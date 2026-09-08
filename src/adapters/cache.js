/**
 * Provider response cache + request throttle.
 *
 * Market providers rate-limit aggressively; a monthly report for five clients
 * touches the same tickers repeatedly. Cached responses keep their original
 * source metadata (including the real retrieval timestamp), so a cached value
 * is never presented as freshly retrieved.
 *
 * Backends: an in-process Map always; a Cloudflare KV namespace when running in
 * the Worker (§24 — cached market responses are explicitly a KV use case);
 * a disk cache when running under Node so a Rivet run is reproducible offline.
 */

const mem = new Map();

let kv = null;          // Cloudflare KV namespace, injected by the Worker
let diskDir = null;     // set by the Node runner

export function useKv(namespace) { kv = namespace; }
export async function useDisk(dir) {
  diskDir = dir;
  const { mkdir } = await import('node:fs/promises');
  await mkdir(dir, { recursive: true });
}

function keyOf(k) { return `mkt:${k}`.replace(/[^a-zA-Z0-9:._-]/g, '_'); }

export async function cacheGet(k, ttlSeconds) {
  const key = keyOf(k);
  const now = Date.now();
  const hit = mem.get(key);
  if (hit && now - hit.at < ttlSeconds * 1000) return hit.value;

  if (kv) {
    try {
      const raw = await kv.get(key, 'json');
      if (raw && now - raw.at < ttlSeconds * 1000) { mem.set(key, raw); return raw.value; }
    } catch { /* cache miss is never fatal */ }
  }
  if (diskDir) {
    try {
      const { readFile } = await import('node:fs/promises');
      const path = await import('node:path');
      const raw = JSON.parse(await readFile(path.join(diskDir, `${key}.json`), 'utf8'));
      if (raw && now - raw.at < ttlSeconds * 1000) { mem.set(key, raw); return raw.value; }
    } catch { /* cache miss is never fatal */ }
  }
  return null;
}

export async function cacheSet(k, value, ttlSeconds = 3600) {
  const key = keyOf(k);
  const entry = { at: Date.now(), value };
  mem.set(key, entry);
  if (kv) { try { await kv.put(key, JSON.stringify(entry), { expirationTtl: Math.max(60, ttlSeconds) }); } catch { /* non-critical */ } }
  if (diskDir) {
    try {
      const { writeFile } = await import('node:fs/promises');
      const path = await import('node:path');
      await writeFile(path.join(diskDir, `${key}.json`), JSON.stringify(entry));
    } catch { /* non-critical */ }
  }
  return value;
}

/**
 * Serialises calls to one provider with a minimum gap between them.
 * Yahoo starts returning 429 within a few hundred milliseconds of parallel calls.
 */
const queues = new Map();
export function throttle(providerKey, minGapMs) {
  if (!queues.has(providerKey)) queues.set(providerKey, { chain: Promise.resolve(), last: 0 });
  const q = queues.get(providerKey);
  const run = q.chain.then(async () => {
    const wait = Math.max(0, q.last + minGapMs - Date.now());
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    q.last = Date.now();
  });
  q.chain = run.catch(() => {});
  return run;
}
