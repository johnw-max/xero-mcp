# G7 — Final verdict and handoff

Run ID `2026-08-18-final-acceptance`. Date 2026-08-18.
Candidate fingerprint `8d8371cf087d0ced5b81b81a7a928b7a106b2f62e40710ed5aca8e17eba64287`
(re-frozen after the XF-019 harness extension; the earlier `dbf0ce4d…` freeze predates it).

## Verdict: **BLOCKED**

Upgraded from PARTIAL after live testing on 2026-08-18. The round cannot pass as
written, and the reason is not a defect — it is that the Definition of Done names a
test object the product deliberately refuses to create autonomously.

The DoD fixes the object as one **Supplier Bill DRAFT under Standing Delegation**.
The product classifies SUPPLIER_BILL as `NON_UNIQUE_EXCLUSIVE_WRITER` — correctly,
because Xero does not enforce uniqueness on ACCPAY bill numbers the way it does on
ACCREC invoice numbers — and therefore requires verified firm-governance
exclusive-writer authority before it will autonomously create one. Neither the local
harness nor the deployed environment has that authority configured, and the round
explicitly declared firm governance out of scope. Execute fails closed with
`PROVIDER_BUSINESS_COORDINATE_ATOMICITY_UNPROVEN`. This is XF-021 and it needs a
decision from the user, not an engineering fix.

Separately, Agent2 cannot host G6 today for three independent reasons (XF-002):
it runs a build predating this round's P0 fix, it is `READ_ONLY` with the process
write gate closed, and it has zero standing delegations configured.

No real Xero object was created in this round, so nothing here permits the claim
"已写入 Xero DRAFT".

## The four fact layers

| Layer | Status | What it actually proves |
|---|---|---|
| `SOURCE_CODE` | **ESTABLISHED** | Typecheck, build and static verification pass. 1,562 tests run, 1,425 pass, zero genuine product-runtime failures. All 26 failures sit inside the repository's own experimental governance tooling. |
| `LOCAL_RUNTIME` | **ESTABLISHED (synthetic Provider, customer-invoice route only)** | One deployment-equivalent natural-language chain with mandatory Skill loading, zero schema repair, one write, receipt and exact same-ID readback. Duplicate protection now proven at three layers with `provider_write_count: 1`. 16 files / 110 PostgreSQL tests on a fresh disposable database. Four real SIGKILL/restart boundaries, independently replayed. The **supplier-bill route is refused and therefore unproven**. |
| `AGENT2_LIVE` | **NOT ESTABLISHED — and provably not the candidate** | Unauthenticated preflight on 2026-08-18 shows the deployed MCP requires migration 039 against the candidate's 040, with differing `attestationHash` and `acceptanceSourceSha256`. Identical `toolsetHash`, so the public surface looks correct while the enforcement stack differs. Also `READ_ONLY`, write gate closed, zero standing delegations. See `agent2-preflight/AGENT2-DEPLOYMENT-PREFLIGHT.md`. |
| `PROVIDER_DURABLE` | **NOT ESTABLISHED** | Every write in this round crossed `LOCAL_SYNTHETIC_PROVIDER_SDK_BOUNDARY`. No real Xero tenant was contacted. No real Xero object ID exists. |

## What is safe to say

- The candidate compiles, builds, and passes its product-runtime test suite.
- On a deployment-equivalent local Agent with the real Skill bundle mounted and the
  narrow 5-tool Accounting Case profile over the unchanged 28-tool backend, a
  natural-language accounting request produces exactly one governed write with a
  Provider object ID, a durable receipt whose idempotency key equals the durable
  mutation request ID, and an exact same-ID readback — with zero schema-repair
  retries.
- The durable state machine survives process kill at all four governed crash
  boundaries, with one write, zero writes, one write and one idempotent replay
  respectively — never a duplicate.
- The Agent's final answer is evidence-bound: it does not upgrade a ledger readback
  into source-file verification, and it correctly reports what it could not confirm.

## What is not safe to say

- That anything was written to Xero. It was not.
- That Agent2 works, is correctly configured, or routes to the right MCP and tenant.
  XF-002 remains open and unverified.
- That Gate L passed. It did not run past its first step.
- That the 18-requirement / 90-claim governance framework passes. It explicitly does
  not (XF-011), and it is deferred, not closed.

## Gate status

| Gate | Status |
|---|---|
| G0 baseline and contract | PASS |
| G1 P0/P1 fixes and targeted regression | PASS — XF-001, 003, 004, 012, 013, 014 fixed pending review; 008, 009, 010 closed |
| G2 local deployment-equivalent Agent, full scenario matrix | PARTIAL — customer-invoice route PASS at synthetic boundary (`local-agent/MAIN-CHAIN-06-RESULT.md`, `LOCAL-CONVERSATION-RESULTS.md`); duplicate protection now proven; supplier-bill route refused (XF-021) |
| G3 local host against real Xero test tenant | **NOT RUN — BLOCKED** |
| G4 Gate L, attestation, candidate freeze | **PARTIAL** — candidate frozen; Gate L `NOT_IMPLIED`, see `LOCAL-GATE-RESULTS.md` |
| G5 Agent2 deployment and identity pre-check | **RUN — NO-GO.** Deployed build is not the candidate; write disabled; no standing delegation |
| G6 Agent2 minimal online DRAFT | **NOT RUN — BLOCKED** |
| G7 independent audit and final verdict | This document. Independent reviewer sign-off outstanding. |

## Blockers, and exactly what unblocks each

### B1 — Real Xero test organisation (blocks G3, and therefore G6)

There is no `.env` in the repository and no stored Xero credential or token
anywhere in it. The credentials file in the parent directory holds client IDs and
secrets for the `Work` and `Agent2` OAuth clients, but a Provider write also needs
a live OAuth authorization against a dedicated Xero test organisation, which is an
interactive browser consent that must be performed by a person.

To unblock, the operator must:

1. Nominate the dedicated Xero **test** organisation and confirm it is not a
   production tenant.
2. Confirm the existing Contact, Account and Tax Rate the Supplier Bill will use.
3. Complete the OAuth authorization in a browser and confirm the granted scopes are
   exactly the narrowed `xero.draft.write` set from XF-003 — old authorizations may
   still carry the withdrawn Manual Journal and item/settings scopes until
   re-authorized.
4. Provide the resulting configuration to the local host and enable the write gate
   for that single installation and tenant only.

I did not attempt any of this: entering credentials and granting OAuth consent is
the operator's action, not mine.

### B2 — Codex account quota (blocks XF-016, and therefore Gate L step 3)

The run 06 raw evidence exists and replays, but the validated, source-bound
evidence document was never emitted — the generator stopped at a Codex account
usage limit before its final summary step. Gate L consumes that document, not the
raw directory. Unblock by restoring quota and re-running
`npm run evidence:local-agent --evidence <path>` against the frozen candidate.

### B3 — Host review authority (blocks Gate L step 1, and therefore all of G4)

Gate L refuses at `independent-review-live` on structural grounds: a
candidate-repository driver cannot authenticate its own reviewer provenance. It
requires an out-of-repository pinned parent driver that captures the immutable
inputs, spawns a signed reviewer, verifies the raw lifecycle, and signs a receipt
with a host-held key. No such authority exists in this environment, so **a Gate L
PASS is unreachable from inside the repository**. Either provision that authority,
or make an explicit, recorded product decision to accept the deterministic evidence
in its place — and stop describing the round's exit criterion as "Gate L PASS" if
so.

### B4 — Agent2 deployment (blocks G5 and G6)

G5 requires deploying the same image digest that Gate L accepted. No release bundle
or OCI artifact has been built from the frozen candidate, and Gate L has not
accepted anything. Deployment also touches a live host and is an outward-facing
action, so it needs explicit authorization regardless of readiness. See
`RELEASE-BUNDLE-FEASIBILITY.md` for what the release artifact steps require.

## Repository push readiness

`PUSH-READINESS-AUDIT.md` verdict: **READY-WITH-FIXES**, no P0 blockers.

The pending ~431-path diff introduces no secrets, no private keys, no `.env`
values, and no credentials — verified across the worktree and full git history. Its
total weight is about 9 MB. A 7-commit grouping is proposed in that report.

XF-018 is settled. The GitHub remote is public and **already** carries a real Xero
Developer App client ID and the production hostname in previously pushed commits;
no client secret leaked. User decision of 2026-08-18: **accepted as low risk**, the
Xero app registration is not being rotated. Standing condition: redact client IDs
and production hostnames from any new document before committing it, and revisit
immediately if a secret, refresh token or tenant credential ever appears in the
repository.

## Recommended next sequence

1. **Decide XF-021.** This gates everything else. Either configure verified
   firm-governance exclusive-writer authority so the Supplier Bill can be created
   autonomously, or change the round's fixed object to a Customer Invoice with a
   formal document number, or move the Supplier Bill write behind explicit human
   approval. Until this is settled the Definition of Done cannot be met as written.
2. ~~Settle XF-018~~ — done: accepted as low risk, 2026-08-18.
3. Commit the frozen candidate on the working branch per the 7-commit plan.
4. Redeploy: build the release artifact from the re-frozen candidate, migrate the
   deployment to 040, configure the standing delegation for whichever action
   step 1 selects, and re-run the G5 preflight requiring every identity field to
   match before opening any write gate.
5. Arrange the real Xero test organisation and run G3 locally on the object chosen
   in step 1.
6. Only after G3 passes, open the Agent2 write gate for exactly one installation
   and tenant and run the single G6 chain.

Step 1 is a product decision and costs nothing to make. Steps 4-6 are where the
remaining risk lives. Steps 2 and 3 are bookkeeping.

## Blockers no longer standing

- **Codex quota (was B2).** Superseded: the Agent role was executed directly by
  Claude against the same MCP server and the same Skill bundle, producing the
  session A and session B evidence. The Codex-specific evidence *document* still
  cannot be regenerated (XF-016), so Gate L's `local-agent-evidence` step remains
  blocked, but local acceptance testing itself is no longer quota-bound.
