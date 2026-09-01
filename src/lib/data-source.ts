/**
 * The one file that decides where a page's data came from.
 *
 * Every read in the app goes through a function here. In fixture mode each one hands back
 * something from `mock-data.ts`; with a contract address present each one calls
 * `live-reads.ts` instead. Going live is this file changing branch and no component changing
 * at all, which is the only way to be sure the fixture pages were rehearsing the real thing
 * rather than a friendlier version of it.
 *
 * One exception is deliberate and it is the important one. The maximum the contract will
 * escrow is a limit it enforces on a signed transaction. There is no fixture branch that
 * invents it, and there is not one even though the figure is a compile-time constant in the
 * contract source, because a copy of a constant is still a copy: a form that validated a real
 * price against a number this repository holds would pass in the browser and be refused on chain
 * after taking a signature. In fixture mode that read refuses and the form refuses with it.
 */

import type { Deal, DealSummary, Ledger, Parameters, Probe } from "@/lib/contract-types";
import { summarise } from "@/lib/contract-types";
import { CHAIN_NAME, CONTRACT_ADDRESS, DATA_MODE, IS_LIVE } from "@/lib/genlayer/config";
import { available, notFound, unavailable, type ReadResult } from "@/lib/genlayer/read-result";
import * as live from "@/lib/live-reads";
import { MOCK_DEALS, MOCK_LEDGER, MOCK_NOW, MOCK_PARAMETERS, MOCK_PROBES } from "@/lib/mock-data";

export const dataMode = DATA_MODE;

/**
 * The sentence printed on every page, in the header, never in a corner.
 *
 * Three branches, not two. "Live was asked for and there is no address" is its own state and
 * has to say so, because silently falling back to fixtures while the banner claims live is
 * how a demo becomes a false statement.
 */
export function dataProvenance(): { mode: "live" | "fixtures" | "misconfigured"; line: string } {
  if (DATA_MODE === "live" && !CONTRACT_ADDRESS) {
    return {
      mode: "misconfigured",
      line: "This build was asked for live data and no contract address is set, so nothing can be read. Set NEXT_PUBLIC_CONVEYANCE_CONTRACT.",
    };
  }
  if (IS_LIVE) {
    return {
      mode: "live",
      line: `Every figure on this page was read from the deployed contract on ${CHAIN_NAME}. Deadlines are the contract's own.`,
    };
  }
  return {
    mode: "fixtures",
    line: `Bundled fixtures, not a deployed contract. The deals below are invented, and so are the domain names in them: none of it is a claim about anybody's registration. Every state this interface can render has a deal in the register, the clock is fixed at ${MOCK_NOW}, no wallet is needed to read them, and no write will be attempted.`,
  };
}

/**
 * The instant countdowns are measured from.
 *
 * Fixed in fixture mode so that a deadline described as "31 hours remaining" stays that way
 * between a server render and a client render of the same page. Live, it is now.
 */
export function referenceNow(): number {
  return IS_LIVE ? Date.now() : Date.parse(MOCK_NOW);
}

/* -------------------------------------------------------------------------- */
/* Deals                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The register, from `list_deals`, which returns seven fields per row and not whole deals.
 *
 * The fixture branch derives its summaries from the same deals `getDeal` serves, so a row in
 * the register and the page it links to cannot disagree about a state or a sum. Deriving is
 * also what the contract does: `list_deals` is built from the same stored deals `get_deal`
 * reads, so the fixture is imitating the contract's structure and not just its output.
 */
export async function listDeals(): Promise<ReadResult<DealSummary[]>> {
  if (IS_LIVE) return live.listDeals();
  return available(MOCK_DEALS.map(summarise));
}

export async function getDeal(id: string): Promise<ReadResult<Deal>> {
  if (IS_LIVE) return live.getDeal(id);
  const deal = MOCK_DEALS.find((row) => row.deal_id === id);
  return deal ? available(deal) : notFound();
}

/**
 * The same deal, asked for by domain, which is the shape a marketplace integrating this wants.
 *
 * The contract resolves its own `domain_to_deal` index and then returns the deal, so this is
 * one view call and not a scan. A domain carries at most one live deal at a time, which is why
 * the index can exist at all.
 */
export async function getDealByDomain(domain: string): Promise<ReadResult<Deal>> {
  if (IS_LIVE) return live.deliveryStatus(domain);
  const deal = MOCK_DEALS.find((row) => row.domain === domain);
  return deal ? available(deal) : notFound();
}

/* -------------------------------------------------------------------------- */
/* Contract-wide figures                                                      */
/* -------------------------------------------------------------------------- */

/** Escrow conservation and the counters. Every figure here is the contract's own arithmetic. */
export async function getLedger(): Promise<ReadResult<Ledger>> {
  if (IS_LIVE) return live.ledger();
  return available(MOCK_LEDGER);
}

/** The constants a caller's decisions depend on, read rather than assumed. */
export async function getParameters(): Promise<ReadResult<Parameters>> {
  if (IS_LIVE) return live.parameters();
  return available(MOCK_PARAMETERS);
}

const NO_FIXTURE_FOR_A_LIMIT =
  "This is a limit the contract enforces on a signed transaction, and there is no deployed contract to ask. Fixtures do not answer for it, because a form that validated against a figure this repository holds would pass here and be refused on chain after taking a signature.";

/**
 * BOTH LIMIT READERS TAKE AN ALREADY-READ `parameters()` WHEN THE CALLER HAS ONE.
 *
 * The two limits and the constants panel are three facts from one view call, and `/deals/new` needs
 * all three. Reading independently, that page spent three identical `parameters()` calls per
 * render, which was invisible while it was prerendered once at build time and is not invisible now
 * that it renders per request: StudioNet answers 30 requests per minute and said so, by name, on
 * the offer form during a Playwright run. Two thirds of that page's budget was being spent asking
 * the same question.
 *
 * The argument is optional rather than required so neither reader can be called without a way to
 * get its answer, and it is the read result rather than a client or a flag, so a caller cannot pass
 * something these functions would have to interpret. This is per-call sharing and not a cache:
 * nothing is held between requests, which is the property the pages were just fixed to have.
 */

/** The largest sum the contract will escrow. Refuses rather than guessing. */
export async function priceCap(read?: ReadResult<Parameters>): Promise<ReadResult<string>> {
  const parameters = read ?? (await getParameters());
  if (parameters.kind !== "AVAILABLE") return parameters as ReadResult<string>;
  const cap = parameters.value.max_deal_value_wei;
  return cap ? available(cap) : unavailable(NO_FIXTURE_FOR_A_LIMIT);
}

/**
 * The nameserver count bounds, which the open form validates against before signing.
 *
 * Refuses in fixture mode for the same reason the price cap does. Two and eight are in the
 * contract source; a form driven by this repository's memory of them is a form that can be
 * wrong about them.
 */
export async function nameserverBounds(
  read?: ReadResult<Parameters>,
): Promise<ReadResult<{ min: number; max: number }>> {
  const parameters = read ?? (await getParameters());
  if (parameters.kind !== "AVAILABLE") {
    return parameters as ReadResult<{ min: number; max: number }>;
  }
  const { min_nameservers: min, max_nameservers: max } = parameters.value;
  if (!min || !max) return unavailable(NO_FIXTURE_FOR_A_LIMIT);
  return available({ min: Number(min), max: Number(max) });
}

/* -------------------------------------------------------------------------- */
/* The probe                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * What the registry says about one domain, before any deal exists for it.
 *
 * The only read in this file with no live counterpart here, because there is no live read to
 * have: `probe_domain` fetches the IANA bootstrap and an RDAP object inside consensus, so it is
 * a transaction the caller signs and pays for, not a view. Live, the new-deal form sends it
 * through `write-runner.tsx` and reads the returned object from the receipt. This function exists
 * so that the form is walkable without a wallet, and it answers for three names and refuses for
 * every other one rather than inventing a plausible registrar for whatever was typed.
 *
 * Refusing on the fourth name is the point. A fixture probe that answered for any input would be
 * this app deciding what a registry says, which is the one thing the whole product is built to
 * not do.
 */
export async function probeFixture(domain: string): Promise<ReadResult<Probe>> {
  if (IS_LIVE) {
    return unavailable(
      "A probe is a signed transaction rather than a view, so it is sent from the form and read from its receipt. There is nothing to fetch here.",
    );
  }
  const probe = MOCK_PROBES.find((row) => row.domain === domain.trim().toLowerCase());
  if (probe) return available(probe);
  return unavailable(
    `No fixture probe for that name. Live, this call asks the registry directly and answers for anything registered. In fixture mode the answers are bundled, and only ${MOCK_PROBES.map((row) => row.domain).join(", ")} have one. Nothing is guessed for a name that does not.`,
  );
}

