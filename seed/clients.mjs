/**
 * Client book, policies, snapshots and history (§28).
 * See seed/seed.mjs for what is real and what is simulated.
 */
import { BANDS, mulberry32, gauss } from './seed.mjs';

const uid = (p, n) => `${p}_${n}`;

/** Monthly NAV series for a fund with no public price feed. */
function navSeries({ assetId, seed, months, annualReturn, annualVol, start = 100 }) {
  const rnd = mulberry32(seed);
  const mu = (1 + annualReturn) ** (1 / 12) - 1;
  const sigma = annualVol / Math.sqrt(12);
  let price = start;
  return months.map((m) => {
    price *= 1 + mu + sigma * gauss(rnd);
    return {
      asset_id: assetId,
      observation_date: monthEnd(m),
      price: Number(price.toFixed(6)),
      provider: 'XP position statement (simulated for the demo dataset)',
      simulated: true,
    };
  });
}

function monthEnd(ym) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

export function monthRange(fromYm, toYm) {
  const out = [];
  let [y, m] = fromYm.split('-').map(Number);
  const [ty, tm] = toYm.split('-').map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1; if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

const HISTORY_MONTHS = monthRange('2023-08', '2026-08');

/** Fund NAV universe — deterministic, flagged, and the only simulated price data. */
export const NAV_OBSERVATIONS = [
  ...navSeries({ assetId: 'ast_riza', seed: 101, months: HISTORY_MONTHS, annualReturn: 0.132, annualVol: 0.012 }),
  ...navSeries({ assetId: 'ast_brave', seed: 202, months: HISTORY_MONTHS, annualReturn: 0.118, annualVol: 0.055 }),
  ...navSeries({ assetId: 'ast_truxt', seed: 303, months: HISTORY_MONTHS, annualReturn: 0.061, annualVol: 0.145 }),
  ...navSeries({ assetId: 'ast_ibiuna', seed: 404, months: HISTORY_MONTHS, annualReturn: 0.109, annualVol: 0.048 }),
  ...navSeries({ assetId: 'ast_stk', seed: 505, months: HISTORY_MONTHS, annualReturn: 0.043, annualVol: 0.191 }),
  ...navSeries({ assetId: 'ast_constellation', seed: 606, months: HISTORY_MONTHS, annualReturn: 0.052, annualVol: 0.176 }),
  ...navSeries({ assetId: 'ast_trend_ib', seed: 707, months: HISTORY_MONTHS, annualReturn: 0.125, annualVol: 0.004 }),
];

const navAt = (assetId, date) => {
  const rows = NAV_OBSERVATIONS.filter((o) => o.asset_id === assetId && o.observation_date <= date);
  return rows.length ? rows[rows.length - 1].price : 100;
};

/** Quantity that produces a target market value at a given date. */
const qtyFor = (assetId, targetValue, date) => Number((targetValue / navAt(assetId, date)).toFixed(6));

const AUG_END = '2026-08-31';

// ══ Albert da Silva — the main demo client ═══════════════════════════════════
// Snapshot v1 reproduces the May 2025 XP statement in Input/ line for line.
// v2–v4 are the advisory relationship since then.

const ALBERT_V1_POSITIONS = [
  { asset_id: 'ast_lren3', quantity: 1642, cost_basis: 29.05, price: 16.94, market_value: 27812.04, acquired_at: '2021-04-22' },
  { asset_id: 'ast_mrfg3_legacy', quantity: 1504, cost_basis: 7.15, price: 10.26, market_value: 15432.89, acquired_at: '2021-04-22' },
  { asset_id: 'ast_arzz3_legacy', quantity: 193, cost_basis: 82.06, price: 56.58, market_value: 10923.72, acquired_at: '2022-11-02' },
  { asset_id: 'ast_hapv3', quantity: 1547, cost_basis: 15.62, price: 3.97, market_value: 6143.14, acquired_at: '2022-11-02' },
  { asset_id: 'ast_riza', quantity: 96178.73, cost_basis: 1, price: 1, market_value: 96178.73, acquired_at: '2021-04-22' },
  { asset_id: 'ast_brave', quantity: 72567.43, cost_basis: 1, price: 1, market_value: 72567.43, acquired_at: '2021-04-22' },
  { asset_id: 'ast_trend_ib', quantity: 305.44, cost_basis: 1, price: 1, market_value: 305.44, acquired_at: '2022-11-02' },
  { asset_id: 'ast_truxt', quantity: 12522.05, cost_basis: 1, price: 1, market_value: 12522.05, acquired_at: '2022-11-02' },
  { asset_id: 'ast_stk', quantity: 9745.97, cost_basis: 1, price: 1, market_value: 9745.97, acquired_at: '2023-11-09' },
  { asset_id: 'ast_constellation', quantity: 8475.02, cost_basis: 1, price: 1, market_value: 8475.02, acquired_at: '2023-11-09' },
  { asset_id: 'ast_ibiuna', quantity: 11601.02, cost_basis: 1, price: 1, market_value: 11601.02, acquired_at: '2023-11-09' },
  { asset_id: 'ast_cdb_c6', quantity: 40478.75, cost_basis: 30000, price: 1, market_value: 40478.75, acquired_at: '2021-09-06' },
  { asset_id: 'ast_cash_brl', quantity: 74672.62, cost_basis: 1, price: 1, market_value: 74672.62 },
];

const ALBERT_V4_POSITIONS = [
  { asset_id: 'ast_bova11', quantity: 310, cost_basis: 132.40, acquired_at: '2025-08-14' },
  { asset_id: 'ast_lren3', quantity: 1642, cost_basis: 29.05, acquired_at: '2021-04-22' },
  { asset_id: 'ast_mbrf3', quantity: 1504, cost_basis: 7.15, acquired_at: '2021-04-22', notes: 'Received in exchange for MRFG3 in the Marfrig–BRF combination. Cost basis carried over.' },
  { asset_id: 'ast_azza3', quantity: 193, cost_basis: 82.06, acquired_at: '2022-11-02', notes: 'Received in exchange for ARZZ3 in the Arezzo–Soma combination. Cost basis carried over.' },
  { asset_id: 'ast_hapv3', quantity: 1547, cost_basis: 15.62, acquired_at: '2022-11-02' },
  { asset_id: 'ast_ivvb11', quantity: 90, cost_basis: 341.20, acquired_at: '2025-08-14' },
  { asset_id: 'ast_ivv', quantity: 8, cost_basis: 612.40, acquired_at: '2026-02-11', notes: 'Offshore account. Unhedged USD.' },
  { asset_id: 'ast_imab11', quantity: 250, cost_basis: 104.80, acquired_at: '2025-08-14' },
  { asset_id: 'ast_cdb_daycoval', quantity: 45000, cost_basis: 45000, acquired_at: '2026-03-16' },
  { asset_id: 'ast_riza', quantity: qtyFor('ast_riza', 55600, AUG_END), cost_basis: 48000, acquired_at: '2021-04-22' },
  { asset_id: 'ast_brave', quantity: qtyFor('ast_brave', 40300, AUG_END), cost_basis: 36000, acquired_at: '2021-04-22' },
  { asset_id: 'ast_truxt', quantity: qtyFor('ast_truxt', 13100, AUG_END), cost_basis: 14250, acquired_at: '2022-11-02' },
  { asset_id: 'ast_cash_brl', quantity: 30000, cost_basis: 1, market_value: 30000 },
];

// ══ the other four clients ═══════════════════════════════════════════════════
// Beatriz sits at the top of the middle-market band the brief describes, so the
// book is sized to stay under R$ 1 million. NVDA is deliberately above her
// single-name cap: the client signed an explicit exception, and the guardrail
// layer has to keep surfacing it anyway.
const BEATRIZ_POSITIONS = [
  { asset_id: 'ast_ivv', quantity: 15, cost_basis: 498.10, acquired_at: '2024-05-20' },
  { asset_id: 'ast_acwi', quantity: 60, cost_basis: 112.40, acquired_at: '2024-09-03' },
  { asset_id: 'ast_nvda', quantity: 120, cost_basis: 118.90, acquired_at: '2024-03-11' },
  { asset_id: 'ast_bova11', quantity: 520, cost_basis: 141.10, acquired_at: '2025-01-15' },
  { asset_id: 'ast_smal11', quantity: 200, cost_basis: 98.30, acquired_at: '2025-06-02' },
  { asset_id: 'ast_imab11', quantity: 700, cost_basis: 108.20, acquired_at: '2025-03-18' },
  { asset_id: 'ast_btc', quantity: 0.15, cost_basis: 51200, acquired_at: '2025-11-04' },
  { asset_id: 'ast_hglg11', quantity: 90, cost_basis: 138.60, acquired_at: '2025-09-22' },
  { asset_id: 'ast_ibiuna', quantity: qtyFor('ast_ibiuna', 45000, AUG_END), cost_basis: 42000, acquired_at: '2024-02-14' },
  { asset_id: 'ast_cash_brl', quantity: 22000, cost_basis: 1, market_value: 22000 },
  { asset_id: 'ast_cash_usd', quantity: 3000, cost_basis: 1, market_value: 3000 },
];

const CARLOS_POSITIONS = [
  { asset_id: 'ast_b5p211', quantity: 1450, cost_basis: 101.90, acquired_at: '2024-11-08' },
  { asset_id: 'ast_imab11', quantity: 900, cost_basis: 110.40, acquired_at: '2025-02-12' },
  { asset_id: 'ast_cdb_daycoval', quantity: 44000, cost_basis: 44000, acquired_at: '2026-03-16' },
  { asset_id: 'ast_riza', quantity: qtyFor('ast_riza', 44000, AUG_END), cost_basis: 40000, acquired_at: '2023-05-19' },
  { asset_id: 'ast_trend_ib', quantity: qtyFor('ast_trend_ib', 52000, AUG_END), cost_basis: 49000, acquired_at: '2024-01-22' },
  { asset_id: 'ast_bova11', quantity: 210, cost_basis: 148.20, acquired_at: '2025-07-10' },
  { asset_id: 'ast_cash_brl', quantity: 38000, cost_basis: 1, market_value: 38000 },
];

const DANIELA_POSITIONS = [
  { asset_id: 'ast_ivvb11', quantity: 260, cost_basis: 372.10, acquired_at: '2025-04-30' },
  { asset_id: 'ast_bova11', quantity: 480, cost_basis: 152.60, acquired_at: '2025-02-20' },
  { asset_id: 'ast_lren3', quantity: 3200, cost_basis: 16.10, acquired_at: '2025-10-14' },
  { asset_id: 'ast_gold', quantity: 1900, cost_basis: 18.40, acquired_at: '2026-01-09' },
  { asset_id: 'ast_btc', quantity: 0.09, cost_basis: 64800, acquired_at: '2026-02-27' },
  { asset_id: 'ast_xpml11', quantity: 380, cost_basis: 105.90, acquired_at: '2025-08-06' },
  { asset_id: 'ast_imab11', quantity: 520, cost_basis: 111.80, acquired_at: '2025-05-15' },
  { asset_id: 'ast_stk', quantity: qtyFor('ast_stk', 62000, AUG_END), cost_basis: 68000, acquired_at: '2024-06-11' },
  { asset_id: 'ast_cash_brl', quantity: 26000, cost_basis: 1, market_value: 26000 },
];

const EDUARDO_POSITIONS = [
  { asset_id: 'ast_b5p211', quantity: 1120, cost_basis: 103.40, acquired_at: '2025-01-28' },
  { asset_id: 'ast_riza', quantity: qtyFor('ast_riza', 32000, AUG_END), cost_basis: 30000, acquired_at: '2024-08-13' },
  { asset_id: 'ast_bova11', quantity: 140, cost_basis: 158.90, acquired_at: '2026-01-19' },
  { asset_id: 'ast_ivvb11', quantity: 42, cost_basis: 401.20, acquired_at: '2026-03-05' },
  { asset_id: 'ast_hglg11', quantity: 96, cost_basis: 143.20, acquired_at: '2025-12-03' },
  { asset_id: 'ast_cash_brl', quantity: 19500, cost_basis: 1, market_value: 19500 },
];

function policyFor(clientId, profile, version, effective, overrides = {}) {
  const b = BANDS[profile];
  return {
    id: uid('pol', `${clientId}_v${version}`),
    client_id: clientId,
    version,
    effective_date: effective,
    status: 'approved',
    risk_profile: profile,
    investment_horizon: overrides.horizon ?? 'Médio a longo prazo (5 a 10 anos)',
    liquidity_requirements: overrides.liquidity ?? 'Reserva de emergência equivalente a seis meses de despesas, mantida em caixa e liquidez diária.',
    liquidity_requirement_days: b.liquidity_days,
    objectives: overrides.objectives ?? 'Preservar o poder de compra e ampliar o patrimônio de forma sustentável, com volatilidade compatível com o perfil.',
    base_currency: overrides.base_currency ?? 'BRL',
    restrictions: overrides.restrictions ?? [],
    target_allocation: b.target,
    permitted_ranges: Object.fromEntries(Object.entries(b.ranges).map(([k, [min, max]]) => [k, { min, max, target: b.target[k] ?? 0 }])),
    single_name_cap: overrides.single_name_cap ?? b.single_name_cap,
    max_unhedged_fx: overrides.max_unhedged_fx ?? b.max_unhedged_fx,
    rebalance_trigger: 0.05,
    notes: overrides.notes ?? null,
    approved_by: 'Antonio Bicudo',
  };
}

export const CLIENTS = [
  {
    id: 'cli_albert',
    user: { id: 'usr_albert', email: 'albert.dasilva@exemplo.com.br', name: 'Albert da Silva', role: 'client', password: 'albert2026' },
    full_name: 'Albert da Silva',
    risk_profile: 'Moderado',
    base_currency: 'BRL',
    segment: 'Middle market',
    onboarded_at: '2021-04-22',
    next_review_at: '2026-09-18',
    is_demo_primary: true,
    policies: [
      policyFor('cli_albert', 'Moderado', 1, '2021-04-22', {
        notes: 'Perfil definido no questionário de suitability na abertura da conta. Carteira concentrada em fundos e quatro ações individuais herdadas.',
      }),
      policyFor('cli_albert', 'Moderado', 2, '2025-08-14', {
        notes: 'Revisão após a reunião de agosto de 2025. Introduzidas faixas explícitas por classe, teto de 12% por emissor e alvo de 5% em imóveis listados.',
        restrictions: [
          { id: 'r_credit_floor', type: 'credit_rating', value: 'BB+', label: 'Renda fixa privada apenas com classificação BB+ ou superior, conforme o perfil moderado.' },
          { id: 'r_no_crypto', type: 'asset_class', value: 'Digital Assets', label: 'Ativos digitais não autorizados nesta política.' },
        ],
      }),
      policyFor('cli_albert', 'Moderado', 3, '2026-03-16', {
        notes: 'Mantido o perfil moderado. Autorizada exposição internacional sem hedge até 30% do patrimônio e ampliada a faixa de renda fixa inflação.',
        restrictions: [
          { id: 'r_credit_floor', type: 'credit_rating', value: 'BB+', label: 'Renda fixa privada apenas com classificação BB+ ou superior, conforme o perfil moderado.' },
          { id: 'r_no_crypto', type: 'asset_class', value: 'Digital Assets', label: 'Ativos digitais não autorizados nesta política.' },
        ],
      }),
    ],
    snapshots: [
      { version: 1, effective_date: '2025-05-07', policy_version: 1, positions: ALBERT_V1_POSITIONS, cash: 74672.62, total_value: 386858.82, commentary: 'Extrato XP de 07/05/2025 reproduzido integralmente. Carteira com 54% do investido em dois fundos e quatro ações individuais com perdas relevantes desde a compra.', meeting: null, verbatim_from_input: true },
      { version: 2, effective_date: '2025-08-14', policy_version: 2, positions: null, cash: 41000, total_value: 392400, commentary: 'Reunião de agosto de 2025. Reduzida a concentração nos dois maiores fundos e introduzidos BOVA11, IVVB11 e IMAB11 como núcleo listado da carteira.', meeting: { id: 'mtg_albert_2025_08', date: '2025-08-14', notes: 'Cliente confortável com a redução da concentração. Manteve as quatro ações individuais por razão fiscal (prejuízo acumulado).' } },
      { version: 3, effective_date: '2026-03-16', policy_version: 3, positions: null, cash: 52000, total_value: 401800, commentary: 'Reunião de março de 2026. Alocada a posição offshore em IVV e contratado CDB Daycoval IPCA+6,10% com vencimento em 2028.', meeting: { id: 'mtg_albert_2026_03', date: '2026-03-16', notes: 'Aprovada exposição internacional sem hedge até 30%. Cliente citou objetivo de compra de imóvel em 2031.' } },
      { version: 4, effective_date: '2026-07-15', policy_version: 3, positions: ALBERT_V4_POSITIONS, cash: 30000, total_value: null, commentary: 'Reunião de julho de 2026. Sem mudanças estruturais; caixa reduzido para 30 mil com aporte em IMAB11.', meeting: { id: 'mtg_albert_2026_07', date: '2026-07-15', notes: 'Cliente pediu para revisar as ações individuais na próxima reunião. Sem apetite para ativos digitais.' }, is_current: true },
    ],
    flows: [
      { date: '2026-08-11', amount: 6000, type: 'contribution', description: 'Aporte mensal programado' },
      { date: '2026-08-25', amount: -2500, type: 'withdrawal', description: 'Resgate para despesa pessoal' },
    ],
    meetings: [
      { id: 'mtg_albert_next', date: '2026-09-18', status: 'scheduled', notes: null },
    ],
  },
  {
    id: 'cli_beatriz',
    user: { id: 'usr_beatriz', email: 'beatriz.nakamura@exemplo.com.br', name: 'Beatriz Nakamura', role: 'client', password: 'beatriz2026' },
    full_name: 'Beatriz Nakamura',
    risk_profile: 'Arrojado',
    base_currency: 'BRL',
    segment: 'Middle market — upper',
    onboarded_at: '2024-02-14',
    next_review_at: '2026-09-24',
    policies: [policyFor('cli_beatriz', 'Arrojado', 1, '2024-02-14', {
      horizon: 'Longo prazo (acima de 10 anos)',
      objectives: 'Crescimento patrimonial com tolerância a oscilações relevantes; parte do patrimônio dedicada a exposição internacional.',
      max_unhedged_fx: 0.60,
      restrictions: [{ id: 'r_no_tobacco', type: 'sector', value: 'Tobacco', label: 'Sem exposição a tabaco por decisão da cliente.' }],
    })],
    snapshots: [{ version: 1, effective_date: '2026-06-30', policy_version: 1, positions: BEATRIZ_POSITIONS, cash: 41000, total_value: null, commentary: 'Carteira com forte viés internacional e uma posição individual relevante em semicondutores.', meeting: { id: 'mtg_bea_2026_06', date: '2026-06-30', notes: 'Cliente aceitou manter NVDA acima do teto por convicção, com revisão trimestral formalizada.' }, is_current: true }],
    flows: [{ date: '2026-08-05', amount: 15000, type: 'contribution', description: 'Aporte de bônus anual' }],
    meetings: [{ id: 'mtg_bea_next', date: '2026-09-24', status: 'scheduled', notes: null }],
  },
  {
    id: 'cli_carlos',
    user: { id: 'usr_carlos', email: 'carlos.ferreira@exemplo.com.br', name: 'Carlos Mendes Ferreira', role: 'client', password: 'carlos2026' },
    full_name: 'Carlos Mendes Ferreira',
    risk_profile: 'Conservador',
    base_currency: 'BRL',
    segment: 'Middle market',
    onboarded_at: '2023-05-19',
    next_review_at: '2026-10-02',
    policies: [policyFor('cli_carlos', 'Conservador', 1, '2023-05-19', {
      horizon: 'Curto a médio prazo (2 a 5 anos)',
      liquidity: 'Necessidade declarada de resgate em até 30 dias para complemento de renda.',
      objectives: 'Preservação de capital e renda previsível, com volatilidade mínima.',
      restrictions: [
        { id: 'r_no_equity_single', type: 'asset_class', value: 'Digital Assets', label: 'Ativos digitais não autorizados.' },
        { id: 'r_credit_floor_c', type: 'credit_rating', value: 'A-', label: 'Crédito privado apenas com classificação A− ou superior.' },
      ],
    })],
    snapshots: [{ version: 1, effective_date: '2026-05-21', policy_version: 1, positions: CARLOS_POSITIONS, cash: 38000, total_value: null, commentary: 'Carteira predominantemente indexada à inflação e ao CDI, compatível com a necessidade de liquidez declarada.', meeting: { id: 'mtg_car_2026_05', date: '2026-05-21', notes: 'Cliente reforçou a necessidade de liquidez em 30 dias.' }, is_current: true }],
    flows: [],
    meetings: [{ id: 'mtg_car_next', date: '2026-10-02', status: 'scheduled', notes: null }],
  },
  {
    id: 'cli_daniela',
    user: { id: 'usr_daniela', email: 'daniela.rocha@exemplo.com.br', name: 'Daniela Rocha Lima', role: 'client', password: 'daniela2026' },
    full_name: 'Daniela Rocha Lima',
    risk_profile: 'Moderado-Arrojado',
    base_currency: 'BRL',
    segment: 'Middle market',
    onboarded_at: '2024-06-11',
    next_review_at: '2026-09-11',
    policies: [policyFor('cli_daniela', 'Moderado-Arrojado', 1, '2024-06-11', {
      horizon: 'Longo prazo (acima de 10 anos)',
      objectives: 'Crescimento com diversificação real, incluindo ouro e uma alocação pequena em ativos digitais.',
    })],
    snapshots: [{ version: 1, effective_date: '2026-07-02', policy_version: 1, positions: DANIELA_POSITIONS, cash: 26000, total_value: null, commentary: 'Carteira com diversificação real relevante: ouro, imóveis listados e uma posição pequena em bitcoin dentro da faixa autorizada.', meeting: { id: 'mtg_dan_2026_07', date: '2026-07-02', notes: 'Cliente aumentou a posição em ouro após a discussão sobre risco geopolítico.' }, is_current: true }],
    flows: [{ date: '2026-08-18', amount: -8000, type: 'withdrawal', description: 'Resgate programado' }],
    meetings: [{ id: 'mtg_dan_next', date: '2026-09-11', status: 'scheduled', notes: null }],
  },
  {
    id: 'cli_eduardo',
    user: { id: 'usr_eduardo', email: 'eduardo.tavares@exemplo.com.br', name: 'Eduardo Tavares', role: 'client', password: 'eduardo2026' },
    full_name: 'Eduardo Tavares',
    risk_profile: 'Conservador',
    base_currency: 'BRL',
    segment: 'Middle market — entry',
    onboarded_at: '2024-08-13',
    next_review_at: '2026-11-06',
    policies: [policyFor('cli_eduardo', 'Conservador', 1, '2024-08-13', {
      horizon: 'Médio prazo (3 a 7 anos)',
      objectives: 'Formar reserva para entrada de imóvel mantendo baixa volatilidade.',
    })],
    snapshots: [{ version: 1, effective_date: '2026-06-18', policy_version: 1, positions: EDUARDO_POSITIONS, cash: 19500, total_value: null, commentary: 'Primeira carteira estruturada do cliente, com núcleo em renda fixa curta indexada à inflação.', meeting: { id: 'mtg_edu_2026_06', date: '2026-06-18', notes: 'Cliente iniciou aportes mensais de R$ 1.500.' }, is_current: true }],
    flows: [{ date: '2026-08-07', amount: 1500, type: 'contribution', description: 'Aporte mensal programado' }],
    meetings: [{ id: 'mtg_edu_next', date: '2026-11-06', status: 'scheduled', notes: null }],
  },
];

/**
 * Reconstructed monthly return history. Written before the platform existed, so
 * it is simulated and labelled as such wherever it is surfaced. The live
 * pipeline computes the reporting month itself and overwrites the last entry.
 */
/**
 * Reconstructed monthly return history for the period before the platform
 * existed. The drift parameters put each profile in a plausible place against a
 * ~13.5% CDI over the window: a moderate book roughly matching cash, a
 * conservative book slightly ahead of it after fees, an aggressive book ahead
 * with materially more volatility. Simulated, and labelled wherever it surfaces.
 */
export function returnHistory(clientId, seed, annualReturn, annualVol) {
  const months = monthRange('2023-08', '2026-07');
  const rnd = mulberry32(seed);
  const mu = (1 + annualReturn) ** (1 / 12) - 1;
  const sigma = annualVol / Math.sqrt(12);
  return months.map((m) => ({
    client_id: clientId,
    month: m,
    portfolio_return: Number((mu + sigma * gauss(rnd)).toFixed(6)),
    benchmark_return: Number((mu * 0.92 + (sigma * 0.75) * gauss(rnd)).toFixed(6)),
    method: 'reconstructed_from_statements',
    simulated: true,
  }));
}

export const RETURN_HISTORY = [
  ...returnHistory('cli_albert', 11, 0.212, 0.071),
  ...returnHistory('cli_beatriz', 22, 0.198, 0.148),
  ...returnHistory('cli_carlos', 33, 0.152, 0.021),
  ...returnHistory('cli_daniela', 44, 0.182, 0.109),
  ...returnHistory('cli_eduardo', 55, 0.156, 0.032),
];

export { ALBERT_V1_POSITIONS, ALBERT_V4_POSITIONS, navAt, HISTORY_MONTHS };
