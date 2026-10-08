// DEC-0229: new Reserve Token mints are Token-2022 with a protocol transfer
// fee. Offline guards for everything a client must get right:
//  - the IDL shape the deployed program will expect (create_reserve pins
//    Token-2022 and the fee-authority PDA; the two new instructions exist;
//    the new errors are appended, never renumbering an old one);
//  - the Rust constants and the SDK's copies agree (15 bps launch, 25 ceiling);
//  - every Reserve Token ATA (wallet, fee vault, treasury) is derived under
//    the mint's own program, and the builders put that program in the
//    instruction -- a classic-derived ATA for a Token-2022 mint is a
//    different, empty address;
//  - the rate builder refuses anything the program would refuse.
import { expect } from "chai";
import * as fs from "fs";
import * as path from "path";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import idl from "../packages/sdk/idl/ssr_protocol.json";
import { buildReadOnlyProgram, rememberMintTokenProgram, resolveMintTokenProgram, clearMintTokenProgramCache } from "../packages/sdk/src/readOnly";
import { findFeeVaultAta, findFeeVaultAuthority, findReserveTokenMint, findTransferFeeAuthority, findProtocolConfig, findMintAuthority, findVaultAuthority } from "../packages/sdk/src/pda";
import { buildCreateReserveInstruction, buildSeedReserveInstruction } from "../packages/sdk/src/createReserveFlow";
import { buildDirectMultiAssetMintInstructions, buildDirectMultiAssetRedeemInstructions } from "../packages/sdk/src/directInstructions";
import {
  buildCollectTransferFeesInstruction,
  buildUpdateTransferFeeInstruction,
  MAX_RESERVE_TOKEN_TRANSFER_FEE_BPS,
  RESERVE_TOKEN_TRANSFER_FEE_LAUNCH_BPS,
} from "../packages/sdk/src/transferFeeInstructions";

type IdlIx = { name: string; accounts: { name: string; address?: string }[] };
const ixs = (idl as unknown as { instructions: IdlIx[] }).instructions;
const ix = (name: string) => ixs.find((i) => i.name === name)!;
const PROGRAM_ID = new PublicKey((idl as { address: string }).address);
const key = () => Keypair.generate().publicKey;
// Never contacted: every builder below is given the program explicitly or reads a seeded cache.
const program = buildReadOnlyProgram(new Connection("http://127.0.0.1:1")) as any;

describe("DEC-0229 Token-2022 Reserve Token -- IDL shape", () => {
  it("create_reserve pins the Token-2022 program and takes the transfer-fee authority PDA", () => {
    const create = ix("create_reserve");
    expect(create.accounts.find((a) => a.name === "token_program")!.address).to.equal(TOKEN_2022_PROGRAM_ID.toBase58());
    expect(create.accounts.map((a) => a.name)).to.include("transfer_fee_authority");
  });

  it("mint / redeem / seed / fee instructions accept either token program (no pinned address)", () => {
    for (const name of ["mint_reserve_tokens_in_kind", "redeem_reserve_tokens_in_kind", "seed_reserve", "accrue_fees", "collect_fees", "collect_protocol_fee", "collect_manager_fee_share", "redeem_fee_vault_shares"]) {
      const tp = ix(name).accounts.find((a) => a.name === "token_program");
      expect(tp, name).to.not.equal(undefined);
      expect(tp!.address, name).to.equal(undefined);
    }
  });

  it("update_transfer_fee and collect_transfer_fees exist and pin Token-2022", () => {
    for (const name of ["update_transfer_fee", "collect_transfer_fees"]) {
      expect(ix(name).accounts.find((a) => a.name === "token_program")!.address, name).to.equal(TOKEN_2022_PROGRAM_ID.toBase58());
    }
  });

  it("appends the transfer-fee errors after TokenMetadataFieldTooLong (6062), never renumbering an existing code", () => {
    const errors = (idl as unknown as { errors: { code: number; name: string }[] }).errors;
    const byName = new Map(errors.map((e) => [e.name, e.code]));
    expect(byName.get("TokenMetadataFieldTooLong")).to.equal(6062);
    expect(byName.get("TransferFeeExceedsMaximum")).to.equal(6063);
    expect(byName.get("ReserveTokenHasNoTransferFee")).to.equal(6064);
    expect(byName.get("TransferFeeTreasuryMismatch")).to.equal(6065);
  });
});

describe("DEC-0229 Token-2022 Reserve Token -- constants", () => {
  it("the SDK's launch rate and ceiling equal the program's", () => {
    const rs = fs.readFileSync(path.resolve(__dirname, "..", "programs/ssr_protocol/src/constants.rs"), "utf8");
    const num = (name: string) => Number(rs.match(new RegExp(`pub const ${name}: u16 = (\\d+);`))![1]);
    expect(num("RESERVE_TOKEN_TRANSFER_FEE_LAUNCH_BPS")).to.equal(RESERVE_TOKEN_TRANSFER_FEE_LAUNCH_BPS);
    expect(num("MAX_RESERVE_TOKEN_TRANSFER_FEE_BPS")).to.equal(MAX_RESERVE_TOKEN_TRANSFER_FEE_BPS);
    expect(RESERVE_TOKEN_TRANSFER_FEE_LAUNCH_BPS).to.equal(15);
    expect(MAX_RESERVE_TOKEN_TRANSFER_FEE_BPS).to.equal(25);
  });
});

describe("DEC-0229 Token-2022 Reserve Token -- addresses and builders", () => {
  const reserve = key();
  const [mint] = findReserveTokenMint(reserve, PROGRAM_ID);
  const user = key();

  afterEach(() => clearMintTokenProgramCache());

  it("the fee vault's ATA differs by program -- the program must be passed, never assumed", () => {
    const classic = findFeeVaultAta(reserve, mint, PROGRAM_ID, TOKEN_PROGRAM_ID);
    const t22 = findFeeVaultAta(reserve, mint, PROGRAM_ID, TOKEN_2022_PROGRAM_ID);
    expect(classic.equals(t22)).to.equal(false);
    expect(t22.equals(getAssociatedTokenAddressSync(mint, findFeeVaultAuthority(reserve, PROGRAM_ID)[0], true, TOKEN_2022_PROGRAM_ID))).to.equal(true);
  });

  it("a remembered mint owner is served from the cache without an RPC read", async () => {
    rememberMintTokenProgram(mint, TOKEN_2022_PROGRAM_ID);
    // The connection points nowhere; a cache miss would fall back to classic.
    const p = await resolveMintTokenProgram(new Connection("http://127.0.0.1:1"), mint);
    expect(p.equals(TOKEN_2022_PROGRAM_ID)).to.equal(true);
  });

  it("create_reserve is built against Token-2022 with the transfer-fee authority PDA", async () => {
    const addresses = { reserveId: 0n, reserve, reserveTokenMint: mint, mintAuthority: findMintAuthority(reserve, PROGRAM_ID)[0], vaultAuthority: findVaultAuthority(reserve, PROGRAM_ID)[0], protocolConfig: findProtocolConfig(PROGRAM_ID)[0], reserveTokenProgram: TOKEN_2022_PROGRAM_ID };
    const built = await buildCreateReserveInstruction(program, addresses, user, { metadataUri: "https://x", mintFeeBps: 50, redemptionFeeBps: 0, tvlFeeBps: 100, feeDestination: user });
    const keys = built.keys.map((k) => k.pubkey.toBase58());
    expect(keys).to.include(TOKEN_2022_PROGRAM_ID.toBase58());
    expect(keys).to.include(findTransferFeeAuthority(PROGRAM_ID)[0].toBase58());
    expect(keys).to.not.include(TOKEN_PROGRAM_ID.toBase58());
  });

  it("seed_reserve mints to the manager's Token-2022 ATA and the Token-2022 fee vault", async () => {
    const addresses = { reserveId: 0n, reserve, reserveTokenMint: mint, mintAuthority: findMintAuthority(reserve, PROGRAM_ID)[0], vaultAuthority: findVaultAuthority(reserve, PROGRAM_ID)[0], protocolConfig: findProtocolConfig(PROGRAM_ID)[0], reserveTokenProgram: TOKEN_2022_PROGRAM_ID };
    const built = await buildSeedReserveInstruction(program, addresses, [], user, [], 1_000_000n);
    const keys = built.keys.map((k) => k.pubkey.toBase58());
    expect(keys).to.include(getAssociatedTokenAddressSync(mint, user, false, TOKEN_2022_PROGRAM_ID).toBase58());
    expect(keys).to.include(findFeeVaultAta(reserve, mint, PROGRAM_ID, TOKEN_2022_PROGRAM_ID).toBase58());
    expect(keys).to.not.include(getAssociatedTokenAddressSync(mint, user).toBase58());
  });

  const leg = () => {
    const assetMint = key();
    return { mint: assetMint.toBase58(), decimals: 6, reserveAsset: key().toBase58(), vault: key().toBase58(), vaultBalanceRaw: "1000000", tokenProgram: TOKEN_PROGRAM_ID.toBase58() };
  };

  for (const [label, rtProgram] of [["Token-2022", TOKEN_2022_PROGRAM_ID], ["classic", TOKEN_PROGRAM_ID]] as const) {
    it(`mint and redeem of a ${label} Reserve Token use that program's ATA and pass it as token_program`, async () => {
      const assets = [leg(), leg()];
      const rtAta = getAssociatedTokenAddressSync(mint, user, false, rtProgram).toBase58();
      const mintRes = await buildDirectMultiAssetMintInstructions({
        program, protocolConfig: findProtocolConfig(PROGRAM_ID)[0], protocolFeeDestination: key(), reserve, reserveTokenMint: mint, reserveTokenProgram: rtProgram,
        mintAuthority: findMintAuthority(reserve, PROGRAM_ID)[0], user, assets, reserveTokenSupplyRaw: "1000000", reserveTokensRequested: 1000n,
      } as any);
      const mintIx = mintRes.instructions[mintRes.instructions.length - 1];
      const mintKeys = mintIx.keys.map((k) => k.pubkey.toBase58());
      expect(mintKeys).to.include(rtAta);
      expect(mintKeys).to.include(rtProgram.toBase58());
      expect(mintKeys).to.include(findFeeVaultAta(reserve, mint, PROGRAM_ID, rtProgram).toBase58());
      // The idempotent ATA create for the Reserve Token names the same program.
      const createRt = mintRes.instructions.find((i) => i.keys.some((k) => k.pubkey.toBase58() === rtAta) && !i.programId.equals(PROGRAM_ID))!;
      expect(createRt.keys.some((k) => k.pubkey.equals(rtProgram))).to.equal(true);

      const redeemRes = await buildDirectMultiAssetRedeemInstructions({
        program, reserve, reserveTokenMint: mint, reserveTokenProgram: rtProgram, vaultAuthority: findVaultAuthority(reserve, PROGRAM_ID)[0],
        user, assets, reserveTokenSupplyRaw: "1000000", redemptionFeeBps: 0n, reserveTokensToRedeem: 1000n,
      });
      const redeemKeys = redeemRes.instructions[redeemRes.instructions.length - 1].keys.map((k) => k.pubkey.toBase58());
      expect(redeemKeys).to.include(rtAta);
      expect(redeemKeys).to.include(rtProgram.toBase58());
    });
  }

  it("update_transfer_fee refuses a rate above the 25 bps ceiling or a fractional rate before building", async () => {
    for (const bad of [26, 100, -1, 12.5]) {
      let threw = false;
      try {
        await buildUpdateTransferFeeInstruction({ program, programId: PROGRAM_ID, reserve, authority: user, newTransferFeeBps: bad });
      } catch {
        threw = true;
      }
      expect(threw, String(bad)).to.equal(true);
    }
    const ok = await buildUpdateTransferFeeInstruction({ program, programId: PROGRAM_ID, reserve, authority: user, newTransferFeeBps: 25 });
    expect(ok.keys.map((k) => k.pubkey.toBase58())).to.include(mint.toBase58());
  });

  it("collect_transfer_fees pays the treasury's Token-2022 ATA and passes harvest sources writable", async () => {
    const treasury = key();
    const sources = [key(), key()];
    const built = await buildCollectTransferFeesInstruction({ program, programId: PROGRAM_ID, reserve, treasury, payer: user, harvestSources: sources });
    const keys = built.keys.map((k) => k.pubkey.toBase58());
    expect(keys).to.include(getAssociatedTokenAddressSync(mint, treasury, true, TOKEN_2022_PROGRAM_ID).toBase58());
    for (const s of sources) expect(built.keys.find((k) => k.pubkey.equals(s))!.isWritable).to.equal(true);
  });
});
