// Portfolio holdings in one batch (Creator, 2026-10-28: "portfolio fetching on production is
// taking AGES ... stays on no reserves yet ... then syncing holdings ... then no reserves
// again"). Holdings used to wait for the whole discovery pass, then read each Reserve's
// balance one at a time (~65 Reserves x 2 reads, in a row), and "No Reserves Yet" showed as
// soon as discovery finished, before any balance was read. Now every Reserve Token account
// is read in batches of 100 as soon as the Reserves are known, and the Portfolio says
// "Syncing" until this wallet's balances were actually read.
// Also: an empty or nearly-empty Reserve reads $0.00, not "Price unavailable".
import { expect } from "chai";
import { readFileSync } from "fs";
import { join } from "path";
import { Keypair, PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { readReserveTokenBalances } from "../src/merge/lib/walletReserveBalances";
import { isNearlyEmptyReserve } from "../src/merge/lib/reserveCardProps";

const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");

function tokenAccountData(mint: PublicKey, owner: PublicKey, amount: bigint): Buffer {
  const b = Buffer.alloc(165);
  mint.toBuffer().copy(b, 0);
  owner.toBuffer().copy(b, 32);
  b.writeBigUInt64LE(amount, 64);
  return b;
}

describe("Portfolio reads every Reserve Token balance in one batch", () => {
  const owner = Keypair.generate().publicKey;

  it("70 Reserves cost 2 getMultipleAccounts calls, under both token programs, and nothing else", async () => {
    const mints = Array.from({ length: 70 }, () => Keypair.generate().publicKey);
    const accounts = new Map<string, { owner: PublicKey; data: Buffer }>();
    // A Token-2022 holding, a classic holding, the rest hold nothing.
    const ata2022 = getAssociatedTokenAddressSync(mints[3], owner, false, TOKEN_2022_PROGRAM_ID);
    accounts.set(ata2022.toBase58(), { owner: TOKEN_2022_PROGRAM_ID, data: tokenAccountData(mints[3], owner, 1_500_000n) });
    const ataClassic = getAssociatedTokenAddressSync(mints[60], owner, false, TOKEN_PROGRAM_ID);
    accounts.set(ataClassic.toBase58(), { owner: TOKEN_PROGRAM_ID, data: tokenAccountData(mints[60], owner, 42n) });
    const calls: number[] = [];
    const conn = {
      async getMultipleAccountsInfo(addrs: PublicKey[]) {
        calls.push(addrs.length);
        return addrs.map((a) => {
          const acc = accounts.get(a.toBase58());
          return acc ? { owner: acc.owner, data: acc.data, lamports: 1, executable: false } : null;
        });
      },
    } as never;
    const balances = await readReserveTokenBalances(conn, owner, mints.map((m) => m.toBase58()));
    expect(calls).to.deep.equal([100, 40]);
    expect(balances.get(mints[3].toBase58())).to.equal(1_500_000n);
    expect(balances.get(mints[60].toBase58())).to.equal(42n);
    expect(balances.get(mints[0].toBase58())).to.equal(0n);
    expect(balances.size).to.equal(70);
  });

  it("a failed read throws instead of reading as 'holds nothing'", async () => {
    const conn = {
      async getMultipleAccountsInfo() {
        throw new Error("boom");
      },
    } as never;
    let threw = false;
    await readReserveTokenBalances(conn, owner, [Keypair.generate().publicKey.toBase58()]).catch(() => (threw = true));
    expect(threw).to.equal(true);
  });

  it("RealReserveSync reads holdings as soon as Reserves are in the store, never one Reserve at a time", () => {
    const src = read("src/merge/lib/RealReserveSync.tsx");
    expect(src).not.to.include("fetchTokenBalanceRaw");
    expect(src).not.to.include("syncRealHolding(");
    expect(src).to.include("}, [connection, walletKey, liveMintKey]);");
  });

  it("the Portfolio shows 'No Reserves Yet' only after this wallet's balances were read", () => {
    expect(read("src/merge/pages/Portfolio.tsx")).to.include("holdingsReadFor !== wallet.address");
    const store = read("src/merge/store/useAppStore.ts");
    expect(store).to.include("return { holdings, holdingsReadFor: wallet };");
    expect(store).to.include("holdingsReadFor: _holdingsReadFor, ...rest");
  });
});

describe("empty and nearly-empty Reserves read $0.00", () => {
  it("under one whole Reserve Token (or none) is nearly empty", () => {
    expect(isNearlyEmptyReserve({ status: "active", reserveTokenSupplyRaw: "0" })).to.equal(true);
    expect(isNearlyEmptyReserve({ status: "active", reserveTokenSupplyRaw: "999999" })).to.equal(true);
    expect(isNearlyEmptyReserve({ status: "active", reserveTokenSupplyRaw: "1000000" })).to.equal(false);
    expect(isNearlyEmptyReserve(undefined)).to.equal(false);
  });
});
