# Review of the acceptance loop mechanism

Date: 2026-08-18. Reviewing
`docs/XERO-MCP-NEXT-PHASE-EXECUTION-AND-ACCEPTANCE-LOOP-2026-08-18.md` against
what actually happened when it was executed.

The loop's *content* is good: the gate ordering, the fail-closed instincts, the
four fact layers in G7, and the refusal to let chat text count as evidence are all
sound and worth keeping. The defects below are all in the loop's *mechanics* —
places where it cannot terminate, or where it spends effort before checking a
cheap precondition. Each correction is a tightening. None adds scope.

## D1 — The loop deadlocks at G4 and can never legally reach G5/G6

**What the plan says.** §4: "上一个 Gate 没有机器证据，不进入下一个 Gate."
G4 requires Gate L to pass.

**What is true.** Gate L's first step, `independent-review-live`, returns
`LOCAL_EVIDENCE_UNTRUSTED` / `gate_l_claim: NOT_IMPLIED` unconditionally, by
design: a candidate repository cannot authenticate its own reviewer provenance. It
demands an out-of-repository pinned parent driver holding a host key. No such
authority exists.

So the promotion rule makes G5 and G6 unreachable — not difficult, *unreachable* —
while the plan simultaneously schedules WP-08 and WP-09 to perform them. The round
cannot terminate in any state the plan recognises.

**Correction.** Gate L must stop being written as an achievable local gate. Either
provision the host authority, or split it explicitly:

- `Gate L-local` — the fourteen mechanically checkable steps (typecheck, build,
  regression, PostgreSQL, HTTP, static, diff, bundle, OCI, smoke, evidence
  validation). This is achievable today and should be the promotion criterion.
- `Gate L-attested` — the independent-review signature. Record it as an
  out-of-band control with a named human owner and an explicit "not obtained"
  state, so a round can close as `PASS (unattested)` rather than deadlock.

Today's round would then read: G4 = `Gate L-local` reachable once D3 is fixed,
`Gate L-attested` = NOT OBTAINED, owner unassigned.

## D2 — The round fixed a test object without checking the product can execute it

**What happened.** The Definition of Done fixed "one Supplier Bill DRAFT under
Standing Delegation" in §2.1, and §3 declared firm governance out of scope. Those
two statements are mutually exclusive: the product classifies SUPPLIER_BILL as
`NON_UNIQUE_EXCLUSIVE_WRITER` and requires verified firm-governance
exclusive-writer authority before creating one autonomously. The round was
therefore unsatisfiable from the moment it was written, and nobody noticed for six
agent runs — which all silently exercised a *customer invoice* instead.

**Root cause in the loop.** There is no step between "choose the object" and "spend
the budget" that asks whether the product will actually execute that object under
the chosen authority model.

**Correction.** Insert a **G0.5 capability feasibility probe**, before WP-01 and
before any model spend: run the smallest possible end-to-end write of the exact
DoD object on the harness. Roughly four tool calls. If it refuses, the object or
the authority model is wrong and the round is re-scoped immediately, at a cost of
minutes. This single check would have saved this entire round's misdirection.

Cheap and non-negotiable, because a refusal here is not a bug to fix — it is the
plan discovering it asked for the wrong thing.

## D3 — Gate currency is a single generated document with a single generator

**What happened.** The local-agent chain succeeded, its raw evidence was captured
and independently replayable — and Gate L still could not consume it, because the
gate reads a *validated evidence document* that the generator failed to emit when
its model account hit a usage limit (XF-016). Valid evidence existed; the gate
could not see it.

**Correction.** The repository already has the right pattern elsewhere:
`process-crash-evidence-lib.mjs` recomputes crash evidence from raw artifacts and
verifies it independently. The local-agent evidence step should accept the same
shape — raw artifacts plus an independent recomputation — rather than trusting only
a document one generator emits. Evidence should be reconstructible from what was
actually observed, not lost because the tool that observed it stopped.

## D4 — The agent runtime was a hardcoded constant, not a parameter

**What happened.** The harness pins the Codex executable, hashes it, and records
its identity in the evidence schema. When that account ran out of quota, the whole
acceptance line stopped, even though the thing under test — the MCP server, its
Skills, its policy and its controls — was entirely unaffected.

The substitution that unblocked it (driving the same MCP server, same Skills, same
tool profile, from a different agent runtime) produced *server-side* evidence of
identical quality: the refusals, guards, receipts and readbacks are the product's
behaviour regardless of which model sits in front of it.

**Correction.** Treat the agent runtime as a recorded variable, not a fixed
identity. The evidence should state which runtime executed the chain and hold it to
the same rules (loaded the mandatory Skills, made no unaudited calls, claimed
nothing without a receipt). Reserve "same runtime as production" as a requirement
for the *online* gate only, where it genuinely matters.

## D5 — Harness/product capability parity was assumed, never verified

**What happened.** The harness was described throughout as "deployment-equivalent",
but its synthetic provider did not implement supplier-bill creation at all — both
methods threw — and its standing-delegation fixture granted only one action. The
harness could not have executed the round's stated object under any circumstances.

**Correction.** Add one mechanical check to G2: for every action the round intends
to exercise, assert the harness implements it and the fixture authorises it.
This is a short assertion over `AccountingProvider` methods and the delegation
fixture's `action_ids`. It fails in milliseconds instead of after a paid run.

## D6 — Deployment identity drift had no cheap standing check

**What happened.** The deployed instance runs a build predating this round's P0
fix — different `requiredMigration`, `attestationHash` and `acceptanceSourceSha256`
— while presenting an *identical* `toolsetHash` and tool count. Every casual check
looked correct. It was caught only because G5 was finally run properly.

**Correction.** The deployment already exposes everything needed at an
unauthenticated `/healthz`. Make a single identity diff against the frozen
candidate a standing check: at the start of every round, before every online step,
and after every deploy. One command, no credentials, catches this entire class
instantly. It should also gate the write switch mechanically, not by discipline.

## D7 — Budget is allocated by work package, not by information gained

**What the plan says.** §6 allocates 40 relative units across WP-00..WP-10, with
about three quarters spent locally before Agent2.

**What actually produced the round's value.** The findings that changed the
outcome — D2/XF-021, the deployment drift, the duplicate-protection proof, the
snapshot-monitor defect — each cost minutes and came from cheap, targeted probes.
The expensive line item, repeated full natural-language agent runs, produced
diminishing returns after run 04: runs 05 and 06 mostly re-proved run 04's result
at full price.

**Correction.** Order work by information-per-unit-cost, not by pipeline position.
Cheap deterministic probes (capability feasibility, harness parity, identity diff,
schema and monetary reconciliation) run first and exhaustively; expensive
conversational runs are reserved for what only they can establish — that the agent
behaves honestly in natural language — and run once per frozen candidate, not once
per iteration.

## Corrections adopted for the remainder of this round

Applied now, in priority order:

1. **G0.5 feasibility probe** — done retroactively; it is what produced XF-021.
   The object is now Customer Invoice, verified executable end to end.
2. **Identity diff as a standing gate** — done; `/healthz` versus the frozen
   candidate is now recorded in `agent2-preflight/`, and the write switch stays
   closed until it matches.
3. **Harness parity assertion** — partially done: supplier-bill support was added
   to the harness and the delegation fixture, so the parity gap that blocked
   testing is closed even though the route is out of scope for this round.
4. **Cheap probes before expensive runs** — in force: monetary reconciliation,
   duplicate protection and injection resistance are being exercised by
   deterministic scenario runs rather than by paid conversational chains.
5. **Gate L split** — recommended, not yet adopted. It changes the round's
   promotion criterion and is the user's call.
6. **Evidence reconstructible from raw** — recommended, not adopted. It is a real
   change to the gate's contract and should not be made mid-round.

Items 5 and 6 are the two that need a decision. Everything else is already applied.
