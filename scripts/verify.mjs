/**
 * Checks the invariants this product depends on.
 *
 *   npm run verify              engine checks only
 *   npm run verify -- --live    also checks a running API and the provider chain
 *
 * These are the properties that, if they broke, would put a wrong number in front
 * of a client. They are asserted rather than assumed.
 */
import { monthlyProfitability, modifiedDietz, timeWeightedReturn, historicalMetrics } from '../src/core/performance.js';
import { proposeForAsset, bandPosition, ACTIONS } from '../src/core/recommendations.js';
import { checkSuitability, SUITABILITY } from '../src/core/suitability.js';
import { evaluateTrigger, driftTriggers, triggerProximity, TRIGGER_STATUS } from '../src/core/triggers.js';
import { validateReport, emptyReport, standardDisclosures } from '../src/core/report-schema.js';
import { money, percent, pp, previousMonth, monthBounds, MINUS } from '../src/core/format.js';
import { TrueTypeFont } from '../src/render/pdf/ttf.js';
import { brandFonts } from '../src/render/fonts/index.js';
import { PdfDocument } from '../src/render/pdf/writer.js';
import { pearson, logReturns, correlationMatrix } from '../src/core/correlation.js';
import { parseRss, clusterHeadlines, sourceFor, PROVIDER as VALOR } from '../src/adapters/valor.js';
import { buildWhatMattersTable } from '../src/core/events.js';

let pass = 0; let fail = 0;
const t = (name, fn) => {
  try { fn(); pass += 1; console.log(`  ✓ ${name}`); }
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
    const login = await (await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'antonio.bicudo@enteram.com.br', password: 'enter2026' }) })).json();
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
  await tAsync('a client cannot read another client', async () => {
    const login = await (await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'albert.dasilva@exemplo.com.br', password: 'albert2026' }) })).json();
    const res = await fetch(`${BASE}/api/clients/cli_beatriz`, { headers: { authorization: `Bearer ${login.token}` } });
    eq(res.status, 403);
  });
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
