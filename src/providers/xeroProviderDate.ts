/**
 * Shared Xero provider date/time parsing.
 *
 * The xero-node SDK silently promotes a field it declares as `type: "string"`
 * into a native `Date` object whenever the wire value uses Xero's legacy
 * `/Date(ms+tz)/` format, and leaves the field as a plain string otherwise.
 * Every place in this codebase that reads a Xero date-shaped field has to
 * handle all three shapes - `Date`, that legacy string, and an ordinary
 * string - and that handling used to be reimplemented independently at each
 * call site. Two of those reimplementations (the date usages of
 * `providerText` in xeroCreditNoteManualJournalDraft.ts and
 * `providerTrimmedString` in xeroQuotePurchaseOrderDraft.ts) never learned
 * the `Date` branch at all, so a real `Date` there was rejected outright
 * (`typeof value !== "string"`), turning every live CreditNote / Quote /
 * PurchaseOrder / ManualJournal draft-write readback into
 * MALFORMED_PROVIDER_READBACK.
 *
 * This module is now the one place the Date / legacy-string kernel lives.
 * Callers still own their own plain-string validation (length, charset,
 * exact format, or none at all) - the functions here only turn a
 * Date-shaped value into the string form a caller already knows how to
 * validate; they never loosen or tighten what a caller does with a value
 * that was already a plain string.
 */

/**
 * Resolves any Xero provider value that represents an instant - a native
 * `Date`, or the legacy `/Date(ms+tz)/` wire string - to a `Date`.
 *
 * Returns undefined for an invalid `Date`, a string that is not in the
 * legacy format, or any other input (including `undefined`, `null`, a
 * number, or a plain calendar-date string), so callers can layer their own
 * handling for those cases on top without this function pre-empting it.
 */
export function xeroProviderInstant(value: unknown): Date | undefined {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value;
  if (typeof value !== "string") return undefined;
  const match = /^\/Date\((-?\d+)/.exec(value);
  if (!match?.[1]) return undefined;
  const parsed = new Date(Number(match[1]));
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

/**
 * Pre-normalizes a Xero provider date-ONLY field (CreditNote.date,
 * ManualJournal.date, Quote.date / expiryDate, PurchaseOrder.date /
 * expectedArrivalDate / deliveryDate) ahead of a generic string validator.
 *
 * A `Date` instance or a legacy `/Date(ms+tz)/` string is rewritten to its
 * 10-character YYYY-MM-DD prefix. Every other value - a plain string,
 * `undefined`, a number, anything else - passes through completely
 * unchanged, so an existing length/charset check downstream keeps exactly
 * its current behaviour for every case it already handled. This function
 * only fixes type handling; it adds no new format constraint of its own.
 */
export function xeroProviderDateOnly(value: unknown): unknown {
  const instant = xeroProviderInstant(value);
  return instant ? instant.toISOString().slice(0, 10) : value;
}

/**
 * The full date parser historically duplicated (byte-for-byte) as `xeroDate`
 * in both xeroProvider.ts and xeroExtendedReadMapper.ts. A `Date` instance
 * or a legacy `/Date(/` string is truncated to its 10-character calendar
 * date; a plain string is accepted only when it already starts with a
 * YYYY-MM-DD prefix (and is truncated to that prefix); anything else is
 * undefined.
 */
export function xeroProviderDate(value: unknown): string | undefined {
  const instant = xeroProviderInstant(value);
  if (instant) return instant.toISOString().slice(0, 10);
  if (typeof value !== "string") return undefined;
  return /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : undefined;
}
