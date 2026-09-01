"use client";

/**
 * The controls on one deal, chosen by the state the contract is actually in.
 *
 * `METHODS_BY_STATE` decides which cards exist, so this component cannot offer a call the
 * contract would refuse on state alone. What it adds on top is the part that needs a wallet and a
 * clock: whether the address in this browser is the one the door names, and whether the window a
 * door waits on has closed yet.
 *
 * THE DIVISION OF LABOUR ON `blocked`. A card is disabled only when the reason is in this browser
 * and stated in the same breath: the connected address is not the party, the window has not
 * closed, the token field is empty. Everything else stays pressable. A seller who has not yet
 * published their TXT record can still press Accept, get the contract's own refusal with its own
 * tag, and learn from the message rather than from a greyed-out button that explains nothing.
 *
 * WHY THE CHECK CARD HAS A TEXT FIELD. `check_transfer(deal_id, buyer_proof_token)` requires the
 * token on every call, including calls after the first successful one, and `get_deal` does not
 * return it. That is not an oversight in either place. The check is permissionless because
 * delivery is a fact about public records, and by the time a check can pass the token is published
 * in DNS where anybody can read it. So the field is here, anyone may fill it, and the buyer gets a
 * second box that rebuilds the token from the secret they kept.
 */

import { useMemo, useState } from "react";
import { ActionCard } from "@/components/action-card";
import { useWallet } from "@/components/wallet-provider";
import type { Deal } from "@/lib/contract-types";
import { displayTime } from "@/lib/format";
import { buyerProofValue } from "@/lib/secret";

const sameAddress = (a: string, b: string) => Boolean(a) && a.toLowerCase() === b.toLowerCase();

/** Has this instant passed, by the clock this page was rendered with. */
const elapsed = (iso: string, now: number) => Boolean(iso) && Date.parse(iso) <= now;

export function DealActions({
  deal,
  now,
  checkIntervalSeconds,
}: {
  deal: Deal;
  /** The clock this page rendered with. Frozen in fixture mode, on purpose. */
  now: number;
  /** The contract's floor between two checks, from `parameters()`. Empty if it could not be read. */
  checkIntervalSeconds: string;
}) {
  const wallet = useWallet();
  const you = wallet.address;
  const isBuyer = sameAddress(you, deal.buyer);
  const isSeller = sameAddress(you, deal.seller);
  const connected = wallet.mode !== "none";

  /** Why an address-gated door is shut in this browser, or null. */
  const notThisAddress = (who: "buyer" | "seller" | "either") => {
    if (!connected) return null;
    if (who === "buyer" && !isBuyer) return `This call is the buyer's. The connected address is not the buyer on this deal.`;
    if (who === "seller" && !isSeller) return `This call is the seller's. The connected address is not the seller on this deal.`;
    if (who === "either" && !isBuyer && !isSeller) {
      return "This call is for the buyer or the seller. The connected address is neither.";
    }
    return null;
  };

  const notYet = (iso: string, what: string) =>
    elapsed(iso, now) ? null : `${what} has not closed. It closes at ${displayTime(iso)}.`;

  return (
    <div className="space-y-6">
      {deal.state === "OFFERED" ? (
        <>
          <ActionCard
            method="arm"
            state="OFFERED"
            title="Accept the offer and prove control"
            what="Reads the seller's TXT record at both resolvers, then fetches the registry object and freezes it as the baseline every later check is measured against. This is the only call that writes a baseline, and it cannot be repeated."
            buttonLabel="Accept and arm"
            args={[deal.deal_id]}
            dealId={deal.deal_id}
            blocked={notThisAddress("seller")}
          >
            <p className="cv-aside mt-3 max-w-[68ch]">
              Publish{" "}
              <span className="cv-record-sm break-all">{deal.seller_proof_name}</span> with the
              token on the record below before pressing this. If it is not resolving yet the
              contract refuses with its own tag and nothing is spent but gas, so pressing early
              costs a message rather than the deal.
            </p>
          </ActionCard>

          <ActionCard
            method="abandon"
            state="OFFERED"
            title="Give the deal up"
            what="Closes the deal and returns the consideration to the buyer. No window has to pass, because nothing has been proved and no transfer can be in flight."
            buttonLabel="Give it up"
            args={[deal.deal_id]}
            dealId={deal.deal_id}
            blocked={notThisAddress("either")}
          />

          <ActionCard
            method="refund"
            state="OFFERED"
            title="Return the consideration"
            what="Returns the escrow to the buyer because the seller did not accept inside the window. The destination is the buyer whoever presses it."
            buttonLabel="Return it to the buyer"
            args={[deal.deal_id]}
            dealId={deal.deal_id}
            blocked={notYet(deal.accept_deadline, "The acceptance window")}
          />
        </>
      ) : null}

      {deal.state === "LOCKED" || deal.state === "VERIFIED" ? (
        <CheckCard deal={deal} now={now} checkIntervalSeconds={checkIntervalSeconds} />
      ) : null}

      {deal.state === "LOCKED" ? (
        <>
          <ActionCard
            method="abandon"
            state="LOCKED"
            title="Give the deal up"
            what="Closes the deal and returns the consideration to the buyer. From here it is the seller's call alone."
            buttonLabel="Give it up"
            args={[deal.deal_id]}
            dealId={deal.deal_id}
            blocked={notThisAddress("seller")}
          />

          <ActionCard
            method="refund"
            state="LOCKED"
            title="Return the consideration"
            what="Returns the escrow to the buyer because the transfer window closed without any check observing the delivery. This is the buyer's exit and anyone may take it for them."
            buttonLabel="Return it to the buyer"
            args={[deal.deal_id]}
            dealId={deal.deal_id}
            blocked={notYet(deal.transfer_deadline, "The transfer window")}
          />
        </>
      ) : null}

      {deal.state === "VERIFIED" ? (
        <ActionCard
          method="settle"
          state="VERIFIED"
          title="Release the consideration to the seller"
          what="Re-reads the registry and the buyer's record with the token the contract stored, requires the delivery to still hold, and then pays the seller. It is not a signature on a promise: the delivery is proved a second time inside this transaction."
          buttonLabel="Release to the seller"
          args={[deal.deal_id]}
          dealId={deal.deal_id}
          blocked={
            elapsed(deal.inspection_deadline, now)
              ? null
              : (notThisAddress("buyer") ??
                (connected
                  ? null
                  : "Connect the buyer's wallet, or wait for the inspection window to close, after which anyone may press this."))
          }
        />
      ) : null}

      {deal.state === "REVERSED" ? (
        <ActionCard
          method="refund"
          state="REVERSED"
          title="Return the consideration"
          what="Returns the escrow to the buyer because a check found the registration back with the seller's own registrar. No window is needed: the fact that decides this is already on chain."
          buttonLabel="Return it to the buyer"
          args={[deal.deal_id]}
          dealId={deal.deal_id}
          blocked={null}
        />
      ) : null}

      {deal.state === "RELEASED" || deal.state === "REFUNDED" ? (
        <section className="cv-panel p-6">
          <h3 className="cv-heading">Closed</h3>
          <p className="cv-body mt-2 max-w-[68ch]">
            This deal is settled and the contract holds nothing against it. There is no call left
            that would change it, so there is no control here. Every field above is still readable
            and will stay readable, which is the point of keeping them.
          </p>
        </section>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* The check, with the token it requires                                      */
/* -------------------------------------------------------------------------- */

/**
 * The one control that takes an argument beyond the deal id.
 *
 * Two ways to fill it, because there are two people who might. Anyone at all can paste the token
 * they read out of DNS. The buyer can paste the secret they generated at open, and the token is
 * rebuilt here from the deal id, the buyer's address and that secret, in the same order the
 * contract hashes them. The rebuild happens in this browser and the secret is never sent anywhere,
 * including to the chain: what goes on chain is the token, which is public by then anyway.
 */
function CheckCard({
  deal,
  now,
  checkIntervalSeconds,
}: {
  deal: Deal;
  now: number;
  checkIntervalSeconds: string;
}) {
  const [pasted, setPasted] = useState("");
  const [secret, setSecret] = useState("");

  // Rebuilt rather than stored, so there is one source for the token and no second copy of it in
  // component state to fall out of step with the box the reader is looking at.
  const rebuilt = useMemo(
    () => (secret.trim() ? buyerProofValue(deal.deal_id, deal.buyer, secret.trim()) : ""),
    [deal.deal_id, deal.buyer, secret],
  );

  // A rebuild wins over anything pasted, and the box goes read-only while one exists. Two editable
  // sources for one argument is two things that can disagree, and the one that would be sent is
  // whichever the code happened to prefer. Here the preference is visible: the box shows what will
  // be sent, and clearing the secret hands it back.
  const token = rebuilt || pasted;

  const interval = Number(checkIntervalSeconds || "0");
  const nextDue =
    deal.last_check_at && interval > 0
      ? new Date(Date.parse(deal.last_check_at) + interval * 1000).toISOString()
      : "";
  const tooSoon = Boolean(nextDue) && Date.parse(nextDue) > now;

  const blocked = !token.trim()
    ? "Supply the buyer's proof token. The contract requires it on every check and does not return it from a view."
    : tooSoon
      ? `The last check ran at ${displayTime(deal.last_check_at)} and the next is due at ${displayTime(nextDue)}. Every validator fetches independently, and both RDAP and the resolvers rate limit per source.`
      : null;

  return (
    <ActionCard
      method="check_transfer"
      state={deal.state}
      title="Run a check"
      what={
        deal.state === "VERIFIED"
          ? "Reads the registry and both resolvers again. From here the same call is how a reversal is caught: if the registration has gone back to the seller's own registrar and the proof has gone with it, this records that and the escrow becomes the buyer's."
          : "Makes every validator fetch the registry and both resolvers, compare what they find against the frozen baseline, and write the answer down whatever it is. Four of the outcomes advance nothing and are still recorded."
      }
      buttonLabel="Run the check"
      args={() => [deal.deal_id, token.trim()]}
      dealId={deal.deal_id}
      blocked={blocked}
    >
      <div className="cv-rule mt-4 pt-4">
        <label className="cv-legend cv-legend-ink block" htmlFor="proof-token">
          the buyer&rsquo;s proof token
        </label>
        <p className="cv-aside mt-1 max-w-[68ch]">
          The whole TXT value, byte for byte. It hashes to the commitment recorded on this deal, and
          a token that hashes to anything else is refused before a single fetch goes out.
        </p>
        <input
          id="proof-token"
          type="text"
          value={token}
          onChange={(event) => setPasted(event.target.value)}
          readOnly={Boolean(rebuilt)}
          placeholder={`v1;deal=${deal.deal_id};buyer=…;secret=…`}
          spellCheck={false}
          autoComplete="off"
          className="cv-input mt-2 w-full"
        />
        {rebuilt ? (
          <p className="cv-aside mt-2 max-w-[68ch]">
            Filled from the secret below, so it is not editable here. Clear the secret to paste a
            token instead.
          </p>
        ) : null}

        <label className="cv-legend cv-legend-ink mt-4 block" htmlFor="proof-secret">
          or, if you are the buyer, the secret you kept
        </label>
        <p className="cv-aside mt-1 max-w-[68ch]">
          The token is rebuilt from it here, in this tab. The secret itself is not sent anywhere and
          does not go on chain.
        </p>
        <input
          id="proof-secret"
          type="text"
          value={secret}
          onChange={(event) => setSecret(event.target.value)}
          placeholder="the 64 hex characters generated when the offer was lodged"
          spellCheck={false}
          autoComplete="off"
          className="cv-input mt-2 w-full"
        />
        {rebuilt ? (
          <p className="cv-aside mt-2 max-w-[68ch]">
            The token above was rebuilt from it, and that is what will be sent.
          </p>
        ) : null}

        {deal.buyer_proof_revealed === "True" ? (
          <p className="cv-aside mt-3 max-w-[68ch]">
            A previous check already matched a token against this deal&rsquo;s commitment, so the
            token is published and readable at{" "}
            <span className="cv-record-sm break-all">{deal.buyer_proof_name}</span>. The contract
            still requires it here, and it still has to be the same one.
          </p>
        ) : null}
      </div>
    </ActionCard>
  );
}
