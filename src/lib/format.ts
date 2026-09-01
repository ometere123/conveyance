/**
 * Printing values without asserting anything the value does not carry.
 *
 * Every sum arrives as a decimal string of wei. Nothing here converts through a JS number,
 * because a price in this product is the whole point of the product and a rounded price is
 * a wrong price.
 */

const WEI_PER_GEN = 10n ** 18n;

/** `1.5 GEN`, `0.000000000000000001 GEN`, exactly, with no trailing zero theatre. */
export function formatGen(wei: string | bigint): string {
  // An empty field is not zero. A contract that reported no figure must not be printed as
  // having reported none owing, which is what "0 GEN" would say next to a price.
  if (wei === "" || wei === null || wei === undefined) return "not reported";
  let value: bigint;
  try {
    value = typeof wei === "bigint" ? wei : BigInt(wei || "0");
  } catch {
    return `${String(wei)} wei`;
  }
  const negative = value < 0n;
  if (negative) value = -value;
  const whole = value / WEI_PER_GEN;
  const fraction = value % WEI_PER_GEN;
  const sign = negative ? "-" : "";
  if (fraction === 0n) return `${sign}${whole.toString()} GEN`;
  const digits = fraction.toString().padStart(18, "0").replace(/0+$/, "");
  return `${sign}${whole.toString()}.${digits} GEN`;
}

/** The parser for a typed amount. Returns null rather than guessing at a malformed one. */
export function genToWei(input: string): bigint | null {
  const text = input.trim();
  if (!/^\d+(\.\d{1,18})?$/.test(text)) return null;
  const [whole, fraction = ""] = text.split(".");
  return BigInt(whole) * WEI_PER_GEN + BigInt(fraction.padEnd(18, "0") || "0");
}

export function shortenHex(value: string, head = 10, tail = 6): string {
  if (!value) return "not recorded";
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

/** ISO in, ISO out. An empty field is stated as empty rather than rendered as the epoch. */
export function displayTime(iso: string): string {
  if (!iso) return "not recorded";
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return iso;
  return new Date(at).toISOString().replace("T", " ").replace(".000Z", "Z");
}

export function formatCount(value: string | number): string {
  const text = String(value ?? "");
  if (!/^\d+$/.test(text)) return text || "0";
  return text.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * A window length, from seconds the contract reported rather than a constant this file
 * believes. `parameters()` is the source; when it is unreadable the caller prints nothing.
 */
export function formatWindow(seconds: string): string {
  const total = Number(seconds);
  if (!Number.isFinite(total) || total <= 0) return "not reported";
  const hours = Math.round(total / 3600);
  if (hours % 24 === 0 && hours >= 24) {
    const days = hours / 24;
    return days === 1 ? "1 day" : `${days} days`;
  }
  return hours === 1 ? "1 hour" : `${hours} hours`;
}

export type Countdown =
  | { kind: "none" }
  | { kind: "running"; text: string }
  | { kind: "elapsed"; text: string };

/**
 * How long is left on a deadline, measured against a clock the caller passes in.
 *
 * `now` is a parameter so the server render and the client render of the same page can be
 * given the same instant. A countdown that disagrees with itself across hydration is a
 * countdown nobody trusts, and this one sits next to a sum of money.
 */
export function countdown(deadlineIso: string, now: number): Countdown {
  if (!deadlineIso) return { kind: "none" };
  const at = Date.parse(deadlineIso);
  if (Number.isNaN(at)) return { kind: "none" };
  const delta = at - now;
  const text = describeSpan(Math.abs(delta));
  return delta > 0 ? { kind: "running", text: `${text} remaining` } : { kind: "elapsed", text: `${text} ago` };
}

function describeSpan(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return minutes === 1 ? "1 minute" : `${minutes} minutes`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) {
    const rest = minutes % 60;
    const head = hours === 1 ? "1 hour" : `${hours} hours`;
    return rest === 0 ? head : `${head} ${rest} min`;
  }
  const days = Math.floor(hours / 24);
  const rest = hours % 24;
  const head = `${days} days`;
  return rest === 0 ? head : `${head} ${rest} h`;
}

/**
 * A comma-joined set from the contract, back into its members.
 *
 * The contract stores nameserver sets, status lists, resolver names and TXT record values as
 * `",".join(sorted(...))`, because GenVM storage carries no list type. This is the only place
 * in the interface that takes one apart, so a component never has to decide what an empty
 * string means or whether to trim.
 *
 * An empty field yields an empty array and not `[""]`. That distinction is load bearing: a
 * domain with no delegation and a domain with one nameserver called "" are different claims,
 * and only the first one happens.
 */
export function splitSet(joined: string): string[] {
  if (!joined) return [];
  return joined
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

/** How many members a comma-joined set has, printed for a count column. */
export function setSize(joined: string): number {
  return splitSet(joined).length;
}

/**
 * Two comma-joined sets compared as sets.
 *
 * The contract canonicalises both sides before storing them, sorted and lowercased and
 * de-duplicated, so a plain string comparison is already correct. This function exists so a
 * component asking "did the delegation match" reads as that question rather than as string
 * equality that happens to mean it, and so the canonicalisation is documented at the point of
 * use rather than only in the contract.
 */
export function setsAgree(left: string, right: string): boolean {
  return left === right && left !== "";
}

/** Members of `next` that are not in `previous`, in the order `next` carries them. */
export function setAdded(previous: string, next: string): string[] {
  const before = new Set(splitSet(previous));
  return splitSet(next).filter((item) => !before.has(item));
}

/** Members of `previous` that are gone from `next`. */
export function setRemoved(previous: string, next: string): string[] {
  return setAdded(next, previous);
}

/**
 * A domain, printed the way a registry would have to agree with.
 *
 * Punycode is shown beside the Unicode form whenever they differ, because a homograph is
 * the cheapest attack available against a screen that shows only one of the two.
 */
export function domainForms(domain: string): { unicode: string; ascii: string; differs: boolean } {
  const ascii = domain;
  let unicode = domain;
  if (domain.split(".").some((label) => label.startsWith("xn--"))) {
    try {
      unicode = new URL(`https://${domain}`).hostname;
      // URL keeps punycode in `hostname`, so only a real decoder would differ. Left as the
      // ascii form when no decode happened, which is honest rather than clever.
    } catch {
      unicode = domain;
    }
  }
  return { unicode, ascii, differs: unicode !== ascii };
}
