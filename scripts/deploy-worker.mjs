/**
 * Deploys the API Worker and writes its real URL into web/shared/config.js.
 *
 * The portal resolves its API base at runtime from the hostname, but it still
 * needs to know the Worker's address. Rather than asking anyone to remember to
 * paste it, the deploy reads it back from wrangler's own output and rewrites the
 * placeholder, so the committed config and the deployed Worker cannot drift.
 */
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = path.join(ROOT, 'web', 'shared', 'config.js');

const run = (args) => execFileSync('npx', ['wrangler', ...args], { cwd: ROOT, encoding: 'utf8', stdio: ['inherit', 'pipe', 'inherit'] });

console.log('\n  Deploying the API Worker…\n');
const out = run(['deploy']);
process.stdout.write(out);

const url = out.match(/https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev/i)?.[0];
if (!url) {
  console.error('\n  Could not read the Worker URL from the deploy output.');
  console.error('  Set it by hand in web/shared/config.js and re-run the Pages workflow.\n');
  process.exit(1);
}

const config = await readFile(CONFIG, 'utf8');
const updated = config.replace(/const WORKER_API = '[^']*';/, `const WORKER_API = '${url}';`);
if (updated === config && !config.includes(url)) {
  console.error(`\n  Could not rewrite WORKER_API in ${CONFIG}.\n`);
  process.exit(1);
}
await writeFile(CONFIG, updated);

console.log(`\n  Worker:  ${url}`);
console.log(`  Wrote that URL into web/shared/config.js.`);
console.log('  Commit and push to publish the portal against it:\n');
console.log('    git add web/shared/config.js && git commit -m "point the portal at the deployed Worker" && git push\n');
