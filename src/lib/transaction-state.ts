import type { StoredTransaction, TxStage } from "./contract-types.ts";
import { inspectGenVMExecution } from "./genlayer/execution.ts";

export const STALE_AFTER_MS = 2 * 60 * 60 * 1000;

export const ACTIVE_TRANSACTION_STAGES = new Set<TxStage>([
  "UNINITIALIZED",
  "PENDING",
  "PROPOSING",
  "COMMITTING",
  "REVEALING",
  "ACCEPTED",
  "READY_TO_FINALIZE",
  "APPEAL_COMMITTING",
  "APPEAL_REVEALING",
]);

export function shouldRefreshTransaction(tx: StoredTransaction, now = Date.now()) {
  if (!ACTIVE_TRANSACTION_STAGES.has(tx.status)) return false;
  const created = Date.parse(tx.createdAt);
  return Number.isNaN(created) || now - created < STALE_AFTER_MS;
}

export function normalizeStoredTransactions(items: StoredTransaction[], now = Date.now()) {
  return items.map((tx) =>
    shouldRefreshTransaction(tx, now) || !ACTIVE_TRANSACTION_STAGES.has(tx.status)
      ? tx
      : { ...tx, status: "UNDETERMINED" as TxStage },
  );
}

export function applyTransactionSnapshot(
  tx: StoredTransaction,
  snapshot: unknown,
): StoredTransaction {
  if (typeof snapshot !== "object" || snapshot === null) return tx;
  const statusName = (snapshot as { statusName?: unknown }).statusName;
  if (typeof statusName !== "string") return tx;
  const status = statusName.toUpperCase() as TxStage;
  if (status !== "FINALIZED") return { ...tx, status };
  return { ...tx, status, ...inspectGenVMExecution(snapshot) };
}
