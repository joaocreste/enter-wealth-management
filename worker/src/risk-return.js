/**
 * Trailing return and volatility of every mapped asset, with the market
 * references, for the risk/return chart of the signals page and for the
 * per-asset risk list of a client's Risco tab. Kept out of the route file so a
 * caller does not have to import the router.
 *
 * The expensive half — the monthly return of every asset, from the provider
 * that prices it — is computed once over a long history and cached. The cheap
 * half, the measures, is arithmetic over that history and runs per request, so
 * a reader that wants one trailing window and a reader that wants the window
 * rolled month by month read the same returns and cannot disagree.
 */
import { all, json, nowIso } from './db.js';
import * as P from './pipeline.js';
import * as S from './series.js';
import { previousMonth } from '../../src/core/format.js';
import { INDICATORS } from '../../seed/market.mjs';
import { cacheGet, cacheSet } from '../../src/adapters/cache.js';
import { riskClassOf, RISK_CLASSES, monthEnd, monthBefore, monthlyReturnsFromCloses, riskFromMonthly, rollingRisk, efficientFrontier } from '../../src/core/risk.js';
import { dailySeries, dividendsBetween } from '../../src/adapters/yahoo.js';
import * as bcb from '../../src/adapters/bcb.js';
import { makeSource, SourceLedger } from '../../src/core/sources.js';

/** The window every measure on this page is taken over. */
export const WINDOW_MONTHS = 12;
/** How much history is kept behind it, so the window can be rolled. */
export const HISTORY_MONTHS = 36;

function addDays(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * A month-end close that repeats for months is a provider gap, not a price: an
 * asset whose series stands still is excluded rather than plotted at zero
 * volatility. Applied to the window being measured, never to history the reader
 * is not looking at.
 */
const providerGap = (local) => local.filter((v) => v === 0).length >= 2;

/** A monthly move this large is a corporate action until someone has checked it. */
const bigMove = (local) => local.some((v) => v != null && Math.abs(v) > 0.6);

/**
 * Monthly returns of every mapped asset and of the market references over the
 * last HISTORY_MONTHS months, in reais.
 *
 * Everything is measured at a monthly frequency. Fund quotas exist only at
 * month-ends and contractual instruments accrue from a monthly index, and a
 * measure must not compare a daily volatility with a monthly one, so listed
 * assets are sampled at the same month-ends: listed assets from Yahoo's
 * unadjusted closes plus the dividends paid in each month (dollar assets
 * translated at PTAX), fund quotas from the custodian observations, contractual
 * instruments accrued from the Banco Central index plus their spread. The
 * unadjusted close is used on purpose: Yahoo's adjustment factors for Brazilian
 * ETFs and FIIs are unreliable and would turn a listed fund into a 700% return,
 * while the dividend events themselves are sound. The references are the
 * Ibovespa, the S&P 500 in reais and the CDI. What cannot be priced at all —
 * cash, a matured or delisted line, an instrument with no approved symbol — is
 * listed as excluded with the reason. Cached for an hour.
 *
 * Each series carries both its return in reais and its return in its own
 * currency: the provider-gap rule reads a close that did not move, which is a
 * fact about the close and not about the exchange rate.
 */
async function assetReturnHistory(env, db) {
  P.attachKv(env);
  const today = new Date().toISOString().slice(0, 10);
  const months = [];
  for (let m = previousMonth(today), i = 0; i < HISTORY_MONTHS; i += 1, m = monthBefore(m)) months.unshift(m);
  const anchors = [monthEnd(monthBefore(months[0])), ...months.map(monthEnd)];
  const from = anchors[0]; const to = anchors[anchors.length - 1];
  const cacheKey = `assets-riskhist:v1:${HISTORY_MONTHS}:${to}:${today}`;
  const cached = await cacheGet(cacheKey, 3600);
  if (cached) return { ...cached, from_cache: true };

  const ledger = new SourceLedger();
  const STALE_DAYS = 10;                                   // a close older than this before an anchor is not that month-end
  const atOrBefore = (points, iso, field) => {
    let best = null;
    for (const p of points) { if (p.date <= iso) best = p; else break; }
    if (!best || (Date.parse(iso) - Date.parse(best.date)) / 86400000 > STALE_DAYS) return null;
    return best[field];
  };
  const byMonth = (points) => new Map(points.map((p) => [p.date.slice(0, 7), p.value]));

  const fx = await bcb.series('USD_PTAX_SELL', addDays(from, -12), to);
  if (!fx.unavailable) ledger.add(fx.source);
  const fxAt = (iso) => (fx.unavailable ? null : atOrBefore(fx.points, iso, 'value'));
  const toBrl = (closes, currency) => {
    if (!currency || currency === 'BRL') return { closes, fx_ok: true };
    const out = closes.map((c, i) => { const r = fxAt(anchors[i]); return c != null && r != null ? c * r : null; });
    return { closes: out, fx_ok: !fx.unavailable };
  };

  const cdi = await bcb.series('CDI_MONTHLY', anchors[0], to);
  const ipca = await bcb.series('IPCA_MONTHLY', anchors[0], to);
  const cdiByMonth = cdi.unavailable ? null : byMonth(cdi.points);
  const ipcaByMonth = ipca.unavailable ? null : byMonth(ipca.points);

  const navRows = await all(db, 'SELECT * FROM market_observations WHERE observation_date <= ? AND asset_id IN (SELECT id FROM assets WHERE pricing_mode = ?) ORDER BY observation_date', to, 'nav');
  const navByAsset = {};
  for (const r of navRows) (navByAsset[r.asset_id] ||= []).push({ date: r.observation_date, value: r.price, provider: r.provider });

  const assets = [];
  const excluded = [];
  const rows = await all(db, 'SELECT * FROM assets ORDER BY asset_class, ticker, name');
  for (const a of rows) {
    const label = a.ticker || a.name;
    const base = { id: a.id, ticker: a.ticker, name: a.name, asset_class: a.asset_class, risk_class: riskClassOf(a.asset_class), type: a.type, pricing_mode: a.pricing_mode, currency: a.currency };
    const skip = (reason) => excluded.push({ id: a.id, ticker: a.ticker, name: a.name, label, asset_class: a.asset_class, reason });
    if (a.pricing_mode === 'cash') { skip('saldo em conta, não marcado a mercado'); continue; }
    if (a.matured_before && a.matured_before <= to) { skip(`vencido em ${a.matured_before}`); continue; }

    let returns = null; let local = null; let sources = []; let simulated = false; let basis = null;
    if (a.pricing_mode === 'market') {
      if (!a.yahoo_symbol) { skip('sem símbolo em provedor aprovado'); continue; }
      const s = await dailySeries(a.yahoo_symbol, addDays(from, -12), to);
      if (s.unavailable) { skip(a.corporate_action ? `sem série de preços: ${a.corporate_action}` : `Yahoo Finance: ${s.reason}`); continue; }
      const currency = s.currency || a.currency || 'BRL';
      if (currency !== 'BRL' && fx.unavailable) { skip('PTAX indisponível para traduzir a série para reais'); continue; }
      const closes = anchors.map((d) => atOrBefore(s.points, d, 'raw'));
      local = months.map((m, i) => {
        const o = closes[i]; const c = closes[i + 1];
        return o > 0 && c > 0 ? (c + dividendsBetween(s, anchors[i], anchors[i + 1])) / o - 1 : null;
      });
      returns = months.map((m, i) => {
        if (local[i] == null) return { month: m, value: null };
        if (currency === 'BRL') return { month: m, value: local[i] };
        const fo = fxAt(anchors[i]); const fc = fxAt(anchors[i + 1]);
        return { month: m, value: fo && fc ? (1 + local[i]) * (fc / fo) - 1 : null };
      });
      sources = [s.source];
      basis = `fechamentos e dividendos do mês${currency !== 'BRL' ? ', em reais pela PTAX' : ''}`;
    } else if (a.pricing_mode === 'nav') {
      const obs = navByAsset[a.id] || [];
      if (!obs.length) { skip('sem cotas do custodiante'); continue; }
      returns = monthlyReturnsFromCloses(anchors.map((d) => atOrBefore(obs, d, 'value')), months);
      local = returns.map((r) => r.value);
      // Both spellings: the provider name is written in the language of the
      // letter it is printed in, and this flag is what keeps a simulated quota
      // from being presented as a real one.
      simulated = obs.some((o) => o.simulated === true || /simulat|simulad/i.test(o.provider || ''));
      const provider = obs[obs.length - 1].provider || 'XP position statement (advisor-supplied)';
      sources = [makeSource({
        provider, kind: 'statement', instrument: a.name, identifier: a.isin || a.id, requested_range: `${from}..${to}`,
        last_observation: obs[obs.length - 1].date, reference: 'custodian position statement — not an exchange feed', mocked: simulated,
        notes: 'cotas mensais fornecidas pelo custodiante; não há feed público para este veículo',
      })];
      basis = 'cotas mensais do custodiante';
    } else if (a.pricing_mode === 'accrual') {
      const terms = json(a.accrual_terms, {}) || {};
      const index = terms.index || 'CDI';
      const table = index === 'IPCA' ? ipcaByMonth : cdiByMonth;
      const series = index === 'IPCA' ? ipca : cdi;
      if (!table) { skip(`${index} indisponível no Banco Central`); continue; }
      const spreadM = (1 + Number(terms.spread_pa ?? 0)) ** (1 / 12) - 1;
      const pct = Number(terms.percent_of_index ?? 1);
      returns = months.map((m) => { const v = table.get(m); return { month: m, value: v == null ? null : (1 + (v / 100) * pct) * (1 + spreadM) - 1 }; });
      local = returns.map((r) => r.value);
      sources = [{ ...series.source, notes: `acúmulo de ${index}${pct !== 1 ? ` × ${pct}` : ''} mais ${(Number(terms.spread_pa ?? 0) * 100).toFixed(2)}% a.a. de spread contratual` }];
      basis = `acúmulo na curva: ${index} + spread`;
    } else { skip(`modo de apreçamento desconhecido: ${a.pricing_mode}`); continue; }

    assets.push({ ...base, returns, local, simulated, basis, source_ids: ledger.addAll(sources) });
  }

  // references: the two indices from the store, in reais, and the CDI
  const references = [];
  const refExcluded = [];
  const ref = async (key, label, symbolKey, inBrl) => {
    const ind = INDICATORS.find((i) => i.key === symbolKey);
    const s = await S.ensureSeries(env, ind, { from: addDays(from, -12) });
    if (s.unavailable) { refExcluded.push({ id: key, label, reason: `${ind.label}: ${s.reason}`, reference: true }); return; }
    const raw = anchors.map((d) => atOrBefore(s.points, d, 'close'));
    const { closes, fx_ok } = inBrl ? toBrl(raw, 'USD') : { closes: raw, fx_ok: true };
    if (!fx_ok) { refExcluded.push({ id: key, label, reason: 'PTAX indisponível para traduzir a série para reais', reference: true }); return; }
    const returns = monthlyReturnsFromCloses(closes, months);
    references.push({
      key, label, symbol: ind.yahoo_symbol, returns, local: returns.map((r) => r.value),
      basis: inBrl ? 'fechamentos em reais pela PTAX' : 'fechamentos', source_ids: ledger.addAll([s.source]),
    });
  };
  await ref('ibovespa', 'Ibovespa', 'ibovespa', false);
  await ref('sp500_brl', 'S&P 500 em reais', 'sp500', true);
  if (cdiByMonth) {
    const returns = months.map((mo) => ({ month: mo, value: cdiByMonth.has(mo) ? cdiByMonth.get(mo) / 100 : null }));
    references.push({ key: 'cdi', label: 'CDI', returns, local: returns.map((r) => r.value), basis: 'CDI acumulado no mês', source_ids: ledger.addAll([cdi.source]) });
  } else refExcluded.push({ id: 'cdi', label: 'CDI', reason: `Banco Central: ${cdi.reason}`, reference: true });

  const result = { months, from, to, assets, references, excluded, ref_excluded: refExcluded, sources: ledger.all(), computed_at: nowIso() };
  await cacheSet(cacheKey, result, 3600);
  return result;
}

/** The derived record that says what was done to the providers' numbers. */
const derivedSource = (from, to, extra = null) => makeSource({
  provider: 'XP Asset Management (derivado)', kind: 'derived', instrument: 'Retorno e volatilidade em 12 meses por ativo',
  identifier: 'assets-risk-return-12m', requested_range: `${from}..${to}`, last_observation: to,
  notes: `retorno composto e desvio-padrão anualizado (√12) dos retornos mensais, em reais${extra ? `; ${extra}` : ''}`,
});

const METHOD_PT = 'retorno composto dos doze retornos mensais; volatilidade é o desvio-padrão amostral dos retornos mensais, anualizado por √12; tudo amostrado nos fins de mês e medido em reais';

/**
 * One trailing-window measure of a series, with the rules that decide whether it
 * may be published at all. Returns null with a reason when it may not.
 */
function measureWindow(row, months, { market }) {
  const local = row.local.slice(-months);
  const returns = row.returns.slice(-months);
  if (market && providerGap(local)) return { reason: 'série do Yahoo Finance com o mesmo fechamento em meses seguidos — lacuna do provedor, não um preço' };
  const m = riskFromMonthly(returns);
  if (!m) return { reason: `histórico insuficiente: ${returns.filter((r) => r.value != null).length} meses com retorno` };
  return { m, note: market && bigMove(local) ? 'movimento mensal acima de 60% na série; conferir evento corporativo antes de citar' : null };
}

/**
 * Trailing-twelve-month return against volatility, one point per mapped asset,
 * plus the market references and the empirical efficient frontier — the upper
 * hull of the points, so that nothing on the plane lies above the line.
 *
 * With `rolling`, each asset also carries the same measure taken month by month
 * over the whole history, so a reader can see whether a volatility is where it
 * usually sits or somewhere it has just arrived.
 */
export async function assetRiskReturn(env, db, { rolling = false } = {}) {
  const h = await assetReturnHistory(env, db);
  const months = h.months.slice(-WINDOW_MONTHS);
  const window = { from: monthEnd(monthBefore(months[0])), to: h.to, months, label: '12 meses' };

  // The measure rolled over the whole history, one reading per closed window.
  // A provider gap costs the windows that contain it and no others.
  const rollingSeries = (row, market) => rollingRisk(row.returns, {
    window: WINDOW_MONTHS,
    exclude: market ? (_, from, to) => providerGap(row.local.slice(from, to)) : null,
  });

  const assets = [];
  const excluded = [...h.excluded];
  for (const row of h.assets) {
    const market = row.pricing_mode === 'market';
    const { m, reason, note } = measureWindow(row, WINDOW_MONTHS, { market });
    if (!m) { excluded.push({ id: row.id, ticker: row.ticker, name: row.name, label: row.ticker || row.name, asset_class: row.asset_class, reason }); continue; }
    const { returns, local, ...base } = row;
    assets.push({
      ...base, ...m, partial: m.observations < months.length, note,
      ...(rolling ? { rolling: rollingSeries(row, market) } : {}),
    });
  }

  const references = [];
  for (const row of h.references) {
    const { m, reason } = measureWindow(row, WINDOW_MONTHS, { market: false });
    if (!m) { excluded.push({ id: row.key, label: row.label, reason, reference: true }); continue; }
    const { returns, local, ...base } = row;
    references.push({
      ...base, ...m, partial: m.observations < months.length,
      ...(rolling ? { rolling: rollingSeries(row, false) } : {}),
    });
  }
  excluded.push(...h.ref_excluded);

  const frontier = efficientFrontier([
    ...assets.map((a) => ({ key: a.id, x: a.volatility, y: a.total_return })),
    ...references.map((r) => ({ key: r.key, x: r.volatility, y: r.total_return })),
  ]);

  return {
    window,
    frequency: 'monthly',
    currency: 'BRL',
    method: METHOD_PT,
    classes: RISK_CLASSES.map(({ key, label }) => ({ key, label })),
    assets,
    references,
    frontier,
    excluded,
    ...(rolling ? { rolling_window: { months: WINDOW_MONTHS, history: h.months, readings: Math.max(0, h.months.length - WINDOW_MONTHS + 1) } } : {}),
    computed_at: nowIso(),
    sources: [...h.sources, derivedSource(window.from, h.to, rolling
      ? `a mesma medida tomada mês a mês sobre ${h.months.length} meses de retornos, uma leitura por janela fechada`
      : 'fronteira eficiente empírica como envoltória superior dos pontos')],
  };
}
