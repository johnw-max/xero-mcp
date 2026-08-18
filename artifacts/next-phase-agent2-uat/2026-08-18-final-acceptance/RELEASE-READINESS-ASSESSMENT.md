# Xero MCP — release readiness assessment

Date: 2026-08-18. Written against the delivery architecture as described: a
LibreChat platform where an accounting firm receives several agents, each
mounting different MCPs, skills and prompts. Two agents matter here — a
client-facing intake agent using the Google Drive MCP, and an accountant-facing
agent mounting the Drive MCP **and** this Xero MCP, which reads client material,
performs accounting analysis under skills, and finally writes to Xero.

The historical failure this work exists to eliminate is **串帐 — cross-account
contamination** — together with plain data errors.

## Short answer

**The Xero MCP's own quality is good — genuinely above average for this class of
system. It is not yet ready to release.**

The gap is not code quality. It is that no write from this candidate has ever
reached a real Xero organisation, the deployed instance is not this candidate, and
the place where 串帐 can still occur in the target architecture sits outside this
MCP's reach.

## Where the quality actually is

### Against 串帐, on the Xero side — strong

Independently reviewed and confirmed today:

- **Target binding is the only authorization.** Every ledger action requires an
  opaque `target_session_ref` bound to the verified OAuth installation principal
  and an immutable ledger binding. An organisation name in user text, chat memory,
  or an uploaded document is `USER_ASSERTED` and never authorises anything.
- **Identity resolution is full-tuple.** The database resolver requires workspace,
  subject type, subject id, agent, installation, binding and connection to match
  together. No partial match resolves.
- **No cross-request client or token caching** in `XeroClientManager` — the classic
  contamination vector in a multi-tenant broker, checked specifically and found
  clean.
- **Refresh-token reuse revokes the whole family**, and a raced refresh can only
  recover a strictly newer ACTIVE authorization, never a revoked one.
- **Scopes are re-validated against the broker after every refresh**, before any
  Xero call, and a scope reduction fails closed.
- **Business coordinate reservation** prevents the same document coordinate being
  claimed twice, even from a brand-new Case.

Independent security review of the auth, tenant-isolation and secret boundary
returned **0 P0 and 0 P1**, with four inert P2 hardening items.

### Against data errors — strong

- **Exact bigint HALF_UP arithmetic, no floats** anywhere in the compiler.
- **Deterministic validation with precise reason codes**, proven on real demo
  material: gross that does not reconcile, line tax contradicting document tax,
  and a wrong effective rate were each refused with named reason codes and
  **zero** provider writes.
- **Server owns the dangerous fields** — account codes, tax types, routes, tenant
  identity, receipts. A client cannot influence them.
- **Exact same-ID readback with zero tolerance** gates every success claim; the
  economic fields are compared, not just the ID.
- **Duplicate protection holds at three independent layers** — same-key replay,
  different-key re-execution, and a fresh Case reserving the same coordinate —
  measured at `provider_write_count: 1`.
- **Crash recovery** across four SIGKILL boundaries never produced a duplicate.
- **Injection carried inside a business field is inert**: no posted state, no
  behavioural change, description stored verbatim.
- 1,562 tests with **zero product-runtime failures**.

### The honesty property, which matters more than it looks

The system consistently refuses to claim what it cannot prove:
`source_truth_claim: NOT_VERIFIED`, `original_file_verified: false`,
`fact_origins: ["MODEL_EXTRACTED"]`, coverage asserted for the submitted set only,
DRAFT never described as posted. For a product whose failure mode is a confident
wrong answer, this is the right instinct and it is applied consistently.

## Why it is not ready

### 1. No real Xero write has ever been verified — the decisive gap

Every write in this entire round crossed a synthetic provider. **Not one real Xero
object ID exists.** For a component whose whole purpose is writing correctly into a
client's books, that is the gap that matters most.

There is already a concrete, identified way real Xero will differ (XF-029): the
readback validator is value-exact with `toleranceMinorUnits = 0`. If Xero's own
per-line tax rounding diverges from ours by a single cent, the draft is created in
Xero and then fails readback. That is fail-closed and safe, but it is untested
against the real provider, and it is the most likely way a first live run looks
broken.

**Nothing should be called ready until one real DRAFT round-trips with object ID,
receipt and matching readback.**

### 2. The deployed instance is not this candidate

`mcp.jiayuanwang.xyz` requires migration 039; the candidate requires 040 — the
migration carrying this round's P0 idempotency-recovery fix. `attestationHash` and
`acceptanceSourceSha256` both differ. The `toolsetHash` is identical, so the public
surface looks correct while the enforcement stack differs. Any prior online
impression of quality describes a different build.

### 3. Cross-MCP source-to-client binding — where 串帐 can still happen

This is the one I most want to flag, and it is **not** a Xero MCP defect.

In the target architecture the accountant's agent mounts both MCPs. Material for
client A arrives via the Drive MCP; the write goes to client A's Xero
organisation. The Xero MCP can prove **which organisation it wrote to** and **that
the write matched the compiled Case**. It cannot prove **that the material the
agent read from Drive belongs to that organisation's client**.

It is honest about exactly this — that is what `source_truth_claim: NOT_VERIFIED`
and `original_file_verified: false` mean. But the consequence is:

> 串帐 in the new architecture would not originate in the Xero MCP. It would
> originate in the agent pairing client A's document with client B's pinned
> organisation. From the Xero MCP's perspective a validly pinned organisation plus
> a well-formed Case is legitimate, and it will correctly write it.

Nothing inside this MCP can catch that. Closing it needs a platform-level binding:
material provenance from Drive — which folder, which client — carried into the Case
and checked against the pinned organisation. The Case already carries
`source_label`, `fact_origins` and `document_validity` as hooks, but nothing today
binds a Drive file identity to a Xero tenant.

This is the highest-leverage remaining work for the delivered product, and it is
architecture work spanning both MCPs, not Xero MCP work.

### 4. Related: per-conversation organisation pinning needs to be visible

A `target_session_ref` deliberately survives an organisation switch, so parallel
conversations can each hold a different client's books — correct for an accountant
working several clients at once (XF-027). Combined with a multi-MCP agent, it means
the agent must stay disciplined about which conversation holds which client. The
organisation name is currently surfaced at pin/read time; surfacing it again in the
execute confirmation is cheap insurance against exactly the failure this project
exists to prevent.

## Verdict

| Question | Answer |
|---|---|
| Is the Xero MCP's quality good? | **Yes.** Controls are coherent, fail-closed, and independently verified. No confirmed P0 in either review. |
| Does it need more optimisation? | **Not much on its own side.** Four P2 hardening items; no P0/P1 work outstanding. |
| Is it ready to release? | **No — not yet.** |

**Ready for:** controlled UAT against a real Xero organisation, on the candidate
build, with the write gate scoped to one installation and one tenant.

**Not ready for:** delivery to an accounting firm handling real client books, or
unattended posting.

## The shortest path to "ready"

1. Deploy the candidate and migrate to 040. Artifact is built, verified and already
   staged on the host.
2. Re-authorise the Agent2 installation — required anyway, since persisted
   `granted_scopes` are empty and the candidate revalidates scopes fail-closed
   (XF-025). This doubles as the XF-003 narrowed-scope closure evidence.
3. Run **one real DRAFT** on `Demo Company (Global)` with a round net figure, so
   the rounding boundary cannot confound the first result.
4. Run **a second real DRAFT** with a cents-rounded net, deliberately probing
   XF-029. Do not relax the zero tolerance to make it pass — if it diverges, that
   is the finding.
5. Then the Xero-writing component is releasable for controlled firm use.

Items 3 and 4 are the whole remaining question. Everything before them is
mechanical.

Separately, and before any real firm's data flows through both MCPs, decide how
material provenance binds to the Xero organisation. That is the 串帐 risk that
survives everything above.
