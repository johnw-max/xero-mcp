import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { AppError } from "../../src/errors.js";
import { createAccountingMcpServer } from "../../src/mcp/createServer.js";
import { TOOL_ALLOWLIST } from "../../src/mcp/toolNames.js";
import { createLegacySharedBearerRequestContext } from "../../src/security/requestContext.js";
import { XERO_RELEASE_ATTESTATION, XERO_RELEASE_VERSION } from "../../src/xeroRelease.js";
import type { XeroAccountingCaseService } from "../../src/services/xeroAccountingCaseService.js";
import {
  createDeterministicAccountingService,
  type ServiceCall,
} from "../lib/deterministicAccountingService.js";

type JsonObject = Record<string, unknown>;
type CaseStatus = "PASS" | "FAIL";

interface ValidReadCase {
  id: string;
  tool: string;
  arguments: JsonObject;
  expectedServiceMethod: string;
}

interface InvalidInputCase {
  id: string;
  tool: string;
  arguments: JsonObject;
  forbiddenServiceMethod: string;
}

interface ContractManifest {
  schemaVersion: string;
  releaseVersion: string;
  requiredMigration: string;
  authorityModel: "STANDING_DELEGATION";
  expectedTools: string[];
  forbiddenPublicTools: string[];
  dangerousTools: string[];
  validReadCases: ValidReadCase[];
  invalidInputCases: InvalidInputCase[];
}

interface CaseResult {
  id: string;
  dimension: "PROTOCOL" | "VERSION" | "TOOL_SURFACE" | "ROUTING" | "SCHEMA" | "WRITE_GATE";
  status: CaseStatus;
  detail: string;
  tool?: string;
}

interface ToolReceipt {
  caseId: string;
  tool: string;
  arguments: JsonObject;
  outcome: "SUCCESS" | "MCP_ERROR" | "THROWN_ERROR";
  isError: boolean;
  serviceMethodsReached: string[];
  writeAttemptsAfterCall: number;
  structuredContent?: unknown;
  error?: { name: string; message: string; code?: number };
}

const repoRoot = resolve(import.meta.dirname, "../..");
const manifestPath = resolve(repoRoot, "harness/manifests/contract-v1.json");

function parseOptions(argv: string[]): { runId: string; outputDirectory?: string } {
  const runIdIndex = argv.indexOf("--run-id");
  const explicit = runIdIndex >= 0 ? argv[runIdIndex + 1] : undefined;
  if (runIdIndex >= 0 && !explicit) throw new Error("--run-id requires a value");
  const fromEnvironment = process.env.XERO_HARNESS_RUN_ID;
  const value = explicit ?? fromEnvironment ?? new Date().toISOString().replaceAll(":", "-");
  if (!/^[A-Za-z0-9._:-]+$/.test(value)) {
    throw new Error("run ID must contain only letters, numbers, dot, underscore, colon, or hyphen");
  }
  const outputIndex = argv.indexOf("--out-dir");
  const outputDirectory = outputIndex >= 0 ? argv[outputIndex + 1] : undefined;
  if (outputIndex >= 0 && !outputDirectory) throw new Error("--out-dir requires a value");
  const knownIndexes = new Set([
    ...(runIdIndex >= 0 ? [runIdIndex, runIdIndex + 1] : []),
    ...(outputIndex >= 0 ? [outputIndex, outputIndex + 1] : []),
  ]);
  const unknown = argv.find((_argument, index) => !knownIndexes.has(index));
  if (unknown) throw new Error(`Unknown argument: ${unknown}`);
  return { runId: value, ...(outputDirectory ? { outputDirectory: resolve(outputDirectory) } : {}) };
}

function serviceMethodsSince(calls: ServiceCall[], start: number): string[] {
  return calls.slice(start).map((call) => call.method);
}

function asError(error: unknown): { name: string; message: string; code?: number; stack?: string } {
  if (error instanceof Error) {
    const possibleCode = (error as Error & { code?: unknown }).code;
    return {
      name: error.name,
      message: error.message,
      ...(typeof possibleCode === "number" ? { code: possibleCode } : {}),
      ...(error.stack ? { stack: error.stack } : {}),
    };
  }
  return { name: "UnknownError", message: String(error) };
}

function pass(
  results: CaseResult[],
  id: string,
  dimension: CaseResult["dimension"],
  detail: string,
  tool?: string,
): void {
  results.push({ id, dimension, status: "PASS", detail, ...(tool ? { tool } : {}) });
}

function fail(
  results: CaseResult[],
  id: string,
  dimension: CaseResult["dimension"],
  detail: string,
  tool?: string,
): void {
  results.push({ id, dimension, status: "FAIL", detail, ...(tool ? { tool } : {}) });
}

function resultIsError(result: unknown): boolean {
  return typeof result === "object" && result !== null && (result as { isError?: unknown }).isError === true;
}

function structuredContent(result: unknown): unknown {
  return typeof result === "object" && result !== null
    ? (result as { structuredContent?: unknown }).structuredContent
    : undefined;
}

async function callAndReceipt(options: {
  client: Client;
  calls: ServiceCall[];
  writeAttempts: () => number;
  caseId: string;
  tool: string;
  arguments: JsonObject;
}): Promise<{ result?: unknown; thrown?: { name: string; message: string; code?: number }; receipt: ToolReceipt }> {
  const start = options.calls.length;
  try {
    const result = await options.client.callTool({ name: options.tool, arguments: options.arguments });
    const isError = resultIsError(result);
    return {
      result,
      receipt: {
        caseId: options.caseId,
        tool: options.tool,
        arguments: options.arguments,
        outcome: isError ? "MCP_ERROR" : "SUCCESS",
        isError,
        serviceMethodsReached: serviceMethodsSince(options.calls, start),
        writeAttemptsAfterCall: options.writeAttempts(),
        structuredContent: structuredContent(result),
      },
    };
  } catch (error) {
    const thrown = asError(error);
    return {
      thrown,
      receipt: {
        caseId: options.caseId,
        tool: options.tool,
        arguments: options.arguments,
        outcome: "THROWN_ERROR",
        isError: true,
        serviceMethodsReached: serviceMethodsSince(options.calls, start),
        writeAttemptsAfterCall: options.writeAttempts(),
        error: thrown,
      },
    };
  }
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const runId = options.runId;
  const outputDirectory = options.outputDirectory ?? resolve(repoRoot, "artifacts/harness-runs", runId);
  const contractResultsPath = resolve(outputDirectory, "contract-results.json");
  const receiptsPath = resolve(outputDirectory, "tool-receipts.jsonl");
  const generatedAt = new Date().toISOString();
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as ContractManifest;
  const packageVersion = (JSON.parse(await readFile(resolve(repoRoot, "package.json"), "utf8")) as { version?: unknown }).version;
  const results: CaseResult[] = [];
  const receipts: ToolReceipt[] = [];
  const harnessService = createDeterministicAccountingService();
  const accountingCases = {
    prepare: async (...args: unknown[]) => {
      harnessService.calls.push({ method: "accountingCase.prepare", arguments: args });
      return {
        case_id: "contract-case-001",
        case_version: 1,
        state: "PLANNED_NEEDS_PREFLIGHT",
        completion_claim: { ledger_write_claim: "NOT_WRITTEN" },
      };
    },
    execute: async (...args: unknown[]) => {
      harnessService.calls.push({ method: "accountingCase.execute", arguments: args });
      throw new AppError(
        "SCOPE_MISSING",
        "The exact ordinary Accounting Case requires xero.draft.write before preflight or execution.",
        {
          httpStatus: 403,
          details: {
            failureLayer: "MCP_SCOPE",
            reasonCodes: ["MISSING_MCP_SCOPE"],
            recoveryAction: "REAUTHORISE_MCP_SCOPE",
            providerMutationPossible: false,
          },
        },
      );
    },
    status: async (...args: unknown[]) => {
      harnessService.calls.push({ method: "accountingCase.status", arguments: args });
      return {
        case_id: "contract-case-001",
        case_version: 1,
        state: "PLANNED_NEEDS_PREFLIGHT",
        completion_claim: { ledger_write_claim: "NOT_WRITTEN" },
      };
    },
  } as unknown as Pick<XeroAccountingCaseService, "prepare" | "execute" | "status">;
  const context = createLegacySharedBearerRequestContext({
    actorId: "contract-harness-read-only",
    audience: "https://xero-mcp.contract-harness.invalid/mcp",
    scopes: ["xero.read"],
  });
  const server = createAccountingMcpServer(harnessService.service, context, undefined, undefined, accountingCases);
  const client = new Client({ name: "xero-contract-harness", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport as unknown as Transport);
    await client.connect(clientTransport);
    const serverVersion = client.getServerVersion();
    const serverCapabilities = client.getServerCapabilities();
    if (serverVersion?.name === "zcloak-xero-accounting-mcp-demo" && typeof serverVersion.version === "string") {
      pass(results, "protocol.initialize", "PROTOCOL", `initialize negotiated ${serverVersion.name}@${serverVersion.version}`);
    } else {
      fail(results, "protocol.initialize", "PROTOCOL", "initialize did not return the expected server identity");
    }

    if (
      typeof packageVersion === "string" &&
      serverVersion?.version === packageVersion &&
      XERO_RELEASE_VERSION === packageVersion
    ) {
      pass(
        results,
        "version.one-source",
        "VERSION",
        `package, MCP initialize, health and readiness share ${packageVersion} via XERO_RELEASE_VERSION`,
      );
    } else {
      fail(
        results,
        "version.one-source",
        "VERSION",
        `version drift: package=${String(packageVersion)}, initialize=${String(serverVersion?.version)}, shared=${XERO_RELEASE_VERSION}`,
      );
    }

    if (manifest.requiredMigration === XERO_RELEASE_ATTESTATION.requiredMigration) {
      pass(
        results,
        "version.migration-head",
        "VERSION",
        `contract and runtime require ${manifest.requiredMigration}`,
      );
    } else {
      fail(
        results,
        "version.migration-head",
        "VERSION",
        `migration head drift: contract=${manifest.requiredMigration}, runtime=${XERO_RELEASE_ATTESTATION.requiredMigration}`,
      );
    }

    try {
      await client.ping();
      pass(results, "protocol.ping", "PROTOCOL", "ping returned successfully");
    } catch (error) {
      fail(results, "protocol.ping", "PROTOCOL", `ping failed: ${asError(error).message}`);
    }

    const listed = await client.listTools();
    const actualTools = listed.tools.map((tool) => tool.name).sort();
    const manifestTools = [...manifest.expectedTools].sort();
    const productionAllowlist: string[] = [...TOOL_ALLOWLIST].sort();
    const missing = manifestTools.filter((tool) => !actualTools.includes(tool));
    const unexpected = actualTools.filter((tool) => !manifestTools.includes(tool));
    const allowlistDrift = manifestTools.filter((tool) => !productionAllowlist.includes(tool))
      .concat(productionAllowlist.filter((tool) => !manifestTools.includes(tool)));

    if (actualTools.length === TOOL_ALLOWLIST.length && missing.length === 0 && unexpected.length === 0 && allowlistDrift.length === 0) {
      pass(results, "surface.exact-reviewed-tools", "TOOL_SURFACE", `tools/list exactly matches the pinned ${TOOL_ALLOWLIST.length}-tool production allowlist`);
    } else {
      fail(
        results,
        "surface.exact-reviewed-tools",
        "TOOL_SURFACE",
        `tool drift: count=${actualTools.length}, missing=${missing.join(",") || "none"}, unexpected=${unexpected.join(",") || "none"}, allowlistDrift=${allowlistDrift.join(",") || "none"}`,
      );
    }

    const dangerousPresent = manifest.dangerousTools.filter((tool) => actualTools.includes(tool));
    const forbiddenPublicPresent = manifest.forbiddenPublicTools.filter((tool) => actualTools.includes(tool));
    if (dangerousPresent.length === 0 && forbiddenPublicPresent.length === 0) {
      pass(results, "surface.no-bypass-tools", "TOOL_SURFACE", "dangerous tools and legacy object-level mutation bypasses are absent");
    } else {
      fail(
        results,
        "surface.no-bypass-tools",
        "TOOL_SURFACE",
        `dangerous=${dangerousPresent.join(", ") || "none"}, legacyMutation=${forbiddenPublicPresent.join(", ") || "none"}`,
      );
    }

    const unsafeAnnotationTools = listed.tools.filter((tool) =>
      manifest.dangerousTools.includes(tool.name) || tool.annotations?.destructiveHint === true);
    if (unsafeAnnotationTools.length === 0) {
      pass(results, "surface.no-destructive-annotations", "TOOL_SURFACE", "no advertised tool declares destructiveHint=true");
    } else {
      fail(results, "surface.no-destructive-annotations", "TOOL_SURFACE", `unsafe annotations on ${unsafeAnnotationTools.map((tool) => tool.name).join(", ")}`);
    }

    for (const testCase of manifest.validReadCases) {
      const beforeMethodCalls = harnessService.calls.filter((call) => call.method === testCase.expectedServiceMethod).length;
      const invocation = await callAndReceipt({
        client,
        calls: harnessService.calls,
        writeAttempts: harnessService.writeAttempts,
        caseId: testCase.id,
        tool: testCase.tool,
        arguments: testCase.arguments,
      });
      receipts.push(invocation.receipt);
      const afterMethodCalls = harnessService.calls.filter((call) => call.method === testCase.expectedServiceMethod).length;
      if (
        !invocation.thrown &&
        !resultIsError(invocation.result) &&
        afterMethodCalls === beforeMethodCalls + 1 &&
        invocation.receipt.serviceMethodsReached.includes("withAudit")
      ) {
        pass(results, testCase.id, "ROUTING", `routed once through audit to ${testCase.expectedServiceMethod}`, testCase.tool);
      } else {
        fail(
          results,
          testCase.id,
          "ROUTING",
          `expected one audited ${testCase.expectedServiceMethod} call; reached=${invocation.receipt.serviceMethodsReached.join(",") || "none"}`,
          testCase.tool,
        );
      }
    }

    for (const testCase of manifest.invalidInputCases) {
      const beforeMethodCalls = harnessService.calls.filter((call) => call.method === testCase.forbiddenServiceMethod).length;
      const invocation = await callAndReceipt({
        client,
        calls: harnessService.calls,
        writeAttempts: harnessService.writeAttempts,
        caseId: testCase.id,
        tool: testCase.tool,
        arguments: testCase.arguments,
      });
      receipts.push(invocation.receipt);
      const afterMethodCalls = harnessService.calls.filter((call) => call.method === testCase.forbiddenServiceMethod).length;
      if ((invocation.thrown || resultIsError(invocation.result)) && afterMethodCalls === beforeMethodCalls) {
        pass(results, testCase.id, "SCHEMA", `invalid input was rejected before ${testCase.forbiddenServiceMethod}`, testCase.tool);
      } else {
        fail(
          results,
          testCase.id,
          "SCHEMA",
          `invalid input escaped validation; reached=${invocation.receipt.serviceMethodsReached.join(",") || "none"}`,
          testCase.tool,
        );
      }
    }

    for (const forbiddenTool of [...manifest.dangerousTools, ...manifest.forbiddenPublicTools]) {
      const caseId = `surface.invoke-absent.${forbiddenTool}`;
      const invocation = await callAndReceipt({
        client,
        calls: harnessService.calls,
        writeAttempts: harnessService.writeAttempts,
        caseId,
        tool: forbiddenTool,
        arguments: {},
      });
      receipts.push(invocation.receipt);
      if ((invocation.thrown || resultIsError(invocation.result)) && invocation.receipt.serviceMethodsReached.length === 0) {
        pass(results, caseId, "TOOL_SURFACE", "unadvertised bypass tool invocation was rejected", forbiddenTool);
      } else {
        fail(results, caseId, "TOOL_SURFACE", "bypass tool invocation was not rejected at the MCP boundary", forbiddenTool);
      }
    }

    const caseExecute = {
      case_id: "contract-case-001",
      case_version: 1,
      request_id: "contract-harness-case-execute-scope-probe",
    };
    const executeCallsBefore = harnessService.calls.filter((call) =>
      call.method === "accountingCase.execute").length;
    const writeInvocation = await callAndReceipt({
      client,
      calls: harnessService.calls,
      writeAttempts: harnessService.writeAttempts,
      caseId: "write-gate.read-only-scope-denies-case-execute",
      tool: "xero_execute_accounting_case",
      arguments: caseExecute,
    });
    receipts.push(writeInvocation.receipt);
    const executeCallsAfter = harnessService.calls.filter((call) =>
      call.method === "accountingCase.execute").length;
    const writeErrorJson = JSON.stringify(structuredContent(writeInvocation.result)) ?? "";
    if (
      resultIsError(writeInvocation.result) &&
      writeErrorJson.includes("SCOPE_MISSING") &&
      writeErrorJson.includes("MCP_SCOPE") &&
      writeErrorJson.includes("REAUTHORISE_MCP_SCOPE") &&
      writeErrorJson.includes("xero.draft.write") &&
      executeCallsAfter - executeCallsBefore <= 1 &&
      harnessService.writeAttempts() === 0
    ) {
      pass(
        results,
        "write-gate.read-only-scope-denies-case-execute",
        "WRITE_GATE",
        "ordinary Case execute was denied at the MCP/service state gate with zero Provider writes",
        "xero_execute_accounting_case",
      );
    } else {
      fail(
        results,
        "write-gate.read-only-scope-denies-case-execute",
        "WRITE_GATE",
        `write gate failed closed incorrectly; writeAttempts=${harnessService.writeAttempts()}, response=${writeErrorJson}`,
        "xero_execute_accounting_case",
      );
    }

    if (harnessService.writeAttempts() === 0) {
      pass(results, "write-gate.zero-provider-writes", "WRITE_GATE", "the entire run reached zero provider write methods");
    } else {
      fail(results, "write-gate.zero-provider-writes", "WRITE_GATE", `${harnessService.writeAttempts()} provider write method(s) were reached`);
    }

    const passed = results.filter((result) => result.status === "PASS").length;
    const failed = results.length - passed;
    const report = {
      schemaVersion: "1.0",
      runId,
      generatedAt,
      executionMode: "LOCAL_IN_MEMORY_NO_XERO_NETWORK",
      guardrails: {
        realXeroUsed: false,
        remoteWriteEnabled: false,
        requestScopes: [...context.scopes],
        providerWriteAttempts: harnessService.writeAttempts(),
      },
      manifest: {
        path: "harness/manifests/contract-v1.json",
        schemaVersion: manifest.schemaVersion,
      },
      protocol: {
        serverVersion,
        serverCapabilities,
      },
      toolSurface: {
        expected: manifestTools,
        actual: actualTools,
        missing,
        unexpected,
        dangerousPresent,
        forbiddenPublicPresent,
      },
      summary: {
        total: results.length,
        passed,
        failed,
        status: failed === 0 ? "PASS" : "FAIL",
      },
      cases: results,
    };

    await mkdir(outputDirectory, { recursive: true });
    await writeFile(contractResultsPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    await writeFile(receiptsPath, receipts.map((receipt) => JSON.stringify(receipt)).join("\n") + "\n", "utf8");

    process.stdout.write(`${JSON.stringify({
      runId,
      status: report.summary.status,
      total: report.summary.total,
      passed: report.summary.passed,
      failed: report.summary.failed,
      providerWriteAttempts: harnessService.writeAttempts(),
      contractResultsPath,
      receiptsPath,
    }, null, 2)}\n`);
    if (failed > 0) process.exitCode = 1;
  } finally {
    await Promise.allSettled([client.close(), server.close()]);
  }
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ status: "HARNESS_ERROR", error: asError(error) }, null, 2)}\n`);
  process.exitCode = 1;
});
