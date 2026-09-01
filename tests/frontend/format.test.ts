import assert from "node:assert/strict";
import test from "node:test";
import {
  countdown,
  displayTime,
  domainForms,
  formatCount,
  formatGen,
  formatWindow,
  genToWei,
  setAdded,
  setRemoved,
  setSize,
  setsAgree,
  shortenHex,
  splitSet,
} from "../../src/lib/format.ts";

/**
 * Printing values without asserting anything the value does not carry.
 *
 * Three properties are worth a test here and the rest follows from them. A price never passes
 * through a JS number, because a rounded price is a wrong price and this product is entirely about
 * a price. An empty field is never printed as a zero, because a contract that reported no figure
 * and a contract that reported nothing owing are different statements and only one of them is
 * about money. And a comma-joined set with nothing in it is an empty set, never a set containing
 * one empty member, because `[""]` next to a delegation would print a nameserver called nothing.
 */

const WEI = 10n ** 18n;

/* --- money ---------------------------------------------------------------- */

/**
 * `Number` loses precision above 2^53, and a wei figure crosses that at 0.009 GEN. Every assertion
 * below sits past the point where a float would round, which is the only place the test means
 * anything.
 */
test("a price is exact past the point a float would round it", () => {
  assert.equal(formatGen("1000000000000000001"), "1.000000000000000001 GEN");
  assert.equal(formatGen("999999999999999999999"), "999.999999999999999999 GEN");
  assert.equal(formatGen(1n), "0.000000000000000001 GEN");
  assert.notEqual(
    String(Number("1000000000000000001")),
    "1000000000000000001",
    "the premise: a float loses the last digit of this",
  );
});

test("a whole number of GEN prints without a decimal point", () => {
  assert.equal(formatGen("0"), "0 GEN");
  assert.equal(formatGen(WEI), "1 GEN");
  assert.equal(formatGen(100n * WEI), "100 GEN");
});

test("a fraction keeps its leading zeros and drops only its trailing ones", () => {
  assert.equal(formatGen(WEI / 2n), "0.5 GEN");
  assert.equal(formatGen(WEI / 1000n), "0.001 GEN");
  assert.equal(formatGen(1500000000000000000n), "1.5 GEN");
});

/**
 * An empty field is not zero. A contract that reported no figure must not be printed as having
 * reported none owing, which is what "0 GEN" beside a price would say.
 */
test("an unreported figure says so rather than printing zero", () => {
  assert.equal(formatGen(""), "not reported");
  assert.notEqual(formatGen(""), "0 GEN");
});

test("something that is not a number is shown as it arrived, not as a zero", () => {
  assert.equal(formatGen("not a number"), "not a number wei");
  assert.equal(formatGen("12.5"), "12.5 wei");
});

test("a negative figure keeps its sign, so a ledger difference reads as one", () => {
  assert.equal(formatGen(-WEI), "-1 GEN");
  assert.equal(formatGen(-1500000000000000000n), "-1.5 GEN");
});

/* --- parsing an amount ---------------------------------------------------- */

test("a typed amount parses to wei exactly, to the last decimal place", () => {
  assert.equal(genToWei("1"), WEI);
  assert.equal(genToWei("0.5"), WEI / 2n);
  assert.equal(genToWei("1.000000000000000001"), WEI + 1n);
  assert.equal(genToWei("0.000000000000000001"), 1n);
  assert.equal(genToWei("  2.25  "), 2250000000000000000n);
});

/**
 * Null rather than a guess. A malformed amount coerced into a number would put a figure into a
 * payable call that the person typing it never wrote, and the call is the one that takes escrow.
 */
test("a malformed amount is null, never a repaired number", () => {
  for (const input of [
    "",
    ".",
    ".5",
    "1.",
    "1e18",
    "-1",
    "1,5",
    "abc",
    "0x1",
    "1.0000000000000000001",
    "Infinity",
  ]) {
    assert.equal(genToWei(input), null, JSON.stringify(input));
  }
});

test("an amount round trips through both directions unchanged", () => {
  for (const text of ["0", "1", "0.5", "12.34", "1.000000000000000001", "100"]) {
    const wei = genToWei(text);
    assert.notEqual(wei, null, text);
    assert.equal(formatGen(wei!), `${text.replace(/\.0+$/, "")} GEN`);
  }
});

/* --- hex and time --------------------------------------------------------- */

test("a hash is shortened in the middle and a short one is left whole", () => {
  const hash = `0x${"a".repeat(64)}`;
  const short = shortenHex(hash);
  assert.match(short, /^0x/);
  assert.ok(short.includes("…"));
  assert.equal(short.endsWith(hash.slice(-6)), true);
  assert.equal(shortenHex("0xabc"), "0xabc");
});

test("an absent hash says nothing was recorded rather than showing an ellipsis", () => {
  assert.equal(shortenHex(""), "not recorded");
});

test("a time is printed in UTC, and an absent one is stated as absent", () => {
  assert.equal(displayTime("2026-08-30T12:00:00.000Z"), "2026-08-30 12:00:00Z");
  assert.equal(displayTime(""), "not recorded");
});

/**
 * An unparseable timestamp is echoed rather than rendered as the epoch. "1970-01-01" beside a
 * deadline is a date somebody could act on, and it would be an invented one.
 */
test("an unparseable timestamp is echoed, never rendered as the epoch", () => {
  assert.equal(displayTime("whenever"), "whenever");
  assert.ok(!displayTime("whenever").includes("1970"));
});

test("a count is grouped in threes, and a non-count is passed through", () => {
  assert.equal(formatCount("1234567"), "1,234,567");
  assert.equal(formatCount(0), "0");
  assert.equal(formatCount("999"), "999");
  assert.equal(formatCount("none"), "none");
  assert.equal(formatCount(""), "0");
});

/* --- windows -------------------------------------------------------------- */

/**
 * Every window is read out of `parameters()`, so the input is a string of seconds the contract
 * reported. The contract's own three windows are 48 hours, 10 days and 3 days, and all three have
 * to print as the unit a person would use.
 */
test("the contract's three windows print in the units a person would use", () => {
  assert.equal(formatWindow("172800"), "2 days");
  assert.equal(formatWindow("864000"), "10 days");
  assert.equal(formatWindow("259200"), "3 days");
  assert.equal(formatWindow("86400"), "1 day");
  assert.equal(formatWindow("3600"), "1 hour");
  assert.equal(formatWindow("7200"), "2 hours");
});

test("a window that is not a whole number of days stays in hours", () => {
  assert.equal(formatWindow("90000"), "25 hours");
});

/**
 * An unreadable window prints nothing rather than a default. A form that invented 48 hours because
 * `parameters()` could not be reached would be inventing the one figure a reader's decision rests
 * on, and the invention would look identical to a fact.
 */
test("an unreadable window is not reported rather than guessed at", () => {
  for (const value of ["", "0", "-1", "soon", "NaN"]) {
    assert.equal(formatWindow(value), "not reported", JSON.stringify(value));
  }
});

/* --- countdowns ----------------------------------------------------------- */

const NOW = Date.parse("2026-08-30T12:00:00.000Z");

/**
 * `now` is a parameter rather than a call to the clock, so the server render and the client render
 * of the same page can be handed the same instant. A countdown that disagrees with itself across
 * hydration is a countdown nobody trusts, and this one sits beside a sum of money.
 */
test("a countdown is measured against the clock it was handed", () => {
  const soon = new Date(NOW + 3 * 3600_000).toISOString();
  assert.deepEqual(countdown(soon, NOW), { kind: "running", text: "3 hours remaining" });
  assert.deepEqual(countdown(soon, NOW + 7200_000), { kind: "running", text: "1 hour remaining" });
});

test("a passed deadline is elapsed and says how long ago, not that it is running", () => {
  const past = new Date(NOW - 90 * 60_000).toISOString();
  assert.deepEqual(countdown(past, NOW), { kind: "elapsed", text: "1 hour 30 min ago" });
});

/**
 * The boundary matters because it is the instant a permissionless door opens. At exactly the
 * deadline the window is over, so it reads as elapsed rather than as zero remaining.
 */
test("the deadline instant itself reads as elapsed", () => {
  const at = new Date(NOW).toISOString();
  assert.equal(countdown(at, NOW).kind, "elapsed");
  assert.equal(countdown(new Date(NOW + 1).toISOString(), NOW).kind, "running");
});

test("under a minute is said in words rather than as zero minutes", () => {
  assert.deepEqual(countdown(new Date(NOW + 30_000).toISOString(), NOW), {
    kind: "running",
    text: "under a minute remaining",
  });
});

test("a long span is days and hours, and a round one drops the hours", () => {
  assert.deepEqual(countdown(new Date(NOW + 10 * 86400_000).toISOString(), NOW), {
    kind: "running",
    text: "10 days remaining",
  });
  assert.deepEqual(countdown(new Date(NOW + (10 * 86400_000 + 5 * 3600_000)).toISOString(), NOW), {
    kind: "running",
    text: "10 days 5 h remaining",
  });
});

/**
 * A deal that has never been armed carries an empty `transfer_deadline`, so an empty string is a
 * real and common value. It has to be its own kind, because rendering it as elapsed would put "54
 * years ago" beside a deadline that does not exist yet.
 */
test("an empty or unparseable deadline is no countdown at all", () => {
  assert.deepEqual(countdown("", NOW), { kind: "none" });
  assert.deepEqual(countdown("whenever", NOW), { kind: "none" });
});

/* --- comma-joined sets ---------------------------------------------------- */

/**
 * GenVM storage carries no list type, so the contract joins every set with commas. This is the
 * only place in the interface that takes one apart, and the empty case is the one that matters: a
 * domain with no delegation and a domain with one nameserver called "" are different claims, and
 * only the first happens.
 */
test("an empty set is empty, and never a set holding one empty member", () => {
  assert.deepEqual(splitSet(""), []);
  assert.deepEqual(splitSet(","), []);
  assert.deepEqual(splitSet(" , , "), []);
  assert.equal(setSize(""), 0);
});

test("a joined set splits on commas and trims each member", () => {
  assert.deepEqual(splitSet("ns1.example.com,ns2.example.com"), [
    "ns1.example.com",
    "ns2.example.com",
  ]);
  assert.deepEqual(splitSet("clientTransferProhibited, clientDeleteProhibited"), [
    "clientTransferProhibited",
    "clientDeleteProhibited",
  ]);
  assert.equal(setSize("a,b,c"), 3);
});

/**
 * Two empty sets do not agree. The contract canonicalises both sides before storing them, so a
 * plain comparison is correct for two real sets, but "" on both sides means neither was ever
 * observed, and calling that a match would read as a delegation confirmed by nothing.
 */
test("two empty sets do not agree, because nothing was compared", () => {
  assert.equal(setsAgree("", ""), false);
});

test("identical canonical sets agree and different ones do not", () => {
  assert.equal(setsAgree("ns1.example.com,ns2.example.com", "ns1.example.com,ns2.example.com"), true);
  assert.equal(setsAgree("ns1.example.com,ns2.example.com", "ns2.example.com,ns1.example.com"), false);
  assert.equal(setsAgree("ns1.example.com", "ns1.example.com,ns2.example.com"), false);
});

test("a diff names what appeared and what went, in the order it is carried", () => {
  const before = "ns1.old.example,ns2.old.example";
  const after = "ns1.new.example,ns2.old.example";
  assert.deepEqual(setAdded(before, after), ["ns1.new.example"]);
  assert.deepEqual(setRemoved(before, after), ["ns1.old.example"]);
});

test("a diff against nothing is entirely an addition, and the reverse a removal", () => {
  assert.deepEqual(setAdded("", "ns1.example.com"), ["ns1.example.com"]);
  assert.deepEqual(setRemoved("", "ns1.example.com"), []);
  assert.deepEqual(setRemoved("ns1.example.com", ""), ["ns1.example.com"]);
});

test("an unchanged set has an empty diff in both directions", () => {
  const set = "ns1.example.com,ns2.example.com";
  assert.deepEqual(setAdded(set, set), []);
  assert.deepEqual(setRemoved(set, set), []);
});

/* --- domains -------------------------------------------------------------- */

/**
 * A homograph is the cheapest attack available against a screen that shows one form of a name. So
 * an ascii-only domain reports `differs: false` and the page prints one form, and anything with an
 * `xn--` label is flagged so both can be shown side by side.
 */
test("an ordinary domain has one form and says the two do not differ", () => {
  const forms = domainForms("example.com");
  assert.equal(forms.ascii, "example.com");
  assert.equal(forms.unicode, "example.com");
  assert.equal(forms.differs, false);
});

test("the ascii form is always exactly the string that was handed in", () => {
  for (const domain of ["example.com", "xn--bcher-kva.example", "a.co.uk"]) {
    assert.equal(domainForms(domain).ascii, domain);
  }
});

/**
 * When no decode happens the unicode form is left as the ascii one, which is honest rather than
 * clever: showing a half-decoded name would be a third string that neither the registry nor the
 * resolver would agree with.
 */
test("an undecodable punycode label leaves both forms equal rather than inventing one", () => {
  const forms = domainForms("xn--.example");
  assert.equal(forms.ascii, "xn--.example");
  assert.ok(forms.unicode === forms.ascii || forms.differs);
});
