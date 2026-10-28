// DEC-0238: server side of the USDC mint fee.
//
// The mint fee at creation (seed) and at every mint is paid in USDC, inside
// the mint transaction, to the Protocol Treasury and the Manager's fee
// recipients. The program requires SSR's fee quote signer (the configured
// settlement keeper, SSR_FEE_SETTLEMENT_KEEPER_SECRET) to co-sign the USDC
// amount. This module computes that amount from SSR's own prices, resolves
// the fee routing from chain, and co-signs ONLY transactions this server
// itself built -- it never signs a transaction a client sends in.
import { Connection, Keypair, PublicKey, TransactionInstruction, VersionedTransaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { computeUsdcMintFeeRaw, findManagerFeeRecipients, valueAssetAmountsUsdcRaw, buildUsdcFeeDestinationAtaInstructions, type UsdcMintFeeRouting } from "@ssr/sdk";
import { BuildError, MAINNET_TREASURY_VAULT } from "./buildCommon";
import { MAINNET_USDC_MINT } from "./jupiter";

/** Loads the fee quote signer (JSON array or base64 secret, same format as the fee-settlement keeper). */
export function loadFeeQuoteSigner(env: NodeJS.ProcessEnv = process.env): Keypair {
  const raw = env.SSR_FEE_SETTLEMENT_KEEPER_SECRET;
  if (!raw) throw new BuildError(503, "Minting is temporarily unavailable: the USDC mint-fee signer is not configured on this deployment. Nothing was submitted.");
  const parsed: number[] = raw.trim().startsWith("[") ? JSON.parse(raw) : Array.from(Buffer.from(raw, "base64"));
  return Keypair.fromSecretKey(Uint8Array.from(parsed));
}

/**
 * USDC fee for depositing `amountsRaw` of each leg: the Reserve's effective
 * mint-fee rate on the deposit's USD value at SSR's prices (USDC legs are
 * worth exactly 1). A leg with no price fails the build -- the fee is never
 * guessed.
 */
export function quoteUsdcMintFee(params: {
  legs: { mint: string; decimals: number; amountRaw: bigint; priceUsd: number | null | undefined }[];
  mintFeeBps: number;
}): { depositValueUsdcRaw: bigint; usdcFeeRaw: bigint } {
  let depositValueUsdcRaw: bigint;
  try {
    depositValueUsdcRaw = valueAssetAmountsUsdcRaw(params.legs.map((l) => ({ amountRaw: l.amountRaw, decimals: l.decimals, priceUsd: l.mint === MAINNET_USDC_MINT ? 1 : l.priceUsd })));
  } catch (e) {
    throw new BuildError(422, `${e instanceof Error ? e.message : String(e)} Try again in a moment. Nothing was submitted.`);
  }
  const usdcFeeRaw = computeUsdcMintFeeRaw(depositValueUsdcRaw, params.mintFeeBps);
  // DEC-0269: every mint pays at least the Protocol's 0.5%, a 0% mint fee included.
  if (usdcFeeRaw === 0n) {
    throw new BuildError(422, "This mint is too small for its mint fee to be charged in USDC (under $0.000001). Enter a larger amount. Nothing was submitted.");
  }
  return { depositValueUsdcRaw, usdcFeeRaw };
}

/** The Reserve's fee routing, read from chain (ManagerFeeRecipients if it opted in, else the legacy destination). */
export async function resolveUsdcFeeRouting(program: any, ssrProgramId: PublicKey, reserve: PublicKey, reserveAccount: any): Promise<UsdcMintFeeRouting> {
  const recipientsAccount = await program.account.managerFeeRecipients.fetchNullable(findManagerFeeRecipients(reserve, ssrProgramId)[0]);
  if (recipientsAccount) {
    const count = Number(recipientsAccount.recipientCount);
    return {
      protocolFeeDestination: new PublicKey(MAINNET_TREASURY_VAULT),
      managerRecipients: (recipientsAccount.recipients as { wallet: PublicKey }[]).slice(0, count).map((r) => ({ wallet: new PublicKey(r.wallet) })),
    };
  }
  return {
    protocolFeeDestination: new PublicKey(MAINNET_TREASURY_VAULT),
    managerRecipients: [],
    legacyManagerDestination: new PublicKey(reserveAccount.feeConfig.feeDestination),
  };
}

/**
 * Idempotent creates for only those fee-destination USDC accounts that do
 * not exist yet (usually none: the Treasury's exists, and recipients that
 * were paid before have theirs). Each missing one costs the payer ~0.002 SOL
 * of rent once.
 */
export async function missingFeeDestinationAtaInstructions(connection: Connection, payer: PublicKey, routing: UsdcMintFeeRouting): Promise<TransactionInstruction[]> {
  const usdcMint = new PublicKey(MAINNET_USDC_MINT);
  const all = buildUsdcFeeDestinationAtaInstructions(payer, usdcMint, routing);
  if (all.length === 0) return [];
  // keys[1] of an ATA-create instruction is the ATA itself.
  const infos = await connection.getMultipleAccountsInfo(all.map((ix) => ix.keys[1].pubkey), "confirmed");
  return all.filter((_, i) => infos[i] === null);
}

/** The payer's USDC ATA (the account the fee is paid from). */
export function walletUsdcAta(wallet: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(new PublicKey(MAINNET_USDC_MINT), wallet, true);
}

/** Adds the fee quote signer's signature to a transaction this server compiled. The wallet signs afterwards. */
export function coSignFee(tx: VersionedTransaction, signer: Keypair): VersionedTransaction {
  const required = tx.message.staticAccountKeys.slice(0, tx.message.header.numRequiredSignatures);
  if (!required.some((k) => k.equals(signer.publicKey))) {
    throw new BuildError(500, "Internal error: the mint transaction does not name the fee quote signer. Nothing was submitted.");
  }
  if (required[0].equals(signer.publicKey)) {
    // Never let the keeper be the fee payer.
    throw new BuildError(500, "Internal error: the fee quote signer must never pay transaction fees. Nothing was submitted.");
  }
  tx.sign([signer]);
  return tx;
}
