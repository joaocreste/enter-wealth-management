/**
 * Suitability / guardrail layer (§18).
 *
 * This runs AFTER the recommendation engine and is deliberately a separate
 * pass with its own vocabulary. A market signal and a client outcome are two
 * different statements, and the product must be able to print both:
 *
 *     MARKET SIGNAL:            BUY
 *     CLIENT-SUITABILITY RESULT: DO NOT ADD / DISCUSS ONLY
 *
 * The guardrail can only ever make a recommendation more conservative. It
 * never turns a HOLD into an ADD.
 */
import { ACTIONS } from './recommendations.js';

export const SUITABILITY = {
  PASS: 'PASS',
  DISCUSS_ONLY: 'DISCUSS_ONLY',
  DO_NOT_ADD: 'DO_NOT_ADD',
  REDUCE_REQUIRED: 'REDUCE_REQUIRED',
  BLOCKED: 'BLOCKED',
};

const RISK_ORDER = ['Conservador', 'Moderado', 'Moderado-Arrojado', 'Arrojado', 'Agressivo'];

/** Asset-class names as a Brazilian client reads them (§5.7). */
const CLASS_PT = {
  Cash: 'Caixa',
  'Fixed Income': 'Renda fixa',
  'Equities BR': 'Renda variável Brasil',
  'Equities Global': 'Renda variável global',
  Alternatives: 'Multimercado e alternativos',
  'Real Estate': 'Imobiliário listado',
  Commodities: 'Commodities',
  'Digital Assets': 'Ativos digitais',
};
const pt = (assetClass) => CLASS_PT[assetClass] || assetClass;

/**
 * Highest instrument risk grade a profile may ADD to.
 *
 * Grades: 1 cash-like · 2 sovereign and high-grade credit · 3 credit and
 * inflation-linked funds · 4 diversified equity and multi-strategy ·
 * 5 single-name high-volatility, small caps and digital assets.
 *
 * A moderate profile may hold diversified equity — that is the whole point of a
 * 10–30% equity band — but not the grade-5 sleeve. An existing grade-5 holding
 * is not force-sold; it simply cannot be increased, which is what the guardrail
 * expresses by refusing an ADD rather than demanding a REDUCE.
 */
const PROFILE_MAX_GRADE = {
  Conservador: 3,
  Moderado: 4,
  'Moderado-Arrojado': 5,
  Arrojado: 5,
  Agressivo: 5,
};

/**
 * @param {object} rec        one recommendation record
 * @param {object} ctx        { asset, position, policy, exposures, portfolio, classBand, liquidityDays }
 */
export function checkSuitability(rec, ctx) {
  const { asset, policy, exposures = {}, portfolio = {}, classBand } = ctx;
  const flags = [];
  let result = SUITABILITY.PASS;

  const escalate = (next) => {
    const rank = { PASS: 0, DISCUSS_ONLY: 1, DO_NOT_ADD: 2, REDUCE_REQUIRED: 3, BLOCKED: 4 };
    if (rank[next] > rank[result]) result = next;
  };

  // ── 1. explicit restrictions in the policy ───────────────────────────────
  const restrictions = policy?.restrictions || [];
  for (const r of restrictions) {
    const hit =
      (r.type === 'asset_class' && r.value === asset.asset_class) ||
      (r.type === 'ticker' && r.value === asset.ticker) ||
      (r.type === 'sector' && r.value === asset.sector) ||
      (r.type === 'issuer' && r.value === asset.issuer) ||
      (r.type === 'credit_rating' && asset.credit_rating && ratingBelow(asset.credit_rating, r.value));
    if (hit) {
      flags.push({
        code: 'RESTRICTED_INSTRUMENT', severity: 'high',
        message: r.label_en || `Restricted by the investment policy: ${r.type} = ${r.value}`,
        message_pt: r.label || `Vedado pela política de investimentos: ${r.type} = ${r.value}`,
        policy_reference: r.id || null,
      });
      escalate(SUITABILITY.BLOCKED);
    }
  }

  // ── 2. instrument risk grade against the client's profile ────────────────
  const maxGrade = PROFILE_MAX_GRADE[policy?.risk_profile] ?? 4;
  if (asset.risk_grade && asset.risk_grade > maxGrade) {
    const held = (rec.current_weight ?? 0) > 0;
    flags.push({
      code: 'RISK_GRADE_ABOVE_PROFILE',
      severity: held ? 'medium' : 'high',
      message: held
        ? `Instrument risk grade ${asset.risk_grade} is above the maximum of ${maxGrade} for a ${policy?.risk_profile} profile. The existing position may be held and discussed, but not increased.`
        : `Instrument risk grade ${asset.risk_grade} exceeds the maximum of ${maxGrade} for a ${policy?.risk_profile} profile.`,
      message_pt: held
        ? `O grau de risco ${asset.risk_grade} deste ativo está acima do máximo de ${maxGrade} previsto para o perfil ${policy?.risk_profile}. A posição atual pode ser mantida e discutida, mas não aumentada.`
        : `O grau de risco ${asset.risk_grade} deste ativo excede o máximo de ${maxGrade} previsto para o perfil ${policy?.risk_profile}.`,
    });
    escalate(SUITABILITY.DO_NOT_ADD);
  }

  // ── 3. asset-class band ──────────────────────────────────────────────────
  const classWeight = exposures[asset.asset_class] ?? 0;
  if (classBand) {
    if (classWeight >= (classBand.max ?? 1)) {
      flags.push({
        code: 'CLASS_AT_OR_ABOVE_MAX', severity: rec.proposed_action === ACTIONS.ADD ? 'high' : 'medium',
        message: `${asset.asset_class} is at ${(classWeight * 100).toFixed(1)}% against a policy maximum of ${((classBand.max ?? 1) * 100).toFixed(1)}%. Adding would breach the approved range.`,
        message_pt: `${pt(asset.asset_class)} está em ${(classWeight * 100).toFixed(1).replace('.', ',')}% contra um máximo de ${((classBand.max ?? 1) * 100).toFixed(0)}% na política. Aumentar romperia a faixa aprovada.`,
      });
      if (rec.proposed_action === ACTIONS.ADD) escalate(SUITABILITY.DO_NOT_ADD);
      else escalate(SUITABILITY.DISCUSS_ONLY);
    } else if (classWeight > (classBand.max ?? 1) * 0.92 && rec.proposed_action === ACTIONS.ADD) {
      flags.push({
        code: 'CLASS_NEAR_MAX', severity: 'medium',
        message: `${asset.asset_class} is close to its ${((classBand.max ?? 1) * 100).toFixed(1)}% ceiling; sizing must respect the remaining headroom.`,
        message_pt: `${pt(asset.asset_class)} está próximo do teto de ${((classBand.max ?? 1) * 100).toFixed(0)}% da política; qualquer aumento precisa respeitar o espaço que resta.`,
      });
      escalate(SUITABILITY.DISCUSS_ONLY);
    }
    if (classWeight < (classBand.min ?? 0) && rec.proposed_action === ACTIONS.REDUCE) {
      flags.push({
        code: 'CLASS_BELOW_MIN', severity: 'medium',
        message: `${asset.asset_class} is already below its ${((classBand.min ?? 0) * 100).toFixed(1)}% floor; reducing further would move the portfolio away from the approved policy.`,
        message_pt: `${pt(asset.asset_class)} já está abaixo do mínimo de ${((classBand.min ?? 0) * 100).toFixed(0)}% da política; reduzir mais afastaria a carteira do que foi aprovado.`,
      });
      escalate(SUITABILITY.DISCUSS_ONLY);
    }
  }

  // ── 4. single-name concentration ─────────────────────────────────────────
  // The cap is about issuer concentration. A broad index ETF is a wrapper over
  // hundreds of issuers, so applying a single-name cap to it would be a
  // category error — and would generate a REDUCE on the most diversified thing
  // in the book. Actively managed funds are NOT exempt: a credit fund at 14% is
  // real concentration in one manager and one strategy.
  const cap = policy?.single_name_cap ?? 0.10;
  const w = rec.current_weight ?? 0;
  const concentrationExempt = asset.concentration_exempt ?? asset.type === 'etf';
  if (!concentrationExempt && w > cap) {
    flags.push({
      code: 'CONCENTRATION_BREACH', severity: 'high',
      message: `Position is ${(w * 100).toFixed(1)}% of the portfolio against a ${(cap * 100).toFixed(0)}% single-name cap.`,
      message_pt: `A posição representa ${(w * 100).toFixed(1).replace('.', ',')}% da carteira, acima do teto de ${(cap * 100).toFixed(0)}% por emissor previsto na política.`,
    });
    escalate(rec.proposed_action === ACTIONS.ADD ? SUITABILITY.DO_NOT_ADD : SUITABILITY.REDUCE_REQUIRED);
  }

  // ── 5. currency mismatch against the base currency and any FX mandate ────
  if (asset.currency && policy?.base_currency && asset.currency !== policy.base_currency) {
    const fxCap = policy.max_unhedged_fx ?? null;
    const fxExposure = portfolio.unhedged_fx_weight ?? null;
    if (fxCap != null && fxExposure != null && fxExposure >= fxCap && rec.proposed_action === ACTIONS.ADD) {
      flags.push({
        code: 'FX_EXPOSURE_AT_CAP', severity: 'high',
        message: `Unhedged exposure outside ${policy.base_currency} is ${(fxExposure * 100).toFixed(1)}% against a ${(fxCap * 100).toFixed(0)}% limit.`,
        message_pt: `A exposição sem proteção cambial fora do ${policy.base_currency} está em ${(fxExposure * 100).toFixed(1).replace('.', ',')}%, contra um limite de ${(fxCap * 100).toFixed(0)}%.`,
      });
      escalate(SUITABILITY.DO_NOT_ADD);
    } else {
      flags.push({
        code: 'CURRENCY_MISMATCH', severity: 'low',
        message: `Priced in ${asset.currency} while the policy base currency is ${policy.base_currency}; the client's result includes an exchange-rate effect.`,
        message_pt: `Ativo cotado em ${asset.currency} enquanto a moeda base da política é ${policy.base_currency}; parte do resultado vem da variação cambial.`,
      });
    }
  }

  // ── 6. liquidity against the client's stated needs ───────────────────────
  const need = policy?.liquidity_requirement_days ?? null;
  if (need != null && asset.liquidity_days != null && asset.liquidity_days > need) {
    flags.push({
      code: 'LIQUIDITY_MISMATCH', severity: asset.liquidity_days > need * 3 ? 'high' : 'medium',
      message: `Redemption takes ${asset.liquidity_days} days against a stated liquidity requirement of ${need} days.`,
      message_pt: `O resgate leva ${asset.liquidity_days} dias, contra uma necessidade declarada de liquidez em ${need} dias.`,
    });
    if (rec.proposed_action === ACTIONS.ADD) escalate(SUITABILITY.DISCUSS_ONLY);
  }

  // ── 7. deviation of the whole portfolio from the approved policy ─────────
  // A portfolio-level fact. It is surfaced once on the recommendation set
  // rather than repeated on every asset, which only trains the advisor to skip it.
  if (ctx.includePortfolioDrift && portfolio.max_class_drift != null && portfolio.max_class_drift > (policy?.rebalance_trigger ?? 0.05)) {
    flags.push({
      code: 'POLICY_DRIFT', severity: 'medium',
      message: `The portfolio has drifted ${(portfolio.max_class_drift * 100).toFixed(1)} p.p. from its approved allocation, above the ${((policy?.rebalance_trigger ?? 0.05) * 100).toFixed(0)} p.p. review trigger.`,
      message_pt: `A carteira se afastou ${(portfolio.max_class_drift * 100).toFixed(1).replace('.', ',')} p.p. da alocação aprovada, acima do gatilho de revisão de ${((policy?.rebalance_trigger ?? 0.05) * 100).toFixed(0)} p.p.`,
    });
  }

  // ── 8. data integrity ────────────────────────────────────────────────────
  if (rec.blocked_reason) {
    flags.push({ code: 'DATA_INTEGRITY', severity: 'high', message: rec.blocked_reason, message_pt: `Pendência de dados: ${rec.blocked_reason}` });
    escalate(SUITABILITY.DISCUSS_ONLY);
  }

  const finalAction = applyGuardrail(rec.proposed_action, result);

  return {
    suitability_result: result,
    flags,
    final_action: finalAction,
    downgraded: finalAction !== rec.proposed_action,
    /** The exact two-line statement the UI and the letter both render (§18). */
    statement: {
      market_signal: marketSignalLine(rec),
      client_suitability: suitabilityLine(result, finalAction),
    },
  };
}

function applyGuardrail(action, result) {
  if (result === SUITABILITY.BLOCKED) return ACTIONS.DISCUSS;
  if (result === SUITABILITY.DO_NOT_ADD) return action === ACTIONS.ADD ? ACTIONS.DISCUSS : action;
  if (result === SUITABILITY.REDUCE_REQUIRED) return action === ACTIONS.ADD || action === ACTIONS.HOLD ? ACTIONS.REDUCE : action;
  if (result === SUITABILITY.DISCUSS_ONLY) return action === ACTIONS.ADD ? ACTIONS.DISCUSS : action;
  return action;
}

function marketSignalLine(rec) {
  const t = rec.technical_signal;
  const a = rec.analyst_signal;
  if (!t && !a) return 'NO MARKET SIGNAL AVAILABLE';
  if (t && a && rec.signal_conflict) return `TECHNICAL: ${t.toUpperCase()} · ANALYST: ${a.toUpperCase()} (CONFLICT)`;
  return [t ? `TECHNICAL: ${t.toUpperCase()}` : 'TECHNICAL: NOT COVERED',
    a ? `ANALYST: ${a.toUpperCase()}` : 'ANALYST: NO CONSENSUS AVAILABLE'].join(' · ');
}

function suitabilityLine(result, finalAction) {
  switch (result) {
    case SUITABILITY.BLOCKED: return 'BLOCKED BY THE INVESTMENT POLICY — DISCUSS ONLY';
    case SUITABILITY.DO_NOT_ADD: return 'DO NOT ADD / DISCUSS ONLY';
    case SUITABILITY.REDUCE_REQUIRED: return 'REDUCE REQUIRED TO RETURN WITHIN POLICY';
    case SUITABILITY.DISCUSS_ONLY: return 'DISCUSS ONLY — CONDITIONS APPLY';
    default: return `WITHIN POLICY — ${finalAction}`;
  }
}

const RATING_SCALE = ['D', 'C', 'CC', 'CCC', 'CCC+', 'B-', 'B', 'B+', 'BB-', 'BB', 'BB+', 'BBB-', 'BBB', 'BBB+', 'A-', 'A', 'A+', 'AA-', 'AA', 'AA+', 'AAA'];
function ratingBelow(rating, floor) {
  const a = RATING_SCALE.indexOf(String(rating).toUpperCase());
  const b = RATING_SCALE.indexOf(String(floor).toUpperCase());
  return a >= 0 && b >= 0 && a < b;
}

export function runSuitability(recommendations, ctx) {
  return recommendations.map((rec) => {
    const asset = ctx.assets.find((a) => a.id === rec.asset_id);
    const check = checkSuitability(rec, { ...ctx, asset, classBand: ctx.bands?.[asset.asset_class] || null });
    return { ...rec, ...check };
  });
}

export { RISK_ORDER };
