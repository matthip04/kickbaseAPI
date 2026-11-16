/*
 * Bousching Live – Live-Punkte deiner Kickbase-Liga als API + Handy-Seite
 * ------------------------------------------------------------------------
 * Läuft als Cloudflare Worker (Free-Plan reicht) oder lokal/Docker mit `node server.mjs`.
 * Datenquelle: inoffizielle Kickbase-API v4 (Community-Doku kevinskyba/kickbase-api-doc).
 * Kickbase kann die Schnittstelle jederzeit ändern – dann hilft /api/raw beim Nachjustieren.
 *
 * Endpunkte (alle GET, bei gesetztem ACCESS_KEY immer mit ?key=...)
 *   /                        Live-Seite fürs Handy
 *   /?demo=1                 Seite mit erfundenen Daten (ohne Kickbase)
 *   /api/live                Alles in einem JSON: Manager, Aufstellungen, Live-Punkte, Events
 *   /api/overview            Liga, Spieltag, Spiele, Manager + Aufstellungen (ohne Live-Punkte)
 *   /api/players?ids=1,2     Live-Punkte + Events einzelner Spieler (max. PLAYER_BATCH pro Aufruf)
 *   /api/leagues             Deine Ligen mit ID
 *   /api/raw?path=/v4/...    Kickbase-Rohdaten zum Debuggen (nur mit ?debug=DEBUG_KEY)
 *   Optional überall: ?day=N für einen anderen Spieltag.
 *
 * Einstellungen (Cloudflare: Worker → Settings → Variables and Secrets)
 *   KICKBASE_EMAIL, KICKBASE_PASSWORD  Pflicht, als Secret anlegen
 *   LEAGUE_NAME oder LEAGUE_ID         welche Liga (ohne Angabe: die erste)
 *   ACCESS_KEY                         empfohlen: Seite + API nur mit ?key=...
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
    cached('sq:' + league.id + ':' + u.i, 15 * 60000, () => kb.get('/v4/leagues/' + league.id + '/managers/' + u.i + '/squad')).catch(
      () => null,
    ),
  );
  const known = {};
  for (const sq of squads) {
    for (const p of (sq && sq.it) || []) known[String(p.pi)] = { name: String(p.pn || '').trim(), pos: num(p.pos), teamId: str(p.tid) };
  }

  const me = (await kb.session(false)).uid;
  const players = {};
  const managers = users.map((u) => {
    const lineup = (u.lp || []).map((x) => (x == null || x === '' ? null : String(x)));
    for (const id of lineup) if (id) players[id] = known[id] || { name: '', pos: null, teamId: null };
    return {
      id: String(u.i),
      name: String(u.n || u.unm || '').trim(),
      image: img(u.uim),
      you: String(u.i) === me,
      lineup,
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
  const league = await getLeague(kb, env);
  const day = parseDay(url.searchParams.get('day')) || num((await matchdays(kb, league)).day);
  return { day, players: await livePlayers(kb, env, ids, day), updatedAt: new Date().toISOString() };
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

function standings(ov, live) {
  const tm = teamIndex(ov.matches);
  const current = ov.day === ov.currentDay;
  const rows = ov.managers.map((m) => {
    let points = 0;
    let played = 0;
    let size = 0;
    let missing = 0;
    const players = [];
    m.lineup.forEach((id, slot) => {
      if (!id) return;
      size++;
      const meta = ov.players[id] || {};
      const lv = live[id] && !live[id].error ? live[id] : null;
      const teamId = (lv && lv.teamId) || meta.teamId || null;
      const match = teamId ? tm[teamId] : null;
      const state = later(lv && lv.state, match && match.state) || 'upcoming';
      if (state !== 'upcoming') {
        played++;
        if (!lv) missing++;
      }
      const pts = lv ? lv.points : 0;
      points += pts;
      players.push({
        id,
        slot,
        name: (lv && lv.name) || meta.name || '',
        pos: POS[meta.pos] || null,
        team: match ? (match.home.id === teamId ? match.home.sym : match.away.sym) : null,
        points: pts,
        state,
        minute: state === 'live' ? (lv && lv.minute) || (match && match.minute) || '' : '',
        role: lv ? lv.role : null,
        keys: lv ? lv.keys : [],
        events: lv ? lv.events : [],
      });
    });
    players.sort((a, b) => (POS_RANK[a.pos] || 5) - (POS_RANK[b.pos] || 5) || a.slot - b.slot);
    const o = m.official;
    const season = o.season == null ? null : current ? o.season - (o.day || 0) + points : o.season;
    return { id: m.id, name: m.name, you: m.you, points, officialPoints: o.day, seasonPoints: season, played, lineupSize: size, missing, players };
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
          headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'x-access-key' },
        });
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') return json({ error: 'Nur GET.' }, 405);
      if (path === '/favicon.ico') return new Response(null, { status: 204 });
      if (path === '/robots.txt') return new Response('User-agent: *\nDisallow: /\n', { headers: { 'content-type': 'text/plain' } });

      if (!authorized(url, request, env)) {
        return path.startsWith('/api/') ? json({ error: 'Zugriffsschlüssel fehlt oder ist falsch (?key=...).' }, 401) : html(LOCKED, 401);
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
      return json({ error: (e && e.message) || String(e) }, status);
    }
  },
};

// ---------------------------------------------------------------- Seiten

const LOCKED =
  '<!doctype html><html lang="de"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
  '<meta name="robots" content="noindex"><title>Bousching Live</title>' +
  '<body style="font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 16px;background:#0f241b;color:#e9efe6">' +
  '<h1 style="font-size:1.3rem">Zugriffsschlüssel fehlt</h1>' +
  '<p>Öffne die Seite mit deinem Schlüssel, also <b>/?key=…</b> am Ende der Adresse. ' +
  'Den Schlüssel legst du in den Worker-Einstellungen als <b>ACCESS_KEY</b> fest.</p></body></html>';

// Hinweis: Im Seiten-Code keine Backticks und kein Dollar-Klammer-Muster verwenden (Template-String).
const PAGE = String.raw`<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex">
<meta name="theme-color" content="#0f241b">
<title>Bousching Live</title>
<link rel="icon" href="data:,">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,400..800&family=Doto:wght@900&display=swap">
<style>
:root{
  --bg:#eef3ee;--surface:#ffffff;--ink:#10241b;--muted:#5b6f63;--line:#d6e1d8;--chip:#e1eae2;
  --board:#0f241b;--board-ink:#ffc53d;--live:#9a6400;--minus:#c0392b;--plus:#1d6b45;--focus:#1f6feb;
  color-scheme:light;
}
@media (prefers-color-scheme: dark){
  :root:not([data-theme="light"]){
    --bg:#0f241b;--surface:#163126;--ink:#e9efe6;--muted:#93a99b;--line:#24443a;--chip:#1b392e;
    --board:#08170f;--board-ink:#ffc53d;--live:#ffc53d;--minus:#ff7a6b;--plus:#7fd3a0;--focus:#ffc53d;
    color-scheme:dark;
  }
}
:root[data-theme="dark"]{
  --bg:#0f241b;--surface:#163126;--ink:#e9efe6;--muted:#93a99b;--line:#24443a;--chip:#1b392e;
  --board:#08170f;--board-ink:#ffc53d;--live:#ffc53d;--minus:#ff7a6b;--plus:#7fd3a0;--focus:#ffc53d;
  color-scheme:dark;
}
*{box-sizing:border-box}
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
.is-live .status .dot{background:var(--board-ink);animation:pulse 2s infinite}
.busy .status .dot{opacity:.45}
.status.bad{color:var(--minus)}
.status.bad .dot{background:var(--minus);animation:none}
@keyframes pulse{0%{box-shadow:0 0 0 0 rgba(255,197,61,.65)}70%{box-shadow:0 0 0 9px rgba(255,197,61,0)}100%{box-shadow:0 0 0 0 rgba(255,197,61,0)}}

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
.board{font-family:"Doto","Archivo",monospace;font-weight:900;font-size:30px;line-height:1;color:var(--board-ink);background:var(--board);padding:8px 10px 6px;border-radius:8px;min-width:4.2ch;text-align:right;text-shadow:0 0 8px rgba(255,197,61,.35)}
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
    if (DEMO) return Promise.resolve(Demo.api(path, params || {}));
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
        ov.managers.forEach(function (m) { if (m.you) S.openM[m.id] = true; });
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
    var rows = ov.managers.map(function (m) {
      var points = 0, played = 0, size = 0, missing = 0, players = [];
      m.lineup.forEach(function (id, slot) {
        if (!id) return;
        size++;
        var meta = ov.players[id] || {};
        var lv = S.live[id] && !S.live[id].error ? S.live[id] : null;
        var teamId = (lv && lv.teamId) || meta.teamId || null;
        var match = teamId ? tm[teamId] : null;
        var state = later(lv && lv.state, match && match.state) || 'upcoming';
        if (state !== 'upcoming') { played++; if (!lv) missing++; }
        var p = lv ? lv.points : 0;
        points += p;
        players.push({
          id: id, slot: slot, name: (lv && lv.name) || meta.name || ('Spieler ' + id),
          pos: POS[meta.pos] || '', team: sym(match, teamId), points: p, state: state,
          minute: (lv && lv.minute) || (match && match.minute) || '',
          kickoff: (match && match.kickoff) || (lv && lv.kickoff) || null,
          role: lv ? lv.role : null, keys: lv ? lv.keys : [], events: lv ? lv.events : [], loaded: !!lv
        });
      });
      players.sort(function (a, b) { return ((POS_RANK[a.pos] || 5) - (POS_RANK[b.pos] || 5)) || (a.slot - b.slot); });
      var o = m.official || {};
      var season = o.season == null ? null : current ? o.season - (o.day || 0) + points : o.season;
      return { id: m.id, name: m.name, you: m.you, points: points, season: season, officialRank: o.seasonRank,
        played: played, size: size, missing: missing, players: players };
    });
    rows.sort(function (a, b) { return (b.points - a.points) || ((b.season || 0) - (a.season || 0)); });
    rows.forEach(function (r, i) { r.rank = i > 0 && rows[i - 1].points === r.points ? rows[i - 1].rank : i + 1; });
    rows.slice().sort(function (a, b) {
      return (b.season == null ? -1e12 : b.season) - (a.season == null ? -1e12 : a.season);
    }).forEach(function (r, i) { r.seasonRank = i + 1; });
    return rows;
  }

  // ---------------------------------------------------------- Anzeigen

  function render(final) {
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
          (r.missing ? '<span>' + r.missing + ' laden noch</span>' : '')
        : '<span>Aufstellung nicht sichtbar</span>';
      var head = '<button type="button" class="mrow" data-m="' + esc(r.id) + '" aria-expanded="' + open + '">' +
        '<span class="rank">' + r.rank + '</span>' +
        '<span class="who"><span class="name">' + esc(r.name) + (r.you ? ' <span class="tag">Du</span>' : '') +
        '</span><span class="meta">' + meta + '</span></span>' +
        '<span class="board' + (r.points < 0 ? ' neg' : '') + (flash ? ' flash' : '') + '">' + pts(r.points) + '</span></button>';
      var body = '';
      if (open) {
        var empty = r.size && r.size < 11 ? 11 - r.size : 0;
        body = '<ul class="players">' + r.players.map(renderPlayer).join('') +
          (empty ? '<li class="slot">' + empty + (empty === 1 ? ' Platz' : ' Plätze') + ' in der Elf leer</li>' : '') +
          (!r.size ? '<li class="slot">Keine Aufstellung sichtbar.</li>' : '') + '</ul>';
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

  document.addEventListener('click', function (e) {
    var el = e.target.closest('button');
    if (!el) return;
    if (el.dataset.m) { S.openM[el.dataset.m] = !S.openM[el.dataset.m]; render(false); return; }
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
      var doneDay = lineup.reduce(function (s, id) { return s + (id && live[id].state === 'done' ? live[id].points : 0); }, 0);
      return { id: 'u' + mi, name: name, image: null, you: mi === 4, lineup: lineup,
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
