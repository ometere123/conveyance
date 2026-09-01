"use client";

/**
 * One button. Injected wallet only, and no chooser panel.
 *
 * There is nothing to choose between, because there is exactly one signer in this app and no
 * key is ever generated in the browser. A panel offering a choice would be a panel with one
 * item in it pretending to be a decision.
 *
 * Two labels do the work: "Connect wallet" and "Disconnect wallet". The other states this
 * button can be in are not alternatives to those, they are the same button mid flight or
 * blocked, and each says what it is instead of staying silent.
 */

import { shortenHex } from "@/lib/format";
import { useWallet } from "./wallet-provider";

export function WalletControl() {
  const wallet = useWallet();

  if (wallet.mode !== "injected") {
    return (
      <div className="flex flex-col items-start gap-1 plate:items-end">
        <button
          type="button"
          className="cv-btn"
          onClick={() => void wallet.connectInjected()}
          disabled={wallet.connecting}
        >
          {wallet.connecting ? "Waiting for wallet" : "Connect wallet"}
        </button>
        {wallet.refusal ? (
          <p className="cv-aside max-w-[34ch]">{wallet.refusal}</p>
        ) : !wallet.hasInjected ? (
          <p className="cv-aside max-w-[34ch]">
            No injected wallet was found in this browser. Every page here still reads.
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex flex-col items-start gap-1 plate:items-end">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="cv-record" title={wallet.address}>
          {shortenHex(wallet.address)}
        </span>
        <span className="cv-legend">{wallet.networkName}</span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {wallet.network.kind !== "expected" ? (
          <button
            type="button"
            className="cv-btn-quiet"
            onClick={() => void wallet.switchNetwork()}
          >
            Switch network
          </button>
        ) : null}
        <button type="button" className="cv-btn-quiet" onClick={wallet.disconnect}>
          Disconnect wallet
        </button>
      </div>
      {wallet.refusal ? <p className="cv-aside max-w-[38ch]">{wallet.refusal}</p> : null}
    </div>
  );
}
