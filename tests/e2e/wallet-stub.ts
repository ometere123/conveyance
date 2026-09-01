import type { Page } from "@playwright/test";

/**
 * A stand-in for an injected wallet, installed before the app's scripts run.
 *
 * It exists to prove the gates work, so it answers only the three methods this app calls before
 * a signature and throws on everything else. `eth_sendTransaction` and the signing methods are
 * not implemented and never will be: this is an escrow interface, and a smoke suite that could
 * send value is a smoke suite nobody dares run. The refusal is EIP-1193 `-32601`, which is what
 * a real provider returns for a method it does not have, so the app is exercised against the
 * failure it would actually see rather than against a bespoke one.
 *
 * `window.__walletEmit` lets a test do the things a person does mid-session: switch account,
 * revoke the site, switch network, drop the connection. Each of those changes whether a write
 * may be signed, and the running head has to say so.
 */

/** StudioNet, as a wallet reports it. `genlayer-js`'s studionet is chain 61999. */
export const STUDIONET_CHAIN_HEX = "0xf22f";
/** Ethereum mainnet, standing in for "the wallet is somewhere else". */
export const WRONG_CHAIN_HEX = "0x1";

export const STUB_ACCOUNT = "0x00000000000000000000000000000000000000e2";

export type WalletStubOptions = {
  /** The account `eth_requestAccounts` returns. */
  account?: string;
  /** The chain the wallet claims, as hex. */
  chainId?: string;
  /** Refuse the connection with EIP-1193 code 4001. */
  rejectConnection?: boolean;
  /** Whether `wallet_switchEthereumChain` succeeds. Real wallets often refuse. */
  switchOutcome?: "accept" | "reject";
  /** Answer `eth_requestAccounts` with an empty list. */
  returnNoAccounts?: boolean;
};

type EmittableEvent = "accountsChanged" | "chainChanged" | "disconnect";

declare global {
  interface Window {
    __walletEmit?: (event: EmittableEvent, payload?: unknown) => void;
  }
}

export async function installWalletStub(page: Page, options: WalletStubOptions = {}) {
  const settings = {
    account: options.account ?? STUB_ACCOUNT,
    chainId: options.chainId ?? STUDIONET_CHAIN_HEX,
    rejectConnection: options.rejectConnection ?? false,
    switchOutcome: options.switchOutcome ?? "reject",
    returnNoAccounts: options.returnNoAccounts ?? false,
    expectedChainId: STUDIONET_CHAIN_HEX,
  };

  await page.addInitScript((config: typeof settings) => {
    const listeners: Record<string, ((payload?: unknown) => void)[]> = {};
    let chainId = config.chainId;

    const emit = (event: string, payload?: unknown) => {
      for (const handler of listeners[event] ?? []) handler(payload);
    };

    const rejection = (code: number, message: string) => {
      const error = new Error(message) as Error & { code: number };
      error.code = code;
      return error;
    };

    const provider = {
      isMetaMask: true,
      async request({ method }: { method: string; params?: unknown[] }) {
        switch (method) {
          case "eth_requestAccounts":
          case "eth_accounts":
            if (config.rejectConnection) {
              throw rejection(4001, "User rejected the request.");
            }
            return config.returnNoAccounts ? [] : [config.account];

          case "eth_chainId":
            return chainId;

          case "wallet_switchEthereumChain":
            if (config.switchOutcome === "reject") {
              throw rejection(4902, "Unrecognized chain ID. Try adding the chain first.");
            }
            chainId = config.expectedChainId;
            emit("chainChanged", chainId);
            return null;

          default:
            // Deliberate. Nothing in a smoke suite for an escrow contract may reach a method
            // that could move value, so every other method is absent rather than stubbed.
            throw rejection(-32601, `The E2E wallet stub does not implement ${method}.`);
        }
      },
      on(event: string, handler: (payload?: unknown) => void) {
        (listeners[event] ??= []).push(handler);
        return provider;
      },
      removeListener(event: string, handler: (payload?: unknown) => void) {
        listeners[event] = (listeners[event] ?? []).filter((entry) => entry !== handler);
        return provider;
      },
    };

    (window as unknown as Record<string, unknown>).ethereum = provider;
    window.__walletEmit = (event, payload) => {
      if (event === "chainChanged" && typeof payload === "string") chainId = payload;
      emit(event, payload);
    };
  }, settings);
}

/** Drives a wallet event from the test, the way a person would from the extension. */
export async function emitWalletEvent(page: Page, event: EmittableEvent, payload?: unknown) {
  await page.evaluate(
    ([name, value]) => {
      window.__walletEmit?.(name as EmittableEvent, value);
    },
    [event, payload] as const,
  );
}
