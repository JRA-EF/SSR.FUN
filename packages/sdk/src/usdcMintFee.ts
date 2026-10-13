// DEC-0238: the mint fee paid in USDC at mint/seed time.
//
// `mint_reserve_tokens_in_kind_usdc_fee` and `seed_reserve_usdc_fee` mint the
// FULL requested Reserve Tokens to the minter (no fee shares) and move
// `usdc_fee` from the minter's USDC account to the Protocol Treasury and the
// Manager fee recipients inside the same instruction. Both require a
// co-signature from SSR's fee quote signer (the configured settlement keeper),
// which only SSR's server holds -- so these transactions are always built and
// co-signed server-side (lib/mainnet/buildBuy.ts, lib/mainnet/buildSeed.ts),
// then signed by the user's wallet.
//
// The USDC fee is the Reserve's effective mint-fee rate applied to the USD
// value of what the mint deposits, the same rate the share fee used to take.

import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import * as anchor from "@anchor-lang/core";
import { BN } from "@anchor-lang/core";
import type { Program } from "@anchor-lang/core";
import { assetAta, resolveLegTokenProgram } from "./tokenPrograms";
import { resolveMintTokenProgram } from "./readOnly";
import { findManagerFeeRecipients, findSettlementKeeperConfig, findTvlAccrual } from "./pda";
import type { NewReserveAddresses, ReserveAssetAddresses } from "./createReserveFlow";
import type { ZapAssetLeg } from "./zapInstructions";
import { computeMintRequirements, mulDivCeil } from "./calculations";
import { computeEffectiveFeeSplit, PROTOCOL_MIN_MINT_FEE_BPS } from "./feeMath";

const BPS = 10_000n;

/**
 * USDC fee (raw, 6 decimals) for a mint whose deposit is worth
 * `depositValueUsdcRaw`: the Reserve's EFFECTIVE mint-fee rate (configured
 * bps with the Protocol's 0.5% floor on its half -- the exact split the
 * program applies), rounded up in the protocol's favor. Zero when the
 * Reserve's configured mint fee is 0.
 */
export function computeUsdcMintFeeRaw(depositValueUsdcRaw: bigint, configuredMintFeeBps: number | bigint): bigint {
  const { effectiveTotalBps } = computeEffectiveFeeSplit(BigInt(configuredMintFeeBps), PROTOCOL_MIN_MINT_FEE_BPS);
  if (effectiveTotalBps === 0n || depositValueUsdcRaw <= 0n) return 0n;
  return mulDivCeil(depositValueUsdcRaw, effectiveTotalBps, BPS);
}

/** Effective mint-fee rate as a fraction (e.g. 0.01 for 1%), for display. */
export function effectiveMintFeeFraction(configuredMintFeeBps: number | bigint): number {
  const { effectiveTotalBps } = computeEffectiveFeeSplit(BigInt(configuredMintFeeBps), PROTOCOL_MIN_MINT_FEE_BPS);
  return Number(effectiveTotalBps) / 10_000;
}

/**
 * USD value (USDC raw units, 6 decimals) of a set of raw asset amounts at the
 * given USD prices. Floors per leg. Throws if any leg with a nonzero amount
 * has no usable price -- a fee must never be computed from a guess.
 */
export function valueAssetAmountsUsdcRaw(legs: { amountRaw: bigint; decimals: number; priceUsd: number | null | undefined }[]): bigint {
  let total = 0n;
  for (const leg of legs) {
    if (leg.amountRaw === 0n) continue;
    if (leg.priceUsd == null || !Number.isFinite(leg.priceUsd) || leg.priceUsd <= 0) {
      throw new Error("A reserve asset has no current price, so the USDC mint fee cannot be calculated.");
    }
    // price in micro-USD per whole token, kept integer to avoid float drift on large amounts.
    const microUsdPerToken = BigInt(Math.round(leg.priceUsd * 1_000_000));
    total += (leg.amountRaw * microUsdPerToken) / 10n ** BigInt(leg.decimals);
  }
  return total;
}

export interface UsdcMintFeeRouting {
  /** The Protocol Treasury (`ProtocolConfig.default_protocol_fee_destination`). */
  protocolFeeDestination: PublicKey;
  /** Active ManagerFeeRecipients wallets in slot order; empty when the Reserve has not opted in. */
  managerRecipients: { wallet: string | PublicKey }[];
  /** The Reserve's legacy `fee_config.fee_destination`; required when `managerRecipients` is empty. */
  legacyManagerDestination?: PublicKey;
}

interface UsdcFeeAccounts {
  accounts: Record<string, PublicKey>;
  managerUsdcAtas: PublicKey[];
}

function usdcFeeAccounts(programId: PublicKey, reserve: PublicKey, usdcMint: PublicKey, feeQuoteSigner: PublicKey, routing: UsdcMintFeeRouting): UsdcFeeAccounts {
  const usesMultiRecipient = routing.managerRecipients.length > 0;
  // allowOwnerOffCurve everywhere: the Treasury is a Squads vault PDA and
  // recipients may be PDAs too (see buildDistributeFeeUsdcInstruction).
  const managerUsdcAtas = usesMultiRecipient
    ? routing.managerRecipients.map((r) => getAssociatedTokenAddressSync(usdcMint, new PublicKey(r.wallet), true))
    : [
        getAssociatedTokenAddressSync(
          usdcMint,
          routing.legacyManagerDestination ??
            (() => {
              throw new Error("USDC mint fee: legacyManagerDestination is required when the Reserve has no Manager fee recipients.");
            })(),
          true,
        ),
      ];
  return {
    accounts: {
      settlementKeeperConfig: findSettlementKeeperConfig(programId)[0],
      feeQuoteSigner,
      usdcMint,
      protocolUsdcDestination: getAssociatedTokenAddressSync(usdcMint, routing.protocolFeeDestination, true),
      protocolFeeDestination: routing.protocolFeeDestination,
      // Always the PDA: the program itself treats an uninitialized one as "legacy destination".
      managerFeeRecipients: findManagerFeeRecipients(reserve, programId)[0],
      usdcTokenProgram: TOKEN_PROGRAM_ID,
    },
    managerUsdcAtas,
  };
}

/** Idempotent ATA creation for every Manager USDC destination (and the Treasury's), paid by `payer`. */
export function buildUsdcFeeDestinationAtaInstructions(payer: PublicKey, usdcMint: PublicKey, routing: UsdcMintFeeRouting): TransactionInstruction[] {
  const owners = [
    routing.protocolFeeDestination,
    ...(routing.managerRecipients.length > 0
      ? routing.managerRecipients.map((r) => new PublicKey(r.wallet))
      : routing.legacyManagerDestination
        ? [routing.legacyManagerDestination]
        : []),
  ];
  const seen = new Set<string>();
  const out: TransactionInstruction[] = [];
  for (const owner of owners) {
    const ata = getAssociatedTokenAddressSync(usdcMint, owner, true);
    if (seen.has(ata.toBase58())) continue;
    seen.add(ata.toBase58());
    out.push(createAssociatedTokenAccountIdempotentInstruction(payer, ata, owner, usdcMint, TOKEN_PROGRAM_ID));
  }
  return out;
}

export interface BuildMintWithUsdcFeeParams {
  program: Program<anchor.Idl>;
  protocolConfig: PublicKey;
  reserve: PublicKey;
  reserveTokenMint: PublicKey;
  mintAuthority: PublicKey;
  /** DEC-0229: classic for pre-DEC-0229 Reserves, Token-2022 after. Resolved from the mint when omitted. */
  reserveTokenProgram?: PublicKey;
  user: PublicKey;
  assets: ZapAssetLeg[];
  reserveTokenSupplyRaw: string;
  reserveTokensRequested: bigint;
  /** Fractional per-leg slippage buffer (0.02 = 2%). */
  slippageBps?: number;
  usdcFeeRaw: bigint;
  usdcMint: PublicKey;
  feeQuoteSigner: PublicKey;
  routing: UsdcMintFeeRouting;
  /** The user's USDC token account; defaults to their USDC ATA. */
  userUsdcAccount?: PublicKey;
}

export interface BuildMintWithUsdcFeeResult {
  /** [ATA creates..., mint instruction] -- the mint is always last. */
  instructions: TransactionInstruction[];
  reserveTokensRequested: bigint;
  requiredAmountsRaw: bigint[];
  /** Exactly `reserveTokensRequested`: no fee shares are withheld on this path. */
  expectedReserveTokensOut: bigint;
}

/**
 * Multi-leg in-kind mint with the mint fee paid in USDC
 * (`mint_reserve_tokens_in_kind_usdc_fee`). Same leg layout and slippage
 * semantics as buildDirectMultiAssetMintInstructions; the Manager USDC ATAs
 * follow the leg groups in remaining accounts.
 */
export async function buildMintWithUsdcFeeInstructions(params: BuildMintWithUsdcFeeParams): Promise<BuildMintWithUsdcFeeResult> {
  const { program, reserve, reserveTokenMint, user, assets, reserveTokensRequested } = params;
  if (assets.length < 1) throw new Error("buildMintWithUsdcFeeInstructions requires at least one registered asset.");
  const reserveTokenProgram = params.reserveTokenProgram ?? (await resolveMintTokenProgram(program.provider.connection, reserveTokenMint));

  const requirements = computeMintRequirements(
    reserveTokensRequested,
    BigInt(params.reserveTokenSupplyRaw),
    assets.map((a) => ({ mint: a.mint, vaultBalance: BigInt(a.vaultBalanceRaw) })),
  );
  const slippageBps = BigInt(Math.round((params.slippageBps ?? 0.02) * 10_000));
  const maxAssetAmounts = requirements.map((r) => mulDivCeil(r.requiredAmount, BPS + slippageBps, BPS));

  const instructions: TransactionInstruction[] = [];
  const depositorReserveTokenAccount = assetAta(reserveTokenMint, user, reserveTokenProgram);
  instructions.push(createAssociatedTokenAccountIdempotentInstruction(user, depositorReserveTokenAccount, user, reserveTokenMint, reserveTokenProgram));

  const remainingAccounts: { pubkey: PublicKey; isWritable: boolean; isSigner: boolean }[] = [];
  for (const leg of assets) {
    const mint = new PublicKey(leg.mint);
    const legTokenProgram = resolveLegTokenProgram(leg);
    const userAta = assetAta(mint, user, legTokenProgram);
    instructions.push(createAssociatedTokenAccountIdempotentInstruction(user, userAta, user, mint, legTokenProgram));
    remainingAccounts.push(
      { pubkey: new PublicKey(leg.reserveAsset), isWritable: false, isSigner: false },
      { pubkey: new PublicKey(leg.vault), isWritable: true, isSigner: false },
      { pubkey: userAta, isWritable: true, isSigner: false },
      { pubkey: mint, isWritable: false, isSigner: false },
      { pubkey: legTokenProgram, isWritable: false, isSigner: false },
    );
  }

  const fee = usdcFeeAccounts(program.programId, reserve, params.usdcMint, params.feeQuoteSigner, params.routing);
  for (const ata of fee.managerUsdcAtas) remainingAccounts.push({ pubkey: ata, isWritable: true, isSigner: false });

  const mintIx = await program.methods
    .mintReserveTokensInKindUsdcFee(
      new BN(reserveTokensRequested.toString()),
      new BN(reserveTokensRequested.toString()),
      maxAssetAmounts.map((a) => new BN(a.toString())),
      new BN(params.usdcFeeRaw.toString()),
    )
    .accounts({
      protocolConfig: params.protocolConfig,
      reserve,
      reserveTokenMint,
      mintAuthority: params.mintAuthority,
      depositorReserveTokenAccount,
      depositor: user,
      tvlAccrual: findTvlAccrual(reserve, program.programId)[0],
      ...fee.accounts,
      depositorUsdcAccount: params.userUsdcAccount ?? getAssociatedTokenAddressSync(params.usdcMint, user, true),
      tokenProgram: reserveTokenProgram,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    } as any)
    .remainingAccounts(remainingAccounts)
    .instruction();
  instructions.push(mintIx);

  return {
    instructions,
    reserveTokensRequested,
    requiredAmountsRaw: requirements.map((r) => r.requiredAmount),
    expectedReserveTokensOut: reserveTokensRequested,
  };
}

export interface BuildSeedReserveUsdcFeeParams {
  program: Program<anchor.Idl>;
  addresses: NewReserveAddresses;
  assets: ReserveAssetAddresses[];
  manager: PublicKey;
  seedAmounts: bigint[];
  initialReserveTokens: bigint;
  usdcFeeRaw: bigint;
  usdcMint: PublicKey;
  feeQuoteSigner: PublicKey;
  routing: UsdcMintFeeRouting;
  managerUsdcAccount?: PublicKey;
}

/** Initial seed with the mint fee paid in USDC (`seed_reserve_usdc_fee`). */
export async function buildSeedReserveUsdcFeeInstruction(params: BuildSeedReserveUsdcFeeParams): Promise<TransactionInstruction> {
  const { program, addresses, assets, manager } = params;
  const remainingAccounts = assets.flatMap((a) => {
    const legTokenProgram = resolveLegTokenProgram({ tokenProgram: a.tokenProgram ?? null });
    return [
      { pubkey: a.reserveAsset, isWritable: false, isSigner: false },
      { pubkey: a.vault, isWritable: true, isSigner: false },
      { pubkey: assetAta(a.mint, manager, legTokenProgram), isWritable: true, isSigner: false },
      { pubkey: a.mint, isWritable: false, isSigner: false },
      { pubkey: legTokenProgram, isWritable: false, isSigner: false },
    ];
  });
  const fee = usdcFeeAccounts(program.programId, addresses.reserve, params.usdcMint, params.feeQuoteSigner, params.routing);
  for (const ata of fee.managerUsdcAtas) remainingAccounts.push({ pubkey: ata, isWritable: true, isSigner: false });

  return program.methods
    .seedReserveUsdcFee(
      params.seedAmounts.map((a) => new BN(a.toString())),
      new BN(params.initialReserveTokens.toString()),
      new BN(params.usdcFeeRaw.toString()),
    )
    .accounts({
      protocolConfig: addresses.protocolConfig,
      reserve: addresses.reserve,
      reserveTokenMint: addresses.reserveTokenMint,
      mintAuthority: addresses.mintAuthority,
      managerReserveTokenAccount: assetAta(addresses.reserveTokenMint, manager, addresses.reserveTokenProgram),
      manager,
      tvlAccrual: findTvlAccrual(addresses.reserve, program.programId)[0],
      ...fee.accounts,
      managerUsdcAccount: params.managerUsdcAccount ?? getAssociatedTokenAddressSync(params.usdcMint, manager, true),
      tokenProgram: addresses.reserveTokenProgram,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    } as any)
    .remainingAccounts(remainingAccounts)
    .instruction();
}
