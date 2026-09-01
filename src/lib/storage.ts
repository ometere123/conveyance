/**
 * The one place this app writes to the browser.
 *
 * Namespaced and versioned, so a shape change is a new key rather than a parse of somebody
 * else's leftovers. Capped, because an unbounded list in localStorage is a slow leak that
 * only shows up on the machine of whoever used the thing most.
 */

import type { StoredTransaction } from "@/lib/contract-types";
import { normalizeStoredTransactions } from "@/lib/transaction-state";

export const TRANSACTIONS_KEY = "conveyance.transactions.v1";
const CAP = 24;

export function loadTransactions(): StoredTransaction[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(TRANSACTIONS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const rows = parsed.filter(isStoredTransaction);
    return normalizeStoredTransactions(rows).slice(0, CAP);
  } catch {
    return [];
  }
}

/** Anything that is not recognisably one of ours is dropped rather than coerced. */
function isStoredTransaction(value: unknown): value is StoredTransaction {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.hash === "string" &&
    typeof row.label === "string" &&
    typeof row.createdAt === "string" &&
    typeof row.status === "string"
  );
}

export function saveTransactions(transactions: StoredTransaction[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(TRANSACTIONS_KEY, JSON.stringify(transactions.slice(0, CAP)));
  } catch {
    // A full or blocked store must not take the page down with it. The rail is a
    // convenience; the chain is the record.
  }
}

export function clearTransactions(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(TRANSACTIONS_KEY);
  } catch {
    // See above.
  }
}
