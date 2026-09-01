import { createAccount, createClient } from "genlayer-js";
import { chain, GENLAYER_ENDPOINT } from "./config";

/**
 * A client for views only.
 *
 * genlayer-js requires an `account` on every client even when the call is a read, so this
 * makes an ephemeral one per client. It is not a wallet and must never be mistaken for
 * one: it is created in memory, never written to storage, never shown, never funded, and
 * never used to sign anything. Every write in this app goes through the injected wallet
 * in `client.ts` instead.
 *
 * Previous experimental builds stored a generated StudioNet key locally. Current versions
 * support injected wallets only. Legacy generated-wallet material is deleted on migration
 * and is never used.
 */
export function createReadClient() {
  return createClient({ chain, endpoint: GENLAYER_ENDPOINT, account: createAccount() });
}
