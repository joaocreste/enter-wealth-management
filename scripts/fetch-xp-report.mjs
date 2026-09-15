/**
 * Fetch XP's monthly macro report and hand it to the Worker.
 *
 *   node scripts/fetch-xp-report.mjs                      # local Worker
 *   node scripts/fetch-xp-report.mjs --api https://…      # deployed
 *   node scripts/fetch-xp-report.mjs --dry-run            # fetch and print, send nothing
 *
 * Why this exists: conteudos.xpi.com.br sits behind a WAF that refuses the
 * Cloudflare Workers runtime on every path — the feed, the archive, the
 * article, the root domain — and it refuses it below the header layer, so
 * there is nothing the Worker can put in a request that gets through. The same
 * request from Node is served normally. So the fetch and the parse happen
 * here, and the Worker is handed the parsed edition; its macro agent then
 * reads the house view out of KV and makes no outbound call for it at all.
 *
 * Run it on a schedule (.github/workflows/xp-macro.yml) a little more often
 * than XP publishes. A deposit is good for 45 days, so a missed run changes
 * nothing; a run that finds the same edition simply refreshes it.
 *
 * It fails loudly. A silent failure here would leave the portal showing a
 * February 2025 vintage while saying nothing is wrong.
 */
import { monthlyReport, LIVE_ROUTES } from '../src/adapters/xpresearch.js';
import { useDisk } from '../src/adapters/cache.js';

const args = Object.fromEntries(process.argv.slice(2).flatMap((a, i, all) => (a.startsWith('--') ? [[a.slice(2), all[i + 1]?.startsWith('--') === false ? all[i + 1] : true]] : [])));
const API = args.api || process.env.API_BASE || 'http://127.0.0.1:8788';
const TOKEN = args.token || process.env.SERVICE_TOKEN || 'dev-service-token';

await useDisk('.cache');

console.log(`Reading XP's Brasil Macro Mensal…`);
// Live routes only. Reading a deposited edition here would re-deposit what
// this job last wrote and the house view would never move again.
const report = await monthlyReport({ routes: LIVE_ROUTES });

if (report.unavailable) {
  console.error(`\n  ✗ the report could not be retrieved\n    ${report.reason}\n`);
  for (const a of report.attempts || []) console.error(`      ${a.route}: ${a.ok ? 'ok' : a.reason}`);
  process.exit(1);
}

const figures = report.figures.map((f) => `${f.label} ${f.written} ${f.year}`).join(' · ');
console.log(`
  ${report.title}
  published   ${report.published_label} (${report.age_days} days ago)${report.stale ? '  ⚠ stale' : ''}
  route       ${report.route_label}
  authors     ${report.authors.map((a) => a.name).join(', ') || '—'}
  conclusions ${report.summary.length}
  stances     ${report.sections.length}
  projections ${figures || '(none parsed — the sentences are still carried)'}
  url         ${report.url}
`);

if (args['dry-run']) { console.log('  --dry-run: nothing sent.\n'); process.exit(0); }

const res = await fetch(`${API}/api/admin/xp-report`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'X-Service-Token': TOKEN },
  body: JSON.stringify({ report, fetched_at: report.retrieved_at }),
});
const out = await res.json().catch(() => ({}));
if (!res.ok) {
  console.error(`\n  ✗ ${API} refused the deposit: HTTP ${res.status} ${out.error || ''}\n`);
  process.exit(1);
}
console.log(`  ✓ deposited with ${API} — ${out.title} (${out.published}), ${out.figures} projections\n`);
