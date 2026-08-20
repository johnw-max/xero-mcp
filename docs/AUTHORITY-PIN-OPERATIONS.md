# Authority Pin Operations

## What Are These Hashes?

When deploying writes to Xero, the MCP server pins two hashes to verify operational safety:

1. **XERO_STANDING_DELEGATIONS_CONFIG_SHA256**: SHA256 of the exact raw bytes of `XERO_STANDING_DELEGATIONS_JSON`. This pins the specific delegation content.
2. **XERO_EXPECTED_AUTHORITY_SNAPSHOT_SHA256**: Hash of the complete authority snapshot (schema version, provider ID, revision, write-kill-switch state, and all delegations). This verifies that the deployment's understanding of authority matches what the database recorded.

## When Each Hash Must Change

### XERO_STANDING_DELEGATIONS_CONFIG_SHA256
Re-compute whenever `XERO_STANDING_DELEGATIONS_JSON` is edited.

### XERO_EXPECTED_AUTHORITY_SNAPSHOT_SHA256
Changes automatically whenever:
- The snapshot hash changes (always when delegations change)
- The revision number changes
- The write-kill-switch state changes

## Revision Monotonicity and Rollback

**The revision number only increases.** The database enforces this:
- Refuses the same revision with different content
- Refuses any revision lower than the current one

**To rollback**, republish the OLD delegation content under a HIGHER revision number—never by decreasing the revision.

## 3-Step Runbook

### 1. Edit Your Candidate Env File

```bash
# Edit your candidate.env with new delegation content and/or settings
nano candidate.env
```

### 2. Run the Pin Script

```bash
node scripts/release/compute-authority-pins.mjs --env path/to/candidate.env [--revision N]
```

- If `--revision N` is omitted, the script uses `XERO_AUTHORITY_REVISION` from `candidate.env`
- The script prints three lines: the two hashes and the revision used

Example output:
```
XERO_STANDING_DELEGATIONS_CONFIG_SHA256=abc123...
XERO_EXPECTED_AUTHORITY_SNAPSHOT_SHA256=def456...
XERO_AUTHORITY_REVISION=2
```

### 3. Paste Into Candidate Env and Restart

Copy the three printed lines into `candidate.env`, replacing any existing values:

```bash
# In candidate.env, update these three lines with the script's output
XERO_STANDING_DELEGATIONS_CONFIG_SHA256=<paste here>
XERO_EXPECTED_AUTHORITY_SNAPSHOT_SHA256=<paste here>
XERO_AUTHORITY_REVISION=<paste here>
```

Then restart your MCP container to load the new configuration.

## Why the pin names the content hash (verified in production, 2026-08-19)

The snapshot hash folds the publication revision into itself. A build pins the
authority it was built to honour, so pinning the snapshot hash meant that any
later publication invalidated every build's pin — including a republication of
the *identical* authority. Since the revision may never decrease, a rollback has
to republish the older content under a **higher** revision, which changed the
hash, which left the rolled-back build serving `READ_ONLY` without saying why.
Rollback was therefore not merely awkward but structurally impossible.

The pin now names `contentHash`, which covers what the authority grants —
provider, kill switch, canonical delegations — and nothing about when it was
published. `readyz` exposes it as `authorityContentHash`.

Verified against the live deployment: with the authority content unchanged and
only the revision moved from 6 to 7, the server stayed `ready` /
`WRITE_ENABLED` and reported the same `authorityContentHash`
(`38490ba61f52…`). Under the old rule that same step would have failed the pin
and dropped the server to read-only.

Changing what the authority actually grants still changes the content hash, and
still fails the pin closed — that protection is unchanged.
