/**
 * One line of the register.
 *
 * The same row prints on the plate and in the register itself, because a reader who learned to
 * read it in one place should not have to learn it again in the other.
 *
 * IT TAKES A SUMMARY, NOT A DEAL, AND THAT DECIDES THE COLUMNS. `list_deals` returns seven
 * fields per row: the identifier, the state, the domain, the escrow, the target registrar, and
 * the last check's outcome and time. It does not return the deadlines. So a row cannot print a
 * countdown without fetching fifty fields per line to draw one, and a register that did that
 * would be lying about what one view call costs.
 *
 * Six columns, and the sixth is the last check rather than a deadline: the mark-size seal, the
 * identifier, the name, what the register says the deal is, the sum, and when a check last ran
 * and what it stopped at. `pendingDeadline` stays here because the deal page prints exactly one
 * countdown and this is where the rule for choosing it belongs, but the row itself does not call
 * it.
 *
 * The seal at mark size draws from the summary through `Sealable`, which is why that type exists.
 * The summary does not carry the recorded proof outcome, so `sealState` places the third arc from
 * where the check stopped and sets `proofFromRecord` false. The accessible name says so out loud.
 * A drawing that is read from one field here and another field on the deal page has to admit
 * which it did, or the two become one claim of unknown provenance.
 */

import Link from "next/link";
import { ConveyanceSeal } from "@/components/conveyance-seal";
import {
  CHECK_OUTCOME_TEXT,
  DEAL_STATE_TEXT,
  type Deal,
  type DealSummary,
} from "@/lib/contract-types";
import { displayTime, formatGen } from "@/lib/format";
import { sealState } from "@/lib/seal";

/**
 * The deadline that decides what becomes possible next, or null for a closed deal.
 *
 * A deal in escrow has up to five deadlines recorded against it and only one of them can be
 * acted on at a time, so printing all five buries the one that matters and printing none hides
 * that a window is about to hand the money back. This returns exactly the one whose expiry
 * changes who may press what.
 */
export function pendingDeadline(deal: Deal): { label: string; iso: string; unlocks: string } | null {
  if (deal.state === "OFFERED") {
    return {
      label: "acceptance window",
      iso: deal.accept_deadline,
      unlocks: "anyone may now return the consideration to the buyer",
    };
  }
  if (deal.state === "LOCKED") {
    return {
      label: "transfer window",
      iso: deal.transfer_deadline,
      unlocks: "anyone may now refund the buyer, the transfer having not been observed",
    };
  }
  if (deal.state === "VERIFIED") {
    return {
      label: "inspection window",
      iso: deal.inspection_deadline,
      unlocks: "anyone may now pay the seller",
    };
  }
  return null;
}

export function DealRow({ deal }: { deal: DealSummary }) {
  const state = DEAL_STATE_TEXT[deal.state];
  const seal = sealState(deal);
  const check = CHECK_OUTCOME_TEXT[deal.last_check_outcome];

  return (
    <Link
      href={`/deals/${deal.deal_id}`}
      className="cv-rule flex flex-wrap items-baseline gap-x-6 gap-y-1 px-2 py-3 no-underline first:border-t-0 plate:px-4"
    >
      {/* Baseline-shifted rather than centred: the ring should sit on the line of type, not
          float beside it, because the row is a line in a register and not a card. */}
      <span className="w-[22px] shrink-0 translate-y-1">
        <ConveyanceSeal state={seal} size="mark" animate={false} />
      </span>
      <span className="cv-record-sm w-20 shrink-0">{deal.deal_id}</span>
      <span className="cv-record min-w-0 flex-1 break-all underline decoration-[var(--rule-strong)] underline-offset-2">
        {deal.domain}
      </span>
      <span className="cv-legend cv-legend-ink w-full plate:w-44 plate:shrink-0">
        {state.label}
      </span>
      <span className="cv-record w-full plate:w-36 plate:shrink-0 plate:text-right">
        {formatGen(deal.escrow)}
      </span>
      <span className="w-full plate:w-64 plate:shrink-0">
        {deal.last_check_at ? (
          <span className="cv-aside">
            <span className="cv-legend mr-2">{check.label}</span>
            {displayTime(deal.last_check_at)}
          </span>
        ) : (
          <span className="cv-aside">{state.register}</span>
        )}
      </span>
    </Link>
  );
}

/** The column heads, printed once above a run of rows. Hidden below the plate breakpoint. */
export function DealRowHead() {
  return (
    <div className="hidden flex-wrap items-baseline gap-x-6 px-2 pb-2 plate:flex plate:px-4">
      <span className="w-[22px] shrink-0" aria-hidden />
      <span className="cv-legend w-20 shrink-0">deal</span>
      <span className="cv-legend min-w-0 flex-1">domain</span>
      <span className="cv-legend w-44 shrink-0">register says</span>
      <span className="cv-legend w-36 shrink-0 text-right">consideration</span>
      <span className="cv-legend w-64 shrink-0">last check</span>
    </div>
  );
}
