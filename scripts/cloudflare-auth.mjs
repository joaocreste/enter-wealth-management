/**
 * Resolves Cloudflare credentials for the deploy scripts.
 *
 * Wrangler's OAuth flow needs an interactive terminal, a free callback port and
 * a browser already signed in to the right account. When any of those is not
 * available — CI, a remote shell, or a machine with two Cloudflare accounts —
 * an API token is the reliable path.
 *
 * Order: an existing CLOUDFLARE_API_TOKEN in the environment, then a
 * .cloudflare-token file beside the project (gitignored), then whatever OAuth
 * session wrangler already holds.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function cloudflareEnv() {
  const env = { ...process.env };
  if (env.CLOUDFLARE_API_TOKEN) return { env, source: 'CLOUDFLARE_API_TOKEN environment variable' };
  try {
    const token = (await readFile(path.join(ROOT, '.cloudflare-token'), 'utf8')).trim();
    if (token) {
      env.CLOUDFLARE_API_TOKEN = token;
      return { env, source: '.cloudflare-token' };
    }
  } catch { /* no token file; fall through to the OAuth session */ }
  return { env, source: 'wrangler OAuth session' };
}
