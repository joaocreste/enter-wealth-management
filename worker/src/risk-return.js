/**
 * Trailing-twelve-month return and volatility of every mapped asset, with the
 * market references, for the risk/return chart of the signals page and the
 * scatter of the client report. Shared here so the report agent does not
 * import the router.
 */
import { all, json, nowIso } from './db.js';
import * as P from './pipeline.js';
import * as S from './series.js';
import { previousMonth } from '../../src/core/format.js';
import { INDICATORS } from '../../seed/market.mjs';
import { cacheGet, cacheSet } from '../../src/adapters/cache.js';
import { riskClassOf, RISK_CLASSES, monthEnd, monthBefore, monthlyReturnsFromCloses, riskFromMonthly, efficientFrontier } from '../../src/core/risk.js';
import { dailySeries, dividendsBetween } from '../../src/adapters/yahoo.js';
import * as bcb from '../../src/adapters/bcb.js';
import { makeSource, SourceLedger } from '../../src/core/sources.js';

function addDays(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Trailing-twelve-month return and volatility of every mapped asset, with the
 * market references, for the risk/return chart (src/core/risk.js).
 *
 * Twelve completed months, sampled at month-ends and measured in reais: listed
 * assets from Yahoo's unadjusted closes plus the dividends paid in each month
 * (dollar assets translated at PTAX), fund quotas from the custodian
 * observations, contractual instruments accrued from the Banco Central index
 * plus their spread. The unadjusted close is used on purpose: Yahoo's
 * adjustment factors for Brazilian ETFs and FIIs are unreliable and would turn
 * a listed fund into a 700% return, while the dividend events themselves are
 * sound. A series whose month-end close repeats for months is a provider gap,
 * not a price, and is excluded rather than plotted at zero volatility. The
 * references are the Ibovespa, the S&P 500 in reais and the CDI. What cannot be
 * measured — cash, a matured or delisted line, a series shorter than six months
 * — is listed as excluded with the reason. Cached for an hour.
 */
export async function assetRiskReturn(env, db) {
  P.attachKv(env);
  const today = new Date().toISOString().slice(0, 10);
  const months = [];
  for (let m = previousMonth(today), i = 0; i < 12; i += 1, m = monthBefore(m)) months.unshift(m);
  const anchors = [monthEnd(monthBefore(months[0])), ...months.map(monthEnd)];
  const from = anchors[0]; const to = anchors[anchors.length - 1];
  const cacheKey = `assets-riskret:v2:${to}:${today}`;
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

  const measure = (returns) => riskFromMonthly(returns);
  const assets = [];
  const excluded = [];
  const rows = await all(db, 'SELECT * FROM assets ORDER BY asset_class, ticker, name');
  for (const a of rows) {
    const label = a.ticker || a.name;
    const base = { id: a.id, ticker: a.ticker, name: a.name, asset_class: a.asset_class, risk_class: riskClassOf(a.asset_class), type: a.type, pricing_mode: a.pricing_mode, currency: a.currency };
    const skip = (reason) => excluded.push({ id: a.id, ticker: a.ticker, name: a.name, label, asset_class: a.asset_class, reason });
    if (a.pricing_mode === 'cash') { skip('saldo em conta, não marcado a mercado'); continue; }
    if (a.matured_before && a.matured_before <= to) { skip(`vencido em ${a.matured_before}`); continue; }

    let returns = null; let sources = []; let simulated = false; let basis = null; let note = null;
    if (a.pricing_mode === 'market') {
      if (!a.yahoo_symbol) { skip('sem símbolo em provedor aprovado'); continue; }
      const s = await dailySeries(a.yahoo_symbol, addDays(from, -12), to);
      if (s.unavailable) { skip(a.corporate_action ? `sem série de preços: ${a.corporate_action}` : `Yahoo Finance: ${s.reason}`); continue; }
      const currency = s.currency || a.currency || 'BRL';
      if (currency !== 'BRL' && fx.unavailable) { skip('PTAX indisponível para traduzir a série para reais'); continue; }
      const closes = anchors.map((d) => atOrBefore(s.points, d, 'raw'));
      const local = months.map((m, i) => {
        const o = closes[i]; const c = closes[i + 1];
        return o > 0 && c > 0 ? (c + dividendsBetween(s, anchors[i], anchors[i + 1])) / o - 1 : null;
      });
      if (local.filter((v) => v === 0).length >= 2) { skip('série do Yahoo Finance com o mesmo fechamento em meses seguidos — lacuna do provedor, não um preço'); continue; }
      returns = months.map((m, i) => {
        if (local[i] == null) return { month: m, value: null };
        if (currency === 'BRL') return { month: m, value: local[i] };
        const fo = fxAt(anchors[i]); const fc = fxAt(anchors[i + 1]);
        return { month: m, value: fo && fc ? (1 + local[i]) * (fc / fo) - 1 : null };
      });
      if (local.some((v) => v != null && Math.abs(v) > 0.6)) note = 'movimento mensal acima de 60% na série; conferir evento corporativo antes de citar';
      sources = [s.source];
      basis = `fechamentos e dividendos do mês${currency !== 'BRL' ? ', em reais pela PTAX' : ''}`;
    } else if (a.pricing_mode === 'nav') {
      const obs = navByAsset[a.id] || [];
      if (!obs.length) { skip('sem cotas do custodiante'); continue; }
      returns = monthlyReturnsFromCloses(anchors.map((d) => atOrBefore(obs, d, 'value')), months);
      simulated = obs.some((o) => /simulated/i.test(o.provider || ''));
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
      sources = [{ ...series.source, notes: `acúmulo de ${index}${pct !== 1 ? ` × ${pct}` : ''} mais ${(Number(terms.spread_pa ?? 0) * 100).toFixed(2)}% a.a. de spread contratual` }];
      basis = `acúmulo na curva: ${index} + spread`;
    } else { skip(`modo de apreçamento desconhecido: ${a.pricing_mode}`); continue; }

    const m = measure(returns);
    if (!m) { skip(`histórico insuficiente: ${returns.filter((r) => r.value != null).length} meses com retorno`); continue; }
    assets.push({ ...base, ...m, partial: m.observations < months.length, simulated, basis, note, source_ids: ledger.addAll(sources) });
  }

  // references: the two indices from the store, in reais, and the CDI
  const references = [];
  const ref = async (key, label, symbolKey, inBrl) => {
    const ind = INDICATORS.find((i) => i.key === symbolKey);
    const s = await S.ensureSeries(env, ind, { from: addDays(from, -12) });
    if (s.unavailable) { excluded.push({ id: key, label, reason: `${ind.label}: ${s.reason}`, reference: true }); return; }
    const raw = anchors.map((d) => atOrBefore(s.points, d, 'close'));
    const { closes, fx_ok } = inBrl ? toBrl(raw, 'USD') : { closes: raw, fx_ok: true };
    if (!fx_ok) { excluded.push({ id: key, label, reason: 'PTAX indisponível para traduzir a série para reais', reference: true }); return; }
    const m = measure(monthlyReturnsFromCloses(closes, months));
    if (!m) { excluded.push({ id: key, label, reason: 'histórico insuficiente', reference: true }); return; }
    references.push({ key, label, symbol: ind.yahoo_symbol, ...m, partial: m.observations < months.length, basis: inBrl ? 'fechamentos em reais pela PTAX' : 'fechamentos', source_ids: ledger.addAll([s.source]) });
  };
  await ref('ibovespa', 'Ibovespa', 'ibovespa', false);
  await ref('sp500_brl', 'S&P 500 em reais', 'sp500', true);
  if (cdiByMonth) {
    const m = measure(months.map((mo) => ({ month: mo, value: cdiByMonth.has(mo) ? cdiByMonth.get(mo) / 100 : null })));
    if (m) references.push({ key: 'cdi', label: 'CDI', ...m, partial: m.observations < months.length, basis: 'CDI acumulado no mês', source_ids: ledger.addAll([cdi.source]) });
  } else excluded.push({ id: 'cdi', label: 'CDI', reason: `Banco Central: ${cdi.reason}`, reference: true });

  const frontier = efficientFrontier([
    ...assets.map((a) => ({ key: a.id, x: a.volatility, y: a.total_return })),
    ...references.map((r) => ({ key: r.key, x: r.volatility, y: r.total_return })),
  ]);

  const result = {
    window: { from, to, months, label: '12 meses' },
    frequency: 'monthly',
    currency: 'BRL',
    method: 'retorno composto dos doze retornos mensais; volatilidade é o desvio-padrão amostral dos retornos mensais, anualizado por √12; tudo amostrado nos fins de mês e medido em reais',
    classes: RISK_CLASSES.map(({ key, label }) => ({ key, label })),
    assets,
    references,
    frontier,
    excluded,
    computed_at: nowIso(),
    sources: [...ledger.all(), makeSource({
      provider: 'XP Asset Management (derivado)', kind: 'derived', instrument: 'Retorno e volatilidade em 12 meses por ativo',
      identifier: 'assets-risk-return-12m', requested_range: `${from}..${to}`, last_observation: to,
      notes: 'retorno composto e desvio-padrão anualizado (√12) dos retornos mensais, em reais; fronteira eficiente empírica como envoltória superior dos pontos',
    })],
  };
  await cacheSet(cacheKey, result, 3600);
  return result;
}
