/**
 * The wallet session as a pure reducer.
 *
 * No provider calls happen in here. Everything is `(state, event) -> state`, which is what
 * makes the one rule that matters testable: an unknown network fails closed. A write is
 * never offered on a chain the wallet has not confirmed, because the failure mode is a
 * priced transaction landing somewhere it was not meant to land.
 */

export type WalletMode = "none" | "injected";

export type WalletState = {
  mode: WalletMode;
  address: string;
  chainId: number | null;
  /** Set when the last connection attempt was refused. Printed verbatim, never paraphrased. */
  refusal: string;
};

export const DISCONNECTED: WalletState = {
  mode: "none",
  address: "",
  chainId: null,
  refusal: "",
};

export type WalletEvent =
  | { type: "connected"; address: string; chainId: number | null }
  | { type: "accounts-changed"; accounts: string[] }
  | { type: "chain-changed"; chainId: number | null }
  | { type: "provider-disconnected" }
  | { type: "connection-refused"; message: string }
  | { type: "forget" };

export function nextWalletState(state: WalletState, event: WalletEvent): WalletState {
  switch (event.type) {
    case "connected":
      return { mode: "injected", address: event.address, chainId: event.chainId, refusal: "" };
    case "accounts-changed":
      if (event.accounts.length === 0) return DISCONNECTED;
      return { ...state, mode: "injected", address: event.accounts[0], refusal: "" };
    case "chain-changed":
      return { ...state, chainId: event.chainId };
    case "provider-disconnected":
      return DISCONNECTED;
    case "connection-refused":
      return { ...DISCONNECTED, refusal: event.message };
    case "forget":
      return DISCONNECTED;
  }
}

export function parseChainId(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || value === "") return null;
  const parsed = value.startsWith("0x") ? Number.parseInt(value, 16) : Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

export const chainIdHex = (chainId: number) => `0x${chainId.toString(16)}`;

/**
 * A refusal, in the words it arrived in.
 *
 * A user closing the wallet window is not an error and is not reported as one. Anything else
 * is passed through unedited, because a rewritten wallet message is a message nobody can
 * search for.
 *
 * The shape it arrives in is not guaranteed to be an `Error`. EIP-1193 specifies a rejection as
 * an object carrying `code` and `message`, and several wallets throw exactly that rather than an
 * `Error` subclass. `String(value)` on one of those yields `[object Object]`, which would be this
 * function printing nothing at all in the one place it exists to print something, so the message
 * is read off the object and the numeric code is used as a last resort.
 */
function walletText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const shape = error as { message?: unknown; data?: { message?: unknown }; code?: unknown };
    if (typeof shape.message === "string" && shape.message) return shape.message;
    if (typeof shape.data?.message === "string" && shape.data.message) return shape.data.message;
    if (typeof shape.code === "number") return `The wallet returned error code ${shape.code}.`;
    return "The wallet refused without saying why.";
  }
  return String(error);
}

export function refusalMessage(error: unknown): string {
  const raw = walletText(error);
  const text = raw.toLowerCase();
  if (text.includes("user rejected") || text.includes("user denied")) {
    return "The wallet declined the request. Nothing was sent.";
  }
  if (text.includes("already pending") || text.includes("-32002")) {
    return "The wallet already has a request open. Finish that one first.";
  }
  return raw;
}

export type NetworkVerdict =
  | { kind: "unknown" }
  | { kind: "expected"; chainId: number }
  | { kind: "wrong"; chainId: number; expected: number };

/**
 * Unknown is its own verdict and it fails closed.
 *
 * Treating "the wallet has not told us yet" as "probably fine" is how a transaction ends up
 * priced in the wrong currency on the wrong chain.
 */
export function networkVerdict(chainId: number | null, expected: number | null): NetworkVerdict {
  if (chainId === null || expected === null) return { kind: "unknown" };
  return chainId === expected
    ? { kind: "expected", chainId }
    : { kind: "wrong", chainId, expected };
}

/** The network the wallet reports, not the one this build hopes for. */
export function networkLabel(verdict: NetworkVerdict, expectedName: string): string {
  switch (verdict.kind) {
    case "unknown":
      return "network not reported";
    case "expected":
      return `${expectedName} · chain ${verdict.chainId}`;
    case "wrong":
      return `chain ${verdict.chainId}, and this build writes to chain ${verdict.expected}`;
  }
}

export type WriteGate =
  | { ok: true }
  | { ok: false; reason: string; offerSwitch: boolean };

export function writeGate(state: WalletState, verdict: NetworkVerdict): WriteGate {
  if (state.mode === "none" || !state.address) {
    return { ok: false, reason: "Connect a wallet to sign this.", offerSwitch: false };
  }
  if (verdict.kind === "unknown") {
    return {
      ok: false,
      reason: "The wallet has not reported which network it is on, so nothing will be signed.",
      offerSwitch: false,
    };
  }
  if (verdict.kind === "wrong") {
    return {
      ok: false,
      reason: `The wallet is on chain ${verdict.chainId} and this build writes to chain ${verdict.expected}.`,
      offerSwitch: true,
    };
  }
  return { ok: true };
}
