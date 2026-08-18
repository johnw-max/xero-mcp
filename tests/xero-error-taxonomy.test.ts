import { describe, expect, it } from "vitest";
import { AppError } from "../src/errors.js";
import { xeroMcpFailureEnvelope } from "../src/mcp/xeroFailureEnvelope.js";
import { xeroCapabilityDenied } from "../src/policy/xeroCapabilityError.js";
import {
  classifyXeroProviderFailure,
  xeroProviderReadFailure,
  xeroUncertainWriteFailureDetails,
} from "../src/providers/xeroProviderFailure.js";

describe("Xero permission and connection failure taxonomy", () => {
  it.each([
    [{ response: { status: 401 } }, "OAUTH_TOKEN_EXPIRED", "PROVIDER_OAUTH_TOKEN", false],
    [{ response: { status: 403 } }, "FORBIDDEN", "PROVIDER_ACCESS", false],
    [{ response: { status: 429 } }, "RATE_LIMITED", "PROVIDER_RATE_LIMIT", true],
    [{ response: { status: 503 } }, "PROVIDER_UNAVAILABLE", "PROVIDER_SERVICE", true],
    [{ code: "ETIMEDOUT" }, "NETWORK_UNAVAILABLE", "NETWORK", true],
  ] as const)("classifies %j without calling it read-only", (raw, code, layer, retryable) => {
    const classified = classifyXeroProviderFailure(raw);
    expect(classified).toMatchObject({ code, failureLayer: layer, retryable });
    expect(classified.reasonCode).not.toContain("READ_ONLY");
  });

  it("keeps a post-send 403 as an uncertain write with readback-only recovery", () => {
    expect(xeroUncertainWriteFailureDetails({ response: { status: 403 } })).toMatchObject({
      failureLayer: "PROVIDER_ACCESS",
      reasonCodes: ["PROVIDER_ACCESS_DENIED"],
      recoveryAction: "READBACK_RECOVERY_ONLY",
      providerMutationPossible: true,
    });
  });

  it("does not expose provider bodies in a read failure", () => {
    const failure = xeroProviderReadFailure({
      response: { status: 403, body: { access_token: "secret", message: "raw role detail" } },
    });
    expect(failure.code).toBe("FORBIDDEN");
    expect(failure.details).toMatchObject({
      failureLayer: "PROVIDER_ACCESS",
      reasonCodes: ["PROVIDER_ACCESS_DENIED"],
      recoveryAction: "VERIFY_XERO_ACCESS_AND_TENANT",
    });
    expect(JSON.stringify(failure.details)).not.toContain("secret");
    expect(JSON.stringify(failure.details)).not.toContain("raw role detail");
  });

  it("treats readback mismatch as a potentially committed provider mutation", () => {
    const payload = xeroMcpFailureEnvelope(new AppError("READBACK_MISMATCH", "Readback differs.", {
      details: { providerMutationPossible: false },
    }));
    expect(payload.error.provider_mutation_possible).toBe(true);
  });

  it("defaults an MCP scope failure to the MCP scope recovery path", () => {
    const payload = xeroMcpFailureEnvelope(new AppError("SCOPE_MISSING", "Scope is missing."));
    expect(payload.error).toMatchObject({
      failure_layer: "MCP_SCOPE",
      recovery_action: "REAUTHORISE_MCP_SCOPE",
    });
  });

  it("bounds machine fields and drops unapproved detail strings", () => {
    const payload = xeroMcpFailureEnvelope(new AppError("FORBIDDEN", "Denied.", {
      details: {
        failureLayer: "ATTACKER_CONTROLLED_LAYER",
        recoveryAction: "EXFILTRATE_TOKEN",
        reasonCodes: [
          "PROVIDER_ACCESS_DENIED",
          "raw provider body",
          `SOURCE_${"A".repeat(80)}`,
          ...Array.from({ length: 40 }, (_, index) => `SOURCE_SAFE_${index}`),
        ],
        auditCallId: `call_${"a".repeat(124)}`,
      },
    }));
    expect(payload.error.failure_layer).toBe("AUTHORIZATION");
    expect(payload.error.recovery_action).toBe("INSPECT_AUTHORIZATION_BINDING");
    expect(payload.error.reason_codes).toHaveLength(32);
    expect(payload.error.reason_codes).toContain("PROVIDER_ACCESS_DENIED");
    expect(payload.error.auditCallId).toBeUndefined();
    expect(JSON.stringify(payload)).not.toContain("raw provider body");
    expect(JSON.stringify(payload)).not.toContain("EXFILTRATE_TOKEN");
  });

  it("allowlists capability deny reasons before projecting them", () => {
    const payload = xeroMcpFailureEnvelope(xeroCapabilityDenied(
      "Scope denied.",
      ["MISSING_MCP_SCOPE", "RAW_PROVIDER_SECRET"],
    ));
    expect(payload.error).toMatchObject({
      code: "SCOPE_MISSING",
      failure_layer: "MCP_SCOPE",
      recovery_action: "REAUTHORISE_MCP_SCOPE",
      reason_codes: ["MISSING_MCP_SCOPE"],
    });
    expect(JSON.stringify(payload)).not.toContain("RAW_PROVIDER_SECRET");
  });

  it("projects internal reason families into one stable MCP envelope", () => {
    const payload = xeroMcpFailureEnvelope(new AppError("SCOPE_MISSING", "Scope is missing.", {
      httpStatus: 403,
      details: {
        failureLayer: "PROVIDER_OAUTH_SCOPE",
        denyReasons: ["PROVIDER_ACCESS_DENIED"],
        providerAccessDenyReasons: ["MISSING_XERO_OAUTH_SCOPE"],
        validationReasonCodes: ["SOURCE_GROSS_MISMATCH"],
        reasonCodes: ["MISSING_XERO_OAUTH_SCOPE"],
        recoveryAction: "REAUTHORISE_XERO_SCOPES",
        operationId: "op_case_1",
      },
    }));
    expect(payload.error).toEqual(expect.objectContaining({
      code: "SCOPE_MISSING",
      failure_layer: "PROVIDER_OAUTH_SCOPE",
      recovery_action: "REAUTHORISE_XERO_SCOPES",
      provider_mutation_possible: false,
      operation_id: "op_case_1",
      reason_codes: [
        "MISSING_XERO_OAUTH_SCOPE",
        "PROVIDER_ACCESS_DENIED",
        "SOURCE_GROSS_MISMATCH",
      ],
    }));
  });

  it("classifies deterministic Accounting Case graph diagnostics as validation, never Provider response", () => {
    const payload = xeroMcpFailureEnvelope(new AppError(
      "VALIDATION_FAILED",
      "Accounting Case source facts are inconsistent.",
      {
        httpStatus: 422,
        details: {
          failureLayer: "DETERMINISTIC_VALIDATION",
          reasonCodes: ["PAYMENT_DOCUMENT_BRIDGE_MISMATCH"],
          providerMutationPossible: false,
        },
      },
    ));
    expect(payload.error).toMatchObject({
      code: "VALIDATION_FAILED",
      retryable: false,
      failure_layer: "DETERMINISTIC_VALIDATION",
      provider_mutation_possible: false,
      recovery_action: "CORRECT_CASE_FACTS",
      reason_codes: ["PAYMENT_DOCUMENT_BRIDGE_MISMATCH"],
    });
  });

  it("returns bounded Case recovery coordinates without exposing arbitrary details", () => {
    const payload = xeroMcpFailureEnvelope(new AppError("VALIDATION_FAILED", "A later Case operation failed.", {
      httpStatus: 422,
      details: {
        caseId: "case-2026/08/13",
        caseVersion: 3,
        completedOperationIds: ["op_invoice_1", "../../unsafe id", 7],
        failedOperationId: "op_credit_2",
        nextAction: "GET_ACCOUNTING_CASE_STATUS",
        rawProviderBody: { token: "must-not-leak" },
      },
    }));
    expect(payload.error).toMatchObject({
      case_id: "case-2026/08/13",
      case_version: 3,
      completed_operation_ids: ["op_invoice_1"],
      failed_operation_id: "op_credit_2",
      next_action: "GET_ACCOUNTING_CASE_STATUS",
    });
    expect(JSON.stringify(payload)).not.toContain("must-not-leak");
  });

  it.each([
    ["TARGET_SESSION_EXPIRED", "TARGET_BINDING", "PIN_LEDGER_TARGET"],
    ["OAUTH_REFRESH_FAILED", "PROVIDER_OAUTH_REFRESH", "RECONNECT_XERO"],
    ["SUBJECT_FORBIDDEN", "PROVIDER_USER_ROLE", "VERIFY_XERO_USER_ROLE_AND_TENANT"],
    ["RATE_LIMITED", "PROVIDER_RATE_LIMIT", "RETRY_WITH_BACKOFF"],
    ["NETWORK_UNAVAILABLE", "NETWORK", "RETRY_AFTER_CONNECTIVITY_RECOVERS"],
  ] as const)("provides a non-UNKNOWN default for %s", (code, layer, recovery) => {
    const payload = xeroMcpFailureEnvelope(new AppError(code, "safe"));
    expect(payload.error.failure_layer).toBe(layer);
    expect(payload.error.recovery_action).toBe(recovery);
  });
});
