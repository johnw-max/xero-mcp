# Agent-under-test acceptance loop

## Why this exists

Earlier local acceptance runs had one role playing both sides: the same context
wrote the user's turns and decided the agent's tool calls. That cannot falsify
the agent — it can only confirm whatever the author already believed. The
Codex-driven runs avoided this, but became unavailable when that account ran out
of quota, and their evidence schema was welded to one executable identity.

This harness restores the separation without depending on any one vendor:

| Role | Who | Sees |
|---|---|---|
| Product agent | a subagent, cold context | mounted instructions + Skills + the MCP tool surface. **Never the repository.** |
| Accountant | the supervising session | the source documents and the business intent |
| Oracle | the server audit | tool calls, provider write count, receipts, readbacks, refusals |

The agent under test is mounted under a temporary root, so "it did not read the
source" is checkable rather than promised: any repository path appearing in its
transcript is a protocol violation and invalidates the run.

## Running one conversation

```bash
node harness/agent-under-test/mount-agent-workspace.mjs
```

Prints a manifest with the ephemeral workspace, the mounted Skill paths, the
`step_dir` the agent drives the MCP through, and the `server_audit` path. One
server lives for one conversation so state is shared across turns, exactly as a
real session would be.

Spawn the product agent with the mounted paths and the driver protocol, give it
the accountant's first turn, then continue the same agent for each later turn so
its context persists. Stop the conversation by touching `STOP` in `step_dir`;
the server writes its audit on exit.

## What the oracle checks

The audit, not the agent's prose, decides the outcome:

- `provider_write_count` against what the scenario expected — this is the single
  most important number;
- every write carries a provider object ID, a receipt, and an exact same-ID
  readback whose economic fields match;
- refusals carry the expected reason codes and `providerMutationPossible: false`;
- the agent never claimed a state the audit does not support.

An agent that produces a correct-looking narrative while the audit shows no
write, a second write, or a missing readback has failed, regardless of how
convincing the narrative is.

## The loop

```
mount → converse → read audit → triage findings → fix → re-mount → converse
```

Each iteration writes its findings and the raw step files under the run's
evidence folder. A finding is only closed when a later run reproduces the same
scenario and the audit shows the corrected behaviour — never on the strength of
a code change alone.

Fix at the first failing layer: mounted Skill wording, agent instructions, tool
schema, or the runtime. Do not fix a runtime refusal by softening the Skill into
avoiding the case, and never relax a control to make a conversation succeed —
a refusal that surprised the agent is usually the control working.
