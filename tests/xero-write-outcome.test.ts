import { describe, expect, it } from "vitest";
import { classifyXeroWriteException } from "../src/providers/xeroWriteOutcome.js";

describe("conservative Xero write-outcome classification", () => {
  it.each([
    ["missing status", {}],
    ["network timeout", { code: "ETIMEDOUT" }],
    ["redirect", { response: { status: 307, body: {} } }],
    ["request timeout", { response: { status: 408, body: {} } }],
    ["conflict", { response: { status: 409, body: {} } }],
    ["too early", { response: { status: 425, body: {} } }],
    ["rate limit", { response: { status: 429, body: {} } }],
    ["server error", { response: { status: 503, body: {} } }],
    ["empty 400", { response: { status: 400 } }],
    ["generic 422", { response: { status: 422, body: { message: "invalid" } } }],
  ])("keeps %s as UNKNOWN", (_name, error) => {
    expect(classifyXeroWriteException(error)).toBe("UNKNOWN");
  });

  it.each([
    {
      response: {
        status: 400,
        body: { ErrorNumber: 10, Type: "ValidationException", Message: "Validation failed" },
      },
    },
    {
      response: {
        status: 422,
        body: { Elements: [{ ValidationErrors: [{ Message: "Account code is invalid" }] }] },
      },
    },
  ])("accepts only structured Xero validation evidence as DEFINITELY_REJECTED", (error) => {
    expect(classifyXeroWriteException(error)).toBe("DEFINITELY_REJECTED");
  });
});
