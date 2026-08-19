import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const fixtureDirectory = dirname(fileURLToPath(import.meta.url));

/**
 * Real responses captured from the Xero Accounting API, replayed with their real
 * runtime types.
 *
 * Test doubles in this repo have historically echoed back whatever the code sent
 * them. That models a provider that agrees with us, which is the one provider we
 * never need to defend against. Five production defects came from the gap: Xero
 * returns four empty phone blocks and two empty address blocks on every contact
 * whatever you send, drops the pagination envelope on some queries, and hands
 * back `Date` objects where the rest of a payload carries calendar strings.
 *
 * JSON cannot carry the last of those - `JSON.stringify` turns a Date into a
 * string, so a plain fixture silently loses the exact distinction that caused the
 * defect. `runtime-types.json` records what each leaf actually was at capture
 * time, and this loader puts the Date objects back before a test sees the body.
 */
const runtimeTypes = JSON.parse(
  readFileSync(join(fixtureDirectory, "runtime-types.json"), "utf8"),
) as Record<string, Record<string, string>>;

export type XeroCapturedResponse =
  | "accounts"
  | "contact_single"
  /**
   * An empty result WITHOUT a page parameter. Xero leaves `pagination`
   * undefined here. Production never calls this way - it always pages - so a
   * mapper conclusion drawn from this shape does not transfer. Kept because the
   * shape is real and code that reads `pagination?.pageCount` can meet it.
   */
  | "contacts_empty_filter"
  /**
   * The same empty result WITH `page=1`, which is how production asks. Xero
   * answers with the full envelope and `pageCount: 0, itemCount: 0` - the exact
   * "exhausted, and there is nothing" signal the contact scan depends on to let
   * a new supplier be created at all.
   */
  | "contacts_empty_filter_paged"
  | "credit_notes"
  | "invoice_accpay"
  | "items"
  | "organisation"
  | "tax_rates";

function reviveDatesAtPath(node: unknown, segments: readonly string[]): void {
  if (segments.length === 0 || node === null || typeof node !== "object") return;
  const [head, ...rest] = segments;
  if (head === undefined) return;
  if (head.endsWith("[]")) {
    const key = head.slice(0, -2);
    const array = (node as Record<string, unknown>)[key];
    if (!Array.isArray(array)) return;
    for (const entry of array) reviveDatesAtPath(entry, rest);
    return;
  }
  const container = node as Record<string, unknown>;
  if (rest.length === 0) {
    const value = container[head];
    if (typeof value === "string") container[head] = new Date(value);
    return;
  }
  reviveDatesAtPath(container[head], rest);
}

/**
 * The captured body for `name`, with every field the live API returned as a Date
 * object restored to a Date. Each call returns a fresh copy, so a test may mutate
 * what it gets without leaking into the next one.
 */
export function loadXeroResponse(name: XeroCapturedResponse): Record<string, unknown> {
  const body = JSON.parse(
    readFileSync(join(fixtureDirectory, `${name}.json`), "utf8"),
  ) as Record<string, unknown>;
  for (const [path, type] of Object.entries(runtimeTypes[name] ?? {})) {
    if (type !== "Date") continue;
    reviveDatesAtPath(body, path.split("."));
  }
  return body;
}

/** Every field the live API returned as a Date, by captured response name. */
export function capturedDateFields(name: XeroCapturedResponse): readonly string[] {
  return Object.entries(runtimeTypes[name] ?? {})
    .filter(([, type]) => type === "Date")
    .map(([path]) => path)
    .sort();
}

/**
 * Paths the live API returned as an empty array. A hand-built double usually
 * omits these keys entirely, so code that distinguishes "absent" from "present
 * but empty" is never exercised against the shape the provider actually sends.
 */
export function capturedEmptyArrayFields(name: XeroCapturedResponse): readonly string[] {
  return Object.entries(runtimeTypes[name] ?? {})
    .filter(([, type]) => type === "array(empty)")
    .map(([path]) => path)
    .sort();
}
