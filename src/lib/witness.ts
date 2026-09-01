/**
 * The buyer's control proof, as the chain records it.
 *
 * WHAT THE CHAIN CARRIES, AND WHAT IT DELIBERATELY DOES NOT. The contract asks two resolvers
 * for the same TXT record inside one consensus block, and it stores three things: the proof
 * outcome, the corroborated record set, and the digest of the set at the check that delivered.
 * It stores nothing per resolver. That is not an omission to work around, it is the design:
 * the two resolvers format the same unchanging record differently on eight measured axes, so
 * the only thing two validators can be asked to agree on is the normalised record set. Raw
 * bodies on chain would be raw bodies that guarantee disagreement.
 *
 * So this file does not compare witnesses. It reads what the comparison already concluded, and
 * it prints the axes the contract compared and the axes it excluded, verbatim, so that a
 * reader can check the rule rather than take the verdict on faith.
 *
 * THE ONE INFERENCE, AND WHY IT IS SOUND. `Corroboration.__init__` sets
 * `values = first.values if (agreed and first is not None) else ()`, so the stored
 * `last_proof_values` is non-empty if and only if both resolvers answered and their normalised
 * sets matched. A non-empty set on chain is therefore proof of agreement, not a summary of it.
 *
 * WHY THAT INFERENCE IS LOAD BEARING RATHER THAN DECORATIVE. `PROOF_ABSENT` means two
 * different things and the record set is the only thing that separates them. `classify_proof`
 * returns it when the resolvers agreed and the expected token was not in the set they agreed
 * on, and it returns it again when the resolvers did not agree at all and neither of them said
 * NXDOMAIN. The first is a fact about the buyer's zone. The second is a fact about propagation
 * or about a resolver. Reading the second as the first would tell a buyer their record is
 * missing when the record may be published and one resolver simply had not caught up.
 *
 * `arm` and `check_transfer` differ here on purpose, and it is why the disagreement reaches the
 * chain at all. `arm` raises on a proof that does not hold, because the seller is the caller and
 * nobody else needs the attempt recorded. `check_transfer` records it: `_delivery_block` returns
 * the disagreement rather than raising, "which lets `check_transfer` write the disagreement onto
 * the deal before deciding what to do about it", because a raise there would revert the
 * transaction and take the record with it.
 */

import type { Deal, ProofOutcome } from "./contract-types.ts";
import { taggedRefusal } from "./contract-types.ts";
import { splitSet } from "./format.ts";

/* -------------------------------------------------------------------------- */
/* The comparison rule, copied from the contract                              */
/* -------------------------------------------------------------------------- */

/**
 * The three axes the contract compares. `PROOF_COMPARED` in `contracts/Conveyance.py`.
 *
 * Copied rather than derived, because there is no view that returns them and inventing a
 * paraphrase would put a second version of the rule in the world. If the contract's tuple
 * changes, this list is wrong, and that is why it names its source.
 */
export const PROOF_COMPARED: string[] = [
  "the DNS rcode, which must be NOERROR from both",
  "the query name, lowercased with the root label dropped",
  "the set of TXT character-string values from Answer only, RFC 1035 decoded, sorted",
];

/**
 * The eight axes it excludes, each with the measurement that justifies excluding it.
 *
 * This is the part worth reading. Every line here is a way two healthy resolvers differ about
 * one record that never changed, and a naive implementation that hashed the response body
 * would fail consensus on all eight.
 */
export const PROOF_EXCLUDED: string[] = [
  "TTL, because each resolver reports its own remaining cache time, 58 against 300 in the captures, and neither is a fact about the record",
  "the Comment field, which Google uses to name the answering resolver IP and Cloudflare omits entirely, so hashing it guarantees disagreement",
  "literal quoting of TXT character-strings, present on Cloudflare and absent on Google, worth 2 bytes per record and no meaning",
  "the trailing root label on the query name, kept by Google and dropped by Cloudflare",
  "record order within Answer, which no resolver promises to preserve",
  "the Authority and Additional sections, which are never a proof source",
  "the TC, RD, RA, AD and CD header flags, which describe the transport and the resolver's own DNSSEC posture rather than the record",
  "HTTP response headers and body length, because the Date header is different on every request and the length follows from how each resolver serialises its JSON rather than from the record inside it",
];

/* -------------------------------------------------------------------------- */
/* The verdict                                                                */
/* -------------------------------------------------------------------------- */

export type ProofVerdict =
  /**
   * Both resolvers answered and agreed, and the expected token was in the set.
   *
   * `values` is the corroborated set. Its non-emptiness is what proves the agreement, so it
   * is carried rather than a separate boolean that could drift from it.
   */
  | { kind: "CORROBORATED"; values: string[] }
  /** The name resolves at both, they agreed, and the expected token was not in the set. */
  | { kind: "TOKEN_ABSENT"; values: string[] }
  /**
   * The two resolvers did not agree, and neither of them said the name does not exist.
   *
   * One of four things in the contract: one resolver returned no TXT Answer, the two answered
   * different query names, the two returned different normalised TXT sets, or fewer than two
   * observations arrived. All four are `[TRANSIENT]` or `[EXTERNAL]`, none is a statement about
   * the buyer's zone, and the contract's own reason is in `last_check_note` on any check that
   * got as far as the proof before stopping.
   */
  | { kind: "DISAGREED" }
  /**
   * At least one resolver has no record at the name.
   *
   * Both saying NXDOMAIN is `[EXTERNAL]` and means the name does not exist. One saying it and
   * the other answering is `[TRANSIENT]` and means propagation is incomplete. The contract
   * separates them in its reason string; this type does not, because the drawing cannot, and
   * the note carries the distinction where it is available.
   */
  | { kind: "NAME_MISSING" }
  /**
   * A recorded `PROOF_FOUND` with no corroborated set behind it.
   *
   * `Corroboration` cannot produce that combination, so it is a shape this build did not
   * expect rather than a state the contract reaches. It is kept because printing
   * "corroborated" for it would be the one wrong thing to do, and an unexpected shape must
   * fail towards saying less.
   */
  | { kind: "UNCORROBORATED"; outcome: ProofOutcome }
  /** No check has asked the resolvers about this deal yet. */
  | { kind: "NOT_ASKED" };

/**
 * The verdict for one deal's last proof observation.
 *
 * Two properties of the order matter. Absence of a recorded outcome is tested first, so no path
 * through this function can turn a deal nobody has checked into a statement about whether the
 * buyer published anything. And `PROOF_ABSENT` is split on the record set rather than reported
 * as one thing, because the two cases it covers push a reader in opposite directions.
 */
export function proofVerdict(deal: Deal): ProofVerdict {
  const outcome = deal.last_proof_outcome;
  if (!outcome) return { kind: "NOT_ASKED" };

  const values = splitSet(deal.last_proof_values);

  if (outcome === "PROOF_NAME_MISSING") return { kind: "NAME_MISSING" };
  if (outcome === "PROOF_ABSENT") {
    // A set on chain is agreement, so a set here means the resolvers matched and the token was
    // not among what they matched on. Printing that set is the useful thing: it is what the
    // buyer published instead of what was asked for. No set means they never matched at all.
    return values.length > 0 ? { kind: "TOKEN_ABSENT", values } : { kind: "DISAGREED" };
  }
  if (outcome === "PROOF_FOUND" && values.length > 0) {
    return { kind: "CORROBORATED", values };
  }
  return { kind: "UNCORROBORATED", outcome };
}

/**
 * The sentence printed beside the panel. Written so that no two verdicts can be mistaken for
 * one another when read aloud, which is the test that matters for a screen reader.
 */
export function proofSentence(verdict: ProofVerdict): string {
  switch (verdict.kind) {
    case "CORROBORATED":
      return "Both resolvers answered, their normalised record sets matched, and the token this deal committed to was in the set.";
    case "TOKEN_ABSENT":
      return "Both resolvers answered and agreed on what is published at the name. The token this deal committed to is not among it, so the record still has to be published.";
    case "DISAGREED":
      return "The two resolvers did not agree, and neither of them said the name does not exist. Nothing follows from that about the buyer's zone: it is a fact about propagation or about a resolver, and the contract recorded it rather than treating it as a missing record.";
    case "NAME_MISSING":
      return "At least one resolver has no record at the name. Both saying so means the name does not exist; one saying so while the other answers means propagation is incomplete. Neither is a failed proof.";
    case "UNCORROBORATED":
      return `The contract recorded ${verdict.outcome} with no corroborated record set behind it. Nothing is claimed from that, because a set is what agreement looks like on chain.`;
    case "NOT_ASKED":
      return "No check has asked the resolvers about this deal. Anyone at all may run one.";
  }
}

/**
 * Whether the third seal segment can be drawn from this verdict alone.
 *
 * Only CORROBORATED counts, and only because the corroborated set is on chain. Every other
 * verdict is a reason the segment is not engraved, and none of them is a reason it is.
 */
export function proofHolds(verdict: ProofVerdict): boolean {
  return verdict.kind === "CORROBORATED";
}

/**
 * The tag the contract wrote at the front of `last_check_note` when a proof did not hold.
 *
 * `_classify_delivery` formats that note as `"<tag> <reason>"`, so the tag is recoverable
 * without a second field. Returns null when the note does not start with one, which is every
 * outcome other than AWAITING_DNS.
 *
 * The parse itself lives in `contract-types.ts` beside the taxonomy it reads, because the same
 * four tags also arrive on a receipt when `open_deal` declines, and two copies of the pattern
 * could fall out of step with each other and with the contract.
 */
export function noteTag(note: string): { tag: string; rest: string } | null {
  return taggedRefusal(note);
}
