"use client";

/**
 * Lodging an offer: the only form in this interface that sends value.
 *
 * WHY THIS FORM REHEARSES BEFORE IT SENDS. `open_deal` is the one method here that can receive
 * value, and that one fact shapes both sides. The contract's side: it refuses by refunding
 * `gl.message.value` and returning its tagged reason rather than by raising, because StudioNet does
 * not return the value that arrived when a GenVM execution reverts, so a reverting payable method
 * would keep the escrow of a caller it had just turned down. This form's side: every check the
 * contract makes before its first network call is deterministic, which makes the call safe to
 * rehearse with nothing attached, and rehearsing it is how the reader learns which rule would fire
 * before a signature is spent on finding out.
 *
 * WHAT THE REHEARSAL IS FOR, NOW THAT A REFUSAL IS NOT COSTLY. It saves a signature and a wait, not
 * an escrow. That is a smaller claim than it used to be and it is worth stating plainly: the
 * contract hands the value back either way. What the rehearsal still buys is that a reader who has
 * a field wrong finds out from a call that costs nothing rather than from a receipt.
 *
 * WHY THE REHEARSAL IS NOT ENOUGH ON ITS OWN, AND WHY THERE ARE FIVE CHECKS. A rehearsal with no
 * value stops at `escrow <= 0`, which is the third rule out of eight. Everything after it is
 * unreached, and three of those are the expensive ones:
 *
 *   1. The registry conditions. Reached only after the first network call, so the rehearsal cannot
 *      see them at all. They are covered by `probe_domain`, which reads the same registry through
 *      the same code path and writes nothing.
 *   2. The duplicate id. Covered by `get_deal`, which answers `{}` when the id is free.
 *   3. The duplicate domain. Covered by `delivery_status`, same shape, keyed by name.
 *   4. The ceiling. A zero-value call passes it trivially, so it is compared here against the
 *      figure `parameters()` reports and never against a constant copied out of the contract.
 *   5. The rehearsal itself, whose one acceptable answer is the escrow refusal. Any other refusal
 *      means a rule fired earlier and the terms are wrong in a way the reader has not seen yet.
 *
 * WHY A PASSING CHECK GOES STALE. Every finding is stamped with the terms it was computed from.
 * Edit a field and the findings stop counting, because a rehearsal of one set of terms says
 * nothing about another set, and a form that let an old pass authorise a new send would be worse
 * than a form with no rehearsal at all.
 *
 * WHY THE SECRET IS GENERATED HERE AND NOWHERE ELSE. Only its sha256 goes on chain. If it is lost
 * the deal cannot be verified by anybody, and the escrow comes back only when the transfer window
 * closes. That is stated beside the field rather than in a tooltip.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { CopyLine } from "@/components/copy-line";
import { Row, ValueList } from "@/components/record";
import { useWallet } from "@/components/wallet-provider";
import { WritePanel } from "@/components/write-panel";
import { useWriteRunner } from "@/components/write-runner";
import { isTrue, LIVE_STATES, type DealState, type Probe } from "@/lib/contract-types";
import { getDeal, getDealByDomain, probeFixture } from "@/lib/data-source";
import { formatGen, formatWindow, genToWei, splitSet } from "@/lib/format";
import { IS_LIVE } from "@/lib/genlayer/config";
import { returnedRecord } from "@/lib/genlayer/returned-value";
import { decodeProbe } from "@/lib/live-reads";
import {
  buyerProofValue,
  buyerRecordName,
  canonicalNameservers,
  commitment,
  domainFault,
  generateSecret,
  sealSecret,
  sellerProofValue,
  sellerRecordName,
  zoneLine,
} from "@/lib/secret";
import { addressFault, idFault, nameserverFault, registrarFault } from "@/lib/validate";

/* -------------------------------------------------------------------------- */
/* Findings                                                                   */
/* -------------------------------------------------------------------------- */

type Verdict = "pass" | "fail" | "unknown";

type Finding = {
  key: string;
  label: string;
  verdict: Verdict;
  detail: string;
};

const VERDICT_TEXT: Record<Verdict, string> = {
  pass: "clear",
  fail: "would be refused",
  unknown: "not established",
};

type ProbeState =
  | { status: "idle" }
  | { status: "running" }
  | { status: "done"; value: Probe }
  | { status: "refused"; message: string };

/** The escrow refusal, verbatim from the contract. The one answer a rehearsal may come back with. */
const ESCROW_REFUSAL = "a deal needs an escrow; this call carried no value";

export function LodgeOffer({
  maxDealValueWei,
  nameserverMin,
  nameserverMax,
  limitRefusal,
  acceptWindowSeconds,
}: {
  /** From `parameters()`. Empty when the read refused, which is the case in fixture mode. */
  maxDealValueWei: string;
  nameserverMin: string;
  nameserverMax: string;
  /** Why the three figures above are missing, when they are. */
  limitRefusal: string;
  acceptWindowSeconds: string;
}) {
  const wallet = useWallet();
  const probeRunner = useWriteRunner();
  const rehearsal = useWriteRunner();
  const lodge = useWriteRunner();

  const [domain, setDomain] = useState("");
  const [dealId, setDealId] = useState("");
  const [seller, setSeller] = useState("");
  const [registrarId, setRegistrarId] = useState("");
  const [nameservers, setNameservers] = useState("");
  const [price, setPrice] = useState("");
  const [secret, setSecret] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [kept, setKept] = useState(false);
  const [idNote, setIdNote] = useState("");
  const [vaultNote, setVaultNote] = useState("");
  const [probe, setProbe] = useState<ProbeState>({ status: "idle" });
  const [findings, setFindings] = useState<Finding[] | null>(null);
  const [checkedTerms, setCheckedTerms] = useState("");
  const [checking, setChecking] = useState(false);
  const [lodged, setLodged] = useState("");

  const buyer = wallet.address;
  const cleanDomain = domain.trim().toLowerCase();
  const cleanId = dealId.trim();
  const cleanSeller = seller.trim();
  const cleanRegistrar = registrarId.trim();
  const nameserverSet = canonicalNameservers(nameservers);
  const wei = genToWei(price.trim());

  const domainRefusal = domain.trim() ? domainFault(domain) : "Enter the domain being sold.";
  const idRefusal = idFault(dealId);
  const sellerRefusal = addressFault(seller, "seller's address");
  const registrarRefusal = registrarFault(registrarId);
  const nameserverRefusal = nameserverFault(nameserverSet, nameserverMin, nameserverMax);
  const priceRefusal = !price.trim()
    ? "Give the consideration this offer carries."
    : wei === null
      ? "A sum in GEN, with up to 18 decimal places and no separators."
      : wei <= 0n
        ? "An escrow of nothing settles nothing. The contract refuses it."
        : "";
  const sameParty =
    cleanSeller && buyer && cleanSeller.toLowerCase() === buyer.toLowerCase()
      ? "The seller here is the connected address. The contract refuses an escrow with one party on both sides."
      : "";

  /* ---------------------------------------------------------------------- */
  /* The buyer's secret, and the commitment that is all the chain gets       */
  /* ---------------------------------------------------------------------- */

  const token = secret.trim() && cleanId && buyer ? buyerProofValue(cleanId, buyer, secret.trim()) : "";

  /**
   * The commitment carries the token it was computed from, and is read only when the two still
   * match. sha256 is async here because WebCrypto is, so without that pairing an edit to the deal
   * id would leave the previous deal's commitment on screen for a frame and, worse, would leave it
   * readable by the code that decides whether the terms are complete. Storing the pair means a
   * stale commitment is unreachable rather than merely short-lived.
   */
  const [computed, setComputed] = useState({ token: "", value: "", error: "" });

  useEffect(() => {
    if (!token) return;
    let current = true;
    void commitment(token).then(
      (value) => {
        if (current) setComputed({ token, value, error: "" });
      },
      (error: unknown) => {
        if (current) {
          setComputed({
            token,
            value: "",
            error: error instanceof Error ? error.message : String(error),
          });
        }
      },
    );
    return () => {
      current = false;
    };
  }, [token]);

  const commit =
    token && computed.token === token
      ? { value: computed.value, error: computed.error }
      : { value: "", error: "" };

  const secretRefusal = !buyer
    ? "Connect the wallet that will send this call. The token is bound to the buyer's address, and the address that lodges the offer is the one every later check rebuilds it from."
    : !secret.trim()
      ? "Generate a secret. Nothing can be committed to until there is one."
      : commit.error
        ? commit.error
        : !commit.value
          ? "The commitment is still being computed."
          : !kept
            ? "Confirm you have kept the secret. Nothing else in this system can recover it."
            : "";

  /* ---------------------------------------------------------------------- */
  /* Terms identity, so a stale rehearsal cannot authorise a fresh send      */
  /* ---------------------------------------------------------------------- */

  const terms = [
    cleanDomain,
    cleanId,
    cleanSeller.toLowerCase(),
    cleanRegistrar,
    nameserverSet.join(","),
    commit.value,
    wei === null ? "" : wei.toString(),
  ].join("|");

  const stale = findings !== null && checkedTerms !== terms;
  const clear = findings !== null && !stale && findings.every((finding) => finding.verdict === "pass");

  const formRefusal =
    domainRefusal ||
    idRefusal ||
    sellerRefusal ||
    sameParty ||
    registrarRefusal ||
    nameserverRefusal ||
    priceRefusal ||
    secretRefusal;

  /* ---------------------------------------------------------------------- */
  /* Asking the registry                                                    */
  /* ---------------------------------------------------------------------- */

  const askRegistry = async () => {
    const fault = domain.trim() ? domainFault(domain) : "Enter a domain first.";
    if (fault) {
      setProbe({ status: "refused", message: fault });
      return;
    }
    setProbe({ status: "running" });

    if (!IS_LIVE) {
      const result = await probeFixture(cleanDomain);
      if (result.kind === "AVAILABLE") {
        setProbe({ status: "done", value: result.value });
        return;
      }
      setProbe({
        status: "refused",
        message:
          result.kind === "NOT_FOUND"
            ? "No fixture probe for that name."
            : result.error,
      });
      return;
    }

    const outcome = await probeRunner.run({
      label: `probe ${cleanDomain}`,
      functionName: "probe_domain",
      args: [cleanDomain],
    });
    if (!outcome.ok) {
      setProbe({ status: "refused", message: outcome.message });
      return;
    }
    const record = returnedRecord(outcome.returned);
    const decoded = record ? decodeProbe(record) : null;
    if (!decoded) {
      setProbe({
        status: "refused",
        message:
          "The probe was accepted and finalised, and its answer could not be read off the receipt in this build. Nothing is invented from that: every field it would have filled is typeable below, and the rehearsal checks the terms against the contract either way.",
      });
      return;
    }
    setProbe({ status: "done", value: decoded });
  };

  const probeReport = probe.status === "done" ? registryReport(probe.value, cleanRegistrar) : null;

  /* ---------------------------------------------------------------------- */
  /* The four checks that are not the rehearsal, and then the rehearsal      */
  /* ---------------------------------------------------------------------- */

  const runChecks = async () => {
    setChecking(true);
    setFindings(null);
    const collected: Finding[] = [];

    collected.push(
      probeReport
        ? {
            key: "registry",
            label: "The registry allows an escrow on this name",
            verdict: probeReport.faults.length === 0 ? "pass" : "fail",
            detail:
              probeReport.faults.length === 0
                ? probeReport.note ||
                  "The name is not held, no transfer is in flight, the transfer lock is not the registry's own, and the registrar it has to reach is not the one it already sits at."
                : probeReport.faults.join(" "),
          }
        : {
            key: "registry",
            label: "The registry allows an escrow on this name",
            verdict: "unknown",
            detail:
              "Ask the registry above first. These conditions sit after the contract's first network call, and a rehearsal with no value attached is refused before it, so nothing except a probe can reach them.",
          },
    );

    const byId = await getDeal(cleanId);
    collected.push({
      key: "id",
      label: "The identifier is free",
      verdict: byId.kind === "NOT_FOUND" ? "pass" : byId.kind === "AVAILABLE" ? "fail" : "unknown",
      detail:
        byId.kind === "NOT_FOUND"
          ? `The register carries nothing under ${cleanId}.`
          : byId.kind === "AVAILABLE"
            ? `${cleanId} is already the identifier of a deal on ${byId.value.domain}. The contract refuses a second one, and this check exists so the refusal arrives here rather than on a receipt you signed for.`
            : byId.error,
    });

    const byDomain = await getDealByDomain(cleanDomain);
    // A closed predecessor does not block the domain. The contract's index keeps pointing at
    // the last deal on a name after it settles or refunds, and only a live one would let a
    // single transfer settle two escrows, so a terminal predecessor is reported as superseded
    // rather than as a refusal. Reading the state here rather than treating any hit as a
    // failure is what keeps this rehearsal honest: a check that predicted a refusal the
    // contract would not make would stop a legitimate offer.
    const previousIsLive =
      byDomain.kind === "AVAILABLE" && LIVE_STATES.includes(byDomain.value.state as DealState);
    collected.push({
      key: "domain",
      label: "No live deal already covers this domain",
      verdict:
        byDomain.kind === "NOT_FOUND" ? "pass" : byDomain.kind === "AVAILABLE" ? (previousIsLive ? "fail" : "pass") : "unknown",
      detail:
        byDomain.kind === "NOT_FOUND"
          ? `No deal in the register is keyed to ${cleanDomain}.`
          : byDomain.kind === "AVAILABLE"
            ? previousIsLive
              ? `Deal ${byDomain.value.deal_id} already covers ${cleanDomain} and is ${byDomain.value.state}. A second live escrow on one domain would let a single transfer settle both, so the contract refuses it.`
              : `Deal ${byDomain.value.deal_id} covered ${cleanDomain} and is ${byDomain.value.state}, which holds no money and can settle nothing. This offer would supersede it.`
            : byDomain.error,
    });

    collected.push(
      !maxDealValueWei
        ? { key: "ceiling", label: "The consideration is under the ceiling", verdict: "unknown", detail: limitRefusal }
        : wei === null
          ? { key: "ceiling", label: "The consideration is under the ceiling", verdict: "unknown", detail: "There is no sum to compare yet." }
          : wei > BigInt(maxDealValueWei)
            ? {
                key: "ceiling",
                label: "The consideration is under the ceiling",
                verdict: "fail",
                detail: `This deployment escrows at most ${formatGen(maxDealValueWei)} and this offer carries ${formatGen(wei)}. A rehearsal cannot catch this, because a call with nothing attached is under every ceiling.`,
              }
            : {
                key: "ceiling",
                label: "The consideration is under the ceiling",
                verdict: "pass",
                detail: `${formatGen(wei)} against this deployment's maximum of ${formatGen(maxDealValueWei)}, read from the contract rather than assumed.`,
              },
    );

    if (!IS_LIVE) {
      collected.push({
        key: "rehearsal",
        label: "The contract stops exactly at the escrow rule",
        verdict: "unknown",
        detail:
          "A rehearsal is a real transaction against a deployed contract and there is none configured here, so it was not pretended. The four checks above ran for real against the fixtures.",
      });
    } else {
      const outcome = await rehearsal.run({
        label: `rehearse ${cleanId}`,
        functionName: "open_deal",
        args: [cleanId, cleanDomain, cleanSeller, cleanRegistrar, JSON.stringify(nameserverSet), commit.value],
        value: 0n,
      });
      if (outcome.ok) {
        collected.push({
          key: "rehearsal",
          label: "The contract stops exactly at the escrow rule",
          verdict: "fail",
          detail:
            "The rehearsal was accepted. The contract documents a call with no value attached as impossible, so this build cannot explain what happened and will not treat it as permission to send money. Read the deal in the register before going further.",
        });
      } else if (outcome.message.includes(ESCROW_REFUSAL)) {
        collected.push({
          key: "rehearsal",
          label: "The contract stops exactly at the escrow rule",
          verdict: "pass",
          detail:
            "Every rule the contract checks before this one accepted these terms: the shape of all six arguments, and that the seller is not the buyer. The refusal was the escrow floor and nothing earlier.",
        });
      } else {
        collected.push({
          key: "rehearsal",
          label: "The contract stops exactly at the escrow rule",
          verdict: outcome.outcome === "expected" ? "fail" : "unknown",
          detail:
            outcome.outcome === "expected"
              ? `A rule fired before the escrow floor, so the terms are wrong in a way nothing above caught. The contract's words: ${outcome.message}`
              : `The rehearsal did not conclude, so it decided nothing about these terms. ${outcome.message}`,
        });
      }
    }

    setFindings(collected);
    setCheckedTerms(terms);
    setChecking(false);
  };

  /* ---------------------------------------------------------------------- */
  /* Sending it                                                             */
  /* ---------------------------------------------------------------------- */

  const send = async () => {
    if (wei === null) return;
    const outcome = await lodge.run({
      label: `lodge ${cleanId}`,
      functionName: "open_deal",
      args: [cleanId, cleanDomain, cleanSeller, cleanRegistrar, JSON.stringify(nameserverSet), commit.value],
      value: wei,
      dealId: cleanId,
    });
    if (outcome.ok) setLodged(cleanId);
  };

  const suggestId = () => {
    try {
      const stem =
        cleanDomain.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "deal";
      setDealId(`${stem}-${generateSecret().slice(0, 6)}`);
      setIdNote("");
    } catch (error) {
      setIdNote(error instanceof Error ? error.message : String(error));
    }
  };

  const makeSecret = () => {
    try {
      setSecret(generateSecret());
      setKept(false);
      setVaultNote("");
    } catch (error) {
      setVaultNote(error instanceof Error ? error.message : String(error));
    }
  };

  const download = async () => {
    try {
      const vault = await sealSecret(secret.trim(), passphrase, {
        dealId: cleanId,
        domain: cleanDomain,
      });
      const blob = new Blob([JSON.stringify(vault, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `conveyance-${cleanId || "deal"}-secret.json`;
      anchor.click();
      URL.revokeObjectURL(url);
      setVaultNote(
        "Encrypted with that passphrase and saved. The passphrase was not stored anywhere, including here, so a forgotten one loses the file as completely as a lost file would.",
      );
    } catch (error) {
      setVaultNote(error instanceof Error ? error.message : String(error));
    }
  };

  /* ---------------------------------------------------------------------- */
  /* Lodged                                                                 */
  /* ---------------------------------------------------------------------- */

  if (lodged) {
    return (
      <div className="space-y-8">
        <section className="cv-panel p-6">
          <p className="cv-legend cv-legend-ink">Lodged</p>
          <h2 className="cv-heading mt-2">The offer is in the register</h2>
          <p className="cv-body mt-2 max-w-[68ch]">
            The consideration is in escrow and the acceptance window is running. It closes{" "}
            {acceptWindowSeconds ? formatWindow(acceptWindowSeconds) : "after this deployment's acceptance window"}{" "}
            from the instant the contract recorded, and if the seller has not accepted by then
            anyone at all may return the escrow to you.
          </p>
          <p className="cv-body mt-3 max-w-[68ch]">
            Send the seller the line below. Until they publish it and press Accept, nothing about
            this deal is armed and no baseline exists.
          </p>
          <div className="mt-5">
            <CopyLine
              label="the seller publishes this, then presses Accept"
              value={zoneLine(sellerRecordName(cleanDomain), sellerProofValue(cleanId, cleanSeller))}
              note="Computed in this browser from the deal id and the seller's address. The contract wrote its own copy at open, and the deal page prints that one rather than this one."
            />
          </div>
          <p className="cv-aside mt-5 max-w-[68ch]">
            Keep your secret. It is the only thing that lets a check pass, and no check can pass
            without it. If it is gone, the escrow comes back to you when the transfer window closes
            and not before.
          </p>
        </section>
        <Link
          href={`/deals/${lodged}`}
          className="cv-legend cv-legend-ink inline-block underline decoration-1 underline-offset-4"
        >
          read the deal in the register
        </Link>
      </div>
    );
  }

  /* ---------------------------------------------------------------------- */
  /* The form                                                               */
  /* ---------------------------------------------------------------------- */

  return (
    <div className="space-y-8">
      {/* ------------------------------------------------------------------ */}
      {/* One: the name, and what the registry says about it                 */}
      {/* ------------------------------------------------------------------ */}
      <section className="cv-panel p-6">
        <p className="cv-legend">one</p>
        <h2 className="cv-heading mt-1">The name</h2>
        <p className="cv-body mt-2 max-w-[68ch]">
          Ask the registry before anything else. A probe writes nothing and moves nothing, and it
          answers the four questions a rehearsal cannot reach, because the contract only reaches
          them after its first network call.
        </p>

        <Field
          id="offer-domain"
          label="domain"
          hint="The registrable name only, with no scheme and no trailing dot."
          value={domain}
          onChange={setDomain}
          placeholder="example.com"
          refusal={domain.trim() ? domainRefusal : ""}
        />

        <div className="mt-4">
          <button
            type="button"
            className="cv-btn"
            onClick={() => void askRegistry()}
            disabled={probe.status === "running"}
          >
            {IS_LIVE ? "Ask the registry" : "Read the bundled answer"}
          </button>
          <p className="cv-aside mt-2 max-w-[68ch]">
            {IS_LIVE
              ? "A signed transaction that writes nothing. It costs gas, because every validator fetches the IANA bootstrap and the registry object independently and they have to agree byte for byte."
              : "Fixture mode answers for the three names bundled with this build and refuses for every other one. It does not invent a registrar for whatever was typed."}
          </p>
        </div>

        {IS_LIVE ? (
          <WritePanel
            state={probeRunner.state}
            functionName="probe_domain"
            walletGate={probeRunner.walletGate}
            onReset={probeRunner.reset}
          />
        ) : null}

        {probe.status === "refused" ? (
          <p className="cv-body mt-4 max-w-[68ch]">{probe.message}</p>
        ) : null}

        {probe.status === "done" ? <RegistryPanel probe={probe.value} /> : null}
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* Two: the terms                                                     */}
      {/* ------------------------------------------------------------------ */}
      <section className="cv-panel p-6">
        <p className="cv-legend">two</p>
        <h2 className="cv-heading mt-1">The terms</h2>
        <p className="cv-body mt-2 max-w-[68ch]">
          Written once and never rewritten. The contract stores them at open and every later check
          is measured against them, so a term that is wrong here is wrong for the life of the deal.
        </p>

        <Field
          id="offer-id"
          label="identifier"
          hint="Yours to choose, not issued by the contract. Up to 64 characters of letters, digits, hyphen, underscore or dot. An identifier already in the register is refused."
          value={dealId}
          onChange={setDealId}
          placeholder="example-com-01"
          refusal={dealId.trim() ? idRefusal : ""}
        />
        <div className="mt-2">
          <button type="button" className="cv-btn-quiet" onClick={suggestId}>
            Suggest one
          </button>
          {idNote ? <p className="cv-aside mt-2 max-w-[68ch]">{idNote}</p> : null}
        </div>

        <Field
          id="offer-seller"
          label="seller"
          hint="The only address that may accept this offer. Nobody else can arm it, whatever they publish."
          value={seller}
          onChange={setSeller}
          placeholder="0x…"
          refusal={(seller.trim() ? sellerRefusal : "") || sameParty}
        />

        <Field
          id="offer-registrar"
          label="registrar required, as an IANA id"
          hint="The number, not the name. The contract compares numbers because a registrar can rebrand without a single domain moving."
          value={registrarId}
          onChange={setRegistrarId}
          placeholder="1234"
          refusal={registrarId.trim() ? registrarRefusal : ""}
        />
        {probe.status === "done" && probe.value.registrar_iana_id ? (
          <p className="cv-aside mt-2 max-w-[68ch]">
            The name sits at {probe.value.registrar_iana_id}
            {probe.value.registrar_name ? `, ${probe.value.registrar_name}` : ""} today. The target
            has to be a different number, or no transfer would take place and the contract says so.
          </p>
        ) : null}

        <div className="mt-6">
          <label className="cv-legend cv-legend-ink block" htmlFor="offer-nameservers">
            delegation required
          </label>
          <p className="cv-aside mt-1 max-w-[68ch]">
            Compared as a set: lowercased, root dot dropped, de-duplicated and sorted, on both
            sides. Order is not a difference. Separate them with spaces, commas or newlines.
          </p>
          <textarea
            id="offer-nameservers"
            value={nameservers}
            onChange={(event) => setNameservers(event.target.value)}
            placeholder={"ns1.example-registrar.com\nns2.example-registrar.com"}
            spellCheck={false}
            autoComplete="off"
            rows={3}
            className="cv-textarea mt-2"
          />
          {nameserverSet.length > 0 ? (
            <p className="cv-aside mt-2 max-w-[68ch]">
              Committing to {nameserverSet.length === 1 ? "one name" : `${nameserverSet.length} names`}:{" "}
              <span className="cv-record-sm break-all">{nameserverSet.join(", ")}</span>
            </p>
          ) : null}
          {nameservers.trim() && nameserverRefusal ? (
            <p className="cv-body mt-2 max-w-[68ch]">{nameserverRefusal}</p>
          ) : null}
          {!nameserverMin || !nameserverMax ? (
            <p className="cv-aside mt-2 max-w-[68ch]">
              How many the contract accepts could not be read here, so the count was not checked
              against it. {limitRefusal}
            </p>
          ) : null}
          {probe.status === "done" && probe.value.nameservers ? (
            <div className="cv-rule mt-4 pt-4">
              <p className="cv-legend cv-legend-ink">delegated to this today</p>
              <div className="mt-2">
                <ValueList values={splitSet(probe.value.nameservers)} empty="the registry reported none" />
              </div>
              <button
                type="button"
                className="cv-btn-quiet mt-3"
                onClick={() => setNameservers(splitSet(probe.value.nameservers).join("\n"))}
              >
                Use these as the target
              </button>
              <p className="cv-aside mt-2 max-w-[68ch]">
                Read what that means before pressing it. These are the seller&rsquo;s nameservers
                now, so requiring them as the target satisfies the delegation condition before the
                transfer even starts, and the deal turns on the registrar change and the
                buyer&rsquo;s record alone.
              </p>
            </div>
          ) : null}
        </div>

        <Field
          id="offer-price"
          label="consideration, in GEN"
          hint="Taken into escrow by this call and held by the contract until the deal closes one way or the other."
          value={price}
          onChange={setPrice}
          placeholder="1.5"
          refusal={price.trim() ? priceRefusal : ""}
        />
        {wei !== null && wei > 0n ? (
          <p className="cv-aside mt-2 max-w-[68ch]">
            {wei.toString()} wei. The contract works in wei and this figure is what will be
            attached, converted here with nothing rounded.
          </p>
        ) : null}
        {maxDealValueWei ? (
          <p className="cv-aside mt-2 max-w-[68ch]">
            This deployment escrows at most {formatGen(maxDealValueWei)}, read from the
            contract.
          </p>
        ) : null}
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* Three: the secret                                                  */}
      {/* ------------------------------------------------------------------ */}
      <section className="cv-panel p-6">
        <p className="cv-legend">three</p>
        <h2 className="cv-heading mt-1">Your secret</h2>
        <p className="cv-body mt-2 max-w-[68ch]">
          Thirty-two bytes from this browser&rsquo;s cryptographic random source. The chain gets
          its sha256 and nothing else, which is what stops the seller publishing your control
          record before you do. You publish the record after the transfer completes, and a check
          reveals the token then, by which point it is public in DNS anyway.
        </p>

        <div className="mt-4">
          <button type="button" className="cv-btn" onClick={makeSecret}>
            {secret ? "Generate a different one" : "Generate a secret"}
          </button>
        </div>

        {!buyer ? (
          <p className="cv-body mt-4 max-w-[68ch]">
            Connect the wallet that will send this call first. The token is bound to the
            buyer&rsquo;s address, and every later check rebuilds it from the address that lodged
            the offer, so it cannot be built from an address that is not yet known.
          </p>
        ) : null}

        {secret && buyer ? (
          <div className="mt-5 space-y-5">
            <CopyLine
              label="the secret"
              value={secret}
              note="Not sent anywhere by this page, not put in a URL, and not written to storage. If it is lost the deal cannot be verified by anybody and the escrow returns to you only when the transfer window closes."
            />
            <CopyLine
              label="you publish this once the transfer completes"
              value={zoneLine(buyerRecordName(cleanDomain), token)}
              note="Not before. Publishing it early proves nothing early, and the record name is derived by the contract rather than by this page."
            />
            <dl>
              <Row
                label="commitment"
                note="sha256 of the token above. This is the only part of it that goes on chain, and it is what the contract compares a revealed token against."
              >
                {commit.value ? (
                  <span className="cv-record-sm break-all">{commit.value}</span>
                ) : (
                  <span className="cv-unchanged">{commit.error || "computing"}</span>
                )}
              </Row>
            </dl>

            <div className="cv-rule pt-4">
              <label className="cv-legend cv-legend-ink block" htmlFor="offer-passphrase">
                save it, encrypted
              </label>
              <p className="cv-aside mt-1 max-w-[68ch]">
                At least 12 characters. The file is AES-GCM under a key derived from it, so a copy
                in a Downloads folder is not a copy of the secret. The passphrase is not stored and
                cannot be recovered from anywhere, including from this build.
              </p>
              <input
                id="offer-passphrase"
                type="password"
                value={passphrase}
                onChange={(event) => setPassphrase(event.target.value)}
                autoComplete="new-password"
                className="cv-input mt-2 w-full"
              />
              <button
                type="button"
                className="cv-btn-quiet mt-3"
                onClick={() => void download()}
                disabled={passphrase.length < 12}
              >
                Encrypt and download
              </button>
              {vaultNote ? <p className="cv-aside mt-2 max-w-[68ch]">{vaultNote}</p> : null}
            </div>

            <label className="flex max-w-[68ch] items-start gap-3">
              <input
                type="checkbox"
                checked={kept}
                onChange={(event) => setKept(event.target.checked)}
                className="mt-1"
              />
              <span className="cv-body">
                I have kept this secret somewhere I will still have it in ten days. Nothing in this
                system can recover it, and no check can pass without it.
              </span>
            </label>
          </div>
        ) : null}
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* Four: the rehearsal                                                */}
      {/* ------------------------------------------------------------------ */}
      <section className="cv-panel p-6">
        <p className="cv-legend">four</p>
        <h2 className="cv-heading mt-1">The rehearsal</h2>
        <p className="cv-body mt-2 max-w-[68ch]">
          <span className="cv-record-sm">open_deal</span> is the one method here that receives value,
          and when it refuses it hands that value straight back and returns its reason. So sending
          bad terms costs a signature and a wait rather than the escrow. The same call is sent first
          with nothing attached, and its one acceptable answer is the escrow refusal: reaching that
          rule means every rule before it accepted these terms.
        </p>
        <p className="cv-body mt-3 max-w-[68ch]">
          Three of the contract&rsquo;s later rules sit past that point and are checked separately,
          against the register and against the figure the contract reports for its own ceiling. All
          five are listed with their verdicts, and a verdict that could not be established is not
          counted as a pass.
        </p>

        <div className="mt-5">
          <button
            type="button"
            className="cv-btn"
            onClick={() => void runChecks()}
            disabled={checking || Boolean(formRefusal)}
          >
            {checking ? "Running the checks" : "Rehearse these terms"}
          </button>
          {formRefusal ? <p className="cv-body mt-3 max-w-[68ch]">{formRefusal}</p> : null}
          {IS_LIVE && !formRefusal ? (
            <p className="cv-aside mt-2 max-w-[68ch]">
              The rehearsal is a real transaction and it will be refused, which costs gas and moves
              nothing. That is the price of learning which rule fires before a signature carries
              money with it.
            </p>
          ) : null}
        </div>

        {IS_LIVE ? (
          <WritePanel
            state={rehearsal.state}
            functionName="open_deal"
            walletGate={rehearsal.walletGate}
            onReset={rehearsal.reset}
          />
        ) : null}

        {findings ? (
          <div className="mt-6">
            {stale ? (
              <p className="cv-body max-w-[68ch]">
                The terms changed after these checks ran, so they no longer describe what would be
                sent. Rehearse again.
              </p>
            ) : null}
            <dl className="mt-3">
              {findings.map((finding) => (
                <Row key={finding.key} label={finding.label} note={finding.detail}>
                  <span className={finding.verdict === "pass" ? "" : "cv-delta"}>
                    {VERDICT_TEXT[finding.verdict]}
                  </span>
                </Row>
              ))}
            </dl>
          </div>
        ) : null}
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* Five: lodging it                                                   */}
      {/* ------------------------------------------------------------------ */}
      <section className="cv-panel p-6">
        <p className="cv-legend">five</p>
        <h2 className="cv-heading mt-1">Lodge the offer</h2>
        <p className="cv-body mt-2 max-w-[68ch]">
          The same six arguments as the rehearsal, with the consideration attached this time. The
          acceptance window starts at the instant the contract records, and until the seller accepts
          nothing is armed and no baseline exists.
        </p>

        <div className="mt-5">
          <button
            type="button"
            className="cv-btn"
            onClick={() => void send()}
            disabled={!clear || Boolean(formRefusal)}
          >
            Lodge the offer and escrow {wei !== null && wei > 0n ? formatGen(wei) : "the consideration"}
          </button>
          {!clear ? (
            <p className="cv-body mt-3 max-w-[68ch]">
              {findings === null
                ? "Rehearse the terms first. This is the one control in this interface that sends value, and it is not offered on terms the contract has not seen."
                : stale
                  ? "The terms changed after the rehearsal. Run it again."
                  : "At least one check above is not clear. Every one of them has to be. The contract would hand the escrow back rather than keep it, but a send that is going to be refused still spends a signature and tells you nothing this page has not already worked out."}
            </p>
          ) : null}
        </div>

        <WritePanel
          state={lodge.state}
          functionName="open_deal"
          walletGate={lodge.walletGate}
          onReset={lodge.reset}
        />
      </section>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Pieces                                                                     */
/* -------------------------------------------------------------------------- */

function Field({
  id,
  label,
  hint,
  value,
  onChange,
  placeholder,
  refusal,
}: {
  id: string;
  label: string;
  hint: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  /** Printed only once something has been typed, so an untouched form is not a wall of red. */
  refusal: string;
}) {
  return (
    <div className="mt-6">
      <label className="cv-legend cv-legend-ink block" htmlFor={id}>
        {label}
      </label>
      <p className="cv-aside mt-1 max-w-[68ch]">{hint}</p>
      <input
        id={id}
        type="text"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        className="cv-input mt-2 w-full"
      />
      {refusal ? <p className="cv-body mt-2 max-w-[68ch]">{refusal}</p> : null}
    </div>
  );
}

/**
 * What the probe said, printed whole rather than summarised into a yes or a no.
 *
 * `escrowable` is the contract's own field and it covers two of the four conditions that matter:
 * the name is not held and no transfer is in flight. It does not cover a lock the registry itself
 * set, and it does not know which registrar the buyer wants. Those two are read from the fields
 * beside it, which is why they are printed here rather than hidden behind one flag.
 */
function RegistryPanel({ probe }: { probe: Probe }) {
  const setters = splitSet(probe.transfer_lock_setters);
  return (
    <div className="cv-rule-strong mt-6 pt-5">
      <p className="cv-legend cv-legend-ink">what the registry answered</p>
      <dl className="mt-3">
        <Row label="registrar" note="The IANA id is what the contract compares. The name is printed for you, not for it.">
          {probe.registrar_iana_id || <span className="cv-unchanged">not reported</span>}
          {probe.registrar_name ? ` · ${probe.registrar_name}` : ""}
        </Row>
        <Row label="statuses" note="EPP statuses, as the registry publishes them.">
          <ValueList values={splitSet(probe.statuses)} empty="none published" />
        </Row>
        <Row
          label="transfer lock"
          note="A lock the registrar set can be lifted by the seller. A lock the registry set cannot, which is why the two are not one field."
        >
          {isTrue(probe.transfer_locked)
            ? setters.length > 0
              ? `locked, set by ${setters.join(" and ")}`
              : "locked"
            : "not locked"}
        </Row>
        <Row label="transfer in flight" note="A name already mid-transfer cannot be escrowed against a second one.">
          {isTrue(probe.pending_transfer) ? "yes" : "no"}
        </Row>
        <Row
          label="escrowable"
          note="The contract's own field. True means the name is neither held nor mid-transfer. It is not a promise that a deal will open: the registry lock and the target registrar are separate rules."
        >
          {isTrue(probe.escrowable) ? "yes" : "no"}
        </Row>
        <Row label="registry answer digest" note="sha256 of the bytes every validator agreed on.">
          {probe.digest ? (
            <span className="cv-record-sm break-all">{probe.digest}</span>
          ) : (
            <span className="cv-unchanged">not reported</span>
          )}
        </Row>
      </dl>
    </div>
  );
}

/**
 * The four registry conditions a rehearsal cannot reach, tested against one probe.
 *
 * Two of them are the contract's `escrowable` unpacked, and two are rules `escrowable` says
 * nothing about. The client lock is deliberately not a fault: the contract records that the
 * registrar set a lock and opens the deal anyway, because the seller can lift their own lock and
 * refusing would be this interface being stricter than the rule it is explaining.
 */
function registryReport(probe: Probe, targetRegistrar: string): { faults: string[]; note: string } {
  const faults: string[] = [];
  const setters = splitSet(probe.transfer_lock_setters);

  if (!isTrue(probe.escrowable)) {
    const statuses = splitSet(probe.statuses);
    faults.push(
      `The registry does not report this name as escrowable. Its statuses are ${statuses.length > 0 ? statuses.join(", ") : "not published"} and a transfer is ${isTrue(probe.pending_transfer) ? "already in flight" : "not in flight"}.`,
    );
  }
  if (setters.includes("server")) {
    faults.push(
      "The transfer lock was set by the registry itself. Only the registry can lift it, so the seller cannot deliver whatever they agree to.",
    );
  }
  if (targetRegistrar && probe.registrar_iana_id && targetRegistrar === probe.registrar_iana_id) {
    faults.push(
      `The name already sits at registrar ${targetRegistrar}, so the transfer this deal turns on would never happen.`,
    );
  }

  const note = setters.includes("client")
    ? "The registrar set a transfer lock on this name. The contract records that and opens the deal anyway, because the seller can lift their own registrar's lock. They will have to, before any check can pass."
    : "";
  return { faults, note };
}
