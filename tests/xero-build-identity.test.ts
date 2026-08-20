import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createXeroBuildIdentity,
  parseXeroBuildIdentity,
  xeroBuildIdentityHash,
} from "../src/xeroRelease.js";
import {
  sealAcceptedBuildContext,
  verifyAcceptedBuildContext,
} from "../scripts/verify-accepted-build-context.mjs";
import {
  createDeterministicTar,
  parseTarArchive,
} from "../scripts/release/release-bundle-lib.mjs";
import {
  parseOciLayoutTar,
  verifyOciLayoutArtifact,
} from "../scripts/verify-accepted-oci-release.mjs";
import {
  assertLocalBuildxInspection,
  trustedDockerEnvironment,
} from "../scripts/release/system-docker.mjs";
import {
  APPROVED_LOCAL_BUILDER_CONTRACT,
  assertApprovedLocalDockerObservation,
  createApprovedLocalBuilderReceipt,
} from "../scripts/approved-local-builder-contract.mjs";
import {
  assertDevComposeContract,
  assertProductionComposeContract,
  assertProductionRunbookContract,
} from "../scripts/release/production-deployment-contract.mjs";
import { localDockerImageIdForOci } from "../scripts/release/smoke-accepted-oci-runtime.mjs";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

function identity() {
  return createXeroBuildIdentity({
    acceptanceSourceSha256: digest("accepted-source"),
    releaseSourceManifestSha256: digest("release-files"),
    sourceArchiveSha256: digest("source-archive"),
    sourceBundleManifestSha256: digest("bundle-manifest"),
  });
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

type TarEntry = {
  readonly path: string;
  readonly type?: "0" | "2" | "5" | "x";
  readonly content?: Buffer;
};

function writeTarField(header: Buffer, offset: number, length: number, value: string): void {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.length > length) throw new Error(`tar field too long: ${value}`);
  encoded.copy(header, offset);
}

function writeTarOctal(header: Buffer, offset: number, length: number, value: number): void {
  writeTarField(header, offset, length, `${value.toString(8).padStart(length - 1, "0")}\0`);
}

function tarHeader(entry: TarEntry): Buffer {
  const header = Buffer.alloc(512, 0);
  const content = entry.content ?? Buffer.alloc(0);
  writeTarField(header, 0, 100, entry.path);
  writeTarOctal(header, 100, 8, entry.type === "5" ? 0o755 : 0o444);
  writeTarOctal(header, 108, 8, 0);
  writeTarOctal(header, 116, 8, 0);
  writeTarOctal(header, 124, 12, content.length);
  writeTarOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = (entry.type ?? "0").charCodeAt(0);
  writeTarField(header, 257, 6, "ustar\0");
  writeTarField(header, 263, 2, "00");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeTarField(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
  return header;
}

function createTar(entries: readonly TarEntry[]): Buffer {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    const content = entry.content ?? Buffer.alloc(0);
    chunks.push(tarHeader(entry), content);
    const padding = (512 - (content.length % 512)) % 512;
    if (padding > 0) chunks.push(Buffer.alloc(padding, 0));
  }
  chunks.push(Buffer.alloc(1024, 0));
  return Buffer.concat(chunks);
}

function ociFixture() {
  const buildIdentity = identity();
  const semanticBuildIdentityHash = xeroBuildIdentityHash(buildIdentity);
  const layer = Buffer.from("synthetic accepted layer", "utf8");
  const layerDigest = digest(layer);
  const config = Buffer.from(JSON.stringify({
    architecture: "amd64",
    os: "linux",
    config: {
      User: "10001:10001",
      Cmd: ["npm", "run", "start"],
      Env: [
        `XERO_BUILD_IDENTITY_JSON=${JSON.stringify(buildIdentity)}`,
      ],
      Labels: {
        "io.zcloak.xero.build-identity-hash": semanticBuildIdentityHash,
        "io.zcloak.xero.acceptance-source-sha256": buildIdentity.acceptanceSourceSha256,
        "io.zcloak.xero.source-archive-sha256": buildIdentity.sourceArchiveSha256,
      },
    },
    rootfs: { type: "layers", diff_ids: [`sha256:${layerDigest}`] },
  }), "utf8");
  const configDigest = digest(config);
  const manifest = Buffer.from(JSON.stringify({
    schemaVersion: 2,
    config: { digest: `sha256:${configDigest}`, size: config.length },
    layers: [{ digest: `sha256:${layerDigest}`, size: layer.length }],
  }), "utf8");
  const manifestDigest = digest(manifest);
  const index = Buffer.from(JSON.stringify({
    schemaVersion: 2,
    manifests: [{ digest: `sha256:${manifestDigest}`, size: manifest.length }],
  }), "utf8");
  const entries: TarEntry[] = [
    { path: "blobs/", type: "5" },
    { path: "blobs/sha256/", type: "5" },
    { path: `blobs/sha256/${configDigest}`, content: config },
    { path: `blobs/sha256/${layerDigest}`, content: layer },
    { path: `blobs/sha256/${manifestDigest}`, content: manifest },
    { path: "index.json", content: index },
    { path: "oci-layout", content: Buffer.from('{"imageLayoutVersion":"1.0.0"}', "utf8") },
  ];
  return {
    entries,
    expected: {
      ociManifestDigest: `sha256:${manifestDigest}`,
      semanticBuildIdentityHash,
      acceptanceSourceSha256: buildIdentity.acceptanceSourceSha256,
      sourceArchiveSha256: buildIdentity.sourceArchiveSha256,
    },
  };
}

async function acceptedContextFixture() {
  const root = await mkdtemp(join(tmpdir(), "xero-accepted-context-"));
  const filePath = "src/example.ts";
  const content = Buffer.from("export const accepted = true;\n", "utf8");
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, filePath), content, { mode: 0o644 });
  const archive = Buffer.from("synthetic-source-archive", "utf8");
  const base = "xero-accounting-mcp-0.4.0-rc.1-source";
  const manifest = {
    schemaVersion: 1,
    acceptanceSource: { sha256: digest("acceptance-source") },
    archive: { filename: `${base}.tar.gz`, sha256: digest(archive) },
    summary: { fileCount: 1 },
    files: [{ path: filePath, sizeBytes: content.length, mode: "0644", sha256: digest(content) }],
  };
  const manifestContent = Buffer.from(stableJson(manifest), "utf8");
  const releaseSourceManifestSha256 = digest(Buffer.from(JSON.stringify(manifest.files.map((file) => ({
    path: file.path,
    size_bytes: file.sizeBytes,
    mode: file.mode,
    sha256: file.sha256,
  }))), "utf8"));
  const buildIdentity = createXeroBuildIdentity({
    acceptanceSourceSha256: manifest.acceptanceSource.sha256,
    releaseSourceManifestSha256,
    sourceArchiveSha256: manifest.archive.sha256,
    sourceBundleManifestSha256: digest(manifestContent),
  });
  const buildIdentityContent = Buffer.from(stableJson(buildIdentity), "utf8");
  const checksumContent = Buffer.from(
    `${digest(archive)}  ${base}.tar.gz\n${digest(manifestContent)}  ${base}.manifest.json\n` +
      `${digest(buildIdentityContent)}  ${base}.build-identity.json\n`,
    "utf8",
  );
  const identityDirectory = join(root, ".accepted-release");
  await mkdir(identityDirectory);
  await Promise.all([
    writeFile(join(identityDirectory, "source.tar.gz"), archive),
    writeFile(join(identityDirectory, "manifest.json"), manifestContent),
    writeFile(join(identityDirectory, "build-identity.json"), buildIdentityContent),
    writeFile(join(identityDirectory, "checksums.sha256"), checksumContent),
  ]);
  return { root, filePath, manifest, buildIdentity };
}

describe("accepted source to OCI runtime identity", () => {
  it("binds every artifact digest and changes for a one-byte source change", () => {
    const baseline = identity();
    const changed = createXeroBuildIdentity({
      ...baseline,
      acceptanceSourceSha256: digest("accepted-sourcf"),
    });
    expect(xeroBuildIdentityHash(baseline)).toMatch(/^[a-f0-9]{64}$/u);
    expect(xeroBuildIdentityHash(changed)).not.toBe(xeroBuildIdentityHash(baseline));
    expect(parseXeroBuildIdentity(JSON.stringify(baseline))).toEqual(baseline);
    expect(() => parseXeroBuildIdentity(JSON.stringify({ ...baseline, toolsetHash: "f".repeat(64) })))
      .toThrow("XERO_BUILD_IDENTITY_CONTRACT_MISMATCH");
  });

  it("pins the base image and refuses mutable cutover identities", () => {
    const dockerfile = readFileSync("deploy/Dockerfile", "utf8");
    const productionComposes = [
      "deploy/docker-compose/compose.vps.yaml",
      "deploy/docker-compose/compose.host-nginx.vps.yaml",
      "deploy/docker-compose/compose.host-nginx.green.vps.yaml",
    ].map((path) => ({ path, content: readFileSync(path, "utf8") }));
    const cutover = readFileSync("deploy/scripts/switch-xero-upstream.sh", "utf8");
    const verifier = readFileSync("scripts/release/verify-oci-build-identity.mjs", "utf8");
    expect(dockerfile).not.toMatch(/^#\s*syntax=/mu);
    expect(dockerfile).toContain("node:22.22.3-alpine3.23@sha256:");
    expect(dockerfile).toContain("io.zcloak.xero.build-identity-hash");
    for (const compose of productionComposes) {
      expect(compose.content, compose.path).not.toMatch(/^\s*build:/mu);
      expect(compose.content, compose.path).toContain("APP_IMAGE must be an immutable repo@sha256 digest");
      expect(compose.content, compose.path).toContain("image: ${APP_IMAGE:?Set APP_IMAGE");
    }
    expect(cutover).toContain("APP_IMAGE_MUST_USE_IMMUTABLE_REPO_DIGEST");
    expect(cutover).toContain("GREEN_IMAGE_IDENTITY_MISMATCH");
    expect(verifier).toContain("OCI_IMAGE_REFERENCE_MUST_USE_REPO_DIGEST");
    expect(verifier).toContain("OCI_IMAGE_LABEL_MISMATCH");
  });

  it("rejects environment-selected or remote release builders", () => {
    expect(() => trustedDockerEnvironment({ PATH: "/tmp/fake", DOCKER_HOST: "tcp://attacker.invalid:2375" }))
      .toThrow("LOCAL_DOCKER_OVERRIDE_FORBIDDEN:DOCKER_HOST");
    expect(() => trustedDockerEnvironment({ DOCKER_CONTEXT: "remote" }))
      .toThrow("LOCAL_DOCKER_OVERRIDE_FORBIDDEN:DOCKER_CONTEXT");
    expect(() => trustedDockerEnvironment({ BUILDX_BUILDER: "workspace-builder" }))
      .toThrow("LOCAL_DOCKER_OVERRIDE_FORBIDDEN:BUILDX_BUILDER");
    expect(() => trustedDockerEnvironment({ DOCKER_CONFIG: "/tmp/workspace-config" }))
      .toThrow("LOCAL_DOCKER_OVERRIDE_FORBIDDEN:DOCKER_CONFIG");
    expect(trustedDockerEnvironment({ PATH: "/tmp/fake" })).toEqual({
      PATH: "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    });

    const localInspection = [
      "Name:          orbstack",
      "Driver:        docker",
      "Nodes:",
      "Name:             orbstack",
      "Endpoint:         orbstack",
      "Status:           running",
      "BuildKit version: v0.29.0",
      "Labels:",
      " org.mobyproject.buildkit.worker.containerd.uuid:      cff3ac24-805e-402f-a906-b5ae91d57f25",
    ].join("\n");
    expect(() => assertLocalBuildxInspection(localInspection, "orbstack")).not.toThrow();
    expect(() => assertLocalBuildxInspection(localInspection.replace("Driver:        docker", "Driver:        remote"), "orbstack"))
      .toThrow("LOCAL_BUILDX_CONTEXT_NOT_BOUND");
    expect(() => assertLocalBuildxInspection(localInspection.replace("Endpoint:         orbstack", "Endpoint:         tcp://remote"), "orbstack"))
      .toThrow("LOCAL_BUILDX_CONTEXT_NOT_BOUND");
    expect(() => assertLocalBuildxInspection(localInspection.replace("v0.29.0", "v0.30.0"), "orbstack"))
      .toThrow("LOCAL_BUILDX_CONTEXT_NOT_BOUND");
  });

  it("rejects a fake local Unix context, socket ownership drift, daemon drift, and BuildKit drift", () => {
    const approved = JSON.parse(JSON.stringify(APPROVED_LOCAL_BUILDER_CONTRACT)) as any;
    expect(() => assertApprovedLocalDockerObservation(approved, { requireBuilder: true })).not.toThrow();
    expect(createApprovedLocalBuilderReceipt(approved).approvedContractSha256).toMatch(/^[a-f0-9]{64}$/u);

    const fakeContext = structuredClone(approved) as any;
    fakeContext.runtime.context.endpoint = "unix:///tmp/fake-docker.sock";
    fakeContext.runtime.socket.path = "/tmp/fake-docker.sock";
    expect(() => assertApprovedLocalDockerObservation(fakeContext, { requireBuilder: true }))
      .toThrow("LOCAL_DOCKER_RUNTIME_CONTRACT_MISMATCH");

    const wrongOwner = structuredClone(approved) as any;
    wrongOwner.runtime.socket.ownerUid = 0;
    expect(() => assertApprovedLocalDockerObservation(wrongOwner, { requireBuilder: true }))
      .toThrow("LOCAL_DOCKER_RUNTIME_CONTRACT_MISMATCH");

    const daemonDrift = structuredClone(approved) as any;
    daemonDrift.runtime.daemon.serverVersion = "29.4.1";
    expect(() => assertApprovedLocalDockerObservation(daemonDrift, { requireBuilder: true }))
      .toThrow("LOCAL_DOCKER_RUNTIME_CONTRACT_MISMATCH");

    const builderDrift = structuredClone(approved) as any;
    builderDrift.builder.instance.buildkitVersion = "v0.30.0";
    expect(() => assertApprovedLocalDockerObservation(builderDrift, { requireBuilder: true }))
      .toThrow("LOCAL_DOCKER_BUILDER_CONTRACT_MISMATCH");
  });

  it("rejects production build/mutable-image paths and keeps local rebuild dev-only/read-only", () => {
    const production = readFileSync("deploy/docker-compose/compose.vps.yaml", "utf8");
    const runbook = readFileSync("deploy/HETZNER_RUNBOOK.md", "utf8");
    const dev = readFileSync("deploy/docker-compose/compose.dev.yaml", "utf8");
    expect(() => assertProductionComposeContract("production", production)).not.toThrow();
    expect(() => assertProductionRunbookContract("runbook", runbook)).not.toThrow();
    expect(() => assertDevComposeContract("dev", dev)).not.toThrow();
    expect(() => assertProductionComposeContract(
      "production",
      production.replace(/^\s*image: \$\{APP_IMAGE[^\n]+$/mu, "    image: xero-accounting-mcp:local\n    build:\n      context: ."),
    )).toThrow(/PRODUCTION_COMPOSE_(?:BUILD_FORBIDDEN|IMAGE_NOT_IMMUTABLE)/u);
    expect(() => assertProductionRunbookContract(
      "runbook",
      `${runbook}\n\`\`\`sh\ndocker compose -f deploy/docker-compose/compose.vps.yaml up -d accounting-mcp\n\`\`\`\n`,
    )).toThrow("PRODUCTION_RUNBOOK_DIRECT_MUTATION_FORBIDDEN:runbook");
    expect(() => assertDevComposeContract("dev", dev.replace("XERO_WRITE_ENABLED: \"false\"", "XERO_WRITE_ENABLED: \"true\"")))
      .toThrow("DEV_COMPOSE_WRITE_GATE_INVALID:dev");
  });

  it("does not require an external control-catalog approval", () => {
    const buildIdentity = identity();
    expect(buildIdentity).not.toHaveProperty("approvedControlCatalogSha256");
    expect(JSON.stringify(buildIdentity)).not.toContain("CONTROL_CATALOG");
  });

  it("verifies every accepted build-context byte and rejects source or file-set drift", async () => {
    const fixture = await acceptedContextFixture();
    try {
      await expect(verifyAcceptedBuildContext({ root: fixture.root })).resolves.toMatchObject({
        semanticBuildIdentityHash: xeroBuildIdentityHash(fixture.buildIdentity),
        fileCount: 1,
      });
      await writeFile(join(fixture.root, fixture.filePath), "export const accepted = false;\n");
      await expect(verifyAcceptedBuildContext({ root: fixture.root }))
        .rejects.toThrow(`ACCEPTED_BUILD_CONTEXT_FILE_MISMATCH:${fixture.filePath}`);
      await writeFile(join(fixture.root, fixture.filePath), "export const accepted = true;\n");
      await writeFile(join(fixture.root, "extra.ts"), "export {};\n");
      await expect(verifyAcceptedBuildContext({ root: fixture.root }))
        .rejects.toThrow("ACCEPTED_BUILD_CONTEXT_FILE_SET_MISMATCH");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("seals one deterministic stdin build context before the mutable path can be read again", async () => {
    const fixture = await acceptedContextFixture();
    try {
      const sealed = await sealAcceptedBuildContext({ root: fixture.root });
      const stdinTar = createDeterministicTar(sealed.sealedEntries, { sourceDateEpoch: 0 });
      const stdinHash = digest(stdinTar);
      const captured = new Map(parseTarArchive(stdinTar).map((entry) => [entry.path, entry.content]));
      expect(captured.get(fixture.filePath)?.toString("utf8")).toBe("export const accepted = true;\n");
      expect(captured.has(".accepted-release/build-identity.json")).toBe(true);

      await writeFile(join(fixture.root, fixture.filePath), "export const attacker = true;\n");
      expect(digest(stdinTar)).toBe(stdinHash);
      expect(captured.get(fixture.filePath)?.toString("utf8")).toBe("export const accepted = true;\n");
      await expect(sealAcceptedBuildContext({ root: fixture.root }))
        .rejects.toThrow(`ACCEPTED_BUILD_CONTEXT_FILE_MISMATCH:${fixture.filePath}`);

      const builder = readFileSync("scripts/release/build-accepted-oci-image.mjs", "utf8");
      expect(builder).toContain("createDeterministicTar(verified.sealedEntries");
      expect(builder).toContain("dockerTrust.environment, buildContextTar");
      expect(builder).toContain('"-",\n    ], options.context');
      expect(builder).not.toContain('".",\n    ], options.context');
      expect(builder).toContain("BUILD_CONTEXT_STDIN_WRITE_FAILED");
      const gate = readFileSync("scripts/release/run-local-acceptance-gate.mjs", "utf8");
      expect(gate).toContain("createDeterministicTar(trustedBuildContextEntries");
      expect(gate).toContain("parsedOciReceipt.buildContextTarSha256 !== sha256Buffer(trustedBuildContextTar)");
      expect(gate).toContain("parsedOciReceipt.buildContextTarSizeBytes !== trustedBuildContextTar.length");
      expect(gate).toContain("parsedOciReceipt.sourceBundleManifestSha256 !== sha256Buffer(bundleManifest)");
      expect(gate).toContain("parsedOciReceipt.releaseSourceManifestSha256 !== releaseSourceManifestSha256");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects mode, symlink, checksum, and build-identity substitution", async () => {
    const modeFixture = await acceptedContextFixture();
    try {
      await chmod(join(modeFixture.root, modeFixture.filePath), 0o755);
      await expect(verifyAcceptedBuildContext({ root: modeFixture.root }))
        .rejects.toThrow(`ACCEPTED_BUILD_CONTEXT_FILE_MISMATCH:${modeFixture.filePath}`);
    } finally {
      await rm(modeFixture.root, { recursive: true, force: true });
    }

    const symlinkFixture = await acceptedContextFixture();
    try {
      await symlink("src/example.ts", join(symlinkFixture.root, "linked.ts"));
      await expect(verifyAcceptedBuildContext({ root: symlinkFixture.root }))
        .rejects.toThrow("ACCEPTED_BUILD_CONTEXT_SYMLINK:linked.ts");
    } finally {
      await rm(symlinkFixture.root, { recursive: true, force: true });
    }

    const checksumFixture = await acceptedContextFixture();
    try {
      const checksumPath = join(checksumFixture.root, ".accepted-release/checksums.sha256");
      const checksum = await readFile(checksumPath, "utf8");
      await writeFile(checksumPath, checksum.replace(/^[a-f0-9]/u, "f"));
      await expect(verifyAcceptedBuildContext({ root: checksumFixture.root }))
        .rejects.toThrow("ACCEPTED_BUILD_CONTEXT_CHECKSUM_MISMATCH");
    } finally {
      await rm(checksumFixture.root, { recursive: true, force: true });
    }

    const identityFixture = await acceptedContextFixture();
    try {
      await writeFile(
        join(identityFixture.root, ".accepted-release/build-identity.json"),
        stableJson({ ...identityFixture.buildIdentity, toolsetHash: "f".repeat(64) }),
      );
      await expect(verifyAcceptedBuildContext({ root: identityFixture.root }))
        .rejects.toThrow("ACCEPTED_BUILD_CONTEXT_CHECKSUM_MISMATCH");
    } finally {
      await rm(identityFixture.root, { recursive: true, force: true });
    }
  });

  it("accepts the exact Buildx OCI directory dialect and verifies every referenced blob", () => {
    const fixture = ociFixture();
    const artifact = createTar(fixture.entries);
    expect(parseOciLayoutTar(artifact).map((entry) => entry.path)).toEqual([
      expect.stringMatching(/^blobs\/sha256\//u),
      expect.stringMatching(/^blobs\/sha256\//u),
      expect.stringMatching(/^blobs\/sha256\//u),
      "index.json",
      "oci-layout",
    ]);
    expect(verifyOciLayoutArtifact(artifact, fixture.expected)).toMatchObject({
      ociManifestDigest: fixture.expected.ociManifestDigest,
    });
  });

  it("uses the OCI manifest digest, not the config blob digest, as Docker's loaded image ID", () => {
    const manifestDigest = `sha256:${"a".repeat(64)}`;
    const configDigest = `sha256:${"b".repeat(64)}`;
    expect(localDockerImageIdForOci({ ociManifestDigest: manifestDigest, configDigest }))
      .toBe(manifestDigest);
    expect(() => localDockerImageIdForOci({ ociManifestDigest: "bad", configDigest }))
      .toThrow("OCI_RUNTIME_IMAGE_DESCRIPTOR_INVALID");
  });

  it("rejects missing, extra, and non-empty OCI directory entries", () => {
    const fixture = ociFixture();
    expect(() => parseOciLayoutTar(createTar(fixture.entries.filter((entry) => entry.path !== "blobs/"))))
      .toThrow("OCI_TAR_REQUIRED_DIRECTORIES_MISSING");
    expect(() => parseOciLayoutTar(createTar([
      ...fixture.entries,
      { path: "unexpected/", type: "5" },
    ]))).toThrow("OCI_TAR_DIRECTORY_INVALID:unexpected/");
    expect(() => parseOciLayoutTar(createTar(fixture.entries.map((entry) =>
      entry.path === "blobs/" ? { ...entry, content: Buffer.from("x") } : entry))))
      .toThrow("OCI_TAR_DIRECTORY_INVALID:blobs/");
  });

  it("rejects symlink, PAX, duplicate, and unsafe OCI tar entries", () => {
    const fixture = ociFixture();
    for (const type of ["2", "x"] as const) {
      expect(() => parseOciLayoutTar(createTar([
        ...fixture.entries,
        { path: "blobs/sha256/" + "f".repeat(64), type },
      ]))).toThrow("OCI_TAR_ENTRY_TYPE_FORBIDDEN");
    }
    expect(() => parseOciLayoutTar(
      createTar([...fixture.entries, fixture.entries[0]!]),
    ))
      .toThrow("OCI_TAR_DUPLICATE_ENTRY:blobs/");
    expect(() => parseOciLayoutTar(createTar([
      ...fixture.entries,
      { path: "./index.json", content: Buffer.from("{}") },
    ]))).toThrow("OCI_TAR_REGULAR_PATH_INVALID:./index.json");
  });
});
