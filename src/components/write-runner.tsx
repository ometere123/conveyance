"use client";

/**
 * One write, from a click to a receipt, with the phase always nameable.
 *
 * The refusal classes are kept apart deliberately. `[EXPECTED]` is the contract or this
 * browser declining on stated terms, `[EXTERNAL]` is a registry or a resolver not answering,
 * `[TRANSIENT]` is consensus not concluding, and `[LLM_ERROR]` is a reading that failed
 * closed. Only the first is a verdict. Collapsing them into one error state would put an
 * unreachable RDAP server and a refused transfer in the same box, and the whole point of an
 * escrow is that those two are not the same event.
 *
 * Classification is not done here. `classify` in `src/lib/lifecycle.ts` reads the contract's
 * own tag first and only falls back to reading words, and it falls back to transient rather
 * than to a verdict, because calling something a verdict is the one mistake that could move
 * money.
 *
 * `run` hands the returned value back on success, undecoded. One caller needs it: `probe_domain`
 * answers with a dict and is a write rather than a view, so the only place its answer exists is
 * the receipt. Nothing is parsed here, because what a receipt payload can be narrowed to is a
 * question about the receipt and not about this hook.
 */

import { useCallback, useState } from "react";
import type { CalldataEncodable, TransactionHash } from "genlayer-js/types";
import { IS_LIVE } from "@/lib/genlayer/config";
import { refusalReturned, type ReturnedValue } from "@/lib/genlayer/returned-value";
import { waitAccepted, writeContract } from "@/lib/genlayer/tx";
import { classify, type OutcomeClass, type PhaseKey } from "@/lib/lifecycle";
import { useTransactions } from "./transaction-provider";
import { useWallet } from "./wallet-provider";

export type WriteState = {
  phase: PhaseKey;
  hash?: TransactionHash;
  /** Set only when the call did not do what was asked. */
  outcome?: OutcomeClass;
  /** The exact message, kept verbatim. Never replaced with "something went wrong". */
  message?: string;
};

const IDLE: WriteState = { phase: "idle" };

/**
 * What `run` hands back to the caller that awaited it.
 *
 * The message is on the result and not only on the state, because a caller that has to decide
 * what to do next cannot read the state it just set: the closure it is standing in captured the
 * previous one. The one caller that needs this is the offer form, which rehearses `open_deal` with
 * no value attached and has to confirm that the refusal it got back is the escrow refusal and not
 * some other rule firing earlier.
 */
export type RunResult =
  | { ok: true; hash: TransactionHash; returned: ReturnedValue }
  | { ok: false; hash?: TransactionHash; outcome: OutcomeClass; message: string };

/**
 * Wallet errors pass through verbatim, with one addition: a wallet that does not implement
 * the GenLayer RPC methods is the wallet's limitation and not a mistake by whoever clicked,
 * and saying so is the difference between a dead end and a next step.
 */
function writeErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("does not support") || message.includes("Unsupported method")) {
    const stated = message.replace(/[\s.]+$/, "");
    return `${stated}. Some injected wallets do not implement the GenLayer RPC methods. A wallet that speaks them is required to sign this call.`;
  }
  return message;
}

export function useWriteRunner() {
  const wallet = useWallet();
  const { track, update } = useTransactions();
  const [state, setState] = useState<WriteState>(IDLE);

  const reset = useCallback(() => setState(IDLE), []);

  const run = useCallback(
    async (options: {
      label: string;
      functionName: string;
      args: CalldataEncodable[];
      value?: bigint;
      /** The deal this write belongs to, so the rail can link back to the page. */
      dealId?: string;
      /** Runs entirely in this browser. Returns a plain refusal sentence, or null. */
      preflight?: () => string | null;
    }): Promise<RunResult> => {
      setState({ phase: "validating" });
      const refusal = options.preflight?.() ?? null;
      if (refusal) {
        setState({ phase: "idle", outcome: "expected", message: refusal });
        return { ok: false, outcome: "expected", message: refusal };
      }

      // Fixture mode refuses rather than simulating. A fake receipt would teach the reader
      // that this interface can tell them something it cannot, and an escrow interface that
      // has taught anyone that is worse than no interface.
      if (!IS_LIVE) {
        const stated =
          "No Conveyance contract is configured, so this write was refused here rather than pretended. Set NEXT_PUBLIC_CONVEYANCE_CONTRACT and NEXT_PUBLIC_CONVEYANCE_DATA=live to send it. The checks above ran for real.";
        setState({ phase: "idle", outcome: "expected", message: stated });
        return { ok: false, outcome: "expected", message: stated };
      }

      // Held outside the try so the catch can report which transaction was in flight. A failure
      // after submission is a different event from a failure before one, and a caller that
      // cannot tell them apart cannot say whether anything was spent.
      let sent: TransactionHash | undefined;

      try {
        setState({ phase: "wallet-pending" });
        const client = await wallet.getWriteClient();
        const hash = await writeContract(
          client,
          options.functionName,
          options.args,
          options.value ?? 0n,
        );
        sent = hash;
        setState({ phase: "submitted", hash });
        track({
          hash,
          label: options.label,
          createdAt: new Date().toISOString(),
          status: "PENDING",
          functionName: options.functionName,
          dealId: options.dealId,
        });
        setState({ phase: "consensus-running", hash });
        const outcome = await waitAccepted(client, hash);
        update(hash, {
          status: "FINALIZED",
          executionResult: outcome.executionResult,
          executionError: outcome.executionError,
        });

        // `open_deal` refuses by returning the value and finalizing with GenVM SUCCESS rather
        // than by raising, because this chain rolls storage back on a revert and keeps the value
        // that arrived with the call. So the transaction succeeding and the request being
        // accepted are two different facts, and the rail keeps saying finalized while this
        // reports the refusal.
        //
        // The class comes from the contract's own tag rather than being assumed. A refusal here
        // can be any of the four: a rule firing is `[EXPECTED]` and worth no retry, a registry
        // that did not answer is `[EXTERNAL]` and worth one, and reporting the second as the
        // first would tell a buyer they were turned down when nobody had decided anything.
        const refusal = refusalReturned(outcome.returned);
        if (refusal) {
          update(hash, { refusal });
          const stated = `The contract declined this call and returned the value you sent. ${refusal}`;
          const refused = classify(refusal);
          setState({ phase: "idle", hash, outcome: refused, message: stated });
          return { ok: false, hash, outcome: refused, message: stated };
        }

        setState({ phase: "settled", hash });
        return { ok: true, hash, returned: outcome.returned };
      } catch (error) {
        const message = writeErrorMessage(error);
        const outcome = classify(message);
        setState((previous) => ({ phase: "idle", hash: previous.hash, outcome, message }));
        return { ok: false, hash: sent, outcome, message };
      }
    },
    [track, update, wallet],
  );

  return {
    state,
    run,
    reset,
    /**
     * The lead sentence when a write cannot be signed at all. "Connect a wallet first" is
     * only useful advice when there is a wallet to connect, so a browser with no extension is
     * told that instead, and a wallet on another chain is told which chain it is on rather
     * than being allowed to sign into the void. Null once a session is open and on this
     * build's network.
     */
    walletGate:
      wallet.mode === "none"
        ? wallet.hasInjected
          ? "Connect a wallet first."
          : "No wallet extension was detected in this browser, so there is nothing to sign with."
        : (wallet.writeBlockedReason ?? null),
  };
}
