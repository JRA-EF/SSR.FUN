// Offline coverage for launchpad provenance (packages/sdk/src/launchpads.ts
// and lib/ledger/launchpadClassification.ts): positive detection for each
// supported platform, graduated vs bonding stages and venues, unsupported
// tokens, and spoofing attempts (imitating names/suffixes/metadata, pools
// created by third parties under the same programs, wrong platform
// identities). Every account here is a synthetic byte image laid out
// exactly like the Mainnet accounts verified in docs/protocol/LAUNCHPADS.md.
//
// Run in isolation:
//   npx ts-mocha -p ./tests/tsconfig.json -t 30000 tests/phase_launchpads.ts
import { expect } from "chai";
import { createHash } from "node:crypto";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  BAGS_LAUNCH_AUTHORITY,
  DISCRIMINATORS,
  LAYOUT,
  LAUNCHLAB_MIGRATE_TYPE,
  LAUNCHLAB_STATUS,
  LETSBONK_PLATFORM_CONFIG,
  METEORA_DBC_PROGRAM_ID,
  PUMP_PROGRAM_ID,
  PUMPSWAP_PROGRAM_ID,
  RAYDIUM_CPMM_PROGRAM_ID,
  RAYDIUM_LAUNCHLAB_AUTHORITY,
  RAYDIUM_LAUNCHLAB_PROGRAM_ID,
  classifyLaunchpad,
  decodePumpBondingCurve,
  deriveDbcDammV1MigrationMetadata,
  deriveDbcDammV2MigrationMetadata,
  deriveLaunchLabPool,
  derivePumpBondingCurve,
  derivePumpPoolAuthority,
  derivePumpSwapCanonicalPool,
  deriveRaydiumCpmmPool,
  isLaunchpadId,
  LAUNCHPAD_LABELS,
  SUPPORTED_LAUNCHPADS,
  type AccountLike,
} from "../packages/sdk/src/launchpads";
import { WRAPPED_SOL_MINT } from "../packages/sdk/src/zapPricing";
import { launchpadColumnsFor, selectMintsToClassify } from "../lib/ledger/launchpadClassification";
import { dedupeBySymbolPreferOrganicScore, type CatalogueRow } from "../api/ledger/asset-catalogue";

const disc = (n: string) => Uint8Array.from(createHash("sha256").update(n).digest().subarray(0, 8));
const acc = (address: PublicKey, owner: PublicKey, data: Uint8Array): AccountLike => ({ address, owner, data });
function put(buf: Buffer, offset: number, key: PublicKey) {
  key.toBuffer().copy(buf, offset);
}

// --- synthetic account builders (byte layouts from docs/protocol/LAUNCHPADS.md)
function pumpBondingCurve(mint: PublicKey, complete: boolean, opts: { owner?: PublicKey; disc?: Uint8Array; address?: PublicKey } = {}): AccountLike {
  const d = Buffer.alloc(151);
  Buffer.from(opts.disc ?? DISCRIMINATORS.pumpBondingCurve).copy(d, 0);
  d.writeBigUInt64LE(1_000_000_000_000_000n, 40);
  d[LAYOUT.pumpBondingCurve.complete] = complete ? 1 : 0;
  put(d, LAYOUT.pumpBondingCurve.creator, Keypair.generate().publicKey);
  return acc(opts.address ?? derivePumpBondingCurve(mint), opts.owner ?? PUMP_PROGRAM_ID, d);
}
function pumpSwapPool(mint: PublicKey, opts: { index?: number; creator?: PublicKey; address?: PublicKey; owner?: PublicKey } = {}): AccountLike {
  const d = Buffer.alloc(301);
  Buffer.from(DISCRIMINATORS.pumpSwapPool).copy(d, 0);
  d[8] = 254;
  d.writeUInt16LE(opts.index ?? 0, LAYOUT.pumpSwapPool.index);
  put(d, LAYOUT.pumpSwapPool.creator, opts.creator ?? derivePumpPoolAuthority(mint));
  put(d, LAYOUT.pumpSwapPool.baseMint, mint);
  put(d, LAYOUT.pumpSwapPool.quoteMint, WRAPPED_SOL_MINT);
  return acc(opts.address ?? derivePumpSwapCanonicalPool(mint), opts.owner ?? PUMPSWAP_PROGRAM_ID, d);
}
function launchLabPool(mint: PublicKey, opts: { status?: number; migrateType?: number; platform?: PublicKey; owner?: PublicKey; address?: PublicKey } = {}): AccountLike {
  const d = Buffer.alloc(LAYOUT.launchLabPoolState.len);
  Buffer.from(DISCRIMINATORS.launchLabPoolState).copy(d, 0);
  d[LAYOUT.launchLabPoolState.status] = opts.status ?? LAUNCHLAB_STATUS.fund;
  d[LAYOUT.launchLabPoolState.migrateType] = opts.migrateType ?? LAUNCHLAB_MIGRATE_TYPE.cpmm;
  put(d, LAYOUT.launchLabPoolState.globalConfig, Keypair.generate().publicKey);
  put(d, LAYOUT.launchLabPoolState.platformConfig, opts.platform ?? LETSBONK_PLATFORM_CONFIG);
  put(d, LAYOUT.launchLabPoolState.baseMint, mint);
  put(d, LAYOUT.launchLabPoolState.quoteMint, WRAPPED_SOL_MINT);
  put(d, LAYOUT.launchLabPoolState.creator, Keypair.generate().publicKey);
  return acc(opts.address ?? deriveLaunchLabPool(mint), opts.owner ?? RAYDIUM_LAUNCHLAB_PROGRAM_ID, d);
}
function cpmmPool(mint: PublicKey, creator: PublicKey, ammConfig = Keypair.generate().publicKey): AccountLike {
  const d = Buffer.alloc(LAYOUT.raydiumCpmmPool.minLen);
  put(d, LAYOUT.raydiumCpmmPool.ammConfig, ammConfig);
  put(d, LAYOUT.raydiumCpmmPool.poolCreator, creator);
  const [m0, m1] = Buffer.compare(mint.toBuffer(), WRAPPED_SOL_MINT.toBuffer()) < 0 ? [mint, WRAPPED_SOL_MINT] : [WRAPPED_SOL_MINT, mint];
  put(d, LAYOUT.raydiumCpmmPool.token0Mint, m0);
  put(d, LAYOUT.raydiumCpmmPool.token1Mint, m1);
  return acc(deriveRaydiumCpmmPool(ammConfig, mint, WRAPPED_SOL_MINT), RAYDIUM_CPMM_PROGRAM_ID, d);
}
function dbcPool(mint: PublicKey, opts: { creator?: PublicKey; migrated?: boolean; owner?: PublicKey; disc?: Uint8Array; address?: PublicKey } = {}): AccountLike {
  const d = Buffer.alloc(LAYOUT.dbcVirtualPool.len);
  Buffer.from(opts.disc ?? DISCRIMINATORS.dbcVirtualPool).copy(d, 0);
  put(d, LAYOUT.dbcVirtualPool.config, Keypair.generate().publicKey);
  put(d, LAYOUT.dbcVirtualPool.creator, opts.creator ?? BAGS_LAUNCH_AUTHORITY);
  put(d, LAYOUT.dbcVirtualPool.baseMint, mint);
  d[LAYOUT.dbcVirtualPool.isMigrated] = opts.migrated ? 1 : 0;
  d[LAYOUT.dbcVirtualPool.migrationProgress] = opts.migrated ? 3 : 0;
  return acc(opts.address ?? Keypair.generate().publicKey, opts.owner ?? METEORA_DBC_PROGRAM_ID, d);
}
function dbcMeta(pool: PublicKey, v: "v1" | "v2"): AccountLike {
  const d = Buffer.alloc(280);
  Buffer.from(v === "v2" ? DISCRIMINATORS.dbcDammV2Metadata : DISCRIMINATORS.dbcDammV1MigrationMetadata).copy(d, 0);
  return acc(v === "v2" ? deriveDbcDammV2MigrationMetadata(pool) : deriveDbcDammV1MigrationMetadata(pool), METEORA_DBC_PROGRAM_ID, d);
}

describe("launchpads.ts -- verified identifiers", () => {
  it("discriminators are sha256('account:<Name>')[0..8] of the documented account names", () => {
    expect(DISCRIMINATORS.pumpBondingCurve).to.deep.equal(disc("account:BondingCurve"));
    expect(DISCRIMINATORS.pumpSwapPool).to.deep.equal(disc("account:Pool"));
    expect(DISCRIMINATORS.launchLabPoolState).to.deep.equal(disc("account:PoolState"));
    expect(DISCRIMINATORS.launchLabPlatformConfig).to.deep.equal(disc("account:PlatformConfig"));
    expect(DISCRIMINATORS.dbcVirtualPool).to.deep.equal(disc("account:VirtualPool"));
    expect(DISCRIMINATORS.dbcDammV1MigrationMetadata).to.deep.equal(disc("account:MeteoraDammMigrationMetadata"));
    expect(DISCRIMINATORS.dbcDammV2Metadata).to.deep.equal(disc("account:MeteoraDammV2Metadata"));
  });

  it("derives the PDAs verified on Mainnet (SSR pump curve + canonical PumpSwap pool, USELESS LaunchLab pool, LaunchLab authority)", () => {
    const ssr = new PublicKey("BpdHpqznEgYPXZNrJVRZvBhdWoafYLVVuLxTQo34pump");
    expect(derivePumpBondingCurve(ssr).toBase58()).to.equal("795sG4tmTQKPaghcysFfRCF8rd7b9GYzukjLPiq3SqnD");
    expect(derivePumpSwapCanonicalPool(ssr).toBase58()).to.equal("C2TLNU8AwnaWrnAGhQm4X6y9T79mcMnmbKTMsYGPHKJd");
    expect(derivePumpPoolAuthority(ssr).toBase58()).to.equal("5HsRniqrFPkBmNRj7ySt3s48VtBFvobYwL75dS5F34aH");
    const useless = new PublicKey("Dz9mQ9NzkBcCsuGPFJ3r1bS4wgqKMHBPiVuniW8Mbonk");
    expect(deriveLaunchLabPool(useless).toBase58()).to.equal("GWqWrb44KJ8rmKvytQVUDh9X2pAVUkT8zE5RqTnJ4Dw4");
    expect(RAYDIUM_LAUNCHLAB_AUTHORITY.toBase58()).to.equal("WLHv2UAZm6z4KyaaELi5pjdbJh6RESMva1Rnn8pJVVh");
    expect(LETSBONK_PLATFORM_CONFIG.toBase58()).to.equal("FfYek5vEz23cMkWsdJwG2oa6EphsvXSHrGpdALN4g6W1");
    expect(BAGS_LAUNCH_AUTHORITY.toBase58()).to.equal("BAGSB9TpGrZxQbEsrEznv5jXXdwyP6AXerN8aVRiAmcv");
  });

  it("exposes the three supported launchpads with plain-language labels and the graduation venue", () => {
    expect(SUPPORTED_LAUNCHPADS).to.deep.equal(["pump.fun", "letsbonk.fun", "bags.fm"]);
    expect(LAUNCHPAD_LABELS["pump.fun"]).to.deep.equal({ name: "Pump.fun", site: "pump.fun", graduationVenue: "PumpSwap" });
    expect(isLaunchpadId("pump.fun")).to.equal(true);
    expect(isLaunchpadId("pumpswap")).to.equal(false);
  });
});

describe("launchpads.ts -- Pump.fun detection", () => {
  const mint = Keypair.generate().publicKey;

  it("bonding: a pump-owned BondingCurve PDA with complete=false", () => {
    const r = classifyLaunchpad(mint, { pumpBondingCurve: pumpBondingCurve(mint, false) });
    expect(r).to.deep.include({ launchpad: "pump.fun", stage: "bonding", venue: null });
    expect(r!.evidence.launchProgram).to.equal(PUMP_PROGRAM_ID.toBase58());
  });

  it("graduated to PumpSwap: complete=true plus the canonical pool (index 0, creator = pool-authority PDA)", () => {
    const r = classifyLaunchpad(mint, { pumpBondingCurve: pumpBondingCurve(mint, true), pumpSwapCanonicalPool: pumpSwapPool(mint) });
    expect(r).to.deep.include({ launchpad: "pump.fun", stage: "graduated", venue: "pumpswap" });
    expect(r!.evidence.venueProgram).to.equal(PUMPSWAP_PROGRAM_ID.toBase58());
  });

  it("graduated but no canonical pool (legacy Raydium migration or not yet migrated): venue is unknown, never guessed", () => {
    const r = classifyLaunchpad(mint, { pumpBondingCurve: pumpBondingCurve(mint, true) });
    expect(r).to.deep.include({ launchpad: "pump.fun", stage: "graduated", venue: null });
  });

  it("spoof: a PumpSwap pool created by a third party (index 0 but creator != pool authority) does not count as the graduation venue", () => {
    const r = classifyLaunchpad(mint, { pumpBondingCurve: pumpBondingCurve(mint, true), pumpSwapCanonicalPool: pumpSwapPool(mint, { creator: Keypair.generate().publicKey }) });
    expect(r!.venue).to.equal(null);
  });

  it("spoof: a PumpSwap pool alone (no bonding curve) is not a Pump.fun launch -- anyone can open a PumpSwap pool for any mint", () => {
    expect(classifyLaunchpad(mint, { pumpSwapCanonicalPool: pumpSwapPool(mint) })).to.equal(null);
  });

  it("spoof: a bonding-curve-shaped account owned by another program, or with the wrong discriminator, or at the wrong address, is ignored", () => {
    expect(classifyLaunchpad(mint, { pumpBondingCurve: pumpBondingCurve(mint, true, { owner: Keypair.generate().publicKey }) })).to.equal(null);
    expect(classifyLaunchpad(mint, { pumpBondingCurve: pumpBondingCurve(mint, true, { disc: DISCRIMINATORS.pumpSwapPool }) })).to.equal(null);
    expect(classifyLaunchpad(mint, { pumpBondingCurve: pumpBondingCurve(mint, true, { address: Keypair.generate().publicKey }) })).to.equal(null);
    expect(decodePumpBondingCurve(acc(derivePumpBondingCurve(mint), PUMP_PROGRAM_ID, new Uint8Array(10)))).to.equal(null);
  });
});

describe("launchpads.ts -- LetsBONK.fun detection (Raydium LaunchLab + LetsBONK platform config)", () => {
  const mint = Keypair.generate().publicKey;

  it("bonding: a LaunchLab PoolState for the mint whose platform_config is LetsBONK's, status Fund", () => {
    const r = classifyLaunchpad(mint, { launchLabPool: launchLabPool(mint) });
    expect(r).to.deep.include({ launchpad: "letsbonk.fun", stage: "bonding", venue: null });
    expect(r!.evidence.platformIdentity).to.equal(LETSBONK_PLATFORM_CONFIG.toBase58());
  });

  it("graduated to Raydium CPMM: status Trade, migrateType CPMM, and the CPMM pool created by LaunchLab's authority PDA", () => {
    const pool = cpmmPool(mint, RAYDIUM_LAUNCHLAB_AUTHORITY);
    const r = classifyLaunchpad(mint, {
      launchLabPool: launchLabPool(mint, { status: LAUNCHLAB_STATUS.trade }),
      raydiumCpmmPools: [cpmmPool(mint, Keypair.generate().publicKey), pool],
    });
    expect(r).to.deep.include({ launchpad: "letsbonk.fun", stage: "graduated", venue: "raydium-cpmm" });
    expect(r!.evidence.venueAccount).to.equal(pool.address.toBase58());
  });

  it("graduated with only third-party CPMM pools: venue unknown (community pools never count as the migration venue)", () => {
    const r = classifyLaunchpad(mint, { launchLabPool: launchLabPool(mint, { status: LAUNCHLAB_STATUS.trade }), raydiumCpmmPools: [cpmmPool(mint, Keypair.generate().publicKey)] });
    expect(r).to.deep.include({ launchpad: "letsbonk.fun", stage: "graduated", venue: null });
  });

  it("graduated with migrateType AMM v4 reports the legacy venue without deriving a pool", () => {
    const r = classifyLaunchpad(mint, { launchLabPool: launchLabPool(mint, { status: LAUNCHLAB_STATUS.trade, migrateType: LAUNCHLAB_MIGRATE_TYPE.ammV4 }) });
    expect(r).to.deep.include({ launchpad: "letsbonk.fun", stage: "graduated", venue: "raydium-amm-v4" });
    expect(r!.evidence.venueAccount).to.equal(undefined);
  });

  it("not LetsBONK: a LaunchLab pool under a DIFFERENT platform config is a LaunchLab launch but not a supported launchpad", () => {
    expect(classifyLaunchpad(mint, { launchLabPool: launchLabPool(mint, { platform: Keypair.generate().publicKey }) })).to.equal(null);
  });

  it("spoof: LaunchLab-shaped account owned by another program / at the wrong address is ignored", () => {
    expect(classifyLaunchpad(mint, { launchLabPool: launchLabPool(mint, { owner: Keypair.generate().publicKey }) })).to.equal(null);
    expect(classifyLaunchpad(mint, { launchLabPool: launchLabPool(mint, { address: Keypair.generate().publicKey }) })).to.equal(null);
  });
});

describe("launchpads.ts -- Bags.fm detection (Meteora DBC + Bags launch authority as creator)", () => {
  const mint = Keypair.generate().publicKey;

  it("bonding: a DBC VirtualPool for the mint whose creator is the Bags launch authority", () => {
    const r = classifyLaunchpad(mint, { dbcVirtualPools: [dbcPool(mint)] });
    expect(r).to.deep.include({ launchpad: "bags.fm", stage: "bonding", venue: null });
    expect(r!.evidence.platformIdentity).to.equal(BAGS_LAUNCH_AUTHORITY.toBase58());
  });

  it("graduated to Meteora DAMM v2 / v1 per the DBC migration-metadata PDA that exists", () => {
    const p2 = dbcPool(mint, { migrated: true });
    const r2 = classifyLaunchpad(mint, { dbcVirtualPools: [p2], dbcMigrationMetadata: { [p2.address.toBase58()]: { dammV2: dbcMeta(p2.address, "v2") } } });
    expect(r2).to.deep.include({ launchpad: "bags.fm", stage: "graduated", venue: "meteora-damm-v2" });
    const p1 = dbcPool(mint, { migrated: true });
    const r1 = classifyLaunchpad(mint, { dbcVirtualPools: [p1], dbcMigrationMetadata: { [p1.address.toBase58()]: { dammV1: dbcMeta(p1.address, "v1") } } });
    expect(r1).to.deep.include({ launchpad: "bags.fm", stage: "graduated", venue: "meteora-damm-v1" });
  });

  it("graduated with no migration metadata: venue unknown", () => {
    const p = dbcPool(mint, { migrated: true });
    expect(classifyLaunchpad(mint, { dbcVirtualPools: [p] })).to.deep.include({ launchpad: "bags.fm", stage: "graduated", venue: null });
  });

  it("not Bags: a DBC pool created by anyone else (another DBC partner, or someone copying the Bags config) is ignored", () => {
    expect(classifyLaunchpad(mint, { dbcVirtualPools: [dbcPool(mint, { creator: Keypair.generate().publicKey })] })).to.equal(null);
  });

  it("spoof: a Bags-created pool for a DIFFERENT base mint, or a VirtualPool-shaped account owned by another program, is ignored", () => {
    expect(classifyLaunchpad(mint, { dbcVirtualPools: [dbcPool(Keypair.generate().publicKey)] })).to.equal(null);
    expect(classifyLaunchpad(mint, { dbcVirtualPools: [dbcPool(mint, { owner: Keypair.generate().publicKey })] })).to.equal(null);
    expect(classifyLaunchpad(mint, { dbcVirtualPools: [dbcPool(mint, { disc: DISCRIMINATORS.pumpSwapPool })] })).to.equal(null);
  });

  it("spoof: migration metadata at a non-derived address or with the wrong discriminator does not upgrade the venue", () => {
    const p = dbcPool(mint, { migrated: true });
    const fake = acc(Keypair.generate().publicKey, METEORA_DBC_PROGRAM_ID, Buffer.from(dbcMeta(p.address, "v2").data));
    expect(classifyLaunchpad(mint, { dbcVirtualPools: [p], dbcMigrationMetadata: { [p.address.toBase58()]: { dammV2: fake } } })!.venue).to.equal(null);
  });
});

describe("launchpads.ts -- unsupported tokens and metadata-only imitation", () => {
  it("a mint with no launch account at all is null, whatever its name, symbol, suffix or metadata claim", () => {
    // Names, symbols and URIs are never inputs to the classifier; a mint that
    // merely ends in 'pump' or is called 'Pump.fun Official' has nothing to
    // classify from.
    const lookalike = Keypair.generate().publicKey;
    expect(classifyLaunchpad(lookalike, {})).to.equal(null);
    expect(classifyLaunchpad(lookalike, { pumpBondingCurve: null, pumpSwapCanonicalPool: null, launchLabPool: null, dbcVirtualPools: [], raydiumCpmmPools: [] })).to.equal(null);
  });

  it("the ORIGINAL launch wins when an adversary adds a second launch account for an existing token (precedence pump > letsbonk > bags, all evidence-based)", () => {
    const mint = Keypair.generate().publicKey;
    const r = classifyLaunchpad(mint, { pumpBondingCurve: pumpBondingCurve(mint, false), dbcVirtualPools: [dbcPool(mint)] });
    expect(r!.launchpad).to.equal("pump.fun");
  });
});

describe("lib/ledger/launchpadClassification.ts -- catalogue job helpers (pure)", () => {
  it("launchpadColumnsFor maps a provenance to the catalogue columns and null provenance to explicit nulls (checked, not unknown)", () => {
    const cols = launchpadColumnsFor({ launchpad: "pump.fun", stage: "graduated", venue: "pumpswap", evidence: { launchAccount: "A", launchProgram: "B", venueAccount: "C", venueProgram: "D" } });
    expect(cols).to.deep.equal({ launchpad: "pump.fun", launchpadStage: "graduated", launchpadVenue: "pumpswap", launchpadEvidence: { launchAccount: "A", launchProgram: "B", venueAccount: "C", venueProgram: "D" } });
    expect(launchpadColumnsFor(null)).to.deep.equal({ launchpad: null, launchpadStage: null, launchpadVenue: null, launchpadEvidence: null });
  });

  it("selectMintsToClassify prefers never-checked mints, then the stalest bonding-stage ones (they can graduate), then everything older than the re-check window", () => {
    const now = Date.parse("2026-09-18T00:00:00Z");
    const day = 86_400_000;
    const rows = [
      { mint: "never", launchpadCheckedAt: null, launchpadStage: null },
      { mint: "bonding-old", launchpadCheckedAt: new Date(now - 3 * day).toISOString(), launchpadStage: "bonding" },
      { mint: "graduated-recent", launchpadCheckedAt: new Date(now - 1 * day).toISOString(), launchpadStage: "graduated" },
      { mint: "none-old", launchpadCheckedAt: new Date(now - 40 * day).toISOString(), launchpadStage: null },
      { mint: "graduated-old", launchpadCheckedAt: new Date(now - 40 * day).toISOString(), launchpadStage: "graduated" },
    ];
    expect(selectMintsToClassify(rows, { now, limit: 10, bondingRecheckMs: 2 * day, fullRecheckMs: 30 * day })).to.deep.equal(["never", "bonding-old", "none-old", "graduated-old"]);
    expect(selectMintsToClassify(rows, { now, limit: 2, bondingRecheckMs: 2 * day, fullRecheckMs: 30 * day })).to.deep.equal(["never", "bonding-old"]);
  });
});

describe("api/ledger/asset-catalogue.ts -- provenance never changes eligibility", () => {
  const base = (over: Partial<CatalogueRow>): CatalogueRow => ({ mint: Keypair.generate().publicKey.toBase58(), symbol: "X", name: "X", decimals: 6, organicScore: 1, tokenProgram: null, launchpad: null, launchpadStage: null, launchpadVenue: null, ...over });

  it("a supported-launchpad token is still excluded when it is a Token-2022 mint or the reserved USDC symbol, exactly like any other token", () => {
    const rows = [
      base({ symbol: "T22", tokenProgram: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", launchpad: "bags.fm", launchpadStage: "graduated", launchpadVenue: "meteora-damm-v2" }),
      base({ symbol: "USDC", launchpad: "pump.fun", launchpadStage: "graduated", launchpadVenue: "pumpswap" }),
      base({ symbol: "OK", launchpad: "pump.fun", launchpadStage: "graduated", launchpadVenue: "pumpswap" }),
      base({ symbol: "PLAIN" }),
    ];
    const out = dedupeBySymbolPreferOrganicScore(rows);
    expect(out.map((t) => t.symbol).sort()).to.deep.equal(["OK", "PLAIN"]);
    expect(out.find((t) => t.symbol === "OK")!.launchpad).to.deep.equal({ id: "pump.fun", stage: "graduated", venue: "pumpswap" });
    expect(out.find((t) => t.symbol === "PLAIN")!.launchpad).to.equal(null);
  });

  it("symbol de-duplication still keys on organic score, never on launchpad", () => {
    const rows = [base({ symbol: "DUP", organicScore: 5, launchpad: "letsbonk.fun", launchpadStage: "bonding" }), base({ symbol: "DUP", organicScore: 9 })];
    const out = dedupeBySymbolPreferOrganicScore(rows);
    expect(out).to.have.length(1);
    expect(out[0].mint).to.equal(rows[1].mint);
    expect(out[0].launchpad).to.equal(null);
  });
});
