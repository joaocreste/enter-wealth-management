/**
 * What one client's portfolio risks, measured rather than described.
 *
 * Three readings, all deterministic and all from the same twelve-month window
 * the rest of the portal uses (§15, §32):
 *
 *   1. The portfolio's annualised volatility, month by month, over a rolling
 *      twelve-month window — how unstable the book has been, and whether that
 *      is rising or falling.
 *   2. The Sharpe ratio over the same rolling window, measured against the CDI
 *      actually published for each month rather than a constant, so it is
 *      comparable to any other Brazilian mandate.
 *   3. Every position the client holds with its own trailing-twelve-month
 *      volatility, so the advisor can point at the lines carrying the risk.
 *
 * The per-asset figures come from the desk-wide engine (worker/src/risk-return.js),
 * filtered to this client's holdings: one method, one set of sources, one answer
 * to "how volatile is this fund" wherever it is asked. What cannot be measured
 * is listed with the reason, never plotted at zero.
 */
import { all, nowIso, currentSnapshot, snapshotPositions } from './db.js';
import { rollingMetrics, historicalMetrics } from '../../src/core/performance.js';
import { monthEnd } from '../../src/core/risk.js';
import { makeSource } from '../../src/core/sources.js';
import * as bcb from '../../src/adapters/bcb.js';
import { assetRiskReturn } from './risk-return.js';

export const WINDOW_MONTHS = 12;

/**
 * The CDI of each month in `months`, as a decimal fraction, aligned index by
 * index. Null when the series could not be read, or does not cover the window:
 * a Sharpe ratio against a risk-free rate that is partly guessed is not a
 * Sharpe ratio.
 */
async function riskFreeFor(months) {
  if (!months.length) return { rates: null, source: null, reason: 'sem histórico de retornos' };
  const cdi = await bcb.series('CDI_MONTHLY', `${months[0]}-01`, monthEnd(months[months.length - 1]));
  if (cdi.unavailable) return { rates: null, source: null, reason: `CDI indisponível no Banco Central: ${cdi.reason}` };
  const byMonth = new Map(cdi.points.map((p) => [p.date.slice(0, 7), p.value / 100]));
  const rates = months.map((m) => (byMonth.has(m) ? byMonth.get(m) : null));
  const missing = months.filter((m) => !byMonth.has(m));
  return {
    rates: rates.some((v) => v != null) ? rates : null,
    source: cdi.source,
    reason: missing.length ? `CDI ausente em ${missing.length} ${missing.length === 1 ? 'mês' : 'meses'} da janela` : null,
  };
}

/**
 * The portfolio's own risk: the rolling series and the trailing-twelve-month
 * reading that heads the client's overview. Kept separate from the per-asset
 * breakdown because the overview needs only this half, and this half costs one
 * query and one cached call to the Banco Central.
 */
export async function portfolioRisk(env, db, client) {
  const rows = await all(db, 'SELECT month, portfolio_return, benchmark_return FROM monthly_returns WHERE client_id = ? ORDER BY month', client.id);
  const months = rows.map((r) => r.month);
  const { rates, source: cdiSource, reason: rfReason } = await riskFreeFor(months);

  const portfolio = rows.map((r) => ({ month: r.month, value: r.portfolio_return }));
  const benchmark = rows.map((r) => ({ month: r.month, value: r.benchmark_return }));
  const series = rollingMetrics(portfolio, rates, { window: WINDOW_MONTHS });
  const benchSeries = rollingMetrics(benchmark, rates, { window: WINDOW_MONTHS });
  const last = series[series.length - 1] || null;
  const lastBench = benchSeries[benchSeries.length - 1] || null;

  // The same measures over the whole history, so the twelve-month reading can
  // be seen against the book's own long run rather than in isolation.
  const lifetime = historicalMetrics(portfolio, rates && rates.every((v) => v != null) ? rates : null);

  return {
    window: {
      months: WINDOW_MONTHS,
      label: '12 meses',
      from: last?.from ?? null,
      to: last?.month ?? null,
      history: { from: months[0] ?? null, to: months[months.length - 1] ?? null, months: months.length },
    },
    available: !!last?.volatility,
    reason: last?.volatility ? null
      : months.length < WINDOW_MONTHS
        ? `histórico de ${months.length} ${months.length === 1 ? 'mês' : 'meses'}; a janela de ${WINDOW_MONTHS} meses ainda não fecha`
        : 'a janela de 12 meses tem meses sem retorno apurado',
    current: last,
    benchmark_current: lastBench,
    series,
    benchmark_series: benchSeries,
    lifetime: lifetime.available ? lifetime : { available: false, reason: lifetime.reason },
    risk_free: rates
      ? { name: 'CDI', source_id: cdiSource?.id ?? null, note: rfReason }
      : { unavailable: true, reason: rfReason || 'CDI indisponível; o índice de Sharpe não é publicado' },
    method: {
      volatility: 'desvio-padrão amostral dos doze retornos mensais da carteira, anualizado por √12',
      sharpe: 'retorno mensal da carteira menos o CDI do mesmo mês; a média dos doze excessos anualizada por 12, dividida pelo desvio-padrão desses excessos anualizado por √12',
      pt: `Janela móvel de ${WINDOW_MONTHS} meses: cada ponto mede os doze meses encerrados naquele mês. Um mês sem retorno apurado deixa a janela sem leitura, em vez de medi-la com menos meses.`,
    },
    computed_at: nowIso(),
    sources: [
      ...(cdiSource ? [cdiSource] : []),
      makeSource({
        provider: 'XP Asset Management (derivado)',
        kind: 'derived',
        instrument: 'Volatilidade e índice de Sharpe da carteira em janela móvel de 12 meses',
        identifier: `client-risk-portfolio-12m:${client.id}`,
        requested_range: `${months[0] || '—'}..${months[months.length - 1] || '—'}`,
        last_observation: last?.month ?? null,
        notes: 'desvio-padrão amostral dos retornos mensais apurados da carteira, anualizado por √12; índice de Sharpe sobre os excessos mensais contra o CDI publicado em cada mês',
      }),
    ],
  };
}

/**
 * Every position the client holds with its own trailing-twelve-month
 * volatility, ordered by volatility, with the market references alongside.
 *
 * Its own route rather than a field on the portfolio reading, because a cold
 * run of the desk-wide engine reaches every provider in the book and takes the
 * better part of a minute. The page draws the portfolio's own risk first and
 * fills this in when it arrives, rather than holding the whole tab behind it.
 */
export async function assetRisk(env, db, client) {
  const snap = await currentSnapshot(db, client.id);
  const positions = snap ? await snapshotPositions(db, snap.id) : [];
  const total = positions.reduce((a, p) => a + (p.market_value || 0), 0);

  let desk = null;
  let deskError = null;
  try { desk = await assetRiskReturn(env, db); } catch (err) { deskError = err.message; }

  const measured = new Map((desk?.assets || []).map((a) => [a.id, a]));
  const unmeasured = new Map((desk?.excluded || []).filter((x) => !x.reference).map((x) => [x.id, x]));

  const assets = [];
  const excluded = [];
  for (const p of positions) {
    const base = {
      asset_id: p.asset_id,
      ticker: p.ticker,
      name: p.asset_name,
      asset_class: p.asset_class,
      type: p.type,
      pricing_mode: p.pricing_mode,
      currency: p.currency,
      risk_grade: p.risk_grade,
      market_value: p.market_value,
      weight: total ? p.market_value / total : null,
    };
    const a = measured.get(p.asset_id);
    if (a) {
      assets.push({
        ...base,
        risk_class: a.risk_class,
        volatility: a.volatility,
        total_return: a.total_return,
        observations: a.observations,
        months: a.months,
        partial: a.partial,
        simulated: a.simulated,
        basis: a.basis,
        note: a.note,
        source_ids: a.source_ids || [],
      });
    } else {
      excluded.push({
        ...base,
        reason: unmeasured.get(p.asset_id)?.reason
          || deskError
          || 'sem medida de volatilidade nesta janela',
      });
    }
  }
  assets.sort((a, b) => (b.volatility ?? -Infinity) - (a.volatility ?? -Infinity));
  excluded.sort((a, b) => (b.market_value || 0) - (a.market_value || 0));

  const references = (desk?.references || []).map((r) => ({
    key: r.key, label: r.label, volatility: r.volatility, total_return: r.total_return,
    observations: r.observations, months: r.months, partial: r.partial, basis: r.basis, source_ids: r.source_ids || [],
  }));

  // Sources: only the ones these rows actually rest on, plus the derived record
  // for the measure itself (§29).
  const used = new Set([...assets, ...references].flatMap((x) => x.source_ids || []));
  const sources = [
    ...(desk?.sources || []).filter((s) => used.has(s.id)),
    makeSource({
      provider: 'XP Asset Management (derivado)',
      kind: 'derived',
      instrument: 'Volatilidade e retorno por ativo em 12 meses',
      identifier: `client-asset-risk-12m:${client.id}`,
      requested_range: desk ? `${desk.window.from}..${desk.window.to}` : null,
      last_observation: desk?.window?.to ?? null,
      notes: 'desvio-padrão dos doze retornos mensais de cada ativo, anualizado por √12, amostrado nos fins de mês e medido em reais — o mesmo motor que alimenta o gráfico de retorno e risco da mesa',
    }),
  ];

  return {
    snapshot: snap ? { id: snap.id, effective_date: snap.effective_date, version: snap.version } : null,
    total_value: total,
    window: desk?.window || null,
    method: desk?.method || null,
    assets,
    excluded,
    references,
    error: deskError,
    computed_at: nowIso(),
    sources,
  };
}
