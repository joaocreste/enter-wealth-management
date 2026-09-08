/**
 * Signed artefact links (§24 — signed asset access).
 *
 * A PDF opened in a new tab and an HTML preview loaded into an iframe are
 * browser-initiated navigations: they cannot carry an Authorization header, and
 * once the portal is served from a different origin than the API the session
 * cookie will not travel either. So the API mints a short-lived signed URL for
 * each artefact when it hands over the report metadata.
 *
 * The signature covers the report, the artefact kind and the expiry, so a link
 * cannot be edited into a link for a different report or a longer life. It does
 * not replace authorization: the link is only ever issued to a caller that has
 * already passed resolveClientScope.
 */

const enc = new TextEncoder();
const TTL_SECONDS = 60 * 60 * 6;

const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function key(secret) {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

async function sign(secret, payload) {
  const sig = await crypto.subtle.sign('HMAC', await key(secret), enc.encode(payload));
  return b64url(sig);
}

function signingSecret(env) {
  // Never falls back to a constant: an unset secret disables signed links
  // rather than issuing forgeable ones.
  return env.ASSET_SIGNING_KEY || env.SERVICE_TOKEN || null;
}

export async function signArtefact(env, reportId, kind, ttl = TTL_SECONDS) {
  const secret = signingSecret(env);
  if (!secret) return null;
  const exp = Math.floor(Date.now() / 1000) + ttl;
  const sig = await sign(secret, `${reportId}:${kind}:${exp}`);
  return `${exp}.${sig}`;
}

export async function verifyArtefactToken(env, reportId, kind, token) {
  const secret = signingSecret(env);
  if (!secret || !token) return false;
  const [expRaw, sig] = String(token).split('.');
  const exp = Number(expRaw);
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return false;
  const expected = await sign(secret, `${reportId}:${kind}:${exp}`);
  if (expected.length !== sig?.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}

/** The link set attached to a report row, so the portal needs no extra round trip. */
export async function artefactLinks(env, reportId, base = '') {
  const kinds = ['pdf', 'html', 'portal'];
  const out = {};
  for (const kind of kinds) {
    const token = await signArtefact(env, reportId, kind);
    out[kind] = token ? `${base}/api/reports/${reportId}/${kind}?t=${encodeURIComponent(token)}` : `${base}/api/reports/${reportId}/${kind}`;
  }
  return out;
}
