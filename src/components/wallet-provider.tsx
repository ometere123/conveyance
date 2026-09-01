"use client";

/**
 * The wallet session, held in one place.
 *
 * All of the logic lives in `src/lib/wallet-session.ts` as a reducer, so this component is
 * only the part that has to touch the browser: detecting a provider, subscribing to its
 * events, and asking it for things. Every decision about whether a write may go out is made
 * by `writeGate`, which is a pure function and is tested as one.
 *
 * Two rules are load-bearing. A page load is never treated as consent to reveal an address,
 * so nothing auto-connects. And a network the wallet has not confirmed fails closed, because
 * a priced transaction landing on the wrong chain is not recoverable by apologising for it.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { createInjectedClient } from "@/lib/genlayer/client";
import { chain, CHAIN_NAME } from "@/lib/genlayer/config";
import {
  chainIdHex,
  DISCONNECTED,
  networkLabel,
  networkVerdict,
  nextWalletState,
  parseChainId,
  refusalMessage,
  writeGate,
  type NetworkVerdict,
  type WalletMode,
  type WalletState,
} from "@/lib/wallet-session";

export type { WalletMode };

type WalletContextValue = {
  mode: WalletMode;
  address: string;
  hasInjected: boolean;
  connecting: boolean;
  /** The last refusal, in the words it arrived in. Empty when there is nothing to report. */
  refusal: string;
  /** Where the wallet says it is. Writes are held back unless this is `expected`. */
  network: NetworkVerdict;
  /** What the running head prints. Never this build's network unless the wallet is on it. */
  networkName: string;
  canWrite: boolean;
  /** Why a write cannot be signed, or undefined when one can. */
  writeBlockedReason?: string;
  /** True only when the block is a wrong chain, which is the one block with a remedy here. */
  offerSwitch: boolean;
  connectInjected: () => Promise<void>;
  /** Asks the wallet to move to the chain this build targets. */
  switchNetwork: () => Promise<void>;
  disconnect: () => void;
  getWriteClient: () => Promise<Awaited<ReturnType<typeof createInjectedClient>>>;
};

const WalletContext = createContext<WalletContextValue | null>(null);

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [wallet, setWallet] = useState<WalletState>(DISCONNECTED);
  const [hasInjected, setHasInjected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  // A wallet refusing to switch chains is not a connection refusal and must not discard the
  // session, so it is held apart from the reducer's own refusal field.
  const [switchRefusal, setSwitchRefusal] = useState("");

  // Detect the provider without touching it.
  useEffect(() => {
    queueMicrotask(() => setHasInjected(Boolean(window.ethereum)));
  }, []);

  // Follow the wallet for as long as a session is open. All three events matter: the address
  // on screen has to be the address that would sign, the chain has to be the chain the
  // transaction would go to, and a provider that dropped the connection must not leave a
  // stale session looking live.
  useEffect(() => {
    const provider = typeof window !== "undefined" ? window.ethereum : undefined;
    if (wallet.mode !== "injected" || !provider?.on) return;

    const onAccounts = (...args: unknown[]) => {
      const accounts = Array.isArray(args[0]) ? args[0].map((value) => String(value)) : [];
      setWallet((current) => nextWalletState(current, { type: "accounts-changed", accounts }));
    };
    const onChain = (...args: unknown[]) => {
      setSwitchRefusal("");
      setWallet((current) =>
        nextWalletState(current, { type: "chain-changed", chainId: parseChainId(args[0]) }),
      );
    };
    const onDisconnect = () =>
      setWallet((current) => nextWalletState(current, { type: "provider-disconnected" }));

    provider.on("accountsChanged", onAccounts);
    provider.on("chainChanged", onChain);
    provider.on("disconnect", onDisconnect);
    return () => {
      provider.removeListener?.("accountsChanged", onAccounts);
      provider.removeListener?.("chainChanged", onChain);
      provider.removeListener?.("disconnect", onDisconnect);
    };
  }, [wallet.mode]);

  const switchNetwork = useCallback(async () => {
    const provider = typeof window !== "undefined" ? window.ethereum : undefined;
    if (!provider) return;
    setSwitchRefusal("");
    try {
      await provider.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: chainIdHex(chain.id) }],
      });
      // The wallet answers with `chainChanged`, which the listener above records. Asking
      // again here would only duplicate what the event already says.
    } catch (caught) {
      setSwitchRefusal(
        `This wallet would not switch to ${CHAIN_NAME} (chain ${chain.id}): ${refusalMessage(caught)} Add the network in the wallet itself, then connect again.`,
      );
    }
  }, []);

  const connectInjected = useCallback(async () => {
    const provider = typeof window !== "undefined" ? window.ethereum : undefined;
    if (!provider) {
      setWallet(
        nextWalletState(DISCONNECTED, {
          type: "connection-refused",
          message: "No injected wallet was found in this browser.",
        }),
      );
      return;
    }
    setConnecting(true);
    setSwitchRefusal("");
    // A provider found here proves one exists even if none did at mount, so the gate copy
    // cannot keep claiming there is nothing to sign with.
    setHasInjected(true);
    try {
      const accounts = (await provider.request({ method: "eth_requestAccounts" })) as string[];
      const next = Array.isArray(accounts) ? accounts[0] : undefined;
      if (!next) {
        setWallet(
          nextWalletState(DISCONNECTED, {
            type: "connection-refused",
            message: "The wallet returned no account.",
          }),
        );
        return;
      }
      // Ask which chain before declaring the session open, so the first render already knows
      // whether a write may go out.
      const chainId = parseChainId(await provider.request({ method: "eth_chainId" }));
      setWallet(nextWalletState(DISCONNECTED, { type: "connected", address: next, chainId }));

      // On the wrong chain, ask once. A wallet that refuses says so, and writes stay shut.
      if (chainId !== null && chainId !== chain.id) await switchNetwork();
    } catch (caught) {
      setWallet((current) =>
        nextWalletState(current, {
          type: "connection-refused",
          message: refusalMessage(caught),
        }),
      );
    } finally {
      setConnecting(false);
    }
  }, [switchNetwork]);

  // Forgets the session in this tab. A wallet cannot be made to revoke a site from here, so
  // the label says disconnect and means exactly this much.
  const disconnect = useCallback(() => {
    setSwitchRefusal("");
    setWallet((current) => nextWalletState(current, { type: "forget" }));
  }, []);

  const getWriteClient = useCallback(async () => {
    // Gated here as well as in the UI, because this is the last point before a signature is
    // requested and a caller that skipped the gate must still not get a client pointed at
    // the wrong chain.
    const decision = writeGate(wallet, networkVerdict(wallet.chainId, chain.id));
    if (!decision.ok) throw new Error(decision.reason);
    return createInjectedClient(wallet.address as `0x${string}`);
  }, [wallet]);

  const value = useMemo(() => {
    const network = networkVerdict(wallet.chainId, chain.id);
    const gate = writeGate(wallet, network);
    return {
      mode: wallet.mode,
      address: wallet.address,
      hasInjected,
      connecting,
      refusal: switchRefusal || wallet.refusal,
      network,
      networkName: networkLabel(network, CHAIN_NAME),
      canWrite: gate.ok,
      writeBlockedReason: gate.ok ? undefined : gate.reason,
      offerSwitch: gate.ok ? false : gate.offerSwitch,
      connectInjected,
      switchNetwork,
      disconnect,
      getWriteClient,
    };
  }, [
    wallet,
    hasInjected,
    connecting,
    switchRefusal,
    connectInjected,
    switchNetwork,
    disconnect,
    getWriteClient,
  ]);

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet() {
  const value = useContext(WalletContext);
  if (!value) throw new Error("useWallet must be used inside WalletProvider");
  return value;
}
