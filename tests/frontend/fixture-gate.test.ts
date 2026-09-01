import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * The fixture gate, enforced rather than asserted.
 *
 * `data-source.ts` states in its own header that it is the single seam between the bundled
 * fixtures and the deployed contract, and that going live is that one file changing branch with
 * no component changing at all. That claim is true the day it is written and quietly false six
 * commits later, when somebody imports a fixture constant into a page to get it rendering.
 *
 * The reason it matters more here than in most apps is what the fixtures are for. They exist so
 * the interface can be walked before a deployment exists, which means every page is rehearsing
 * the real thing. A page that reached past the gate would be rehearsing something else, and the
 * difference would only show up after a deployment, in the one place nobody is watching.
 *
 * Three properties are enforced below. The fixture module is reachable from the gate and nowhere
 * else. No fixture is read without first checking which mode the app is in. And the three limits
 * the contract enforces on a signed transaction have no fixture answer at all, because a form
 * validated against a figure this repository holds would pass in the browser and revert on chain
 * after taking a signature.
 */

const SRC = fileURLToPath(new URL("../../src/", import.meta.url));
const GATE = "lib/data-source.ts";
const FIXTURES = "lib/mock-data.ts";
const CONFIG = "lib/genlayer/config.ts";

/** Every .ts/.tsx file under src/, as src-relative POSIX paths. */
function sourceFiles(dir: string = SRC, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, found);
    else if (/\.tsx?$/.test(entry)) found.push(path.relative(SRC, full).split(path.sep).join("/"));
  }
  return found;
}

const FILES = sourceFiles();
const read = (rel: string): string => readFileSync(path.join(SRC, rel), "utf8");

test("the app has the source layout these tests assume", () => {
  assert.ok(FILES.length > 20, `only found ${FILES.length} source files`);
  for (const rel of [GATE, FIXTURES, CONFIG]) {
    assert.ok(FILES.includes(rel), `${rel} is missing`);
  }
});

/* --- reaching the fixtures ------------------------------------------------- */

test("the fixture module is imported by the gate and by nothing else", () => {
  const importers: string[] = [];
  for (const rel of FILES) {
    for (const statement of read(rel).match(/^\s*import[\s\S]*?from\s+"([^"]+)"/gm) ?? []) {
      const target = statement.match(/from\s+"([^"]+)"$/)?.[1] ?? "";
      if (/(^|\/)mock-data(\.ts)?$/.test(target)) importers.push(rel);
    }
  }
  assert.deepEqual(importers, [GATE]);
});

test("no page or component names a fixture constant", () => {
  for (const rel of FILES) {
    if (rel === GATE || rel === FIXTURES) continue;
    assert.doesNotMatch(read(rel), /\bMOCK_[A-Z_]+\b/, `${rel} reaches past the gate`);
  }
});

/**
 * Every fixture read has to sit behind a mode check inside its own function. Scanning per function
 * rather than per file is the point: a single `IS_LIVE` at the top of the module would satisfy a
 * file-wide search while leaving a later reader ungated.
 */
test("every fixture read in the gate sits behind the mode check", () => {
  const lines = read(GATE).split("\n");
  let gated = false;
  let fixtureReads = 0;

  for (const [index, line] of lines.entries()) {
    if (/^import\b/.test(line)) continue; // the import names them; it does not read them
    if (/^export (async )?function /.test(line)) gated = false;
    if (/\bIS_LIVE\b/.test(line)) gated = true;
    if (!/\bMOCK_[A-Z_]+\b/.test(line)) continue;
    fixtureReads += 1;
    assert.ok(gated, `${GATE}:${index + 1} reads a fixture before checking IS_LIVE: ${line.trim()}`);
  }

  assert.ok(fixtureReads >= 6, `expected the gate to serve several fixture reads, saw ${fixtureReads}`);
});

/**
 * The live branch has to be reachable from every reader that has one, which is the other half of
 * the same property. A function that imported `live` and never called it would be a fixture-only
 * reader wearing a live signature.
 */
test("every read with a live counterpart calls it rather than only importing it", () => {
  const gate = read(GATE);
  const called = new Set(
    [...gate.matchAll(/\blive\.([a-zA-Z]+)\(/g)].map((match) => match[1]),
  );
  for (const name of ["listDeals", "getDeal", "deliveryStatus", "ledger", "parameters"]) {
    assert.ok(called.has(name), `the gate never calls live.${name}()`);
  }
});

/* --- the limits with no fixture answer ------------------------------------- */

/**
 * This is the exception the gate's header calls the important one, and it is the assertion most
 * worth having. The escrow ceiling and the nameserver bounds are limits the contract enforces on a
 * signed transaction. Both are compile-time constants in the contract source, and copying either
 * one into this repository would produce a form that passes in the browser and reverts on chain
 * after taking a signature. So the fixture leaves them empty and the reader refuses.
 */
test("the fixture parameters leave the three enforced limits empty", () => {
  const fixtures = read(FIXTURES);
  const block = fixtures.slice(
    fixtures.indexOf("export const MOCK_PARAMETERS"),
    fixtures.indexOf("};", fixtures.indexOf("export const MOCK_PARAMETERS")),
  );
  assert.ok(block.length > 100, "MOCK_PARAMETERS was not found");
  for (const field of ["max_deal_value_wei", "min_nameservers", "max_nameservers"]) {
    assert.match(
      block,
      new RegExp(`${field}: "",`),
      `${field} has a fixture answer, so a form could validate a real price against this repository`,
    );
  }
});

test("neither limit reader invents a figure or borrows one from the fixtures", () => {
  const gate = read(GATE);
  for (const name of ["priceCap", "nameserverBounds"]) {
    const start = gate.indexOf(`export async function ${name}`);
    assert.ok(start > 0, `${name} is missing from the gate`);
    const rest = gate.slice(start);
    const body = rest.slice(0, rest.indexOf("\n}\n") + 2);

    assert.doesNotMatch(body, /\bMOCK_/, `${name} reads a fixture for an enforced limit`);
    assert.match(body, /unavailable\(NO_FIXTURE_FOR_A_LIMIT\)/, `${name} must refuse rather than answer`);
    assert.doesNotMatch(body, /\b10\s*\*\*\s*\d+/, `${name} computes a limit instead of reading one`);
  }
});

/**
 * The contract's own numbers, kept out of the interface. Two and eight are the nameserver bounds
 * in `contracts/Conveyance.py`; finding either beside a validator in the gate would mean the
 * refusal above had been quietly worked around.
 */
test("the gate holds no copy of a limit the contract enforces", () => {
  const gate = read(GATE);
  const CONTRACT = readFileSync(
    fileURLToPath(new URL("../../contracts/Conveyance.py", import.meta.url)),
    "utf8",
  );
  const cap = CONTRACT.match(/^MAX_DEAL_VALUE_WEI = (.+)$/m);
  assert.ok(cap, "the contract no longer declares MAX_DEAL_VALUE_WEI");
  const digits = cap[1].match(/\d{6,}/);
  if (digits) assert.ok(!gate.includes(digits[0]), "the gate holds a copy of the escrow ceiling");

  for (const name of ["MIN_NAMESERVERS", "MAX_NAMESERVERS"]) {
    const bound = CONTRACT.match(new RegExp(`^${name} = (\\d+)$`, "m"));
    assert.ok(bound, `the contract no longer declares ${name}`);
    assert.doesNotMatch(
      gate,
      new RegExp(`(min|max)\\w*\\s*[:=]\\s*${bound[1]}\\b`),
      `the gate hardcodes ${name}`,
    );
  }
});

/* --- the mode itself ------------------------------------------------------- */

/**
 * The mode is derived once, from the configured address, and nothing else in the app computes its
 * own answer to "are we live". Two flags that could disagree is how a banner ends up claiming live
 * data over a page rendering fixtures.
 */
test("the mode is derived once, from the configured address", () => {
  const config = read(CONFIG);
  assert.match(config, /export const IS_LIVE = DATA_MODE === "live" && Boolean\(CONTRACT_ADDRESS\)/);

  const declarations = FILES.filter((rel) => /^export const (IS_LIVE|DATA_MODE)\b/m.test(read(rel)));
  assert.deepEqual(declarations, [CONFIG], "the mode is declared in more than one place");
});

/**
 * `DATA_MODE === "live"` on its own is not liveness. The env var can ask for live with no address
 * set, and that third state has to reach the page as its own sentence rather than falling back to
 * fixtures under a banner that says otherwise.
 */
test("asking for live with no address is its own state and says so", () => {
  const gate = read(GATE);
  assert.match(gate, /DATA_MODE === "live" && !CONTRACT_ADDRESS/);
  assert.match(gate, /mode: "misconfigured"/);
  assert.match(gate, /NEXT_PUBLIC_CONVEYANCE_CONTRACT/, "the misconfigured line must name the variable to set");

  const provenance = gate.slice(gate.indexOf("export function dataProvenance"));
  const body = provenance.slice(0, provenance.indexOf("\n}\n"));
  for (const mode of ['mode: "misconfigured"', 'mode: "live"', 'mode: "fixtures"']) {
    assert.ok(body.includes(mode), `dataProvenance has no ${mode} branch`);
  }
});

/**
 * The fixture banner has to say the domains are invented. The register uses real TLDs and real
 * IANA registrar ids because the fixtures have to exercise a different RDAP base per registry, so
 * a reader could reasonably take a name in it for a real registration, and a fixture deal is a
 * statement that somebody's property is in escrow for a sum.
 */
test("the fixture banner says the register is invented, in the header and not a footnote", () => {
  const gate = read(GATE);
  const line = gate.match(/mode: "fixtures",\s*\n\s*line: `([^`]+)`/);
  assert.ok(line, "the fixtures branch has no line");
  assert.match(line[1], /invented/);
  assert.match(line[1], /none of it is a claim about anybody/);
  assert.match(line[1], /no write will be attempted/);
});

/* --- the clock ------------------------------------------------------------- */

/**
 * A fixed instant in fixture mode, so a deadline described as thirty-one hours away stays that way
 * between a server render and a client render of the same page. Live it is `Date.now()`, and the
 * choice is made in one place so no page can reach for the clock itself.
 *
 * Three files do read the clock directly and all three are named here rather than matched by a
 * pattern, because the reasons are specific enough that a fourth file appearing should be a failed
 * test and not a widened regex. `deadline.tsx` ticks a mounted countdown and gates the tick on
 * live mode, so the fixture freeze survives. `transaction-provider.tsx` and `transaction-state.ts`
 * measure how long a submitted transaction has been outstanding, which is wall-clock time about a
 * real transaction and has nothing to do with which mode the reads are in; both take the instant
 * as an injectable parameter rather than reaching for it mid-calculation.
 */
test("the fixture clock is fixed and the live one is now, decided in one place", () => {
  const gate = read(GATE);
  assert.match(gate, /return IS_LIVE \? Date\.now\(\) : Date\.parse\(MOCK_NOW\)/);
  assert.match(read(FIXTURES), /export const MOCK_NOW = "[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:]+Z"/);

  const readers = FILES.filter((rel) => rel !== GATE && /\bDate\.now\(\)/.test(read(rel)));
  assert.deepEqual(
    readers.sort(),
    ["components/deadline.tsx", "components/transaction-provider.tsx", "lib/transaction-state.ts"],
    "a new file reads the clock directly; either route it through referenceNow() or say why here",
  );

  // The transaction age helpers take the instant as a parameter, so they are testable and so two
  // calls in one pass cannot disagree about what "now" was.
  const state = read("lib/transaction-state.ts");
  for (const fn of ["shouldRefreshTransaction", "normalizeStoredTransactions"]) {
    assert.match(state, new RegExp(`export function ${fn}\\([^)]*now = Date\\.now\\(\\)`), fn);
  }
});

/**
 * The freeze is only a freeze if nothing undoes it after mount. A countdown that seeds from the
 * server's instant and then starts ticking from the browser's would drift away from the fixed clock
 * the provenance strip has already named, so the tick returns early when the app is not live.
 */
test("the mounted countdown does not tick away from the frozen fixture clock", () => {
  const component = read("components/deadline.tsx");
  assert.match(component, /if \(!IS_LIVE\) return;/, "the tick is not gated on live mode");

  const effect = component.slice(component.indexOf("useEffect("));
  const gateAt = effect.indexOf("if (!IS_LIVE) return;");
  const tickAt = effect.indexOf("setInterval(");
  assert.ok(gateAt >= 0 && tickAt >= 0);
  assert.ok(gateAt < tickAt, "the interval is installed before the fixture check can stop it");

  // The seed comes from the server render, so the first paint on both sides is the same instant.
  assert.match(component, /useState\(now\)/);
  assert.match(component, /countdown\(iso, clock\)/);
});

/* --- the probe, which refuses rather than inventing an answer -------------- */

/**
 * The fixture probe answers for three names and refuses for every other one. Answering for
 * anything typed would be this app deciding what a registry says about a domain, which is the one
 * thing the product exists to not do, and in fixture mode the mistake would be invisible.
 */
test("the fixture probe refuses an unknown name instead of inventing a registrar", () => {
  const gate = read(GATE);
  const start = gate.indexOf("export async function probeFixture");
  assert.ok(start > 0, "probeFixture is missing");
  const body = gate.slice(start);

  assert.match(body, /MOCK_PROBES\.find\(/, "the probe must look the name up rather than build one");
  assert.match(body, /return unavailable\(/, "the probe must refuse for a name it has no fixture for");
  assert.match(body, /Nothing is guessed for a name that does not/);
});
