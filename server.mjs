// Bousching Live ohne Cloudflare: `node server.mjs` (Node 18+), z. B. auf dem Raspberry Pi oder per Docker.
// Einstellungen kommen aus Umgebungsvariablen, genau wie beim Worker (KICKBASE_EMAIL, KICKBASE_PASSWORD, ...).
import http from 'node:http';
import worker from './worker.js';

// Ohne Cloudflare gibt es kein 50-Aufrufe-Limit pro Request.
const env = { SUBREQUEST_LIMIT: '10000', PLAYER_BATCH: '60', ...process.env };
const port = Number(process.env.PORT) || 8787;

http
  .createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
      const response = await worker.fetch(new Request(url, { method: req.method, headers }), env, { waitUntil() {} });
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(req.method === 'HEAD' ? undefined : Buffer.from(await response.arrayBuffer()));
    } catch (e) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Fehler: ' + (e && e.message ? e.message : e));
    }
  })
  .listen(port, () => console.log('Bousching Live läuft auf http://localhost:' + port));
