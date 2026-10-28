// DEC-0238: the mint fee paid in USDC at mint/seed time -- IDL shape, fee
// math, SDK builders, and the server-built seed (lib/mainnet/buildSeed.ts).
// Live-proven separately on a throwaway DevNet deployment
// (scripts/verify_usdc_mint_fee_live.ts).
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { expect } from "chai";
import { Connection, Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { AccountLayout, MintLayout, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import idl from "../packages/sdk/idl/ssr_protocol.json";
import { buildReadOnlyProgram } from "../packages/sdk/src/readOnly";
import { findManagerFeeRecipients, findReserveAsset, findReserveVault, findSettlementKeeperConfig } from "../packages/sdk/src/pda";
import { buildUsdcFeeDestinationAtaInstructions, computeUsdcMintFeeRaw, effectiveMintFeeFraction, valueAssetAmountsUsdcRaw } from "../packages/sdk/src/usdcMintFee";
import { quoteUsdcMintFee } from "../lib/mainnet/usdcMintFee";
import { buildSeedTransaction } from "../lib/mainnet/buildSeed";
import { BuildError } from "../lib/mainnet/buildCommon";
import { assessLaunchFeasibility } from "../src/merge/lib/launchFunding";

const PROGRAM_ID = new PublicKey("8hTW7fHwn8t8hcgTVeyAhHMiCTHGUP3783NWUTBBFwH9");
const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const TREASURY = new PublicKey("3CBpVMPDQD75b5bXgDunkpVJ3EeQWcwU9DCSLsTjWQL5");
const disc = (ns: string, name: string) => Array.from(crypto.createHash("sha256").update(`${ns}:${name}`).digest().subarray(0, 8));

describe("DEC-0238 -- IDL: the two USDC-fee instructions, the event, the appended errors", () => {
  const ixByName = (n: string) => (idl as any).instructions.find((i: any) => i.name === n);

  it("the original share-fee instructions are unchanged (old clients keep working through the cutover)", () => {
    expect(ixByName("mint_reserve_tokens_in_kind").accounts.map((a: any) => a.name)).to.include("fee_vault");
    expect(ixByName("seed_reserve").accounts.map((a: any) => a.name)).to.include("fee_vault");
  });

  for (const [name, payer, payerUsdc] of [
    ["mint_reserve_tokens_in_kind_usdc_fee", "depositor", "depositor_usdc_account"],
    ["seed_reserve_usdc_fee", "manager", "manager_usdc_account"],
  ] as const) {
    it(`${name}: discriminator, a required fee_quote_signer, the USDC accounts, no fee vault`, () => {
      const ix = ixByName(name);
      expect(ix, name).to.exist;
      expect(ix.discriminator).to.deep.equal(disc("global", name));
      const acc = (n: string) => ix.accounts.find((a: any) => a.name === n);
      expect(acc("fee_quote_signer").signer).to.equal(true);
      expect(acc("fee_quote_signer").writable ?? false).to.equal(false); // the keeper never pays or holds anything here
      expect(acc(payer).signer).to.equal(true);
      expect(acc(payerUsdc).writable).to.equal(true);
      expect(acc("protocol_usdc_destination").writable).to.equal(true);
      // Always the PDA, never optional: the program itself decides legacy vs. multi-recipient routing.
      expect(acc("manager_fee_recipients").optional ?? false).to.equal(false);
      const names = ix.accounts.map((a: any) => a.name);
      for (const gone of ["fee_settlement", "fee_vault", "fee_vault_authority"]) expect(names).to.not.include(gone);
      expect(ix.args.map((a: any) => a.name)).to.include("usdc_fee");
    });
  }

  it("MintFeePaidUsdc is declared with the payer, the split and the recipients", () => {
    const ev = (idl as any).events.find((e: any) => e.name === "MintFeePaidUsdc");
    expect(ev.discriminator).to.deep.equal(disc("event", "MintFeePaidUsdc"));
    const fields = (idl as any).types.find((t: any) => t.name === "MintFeePaidUsdc").type.fields.map((f: any) => f.name);
    expect(fields).to.deep.equal(["reserve", "payer", "is_seed", "reserve_tokens_out", "usdc_fee", "protocol_usdc", "manager_usdc", "protocol_destination", "manager_recipients", "manager_amounts", "fee_quote_signer", "ts"]);
  });

  it("the three new errors are appended at 6068-6070, after the co-manager containment errors (no existing code moved)", () => {
    const code = (n: string) => (idl as any).errors.find((e: any) => e.name === n)?.code;
    expect(code("DelegateSelfModification")).to.equal(6067);
    expect(code("NotFeeQuoteSigner")).to.equal(6068);
    expect(code("UsdcMintFeeRequired")).to.equal(6069);
    expect(code("UsdcMintFeeNotExpected")).to.equal(6070);
  });

  it("the camelCase TS mirror carries the same additions", () => {
    const ts = fs.readFileSync(path.join(__dirname, "../packages/sdk/idl/ssr_protocol.ts"), "utf8");
    for (const s of ["mintReserveTokensInKindUsdcFee", "seedReserveUsdcFee", "mintFeePaidUsdc", "notFeeQuoteSigner"]) expect(ts, s).to.include(s);
  });
});

describe("DEC-0238 -- fee math", () => {
  it("the USDC fee is the EFFECTIVE mint-fee rate (with the Protocol's 0.5% floor) on the deposit's value, rounded up", () => {
    expect(computeUsdcMintFeeRaw(10_000_000n, 100)).to.equal(100_000n); // $10 at 1% = $0.10
    expect(computeUsdcMintFeeRaw(10_000_000n, 40)).to.equal(50_000n); // configured 0.4% is below the floor: the protocol half is raised to 0.5%
    expect(computeUsdcMintFeeRaw(10_000_000n, 60)).to.equal(60_000n); // configured 0.6% -> 0.5% protocol (floor) + 0.1% manager
    expect(computeUsdcMintFeeRaw(10_000_000n, 0)).to.equal(50_000n); // DEC-0269: a 0% Reserve still pays the Protocol 0.5%
    expect(computeUsdcMintFeeRaw(1n, 100)).to.equal(1n); // rounds up in the protocol's favor
    expect(effectiveMintFeeFraction(100)).to.equal(0.01);
  });

  it("values legs at their prices (USDC raw, floored per leg) and refuses an unpriced leg instead of guessing", () => {
    expect(valueAssetAmountsUsdcRaw([{ amountRaw: 2_500_000n, decimals: 6, priceUsd: 2 }, { amountRaw: 100_000_000n, decimals: 9, priceUsd: 150 }])).to.equal(5_000_000n + 15_000_000n);
    expect(valueAssetAmountsUsdcRaw([{ amountRaw: 0n, decimals: 6, priceUsd: null }])).to.equal(0n); // nothing deposited, no price needed
    expect(() => valueAssetAmountsUsdcRaw([{ amountRaw: 1n, decimals: 6, priceUsd: null }])).to.throw(/no current price/);
  });

  it("quoteUsdcMintFee prices USDC legs at exactly 1 and turns a missing price into a 422", () => {
    expect(quoteUsdcMintFee({ legs: [{ mint: USDC.toBase58(), decimals: 6, amountRaw: 5_000_000n, priceUsd: null }], mintFeeBps: 100 })).to.deep.equal({ depositValueUsdcRaw: 5_000_000n, usdcFeeRaw: 50_000n });
    try {
      quoteUsdcMintFee({ legs: [{ mint: Keypair.generate().publicKey.toBase58(), decimals: 6, amountRaw: 5n, priceUsd: undefined }], mintFeeBps: 100 });
      expect.fail("expected BuildError");
    } catch (e) {
      expect(e).to.be.instanceOf(BuildError);
      expect((e as BuildError).status).to.equal(422);
    }
  });

  it("the launch feasibility check adds the seed's USDC mint fee to what the wallet must hold", () => {
    const assets = [{ mint: USDC.toBase58(), seedWeightFraction: 1, kind: "usdc" as const }];
    const without = assessLaunchFeasibility({ assets, seedTotalUsd: 10, walletUsdcRaw: 10_310_000n });
    const withFee = assessLaunchFeasibility({ assets, seedTotalUsd: 10, walletUsdcRaw: 10_310_000n, mintFeeUsd: 0.1 });
    expect(without.feasible).to.equal(true);
    expect(withFee.feasible).to.equal(false);
    expect(withFee.reasons.join(" ")).to.include("0.10 USDC mint fee");
  });

  it("fee-destination ATA creates cover the Treasury and every recipient, deduplicated, off-curve owners allowed", () => {
    const a = Keypair.generate().publicKey;
    const ixs = buildUsdcFeeDestinationAtaInstructions(a, USDC, { protocolFeeDestination: TREASURY, managerRecipients: [{ wallet: a }, { wallet: a }] });
    expect(ixs).to.have.length(2);
    expect(ixs[0].keys[1].pubkey.equals(getAssociatedTokenAddressSync(USDC, TREASURY, true))).to.equal(true);
  });
});

// --- The server-built seed with fakes --------------------------------------

function tokenAccountInfo(mint: PublicKey, owner: PublicKey, amount: bigint, program = TOKEN_PROGRAM_ID) {
  const data = Buffer.alloc(AccountLayout.span);
  AccountLayout.encode({ mint, owner, amount, delegateOption: 0, delegate: PublicKey.default, state: 1, isNativeOption: 0, isNative: 0n, delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: PublicKey.default }, data);
  return { data, executable: false, lamports: 2_039_280, owner: program, rentEpoch: 0 };
}
function mintAccountInfo(supply: bigint, owner: PublicKey) {
  const data = Buffer.alloc(MintLayout.span);
  MintLayout.encode({ mintAuthorityOption: 1, mintAuthority: PublicKey.default, supply, decimals: 6, isInitialized: true, freezeAuthorityOption: 0, freezeAuthority: PublicKey.default }, data);
  return { data, executable: false, lamports: 1_461_600, owner, rentEpoch: 0 };
}

interface SeedWorld {
  legs: { mint: PublicKey; decimals: number; price: number | null }[];
  manager: PublicKey;
  walletUsdcRaw: bigint;
  status: Record<string, object>;
  recipients: PublicKey[] | null;
}

function seedDeps(w: SeedWorld, feeQuoteSigner: Keypair | null) {
  const reserve = Keypair.generate().publicKey;
  const reserveTokenMint = Keypair.generate().publicKey;
  const legacyDestination = w.manager;
  const real = buildReadOnlyProgram(new Connection("http://127.0.0.1:1")) as any;
  const program = {
    programId: PROGRAM_ID,
    methods: real.methods,
    account: {
      reserve: { fetchNullable: async () => ({ reserveId: { toString: () => "42" }, manager: w.manager, status: w.status, reserveTokenMint, assetCount: w.legs.length, feeConfig: { mintFeeBps: 100, feeDestination: legacyDestination } }) },
      reserveAsset: {
        fetchMultiple: async (pdas: PublicKey[]) =>
          pdas.map((pda) => {
            const i = w.legs.findIndex((l) => findReserveAsset(reserve, l.mint, PROGRAM_ID)[0].equals(pda));
            return i >= 0 ? { decimals: w.legs[i].decimals, orderIndex: i, tokenProgram: { classic: {} } } : null;
          }),
      },
      managerFeeRecipients: {
        fetchNullable: async () => (w.recipients ? { recipientCount: w.recipients.length, recipients: w.recipients.map((wallet) => ({ wallet })) } : null),
      },
    },
  };
  const connection = {
    getMultipleAccountsInfo: async (keys: PublicKey[]) =>
      keys.map((k) => {
        if (k.equals(reserveTokenMint)) return mintAccountInfo(0n, TOKEN_2022_PROGRAM_ID);
        if (k.equals(getAssociatedTokenAddressSync(USDC, w.manager))) return tokenAccountInfo(USDC, w.manager, w.walletUsdcRaw);
        if (k.equals(getAssociatedTokenAddressSync(USDC, TREASURY, true))) return tokenAccountInfo(USDC, TREASURY, 0n);
        for (const l of w.legs) if (k.equals(findReserveVault(reserve, l.mint, PROGRAM_ID)[0])) return tokenAccountInfo(l.mint, reserve, 0n);
        return null;
      }),
    getBalance: async () => 1_000_000_000,
    getLatestBlockhash: async () => ({ blockhash: "GfVcyD5g4T1yY3aLj7Y5ZQhYjQ1kJ7RkS6oY8cQ8xY7Z", lastValidBlockHeight: 999_999 }),
    getAddressLookupTable: async () => ({ context: { slot: 1 }, value: null }),
  } as unknown as Connection;
  const deps = {
    connection,
    program,
    ssrProgramId: PROGRAM_ID,
    lookupReserveAlt: async () => null,
    fetchPrices: async (mints: string[]) => new Map(mints.map((m) => [m, { usdPrice: w.legs.find((l) => l.mint.toBase58() === m)?.price ?? null }])),
    feeQuoteSigner,
  };
  return { deps, reserve };
}

const seedInput = (w: SeedWorld, reserve: PublicKey, amounts: bigint[]) => ({
  reserve,
  manager: w.manager,
  assetMints: w.legs.map((l) => l.mint),
  seedAmountsRaw: amounts,
  initialReserveTokens: 10_000_000n,
  lookupTable: null,
});

describe("DEC-0238 -- lib/mainnet/buildSeed.ts (server-built, co-signed seed)", () => {
  const signer = Keypair.generate();
  const base = (o: Partial<SeedWorld> = {}): SeedWorld => ({
    legs: [
      { mint: USDC, decimals: 6, price: 1 },
      { mint: Keypair.generate().publicKey, decimals: 6, price: 2 },
    ],
    manager: Keypair.generate().publicKey,
    walletUsdcRaw: 20_000_000n,
    status: { assetsInitializing: {} },
    recipients: null,
    ...o,
  });

  it("builds seed_reserve_usdc_fee with a 1% USDC fee on the seed's value, co-signed, the creator as fee payer", async () => {
    const w = base();
    const { deps, reserve } = seedDeps(w, signer);
    // $5 USDC + 2.5 units at $2 = $10 seed -> 0.10 USDC fee.
    const r = await buildSeedTransaction(deps, seedInput(w, reserve, [5_000_000n, 2_500_000n]));
    expect(r.status).to.equal("ready");
    if (r.status !== "ready") return;
    expect(r.seedValueUsdcRaw).to.equal("10000000");
    expect(r.usdcMintFeeRaw).to.equal("100000");
    const tx = VersionedTransaction.deserialize(Buffer.from(r.transactionBase64, "base64"));
    const keys = tx.message.staticAccountKeys;
    expect(keys[0].equals(w.manager)).to.equal(true);
    const feeIdx = keys.slice(0, tx.message.header.numRequiredSignatures).findIndex((k) => k.equals(signer.publicKey));
    expect(feeIdx).to.be.greaterThan(0);
    const { ed25519 } = await import("@noble/curves/ed25519");
    expect(ed25519.verify(tx.signatures[feeIdx], tx.message.serialize(), signer.publicKey.toBytes())).to.equal(true);
    const ssr = tx.message.compiledInstructions.filter((ix) => keys[ix.programIdIndex].equals(PROGRAM_ID));
    expect(ssr).to.have.length(1);
    expect(Array.from(ssr[0].data.subarray(0, 8))).to.deep.equal(disc("global", "seed_reserve_usdc_fee"));
    const ixKeys = ssr[0].accountKeyIndexes.map((i) => keys[i]?.toBase58());
    expect(ixKeys).to.include(findSettlementKeeperConfig(PROGRAM_ID)[0].toBase58());
    expect(ixKeys).to.include(findManagerFeeRecipients(reserve, PROGRAM_ID)[0].toBase58());
    // The Treasury's and the manager's (legacy destination) USDC accounts exist: compute budget x2 + the seed, no ATA creates.
    expect(tx.message.compiledInstructions.length).to.equal(3);
  });

  it("re-keys seed amounts by mint, whatever order the caller sent them in", async () => {
    const w = base();
    const { deps, reserve } = seedDeps(w, signer);
    const input = seedInput(w, reserve, [2_500_000n, 5_000_000n]);
    input.assetMints = [w.legs[1].mint, w.legs[0].mint];
    const r = await buildSeedTransaction(deps, input);
    expect(r.status === "ready" && r.seedValueUsdcRaw).to.equal("10000000");
  });

  it("refuses: no signer configured (503), not the manager (403), already seeded (409), not enough USDC for the fee (422), an unpriced asset (422)", async () => {
    const expectStatus = async (p: Promise<unknown>, status: number) => {
      try {
        await p;
        expect.fail(`expected ${status}`);
      } catch (e) {
        expect(e).to.be.instanceOf(BuildError);
        expect((e as BuildError).status).to.equal(status);
      }
    };
    let w = base();
    let s = seedDeps(w, null);
    await expectStatus(buildSeedTransaction(s.deps, seedInput(w, s.reserve, [5_000_000n, 2_500_000n])), 503);
    w = base();
    s = seedDeps(w, signer);
    await expectStatus(buildSeedTransaction(s.deps, { ...seedInput(w, s.reserve, [5_000_000n, 2_500_000n]), manager: Keypair.generate().publicKey }), 403);
    w = base({ status: { active: {} } });
    s = seedDeps(w, signer);
    await expectStatus(buildSeedTransaction(s.deps, seedInput(w, s.reserve, [5_000_000n, 2_500_000n])), 409);
    w = base({ walletUsdcRaw: 5_050_000n }); // covers the $5 USDC seed leg but not the 0.10 fee
    s = seedDeps(w, signer);
    await expectStatus(buildSeedTransaction(s.deps, seedInput(w, s.reserve, [5_000_000n, 2_500_000n])), 422);
    w = base();
    w.legs[1].price = null;
    s = seedDeps(w, signer);
    await expectStatus(buildSeedTransaction(s.deps, seedInput(w, s.reserve, [5_000_000n, 2_500_000n])), 422);
  });

  it("a 12-asset seed that cannot fit asks for a lookup table (signers excluded) instead of building", async () => {
    const legs = Array.from({ length: 12 }, () => ({ mint: Keypair.generate().publicKey, decimals: 6, price: 1 }));
    const w = base({ legs, recipients: [Keypair.generate().publicKey, Keypair.generate().publicKey] });
    const { deps, reserve } = seedDeps(w, signer);
    const r = await buildSeedTransaction(deps, seedInput(w, reserve, legs.map(() => 1_000_000n)));
    expect(r.status).to.equal("needsLookupTable");
    if (r.status !== "needsLookupTable") return;
    expect(r.addresses).to.not.include(w.manager.toBase58());
    expect(r.addresses).to.not.include(signer.publicKey.toBase58());
    expect(r.usdcMintFeeRaw).to.equal("120000");
  });
});
