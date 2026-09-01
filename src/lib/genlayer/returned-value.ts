/**
 * What a write actually returned, read off the leader receipt.
 *
 * This exists because of one uncomfortable fact about GenLayer: a transaction can finalize with
 * GenVM SUCCESS and still be a refusal. `open_deal` is the only payable method here, and it
 * refuses by refunding `gl.message.value` and returning its tagged reason rather than by raising.
 * That is not a stylistic choice. It was measured on StudioNet: a revert rolls storage back but
 * does not return the value that arrived with the call, so a reverting payable method charges the
 * caller for being told no, and charges again on every retry. The escrow would be stranded in the
 * contract with no method able to reach it.
 *
 * The cost of refunding instead of reverting is that "the transaction succeeded" and "the request
 * was accepted" stop being the same statement, and an interface that checked only the first would
 * print a deal id over an escrow that had just been handed straight back.
 *
 * WHICH WORDS COUNT AS A REFUSAL. Conveyance tags every refusal with one of four: `[EXPECTED]`,
 * `[EXTERNAL]`, `[TRANSIENT]`, `[LLM_ERROR]`. Those four are the marker, and the marker is kept in
 * what this module returns rather than being stripped off. The tag is the part that says whether
 * to try again: `[EXTERNAL]` means a registry did not answer and the same call may well work in a
 * minute, `[EXPECTED]` means a rule fired and it will fire again. A decoder that handed back only
 * the words would leave its caller unable to tell those apart, and telling them apart is the
 * entire reason the taxonomy exists.
 *
 * StudioNet's `leader_receipt[0].result` is a base64 payload whose first byte is a result code,
 * 0 return and 1 rollback and 2 contract error, and genlayer-js decodes it into `{status, payload}`
 * before the app ever sees it. Both shapes are handled here: the decoded object, and the raw base64
 * string, so this works whether the caller went through the client or read the RPC directly.
 *
 * One method returns something other than a string. `probe_domain` answers with a dict and is
 * a write rather than a view, so its answer exists only on a receipt. When the client hands
 * back a decoded record that is not one of its own text wrappers, it is kept as `structure`
 * rather than being thrown away as unreadable. The base64 path cannot produce one: the
 * remainder there is calldata-encoded and decoding calldata is not reimplemented in this file.
 * A caller that asks for a structure and does not get one is expected to say so plainly rather
 * than to fill the gap with something plausible.
 */

import { taggedRefusal } from "../contract-types.ts";

/**
 * How far into an undecoded body a tag may sit and still be the start of the string.
 *
 * A calldata string is length-prefixed, so its text never begins at byte zero of the payload and
 * an anchored test would find nothing. A bare search for the tag anywhere would go too far the
 * other way and read a returned sentence that quotes a tag as a refusal. Eight bytes is past any
 * length prefix these strings can carry, every refusal here being well under a kilobyte, and far
 * short of anywhere a quotation could plausibly sit.
 */
const CALLDATA_PREFIX_BYTES = 8;

export type ReturnedValue =
  /** The call returned. `text` is the returned value rendered as text. */
  | { kind: "returned"; text: string }
  /** The call returned a record the client had already decoded. Fields are untyped here. */
  | { kind: "structure"; value: Record<string, unknown> }
  /** The call rolled back or errored. `message` is the contract's own words. */
  | { kind: "reverted"; message: string }
  /** No receipt, or a payload in a shape this decoder does not recognise. */
  | { kind: "unreadable" };

/** Decodes one leader receipt's `result` field, in either shape. */
export function returnedValue(result: unknown): ReturnedValue {
  if (typeof result === "string") return fromBase64(result);
  if (!isRecord(result)) return { kind: "unreadable" };

  const status = result.status;
  const payload = result.payload;

  if (status === "rollback" || status === "contract_error" || status === "error") {
    return { kind: "reverted", message: typeof payload === "string" ? payload : "" };
  }
  if (status === "return") {
    if (payload === null || payload === undefined) return { kind: "returned", text: "" };
    if (typeof payload === "string") return { kind: "returned", text: payload };
    if (isRecord(payload) && typeof payload.readable === "string") {
      return { kind: "returned", text: unquote(payload.readable) };
    }
    if (isRecord(payload)) return { kind: "structure", value: payload };
    return { kind: "unreadable" };
  }
  if (status === "none") return { kind: "returned", text: "" };
  if (typeof result.raw === "string") return fromBase64(result.raw);
  return { kind: "unreadable" };
}

/**
 * The refusal a payable call returned, tag and all, or undefined if it did not refuse.
 *
 * The tag stays on. A caller deciding what to say next needs it, `classify` in
 * `src/lib/lifecycle.ts` reads it, and a refusal that arrived as `[EXTERNAL]` and got reported as
 * an `[EXPECTED]` verdict would be telling somebody a rule refused them when in fact a registry
 * was unreachable for a moment.
 *
 * Only a returned value counts. A revert carrying the same words is a different event with
 * different consequences for the caller's GEN: the eleven non-payable methods here still refuse by
 * raising, because none of them can receive value and there is nothing to strand. Conflating the
 * two would defeat the point of having separated them in the contract.
 *
 * A tag with nothing after it gets a stated fallback rather than an empty string, because an empty
 * refusal reads on screen as no refusal at all.
 */
export function refusalReturned(value: ReturnedValue): string | undefined {
  if (value.kind !== "returned") return undefined;
  const text = value.text.trim();
  const tagged = taggedRefusal(text);
  if (!tagged) return undefined;
  return tagged.rest.trim() === "" ? `[${tagged.tag}] no reason was given` : text;
}

/** Convenience for the common case: decode a receipt result and test it. */
export function refusalIn(result: unknown): string | undefined {
  return refusalReturned(returnedValue(result));
}

/**
 * The returned value as a record, when it can honestly be read as one.
 *
 * Two ways in. The client may have decoded the payload into an object already, which is the
 * `structure` kind. Or it may have handed back text, in which case the only text this will
 * accept is JSON: a Python dict repr uses single quotes and will not parse, and rewriting it
 * into something that would parse is guesswork this file does not do. Null means the receipt
 * could not be read as a record, which is a fact worth printing rather than papering over.
 */
export function returnedRecord(value: ReturnedValue): Record<string, unknown> | null {
  if (value.kind === "structure") return value.value;
  if (value.kind !== "returned") return null;
  const text = value.text.trim();
  if (!text.startsWith("{")) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** The leader receipt's `result`, decoded, however deeply the client wrapped it. */
export function returnedFromTransaction(transaction: unknown): ReturnedValue {
  if (!isRecord(transaction)) return { kind: "unreadable" };
  const consensus = transaction.consensus_data;
  if (!isRecord(consensus)) return { kind: "unreadable" };
  const leader = consensus.leader_receipt;
  const first = Array.isArray(leader) ? leader[0] : leader;
  return returnedValue(isRecord(first) ? first.result : undefined);
}

/**
 * The undecoded form. First byte is the result code; for a return the remainder is
 * calldata-encoded, which is not worth reimplementing here, so the bytes are read as text and the
 * length prefix is stepped over rather than parsed. See `CALLDATA_PREFIX_BYTES` for how far that
 * step is allowed to go and why it is bounded rather than open.
 */
function fromBase64(encoded: string): ReturnedValue {
  let bytes: Uint8Array;
  try {
    const binary = atob(encoded);
    bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return { kind: "unreadable" };
  }
  if (bytes.length === 0) return { kind: "unreadable" };
  const body = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(1));
  if (bytes[0] === 1 || bytes[0] === 2 || bytes[0] === 3) {
    return { kind: "reverted", message: body };
  }
  if (bytes[0] === 0) {
    const at = body.indexOf("[");
    const startsARefusal = at !== -1 && at <= CALLDATA_PREFIX_BYTES && taggedRefusal(body.slice(at));
    return { kind: "returned", text: startsARefusal ? body.slice(at) : body };
  }
  if (bytes[0] === 4) return { kind: "returned", text: "" };
  return { kind: "unreadable" };
}

/** `"\"d2\""` is how a returned string arrives once decoded. */
function unquote(readable: string): string {
  const trimmed = readable.trim();
  if (!trimmed.startsWith('"')) return trimmed;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return typeof parsed === "string" ? parsed : trimmed;
  } catch {
    return trimmed.replace(/^"|"$/g, "");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
