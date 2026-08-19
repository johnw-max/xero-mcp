import { describe, expect, it } from "vitest";
import { z } from "zod";
import { xeroMcpFailureEnvelope } from "./xeroFailureEnvelope.js";
import { AppError } from "../errors.js";

const documentIntake = z.object({
  documents: z.array(z.object({
    document_type: z.enum(["ACCPAY", "ACCREC"]),
    reference: z.string().min(1),
    lines: z.array(z.object({ account_code: z.string().min(1) })).min(1),
  })).min(1),
});

function schemaFailure(input: unknown): unknown {
  try {
    documentIntake.parse(input);
    throw new Error("expected the schema to reject this input");
  } catch (error) {
    return error;
  }
}

describe("schema failures reported to the Agent", () => {
  it("names the fields that failed so the caller can correct itself", () => {
    const envelope = xeroMcpFailureEnvelope(schemaFailure({
      documents: [{ reference: "INV-1", lines: [{ account_code: "494" }] }],
    }));

    expect(envelope.error.code).toBe("VALIDATION_FAILED");
    expect(envelope.error.retryable).toBe(false);
    expect(envelope.error.reason_codes).toContain("REQUEST_SCHEMA_INVALID");
    expect(envelope.error.invalid_fields).toEqual(["documents[0].document_type"]);
  });

  it("keeps the array index so the caller knows which document is wrong", () => {
    const envelope = xeroMcpFailureEnvelope(schemaFailure({
      documents: [
        { document_type: "ACCPAY", reference: "INV-1", lines: [{ account_code: "494" }] },
        { document_type: "ACCPAY", reference: "INV-2", lines: [{}] },
      ],
    }));

    expect(envelope.error.invalid_fields).toEqual(["documents[1].lines[0].account_code"]);
  });

  it("never echoes the rejected values back to the caller", () => {
    const envelope = xeroMcpFailureEnvelope(schemaFailure({
      documents: [{ document_type: "SECRET-LEAK", reference: "INV-1", lines: [{ account_code: "494" }] }],
    }));

    expect(JSON.stringify(envelope)).not.toContain("SECRET-LEAK");
    expect(envelope.error.invalid_fields).toEqual(["documents[0].document_type"]);
  });
});

describe("coordinate reservation conflicts reported to the Agent", () => {
  it("names the holding Case and when its hold releases so the caller can wait or resume instead of guessing", () => {
    const envelope = xeroMcpFailureEnvelope(new AppError("CONFLICT", "reserved", {
      httpStatus: 409,
      details: {
        reasonCodes: ["ACCOUNTING_CASE_BUSINESS_COORDINATE_ALREADY_RESERVED"],
        holdingCaseId: "case-city-limousines-inv-2026-0818a-final",
        holdingCaseVersion: 3,
        holdReleasesAt: "2026-08-18T18:08:11.000Z",
      },
    }));

    expect(envelope.error.holding_case_id).toBe("case-city-limousines-inv-2026-0818a-final");
    expect(envelope.error.holding_case_version).toBe(3);
    expect(envelope.error.hold_releases_at).toBe("2026-08-18T18:08:11.000Z");
  });

  it("drops a holder id that is not a plain identifier", () => {
    const envelope = xeroMcpFailureEnvelope(new AppError("CONFLICT", "reserved", {
      details: { holdingCaseId: "<script>alert(1)</script>", holdReleasesAt: "not-a-time" },
    }));
    expect(envelope.error.holding_case_id).toBeUndefined();
    expect(envelope.error.hold_releases_at).toBeUndefined();
  });
});

describe("prepared-proposal mismatches reported to the Agent", () => {
  it("names the fields that disagreed instead of returning an opaque persistence failure", () => {
    // Observed live: a supplier bill for a new contact failed with only
    // ACCOUNTING_CASE_PREPARATION_PAYLOAD_MISMATCH. The server knew exactly which
    // fields disagreed and did not say, so the agent could not correct anything
    // and instead proposed booking the bill under a different supplier.
    const envelope = xeroMcpFailureEnvelope(new AppError("PERSISTENCE_FAILURE", "mismatch", {
      httpStatus: 503,
      details: {
        reasonCodes: ["ACCOUNTING_CASE_PREPARATION_PAYLOAD_MISMATCH"],
        mismatchFields: ["canonicalPayload.externalReference", "binding.targetSessionId"],
      },
    }));

    expect(envelope.error.mismatch_fields)
      .toEqual(["canonicalPayload.externalReference", "binding.targetSessionId"]);
  });

  it("drops anything in that list that is not a plain field path", () => {
    const envelope = xeroMcpFailureEnvelope(new AppError("PERSISTENCE_FAILURE", "mismatch", {
      details: { mismatchFields: ["ok.field", "<script>", "secret value with spaces"] },
    }));
    expect(envelope.error.mismatch_fields).toEqual(["ok.field"]);
  });
});
