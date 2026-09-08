/**
 * Demo dataset for the MVP (§28).
 *
 * What is real and what is not — stated once, here, and carried into the UI:
 *
 *  REAL, retrieved live at run time
 *    · every listed price (Yahoo Finance / TradingView)
 *    · CDI, Selic, IPCA and the PTAX dollar (Banco Central do Brasil)
 *    · every TradingView technical rating and analyst consensus
 *    · the benchmark composite, computed from the above
 *
 *  REAL, taken from the case files in Input/
 *    · Albert da Silva's identity, advisor, risk profile and the May 2025
 *      position statement that snapshot v1 reproduces line for line
 *    · XP's February 2025 macro projections
 *
 *  SIMULATED, and flagged `simulated: true` wherever it surfaces
 *    · monthly quota values for Brazilian funds, which have no public feed
 *    · the return history before the platform existed
 *    · the four demo clients other than Albert
 *
 * Nothing simulated is ever presented as retrieved market data.
 */

/** Deterministic PRNG so the demo dataset is byte-identical on every machine. */
function mulberry32(seed) {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gauss(rnd) {
  const u = Math.max(1e-9, rnd()), v = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const REFERENCE_DATE = '2026-09-07';

// ─── assets ────────────────────────────────────────────────────────────────
export const ASSETS = [
  // Brazilian equities — Albert's original book, carried through the corporate actions
  { id: 'ast_lren3', ticker: 'LREN3', isin: 'BRLRENACNOR1', name: 'Lojas Renner S.A.', type: 'stock', asset_class: 'Equities BR', sector: 'Consumer discretionary', currency: 'BRL', yahoo_symbol: 'LREN3.SA', tv_symbol: 'BMFBOVESPA:LREN3', pricing_mode: 'market', liquidity_days: 2, risk_grade: 4, portfolio_role: 'Domestic equity — single name' },
  { id: 'ast_mbrf3', ticker: 'MBRF3', isin: 'BRMBRFACNOR6', name: 'MBRF Global Foods Company S.A.', type: 'stock', asset_class: 'Equities BR', sector: 'Food', currency: 'BRL', yahoo_symbol: 'MBRF3.SA', tv_symbol: 'BMFBOVESPA:MBRF3', pricing_mode: 'market', liquidity_days: 2, risk_grade: 4, portfolio_role: 'Domestic equity — single name', corporate_action_note: 'Received in exchange for MRFG3 (Marfrig) in the Marfrig–BRF combination. Cost basis carried over from the original MRFG3 purchase.' },
  { id: 'ast_azza3', ticker: 'AZZA3', isin: 'BRAZZAACNOR7', name: 'Azzas 2154 S.A.', type: 'stock', asset_class: 'Equities BR', sector: 'Consumer discretionary', currency: 'BRL', yahoo_symbol: 'AZZA3.SA', tv_symbol: 'BMFBOVESPA:AZZA3', pricing_mode: 'market', liquidity_days: 2, risk_grade: 4, portfolio_role: 'Domestic equity — single name', corporate_action_note: 'Received in exchange for ARZZ3 (Arezzo) in the Arezzo–Soma combination. Cost basis carried over from the original ARZZ3 purchase.' },
  { id: 'ast_hapv3', ticker: 'HAPV3', isin: 'BRHAPVACNOR6', name: 'Hapvida Participações e Investimentos S.A.', type: 'stock', asset_class: 'Equities BR', sector: 'Healthcare', currency: 'BRL', yahoo_symbol: 'HAPV3.SA', tv_symbol: 'BMFBOVESPA:HAPV3', pricing_mode: 'market', liquidity_days: 2, risk_grade: 5, portfolio_role: 'Domestic equity — single name' },
  { id: 'ast_arzz3_legacy', ticker: 'ARZZ3', isin: 'BRARZZACNOR3', name: 'Arezzo Indústria e Comércio S.A. (legacy line)', type: 'stock', asset_class: 'Equities BR', sector: 'Consumer discretionary', currency: 'BRL', yahoo_symbol: 'ARZZ3.SA', tv_symbol: 'BMFBOVESPA:ARZZ3', pricing_mode: 'market', liquidity_days: 2, risk_grade: 4, corporate_action: 'Delisted after the Arezzo–Soma combination. No provider publishes a price for this ticker.', successor_asset_id: 'ast_azza3' },
  { id: 'ast_mrfg3_legacy', ticker: 'MRFG3', isin: 'BRMRFGACNOR0', name: 'Marfrig Global Foods S.A. (legacy line)', type: 'stock', asset_class: 'Equities BR', sector: 'Food', currency: 'BRL', yahoo_symbol: 'MRFG3.SA', tv_symbol: 'BMFBOVESPA:MRFG3', pricing_mode: 'market', liquidity_days: 2, risk_grade: 4, corporate_action: 'Superseded by MBRF3 after the Marfrig–BRF combination.', successor_asset_id: 'ast_mbrf3' },

  // Listed funds / ETFs
  { id: 'ast_bova11', concentration_exempt: true, ticker: 'BOVA11', isin: 'BRBOVACTF003', name: 'iShares Ibovespa Fundo de Índice', type: 'etf', asset_class: 'Equities BR', currency: 'BRL', yahoo_symbol: 'BOVA11.SA', tv_symbol: 'BMFBOVESPA:BOVA11', pricing_mode: 'market', liquidity_days: 2, risk_grade: 4, portfolio_role: 'Core domestic equity' },
  { id: 'ast_smal11', concentration_exempt: true, ticker: 'SMAL11', isin: 'BRSMALCTF001', name: 'iShares BM&FBOVESPA Small Cap Index Fund', type: 'etf', asset_class: 'Equities BR', currency: 'BRL', yahoo_symbol: 'SMAL11.SA', tv_symbol: 'BMFBOVESPA:SMAL11', pricing_mode: 'market', liquidity_days: 2, risk_grade: 5, portfolio_role: 'Domestic small-cap satellite' },
  { id: 'ast_ivvb11', concentration_exempt: true, ticker: 'IVVB11', isin: 'BRIVVBCTF005', name: 'iShares S&P 500 FIC de Fundo de Índice — Investimento no Exterior', type: 'etf', asset_class: 'Equities Global', currency: 'BRL', yahoo_symbol: 'IVVB11.SA', tv_symbol: 'BMFBOVESPA:IVVB11', pricing_mode: 'market', liquidity_days: 2, risk_grade: 4, portfolio_role: 'Core global equity, BRL-quoted' },
  { id: 'ast_ivv', concentration_exempt: true, ticker: 'IVV', isin: 'US4642872000', name: 'iShares Core S&P 500 ETF', type: 'etf', asset_class: 'Equities Global', currency: 'USD', yahoo_symbol: 'IVV', tv_symbol: 'AMEX:IVV', pricing_mode: 'market', liquidity_days: 3, risk_grade: 4, portfolio_role: 'Offshore core equity — unhedged USD' },
  { id: 'ast_acwi', concentration_exempt: true, ticker: 'ACWI', isin: 'US4642882579', name: 'iShares MSCI ACWI ETF', type: 'etf', asset_class: 'Equities Global', currency: 'USD', yahoo_symbol: 'ACWI', tv_symbol: 'NASDAQ:ACWI', pricing_mode: 'market', liquidity_days: 3, risk_grade: 4, portfolio_role: 'Global equity diversifier' },
  { id: 'ast_imab11', concentration_exempt: true, ticker: 'IMAB11', isin: 'BRIMABCTF008', name: 'It Now IMA-B Fundo de Índice', type: 'etf', asset_class: 'Fixed Income', currency: 'BRL', yahoo_symbol: 'IMAB11.SA', tv_symbol: 'BMFBOVESPA:IMAB11', pricing_mode: 'market', liquidity_days: 2, risk_grade: 3, portfolio_role: 'Inflation-linked sovereign' },
  { id: 'ast_b5p211', concentration_exempt: true, ticker: 'B5P211', isin: 'BRB5P2CTF000', name: 'It Now IMA-B 5 Fundo de Índice', type: 'etf', asset_class: 'Fixed Income', currency: 'BRL', yahoo_symbol: 'B5P211.SA', tv_symbol: 'BMFBOVESPA:B5P211', pricing_mode: 'market', liquidity_days: 2, risk_grade: 2, portfolio_role: 'Short inflation-linked sovereign' },
  { id: 'ast_hglg11', ticker: 'HGLG11', isin: 'BRHGLGCTF006', name: 'CSHG Logística FII', type: 'reit', asset_class: 'Real Estate', currency: 'BRL', yahoo_symbol: 'HGLG11.SA', tv_symbol: 'BMFBOVESPA:HGLG11', pricing_mode: 'market', liquidity_days: 2, risk_grade: 4, portfolio_role: 'Listed real estate income' },
  { id: 'ast_xpml11', ticker: 'XPML11', isin: 'BRXPMLCTF008', name: 'XP Malls FII', type: 'reit', asset_class: 'Real Estate', currency: 'BRL', yahoo_symbol: 'XPML11.SA', tv_symbol: 'BMFBOVESPA:XPML11', pricing_mode: 'market', liquidity_days: 2, risk_grade: 4, portfolio_role: 'Listed real estate income' },
  { id: 'ast_gold', concentration_exempt: true, ticker: 'GOLD11', isin: 'BRGOLDCTF002', name: 'Trend Ouro Fundo de Índice', type: 'etf', asset_class: 'Commodities', currency: 'BRL', yahoo_symbol: 'GOLD11.SA', tv_symbol: 'BMFBOVESPA:GOLD11', pricing_mode: 'market', liquidity_days: 2, risk_grade: 4, portfolio_role: 'Gold — portfolio insurance' },
  { id: 'ast_btc', ticker: 'BTC', isin: null, name: 'Bitcoin', type: 'crypto', asset_class: 'Digital Assets', currency: 'USD', yahoo_symbol: 'BTC-USD', tv_symbol: 'CRYPTO:BTCUSD', coingecko_id: 'bitcoin', pricing_mode: 'market', liquidity_days: 1, risk_grade: 5, portfolio_role: 'Digital asset satellite' },
  { id: 'ast_nvda', ticker: 'NVDA', isin: 'US67066G1040', name: 'NVIDIA Corporation', type: 'stock', asset_class: 'Equities Global', sector: 'Semiconductors', currency: 'USD', yahoo_symbol: 'NVDA', tv_symbol: 'NASDAQ:NVDA', pricing_mode: 'market', liquidity_days: 3, risk_grade: 5, portfolio_role: 'Global equity — single name' },

  // Brazilian funds: no public price feed; valued from the custodian statement
  { id: 'ast_riza', ticker: null, isin: 'BRRIZAFIC001', name: 'Riza Lotus Plus Advisory FIC FIRF REF DI CP', type: 'fund', asset_class: 'Fixed Income', issuer: 'Riza Asset', currency: 'BRL', pricing_mode: 'nav', liquidity_days: 31, risk_grade: 3, portfolio_role: 'Credit-linked cash management' },
  { id: 'ast_brave', ticker: null, isin: 'BRBRAVFIC004', name: 'Brave I FIC FIM CP', type: 'fund', asset_class: 'Alternatives', issuer: 'Brave Asset', currency: 'BRL', pricing_mode: 'nav', liquidity_days: 45, risk_grade: 4, portfolio_role: 'Multi-strategy' },
  { id: 'ast_truxt', ticker: null, isin: 'BRTRUXFIC002', name: 'Truxt Long Bias Advisory FIC FIM', type: 'fund', asset_class: 'Alternatives', issuer: 'Truxt Investimentos', currency: 'BRL', pricing_mode: 'nav', liquidity_days: 32, risk_grade: 4, portfolio_role: 'Long-bias equity' },
  { id: 'ast_ibiuna', ticker: null, isin: 'BRIBIUFIC003', name: 'Ibiuna Hedge ST Advisory FIC FIM', type: 'fund', asset_class: 'Alternatives', issuer: 'Ibiuna Investimentos', currency: 'BRL', pricing_mode: 'nav', liquidity_days: 5, risk_grade: 4, portfolio_role: 'Macro hedge' },
  { id: 'ast_stk', ticker: null, isin: 'BRSTKLFIC005', name: 'STK Long Biased FIC FIA', type: 'fund', asset_class: 'Alternatives', issuer: 'STK Capital', currency: 'BRL', pricing_mode: 'nav', liquidity_days: 32, risk_grade: 5, portfolio_role: 'Long-biased equity' },
  { id: 'ast_constellation', ticker: null, isin: 'BRCONSFIC009', name: 'Constellation Institucional Advisory FIC FIA', type: 'fund', asset_class: 'Equities BR', issuer: 'Constellation', currency: 'BRL', pricing_mode: 'nav', liquidity_days: 32, risk_grade: 5, portfolio_role: 'Active domestic equity' },
  { id: 'ast_trend_ib', ticker: null, isin: 'BRTRENFIC007', name: 'Trend Investback FIC FIRF Simples', type: 'fund', asset_class: 'Fixed Income', issuer: 'XP Asset', currency: 'BRL', pricing_mode: 'nav', liquidity_days: 1, risk_grade: 2, portfolio_role: 'Liquidity sleeve' },

  // Contractual instruments — accrued from an official index plus the contract spread
  { id: 'ast_cdb_daycoval', ticker: null, isin: 'BRCDBDAY028', name: 'CDB Banco Daycoval S.A. — IPCA + 6,10% a.a., venc. 15/03/2028', type: 'cdb', asset_class: 'Fixed Income', issuer: 'Banco Daycoval S.A.', currency: 'BRL', pricing_mode: 'accrual', accrual_terms: { index: 'IPCA', spread_pa: 0.0610 }, liquidity_days: 560, risk_grade: 2, credit_rating: 'AA-', portfolio_role: 'Held-to-maturity inflation-linked credit' },
  { id: 'ast_cdb_c6', ticker: null, isin: 'BRCDBC6S024', name: 'CDB Banco C6 Consignado S.A. — IPCA + 5,45% a.a., venc. 05/09/2024', type: 'cdb', asset_class: 'Fixed Income', issuer: 'Banco C6 Consignado S.A.', currency: 'BRL', pricing_mode: 'accrual', accrual_terms: { index: 'IPCA', spread_pa: 0.0545 }, matured_before: '2024-09-05', liquidity_days: 0, risk_grade: 2, credit_rating: 'A', portfolio_role: 'Matured — proceeds settled to cash' },
  { id: 'ast_lca_btg', ticker: null, isin: 'BRLCABTG031', name: 'LCA Banco BTG Pactual — 96% do CDI, venc. 20/08/2026', type: 'lca', asset_class: 'Fixed Income', issuer: 'Banco BTG Pactual S.A.', currency: 'BRL', pricing_mode: 'accrual', accrual_terms: { index: 'CDI', percent_of_index: 0.96 }, matured_before: '2026-08-20', liquidity_days: 0, risk_grade: 2, credit_rating: 'AA', portfolio_role: 'Matured during the reporting month' },
  { id: 'ast_cash_brl', ticker: null, isin: null, name: 'Saldo em conta — reais', type: 'cash', asset_class: 'Cash', currency: 'BRL', pricing_mode: 'cash', liquidity_days: 0, risk_grade: 1, portfolio_role: 'Liquidity' },
  { id: 'ast_cash_usd', ticker: null, isin: null, name: 'Saldo em conta — dólares', type: 'cash', asset_class: 'Cash', currency: 'USD', pricing_mode: 'cash', liquidity_days: 0, risk_grade: 1, portfolio_role: 'Offshore liquidity' },
];

// ─── the advisor ───────────────────────────────────────────────────────────
export const ADVISOR = {
  id: 'adv_bicudo',
  user: { id: 'usr_bicudo', email: 'antonio.bicudo@enteram.com.br', name: 'Antonio Bicudo', role: 'advisor', password: 'enter2026' },
  advisor_code: 'A7699',
  team: 'Middle Market — São Paulo',
};

// ─── policy templates by risk profile ──────────────────────────────────────
const BANDS = {
  Conservador: {
    target: { Cash: 0.10, 'Fixed Income': 0.70, 'Equities BR': 0.08, 'Equities Global': 0.07, Alternatives: 0.05, 'Real Estate': 0.00, Commodities: 0.00, 'Digital Assets': 0.00 },
    ranges: { Cash: [0.05, 0.20], 'Fixed Income': [0.55, 0.85], 'Equities BR': [0.00, 0.15], 'Equities Global': [0.00, 0.15], Alternatives: [0.00, 0.10], 'Real Estate': [0.00, 0.08], Commodities: [0.00, 0.05], 'Digital Assets': [0.00, 0.00] },
    single_name_cap: 0.08, max_unhedged_fx: 0.15, liquidity_days: 30,
  },
  Moderado: {
    target: { Cash: 0.05, 'Fixed Income': 0.40, 'Equities BR': 0.20, 'Equities Global': 0.15, Alternatives: 0.12, 'Real Estate': 0.05, Commodities: 0.03, 'Digital Assets': 0.00 },
    ranges: { Cash: [0.02, 0.12], 'Fixed Income': [0.30, 0.55], 'Equities BR': [0.10, 0.30], 'Equities Global': [0.05, 0.25], Alternatives: [0.05, 0.20], 'Real Estate': [0.03, 0.12], Commodities: [0.00, 0.08], 'Digital Assets': [0.00, 0.02] },
    single_name_cap: 0.12, max_unhedged_fx: 0.30, liquidity_days: 60,
  },
  'Moderado-Arrojado': {
    target: { Cash: 0.04, 'Fixed Income': 0.28, 'Equities BR': 0.24, 'Equities Global': 0.22, Alternatives: 0.12, 'Real Estate': 0.05, Commodities: 0.03, 'Digital Assets': 0.02 },
    ranges: { Cash: [0.02, 0.10], 'Fixed Income': [0.18, 0.42], 'Equities BR': [0.12, 0.35], 'Equities Global': [0.12, 0.35], Alternatives: [0.05, 0.22], 'Real Estate': [0.00, 0.12], Commodities: [0.00, 0.08], 'Digital Assets': [0.00, 0.05] },
    single_name_cap: 0.15, max_unhedged_fx: 0.45, liquidity_days: 90,
  },
  Arrojado: {
    target: { Cash: 0.03, 'Fixed Income': 0.18, 'Equities BR': 0.27, 'Equities Global': 0.30, Alternatives: 0.12, 'Real Estate': 0.04, Commodities: 0.03, 'Digital Assets': 0.03 },
    ranges: { Cash: [0.01, 0.10], 'Fixed Income': [0.10, 0.32], 'Equities BR': [0.15, 0.40], 'Equities Global': [0.15, 0.45], Alternatives: [0.05, 0.25], 'Real Estate': [0.00, 0.12], Commodities: [0.00, 0.10], 'Digital Assets': [0.00, 0.08] },
    single_name_cap: 0.18, max_unhedged_fx: 0.60, liquidity_days: 120,
  },
};

export { BANDS, mulberry32, gauss, REFERENCE_DATE };
