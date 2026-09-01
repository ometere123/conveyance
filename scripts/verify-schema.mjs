/**
 * Is the public surface of the deployed contract the surface this repository documents?
 *
 * Not "does it have the methods the frontend calls". That check passes on a contract with a
 * dozen extra entry points nobody reviewed, and on this contract the surface *is* the security
 * argument: seven writes, five reads, and exactly one method that may receive value. So the set
 * is asserted in both directions, the payable flag is asserted to be true on `open_deal` and
 * false on all eleven others, and every parameter list is asserted by name and type.
 *
 * A method appearing on chain that is absent from the table below fails this. That is the point.
 * The frontend's `data-source.ts` decodes fixed shapes, `docs` tells a reader there are seven
 * calls, and a thirteenth entry point would make both of those false without breaking either.
 *
 *   node scripts/verify-schema.mjs        # against NEXT_PUBLIC_CONVEYANCE_CONTRACT
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

const address = process.env.NEXT_PUBLIC_CONVEYANCE_CONTRACT;
if (!address) {
  console.error("NEXT_PUBLIC_CONVEYANCE_CONTRACT is not set.");
  process.exitCode = 1;
} else {
  process.exitCode = await verify(address);
}

/**
 * The whole intended surface, written out. `payable` is listed even where it is false, because
 * "this method cannot receive value" is a claim worth making explicitly for eleven of the twelve.
 */
function surface() {
  const write = (params, ret = "string", payable = false) => ({
    readonly: false,
    payable,
    params,
    ret,
  });
  const read = (params, ret) => ({ readonly: true, payable: false, params, ret });

  return {
    // The one method that receives value. Its six arguments are the whole of the deal's terms,
    // and the contract stores them before it has fetched anything.
    open_deal: write(
      [
        ["deal_id", "string"],
        ["domain", "string"],
        ["seller", "string"],
        ["target_registrar_id", "string"],
        ["target_nameservers", "string"],
        ["buyer_proof_commitment", "string"],
      ],
      "string",
      true,
    ),
    arm: write([["deal_id", "string"]]),
    check_transfer: write([
      ["deal_id", "string"],
      ["buyer_proof_token", "string"],
    ]),
    settle: write([["deal_id", "string"]]),
    refund: write([["deal_id", "string"]]),
    abandon: write([["deal_id", "string"]]),
    // A write because it opens a consensus block and fetches, not because it stores anything.
    probe_domain: write([["domain", "string"]], "dict"),

    get_deal: read([["deal_id", "string"]], "dict"),
    // `array`, not `list`. The contract annotates `-> list` and GenVM reports the schema type,
    // not the Python one. Written as the chain reports it, because that is what is being checked.
    list_deals: read([], "array"),
    delivery_status: read([["domain", "string"]], "dict"),
    ledger: read([], "dict"),
    parameters: read([], "dict"),
  };
}

async function verify(target) {
  const client = createClient({
    chain: studionet,
    account: createAccount(),
    endpoint: process.env.NEXT_PUBLIC_GENLAYER_ENDPOINT ?? "https://studio.genlayer.com/api",
  });

  const schema = await client.getContractSchema(target);
  const methods = schema.methods ?? {};
  const expected = surface();
  const failures = [];

  const onChain = Object.keys(methods).sort();
  const declared = Object.keys(expected).sort();

  for (const name of declared) {
    if (!methods[name]) failures.push(`${name} is declared here but absent from the deployment`);
  }
  for (const name of onChain) {
    if (!expected[name]) {
      failures.push(
        `${name} is a public method on the deployment that this repository does not document`,
      );
    }
  }

  for (const [name, want] of Object.entries(expected)) {
    const got = methods[name];
    if (!got) continue;

    if (Boolean(got.readonly) !== want.readonly) {
      failures.push(
        `${name} is readonly=${Boolean(got.readonly)} on chain, expected ${want.readonly}`,
      );
    }
    if (Boolean(got.payable) !== want.payable) {
      failures.push(
        `${name} is payable=${Boolean(got.payable)} on chain, expected ${want.payable}. ` +
          "Exactly one method in this contract may receive value.",
      );
    }
    if (got.ret !== want.ret) {
      failures.push(`${name} returns ${got.ret} on chain, expected ${want.ret}`);
    }

    const gotParams = (got.params ?? []).map(([n, t]) => `${n}:${t}`).join(", ");
    const wantParams = want.params.map(([n, t]) => `${n}:${t}`).join(", ");
    if (gotParams !== wantParams) {
      failures.push(`${name} takes (${gotParams}) on chain, expected (${wantParams})`);
    }
    if (Object.keys(got.kwparams ?? {}).length) {
      failures.push(`${name} declares keyword parameters, which nothing here would pass`);
    }
  }

  const ctorParams = (schema.ctor?.params ?? []).length;
  if (ctorParams !== 0) {
    failures.push(
      `the constructor takes ${ctorParams} argument(s); Conveyance is deployed with none, ` +
        "so no deployer-supplied value can differ between two deployments of this source",
    );
  }

  const payable = onChain.filter((name) => methods[name].payable);
  const writes = declared.filter((name) => !expected[name].readonly);
  const reads = declared.filter((name) => expected[name].readonly);

  if (failures.length) {
    console.error(`Schema does NOT match for ${target}:`);
    for (const failure of failures) console.error(`  FAIL ${failure}`);
    console.error(`  on chain: ${onChain.join(", ")}`);
    return 1;
  }

  console.log(`Conveyance schema verified for ${target}.`);
  console.log(`  ${declared.length} public methods, and no thirteenth: ${onChain.join(", ")}`);
  console.log(`  ${writes.length} writes: ${writes.join(", ")}`);
  console.log(`  ${reads.length} reads: ${reads.join(", ")}`);
  console.log(`  payable: ${payable.join(", ") || "none"}`);
  console.log(`  constructor takes no arguments`);
  return 0;
}
