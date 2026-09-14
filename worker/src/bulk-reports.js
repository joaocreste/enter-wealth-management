/**
 * Bulk letters: the whole book, in one go.
 *
 * "Criar Cartas" on the day's panorama runs the monthly letter agent once per
 * client under the advisor, then puts the finished letters into one zip.
 * Nothing new is written here about a portfolio: each client still gets an
 * ordinary letter_runs run, with its own four steps, its own log, its own audit
 * line and its own row in `reports`, so a letter produced in bulk is
 * indistinguishable from one the advisor asked for from the client page — and
 * is reopened, approved and published there afterwards.
 *
 * The clients are written one at a time rather than in parallel. Each letter
 * calls the model and reads market data, and a Worker has a budget for both; a
 * book of five fanned out at once would spend it on the first two and fail the
 * rest. A slow sweep that finishes beats a fast one that does not.
 *
 * A client whose letter fails does not stop the sweep. The run carries the
 * roster with a per-client outcome, so the zip can be handed over with four of
 * five letters in it and the portal can say which one is missing and why.
 *
 * Like the other long jobs here this runs as a Cloudflare Workflow, one durable
 * step per client plus one for the archive: a sweep that takes several minutes
 * outlives both the request that started it and the tab that was watching.
 */
import { WorkflowEntrypoint } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { all, first, run, id, json, nowIso, audit } from './db.js';
import * as L from './letter-agent.js';
import { signArtefact } from './links.js';
import { buildZip, zipSafeName } from '../../src/render/zip.js';
import { previousMonth } from '../../src/core/format.js';

export const ARTEFACT_KIND = 'bulk-zip';
const STALE_MS = 30 * 60 * 1000;
const today = () => new Date().toISOString().slice(0, 10);
const isStale = (row) => row.status === 'running' && Date.now() - Date.parse(row.started_at) > STALE_MS;
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * The steps the progress card draws: one per client, by name, then the archive.
 * The advisor watching should see whose letter is being written, not a counter.
 */
export function bulkAgents(clients) {
  const steps = clients.map((c, i) => ({
    step: i + 1, key: c.client_id, title: c.name,
    what: 'carteira e política, a rentabilidade do mês, a carta e a diagramação em duas páginas',
  }));
  steps.push({
    step: clients.length + 1, key: 'zip', title: 'Arquivo zip',
    what: clients.length === 1 ? 'a carta, pronta para baixar' : `as ${clients.length} cartas em um único arquivo`,
  });
  return steps;
}

/** What the portal sees of a run: progress, the roster, and the signed link once the zip exists. */
export async function runView(env, row) {
  if (!row) return null;
  const stale = isStale(row);
  const clients = json(row.clients_json, []);
  const token = row.status === 'completed' ? await signArtefact(env, row.id, ARTEFACT_KIND) : null;
  return {
    id: row.id, advisor_id: row.advisor_id,
    status: stale ? 'failed' : row.status,
    step: row.step, progress: row.progress, message: row.message,
    error: stale ? 'sem progresso há mais de trinta minutos' : row.error,
    started_at: row.started_at, finished_at: row.finished_at,
    reporting_month: row.reporting_month,
    total: row.total, written: row.written, failed: row.failed,
    clients,
    zip_name: row.zip_name,
    zip_bytes: row.zip_bytes,
    log: json(row.log_json, []).slice(-12),
    agents: bulkAgents(clients),
    links: row.status === 'completed' ? { zip: `/api/bulk-reports/${row.id}/zip${token ? `?t=${encodeURIComponent(token)}` : ''}` } : null,
  };
}

export async function latestBulkRun(db, advisorId, { status = null } = {}) {
  return status
    ? first(db, 'SELECT * FROM bulk_reports WHERE advisor_id = ? AND status = ? ORDER BY started_at DESC LIMIT 1', advisorId, status)
    : first(db, 'SELECT * FROM bulk_reports WHERE advisor_id = ? ORDER BY started_at DESC LIMIT 1', advisorId);
}

export async function listBulkRuns(env, advisorId) {
  const rows = await all(env.DB, 'SELECT * FROM bulk_reports WHERE advisor_id = ? ORDER BY started_at DESC LIMIT 10', advisorId);
  const out = [];
  for (const row of rows) out.push(await runView(env, row));
  return out;
}

/**
 * Start a sweep and return it at once; the tab polls it. A sweep already
 * running is handed back rather than started twice — one advisor pressing the
 * button again should join the run in progress, not double the model calls.
 */
export async function startBulkRun(env, ctx, { advisor, actorId = null }) {
  const db = env.DB;
  const active = await latestBulkRun(db, advisor.id, { status: 'running' });
  if (active && !isStale(active)) return { run: await runView(env, active) };
  if (active) await run(db, 'UPDATE bulk_reports SET status = ?, error = ?, finished_at = ? WHERE id = ?', 'failed', 'abandonada: sem progresso há mais de trinta minutos', nowIso(), active.id);

  const rows = await all(db, 'SELECT id, full_name FROM clients WHERE advisor_id = ? ORDER BY full_name', advisor.id);
  if (!rows.length) return { error: 'nenhum cliente sob sua responsabilidade' };
  const clients = rows.map((c) => ({ client_id: c.id, name: c.full_name, run_id: null, status: 'pending', error: null, page_count: null }));

  const runId = id('bulk');
  await run(db,
    `INSERT INTO bulk_reports (id, advisor_id, status, step, progress, message, clients_json, total, reporting_month, zip_name, actor_id, started_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    runId, advisor.id, 'running', 0, 0, 'Na fila', JSON.stringify(clients), clients.length,
    previousMonth(today()), zipName(advisor), actorId, nowIso());

  if (env.BULK_REPORTS) {
    await env.BULK_REPORTS.create({ id: runId, params: { runId } });
  } else {
    const job = runBulkPipeline(env, runId).catch((err) => console.error('bulk run failed', err?.stack || err));
    if (ctx?.waitUntil) ctx.waitUntil(job); else await job;
  }
  return { run: await runView(env, await first(db, 'SELECT * FROM bulk_reports WHERE id = ?', runId)) };
}

const zipName = (advisor) => `cartas-${zipSafeName(advisor.advisor_code || advisor.name, 'assessor')}-${today()}.zip`;

/**
 * The Workflow: one durable step per client, then the archive. The roster is
 * read from the row rather than carried in the payload, so a step names the
 * client it is about even after a restart.
 */
export class BulkReports extends WorkflowEntrypoint {
  async run(event, step) {
    const { runId } = event.payload;
    const row = await first(this.env.DB, 'SELECT * FROM bulk_reports WHERE id = ?', runId);
    if (!row) return;
    const clients = json(row.clients_json, []);
    const guard = (fn) => async () => {
      try { return await fn(); } catch (err) { throw new NonRetryableError(String(err?.message || err)); }
    };
    const opts = { timeout: '15 minutes', retries: { limit: 0, delay: '1 second' } };
    for (let i = 0; i < clients.length; i += 1) {
      await step.do(`carta-${clients[i].client_id}`, opts, guard(() => writeOneLetter(this.env, runId, i)));
    }
    await step.do('zip', opts, guard(() => archive(this.env, runId)));
  }
}

/** The same sweep, in-process, for a runtime without the Workflow binding. */
export async function runBulkPipeline(env, runId) {
  const row = await first(env.DB, 'SELECT * FROM bulk_reports WHERE id = ?', runId);
  if (!row) return;
  const clients = json(row.clients_json, []);
  for (let i = 0; i < clients.length; i += 1) await writeOneLetter(env, runId, i);
  await archive(env, runId);
}

// ── the run's bookkeeping ─────────────────────────────────────────────────────
async function loadRun(db, runId) {
  const row = await first(db, 'SELECT * FROM bulk_reports WHERE id = ?', runId);
  if (!row) throw new Error(`bulk run ${runId} not found`);
  const advisor = await first(db, 'SELECT a.*, u.name, u.email FROM advisors a JOIN users u ON u.id = a.user_id WHERE a.id = ?', row.advisor_id);
  const clients = json(row.clients_json, []);
  const log = json(row.log_json, []);

  // The archive is the last step, so a run of N clients has N+1 things to do.
  // `completed` is how many of them are behind us, which is what the ring shows.
  const report = async (step, message, { completed = step - 1, quiet = false } = {}) => {
    if (!quiet) log.push({ at: nowIso(), step, message });
    const progress = Math.min(99, Math.round((100 * completed) / (clients.length + 1)));
    await run(db, 'UPDATE bulk_reports SET step = ?, progress = ?, message = ?, log_json = ? WHERE id = ?',
      step, progress, message, JSON.stringify(log.slice(-60)), runId);
  };
  const saveRoster = async () => {
    const written = clients.filter((c) => c.status === 'completed').length;
    const failed = clients.filter((c) => c.status === 'failed').length;
    await run(db, 'UPDATE bulk_reports SET clients_json = ?, written = ?, failed = ? WHERE id = ?',
      JSON.stringify(clients), written, failed, runId);
  };
  const fail = async (err) => {
    console.error('bulk reports', err?.stack || err);
    await run(db, 'UPDATE bulk_reports SET status = ?, error = ?, finished_at = ?, log_json = ? WHERE id = ?',
      'failed', String(err?.message || err), nowIso(), JSON.stringify(log.slice(-60)), runId);
  };
  return { row, advisor, clients, log, report, saveRoster, fail };
}

/**
 * One client's letter: an ordinary report run, driven here instead of dispatched.
 *
 * While the four steps run, the sub-run's own progress line is mirrored onto the
 * bulk row every couple of seconds. Without it the card would sit on one client's
 * name for a minute with nothing moving, which reads as a hang rather than as a
 * model writing a letter.
 */
async function writeOneLetter(env, runId, index) {
  const db = env.DB;
  const { clients, report, saveRoster } = await loadRun(db, runId);
  const entry = clients[index];
  if (!entry) return null;
  const position = `${index + 1} de ${clients.length}`;
  try {
    await report(index + 1, `Carta ${position} — ${entry.name}: na fila`);
    const row = await first(db, 'SELECT * FROM bulk_reports WHERE id = ?', runId);
    const subId = await L.createLetterRun(env, { clientId: entry.client_id, advisorId: row.advisor_id, actorId: row.actor_id, month: row.reporting_month });
    entry.run_id = subId;
    entry.status = 'running';
    await saveRoster();

    let done = false;
    const job = L.runLetterPipeline(env, subId).finally(() => { done = true; });
    const mirror = (async () => {
      while (!done) {
        await sleep(2500);
        if (done) break;
        const sub = await first(db, 'SELECT message FROM letter_runs WHERE id = ?', subId);
        if (sub?.message) await report(index + 1, `Carta ${position} — ${entry.name}: ${String(sub.message).replace(/^Carta · /, '').toLowerCase()}`, { quiet: true });
      }
    })();
    try { await job; } finally { done = true; await mirror.catch(() => {}); }

    const sub = await first(db, 'SELECT * FROM letter_runs WHERE id = ?', subId);
    entry.status = sub?.status === 'completed' ? 'completed' : 'failed';
    entry.error = sub?.status === 'completed' ? null : (sub?.error || 'a carta não foi produzida');
    entry.page_count = sub?.page_count ?? null;
    await saveRoster();
    await report(index + 1, entry.status === 'completed'
      ? `Carta ${position} — ${entry.name}: pronta`
      : `Carta ${position} — ${entry.name}: falhou (${entry.error})`, { completed: index + 1 });
    return { ok: entry.status === 'completed' };
  } catch (err) {
    // One client's letter failing is not the sweep failing: record it and go on.
    // A sweep where every letter failed ends as a failure in the archive step,
    // which is the one place that decides how the run finished.
    entry.status = 'failed';
    entry.error = String(err?.message || err);
    try { await saveRoster(); } catch { /* the roster is best effort */ }
    console.error('bulk letter', entry.client_id, err?.stack || err);
    return { ok: false };
  }
}

/** The archive, and the run's own ending. */
async function archive(env, runId) {
  const db = env.DB;
  const { row, clients, log, report, fail } = await loadRun(db, runId);
  try {
    await report(clients.length + 1, 'Arquivo zip — reunindo as cartas', { completed: clients.length });
    const files = await collectLetters(env, clients, row.reporting_month);
    if (!files.length) throw new Error('nenhuma carta foi produzida');

    const zip = buildZip(files);
    const key = `bulk-reports/${row.advisor_id}/${runId}.zip`;
    if (env.REPORTS) await env.REPORTS.put(key, zip, { httpMetadata: { contentType: 'application/zip' } });

    const failed = clients.filter((c) => c.status === 'failed');
    const message = `Concluído — ${files.length} ${files.length === 1 ? 'carta' : 'cartas'} em ${Math.max(1, Math.round(zip.length / 1024))} KB${failed.length ? `; ${failed.length} não ${failed.length === 1 ? 'saiu' : 'saíram'}: ${failed.map((c) => c.name).join(', ')}` : ''}`;
    await run(db,
      `UPDATE bulk_reports SET status = ?, step = ?, progress = 100, message = ?, zip_r2_key = ?, zip_bytes = ?, finished_at = ?, log_json = ? WHERE id = ?`,
      'completed', clients.length + 1, message, env.REPORTS ? key : null, zip.length, nowIso(),
      JSON.stringify([...log, { at: nowIso(), step: clients.length + 1, message }].slice(-60)), runId);
    await audit(db, {
      entity: 'bulk_report', entity_id: runId, action: 'completed', actor_id: row.actor_id,
      detail: { advisor_id: row.advisor_id, written: files.length, failed: failed.map((c) => c.client_id), bytes: zip.length },
    });
    return { ok: true, written: files.length };
  } catch (err) {
    await fail(err);
    return null;
  }
}

/**
 * The letters as zip entries, in the order the roster names them. A run whose
 * R2 object is gone re-renders from the canonical report each letter stored, so
 * an old zip can still be rebuilt from the record.
 */
async function collectLetters(env, clients, month) {
  const files = [];
  const used = new Set();
  for (const entry of clients) {
    if (entry.status !== 'completed' || !entry.run_id) continue;
    const sub = await first(env.DB, 'SELECT report_id, reporting_month FROM letter_runs WHERE id = ?', entry.run_id);
    if (!sub?.report_id) continue;
    const row = await first(env.DB, 'SELECT * FROM reports WHERE id = ?', sub.report_id);
    const bytes = await L.letterBytes(env, row);
    if (!bytes) continue;
    let name = `carta-${zipSafeName(entry.name, entry.client_id)}-${sub.reporting_month || month || 'carteira'}.pdf`;
    // Two clients who share a name would otherwise overwrite each other in the archive.
    if (used.has(name)) name = name.replace(/\.pdf$/, `-${zipSafeName(entry.client_id)}.pdf`);
    used.add(name);
    files.push({ name, data: bytes });
  }
  return files;
}

/** The zip from R2, or rebuilt from the reports the run produced when the object is gone. */
export async function serveBulkZip(env, row) {
  const name = row.zip_name || `cartas-${row.id}.zip`;
  const headers = {
    'content-type': 'application/zip',
    'content-disposition': `attachment; filename="${name}"`,
    'cache-control': 'private, max-age=300',
  };
  if (env.REPORTS && row.zip_r2_key) {
    const obj = await env.REPORTS.get(row.zip_r2_key);
    if (obj) return new Response(obj.body, { headers });
  }
  const files = await collectLetters(env, json(row.clients_json, []), row.reporting_month);
  if (!files.length) return new Response(JSON.stringify({ error: 'no letters in this run' }), { status: 404, headers: { 'content-type': 'application/json' } });
  return new Response(buildZip(files), { headers });
}
