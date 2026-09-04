/**
 * The shapes the contract actually returns, and the words this interface prints for them.
 *
 * Every type below mirrors one dict in `contracts/Conveyance.py`, field for field, and every
 * field is a string because that is what GenVM storage and the view methods hand back. Where
 * the contract joins a set with commas, the type says so and the splitting happens here rather
 * than being guessed at in a component.
 *
 * THE CONTRACT IS THE SPECIFICATION. Its header documents a deliberate divergence from the
 * product document: ten methods become six, and the four-ground LLM dispute step is replaced by
 * fields the contract reads directly from RDAP or a TXT record for three of the four grounds. A
 * model would have been asked to opine on facts the contract can read, which the house rule for
 * this project forbids. The fourth ground, `TRANSFER_REVERSED`, is left unimplemented rather
 * than approximated: RDAP names a sponsoring registrar and never an account, so no signal this
 * contract can read distinguishes a real reversal from a buyer moving their own delivered
 * domain around, and once VERIFIED, delivery is final. This file follows the contract, not the
 * document, because the contract is what gets deployed and what a reader can check.
 */

/* -------------------------------------------------------------------------- */
/* Consensus and the transaction rail                                         */
/* -------------------------------------------------------------------------- */

export type TxStage =
  | "UNINITIALIZED"
  | "PENDING"
  | "PROPOSING"
  | "COMMITTING"
  | "REVEALING"
  | "ACCEPTED"
  | "READY_TO_FINALIZE"
  | "APPEAL_COMMITTING"
  | "APPEAL_REVEALING"
  | "FINALIZED"
  | "UNDETERMINED"
  | "VALIDATORS_TIMEOUT"
  | "LEADER_TIMEOUT"
  | "CANCELED";

/** The stages that are progress. The rail draws one bar for each, always all six. */
export const CONSENSUS_STAGES: TxStage[] = [
  "PENDING",
  "PROPOSING",
  "COMMITTING",
  "REVEALING",
  "ACCEPTED",
  "FINALIZED",
];

/**
 * Three stages mean nothing was decided.
 *
 * They are not failures and must never be printed as one. Nothing was written, no value
 * moved, and sending the same call again is the correct response, which is the opposite of
 * what to do about a contract that refused.
 */
export const RETRYABLE_STAGES = new Set<TxStage>([
  "UNDETERMINED",
  "VALIDATORS_TIMEOUT",
  "LEADER_TIMEOUT",
]);

export const STAGE_TEXT: Record<TxStage, string> = {
  UNINITIALIZED: "not yet submitted",
  PENDING: "submitted, waiting for a leader",
  PROPOSING: "the leader is executing the contract",
  COMMITTING: "validators are committing their results",
  REVEALING: "validators are revealing their results",
  ACCEPTED: "accepted, waiting for finality",
  READY_TO_FINALIZE: "ready to finalize",
  APPEAL_COMMITTING: "an appeal round is committing",
  APPEAL_REVEALING: "an appeal round is revealing",
  FINALIZED: "finalized",
  UNDETERMINED: "no determination was reached. Retryable, and nothing was decided",
  VALIDATORS_TIMEOUT: "validators timed out. Retryable, and nothing was decided",
  LEADER_TIMEOUT: "the leader timed out. Retryable, and nothing was decided",
  CANCELED: "canceled before execution",
};

export type StoredTransaction = {
  hash: string;
  label: string;
  createdAt: string;
  status: TxStage;
  executionResult?: "SUCCESS" | "ROLLBACK" | "ERROR" | "UNKNOWN";
  executionError?: string;
  /** The contract method, so a row can be read without decoding the label. */
  functionName?: string;
  /** The deal this write belongs to, when it belongs to one. Links the rail to the page. */
  dealId?: string;
  /**
   * A payable call can finalize with GenVM SUCCESS while having refused and refunded, by
   * returning a tagged string. Kept separately from `executionResult` for exactly that
   * reason: the network succeeded and the contract declined, and both are true at once.
   */
  refusal?: string;
};

/* -------------------------------------------------------------------------- */
/* The error taxonomy                                                         */
/* -------------------------------------------------------------------------- */

export type RefusalTag = "EXPECTED" | "EXTERNAL" | "TRANSIENT" | "LLM_ERROR";

export const REFUSAL_TAG_TEXT: Record<RefusalTag, { tag: string; means: string }> = {
  EXPECTED: {
    tag: "[EXPECTED]",
    means: "The contract declined on purpose. A rule fired and it held.",
  },
  EXTERNAL: {
    tag: "[EXTERNAL]",
    means: "A source outside the contract did not answer. Nothing was learned in either direction.",
  },
  TRANSIENT: {
    tag: "[TRANSIENT]",
    means: "Nothing was decided and nothing was written. The same call may resolve later.",
  },
  LLM_ERROR: {
    tag: "[LLM_ERROR]",
    means:
      "A model answered in a shape the contract would not accept. This contract runs no model, so this tag is carried only so its absence is visible.",
  },
};

/** The four, in the order the documentation lists them and the contract declares them. */
export const REFUSAL_TAGS = ["EXPECTED", "EXTERNAL", "TRANSIENT", "LLM_ERROR"] as const;

/**
 * A tagged line split into its tag and the words after it, or null when it carries no tag.
 *
 * One regex, in the module that owns the taxonomy, because there are three places that need this
 * and they must not drift: a stored check note, a stored proof note, and the reason a refused
 * `open_deal` returns on its receipt. A second copy of this pattern that fell a tag behind would
 * read a real refusal as an ordinary answer, which is the one misreading with money attached.
 *
 * Anchored, deliberately. `[EXPECTED]` quoted in the middle of a sentence is a sentence about a
 * refusal and not a refusal, and the difference matters because the contract writes its tag first
 * or not at all.
 */
export function taggedRefusal(line: string): { tag: RefusalTag; rest: string } | null {
  const match = /^\[(EXPECTED|EXTERNAL|TRANSIENT|LLM_ERROR)\]\s*/.exec(line);
  if (!match) return null;
  return { tag: match[1] as RefusalTag, rest: line.slice(match[0].length) };
}

/* -------------------------------------------------------------------------- */
/* The deal                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Five states. OFFERED to LOCKED to VERIFIED to RELEASED is the path a completed sale takes;
 * REFUNDED is the other way it ends.
 *
 * A deal never returns to an earlier state, which is what makes a state name safe to print
 * beside a sum of money. VERIFIED is final: an earlier contract version had a sixth state,
 * REVERSED, reached by a backwards transition out of VERIFIED when the registry looked like it
 * had taken a transfer back. It was removed, because RDAP names a sponsoring registrar and
 * never an account, so that signal could not actually be told apart from a buyer moving their
 * own delivered domain around for reasons that have nothing to do with the deal. See
 * `_check_from_verified` in the contract for the fuller reasoning.
 */
export type DealState = "OFFERED" | "LOCKED" | "VERIFIED" | "RELEASED" | "REFUNDED";

export const DEAL_STATES: DealState[] = [
  "OFFERED",
  "LOCKED",
  "VERIFIED",
  "RELEASED",
  "REFUNDED",
];

/** The states in which the contract is still holding somebody's money. */
export const LIVE_STATES: DealState[] = ["OFFERED", "LOCKED", "VERIFIED"];

/**
 * Every state gets a word, never only a colour. `register` is the conveyancing-register
 * phrasing used in prose; `holds` states plainly where the money is, because that is the
 * question a reader actually has.
 */
export const DEAL_STATE_TEXT: Record<DealState, { label: string; register: string; holds: string }> =
  {
    OFFERED: {
      label: "Offered",
      register: "Escrow lodged, awaiting the seller's proof of control",
      holds:
        "The consideration is in escrow. Either party may abandon the deal and return it to the buyer, and once the acceptance window closes anyone at all may.",
    },
    LOCKED: {
      label: "Locked",
      register: "Seller proved control, transfer outstanding",
      holds:
        "The consideration is in escrow. Only the seller may give the deal up from here, because a transfer may be in flight. The buyer's exit is the transfer deadline, which anyone may enforce.",
    },
    VERIFIED: {
      label: "Verified",
      register: "Transfer and control observed in the registry and the zone",
      holds:
        "The consideration is in escrow. The buyer may release it at once; anyone may once the inspection window closes. Verified delivery is final: no later check moves this deal anywhere, and no refund route runs from here.",
    },
    RELEASED: {
      label: "Released",
      register: "Consideration paid to the seller",
      holds: "The consideration has been paid to the seller. This deal is closed.",
    },
    REFUNDED: {
      label: "Refunded",
      register: "Escrow discharged, consideration returned",
      holds: "The consideration has been returned to the buyer. This deal is closed.",
    },
  };

/**
 * What the last check saw, in the contract's own words.
 *
 * `_classify_delivery` is ordered and total: it returns the furthest condition that did not
 * hold, so any outcome later in this list implies every earlier condition held at that check.
 * That property is what lets a three-segment seal be drawn from one recorded string without
 * this interface re-deriving anything the contract decided.
 *
 * The empty string is a real value and means no check has ever run against the deal.
 */
export type CheckOutcome =
  | ""
  | "SUSPENDED"
  | "PENDING_TRANSFER"
  | "AWAITING_TRANSFER"
  | "AWAITING_DELEGATION"
  | "AWAITING_DNS"
  | "VERIFIED";

/** The contract's classification order. Position in this array is the whole inference. */
export const CHECK_ORDER: CheckOutcome[] = [
  "SUSPENDED",
  "PENDING_TRANSFER",
  "AWAITING_TRANSFER",
  "AWAITING_DELEGATION",
  "AWAITING_DNS",
  "VERIFIED",
];

export const CHECK_OUTCOME_TEXT: Record<CheckOutcome, { label: string; means: string }> = {
  "": {
    label: "Not checked",
    means:
      "No check has been run against this deal. Nothing has been observed and nothing is claimed in either direction.",
  },
  SUSPENDED: {
    label: "Suspended",
    means:
      "The registry reports a hold or a pending deletion. A held domain is not delivered whoever holds it, so nothing further was examined.",
  },
  PENDING_TRANSFER: {
    label: "Transfer in flight",
    means:
      "The registry reports a pending transfer. This is neither a failure nor a delivery, and the contract refuses to read it as either. The deadline keeps running.",
  },
  AWAITING_TRANSFER: {
    label: "Awaiting the transfer",
    means:
      "Either the sponsoring registrar is not the one this deal names, or the registry has published no transfer event later than the one recorded when the deal opened.",
  },
  AWAITING_DELEGATION: {
    label: "Awaiting the delegation",
    means:
      "The registration moved to the target registrar, and the nameserver set the registry publishes is not the set this deal named.",
  },
  AWAITING_DNS: {
    label: "Awaiting the buyer's control proof",
    means:
      "The registry side is complete. The buyer's deal-bound TXT record did not resolve at both resolvers with both agreeing.",
  },
  VERIFIED: {
    label: "Verified",
    means:
      "The registry reports the transfer to the named registrar, the delegation matches, and both resolvers saw the buyer's control proof and agreed on it. Once reached, this outcome is final.",
  },
};

/** The three values `classify_proof` can reach, as the contract records them. */
export type ProofOutcome = "" | "PROOF_FOUND" | "PROOF_ABSENT" | "PROOF_NAME_MISSING";

export const PROOF_OUTCOME_TEXT: Record<ProofOutcome, { label: string; means: string }> = {
  "": {
    label: "not asked",
    means: "No check has asked the resolvers about this name yet.",
  },
  PROOF_FOUND: {
    label: "found at both resolvers",
    means:
      "Both resolvers answered, their normalised record sets agreed, and the expected token was in the set.",
  },
  PROOF_ABSENT: {
    label: "not corroborated at the expected token",
    means:
      "Either the two resolvers agreed and the expected token was not among the records they agreed on, or they did not agree at all and neither said the name is missing. `last_proof_values` separates the two: a set on chain is what agreement looks like. Only the first case is the buyer's step to take.",
  },
  PROOF_NAME_MISSING: {
    label: "no record at the name",
    means:
      "At least one resolver has no record at the name. Both saying so means the name does not exist. One saying so while the other answers means propagation is incomplete, which is not a failed proof in either direction.",
  },
};

/**
 * One deal, exactly as `get_deal()` returns it.
 *
 * Every value is a string, including the numbers and the booleans, because that is what the
 * contract hands back and coercing it here rather than at the edge would hide which fields
 * are the contract's and which are this interface's. `nameservers` and `statuses` fields are
 * comma-joined sets, canonicalised by the contract, and `splitSet` in `format.ts` is the only
 * place they are taken apart.
 */
export type Deal = {
  deal_id: string;
  state: DealState;
  buyer: string;
  seller: string;
  domain: string;
  tld: string;
  rdap_base: string;

  /** What the buyer required. The observed snapshot is compared against these two. */
  target_registrar_id: string;
  /** Comma-joined, sorted, lowercased, de-duplicated. */
  target_nameservers: string;

  /** The seller proves control by publishing this name with this token. No secret in it. */
  seller_proof_name: string;
  seller_proof_token: string;
  /** The buyer's name is known from the start; the token is committed to and revealed later. */
  buyer_proof_name: string;
  buyer_proof_commitment: string;
  /** "True" once a successful check has stored the revealed token. */
  buyer_proof_revealed: string;

  /** wei, as a decimal string. */
  escrow: string;

  opened_at: string;
  accept_deadline: string;
  armed_at: string;
  transfer_deadline: string;
  verified_at: string;
  inspection_deadline: string;
  closed_at: string;

  /** The registry's answer frozen when the seller armed. Everything is measured against it. */
  baseline_registrar_id: string;
  baseline_registrar_name: string;
  baseline_nameservers: string;
  baseline_statuses: string;
  baseline_transfer_at: string;
  baseline_last_changed_at: string;
  baseline_digest: string;
  baseline_client_transfer_locked: string;

  /** Every check writes here, whatever it saw. A decimal count, not a boolean. */
  checks: string;
  last_check_at: string;
  last_check_outcome: CheckOutcome;
  last_check_note: string;
  last_check_registrar_id: string;
  last_check_nameservers: string;
  last_check_statuses: string;
  last_check_transfer_at: string;
  last_check_digest: string;
  last_proof_outcome: ProofOutcome;
  last_proof_values: string;

  /** Frozen at the check that reached VERIFIED. Distinct from the last check's fields. */
  delivered_registrar_id: string;
  delivered_transfer_at: string;
  delivered_digest: string;
  delivered_proof_digest: string;

  paid_to_seller: string;
  returned_to_buyer: string;
};

/** The seven fields `list_deals()` returns. Deliberately not a whole deal. */
export type DealSummary = {
  deal_id: string;
  state: DealState;
  domain: string;
  escrow: string;
  target_registrar_id: string;
  last_check_outcome: CheckOutcome;
  last_check_at: string;
};

/** Every deal carries its own summary, so one row type reads either. */
export function summarise(deal: Deal): DealSummary {
  return {
    deal_id: deal.deal_id,
    state: deal.state,
    domain: deal.domain,
    escrow: deal.escrow,
    target_registrar_id: deal.target_registrar_id,
    last_check_outcome: deal.last_check_outcome,
    last_check_at: deal.last_check_at,
  };
}

/* -------------------------------------------------------------------------- */
/* The registry snapshot, as a pair of columns                                */
/* -------------------------------------------------------------------------- */

/**
 * One RDAP observation in the shape the diff prints.
 *
 * The baseline and the last check are the same shape on purpose. The whole delivery question
 * is a diff between them, and a diff is only readable if both sides sit in the same columns.
 */
export type RegistrySnapshot = {
  when: string;
  registrar_id: string;
  registrar_name: string;
  nameservers: string;
  statuses: string;
  transfer_at: string;
  digest: string;
};

export function baselineSnapshot(deal: Deal): RegistrySnapshot {
  return {
    when: deal.armed_at,
    registrar_id: deal.baseline_registrar_id,
    registrar_name: deal.baseline_registrar_name,
    nameservers: deal.baseline_nameservers,
    statuses: deal.baseline_statuses,
    transfer_at: deal.baseline_transfer_at,
    digest: deal.baseline_digest,
  };
}

/**
 * The last check, which is not the same thing as the delivered snapshot.
 *
 * A deal that verified and then reversed has a delivered snapshot from the check that
 * verified and a last-check snapshot from the one that found the reversal, and printing
 * either as "the current state" would be a different claim from the other.
 */
export function observedSnapshot(deal: Deal): RegistrySnapshot {
  return {
    when: deal.last_check_at,
    registrar_id: deal.last_check_registrar_id,
    // The contract does not carry a registrar name per check, only on the baseline. Left
    // empty rather than reusing the baseline's, which would be a claim about the wrong party.
    registrar_name: "",
    nameservers: deal.last_check_nameservers,
    statuses: deal.last_check_statuses,
    transfer_at: deal.last_check_transfer_at,
    digest: deal.last_check_digest,
  };
}

/* -------------------------------------------------------------------------- */
/* probe_domain                                                               */
/* -------------------------------------------------------------------------- */

/**
 * What `probe_domain()` returns. A write method because it fetches, and a view that fetches
 * has no consensus behind it.
 *
 * This exists so a buyer does not open a deal that can never verify. `open_deal` compares the
 * observed delegation to the buyer's target set for exact string equality, so the form is
 * filled from this answer rather than from anything typed by hand.
 */
export type Probe = {
  domain: string;
  rdap_base: string;
  registrar_iana_id: string;
  registrar_name: string;
  nameservers: string;
  statuses: string;
  registration_at: string;
  expiration_at: string;
  last_changed_at: string;
  transfer_at: string;
  /** "True" or "False", as the contract stringifies a Python bool. */
  transfer_locked: string;
  transfer_lock_setters: string;
  pending_transfer: string;
  digest: string;
  seller_proof_name: string;
  buyer_proof_name: string;
  /** "True" when the domain is neither held nor mid-transfer. Not a promise about anything. */
  escrowable: string;
};

/** The contract stringifies Python bools as "True" and "False". Nothing else counts. */
export function isTrue(value: string): boolean {
  return value === "True" || value === "true";
}

/* -------------------------------------------------------------------------- */
/* ledger() and parameters()                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Escrow conservation, checkable by addition.
 *
 * `held` is computed by the contract from its own counters and `balance` is read from the
 * contract's balance. The two disagreeing is the shape a value bug would take, so both are
 * printed and the difference is stated rather than hidden behind whichever one looks better.
 */
export type Ledger = {
  total_escrowed: string;
  total_released: string;
  total_refunded: string;
  held: string;
  balance: string;
  deals_opened: string;
  checks_run: string;
  deliveries_verified: string;
  /** "0". There is no protocol fee, and the field exists so its absence is checkable. */
  protocol_fee: string;
};

/** Every constant a caller's decision depends on, read from the chain rather than assumed. */
export type Parameters = {
  iana_bootstrap_url: string;
  seller_proof_label: string;
  buyer_proof_label: string;
  proof_version: string;
  accept_window_seconds: string;
  transfer_window_seconds: string;
  inspection_window_seconds: string;
  check_interval_seconds: string;
  max_deal_value_wei: string;
  min_nameservers: string;
  max_nameservers: string;
  /** Comma-joined resolver names. Two, always both, never one. */
  resolvers: string;
  embedded_function_count: string;
  /** "false". The contract runs no model and says so in a field a reader can check. */
  uses_a_model: string;
  boundary: string;
};

/* -------------------------------------------------------------------------- */
/* The three conditions the seal engraves                                     */
/* -------------------------------------------------------------------------- */

/**
 * The contract asks six ordered questions. They group into three that a person actually holds
 * in their head, and the grouping is not a simplification: each group is contiguous in the
 * contract's own order, and each group reads exactly one kind of source. The line between the
 * segments is a line the evidence already draws.
 *
 *   deliverable  holds, pending deletion, pending transfer         RDAP status fields
 *   transferred  sponsoring registrar, transfer event, delegation  the rest of the RDAP object
 *   controlled   the buyer's TXT proof at two agreeing resolvers   DNS over HTTPS, twice
 *
 * Two of the six blocking outcomes land in the middle group, so the seal alone cannot say
 * which of them fired. That is why the legend prints the contract's own recorded note beside
 * the segment rather than only the segment's word: the drawing carries the shape of the
 * problem and the note carries its name.
 */
export type ConditionKey = "deliverable" | "transferred" | "controlled";

export const CONDITION_KEYS: ConditionKey[] = ["deliverable", "transferred", "controlled"];

export const CONDITION_TEXT: Record<
  ConditionKey,
  { ordinal: string; label: string; asks: string; source: string }
> = {
  deliverable: {
    ordinal: "First",
    label: "The domain can be delivered at all",
    asks: "Is the registration free of holds and pending deletion, and is no transfer mid-flight?",
    source: "The authoritative RDAP base named for this TLD by the IANA bootstrap",
  },
  transferred: {
    ordinal: "Second",
    label: "The registration moved to the named party",
    asks:
      "Is the sponsoring registrar the one this deal names, has the registry published a transfer event later than the baseline, and does it publish the nameserver set the deal named?",
    source: "The same RDAP object, compared against the baseline frozen when the seller armed",
  },
  controlled: {
    ordinal: "Third",
    label: "The buyer controls the zone",
    asks:
      "Does the buyer's deal-bound TXT record resolve at two independent resolvers, with both agreeing on the record set?",
    source: "Cloudflare and Google DNS over HTTPS, and the escrow moves only if the two agree",
  },
};

/**
 * What is known about one condition after the last check.
 *
 * Five values rather than three, because "the check stopped before this question" and "this
 * question was answered no" are different facts and only one of them says anything about the
 * transfer. Collapsing them is how an interface ends up telling a seller their delegation is
 * wrong when nothing ever looked at it.
 */
export type ConditionOutcome = "MET" | "BLOCKING" | "NOT_REACHED" | "UNCHECKED";

export const CONDITION_OUTCOME_WORD: Record<ConditionOutcome, string> = {
  MET: "engraved",
  BLOCKING: "not yet",
  NOT_REACHED: "not reached",
  UNCHECKED: "unchecked",
};

export const CONDITION_OUTCOME_NOTE: Record<ConditionOutcome, string> = {
  MET: "The sources were read and this condition held.",
  BLOCKING: "The sources were read and this is the condition they stopped at.",
  NOT_REACHED:
    "The check stopped at an earlier condition, so the delivery decision did not rest on this one. Nothing drawn here is a claim about it in either direction.",
  UNCHECKED: "No check has run against this deal, so nothing has been read about this condition.",
};
