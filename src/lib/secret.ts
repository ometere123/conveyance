/**
 * The buyer's secret, and the record that proves control of the zone with it.
 *
 * The secret exists in exactly three places: this tab's memory, the TXT record the buyer
 * publishes, and a file the buyer chooses to save. It is never put in a URL, a query string,
 * a log line, a fetch body or a storage key. Only its sha256 goes on chain, and the contract
 * compares against that hash, so the chain never learns the secret either.
 *
 * Everything here runs in the browser and nothing here is imported by a server component.
 */

const PROOF_VERSION = "v1";

/** 32 bytes from the platform RNG, hex encoded. No fallback to Math.random, ever. */
export function generateSecret(): string {
  if (typeof crypto === "undefined" || typeof crypto.getRandomValues !== "function") {
    throw new Error(
      "This browser exposes no cryptographic random source, so no secret will be generated here.",
    );
  }
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return toHex(bytes);
}

export const sellerRecordName = (domain: string) => `_conveyance-seller.${domain}`;
export const buyerRecordName = (domain: string) => `_conveyance-buyer.${domain}`;

/**
 * `v1;deal=<id>;seller=<address>` exactly, with no spaces and no padding.
 *
 * The address is lowercased, and that is not cosmetic. The contract derives the seller's token by
 * lowercasing `Address.as_hex`, and it compares the derived token to the published TXT value byte
 * for byte, because `canonical_control_proof` normalises the query name and never the values. A
 * wallet reports a checksummed mixed-case address, so a token built from one unmodified would
 * differ from the contract's in nine or ten characters and match it nowhere.
 *
 * This agreement was not always real. `_proof_token` lowercases because a live deployment stored
 * `seller=0xac3AC69dC0Bde389256dD6748C75817ead9286D9` while this function displayed the same line
 * lowercased, which made every deal unarmable by the seller it named. The direct suite asserts the
 * contract's half; `tests/frontend/proof-records.test.ts` asserts this half.
 */
export const sellerProofValue = (dealId: string, seller: string) =>
  `${PROOF_VERSION};deal=${dealId};seller=${seller.trim().toLowerCase()}`;

/**
 * `v1;deal=<id>;buyer=<address>;secret=<secret>` exactly.
 *
 * Lowercased for the same reason, and here the consequence is worse. The contract never derives
 * this token; it only compares its sha256 to the commitment lodged at open. So a token built from
 * a checksummed address at open and rebuilt from `deal.buyer` at check time would hash to two
 * different digests, and the deal would be unverifiable with nothing on chain to say why.
 */
export const buyerProofValue = (dealId: string, buyer: string, secret: string) =>
  `${PROOF_VERSION};deal=${dealId};buyer=${buyer.trim().toLowerCase()};secret=${secret}`;

/** The whole line, as a zone file would hold it. What the copy button copies. */
export const zoneLine = (name: string, value: string) => `${name}. IN TXT "${value}"`;

/** sha256, hex, lower case. The only form of the secret that leaves this tab willingly. */
export async function commitment(value: string): Promise<string> {
  if (typeof crypto === "undefined" || !crypto.subtle) {
    throw new Error(
      "Hashing needs a secure context. Serve this page over https and the commitment can be computed.",
    );
  }
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return toHex(new Uint8Array(digest));
}

/* -------------------------------------------------------------------------- */
/* The encrypted keepsake                                                     */
/* -------------------------------------------------------------------------- */

export type SecretVault = {
  format: "conveyance.buyer-secret.v1";
  deal_id: string;
  domain: string;
  kdf: "PBKDF2-SHA256";
  iterations: number;
  salt: string;
  iv: string;
  ciphertext: string;
  note: string;
};

const ITERATIONS = 310000;

/**
 * AES-GCM under a passphrase-derived key, so the downloaded file is useless on its own.
 *
 * An unencrypted download would put the secret in the Downloads folder in plaintext, which
 * is the single most likely place for it to leak from. The passphrase never leaves the tab
 * either; there is nothing to recover it with, and the file says so in its own note field.
 */
export async function sealSecret(
  secret: string,
  passphrase: string,
  meta: { dealId: string; domain: string },
): Promise<SecretVault> {
  if (typeof crypto === "undefined" || !crypto.subtle) {
    throw new Error(
      "Encryption needs a secure context. Serve this page over https and the download can be encrypted.",
    );
  }
  if (passphrase.length < 12) {
    throw new Error("Use a passphrase of at least 12 characters. Nothing was written.");
  }
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(secret),
  );
  return {
    format: "conveyance.buyer-secret.v1",
    deal_id: meta.dealId,
    domain: meta.domain,
    kdf: "PBKDF2-SHA256",
    iterations: ITERATIONS,
    salt: toBase64(salt),
    iv: toBase64(iv),
    ciphertext: toBase64(new Uint8Array(ciphertext)),
    note: "Encrypted with a passphrase held only by whoever typed it. There is no recovery path and no copy of it anywhere else.",
  };
}

export async function openSecret(vault: SecretVault, passphrase: string): Promise<string> {
  const key = await deriveKey(passphrase, fromBase64(vault.salt));
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(vault.iv) },
    key,
    fromBase64(vault.ciphertext),
  );
  return new TextDecoder().decode(plain);
}

async function deriveKey(passphrase: string, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: ITERATIONS, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/* -------------------------------------------------------------------------- */
/* Encoding                                                                   */
/* -------------------------------------------------------------------------- */

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * Base64 back to bytes, in a buffer the Web Crypto types will accept.
 *
 * The `<ArrayBuffer>` parameter is load bearing. A bare `Uint8Array` can be backed by a
 * `SharedArrayBuffer`, which `BufferSource` excludes, so without it every call into
 * `crypto.subtle` here needs a cast to compile. One annotation removes all of them.
 */
function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/**
 * Nameserver text into the canonical set: lower case, root dot dropped, deduplicated, sorted.
 *
 * The contract canonicalises the same way, so a set typed in a different order or a
 * different case commits to the same value. Sorting here is what makes the commitment
 * insensitive to how somebody happened to paste it.
 */
export function canonicalNameservers(input: string): string[] {
  const items = input
    .split(/[\s,]+/)
    .map((item) => item.trim().toLowerCase().replace(/\.$/, ""))
    .filter(Boolean);
  return [...new Set(items)].sort();
}

/**
 * Is this a registrable domain and nothing else?
 *
 * A scheme, a path, a port, a userinfo or a wildcard all mean the caller typed a URL where a
 * domain was asked for, and the contract will refuse it after taking a signature. Refusing
 * it here costs nothing.
 */
export function domainFault(input: string): string {
  const value = input.trim();
  if (!value) return "Enter a domain.";
  if (/[:/?#@\s]/.test(value)) {
    return "Enter the domain only, with no scheme, port, path or spaces.";
  }
  if (value.startsWith("*")) return "A wildcard is not a domain.";
  if (value.startsWith(".") || value.endsWith(".")) return "Drop the leading or trailing dot.";
  const labels = value.split(".");
  if (labels.length < 2) return "A registrable domain needs at least one dot.";
  if (labels.some((label) => label.length === 0)) return "Two dots in a row leave an empty label.";
  if (labels.some((label) => label.length > 63)) return "A label may not exceed 63 characters.";
  if (value.length > 253) return "A domain may not exceed 253 characters.";
  if (labels.some((label) => label.startsWith("-") || label.endsWith("-"))) {
    return "A label may not start or end with a hyphen.";
  }
  /**
   * The contract's `normalize_domain` refuses non-ASCII outright rather than guessing at IDNA,
   * because two validators that disagreed about an encoding would be looking up two different
   * domains and would still agree with each other about it. So a Unicode name that looks fine here
   * would be refused on chain, which is the one class of mistake this function exists to prevent.
   */
  if (labels.some((label) => !/^[a-z0-9_-]+$/.test(label.toLowerCase()))) {
    return "Letters, digits, hyphen and underscore only. An internationalised name has to be typed as its xn-- punycode form, because the contract refuses to guess at an encoding.";
  }
  return "";
}
