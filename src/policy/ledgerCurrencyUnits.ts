/**
 * Currency minor-unit scales used by the deterministic fixed-decimal compiler.
 *
 * This is a *currency/provider mechanism*, not a jurisdiction policy: the
 * compiler must never infer a rounding scale from a JavaScript Number, so the
 * supported scales are enumerated explicitly and every unlisted currency fails
 * closed with `ACCOUNTING_MONETARY_CURRENCY_UNSUPPORTED`.
 *
 * Migrated out of the retired Singapore accounting policy so that removing a
 * jurisdiction rule set does not remove the arithmetic contract with it.
 */
export type LedgerCurrencyMinorUnitScale = 0 | 1 | 2 | 3 | 4;

/** ISO 4217 minor units for the currencies this ledger gateway can quantize. */
export const LEDGER_CURRENCY_MINOR_UNITS: Readonly<Record<string, LedgerCurrencyMinorUnitScale>> =
  Object.freeze({
    AED: 2,
    AUD: 2,
    BHD: 3,
    CAD: 2,
    CHF: 2,
    CNY: 2,
    EUR: 2,
    GBP: 2,
    HKD: 2,
    IDR: 2,
    INR: 2,
    JOD: 3,
    JPY: 0,
    KRW: 0,
    KWD: 3,
    MYR: 2,
    NZD: 2,
    OMR: 3,
    PHP: 2,
    SGD: 2,
    THB: 2,
    TND: 3,
    TWD: 2,
    USD: 2,
    VND: 0,
    ZAR: 2,
  });

export function ledgerCurrencyMinorUnitScale(
  currency: string,
): LedgerCurrencyMinorUnitScale | undefined {
  return LEDGER_CURRENCY_MINOR_UNITS[currency];
}
