/**
 * Provisions the Cloudflare resources this Worker binds to, then deploys.
 *
 *   npm run setup:cloudflare
 *
 * Idempotent: existing resources are reused rather than duplicated, and the ids
 * are written back into wrangler.toml so the binding config and the account
 * cannot drift. Run it once per account; after that `npm run deploy:worker` is
 * enough.
 */
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOML = path.join(ROOT, 'wrangler.toml');

const D1_NAME = 'enter-wealth';
const KV_NAME = 'MARKET_CACHE';
const R2_NAME = 'enter-wealth-reports';

const say = (s) => console.log(`  ${s}`);
const wrangler = (args, { quiet = false } = {}) => {
  try {
    return execFileSync('npx', ['wrangler', ...args], {
      cwd: ROOT, encoding: 'utf8', stdio: ['pipe', 'pipe', quiet ? 'pipe' : 'inherit'],
    });
  } catch (err) {
    return `__ERROR__${err.stdout || ''}${err.stderr || ''}`;
  }
};

// ── who are we ────────────────────────────────────────────────────────────
const who = wrangler(['whoami'], { quiet: true });
const email = who.match(/associated with the email ([^\s.]+@[^\s.]+\.[^\s.]+)/i)?.[1];
const account = who.match(/│\s*(\S[^│]*?)\s*│\s*([0-9a-f]{32})\s*│/);
if (!email) {
  console.error('\n  Not logged in. Run:  npx wrangler login\n');
  process.exit(1);
}
console.log('\n  Cloudflare setup');
console.log(`  ${'─'.repeat(64)}`);
say(`account   ${account?.[1] ?? 'unknown'} (${email})`);

// ── D1 ────────────────────────────────────────────────────────────────────
let dbId = null;
const dbList = wrangler(['d1', 'list', '--json'], { quiet: true });
try {
  dbId = JSON.parse(dbList.replace(/^[^[{]*/, '')).find((d) => d.name === D1_NAME)?.uuid ?? null;
} catch { /* fall through to create */ }
if (!dbId) {
  const created = wrangler(['d1', 'create', D1_NAME], { quiet: true });
  dbId = created.match(/database_id\s*=\s*"([0-9a-f-]{36})"/)?.[1]
    ?? created.match(/"uuid":\s*"([0-9a-f-]{36})"/)?.[1] ?? null;
  say(`d1        created ${D1_NAME}`);
} else {
  say(`d1        reusing ${D1_NAME}`);
}
if (!dbId) { console.error('\n  Could not determine the D1 database id.\n'); process.exit(1); }

// ── KV ────────────────────────────────────────────────────────────────────
let kvId = null;
const kvList = wrangler(['kv', 'namespace', 'list'], { quiet: true });
try {
  kvId = JSON.parse(kvList.replace(/^[^[]*/, '')).find((n) => n.title?.endsWith(KV_NAME))?.id ?? null;
} catch { /* fall through to create */ }
if (!kvId) {
  const created = wrangler(['kv', 'namespace', 'create', KV_NAME], { quiet: true });
  kvId = created.match(/id\s*=\s*"([0-9a-f]{32})"/)?.[1] ?? created.match(/"id":\s*"([0-9a-f]{32})"/)?.[1] ?? null;
  say(`kv        created ${KV_NAME}`);
} else {
  say(`kv        reusing ${KV_NAME}`);
}
if (!kvId) { console.error('\n  Could not determine the KV namespace id.\n'); process.exit(1); }

// ── R2 ────────────────────────────────────────────────────────────────────
const buckets = wrangler(['r2', 'bucket', 'list'], { quiet: true });
if (buckets.includes(R2_NAME)) say(`r2        reusing ${R2_NAME}`);
else {
  const out = wrangler(['r2', 'bucket', 'create', R2_NAME], { quiet: true });
  if (out.startsWith('__ERROR__') && !out.includes('already')) {
    console.error(`\n  Could not create the R2 bucket. R2 may not be enabled on this account.\n  ${out.slice(9, 400)}\n`);
    process.exit(1);
  }
  say(`r2        created ${R2_NAME}`);
}

// ── write the ids back ────────────────────────────────────────────────────
let toml = await readFile(TOML, 'utf8');
toml = toml.replace(/(\[\[d1_databases\]\][\s\S]*?database_id = ")[^"]*(")/, `$1${dbId}$2`);
toml = toml.replace(/(\[\[kv_namespaces\]\][\s\S]*?id = ")[^"]*(")/, `$1${kvId}$2`);
toml = toml.replace(/# replace after `wrangler d1 create enter-wealth`\n?/, '');
toml = toml.replace(/\s*# replace after `wrangler kv namespace create MARKET_CACHE`/, '');
await writeFile(TOML, toml);
say('wrangler  ids written into wrangler.toml');

// ── secrets ───────────────────────────────────────────────────────────────
const randomToken = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
for (const name of ['SERVICE_TOKEN', 'ASSET_SIGNING_KEY', 'SEED_TOKEN']) {
  const value = randomToken();
  try {
    execFileSync('npx', ['wrangler', 'secret', 'put', name], { cwd: ROOT, input: value, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    say(`secret    ${name} set`);
    if (name === 'SERVICE_TOKEN') console.log(`\n            the Rivet runner needs this:  export SERVICE_TOKEN=${value}\n`);
    if (name === 'SEED_TOKEN') console.log(`            seeding the deployed database needs this:  ${value}\n`);
  } catch (err) {
    say(`secret    ${name} FAILED — set it by hand with: npx wrangler secret put ${name}`);
  }
}

// ── schema ────────────────────────────────────────────────────────────────
say('migrate   applying schema to the remote database…');
const migrated = wrangler(['d1', 'migrations', 'apply', D1_NAME, '--remote']);
if (String(migrated).startsWith('__ERROR__')) {
  console.error('\n  Migration failed. Fix the error above and re-run.\n');
  process.exit(1);
}

console.log(`\n  ${'─'.repeat(64)}`);
console.log('  Provisioned. Next:\n');
console.log('    npm run deploy:worker      deploy the API and write its URL into the portal');
console.log('    git add web/shared/config.js wrangler.toml && git commit && git push');
console.log('                               publishes the portal to GitHub Pages against it\n');
