import { createHash } from "node:crypto";

function stableCanonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableCanonical).join(",")}]`;
  return `{${Object.entries(value)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([key, child]) => `${JSON.stringify(key)}:${stableCanonical(child)}`)
    .join(",")}}`;
}

function deepFreeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export function approvedLocalBuilderValueSha256(value) {
  return createHash("sha256").update(stableCanonical(value), "utf8").digest("hex");
}

/**
 * This is intentionally a single-machine release-builder trust root. Any
 * Docker, OrbStack, daemon, socket, Buildx, or BuildKit upgrade must change
 * this reviewed source contract and therefore changes the acceptance-source
 * identity before a new release can pass.
 */
export const APPROVED_LOCAL_BUILDER_CONTRACT = deepFreeze({
  schemaVersion: "xero-approved-local-builder-contract:v1",
  platform: "darwin",
  runtime: {
    dockerExecutable: {
      invokedPath: "/usr/local/bin/docker",
      resolvedPath: "/Applications/OrbStack.app/Contents/MacOS/xbin/docker-tools",
      sha256: "70d5a06adf388bd09b652f47ddc9ca31663a3e5353d24188bdb0054b3014ab3e",
      ownerUid: 501,
      groupGid: 20,
      mode: "0755",
      signingIdentifier: "docker-tools-555549443ffa244c942c371ee6748fce167097f6",
      signingTeamIdentifier: "HUAQ24HBR6",
    },
    dockerClient: {
      version: "29.4.0",
      apiVersion: "1.54",
      gitCommit: "9d7ad9f",
      goVersion: "go1.26.4",
      os: "darwin",
      arch: "arm64",
    },
    context: {
      name: "orbstack",
      endpoint: "unix:///Users/jiayuanwang/.orbstack/run/docker.sock",
    },
    socket: {
      path: "/Users/jiayuanwang/.orbstack/run/docker.sock",
      ownerUid: 501,
      groupGid: 20,
      mode: "0755",
    },
    daemon: {
      id: "09a6202e-c548-4147-a1a9-3a33590a5b1b",
      operatingSystem: "OrbStack",
      serverVersion: "29.4.0",
      apiVersion: "1.54",
      minApiVersion: "1.40",
      gitCommit: "daa0cb7f",
      goVersion: "go1.26.1",
      kernelVersion: "7.0.14-orbstack-00380-ga7e0a2dc9535",
      os: "linux",
      arch: "arm64",
      architecture: "aarch64",
      dockerRootDir: "/var/lib/docker",
      containerdCommit: "301b2dac98f15c27117da5c8af12118a041a31d9",
      runcCommit: "bb14dabeb7185bb72c8c86735d090dcb20f36587",
      initCommit: "de40ad0",
    },
  },
  builder: {
    buildxPlugin: {
      invokedPath: "/Users/jiayuanwang/.docker/cli-plugins/docker-buildx",
      resolvedPath: "/Applications/OrbStack.app/Contents/MacOS/xbin/docker-tools",
      sha256: "70d5a06adf388bd09b652f47ddc9ca31663a3e5353d24188bdb0054b3014ab3e",
      ownerUid: 501,
      groupGid: 20,
      mode: "0755",
      signingIdentifier: "docker-tools-555549443ffa244c942c371ee6748fce167097f6",
      signingTeamIdentifier: "HUAQ24HBR6",
      vendor: "Docker Inc.",
      version: "v0.33.0",
      gitCommit: "f7897eba028583e0071642db3c011e860444f8cf",
    },
    instance: {
      name: "orbstack",
      driver: "docker",
      endpoint: "orbstack",
      status: "running",
      buildkitVersion: "v0.29.0",
      workerUuid: "cff3ac24-805e-402f-a906-b5ae91d57f25",
    },
    dockerfileFrontend: {
      selection: "BUILTIN_BY_APPROVED_BUILDKIT",
      syntaxDirective: null,
    },
  },
});

export const APPROVED_LOCAL_BUILDER_CONTRACT_SHA256 = approvedLocalBuilderValueSha256(
  APPROVED_LOCAL_BUILDER_CONTRACT,
);

function assertExact(actual, expected, errorCode) {
  if (stableCanonical(actual) !== stableCanonical(expected)) throw new Error(errorCode);
}

export function assertApprovedLocalDockerObservation(observation, options = {}) {
  if (!observation || typeof observation !== "object" || Array.isArray(observation)) {
    throw new Error("LOCAL_DOCKER_OBSERVATION_INVALID");
  }
  if (observation.schemaVersion !== APPROVED_LOCAL_BUILDER_CONTRACT.schemaVersion ||
      observation.platform !== APPROVED_LOCAL_BUILDER_CONTRACT.platform) {
    throw new Error("LOCAL_DOCKER_PLATFORM_CONTRACT_MISMATCH");
  }
  assertExact(
    observation.runtime,
    APPROVED_LOCAL_BUILDER_CONTRACT.runtime,
    "LOCAL_DOCKER_RUNTIME_CONTRACT_MISMATCH",
  );
  if (options.requireBuilder === true) {
    assertExact(
      observation.builder,
      APPROVED_LOCAL_BUILDER_CONTRACT.builder,
      "LOCAL_DOCKER_BUILDER_CONTRACT_MISMATCH",
    );
  } else if (observation.builder !== null) {
    throw new Error("LOCAL_DOCKER_UNREQUESTED_BUILDER_OBSERVATION");
  }
  return Object.freeze({
    approvedContractSha256: APPROVED_LOCAL_BUILDER_CONTRACT_SHA256,
    observationSha256: approvedLocalBuilderValueSha256(observation),
  });
}

export function createApprovedLocalBuilderReceipt(observation) {
  const identity = assertApprovedLocalDockerObservation(observation, { requireBuilder: true });
  return Object.freeze({
    schemaVersion: "xero-approved-local-builder-receipt:v1",
    approvedContractSha256: identity.approvedContractSha256,
    observationSha256: identity.observationSha256,
    observation,
  });
}

export function assertApprovedLocalBuilderReceipt(receipt) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt) ||
      JSON.stringify(Object.keys(receipt).sort()) !== JSON.stringify([
        "approvedContractSha256",
        "observation",
        "observationSha256",
        "schemaVersion",
      ])) {
    throw new Error("LOCAL_BUILDER_RECEIPT_INVALID");
  }
  if (receipt.schemaVersion !== "xero-approved-local-builder-receipt:v1" ||
      receipt.approvedContractSha256 !== APPROVED_LOCAL_BUILDER_CONTRACT_SHA256) {
    throw new Error("LOCAL_BUILDER_RECEIPT_CONTRACT_MISMATCH");
  }
  const identity = assertApprovedLocalDockerObservation(receipt.observation, { requireBuilder: true });
  if (receipt.observationSha256 !== identity.observationSha256) {
    throw new Error("LOCAL_BUILDER_RECEIPT_OBSERVATION_MISMATCH");
  }
  return identity;
}
