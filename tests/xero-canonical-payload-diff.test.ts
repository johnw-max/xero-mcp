import { describe, expect, it } from "vitest";
import { canonicalPayloadMismatchFields } from "../src/providers/canonicalPayloadDiff.js";

describe("canonicalPayloadMismatchFields", () => {
  it("names a single changed top-level field and nothing else", () => {
    // proves: a lone header-field change is reported as exactly that field,
    // not as an opaque "the payload disagreed somewhere".
    const expected = { total: "100.0000", reference: "RETURN-001", currency: "SGD" };
    const actual = { total: "100.0000", reference: "RETURN-002", currency: "SGD" };
    expect(canonicalPayloadMismatchFields(expected, actual)).toEqual(["reference"]);
  });

  it("addresses a changed field inside an array element by index, matching the plan's own example shape", () => {
    // proves: "lines[0].accountCode" - the exact path shape the implementation
    // plan specifies - is what a single line-level field change produces.
    const expected = { lines: [{ accountCode: "200", description: "Advisory" }] };
    const actual = { lines: [{ accountCode: "201", description: "Advisory" }] };
    expect(canonicalPayloadMismatchFields(expected, actual)).toEqual(["lines[0].accountCode"]);
  });

  it("reports the array's own path once instead of expanding elements when lengths differ", () => {
    const expected = { lines: [{ accountCode: "200" }, { accountCode: "400" }] };
    const actual = { lines: [{ accountCode: "200" }] };
    expect(canonicalPayloadMismatchFields(expected, actual)).toEqual(["lines"]);
  });

  it("reports both sides of a two-field mismatch, sorted and deduplicated", () => {
    const expected = { a: 1, b: 2, c: 3 };
    const actual = { a: 1, b: 20, c: 30 };
    expect(canonicalPayloadMismatchFields(expected, actual)).toEqual(["b", "c"]);
  });

  it("treats a key present only on one side the same as a changed field, not a crash", () => {
    const expected = { reference: "REF-1" };
    const actual = { reference: "REF-1", extraField: "unexpected" };
    expect(canonicalPayloadMismatchFields(expected, actual)).toEqual(["extraField"]);
  });

  it("returns no paths for structurally identical payloads regardless of key order", () => {
    const expected = { a: 1, lines: [{ x: 1, y: 2 }] };
    const actual = { lines: [{ y: 2, x: 1 }], a: 1 };
    expect(canonicalPayloadMismatchFields(expected, actual)).toEqual([]);
  });

  it("caps the result at 32 field paths and keeps them lexically sorted", () => {
    const expected: Record<string, number> = {};
    const actual: Record<string, number> = {};
    for (let index = 0; index < 40; index += 1) {
      const key = `field${String(index).padStart(2, "0")}`;
      expected[key] = index;
      actual[key] = index + 1_000; // every field disagrees
    }
    const diff = canonicalPayloadMismatchFields(expected, actual);
    expect(diff).toHaveLength(32);
    expect(diff).toEqual([...diff].sort());
    expect(diff[0]).toBe("field00");
  });

  it("never places either side's value into the returned field paths", () => {
    // proves: the hard constraint this module exists to uphold - mirrors the
    // "not.toContain(SECRET-LEAK)" style used in xeroFailureEnvelope.test.ts
    // for the same class of guarantee at the envelope layer. A provider body
    // could put anything in a string field; only the field's own name may
    // ever appear in the diff.
    const expected = { reference: "SAFE-REFERENCE", contactId: "11111111-1111-4111-8111-111111111111" };
    const actual = { reference: "SECRET-LEAK-FROM-PROVIDER-BODY", contactId: "11111111-1111-4111-8111-111111111111" };
    const diff = canonicalPayloadMismatchFields(expected, actual);
    expect(diff).toEqual(["reference"]);
    expect(JSON.stringify(diff)).not.toContain("SECRET-LEAK");
    expect(JSON.stringify(diff)).not.toContain("SAFE-REFERENCE");
  });

  it("never places a leaked value into the output even when the value looks like a plausible field name", () => {
    // proves: the guarantee holds even under an adversarial value chosen to
    // look like it belongs in a field-path list - the differ only ever emits
    // the *actual* object keys/indices it walked, never string content.
    const expected = { narration: "Month-end accrual" };
    const actual = { narration: "lines[0].accountCode" };
    const diff = canonicalPayloadMismatchFields(expected, actual);
    expect(diff).toEqual(["narration"]);
  });
});
