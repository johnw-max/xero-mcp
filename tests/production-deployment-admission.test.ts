import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertPulledProductionImageIdentity,
  parseCapturedReleaseEnvironment,
  readTrustedRegularFile,
} from "../scripts/release/production-deployment-admission.mjs";
import {
  assertProductionAdmissionWrapperContract,
  assertProductionComposeContract,
  assertProductionCutoverContract,
  assertProductionRunbookContract,
} from "../scripts/release/production-deployment-contract.mjs";

const uid = process.getuid?.() ?? 0;

function capturedReleaseEnvironment(overrides: Record<string, string> = {}): Buffer {
  const values = {
    APP_IMAGE: `registry.example/xero@sha256:${"a".repeat(64)}`,
    XERO_ACCEPTANCE_GATE_RESULT: "/srv/xero-accounting-mcp/release/gate-result.json",
    XERO_ACCEPTANCE_GATE_RECEIPT: "/srv/xero-accounting-mcp/release/gate-receipt.json",
    XERO_ACCEPTED_OCI_RECEIPT: "/srv/xero-accounting-mcp/release/oci-receipt.json",
    XERO_ACCEPTED_OCI_ARTIFACT: "/srv/xero-accounting-mcp/release/oci.tar",
    XERO_WRITE_ENABLED: "false",
    ...overrides,
  };
  return Buffer.from(`${Object.entries(values).map(([key, value]) => `${key}=${value}`).join("\n")}\n`);
}

async function trustFixture() {
  const root = await mkdtemp(join(tmpdir(), "xero-production-trust-"));
  await chmod(root, 0o700);
  const file = join(root, "release.json");
  await writeFile(file, "accepted\n", { mode: 0o600 });
  return { root, file };
}

describe("production deployment admission", () => {
  it("captures a safe regular file once and rejects a world-writable root-owned file", async () => {
    const fixture = await trustFixture();
    try {
      await expect(readTrustedRegularFile(fixture.file, {
        anchor: fixture.root,
        expectedUid: uid,
        includeAnchorAncestors: false,
      })).resolves.toMatchObject({ content: Buffer.from("accepted\n") });
      await chmod(fixture.file, 0o666);
      await expect(readTrustedRegularFile(fixture.file, {
        anchor: fixture.root,
        expectedUid: uid,
        includeAnchorAncestors: false,
      })).rejects.toThrow("PRODUCTION_TRUST_FILE_UNSAFE");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects a writable ancestor and path replacement after O_NOFOLLOW open", async () => {
    const fixture = await trustFixture();
    try {
      const writable = join(fixture.root, "writable");
      await mkdir(writable, { mode: 0o700 });
      await chmod(writable, 0o777);
      const nested = join(writable, "receipt.json");
      await writeFile(nested, "{}\n", { mode: 0o600 });
      await expect(readTrustedRegularFile(nested, {
        anchor: fixture.root,
        expectedUid: uid,
        includeAnchorAncestors: false,
      })).rejects.toThrow("PRODUCTION_TRUST_DIRECTORY_UNSAFE");

      await chmod(writable, 0o700);
      await expect(readTrustedRegularFile(fixture.file, {
        anchor: fixture.root,
        expectedUid: uid,
        includeAnchorAncestors: false,
        afterOpen: async () => {
          await rename(fixture.file, join(fixture.root, "original.json"));
          await writeFile(fixture.file, "attacker\n", { mode: 0o600 });
        },
      })).rejects.toThrow("PRODUCTION_TRUST_FILE_CHANGED");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("accepts only current immutable release inputs and validates the write gate", () => {
    expect(parseCapturedReleaseEnvironment(capturedReleaseEnvironment())).toMatchObject({
      APP_IMAGE: `registry.example/xero@sha256:${"a".repeat(64)}`,
      XERO_WRITE_ENABLED: "false",
    });
    expect(parseCapturedReleaseEnvironment(capturedReleaseEnvironment({ XERO_WRITE_ENABLED: "true" })))
      .toMatchObject({ XERO_WRITE_ENABLED: "true" });
    expect(() => parseCapturedReleaseEnvironment(capturedReleaseEnvironment({ XERO_WRITE_ENABLED: "enabled" })))
      .toThrow("PRODUCTION_RELEASE_ENV_WRITE_ENABLED_INVALID");
    expect(() => parseCapturedReleaseEnvironment(capturedReleaseEnvironment({ APP_IMAGE: "registry.example/xero:latest" })))
      .toThrow("PRODUCTION_RELEASE_ENV_APP_IMAGE_INVALID");
    expect(() => parseCapturedReleaseEnvironment(Buffer.from(
      `APP_IMAGE=a@sha256:${"a".repeat(64)}\nAPP_IMAGE=b@sha256:${"b".repeat(64)}\n`,
    ))).toThrow("PRODUCTION_RELEASE_ENV_INVALID");
  });

  it("validates pulled immutable OCI digest, labels and baked identity", () => {
    const manifest = `sha256:${"d".repeat(64)}`;
    const config = `sha256:${"e".repeat(64)}`;
    const env = { APP_IMAGE: `registry.example/xero@${manifest}` };
    const receipt = {
      ociManifestDigest: manifest,
      ociConfigDigest: config,
      semanticBuildIdentityHash: "1".repeat(64),
      acceptanceSourceSha256: "2".repeat(64),
      sourceArchiveSha256: "3".repeat(64),
    };
    const embeddedIdentity = JSON.stringify({
      acceptanceSourceSha256: receipt.acceptanceSourceSha256,
      sourceArchiveSha256: receipt.sourceArchiveSha256,
    });
    const inspection = {
      RepoDigests: [env.APP_IMAGE],
      Id: config,
      Config: {
        Labels: {
          "io.zcloak.xero.build-identity-hash": receipt.semanticBuildIdentityHash,
          "io.zcloak.xero.acceptance-source-sha256": receipt.acceptanceSourceSha256,
          "io.zcloak.xero.source-archive-sha256": receipt.sourceArchiveSha256,
        },
        Env: [
          `XERO_BUILD_IDENTITY_JSON=${embeddedIdentity}`,
        ],
      },
    };
    expect(assertPulledProductionImageIdentity(inspection, env, receipt)).toBe(true);
    expect(assertPulledProductionImageIdentity({ ...inspection, Id: manifest }, env, receipt)).toBe(true);
    expect(() => assertPulledProductionImageIdentity({
      ...inspection,
      Id: `sha256:${"f".repeat(64)}`,
    }, env, receipt)).toThrow("PRODUCTION_IMAGE_REPODIGEST_MISMATCH");
    expect(() => assertPulledProductionImageIdentity({ ...inspection, RepoDigests: [] }, env, receipt))
      .toThrow("PRODUCTION_IMAGE_REPODIGEST_MISMATCH");
    expect(() => assertPulledProductionImageIdentity({
      ...inspection,
      Config: { ...inspection.Config, Env: [] },
    }, env, receipt)).toThrow("PRODUCTION_IMAGE_BUILD_IDENTITY_ENV_MISSING");
    expect(() => assertPulledProductionImageIdentity(inspection, {
      ...env,
      XERO_BUILD_IDENTITY_JSON: JSON.stringify({ acceptanceSourceSha256: "8".repeat(64), sourceArchiveSha256: "7".repeat(64) }),
    }, receipt)).toThrow("PRODUCTION_BUILD_IDENTITY_OVERRIDE_MISMATCH");
  });

  it("keeps candidate admission structural while public cutover still requires READY capability identity", async () => {
    const verifyStatic = await readFile("deploy/scripts/verify-static.sh", "utf8");
    const cutover = await readFile("deploy/scripts/switch-xero-upstream.sh", "utf8");
    const server = await readFile("src/server.ts", "utf8");
    expect(verifyStatic).toContain("scripts/validate-capability-manifest.mjs --format fields");
    expect(verifyStatic).not.toContain("scripts/validate-capability-manifest.mjs --require-ready");
    expect(verifyStatic).toContain("writeEnabled: config.xeroWriteEnabled");
    expect(verifyStatic).toContain("required: config.xeroTargetSessionRequired ?? false");
    expect(verifyStatic).toContain("forbid_text src/server.ts 'RepositoryLedgerAuthoritySnapshotResolver'");
    expect(verifyStatic).not.toContain("config.xeroWriteEnabled && evidence.authorityWriteKillSwitchEnabled === true");
    expect(server).toContain("writeEnabled: config.xeroWriteEnabled");
    expect(server).toContain("required: config.xeroTargetSessionRequired ?? false");
    expect(server).not.toContain("RepositoryLedgerAuthoritySnapshotResolver");
    expect(server).not.toContain("authoritySnapshotResolver");
    expect(cutover).toContain("scripts/validate-capability-manifest.mjs --require-ready --format fields");
    expect(() => assertProductionCutoverContract("cutover", Buffer.from(cutover))).not.toThrow();
  });

  it("keeps release wrapper/runbook guards and forbids legacy governance from production compose", async () => {
    const wrapper = await readFile("deploy/scripts/admit-and-compose.sh");
    const runbook = await readFile("deploy/HETZNER_RUNBOOK.md");
    expect(() => assertProductionAdmissionWrapperContract("wrapper", wrapper)).not.toThrow();
    expect(() => assertProductionRunbookContract("runbook", runbook)).not.toThrow();

    for (const path of [
      "deploy/docker-compose/compose.vps.yaml",
      "deploy/docker-compose/compose.host-nginx.vps.yaml",
      "deploy/docker-compose/compose.host-nginx.green.vps.yaml",
    ]) {
      const original = await readFile(path, "utf8");
      expect(assertProductionComposeContract(path, Buffer.from(original))).toBe(true);
      expect(() => assertProductionComposeContract(path, Buffer.from(`${original}\nXERO_GOVERNANCE_STATUS_SHA256=revived\n`)))
        .toThrow("PRODUCTION_COMPOSE_LEGACY_GOVERNANCE_FORBIDDEN");
      expect(() => assertProductionComposeContract(path, Buffer.from(`${original}\n# xero-governance\n`)))
        .toThrow("PRODUCTION_COMPOSE_LEGACY_GOVERNANCE_FORBIDDEN");
    }
  });
});
