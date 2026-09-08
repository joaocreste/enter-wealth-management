/**
 * Banco Central do Brasil — SGS time series.
 * Authoritative for Brazilian policy rate, CDI, IPCA and the PTAX dollar, so it
 * is the primary source for those series rather than a fallback.
 * https://dadosabertos.bcb.gov.br/
 */
import { getJson } from './http.js';
import { makeSource } from '../core/sources.js';
import { cacheGet, cacheSet, throttle } from './cache.js';

const BASE = 'https://api.bcb.gov.br/dados/serie';

export const SERIES = {
  SELIC_TARGET: { code: 432, name: 'Selic — meta definida pelo Copom', unit: '% a.a.' },
  CDI_DAILY: { code: 12, name: 'CDI — taxa diária', unit: '% a.d.' },
  CDI_MONTHLY: { code: 4391, name: 'CDI — acumulada no mês', unit: '% a.m.' },
  IPCA_MONTHLY: { code: 433, name: 'IPCA — variação mensal', unit: '% a.m.' },
  USD_PTAX_SELL: { code: 1, name: 'Dólar dos EUA (venda) — PTAX', unit: 'BRL/USD' },
  IGPM_MONTHLY: { code: 189, name: 'IGP-M — variação mensal', unit: '% a.m.' },
};

const br = (isoDate) => { const [y, m, d] = isoDate.split('-'); return `${d}/${m}/${y}`; };
const toIso = (brDate) => { const [d, m, y] = brDate.split('/'); return `${y}-${m}-${d}`; };

export async function series(key, fromIso, toIsoDate) {
  const def = SERIES[key];
  if (!def) throw new Error(`unknown BCB series ${key}`);
  const cacheKey = `bcb:${def.code}:${fromIso}:${toIsoDate}`;
  const cached = await cacheGet(cacheKey, 6 * 3600);
  const build = (rows) => ({
    key,
    code: def.code,
    name: def.name,
    unit: def.unit,
    points: rows.map((r) => ({ date: toIso(r.data), value: Number(r.valor) })).filter((p) => Number.isFinite(p.value)),
    source: makeSource({
      provider: 'Banco Central do Brasil (SGS)',
      kind: key === 'IPCA_MONTHLY' || key === 'IGPM_MONTHLY' ? 'macro' : 'market_price',
      instrument: def.name,
      identifier: `BCB-SGS-${def.code}`,
      requested_range: `${fromIso}..${toIsoDate}`,
      last_observation: rows.length ? toIso(rows[rows.length - 1].data) : null,
      reference: `https://api.bcb.gov.br/dados/serie/bcdata.sgs.${def.code}/dados`,
    }),
  });
  if (cached) return build(cached);

  try {
    await throttle('bcb', 150);
    const url = `${BASE}/bcdata.sgs.${def.code}/dados?formato=json&dataInicial=${br(fromIso)}&dataFinal=${br(toIsoDate)}`;
    const rows = await getJson(url, { retries: 1, timeout: 15000 });
    if (!Array.isArray(rows) || !rows.length) throw new Error('empty series');
    await cacheSet(cacheKey, rows, 6 * 3600);
    return build(rows);
  } catch (err) {
    return { key, code: def.code, name: def.name, unavailable: true, reason: err.message, points: [], providers_attempted: ['Banco Central do Brasil (SGS)'] };
  }
}

/**
 * CDI accumulated over a window — the reference benchmark for Brazilian
 * fixed income and the risk-free leg of the Sharpe ratio.
 * BCB publishes CDI as a daily percentage; the period return compounds them.
 */
export async function cdiAccumulated(fromIso, toIsoDate) {
  const s = await series('CDI_DAILY', fromIso, toIsoDate);
  if (s.unavailable || !s.points.length) return { unavailable: true, reason: s.reason || 'no CDI observations', providers_attempted: ['Banco Central do Brasil (SGS)'] };
  const factor = s.points.reduce((acc, p) => acc * (1 + p.value / 100), 1);
  return { value: factor - 1, observations: s.points.length, first: s.points[0].date, last: s.points[s.points.length - 1].date, source: s.source };
}
