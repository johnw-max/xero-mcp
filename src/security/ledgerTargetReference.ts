import { sha256 } from "./hash.js";

/** Stable, non-secret correlation reference for one internal ledger target. */
export function safeLedgerTargetReference(sessionId: string): string {
  return `xero-target-session:${sha256(sessionId).slice(0, 32)}`;
}
