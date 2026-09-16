/**
 * Checks the invariants this product depends on.
 *
 *   npm run verify              engine checks only
 *   npm run verify -- --live    also checks a running API and the provider chain
 *
 * These are the properties that, if they broke, would put a wrong number in front
 * of a client. They are asserted rather than assumed.
 */
import { monthlyProfitability, modifiedDietz, timeWeightedReturn, historicalMetrics, rollingMetrics } from '../src/core/performance.js';
import { proposeForAsset, bandPosition, ACTIONS } from '../src/core/recommendations.js';
import { checkSuitability, SUITABILITY, withinPolicy, policyFitLabel } from '../src/core/suitability.js';
import { evaluateTrigger, driftTriggers, triggerProximity, TRIGGER_STATUS } from '../src/core/triggers.js';
import { validateReport, emptyReport, standardDisclosures } from '../src/core/report-schema.js';
import { money, percent, pp, previousMonth, monthBounds, MINUS } from '../src/core/format.js';
import { TrueTypeFont } from '../src/render/pdf/ttf.js';
import { brandFonts } from '../src/render/fonts/index.js';
import { deterministicLetter } from '../worker/src/llm.js';
import { allocationRows } from '../worker/src/pipeline.js';
import { buildLetterModel, sanitiseLetter, strayNumbers, houseView, stanceStep, ACTION_PT } from '../src/render/letter-model.js';
import { renderLetterPdf, contributorBars } from '../src/render/pdf/letter.js';
import { PdfDocument } from '../src/render/pdf/writer.js';
import { rangeBarGeometry } from '../src/render/charts.js';
import { pearson, logReturns, correlationMatrix } from '../src/core/correlation.js';
import { riskFromMonthly, riskClassOf, monthEnd, monthBefore, monthlyReturnsFromCloses, efficientFrontier } from '../src/core/risk.js';
import { parseRss, clusterHeadlines, sourceFor, distinctStories, isServicePiece, PROVIDER as VALOR } from '../src/adapters/valor.js';
import { splitTitle, feedUrl } from '../src/adapters/googlenews.js';
import { articleUrl } from '../src/adapters/bingnews.js';
import { describeLevelSeries } from '../src/adapters/marketdata.js';
import { monthToDate } from '../src/adapters/yahoo.js';
import { buildWhatMattersTable, notableWindow } from '../src/core/events.js';
import { figuresIn, projectionSentences, parseArchive, parseFeed, isoFromRfc822, ptLabel, parseEdition, houseView as xpHouseView, ptDate, monthlyReport, deposit as depositXp, DEPOSIT_KEY, PROVIDER as XP_RESEARCH } from '../src/adapters/xpresearch.js';

let pass = 0; let fail = 0;
const t = (name, fn) => {
  try { fn(); pass += 1; console.log(`  ✓ ${name}`); }
  catch (e) { fail += 1; console.log(`  ✗ ${name}\n      ${e.message}`); }
};
/** The same, for a check that awaits something (a PDF render). */
const ta = async (name, fn) => {
  try { await fn(); pass += 1; console.log(`  ✓ ${name}`); }
  catch (e) { fail += 1; console.log(`  ✗ ${name}\n      ${e.message}`); }
};
const eq = (a, b, msg) => { if (a !== b) throw new Error(`${msg || ''} expected ${b}, got ${a}`); };
const close = (a, b, tol, msg) => { if (!(Math.abs(a - b) <= tol)) throw new Error(`${msg || ''} expected ${b} ±${tol}, got ${a}`); };
const ok = (c, msg) => { if (!c) throw new Error(msg || 'assertion failed'); };

console.log('\n  Formatting — the rules a client letter cannot break');
t('a negative figure uses U+2212, never a hyphen', () => {
  ok(percent(-0.0412).startsWith(MINUS), 'percent');
  ok(money(-1234.5).includes(MINUS), 'money');
  ok(!percent(-0.0412).includes('-'), 'hyphen leaked in');
});
t('every positive return carries an explicit plus', () => {
  ok(percent(0.0173).startsWith('+'));
  ok(pp(0.0055).startsWith('+'));
});
t('locale separators never mix inside one document', () => {
  eq(percent(0.0173, { locale: 'pt-BR' }), '+1,73%');
  eq(percent(0.0173, { locale: 'en' }), '+1.73%');
  eq(money(386858.82, { locale: 'pt-BR' }), 'R$ 386.859');
});
t('currency is always explicit, never a bare dollar sign', () => {
  ok(money(12.34, { currency: 'USD', locale: 'en' }).startsWith('US$'));
});
t('an unavailable figure says so instead of printing zero', () => {
  eq(percent(null), 'DATA UNAVAILABLE');
  eq(money(undefined), 'DATA UNAVAILABLE');
});
t('the reporting month is the previous calendar month', () => {
  eq(previousMonth('2026-09-07'), '2026-08');
  eq(previousMonth('2026-01-03'), '2025-12');
  eq(monthBounds('2026-08').priorEnd, '2026-07-31');
});

console.log('\n  Headlines — what the newsroom published, attributed');
const FEED = `<?xml version="1.0"?><rss><channel><title>valor</title>
<item><title>Andr&#233; Mendon&#231;a afasta Andrei Rodrigues da dire&#231;&#227;o da PF</title><atom:subtitle>Ministro do STF atendeu pedido</atom:subtitle><link>https://valor.globo.com/politica/noticia/2026/09/08/a.ghtml</link><guid>https://valor.globo.com/politica/noticia/2026/09/08/a.ghtml</guid><description><![CDATA[ <img src="x.jpg" /><br /> ]]> O ministro André Mendonça, do STF, afastou nesta terça o diretor-geral da PF.</description><pubDate>Tue, 08 Sep 2026 11:59:00 -0300</pubDate></item>
<item><title>AGU deve contestar decis&#227;o de Mendon&#231;a de afastar diretor da PF alegando viola&#231;&#227;o de compet&#234;ncia</title><link>https://valor.globo.com/politica/noticia/2026/09/08/b.ghtml</link><description>A AGU recorreu da decis&#227;o de Mendon&#231;a.</description><pubDate>Tue, 08 Sep 2026 13:47:00 -0300</pubDate></item>
<item><title>Lula ignora afastamento de Andrei da PF em evento ap&#243;s decis&#227;o de Mendon&#231;a</title><link>https://valor.globo.com/politica/noticia/2026/09/08/c.ghtml</link><description>x</description><pubDate>Tue, 08 Sep 2026 21:15:00 -0300</pubDate></item>
<item><title>Apple deve lan&#231;ar amanh&#227; seu primeiro celular de tela dob&#225;vel</title><link>https://valor.globo.com/empresas/noticia/2026/09/08/d.ghtml</link><description>y</description><pubDate>Tue, 08 Sep 2026 08:00:00 -0300</pubDate></item>
<item><title>Valor 1000: Copacol lidera o setor</title><link>https://valor.globo.com/patrocinado/dino/noticia/2026/09/08/e.ghtml</link><description>z</description><pubDate>Tue, 08 Sep 2026 08:00:00 -0300</pubDate></item>
</channel></rss>`;
t('the feed parser reads title, subtitle, link, lead and date, decoding entities and dropping markup', () => {
  const items = parseRss(FEED);
  eq(items.length, 5);
  eq(items[0].title, 'André Mendonça afasta Andrei Rodrigues da direção da PF');
  eq(items[0].subtitle, 'Ministro do STF atendeu pedido');
  eq(items[0].link, 'https://valor.globo.com/politica/noticia/2026/09/08/a.ghtml');
  ok(items[0].lead.startsWith('O ministro André Mendonça'), `lead was "${items[0].lead}"`);
  ok(!items[0].lead.includes('<img'), 'markup leaked into the lead');
  eq(items[0].publishedAt.toISOString(), '2026-09-08T14:59:00.000Z');
});
t('headlines about one story cluster together and the biggest cluster leads with the line that broke it', () => {
  const items = parseRss(FEED).slice(0, 4).map((it, i) => ({ id: `h${i}`, title: it.title, subtitle: it.subtitle, lead: it.lead, url: it.link, section: 'politica', published: it.publishedAt.toISOString() }));
  const clusters = clusterHeadlines(items);
  eq(clusters[0].size, 3, 'PF/STF cluster size');
  ok(clusters[0].lead.title.startsWith('André Mendonça afasta'), `lead was "${clusters[0].lead.title}"`);
  eq(clusters.length, 2, 'Apple stays apart');
});
t('every headline carries a source record naming the newspaper and the article', () => {
  const s = sourceFor({ title: 'x', url: 'https://valor.globo.com/politica/noticia/2026/09/08/a.ghtml', published: '2026-09-08T14:59:00.000Z', section: 'politica' });
  eq(s.provider, VALOR); eq(s.kind, 'news');
  eq(s.reference, 'https://valor.globo.com/politica/noticia/2026/09/08/a.ghtml');
  eq(s.last_observation, '2026-09-08');
});
t('the move column shows the day, and a longer window only when notable, always with its timeframe', () => {
  eq(notableWindow({ d5Pct: 0.012, d30Pct: 0.031 }), null, 'a quiet week and month earn no second line');
  const five = notableWindow({ d5Pct: -0.034, d30Pct: 0.12 });
  eq(five.key, '5d'); eq(five.label_pt, 'em 5 sessões');
  const thirty = notableWindow({ d5Pct: 0.01, d30Pct: 0.09, d30From: '2026-08-09' });
  eq(thirty.key, '30d'); eq(thirty.label_pt, 'em 30 dias'); eq(thirty.from, '2026-08-09');
  const portfolios = [{ client_id: 'c1', client_name: 'A', portfolio: { exposures: { Commodities: 0.1 }, positions: [], base_currency: 'BRL' } }];
  const [row] = buildWhatMattersTable(
    [{ id: 'e', title: 'Brent', category: 'commodities', asset_classes: ['Commodities'], importance: 'high', indicator_key: 'brent', summary: 's' }],
    [{ key: 'brent', price: 99.36, unit: 'USD/bbl', changePct: 0.014, d5Pct: 0.02, d30Pct: 0.09, mtdPct: 0.134 }], portfolios);
  eq(row.current_move.changePct, 0.014, 'the day move is always carried');
  eq(row.current_move.notable.key, '30d', 'the notable window is decided in code, not in the browser');
});
t('the story of the day stays on the table even when no portfolio maps to it, and comes first', () => {
  const portfolios = [{ client_id: 'c1', client_name: 'A', portfolio: { exposures: { 'Equities BR': 0.3 }, positions: [], base_currency: 'BRL' } }];
  const rows = buildWhatMattersTable([
    { id: 'e_move', title: 'Brent up', category: 'commodities', asset_classes: ['Equities BR'], importance: 'high', summary: 's' },
    { id: 'e_top', title: 'Crise no STF', category: 'politics', asset_classes: ['Real Estate'], importance: 'medium', market_wide: true, coverage: 36, summary: 's' },
    { id: 'e_low', title: 'Nada', category: 'macro', asset_classes: ['Real Estate'], importance: 'medium', summary: 's' },
  ], [], portfolios);
  eq(rows.length, 2, 'the unmapped medium event is dropped, the market-wide one is not');
  eq(rows[0].event_id, 'e_top');
  eq(rows[0].coverage, 36);
});

console.log('\n  Return engine');
t('Modified Dietz day-weights a mid-month flow', () => {
  const r = modifiedDietz(100000, 111000, [{ date: '2026-08-16', amount: 10000 }], '2026-07-31', '2026-08-31');
  close(r.denominator, 104839, 400, 'denominator');
  close(r.value, 0.00954, 0.0005, 'return');
});
t('a portfolio with no flows uses the simple return', () => {
  const r = monthlyProfitability({
    start: '2026-07-31', end: '2026-08-31', opening_cash: 0, closing_cash: 0, flows: [],
    positions: [{ asset: { id: 'a', name: 'A', asset_class: 'Equities BR', currency: 'BRL' }, quantity: 100, open_price: 10, close_price: 11, pricing_mode: 'market' }],
  });
  eq(r.method, 'simple');
  close(r.monthly_return, 0.10, 1e-9);
});
t('true TWR removes the flow from its own sub-period', () => {
  // End-of-day marks: the +10 on 15 Aug is already inside the 110.
  // Sub-period 1: (110 − 10)/100 = 0%.  Sub-period 2: 132/110 = +20%.
  const r = timeWeightedReturn(
    [{ date: '2026-07-31', value: 100 }, { date: '2026-08-15', value: 110 }, { date: '2026-08-31', value: 132 }],
    [{ date: '2026-08-15', amount: 10 }],
  );
  eq(r.method, 'twr_daily_linked');
  close(r.value, 0.20, 1e-9);
  eq(r.sub_periods, 2);
  // and a flow-free series is just the simple return
  const clean = timeWeightedReturn([{ date: 'a', value: 100 }, { date: 'b', value: 121 }], []);
  close(clean.value, 0.21, 1e-9);
});
t('attribution always sums to the reported return', () => {
  const r = monthlyProfitability({
    start: '2026-07-31', end: '2026-08-31', opening_cash: 5000, closing_cash: 8000,
    flows: [{ date: '2026-08-10', amount: 3000 }],
    positions: [
      { asset: { id: 'a', name: 'A', asset_class: 'Equities BR', currency: 'BRL' }, quantity: 100, open_price: 10, close_price: 11, pricing_mode: 'market' },
      { asset: { id: 'b', name: 'B', asset_class: 'Equities Global', currency: 'USD' }, quantity: 50, open_price: 20, close_price: 19, fx_open: 5.08, fx_close: 5.18, pricing_mode: 'market' },
      { asset: { id: 'c', name: 'C', asset_class: 'Fixed Income', currency: 'BRL' }, quantity: 10, market_value: 900, reason: 'delisted', pricing_mode: 'market' },
    ],
  });
  ok(r.attribution.reconciles, 'attribution does not reconcile');
  const sum = r.attribution.by_position.reduce((a, p) => a + p.contribution, 0) + r.attribution.residual.contribution;
  close(sum, r.monthly_return, 1e-12);
});
t('an unpriceable position contributes exactly zero and is disclosed', () => {
  const r = monthlyProfitability({
    start: '2026-07-31', end: '2026-08-31', opening_cash: 0, closing_cash: 0, flows: [],
    positions: [
      { asset: { id: 'a', name: 'A', asset_class: 'Equities BR', currency: 'BRL' }, quantity: 100, open_price: 10, close_price: 11, pricing_mode: 'market' },
      { asset: { id: 'x', name: 'Delisted', ticker: 'ARZZ3', asset_class: 'Equities BR', currency: 'BRL' }, quantity: 193, market_value: 3414, reason: 'no price series', pricing_mode: 'market' },
    ],
  });
  eq(r.coverage.excluded.length, 1);
  eq(r.coverage.excluded[0].ticker, 'ARZZ3');
  // the excluded value sits on both sides, so it moves the denominator but not the P&L
  close(r.absolute_pnl, 100, 1e-9);
});
t('FX is decomposed out of the base-currency result', () => {
  const r = monthlyProfitability({
    start: '2026-07-31', end: '2026-08-31', opening_cash: 0, closing_cash: 0, flows: [],
    positions: [{ asset: { id: 'b', name: 'B', asset_class: 'Equities Global', currency: 'USD' }, quantity: 10, open_price: 100, close_price: 100, fx_open: 5.0, fx_close: 5.5, pricing_mode: 'market' }],
  });
  close(r.attribution.fx_contribution, 0.10, 1e-9, 'a flat asset with a 10% FX move is 10% FX contribution');
});
t('a historical measure is never labelled as an expectation', () => {
  const m = historicalMetrics([...Array(40)].map((_, i) => ({ month: `2023-${i}`, value: 0.01 })), Array(40).fill(0.008));
  eq(m.classification, 'historical_measure');
  ok(m.three_year_available);
  ok(m.sharpe_ratio > 0);
});
t('three-year return is withheld when history is short', () => {
  const m = historicalMetrics([...Array(12)].map((_, i) => ({ month: `2026-${i}`, value: 0.01 })));
  eq(m.three_year_return, null);
  ok(m.three_year_note.includes('12'));
});
t('a rolling window reports exactly what the same window reported to historicalMetrics', () => {
  const months = [...Array(20)].map((_, i) => ({ month: `2025-${String(i + 1).padStart(2, '0')}`, value: (i % 5 - 2) / 100 }));
  const rf = months.map(() => 0.009);
  const roll = rollingMetrics(months, rf, { window: 12 });
  eq(roll.length, 9, 'twenty months close nine twelve-month windows');
  eq(roll[0].month, months[11].month);
  eq(roll[roll.length - 1].month, months[19].month);
  const last = historicalMetrics(months.slice(-12), rf.slice(-12));
  close(roll[roll.length - 1].volatility, last.annualised_volatility, 1e-12);
  close(roll[roll.length - 1].sharpe, last.sharpe_ratio, 1e-12);
});
t('a window missing a month is left unmeasured rather than measured short', () => {
  const months = [...Array(13)].map((_, i) => ({ month: `2025-${String(i + 1).padStart(2, '0')}`, value: i === 0 ? null : 0.01 + (i % 3) / 100 }));
  const roll = rollingMetrics(months, months.map(() => 0.008), { window: 12 });
  eq(roll[0].volatility, null, 'the window holding the gap publishes no volatility');
  eq(roll[0].sharpe, null);
  ok(roll[1].volatility != null, 'the next window, complete, does');
});
t('no risk-free rate means no Sharpe ratio, never a Sharpe against zero', () => {
  const months = [...Array(12)].map((_, i) => ({ month: `2026-${String(i + 1).padStart(2, '0')}`, value: 0.01 + i / 1000 }));
  const roll = rollingMetrics(months, null, { window: 12 });
  eq(roll.length, 1);
  eq(roll[0].sharpe, null);
  eq(roll[0].risk_free_return, null);
  ok(roll[0].volatility > 0);
});

console.log('\n  Recommendations and the guardrail');
const asset = (o = {}) => ({ id: 'ast_x', ticker: 'XPTO', name: 'Xpto S.A.', asset_class: 'Equities BR', currency: 'BRL', risk_grade: 4, type: 'stock', ...o });
const sig = (tech, an) => ({
  technical: tech ? { signal: tech, rating: 0.4, timeframe: '1D', moving_averages: tech, oscillators: tech } : { unavailable: true, reason: 'not covered' },
  analyst: an ? { consensus: an, mark: 2, analyst_count: 11, breakdown: { buy: 6, hold: 4, sell: 1 }, target_price: { average: 20 }, implied_upside: 0.2 } : { unavailable: true, reason: 'No analyst consensus available' },
});
t('a technical Sell beside an analyst Buy is surfaced as a conflict', () => {
  const r = proposeForAsset({
    asset: asset(), position: { weight: 0.03, market_value: 1000 }, signal: sig('Sell', 'Strong Buy'),
    classBand: { min: 0.1, max: 0.3, target: 0.2 }, policy: { single_name_cap: 0.12 }, exposure: { class_weight: 0.2 },
  });
  ok(r.signal_conflict, 'conflict not detected');
  eq(r.proposed_action, ACTIONS.DISCUSS);
  ok(r.factors.some((f) => f.family === 'tradingview_technical'));
  ok(r.factors.some((f) => f.family === 'tradingview_analyst'));
});
t('analyst sentiment is never inferred from the technical rating', () => {
  const r = proposeForAsset({
    asset: asset(), position: { weight: 0.03, market_value: 1000 }, signal: sig('Strong Buy', null),
    classBand: { min: 0.1, max: 0.3, target: 0.2 }, policy: {}, exposure: { class_weight: 0.2 },
  });
  eq(r.analyst_signal, null);
  ok(r.factors.some((f) => f.family === 'tradingview_analyst' && f.unavailable));
});
t('the guardrail can only make a recommendation more conservative', () => {
  const rec = { proposed_action: ACTIONS.ADD, current_weight: 0.03, flags: [], technical_signal: 'Buy', analyst_signal: 'Buy' };
  const c = checkSuitability(rec, {
    asset: asset({ risk_grade: 5 }), policy: { risk_profile: 'Moderado', base_currency: 'BRL' },
    exposures: { 'Equities BR': 0.2 }, portfolio: {}, classBand: { min: 0.1, max: 0.3 },
  });
  eq(c.suitability_result, SUITABILITY.DO_NOT_ADD);
  ok(c.final_action !== ACTIONS.ADD, 'an ADD survived a DO_NOT_ADD');
  ok(c.statement.client_suitability.includes('DO NOT ADD'));
});
t('a broad index ETF is exempt from the single-name issuer cap', () => {
  const c = checkSuitability(
    { proposed_action: ACTIONS.HOLD, current_weight: 0.14, flags: [] },
    { asset: asset({ type: 'etf', concentration_exempt: true }), policy: { single_name_cap: 0.12, risk_profile: 'Moderado' }, exposures: { 'Equities BR': 0.2 }, portfolio: {}, classBand: { min: 0.1, max: 0.3 } },
  );
  ok(!c.flags.some((f) => f.code === 'CONCENTRATION_BREACH'));
  eq(c.suitability_result, SUITABILITY.PASS);
});
t('an actively managed fund is NOT exempt from the cap', () => {
  const c = checkSuitability(
    { proposed_action: ACTIONS.HOLD, current_weight: 0.14, flags: [] },
    { asset: asset({ type: 'fund' }), policy: { single_name_cap: 0.12, risk_profile: 'Moderado' }, exposures: { 'Equities BR': 0.2 }, portfolio: {}, classBand: { min: 0.1, max: 0.3 } },
  );
  eq(c.suitability_result, SUITABILITY.REDUCE_REQUIRED);
  ok(c.flags.some((f) => f.code === 'CONCENTRATION_BREACH' && f.message_pt));
});
t('a restricted asset class is blocked outright', () => {
  const c = checkSuitability(
    { proposed_action: ACTIONS.ADD, current_weight: 0, flags: [] },
    {
      asset: asset({ asset_class: 'Digital Assets' }),
      policy: { risk_profile: 'Moderado', restrictions: [{ type: 'asset_class', value: 'Digital Assets', label: 'Ativos digitais não autorizados.' }] },
      exposures: {}, portfolio: {}, classBand: null,
    },
  );
  eq(c.suitability_result, SUITABILITY.BLOCKED);
  eq(c.final_action, ACTIONS.DISCUSS);
});
t('band position is computed against the policy, not the target alone', () => {
  eq(bandPosition(0.02, { min: 0.03, max: 0.12, target: 0.05 }).state, 'below_band');
  eq(bandPosition(0.15, { min: 0.03, max: 0.12, target: 0.05 }).state, 'above_band');
  eq(bandPosition(0.05, { min: 0.03, max: 0.12, target: 0.05 }).state, 'within_band');
});

console.log('\n  Thresholds');
t('a threshold with a persistence window needs the window, not one touch', () => {
  const trigger = { id: 't', label: 'VIX above 30 for five sessions', comparator: 'gt', threshold: 30, persistence_days: 5 };
  const touched = evaluateTrigger(trigger, { value: 31, history: [{ value: 20 }, { value: 21 }, { value: 22 }, { value: 25 }, { value: 31 }] });
  eq(touched.status, TRIGGER_STATUS.APPROACHING);
  const sustained = evaluateTrigger(trigger, { value: 34, history: Array(5).fill({ value: 33 }) });
  eq(sustained.status, TRIGGER_STATUS.BREACHED);
});
t('an unavailable indicator reports NO_DATA, never a false all-clear', () => {
  const r = evaluateTrigger({ id: 't', label: 'x', comparator: 'gt', threshold: 5 }, { unavailable: true, reason: 'provider down' });
  eq(r.status, TRIGGER_STATUS.NO_DATA);
  eq(r.observed, null);
});
t('allocation drift is bilingual and directional', () => {
  const d = driftTriggers({ 'Equities BR': 0.30 }, { 'Equities BR': 0.20 }, 0.05);
  eq(d.length, 1);
  close(d[0].drift, 0.10, 1e-9);
  ok(d[0].action.includes('trimming'));
  ok(d[0].action_pt.includes('reduzir'));
});

console.log('\n  Trigger proximity (the bar the portal draws)');
t('proximity is exactly 1 at the threshold, whichever way the trigger points', () => {
  close(triggerProximity({ observed: 90, threshold: 90, comparator: 'gt' }), 1, 1e-12, 'above');
  close(triggerProximity({ observed: 92, threshold: 92, comparator: 'lt' }), 1, 1e-12, 'below');
  close(triggerProximity({ observed: -0.04, threshold: -0.04, comparator: 'lt' }), 1, 1e-12, 'negative below');
  close(triggerProximity({ observed: 30, threshold: 30, comparator: 'abs_gt' }), 1, 1e-12, 'absolute');
});
t('proximity grows as a reading approaches its trigger from either side', () => {
  ok(triggerProximity({ observed: 97.8, threshold: 90, comparator: 'gt' }) > 1, 'past an above trigger');
  const dxy = triggerProximity({ observed: 98.8, threshold: 92, comparator: 'lt' });
  ok(dxy > 0.9 && dxy < 1, 'approaching a below trigger from above');
  close(triggerProximity({ observed: -0.01, threshold: -0.04, comparator: 'lt' }), 0.25, 1e-12, 'a quarter of the way into a fall');
  eq(triggerProximity({ observed: 0.02, threshold: -0.04, comparator: 'lt' }), 0, 'a rise is nowhere near a fall trigger');
  eq(triggerProximity({ observed: null, threshold: 90, comparator: 'gt' }), null, 'no reading, no bar');
});

console.log('\n  Correlation');
t('a series against itself is +1, against its mirror is −1', () => {
  const pts = [100, 101, 99, 103, 104, 102, 105, 108, 107, 110].map((c, i) => ({ date: `2026-08-${String(i + 1).padStart(2, '0')}`, close: c }));
  const mirror = pts.map((p) => ({ date: p.date, close: 10000 / p.close }));
  const { matrix } = correlationMatrix([{ key: 'a', returns: logReturns(pts) }, { key: 'b', returns: logReturns(mirror) }], { minObservations: 5 });
  close(matrix[0][0], 1, 1e-12, 'diagonal'); close(matrix[0][1], -1, 1e-9, 'mirror'); eq(matrix[0][1], matrix[1][0], 'symmetry');
});
t('a pair is measured only over the dates both series observed', () => {
  const a = new Map([['d1', 0.01], ['d2', -0.02], ['d3', 0.015], ['d4', 0.004], ['d5', -0.01]]);
  const b = new Map([['d1', 0.02], ['d3', 0.01], ['d4', 0.003], ['d5', -0.02], ['d6', 0.05]]);
  const { observations } = correlationMatrix([{ key: 'a', returns: a }, { key: 'b', returns: b }], { minObservations: 3 });
  eq(observations[0][1], 4, 'common dates'); eq(observations[0][0], 5, 'own dates');
});
t('too few common observations is unavailable, never zero', () => {
  const a = new Map([['d1', 0.01], ['d2', -0.02]]); const b = new Map([['d1', 0.02], ['d2', 0.01]]);
  const { matrix } = correlationMatrix([{ key: 'a', returns: a }, { key: 'b', returns: b }]);
  eq(matrix[0][1], null); eq(pearson([1, 1, 1], [1, 2, 3]), null, 'constant series');
});

console.log('\n  Return and volatility');
t('return compounds the monthly returns; volatility is their sample deviation × √12', () => {
  const rs = [0.02, -0.01, 0.015, 0.005, -0.02, 0.03, 0.01, 0, 0.012, -0.004, 0.018, 0.007].map((v, i) => ({ month: `2026-${String(i + 1).padStart(2, '0')}`, value: v }));
  const m = riskFromMonthly(rs);
  close(m.total_return, rs.reduce((a, r) => a * (1 + r.value), 1) - 1, 1e-12, 'compounded');
  const mean = rs.reduce((a, r) => a + r.value, 0) / 12;
  const sd = Math.sqrt(rs.reduce((a, r) => a + (r.value - mean) ** 2, 0) / 11);
  close(m.volatility, sd * Math.sqrt(12), 1e-12, 'annualised'); eq(m.observations, 12);
});
t('too few months is unavailable, never zero; a missing close leaves two months without a return', () => {
  eq(riskFromMonthly([{ month: 'a', value: 0.01 }, { month: 'b', value: 0.02 }]), null);
  const months = ['2026-01', '2026-02', '2026-03'];
  const rs = monthlyReturnsFromCloses([100, 110, null, 121], months);
  eq(rs.length, 3); close(rs[0].value, 0.1, 1e-12); eq(rs[1].value, null); eq(rs[2].value, null);
});
t('month arithmetic lands on the right calendar day', () => {
  eq(monthEnd('2026-02'), '2026-02-28'); eq(monthEnd('2024-02'), '2024-02-29'); eq(monthEnd('2026-12'), '2026-12-31');
  eq(monthBefore('2026-01'), '2025-12'); eq(monthBefore('2026-08'), '2026-07');
});
t('the empirical frontier is the upper hull from the least volatile point to the highest return', () => {
  const pts = [
    { key: 'cdi', x: 0.002, y: 0.12 }, { key: 'lqd', x: 0.05, y: 0.02 }, { key: 'bova', x: 0.18, y: 0.30 },
    { key: 'ivv', x: 0.14, y: 0.25 }, { key: 'gold', x: 0.20, y: 0.45 }, { key: 'btc', x: 0.55, y: 0.10 }, { key: 'mid', x: 0.10, y: 0.15 },
  ];
  const f = efficientFrontier(pts);
  eq(f[0], 'cdi', 'starts at the least volatile'); eq(f[f.length - 1], 'gold', 'ends at the highest return');
  ok(!f.includes('lqd') && !f.includes('btc') && !f.includes('mid') && !f.includes('ivv'), `dominated points stay below the line: ${f}`);
  for (let i = 1; i < f.length; i += 1) { const a = pts.find((p) => p.key === f[i - 1]); const b = pts.find((p) => p.key === f[i]); ok(b.x > a.x && b.y > a.y, 'rises to the right'); }
});
t('asset classes fold into the four chart classes', () => {
  eq(riskClassOf('Equities BR'), 'equity'); eq(riskClassOf('Real Estate'), 'equity'); eq(riskClassOf('Fixed Income'), 'debt');
  eq(riskClassOf('Commodities'), 'fx_commodities'); eq(riskClassOf('Alternatives'), 'crypto_other'); eq(riskClassOf('Something new'), 'crypto_other');
});

console.log('\n  Canonical report validation');
t('a report with an unsourced market figure is rejected', () => {
  const r = emptyReport();
  Object.assign(r, {
    client: {}, advisor: {}, reporting_period: {}, approved_portfolio: {},
    disclosures: standardDisclosures('pt-BR'),
    sources: [{ id: 'src_1', provider: 'Yahoo Finance' }],
    portfolio_performance: { monthly_return: 0.01, source_ids: [] },
  });
  const v = validateReport(r);
  ok(!v.ok);
  ok(v.errors.some((e) => e.includes('no source_ids')));
});
t('a report is rejected while any recommendation is unapproved', () => {
  const r = emptyReport();
  Object.assign(r, {
    client: {}, advisor: {}, reporting_period: {}, approved_portfolio: {},
    disclosures: standardDisclosures('pt-BR'),
    sources: [{ id: 'src_1', provider: 'Yahoo Finance' }],
    portfolio_performance: { monthly_return: 0.01, source_ids: ['src_1'] },
    recommendations: [{ ticker: 'X', suitability_result: 'PASS', advisor_status: 'proposed', final_action: 'HOLD' }],
  });
  ok(validateReport(r).errors.some((e) => e.includes('only advisor-approved')));
});
t('an ADD that contradicts its suitability result is rejected', () => {
  const r = emptyReport();
  Object.assign(r, {
    client: {}, advisor: {}, reporting_period: {}, approved_portfolio: {},
    disclosures: standardDisclosures('pt-BR'),
    sources: [{ id: 'src_1', provider: 'Yahoo Finance' }],
    portfolio_performance: { monthly_return: 0.01, source_ids: ['src_1'] },
    recommendations: [{ ticker: 'X', suitability_result: 'DO_NOT_ADD', advisor_status: 'approved', final_action: 'ADD' }],
  });
  ok(validateReport(r).errors.some((e) => e.includes('suitability says')));
});
t('P&L that does not reconcile with values and flows is rejected', () => {
  const r = emptyReport();
  Object.assign(r, {
    client: {}, advisor: {}, reporting_period: {}, approved_portfolio: {},
    disclosures: standardDisclosures('pt-BR'),
    sources: [{ id: 'src_1', provider: 'Yahoo Finance' }],
    portfolio_performance: { monthly_return: 0.01, source_ids: ['src_1'], beginning_market_value: 100, ending_market_value: 110, net_flows: 0, absolute_pnl: 25 },
  });
  ok(validateReport(r).errors.some((e) => e.includes('does not reconcile')));
});

console.log('\n  PDF engine');
t('the brand typefaces embed and map Portuguese and the true minus', () => {
  const f = new TrueTypeFont(brandFonts().sans400);
  for (const ch of 'ãçéõáêúüÁÊ−R$%') ok(f.glyphFor(ch.codePointAt(0)) > 0, `no glyph for ${ch}`);
  ok(f.measure('Prezado Albert,', 11) > 60);
});
t('a generated PDF is well formed and carries a UTF-16 title', () => {
  const doc = new PdfDocument({ title: 'Carta mensal — Albert da Silva', author: 'Antonio Bicudo' });
  doc.registerFont('sans', brandFonts().sans400);
  doc.addPage();
  doc.text('Rentabilidade −1,20% · R$ 386.859', 50, 700, { font: 'sans', size: 11 });
  const bytes = doc.build();
  const head = new TextDecoder().decode(bytes.slice(0, 9));
  eq(head, '%PDF-1.7\n');
  const tail = new TextDecoder('latin1').decode(bytes.slice(-2048));
  ok(tail.includes('%%EOF'));
  ok(tail.includes('startxref'));
  const all = new TextDecoder('latin1').decode(bytes);
  ok(all.includes('<FEFF'), 'non-ASCII metadata is not UTF-16 encoded');
});

// ── live checks ───────────────────────────────────────────────────────────
if (process.argv.includes('--live')) {
  const BASE = process.env.API_BASE || 'http://127.0.0.1:8788';
  console.log('\n  Live provider chain and API');
  const tAsync = async (name, fn) => {
    try { await fn(); pass += 1; console.log(`  ✓ ${name}`); }
    catch (e) { fail += 1; console.log(`  ✗ ${name}\n      ${e.message}`); }
  };
  const { useDisk } = await import('../src/adapters/cache.js');
  await useDisk('.cache');

  await tAsync('Yahoo Finance returns a usable series', async () => {
    const { dailySeries, closeOnOrBefore } = await import('../src/adapters/yahoo.js');
    const s = await dailySeries('^BVSP', '2026-07-15', '2026-09-06');
    ok(!s.unavailable, s.reason);
    ok(closeOnOrBefore(s, '2026-08-31'), 'no close for the month end');
    ok(s.source.provider === 'Yahoo Finance' && s.source.retrieval_timestamp);
  });
  await tAsync('a delisted ticker returns DATA UNAVAILABLE, not a stale price', async () => {
    const { dailySeries } = await import('../src/adapters/yahoo.js');
    const s = await dailySeries('ARZZ3.SA', '2026-07-15', '2026-09-06');
    ok(s.unavailable, 'a delisted ticker returned data');
    ok(s.providers_attempted.length > 0);
  });
  await tAsync('the Banco Central is the source for CDI and PTAX', async () => {
    const { cdiAccumulated, series } = await import('../src/adapters/bcb.js');
    const cdi = await cdiAccumulated('2026-08-01', '2026-08-31');
    ok(!cdi.unavailable && cdi.value > 0, 'CDI unavailable');
    const fx = await series('USD_PTAX_SELL', '2026-08-20', '2026-09-05');
    ok(!fx.unavailable && fx.points.length > 0);
  });
  await tAsync('TradingView returns two independent families', async () => {
    const { signals } = await import('../src/adapters/tradingview.js');
    const r = await signals(['BMFBOVESPA:LREN3', 'AMEX:IVV']);
    ok(r['BMFBOVESPA:LREN3'].technical.signal, 'no technical rating for LREN3');
    ok(r['AMEX:IVV'].analyst.unavailable, 'an ETF reported analyst coverage');
    ok(r['AMEX:IVV'].analyst.reason.includes('No analyst consensus available'));
  });
  await tAsync('the three outputs render from one payload and agree', async () => {
    const login = await (await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'antonio.bicudo@xpi.com.br', password: 'xp2026' }) })).json();
    const H = { authorization: `Bearer ${login.token}` };
    const list = await (await fetch(`${BASE}/api/clients/cli_albert/reports`, { headers: H })).json();
    ok(list.reports.length, 'no report generated yet — run npm run demo first');
    const id = list.reports[0].id;
    const full = await (await fetch(`${BASE}/api/clients/cli_albert/reports/${id}`, { headers: H })).json();
    const c = full.report.canonical;
    const ret = percent(c.portfolio_performance.monthly_return, { locale: 'pt-BR' });
    const html = await (await fetch(`${BASE}/api/reports/${id}/html`, { headers: H })).text();
    ok(html.includes(ret), `the email does not show ${ret}`);
    const pdf = new Uint8Array(await (await fetch(`${BASE}/api/reports/${id}/pdf`, { headers: H })).arrayBuffer());
    ok(pdf.length > 10000, 'pdf too small');
    eq(new TextDecoder().decode(pdf.slice(0, 8)), '%PDF-1.7');
    ok(full.report.page_count <= 2, `pdf is ${full.report.page_count} pages`);
  });
  await tAsync('the letter agent writes one client\'s carta, and stops at a published month', async () => {
    const login = await (await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'antonio.bicudo@xpi.com.br', password: 'xp2026' }) })).json();
    const H = { authorization: `Bearer ${login.token}`, 'content-type': 'application/json' };
    const start = async (body) => (await (await fetch(`${BASE}/api/clients/cli_albert/letters`, { method: 'POST', headers: H, body: JSON.stringify(body) })).json()).run;
    const settle = async (runId) => {
      for (let i = 0; i < 90; i += 1) {
        const { run } = await (await fetch(`${BASE}/api/clients/cli_albert/letters/${runId}`, { headers: H })).json();
        if (run.status !== 'running') return run;
        await new Promise((r) => { setTimeout(r, 2000); });
      }
      throw new Error('the run never settled');
    };

    // A month already published is refused, and says so in a way the tab can act on.
    const published = await (await fetch(`${BASE}/api/clients/cli_albert/reports`, { headers: H })).json();
    if (published.reports.some((r) => r.status === 'published')) {
      const blocked = await settle((await start({})).id);
      eq(blocked.status, 'failed');
      eq(blocked.blocked_by, 'published');
    }

    // Asked for deliberately, it writes the letter and leaves it for approval.
    const done = await settle((await start({ reissue: true })).id);
    eq(done.status, 'completed');
    ok(done.report_id, done.error || 'the run produced no letter');
    ok(done.page_count <= 2, `the letter is ${done.page_count} pages`);
    const full = await (await fetch(`${BASE}/api/clients/cli_albert/reports/${done.report_id}`, { headers: H })).json();
    eq(full.report.status, 'pending_approval');
    ok(full.report.canonical.letter.greeting.startsWith('Prezado'), 'the letter does not greet the client');
  });
  await tAsync('XP publishes its monthly macro report where the macro agent looks for it', async () => {
    const r = await monthlyReport();
    ok(!r.unavailable, r.reason || 'the report could not be read');
    ok(/^20\d\d-\d\d-\d\d$/.test(r.published), `no publication date: ${r.published}`);
    ok(r.age_days < 100, `the newest edition is ${r.age_days} days old`);
    ok(r.sections.length >= 3, `only ${r.sections.length} sections`);
    ok(r.summary.length || r.sections.some((x) => x.paragraphs.length), 'the edition carried no text');
    ok(r.figures.length >= 2, `only ${r.figures.length} projections read`);
    ok(['feed', 'archive'].includes(r.route), `unknown route ${r.route}`);
    for (const f of r.figures) ok(f.quote.includes(f.written.replace('%', '')), `${f.key} ${f.year} is not in its own sentence`);
    eq(r.source.provider, XP_RESEARCH);
    ok(r.source.reference.startsWith('https://conteudos.xpi.com.br/'), r.source.reference);
    eq(r.source.mocked, false);
  });
  await tAsync('a client cannot read another client', async () => {
    const login = await (await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'albert.dasilva@exemplo.com.br', password: 'albert2026' }) })).json();
    const res = await fetch(`${BASE}/api/clients/cli_beatriz`, { headers: { authorization: `Bearer ${login.token}` } });
    eq(res.status, 403);
  });
}

console.log('\n  Indicators — a rate has a level and a last change, never a day move');
t('the Selic is a step: the day it changed and the value before it, no percentage', () => {
  const pts = [['2026-07-30', 14.25], ['2026-07-31', 14.25], ['2026-08-06', 14.0], ['2026-08-07', 14.0], ['2026-09-11', 14.0]].map(([date, value]) => ({ date, value }));
  const l = describeLevelSeries(pts);
  eq(l.kind, 'policy_rate'); eq(l.since, '2026-08-06'); eq(l.prev_value, 14.25); close(l.delta, -0.25, 1e-9);
});
t('the IPCA is one number a month: the reference month and the month before, never −557%', () => {
  const pts = [{ date: '2026-06-01', value: 0.26 }, { date: '2026-07-01', value: 0.07 }, { date: '2026-08-01', value: -0.32 }];
  const l = describeLevelSeries(pts, { monthly: true });
  eq(l.kind, 'monthly_index'); eq(l.period, '2026-08'); eq(l.prev_period, '2026-07'); eq(l.prev_value, 0.07);
  ok(!('changePct' in l), 'no percentage change on a percentage');
});
t('month to date is measured from the last close of the previous month', () => {
  const bars = [{ date: '2026-08-28', close: 100 }, { date: '2026-08-31', close: 110 }, { date: '2026-09-01', close: 120 }, { date: '2026-09-11', close: 121 }];
  const m = monthToDate(bars, 121, '2026-09');
  eq(m.from, '2026-08-31'); close(m.pct, 0.1, 1e-9);
  eq(monthToDate(bars.slice(2), 121, '2026-09').pct, null, 'no previous-month close in the window');
});

console.log('\n  Headlines — coverage counts stories, and service pieces are not events');
t('thirty candidate lists filled from one template are one story', () => {
  const items = ['Acre (AC)', 'Alagoas (AL)', 'Amapá (AP)'].map((uf, i) => ({ id: `h${i}`, title: `Candidatos a senador pelo ${uf}: veja lista das eleições 2026` }));
  eq(distinctStories(items), 1);
  eq(distinctStories([{ title: 'Copom corta a Selic para 14%' }, { title: 'Dólar cai com corte da Selic' }]), 2);
  ok(isServicePiece('Candidatos a senador pelo Acre (AC): veja lista das eleições 2026'));
  ok(!isServicePiece('Copom corta a Selic para 14,00% ao ano'));
});
t('a Google News item keeps its publisher and loses the " - Publisher" suffix', () => {
  const xml = '<rss><channel><item><title>Fed poised to raise rates - WSJ</title><link>https://news.google.com/rss/articles/abc?oc=5</link><pubDate>Fri, 11 Sep 2026 21:21:41 GMT</pubDate><source url="https://www.wsj.com">WSJ</source></item></channel></rss>';
  const [it] = parseRss(xml);
  eq(it.source, 'WSJ'); eq(it.sourceUrl, 'https://www.wsj.com');
  const s = splitTitle(it.title, it.source);
  eq(s.title, 'Fed poised to raise rates'); eq(s.publisher, 'WSJ');
  ok(feedUrl({ q: 'Fed', region: 'intl' }, 48).includes('when%3A2d'), 'the 48-hour window goes into the query');
});
t('a Bing News item names its publisher and links to the article, not to Bing', () => {
  const xml = '<rss><channel><item><title>Ibovespa vai &#224;s m&#237;nimas</title><link>http://www.bing.com/news/apiclick.aspx?ref=FexRss&amp;url=https%3a%2f%2fvalor.globo.com%2ffinancas%2fnoticia%2f2026%2f09%2f11%2fx.ghtml&amp;c=1</link><pubDate>Fri, 11 Sep 2026 16:47:00 GMT</pubDate><News:Source>Valor Econ&#244;mico</News:Source></item></channel></rss>';
  const [it] = parseRss(xml);
  eq(it.title, 'Ibovespa vai às mínimas'); eq(it.source, 'Valor Econômico');
  eq(articleUrl(it.link), 'https://valor.globo.com/financas/noticia/2026/09/11/x.ghtml');
  eq(articleUrl('https://example.com/a'), 'https://example.com/a');
});

console.log('\n  The XP monthly report — the house view, read from the house\'s own sentences');
t('a revision reports the figure XP moved to, never the one it left', () => {
  const [f] = figuresIn(['Nossa projeção para o IPCA de 2026 foi reduzida de 5,1% para 5,0%, refletindo surpresas baixistas.'], 2026);
  eq(f.key, 'ipca'); eq(f.year, 2026); eq(f.written, '5,0%'); close(f.value, 0.05, 1e-9);
});
t('a revision inside a continuation clause does the same', () => {
  const figs = figuresIn(['Elevamos nossa projeção para o IPCA de 2026 de 5,3% para 5,5%; para 2027, subimos a expectativa de 4,0% para 4,2%.'], 2026);
  eq(figs.find((f) => f.year === 2026).written, '5,5%');
  eq(figs.find((f) => f.year === 2027).written, '4,2%');
});
t('"este ano" and "o ano que vem" resolve against the edition, not against today', () => {
  const figs = figuresIn(['Nossas projeções para o IPCA continuaram em 5,1% este ano e 4,2% no ano que vem, com elevada incerteza.'], 2026);
  eq(figs.length, 2);
  eq(figs.find((f) => f.year === 2026).written, '5,1%');
  eq(figs.find((f) => f.year === 2027).written, '4,2%');
  eq(figuresIn(['Projetamos a taxa Selic em 11,50% ao final do ano que vem.'], 2025)[0].year, 2026);
});
t('a share of output is never read as growth', () => {
  eq(figuresIn(['Tendência de curto prazo reforça nossa projeção de déficit primário de 0,3% do PIB para o governo central em 2026.'], 2026).length, 0);
  eq(figuresIn(['O aumento das despesas financeiras levará a dívida pública para 83,3% e 88,1% do PIB em 2026 e 2027.'], 2026).length, 0);
});
t('a sentence naming two years yields both', () => {
  const figs = figuresIn(['Projetamos a taxa Selic em 13,25% no final de 2026 e 11,50% em 2027 (nível alcançado em junho).'], 2026);
  eq(figs.length, 2); eq(figs[0].written, '13,25%'); eq(figs[1].written, '11,50%');
  const fx = figuresIn(['Continuamos a projetar 5,00 reais por dólar no final de 2026 e 5,30 no final de 2027.'], 2026);
  eq(fx.length, 2); eq(fx[0].unit, 'brl_per_usd'); close(fx[1].value, 5.3, 1e-9);
});
t('a phrasing the parser does not recognise yields no figure at all', () => {
  eq(figuresIn(['na taxa Selic, para 13,75% (esperávamos três reduções antes, para 13,50%), seguidos por uma pausa.'], 2026).length, 0);
});
t('every figure carries the sentence it was read from, and the sentence contains it', () => {
  for (const f of figuresIn([
    'Reduzimos nossa projeção para o crescimento do PIB em 2026, de 2,0% para 1,7%, devido ao arrefecimento.',
    'Projetamos a taxa Selic em 13,25% no final de 2026 e 11,50% em 2027.',
  ], 2026)) {
    ok(f.quote && f.quote.length > 20, `${f.key} has no quote`);
    ok(f.quote.includes(f.written.replace('%', '')), `${f.key} quote does not contain ${f.written}`);
  }
});
t('the projection sentences keep what the figures could not', () => {
  const sents = projectionSentences(['Mantemos a projeção de 14,00% para a taxa Selic no final deste ano.', 'O tempo melhorou.']);
  eq(sents.length, 1);
  ok(sents[0].includes('14,00%'));
});
t('a Portuguese card date becomes an ISO date', () => {
  eq(ptDate('3 Set 2026'), '2026-09-03');
  eq(ptDate('14 Fev 2025'), '2025-02-14');
  eq(ptDate('sem data'), null);
});
t('the archive is read newest first, whatever order the cards arrive in', () => {
  const card = (slug, title, when) => `<a class="bloco-materia box-rounded" href="https://conteudos.xpi.com.br/economia/brasil-macro-mensal-${slug}/" data-wa="x" title="${title}"><div class="conteudo-aprenda"><div class="data">${when} • 33 mins de leitura</div><div class="conteudo-titulo"><h3>${title}</h3></div><div class="personas"><h4>Caio Megale</h4><p>Economista-chefe da XP</p></div></div></a>`;
  const editions = parseArchive(`${card('julho', 'Brasil Macro Mensal: Julho', '7 Jul 2026')}${card('setembro', 'Brasil Macro Mensal: Setembro', '3 Set 2026')}`);
  eq(editions.length, 2);
  eq(editions[0].published, '2026-09-03');
  eq(editions[0].authors[0].name, 'Caio Megale');
  ok(editions[0].url.endsWith('/brasil-macro-mensal-setembro/'));
});
t('the feed yields the report and never the weekly note that links to it', () => {
  const item = (title, when, content) => `<item><title><![CDATA[${title}]]></title><link>https://conteudos.xpi.com.br/economia/${title.toLowerCase().replace(/[^a-z]+/g, '-')}/</link><pubDate>${when}</pubDate><dc:creator><![CDATA[Caio Megale]]></dc:creator><content:encoded><![CDATA[${content}]]></content:encoded></item>`;
  const xml = `<rss><channel>`
    + item('Economia em Destaque: PIB reflete desaceleração', 'Fri, 04 Sep 2026 18:28:13 +0000', '<p>Comenta o <em>Brasil Macro Mensal</em> desta semana.</p>')
    + item('Brasil Macro Mensal: Desaceleração antes do esperado', 'Thu, 03 Sep 2026 19:39:25 +0000', '<ul class="wp-block-list"><li>Projetamos a taxa Selic em 13,25% no final de 2026 e 11,50% em 2027, diante da desaceleração.</li></ul>')
    + item('Brasil Macro Mensal: Edição anterior', 'Thu, 06 Aug 2026 19:00:00 +0000', '<p>anterior</p>')
    + `</channel></rss>`;
  const editions = parseFeed(xml);
  eq(editions.length, 2, 'the weekly note was taken for the report');
  eq(editions[0].published, '2026-09-03');
  eq(editions[0].published_label, '3 Set 2026');
  eq(editions[0].authors[0].name, 'Caio Megale');
  const ed = parseEdition(editions[0].content, editions[0]);
  eq(ed.figures.length, 2);
  eq(ed.figures[0].written, '13,25%');
});
t('a feed date and an archive card date agree on the same edition', () => {
  eq(isoFromRfc822('Thu, 03 Sep 2026 19:39:25 +0000'), '2026-09-03');
  eq(ptLabel('2026-09-03'), '3 Set 2026');
  eq(ptDate(ptLabel('2026-09-03')), '2026-09-03');
  eq(isoFromRfc822('não é uma data'), null);
});
t('an edition gives its conclusions, a stance per topic, and the report PDF', () => {
  const html = `<article><ul class="wp-block-list"><li>Reduzimos nossa projeção para o crescimento do PIB em 2026, de 2,0% para 1,7%, devido ao arrefecimento dos componentes cíclicos;</li></ul>`
    + `<h2>Editorial – Desaceleração mais cedo do que o esperado</h2><p>${'A economia brasileira está perdendo força mais cedo do que esperávamos, e isso muda o cenário para o ano que vem. '.repeat(2)}</p>`
    + `<h3>Política Monetária – Não vemos pausa no ciclo de corte de juros</h3><p>${'O Copom deve seguir cortando a taxa básica ao longo dos próximos trimestres, segundo o nosso cenário base. '.repeat(2)}</p></article>`
    + `<a href="https://conteudos.xpi.com.br/wp-content/uploads/2026/09/XP-Macro-Mensal-Set26.pdf">Leia o relatório em PDF – PT</a>`;
  const ed = parseEdition(html, { url: 'https://conteudos.xpi.com.br/economia/x/', title: 'Brasil Macro Mensal: X', published: '2026-09-03', published_label: '3 Set 2026' });
  eq(ed.summary.length, 1);
  eq(ed.sections.length, 2);
  eq(ed.sections[1].topic, 'Política Monetária');
  eq(ed.sections[1].thesis, 'Não vemos pausa no ciclo de corte de juros');
  eq(ed.editorial.length, 1);
  eq(ed.pdf.pt, 'https://conteudos.xpi.com.br/wp-content/uploads/2026/09/XP-Macro-Mensal-Set26.pdf');
  eq(ed.figures.find((f) => f.key === 'gdp').written, '1,7%');
});
await ta('a deposited edition is read back whole, and an unretrieved one is refused', async () => {
  const { cacheGet, cacheSet } = await import('../src/adapters/cache.js');
  await cacheSet(DEPOSIT_KEY, null, 1);
  let refused = null;
  try { await depositXp({ unavailable: true, reason: 'HTTP 403' }); } catch (e) { refused = e.message; }
  ok(refused && /never retrieved/.test(refused), 'an unretrieved edition was accepted');
  const report = {
    unavailable: false, url: 'https://conteudos.xpi.com.br/economia/x/', title: 'Brasil Macro Mensal: X',
    published: '2026-09-03', published_label: '3 Set 2026', summary: ['uma conclusão'],
    sections: [{ topic: 'Inflação', thesis: 'IPCA menor', paragraphs: ['p'] }], editorial: [], authors: [{ name: 'Caio Megale' }],
    figures: [{ key: 'selic', label: 'Selic', year: 2026, unit: 'rate', written: '13,25%', value: 0.1325, quote: 'Projetamos a taxa Selic em 13,25% no final de 2026.' }],
    projection_sentences: [], pdf: {}, previous: [], source: { id: 'src_1' }, attempts: [],
  };
  const held = await depositXp(report, { at: '2026-09-15T17:00:00.000Z' });
  eq(held.published, '2026-09-03');
  const back = await cacheGet(DEPOSIT_KEY, 3600);
  eq(back.edition.title, 'Brasil Macro Mensal: X');
  eq(back.edition.figures[0].written, '13,25%');
  eq(back.deposited_at, '2026-09-15T17:00:00.000Z');
  ok(!('source' in back.edition), 'the deposit kept a stale source record');
  // The fixture must not outlive the check: the deposit key is the one the
  // macro agent and the deposit job both read, and a test edition left in it
  // would be published as XP's house view.
  await cacheSet(DEPOSIT_KEY, null, 1);
  eq(await monthlyReport({ routes: ['deposited'] }).then((r) => r.unavailable), true);
});
t('a report that could not be read says so instead of going quiet', () => {
  const hv = xpHouseView({ unavailable: true, reason: 'HTTP 503' });
  eq(hv.available, false);
  ok(hv.reason.includes('503'));
  ok(hv.where.includes('conteudos.xpi.com.br'));
});
t('the house view names the provider and every projection carries its year', () => {
  const hv = xpHouseView({
    unavailable: false, title: 'Brasil Macro Mensal: X', published: '2026-09-03', published_label: '3 Set 2026',
    summary: ['uma conclusão'], sections: [{ topic: 'Inflação', thesis: 'IPCA menor' }], editorial: [], authors: [{ name: 'Caio Megale' }],
    figures: [{ key: 'selic', label: 'Selic', year: 2026, unit: 'rate', written: '13,25%', value: 0.1325, quote: 'Projetamos a taxa Selic em 13,25% no final de 2026.' }],
    projection_sentences: [], pdf: {}, source: { id: 'src_1' },
  });
  eq(hv.provider, XP_RESEARCH);
  ok(hv.provider.includes('XP'));
  for (const p of hv.projections) { ok(Number.isFinite(p.year), 'a projection without a year'); ok(p.quote, 'a projection without its sentence'); }
});

console.log('\n  The letter — one piece of writing, and a binary answer on policy');

const LETTER_FACTS = {
  date: '2026-09-08',
  client: { name: 'Albert da Silva', first_name: 'Albert', risk_profile: 'Moderado', base_currency: 'BRL' },
  advisor: { name: 'Antonio Bicudo' },
  reporting_period: { month: '2026-08', start: '2026-08-01', end: '2026-08-31' },
  performance: { monthly_return: -0.012, absolute_pnl: -4852, ending_market_value: 398161 },
  benchmark: { value: 0.0176, available: true },
  attribution: {
    worst_contributor: { name: 'Hapvida Participações e Investimentos S.A.', short_name: 'Hapvida', contribution: -0.0179 },
    best_contributor: { name: 'iShares S&P 500 FIC de Fundo de Índice', short_name: 'iShares S&P 500', contribution: 0.0047 },
    fx_contribution: 0.0016,
  },
  events: [{ title_pt: 'Petróleo dispara com interrupção de oferta' }],
  impact: [{ relevance: 'high', potential_impact_pt: 'Petróleo mais caro se transfere para a inflação a que a renda fixa está exposta' }],
  advisor_view: { headline: 'Juro alto por mais tempo no Brasil', stance_by_asset_class: { 'Equities BR': 'cautious' } },
  letter_recommendations: [
    { short_name: 'Riza Lotus Plus', within_policy: false, signal_conflict: false },
    { short_name: 'Hapvida', within_policy: true, signal_conflict: true },
  ],
  next_meeting: '2026-09-17',
  next_meeting_label: '17 de setembro de 2026',
  labels: {
    month: 'agosto de 2026', monthly_return: '−1,20%', benchmark: '+1,76%',
    excess: '−2,96 p.p.', excess_abs: '2,96 p.p.', absolute_pnl: '−R$ 4.852',
    ending_value: 'R$ 398.161', next_meeting: '17 de setembro de 2026',
  },
};

/** A canonical report of the shape the pipeline stores, for the render checks. */
const LETTER_REPORT = {
  locale: 'pt-BR',
  generated_at: '2026-09-08T12:19:04Z',
  client: { name: 'Albert da Silva', risk_profile: 'Moderado', base_currency: 'BRL' },
  advisor: { name: 'Antonio Bicudo', code: 'A7699', email: 'antonio.bicudo@xpi.com.br' },
  reporting_period: { month: '2026-08', start: '2026-08-01', end: '2026-08-31' },
  portfolio_performance: {
    monthly_return: -0.012, absolute_pnl: -4852, beginning_market_value: 403013, ending_market_value: 398161,
    net_flows: 0, method: 'modified_dietz', method_note: { pt: 'Método de Dietz modificado.' }, source_ids: ['src_stmt'],
  },
  performance_attribution: {
    top_positive: [
      { ticker: 'IVVB11', name: 'iShares S&P 500', contribution: 0.0047, total_return: 0.031 },
      { ticker: 'IVV', name: 'IVV', contribution: 0.0037 },
      { ticker: 'MBRF3', name: 'MBRF', contribution: 0.0027 },
    ],
    top_negative: [
      { ticker: 'HAPV3', name: 'Hapvida', contribution: -0.0179, total_return: -0.414 },
      { ticker: 'LREN3', name: 'Lojas Renner', contribution: -0.011 },
      { ticker: 'AZZA3', name: 'Azzas', contribution: -0.0007 },
    ],
    fx_contribution: 0.0016, reconciles: true,
  },
  benchmark: { name: 'Carteira de referência da política', value: 0.0176, comparison: { excess_return: -0.0296 } },
  letter: deterministicLetter(LETTER_FACTS),
  recommendations: [
    {
      asset_id: 'ast_riza', ticker: 'RIZA', name: 'Riza Lotus Plus Advisory FIC FIRF REF DI CP', asset_class: 'Fixed Income',
      final_action: 'REDUCE', suitability_result: 'REDUCE_REQUIRED', advisor_status: 'approved', current_weight: 0.14,
      within_policy: false, flags: [{ code: 'CONCENTRATION_BREACH', severity: 'high', breach: true }],
      rationale_pt: 'A posição representa 14,0% da carteira, acima do teto de 12% por emissor previsto na sua política.',
    },
    {
      asset_id: 'ast_hapv3', ticker: 'HAPV3', name: 'Hapvida', asset_class: 'Equities BR',
      final_action: 'DISCUSS', suitability_result: 'DO_NOT_ADD', advisor_status: 'approved', current_weight: 0.026,
      within_policy: false, signal_conflict: true, technical_signal: 'Sell', analyst_signal: 'Buy', analyst_count: 11,
      flags: [{ code: 'RISK_GRADE_ABOVE_PROFILE', severity: 'medium', breach: true }],
      rationale_pt: 'A leitura técnica aponta venda e o consenso de analistas aponta compra.',
    },
    {
      asset_id: 'ast_imab11', ticker: 'IMAB11', name: 'Tesouro IPCA', asset_class: 'Fixed Income',
      final_action: 'ADD', suitability_result: 'PASS', advisor_status: 'approved', current_weight: 0.073,
      within_policy: true, technical_signal: 'Strong Buy', flags: [],
      rationale_pt: 'Sinal técnico de compra forte e a classe ainda tem espaço dentro da faixa aprovada.',
    },
  ],
  approved_portfolio: {
    policy_version: 3,
    allocation: [
      { asset_class: 'Fixed Income', weight: 0.326, value: 129734, target: 0.40, range: { min: 0.30, max: 0.55 }, opening_weight: 0.3185 },
      { asset_class: 'Equities BR', weight: 0.283, value: 112636, target: 0.20, range: { min: 0.10, max: 0.30 }, opening_weight: 0.3067 },
      { asset_class: 'Equities Global', weight: 0.182, value: 72391, target: 0.15, range: { min: 0.05, max: 0.25 }, opening_weight: 0.1713 },
      { asset_class: 'Alternatives', weight: 0.134, value: 53400, target: 0.12, range: { min: 0.05, max: 0.20 }, opening_weight: 0.1291 },
      { asset_class: 'Cash', weight: 0.075, value: 30000, target: 0.05, range: { min: 0.02, max: 0.12 }, opening_weight: 0.0744 },
    ],
  },
  portfolio_impact: [],
  sources: [{ id: 'src_stmt', provider: 'XP position statement', kind: 'statement', as_of: '2026-08-31' }],
  disclosures: standardDisclosures('pt-BR'),
  data_quality: { warnings: [], unavailable: [] },
};

t('the deterministic letter is a letter: a title, a greeting and paragraphs that follow an arc', () => {
  const l = deterministicLetter(LETTER_FACTS);
  ok(l.title && l.title.length > 10, 'no title');
  ok(!/^carta|^relat/i.test(l.title), `the title is a label, not an idea: ${l.title}`);
  ok(l.paragraphs.length >= 4 && l.paragraphs.length <= 6, `${l.paragraphs.length} paragraphs`);
  eq(l.greeting, 'Prezado Albert,');
  const all = l.paragraphs.join(' ');
  ok(all.includes('Hapvida'), 'the largest detractor is never named');
  ok(all.indexOf('Hapvida') < all.indexOf('iShares'), 'the gain is described before the loss');
  ok(!all.includes('Participações e Investimentos S.A.'), 'the letter uses a custody statement name');
});

t('the house speaks in the plural and the advisor in the singular', () => {
  const all = deterministicLetter(LETTER_FACTS).paragraphs.join(' ');
  ok(all.includes('Na nossa leitura aqui na XP Asset Management'), 'the view is not attributed to the firm');
  ok(!/\bna minha leitura\b|\beu acho\b|\beu prefiro\b/i.test(all), 'a market view is written in the first person singular');
  ok(/\bquero conversar\b|\bLevo estes pontos\b|\bme chamar\b/.test(all), 'nothing is offered in the advisor\'s own voice');
});

t('a figure the facts never supplied is rejected, and the letter is asked for again', () => {
  const good = deterministicLetter(LETTER_FACTS);
  ok(sanitiseLetter(good, LETTER_FACTS).paragraphs.length >= 4, 'the deterministic letter fails its own check');
  // The invented figure has to sit inside the paragraphs that will be printed:
  // sanitiseLetter clips to six before it checks, so appending a seventh proves nothing.
  const invented = { ...good, paragraphs: ['A Hapvida caiu 41,4% e explicou 84% da diferença.', ...good.paragraphs.slice(1)] };
  let threw = null;
  try { sanitiseLetter(invented, LETTER_FACTS); } catch (e) { threw = e; }
  ok(threw, 'an invented figure reached the client');
  ok(threw.message.includes('41') && threw.message.includes('84'), threw.message);
  eq(strayNumbers('A carteira fez −1,20%, 2,96 p.p. abaixo da referência.', LETTER_FACTS).length, 0);
});

t('a letter of three paragraphs is not a letter', () => {
  let threw = null;
  try { sanitiseLetter({ title: 'x', greeting: 'Prezado Albert,', paragraphs: ['a', 'b', 'c'] }, LETTER_FACTS); } catch (e) { threw = e; }
  ok(threw && threw.message.includes('3 paragraphs'), 'a three-paragraph reply was accepted');
});

t('enquadramento has two values: a held grade-5 name is outside, a class on its ceiling is inside', () => {
  const policy = { risk_profile: 'Moderado', single_name_cap: 0.12, permitted_ranges: { 'Equities BR': { min: 0.10, max: 0.30 } } };
  // Albert's Hapvida: grade 5 against a ceiling of 4, and he holds it.
  const held = checkSuitability(
    { proposed_action: ACTIONS.HOLD, current_weight: 0.026 },
    { asset: { asset_class: 'Equities BR', risk_grade: 5, ticker: 'HAPV3' }, policy, exposures: { 'Equities BR': 0.283 }, classBand: policy.permitted_ranges['Equities BR'] },
  );
  eq(held.suitability_result, SUITABILITY.DO_NOT_ADD);
  eq(withinPolicy(held), false, 'a holding above the profile grade ceiling reported as within policy');
  eq(policyFitLabel(held), 'Fora da política');

  // A class sitting exactly on its ceiling: adding would breach, the holding does not.
  const atMax = checkSuitability(
    { proposed_action: ACTIONS.ADD, current_weight: 0.05 },
    { asset: { asset_class: 'Equities BR', risk_grade: 4, ticker: 'BOVA11' }, policy, exposures: { 'Equities BR': 0.30 }, classBand: policy.permitted_ranges['Equities BR'] },
  );
  eq(atMax.suitability_result, SUITABILITY.DO_NOT_ADD, 'the guardrail let an add through at the ceiling');
  eq(withinPolicy(atMax), true, '"adding would breach" was reported to the client as a breach');
  eq(policyFitLabel(atMax), 'Dentro da política');

  // Over the issuer cap: a real breach, and the guardrail forces a reduction.
  const over = checkSuitability(
    { proposed_action: ACTIONS.HOLD, current_weight: 0.14 },
    { asset: { asset_class: 'Fixed Income', risk_grade: 3, ticker: 'RIZA' }, policy, exposures: { 'Fixed Income': 0.326 } },
  );
  eq(over.suitability_result, SUITABILITY.REDUCE_REQUIRED);
  eq(withinPolicy(over), false);
  eq(over.final_action, ACTIONS.REDUCE);
});

t('the client reads three verbs, and every engine action maps onto one of them', () => {
  const seen = new Set(Object.values(ACTIONS).map((a) => ACTION_PT[a]));
  eq([...seen].sort().join(', '), 'Aumentar, Manter, Reduzir');
});

t('a row outside the policy explains the rule it breaks, not the market view', () => {
  // Three verbs mean a breached position can still read "Manter" — held, not
  // increased, which is what the guardrail decided. That makes the line beneath
  // it the only place the client learns why the row says "Fora da política",
  // and it was spending that line on analysts disagreeing.
  const rec = {
    asset_id: 'ast_hapv3', ticker: 'HAPV3', name: 'Hapvida', asset_class: 'Equities BR',
    final_action: 'DISCUSS', current_weight: 0.026, advisor_status: 'approved',
    suitability_result: 'DO_NOT_ADD', signal_conflict: true,
    rationale_pt: 'A leitura técnica aponta venda e o consenso de analistas aponta compra.',
    flags: [{ code: 'RISK_GRADE_ABOVE_PROFILE', breach: true, message_pt: 'O grau de risco 5 deste ativo está acima do máximo de 4 previsto para o perfil Moderado.' }],
  };
  const breached = buildLetterModel({ ...LETTER_REPORT, recommendations: [rec] }, { locale: 'pt-BR' }).recommendations[0];
  eq(breached.within_policy, false);
  eq(breached.action_label, 'Manter');
  ok(breached.rationale.includes('grau de risco'), 'the breached row does not say which rule it breaks');
  ok(!breached.rationale.includes('analistas'), 'the market view crowded out the policy rule');

  // Nothing breached, nothing to explain: the market view is the better read.
  const clean = { ...rec, suitability_result: 'PASS', flags: [] };
  const ok2 = buildLetterModel({ ...LETTER_REPORT, recommendations: [clean] }, { locale: 'pt-BR' }).recommendations[0];
  eq(ok2.within_policy, true);
  ok(ok2.rationale.includes('analistas'), 'a compliant row lost its market rationale');
});

t('a view the firm never formed never reaches the client as the firm\'s view', () => {
  // The deterministic World Overview sets every stance to neutral and says so.
  eq(houseView({ headline_pt: 'Brent rompeu US$ 90', summary_pt: '4 limiares rompidos.', mode: 'deterministic_template', generated_without_model: true, stance_by_asset_class: {} }), null);
  const formed = houseView({ headline_pt: 'Juro alto por mais tempo', summary_pt: 'O Copom manteve o tom duro.', mode: 'model', briefing: { main_risk_or_opportunity_pt: 'O risco é o fiscal.' }, stance_by_asset_class: { 'Equities BR': 'cautious' } });
  eq(formed.main_risk, 'O risco é o fiscal.');
  // An advisor who wrote a commentary has formed a view, model or no model.
  const byHand = houseView({ advisor_commentary: 'Sigo cauteloso com bolsa local.', mode: 'deterministic_template', generated_without_model: true, stance_by_asset_class: { 'Equities BR': 'cautious' } });
  eq(byHand.commentary, 'Sigo cauteloso com bolsa local.');
  eq(byHand.summary, null, 'a template summary was passed off as the house view');
});

t('a contributors chart with no room for every bar still shows the losses', () => {
  const model = buildLetterModel(LETTER_REPORT, { locale: 'pt-BR' });
  const all = model.charts.contributors.items;
  eq(all.length, 6);
  const four = contributorBars(model, 4).map((i) => i.label);
  // Taking the first four of a list sorted by contribution keeps the winners.
  ok(four.includes('HAPV3'), `the largest detractor was dropped: ${four.join(', ')}`);
  ok(four.includes('LREN3'), `the second detractor was dropped: ${four.join(', ')}`);
  // And the survivors are still drawn best to worst.
  const order = contributorBars(model, 4).map((i) => i.value);
  eq(order.slice().sort((a, b) => b - a).join(), order.join(), 'the bars lost their order');
  eq(contributorBars(model, 6).length, 6, 'trimming ran when there was room for every bar');
});

await ta('the pdf is a letter on page one and the annex on page two', async () => {
  const model = buildLetterModel(LETTER_REPORT, { locale: 'pt-BR' });
  const doc = await renderLetterPdf(model, { fonts: brandFonts(), maxPages: 2 });
  eq(doc.pageCount, 2, 'the letter is not two pages');
  const bytes = doc.build();
  ok(bytes.length > 4000, 'the pdf is suspiciously small');
  ok(model.letter.paragraphs.length >= 4, 'the model lost the paragraphs');
  eq(model.recommendations[0].suitability_label, 'Fora da política');
  ok(model.dateline.place_date.startsWith('São Paulo,'), model.dateline.place_date);
});

console.log('\n  The permitted range, as a bar');
t('every band lands on the same two points, so the column reads as one scale', () => {
  const g = (min, max, weight) => rangeBarGeometry({ min, max, weight }, { width: 200, padLabel: 26 });
  const a = g(0.30, 0.55, 0.326);
  const b = g(0.02, 0.12, 0.075);
  close(a.bandX0, b.bandX0, 0.01);
  close(a.bandX1, b.bandX1, 0.01);
  // and the mark sits where the weight sits inside it
  const midBand = g(0.30, 0.55, 0.425);
  close(midBand.markX, (midBand.bandX0 + midBand.bandX1) / 2, 0.01);
  ok(g(0.30, 0.55, 0.30).markX <= g(0.30, 0.55, 0.31).markX, 'the mark runs backwards');
});

t('a class that has drifted out of its band is drawn outside it, not clamped onto the edge', () => {
  const over = rangeBarGeometry({ min: 0.30, max: 0.55, weight: 0.70 }, { width: 200, padLabel: 26 });
  eq(over.inside, false);
  ok(over.markX > over.bandX1, 'a weight above the ceiling was drawn inside the band');
  const under = rangeBarGeometry({ min: 0.30, max: 0.55, weight: 0.10 }, { width: 200, padLabel: 26 });
  eq(under.inside, false);
  ok(under.markX < under.bandX0, 'a weight below the floor was drawn inside the band');
  // The mark never leaves the bar: a class at four times its ceiling still has to
  // be somewhere a reader can see.
  for (const w of [0, 0.4, 1]) {
    const g = rangeBarGeometry({ min: 0.02, max: 0.12, weight: w }, { width: 200, padLabel: 26 });
    ok(g.markX >= 0 && g.markX <= 200, `a weight of ${w} fell off the bar at ${g.markX}`);
  }
});

t('a band with no width is a point, not a division by zero', () => {
  const g = rangeBarGeometry({ min: 0.10, max: 0.10, weight: 0.10 }, { width: 200, padLabel: 26 });
  ok(Number.isFinite(g.bandX0) && Number.isFinite(g.markX), 'the geometry went to NaN');
  eq(g.inside, true);
});

console.log('\n  The positioning chart — the policy decides the step, not an opinion');
t('the five steps are read off the client\'s own band, and its two halves separately', () => {
  const band = { min: 0.05, max: 0.20 };
  eq(stanceStep(0.10, 0.10, band), 0, 'at target');
  eq(stanceStep(0.25, 0.10, band), 2, 'above the band');
  eq(stanceStep(0.03, 0.10, band), -2, 'below the band');
  // The caption under the chart tells the client that −− and ++ mean outside
  // the permitted range, and the annex table calls a class on its own limit
  // compliant. Both ends of the scale are therefore read off the band itself:
  // on the limit is the last step inside, not the first step outside. Scored by
  // ratio alone the two pages disagreed here — the chart put a class at its
  // ceiling outside the band while the table printed its weight as inside.
  eq(stanceStep(0.20, 0.10, band), 1, 'on the ceiling is the top of the band, not past it');
  eq(stanceStep(0.05, 0.10, band), -1, 'on the floor is the bottom of the band, not under it');
  eq(stanceStep(0.2001, 0.10, band), 2, 'a hair over the ceiling is outside');
  // A class the policy asks for and the client holds none of. There is no
  // position to look at, only an absence, and it still has to reach the end of
  // the scale.
  eq(stanceStep(0, 0.05, { min: 0.03, max: 0.12 }), -2, 'nothing held against a floor');
  eq(stanceStep(0, 0.03, { min: 0, max: 0.08 }), -1, 'nothing held, and none required');
  // The band is asymmetric: 10 points of room above, 5 below. The same 2-point
  // drift must not read neutral going up and overweight going down.
  eq(stanceStep(0.12, 0.10, band), 0, '2 points into 10 of room is still neutral');
  eq(stanceStep(0.08, 0.10, band), -1, '2 points into 5 of room is underweight');
  eq(stanceStep(0.10, null, null), 0, 'no policy, no position to be over or under');
});

t('the chart and the annex table cannot disagree: a class outside its band is at the end of the scale', () => {
  const model = buildLetterModel(LETTER_REPORT, { locale: 'pt-BR' });
  eq(model.stance.length, model.allocation.length, 'a class the table lists is missing from the chart');
  for (const [i, row] of model.stance.entries()) {
    const a = model.allocation[i];
    eq(row.label, a.asset_class);
    if (!a.inside_band) ok(Math.abs(row.step) === 2, `${a.asset_class} is outside its band but not at the end of the scale`);
    if (Math.abs(row.step) < 2) ok(a.inside_band, `${a.asset_class} is mid-scale but outside its band`);
  }
  eq(model.stance.find((r) => r.label === 'Renda variável Brasil').change, 'down', 'the class that fell reads as unchanged');
  // Nine hundredths of a point is the portfolio breathing, not a decision.
  eq(model.stance.find((r) => r.label === 'Caixa').change, 'flat');
});

t('a class the policy asks for and the client holds none of still gets a row', () => {
  // Albert's own case. The Moderado policy asks for 5% in listed real estate
  // with a 3% floor; he holds none of it. Read off the holdings, the class had
  // no row, so the floor could not be breached on paper, the chart had nothing
  // to draw, and the ALVO column quietly added up to 92%.
  const policy = {
    target_allocation: { Cash: 0.05, 'Fixed Income': 0.40, 'Equities BR': 0.20, 'Equities Global': 0.15, Alternatives: 0.12, 'Real Estate': 0.05, Commodities: 0.03, 'Digital Assets': 0 },
    permitted_ranges: {
      Cash: { min: 0.02, max: 0.12 }, 'Fixed Income': { min: 0.30, max: 0.55 },
      'Equities BR': { min: 0.10, max: 0.30 }, 'Equities Global': { min: 0.05, max: 0.25 },
      Alternatives: { min: 0.05, max: 0.20 }, 'Real Estate': { min: 0.03, max: 0.12 },
      Commodities: { min: 0, max: 0.08 }, 'Digital Assets': { min: 0, max: 0.02 },
    },
  };
  const exposures = { Cash: 0.075, 'Fixed Income': 0.326, 'Equities BR': 0.283, 'Equities Global': 0.182, Alternatives: 0.134 };
  const rows = allocationRows({ exposures, policy, totalValue: 397984 });

  const re = rows.find((r) => r.asset_class === 'Real Estate');
  ok(re, 'the class the policy asks for is missing from the table');
  eq(re.weight, 0);
  eq(re.value, 0);
  eq(stanceStep(re.weight, re.target, re.range), -2, 'a class under its floor sits at the end of the scale');

  // Targeted at zero with no floor: a 0% row against a 0% target says nothing,
  // and its absence is what keeps the column adding to 100.
  ok(!rows.some((r) => r.asset_class === 'Digital Assets'), 'a class nobody asked for and nobody holds');
  eq(Math.round(rows.reduce((a, r) => a + (r.target ?? 0), 0) * 100), 100, 'the ALVO column must add to 100%');

  // The heaviest class still leads, and the empty ones fall to the end.
  eq(rows[0].asset_class, 'Fixed Income');
  eq(rows.at(-1).weight, 0);
});

t('a first letter shows position without claiming a movement it cannot see', () => {
  const noOpen = { ...LETTER_REPORT, approved_portfolio: { ...LETTER_REPORT.approved_portfolio,
    allocation: LETTER_REPORT.approved_portfolio.allocation.map(({ opening_weight, ...a }) => a) } };
  const model = buildLetterModel(noOpen, { locale: 'pt-BR' });
  ok(model.stance.every((r) => r.change === null), 'a direction was drawn with nothing to compare against');
  ok(model.stance.every((r) => Number.isInteger(r.step)), 'the position went missing with the direction');
});

await ta('the chart holds its place on page one, and gives it up before a paragraph does', async () => {
  const model = buildLetterModel(LETTER_REPORT, { locale: 'pt-BR' });
  const doc = await renderLetterPdf(model, { fonts: brandFonts(), maxPages: 2 });
  eq(doc.pageCount, 2, 'the chart pushed the letter onto a third page');
  ok(!doc.overflow, 'the letter overflowed');

  // Six paragraphs of the longest thing the model is allowed to write, which is
  // more than the sanitiser lets through, so the chart has to climb the ladder.
  const long = 'Uma frase longa que o modelo poderia escrever se ninguém o contivesse, repetida para forçar o limite de duas páginas. '.repeat(4);
  const heavy = buildLetterModel({ ...LETTER_REPORT,
    letter: { ...LETTER_REPORT.letter, paragraphs: Array.from({ length: 6 }, () => long) } }, { locale: 'pt-BR' });
  const doc2 = await renderLetterPdf(heavy, { fonts: brandFonts(), maxPages: 2 });
  eq(doc2.pageCount, 2, 'a long letter with the chart spilled onto a third page');
  ok(!doc2.overflow, 'a long letter with the chart overflowed');
  ok(doc2.letterTypeLevel > 0, 'the ladder never tightened for a letter this long');
  eq(heavy.letter.paragraphs.length, 6, 'a paragraph the advisor wrote was dropped for the chart');
});

console.log('\n  The Rivet canvas — a node nobody wired is a stage nobody runs');
await ta('every node on the canvas is connected, and no output hangs with nothing feeding it', async () => {
  // The validation gates of stages 02 and 08 were created, connected and then
  // never added to their graph — one word wrong in a push. Rivet drops the
  // connections of a node it does not have, so both stages shipped with their
  // outputs dangling and the gate that stops a bad figure simply absent. It
  // looked like a layout problem on the canvas, which is why nobody caught it.
  const { loadProjectFromString } = await import('@ironclad/rivet-node');
  const { readFile } = await import('node:fs/promises');
  const project = await loadProjectFromString(await readFile('rivet/enter_wealth_advisor.rivet-project', 'utf8'));
  const graphs = Object.values(project.graphs);
  ok(graphs.length >= 11, `${graphs.length} graphs`);

  const loose = [];
  for (const g of graphs) {
    const into = new Set(g.connections.map((c) => c.inputNodeId));
    const outOf = new Set(g.connections.map((c) => c.outputNodeId));
    for (const n of g.nodes) {
      if (n.type === 'comment') continue;
      // `gate` is wired by the orchestrator, not inside the stage it sequences.
      if (n.type === 'graphInput' && n.data?.id === 'gate') continue;
      const wired = n.type === 'graphOutput' ? into.has(n.id)
        : n.type === 'graphInput' ? outOf.has(n.id)
          : into.has(n.id) || outOf.has(n.id);
      if (!wired) loose.push(`${g.metadata.name} → ${n.type} "${n.title}"`);
    }
  }
  eq(loose.length, 0, `unwired: ${loose.join('; ')}`);
});

await ta('every stage output the orchestrator declares is read somewhere', async () => {
  // Six boolean outputs — blocked, reconciles, signal_conflicts, needs_review,
  // ready, within_two_pages — were computed by a "validation gate" in each
  // stage, published on a port, and read by nothing. A gate whose verdict
  // nobody reads is a comment. The hard ones throw inside their stage now and
  // the advisory ones reach `00`; this is what stops the next one being added
  // back as decoration.
  const { loadProjectFromString } = await import('@ironclad/rivet-node');
  const { readFile } = await import('node:fs/promises');
  const project = await loadProjectFromString(await readFile('rivet/enter_wealth_advisor.rivet-project', 'utf8'));
  const graphs = Object.values(project.graphs);
  const main = graphs.find((g) => g.metadata.name.startsWith('00'));
  ok(main, 'no orchestrator graph');

  const byId = new Map(graphs.map((g) => [g.metadata.id, g]));
  const read = new Set(main.connections.map((c) => `${c.outputNodeId}:${c.outputId}`));
  const unread = [];
  for (const node of main.nodes) {
    if (node.type !== 'subGraph') continue;
    const stage = byId.get(node.data.graphId);
    if (!stage) continue;
    for (const o of stage.nodes.filter((x) => x.type === 'graphOutput')) {
      if (!read.has(`${node.id}:${o.data.id}`)) unread.push(`${stage.metadata.name} → ${o.data.id}`);
    }
  }
  eq(unread.length, 0, `outputs nothing reads: ${unread.join('; ')}`);
});

await ta('no two nodes are drawn on top of each other', async () => {
  // Approximate heights, measured from the Rivet canvas: the file does not
  // carry them because Rivet sizes a node by its content. Rounded down, so a
  // failure here is a real collision rather than a rounding argument.
  const H = { graphInput: 82, graphOutput: 82, ifElse: 110, extractJson: 120, subGraph: 130, object: 150, text: 150, httpCall: 210, prompt: 220, chat: 220, code: 260 };
  const { loadProjectFromString } = await import('@ironclad/rivet-node');
  const { readFile } = await import('node:fs/promises');
  const project = await loadProjectFromString(await readFile('rivet/enter_wealth_advisor.rivet-project', 'utf8'));
  const hits = [];
  for (const g of Object.values(project.graphs)) {
    const boxes = g.nodes.filter((n) => n.type !== 'comment').map((n) => ({
      t: n.title, x: n.visualData.x, y: n.visualData.y,
      w: n.visualData.width ?? 300, h: H[n.type] ?? 160,
    }));
    // Every comparison against NaN is false, so a graph laid out at y = NaN —
    // which is what one empty column in the layout produced — passed this test
    // with all twenty-two of its nodes stacked on the same point.
    for (const b of boxes) {
      if (!Number.isFinite(b.x) || !Number.isFinite(b.y)) hits.push(`${g.metadata.name}: "${b.t}" has no position`);
    }
    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) {
        const a = boxes[i]; const b = boxes[j];
        const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
        const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
        if (ox > 1 && oy > 1) hits.push(`${g.metadata.name}: "${a.t}" × "${b.t}"`);
      }
    }
  }
  eq(hits.length, 0, `${hits.length} overlapping: ${hits.slice(0, 3).join('; ')}`);
});

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
