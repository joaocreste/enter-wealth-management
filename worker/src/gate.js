/**
 * The access gate: the whole portal behind one password, checked by the Worker
 * before any page or asset is served.
 *
 * The API keeps its own authentication (a session token per user); the gate
 * sits in front of the pages, the scripts, the styles and the photographs, so
 * that nothing of the product is visible to someone who does not hold the
 * password. The password is a Worker secret (SITE_PASSWORD), never in the code;
 * the gate is off when the secret is not set, which is how local development runs.
 *
 * A correct password sets an HttpOnly cookie carrying an expiry and an HMAC
 * over it, signed with the same secret the artefact links use, so the cookie
 * cannot be forged or extended. Twelve hours later the gate asks again.
 */
import { LOGO_SYMBOL_PATH, LOGO_SYMBOL_VIEWBOX } from '../../src/core/brand.js';

const COOKIE = 'ew_gate';
const TTL_SECONDS = 12 * 60 * 60;
const enc = new TextEncoder();
const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export const gateEnabled = (env) => typeof env.SITE_PASSWORD === 'string' && env.SITE_PASSWORD.length > 0;

function secret(env) { return env.ASSET_SIGNING_KEY || env.SERVICE_TOKEN || env.SITE_PASSWORD; }

async function sign(env, payload) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret(env)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, enc.encode(payload)));
}

/** Equal strings, compared in constant time; a different length is simply not equal. */
function same(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const la = enc.encode(a); const lb = enc.encode(b);
  let diff = la.length ^ lb.length;
  for (let i = 0; i < Math.max(la.length, lb.length); i += 1) diff |= (la[i] ?? 0) ^ (lb[i] ?? 0);
  return diff === 0;
}

function cookieValue(request, name) {
  const raw = request.headers.get('cookie') || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

const safePath = (p) => (/^\/(?!\/)/.test(String(p || '')) ? String(p) : '/');

/** True when the request carries a cookie the gate signed and that has not expired. */
export async function gatePassed(request, env) {
  const token = cookieValue(request, COOKIE);
  if (!token) return false;
  const [expRaw, sig] = token.split('.');
  const exp = Number(expRaw);
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return false;
  return same(await sign(env, `gate:${exp}`), sig || '');
}

/** The form's POST: the password, then the cookie and a redirect to where the person was going. */
export async function gateSubmit(request, env, url) {
  const form = await request.formData().catch(() => null);
  const password = String(form?.get('password') ?? '');
  const next = safePath(form?.get('next'));
  if (!same(password, env.SITE_PASSWORD)) {
    await new Promise((resolve) => setTimeout(resolve, 600));   // a wrong guess costs a little time
    return gatePage(url, { next, error: true });
  }
  const exp = Math.floor(Date.now() / 1000) + TTL_SECONDS;
  const token = `${exp}.${await sign(env, `gate:${exp}`)}`;
  return new Response(null, {
    status: 303,
    headers: {
      location: next,
      'set-cookie': `${COOKIE}=${token}; Path=/; Max-Age=${TTL_SECONDS}; HttpOnly; Secure; SameSite=Lax`,
      'cache-control': 'no-store',
    },
  });
}

const escape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

/** The gate itself: the Carta's dark cover, the symbol, one field. */
export function gatePage(url, { next = null, error = false } = {}) {
  const target = safePath(next || `${url.pathname}${url.search}`);
  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>XP Asset Management — Acesso</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Roboto:wght@300;400;500&family=Hanken+Grotesk:wght@300;400&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box}
html,body{margin:0;min-height:100%}
body{background:#1F1F1F;color:#DDDDDD;font-family:'Roboto','Helvetica Neue',Arial,sans-serif;font-weight:300;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px 16px}
.cover{position:relative;width:min(440px,100%);padding:36px 36px 32px;background:#242424;border-top:2px solid #BB795E;overflow:hidden}
.ray{position:absolute;right:0;bottom:0;width:100%;height:38%;pointer-events:none}
.lockup{display:flex;align-items:flex-end;gap:6px;color:#fff;margin-bottom:34px}
.lockup svg{width:32px;height:auto;fill:currentColor;fill-rule:evenodd}
.lockup span{font-family:'Hanken Grotesk','Roboto',sans-serif;font-weight:400;font-size:22px;line-height:1;padding-bottom:2px}
.kicker{font-size:10px;letter-spacing:.3em;text-transform:uppercase;color:#A1A894;margin:0 0 14px}
h1{font-family:'Roboto',sans-serif;font-weight:300;font-size:30px;line-height:1.1;color:#BB795E;margin:0 0 12px}
p{margin:0 0 22px;font-size:14px;line-height:1.7;color:rgba(221,221,221,.85)}
label{display:block;font-size:12px;color:#A1A894;margin-bottom:6px}
input{width:100%;font:inherit;font-weight:400;font-size:15px;padding:12px 14px;background:#1F1F1F;color:#fff;border:1px solid #595959;border-radius:3px;outline:none}
input:focus{border-color:#BB795E}
button{width:100%;margin-top:14px;font:inherit;font-weight:400;font-size:14px;padding:12px 16px;background:#2A3B43;color:#fff;border:0;border-radius:3px;cursor:pointer}
button:hover{background:#3b515c}
.err{margin:14px 0 0;padding:10px 12px;border-left:2px solid #A62900;background:rgba(166,41,0,.14);color:#F0C9BC;font-size:13px}
.foot{position:relative;margin-top:26px;font-size:10px;letter-spacing:.3em;text-transform:uppercase;color:#7F7F7F}
</style>
</head>
<body>
<main class="cover">
  <svg class="ray" viewBox="0 0 1200 268.8" preserveAspectRatio="xMaxYMax slice" aria-hidden="true"><defs><linearGradient id="g" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stop-color="#CF7A5B"/><stop offset="1" stop-color="#654339"/></linearGradient></defs><polygon points="855.8,207.4 1200,0 1200,207.4" fill="url(#g)" opacity=".9"/><line x1="0" y1="207.4" x2="1200" y2="207.4" stroke="#BB795E" stroke-width=".8" vector-effect="non-scaling-stroke"/><line x1="1200" y1="0" x2="855.8" y2="267" stroke="#BB795E" stroke-width=".8" vector-effect="non-scaling-stroke"/></svg>
  <div class="lockup"><svg viewBox="${LOGO_SYMBOL_VIEWBOX}" role="img" aria-label="XP Asset Management"><path d="${LOGO_SYMBOL_PATH}"/></svg><span>asset management</span></div>
  <p class="kicker">Portal de investimentos</p>
  <h1>Acesso restrito</h1>
  <p>Este portal é de uso exclusivo de clientes e assessores da XP Asset Management. Informe a senha de acesso para continuar.</p>
  <form method="post" action="/gate" autocomplete="off">
    <input type="hidden" name="next" value="${escape(target)}">
    <label for="password">Senha de acesso</label>
    <input type="password" id="password" name="password" autofocus required autocomplete="current-password">
    <button type="submit">entrar</button>
  </form>
  ${error ? '<p class="err" role="alert">Senha incorreta. Tente novamente.</p>' : ''}
  <p class="foot">XP Asset Management · São Paulo</p>
</main>
</body>
</html>`;
  return new Response(html, { status: 401, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' } });
}
