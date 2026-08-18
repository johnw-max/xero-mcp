# Cross-MCP case correspondence — design record

Date: 2026-08-18. Tracked as XF-030.

## The problem

The delivered architecture mounts two MCPs on one accountant-facing agent: a
Google Drive MCP (owned by another team) for client material, and this Xero MCP
for the accounting write. The Drive MCP has its own case concept. Nothing today
makes the two cases correspond.

Consequence: material collected under Drive case A can be written into Xero
organisation B. The Xero MCP can prove **which organisation it wrote to** and
**that the write matched the compiled Case**. It cannot prove **that the material
belongs to that organisation's client**. That is precisely the 串帐 failure this
product exists to prevent, and it survives every control described elsewhere in
this evidence folder.

## The constraint

Only this Xero MCP may change. The Drive MCP and the platform are owned elsewhere
and are fixed. So we cannot validate the upstream case, and we cannot ask the
upstream to send us anything it does not already have.

## What is achievable inside that constraint

We cannot establish that a Drive case is the *right* one. We can establish that a
Drive case is *consistent* — that it never spans two Xero organisations.

That is a weaker claim than "correct", but it is the claim that actually closes
串帐. Cross-account contamination requires one upstream engagement's material to
reach two different sets of books. Forbid that, and the failure mode is gone even
though the upstream remains unverified.

## The control

**Trust on first use, many-to-one, fail-closed thereafter.**

- An upstream source case binds to exactly one Xero tenant, the first time it is
  cited.
- One Xero tenant may hold many upstream source cases — a client legitimately has
  many engagements. That direction stays open.
- Any later Case citing a bound source case against a different tenant is refused
  with `SOURCE_CASE_TENANT_CONFLICT`, `providerMutationPossible: false`, before any
  provider write.
- The cited source case is immutable across a Case's versions; changing it is
  refused with `SOURCE_CASE_CHANGED`.

The binding is enforced by a database primary key, not by service logic alone, so
two concurrent binds cannot both win.

### Why this shape

- **Optional input.** When no source case is cited, behaviour is exactly as today
  and the evidence records `SOURCE_CASE_ABSENT`. The control cannot break existing
  callers, and it degrades honestly rather than silently.
- **The reference is hashed, never stored in the clear.** We hold a digest and the
  source system name. We do not need to know what a Drive case is called to know
  two Cases cite the same one.
- **Many-to-one, not one-to-one.** One-to-one would break the real workflow: a
  client has several engagements, and a firm has several clients per organisation
  arrangement. Only the contaminating direction is forbidden.
- **First use is trusted, deliberately.** We have no upstream authority to consult.
  Pretending otherwise would be the dishonesty this codebase otherwise avoids. The
  evidence distinguishes `SOURCE_CASE_BOUND_FIRST_USE` from
  `SOURCE_CASE_BOUND_CONFIRMED` so a reader can see which one they are relying on.

### What this does NOT claim

It does not verify the upstream material, the original file, the uploader, or that
the Drive case belongs to the client whose books were written. `source_truth_claim`
stays `NOT_VERIFIED` and `original_file_verified` stays `false`. The new field
records pairing consistency only.

## Residual risk after this control

If the very first Case for an upstream source case cites the wrong Xero
organisation, that wrong pairing is what gets locked in. The control makes the
mistake *consistent*, not *correct* — every later document for that engagement goes
to the same wrong organisation rather than being scattered.

That is a real limit and worth stating plainly. It is also a much better failure
than the current one: a single, detectable, reviewable misbinding instead of silent
per-document drift. Surfacing the organisation name in the execute confirmation
(see XF-027) is the natural complement — it puts the first binding in front of a
human at the moment it is created.
