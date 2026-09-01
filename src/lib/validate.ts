/**
 * The contract's own argument rules, restated where a browser can reach them.
 *
 * These mirror `_require_id`, `_require_address`, `_require_registrar_id` and
 * `_require_nameservers` in `contracts/Conveyance.py`. They are a courtesy and not an authority:
 * the offer form rehearses the real call before it sends, and where these two ever disagree the
 * contract is right. They exist so that a typo costs a sentence rather than a signature.
 *
 * WHY THEY LIVE HERE RATHER THAN IN THE FORM. A restatement of somebody else's rule is only worth
 * having while it still matches, and the way to keep it matching is to test it against the rule it
 * copies. A validator declared inside a `"use client"` component with JSX in it cannot be imported
 * by a node test, so it can only be checked by reading it. Moved out here, `tests/frontend`
 * compares each bound against the constant it was copied from, and the day the contract raises
 * `MAX_NAMESERVERS` the mismatch is a failed test rather than a form that refuses a set the chain
 * would have taken.
 *
 * The four bounds below are `MAX_ID_CHARS`, `MAX_REGISTRAR_ID_CHARS`, `MAX_NAMESERVER_CHARS` and
 * the address shape. The nameserver count is deliberately not a constant here: it arrives as text
 * from `parameters()`, because a figure this repository holds could pass a form and still be
 * refused on chain.
 *
 * WHERE THESE ARE NARROWER THAN THE CONTRACT, AND WHY THAT IS THE SAFE DIRECTION. Python's
 * `str.isalnum()` is Unicode aware, so the contract would accept a deal id or a nameserver label
 * holding `é`. These refuse it. The contract also checks nameserver characters without checking
 * their placement, so it would accept `-ns1.example.com`, which cannot be delegated to. These
 * refuse that too. Narrower means a reader is occasionally told no about something the chain would
 * have taken, and is told why, before signing. Wider would mean a signature spent on a refusal.
 * `tests/frontend/argument-rules.test.ts` asserts both divergences in both directions, so neither
 * can widen by accident.
 */

/** `_require_id`: 1 to 64 characters, alphanumerics plus hyphen, underscore and dot. */
const ID_SHAPE = /^[A-Za-z0-9._-]+$/;
const MAX_ID_CHARS = 64;

export function idFault(value: string): string {
  const id = value.trim();
  if (!id) return "Choose an identifier for this deal.";
  if (id.length > MAX_ID_CHARS) {
    return `An identifier may not exceed ${MAX_ID_CHARS} characters.`;
  }
  if (!ID_SHAPE.test(id)) {
    return "Letters, digits, hyphen, underscore and dot only. Nothing else is accepted.";
  }
  return "";
}

/**
 * `_require_address`: 0x and 40 hex characters, and never the zero address.
 *
 * The zero address is refused separately because it satisfies the shape. On chain it is the
 * address a mistyped or empty field decodes to, and a deal whose seller is the zero address is a
 * deal whose escrow has nowhere to go.
 */
export function addressFault(value: string, who: string): string {
  const address = value.trim();
  if (!address) return `Name the ${who}.`;
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return "An address is 0x followed by 40 hexadecimal characters.";
  }
  if (/^0x0{40}$/i.test(address)) return "The zero address is not a party to anything.";
  return "";
}

/** `_require_registrar_id`: digits only, 1 to 12 of them. */
const MAX_REGISTRAR_ID_CHARS = 12;

export function registrarFault(value: string): string {
  const id = value.trim();
  if (!id) return "Give the IANA id of the registrar the domain has to end up at.";
  if (!/^\d+$/.test(id)) {
    return "An IANA registrar id is digits only. A registrar's display name is not accepted, because a name can change without a transfer.";
  }
  if (id.length > MAX_REGISTRAR_ID_CHARS) {
    return `A registrar id may not exceed ${MAX_REGISTRAR_ID_CHARS} digits.`;
  }
  return "";
}

/** `_require_nameservers`: dotted hosts, alphanumerics plus hyphen and dot, 253 characters each. */
const HOST_SHAPE = /^[A-Za-z0-9.-]+$/;
const MAX_NAMESERVER_CHARS = 253;
const MAX_LABEL_CHARS = 63;

/**
 * The count bounds arrive as text, not as numbers, and an empty string means the read failed.
 *
 * That is why they are checked last and skipped when absent. A form that guessed at the bounds
 * because `parameters()` could not be reached would be inventing the one figure it has no business
 * inventing, and the guess would be indistinguishable from a fact on screen.
 */
export function nameserverFault(names: string[], min: string, max: string): string {
  if (names.length === 0) return "Give the nameservers the domain has to be delegated to.";
  for (const name of names) {
    if (!name.includes(".")) {
      return `${name} is not a hostname. A nameserver needs at least one dot.`;
    }
    if (!HOST_SHAPE.test(name)) return `${name} carries a character the contract will not accept.`;
    if (name.length > MAX_NAMESERVER_CHARS) {
      return `${name} is longer than ${MAX_NAMESERVER_CHARS} characters.`;
    }
    /**
     * The label rules are stricter here than in the contract, and on purpose. The contract checks
     * characters and not placement, so it would accept `-ns1.example.com` or `ns1..example.com`.
     * Neither can be delegated to, and a deal whose target nameservers cannot resolve is a deal
     * that can only end in a refund after the transfer window closes. Refusing it now costs a
     * sentence.
     */
    for (const label of name.split(".")) {
      if (!label) return `${name} has an empty label, so it is not a hostname.`;
      if (label.length > MAX_LABEL_CHARS) {
        return `${label} is longer than ${MAX_LABEL_CHARS} characters, which no label may be.`;
      }
      if (label.startsWith("-") || label.endsWith("-")) {
        return `${name} has a label starting or ending with a hyphen, so it cannot be delegated to.`;
      }
    }
  }
  if (min && names.length < Number(min)) {
    return `The contract requires at least ${min}. This is ${names.length} once duplicates are dropped.`;
  }
  if (max && names.length > Number(max)) {
    return `The contract accepts at most ${max}. This is ${names.length}.`;
  }
  return "";
}

/**
 * `_require_commitment`: exactly 64 lowercase hex characters.
 *
 * Nothing in the interface asks a reader to type one, because `commitment()` computes it from the
 * token. It is restated anyway so that the shape the contract insists on is checked in the one
 * place a test can reach, and so that a commitment arriving from anywhere other than that function
 * can be refused rather than sent.
 */
const COMMITMENT_CHARS = 64;

export function commitmentFault(value: string): string {
  const digest = value.trim();
  if (!digest) return "No commitment was computed.";
  if (digest.length !== COMMITMENT_CHARS) {
    return `A commitment is exactly ${COMMITMENT_CHARS} characters. This is ${digest.length}.`;
  }
  if (!/^[0-9a-f]+$/.test(digest)) {
    return "A commitment is lower case hexadecimal. Upper case will not match on chain.";
  }
  return "";
}
