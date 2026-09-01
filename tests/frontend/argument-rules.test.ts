import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  addressFault,
  commitmentFault,
  idFault,
  nameserverFault,
  registrarFault,
} from "../../src/lib/validate.ts";
import { canonicalNameservers } from "../../src/lib/secret.ts";

/**
 * The interface's restatement of the contract's argument rules, checked against the rules.
 *
 * A restatement is worth having only while it still matches. `src/lib/validate.ts` says as much in
 * its own header: it is a courtesy and not an authority, and the offer form rehearses the real call
 * before it sends. But a courtesy that has drifted is worse than none, because it refuses input the
 * chain would have taken and the reader has no way to tell the difference. So every bound below is
 * lifted out of `contracts/Conveyance.py` at test time.
 *
 * TWO DIVERGENCES ARE DELIBERATE AND BOTH ARE ASSERTED HERE RATHER THAN HIDDEN.
 *
 * Python's `str.isalnum()` is Unicode aware, so the contract would accept a deal id or a nameserver
 * label containing `é` or an Arabic-Indic digit. The restatement is ASCII only, which is narrower.
 * That is the safe direction for a value that ends up inside a DNS TXT record and in a URL, and the
 * cost is a sentence on screen rather than a signature spent on a revert.
 *
 * The contract permits a leading or trailing hyphen in a nameserver label; the restatement refuses
 * it, because such a name cannot be delegated to and a deal whose target nameservers do not resolve
 * is a deal that can only end in a refund.
 *
 * Narrower is safe. Wider is not, and a test that only checked "these inputs are refused" would not
 * notice the day the contract tightened a bound the form still allows. Both directions are checked.
 */

const CONTRACT = readFileSync(
  fileURLToPath(new URL("../../contracts/Conveyance.py", import.meta.url)),
  "utf8",
);

function pythonInt(name: string): number {
  const match = CONTRACT.match(new RegExp(`^${name} = (\\d+)`, "m"));
  assert.ok(match, `${name} is not an integer constant in contracts/Conveyance.py any more`);
  return Number(match[1]);
}

const MAX_ID_CHARS = pythonInt("MAX_ID_CHARS");
const MAX_REGISTRAR_ID_CHARS = pythonInt("MAX_REGISTRAR_ID_CHARS");
const MAX_NAMESERVER_CHARS = pythonInt("MAX_NAMESERVER_CHARS");
const MIN_NAMESERVERS = pythonInt("MIN_NAMESERVERS");
const MAX_NAMESERVERS = pythonInt("MAX_NAMESERVERS");
const COMMITMENT_CHARS = pythonInt("COMMITMENT_CHARS");

const MIN = String(MIN_NAMESERVERS);
const MAX = String(MAX_NAMESERVERS);

/* --- the deal id ---------------------------------------------------------- */

test("the id length bound is the contract's, not a number typed twice", () => {
  assert.equal(idFault("d".repeat(MAX_ID_CHARS)), "");
  assert.notEqual(idFault("d".repeat(MAX_ID_CHARS + 1)), "");
});

test("the id message names the bound the contract enforces", () => {
  assert.match(idFault("d".repeat(MAX_ID_CHARS + 1)), new RegExp(String(MAX_ID_CHARS)));
});

test("the characters the contract lists for an id are the characters accepted", () => {
  const listed = CONTRACT.match(/if not \(char\.isalnum\(\) or char in "([^"]+)"\):/);
  assert.ok(listed, "the contract no longer validates the deal id character by character");
  assert.equal(listed[1], "-_.");

  for (const character of listed[1]) {
    assert.equal(idFault(`a${character}b`), "", character);
  }
  for (const character of "!@#$%^&*()+=/\\|<>?,;:'\" ") {
    assert.notEqual(idFault(`a${character}b`), "", character);
  }
});

test("an empty or blank id is refused with an instruction, not a bound", () => {
  assert.match(idFault(""), /Choose an identifier/);
  assert.match(idFault("   "), /Choose an identifier/);
});

test("an id is trimmed before it is measured, as the contract trims it", () => {
  assert.equal(idFault(`  ${"d".repeat(MAX_ID_CHARS)}  `), "");
});

/* --- the addresses -------------------------------------------------------- */

test("an address is 0x and forty hex characters, in either case", () => {
  assert.equal(addressFault(`0x${"a".repeat(40)}`, "seller"), "");
  assert.equal(addressFault(`0x${"A".repeat(40)}`, "seller"), "");
  assert.notEqual(addressFault(`0x${"a".repeat(39)}`, "seller"), "");
  assert.notEqual(addressFault(`0x${"a".repeat(41)}`, "seller"), "");
  assert.notEqual(addressFault("a".repeat(40), "seller"), "");
  assert.notEqual(addressFault(`0x${"g".repeat(40)}`, "seller"), "");
});

/**
 * The zero address satisfies the shape, which is exactly why the contract refuses it separately. It
 * is what an empty or mistyped field decodes to, and a deal whose seller is the zero address is a
 * deal whose escrow has nowhere to go. The contract's own test for it is a string comparison
 * against `"0x" + "00" * 20`, lifted here so both sides refuse the same value.
 */
test("the zero address is refused, in whatever case it arrives", () => {
  const zero = CONTRACT.match(/text\.lower\(\) == "0x" \+ "00" \* (\d+):/);
  assert.ok(zero, "the contract no longer refuses the zero address by comparison");
  assert.equal(Number(zero[1]), 20);

  assert.notEqual(addressFault(`0x${"0".repeat(40)}`, "seller"), "");
  assert.notEqual(addressFault(`0X${"0".repeat(40)}`.toLowerCase(), "seller"), "");
});

test("an empty address names the party that is missing", () => {
  assert.equal(addressFault("", "seller"), "Name the seller.");
  assert.equal(addressFault("  ", "buyer"), "Name the buyer.");
});

test("an address is trimmed, because a pasted address often carries a space", () => {
  assert.equal(addressFault(`  0x${"a".repeat(40)} `, "seller"), "");
});

/* --- the registrar id ----------------------------------------------------- */

test("a registrar id is digits and only digits, up to the contract's width", () => {
  assert.equal(registrarFault("1910"), "");
  assert.equal(registrarFault("9".repeat(MAX_REGISTRAR_ID_CHARS)), "");
  assert.notEqual(registrarFault("9".repeat(MAX_REGISTRAR_ID_CHARS + 1)), "");
  assert.notEqual(registrarFault("1910a"), "");
  assert.notEqual(registrarFault("-1"), "");
  assert.notEqual(registrarFault("19.10"), "");
});

/**
 * The contract's refusal says a registrar's name is not accepted because two registrars can trade
 * under one brand and one brand can hold several ids. The restatement has to say something with the
 * same content, because the reader typing "GoDaddy" needs to know that a name is not merely
 * mistyped but unusable.
 */
test("a registrar name is refused with the reason a name cannot stand in for an id", () => {
  const fault = registrarFault("GoDaddy");
  assert.match(fault, /digits only/);
  assert.match(fault, /name can change/);
});

test("an empty registrar id asks for the id rather than reporting a shape", () => {
  assert.match(registrarFault(""), /IANA id/);
});

/* --- the nameservers ------------------------------------------------------ */

test("a set inside the contract's count bounds passes", () => {
  const names = Array.from({ length: MIN_NAMESERVERS }, (_, index) => `ns${index}.example.com`);
  assert.equal(nameserverFault(names, MIN, MAX), "");
});

test("a set below the minimum and above the maximum are both refused", () => {
  const below = Array.from({ length: MIN_NAMESERVERS - 1 }, (_, i) => `ns${i}.example.com`);
  const above = Array.from({ length: MAX_NAMESERVERS + 1 }, (_, i) => `ns${i}.example.com`);
  assert.match(nameserverFault(below, MIN, MAX), new RegExp(`at least ${MIN}`));
  assert.match(nameserverFault(above, MIN, MAX), new RegExp(`at most ${MAX}`));
});

test("the count is measured after duplicates are dropped, as the contract measures it", () => {
  const pasted = canonicalNameservers("ns1.example.com, NS1.example.com., ns1.example.com");
  assert.equal(pasted.length, 1);
  const fault = nameserverFault(pasted, MIN, MAX);
  assert.match(fault, /once duplicates are dropped/);
});

test("a nameserver needs a dot, and the message says which name failed", () => {
  assert.match(nameserverFault(["ns1", "ns2.example.com"], MIN, MAX), /^ns1 is not a hostname/);
});

test("the per-name length bound is the contract's", () => {
  const long = `${"a".repeat(MAX_NAMESERVER_CHARS)}.example.com`;
  assert.ok(long.length > MAX_NAMESERVER_CHARS);
  assert.match(nameserverFault([long, "ns2.example.com"], MIN, MAX), new RegExp(String(MAX_NAMESERVER_CHARS)));
});

test("the characters the contract lists for a nameserver are the characters accepted", () => {
  const listed = CONTRACT.match(/if not \(char\.isalnum\(\) or char in "-\."\):/);
  assert.ok(listed, "the contract no longer validates nameserver characters the way this expects");

  assert.equal(nameserverFault(["ns-1.example.com", "ns2.example.com"], MIN, MAX), "");
  for (const character of "_!@#$%^&*()+=/\\|<>?,;:'\" ") {
    assert.notEqual(
      nameserverFault([`ns${character}1.example.com`, "ns2.example.com"], MIN, MAX),
      "",
      character,
    );
  }
});

/**
 * An empty bound means `parameters()` could not be read. The count check is skipped rather than
 * guessed at, and the shape checks still run. A form that invented two and eight because the
 * contract was unreachable would be inventing the one figure it has no business inventing.
 */
test("an unreadable bound skips the count check and keeps the shape checks", () => {
  const one = ["ns1.example.com"];
  assert.equal(nameserverFault(one, "", ""), "");
  assert.notEqual(nameserverFault(["ns1"], "", ""), "");
});

test("an empty set asks for nameservers rather than reporting a count", () => {
  assert.match(nameserverFault([], MIN, MAX), /Give the nameservers/);
});

/* --- the commitment ------------------------------------------------------ */

test("a commitment is exactly the contract's width, in lower case hex", () => {
  assert.equal(commitmentFault("a".repeat(COMMITMENT_CHARS)), "");
  assert.notEqual(commitmentFault("a".repeat(COMMITMENT_CHARS - 1)), "");
  assert.notEqual(commitmentFault("a".repeat(COMMITMENT_CHARS + 1)), "");
  assert.match(commitmentFault("A".repeat(COMMITMENT_CHARS)), /lower case/);
  assert.notEqual(commitmentFault(`g${"a".repeat(COMMITMENT_CHARS - 1)}`), "");
});

test("a missing commitment reports that none was computed, not that it is malformed", () => {
  assert.match(commitmentFault(""), /No commitment/);
});

/* --- the divergences, stated as tests ------------------------------------ */

/**
 * These two assertions exist so that the narrowing is a decision on the record. If either ever
 * flips to accepting the Unicode form, the change was either intentional and this test is the place
 * to say so, or accidental and this test is the thing that caught it.
 */
test("the restatement is narrower than the contract on Unicode, deliberately", () => {
  assert.ok("é".match(/\p{L}/u), "the premise of this test is that é is a letter");
  assert.notEqual(idFault("déal"), "", "the id restatement is ASCII only on purpose");
  assert.notEqual(
    nameserverFault(["ns1.exämple.com", "ns2.example.com"], MIN, MAX),
    "",
    "the nameserver restatement is ASCII only on purpose",
  );
});

test("the restatement is narrower than the contract on hyphen placement, deliberately", () => {
  assert.notEqual(nameserverFault(["-ns1.example.com", "ns2.example.com"], MIN, MAX), "");
});
