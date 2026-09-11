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
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  assetAta,
  isToken2022,
  resolveLegTokenProgram,
  tokenProgramFromKind,
  tokenProgramFromMintOwner,
  tokenProgramKindArg,
  tokenProgramName,
} from "../packages/sdk/src/tokenPrograms";

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
