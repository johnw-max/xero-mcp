#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const inputs = process.argv.slice(2);
if (inputs.length === 0) {
  process.stderr.write("Usage: node tests/assert-log-redaction.mjs <log-file-or-directory> [...]\n");
  process.exit(2);
}

const sentinels = (process.env.LOG_SECRET_SENTINELS ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const outputPath = process.env.LOG_REDACTION_OUTPUT;
const files = inputs.flatMap(walkFiles);
if (files.length === 0) {
  process.stderr.write("No log files found in the supplied paths.\n");
  process.exit(2);
}

const patterns = [
  {
    id: "authorization-bearer",
    regex: /authorization[\"']?\s*[:=]\s*[\"']?bearer\s+(?!\[?redacted\]?|\*{3,})[A-Za-z0-9._~+\/-]{8,}/gi,
  },
  {
    id: "token-field",
    regex: /(?:access_token|refresh_token|client_secret|mcp_bearer)[\"']?\s*[:=]\s*[\"']?(?!\[?redacted\]?|\*{3,}|null\b)[A-Za-z0-9._~+\/-]{8,}/gi,
  },
  {
    id: "cookie-field",
    regex: /(?:set-cookie|cookie)[\"']?\s*[:=]\s*[\"']?(?!\[?redacted\]?|\*{3,})[^\s\"']{8,}/gi,
  },
  {
    id: "oauth-code-query",
    regex: /(?:\?|&)code=(?!\[?redacted\]?|\*{3,})[A-Za-z0-9._~+\/-]{8,}/gi,
  },
  {
    id: "jwt-like-value",
    regex: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}/g,
  },
];

const findings = [];
const scanned = [];
for (const file of files) {
  const content = readFileSync(file, "utf8");
  scanned.push({
    path: file,
    bytes: Buffer.byteLength(content),
    sha256: createHash("sha256").update(content).digest("hex"),
  });

  for (const { id, regex } of patterns) {
    regex.lastIndex = 0;
    for (const match of content.matchAll(regex)) {
      findings.push(redactedFinding(file, content, id, match.index ?? 0));
    }
  }
  for (const sentinel of sentinels) {
    let offset = content.indexOf(sentinel);
    while (offset !== -1) {
      findings.push(redactedFinding(file, content, "qa-sentinel", offset));
      offset = content.indexOf(sentinel, offset + sentinel.length);
    }
  }
}

const report = {
  status: findings.length === 0 ? "PASS" : "FAIL",
  scanned,
  findingCount: findings.length,
  findings,
  note: "Findings identify file, line and pattern only; matched secret values are never copied into this report.",
  finishedAt: new Date().toISOString(),
};

const rendered = `${JSON.stringify(report, null, 2)}\n`;
if (outputPath) {
  writeFileSync(outputPath, rendered, { mode: 0o600 });
}
process.stdout.write(rendered);
process.exitCode = findings.length === 0 ? 0 : 1;

function walkFiles(input) {
  const path = resolve(input);
  const stat = statSync(path);
  if (stat.isFile()) return [path];
  if (!stat.isDirectory()) return [];
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const child = resolve(path, entry.name);
    if (entry.isDirectory()) return walkFiles(child);
    return entry.isFile() ? [child] : [];
  });
}

function redactedFinding(file, content, pattern, offset) {
  const line = content.slice(0, offset).split("\n").length;
  return { file, line, pattern };
}
