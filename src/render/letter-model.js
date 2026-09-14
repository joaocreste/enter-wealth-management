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
import { withinPolicy, policyFitLabel } from '../core/suitability.js';
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

/**
 * What the client reads in the "sugestão" column, and it has three values.
 *
 * The engine's own vocabulary has five, but two of them are not suggestions
 * about a position. EXIT is a REDUCE that goes to zero, and the sentence under
 * the row says so. DISCUSS is what the guardrail returns when it refuses a buy
 * or when the signals disagree — nothing changes until the meeting, which is
 * exactly what "manter" means. The whole letter is already a set of discussion
 * points, so a row labelled "discutir" told the client nothing.
 */
const ACTION_PT = {
  ADD: 'Aumentar',
  HOLD: 'Manter',
  REDUCE: 'Reduzir',
  EXIT: 'Reduzir',
  DISCUSS: 'Manter',
};

const ACTION_EN = { ADD: 'Increase', HOLD: 'Hold', REDUCE: 'Reduce', EXIT: 'Reduce', DISCUSS: 'Hold' };

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

/**
 * The house view, or nothing at all.
 *
 * A World Overview generated without a language model carries neutral stances
 * and a rationale that says, in as many words, that the advisor must set them
 * before using the view with a client. Handing that to the letter would put an
 * opinion in the firm's mouth that the firm never formed, so an unformed view
 * reaches the letter as null and the letter simply has no house-view paragraph.
 */
export function houseView(wv) {
  if (!wv) return null;
  const commentary = wv.advisor_commentary || null;
  const formed = !wv.generated_without_model && wv.mode !== 'deterministic_template';
  if (!commentary && !formed) return null;
  const b = wv.briefing || {};
  return {
    headline: wv.headline_pt || wv.headline || null,
    summary: formed ? (wv.summary_pt || wv.generated_summary || null) : null,
    commentary,
    main_risk: formed ? (b.main_risk_or_opportunity_pt || b.main_risk_or_opportunity || null) : null,
    // Stances only count as the house's when a person or a model actually set them.
    stance_by_asset_class: formed || commentary ? wv.stance_by_asset_class : null,
  };
}

/**
 * What the model returned, checked against the facts it was given.
 *
 * Two things are enforced here and nowhere else. The letter must have the shape
 * of a letter — a title, a greeting, four to six paragraphs and a sign-off — and
 * it must not contain a digit that did not come from FACTS.labels. The second
 * check is the reason the facts carry formatted strings: comparing the digits a
 * model wrote against the digits it was given is exact, where re-deriving a
 * number from a float and hoping the rounding matches is not.
 *
 * @throws when the reply cannot be used, so the caller can ask again or fall
 *         back to the deterministic text.
 */
export function sanitiseLetter(data, facts) {
  if (!data || typeof data !== 'object') throw new Error('model returned no object');
  const paragraphs = (Array.isArray(data.paragraphs) ? data.paragraphs : [])
    .map((x) => String(x ?? '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  if (paragraphs.length < 4) throw new Error(`letter has ${paragraphs.length} paragraphs, needs at least 4`);
  if (!data.title) throw new Error('letter has no title');

  const letter = {
    title: clip(data.title, 80),
    greeting: clip(data.greeting || `Prezado ${facts?.client?.first_name || ''},`, 60),
    paragraphs: paragraphs.slice(0, 6).map((x) => clip(x, 900)),
    sign_off: clip(data.sign_off || 'Um abraço,', 40),
    language: 'pt-BR',
  };

  const stray = strayNumbers([letter.title, ...letter.paragraphs].join(' '), facts);
  if (stray.length) throw new Error(`letter contains ${stray.length} figure(s) not in FACTS: ${stray.join(', ')}`);
  return letter;
}

const clip = (t, n) => {
  const s = String(t ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s;
};

/**
 * Every run of digits the letter writes that FACTS never offered it.
 *
 * The allowed set is drawn from the STRINGS in FACTS and never from its numbers.
 * That distinction is the whole check. A string is text the model was given and
 * may reuse — a formatted label, a date, an asset called "iShares S&P 500" or
 * "Azzas 2154". A raw number is a float the model was told not to format, so
 * letting its digits through would legitimise exactly the invented figure this
 * is here to catch.
 */
export function strayNumbers(text, facts) {
  const allowed = new Set();
  const walk = (v, depth = 0) => {
    if (depth > 8 || v == null) return;
    if (typeof v === 'string') {
      for (const run of v.match(/\d+/g) || []) allowed.add(run);
      return;
    }
    if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return; }
    if (typeof v === 'object') { for (const x of Object.values(v)) walk(x, depth + 1); }
  };
  walk(facts);
  // Small counts are the letter's own arithmetic over things it can see —
  // "três coisas", "dois nomes" — and are allowed as digits too.
  for (let i = 0; i <= 12; i += 1) allowed.add(String(i));

  const stray = [];
  for (const run of String(text || '').match(/\d+/g) || []) {
    if (!allowed.has(run) && !stray.includes(run)) stray.push(run);
  }
  return stray;
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
    action_label: (L === 'pt-BR' ? ACTION_PT : ACTION_EN)[r.final_action] || r.final_action,
    weight: r.current_weight,
    weight_label: fmtWeight(r.current_weight, { locale: L, decimals: 1 }),
    technical: L === 'pt-BR' ? (r.technical_signal ? SIGNAL_PT[r.technical_signal] || r.technical_signal : null) : r.technical_signal,
    analyst: L === 'pt-BR' ? (r.analyst_signal ? SIGNAL_PT[r.analyst_signal] || r.analyst_signal : null) : r.analyst_signal,
    analyst_count: r.analyst_count,
    analyst_missing_label: r.analyst_signal ? null : (L === 'pt-BR' ? 'Sem consenso de analistas' : 'No analyst consensus available'),
    conflict: r.signal_conflict,
    suitability: r.suitability_result,
    within_policy: withinPolicy(r),
    suitability_label: policyFitLabel(r, L),
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
    opening_weight: a.opening_weight ?? null,
  }));

  /**
   * Where each class stands against the policy, on the five-step scale a client
   * sees in every XP positioning chart, and which way its weight moved over the
   * month the letter covers.
   *
   * The step is read from the policy itself, not from an opinion: the permitted
   * range is the scale, the target is its centre, and a class outside its band
   * sits at the end of the scale. So the chart cannot disagree with the table in
   * the annex — the same two numbers decide both.
   */
  const stance = allocation.map((a) => {
    const open = a.opening_weight;
    const delta = open == null ? null : a.weight - open;
    return {
      label: a.asset_class,
      step: stanceStep(a.weight, a.target, a.range),
      weight_label: a.weight_label,
      target_label: a.target_label,
      // A tenth of a percentage point either way is the portfolio breathing,
      // not a decision; it reads as unchanged.
      change: delta == null ? null : delta > 0.001 ? 'up' : delta < -0.001 ? 'down' : 'flat',
    };
  });

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
    /**
     * The letter is one piece of writing: a title, a greeting, the paragraphs
     * and a sign-off. It used to be eight labelled fields, one per section, and
     * that is precisely why it never read like a letter.
     */
    letter: {
      title: letter.title || null,
      greeting: letter.greeting || null,
      paragraphs: Array.isArray(letter.paragraphs) ? letter.paragraphs.filter(Boolean) : [],
      sign_off: letter.sign_off || null,
    },
    /** The correspondence head: where and when it was written, and to whom. */
    dateline: {
      place_date: `São Paulo, ${dateLong(report.generated_at?.slice(0, 10) || report.reporting_period?.end, L)}`,
      to: report.client?.name || '',
      to_line: [
        // "Perfil moderado" agrees; "Carteira moderado" does not, and the
        // profile names are masculine nouns in the policy.
        report.client?.risk_profile ? `Perfil ${String(report.client.risk_profile).toLowerCase()}` : null,
        `posição de ${dateLong(report.reporting_period?.end, L)}`,
      ].filter(Boolean).join(' · '),
    },
    annex_title: `Anexo · Sua carteira em ${dateLong(report.reporting_period?.end, L)}`,
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
    stance,
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

/**
 * Which of the five steps a class sits on: −2 and +2 are outside the permitted
 * range, −1 and +1 are inside it but away from the target, 0 is at the target.
 *
 * The two halves of the band are measured separately because a policy rarely
 * makes them symmetrical: a class with a target of 10 % and a range of 5–20 %
 * has twice the room above the target that it has below it, and reading both
 * sides off the same width would call the same drift neutral going up and
 * overweight going down.
 *
 * Without a target or a range there is nothing to be over or under, and the
 * class sits at the centre rather than being placed by a number nobody agreed.
 */
export function stanceStep(weight, target, range) {
  if (weight == null || target == null || !range || range.min == null || range.max == null) return 0;
  const d = weight - target;
  const room = d >= 0 ? range.max - target : target - range.min;
  if (!(room > 0)) return d > 0 ? 2 : d < 0 ? -2 : 0;
  const r = d / room;
  if (r >= 1) return 2;
  if (r <= -1) return -2;
  if (r >= 1 / 3) return 1;
  if (r <= -1 / 3) return -1;
  return 0;
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

export { ACTION_PT, ACTION_EN, SECTIONS_PT, SECTIONS_EN, ASSET_CLASS_PT, SIGNAL_PT };
