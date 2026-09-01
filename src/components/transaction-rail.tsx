"use client";

/**
 * Every stage a write passes through, drawn as a strip of engraved rules.
 *
 * All six consensus stages are always present, so the rail shows how far along a write is
 * rather than only naming where it stopped. PENDING, PROPOSING, COMMITTING, REVEALING,
 * ACCEPTED and FINALIZED each get a bar whether or not this transaction has reached it.
 *
 * The three retryable stages are the reason this is not simply a status word. UNDETERMINED,
 * VALIDATORS_TIMEOUT and LEADER_TIMEOUT are consensus failing to conclude, not consensus
 * concluding against the caller. They get the hatched bar, the tag [TRANSIENT], and a
 * sentence saying so, because somebody looking at a rail that stopped needs to know whether
 * to press the button again or to stop pressing it.
 *
 * A refusal is the fourth case and it is kept separate from all of them. A payable method
 * that declines refunds the value and finalizes with GenVM SUCCESS, so the network succeeded
 * and the contract said no, and both are true on the same row.
 */

import Link from "next/link";
import type { StoredTransaction, TxStage } from "@/lib/contract-types";
import {
  CONSENSUS_STAGES,
  REFUSAL_TAG_TEXT,
  RETRYABLE_STAGES,
  STAGE_TEXT,
  taggedRefusal,
} from "@/lib/contract-types";
import { explorerTxUrl } from "@/lib/genlayer/config";
import { displayTime, shortenHex } from "@/lib/format";
import { useTransactions } from "./transaction-provider";

/** Where a stage sits on the six bar rail, or -1 for a stage that is not on it. */
function stagePosition(status: TxStage): number {
  switch (status) {
    case "UNINITIALIZED":
      return -1;
    case "READY_TO_FINALIZE":
    case "APPEAL_COMMITTING":
    case "APPEAL_REVEALING":
      // An appeal round is a re-run of commit and reveal after acceptance, so the rail shows
      // it as still standing at ACCEPTED rather than inventing a seventh bar.
      return CONSENSUS_STAGES.indexOf("ACCEPTED");
    default:
      return CONSENSUS_STAGES.indexOf(status as (typeof CONSENSUS_STAGES)[number]);
  }
}

const STAGE_NOTE: Partial<Record<TxStage, string>> = {
  READY_TO_FINALIZE: "Accepted and waiting to finalize.",
  APPEAL_COMMITTING: "An appeal round is committing. The write is still live.",
  APPEAL_REVEALING: "An appeal round is revealing. The write is still live.",
  CANCELED: "Canceled before consensus ran. Nothing was recorded.",
};

export function StageRail({
  status,
  executionResult,
  refusal,
}: {
  status: TxStage;
  executionResult?: StoredTransaction["executionResult"];
  refusal?: string;
}) {
  const retryable = RETRYABLE_STAGES.has(status);
  const reverted = executionResult === "ROLLBACK" || executionResult === "ERROR";
  const reached = stagePosition(status);

  // The tag the contract wrote, not one this component picked. A refusal from `open_deal` carries
  // its own class, and the three that are not `[EXPECTED]` are worth retrying: printing them all
  // as verdicts would tell somebody to stop when the right move was to press the button again.
  // The untagged branch below stays for a refusal recorded before the tag was being kept.
  const refused = refusal ? taggedRefusal(refusal) : null;

  return (
    <div>
      <ul className="flex list-none gap-1 p-0" aria-hidden="true">
        {CONSENSUS_STAGES.map((stage, index) => {
          const done = reached >= index;
          const now = reached === index && status !== "FINALIZED";
          const state = retryable
            ? "cv-stage-retry"
            : now
              ? "cv-stage-now"
              : done
                ? "cv-stage-done"
                : "";
          return (
            <li key={stage} className={`flex-1 ${state}`}>
              <div className={`cv-stage-bar ${now ? "cv-stage-active" : ""}`} />
            </li>
          );
        })}
      </ul>
      <ul className="mt-1 flex list-none gap-1 p-0">
        {CONSENSUS_STAGES.map((stage, index) => (
          <li
            key={stage}
            className={`cv-record-sm flex-1 ${
              reached >= index && !retryable ? "" : "cv-unchanged"
            }`}
          >
            {stage.toLowerCase()}
          </li>
        ))}
      </ul>

      <p className="cv-aside mt-2 max-w-[68ch]">
        {retryable ? (
          <>
            <span className="cv-tag mr-2">[TRANSIENT]</span>
            {STAGE_TEXT[status]}. Nothing was recorded and no escrow moved. Sending the same
            call again is the expected next step.
          </>
        ) : refused ? (
          <>
            <span
              className={`cv-tag mr-2 ${refused.tag === "EXPECTED" ? "cv-tag-verdict" : ""}`}
            >
              {REFUSAL_TAG_TEXT[refused.tag].tag}
            </span>
            Consensus finalized and the contract declined, returning the value that was sent.{" "}
            {refused.rest} {REFUSAL_TAG_TEXT[refused.tag].means}
          </>
        ) : refusal ? (
          <>
            <span className="cv-tag cv-tag-verdict mr-2">[EXPECTED]</span>
            Consensus finalized and the contract declined, returning the value that was sent.{" "}
            {refusal}
          </>
        ) : reverted ? (
          <>
            <span className="cv-tag cv-tag-verdict mr-2">[EXPECTED]</span>
            Consensus concluded and the call was refused. This is a verdict, so sending it
            again unchanged reaches the same one.
          </>
        ) : (
          (STAGE_NOTE[status] ?? STAGE_TEXT[status])
        )}
      </p>
    </div>
  );
}

export function TransactionRail({ onClose }: { onClose?: () => void }) {
  const { transactions, clear } = useTransactions();

  return (
    <section className="cv-panel p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
        <h2 className="cv-heading">Writes sent from this browser</h2>
        <div className="flex flex-wrap items-center gap-2">
          {transactions.length > 0 ? (
            <button type="button" className="cv-btn-quiet" onClick={clear}>
              Clear this list
            </button>
          ) : null}
          {onClose ? (
            <button type="button" className="cv-btn-quiet" onClick={onClose}>
              Close
            </button>
          ) : null}
        </div>
      </div>

      {transactions.length === 0 ? (
        <p className="cv-aside mt-3 max-w-[68ch]">
          Nothing has been sent from this browser yet. This list is a local note of what you
          sent, not the record of a deal. Every deal keeps its own record on chain and every
          page here reads that one.
        </p>
      ) : (
        <>
          <p className="cv-aside mt-3 max-w-[68ch]">
            A local note of what this browser sent. Clearing it removes nothing from the chain.
          </p>
          <ul className="mt-5 list-none p-0">
            {transactions.map((tx) => (
              <li key={tx.hash} className="cv-rule py-4 first:border-t-0 first:pt-0">
                <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
                  <span className="cv-body">{tx.label}</span>
                  <span className="cv-record-sm cv-unchanged">{displayTime(tx.createdAt)}</span>
                </div>
                <div className="mt-1 flex flex-wrap items-baseline gap-x-4 gap-y-1">
                  <a
                    className="cv-record underline decoration-1 underline-offset-4"
                    href={explorerTxUrl(tx.hash)}
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    {shortenHex(tx.hash, 10, 8)}
                  </a>
                  {tx.functionName ? (
                    <span className="cv-record-sm cv-unchanged">{tx.functionName}</span>
                  ) : null}
                  {tx.dealId ? (
                    <Link
                      href={`/deals/${tx.dealId}`}
                      className="cv-record-sm underline decoration-1 underline-offset-4"
                    >
                      deal {tx.dealId}
                    </Link>
                  ) : null}
                </div>
                <div className="mt-3">
                  <StageRail
                    status={tx.status}
                    executionResult={tx.executionResult}
                    refusal={tx.refusal}
                  />
                </div>
                {tx.executionError ? (
                  <p className="cv-record-sm mt-2 max-w-[76ch]">{tx.executionError}</p>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
