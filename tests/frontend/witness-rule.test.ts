import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { Deal, ProofOutcome } from "../../src/lib/contract-types.ts";
import {
  PROOF_COMPARED,
  PROOF_EXCLUDED,
  noteTag,
  proofHolds,
  proofSentence,
  proofVerdict,
} from "../../src/lib/witness.ts";

/**
 * The one inference this interface draws from the chain, checked against the contract that
 * produces the values it draws it from.
 *
 * `witness.ts` reads two stored fields and concludes something neither of them states outright: a
 * non-empty `last_proof_values` means the two resolvers agreed, because `Corroboration.__init__`
 * only keeps the values when they did. That inference is load bearing. `PROOF_ABSENT` covers both
 * "the resolvers agreed and the token was not there", which is a fact about the buyer's zone, and
 * "the resolvers did not agree at all", which is a fact about propagation. Collapsing them would
 * tell a buyer to republish a record that is already published.
 *
 * So the contract is read at test time and the premise is asserted directly, rather than the
 * conclusion being trusted because the comment above it is convincing.
 */

const CONTRACT = readFileSync(
  fileURLToPath(new URL("../../contracts/Conveyance.py", import.meta.url)),
  "utf8",
);

/** A deal with every field empty, so each test names only the fields it is about. */
function dealWith(fields: Partial<Deal>): Deal {
  const blank = Object.fromEntries(
    (
      `deal_id state buyer seller domain tld rdap_base target_registrar_id target_nameservers ` +
      `seller_proof_name seller_proof_token buyer_proof_name buyer_proof_commitment ` +
      `buyer_proof_revealed escrow opened_at accept_deadline armed_at transfer_deadline ` +
      `verified_at inspection_deadline closed_at baseline_registrar_id baseline_registrar_name ` +
      `baseline_nameservers baseline_statuses baseline_transfer_at baseline_last_changed_at ` +
      `baseline_digest baseline_client_transfer_locked checks last_check_at last_check_outcome ` +
      `last_check_note last_check_registrar_id last_check_nameservers last_check_statuses ` +
      `last_check_transfer_at last_check_digest last_proof_outcome last_proof_values ` +
      `delivered_registrar_id delivered_transfer_at delivered_digest delivered_proof_digest ` +
      `paid_to_seller returned_to_buyer`
    )
      .split(/\s+/)
      .map((key) => [key, ""]),
  );
  return { ...blank, ...fields } as Deal;
}

const TOKEN = "conveyance-buyer-v1=aXQgd2FzIGhlcmU";

/* --- the premise, read out of the contract -------------------------------- */

/**
 * The inference is only sound because the contract discards the values when the resolvers
 * disagree. If that line ever kept them, a set on chain would stop meaning agreement and every
 * verdict below would silently change meaning without a single one of them failing.
 */
test("the contract only stores a record set when the two resolvers agreed", () => {
  assert.match(
    CONTRACT,
    /self\.values\s*=\s*first\.values if \(agreed and first is not None\) else \(\)/,
    "Corroboration no longer discards the values on disagreement, so a set on chain no longer proves agreement",
  );
});

/**
 * And it is only necessary because `PROOF_ABSENT` has two producers. Both are asserted so that a
 * third producer, or the collapse of these two, shows up here.
 */
test("the contract returns PROOF_ABSENT from both an agreed miss and a disagreement", () => {
  const classify = CONTRACT.slice(
    CONTRACT.indexOf("def classify_proof("),
    CONTRACT.indexOf("def ", CONTRACT.indexOf("def classify_proof(") + 10),
  );
  const returns = [...classify.matchAll(/"outcome": PROOF_([A-Z_]+)/g)].map((match) => match[1]);
  assert.ok(returns.filter((name) => name === "ABSENT").length >= 2, `saw ${returns.join(", ")}`);
  assert.ok(returns.includes("FOUND"));
  assert.ok(returns.includes("NAME_MISSING"));
});

test("the three proof outcomes this file switches on are the contract's three", () => {
  for (const name of ["PROOF_ABSENT", "PROOF_FOUND", "PROOF_NAME_MISSING"]) {
    assert.match(CONTRACT, new RegExp(`^${name} = `, "m"));
  }
});

/* --- the verdict ---------------------------------------------------------- */

/**
 * Absence first. A deal nobody has checked must not become a statement about whether the buyer
 * published anything, and the empty outcome is the common case: every deal has it until the first
 * check runs.
 */
test("a deal nobody has checked says so, and says nothing about the zone", () => {
  const verdict = proofVerdict(dealWith({}));
  assert.deepEqual(verdict, { kind: "NOT_ASKED" });
  assert.match(proofSentence(verdict), /No check has asked/);
  assert.equal(proofHolds(verdict), false);
});

test("an outcome with no values behind it is not read as agreement", () => {
  for (const outcome of ["PROOF_FOUND", "PROOF_ABSENT"] as ProofOutcome[]) {
    const verdict = proofVerdict(dealWith({ last_proof_outcome: outcome }));
    assert.notEqual(verdict.kind, "CORROBORATED", outcome);
  }
});

test("found with a corroborated set behind it is the only verdict that holds", () => {
  const verdict = proofVerdict(
    dealWith({ last_proof_outcome: "PROOF_FOUND", last_proof_values: TOKEN }),
  );
  assert.deepEqual(verdict, { kind: "CORROBORATED", values: [TOKEN] });
  assert.equal(proofHolds(verdict), true);
});

/**
 * The split that the whole file exists for. Same recorded outcome, opposite conclusions, decided
 * only by whether a set reached the chain.
 */
test("PROOF_ABSENT with a set is a published record missing the token", () => {
  const other = "some-other-verification=abc";
  const verdict = proofVerdict(
    dealWith({ last_proof_outcome: "PROOF_ABSENT", last_proof_values: other }),
  );
  assert.deepEqual(verdict, { kind: "TOKEN_ABSENT", values: [other] });
  assert.match(proofSentence(verdict), /agreed on what is published/);
  assert.equal(proofHolds(verdict), false);
});

test("PROOF_ABSENT with no set is a disagreement and claims nothing about the zone", () => {
  const verdict = proofVerdict(dealWith({ last_proof_outcome: "PROOF_ABSENT" }));
  assert.deepEqual(verdict, { kind: "DISAGREED" });
  assert.match(proofSentence(verdict), /Nothing follows from that about the buyer's zone/);
  assert.equal(proofHolds(verdict), false);
});

/**
 * The two PROOF_ABSENT sentences must not be interchangeable, because the reader's next action
 * differs: one republishes a record, the other waits.
 */
test("the two PROOF_ABSENT verdicts do not read alike", () => {
  const agreed = proofSentence(
    proofVerdict(dealWith({ last_proof_outcome: "PROOF_ABSENT", last_proof_values: TOKEN })),
  );
  const disagreed = proofSentence(proofVerdict(dealWith({ last_proof_outcome: "PROOF_ABSENT" })));
  assert.notEqual(agreed, disagreed);
  assert.ok(!disagreed.includes("has to be published"), "a disagreement must not ask for a republish");
});

test("a missing name is reported without calling it a failed proof", () => {
  const verdict = proofVerdict(dealWith({ last_proof_outcome: "PROOF_NAME_MISSING" }));
  assert.deepEqual(verdict, { kind: "NAME_MISSING" });
  assert.match(proofSentence(verdict), /Neither is a failed proof/);
});

/**
 * A shape the contract cannot produce still has to print something, and what it prints must not be
 * "corroborated". An unexpected combination fails towards saying less.
 */
test("an unexpected combination names itself instead of claiming corroboration", () => {
  const verdict = proofVerdict(
    dealWith({ last_proof_outcome: "PROOF_NAME_MISSING", last_proof_values: TOKEN }),
  );
  assert.equal(verdict.kind, "NAME_MISSING");

  const surprising = proofVerdict(dealWith({ last_proof_outcome: "PROOF_MYSTERY" as ProofOutcome }));
  assert.deepEqual(surprising, { kind: "UNCORROBORATED", outcome: "PROOF_MYSTERY" });
  assert.equal(proofHolds(surprising), false);
  assert.match(proofSentence(surprising), /with no corroborated record set behind it/);
});

test("every verdict has a sentence and no two of them are the same", () => {
  const verdicts = [
    proofVerdict(dealWith({})),
    proofVerdict(dealWith({ last_proof_outcome: "PROOF_FOUND", last_proof_values: TOKEN })),
    proofVerdict(dealWith({ last_proof_outcome: "PROOF_ABSENT", last_proof_values: TOKEN })),
    proofVerdict(dealWith({ last_proof_outcome: "PROOF_ABSENT" })),
    proofVerdict(dealWith({ last_proof_outcome: "PROOF_NAME_MISSING" })),
    proofVerdict(dealWith({ last_proof_outcome: "PROOF_X" as ProofOutcome })),
  ];
  const sentences = verdicts.map(proofSentence);
  for (const sentence of sentences) assert.ok(sentence.length > 40, sentence);
  assert.equal(new Set(sentences).size, sentences.length);
  assert.equal(verdicts.filter(proofHolds).length, 1, "exactly one verdict may hold");
});

test("a multi-value record set is carried whole rather than reduced to the first", () => {
  const verdict = proofVerdict(
    dealWith({ last_proof_outcome: "PROOF_FOUND", last_proof_values: `${TOKEN},v=spf1 -all` }),
  );
  assert.equal(verdict.kind, "CORROBORATED");
  assert.deepEqual(verdict.kind === "CORROBORATED" && verdict.values, [TOKEN, "v=spf1 -all"]);
});

/* --- the comparison rule -------------------------------------------------- */

/**
 * The compared axes are copied out of the contract rather than derived, because no view returns
 * them. A copy needs its original checked, so the contract's own tuple is counted here.
 */
test("the three compared axes match the count the contract compares", () => {
  const tuple = CONTRACT.match(/^PROOF_COMPARED = \(([\s\S]*?)\)$/m);
  assert.ok(tuple, "the contract no longer names its compared axes as PROOF_COMPARED");
  const entries = [...tuple[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  assert.equal(PROOF_COMPARED.length, entries.length, `contract compares ${entries.join(", ")}`);
});

/**
 * The excluded axes are the interesting half: each one is a way two healthy resolvers differ
 * about a record that never changed. Every line has to carry the reason, or the list becomes a
 * list of things somebody once decided to ignore.
 */
test("every excluded axis says why it is excluded", () => {
  assert.ok(PROOF_EXCLUDED.length === 8, `expected the eight measured axes, saw ${PROOF_EXCLUDED.length}`);
  for (const axis of PROOF_EXCLUDED) {
    assert.ok(
      /\bbecause\b|\bwhich\b|,\s(present|kept|worth)\b/.test(axis),
      `no reason given: ${axis}`,
    );
  }
});

test("no axis is both compared and excluded", () => {
  for (const compared of PROOF_COMPARED) {
    for (const excluded of PROOF_EXCLUDED) {
      assert.notEqual(compared, excluded);
    }
  }
});

/* --- the tag on a note ---------------------------------------------------- */

test("a tagged note is split into its tag and the reason, keeping the reason whole", () => {
  const parsed = noteTag("[TRANSIENT] the two resolvers returned different record sets");
  assert.deepEqual(parsed, {
    tag: "TRANSIENT",
    rest: "the two resolvers returned different record sets",
  });
});

test("all four tags are recognised, and they are the contract's four", () => {
  for (const tag of ["EXPECTED", "EXTERNAL", "TRANSIENT", "LLM_ERROR"]) {
    assert.equal(noteTag(`[${tag}] something`)?.tag, tag);
    assert.match(CONTRACT, new RegExp(`^TAG_${tag} = "\\[${tag}\\]"$`, "m"));
  }
});

/**
 * Null rather than an invented tag. An untagged note is every outcome other than AWAITING_DNS, so
 * this is the common path, and a fabricated `[EXPECTED]` on it would turn a description into a
 * verdict.
 */
test("an untagged note gets no tag rather than a plausible one", () => {
  for (const note of ["", "the registrar id still matches the baseline", "[SOMETHING] else"]) {
    assert.equal(noteTag(note), null, JSON.stringify(note));
  }
});

test("a tag has to be at the front of the note to count", () => {
  assert.equal(noteTag("the resolvers disagreed [TRANSIENT]"), null);
});
