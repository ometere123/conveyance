/**
 * The bundled register. Every state this interface can draw has a deal here.
 *
 * WHY THESE FIXTURES ARE SHAPED LIKE THIS. `openDeal()` below returns exactly the `Deal` that
 * `open_deal` writes: the same fields set, the same fields left empty, the same `"0"` counters.
 * Every fixture is then that deal plus the writes that actually happened to it. So a fixture
 * cannot hold a combination the contract could not reach, and it cannot forget a field, because
 * the factory owns all forty-seven and each fixture only names what a write would have changed.
 *
 * The register covers all six states, all seven recorded check outcomes, and all four proof
 * outcomes, including both meanings of `PROOF_ABSENT`. Three fixtures exist specifically for
 * shapes an earlier version of this app got wrong and could not have caught: a check that
 * stopped early while the buyer's proof was already corroborated, a check that stopped early
 * while the resolvers disagreed, and a corroborated set holding a token that differs from the
 * expected one by a single hex digit.
 *
 * WHAT IS DELIBERATELY NOT HERE. `MOCK_PARAMETERS` leaves `max_deal_value_wei`,
 * `min_nameservers` and `max_nameservers` empty. Those three are limits the contract enforces
 * on a signed transaction, and `data-source.ts` refuses rather than answering for them. A form
 * validated against a figure this repository holds would pass in the browser and be refused on
 * chain after taking a signature.
 *
 * THE DOMAINS ARE INVENTED, AND THAT IS THE CAREFUL CHOICE RATHER THAN THE LAZY ONE. A fixture
 * that named a real registered domain would be asserting that somebody's property is sitting in
 * escrow between two addresses for a sum, which is a false statement about a real registrant
 * even inside a demo. The TLDs are real because the fixtures have to exercise a different RDAP
 * base per registry, and the registrar ids are real IANA ids for the same reason. What is
 * invented is which name is in which deal. `dataProvenance()` says so in the page header, not in
 * a footnote.
 */

import type { Deal, Ledger, Parameters, Probe } from "@/lib/contract-types";

/** The fixed instant every countdown on the fixture pages is measured from. */
export const MOCK_NOW = "2026-08-30T11:00:00Z";

/* -------------------------------------------------------------------------- */
/* Parties                                                                    */
/* -------------------------------------------------------------------------- */

const B1 = "0x9c1f4b2e7a6d508c3f21b9084e7d6a5c1f0b3e82";
const B2 = "0x4d7e0a915c3b862f04a1d7e58b96c203f4a8d17b";
const B3 = "0xe20b58c7143f9a6d05e8b21c47d3f96a08b5e1c4";
const S1 = "0x71a3e9c05d2b846f17c0a95e3b8d24f6019c7ea5";
const S2 = "0x0f5c82d61b9e347a08d5f2c94e1b673a20d8c9f1";
const S3 = "0xb84d1f720c6a395e8f1d04b72c9a5e638d0f17b2";
const S4 = "0x2e91c04a7d5f83b160e2a9c48f7d15b309e6a2d8";

/* -------------------------------------------------------------------------- */
/* Registries and registrars                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The RDAP base for each TLD used below, as the IANA bootstrap publishes it.
 *
 * Stored on the deal rather than derived at read time, because that is what the contract does:
 * `open_deal` records the base it resolved and `_delivery_block` re-derives it from a fresh
 * bootstrap on every check, refusing `[TRANSIENT]` if the map moved.
 */
const BASE = {
  com: "https://rdap.verisign.com/com/v1/",
  net: "https://rdap.verisign.com/net/v1/",
  org: "https://rdap.publicinterestregistry.org/rdap/",
  io: "https://rdap.identitydigital.services/rdap/",
  dev: "https://www.registry.google/rdap/",
  app: "https://www.registry.google/rdap/",
  xyz: "https://rdap.centralnic.com/xyz/",
};

// IANA registrar ids, which is what the contract compares. The names beside them are carried
// for display only and are deliberately outside `digest`: registrars rename and resell, and a
// display string moving is not a transfer.
const GODADDY = "146";
const NAMECHEAP = "1068";
const TUCOWS = "69";
const GANDI = "81";
const CLOUDFLARE = "1910";
const PORKBUN = "1861";
const DYNADOT = "472";
const SQUARESPACE = "895";

const REGISTRAR_NAME: Record<string, string> = {
  [GODADDY]: "GoDaddy.com, LLC",
  [NAMECHEAP]: "NameCheap, Inc.",
  [TUCOWS]: "Tucows Domains Inc.",
  [GANDI]: "Gandi SAS",
  [CLOUDFLARE]: "Cloudflare, Inc.",
  [PORKBUN]: "Porkbun LLC",
  [DYNADOT]: "Dynadot Inc",
  [SQUARESPACE]: "Squarespace Domains II LLC",
};

const CLOUDFLARE_NS = "ada.ns.cloudflare.com,kirk.ns.cloudflare.com";
const PORKBUN_NS = "curitiba.ns.porkbun.com,fortaleza.ns.porkbun.com";
const DYNADOT_NS = "ns1.dynadot.com,ns2.dynadot.com";

/* -------------------------------------------------------------------------- */
/* Fixture digests                                                            */
/* -------------------------------------------------------------------------- */

/**
 * A stable 64-hex string from a label. NOT sha256 of anything.
 *
 * Written as an expansion rather than as thirty pasted constants for two reasons. It cannot be
 * miscounted, and it cannot be mistaken for a real digest a reader might try to verify. Live,
 * `rdap_digest` and `control_proof_digest` compute the real ones inside consensus over the
 * canonical form, and those are the only digests in this product that mean anything.
 */
function fixtureDigest(label: string): string {
  let a = 0x811c9dc5;
  let out = "";
  for (let round = 0; out.length < 64; round += 1) {
    for (let i = 0; i < label.length; i += 1) {
      a = (a ^ (label.charCodeAt(i) + round)) >>> 0;
      a = (a * 0x01000193) >>> 0;
    }
    out += a.toString(16).padStart(8, "0");
  }
  return out.slice(0, 64);
}

/* -------------------------------------------------------------------------- */
/* The factory                                                               */
/* -------------------------------------------------------------------------- */

type Opened = {
  id: string;
  domain: string;
  buyer: string;
  seller: string;
  escrow: string;
  openedAt: string;
  acceptDeadline: string;
  targetRegistrar: string;
  targetNameservers: string;
  baselineRegistrar: string;
  baselineNameservers: string;
  baselineStatuses: string;
  baselineTransferAt: string;
  baselineLastChangedAt: string;
  /** True when the registry publishes `client transfer prohibited`, which the losing
   *  registrar can lift and must, before a transfer can start. */
  clientLocked?: boolean;
};

const tldOf = (domain: string) => domain.split(".").pop() as keyof typeof BASE;

/**
 * A deal exactly as `open_deal` leaves it: OFFERED, one baseline frozen, nothing checked.
 *
 * The proof names and the seller's token are derived here the same way the contract derives
 * them, from the label constants and the deal id, so a fixture cannot carry a token shape the
 * contract would refuse.
 */
function openDeal(o: Opened): Deal {
  return {
    deal_id: o.id,
    state: "OFFERED",
    buyer: o.buyer,
    seller: o.seller,
    domain: o.domain,
    tld: tldOf(o.domain),
    rdap_base: BASE[tldOf(o.domain)],

    target_registrar_id: o.targetRegistrar,
    target_nameservers: o.targetNameservers,

    seller_proof_name: `_conveyance-seller.${o.domain}`,
    seller_proof_token: `v1;deal=${o.id};seller=${o.seller}`,
    buyer_proof_name: `_conveyance-buyer.${o.domain}`,
    buyer_proof_commitment: fixtureDigest(`commitment:${o.id}`),
    buyer_proof_revealed: "False",

    escrow: o.escrow,

    opened_at: o.openedAt,
    accept_deadline: o.acceptDeadline,
    armed_at: "",
    transfer_deadline: "",
    verified_at: "",
    inspection_deadline: "",
    closed_at: "",

    baseline_registrar_id: o.baselineRegistrar,
    baseline_registrar_name: REGISTRAR_NAME[o.baselineRegistrar] ?? "",
    baseline_nameservers: o.baselineNameservers,
    baseline_statuses: o.baselineStatuses,
    baseline_transfer_at: o.baselineTransferAt,
    baseline_last_changed_at: o.baselineLastChangedAt,
    baseline_digest: fixtureDigest(`baseline:${o.id}`),
    baseline_client_transfer_locked: o.clientLocked ? "True" : "False",

    checks: "0",
    last_check_at: "",
    last_check_outcome: "",
    last_check_note: "",
    last_check_registrar_id: "",
    last_check_nameservers: "",
    last_check_statuses: "",
    last_check_transfer_at: "",
    last_check_digest: "",
    last_proof_outcome: "",
    last_proof_values: "",

    delivered_registrar_id: "",
    delivered_transfer_at: "",
    delivered_digest: "",
    delivered_proof_digest: "",

    paid_to_seller: "0",
    returned_to_buyer: "0",
  };
}

/** What `arm` writes: LOCKED, the transfer clock started, nothing observed yet. */
function armed(deal: Deal, armedAt: string, transferDeadline: string): Deal {
  return {
    ...deal,
    state: "LOCKED",
    armed_at: armedAt,
    transfer_deadline: transferDeadline,
    // `arm` raises unless the seller's proof is FOUND, so a LOCKED deal always got there
    // through a corroborated seller proof. The field then carries that until the first check
    // overwrites it, which is why an armed-but-unchecked deal reads PROOF_FOUND.
    last_proof_outcome: "PROOF_FOUND",
    last_proof_values: deal.seller_proof_token,
  };
}

/* -------------------------------------------------------------------------- */
/* The register                                                               */
/* -------------------------------------------------------------------------- */

/* 1 -------------------------------------------------------------------------
 * Fresh offer, nothing armed, no check. The unstruck seal, and the only fixture whose
 * `baseline_transfer_at` is empty, which is the "(none)" branch of the transfer-event note.
 */
const D1088 = openDeal({
  id: "CVY-1088",
  domain: "ledgerline.com",
  buyer: B1,
  seller: S1,
  escrow: "4500000000000000000",
  openedAt: "2026-08-30T06:41:12Z",
  acceptDeadline: "2026-09-01T06:41:12Z",
  targetRegistrar: CLOUDFLARE,
  targetNameservers: CLOUDFLARE_NS,
  baselineRegistrar: GODADDY,
  baselineNameservers: "ns53.domaincontrol.com,ns54.domaincontrol.com",
  baselineStatuses: "client delete prohibited,client renew prohibited,client update prohibited",
  baselineTransferAt: "",
  baselineLastChangedAt: "2026-07-19T04:22:08Z",
});

/* 2 -------------------------------------------------------------------------
 * An offer with two and a half hours of accept window left, on a domain the registry reports
 * as transfer prohibited. Both facts are on the deal and both belong on the page: the seller
 * has to get the lock lifted AND arm, and only one of those is a contract call.
 */
const D1087 = openDeal({
  id: "CVY-1087",
  domain: "harborstack.io",
  buyer: B2,
  seller: S2,
  escrow: "12000000000000000000",
  openedAt: "2026-08-28T13:30:00Z",
  acceptDeadline: "2026-08-30T13:30:00Z",
  targetRegistrar: CLOUDFLARE,
  targetNameservers: CLOUDFLARE_NS,
  baselineRegistrar: NAMECHEAP,
  baselineNameservers: "dns1.registrar-servers.com,dns2.registrar-servers.com",
  baselineStatuses: "client transfer prohibited",
  baselineTransferAt: "2025-03-11T17:02:44Z",
  baselineLastChangedAt: "2026-02-27T20:15:31Z",
  clientLocked: true,
});

/* 3 -------------------------------------------------------------------------
 * SUSPENDED. A client hold, which pulls the domain out of the DNS root zone. The first
 * condition is where the check stopped, so the second was not what the decision rested on,
 * and the third is drawn from the proof the same round recorded.
 */
const D1086: Deal = {
  ...armed(
    openDeal({
      id: "CVY-1086",
      domain: "mistral-forge.net",
      buyer: B1,
      seller: S3,
      escrow: "2200000000000000000",
      openedAt: "2026-08-24T09:05:31Z",
      acceptDeadline: "2026-08-26T09:05:31Z",
      targetRegistrar: PORKBUN,
      targetNameservers: PORKBUN_NS,
      baselineRegistrar: TUCOWS,
      baselineNameservers: "ns1.easydns.com,ns2.easydns.net",
      baselineStatuses: "client transfer prohibited",
      baselineTransferAt: "2024-11-30T12:00:03Z",
      baselineLastChangedAt: "2026-06-04T18:44:20Z",
      clientLocked: true,
    }),
    "2026-08-24T15:48:02Z",
    "2026-09-03T15:48:02Z",
  ),
  checks: "3",
  last_check_at: "2026-08-30T10:41:19Z",
  last_check_outcome: "SUSPENDED",
  last_check_note: "the registry reports a client hold, which removes the domain from DNS",
  last_check_registrar_id: TUCOWS,
  last_check_nameservers: "ns1.easydns.com,ns2.easydns.net",
  last_check_statuses: "client hold,client transfer prohibited",
  last_check_transfer_at: "2024-11-30T12:00:03Z",
  last_check_digest: fixtureDigest("check:CVY-1086:3"),
  last_proof_outcome: "PROOF_NAME_MISSING",
  last_proof_values: "",
};

/* 4 -------------------------------------------------------------------------
 * PENDING_TRANSFER, with the resolvers disagreeing in the same round.
 *
 * The fixture that exists because `PROOF_ABSENT` means two things. Here the record set is
 * empty, which on chain means the two resolvers never matched, and the honest reading is a
 * fact about propagation rather than about the buyer's zone. Mid-transfer is exactly when
 * that happens, so this is where it belongs.
 */
const D1085: Deal = {
  ...armed(
    openDeal({
      id: "CVY-1085",
      domain: "quietharbor.org",
      buyer: B3,
      seller: S1,
      escrow: "8000000000000000000",
      openedAt: "2026-08-26T22:40:11Z",
      acceptDeadline: "2026-08-28T22:40:11Z",
      targetRegistrar: DYNADOT,
      targetNameservers: DYNADOT_NS,
      baselineRegistrar: GODADDY,
      baselineNameservers: "ns17.domaincontrol.com,ns18.domaincontrol.com",
      baselineStatuses: "client transfer prohibited,client update prohibited",
      baselineTransferAt: "2022-09-14T07:31:52Z",
      baselineLastChangedAt: "2026-08-27T09:03:18Z",
    }),
    "2026-08-27T08:12:00Z",
    "2026-09-06T08:12:00Z",
  ),
  checks: "5",
  last_check_at: "2026-08-30T10:55:04Z",
  last_check_outcome: "PENDING_TRANSFER",
  last_check_note:
    "the registry reports 'pending transfer', so a transfer is in flight and has not completed",
  last_check_registrar_id: GODADDY,
  last_check_nameservers: "ns17.domaincontrol.com,ns18.domaincontrol.com",
  last_check_statuses: "active,pending transfer",
  last_check_transfer_at: "2022-09-14T07:31:52Z",
  last_check_digest: fixtureDigest("check:CVY-1085:5"),
  last_proof_outcome: "PROOF_ABSENT",
  last_proof_values: "",
};

/* 5 -------------------------------------------------------------------------
 * AWAITING_TRANSFER on the sponsoring registrar. The plain case: the domain has not moved,
 * and the buyer has published nothing yet.
 */
const D1084: Deal = {
  ...armed(
    openDeal({
      id: "CVY-1084",
      domain: "pallasfund.com",
      buyer: B1,
      seller: S2,
      escrow: "28000000000000000000",
      openedAt: "2026-08-29T14:52:07Z",
      acceptDeadline: "2026-08-31T14:52:07Z",
      targetRegistrar: CLOUDFLARE,
      targetNameservers: CLOUDFLARE_NS,
      baselineRegistrar: GODADDY,
      baselineNameservers: "ns09.domaincontrol.com,ns10.domaincontrol.com",
      baselineStatuses: "client delete prohibited,client transfer prohibited",
      baselineTransferAt: "2023-06-02T10:11:55Z",
      baselineLastChangedAt: "2026-08-01T12:19:44Z",
      clientLocked: true,
    }),
    "2026-08-29T19:04:44Z",
    "2026-09-08T19:04:44Z",
  ),
  checks: "2",
  last_check_at: "2026-08-30T09:58:12Z",
  last_check_outcome: "AWAITING_TRANSFER",
  last_check_note:
    "the sponsoring registrar is IANA id 146, and this deal is for a transfer to 1910",
  last_check_registrar_id: GODADDY,
  last_check_nameservers: "ns09.domaincontrol.com,ns10.domaincontrol.com",
  last_check_statuses: "client delete prohibited,client transfer prohibited",
  last_check_transfer_at: "2023-06-02T10:11:55Z",
  last_check_digest: fixtureDigest("check:CVY-1084:2"),
  last_proof_outcome: "PROOF_NAME_MISSING",
  last_proof_values: "",
};

/* 6 -------------------------------------------------------------------------
 * AWAITING_TRANSFER on the transfer EVENT, with the buyer's proof already corroborated.
 *
 * The domain is at the target registrar and delegates to the buyer's own nameservers, so the
 * buyer could and did publish. What is missing is the registry's transfer event, which is the
 * second of the two questions the middle segment covers. This is the fixture that proves the
 * seal has to read the recorded proof outcome rather than infer it from where the check
 * stopped: inferring would draw a blank third arc over a corroborated record set.
 */
const D1083: Deal = {
  ...armed(
    openDeal({
      id: "CVY-1083",
      domain: "slateroom.dev",
      buyer: B2,
      seller: S3,
      escrow: "6400000000000000000",
      openedAt: "2026-08-26T06:18:40Z",
      acceptDeadline: "2026-08-28T06:18:40Z",
      targetRegistrar: CLOUDFLARE,
      targetNameservers: CLOUDFLARE_NS,
      baselineRegistrar: GANDI,
      baselineNameservers: "ns-1.gandi.net,ns-2.gandi.net",
      baselineStatuses: "client transfer prohibited",
      baselineTransferAt: "2026-05-02T08:14:11Z",
      baselineLastChangedAt: "2026-05-02T08:14:11Z",
      clientLocked: true,
    }),
    "2026-08-26T11:20:15Z",
    "2026-09-05T11:20:15Z",
  ),
  checks: "7",
  last_check_at: "2026-08-30T10:12:33Z",
  last_check_outcome: "AWAITING_TRANSFER",
  last_check_note:
    "the domain is at the target registrar but the registry has published no transfer event later than the 2026-05-02T08:14:11Z recorded when this deal opened",
  last_check_registrar_id: CLOUDFLARE,
  last_check_nameservers: CLOUDFLARE_NS,
  last_check_statuses: "active",
  last_check_transfer_at: "2026-05-02T08:14:11Z",
  last_check_digest: fixtureDigest("check:CVY-1083:7"),
  last_proof_outcome: "PROOF_FOUND",
  last_proof_values: `v1;deal=CVY-1083;buyer=${B2}`,
  buyer_proof_revealed: "True",
};

/* 7 -------------------------------------------------------------------------
 * AWAITING_DELEGATION, and the name still answers from the losing host's zone.
 *
 * The record set on chain is what that zone publishes, and the deal's token is not in it. Two
 * resolvers agreed on it, which is what a non-empty set means, so this is a real statement
 * about the zone and not a propagation artefact.
 */
const D1082: Deal = {
  ...armed(
    openDeal({
      id: "CVY-1082",
      domain: "northfold.app",
      buyer: B3,
      seller: S4,
      escrow: "17000000000000000000",
      openedAt: "2026-08-25T03:10:52Z",
      acceptDeadline: "2026-08-27T03:10:52Z",
      targetRegistrar: CLOUDFLARE,
      targetNameservers: CLOUDFLARE_NS,
      baselineRegistrar: SQUARESPACE,
      baselineNameservers: "ns1.oldhost.example,ns2.oldhost.example",
      baselineStatuses: "client transfer prohibited",
      baselineTransferAt: "2026-01-14T06:50:22Z",
      baselineLastChangedAt: "2026-01-14T06:50:22Z",
      clientLocked: true,
    }),
    "2026-08-25T07:33:09Z",
    "2026-09-04T07:33:09Z",
  ),
  checks: "4",
  last_check_at: "2026-08-30T10:30:00Z",
  last_check_outcome: "AWAITING_DELEGATION",
  last_check_note:
    "the domain delegates to ns1.oldhost.example,ns2.oldhost.example, and this deal names ada.ns.cloudflare.com,kirk.ns.cloudflare.com",
  last_check_registrar_id: CLOUDFLARE,
  last_check_nameservers: "ns1.oldhost.example,ns2.oldhost.example",
  last_check_statuses: "active",
  last_check_transfer_at: "2026-08-29T22:41:07Z",
  last_check_digest: fixtureDigest("check:CVY-1082:4"),
  last_proof_outcome: "PROOF_ABSENT",
  last_proof_values: "v=spf1 include:_spf.oldhost.example -all",
};

/* 8 -------------------------------------------------------------------------
 * AWAITING_DNS with the name absent at both resolvers. Two of three engraved, and the note
 * carries the `[EXTERNAL]` tag the contract wrote at the front of it.
 */
const D1081: Deal = {
  ...armed(
    openDeal({
      id: "CVY-1081",
      domain: "vellumtype.com",
      buyer: B1,
      seller: S4,
      escrow: "1500000000000000000",
      openedAt: "2026-08-22T09:47:26Z",
      acceptDeadline: "2026-08-24T09:47:26Z",
      targetRegistrar: PORKBUN,
      targetNameservers: PORKBUN_NS,
      baselineRegistrar: NAMECHEAP,
      baselineNameservers: "dns1.registrar-servers.com,dns2.registrar-servers.com",
      baselineStatuses: "client transfer prohibited",
      baselineTransferAt: "2021-04-08T15:22:39Z",
      baselineLastChangedAt: "2026-08-22T18:41:03Z",
      clientLocked: true,
    }),
    "2026-08-22T16:00:00Z",
    "2026-09-01T16:00:00Z",
  ),
  checks: "11",
  last_check_at: "2026-08-30T10:47:52Z",
  last_check_outcome: "AWAITING_DNS",
  last_check_note:
    "[EXTERNAL] every resolver returned NXDOMAIN, so the name does not exist and nothing was observed",
  last_check_registrar_id: PORKBUN,
  last_check_nameservers: PORKBUN_NS,
  last_check_statuses: "active",
  last_check_transfer_at: "2026-08-25T11:09:44Z",
  last_check_digest: fixtureDigest("check:CVY-1081:11"),
  last_proof_outcome: "PROOF_NAME_MISSING",
  last_proof_values: "",
};

/* 9 -------------------------------------------------------------------------
 * AWAITING_DNS with a corroborated set holding the wrong token.
 *
 * The published token differs from the expected one in its final hex digit. This is the
 * fixture that makes the case for printing the whole set beside the expected value instead of
 * printing a verdict: the verdict says "absent", and only the two strings side by side say
 * why. The tag is `[TRANSIENT]` because a set that agrees today may still be propagating.
 */
const D1080: Deal = {
  ...armed(
    openDeal({
      id: "CVY-1080",
      domain: "orrery.xyz",
      buyer: B2,
      seller: S1,
      escrow: "750000000000000000",
      openedAt: "2026-08-28T01:02:15Z",
      acceptDeadline: "2026-08-30T01:02:15Z",
      targetRegistrar: CLOUDFLARE,
      targetNameservers: CLOUDFLARE_NS,
      baselineRegistrar: DYNADOT,
      baselineNameservers: "ns1.dynadot.com,ns2.dynadot.com",
      baselineStatuses: "client transfer prohibited",
      baselineTransferAt: "2025-11-19T13:50:07Z",
      baselineLastChangedAt: "2026-08-28T04:12:55Z",
      clientLocked: true,
    }),
    "2026-08-28T05:15:20Z",
    "2026-09-07T05:15:20Z",
  ),
  checks: "6",
  last_check_at: "2026-08-30T10:20:41Z",
  last_check_outcome: "AWAITING_DNS",
  last_check_note:
    "[TRANSIENT] both resolvers agree on the TXT set and the expected token is not in it, which is an absent proof and may be incomplete propagation",
  last_check_registrar_id: CLOUDFLARE,
  last_check_nameservers: CLOUDFLARE_NS,
  last_check_statuses: "active",
  last_check_transfer_at: "2026-08-29T08:33:12Z",
  last_check_digest: fixtureDigest("check:CVY-1080:6"),
  last_proof_outcome: "PROOF_ABSENT",
  last_proof_values: "v1;deal=CVY-1080;buyer=0x4d7e0a915c3b862f04a1d7e58b96c203f4a8d17c",
};

/* 10 ------------------------------------------------------------------------
 * The transfer window has closed with no delivery ever observed, and the deal is still
 * LOCKED. Anyone at all may press refund, which is the door that makes the deadline mean
 * something without a cron. Thirty-one checks, all of them recorded, none of them a delivery.
 */
const D1079: Deal = {
  ...armed(
    openDeal({
      id: "CVY-1079",
      domain: "brightlot.io",
      buyer: B3,
      seller: S2,
      escrow: "33000000000000000000",
      openedAt: "2026-08-18T07:22:41Z",
      acceptDeadline: "2026-08-20T07:22:41Z",
      targetRegistrar: CLOUDFLARE,
      targetNameservers: CLOUDFLARE_NS,
      baselineRegistrar: SQUARESPACE,
      baselineNameservers: "ns1.squarespacedns.com,ns2.squarespacedns.com",
      baselineStatuses: "client transfer prohibited",
      baselineTransferAt: "2024-02-06T09:14:30Z",
      baselineLastChangedAt: "2026-07-30T22:07:19Z",
      clientLocked: true,
    }),
    "2026-08-18T12:00:00Z",
    "2026-08-28T12:00:00Z",
  ),
  checks: "31",
  last_check_at: "2026-08-30T10:05:00Z",
  last_check_outcome: "AWAITING_TRANSFER",
  last_check_note:
    "the sponsoring registrar is IANA id 895, and this deal is for a transfer to 1910",
  last_check_registrar_id: SQUARESPACE,
  last_check_nameservers: "ns1.squarespacedns.com,ns2.squarespacedns.com",
  last_check_statuses: "client transfer prohibited",
  last_check_transfer_at: "2024-02-06T09:14:30Z",
  last_check_digest: fixtureDigest("check:CVY-1079:31"),
  last_proof_outcome: "PROOF_NAME_MISSING",
  last_proof_values: "",
};

/* 11 ------------------------------------------------------------------------
 * VERIFIED, inside the inspection window. The seal is closed, the buyer may settle now, and
 * anyone may settle once the window closes. The largest escrow in the register, five GEN
 * under the ceiling the contract enforces.
 */
const D1078: Deal = {
  ...armed(
    openDeal({
      id: "CVY-1078",
      domain: "cairnstone.com",
      buyer: B1,
      seller: S3,
      escrow: "95000000000000000000",
      openedAt: "2026-08-20T05:31:08Z",
      acceptDeadline: "2026-08-22T05:31:08Z",
      targetRegistrar: CLOUDFLARE,
      targetNameservers: CLOUDFLARE_NS,
      baselineRegistrar: GANDI,
      baselineNameservers: "ns-1.gandi.net,ns-2.gandi.net",
      baselineStatuses: "client transfer prohibited",
      baselineTransferAt: "2020-07-21T11:45:02Z",
      baselineLastChangedAt: "2026-08-21T16:28:37Z",
      clientLocked: true,
    }),
    "2026-08-20T10:00:00Z",
    "2026-08-30T10:00:00Z",
  ),
  state: "VERIFIED",
  verified_at: "2026-08-29T18:22:41Z",
  inspection_deadline: "2026-09-01T18:22:41Z",
  checks: "9",
  last_check_at: "2026-08-29T18:22:41Z",
  last_check_outcome: "VERIFIED",
  last_check_note:
    "the registry reports the transfer to IANA id 1910 at 2026-08-29T17:40:12Z, the delegation matches, and both resolvers see the buyer's control proof",
  last_check_registrar_id: CLOUDFLARE,
  last_check_nameservers: CLOUDFLARE_NS,
  last_check_statuses: "active",
  last_check_transfer_at: "2026-08-29T17:40:12Z",
  last_check_digest: fixtureDigest("check:CVY-1078:9"),
  last_proof_outcome: "PROOF_FOUND",
  last_proof_values: `v1;deal=CVY-1078;buyer=${B1}`,
  buyer_proof_revealed: "True",
  delivered_registrar_id: CLOUDFLARE,
  delivered_transfer_at: "2026-08-29T17:40:12Z",
  delivered_digest: fixtureDigest("check:CVY-1078:9"),
  delivered_proof_digest: fixtureDigest("proof:CVY-1078"),
};

/* 12 ------------------------------------------------------------------------
 * VERIFIED, with a later check on record. Delivery is final once verified, so this later check
 * only adds a row to `checks` and a fresh `last_check_*` snapshot; it never moves the state,
 * however different the registrar or proof it observed might look from the delivery itself.
 */
const D1077: Deal = {
  ...armed(
    openDeal({
      id: "CVY-1077",
      domain: "halfmoon.io",
      buyer: B2,
      seller: S4,
      escrow: "60000000000000000000",
      openedAt: "2026-08-19T09:58:14Z",
      acceptDeadline: "2026-08-21T09:58:14Z",
      targetRegistrar: CLOUDFLARE,
      targetNameservers: CLOUDFLARE_NS,
      baselineRegistrar: GANDI,
      baselineNameservers: "ns-1.gandi.net,ns-2.gandi.net",
      baselineStatuses: "client transfer prohibited",
      baselineTransferAt: "2023-12-01T08:20:41Z",
      baselineLastChangedAt: "2026-08-20T13:14:09Z",
      clientLocked: true,
    }),
    "2026-08-19T14:30:00Z",
    "2026-08-29T14:30:00Z",
  ),
  state: "VERIFIED",
  verified_at: "2026-08-28T09:11:03Z",
  inspection_deadline: "2026-08-31T09:11:03Z",
  checks: "14",
  last_check_at: "2026-08-30T09:44:18Z",
  last_check_outcome: "VERIFIED",
  last_check_note:
    "delivery still stands as of 2026-08-30T09:44:18Z. The buyer may settle now, and anyone may settle from 2026-08-31T09:11:03Z.",
  last_check_registrar_id: CLOUDFLARE,
  last_check_nameservers: CLOUDFLARE_NS,
  last_check_statuses: "client delete prohibited,client update prohibited",
  last_check_transfer_at: "2026-08-27T21:36:50Z",
  last_check_digest: fixtureDigest("check:CVY-1077:14"),
  last_proof_outcome: "PROOF_FOUND",
  last_proof_values: `v1;deal=CVY-1077;buyer=${B2}`,
  buyer_proof_revealed: "True",
  delivered_registrar_id: CLOUDFLARE,
  delivered_transfer_at: "2026-08-27T21:36:50Z",
  delivered_digest: fixtureDigest("check:CVY-1077:12"),
  delivered_proof_digest: fixtureDigest("proof:CVY-1077"),
};

/* 13 ------------------------------------------------------------------------
 * RELEASED. The buyer settled inside their own inspection window, two and a half hours after
 * the delivery was accepted, so `closed_at` is earlier than `inspection_deadline`.
 */
const D1076: Deal = {
  ...armed(
    openDeal({
      id: "CVY-1076",
      domain: "tinderbox.net",
      buyer: B3,
      seller: S3,
      escrow: "3000000000000000000",
      openedAt: "2026-08-21T12:04:33Z",
      acceptDeadline: "2026-08-23T12:04:33Z",
      targetRegistrar: PORKBUN,
      targetNameservers: PORKBUN_NS,
      baselineRegistrar: TUCOWS,
      baselineNameservers: "ns1.easydns.com,ns2.easydns.net",
      baselineStatuses: "client transfer prohibited",
      baselineTransferAt: "2022-03-17T06:41:28Z",
      baselineLastChangedAt: "2026-08-22T19:50:16Z",
      clientLocked: true,
    }),
    "2026-08-21T17:12:09Z",
    "2026-08-31T17:12:09Z",
  ),
  state: "RELEASED",
  verified_at: "2026-08-26T13:05:44Z",
  inspection_deadline: "2026-08-29T13:05:44Z",
  closed_at: "2026-08-26T15:40:12Z",
  checks: "8",
  last_check_at: "2026-08-26T13:05:44Z",
  last_check_outcome: "VERIFIED",
  last_check_note:
    "the registry reports the transfer to IANA id 1861 at 2026-08-26T11:58:20Z, the delegation matches, and both resolvers see the buyer's control proof",
  last_check_registrar_id: PORKBUN,
  last_check_nameservers: PORKBUN_NS,
  last_check_statuses: "active",
  last_check_transfer_at: "2026-08-26T11:58:20Z",
  last_check_digest: fixtureDigest("check:CVY-1076:8"),
  last_proof_outcome: "PROOF_FOUND",
  last_proof_values: `v1;deal=CVY-1076;buyer=${B3}`,
  buyer_proof_revealed: "True",
  delivered_registrar_id: PORKBUN,
  delivered_transfer_at: "2026-08-26T11:58:20Z",
  delivered_digest: fixtureDigest("check:CVY-1076:8"),
  delivered_proof_digest: fixtureDigest("proof:CVY-1076"),
  paid_to_seller: "3000000000000000000",
};

/* 14 ------------------------------------------------------------------------
 * REFUNDED. Nineteen checks over ten days, none of which ever saw the domain leave the
 * losing registrar, and then somebody pressed refund thirty-four minutes after the transfer
 * window closed. The seal is left as the last check drew it, because a refund is not a
 * finding about the domain.
 */
const D1075: Deal = {
  ...armed(
    openDeal({
      id: "CVY-1075",
      domain: "greyparade.org",
      buyer: B1,
      seller: S2,
      escrow: "400000000000000000",
      openedAt: "2026-08-08T06:15:44Z",
      acceptDeadline: "2026-08-10T06:15:44Z",
      targetRegistrar: DYNADOT,
      targetNameservers: DYNADOT_NS,
      baselineRegistrar: GODADDY,
      baselineNameservers: "ns41.domaincontrol.com,ns42.domaincontrol.com",
      baselineStatuses: "client transfer prohibited",
      baselineTransferAt: "2019-10-25T14:07:11Z",
      baselineLastChangedAt: "2026-08-09T10:33:02Z",
      clientLocked: true,
    }),
    "2026-08-08T11:00:00Z",
    "2026-08-18T11:00:00Z",
  ),
  state: "REFUNDED",
  closed_at: "2026-08-18T11:34:52Z",
  checks: "19",
  last_check_at: "2026-08-18T10:52:30Z",
  last_check_outcome: "AWAITING_TRANSFER",
  last_check_note:
    "the sponsoring registrar is IANA id 146, and this deal is for a transfer to 472",
  last_check_registrar_id: GODADDY,
  last_check_nameservers: "ns41.domaincontrol.com,ns42.domaincontrol.com",
  last_check_statuses: "client transfer prohibited",
  last_check_transfer_at: "2019-10-25T14:07:11Z",
  last_check_digest: fixtureDigest("check:CVY-1075:19"),
  last_proof_outcome: "PROOF_NAME_MISSING",
  last_proof_values: "",
  returned_to_buyer: "400000000000000000",
};

/**
 * The register, newest first, which is the order `list_deals` produces reversed.
 *
 * `deal_ids` on chain appends, so `list_deals` returns oldest first. The register reverses it
 * for display and says so on the page, rather than pretending the contract stores it this way.
 */
export const MOCK_DEALS: Deal[] = [
  D1088,
  D1087,
  D1086,
  D1085,
  D1084,
  D1083,
  D1082,
  D1081,
  D1080,
  D1079,
  D1078,
  D1077,
  D1076,
  D1075,
];

/* -------------------------------------------------------------------------- */
/* The ledger                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Escrow conservation, and it adds up.
 *
 * 271.75 GEN escrowed across fourteen deals, 3 released on CVY-1076, 0.4 refunded on
 * CVY-1075, and 268.35 still held against the twelve that are live. `balance` matches `held`
 * here because nothing is wrong; the contract reports both precisely so that the case where
 * they differ is visible instead of hidden behind whichever number looks better.
 *
 * `deliveries_verified` is 3 and not 1: CVY-1078 is verified now, CVY-1077 was verified before
 * it reversed, and CVY-1076 was verified before it settled. The counter records deliveries
 * that happened, not deals currently in the VERIFIED state.
 */
export const MOCK_LEDGER: Ledger = {
  total_escrowed: "271750000000000000000",
  total_released: "3000000000000000000",
  total_refunded: "400000000000000000",
  held: "268350000000000000000",
  balance: "268350000000000000000",
  deals_opened: "14",
  checks_run: "119",
  deliveries_verified: "3",
  protocol_fee: "0",
};

/* -------------------------------------------------------------------------- */
/* Parameters                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The contract's own constants, with three left empty on purpose.
 *
 * `max_deal_value_wei`, `min_nameservers` and `max_nameservers` are the three a form would
 * validate against before asking for a signature, and they are the three this file refuses to
 * answer for. `priceCap()` and `nameserverBounds()` in `data-source.ts` turn the empty string
 * into a refusal with the reason printed, so a fixture-mode form declines to validate rather
 * than validating against a number that came from this repository instead of from the chain.
 *
 * `uses_a_model` is "false" and that is not an oversight. There is no model in this contract.
 * Every consensus block is `gl.eq_principle.strict_eq` over public records.
 */
export const MOCK_PARAMETERS: Parameters = {
  iana_bootstrap_url: "https://data.iana.org/rdap/dns.json",
  seller_proof_label: "_conveyance-seller",
  buyer_proof_label: "_conveyance-buyer",
  proof_version: "v1",
  accept_window_seconds: "172800",
  transfer_window_seconds: "864000",
  inspection_window_seconds: "259200",
  check_interval_seconds: "300",
  max_deal_value_wei: "",
  min_nameservers: "",
  max_nameservers: "",
  resolvers: "cloudflare,google",
  embedded_function_count: "40",
  uses_a_model: "false",
  boundary:
    "Conveyance verifies public transfer signals and operational DNS control. It does not prove legal title, beneficial ownership, the identity of a private registrant, or that a registrar account has no retained delegates.",
};

/* -------------------------------------------------------------------------- */
/* Probes                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Rehearsals of `probe_domain`, for the open form in fixture mode.
 *
 * `probe_domain` is a write, because it fetches, and a view that fetches has no consensus
 * behind its answer. So there is no read to fall back to and these are not standing in for
 * one: they are canned answers for a form that cannot sign anything in fixture mode. Live,
 * the form sends the write and decodes the receipt through `decodeProbe`.
 *
 * Three domains, chosen so the form's three branches all have something to render: a name
 * that can be escrowed, a name that can be escrowed but carries a client transfer lock the
 * losing registrar has to lift first, and a name that cannot be escrowed at all.
 */
export const MOCK_PROBES: Probe[] = [
  {
    domain: "sablefield.net",
    rdap_base: BASE.net,
    registrar_iana_id: TUCOWS,
    registrar_name: REGISTRAR_NAME[TUCOWS],
    nameservers: "ns1.easydns.com,ns2.easydns.net",
    statuses: "active",
    registration_at: "2014-05-30T18:22:04Z",
    expiration_at: "2027-05-30T18:22:04Z",
    last_changed_at: "2026-06-11T09:41:37Z",
    transfer_at: "2021-08-02T13:15:49Z",
    transfer_locked: "False",
    transfer_lock_setters: "",
    pending_transfer: "False",
    digest: fixtureDigest("probe:sablefield.net"),
    seller_proof_name: "_conveyance-seller.sablefield.net",
    buyer_proof_name: "_conveyance-buyer.sablefield.net",
    escrowable: "True",
  },
  {
    domain: "wintergreen.com",
    rdap_base: BASE.com,
    registrar_iana_id: GODADDY,
    registrar_name: REGISTRAR_NAME[GODADDY],
    nameservers: "ns31.domaincontrol.com,ns32.domaincontrol.com",
    statuses: "client delete prohibited,client renew prohibited,client transfer prohibited,client update prohibited",
    registration_at: "2003-11-14T07:00:00Z",
    expiration_at: "2027-11-14T07:00:00Z",
    last_changed_at: "2026-08-12T22:05:18Z",
    transfer_at: "2018-01-09T16:44:22Z",
    transfer_locked: "True",
    transfer_lock_setters: "client",
    pending_transfer: "False",
    digest: fixtureDigest("probe:wintergreen.com"),
    seller_proof_name: "_conveyance-seller.wintergreen.com",
    buyer_proof_name: "_conveyance-buyer.wintergreen.com",
    escrowable: "True",
  },
  {
    domain: "quaydock.org",
    rdap_base: BASE.org,
    registrar_iana_id: NAMECHEAP,
    registrar_name: REGISTRAR_NAME[NAMECHEAP],
    nameservers: "dns1.registrar-servers.com,dns2.registrar-servers.com",
    statuses: "active,pending transfer",
    registration_at: "2016-02-19T11:30:52Z",
    expiration_at: "2027-02-19T11:30:52Z",
    last_changed_at: "2026-08-29T14:02:11Z",
    transfer_at: "2023-07-04T08:19:36Z",
    transfer_locked: "False",
    transfer_lock_setters: "",
    pending_transfer: "True",
    digest: fixtureDigest("probe:quaydock.org"),
    seller_proof_name: "_conveyance-seller.quaydock.org",
    buyer_proof_name: "_conveyance-buyer.quaydock.org",
    escrowable: "False",
  },
];
