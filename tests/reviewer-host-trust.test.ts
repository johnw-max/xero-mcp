import { createHash } from "node:crypto";
import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildIndependentReviewCodexCommand,
  createIndependentReviewSanitizedEnvironment,
  independentReviewEnvironmentPolicy,
  INDEPENDENT_REVIEW_MODEL,
  INDEPENDENT_REVIEW_REASONING_EFFORT,
} from "../scripts/review/independent-review-evidence-lib.mjs";
import {
  inspectIndependentReviewCodexIdentity,
  normalizeIndependentReviewLiveContext,
} from "../scripts/review/independent-review-shard-evidence-lib.mjs";

const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

function liveContext() {
  return {
    schema_version: "1.0",
    mode: "LOCAL_ACCEPTANCE_GATE_LIVE",
    gate_run_id: "11111111-1111-4111-8111-111111111111",
    live_challenge: "a".repeat(64),
    source_fingerprint_sha256: "b".repeat(64),
    source_snapshot_sha256: "c".repeat(64),
    source_snapshot_manifest_sha256: "d".repeat(64),
    source_snapshot_attestation_sha256: "e".repeat(64),
    supplemental_inputs_sha256: "f".repeat(64),
    supplemental_manifest_sha256: "1".repeat(64),
    approved_review_codex_sha256: "2".repeat(64),
    approved_review_runtime_sha256: "3".repeat(64),
  };
}

describe("repo-local reviewer provenance hardening", () => {
  it("pins direct argv, model, reasoning and a no-inherit shell environment without wrappers", () => {
    const command = buildIndependentReviewCodexCommand({
      codexPath: "/approved/codex",
      repoRoot: "/snapshot/source",
      outputSchemaPath: "/snapshot/source/schema.json",
      finalVerdictPath: "/evidence/final.json",
    });
    expect(command.slice(0, 2)).toEqual(["/approved/codex", "exec"]);
    expect(command).toContain("--strict-config");
    expect(command).toContain(INDEPENDENT_REVIEW_MODEL);
    expect(command).toContain(`model_reasoning_effort=${JSON.stringify(INDEPENDENT_REVIEW_REASONING_EFFORT)}`);
    expect(command).toContain("shell_environment_policy.inherit=none");
    expect(command).not.toContain("/bin/sh");
    expect(command).not.toContain("/bin/bash");
    expect(command).not.toContain("/bin/zsh");
    expect(command).not.toContain("-lc");
  });

  it("rejects preload and shell/config override variables before constructing the child environment", () => {
    for (const name of ["NODE_OPTIONS", "NODE_PATH", "BASH_ENV", "ZDOTDIR", "DYLD_INSERT_LIBRARIES"]) {
      expect(() => createIndependentReviewSanitizedEnvironment({ HOME: "/host", [name]: "attacker" }))
        .toThrow(`INDEPENDENT_REVIEW_ENVIRONMENT_PRELOAD_REJECTED:${name}`);
    }
    const environment = createIndependentReviewSanitizedEnvironment({
      HOME: "/host",
      TMPDIR: "/tmp/reviewer",
      PATH: "/attacker/bin",
      SAFE_BUT_UNAPPROVED: "discard-me",
    });
    expect(environment).toEqual({
      HOME: "/host",
      TMPDIR: "/tmp/reviewer",
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      LC_CTYPE: "C.UTF-8",
      NO_COLOR: "1",
      CODEX_CI: "1",
      SHELL: "/bin/sh",
    });
    expect(independentReviewEnvironmentPolicy().sha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("rejects an unsigned fake Codex even when the host digest and version command match", async () => {
    const root = await mkdtemp(join(tmpdir(), "reviewer-host-trust-"));
    const fake = join(root, "codex");
    const bytes = Buffer.from("#!/bin/sh\nprintf 'codex fixture 1.0\\n'\n", "utf8");
    try {
      await writeFile(fake, bytes);
      await chmod(fake, 0o755);
      const canonicalFake = await realpath(fake);
      await expect(inspectIndependentReviewCodexIdentity({
        codexPath: canonicalFake,
        repoRoot: root,
        approvedExecutableSha256: digest(bytes),
        allowedCodexExecutablePaths: [canonicalFake],
      })).rejects.toThrow("INDEPENDENT_REVIEW_SHARD_CODEX_SIGNATURE_VERIFY_FAILED");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("binds the raw challenge by hash and rejects a malformed Gate-live context", () => {
    const context = liveContext();
    expect(normalizeIndependentReviewLiveContext(context)).toMatchObject({
      gate_run_id: context.gate_run_id,
      live_challenge_sha256: digest(context.live_challenge),
      approved_review_runtime_sha256: context.approved_review_runtime_sha256,
    });
    expect(() => normalizeIndependentReviewLiveContext({ ...context, live_challenge: "forged" }))
      .toThrow("INDEPENDENT_REVIEW_LIVE_CONTEXT_IDENTITY_INVALID");
  });
});
