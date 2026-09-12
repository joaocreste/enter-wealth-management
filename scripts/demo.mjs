/**
 * Drives the end-to-end journey from §37 against a running API.
 *
 *   npm run demo                       the full path for the main demo client
 *   npm run demo -- --client cli_beatriz
 *
 * It exists so the journey can be replayed in one command before a
 * presentation, and so the README's claims are testable rather than asserted.
 */
const BASE = process.env.API_BASE || 'http://127.0.0.1:8788';
const args = Object.fromEntries(process.argv.slice(2).flatMap((a, i, all) => (a.startsWith('--') ? [[a.slice(2), all[i + 1] ?? true]] : [])));
const CLIENT = args.client || 'cli_albert';

let token = null;
async function api(path, body, method) {
  const res = await fetch(BASE + path, {
    method: method || (body ? 'POST' : 'GET'),
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} → ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

const step = (n, s) => console.log(`\n  ${String(n).padStart(2, '0')}  ${s}`);
const line = (k, v) => console.log(`      ${String(k).padEnd(34)} ${v}`);

console.log('\n  XP Asset Management — end-to-end journey');
console.log(`  ${'─'.repeat(70)}`);

step(1, 'Advisor signs in');
const login = await api('/api/auth/login', { email: 'antonio.bicudo@xpi.com.br', password: 'xp2026' });
token = login.token;
line('advisor', `${login.user.name} <${login.user.email}>`);

step(2, 'World Overview: what matters today');
const overview = await api('/api/advisor/overview');
line('indicators retrieved', `${overview.indicators.filter((i) => !i.unavailable).length} of ${overview.indicators.length}`);
line('thresholds breached', overview.triggers.filter((t) => t.status === 'BREACHED').map((t) => t.label).join('; ') || 'none');
line('events mapped to the book', overview.what_matters.length);
for (const r of overview.what_matters.slice(0, 3)) {
  line(`  · ${(r.event_pt || r.event).slice(0, 44)}`, `${r.per_client.length} client(s), max exposure ${(r.exposure_summary.max_exposure * 100).toFixed(1)}%`);
}

step(3, 'Run the Rivet workflow for the client');
const start = await api('/api/pipeline/start', { client_id: CLIENT });
const runId = start.run_id;
line('run', runId);
line('reporting month', start.month);
for (const s of ['context', 'market-data', 'profitability', 'market-intel', 'signals', 'recommendations', 'narrative']) {
  const t0 = Date.now();
  const r = await api(`/api/pipeline/${s}`, { run_id: runId, client_id: CLIENT, month: start.month });
  line(`  ${s}`, `${String(Date.now() - t0).padStart(5)} ms${s === 'profitability' ? `  · return ${(r.monthly_return * 100).toFixed(2)}% by ${r.method}` : ''}${s === 'recommendations' ? `  · ${r.count} proposals, ${r.conflicts} signal conflicts` : ''}${s === 'narrative' ? `  · ${r.mode}` : ''}`);
}

step(4, 'Suitability: where the market view and the client policy disagree');
const recs = await api(`/api/clients/${CLIENT}/recommendations`);
for (const r of recs.recommendations.filter((x) => x.signal_conflict || x.suitability_result !== 'PASS')) {
  line(r.ticker || r.name, `${r.statement?.market_signal}  →  ${r.statement?.client_suitability}`);
}

step(5, 'Advisor approves every proposal');
for (const r of recs.recommendations) {
  await api(`/api/clients/${CLIENT}/recommendations/${r.id}/decision`, { status: 'approved', note: 'Levar para a próxima reunião.' });
}
line('approved', recs.recommendations.length);

step(6, 'Re-run: the workflow refreshes the analysis and keeps the decisions');
const rerun = await api('/api/pipeline/recommendations', { run_id: runId });
line('decisions carried forward', rerun.advisor_decisions_carried_forward);
line('decisions reopened by a change', rerun.advisor_decisions_reopened);

step(7, 'Assemble, render and persist');
await api('/api/pipeline/narrative', { run_id: runId });
// A published letter is immutable, so a replayable demo reissues on purpose.
// In production this flag is the advisor's explicit decision, surfaced as the
// `reissue` input on the Rivet canvas.
const assembled = await api('/api/pipeline/assemble', { run_id: runId, force: true });
line('canonical report valid', assembled.valid ? 'yes' : `no — ${assembled.blocking_errors.join('; ')}`);
line('sources attached', assembled.sources);
const rendered = await api('/api/pipeline/render', { run_id: runId, approved_only: true });
line('pdf pages', `${rendered.page_count} (limit 2)${rendered.layout_reduction_level ? ` · layout reduction level ${rendered.layout_reduction_level}` : ''}`);
line('recommendations in the letter', `${rendered.letter_rows} printed of ${rendered.approved_recommendations} approved (${rendered.letter_rows_omitted} summarised)`);
const persisted = await api('/api/pipeline/persist', { run_id: runId, status: 'pending_approval' });
line('report', persisted.report_id);

step(8, 'Advisor approves and publishes the letter');
line('note', 'a reissued letter drops back to pending_approval and must be re-approved');
await api(`/api/clients/${CLIENT}/reports/${persisted.report_id}/approve`, {});
await api(`/api/clients/${CLIENT}/reports/${persisted.report_id}/publish`, {});
const full = await api(`/api/clients/${CLIENT}/reports/${persisted.report_id}`);
const c = full.report.canonical;
line('status', full.report.status);
line('monthly return', `${(c.portfolio_performance.monthly_return * 100).toFixed(2)}%  vs benchmark ${(c.benchmark.value * 100).toFixed(2)}%`);
line('worst contributor', `${c.performance_attribution.worst_contributor?.name} ${(c.performance_attribution.worst_contributor?.contribution * 100).toFixed(2)} p.p.`);
line('recommendations in letter', c.recommendations.length);
line('letter language', c.letter?.language);

step(9, 'The client signs in and sees the same content');
const clientLogin = await api('/api/auth/login', { email: 'albert.dasilva@exemplo.com.br', password: 'albert2026' });
token = clientLogin.token;
const mine = await api('/api/auth/me');
const clientReports = await api(`/api/clients/${mine.client_id}/reports`);
line('client', clientLogin.user.name);
line('published letters visible', clientReports.reports.length);
const clientCopy = await api(`/api/clients/${mine.client_id}/reports/${persisted.report_id}`);
const same = clientCopy.report.canonical.portfolio_performance.monthly_return === c.portfolio_performance.monthly_return
  && clientCopy.report.canonical.recommendations.length === c.recommendations.length;
line('same numbers as the advisor view', same ? 'yes' : 'NO — the outputs disagree');

step(10, 'Authorization boundary');
try {
  await api('/api/clients/cli_beatriz');
  line('client reading another client', 'FAILED — access was allowed');
} catch (e) {
  line('client reading another client', `refused (${String(e.message).split('→')[1]?.trim().slice(0, 24) || 'blocked'})`);
}
try {
  await api(`/api/clients/${mine.client_id}/snapshots`, { positions: [] });
  line('client editing the portfolio', 'FAILED — write was allowed');
} catch (e) {
  line('client editing the portfolio', `refused (${String(e.message).split('→')[1]?.trim().slice(0, 24) || 'blocked'})`);
}

console.log(`\n  ${'─'.repeat(70)}`);
console.log(`  Advisor portal   ${BASE}/advisor/   antonio.bicudo@xpi.com.br / xp2026`);
console.log(`  Client portal    ${BASE}/client/    albert.dasilva@exemplo.com.br / albert2026`);
console.log(`  PDF              ${BASE}/api/reports/${persisted.report_id}/pdf\n`);
