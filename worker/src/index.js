/**
 * XP Asset Management — advisory portal API and static host.
 *
 * One Worker serves the advisor portal, the client portal and the API, so the
 * advisor/client authorization boundary is enforced in exactly one place (§24).
 *
 * The /api/pipeline/* routes are the deterministic steps the Rivet graph calls.
 * They keep their intermediate state in D1 against a run id, so the payloads
 * flowing through the graph stay small and readable while the full inputs of
 * every published report remain reproducible (§31).
 */
import { all, first, run, id, json, nowIso, audit, resolveClientScope, currentPolicy, currentSnapshot, snapshotPositions, positionToAsset, hydratePolicy } from './db.js';
import { login, logout, sessionFromRequest, hashPassword } from './auth.js';
import * as P from './pipeline.js';
import * as LLM from './llm.js';
import { buildLetterModel, prioritiseForLetter } from '../../src/render/letter-model.js';
import { renderLetterHtml, renderPortalLetter } from '../../src/render/html-email.js';
import { renderLetterPdf } from '../../src/render/pdf/letter.js';
import { brandFonts } from '../../src/render/fonts/index.js';
import { validateReport } from '../../src/core/report-schema.js';
import { previousMonth, monthBounds } from '../../src/core/format.js';
import { INDICATORS } from '../../seed/market.mjs';
import { eventRegion } from '../../src/core/events.js';
import { seedDatabase } from './seed-runner.js';
import { artefactLinks, verifyArtefactToken } from './links.js';
import { cacheGet, cacheSet } from '../../src/adapters/cache.js';
import { PROMPT_VERSION } from '../../src/llm/prompts.js';
import { logReturns, correlationMatrix } from '../../src/core/correlation.js';
import { riskClassOf, RISK_CLASSES, monthEnd, monthBefore, monthlyReturnsFromCloses, riskFromMonthly, efficientFrontier } from '../../src/core/risk.js';
import { dailySeries, dividendsBetween } from '../../src/adapters/yahoo.js';
import * as bcb from '../../src/adapters/bcb.js';
import { makeSource, SourceLedger } from '../../src/core/sources.js';
import * as A from './agents.js';
import * as S from './series.js';
import * as R from './report-agent.js';
import { gateEnabled, gatePassed, gateSubmit, gatePage } from './gate.js';
import { hydrateRecommendation, allocationOf, meetingPrep, runProfitabilityLive } from './client-analysis.js';
import { assetRiskReturn } from './risk-return.js';
export { OverviewAgents } from './agents.js';
export { ReportAgent } from './report-agent.js';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };

/**
 * CORS.
 *
 * The portal is served from GitHub Pages and the API from a Worker, so every
 * portal request is cross-origin. The allowlist is an explicit env var rather
 * than a wildcard: `*` would let any site on the internet call this API with a
 * token it had somehow obtained, and would make the browser's own origin check
 * worthless. Local development hosts are permitted only outside production.
 */
function allowedOrigins(env) {
  const configured = String(env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (env.ENVIRONMENT === 'development') {
    configured.push('http://localhost:8788', 'http://127.0.0.1:8788', 'http://localhost:8080', 'http://127.0.0.1:8080');
  }
  return configured;
}

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin');
  if (!origin) return {};
  const allowed = allowedOrigins(env);
  if (!allowed.includes(origin)) return {};
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'access-control-allow-headers': 'content-type,authorization,x-service-token',
    'access-control-max-age': '86400',
    vary: 'Origin',
  };
}

function withCors(response, request, env) {
  const headers = corsHeaders(request, env);
  if (!Object.keys(headers).length) return response;
  const out = new Response(response.body, response);
  for (const [k, v] of Object.entries(headers)) out.headers.set(k, v);
  return out;
}

/** Asset-class names as the Brazilian advisor portal shows them (§5.7). */
const CLASS_PT = {
  Cash: 'Caixa', 'Fixed Income': 'Renda fixa', 'Equities BR': 'Renda variável Brasil',
  'Equities Global': 'Renda variável global', Alternatives: 'Multimercado e alternativos',
  'Real Estate': 'Imobiliário listado', Commodities: 'Commodities', 'Digital Assets': 'Ativos digitais',
};
const classPt = (k) => CLASS_PT[k] || k;

const ok = (data, init = {}) => new Response(JSON.stringify(data), { status: 200, headers: JSON_HEADERS, ...init });
const bad = (status, error, extra = {}) => new Response(JSON.stringify({ error, ...extra }), { status, headers: JSON_HEADERS });

export default {
  /** The daily cron (wrangler.toml [triggers]): rebuild the World Overview for every advisor. */
  async scheduled(event, env, ctx) {
    const advisors = await all(env.DB, 'SELECT a.*, u.name, u.email FROM advisors a JOIN users u ON u.id = a.user_id');
    for (const advisor of advisors) await A.startOverviewRun(env, ctx, { advisor, trigger: 'cron' });
    // The indicator histories in R2 pick up yesterday's close now, so the first
    // advisor of the day reads the strip from the store instead of waiting on Yahoo.
    P.attachKv(env);
    try { console.log('series store', JSON.stringify(await S.warmSeriesStore(env))); } catch (err) { console.error('series store', err?.stack || err); }
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (!pathname.startsWith('/api/')) {
      // The whole portal sits behind one password when SITE_PASSWORD is set:
      // no page, script, style or photograph is served before it is given.
      if (gateEnabled(env)) {
        if (pathname === '/gate' && request.method === 'POST') return gateSubmit(request, env, url);
        if (!(await gatePassed(request, env))) return gatePage(url);
      }
      return env.ASSETS ? env.ASSETS.fetch(request) : bad(404, 'not found');
    }
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }

    try {
      return withCors(await route(request, env, url, ctx), request, env);
    } catch (err) {
      console.error('unhandled', err?.stack || err);
      return withCors(bad(500, err?.message || 'internal error', { stack: env.ENVIRONMENT === 'development' ? String(err?.stack || '') : undefined }), request, env);
    }
  },
};

async function route(request, env, url, ctx) {
  const db = env.DB;
  const path = url.pathname.replace(/\/+$/, '') || '/api';
  const method = request.method;
  const body = method === 'POST' || method === 'PATCH' ? await readJson(request) : {};
  const session = await sessionFromRequest(request, env, db);

  P.attachKv(env);

  // ── public ────────────────────────────────────────────────────────────────
  if (path === '/api/health') {
    return ok({ status: 'ok', time: nowIso(), environment: env.ENVIRONMENT, llm: LLM.llmAvailable(env) ? 'configured' : 'deterministic-fallback' });
  }

  if (path === '/api/auth/login' && method === 'POST') {
    const s = await login(db, body.email, body.password);
    if (!s) return bad(401, 'invalid credentials');
    await audit(db, { entity: 'user', entity_id: s.user.id, action: 'login', actor_id: s.user.id });
    return new Response(JSON.stringify(s), {
      status: 200,
      headers: { ...JSON_HEADERS, 'set-cookie': `ew_session=${s.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200${url.protocol === 'https:' ? '; Secure' : ''}` },
    });
  }

  if (path === '/api/admin/seed' && method === 'POST') {
    if (env.ENVIRONMENT !== 'development' && !(env.SEED_TOKEN && body.token === env.SEED_TOKEN)) {
      return bad(403, 'seeding is disabled in this environment');
    }
    const result = await seedDatabase(env);
    return ok(result);
  }

  // ── report artefacts ─────────────────────────────────────────────────────
  // Sits above the session gate because a signed link is its own credential: a
  // PDF opened in a new tab cannot send an Authorization header, and once the
  // portal is on another origin the session cookie does not travel either. The
  // signature is minted only for a caller that already passed the scope check.
  const reportMatch = path.match(/^\/api\/reports\/([^/]+)\/(pdf|html|portal|json)$/);
  if (reportMatch) {
    const [, reportId, kind] = reportMatch;
    const report = await first(db, 'SELECT * FROM reports WHERE id = ?', reportId);
    if (!report) return bad(404, 'report not found');

    const signed = await verifyArtefactToken(env, reportId, kind, url.searchParams.get('t'));
    if (!signed) {
      if (!session) return bad(401, 'authentication required');
      const scope = await resolveClientScope(db, session, report.client_id);
      if (!scope.ok) return bad(scope.status, scope.error);
      if (scope.actingAs === 'client' && report.status !== 'published') return bad(404, 'report not available');
    }
    return serveArtefact(env, report, kind);
  }

  // ── the report agent's PDFs, by signed link or by a scoped session ────────
  const pdfMatch = path.match(/^\/api\/pdf-reports\/([^/]+)\/pdf$/);
  if (pdfMatch) {
    const row = await first(db, 'SELECT * FROM pdf_reports WHERE id = ?', pdfMatch[1]);
    if (!row) return bad(404, 'report not found');
    const signed = await verifyArtefactToken(env, row.id, R.ARTEFACT_KIND, url.searchParams.get('t'));
    if (!signed) {
      if (!session) return bad(401, 'authentication required');
      if (session.role === 'client') return bad(403, 'advisor surface');
      const scope = await resolveClientScope(db, session, row.client_id);
      if (!scope.ok) return bad(scope.status, scope.error);
    }
    return R.servePdfReport(env, row);
  }

  if (!session) return bad(401, 'authentication required');

  if (path === '/api/auth/me') {
    const advisor = await first(db, 'SELECT * FROM advisors WHERE user_id = ?', session.user_id);
    const client = await first(db, 'SELECT * FROM clients WHERE user_id = ?', session.user_id);
    return ok({ user: { id: session.user_id, name: session.name, email: session.email, role: session.role, via: session.via }, advisor_id: advisor?.id ?? null, client_id: client?.id ?? null });
  }

  if (path === '/api/auth/logout' && method === 'POST') {
    await logout(db, session.token);
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { ...JSON_HEADERS, 'set-cookie': 'ew_session=; Path=/; Max-Age=0' } });
  }

  // ── advisor surfaces ─────────────────────────────────────────────────────
  if (path === '/api/advisor/overview') {
    if (session.role === 'client') return bad(403, 'advisor surface');
    return ok(await advisorOverview(env, ctx, session));
  }

  // The daily agents, on demand. Returns the run at once; the portal polls it.
  if (path === '/api/advisor/refresh' && method === 'POST') {
    if (session.role === 'client') return bad(403, 'advisor surface');
    const advisor = await advisorFor(env, session);
    if (!advisor) return bad(404, 'no advisor record');
    await audit(db, { entity: 'overview_run', entity_id: advisor.id, action: 'refresh_requested', actor_id: session.user_id });
    return ok({ run: await A.startOverviewRun(env, ctx, { advisor, trigger: 'manual', actorId: session.user_id }) });
  }

  const runMatch = path.match(/^\/api\/advisor\/refresh\/([^/]+)$/);
  if (runMatch) {
    if (session.role === 'client') return bad(403, 'advisor surface');
    const advisor = await advisorFor(env, session);
    const row = await first(db, 'SELECT * FROM overview_runs WHERE id = ?', runMatch[1]);
    if (!row || (advisor && row.advisor_id !== advisor.id && session.role !== 'service')) return bad(404, 'run not found');
    return ok({ run: A.runView(row) });
  }

  if (path === '/api/advisor/clients') {
    if (session.role === 'client') return bad(403, 'advisor surface');
    return ok(await advisorClients(env, session));
  }

  if (path === '/api/advisor/signals') {
    if (session.role === 'client') return bad(403, 'advisor surface');
    return ok(await signalDashboard(env, session));
  }

  if (path === '/api/advisor/world-view' && method === 'POST') {
    if (session.role === 'client') return bad(403, 'advisor surface');
    return ok(await saveWorldView(env, session, body));
  }

  if (path === '/api/advisor/triggers') {
    if (session.role === 'client') return bad(403, 'advisor surface');
    if (method === 'POST') return ok(await upsertTrigger(env, session, body));
    const rows = await all(db, 'SELECT * FROM market_triggers ORDER BY indicator_key, threshold');
    return ok({ triggers: rows.map((r) => ({ ...r, asset_classes: json(r.asset_classes_json, []) })) });
  }

  if (path === '/api/advisor/correlations') {
    if (session.role === 'client') return bad(403, 'advisor surface');
    return ok(await advisorCorrelations(env, url.searchParams.get('window') || '1y'));
  }

  // Trailing-twelve-month return against volatility, one point per mapped asset, plus the market references.
  if (path === '/api/advisor/assets/risk-return') {
    if (session.role === 'client') return bad(403, 'advisor surface');
    return ok(await assetRiskReturn(env, db));
  }

  // The monitored indicators over any window, from the daily histories kept in R2 (worker/src/series.js).
  if (path === '/api/advisor/indicators/series') {
    if (session.role === 'client') return bad(403, 'advisor surface');
    const r = await S.indicatorSeries(env, { window: url.searchParams.get('window') || '30d', from: url.searchParams.get('from'), to: url.searchParams.get('to') });
    return r.error ? bad(400, r.error) : ok(r);
  }

  if (path === '/api/advisor/indicators/series/rebuild' && method === 'POST') {
    if (session.role === 'client') return bad(403, 'advisor surface');
    await audit(db, { entity: 'series_store', entity_id: 'indicators', action: 'rebuild_requested', actor_id: session.user_id });
    return ok(await S.warmSeriesStore(env, { force: true }));
  }

  // ── client-scoped ────────────────────────────────────────────────────────
  const clientMatch = path.match(/^\/api\/clients\/([^/]+)(\/.*)?$/);
  if (clientMatch) {
    const clientId = clientMatch[1];
    const sub = clientMatch[2] || '';
    const scope = await resolveClientScope(db, session, clientId);
    if (!scope.ok) return bad(scope.status, scope.error);
    return clientRoutes(env, request, { scope, sub, method, body, url, session, ctx });
  }

  // ── report artefacts from R2 ─────────────────────────────────────────────
  // ── pipeline (Rivet) ─────────────────────────────────────────────────────
  if (path.startsWith('/api/pipeline/')) {
    if (session.role === 'client') return bad(403, 'pipeline is not client accessible');
    return pipelineRoutes(env, path.slice('/api/pipeline/'.length), body, session);
  }

  if (path === '/api/llm/complete' && method === 'POST') {
    if (session.role === 'client') return bad(403, 'not permitted');
    if (!LLM.llmAvailable(env)) return ok({ mode: 'deterministic', reason: 'no model provider configured' });
    const out = await LLM.complete(env, { system: body.system, user: body.user, maxTokens: body.max_tokens ?? 2000 });
    return ok({ mode: 'model', ...out });
  }

  return bad(404, `no route for ${path}`);
}

async function readJson(request) {
  try { return await request.json(); } catch { return {}; }
}

// ═══════════════════════════════════════════════════════════════════════════
// Advisor surfaces
// ═══════════════════════════════════════════════════════════════════════════

async function advisorFor(env, session) {
  return session.role === 'service'
    ? first(env.DB, 'SELECT a.*, u.name, u.email FROM advisors a JOIN users u ON u.id = a.user_id LIMIT 1')
    : first(env.DB, 'SELECT a.*, u.name, u.email FROM advisors a JOIN users u ON u.id = a.user_id WHERE a.user_id = ?', session.user_id);
}

/**
 * The World Overview is whatever the daily agents last produced. Nothing is
 * recomputed on a page view: a fresh deploy with no run yet starts one and
 * tells the portal to wait for it.
 */
async function advisorOverview(env, ctx, session) {
  const db = env.DB;
  const advisor = await advisorFor(env, session);
  if (!advisor) throw new Error('no advisor record');
  const last = await A.latestRun(db, advisor.id, { status: 'completed' });
  const running = await A.latestRun(db, advisor.id, { status: 'running' });
  const active = running ? A.runView(running) : null;
  if (!last) {
    const started = active && active.status === 'running' ? active : await A.startOverviewRun(env, ctx, { advisor, trigger: 'bootstrap', actorId: session.user_id });
    const clients = await all(db, 'SELECT id FROM clients WHERE advisor_id = ?', advisor.id);
    return {
      pending: true, run: started, date: new Date().toISOString().slice(0, 10),
      advisor: { id: advisor.id, name: advisor.name, code: advisor.advisor_code, team: advisor.team },
      clients_count: clients.length,
    };
  }
  const result = json(last.result_json, {});
  // A run stored before the table was split by region gets its rows classified on the way out.
  const whatMatters = (result.what_matters || []).map((r) => ({ ...r, region: eventRegion(r) }));
  return { ...result, what_matters: whatMatters, run: A.runView(last), active_run: active && active.status === 'running' ? active : null };
}

/**
 * Correlation between the monitored indicators' daily returns.
 *
 * Only indicators with a daily price series take part: the Selic target and the
 * monthly IPCA are policy or monthly series and would correlate with nothing
 * meaningful at a daily frequency, so they are listed as excluded rather than
 * silently dropped. The daily closes come from the histories kept in R2
 * (worker/src/series.js), adjusted for dividends, so a five-year matrix costs
 * no provider call. Cached for an hour per window.
 */
const CORRELATION_WINDOWS = { '1y': 365, '2y': 730, '5y': 1826 };

async function advisorCorrelations(env, windowKey) {
  const key = CORRELATION_WINDOWS[windowKey] ? windowKey : '1y';
  const days = CORRELATION_WINDOWS[key];
  const to = new Date().toISOString().slice(0, 10);
  const from = addDays(to, -days);
  const cacheKey = `corr:${key}:${to}`;
  const cached = await cacheGet(cacheKey, 3600);
  if (cached) return { ...cached, from_cache: true };

  const series = [];
  const sources = [];
  const excluded = INDICATORS.filter((i) => !i.yahoo_symbol)
    .map((i) => ({ key: i.key, label: i.label, reason: 'série mensal ou de política, não um preço diário' }));
  for (const ind of INDICATORS.filter((i) => i.yahoo_symbol)) {
    const s = await S.ensureSeries(env, ind, { from });
    const points = s.unavailable ? [] : s.points.filter((p) => p.date >= from && p.date <= to).map((p) => ({ date: p.date, close: p.adj ?? p.close }));
    if (s.unavailable || points.length < 20) {
      excluded.push({ key: ind.key, label: ind.label, reason: s.unavailable ? s.reason : 'série insuficiente no período' });
      continue;
    }
    series.push({
      key: ind.key, label: ind.label, group: ind.group, symbol: ind.yahoo_symbol,
      first: points[0].date, last: points[points.length - 1].date,
      returns: logReturns(points),
    });
    sources.push(s.source);
  }

  const { matrix, observations } = correlationMatrix(series);
  const pairs = observations.flatMap((row, i) => row.filter((_, j) => j !== i));
  const result = {
    window: { key, days, from, to },
    method: 'Pearson sobre retornos diários logarítmicos, pares completos',
    indicators: series.map(({ returns, ...rest }) => ({ ...rest, observations: returns.size })),
    matrix,
    observations,
    pair_observations: pairs.length ? { min: Math.min(...pairs), max: Math.max(...pairs) } : null,
    excluded,
    computed_at: nowIso(),
    sources: [...sources, makeSource({
      provider: 'XP Asset Management (derivado)', kind: 'derived', instrument: 'Matriz de correlação',
      identifier: `corr-${key}`, requested_range: `${from}..${to}`, last_observation: to,
      notes: 'Pearson sobre retornos diários logarítmicos; cada par medido nas datas que ambas as séries observaram',
    })],
  };
  await cacheSet(cacheKey, result, 3600);
  return result;
}

async function advisorClients(env, session) {
  const db = env.DB;
  const advisor = await advisorFor(env, session);
  const clients = await all(db, 'SELECT * FROM clients WHERE advisor_id = ? ORDER BY full_name', advisor.id);
  const month = previousMonth(new Date().toISOString().slice(0, 10));

  const rows = [];
  for (const c of clients) {
    const snap = await currentSnapshot(db, c.id);
    const policy = await currentPolicy(db, c.id);
    const positions = snap ? await snapshotPositions(db, snap.id) : [];
    const total = positions.reduce((a, p) => a + (p.market_value || 0), 0);
    const lastReturn = await first(db, 'SELECT * FROM monthly_returns WHERE client_id = ? ORDER BY month DESC LIMIT 1', c.id);
    const lastMeeting = await first(db, "SELECT * FROM meetings WHERE client_id = ? AND status = 'held' ORDER BY date DESC LIMIT 1", c.id);
    const nextMeeting = await first(db, "SELECT * FROM meetings WHERE client_id = ? AND status = 'scheduled' ORDER BY date LIMIT 1", c.id);
    const report = await first(db, 'SELECT * FROM reports WHERE client_id = ? AND reporting_month = ?', c.id, month);

    const exposures = {};
    for (const p of positions) exposures[p.asset_class] = (exposures[p.asset_class] ?? 0) + (p.market_value || 0) / (total || 1);
    const alerts = [];
    if (policy) {
      for (const d of P.driftTriggers(exposures, policy.target_allocation, policy.rebalance_trigger ?? 0.05)) {
        alerts.push({ kind: 'drift', message: d.label_pt || d.label, severity: 'medium' });
      }
      for (const [k, band] of Object.entries(policy.permitted_ranges || {})) {
        const w = exposures[k] ?? 0;
        if (band.min != null && w < band.min) alerts.push({ kind: 'band', message: `${classPt(k)} abaixo da faixa (${(w * 100).toFixed(1)}% < ${(band.min * 100).toFixed(0)}%)`, severity: 'medium' });
        if (band.max != null && w > band.max) alerts.push({ kind: 'band', message: `${classPt(k)} acima da faixa (${(w * 100).toFixed(1)}% > ${(band.max * 100).toFixed(0)}%)`, severity: 'high' });
      }
      const cap = policy.single_name_cap ?? 0.1;
      for (const p of positions) {
        const w = (p.market_value || 0) / (total || 1);
        if (w > cap && p.type !== 'etf' && p.type !== 'cash' && p.type !== 'reit') {
          alerts.push({ kind: 'concentration', message: `${p.asset_name} em ${(w * 100).toFixed(1)}% (teto ${(cap * 100).toFixed(0)}%)`, severity: 'high' });
        }
      }
    }

    rows.push({
      id: c.id, name: c.full_name, risk_profile: c.risk_profile, base_currency: c.base_currency,
      segment: c.segment, portfolio_value: total,
      last_month: lastReturn ? { month: lastReturn.month, portfolio_return: lastReturn.portfolio_return, benchmark_return: lastReturn.benchmark_return } : null,
      last_meeting: lastMeeting?.date ?? null,
      next_review: nextMeeting?.date ?? c.next_review_at ?? null,
      policy_version: policy?.version ?? null,
      snapshot_date: snap?.effective_date ?? null,
      priced_at: snap?.created_at ?? null,           // when the positions were last valued: the snapshot's creation
      report_status: report?.status ?? 'not_generated',
      report_id: report?.id ?? null,
      alerts,
    });
  }
  return { month, clients: rows };
}

async function signalDashboard(env, session) {
  const db = env.DB;
  const advisor = await advisorFor(env, session);
  const rows = await all(db, `
    SELECT s.*, a.ticker, a.name, a.asset_class, a.type
      FROM tradingview_signals s JOIN assets a ON a.id = s.asset_id
     WHERE s.id IN (SELECT id FROM tradingview_signals t2 WHERE t2.asset_id = s.asset_id ORDER BY captured_at DESC LIMIT 1)
     ORDER BY a.asset_class, a.ticker`);
  if (!rows.length) {
    // First run: capture the whole advisor universe once.
    const assets = await all(db, 'SELECT * FROM assets WHERE tv_symbol IS NOT NULL');
    await P.fetchSignals(env, assets);
    return signalDashboard(env, session);
  }
  const held = await all(db, `
    SELECT DISTINCT p.asset_id FROM positions p
      JOIN portfolio_snapshots s ON s.id = p.portfolio_snapshot_id
      JOIN clients c ON c.id = s.client_id
     WHERE c.advisor_id = ? AND s.status = 'approved'`, advisor.id);
  const heldSet = new Set(held.map((h) => h.asset_id));

  return {
    captured_at: rows[0]?.captured_at ?? null,
    signals: rows.map((r) => ({
      asset_id: r.asset_id, ticker: r.ticker, name: r.name, asset_class: r.asset_class, type: r.type,
      held_by_book: heldSet.has(r.asset_id),
      technical: { signal: r.technical_signal, rating: r.technical_rating, timeframe: r.technical_timeframe, weekly: r.technical_weekly, rsi: r.rsi_14 },
      analyst: r.analyst_signal
        ? { consensus: r.analyst_signal, mark: r.analyst_mark, count: r.analyst_count, buy: r.analyst_buy, hold: r.analyst_hold, sell: r.analyst_sell, target: r.target_price, upside: r.implied_upside }
        : { consensus: null, unavailable: true, reason: 'No analyst consensus available' },
      conflict: !!(r.technical_signal && r.analyst_signal && conflictOf(r.technical_signal, r.analyst_signal)),
      captured_at: r.captured_at,
    })),
  };
}

const SIG_SCORE = { 'Strong Buy': 2, Buy: 1, Neutral: 0, Sell: -1, 'Strong Sell': -2 };
const conflictOf = (t, a) => Math.sign(SIG_SCORE[t] ?? 0) !== 0 && Math.sign(SIG_SCORE[a] ?? 0) !== 0 && Math.sign(SIG_SCORE[t]) !== Math.sign(SIG_SCORE[a]);

async function saveWorldView(env, session, body) {
  const db = env.DB;
  const advisor = await advisorFor(env, session);
  const today = body.date || new Date().toISOString().slice(0, 10);
  const existing = await first(db, 'SELECT * FROM world_overviews WHERE advisor_id = ? AND date = ?', advisor.id, today);
  if (!existing) return { error: 'no world view for this date' };
  const stance = body.stance ? JSON.stringify(body.stance) : existing.stance_json;
  const status = body.approve ? 'approved' : existing.approval_status;
  await run(db, 'UPDATE world_overviews SET advisor_commentary = ?, stance_json = ?, approval_status = ?, approved_at = ? WHERE id = ?',
    body.commentary ?? existing.advisor_commentary, stance, status, body.approve ? nowIso() : existing.approved_at, existing.id);
  await audit(db, { entity: 'world_overview', entity_id: existing.id, action: body.approve ? 'approved' : 'edited', actor_id: session.user_id, detail: { stance: body.stance } });
  const updated = await first(db, 'SELECT * FROM world_overviews WHERE id = ?', existing.id);
  return { ...updated, briefing: json(updated.briefing_json, {}), stance: json(updated.stance_json, {}) };
}

async function upsertTrigger(env, session, body) {
  const db = env.DB;
  const advisor = await advisorFor(env, session);
  const tid = body.id || id('trg');
  await run(db, `INSERT INTO market_triggers (id, label, indicator_key, field, comparator, threshold, unit, approach_ratio, persistence_days, asset_classes_json, action, enabled, advisor_id, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET label=excluded.label, indicator_key=excluded.indicator_key, comparator=excluded.comparator,
      threshold=excluded.threshold, unit=excluded.unit, persistence_days=excluded.persistence_days,
      asset_classes_json=excluded.asset_classes_json, action=excluded.action, enabled=excluded.enabled, updated_at=excluded.updated_at`,
    tid, body.label, body.indicator_key, body.field || 'price', body.comparator || 'gt', Number(body.threshold),
    body.unit || null, body.approach_ratio ?? 0.95, body.persistence_days ?? 1,
    JSON.stringify(body.asset_classes || []), body.action || null, body.enabled === false ? 0 : 1, advisor.id, nowIso());
  await audit(db, { entity: 'market_trigger', entity_id: tid, action: body.id ? 'updated' : 'created', actor_id: session.user_id, detail: body });
  return { id: tid, ok: true };
}

// ═══════════════════════════════════════════════════════════════════════════
// Client-scoped routes
// ═══════════════════════════════════════════════════════════════════════════

async function clientRoutes(env, request, { scope, sub, method, body, url, session, ctx }) {
  const db = env.DB;
  const { client, advisor, actingAs } = scope;
  const isAdvisor = actingAs !== 'client';

  if (sub === '' || sub === '/') {
    const policy = await currentPolicy(db, client.id);
    const snap = await currentSnapshot(db, client.id);
    const positions = snap ? await snapshotPositions(db, snap.id) : [];
    const total = positions.reduce((a, p) => a + (p.market_value || 0), 0);
    const returns = await all(db, 'SELECT * FROM monthly_returns WHERE client_id = ? ORDER BY month', client.id);
    const reports = await all(db, 'SELECT id, reporting_month, status, published_at, page_count FROM reports WHERE client_id = ? ORDER BY reporting_month DESC', client.id);
    return ok({
      client: { id: client.id, name: client.full_name, risk_profile: client.risk_profile, base_currency: client.base_currency, segment: client.segment, next_review_at: client.next_review_at },
      advisor: advisor ? { id: advisor.id, code: advisor.advisor_code } : null,
      policy, snapshot: snap,
      total_value: total,
      allocation: allocationOf(positions, total, policy),
      returns: returns.map((r) => ({ month: r.month, portfolio: r.portfolio_return, benchmark: r.benchmark_return, method: r.method })),
      reports: isAdvisor ? reports : reports.filter((r) => r.status === 'published'),
      acting_as: actingAs,
    });
  }

  if (sub === '/holdings') {
    const snap = await currentSnapshot(db, client.id);
    const positions = snap ? await snapshotPositions(db, snap.id) : [];
    const total = positions.reduce((a, p) => a + (p.market_value || 0), 0);
    return ok({
      snapshot: snap,
      total_value: total,
      holdings: positions.map((p) => ({
        asset_id: p.asset_id, ticker: p.ticker, isin: p.isin, name: p.asset_name, type: p.type,
        asset_class: p.asset_class, currency: p.currency, quantity: p.quantity, cost_basis: p.cost_basis,
        price: p.price, market_value: p.market_value, weight: total ? p.market_value / total : 0,
        pricing_mode: p.pricing_mode, liquidity_days: p.liquidity_days, risk_grade: p.risk_grade,
        corporate_action: p.corporate_action, portfolio_role: p.portfolio_role, notes: p.notes,
        unrealised: p.cost_basis && p.quantity ? (p.market_value - p.cost_basis * p.quantity) : null,
      })).sort((a, b) => b.market_value - a.market_value),
    });
  }

  if (sub === '/policy') {
    const policy = await currentPolicy(db, client.id);
    return ok({ policy });
  }

  if (sub === '/policy/history') {
    const rows = await all(db, 'SELECT * FROM investment_policies WHERE client_id = ? ORDER BY version DESC', client.id);
    return ok({ versions: rows.map(hydratePolicy) });
  }

  if (sub === '/snapshots') {
    if (method === 'POST') {
      if (!isAdvisor) return bad(403, 'clients may not change the portfolio');
      return ok(await createSnapshot(env, scope, body, session));
    }
    const rows = await all(db, 'SELECT * FROM portfolio_snapshots WHERE client_id = ? ORDER BY effective_date DESC', client.id);
    const out = [];
    for (const s of rows) {
      const positions = await snapshotPositions(db, s.id);
      out.push({ ...s, positions: positions.map((p) => ({ ticker: p.ticker, name: p.asset_name, asset_class: p.asset_class, market_value: p.market_value, weight: s.total_value ? p.market_value / s.total_value : null })) });
    }
    return ok({ snapshots: out });
  }

  if (sub === '/meetings') {
    if (method === 'POST') {
      if (!isAdvisor) return bad(403, 'advisor only');
      const mid = body.id || id('mtg');
      await run(db, `INSERT INTO meetings (id, client_id, advisor_id, date, notes, status, agenda_json) VALUES (?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET date=excluded.date, notes=excluded.notes, status=excluded.status, agenda_json=excluded.agenda_json`,
        mid, client.id, client.advisor_id, body.date, body.notes ?? null, body.status || 'in_preparation', body.agenda ? JSON.stringify(body.agenda) : null);
      await audit(db, { entity: 'meeting', entity_id: mid, action: body.id ? 'updated' : 'created', actor_id: session.user_id, detail: { date: body.date, status: body.status } });
      return ok({ id: mid, ok: true });
    }
    const rows = await all(db, 'SELECT * FROM meetings WHERE client_id = ? ORDER BY date DESC', client.id);
    return ok({ meetings: rows.map((m) => ({ ...m, agenda: json(m.agenda_json, null) })) });
  }

  if (sub === '/meeting-prep') {
    if (!isAdvisor) return bad(403, 'advisor only');
    return ok(await meetingPrep(env, scope, url.searchParams.get('month')));
  }

  // ── what the client may read of the advisor's World Overview ─────────────
  // The day's briefing and the indicators, from the advisor's last completed
  // run. Nothing about other clients (the What Matters exposures, the drift
  // alerts, the book) and nothing that starts a run: the client reads what the
  // advisor's agents produced.
  if (sub === '/overview') {
    const last = advisor ? await A.latestRun(db, advisor.id, { status: 'completed' }) : null;
    if (!last) return ok({ pending: true, date: new Date().toISOString().slice(0, 10) });
    const r = json(last.result_json, {});
    const wv = r.world_view || null;
    const hl = r.news?.headlines || null;
    return ok({
      date: r.date,
      world_view: wv ? { generated_summary: wv.generated_summary ?? null, approval_status: wv.approval_status ?? null, briefing: wv.briefing ?? null } : null,
      indicators: r.indicators || [],
      sources: r.sources || [],
      inference: r.inference ? { mode: r.inference.mode, model: r.inference.model ?? null } : null,
      news: r.news ? {
        mode: r.news.mode, reason: r.news.reason ?? null, searches: r.news.searches ?? 0, kept: r.news.kept ?? 0,
        headlines: hl ? { provider: hl.provider, providers: hl.providers ?? [], window_hours: hl.window_hours, mode: hl.mode, reason: hl.reason ?? null, items: hl.items, kept: hl.kept, classified_by: hl.classified_by, top_story: hl.top_story ?? null } : null,
      } : null,
      run: { finished_at: last.finished_at, trigger: last.trigger },
    });
  }

  // The monitored indicators over any window, the same series the advisor reads.
  if (sub === '/indicators/series') {
    const r = await S.indicatorSeries(env, { window: url.searchParams.get('window') || '30d', from: url.searchParams.get('from'), to: url.searchParams.get('to') });
    return r.error ? bad(400, r.error) : ok(r);
  }

  // ── the report agent: a two-page PDF on demand, advisor only ──────────────
  if (sub === '/pdf-reports') {
    if (!isAdvisor) return bad(403, 'advisor only');
    if (method === 'POST') {
      await audit(db, { entity: 'pdf_report', entity_id: client.id, action: 'requested', actor_id: session.user_id });
      return ok({ run: await R.startReportRun(env, ctx, { scope, actorId: session.user_id }) });
    }
    return ok({ reports: await R.listReportRuns(env, client.id) });
  }
  const pdfRun = sub.match(/^\/pdf-reports\/([^/]+)$/);
  if (pdfRun) {
    if (!isAdvisor) return bad(403, 'advisor only');
    const row = await first(db, 'SELECT * FROM pdf_reports WHERE id = ? AND client_id = ?', pdfRun[1], client.id);
    if (!row) return bad(404, 'run not found');
    return ok({ run: await R.runView(env, row) });
  }

  if (sub === '/recommendations') {
    const setId = url.searchParams.get('set');
    const monthParam = url.searchParams.get('month');
    const rows = setId
      ? await all(db, 'SELECT * FROM recommendations WHERE client_id = ? AND recommendation_set_id = ?', client.id, setId)
      : await all(db, 'SELECT * FROM recommendations WHERE client_id = ? AND reporting_month = COALESCE(?, (SELECT MAX(reporting_month) FROM recommendations WHERE client_id = ?))', client.id, monthParam, client.id);
    const assetRows = rows.length
      ? await all(db, `SELECT id, ticker, name, asset_class, type FROM assets WHERE id IN (${rows.map(() => '?').join(',')})`, ...rows.map((r) => r.asset_id))
      : [];
    const assetById = new Map(assetRows.map((a) => [a.id, a]));
    const mapped = rows.map((r) => {
      const a = assetById.get(r.asset_id) || {};
      return { ...hydrateRecommendation(r), ticker: a.ticker, name: a.name, asset_class: a.asset_class, type: a.type };
    });
    return ok({ recommendations: isAdvisor ? mapped : mapped.filter((r) => r.advisor_status === 'approved') });
  }

  const decisionMatch = sub.match(/^\/recommendations\/([^/]+)\/decision$/);
  if (decisionMatch && method === 'POST') {
    if (!isAdvisor) return bad(403, 'advisor only');
    const recId = decisionMatch[1];
    const status = body.status;
    if (!['approved', 'rejected', 'edited', 'proposed'].includes(status)) return bad(400, 'invalid status');
    await run(db, 'UPDATE recommendations SET advisor_status = ?, advisor_note = ?, final_action = COALESCE(?, final_action), decided_at = ? WHERE id = ? AND client_id = ?',
      status, body.note ?? null, body.final_action ?? null, nowIso(), recId, client.id);
    await audit(db, { entity: 'recommendation', entity_id: recId, action: `advisor_${status}`, actor_id: session.user_id, detail: { note: body.note, final_action: body.final_action } });
    return ok({ ok: true });
  }

  if (sub === '/performance') {
    const month = url.searchParams.get('month') || previousMonth(new Date().toISOString().slice(0, 10));
    const report = await first(db, 'SELECT * FROM reports WHERE client_id = ? AND reporting_month = ?', client.id, month);
    if (report) {
      const canonical = json(report.canonical_report_json, {});
      if (!isAdvisor && report.status !== 'published') return bad(404, 'report not available');
      return ok({ month, from_report: true, report_id: report.id, report_created_at: report.created_at, performance: canonical.portfolio_performance, attribution: canonical.performance_attribution, benchmark: canonical.benchmark, metrics: canonical.portfolio_metrics, sources: canonical.sources });
    }
    if (!isAdvisor) return bad(404, 'no published report for this month');
    const live = await runProfitabilityLive(env, client.id, month);
    return ok({ month, from_report: false, ...live });
  }

  if (sub === '/reports') {
    const rows = await all(db, 'SELECT id, reporting_month, status, page_count, approved_at, published_at, created_at, pdf_r2_key, html_r2_key FROM reports WHERE client_id = ? ORDER BY reporting_month DESC', client.id);
    const visible = isAdvisor ? rows : rows.filter((r) => r.status === 'published');
    const withLinks = [];
    for (const r of visible) withLinks.push({ ...r, links: await artefactLinks(env, r.id) });
    return ok({ reports: withLinks });
  }

  const reportSub = sub.match(/^\/reports\/([^/]+)$/);
  if (reportSub) {
    const report = await first(db, 'SELECT * FROM reports WHERE id = ? AND client_id = ?', reportSub[1], client.id);
    if (!report) return bad(404, 'report not found');
    if (!isAdvisor && report.status !== 'published') return bad(404, 'report not available');
    return ok({ report: { ...report, canonical: json(report.canonical_report_json, {}), links: await artefactLinks(env, report.id) } });
  }

  const approveMatch = sub.match(/^\/reports\/([^/]+)\/(approve|publish)$/);
  if (approveMatch && method === 'POST') {
    if (!isAdvisor) return bad(403, 'advisor only');
    const [, reportId, action] = approveMatch;
    const report = await first(db, 'SELECT * FROM reports WHERE id = ? AND client_id = ?', reportId, client.id);
    if (!report) return bad(404, 'report not found');
    if (action === 'approve') {
      await run(db, "UPDATE reports SET status = 'approved', approved_at = ? WHERE id = ?", nowIso(), reportId);
    } else {
      if (report.status !== 'approved') return bad(409, 'a report must be approved before it is published to the client');
      await run(db, "UPDATE reports SET status = 'published', published_at = ? WHERE id = ?", nowIso(), reportId);
    }
    await audit(db, { entity: 'report', entity_id: reportId, action, actor_id: session.user_id });
    return ok({ ok: true, status: action === 'approve' ? 'approved' : 'published' });
  }

  if (sub === '/audit') {
    if (!isAdvisor) return bad(403, 'advisor only');
    const rows = await all(db, `SELECT * FROM audit_log WHERE entity_id IN
        (SELECT id FROM reports WHERE client_id = ?1)
        OR entity_id IN (SELECT id FROM recommendations WHERE client_id = ?1)
        OR entity_id IN (SELECT id FROM portfolio_snapshots WHERE client_id = ?1)
        OR entity_id = ?1
      ORDER BY created_at DESC LIMIT 200`, client.id);
    const sources = await all(db, 'SELECT * FROM data_sources WHERE report_id IN (SELECT id FROM reports WHERE client_id = ?) ORDER BY retrieval_timestamp DESC LIMIT 300', client.id);
    const runs = await all(db, 'SELECT * FROM graph_runs WHERE client_id = ? ORDER BY started_at DESC LIMIT 30', client.id);
    return ok({ audit: rows.map((r) => ({ ...r, detail: json(r.detail_json, null) })), sources, graph_runs: runs });
  }

  return bad(404, `no client route for ${sub}`);
}

async function createSnapshot(env, scope, body, session) {
  const db = env.DB;
  const { client } = scope;
  const policy = body.investment_policy_id
    ? await first(db, 'SELECT * FROM investment_policies WHERE id = ? AND client_id = ?', body.investment_policy_id, client.id)
    : await currentPolicy(db, client.id);
  const snapId = id('snp');
  const total = (body.positions || []).reduce((a, p) => a + Number(p.market_value || 0), 0);

  // Snapshots are never overwritten. The previous approved snapshot is marked
  // superseded and stays queryable forever (§11).
  await run(db, "UPDATE portfolio_snapshots SET status = 'superseded' WHERE client_id = ? AND status = 'approved'", client.id);
  await run(db, `INSERT INTO portfolio_snapshots (id, client_id, meeting_id, investment_policy_id, effective_date, status, total_value, cash_balance, base_currency, advisor_commentary, world_overview_id, recommendation_set_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    snapId, client.id, body.meeting_id ?? null, policy.id, body.effective_date || new Date().toISOString().slice(0, 10),
    'approved', total, Number(body.cash_balance || 0), client.base_currency, body.commentary ?? null,
    body.world_overview_id ?? null, body.recommendation_set_id ?? null);

  for (const p of body.positions || []) {
    await run(db, 'INSERT INTO positions (id, portfolio_snapshot_id, asset_id, quantity, cost_basis, price, market_value, portfolio_weight, acquired_at, notes) VALUES (?,?,?,?,?,?,?,?,?,?)',
      id('pos'), snapId, p.asset_id, p.quantity ?? null, p.cost_basis ?? null, p.price ?? null,
      Number(p.market_value || 0), total ? Number(p.market_value || 0) / total : null, p.acquired_at ?? null, p.notes ?? null);
  }
  await audit(db, { entity: 'portfolio_snapshot', entity_id: snapId, action: 'created', actor_id: session.user_id, detail: { effective_date: body.effective_date, total_value: total, positions: (body.positions || []).length } });
  return { id: snapId, total_value: total, ok: true };
}

// ═══════════════════════════════════════════════════════════════════════════
// Pipeline routes — the Rivet graph's targets
// ═══════════════════════════════════════════════════════════════════════════

async function loadRun(env, runId) {
  const row = await first(env.DB, 'SELECT * FROM graph_runs WHERE id = ?', runId);
  if (!row) throw new Error(`unknown run ${runId}`);
  return { row, state: json(row.outputs_json, {}) };
}

async function saveRun(env, runId, state, patch = {}) {
  await run(env.DB, 'UPDATE graph_runs SET outputs_json = ?, status = COALESCE(?, status), finished_at = COALESCE(?, finished_at), error = COALESCE(?, error) WHERE id = ?',
    JSON.stringify(state), patch.status ?? null, patch.finished_at ?? null, patch.error ?? null, runId);
}

async function pipelineRoutes(env, step, body, session) {
  const db = env.DB;

  if (step === 'start') {
    const runId = body.run_id || id('run');
    const month = body.month || previousMonth(new Date().toISOString().slice(0, 10));
    await run(db, 'INSERT INTO graph_runs (id, graph_name, client_id, advisor_id, started_at, status, prompt_version, inputs_json, outputs_json) VALUES (?,?,?,?,?,?,?,?,?)',
      runId, body.graph || 'monthly_client_report', body.client_id ?? null, body.advisor_id ?? null,
      nowIso(), 'running', body.prompt_version || PROMPT_VERSION || null, JSON.stringify(body), '{}');
    return ok({ run_id: runId, month, started_at: nowIso() });
  }

  if (step === 'context') {
    const { state } = await loadRun(env, body.run_id);
    const ctx = await P.loadClientContext(env, body.client_id, { month: body.month });
    state.ctx = ctx;
    await saveRun(env, body.run_id, state);
    return ok({
      run_id: body.run_id,
      client: { id: ctx.client.id, name: ctx.client.full_name, risk_profile: ctx.client.risk_profile, base_currency: ctx.client.base_currency },
      advisor: { id: ctx.advisor?.id, name: ctx.advisor?.name, code: ctx.advisor?.advisor_code },
      policy_version: ctx.policy?.version,
      snapshot: { id: ctx.snapshot.id, effective_date: ctx.snapshot.effective_date },
      positions: ctx.positions.length,
      flows: ctx.flows.length,
      reporting_period: ctx.reporting_period,
    });
  }

  if (step === 'market-data') {
    const { state } = await loadRun(env, body.run_id);
    const market = await P.fetchAndValidateMarketData(env, state.ctx);
    state.market = market;
    await saveRun(env, body.run_id, state);
    return ok({
      run_id: body.run_id,
      priced: market.priced.filter((p) => p.open_price != null).length,
      unavailable: market.validation.filter((v) => v.status === 'unavailable').map((v) => ({ ticker: v.ticker, reason: v.reason })),
      review: market.validation.filter((v) => v.status === 'review'),
      sources: market.ledger.length,
      fx: { open: market.fx.open, close: market.fx.close },
      cdi: market.cdi.unavailable ? null : market.cdi.value,
    });
  }

  if (step === 'profitability') {
    const { state } = await loadRun(env, body.run_id);
    const perf = await P.computeProfitability(env, state.ctx, state.market);
    const benchmark = await P.computeBenchmark(env, state.ctx, state.market);
    const metrics = await P.computeMetrics(env, state.ctx);
    state.perf = perf; state.benchmark = benchmark; state.metrics = metrics;
    await saveRun(env, body.run_id, state);

    await run(db, `INSERT INTO monthly_returns (id, client_id, month, portfolio_return, benchmark_return, method) VALUES (?,?,?,?,?,?)
      ON CONFLICT(client_id, month) DO UPDATE SET portfolio_return=excluded.portfolio_return, benchmark_return=excluded.benchmark_return, method=excluded.method, computed_at=datetime('now')`,
      id('mr'), state.ctx.client.id, state.ctx.reporting_period.month, perf.monthly_return, benchmark.available ? benchmark.value : null, perf.method);

    return ok({
      run_id: body.run_id,
      monthly_return: perf.monthly_return,
      method: perf.method,
      beginning_market_value: perf.beginning_market_value,
      ending_market_value: perf.ending_market_value,
      absolute_pnl: perf.absolute_pnl,
      net_flows: perf.net_flows,
      benchmark: benchmark.available ? { value: benchmark.value, coverage: benchmark.coverage } : { unavailable: true, reason: benchmark.reason },
      excess: benchmark.available ? perf.monthly_return - benchmark.value : null,
      best: perf.attribution.best_contributor ? { name: perf.attribution.best_contributor.name, contribution: perf.attribution.best_contributor.contribution } : null,
      worst: perf.attribution.worst_contributor ? { name: perf.attribution.worst_contributor.name, contribution: perf.attribution.worst_contributor.contribution } : null,
      fx_contribution: perf.attribution.fx_contribution,
      reconciles: perf.attribution.reconciles,
      by_asset_class: perf.attribution.by_asset_class.map((c) => ({ asset_class: c.asset_class, contribution: c.contribution, return: c.return })),
      metrics: metrics.available ? { annualised_return: metrics.annualised_return, annualised_volatility: metrics.annualised_volatility, sharpe_ratio: metrics.sharpe_ratio, max_drawdown: metrics.max_drawdown, three_year_return: metrics.three_year_return } : { unavailable: true, reason: metrics.reason },
    });
  }

  if (step === 'market-intel') {
    const { state } = await loadRun(env, body.run_id);
    const indicators = await P.fetchIndicators(env, INDICATORS);
    const triggers = await P.evaluateTriggers(env, indicators, state.ctx?.advisor?.id);
    const today = new Date().toISOString().slice(0, 10);
    const curated = await P.loadMarketEvents(env, { since: addDays(today, -35), limit: 20 });
    const generated = P.eventsFromIndicatorMoves(indicators);
    const events = dedupeEvents([...curated, ...generated]);

    const total = state.perf?.ending_market_value || 1;
    const exposures = {};
    for (const p of state.market.priced) exposures[p.asset.asset_class] = (exposures[p.asset.asset_class] ?? 0) + (p.market_value ?? 0) / total;
    const portfolio = {
      exposures,
      base_currency: state.ctx.policy?.base_currency || 'BRL',
      positions: state.market.priced.map((p) => ({ ticker: p.asset.ticker, asset_id: p.asset.id, asset_class: p.asset.asset_class, weight: (p.market_value ?? 0) / total, currency: p.asset.currency })),
    };
    const impact = events.map((e) => P.mapEventToPortfolio(e, portfolio)).filter((i) => i.relevance !== 'none');

    state.indicators = indicators.map(compactIndicator);
    state.triggers = triggers;
    state.events = events;
    state.impact = impact;
    state.exposures = exposures;
    await saveRun(env, body.run_id, state);

    return ok({
      run_id: body.run_id,
      indicators: state.indicators.filter((i) => !i.unavailable).map((i) => ({ key: i.key, label: i.label, price: i.price, mtdPct: i.mtdPct, unit: i.unit, asOf: i.asOf })),
      indicators_unavailable: state.indicators.filter((i) => i.unavailable).map((i) => ({ key: i.key, reason: i.reason })),
      triggers_fired: triggers.filter((t) => t.status === 'BREACHED').map((t) => ({ label: t.label, observed: t.observed, threshold: t.threshold, action: t.action })),
      events: events.map((e) => ({ id: e.id, title: e.title, category: e.category, importance: e.importance, summary: e.summary, asset_classes: e.asset_classes, source_id: e.source_id })),
      impact: impact.map((i) => ({ event_id: i.event_id, title: i.title, relevance: i.relevance, exposure: i.portfolio_exposure.total_exposure, potential_impact: i.potential_impact, discussion_prompt: i.discussion_prompt })),
      exposures,
    });
  }

  if (step === 'signals') {
    const { state } = await loadRun(env, body.run_id);
    const heldAssets = state.market.priced.map((p) => p.asset).filter((a) => a.tv_symbol);
    const candidateIds = body.candidates || await defaultCandidates(env, state);
    const candidateRows = candidateIds.length
      ? await all(db, `SELECT * FROM assets WHERE id IN (${candidateIds.map(() => '?').join(',')})`, ...candidateIds)
      : [];
    const signals = await P.fetchSignals(env, [...heldAssets, ...candidateRows.filter((a) => a.tv_symbol)]);
    state.signals = signals;
    state.candidates = candidateIds;
    await saveRun(env, body.run_id, state);
    return ok({
      run_id: body.run_id,
      captured: Object.keys(signals).length,
      technical_available: Object.values(signals).filter((s) => !s.technical?.unavailable).length,
      analyst_available: Object.values(signals).filter((s) => !s.analyst?.unavailable).length,
      rows: Object.entries(signals).map(([sym, s]) => ({
        symbol: sym,
        technical: s.technical?.unavailable ? null : s.technical.signal,
        analyst: s.analyst?.unavailable ? null : s.analyst.consensus,
        analyst_count: s.analyst?.analyst_count ?? null,
        analyst_reason: s.analyst?.unavailable ? s.analyst.reason : null,
        target: s.analyst?.target_price?.average ?? null,
      })),
    });
  }

  if (step === 'recommendations') {
    const { state } = await loadRun(env, body.run_id);
    const advisorId = state.ctx.advisor?.id;
    const wv = advisorId ? await first(db, 'SELECT * FROM world_overviews WHERE advisor_id = ? ORDER BY date DESC LIMIT 1', advisorId) : null;
    const worldView = wv ? { ...json(wv.briefing_json, {}), stance_by_asset_class: json(wv.stance_json, {}), date: wv.date, approval_status: wv.approval_status, advisor_commentary: wv.advisor_commentary } : {};
    const built = await P.buildAndCheckRecommendations(env, state.ctx, state.market, state.perf, state.signals, worldView, state.candidates || []);

    const month = state.ctx.reporting_period.month;
    const existingRows = await all(db, 'SELECT * FROM recommendations WHERE client_id = ? AND reporting_month = ?', state.ctx.client.id, month);
    const existingByAsset = new Map(existingRows.map((r) => [r.asset_id, r]));
    const setId = existingRows[0]?.recommendation_set_id || id('recset');
    let carried = 0;
    let reopened = 0;

    for (const r of built.recommendations) {
      const prev = existingByAsset.get(r.asset_id);
      // An advisor decision survives a re-run of the workflow. It is reset only
      // when the underlying proposal actually changed, and the reason is recorded.
      const materiallyChanged = prev
        && (prev.proposed_action !== r.proposed_action
          || prev.suitability_result !== r.suitability_result
          || (prev.signal_conflict === 1) !== r.signal_conflict);
      const advisorStatus = prev && !materiallyChanged ? prev.advisor_status : 'proposed';
      const advisorNote = prev && !materiallyChanged ? prev.advisor_note : null;
      const finalAction = prev && !materiallyChanged && prev.advisor_status === 'edited' ? prev.final_action : r.final_action;
      if (prev && !materiallyChanged && prev.advisor_status !== 'proposed') carried += 1;
      if (prev && materiallyChanged && prev.advisor_status !== 'proposed') reopened += 1;

      await run(db, `INSERT INTO recommendations (id, client_id, asset_id, reporting_month, recommendation_set_id, tradingview_signal_id, proposed_action, final_action, suitability_result, score, conviction, signal_conflict, current_weight, rationale, factors_json, flags_json, statement_json, advisor_status, advisor_note, decided_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(client_id, reporting_month, asset_id) DO UPDATE SET
          recommendation_set_id = excluded.recommendation_set_id,
          tradingview_signal_id = excluded.tradingview_signal_id,
          proposed_action = excluded.proposed_action, final_action = excluded.final_action,
          suitability_result = excluded.suitability_result, score = excluded.score,
          conviction = excluded.conviction, signal_conflict = excluded.signal_conflict,
          current_weight = excluded.current_weight, factors_json = excluded.factors_json,
          flags_json = excluded.flags_json, statement_json = excluded.statement_json,
          advisor_status = excluded.advisor_status, advisor_note = excluded.advisor_note`,
        prev?.id || id('rec'), state.ctx.client.id, r.asset_id, month, setId, r.tradingview_signal_id ?? null,
        r.proposed_action, finalAction, r.suitability_result, r.score, r.conviction,
        r.signal_conflict ? 1 : 0, r.current_weight, null,
        JSON.stringify(r.factors), JSON.stringify(r.flags), JSON.stringify(r.statement),
        advisorStatus, advisorNote, prev?.decided_at ?? null);
    }

    // An asset that left the book no longer needs a decision.
    const currentAssets = new Set(built.recommendations.map((r) => r.asset_id));
    for (const prev of existingRows) {
      if (!currentAssets.has(prev.asset_id)) await run(db, 'DELETE FROM recommendations WHERE id = ?', prev.id);
    }
    state.recommendations = built.recommendations;
    state.portfolio_flags = built.portfolio_flags;
    state.recommendation_set_id = setId;
    state.world_view = worldView;
    state.exposures = built.exposures;
    await saveRun(env, body.run_id, state);

    return ok({
      run_id: body.run_id,
      recommendation_set_id: setId,
      count: built.recommendations.length,
      conflicts: built.recommendations.filter((r) => r.signal_conflict).length,
      guardrail_downgrades: built.recommendations.filter((r) => r.downgraded).length,
      advisor_decisions_carried_forward: carried,
      advisor_decisions_reopened: reopened,
      unhedged_fx_weight: built.unhedged_fx_weight,
      max_class_drift: built.max_class_drift,
      portfolio_flags: built.portfolio_flags,
      rows: built.recommendations.map((r) => ({
        asset_id: r.asset_id, ticker: r.ticker, name: r.name, asset_class: r.asset_class,
        weight: r.current_weight, proposed: r.proposed_action, final: r.final_action,
        suitability: r.suitability_result, conflict: r.signal_conflict,
        technical: r.technical_signal, analyst: r.analyst_signal, analyst_count: r.analyst_count,
        target_price: r.target_price, implied_upside: r.implied_upside,
        market_signal: r.statement?.market_signal, client_suitability: r.statement?.client_suitability,
        factors: r.factors.filter((f) => f.direction !== 0).map((f) => ({ family: f.family, label: f.label, direction: f.direction, weight: f.weight })),
        flags: r.flags,
      })),
    });
  }

  /**
   * The FACTS object, on its own.
   *
   * The Rivet graph fetches this, interpolates it into the Prompt nodes that
   * hold the English prompt text, calls the model itself, and posts the result
   * back to /narrative. That keeps the prompts visible and editable inside the
   * graph, which is where a reviewer expects to find them, while the numbers
   * stay computed in code.
   */
  if (step === 'narrative-facts') {
    const { state } = await loadRun(env, body.run_id);
    const refreshed = { ...state, recommendations: await refreshRecommendationStatus(env, state) };
    const facts = narrativeFacts(refreshed);
    const { renderPrompt } = await import('../../src/llm/prompts.js');
    const p = renderPrompt(body.prompt || 'client_letter', facts);
    return ok({
      run_id: body.run_id,
      facts,
      facts_json: JSON.stringify(facts, null, 2),
      system: p.system,
      user: p.user,
      prompt_version: p.prompt_version,
      prompt_id: p.prompt_id,
      llm_configured: LLM.llmAvailable(env),
    });
  }

  if (step === 'narrative') {
    const { state } = await loadRun(env, body.run_id);

    // A letter supplied by the graph's own model node is accepted here; the
    // Worker only fills in when the graph did not produce one.
    let narrative;
    if (body.letter && typeof body.letter === 'object' && body.letter.greeting) {
      const facts = narrativeFacts({ ...state, recommendations: await refreshRecommendationStatus(env, state) });
      narrative = {
        letter: { ...body.letter, language: 'pt-BR' },
        rationales: body.rationales && Object.keys(body.rationales).length ? body.rationales : LLM.deterministicRationales(facts),
        mode: body.mode || 'model_via_rivet',
        model: body.model || null,
        prompt_version: body.prompt_version || PROMPT_VERSION,
      };
    } else {
      narrative = await buildNarrative(env, state, body);
    }
    state.narrative = narrative;
    await saveRun(env, body.run_id, state);
    return ok({ run_id: body.run_id, mode: narrative.mode, model: narrative.model, letter: narrative.letter, rationales: Object.keys(narrative.rationales || {}).length });
  }

  if (step === 'assemble') {
    const { state, row } = await loadRun(env, body.run_id);
    const decided = await refreshRecommendationStatus(env, state);
    const recs = decided.map((r) => ({ ...r, rationale_pt: state.narrative?.rationales?.[r.asset_id] ?? null }));

    // One report per client per month. Regenerating reuses the existing id so
    // the link an advisor already has keeps working and the stored source
    // records stay attached to it.
    const existing = await first(db, 'SELECT id, status FROM reports WHERE client_id = ? AND reporting_month = ?',
      state.ctx.client.id, state.ctx.reporting_period.month);
    if (existing?.status === 'published' && !body.force) {
      return bad(409, 'a published client letter is immutable; reissue it deliberately if the advisor has decided to', {
        report_id: existing.id,
        published_at: existing.published_at,
        how_to_reissue: 'set the reissue graph input to true, or POST assemble with { "force": true }',
      });
    }
    const reportId = body.report_id || existing?.id || id('rep');
    const report = P.assembleCanonicalReport({
      ctx: state.ctx, market: state.market, perf: state.perf, benchmark: state.benchmark,
      metrics: state.metrics, signals: state.signals, recommendations: recs,
      worldView: state.world_view,
      eventsForClient: state.impact.map((i) => {
        const src = state.events.find((e) => e.id === i.event_id) || {};
        return { ...i, summary: src.summary, summary_pt: src.summary_pt ?? null, category: src.category, importance: src.importance, direction: src.direction, date: i.date ?? src.date };
      }),
      narrative: state.narrative, exposures: state.exposures,
      locale: env.REPORT_LOCALE || 'pt-BR', reportId, graphRunId: body.run_id,
      promptVersion: row.prompt_version,
    });
    state.report = report;
    state.report_id = reportId;
    await saveRun(env, body.run_id, state);

    // Validation before the advisor gate. Recommendations are still "proposed"
    // at this point, so the approval error is expected and reported as pending.
    const check = validateReport(report);
    const pendingApproval = check.errors.filter((e) => e.includes('only advisor-approved'));
    return ok({
      run_id: body.run_id, report_id: reportId,
      valid: check.ok,
      blocking_errors: check.errors.filter((e) => !e.includes('only advisor-approved')),
      pending_advisor_approval: pendingApproval.length,
      warnings: check.warnings,
      sections: Object.keys(report).length,
      sources: report.sources.length,
      unavailable: report.data_quality.unavailable,
    });
  }

  if (step === 'render') {
    const { state } = await loadRun(env, body.run_id);
    if (!state.report) {
      return bad(409, 'nothing to render: the assemble stage did not produce a report for this run', { run_id: body.run_id, stages_completed: Object.keys(state) });
    }
    const approvedOnly = body.approved_only !== false;
    let report = state.report;

    if (approvedOnly) {
      const decided = await refreshRecommendationStatus(env, state);
      const byAsset = new Map(decided.map((d) => [d.asset_id, d]));
      report = {
        ...report,
        recommendations: report.recommendations
          .map((r) => {
            const d = byAsset.get(r.asset_id);
            return d ? { ...r, advisor_status: d.advisor_status, advisor_note: d.advisor_note, final_action: d.final_action ?? r.final_action } : r;
          })
          .filter((r) => r.advisor_status === 'approved'),
      };
      const check = validateReport(report);
      if (!check.ok) return bad(422, 'the report does not pass validation and will not be rendered', { errors: check.errors, warnings: check.warnings });
    }

    const model = buildLetterModel(report, { locale: report.locale });
    const html = renderLetterHtml(model, { variant: 'email', pdfUrl: `/api/reports/${state.report_id}/pdf`, portalUrl: `/client/#/report/${state.report_id}` });
    const portalHtml = renderPortalLetter(model);
    const pdfDoc = await renderLetterPdf(model, { fonts: brandFonts() });
    const pdf = pdfDoc.build();

    const keys = {
      html: `reports/${state.ctx.client.id}/${state.ctx.reporting_period.month}/${state.report_id}.email.html`,
      portal: `reports/${state.ctx.client.id}/${state.ctx.reporting_period.month}/${state.report_id}.portal.html`,
      pdf: `reports/${state.ctx.client.id}/${state.ctx.reporting_period.month}/${state.report_id}.pdf`,
    };
    if (env.REPORTS) {
      await env.REPORTS.put(keys.html, html, { httpMetadata: { contentType: 'text/html; charset=utf-8' } });
      await env.REPORTS.put(keys.portal, portalHtml, { httpMetadata: { contentType: 'text/html; charset=utf-8' } });
      await env.REPORTS.put(keys.pdf, pdf, { httpMetadata: { contentType: 'application/pdf' } });
    }
    state.report = report;
    state.render = { keys, page_count: pdfDoc.pageCount, pdf_bytes: pdf.length, html_bytes: html.length, layout_reduction_level: pdfDoc.reductionLevel ?? 0 };
    await saveRun(env, body.run_id, state);

    return ok({ run_id: body.run_id, report_id: state.report_id, page_count: pdfDoc.pageCount, pdf_bytes: pdf.length, html_bytes: html.length, keys, within_two_pages: pdfDoc.pageCount <= 2, layout_reduction_level: pdfDoc.reductionLevel ?? 0, approved_recommendations: report.recommendations.length, letter_rows: model.recommendations.length, letter_rows_omitted: model.recommendations_omitted });
  }

  if (step === 'persist') {
    const { state } = await loadRun(env, body.run_id);
    if (!state.report || !state.report_id) {
      await saveRun(env, body.run_id, state, { status: 'failed', finished_at: nowIso(), error: 'no report to persist' });
      return bad(409, 'nothing to persist: this run has no assembled report', { run_id: body.run_id, stages_completed: Object.keys(state) });
    }
    const r = state.report;
    const status = body.status || 'pending_approval';
    await run(db, `INSERT INTO reports (id, client_id, advisor_id, portfolio_snapshot_id, reporting_month, canonical_report_json, html_r2_key, pdf_r2_key, portal_r2_key, status, page_count, graph_run_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(client_id, reporting_month) DO UPDATE SET canonical_report_json=excluded.canonical_report_json,
        html_r2_key=excluded.html_r2_key, pdf_r2_key=excluded.pdf_r2_key, portal_r2_key=excluded.portal_r2_key,
        status=excluded.status, page_count=excluded.page_count, graph_run_id=excluded.graph_run_id`,
      state.report_id, state.ctx.client.id, state.ctx.advisor.id, state.ctx.snapshot.id,
      state.ctx.reporting_period.month, JSON.stringify(r),
      state.render?.keys?.html ?? null, state.render?.keys?.pdf ?? null, state.render?.keys?.portal ?? null,
      status, state.render?.page_count ?? null, body.run_id);

    await run(db, 'DELETE FROM data_sources WHERE report_id = ?', state.report_id);
    for (const s of r.sources || []) {
      await run(db, `INSERT INTO data_sources (id, report_id, provider, kind, instrument, identifier, requested_range, retrieval_timestamp, last_observation, source_reference, fallback_for, mocked, metadata_json)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        id('ds'), state.report_id, s.provider, s.kind, s.instrument, s.identifier, s.requested_range,
        s.retrieval_timestamp, s.last_observation, s.reference, s.fallback_for, s.mocked ? 1 : 0, JSON.stringify(s));
    }
    await audit(db, { entity: 'report', entity_id: state.report_id, action: 'generated', actor_id: session.user_id, detail: { month: state.ctx.reporting_period.month, run_id: body.run_id, page_count: state.render?.page_count, narrative_mode: state.narrative?.mode } });
    await saveRun(env, body.run_id, state, { status: 'completed', finished_at: nowIso() });
    return ok({ run_id: body.run_id, report_id: state.report_id, status, stored: true, sources_persisted: (r.sources || []).length });
  }

  if (step === 'publish') {
    const report = await first(db, 'SELECT * FROM reports WHERE id = ?', body.report_id);
    if (!report) return bad(404, 'report not found');
    if (report.status !== 'approved') return bad(409, 'the advisor must approve the report before it is published');
    await run(db, "UPDATE reports SET status = 'published', published_at = ? WHERE id = ?", nowIso(), body.report_id);
    await audit(db, { entity: 'report', entity_id: body.report_id, action: 'published', actor_id: session.user_id });
    return ok({ ok: true, report_id: body.report_id, status: 'published' });
  }

  if (step === 'state') {
    const { state, row } = await loadRun(env, body.run_id);
    return ok({ run: { id: row.id, status: row.status, started_at: row.started_at, finished_at: row.finished_at }, keys: Object.keys(state) });
  }

  return bad(404, `unknown pipeline step ${step}`);
}

async function defaultCandidates(env, state) {
  // A candidate is an instrument that would move an under-allocated class back
  // toward its policy target. Nothing is proposed for a class already in range.
  const db = env.DB;
  const policy = state.ctx.policy;
  const total = state.perf?.ending_market_value || 1;
  const exposures = {};
  for (const p of state.market.priced) exposures[p.asset.asset_class] = (exposures[p.asset.asset_class] ?? 0) + (p.market_value ?? 0) / total;
  const held = new Set(state.market.priced.map((p) => p.asset.id));

  const under = Object.entries(policy?.permitted_ranges || {})
    .filter(([k, band]) => band.min != null && (exposures[k] ?? 0) < band.min)
    .map(([k]) => k);
  if (!under.length) return [];

  const rows = await all(db, `SELECT id FROM assets WHERE asset_class IN (${under.map(() => '?').join(',')}) AND tv_symbol IS NOT NULL AND pricing_mode = 'market'`, ...under);
  return rows.map((r) => r.id).filter((x) => !held.has(x)).slice(0, 3);
}

/**
 * The run state holds the recommendations as the engine proposed them. The
 * advisor's decisions live in D1. Every step that speaks for the client — the
 * narrative, the validation and the render — reads the decisions back first, so
 * an approval made in the portal is reflected without re-running the pipeline.
 */
async function refreshRecommendationStatus(env, state) {
  if (!state.recommendation_set_id) return state.recommendations || [];
  const decided = await all(env.DB, 'SELECT * FROM recommendations WHERE client_id = ? AND reporting_month = ?',
    state.ctx.client.id, state.ctx.reporting_period.month);
  const byAsset = new Map(decided.map((d) => [d.asset_id, d]));
  return (state.recommendations || []).map((r) => {
    const d = byAsset.get(r.asset_id);
    return d ? { ...r, advisor_status: d.advisor_status, advisor_note: d.advisor_note, final_action: d.final_action ?? r.final_action } : r;
  });
}

async function buildNarrative(env, state, body) {
  state = { ...state, recommendations: await refreshRecommendationStatus(env, state) };
  const facts = narrativeFacts(state);
  let letter = null; let rationales = null; let mode = 'deterministic_template'; let model = null; let fallbackReason = null;

  if (body.mode !== 'deterministic' && LLM.llmAvailable(env)) {
    try {
      const r = await LLM.runPrompt(env, 'client_letter', facts, { maxTokens: 2600 });
      letter = { ...r.data, language: 'pt-BR' };
      model = r.model; mode = 'model';
      try {
        const rr = await LLM.runPrompt(env, 'recommendation_rationale', { recommendations: facts.recommendations }, { maxTokens: 1600 });
        rationales = rr.data;
      } catch { rationales = LLM.deterministicRationales(facts); }
    } catch (err) {
      fallbackReason = err.message;
    }
  }

  if (!letter) {
    letter = LLM.deterministicLetter(facts);
    rationales = LLM.deterministicRationales(facts);
    mode = LLM.llmAvailable(env) ? 'deterministic_fallback_after_error' : 'deterministic_template';
  }
  return { letter, rationales: rationales || {}, mode, model, prompt_version: PROMPT_VERSION, fallback_reason: fallbackReason, facts_digest: Object.keys(facts) };
}

/** The FACTS object. Nothing outside it may appear in the letter. */
function narrativeFacts(state) {
  const perf = state.perf;
  const bench = state.benchmark;
  return {
    client: { name: state.ctx.client.full_name, risk_profile: state.ctx.client.risk_profile, base_currency: state.ctx.client.base_currency },
    advisor: { name: state.ctx.advisor?.name },
    reporting_period: state.ctx.reporting_period,
    performance: {
      monthly_return: perf.monthly_return,
      absolute_pnl: perf.absolute_pnl,
      beginning_market_value: perf.beginning_market_value,
      ending_market_value: perf.ending_market_value,
      contributions: perf.contributions,
      withdrawals: perf.withdrawals,
      income: perf.income,
      method: perf.method,
      method_note: perf.method_note,
      unavailable_reason: perf.monthly_return == null ? 'não foi possível apurar o retorno com os dados disponíveis' : null,
      excluded_positions: perf.coverage.excluded.map((e) => ({ name: e.name, reason: e.reason })),
    },
    benchmark: bench.available
      ? { name: bench.name, value: bench.value, excess_return: perf.monthly_return - bench.value, composition: bench.composition }
      : { unavailable: true, reason: bench.reason },
    attribution: {
      best_contributor: perf.attribution.best_contributor ? { name: perf.attribution.best_contributor.name, ticker: perf.attribution.best_contributor.ticker, contribution: perf.attribution.best_contributor.contribution, total_return: perf.attribution.best_contributor.total_return } : null,
      worst_contributor: perf.attribution.worst_contributor ? { name: perf.attribution.worst_contributor.name, ticker: perf.attribution.worst_contributor.ticker, contribution: perf.attribution.worst_contributor.contribution, total_return: perf.attribution.worst_contributor.total_return } : null,
      by_asset_class: perf.attribution.by_asset_class.map((c) => ({ asset_class: c.asset_class, contribution: c.contribution, return: c.return })),
      fx_contribution: perf.attribution.fx_contribution,
    },
    events: (state.events || []).slice(0, 6).map((e) => ({
      id: e.id, title: e.title, title_pt: e.title_pt ?? null,
      why_it_matters: e.summary, why_it_matters_pt: e.summary_pt ?? null,
      category: e.category, importance: e.importance,
    })),
    impact: (state.impact || []).map((i) => ({
      event_id: i.event_id, title: i.title, title_pt: i.title_pt ?? null,
      exposure: i.portfolio_exposure.total_exposure,
      potential_impact: i.potential_impact, potential_impact_pt: i.potential_impact_pt ?? null,
      discussion_prompt_pt: i.discussion_prompt_pt ?? null,
      relevance: i.relevance,
    })),
    recommendations: (state.recommendations || []).map((r) => ({
      asset_id: r.asset_id, ticker: r.ticker, name: r.name, asset_class: r.asset_class,
      final_action: r.final_action, suitability_result: r.suitability_result, signal_conflict: r.signal_conflict,
      technical_signal: r.technical_signal, analyst_signal: r.analyst_signal, analyst_count: r.analyst_count,
      target_price: r.target_price, implied_upside: r.implied_upside, current_weight: r.current_weight,
      factors: r.factors, flags: r.flags, advisor_status: r.advisor_status,
    })),
    allocation: Object.entries(state.exposures || {}).map(([k, v]) => ({ asset_class: k, weight: v, target: state.ctx.policy?.target_allocation?.[k] ?? null, range: state.ctx.policy?.permitted_ranges?.[k] ?? null })),
    advisor_view: state.world_view ? { headline: state.world_view.headline, stance_by_asset_class: state.world_view.stance_by_asset_class } : null,
    /** Exactly the items the letter will print, so the copy and the table agree. */
    letter_recommendations: prioritiseForLetter(state.recommendations || []).selected.map((r) => ({
      asset_id: r.asset_id, ticker: r.ticker, name: r.name,
      final_action: r.final_action, suitability_result: r.suitability_result, signal_conflict: r.signal_conflict,
    })),
    next_meeting: state.next_meeting ?? null,
  };
}

// ═══════════════════════════════════════════════════════════════════════════

async function serveArtefact(env, report, kind) {
  if (kind === 'json') {
    return ok({ report: json(report.canonical_report_json, {}) });
  }
  const key = kind === 'pdf' ? report.pdf_r2_key : kind === 'portal' ? report.portal_r2_key : report.html_r2_key;
  if (env.REPORTS && key) {
    const obj = await env.REPORTS.get(key);
    if (obj) {
      return new Response(obj.body, {
        headers: {
          'content-type': kind === 'pdf' ? 'application/pdf' : 'text/html; charset=utf-8',
          'content-disposition': kind === 'pdf' ? `inline; filename="carta-${report.reporting_month}.pdf"` : 'inline',
          'cache-control': 'private, max-age=300',
        },
      });
    }
  }
  // R2 miss: re-render from the canonical object, which is the point of storing it.
  const canonical = json(report.canonical_report_json, {});
  const model = buildLetterModel(canonical, { locale: canonical.locale || 'pt-BR' });
  if (kind === 'pdf') {
    const doc = await renderLetterPdf(model, { fonts: brandFonts() });
    return new Response(doc.build(), { headers: { 'content-type': 'application/pdf' } });
  }
  const html = kind === 'portal' ? renderPortalLetter(model) : renderLetterHtml(model, { variant: 'email' });
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
}

function addDays(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
