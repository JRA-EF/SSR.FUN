// Launchpad provenance for Solana tokens: which launchpad a mint was created
// on (Pump.fun, LetsBONK.fun, Bags.fm), whether it is still on its bonding
// curve or has graduated, and which venue its graduated liquidity lives on.
//
// DETECTION IS ON-CHAIN ONLY. A token is attributed to a launchpad only when
// a program-owned account that ONLY that launch program can create exists
// for the mint, with the expected Anchor discriminator and, where the launch
// program is shared by several platforms, the platform's own verified
// identity inside that account:
//
//   Pump.fun      the mint's BondingCurve PDA, owned by the pump program.
//                 Graduated when `complete == true`; the post-graduation
//                 venue is PumpSwap when the canonical pool (index 0, creator
//                 = the pump program's pool-authority PDA) exists.
//   LetsBONK.fun  the mint's Raydium LaunchLab PoolState PDA whose
//                 `platform_config` is LetsBONK's PlatformConfig account.
//                 Graduated when `status == Trade`; venue = the Raydium CPMM
//                 pool created by LaunchLab's own authority PDA.
//   Bags.fm       a Meteora Dynamic Bonding Curve VirtualPool for the mint
//                 whose `creator` is the Bags launch authority (a signer the
//                 program requires, so it cannot be forged). Graduated when
//                 `is_migrated == 1`; venue = Meteora DAMM v1 or v2 per the
//                 DBC migration-metadata PDA that exists.
//
// Names, symbols, metadata URIs, mint-address suffixes ("...pump", "...bonk",
// "...BAGS"), API labels and website domains are NEVER consulted: they are
// free to imitate. Every constant below was verified against live Mainnet
// account bytes on 2026-09-18 -- see docs/protocol/LAUNCHPADS.md for the
// evidence and the exact byte layouts.
//
// Provenance is INFORMATIONAL. It never makes a token eligible as a Reserve
// asset and never bypasses any existing check (Jupiter verified list,
// Token-2022 exclusion, symbol de-duplication, catalogue status). See
// api/ledger/asset-catalogue.ts.
import { Connection, PublicKey } from "@solana/web3.js";
import { WRAPPED_SOL_MINT } from "./zapPricing";

// ---------------------------------------------------------------------------
// Verified program and account identifiers (Solana Mainnet)
// ---------------------------------------------------------------------------

/** Pump.fun bonding-curve program. */
export const PUMP_PROGRAM_ID = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
/** PumpSwap AMM (Pump.fun's post-graduation venue since 2025-03-20). */
export const PUMPSWAP_PROGRAM_ID = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
/** Raydium LaunchLab (the launch program LetsBONK.fun runs on). */
export const RAYDIUM_LAUNCHLAB_PROGRAM_ID = new PublicKey("LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj");
/** Raydium CPMM (constant-product AMM LaunchLab migrates into). */
export const RAYDIUM_CPMM_PROGRAM_ID = new PublicKey("CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C");
/** Raydium AMM v4 (legacy migration target for both Pump.fun pre-2025-03 and LaunchLab migrateType 0). */
export const RAYDIUM_AMM_V4_PROGRAM_ID = new PublicKey("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8");
/** Meteora Dynamic Bonding Curve (the launch program Bags.fm runs on). */
export const METEORA_DBC_PROGRAM_ID = new PublicKey("dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN");
/** Meteora DAMM v1 (legacy DBC migration target). */
export const METEORA_DAMM_V1_PROGRAM_ID = new PublicKey("Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB");
/** Meteora DAMM v2. */
export const METEORA_DAMM_V2_PROGRAM_ID = new PublicKey("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG");


/** LetsBONK.fun's Raydium LaunchLab PlatformConfig (on-chain name "letsbonk.fun", web "https://letsbonk.fun/"). */
export const LETSBONK_PLATFORM_CONFIG = new PublicKey("FfYek5vEz23cMkWsdJwG2oa6EphsvXSHrGpdALN4g6W1");
/** LaunchLab's authority PDA (["vault_auth_seed"]) -- the creator of every LaunchLab-migrated Raydium CPMM pool. */
export const RAYDIUM_LAUNCHLAB_AUTHORITY = PublicKey.findProgramAddressSync([Buffer.from("vault_auth_seed")], RAYDIUM_LAUNCHLAB_PROGRAM_ID)[0];
/** Bags.fm launch authority: the required `creator` signer of every Bags DBC virtual pool (and the update authority of Bags token metadata). */
export const BAGS_LAUNCH_AUTHORITY = new PublicKey("BAGSB9TpGrZxQbEsrEznv5jXXdwyP6AXerN8aVRiAmcv");
/** Pump.fun's mint-authority PDA (["mint-authority"]) -- update authority of pump token metadata; informational only. */
export const PUMP_MINT_AUTHORITY = PublicKey.findProgramAddressSync([Buffer.from("mint-authority")], PUMP_PROGRAM_ID)[0];

/** Anchor account discriminators: sha256("account:<Name>")[0..8]. */
export const DISCRIMINATORS = {
  pumpBondingCurve: Uint8Array.from([23, 183, 248, 55, 96, 216, 172, 96]),
  pumpSwapPool: Uint8Array.from([241, 154, 109, 4, 17, 177, 109, 188]),
  launchLabPoolState: Uint8Array.from([247, 237, 227, 245, 215, 195, 222, 70]),
  launchLabPlatformConfig: Uint8Array.from([160, 78, 128, 0, 248, 83, 230, 160]),
  dbcVirtualPool: Uint8Array.from([213, 224, 5, 209, 98, 69, 119, 92]),
  dbcDammV1MigrationMetadata: Uint8Array.from([17, 155, 141, 215, 207, 4, 133, 156]),
  dbcDammV2Metadata: Uint8Array.from([104, 221, 219, 203, 10, 142, 250, 163]),
} as const;

/** Verified byte offsets (from the start of account data, discriminator included). */
export const LAYOUT = {
  pumpBondingCurve: { minLen: 49, complete: 48, creator: 49 },
  pumpSwapPool: { minLen: 107, bump: 8, index: 9, creator: 11, baseMint: 43, quoteMint: 75 },
  launchLabPoolState: { len: 429, status: 17, migrateType: 20, globalConfig: 141, platformConfig: 173, baseMint: 205, quoteMint: 237, creator: 333 },
  raydiumCpmmPool: { minLen: 232, ammConfig: 8, poolCreator: 40, token0Mint: 168, token1Mint: 200 },
  dbcVirtualPool: { len: 424, config: 72, creator: 104, baseMint: 136, poolType: 304, isMigrated: 305, migrationProgress: 308 },
} as const;

/** LaunchLab PoolState.status. */
export const LAUNCHLAB_STATUS = { fund: 0, migrate: 1, trade: 2 } as const;
/** LaunchLab PoolState.migrate_type. */
export const LAUNCHLAB_MIGRATE_TYPE = { ammV4: 0, cpmm: 1 } as const;
/** DBC VirtualPool.migration_progress. */
export const DBC_MIGRATION_PROGRESS = { preBondingCurve: 0, postBondingCurve: 1, lockedVesting: 2, createdPool: 3 } as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LaunchpadId = "pump.fun" | "letsbonk.fun" | "bags.fm";
export type LaunchpadStage = "bonding" | "graduated";
export type LaunchpadVenue = "pumpswap" | "raydium-cpmm" | "raydium-amm-v4" | "meteora-damm-v1" | "meteora-damm-v2";

export interface LaunchpadEvidence {
  /** The program-owned account that proves the launch (bonding curve / pool state / virtual pool). */
  launchAccount: string;
  launchProgram: string;
  /** The platform identity inside the launch account, when the launch program is shared (LaunchLab platform config, DBC creator). */
  platformIdentity?: string;
  /** The graduated-liquidity pool when it could be located on-chain. */
  venueAccount?: string;
  venueProgram?: string;
}

export interface LaunchpadProvenance {
  launchpad: LaunchpadId;
  stage: LaunchpadStage;
  /** null while bonding, or when graduated but the venue pool could not be located/derived (see docs). */
  venue: LaunchpadVenue | null;
  evidence: LaunchpadEvidence;
}

/** User-facing names. "Launchpad" is where the token was created; "venue" is where it trades after graduating. */
export const LAUNCHPAD_LABELS: Record<LaunchpadId, { name: string; site: string; graduationVenue: string }> = {
  "pump.fun": { name: "Pump.fun", site: "pump.fun", graduationVenue: "PumpSwap" },
  "letsbonk.fun": { name: "LetsBONK.fun", site: "letsbonk.fun", graduationVenue: "Raydium" },
  "bags.fm": { name: "Bags.fm", site: "bags.fm", graduationVenue: "Meteora" },
};

export const LAUNCHPAD_VENUE_LABELS: Record<LaunchpadVenue, string> = {
  pumpswap: "PumpSwap",
  "raydium-cpmm": "Raydium CPMM",
  "raydium-amm-v4": "Raydium AMM v4",
  "meteora-damm-v1": "Meteora DAMM v1",
  "meteora-damm-v2": "Meteora DAMM v2",
};

export const SUPPORTED_LAUNCHPADS: readonly LaunchpadId[] = ["pump.fun", "letsbonk.fun", "bags.fm"];

export function isLaunchpadId(v: unknown): v is LaunchpadId {
  return v === "pump.fun" || v === "letsbonk.fun" || v === "bags.fm";
}

/** A fetched account as the pure classifier sees it. */
export interface AccountLike {
  address: PublicKey;
  owner: PublicKey;
  data: Uint8Array;
}

// ---------------------------------------------------------------------------
// Address derivation (pure)
// ---------------------------------------------------------------------------

export function derivePumpBondingCurve(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("bonding-curve"), mint.toBuffer()], PUMP_PROGRAM_ID)[0];
}

/** The pump program's per-mint pool authority PDA -- the `creator` of the canonical PumpSwap pool. */
export function derivePumpPoolAuthority(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("pool-authority"), mint.toBuffer()], PUMP_PROGRAM_ID)[0];
}

/** PumpSwap pool PDA: ["pool", u16 index (LE), creator, base_mint, quote_mint]. The canonical (migration) pool is index 0, creator = pool authority. */
export function derivePumpSwapPool(index: number, creator: PublicKey, baseMint: PublicKey, quoteMint: PublicKey): PublicKey {
  const idx = Buffer.alloc(2);
  idx.writeUInt16LE(index);
  return PublicKey.findProgramAddressSync([Buffer.from("pool"), idx, creator.toBuffer(), baseMint.toBuffer(), quoteMint.toBuffer()], PUMPSWAP_PROGRAM_ID)[0];
}

export function derivePumpSwapCanonicalPool(mint: PublicKey): PublicKey {
  return derivePumpSwapPool(0, derivePumpPoolAuthority(mint), mint, WRAPPED_SOL_MINT);
}

/** Raydium LaunchLab PoolState PDA: ["pool", base_mint, quote_mint]. */
export function deriveLaunchLabPool(baseMint: PublicKey, quoteMint: PublicKey = WRAPPED_SOL_MINT): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("pool"), baseMint.toBuffer(), quoteMint.toBuffer()], RAYDIUM_LAUNCHLAB_PROGRAM_ID)[0];
}

/** Raydium CPMM pool PDA: ["pool", amm_config, token_0_mint, token_1_mint] with the mints in byte order. */
export function deriveRaydiumCpmmPool(ammConfig: PublicKey, mintA: PublicKey, mintB: PublicKey): PublicKey {
  const [m0, m1] = Buffer.compare(mintA.toBuffer(), mintB.toBuffer()) < 0 ? [mintA, mintB] : [mintB, mintA];
  return PublicKey.findProgramAddressSync([Buffer.from("pool"), ammConfig.toBuffer(), m0.toBuffer(), m1.toBuffer()], RAYDIUM_CPMM_PROGRAM_ID)[0];
}

/** DBC migration-metadata PDAs: ["meteora", virtual_pool] (DAMM v1) and ["damm_v2", virtual_pool] (DAMM v2). */
export function deriveDbcDammV1MigrationMetadata(virtualPool: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("meteora"), virtualPool.toBuffer()], METEORA_DBC_PROGRAM_ID)[0];
}
export function deriveDbcDammV2MigrationMetadata(virtualPool: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("damm_v2"), virtualPool.toBuffer()], METEORA_DBC_PROGRAM_ID)[0];
}

// ---------------------------------------------------------------------------
// Decoders (pure; return null unless owner, discriminator and length all match)
// ---------------------------------------------------------------------------

function hasDiscriminator(data: Uint8Array, d: Uint8Array): boolean {
  if (data.length < 8) return false;
  for (let i = 0; i < 8; i++) if (data[i] !== d[i]) return false;
  return true;
}
const pk = (d: Uint8Array, o: number) => new PublicKey(d.subarray(o, o + 32));

export interface PumpBondingCurveView {
  complete: boolean;
  creator: string | null;
}
export function decodePumpBondingCurve(acc: AccountLike): PumpBondingCurveView | null {
  const L = LAYOUT.pumpBondingCurve;
  if (!acc.owner.equals(PUMP_PROGRAM_ID) || !hasDiscriminator(acc.data, DISCRIMINATORS.pumpBondingCurve) || acc.data.length < L.minLen) return null;
  return { complete: acc.data[L.complete] === 1, creator: acc.data.length >= L.creator + 32 ? pk(acc.data, L.creator).toBase58() : null };
}

export interface PumpSwapPoolView {
  index: number;
  creator: string;
  baseMint: string;
  quoteMint: string;
}
export function decodePumpSwapPool(acc: AccountLike): PumpSwapPoolView | null {
  const L = LAYOUT.pumpSwapPool;
  if (!acc.owner.equals(PUMPSWAP_PROGRAM_ID) || !hasDiscriminator(acc.data, DISCRIMINATORS.pumpSwapPool) || acc.data.length < L.minLen) return null;
  const d = Buffer.from(acc.data);
  return { index: d.readUInt16LE(L.index), creator: pk(d, L.creator).toBase58(), baseMint: pk(d, L.baseMint).toBase58(), quoteMint: pk(d, L.quoteMint).toBase58() };
}

export interface LaunchLabPoolStateView {
  status: number;
  migrateType: number;
  platformConfig: string;
  baseMint: string;
  quoteMint: string;
  creator: string;
}
export function decodeLaunchLabPoolState(acc: AccountLike): LaunchLabPoolStateView | null {
  const L = LAYOUT.launchLabPoolState;
  if (!acc.owner.equals(RAYDIUM_LAUNCHLAB_PROGRAM_ID) || !hasDiscriminator(acc.data, DISCRIMINATORS.launchLabPoolState) || acc.data.length < L.len) return null;
  const d = acc.data;
  return {
    status: d[L.status],
    migrateType: d[L.migrateType],
    platformConfig: pk(d, L.platformConfig).toBase58(),
    baseMint: pk(d, L.baseMint).toBase58(),
    quoteMint: pk(d, L.quoteMint).toBase58(),
    creator: pk(d, L.creator).toBase58(),
  };
}

export interface RaydiumCpmmPoolView {
  ammConfig: string;
  poolCreator: string;
  token0Mint: string;
  token1Mint: string;
}
export function decodeRaydiumCpmmPool(acc: AccountLike): RaydiumCpmmPoolView | null {
  const L = LAYOUT.raydiumCpmmPool;
  if (!acc.owner.equals(RAYDIUM_CPMM_PROGRAM_ID) || acc.data.length < L.minLen) return null;
  const d = acc.data;
  return { ammConfig: pk(d, L.ammConfig).toBase58(), poolCreator: pk(d, L.poolCreator).toBase58(), token0Mint: pk(d, L.token0Mint).toBase58(), token1Mint: pk(d, L.token1Mint).toBase58() };
}

export interface DbcVirtualPoolView {
  config: string;
  creator: string;
  baseMint: string;
  poolType: number;
  isMigrated: boolean;
  migrationProgress: number;
}
export function decodeDbcVirtualPool(acc: AccountLike): DbcVirtualPoolView | null {
  const L = LAYOUT.dbcVirtualPool;
  if (!acc.owner.equals(METEORA_DBC_PROGRAM_ID) || !hasDiscriminator(acc.data, DISCRIMINATORS.dbcVirtualPool) || acc.data.length < L.len) return null;
  const d = acc.data;
  return {
    config: pk(d, L.config).toBase58(),
    creator: pk(d, L.creator).toBase58(),
    baseMint: pk(d, L.baseMint).toBase58(),
    poolType: d[L.poolType],
    isMigrated: d[L.isMigrated] === 1,
    migrationProgress: d[L.migrationProgress],
  };
}

// ---------------------------------------------------------------------------
// Pure classification
// ---------------------------------------------------------------------------

/** Everything the classifier may look at for one mint. Absent/undefined entries mean "not fetched or does not exist". */
export interface LaunchpadAccountSet {
  /** The mint's pump BondingCurve PDA (derivePumpBondingCurve). */
  pumpBondingCurve?: AccountLike | null;
  /** The canonical PumpSwap pool PDA (derivePumpSwapCanonicalPool). */
  pumpSwapCanonicalPool?: AccountLike | null;
  /** The mint's LaunchLab PoolState PDA against WSOL (deriveLaunchLabPool). */
  launchLabPool?: AccountLike | null;
  /** Raydium CPMM pools that include the mint (any); the classifier keeps only the one LaunchLab's authority created. */
  raydiumCpmmPools?: AccountLike[];
  /** DBC virtual pools whose base_mint is the mint (any creator); the classifier keeps only Bags-created ones. */
  dbcVirtualPools?: AccountLike[];
  /** Existence of the DBC migration-metadata PDAs, keyed by virtual-pool address. */
  dbcMigrationMetadata?: Record<string, { dammV1?: AccountLike | null; dammV2?: AccountLike | null }>;
}

/**
 * Classifies a mint from already-fetched accounts. Order of precedence is
 * Pump.fun, then LetsBONK.fun, then Bags.fm; a mint can only genuinely have
 * one launch account, so precedence only matters for adversarial inputs
 * (someone creating, say, a DBC pool for an existing pump token) -- and the
 * ORIGINAL launch wins because its account was created by the launch itself.
 */
export function classifyLaunchpad(mint: PublicKey, accounts: LaunchpadAccountSet): LaunchpadProvenance | null {
  const mintStr = mint.toBase58();

  // --- Pump.fun -----------------------------------------------------------
  if (accounts.pumpBondingCurve) {
    const curve = decodePumpBondingCurve(accounts.pumpBondingCurve);
    if (curve && accounts.pumpBondingCurve.address.equals(derivePumpBondingCurve(mint))) {
      const evidence: LaunchpadEvidence = { launchAccount: accounts.pumpBondingCurve.address.toBase58(), launchProgram: PUMP_PROGRAM_ID.toBase58() };
      if (!curve.complete) return { launchpad: "pump.fun", stage: "bonding", venue: null, evidence };
      const poolAcc = accounts.pumpSwapCanonicalPool ?? null;
      const pool = poolAcc ? decodePumpSwapPool(poolAcc) : null;
      const canonical =
        pool &&
        poolAcc!.address.equals(derivePumpSwapCanonicalPool(mint)) &&
        pool.index === 0 &&
        pool.creator === derivePumpPoolAuthority(mint).toBase58() &&
        pool.baseMint === mintStr;
      if (canonical) {
        return { launchpad: "pump.fun", stage: "graduated", venue: "pumpswap", evidence: { ...evidence, venueAccount: poolAcc!.address.toBase58(), venueProgram: PUMPSWAP_PROGRAM_ID.toBase58() } };
      }
      // Completed curve without a canonical PumpSwap pool: a pre-2025-03-20
      // graduation that migrated to Raydium AMM v4 (pool not derived here),
      // or a curve completed but not yet migrated. Reported as graduated with
      // an unknown venue rather than guessing.
      return { launchpad: "pump.fun", stage: "graduated", venue: null, evidence };
    }
  }

  // --- LetsBONK.fun (Raydium LaunchLab + LetsBONK platform config) --------
  if (accounts.launchLabPool) {
    const state = decodeLaunchLabPoolState(accounts.launchLabPool);
    if (
      state &&
      accounts.launchLabPool.address.equals(deriveLaunchLabPool(mint, new PublicKey(state.quoteMint))) &&
      state.baseMint === mintStr &&
      state.platformConfig === LETSBONK_PLATFORM_CONFIG.toBase58()
    ) {
      const evidence: LaunchpadEvidence = {
        launchAccount: accounts.launchLabPool.address.toBase58(),
        launchProgram: RAYDIUM_LAUNCHLAB_PROGRAM_ID.toBase58(),
        platformIdentity: LETSBONK_PLATFORM_CONFIG.toBase58(),
      };
      if (state.status !== LAUNCHLAB_STATUS.trade) return { launchpad: "letsbonk.fun", stage: "bonding", venue: null, evidence };
      if (state.migrateType === LAUNCHLAB_MIGRATE_TYPE.cpmm) {
        const authority = RAYDIUM_LAUNCHLAB_AUTHORITY.toBase58();
        for (const acc of accounts.raydiumCpmmPools ?? []) {
          const p = decodeRaydiumCpmmPool(acc);
          if (!p || p.poolCreator !== authority) continue;
          if (p.token0Mint !== mintStr && p.token1Mint !== mintStr) continue;
          if (!acc.address.equals(deriveRaydiumCpmmPool(new PublicKey(p.ammConfig), new PublicKey(p.token0Mint), new PublicKey(p.token1Mint)))) continue;
          return { launchpad: "letsbonk.fun", stage: "graduated", venue: "raydium-cpmm", evidence: { ...evidence, venueAccount: acc.address.toBase58(), venueProgram: RAYDIUM_CPMM_PROGRAM_ID.toBase58() } };
        }
        return { launchpad: "letsbonk.fun", stage: "graduated", venue: null, evidence };
      }
      // migrateType 0: Raydium AMM v4 -- venue known from the pool state, pool address not derived here.
      return { launchpad: "letsbonk.fun", stage: "graduated", venue: "raydium-amm-v4", evidence: { ...evidence, venueProgram: RAYDIUM_AMM_V4_PROGRAM_ID.toBase58() } };
    }
  }

  // --- Bags.fm (Meteora DBC + Bags launch authority as pool creator) ------
  for (const acc of accounts.dbcVirtualPools ?? []) {
    const pool = decodeDbcVirtualPool(acc);
    if (!pool || pool.baseMint !== mintStr || pool.creator !== BAGS_LAUNCH_AUTHORITY.toBase58()) continue;
    const evidence: LaunchpadEvidence = {
      launchAccount: acc.address.toBase58(),
      launchProgram: METEORA_DBC_PROGRAM_ID.toBase58(),
      platformIdentity: BAGS_LAUNCH_AUTHORITY.toBase58(),
    };
    if (!pool.isMigrated) return { launchpad: "bags.fm", stage: "bonding", venue: null, evidence };
    const meta = accounts.dbcMigrationMetadata?.[acc.address.toBase58()];
    const v2 = meta?.dammV2 ?? null;
    const v1 = meta?.dammV1 ?? null;
    if (v2 && v2.owner.equals(METEORA_DBC_PROGRAM_ID) && hasDiscriminator(v2.data, DISCRIMINATORS.dbcDammV2Metadata) && v2.address.equals(deriveDbcDammV2MigrationMetadata(acc.address))) {
      return { launchpad: "bags.fm", stage: "graduated", venue: "meteora-damm-v2", evidence: { ...evidence, venueProgram: METEORA_DAMM_V2_PROGRAM_ID.toBase58(), venueAccount: v2.address.toBase58() } };
    }
    if (v1 && v1.owner.equals(METEORA_DBC_PROGRAM_ID) && hasDiscriminator(v1.data, DISCRIMINATORS.dbcDammV1MigrationMetadata) && v1.address.equals(deriveDbcDammV1MigrationMetadata(acc.address))) {
      return { launchpad: "bags.fm", stage: "graduated", venue: "meteora-damm-v1", evidence: { ...evidence, venueProgram: METEORA_DAMM_V1_PROGRAM_ID.toBase58(), venueAccount: v1.address.toBase58() } };
    }
    return { launchpad: "bags.fm", stage: "graduated", venue: null, evidence };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

const toAccountLike = (address: PublicKey, info: { owner: PublicKey; data: Uint8Array | Buffer } | null): AccountLike | null =>
  info ? { address, owner: info.owner, data: Uint8Array.from(info.data) } : null;

/**
 * Fetches everything classifyLaunchpad needs for one mint and classifies it.
 * Cost: one getMultipleAccountsInfo for the three PDAs, then at most a few
 * filtered getProgramAccounts calls, only on the branch the PDAs point to.
 * Throws on RPC failure (never returns null for "could not check").
 */
export async function detectLaunchpad(connection: Connection, mint: PublicKey): Promise<LaunchpadProvenance | null> {
  const bondingCurve = derivePumpBondingCurve(mint);
  const canonicalPool = derivePumpSwapCanonicalPool(mint);
  const launchLabPool = deriveLaunchLabPool(mint);
  const [bc, cp, ll] = await connection.getMultipleAccountsInfo([bondingCurve, canonicalPool, launchLabPool], "confirmed");
  const set: LaunchpadAccountSet = {
    pumpBondingCurve: toAccountLike(bondingCurve, bc),
    pumpSwapCanonicalPool: toAccountLike(canonicalPool, cp),
    launchLabPool: toAccountLike(launchLabPool, ll),
  };
  if (set.pumpBondingCurve) return classifyLaunchpad(mint, set);

  if (set.launchLabPool) {
    const state = decodeLaunchLabPoolState(set.launchLabPool);
    if (state && state.status === LAUNCHLAB_STATUS.trade && state.migrateType === LAUNCHLAB_MIGRATE_TYPE.cpmm) {
      const L = LAYOUT.raydiumCpmmPool;
      const authority = RAYDIUM_LAUNCHLAB_AUTHORITY.toBase58();
      const pools: AccountLike[] = [];
      for (const off of [L.token0Mint, L.token1Mint]) {
        const res = await connection.getProgramAccounts(RAYDIUM_CPMM_PROGRAM_ID, {
          commitment: "confirmed",
          dataSlice: { offset: 0, length: L.minLen },
          filters: [
            { memcmp: { offset: L.poolCreator, bytes: authority } },
            { memcmp: { offset: off, bytes: mint.toBase58() } },
          ],
        });
        for (const r of res) pools.push({ address: r.pubkey, owner: r.account.owner, data: Uint8Array.from(r.account.data) });
      }
      set.raydiumCpmmPools = pools;
    }
    return classifyLaunchpad(mint, set);
  }

  // Bags: DBC virtual pools for this base mint created by the Bags authority.
  const L = LAYOUT.dbcVirtualPool;
  const res = await connection.getProgramAccounts(METEORA_DBC_PROGRAM_ID, {
    commitment: "confirmed",
    dataSlice: { offset: 0, length: L.len },
    filters: [
      { memcmp: { offset: L.creator, bytes: BAGS_LAUNCH_AUTHORITY.toBase58() } },
      { memcmp: { offset: L.baseMint, bytes: mint.toBase58() } },
    ],
  });
  set.dbcVirtualPools = res.map((r) => ({ address: r.pubkey, owner: r.account.owner, data: Uint8Array.from(r.account.data) }));
  const migrated = set.dbcVirtualPools.filter((a) => decodeDbcVirtualPool(a)?.isMigrated);
  if (migrated.length) {
    const keys = migrated.flatMap((a) => [deriveDbcDammV1MigrationMetadata(a.address), deriveDbcDammV2MigrationMetadata(a.address)]);
    const infos = await connection.getMultipleAccountsInfo(keys, "confirmed");
    set.dbcMigrationMetadata = {};
    migrated.forEach((a, i) => {
      set.dbcMigrationMetadata![a.address.toBase58()] = { dammV1: toAccountLike(keys[i * 2], infos[i * 2]), dammV2: toAccountLike(keys[i * 2 + 1], infos[i * 2 + 1]) };
    });
  }
  return classifyLaunchpad(mint, set);
}

/** Sequential-with-concurrency batch helper for catalogue jobs. Errors are returned per mint, never swallowed into "no launchpad". */
export async function detectLaunchpadsBatch(
  connection: Connection,
  mints: PublicKey[],
  options: { concurrency?: number } = {},
): Promise<Map<string, { provenance: LaunchpadProvenance | null; error?: string }>> {
  const out = new Map<string, { provenance: LaunchpadProvenance | null; error?: string }>();
  const concurrency = Math.max(1, options.concurrency ?? 4);
  let next = 0;
  async function worker() {
    while (next < mints.length) {
      const mint = mints[next++];
      try {
        out.set(mint.toBase58(), { provenance: await detectLaunchpad(connection, mint) });
      } catch (e) {
        out.set(mint.toBase58(), { provenance: null, error: e instanceof Error ? e.message : String(e) });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, mints.length) }, worker));
  return out;
}

// ---------------------------------------------------------------------------
// Catalogue-scale batch classification
// ---------------------------------------------------------------------------

/**
 * Classifies many mints with a bounded number of RPC calls -- for the
 * catalogue job (thousands of mints). Per-mint detectLaunchpad() would cost
 * a ~7-10s DBC program scan for every non-launchpad mint; here the Bags
 * membership comes from ONE scan of Bags-created DBC pools (base mints
 * only), and the pump/LaunchLab PDA lookups are batched 100 per call. Only
 * mints that turn out to be launchpad tokens pay for venue lookups.
 *
 * Results are keyed by mint; a mint whose lookups failed is reported with an
 * `error` and NO provenance, never as "not a launchpad token".
 */
export async function classifyMintsBatch(
  connection: Connection,
  mints: PublicKey[],
  options: { chunkSize?: number; concurrency?: number } = {},
): Promise<Map<string, { provenance: LaunchpadProvenance | null; error?: string }>> {
  const out = new Map<string, { provenance: LaunchpadProvenance | null; error?: string }>();
  if (mints.length === 0) return out;
  const chunk = Math.min(100, Math.max(1, options.chunkSize ?? 100));

  // 1. Pump bonding curves + LaunchLab pool states for every mint, batched.
  const sets = new Map<string, LaunchpadAccountSet>();
  const keys: PublicKey[] = [];
  for (const m of mints) keys.push(derivePumpBondingCurve(m), deriveLaunchLabPool(m));
  const infos: ({ owner: PublicKey; data: Buffer } | null)[] = [];
  for (let i = 0; i < keys.length; i += chunk) infos.push(...(await connection.getMultipleAccountsInfo(keys.slice(i, i + chunk), "confirmed")));
  mints.forEach((m, i) => {
    sets.set(m.toBase58(), {
      pumpBondingCurve: toAccountLike(keys[i * 2], infos[i * 2]),
      launchLabPool: toAccountLike(keys[i * 2 + 1], infos[i * 2 + 1]),
    });
  });

  // 2. Canonical PumpSwap pools for completed curves, batched.
  const completed = mints.filter((m) => {
    const bc = sets.get(m.toBase58())!.pumpBondingCurve;
    return bc && decodePumpBondingCurve(bc)?.complete;
  });
  const poolKeys = completed.map((m) => derivePumpSwapCanonicalPool(m));
  const poolInfos: ({ owner: PublicKey; data: Buffer } | null)[] = [];
  for (let i = 0; i < poolKeys.length; i += chunk) poolInfos.push(...(await connection.getMultipleAccountsInfo(poolKeys.slice(i, i + chunk), "confirmed")));
  completed.forEach((m, i) => {
    sets.get(m.toBase58())!.pumpSwapCanonicalPool = toAccountLike(poolKeys[i], poolInfos[i]);
  });

  // 3. LaunchLab graduations to CPMM: per-mint filtered scans (few mints).
  const L = LAYOUT.raydiumCpmmPool;
  const authority = RAYDIUM_LAUNCHLAB_AUTHORITY.toBase58();
  for (const m of mints) {
    const set = sets.get(m.toBase58())!;
    if (set.pumpBondingCurve || !set.launchLabPool) continue;
    const state = decodeLaunchLabPoolState(set.launchLabPool);
    if (!state || state.platformConfig !== LETSBONK_PLATFORM_CONFIG.toBase58()) continue;
    if (state.status !== LAUNCHLAB_STATUS.trade || state.migrateType !== LAUNCHLAB_MIGRATE_TYPE.cpmm) continue;
    try {
      const pools: AccountLike[] = [];
      for (const off of [L.token0Mint, L.token1Mint]) {
        const res = await connection.getProgramAccounts(RAYDIUM_CPMM_PROGRAM_ID, {
          commitment: "confirmed",
          dataSlice: { offset: 0, length: L.minLen },
          filters: [{ memcmp: { offset: L.poolCreator, bytes: authority } }, { memcmp: { offset: off, bytes: m.toBase58() } }],
        });
        for (const r of res) pools.push({ address: r.pubkey, owner: r.account.owner, data: Uint8Array.from(r.account.data) });
      }
      set.raydiumCpmmPools = pools;
    } catch (e) {
      out.set(m.toBase58(), { provenance: null, error: "cpmm lookup failed: " + (e instanceof Error ? e.message : String(e)) });
    }
  }

  // 4. Bags: which of the remaining mints have a Bags-created DBC pool -- one
  //    scan (base mints only), then details only for members.
  const remaining = mints.filter((m) => {
    const set = sets.get(m.toBase58())!;
    return !set.pumpBondingCurve && !set.launchLabPool && !out.has(m.toBase58());
  });
  if (remaining.length > 0) {
    const D = LAYOUT.dbcVirtualPool;
    let bagsBaseMints: Set<string> | null = null;
    try {
      const scan = await connection.getProgramAccounts(METEORA_DBC_PROGRAM_ID, {
        commitment: "confirmed",
        dataSlice: { offset: D.baseMint, length: 32 },
        filters: [{ memcmp: { offset: D.creator, bytes: BAGS_LAUNCH_AUTHORITY.toBase58() } }],
      });
      bagsBaseMints = new Set(scan.map((r) => new PublicKey(r.account.data).toBase58()));
    } catch (e) {
      for (const m of remaining) out.set(m.toBase58(), { provenance: null, error: "dbc scan failed: " + (e instanceof Error ? e.message : String(e)) });
    }
    if (bagsBaseMints) {
      for (const m of remaining) {
        const set = sets.get(m.toBase58())!;
        if (!bagsBaseMints.has(m.toBase58())) {
          set.dbcVirtualPools = [];
          continue;
        }
        try {
          const res = await connection.getProgramAccounts(METEORA_DBC_PROGRAM_ID, {
            commitment: "confirmed",
            dataSlice: { offset: 0, length: D.len },
            filters: [{ memcmp: { offset: D.creator, bytes: BAGS_LAUNCH_AUTHORITY.toBase58() } }, { memcmp: { offset: D.baseMint, bytes: m.toBase58() } }],
          });
          set.dbcVirtualPools = res.map((r) => ({ address: r.pubkey, owner: r.account.owner, data: Uint8Array.from(r.account.data) }));
          const migrated = set.dbcVirtualPools.filter((a) => decodeDbcVirtualPool(a)?.isMigrated);
          if (migrated.length) {
            const mk = migrated.flatMap((a) => [deriveDbcDammV1MigrationMetadata(a.address), deriveDbcDammV2MigrationMetadata(a.address)]);
            const mi = await connection.getMultipleAccountsInfo(mk, "confirmed");
            set.dbcMigrationMetadata = {};
            migrated.forEach((a, i) => {
              set.dbcMigrationMetadata![a.address.toBase58()] = { dammV1: toAccountLike(mk[i * 2], mi[i * 2]), dammV2: toAccountLike(mk[i * 2 + 1], mi[i * 2 + 1]) };
            });
          }
        } catch (e) {
          out.set(m.toBase58(), { provenance: null, error: "dbc pool lookup failed: " + (e instanceof Error ? e.message : String(e)) });
        }
      }
    }
  }

  for (const m of mints) {
    const key = m.toBase58();
    if (out.has(key)) continue;
    out.set(key, { provenance: classifyLaunchpad(m, sets.get(key)!) });
  }
  return out;
}
