// Bousching Live ohne Cloudflare: `node server.mjs` (Node 18+), z. B. auf blitz.cloud, dem Raspberry Pi oder per Docker.
// Einstellungen kommen aus Umgebungsvariablen, genau wie beim Worker (KICKBASE_EMAIL, KICKBASE_PASSWORD, ...).
// Korrekturen der Kontostände landen in DATA_DIR (Standard /app/data) – den Ordner dauerhaft speichern.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import worker from './worker.js';

const dataDir = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const STORE = {
  async get(key) {
    try {
      return JSON.parse(await fs.readFile(path.join(dataDir, key + '.json'), 'utf8'));
    } catch {
      return null;
    }
  },
  async put(key, value) {
    await fs.mkdir(dataDir, { recursive: true });
    const file = path.join(dataDir, key + '.json');
    await fs.writeFile(file + '.tmp', JSON.stringify(value, null, 2));
    await fs.rename(file + '.tmp', file);
  },
};

// Ohne Cloudflare gibt es kein 50-Aufrufe-Limit pro Request.
const env = { SUBREQUEST_LIMIT: '10000', PLAYER_BATCH: '60', ...process.env, STORE };
const port = Number(process.env.PORT) || 8787;

http
  .createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
      let body;
      if (req.method === 'POST') {
        const chunks = [];
        let size = 0;
        for await (const c of req) {
          size += c.length;
          if (size > 64 * 1024) throw new Error('Anfrage zu groß');
          chunks.push(c);
        }
        body = Buffer.concat(chunks);
      }
      const response = await worker.fetch(new Request(url, { method: req.method, headers, body }), env, { waitUntil() {} });
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(req.method === 'HEAD' ? undefined : Buffer.from(await response.arrayBuffer()));
    } catch (e) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Fehler: ' + (e && e.message ? e.message : e));
    }
  })
  .listen(port, () => console.log('Bousching Live läuft auf http://localhost:' + port + ' (Daten: ' + dataDir + ')'));
