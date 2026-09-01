/**
 * What this commit claims is deployed.
 *
 * The suite asserts the live site is pointed at *this* address rather than at a hardcoded one,
 * so the pair (repository, deployment) is checked rather than assumed. When the contract is
 * redeployed, `DEPLOYMENT.json` is rewritten and these tests follow it without being edited.
 * A stale test that still passed against a superseded contract would be worse than no test,
 * because it would report the old address as live.
 *
 * Resolved by walking up from the working directory rather than from `import.meta.url`, so the
 * file is identical in this repository and in Recourse, one of which is ESM and one of which is
 * not. Two copies that had drifted would be two different claims about the same fact.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

function findRepoRoot(): string {
  let dir = process.cwd();
  for (let hops = 0; hops < 6; hops += 1) {
    if (existsSync(path.join(dir, "DEPLOYMENT.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `DEPLOYMENT.json was not found at or above ${process.cwd()}. Run the E2E suite from the repository root.`,
  );
}

type DeploymentRecord = {
  network: string;
  contract: string;
  deploymentTransaction?: string;
  contractSha256?: string;
  deployedSourceVerified?: boolean;
};

const root = findRepoRoot();

export const deployment = JSON.parse(
  readFileSync(path.join(root, "DEPLOYMENT.json"), "utf8"),
) as DeploymentRecord;

/** Lowercased, because the site prints whatever casing its environment holds. */
export const expectedContract = deployment.contract.toLowerCase();

export const expectedNetwork = deployment.network;

/** The first `0x…40` in a string, lowercased, or undefined when there is none. */
export function addressIn(text: string | null): string | undefined {
  return text?.match(/0x[0-9a-fA-F]{40}/)?.[0]?.toLowerCase();
}
