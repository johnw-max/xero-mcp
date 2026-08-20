#!/usr/bin/env node
/**
 * Checks a system-review area against docs/REVIEW-PROTOCOL.md.
 *
 * The protocol exists because a review's conclusions are easy to write and its
 * coverage is easy to quietly shrink. Everything here is aimed at the second
 * problem: it re-runs the enumeration command the reviewer declared, compares
 * the result against the list they submitted, and refuses a coverage file that
 * does not account for every enumerated item.
 *
 * Usage:
 *   node scripts/review/verify-review-artifacts.mjs                 # every area
 *   node scripts/review/verify-review-artifacts.mjs <area>          # one area
 */

import { execFile } from "node:child_process";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const ROOT = process.cwd();
const REVIEW_ROOT = join(ROOT, "artifacts", "system-review");

/**
 * An enumeration command has to be re-runnable and side-effect free, both so it
 * can be checked and because a reviewer should not be enumerating with anything
 * that changes the tree. Anything outside this set is reported rather than run.
 */
const READ_ONLY_LEADERS = new Set([
  "grep", "rg", "find", "ls", "cat", "wc", "sort", "git", "node", "npx", "awk", "sed", "comm", "head", "tail",
]);

function readJson(path) {
  try {
    return { ok: true, value: JSON.parse(readFileSync(path, "utf8")) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function leaderOf(command) {
  return command.trim().split(/\s+/u)[0]?.replace(/^.*\//u, "") ?? "";
}

async function reRunEnumeration(command) {
  const leader = leaderOf(command);
  if (!READ_ONLY_LEADERS.has(leader)) {
    return { rerun: false, reason: `enumeration command starts with ${leader}, which is not a known read-only tool` };
  }
  try {
    const { stdout } = await run("/bin/sh", ["-c", command], { cwd: ROOT, maxBuffer: 32 * 1024 * 1024 });
    return { rerun: true, lines: stdout.split("\n").map((line) => line.trim()).filter(Boolean) };
  } catch (error) {
    return { rerun: false, reason: `enumeration command failed: ${error.message.slice(0, 200)}` };
  }
}

function itemIds(enumeration) {
  return (enumeration.items ?? []).map((item) => (typeof item === "string" ? item : item.id)).filter(Boolean);
}

async function verifyArea(area) {
  const dir = join(REVIEW_ROOT, area);
  const problems = [];
  const notes = [];

  const enumerationRead = readJson(join(dir, "enumeration.json"));
  const coverageRead = readJson(join(dir, "coverage.json"));
  const findingsPath = join(dir, "findings.md");

  if (!enumerationRead.ok) problems.push(`enumeration.json unreadable: ${enumerationRead.error}`);
  if (!coverageRead.ok) problems.push(`coverage.json unreadable: ${coverageRead.error}`);
  if (!existsSync(findingsPath)) problems.push("findings.md missing");
  if (problems.length > 0) return { area, status: "FAIL", problems, notes };

  const enumeration = enumerationRead.value;
  const coverage = coverageRead.value;
  const enumerated = itemIds(enumeration);

  if (enumerated.length === 0) problems.push("enumeration lists no items");

  // The declared count and the declared list must agree with each other before
  // either is worth comparing to anything else.
  if (typeof enumeration.item_count === "number" && enumeration.item_count !== enumerated.length) {
    problems.push(`item_count says ${enumeration.item_count} but items has ${enumerated.length}`);
  }

  // Re-run the enumeration. A list that cannot be reproduced is a list that can
  // be trimmed silently, which is the failure this whole protocol is about.
  if (typeof enumeration.enumerated_by !== "string" || enumeration.enumerated_by.trim() === "") {
    problems.push("enumerated_by is missing - the item list cannot be reproduced");
  } else {
    const rerun = await reRunEnumeration(enumeration.enumerated_by);
    if (!rerun.rerun) {
      notes.push(`could not re-run enumeration: ${rerun.reason}`);
    } else {
      const produced = new Set(rerun.lines);
      const missing = enumerated.filter((id) => !produced.has(id));
      const extra = rerun.lines.filter((line) => !enumerated.includes(line));
      if (missing.length > 0) {
        notes.push(`${missing.length} listed item(s) not produced by the command (e.g. ${missing.slice(0, 3).join(", ")})`);
      }
      if (extra.length > 0) {
        problems.push(`${extra.length} item(s) the command produces are absent from the enumeration (e.g. ${extra.slice(0, 3).join(", ")}) - scope was narrowed`);
      }
    }
  }

  // Every enumerated item needs a verdict. This is the core check.
  const verdicts = new Map((coverage.verdicts ?? []).map((entry) => [entry.id, entry]));
  const uncovered = enumerated.filter((id) => !verdicts.has(id));
  if (uncovered.length > 0) {
    problems.push(`${uncovered.length} enumerated item(s) have no verdict (e.g. ${uncovered.slice(0, 5).join(", ")})`);
  }

  const classes = { EXECUTED: 0, READ: 0, INFERRED: 0, UNKNOWN: 0, MISSING: 0 };
  const verdictCounts = { SOUND: 0, FINDING: 0, NOT_EXAMINED: 0, OTHER: 0 };
  for (const entry of verdicts.values()) {
    const cls = entry.evidence_class;
    if (cls in classes) classes[cls] += 1; else classes.MISSING += 1;
    const verdict = entry.verdict;
    if (verdict in verdictCounts) verdictCounts[verdict] += 1; else verdictCounts.OTHER += 1;
    if (!entry.evidence || String(entry.evidence).trim().length < 12) {
      notes.push(`${entry.id}: evidence field is empty or too short to be evidence`);
    }
  }

  const examined = classes.EXECUTED + classes.READ + classes.INFERRED + classes.UNKNOWN;
  const soft = classes.INFERRED + classes.UNKNOWN;
  if (examined > 0 && soft / examined > 0.3) {
    problems.push(`${Math.round((soft / examined) * 100)}% of verdicts are INFERRED or UNKNOWN - the protocol asks for an explanation above 30%`);
  }
  if (classes.MISSING > 0) problems.push(`${classes.MISSING} verdict(s) carry no evidence_class`);

  // Findings must show what would have falsified them. A finding without that is
  // how a capture whose call shape differed from production became a "critical
  // production defect" here once already.
  const findings = readFileSync(findingsPath, "utf8");
  const findingHeadings = [...findings.matchAll(/^#{2,4}\s+.*$/gmu)].length;
  const falsificationMentions = [...findings.matchAll(/证伪|falsif/giu)].length;
  if (findingHeadings > 0 && falsificationMentions === 0) {
    problems.push("findings.md has findings but no falsification attempt anywhere");
  }
  if (!/查过且认为无问题|sound|no problem found/iu.test(findings)) {
    notes.push("findings.md has no negative-results section - silence must not stand for 'checked and fine'");
  }

  return {
    area,
    status: problems.length === 0 ? "PASS" : "FAIL",
    problems,
    notes,
    stats: { enumerated: enumerated.length, covered: verdicts.size, classes, verdicts: verdictCounts },
  };
}

async function main() {
  const requested = process.argv[2];
  if (!existsSync(REVIEW_ROOT)) {
    console.error(JSON.stringify({ status: "FAIL", error: `no ${REVIEW_ROOT}` }, null, 2));
    process.exit(1);
  }
  const areas = requested
    ? [requested]
    : readdirSync(REVIEW_ROOT, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);

  const results = [];
  for (const area of areas.sort()) results.push(await verifyArea(area));

  console.log(JSON.stringify({
    checked: results.length,
    passed: results.filter((result) => result.status === "PASS").length,
    results,
  }, null, 2));
  process.exit(results.some((result) => result.status === "FAIL") ? 1 : 0);
}

await main();
