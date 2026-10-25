// Servidor local mínimo (sem dependências): ficheiros estáticos + 3 endpoints JSON.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ds from './src/dataSource.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
// Carrega .env (opcional, não versionado), sem dependências.
try {
  for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m && !line.trim().startsWith('#') && m[2] && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
} catch { /* sem .env: modo demonstração */ }

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };

async function handleApi(url, res) {
  const q = url.searchParams;
  const demo = q.get('source') === 'demo';
  if (url.pathname === '/api/status') {
    return json(res, 200, { apiConfigured: ds.apiConfigured(), demo: await ds.demoInfo() });
  }
  if (url.pathname === '/api/devices') {
    return json(res, 200, { source: demo ? 'demo' : 'api', devices: demo ? await ds.demoDevices() : await ds.apiDevices() });
  }
  if (url.pathname === '/api/readings') {
    const [id, from, to] = [q.get('deviceId'), q.get('from'), q.get('to')];
    if (!id) throw new ds.SourceError('BAD_REQUEST', 'Falta deviceId.', 400);
    ds.validateWindow(from, to);
    const observations = demo ? await ds.demoReadings(id, from, to) : await ds.apiReadings(id, from, to);
    return json(res, 200, { source: demo ? 'demo' : 'api', deviceId: id, from, to, fetchedAt: new Date().toISOString(), observations });
  }
  json(res, 404, { error: 'NOT_FOUND', message: 'Endpoint desconhecido.' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(url, res);
    let file = url.pathname === '/' ? '/index.html' : url.pathname;
    if (file === '/analysis.js') file = '/../src/analysis.js'; // módulo partilhado com os testes
    const full = path.normalize(path.join(ROOT, 'public', file));
    if (!full.startsWith(path.join(ROOT, 'public')) && !full.endsWith(path.join('src', 'analysis.js'))) { res.writeHead(403); return res.end(); }
    const data = fs.readFileSync(full);
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(full)] || 'application/octet-stream' });
    res.end(data);
  } catch (e) {
    if (e instanceof ds.SourceError) return json(res, e.status, { error: e.code, message: e.message });
    if (e.code === 'ENOENT') { res.writeHead(404); return res.end('Não encontrado'); }
    console.error(e);
    json(res, 500, { error: 'INTERNAL', message: 'Erro interno.' });
  }
});
const PORT = Number(process.env.PORT) || 3000;
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  server.listen(PORT, '127.0.0.1', () => console.log(`http://localhost:${PORT}  (${ds.apiConfigured() ? 'API configurada' : 'sem credenciais: modo demonstração'})`));
}
export { server };
