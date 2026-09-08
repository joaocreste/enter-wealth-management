# Implementation report

**Enter Asset Management — AI advisory portal**
Prepared for the XP working session · reporting month August 2026

---

## 1. What was wrong with the first version

The original workflow was four prompts in a chain: summarise the risk profile,
summarise the macro report, summarise the portfolio, then write a letter from the
three summaries. It ran, and it produced Portuguese prose. It could not be shown to a
client.

**It had no arithmetic.** No return was ever calculated. The model was handed a raw
position statement and asked to describe performance. The statement's "Rentabilidade"
column is a since-inception figure — LREN3 at −41.7%, HAPV3 at −74.58% — and nothing
in the workflow stopped a model from presenting those as the month's result. The one
file that could have supported a monthly calculation, `profitability_calc_wip.csv`,
was never opened by the graph.

**It had no sources.** Every number in the output was whatever the model chose to
repeat from its input, with no record of where it came from, when it was retrieved, or
whether it was still true. The macro report was dated February 2025 and was fed in as
if it were current.

**It could not tell stale data from live data.** Two of Albert's four equity
positions no longer exist under the tickers on the statement: MRFG3 became MBRF3 in
the Marfrig–BRF combination, and ARZZ3 became AZZA3 in the Arezzo–Soma combination.
No provider returns a price for either old ticker. The original workflow would have
carried the May 2025 valuations forward silently. The CDB in the statement matured in
September 2024, before the statement date.

**It had no recommendation logic.** The letter prompt said "make recommendations
aligned with the client's risk profile" and left the model to invent them, with no
market signal, no policy band, no concentration check and no restriction list. A model
asked that question will always produce a confident answer.

**It had no formatting.** The output was chat text. The two-page constraint, the
letter format and the brand were entirely manual.

**It had no state.** Nothing was versioned, nothing was stored, nothing could be
reproduced, and there was no advisor in the loop — the model's first draft was the
deliverable.

Underneath all of it sat one design error: **the model was the system.** Everything
the product needed to be right about — the return, the attribution, the exposure, the
suitability — was delegated to the least reliable component available.

---

## 2. The approach

**Invert the relationship. Code computes; the model writes.**

Every figure is produced by deterministic code before the model is called. The model
receives a `FACTS` object and a system prompt that forbids producing any number not in
it. Its job is language: explanation, personalisation, the sentence that makes a
−1.20% month understandable to someone who is not a professional investor.

The consequence is that the product degrades gracefully rather than catastrophically.
With no model provider configured, a deterministic renderer produces correct
Portuguese from the same facts, and the report records which path ran. A missing API
key makes the letter less fluent. It cannot make it wrong.

**Rivet orchestrates; it does not calculate.** Ten subgraphs, each named for the
stage it owns, each carrying a comment node stating what it guarantees. The graph is
the audit surface: someone who has never seen the code can read the canvas and know
what the system does and in what order. Financial arithmetic sits behind an API, in
tested modules, where it can be reasoned about.

**Make provenance a type, not a convention.** Every provider response returns a
source record — provider, instrument, requested range, retrieval timestamp, last
observation, and `fallback_for` when a fallback was used. The canonical report
validator rejects a report whose performance figures reference a source that is not in
the ledger. "Where did this number come from" is answerable for every number, in the
UI and in the stored report.

**Separate what the market says from what the client may do.** Two passes with
different vocabularies. The recommendation engine produces a market view from two
independent TradingView families, the client's weight, the policy band, concentration
and the advisor's own stance. The suitability layer then checks it against the
client's policy and can only make it more conservative. Both statements are printed
side by side, because they are different statements and collapsing them is how
unsuitable advice gets shipped.

**Build the two-page constraint into the renderer.** The PDF engine is written from
scratch, embeds the two brand typefaces, measures every block before drawing it, and
drops optional content in a fixed priority order if two pages would not hold. It
records which level it needed. A hard constraint that is checked at the end is a
constraint that gets violated in production.

**Keep the advisor in the loop and make the gate real.** The engine proposes; the
advisor decides in the portal; only approved items render into the letter.
Re-running the workflow refreshes the analysis and keeps the decisions — a decision is
reopened only when the underlying proposal materially changed. Without that, the
approval step is theatre, because any re-run silently discards it.

---

## 3. What was built

Against Albert's real book and live August 2026 data:

| | |
|---|---|
| Monthly return | **−1.20%** by Modified Dietz, benchmark **+1.76%**, excess **−2.96 p.p.** |
| Method | Selected from the data, not assumed. TWR where a daily valuation exists for the whole book; Modified Dietz where fund quotas are month-end only; the assumption is stated in the letter |
| Attribution | Reconciles exactly to the reported return, including a cash-and-unpriced residual line |
| FX | Decomposed: **+0.16 p.p.** of the month came from the currency, not the assets |
| Worst contributor | Hapvida, **−1.79 p.p.**, where the technical rating says Sell and 11 analysts say Buy |
| Benchmark | The client's own policy allocation, priced with real series — not an index chosen after the fact |
| Signals | Two TradingView families kept apart; four instruments have no analyst coverage and the record says so |
| Guardrail | Riza Lotus at 14.0% against a 12% issuer cap → *reduce required*; Hapvida grade 5 against a Moderado profile → *do not add*; Real Estate at 0% against a 3% floor → two candidates proposed |
| Data integrity | ARZZ3 and MRFG3 detected as unpriceable, successors mapped, cost basis carried |
| Output | One canonical object → HTML email, two-page Portuguese PDF, client portal view |
| Provenance | 27 source records persisted with the report |

Also delivered: a daily World Overview with 18 live indicators and 14 configurable
thresholds (four breached on the day of writing), a journal-to-portfolio impact table
mapping each event to the advisor's actual book, five demo clients with versioned
policies and snapshots, a meeting-preparation view, a portfolio editor that creates a
new versioned snapshot rather than mutating the old one, and an audit tab showing every
graph run, source record and approval.

---

## 4. What one more month would buy

**Week 1 — earn the right to be trusted with the numbers.**
Replace simulated fund quotas with the CVM daily quota series and the custodian file,
which removes the last simulated input. Add a golden-file test suite: a set of frozen
provider responses and the exact expected report JSON, so a change to the engine that
moves a client's return by a basis point fails in CI rather than in a letter. Add
true daily TWR by storing a daily portfolio valuation, which makes the method
selection a fact about the data rather than a limitation.

**Week 2 — make the advisor's judgement compound.**
Today the advisor's world view is a daily draft. It should be a versioned position
with a history, so "we were cautious on Brazilian equities from March" is a
retrievable claim, and so the recommendation engine can weight an advisor's stance by
how it has actually performed. Add outcome tracking: every recommendation gets a
follow-up record, and the advisor sees their own hit rate by factor family. That turns
the product from a report generator into something an advisor learns from.

**Week 3 — scale past one client at a time.**
The economics of this product are "three times as many clients", so the monthly run
must be a batch: a scheduled Worker fans out over the book, generates every letter,
and presents the advisor with a review queue ordered by how much judgement each one
needs — a portfolio with no breaches and no signal conflicts should take fifteen
seconds to approve. Move the approval gate inside the graph as a `waitForEvent` node
so the run itself pauses, which makes the audit trail one object instead of two.
Add email delivery and read receipts.

**Week 4 — the things compliance will ask about.**
Suitability rules are currently code with data-driven thresholds; they should be a
versioned rule set with an effective date, so a report can be re-evaluated against the
rules that applied when it was published. Add the jurisdiction gating and
professional-investor separation the brand guidelines require. Add a reproducibility
command that rebuilds any published report byte-for-byte from its stored inputs and
diffs it against what was sent — the single most useful artefact in a regulatory
conversation.

**The thing I would not do:** add more model calls. The remaining gaps in this
product are data gaps, workflow gaps and evidence gaps. None of them get smaller by
asking a language model a broader question.

---

## 5. Honest limitations

- Fund quota values in the demo are simulated and flagged everywhere they surface.
  Nothing else in the demo is.
- The advisor gate is a portal action read back by stage 09, not a pause inside the
  graph run.
- TradingView is consumed through its public scanner endpoint; a licensed feed would
  replace one adapter behind the same interface.
- The HTML email is rendered and stored, not sent.
- Historical measures — annualised return, volatility, Sharpe against the real CDI,
  maximum drawdown — are computed from a reconstructed return history for the period
  before the platform existed, and are labelled `classification: historical_measure`
  so they can never be presented as an expectation.
