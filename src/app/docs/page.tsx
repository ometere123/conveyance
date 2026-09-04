/**
 * The instrument: the whole contract, in the order somebody would need to argue with it.
 *
 * The plate says what this decides and what it refuses to decide. The register says what it has
 * decided so far. This page is the third thing, and it exists because an escrow is a promise and a
 * promise nobody can read is not one. So the order here is the order of an objection: what the
 * money is held against, what each call actually fetches, who may press what and from when, what
 * the four refusal tags separate, and then the constants the contract reports about itself.
 *
 * WHY EVERY TABLE IS BUILT FROM THE SAME OBJECTS THE CONTROLS ARE. `METHODS`, `PROGRAMS`,
 * `CALLER_TEXT` and `DEADLINE_TEXT` drive the buttons on a deal page. Restating them in prose here
 * would create a second description that could drift from the first, and a documentation page that
 * disagrees with the interface is worse than no documentation page. Where this file states
 * something the data does not carry, it states it as a paragraph and not as a row.
 *
 * WHY THE PARAMETERS PANEL CAN BE HALF EMPTY. Three of the figures are limits the contract
 * enforces on a signed transaction, and fixture mode cannot answer for them. The panel says which
 * ones were unreadable and why, rather than printing a number this repository remembers.
 */

import type { Metadata } from "next";
import Link from "next/link";
import { ReadUnavailableRow } from "@/components/read-unavailable";
import { Row } from "@/components/record";
import {
  CONDITION_KEYS,
  CONDITION_TEXT,
  DEAL_STATE_TEXT,
  DEAL_STATES,
  REFUSAL_TAG_TEXT,
  type RefusalTag,
} from "@/lib/contract-types";
import { getParameters } from "@/lib/data-source";
import { formatGen, formatWindow, splitSet } from "@/lib/format";
import {
  CALLER_TEXT,
  DEADLINE_TEXT,
  METHODS,
  METHODS_BY_STATE,
  PROGRAMS,
  type Door,
} from "@/lib/lifecycle";

/**
 * Read on every request, never prerendered.
 *
 * The parameters panel near the foot of this page is the deployed contract reporting on itself, and
 * the no-model claim two sections above it is checkable only because that panel is the contract's
 * answer rather than this page's. Prerendered, it would be the answer a previous deployment gave,
 * which turns the one verifiable row on the page into a remembered one. It was being prerendered
 * into a 102 KB file. One read per page load.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "The instrument",
  description:
    "What the Conveyance contract holds money against, what every call fetches, who may press what and from when, and the constants it reports about itself.",
};

/** The order the methods are read in: the path a completed sale takes, then the exits. */
const METHOD_ORDER = ["open_deal", "arm", "check_transfer", "settle", "refund", "abandon", "probe_domain"];

export default async function DocsPage() {
  const parameters = await getParameters();

  return (
    <div className="space-y-16">
      <header>
        <p className="cv-legend">the instrument</p>
        <h1 className="cv-heading mt-2">What this contract is bound to do</h1>
        <p className="cv-body mt-3 max-w-[72ch]">
          Everything below is enforced in the contract rather than in this interface. Where the two
          could disagree the contract is right, and the interface is written so that a disagreement
          shows up as a refusal with the contract&rsquo;s own words rather than as a page that keeps
          its own story straight.
        </p>
      </header>

      {/* ------------------------------------------------------------------ */}
      {/* What the money is held against                                     */}
      {/* ------------------------------------------------------------------ */}
      <section>
        <h2 className="cv-heading">What the money is held against</h2>
        <p className="cv-body mt-2 max-w-[72ch]">
          A domain sale has two halves that are usually confused with each other. The registration
          has to move, and the buyer has to be able to operate the name. A registrar can report the
          first without the second being true, and a nameserver change can produce the second
          without the first having happened. This contract holds the consideration against both, at
          the same check, and reports which one is missing when only one is.
        </p>
        <dl className="cv-panel mt-6 p-6">
          {CONDITION_KEYS.map((key) => {
            const text = CONDITION_TEXT[key];
            return (
              <div
                key={key}
                className="cv-rule flex flex-wrap items-baseline gap-x-6 gap-y-1 py-3 first:border-t-0 first:pt-0"
              >
                <dt className="cv-legend cv-legend-ink w-full shrink-0 plate:w-40">{text.label}</dt>
                <dd className="min-w-0 flex-1">
                  <p className="cv-body max-w-[62ch]">{text.asks}</p>
                  <p className="cv-aside mt-0.5 max-w-[68ch]">{text.source}</p>
                </dd>
              </div>
            );
          })}
        </dl>
        <p className="cv-aside mt-3 max-w-[72ch]">
          The contract asks six ordered questions and returns the furthest one that did not hold, so
          any recorded outcome implies every condition above it held at that check. That ordering is
          what makes the seal on a deal page a reading of one recorded word rather than a second
          judgement made here.
        </p>
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* No model                                                           */}
      {/* ------------------------------------------------------------------ */}
      <section className="cv-panel-engraved p-6 plate:p-8">
        <h2 className="cv-heading">There is no model in this contract</h2>
        <p className="cv-body mt-2 max-w-[72ch]">
          GenLayer contracts may call a language model inside consensus. This one does not, anywhere,
          and{" "}
          <span className="cv-record-sm">parameters()</span> reports{" "}
          <span className="cv-record-sm">uses_a_model</span> as{" "}
          <span className="cv-record-sm">
            {parameters.kind === "AVAILABLE" ? parameters.value.uses_a_model : "false"}
          </span>{" "}
          so the claim is checkable rather than promised in prose.
        </p>
        <p className="cv-body mt-3 max-w-[72ch]">
          Every question this contract asks has an exact answer in a machine-readable document. A
          sponsoring registrar is a number in an RDAP object. A transfer is a dated event in the
          same object. A control proof is a TXT record whose bytes either hash to the stored
          commitment or do not. Asking a model to read any of those would introduce disagreement
          into the one place the whole design is trying to remove it from, and it would put a
          judgement between the evidence and the money.
        </p>
        <p className="cv-body mt-3 max-w-[72ch]">
          So every consensus block here runs under strict equality: validators compare the bytes
          they fetched, and a block where they differ produces no verdict rather than a majority
          one. The cost is that a flaky registry produces a check that decides nothing. That is the
          intended cost. A check that decides nothing is recorded as having decided nothing, and
          anyone may run another.
        </p>
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* Two resolvers                                                      */}
      {/* ------------------------------------------------------------------ */}
      <section>
        <h2 className="cv-heading">Why a proof is read twice</h2>
        <p className="cv-body mt-2 max-w-[72ch]">
          Every TXT lookup goes to two independent resolvers
          {parameters.kind === "AVAILABLE" && parameters.value.resolvers
            ? `, ${splitSet(parameters.value.resolvers).join(" and ")},`
            : ""}{" "}
          and both have to return the same answer. One resolver serving a stale or poisoned record
          would otherwise be enough to move an escrow, and a resolver is exactly the kind of
          infrastructure a motivated party can influence for one name for a short time.
        </p>
        <p className="cv-body mt-3 max-w-[72ch]">
          Two resolvers that disagree is not a failure to find the record. It is recorded as{" "}
          <span className="cv-record-sm">[EXTERNAL]</span>, meaning nothing was learned in either
          direction, and the deal stays exactly where it was. The proof names themselves are derived
          by the contract from the deal, not chosen by either party:
        </p>
        <dl className="cv-panel mt-5 p-6">
          <Row
            label="the seller's record"
            note="Public from the start. Acceptance is the proof of control, and there is nothing in the token worth hiding, so it is written into the deal at open for anyone to read."
          >
            <span className="cv-record-sm break-all">
              {parameters.kind === "AVAILABLE" && parameters.value.seller_proof_label
                ? `${parameters.value.seller_proof_label}.<domain>`
                : "the seller's derived proof name"}
            </span>
          </Row>
          <Row
            label="the buyer's record"
            note="The chain holds only the sha256 of this token until a check matches one against it. Publishing the buyer's record before the transfer completes proves nothing early, and the commitment is what stops the seller publishing it at all."
          >
            <span className="cv-record-sm break-all">
              {parameters.kind === "AVAILABLE" && parameters.value.buyer_proof_label
                ? `${parameters.value.buyer_proof_label}.<domain>`
                : "the buyer's derived proof name"}
            </span>
          </Row>
          <Row
            label="the token format"
            note="Bound to the deal id and to the party's address, so a record published for one deal proves nothing about another and a record published by one address proves nothing about a second."
          >
            <span className="cv-record-sm break-all">
              {parameters.kind === "AVAILABLE" && parameters.value.proof_version
                ? `${parameters.value.proof_version};deal=<id>;<party>=<address>`
                : "version, deal id, party, address"}
            </span>
          </Row>
        </dl>
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* The seven writes                                                   */}
      {/* ------------------------------------------------------------------ */}
      <section>
        <h2 className="cv-heading">The seven calls, and who may make them</h2>
        <p className="cv-body mt-2 max-w-[72ch]">
          A method is a set of doors rather than one rule. Three of them move escrow and are marked.
          Every door carries the reason the rule is that rule, because the asymmetries are the
          design: the buyer may walk away before the seller accepts and not after, the seller may
          never trigger a refund and never needs to, and settlement widens to anyone once the
          inspection window closes.
        </p>

        <div className="mt-6 space-y-5">
          {METHOD_ORDER.map((name) => {
            const method = METHODS[name];
            if (!method) return null;
            const program = PROGRAMS[name];
            return (
              <article key={name} className="cv-panel p-6">
                <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
                  <h3 className="cv-heading">{method.action}</h3>
                  <span className="cv-record-sm">{method.name}</span>
                </div>
                <p className="cv-body mt-2 max-w-[68ch]">{method.effect}</p>
                <p className="cv-legend mt-2">
                  {method.movesValue ? "moves escrow" : "moves no value"}
                  {method.payable ? " · payable" : ""}
                </p>

                <div className="cv-rule mt-5 pt-4">
                  <p className="cv-legend cv-legend-ink">the doors</p>
                  <dl className="mt-2">
                    {method.doors.map((door, index) => (
                      <Row key={index} label={doorLabel(door)} note={door.because}>
                        {CALLER_TEXT[door.caller].label}
                      </Row>
                    ))}
                  </dl>
                </div>

                {program ? (
                  <div className="cv-rule mt-5 pt-4">
                    <p className="cv-legend cv-legend-ink">what it fetches, in order</p>
                    <ol className="mt-2 list-none p-0">
                      {program.map((step) => (
                        <li
                          key={step.label}
                          className="cv-rule flex flex-wrap items-baseline gap-x-6 gap-y-0.5 py-2 first:border-t-0"
                        >
                          <span className="cv-body w-full shrink-0 plate:w-[24rem]">{step.label}</span>
                          <span className="cv-aside min-w-0 flex-1">
                            {step.source}
                            {step.resolvers ? ` · ${step.resolvers.join(" and ")}, both required` : ""}
                          </span>
                        </li>
                      ))}
                    </ol>
                  </div>
                ) : (
                  <p className="cv-aside mt-5 max-w-[68ch]">
                    Fetches nothing. It reads the state and a deadline the contract already stored,
                    moves the escrow, and returns. That is exactly why it is one of the calls anyone
                    can make.
                  </p>
                )}
              </article>
            );
          })}
        </div>
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* States                                                             */}
      {/* ------------------------------------------------------------------ */}
      <section>
        <h2 className="cv-heading">What can be called from each state</h2>
        <p className="cv-body mt-2 max-w-[72ch]">
          A deal never returns to an earlier state, which is what makes a state name safe to print
          beside a sum of money. Verified is final: no later observation moves a deal out of it, on
          purpose. RDAP names a sponsoring registrar and never an account, so nothing this contract
          can read distinguishes the seller genuinely taking a domain back from the buyer moving
          their own delivered property around, and a check run after delivery records what it sees
          without ever acting on it.
        </p>
        <dl className="cv-panel mt-6 p-6">
          {DEAL_STATES.map((state) => (
            <Row
              key={state}
              label={DEAL_STATE_TEXT[state].label}
              note={DEAL_STATE_TEXT[state].holds}
            >
              {METHODS_BY_STATE[state].length === 0 ? (
                <span className="cv-unchanged">nothing; the deal is closed</span>
              ) : (
                <span className="cv-record-sm">{METHODS_BY_STATE[state].join(" · ")}</span>
              )}
            </Row>
          ))}
        </dl>
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* The four tags                                                      */}
      {/* ------------------------------------------------------------------ */}
      <section>
        <h2 className="cv-heading">The four things a refusal can mean</h2>
        <p className="cv-body mt-2 max-w-[72ch]">
          A refused transfer and an unreachable registry are not the same event, and an interface
          that showed them in the same red box would be hiding the difference that decides whether
          to try again. So the contract tags its own notes, this interface reads the tag rather than
          guessing from the words, and where a tag is missing it falls back to the one that claims
          least.
        </p>
        <dl className="cv-panel mt-6 p-6">
          {(Object.keys(REFUSAL_TAG_TEXT) as RefusalTag[]).map((tag) => (
            <Row key={tag} label={REFUSAL_TAG_TEXT[tag].tag}>
              <span className="cv-body">{REFUSAL_TAG_TEXT[tag].means}</span>
            </Row>
          ))}
        </dl>
        <p className="cv-aside mt-3 max-w-[72ch]">
          Only the first of the four is a verdict. The other three leave the deal exactly where it
          was and leave every window running, which is why an interface that reported them as
          progress would be the dangerous kind of wrong.
        </p>
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* Parameters                                                         */}
      {/* ------------------------------------------------------------------ */}
      <section>
        <h2 className="cv-heading">What the contract reports about itself</h2>
        <p className="cv-body mt-2 max-w-[72ch]">
          Read from <span className="cv-record-sm">parameters()</span>, not from this repository.
          Three of these are limits enforced on a signed transaction, and a build with no deployed
          contract to ask says so rather than filling them in from memory.
        </p>
        <dl className="cv-panel mt-6 p-6">
          {parameters.kind !== "AVAILABLE" ? (
            <ReadUnavailableRow result={parameters} subject="contract's own parameters" />
          ) : (
            <>
              <Row
                label="acceptance window"
                note="From the offer being lodged. When it closes, anyone may return the escrow to the buyer."
              >
                {formatWindow(parameters.value.accept_window_seconds)}
              </Row>
              <Row
                label="transfer window"
                note="From acceptance. When it closes with no check having observed the delivery, anyone may return the escrow to the buyer."
              >
                {formatWindow(parameters.value.transfer_window_seconds)}
              </Row>
              <Row
                label="inspection window"
                note="From the check that verified delivery. Until it closes only the buyer may settle; after it, anyone may."
              >
                {formatWindow(parameters.value.inspection_window_seconds)}
              </Row>
              <Row
                label="minimum interval between checks"
                note="Every validator fetches independently, and both RDAP and the resolvers rate limit per source. The contract enforces the spacing rather than asking callers to be polite."
              >
                {formatWindow(parameters.value.check_interval_seconds)}
              </Row>
              <Row
                label="largest escrow"
                note="A deployment ceiling, checked before the value is accepted."
              >
                {formatGen(parameters.value.max_deal_value_wei)}
              </Row>
              <Row
                label="nameservers per deal"
                note="Compared as a set: lowercased, root dot dropped, de-duplicated, sorted. Order is not a difference."
              >
                {parameters.value.min_nameservers} to {parameters.value.max_nameservers}
              </Row>
              <Row
                label="resolvers"
                note="Both are required to agree on every TXT lookup. One answering alone decides nothing."
              >
                {splitSet(parameters.value.resolvers).join(" · ") || (
                  <span className="cv-unchanged">not reported</span>
                )}
              </Row>
              <Row
                label="registry directory"
                note="The IANA bootstrap file, fetched inside consensus. The contract does not carry a list of registries; it resolves the authority for the TLD every time and refuses a TLD whose registry publishes no https base."
              >
                <span className="cv-record-sm break-all">
                  {parameters.value.iana_bootstrap_url || (
                    <span className="cv-unchanged">not reported</span>
                  )}
                </span>
              </Row>
              <Row
                label="runs a model"
                note="Reported by the contract so the claim can be checked rather than believed."
              >
                {parameters.value.uses_a_model}
              </Row>
              <Row
                label="embedded functions"
                note="How many callables the consensus block carries. It is reported so that a reader can compare it against the source that was deployed."
              >
                {parameters.value.embedded_function_count || (
                  <span className="cv-unchanged">not reported</span>
                )}
              </Row>
              {parameters.value.boundary ? (
                <Row label="the boundary, in the contract's words">
                  <span className="cv-body">{parameters.value.boundary}</span>
                </Row>
              ) : null}
            </>
          )}
        </dl>
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* Limits                                                             */}
      {/* ------------------------------------------------------------------ */}
      <section className="cv-panel-engraved p-6 plate:p-8">
        <h2 className="cv-heading">Where this instrument does not reach</h2>
        <p className="cv-body mt-2 max-w-[72ch]">
          Stated here rather than discovered later. Each of these is a real refusal in the contract,
          not a limitation of this interface.
        </p>
        <dl className="mt-6">
          <Limit label="it cannot move a domain">
            A transfer is executed at two registrars by the two parties. This contract holds the
            money and reads the result. If the seller never starts the transfer, no call here makes
            them; the transfer window closes and the escrow comes back.
          </Limit>
          <Limit label="a TLD whose registry publishes no https RDAP base">
            The contract refuses at open rather than settling on a source it cannot fetch inside
            consensus. Some live TLDs publish an http-only base in the IANA bootstrap, and a deal on
            one of those cannot be lodged here at all. Failing at open is the right end to fail at:
            failing later would fail with money already in escrow.
          </Limit>
          <Limit label="a registry lock the seller cannot lift">
            A lock the registrar set can be lifted by the seller, and the contract records it and
            opens the deal anyway. A lock the registry itself set cannot be, so the domain cannot be
            delivered whatever either party agrees, and the deal is refused before the escrow is
            taken.
          </Limit>
          <Limit label="a lost buyer secret">
            The chain holds only its hash. Nobody can pass a check without the secret, including the
            buyer who lost it and including anyone operating this interface. The escrow returns to
            the buyer when the transfer window closes, and there is no earlier route.
          </Limit>
          <Limit label="a dispute">
            There is nothing to file and nobody to file it with. A delivery that reverses is decided
            by the check itself, from what the registry says, deterministically. A route promising
            otherwise would be promising an authority this instrument does not contain.
          </Limit>
        </dl>
      </section>

      <div>
        <Link
          href="/deals"
          className="cv-legend cv-legend-ink underline decoration-1 underline-offset-4"
        >
          read the register
        </Link>
      </div>
    </div>
  );
}

/** A door's condition as a phrase: the state, and the window it waits on or widens after. */
function doorLabel(door: Door): string {
  const state = DEAL_STATE_TEXT[door.from].label;
  if (door.after) return `from ${state}, after ${DEADLINE_TEXT[door.after]} closes`;
  if (door.widensAfter) return `from ${state}, widening to anyone after ${DEADLINE_TEXT[door.widensAfter]} closes`;
  return `from ${state}`;
}

function Limit({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="cv-rule flex flex-wrap items-baseline gap-x-6 gap-y-1 py-3 first:border-t-0 first:pt-0">
      <dt className="cv-legend cv-legend-ink w-full shrink-0 plate:w-64">{label}</dt>
      <dd className="cv-body min-w-0 max-w-[62ch] flex-1">{children}</dd>
    </div>
  );
}
