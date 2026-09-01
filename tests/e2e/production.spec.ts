import { expect, test, type Page } from "@playwright/test";
import { addressIn, expectedContract, expectedNetwork } from "./deployment.ts";
import { annotateReadBudgetOnFailure } from "./read-budget.ts";

/**
 * A served build, read the way a reviewer would read it.
 *
 * Every assertion here is about something that can only be wrong in a running build: whether the
 * origin serves live contract state or the bundled fixture set, whether it is pointed at the
 * contract this commit claims, whether a deal that exists on StudioNet actually renders, and
 * whether the three figures the offer form refuses to invent were really read from `parameters()`.
 * Compiling proves none of those.
 *
 * The origin is whatever `E2E_BASE_URL` names, defaulting to a local `next start`. Conveyance is
 * not published anywhere, and `playwright.config.ts` says which of these properties a local origin
 * therefore cannot reach.
 *
 * These tests only read. No wallet is installed in this file, and the one write control it
 * touches is touched to prove it is closed: the lodge button is the single control in this
 * interface that sends value, and until a rehearsal has run it is disabled with the reason
 * printed beside it. The wallet gates proper are exercised in `wallet.spec.ts`.
 *
 * ON CASING. Playwright's text engines read the DOM's own text, so `getByText` and `:text()`
 * see the source string. `allInnerTexts()` reads `innerText`, which applies `text-transform`,
 * and `.cv-legend` is uppercased, so every label compared through `allInnerTexts()` is
 * case-folded first. Asserting the source casing there would be asserting a CSS rule.
 */

const ROUTES = ["/", "/deals", "/deals/new", "/docs"];

// Every test in this file reads the contract, so every failure here has two candidate causes and
// only one of them is a defect. See `read-budget.ts`.
annotateReadBudgetOnFailure();

/**
 * A register row. `/deals/new` is excluded because the running head links it on every page and
 * the register links it again, and neither is a deal.
 */
const REGISTER_LINK = 'a[href^="/deals/"]:not([href="/deals/new"])';

/** The provenance strip prints exactly one of these three, on every page, above the content. */
const LIVE_LINE = "Every figure on this page was read from the deployed contract on";
const FIXTURE_LINE = "Bundled fixtures, not a deployed contract.";
const MISCONFIGURED_LINE = "This build was asked for live data and no contract address is set";

/**
 * The three ways a read can fail, each named on the page. Their absence is the assertion, and
 * they are checked separately rather than as one regex because they mean different things: a
 * failed transport, an unusable answer, and a record the register does not carry.
 */
const READ_FAILURES = [
  "[EXTERNAL] Read failed",
  "[LLM_ERROR] Answer in an unusable shape",
  "No such record",
];

async function expectNoReadFailures(page: Page, where: string) {
  for (const sentinel of READ_FAILURES) {
    await expect(page.getByText(sentinel), `${where} should not print "${sentinel}"`).toHaveCount(0);
  }
}

type Entry = { id: string; domain: string };

/**
 * Opens the first deal the register links to and returns its id and the domain it was lodged
 * under, both read off the page rather than hardcoded, so the suite follows a redeployment
 * instead of asserting against a dead one.
 */
async function openFirstDeal(page: Page): Promise<Entry> {
  await page.goto("/deals");
  const link = page.locator(REGISTER_LINK).first();
  const href = await link.getAttribute("href");
  expect(href, "a deal should be linked from the register").toBeTruthy();
  const id = (href as string).split("/").pop() as string;

  await page.goto(href as string);
  await expect(page.getByText("register entry").first()).toBeVisible();

  // The heading is the domain the deal was lodged under, in full.
  const domain = (await page.getByRole("heading", { level: 1 }).innerText()).trim();
  expect(domain, "the deal should print its domain").not.toBe("");
  return { id, domain };
}

test.describe("every route serves live contract state", () => {
  for (const path of ROUTES) {
    test(`${path} loads in live mode against the deployed contract`, async ({ page }) => {
      const response = await page.goto(path);
      expect(response?.status(), `${path} should be served`).toBe(200);

      // Live, not fixtures, and not misconfigured. The strip prints one of the three and
      // never two, so the other two are asserted absent rather than merely unlooked-for.
      await expect(page.getByText(LIVE_LINE)).toBeVisible();
      await expect(page.getByText(FIXTURE_LINE)).toHaveCount(0);
      await expect(page.getByText(MISCONFIGURED_LINE)).toHaveCount(0);

      // The chain the site says it is on is the chain this commit deployed to. Built from
      // `DEPLOYMENT.json` rather than written out, so a redeployment to a different network
      // fails here instead of passing quietly.
      await expect(page.getByText(`${expectedNetwork} · live`)).toBeVisible();

      // And pointed at this commit's contract. The footer prints an abbreviation, so the
      // full address is taken from the link it wraps and compared as bytes rather than as
      // whatever casing the deployment's environment happens to hold.
      const href = await page.locator('footer a[href*="/address/"]').getAttribute("href");
      expect(addressIn(href), `${path} should link ${expectedContract}`).toBe(expectedContract);
    });
  }
});

/**
 * The value cell of one summary figure, addressed through its own legend.
 *
 * `Stat` renders the label as `<p class="cv-legend">` immediately followed by the value in a
 * `<p class="cv-record">`, so the value is the legend's next sibling. The legend is matched on its
 * whole text rather than on a substring, because `:text()` matches any element containing the
 * string and several of these labels are also ordinary words in the prose around them. Written the
 * loose way, `p:text("closed") + p` resolved to the figure AND to a sentence beginning "Nothing has
 * closed yet", and the assertion failed on a page that was entirely correct.
 */
const statValue = (page: Page, label: string) =>
  page.locator(`p.cv-legend:text-is("${label}") + p`);

test.describe("the plate", () => {
  test("states the claim and the boundary around it", async ({ page }) => {
    await page.goto("/");
    await expect(
      page.getByRole("heading", {
        name: "The money moves when the registry says the domain did.",
      }),
    ).toBeVisible();
    for (const heading of [
      "What it decides",
      "What it does not decide",
      "The three conditions",
      "The register in figures",
      "Most recent entries",
      "Before you lodge anything",
    ]) {
      await expect(page.getByRole("heading", { name: heading })).toBeVisible();
    }
    await expect(page.getByRole("heading", { name: "The windows" })).toBeVisible();
    await expectNoReadFailures(page, "the plate");
  });

  test("the figures are the contract's own, and they reconcile or say they do not", async ({
    page,
  }) => {
    await page.goto("/");

    // `ledger()` answered. Each of these is a figure, not a shrug: `formatGen` prints
    // "not reported" for an empty field, which would fail the pattern.
    for (const label of ["taken into escrow", "paid to sellers", "returned to buyers", "still held"]) {
      await expect(statValue(page, label), `${label} should print a sum`).toHaveText(
        /^\d[\d,.]* GEN$/,
      );
    }
    for (const label of ["offers lodged", "checks run by anyone", "deliveries verified"]) {
      await expect(statValue(page, label), `${label} should print a count`).toHaveText(/^[\d,]+$/);
    }

    // Held against the contract's own balance. Whether they agree is chain state and not
    // something this suite may decide, so what is asserted is that the page reached a stated
    // reconciliation rather than that it reached the comfortable one.
    await expect(page.getByText("Held and balance")).toBeVisible();
    await expect(page.getByText("Reversals recorded:")).toBeVisible();
  });

  test("the recent entries are deals the contract carries", async ({ page }) => {
    await page.goto("/");
    // The preview renders through the same row component as the register, so a row here is a
    // decoded deal and not a placeholder.
    await expect(page.locator(REGISTER_LINK).first()).toBeVisible();
    expect(await page.locator(REGISTER_LINK).count()).toBeGreaterThan(0);
    await expect(
      page.getByText("The register carries no entries yet."),
      "the deployment should carry at least one deal for this suite to read",
    ).toHaveCount(0);
    await expect(page.getByRole("link", { name: "the whole register" })).toBeVisible();
  });
});

test.describe("the register", () => {
  test("lists deals read from the contract", async ({ page }) => {
    await page.goto("/deals");
    await expect(page.getByRole("heading", { name: "Deals", exact: true })).toBeVisible();
    for (const heading of [
      "What each state means for the money",
      "What the last check column can say",
    ]) {
      await expect(page.getByRole("heading", { name: heading })).toBeVisible();
    }
    await expect(page.locator(REGISTER_LINK).first()).toBeVisible();
    expect(await page.locator(REGISTER_LINK).count()).toBeGreaterThan(0);
    await expectNoReadFailures(page, "the register");

    // The four summary figures, each a count or a sum rather than a dash.
    await expect(statValue(page, "sum held")).toHaveText(/^\d[\d,.]* GEN$/);
    for (const label of ["in escrow", "closed"]) {
      await expect(statValue(page, label), `${label} should print a count`).toHaveText(/^[\d,]+$/);
    }

    // The reversal count is the one figure allowed to be a word, and this assertion was wrong
    // before it was right. A register prints an absent value in words rather than as a digit that
    // could be misread, and a count of zero reversals is the figure most worth being unambiguous
    // about, so the page prints "none". Requiring a digit here would have been requiring that some
    // domain had been taken back by its registry, which is a result and not something a smoke test
    // may demand. Both forms are accepted; neither is invented.
    await expect(statValue(page, "taken back by the registry")).toHaveText(/^(none|[\d,]+)$/);
  });

  test("a StudioNet deal renders its whole record", async ({ page }) => {
    const { id } = await openFirstDeal(page);

    // The id the deal was lodged under, printed as the entry's own header.
    await expect(page.getByText(id, { exact: true }).first()).toBeVisible();

    // These are contract fields. Their presence is what proves a stored deal was read and
    // decoded rather than a shell rendered. Case-folded, because `.cv-legend` uppercases and
    // `allInnerTexts` reflects that.
    const labels = (await page.locator("dt").allInnerTexts()).map((label) =>
      label.trim().toUpperCase(),
    );
    for (const field of [
      "deal",
      "domain",
      "buyer",
      "seller",
      "consideration held",
      "registrar required",
      "delegation required",
      "buyer's commitment",
      "offer lodged",
      "paid to the seller",
      "returned to the buyer",
    ]) {
      expect(labels, `the record should print ${field}`).toContain(field.toUpperCase());
    }

    // A state stamp, whichever one chain state produced. Asserting a particular state here
    // would be asserting a result. `.first()` because a check outcome shares two of these
    // words and is stamped in the same style.
    await expect(
      page.getByText(/^(Offered|Locked|Verified|Reversed|Released|Refunded)$/).first(),
    ).toBeVisible();

    // Both evidence panels rendered, and the controls section knows which state it is in.
    for (const heading of [
      "The last check",
      "The evidence",
      "The terms, as lodged",
      "The two records this deal turns on",
      "Every instant on the record",
      "What can be called from here",
    ]) {
      await expect(page.getByRole("heading", { name: heading })).toBeVisible();
    }
    await expect(page.getByRole("link", { name: "back to the register" }).first()).toBeVisible();
    await expectNoReadFailures(page, `deal ${id}`);
  });

  test("a deal id nobody lodged is an absent record, not an invented one", async ({ page }) => {
    await page.goto("/deals/cv-e2e-was-never-lodged");

    // `get_deal` raises on an unknown id, and the page has two honest answers for that: the
    // register does not carry it, or the read failed. Which one appears depends on what the
    // node returned, so what is asserted is that one of them did and that nothing was filled
    // in from memory.
    const absent = await page.getByText("No such record").count();
    const failed = await page.getByText("[EXTERNAL] Read failed").count();
    expect(
      absent + failed,
      "an unknown deal id should be refused rather than rendered",
    ).toBeGreaterThan(0);

    // The invariant underneath, whichever of the two it was: no record was invented, so there
    // is no domain heading, no sum and no controls.
    await expect(page.getByRole("heading", { name: "The terms, as lodged" })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "What can be called from here" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "back to the register" })).toBeVisible();
  });

  test("a GEN amount prints its unit exactly once", async ({ page }) => {
    // A regression guard with a real defect behind it. `formatGen` returns a string that
    // already ends in the unit, and six call sites had appended a second one, so the page
    // printed "100 GEN GEN" and a missing ceiling printed "not reported GEN". React splits
    // adjacent text nodes with comments, so this is checked against rendered text rather
    // than against HTML source.
    const { id } = await openFirstDeal(page);
    for (const path of [`/deals/${id}`, "/deals", "/deals/new", "/docs", "/"]) {
      await page.goto(path);
      const text = await page.locator("body").innerText();
      expect(text, `${path} should not print the unit twice`).not.toMatch(/GEN\s+GEN/);
      expect(text, `${path} should not print a unit after "not reported"`).not.toMatch(
        /not reported GEN/i,
      );
    }
  });
});

test.describe("the offer form", () => {
  test("reads its limits from the contract rather than carrying them", async ({ page }) => {
    await page.goto("/deals/new");
    await expect(page.getByRole("heading", { name: "Lodge an offer" })).toBeVisible();

    // This line renders only when `parameters()` answered with a ceiling. Its presence is the
    // proof that the figure came from the deployment and not from this repository, and the
    // pattern rules out the "not reported" that an empty field would print.
    await expect(page.getByText("This deployment escrows at most")).toHaveText(
      /This deployment escrows at most \d[\d,.]* GEN, read from the contract\./,
    );

    // Every field the offer is built from that a reader can reach with no wallet installed.
    for (const id of [
      "offer-domain",
      "offer-id",
      "offer-seller",
      "offer-registrar",
      "offer-nameservers",
      "offer-price",
    ]) {
      await expect(page.locator(`#${id}`), `${id} should be on the form`).toBeVisible();
    }
    await expect(page.getByRole("button", { name: "Generate a secret" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Rehearse these terms" })).toBeVisible();

    /**
     * `#offer-passphrase` is deliberately not in that list. The encrypted-keepsake field renders
     * only once a secret exists AND a wallet has reported an address, because the buyer's token is
     * bound to the address that lodges the offer and cannot be built from an address that is not
     * yet known. This file installs no wallet, so asserting that field here would have been
     * asserting that a gate is open when the whole point of the gate is that it is shut. What is
     * asserted instead is that the page says why, in place of the panel.
     */
    await expect(page.getByText("Connect the wallet that will send this call first.")).toBeVisible();
    await expect(page.locator("#offer-passphrase")).toHaveCount(0);
    await expectNoReadFailures(page, "the offer form");
  });

  test("the one control that sends value is closed until the terms have been rehearsed", async ({
    page,
  }) => {
    // Reached with no wallet at all, and nothing here requests a signature. The point is the
    // shape of the refusal: the button is disabled and the reason is printed beside it, which
    // is the only place in this interface where a control is disabled rather than pressable.
    await page.goto("/deals/new");
    const lodge = page.getByRole("button", { name: /^Lodge the offer and escrow/ });
    await expect(lodge).toBeVisible();
    await expect(lodge).toBeDisabled();
    await expect(
      page.getByText(
        "Rehearse the terms first. This is the one control in this interface that sends value, and it is not offered on terms the contract has not seen.",
      ),
    ).toBeVisible();

    // And the validators' program is stated before anything is fetched, by source name. The legend
    // belongs to the write panel, and `/deals/new` carries one panel per call it can make, so it
    // appears once per panel by design. `.first()` rather than a count, because pinning the number
    // of panels would make this test a layout assertion.
    await expect(page.getByText("what the validators fetch").first()).toBeVisible();
  });
});

test.describe("the instrument", () => {
  test("covers the money, the calls, the states and the refusals", async ({ page }) => {
    await page.goto("/docs");
    await expect(
      page.getByRole("heading", { name: "What this contract is bound to do" }),
    ).toBeVisible();
    for (const heading of [
      "What the money is held against",
      "There is no model in this contract",
      "Why a proof is read twice",
      "The seven calls, and who may make them",
      "What can be called from each state",
      "The four things a refusal can mean",
      "What the contract reports about itself",
      "Where this instrument does not reach",
    ]) {
      await expect(page.getByRole("heading", { name: heading })).toBeVisible();
    }
    await expectNoReadFailures(page, "the instrument");
  });

  test("the no-model claim is the deployment's own answer, not the page's", async ({ page }) => {
    await page.goto("/docs");

    // The heading two sections up says there is no model in this contract. This row is the
    // deployed contract agreeing, through `parameters()`, so the claim is checkable rather
    // than asserted. A build that could not reach the contract prints a refusal row here
    // instead, and that would fail this.
    await expect(page.locator('dt:text("runs a model") + dd > .cv-record')).toHaveText("false");

    // The other two self-reported figures, in the same row shape.
    await expect(page.locator('dt:text("largest escrow") + dd > .cv-record')).toHaveText(
      /^\d[\d,.]* GEN$/,
    );
    await expect(page.locator('dt:text("embedded functions") + dd > .cv-record')).toHaveText(
      /^\d+$/,
    );

    // And the registry directory is a URL the validators fetch, not a hardcoded registry list.
    await expect(page.locator('dt:text("registry directory") + dd > .cv-record')).toHaveText(
      /^https:\/\/\S+$/,
    );
  });
});
