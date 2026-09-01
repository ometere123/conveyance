/**
 * Does the contract deployed at the configured address contain the source in this repo?
 *
 * Not "did it deploy". A deployment succeeding proves something is on chain; it does not
 * prove that the something is what the repository claims. This reads the deployed code
 * back off StudioNet and compares it to `contracts/Conveyance.py` after normalising line
 * endings, so a CRLF checkout does not report a false mismatch.
 */
import { createAccount, createClient } from "genlayer-js";
import { studionet } from "genlayer-js/chains";
import { createHash } from "node:crypto";
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
  process.exit(1);
}

const normalise = (text) => text.replace(/\r\n/g, "\n").trimEnd();
const digest = (text) => createHash("sha256").update(normalise(text), "utf8").digest("hex");

const local = readFileSync("contracts/Conveyance.py", "utf8");

const client = createClient({
  chain: studionet,
  account: createAccount(),
  endpoint: process.env.NEXT_PUBLIC_GENLAYER_ENDPOINT ?? "https://studio.genlayer.com/api",
});

const raw = await client.getContractCode(address);
const deployed = typeof raw === "string" ? raw : new TextDecoder().decode(raw);

const localHash = digest(local);
const deployedHash = digest(deployed);

if (localHash !== deployedHash) {
  console.error("Deployed source does NOT match contracts/Conveyance.py");
  console.error(`  repo:     sha256 ${localHash} (${normalise(local).length} chars)`);
  console.error(`  deployed: sha256 ${deployedHash} (${normalise(deployed).length} chars)`);
  process.exit(1);
}
console.log(
  `Deployed source matches contracts/Conveyance.py (sha256 ${localHash.slice(0, 16)}, ` +
    `${normalise(local).length} chars) at ${address}.`,
);
