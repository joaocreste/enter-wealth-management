/**
 * Event / threshold monitoring (§7).
 *
 * The evaluator is pure. Every threshold, comparator, persistence window and
 * affected-asset-class mapping is DATA, loaded from the triggers table, so a
 * desk can add "Bund 10Y above 3.20%" without a code change or a deployment.
 */

/** Asset-class names as a Brazilian advisor reads them (§5.7). */
const CLASS_PT = {
  Cash: 'caixa', 'Fixed Income': 'renda fixa', 'Equities BR': 'renda variável Brasil',
  'Equities Global': 'renda variável global', Alternatives: 'multimercado e alternativos',
  'Real Estate': 'imobiliário listado', Commodities: 'commodities', 'Digital Assets': 'ativos digitais',
};
const classPt = (k) => CLASS_PT[k] || k;

const COMPARATORS = {
  gt: (v, t) => v > t,
  gte: (v, t) => v >= t,
  lt: (v, t) => v < t,
  lte: (v, t) => v <= t,
  abs_gt: (v, t) => Math.abs(v) > t,
};

export const TRIGGER_STATUS = { ARMED: 'ARMED', APPROACHING: 'APPROACHING', BREACHED: 'BREACHED', NO_DATA: 'NO_DATA' };

/**
 * @param {object} trigger  { id, label, indicator_key, field, comparator, threshold, unit,
 *                            approach_ratio, persistence_days, asset_classes, action }
 * @param {object} reading  { value, asOf, history?: [{date, value}] }
 */
export function evaluateTrigger(trigger, reading) {
  if (!reading || reading.unavailable || reading.value == null || !Number.isFinite(reading.value)) {
    return {
      trigger_id: trigger.id,
      label: trigger.label,
      status: TRIGGER_STATUS.NO_DATA,
      observed: null,
      threshold: trigger.threshold,
      unit: trigger.unit,
      asset_classes: trigger.asset_classes || [],
      action: trigger.action,
      action_pt: trigger.action_pt ?? null,
      reason: reading?.reason || 'indicator unavailable',
      source_id: null,
    };
  }

  const cmp = COMPARATORS[trigger.comparator] || COMPARATORS.gt;
  const v = reading.value;
  let breached = cmp(v, trigger.threshold);

  // Persistence: "VIX above 30 for five sessions" is a different statement from
  // "VIX touched 30 once". When a window is configured the history decides.
  let persistenceMet = true;
  if (breached && trigger.persistence_days > 1) {
    const hist = (reading.history || []).slice(-trigger.persistence_days);
    persistenceMet = hist.length >= trigger.persistence_days && hist.every((h) => cmp(h.value, trigger.threshold));
    if (!persistenceMet) breached = false;
  }

  let status = TRIGGER_STATUS.ARMED;
  if (breached) status = TRIGGER_STATUS.BREACHED;
  else {
    const ratio = trigger.approach_ratio ?? 0.95;
    const near = ['gt', 'gte'].includes(trigger.comparator)
      ? v >= trigger.threshold * ratio
      : ['lt', 'lte'].includes(trigger.comparator)
        ? v <= trigger.threshold / ratio
        : Math.abs(v) >= trigger.threshold * ratio;
    if (near) status = TRIGGER_STATUS.APPROACHING;
  }

  return {
    trigger_id: trigger.id,
    label: trigger.label,
    status,
    observed: v,
    observed_at: reading.asOf ?? null,
    threshold: trigger.threshold,
    comparator: trigger.comparator,
    unit: trigger.unit,
    distance: trigger.threshold ? v / trigger.threshold - 1 : null,
    persistence_days: trigger.persistence_days ?? 1,
    persistence_met: persistenceMet,
    asset_classes: trigger.asset_classes || [],
    action: trigger.action,
    action_pt: trigger.action_pt ?? null,
    source_id: reading.source?.id ?? null,
  };
}

/**
 * How far a reading has travelled towards its trigger, on a scale where 1.0
 * is the threshold itself: 0.93 is approaching, 1.08 is past it. Works for
 * "above" and "below" triggers alike, and for negative thresholds such as a
 * month-to-date fall, so the portal can draw every trigger as the same bar.
 * null when there is no reading.
 */
export function triggerProximity({ observed, threshold, comparator }) {
  if (observed == null || !Number.isFinite(observed) || threshold == null || threshold === 0) return null;
  const v = observed; const t = threshold;
  if (comparator === 'abs_gt') return Math.abs(v) / Math.abs(t);
  const below = comparator === 'lt' || comparator === 'lte';
  if (t > 0) {
    if (!below) return Math.max(0, v / t);
    return v <= 0 ? 2 : t / v;
  }
  // negative threshold: "down more than 4%" fires when v <= t
  if (below) return v >= 0 ? 0 : v / t;
  return v <= 0 ? 0 : 2;
}

/** Which of the advisor's clients each fired trigger actually touches. */
export function mapTriggersToClients(evaluations, clientExposures) {
  return evaluations.map((e) => {
    if (e.status === TRIGGER_STATUS.NO_DATA) return { ...e, affected_clients: [] };
    const affected = [];
    for (const c of clientExposures) {
      const exposure = (e.asset_classes || []).reduce((a, k) => a + (c.exposures[k] ?? 0), 0);
      if (exposure > 0.005) {
        affected.push({
          client_id: c.client_id,
          client_name: c.client_name,
          exposure,
          asset_classes: (e.asset_classes || []).filter((k) => (c.exposures[k] ?? 0) > 0),
        });
      }
    }
    affected.sort((a, b) => b.exposure - a.exposure);
    return { ...e, affected_clients: affected };
  });
}

/** Allocation drift is a portfolio trigger rather than a market one. */
export function driftTriggers(currentWeights, targetWeights, thresholdPp = 0.05) {
  const out = [];
  const classes = new Set([...Object.keys(currentWeights || {}), ...Object.keys(targetWeights || {})]);
  for (const k of classes) {
    const cur = currentWeights?.[k] ?? 0;
    const tgt = targetWeights?.[k] ?? 0;
    const drift = cur - tgt;
    if (Math.abs(drift) >= thresholdPp) {
      out.push({
        trigger_id: `drift_${k.toLowerCase().replace(/\s+/g, '_')}`,
        label: `${k} allocation drift beyond ±${(thresholdPp * 100).toFixed(0)} p.p.`,
        label_pt: `Desvio de ${classPt(k)} além de ±${(thresholdPp * 100).toFixed(0)} p.p.`,
        status: TRIGGER_STATUS.BREACHED,
        observed: cur, threshold: tgt, unit: 'weight',
        drift,
        asset_classes: [k],
        action: drift > 0
          ? `Discuss trimming ${k} back toward the ${(tgt * 100).toFixed(0)}% target.`
          : `Discuss topping up ${k} toward the ${(tgt * 100).toFixed(0)}% target.`,
        action_pt: drift > 0
          ? `Avaliar reduzir ${classPt(k)} de volta ao alvo de ${(tgt * 100).toFixed(0)}%.`
          : `Avaliar reforçar ${classPt(k)} em direção ao alvo de ${(tgt * 100).toFixed(0)}%.`,
        kind: 'portfolio_drift',
      });
    }
  }
  return out.sort((a, b) => Math.abs(b.drift) - Math.abs(a.drift));
}
