/**
 * Re-checks a StudioNet exercise from its transaction hashes, and asserts what each one meant.
 *
 * WHY THIS EXISTS RATHER THAN A TRANSCRIPT. A capture of CLI output proves that a command was run.
 * It does not prove the command did what the surrounding prose claims, and it goes stale silently:
 * a hash stays a hash after the contract behind it is replaced. This script takes the hashes, reads
 * them back off the chain, and fails if any one of them no longer says what the evidence file says
 * it says. Everything it prints is read at run time from the endpoint in `.env.local`.
 *
 * WHY THE LABELS ARE PART OF THE ARGUMENT. Each hash is passed as `label=0xhash`, and every label
 * carries its own expectation: which of the three leader outcomes it must have, which words must
 * appear in what it returned, and for the one funded refusal, that the escrow was handed back. A
 * bare list of hashes could only assert that they all finalized, which is the one thing about them
 * that was never in doubt.
 *
 * THE THREE OUTCOMES, AND WHY A BOOLEAN CANNOT HOLD THEM. GenVM reports a refusal three different
 * ways on this contract and only one of them is an error:
 *
 *   return          `execution_result: SUCCESS`, `result.status === "return"`. Either a deal opened
 *                   or `open_deal` refused. It is the payable method, so it refuses by refunding
 *                   `gl.message.value` and returning its tagged reason rather than by raising,
 *                   because StudioNet does not give back the value that arrived when an execution
 *                   reverts. A reverting payable refusal would keep the escrow of a caller it had
 *                   just turned down, which is what the second deployment did.
 *   rollback        `execution_result: ERROR`, `result.status === "rollback"`, and `result.payload`
 *                   is the tagged message as a plain string. This is how the eleven non-payable
 *                   methods refuse. Storage is rolled back and the tag survives.
 *   contract_error  `execution_result: ERROR`, `result.status === "contract_error"`, payload
 *                   `exit_code 1`. Something crashed. There is no tag, because no rule fired.
 *
 * Note that `rollback` and `contract_error` share an `execution_result`. Reading only
 * `execution_result` cannot tell a rule firing from a crash, so nothing here does: every assertion
 * goes through `result.status`. The `arityError` label exists to hold that distinction still. It is
 * a deliberately malformed call, and the script asserts it crashed AND that it carries no tag, so
 * that a future change which started tagging crashes would fail here rather than quietly turn every
 * bug into a verdict on screen.
 *
 * WHY THE VALUE INVARIANT IS ONLY CHECKED AT THE END. `_decline` refunds through a receipt message
 * with `onAcceptance: false`, which means the transfer is dispatched at FINALIZED and not at
 * ACCEPTED. Read six seconds after a funded refusal, `ledger()` shows `balance` exceeding `held` by
 * exactly the refunded amount, which is the same shape as the stranding defect this contract was
 * redeployed to fix. It is not that defect; it is the refund in flight. So `balance == held` is
 * asserted once, after every hash has been polled to FINALIZED, and never before.
 *
 * Usage:
 *   node scripts/exercise-studionet.mjs open1=0x… open2=0x… zeroControl=0x… fundedRefusal=0x… \
 *     arm=0x… settle=0x… refund=0x… checkTransfer=0x… arityError=0x…
 *
 * Any subset may be passed; only the labels given are checked. Reads always run.
 */

import { createAccount, createClient } from "genlayer-js";
import { studionet } from "genlayer-js/chains";
import { existsSync, readFileSync } from "node:fs";

if (existsSync(".env.local")) {
  for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const [key, ...value] = trimmed.split("=");
    process.env[key] ??= value.join("=");
  }
}

const RPC_GAP_MS = 4_500; // At most 13 requests/minute, below the submission limit.
const POLL_MS = 5_000;

const DEAL_ONE = "cv-demo-example-com-1";
const DEAL_TWO = "cv-demo-example-net-1";
const SELLER = "0xac3ac69dc0bde389256dd6748c75817ead9286d9";
const ESCROW_ONE = "250000000000000000";
const ESCROW_TWO = "50000000000000000";
const REFUSAL_VALUE = "50000000000000000";
const HELD_TOTAL = "300000000000000000";

/**
 * What each labelled hash has to turn out to have been.
 *
 * `outcome` is the leader's `result.status`. `says` are fragments that must all appear in what the
 * call returned; they are fragments rather than whole strings because two of these messages carry a
 * deadline computed at submission time, and pinning a timestamp would make this script expire.
 * `refunds` marks the one call that must carry a value-bearing receipt message.
 */
const EXPECTATIONS = {
  open1: {
    outcome: "return",
    says: [`${DEAL_ONE} OFFERED`, `${ESCROW_ONE} wei escrowed on example.com`, `v1;deal=${DEAL_ONE};seller=${SELLER}`],
    note: "the first deal opened, and its return string carries the token the seller has to publish",
  },
  open2: {
    outcome: "return",
    says: [`${DEAL_TWO} OFFERED`, `${ESCROW_TWO} wei escrowed on example.net`, `v1;deal=${DEAL_TWO};seller=${SELLER}`],
    note: "the second deal opened on a different registry, so the two RDAP bases are both exercised",
  },
  zeroControl: {
    outcome: "return",
    says: ["[EXPECTED] a deal needs an escrow; this call carried no value"],
    note: "a payable method refusing with no value attached returns rather than reverting",
  },
  fundedRefusal: {
    outcome: "return",
    says: [`[EXPECTED] deal '${DEAL_ONE}' already exists`],
    refunds: REFUSAL_VALUE,
    note: "the refund proof: a funded call was refused and the escrow was handed straight back",
  },
  arm: {
    outcome: "rollback",
    says: [`[EXPECTED] only the named seller can arm deal ${DEAL_ONE}`],
    note: "a non-payable refusal reverts, and the tag survives the revert",
  },
  settle: {
    outcome: "rollback",
    says: [`[EXPECTED] deal ${DEAL_ONE} is OFFERED; settle() needs VERIFIED`],
    note: "settlement is gated on the state machine and not on who is asking",
  },
  refund: {
    outcome: "rollback",
    says: ["[EXPECTED] the seller has until", `to arm deal ${DEAL_ONE}`],
    note: "the escrow cannot be pulled back before the acceptance window closes",
  },
  checkTransfer: {
    outcome: "rollback",
    says: [`[EXPECTED] deal ${DEAL_ONE} is OFFERED; check_transfer() needs LOCKED or VERIFIED`],
    note: "a check on an unarmed deal is refused before any network call is made",
  },
  arityError: {
    outcome: "contract_error",
    says: ["exit_code"],
    untagged: true,
    note: "the control: a malformed call crashes, and a crash carries no tag because no rule fired",
  },
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isRateLimit = (error) => /429|rate.?limit|-32429|-32028/i.test(String(error?.message ?? error));

async function rpc(label, action, attempts = 6) {
  let delay = RPC_GAP_MS;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const value = await action();
      await sleep(RPC_GAP_MS);
      return value;
    } catch (error) {
      if (!isRateLimit(error) || attempt === attempts) throw error;
      console.error(`${label}: StudioNet rate limit, retry ${attempt}/${attempts} in ${delay}ms`);
      await sleep(delay);
      delay = Math.min(delay * 2, 40_000);
    }
  }
  throw new Error(`${label}: retry budget exhausted`);
}

const statusName = (tx) => tx?.statusName ?? tx?.status_name ?? tx?.status;

/**
 * The leader's outcome, and the string it returned, whichever of the two shapes it came in.
 *
 * A `return` carries `payload.readable`, which is the value JSON-encoded, so a returned string
 * arrives wrapped in quotes and has to be parsed back out. A `rollback` carries the message as a
 * plain string in `payload`. Both are reduced to one `said` field here so that no assertion below
 * has to know which shape it is looking at.
 */
function leaderOutcome(tx) {
  const leader = tx?.consensus_data?.leader_receipt?.[0];
  const result = leader?.result ?? {};
  const payload = result.payload;
  let said = "";
  if (payload && typeof payload === "object" && typeof payload.readable === "string") {
    try {
      const parsed = JSON.parse(payload.readable);
      said = typeof parsed === "string" ? parsed : payload.readable;
    } catch {
      said = payload.readable;
    }
  } else if (typeof payload === "string") {
    said = payload;
  }
  return {
    executionResult: leader?.execution_result ?? null,
    outcome: result.status ?? null,
    said,
    error: leader?.error ?? null,
  };
}

async function finalized(client, hash, label, retries = 90) {
  let tx;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    tx = await rpc(`${label} receipt`, () => client.getTransaction({ hash }));
    if (statusName(tx) === "FINALIZED") break;
    if (attempt === retries) throw new Error(`${label} did not finalize after ${retries} polls`);
    await sleep(POLL_MS);
  }
  if (statusName(tx) !== "FINALIZED") {
    throw new Error(`${label} did not finalize (status ${statusName(tx) ?? "missing"})`);
  }
  return tx;
}

/* -------------------------------------------------------------------------- */
/* Arguments                                                                  */
/* -------------------------------------------------------------------------- */

const HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const TAG_RE = /\[(EXPECTED|EXTERNAL|TRANSIENT|LLM_ERROR)\]/;
/** Any seller token in any returned string has to be all lower case. See the note by `checkCasing`. */
const SELLER_TOKEN_RE = /seller=0x[0-9a-fA-F]{40}/g;

const pairs = process.argv.slice(2).map((argument) => {
  const index = argument.indexOf("=");
  if (index < 0) throw new Error(`expected label=0xhash, got ${argument}`);
  return [argument.slice(0, index), argument.slice(index + 1)];
});
for (const [label, hash] of pairs) {
  if (!EXPECTATIONS[label]) {
    throw new Error(`unknown label ${label}. Known: ${Object.keys(EXPECTATIONS).join(", ")}`);
  }
  if (!HASH_RE.test(hash)) throw new Error(`${label}: ${hash} is not a 32-byte transaction hash`);
}
if (pairs.length === 0) {
  console.error("no hashes given, so only the read-backs will be checked");
}

const address = process.env.NEXT_PUBLIC_CONVEYANCE_CONTRACT;
if (!address) throw new Error("NEXT_PUBLIC_CONVEYANCE_CONTRACT is not set");
const client = createClient({
  chain: studionet,
  account: createAccount(),
  endpoint: process.env.NEXT_PUBLIC_GENLAYER_ENDPOINT ?? "https://studio.genlayer.com/api",
});

const failures = [];
const fail = (message) => failures.push(message);

/**
 * The seller proof token has to be lower case everywhere it is compared, and this is cheap to check.
 *
 * `Address.as_hex` returns the EIP-55 checksummed form. The third deployment stored
 * `seller=0xac3AC69dC0Bde389256dD6748C75817ead9286D9` in `seller_proof_token` while the offer form
 * displayed the same line lowercased, and because `classify_proof` compares the token to a TXT value
 * byte for byte, every deal it opened named a seller who could not arm it. Worse than a refusal: an
 * absent proof is tagged `[TRANSIENT]`, so it would have told the seller to wait for a propagation
 * that was never going to help. One regex over everything the chain says is enough to catch it
 * coming back.
 */
function checkCasing(where, text) {
  for (const match of String(text).match(SELLER_TOKEN_RE) ?? []) {
    if (match !== match.toLowerCase()) {
      fail(`${where}: seller token is not lower case (${match}), so a published TXT record cannot match it`);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* The transactions                                                           */
/* -------------------------------------------------------------------------- */

const transactions = {};
for (const [label, hash] of pairs) {
  const expectation = EXPECTATIONS[label];
  const tx = await finalized(client, hash, label);
  const outcome = leaderOutcome(tx);

  /**
   * The hash has to belong to the contract this script is checking.
   *
   * Without this, a hash from a superseded deployment passes every other assertion in the loop,
   * because the wording of a refusal did not change between deployments. Three of the four earlier
   * deployments were replaced for defects, and one of the labels here was originally captured
   * against the third. A stale hash sitting in an evidence file next to the current contract address
   * would then read as a live proof of the current contract, which is the exact confusion this whole
   * script exists to remove.
   */
  if (tx?.recipient && String(tx.recipient).toLowerCase() !== address.toLowerCase()) {
    fail(`${label}: this transaction was sent to ${tx.recipient}, not to ${address}, so it proves nothing about the contract under test`);
  }

  if (outcome.outcome !== expectation.outcome) {
    fail(`${label}: leader reported ${outcome.outcome ?? "no status"}, expected ${expectation.outcome}`);
  }
  for (const fragment of expectation.says) {
    if (!outcome.said.includes(fragment)) {
      fail(`${label}: returned value does not contain ${JSON.stringify(fragment)}. It said ${JSON.stringify(outcome.said.slice(0, 240))}`);
    }
  }
  if (expectation.untagged && TAG_RE.test(outcome.said)) {
    fail(`${label}: a crash carried a tag (${outcome.said.slice(0, 120)}), which would make a bug look like a verdict`);
  }
  if (!expectation.untagged && expectation.outcome !== "return" && !TAG_RE.test(outcome.said)) {
    fail(`${label}: a refusal arrived with no tag, so nothing downstream can classify it`);
  }
  checkCasing(label, outcome.said);

  /**
   * The refund is asserted on the receipt rather than on a balance, because the balance does not
   * move until finalization and because a balance cannot say who the money went to. The message is
   * the only place both facts appear together.
   */
  const messages = Array.isArray(tx?.messages) ? tx.messages : [];
  if (expectation.refunds) {
    const sender = String(tx?.sender ?? "").toLowerCase();
    const refund = messages.find((message) => String(message?.value ?? "") === expectation.refunds);
    if (!refund) {
      fail(`${label}: no receipt message returning ${expectation.refunds} wei, so the escrow was kept`);
    } else {
      if (String(refund.recipient ?? "").toLowerCase() !== sender) {
        fail(`${label}: refund went to ${refund.recipient}, not to the caller ${tx?.sender}`);
      }
      if (refund.onAcceptance !== false) {
        fail(`${label}: refund has onAcceptance ${refund.onAcceptance}. The evidence describes a finalization-time transfer, and a change here changes when balance == held becomes true`);
      }
    }
  } else if (messages.some((message) => String(message?.value ?? "0") !== "0")) {
    fail(`${label}: moved value, and this label is not expected to move any`);
  }

  transactions[label] = {
    hash,
    status: statusName(tx),
    executionResult: outcome.executionResult,
    outcome: outcome.outcome,
    said: outcome.said,
    valueMessages: messages.filter((message) => String(message?.value ?? "0") !== "0"),
    means: expectation.note,
  };
}

/* -------------------------------------------------------------------------- */
/* The read-backs                                                             */
/* -------------------------------------------------------------------------- */

const read = (functionName, args = []) =>
  rpc(functionName, () => client.readContract({ address, functionName, args }));

const parameters = await read("parameters");
const ledger = await read("ledger");
const deals = await read("list_deals");
const dealOne = await read("get_deal", [DEAL_ONE]);
const dealTwo = await read("get_deal", [DEAL_TWO]);

if (String(parameters.uses_a_model) !== "false") {
  fail(`parameters().uses_a_model is ${parameters.uses_a_model}. The submission argues no model is used, and this is the field that has to back it`);
}
if (String(parameters.embedded_function_count) !== "40") {
  fail(`parameters().embedded_function_count is ${parameters.embedded_function_count}, expected 40 to match the spliced region`);
}

// Safe here and nowhere earlier: every hash above has been polled to FINALIZED, so any refund
// dispatched by a receipt message has landed.
if (String(ledger.balance) !== String(ledger.held)) {
  fail(`ledger() balance ${ledger.balance} against held ${ledger.held}. Either value is stranded or a refund is still in flight`);
}
if (String(ledger.held) !== HELD_TOTAL) fail(`ledger().held is ${ledger.held}, expected ${HELD_TOTAL}`);
if (String(ledger.deals_opened) !== "2") fail(`ledger().deals_opened is ${ledger.deals_opened}, expected 2`);
if (String(ledger.total_escrowed) !== HELD_TOTAL) fail(`ledger().total_escrowed is ${ledger.total_escrowed}, expected ${HELD_TOTAL}`);
// A declined `open_deal` never became a deal, so returning its value is not a deal refund and must
// not be counted as one. A non-zero figure here would mean a real refund path had run.
if (String(ledger.total_refunded) !== "0") fail(`ledger().total_refunded is ${ledger.total_refunded}, expected 0`);
if (String(ledger.total_released) !== "0") fail(`ledger().total_released is ${ledger.total_released}, expected 0`);

if (!Array.isArray(deals) || deals.length !== 2) {
  fail(`list_deals() returned ${Array.isArray(deals) ? deals.length : "a non-array"}, expected 2`);
} else {
  if (String(deals[0].deal_id) !== DEAL_ONE) fail(`list_deals()[0] is ${deals[0].deal_id}, expected ${DEAL_ONE} in open order`);
  if (String(deals[1].deal_id) !== DEAL_TWO) fail(`list_deals()[1] is ${deals[1].deal_id}, expected ${DEAL_TWO} in open order`);
}

for (const [id, deal, escrow, domain] of [
  [DEAL_ONE, dealOne, ESCROW_ONE, "example.com"],
  [DEAL_TWO, dealTwo, ESCROW_TWO, "example.net"],
]) {
  if (String(deal.deal_id) !== id) fail(`get_deal(${id}) came back as ${deal.deal_id}`);
  if (String(deal.state) !== "OFFERED") fail(`${id} is ${deal.state}, expected OFFERED`);
  if (String(deal.escrow) !== escrow) fail(`${id} escrow is ${deal.escrow}, expected ${escrow}`);
  if (String(deal.domain) !== domain) fail(`${id} domain is ${deal.domain}, expected ${domain}`);
  const token = String(deal.seller_proof_token);
  if (token !== `v1;deal=${id};seller=${SELLER}`) {
    fail(`${id} seller_proof_token is ${token}, and the interface would display v1;deal=${id};seller=${SELLER}`);
  }
  checkCasing(`get_deal(${id})`, token);
  // The address fields may report checksummed; only a compared value has to be lower case.
  if (String(deal.buyer_proof_revealed) !== "False") fail(`${id} reports a revealed buyer token before any check ran`);
  if (String(deal.checks) !== "0") fail(`${id} has ${deal.checks} checks, expected 0`);
}

/* -------------------------------------------------------------------------- */
/* Report                                                                     */
/* -------------------------------------------------------------------------- */

console.log(
  JSON.stringify(
    {
      network: "studionet",
      endpoint: process.env.NEXT_PUBLIC_GENLAYER_ENDPOINT ?? "https://studio.genlayer.com/api",
      contract: address,
      checked: pairs.map(([label]) => label),
      transactions,
      parameters,
      ledger,
      deals,
      dealOne,
      dealTwo,
      failures,
    },
    null,
    2,
  ),
);

if (failures.length > 0) {
  console.error(`\n${failures.length} assertion(s) failed:`);
  for (const message of failures) console.error(`  ${message}`);
  process.exit(1);
}
console.error(`\nall assertions passed across ${pairs.length} transaction(s) and 5 read(s).`);
