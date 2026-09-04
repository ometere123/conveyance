/**
 * Live reads, in the shapes the pages already consume.
 *
 * This is the other half of the one-file swap. `data-source.ts` decides whether a page gets
 * a fixture or one of these; nothing else in the app knows which it got. Every function here
 * returns the same `ReadResult` union the fixtures do, so a rate-limited endpoint and a
 * missing deal arrive as different values rather than as the same empty object.
 *
 * Two shapes of emptiness matter and are kept apart. `get_deal` and `delivery_status` return
 * `{}` for a deal that does not exist, which is NOT_FOUND, a fact about the register. A read
 * that threw is UNAVAILABLE, a fact about the network. Only the first one is safe to print as
 * "no such deal".
 *
 * THAT RULE WAS STATED HERE AND THEN BROKEN, AND IT IS WORTH SAYING HOW. This file used to call
 * `readMaybe`, a helper that catches five classes of RPC failure and returns `undefined` for all
 * of them: a raising contract, a malformed call, a rate limit, an exhausted connection pool, and
 * a response body that is not JSON. `view` then mapped `undefined` to NOT_FOUND. So a
 * rate-limited node made the register print "The contract has no register of deals under that
 * identifier. Nothing is missing and nothing failed." That sentence was false in every word that
 * mattered: something had failed, and the read it was said about was `list_deals`, which takes no
 * identifier. It was found by a Playwright run that went live for the first time, and the page it
 * appeared on was the register.
 *
 * The correction is that this file no longer swallows anything. Every failure reaches the catch
 * below and arrives at the reader as UNAVAILABLE with the node's own message. NOT_FOUND now has
 * exactly one source, the empty dict, and that was measured rather than assumed: against the
 * deployed contract, `get_deal cv-e2e-was-never-lodged` and `delivery_status
 * never-lodged.example` both answer `{}` and neither raises.
 *
 * Nothing under `lib/genlayer/` is modified by this file. It is a consumer of that layer.
 */

import type {
  CheckOutcome,
  Deal,
  DealState,
  Ledger,
  Parameters,
  Probe,
  ProofOutcome,
} from "@/lib/contract-types";
import { CHECK_OUTCOME_TEXT, DEAL_STATES } from "@/lib/contract-types";
import { CONTRACT_ADDRESS } from "@/lib/genlayer/config";
import { createReadClient } from "@/lib/genlayer/read-client";
import {
  available,
  invalidResponse,
  isRecord,
  notFound,
  unavailable,
  type ReadResult,
} from "@/lib/genlayer/read-result";

/* -------------------------------------------------------------------------- */
/* The one view call                                                          */
/* -------------------------------------------------------------------------- */

async function view<T>(
  functionName: string,
  args: unknown[],
  shape: (raw: unknown) => T | null,
): Promise<ReadResult<T>> {
  // Copied to a local before the guard on purpose. `CONTRACT_ADDRESS` is an imported binding,
  // so the narrowing the guard performs is discarded again inside the callback below, and the
  // address would arrive there as possibly undefined.
  const address = CONTRACT_ADDRESS;
  if (!address) {
    return unavailable("No deployed contract address is configured for this build.");
  }
  try {
    const client = createReadClient();
    const raw = await client.readContract({
      address,
      functionName,
      args: args as never,
    });

    // `get_deal` and `delivery_status` answer `{}` for a record the register does not carry, and
    // that is the only not-found this file can produce. Nothing else here returns a bare record:
    // the two counters answer with populated dicts and `list_deals` answers with a list, which
    // `isRecord` excludes. A no-argument view could not be a not-found in any case, because there
    // is no identifier for the register to be missing.
    if (isRecord(raw) && Object.keys(raw).length === 0) return notFound();

    const value = shape(raw);
    if (value === null) {
      return invalidResponse(
        `${functionName} answered in a shape this build does not recognise. Nothing was read from it.`,
      );
    }
    return available(value);
  } catch (error) {
    return unavailable(error);
  }
}

/* -------------------------------------------------------------------------- */
/* Coercion                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Every scalar becomes a string and nothing is parsed into a number.
 *
 * A u256 sum that does not fit a JS number must not be rounded on the way in, and the one
 * reliable way to guarantee that is for no number to exist on this path at all. The contract
 * stringifies its own booleans as "True" and "False", which `isTrue` in `contract-types.ts`
 * is the only reader of.
 */
function str(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "bigint" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

const STATES = new Set<string>(DEAL_STATES);
const OUTCOMES = new Set<string>(Object.keys(CHECK_OUTCOME_TEXT));
const PROOF_OUTCOMES = new Set<string>([
  "",
  "PROOF_FOUND",
  "PROOF_ABSENT",
  "PROOF_NAME_MISSING",
]);

/**
 * An unrecognised check outcome becomes the empty string, which the seal reads as UNCHECKED.
 *
 * Failing to "nothing has been observed" is the only safe direction. Any other default would
 * have this build assert something about a domain transfer on the strength of a string it did
 * not understand.
 */
function outcome(value: unknown): CheckOutcome {
  const text = str(value);
  return (OUTCOMES.has(text) ? text : "") as CheckOutcome;
}

function proofOutcome(value: unknown): ProofOutcome {
  const text = str(value);
  return (PROOF_OUTCOMES.has(text) ? text : "") as ProofOutcome;
}

/* -------------------------------------------------------------------------- */
/* Shapes                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * `get_deal` returns `{}` for a deal that is not in the register, so an empty object is the
 * contract's way of saying not-found and is passed through as one rather than coerced into a
 * deal with every field blank.
 */
function toDeal(raw: unknown): Deal | null {
  if (!isRecord(raw)) return null;
  const deal_id = str(raw.deal_id);
  const state = str(raw.state);
  if (!deal_id || !STATES.has(state)) return null;
  return {
    deal_id,
    state: state as DealState,
    buyer: str(raw.buyer),
    seller: str(raw.seller),
    domain: str(raw.domain),
    tld: str(raw.tld),
    rdap_base: str(raw.rdap_base),

    target_registrar_id: str(raw.target_registrar_id),
    target_nameservers: str(raw.target_nameservers),

    seller_proof_name: str(raw.seller_proof_name),
    seller_proof_token: str(raw.seller_proof_token),
    buyer_proof_name: str(raw.buyer_proof_name),
    buyer_proof_commitment: str(raw.buyer_proof_commitment),
    buyer_proof_revealed: str(raw.buyer_proof_revealed),

    escrow: str(raw.escrow),

    opened_at: str(raw.opened_at),
    accept_deadline: str(raw.accept_deadline),
    armed_at: str(raw.armed_at),
    transfer_deadline: str(raw.transfer_deadline),
    verified_at: str(raw.verified_at),
    inspection_deadline: str(raw.inspection_deadline),
    closed_at: str(raw.closed_at),

    baseline_registrar_id: str(raw.baseline_registrar_id),
    baseline_registrar_name: str(raw.baseline_registrar_name),
    baseline_nameservers: str(raw.baseline_nameservers),
    baseline_statuses: str(raw.baseline_statuses),
    baseline_transfer_at: str(raw.baseline_transfer_at),
    baseline_last_changed_at: str(raw.baseline_last_changed_at),
    baseline_digest: str(raw.baseline_digest),
    baseline_client_transfer_locked: str(raw.baseline_client_transfer_locked),

    checks: str(raw.checks),
    last_check_at: str(raw.last_check_at),
    last_check_outcome: outcome(raw.last_check_outcome),
    last_check_note: str(raw.last_check_note),
    last_check_registrar_id: str(raw.last_check_registrar_id),
    last_check_nameservers: str(raw.last_check_nameservers),
    last_check_statuses: str(raw.last_check_statuses),
    last_check_transfer_at: str(raw.last_check_transfer_at),
    last_check_digest: str(raw.last_check_digest),
    last_proof_outcome: proofOutcome(raw.last_proof_outcome),
    last_proof_values: str(raw.last_proof_values),

    delivered_registrar_id: str(raw.delivered_registrar_id),
    delivered_transfer_at: str(raw.delivered_transfer_at),
    delivered_digest: str(raw.delivered_digest),
    delivered_proof_digest: str(raw.delivered_proof_digest),

    paid_to_seller: str(raw.paid_to_seller),
    returned_to_buyer: str(raw.returned_to_buyer),
  };
}

/**
 * `list_deals` returns seven fields per row, not whole deals.
 *
 * The register needs a state, a sum and an outcome, and it gets exactly those. The remaining
 * forty-odd fields are one `get_deal` away on the detail page, and fetching them for every row
 * of an index would be forty reads to draw one column.
 */
function toSummary(raw: unknown) {
  if (!isRecord(raw)) return null;
  const deal_id = str(raw.deal_id);
  const state = str(raw.state);
  if (!deal_id || !STATES.has(state)) return null;
  return {
    deal_id,
    state: state as DealState,
    domain: str(raw.domain),
    escrow: str(raw.escrow),
    target_registrar_id: str(raw.target_registrar_id),
    last_check_outcome: outcome(raw.last_check_outcome),
    last_check_at: str(raw.last_check_at),
  };
}

function toLedger(raw: unknown): Ledger | null {
  if (!isRecord(raw)) return null;
  const keys: (keyof Ledger)[] = [
    "total_escrowed",
    "total_released",
    "total_refunded",
    "held",
    "balance",
    "deals_opened",
    "checks_run",
    "deliveries_verified",
    "protocol_fee",
  ];
  const out = {} as Ledger;
  for (const key of keys) out[key] = str(raw[key]);
  // A ledger with no `total_escrowed` key at all is a different view answering, not an empty
  // register. The register legitimately reports "0", and "" is what a wrong shape looks like.
  if (out.total_escrowed === "") return null;
  return out;
}

function toParameters(raw: unknown): Parameters | null {
  if (!isRecord(raw)) return null;
  const keys: (keyof Parameters)[] = [
    "iana_bootstrap_url",
    "seller_proof_label",
    "buyer_proof_label",
    "proof_version",
    "accept_window_seconds",
    "transfer_window_seconds",
    "inspection_window_seconds",
    "check_interval_seconds",
    "max_deal_value_wei",
    "min_nameservers",
    "max_nameservers",
    "resolvers",
    "embedded_function_count",
    "uses_a_model",
    "boundary",
  ];
  const out = {} as Parameters;
  for (const key of keys) out[key] = str(raw[key]);
  if (out.max_deal_value_wei === "") return null;
  return out;
}

function toProbe(raw: unknown): Probe | null {
  if (!isRecord(raw)) return null;
  const domain = str(raw.domain);
  if (!domain) return null;
  return {
    domain,
    rdap_base: str(raw.rdap_base),
    registrar_iana_id: str(raw.registrar_iana_id),
    registrar_name: str(raw.registrar_name),
    nameservers: str(raw.nameservers),
    statuses: str(raw.statuses),
    registration_at: str(raw.registration_at),
    expiration_at: str(raw.expiration_at),
    last_changed_at: str(raw.last_changed_at),
    transfer_at: str(raw.transfer_at),
    transfer_locked: str(raw.transfer_locked),
    transfer_lock_setters: str(raw.transfer_lock_setters),
    pending_transfer: str(raw.pending_transfer),
    digest: str(raw.digest),
    seller_proof_name: str(raw.seller_proof_name),
    buyer_proof_name: str(raw.buyer_proof_name),
    escrowable: str(raw.escrowable),
  };
}

/* -------------------------------------------------------------------------- */
/* The reads                                                                  */
/* -------------------------------------------------------------------------- */

export const getDeal = (dealId: string) => view("get_deal", [dealId], toDeal);

/**
 * Keyed by domain, because that is the signature the contract exposes.
 *
 * It resolves its own `domain_to_deal` index and then returns the same dict `get_deal` does,
 * so the shape is a `Deal` and not a separate delivery record.
 */
export const deliveryStatus = (domain: string) => view("delivery_status", [domain], toDeal);

export const ledger = () => view("ledger", [], toLedger);

export const parameters = () => view("parameters", [], toParameters);

/**
 * `list_deals` returns summaries; the register draws from those and the detail page reads the
 * whole deal. A row this build cannot parse is dropped rather than rendered blank, and the
 * count on the page is therefore the count of rows it understood.
 */
export const listDeals = () =>
  view("list_deals", [], (raw) => {
    if (!Array.isArray(raw)) return null;
    return raw.map(toSummary).filter((row): row is NonNullable<typeof row> => row !== null);
  });

/**
 * The shape of `probe_domain`'s answer, for reading a receipt after the call.
 *
 * `probe_domain` is a write, so it is not called from here. This exists so that the write
 * runner's returned value can be decoded into the same type the form consumes, rather than
 * being pattern-matched out of a string in a component.
 */
export const decodeProbe = toProbe;
