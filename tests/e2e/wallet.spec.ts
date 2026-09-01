import { expect, test, type Page } from "@playwright/test";
import { expectedNetwork } from "./deployment.ts";
import { annotateReadBudgetOnFailure } from "./read-budget.ts";
import {
  emitWalletEvent,
  installWalletStub,
  STUB_ACCOUNT,
  STUDIONET_CHAIN_HEX,
  WRONG_CHAIN_HEX,
} from "./wallet-stub.ts";

/**
 * What a served build does when a wallet behaves like a wallet.
 *
 * A person switches account, revokes the site, switches network, or the extension drops the
 * connection, and each of those changes whether a signature may be requested. These tests drive
 * all of those against a running build and read what the running head then says, because the
 * failure worth catching is a page that still says StudioNet while the wallet is somewhere else.
 *
 * This is also where the network this build targets gets proven. The footer's explorer link is
 * built from a fixed explorer origin and so cannot say which chain the build writes to; the
 * running head's network label and the write gate's refusal both can, and both are checked
 * against `DEPLOYMENT.json` rather than against a literal.
 *
 * NOTHING HERE IS CLICKED THAT COULD SIGN. This is an escrow interface, and the one control in
 * it that sends value is disabled until a rehearsal has run, so it is never reachable from these
 * tests at all. What is read instead is the gate itself, which `WritePanel` prints above every
 * write control whenever a write cannot be signed. That the gate is also enforced one layer
 * lower, inside `getWriteClient`, is a pure function and is tested as one in `tests/frontend`.
 * The stub implements three read methods and throws `-32601` on everything else, so this suite
 * costs no GEN however often anyone runs it.
 */

/** `/deals/new` is the stage: it carries the write gate on the page without anything being pressed. */
const FORM = "/deals/new";

// The gates are pure client state, but the pages carrying them read the contract on every request,
// so a failure here can still be StudioNet declining rather than a gate misbehaving.
annotateReadBudgetOnFailure();

const SECOND_ACCOUNT = "0x1111111111111111111111111111111111111111";

/** As the running head abbreviates them, mirroring `shortenHex`'s defaults of 10 and 6. */
const shorten = (address: string) => `${address.slice(0, 10)}…${address.slice(-6)}`;
const STUB_SHORT = shorten(STUB_ACCOUNT);
const SECOND_SHORT = shorten(SECOND_ACCOUNT);

/** The same two numbers the stub reports, written once. */
const EXPECTED_CHAIN = Number.parseInt(STUDIONET_CHAIN_HEX, 16);
const WRONG_CHAIN = Number.parseInt(WRONG_CHAIN_HEX, 16);

/** `networkLabel`'s two answers. Never the first one while the wallet is elsewhere. */
const NETWORK_EXPECTED = `${expectedNetwork} · chain ${EXPECTED_CHAIN}`;
const NETWORK_WRONG = `chain ${WRONG_CHAIN}, and this build writes to chain ${EXPECTED_CHAIN}`;

/** The three things `walletGate` can say, in the order a session reaches them. */
const GATE_NO_EXTENSION =
  "No wallet extension was detected in this browser, so there is nothing to sign with.";
const GATE_CONNECT_FIRST = "Connect a wallet first.";
const GATE_WRONG_CHAIN = `The wallet is on chain ${WRONG_CHAIN} and this build writes to chain ${EXPECTED_CHAIN}.`;

/**
 * The full sentence a refused `wallet_switchEthereumChain` produces, assembled from the stub's
 * own 4902 message so the two cannot drift apart.
 */
const SWITCH_REFUSAL =
  `This wallet would not switch to ${expectedNetwork} (chain ${EXPECTED_CHAIN}): ` +
  "Unrecognized chain ID. Try adding the chain first. " +
  "Add the network in the wallet itself, then connect again.";

/** Every gate string absent. The state a connected wallet on this build's chain should reach. */
async function expectNoGate(page: Page) {
  for (const gate of [GATE_NO_EXTENSION, GATE_CONNECT_FIRST, GATE_WRONG_CHAIN]) {
    await expect(page.getByText(gate), `the gate should not say "${gate}"`).toHaveCount(0);
  }
}

async function connect(page: Page, path = FORM) {
  await page.goto(path);
  await page.getByRole("button", { name: "Connect wallet" }).click();
  await expect(page.getByRole("button", { name: "Disconnect wallet" })).toBeVisible();
}

test.describe("with no wallet extension at all", () => {
  test("the head offers to connect, and says reading still works", async ({ page }) => {
    await page.goto(FORM);
    await expect(page.getByRole("button", { name: "Connect wallet" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Disconnect wallet" })).toHaveCount(0);
    await expect(
      page.getByText("No injected wallet was found in this browser. Every page here still reads."),
    ).toBeVisible();

    // And every write control on the page says which of the two problems it has. "Connect a
    // wallet first" would be useless advice in a browser with nothing to connect.
    await expect(page.getByText(GATE_NO_EXTENSION).first()).toBeVisible();
    await expect(page.getByText(GATE_CONNECT_FIRST)).toHaveCount(0);
  });

  test("pressing connect with nothing to connect to is reported, not swallowed", async ({
    page,
  }) => {
    await page.goto(FORM);
    await page.getByRole("button", { name: "Connect wallet" }).click();

    // The refusal replaces the standing note, so the reading reassurance is gone and what is
    // left is the reason the attempt failed.
    await expect(page.getByText("Every page here still reads.")).toHaveCount(0);
    await expect(
      page.getByText("No injected wallet was found in this browser.").first(),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Connect wallet" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Disconnect wallet" })).toHaveCount(0);
  });
});

test.describe("a wallet on this build's chain", () => {
  test.beforeEach(async ({ page }) => {
    await installWalletStub(page, { chainId: STUDIONET_CHAIN_HEX });
  });

  test("a page load is not consent, and the gate names the missing step", async ({ page }) => {
    await page.goto(FORM);
    // A provider exists, so the advice changes from "there is nothing to sign with" to
    // "connect one". Nothing has been connected, because nothing asked.
    await expect(page.getByText(GATE_CONNECT_FIRST).first()).toBeVisible();
    await expect(page.getByText(GATE_NO_EXTENSION)).toHaveCount(0);
    await expect(page.getByText(STUB_SHORT)).toHaveCount(0);
  });

  test("connecting shows the account and the network it is really on", async ({ page }) => {
    await connect(page);

    // The network name is built from `DEPLOYMENT.json`, so this fails if the deployed build is
    // pointed somewhere other than the network this commit claims.
    await expect(page.getByText(NETWORK_EXPECTED)).toBeVisible();
    await expect(page.getByText(STUB_SHORT)).toBeVisible();

    // Writes are open, so there is nothing to switch and nothing to warn about.
    await expect(page.getByRole("button", { name: "Switch network" })).toHaveCount(0);
    await expectNoGate(page);
  });

  test("switching account changes who would sign", async ({ page }) => {
    await connect(page);
    await expect(page.getByText(STUB_SHORT)).toBeVisible();

    await emitWalletEvent(page, "accountsChanged", [SECOND_ACCOUNT]);
    await expect(page.getByText(SECOND_SHORT)).toBeVisible();
    await expect(page.getByText(STUB_SHORT)).toHaveCount(0);
    // Same network, so still signable.
    await expect(page.getByText(NETWORK_EXPECTED)).toBeVisible();
    await expectNoGate(page);
  });

  test("revoking the account ends the session and shuts the gate again", async ({ page }) => {
    await connect(page);
    await emitWalletEvent(page, "accountsChanged", []);

    await expect(page.getByRole("button", { name: "Connect wallet" })).toBeVisible();
    await expect(page.getByText(STUB_SHORT)).toHaveCount(0);
    await expect(page.getByText(NETWORK_EXPECTED)).toHaveCount(0);
    // A wallet is still installed, so this is the gate that says so.
    await expect(page.getByText(GATE_CONNECT_FIRST).first()).toBeVisible();
  });

  test("the provider disconnecting does not leave a stale session looking live", async ({
    page,
  }) => {
    await connect(page);
    await emitWalletEvent(page, "disconnect", { message: "the extension was locked" });

    await expect(page.getByRole("button", { name: "Connect wallet" })).toBeVisible();
    await expect(page.getByText(STUB_SHORT)).toHaveCount(0);
    await expect(page.getByText(NETWORK_EXPECTED)).toHaveCount(0);
    await expect(page.getByText(GATE_CONNECT_FIRST).first()).toBeVisible();
  });

  test("disconnecting from the head forgets the session", async ({ page }) => {
    await connect(page);
    await page.getByRole("button", { name: "Disconnect wallet" }).click();

    await expect(page.getByRole("button", { name: "Connect wallet" })).toBeVisible();
    await expect(page.getByText(STUB_SHORT)).toHaveCount(0);
    await expect(page.getByText(NETWORK_EXPECTED)).toHaveCount(0);
  });
});

test.describe("a wallet that moves off this build's chain mid-session", () => {
  test("the head names the chain the wallet is on, and the gate shuts", async ({ page }) => {
    await installWalletStub(page, {
      chainId: STUDIONET_CHAIN_HEX,
      switchOutcome: "accept",
    });
    await connect(page);
    await expect(page.getByText(NETWORK_EXPECTED)).toBeVisible();

    await emitWalletEvent(page, "chainChanged", WRONG_CHAIN_HEX);

    // Never this build's network label while the wallet is elsewhere. That is the whole point
    // of `networkLabel` reporting what the wallet said rather than what the build wants.
    await expect(page.getByText(NETWORK_WRONG)).toBeVisible();
    await expect(page.getByText(NETWORK_EXPECTED)).toHaveCount(0);

    // And the write is held back before anything is signed, with the chain named in the refusal
    // rather than a generic "wrong network".
    await expect(page.getByText(GATE_WRONG_CHAIN).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Switch network" })).toBeVisible();
    // Still connected. A wallet on another chain is a wallet, not a dropped session.
    await expect(page.getByText(STUB_SHORT)).toBeVisible();
    await expect(page.getByRole("button", { name: "Disconnect wallet" })).toBeVisible();
  });

  test("switching back reopens the gate", async ({ page }) => {
    await installWalletStub(page, {
      chainId: STUDIONET_CHAIN_HEX,
      switchOutcome: "accept",
    });
    await connect(page);
    await emitWalletEvent(page, "chainChanged", WRONG_CHAIN_HEX);
    await expect(page.getByRole("button", { name: "Switch network" })).toBeVisible();

    await page.getByRole("button", { name: "Switch network" }).click();

    await expect(page.getByText(NETWORK_EXPECTED)).toBeVisible();
    await expect(page.getByRole("button", { name: "Switch network" })).toHaveCount(0);
    await expectNoGate(page);
  });
});

test.describe("a wallet on the wrong chain at connect time", () => {
  test("a refused network switch is reported in full, and the gate stays shut", async ({
    page,
  }) => {
    // The common real case: the wallet has never had this network added, so it answers
    // `wallet_switchEthereumChain` with 4902 rather than moving. The app asks exactly once.
    await installWalletStub(page, { chainId: WRONG_CHAIN_HEX, switchOutcome: "reject" });
    await connect(page);

    await expect(page.getByText(NETWORK_WRONG)).toBeVisible();
    await expect(page.getByText(NETWORK_EXPECTED)).toHaveCount(0);

    // The wallet's own words, kept verbatim, with the next step after them. A paraphrased
    // wallet message is a message nobody can search for.
    await expect(page.getByText(SWITCH_REFUSAL)).toBeVisible();
    await expect(page.getByText(GATE_WRONG_CHAIN).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Switch network" })).toBeVisible();
  });
});

test.describe("a wallet that refuses", () => {
  test("a declined connection is reported as a decision, not as a fault", async ({ page }) => {
    await installWalletStub(page, { rejectConnection: true });
    await page.goto(FORM);
    await page.getByRole("button", { name: "Connect wallet" }).click();

    await expect(page.getByText("The wallet declined the request. Nothing was sent.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Connect wallet" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Disconnect wallet" })).toHaveCount(0);
    await expect(page.getByText(NETWORK_EXPECTED)).toHaveCount(0);
  });

  test("a wallet that offers no account is not treated as connected", async ({ page }) => {
    await installWalletStub(page, { returnNoAccounts: true });
    await page.goto(FORM);
    await page.getByRole("button", { name: "Connect wallet" }).click();

    await expect(page.getByText("The wallet returned no account.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Disconnect wallet" })).toHaveCount(0);
    await expect(page.getByText(NETWORK_EXPECTED)).toHaveCount(0);
  });
});

test("no key is generated or stored, on any route", async ({ page }) => {
  // The architectural guarantee, checked where it can actually be observed: an injected wallet
  // is the only signer, there is no chooser panel because there is nothing to choose between,
  // and a page load must therefore leave no key material behind and connect nothing by itself.
  await installWalletStub(page, { chainId: STUDIONET_CHAIN_HEX });
  for (const path of ["/", "/deals", FORM, "/docs"]) {
    await page.goto(path);
    await expect(page.getByRole("button", { name: "Connect wallet" })).toBeVisible();
    await expect(page.getByText(STUB_SHORT)).toHaveCount(0);

    const stored = await page.evaluate(() => ({
      local: Object.entries({ ...localStorage }),
      session: Object.entries({ ...sessionStorage }),
    }));
    for (const [key, value] of [...stored.local, ...stored.session]) {
      expect(`${key} ${value}`, `${path} stored something key-shaped`).not.toMatch(
        /0x[0-9a-fA-F]{64}|privateKey|mnemonic|keystore/i,
      );
    }
  }
});
