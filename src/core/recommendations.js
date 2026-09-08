/**
 * Buy / Hold / Reduce / Sell synthesis (§16–17).
 *
 * The engine is deterministic and explainable: every input that moved the
 * result is written into `factors` with its own direction and weight, so the
 * advisor can see exactly why an asset was proposed and can disagree with one
 * factor without discarding the whole recommendation.
 *
 * Two TradingView families are consumed as SEPARATE inputs and are never
 * collapsed into one "market view": a technical Sell alongside an analyst
 * Strong Buy is a genuine disagreement and is surfaced as such, because that
 * disagreement is exactly what an advisor should be talking about.
 *
 * The output is a PROPOSAL. Nothing here executes, and nothing reaches the
 * client until an advisor sets advisor_status = 'approved'.
 */

const TECH_SCORE = { 'Strong Buy': 2, Buy: 1, Neutral: 0, Sell: -1, 'Strong Sell': -2 };

/**
 * Every factor is written twice: English for the engine, the graph and the
 * audit trail, Portuguese for the advisor who reads it on screen. §5.7 —
 * neither language is a translation layer over the other.
 */
const SIGNAL_PT = { 'Strong Buy': 'compra forte', Buy: 'compra', Neutral: 'neutro', Sell: 'venda', 'Strong Sell': 'venda forte' };
const CLASS_PT = {
  Cash: 'Caixa', 'Fixed Income': 'Renda fixa', 'Equities BR': 'Renda variável Brasil',
  'Equities Global': 'Renda variável global', Alternatives: 'Multimercado e alternativos',
  'Real Estate': 'Imobiliário listado', Commodities: 'Commodities', 'Digital Assets': 'Ativos digitais',
};
const classPt = (k) => CLASS_PT[k] || k;
const sigPt = (s) => SIGNAL_PT[s] || String(s || '').toLowerCase();
const pct = (v, d = 1) => `${(v * 100).toFixed(d).replace('.', ',')}%`;
const ANALYST_SCORE = { 'Strong Buy': 2, Buy: 1, Neutral: 0, Sell: -1, 'Strong Sell': -2 };

export const ACTIONS = {
  ADD: 'ADD',
  HOLD: 'HOLD',
  REDUCE: 'REDUCE',
  EXIT: 'EXIT',
  DISCUSS: 'DISCUSS',
};

/** Where a holding sits against its policy band. */
export function bandPosition(weight, range) {
  if (!range || weight == null) return { state: 'no_band', gap: null };
  const { min, max, target } = range;
  if (min != null && weight < min) return { state: 'below_band', gap: min - weight, target, min, max };
  if (max != null && weight > max) return { state: 'above_band', gap: weight - max, target, min, max };
  if (target != null) {
    const drift = weight - target;
    if (Math.abs(drift) >= 0.05) return { state: 'drifted', gap: drift, target, min, max };
  }
  return { state: 'within_band', gap: null, target, min, max };
}

/**
 * @param {object} ctx
 * @param {object} ctx.asset
 * @param {object} ctx.position          { market_value, weight, quantity, unrealised_pl_pct }
 * @param {object} ctx.signal            the TradingView record (technical + analyst)
 * @param {object} ctx.classBand         permitted range for the asset class
 * @param {object} ctx.policy            the investment policy row
 * @param {object} ctx.exposure          { class_weight, concentration_rank, largest_position_weight }
 * @param {object} ctx.worldView         { stance_by_asset_class: { Equities: 'constructive' | 'neutral' | 'cautious' } }
 * @param {object} ctx.performance       { monthly_contribution, total_return }
 */
export function proposeForAsset(ctx) {
  const { asset, position, signal, classBand, exposure = {}, worldView = {} } = ctx;
  const factors = [];
  let score = 0;

  // ── 1. TradingView technical ─────────────────────────────────────────────
  const tech = signal?.technical;
  if (tech && !tech.unavailable && tech.signal) {
    const s = TECH_SCORE[tech.signal] ?? 0;
    score += s * 1.0;
    factors.push({
      family: 'tradingview_technical',
      label: `Technical rating ${tech.signal} (${tech.timeframe})`,
      label_pt: `Leitura técnica de ${sigPt(tech.signal)} no diário`,
      detail: `Recommend.All ${tech.rating?.toFixed(3)} · moving averages ${tech.moving_averages ?? '—'} · oscillators ${tech.oscillators ?? '—'}${tech.weekly_signal ? ` · weekly ${tech.weekly_signal}` : ''}`,
      detail_pt: `médias móveis ${sigPt(tech.moving_averages)} · osciladores ${sigPt(tech.oscillators)}${tech.weekly_signal ? ` · semanal ${sigPt(tech.weekly_signal)}` : ''}${Number.isFinite(tech.rsi_14) ? ` · RSI ${tech.rsi_14.toFixed(0)}` : ''}`,
      direction: Math.sign(s), weight: 1.0,
    });
  } else {
    factors.push({
      family: 'tradingview_technical',
      label: 'No technical rating available',
      label_pt: 'Sem leitura técnica disponível',
      detail: tech?.reason || 'instrument not covered by the technical scanner',
      detail_pt: 'instrumento não coberto pelo scanner técnico',
      direction: 0, weight: 0, unavailable: true,
    });
  }

  // ── 2. TradingView analyst consensus — independent of the above ──────────
  const an = signal?.analyst;
  if (an && !an.unavailable && an.consensus) {
    const s = ANALYST_SCORE[an.consensus] ?? 0;
    score += s * 1.2;   // sell-side coverage carries slightly more weight than a chart rating
    factors.push({
      family: 'tradingview_analyst',
      label: `Analyst consensus ${an.consensus} (${an.analyst_count} analysts)`,
      label_pt: `Consenso de ${an.analyst_count} analistas: ${sigPt(an.consensus)}`,
      detail_pt: an.target_price?.average != null
        ? `preço-alvo médio ${an.target_price.average.toFixed(2)}${an.implied_upside != null ? ` · ${pct(an.implied_upside)} sobre o último fechamento` : ''} · ${an.breakdown?.buy ?? '—'} compra / ${an.breakdown?.hold ?? '—'} neutro / ${an.breakdown?.sell ?? '—'} venda`
        : `${an.breakdown?.buy ?? '—'} compra / ${an.breakdown?.hold ?? '—'} neutro / ${an.breakdown?.sell ?? '—'} venda`,
      detail: an.target_price?.average != null
        ? `Average target ${an.target_price.average.toFixed(2)}${an.implied_upside != null ? ` · implied ${(an.implied_upside * 100).toFixed(1)}% vs last close` : ''} · split ${an.breakdown?.buy ?? '—'}/${an.breakdown?.hold ?? '—'}/${an.breakdown?.sell ?? '—'} buy/hold/sell`
        : `Split ${an.breakdown?.buy ?? '—'}/${an.breakdown?.hold ?? '—'}/${an.breakdown?.sell ?? '—'} buy/hold/sell`,
      direction: Math.sign(s), weight: 1.2,
    });
  } else {
    factors.push({
      family: 'tradingview_analyst',
      label: 'No analyst consensus available',
      label_pt: 'Sem consenso de analistas disponível',
      detail: an?.reason || 'no sell-side coverage published for this instrument',
      detail_pt: 'nenhuma casa publica recomendação para este instrumento',
      direction: 0, weight: 0, unavailable: true,
    });
  }

  // ── 3. policy band on the asset class ────────────────────────────────────
  const band = bandPosition(exposure.class_weight, classBand);
  if (band.state === 'below_band') {
    score += 1.0;
    factors.push({ family: 'policy_band', label: `${asset.asset_class} below the permitted range`, label_pt: `${classPt(asset.asset_class)} abaixo da faixa permitida`, detail: `Class weight ${(exposure.class_weight * 100).toFixed(1)}% against a minimum of ${(band.min * 100).toFixed(1)}%`, detail_pt: `classe em ${pct(exposure.class_weight)} contra um mínimo de ${pct(band.min, 0)}`, direction: 1, weight: 1.0 });
  } else if (band.state === 'above_band') {
    score -= 1.4;
    factors.push({ family: 'policy_band', label: `${asset.asset_class} above the permitted range`, label_pt: `${classPt(asset.asset_class)} acima da faixa permitida`, detail: `Class weight ${(exposure.class_weight * 100).toFixed(1)}% against a maximum of ${(band.max * 100).toFixed(1)}%`, detail_pt: `classe em ${pct(exposure.class_weight)} contra um máximo de ${pct(band.max, 0)}`, direction: -1, weight: 1.4 });
  } else if (band.state === 'drifted') {
    factors.push({ family: 'policy_band', label: `${asset.asset_class} drifted from target`, label_pt: `${classPt(asset.asset_class)} afastada do alvo`, detail: `Class weight ${(exposure.class_weight * 100).toFixed(1)}% against a ${(band.target * 100).toFixed(1)}% target`, detail_pt: `classe em ${pct(exposure.class_weight)} contra um alvo de ${pct(band.target, 0)}`, direction: band.gap > 0 ? -1 : 1, weight: 0.4 });
    score += band.gap > 0 ? -0.4 : 0.4;
  } else {
    factors.push({ family: 'policy_band', label: `${asset.asset_class} within the permitted range`, label_pt: `${classPt(asset.asset_class)} dentro da faixa permitida`, detail: classBand ? `${(classBand.min * 100).toFixed(0)}–${(classBand.max * 100).toFixed(0)}% permitted` : 'no band defined', detail_pt: classBand ? `faixa de ${pct(classBand.min, 0)} a ${pct(classBand.max, 0)}` : 'sem faixa definida', direction: 0, weight: 0 });
  }

  // ── 4. single-name concentration ─────────────────────────────────────────
  const w = position?.weight ?? 0;
  const singleNameCap = ctx.policy?.single_name_cap ?? 0.10;
  const concentrationExempt = asset.concentration_exempt ?? asset.type === 'etf';
  if (!concentrationExempt && w > singleNameCap) {
    score -= 1.6;
    factors.push({ family: 'concentration', label: 'Single-name concentration above the policy cap', label_pt: 'Concentração por emissor acima do teto', detail: `Position is ${(w * 100).toFixed(1)}% of the portfolio against a ${(singleNameCap * 100).toFixed(0)}% cap`, detail_pt: `posição em ${pct(w)} da carteira contra um teto de ${pct(singleNameCap, 0)}`, direction: -1, weight: 1.6 });
  } else if (!concentrationExempt && w > singleNameCap * 0.8) {
    score -= 0.5;
    factors.push({ family: 'concentration', label: 'Approaching the single-name cap', label_pt: 'Próximo do teto por emissor', detail: `Position is ${(w * 100).toFixed(1)}% against a ${(singleNameCap * 100).toFixed(0)}% cap`, detail_pt: `posição em ${pct(w)} contra um teto de ${pct(singleNameCap, 0)}`, direction: -1, weight: 0.5 });
  }

  // ── 5. the advisor's own world view ──────────────────────────────────────
  const stance = worldView.stance_by_asset_class?.[asset.asset_class];
  if (stance === 'constructive') { score += 0.6; factors.push({ family: 'advisor_world_view', label: `Advisor stance on ${asset.asset_class}: constructive`, label_pt: `Sua visão sobre ${classPt(asset.asset_class)}: construtiva`, detail: worldView.headline || '', detail_pt: worldView.headline || '', direction: 1, weight: 0.6 }); }
  else if (stance === 'cautious') { score -= 0.6; factors.push({ family: 'advisor_world_view', label: `Advisor stance on ${asset.asset_class}: cautious`, label_pt: `Sua visão sobre ${classPt(asset.asset_class)}: cautelosa`, detail: worldView.headline || '', detail_pt: worldView.headline || '', direction: -1, weight: 0.6 }); }

  // ── 6. data gaps and unresolved corporate actions override everything ────
  // A resolved corporate action (the client already holds the successor line)
  // is context, not a blocker. Only an unresolved one — a ticker that no longer
  // prices — stops the engine from forming a view.
  if (asset.corporate_action_note) {
    factors.push({ family: 'data_integrity', label: 'Corporate action on the record', label_pt: 'Evento societário no histórico', detail: asset.corporate_action_note, detail_pt: asset.corporate_action_note, direction: 0, weight: 0 });
  }
  if (asset.corporate_action) {
    factors.push({ family: 'data_integrity', label: 'Unresolved corporate action', label_pt: 'Evento societário não resolvido', detail: asset.corporate_action, detail_pt: asset.corporate_action, direction: 0, weight: 0, blocking: true });
    return finalise({ ctx, factors, score: 0, forced: ACTIONS.DISCUSS, conflict: false, blockedReason: asset.corporate_action });
  }

  const noSignals = (!tech || tech.unavailable) && (!an || an.unavailable);
  if (noSignals && !position) {
    return finalise({ ctx, factors, score: 0, forced: ACTIONS.DISCUSS, conflict: false, blockedReason: 'no market signal of either family is available for this instrument' });
  }

  // ── signal conflict: the two families genuinely disagree ─────────────────
  const tScore = tech && !tech.unavailable ? TECH_SCORE[tech.signal] ?? 0 : null;
  const aScore = an && !an.unavailable ? ANALYST_SCORE[an.consensus] ?? 0 : null;
  const conflict = tScore != null && aScore != null && Math.sign(tScore) !== 0 && Math.sign(aScore) !== 0 && Math.sign(tScore) !== Math.sign(aScore);

  return finalise({ ctx, factors, score, conflict });
}

function finalise({ ctx, factors, score, conflict = false, forced = null, blockedReason = null }) {
  const { asset, position, signal } = ctx;
  const held = !!position && (position.market_value ?? 0) > 0;

  let action = forced;
  if (!action) {
    if (conflict) action = ACTIONS.DISCUSS;
    else if (score >= 1.8) action = held ? ACTIONS.ADD : ACTIONS.ADD;
    else if (score <= -2.6) action = held ? ACTIONS.EXIT : ACTIONS.HOLD;
    else if (score <= -1.2) action = held ? ACTIONS.REDUCE : ACTIONS.HOLD;
    else action = held ? ACTIONS.HOLD : ACTIONS.DISCUSS;
  }

  const conviction = Math.min(1, Math.abs(score) / 3.5);
  return {
    asset_id: asset.id,
    ticker: asset.ticker,
    name: asset.name,
    asset_class: asset.asset_class,
    portfolio_role: asset.portfolio_role || (held ? 'existing holding' : 'candidate'),
    held,
    current_weight: position?.weight ?? 0,
    market_value: position?.market_value ?? 0,
    proposed_action: action,
    score: Number(score.toFixed(3)),
    conviction: Number(conviction.toFixed(2)),
    signal_conflict: conflict,
    blocked_reason: blockedReason,
    technical_signal: signal?.technical?.unavailable ? null : signal?.technical?.signal ?? null,
    analyst_signal: signal?.analyst?.unavailable ? null : signal?.analyst?.consensus ?? null,
    analyst_count: signal?.analyst?.analyst_count ?? null,
    target_price: signal?.analyst?.target_price?.average ?? null,
    implied_upside: signal?.analyst?.implied_upside ?? null,
    tradingview_signal_id: signal?.signal_id ?? null,
    factors,
    advisor_status: 'proposed',
  };
}

/** Run the engine across every held position plus the approved candidate list. */
export function buildRecommendations({ assets, positions, signals, policy, bands, exposures, worldView, candidates = [] }) {
  const byAsset = new Map(positions.map((p) => [p.asset_id, p]));
  const universe = [...new Set([...positions.map((p) => p.asset_id), ...candidates])];

  return universe.map((assetId) => {
    const asset = assets.find((a) => a.id === assetId);
    if (!asset) return null;
    return proposeForAsset({
      asset,
      position: byAsset.get(assetId) || null,
      signal: signals[asset.tv_symbol] || signals[assetId] || null,
      classBand: bands?.[asset.asset_class] || null,
      policy,
      exposure: { class_weight: exposures?.[asset.asset_class] ?? 0 },
      worldView,
    });
  }).filter(Boolean);
}
