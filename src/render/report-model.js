/**
 * The two-page portfolio report: the analysis, the facts the narrative is
 * written from, and the display model the renderer draws — pure functions
 * over the state the report agent gathers, so they run in Node for tests.
 *
 * Nothing here calls a provider. Every figure the report prints is computed
 * from the approved snapshot, the return history, the month's profitability
 * and the day's World Overview, and the model carries only formatted strings
 * plus the numbers a chart or a colour needs.
 */
import { money, percent, pp, weight as fmtWeight, num, dateLong, monthLabel } from '../core/format.js';
import { historicalMetrics } from '../core/performance.js';
import { standardDisclosures } from '../core/report-schema.js';

const L = 'pt-BR';
export const CLASS_PT = {
  Cash: 'Caixa', 'Fixed Income': 'Renda fixa', 'Equities BR': 'Renda variável Brasil',
  'Equities Global': 'Renda variável global', Alternatives: 'Multimercado e alternativos',
  'Real Estate': 'Imobiliário listado', Commodities: 'Commodities', 'Digital Assets': 'Ativos digitais', Other: 'Outros',
};
const classPt = (k) => CLASS_PT[k] || k || 'Outros';
const CLASS_ORDER = ['Cash', 'Fixed Income', 'Equities BR', 'Equities Global', 'Alternatives', 'Real Estate', 'Commodities', 'Digital Assets'];
/** The brand's pie: cash charcoal, fixed income copper, equity grey; the rest from the palette. Stable per class across reports. */
const CLASS_COLOR = {
  Cash: '#45484A', 'Fixed Income': '#C57D5C', 'Equities BR': '#2A3B43', 'Equities Global': '#7F7F7F',
  Alternatives: '#A1A894', 'Real Estate': '#828D6F', Commodities: '#654339', 'Digital Assets': '#BFBFBF', Other: '#D9D9D9',
};
const MONTHS_PT = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
const MONTHS_LONG = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const RATE_KEYS = new Set(['selic', 'ipca']);
const ACTION_PT = { ADD: 'Aumentar', REDUCE: 'Reduzir', EXIT: 'Encerrar', DISCUSS: 'Discutir' };
const KIND = {
  above_band: ['Classe acima da faixa', 0], concentration: ['Concentração por emissor', 0], corporate_action: ['Evento societário', 0],
  trigger: ['Limiar de mercado rompido', 1], recommendation: ['Recomendação aprovada', 1], below_band: ['Classe abaixo da faixa', 1],
  drift: ['Desvio do alvo', 2], signal_conflict: ['Sinais divergentes', 2],
};
const SEV = { high: 0, medium: 1, low: 2 };

const compound = (rs) => rs.reduce((a, r) => a * (1 + r), 1) - 1;
const dmy = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '');
const lastDay = (ym) => { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).getUTCDate(); };

/** A level as the World Overview prints it. */
function levelText(price, unit) {
  if (price == null || !Number.isFinite(price)) return null;
  if (['%', '% a.a.', '% a.m.'].includes(unit)) return `${num(price, { locale: L, decimals: 2 })}%${unit === '% a.a.' ? ' a.a.' : unit === '% a.m.' ? ' a.m.' : ''}`;
  if (unit === 'USD' || unit === 'USD/oz') return `US$ ${num(price, { locale: L, decimals: price >= 1000 ? 0 : 2 })}`;
  if (unit === 'USD/bbl' || unit === 'USD/lb') return `US$ ${num(price, { locale: L, decimals: 2 })}`;
  if (unit === 'BRL') return `R$ ${num(price, { locale: L, decimals: 4 })}`;
  return num(price, { locale: L, decimals: price >= 1000 ? 0 : 2 });
}

function indicatorRow(i) {
  const isRate = RATE_KEYS.has(i.key);
  return {
    key: i.key, label: i.label, level: levelText(i.price, i.unit),
    day: isRate ? null : (Number.isFinite(i.changePct) ? i.changePct : null),
    d30: isRate ? null : (Number.isFinite(i.d30Pct) ? i.d30Pct : null),
    is_rate: isRate,
  };
}

// ── 2 · análise ────────────────────────────────────────────────────────────
export function analyseForReport(s) {
  const history = [...(s.returns_history || [])].filter((r) => Number.isFinite(r.portfolio)).sort((a, b) => a.month.localeCompare(b.month));
  const upto = history.filter((r) => r.month <= s.month);
  const year = s.month.slice(0, 4);
  const inYear = upto.filter((r) => r.month.startsWith(year));
  const last12 = upto.slice(-12);
  const last36 = upto.slice(-36);
  const port = (rows) => (rows.length ? compound(rows.map((r) => r.portfolio)) : null);
  const bench = (rows) => { const v = rows.map((r) => r.benchmark).filter(Number.isFinite); return rows.length && v.length === rows.length ? compound(v) : null; };

  const monthRow = upto.find((r) => r.month === s.month) || null;
  const perf = s.perf?.performance || null;
  const monthly = Number.isFinite(perf?.monthly_return) ? perf.monthly_return : (monthRow?.portfolio ?? null);
  const benchMonth = Number.isFinite(s.perf?.benchmark?.value) ? s.perf.benchmark.value : (monthRow?.benchmark ?? null);
  const metricsIn = s.perf?.metrics?.available ? s.perf.metrics : historicalMetrics(upto.map((r) => ({ month: r.month, value: r.portfolio })));
  const metrics = metricsIn?.available ? {
    volatility: metricsIn.annualised_volatility, sharpe: metricsIn.sharpe_ratio ?? null, max_drawdown: metricsIn.max_drawdown,
    from: metricsIn.period?.from, to: metricsIn.period?.to, observations: metricsIn.observations, annualised: metricsIn.annualised_return,
  } : null;

  // the monthly matrix: one row per year, newest first, as the fund sheets print it
  const years = [...new Set(upto.map((r) => r.month.slice(0, 4)))].sort().reverse();
  const matrix = years.map((y) => {
    const rows = upto.filter((r) => r.month.startsWith(y));
    const cells = Array.from({ length: 12 }, (_, i) => rows.find((r) => Number(r.month.slice(5, 7)) === i + 1)?.portfolio ?? null);
    return { year: y, cells, total: port(rows), partial: rows.length < 12 };
  });

  // the cumulative curve, portfolio and reference
  let p = 1; let b = 1;
  const series = { portfolio: [], benchmark: [] };
  for (const r of upto) {
    p *= 1 + r.portfolio; series.portfolio.push({ month: r.month, value: p - 1 });
    if (Number.isFinite(r.benchmark)) { b *= 1 + r.benchmark; series.benchmark.push({ month: r.month, value: b - 1 }); }
  }

  // allocation against the policy: a position on the underweight/overweight scale and a change since the previous snapshot
  const byClass = new Map();
  for (const pos of s.positions || []) {
    const k = pos.asset_class || 'Other';
    const e = byClass.get(k) || { value: 0, items: [] };
    e.value += pos.market_value || 0; e.items.push(pos); byClass.set(k, e);
  }
  const total = s.total || [...byClass.values()].reduce((a, e) => a + e.value, 0) || 1;
  const tol = s.policy?.rebalance_trigger ?? 0.05;
  const targets = s.policy?.target_allocation || {};
  const ranges = s.policy?.permitted_ranges || {};
  const keys = [...new Set([...CLASS_ORDER.filter((k) => byClass.has(k) || (targets[k] ?? 0) > 0), ...byClass.keys()])];
  const allocation = keys.map((k) => {
    const e = byClass.get(k);
    const w = e ? e.value / total : 0;
    const target = targets[k] ?? null;
    const range = ranges[k] ?? null;
    let position = 0;
    if (range && w < range.min - 1e-9) position = -2;
    else if (range && w > range.max + 1e-9) position = 2;
    else if (target != null && w < target - tol) position = -1;
    else if (target != null && w > target + tol) position = 1;
    const prev = s.previous_weights ? (s.previous_weights[k] ?? 0) : null;
    const change = prev == null ? null : (w - prev > 0.01 ? 1 : w - prev < -0.01 ? -1 : 0);
    return {
      asset_class: k, label: classPt(k), weight: w, value: e?.value ?? 0, target, min: range?.min ?? null, max: range?.max ?? null,
      position, change, outside_band: position === -2 || position === 2, color: CLASS_COLOR[k] || CLASS_COLOR.Other,
    };
  }).filter((a) => a.weight > 0.0005 || (a.target ?? 0) > 0);
  const composition = allocation.filter((a) => a.weight > 0.0005).sort((x, y) => y.weight - x.weight).map((a) => ({
    ...a,
    items: (byClass.get(a.asset_class)?.items || []).slice().sort((x, y) => (y.market_value || 0) - (x.market_value || 0))
      .map((i) => ({ name: i.name, ticker: i.ticker, weight: i.weight, value: i.market_value })),
  }));

  // discussion points: the meeting preparation, the day's breached thresholds and the approved recommendations
  const points = [];
  for (const o of s.discussion_opportunities || []) points.push({ kind: o.kind, severity: o.severity || 'medium', title: KIND[o.kind]?.[0] || 'Ponto de atenção', text: o.message, asset_class: o.asset_class || null });
  for (const t of s.overview?.triggers || []) points.push({ kind: 'trigger', severity: 'high', title: KIND.trigger[0], text: `${t.label}. ${t.action_pt || t.action || ''}`.trim() });
  for (const r of s.recommendations || []) {
    const act = ACTION_PT[r.final_action] || r.final_action;
    points.push({
      kind: 'recommendation', severity: r.suitability_result === 'PASS' ? 'medium' : 'high', title: `${act}: ${r.ticker || r.name}`,
      text: r.rationale || `${act} ${r.name}${r.current_weight ? `, hoje ${fmtWeight(r.current_weight, { locale: L, decimals: 1 })} da carteira` : ''}. Sugestão para discussão, não uma ordem.`,
    });
  }
  const seen = new Set();
  const discussion = points
    .filter((x) => x.text && !seen.has(x.text.slice(0, 80)) && seen.add(x.text.slice(0, 80)))
    .sort((a, b) => (SEV[a.severity] ?? 1) - (SEV[b.severity] ?? 1) || (KIND[a.kind]?.[1] ?? 3) - (KIND[b.kind]?.[1] ?? 3))
    .slice(0, 6);   // what two pages hold at full budget; the headline and the callouts then agree

  // the market table, two blocks as the Comitê prints its indices
  const inds = new Map((s.overview?.indicators || []).map((i) => [i.key, i]));
  const block = (title, ks) => ({ title, rows: ks.map((k) => inds.get(k)).filter(Boolean).map(indicatorRow) });
  const market_blocks = [
    block('Bolsas e juros', ['sp500', 'nasdaq', 'ibovespa', 'vix', 'us10y', 'selic', 'ipca', 'hy_etf']),
    block('Câmbio, commodities e digitais', ['usdbrl', 'dxy', 'eurusd', 'gold', 'brent', 'copper', 'btc', 'eth']),
  ];

  const at = s.perf?.attribution || null;
  const worst = at?.top_negative?.[0] || at?.worst_contributor || null;
  const best = at?.top_positive?.[0] || null;
  const sources = [...new Set([...(s.perf?.sources || []), ...(s.overview?.sources || []), ...(s.recommendations?.length ? ['TradingView'] : [])])]
    .map((x) => String(x).replace(/\s*\(.*\)$/, '')).filter((x, i, arr) => arr.indexOf(x) === i);

  return {
    monthly, benchMonth, excess: monthly != null && benchMonth != null ? monthly - benchMonth : null, pnl: perf?.absolute_pnl ?? null,
    ytd: port(inYear), ytdB: bench(inYear),
    twelve: last12.length >= 12 ? port(last12) : null, twelveB: last12.length >= 12 ? bench(last12) : null,
    three_year: last36.length >= 36 ? port(last36) : null,
    since: port(upto), sinceB: bench(upto), since_from: upto[0]?.month || null,
    metrics, matrix, series, allocation, composition, discussion, market_blocks,
    worst: worst ? { name: worst.ticker || worst.name, contribution: worst.contribution } : null,
    best: best ? { name: best.ticker || best.name, contribution: best.contribution } : null,
    fx: Number.isFinite(at?.fx_contribution) ? at.fx_contribution : null,
    sources, simulated_history: upto.some((r) => r.method === 'reconstructed_from_statements'),
  };
}

// ── 3 · redação: the facts the model (or the template) writes from ─────────
const POSITION_PT = { '-2': 'abaixo da faixa', '-1': 'abaixo do alvo', 0: 'no alvo', 1: 'acima do alvo', 2: 'acima da faixa' };
const POSITION_SYM = { '-2': '--', '-1': '-', 0: '=', 1: '+', 2: '++' };

export function factsForNarrative(s) {
  const a = s.analysis;
  const pct = (v, o = {}) => (v == null ? null : percent(v, { locale: L, ...o }));
  return {
    date: s.date, month: s.month, month_label: monthLabel(s.month, L),
    client: { name: s.client.name, risk_profile: s.client.risk_profile },
    performance: {
      monthly_return_label: pct(a.monthly), absolute_pnl_label: a.pnl == null ? null : money(a.pnl, { locale: L, signed: true }),
      benchmark_label: pct(a.benchMonth), excess_label: a.excess == null ? null : pp(a.excess, { locale: L }),
      ytd_label: pct(a.ytd), twelve_months_label: pct(a.twelve), since_start_label: pct(a.since), since_start_from: a.since_from ? monthLabel(a.since_from, L) : null,
      worst: a.worst ? { name: a.worst.name, contribution_label: pp(a.worst.contribution, { locale: L }) } : null,
      best: a.best ? { name: a.best.name, contribution_label: pp(a.best.contribution, { locale: L }) } : null,
      fx_label: a.fx == null ? null : pp(a.fx, { locale: L }),
      volatility_label: pct(a.metrics?.volatility, { signed: false }), max_drawdown_label: pct(a.metrics?.max_drawdown),
    },
    market: s.overview ? {
      date: s.overview.date, headline: s.overview.headline, summary: s.overview.summary, briefing: s.overview.briefing,
      indicators: a.market_blocks.flatMap((b) => b.rows).map((r) => ({ label: r.label, level: r.level, day: pct(r.day, { decimals: 1 }), thirty_days: pct(r.d30, { decimals: 1 }) })),
    } : null,
    allocation: a.allocation.map((x) => ({
      asset_class: x.asset_class, label: x.label, weight_label: fmtWeight(x.weight, { locale: L, decimals: 1 }),
      target_label: x.target == null ? null : fmtWeight(x.target, { locale: L, decimals: 0 }),
      band_label: x.min == null ? null : `${fmtWeight(x.min, { locale: L, decimals: 0 })} a ${fmtWeight(x.max, { locale: L, decimals: 0 })}`,
      position: POSITION_SYM[x.position], position_label: POSITION_PT[x.position], outside_band: x.outside_band,
    })),
    discussion_points: a.discussion.map((d) => ({ kind: d.kind, severity: d.severity, title: d.title, text: d.text })),
    next_meeting: s.next_meeting ? dateLong(s.next_meeting, L) : null,
  };
}

const clip = (t, n) => { const s = String(t ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s; };

/** What the model returned, aligned to the facts: one discussion entry per point, every field a bounded string. */
export function sanitiseNarrative(data, facts) {
  if (!data || typeof data !== 'object' || !data.market_view) throw new Error('model returned no market_view');
  const want = facts.discussion_points || [];
  const got = Array.isArray(data.discussion) ? data.discussion : [];
  return {
    headline: clip(data.headline || '', 120) || null,
    market_view: clip(data.market_view, 900),
    performance_comment: clip(data.performance_comment || '', 700),
    allocation_comment: clip(data.allocation_comment || '', 400),
    discussion: want.map((w, i) => ({ title: clip(got[i]?.title || w.title, 60), text: clip(got[i]?.text || w.text, 340) })),
    language: 'pt-BR',
  };
}

// ── 4 · diagramação: the display model ─────────────────────────────────────
export function buildReportModel(s) {
  const a = s.analysis;
  const n = s.narrative || {};
  const tone = (v) => (v == null ? 'flat' : v > 0 ? 'gain' : v < 0 ? 'loss' : 'flat');
  const pct = (v, o = {}) => (v == null ? '—' : percent(v, { locale: L, ...o }));
  const cell = (v) => (v == null ? '-' : percent(v, { locale: L, signed: false }));
  const [yy, mm] = s.month.split('-').map(Number);
  const [dy, dm, dd] = s.date.split('-').map(Number);
  const monthEndIso = `${s.month}-${String(lastDay(s.month)).padStart(2, '0')}`;

  return {
    locale: L, generated_at: s.date, narrative_mode: s.narrative_mode || 'deterministic_template',
    header: { title_light: 'Relatório', title_bold: 'de carteira', date: `${dd} ${MONTHS_LONG[dm - 1]} ${dy}` },
    data_until: `Dados até ${dateLong(monthEndIso, L)}`,
    client: { name: s.client.name, profile: s.client.risk_profile, segment: s.client.segment || null },
    advisor: { name: s.advisor.name, code: s.advisor.code || null },
    policy: { version: s.policy?.version ?? null, effective: s.policy?.effective_date ? dmy(s.policy.effective_date) : null },
    total_label: money(s.total, { locale: L }),
    positions_count: (s.positions || []).length,
    headline: n.headline || null,
    market_view: n.market_view || '',
    performance_comment: n.performance_comment || '',
    allocation_comment: n.allocation_comment || '',
    market_date: s.overview?.date ? dmy(s.overview.date) : null,
    market_blocks: a.market_blocks.map((b) => ({
      title: b.title,
      rows: b.rows.map((r) => ({ label: r.label, level: r.level || '—', day: r.day == null ? '—' : percent(r.day, { locale: L, decimals: 1 }), day_v: r.day, d30: r.d30 == null ? '—' : percent(r.d30, { locale: L, decimals: 1 }), d30_v: r.d30 })),
    })),
    figures: [
      { label: `No mês · ${MONTHS_PT[mm - 1]}/${String(yy).slice(2)}`, value: pct(a.monthly), tone: tone(a.monthly), emphasis: true },
      { label: 'No ano', value: pct(a.ytd), tone: tone(a.ytd) },
      { label: '12 meses', value: pct(a.twelve), tone: tone(a.twelve) },
      { label: 'Referência no mês', value: pct(a.benchMonth), tone: 'benchmark' },
      { label: 'Diferença no mês', value: a.excess == null ? '—' : pp(a.excess, { locale: L }), tone: tone(a.excess) },
    ],
    chart: {
      title: 'Retorno histórico',
      portfolio: a.series.portfolio, benchmark: a.series.benchmark,
      legend: ['Carteira', 'Carteira de referência da política'],
    },
    performance_block: {
      title: 'Performance %',
      rows: [
        ['No ano', pct(a.ytd)], ['12 meses', pct(a.twelve)],
        ['3 anos', a.three_year == null ? '-' : pct(a.three_year)],
        [`Desde ${a.since_from ? `${MONTHS_PT[Number(a.since_from.slice(5, 7)) - 1].toLowerCase()}/${a.since_from.slice(2, 4)}` : 'o início'}`, pct(a.since)],
      ],
    },
    risk_block: {
      title: 'Risco',
      rows: [
        ['Volatilidade a.a.', a.metrics?.volatility == null ? '-' : pct(a.metrics.volatility, { signed: false })],
        ['Sharpe', a.metrics?.sharpe == null ? '-' : num(a.metrics.sharpe, { locale: L, decimals: 2 })],
        ['Queda máx.', a.metrics?.max_drawdown == null ? '-' : pct(a.metrics.max_drawdown)],
        ['Meses', a.metrics?.observations == null ? '-' : String(a.metrics.observations)],
      ],
    },
    matrix: {
      months: MONTHS_PT,
      rows: a.matrix.map((r) => ({ year: r.year, cells: r.cells.map(cell), values: r.cells, total: r.total == null ? '-' : percent(r.total, { locale: L, signed: false }), total_v: r.total })),
      simulated: a.simulated_history,
    },
    composition: {
      classes: a.composition.map((c) => ({
        label: c.label, weight: c.weight, weight_label: fmtWeight(c.weight, { locale: L, decimals: 1 }), color: c.color,
        items: c.items.map((i) => ({ name: i.ticker ? `${i.ticker} · ${i.name}` : i.name, weight_label: fmtWeight(i.weight, { locale: L, decimals: 1 }) })),
      })),
      total_label: '100,0%',
    },
    pie: a.composition.map((c) => ({ label: c.label, weight: c.weight, color: c.color })),
    alloc_view: a.allocation.map((x) => ({
      label: x.label, position: x.position, change: x.change, outside_band: x.outside_band,
      weight_label: fmtWeight(x.weight, { locale: L, decimals: 1 }), target_label: x.target == null ? '-' : fmtWeight(x.target, { locale: L, decimals: 0 }),
    })),
    discussion: (n.discussion || []).map((d, i) => ({ title: d.title, text: d.text, severity: a.discussion[i]?.severity || 'medium' })),
    next_meeting: s.next_meeting ? dateLong(s.next_meeting, L) : null,
    sources_line: `Fonte: ${a.sources.length ? a.sources.join(', ') : 'registros do custodiante'}. Elaboração: XP Asset Management.${a.simulated_history ? ' O histórico anterior à plataforma foi reconstruído a partir dos extratos e é simulado.' : ''}`,
    disclosures: standardDisclosures(L),
  };
}
