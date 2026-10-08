/** Raydium cp-swap b3187ae53a1b95a201f855a59024a12ca8f5b51a.
 * Read/prepare only: this adapter never signs or submits transactions.
 * Compound deliberately has no builder until OPEN-13 is resolved.
 */
import { PublicKey, SystemProgram, TransactionInstruction, type AccountInfo, type Connection } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";

export const RAYDIUM_CPMM = new PublicKey("CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C");
export const SSR_POOL_PAYER = new PublicKey("6smLxV5X1n7wYPGN4F6EsFNHTPizmUNQkdBBHMCFoqAS");
export const SSR_CPMM_CONFIG = new PublicKey("LNmHRmMvk9kmtepfTSr98kqGLThd61kH1DPWf2cVRaC");
export const LIQUIDITY_USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const DENOMINATOR = 1_000_000n;
const DISCRIMINATORS = {
  Permission: [224,83,28,79,10,253,161,28],
  AmmConfig: [218,244,33,104,203,203,43,111],
  PoolState: [247,237,227,245,215,195,222,70],
  CreatorFeeShare: [30,235,98,252,26,197,66,86],
};
function pda(...seeds: Buffer[]): PublicKey {
  return PublicKey.findProgramAddressSync(seeds, RAYDIUM_CPMM)[0];
}
export function permissionAddress(payer = SSR_POOL_PAYER): PublicKey {
  return pda(Buffer.from("permission"), payer.toBuffer());
}
export function creatorShareAddress(creator: PublicKey): PublicKey {
  return pda(Buffer.from("creator_fee_share"), creator.toBuffer(), SSR_CPMM_CONFIG.toBuffer());
}
function checked(account: AccountInfo<Buffer> | null, kind: keyof typeof DISCRIMINATORS, size: number): Buffer {
  if (!account || !account.owner.equals(RAYDIUM_CPMM) || account.data.length !== size ||
      !account.data.subarray(0,8).equals(Buffer.from(DISCRIMINATORS[kind]))) {
    throw new Error(`Invalid Raydium ${kind} account`);
  }
  return account.data;
}
function rate(value: bigint): bigint {
  if (value > DENOMINATOR) throw new Error("Invalid Raydium fee rate");
  return value;
}
export function verifyPermission(account: AccountInfo<Buffer> | null, payer = SSR_POOL_PAYER): void {
  const b = checked(account, "Permission", 280);
  if (!new PublicKey(b.subarray(8,40)).equals(payer)) throw new Error("Raydium permission belongs to another payer");
}
export function decodeConfig(account: AccountInfo<Buffer> | null) {
  const b = checked(account, "AmmConfig", 236);
  if (b.readUInt16LE(10) !== 9 || b[9] !== 0) throw new Error("Raydium config 9 is unavailable");
  const tradeFeeRate = rate(b.readBigUInt64LE(12));
  const creatorFeeRate = rate(b.readBigUInt64LE(108));
  if (tradeFeeRate !== 2500n || creatorFeeRate !== 7500n) throw new Error("Raydium fee economics changed; review before creating a pool");
  return { tradeFeeRate, creatorFeeRate, creatorFeeShareRate: rate(b.readBigUInt64LE(116)), createPoolLamports: b.readBigUInt64LE(36) };
}
export function effectiveCreatorShare(account: AccountInfo<Buffer> | null, creator: PublicKey, fallback: bigint): bigint {
  if (!account || account.data.length === 0 || !account.owner.equals(RAYDIUM_CPMM)) return rate(fallback);
  const b = checked(account, "CreatorFeeShare", 145);
  if (!new PublicKey(b.subarray(9,41)).equals(creator) || !new PublicKey(b.subarray(41,73)).equals(SSR_CPMM_CONFIG)) {
    throw new Error("Raydium creator fee override does not match the treasury/config");
  }
  return rate(b.readBigUInt64LE(73));
}
export function netCreatorEarnings(accrued: bigint, shareRate: bigint): bigint {
  if (accrued < 0n) throw new Error("Negative creator earnings");
  return accrued - accrued * rate(shareRate) / DENOMINATOR;
}
export function decodePool(account: AccountInfo<Buffer> | null, reserveMint: PublicKey, treasury: PublicKey) {
  const b = checked(account, "PoolState", 637);
  const key = (offset: number) => new PublicKey(b.subarray(offset, offset + 32));
  const config = key(8), creator = key(40), mint0 = key(168), mint1 = key(200);
  if (!config.equals(SSR_CPMM_CONFIG) || !creator.equals(treasury)) throw new Error("Pool config or fixed creator treasury mismatch");
  const usdc0 = mint0.equals(LIQUIDITY_USDC), usdc1 = mint1.equals(LIQUIDITY_USDC);
  if (!(usdc0 && mint1.equals(reserveMint)) && !(usdc1 && mint0.equals(reserveMint))) throw new Error("Pool is not the Reserve Token / USDC pair");
  // Packed PoolState: 10 pubkeys, 5 u8s, 7 u64s, creator_fee_on + enabled.
  if (b[389] !== (usdc0 ? 1 : 2) || b[390] !== 1) throw new Error("Pool does not collect native creator fees in USDC only");
  const program0 = key(232), program1 = key(264);
  for (const program of [program0,program1]) if (!program.equals(TOKEN_PROGRAM_ID) && !program.equals(TOKEN_2022_PROGRAM_ID)) throw new Error("Unsupported pool token program");
  if (!(usdc0 ? program0 : program1).equals(TOKEN_PROGRAM_ID)) throw new Error("Invalid USDC token program");
  return { creator, mint0, mint1, vault0: key(72), vault1: key(104), program0, program1,
    accruedUsdc: b.readBigUInt64LE(usdc0 ? 397 : 405) };
}

export class RaydiumPermissionedCpmmAdapter {
  readonly primitive = "raydium-permissioned-cpmm" as const;
  private readonly connection: Pick<Connection, "getMultipleAccountsInfo" | "getAccountInfo">;
  constructor(connection: Pick<Connection, "getMultipleAccountsInfo" | "getAccountInfo">) {
    this.connection = connection;
  }
  async readReadiness(treasury: PublicKey) {
    const [permission, config, override] = await this.connection.getMultipleAccountsInfo(
      [permissionAddress(), SSR_CPMM_CONFIG, creatorShareAddress(treasury)], "finalized");
    verifyPermission(permission);
    const fees = decodeConfig(config);
    const shareRate = effectiveCreatorShare(override, treasury, fees.creatorFeeShareRate);
    return { primitive: this.primitive, payer: SSR_POOL_PAYER, permission: permissionAddress(), ...fees, shareRate,
      netCreatorFeeRate: Number(fees.creatorFeeRate) * (1 - Number(shareRate) / Number(DENOMINATOR)),
      compoundAvailable: false as const, compoundBlocker: "OPEN-13" as const };
  }
  /** Any payer can collect; destination comes from verified PoolState, never from the caller's wallet. */
  async prepareCollect(input: { payer: PublicKey; pool: PublicKey; reserveMint: PublicKey; treasury: PublicKey }) {
    const pool = decodePool(await this.connection.getAccountInfo(input.pool, "finalized"), input.reserveMint, input.treasury);
    const readiness = await this.readReadiness(pool.creator);
    if (pool.accruedUsdc === 0n) throw new Error("No creator DEX earnings to collect");
    const authority = pda(Buffer.from("vault_and_lp_mint_auth_seed"));
    const meta = (pubkey: PublicKey, isWritable = false, isSigner = false) => ({ pubkey, isWritable, isSigner });
    const instruction = new TransactionInstruction({ programId: RAYDIUM_CPMM,
      data: Buffer.from([202,202,34,83,226,122,145,229]),
      keys: [meta(input.payer,true,true), meta(pool.creator), meta(authority), meta(input.pool,true),
        meta(pool.vault0,true),meta(pool.vault1,true),meta(pool.mint0),meta(pool.mint1),
        meta(getAssociatedTokenAddressSync(pool.mint0,pool.creator,true,pool.program0),true),
        meta(getAssociatedTokenAddressSync(pool.mint1,pool.creator,true,pool.program1),true),
        meta(pool.program0),meta(pool.program1),meta(ASSOCIATED_TOKEN_PROGRAM_ID),meta(SystemProgram.programId),
        meta(SSR_CPMM_CONFIG),meta(creatorShareAddress(pool.creator))] });
    return { instruction, treasury: pool.creator, grossUsdcRaw: pool.accruedUsdc,
      netUsdcRaw: netCreatorEarnings(pool.accruedUsdc, readiness.shareRate) };
  }
}
