/**
 * Market-data orchestrator.
 *
 * Owns the provider chain and the failure policy (§30):
 *   1. try the primary provider for the instrument class
 *   2. on failure try the approved fallback, and record `fallback_for`
 *   3. if nothing reliable is available return DATA_UNAVAILABLE — never a guess
 *
 * A single calculation never mixes providers: the month-start and month-end
 * price for one instrument always come from the same series object.
 *
 * Pricing modes
 *   market  — exchange-listed, priced from a provider series
 *   nav     — fund quota valued from custodian statement observations (no public feed)
 *   accrual — contractual instrument accrued from an official index + spread
 *   cash    — non-market balance
 */
import * as yahoo from './yahoo.js';
import * as bcb from './bcb.js';
import * as coingecko from './coingecko.js';
import { makeSource, unavailable } from '../core/sources.js';

/** Windows are widened so the anchor dates always have a preceding observation. */
function widen(fromIso, days = 12) {
  const d = new Date(`${fromIso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/**
 * Price an instrument at two anchor dates.
 * @param {object} asset      an Assets row (ticker, yahoo_symbol, tv_symbol, pricing_mode, ...)
 * @param {string} startIso   valuation anchor for the opening price (prior month end)
 * @param {string} endIso     valuation anchor for the closing price (month end)
 * @param {object} [ctx]      { navObservations, accrualIndexes }
 */
export async function priceWindow(asset, startIso, endIso, ctx = {}) {
  const mode = asset.pricing_mode || 'market';

  if (mode === 'cash') {
    return {
      asset_id: asset.id, mode, open: null, close: null, income: 0,
      note: 'cash balance — not marked to market',
      sources: [],
    };
  }

  if (mode === 'nav') return priceFromNav(asset, startIso, endIso, ctx);
  if (mode === 'accrual') return priceFromAccrual(asset, startIso, endIso, ctx);
  return priceFromMarket(asset, startIso, endIso);
}

async function priceFromMarket(asset, startIso, endIso) {
  const attempted = [];
  const from = widen(startIso);

  // ── primary: crypto goes to CoinGecko, everything else to Yahoo ───────────
  if (asset.coingecko_id) {
    attempted.push('CoinGecko');
    // CoinGecko's free tier gives spot only; monthly anchors come from Yahoo,
    // so crypto uses Yahoo for the window and CoinGecko for the live quote.
  }

  if (asset.yahoo_symbol) {
    attempted.push('Yahoo Finance');
    const s = await yahoo.dailySeries(asset.yahoo_symbol, from, endIso);
    if (!s.unavailable) {
      const open = yahoo.closeOnOrBefore(s, startIso);
      const close = yahoo.closeOnOrBefore(s, endIso);
      if (open && close) {
        return {
          asset_id: asset.id, mode: 'market',
          open: open.close, open_date: open.date,
          close: close.close, close_date: close.date,
          income_per_unit: yahoo.dividendsBetween(s, startIso, endIso),
          currency: s.currency || asset.currency,
          instrument_name: s.name,
          sources: [s.source],
        };
      }
    }
  }

  // ── fallback: TradingView last close (closing anchor only) ────────────────
  if (asset.tv_symbol) {
    attempted.push('TradingView');
    try {
      const { signals } = await import('./tradingview.js');
      const sig = await signals([asset.tv_symbol]);
      const row = sig[asset.tv_symbol];
      if (row && Number.isFinite(row.last_close)) {
        return {
          asset_id: asset.id, mode: 'market',
          open: null, open_date: null,
          close: row.last_close, close_date: new Date().toISOString().slice(0, 10),
          income_per_unit: 0,
          currency: row.currency || asset.currency,
          partial: true,
          note: 'closing price only — no opening observation from any approved provider, so no return is computed for this position',
          sources: [makeSource({
            provider: 'TradingView',
            kind: 'market_price',
            instrument: row.description || asset.name,
            identifier: asset.tv_symbol,
            requested_range: 'last close',
            last_observation: new Date().toISOString().slice(0, 10),
            reference: `https://www.tradingview.com/symbols/${asset.tv_symbol.replace(':', '-')}/`,
            fallback_for: 'Yahoo Finance',
          })],
        };
      }
    } catch { /* fall through to unavailable */ }
  }

  return {
    asset_id: asset.id, mode: 'market',
    ...unavailable(
      asset.corporate_action
        ? `no price series: ${asset.corporate_action}`
        : 'no approved provider returned a usable series for this instrument',
      attempted,
    ),
    sources: [],
  };
}

/**
 * Fund quotas. Brazilian FIC/FIM quotas have no public price feed; the
 * authoritative observation is the custodian statement. Those observations are
 * stored as MarketObservations with provider "XP position statement", and the
 * source line says so plainly rather than implying an exchange feed.
 */
function priceFromNav(asset, startIso, endIso, ctx) {
  const obs = (ctx.navObservations?.[asset.id] || [])
    .slice()
    .sort((a, b) => a.observation_date.localeCompare(b.observation_date));
  const pick = (anchor) => {
    let best = null;
    for (const o of obs) { if (o.observation_date <= anchor) best = o; else break; }
    return best;
  };
  const open = pick(startIso);
  const close = pick(endIso);
  if (!open || !close || open.observation_date === close.observation_date) {
    return {
      asset_id: asset.id, mode: 'nav',
      ...unavailable('no pair of custodian NAV observations spans the reporting month', ['XP position statement']),
      sources: [],
    };
  }
  const provider = open.provider || 'XP position statement (advisor-supplied)';
  return {
    asset_id: asset.id, mode: 'nav',
    open: open.price, open_date: open.observation_date,
    close: close.price, close_date: close.observation_date,
    income_per_unit: 0,
    currency: asset.currency,
    sources: [makeSource({
      provider,
      kind: 'statement',
      instrument: asset.name,
      identifier: asset.ticker || asset.isin || asset.id,
      requested_range: `${open.observation_date}..${close.observation_date}`,
      last_observation: close.observation_date,
      reference: 'custodian position statement — not an exchange feed',
      notes: 'Quota values are supplied by the custodian; no public market feed exists for this vehicle.',
    })],
  };
}

/**
 * Contractual instruments (CDB IPCA+, LCA CDI+, debentures).
 * Accrued from the official index published by the Banco Central plus the
 * contractual spread. The index is real; the spread comes from the instrument
 * record. Both are cited.
 */
async function priceFromAccrual(asset, startIso, endIso, ctx) {
  const terms = asset.accrual_terms || {};
  const index = terms.index || 'CDI';
  const spreadPa = Number(terms.spread_pa ?? 0);
  const pctIndex = Number(terms.percent_of_index ?? 1);
  const days = Math.max(1, Math.round((Date.parse(endIso) - Date.parse(startIso)) / 86400000));

  if (asset.matured_before && asset.matured_before <= endIso) {
    return {
      asset_id: asset.id, mode: 'accrual',
      ...unavailable(`instrument matured on ${asset.matured_before}; position status must be confirmed with the custodian before it is valued`, ['Banco Central do Brasil (SGS)']),
      sources: [],
    };
  }

  let indexReturn = null;
  const sources = [];

  if (index === 'CDI') {
    const cached = ctx.cdi?.[`${startIso}..${endIso}`];
    const cdi = cached || await bcb.cdiAccumulated(startIso, endIso);
    if (!cdi.unavailable) { indexReturn = cdi.value * pctIndex; sources.push(cdi.source); }
  } else if (index === 'IPCA') {
    const s = await bcb.series('IPCA_MONTHLY', widen(startIso, 70), endIso);
    if (!s.unavailable && s.points.length) {
      // IPCA is published with a lag; the month actually applied is the newest
      // observation at or before the window end. The lag is disclosed.
      const applied = s.points[s.points.length - 1];
      indexReturn = applied.value / 100;
      sources.push({ ...s.source, notes: `IPCA reference month applied: ${applied.date.slice(0, 7)} (index published with a one-month lag)` });
    }
  }

  if (indexReturn == null) {
    return {
      asset_id: asset.id, mode: 'accrual',
      ...unavailable(`could not retrieve the ${index} index for the reporting period`, ['Banco Central do Brasil (SGS)']),
      sources: [],
    };
  }

  const spreadReturn = (1 + spreadPa) ** (days / 365) - 1;
  const totalReturn = (1 + indexReturn) * (1 + spreadReturn) - 1;
  return {
    asset_id: asset.id, mode: 'accrual',
    open: 1, open_date: startIso,
    close: 1 + totalReturn, close_date: endIso,
    income_per_unit: 0,
    currency: asset.currency,
    accrual: { index, index_return: indexReturn, spread_pa: spreadPa, percent_of_index: pctIndex, days },
    note: `accrued from ${index} + ${(spreadPa * 100).toFixed(2)}% p.a. over ${days} days`,
    sources,
  };
}

/** Live quote for a World Overview indicator. Chain: CoinGecko (crypto) → Yahoo → BCB. */
export async function indicatorQuote(ind) {
  if (ind.coingecko_id) {
    const r = await coingecko.spot([ind.yahoo_symbol]);
    const row = r[ind.yahoo_symbol];
    if (row && !row.unavailable) return { ...row, key: ind.key, label: ind.label, unit: ind.unit };
  }
  if (ind.yahoo_symbol) {
    const q = await yahoo.quote(ind.yahoo_symbol);
    if (!q.unavailable) return { ...q, key: ind.key, label: ind.label, unit: ind.unit };
  }
  if (ind.bcb_series) {
    const to = new Date().toISOString().slice(0, 10);
    const s = await bcb.series(ind.bcb_series, widen(to, 45), to);
    if (!s.unavailable && s.points.length) {
      const last = s.points[s.points.length - 1];
      const first = s.points[0];
      return {
        key: ind.key, label: ind.label, unit: ind.unit,
        symbol: `BCB-SGS-${s.code}`, name: s.name, price: last.value,
        changePct: first.value ? last.value / first.value - 1 : null,
        mtdPct: null, asOf: last.date, source: s.source,
      };
    }
  }
  return { key: ind.key, label: ind.label, unavailable: true, reason: 'no approved provider returned this indicator', providers_attempted: ['CoinGecko', 'Yahoo Finance', 'Banco Central do Brasil (SGS)'] };
}

export { yahoo, bcb, coingecko };
