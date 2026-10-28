// The connected wallet's balance in every known Reserve Token, in a couple of
// batched reads (2026-10-28). The Portfolio used to wait for the whole
// discovery pass and then read each Reserve's balance one at a time (a mint
// owner lookup plus the token account, ~65 Reserves in a row), showing "No
// Reserves Yet" the whole time. Here every Reserve's token account is derived
// locally under BOTH token programs (classic Reserve Tokens predate DEC-0229)
// and fetched with getMultipleAccounts, 100 addresses per call: ~65 Reserves
// cost 2 calls. getTokenAccountsByOwner would be one call, but the rpc-proxy
// does not allow it.
import type { Connection, PublicKey } from "@solana/web3.js";
import { assetAta, tokenAccountAmountByOwner, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@ssr/sdk";
import { withRateLimitRetry, withReadConcurrencyLimit } from "./rpcResilience";

const MAX_ACCOUNTS_PER_CALL = 100;

/** mint -> raw balance for every mint given (0 when the wallet has no account). Throws if a read fails, so a failure never reads as "holds nothing". */
export async function readReserveTokenBalances(connection: Connection, owner: PublicKey, mints: string[]): Promise<Map<string, bigint>> {
  const slots = [...new Set(mints)].flatMap((mint) => [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].map((program) => ({ mint, address: assetAta(mint, owner, program) })));
  const out = new Map<string, bigint>(mints.map((m) => [m, 0n]));
  for (let i = 0; i < slots.length; i += MAX_ACCOUNTS_PER_CALL) {
    const chunk = slots.slice(i, i + MAX_ACCOUNTS_PER_CALL);
    const infos = await withRateLimitRetry(() => withReadConcurrencyLimit(() => connection.getMultipleAccountsInfo(chunk.map((s) => s.address))), 3, 500);
    chunk.forEach((s, j) => out.set(s.mint, (out.get(s.mint) ?? 0n) + tokenAccountAmountByOwner(s.address, infos[j])));
  }
  return out;
}
