/**
 * The client data refresh: three steps that bring one client's portfolio to
 * today's prices, for the advisor with a meeting in half an hour who wants the
 * letter written on current numbers rather than on the last approved retrato.
 *
 *   1. Preços    — every position remarked at the newest observation its own
 *                  provider has: Yahoo for the listed instruments, the
 *                  custodian statement for fund quotas, the Banco Central's
 *                  index for the contractual ones, PTAX for what is not in the
 *                  client's currency. A position whose provider has nothing
 *                  keeps the price it had and is named as kept, never guessed
 *                  (§30) — a stale number the advisor knows about is safe; an
 *                  invented one is not.
 *   2. Carteira  — the remarked positions written as a NEW approved snapshot
 *                  effective today. The previous one is superseded, not
 *                  overwritten, so the valuation every past letter rests on is
 *                  still there to be read (§11). Quantities, cost bases and
 *                  notes are carried over untouched: this changes what the
 *                  holdings are worth, never what they are.
 *   3. Leitura   — the new allocation against the policy: which classes left
 *                  their band, the drift against the target, the single names
 *                  over the cap, and how old the day's panorama is next to the
 *                  valuation that now exists.
 *
 * This is the whole of the client's own data. The market view a letter also
 * rests on belongs to the entire book and is refreshed from the day's panorama;
 * step 3 only reports how old it is, because starting that run for one client
 * would make every other client wait on it.
 *
 * Outbound budget (Workers Free allows fifty fetches per invocation): one
 * series per market-priced position, plus one PTAX series and one CDI window
 * for the run. A book-sized portfolio stays well inside that.
 */
import { all, first, run, id, json, nowIso, audit, currentPolicy, snapshotPositions, positionToAsset } from './db.js';
import * as P from './pipeline.js';
import * as A from './agents.js';
import { priceWindow } from '../../src/adapters/marketdata.js';
import * as bcb from '../../src/adapters/bcb.js';
import { SourceLedger } from '../../src/core/sources.js';
import { allocationOf } from './client-analysis.js';
import { money } from '../../src/core/format.js';

export const REFRESH_AGENTS = [
  { step: 1, key: 'precos', title: 'Atualização · Preços', what: 'cada posição remarcada no provedor que a precifica' },
  { step: 2, key: 'carteira', title: 'Atualização · Carteira', what: 'um novo retrato da carteira, com os valores e os pesos de hoje' },
  { step: 3, key: 'leitura', title: 'Atualização · Leitura', what: 'a alocação contra a política e o que saiu da faixa' },
];

/** A price refresh is seconds of work; one that has said nothing for five minutes is gone. */
const STALE_MS = 5 * 60 * 1000;
const CLASS_PT = {
  Cash: 'Caixa', 'Fixed Income': 'Renda fixa', 'Equities BR': 'Renda variável Brasil',
  'Equities Global': 'Renda variável global', Alternatives: 'Multimercado e alternativos',
  'Real Estate': 'Imobiliário listado', Commodities: 'Commodities', 'Digital Assets': 'Ativos digitais',
};
const classPt = (k) => CLASS_PT[k] || k;
const today = () => new Date().toISOString().slice(0, 10);
const br = (iso) => (iso ? iso.slice(0, 10).split('-').reverse().join('/') : '—');
const brl = (v) => money(v, { locale: 'pt-BR' });
const isStale = (row) => row.status === 'running' && Date.now() - Date.parse(row.started_at) > STALE_MS;

function addDays(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

/** What the portal sees of a run. A run that stopped reporting is shown as failed. */
export function runView(row) {
  if (!row) return null;
  const stale = isStale(row);
  return {
    id: row.id, client_id: row.client_id,
    status: stale ? 'failed' : row.status,
    step: row.step, progress: row.progress, message: row.message,
    error: stale ? 'sem progresso há mais de cinco minutos' : row.error,
    started_at: row.started_at, finished_at: row.finished_at,
    snapshot_id: row.snapshot_id, previous_snapshot_id: row.previous_snapshot_id,
    result: json(row.result_json, null),
    log: json(row.log_json, []).slice(-12),
    agents: REFRESH_AGENTS,
  };
}

export async function latestRefresh(db, clientId, { status = null } = {}) {
  return status
    ? first(db, 'SELECT * FROM client_refresh_runs WHERE client_id = ? AND status = ? ORDER BY started_at DESC LIMIT 1', clientId, status)
    : first(db, 'SELECT * FROM client_refresh_runs WHERE client_id = ? ORDER BY started_at DESC LIMIT 1', clientId);
}

/**
 * What the client page shows in its header once a refresh has run: when the
 * valuation was made and who priced it. Cheap enough to answer on every load.
 */
export async function lastRefreshSummary(db, clientId) {
  const row = await latestRefresh(db, clientId, { status: 'completed' });
  if (!row) return null;
  const r = json(row.result_json, {});
  return {
    id: row.id, finished_at: row.finished_at,
    effective_date: r.to ?? null, previous_date: r.from ?? null,
    total_value: r.total_value ?? null, previous_total: r.previous_total ?? null,
    change_pct: r.change_pct ?? null,
    providers: r.providers || [],
    priced: r.counts?.priced ?? null, kept: r.counts?.kept ?? null,
  };
}

/**
 * Start a refresh in the background and return its row at once; the page polls
 * it. A refresh already running for this client is returned instead of starting
 * a second one — two runs would each supersede the other's snapshot.
 */
export async function startClientRefresh(env, ctx, { scope, actorId = null }) {
  const db = env.DB;
  const { client, advisor } = scope;
  if (!advisor) return { error: 'cliente sem assessor responsável' };

  const active = await latestRefresh(db, client.id, { status: 'running' });
  if (active && !isStale(active)) return { run: runView(active) };
  if (active) {
    await run(db, 'UPDATE client_refresh_runs SET status = ?, error = ?, finished_at = ? WHERE id = ?',
      'failed', 'abandonada: sem progresso há mais de cinco minutos', nowIso(), active.id);
  }

  const snap = await first(db, "SELECT * FROM portfolio_snapshots WHERE client_id = ? AND status = 'approved' ORDER BY effective_date DESC, created_at DESC LIMIT 1", client.id);
  if (!snap) return { error: 'não há carteira aprovada para remarcar' };

  const runId = id('rfr');
  await run(db,
    'INSERT INTO client_refresh_runs (id, client_id, advisor_id, status, step, progress, message, previous_snapshot_id, actor_id, started_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    runId, client.id, advisor.id, 'running', 0, 0, 'Na fila', snap.id, actorId, nowIso());

  const job = runClientRefresh(env, runId).catch((err) => console.error('client refresh failed', err?.stack || err));
  if (ctx?.waitUntil) ctx.waitUntil(job); else await job;
  return { run: runView(await first(db, 'SELECT * FROM client_refresh_runs WHERE id = ?', runId)) };
}

/** The three steps, in order. A step that fails records it and stops the run. */
export async function runClientRefresh(env, runId) {
  const s1 = await stepPrecos(env, runId);
  if (!s1) return;
  const s2 = await stepCarteira(env, runId, s1);
  if (!s2) return;
  await stepLeitura(env, runId, s2);
}

// ── the run's bookkeeping ───────────────────────────────────────────────────
async function loadRun(db, runId) {
  const row = await first(db, 'SELECT * FROM client_refresh_runs WHERE id = ?', runId);
  if (!row) throw new Error(`refresh run ${runId} not found`);
  const client = await first(db, 'SELECT * FROM clients WHERE id = ?', row.client_id);
  const log = json(row.log_json, []);
  const report = async (step, progress, message, detail = null) => {
    log.push({ at: nowIso(), step, message, detail });
    await run(db, 'UPDATE client_refresh_runs SET step = ?, progress = ?, message = ?, log_json = ? WHERE id = ?',
      step, Math.round(progress), message, JSON.stringify(log.slice(-80)), runId);
  };
  const fail = async (err) => {
    console.error('client refresh', err?.stack || err);
    await run(db, 'UPDATE client_refresh_runs SET status = ?, error = ?, finished_at = ?, log_json = ? WHERE id = ?',
      'failed', String(err?.message || err), nowIso(), JSON.stringify(log.slice(-80)), runId);
  };
  return { row, client, log, report, fail };
}

// ── 1 · Preços ──────────────────────────────────────────────────────────────
async function stepPrecos(env, runId) {
  const db = env.DB;
  const { row, client, report, fail } = await loadRun(db, runId);
  try {
    P.attachKv(env);
    const snap = await first(db, 'SELECT * FROM portfolio_snapshots WHERE id = ?', row.previous_snapshot_id);
    if (!snap) throw new Error('o retrato anterior da carteira desapareceu');
    const policy = await currentPolicy(db, client.id);
    const positions = await snapshotPositions(db, snap.id);
    if (!positions.length) throw new Error('a carteira aprovada não tem posições');

    const from = snap.effective_date;
    const to = today();
    const base = policy?.base_currency || client.base_currency || 'BRL';
    const ledger = new SourceLedger();
    await report(1, 4, `Remarcando ${positions.length} posições de ${br(from)} para ${br(to)}`);

    // Fund quotas have no public feed: the custodian statement is the price.
    const navRows = await all(db,
      'SELECT * FROM market_observations WHERE observation_date <= ? AND asset_id IN (SELECT id FROM assets WHERE pricing_mode = ?) ORDER BY observation_date',
      to, 'nav');
    const navObservations = {};
    for (const o of navRows) (navObservations[o.asset_id] ||= []).push({ ...o, ...json(o.metadata_json, {}) });

    // PTAX translates what is not in the client's currency; the CDI window is
    // fetched once and handed to every accrual instrument that needs it.
    const needsFx = positions.some((p) => p.currency && p.currency !== base);
    const fxSeries = needsFx ? await bcb.series('USD_PTAX_SELL', addDays(from, -12), to) : null;
    const fxAt = (date) => {
      if (!fxSeries || fxSeries.unavailable) return null;
      let best = null;
      for (const p of fxSeries.points) { if (p.date <= date) best = p; else break; }
      return best?.value ?? null;
    };
    if (fxSeries && !fxSeries.unavailable) ledger.add(fxSeries.source);
    const fxNow = fxAt(to);
    const fxThen = fxAt(from);

    const hasAccrual = positions.some((p) => p.pricing_mode === 'accrual');
    const cdi = hasAccrual && from < to ? await bcb.cdiAccumulated(from, to) : null;
    if (cdi && !cdi.unavailable) ledger.add(cdi.source);

    const priced = [];
    let n = 0;
    for (const p of positions) {
      const asset = positionToAsset(p);
      const carry = {
        asset_id: p.asset_id, ticker: p.ticker, name: p.asset_name, asset_class: p.asset_class,
        pricing_mode: p.pricing_mode, currency: p.currency, type: p.type,
        quantity: p.quantity, cost_basis: p.cost_basis, acquired_at: p.acquired_at, notes: p.notes,
        previous_price: p.price, previous_value: p.market_value ?? 0,
      };
      n += 1;
      await report(1, 4 + (n / positions.length) * 46, `${n}/${positions.length} · ${asset.ticker || asset.name}`);

      if (asset.pricing_mode === 'cash') {
        priced.push({ ...carry, status: 'cash', price: p.price, market_value: p.market_value ?? 0, change_pct: 0, provider: null });
        continue;
      }

      // Nothing accrues inside a day the portfolio is already valued at; a
      // second refresh on the same date must not pay another day of spread.
      if (asset.pricing_mode === 'accrual' && from >= to) {
        priced.push({ ...carry, status: 'kept', reason: 'a carteira já está valorizada em hoje', price: p.price, market_value: p.market_value ?? 0, change_pct: 0, provider: null });
        continue;
      }

      const pw = await priceWindow(asset, from, to, { navObservations, cdi: cdi ? { [`${from}..${to}`]: cdi } : {} });
      ledger.addAll(pw.sources || []);
      const provider = (pw.sources || [])[0]?.provider || null;

      if (pw.status === 'DATA_UNAVAILABLE' || !(pw.open > 0) || !(pw.close > 0)) {
        priced.push({
          ...carry, status: 'kept',
          reason: pw.reason || 'nenhum provedor aprovado devolveu preço para a janela',
          providers_attempted: pw.providers_attempted || [],
          price: p.price, market_value: p.market_value ?? 0, change_pct: 0, provider: null,
        });
        continue;
      }

      const factor = pw.close / pw.open;
      let price;
      let value;
      if (asset.pricing_mode === 'accrual') {
        // open and close are a return factor here, not a price: the instrument
        // accrues from where it already stood, or the refresh would reset it to par.
        price = (p.price ?? 1) * factor;
        value = (p.market_value ?? 0) * factor;
      } else {
        const fx = asset.currency && asset.currency !== base ? (fxNow ?? 1) : 1;
        const fxRatio = asset.currency && asset.currency !== base && fxNow && fxThen ? fxNow / fxThen : 1;
        price = pw.close;
        value = Number.isFinite(p.quantity) ? pw.close * p.quantity * fx : (p.market_value ?? 0) * factor * fxRatio;
      }

      priced.push({
        ...carry, status: 'priced', price, market_value: value,
        price_date: pw.close_date || to,
        change_pct: carry.previous_value ? value / carry.previous_value - 1 : null,
        provider,
        // A move this large over the window is usually real, but it is never
        // put in front of a client without being looked at first.
        review: asset.pricing_mode === 'market' && Math.abs(factor - 1) > 0.6,
        note: pw.note || null,
      });
    }

    const counts = {
      total: priced.length,
      priced: priced.filter((p) => p.status === 'priced').length,
      kept: priced.filter((p) => p.status === 'kept').length,
      cash: priced.filter((p) => p.status === 'cash').length,
    };
    await report(1, 52, `${counts.priced} de ${counts.total} posições remarcadas${counts.kept ? `, ${counts.kept} sem preço novo` : ''}`);
    return { snap, policy, priced, counts, from, to, base, ledger };
  } catch (err) {
    await fail(err);
    return null;
  }
}

// ── 2 · Carteira ────────────────────────────────────────────────────────────
async function stepCarteira(env, runId, s1) {
  const db = env.DB;
  const { row, client, report, fail } = await loadRun(db, runId);
  try {
    const { snap, priced, from, to } = s1;
    const total = priced.reduce((a, p) => a + (p.market_value || 0), 0);
    const previousTotal = priced.reduce((a, p) => a + (p.previous_value || 0), 0);
    await report(2, 60, `Novo retrato da carteira: ${brl(total)}`);
    const commentary = from === to
      ? `Remarcação a mercado em ${br(to)}. As mesmas posições e quantidades; apenas os preços foram atualizados.`
      : `Remarcação a mercado de ${br(from)} para ${br(to)}. As mesmas posições e quantidades do retrato anterior; apenas os preços mudaram.`;

    // A refresh earlier today already wrote a retrato for this date: rewrite it
    // instead of stacking one per click. An advisor preparing a meeting presses
    // the button more than once, and the history worth keeping is the snapshots
    // an advisor approved — never a machine's second pass at the same day.
    const rewritable = snap.effective_date === to
      && !!(await first(db, 'SELECT 1 AS x FROM client_refresh_runs WHERE snapshot_id = ? LIMIT 1', snap.id));

    let snapId;
    if (rewritable) {
      snapId = snap.id;
      await run(db, 'DELETE FROM positions WHERE portfolio_snapshot_id = ?', snapId);
      await run(db, 'UPDATE portfolio_snapshots SET total_value = ?, advisor_commentary = ? WHERE id = ?', total, commentary, snapId);
    } else {
      snapId = id('snp');
      await run(db, "UPDATE portfolio_snapshots SET status = 'superseded' WHERE client_id = ? AND status = 'approved'", client.id);
      await run(db, `INSERT INTO portfolio_snapshots (id, client_id, meeting_id, investment_policy_id, effective_date, status, total_value, cash_balance, base_currency, advisor_commentary, world_overview_id, recommendation_set_id)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        snapId, client.id, null, snap.investment_policy_id, to, 'approved', total, snap.cash_balance, snap.base_currency,
        commentary, snap.world_overview_id, snap.recommendation_set_id);
    }

    for (const p of priced) {
      await run(db, 'INSERT INTO positions (id, portfolio_snapshot_id, asset_id, quantity, cost_basis, price, market_value, portfolio_weight, acquired_at, notes) VALUES (?,?,?,?,?,?,?,?,?,?)',
        id('pos'), snapId, p.asset_id, p.quantity ?? null, p.cost_basis ?? null, p.price ?? null,
        p.market_value || 0, total ? (p.market_value || 0) / total : null, p.acquired_at ?? null, p.notes ?? null);
    }

    await run(db, 'UPDATE client_refresh_runs SET snapshot_id = ? WHERE id = ?', snapId, runId);
    await audit(db, {
      entity: 'portfolio_snapshot', entity_id: snapId, action: rewritable ? 'repriced_again' : 'repriced', actor_id: row.actor_id,
      detail: { run_id: runId, from, to, previous_snapshot_id: snap.id, total_value: total, previous_total: previousTotal, priced: s1.counts.priced, kept: s1.counts.kept },
    });
    await report(2, 70, rewritable
      ? `Retrato de ${br(to)} regravado com os preços desta atualização`
      : `Retrato de ${br(to)} gravado; o de ${br(from)} foi mantido como histórico`);
    return { ...s1, snapId, total, previousTotal };
  } catch (err) {
    await fail(err);
    return null;
  }
}

// ── 3 · Leitura ─────────────────────────────────────────────────────────────
async function stepLeitura(env, runId, s2) {
  const db = env.DB;
  const { row, client, report, fail } = await loadRun(db, runId);
  try {
    const { priced, policy, total, previousTotal, from, to, snapId, ledger, counts } = s2;
    await report(3, 80, 'Lendo a nova alocação contra a política');

    const allocation = allocationOf(priced.map((p) => ({ asset_class: p.asset_class, market_value: p.market_value })), total, policy);
    const exposures = {};
    for (const a of allocation) exposures[a.asset_class] = a.weight;

    const breaches = [];
    for (const a of allocation) {
      if (!a.range) continue;
      if (a.range.min != null && a.weight < a.range.min) breaches.push({ kind: 'below_band', asset_class: a.asset_class, severity: 'medium', message: `${classPt(a.asset_class)} está em ${(a.weight * 100).toFixed(1)}%, abaixo do mínimo de ${(a.range.min * 100).toFixed(0)}% da política.` });
      if (a.range.max != null && a.weight > a.range.max) breaches.push({ kind: 'above_band', asset_class: a.asset_class, severity: 'high', message: `${classPt(a.asset_class)} está em ${(a.weight * 100).toFixed(1)}%, acima do máximo de ${(a.range.max * 100).toFixed(0)}% da política.` });
    }
    for (const d of P.driftTriggers(exposures, policy?.target_allocation || {}, policy?.rebalance_trigger ?? 0.05)) {
      breaches.push({ kind: 'drift', asset_class: d.asset_classes?.[0] ?? null, severity: 'medium', message: d.action_pt || d.action });
    }
    const cap = policy?.single_name_cap ?? 0.1;
    for (const p of priced) {
      const w = total ? (p.market_value || 0) / total : 0;
      if (w > cap && !['etf', 'cash', 'reit'].includes(p.type)) {
        breaches.push({ kind: 'concentration', asset_class: p.asset_class, severity: 'high', message: `${p.ticker || p.name} representa ${(w * 100).toFixed(1)}% da carteira, acima do teto de ${(cap * 100).toFixed(0)}% por emissor.` });
      }
    }

    // The market view a letter also rests on belongs to the whole book. Say how
    // old it is rather than silently letting a fresh valuation carry a stale read.
    const lastOverview = await A.latestRun(db, row.advisor_id, { status: 'completed' });
    const overviewDate = lastOverview?.date ?? null;
    const overview = overviewDate
      ? { date: overviewDate, days: daysBetween(overviewDate, to), stale: overviewDate < to }
      : { date: null, days: null, stale: true };

    const providers = [...new Set(ledger.all().map((s) => s.provider).filter(Boolean))];
    const result = {
      from, to,
      snapshot_id: snapId, previous_snapshot_id: row.previous_snapshot_id,
      total_value: total, previous_total: previousTotal,
      change_value: total - previousTotal,
      change_pct: previousTotal ? total / previousTotal - 1 : null,
      counts,
      positions: priced.map(({ cost_basis, acquired_at, notes, ...p }) => p),
      providers, sources: ledger.all(),
      allocation, breaches, overview,
    };

    await run(db, 'UPDATE client_refresh_runs SET status = ?, step = ?, progress = ?, message = ?, result_json = ?, finished_at = ? WHERE id = ?',
      'completed', 4, 100,
      `${brl(total)} em ${br(to)} · ${counts.priced} de ${counts.total} posições remarcadas`,
      JSON.stringify(result), nowIso(), runId);
    await audit(db, { entity: 'client_refresh', entity_id: runId, action: 'completed', actor_id: row.actor_id, detail: { client_id: client.id, total_value: total, breaches: breaches.length, providers } });
    return result;
  } catch (err) {
    await fail(err);
    return null;
  }
}
