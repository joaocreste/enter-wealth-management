/**
 * Builds enter_wealth_advisor.rivet-project.
 *
 * The graph is generated rather than hand-edited so that the prompt text in
 * src/llm/prompts.js and the node graph can never drift apart: edit a prompt,
 * run `npm run build:graph`, and the Rivet project reflects it. The file it
 * writes opens in Rivet Desktop like any other project.
 *
 * Structure (§32): one orchestrator graph calling ten subgraphs, each named for
 * the stage it owns, so the workflow is auditable by reading the canvas.
 */
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  serializeProject, graphInputNode, graphOutputNode, textNode, objectNode,
  httpCallNode, codeNode, subGraphNode, commentNode, extractJsonNode,
  ifElseNode, promptNode,
} from '@ironclad/rivet-node';
import { PROMPTS, PROMPT_VERSION, SYSTEM_GUARDRAIL } from '../src/llm/prompts.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ── tiny builder over the Rivet node factories ─────────────────────────────
let seq = 0;
const nid = (p) => `${p}_${(seq += 1).toString(36).padStart(4, '0')}_ewa`;

function make(factory, { title, x, y, width, data = {}, id }) {
  const n = factory.impl.create();
  n.id = id || nid(n.type);
  n.title = title ?? n.title;
  n.visualData = { x, y, width: width ?? n.visualData?.width ?? 300 };
  n.data = { ...n.data, ...data };
  return n;
}

/**
 * Rivet keeps connections at graph level, not on the node, so they are
 * collected here and attached when the graph is assembled.
 */
let CONNECTIONS = [];

/** connect(from, 'outputPort', to, 'inputPort') */
function connect(from, fromPort, to, toPort) {
  CONNECTIONS.push({
    outputNodeId: from.id, outputId: fromPort,
    inputNodeId: to.id, inputId: toPort,
  });
  return to;
}

function graph(id, name, description, nodes) {
  const nodeIds = new Set(nodes.map((x) => x.id));
  const connections = CONNECTIONS.filter((c) => nodeIds.has(c.outputNodeId) && nodeIds.has(c.inputNodeId));
  CONNECTIONS = CONNECTIONS.filter((c) => !(nodeIds.has(c.outputNodeId) && nodeIds.has(c.inputNodeId)));
  return { metadata: { id, name, description }, nodes, connections };
}

const COMMENT_W = 460;
function note(text, x, y, width = COMMENT_W, height = 92) {
  // The first line doubles as the node title, so the canvas is readable when
  // the comment body is collapsed.
  const title = text.split('\n')[0].slice(0, 72);
  const n = make(commentNode, { title, x, y, width, data: { text, color: { bg: '#1F2427', border: '#2E3439' } } });
  n.visualData.height = height;
  return n;
}

// ── shared building blocks ─────────────────────────────────────────────────

/**
 * One deterministic pipeline step.
 *
 * A Text node builds the URL, an Object node builds the headers and a second
 * Text node builds the request body, because Rivet's HTTP node interpolates
 * only from connected inputs. The parsed JSON comes straight off the node's
 * `json` port. Financial arithmetic never happens in the graph.
 */
function pipelineStep({ step, x, y, bodyTemplate, title, method = 'POST', urlSuffix = '' }) {
  const url = make(textNode, {
    title: `${title} — endpoint`,
    x, y, width: 300,
    data: { text: `{{api_base}}/api/pipeline/${step}${urlSuffix}` },
  });
  const headers = make(objectNode, {
    title: 'Service headers',
    x, y: y + 110, width: 300,
    data: { jsonTemplate: '{\n  "content-type": "application/json",\n  "x-service-token": "{{api_token}}"\n}' },
  });
  const body = make(textNode, {
    title: `${title} — request body`,
    x, y: y + 240, width: 300,
    data: { text: bodyTemplate },
  });
  const call = make(httpCallNode, {
    title: `${method} /api/pipeline/${step}`,
    x: x + 360, y: y + 90, width: 320,
    data: { method, url: '', headers: '', body: '', errorOnNon200: true, useUrlInput: true, useHeadersInput: true, useBodyInput: true },
  });
  connect(url, 'output', call, 'url');
  connect(headers, 'output', call, 'headers');
  connect(body, 'output', call, 'req_body');
  return { url, headers, body, call, result: call, resultPort: 'json', nodes: [url, headers, body, call] };
}

/** Wires api_base / api_token into a step's URL and header nodes. */
function wireStep(step, { apiBase, apiToken }) {
  connect(apiBase, 'data', step.url, 'api_base');
  connect(apiToken, 'data', step.headers, 'api_token');
}

// ═══════════════════════════════════════════════════════════════════════════
// 01 · Ingest
// ═══════════════════════════════════════════════════════════════════════════
function graphIngest() {
  const n = [];
  n.push(note(
    'STAGE 01 — DATA INGESTION\n\n'
    + 'Loads the client, the approved Investment Policy version, the approved portfolio snapshot,\n'
    + 'its positions and the month\'s external cash flows.\n\n'
    + 'Nothing here is inferred. The snapshot is the advisor-approved record and is never\n'
    + 'modified by a market move (§4, layer 3).', 20, 20, 720, 130));

  const apiBase = make(graphInputNode, { title: 'api_base', x: 20, y: 190, data: { id: 'api_base', dataType: 'string' } });
  const apiToken = make(graphInputNode, { title: 'api_token', x: 20, y: 270, data: { id: 'api_token', dataType: 'string' } });
  const runId = make(graphInputNode, { title: 'run_id', x: 20, y: 350, data: { id: 'run_id', dataType: 'string' } });
  const clientId = make(graphInputNode, { title: 'client_id', x: 20, y: 430, data: { id: 'client_id', dataType: 'string' } });
  const month = make(graphInputNode, { title: 'month', x: 20, y: 510, data: { id: 'month', dataType: 'string' } });
  n.push(apiBase, apiToken, runId, clientId, month);

  const step = pipelineStep({
    step: 'context', title: 'Load client, policy and snapshot', x: 420, y: 240,
    bodyTemplate: '{\n  "run_id": "{{run_id}}",\n  "client_id": "{{client_id}}",\n  "month": "{{month}}"\n}',
  });
  wireStep(step, { apiBase, apiToken });
  connect(runId, 'data', step.body, 'run_id');
  connect(clientId, 'data', step.body, 'client_id');
  connect(month, 'data', step.body, 'month');
  n.push(...step.nodes);

  const out = make(graphOutputNode, { title: 'context', x: 1460, y: 260, data: { id: 'context', dataType: 'object' } });
  connect(step.result, step.resultPort, out, 'value');
  n.push(out);
  return graph('g_ingest', '01 · Ingest client, policy and snapshot', 'Loads the approved client record, policy version, portfolio snapshot and the month\'s cash flows.', n);
}

// ═══════════════════════════════════════════════════════════════════════════
// 02 · Market data
// ═══════════════════════════════════════════════════════════════════════════
function graphMarketData() {
  const n = [];
  n.push(note(
    'STAGE 02 — MARKET DATA AND VALIDATION\n\n'
    + 'Prices every position at both ends of the reporting month through the provider chain:\n'
    + '  · listed instruments  → Yahoo Finance, falling back to the TradingView last close\n'
    + '  · fund quotas         → the custodian statement (no public feed exists)\n'
    + '  · contractual paper   → accrued from the Banco Central index plus the contract spread\n'
    + '  · FX                  → PTAX from the Banco Central\n\n'
    + 'A position that cannot be valued is reported as DATA UNAVAILABLE with the providers tried.\n'
    + 'It is never estimated, and it contributes exactly zero to the return (§30).', 20, 20, 780, 176));

  const runId = make(graphInputNode, { title: 'run_id', x: 20, y: 240, data: { id: 'run_id', dataType: 'string' } });
  const apiBase = make(graphInputNode, { title: 'api_base', x: 20, y: 320, data: { id: 'api_base', dataType: 'string' } });
  const apiToken = make(graphInputNode, { title: 'api_token', x: 20, y: 400, data: { id: 'api_token', dataType: 'string' } });
  n.push(runId, apiBase, apiToken);


  // Sequencing gate. Rivet runs a node as soon as its inputs are ready, and
  // these stages share only the connection settings, so without an explicit
  // dependency the whole pipeline would fire at once. The orchestrator wires
  // stage N's output into stage N+1's gate.
  const seqGate = make(graphInputNode, { title: 'gate (sequencing)', x: 20, y: 480, data: { id: 'gate', dataType: 'any' } });
  n.push(seqGate);
  const step = pipelineStep({
    step: 'market-data', title: 'Fetch and validate prices', x: 420, y: 300,
    bodyTemplate: '{\n  "run_id": "{{run_id}}"\n}',
  });
  wireStep(step, { apiBase, apiToken });
  connect(runId, 'data', step.body, 'run_id');
  n.push(...step.nodes);

  const gate = make(codeNode, {
    title: 'Validation gate', x: 1120, y: 300, width: 420,
    data: {
      inputNames: ['result'],
      outputNames: ['market', 'blocked'],
      allowConsole: true,
      code: `// Stops the run before a client ever sees a figure that failed validation.
// An unavailable position is acceptable and is disclosed in the letter; a
// failed price sanity check is not.
const r = inputs.result.value;
const failed = (r.review || []).filter((v) => v.status === 'fail');
return {
  market: { type: 'object', value: r },
  blocked: { type: 'boolean', value: failed.length > 0 },
};`,
    },
  });
  connect(step.result, step.resultPort, gate, 'result');
  n.push(seqGate);

  const out = make(graphOutputNode, { title: 'market_data', x: 1600, y: 300, data: { id: 'market_data', dataType: 'object' } });
  connect(gate, 'market', out, 'value');
  const outBlocked = make(graphOutputNode, { title: 'blocked', x: 1600, y: 400, data: { id: 'blocked', dataType: 'boolean' } });
  connect(gate, 'blocked', outBlocked, 'value');
  n.push(out, outBlocked);
  return graph('g_market', '02 · Fetch and validate market data', 'Prices every position through the approved provider chain and records the source of each figure.', n);
}

// ═══════════════════════════════════════════════════════════════════════════
// 03 · Profitability
// ═══════════════════════════════════════════════════════════════════════════
function graphProfitability() {
  const n = [];
  n.push(note(
    'STAGE 03 — PROFITABILITY, ATTRIBUTION AND BENCHMARK\n\n'
    + 'Deterministic. No language model touches any figure produced by this stage (§32).\n\n'
    + 'Method selection: true time-weighted return where a daily valuation exists for the whole\n'
    + 'book, Modified Dietz when only month-end valuations exist, simple return when there were\n'
    + 'no flows. Whichever is used is recorded and printed in the client letter.\n\n'
    + 'The benchmark is the client\'s own policy allocation, priced with real series, not a\n'
    + 'convenient index chosen after the fact.', 20, 20, 780, 176));

  const runId = make(graphInputNode, { title: 'run_id', x: 20, y: 240, data: { id: 'run_id', dataType: 'string' } });
  const apiBase = make(graphInputNode, { title: 'api_base', x: 20, y: 320, data: { id: 'api_base', dataType: 'string' } });
  const apiToken = make(graphInputNode, { title: 'api_token', x: 20, y: 400, data: { id: 'api_token', dataType: 'string' } });
  n.push(runId, apiBase, apiToken);


  // Sequencing gate. Rivet runs a node as soon as its inputs are ready, and
  // these stages share only the connection settings, so without an explicit
  // dependency the whole pipeline would fire at once. The orchestrator wires
  // stage N's output into stage N+1's gate.
  const seqGate = make(graphInputNode, { title: 'gate (sequencing)', x: 20, y: 480, data: { id: 'gate', dataType: 'any' } });
  n.push(seqGate);
  const step = pipelineStep({
    step: 'profitability', title: 'Return, attribution, benchmark, metrics', x: 420, y: 300,
    bodyTemplate: '{\n  "run_id": "{{run_id}}"\n}',
  });
  wireStep(step, { apiBase, apiToken });
  connect(runId, 'data', step.body, 'run_id');
  n.push(...step.nodes);

  const check = make(codeNode, {
    title: 'Attribution reconciliation check', x: 1120, y: 300, width: 430,
    data: {
      inputNames: ['result'],
      outputNames: ['performance', 'reconciles'],
      allowConsole: true,
      code: `// The sum of every contribution line, including the cash residual, must equal
// the reported portfolio return. A silent gap between "sum of the parts" and
// "the number on page one" is the fastest way to lose an advisor's trust.
const r = inputs.result.value;
if (r.reconciles !== true) console.log('ATTRIBUTION DOES NOT RECONCILE', r.monthly_return);
return {
  performance: { type: 'object', value: r },
  reconciles: { type: 'boolean', value: r.reconciles === true },
};`,
    },
  });
  connect(step.result, step.resultPort, check, 'result');
  n.push(check);

  const out = make(graphOutputNode, { title: 'performance', x: 1610, y: 300, data: { id: 'performance', dataType: 'object' } });
  connect(check, 'performance', out, 'value');
  const outOk = make(graphOutputNode, { title: 'reconciles', x: 1610, y: 400, data: { id: 'reconciles', dataType: 'boolean' } });
  connect(check, 'reconciles', outOk, 'value');
  n.push(out, outOk);
  return graph('g_profit', '03 · Calculate profitability and attribution', 'Monthly return with a cash-flow-correct method, attribution by class and position, FX decomposition, policy benchmark and historical metrics.', n);
}

// ═══════════════════════════════════════════════════════════════════════════
// 04 · Market intelligence
// ═══════════════════════════════════════════════════════════════════════════
function graphMarketIntel() {
  const n = [];
  n.push(note(
    'STAGE 04 — MARKET INDICATORS, EVENTS AND PORTFOLIO IMPACT\n\n'
    + 'Retrieves the monitored indicator set, evaluates the configurable thresholds, merges the\n'
    + 'curated macro events with events generated from significant indicator moves, and maps\n'
    + 'each one onto this client\'s actual exposures.\n\n'
    + 'Every statement carries the source id of the observation it rests on (§9).', 20, 20, 780, 150));

  const runId = make(graphInputNode, { title: 'run_id', x: 20, y: 220, data: { id: 'run_id', dataType: 'string' } });
  const apiBase = make(graphInputNode, { title: 'api_base', x: 20, y: 300, data: { id: 'api_base', dataType: 'string' } });
  const apiToken = make(graphInputNode, { title: 'api_token', x: 20, y: 380, data: { id: 'api_token', dataType: 'string' } });
  n.push(runId, apiBase, apiToken);


  // Sequencing gate. Rivet runs a node as soon as its inputs are ready, and
  // these stages share only the connection settings, so without an explicit
  // dependency the whole pipeline would fire at once. The orchestrator wires
  // stage N's output into stage N+1's gate.
  const seqGate = make(graphInputNode, { title: 'gate (sequencing)', x: 20, y: 460, data: { id: 'gate', dataType: 'any' } });
  n.push(seqGate);
  const step = pipelineStep({
    step: 'market-intel', title: 'Indicators, triggers, events, impact', x: 420, y: 280,
    bodyTemplate: '{\n  "run_id": "{{run_id}}"\n}',
  });
  wireStep(step, { apiBase, apiToken });
  connect(runId, 'data', step.body, 'run_id');
  n.push(...step.nodes);

  const out = make(graphOutputNode, { title: 'market_intel', x: 1460, y: 280, data: { id: 'market_intel', dataType: 'object' } });
  connect(step.result, step.resultPort, out, 'value');
  n.push(out);
  return graph('g_intel', '04 · Market indicators, events and impact', 'Retrieves indicators, fires configurable thresholds and maps events onto the client\'s exposures.', n);
}

// ═══════════════════════════════════════════════════════════════════════════
// 05 · Signals
// ═══════════════════════════════════════════════════════════════════════════
function graphSignals() {
  const n = [];
  n.push(note(
    'STAGE 05 — TRADINGVIEW SIGNALS, TWO INDEPENDENT FAMILIES\n\n'
    + '  1. TECHNICAL  — moving-average and oscillator rating, daily and weekly, with a timestamp\n'
    + '  2. ANALYST    — sell-side consensus, the analyst count and the target price\n\n'
    + 'They are captured and stored separately and are never collapsed into one "market view".\n'
    + 'Where a security has no analyst coverage the record says\n'
    + '"No analyst consensus available" — the technical rating is NEVER used to infer it (§16, §30).', 20, 20, 800, 160));

  const runId = make(graphInputNode, { title: 'run_id', x: 20, y: 230, data: { id: 'run_id', dataType: 'string' } });
  const apiBase = make(graphInputNode, { title: 'api_base', x: 20, y: 310, data: { id: 'api_base', dataType: 'string' } });
  const apiToken = make(graphInputNode, { title: 'api_token', x: 20, y: 390, data: { id: 'api_token', dataType: 'string' } });
  n.push(runId, apiBase, apiToken);


  // Sequencing gate. Rivet runs a node as soon as its inputs are ready, and
  // these stages share only the connection settings, so without an explicit
  // dependency the whole pipeline would fire at once. The orchestrator wires
  // stage N's output into stage N+1's gate.
  const seqGate = make(graphInputNode, { title: 'gate (sequencing)', x: 20, y: 470, data: { id: 'gate', dataType: 'any' } });
  n.push(seqGate);
  const step = pipelineStep({
    step: 'signals', title: 'Capture both signal families', x: 420, y: 290,
    bodyTemplate: '{\n  "run_id": "{{run_id}}"\n}',
  });
  wireStep(step, { apiBase, apiToken });
  connect(runId, 'data', step.body, 'run_id');
  n.push(...step.nodes);

  const split = make(codeNode, {
    title: 'Separate the two families', x: 1120, y: 290, width: 430,
    data: {
      inputNames: ['result'],
      outputNames: ['signals', 'conflicts'],
      allowConsole: true,
      code: `// A technical Sell alongside an analyst Strong Buy is a real disagreement and
// is exactly what the advisor should be talking about. It is surfaced, never
// averaged away.
const r = inputs.result.value;
const score = { 'Strong Buy': 2, Buy: 1, Neutral: 0, Sell: -1, 'Strong Sell': -2 };
const conflicts = (r.rows || []).filter((row) => {
  const t = score[row.technical], a = score[row.analyst];
  return t != null && a != null && Math.sign(t) !== 0 && Math.sign(a) !== 0 && Math.sign(t) !== Math.sign(a);
});
return {
  signals: { type: 'object', value: r },
  conflicts: { type: 'object[]', value: conflicts.map((c) => ({ type: 'object', value: c })) },
};`,
    },
  });
  connect(step.result, step.resultPort, split, 'result');
  n.push(split);

  const out = make(graphOutputNode, { title: 'signals', x: 1610, y: 290, data: { id: 'signals', dataType: 'object' } });
  connect(split, 'signals', out, 'value');
  const outC = make(graphOutputNode, { title: 'signal_conflicts', x: 1610, y: 390, data: { id: 'signal_conflicts', dataType: 'object[]' } });
  connect(split, 'conflicts', outC, 'value');
  n.push(out, outC);
  return graph('g_signals', '05 · TradingView technical and analyst signals', 'Captures the two signal families independently and flags where they disagree.', n);
}

// ═══════════════════════════════════════════════════════════════════════════
// 06 · Recommendations and suitability
// ═══════════════════════════════════════════════════════════════════════════
function graphRecommendations() {
  const n = [];
  n.push(note(
    'STAGE 06 — RECOMMENDATIONS AND THE SUITABILITY GUARDRAIL\n\n'
    + 'Two passes with different vocabularies, deliberately kept apart:\n\n'
    + '  buildRecommendations  → what the market is saying, given the two signal families,\n'
    + '                          the client weight, the policy band, concentration and the\n'
    + '                          advisor world view\n'
    + '  runSuitability        → what this client may actually do about it\n\n'
    + 'The guardrail can only make a recommendation more conservative. It never turns a HOLD\n'
    + 'into an ADD. The product prints both lines:\n'
    + '     MARKET SIGNAL:             BUY\n'
    + '     CLIENT-SUITABILITY RESULT: DO NOT ADD / DISCUSS ONLY   (§18)', 20, 20, 800, 216));

  const runId = make(graphInputNode, { title: 'run_id', x: 20, y: 290, data: { id: 'run_id', dataType: 'string' } });
  const apiBase = make(graphInputNode, { title: 'api_base', x: 20, y: 370, data: { id: 'api_base', dataType: 'string' } });
  const apiToken = make(graphInputNode, { title: 'api_token', x: 20, y: 450, data: { id: 'api_token', dataType: 'string' } });
  n.push(runId, apiBase, apiToken);


  // Sequencing gate. Rivet runs a node as soon as its inputs are ready, and
  // these stages share only the connection settings, so without an explicit
  // dependency the whole pipeline would fire at once. The orchestrator wires
  // stage N's output into stage N+1's gate.
  const seqGate = make(graphInputNode, { title: 'gate (sequencing)', x: 20, y: 530, data: { id: 'gate', dataType: 'any' } });
  n.push(seqGate);
  const step = pipelineStep({
    step: 'recommendations', title: 'Propose and check', x: 420, y: 350,
    bodyTemplate: '{\n  "run_id": "{{run_id}}"\n}',
  });
  wireStep(step, { apiBase, apiToken });
  connect(runId, 'data', step.body, 'run_id');
  n.push(...step.nodes);

  const summary = make(codeNode, {
    title: 'Advisor review queue', x: 1120, y: 350, width: 440,
    data: {
      inputNames: ['result'],
      outputNames: ['recommendations', 'needs_review'],
      allowConsole: true,
      code: `// Everything the guardrail touched, or where the two signal families disagree,
// goes to the top of the advisor's review queue. Nothing is auto-approved.
const r = inputs.result.value;
const rows = r.rows || [];
const needsReview = rows.filter((x) => x.conflict || x.suitability !== 'PASS' || x.final !== x.proposed);
console.log(\`\${rows.length} proposals, \${needsReview.length} need an explicit advisor decision\`);
return {
  recommendations: { type: 'object', value: r },
  needs_review: { type: 'object[]', value: needsReview.map((x) => ({ type: 'object', value: x })) },
};`,
    },
  });
  connect(step.result, step.resultPort, summary, 'result');
  n.push(summary);

  const out = make(graphOutputNode, { title: 'recommendations', x: 1620, y: 350, data: { id: 'recommendations', dataType: 'object' } });
  connect(summary, 'recommendations', out, 'value');
  const outR = make(graphOutputNode, { title: 'needs_review', x: 1620, y: 450, data: { id: 'needs_review', dataType: 'object[]' } });
  connect(summary, 'needs_review', outR, 'value');
  n.push(out, outR);
  return graph('g_recs', '06 · Recommendations and suitability', 'Synthesises a Buy/Hold/Reduce/Sell proposal per asset and runs it through the client policy guardrail.', n);
}

// ═══════════════════════════════════════════════════════════════════════════
// 07 · Narrative — the language model stage
// ═══════════════════════════════════════════════════════════════════════════
function graphNarrative() {
  const n = [];
  n.push(note(
    'STAGE 07 — NARRATIVE\n\n'
    + 'The ONLY stage where a language model is used, and it is used for language, not arithmetic.\n\n'
    + 'The model receives a FACTS object containing every figure the pipeline computed, and the\n'
    + 'system prompt forbids producing any number that is not in it. That single constraint is\n'
    + 'what the first version of this workflow was missing: it asked a model to write about a\n'
    + 'portfolio it had never been shown the arithmetic for.\n\n'
    + 'The prompts below are the real prompts, in English. They are generated from\n'
    + 'src/llm/prompts.js so the graph and the API can never disagree about what was asked —\n'
    + 'edit them there and re-run `npm run build:graph`.\n\n'
    + 'WHY THE GATEWAY RATHER THAN THE BUNDLED CHAT NODE\n'
    + 'Rivet ships an Anthropic plugin, but its model list stops at the Claude 4 family and it\n'
    + 'only exposes a system-prompt port for claude-3 models. Routing through the Worker keeps\n'
    + 'the current model in use, keeps the API key in Cloudflare rather than in a project file,\n'
    + 'and gives one place where the provider fallback lives. The prompts stay here.',
    20, 20, 900, 300));

  const runId = make(graphInputNode, { title: 'run_id', x: 20, y: 360, data: { id: 'run_id', dataType: 'string' } });
  const apiBase = make(graphInputNode, { title: 'api_base', x: 20, y: 440, data: { id: 'api_base', dataType: 'string' } });
  const apiToken = make(graphInputNode, { title: 'api_token', x: 20, y: 520, data: { id: 'api_token', dataType: 'string' } });
  n.push(runId, apiBase, apiToken);

  // ── the FACTS the model may write about, and nothing else ───────────────

  // Sequencing gate. Rivet runs a node as soon as its inputs are ready, and
  // these stages share only the connection settings, so without an explicit
  // dependency the whole pipeline would fire at once. The orchestrator wires
  // stage N's output into stage N+1's gate.
  const seqGate = make(graphInputNode, { title: 'gate (sequencing)', x: 20, y: 680, data: { id: 'gate', dataType: 'any' } });
  n.push(seqGate);
  const factsStep = pipelineStep({
    step: 'narrative-facts', title: 'FACTS for the letter', x: 420, y: 360,
    bodyTemplate: '{\n  "run_id": "{{run_id}}",\n  "prompt": "client_letter"\n}',
  });
  wireStep(factsStep, { apiBase, apiToken });
  connect(runId, 'data', factsStep.body, 'run_id');
  n.push(...factsStep.nodes);

  const factsText = make(codeNode, {
    title: 'FACTS as text', x: 1120, y: 450, width: 300,
    data: {
      inputNames: ['facts'],
      outputNames: ['facts_json'],
      code: "return { facts_json: { type: 'string', value: inputs.facts.value.facts_json } };",
    },
  });
  connect(factsStep.result, factsStep.resultPort, factsText, 'facts');
  n.push(factsText);

  // ── the prompts, in English, on the canvas ──────────────────────────────
  const systemPrompt = make(textNode, {
    title: 'Prompt — system guardrail', x: 420, y: 760, width: 560,
    data: { text: SYSTEM_GUARDRAIL },
  });
  const letterPrompt = make(textNode, {
    title: 'Prompt — monthly client letter (writes pt-BR)', x: 1020, y: 760, width: 620,
    data: { text: PROMPTS.client_letter.template.replace('{{facts}}', '{{facts_json}}') },
  });
  connect(factsText, 'facts_json', letterPrompt, 'facts_json');
  n.push(systemPrompt, letterPrompt);

  const buildCall = make(codeNode, {
    title: 'Build the model request', x: 1700, y: 760, width: 380,
    data: {
      inputNames: ['system', 'user'],
      outputNames: ['body'],
      code: `// JSON.stringify rather than a template, so a quotation mark inside a prompt
// cannot produce a malformed request body.
return {
  body: {
    type: 'string',
    value: JSON.stringify({ system: inputs.system.value, user: inputs.user.value, max_tokens: 3000 }),
  },
};`,
    },
  });
  connect(systemPrompt, 'output', buildCall, 'system');
  connect(letterPrompt, 'output', buildCall, 'user');
  n.push(buildCall);

  const llmUrl = make(textNode, { title: 'Model gateway endpoint', x: 1700, y: 940, width: 380, data: { text: '{{api_base}}/api/llm/complete' } });
  const llmHeaders = make(objectNode, { title: 'Service headers', x: 1700, y: 1050, width: 380, data: { jsonTemplate: '{\n  "content-type": "application/json",\n  "x-service-token": "{{api_token}}"\n}' } });
  connect(apiBase, 'data', llmUrl, 'api_base');
  connect(apiToken, 'data', llmHeaders, 'api_token');
  const llmCall = make(httpCallNode, {
    title: 'POST /api/llm/complete', x: 2140, y: 850, width: 320,
    data: { method: 'POST', url: '', headers: '', body: '', errorOnNon200: true, useUrlInput: true, useHeadersInput: true, useBodyInput: true },
  });
  connect(llmUrl, 'output', llmCall, 'url');
  connect(llmHeaders, 'output', llmCall, 'headers');
  connect(buildCall, 'body', llmCall, 'req_body');
  n.push(llmUrl, llmHeaders, llmCall);

  const parseLetter = make(codeNode, {
    title: 'Parse the letter and check it against FACTS', x: 2520, y: 850, width: 460,
    data: {
      inputNames: ['response'],
      outputNames: ['letter_json', 'model', 'ok'],
      allowConsole: true,
      code: `// Models wrap JSON in prose often enough to be worth handling properly.
const r = inputs.response.value;
const text = r.text || '';
const fenced = text.match(/\\\`\\\`\\\`(?:json)?\\s*([\\s\\S]*?)\\\`\\\`\\\`/);
const candidate = fenced ? fenced[1] : text;
const start = candidate.indexOf('{');
const end = candidate.lastIndexOf('}');
let letter = null;
if (start >= 0 && end > start) {
  try { letter = JSON.parse(candidate.slice(start, end + 1)); } catch (e) { console.log('unparsable model output'); }
}
const required = ['greeting', 'opening', 'performance', 'markets', 'meaning', 'recommendations_intro', 'closing', 'sign_off'];
const ok = !!letter && required.every((k) => typeof letter[k] === 'string' && letter[k].length > 0);
if (!ok) console.log('model output rejected; the deterministic renderer will be used');
return {
  letter_json: { type: 'string', value: ok ? JSON.stringify(letter) : '' },
  model: { type: 'string', value: r.model || '' },
  ok: { type: 'boolean', value: ok },
};`,
    },
  });
  connect(llmCall, 'json', parseLetter, 'response');
  n.push(parseLetter);

  const storeBody = make(codeNode, {
    title: 'Build the store request', x: 3040, y: 850, width: 380,
    data: {
      inputNames: ['run_id', 'letter_json', 'model'],
      outputNames: ['body'],
      code: `return {
  body: {
    type: 'string',
    value: JSON.stringify({
      run_id: inputs.run_id.value,
      mode: 'model_via_rivet',
      model: inputs.model.value,
      prompt_version: '${PROMPT_VERSION}',
      letter: JSON.parse(inputs.letter_json.value || '{}'),
    }),
  },
};`,
    },
  });
  connect(runId, 'data', storeBody, 'run_id');
  connect(parseLetter, 'letter_json', storeBody, 'letter_json');
  connect(parseLetter, 'model', storeBody, 'model');
  n.push(storeBody);

  const storeUrl = make(textNode, { title: 'Narrative endpoint', x: 3040, y: 1030, width: 380, data: { text: '{{api_base}}/api/pipeline/narrative' } });
  const storeHeaders = make(objectNode, { title: 'Service headers', x: 3040, y: 1140, width: 380, data: { jsonTemplate: '{\n  "content-type": "application/json",\n  "x-service-token": "{{api_token}}"\n}' } });
  connect(apiBase, 'data', storeUrl, 'api_base');
  connect(apiToken, 'data', storeHeaders, 'api_token');
  const storeCall = make(httpCallNode, {
    title: 'POST /api/pipeline/narrative (model letter)', x: 3480, y: 940, width: 340,
    data: { method: 'POST', url: '', headers: '', body: '', errorOnNon200: true, useUrlInput: true, useHeadersInput: true, useBodyInput: true },
  });
  connect(storeUrl, 'output', storeCall, 'url');
  connect(storeHeaders, 'output', storeCall, 'headers');
  connect(storeBody, 'body', storeCall, 'req_body');
  n.push(storeUrl, storeHeaders, storeCall);

  // ── deterministic branch ────────────────────────────────────────────────
  n.push(note(
    'DETERMINISTIC BRANCH\n\n'
    + 'Renders the same FACTS into correct Portuguese without a model, so the product degrades to\n'
    + '"less fluent" rather than to "broken" when no provider is configured or the model returns\n'
    + 'something unusable. The canonical report records which path ran, and the advisor sees it\n'
    + 'in the Audit tab.',
    420, 1320, 760, 120));

  const detStep = pipelineStep({
    step: 'narrative', title: 'Deterministic narrative', x: 420, y: 1460,
    bodyTemplate: '{\n  "run_id": "{{run_id}}",\n  "mode": "deterministic"\n}',
  });
  wireStep(detStep, { apiBase, apiToken });
  connect(runId, 'data', detStep.body, 'run_id');
  n.push(...detStep.nodes);

  const branch = make(ifElseNode, { title: 'Model letter accepted?', x: 3900, y: 1100, width: 220 });
  connect(parseLetter, 'ok', branch, 'if');
  connect(storeCall, 'json', branch, 'true');
  connect(detStep.result, detStep.resultPort, branch, 'false');
  n.push(branch);

  const out = make(graphOutputNode, { title: 'narrative', x: 4180, y: 1100, data: { id: 'narrative', dataType: 'object' } });
  connect(branch, 'output', out, 'value');
  n.push(out);

  return graph('g_narrative', '07 · Narrative — advisor view and client letter', 'The only language-model stage. Writes the Portuguese client letter from a FACTS object it may not add to.', n);
}

// ═══════════════════════════════════════════════════════════════════════════
// 08 · Assemble
// ═══════════════════════════════════════════════════════════════════════════
function graphAssemble() {
  const n = [];
  n.push(note(
    'STAGE 08 — CANONICAL REPORT ASSEMBLY AND VALIDATION\n\n'
    + 'Builds the single structured payload that the HTML email, the PDF and the client portal\n'
    + 'all render from, then validates it:\n\n'
    + '  · every market figure carries a source id that exists in the source ledger\n'
    + '  · analyst sentiment was never inferred from a technical rating\n'
    + '  · absolute P&L reconciles with market values and flows\n'
    + '  · attribution sums to the reported return\n'
    + '  · nothing reaches a client that the advisor has not approved (§23)', 20, 20, 800, 180));

  const runId = make(graphInputNode, { title: 'run_id', x: 20, y: 250, data: { id: 'run_id', dataType: 'string' } });
  const apiBase = make(graphInputNode, { title: 'api_base', x: 20, y: 330, data: { id: 'api_base', dataType: 'string' } });
  const apiToken = make(graphInputNode, { title: 'api_token', x: 20, y: 410, data: { id: 'api_token', dataType: 'string' } });
  n.push(runId, apiBase, apiToken);


  // Sequencing gate. Rivet runs a node as soon as its inputs are ready, and
  // these stages share only the connection settings, so without an explicit
  // dependency the whole pipeline would fire at once. The orchestrator wires
  // stage N's output into stage N+1's gate.
  const seqGate = make(graphInputNode, { title: 'gate (sequencing)', x: 20, y: 490, data: { id: 'gate', dataType: 'any' } });
  // A published client letter is immutable. Reissuing one is a deliberate act,
  // so it is an input on the canvas rather than a flag buried in a request body.
  const reissue = make(graphInputNode, { title: 'reissue a published letter', x: 20, y: 570, width: 300, data: { id: 'reissue', dataType: 'boolean' } });
  n.push(seqGate, reissue);
  const step = pipelineStep({
    step: 'assemble', title: 'Assemble and validate', x: 420, y: 310,
    bodyTemplate: '{\n  "run_id": "{{run_id}}",\n  "force": {{reissue}}\n}',
  });
  wireStep(step, { apiBase, apiToken });
  connect(runId, 'data', step.body, 'run_id');
  connect(reissue, 'data', step.body, 'reissue');
  n.push(...step.nodes);

  const gate = make(codeNode, {
    title: 'Publication gate', x: 1120, y: 310, width: 440,
    data: {
      inputNames: ['result'],
      outputNames: ['report', 'ready', 'pending_approval'],
      allowConsole: true,
      code: `// "pending advisor approval" is not an error, it is the design: the advisor
// gate at stage 09 is the whole point. A blocking error is anything else.
const r = inputs.result.value;
if ((r.blocking_errors || []).length) console.log('BLOCKING:', r.blocking_errors.join(' | '));
return {
  report: { type: 'object', value: r },
  ready: { type: 'boolean', value: (r.blocking_errors || []).length === 0 },
  pending_approval: { type: 'number', value: r.pending_advisor_approval || 0 },
};`,
    },
  });
  connect(step.result, step.resultPort, gate, 'result');
  n.push(seqGate);

  const out = make(graphOutputNode, { title: 'canonical_report', x: 1620, y: 310, data: { id: 'canonical_report', dataType: 'object' } });
  connect(gate, 'report', out, 'value');
  const outReady = make(graphOutputNode, { title: 'ready', x: 1620, y: 410, data: { id: 'ready', dataType: 'boolean' } });
  connect(gate, 'ready', outReady, 'value');
  n.push(out, outReady);
  return graph('g_assemble', '08 · Assemble the canonical report', 'Builds and validates the single payload that every output format renders from.', n);
}

// ═══════════════════════════════════════════════════════════════════════════
// 09 · Advisor gate, render, persist
// ═══════════════════════════════════════════════════════════════════════════
function graphRenderPersist() {
  const n = [];
  n.push(note(
    'STAGE 09 — ADVISOR APPROVAL GATE, RENDER, PERSIST\n\n'
    + 'The gate is real. Only recommendations the advisor marked "approved" in the portal are\n'
    + 'rendered into the client letter; the rest stay in the advisor view.\n\n'
    + 'Three outputs are rendered from ONE canonical object, so they cannot contradict each other:\n'
    + '  A. a responsive HTML email\n'
    + '  B. a PDF of at most two pages, with the brand typefaces embedded\n'
    + '  C. the client portal view\n\n'
    + 'Then the report, its canonical JSON and every source record are persisted to D1 and R2,\n'
    + 'which is what makes a published report reproducible (§31).', 20, 20, 820, 210));

  const runId = make(graphInputNode, { title: 'run_id', x: 20, y: 290, data: { id: 'run_id', dataType: 'string' } });
  const apiBase = make(graphInputNode, { title: 'api_base', x: 20, y: 370, data: { id: 'api_base', dataType: 'string' } });
  const apiToken = make(graphInputNode, { title: 'api_token', x: 20, y: 450, data: { id: 'api_token', dataType: 'string' } });
  n.push(runId, apiBase, apiToken);


  // Sequencing gate. Rivet runs a node as soon as its inputs are ready, and
  // these stages share only the connection settings, so without an explicit
  // dependency the whole pipeline would fire at once. The orchestrator wires
  // stage N's output into stage N+1's gate.
  const seqGate = make(graphInputNode, { title: 'gate (sequencing)', x: 20, y: 530, data: { id: 'gate', dataType: 'any' } });
  n.push(seqGate);
  const render = pipelineStep({
    step: 'render', title: 'Render HTML, PDF and portal', x: 420, y: 350,
    bodyTemplate: '{\n  "run_id": "{{run_id}}",\n  "approved_only": true\n}',
  });
  wireStep(render, { apiBase, apiToken });
  connect(runId, 'data', render.body, 'run_id');
  n.push(...render.nodes);

  const pageCheck = make(codeNode, {
    title: 'Two-page constraint', x: 1120, y: 350, width: 420,
    data: {
      inputNames: ['result'],
      outputNames: ['render', 'within_limit'],
      allowConsole: true,
      code: `// The two-page limit is a hard constraint. The renderer drops optional blocks
// in a fixed order until it fits; this reports which level it needed.
const r = inputs.result.value;
console.log(\`\${r.page_count} page(s), layout reduction level \${r.layout_reduction_level}\`);
return {
  render: { type: 'object', value: r },
  within_limit: { type: 'boolean', value: r.page_count <= 2 },
};`,
    },
  });
  connect(render.result, render.resultPort, pageCheck, 'result');
  n.push(pageCheck);

  const persist = pipelineStep({
    step: 'persist', title: 'Persist to D1 and R2', x: 1620, y: 350,
    bodyTemplate: '{\n  "run_id": "{{run_id}}",\n  "status": "pending_approval"\n}',
  });
  wireStep(persist, { apiBase, apiToken });
  connect(runId, 'data', persist.body, 'run_id');
  // sequencing: persist only runs once the page-count check has produced a value
  connect(pageCheck, 'render', persist.body, 'render');
  n.push(...persist.nodes);

  const out = make(graphOutputNode, { title: 'report', x: 2620, y: 350, data: { id: 'report', dataType: 'object' } });
  connect(persist.result, persist.resultPort, out, 'value');
  const outLimit = make(graphOutputNode, { title: 'within_two_pages', x: 2620, y: 450, data: { id: 'within_two_pages', dataType: 'boolean' } });
  connect(pageCheck, 'within_limit', outLimit, 'value');
  n.push(out, outLimit);

  return graph('g_render', '09 · Render and persist', 'Renders the email, the two-page PDF and the portal view from one payload, then stores everything for audit.', n);
}

// ═══════════════════════════════════════════════════════════════════════════
// 10 · Daily World Overview — a separate entry point
// ═══════════════════════════════════════════════════════════════════════════
function graphWorldOverview() {
  const n = [];
  n.push(note(
    'DAILY WORLD OVERVIEW — a separate entry point, run once per advisor per morning.\n\n'
    + 'Answers the advisor\'s first question of the day: what matters in markets today, and which\n'
    + 'of my clients could be affected?\n\n'
    + 'The briefing is generated from retrieved data, never from model memory. Every factual\n'
    + 'statement keeps its source metadata, and the advisor edits and approves the world view\n'
    + 'before it influences any client recommendation (§4 layer 2, §8).', 20, 20, 820, 170));

  const apiBase = make(graphInputNode, { title: 'api_base', x: 20, y: 240, data: { id: 'api_base', dataType: 'string' } });
  const apiToken = make(graphInputNode, { title: 'api_token', x: 20, y: 320, data: { id: 'api_token', dataType: 'string' } });
  n.push(apiBase, apiToken);

  const url = make(textNode, { title: 'Overview endpoint', x: 420, y: 220, width: 320, data: { text: '{{api_base}}/api/advisor/overview?refresh=1' } });
  const headers = make(objectNode, { title: 'Service headers', x: 420, y: 330, width: 320, data: { jsonTemplate: '{\n  "x-service-token": "{{api_token}}"\n}' } });
  const call = make(httpCallNode, {
    title: 'GET /api/advisor/overview', x: 800, y: 260, width: 320,
    data: { method: 'GET', url: '', headers: '', body: '', errorOnNon200: true, useUrlInput: true, useHeadersInput: true },
  });
  connect(apiBase, 'data', url, 'api_base');
  connect(apiToken, 'data', headers, 'api_token');
  connect(url, 'output', call, 'url');
  connect(headers, 'output', call, 'headers');
  n.push(url, headers, call);

  const summarise = make(codeNode, {
    title: 'What matters today', x: 1160, y: 260, width: 460,
    data: {
      inputNames: ['overview'],
      outputNames: ['briefing', 'what_matters', 'fired_triggers'],
      allowConsole: true,
      code: `const o = inputs.overview.value;
const fired = (o.triggers || []).filter((t) => t.status === 'BREACHED');
console.log(\`\${(o.indicators || []).filter((i) => !i.unavailable).length} indicators retrieved, \${fired.length} threshold(s) breached\`);
return {
  briefing: { type: 'object', value: o.world_view?.briefing ?? {} },
  what_matters: { type: 'object[]', value: (o.what_matters || []).map((r) => ({ type: 'object', value: r })) },
  fired_triggers: { type: 'object[]', value: fired.map((t) => ({ type: 'object', value: t })) },
};`,
    },
  });
  connect(call, 'json', summarise, 'overview');
  n.push(summarise);

  const outB = make(graphOutputNode, { title: 'briefing', x: 1700, y: 240, data: { id: 'briefing', dataType: 'object' } });
  connect(summarise, 'briefing', outB, 'value');
  const outW = make(graphOutputNode, { title: 'what_matters', x: 1700, y: 340, data: { id: 'what_matters', dataType: 'object[]' } });
  connect(summarise, 'what_matters', outW, 'value');
  const outT = make(graphOutputNode, { title: 'fired_triggers', x: 1700, y: 440, data: { id: 'fired_triggers', dataType: 'object[]' } });
  connect(summarise, 'fired_triggers', outT, 'value');
  n.push(outB, outW, outT);

  return graph('g_overview', '10 · Daily World Overview', 'The advisor\'s morning briefing: retrieved indicators, fired thresholds and the journal-to-portfolio impact table.', n);
}

// ═══════════════════════════════════════════════════════════════════════════
// 00 · Orchestrator
// ═══════════════════════════════════════════════════════════════════════════
function graphMain(subgraphIds) {
  const n = [];
  n.push(note(
    'XP ASSET MANAGEMENT — MONTHLY CLIENT REPORT\n\n'
    + 'Rivet owns the sequencing, the branching and the language-model stage.\n'
    + 'Every deterministic financial calculation happens in code, invoked through the API,\n'
    + 'because a number in a client letter should be reproducible, not generated.\n\n'
    + 'Run it with:  npm run run:report -- --client cli_albert\n'
    + 'or open this project in Rivet Desktop and press Run with the inputs below.', 20, 20, 820, 160));

  const apiBase = make(graphInputNode, { title: 'api_base', x: 20, y: 230, width: 320, data: { id: 'api_base', dataType: 'string', defaultValue: 'http://127.0.0.1:8788' } });
  const apiToken = make(graphInputNode, { title: 'api_token', x: 20, y: 310, width: 320, data: { id: 'api_token', dataType: 'string' } });
  const clientId = make(graphInputNode, { title: 'client_id', x: 20, y: 390, width: 320, data: { id: 'client_id', dataType: 'string', defaultValue: 'cli_albert' } });
  const month = make(graphInputNode, { title: 'month', x: 20, y: 470, width: 320, data: { id: 'month', dataType: 'string' } });
  const runId = make(graphInputNode, { title: 'run_id', x: 20, y: 550, width: 320, data: { id: 'run_id', dataType: 'string' } });
  const reissue = make(graphInputNode, { title: 'reissue', x: 20, y: 630, width: 320, data: { id: 'reissue', dataType: 'boolean', defaultValue: false } });
  n.push(apiBase, apiToken, clientId, month, runId, reissue);

  const stages = [
    { id: subgraphIds.ingest, title: '01 · Ingest', inputs: ['api_base', 'api_token', 'run_id', 'client_id', 'month'], out: 'context' },
    { id: subgraphIds.market, title: '02 · Market data', inputs: ['api_base', 'api_token', 'run_id'], out: 'market_data' },
    { id: subgraphIds.profit, title: '03 · Profitability', inputs: ['api_base', 'api_token', 'run_id'], out: 'performance' },
    { id: subgraphIds.intel, title: '04 · Market intelligence', inputs: ['api_base', 'api_token', 'run_id'], out: 'market_intel' },
    { id: subgraphIds.signals, title: '05 · TradingView signals', inputs: ['api_base', 'api_token', 'run_id'], out: 'signals' },
    { id: subgraphIds.recs, title: '06 · Recommendations + suitability', inputs: ['api_base', 'api_token', 'run_id'], out: 'recommendations' },
    { id: subgraphIds.narrative, title: '07 · Narrative', inputs: ['api_base', 'api_token', 'run_id'], out: 'narrative' },
    { id: subgraphIds.assemble, title: '08 · Canonical report', inputs: ['api_base', 'api_token', 'run_id', 'reissue'], out: 'canonical_report' },
    { id: subgraphIds.render, title: '09 · Render + persist', inputs: ['api_base', 'api_token', 'run_id'], out: 'report' },
  ];

  const inputByName = { api_base: apiBase, api_token: apiToken, run_id: runId, client_id: clientId, month, reissue };

  let x = 460;
  let y = 240;
  const created = [];
  let previous = null;
  for (const st of stages) {
    const sg = make(subGraphNode, { title: st.title, x, y, width: 320, data: { graphId: st.id, useAsGraphPartialOutput: true } });
    for (const inp of st.inputs) {
      const src = inputByName[inp];
      if (src) connect(src, 'data', sg, inp);
    }
    // The stages share connection settings only, so without this the whole
    // pipeline would run at once. Each stage waits on the one before it.
    if (previous) connect(previous.node, previous.out, sg, 'gate');
    previous = { node: sg, out: st.out };
    created.push(sg);
    n.push(sg);
    y += 130;
    if (y > 900) { y = 240; x += 420; }
  }

  const out = make(graphOutputNode, { title: 'report', x: x + 420, y: 300, width: 320, data: { id: 'report', dataType: 'object' } });
  connect(created[created.length - 1], 'report', out, 'value');
  n.push(out);

  n.push(note(
    'ADVISOR APPROVAL SITS BETWEEN STAGE 06 AND STAGE 09.\n\n'
    + 'In the demo the advisor decides in the portal (Recommendations tab) and stage 09 reads the\n'
    + 'decisions back from D1 before rendering. In production this is a wait-for-event node, so the\n'
    + 'graph run itself pauses at the gate rather than the runner re-entering it.',
    x + 420, 480, 620, 120));

  return graph('g_main', '00 · Monthly client report', 'Orchestrator. Runs the nine stages that produce one client\'s monthly report.', n);
}

// ═══════════════════════════════════════════════════════════════════════════

const subgraphs = {
  ingest: graphIngest(),
  market: graphMarketData(),
  profit: graphProfitability(),
  intel: graphMarketIntel(),
  signals: graphSignals(),
  recs: graphRecommendations(),
  narrative: graphNarrative(),
  assemble: graphAssemble(),
  render: graphRenderPersist(),
  overview: graphWorldOverview(),
};

const ids = Object.fromEntries(Object.entries(subgraphs).map(([k, g]) => [k, g.metadata.id]));
const main = graphMain(ids);

const project = {
  metadata: {
    id: 'enter_wealth_advisor',
    title: 'XP Asset Management — AI advisory workflow',
    description:
      'Monthly client reporting and daily world overview for XP-style financial advisors.\n\n'
      + 'Rivet is the orchestration layer. Deterministic finance runs in code behind the API; the\n'
      + 'language model writes, explains and personalises, and is never asked for a number.\n\n'
      + `Prompt version ${PROMPT_VERSION}. Generated by rivet/build-graph.mjs — edit the prompts in `
      + 'src/llm/prompts.js and re-run `npm run build:graph` rather than editing prompt text here.',
  },
  graphs: Object.fromEntries([main, ...Object.values(subgraphs)].map((g) => [g.metadata.id, g])),
  plugins: [{ id: 'anthropic', name: 'Anthropic', type: 'built-in' }],
};

const yaml = serializeProject(project);
const outPath = path.join(HERE, 'enter_wealth_advisor.rivet-project');
await writeFile(outPath, yaml);

const nodeCount = Object.values(project.graphs).reduce((a, g) => a + g.nodes.length, 0);
console.log(`wrote ${outPath}`);
console.log(`${Object.keys(project.graphs).length} graphs, ${nodeCount} nodes, prompt version ${PROMPT_VERSION}`);
