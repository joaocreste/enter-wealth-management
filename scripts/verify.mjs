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
import { evaluateTrigger, driftTriggers, TRIGGER_STATUS } from '../src/core/triggers.js';
import { validateReport, emptyReport, standardDisclosures } from '../src/core/report-schema.js';
import { money, percent, pp, previousMonth, monthBounds, MINUS } from '../src/core/format.js';
import { TrueTypeFont } from '../src/render/pdf/ttf.js';
import { brandFonts } from '../src/render/fonts/index.js';
import { PdfDocument } from '../src/render/pdf/writer.js';

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
