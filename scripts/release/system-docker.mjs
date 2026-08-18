import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, lstat, readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import {
  APPROVED_LOCAL_BUILDER_CONTRACT,
  assertApprovedLocalDockerObservation,
  createApprovedLocalBuilderReceipt,
} from "../approved-local-builder-contract.mjs";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function mode(stat) {
  return (stat.mode & 0o7777).toString(8).padStart(4, "0");
}

function parseJson(value, errorCode) {
  try {
    return JSON.parse(value.trim());
  } catch {
    throw new Error(errorCode);
  }
}

export function trustedDockerEnvironment(environment) {
  const overrideKeys = Object.keys(environment)
    .filter((key) => /^(?:DOCKER|BUILDX|BUILDKIT)_/u.test(key))
    .sort((left, right) => left.localeCompare(right, "en"));
  for (const key of overrideKeys) {
    if (typeof environment[key] === "string" && environment[key].length > 0) {
      throw new Error(`LOCAL_DOCKER_OVERRIDE_FORBIDDEN:${key}`);
    }
  }
  const clean = {
    ...environment,
    PATH: "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin",
  };
  for (const key of overrideKeys) delete clean[key];
  return clean;
}

function parseBuildxInspection(inspection) {
  return {
    name: /^Name:\s+(.+)$/mu.exec(inspection)?.[1]?.trim(),
    driver: /^Driver:\s+(.+)$/mu.exec(inspection)?.[1]?.trim(),
    endpoint: /^Endpoint:\s+(.+)$/mu.exec(inspection)?.[1]?.trim(),
    status: /^Status:\s+(.+)$/mu.exec(inspection)?.[1]?.trim(),
    buildkitVersion: /^BuildKit version:\s+(.+)$/mu.exec(inspection)?.[1]?.trim(),
    workerUuid: /^\s*org\.mobyproject\.buildkit\.worker\.containerd\.uuid:\s+(.+)$/mu.exec(inspection)?.[1]?.trim(),
  };
}

export function assertLocalBuildxInspection(inspection, contextName) {
  const parsed = parseBuildxInspection(inspection);
  const approved = APPROVED_LOCAL_BUILDER_CONTRACT.builder.instance;
  if (contextName !== approved.name ||
      parsed.name !== approved.name ||
      parsed.driver !== approved.driver ||
      parsed.endpoint !== approved.endpoint ||
      parsed.status !== approved.status ||
      parsed.buildkitVersion !== approved.buildkitVersion ||
      parsed.workerUuid !== approved.workerUuid) {
    throw new Error("LOCAL_BUILDX_CONTEXT_NOT_BOUND");
  }
  return Object.freeze(parsed);
}

function run(command, args, environment) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: environment,
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", rejectPromise);
    child.once("close", (code, signal) => {
      const output = Buffer.concat(stdout).toString("utf8");
      const error = Buffer.concat(stderr).toString("utf8");
      if (code === 0 && signal === null) resolvePromise({ stdout: output, stderr: error });
      else rejectPromise(new Error(
        `LOCAL_DOCKER_TRUST_COMMAND_FAILED:${code ?? "null"}:${signal ?? "none"}:${error.trim().slice(0, 500)}`,
      ));
    });
  });
}

async function platformSigningIdentity(executable, environment) {
  if (process.platform !== "darwin") throw new Error("LOCAL_DOCKER_PLATFORM_UNAPPROVED");
  const result = await run("/usr/bin/codesign", ["-dv", "--verbose=4", executable], environment);
  const output = `${result.stdout}\n${result.stderr}`;
  const signingIdentifier = /^Identifier=(.+)$/mu.exec(output)?.[1]?.trim();
  const signingTeamIdentifier = /^TeamIdentifier=(.+)$/mu.exec(output)?.[1]?.trim();
  if (!signingIdentifier || !signingTeamIdentifier) {
    throw new Error("LOCAL_DOCKER_PLATFORM_IDENTITY_UNTRUSTED");
  }
  return Object.freeze({ signingIdentifier, signingTeamIdentifier });
}

async function executableIdentity(invokedPath, workspaceRoot, environment) {
  await access(invokedPath, fsConstants.X_OK);
  const resolvedPath = await realpath(invokedPath);
  const stat = await lstat(resolvedPath);
  if (!stat.isFile() || stat.isSymbolicLink() ||
      invokedPath.startsWith(`${workspaceRoot}/`) || resolvedPath.startsWith(`${workspaceRoot}/`)) {
    throw new Error("LOCAL_DOCKER_EXECUTABLE_UNTRUSTED");
  }
  const [bytes, signing] = await Promise.all([
    readFile(resolvedPath),
    platformSigningIdentity(resolvedPath, environment),
  ]);
  return Object.freeze({
    invokedPath,
    resolvedPath,
    sha256: sha256(bytes),
    ownerUid: stat.uid,
    groupGid: stat.gid,
    mode: mode(stat),
    ...signing,
  });
}

function unixSocketPath(rawEndpoint) {
  if (typeof rawEndpoint !== "string" || !rawEndpoint.startsWith("unix://")) {
    throw new Error("LOCAL_DOCKER_ENDPOINT_NOT_UNIX");
  }
  const decoded = decodeURIComponent(rawEndpoint.slice("unix://".length));
  if (!decoded.startsWith("/")) throw new Error("LOCAL_DOCKER_SOCKET_PATH_INVALID");
  return resolve(decoded);
}

async function socketIdentity(endpoint, workspaceRoot) {
  const requested = unixSocketPath(endpoint);
  const path = await realpath(requested);
  const stat = await lstat(path);
  if (!stat.isSocket() || stat.isSymbolicLink() || path.startsWith(`${workspaceRoot}/`)) {
    throw new Error("LOCAL_DOCKER_SOCKET_UNTRUSTED");
  }
  return Object.freeze({
    path,
    ownerUid: stat.uid,
    groupGid: stat.gid,
    mode: mode(stat),
  });
}

function clientObservation(version) {
  const client = version?.Client;
  if (!client || typeof client !== "object") throw new Error("LOCAL_DOCKER_CLIENT_IDENTITY_INVALID");
  return Object.freeze({
    version: client.Version,
    apiVersion: client.ApiVersion,
    gitCommit: client.GitCommit,
    goVersion: client.GoVersion,
    os: client.Os,
    arch: client.Arch,
  });
}

function daemonObservation(version, info) {
  const server = version?.Server;
  if (!server || typeof server !== "object" || !info || typeof info !== "object") {
    throw new Error("LOCAL_DOCKER_DAEMON_IDENTITY_INVALID");
  }
  return Object.freeze({
    id: info.ID,
    operatingSystem: info.OperatingSystem,
    serverVersion: server.Version,
    apiVersion: server.ApiVersion,
    minApiVersion: server.MinAPIVersion,
    gitCommit: server.GitCommit,
    goVersion: server.GoVersion,
    kernelVersion: server.KernelVersion,
    os: server.Os,
    arch: server.Arch,
    architecture: info.Architecture,
    dockerRootDir: info.DockerRootDir,
    containerdCommit: info.ContainerdCommit?.ID,
    runcCommit: info.RuncCommit?.ID,
    initCommit: info.InitCommit?.ID,
  });
}

function parseBuildxVersion(value) {
  const match = /^github\.com\/docker\/buildx\s+(v\d+\.\d+\.\d+)\s+([a-f0-9]{40})$/u.exec(value.trim());
  if (!match) throw new Error("LOCAL_BUILDX_VERSION_INVALID");
  return Object.freeze({ version: match[1], gitCommit: match[2] });
}

export async function resolveTrustedLocalDocker({ workspaceRoot, requireBuilder = false }) {
  const absoluteWorkspace = resolve(workspaceRoot);
  const environment = trustedDockerEnvironment(process.env);
  const approved = APPROVED_LOCAL_BUILDER_CONTRACT;
  if (process.platform !== approved.platform) throw new Error("LOCAL_DOCKER_PLATFORM_UNAPPROVED");
  const dockerExecutable = await executableIdentity(
    approved.runtime.dockerExecutable.invokedPath,
    absoluteWorkspace,
    environment,
  );
  const docker = dockerExecutable.invokedPath;
  const contextResult = await run(docker, ["context", "show"], environment);
  const contextName = contextResult.stdout.trim();
  if (contextName !== approved.runtime.context.name) throw new Error("LOCAL_DOCKER_CONTEXT_UNAPPROVED");
  const contextInspect = await run(
    docker,
    ["context", "inspect", contextName, "--format", "{{json .Endpoints.docker.Host}}"],
    environment,
  );
  const endpoint = parseJson(contextInspect.stdout, "LOCAL_DOCKER_ENDPOINT_INVALID");
  const socket = await socketIdentity(endpoint, absoluteWorkspace);
  const [versionResult, infoResult] = await Promise.all([
    run(docker, ["--context", contextName, "version", "--format", "{{json .}}"], environment),
    run(docker, ["--context", contextName, "info", "--format", "{{json .}}"], environment),
  ]);
  const version = parseJson(versionResult.stdout, "LOCAL_DOCKER_VERSION_INVALID");
  const info = parseJson(infoResult.stdout, "LOCAL_DOCKER_INFO_INVALID");
  const runtime = Object.freeze({
    dockerExecutable,
    dockerClient: clientObservation(version),
    context: Object.freeze({ name: contextName, endpoint }),
    socket,
    daemon: daemonObservation(version, info),
  });

  let builder = null;
  let builderDetails = null;
  if (requireBuilder) {
    const buildxClient = info.ClientInfo?.Plugins?.find((plugin) => plugin?.Name === "buildx");
    if (!buildxClient) throw new Error("LOCAL_BUILDX_PLUGIN_NOT_FOUND");
    const [pluginIdentity, versionOutput, inspection] = await Promise.all([
      executableIdentity(approved.builder.buildxPlugin.invokedPath, absoluteWorkspace, environment),
      run(docker, ["--context", contextName, "buildx", "version"], environment),
      run(docker, ["--context", contextName, "buildx", "inspect", contextName, "--bootstrap"], environment),
    ]);
    const parsedBuildxVersion = parseBuildxVersion(versionOutput.stdout);
    const parsedInspection = assertLocalBuildxInspection(inspection.stdout, contextName);
    const buildxPlugin = Object.freeze({
      ...pluginIdentity,
      vendor: buildxClient.Vendor,
      version: parsedBuildxVersion.version,
      gitCommit: parsedBuildxVersion.gitCommit,
    });
    builder = Object.freeze({
      buildxPlugin,
      instance: parsedInspection,
      dockerfileFrontend: Object.freeze({
        selection: "BUILTIN_BY_APPROVED_BUILDKIT",
        syntaxDirective: null,
      }),
    });
    builderDetails = Object.freeze({
      name: parsedInspection.name,
      inspection: inspection.stdout,
      inspectionSha256: sha256(inspection.stdout),
    });
  }

  const observation = Object.freeze({
    schemaVersion: approved.schemaVersion,
    platform: process.platform,
    runtime,
    builder,
  });
  assertApprovedLocalDockerObservation(observation, { requireBuilder });
  const builderReceipt = requireBuilder ? createApprovedLocalBuilderReceipt(observation) : null;
  return Object.freeze({
    executable: docker,
    resolvedExecutable: dockerExecutable.resolvedPath,
    executableSha256: dockerExecutable.sha256,
    signingIdentity: Object.freeze({
      platform: process.platform,
      identifier: dockerExecutable.signingIdentifier,
      teamIdentifier: dockerExecutable.signingTeamIdentifier,
    }),
    clientVersion: runtime.dockerClient,
    daemon: runtime.daemon,
    contextName,
    endpoint,
    socket: socket.path,
    socketIdentity: socket,
    environment: Object.freeze(environment),
    builder: builderDetails,
    observation,
    builderReceipt,
  });
}
