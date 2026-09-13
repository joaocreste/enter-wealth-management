/**
 * The investment policy as a document.
 *
 * `investment_policies` holds the policy the engine reads — the bands, the caps,
 * the restrictions every suitability check is measured against. What the advisor
 * hands a client, opens in a meeting and has to replace when a new one is signed
 * is the PDF those parameters were agreed in. This module holds that file.
 *
 * Replacing never deletes. The previous document is marked superseded and its R2
 * object stays where it was, so a letter written under an older policy can still
 * be read against the document that governed it (§11). An upload identical to
 * the one already stored is refused rather than filed as a new version: the
 * advisor pressing the button twice should not invent a second version of the
 * same policy.
 *
 * The file is fetched by navigation — a click on a link, not a fetch() the page
 * can put a header on — so it is served through a signed link like the report
 * artefacts (worker/src/links.js), with the session path kept as a fallback.
 */
import { all, first, run, id, nowIso, audit } from './db.js';
import { signArtefact } from './links.js';

export const ARTEFACT_KIND = 'policy-document';

/** A signed policy with scanned pages, not a video. */
export const MAX_BYTES = 20 * 1024 * 1024;

/**
 * An allowlist, not a blocklist: this file is handed back to a browser later,
 * and the set of things a policy is ever delivered as is small.
 */
const ACCEPTED = [
  { ext: 'pdf', type: 'application/pdf' },
  { ext: 'doc', type: 'application/msword' },
  { ext: 'docx', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
];
export const ACCEPTED_EXTENSIONS = ACCEPTED.map((a) => a.ext);

const SELECT = `SELECT d.*, u.name AS uploaded_by_name, p.version AS policy_version
    FROM policy_documents d
    LEFT JOIN users u ON u.id = d.uploaded_by
    LEFT JOIN investment_policies p ON p.id = d.investment_policy_id`;

const extOf = (name) => String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] || '';
/** A filename a header can carry verbatim; the real one rides in filename*. */
const asciiName = (name) => String(name || 'politica').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

export async function documentRow(db, docId) {
  return first(db, `${SELECT} WHERE d.id = ?`, docId);
}

export async function currentDocument(db, clientId) {
  return first(db, `${SELECT} WHERE d.client_id = ? AND d.status = 'current' ORDER BY d.version DESC LIMIT 1`, clientId);
}

/** What the portal sees of one stored document, with a link it can actually follow. */
export async function documentView(env, row) {
  if (!row) return null;
  const token = await signArtefact(env, row.id, ARTEFACT_KIND);
  const q = token ? `?t=${encodeURIComponent(token)}` : '';
  const base = `/api/policy-documents/${row.id}/file`;
  return {
    id: row.id, version: row.version, status: row.status,
    filename: row.filename, content_type: row.content_type, size_bytes: row.size_bytes,
    sha256: row.sha256, note: row.note,
    policy_version: row.policy_version ?? null,
    uploaded_by: row.uploaded_by_name || null,
    uploaded_at: row.uploaded_at,
    links: { view: `${base}${q}`, download: `${base}${q}${q ? '&' : '?'}dl=1` },
  };
}

/** The document in force and every version behind it, newest first. */
export async function policyDocuments(env, clientId) {
  const rows = await all(env.DB, `${SELECT} WHERE d.client_id = ? ORDER BY d.version DESC`, clientId);
  const versions = [];
  for (const r of rows) versions.push(await documentView(env, r));
  return {
    current: versions.find((d) => d.status === 'current') ?? null,
    versions,
    accepts: ACCEPTED_EXTENSIONS,
    max_bytes: MAX_BYTES,
  };
}

/**
 * Store an uploaded policy and make it the one in force. Returns `{ error }`
 * rather than throwing, so the route can answer 400 with something the advisor
 * can act on instead of a stack trace.
 */
export async function storeDocument(env, request, { scope, session }) {
  const db = env.DB;
  const { client } = scope;
  if (!env.REPORTS) return { error: 'o armazenamento de arquivos não está configurado' };

  let form;
  try { form = await request.formData(); } catch { return { error: 'envio inválido: esperado um formulário com o arquivo' }; }
  const file = form.get('file');
  if (!file || typeof file === 'string') return { error: 'nenhum arquivo foi enviado' };

  const name = String(file.name || '').trim() || 'politica-de-investimento.pdf';
  const accepted = ACCEPTED.find((a) => a.ext === extOf(name));
  if (!accepted) return { error: `formato não aceito: envie ${ACCEPTED_EXTENSIONS.map((e) => e.toUpperCase()).join(', ')}` };
  if (!file.size) return { error: 'o arquivo está vazio' };
  if (file.size > MAX_BYTES) return { error: `o arquivo tem ${(file.size / 1048576).toFixed(1)} MB, acima do limite de ${MAX_BYTES / 1048576} MB` };

  const bytes = new Uint8Array(await file.arrayBuffer());
  const sha256 = hex(await crypto.subtle.digest('SHA-256', bytes));

  const previous = await currentDocument(db, client.id);
  if (previous && previous.sha256 === sha256) {
    return { unchanged: true, document: await documentView(env, previous) };
  }

  const policy = await first(db, "SELECT id FROM investment_policies WHERE client_id = ? AND status = 'approved' ORDER BY version DESC LIMIT 1", client.id);
  const version = ((await first(db, 'SELECT MAX(version) AS v FROM policy_documents WHERE client_id = ?', client.id))?.v ?? 0) + 1;
  const docId = id('pol');
  const key = `policies/${client.id}/v${version}-${docId}.${accepted.ext}`;
  await env.REPORTS.put(key, bytes, { httpMetadata: { contentType: accepted.type } });

  await run(db, "UPDATE policy_documents SET status = 'superseded' WHERE client_id = ? AND status = 'current'", client.id);
  await run(db, `INSERT INTO policy_documents (id, client_id, investment_policy_id, version, status, filename, content_type, size_bytes, sha256, r2_key, note, uploaded_by, uploaded_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    docId, client.id, policy?.id ?? null, version, 'current', name, accepted.type, bytes.length, sha256, key,
    String(form.get('note') || '').trim().slice(0, 500) || null, session.user_id, nowIso());

  await audit(db, {
    entity: 'policy_document', entity_id: docId, action: previous ? 'replaced' : 'uploaded', actor_id: session.user_id,
    detail: { client_id: client.id, version, filename: name, size_bytes: bytes.length, replaced: previous?.id ?? null },
  });

  return { document: await documentView(env, await documentRow(db, docId)), replaced: previous ? previous.version : null };
}

/** The stored bytes. `download` forces the save dialog; otherwise the browser may show it. */
export async function serveDocument(env, row, { download = false } = {}) {
  const jsonHeaders = { 'content-type': 'application/json; charset=utf-8' };
  if (!env.REPORTS) return new Response(JSON.stringify({ error: 'o armazenamento de arquivos não está configurado' }), { status: 503, headers: jsonHeaders });
  const obj = await env.REPORTS.get(row.r2_key);
  if (!obj) return new Response(JSON.stringify({ error: 'o arquivo não está mais no armazenamento' }), { status: 404, headers: jsonHeaders });
  return new Response(obj.body, {
    headers: {
      'content-type': row.content_type,
      'content-disposition': `${download ? 'attachment' : 'inline'}; filename="${asciiName(row.filename)}"; filename*=UTF-8''${encodeURIComponent(row.filename)}`,
      'cache-control': 'private, max-age=300',
    },
  });
}
