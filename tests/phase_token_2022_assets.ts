// Token-2022 asset support (DEC-0201).
//
// PUMP was reported missing from the asset picker. It is not a PUMP problem:
// PUMP is a Token-2022 mint, the catalogue dropped every Token-2022 mint, and
// measured against the live catalogue that was 1,587 of 3,224 Jupiter-verified
// mints -- 49% of the tradable universe, including most pump.fun-era tokens.
//
// The on-chain program was never the blocker. Asset legs are InterfaceAccounts,
// each ReserveAsset records its own `token_program`, and the CPI uses whichever
// program the caller passes in the leg's 5th remaining account. The CLIENT was
// the blocker: every builder hardcoded the classic program, and -- the quieter
// half -- derived every ATA under it, which for a Token-2022 mint is simply a
// different address that can never hold the asset.
//
// These tests pin both halves.
import { expect } from "chai";
import { Keypair, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync, unpackAccount, AccountLayout, ACCOUNT_SIZE } from "@solana/spl-token";
import {
  assetAta,
  isToken2022,
  resolveLegTokenProgram,
  tokenProgramFromKind,
  tokenProgramFromMintOwner,
  tokenProgramKindArg,
  tokenProgramName,
  unpackTokenAccountByOwner,
  tokenAccountAmountByOwner,
} from "../packages/sdk/src/tokenPrograms";
import { tokenAmountFromInfo } from "../lib/mainnet/buildCommon";

const PUMP = new PublicKey("pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn"); // real, Token-2022
const OWNER = Keypair.generate().publicKey;

describe("token program resolution", () => {
  it("decodes an on-chain TokenProgramKind, defaulting to classic when absent or unrecognised", () => {
    expect(tokenProgramFromKind({ token2022: {} }).toBase58()).to.equal(TOKEN_2022_PROGRAM_ID.toBase58());
    expect(tokenProgramFromKind({ splToken: {} }).toBase58()).to.equal(TOKEN_PROGRAM_ID.toBase58());
    // Absent/unknown must mean CLASSIC, never a guess: every Reserve created
    // before Token-2022 assets were selectable holds classic mints.
    expect(tokenProgramFromKind(null).toBase58()).to.equal(TOKEN_PROGRAM_ID.toBase58());
    expect(tokenProgramFromKind(undefined).toBase58()).to.equal(TOKEN_PROGRAM_ID.toBase58());
    expect(tokenProgramFromKind({} as never).toBase58()).to.equal(TOKEN_PROGRAM_ID.toBase58());
  });

  it("reads a mint's owning program from the account owner -- authoritative for a mint not yet registered", () => {
    expect(tokenProgramFromMintOwner(TOKEN_2022_PROGRAM_ID).toBase58()).to.equal(TOKEN_2022_PROGRAM_ID.toBase58());
    expect(tokenProgramFromMintOwner(TOKEN_PROGRAM_ID.toBase58()).toBase58()).to.equal(TOKEN_PROGRAM_ID.toBase58());
    expect(tokenProgramFromMintOwner(null).toBase58()).to.equal(TOKEN_PROGRAM_ID.toBase58());
  });

  it("resolves a leg's program from either a PublicKey or a base58 string, defaulting to classic", () => {
    expect(resolveLegTokenProgram({ tokenProgram: TOKEN_2022_PROGRAM_ID }).toBase58()).to.equal(TOKEN_2022_PROGRAM_ID.toBase58());
    expect(resolveLegTokenProgram({ tokenProgram: TOKEN_2022_PROGRAM_ID.toBase58() }).toBase58()).to.equal(TOKEN_2022_PROGRAM_ID.toBase58());
    expect(resolveLegTokenProgram({}).toBase58()).to.equal(TOKEN_PROGRAM_ID.toBase58());
    expect(resolveLegTokenProgram({ tokenProgram: null }).toBase58()).to.equal(TOKEN_PROGRAM_ID.toBase58());
  });

  it("emits the enum shape the instruction argument expects, and a readable name", () => {
    expect(tokenProgramKindArg(TOKEN_2022_PROGRAM_ID)).to.deep.equal({ token2022: {} });
    expect(tokenProgramKindArg(TOKEN_PROGRAM_ID)).to.deep.equal({ splToken: {} });
    expect(tokenProgramName(TOKEN_2022_PROGRAM_ID)).to.equal("token-2022");
    expect(tokenProgramName(TOKEN_PROGRAM_ID)).to.equal("spl-token");
    expect(isToken2022(TOKEN_2022_PROGRAM_ID)).to.equal(true);
    expect(isToken2022(TOKEN_PROGRAM_ID)).to.equal(false);
    expect(isToken2022(null)).to.equal(false);
  });
});

describe("associated token addresses -- the quiet half of the bug", () => {
  it("a Token-2022 mint's ATA is a DIFFERENT address than the classic derivation, so deriving it wrong yields an account that can never hold the asset", () => {
    const classic = assetAta(PUMP, OWNER, TOKEN_PROGRAM_ID);
    const t22 = assetAta(PUMP, OWNER, TOKEN_2022_PROGRAM_ID);
    expect(classic.toBase58()).to.not.equal(t22.toBase58());
    // And the classic derivation is exactly what the old code produced.
    expect(classic.toBase58()).to.equal(getAssociatedTokenAddressSync(PUMP, OWNER).toBase58());
    expect(t22.toBase58()).to.equal(getAssociatedTokenAddressSync(PUMP, OWNER, false, TOKEN_2022_PROGRAM_ID).toBase58());
  });

  it("supports an off-curve owner (the settlement authority and Treasury are PDAs)", () => {
    const [pda] = PublicKey.findProgramAddressSync([Buffer.from("settlement_authority")], new PublicKey("8hTW7fHwn8t8hcgTVeyAhHMiCTHGUP3783NWUTBBFwH9"));
    expect(() => assetAta(PUMP, pda, TOKEN_2022_PROGRAM_ID, true)).to.not.throw();
    // Without the off-curve allowance this is the documented throw, so the
    // flag is load-bearing, not decorative.
    expect(() => assetAta(PUMP, pda, TOKEN_2022_PROGRAM_ID, false)).to.throw();
  });

  it("accepts base58 strings as well as PublicKeys, since legs carry strings", () => {
    expect(assetAta(PUMP.toBase58(), OWNER.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58()).toBase58()).to.equal(
      assetAta(PUMP, OWNER, TOKEN_2022_PROGRAM_ID).toBase58(),
    );
  });
});

describe("no builder assumes a token program any more", () => {
  it("PUMP is a real Token-2022 mint -- the fixture this whole pass came from", () => {
    // Verified against Mainnet 2026-09-11: owner TokenzQd..., decimals 6.
    expect(PUMP.toBase58()).to.equal("pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn");
    expect(isToken2022("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb")).to.equal(true);
  });

  it("a mixed-program basket resolves each leg independently -- one Token-2022 asset must not drag the others onto the wrong program", () => {
    const legs = [
      { mint: "USDCmint", tokenProgram: TOKEN_PROGRAM_ID.toBase58() },
      { mint: PUMP.toBase58(), tokenProgram: TOKEN_2022_PROGRAM_ID.toBase58() },
      { mint: "LegacyMint" }, // no field at all -> classic
    ];
    const resolved = legs.map((l) => resolveLegTokenProgram(l).toBase58());
    expect(resolved).to.deep.equal([TOKEN_PROGRAM_ID.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58(), TOKEN_PROGRAM_ID.toBase58()]);
  });
});

// --- The NAV half: reading a Token-2022 vault's balance (2026-09-24) ---------
// TESTT, the first Reserve holding xStocks (eight Token-2022 tokenized
// stocks), showed $0 in every "Value in Reserve" cell, a $0 market cap and
// "This Reserve's current NAV could not be read" while every per-asset price
// beside them was fine. Probed on Mainnet: all eight vaults are Token-2022
// accounts (175 bytes, owner = Token-2022) with real balances, and spl-token's
// classic-default `unpackAccount` threw TokenInvalidAccountOwnerError on each
// one -- which every vault reader caught and recorded as "0". These tests pin
// the program-aware decoder that every vault and wallet read now goes through.

function tokenAccountData(mint: PublicKey, owner: PublicKey, amount: bigint): Buffer {
  const data = Buffer.alloc(ACCOUNT_SIZE);
  AccountLayout.encode(
    {
      mint,
      owner,
      amount,
      delegateOption: 0,
      delegate: PublicKey.default,
      state: 1,
      isNativeOption: 0,
      isNative: 0n,
      delegatedAmount: 0n,
      closeAuthorityOption: 0,
      closeAuthority: PublicKey.default,
    },
    data,
  );
  return data;
}

/** A Token-2022 account: the classic 165-byte layout, the account-type byte (2 = Account), then TLV extension bytes. Sized like the live xStocks vaults (175 bytes). */
function token2022AccountData(mint: PublicKey, owner: PublicKey, amount: bigint): Buffer {
  const tlv = Buffer.alloc(9); // ImmutableOwner-style TLV padding; the decoder slices it, never parses it here
  return Buffer.concat([tokenAccountData(mint, owner, amount), Buffer.from([2]), tlv]);
}

function accountInfo(owner: PublicKey, data: Buffer) {
  return { executable: false, owner, lamports: 2_039_280, data, rentEpoch: 0 };
}

describe("vault balance reads decode under the vault's OWN token program (the NAV half)", () => {
  const vault = Keypair.generate().publicKey;
  const vaultAuthority = Keypair.generate().publicKey;
  const NVDAX = new PublicKey("Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh"); // real xStocks NVDAx, Token-2022
  const LIVE_NVDAX_VAULT_RAW = 1_120_787n; // what TESTT's NVDAx vault held when probed, 8 decimals

  it("a Token-2022 vault (175 bytes, owner = Token-2022) decodes to its real balance -- this was reading as 0", () => {
    const info = accountInfo(TOKEN_2022_PROGRAM_ID, token2022AccountData(NVDAX, vaultAuthority, LIVE_NVDAX_VAULT_RAW));
    expect(info.data.length).to.equal(175);
    expect(unpackTokenAccountByOwner(vault, info).amount).to.equal(LIVE_NVDAX_VAULT_RAW);
    expect(tokenAccountAmountByOwner(vault, info)).to.equal(LIVE_NVDAX_VAULT_RAW);
    expect(tokenAmountFromInfo(vault, info)).to.equal(LIVE_NVDAX_VAULT_RAW);
  });

  it("a classic vault still decodes exactly as before", () => {
    const info = accountInfo(TOKEN_PROGRAM_ID, tokenAccountData(OWNER, vaultAuthority, 5_000_000n));
    expect(unpackTokenAccountByOwner(vault, info).amount).to.equal(5_000_000n);
    expect(tokenAccountAmountByOwner(vault, info)).to.equal(5_000_000n);
    expect(tokenAmountFromInfo(vault, info)).to.equal(5_000_000n);
  });

  it("a missing account is an empty balance, not an error", () => {
    expect(tokenAccountAmountByOwner(vault, null)).to.equal(0n);
    expect(tokenAccountAmountByOwner(vault, undefined)).to.equal(0n);
    expect(tokenAmountFromInfo(vault, null)).to.equal(0n);
    expect(() => unpackTokenAccountByOwner(vault, null)).to.throw();
  });

  it("an account owned by neither token program is never decoded as a balance", () => {
    const notAToken = accountInfo(Keypair.generate().publicKey, tokenAccountData(OWNER, vaultAuthority, 999n));
    expect(() => unpackTokenAccountByOwner(vault, notAToken)).to.throw();
    expect(tokenAccountAmountByOwner(vault, notAToken)).to.equal(0n);
    expect(tokenAmountFromInfo(vault, notAToken)).to.equal(0n);
  });

  it("the decoder trusts the account's owner, not the caller's assumption -- a Token-2022 account is rejected under the classic program and vice versa", () => {
    // Direct evidence of the original defect: the classic-default call throws.
    const t22 = accountInfo(TOKEN_2022_PROGRAM_ID, token2022AccountData(NVDAX, vaultAuthority, 1n));
    expect(() => unpackAccount(vault, t22)).to.throw();
    expect(() => unpackAccount(vault, t22, TOKEN_2022_PROGRAM_ID)).not.to.throw();
    const classic = accountInfo(TOKEN_PROGRAM_ID, tokenAccountData(OWNER, vaultAuthority, 1n));
    expect(() => unpackAccount(vault, classic, TOKEN_2022_PROGRAM_ID)).to.throw();
    expect(unpackTokenAccountByOwner(vault, classic).amount).to.equal(1n);
  });
});
