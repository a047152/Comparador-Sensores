// Acesso aos dados: API Human Experience (só no servidor, credenciais em .env) ou ficheiro JSON de contingência.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEMO_FILE = path.join(ROOT, 'data', 'DADOS_CONTINGENCIA_20261021.json');
const ISO_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const MAX_WINDOW_MS = 24 * 3600 * 1000;

export class SourceError extends Error {
  constructor(code, message, status = 500) { super(message); this.code = code; this.status = status; }
}

export function validateWindow(from, to) {
  if (!ISO_Z.test(from || '') || !ISO_Z.test(to || '') || Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to)))
    throw new SourceError('BAD_REQUEST', 'Datas inválidas: use UTC ISO 8601 com Z (ex.: 2026-10-21T14:00:00Z).', 400);
  const span = Date.parse(to) - Date.parse(from);
  if (span <= 0) throw new SourceError('BAD_REQUEST', 'O fim do período tem de ser posterior ao início.', 400);
  if (span > MAX_WINDOW_MS) throw new SourceError('BAD_REQUEST', 'O período não pode exceder 24 horas.', 400);
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
export const normalize = (o) => ({
  measuredAt: o?.data?.createdAt ?? null, // instante da medição
  receivedAt: o?.createdAt ?? null,       // instante da classificação (usado só para desempatar duplicados)
  temp: num(o?.data?.si7021Temp),
  hum: num(o?.data?.si7021Humidity),
});

// ---------- modo demonstração (ficheiro) ----------
let demoCache = null;
async function demo() {
  if (!demoCache) demoCache = JSON.parse(await fs.readFile(DEMO_FILE, 'utf8'));
  return demoCache;
}
export async function demoInfo() {
  const d = await demo();
  return { from: d.metadata.requested_from_utc.replace('+00:00', 'Z').replace(/\.\d+/, ''), to: d.metadata.requested_to_utc.replace('+00:00', 'Z').replace(/\.\d+/, '') };
}
export async function demoDevices() {
  const d = await demo();
  return d.devices.data.map(({ id, name, latestReading }) => ({ id, name, latestReading }));
}
export async function demoReadings(deviceId, from, to) {
  const d = await demo();
  const entry = d.data_classifications[deviceId];
  if (!entry) throw new SourceError('NOT_FOUND', 'Dispositivo desconhecido no ficheiro de demonstração.', 404);
  const f = Date.parse(from), t = Date.parse(to);
  return entry.data.map(normalize).filter((r) => { const m = Date.parse(r.measuredAt); return m >= f && m <= t; });
}

// ---------- API real ----------
const base = () => process.env.HE_API_BASE || 'https://sensorblock.humanexperience.pt';
export const apiConfigured = () => Boolean(process.env.HE_EMAIL && process.env.HE_PASSWORD);
let token = null;

async function call(url, opts = {}) {
  try {
    return await fetch(url, { ...opts, signal: AbortSignal.timeout(10000) });
  } catch {
    throw new SourceError('API_DOWN', 'API indisponível (erro de rede ou tempo esgotado).', 503);
  }
}
async function login() {
  const res = await call(`${base()}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: process.env.HE_EMAIL, password: process.env.HE_PASSWORD, clientType: 'web' }),
  });
  if (res.status === 400 || res.status === 401) throw new SourceError('AUTH', 'Login recusado: confira HE_EMAIL e HE_PASSWORD no .env.', 502);
  if (!res.ok) throw new SourceError('API_DOWN', `API indisponível (HTTP ${res.status}).`, 503);
  token = (await res.json())?.data?.token;
  if (!token) throw new SourceError('API_DOWN', 'Resposta de login sem token.', 502);
}
async function apiGet(pathAndQuery, retry = true) {
  if (!apiConfigured()) throw new SourceError('NOT_CONFIGURED', 'Credenciais da API não configuradas (.env).', 503);
  if (!token) await login();
  const res = await call(`${base()}${pathAndQuery}`, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 401 && retry) { token = null; return apiGet(pathAndQuery, false); }
  if (!res.ok) throw new SourceError('API_DOWN', `API indisponível (HTTP ${res.status}).`, 503);
  return res.json();
}
export async function apiDevices() {
  const j = await apiGet('/api/devices');
  return (j.data || []).map(({ id, name, latestReading }) => ({ id, name: name ?? String(id), latestReading: latestReading ?? null }));
}
export async function apiReadings(deviceId, from, to) {
  const q = new URLSearchParams({ deviceId, includeData: 'true', dateFrom: from, dateTo: to });
  const j = await apiGet(`/api/data-classifications?${q}`);
  return (j.data || []).map(normalize);
}
