import { cleanReadings, analyzeMetric, compare, overall, validateRange, GAP_LIMIT_MIN } from '/analysis.js';

const $ = (id) => document.getElementById(id);
const METRICS = {
  temp: { label: 'Temperatura', unit: '°C', min: 20, max: 25, dec: 1 },
  hum: { label: 'Humidade relativa', unit: '%', min: 40, max: 60, dec: 1 },
};
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtT = (iso) => new Date(iso).toLocaleString('pt-PT', { timeZone: 'UTC', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) + ' UTC';
const fmtN = (x, d = 1) => x.toFixed(d).replace('.', ',');
const fmtMin = (m) => (m >= 60 ? `${Math.floor(m / 60)} h ${String(Math.round(m % 60)).padStart(2, '0')} min` : `${Math.round(m)} min`);
const fmtAge = (m) => (m >= 1440 ? `${Math.floor(m / 1440)} d ${Math.floor((m % 1440) / 60)} h` : fmtMin(m));
const toInput = (ms) => new Date(ms).toISOString().slice(0, 16);
const floor5 = (ms) => Math.floor(ms / 300000) * 300000;
const rows = () => [...document.querySelectorAll('.mrow')];

let state = null; // { source, period, A:{id,observations}, B:{...}, fetchedAt }
let statusInfo = null;

async function getJson(url) {
  let res;
  try { res = await fetch(url); } catch { throw { code: 'API_DOWN', message: 'Servidor local inacessível. Verifique se executou "npm start".' }; }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw { code: body.error || 'ERROR', message: body.message || `Erro HTTP ${res.status}` };
  return body;
}

function showError(err) {
  const box = $('error');
  const canDemo = ['API_DOWN', 'AUTH', 'NOT_CONFIGURED'].includes(err.code) && $('source').value === 'api';
  box.innerHTML = `${esc(err.message)}${canDemo ? ' <button type="button" id="useDemo" class="secondary">Usar dados históricos</button>' : ''}`;
  box.hidden = false;
  $('results').hidden = true;
  if (canDemo) $('useDemo').onclick = () => { $('source').value = 'demo'; onSourceChange().then(refresh); };
}

async function loadDevices() {
  try {
    const { devices } = await getJson(`/api/devices?source=${$('source').value}`);
    for (const id of ['devA', 'devB']) $(id).innerHTML = devices.map((d) => `<option value="${esc(d.id)}">${esc(d.name)}</option>`).join('');
    if (devices.length > 1) $('devB').selectedIndex = 1;
    $('error').hidden = true;
  } catch (e) { showError(e); }
}

function setDefaultPeriod() {
  if ($('source').value === 'demo') {
    $('from').value = toInput(floor5(Date.parse(statusInfo.demo.from)));
    $('to').value = toInput(floor5(Date.parse(statusInfo.demo.to)));
  } else {
    const end = floor5(Date.now());
    $('to').value = toInput(end);
    $('from').value = toInput(end - 6 * 3600000);
  }
}

async function onSourceChange() {
  $('modeBanner').hidden = $('source').value !== 'demo';
  $('modeBanner').textContent = 'Modo de demonstração — dados históricos de 21/10/2026. Não mostram o estado atual dos sensores.';
  setDefaultPeriod();
  $('results').hidden = true;
  state = null;
  await loadDevices();
}

async function refresh() {
  const [a, b] = [$('devA').value, $('devB').value];
  if (!a || !b) return showError({ message: 'Escolha dois dispositivos.' });
  if (a === b) return showError({ message: 'Escolha dois dispositivos diferentes.' });
  if (!$('from').value || !$('to').value) return showError({ message: 'Indique o início e o fim do período.' });
  const from = $('from').value + ':00Z', to = $('to').value + ':00Z';
  const span = Date.parse(to) - Date.parse(from);
  if (!(span > 0)) return showError({ message: 'O fim do período tem de ser posterior ao início.' });
  if (span > 24 * 3600000) return showError({ message: 'O período não pode exceder 24 horas.' });
  const source = $('source').value;
  $('refresh').disabled = true;
  try {
    const get = (id) => getJson(`/api/readings?source=${source}&deviceId=${encodeURIComponent(id)}&from=${from}&to=${to}`);
    const [ra, rb] = await Promise.all([get(a), get(b)]);
    state = { source, period: { from, to }, fetchedAt: ra.fetchedAt, A: { id: a, observations: ra.observations }, B: { id: b, observations: rb.observations } };
    $('error').hidden = true;
    render();
  } catch (e) { state = null; showError(e); }
  finally { $('refresh').disabled = false; }
}

function selectedMetrics() {
  return rows().filter((r) => r.querySelector('[type=checkbox]').checked).map((r) => ({
    key: r.dataset.key, ...METRICS[r.dataset.key],
    range: { min: parseFloat(r.querySelector('.min').value), max: parseFloat(r.querySelector('.max').value) },
  }));
}

function render() {
  if (!state) return;
  const metrics = selectedMetrics();
  if (!metrics.length) { $('error').textContent = 'Escolha pelo menos uma métrica.'; $('error').hidden = false; return; }
  for (const m of metrics) {
    const err = validateRange(m.range.min, m.range.max);
    if (err) { $('error').textContent = `${m.label}: ${err}`; $('error').hidden = false; return; }
  }
  $('error').hidden = true;

  const keys = metrics.map((m) => m.key);
  const dev = {};
  for (const k of ['A', 'B']) {
    const cleaned = cleanReadings(state[k].observations, state.period.from, state.period.to);
    const lastAt = lastValidAt(cleaned.readings, keys);
    dev[k] = { id: state[k].id, ...cleaned, lastAt,
      an: Object.fromEntries(metrics.map((m) => [m.key, analyzeMetric(cleaned.readings, m.key, m.range, state.period)])) };
  }
  const cmps = metrics.map((m) => ({ m, cmp: compare(dev.A.an[m.key], dev.B.an[m.key], dev.A.id, dev.B.id) }));

  $('results').hidden = false;
  $('verdict').className = `verdict ${cmps.every((c) => c.cmp.kind === 'unavailable') ? 'unavailable' : ''}`;
  $('verdict').innerHTML = `<p class="big">${esc(metrics.length > 1 ? overall(cmps, dev.A.id, dev.B.id) : cmps[0].cmp.text)}</p>`
    + (metrics.length > 1 ? `<ul>${cmps.map((c) => `<li><strong>${esc(c.m.label)}:</strong> ${esc(c.cmp.text)}</li>`).join('')}</ul>` : '')
    + cmps.flatMap((c) => c.cmp.notes.map((n) => `<p class="note">${esc(c.m.label)}: ${esc(n)}</p>`)).join('')
    ;
  $('periods').innerHTML = periods(dev, metrics);
  $('cards').innerHTML = ['A', 'B'].map((k) => card(dev[k], k === 'B', metrics)).join('');
  $('charts').innerHTML = metrics.map((m) => `<div class="chartwrap"><h3>${esc(m.label)} (${m.unit})</h3>${chart(dev, m)}<p class="legend">Traço grosso = fora de ${fmtN(m.range.min, m.dec)}–${fmtN(m.range.max, m.dec)} ${m.unit}. Cortes na linha = lacunas (sem dados), não valor zero.</p></div>`).join('');
  $('provenance').innerHTML = `<h2>Origem dos dados</h2>
    <p><strong>Origem:</strong> ${state.source === 'demo' ? 'ficheiro histórico de contingência (cópia de 21/10/2026, não é tempo real)' : 'API Human Experience, consulta manual'}</p>
    <p><strong>Período:</strong> ${fmtT(state.period.from)} → ${fmtT(state.period.to)} · consulta feita em ${fmtT(state.fetchedAt)}</p>
    ${['A', 'B'].map((k) => `<p><strong>${esc(dev[k].id)}:</strong> ${dev[k].lastAt ? `última observação válida ${fmtT(dev[k].lastAt)}${state.source === 'demo' ? ' — dados históricos, não o estado atual' : ''}` : 'sem observação válida neste período'}</p>`).join('')}
    <p class="hint">Os resultados descrevem o período consultado, não o estado atual do sensor.</p>`;
}

function lastValidAt(readings, keys) {
  let last = null;
  for (const r of readings) if (keys.some((k) => Number.isFinite(r[k]))) last = r.t;
  return last === null ? null : new Date(last).toISOString();
}

function periods(dev, metrics) {
  const dot = (k) => `<span class="dot" style="background:var(--${k === 'A' ? 'a' : 'b'})"></span>`;
  return `<h2>Períodos fora do intervalo</h2>` + metrics.map((m) => {
    const f = (v) => fmtN(v, m.dec);
    const head = `<h3>${esc(m.label)} · aceitável ${f(m.range.min)}–${f(m.range.max)} ${m.unit}</h3>`;
    const rows = ['A', 'B'].flatMap((k) => (dev[k].an[m.key].episodes || []).map((e) => ({ k, id: dev[k].id, ...e })))
      .sort((x, y) => Date.parse(x.start) - Date.parse(y.start));
    const lacking = ['A', 'B'].filter((k) => dev[k].an[m.key].status !== 'ok').map((k) => dev[k].id);
    const warn = lacking.length ? `<p class="hint">Sem dados suficientes de ${esc(lacking.join(' e '))}: isso não significa que esteve dentro do intervalo.</p>` : '';
    if (!rows.length) return `${head}<p class="sub">Nenhum período fora do intervalo nas leituras disponíveis.</p>${warn}`;
    const shown = rows.slice(0, 15);
    return `${head}<div class="tablewrap"><table><thead><tr><th>Dispositivo</th><th>Início</th><th>Fim</th><th class="num">Duração</th><th>Sentido</th><th class="num">Valor extremo</th></tr></thead><tbody>${shown.map((e) =>
      `<tr><td>${dot(e.k)}${esc(e.id)}</td><td>${fmtT(e.start)}</td><td>${fmtT(e.end)}</td><td class="num">${fmtMin(e.minutes)}</td><td>${e.direction} do intervalo</td><td class="num">${f(e.worstValue)} ${m.unit}</td></tr>`).join('')}</tbody></table></div>${rows.length > shown.length ? `<p class="hint">+ ${rows.length - shown.length} períodos mais curtos ou posteriores não listados.</p>` : ''}${warn}`;
  }).join('');
}

function metricBlock(d, m) {
  const an = d.an[m.key], f = (v) => fmtN(v, m.dec);
  const title = `<h4>${esc(m.label)}</h4>`;
  if (an.status === 'empty') return `<div class="mblock">${title}<p class="sub">Sem leituras válidas neste período (recebidas: ${d.stats.received}). Isto não significa que esteve dentro do intervalo.</p></div>`;
  const s = an.summary;
  const dl = `<dl><dt>Mín. / média / máx.</dt><dd>${f(s.min)} / ${f(s.mean)} / ${f(s.max)} ${m.unit}</dd><dt>Leituras válidas · valores em falta</dt><dd>${an.validCount} · ${an.missingValues}</dd>${an.status === 'ok' ? `<dt>Cobertura · lacunas</dt><dd>${fmtN(an.coverage, 0)} % · ${an.gaps.length}</dd>` : ''}</dl>`;
  if (an.status === 'insufficient') return `<div class="mblock">${title}<p class="sub">Só ${an.validCount} leitura válida: insuficiente para medir tempo fora do intervalo.</p>${dl}</div>`;
  return `<div class="mblock">${title}<p class="big">${fmtN(an.pctOut)} %</p><p class="sub">fora do intervalo (${fmtMin(an.outMin)} de ${fmtMin(an.observedMin)} observados)</p>${dl}</div>`;
}

function card(d, isB, metrics) {
  return `<article class="card ${isB ? 'b' : ''}"><h3>Dispositivo ${isB ? 'B' : 'A'} · ${esc(d.id)}</h3>
    <p class="sub">Duplicados removidos: ${d.stats.duplicatesRemoved}</p>${metrics.map((m) => metricBlock(d, m)).join('')}</article>`;
}

function chart(dev, m) {
  const key = m.key, range = m.range;
  const W = 800, H = 240, L = 48, R = 12, T = 12, B = 28;
  const t0 = Date.parse(state.period.from), t1 = Date.parse(state.period.to);
  const all = ['A', 'B'].flatMap((k) => dev[k].readings.map((r) => r[key]).filter(Number.isFinite));
  if (!all.length) return '<p class="hint">Sem dados para desenhar.</p>';
  let lo = Math.min(range.min, ...all), hi = Math.max(range.max, ...all);
  const pad = (hi - lo) * 0.08 || 1; lo -= pad; hi += pad;
  const x = (t) => L + ((t - t0) / (t1 - t0)) * (W - L - R);
  const y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  let out = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Série de ${esc(m.label.toLowerCase())} dos dois dispositivos com a faixa aceitável">`;
  out += `<rect x="${L}" y="${y(range.max)}" width="${W - L - R}" height="${y(range.min) - y(range.max)}" fill="var(--band)"/>`;
  for (let i = 0; i <= 4; i++) { const v = lo + ((hi - lo) * i) / 4; out += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="#e7dfce"/><text x="${L - 6}" y="${y(v) + 4}" font-size="11" text-anchor="end" fill="#5d666b">${fmtN(v, 0)}</text>`; }
  const step = (t1 - t0) > 12 * 3600000 ? 4 * 3600000 : (t1 - t0) > 3 * 3600000 ? 3600000 : 900000;
  for (let t = Math.ceil(t0 / step) * step; t <= t1; t += step) out += `<text x="${x(t)}" y="${H - 8}" font-size="11" text-anchor="middle" fill="#5d666b">${new Date(t).toISOString().slice(11, 16)}</text>`;
  const gapMs = GAP_LIMIT_MIN * 60000;
  ['A', 'B'].forEach((k) => {
    const color = k === 'A' ? 'var(--a)' : 'var(--b)';
    const v = dev[k].readings.filter((r) => Number.isFinite(r[key]));
    for (let i = 0; i < v.length - 1; i++) {
      if (v[i + 1].t - v[i].t > gapMs) continue;
      const bad = v[i][key] < range.min || v[i][key] > range.max;
      out += `<line x1="${x(v[i].t)}" y1="${y(v[i][key])}" x2="${x(v[i + 1].t)}" y2="${y(v[i + 1][key])}" stroke="${color}" stroke-width="${bad ? 3.6 : 1.6}" stroke-linecap="round"/>`;
    }
  });
  out += `<text x="${L + 6}" y="${T + 12}" font-size="12" fill="var(--a)">● ${esc(dev.A.id)}</text><text x="${L + 90}" y="${T + 12}" font-size="12" fill="var(--b)">● ${esc(dev.B.id)}</text></svg>`;
  return out;
}

async function init() {
  rows().forEach((r) => { const M = METRICS[r.dataset.key]; r.querySelector('.min').value = M.min; r.querySelector('.max').value = M.max; });
  try { statusInfo = await getJson('/api/status'); } catch (e) { return showError(e); }
  $('source').value = statusInfo.apiConfigured ? 'api' : 'demo';
  if (!statusInfo.apiConfigured) $('source').querySelector('[value=api]').textContent = 'API Human Experience (sem credenciais)';
  await onSourceChange();
  $('refresh').onclick = refresh;
  $('source').onchange = onSourceChange;
  document.querySelectorAll('.mrow input').forEach((i) => { i.oninput = render; i.onchange = render; });
  refresh();
}
init();
