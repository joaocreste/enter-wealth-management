# Enter Asset Management — AI advisory portal

An MVP of an AI-assisted advisory product for XP-style financial advisors and their
middle-market clients. It answers three questions for every client, every month:
how the portfolio performed, what happened in markets that matters to *this*
portfolio, and what is worth discussing at the next meeting.

Rivet orchestrates the workflow. Deterministic finance runs in code. A language
model writes, explains and personalises — and is never asked for a number.

Everything below has been run against live market data. The reporting month in the
demo is **August 2026**, priced from Yahoo Finance, TradingView, the Banco Central do
Brasil and CoinGecko at run time.

---

## Run it

```bash
npm install
npm run migrate                                   # create the local D1 schema
npm run dev                                       # start the Worker on :8788
# in a second terminal:
curl -X POST localhost:8788/api/admin/seed -d '{}' -H 'content-type: application/json'
npm run demo                                      # the whole §37 journey, narrated
```

Then open **http://127.0.0.1:8788/** — or the deployed portal at
**https://joaocreste.github.io/enter-wealth-management/**, which runs against the
deployed Worker rather than your local one.

| | |
|---|---|
| Advisor | `antonio.bicudo@enteram.com.br` / `enter2026` |
| Client | `albert.dasilva@exemplo.com.br` / `albert2026` |

`docs/screens/` holds a captured run if you would rather look before installing:
the login, the World Overview, the client book, the signal dashboard, performance
attribution, the recommendation and suitability screen, meeting preparation, both
client views, the generated
**[two-page PDF](docs/screens/carta-mensal-albert-agosto-2026.pdf)** and the
**[HTML email](docs/screens/email-albert-agosto-2026.html)**.

To run the workflow through Rivet itself rather than the demo script:

```bash
npm run build:graph                  # regenerate the graph from src/llm/prompts.js
npm run run:report -- --client cli_albert
npm run run:overview
```

`rivet/enter_wealth_advisor.rivet-project` opens directly in Rivet Desktop. Set the
`api_base` and `api_token` graph inputs (`http://127.0.0.1:8788` and the value of
`SERVICE_TOKEN` in `.dev.vars`) and press Run.

### Optional: connect a language model

Without a key the narrative is produced by a deterministic Portuguese renderer,
the report records `narrative_mode: "deterministic_template"`, and the daily
agents skip the news scan and rank events by rule. To use a model:

```bash
echo 'ANTHROPIC_API_KEY = "sk-ant-..."' >> .dev.vars     # local
npx wrangler secret put ANTHROPIC_API_KEY                # deployed
```

`ANTHROPIC_MODEL` in `wrangler.toml` selects the model (default `claude-opus-5`) and
is written into every report's provenance block. `OPENAI_API_KEY` works as an
alternative. Nothing else changes: the same prompts, the same FACTS object, the same
validation.

---

## What is real

| Real, retrieved live | Real, from the case files | Simulated, and labelled |
|---|---|---|
| Every listed price (Yahoo Finance, TradingView) | Albert's identity, advisor, risk profile | Monthly quota values for Brazilian funds |
| CDI, Selic, IPCA, PTAX (Banco Central) | The May 2025 XP position statement, reproduced as snapshot v1 | Return history before the platform existed |
| TradingView technical ratings and analyst consensus | XP's February 2025 macro projections | The four demo clients other than Albert |
| The policy benchmark, composed from the above | | |

Simulated data carries `mocked: true` in its source record, shows a `SIMULADO` chip in
the advisor's Audit tab, and is named in the source line of the letter. Brazilian FIC
funds have no public price feed — the honest answer is "the custodian statement", and
that is what the source line says.

---

## Architecture

```
Rivet graph  ──HTTP──▶  Cloudflare Worker  ──▶  D1   relational record
   │                          │                 R2   PDFs, HTML, snapshots
   │                          │                 KV   cached provider responses
   │                          ▼
   │                    provider chain: Yahoo → TradingView → DATA UNAVAILABLE
   │                                    BCB (authoritative for BRL rates and FX)
   │                                    CoinGecko (digital assets)
   ▼
LLM stage: prompts held in the graph, FACTS object built in code
```

| Path | What lives there |
|---|---|
| `rivet/` | The graph, and `build-graph.mjs` which generates it from `src/llm/prompts.js` |
| `src/core/` | Performance, attribution, recommendations, suitability, triggers, events, formatting, the canonical schema |
| `src/adapters/` | Yahoo, TradingView, Banco Central, CoinGecko, the provider chain, cache and throttle |
| `src/render/` | The letter model, charts, the HTML email, and a self-contained PDF engine |
| `src/llm/prompts.js` | Every prompt, in English. The single source of truth |
| `worker/` | The API, the pipeline steps Rivet calls, D1 migrations, the seed runner |
| `web/` | The advisor portal, the client portal and the login, served by the same Worker |
| `seed/` | The demo dataset |
| `docs/` | The implementation report, plus `docs/screens/` — every screen, the generated PDF and the HTML email, captured from a live run |
| `Input/`, `Output/`, `brand-guidelines.html`, `enter_challenge.rivet-project` | The working-session material — case files, the brand document and the original four-prompt graph. Present in the working tree, **excluded from this public repository** because they are Enter's and XP's material, not this project's. Nothing at runtime reads them: the brand tokens live in `src/core/brand.js` and the case data is reproduced in `seed/` |

### The Rivet graph

`00 · Monthly client report` orchestrates nine subgraphs, each named for the stage it
owns and each carrying a comment node explaining what it guarantees:

| | |
|---|---|
| 01 | Ingest client, policy and approved snapshot |
| 02 | Fetch and validate market data |
| 03 | Profitability, attribution, benchmark, historical metrics |
| 04 | Market indicators, thresholds, events and portfolio impact |
| 05 | TradingView technical and analyst signals — two independent families |
| 06 | Recommendations and the suitability guardrail |
| 07 | Narrative — the only language-model stage |
| 08 | Assemble and validate the canonical report |
| 09 | Render HTML, PDF and portal view, then persist |

`10 · Daily World Overview` is a separate entry point, run once per advisor per morning.

Stages are chained through an explicit `gate` input. Without it Rivet would run all
nine at once, because they share only the connection settings.

---

## The parts that matter

**Every figure is traceable.** A market number cannot reach a client without a source
record naming the provider, the instrument, the requested range, the retrieval
timestamp and the last observation used. The canonical report is rejected by its own
validator if a figure references a source that is not in the ledger.

**Nothing is fabricated.** When a provider fails, the chain tries the approved
fallback and records `fallback_for`. When nothing reliable exists, the position is
reported as `DATA UNAVAILABLE` with the providers tried, contributes exactly zero to
the return, and is disclosed in the letter. The demo contains two real cases: `ARZZ3`
and `MRFG3` no longer price after their corporate actions, and the system detects it
rather than carrying a stale number.

**The two TradingView families stay apart.** Technical rating and analyst consensus
are captured, stored and displayed as separate fields. Where a security has no
sell-side coverage the record says *No analyst consensus available* — the technical
rating is never used to infer it. Where they disagree, the disagreement is the point,
and it goes to the top of the advisor's queue.

**A market signal is not a client outcome.** The suitability layer runs as a separate
pass with its own vocabulary and can only make a recommendation more conservative.
Both lines are printed:

```
MERCADO         TECHNICAL: SELL · ANALYST: BUY (CONFLICT)
ENQUADRAMENTO   DO NOT ADD / DISCUSS ONLY
```

**The advisor gate is real.** Only recommendations the advisor marked *approved* are
rendered into the client letter. Re-running the workflow refreshes the analysis and
keeps those decisions; a decision is reopened only when the underlying proposal
actually changed.

**One payload, three outputs.** The HTML email, the two-page PDF and the client
portal all render from the same canonical report object, so they cannot disagree.
The demo script asserts it.

**Two pages means two pages.** The PDF engine is written from scratch — it embeds
Archivo and Newsreader as CIDFontType2 so Portuguese accents and the true minus sign
U+2212 render correctly, and it measures every block before drawing. If the content
would spill onto a third page it drops optional blocks in a fixed order and records
which level it needed. The contribution chart is the last thing to go.

---

## Deploying

The portal and the API live on different origins by design: static files on
**GitHub Pages**, everything with state on a **Cloudflare Worker** with D1, R2 and KV.

**Live:**

| | |
|---|---|
| Portal | **https://joaocreste.github.io/enter-wealth-management/** |
| API | https://enter-wealth-advisor.joaocreste-8da.workers.dev |

Advisor `antonio.bicudo@enteram.com.br` / `enter2026` · client
`albert.dasilva@exemplo.com.br` / `albert2026`. The demo dataset is seeded and
August 2026 is published, priced from live providers.

`web/shared/config.js` resolves which API to call from the hostname at runtime, so
the same committed files work under `wrangler dev` (same origin) and on Pages
(cross origin). Nothing is injected at build time.

### The daily agents

The World Overview is rebuilt by three agents that run in sequence inside the
Worker — every day at 07:00 São Paulo time (a Cloudflare cron trigger, so
nothing depends on anyone's machine) and whenever an advisor presses
**atualizar dados de mercado**, which pops up a progress card and shows what
each agent is doing while it runs.

| | Agent | What it does | With a model | Without |
|---|---|---|---|---|
| 1 | **Dados** | Retrieves every monitored indicator (Yahoo Finance, Banco Central, CoinGecko), the curated events and the events generated from significant moves — each with a source record. With Claude, also scans the web for today's news: every item must carry the URL of a search result, and the code drops any item whose URL was not actually among the results. | Claude with web search, citations verified | indicators and curated events only |
| 2 | **Inferência** | Reads what agent 1 gathered plus every client's exposure by asset class, decides what matters for *this* book today, ranks it, and writes the day's summary and the What Matters rows in Portuguese. The code keeps the exposure arithmetic; the model never gets to write a number that is not in the facts. | Claude (`ANTHROPIC_MODEL`) | a Portuguese template ranked by rule |
| 3 | **Gatilhos** | Evaluates every configured threshold and every client's allocation drift against their policy, with a *proximity* (1.0 = at the threshold) so the portal draws each as a bar and says plainly when an action is due. | pure code | pure code |

Runs are recorded in `overview_runs` with their progress log and result; the
portal reads the last completed run rather than recomputing on a page view.
`POST /api/advisor/refresh` starts a run and `GET /api/advisor/refresh/:id`
reports it. The model path needs `npx wrangler secret put ANTHROPIC_API_KEY`;
`/api/health` says which path is active.

### The indicator histories

**Indicadores monitorados** reads its variation from daily price histories the
Worker keeps in the `enter-wealth-market` R2 bucket (`worker/src/series.js`), one
object per indicator under `series/indicators/<key>.json`: unadjusted and adjusted
closes from Yahoo Finance, the source record for the whole history, and when it
was refreshed. The first request backfills five years; after that the daily cron
appends the newest sessions (re-reading the last ten so a restated close lands),
and a custom range that starts earlier than the stored history extends it
backwards and keeps what it learned. A row fetched while its session is still
open is marked provisional and shown as "sessão em curso" until the next refresh
replaces it with the close. The Selic target and the monthly IPCA have no daily
price and are listed as excluded, not dropped.

`GET /api/advisor/indicators/series?window=5d|30d|ytd|1y|5y` returns every
indicator's start and end close, variation, high, low and a downsampled series for
the sparkline; `window=custom&from=YYYY-MM-DD&to=YYYY-MM-DD` takes any range back
to 1990. Variation is measured on the unadjusted close, the price the strip shows,
so a dividend restatement never makes merged history inconsistent. Every response
carries the source record of each series. `POST /api/advisor/indicators/series/rebuild`
downloads every history again; the daily cron refreshes the store after it starts
the overview runs.

### The portal's design

`web/shared/app.css` is the brand book applied to a screen: an ink rail, a paper
page with a 2px masthead rule, Archivo for everything that is a number or a control,
Newsreader for everything a person wrote, and chroma reserved for data — green and
red appear only on a figure, never on chrome. Sections are numbered like a ledger,
charts colour themselves from CSS tokens so the light/dark toggle in the rail
repaints them without a re-render, and the one animated moment per surface is the
return arrow drawing itself on the login page (and as the loading indicator).
`prefers-reduced-motion` shows the final state immediately.

```bash
npx wrangler login            # as the account that should own the resources
npm run setup:cloudflare      # creates D1, KV and R2, sets the secrets, migrates
npm run deploy:worker         # deploys, and writes the Worker URL into the portal
git add web/shared/config.js wrangler.toml && git commit -m "point the portal at the Worker" && git push
```

**If `wrangler login` will not complete.** The OAuth flow needs an interactive
terminal, a free callback port and a browser already signed in to the right
account. Two things break it in practice: a previous `wrangler login` left running
still holds port 8976, so every later attempt fails to bind (`lsof -nP -iTCP:8976`,
then kill it); and if the browser is signed in to a different Cloudflare account
the consent screen authorises that one instead. An API token avoids all of it:

```bash
# dash.cloudflare.com/profile/api-tokens → Create Token → Edit Cloudflare Workers,
# then add: D1 Edit, Workers R2 Storage Edit, Account Settings Read
echo 'PASTE_TOKEN_HERE' > .cloudflare-token && chmod 600 .cloudflare-token
```

`.cloudflare-token` is gitignored, and `setup:cloudflare` and `deploy:worker` pick
it up automatically — no browser, no callback port, and the account is whichever one
minted the token.

The push triggers `.github/workflows/pages.yml`, which publishes `web/`. That
workflow refuses to publish while `config.js` still holds the `WORKERS_SUBDOMAIN`
placeholder — a portal pointing at an API that does not exist is worse than no
portal.

Then seed the deployed database once, with the `SEED_TOKEN` the setup script printed:

```bash
curl -X POST https://<worker>/api/admin/seed -H 'content-type: application/json' \
  -d '{"token":"<SEED_TOKEN>"}'
```

### Cross-origin details worth knowing

**CORS is an allowlist, never a wildcard.** `ALLOWED_ORIGINS` in `wrangler.toml`
names the Pages origin. `*` would let any site on the internet call the API with a
token it had obtained and would make the browser's own origin check worthless.

**Artefacts use signed links.** A PDF opened in a new tab and an HTML preview in an
iframe are browser navigations: they cannot send an `Authorization` header, and the
session cookie does not travel to another origin. So the API mints a short-lived
HMAC-signed URL per artefact when it returns the report metadata. The signature
covers the report, the artefact kind and the expiry, and is only ever issued to a
caller that already passed the scope check.

**`ENVIRONMENT` defaults to `production`.** Development relaxes CORS to localhost and
lets `/api/admin/seed` run without a token, so the deployed value must never be
`development`. `.dev.vars` overrides it locally and is gitignored.

Putting the Worker behind a Cloudflare Access application makes the portal pick the
identity up from `Cf-Access-Authenticated-User-Email` automatically; the email and
password path stays as the local fallback. The advisor/client boundary is enforced in
`resolveClientScope` — one function, every client-scoped route.

---

## Commands

| | |
|---|---|
| `npm run dev` | Worker + portals on :8788 |
| `npm run migrate` | apply D1 migrations locally |
| `npm run demo` | the end-to-end journey, narrated |
| `npm run build:graph` | regenerate the Rivet project from the prompts |
| `npm run run:report -- --client cli_albert` | run the graph headlessly |
| `npm run run:overview` | run the daily overview graph |
| `npm run verify` | 30 checks on the engine: formatting rules, return methods, the guardrail, report validation, the PDF |
| `npm run verify:live` | the above plus the live provider chain and the running API |
| `npm run setup:cloudflare` | create D1, KV and R2, set the secrets, migrate |
| `npm run deploy:worker` | deploy the API and point the portal at it |

---

## Known limits

- Fund quota values are simulated, because no public feed exists for Brazilian FIC
  vehicles. Production reads the custodian file or the CVM daily quota series.
- The advisor approval gate is a portal action that stage 09 reads back, not a
  `waitForEvent` node inside the graph run. The graph is written so that swap is a
  one-node change.
- TradingView is used through its public scanner endpoint. A licensed feed would
  replace `src/adapters/tradingview.js` behind the same interface.
- Email is rendered and stored, not sent. Adding a provider is one adapter.
- `PBKDF2_ITERATIONS` is 100,000, the Cloudflare Workers ceiling. The local
  emulator does not enforce that cap, so a higher value passes every local test
  and fails only on a real deploy.
- `docs/implementation-report.md` covers what one more month would buy.
