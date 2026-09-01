import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * What a read is allowed to say when it produced no value, enforced rather than trusted.
 *
 * This file exists because of a defect it would have caught, and the defect is the reason to keep
 * it rather than fold these assertions into a comment.
 *
 * `live-reads.ts` used to route every view call through `readMaybe`, a helper in the transaction
 * layer that catches five unrelated RPC failures and returns `undefined` for all of them: a
 * raising contract, a malformed call, a rate limit, an exhausted connection pool, and a response
 * body that is not JSON. The caller then mapped `undefined` to NOT_FOUND. So a node that was
 * merely busy made the register print "The contract has no register of deals under that
 * identifier. Nothing is missing and nothing failed." Every clause of that was wrong. Something
 * had failed; the read it described was `list_deals`, which takes no identifier and therefore has
 * no identifier to be missing; and the reader was told the register was empty when nobody had
 * managed to ask it.
 *
 * It is the same mistake the contract spends four error tags avoiding. `[TRANSIENT]` and
 * `[EXPECTED]` exist precisely so that "nothing was decided" is never reported as "a rule fired",
 * and this interface had the mirror-image bug on the way back out: a transport fault reported as a
 * verdict about storage. A frontend that undoes the contract's care on the last hop is worse than
 * one that never took it, because the care is what the reader is being asked to rely on.
 *
 * THREE PROPERTIES ARE ENFORCED BELOW.
 *
 * Nothing on the read path swallows a failure, so every one of them arrives at the reader as the
 * network fact it is, carrying the node's own message.
 *
 * NOT_FOUND has exactly one source in each branch, and in both it is a read that was given an
 * identifier. A view with no argument cannot be a not-found, and no amount of node trouble may
 * turn into one.
 *
 * An answer this build does not recognise is an unusable shape and not an absence, because those
 * reach the page as different sentences and only one of them is a claim about the register.
 *
 * WHY THIS IS A SOURCE-TEXT TEST AND NOT AN EXERCISE OF THE FUNCTIONS. `live-reads.ts` imports
 * through the `@/` alias, which `node --experimental-strip-types` does not resolve, so the module
 * cannot be loaded here. Rewriting its imports to relative paths purely to make it importable
 * would make it the one file in `src/` that is written differently from its neighbours. Reading it
 * as text costs nothing and pins the property that actually broke, which was structural. The
 * measurement that says NOT_FOUND belongs only to keyed reads is on the deployed contract, not
 * here: `get_deal cv-e2e-was-never-lodged` and `delivery_status never-lodged.example` both answer
 * `{}` rather than raising, and that is recorded in the header of `live-reads.ts`.
 */

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SRC = path.join(ROOT, "src");

const LIVE = "lib/live-reads.ts";
const GATE = "lib/data-source.ts";
const TX = "lib/genlayer/tx.ts";
const RESULT = "lib/genlayer/read-result.ts";

const read = (rel: string): string => readFileSync(path.join(SRC, rel), "utf8");

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

/**
 * A file's code with its comments removed.
 *
 * Needed because these tests search for the names of things that must not be used, and the files
 * they search explain at length why those things must not be used. The first run of the test below
 * failed on the paragraph in `live-reads.ts` recording the defect, which is the one mention of
 * `readMaybe` that should be there. Block comments carry all the prose in this codebase; the line
 * form is stripped too, and `://` is spared so a URL in a comment does not truncate the line.
 */
function codeOf(rel: string): string {
  return read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** The body of a named function, from its declaration to the first column-zero close. */
function bodyOf(source: string, declaration: string): string {
  const start = source.indexOf(declaration);
  assert.ok(start > 0, `${declaration} is missing`);
  const rest = source.slice(start);
  const end = rest.indexOf("\n}\n");
  assert.ok(end > 0, `${declaration} has no closing brace at column zero`);
  return rest.slice(0, end + 2);
}

test("the read path has the layout these tests assume", () => {
  for (const rel of [LIVE, GATE, TX, RESULT]) {
    assert.ok(FILES.includes(rel), `${rel} is missing`);
  }
});

/* --- nothing on the read path swallows a failure --------------------------- */

/**
 * The helper that collapses five failures into one absent value stays where it is, reachable from
 * the schema check that can honestly treat "could not ask" as "no", and from nowhere else. Asserted
 * as an exact list rather than as an absence from `live-reads.ts` alone, so a third caller has to
 * be argued for here before it can exist.
 */
test("the swallowing helper is confined to the file that defines it", () => {
  const importers = FILES.filter((rel) => /\breadMaybe\b/.test(codeOf(rel)));
  assert.deepEqual(
    importers,
    [TX],
    "readMaybe reached a second file; a rate limit must not become a fact about storage",
  );
});

/**
 * And the read path imports nothing at all from the transaction layer, which is the structural
 * version of the same property. `live-reads.ts` needs a client and a result type; a write helper
 * appearing in its imports is how the swallow got there the first time.
 */
test("the read path imports no helper from the transaction layer", () => {
  const imports = [...codeOf(LIVE).matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]);
  assert.ok(imports.length > 2, "the imports of live-reads.ts could not be parsed");
  for (const target of imports) {
    assert.doesNotMatch(target, /genlayer\/tx$/, `${LIVE} imports from the transaction layer`);
  }
});

/**
 * Every failure reaches the reader. One catch, and it classifies as UNAVAILABLE, which is the tag
 * the page prints as "[EXTERNAL] Read failed" beside the node's own message. A catch that returned
 * anything else, or a `return undefined` anywhere in the view, would put the reader back where the
 * defect had them.
 */
test("the one view call reports every failure as a fact about the network", () => {
  const view = bodyOf(read(LIVE), "async function view<T>");

  assert.match(view, /\} catch \(error\) \{\s*\n\s*return unavailable\(error\);/, "the catch must classify as UNAVAILABLE");
  assert.equal((view.match(/catch \(/g) ?? []).length, 1, "the view has more than one catch");
  assert.doesNotMatch(view, /return undefined/, "the view discards a failure instead of reporting it");
  assert.doesNotMatch(
    view,
    /raw === undefined|raw === null|!raw\b/,
    "the view treats an absent answer as a not-found again",
  );
});

/* --- NOT_FOUND belongs to reads that were given an identifier -------------- */

/**
 * The live branch. One `notFound()`, and it is the contract's own empty dict rather than anything
 * inferred from a failure. The gap is bounded at three lines so the guard cannot drift away from
 * the thing it guards and still pass.
 */
test("the live branch produces NOT_FOUND only from the contract's empty answer", () => {
  const lines = read(LIVE).split("\n");
  const sites = lines
    .map((line, index) => ({ line, number: index + 1 }))
    .filter((entry) => /\breturn notFound\(\)/.test(entry.line));

  assert.equal(sites.length, 1, `expected one notFound() in ${LIVE}, found ${sites.length}`);

  const site = sites[0];
  assert.match(
    site.line,
    /Object\.keys\(raw\)\.length === 0/,
    `${LIVE}:${site.number} returns NOT_FOUND without the empty-dict check on the same line`,
  );
  assert.match(site.line, /isRecord\(raw\)/, "the empty-dict check must first establish it is a dict");
});

/**
 * The fixture branch, which has to obey the same rule for the same reason. Its two `notFound()`
 * calls are lookups that missed, and both sit in functions that were handed something to look up.
 * `listDeals` takes nothing and answers `available` unconditionally, so the two branches agree
 * about what an unkeyed read can say and a reviewer switching modes sees one vocabulary.
 */
test("the fixture branch produces NOT_FOUND only from a lookup that was given a key", () => {
  const gate = read(GATE);
  const lines = gate.split("\n");

  // Each notFound() site, paired with the exported function it sits in.
  let current = "";
  const sites: { fn: string; line: string }[] = [];
  for (const line of lines) {
    const declared = line.match(/^export async function (\w+)\(([^)]*)\)/);
    if (declared) current = `${declared[1]}(${declared[2]})`;
    if (/\bnotFound\(\)/.test(line)) sites.push({ fn: current, line });
  }

  assert.equal(sites.length, 2, `expected two notFound() sites in ${GATE}, found ${sites.length}`);
  for (const site of sites) {
    assert.ok(site.fn, "a notFound() sits outside any exported reader");
    const args = site.fn.slice(site.fn.indexOf("(") + 1, -1).trim();
    assert.ok(args.length > 0, `${site.fn} answers NOT_FOUND for a read that was given no identifier`);
  }

  const listDeals = bodyOf(gate, "export async function listDeals(");
  assert.doesNotMatch(listDeals, /notFound/, "listDeals can report a not-found, and it has no key to miss");
});

/**
 * The reader's sentence for NOT_FOUND says nothing failed, and that is only ever true because of
 * the two tests above. Pinned here so the claim and its precondition break together: if somebody
 * widens what may produce NOT_FOUND, this sentence becomes the lie it was, and a reviewer reading
 * this file sees why it is worded this strongly.
 */
test("the NOT_FOUND sentence claims nothing failed, which is why its sources are pinned", () => {
  const component = read("components/read-unavailable.tsx");
  assert.match(component, /Nothing is missing and nothing\s*\n?\s*failed\./);
  assert.match(component, /under that identifier/);
  assert.match(component, /\[EXTERNAL\] Read failed/, "a failed read must be printed as a failed read");
});

/**
 * The refusal component supplies the article, so no caller may bring its own.
 *
 * Another defect this file exists for, and this one reached a reader. Every sentence in
 * `read-unavailable.tsx` opens with a definite article and then interpolates the subject: "The
 * {subject} could not be read". The docs page passed `subject="the contract's own parameters"`, so
 * when StudioNet answered a read with its rate limit, the panel printed "The the contract's own
 * parameters could not be read, so this panel states nothing about it in either direction."
 *
 * It surfaced from an e2e run rather than from review, and only because the run exhausted
 * StudioNet's thirty-reads-a-minute budget and drove the branch. That is the shape of the problem
 * worth pinning: a refusal sentence is rendered exactly when something has already gone wrong, so
 * it is the least exercised prose in the build and the most closely read when it appears. Nobody
 * reads it twice on a good day.
 *
 * A floor on the number of call sites is part of the test. Without it a regex that stopped matching
 * would report zero violations across zero sites and pass, which is the same failure this file
 * describes at length in another register: a check that quietly stops checking.
 */
test("no caller doubles the article the refusal component already supplies", () => {
  const sites: { file: string; subject: string }[] = [];
  for (const rel of FILES) {
    for (const match of codeOf(rel).matchAll(/subject=(?:"([^"]*)"|\{`([^`]*)`\})/g)) {
      sites.push({ file: rel, subject: match[1] ?? match[2] });
    }
  }

  assert.ok(
    sites.length >= 5,
    `only ${sites.length} subject= call site(s) were found, so this scan is not reading the ` +
      "call sites it was written to read",
  );

  for (const site of sites) {
    assert.doesNotMatch(
      site.subject,
      /^(the|a|an)\s/i,
      `${site.file} passes subject "${site.subject}", and the component prefixes "The ", ` +
        "so the reader is shown a doubled article in a sentence about something having failed",
    );
  }
});

/* --- an unusable shape is not an absence ---------------------------------- */

/**
 * Every shape function refuses by returning null, which the view turns into INVALID_RESPONSE and
 * the page prints as `[LLM_ERROR] Answer in an unusable shape`. That is a different sentence from
 * the empty-dict path on purpose: one says the register does not carry a record, the other says
 * this build could not read what the register sent. A shape function that returned an object with
 * every field blank would collapse the two.
 */
test("an answer this build cannot read is an unusable shape rather than an absence", () => {
  const live = read(LIVE);
  const view = bodyOf(live, "async function view<T>");
  assert.match(view, /if \(value === null\) \{[\s\S]*?invalidResponse\(/, "a null shape must become INVALID_RESPONSE");
  assert.doesNotMatch(
    bodyOf(live, "async function view<T>").slice(view.indexOf("const value = shape(raw)")),
    /notFound/,
    "the shape check falls through to a not-found",
  );

  // The two unkeyed counters and the register list each refuse rather than answering blank.
  assert.match(bodyOf(live, "function toLedger("), /if \(out\.total_escrowed === ""\) return null;/);
  assert.match(bodyOf(live, "function toParameters("), /if \(out\.max_deal_value_wei === ""\) return null;/);
  assert.match(live, /if \(!Array\.isArray\(raw\)\) return null;/, "list_deals must refuse a non-list");
});

/**
 * And the union itself carries the distinction, so a page cannot render a failure through the
 * absent-record branch by accident. Four outcomes, and the two failures carry a message while the
 * absence deliberately does not: there is nothing to report about a record that simply is not there.
 */
test("the result union keeps an absence and a failure apart at the type level", () => {
  const result = read(RESULT);
  assert.match(result, /\{ kind: "NOT_FOUND" \}/, "NOT_FOUND must carry no error message");
  assert.match(result, /\{ kind: ReadFailureKind; error: string \}/, "a failure must carry its message");
  assert.match(result, /ReadFailureKind = "UNAVAILABLE" \| "INVALID_RESPONSE"/);
});
