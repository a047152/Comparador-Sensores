// Três cenários de validação (README: tabela de testes). Cenários 1 e 2 usam o ficheiro histórico real;
// o cenário 3 usa dados SIMULADOS (identificados como tal) e uma falha de API simulada.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanReadings, analyzeMetric, compare, overall, validateRange } from '../src/analysis.js';
import * as ds from '../src/dataSource.js';

const PERIOD = { from: '2026-10-20T14:40:00Z', to: '2026-10-21T14:40:00Z' };
async function run(id, key, range, period = PERIOD) {
  const raw = await ds.demoReadings(id, period.from, period.to);
  const c = cleanReadings(raw, period.from, period.to);
  return { ...c, an: analyzeMetric(c.readings, key, range, period) };
}

test('C1 normal: HE-02 vs HE-03, temperatura 22–26 °C → nenhum sai do intervalo', async () => {
  const a = await run('HE-02', 'temp', { min: 22, max: 26 });
  const b = await run('HE-03', 'temp', { min: 22, max: 26 });
  assert.equal(a.stats.duplicatesRemoved, 2);      // timestamps repetidos tratados
  assert.equal(a.readings.length, 286);
  assert.equal(a.an.gaps.length, 2);               // lacunas detetadas, não contadas como "dentro"
  assert.equal(a.an.outMin, 0);
  assert.equal(b.an.outMin, 0);
  assert.equal(compare(a.an, b.an, 'HE-02', 'HE-03').kind, 'none');
});

test('C2 ativa a funcionalidade: HE-01 vs HE-04, temperatura 20–25 °C', async () => {
  const a = await run('HE-01', 'temp', { min: 20, max: 25 });
  const b = await run('HE-04', 'temp', { min: 20, max: 25 });
  assert.equal(a.an.outMin, 565);
  assert.equal(b.an.outMin, 1430);
  assert.ok(Math.abs(a.an.pctOut - 39.51) < 0.01);
  assert.equal(b.an.pctOut, 100);
  const c = compare(a.an, b.an, 'HE-01', 'HE-04');
  assert.equal(c.kind, 'worse');
  assert.equal(c.worse, 'HE-04');
});

test('C2b parâmetro interativo: alargar o intervalo reduz o tempo fora; trocar de métrica muda o resultado', async () => {
  const narrow = await run('HE-04', 'temp', { min: 20, max: 25 });
  const wide = await run('HE-04', 'temp', { min: 17, max: 25 });
  assert.ok(wide.an.pctOut < narrow.an.pctOut);
  const hum = await run('HE-02', 'hum', { min: 40, max: 60 });
  assert.equal(hum.an.outMin, 1190);
  assert.ok(Math.abs(hum.an.pctOut - 84.1) < 0.05);
});

test('C3 dados em falta (SIMULADO): resposta vazia, nulos e uma só leitura não viram zero nem "normal"', () => {
  const p = { from: '2026-10-21T10:00:00Z', to: '2026-10-21T11:00:00Z' };
  const range = { min: 20, max: 25 };
  const empty = analyzeMetric(cleanReadings([], p.from, p.to).readings, 'temp', range, p);
  assert.equal(empty.status, 'empty');
  const nulls = [0, 5, 10].map((m) => ({ measuredAt: `2026-10-21T10:${String(m).padStart(2, '0')}:00Z`, receivedAt: null, temp: null, hum: null }));
  const allNull = analyzeMetric(cleanReadings(nulls, p.from, p.to).readings, 'temp', range, p);
  assert.equal(allNull.status, 'empty');
  assert.equal(allNull.pctOut, undefined);
  const one = analyzeMetric(cleanReadings([{ measuredAt: '2026-10-21T10:00:00Z', temp: 30, hum: null }], p.from, p.to).readings, 'temp', range, p);
  assert.equal(one.status, 'insufficient');
  const cmp = compare(empty, one, 'X', 'Y');
  assert.equal(cmp.kind, 'unavailable');
  assert.match(cmp.text, /não significa/);
});

test('C3b lacuna simulada: o tempo sem dados não conta como dentro nem fora', () => {
  const p = { from: '2026-10-21T10:00:00Z', to: '2026-10-21T11:00:00Z' };
  const mk = (m, temp) => ({ measuredAt: `2026-10-21T10:${String(m).padStart(2, '0')}:00Z`, receivedAt: null, temp, hum: 50 });
  const r = cleanReadings([mk(0, 30), mk(5, 30), mk(10, 22), mk(40, 22), mk(45, 22)], p.from, p.to);
  const an = analyzeMetric(r.readings, 'temp', { min: 20, max: 25 }, p);
  assert.equal(an.gaps.length, 1);
  assert.equal(an.gaps[0].minutes, 30);
  assert.equal(an.observedMin, 15);      // 5+5 antes da lacuna, 5 depois
  assert.equal(an.outMin, 10);
  assert.ok(an.coverage < 30);
});

test('C3c erros: intervalo inválido, janela >24 h, API indisponível, sem credenciais', async () => {
  assert.ok(validateRange(26, 20));
  assert.ok(validateRange(NaN, 20));
  assert.throws(() => ds.validateWindow('2026-10-20T00:00:00Z', '2026-10-22T00:00:00Z'), { code: 'BAD_REQUEST' });
  assert.throws(() => ds.validateWindow('2026-10-20 00:00', '2026-10-20T01:00:00Z'), { code: 'BAD_REQUEST' });
  delete process.env.HE_EMAIL; delete process.env.HE_PASSWORD;
  await assert.rejects(ds.apiDevices(), { code: 'NOT_CONFIGURED' });
  process.env.HE_EMAIL = 'x@example.com'; process.env.HE_PASSWORD = 'x';
  process.env.HE_API_BASE = 'http://127.0.0.1:1'; // SIMULA API em baixo
  await assert.rejects(ds.apiDevices(), { code: 'API_DOWN' });
});

test('C4 duas métricas ao mesmo tempo: HE-01 vs HE-02 (temp 20–25 °C, hum 40–60 %) + sentido dos episódios', async () => {
  const cmps = [];
  for (const [key, label, range] of [['temp', 'Temperatura', { min: 20, max: 25 }], ['hum', 'Humidade', { min: 40, max: 60 }]]) {
    const a = await run('HE-01', key, range);
    const b = await run('HE-02', key, range);
    cmps.push({ label, cmp: compare(a.an, b.an, 'HE-01', 'HE-02'), a: a.an, b: b.an });
  }
  assert.equal(cmps[0].cmp.worse, 'HE-01');           // temp.: 565 min vs 0
  assert.equal(cmps[0].a.outMin, 565);
  assert.equal(cmps[1].cmp.worse, 'HE-02');           // hum.: 0 vs 1190 min (84,1 %)
  assert.equal(cmps[1].b.outMin, 1190);
  assert.equal(overall(cmps, 'HE-01', 'HE-02'), 'Empate: cada dispositivo está pior em 1 métrica(s).');
  assert.ok(cmps[0].a.episodes.every((e) => e.direction === 'abaixo'));   // HE-01 ficou abaixo de 20 °C
  assert.ok(cmps[1].b.episodes.every((e) => ['abaixo', 'acima', 'abaixo e acima'].includes(e.direction)));
});
