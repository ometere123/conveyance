/**
 * The buyer's control proof, as the chain records it.
 *
 * WHY THIS IS NOT TWO COLUMNS. An earlier version of this panel printed the two resolvers side by
 * side, field by field, with a benign-difference list under them. That panel could not be built
 * from this contract, and the reason it could not is the finding worth showing: the contract
 * stores nothing per resolver. It stores the outcome, the corroborated record set, and a digest of
 * that set at the check that delivered. Nothing else, deliberately.
 *
 * The two resolvers format the same unchanging record differently on eight measured axes, so the
 * only thing two validators can be asked to agree on is the normalised set. Raw bodies on chain
 * would be raw bodies that guarantee disagreement, which is a consensus failure caused entirely by
 * fields neither validator should have been reading. So this panel prints the rule instead of the
 * bodies: three axes compared, eight excluded, each with the measurement that justifies excluding
 * it. A reader can check the rule rather than take the verdict on faith, which is the stronger
 * thing to be able to do.
 *
 * THE ONE STATE THAT GETS A BORDER. `TOKEN_ABSENT` is the buyer's step to take and it says so
 * with the record to publish attached. Every other non-passing verdict is a fact about a resolver
 * or about propagation, and drawing those as faults would train a reader to ignore the one that is
 * actionable. So `TOKEN_ABSENT` gets the heavy left rule and the others do not.
 */

import { CopyLine } from "@/components/copy-line";
import {
  PROOF_OUTCOME_TEXT,
  REFUSAL_TAG_TEXT,
  type Deal,
  type RefusalTag,
} from "@/lib/contract-types";
import { displayTime } from "@/lib/format";
import {
  noteTag,
  proofSentence,
  proofVerdict,
  PROOF_COMPARED,
  PROOF_EXCLUDED,
  type ProofVerdict,
} from "@/lib/witness";

const VERDICT_WORD: Record<ProofVerdict["kind"], string> = {
  CORROBORATED: "Corroborated at both resolvers",
  TOKEN_ABSENT: "Agreed, and the token is not in the set",
  DISAGREED: "The two resolvers did not agree",
  NAME_MISSING: "No record at the name",
  UNCORROBORATED: "Recorded in a shape this build does not read",
  NOT_ASKED: "No check has asked",
};

export function ControlProof({
  deal,
  heading = "The buyer's control proof",
}: {
  deal: Deal;
  heading?: string;
}) {
  const verdict = proofVerdict(deal);
  const outcome = PROOF_OUTCOME_TEXT[deal.last_proof_outcome];
  const tagged = deal.last_check_note ? noteTag(deal.last_check_note) : null;

  return (
    <section className="cv-panel p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <h3 className="cv-heading">{heading}</h3>
        <p className="cv-legend cv-legend-ink">{VERDICT_WORD[verdict.kind]}</p>
      </div>
      <p className="cv-body mt-2 max-w-[68ch]">{proofSentence(verdict)}</p>

      {deal.last_proof_outcome ? (
        <p className="cv-aside mt-2 max-w-[68ch]">
          The chain records this as{" "}
          <span className="cv-record-sm">{deal.last_proof_outcome}</span>, which it calls{" "}
          {outcome.label}. {outcome.means}
        </p>
      ) : null}

      <Asked deal={deal} />

      {verdict.kind === "CORROBORATED" ? <Corroborated verdict={verdict} /> : null}
      {verdict.kind === "TOKEN_ABSENT" ? <TokenAbsent deal={deal} verdict={verdict} /> : null}
      {verdict.kind === "DISAGREED" ? <Disagreed tagged={tagged} /> : null}
      {verdict.kind === "NAME_MISSING" ? <NameMissing deal={deal} tagged={tagged} /> : null}
      {verdict.kind === "UNCORROBORATED" ? <Unexpected /> : null}
      {verdict.kind === "NOT_ASKED" ? <NotAsked /> : null}

      <Rule />
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* What was asked                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The name and the token, always, in every state.
 *
 * Printed even when the proof holds, because a reader who cannot see what was asked cannot check
 * that the right question was asked. The token is derived by the contract from the deal id and the
 * buyer's address, so it cannot be replayed against another deal, and that is worth stating rather
 * than leaving to be inferred from its shape.
 */
function Asked({ deal }: { deal: Deal }) {
  return (
    <dl className="mt-5 grid gap-x-8 gap-y-3 plate:grid-cols-2">
      <div>
        <dt className="cv-legend">the name asked at</dt>
        <dd className="cv-record break-all">{deal.buyer_proof_name || "not recorded"}</dd>
      </div>
      <div>
        <dt className="cv-legend">last asked</dt>
        <dd className="cv-record">
          {deal.last_check_at ? displayTime(deal.last_check_at) : "never"}
          {deal.checks && deal.checks !== "0" ? (
            <span className="cv-aside ml-2">
              {deal.checks} {deal.checks === "1" ? "check" : "checks"} recorded
            </span>
          ) : null}
        </dd>
      </div>
      <div className="plate:col-span-2">
        <dt className="cv-legend">the commitment made at open</dt>
        <dd className="cv-record-sm break-all">
          {deal.buyer_proof_commitment || "not recorded"}
        </dd>
        <p className="cv-aside mt-1 max-w-[68ch]">
          The buyer committed to this digest before the seller armed, and the token itself is
          revealed to the contract later. The token is bound to this deal id and this buyer
          address, so a record published for one deal proves nothing about another.
          {deal.buyer_proof_revealed === "True"
            ? " The token has been revealed and the chain is holding it."
            : " The token has not been revealed yet, so no check can pass."}
        </p>
      </div>
    </dl>
  );
}

/* -------------------------------------------------------------------------- */
/* The six verdicts                                                           */
/* -------------------------------------------------------------------------- */

function Corroborated({ verdict }: { verdict: Extract<ProofVerdict, { kind: "CORROBORATED" }> }) {
  return (
    <div className="mt-5">
      <p className="cv-legend cv-legend-ink">The corroborated record set</p>
      <p className="cv-aside mt-1 max-w-[68ch]">
        Both resolvers returned this after normalising, and the fact that it is on chain at all is
        what proves they agreed: the contract stores an empty set when they do not.
      </p>
      <ul className="mt-2">
        {verdict.values.map((value) => (
          <li key={value} className="cv-record break-all">
            {value}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The one actionable state, and the only one with a border.
 *
 * The resolvers agreed, so what is printed here is a real statement about the buyer's zone rather
 * than a propagation artefact. The record to publish comes with it, because "the token is not in
 * the set" without the token is an instruction with the instruction missing.
 */
function TokenAbsent({
  deal,
  verdict,
}: {
  deal: Deal;
  verdict: Extract<ProofVerdict, { kind: "TOKEN_ABSENT" }>;
}) {
  return (
    <div
      className="cv-panel-engraved mt-5 p-5"
      style={{ borderLeftWidth: 3, borderLeftColor: "var(--document)" }}
    >
      <p className="cv-legend cv-legend-ink">This one is the buyer&rsquo;s step</p>
      <p className="cv-body mt-2 max-w-[68ch]">
        Both resolvers answered and agreed on what is published at this name. The set below is what
        they agreed on, and the deal&rsquo;s token is not in it. Because they agreed, this is a
        statement about the zone and not about propagation.
      </p>
      <div className="mt-4">
        <p className="cv-legend">what is published at the name now</p>
        <ul className="mt-1">
          {verdict.values.map((value) => (
            <li key={value} className="cv-record break-all">
              {value}
            </li>
          ))}
        </ul>
      </div>
      <div className="cv-rule mt-4 pt-4">
        <CopyLine
          label={`the TXT record that must exist at ${deal.buyer_proof_name}`}
          value={deal.buyer_proof_name ? `${deal.buyer_proof_name}. IN TXT "<the revealed token>"` : "not recorded"}
          note="The contract holds the token itself and does not publish it in a view, so the exact string comes from whoever revealed it. Publish it byte for byte: a trailing space or one changed character is a different value and will not verify."
        />
      </div>
    </div>
  );
}

function Disagreed({ tagged }: { tagged: { tag: string; rest: string } | null }) {
  return (
    <div className="mt-5">
      <p className="cv-legend cv-legend-ink">Nothing follows from this about the zone</p>
      <p className="cv-body mt-2 max-w-[68ch]">
        One of four things: a resolver returned no TXT answer, the two echoed different query
        names, the two returned different normalised sets, or fewer than two observations arrived.
        All four are transient or external, none is a statement about what the buyer published, and
        the contract recorded it rather than treating it as a missing record.
      </p>
      <Reason tagged={tagged} />
      <p className="cv-aside mt-3 max-w-[68ch]">
        Re-reading the sources is a fresh consensus round, not a browser refresh. Anyone at all may
        run the check again from the actions on this deal.
      </p>
    </div>
  );
}

function NameMissing({
  deal,
  tagged,
}: {
  deal: Deal;
  tagged: { tag: string; rest: string } | null;
}) {
  return (
    <div className="mt-5">
      <p className="cv-legend cv-legend-ink">Two readings, and the note separates them</p>
      <p className="cv-body mt-2 max-w-[68ch]">
        Both resolvers saying there is no record at the name means the name does not exist, and
        that is external. One saying it while the other answers means propagation is incomplete,
        and that is transient. Neither is a failed proof, and the difference is in the
        contract&rsquo;s own reason rather than in this drawing.
      </p>
      <Reason tagged={tagged} />
      {deal.buyer_proof_name ? (
        <p className="cv-aside mt-3 max-w-[68ch]">
          The name asked for is{" "}
          <span className="cv-record-sm break-all">{deal.buyer_proof_name}</span>. A record at the
          bare domain, or at a different label, is a different name and will not be seen.
        </p>
      ) : null}
    </div>
  );
}

function Unexpected() {
  return (
    <div className="mt-5">
      <p className="cv-legend cv-legend-ink">A shape this build did not expect</p>
      <p className="cv-body mt-2 max-w-[68ch]">
        The chain records a found proof with no corroborated set behind it. The contract cannot
        produce that combination, so rather than print &ldquo;corroborated&rdquo; from a field that
        contradicts itself, this panel says less. An unexpected shape must fail towards claiming
        nothing.
      </p>
    </div>
  );
}

function NotAsked() {
  return (
    <div className="mt-5">
      <p className="cv-body max-w-[68ch]">
        No check has asked the resolvers about this deal, so nothing is claimed about the
        buyer&rsquo;s zone in either direction. Anyone at all may run a check, including someone
        who is neither party.
      </p>
    </div>
  );
}

/**
 * The contract's own reason, with its tag.
 *
 * `_classify_delivery` writes the note as `"<tag> <reason>"` for the DNS outcome, so the tag is
 * recoverable from the note without a second field. Printed with the taxonomy's own gloss beside
 * it, because a bare `[TRANSIENT]` is a code and the point of the taxonomy is that it is not.
 */
function Reason({ tagged }: { tagged: { tag: string; rest: string } | null }) {
  if (!tagged) return null;
  const tag = REFUSAL_TAG_TEXT[tagged.tag as RefusalTag];
  return (
    <div className="cv-rule mt-4 pt-4">
      <p className="cv-legend cv-legend-ink">
        {tag ? tag.tag : `[${tagged.tag}]`} the contract&rsquo;s reason
      </p>
      <p className="cv-record mt-1.5 max-w-[68ch] break-words">{tagged.rest}</p>
      {tag ? <p className="cv-aside mt-1.5 max-w-[68ch]">{tag.means}</p> : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* The rule                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * What was compared and what was excluded, verbatim from the contract.
 *
 * Copied rather than derived, because there is no view that returns these lists and a paraphrase
 * would put a second version of the rule in the world. Printed in the quiet register: the
 * exclusions are what two healthy resolvers look like, and drawing them as warnings would train a
 * reader to ignore the one panel above that is actionable.
 */
function Rule() {
  return (
    <div className="cv-rule-strong mt-6 pt-5">
      <p className="cv-legend cv-legend-ink">The comparison rule</p>
      <p className="cv-aside mt-1 max-w-[68ch]">
        The contract stores no per-resolver data at all, so there are no two columns to diff here.
        This is the rule it applied instead, and it is checkable without trusting the verdict.
      </p>

      <div className="mt-4">
        <p className="cv-legend">compared, and agreement was decided on these three</p>
        <ol className="mt-1.5">
          {PROOF_COMPARED.map((axis) => (
            <li key={axis} className="cv-rule py-2 first:border-t-0 first:pt-0">
              <p className="cv-body max-w-[68ch]">{axis}</p>
            </li>
          ))}
        </ol>
      </div>

      <div className="mt-5">
        <p className="cv-legend">excluded, each with the measurement that justifies it</p>
        <p className="cv-aside mt-1 max-w-[68ch]">
          Every line here is a way two healthy resolvers differ about one record that never
          changed. A build that hashed the response body would fail consensus on all eight.
        </p>
        <ol className="mt-1.5">
          {PROOF_EXCLUDED.map((axis) => (
            <li key={axis} className="cv-rule py-2 first:border-t-0 first:pt-0">
              <p className="cv-aside max-w-[68ch]">{axis}</p>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
