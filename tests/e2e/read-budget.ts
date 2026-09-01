import { test } from "@playwright/test";

/**
 * Naming the one cause that makes this suite go red without anything being broken.
 *
 * StudioNet allows thirty reads a minute per client and says so by name in the error it returns:
 * `An unknown RPC error occurred. Details: Rate limit exceeded: 30 requests per minute Version:
 * viem@2.55.19`. Every route in this app is `force-dynamic` and reads the contract on each request,
 * so a full pass of this suite spends far more than thirty reads. Measured on this build: a
 * serialized run of 29 tests took four minutes and exhausted the budget twice, and the two affected
 * tests recovered on retry because the budget refills.
 *
 * The retries are the right response and they are kept. What was wrong is what the report said
 * afterwards. Playwright called those two tests `flaky` and stopped there, and `flaky` is the label
 * that gets a real regression ignored: the next person to see it has no way to tell a read budget
 * from a broken read path, and the honest answer was sitting on the failed page the whole time.
 *
 * So this reads it off the page. On a failure, and only on a failure, the rendered text is searched
 * for StudioNet's own sentence, and when it is there the cause is attached to the test result. It
 * cannot turn a red into a green: the annotation is a note, the verdict is untouched, and a budget
 * exhaustion that survives both retries still fails the run. What it removes is the guessing.
 *
 * It is also, incidentally, the strongest evidence in the suite that the read path is right. A rate
 * limit is a transport fault, and the page under it printed `[EXTERNAL] Read failed` beside the
 * node's own words rather than an empty register. That distinction is what the frontend read layer
 * exists to preserve, and this is the only place it gets exercised against a real adverse network
 * instead of a constructed one.
 */

/** The substring StudioNet puts in the error body. Matched on the numbers, not on the wrapper. */
export const READ_BUDGET_SENTENCE = "Rate limit exceeded: 30 requests per minute";

/**
 * Registers an `afterEach` that explains a failed read as a read budget when that is what it was.
 *
 * Call once at the top level of a spec file. Best effort by design: a test that failed by timing
 * out may leave no page to read, and a diagnostic that threw while explaining a failure would
 * replace a useful error with a useless one.
 *
 * The cause is recorded twice, on purpose, because the two go to different readers. The annotation
 * is structured and reaches the HTML and JSON reporters, which is what CI keeps. The printed line
 * reaches the `list` reporter, which is what a person actually watching the run sees, and which
 * shows no annotations at all. Recording it only as an annotation would have put the explanation
 * everywhere except the one place it was written to be read.
 */
export function annotateReadBudgetOnFailure(): void {
  test.afterEach(async ({ page }, testInfo) => {
    if (testInfo.status === testInfo.expectedStatus) return;

    let rendered = "";
    try {
      rendered = await page.locator("body").innerText({ timeout: 2_000 });
    } catch {
      return;
    }
    if (!rendered.includes(READ_BUDGET_SENTENCE)) return;

    const description =
      "The page printed StudioNet's rate limit, so this failure is the node declining to " +
      "answer rather than the app answering wrongly. Note what the page did with it: " +
      "[EXTERNAL] Read failed, beside the node's own sentence, which is a transport fault " +
      "reported as a transport fault. Rerun the single test rather than the file, or wait a " +
      "minute for the budget to refill.";

    testInfo.annotations.push({ type: "read budget", description });
    console.log(`\n  read budget  ${testInfo.title}\n  ${description}\n`);
  });
}
