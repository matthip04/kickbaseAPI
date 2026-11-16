# Bousching Live

Live-Punkte deiner Kickbase-Liga: alle aufgestellten Spieler aller Manager mit Live-Punkten und den Ereignissen dazu (Tore, Vorlagen, Karten, Wechsel und jede einzelne Punkte-Aktion). Als Handy-Seite und als JSON-API.

## In 5 Minuten online (Cloudflare, kostenlos, ohne Kommandozeile)

1. Auf <https://dash.cloudflare.com> ein kostenloses Konto anlegen.
2. **Workers & Pages → Create → Worker**, Vorlage „Hello World“, Name `bousching-live`, **Deploy**.
3. **Edit code** → alles löschen → kompletten Inhalt von `worker.js` einfügen → **Deploy**.
4. Im Worker unter **Settings → Variables and Secrets** anlegen:

   | Name | Typ | Wert |
   |---|---|---|
   | `KICKBASE_EMAIL` | Secret | deine Kickbase-Mail |
   | `KICKBASE_PASSWORD` | Secret | dein Kickbase-Passwort |
   | `ACCESS_KEY` | Secret | langes Zufallswort (nur für interne Endpunkte) |
   | `LEAGUE_NAME` | Text | `BOUSCHING` |

5. Aufrufen: `https://bousching-live.<dein-name>.workers.dev/` und am Handy „Zum Home-Bildschirm“ hinzufügen.

Die Seite ist öffentlich, den Link kannst du direkt an die Liga schicken. Deine Zugangsdaten sieht niemand; die internen Endpunkte `/api/leagues` und `/api/raw` gehen nur mit `?key=<ACCESS_KEY>`.

**Erst testen ohne Kickbase:** `/?demo=1` zeigt die Seite mit erfundenen Daten.

## Alternativ per Kommandozeile

```bash
npx wrangler login
npx wrangler secret put KICKBASE_EMAIL
npx wrangler secret put KICKBASE_PASSWORD
npx wrangler secret put ACCESS_KEY
npx wrangler deploy
```

`LEAGUE_NAME` steht schon in `wrangler.toml`.

## Endpunkte

| Pfad | Liefert |
|---|---|
| `/` | Live-Seite: Tabelle nach Live-Punkten, aufklappbare Elf, Punkte-Ereignisse pro Spieler, Ticker |
| `/api/live` | alles als ein JSON: Manager sortiert nach Live-Punkten, je Spieler Punkte, Status, Minute, Key-Events und Einzel-Ereignisse |
| `/api/overview` | Liga, Spieltag, Spiele, Manager + Aufstellungen (ohne Punkte) |
| `/api/players?ids=7226,8329` | Live-Daten einzelner Spieler (max. 30 pro Aufruf) |
| `/api/leagues` | deine Ligen mit ID |
| `/api/raw?path=/v4/leagues/{league}/ranking&debug=…` | Kickbase-Rohdaten, nur mit `DEBUG_KEY` |

`/`, `/api/live`, `/api/overview` und `/api/players` sind öffentlich (nur Spieler, die in der Liga aufgestellt sind). `/api/leagues` und `/api/raw` brauchen `key=<ACCESS_KEY>`. Optional `day=N` für einen anderen Spieltag.

## Gut zu wissen

- **Inoffizielle API.** Kickbase hat keine offizielle Schnittstelle; das hier nutzt die v4-API, die auch die App verwendet (Stand der Community-Doku: März 2026). Ändert Kickbase etwas, bleiben einzelne Felder leer. Dann zeigt `/api/raw` die Rohdaten, und die Stelle in `worker.js` ist schnell angepasst.
- **Woher die Live-Punkte kommen.** Pro Spieler aus dem Kickbase-„Playercenter“, das während des Spiels live zählt. Tabelle und Ranking aktualisiert Kickbase erst nach Abpfiff. Deshalb rechnet der Dienst Gesamtpunkte und Platz live hoch (offizielle Saisonpunkte − offizielle Spieltagspunkte + Live-Summe).
- **Cloudflare-Limit.** Der Gratis-Plan erlaubt 50 Kickbase-Abrufe pro Anfrage, bei 10 Managern sind es aber rund 110 Spieler. Die Seite lädt deshalb in Paketen. `/api/live` kann bei vielen laufenden Spielen `"complete": false` liefern; dann einfach nochmal aufrufen, der Rest kommt aus dem Cache. Mit Workers Paid oder Node gibt es das Limit nicht (`SUBREQUEST_LIMIT=10000`).
- **Ereignis-Symbole.** Tor, Vorlage, Gelb und Wechsel erkennt der Dienst an Kickbase-Codes; Rot, Gelb-Rot und Eigentor am Ereignisnamen.
- **Aufstellungen der anderen** zeigt der Dienst nur, wenn Kickbase sie deinem Account liefert.
- **Zugangsdaten** liegen nur als Secret im Worker, nicht im Code und nicht auf der Seite.

## Einstellungen

| Variable | Pflicht | Bedeutung |
|---|---|---|
| `KICKBASE_EMAIL`, `KICKBASE_PASSWORD` | ja | Kickbase-Login |
| `LEAGUE_NAME` oder `LEAGUE_ID` | nein | welche Liga (sonst die erste) |
| `ACCESS_KEY` | empfohlen | Schlüssel für die internen Endpunkte (ohne: gesperrt) |
| `DEBUG_KEY` | nein | schaltet `/api/raw` frei |
| `PLAYER_BATCH` | nein | Spieler pro `/api/players` (Standard 30) |
| `SUBREQUEST_LIMIT` | nein | Kickbase-Abrufe pro `/api/live` (Standard 40) |
| KV-Binding `KV` | nein | merkt sich das Kickbase-Token über Neustarts (weniger Logins) |

## Ohne Cloudflare (Raspberry Pi, Docker)

```bash
KICKBASE_EMAIL=… KICKBASE_PASSWORD=… ACCESS_KEY=… LEAGUE_NAME=BOUSCHING node server.mjs   # Node 18+, Port 8787

docker build -t bousching-live .
docker run -d -p 8787:8787 -e KICKBASE_EMAIL=… -e KICKBASE_PASSWORD=… -e ACCESS_KEY=… -e LEAGUE_NAME=BOUSCHING bousching-live
```

So läuft es nur im Heimnetz. Fürs Internet bräuchtest du zusätzlich z. B. einen Cloudflare Tunnel – der Worker ist dafür der einfachere Weg.
