// Lógica pura (sem rede, sem DOM): usada pelo browser e pelos testes.
// Regras principais:
//  - cada leitura vale até à leitura seguinte; se o intervalo > GAP_LIMIT_MIN é uma LACUNA
//    e esse tempo não conta nem como "dentro" nem como "fora" (ausência ≠ normalidade);
//  - valores nulos não são convertidos em 0 e são excluídos;
//  - timestamps de medição repetidos: fica a linha recebida mais tarde (createdAt exterior).

export const NOMINAL_MIN = 5;
export const GAP_LIMIT_MIN = 7.5;
export const SIMILAR_PP = 5; // diferença (pontos percentuais) abaixo da qual dizemos "semelhante"
const MIN = 60000;
const p1 = (x) => x.toFixed(1).replace('.', ',');
const iso = (t) => new Date(t).toISOString();
const tsOr = (v) => { const t = Date.parse(v); return Number.isFinite(t) ? t : -Infinity; };

export function cleanReadings(raw, fromISO, toISO) {
  const from = Date.parse(fromISO), to = Date.parse(toISO);
  const stats = { received: raw.length, badTimestamp: 0, outsidePeriod: 0, duplicatesRemoved: 0 };
  const byTime = new Map();
  for (const r of raw) {
    const t = Date.parse(r.measuredAt);
    if (!Number.isFinite(t)) { stats.badTimestamp++; continue; }
    if (t < from || t > to) { stats.outsidePeriod++; continue; }
    const prev = byTime.get(t);
    if (prev) {
      stats.duplicatesRemoved++;
      if (tsOr(r.receivedAt) < tsOr(prev.receivedAt)) continue;
    }
    byTime.set(t, { t, receivedAt: r.receivedAt, temp: r.temp ?? null, hum: r.hum ?? null });
  }
  const readings = [...byTime.values()].sort((a, b) => a.t - b.t);
  return { readings, stats };
}

export function validateRange(min, max) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return 'Indique o mínimo e o máximo do intervalo.';
  if (min > max) return 'O mínimo não pode ser maior que o máximo.';
  return null;
}

export function analyzeMetric(readings, key, range, period, gapLimit = GAP_LIMIT_MIN) {
  const valid = readings.filter((r) => Number.isFinite(r[key]));
  const periodMin = (Date.parse(period.to) - Date.parse(period.from)) / MIN;
  const base = { key, range, validCount: valid.length, missingValues: readings.length - valid.length, periodMin };
  if (valid.length === 0) return { ...base, status: 'empty' };

  const values = valid.map((r) => r[key]);
  const summary = {
    min: Math.min(...values), max: Math.max(...values),
    mean: values.reduce((s, v) => s + v, 0) / values.length,
  };
  summary.amplitude = summary.max - summary.min;
  const lastValidAt = iso(valid[valid.length - 1].t);
  if (valid.length < 2) return { ...base, status: 'insufficient', summary, lastValidAt };

  let observedMin = 0, outMin = 0, cur = null;
  const gaps = [], episodes = [];
  const close = () => { if (cur) { episodes.push({ start: iso(cur.start), end: iso(cur.end), minutes: cur.minutes, worstValue: cur.worst, direction: cur.dirs.size > 1 ? 'abaixo e acima' : [...cur.dirs][0] }); cur = null; } };
  for (let i = 0; i < valid.length - 1; i++) {
    const a = valid[i], b = valid[i + 1], dt = (b.t - a.t) / MIN, v = a[key];
    if (dt > gapLimit) { gaps.push({ from: iso(a.t), to: iso(b.t), minutes: dt }); close(); continue; }
    observedMin += dt;
    const dev = v < range.min ? range.min - v : v > range.max ? v - range.max : 0;
    if (dev > 0) {
      outMin += dt;
      if (!cur) cur = { start: a.t, end: b.t, minutes: dt, worst: v, worstDev: dev, dirs: new Set() };
      else { cur.end = b.t; cur.minutes += dt; if (dev > cur.worstDev) { cur.worst = v; cur.worstDev = dev; } }
      cur.dirs.add(v < range.min ? 'abaixo' : 'acima');
    } else close();
  }
  close();
  const longest = episodes.reduce((m, e) => (!m || e.minutes > m.minutes ? e : m), null);
  return {
    ...base, status: 'ok', summary, lastValidAt, observedMin, outMin,
    pctOut: observedMin > 0 ? (outMin / observedMin) * 100 : 0,
    coverage: Math.min(100, (observedMin / periodMin) * 100),
    gaps, episodes, longest,
  };
}

export function compare(a, b, labelA, labelB) {
  const notes = [];
  const bad = [[a, labelA], [b, labelB]].filter(([x]) => x.status !== 'ok');
  if (bad.length) {
    const names = bad.map(([, l]) => l).join(' e ');
    return { kind: 'unavailable', notes,
      text: `Não é possível comparar: sem leituras válidas suficientes de ${names} neste período. Ausência de dados não significa que esteve dentro do intervalo.` };
  }
  const f = (x) => x.toFixed(0);
  if (Math.abs(a.coverage - b.coverage) > 10 || Math.min(a.coverage, b.coverage) < 80) {
    notes.push(`Cobertura diferente ou baixa (${labelA}: ${f(a.coverage)} %, ${labelB}: ${f(b.coverage)} %): a percentagem refere-se só ao tempo com dados.`);
  }
  if (a.outMin === 0 && b.outMin === 0) {
    return { kind: 'none', notes, text: 'Nenhum dos dois saiu do intervalo nas leituras disponíveis.' };
  }
  const diff = a.pctOut - b.pctOut;
  if (Math.abs(diff) < SIMILAR_PP) {
    return { kind: 'similar', notes, text: `Situação semelhante: ${labelA} ${p1(a.pctOut)} % e ${labelB} ${p1(b.pctOut)} % do tempo observado fora do intervalo.` };
  }
  const [w, wl, o, ol] = diff > 0 ? [a, labelA, b, labelB] : [b, labelB, a, labelA];
  return { kind: 'worse', worse: wl, notes,
    text: `${wl} esteve mais tempo fora do intervalo: ${p1(w.pctOut)} % do tempo observado (${f(w.outMin)} min) contra ${p1(o.pctOut)} % (${f(o.outMin)} min) de ${ol}.` };
}



// Síntese de várias métricas: cmps = [{label, cmp}] (cmp vem de compare()).
export function overall(cmps, labelA, labelB) {
  const usable = cmps.filter((c) => c.cmp.kind !== 'unavailable');
  if (!usable.length) return 'Sem métricas comparáveis neste período.';
  const wins = { [labelA]: 0, [labelB]: 0 };
  usable.forEach((c) => { if (c.cmp.kind === 'worse') wins[c.cmp.worse]++; });
  const [w, o] = wins[labelA] >= wins[labelB] ? [labelA, labelB] : [labelB, labelA];
  const tail = usable.length < cmps.length ? ` (${cmps.length - usable.length} sem dados suficientes)` : '';
  if (wins[w] === 0) return `Sem diferença relevante em nenhuma das ${usable.length} métricas comparáveis${tail}.`;
  if (wins[w] === wins[o]) return `Empate: cada dispositivo está pior em ${wins[w]} métrica(s)${tail}.`;
  return `${w} esteve pior em ${wins[w]} de ${usable.length} métricas${tail}.`;
}
