/**
 * What each write does, who may call it, and what a refusal is called.
 *
 * Three rules hold this file together. First, a step is only listed if the source it reads can
 * be named: an unlabelled progress row is a spinner with extra characters. Second, the four
 * non-verdict outcomes are separate classes with separate words, because in this product a
 * source that did not answer and a rule that fired push money in opposite directions. Third,
 * a method's caller is not one value. `settle` belongs to the buyer until the inspection
 * window closes and to everybody afterwards, and flattening that into "buyer only" would hide
 * the mechanism that stops a buyer from sitting on a seller's money forever.
 *
 * The seven writes here are the seven the contract has. The product document lists ten and
 * describes an LLM adjudication step; the contract's header explains why the six harness-fixed
 * names are authoritative and why one dispute ground, TRANSFER_REVERSED, is left unimplemented
 * rather than approximated on evidence that cannot support it. This file follows the contract.
 */

import type { DealState, RefusalTag } from "@/lib/contract-types";

/* -------------------------------------------------------------------------- */
/* Client phases                                                              */
/* -------------------------------------------------------------------------- */

export type PhaseKey =
  | "idle"
  | "validating"
  | "wallet-pending"
  | "submitted"
  | "consensus-running"
  | "settled";

export const CLIENT_PHASES: {
  key: PhaseKey;
  label: string;
  note: string;
  /** True for the one phase that asks the wallet to sign. Named so nothing else can. */
  costsSignature: boolean;
}[] = [
  {
    key: "validating",
    label: "Checking the request here",
    note: "Refused in this browser before any signature is asked for, if it can be refused here.",
    costsSignature: false,
  },
  {
    key: "wallet-pending",
    label: "Waiting on the wallet",
    note: "The wallet is holding the transaction. Nothing has been broadcast.",
    costsSignature: true,
  },
  {
    key: "submitted",
    label: "Submitted",
    note: "The transaction has a hash and the network has it.",
    costsSignature: false,
  },
  {
    key: "consensus-running",
    label: "Validators are executing it",
    note: "Each validator fetches the sources itself. The stages below are the network's own.",
    costsSignature: false,
  },
  {
    key: "settled",
    label: "Finalized",
    note: "The leader receipt has been re-read and the returned value inspected.",
    costsSignature: false,
  },
];

/* -------------------------------------------------------------------------- */
/* The program each write runs inside consensus                               */
/* -------------------------------------------------------------------------- */

export type ProgramStep = {
  label: string;
  /** The source this step reads, by name. No row without one. */
  source: string;
  /** Set when the step is a two-resolver comparison, so it is drawn as a pair. */
  resolvers?: string[];
};

/**
 * Every fetch each write performs, in order.
 *
 * Two of the seven writes are missing from this table on purpose. `refund` and `abandon` read
 * nothing at all: they check the state and a deadline the contract already stored, move the
 * escrow, and return. A program diagram for them would be an empty diagram, and printing one
 * anyway would suggest they consult something. They do not, which is exactly why they are the
 * two that anybody can call without an argument.
 */
export const PROGRAMS: Record<string, ProgramStep[]> = {
  open_deal: [
    { label: "Normalise the domain", source: "IDNA, then the registrable-domain check" },
    { label: "Resolve the RDAP authority for this TLD", source: "IANA bootstrap, dns.json" },
    {
      label: "Refuse a TLD whose registry publishes no https base",
      source: "the bootstrap entry itself",
    },
    { label: "Take the consideration into escrow", source: "the value attached to this call" },
  ],
  arm: [
    {
      label: "Read the seller's control proof",
      source: "TXT at _conveyance-seller, the token being public",
      resolvers: ["Cloudflare", "Google"],
    },
    { label: "Resolve the RDAP authority for this TLD", source: "IANA bootstrap, dns.json" },
    { label: "Fetch the baseline registry object", source: "the registry's own RDAP base" },
    {
      label: "Freeze the baseline",
      source: "registrar id, transfer event, statuses, nameservers, digest",
    },
  ],
  check_transfer: [
    {
      label: "Re-resolve the authority and refuse a map that moved",
      source: "IANA bootstrap, dns.json, against the base stored at open",
    },
    { label: "Fetch the registry object", source: "the registry's own RDAP base" },
    { label: "Test for holds and a pending transfer", source: "the RDAP status array" },
    { label: "Compare the sponsoring registrar", source: "the baseline registrar id" },
    { label: "Compare the transfer event", source: "the latest valid transfer date in RDAP" },
    { label: "Compare the nameserver set", source: "the set the buyer committed to at open" },
    {
      label: "Read the buyer's control proof",
      source: "TXT at _conveyance-buyer, against the stored commitment",
      resolvers: ["Cloudflare", "Google"],
    },
    { label: "Record what was seen, whatever it was", source: "the deal's own check fields" },
  ],
  settle: [
    {
      label: "Re-resolve the authority and refuse a map that moved",
      source: "IANA bootstrap, dns.json, against the base stored at open",
    },
    { label: "Re-read the registry", source: "the same RDAP base, fetched again" },
    {
      label: "Re-read the buyer's control proof with the stored token",
      source: "TXT at _conveyance-buyer",
      resolvers: ["Cloudflare", "Google"],
    },
    {
      label: "Require the delivery to still hold",
      source: "the delivered registrar, and a transfer event no earlier than the delivered one",
    },
    { label: "Pay the seller", source: "the escrow held against this deal" },
  ],
  probe_domain: [
    { label: "Normalise the domain", source: "IDNA, then the registrable-domain check" },
    { label: "Resolve the RDAP authority for this TLD", source: "IANA bootstrap, dns.json" },
    { label: "Fetch the registry object", source: "the registry's own RDAP base" },
    {
      label: "Report the delegation and both proof names",
      source: "nothing is written and no value moves",
    },
  ],
};

/* -------------------------------------------------------------------------- */
/* Outcomes                                                                   */
/* -------------------------------------------------------------------------- */

export type OutcomeClass = "verdict" | "expected" | "external" | "transient" | "llm-error";

export const OUTCOMES: Record<
  Exclude<OutcomeClass, "verdict">,
  { tag: string; headline: string; body: string; register: string; retry: boolean }
> = {
  expected: {
    tag: "[EXPECTED]",
    headline: "The contract declined, on purpose",
    body: "A rule fired and held. This is the contract working, not the contract failing. Nothing was written and nothing moved.",
    register: "Refused under a rule",
    retry: false,
  },
  external: {
    tag: "[EXTERNAL]",
    headline: "A source outside the contract did not answer",
    body: "This says nothing about the transfer. An empty answer, a 404, a 403 or a 429 is a fact about a server, and it is never read as evidence that a record is absent.",
    register: "Source unavailable",
    retry: true,
  },
  transient: {
    tag: "[TRANSIENT]",
    headline: "Nothing was decided",
    body: "The round judged nothing and wrote nothing. The same call may resolve later, most often once a cache has caught up.",
    register: "Undetermined, retryable",
    retry: true,
  },
  "llm-error": {
    tag: "[LLM_ERROR]",
    headline: "A model answered in a shape the contract would not accept",
    body: "The answer was discarded rather than repaired. The escrow stays exactly where it was. This contract runs no model, so this class exists here only so that its absence from the register is checkable.",
    register: "Discarded model output",
    retry: true,
  },
};

export const TAG_TO_CLASS: Record<RefusalTag, Exclude<OutcomeClass, "verdict">> = {
  EXPECTED: "expected",
  EXTERNAL: "external",
  TRANSIENT: "transient",
  LLM_ERROR: "llm-error",
};

/**
 * Reading a thrown message into a class.
 *
 * The contract tags its own refusals, so the tag is looked for first and trusted. Only when
 * there is no tag does this fall back to reading the message, and the fallback is
 * deliberately conservative: an unclassifiable failure is transient, never a verdict,
 * because calling something a verdict is the one mistake that could move money.
 */
export function classify(message: string): OutcomeClass {
  const text = message.toLowerCase();
  if (text.includes("[expected]")) return "expected";
  if (text.includes("[external]")) return "external";
  if (text.includes("[transient]")) return "transient";
  if (text.includes("[llm_error]")) return "llm-error";
  if (text.includes("user rejected") || text.includes("user denied")) return "expected";
  if (
    text.includes("429") ||
    text.includes("rate limit") ||
    text.includes("fetch failed") ||
    text.includes("network")
  ) {
    return "external";
  }
  return "transient";
}

/* -------------------------------------------------------------------------- */
/* Who may call what, and from where                                          */
/* -------------------------------------------------------------------------- */

export type Caller = "anyone" | "buyer" | "seller" | "either-party";

/**
 * Every time-based transition in this contract is permissionless, because no cron exists on
 * a chain. A deadline does not fire; somebody presses a button after it passes. That is not
 * a footnote, it is how the product works, so the caller is printed on every control.
 */
export const CALLER_TEXT: Record<Caller, { label: string; note: string }> = {
  anyone: {
    label: "Anyone may call this",
    note: "No cron exists on a chain, so a deadline does not fire by itself. Any address can press this, including one that is neither buyer nor seller, and the outcome is the same whoever does.",
  },
  buyer: {
    label: "Buyer only",
    note: "The contract checks the sender against the deal's buyer and refuses anyone else.",
  },
  seller: {
    label: "Seller only",
    note: "The contract checks the sender against the deal's seller and refuses anyone else.",
  },
  "either-party": {
    label: "Buyer or seller",
    note: "The contract accepts either named party and refuses a third address.",
  },
};

/** The deadline field a door waits on, or null for a door that is open at once. */
export type DeadlineField = "accept_deadline" | "transfer_deadline" | "inspection_deadline";

/** What each deadline is called on a control, so a door can name the window it waits on. */
export const DEADLINE_TEXT: Record<DeadlineField, string> = {
  accept_deadline: "the window for the seller to accept",
  transfer_deadline: "the window for the transfer to be executed",
  inspection_deadline: "the window for the buyer to inspect",
};

/**
 * One way into a method: a state it can be called from, by whom, and from when.
 *
 * A method is a set of these rather than a single rule, because that is what the contract's
 * guards actually are. `refund` has three doors out of three different states with three
 * different conditions, and a control that printed one rule for it would be wrong two thirds
 * of the time.
 */
export type Door = {
  from: DealState;
  caller: Caller;
  /** When set, this door is shut until the named deadline has passed. */
  after?: DeadlineField;
  /** When set, the door opens to `anyone` once the deadline passes, not just to `caller`. */
  widensAfter?: DeadlineField;
  /** Why the rule is this rule. Printed on the control, not kept for the docs page. */
  because: string;
};

export type MethodSpec = {
  name: string;
  /** The imperative on the button. Not the method name, which is printed beside it. */
  action: string;
  /** One line on what it does to the deal, in the register's voice. */
  effect: string;
  payable: boolean;
  /**
   * True when the method moves escrow. Four of the seven do, and the asymmetry is the point:
   * one takes value in and three pay it out, which is why `payable` and this are separate
   * fields rather than one.
   *
   * The contract has five value sites to match, not four, and the fifth is the interesting one.
   * `gl.message.value` is read twice in `open_deal`: once to record the escrow, and once to hand
   * it straight back when the call is refused. That second read is there because a revert on this
   * chain rolls storage back but keeps the value that arrived, so the one payable method has to
   * refuse by returning. The other three sites are the `_pay` calls in `settle`, `refund` and
   * `abandon`, which pay out an escrow the contract is already holding.
   */
  movesValue: boolean;
  doors: Door[];
};

/**
 * The seven writes, with the contract's own guards.
 *
 * Read the `because` lines together and the asymmetries stop looking arbitrary. The buyer can
 * abandon from OFFERED but not from LOCKED, because after arming there may be a transfer in
 * flight that the buyer could let complete and then walk away from. The seller can never
 * refund, and never needs to, because every refund destination is the buyer. And `settle`
 * widens to anyone rather than moving to the seller, because a rule that named the seller
 * would still let a buyer stall a seller who had lost their key.
 */
export const METHODS: Record<string, MethodSpec> = {
  open_deal: {
    name: "open_deal",
    action: "Lodge the offer",
    effect: "Creates the deal and takes the consideration into escrow.",
    payable: true,
    movesValue: true,
    doors: [
      {
        from: "OFFERED",
        caller: "anyone",
        because:
          "Whoever sends the call becomes the buyer, so there is no earlier party to check them against.",
      },
    ],
  },
  arm: {
    name: "arm",
    action: "Accept and prove control",
    effect: "Moves the deal to Locked and freezes the registry baseline.",
    payable: false,
    movesValue: false,
    doors: [
      {
        from: "OFFERED",
        caller: "seller",
        because:
          "Acceptance is the proof of control. A named seller who cannot publish a TXT record at the domain has no operational relationship with it, so the two steps are one call rather than two.",
      },
    ],
  },
  check_transfer: {
    name: "check_transfer",
    action: "Run a check",
    effect: "Reads the registry and both resolvers and writes down what they said.",
    payable: false,
    movesValue: false,
    doors: [
      {
        from: "LOCKED",
        caller: "anyone",
        because:
          "Permissionless so that a buyer cannot withhold a check and run the seller into the transfer deadline. The token is public by the time it matters.",
      },
      {
        from: "VERIFIED",
        caller: "anyone",
        because:
          "The same call from Verified reads the same two sources and records what they say, but delivery is final by then, so nothing it observes moves the deal.",
      },
    ],
  },
  settle: {
    name: "settle",
    action: "Release to the seller",
    effect: "Re-verifies the delivery, then pays the seller.",
    payable: false,
    movesValue: true,
    doors: [
      {
        from: "VERIFIED",
        caller: "buyer",
        widensAfter: "inspection_deadline",
        because:
          "The buyer may accept at once. Once the inspection window closes anyone may press it, so a buyer who goes quiet cannot hold a delivered domain's price indefinitely.",
      },
    ],
  },
  refund: {
    name: "refund",
    action: "Return to the buyer",
    effect: "Returns the escrow to the buyer and closes the deal.",
    payable: false,
    movesValue: true,
    doors: [
      {
        from: "OFFERED",
        caller: "anyone",
        after: "accept_deadline",
        because:
          "The seller did not accept in the window. The destination is the buyer whoever presses it, so restricting the caller would only add a way to get stuck.",
      },
      {
        from: "LOCKED",
        caller: "anyone",
        after: "transfer_deadline",
        because:
          "The transfer window closed without a check ever observing the delivery. This is the buyer's exit, and anyone may take it for them.",
      },
    ],
  },
  abandon: {
    name: "abandon",
    action: "Give the deal up",
    effect: "Closes the deal and returns the escrow to the buyer.",
    payable: false,
    movesValue: true,
    doors: [
      {
        from: "OFFERED",
        caller: "either-party",
        because:
          "Nothing has been proved and nothing is in flight, so either party may walk away without waiting for a window.",
      },
      {
        from: "LOCKED",
        caller: "seller",
        because:
          "Seller only, because a transfer may be in flight. A buyer who could cancel at will could let the transfer complete and then take the price back with the domain already moved.",
      },
    ],
  },
  probe_domain: {
    name: "probe_domain",
    action: "Probe the domain",
    effect: "Fetches the registry object and reports it. Writes nothing and moves no value.",
    payable: false,
    movesValue: false,
    doors: [
      {
        from: "OFFERED",
        caller: "anyone",
        because:
          "It touches no deal. It is a write rather than a view only because it fetches, and a view that fetches has no consensus behind its answer.",
      },
    ],
  },
};

/** The doors into a method from one state, which is what a control on a deal page needs. */
export function doorsFrom(method: string, state: DealState): Door[] {
  return METHODS[method]?.doors.filter((door) => door.from === state) ?? [];
}

/** Every method that has at least one door out of this state, in register order. */
export const METHODS_BY_STATE: Record<DealState, string[]> = {
  OFFERED: ["arm", "abandon", "refund"],
  LOCKED: ["check_transfer", "abandon", "refund"],
  VERIFIED: ["settle", "check_transfer"],
  RELEASED: [],
  REFUNDED: [],
};
