/**
 * The register: every deal the contract carries, split by whether it still holds money.
 *
 * The split is the point. A closed deal is a historical record and a live one is a claim on a sum
 * sitting in the contract right now, and mixing them into one list makes the second kind hard to
 * find. Escrow that is running is printed first, because that is the only part of this page
 * anybody can act on.
 *
 * There is no filter control and no search box. The register is short enough to read, and a filter
 * that hides a deal is a filter that can hide the deal whose window is about to expire.
 *
 * WHY THE ORDER IS THE CONTRACT'S, REVERSED, AND NOT A SORT BY DATE. `list_deals` returns seven
 * fields per row and the open date is not among them. This page could fetch fifty fields per deal
 * to sort by a field it then would not print, or it could reverse the append order the contract
 * already guarantees. It reverses, and says so under the heading. A page that sorted by an invented
 * key and called it recency would be asserting an order the register does not have.
 */

import type { Metadata } from "next";
import Link from "next/link";
import { DealRow, DealRowHead } from "@/components/deal-row";
import { ReadUnavailable } from "@/components/read-unavailable";
import { Stat } from "@/components/record";
import {
  CHECK_OUTCOME_TEXT,
  DEAL_STATE_TEXT,
  LIVE_STATES,
  type DealState,
  type DealSummary,
} from "@/lib/contract-types";
import { listDeals } from "@/lib/data-source";
import { formatCount, formatGen } from "@/lib/format";

/**
 * Read on every request, never prerendered.
 *
 * Without this the register is a server component with no dynamic input, so Next prerenders it at
 * build time and serves a 42 KB HTML file. It was doing exactly that, and it is the worst possible
 * page to freeze: the strip above it tells the reader every figure was read from the deployed
 * contract, and a deal that settled after the build would keep showing as OFFERED with its
 * consideration still listed as held. A register that is confidently wrong is worse than one that
 * is slow. The cost is one `list_deals` call per page load, which is a read and costs no GEN.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Register",
  description:
    "Every deal the Conveyance contract carries: what is still in escrow, what the last check stopped at, and what the closed entries settled at.",
};

function escrowedTotal(deals: DealSummary[]): bigint {
  return deals.reduce((sum, deal) => sum + BigInt(deal.escrow || "0"), 0n);
}

/** How many live deals have never been checked. Not a fault, and worth being able to see. */
function neverChecked(deals: DealSummary[]): number {
  return deals.filter((deal) => deal.last_check_outcome === "").length;
}

export default async function RegisterPage() {
  const deals = await listDeals();

  if (deals.kind !== "AVAILABLE") {
    return (
      <div className="space-y-8">
        <header>
          <p className="cv-legend">the register</p>
          <h1 className="cv-heading mt-2">Deals</h1>
        </header>
        <ReadUnavailable result={deals} subject="register of deals" />
      </div>
    );
  }

  const newestFirst = deals.value.slice().reverse();
  const live = newestFirst.filter((deal) => LIVE_STATES.includes(deal.state));
  const closed = newestFirst.filter((deal) => !LIVE_STATES.includes(deal.state));
  const reversed = live.filter((deal) => deal.state === "REVERSED");
  const unchecked = neverChecked(live);

  return (
    <div className="space-y-14">
      <header>
        <p className="cv-legend">the register</p>
        <h1 className="cv-heading mt-2">Deals</h1>
        <p className="cv-body mt-3 max-w-[72ch]">
          {formatCount(deals.value.length)} entries, newest first, which is the contract&rsquo;s own
          order reversed. Every figure below is the contract&rsquo;s record rather than a summary of
          it. A deal is shown under escrow while the contract is holding the consideration, whatever
          else is happening to it, because that is the fact that decides whether anybody still has
          something at stake.
        </p>

        <div className="cv-panel mt-6 grid gap-x-10 gap-y-6 p-6 plate:grid-cols-4">
          <Stat label="in escrow" value={formatCount(live.length)} />
          <Stat label="sum held" value={formatGen(escrowedTotal(live).toString())} />
          <Stat
            label="taken back by the registry"
            value={
              reversed.length === 0 ? (
                <span className="cv-unchanged">none</span>
              ) : (
                formatCount(reversed.length)
              )
            }
          />
          <Stat label="closed" value={formatCount(closed.length)} />
        </div>
        {unchecked > 0 ? (
          <p className="cv-aside mt-3 max-w-[72ch]">
            {formatCount(unchecked)} of the live entries have never been checked. That is not a
            fault: a check is a transaction somebody has to send, and anyone at all may send it,
            including someone who is neither party to the deal.
          </p>
        ) : null}
      </header>

      {/* ------------------------------------------------------------------ */}
      {/* Live escrow                                                        */}
      {/* ------------------------------------------------------------------ */}
      <section>
        <div className="flex flex-wrap items-baseline justify-between gap-x-8 gap-y-2">
          <h2 className="cv-heading">Money still in escrow</h2>
          <Link
            href="/deals/new"
            className="cv-legend cv-legend-ink underline decoration-1 underline-offset-4"
          >
            lodge an offer
          </Link>
        </div>
        <p className="cv-body mt-2 max-w-[72ch]">
          Each of these has a window running against it. When a window closes, the transition it
          guards becomes available to anyone at all rather than only to the party it favours, so an
          expired window is an invitation and not a problem. The window itself is on the
          deal&rsquo;s own page, because the register does not carry the deadlines.
        </p>

        {live.length === 0 ? (
          <p className="cv-body mt-4 max-w-[68ch]">
            The contract is holding nothing. Every deal it carries has been settled one way or the
            other.
          </p>
        ) : (
          <div className="cv-panel mt-5 p-2 plate:p-4">
            <DealRowHead />
            {live.map((deal) => (
              <DealRow key={deal.deal_id} deal={deal} />
            ))}
          </div>
        )}
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* Closed                                                             */}
      {/* ------------------------------------------------------------------ */}
      <section>
        <h2 className="cv-heading">Closed entries</h2>
        <p className="cv-body mt-2 max-w-[72ch]">
          Settled, and still readable. A closed deal keeps its baseline, its delivered snapshot and
          every field the last check wrote, so the reason the money went where it went can be
          checked long after it went there. Nothing here is deleted and nothing is compressed into a
          status word.
        </p>

        {closed.length === 0 ? (
          <p className="cv-body mt-4 max-w-[68ch]">
            Nothing has closed yet. The register carries no settled entries.
          </p>
        ) : (
          <div className="cv-panel mt-5 p-2 plate:p-4">
            <DealRowHead />
            {closed.map((deal) => (
              <DealRow key={deal.deal_id} deal={deal} />
            ))}
          </div>
        )}
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* The states, explained once                                         */}
      {/* ------------------------------------------------------------------ */}
      <section className="cv-panel-engraved p-6 plate:p-8">
        <h2 className="cv-heading">What each state means for the money</h2>
        <p className="cv-body mt-2 max-w-[72ch]">
          Six states, and the only question a reader actually has about any of them is where the
          consideration is. So that is what the second line says, in words, rather than a colour
          somebody has to learn.
        </p>
        <dl className="mt-6">
          {(Object.keys(DEAL_STATE_TEXT) as DealState[]).map((state) => {
            const text = DEAL_STATE_TEXT[state];
            return (
              <div
                key={state}
                className="cv-rule flex flex-wrap items-baseline gap-x-6 gap-y-1 py-3 first:border-t-0"
              >
                <dt className="cv-legend cv-legend-ink w-full shrink-0 plate:w-40">{text.label}</dt>
                <dd className="min-w-0 flex-1">
                  <p className="cv-body max-w-[62ch]">{text.register}</p>
                  <p className="cv-aside mt-0.5 max-w-[68ch]">{text.holds}</p>
                </dd>
              </div>
            );
          })}
        </dl>
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* What the check column can say                                      */}
      {/* ------------------------------------------------------------------ */}
      <section>
        <h2 className="cv-heading">What the last check column can say</h2>
        <p className="cv-body mt-2 max-w-[72ch]">
          The contract&rsquo;s classification is ordered and total: it returns the furthest condition
          that did not hold, so any outcome below implies every condition above it held at that
          check. That property is the whole reason a three-segment seal can be drawn from one
          recorded word without this interface re-deciding anything.
        </p>
        <dl className="cv-panel mt-5 p-6">
          {(
            [
              "",
              "SUSPENDED",
              "PENDING_TRANSFER",
              "AWAITING_TRANSFER",
              "AWAITING_DELEGATION",
              "AWAITING_DNS",
              "VERIFIED",
              "REVERSED",
            ] as const
          ).map((outcome) => {
            const text = CHECK_OUTCOME_TEXT[outcome];
            return (
              <div
                key={outcome || "unchecked"}
                className="cv-rule flex flex-wrap items-baseline gap-x-6 gap-y-1 py-3 first:border-t-0 first:pt-0"
              >
                <dt className="cv-legend cv-legend-ink w-full shrink-0 plate:w-48">{text.label}</dt>
                <dd className="cv-body min-w-0 max-w-[62ch] flex-1">{text.means}</dd>
              </div>
            );
          })}
        </dl>
      </section>
    </div>
  );
}
