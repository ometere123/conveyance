/**
 * One deal, whole.
 *
 * The order is the order somebody actually reads in: what the register says this deal is, then
 * the one window that decides what becomes possible next, then the parties and the sum, then the
 * evidence, then the controls. Evidence before controls is deliberate. A page that puts the
 * button above the reason for pressing it is a page that expects to be obeyed rather than read.
 *
 * WHY THERE IS EXACTLY ONE COUNTDOWN. A deal carries up to three deadlines and only one of them
 * can be acted on from any given state. Printing all three buries the one that matters, and
 * printing none hides that a window is about to hand the money back to the other party. So
 * `pendingDeadline` picks the one whose expiry changes who may press what, and the other two are
 * printed as plain instants further down with no clock attached.
 *
 * WHY THE ACTIONS ARE A CLIENT ISLAND AND THE REST IS NOT. Every field here is a server read.
 * Only the controls need a wallet, a clock and a text field, so only the controls cross into the
 * browser, and they cross with plain strings. Nothing on this page is fetched from a browser.
 */

import type { Metadata } from "next";
import Link from "next/link";
import { ConveyanceSeal, SealLegend } from "@/components/conveyance-seal";
import { ControlProof } from "@/components/control-proof";
import { CopyLine } from "@/components/copy-line";
import { Deadline } from "@/components/deadline";
import { DealActions } from "@/components/deal-actions";
import { pendingDeadline } from "@/components/deal-row";
import { ReadUnavailable } from "@/components/read-unavailable";
import { Address, Digest, Instant, Row, Sum, ValueList } from "@/components/record";
import { RegistryDiff } from "@/components/registry-diff";
import {
  CHECK_OUTCOME_TEXT,
  DEAL_STATE_TEXT,
  REFUSAL_TAG_TEXT,
  type RefusalTag,
} from "@/lib/contract-types";
import { getDeal, getParameters, referenceNow } from "@/lib/data-source";
import { displayTime, formatCount, splitSet } from "@/lib/format";
import { sealSentence, sealState } from "@/lib/seal";
import { noteTag } from "@/lib/witness";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const deal = await getDeal(id);
  if (deal.kind !== "AVAILABLE") {
    return { title: `Deal ${id}`, description: "A deal in the Conveyance register." };
  }
  return {
    title: `${deal.value.domain} · ${deal.value.deal_id}`,
    description: `${DEAL_STATE_TEXT[deal.value.state].label}. ${DEAL_STATE_TEXT[deal.value.state].holds}`,
  };
}

export default async function DealPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [deal, parameters] = await Promise.all([getDeal(id), getParameters()]);

  if (deal.kind !== "AVAILABLE") {
    return (
      <div className="space-y-8">
        <p className="cv-legend">register entry</p>
        <h1 className="cv-heading">{id}</h1>
        <ReadUnavailable result={deal} subject={`deal ${id}`} />
        <Link
          href="/deals"
          className="cv-legend cv-legend-ink inline-block underline decoration-1 underline-offset-4"
        >
          back to the register
        </Link>
      </div>
    );
  }

  const record = deal.value;
  const state = DEAL_STATE_TEXT[record.state];
  const seal = sealState(record);
  const pending = pendingDeadline(record);
  const now = referenceNow();
  const check = CHECK_OUTCOME_TEXT[record.last_check_outcome];
  const tagged = record.last_check_note ? noteTag(record.last_check_note) : null;
  const interval =
    parameters.kind === "AVAILABLE" ? parameters.value.check_interval_seconds : "";

  return (
    <div className="space-y-14">
      {/* ------------------------------------------------------------------ */}
      {/* What the register says this is                                      */}
      {/* ------------------------------------------------------------------ */}
      <header>
        <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
          <p className="cv-legend">register entry</p>
          <span className="cv-record-sm">{record.deal_id}</span>
        </div>
        <h1 className="cv-asset mt-2 break-all">{record.domain}</h1>

        <div className="mt-8 grid gap-x-12 gap-y-10 plate:grid-cols-[1fr_auto]">
          <div>
            <p className="cv-legend cv-legend-ink">{state.label}</p>
            <p className="cv-body mt-2 max-w-[68ch]">{state.register}</p>
            <p className="cv-body mt-2 max-w-[68ch]">{state.holds}</p>

            {pending ? (
              <div className="cv-panel mt-6 p-5">
                <p className="cv-legend">{pending.label}</p>
                <p className="mt-1">
                  <Deadline iso={pending.iso} now={now} unlocks={pending.unlocks} />
                </p>
                <p className="cv-aside mt-2 max-w-[62ch]">
                  This is the only window that decides anything from here. When it closes the
                  transition it guards becomes available to anyone at all rather than only to the
                  party it favours, so a closed window is an invitation and not a fault.
                </p>
              </div>
            ) : (
              <p className="cv-aside mt-6 max-w-[68ch]">
                No window is running. This deal is closed and nothing further can be called
                against it.
              </p>
            )}
          </div>

          <div className="plate:w-[320px]">
            <div className="flex justify-center">
              <ConveyanceSeal state={seal} animate={false} />
            </div>
            <p className="cv-body mt-5 max-w-[40ch]">{sealSentence(seal)}</p>
            <div className="mt-5">
              <SealLegend state={seal} />
            </div>
          </div>
        </div>
      </header>

      {/* ------------------------------------------------------------------ */}
      {/* The last check, in the contract's own words                        */}
      {/* ------------------------------------------------------------------ */}
      <section className="cv-panel p-6">
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
          <h2 className="cv-heading">The last check</h2>
          <p className="cv-legend cv-legend-ink">{check.label}</p>
        </div>
        <p className="cv-body mt-2 max-w-[68ch]">{check.means}</p>
        {record.last_check_at ? (
          <p className="cv-aside mt-3 max-w-[68ch]">
            Read at {displayTime(record.last_check_at)}, after{" "}
            {formatCount(record.checks)}{" "}
            {record.checks === "1" ? "check in total" : "checks in total"}. Anyone at all may run
            another, including an address that is neither party.
          </p>
        ) : (
          <p className="cv-aside mt-3 max-w-[68ch]">
            No check has run against this deal. That is a statement about what nobody has done yet
            and not about what the registry says.
          </p>
        )}
        {tagged ? <CheckReason tagged={tagged} /> : null}
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* The evidence                                                       */}
      {/* ------------------------------------------------------------------ */}
      <section className="space-y-6">
        <h2 className="cv-heading">The evidence</h2>
        <p className="cv-body max-w-[72ch]">
          Two sources, read inside one consensus block so they describe the same instant. The
          registry answers whether the registration moved and where it sits. The zone answers
          whether the buyer controls the name. Neither answer implies the other, which is why they
          are two panels and not one verdict.
        </p>
        <RegistryDiff deal={record} />
        <ControlProof deal={record} />
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* The terms as lodged                                                */}
      {/* ------------------------------------------------------------------ */}
      <section className="cv-panel p-6">
        <h2 className="cv-heading">The terms, as lodged</h2>
        <p className="cv-body mt-2 max-w-[68ch]">
          Written when the offer was lodged and never rewritten. A deal whose terms could be
          amended after the seller armed would be a deal whose baseline meant nothing.
        </p>
        <dl className="mt-5">
          <Row
            label="deal"
            note="Chosen by whoever lodged the offer, not issued by the contract. Up to 64 characters of letters, digits, hyphen, underscore or dot, and a second offer under an id already in the register is refused."
          >
            {record.deal_id}
          </Row>
          <Row label="domain">{record.domain}</Row>
          <Row
            label="tld"
            note="Taken from the domain by the contract, not by this page, and used to resolve the registry."
          >
            {record.tld || <span className="cv-unchanged">not recorded</span>}
          </Row>
          <Row label="buyer" note="Whoever sent the call that lodged the offer.">
            <Address value={record.buyer} />
          </Row>
          <Row label="seller" note="Named by the buyer at open. Only this address may accept.">
            <Address value={record.seller} />
          </Row>
          <Row label="consideration held" note="In escrow from the moment the offer was lodged.">
            <Sum wei={record.escrow} />
          </Row>
          <Row
            label="registrar required"
            note="An IANA registrar id. The contract compares the number, because a display name can change without a transfer."
          >
            {record.target_registrar_id || <span className="cv-unchanged">not recorded</span>}
          </Row>
          <Row
            label="delegation required"
            note="Compared as a set: lowercased, root dot dropped, de-duplicated, sorted. Order is not a difference."
          >
            <ValueList
              values={splitSet(record.target_nameservers)}
              empty="none required at open"
            />
          </Row>
        </dl>
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* The two records                                                    */}
      {/* ------------------------------------------------------------------ */}
      <section className="cv-panel p-6">
        <h2 className="cv-heading">The two records this deal turns on</h2>
        <p className="cv-body mt-2 max-w-[68ch]">
          The seller&rsquo;s record is public from the start, because acceptance is the proof of
          control and there is nothing in it worth hiding. The buyer&rsquo;s carries a secret and
          the chain holds only the commitment to it until a check reveals it.
        </p>
        <div className="mt-5 space-y-5">
          <div>
            <CopyLine
              label="the seller publishes this, then presses Accept"
              value={
                record.seller_proof_name && record.seller_proof_token
                  ? `${record.seller_proof_name}. IN TXT "${record.seller_proof_token}"`
                  : "not recorded"
              }
              note="Bound to this deal id and this seller address, so a record published for one deal proves nothing about another. Nothing in it is secret."
            />
          </div>
          <dl>
            <Row label="buyer's record name">
              {record.buyer_proof_name || <span className="cv-unchanged">not recorded</span>}
            </Row>
            <Row
              label="buyer's commitment"
              note="sha256 of the token, made before the seller armed. The chain never learns the token from this."
            >
              <Digest value={record.buyer_proof_commitment} label="commitment" />
            </Row>
            <Row
              label="token revealed"
              note={
                record.buyer_proof_revealed === "True"
                  ? "A check has matched a token against the commitment, so the contract now holds it and `settle` needs no argument."
                  : "No check has matched a token yet, so no check can pass. The contract requires the token on every call."
              }
            >
              {record.buyer_proof_revealed === "True" ? "yes" : "not yet"}
            </Row>
          </dl>
        </div>
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* Every instant, and where the money went                            */}
      {/* ------------------------------------------------------------------ */}
      <section className="cv-panel p-6">
        <h2 className="cv-heading">Every instant on the record</h2>
        <p className="cv-body mt-2 max-w-[68ch]">
          Printed without clocks. The one window that can be acted on is at the top of this page
          with a distance beside it; these are the facts, in UTC, so two readers in two places read
          the same deadline.
        </p>
        <dl className="mt-5">
          <Row label="offer lodged">
            <Instant iso={record.opened_at} />
          </Row>
          <Row label="acceptance window closes">
            <Instant iso={record.accept_deadline} />
          </Row>
          <Row label="accepted and armed">
            <Instant iso={record.armed_at} />
          </Row>
          <Row label="transfer window closes">
            <Instant iso={record.transfer_deadline} />
          </Row>
          <Row label="delivery verified">
            <Instant iso={record.verified_at} />
          </Row>
          <Row label="inspection window closes">
            <Instant iso={record.inspection_deadline} />
          </Row>
          <Row label="closed">
            <Instant iso={record.closed_at} />
          </Row>
        </dl>

        <div className="cv-rule-strong mt-6 pt-5">
          <p className="cv-legend cv-legend-ink">Where the consideration went</p>
          <p className="cv-aside mt-1 max-w-[68ch]">
            Both fields are kept, and a deal that has closed has exactly one of them filled. A sum
            that was not paid is not a zero, so it says so in words.
          </p>
          <dl className="mt-3">
            <Row label="paid to the seller">
              {record.paid_to_seller && record.paid_to_seller !== "0" ? (
                <Sum wei={record.paid_to_seller} />
              ) : (
                <span className="cv-unchanged">nothing paid to the seller</span>
              )}
            </Row>
            <Row label="returned to the buyer">
              {record.returned_to_buyer && record.returned_to_buyer !== "0" ? (
                <Sum wei={record.returned_to_buyer} />
              ) : (
                <span className="cv-unchanged">nothing returned to the buyer</span>
              )}
            </Row>
          </dl>
        </div>
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* The controls                                                       */}
      {/* ------------------------------------------------------------------ */}
      <section>
        <h2 className="cv-heading">What can be called from here</h2>
        <p className="cv-body mt-2 max-w-[72ch]">
          Only the calls the contract has a door for out of{" "}
          <span className="cv-record-sm">{record.state}</span> are shown, and each one carries the
          contract&rsquo;s own reason for its rule. A control is disabled only when the reason is
          in this browser and stated beside it. Everything else stays pressable, because the
          contract&rsquo;s own refusal with its own tag teaches more than a greyed-out button.
        </p>
        <div className="mt-6">
          <DealActions deal={record} now={now} checkIntervalSeconds={interval} />
        </div>
      </section>

      <div>
        <Link
          href="/deals"
          className="cv-legend cv-legend-ink underline decoration-1 underline-offset-4"
        >
          back to the register
        </Link>
      </div>
    </div>
  );
}

/**
 * The contract's own note from the last check, with its tag glossed.
 *
 * `_classify_delivery` writes the note as `"<tag> <reason>"`, so the tag is recoverable without a
 * second field. A bare `[TRANSIENT]` is a code, and the entire point of the taxonomy is that it
 * is not one, so the gloss sits beside it.
 */
function CheckReason({ tagged }: { tagged: { tag: string; rest: string } }) {
  const tag = REFUSAL_TAG_TEXT[tagged.tag as RefusalTag];
  return (
    <div className="cv-rule mt-5 pt-4">
      <p className="cv-legend cv-legend-ink">
        {tag ? tag.tag : `[${tagged.tag}]`} the contract&rsquo;s own note
      </p>
      <p className="cv-record mt-1.5 max-w-[76ch] break-words">{tagged.rest}</p>
      {tag ? <p className="cv-aside mt-1.5 max-w-[68ch]">{tag.means}</p> : null}
    </div>
  );
}
