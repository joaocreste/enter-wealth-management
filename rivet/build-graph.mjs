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
  httpCallNode, codeNode, subGraphNode, commentNode, ifElseNode,
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
 * The two ports every stage needs to reach the API, and the one that decides
 * when it is allowed to.
 *
 * `headers` arrives as an object rather than being rebuilt from a token on each
 * canvas. Rivet's HTTP node takes an object straight on that port, the headers
 * are identical for all fourteen calls in the project, and the service token is
 * a connection setting the orchestrator owns — so it is assembled once, in `00`,
 * and passed down. That is thirteen nodes and eleven copies of the token that
 * are no longer drawn.
 *
 * `gate` carries the previous stage's result and is deliberately unused inside
 * the stage. Rivet runs a node as soon as its inputs are ready, and the stages
 * share only the connection settings, so without it the whole pipeline would
 * fire at once. The orchestrator wires stage N's output into stage N+1's gate.
 */
function connectionPorts(y = 100, { gate = true } = {}) {
  const apiBase = make(graphInputNode, { title: 'api_base', y, data: { id: 'api_base', dataType: 'string' } });
  const headers = make(graphInputNode, { title: 'service headers', y: y + 80, data: { id: 'headers', dataType: 'object' } });
  const nodes = [apiBase, headers];
  const seqGate = gate
    ? make(graphInputNode, { title: 'gate — runs after the stage before it', y: y + 400, data: { id: 'gate', dataType: 'any' } })
    : null;
  if (seqGate) nodes.push(seqGate);
  return { apiBase, headers, gate: seqGate, nodes };
}

/**
 * One deterministic pipeline step.
 *
 * A Text node builds the URL and a second builds the request body, because
 * Rivet's HTTP node interpolates nothing of its own — every field it needs
 * arrives on a port. Both are Text rather than Code so the endpoint and the
 * payload are legible on the canvas. The parsed JSON comes straight off the
 * node's `json` port. Financial arithmetic never happens in the graph.
 */
function pipelineStep({ step, y, bodyTemplate, title, method = 'POST', urlSuffix = '' }) {
  const url = make(textNode, {
    title: `${title} — endpoint`, y, width: 300,
    data: { text: `{{api_base}}/api/pipeline/${step}${urlSuffix}` },
  });
  const body = make(textNode, {
    title: `${title} — request body`, y: y + 240, width: 300,
    data: { text: bodyTemplate },
  });
  const call = make(httpCallNode, {
    title: `${method} /api/pipeline/${step}`, y: y + 90, width: 320,
    data: { method, url: '', headers: '', body: '', errorOnNon200: true, useUrlInput: true, useHeadersInput: true, useBodyInput: true },
  });
  connect(url, 'output', call, 'url');
  connect(body, 'output', call, 'req_body');
  return { url, body, call, result: call, resultPort: 'json', nodes: [url, body, call] };
}

/** Wires the connection ports into a step's URL and its call. */
function wireStep(step, { apiBase, headers }) {
  connect(apiBase, 'data', step.url, 'api_base');
  connect(headers, 'data', step.call, 'headers');
}

// ═══════════════════════════════════════════════════════════════════════════
// 01–06 · The deterministic stages
// ═══════════════════════════════════════════════════════════════════════════
/**
 * Six stages that differ in four things: the endpoint they call, what they
 * send, what they return, and what they refuse to let past. They were six
 * near-identical functions of fifty lines each; they are a table and one
 * builder now, so a seventh stage is a row rather than another fifty lines to
 * keep in step with the other six.
 *
 * A stage's `check` is a real gate. Where the check is a hard one it throws,
 * which fails the run inside the stage that found the problem — before the
 * stage after it starts, which is the only place a gate can do any good. Where
 * it is advisory it returns a list, the orchestrator collects it, and the
 * finished report carries it.
 */
const STAGES = [
  {
    id: 'g_ingest', name: '01 · Ingest client, policy and snapshot',
    description: 'Loads the approved client record, policy version, portfolio snapshot and the month\'s cash flows.',
    note: 'STAGE 01 — DATA INGESTION\n\n'
      + 'Loads the client, the approved Investment Policy version, the approved portfolio snapshot,\n'
      + 'its positions and the month\'s external cash flows.\n\n'
      + 'Nothing here is inferred. The snapshot is the advisor-approved record and is never\n'
      + 'modified by a market move (§4, layer 3).',
    noteSize: [720, 130],
    gate: false,
    step: 'context', stepTitle: 'Load client, policy and snapshot',
    inputs: [['client_id', 'string'], ['month', 'string']],
    body: '{\n  "run_id": "{{run_id}}",\n  "client_id": "{{client_id}}",\n  "month": "{{month}}"\n}',
    out: { id: 'context', dataType: 'object' },
  },
  {
    id: 'g_market', name: '02 · Fetch and validate market data',
    description: 'Prices every position through the approved provider chain and records the source of each figure.',
    note: 'STAGE 02 — MARKET DATA AND VALIDATION\n\n'
      + 'Prices every position at both ends of the reporting month through the provider chain:\n'
      + '  · listed instruments  → Yahoo Finance, falling back to the TradingView last close\n'
      + '  · fund quotas         → the custodian statement (no public feed exists)\n'
      + '  · contractual paper   → accrued from the Banco Central index plus the contract spread\n'
      + '  · FX                  → PTAX from the Banco Central\n\n'
      + 'A position that cannot be valued is reported as DATA UNAVAILABLE with the providers tried.\n'
      + 'It is never estimated, and it contributes exactly zero to the return (§30).',
    noteSize: [780, 176],
    step: 'market-data', stepTitle: 'Fetch and validate prices',
    body: '{\n  "run_id": "{{run_id}}"\n}',
    out: { id: 'market_data', dataType: 'object' },
    check: {
      title: 'Validation gate — stops the run', payload: 'market', width: 440,
      code: `// Stops the run before a client ever sees a figure that failed validation.
// An unavailable position is acceptable and is disclosed in the letter; a
// failed price sanity check is not, so this throws rather than reporting a
// verdict nothing downstream is obliged to read.
const r = inputs.result.value;
const failed = (r.review || []).filter((v) => v.status === 'fail');
if (failed.length) {
  throw new Error(\`stage 02: \${failed.length} position(s) failed price validation — \${failed.map((f) => f.symbol || f.position_id).join(', ')}\`);
}
return { market: { type: 'object', value: r } };`,
    },
  },
  {
    id: 'g_profit', name: '03 · Calculate profitability and attribution',
    description: 'Monthly return with a cash-flow-correct method, attribution by class and position, FX decomposition, policy benchmark and historical metrics.',
    note: 'STAGE 03 — PROFITABILITY, ATTRIBUTION AND BENCHMARK\n\n'
      + 'Deterministic. No language model touches any figure produced by this stage (§32).\n\n'
      + 'Method selection: true time-weighted return where a daily valuation exists for the whole\n'
      + 'book, Modified Dietz when only month-end valuations exist, simple return when there were\n'
      + 'no flows. Whichever is used is recorded and printed in the client letter.\n\n'
      + 'The benchmark is the client\'s own policy allocation, priced with real series, not a\n'
      + 'convenient index chosen after the fact.',
    noteSize: [780, 176],
    step: 'profitability', stepTitle: 'Return, attribution, benchmark, metrics',
    body: '{\n  "run_id": "{{run_id}}"\n}',
    out: { id: 'performance', dataType: 'object' },
    check: {
      title: 'Attribution reconciliation — stops the run', payload: 'performance', width: 440,
      code: `// The sum of every contribution line, including the cash residual, must equal
// the reported portfolio return. A silent gap between "sum of the parts" and
// "the number on page one" is the fastest way to lose an advisor's trust, so
// it stops the run here rather than reaching a letter.
const r = inputs.result.value;
if (r.reconciles !== true) {
  throw new Error(\`stage 03: attribution does not reconcile with the reported return \${r.monthly_return}\`);
}
return { performance: { type: 'object', value: r } };`,
    },
  },
  {
    id: 'g_intel', name: '04 · Market indicators, events and impact',
    description: 'Retrieves indicators, fires configurable thresholds and maps events onto the client\'s exposures.',
    note: 'STAGE 04 — MARKET INDICATORS, EVENTS AND PORTFOLIO IMPACT\n\n'
      + 'Retrieves the monitored indicator set, evaluates the configurable thresholds, merges the\n'
      + 'curated macro events with events generated from significant indicator moves, and maps\n'
      + 'each one onto this client\'s actual exposures.\n\n'
      + 'Every statement carries the source id of the observation it rests on (§9).',
    noteSize: [780, 150],
    step: 'market-intel', stepTitle: 'Indicators, triggers, events, impact',
    body: '{\n  "run_id": "{{run_id}}"\n}',
    out: { id: 'market_intel', dataType: 'object' },
  },
  {
    id: 'g_signals', name: '05 · TradingView technical and analyst signals',
    description: 'Captures the two signal families independently and flags where they disagree.',
    note: 'STAGE 05 — TRADINGVIEW SIGNALS, TWO INDEPENDENT FAMILIES\n\n'
      + '  1. TECHNICAL  — moving-average and oscillator rating, daily and weekly, with a timestamp\n'
      + '  2. ANALYST    — sell-side consensus, the analyst count and the target price\n\n'
      + 'They are captured and stored separately and are never collapsed into one "market view".\n'
      + 'Where a security has no analyst coverage the record says\n'
      + '"No analyst consensus available" — the technical rating is NEVER used to infer it (§16, §30).',
    noteSize: [800, 160],
    step: 'signals', stepTitle: 'Capture both signal families',
    body: '{\n  "run_id": "{{run_id}}"\n}',
    out: { id: 'signals', dataType: 'object' },
    check: {
      title: 'Separate the two families', payload: 'signals', width: 440,
      code: `// A technical Sell alongside an analyst Strong Buy is a real disagreement and
// is exactly what the advisor should be talking about. It is surfaced, never
// averaged away — advisory, so it travels to the orchestrator rather than
// stopping anything.
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
      also: [{ port: 'conflicts', id: 'signal_conflicts', dataType: 'object[]' }],
    },
  },
  {
    id: 'g_recs', name: '06 · Recommendations and suitability',
    description: 'Synthesises a Buy/Hold/Reduce/Sell proposal per asset and runs it through the client policy guardrail.',
    note: 'STAGE 06 — RECOMMENDATIONS AND THE SUITABILITY GUARDRAIL\n\n'
      + 'Two passes with different vocabularies, deliberately kept apart:\n\n'
      + '  buildRecommendations  → what the market is saying, given the two signal families,\n'
      + '                          the client weight, the policy band, concentration and the\n'
      + '                          advisor world view\n'
      + '  runSuitability        → what this client may actually do about it\n\n'
      + 'The guardrail can only make a recommendation more conservative. It never turns a HOLD\n'
      + 'into an ADD. The product prints both lines:\n'
      + '     MARKET SIGNAL:             BUY\n'
      + '     CLIENT-SUITABILITY RESULT: DO NOT ADD / DISCUSS ONLY   (§18)',
    noteSize: [800, 216],
    step: 'recommendations', stepTitle: 'Propose and check',
    body: '{\n  "run_id": "{{run_id}}"\n}',
    out: { id: 'recommendations', dataType: 'object' },
    check: {
      title: 'Advisor review queue', payload: 'recommendations', width: 440, console: true,
      code: `// Everything the guardrail touched, or where the two signal families disagree,
// goes to the top of the advisor's review queue. Nothing is auto-approved, so
// this is a list for the orchestrator to carry, not a reason to stop.
const r = inputs.result.value;
const rows = r.rows || [];
const needsReview = rows.filter((x) => x.conflict || x.suitability !== 'PASS' || x.final !== x.proposed);
console.log(\`\${rows.length} proposals, \${needsReview.length} need an explicit advisor decision\`);
return {
  recommendations: { type: 'object', value: r },
  needs_review: { type: 'object[]', value: needsReview.map((x) => ({ type: 'object', value: x })) },
};`,
      also: [{ port: 'needs_review', id: 'needs_review', dataType: 'object[]' }],
    },
  },
];

function stageGraph(s) {
  const n = [note(s.note, 20, 20, s.noteSize[0], s.noteSize[1])];

  const ports = connectionPorts(240, { gate: s.gate !== false });
  const runId = make(graphInputNode, { title: 'run_id', y: 160, data: { id: 'run_id', dataType: 'string' } });
  const extra = (s.inputs || []).map(([id, dataType], i) => make(graphInputNode, {
    title: id, y: 320 + i * 40, data: { id, dataType },
  }));
  n.push(runId, ...ports.nodes, ...extra);

  const step = pipelineStep({ step: s.step, title: s.stepTitle, y: 300, bodyTemplate: s.body });
  wireStep(step, ports);
  connect(runId, 'data', step.body, 'run_id');
  for (const e of extra) connect(e, 'data', step.body, e.data.id);
  n.push(...step.nodes);

  let source = step.result;
  let port = step.resultPort;
  if (s.check) {
    const also = s.check.also || [];
    const check = make(codeNode, {
      title: s.check.title, y: 300, width: s.check.width ?? 430,
      data: {
        inputNames: ['result'],
        outputNames: [s.check.payload, ...also.map((a) => a.port)],
        allowConsole: true,
        code: s.check.code,
      },
    });
    connect(source, port, check, 'result');
    n.push(check);
    source = check;
    port = s.check.payload;
    for (const [i, a] of also.entries()) {
      const o = make(graphOutputNode, { title: a.id, y: 400 + i * 100, data: { id: a.id, dataType: a.dataType } });
      connect(check, a.port, o, 'value');
      n.push(o);
    }
  }

  const out = make(graphOutputNode, { title: s.out.id, y: 300, data: s.out });
  connect(source, port, out, 'value');
  n.push(out);

  return graph(s.id, s.name, s.description, n);
}
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

  const runId = make(graphInputNode, { title: 'run_id', y: 360, data: { id: 'run_id', dataType: 'string' } });
  const ports = connectionPorts(440);
  const { apiBase, headers } = ports;
  n.push(runId, ...ports.nodes);

  // ── the FACTS the model may write about, and nothing else ───────────────
  const factsStep = pipelineStep({
    step: 'narrative-facts', title: 'FACTS for the letter', y: 360,
    bodyTemplate: '{\n  "run_id": "{{run_id}}",\n  "prompt": "client_letter"\n}',
  });
  wireStep(factsStep, ports);
  connect(runId, 'data', factsStep.body, 'run_id');
  n.push(...factsStep.nodes);

  // The letter prompt addresses the advisor and the client by name, so the two
  // names come off the FACTS beside the JSON. The API path substitutes them in
  // src/llm/prompts.js; on the canvas they are Rivet interpolation ports, and
  // with nothing connected the model was being sent the literal
  // "You are {{advisor_name}}, writing to {{client_first_name}}".
  const factsText = make(codeNode, {
    title: 'FACTS as text, and the two names the letter uses', y: 450, width: 380,
    data: {
      inputNames: ['facts'],
      outputNames: ['facts_json', 'advisor_name', 'client_first_name'],
      code: `const f = inputs.facts.value;
const facts = JSON.parse(f.facts_json || '{}');
return {
  facts_json: { type: 'string', value: f.facts_json },
  advisor_name: { type: 'string', value: facts.advisor?.name || 'o assessor' },
  client_first_name: { type: 'string', value: facts.client?.first_name || (facts.client?.name || '').split(' ')[0] || 'o cliente' },
};`,
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
  connect(factsText, 'advisor_name', letterPrompt, 'advisor_name');
  connect(factsText, 'client_first_name', letterPrompt, 'client_first_name');
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

  const llmUrl = make(textNode, { title: 'Model gateway endpoint', y: 940, width: 380, data: { text: '{{api_base}}/api/llm/complete' } });
  connect(apiBase, 'data', llmUrl, 'api_base');
  const llmCall = make(httpCallNode, {
    title: 'POST /api/llm/complete', y: 850, width: 320,
    data: { method: 'POST', url: '', headers: '', body: '', errorOnNon200: true, useUrlInput: true, useHeadersInput: true, useBodyInput: true },
  });
  connect(llmUrl, 'output', llmCall, 'url');
  connect(headers, 'data', llmCall, 'headers');
  connect(buildCall, 'body', llmCall, 'req_body');
  n.push(llmUrl, llmCall);

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
const required = ['title', 'greeting', 'sign_off'];
const ok = !!letter
  && required.every((k) => typeof letter[k] === 'string' && letter[k].length > 0)
  && Array.isArray(letter.paragraphs)
  && letter.paragraphs.filter((p) => typeof p === 'string' && p.trim()).length >= 4;
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

  const storeUrl = make(textNode, { title: 'Narrative endpoint', y: 1030, width: 380, data: { text: '{{api_base}}/api/pipeline/narrative' } });
  connect(apiBase, 'data', storeUrl, 'api_base');
  const storeCall = make(httpCallNode, {
    title: 'POST /api/pipeline/narrative (model letter)', y: 940, width: 340,
    data: { method: 'POST', url: '', headers: '', body: '', errorOnNon200: true, useUrlInput: true, useHeadersInput: true, useBodyInput: true },
  });
  connect(storeUrl, 'output', storeCall, 'url');
  connect(headers, 'data', storeCall, 'headers');
  connect(storeBody, 'body', storeCall, 'req_body');
  n.push(storeUrl, storeCall);

  // ── deterministic branch ────────────────────────────────────────────────
  n.push(note(
    'DETERMINISTIC BRANCH\n\n'
    + 'Renders the same FACTS into correct Portuguese without a model, so the product degrades to\n'
    + '"less fluent" rather than to "broken" when no provider is configured or the model returns\n'
    + 'something unusable. The canonical report records which path ran, and the advisor sees it\n'
    + 'in the Audit tab.',
    420, 1320, 760, 120));

  const detStep = pipelineStep({
    step: 'narrative', title: 'Deterministic narrative', y: 1460,
    bodyTemplate: '{\n  "run_id": "{{run_id}}",\n  "mode": "deterministic"\n}',
  });
  wireStep(detStep, ports);
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

  const runId = make(graphInputNode, { title: 'run_id', y: 250, data: { id: 'run_id', dataType: 'string' } });
  const ports = connectionPorts(330);
  // A published client letter is immutable. Reissuing one is a deliberate act,
  // so it is an input on the canvas rather than a flag buried in a request body.
  const reissue = make(graphInputNode, { title: 'reissue a published letter', y: 570, width: 300, data: { id: 'reissue', dataType: 'boolean' } });
  n.push(runId, ...ports.nodes, reissue);

  const step = pipelineStep({
    step: 'assemble', title: 'Assemble and validate', y: 310,
    bodyTemplate: '{\n  "run_id": "{{run_id}}",\n  "force": {{reissue}}\n}',
  });
  wireStep(step, ports);
  connect(runId, 'data', step.body, 'run_id');
  connect(reissue, 'data', step.body, 'reissue');
  n.push(...step.nodes);

  const gate = make(codeNode, {
    title: 'Publication gate — stops the run', y: 310, width: 460,
    data: {
      inputNames: ['result'],
      outputNames: ['report', 'pending_approval'],
      allowConsole: true,
      code: `// "pending advisor approval" is not an error, it is the design: the advisor
// gate at stage 09 is the whole point, so it travels on as a count for the
// orchestrator to report. A blocking error is anything else, and there is no
// letter to be had from a report that carries one.
const r = inputs.result.value;
const blocking = r.blocking_errors || [];
if (blocking.length) throw new Error(\`stage 08: \${blocking.length} blocking error(s) — \${blocking.join(' | ')}\`);
return {
  report: { type: 'object', value: r },
  pending_approval: { type: 'number', value: r.pending_advisor_approval || 0 },
};`,
    },
  });
  connect(step.result, step.resultPort, gate, 'result');
  n.push(gate);

  const out = make(graphOutputNode, { title: 'canonical_report', y: 310, data: { id: 'canonical_report', dataType: 'object' } });
  connect(gate, 'report', out, 'value');
  const outPending = make(graphOutputNode, { title: 'pending_approval', y: 410, data: { id: 'pending_approval', dataType: 'number' } });
  connect(gate, 'pending_approval', outPending, 'value');
  n.push(out, outPending);
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

  const runId = make(graphInputNode, { title: 'run_id', y: 290, data: { id: 'run_id', dataType: 'string' } });
  const ports = connectionPorts(370);
  n.push(runId, ...ports.nodes);

  const render = pipelineStep({
    step: 'render', title: 'Render HTML, PDF and portal', y: 350,
    bodyTemplate: '{\n  "run_id": "{{run_id}}",\n  "approved_only": true\n}',
  });
  wireStep(render, ports);
  connect(runId, 'data', render.body, 'run_id');
  n.push(...render.nodes);

  const pageCheck = make(codeNode, {
    title: 'Two-page constraint — stops the run', y: 350, width: 440,
    data: {
      inputNames: ['result'],
      outputNames: ['render'],
      allowConsole: true,
      code: `// The two-page limit is a hard constraint. The renderer drops optional blocks
// in a fixed order until it fits, so a third page means the reduction ladder
// ran out rather than that the letter is long — nothing is persisted from it.
const r = inputs.result.value;
console.log(\`\${r.page_count} page(s), layout reduction level \${r.layout_reduction_level}\`);
if (r.page_count > 2) throw new Error(\`stage 09: rendered \${r.page_count} pages at reduction level \${r.layout_reduction_level}\`);
return { render: { type: 'object', value: r } };`,
    },
  });
  connect(render.result, render.resultPort, pageCheck, 'result');
  n.push(pageCheck);

  const persist = pipelineStep({
    step: 'persist', title: 'Persist to D1 and R2', y: 350,
    bodyTemplate: '{\n  "run_id": "{{run_id}}",\n  "status": "pending_approval"\n}',
  });
  wireStep(persist, ports);
  connect(runId, 'data', persist.body, 'run_id');
  // sequencing: persist only runs once the page-count check has produced a value
  connect(pageCheck, 'render', persist.body, 'render');
  n.push(...persist.nodes);

  const out = make(graphOutputNode, { title: 'report', y: 350, data: { id: 'report', dataType: 'object' } });
  connect(persist.result, persist.resultPort, out, 'value');
  n.push(out);

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

  // `?refresh=1` was on this URL and the handler never read it — the morning run
  // is started by the endpoint itself when there is no completed one, and the
  // portal polls for it.
  const url = make(textNode, { title: 'Overview endpoint', y: 220, width: 320, data: { text: '{{api_base}}/api/advisor/overview' } });
  // This graph is a separate entry point, run on its own rather than by `00`,
  // so it builds its own headers instead of being handed them.
  const headers = make(objectNode, { title: 'Service headers', y: 330, width: 320, data: { jsonTemplate: '{\n  "x-service-token": "{{api_token}}"\n}' } });
  const call = make(httpCallNode, {
    title: 'GET /api/advisor/overview', y: 260, width: 320,
    data: { method: 'GET', url: '', headers: '', body: '', errorOnNon200: true, useUrlInput: true, useHeadersInput: true },
  });
  connect(apiBase, 'data', url, 'api_base');
  connect(apiToken, 'data', headers, 'api_token');
  connect(url, 'output', call, 'url');
  connect(headers, 'output', call, 'headers');
  n.push(url, headers, call);

  const summarise = make(codeNode, {
    title: 'What matters today', y: 260, width: 460,
    data: {
      inputNames: ['overview'],
      outputNames: ['briefing', 'what_matters', 'fired_triggers'],
      allowConsole: true,
      code: `// The endpoint answers with the last completed run, and starts one when
// there is none rather than making the caller wait for it. Reading the fields
// of a run that has not finished gave three empty outputs and no hint why, so
// the unfinished case says so.
const o = inputs.overview.value;
if (o.pending || !o.world_view) {
  throw new Error(\`the morning run has not finished (run \${o.run?.id || 'unknown'}, status \${o.run?.status || 'unknown'}) — it was started by this call; run this graph again in a moment\`);
}
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

  n.push(note(
    'THIS GRAPH IS ONE OF TWO DRIVERS\n\n'
    + 'The stages below call /api/pipeline/*, and those endpoints are thin wrappers over\n'
    + 'worker/src/letter-pipeline.js. The portal drives the same functions itself, from the\n'
    + '\u201Ccriar carta mensal\u201D button on the client page (worker/src/letter-agent.js), so an advisor\n'
    + 'can write a letter without Rivet and without a terminal.\n\n'
    + 'Both end in one row of `reports` for that client and that month. Rivet is the surface where\n'
    + 'the prompts stay visible and editable; the agent is the surface an advisor actually uses.', 20, 200, 820, 150));

  const apiBase = make(graphInputNode, { title: 'api_base', y: 230, width: 320, data: { id: 'api_base', dataType: 'string', defaultValue: 'http://127.0.0.1:8788' } });
  const apiToken = make(graphInputNode, { title: 'api_token', y: 310, width: 320, data: { id: 'api_token', dataType: 'string' } });
  const clientId = make(graphInputNode, { title: 'client_id', y: 390, width: 320, data: { id: 'client_id', dataType: 'string', defaultValue: 'cli_albert' } });
  const month = make(graphInputNode, { title: 'month', y: 470, width: 320, data: { id: 'month', dataType: 'string' } });
  const runId = make(graphInputNode, { title: 'run_id', y: 550, width: 320, data: { id: 'run_id', dataType: 'string' } });
  const reissue = make(graphInputNode, { title: 'reissue', y: 630, width: 320, data: { id: 'reissue', dataType: 'boolean', defaultValue: false } });
  n.push(apiBase, apiToken, clientId, month, runId, reissue);

  // The service token becomes a headers object once, here, and every stage
  // takes that object on a port. Thirteen identical copies of these three lines
  // used to be drawn, one beside each call in the project.
  const headers = make(objectNode, {
    title: 'Service headers — built once, passed to every stage', y: 700, width: 380,
    data: { jsonTemplate: '{\n  "content-type": "application/json",\n  "x-service-token": "{{api_token}}"\n}' },
  });
  connect(apiToken, 'data', headers, 'api_token');
  n.push(headers);

  const stages = [
    { id: subgraphIds.ingest, title: '01 · Ingest', inputs: ['run_id', 'client_id', 'month'], out: 'context' },
    { id: subgraphIds.market, title: '02 · Market data', inputs: ['run_id'], out: 'market_data' },
    { id: subgraphIds.profit, title: '03 · Profitability', inputs: ['run_id'], out: 'performance' },
    { id: subgraphIds.intel, title: '04 · Market intelligence', inputs: ['run_id'], out: 'market_intel' },
    { id: subgraphIds.signals, title: '05 · TradingView signals', inputs: ['run_id'], out: 'signals', carries: ['signal_conflicts'] },
    { id: subgraphIds.recs, title: '06 · Recommendations + suitability', inputs: ['run_id'], out: 'recommendations', carries: ['needs_review'] },
    { id: subgraphIds.narrative, title: '07 · Narrative', inputs: ['run_id'], out: 'narrative' },
    { id: subgraphIds.assemble, title: '08 · Canonical report', inputs: ['run_id', 'reissue'], out: 'canonical_report', carries: ['pending_approval'] },
    { id: subgraphIds.render, title: '09 · Render + persist', inputs: ['run_id'], out: 'report' },
  ];

  const inputByName = { run_id: runId, client_id: clientId, month, reissue };

  let y = 240;
  const created = [];
  const carried = [];
  let previous = null;
  for (const st of stages) {
    const sg = make(subGraphNode, { title: st.title, y, width: 320, data: { graphId: st.id, useAsGraphPartialOutput: true } });
    connect(apiBase, 'data', sg, 'api_base');
    connect(headers, 'output', sg, 'headers');
    for (const inp of st.inputs) {
      const src = inputByName[inp];
      if (src) connect(src, 'data', sg, inp);
    }
    // The stages share connection settings only, so without this the whole
    // pipeline would run at once. Each stage waits on the one before it.
    if (previous) connect(previous.node, previous.out, sg, 'gate');
    previous = { node: sg, out: st.out };
    for (const c of st.carries || []) carried.push({ node: sg, port: c });
    created.push(sg);
    n.push(sg);
    y += 130;
  }

  const out = make(graphOutputNode, { title: 'report', y: 300, width: 320, data: { id: 'report', dataType: 'object' } });
  connect(created[created.length - 1], 'report', out, 'value');
  n.push(out);

  // ── the advisory verdicts, collected ────────────────────────────────────
  // A stage that finds something it cannot let through throws, and the run
  // stops inside that stage, before the next one starts. What reaches here is
  // the other kind: the things an advisor has to look at rather than things
  // that make the report wrong. They used to be computed and dropped — six
  // boolean outputs no node read — which is how a "validation gate" ends up
  // being a comment rather than a gate.
  const checks = make(codeNode, {
    title: 'Run checks — what the advisor has to look at', y: 560, width: 460,
    data: {
      inputNames: carried.map((c) => c.port),
      outputNames: ['checks'],
      allowConsole: true,
      code: `const conflicts = inputs.signal_conflicts?.value || [];
const review = inputs.needs_review?.value || [];
const pending = inputs.pending_approval?.value || 0;
const summary = {
  signal_conflicts: conflicts.length,
  need_advisor_decision: review.length,
  pending_advisor_approval: pending,
};
console.log(\`\${summary.signal_conflicts} signal conflict(s), \${summary.need_advisor_decision} proposal(s) needing a decision, \${summary.pending_advisor_approval} pending approval\`);
return { checks: { type: 'object', value: summary } };`,
    },
  });
  for (const c of carried) connect(c.node, c.port, checks, c.port);
  const outChecks = make(graphOutputNode, { title: 'checks', y: 560, width: 320, data: { id: 'checks', dataType: 'object' } });
  connect(checks, 'checks', outChecks, 'value');
  n.push(checks, outChecks);

  n.push(note(
    'ADVISOR APPROVAL SITS BETWEEN STAGE 06 AND STAGE 09.\n\n'
    + 'In the demo the advisor decides in the portal (Recommendations tab) and stage 09 reads the\n'
    + 'decisions back from D1 before rendering. In production this is a wait-for-event node, so the\n'
    + 'graph run itself pauses at the gate rather than the runner re-entering it.',
    20, 480, 620, 120));

  return graph('g_main', '00 · Monthly client report', 'Orchestrator. Runs the nine stages that produce one client\'s monthly report.', n);
}

// ═══════════════════════════════════════════════════════════════════════════
// Layout
// ═══════════════════════════════════════════════════════════════════════════
/**
 * The canvas is computed, not typed.
 *
 * Every node above is created with an x and a y, and those numbers were chosen
 * by hand one stage at a time. They drifted: three nodes of a pipeline step sat
 * 110 pt apart while Rivet drew them 150 pt tall, so the headers node was buried
 * under the endpoint node in all ten stages, and the stages that grew a branch
 * ended up with wires crossing the whole canvas.
 *
 * So the hand-written coordinates are kept only as a hint for vertical order,
 * and the actual placement is derived from the connections: a node sits one
 * column to the right of everything that feeds it, and the order within a
 * column is pulled towards the middle of its own inputs. That is the standard
 * layered-graph layout, and it means a stage that grows a node lays itself out
 * instead of needing its neighbours nudged by hand.
 */
const LANE = {
  x0: 40,          // the flow starts right of the note rail
  y0: 40,
  hGap: 110,       // between columns
  vGap: 56,        // between nodes in a column
  railW: 520,      // the note rail down the left
  railGap: 70,
};

/**
 * How tall Rivet actually draws each kind of node. Rivet sizes a node by its
 * content and does not write the height back to the file, so these are measured
 * from the canvas and rounded up: a column with too much air reads as calm, one
 * with too little reads as the bug this replaces.
 */
const NODE_H = {
  graphInput: 92, graphOutput: 92, ifElse: 132, extractJson: 152,
  subGraph: 168, object: 196, text: 212, httpCall: 244, prompt: 268, chat: 268, code: 300,
};
const heightOf = (n) => n.visualData.height ?? NODE_H[n.type] ?? 200;

function layoutGraph(g) {
  const notes = g.nodes.filter((n) => n.type === 'comment');
  const flow = g.nodes.filter((n) => n.type !== 'comment');
  if (!flow.length) return g;

  const byId = new Map(flow.map((n) => [n.id, n]));
  const edges = g.connections.filter((c) => byId.has(c.outputNodeId) && byId.has(c.inputNodeId));
  const preds = new Map(flow.map((n) => [n.id, new Set()]));
  const succs = new Map(flow.map((n) => [n.id, new Set()]));
  for (const c of edges) {
    if (c.outputNodeId === c.inputNodeId) continue;
    preds.get(c.inputNodeId).add(c.outputNodeId);
    succs.get(c.outputNodeId).add(c.inputNodeId);
  }

  // ── columns: one to the right of the furthest thing that feeds you ──────
  // Longest path, computed by relaxing until it settles. A cycle cannot make
  // this run away because a node is only raised while something feeding it is
  // strictly higher, and the pass count is bounded by the node count.
  const col = new Map(flow.map((n) => [n.id, 0]));
  for (let pass = 0; pass < flow.length; pass += 1) {
    let moved = false;
    for (const n of flow) {
      const want = Math.max(0, ...[...preds.get(n.id)].map((p) => col.get(p) + 1));
      if (want > col.get(n.id)) { col.set(n.id, want); moved = true; }
    }
    if (!moved) break;
  }
  // Longest-path alone puts every node as far left as its inputs allow, which
  // strands the three little nodes that build one HTTP request in the same
  // column as each other and a long way from the call they belong to — they
  // depend only on the graph inputs, so they all land in column 1. Pulling each
  // node as late as its consumers allow puts the request beside its call.
  // Graph inputs stay put: they are the graph's own edge and belong on it.
  for (let pass = 0; pass < flow.length; pass += 1) {
    let moved = false;
    for (const n of flow) {
      if (n.type === 'graphInput' || !succs.get(n.id).size) continue;
      const latest = Math.min(...[...succs.get(n.id)].map((x) => col.get(x))) - 1;
      const earliest = Math.max(0, ...[...preds.get(n.id)].map((x) => col.get(x) + 1));
      const want = Math.max(earliest, latest);
      if (want !== col.get(n.id) && want >= earliest) { col.set(n.id, want); moved = true; }
    }
    if (!moved) break;
  }

  // An orchestrator is a chain: stage N feeds stage N+1's gate, so longest-path
  // gives each stage a column of its own and nine stages come out as a
  // staircase five thousand points wide. A chain has nothing to lay out
  // sideways — it reads as a ladder, top to bottom, in one column. So a run of
  // nodes of the same type where each feeds only the next collapses back into
  // the column of the first of them.
  const chain = flow.filter((n) => n.type === 'subGraph');
  if (chain.length > 2) {
    const inChain = new Set(chain.map((n) => n.id));
    const links = chain.filter((n) => [...succs.get(n.id)].some((x) => inChain.has(x))).length;
    if (links >= chain.length - 1) {
      const first = Math.min(...chain.map((n) => col.get(n.id)));
      for (const n of chain) col.set(n.id, first);
      // Everything the chain feeds moves to just after it, so the ladder is
      // not straddled by the nodes that read from its rungs.
      for (const n of flow) {
        if (inChain.has(n.id) || n.type === 'graphInput') continue;
        if ([...preds.get(n.id)].some((p) => inChain.has(p))) col.set(n.id, first + 1);
      }
    }
  }

  // A node that feeds nothing is an ending: push the graph outputs to the last
  // column so they line up, rather than floating wherever their input landed.
  const lastCol = Math.max(...col.values());
  for (const n of flow) if (n.type === 'graphOutput') col.set(n.id, lastCol);

  const columns = [];
  for (const n of flow) (columns[col.get(n.id)] ||= []).push(n);

  // Collapsing the chain empties the columns it used to occupy, and a sparse
  // array spreads as `undefined`, so one hole put every node in the
  // orchestrator at y = NaN — all twenty-two drawn on the same spot. Compact
  // the columns and renumber, so nothing below ever sees a column that is not
  // there.
  const dense = columns.filter((c) => c && c.length);
  columns.length = 0;
  columns.push(...dense);
  for (const [i, c] of columns.entries()) for (const n of c) col.set(n.id, i);

  // ── order within a column: towards the middle of your own inputs ────────
  // The hand-written y is the tie-break, so the vertical order an author chose
  // for a row of graph inputs survives.
  const originalY = new Map(flow.map((n) => [n.id, n.visualData.y ?? 0]));
  const rank = new Map();
  for (const c of columns) {
    if (!c) continue;
    c.sort((a, b) => originalY.get(a.id) - originalY.get(b.id));
    c.forEach((n, i) => rank.set(n.id, i));
  }
  // Sweeping forward alone only ever pulls a node towards what feeds it, so the
  // three little nodes that build one HTTP request end up wherever their shared
  // graph inputs put them rather than beside the call they belong to. Sweeping
  // back down the graph as well pulls each node towards what it feeds, which is
  // what actually untangles a fan-in.
  // Only neighbours in another column may pull a node up or down. A collapsed
  // chain has all its edges inside its own column, and counting those made the
  // nine stages sort themselves into 01, 02, 09, 03, 05, 04 — each rung pulled
  // towards the rung it feeds, which is in the same column it is trying to
  // order. Those edges carry no horizontal information, so they get no vote.
  const barycentre = (n, side) => {
    const here = col.get(n.id);
    const ns = [...side.get(n.id)].filter((x) => rank.has(x) && col.get(x) !== here);
    return ns.length ? ns.reduce((a, x) => a + rank.get(x), 0) / ns.length : rank.get(n.id);
  };
  const reorder = (i, side) => {
    const c = columns[i];
    if (!c) return;
    const b = new Map(c.map((n) => [n.id, barycentre(n, side)]));
    c.sort((x, y) => (b.get(x.id) - b.get(y.id)) || (originalY.get(x.id) - originalY.get(y.id)));
    c.forEach((n, k) => rank.set(n.id, k));
  };
  /**
   * How many pairs of wires cross, counted between each pair of neighbouring
   * columns: two edges cross when one starts above the other and ends below it.
   */
  const crossings = () => {
    let total = 0;
    for (const c of edges) {
      for (const d of edges) {
        if (c === d) continue;
        if (col.get(c.outputNodeId) !== col.get(d.outputNodeId)) continue;
        if (col.get(c.inputNodeId) !== col.get(d.inputNodeId)) continue;
        const a1 = rank.get(c.outputNodeId); const b1 = rank.get(c.inputNodeId);
        const a2 = rank.get(d.outputNodeId); const b2 = rank.get(d.inputNodeId);
        if (a1 < a2 && b1 > b2) total += 1;
      }
    }
    return total;
  };

  // A barycentre sweep is not monotonic — it can untangle one column by tangling
  // the next, and left to run it oscillates between two states. So every sweep
  // is scored and the best arrangement seen is the one that gets drawn.
  let best = new Map(rank);
  let bestScore = crossings();
  for (let sweep = 0; sweep < 12 && bestScore > 0; sweep += 1) {
    for (let i = 1; i < columns.length; i += 1) reorder(i, preds);
    for (let i = columns.length - 2; i >= 0; i -= 1) reorder(i, succs);
    const score = crossings();
    if (score < bestScore) { bestScore = score; best = new Map(rank); }
  }
  for (const c of columns) {
    if (!c) continue;
    c.sort((a, b) => best.get(a.id) - best.get(b.id));
    c.forEach((n, k) => rank.set(n.id, k));
  }

  // ── place ───────────────────────────────────────────────────────────────
  const railX = LANE.x0;
  const flowX0 = notes.length ? railX + LANE.railW + LANE.railGap : LANE.x0;
  let x = flowX0;
  const heights = columns.map((c) => (c || []).reduce((a, n) => a + heightOf(n) + LANE.vGap, -LANE.vGap));
  const tallest = Math.max(0, ...heights);
  for (const [i, c] of columns.entries()) {
    if (!c) continue;
    const w = Math.max(...c.map((n) => n.visualData.width ?? 300));
    // Columns are centred against the tallest one, so the flow reads as a band
    // across the canvas rather than everything hanging from the top edge.
    let y = LANE.y0 + (tallest - heights[i]) / 2;
    for (const n of c) {
      n.visualData.x = x;
      n.visualData.y = Math.round(y);
      y += heightOf(n) + LANE.vGap;
    }
    x += w + LANE.hGap;
  }

  // ── the notes: a rail down the left, out of the flow entirely ───────────
  let ny = LANE.y0;
  for (const n of notes) {
    n.visualData.x = railX;
    n.visualData.y = ny;
    n.visualData.width = LANE.railW;
    ny += (n.visualData.height ?? 120) + 40;
  }
  return g;
}

const built = Object.fromEntries(STAGES.map((s) => [s.id, stageGraph(s)]));
const subgraphs = {
  ingest: built.g_ingest,
  market: built.g_market,
  profit: built.g_profit,
  intel: built.g_intel,
  signals: built.g_signals,
  recs: built.g_recs,
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
  graphs: Object.fromEntries([main, ...Object.values(subgraphs)].map(layoutGraph).map((g) => [g.metadata.id, g])),
};

const yaml = serializeProject(project);
const outPath = path.join(HERE, 'enter_wealth_advisor.rivet-project');
await writeFile(outPath, yaml);

const nodeCount = Object.values(project.graphs).reduce((a, g) => a + g.nodes.length, 0);
console.log(`wrote ${outPath}`);
console.log(`${Object.keys(project.graphs).length} graphs, ${nodeCount} nodes, prompt version ${PROMPT_VERSION}`);
