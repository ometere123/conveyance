import assert from "node:assert/strict";
import test from "node:test";
import {
  refusalIn,
  refusalReturned,
  returnedFromTransaction,
  returnedRecord,
  returnedValue,
} from "../../src/lib/genlayer/returned-value.ts";

/**
 * A refused call finalizes with GenVM SUCCESS. That is the whole reason this module exists and the
 * reason these tests are worth having.
 *
 * `open_deal` is the one payable method in this contract, and it is the one that refuses by
 * refunding `gl.message.value` and returning its tagged reason instead of raising. The reason is
 * measured rather than stylistic: this chain rolls storage back on a revert and does not return the
 * value that arrived with the call, so a reverting payable method would keep the escrow of a caller
 * it had just turned down. The other eleven methods cannot receive value, so they still raise.
 *
 * The cost of that choice is that "the transaction succeeded" and "the request was accepted" stop
 * being the same statement. An interface that checked only the first would print a deal id over an
 * escrow that had just been handed straight back.
 *
 * THE MARKER IS THIS CONTRACT'S FOUR TAGS, and these tests are the reason that is written down.
 * This module began as a copy of one that looked for `[REJECTED]`, a word Conveyance never writes,
 * so every refusal read as a success and every declined `open_deal` would have been reported to the
 * buyer as an open deal. The tests below pin all four tags and pin what happens to a fifth word
 * that is not one of them.
 *
 * The payload shapes are the ones StudioNet produces, not invented ones: a decoded return arrives
 * as `{status: "return", payload: {raw, readable}}` with the readable form JSON quoted, and a raise
 * arrives as `{status: "rollback", payload: "<the contract's own words>"}`. `probe_domain` is the
 * exception that shaped the decoder: it returns a dict from a write, so its answer exists only on a
 * receipt and arrives already decoded into an object.
 */

const returned = (readable: string) => ({
  raw: "AAAA",
  status: "return",
  payload: { raw: [0], readable },
});

const rollback = (message: string) => ({ raw: "AQAA", status: "rollback", payload: message });

/** The undecoded form, for a caller reading the RPC without the client. */
function base64(code: number, body: string): string {
  return Buffer.concat([Buffer.from([code]), Buffer.from(body, "utf8")]).toString("base64");
}

/**
 * A returned string arrives calldata encoded, so its text never begins at byte one.
 *
 * That is why the decoder steps over a length prefix rather than testing the very start of the
 * payload, and why these tests have to reproduce the prefix instead of handing it a bare string.
 * One byte is enough for every body here: all of them are well under 128 characters.
 */
function calldataString(body: string): string {
  return String.fromCharCode(body.length) + body;
}

/* --- ordinary successes ---------------------------------------------------- */

test("a returned deal id decodes to the id", () => {
  assert.deepEqual(returnedValue(returned('"d-1"')), { kind: "returned", text: "d-1" });
});

test("an accepted call is not a refusal", () => {
  assert.equal(refusalIn(returned('"d-1"')), undefined);
});

test("a method that returns nothing decodes to an empty return, not to unreadable", () => {
  assert.deepEqual(returnedValue({ status: "none", payload: null }), {
    kind: "returned",
    text: "",
  });
  assert.deepEqual(returnedValue({ status: "return", payload: null }), {
    kind: "returned",
    text: "",
  });
});

/* --- the refusal that looks like a success --------------------------------- */

test("a refused open_deal is read as a refusal and its reason is kept whole", () => {
  const receipt = returned('"[EXPECTED] a deal needs an escrow; this call carried no value"');
  assert.equal(
    refusalIn(receipt),
    "[EXPECTED] a deal needs an escrow; this call carried no value",
  );
});

/**
 * All four, because which one arrived is the part that decides what to do next.
 *
 * `[EXPECTED]` is a rule firing and the same call will be refused again. `[EXTERNAL]` is a registry
 * that did not answer, `[TRANSIENT]` is nothing having been decided, and both of those are worth
 * sending again. `[LLM_ERROR]` cannot happen in this contract, which runs no model, and is carried
 * so that its absence from the register is checkable rather than assumed.
 */
test("every tag in the taxonomy is recognised as a refusal", () => {
  const cases = [
    ["[EXPECTED]", "the domain is locked against transfer at the registry"],
    ["[EXTERNAL]", "RDAP returned 404"],
    ["[TRANSIENT]", "the registry answered about another domain"],
    ["[LLM_ERROR]", "the model answered in a shape the contract would not accept"],
  ];
  for (const [tag, reason] of cases) {
    assert.equal(refusalIn(returned(`"${tag} ${reason}"`)), `${tag} ${reason}`, tag);
  }
});

/**
 * The tag stays on, and this is the test that says so on purpose.
 *
 * `classify` in `src/lib/lifecycle.ts` reads the tag to decide whether the interface offers a retry,
 * and the rail prints the tag with its own gloss beside it. A decoder that stripped the tag off
 * would leave both of them guessing from the words, which is what the taxonomy exists to avoid.
 */
test("the tag is kept rather than stripped, because the tag is the retryable part", () => {
  const said = refusalIn(returned('"[EXTERNAL] RDAP returned 404"'));
  assert.ok(said?.startsWith("[EXTERNAL]"), said);
  assert.ok(said?.includes("RDAP returned 404"), said);
});

test("surrounding whitespace is trimmed and nothing else is edited", () => {
  assert.equal(
    refusalIn(returned('"  [EXPECTED] deal \'d-1\' already exists  "')),
    "[EXPECTED] deal 'd-1' already exists",
  );
});

test("a refusal with no words still reports one, rather than a bare tag", () => {
  assert.equal(refusalIn(returned('"[EXPECTED]"')), "[EXPECTED] no reason was given");
});

test("a reason that merely contains a tag later in the sentence is not a refusal", () => {
  assert.equal(refusalIn(returned('"the transfer was [EXPECTED] once"')), undefined);
});

/**
 * The tag this module used to look for. It came in with the file, from a contract whose refusals
 * are bonded review requests rather than escrows, and it is asserted absent so the copy cannot
 * drift back.
 */
test("a word that is not in this contract's taxonomy is not a refusal", () => {
  assert.equal(refusalIn(returned('"[REJECTED] a deal needs an escrow"')), undefined);
  assert.equal(refusalIn(returned('"[ERROR] a deal needs an escrow"')), undefined);
  assert.equal(refusalIn(returned('"[expected] a deal needs an escrow"')), undefined);
});

/* --- the revert, which is a different event -------------------------------- */

test("a revert is never read as a refusal, even carrying the same words", () => {
  const receipt = rollback("[EXPECTED] a deal needs an escrow; this call carried no value");
  assert.deepEqual(returnedValue(receipt), {
    kind: "reverted",
    message: "[EXPECTED] a deal needs an escrow; this call carried no value",
  });
  assert.equal(refusalIn(receipt), undefined);
});

test("a contract error is a revert too", () => {
  assert.deepEqual(returnedValue({ status: "contract_error", payload: "boom" }), {
    kind: "reverted",
    message: "boom",
  });
});

/**
 * The offer form rehearses `open_deal` with no value attached and expects the escrow refusal back.
 * That refusal can arrive either way and the form has to recognise the reason in both: as a
 * returned refusal from the current contract, and as a revert from a build where the same rule
 * raised. If the decoder ever stopped surfacing the message on a revert, the rehearsal would read
 * every refusal as "not established" and the form would never unlock.
 */
test("a rehearsal's escrow refusal is legible whether it reverts or returns", () => {
  const words = "a deal needs an escrow; this call carried no value";
  const asRevert = returnedValue(rollback(`[EXPECTED] ${words}`));
  assert.equal(asRevert.kind, "reverted");
  assert.ok(asRevert.kind === "reverted" && asRevert.message.includes(words));

  const asReturn = returnedValue(returned(`"[EXPECTED] ${words}"`));
  assert.ok(asReturn.kind === "returned" && asReturn.text.includes(words));
  assert.ok(refusalIn(returned(`"[EXPECTED] ${words}"`))?.includes(words));
});

/* --- the record, which only probe_domain returns --------------------------- */

test("a decoded record survives as a structure rather than being discarded", () => {
  const probe = { domain: "example.com", registrar_iana_id: "1910", escrowable: "True" };
  const value = returnedValue({ status: "return", payload: probe });
  assert.deepEqual(value, { kind: "structure", value: probe });
  assert.deepEqual(returnedRecord(value), probe);
});

test("a record arriving as JSON text is parsed", () => {
  const value = returnedValue(returned('"{\\"domain\\": \\"example.com\\"}"'));
  assert.deepEqual(returnedRecord(value), { domain: "example.com" });
});

/**
 * A Python dict repr uses single quotes and is not JSON. Rewriting it into something that would
 * parse is guesswork, and guesswork here would put invented registry facts on a page that exists
 * to report registry facts. Null is the honest answer and the form prints a sentence for it.
 */
test("a Python dict repr is refused rather than repaired", () => {
  const value = returnedValue(returned("\"{'domain': 'example.com'}\""));
  assert.equal(returnedRecord(value), null);
});

test("a plain string, a revert and an unreadable receipt are all not records", () => {
  assert.equal(returnedRecord({ kind: "returned", text: "d-1" }), null);
  assert.equal(returnedRecord({ kind: "reverted", message: "no" }), null);
  assert.equal(returnedRecord({ kind: "unreadable" }), null);
});

test("a JSON array is not a record", () => {
  assert.equal(returnedRecord(returnedValue(returned('"[1, 2]"'))), null);
});

/* --- the undecoded form ---------------------------------------------------- */

test("result code zero is a return and the tag is found past the length prefix", () => {
  const body = calldataString("[EXPECTED] deal 'd-1' already exists");
  assert.equal(refusalIn(base64(0, body)), "[EXPECTED] deal 'd-1' already exists");
});

/**
 * The bound on how far the decoder will step is what keeps the undecoded path as strict as the
 * decoded one. A tag quoted deep inside a returned sentence is a sentence about a refusal, and
 * before the bound existed this path would have read it as one.
 */
test("a tag sitting well past the length prefix is not a refusal", () => {
  const body = calldataString("the seller was told [EXPECTED] and did nothing");
  assert.equal(refusalIn(base64(0, body)), undefined);
});

test("result codes one, two and three are reverts", () => {
  for (const code of [1, 2, 3]) {
    const value = returnedValue(base64(code, "gone wrong"));
    assert.equal(value.kind, "reverted", `code ${code} should revert`);
  }
});

test("result code four is an empty return", () => {
  assert.deepEqual(returnedValue(base64(4, "")), { kind: "returned", text: "" });
});

test("an unknown result code is unreadable rather than guessed at", () => {
  assert.deepEqual(returnedValue(base64(9, "whatever")), { kind: "unreadable" });
});

test("base64 that is not base64, and an empty payload, are unreadable", () => {
  assert.deepEqual(returnedValue("not base64 at all!!"), { kind: "unreadable" });
  assert.deepEqual(returnedValue(""), { kind: "unreadable" });
});

/* --- reading it off a transaction ----------------------------------------- */

test("the leader receipt is found whether it is an array or a single object", () => {
  const result = returned('"d-1"');
  assert.deepEqual(
    returnedFromTransaction({ consensus_data: { leader_receipt: [{ result }] } }),
    { kind: "returned", text: "d-1" },
  );
  assert.deepEqual(returnedFromTransaction({ consensus_data: { leader_receipt: { result } } }), {
    kind: "returned",
    text: "d-1",
  });
});

test("a transaction with no consensus data yet is unreadable, not accepted", () => {
  assert.deepEqual(returnedFromTransaction({ hash: "0xabc" }), { kind: "unreadable" });
  assert.deepEqual(returnedFromTransaction({ consensus_data: null }), { kind: "unreadable" });
  assert.deepEqual(returnedFromTransaction(undefined), { kind: "unreadable" });
});

test("refusalReturned reads only a returned value, by construction", () => {
  assert.equal(refusalReturned({ kind: "returned", text: "[EXPECTED] no" }), "[EXPECTED] no");
  assert.equal(refusalReturned({ kind: "reverted", message: "[EXPECTED] no" }), undefined);
  assert.equal(refusalReturned({ kind: "structure", value: {} }), undefined);
  assert.equal(refusalReturned({ kind: "unreadable" }), undefined);
});
