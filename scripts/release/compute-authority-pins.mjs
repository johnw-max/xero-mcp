#!/usr/bin/env node
/**
 * Compute authority pins for deployment: the SHA256 of standing-delegation JSON bytes
 * and the authority snapshot hash. Operators use this when editing deployment env files
 * to ensure consistency between the delegation content and the revision number.
 *
 * The snapshot hash covers the delegation content, so any change to
 * XERO_STANDING_DELEGATIONS_JSON requires BOTH:
 * 1. Re-pinning XERO_STANDING_DELEGATIONS_CONFIG_SHA256 (hash of the raw JSON bytes)
 * 2. Bumping XERO_AUTHORITY_REVISION (the DB refuses the same revision with different
 *    content, and refuses a lower revision — rollback means republishing the OLD content
 *    under a HIGHER revision, never reverting the number)
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function parseArguments(argv) {
  const options = {
    envPath: undefined,
    revision: undefined,
  };

  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];

    if (flag === "--env") {
      if (!value) throw new Error("--env requires a value");
      options.envPath = resolve(value);
    } else if (flag === "--revision") {
      if (!value) throw new Error("--revision requires a value");
      const parsed = Number.parseInt(value, 10);
      if (!Number.isSafeInteger(parsed) || parsed < 1) {
        throw new Error("--revision must be a positive integer");
      }
      options.revision = parsed;
    } else if (flag) {
      throw new Error(`Unknown argument: ${flag}`);
    }
  }

  if (!options.envPath) {
    throw new Error("--env <path/to/candidate.env> is required");
  }

  return options;
}

function parseEnvFile(filePath) {
  const content = readFileSync(filePath, "utf8");
  const env = {};

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    // Skip blank lines and comments
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    // Parse KEY=VALUE
    const equalIndex = trimmed.indexOf("=");
    if (equalIndex === -1) {
      continue;
    }
    const key = trimmed.slice(0, equalIndex);
    const value = trimmed.slice(equalIndex + 1); // Everything after first =, no quote stripping
    env[key] = value;
  }

  return env;
}

async function main() {
  try {
    const options = parseArguments(process.argv.slice(2));

    // Parse the env file
    const parsedEnv = parseEnvFile(options.envPath);

    // Set all parsed env vars into process.env
    for (const [key, value] of Object.entries(parsedEnv)) {
      process.env[key] = value;
    }

    // The whole point of this tool is to be run right after the operator has
    // edited XERO_STANDING_DELEGATIONS_JSON, i.e. while the pinned sha in the
    // env is stale. loadConfig() refuses a stale sha, so compute the fresh sha
    // from the raw bytes first and feed it in — the config gate then validates
    // everything else exactly as the server would.
    const rawStandingDelegationsJson = process.env.XERO_STANDING_DELEGATIONS_JSON ?? "[]";
    const configSha256 = sha256(rawStandingDelegationsJson);
    process.env.XERO_STANDING_DELEGATIONS_CONFIG_SHA256 = configSha256;

    // Load config using the same method as the server
    const configModule = await import(pathToFileURL(resolve("dist/config.js")).href);
    const config = configModule.loadConfig();

    // Determine revision to use
    const revision = options.revision ?? config.xeroAuthorityRevision;

    // Import ledgerAuthority module
    const laModule = await import(pathToFileURL(resolve("dist/domain/ledgerAuthority.js")).href);

    // Create the snapshot
    const snapshot = laModule.createLedgerAuthoritySnapshot({
      providerId: "xero",
      revision,
      writeKillSwitchEnabled: config.xeroWriteEnabled,
      standingDelegations: config.xeroStandingDelegations ?? [],
      publishedAt: new Date(),
    });

    // Print the three required lines to stdout
    process.stdout.write(`XERO_STANDING_DELEGATIONS_CONFIG_SHA256=${configSha256}\n`);
    process.stdout.write(`XERO_EXPECTED_AUTHORITY_SNAPSHOT_SHA256=${snapshot.snapshotHash}\n`);
    process.stdout.write(`XERO_AUTHORITY_REVISION=${revision}\n`);

    process.exitCode = 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

main();
