/**
 * The two-page client report: the analysis, the facts the narrative is
 * written from, and the display model the renderer draws — pure functions
 * over the state the report agent gathers, so they run in Node for tests.
 *
 * The report is written for the client, not the advisor: it greets them by
 * name, says what is happening in the world and which events matter, shows
 * their performance with the cumulative curve beside the risk-and-return of
 * each asset they hold, says what could improve the result and what could
 * make it worse, and closes with the portfolio as it stands. Every figure is
 * computed here from the approved snapshot, the return history, the month's
 * profitability, the day's World Overview and the twelve-month measurement of
 * each asset; the model carries formatted strings plus the numbers a chart needs.
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
/** The four broad classes of the risk/return chart, in the brand's series colours. */
export const RISK_CLASS_PT = { equity: 'Renda variável', debt: 'Renda fixa e caixa', fx_commodities: 'Câmbio e commodities', crypto_other: 'Multimercado, cripto e outros' };
const RISK_CLASS_COLOR = { equity: '#2A3B43', debt: '#C57D5C', fx_commodities: '#828D6F', crypto_other: '#7F7F7F' };
const MONTHS_LONG = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const ACTION_PT = { ADD: 'Aumentar', REDUCE: 'Reduzir', EXIT: 'Encerrar', DISCUSS: 'Discutir' };
/** Each kind of point: its title, its rank, and whether it is something that could improve the result or something that could make it worse. */
const KIND = {
  concentration: ['Concentração em um emissor', 0, 'worsen'], above_band: ['Classe acima da faixa', 0, 'worsen'], corporate_action: ['Evento societário', 0, 'worsen'],
  trigger: ['Movimento de mercado', 1, 'worsen'], signal_conflict: ['Sinais divergentes', 2, 'worsen'],
  below_band: ['Classe abaixo da faixa', 1, 'improve'], drift: ['Volta ao alvo', 2, 'improve'],
  recommendation_up: ['Sugestão do assessor', 1, 'improve'], recommendation_down: ['Sugestão do assessor', 1, 'worsen'],
};
const SEV = { high: 0, medium: 1, low: 2 };
const REGION_PT = { br: 'Brasil', intl: 'Mundo' };

const compound = (rs) => rs.reduce((a, r) => a * (1 + r), 1) - 1;
const dmy = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '');
const lastDay = (ym) => { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).getUTCDate(); };
const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || '';

// ── 2 · análise ────────────────────────────────────────────────────────────
export function analyseForReport(s) {
  const history = [...(s.returns_history || [])].filter((r) => Number.isFinite(r.portfolio)).sort((a, b) => a.month.localeCompare(b.month));
  const upto = history.filter((r) => r.month <= s.month);
  const year = s.month.slice(0, 4);
  const inYear = upto.filter((r) => r.month.startsWith(year));
  const last12 = upto.slice(-12);
  const port = (rows) => (rows.length ? compound(rows.map((r) => r.portfolio)) : null);
  const bench = (rows) => { const v = rows.map((r) => r.benchmark).filter(Number.isFinite); return rows.length && v.length === rows.length ? compound(v) : null; };

  const monthRow = upto.find((r) => r.month === s.month) || null;
  const perf = s.perf?.performance || null;
  const monthly = Number.isFinite(perf?.monthly_return) ? perf.monthly_return : (monthRow?.portfolio ?? null);
  const benchMonth = Number.isFinite(s.perf?.benchmark?.value) ? s.perf.benchmark.value : (monthRow?.benchmark ?? null);
  const metricsIn = s.perf?.metrics?.available ? s.perf.metrics : historicalMetrics(upto.map((r) => ({ month: r.month, value: r.portfolio })));
  const metrics = metricsIn?.available ? { volatility: metricsIn.annualised_volatility, max_drawdown: metricsIn.max_drawdown, observations: metricsIn.observations } : null;

  // the cumulative curve, portfolio and reference
  let p = 1; let b = 1;
  const series = { portfolio: [], benchmark: [] };
  for (const r of upto) {
    p *= 1 + r.portfolio; series.portfolio.push({ month: r.month, value: p - 1 });
    if (Number.isFinite(r.benchmark)) { b *= 1 + r.benchmark; series.benchmark.push({ month: r.month, value: b - 1 }); }
  }

  // allocation against the policy, for the pie and for the plain-language line
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
    return { asset_class: k, label: classPt(k), weight: w, value: e?.value ?? 0, target, min: range?.min ?? null, max: range?.max ?? null, position, outside_band: position === -2 || position === 2, color: CLASS_COLOR[k] || CLASS_COLOR.Other };
  }).filter((a) => a.weight > 0.0005 || (a.target ?? 0) > 0);
  const holdings = [...(s.positions || [])].sort((x, y) => (y.market_value || 0) - (x.market_value || 0))
    .map((i) => ({ name: i.ticker ? `${i.ticker} · ${i.name}` : i.name, class_label: classPt(i.asset_class), weight: i.weight, value: i.market_value }));

  // the day's events, as the client reads them: the ones that touch the portfolio first, then the market-wide ones
  const events = (s.overview?.what_matters || []).filter((e) => e.title)
    .sort((a, c) => (Number(c.touches) - Number(a.touches)) || ((SEV[a.importance] ?? 1) - (SEV[c.importance] ?? 1)))
    .slice(0, 5)
    .map((e) => ({ title: e.title, why: e.why || e.impact || '', region: e.region, region_label: REGION_PT[e.region] || null, source: e.source || null, importance: e.importance }));

  // the scatter: twelve months of return and volatility for each asset held, with the references
  const rr = s.risk_return || null;
  const scatter = {
    window: rr?.window || null,
    assets: (rr?.assets || []).map((a) => ({
      id: a.id, label: a.ticker || shortName(a.name), name: a.name, asset_class: a.asset_class, risk_class: a.risk_class || 'crypto_other',
      color: RISK_CLASS_COLOR[a.risk_class] || RISK_CLASS_COLOR.crypto_other, x: a.volatility, y: a.total_return, weight: a.weight ?? 0, partial: !!a.partial, simulated: !!a.simulated,
    })).filter((a) => Number.isFinite(a.x) && Number.isFinite(a.y)),
    references: (rr?.references || []).map((r) => ({ key: r.key, label: r.label, x: r.volatility, y: r.total_return })).filter((r) => Number.isFinite(r.x) && Number.isFinite(r.y)),
    excluded: rr?.excluded || [],
  };
  const byRatio = scatter.assets.filter((a) => a.x > 0).slice().sort((a, c) => (c.y / c.x) - (a.y / a.x));
  scatter.best = byRatio[0] || null;
  scatter.worst = scatter.assets.slice().sort((a, c) => a.y - c.y)[0] || null;

  // what could improve the result and what could make it worse
  const points = [];
  for (const o of s.discussion_opportunities || []) {
    const def = KIND[o.kind];
    if (!def) continue;
    points.push({ kind: o.kind, side: def[2], rank: def[1], severity: o.severity || 'medium', title: def[0], text: o.message, asset_class: o.asset_class || null });
  }
  for (const t of s.overview?.triggers || []) points.push({ kind: 'trigger', side: 'worsen', rank: 1, severity: 'high', title: KIND.trigger[0], text: `${t.label}. ${t.action_pt || t.action || ''}`.trim() });
  for (const r of s.recommendations || []) {
    const act = ACTION_PT[r.final_action] || r.final_action;
    const kind = ['REDUCE', 'EXIT'].includes(r.final_action) ? 'recommendation_down' : 'recommendation_up';
    points.push({
      kind, side: KIND[kind][2], rank: 1, severity: r.suitability_result === 'PASS' ? 'medium' : 'high', title: `${act} ${r.ticker || r.name}`,
      text: r.rationale || `${act} ${r.name}${r.current_weight ? `, hoje ${fmtWeight(r.current_weight, { locale: L, decimals: 1 })} da carteira` : ''}. Sugestão para discussão, não uma ordem.`,
    });
  }
  const seen = new Set();
  const ranked = points
    .filter((x) => x.text && !seen.has(x.text.slice(0, 80)) && seen.add(x.text.slice(0, 80)))
    .sort((a, c) => (SEV[a.severity] ?? 1) - (SEV[c.severity] ?? 1) || a.rank - c.rank);
  const improve = ranked.filter((x) => x.side === 'improve').slice(0, 4);
  const worsen = ranked.filter((x) => x.side === 'worsen').slice(0, 4);

  const at = s.perf?.attribution || null;
  const worst = at?.top_negative?.[0] || at?.worst_contributor || null;
  const best = at?.top_positive?.[0] || null;
  const sources = [...new Set([...(s.perf?.sources || []), ...(rr?.sources || []), ...(s.overview?.sources || []), ...(s.recommendations?.length ? ['TradingView'] : [])])]
    .map((x) => String(x).replace(/\s*\(.*\)$/, '')).filter((x, i, arr) => x && arr.indexOf(x) === i).slice(0, 6);

  return {
    monthly, benchMonth, excess: monthly != null && benchMonth != null ? monthly - benchMonth : null, pnl: perf?.absolute_pnl ?? null,
    ytd: port(inYear), ytdB: bench(inYear),
    twelve: last12.length >= 12 ? port(last12) : null, twelveB: last12.length >= 12 ? bench(last12) : null,
    since: port(upto), sinceB: bench(upto), since_from: upto[0]?.month || null,
    metrics, series, allocation, holdings, events, scatter, improve, worsen,
    worst: worst ? { name: worst.ticker || worst.name, contribution: worst.contribution } : null,
    best: best ? { name: best.ticker || best.name, contribution: best.contribution } : null,
    fx: Number.isFinite(at?.fx_contribution) ? at.fx_contribution : null,
    sources, simulated_history: upto.some((r) => r.method === 'reconstructed_from_statements'),
  };
}

function shortName(name) {
  const stop = /^(fundo|fic|fim|fia|de|do|da|em|e|s\.a\.|ltda\.?|advisory|plus|—|-)$/i;
  return String(name || '').split(' — ')[0].split(/\s+/).filter((w) => w && !stop.test(w)).slice(0, 2).join(' ') || name;
}

// ── 3 · redação: the facts the model (or the template) writes from ─────────
const POSITION_PT = { '-2': 'abaixo da faixa', '-1': 'abaixo do alvo', 0: 'no alvo', 1: 'acima do alvo', 2: 'acima da faixa' };

export function factsForNarrative(s) {
  const a = s.analysis;
  const pct = (v, o = {}) => (v == null ? null : percent(v, { locale: L, ...o }));
  const w = s.risk_return?.window;
  return {
    date: s.date, month: s.month, month_label: monthLabel(s.month, L),
    client: { name: s.client.name, first_name: firstName(s.client.name), risk_profile: s.client.risk_profile },
    advisor: { name: s.advisor.name },
    performance: {
      monthly_return_label: pct(a.monthly), absolute_pnl_label: a.pnl == null ? null : money(a.pnl, { locale: L, signed: true }),
      benchmark_label: pct(a.benchMonth), excess_label: a.excess == null ? null : pp(a.excess, { locale: L }),
      ytd_label: pct(a.ytd), twelve_months_label: pct(a.twelve), since_start_label: pct(a.since), since_start_from: a.since_from ? monthLabel(a.since_from, L) : null,
      worst: a.worst ? { name: a.worst.name, contribution_label: pp(a.worst.contribution, { locale: L }) } : null,
      best: a.best ? { name: a.best.name, contribution_label: pp(a.best.contribution, { locale: L }) } : null,
      fx_label: a.fx == null ? null : pp(a.fx, { locale: L }),
    },
    world: s.overview ? {
      date: s.overview.date, headline: s.overview.headline, summary: s.overview.summary, briefing: s.overview.briefing,
      events: a.events.map((e) => ({ title: e.title, why: e.why, region: e.region_label, source: e.source })),
    } : null,
    assets_12m: {
      window_label: w ? `${monthLabel(w.months?.[0] || w.from?.slice(0, 7), L)} a ${monthLabel(w.months?.[w.months.length - 1] || w.to?.slice(0, 7), L)}` : 'últimos 12 meses',
      items: a.scatter.assets.slice().sort((x, y) => y.weight - x.weight).slice(0, 12).map((x) => ({ name: x.label, full_name: x.name, class: RISK_CLASS_PT[x.risk_class], weight_label: fmtWeight(x.weight, { locale: L, decimals: 1 }), return_label: pct(x.y), volatility_label: pct(x.x, { signed: false }) })),
      references: a.scatter.references.map((r) => ({ name: r.label, return_label: pct(r.y), volatility_label: pct(r.x, { signed: false }) })),
      best_for_risk: a.scatter.best ? a.scatter.best.label : null, lowest_return: a.scatter.worst ? a.scatter.worst.label : null,
      not_measured: a.scatter.excluded.map((e) => e.label),
    },
    improve_points: a.improve.map((d) => ({ kind: d.kind, title: d.title, text: d.text })),
    worsen_points: a.worsen.map((d) => ({ kind: d.kind, title: d.title, text: d.text })),
    allocation: a.allocation.map((x) => ({ asset_class: x.asset_class, label: x.label, weight_label: fmtWeight(x.weight, { locale: L, decimals: 1 }), target_label: x.target == null ? null : fmtWeight(x.target, { locale: L, decimals: 0 }), position_label: POSITION_PT[x.position], outside_band: x.outside_band })),
    holdings: a.holdings.slice(0, 12).map((h) => ({ name: h.name, weight_label: fmtWeight(h.weight, { locale: L, decimals: 1 }) })),
    next_meeting: s.next_meeting ? dateLong(s.next_meeting, L) : null,
  };
}

const clip = (t, n) => { const s = String(t ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s; };
const align = (got, want, tLen, xLen) => want.map((w, i) => ({ title: clip(got?.[i]?.title || w.title, tLen), text: clip(got?.[i]?.text || w.text, xLen) }));

/** What the model returned, aligned to the facts: one entry per event and per point, every field a bounded string. */
export function sanitiseNarrative(data, facts) {
  if (!data || typeof data !== 'object' || !data.world || !data.performance_comment) throw new Error('model returned no world or performance_comment');
  const ev = facts.world?.events || [];
  return {
    greeting: clip(data.greeting || `Prezado ${facts.client.first_name},`, 60),
    opening: clip(data.opening || '', 400),
    world: clip(data.world, 900),
    events: align(Array.isArray(data.events) ? data.events : [], ev.map((e) => ({ title: e.title, text: e.why })), 70, 300),
    performance_comment: clip(data.performance_comment, 600),
    assets_comment: clip(data.assets_comment || '', 400),
    improve: align(Array.isArray(data.improve) ? data.improve : [], facts.improve_points, 60, 300),
    worsen: align(Array.isArray(data.worsen) ? data.worsen : [], facts.worsen_points, 60, 300),
    allocation_comment: clip(data.allocation_comment || '', 300),
    closing: clip(data.closing || '', 300),
    sign_off: clip(data.sign_off || 'Um abraço,', 40),
    language: 'pt-BR',
  };
}

// ── 4 · diagramação: the display model ─────────────────────────────────────
export function buildReportModel(s) {
  const a = s.analysis;
  const n = s.narrative || {};
  const tone = (v) => (v == null ? 'flat' : v > 0 ? 'gain' : v < 0 ? 'loss' : 'flat');
  const pct = (v, o = {}) => (v == null ? '—' : percent(v, { locale: L, ...o }));
  const [dy, dm, dd] = s.date.split('-').map(Number);
  const monthEndIso = `${s.month}-${String(lastDay(s.month)).padStart(2, '0')}`;
  const w = s.risk_return?.window;
  const holdings = a.holdings;

  return {
    locale: L, generated_at: s.date, narrative_mode: s.narrative_mode || 'deterministic_template',
    header: { title_light: 'Relatório', title_bold: 'mensal', date: `${dd} ${MONTHS_LONG[dm - 1]} ${dy}` },
    data_until: `Dados até ${dateLong(monthEndIso, L)}`,
    client: { name: s.client.name, first_name: firstName(s.client.name), profile: s.client.risk_profile },
    advisor: { name: s.advisor.name, code: s.advisor.code || null },
    meta_line: `Perfil ${s.client.risk_profile || '—'} · Assessor ${s.advisor.name}${s.advisor.code ? ` (${s.advisor.code})` : ''} · Posição em ${dmy(s.snapshot?.effective_date || monthEndIso)}`,
    greeting: n.greeting || `Prezado ${firstName(s.client.name)},`,
    opening: n.opening || '',
    world: {
      text: n.world || '',
      date_label: s.overview?.date ? dmy(s.overview.date) : null,
      events: (n.events || []).map((e, i) => ({ title: e.title, text: e.text, source: a.events[i]?.source || null, region: a.events[i]?.region_label || null })),
    },
    performance: {
      figures: [
        { label: `No mês · ${monthLabel(s.month, L)}`, value: pct(a.monthly), tone: tone(a.monthly), emphasis: true },
        { label: 'No ano', value: pct(a.ytd), tone: tone(a.ytd) },
        { label: '12 meses', value: pct(a.twelve), tone: tone(a.twelve) },
        { label: 'Referência no mês', value: pct(a.benchMonth), tone: 'benchmark' },
      ],
      comment: n.performance_comment || '',
      chart: { title: 'Retorno acumulado da sua carteira', portfolio: a.series.portfolio, benchmark: a.series.benchmark, legend: ['Sua carteira', 'Carteira de referência da política'] },
      scatter: {
        title: 'Seus ativos: risco e retorno em 12 meses',
        window_label: w ? `${dmy(w.from)} a ${dmy(w.to)}` : null,
        assets: a.scatter.assets, references: a.scatter.references,
        classes: [...new Set(a.scatter.assets.map((x) => x.risk_class))].map((k) => ({ key: k, label: RISK_CLASS_PT[k], color: RISK_CLASS_COLOR[k] })),
        excluded_note: a.scatter.excluded.length ? `Sem medida de 12 meses: ${a.scatter.excluded.map((e) => e.label).join(', ')}.` : null,
      },
      assets_comment: n.assets_comment || '',
    },
    outlook: {
      improve: (n.improve || []).map((d) => ({ title: d.title, text: d.text })),
      worsen: (n.worsen || []).map((d) => ({ title: d.title, text: d.text })),
    },
    portfolio: {
      comment: n.allocation_comment || '',
      total_label: money(s.total, { locale: L }), positions_count: (s.positions || []).length,
      pie: a.allocation.filter((x) => x.weight > 0.0005).sort((x, y) => y.weight - x.weight).map((x) => ({ label: x.label, weight: x.weight, color: x.color })),
      holdings: holdings.map((h) => ({ name: h.name, class_label: h.class_label, weight_label: fmtWeight(h.weight, { locale: L, decimals: 1 }) })),
    },
    closing: n.closing || '',
    sign_off: n.sign_off || 'Um abraço,',
    next_meeting: s.next_meeting ? dateLong(s.next_meeting, L) : null,
    sources_line: `Fonte: ${a.sources.length ? a.sources.join(', ') : 'registros do custodiante'}. Elaboração: XP Asset Management.${a.simulated_history ? ' O histórico anterior à plataforma foi reconstruído a partir dos extratos e é simulado.' : ''}`,
    disclosures: standardDisclosures(L),
  };
}
