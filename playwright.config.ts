import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end smoke tests against a running build, not against the source.
 *
 * There is deliberately no `webServer` here. What these tests prove is not that the source
 * compiles, which `npm run build` already proves, but that a served build is in live mode, is
 * pointed at the contract this commit claims, and renders a record that really exists on StudioNet.
 * That needs something serving, and it needs the contract to answer.
 *
 * ON THE DEFAULT ORIGIN, STATED PLAINLY BECAUSE IT IS WEAKER THAN IT LOOKS. Conveyance is not
 * published anywhere. This file used to default to a Vercel hostname carried over from a sibling
 * project, which does not resolve for this one, so a bare `npx playwright test` failed on DNS
 * against an origin that was never ours. The default is now the local production server, which is
 * honest about what is being tested and runs without an account anywhere.
 *
 * What a local origin proves: the built output serves, every route is live rather than fixture-
 * backed, the contract address matches `DEPLOYMENT.json`, the register renders a real StudioNet
 * deal, the form's three limits came from `parameters()`, and the wallet gates behave. What it does
 * not prove: anything about a CDN, a serverless cold start, an edge cache, or a CORS preflight from
 * a public origin. Those are properties of a deployment, and this build has none, so they are not
 * claimed. `E2E_BASE_URL` points the same suite at a real origin the day there is one. An empty
 * value is the same as an absent one, because a workflow input left blank arrives as "".
 *
 *     npx next start -p 3210
 *     npx playwright test --workers=1
 *
 * ON WORKERS AND RETRIES. StudioNet allows thirty reads a minute and every route in this app is
 * `force-dynamic`, so the suite competes with itself for a budget it can exhaust. Measured: 29
 * tests serialized took four minutes and exhausted it twice. Both affected tests recovered, because
 * the budget refills, which is what `retries` is for here. Parallel workers make it worse rather
 * than faster, so the local default is one worker. A failure caused by the budget rather than by a
 * defect is named as such in the report by `tests/e2e/read-budget.ts`, so `flaky` is never the whole
 * story a reader is left with.
 *
 * No test here sends a transaction. The injected wallet the wallet tests install answers
 * `eth_requestAccounts`, `eth_chainId` and `wallet_switchEthereumChain` and throws on everything
 * else, so a signing path cannot be reached even by accident and the suite costs no GEN however
 * often it runs.
 */
export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  // Reads go over the StudioNet RPC, whose budget this suite can exhaust on its own. A retry costs
  // a page load; a flake that gets read as a regression costs an afternoon.
  retries: 2,
  // One worker either way. Concurrency here buys nothing: the bottleneck is thirty reads a minute
  // shared across every worker, so a second worker halves each one's share and doubles the retries.
  workers: 1,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  // A cold serverless route plus a live contract read is slower than a local page.
  timeout: 90_000,
  expect: { timeout: 30_000 },
  use: {
    baseURL: process.env.E2E_BASE_URL || "http://localhost:3210",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
