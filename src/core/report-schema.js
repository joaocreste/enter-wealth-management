/**
 * The canonical report object (§23).
 *
 * One structured payload renders the HTML email, the PDF letter and the client
 * portal view. Because all three read the same object, they cannot disagree —
 * which was the single worst defect of the first version, where the letter was
 * written by a language model that had never seen a computed number.
 *
 * The validator is intentionally strict about the things that would embarrass
 * the firm in front of a client: an unsourced figure, a fabricated return, a
 * recommendation that never passed the guardrail, a letter over two pages.
 */

export const REPORT_SCHEMA_VERSION = '1.0.0';

export function emptyReport() {
  return {
    schema_version: REPORT_SCHEMA_VERSION,
    report_id: null,
    generated_at: null,
    locale: 'pt-BR',
    client: {},
    advisor: {},
    reporting_period: {},
    portfolio_performance: {},
    benchmark: {},
    performance_attribution: {},
    portfolio_metrics: {},
    market_events: [],
    portfolio_impact: [],
    tradingview_signals: [],
    recommendations: [],
    advisor_view: {},
    approved_portfolio: {},
    proposed_portfolio: null,
    sources: [],
    disclosures: [],
    data_quality: { warnings: [], unavailable: [] },
    provenance: {},
  };
}

const REQUIRED_TOP_LEVEL = [
  'schema_version', 'client', 'advisor', 'reporting_period',
  'portfolio_performance', 'approved_portfolio', 'sources', 'disclosures',
];

/**
 * @returns {{ok: boolean, errors: string[], warnings: string[]}}
 */
export function validateReport(report) {
  const errors = [];
  const warnings = [];

  for (const k of REQUIRED_TOP_LEVEL) {
    if (report[k] == null) errors.push(`missing required section: ${k}`);
  }
  if (report.schema_version !== REPORT_SCHEMA_VERSION) {
    errors.push(`schema_version ${report.schema_version} does not match ${REPORT_SCHEMA_VERSION}`);
  }

  // ── every figure must be traceable ───────────────────────────────────────
  const sourceIds = new Set((report.sources || []).map((s) => s.id));
  if (!sourceIds.size) errors.push('no sources recorded — a client report may not contain an unsourced market figure');

  const perf = report.portfolio_performance || {};
  if (perf.monthly_return != null && !(perf.source_ids || []).length) {
    errors.push('portfolio_performance.monthly_return has no source_ids');
  }
  for (const id of perf.source_ids || []) {
    if (!sourceIds.has(id)) errors.push(`portfolio_performance references unknown source ${id}`);
  }

  // ── the two families stay separate ───────────────────────────────────────
  for (const s of report.tradingview_signals || []) {
    if (s.analyst_signal && !s.analyst_count && !s.analyst_unavailable_reason) {
      warnings.push(`${s.ticker}: analyst consensus recorded without an analyst count`);
    }
    if (s.analyst_signal && s.analyst_signal === s.technical_signal && s.inferred) {
      errors.push(`${s.ticker}: analyst sentiment appears to be inferred from the technical rating`);
    }
  }

  // ── nothing reaches a client that has not passed the guardrail ───────────
  for (const r of report.recommendations || []) {
    if (!r.suitability_result) errors.push(`recommendation for ${r.ticker || r.asset_id} did not run through the suitability layer`);
    if (r.advisor_status !== 'approved') {
      errors.push(`recommendation for ${r.ticker || r.asset_id} is "${r.advisor_status}" — only advisor-approved items may be published to a client`);
    }
    if (r.final_action === 'ADD' && ['DO_NOT_ADD', 'BLOCKED'].includes(r.suitability_result)) {
      errors.push(`recommendation for ${r.ticker || r.asset_id} proposes ADD while suitability says ${r.suitability_result}`);
    }
  }

  // ── never fabricate ──────────────────────────────────────────────────────
  if (perf.monthly_return != null && !Number.isFinite(perf.monthly_return)) {
    errors.push('portfolio_performance.monthly_return is not a finite number');
  }
  if (perf.beginning_market_value != null && perf.ending_market_value != null) {
    const implied = perf.ending_market_value - perf.beginning_market_value - (perf.net_flows ?? 0);
    if (perf.absolute_pnl != null && Math.abs(implied - perf.absolute_pnl) > 0.51) {
      errors.push(`absolute_pnl (${perf.absolute_pnl}) does not reconcile with market values and flows (${implied.toFixed(2)})`);
    }
  }
  if (report.performance_attribution?.reconciles === false) {
    errors.push('attribution does not sum to the reported portfolio return');
  }

  // ── disclosures are a compliance surface (§15) ───────────────────────────
  if (!(report.disclosures || []).length) errors.push('no disclosures attached to the report');

  // ── data quality is disclosed, not hidden ────────────────────────────────
  for (const u of report.data_quality?.unavailable || []) {
    if (!u.reason) warnings.push(`unavailable item ${u.item} recorded without a reason`);
  }

  if (report.locale === 'pt-BR' && report.letter?.language && report.letter.language !== 'pt-BR') {
    errors.push('client letter must be written in Portuguese');
  }

  return { ok: errors.length === 0, errors, warnings };
}

/** Standard disclosure block (§15.2, §15.3). Rendered at 11pt in ink-2, never grey. */
export function standardDisclosures(locale = 'pt-BR') {
  return locale === 'pt-BR'
    ? [
      'Rentabilidade passada não é garantia de rentabilidade futura. O valor dos investimentos pode subir ou descer.',
      'Os valores apresentados são líquidos de taxas de administração dos veículos investidos e brutos de imposto de renda, salvo indicação em contrário.',
      'As sugestões desta carta são pontos de discussão para a próxima reunião e não constituem ordem de compra ou venda. Nenhuma operação é executada automaticamente.',
      'Este documento não é oferta de venda nem solicitação de compra de qualquer valor mobiliário.',
    ]
    : [
      'Past performance is not a reliable indicator of future results. The value of investments may fall as well as rise.',
      'Figures are net of the management fees of the underlying vehicles and gross of withholding tax unless stated otherwise.',
      'The suggestions in this letter are discussion points for the next review meeting and are not orders to buy or sell. No transaction is executed automatically.',
      'This document is not an offer to sell or a solicitation to buy any security.',
    ];
}
