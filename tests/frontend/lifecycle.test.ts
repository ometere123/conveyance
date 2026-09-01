import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  CALLER_TEXT,
  CLIENT_PHASES,
  DEADLINE_TEXT,
  METHODS,
  METHODS_BY_STATE,
  OUTCOMES,
  PROGRAMS,
  TAG_TO_CLASS,
  classify,
  doorsFrom,
} from "../../src/lib/lifecycle.ts";
import { DEAL_STATES, type DealState } from "../../src/lib/contract-types.ts";

/**
 * The table of who may call what, checked against the guards it describes.
 *
 * `lifecycle.ts` is the only place in this interface that states a rule rather than printing a
 * value the contract returned. Every control on a deal page is drawn from it: the button's words,
 * the caller line, the deadline a door waits on, and the sentence explaining why the rule is that
 * rule. A table like that decays in a particular way. Nothing throws when it drifts. The contract
 * tightens a guard, the table still says anyone may press it, the button stays enabled, and the
 * reader spends a signature to be told no by the chain.
 *
 * So the assertions here are against `contracts/Conveyance.py` wherever a guard can be read out of
 * it: the decorated method names, the single payable, the `_require_state` argument tuples, the
 * `sender_address` comparisons, the four value sites, the six `ST_` constants and the four tags.
 * Where the contract cannot be read mechanically, the table is checked against itself for the
 * properties a control depends on, which is the difference between a claim and a spelling.
 */

const CONTRACT = readFileSync(
  fileURLToPath(new URL("../../contracts/Conveyance.py", import.meta.url)),
  "utf8",
);

/* --- the method table against the contract's decorators -------------------- */

/**
 * Every `@gl.public.write` in the contract, in source order, paired with the name beneath it.
 *
 * Views are excluded deliberately. `METHODS` describes what a signature can be spent on, and a
 * view costs nothing and has no doors, so listing one here would put a button on a page for
 * something that is already on screen.
 */
function contractWrites(): { name: string; payable: boolean }[] {
  const found: { name: string; payable: boolean }[] = [];
  const pattern = /@gl\.public\.write(\.payable)?\s*\n\s*def ([a-z_]+)\(/g;
  for (const match of CONTRACT.matchAll(pattern)) {
    found.push({ name: match[2], payable: Boolean(match[1]) });
  }
  return found;
}

test("the methods this interface offers are the writes the contract has, and no others", () => {
  const writes = contractWrites();
  assert.ok(writes.length > 0, "no @gl.public.write methods were found in the contract");
  assert.deepEqual(
    writes.map((write) => write.name).sort(),
    Object.keys(METHODS).sort(),
  );
});

/**
 * The product document lists ten methods and an LLM adjudication step. The contract has seven and
 * no model, and its header argues why. This asserts the count so the divergence stays a decision
 * somebody made rather than something that quietly drifted back.
 */
test("there are seven writes, matching the contract rather than the product document", () => {
  assert.equal(Object.keys(METHODS).length, 7);
  assert.equal(contractWrites().length, 7);
});

test("each entry's name field matches the key it is filed under", () => {
  for (const [key, spec] of Object.entries(METHODS)) assert.equal(spec.name, key);
});

/**
 * Exactly one method is payable and the interface has to agree about which. A form that attached
 * value to a non-payable method would revert; a form that attached none to `open_deal` would open a
 * deal with an empty escrow, which is the one thing the contract refuses by reverting rather than
 * by refunding.
 */
test("open_deal is the only payable method, in the table and in the contract", () => {
  const payableInContract = contractWrites().filter((write) => write.payable);
  assert.deepEqual(payableInContract.map((write) => write.name), ["open_deal"]);

  const payableInTable = Object.values(METHODS).filter((spec) => spec.payable);
  assert.deepEqual(payableInTable.map((spec) => spec.name), ["open_deal"]);
});

/**
 * Four methods move escrow, and the contract has five value sites to do it with.
 *
 * `settle`, `refund` and `abandon` each call `_pay` once, paying out an escrow the contract is
 * already holding. `open_deal` reads `gl.message.value` twice and calls `_pay` once more: it records
 * the escrow on the way in, and it hands the same figure straight back when it refuses. That fourth
 * `_pay` is not a fourth payout door. It is there because a revert on this chain rolls storage back
 * and keeps the value that arrived with the call, so the one payable method has to refuse by
 * returning rather than by raising, or a caller who was told no would have paid for the answer.
 *
 * Both counts are pinned because a fifth `_pay` appearing without a control naming it would be
 * money moving off a page that says nothing moves, and a third value read would mean the figure
 * was being used somewhere neither of these two purposes covers.
 */
test("the methods that move escrow are the four the contract moves it in", () => {
  const paySites = CONTRACT.match(/self\._pay\(/g) ?? [];
  const valueReads = CONTRACT.match(/int\(gl\.message\.value\)/g) ?? [];
  assert.equal(paySites.length, 4);
  assert.equal(valueReads.length, 2);

  // The refusal path pays back exactly what arrived, to whoever sent it. Anything else at this
  // site would be a payment made by a method that is in the act of refusing to store a deal.
  assert.match(
    CONTRACT,
    /self\._pay\(gl\.message\.sender_address, u256\(int\(gl\.message\.value\)\)\)/,
  );

  const movers = Object.values(METHODS)
    .filter((spec) => spec.movesValue)
    .map((spec) => spec.name)
    .sort();
  assert.deepEqual(movers, ["abandon", "open_deal", "refund", "settle"]);
});

test("a method that moves no value has no door claiming otherwise", () => {
  for (const spec of Object.values(METHODS)) {
    if (spec.payable) assert.equal(spec.movesValue, true, `${spec.name} takes value but moves none`);
  }
});

test("every method has a button word, an effect line and at least one door", () => {
  for (const spec of Object.values(METHODS)) {
    assert.ok(spec.action.length > 0, `${spec.name} has no action word`);
    assert.ok(spec.effect.length > 0, `${spec.name} has no effect line`);
    assert.ok(spec.doors.length > 0, `${spec.name} has no doors, so nothing can call it`);
    assert.notEqual(spec.action, spec.name, `${spec.name}'s button prints the method name`);
  }
});

/* --- the doors ------------------------------------------------------------- */

test("every door names a state the contract has and a reason a control can print", () => {
  for (const spec of Object.values(METHODS)) {
    for (const door of spec.doors) {
      assert.ok(DEAL_STATES.includes(door.from), `${spec.name} has a door from ${door.from}`);
      assert.ok(door.because.length > 40, `${spec.name}'s door from ${door.from} explains nothing`);
      assert.ok(door.caller in CALLER_TEXT, `${spec.name} names an unprintable caller`);
    }
  }
});

test("every deadline a door waits on is a deadline with words for it", () => {
  for (const spec of Object.values(METHODS)) {
    for (const door of spec.doors) {
      if (door.after) assert.ok(door.after in DEADLINE_TEXT, `${spec.name}: ${door.after}`);
      if (door.widensAfter) {
        assert.ok(door.widensAfter in DEADLINE_TEXT, `${spec.name}: ${door.widensAfter}`);
      }
    }
  }
});

/**
 * `after` shuts a door until a deadline passes; `widensAfter` opens one to everybody once it does.
 * A door carrying both would be describing two different rules in one row, and the control would
 * have to pick one to print.
 */
test("no door both waits on a deadline and widens at one", () => {
  for (const spec of Object.values(METHODS)) {
    for (const door of spec.doors) {
      assert.ok(!(door.after && door.widensAfter), `${spec.name}'s door from ${door.from}`);
    }
  }
});

test("a door that widens starts narrower than anyone, or the widening says nothing", () => {
  for (const spec of Object.values(METHODS)) {
    for (const door of spec.doors) {
      if (door.widensAfter) assert.notEqual(door.caller, "anyone", spec.name);
    }
  }
});

test("no method has two doors out of one state", () => {
  for (const spec of Object.values(METHODS)) {
    const states = spec.doors.map((door) => door.from);
    assert.equal(new Set(states).size, states.length, `${spec.name} has a duplicate door`);
  }
});

/* --- the doors against the contract's own guards --------------------------- */

/** The states one `_require_state(deal, (…), "name()")` call permits. */
function statesRequiredBy(method: string): DealState[] {
  const call = CONTRACT.match(
    new RegExp(`_require_state\\(deal, \\(([^)]*)\\), "${method}\\(\\)"\\)`),
  );
  assert.ok(call, `${method} no longer guards its state with _require_state`);
  return call[1]
    .split(",")
    .map((token) => token.trim())
    .filter(Boolean)
    .map((token) => {
      assert.match(token, /^ST_[A-Z]+$/, `${method} guards on something that is not a state`);
      return token.slice(3) as DealState;
    });
}

test("arm, check_transfer, settle and abandon open exactly where the contract lets them", () => {
  for (const method of ["arm", "check_transfer", "settle", "abandon"]) {
    assert.deepEqual(
      METHODS[method].doors.map((door) => door.from).sort(),
      statesRequiredBy(method).sort(),
      `${method}'s doors and its _require_state disagree`,
    );
  }
});

/**
 * `refund` is the one write that does not use `_require_state`, because each of its three doors has
 * a different condition and the refusal has to say which one was missed. Its states are read out of
 * the branch chain instead, and the final `else` is what refuses VERIFIED.
 */
test("refund's three doors are the three branches the contract actually has", () => {
  const branches = [...CONTRACT.matchAll(/deal\.state == (ST_[A-Z]+):/g)].map((m) => m[1]);
  for (const state of ["ST_OFFERED", "ST_LOCKED", "ST_REVERSED"]) {
    assert.ok(branches.includes(state), `refund no longer branches on ${state}`);
  }
  assert.deepEqual(METHODS.refund.doors.map((door) => door.from).sort(), [
    "LOCKED",
    "OFFERED",
    "REVERSED",
  ]);
});

/**
 * VERIFIED is the state a refund must not run from. A seller who delivered is owed the price, and
 * a buyer who believes the delivery came apart has `check_transfer`, which can reach REVERSED and
 * open the refund door properly. A control offering a refund from VERIFIED would be offering a
 * delivered seller's money back.
 */
test("no refund door runs from VERIFIED, and the contract still refuses one", () => {
  assert.ok(!METHODS.refund.doors.some((door) => door.from === "VERIFIED"));
  assert.ok(!METHODS_BY_STATE.VERIFIED.includes("refund"));
  assert.match(CONTRACT, /a refund needs %s, %s or %s/);
});

test("arm is seller only, and the contract compares the sender to the seller", () => {
  assert.deepEqual(METHODS.arm.doors.map((door) => door.caller), ["seller"]);
  assert.match(CONTRACT, /if gl\.message\.sender_address != deal\.seller:/);
});

/**
 * `settle` belongs to the buyer until the inspection window closes and to everybody afterwards.
 * The contract writes that as one condition with an `and` in it, and flattening it to "buyer only"
 * on a control would hide the mechanism that stops a buyer sitting on a delivered seller's money.
 */
test("settle is the buyer's until the inspection deadline, then anyone's", () => {
  const [door] = METHODS.settle.doors;
  assert.equal(door.caller, "buyer");
  assert.equal(door.widensAfter, "inspection_deadline");
  assert.match(
    CONTRACT,
    /if caller != deal\.buyer and not self\._at_or_after\(now, deal\.inspection_deadline\):/,
  );
});

test("abandon is either party from OFFERED and the seller alone from LOCKED", () => {
  const byState = Object.fromEntries(METHODS.abandon.doors.map((door) => [door.from, door.caller]));
  assert.deepEqual(byState, { OFFERED: "either-party", LOCKED: "seller" });

  assert.match(CONTRACT, /if caller != deal\.seller:/);
  assert.match(CONTRACT, /if caller != deal\.seller and caller != deal\.buyer:/);
});

/**
 * Four writes have no sender check at all, and that is the design rather than an omission. A
 * deadline does not fire on a chain, so somebody has to press a button after it passes, and a rule
 * naming who may press it is a rule about who can get stuck.
 *
 * So the sender is read in five places and only three of them gate anything, and this test accounts
 * for all five by shape rather than by counting to five. The three that gate are one direct
 * comparison in `arm` and two bindings to `caller` that `settle` and `abandon` then compare. The two
 * that gate nothing are the one that records the buyer at open, where there is no earlier party to
 * check against, and the refund destination on the refusal path, which hands the sender their own
 * value back rather than deciding anything about them. The sum is asserted against the total, so a
 * sixth site in a shape none of these four patterns matches fails here rather than passing quietly.
 */
test("the permissionless writes are permissionless, and the contract has no extra sender check", () => {
  const senderSites = (CONTRACT.match(/sender_address/g) ?? []).length;
  const gating = {
    "compared in arm": (CONTRACT.match(/if gl\.message\.sender_address != /g) ?? []).length,
    "bound as caller": (CONTRACT.match(/caller = gl\.message\.sender_address/g) ?? []).length,
  };
  const notGating = {
    "recorded as the buyer": (CONTRACT.match(/buyer = gl\.message\.sender_address/g) ?? []).length,
    "paid back on a refusal": (CONTRACT.match(/self\._pay\(gl\.message\.sender_address, /g) ?? [])
      .length,
  };
  assert.deepEqual(gating, { "compared in arm": 1, "bound as caller": 2 });
  assert.deepEqual(notGating, { "recorded as the buyer": 1, "paid back on a refusal": 1 });

  const accounted = [...Object.values(gating), ...Object.values(notGating)].reduce((a, b) => a + b);
  assert.equal(senderSites, accounted, "a sender site appeared in a shape nothing here recognises");

  const permissionless = Object.values(METHODS)
    .filter((spec) => spec.doors.every((door) => door.caller === "anyone"))
    .map((spec) => spec.name)
    .sort();
  assert.deepEqual(permissionless, ["check_transfer", "open_deal", "probe_domain", "refund"]);
});

/* --- the register of what can be pressed from where ------------------------ */

test("METHODS_BY_STATE lists exactly the methods with a door out of that state", () => {
  for (const state of DEAL_STATES) {
    const derived = Object.keys(METHODS)
      .filter((method) => doorsFrom(method, state).length > 0)
      .filter((method) => method !== "open_deal" && method !== "probe_domain");
    assert.deepEqual(
      [...METHODS_BY_STATE[state]].sort(),
      derived.sort(),
      `${state} lists the wrong methods`,
    );
  }
});

/**
 * `open_deal` and `probe_domain` carry an OFFERED door because a door needs a state, and neither
 * belongs on a deal page: one creates the deal that page is about and the other touches no deal at
 * all. They are excluded above rather than silently, so the exclusion is a stated fact.
 */
test("the two methods that do not act on an existing deal are the two excluded", () => {
  for (const method of ["open_deal", "probe_domain"]) {
    assert.ok(doorsFrom(method, "OFFERED").length > 0, `${method} has no OFFERED door`);
    assert.ok(!METHODS_BY_STATE.OFFERED.includes(method), `${method} is offered on a deal page`);
  }
});

test("RELEASED and REFUNDED offer nothing, because a closed deal is closed", () => {
  assert.deepEqual(METHODS_BY_STATE.RELEASED, []);
  assert.deepEqual(METHODS_BY_STATE.REFUNDED, []);
  for (const method of Object.keys(METHODS)) {
    assert.deepEqual(doorsFrom(method, "RELEASED"), [], method);
    assert.deepEqual(doorsFrom(method, "REFUNDED"), [], method);
  }
});

test("every live state offers at least one way out, so no deal can strand", () => {
  for (const state of ["OFFERED", "LOCKED", "VERIFIED", "REVERSED"] as DealState[]) {
    const movers = METHODS_BY_STATE[state].filter((method) => METHODS[method].movesValue);
    assert.ok(movers.length > 0, `${state} has no route that returns or releases the escrow`);
  }
});

test("doorsFrom returns nothing for a method that does not exist, rather than throwing", () => {
  assert.deepEqual(doorsFrom("adjudicate", "OFFERED"), []);
});

test("the six states are the six the contract declares", () => {
  const declared = [...CONTRACT.matchAll(/^ST_[A-Z]+ = "([A-Z]+)"$/gm)].map((match) => match[1]);
  assert.deepEqual(declared.sort(), [...DEAL_STATES].sort());
});

/* --- the programs ---------------------------------------------------------- */

test("every program belongs to a method, and the two that read nothing have none", () => {
  for (const method of Object.keys(PROGRAMS)) {
    assert.ok(method in METHODS, `${method} has a program but is not a method`);
  }
  assert.ok(!("refund" in PROGRAMS), "refund reads nothing, so a program would suggest it does");
  assert.ok(!("abandon" in PROGRAMS), "abandon reads nothing, so a program would suggest it does");
});

/**
 * A step without a named source is a spinner with extra characters. The rule is stated in the
 * module's own header, and this is what keeps it true: a row that cannot say what it is reading
 * does not get drawn.
 */
test("every step names the source it reads", () => {
  for (const [method, steps] of Object.entries(PROGRAMS)) {
    assert.ok(steps.length > 0, `${method}'s program is empty`);
    for (const step of steps) {
      assert.ok(step.label.length > 0, `${method} has an unlabelled step`);
      assert.ok(step.source.length > 0, `${method}: "${step.label}" names no source`);
    }
  }
});

/**
 * Both resolvers, always, never one. The contract compares two DNS-over-HTTPS answers and treats
 * disagreement as an absence of evidence rather than as evidence of absence, so a step drawn with
 * one resolver would be drawing a check the contract does not perform.
 */
test("a comparison step is drawn as a pair, never as a single resolver", () => {
  const resolvers = CONTRACT.match(/^RESOLVERS = .*$/m);
  for (const [method, steps] of Object.entries(PROGRAMS)) {
    for (const step of steps) {
      if (!step.resolvers) continue;
      assert.equal(step.resolvers.length, 2, `${method}: "${step.label}" is not a pair`);
      assert.equal(new Set(step.resolvers).size, 2, `${method}: "${step.label}" repeats a resolver`);
      for (const name of step.resolvers) {
        assert.ok(name.length > 0, `${method}: "${step.label}" has an unnamed resolver`);
        if (resolvers) assert.match(resolvers[0], new RegExp(name, "i"), name);
      }
    }
  }
});

/**
 * The three writes that read DNS are the three that ask a resolver. `open_deal` and `probe_domain`
 * touch RDAP only, and a resolver pair drawn on either would promise a proof check that never runs.
 */
test("only the writes that read a proof draw a resolver pair", () => {
  const withResolvers = Object.entries(PROGRAMS)
    .filter(([, steps]) => steps.some((step) => step.resolvers))
    .map(([method]) => method)
    .sort();
  assert.deepEqual(withResolvers, ["arm", "check_transfer", "settle"]);
});

/**
 * Every program that reaches a registry resolves the authority for the TLD first. The contract
 * never trusts a stored RDAP base: `_delivery_block` fetches the IANA bootstrap again and
 * `assert_base_still_authoritative` refuses TRANSIENT if the map moved, so authority cannot change
 * under a deal between arming and settlement. A diagram that skipped the row would be describing a
 * shortcut the contract does not take, and this test is what caught `settle` missing it.
 */
test("every program that fetches RDAP resolves the bootstrap before it", () => {
  for (const [method, steps] of Object.entries(PROGRAMS)) {
    const fetchAt = steps.findIndex((step) => step.source.includes("RDAP base"));
    if (fetchAt < 0) continue;
    const bootstrapAt = steps.findIndex((step) => step.source.includes("dns.json"));
    assert.ok(bootstrapAt >= 0, `${method} fetches a registry without resolving the authority`);
    assert.ok(bootstrapAt < fetchAt, `${method} fetches before it resolves`);
  }
  assert.match(CONTRACT, /^IANA_BOOTSTRAP_URL = "https:\/\/data\.iana\.org\/rdap\/dns\.json"$/m);
});

/**
 * The two writes that read a registry against a stored base are the two that go through
 * `_delivery_block`, and both have to say they re-check the map. `arm` is the call that stores the
 * base in the first place, so it resolves rather than re-resolves.
 */
test("the writes that re-check a stored base both say so", () => {
  const call = CONTRACT.match(/fresh = assert_base_still_authoritative\(bootstrap, domain, base\)/);
  assert.ok(call, "the contract no longer re-checks a stored base inside the delivery block");

  const blockCallers = [...CONTRACT.matchAll(/observed = self\._delivery_block\(/g)];
  assert.equal(blockCallers.length, 2, "a third caller of _delivery_block appeared");

  for (const method of ["check_transfer", "settle"]) {
    const first = PROGRAMS[method][0];
    assert.match(first.source, /dns\.json/, `${method} does not re-resolve first`);
    assert.match(first.label, /moved/, `${method} does not say a moved map is refused`);
  }
});

/* --- the client phases ----------------------------------------------------- */

test("exactly one client phase costs a signature, and it is the wallet one", () => {
  const signing = CLIENT_PHASES.filter((phase) => phase.costsSignature);
  assert.equal(signing.length, 1);
  assert.equal(signing[0].key, "wallet-pending");
});

test("every phase has a label and a note, and no two share a key", () => {
  const keys = CLIENT_PHASES.map((phase) => phase.key);
  assert.equal(new Set(keys).size, keys.length);
  for (const phase of CLIENT_PHASES) {
    assert.ok(phase.label.length > 0, `${phase.key} has no label`);
    assert.ok(phase.note.length > 20, `${phase.key}'s note says nothing`);
  }
});

/**
 * The phase before the wallet is the one that refuses locally. It has to come first, or the
 * interface would be asking for a signature and validating afterwards, which is the sequence this
 * whole file exists to prevent.
 */
test("validation runs before the wallet is asked for anything", () => {
  const order = CLIENT_PHASES.map((phase) => phase.key);
  assert.ok(order.indexOf("validating") < order.indexOf("wallet-pending"));
  assert.equal(order[order.length - 1], "settled");
});

/* --- the outcome taxonomy -------------------------------------------------- */

test("the four tags are the four the contract writes, character for character", () => {
  const declared = [...CONTRACT.matchAll(/^TAG_([A-Z_]+) = "(\[[A-Z_]+\])"$/gm)];
  assert.equal(declared.length, 4);

  const fromContract = Object.fromEntries(declared.map((match) => [match[1], match[2]]));
  for (const [name, className] of Object.entries(TAG_TO_CLASS)) {
    assert.equal(OUTCOMES[className].tag, fromContract[name], `${name} disagrees with the contract`);
  }
});

test("every class has words for the register and a stated retry answer", () => {
  for (const [className, outcome] of Object.entries(OUTCOMES)) {
    assert.ok(outcome.headline.length > 0, `${className} has no headline`);
    assert.ok(outcome.body.length > 40, `${className}'s body says nothing`);
    assert.ok(outcome.register.length > 0, `${className} has no register phrasing`);
    assert.equal(typeof outcome.retry, "boolean");
  }
});

/**
 * A rule that fired is the one class that is not retryable, and it is the only one that is a
 * verdict. The other three all mean nothing was decided, and telling a reader to retry after one of
 * them is the whole point of separating them.
 */
test("only a fired rule is final; everything else invites the same call again", () => {
  assert.equal(OUTCOMES.expected.retry, false);
  assert.equal(OUTCOMES.external.retry, true);
  assert.equal(OUTCOMES.transient.retry, true);
  assert.equal(OUTCOMES["llm-error"].retry, true);
});

/**
 * The contract runs no model, and `parameters()` says so in a field a reader can check. The class
 * is carried anyway so that its absence from the register is a visible fact rather than an omission
 * nobody can distinguish from an oversight.
 */
test("the model-error class exists precisely so its absence is checkable", () => {
  assert.ok(OUTCOMES["llm-error"].body.includes("runs no model"));
  assert.match(CONTRACT, /"uses_a_model": "false"/);
});

/* --- classify -------------------------------------------------------------- */

test("each tag classifies to its own class, in any case", () => {
  assert.equal(classify("[EXPECTED] deal d-1 is LOCKED"), "expected");
  assert.equal(classify("[EXTERNAL] the registry answered 429"), "external");
  assert.equal(classify("[TRANSIENT] no determination"), "transient");
  assert.equal(classify("[LLM_ERROR] unusable shape"), "llm-error");
  assert.equal(classify("[expected] lower case arrives too"), "expected");
});

test("a tag anywhere in the message is found, not only at the start", () => {
  assert.equal(classify("Error: execution reverted: [EXTERNAL] no answer"), "external");
});

/**
 * A wallet rejection is the user's own decision and belongs with the deliberate refusals. It is the
 * one unstated case worth naming, because reporting "nothing was decided, try again" to somebody
 * who just pressed cancel is an interface arguing with its reader.
 */
test("a wallet rejection is a deliberate refusal, not a failure", () => {
  assert.equal(classify("MetaMask Tx Signature: User rejected the request."), "expected");
  assert.equal(classify("user denied transaction signature"), "expected");
});

test("a network failure is external, whichever shape it arrives in", () => {
  for (const message of [
    "429 Too Many Requests",
    "rate limit exceeded",
    "TypeError: fetch failed",
    "network error",
  ]) {
    assert.equal(classify(message), "external", message);
  }
});

/**
 * The fallback is the assertion that matters most here. Anything unclassifiable is transient, never
 * a verdict, because calling something a verdict is the one mistake that could move money: a
 * refusal printed as final closes a deal in a reader's head that the chain has not closed.
 */
test("anything unrecognisable is transient, and never a verdict", () => {
  for (const message of ["", "something went wrong", "0x1f", "undefined is not a function"]) {
    assert.equal(classify(message), "transient", JSON.stringify(message));
  }
});

test("classify never returns the verdict class, which is not a class of failure", () => {
  const samples = ["[EXPECTED] x", "[EXTERNAL] x", "[TRANSIENT] x", "[LLM_ERROR] x", "nothing"];
  for (const message of samples) assert.notEqual(classify(message), "verdict");
});

/* --- the caller and deadline vocabularies ---------------------------------- */

test("every caller a door can name has a label and a note that explains the rule", () => {
  for (const [caller, text] of Object.entries(CALLER_TEXT)) {
    assert.ok(text.label.length > 0, `${caller} has no label`);
    assert.ok(text.note.length > 40, `${caller}'s note explains nothing`);
  }
});

test("the permissionless note says why a deadline needs somebody to press it", () => {
  assert.match(CALLER_TEXT.anyone.note, /no cron/i);
});

test("every deadline field has words, and every one is used by a door or a deal page", () => {
  const used = new Set<string>();
  for (const spec of Object.values(METHODS)) {
    for (const door of spec.doors) {
      if (door.after) used.add(door.after);
      if (door.widensAfter) used.add(door.widensAfter);
    }
  }
  for (const [field, words] of Object.entries(DEADLINE_TEXT)) {
    assert.ok(words.length > 0, `${field} has no words`);
    assert.match(CONTRACT, new RegExp(`${field}: str`), `${field} is not a field on the deal`);
  }
  assert.deepEqual([...used].sort(), ["accept_deadline", "inspection_deadline", "transfer_deadline"]);
});
