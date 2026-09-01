"use client";

/**
 * The plate: a running head, a stated provenance, the register, and a footer that says what
 * this contract does not do.
 *
 * The provenance strip is not a debug banner and is not dismissible. An escrow interface that
 * looks the same whether it is reading a deployed contract or reading `mock-data.ts` is an
 * interface that can mislead somebody about where their money is, so the answer is printed on
 * every page, above the content, in the same place every time.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { Logo } from "@/components/logo";
import { TransactionRail } from "@/components/transaction-rail";
import { WalletControl } from "@/components/wallet-control";
import { dataProvenance } from "@/lib/data-source";
import { shortenHex } from "@/lib/format";
import { CHAIN_NAME, CONTRACT_ADDRESS, explorerAddressUrl } from "@/lib/genlayer/config";

/**
 * Four entries, and there is no fifth for filings.
 *
 * An earlier draft of this contract had a dispute route. It does not have one now: a deal that
 * verifies and then reverses is decided by the check itself, deterministically, from what the
 * registry says. There is nothing for a party to file and nobody to file it with, so a navigation
 * item promising a filings page would be promising an authority this instrument does not contain.
 */
const NAV = [
  { href: "/", label: "the plate" },
  { href: "/deals", label: "register" },
  { href: "/deals/new", label: "lodge an offer" },
  { href: "/docs", label: "the instrument" },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [railOpen, setRailOpen] = useState(false);
  const provenance = dataProvenance();

  return (
    <div className="min-h-dvh">
      <header className="cv-plate sticky top-0 z-40 border-b border-[var(--rule)] backdrop-blur-[2px]">
        <div className="cv-guilloche-band" />
        <div className="mx-auto flex max-w-[1400px] flex-wrap items-baseline gap-x-6 gap-y-2 px-4 py-3 plate:px-8">
          <Link href="/" className="cv-heading shrink-0 no-underline">
            <Logo />
            <span className="ml-2">Conveyance</span>
          </Link>
          <p className="cv-legend hidden shrink-0 plate:block">
            escrow for a domain that has to change hands
          </p>
          <nav className="order-3 flex w-full flex-wrap items-baseline gap-x-5 gap-y-1 plate:order-none plate:w-auto plate:flex-1">
            {NAV.map((item) => {
              const active =
                item.href === "/"
                  ? pathname === "/"
                  : item.href === "/deals"
                    ? pathname === "/deals" || /^\/deals\/(?!new$)/.test(pathname)
                    : pathname.startsWith(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={`cv-legend no-underline ${
                    active ? "cv-legend-ink underline decoration-1 underline-offset-4" : ""
                  }`}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>
          <div className="ml-auto flex items-center gap-3">
            <button
              type="button"
              onClick={() => setRailOpen((open) => !open)}
              aria-expanded={railOpen}
              aria-controls="tx-rail"
              className="cv-btn-quiet"
            >
              {railOpen ? "Close writes" : "Writes"}
            </button>
            <WalletControl />
          </div>
        </div>

        {/* Provenance. Stated on every page, never buried, never dismissible. */}
        <div
          className={`border-t border-[var(--rule)] px-4 py-1.5 plate:px-8 ${
            provenance.mode === "live" ? "" : "bg-[var(--plate-2)]"
          }`}
        >
          <p className="cv-aside mx-auto max-w-[1400px]">
            <span className="cv-legend cv-legend-ink mr-2">
              {provenance.mode === "live"
                ? `${CHAIN_NAME} · live`
                : provenance.mode === "misconfigured"
                  ? "misconfigured"
                  : "fixtures"}
            </span>
            {provenance.line}
          </p>
        </div>
      </header>

      {railOpen ? (
        <div id="tx-rail" className="mx-auto max-w-[1400px] px-4 pt-6 plate:px-8">
          <TransactionRail onClose={() => setRailOpen(false)} />
        </div>
      ) : null}

      <main id="main" className="mx-auto max-w-[1400px] px-4 py-10 plate:px-8">
        {children}
      </main>

      <footer className="cv-rule mx-auto mt-16 max-w-[1400px] px-4 py-8 plate:px-8">
        <p className="cv-aside max-w-[68ch]">
          Conveyance holds the money and reads the registry. It does not move a domain, and it
          cannot: a transfer is executed at two registrars by the two parties. What this contract
          decides is whether the registry and the zone now say the thing the deal required, and
          who the escrow belongs to as a result. See{" "}
          <Link href="/docs" className="underline decoration-1 underline-offset-4">
            the instrument
          </Link>
          .
        </p>
        <p className="cv-legend mt-4">
          an intelligent contract on genlayer · {CHAIN_NAME}
          {CONTRACT_ADDRESS ? (
            <>
              {" · "}
              <a
                href={explorerAddressUrl(CONTRACT_ADDRESS)}
                target="_blank"
                rel="noreferrer noopener"
                title={CONTRACT_ADDRESS}
                className="underline decoration-1 underline-offset-4"
              >
                {shortenHex(CONTRACT_ADDRESS, 10, 8)}
              </a>
            </>
          ) : null}
        </p>
      </footer>
    </div>
  );
}
