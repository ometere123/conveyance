export type ExecutionOutcome = "SUCCESS" | "ROLLBACK" | "ERROR" | "UNKNOWN";

type TransactionLike = {
  consensus_data?: {
    leader_receipt?: Array<{ execution_result?: string; error?: string | null }>;
  };
};

export function inspectGenVMExecution(tx: TransactionLike | null | undefined): {
  executionResult: ExecutionOutcome;
  executionError?: string;
} {
  const leader = tx?.consensus_data?.leader_receipt?.[0];
  const raw = leader?.execution_result;
  const executionResult: ExecutionOutcome =
    raw === "SUCCESS" || raw === "ROLLBACK" || raw === "ERROR" ? raw : "UNKNOWN";
  return { executionResult, executionError: leader?.error ?? undefined };
}

export function assertSuccessfulGenVMExecution(tx: TransactionLike | null | undefined, hash: string) {
  const outcome = inspectGenVMExecution(tx);
  if (outcome.executionResult !== "SUCCESS") {
    throw new Error(
      `GenLayer contract execution failed (${outcome.executionResult}). Transaction: ${hash}`,
    );
  }
  return outcome;
}
