/**
 * The plate: what this contract decides, what it refuses to decide, and the register.
 *
 * A frontispiece for an escrow has one job, which is to make the boundary of the promise
 * unmistakable before anybody puts money behind it. So the two columns near the top are not
 * marketing symmetry. The left one is what the contract will settle; the right one is what it
 * will not, including the two things a reader is most likely to assume it does.
 *
 * The seal here is a record, not an ornament. It is drawn from a real deal in whatever register
 * this build is reading, and it is labelled with that deal's identifier, because a closed seal
 * means three named conditions were engraved and printing one that means nothing would teach the
 * reader to ignore the one that does. If that deal cannot be read the drawing is replaced by the
 * refusal, never by an empty space: an absent seal and an open seal are different claims.
 *
 * WHY THE FIGURES COME FROM TWO CALLS. `ledger()` reports what moved and `parameters()` reports
 * the constants that decide when it may. They are separate methods on the contract and they are
 * separate reads here, so one being unreadable does not blank the other. Three of the
 * parameters are deliberately unanswerable in fixture mode and the panel that needs them says so
 * rather than filling in a figure from this repository.
 */

import Link from "next/link";
import { ConveyanceSeal, SealLegend } from "@/components/conveyance-seal";
import { DealRow, DealRowHead } from "@/components/deal-row";
import { ReadUnavailable, ReadUnavailableRow } from "@/components/read-unavailable";
import { Stat } from "@/components/record";
import { CONDITION_KEYS, CONDITION_TEXT, type Deal } from "@/lib/contract-types";
import { CONDITION_OUTCOME_WORD } from "@/lib/contract-types";
import { getDeal, getLedger, getParameters, listDeals } from "@/lib/data-source";
import { formatCount, formatGen, formatWindow } from "@/lib/format";
import type { ReadResult } from "@/lib/genlayer/read-result";
import { sealState, sealSentence } from "@/lib/seal";

/**
 * Read on every request, never prerendered.
 *
 * This page has no dynamic input, so Next was prerendering it into a 46 KB HTML file at build time
 * and serving that. The strip above the content says every figure on the page was read from the
 * deployed contract, and there is no date beside the claim that would have made a frozen copy look
 * stale, so the failure would have been silent: the ledger sums, the reversal count and the seal
 * would all keep reporting whatever was true at the moment of the build. The seal is the worst of
 * those, because it draws three named conditions from a real deal and a closed seal is a statement
 * about that deal now. Four reads per page load, all of them free.
 */
export const dynamic = "force-dynamic";

/**
 * The deal whose seal is printed on the plate.
 *
 * One identifier, read through the same `getDeal` every other page uses, so this drawing is a
 * register entry and not an illustration. Live, this is whichever deal the deployment carries
 * under that id, and if it carries none the panel says the register does not have it rather than
 * substituting a friendlier one.
 */
const EMBLEM_DEAL = "CVY-1078";

const DECIDES = [
  "Whether the registry now records a transfer of this exact domain, published later than the moment the seller armed.",
  "Whether the sponsoring registrar is the one the deal names, and whether the delegation the registry publishes is the nameserver set the buyer named at open.",
  "Whether a deal-bound TXT record resolves in the zone at two independent resolvers that agree with each other.",
  "Who the escrowed sum belongs to once those questions have answers, and it pays that party without asking anybody's permission.",
];

const DOES_NOT_DECIDE = [
  "Whether the domain was worth the price. Nothing here is a valuation and nothing here is advice.",
  "Whether an off-chain side agreement was honoured. The contract reads the registry and the zone, and nothing else.",
  "Who owns a name in law. Registry records are evidence of registration, not of title, and a court can contradict them.",
  "Anything held privately at a registrar. A retained delegate on the account is invisible to RDAP, so this contract makes no claim about it in either direction.",
];

/**
 * The seal on the plate, and the refusal that replaces it if that deal could not be read.
 *
 * Split into its own function so the failure branch is narrowed by an early return rather than by
 * a condition in the middle of a ternary. The distinction matters more than usual here, because
 * the fallback must not be blank.
 */
function Emblem({ result }: { result: ReadResult<Deal> }) {
  if (result.kind !== "AVAILABLE") {
    return (
      <div className="cv-panel p-6">
        <ReadUnavailableRow result={result} subject="deal used as the emblem" />
        <p className="cv-aside mt-3 max-w-[40ch]">
          The three conditions are still the three conditions. Only the illustration of one deal is
          missing, and nothing on this page depends on it.
        </p>
      </div>
    );
  }
  const deal = result.value;
  const state = sealState(deal);
  return (
    <div>
      <div className="flex justify-center">
        <ConveyanceSeal state={state} animate={false} />
      </div>
      <p className="cv-body mt-5 max-w-[40ch]">{sealSentence(state)}</p>
      <div className="mt-5">
        <SealLegend state={state} />
      </div>
      <p className="cv-aside mt-4 max-w-[40ch]">
        This is the seal for {deal.deal_id}, {deal.domain}, as the contract recorded it. It is
        struck one segment at a time and it is drawn from that deal&rsquo;s own recorded check
        rather than composed for this page.
      </p>
      <Link
        href={`/deals/${deal.deal_id}`}
        className="cv-legend cv-legend-ink mt-3 inline-block underline decoration-1 underline-offset-4"
      >
        read the register entry
      </Link>
    </div>
  );
}

export default async function PlatePage() {
  const [ledger, parameters, deals, emblem] = await Promise.all([
    getLedger(),
    getParameters(),
    listDeals(),
    getDeal(EMBLEM_DEAL),
  ]);
  const seal = emblem.kind === "AVAILABLE" ? sealState(emblem.value) : null;
  // Newest first. `deal_ids` appends on chain, so `list_deals` hands back oldest first and the
  // reversal is this interface's, which is why it is stated under the heading rather than assumed.
  const preview = deals.kind === "AVAILABLE" ? deals.value.slice().reverse().slice(0, 6) : [];

  return (
    <div className="space-y-16">
      {/* ------------------------------------------------------------------ */}
      {/* The proposition                                                    */}
      {/* ------------------------------------------------------------------ */}
      <section>
        <p className="cv-legend">deed of conveyance, held in escrow</p>
        <h1 className="cv-asset mt-3 max-w-[26ch]">
          The money moves when the registry says the domain did.
        </h1>
        <p className="cv-body mt-6 max-w-[72ch]">
          A buyer funds an offer against one domain name. A seller accepts, and the contract freezes
          what the registry said at that moment. From then on anyone at all can press a button that
          makes the validators fetch the registry and the zone themselves, compare what they find
          against the frozen baseline, and write the answer down. When all three conditions hold the
          consideration is the seller&rsquo;s. When a window closes without them, it is the
          buyer&rsquo;s again. Neither party is asked to be honest and neither party can stall,
          because every transition in this contract is permissionless.
        </p>

        <div className="mt-10 grid gap-x-10 gap-y-8 plate:grid-cols-2">
          <div className="cv-panel p-6">
            <h2 className="cv-heading">What it decides</h2>
            <ul className="mt-4 list-none p-0">
              {DECIDES.map((line) => (
                <li key={line} className="cv-rule cv-body max-w-[62ch] py-2.5 first:border-t-0">
                  {line}
                </li>
              ))}
            </ul>
          </div>
          <div className="cv-panel p-6">
            <h2 className="cv-heading">What it does not decide</h2>
            <ul className="mt-4 list-none p-0">
              {DOES_NOT_DECIDE.map((line) => (
                <li key={line} className="cv-rule cv-body max-w-[62ch] py-2.5 first:border-t-0">
                  {line}
                </li>
              ))}
            </ul>
            <p className="cv-aside mt-4 max-w-[62ch]">
              It also does not move the domain. A registrar transfer is executed at two registrars
              by the two people, and no contract on any chain can do it for them. This one holds the
              money and reads the outcome.
            </p>
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* The three conditions, beside a seal that is a real record          */}
      {/* ------------------------------------------------------------------ */}
      <section>
        <h2 className="cv-heading">The three conditions</h2>
        <p className="cv-body mt-2 max-w-[72ch]">
          Delivery is not one question, and treating it as one is how escrow for a domain gets it
          wrong. A registry can record a transfer to a party who never gets the zone. A zone can
          answer for a name whose registration never moved. Each condition below is read from a
          different source inside one consensus block, and each is written down separately, so a
          partial delivery reads as a partial delivery instead of a failure.
        </p>

        <div className="mt-8 grid gap-x-12 gap-y-10 plate:grid-cols-[1fr_auto]">
          <ol className="list-none p-0">
            {CONDITION_KEYS.map((key) => {
              const text = CONDITION_TEXT[key];
              const segment = seal?.segments.find((row) => row.key === key);
              return (
                <li key={key} className="cv-rule py-4 first:border-t-0">
                  <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                    <span className="cv-legend cv-legend-ink">{text.ordinal}</span>
                    <h3 className="cv-body">{text.label}</h3>
                    {segment ? (
                      <span className="cv-record-sm ml-auto">
                        {CONDITION_OUTCOME_WORD[segment.outcome]}
                      </span>
                    ) : null}
                  </div>
                  <p className="cv-body mt-1.5 max-w-[62ch]">{text.asks}</p>
                  <p className="cv-aside mt-1.5 max-w-[62ch]">
                    <span className="cv-legend mr-2">read from</span>
                    {text.source}
                  </p>
                </li>
              );
            })}
          </ol>

          <div className="plate:w-[320px]">
            <Emblem result={emblem} />
          </div>
        </div>

        <p className="cv-aside mt-6 max-w-[72ch]">
          Every one of those reads happens inside{" "}
          <span className="cv-record-sm">gl.eq_principle.strict_eq</span>, which means every
          validator has to arrive at the same bytes rather than agree that two answers are close
          enough. There is no model in this contract, and{" "}
          <Link href="/docs" className="underline decoration-1 underline-offset-4">
            the instrument
          </Link>{" "}
          sets out why a registry transfer is the wrong question to ask one.
        </p>
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* The figures                                                        */}
      {/* ------------------------------------------------------------------ */}
      <section>
        <h2 className="cv-heading">The register in figures</h2>
        <p className="cv-body mt-2 max-w-[72ch]">
          Escrow conservation, checkable by addition. What the contract took in, less what it paid
          out, is what it should still be holding, and the balance beside it is what it actually
          holds. Both are printed because the case where they differ is the one worth being able to
          see.
        </p>
        {ledger.kind === "AVAILABLE" ? (
          <>
            <div className="cv-panel mt-4 grid gap-x-10 gap-y-6 p-6 plate:grid-cols-4">
              <Stat label="taken into escrow" value={formatGen(ledger.value.total_escrowed)} />
              <Stat label="paid to sellers" value={formatGen(ledger.value.total_released)} />
              <Stat label="returned to buyers" value={formatGen(ledger.value.total_refunded)} />
              <Stat label="still held" value={formatGen(ledger.value.held)} />
              <Stat label="contract balance" value={formatGen(ledger.value.balance)} />
              <Stat label="offers lodged" value={formatCount(ledger.value.deals_opened)} />
              <Stat label="checks run by anyone" value={formatCount(ledger.value.checks_run)} />
              <Stat
                label="deliveries verified"
                value={formatCount(ledger.value.deliveries_verified)}
              />
            </div>
            <p className="cv-aside mt-3 max-w-[72ch]">
              {ledger.value.held === ledger.value.balance
                ? "Held and balance agree, so the counters and the contract's own balance tell the same story."
                : "Held and balance do not agree. Both figures are the contract's, and the difference is printed rather than reconciled by this page."}{" "}
              Reversals recorded: {formatCount(ledger.value.reversals_recorded)}. Protocol fee:{" "}
              {formatGen(ledger.value.protocol_fee)}, which is a field kept so its absence is
              checkable rather than asserted.
            </p>
          </>
        ) : (
          <div className="mt-4">
            <ReadUnavailable result={ledger} subject="escrow ledger" />
          </div>
        )}

        <h3 className="cv-heading mt-10">The windows</h3>
        <p className="cv-body mt-2 max-w-[72ch]">
          Four windows, each the contract&rsquo;s own constant rather than a figure this interface
          chose. When a window closes, the transition it guards becomes available to anyone at all,
          which is the whole reason a party who goes quiet cannot hold the money.
        </p>
        {parameters.kind === "AVAILABLE" ? (
          <>
            <dl className="cv-panel mt-4 grid gap-x-10 gap-y-6 p-6 plate:grid-cols-4">
              <Stat
                label="to accept an offer"
                value={formatWindow(parameters.value.accept_window_seconds)}
              />
              <Stat
                label="to execute the transfer"
                value={formatWindow(parameters.value.transfer_window_seconds)}
              />
              <Stat
                label="for the buyer to inspect"
                value={formatWindow(parameters.value.inspection_window_seconds)}
              />
              <Stat
                label="between two checks"
                value={formatWindow(parameters.value.check_interval_seconds)}
              />
            </dl>
            <p className="cv-aside mt-3 max-w-[72ch]">
              The last figure is not a window but a floor: two checks closer together than that are
              refused, so nobody can bill the validators for a hundred reads of the same registry
              object in a minute. The resolvers consulted are{" "}
              <span className="cv-record-sm">{parameters.value.resolvers}</span>, always both, and
              the contract reports{" "}
              <span className="cv-record-sm">uses_a_model: {parameters.value.uses_a_model}</span>.
            </p>
            <p className="cv-body mt-4 max-w-[72ch]">{parameters.value.boundary}</p>
          </>
        ) : (
          <div className="mt-4">
            <ReadUnavailable result={parameters} subject="contract parameters" />
          </div>
        )}
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* The register itself                                                */}
      {/* ------------------------------------------------------------------ */}
      <section>
        <div className="flex flex-wrap items-baseline justify-between gap-x-8 gap-y-2">
          <h2 className="cv-heading">Most recent entries</h2>
          <Link
            href="/deals"
            className="cv-legend cv-legend-ink underline decoration-1 underline-offset-4"
          >
            the whole register
          </Link>
        </div>
        <p className="cv-aside mt-2 max-w-[72ch]">
          Newest first. The contract appends, so it hands these back oldest first and the reversal
          is this page&rsquo;s doing rather than the register&rsquo;s.
        </p>

        {deals.kind === "AVAILABLE" ? (
          preview.length === 0 ? (
            <p className="cv-body mt-4 max-w-[68ch]">
              The register carries no entries yet. That is a statement about the contract&rsquo;s
              storage and not about whether it could be read.
            </p>
          ) : (
            <div className="cv-panel mt-4 p-2 plate:p-4">
              <DealRowHead />
              {preview.map((deal) => (
                <DealRow key={deal.deal_id} deal={deal} />
              ))}
            </div>
          )
        ) : (
          <div className="mt-4">
            <ReadUnavailable result={deals} subject="register of deals" />
          </div>
        )}
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* Where to go                                                        */}
      {/* ------------------------------------------------------------------ */}
      <section className="cv-panel-engraved p-6 plate:p-8">
        <h2 className="cv-heading">Before you lodge anything</h2>
        <p className="cv-body mt-2 max-w-[72ch]">
          Opening a deal attaches the full consideration to the transaction, and it generates a
          secret that exists in your browser and nowhere else. The contract stores only the
          commitment to it, so a lost secret cannot be recovered by anyone, including whoever runs
          this interface. Read what the instrument does with it first.
        </p>
        <div className="mt-6 flex flex-wrap items-baseline gap-x-8 gap-y-3">
          <Link href="/docs" className="cv-btn no-underline">
            Read the instrument
          </Link>
          <Link
            href="/deals/new"
            className="cv-legend cv-legend-ink underline decoration-1 underline-offset-4"
          >
            lodge an offer
          </Link>
          <Link
            href="/deals"
            className="cv-legend cv-legend-ink underline decoration-1 underline-offset-4"
          >
            read the register
          </Link>
        </div>
      </section>
    </div>
  );
}
