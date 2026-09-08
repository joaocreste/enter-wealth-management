/**
 * Daily price history for the monitored indicators, kept in R2 (the
 * enter-wealth-market bucket, binding MARKET_SERIES).
 *
 * Yahoo Finance is the provider for every indicator with a listed symbol; the
 * Selic target and the monthly IPCA have no daily price and are listed as
 * excluded rather than silently dropped. Each indicator is one object under
 * series/indicators/<key>.json: the unadjusted and the adjusted daily close,
 * the source record for the whole history, and when it was last refreshed.
 *
 * The first build backfills five years plus a margin. After that a refresh
 * fetches only the last few sessions and merges them, so the store grows by a
 * row a day instead of being downloaded again; a custom range that starts
 * before the stored history extends it backwards on demand, and the store
 * keeps whatever it learned.
 *
 * Variation over a window is measured on the unadjusted close. It is the price
 * the strip shows, and unlike the adjusted close it is not restated every time
 * an ETF pays a dividend — restatement would make merged history inconsistent.
 * The adjusted close is stored alongside for anything that needs total return.
 *
 * A row fetched while its session is still open is the live price, not a close.
 * The store remembers that (last_provisional) so the strip can say so, and
 * refreshes again once the session has had time to close.
 */
import { INDICATORS } from '../../seed/market.mjs';
import { dailySeries } from '../../src/adapters/yahoo.js';
import { makeSource } from '../../src/core/sources.js';
import { cacheGet, cacheSet } from '../../src/adapters/cache.js';

export const SERIES_INDICATORS = INDICATORS.filter((i) => i.yahoo_symbol);
export const EXCLUDED_INDICATORS = INDICATORS.filter((i) => !i.yahoo_symbol)
  .map((i) => ({ key: i.key, label: i.label, reason: 'série mensal ou de política do Banco Central, sem preço diário' }));

const BUCKET = 'enter-wealth-market';       // wrangler.toml [[r2_buckets]] binding MARKET_SERIES
const PREFIX = 'series/indicators/';
const keyOf = (ind) => `${PREFIX}${ind.key}.json`;
const bucketOf = (env) => env.MARKET_SERIES || null;

const BACKFILL_YEARS = 5;
const BACKFILL_MARGIN_DAYS = 45;
export const EARLIEST = '1990-01-01';
const REFRESH_AFTER_MS = 2 * 3600 * 1000;   // a refreshed store is trusted for two hours
const REFRESH_CACHE_TTL = 15 * 60;          // the adapter cache for the incremental fetch
const OVERLAP_DAYS = 10;                    // incremental fetches re-read the last sessions so a late correction lands
const RESPONSE_TTL = 10 * 60;
const MAX_POINTS = 120;                     // sparkline resolution

export const WINDOWS = {
  '5d': { label: '5 dias', sessions: 5 },
  '30d': { label: '30 dias', days: 30 },
  ytd: { label: 'no ano' },
  '1y': { label: '12 meses', years: 1 },
  '5y': { label: '5 anos', years: 5 },
};

// ── dates ───────────────────────────────────────────────────────────────────
const today = () => new Date().toISOString().slice(0, 10);
const isIsoDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
function addDays(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function addYears(iso, years) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() + years);
  return d.toISOString().slice(0, 10);
}

/** The calendar bounds of a preset window ending on `to`. 5D counts sessions, not days. */
export function windowBounds(key, to = today()) {
  const w = WINDOWS[key];
  if (!w) return null;
  if (w.sessions) return { key, label: w.label, from: addDays(to, -Math.ceil(w.sessions * 1.6) - 4), to, sessions: w.sessions };
  if (w.days) return { key, label: w.label, from: addDays(to, -w.days), to };
  if (w.years) return { key, label: w.label, from: addYears(to, -w.years), to };
  return { key, label: w.label, from: `${Number(to.slice(0, 4)) - 1}-12-31`, to }; // YTD: last close of the prior year
}

// ── the store ───────────────────────────────────────────────────────────────
const memStore = new Map(); // stands in for R2 where the binding is absent (tests, a bare Node runner)

async function readStored(env, ind) {
  const key = keyOf(ind);
  const bucket = bucketOf(env);
  if (!bucket) return memStore.get(key) ?? null;
  try {
    const obj = await bucket.get(key);
    return obj ? await obj.json() : null;
  } catch { return null; }
}

async function writeStored(env, ind, stored) {
  const key = keyOf(ind);
  const bucket = bucketOf(env);
  if (!bucket) { memStore.set(key, stored); return; }
  await bucket.put(key, JSON.stringify(stored), {
    httpMetadata: { contentType: 'application/json; charset=utf-8' },
    customMetadata: { symbol: ind.yahoo_symbol, first: stored.first, last: stored.last, refreshed_at: stored.refreshed_at },
  });
}

/** One Yahoo fetch, reshaped for the store. Throws with the provider's reason. */
async function fetchPoints(ind, from, to, { cacheTtl = null } = {}) {
  const s = await dailySeries(ind.yahoo_symbol, from, to, { cacheTtl });
  if (s.unavailable) throw new Error(s.reason || 'provider returned no series');
  return {
    points: s.points.map((p) => ({ date: p.date, close: p.raw, adj: p.close })),
    name: s.name, currency: s.currency, exchange: s.exchange,
    fallback_for: s.source?.fallback_for ?? null,
    in_progress: s.session?.in_progress === true,
  };
}

function mergePoints(base, incoming) {
  const byDate = new Map(base.map((p) => [p.date, p]));
  for (const p of incoming) byDate.set(p.date, p);
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function historySource(ind, stored) {
  return makeSource({
    provider: 'Yahoo Finance',
    kind: 'market_price',
    instrument: stored.name || ind.label,
    identifier: ind.yahoo_symbol,
    requested_range: `${stored.first}..${stored.last}`,
    retrieval_timestamp: stored.refreshed_at,
    last_observation: stored.last,
    reference: `https://finance.yahoo.com/quote/${encodeURIComponent(ind.yahoo_symbol)}/history/`,
    fallback_for: stored.fallback_for || null,
    notes: `fechamentos diários (não ajustados e ajustados) mantidos em R2 desde ${stored.built_at.slice(0, 10)}; ${stored.points.length} sessões`,
  });
}

function finish(ind, stored, points, extra = {}) {
  const now = new Date().toISOString();
  const next = {
    key: ind.key, symbol: ind.yahoo_symbol, label: ind.label, group: ind.group, unit: ind.unit,
    name: extra.name ?? stored?.name ?? ind.label,
    currency: extra.currency ?? stored?.currency ?? null,
    exchange: extra.exchange ?? stored?.exchange ?? null,
    fallback_for: extra.fallback_for ?? stored?.fallback_for ?? null,
    built_at: stored?.built_at ?? now,
    refreshed_at: now,
    last_provisional: extra.last_provisional ?? stored?.last_provisional ?? false,
    covers_from: [stored?.covers_from, extra.covers_from].filter(Boolean).sort()[0] ?? points[0].date, // the earliest date ever requested; a holiday there is not a gap
    first: points[0].date,
    last: points[points.length - 1].date,
    points,
  };
  next.source = historySource(ind, next);
  return next;
}

/**
 * The stored history for one indicator, brought up to date.
 *   from      earliest date the caller needs; the store extends backwards when it starts later
 *   force     discard the stored object and download the history again
 * Returns the stored object, or { unavailable: true, reason } when nothing usable exists.
 */
export async function ensureSeries(env, ind, { from = null, force = false } = {}) {
  const to = today();
  const floor = addDays(addYears(to, -BACKFILL_YEARS), -BACKFILL_MARGIN_DAYS);
  const need = from && from < floor ? (from < EARLIEST ? EARLIEST : from) : floor;
  let stored = force ? null : await readStored(env, ind);

  // first build, or a forced rebuild: the whole history in one request
  if (!stored?.points?.length) {
    try {
      const got = await fetchPoints(ind, addDays(need, -OVERLAP_DAYS) < EARLIEST ? EARLIEST : addDays(need, -OVERLAP_DAYS), to);
      stored = finish(ind, null, got.points, { ...got, covers_from: need, last_provisional: got.in_progress });
      await writeStored(env, ind, stored);
      return { ...stored, action: force ? 'rebuilt' : 'built' };
    } catch (err) {
      return { key: ind.key, symbol: ind.yahoo_symbol, label: ind.label, group: ind.group, unit: ind.unit, unavailable: true, reason: err.message, providers_attempted: ['Yahoo Finance'] };
    }
  }

  let points = stored.points;
  let action = 'stored';
  let error = null;
  let provisional = stored.last_provisional === true;

  // the caller asks for history older than the store holds: extend backwards
  const coversFrom = stored.covers_from || stored.first;
  let extendedTo = null;
  if (need < coversFrom) {
    try {
      const got = await fetchPoints(ind, addDays(need, -OVERLAP_DAYS) < EARLIEST ? EARLIEST : addDays(need, -OVERLAP_DAYS), addDays(stored.first, OVERLAP_DAYS));
      points = mergePoints(points, got.points);
      extendedTo = need;
      action = 'extended';
    } catch (err) { error = `extensão para trás falhou: ${err.message}`; }
  }

  // a new session may have closed since the last refresh, or today's row may still be moving
  const ageMs = Date.now() - Date.parse(stored.refreshed_at);
  if ((stored.last < to || provisional) && ageMs > REFRESH_AFTER_MS) {
    try {
      const got = await fetchPoints(ind, addDays(stored.last, -OVERLAP_DAYS), to, { cacheTtl: REFRESH_CACHE_TTL });
      points = mergePoints(points, got.points);
      provisional = got.in_progress;
      action = action === 'extended' ? 'extended+refreshed' : 'refreshed';
    } catch (err) { error = `atualização falhou: ${err.message}`; }
  }

  if (action !== 'stored') {
    stored = finish(ind, stored, points, { covers_from: extendedTo, last_provisional: provisional });
    await writeStored(env, ind, stored);
  }
  return { ...stored, action, refresh_error: error };
}

// ── windows over the store ──────────────────────────────────────────────────
const lastIndexOnOrBefore = (points, iso) => {
  let lo = 0; let hi = points.length - 1; let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].date <= iso) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return best;
};

function downsample(points, max) {
  if (points.length <= max) return points;
  const step = (points.length - 1) / (max - 1);
  const out = [];
  for (let i = 0; i < max; i += 1) out.push(points[Math.round(i * step)]);
  return out;
}

/** Start, end and variation of one stored series over a window; null when the window has no close. */
export function windowView(stored, { from, to, sessions = null, maxPoints = MAX_POINTS }) {
  const pts = stored.points;
  const endIdx = lastIndexOnOrBefore(pts, to);
  if (endIdx < 0) return null;
  let startIdx;
  let partial = false;
  if (sessions) {
    startIdx = endIdx - sessions;
    if (startIdx < 0) { startIdx = 0; partial = true; }
  } else {
    startIdx = lastIndexOnOrBefore(pts, from);
    if (startIdx < 0) { startIdx = 0; partial = true; }   // history starts after the window: measured from the first close
  }
  if (startIdx >= endIdx) return null;
  const slice = pts.slice(startIdx, endIdx + 1);
  const start = slice[0]; const end = slice[slice.length - 1];
  let high = slice[0]; let low = slice[0];
  for (const p of slice) { if (p.close > high.close) high = p; if (p.close < low.close) low = p; }
  return {
    start: { date: start.date, close: start.close },
    end: { date: end.date, close: end.close, provisional: stored.last_provisional === true && end.date === stored.last },
    change_pct: start.close ? end.close / start.close - 1 : null,
    high: { date: high.date, close: high.close },
    low: { date: low.date, close: low.close },
    sessions: slice.length - 1,
    partial,
    points: downsample(slice, maxPoints).map((p) => ({ date: p.date, close: p.close })),
  };
}

/**
 * The advisor endpoint: every indicator's variation over one window.
 *   window   5d | 30d | ytd | 1y | 5y | custom
 *   from/to  ISO dates, custom only (to also caps a preset when given)
 */
export async function indicatorSeries(env, { window: key = '30d', from = null, to = null } = {}) {
  const now = today();
  let bounds;
  if (key === 'custom') {
    if (!isIsoDate(from) || !isIsoDate(to)) return { error: 'período personalizado exige as datas inicial e final no formato AAAA-MM-DD' };
    if (from < EARLIEST) return { error: `a série armazenada começa, no máximo, em ${EARLIEST}` };
    const end = to > now ? now : to;
    if (from >= end) return { error: 'a data inicial precisa ser anterior à final' };
    bounds = { key: 'custom', label: 'período', from, to: end };
  } else {
    if (!WINDOWS[key]) return { error: `janela desconhecida: ${key}` };
    const end = isIsoDate(to) && to < now ? to : now;
    bounds = windowBounds(key, end);
  }

  const cacheKey = `iseries:${bounds.key}:${bounds.from}:${bounds.to}:${now}`;
  const cached = await cacheGet(cacheKey, RESPONSE_TTL);
  if (cached) return { ...cached, from_cache: true };

  // the store is read in parallel; refreshes go through the adapter's own throttle
  const stored = await Promise.all(SERIES_INDICATORS.map((ind) => ensureSeries(env, ind, { from: bounds.from })));

  const indicators = [];
  const excluded = [...EXCLUDED_INDICATORS];
  const sources = [];
  const store = { backend: bucketOf(env) ? 'R2' : 'memory', bucket: bucketOf(env) ? BUCKET : null, prefix: PREFIX, objects: 0, refreshed_at: null, actions: {} };
  for (const s of stored) {
    if (s.unavailable) { excluded.push({ key: s.key, label: s.label, reason: s.reason }); continue; }
    store.objects += 1;
    store.actions[s.action] = (store.actions[s.action] ?? 0) + 1;
    if (!store.refreshed_at || s.refreshed_at > store.refreshed_at) store.refreshed_at = s.refreshed_at;
    const view = windowView(s, bounds);
    if (!view) { excluded.push({ key: s.key, label: s.label, symbol: s.symbol, first: s.first, reason: `sem fechamentos no período pedido (a série começa em ${s.first})` }); continue; }
    sources.push(s.source);
    indicators.push({
      key: s.key, label: s.label, group: s.group, unit: s.unit, symbol: s.symbol, name: s.name, currency: s.currency,
      history: { first: s.first, last: s.last, sessions: s.points.length, refreshed_at: s.refreshed_at, refresh_error: s.refresh_error ?? null },
      ...view,
      source: s.source,
    });
  }

  const result = {
    window: bounds,
    basis: 'variação entre o fechamento da sessão inicial (ou o último anterior à data) e o da sessão final, preços não ajustados',
    as_of: indicators.reduce((a, i) => (i.end.date > a ? i.end.date : a), ''),
    indicators,
    excluded,
    store,
    computed_at: new Date().toISOString(),
    sources: [...sources, makeSource({
      provider: 'Enter Asset Management (derivado)', kind: 'derived', instrument: 'Variação dos indicadores monitorados',
      identifier: `indicators-${bounds.key}`, requested_range: `${bounds.from}..${bounds.to}`, last_observation: bounds.to,
      notes: 'calculada sobre as séries diárias do Yahoo Finance mantidas em R2',
    })],
  };
  await cacheSet(cacheKey, result, RESPONSE_TTL);
  return result;
}

/** Bring every stored series up to date; the daily cron calls this so the first advisor of the day does not wait. */
export async function warmSeriesStore(env, { force = false } = {}) {
  const summary = { ok: 0, failed: [], actions: {} };
  for (const ind of SERIES_INDICATORS) {
    const s = await ensureSeries(env, ind, { force });
    if (s.unavailable) { summary.failed.push({ key: ind.key, reason: s.reason }); continue; }
    summary.ok += 1;
    summary.actions[s.action] = (summary.actions[s.action] ?? 0) + 1;
    if (s.refresh_error) summary.failed.push({ key: ind.key, reason: s.refresh_error, kept_stored: true });
  }
  return summary;
}
