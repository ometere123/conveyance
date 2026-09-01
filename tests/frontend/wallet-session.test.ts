import assert from "node:assert/strict";
import test from "node:test";
import {
  DISCONNECTED,
  type WalletState,
  chainIdHex,
  networkLabel,
  networkVerdict,
  nextWalletState,
  parseChainId,
  refusalMessage,
  writeGate,
} from "../../src/lib/wallet-session.ts";

/**
 * The wallet session, checked on the one property that costs money to get wrong.
 *
 * A write offered on a chain the wallet has not confirmed is a priced transaction landing
 * somewhere it was not meant to land. The reducer is pure precisely so that property can be
 * asserted rather than clicked at, and the assertions below are mostly about the unknown case:
 * every path that has not been told which network it is on has to refuse, and none of them may
 * treat silence as agreement.
 *
 * The events are the ones an injected provider actually emits. `accountsChanged` with an empty
 * array is how MetaMask reports a lock, `chainChanged` can arrive before or after a connection,
 * and both can arrive while a transaction is in the wallet. So the reducer is exercised in the
 * orders a provider can produce them in, not only the happy one.
 */

const CONNECTED: WalletState = {
  mode: "injected",
  address: "0x1234567890abcdef1234567890abcdef12345678",
  chainId: 61999,
  refusal: "",
};

/* --- the reducer ----------------------------------------------------------- */

test("connecting records the address and the chain the wallet reported", () => {
  const state = nextWalletState(DISCONNECTED, {
    type: "connected",
    address: CONNECTED.address,
    chainId: 61999,
  });
  assert.deepEqual(state, CONNECTED);
});

/**
 * A wallet can connect without answering `eth_chainId`, and that state has to survive as null
 * rather than being filled in with a hopeful default. `writeGate` is what turns the null into a
 * refusal, and it can only do that if the null reaches it.
 */
test("connecting without a chain leaves the chain unknown rather than assuming one", () => {
  const state = nextWalletState(DISCONNECTED, {
    type: "connected",
    address: CONNECTED.address,
    chainId: null,
  });
  assert.equal(state.chainId, null);
  assert.equal(state.mode, "injected");
});

test("connecting clears a refusal left over from a previous attempt", () => {
  const refused = nextWalletState(DISCONNECTED, {
    type: "connection-refused",
    message: "The wallet declined the request. Nothing was sent.",
  });
  assert.notEqual(refused.refusal, "");
  const then = nextWalletState(refused, {
    type: "connected",
    address: CONNECTED.address,
    chainId: 61999,
  });
  assert.equal(then.refusal, "");
});

/**
 * An empty accounts array is how a wallet reports being locked. It is a disconnection and has to
 * be read as one, or the interface keeps an address on screen for a wallet that will not sign.
 */
test("an empty accounts array is a disconnection, not a no-op", () => {
  assert.deepEqual(nextWalletState(CONNECTED, { type: "accounts-changed", accounts: [] }), DISCONNECTED);
});

test("switching accounts keeps the chain and takes the first account", () => {
  const other = "0xfedcba9876543210fedcba9876543210fedcba98";
  const state = nextWalletState(CONNECTED, {
    type: "accounts-changed",
    accounts: [other, CONNECTED.address],
  });
  assert.equal(state.address, other);
  assert.equal(state.chainId, 61999);
  assert.equal(state.mode, "injected");
});

/**
 * A chain change keeps the address. The wallet is still connected and still the same account; only
 * the network moved, and dropping the address would make the page look disconnected while the
 * wallet is anything but.
 */
test("a chain change keeps the account and records the new chain", () => {
  const state = nextWalletState(CONNECTED, { type: "chain-changed", chainId: 1 });
  assert.equal(state.chainId, 1);
  assert.equal(state.address, CONNECTED.address);
});

test("a chain change to nothing is recorded as unknown, not ignored", () => {
  assert.equal(nextWalletState(CONNECTED, { type: "chain-changed", chainId: null }).chainId, null);
});

test("a provider disconnection and a deliberate forget both end at the same state", () => {
  assert.deepEqual(nextWalletState(CONNECTED, { type: "provider-disconnected" }), DISCONNECTED);
  assert.deepEqual(nextWalletState(CONNECTED, { type: "forget" }), DISCONNECTED);
});

/**
 * A refusal disconnects and keeps the words. It disconnects because a refused connection is not a
 * connection, and it keeps the words because a rewritten wallet message is a message nobody can
 * search for.
 */
test("a refusal disconnects and keeps the message verbatim", () => {
  const message = "Request of type 'wallet_requestPermissions' already pending";
  const state = nextWalletState(CONNECTED, { type: "connection-refused", message });
  assert.equal(state.mode, "none");
  assert.equal(state.address, "");
  assert.equal(state.chainId, null);
  assert.equal(state.refusal, message);
});

test("the reducer never mutates the state it was given", () => {
  const before = { ...CONNECTED };
  nextWalletState(CONNECTED, { type: "chain-changed", chainId: 1 });
  nextWalletState(CONNECTED, { type: "accounts-changed", accounts: [] });
  nextWalletState(CONNECTED, { type: "forget" });
  assert.deepEqual(CONNECTED, before);
});

test("the disconnected state is disconnected in every field, not only in its mode", () => {
  assert.deepEqual(DISCONNECTED, { mode: "none", address: "", chainId: null, refusal: "" });
});

/* --- parsing what a provider says ------------------------------------------ */

test("a chain id arrives as hex, as a decimal string, or as a number", () => {
  assert.equal(parseChainId("0xf22f"), 61999);
  assert.equal(parseChainId("61999"), 61999);
  assert.equal(parseChainId(61999), 61999);
  assert.equal(parseChainId("0x1"), 1);
});

/**
 * Everything unparseable is null, because null is the value `writeGate` refuses on. A zero or a
 * NaN coerced into a number here would sail through as a chain the interface believed in.
 */
test("anything unparseable is null rather than a number that looks plausible", () => {
  for (const value of ["", "0xzz", "not a chain", null, undefined, {}, [], NaN, Infinity]) {
    assert.equal(parseChainId(value), null, JSON.stringify(value) ?? String(value));
  }
});

test("a chain id round trips through the hex form the wallet switch call needs", () => {
  for (const chainId of [1, 61999, 4221]) {
    assert.equal(parseChainId(chainIdHex(chainId)), chainId);
  }
  assert.equal(chainIdHex(61999), "0xf22f");
});

/* --- the refusal words ---------------------------------------------------- */

test("a user closing the wallet window is not reported as an error", () => {
  for (const message of [
    "MetaMask Tx Signature: User rejected the request.",
    "user denied transaction signature",
  ]) {
    assert.equal(refusalMessage(new Error(message)), "The wallet declined the request. Nothing was sent.");
  }
});

test("a wallet already holding a request says which thing to finish", () => {
  assert.match(refusalMessage(new Error("Already pending")), /Finish that one first/);
  assert.match(
    refusalMessage({ code: -32002, message: "Request already pending. Please wait." }),
    /Finish that one first/,
  );
});

/**
 * An EIP-1193 rejection is specified as an object with `code` and `message`, and several wallets
 * throw exactly that rather than an `Error`. `String()` on one of those yields `[object Object]`,
 * so the shapes a provider can actually throw are enumerated here. This test is what caught it.
 */
test("a plain provider object is read, never stringified into [object Object]", () => {
  const shapes: unknown[] = [
    { code: 4001, message: "User rejected the request." },
    { code: -32603, message: "Internal JSON-RPC error." },
    { code: -32603, data: { message: "execution reverted: insufficient escrow" } },
    { code: 4900 },
    {},
  ];
  for (const shape of shapes) {
    const message = refusalMessage(shape);
    assert.ok(!message.includes("[object Object]"), JSON.stringify(shape));
    assert.ok(message.length > 0, JSON.stringify(shape));
  }
});

test("a nested JSON-RPC message is preferred over a bare code", () => {
  assert.equal(
    refusalMessage({ code: -32603, data: { message: "execution reverted: no such deal" } }),
    "execution reverted: no such deal",
  );
  assert.match(refusalMessage({ code: 4900 }), /error code 4900/);
});

test("a provider object claiming a user rejection is still read as a refusal", () => {
  assert.equal(
    refusalMessage({ code: 4001, message: "User rejected the request." }),
    "The wallet declined the request. Nothing was sent.",
  );
});

/**
 * Anything else is passed through unedited. A wallet's own error text is the string somebody will
 * paste into a search box, and paraphrasing it makes the one useful thing about it useless.
 */
test("any other wallet error is passed through word for word", () => {
  const message = "JSON-RPC error: insufficient funds for intrinsic transaction cost";
  assert.equal(refusalMessage(new Error(message)), message);
  assert.equal(refusalMessage("a bare string"), "a bare string");
});

/* --- the network verdict -------------------------------------------------- */

test("an unreported chain is unknown, and so is an unconfigured expectation", () => {
  assert.deepEqual(networkVerdict(null, 61999), { kind: "unknown" });
  assert.deepEqual(networkVerdict(61999, null), { kind: "unknown" });
  assert.deepEqual(networkVerdict(null, null), { kind: "unknown" });
});

test("the matching chain and a mismatched chain are separate verdicts", () => {
  assert.deepEqual(networkVerdict(61999, 61999), { kind: "expected", chainId: 61999 });
  assert.deepEqual(networkVerdict(1, 61999), { kind: "wrong", chainId: 1, expected: 61999 });
});

/**
 * Chain 0 is falsy and would be swallowed by a truthiness test. It is not a chain anybody deploys
 * to, which is exactly why a bug here would go unnoticed until it did not.
 */
test("chain zero is compared as a number, not as a truthy value", () => {
  assert.deepEqual(networkVerdict(0, 0), { kind: "expected", chainId: 0 });
  assert.deepEqual(networkVerdict(0, 61999), { kind: "wrong", chainId: 0, expected: 61999 });
});

test("the label prints the chain the wallet reported, never the one hoped for", () => {
  assert.equal(networkLabel({ kind: "unknown" }, "StudioNet"), "network not reported");
  assert.equal(networkLabel({ kind: "expected", chainId: 61999 }, "StudioNet"), "StudioNet · chain 61999");
  assert.equal(
    networkLabel({ kind: "wrong", chainId: 1, expected: 61999 }, "StudioNet"),
    "chain 1, and this build writes to chain 61999",
  );
});

/**
 * The wrong-network label deliberately does not name the wrong chain. Printing "Ethereum" beside
 * chain 1 would be this build asserting something about a network it does not write to, from a
 * table it would have to keep up to date. The number is what the wallet said.
 */
test("a wrong network is named by its number and not by a guessed name", () => {
  const label = networkLabel({ kind: "wrong", chainId: 1, expected: 61999 }, "StudioNet");
  assert.ok(!label.includes("StudioNet"), "the expected name has no business labelling the wrong chain");
  assert.match(label, /chain 1/);
});

/* --- the write gate, which is the whole point ----------------------------- */

test("no wallet means no signature, whatever the network says", () => {
  const gate = writeGate(DISCONNECTED, { kind: "expected", chainId: 61999 });
  assert.equal(gate.ok, false);
  assert.ok(gate.ok === false && /Connect a wallet/.test(gate.reason));
  assert.ok(gate.ok === false && gate.offerSwitch === false);
});

test("a mode without an address is not a connection either", () => {
  const halfway: WalletState = { mode: "injected", address: "", chainId: 61999, refusal: "" };
  assert.equal(writeGate(halfway, { kind: "expected", chainId: 61999 }).ok, false);
});

/**
 * This is the assertion the module exists for. An unknown network refuses, and the refusal says
 * nothing will be signed rather than inviting a retry, because retrying does not make the wallet
 * answer. Treating silence as agreement is how a transaction gets priced on the wrong chain.
 */
test("an unknown network fails closed and offers no switch", () => {
  const gate = writeGate(CONNECTED, { kind: "unknown" });
  assert.equal(gate.ok, false);
  assert.ok(gate.ok === false && /has not reported which network/.test(gate.reason));
  assert.ok(gate.ok === false && gate.offerSwitch === false);
});

test("a wrong network refuses and offers the switch, naming both chains", () => {
  const gate = writeGate(CONNECTED, { kind: "wrong", chainId: 1, expected: 61999 });
  assert.equal(gate.ok, false);
  assert.ok(gate.ok === false && gate.offerSwitch === true);
  assert.ok(gate.ok === false && /chain 1/.test(gate.reason) && /chain 61999/.test(gate.reason));
});

test("only a connected wallet on the expected chain opens the gate", () => {
  assert.deepEqual(writeGate(CONNECTED, { kind: "expected", chainId: 61999 }), { ok: true });
});

/**
 * A switch is only ever offered for the one case a switch can fix. Offering it for an unknown
 * network would be asking the wallet to move to a chain when the problem is that it has not said
 * where it is, and offering it with no wallet connected would be a button that cannot work.
 */
test("the switch is offered for exactly one refusal", () => {
  const refusals = [
    writeGate(DISCONNECTED, { kind: "expected", chainId: 61999 }),
    writeGate(CONNECTED, { kind: "unknown" }),
    writeGate(CONNECTED, { kind: "wrong", chainId: 1, expected: 61999 }),
  ];
  const offered = refusals.filter((gate) => gate.ok === false && gate.offerSwitch);
  assert.equal(offered.length, 1);
});

/**
 * Every refusal has to carry words. A disabled button with no sentence beside it is the shape of
 * an interface that knows something and is not saying it.
 */
test("every refusal explains itself", () => {
  const gates = [
    writeGate(DISCONNECTED, { kind: "unknown" }),
    writeGate(CONNECTED, { kind: "unknown" }),
    writeGate(CONNECTED, { kind: "wrong", chainId: 1, expected: 61999 }),
  ];
  for (const gate of gates) {
    assert.equal(gate.ok, false);
    assert.ok(gate.ok === false && gate.reason.length > 20, JSON.stringify(gate));
  }
});

/* --- the orders a provider can actually emit these in --------------------- */

/**
 * A chain change arriving before a connection must not manufacture one. `chainChanged` fires on a
 * page that has never asked for accounts, and a reducer that set `mode` here would put a write
 * button in front of somebody who had connected nothing.
 */
test("a chain change on a disconnected session leaves it disconnected", () => {
  const state = nextWalletState(DISCONNECTED, { type: "chain-changed", chainId: 61999 });
  assert.equal(state.mode, "none");
  assert.equal(state.address, "");
  assert.equal(writeGate(state, networkVerdict(state.chainId, 61999)).ok, false);
});

/**
 * The sequence that has to fail closed: connect on the right chain, then the wallet switches away
 * mid-session. Nothing re-runs the connection, so the gate has to close on the `chainChanged`
 * alone.
 */
test("switching the wallet away mid-session closes the gate without a reconnection", () => {
  let state = nextWalletState(DISCONNECTED, {
    type: "connected",
    address: CONNECTED.address,
    chainId: 61999,
  });
  assert.equal(writeGate(state, networkVerdict(state.chainId, 61999)).ok, true);

  state = nextWalletState(state, { type: "chain-changed", chainId: parseChainId("0x1") });
  const closed = writeGate(state, networkVerdict(state.chainId, 61999));
  assert.equal(closed.ok, false);
  assert.ok(closed.ok === false && closed.offerSwitch === true);
});

/**
 * And the sequence that must not reopen it: a wallet that goes quiet about its chain is not a
 * wallet back on the right one. `chainChanged` with an unreadable value has to leave the gate shut.
 */
test("a wallet that stops reporting its chain does not get the gate back", () => {
  let state = nextWalletState(DISCONNECTED, {
    type: "connected",
    address: CONNECTED.address,
    chainId: 61999,
  });
  state = nextWalletState(state, { type: "chain-changed", chainId: parseChainId("0xzz") });
  assert.equal(writeGate(state, networkVerdict(state.chainId, 61999)).ok, false);
});
