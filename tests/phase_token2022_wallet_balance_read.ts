// DEC-0227: a wallet-balance read that is not told the mint's token program
// must derive the associated token account under the program that OWNS the
// mint, never the classic SPL Token program by default. The live failure:
// a batch Buy of a Reserve holding xStocks (Token-2022) swapped every leg,
// then read 0 for the Token-2022 legs through the classic-derived address
// and refused to mint ("still short after funding: acquired 0 raw").
import { expect } from "chai";
import { Keypair, PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { fetchTokenBalanceRaw } from "../packages/sdk/src/readOnly";

/** A minimal SPL token-account byte image: mint(32) owner(32) amount(u64 LE) + zero tail. */
function tokenAccountData(mint: PublicKey, owner: PublicKey, amount: bigint): Buffer {
  const b = Buffer.alloc(165);
  mint.toBuffer().copy(b, 0);
  owner.toBuffer().copy(b, 32);
  b.writeBigUInt64LE(amount, 64);
  return b;
}

function fakeConnection(accounts: Map<string, { owner: PublicKey; data: Buffer }>, reads: string[]) {
  return {
    async getAccountInfo(addr: PublicKey) {
      reads.push(addr.toBase58());
      const a = accounts.get(addr.toBase58());
      return a ? { owner: a.owner, data: a.data, lamports: 1, executable: false } : null;
    },
  } as never;
}

describe("DEC-0227 wallet balance read derives the ATA under the mint's own token program", () => {
  const owner = Keypair.generate().publicKey;
  const mint2022 = Keypair.generate().publicKey;
  const mintClassic = Keypair.generate().publicKey;

  it("reads a Token-2022 holding when no program is given (the xStocks case)", async () => {
    const ata2022 = getAssociatedTokenAddressSync(mint2022, owner, false, TOKEN_2022_PROGRAM_ID);
    const accounts = new Map<string, { owner: PublicKey; data: Buffer }>();
    accounts.set(mint2022.toBase58(), { owner: TOKEN_2022_PROGRAM_ID, data: Buffer.alloc(82) });
    accounts.set(ata2022.toBase58(), { owner: TOKEN_2022_PROGRAM_ID, data: tokenAccountData(mint2022, owner, 1529209n) });
    const reads: string[] = [];
    const raw = await fetchTokenBalanceRaw(fakeConnection(accounts, reads), mint2022, owner);
    expect(raw).to.equal("1529209");
    expect(reads).to.deep.equal([mint2022.toBase58(), ata2022.toBase58()]);
    // The classic-derived address is a different account and was never consulted.
    expect(reads).to.not.include(getAssociatedTokenAddressSync(mint2022, owner).toBase58());
  });

  it("still reads a classic SPL Token holding without an extra assumption", async () => {
    const ata = getAssociatedTokenAddressSync(mintClassic, owner);
    const accounts = new Map<string, { owner: PublicKey; data: Buffer }>();
    accounts.set(mintClassic.toBase58(), { owner: TOKEN_PROGRAM_ID, data: Buffer.alloc(82) });
    accounts.set(ata.toBase58(), { owner: TOKEN_PROGRAM_ID, data: tokenAccountData(mintClassic, owner, 42n) });
    const raw = await fetchTokenBalanceRaw(fakeConnection(accounts, []), mintClassic, owner);
    expect(raw).to.equal("42");
  });

  it("skips the mint read when the caller passes the program, and returns 0 for a missing account", async () => {
    const reads: string[] = [];
    const raw = await fetchTokenBalanceRaw(fakeConnection(new Map(), reads), mint2022, owner, TOKEN_2022_PROGRAM_ID);
    expect(raw).to.equal("0");
    expect(reads).to.deep.equal([getAssociatedTokenAddressSync(mint2022, owner, false, TOKEN_2022_PROGRAM_ID).toBase58()]);
  });

  it("falls back to classic SPL Token when the mint account itself cannot be read", async () => {
    const unknownMint = Keypair.generate().publicKey;
    const reads: string[] = [];
    const raw = await fetchTokenBalanceRaw(fakeConnection(new Map(), reads), unknownMint, owner);
    expect(raw).to.equal("0");
    expect(reads).to.deep.equal([unknownMint.toBase58(), getAssociatedTokenAddressSync(unknownMint, owner).toBase58()]);
  });
});

describe("DEC-0227 follow-up: the mint -> program lookup is remembered per session", () => {
  it("reads the mint account once per mint, then only the token account", async () => {
    const { clearMintTokenProgramCache } = await import("../packages/sdk/src/readOnly");
    clearMintTokenProgramCache();
    const owner = Keypair.generate().publicKey;
    const mint = Keypair.generate().publicKey;
    const ata = getAssociatedTokenAddressSync(mint, owner, false, TOKEN_2022_PROGRAM_ID);
    const accounts = new Map<string, { owner: PublicKey; data: Buffer }>();
    accounts.set(mint.toBase58(), { owner: TOKEN_2022_PROGRAM_ID, data: Buffer.alloc(82) });
    accounts.set(ata.toBase58(), { owner: TOKEN_2022_PROGRAM_ID, data: tokenAccountData(mint, owner, 7n) });
    const reads: string[] = [];
    const conn = fakeConnection(accounts, reads);
    expect(await fetchTokenBalanceRaw(conn, mint, owner)).to.equal("7");
    expect(await fetchTokenBalanceRaw(conn, mint, owner)).to.equal("7");
    expect(await fetchTokenBalanceRaw(conn, mint, owner)).to.equal("7");
    expect(reads.filter((r) => r === mint.toBase58()).length).to.equal(1);
    expect(reads.filter((r) => r === ata.toBase58()).length).to.equal(3);
    clearMintTokenProgramCache();
  });

  it("does not remember a failed mint read, so the next call retries it", async () => {
    const { clearMintTokenProgramCache } = await import("../packages/sdk/src/readOnly");
    clearMintTokenProgramCache();
    const owner = Keypair.generate().publicKey;
    const mint = Keypair.generate().publicKey;
    const reads: string[] = [];
    const conn = fakeConnection(new Map(), reads);
    await fetchTokenBalanceRaw(conn, mint, owner);
    await fetchTokenBalanceRaw(conn, mint, owner);
    expect(reads.filter((r) => r === mint.toBase58()).length).to.equal(2);
  });
});
