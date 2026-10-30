// DEC-0238: SERVER-BUILT initial seed of a new Mainnet Reserve, with the mint
// fee paid in USDC inside the seed transaction.
//
// The Create flow used to build seed_reserve in the browser, which minted the
// fee as Reserve Tokens. seed_reserve_usdc_fee needs SSR's fee quote signer to
// co-sign the USDC amount, so this server builds the transaction, prices the
// seed with SSR's own prices, co-signs it, and hands it to the creator's
// wallet. The creator's signature is still what moves anything.
//
// A seed of a large basket can exceed the 1232-byte transaction limit. Then
// this returns `needsLookupTable` with the addresses to put in one; the
// browser creates the table (its own wallet pays) and asks again with it.
import { AddressLookupTableAccount, ComputeBudgetProgram, Connection, Keypair, PublicKey, TransactionInstruction, VersionedTransaction } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, unpackMint } from "@solana/spl-token";
import { buildSeedReserveUsdcFeeInstruction, deriveReserveAssetAddresses, describeOnChainError, findProtocolConfig, findVaultAuthority, type NewReserveAddresses, type ReserveAssetAddresses, type UsdcMintFeeRouting } from "@ssr/sdk";
import { seedComputeUnitLimit } from "../../src/merge/lib/seedBudget";
import { buildUnwrapSolInstructions, countAccountLocks, fetchLookupTables, SINGLE_TX_MICRO_LAMPORTS_PER_CU, SOLANA_MAX_TX_ACCOUNT_LOCKS } from "../../src/merge/lib/singleTxBuy";
import { BuildError, compileV0, fitsV0, MAINNET_TREASURY_VAULT, readReserveAndWallet, toBase64, tokenAmountFromInfo, type ReadDeps } from "./buildCommon";
import { MAINNET_USDC_MINT } from "./jupiter";
import { coSignFee, missingFeeDestinationAtaInstructions, quoteUsdcMintFee, resolveUsdcFeeRouting, walletUsdcAta } from "./usdcMintFee";
import { loadFeeLookupTable } from "./feeLookupTable";

export interface BuildSeedInput {
  reserve: PublicKey;
  manager: PublicKey;
  assetMints: PublicKey[];
  /** Raw seed amount per asset, in the Reserve's order_index order. */
  seedAmountsRaw: bigint[];
  initialReserveTokens: bigint;
  /** A lookup table the creator already made for this seed (second call after `needsLookupTable`). */
  lookupTable: PublicKey | null;
}

export interface BuildSeedDeps extends ReadDeps {
  fetchPrices(mints: string[]): Promise<Map<string, { usdPrice: number | null | undefined }>>;
  feeQuoteSigner: Keypair | null;
  simulate?: (tx: VersionedTransaction) => Promise<{ err: unknown; logs: string[] | null }>;
}

export type BuildSeedResult =
  | {
      status: "ready";
      transactionBase64: string;
      lastValidBlockHeight: number;
      usdcMintFeeRaw: string;
      seedValueUsdcRaw: string;
      initialReserveTokens: string;
    }
  | { status: "needsLookupTable"; addresses: string[]; usdcMintFeeRaw: string; seedValueUsdcRaw: string };

/** Reserve Token decimals (programs/ssr_protocol constants.rs RESERVE_TOKEN_DECIMALS). */
const RESERVE_TOKEN_DECIMALS = 6;

/**
 * The initial Reserve Token count: one token per dollar the seeded basket is
 * really worth at SSR's prices (the same value the mint fee is charged on), so
 * NAV starts at exactly $1.00 whatever the swaps delivered. The creator's own
 * figure (one token per committed dollar) is kept when the value is missing or
 * more than 2x off it, i.e. a broken price rather than ordinary swap costs.
 * 2026-10-23: SSRES committed $500, deposited $469.47, minted 500 -> NAV $0.939.
 */
export function initialTokensForSeedValue(depositValueUsdcRaw: bigint, requested: bigint): bigint {
  const valued = (depositValueUsdcRaw * 10n ** BigInt(RESERVE_TOKEN_DECIMALS)) / 1_000_000n;
  if (valued <= 0n || requested <= 0n) return requested;
  return valued * 2n < requested || valued > requested * 2n ? requested : valued;
}

type PriceMap = Map<string, { usdPrice: number | null | undefined }>;

/** Prices for the seed's non-USDC assets. A failed request is a retryable 503, never "this asset has no price". */
async function seedPrices(fetchPrices: BuildSeedDeps["fetchPrices"], mints: string[]): Promise<PriceMap> {
  try {
    return await fetchPrices(mints.filter((m) => m !== MAINNET_USDC_MINT));
  } catch {
    throw new BuildError(503, "SSR's price service is busy right now. Wait a few seconds and try again. Nothing was submitted.");
  }
}

/** Every instruction of the seed transaction, in order. Shared by the real build and the pre-creation check so both count the same accounts. */
async function seedInstructions(params: {
  connection: Connection;
  program: any;
  addresses: NewReserveAddresses;
  assets: ReserveAssetAddresses[];
  manager: PublicKey;
  seedAmountsRaw: bigint[];
  initialReserveTokens: bigint;
  usdcFeeRaw: bigint;
  feeQuoteSigner: PublicKey;
  routing: UsdcMintFeeRouting;
}): Promise<TransactionInstruction[]> {
  const [seedIx, feeAtaIxs] = await Promise.all([
    buildSeedReserveUsdcFeeInstruction({
      program: params.program,
      addresses: params.addresses,
      assets: params.assets,
      manager: params.manager,
      seedAmounts: params.seedAmountsRaw,
      initialReserveTokens: params.initialReserveTokens,
      usdcFeeRaw: params.usdcFeeRaw,
      usdcMint: new PublicKey(MAINNET_USDC_MINT),
      feeQuoteSigner: params.feeQuoteSigner,
      routing: params.routing,
    }),
    missingFeeDestinationAtaInstructions(params.connection, params.manager, params.routing),
  ]);
  return [
    ComputeBudgetProgram.setComputeUnitLimit({ units: seedComputeUnitLimit(params.assets.length) + 40_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: SINGLE_TX_MICRO_LAMPORTS_PER_CU }),
    ...feeAtaIxs,
    seedIx,
    // DEC-0244: any wrapped SOL left after the seed returns to the creator as native SOL.
    ...buildUnwrapSolInstructions(params.manager, params.assets.map((a) => a.mint.toBase58())),
  ];
}

/**
 * Solana locks at most 64 accounts per transaction, lookup table or not. A seed
 * uses about 20 fixed accounts, 4 per asset and 1-2 per fee recipient, so 12
 * assets never fit (2026-10-29: Reserve #69 stuck after creation).
 */
function assertSeedAccountLocksFit(manager: PublicKey, instructions: TransactionInstruction[]): number {
  const locks = countAccountLocks(manager, instructions);
  if (locks > SOLANA_MAX_TX_ACCOUNT_LOCKS) {
    throw new BuildError(
      422,
      `This launch's seed transaction would touch ${locks} accounts, and Solana allows at most ${SOLANA_MAX_TX_ACCOUNT_LOCKS} in one transaction. Remove an asset or a fee recipient. Nothing was submitted.`,
    );
  }
  return locks;
}

export interface PreflightSeedInput {
  manager: PublicKey;
  assetMints: PublicKey[];
  seedAmountsRaw: bigint[];
  mintFeeBps: number;
  /** The Manager fee recipients the launch will register; empty when the Primary Fee Destination takes 100%. */
  feeRecipients: PublicKey[];
  feeDestination: PublicKey;
}

export interface PreflightSeedResult {
  status: "ok";
  usdcMintFeeRaw: string;
  seedValueUsdcRaw: string;
  accountLocks: number;
}

/**
 * Everything the seed needs that can be checked before the Reserve exists:
 * every asset priced, enough USDC for the fee, and a seed transaction that fits
 * Solana's account-lock limit. The Create flow runs this after the swaps and
 * before create-and-register, so a launch that can't be seeded stops with
 * nothing created (2026-10-29: #68 and #72 were created, then failed here).
 */
export async function preflightSeed(deps: BuildSeedDeps, input: PreflightSeedInput): Promise<PreflightSeedResult> {
  if (!deps.feeQuoteSigner) {
    throw new BuildError(503, "Launching is temporarily unavailable: the USDC mint-fee signer is not configured on this deployment. Nothing was submitted.");
  }
  const { connection, program, ssrProgramId } = deps;
  const mints = input.assetMints.map((m) => m.toBase58());
  const [prices, infos] = await Promise.all([
    seedPrices(deps.fetchPrices, mints),
    connection.getMultipleAccountsInfo([...input.assetMints, walletUsdcAta(input.manager)], "confirmed"),
  ]);
  const legs = input.assetMints.map((mint, i) => {
    const info = infos[i];
    if (!info || !(info.owner.equals(TOKEN_PROGRAM_ID) || info.owner.equals(TOKEN_2022_PROGRAM_ID))) {
      throw new BuildError(422, `${mint.toBase58()} is not a token mint on Mainnet. Nothing was submitted.`);
    }
    return { mint, tokenProgram: info.owner, decimals: unpackMint(mint, info, info.owner).decimals };
  });
  const unpriced = legs.filter((l) => l.mint.toBase58() !== MAINNET_USDC_MINT && !(Number(prices.get(l.mint.toBase58())?.usdPrice) > 0));
  if (unpriced.length > 0) {
    throw new BuildError(422, `SSR has no current USD price for ${unpriced.map((l) => l.mint.toBase58()).join(", ")}, so the seed's mint fee can't be charged. Replace ${unpriced.length === 1 ? "that asset" : "those assets"} and launch again. Nothing was created.`);
  }
  const { depositValueUsdcRaw, usdcFeeRaw } = quoteUsdcMintFee({
    legs: legs.map((l, i) => ({ mint: l.mint.toBase58(), decimals: l.decimals, amountRaw: input.seedAmountsRaw[i], priceUsd: prices.get(l.mint.toBase58())?.usdPrice ?? null })),
    mintFeeBps: input.mintFeeBps,
  });
  const walletUsdcRaw = tokenAmountFromInfo(walletUsdcAta(input.manager), infos[legs.length]);
  const usdcLeg = mints.indexOf(MAINNET_USDC_MINT);
  const usdcNeeded = usdcFeeRaw + (usdcLeg >= 0 ? input.seedAmountsRaw[usdcLeg] : 0n);
  if (walletUsdcRaw < usdcNeeded) {
    throw new BuildError(
      422,
      `The seed's mint fee is ${(Number(usdcFeeRaw) / 1e6).toFixed(2)} USDC, paid from your wallet, but it holds ${(Number(walletUsdcRaw) / 1e6).toFixed(2)} USDC${usdcLeg >= 0 ? " after the USDC seed amount" : ""}. Add USDC and launch again. Nothing was created.`,
    );
  }

  // The real addresses depend on the next Reserve id; any distinct ones give the same account count.
  const reserve = Keypair.generate().publicKey;
  const addresses: NewReserveAddresses = {
    reserveId: 0n,
    reserve,
    reserveTokenMint: Keypair.generate().publicKey,
    mintAuthority: PublicKey.findProgramAddressSync([Buffer.from("mint_authority"), reserve.toBuffer()], ssrProgramId)[0],
    vaultAuthority: findVaultAuthority(reserve, ssrProgramId)[0],
    protocolConfig: findProtocolConfig(ssrProgramId)[0],
    reserveTokenProgram: TOKEN_2022_PROGRAM_ID,
  };
  const routing: UsdcMintFeeRouting =
    input.feeRecipients.length > 0
      ? { protocolFeeDestination: new PublicKey(MAINNET_TREASURY_VAULT), managerRecipients: input.feeRecipients.map((wallet) => ({ wallet })) }
      : { protocolFeeDestination: new PublicKey(MAINNET_TREASURY_VAULT), managerRecipients: [], legacyManagerDestination: input.feeDestination };
  const instructions = await seedInstructions({
    connection,
    program,
    addresses,
    assets: legs.map((l) => deriveReserveAssetAddresses(reserve, l.mint, ssrProgramId, l.tokenProgram)),
    manager: input.manager,
    seedAmountsRaw: input.seedAmountsRaw,
    initialReserveTokens: 1n,
    usdcFeeRaw,
    feeQuoteSigner: deps.feeQuoteSigner.publicKey,
    routing,
  });
  const accountLocks = assertSeedAccountLocksFit(input.manager, instructions);
  return { status: "ok", usdcMintFeeRaw: usdcFeeRaw.toString(), seedValueUsdcRaw: depositValueUsdcRaw.toString(), accountLocks };
}

export async function buildSeedTransaction(deps: BuildSeedDeps, input: BuildSeedInput): Promise<BuildSeedResult> {
  if (!deps.feeQuoteSigner) {
    throw new BuildError(503, "Launching is temporarily unavailable: the USDC mint-fee signer is not configured on this deployment. Nothing was submitted.");
  }
  const feeQuoteSigner = deps.feeQuoteSigner;
  const { connection, program, ssrProgramId } = deps;

  const [read, prices] = await Promise.all([
    readReserveAndWallet(deps, input.reserve, input.manager, input.assetMints),
    seedPrices(deps.fetchPrices, input.assetMints.map((m) => m.toBase58())),
  ]);
  const reserveAccount = read.reserveAccount;
  if (!new PublicKey(reserveAccount.manager).equals(input.manager)) {
    throw new BuildError(403, "Only this Reserve's Manager can seed it. Nothing was submitted.");
  }
  if (!("assetsInitializing" in (reserveAccount.status ?? {}))) {
    throw new BuildError(409, "This Reserve is not waiting for its initial seed (it may already be seeded). Nothing was submitted.");
  }
  // Seed amounts arrive in the caller's asset order; re-key them by mint into
  // the Reserve's on-chain order_index order, which is what the program reads.
  const amountByMint = new Map(input.assetMints.map((m, i) => [m.toBase58(), input.seedAmountsRaw[i]]));
  if (input.seedAmountsRaw.length !== read.orderedAssets.length || read.orderedAssets.some((a) => amountByMint.get(a.mint) === undefined)) {
    throw new BuildError(400, `Expected one seed amount for each of this Reserve's ${read.orderedAssets.length} assets. Nothing was submitted.`);
  }
  const seedAmountsRaw = read.orderedAssets.map((a) => amountByMint.get(a.mint) as bigint);

  const { depositValueUsdcRaw, usdcFeeRaw } = quoteUsdcMintFee({
    legs: read.orderedAssets.map((a, i) => ({ mint: a.mint, decimals: a.decimals, amountRaw: seedAmountsRaw[i], priceUsd: prices.get(a.mint)?.usdPrice ?? null })),
    mintFeeBps: Number(reserveAccount.feeConfig.mintFeeBps),
  });
  const initialReserveTokens = initialTokensForSeedValue(depositValueUsdcRaw, input.initialReserveTokens);
  // The fee is paid from the creator's USDC, on top of the seed's assets.
  const usdcSeedLegIndex = read.orderedAssets.findIndex((a) => a.mint === MAINNET_USDC_MINT);
  const usdcNeeded = usdcFeeRaw + (usdcSeedLegIndex >= 0 ? seedAmountsRaw[usdcSeedLegIndex] : 0n);
  if (read.walletUsdcRaw < usdcNeeded) {
    throw new BuildError(
      422,
      `The seed's mint fee is ${(Number(usdcFeeRaw) / 1e6).toFixed(2)} USDC, paid from your wallet, but it holds ${(Number(read.walletUsdcRaw) / 1e6).toFixed(2)} USDC${usdcSeedLegIndex >= 0 ? " after the USDC seed amount" : ""}. Add USDC and retry; nothing was submitted.`,
    );
  }

  const routing = await resolveUsdcFeeRouting(program, ssrProgramId, input.reserve, reserveAccount);
  const addresses: NewReserveAddresses = {
    reserveId: BigInt(reserveAccount.reserveId.toString()),
    reserve: input.reserve,
    reserveTokenMint: read.reserveTokenMint,
    mintAuthority: read.mintAuthority,
    vaultAuthority: read.vaultAuthority,
    protocolConfig: read.protocolConfig,
    reserveTokenProgram: read.reserveTokenProgram,
  };
  const assets: ReserveAssetAddresses[] = read.orderedAssets.map((a) => ({
    mint: new PublicKey(a.mint),
    reserveAsset: new PublicKey(a.reserveAsset),
    vault: new PublicKey(a.vault),
    tokenProgram: a.tokenProgram ? new PublicKey(a.tokenProgram) : undefined,
  }));
  const instructions = await seedInstructions({ connection, program, addresses, assets, manager: input.manager, seedAmountsRaw, initialReserveTokens, usdcFeeRaw, feeQuoteSigner: feeQuoteSigner.publicKey, routing });
  // Before any lookup-table round trip: a table can't lift the lock limit.
  assertSeedAccountLocksFit(input.manager, instructions);

  // DEC-0238: the protocol-wide fee table always, plus the creator's own table for a large seed.
  const [ownTables, feeTables] = await Promise.all([
    input.lookupTable ? fetchLookupTables(connection, [input.lookupTable.toBase58()]).catch(() => [] as AddressLookupTableAccount[]) : Promise.resolve([] as AddressLookupTableAccount[]),
    loadFeeLookupTable(connection),
  ]);
  const tables = [...ownTables, ...feeTables];
  if (input.lookupTable && ownTables.length === 0) {
    throw new BuildError(409, "The lookup table for this seed is not active yet. Wait a few seconds and retry. Nothing was submitted.");
  }
  if (!fitsV0(input.manager, instructions, tables)) {
    if (input.lookupTable) throw new BuildError(422, "This seed does not fit one transaction even with a lookup table. Nothing was submitted.");
    // Signers cannot be looked up, and the fee table already holds the fixed fee accounts.
    const signerKeys = new Set([input.manager.toBase58(), feeQuoteSigner.publicKey.toBase58(), ...feeTables.flatMap((t) => t.state.addresses.map((a) => a.toBase58()))]);
    const lookup = Array.from(new Set(instructions.flatMap((ix) => [ix.programId.toBase58(), ...ix.keys.map((k) => k.pubkey.toBase58())]))).filter((k) => !signerKeys.has(k));
    return { status: "needsLookupTable", addresses: lookup, usdcMintFeeRaw: usdcFeeRaw.toString(), seedValueUsdcRaw: depositValueUsdcRaw.toString() };
  }

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const tx = compileV0(input.manager, blockhash, instructions, tables);
  if (deps.simulate) {
    const sim = await deps.simulate(tx).catch(() => null);
    if (sim && sim.err) {
      throw new BuildError(422, `${describeOnChainError(new Error(`Transaction failed on-chain (${JSON.stringify(sim.err)}).`))} This was caught by a read-only simulation before anything was signed -- nothing moved and no fee was paid.`, { logs: sim.logs ?? [] });
    }
  }
  coSignFee(tx, feeQuoteSigner);
  return {
    status: "ready",
    transactionBase64: toBase64(tx).base64,
    lastValidBlockHeight,
    usdcMintFeeRaw: usdcFeeRaw.toString(),
    seedValueUsdcRaw: depositValueUsdcRaw.toString(),
    initialReserveTokens: initialReserveTokens.toString(),
  };
}
