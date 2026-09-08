/**
 * The presentational model of the monthly letter (§22, §23).
 *
 * The HTML email, the PDF and the client portal all call this one function and
 * render what it returns. They cannot show different numbers, different
 * recommendations or different source lines, because there is only one place
 * those are decided.
 *
 * Nothing here computes finance. It formats what the pipeline already computed.
 */
import { money, percent, pp, weight as fmtWeight, monthLabel, dateLong, shortDate, arrow, toneOf, MINUS } from '../core/format.js';
import { SourceLedger } from '../core/sources.js';
import { prepareContribution, preparePortfolioVsBenchmark, prepareAllocation, prepareContributors } from './charts.js';

/** Asset-class and signal vocabulary. §5.7 — the client letter is written in
 *  Portuguese, not translated from an English internal label at render time. */
const ASSET_CLASS_PT = {
  Cash: 'Caixa',
  'Fixed Income': 'Renda fixa',
  'Equities BR': 'Renda variável Brasil',
  'Equities Global': 'Renda variável global',
  Alternatives: 'Multimercado e alternativos',
  'Real Estate': 'Imobiliário listado',
  Commodities: 'Commodities',
  'Digital Assets': 'Ativos digitais',
  Other: 'Outros',
};

const SIGNAL_PT = {
  'Strong Buy': 'Compra forte',
  Buy: 'Compra',
  Neutral: 'Neutro',
  Sell: 'Venda',
  'Strong Sell': 'Venda forte',
};

const SECTIONS_PT = {
  opening: 'Abertura',
  performance: 'Como sua carteira se comportou',
  markets: 'O que aconteceu nos mercados',
  meaning: 'O que isso significa para a sua carteira',
  recommendations: 'O que sugiro discutirmos',
  portfolio: 'Sua carteira hoje',
  closing: 'Encerramento',
};

const SECTIONS_EN = {
  opening: 'Opening',
  performance: 'How your portfolio performed',
  markets: 'What happened in markets',
  meaning: 'What it means for your portfolio',
  recommendations: 'What we recommend discussing',
  portfolio: 'Your portfolio today',
  closing: 'Closing',
};

const ACTION_PT = {
  ADD: 'Aumentar',
  HOLD: 'Manter',
  REDUCE: 'Reduzir',
  EXIT: 'Encerrar',
  DISCUSS: 'Discutir',
};

const SUITABILITY_PT = {
  PASS: 'Dentro da política',
  DISCUSS_ONLY: 'Somente discussão',
  DO_NOT_ADD: 'Não aumentar',
  REDUCE_REQUIRED: 'Redução necessária',
  BLOCKED: 'Vedado pela política',
};

/**
 * What earns a place in a two-page letter.
 *
 * A book of fourteen positions produces fourteen recommendation records, and
 * twelve of them are usually "hold, within policy". Printing all of them buries
 * the two that matter. The letter carries the items that are actually worth a
 * conversation; the portal and the advisor view keep the complete set.
 */
export function letterPriority(r) {
  let score = 0;
  if (r.signal_conflict) score += 3;
  if (r.suitability_result && r.suitability_result !== 'PASS') score += 3;
  if (['ADD', 'REDUCE', 'EXIT'].includes(r.final_action)) score += 2;
  else if (r.final_action === 'DISCUSS') score += 1;
  if ((r.flags || []).some((f) => f.severity === 'high')) score += 1;
  score += Math.min(1, (r.current_weight ?? 0) * 4);
  return score;
}

export function prioritiseForLetter(recommendations, max = 5) {
  const approved = (recommendations || []).filter((r) => r.advisor_status === 'approved');
  const ranked = approved
    .map((r) => ({ r, score: letterPriority(r) }))
    .filter((x) => x.score >= 1)
    .sort((a, b) => b.score - a.score);
  return {
    selected: ranked.slice(0, max).map((x) => x.r),
    omitted: Math.max(0, approved.length - Math.min(ranked.length, max)),
    total_approved: approved.length,
  };
}

export function buildLetterModel(report, { locale = 'pt-BR', maxLetterRecommendations = 5 } = {}) {
  const L = locale;
  const cur = report.client?.base_currency || 'BRL';
  const S = L === 'pt-BR' ? SECTIONS_PT : SECTIONS_EN;
  const classLabel = (k) => (L === 'pt-BR' ? ASSET_CLASS_PT[k] || k : k);
  const perf = report.portfolio_performance || {};
  const attribution = report.performance_attribution || {};
  const bench = report.benchmark || {};
  const letter = report.letter || {};

  const period = {
    month: report.reporting_period?.month,
    label: monthLabel(report.reporting_period?.month, L),
    start: report.reporting_period?.start,
    end: report.reporting_period?.end,
    end_label: dateLong(report.reporting_period?.end, L),
  };

  // ── the headline figures table ────────────────────────────────────────────
  const figures = [
    {
      key: 'monthly_return',
      label: L === 'pt-BR' ? `Rentabilidade em ${period.label}` : `Return in ${period.label}`,
      short_label: L === 'pt-BR' ? 'Rentabilidade no mês' : 'Return for the month',
      value: perf.monthly_return == null ? 'DATA UNAVAILABLE' : percent(perf.monthly_return, { locale: L }),
      tone: toneOf(perf.monthly_return),
      arrow: arrow(perf.monthly_return),
      emphasis: true,
    },
    {
      key: 'absolute_pnl',
      label: L === 'pt-BR' ? 'Resultado no período' : 'Result for the period',
      short_label: L === 'pt-BR' ? 'Resultado em reais' : 'Result',
      value: perf.absolute_pnl == null ? 'DATA UNAVAILABLE' : money(perf.absolute_pnl, { currency: cur, locale: L, signed: true }),
      tone: toneOf(perf.absolute_pnl),
      arrow: arrow(perf.absolute_pnl),
    },
    {
      key: 'benchmark',
      label: L === 'pt-BR' ? 'Carteira de referência' : 'Reference portfolio',
      short_label: L === 'pt-BR' ? 'Referência' : 'Benchmark',
      value: bench.value == null ? (L === 'pt-BR' ? 'Não disponível' : 'Not available') : percent(bench.value, { locale: L }),
      tone: 'benchmark',
      arrow: arrow(bench.value),
    },
    {
      key: 'excess',
      label: L === 'pt-BR' ? 'Diferença' : 'Difference',
      value: bench.comparison?.excess_return == null ? '—' : pp(bench.comparison.excess_return, { locale: L }),
      tone: toneOf(bench.comparison?.excess_return),
      arrow: arrow(bench.comparison?.excess_return),
    },
    {
      key: 'ending_value',
      label: L === 'pt-BR' ? 'Patrimônio em ' + shortDatePt(period.end, L) : 'Value at ' + shortDate(period.end),
      short_label: L === 'pt-BR' ? `Patrimônio em ${period.end.slice(8)}/${period.end.slice(5, 7)}` : `Value at ${shortDate(period.end)}`,
      value: money(perf.ending_market_value, { currency: cur, locale: L }),
      tone: 'flat',
    },
  ];

  if (perf.net_flows) {
    figures.push({
      key: 'flows',
      label: L === 'pt-BR' ? 'Aportes e resgates no mês' : 'Contributions and withdrawals',
      value: money(perf.net_flows, { currency: cur, locale: L, signed: true }),
      tone: 'flat',
    });
  }

  // ── contributors ──────────────────────────────────────────────────────────
  const contributors = {
    positive: (attribution.top_positive || []).map(mapContributor(L)),
    negative: (attribution.top_negative || []).map(mapContributor(L)),
    fx: attribution.fx_contribution,
    fx_label: attribution.fx_contribution == null ? null
      : L === 'pt-BR'
        ? `Efeito do câmbio: ${pp(attribution.fx_contribution, { locale: L })}`
        : `Currency effect: ${pp(attribution.fx_contribution, { locale: L })}`,
  };

  // ── recommendations: only advisor-approved items reach a client ───────────
  const { selected, omitted, total_approved } = prioritiseForLetter(report.recommendations, maxLetterRecommendations);
  const grouped = { ADD: [], HOLD: [], REDUCE: [], EXIT: [], DISCUSS: [] };
  for (const r of selected) (grouped[r.final_action] ||= []).push(r);

  const recommendations = selected.map((r) => ({
    asset_id: r.asset_id,
    ticker: r.ticker,
    name: r.name,
    asset_class: L === 'pt-BR' ? ASSET_CLASS_PT[r.asset_class] || r.asset_class : r.asset_class,
    action: r.final_action,
    action_label: L === 'pt-BR' ? ACTION_PT[r.final_action] || r.final_action : r.final_action,
    weight: r.current_weight,
    weight_label: fmtWeight(r.current_weight, { locale: L, decimals: 1 }),
    technical: L === 'pt-BR' ? (r.technical_signal ? SIGNAL_PT[r.technical_signal] || r.technical_signal : null) : r.technical_signal,
    analyst: L === 'pt-BR' ? (r.analyst_signal ? SIGNAL_PT[r.analyst_signal] || r.analyst_signal : null) : r.analyst_signal,
    analyst_count: r.analyst_count,
    analyst_missing_label: r.analyst_signal ? null : (L === 'pt-BR' ? 'Sem consenso de analistas' : 'No analyst consensus available'),
    conflict: r.signal_conflict,
    suitability: r.suitability_result,
    suitability_label: L === 'pt-BR' ? SUITABILITY_PT[r.suitability_result] || r.suitability_result : (r.statement?.client_suitability ?? r.suitability_result),
    market_signal_line: r.statement?.market_signal ?? null,
    suitability_line: r.statement?.client_suitability ?? null,
    rationale: (L === 'pt-BR' ? r.rationale_pt : r.rationale) || r.rationale_pt || r.rationale || null,
    flags: (r.flags || []).map((f) => ({ ...f, message: (L === 'pt-BR' ? f.message_pt : f.message) || f.message })),
    target_price: r.target_price,
    implied_upside: r.implied_upside,
  }));

  // ── allocation ────────────────────────────────────────────────────────────
  const allocation = (report.approved_portfolio?.allocation || []).map((a) => ({
    asset_class: L === 'pt-BR' ? ASSET_CLASS_PT[a.asset_class] || a.asset_class : a.asset_class,
    asset_class_key: a.asset_class,
    weight: a.weight,
    weight_label: fmtWeight(a.weight, { locale: L, decimals: 1 }),
    value: a.value,
    value_label: money(a.value, { currency: cur, locale: L }),
    target: a.target,
    target_label: a.target == null ? '—' : fmtWeight(a.target, { locale: L, decimals: 0 }),
    range: a.range,
    range_label: a.range ? `${fmtWeight(a.range.min, { locale: L, decimals: 0 })}–${fmtWeight(a.range.max, { locale: L, decimals: 0 })}` : '—',
    inside_band: a.range ? a.weight >= a.range.min && a.weight <= a.range.max : true,
  }));

  // ── events the client actually has exposure to ────────────────────────────
  const impact = (report.portfolio_impact || [])
    .filter((i) => i.relevance === 'high' || i.relevance === 'medium')
    .slice(0, 4)
    .map((i) => ({
      title: (L === 'pt-BR' ? i.title_pt : i.title) || i.title,
      exposure: i.exposure?.total_exposure ?? null,
      exposure_label: i.exposure?.total_exposure == null ? null : fmtWeight(i.exposure.total_exposure, { locale: L, decimals: 1 }),
      impact: (L === 'pt-BR' ? i.potential_impact_pt : i.potential_impact) || i.potential_impact,
      prompt: (L === 'pt-BR' ? i.discussion_prompt_pt : i.discussion_prompt) || i.discussion_prompt,
    }));

  // ── sources, compact enough to respect the two-page limit (§29) ───────────
  const ledger = new SourceLedger();
  ledger.addAll(report.sources || []);
  const sourceLines = ledger.compactLines(L);

  // ── data quality that the client is entitled to see ──────────────────────
  const unavailable = (report.data_quality?.unavailable || []).map((u) => ({
    item: u.item,
    reason: u.reason,
  }));

  return {
    locale: L,
    currency: cur,
    sections: S,
    client: report.client,
    advisor: report.advisor,
    period,
    letter: {
      greeting: letter.greeting,
      opening: letter.opening,
      performance: letter.performance,
      markets: letter.markets,
      meaning: letter.meaning,
      recommendations_intro: letter.recommendations_intro,
      closing: letter.closing,
      sign_off: letter.sign_off,
    },
    figures,
    contributors,
    recommendations,
    recommendation_groups: grouped,
    recommendations_omitted: omitted,
    recommendations_total_approved: total_approved,
    recommendations_omitted_note: omitted > 0
      ? (L === 'pt-BR'
        ? `Outras ${omitted} posições foram revisadas e permanecem enquadradas na sua política, sem mudança sugerida. A lista completa está no seu portal.`
        : `A further ${omitted} positions were reviewed and remain within policy with no change proposed. The full list is in your portal.`)
      : null,
    allocation,
    impact,
    metrics: report.portfolio_metrics,
    policy_version: report.approved_portfolio?.policy_version ?? null,
    method_note: perf.method_note?.[L === 'pt-BR' ? 'pt' : 'en'] || null,
    coverage_note: bench.coverage_note || null,
    charts: {
      contribution: prepareContribution(report, { classLabel }),
      vs_benchmark: preparePortfolioVsBenchmark(report),
      allocation: prepareAllocation(report, { classLabel }),
      contributors: prepareContributors(report),
    },
    sources: report.sources || [],
    source_lines: sourceLines,
    disclosures: report.disclosures || [],
    unavailable,
    provenance: report.provenance || {},
    generated_at: report.generated_at,
  };
}

function mapContributor(L) {
  return (p) => ({
    ticker: p.ticker || p.name,
    name: p.name,
    asset_class: p.asset_class,
    contribution: p.contribution,
    contribution_label: pp(p.contribution, { locale: L }),
    return: p.total_return,
    return_label: p.total_return == null ? '—' : percent(p.total_return, { locale: L }),
    tone: toneOf(p.contribution),
  });
}

function shortDatePt(iso, L) {
  return L === 'pt-BR' ? dateLong(iso, 'pt-BR').replace(/ de (\d{4})$/, ' de $1') : shortDate(iso);
}

export { ACTION_PT, SUITABILITY_PT, SECTIONS_PT, SECTIONS_EN, ASSET_CLASS_PT, SIGNAL_PT };
