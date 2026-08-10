#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { runHarness } from "./lib/runner-core.mjs";

const scriptPath = fileURLToPath(import.meta.url);

function usage() {
  return `Agent2 Remote Agents behavior harness

Usage:
  node harness/remote-agents/run-behavior.mjs --manifest <path> [--dry-run | --mock | --live]

Options:
  --manifest <path>  Required JSON manifest.
  --dry-run          Validate and enumerate only. This is the default.
  --mock             Use mock responses embedded in the manifest; never use the network.
  --live             Call AGENT2_REMOTE_AGENTS_URL with AGENT2_REMOTE_AGENTS_API_KEY.
  --allow-write      Required before any live case declared as operation=write can run.
  --out-dir <path>   Override artifacts/harness-runs/<run-id>.
  --run-id <id>      Set a stable evidence directory name.
  --help             Show this message.

The API key is deliberately not accepted as a command-line or manifest value.`;
}

function parseArgs(argv) {
  const parsed = {
    manifestPath: null,
    mode: "dry-run",
    allowWrite: false,
    outputDir: null,
    runId: null,
    help: false,
  };
  let explicitMode = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      parsed.help = true;
      continue;
    }
    if (["--dry-run", "--mock", "--live"].includes(argument)) {
      const nextMode = argument.slice(2);
      if (explicitMode && explicitMode !== nextMode) {
        throw new Error("Choose exactly one of --dry-run, --mock, or --live");
      }
      explicitMode = nextMode;
      parsed.mode = nextMode;
      continue;
    }
    if (argument === "--allow-write") {
      parsed.allowWrite = true;
      continue;
    }
    if (["--manifest", "--out-dir", "--run-id"].includes(argument)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${argument} requires a value`);
      }
      index += 1;
      if (argument === "--manifest") {
        parsed.manifestPath = value;
      } else if (argument === "--out-dir") {
        parsed.outputDir = value;
      } else {
        parsed.runId = value;
      }
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  if (!parsed.help && !parsed.manifestPath) {
    throw new Error("--manifest is required");
  }
  if (parsed.allowWrite && parsed.mode !== "live") {
    throw new Error("--allow-write is only meaningful with --live");
  }
  return parsed;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  const result = await runHarness(options);
  const relativeOutput = path.relative(process.cwd(), result.outputDir) || ".";
  const counts = new Map();
  for (const item of result.results) {
    counts.set(item.verdict, (counts.get(item.verdict) ?? 0) + 1);
  }
  process.stdout.write(
    `${JSON.stringify({ run_id: result.runId, mode: options.mode, output: relativeOutput, verdicts: Object.fromEntries(counts) })}\n`,
  );
  const hasHardFailure = result.results.some((item) => ["FAIL", "UNSUPPORTED"].includes(item.verdict));
  if (hasHardFailure) {
    return 2;
  }
  if (result.results.some((item) => item.verdict.startsWith("BLOCKED_"))) {
    return 3;
  }
  if (result.results.some((item) => item.verdict === "FLAKY")) {
    return 4;
  }
  if (options.mode === "live" && result.results.some((item) => item.verdict === "NOT_RUN")) {
    return 5;
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  main().then(
    (exitCode) => {
      process.exitCode = exitCode;
    },
    (error) => {
      process.stderr.write(`${error?.stack ?? error}\n`);
      process.exitCode = 1;
    },
  );
}
