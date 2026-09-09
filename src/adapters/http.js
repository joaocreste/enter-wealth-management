/**
 * Shared fetch wrapper for every provider adapter.
 *
 * Adds a timeout, rate-limit aware backoff and a normalised error shape so the
 * pipeline can decide to fall back rather than throw. Public market endpoints
 * throttle on bursts; a 429 is retried on the same host with a growing pause
 * instead of immediately burning the fallback provider.
 */
export class ProviderError extends Error {
  constructor(message, { status = null, url = null } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    this.url = url;
    this.providerFailure = true;
  }
}

export const USER_AGENT = 'enter-wealth-advisor/1.0 (+https://enteram.com.br; advisory reporting)';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function getJson(url, opts = {}) {
  return request(url, { ...opts, parse: (res) => res.json(), accept: 'application/json,text/plain,*/*' });
}

/** The same wrapper for a text body — an RSS feed, for instance. */
export async function getText(url, opts = {}) {
  return request(url, { ...opts, parse: (res) => res.text(), accept: 'application/rss+xml,application/xml,text/xml,text/plain,*/*' });
}

async function request(url, {
  timeout = 12000, headers = {}, retries = 2, method = 'GET', body = null,
  backoff = [1500, 5000, 15000], parse, accept,
} = {}) {
  let lastErr = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeout);
    try {
      const res = await fetch(url, {
        method,
        signal: ctl.signal,
        headers: {
          // A descriptive agent, not a spoofed browser string. Yahoo actively
          // rate-limits requests that impersonate Chrome against its API hosts.
          'User-Agent': USER_AGENT,
          Accept: accept,
          ...headers,
        },
        ...(body ? { body } : {}),
      });

      if (res.status === 429 || res.status === 503) {
        const retryAfter = Number(res.headers.get('retry-after'));
        const wait = Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(retryAfter * 1000, 30000)
          : backoff[Math.min(attempt, backoff.length - 1)];
        lastErr = new ProviderError(`rate limited (HTTP ${res.status})`, { status: res.status, url });
        if (attempt < retries) { clearTimeout(timer); await sleep(wait); continue; }
        throw lastErr;
      }
      if (!res.ok) throw new ProviderError(`HTTP ${res.status} ${res.statusText}`, { status: res.status, url });
      return await parse(res);
    } catch (err) {
      lastErr = err instanceof ProviderError ? err : new ProviderError(err.message, { url });
      if (attempt < retries && lastErr.status !== 404) await sleep(backoff[Math.min(attempt, backoff.length - 1)] / 3);
      else if (lastErr.status === 404) break;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr || new ProviderError('request failed', { url });
}
