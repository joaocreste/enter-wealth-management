/**
 * Authentication (§24).
 *
 * Two paths, both terminating in the same session record:
 *   · Cloudflare Access — the production path. When the Access identity headers
 *     are present the identity comes from the platform and no password is used.
 *   · Email + password — the local and demo path, PBKDF2-SHA256 with a per-user
 *     salt, so a working login exists without an Access tenant configured.
 *
 * Authorization (who may see which client) is NOT here — it lives in
 * resolveClientScope, so there is exactly one place to audit.
 */
import { first, run, nowIso } from './db.js';

// 100,000 is the Cloudflare Workers ceiling for PBKDF2 — the runtime rejects
// anything above it. The local emulator does not enforce the cap, so this only
// surfaces on a deployed Worker.
const PBKDF2_ITERATIONS = 100_000;
const SESSION_HOURS = 12;
const enc = new TextEncoder();

const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

export async function hashPassword(password, saltHex = null) {
  const salt = saltHex
    ? Uint8Array.from(saltHex.match(/../g).map((h) => parseInt(h, 16)))
    : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' }, key, 256,
  );
  return { hash: toHex(bits), salt: toHex(salt) };
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function login(db, email, password) {
  const user = await first(db, 'SELECT * FROM users WHERE email = ?', String(email || '').toLowerCase().trim());
  if (!user || !user.password_hash) return null;
  const { hash } = await hashPassword(password, user.password_salt);
  if (!timingSafeEqual(hash, user.password_hash)) return null;
  return createSession(db, user);
}

export async function createSession(db, user) {
  const token = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
  const expires = new Date(Date.now() + SESSION_HOURS * 3600_000).toISOString();
  await run(db, 'INSERT INTO sessions (token, user_id, role, expires_at) VALUES (?,?,?,?)', token, user.id, user.role, expires);
  return { token, expires_at: expires, user: { id: user.id, name: user.name, email: user.email, role: user.role } };
}

export async function sessionFromRequest(request, env, db) {
  // Cloudflare Access, when the Worker is published behind an Access application
  const accessEmail = request.headers.get('Cf-Access-Authenticated-User-Email');
  const accessJwt = request.headers.get('Cf-Access-Jwt-Assertion');
  if (accessEmail && accessJwt) {
    const user = await first(db, 'SELECT * FROM users WHERE email = ?', accessEmail.toLowerCase());
    if (user) return { user_id: user.id, role: user.role, name: user.name, email: user.email, via: 'cloudflare_access' };
  }

  // Service token for the Rivet runner — a trusted internal caller, scoped
  // explicitly rather than borrowing an advisor's session.
  const svc = request.headers.get('X-Service-Token');
  if (svc && env.SERVICE_TOKEN && svc === env.SERVICE_TOKEN) {
    return { user_id: 'svc_rivet', role: 'service', name: 'Rivet graph runner', email: null, via: 'service_token' };
  }

  const header = request.headers.get('Authorization') || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : null;
  const cookie = (request.headers.get('Cookie') || '').match(/(?:^|;\s*)ew_session=([^;]+)/);
  const token = bearer || (cookie ? decodeURIComponent(cookie[1]) : null);
  if (!token) return null;

  const row = await first(db, 'SELECT * FROM sessions WHERE token = ?', token);
  if (!row || row.expires_at < nowIso()) return null;
  const user = await first(db, 'SELECT * FROM users WHERE id = ?', row.user_id);
  if (!user) return null;
  return { user_id: user.id, role: user.role, name: user.name, email: user.email, via: 'session_token', token };
}

export async function logout(db, token) {
  if (token) await run(db, 'DELETE FROM sessions WHERE token = ?', token);
}
