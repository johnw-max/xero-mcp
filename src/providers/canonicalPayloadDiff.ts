const MAX_MISMATCH_FIELDS = 32;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Structural equality for already-schema-validated canonical payloads.
 * Deliberately mirrors stableStringify's treatment of `undefined` (an object
 * key holding `undefined` reads the same as a key that is simply absent) so
 * this never disagrees with the hashObject comparison callers use to decide
 * "is there a mismatch at all" in the first place.
 */
function valuesEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => valuesEqual(item, right[index]));
  }
  if (isPlainObject(left) && isPlainObject(right)) {
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    for (const key of keys) {
      if (!valuesEqual(left[key], right[key])) return false;
    }
    return true;
  }
  return false;
}

function collectMismatches(expected: unknown, actual: unknown, path: string, out: Set<string>): void {
  if (valuesEqual(expected, actual)) return;

  if (Array.isArray(expected) && Array.isArray(actual)) {
    // A length change makes positional comparison meaningless past the point
    // of divergence - report the array itself once rather than a flood of
    // index paths that do not describe what actually happened.
    if (expected.length !== actual.length) {
      out.add(path || "root");
      return;
    }
    expected.forEach((item, index) => collectMismatches(item, actual[index], `${path}[${index}]`, out));
    return;
  }

  if (isPlainObject(expected) && isPlainObject(actual)) {
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    for (const key of keys) {
      collectMismatches(expected[key], actual[key], path ? `${path}.${key}` : key, out);
    }
    return;
  }

  // Either a primitive disagreement or a type disagreement (e.g. one side is
  // an array/object and the other is not) - both are reported at this path
  // without descending further, since there is nothing structurally shared
  // left to compare.
  out.add(path || "root");
}

/**
 * Names which fields disagree between two already-schema-validated canonical
 * payloads (or payload fragments), without ever disclosing what either side's
 * value was.
 *
 * Used only after a caller has already decided the two payloads disagree
 * (typically via a hashObject comparison) and needs to say *which* fields
 * caused that - never to decide agreement itself, since its own equality
 * pass is a means to that end, not its contract.
 *
 * Returns dot/bracket paths ("lines[0].accountCode", "total"), lexically
 * sorted, deduplicated, and capped at MAX_MISMATCH_FIELDS so a large or
 * adversarial payload cannot grow the output without bound. Arrays are
 * compared by index; when the two arrays differ in length the array's own
 * path is reported once instead of being expanded element by element.
 *
 * HARD CONSTRAINT: this function must never place a *value* from either
 * argument into its return value, directly or indirectly. Only object key
 * names already present on `expected`/`actual` and numeric array indices may
 * appear in the output. Xero object keys are fixed schema property names on
 * every canonical payload this repo produces (never provider- or
 * agent-supplied strings promoted into key position), so that constraint
 * holds by construction here - do not extend this function to walk any
 * structure where a key could itself be attacker- or provider-controlled
 * data without re-auditing this guarantee. The failure envelope this feeds
 * exists specifically so provider response bodies never reach the calling
 * agent; a differ that echoes values would defeat that by construction.
 */
export function canonicalPayloadMismatchFields(expected: unknown, actual: unknown): readonly string[] {
  const out = new Set<string>();
  collectMismatches(expected, actual, "", out);
  return [...out].sort().slice(0, MAX_MISMATCH_FIELDS);
}
