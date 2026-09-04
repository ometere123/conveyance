/**
 * Lodging an offer: the server half.
 *
 * Everything the form validates against is read here and handed down as plain strings. Two of
 * those figures are the contract's own limits, and this page will not substitute a number from
 * this repository when the contract cannot be asked for them. A form that validated a signature
 * against a remembered ceiling would pass in the browser and be refused on chain, and while
 * `open_deal` hands the escrow back when it refuses, the signature is spent either way.
 *
 * The explanation sits above the form rather than inside it. Somebody about to escrow a sum
 * against a domain transfer should be able to read what they are agreeing to without touching a
 * field, and the shape of the agreement does not change from deal to deal.
 */

import type { Metadata } from "next";
import Link from "next/link";
import { LodgeOffer } from "@/components/lodge-offer";
import { getParameters, nameserverBounds, priceCap } from "@/lib/data-source";
import { formatWindow } from "@/lib/format";

/**
 * Read on every request, never prerendered.
 *
 * The ceiling and the nameserver bounds on this form are the contract's own limits, read through
 * `parameters()`. Prerendered, they would be the limits the contract had at the moment of the last
 * build, and the docstring above is explicit about why that is not acceptable here: the form
 * validates a signature against them, so a stale ceiling passes in the browser and is refused on
 * chain, and `open_deal` hands the escrow back but the signature is spent either way. This is the
 * one page where a frozen figure costs the reader a transaction.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Lodge an offer",
  description:
    "Escrow a sum against a domain transfer: the terms the contract records, the checks it runs before it accepts them, and the secret only the buyer holds.",
};

/** A failed read's own sentence, or an empty string when the read succeeded. */
function refusalOf(result: { kind: string; error?: string }): string {
  if (result.kind === "AVAILABLE") return "";
  return result.error ?? "That figure could not be read from the contract.";
}

export default async function NewDealPage() {
  // One view call, three facts. The limit readers are handed the result rather than each fetching
  // it, which is what makes the sentence below literally true instead of only logically true: it
  // said the two limits derive from the same `parameters()` read while all three were separately
  // asking the node the same question, three times per render against a budget of thirty a minute.
  const parameters = await getParameters();
  const [cap, bounds] = await Promise.all([priceCap(parameters), nameserverBounds(parameters)]);

  // The two limit reads refuse rather than guess, and they refuse for the same reason, so one
  // sentence covers both. Whichever refused first is the one printed; they cannot disagree,
  // because both derive from the same `parameters()` read.
  const limitRefusal = refusalOf(cap) || refusalOf(bounds);

  const acceptWindow =
    parameters.kind === "AVAILABLE" ? parameters.value.accept_window_seconds : "";
  const transferWindow =
    parameters.kind === "AVAILABLE" ? parameters.value.transfer_window_seconds : "";
  const inspectionWindow =
    parameters.kind === "AVAILABLE" ? parameters.value.inspection_window_seconds : "";

  return (
    <div className="space-y-14">
      <header>
        <p className="cv-legend">the register</p>
        <h1 className="cv-heading mt-2">Lodge an offer</h1>
        <p className="cv-body mt-3 max-w-[72ch]">
          An offer puts a sum into the contract&rsquo;s custody and names the conditions under which
          it leaves. Nothing here asks anybody to trust a registrar, a marketplace or this page. The
          conditions are read from the registry and from DNS inside consensus, by every validator
          independently, and the money moves on what they agree the sources said.
        </p>
      </header>

      {/* -------------------------------------------------------------------- */}
      {/* What is being agreed to                                              */}
      {/* -------------------------------------------------------------------- */}
      <section className="cv-panel-engraved p-6 plate:p-8">
        <h2 className="cv-heading">What you are agreeing to</h2>
        <p className="cv-body mt-2 max-w-[72ch]">
          Read this once. Every clause below is enforced by the contract rather than by this
          interface, and none of them can be renegotiated after the offer is lodged.
        </p>
        <dl className="mt-6">
          <Clause label="the sum leaves your wallet now">
            The consideration is taken into escrow by the call that lodges the offer. It is not a
            pledge and it is not an approval. It sits in the contract from that moment until the
            deal closes.
          </Clause>
          <Clause label="the seller has to accept">
            Only the address you name may accept, and they accept by publishing a record the
            contract computes for them and then calling{" "}
            <span className="cv-record-sm">arm</span>. If they have not accepted
            {acceptWindow ? ` within ${formatWindow(acceptWindow)}` : " before the acceptance window closes"},
            anyone at all may return the escrow to you.
          </Clause>
          <Clause label="acceptance takes a baseline, and the baseline is the comparison">
            At acceptance the contract records what the registry says the domain looks like right
            then. Everything a later check reports is a difference from that record, so a transfer
            that happened before acceptance is not a transfer this deal delivered.
          </Clause>
          <Clause label="two conditions, and both have to hold at the same check">
            The registration has to have moved to the registrar you named and be delegated to the
            nameservers you named, and the name has to carry a record only you could have published.
            Neither implies the other. A check that finds one and not the other reports exactly that
            and settles nothing.
          </Clause>
          <Clause label="the secret is yours alone and cannot be recovered">
            The chain gets its sha256 and nothing else. If you lose it, nobody can pass a check on
            this deal, and the escrow comes back to you when the transfer window closes
            {transferWindow ? `, which is ${formatWindow(transferWindow)} after acceptance` : ""}.
            Not before.
          </Clause>
          <Clause label="verified delivery is final">
            After a check verifies delivery, an inspection window runs
            {inspectionWindow ? ` for ${formatWindow(inspectionWindow)}` : ""}, during which you may
            settle at once if you are satisfied. Once verified, there is no refund route: the
            registry and both resolvers already agreed the name is yours, and that does not get
            revisited. Anyone may settle once the window closes.
          </Clause>
          <Clause label="anyone can drive it, including neither of you">
            Every transition is a public call. A check, a settlement, a refund: none of them are
            gated on being a party, because a settlement that only the seller could trigger is a
            settlement the seller can withhold.
          </Clause>
        </dl>
      </section>

      {/* -------------------------------------------------------------------- */}
      {/* The form                                                             */}
      {/* -------------------------------------------------------------------- */}
      <LodgeOffer
        maxDealValueWei={cap.kind === "AVAILABLE" ? cap.value : ""}
        nameserverMin={bounds.kind === "AVAILABLE" ? String(bounds.value.min) : ""}
        nameserverMax={bounds.kind === "AVAILABLE" ? String(bounds.value.max) : ""}
        limitRefusal={limitRefusal}
        acceptWindowSeconds={acceptWindow}
      />

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

function Clause({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="cv-rule flex flex-wrap items-baseline gap-x-6 gap-y-1 py-3 first:border-t-0 first:pt-0">
      <dt className="cv-legend cv-legend-ink w-full shrink-0 plate:w-56">{label}</dt>
      <dd className="cv-body min-w-0 max-w-[62ch] flex-1">{children}</dd>
    </div>
  );
}
