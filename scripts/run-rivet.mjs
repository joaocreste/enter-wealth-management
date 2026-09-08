/**
 * Runs the Rivet graph headlessly.
 *
 *   npm run run:report  -- --client cli_albert [--month 2026-08]
 *   npm run run:overview
 *
 * The same .rivet-project file opens in Rivet Desktop; this runner exists so
 * the workflow is reproducible from a terminal and from CI, not because the
 * graph is a formality. Every stage the runner reports is a subgraph on the
 * canvas.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGraphInFile, loadProjectFromFile } from '@ironclad/rivet-node';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.join(HERE, '..', 'rivet', 'enter_wealth_advisor.rivet-project');

const args = Object.fromEntries(
  process.argv.slice(2).flatMap((a, i, all) => (a.startsWith('--') ? [[a.slice(2), all[i + 1]?.startsWith('--') ? true : all[i + 1] ?? true]] : [])),
);
const mode = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'report';

const API_BASE = args.api || process.env.API_BASE || 'http://127.0.0.1:8788';
const API_TOKEN = args.token || process.env.SERVICE_TOKEN || 'dev-service-token';
const CLIENT_ID = args.client || 'cli_albert';
const MONTH = args.month || '';

const GRAPHS = {
  report: '00 · Monthly client report',
  overview: '10 · Daily World Overview',
};

function fmt(v) {
  if (v == null) return '—';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

async function api(pathname, body) {
  const res = await fetch(`${API_BASE}${pathname}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', 'x-service-token': API_TOKEN },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${pathname} → HTTP ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

const graphName = GRAPHS[mode];
if (!graphName) {
  console.error(`unknown mode "${mode}". Use: report | overview`);
  process.exit(1);
}

console.log(`\n  Enter Asset Management — Rivet workflow`);
console.log(`  ${'─'.repeat(64)}`);
console.log(`  project   ${path.relative(process.cwd(), PROJECT)}`);
console.log(`  graph     ${graphName}`);
console.log(`  api       ${API_BASE}`);

const health = await api('/api/health').catch((e) => {
  console.error(`\n  The API is not reachable at ${API_BASE}.`);
  console.error('  Start it with:  npm run dev\n');
  console.error(`  ${e.message}`);
  process.exit(1);
});
console.log(`  narrative ${health.llm === 'configured' ? 'language model configured' : 'deterministic renderer (no model provider configured)'}`);

const inputs = { api_base: API_BASE, api_token: API_TOKEN, reissue: !!args.reissue };

if (mode === 'report') {
  const start = await api('/api/pipeline/start', { client_id: CLIENT_ID, month: MONTH || undefined, graph: 'monthly_client_report' });
  inputs.run_id = start.run_id;
  inputs.client_id = CLIENT_ID;
  inputs.month = start.month;
  console.log(`  client    ${CLIENT_ID}`);
  console.log(`  month     ${start.month}`);
  console.log(`  run       ${start.run_id}`);
  if (args.reissue) console.log('  reissue   yes — a published letter for this month will be replaced');
}
console.log(`  ${'─'.repeat(64)}\n`);

const started = Date.now();
const stageTimes = new Map();

const outputs = await runGraphInFile(PROJECT, {
  graph: graphName,
  inputs,
  openAiKey: process.env.OPENAI_API_KEY || '',
  pluginSettings: { anthropic: { anthropicApiKey: process.env.ANTHROPIC_API_KEY || '' } },
  onUserEvent: {},
  externalFunctions: {},
  onNodeStart: ({ node }) => {
    if (node.type === 'subGraph') stageTimes.set(node.id, { title: node.title, at: Date.now() });
  },
  onNodeFinish: ({ node }) => {
    const s = stageTimes.get(node.id);
    if (s) console.log(`  ✓ ${s.title.padEnd(38)} ${String(Date.now() - s.at).padStart(6)} ms`);
  },
  onNodeError: ({ node, error }) => {
    console.error(`  ✗ ${node.title}: ${error?.message || error}`);
  },
});

console.log(`\n  ${'─'.repeat(64)}`);
console.log(`  completed in ${((Date.now() - started) / 1000).toFixed(1)} s\n`);

for (const [k, v] of Object.entries(outputs)) {
  console.log(`  ${k}:`);
  const value = v?.value ?? v;
  if (value && typeof value === 'object') {
    for (const [kk, vv] of Object.entries(value).slice(0, 14)) {
      console.log(`    ${kk.padEnd(26)} ${fmt(vv).slice(0, 110)}`);
    }
  } else {
    console.log(`    ${fmt(value).slice(0, 300)}`);
  }
  console.log('');
}

if (mode === 'report' && inputs.run_id) {
  const state = await api('/api/pipeline/state', { run_id: inputs.run_id });
  console.log(`  run status: ${state.run.status}`);
  console.log(`  stages held in state: ${state.keys.join(', ')}\n`);
}
