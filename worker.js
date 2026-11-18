/*
 * Bousching Live – Live-Punkte deiner Kickbase-Liga als API + Handy-Seite
 * ------------------------------------------------------------------------
 * Läuft als Cloudflare Worker (Free-Plan reicht) oder lokal/Docker mit `node server.mjs`.
 * Datenquelle: inoffizielle Kickbase-API v4 (Community-Doku kevinskyba/kickbase-api-doc).
 * Kickbase kann die Schnittstelle jederzeit ändern – dann hilft /api/raw beim Nachjustieren.
 *
 * Öffentlich (ohne Schlüssel):
 *   /                        Live-Seite fürs Handy
 *   /?demo=1                 Seite mit erfundenen Daten (ohne Kickbase)
 *   /api/live                Alles in einem JSON: Manager, Aufstellungen, Live-Punkte, Events
 *   /api/overview            Liga, Spieltag, Spiele, Manager + Aufstellungen (ohne Live-Punkte)
 *   /api/players?ids=1,2     Live-Punkte + Events aufgestellter Spieler (max. PLAYER_BATCH pro Aufruf)
 * Intern (nur mit ?key=ACCESS_KEY, sonst 404):
 *   /api/leagues             Deine Ligen mit ID
 *   /api/raw?path=/v4/...    Kickbase-Rohdaten zum Debuggen (zusätzlich ?debug=DEBUG_KEY)
 *   Optional überall: ?day=N für einen anderen Spieltag.
 *
 * Einstellungen (Cloudflare: Worker → Settings → Variables and Secrets)
 *   KICKBASE_EMAIL, KICKBASE_PASSWORD  Pflicht, als Secret anlegen
 *   LEAGUE_NAME oder LEAGUE_ID         welche Liga (ohne Angabe: die erste)
 *   ACCESS_KEY                         schützt die internen Endpunkte (ohne: komplett gesperrt)
 *   DEBUG_KEY                          schaltet /api/raw frei
 *   PLAYER_BATCH                       Spieler pro /api/players-Aufruf (Standard 30)
 *   SUBREQUEST_LIMIT                   Kickbase-Aufrufe pro /api/live-Request (Standard 40, Free-Plan erlaubt 50)
 *   KV (Binding, optional)             merkt sich das Kickbase-Token über Neustarts hinweg
 */

const DEFAULT_BASE = 'https://api.kickbase.com';
const CDN = 'https://kickbase.b-cdn.net/';
const HEADERS = { accept: 'application/json', 'accept-language': 'de-DE,de;q=0.9', 'user-agent': 'BouschingLive/1.0' };
const ROLE = { 5: 'start', 3: 'sub', 4: 'bench' };
const POS = { 1: 'TW', 2: 'ABW', 3: 'MF', 4: 'ST' };
// Key-Event-Codes aus den Kickbase-Matchdaten: 1 Tor, 3 Vorlage, 4 Gelb, 8 eingewechselt, 9 ausgewechselt
const KEY_CODES = { 1: 'goal', 3: 'assist', 4: 'yellow', 8: 'in', 9: 'out' };
const MAX_MATCH_MS = 4 * 3600 * 1000;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---------------------------------------------------------------- Cache pro Worker-Instanz

const memo = new Map();
let tokenState = null; // { tkn, exp, uid }
let loginPromise = null;

function cached(key, ttl, fn) {
  const now = Date.now();
  const hit = memo.get(key);
  if (hit && hit.pending) return hit.pending;
  if (hit && hit.exp > now) return Promise.resolve(hit.val);
  const pending = Promise.resolve()
    .then(fn)
    .then(
      (val) => {
        memo.set(key, { val, exp: Date.now() + (typeof ttl === 'function' ? ttl(val) : ttl) });
        return val;
      },
      (err) => {
        memo.delete(key);
        throw err;
      },
    );
  memo.set(key, { pending });
  if (memo.size > 5000) for (const [k, v] of memo) if (!v.pending && v.exp < now) memo.delete(k);
  return pending;
}

function isFresh(key) {
  const hit = memo.get(key);
  return !!hit && !hit.pending && hit.exp > Date.now();
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const str = (v) => (v == null || v === '' ? null : String(v));
const num = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
const img = (p) => (p ? (/^https?:/.test(p) ? p : CDN + String(p).replace(/^\/+/, '')) : null);
const parseDay = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 60 ? n : null;
};
const batchSize = (env) => Math.max(1, Math.min(200, Number(env.PLAYER_BATCH) || 30));

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const run = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return out;
}

// ---------------------------------------------------------------- Kickbase-Client

class Kickbase {
  constructor(env) {
    this.env = env;
    this.base = String(env.KICKBASE_BASE_URL || DEFAULT_BASE).replace(/\/+$/, '');
    this.calls = 0; // Aufrufe in diesem Request (Cloudflare Free: max. 50)
  }

  async session(force) {
    if (!force) {
      if (tokenState && tokenState.exp - Date.now() > 120000) return tokenState;
      if (this.env.KV && !tokenState) {
        try {
          const saved = await this.env.KV.get('kickbase_token', 'json');
          if (saved && saved.exp - Date.now() > 120000) return (tokenState = saved);
        } catch (_) {
          // KV ist optional
        }
      }
    }
    if (!loginPromise) loginPromise = this.login().finally(() => (loginPromise = null));
    return loginPromise;
  }

  async login() {
    const em = this.env.KICKBASE_EMAIL;
    const pass = this.env.KICKBASE_PASSWORD;
    if (!em || !pass) {
      throw new HttpError(500, 'KICKBASE_EMAIL und KICKBASE_PASSWORD sind nicht gesetzt (Worker → Settings → Variables and Secrets).');
    }
    this.calls++;
    const res = await fetch(this.base + '/v4/user/login', {
      method: 'POST',
      headers: { ...HEADERS, 'content-type': 'application/json' },
      body: JSON.stringify({ em, pass, loy: false, rep: {}, ext: true }),
    });
    if ([400, 401, 403].includes(res.status)) {
      throw new HttpError(502, 'Kickbase hat den Login abgelehnt. Prüf KICKBASE_EMAIL und KICKBASE_PASSWORD.');
    }
    if (!res.ok) throw new HttpError(502, 'Kickbase-Login fehlgeschlagen (HTTP ' + res.status + ').');
    const data = await res.json();
    if (!data.tkn) throw new HttpError(502, 'Kickbase hat beim Login kein Token geliefert.');
    let exp = Date.parse(data.tknex || '');
    if (!(exp > Date.now())) exp = Date.now() + 12 * 3600 * 1000;
    tokenState = { tkn: data.tkn, exp, uid: data.u && data.u.id != null ? String(data.u.id) : '' };
    if (this.env.KV) {
      try {
        const ttl = Math.max(120, Math.floor((exp - Date.now()) / 1000));
        await this.env.KV.put('kickbase_token', JSON.stringify(tokenState), { expirationTtl: ttl });
      } catch (_) {
        // egal, dann eben nur im Speicher
      }
    }
    return tokenState;
  }

  async get(path, params, lang) {
    const url = new URL(this.base + path);
    for (const [k, v] of Object.entries(params || {})) if (v != null && v !== '') url.searchParams.set(k, String(v));
    let relogged = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      const s = await this.session(false);
      this.calls++;
      const res = await fetch(url, {
        headers: {
          ...HEADERS,
          ...(lang ? { 'accept-language': lang } : {}),
          authorization: 'Bearer ' + s.tkn,
          cookie: 'kkstrauth=' + s.tkn + ';',
        },
      });
      if (res.status === 401 && !relogged) {
        relogged = true;
        tokenState = null;
        await this.session(true);
        continue;
      }
      if ((res.status === 429 || res.status >= 500) && attempt < 2) {
        await sleep(500 * (attempt + 1));
        continue;
      }
      if (!res.ok) throw new HttpError(res.status === 404 ? 404 : 502, 'Kickbase ' + path + ' antwortet mit HTTP ' + res.status + '.');
      return res.json();
    }
    throw new HttpError(502, 'Kickbase ' + path + ' antwortet nicht.');
  }
}

// ---------------------------------------------------------------- Liga, Spieltag, Spiele

function getLeague(kb, env) {
  return cached('league', 3600 * 1000, async () => {
    const sel = await kb.get('/v4/leagues/selection');
    const list = (sel.it || []).map((l) => ({ id: String(l.i), name: String(l.n || '').trim(), cid: String(l.cpi || '1') }));
    if (!list.length) throw new HttpError(404, 'Dein Kickbase-Account ist in keiner Liga.');
    const names = list.map((l) => l.name + ' (' + l.id + ')').join(', ');
    const wantId = String(env.LEAGUE_ID || '').trim();
    const wantName = String(env.LEAGUE_NAME || '').trim().toLowerCase();
    if (wantId) {
      const hit = list.find((l) => l.id === wantId);
      if (!hit) throw new HttpError(404, 'Liga-ID ' + wantId + ' nicht gefunden. Deine Ligen: ' + names);
      return hit;
    }
    if (wantName) {
      const hit = list.find((l) => l.name.toLowerCase() === wantName);
      if (!hit) throw new HttpError(404, 'Liga "' + env.LEAGUE_NAME + '" nicht gefunden. Deine Ligen: ' + names);
      return hit;
    }
    return list[0];
  });
}

function matchdays(kb, league) {
  return cached('md:' + league.cid, 20000, () => kb.get('/v4/competitions/' + league.cid + '/matchdays'));
}

function matchState(st, minute, kickoff) {
  const s = Number(st);
  if (s === 2) return 'done';
  const started = (Number.isFinite(s) && s !== 0) || (/^\d/.test(minute) && minute !== '0');
  if (!started) return 'upcoming';
  const ko = Date.parse(kickoff || '');
  if (ko && Date.now() - ko > MAX_MATCH_MS) return 'done'; // Kickbase hängt manchmal auf "läuft"
  return 'live';
}

function normMatch(m) {
  const minute = m.mtd != null ? String(m.mtd) : '';
  return {
    id: String(m.mi),
    kickoff: m.dt || null,
    state: matchState(m.st, minute, m.dt),
    minute,
    home: { id: str(m.t1), sym: m.t1sy || '', goals: num(m.t1g), logo: img(m.t1im) },
    away: { id: str(m.t2), sym: m.t2sy || '', goals: num(m.t2g), logo: img(m.t2im) },
  };
}

async function overview(kb, env, dayParam) {
  const league = await getLeague(kb, env);
  const md = await matchdays(kb, league);
  const currentDay = num(md.day);
  const day = parseDay(dayParam) || currentDay;
  if (!day) throw new HttpError(502, 'Kickbase liefert keinen aktuellen Spieltag.');

  const group = (md.it || []).find((g) => Number(g.day) === day);
  const matches = (group ? group.it || [] : [])
    .map(normMatch)
    .sort((a, b) => String(a.kickoff).localeCompare(String(b.kickoff)));

  const rk = await cached('rk:' + league.id + ':' + day, 20000, () =>
    kb.get('/v4/leagues/' + league.id + '/ranking', { dayNumber: day }),
  );
  const users = rk.us || [];

  // Kader liefern Namen + Positionen für alle aufgestellten Spieler (ändern sich selten)
  const squads = await mapLimit(users, 6, (u) =>
    cached('sq:' + league.id + ':' + u.i, 5 * 60000, () => kb.get('/v4/leagues/' + league.id + '/managers/' + u.i + '/squad')).catch(
      () => null,
    ),
  );
  const known = {};
  for (const sq of squads) {
    for (const p of (sq && sq.it) || []) known[String(p.pi)] = { name: String(p.pn || '').trim(), pos: num(p.pos), teamId: str(p.tid) };
  }

  const players = {};
  const managers = users.map((u, i) => {
    const lineup = (u.lp || []).map((x) => (x == null || x === '' ? null : String(x)));
    for (const id of lineup) if (id) players[id] = known[id] || { name: '', pos: null, teamId: null };
    // Bank = Kader ohne Aufstellung. Der Kader ist der aktuelle, deshalb nur für den laufenden Spieltag.
    const inLineup = new Set(lineup.filter(Boolean));
    const bench =
      day === currentDay && squads[i] && squads[i].it
        ? squads[i].it.map((p) => String(p.pi)).filter((id) => !inLineup.has(id))
        : [];
    for (const id of bench) players[id] = known[id];
    return {
      id: String(u.i),
      name: String(u.n || u.unm || '').trim(),
      image: img(u.uim),
      lineup,
      bench,
      official: { day: num(u.mdp), season: num(u.sp), seasonRank: num(u.spl), dayRank: num(u.mdpl) },
    };
  });

  return {
    league: { id: league.id, name: league.name },
    day,
    currentDay,
    days: num(rk.nd) || 34,
    season: rk.sn || null,
    matches,
    managers,
    players,
    batch: batchSize(env),
    updatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------- Live-Punkte pro Spieler

function eventNames(kb) {
  return cached('et', 12 * 3600 * 1000, async () => {
    const r = await kb.get('/v4/live/eventtypes', null, 'de-DE');
    const map = {};
    for (const t of r.it || []) map[t.i] = String(t.ti || '').trim();
    return map;
  }).catch(() => ({}));
}

function keyKind(e, name) {
  const code = Number(e.ke);
  if (KEY_CODES[code]) return KEY_CODES[code];
  const n = name.toLowerCase();
  if (/gelb-?rot|yellow.?red|second yellow|2nd yellow/.test(n)) return 'yellowred';
  if (/rote karte|red card|platzverweis/.test(n)) return 'red';
  if (/eigentor|own goal/.test(n) && !/forced|erzwungen|provoziert/.test(n)) return 'owngoal';
  return null;
}

function normPlayer(id, pc, names) {
  const raw = Array.isArray(pc.events) ? pc.events : [];
  // Korrekturen: ein Event mit "cei" hebt das Event mit dieser ID auf – beide fliegen raus
  const cancelled = new Set(raw.filter((e) => e.cei != null).map((e) => String(e.cei)));
  const effective = raw.filter((e) => e.cei == null && !cancelled.has(String(e.ei)));

  const keys = [];
  const seen = new Set();
  const events = [];
  for (const e of effective) {
    const name = names[e.eti] || '';
    const p = Number(e.p) || 0;
    const min = num(e.mt);
    const kind = keyKind(e, name);
    if (kind && !seen.has(kind + '@' + min)) {
      seen.add(kind + '@' + min);
      keys.push({ kind, min, p });
    }
    if (p !== 0) events.push({ min, name: name || 'Ereignis ' + e.eti, p });
  }
  if (!keys.length && Array.isArray(pc.k)) {
    for (const c of pc.k) if (KEY_CODES[c]) keys.push({ kind: KEY_CODES[c], min: null, p: 0 });
  }
  const byMin = (a, b) => (a.min == null ? -1 : a.min) - (b.min == null ? -1 : b.min);
  keys.sort(byMin);
  events.sort(byMin);

  const minute = pc.mtd != null ? String(pc.mtd) : '';
  return {
    id: String(id),
    name: String(pc.n || '').trim(),
    teamId: str(pc.tid),
    points: pc.p != null ? Number(pc.p) : events.reduce((s, e) => s + e.p, 0),
    state: matchState(pc.mst, minute, pc.md),
    minute,
    kickoff: pc.md || null,
    role: ROLE[Number(pc.st)] || null,
    keys,
    events,
  };
}

const pcKey = (league, day, id) => 'pc:' + league.cid + ':' + day + ':' + id;

async function livePlayers(kb, env, ids, day) {
  const league = await getLeague(kb, env);
  const names = await eventNames(kb);
  const players = {};
  await mapLimit(ids, 6, async (id) => {
    try {
      const pc = await cached(
        pcKey(league, day, id),
        (v) => (v && Number(v.mst) === 2 ? 5 * 60000 : 20000),
        () => kb.get('/v4/competitions/' + league.cid + '/playercenter/' + encodeURIComponent(id), { dayNumber: day, leagueId: league.id }),
      );
      players[id] = normPlayer(id, pc, names);
    } catch (e) {
      players[id] = { id, error: e.message || 'Fehler' };
    }
  });
  return players;
}

async function playersEndpoint(kb, env, url) {
  const ids = [
    ...new Set(
      String(url.searchParams.get('ids') || '')
        .split(',')
        .map((s) => s.trim())
        .filter((s) => /^\w{1,24}$/.test(s)),
    ),
  ];
  if (!ids.length) throw new HttpError(400, 'ids fehlt, z. B. /api/players?ids=7226,8329');
  const max = batchSize(env);
  if (ids.length > max) throw new HttpError(400, 'Höchstens ' + max + ' Spieler pro Aufruf (PLAYER_BATCH).');
  // Nur Spieler, die in dieser Liga aufgestellt sind – die Seite ist öffentlich,
  // damit niemand über deinen Account beliebige Abfragen auslösen kann.
  const ov = await overview(kb, env, url.searchParams.get('day'));
  const allowed = ids.filter((id) => ov.players[id]);
  return { day: ov.day, players: await livePlayers(kb, env, allowed, ov.day), updatedAt: new Date().toISOString() };
}

// ---------------------------------------------------------------- Tabelle (für /api/live)

const STATE_ORDER = { upcoming: 0, live: 1, done: 2 };
const later = (a, b) => (!a ? b : !b ? a : STATE_ORDER[a] >= STATE_ORDER[b] ? a : b);
const POS_RANK = { TW: 1, ABW: 2, MF: 3, ST: 4 };

function teamIndex(matches) {
  const t = {};
  for (const m of matches) {
    if (m.home.id) t[m.home.id] = m;
    if (m.away.id) t[m.away.id] = m;
  }
  return t;
}

// Größter verpasster Gewinn: Bankspieler statt schwächstem Startspieler derselben Position
function bestSwap(players, bench) {
  let best = null;
  for (const b of bench) {
    if (b.state === 'upcoming' || !b.loaded) continue;
    for (const s of players) {
      if (s.pos !== b.pos || s.state === 'upcoming') continue;
      const gain = b.points - s.points;
      if (gain > 0 && (!best || gain > best.gain)) best = { in: b.name, out: s.name, gain };
    }
  }
  return best;
}

function standings(ov, live) {
  const tm = teamIndex(ov.matches);
  const current = ov.day === ov.currentDay;
  const row = (id, slot) => {
    const meta = ov.players[id] || {};
    const lv = live[id] && !live[id].error ? live[id] : null;
    const teamId = (lv && lv.teamId) || meta.teamId || null;
    const match = teamId ? tm[teamId] : null;
    const state = later(lv && lv.state, match && match.state) || 'upcoming';
    return {
      id,
      slot,
      name: (lv && lv.name) || meta.name || '',
      pos: POS[meta.pos] || null,
      team: match ? (match.home.id === teamId ? match.home.sym : match.away.sym) : null,
      points: lv ? lv.points : 0,
      state,
      loaded: !!lv,
      minute: state === 'live' ? (lv && lv.minute) || (match && match.minute) || '' : '',
      role: lv ? lv.role : null,
      keys: lv ? lv.keys : [],
      events: lv ? lv.events : [],
    };
  };
  const byPos = (a, b) => (POS_RANK[a.pos] || 5) - (POS_RANK[b.pos] || 5) || a.slot - b.slot;
  const rows = ov.managers.map((m) => {
    const players = [];
    m.lineup.forEach((id, slot) => id && players.push(row(id, slot)));
    players.sort(byPos);
    const points = players.reduce((s, p) => s + p.points, 0);
    const played = players.filter((p) => p.state !== 'upcoming').length;
    const missing = players.filter((p) => p.state !== 'upcoming' && !p.loaded).length;
    const bench = (m.bench || []).map((id, i) => row(id, 100 + i)).sort((a, b) => b.points - a.points);
    const o = m.official;
    const season = o.season == null ? null : current ? o.season - (o.day || 0) + points : o.season;
    return {
      id: m.id,
      name: m.name,
      points,
      officialPoints: o.day,
      seasonPoints: season,
      played,
      lineupSize: players.length,
      missing,
      players,
      bench,
      benchPoints: bench.reduce((s, p) => s + p.points, 0),
      bestSwap: bestSwap(players, bench),
    };
  });
  rows.sort((a, b) => b.points - a.points || (b.seasonPoints || 0) - (a.seasonPoints || 0));
  rows.forEach((r, i) => (r.rank = i > 0 && rows[i - 1].points === r.points ? rows[i - 1].rank : i + 1));
  rows
    .slice()
    .sort((a, b) => (b.seasonPoints == null ? -1e12 : b.seasonPoints) - (a.seasonPoints == null ? -1e12 : a.seasonPoints))
    .forEach((r, i) => (r.seasonRank = i + 1));
  return rows;
}

async function liveAll(kb, env, dayParam) {
  const ov = await overview(kb, env, dayParam);
  const league = await getLeague(kb, env);
  const tm = teamIndex(ov.matches);
  // Cloudflare Free erlaubt 50 externe Aufrufe pro Request. 40 lässt Luft für Wiederholungen,
  // der Rest kommt beim nächsten Aufruf (dann aus dem Cache) – siehe "complete" und "pending".
  let budget = Math.max(0, (Number(env.SUBREQUEST_LIMIT) || 40) - kb.calls - 3);
  const prio = { live: 0, done: 1, unknown: 2 };
  const candidates = Object.keys(ov.players)
    .map((id) => {
      const t = ov.players[id].teamId;
      return { id, st: t && tm[t] ? tm[t].state : 'unknown' };
    })
    .filter((c) => c.st !== 'upcoming')
    .sort((a, b) => prio[a.st] - prio[b.st]);
  const take = [];
  const pending = [];
  for (const c of candidates) {
    if (isFresh(pcKey(league, ov.day, c.id))) take.push(c.id);
    else if (budget > 0) {
      take.push(c.id);
      budget--;
    } else pending.push(c.id);
  }
  const live = take.length ? await livePlayers(kb, env, take, ov.day) : {};
  return {
    league: ov.league,
    day: ov.day,
    currentDay: ov.currentDay,
    season: ov.season,
    updatedAt: new Date().toISOString(),
    complete: pending.length === 0,
    pending,
    matches: ov.matches,
    managers: standings(ov, live),
  };
}

// ---------------------------------------------------------------- Manager-Akte (Easter Egg)
//
// Kontostand = Buchungsliste mit Datum: Startbudget, Transfers, täglicher Login-Bonus,
// Punkteprämie pro Spieltag und Erfolgsprämien. Erfolge rechnen wir aus öffentlichen Daten nach
// (Bedingungen + Prämien aus /user/achievements, geprüft gegen die echten Erfolge des eigenen Accounts).
// Mit einer Korrektur ("Stand am Tag X war Y €") wird ab dort nur noch weitergerechnet.

const M = 1000000;
const ACH = {
  dayWin: { n: 'Spieltagssieger', er: 1 * M },
  dayWinTiers: [[3, 'Spieltagssieger Bronze', 0.5 * M], [5, 'Spieltagssieger Silber', 1 * M], [10, 'Spieltagssieger Gold', 1.5 * M], [25, 'The Special One', 2 * M]],
  dayPts: [[500, 'Spieltagspunkte Bronze', 0.1 * M, false], [1000, 'Spieltagspunkte Silber', 0.25 * M, true], [1500, 'Spieltagspunkte Gold', 1 * M, true], [2000, 'Jahrhundertspiel', 2 * M, true]],
  seasonPts: [[1000, 'Saisonpunkte Bronze', 0.1 * M], [5000, 'Saisonpunkte Silber', 0.25 * M], [15000, 'Saisonpunkte Gold', 0.5 * M], [30000, 'Saisonpunkte Platin', 1 * M], [40000, 'Weltpokalsieger', 2 * M]],
  topPlayer: [[200, 'Topscorer', 0.1 * M], [300, 'Matchwinner', 0.5 * M], [400, 'Weltklasse', 1 * M], [500, 'Fussballgott', 2 * M]],
  teamValue: [[125 * M, 'Mannschaftswert Bronze', 0.1 * M], [150 * M, 'Mannschaftswert Silber', 0.25 * M], [200 * M, 'Mannschaftswert Gold', 0.5 * M], [250 * M, 'Mannschaftswert Platin', 1 * M], [350 * M, 'Die Galaktischen', 2 * M]],
  transfers: [[1, 'Erster Deal', 0.1 * M], [50, 'Transferkönig Bronze', 0.25 * M], [250, 'Transferkönig Silber', 0.5 * M], [500, 'Transferkönig Gold', 1 * M], [1000, 'F. Magath', 2 * M]],
  leagueSize: [[3, 'Kreisliga', 1 * M], [6, 'Regionalliga', 1 * M], [12, '2. Liga', 1 * M], [18, '1. Liga', 1 * M]],
  firstProfit: [1 * M, 'Glückliches Händchen', 0.1 * M],
  profit: [[3 * M, 'Bronzenes Händchen', 0.25 * M], [5 * M, 'Silbernes Händchen', 0.5 * M], [10 * M, 'Goldenes Händchen', 1 * M], [25 * M, 'Königstransfer', 2 * M]],
  mvp: { n: 'MVP', er: 1 * M },
  goals: { n: 'Tormaschine', er: 0.25 * M },
  longBench: [25, 'Lange Bank', 0.1 * M],
  panini: { n: 'Panini', er: 0.1 * M },
};
const LONG = 7 * 24 * 3600 * 1000;

function mdGroups(md) {
  const out = {};
  for (const g of md.it || []) {
    const ms = (g.it || []).map(normMatch);
    const kick = ms.map((m) => Date.parse(m.kickoff || '')).filter(Number.isFinite);
    out[Number(g.day)] = {
      done: ms.length > 0 && ms.every((m) => m.state === 'done'),
      end: kick.length ? Math.max(...kick) + 2.5 * 3600 * 1000 : null,
      teams: [...new Set(ms.flatMap((m) => [m.home.id, m.away.id]).filter(Boolean))],
    };
  }
  return out;
}

function transfersOf(kb, league, uid) {
  return cached('tx:' + league.id + ':' + uid, 5 * 60000, async () => {
    const all = [];
    for (let start = 0, page = 0; page < 60; page++) {
      const t = await kb.get('/v4/leagues/' + league.id + '/managers/' + uid + '/transfer', { start });
      const it = t.it || [];
      if (!it.length) break;
      all.push(...it);
      start += it.length;
    }
    return all
      .map((t) => ({
        date: t.dt || null,
        pid: String(t.pi),
        player: String(t.pn || '').trim(),
        kind: Number(t.tty) === 2 ? 'sell' : 'buy',
        price: Number(t.trp) || 0,
        other: t.othnm ? String(t.othnm) : null,
      }))
      .filter((t) => t.date)
      .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  });
}

// Pro abgeschlossenem Spieltag: bester Aufstellungsspieler + Tore je Manager, stärkster Spieler der Bundesliga
function dayHistory(kb, league, day, group) {
  return cached('hd:' + league.id + ':' + day, LONG, async () => {
    const rk = await kb.get('/v4/leagues/' + league.id + '/ranking', { dayNumber: day });
    const byUser = {};
    for (const u of rk.us || []) {
      const ids = (u.lp || []).filter((x) => x != null && x !== '').map(String);
      const stats = await mapLimit(ids, 6, (id) =>
        cached(pcKey(league, day, id), LONG, () =>
          kb.get('/v4/competitions/' + league.cid + '/playercenter/' + id, { dayNumber: day, leagueId: league.id }),
        ).then(
          (pc) => {
            const ev = (pc.events || []).filter((e) => e.cei == null);
            const cancelled = new Set((pc.events || []).filter((e) => e.cei != null).map((e) => String(e.cei)));
            return { p: Number(pc.p) || 0, goals: ev.filter((e) => Number(e.ke) === 1 && !cancelled.has(String(e.ei))).length };
          },
          () => ({ p: 0, goals: 0 }),
        ),
      );
      byUser[String(u.i)] = {
        best: stats.reduce((m, s) => Math.max(m, s.p), 0),
        goals: stats.reduce((m, s) => m + s.goals, 0),
      };
    }
    let top = { p: -1, ids: [] };
    const teams = await mapLimit(group.teams, 6, (tid) =>
      kb.get('/v4/competitions/' + league.cid + '/teams/' + tid + '/teamcenter', { dayNumber: day }).catch(() => null),
    );
    for (const t of teams) {
      for (const p of (t && t.it) || []) {
        const pts = Number(p.p) || 0;
        if (pts > top.p) top = { p: pts, ids: [String(p.i)] };
        else if (pts === top.p) top.ids.push(String(p.i));
      }
    }
    return { byUser, top };
  });
}

// Hatte der Manager den Spieler zum Zeitpunkt t im Kader? (aus seinen Transfers + aktuellem Kader)
function owned(txs, squadIds, pid, t) {
  const mine = txs.filter((x) => x.pid === pid);
  const before = mine.filter((x) => Date.parse(x.date) <= t);
  if (before.length) return before[before.length - 1].kind === 'buy';
  const after = mine.find((x) => Date.parse(x.date) > t);
  if (after) return after.kind === 'sell';
  return squadIds.has(pid);
}

async function calibrations(env) {
  try {
    if (env.STORE) return (await env.STORE.get('calibrations')) || {};
    if (env.KV) return (await env.KV.get('calibrations', 'json')) || {};
  } catch (_) {
    // egal
  }
  return memo.get('calibrations-mem') ? memo.get('calibrations-mem').val : {};
}

async function saveCalibrations(env, data) {
  if (env.STORE) return env.STORE.put('calibrations', data);
  if (env.KV) return env.KV.put('calibrations', JSON.stringify(data));
  memo.set('calibrations-mem', { val: data, exp: Infinity });
}

async function ledger(kb, env, league, uid) {
  const md = await matchdays(kb, league);
  const groups = mdGroups(md);
  const info = await cached('lo:' + league.id, 3600 * 1000, () => kb.get('/v4/leagues/' + league.id + '/overview'));
  const rk = await cached('rk:' + league.id + ':' + num(md.day), 20000, () =>
    kb.get('/v4/leagues/' + league.id + '/ranking', { dayNumber: num(md.day) }),
  );
  const users = rk.us || [];
  const user = users.find((u) => String(u.i) === uid);
  if (!user) throw new HttpError(404, 'Diesen Manager gibt es in der Liga nicht.');

  const [dash, perf, txs, sq] = await Promise.all([
    cached('dash:' + league.id + ':' + uid, 5 * 60000, () => kb.get('/v4/leagues/' + league.id + '/managers/' + uid + '/dashboard')),
    cached('perf:' + league.id + ':' + uid, 5 * 60000, () => kb.get('/v4/leagues/' + league.id + '/managers/' + uid + '/performance')),
    transfersOf(kb, league, uid),
    cached('sq:' + league.id + ':' + uid, 5 * 60000, () => kb.get('/v4/leagues/' + league.id + '/managers/' + uid + '/squad')).catch(() => ({ it: [] })),
  ]);
  const squadIds = new Set((sq.it || []).map((p) => String(p.pi)));

  const created = Date.parse(info.dt || '');
  const since = Number.isFinite(created) ? created : txs.length ? Date.parse(txs[0].date) : Date.now();
  const start = num(info.b) != null ? num(info.b) : 50 * M;
  const loginBonus = Number(env.LOGIN_BONUS) || 100000;
  const pointMoney = env.POINT_MONEY != null && env.POINT_MONEY !== '' ? Number(env.POINT_MONEY) : 1000;
  const now = Date.now();
  const E = []; // { t, cat, label, amount }
  const add = (t, cat, label, amount) => amount && E.push({ t, cat, label, amount });

  add(since, 'start', 'Startbudget', start);
  for (const x of txs) add(Date.parse(x.date), x.kind, x.player, x.kind === 'sell' ? x.price : -x.price);
  // Login-Bonus: Die Login-Serie zählt pro Kickbase-Account, nicht pro Liga. Wer schon vorher gespielt hat,
  // bekommt ab Ligastart sofort 100.000 €. Nur ein neuer Account startet mit 10.000 €, 20.000 €, … (LOGIN_RAMP=1).
  const ramp = String(env.LOGIN_RAMP || '') === '1';
  for (let t = since, k = 1; t <= now && k < 1000; t += 86400000, k++) {
    add(t, 'login', 'Login-Bonus', ramp ? Math.min(k, 10) * (loginBonus / 10) : loginBonus);
  }

  // Spieltage der Saison (nur abgeschlossene, an denen die Liga schon lief)
  const season = (perf.it && perf.it[0] && perf.it[0].it) || [];
  const days = season
    .filter((d) => groups[d.day] && groups[d.day].done && groups[d.day].end && groups[d.day].end > since)
    .map((d) => ({ day: Number(d.day), pts: Number(d.mdp) || 0, win: !!d.tw, end: groups[d.day].end }))
    .sort((a, b) => a.day - b.day);

  let wins = 0;
  let total = 0;
  const once = new Set();
  const ach = (t, name, er, repeat) => {
    if (!repeat) {
      if (once.has(name)) return;
      once.add(name);
    }
    add(t, 'ach', name, er);
  };
  for (const [min, name, er] of ACH.leagueSize) if (users.length >= min) ach(since, name, er, false);
  if (user.uim) ach(since, ACH.panini.n, ACH.panini.er, false);

  const histories = {};
  await mapLimit(days, 2, async (d) => {
    histories[d.day] = await dayHistory(kb, league, d.day, groups[d.day]).catch(() => null);
  });
  for (const d of days) {
    add(d.end, 'points', 'Punkteprämie Spieltag ' + d.day, d.pts * pointMoney);
    if (d.win) {
      wins++;
      ach(d.end, ACH.dayWin.n, ACH.dayWin.er, true);
      for (const [min, name, er] of ACH.dayWinTiers) if (wins >= min) ach(d.end, name, er, false);
    }
    for (const [min, name, er, rep] of ACH.dayPts) if (d.pts >= min) ach(d.end, name, er, rep);
    total += d.pts;
    for (const [min, name, er] of ACH.seasonPts) if (total >= min) ach(d.end, name, er, false);
    const h = histories[d.day];
    if (h) {
      const mine = h.byUser[uid];
      if (mine) {
        for (const [min, name, er] of ACH.topPlayer) if (mine.best >= min) ach(d.end, name, er, true);
        const others = Object.entries(h.byUser).filter(([id]) => id !== uid).map(([, s]) => s.goals);
        if (mine.goals > 0 && others.every((g) => mine.goals > g)) ach(d.end, ACH.goals.n, ACH.goals.er, true);
      }
      if (h.top.ids.some((pid) => owned(txs, squadIds, pid, d.end))) ach(d.end, ACH.mvp.n, ACH.mvp.er, true);
    }
  }

  // Transfer-Anzahl und Gewinne mit einem Spieler (nur Markt, keine Deals unter Managern)
  const lastBuy = {};
  txs.forEach((x, i) => {
    const t = Date.parse(x.date);
    for (const [min, name, er] of ACH.transfers) if (i + 1 >= min) ach(t, name, er, false);
    if (x.kind === 'buy') lastBuy[x.pid] = x;
    else {
      const b = lastBuy[x.pid];
      delete lastBuy[x.pid];
      if (!b || b.other || x.other) return;
      const gain = x.price - b.price;
      if (gain >= ACH.firstProfit[0]) ach(t, ACH.firstProfit[1], ACH.firstProfit[2], false);
      let tier = null;
      for (const tr of ACH.profit) if (gain >= tr[0]) tier = tr;
      if (tier) ach(t, tier[1], tier[2], true);
    }
  });

  // Teamwert und Kadergröße kennen wir nur aktuell – Zeitpunkt unbekannt, zählen vor einer Korrektur
  const tv = num(dash.tv) || 0;
  for (const [min, name, er] of ACH.teamValue) if (tv >= min) add(null, 'ach', name, er);
  if (squadIds.size >= ACH.longBench[0]) add(null, 'ach', ACH.longBench[1], ACH.longBench[2]);

  return { dash, user, since, start, loginBonus, pointMoney, txs, events: E, wins, now };
}

async function managerFile(kb, env, url) {
  const uid = String(url.searchParams.get('id') || '');
  const league = await getLeague(kb, env);
  return cached('mf:' + league.id + ':' + uid, 5 * 60000, async () => {
    const L = await ledger(kb, env, league, uid);
    const cal = (await calibrations(env))[uid] || null;
    const calT = cal ? Date.parse(cal.at) : null;
    // Mit Korrektur: nur Buchungen danach. Ereignisse ohne Zeitpunkt (Teamwert) stecken dann im korrigierten Stand.
    const used = L.events.filter((e) => (calT == null ? true : e.t != null && e.t > calT));
    const sum = (cat) => used.filter((e) => e.cat === cat).reduce((s, e) => s + e.amount, 0);
    const count = (cat) => used.filter((e) => e.cat === cat).length;
    const achList = {};
    for (const e of used.filter((x) => x.cat === 'ach')) {
      achList[e.label] = achList[e.label] || { name: e.label, count: 0, amount: 0 };
      achList[e.label].count++;
      achList[e.label].amount += e.amount;
    }
    const base = cal ? Number(cal.amount) : 0;
    const estimate = base + used.reduce((s, e) => s + e.amount, 0);
    const d = L.dash;
    // Kickbase erlaubt höchstens 33 % des Teamwerts im Minus
    const maxDebt = -Math.round(0.33 * (num(d.tv) || 0));
    return {
      id: uid,
      name: String(d.unm || L.user.n || '').trim(),
      placement: num(d.pl),
      seasonPoints: num(d.tp),
      averagePoints: num(d.ap),
      matchdayWins: num(d.mdw),
      teamValue: num(d.tv),
      since: new Date(L.since).toISOString(),
      calibration: cal,
      money: {
        start: sum('start'),
        sold: sum('sell'),
        bought: -sum('buy'),
        loginDays: count('login'),
        loginBonus: L.loginBonus,
        login: sum('login'),
        pointMoney: L.pointMoney,
        points: sum('points'),
        achievements: sum('ach'),
        estimate,
        maxDebt,
        room: estimate - maxDebt,
      },
      counts: { buys: count('buy'), sells: count('sell') },
      achievements: Object.values(achList).sort((a, b) => b.amount - a.amount),
      transfers: L.txs
        .slice()
        .reverse()
        .slice(0, 300)
        .map((x) => ({ date: x.date, player: x.player, kind: x.kind, price: x.price, other: x.other })),
      updatedAt: new Date().toISOString(),
    };
  });
}

async function calibrate(kb, env, request) {
  let body = {};
  try {
    body = await request.json();
  } catch (_) {
    throw new HttpError(400, 'Erwarte JSON: {"id":"…","amount":-12345678}');
  }
  const uid = String(body.id || '');
  const league = await getLeague(kb, env);
  const md = await matchdays(kb, league);
  const rk = await cached('rk:' + league.id + ':' + num(md.day), 20000, () =>
    kb.get('/v4/leagues/' + league.id + '/ranking', { dayNumber: num(md.day) }),
  );
  if (!(rk.us || []).some((u) => String(u.i) === uid)) throw new HttpError(400, 'Diesen Manager gibt es in der Liga nicht.');
  const all = await calibrations(env);
  if (body.amount == null || body.amount === '') delete all[uid];
  else {
    const amount = Math.round(Number(body.amount));
    if (!Number.isFinite(amount) || Math.abs(amount) > 2e9) throw new HttpError(400, 'Betrag ungültig.');
    const at = body.at ? new Date(body.at) : new Date();
    if (isNaN(at) || at.getTime() > Date.now() + 60000) throw new HttpError(400, 'Zeitpunkt ungültig.');
    all[uid] = { amount, at: at.toISOString() };
  }
  await saveCalibrations(env, all);
  memo.delete('mf:' + league.id + ':' + uid);
  return { ok: true, calibration: all[uid] || null };
}

// ---------------------------------------------------------------- Debug

async function raw(kb, env, url) {
  if (!env.DEBUG_KEY || url.searchParams.get('debug') !== String(env.DEBUG_KEY)) {
    throw new HttpError(403, '/api/raw ist nur mit DEBUG_KEY freigeschaltet (?debug=...).');
  }
  let path = String(url.searchParams.get('path') || '');
  if (path.includes('{league}') || path.includes('{cid}')) {
    const league = await getLeague(kb, env);
    path = path.split('{league}').join(league.id).split('{cid}').join(league.cid);
  }
  if (!/^\/v4\/[A-Za-z0-9_\-/]+$/.test(path)) {
    throw new HttpError(400, 'path muss mit /v4/ beginnen, z. B. /v4/leagues/{league}/ranking');
  }
  const params = {};
  for (const [k, v] of url.searchParams) if (!['path', 'debug', 'key'].includes(k)) params[k] = v;
  return kb.get(path, params);
}

// ---------------------------------------------------------------- HTTP

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    },
  });
}

function html(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-robots-tag': 'noindex',
    },
  });
}

function authorized(url, request, env) {
  if (!env.ACCESS_KEY) return true;
  const given = String(url.searchParams.get('key') || request.headers.get('x-access-key') || '');
  const want = String(env.ACCESS_KEY);
  if (given.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= given.charCodeAt(i) ^ want.charCodeAt(i);
  return diff === 0;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    try {
      if (request.method === 'OPTIONS') {
        return new Response(null, {
          status: 204,
          headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'x-access-key, content-type', 'access-control-allow-methods': 'GET, POST' },
        });
      }
      if (path === '/api/calibrate' && request.method === 'POST') {
        if (!env.ACCESS_KEY || !authorized(url, request, env)) return json({ error: 'Schlüssel falsch.' }, 403);
        return json(await calibrate(new Kickbase(env), env, request));
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') return json({ error: 'Nur GET.' }, 405);
      if (path === '/favicon.ico') return new Response(null, { status: 204 });
      if (path === '/robots.txt') return new Response('User-agent: *\nDisallow: /\n', { headers: { 'content-type': 'text/plain' } });

      // Seite + Live-Daten sind öffentlich. Interne Endpunkte nur mit ACCESS_KEY (ohne Key: gesperrt).
      if (ADMIN.has(path) && (!env.ACCESS_KEY || !authorized(url, request, env))) {
        return json({ error: 'Gibt es nicht.' }, 404);
      }

      const kb = new Kickbase(env);
      const day = url.searchParams.get('day');
      switch (path) {
        case '/':
          return html(PAGE);
        case '/api/live':
          return json(await liveAll(kb, env, day));
        case '/api/overview':
          return json(await overview(kb, env, day));
        case '/api/players':
          return json(await playersEndpoint(kb, env, url));
        case '/api/manager':
          return json(await managerFile(kb, env, url));
        case '/api/leagues': {
          const sel = await kb.get('/v4/leagues/selection');
          return json({ leagues: (sel.it || []).map((l) => ({ id: str(l.i), name: l.n, competitionId: str(l.cpi) })) });
        }
        case '/api/raw':
          return json(await raw(kb, env, url));
        default:
          return json({ error: 'Gibt es nicht. Probier / oder /api/live.' }, 404);
      }
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      const msg = (e && e.message) || String(e);
      console.error('[' + path + '] ' + status + ': ' + msg);
      // Öffentlich keine Details (Ligen, Login-Probleme) – die stehen in den Logs
      if (ADMIN.has(path) || path === '/api/calibrate' || status === 400) return json({ error: msg }, status);
      return json({ error: 'Kickbase-Daten sind gerade nicht abrufbar. Versuch es gleich nochmal.' }, status >= 500 ? 502 : status);
    }
  },
};

const ADMIN = new Set(['/api/leagues', '/api/raw']);

// ---------------------------------------------------------------- Seiten


// Hinweis: Im Seiten-Code keine Backticks und kein Dollar-Klammer-Muster verwenden (Template-String).
const PAGE = String.raw`<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex">
<meta name="theme-color" content="#0e1a2e">
<title>Bousching Live</title>
<link rel="icon" href="data:,">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,400..800&family=Doto:wght@900&display=swap">
<style>
:root{
  --bg:#f2f4f8;--surface:#ffffff;--ink:#131c2e;--muted:#5d6779;--line:#dce1ea;--chip:#e5e9f1;
  --board:#13294b;--board-ink:#ffe7a8;--live:#b25600;--minus:#c62f2f;--plus:#16775a;--focus:#1f5fd6;
  color-scheme:light;
}
@media (prefers-color-scheme: dark){
  :root:not([data-theme="light"]){
    --bg:#0e1420;--surface:#171f2e;--ink:#e9edf4;--muted:#93a0b5;--line:#263042;--chip:#1d2637;
    --board:#1b3560;--board-ink:#ffe7a8;--live:#ffb347;--minus:#ff7d70;--plus:#6fd1a8;--focus:#8fb4ff;
    color-scheme:dark;
  }
}
:root[data-theme="dark"]{
  --bg:#0e1420;--surface:#171f2e;--ink:#e9edf4;--muted:#93a0b5;--line:#263042;--chip:#1d2637;
  --board:#1b3560;--board-ink:#ffe7a8;--live:#ffb347;--minus:#ff7d70;--plus:#6fd1a8;--focus:#8fb4ff;
  color-scheme:dark;
}
*{box-sizing:border-box}
[hidden]{display:none!important}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:400 16px/1.4 "Archivo",system-ui,-apple-system,"Segoe UI",sans-serif;font-variant-numeric:tabular-nums}
button{font:inherit;color:inherit}
.wrap{max-width:560px;margin:0 auto;padding-left:max(16px, env(safe-area-inset-left, 0px));padding-right:max(16px, env(safe-area-inset-right, 0px));padding-bottom:calc(28px + env(safe-area-inset-bottom, 0px))}
body::before{content:"";position:fixed;inset:0 0 auto;height:env(safe-area-inset-top, 0px);z-index:10;background:var(--bg)}
:focus-visible{outline:2px solid var(--focus);outline-offset:2px;border-radius:6px}

.top{display:flex;align-items:flex-end;justify-content:space-between;gap:12px;padding:22px 0 14px}
.top h1{margin:0;font-weight:800;font-stretch:72%;font-size:30px;line-height:1;letter-spacing:.01em}
.dayline{display:flex;align-items:center;gap:2px;margin:6px 0 0 -8px;color:var(--muted);font-size:15px}
.dayline button{border:0;background:none;cursor:pointer;width:36px;height:36px;border-radius:8px;font-size:22px;line-height:1;color:var(--ink)}
.dayline button:disabled{opacity:.25;cursor:default}
.status{border:0;cursor:pointer;display:inline-flex;align-items:center;gap:8px;padding:9px 13px;border-radius:999px;background:var(--chip);font-size:13px;color:var(--muted);white-space:nowrap}
.status .dot{width:8px;height:8px;border-radius:50%;background:var(--muted)}
.is-live .status .dot{background:var(--live);animation:pulse 2s infinite}
.busy .status .dot{opacity:.45}
.status.bad{color:var(--minus)}
.status.bad .dot{background:var(--minus);animation:none}
@keyframes pulse{0%{box-shadow:0 0 0 0 rgba(255,179,71,.65)}70%{box-shadow:0 0 0 9px rgba(255,179,71,0)}100%{box-shadow:0 0 0 0 rgba(255,179,71,0)}}

.demo{margin:0 0 12px;padding:10px 13px;border-radius:10px;background:var(--board);color:var(--board-ink);font-size:14px;line-height:1.35}
.error{margin:0 0 12px;padding:10px 13px;border-radius:10px;border:1px solid var(--minus);color:var(--minus);font-size:14px}

.matches{display:flex;gap:8px;overflow-x:auto;margin:0 -16px;padding:2px 16px 14px;scroll-snap-type:x proximity;scrollbar-width:none}
.matches::-webkit-scrollbar{display:none}
.match{flex:0 0 auto;scroll-snap-align:start;display:grid;grid-template-columns:auto auto auto;column-gap:8px;align-items:center;justify-items:center;padding:8px 12px 7px;border-radius:10px;background:var(--surface);border:1px solid var(--line)}
.match .t{font-weight:700;font-stretch:78%;font-size:14px}
.match .score{font-family:"Doto","Archivo",monospace;font-weight:900;font-size:21px;line-height:1}
.match .sub{grid-column:1/-1;font-size:12px;color:var(--muted);margin-top:2px}
.match.live{border-color:var(--live)}
.match.live .score,.match.live .sub{color:var(--live)}
.match.upcoming .score{color:var(--muted)}

.tabs{position:sticky;top:env(safe-area-inset-top, 0px);z-index:5;display:flex;gap:4px;padding:8px 0;background:var(--bg)}
.tabs button{flex:1;border:0;background:none;cursor:pointer;padding:10px 0;border-radius:10px;font-weight:700;font-size:15px;color:var(--muted)}
.tabs button[aria-selected="true"]{background:var(--surface);color:var(--ink);box-shadow:inset 0 0 0 1px var(--line)}

.managers,.players,.events,.ticker{list-style:none;margin:0;padding:0}
.mgr{border-bottom:1px solid var(--line)}
.mrow{border:0;background:none;cursor:pointer;width:100%;text-align:left;display:grid;grid-template-columns:30px 1fr auto;align-items:center;gap:10px;padding:14px 0}
.rank{font-weight:800;font-stretch:75%;font-size:19px;color:var(--muted);text-align:center}
.who{min-width:0}
.name{display:block;font-weight:700;font-size:17px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tag{display:inline-block;font-size:11px;font-weight:800;padding:1px 7px;border-radius:999px;background:var(--board);color:var(--board-ink);vertical-align:2px}
.meta{display:flex;flex-wrap:wrap;gap:2px 12px;font-size:13px;color:var(--muted);margin-top:2px}
.meta .up{color:var(--plus);font-weight:700}
.meta .down{color:var(--minus);font-weight:700}
.board{font-family:"Doto","Archivo",monospace;font-weight:900;font-size:30px;line-height:1;color:var(--board-ink);background:var(--board);padding:8px 10px 6px;border-radius:8px;min-width:4.2ch;text-align:right;text-shadow:0 0 8px rgba(255,231,168,.35)}
.board.neg{color:#ff8a7a;text-shadow:0 0 8px rgba(255,138,122,.3)}
.board.flash{animation:flip 1s ease-out}
@keyframes flip{0%{background:var(--board-ink);color:var(--board)}35%{background:var(--board-ink);color:var(--board)}100%{background:var(--board);color:var(--board-ink)}}

.players{margin:0 0 14px;padding:2px 0;border-radius:12px;background:var(--surface);border:1px solid var(--line)}
.pl+.pl,.slot{border-top:1px solid var(--line)}
.prow{border:0;background:none;cursor:pointer;width:100%;text-align:left;display:grid;grid-template-columns:32px 1fr auto 50px;align-items:center;gap:8px;padding:9px 12px}
.pos{font-size:12px;font-weight:700;color:var(--muted)}
.pname{min-width:0}
.pname .n{display:block;font-weight:600;font-stretch:90%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pmeta{display:flex;flex-wrap:wrap;align-items:center;gap:1px 8px;font-size:13px;color:var(--muted);min-height:18px}
.club{font-weight:700;font-stretch:80%;letter-spacing:.02em}
.k{white-space:nowrap}
.k small{font-size:11px;color:var(--muted);margin-left:1px}
.k b{font-size:10px;font-weight:800;color:var(--minus);margin-left:1px}
.k-in{color:var(--plus);font-weight:800}
.k-out{color:var(--minus);font-weight:800}
.st{font-size:13px;color:var(--muted);text-align:right;white-space:nowrap}
.st.live{color:var(--live);font-weight:800}
.pts{font-weight:800;font-size:16px;text-align:right}
.pts.neg{color:var(--minus)}
.pts.zero{color:var(--muted);font-weight:600}
.pl.upcoming .n{color:var(--muted)}
.slot{padding:9px 12px;font-size:13px;color:var(--muted)}
.events{padding:0 12px 10px 52px;font-size:13px}
.events li{display:grid;grid-template-columns:30px 1fr auto;gap:8px;padding:2px 0;color:var(--muted)}
.events .ec{text-align:right;font-weight:700}
.events .ep{text-align:right;color:var(--ink);font-weight:700}
.events .ep.neg{color:var(--minus)}
.noev{margin:0;padding:0 12px 10px 52px;font-size:13px;color:var(--muted)}

.ticker li{display:grid;grid-template-columns:38px 30px 1fr auto;align-items:center;gap:8px;padding:12px 0;border-bottom:1px solid var(--line)}
.ticker li.empty{display:block;color:var(--muted);border:0}
.tmin{font-weight:800;color:var(--muted);text-align:right}
.ticon{font-size:19px;text-align:center}
.twho{min-width:0}
.twho .n{font-weight:700}
.twho .club{font-size:13px;color:var(--muted);margin-left:4px}
.twho .m{display:block;font-size:13px;color:var(--muted)}
.tp{font-weight:800}
.tp.neg{color:var(--minus)}

.note{color:var(--muted);font-size:15px;padding:18px 0 0;margin:0}
footer{color:var(--muted);font-size:12px;padding:28px 0 0}
.meta .benchsum{color:var(--ink);font-weight:600}
.benchhead{display:flex;justify-content:space-between;align-items:baseline;margin:2px 0 6px;padding:0 12px;font-size:13px;font-weight:700;color:var(--muted)}
.benchhead .bsum{color:var(--ink)}
.benchhead .bsum.neg{color:var(--minus)}
.swap{margin:0 0 8px;padding:8px 12px;border-radius:10px;background:var(--chip);font-size:14px}
.players.bench{opacity:.82}
.mrow{-webkit-touch-callout:none;-webkit-user-select:none;user-select:none;position:relative}
body.egg-open{overflow:hidden}
.egg{position:fixed;inset:0;z-index:50;display:flex;align-items:flex-end;justify-content:center;background:rgba(6,10,20,.55)}
.egg-sheet{width:100%;max-width:560px;max-height:88vh;overflow:auto;background:var(--surface);color:var(--ink);border-radius:18px 18px 0 0;padding:16px max(16px, env(safe-area-inset-right, 0px)) calc(24px + env(safe-area-inset-bottom, 0px)) max(16px, env(safe-area-inset-left, 0px));box-shadow:0 -8px 30px rgba(0,0,0,.25)}
.egg-top{display:flex;justify-content:space-between;align-items:center;gap:12px;position:sticky;top:-16px;background:var(--surface);padding:4px 0 8px}
.egg-top h2{margin:0;font-size:22px;font-weight:800;font-stretch:75%}
#egg-close{border:0;background:var(--chip);width:36px;height:36px;border-radius:50%;font-size:22px;line-height:1;cursor:pointer}
.egg-hero{display:flex;flex-direction:column;align-items:flex-start;gap:6px;margin:6px 0 14px}
.egg-label{font-size:13px;color:var(--muted)}
.egg-money{font-family:"Doto","Archivo",monospace;font-weight:900;font-size:clamp(22px,7.5vw,34px);max-width:100%;line-height:1;color:var(--board-ink);background:var(--board);padding:10px 12px 8px;border-radius:10px}
.egg-money.neg{color:#ff9a8c}
.egg h3{margin:18px 0 6px;font-size:15px}
.egg-calc,.egg-tx{list-style:none;margin:0;padding:0}
.egg-calc li{display:flex;justify-content:space-between;gap:12px;padding:7px 0;border-bottom:1px solid var(--line);font-size:14px}
.egg-calc li span:first-child{color:var(--muted);min-width:0}
.egg-calc li span:last-child{font-weight:700;white-space:nowrap}
.egg .plus{color:var(--plus)}
.egg .minus{color:var(--minus)}
.egg-note{margin:8px 0 0;font-size:13px;color:var(--muted)}
.egg-tx li{display:grid;grid-template-columns:44px 1fr auto;gap:8px;align-items:center;padding:7px 0;border-bottom:1px solid var(--line);font-size:14px}
.tx-d{color:var(--muted);font-size:13px}
.tx-n{min-width:0;font-weight:600}
.tx-n small{display:block;font-weight:400;font-size:12px;color:var(--muted)}
.egg-tx li span:last-child{font-weight:700;white-space:nowrap}
.egg-facts{margin-top:12px}
.egg-debt{margin-top:10px;border-top:2px solid var(--line)}
.egg-fix{margin-top:22px;font-size:14px}
.egg-fix summary{cursor:pointer;color:var(--muted)}
.egg-fix form{display:grid;gap:6px;margin-top:10px}
.egg-fix label{font-size:13px;color:var(--muted)}
.egg-fix input{font:inherit;color:var(--ink);background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:9px 10px;width:100%}
.egg-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:6px}
.egg-actions button{font:inherit;font-weight:700;border:0;border-radius:8px;padding:9px 14px;cursor:pointer;background:var(--board);color:var(--board-ink)}
.egg-actions #egg-reset{background:var(--chip);color:var(--ink)}
@media (prefers-reduced-motion: reduce){*{animation:none!important}}
</style>
</head>
<body>
<div class="wrap">
  <header class="top">
    <div>
      <h1 id="league">Live</h1>
      <div class="dayline">
        <button type="button" id="prev" aria-label="Vorheriger Spieltag">‹</button>
        <span id="day">Spieltag</span>
        <button type="button" id="next" aria-label="Nächster Spieltag">›</button>
      </div>
    </div>
    <button type="button" class="status" id="status" title="Jetzt aktualisieren"><span class="dot" aria-hidden="true"></span><span id="stamp">Lädt …</span></button>
  </header>
  <p class="demo" id="demo" hidden>Demo mit erfundenen Daten. Nach dem Deploy siehst du hier deine echte Liga.</p>
  <p class="error" id="error" hidden></p>
  <div class="matches" id="matches" aria-label="Spiele des Spieltags"></div>
  <div class="tabs" role="tablist">
    <button type="button" role="tab" id="tab-table" aria-selected="true" aria-controls="table">Tabelle</button>
    <button type="button" role="tab" id="tab-ticker" aria-selected="false" aria-controls="ticker">Ticker</button>
  </div>
  <ol class="managers" id="table" role="tabpanel" aria-labelledby="tab-table"></ol>
  <ol class="ticker" id="ticker" role="tabpanel" aria-labelledby="tab-ticker" hidden></ol>
  <p class="note" id="note" hidden></p>
  <footer>Live-Punkte über die inoffizielle Kickbase-API. Tippe auf einen Manager für seine Elf, auf einen Spieler für alle Punkte-Ereignisse.</footer>
  <div class="egg" id="egg" hidden role="dialog" aria-modal="true" aria-labelledby="egg-title">
    <div class="egg-sheet">
      <div class="egg-top"><h2 id="egg-title">Akte</h2><button type="button" id="egg-close" aria-label="Schließen">×</button></div>
      <div id="egg-body"></div>
    </div>
  </div>
</div>
<noscript>Diese Seite braucht JavaScript.</noscript>
<script>
(function () {
  'use strict';
  var Q = new URLSearchParams(location.search);
  var KEY = Q.get('key') || '';
  var DEMO = window.__DEMO__ === true || Q.has('demo');
  var POS = { 1: 'TW', 2: 'ABW', 3: 'MF', 4: 'ST' };
  var POS_RANK = { TW: 1, ABW: 2, MF: 3, ST: 4 };
  var ORDER = { upcoming: 0, live: 1, done: 2 };
  var KIND = {
    goal: ['⚽', 'Tor'], owngoal: ['⚽', 'Eigentor'], assist: ['👟', 'Vorlage'],
    yellow: ['🟨', 'Gelbe Karte'], yellowred: ['🟨🟥', 'Gelb-Rote Karte'], red: ['🟥', 'Rote Karte'],
    'in': ['↑', 'Eingewechselt'], out: ['↓', 'Ausgewechselt']
  };
  var S = { day: Number(Q.get('day')) || null, ov: null, live: {}, at: {}, openM: {}, openP: {}, shown: {},
    tab: 'table', busy: false, again: false, timer: 0, okAt: null, err: '', gen: 0, init: false };
  var Demo = DEMO ? makeDemo() : null;

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function pts(n) { return n == null ? '–' : (n < 0 ? '−' : '') + Math.abs(n).toLocaleString('de-DE'); }
  function delta(n) { return (n > 0 ? '+' : n < 0 ? '−' : '±') + Math.abs(n).toLocaleString('de-DE'); }
  function minute(m) { m = String(m == null ? '' : m); return /^\d+$/.test(m) ? m + '’' : m; }
  function hhmm(d) { return d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }); }
  function kickoff(iso) {
    var d = new Date(iso || '');
    if (isNaN(d)) return '';
    if (d.toDateString() === new Date().toDateString()) return hhmm(d);
    return d.toLocaleDateString('de-DE', { weekday: 'short' }).replace('.', '') + ' ' + hhmm(d);
  }
  function later(a, b) { return !a ? b : !b ? a : ORDER[a] >= ORDER[b] ? a : b; }
  function teamIndex(matches) {
    var t = {};
    matches.forEach(function (m) { if (m.home.id) t[m.home.id] = m; if (m.away.id) t[m.away.id] = m; });
    return t;
  }
  function sym(match, teamId) {
    if (!match || !teamId) return '';
    return match.home.id === teamId ? match.home.sym : match.away.sym;
  }

  function api(path, params) {
    if (DEMO) { try { return Promise.resolve(Demo.api(path, params || {})); } catch (e) { return Promise.reject(e); } }
    var u = new URL(path, location.href);
    Object.keys(params || {}).forEach(function (k) {
      var v = params[k];
      if (v != null && v !== '') u.searchParams.set(k, v);
    });
    if (KEY) u.searchParams.set('key', KEY);
    return fetch(u.toString(), { cache: 'no-store' }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) throw new Error(j.error || ('Server antwortet mit HTTP ' + r.status));
        return j;
      });
    });
  }

  // ---------------------------------------------------------- Laden

  function refresh(force) {
    if (S.busy) { S.again = true; return; }
    S.busy = true;
    clearTimeout(S.timer);
    var gen = S.gen;
    document.body.classList.add('busy');
    api('/api/overview', { day: S.day }).then(function (ov) {
      if (gen !== S.gen) return;
      if (!S.ov || S.ov.day !== ov.day || S.ov.league.id !== ov.league.id) { S.live = {}; S.at = {}; S.shown = {}; }
      S.ov = ov;
      S.day = ov.day;
      if (!S.init) {
        S.init = true;
      }
      render(false);
      return loadPlayers(due(ov, force), ov.day, gen);
    }).then(function () {
      if (gen === S.gen) { S.okAt = new Date(); S.err = ''; }
    }).catch(function (e) {
      if (gen === S.gen) S.err = (e && e.message) || 'Unbekannter Fehler';
    }).then(function () {
      S.busy = false;
      document.body.classList.remove('busy');
      if (S.again) { S.again = false; refresh(true); return; }
      render(true);
      schedule();
    });
  }

  // Welche Spieler brauchen frische Live-Daten?
  function due(ov, force) {
    var tm = teamIndex(ov.matches), now = Date.now(), live = [], rest = [];
    Object.keys(ov.players).forEach(function (id) {
      var meta = ov.players[id], m = meta.teamId ? tm[meta.teamId] : null, st = m ? m.state : null;
      var prev = S.live[id], age = now - (S.at[id] || 0);
      if (st === 'upcoming') return;
      if (st === 'live') { if (force || age > 20000) live.push(id); return; }
      if (!prev || prev.error || force || prev.state === 'live' || age > 600000) { rest.push(id); return; }
      if (prev.state === 'upcoming' && prev.kickoff && Date.parse(prev.kickoff) <= now) rest.push(id);
    });
    return live.concat(rest);
  }

  function loadPlayers(ids, day, gen) {
    if (!ids.length) return Promise.resolve();
    var size = (S.ov && S.ov.batch) || 30, chunks = [], i = 0, failed = '';
    for (var k = 0; k < ids.length; k += size) chunks.push(ids.slice(k, k + size));
    function next() {
      if (i >= chunks.length || gen !== S.gen) return Promise.resolve();
      var chunk = chunks[i++];
      return api('/api/players', { ids: chunk.join(','), day: day }).then(function (r) {
        if (gen !== S.gen) return;
        var now = Date.now(), got = r.players || {};
        Object.keys(got).forEach(function (id) { S.live[id] = got[id]; S.at[id] = now; });
        render(false);
      }, function (e) { failed = e.message; }).then(next);
    }
    return Promise.all([next(), next()]).then(function () { if (failed) throw new Error(failed); });
  }

  function schedule() {
    clearTimeout(S.timer);
    if (document.hidden || !S.ov) return;
    var now = Date.now();
    var hot = S.ov.matches.some(function (m) {
      if (m.state === 'live') return true;
      var ko = Date.parse(m.kickoff || '');
      return m.state === 'upcoming' && ko && ko - now < 15 * 60000 && now - ko < 3 * 3600000;
    });
    var wait = DEMO ? 60000 : S.err ? 60000 : hot ? 30000 : 300000;
    S.timer = setTimeout(function () { refresh(false); }, wait);
  }

  // ---------------------------------------------------------- Rechnen

  function standings() {
    var ov = S.ov, tm = teamIndex(ov.matches), current = ov.day === ov.currentDay;
    function row(id, slot) {
      var meta = ov.players[id] || {};
      var lv = S.live[id] && !S.live[id].error ? S.live[id] : null;
      var teamId = (lv && lv.teamId) || meta.teamId || null;
      var match = teamId ? tm[teamId] : null;
      var state = later(lv && lv.state, match && match.state) || 'upcoming';
      return {
        id: id, slot: slot, name: (lv && lv.name) || meta.name || ('Spieler ' + id),
        pos: POS[meta.pos] || '', team: sym(match, teamId), points: lv ? lv.points : 0, state: state,
        minute: (lv && lv.minute) || (match && match.minute) || '',
        kickoff: (match && match.kickoff) || (lv && lv.kickoff) || null,
        role: lv ? lv.role : null, keys: lv ? lv.keys : [], events: lv ? lv.events : [], loaded: !!lv
      };
    }
    var rows = ov.managers.map(function (m) {
      var players = [];
      m.lineup.forEach(function (id, slot) { if (id) players.push(row(id, slot)); });
      players.sort(function (a, b) { return ((POS_RANK[a.pos] || 5) - (POS_RANK[b.pos] || 5)) || (a.slot - b.slot); });
      var points = 0, played = 0, missing = 0;
      players.forEach(function (p) {
        points += p.points;
        if (p.state !== 'upcoming') { played++; if (!p.loaded) missing++; }
      });
      var bench = (m.bench || []).map(function (id, i) { return row(id, 100 + i); })
        .sort(function (a, b) { return (b.points - a.points) || ((POS_RANK[a.pos] || 5) - (POS_RANK[b.pos] || 5)); });
      var benchPlayed = bench.filter(function (p) { return p.state !== 'upcoming' && p.loaded; });
      var o = m.official || {};
      var season = o.season == null ? null : current ? o.season - (o.day || 0) + points : o.season;
      return { id: m.id, name: m.name, points: points, season: season, officialRank: o.seasonRank,
        played: played, size: players.length, missing: missing, players: players, bench: bench,
        benchPoints: benchPlayed.reduce(function (s, p) { return s + p.points; }, 0),
        benchPlayed: benchPlayed.length, swap: bestSwap(players, bench) };
    });
    rows.sort(function (a, b) { return (b.points - a.points) || ((b.season || 0) - (a.season || 0)); });
    rows.forEach(function (r, i) { r.rank = i > 0 && rows[i - 1].points === r.points ? rows[i - 1].rank : i + 1; });
    rows.slice().sort(function (a, b) {
      return (b.season == null ? -1e12 : b.season) - (a.season == null ? -1e12 : a.season);
    }).forEach(function (r, i) { r.seasonRank = i + 1; });
    return rows;
  }

  // Größter verpasster Gewinn: Bankspieler statt schwächstem Startspieler derselben Position
  function bestSwap(players, bench) {
    var best = null;
    bench.forEach(function (b) {
      if (b.state === 'upcoming' || !b.loaded) return;
      players.forEach(function (s) {
        if (s.pos !== b.pos || s.state === 'upcoming') return;
        var gain = b.points - s.points;
        if (gain > 0 && (!best || gain > best.gain)) best = { inName: b.name, outName: s.name, gain: gain };
      });
    });
    return best;
  }

  // ---------------------------------------------------------- Anzeigen

  function render(final) {
    if (S.press) { S.renderLater = S.renderLater || final || 'yes'; return; }
    var ov = S.ov;
    $('stamp').textContent = S.err ? (S.okAt ? 'Fehler, Stand ' + hhmm(S.okAt) : 'Fehler')
      : S.okAt ? 'Stand ' + S.okAt.toLocaleTimeString('de-DE') : 'Lädt …';
    $('status').classList.toggle('bad', !!S.err);
    $('error').hidden = !S.err;
    $('error').textContent = S.err ? S.err + ' Tippe oben rechts, um es nochmal zu versuchen.' : '';
    if (!ov) return;
    $('league').textContent = ov.league.name || 'Liga';
    $('day').textContent = 'Spieltag ' + ov.day;
    $('prev').disabled = DEMO || ov.day <= 1;
    $('next').disabled = DEMO || ov.day >= (ov.currentDay || ov.days || 34);
    document.body.classList.toggle('is-live', ov.matches.some(function (m) { return m.state === 'live'; }));
    renderMatches(ov);
    renderTable(standings(), final);
    renderTicker(ov);
    var note = '';
    if (!ov.managers.length) note = 'In dieser Liga gibt es keine Manager.';
    else if (!ov.managers.some(function (m) { return m.lineup.some(Boolean); })) note = 'Für diesen Spieltag sind noch keine Aufstellungen sichtbar.';
    $('note').hidden = !note;
    $('note').textContent = note;
  }

  function renderMatches(ov) {
    $('matches').innerHTML = ov.matches.map(function (m) {
      var score = m.state === 'upcoming' ? '–:–' : (m.home.goals == null ? 0 : m.home.goals) + ':' + (m.away.goals == null ? 0 : m.away.goals);
      var sub = m.state === 'live' ? (minute(m.minute) || 'läuft') : m.state === 'done' ? 'Ende' : kickoff(m.kickoff);
      return '<div class="match ' + m.state + '"><span class="t">' + esc(m.home.sym) + '</span><span class="score">' + score +
        '</span><span class="t">' + esc(m.away.sym) + '</span><span class="sub">' + esc(sub) + '</span></div>';
    }).join('');
  }

  function trend(r) {
    if (!r.officialRank || S.ov.day !== S.ov.currentDay) return '';
    var d = r.officialRank - r.seasonRank;
    return d > 0 ? ' <span class="up">↑' + d + '</span>' : d < 0 ? ' <span class="down">↓' + (-d) + '</span>' : '';
  }

  function renderTable(rows, final) {
    $('table').innerHTML = rows.map(function (r) {
      var open = !!S.openM[r.id];
      var flash = false;
      if (final) {
        flash = S.shown[r.id] != null && S.shown[r.id] !== r.points;
        S.shown[r.id] = r.points;
      }
      var meta = r.size
        ? '<span>' + r.played + '/' + r.size + ' gespielt</span>' +
          (r.season != null ? '<span>Gesamt ' + pts(r.season) + ', Platz ' + r.seasonRank + trend(r) + '</span>' : '') +
          (r.benchPlayed ? '<span class="benchsum">Bank ' + delta(r.benchPoints) + '</span>' : '') +
          (r.missing ? '<span>' + r.missing + ' laden noch</span>' : '')
        : '<span>Aufstellung nicht sichtbar</span>';
      var head = '<button type="button" class="mrow" data-m="' + esc(r.id) + '" aria-expanded="' + open + '">' +
        '<span class="rank">' + r.rank + '</span>' +
        '<span class="who"><span class="name">' + esc(r.name) +
        '</span><span class="meta">' + meta + '</span></span>' +
        '<span class="board' + (r.points < 0 ? ' neg' : '') + (flash ? ' flash' : '') + '">' + pts(r.points) + '</span></button>';
      var body = '';
      if (open) {
        var empty = r.size && r.size < 11 ? 11 - r.size : 0;
        body = '<ul class="players">' + r.players.map(renderPlayer).join('') +
          (empty ? '<li class="slot">' + empty + (empty === 1 ? ' Platz' : ' Plätze') + ' in der Elf leer</li>' : '') +
          (!r.size ? '<li class="slot">Keine Aufstellung sichtbar.</li>' : '') + '</ul>';
        if (r.bench.length) {
          body += '<div class="benchhead"><span>Auf der Bank</span><span class="bsum' + (r.benchPoints < 0 ? ' neg' : '') + '">' +
            (r.benchPlayed ? delta(r.benchPoints) : '') + '</span></div>' +
            (r.swap ? '<p class="swap">Mit <b>' + esc(r.swap.inName) + '</b> statt ' + esc(r.swap.outName) +
              ' wären es <b>' + delta(r.swap.gain) + '</b> gewesen.</p>' : '') +
            '<ul class="players bench">' + r.bench.map(renderPlayer).join('') + '</ul>';
        }
      }
      return '<li class="mgr' + (open ? ' open' : '') + '">' + head + body + '</li>';
    }).join('');
  }

  function badge(k) {
    var d = KIND[k.kind];
    if (!d) return '';
    var m = k.min != null ? minute(k.min) : '';
    return '<span class="k k-' + k.kind + '" title="' + d[1] + (m ? ' ' + m : '') + '">' + d[0] +
      (k.kind === 'owngoal' ? '<b>ET</b>' : '') + (m ? '<small>' + esc(m) + '</small>' : '') + '</span>';
  }

  function renderPlayer(p) {
    var open = !!S.openP[p.id], status;
    if (p.state === 'live') status = p.role === 'bench' ? '<span class="st">Bank</span>' : '<span class="st live">' + esc(minute(p.minute) || 'läuft') + '</span>';
    else if (p.state === 'done') status = '<span class="st">' + (!p.loaded ? '…' : p.role === 'bench' ? 'Bank' : p.role ? 'Ende' : 'nicht dabei') + '</span>';
    else status = '<span class="st">' + esc(kickoff(p.kickoff)) + '</span>';
    var cls = p.points < 0 ? ' neg' : p.points === 0 ? ' zero' : '';
    var row = '<button type="button" class="prow" data-p="' + esc(p.id) + '" aria-expanded="' + open + '">' +
      '<span class="pos">' + esc(p.pos) + '</span>' +
      '<span class="pname"><span class="n">' + esc(p.name) + '</span><span class="pmeta">' +
      (p.team ? '<span class="club">' + esc(p.team) + '</span>' : '') + (p.keys || []).map(badge).join('') + '</span></span>' +
      status + '<span class="pts' + cls + '">' + pts(p.points) + '</span></button>';
    var detail = '';
    if (open) {
      var groups = grouped(p.events || []);
      detail = groups.length
        ? '<ol class="events">' + groups.map(function (g) {
            return '<li><span class="ec">' + (g.n > 1 ? g.n + '×' : '') + '</span><span>' + esc(g.name) +
              '</span><span class="ep' + (g.p < 0 ? ' neg' : '') + '">' + delta(g.p) + '</span></li>';
          }).join('') + '</ol>'
        : '<p class="noev">' + (p.state === 'upcoming' ? 'Das Spiel hat noch nicht begonnen.' : p.loaded ? 'Noch keine Punkte-Ereignisse.' : 'Wird geladen …') + '</p>';
    }
    return '<li class="pl ' + p.state + (open ? ' open' : '') + '">' + row + detail + '</li>';
  }

  // Gleiche Ereignisse zusammenfassen (Kickbase liefert pro Spiel oft 60+ Kleinst-Events)
  function grouped(events) {
    var map = {}, list = [];
    events.forEach(function (e) {
      if (!map[e.name]) { map[e.name] = { name: e.name, n: 0, p: 0 }; list.push(map[e.name]); }
      map[e.name].n++;
      map[e.name].p += e.p;
    });
    return list.filter(function (g) { return g.p !== 0; })
      .sort(function (a, b) { return (Math.abs(b.p) - Math.abs(a.p)) || (b.n - a.n); });
  }

  function renderTicker(ov) {
    var tm = teamIndex(ov.matches), items = [];
    ov.managers.forEach(function (m) {
      m.lineup.forEach(function (id) {
        var lv = id && S.live[id];
        if (!lv || lv.error) return;
        var match = lv.teamId ? tm[lv.teamId] : null;
        var ko = Date.parse((match && match.kickoff) || lv.kickoff || '') || 0;
        (lv.keys || []).forEach(function (k) {
          if (k.kind === 'in' || k.kind === 'out' || !KIND[k.kind]) return;
          var mi = k.min || 0;
          items.push({ k: k, lv: lv, m: m, team: sym(match, lv.teamId), t: ko + (mi + (mi > 45 ? 15 : 0)) * 60000 });
        });
      });
    });
    items.sort(function (a, b) { return b.t - a.t; });
    $('ticker').innerHTML = items.length ? items.slice(0, 120).map(function (it) {
      var d = KIND[it.k.kind];
      return '<li><span class="tmin">' + (it.k.min == null ? '' : esc(minute(it.k.min))) + '</span>' +
        '<span class="ticon" aria-hidden="true">' + d[0] + '</span>' +
        '<span class="twho"><span class="n">' + esc(it.lv.name) + (it.team ? ' <span class="club">' + esc(it.team) + '</span>' : '') +
        '</span><span class="m">' + d[1] + ' bei ' + esc(it.m.name) + '</span></span>' +
        '<span class="tp' + (it.k.p < 0 ? ' neg' : '') + '">' + (it.k.p ? delta(it.k.p) : '') + '</span></li>';
    }).join('') : '<li class="empty">Noch keine Tore, Vorlagen oder Karten bei aufgestellten Spielern.</li>';
  }

  function setTab(t) {
    S.tab = t;
    $('tab-table').setAttribute('aria-selected', String(t === 'table'));
    $('tab-ticker').setAttribute('aria-selected', String(t === 'ticker'));
    $('table').hidden = t !== 'table';
    $('ticker').hidden = t !== 'ticker';
  }

  // ---------------------------------------------------------- 🥚 5 Sekunden auf einen Manager drücken

  var HOLD = 5000;
  function money(n) {
    if (n == null || isNaN(n)) return '–';
    var a = Math.abs(n), s = n < 0 ? '−' : '';
    return s + Math.round(a).toLocaleString('de-DE') + ' €';
  }
  function dmy(iso) {
    var d = new Date(iso || '');
    return isNaN(d) ? '' : d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
  }
  function pressEnd(fired) {
    if (!S.press) return;
    clearTimeout(S.press.timer);
    S.press = null;
    if (fired) S.eggFired = true;
    if (S.renderLater) { var f = S.renderLater === true; S.renderLater = null; render(f); }
  }
  document.addEventListener('pointerdown', function (e) {
    var el = e.target.closest && e.target.closest('.mrow');
    if (!el || (e.pointerType === 'mouse' && e.button !== 0)) return;
    pressEnd(false);
    S.eggFired = false;
    S.press = {
      el: el, id: el.dataset.m, x: e.clientX, y: e.clientY,
      timer: setTimeout(function () {
        var id = S.press && S.press.id;
        pressEnd(true);
        if (navigator.vibrate) { try { navigator.vibrate([30, 40, 60]); } catch (_) {} }
        openEgg(id);
      }, HOLD)
    };
  });
  document.addEventListener('pointermove', function (e) {
    if (S.press && Math.abs(e.clientX - S.press.x) + Math.abs(e.clientY - S.press.y) > 14) pressEnd(false);
  });
  ['pointerup', 'pointercancel'].forEach(function (t) { document.addEventListener(t, function () { pressEnd(false); }); });
  document.addEventListener('contextmenu', function (e) { if (e.target.closest && e.target.closest('.mrow')) e.preventDefault(); });

  function openEgg(id) {
    var m = S.ov && S.ov.managers.filter(function (x) { return x.id === id; })[0];
    $('egg-title').textContent = 'Akte ' + (m ? m.name : '');
    $('egg-body').innerHTML = '<p class="egg-note">Lade die Akte …</p>';
    $('egg').hidden = false;
    document.body.classList.add('egg-open');
    $('egg-close').focus();
    api('/api/manager', { id: id }).then(renderEgg, function (e) {
      $('egg-body').innerHTML = '<p class="egg-note">' + esc(e.message) + '</p>';
    });
  }
  function closeEgg() {
    $('egg').hidden = true;
    document.body.classList.remove('egg-open');
  }
  function renderEgg(f) {
    S.egg = f;
    var M = f.money, cal = f.calibration;
    var line = function (label, val, cls) {
      return '<li><span>' + label + '</span><span class="' + (cls || '') + '">' + val + '</span></li>';
    };
    var signed = function (n) { return (n >= 0 ? '+' : '') + money(n); };
    var ach = (f.achievements || []).map(function (a) {
      return '<li><span>' + esc(a.name) + (a.count > 1 ? ' ×' + a.count : '') + '</span><span class="plus">+' + money(a.amount) + '</span></li>';
    }).join('');
    $('egg-body').innerHTML =
      '<div class="egg-hero"><span class="egg-label">Kontostand, ' + (cal ? 'hochgerechnet' : 'geschätzt') + '</span>' +
      '<span class="egg-money' + (M.estimate < 0 ? ' neg' : '') + '">' + money(M.estimate) + '</span></div>' +
      '<ul class="egg-calc">' +
        (cal ? line('Korrigierter Stand am ' + dmy(cal.at), money(cal.amount))
             : line('Startbudget', money(M.start))) +
        line('Verkäufe (' + f.counts.sells + ')', '+' + money(M.sold), 'plus') +
        line('Käufe (' + f.counts.buys + ')', '−' + money(M.bought), 'minus') +
        line('Login-Bonus (' + M.loginDays + ' Tage × ' + money(M.loginBonus) + ')', '+' + money(M.login), 'plus') +
        line('Punkteprämie (' + money(M.pointMoney) + ' pro Punkt)', signed(M.points), M.points < 0 ? 'minus' : 'plus') +
        line('Erfolgsprämien', '+' + money(M.achievements), 'plus') +
      '</ul>' +
      (M.maxDebt != null ? '<ul class="egg-calc egg-debt">' +
        line('Max. Minus (33 % vom Teamwert)', money(M.maxDebt), 'minus') +
        line('Spielraum für Käufe/Gebote', money(Math.max(0, M.room)), M.room > 0 ? 'plus' : 'minus') +
      '</ul>' : '') +
      '<p class="egg-note">' + (cal ? 'Seit der Korrektur am ' + dmy(cal.at) + ' weitergerechnet. ' : 'Ab Ligastart am ' + dmy(f.since) + ' gerechnet. ') +
        'Annahme: jeden Tag eingeloggt. Erfolge sind aus Aufstellungen, Punkten, Toren und Transfers nachgerechnet.</p>' +
      '<h3>Erfolge' + (cal ? ' seit der Korrektur' : '') + '</h3><ul class="egg-calc">' +
        (ach || '<li><span>Keine</span><span></span></li>') +
      '</ul>' +
      '<ul class="egg-calc egg-facts">' +
        line('Platz in der Liga', f.placement || '–') +
        line('Spieltagssiege', f.matchdayWins == null ? '–' : f.matchdayWins) +
        line('Saisonpunkte', pts(f.seasonPoints) + (f.averagePoints ? ' (Ø ' + pts(f.averagePoints) + ')' : '')) +
        line('Teamwert', money(f.teamValue)) +
      '</ul>' +
      '<h3>Transfers</h3>' +
      (f.transfers.length ? '<ol class="egg-tx">' + f.transfers.map(function (t) {
        var buy = t.kind === 'buy';
        return '<li><span class="tx-d">' + dmy(t.date) + '</span><span class="tx-n">' + esc(t.player) +
          '<small>' + (buy ? 'gekauft' : 'verkauft') + (t.other ? (buy ? ' von ' : ' an ') + esc(t.other) : '') + '</small></span>' +
          '<span class="' + (buy ? 'minus' : 'plus') + '">' + (buy ? '−' : '+') + money(t.price) + '</span></li>';
      }).join('') + '</ol>' : '<p class="egg-note">Noch keine Transfers.</p>') +
      '<details class="egg-fix"><summary>Kontostand korrigieren</summary>' +
        '<form id="egg-form" autocomplete="off">' +
          '<label for="egg-amount">Echter Kontostand in €</label>' +
          '<input id="egg-amount" inputmode="decimal" placeholder="z. B. -47.248.029" value="' + (cal ? cal.amount : '') + '">' +
          '<label for="egg-at">Stand vom</label>' +
          '<input id="egg-at" type="datetime-local" value="' + localInput(cal ? cal.at : null) + '">' +
          '<label for="egg-key">Schlüssel</label>' +
          '<input id="egg-key" type="password" value="' + esc(savedKey()) + '">' +
          '<div class="egg-actions"><button type="submit">Speichern</button>' +
          (cal ? '<button type="button" id="egg-reset">Korrektur löschen</button>' : '') + '</div>' +
          '<p class="egg-note" id="egg-msg"></p>' +
        '</form></details>';
  }

  function localInput(iso) {
    var d = iso ? new Date(iso) : new Date();
    d = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
    return d.toISOString().slice(0, 16);
  }
  function savedKey() { try { return localStorage.getItem('bousching-key') || ''; } catch (_) { return ''; } }
  function saveCal(amount) {
    var key = $('egg-key').value.trim();
    try { localStorage.setItem('bousching-key', key); } catch (_) {}
    $('egg-msg').textContent = 'Speichere …';
    var at = $('egg-at').value ? new Date($('egg-at').value).toISOString() : null;
    var body = JSON.stringify({ id: S.egg.id, amount: amount, at: at });
    var req = DEMO ? Promise.resolve({ ok: true, json: function () { return {}; } })
      : fetch('/api/calibrate', { method: 'POST', headers: { 'content-type': 'application/json', 'x-access-key': key }, body: body });
    req.then(function (r) {
      if (!r.ok) return r.json().catch(function () { return {}; }).then(function (j) { throw new Error(j.error || 'Fehler ' + r.status); });
      $('egg-msg').textContent = DEMO ? 'In der Demo wird nichts gespeichert.' : 'Gespeichert.';
      if (!DEMO) return api('/api/manager', { id: S.egg.id }).then(renderEgg);
    }).catch(function (e) { $('egg-msg').textContent = e.message; });
  }
  document.addEventListener('submit', function (e) {
    if (e.target.id !== 'egg-form') return;
    e.preventDefault();
    var raw = $('egg-amount').value.replace(/\s|€/g, '').replace(/[−–]/g, '-').replace(/\./g, '').replace(',', '.');
    var n = Number(raw);
    if (raw === '' || !isFinite(n)) { $('egg-msg').textContent = 'Bitte einen Betrag eingeben, z. B. -47.248.029'; return; }
    saveCal(Math.round(n));
  });

  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !$('egg').hidden) closeEgg(); });

  document.addEventListener('click', function (e) {
    if (e.target.id === 'egg' || (e.target.closest && e.target.closest('#egg-close'))) { closeEgg(); return; }
    if (e.target.id === 'egg-reset') { saveCal(null); return; }
    var el = e.target.closest('button');
    if (!el) return;
    if (el.dataset.m) {
      if (S.eggFired) { S.eggFired = false; return; }
      S.openM[el.dataset.m] = !S.openM[el.dataset.m]; render(false); return;
    }
    if (el.dataset.p) { S.openP[el.dataset.p] = !S.openP[el.dataset.p]; render(false); return; }
    if (el.id === 'tab-table') return setTab('table');
    if (el.id === 'tab-ticker') return setTab('ticker');
    if (el.id === 'status') return refresh(true);
    if ((el.id === 'prev' || el.id === 'next') && S.ov) {
      S.day = S.ov.day + (el.id === 'prev' ? -1 : 1);
      S.gen++;
      var u = new URL(location.href);
      if (S.day === S.ov.currentDay) u.searchParams.delete('day'); else u.searchParams.set('day', S.day);
      history.replaceState(null, '', u.toString());
      $('day').textContent = 'Spieltag ' + S.day;
      refresh(true);
    }
  });

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) clearTimeout(S.timer); else refresh(false);
  });

  // ---------------------------------------------------------- Demo (erfundene Daten)

  function makeDemo() {
    var seed = 20261108;
    function rnd() {
      seed = (seed + 0x6D2B79F5) | 0;
      var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
    function int(a, b) { return b <= a ? a : a + Math.floor(rnd() * (b - a + 1)); }
    function pick(a) { return a[Math.floor(rnd() * a.length)]; }
    var CLUBS = ['ISA', 'DON', 'INN', 'VIL', 'ROT', 'ILZ', 'REG', 'LAA', 'ALZ', 'NAA', 'LEC', 'ILM', 'ABE', 'PAA', 'ROD', 'WER', 'ALT', 'SEM'];
    var SUR = ['Huber', 'Bauer', 'Maier', 'Hofer', 'Lechner', 'Wimmer', 'Brandl', 'Eder', 'Gruber', 'Moser', 'Reiter', 'Steiner',
      'Weber', 'Wagner', 'Fischer', 'Schmid', 'Lang', 'Fuchs', 'Berger', 'Hartl', 'Pichler', 'Aigner', 'Strobl', 'Kern', 'Brunner',
      'Haas', 'Holzer', 'Winkler', 'Lindner', 'Stadler', 'Graf', 'Krause', 'Neumann', 'Vogel', 'Roth', 'Lorenz', 'Kraus', 'Sommer',
      'Böhm', 'Kaiser', 'Ludwig', 'Beck', 'Seidl', 'Ott', 'Probst', 'Riedl', 'Zach', 'Mayr', 'Feichtl', 'Grill', 'Kastl', 'Sturm',
      'Hager', 'Forster', 'Nagl', 'Kurz', 'Sedlmeier', 'Haslinger', 'Obermeier', 'Rauscher'];
    var MGRS = ['Sepp', 'Vroni', 'Wast', 'Kathi', 'Beni', 'Toni', 'Resi', 'Flo'];
    var SMALL = [['Pass ins letzte Drittel', 1], ['Pass in die Angriffszone', 1], ['Ballverlust', -1], ['Zweikampf gewonnen', 5],
      ['Zweikampf verloren', -2], ['Torschuss', 12], ['Großchance kreiert', 15], ['Großchance vergeben', -15], ['Ball erobert', 5],
      ['Klärende Aktion', 3], ['Foul begangen', -3], ['Abseits', -3], ['Schuss geblockt', 4]];
    var now = Date.now(), MIN = 60000;
    var PLAN = [['done', -190], ['done', -186], ['done', -122], ['live', -93], ['live', -39], ['live', -21], ['upcoming', 95], ['upcoming', 1405], ['upcoming', 1525]];
    var matches = PLAN.map(function (p, i) {
      var st = p[0], el = -p[1], mi = st === 'live' ? (el > 62 ? el - 15 : Math.min(45, el)) : 90;
      return { id: 'd' + i, kickoff: new Date(now + p[1] * MIN).toISOString(), state: st, minute: st === 'upcoming' ? '' : String(mi),
        home: { id: CLUBS[2 * i], sym: CLUBS[2 * i], goals: st === 'upcoming' ? null : 0 },
        away: { id: CLUBS[2 * i + 1], sym: CLUBS[2 * i + 1], goals: st === 'upcoming' ? null : 0 } };
    });
    var byTeam = {};
    matches.forEach(function (m) { byTeam[m.home.id] = m; byTeam[m.away.id] = m; });

    function player(id, pl, m) {
      var base = { id: id, name: pl.name, teamId: pl.teamId, kickoff: m.kickoff, minute: m.state === 'live' ? m.minute : '',
        state: m.state, role: null, points: 0, keys: [], events: [] };
      if (m.state === 'upcoming') return base;
      var maxMin = m.state === 'live' ? Number(m.minute) : 90, roll = rnd();
      var role = roll < 0.05 ? 'bench' : roll < 0.15 ? 'sub' : 'start';
      if (role === 'sub' && maxMin < 60) role = 'bench';
      base.role = role;
      if (role === 'bench') return base;
      var from = role === 'sub' ? int(56, maxMin - 2) : 0, to = maxMin, ev = [], keys = [];
      if (role === 'start') ev.push({ min: 0, name: 'Startelf', p: 5 }); else keys.push({ kind: 'in', min: from, p: 0 });
      if (role === 'start' && maxMin > 64 && rnd() < 0.3) { to = int(60, maxMin - 1); keys.push({ kind: 'out', min: to, p: 0 }); }
      var count = Math.round(int(6, 18) * (to - from) / 90);
      for (var i = 0; i < count; i++) { var s = pick(SMALL); ev.push({ min: int(from + 1, to), name: s[0], p: s[1] }); }
      if (pl.pos === 1) for (var j = int(0, 4); j > 0; j--) ev.push({ min: int(from + 1, to), name: 'Parade', p: 20 });
      if (rnd() < [0, 0, 0.06, 0.16, 0.34][pl.pos]) {
        var gm = int(from + 1, to), gp = [0, 0, 100, 90, 80][pl.pos];
        ev.push({ min: gm, name: ['', '', 'Tor (Abwehr)', 'Tor (Mittelfeld)', 'Tor (Sturm)'][pl.pos], p: gp });
        keys.push({ kind: 'goal', min: gm, p: gp });
        var side = m.home.id === pl.teamId ? m.home : m.away;
        side.goals += 1;
      }
      if (rnd() < 0.14) { var am = int(from + 1, to); ev.push({ min: am, name: 'Vorlage', p: 40 }); keys.push({ kind: 'assist', min: am, p: 40 }); }
      if (rnd() < 0.12) { var ym = int(from + 1, to); ev.push({ min: ym, name: 'Gelbe Karte', p: -20 }); keys.push({ kind: 'yellow', min: ym, p: -20 }); }
      if (m.state === 'done' && to >= 60) ev.push({ min: 90, name: 'Spielminuten-Bonus', p: 8 });
      var byMin = function (a, b) { return a.min - b.min; };
      base.events = ev.sort(byMin);
      base.keys = keys.sort(byMin);
      base.points = ev.reduce(function (s, e) { return s + e.p; }, 0);
      return base;
    }

    var meta = {}, live = {}, n = 1000, LAYOUT = [1, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4];
    var managers = MGRS.map(function (name, mi) {
      var lineup = LAYOUT.map(function (pos, slot) {
        if (mi === 6 && slot === 10) return null;
        var id = String(n++), club = pick(CLUBS);
        meta[id] = { name: pick(SUR), pos: pos, teamId: club };
        live[id] = player(id, meta[id], byTeam[club]);
        return id;
      });
      var bench = [2, 3, 4, 1].map(function (pos) {
        var id = String(n++), club = pick(CLUBS);
        meta[id] = { name: pick(SUR), pos: pos, teamId: club };
        live[id] = player(id, meta[id], byTeam[club]);
        return id;
      });
      var doneDay = lineup.reduce(function (s, id) { return s + (id && live[id].state === 'done' ? live[id].points : 0); }, 0);
      return { id: 'u' + mi, name: name, image: null, lineup: lineup, bench: bench,
        official: { day: doneDay, season: int(3900, 6300) + doneDay, seasonRank: null, dayRank: null } };
    });
    matches.forEach(function (m) {
      if (m.state === 'upcoming') return;
      if (rnd() < 0.4) m.home.goals += 1;
      if (rnd() < 0.3) m.away.goals += 1;
    });
    managers.slice().sort(function (a, b) { return b.official.season - a.official.season; })
      .forEach(function (m, i) { m.official.seasonRank = i + 1; });
    function copy(x) { return JSON.parse(JSON.stringify(x)); }
    return {
      api: function (path, params) {
        if (path === '/api/overview') {
          return copy({ league: { id: 'demo', name: 'Demo-Liga' }, day: 11, currentDay: 11, days: 34, matches: matches,
            managers: managers, players: meta, batch: 30, updatedAt: new Date().toISOString() });
        }
        if (path === '/api/players') {
          var out = {};
          String(params.ids || '').split(',').forEach(function (id) { if (live[id]) out[id] = live[id]; });
          return copy({ day: 11, players: out });
        }
        if (path === '/api/manager') {
          var mg = managers.filter(function (x) { return x.id === params.id; })[0];
          if (!mg) throw new Error('Diesen Manager gibt es nicht.');
          var tx = [], t = Date.now();
          for (var k = 0; k < 14; k++) {
            t -= int(4, 60) * 3600000;
            var buy = rnd() < 0.55, other = rnd() < 0.3 ? pick(MGRS.filter(function (x) { return x !== mg.name; })) : null;
            tx.push({ date: new Date(t).toISOString(), player: pick(SUR), kind: buy ? 'buy' : 'sell', price: int(5, 300) * 100000, other: other });
          }
          var bought = tx.filter(function (x) { return x.kind === 'buy'; }).reduce(function (a, x) { return a + x.price; }, 0);
          var sold = tx.filter(function (x) { return x.kind === 'sell'; }).reduce(function (a, x) { return a + x.price; }, 0);
          var since = new Date(Date.now() - 60 * 86400000).toISOString(), sp = mg.official.season;
          var achv = [{ name: 'Spieltagssieger', count: 2, amount: 2000000 }, { name: 'Kreisliga', count: 1, amount: 1000000 },
            { name: 'Topscorer', count: 3, amount: 300000 }, { name: 'Bronzenes Händchen', count: 1, amount: 250000 }];
          var M = { start: 50000000, sold: sold, bought: bought, loginDays: 61, loginBonus: 100000, login: 6100000, pointMoney: 1000, points: sp * 1000,
            achievements: 3550000 };
          M.estimate = M.start + sold - bought + M.login + M.points + M.achievements;
          var tvv = int(150, 300) * 1000000;
          M.maxDebt = -Math.round(tvv * 0.33); M.room = M.estimate - M.maxDebt;
          return copy({ id: mg.id, name: mg.name, placement: mg.official.seasonRank, seasonPoints: sp, averagePoints: Math.round(sp / 10),
            matchdayWins: int(0, 3), teamValue: int(150, 300) * 1000000, since: since, money: M,
            counts: { buys: tx.filter(function (x) { return x.kind === 'buy'; }).length, sells: tx.filter(function (x) { return x.kind === 'sell'; }).length },
            calibration: null, achievements: achv, transfers: tx });
        }
        return {};
      }
    };
  }

  $('demo').hidden = !DEMO;
  setTab('table');
  refresh(false);
})();
</script>
</body>
</html>
`;
