import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  buyerProofValue,
  buyerRecordName,
  canonicalNameservers,
  commitment,
  domainFault,
  generateSecret,
  openSecret,
  sealSecret,
  sellerProofValue,
  sellerRecordName,
  zoneLine,
} from "../../src/lib/secret.ts";

/**
 * The proof records, checked against the contract that reads them rather than against themselves.
 *
 * Every assertion about a token's shape in this file is built from a constant lifted out of
 * `contracts/Conveyance.py` at test time. That is the point of the file. A token the interface
 * builds one way and the contract derives another way is not a bug that shows up as an exception:
 * the seller publishes a TXT record, the contract fetches it, the two strings differ in a few
 * characters, and the contract reports the proof absent. Nothing in the stack says why. So the
 * agreement is asserted here, where a divergence is a failed test instead of a stuck deal.
 *
 * The buyer's side is worse and is why the commitment is checked twice over. The contract never
 * derives the buyer's token; it compares its sha256 to a digest lodged at open. A token built one
 * way at open and rebuilt another way at check time hashes to two different digests and the deal
 * becomes unverifiable, with the escrow recoverable only after the transfer window closes.
 */

const CONTRACT = readFileSync(
  fileURLToPath(new URL("../../contracts/Conveyance.py", import.meta.url)),
  "utf8",
);

/** One `NAME = "value"` string constant, read out of the contract source. */
function pythonString(name: string): string {
  const match = CONTRACT.match(new RegExp(`^${name} = "([^"]*)"`, "m"));
  assert.ok(match, `${name} is not a string constant in contracts/Conveyance.py any more`);
  return match[1];
}

/** One `NAME = 123` integer constant, read out of the contract source. */
function pythonInt(name: string): number {
  const match = CONTRACT.match(new RegExp(`^${name} = (\\d+)`, "m"));
  assert.ok(match, `${name} is not an integer constant in contracts/Conveyance.py any more`);
  return Number(match[1]);
}

const PROOF_VERSION = pythonString("PROOF_VERSION");
const SELLER_LABEL = pythonString("SELLER_PROOF_LABEL");
const BUYER_LABEL = pythonString("BUYER_PROOF_LABEL");
const MAX_PROOF_TOKEN_BYTES = pythonInt("MAX_PROOF_TOKEN_BYTES");
const COMMITMENT_CHARS = pythonInt("COMMITMENT_CHARS");

const DEAL = "d-1";
const SELLER = "0x1234567890AbCdEf1234567890aBcDeF12345678";
const BUYER = "0xFEDCBA9876543210fedcba9876543210FEDCBA98";

/**
 * `assert_proof_token_shape`, restated from the rule the contract's docstring gives: one
 * whitespace-free character-string, no quote or backslash, at most 255 octets. A token that breaks
 * any of those is refused at deal creation, so a token this interface can build and the contract
 * cannot accept is a form that takes a signature and reverts.
 */
function tokenShapeFault(token: string): string {
  if (!token) return "empty";
  if (Buffer.byteLength(token, "utf8") > MAX_PROOF_TOKEN_BYTES) return "over the octet cap";
  for (const character of token) {
    if (/\s/.test(character)) return `whitespace at ${JSON.stringify(character)}`;
    if (character === '"' || character === "\\") return `ambiguous ${JSON.stringify(character)}`;
  }
  return "";
}

/* --- the record names ------------------------------------------------------ */

test("the record names use the labels the contract publishes", () => {
  assert.equal(sellerRecordName("example.com"), `${SELLER_LABEL}.example.com`);
  assert.equal(buyerRecordName("example.com"), `${BUYER_LABEL}.example.com`);
});

test("the two record names are different names", () => {
  assert.notEqual(sellerRecordName("example.com"), buyerRecordName("example.com"));
});

/* --- the seller's token, which the contract derives itself ------------------ */

/**
 * The contract builds this one as
 * `"%s;deal=%s;%s=%s" % (PROOF_VERSION, deal_id, kind, who.as_hex.lower())` and compares it to the
 * fetched TXT value byte for byte. The format string is lifted from the source here so that
 * changing it on either side breaks this test rather than a live deal.
 *
 * The `.lower()` is asserted separately and in both directions, because it is the part that was
 * once missing. `Address.as_hex` returns the EIP-55 checksummed form, measured under the real SDK
 * as `0x81b637d8fCD2C6da6359E6963113a1170de795e4`, so a bare `as_hex` put a mixed-case address in
 * the token while this interface displayed a lowercased one. Every deal opened that way named a
 * seller who could not arm it. Asserting the absence of the un-lowercased form is what stops the
 * `.lower()` being dropped again by a refactor that still satisfies the format string.
 */
test("the seller's token matches the contract's own format string", () => {
  const format = CONTRACT.match(
    /token = "([^"]+)" % \(PROOF_VERSION, deal_id, kind, who\.as_hex\.lower\(\)\)/,
  );
  assert.ok(format, "the contract no longer builds the seller token the way this test expects");
  assert.equal(format[1], "%s;deal=%s;%s=%s");

  // The un-lowercased derivation must appear nowhere, in the token or anywhere else a proof value
  // is built. `get_deal` may report `as_hex` freely; only a compared value has to be lower case.
  assert.doesNotMatch(CONTRACT, /kind, who\.as_hex\)/);

  const expected = `${PROOF_VERSION};deal=${DEAL};seller=${SELLER.toLowerCase()}`;
  assert.equal(sellerProofValue(DEAL, SELLER), expected);
});

test("the seller's token lowercases a checksummed address", () => {
  assert.equal(sellerProofValue(DEAL, SELLER), sellerProofValue(DEAL, SELLER.toLowerCase()));
  assert.doesNotMatch(sellerProofValue(DEAL, SELLER), /[A-Z]/);
});

test("a wallet reporting an address with stray spaces still produces the contract's token", () => {
  assert.equal(sellerProofValue(DEAL, `  ${SELLER}  `), sellerProofValue(DEAL, SELLER));
});

/* --- the buyer's token, which only ever exists as a digest on chain -------- */

test("the buyer's token carries the secret and the buyer, in that order", () => {
  assert.equal(
    buyerProofValue(DEAL, BUYER, "abc123"),
    `${PROOF_VERSION};deal=${DEAL};buyer=${BUYER.toLowerCase()};secret=abc123`,
  );
});

test("the buyer's token lowercases the address, or the commitment cannot be reproduced", () => {
  const secret = generateSecret();
  assert.equal(
    buyerProofValue(DEAL, BUYER, secret),
    buyerProofValue(DEAL, BUYER.toLowerCase(), secret),
  );
});

test("the buyer's and seller's tokens are never the same string", () => {
  assert.notEqual(buyerProofValue(DEAL, SELLER, generateSecret()), sellerProofValue(DEAL, SELLER));
});

/* --- both tokens have to satisfy the contract's shape rule ----------------- */

test("both tokens are shapes the contract will accept", () => {
  assert.equal(tokenShapeFault(sellerProofValue(DEAL, SELLER)), "");
  assert.equal(tokenShapeFault(buyerProofValue(DEAL, BUYER, generateSecret())), "");
});

test("both tokens stay inside the octet cap at the longest deal id the contract allows", () => {
  const longest = "d".repeat(pythonInt("MAX_ID_CHARS"));
  assert.equal(tokenShapeFault(sellerProofValue(longest, SELLER)), "");
  assert.equal(tokenShapeFault(buyerProofValue(longest, BUYER, generateSecret())), "");
});

/* --- the commitment ------------------------------------------------------- */

test("the commitment is sha256 of the token, hex, lower case", async () => {
  const token = buyerProofValue(DEAL, BUYER, generateSecret());
  const independent = createHash("sha256").update(token, "utf8").digest("hex");
  assert.equal(await commitment(token), independent);
});

test("the commitment is exactly the width the contract requires", async () => {
  const digest = await commitment(buyerProofValue(DEAL, BUYER, generateSecret()));
  assert.equal(digest.length, COMMITMENT_CHARS);
  assert.match(digest, /^[0-9a-f]+$/);
});

test("two secrets commit to two different digests", async () => {
  const first = await commitment(buyerProofValue(DEAL, BUYER, generateSecret()));
  const second = await commitment(buyerProofValue(DEAL, BUYER, generateSecret()));
  assert.notEqual(first, second);
});

test("the same secret under a different deal id commits differently", async () => {
  const secret = generateSecret();
  const first = await commitment(buyerProofValue("d-1", BUYER, secret));
  const second = await commitment(buyerProofValue("d-2", BUYER, secret));
  assert.notEqual(first, second);
});

/* --- the secret itself ---------------------------------------------------- */

test("a secret is 32 bytes of hex and no two are alike", () => {
  const first = generateSecret();
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.notEqual(first, generateSecret());
});

/* --- the zone line -------------------------------------------------------- */

test("the zone line is a whole line, with the root dot and the quotes", () => {
  assert.equal(
    zoneLine(sellerRecordName("example.com"), sellerProofValue(DEAL, SELLER)),
    `${SELLER_LABEL}.example.com. IN TXT "${PROOF_VERSION};deal=${DEAL};seller=${SELLER.toLowerCase()}"`,
  );
});

/**
 * The quotes in the zone line are the line's own, not the token's. A token containing a quote
 * would end the character-string early and the record would mean something else, which is exactly
 * what `assert_proof_token_shape` refuses. This checks the two facts together, because the zone
 * line is what a reader copies and pastes.
 */
test("the only quotes in a copied zone line are the ones the format adds", () => {
  const line = zoneLine(buyerRecordName("example.com"), buyerProofValue(DEAL, BUYER, generateSecret()));
  assert.equal(line.match(/"/g)?.length, 2);
});

/* --- the nameserver set --------------------------------------------------- */

/**
 * The contract canonicalises with `",".join(sorted(names))` over a lowercased, dot-stripped,
 * deduplicated set. The commitment and the stored set both depend on that order, so a set pasted in
 * a different order has to reduce to the same string here or the interface and the chain disagree
 * about what was agreed.
 */
test("the nameserver set is lowercased, dot stripped, deduplicated and sorted", () => {
  assert.deepEqual(canonicalNameservers("NS2.Example.com. ns1.example.com, NS1.EXAMPLE.COM"), [
    "ns1.example.com",
    "ns2.example.com",
  ]);
});

test("order and separator do not change the canonical set", () => {
  const target = ["ns1.example.com", "ns2.example.com", "ns3.example.com"];
  for (const input of [
    "ns1.example.com ns2.example.com ns3.example.com",
    "ns3.example.com,ns2.example.com,ns1.example.com",
    "ns2.example.com\n ns3.example.com,\tns1.example.com",
  ]) {
    assert.deepEqual(canonicalNameservers(input), target);
  }
});

test("the joined form matches what the contract stores", () => {
  assert.equal(
    canonicalNameservers("NS2.example.com, ns1.example.com").join(","),
    "ns1.example.com,ns2.example.com",
  );
});

test("an empty or blank set is empty rather than a set with one empty name", () => {
  assert.deepEqual(canonicalNameservers("   "), []);
  assert.deepEqual(canonicalNameservers(",,, "), []);
});

/* --- the domain ----------------------------------------------------------- */

test("a registrable domain passes", () => {
  for (const name of ["example.com", "a.co.uk", "xn--bcher-kva.example", "a-b.example.com"]) {
    assert.equal(domainFault(name), "", name);
  }
});

test("a URL typed where a domain was asked for is refused with the reason", () => {
  for (const input of [
    "https://example.com",
    "example.com/path",
    "example.com:443",
    "user@example.com",
    "exa mple.com",
  ]) {
    assert.notEqual(domainFault(input), "", input);
  }
});

test("a wildcard, a bare label, a double dot and a stray dot are all refused", () => {
  assert.notEqual(domainFault("*.example.com"), "");
  assert.notEqual(domainFault("localhost"), "");
  assert.notEqual(domainFault("example..com"), "");
  assert.notEqual(domainFault(".example.com"), "");
  assert.notEqual(domainFault("example.com."), "");
});

test("the length limits match DNS, not a guess", () => {
  assert.equal(domainFault(`${"a".repeat(63)}.example.com`), "");
  assert.notEqual(domainFault(`${"a".repeat(64)}.example.com`), "");
  const long = `${Array.from({ length: 5 }, () => "a".repeat(50)).join(".")}.com`;
  assert.ok(long.length > 253);
  assert.notEqual(domainFault(long), "");
});

test("a hyphen may sit inside a label and never at either end", () => {
  assert.equal(domainFault("a-b.example.com"), "");
  assert.notEqual(domainFault("-ab.example.com"), "");
  assert.notEqual(domainFault("ab-.example.com"), "");
});

/**
 * `normalize_domain` in the contract refuses non-ASCII rather than guessing at IDNA. A Unicode name
 * that passed here would therefore look accepted, take a signature, and revert, which is the one
 * class of mistake this validator exists to prevent. The allowed set is lifted from the contract so
 * that widening it there is what widens it here.
 */
test("a Unicode domain is refused, and its punycoded form is accepted", () => {
  const allowed = CONTRACT.match(/^_DOMAIN_LABEL_OK = set\("([^"]+)"\)/m);
  assert.ok(allowed, "the contract no longer declares its allowed label characters as a set");
  assert.equal(allowed[1], "abcdefghijklmnopqrstuvwxyz0123456789-_");

  assert.match(domainFault("bücher.example"), /xn--/);
  assert.equal(domainFault("xn--bcher-kva.example"), "");

  for (const character of allowed[1]) {
    assert.equal(domainFault(`a${character}b.example`), "", character);
  }
  for (const character of "+~!$%^&*()=[]{}<>,'\"`|") {
    assert.notEqual(domainFault(`a${character}b.example`), "", character);
  }
});

/* --- the encrypted keepsake ---------------------------------------------- */

test("a sealed secret opens with the passphrase and not without it", async () => {
  const secret = generateSecret();
  const vault = await sealSecret(secret, "a passphrase long enough", {
    dealId: DEAL,
    domain: "example.com",
  });
  assert.equal(await openSecret(vault, "a passphrase long enough"), secret);
  await assert.rejects(() => openSecret(vault, "a passphrase long enougi"));
});

test("the sealed file carries the deal it belongs to and the parameters to open it", async () => {
  const vault = await sealSecret(generateSecret(), "a passphrase long enough", {
    dealId: DEAL,
    domain: "example.com",
  });
  assert.equal(vault.format, "conveyance.buyer-secret.v1");
  assert.equal(vault.deal_id, DEAL);
  assert.equal(vault.domain, "example.com");
  assert.equal(vault.kdf, "PBKDF2-SHA256");
  assert.equal(vault.iterations, 310000);
  assert.ok(vault.salt && vault.iv && vault.ciphertext);
  assert.ok(vault.note.length > 40, "the file has to say there is no recovery path");
});

test("the secret is nowhere in the file that holds it", async () => {
  const secret = generateSecret();
  const vault = await sealSecret(secret, "a passphrase long enough", {
    dealId: DEAL,
    domain: "example.com",
  });
  assert.doesNotMatch(JSON.stringify(vault), new RegExp(secret));
});

test("two seals of the same secret differ, so the salt and the iv are not fixed", async () => {
  const secret = generateSecret();
  const meta = { dealId: DEAL, domain: "example.com" };
  const first = await sealSecret(secret, "a passphrase long enough", meta);
  const second = await sealSecret(secret, "a passphrase long enough", meta);
  assert.notEqual(first.salt, second.salt);
  assert.notEqual(first.iv, second.iv);
  assert.notEqual(first.ciphertext, second.ciphertext);
});

test("a short passphrase writes nothing and says so", async () => {
  await assert.rejects(
    () => sealSecret(generateSecret(), "short", { dealId: DEAL, domain: "example.com" }),
    /at least 12 characters/,
  );
});
