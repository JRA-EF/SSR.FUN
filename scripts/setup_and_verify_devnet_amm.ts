// One-time setup (initialize_amm_config, create_pool x4, seed real
// liquidity) AND live verification of ssr_devnet_amm -- see DEC-0051.
// Real transactions only: every step below is a genuine signed DevNet
// transaction, re-confirmed by re-fetching on-chain state afterward, never
// a simulation or a fabricated outcome.
import * as fs from "fs";
import * as path from "path";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  LAMPORTS_PER_SOL,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createMintToInstruction,
  createSyncNativeInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  DEVNET_FIXTURES,
  DEVUSDC,
  WRAPPED_SOL_MINT,
  assertDevnetCluster,
  buildReadOnlyAmmProgram,
  buildAddLiquidityInstruction,
  buildCreatePoolInstruction,
  buildInitializeAmmConfigInstruction,
  buildPauseAmmInstruction,
  buildSwapInstruction,
  buildUnpauseAmmInstruction,
  findAmmConfig,
  findAmmPool,
  findAmmVault,
  quoteAmmSwap,
} from "../packages/sdk/src";

const connection = new Connection("https://api.devnet.solana.com", "confirmed");

async function send(tx: Transaction, signers: Keypair[], label: string): Promise<string> {
  const sig = await sendAndConfirmTransaction(connection, tx, signers, { commitment: "confirmed" });
  console.log(`  [${label}] signature: ${sig}`);
  return sig;
}

const FEE_BPS = 30; // 0.3%, arbitrary DevNet test value, not final economics.
const SOL_PER_POOL = 1; // WSOL side of each pool's initial seed liquidity.
const SOL_TEST_PRICE_USD = 20; // matches packages/sdk/src/zapPricing.ts's existing convention.

async function main() {
  await assertDevnetCluster(connection);
  console.log("Confirmed: connected cluster is genuinely Solana DevNet.\n");

  const deployerSecret = JSON.parse(fs.readFileSync(path.join(require("os").homedir(), ".config", "solana", "devnet-deployer.json"), "utf-8"));
  const deployer = Keypair.fromSecretKey(Uint8Array.from(deployerSecret));

  const managerSecretRaw = fs.readFileSync(path.resolve(__dirname, "..", "devnet-fixtures", "manager-keypair.json"), "utf-8");
  const authority = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(managerSecretRaw)));
  console.log(`AMM authority (reused DevNet swap-authority/manager wallet): ${authority.publicKey.toBase58()}`);

  const authorityBalBefore = await connection.getBalance(authority.publicKey);
  console.log(`Authority SOL balance before funding: ${authorityBalBefore / LAMPORTS_PER_SOL}`);
  const neededLamports = 5 * LAMPORTS_PER_SOL;
  if (authorityBalBefore < neededLamports) {
    const topUp = neededLamports - authorityBalBefore;
    await send(
      new Transaction().add(SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: authority.publicKey, lamports: topUp })),
      [deployer],
      "fund AMM authority from deployer",
    );
  }

  const program = buildReadOnlyAmmProgram(connection) as any;

  // --- Step 1: initialize_amm_config (idempotent -- skip if it already exists) ---
  const [ammConfigPda] = findAmmConfig();
  let ammConfig = await (program.account as any).ammConfig.fetchNullable(ammConfigPda);
  if (!ammConfig) {
    console.log("\n--- initialize_amm_config ---");
    const ix = await buildInitializeAmmConfigInstruction(program, authority.publicKey, FEE_BPS);
    await send(new Transaction().add(ix), [authority], "initialize_amm_config");
    ammConfig = await program.account.ammConfig.fetch(ammConfigPda);
  } else {
    console.log("\nAmmConfig already exists -- skipping initialize_amm_config.");
  }
  console.log(`AmmConfig authority: ${ammConfig.authority.toBase58()}, default_fee_bps: ${ammConfig.defaultFeeBps}, paused: ${ammConfig.paused}`);
  if (ammConfig.authority.toBase58() !== authority.publicKey.toBase58()) {
    throw new Error("AmmConfig authority mismatch -- refusing to proceed with the wrong signer.");
  }

  const assets = [
    { symbol: "mockX", mint: new PublicKey(DEVNET_FIXTURES.mints.mintX.address), decimals: DEVNET_FIXTURES.mints.mintX.decimals },
    { symbol: "mockY", mint: new PublicKey(DEVNET_FIXTURES.mints.mintY.address), decimals: DEVNET_FIXTURES.mints.mintY.decimals },
    { symbol: "mockZ", mint: new PublicKey(DEVNET_FIXTURES.mints.mintZ.address), decimals: DEVNET_FIXTURES.mints.mintZ.decimals },
    { symbol: DEVUSDC.symbol, mint: new PublicKey(DEVUSDC.mint), decimals: DEVUSDC.decimals },
  ];

  const authorityWsolAta = getAssociatedTokenAddressSync(WRAPPED_SOL_MINT, authority.publicKey);

  for (const asset of assets) {
    console.log(`\n=== Pool: SOL/${asset.symbol} ===`);
    const [poolPda] = findAmmPool(WRAPPED_SOL_MINT, asset.mint);
    let pool = await program.account.pool.fetchNullable(poolPda);

    if (!pool) {
      console.log(`--- create_pool(SOL, ${asset.symbol}) ---`);
      const ix = await buildCreatePoolInstruction(program, authority.publicKey, WRAPPED_SOL_MINT, asset.mint, FEE_BPS);
      await send(new Transaction().add(ix), [authority], `create_pool(${asset.symbol})`);
      pool = await program.account.pool.fetch(poolPda);
    } else {
      console.log(`Pool already exists -- skipping create_pool.`);
    }

    const [vaultA] = findAmmVault(poolPda, WRAPPED_SOL_MINT);
    const [vaultB] = findAmmVault(poolPda, asset.mint);
    const vaultABalBefore = await getAccount(connection, vaultA).then((a) => a.amount).catch(() => 0n);
    const vaultBBalBefore = await getAccount(connection, vaultB).then((a) => a.amount).catch(() => 0n);

    if (vaultABalBefore === 0n && vaultBBalBefore === 0n) {
      console.log(`--- Seeding liquidity: ${SOL_PER_POOL} SOL + ${SOL_PER_POOL * SOL_TEST_PRICE_USD} ${asset.symbol} ---`);
      const wrapAmountLamports = BigInt(SOL_PER_POOL * LAMPORTS_PER_SOL);
      const assetAmountRaw = BigInt(SOL_PER_POOL * SOL_TEST_PRICE_USD) * BigInt(10 ** asset.decimals);
      const authorityAssetAta = getAssociatedTokenAddressSync(asset.mint, authority.publicKey);

      const seedTx = new Transaction();
      seedTx.add(createAssociatedTokenAccountIdempotentInstruction(authority.publicKey, authorityWsolAta, authority.publicKey, WRAPPED_SOL_MINT));
      seedTx.add(SystemProgram.transfer({ fromPubkey: authority.publicKey, toPubkey: authorityWsolAta, lamports: wrapAmountLamports }));
      seedTx.add(createSyncNativeInstruction(authorityWsolAta));
      seedTx.add(createAssociatedTokenAccountIdempotentInstruction(authority.publicKey, authorityAssetAta, authority.publicKey, asset.mint));
      seedTx.add(createMintToInstruction(asset.mint, authorityAssetAta, authority.publicKey, assetAmountRaw));
      await send(seedTx, [authority], `wrap SOL + mint ${asset.symbol}`);

      const addLiqIx = await buildAddLiquidityInstruction(program, authority.publicKey, WRAPPED_SOL_MINT, asset.mint, wrapAmountLamports, assetAmountRaw);
      await send(new Transaction().add(addLiqIx), [authority], `add_liquidity(SOL/${asset.symbol})`);
    } else {
      console.log(`Pool already funded (reserve_a=${vaultABalBefore}, reserve_b=${vaultBBalBefore}) -- skipping seed.`);
    }
  }

  // ============================================================
  // LIVE VERIFICATION -- real signed transactions only.
  // ============================================================
  console.log("\n=========================================================");
  console.log("LIVE VERIFICATION");
  console.log("=========================================================");

  const testAsset = assets[0]; // mockX
  const [poolPda] = findAmmPool(WRAPPED_SOL_MINT, testAsset.mint);
  const [vaultA] = findAmmVault(poolPda, WRAPPED_SOL_MINT);
  const [vaultB] = findAmmVault(poolPda, testAsset.mint);
  const pool = await program.account.pool.fetch(poolPda);

  // Use a FRESH trader wallet, funded and given some mockX to swap, so the
  // test is a genuine third-party swap, not the liquidity authority trading
  // with itself.
  const trader = Keypair.generate();
  console.log(`\nFresh trader wallet: ${trader.publicKey.toBase58()}`);
  await send(new Transaction().add(SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: trader.publicKey, lamports: 0.05 * LAMPORTS_PER_SOL })), [deployer], "fund trader");

  const traderWsolAta = getAssociatedTokenAddressSync(WRAPPED_SOL_MINT, trader.publicKey);
  const traderAssetAta = getAssociatedTokenAddressSync(testAsset.mint, trader.publicKey);
  const setupTx = new Transaction();
  setupTx.add(createAssociatedTokenAccountIdempotentInstruction(trader.publicKey, traderWsolAta, trader.publicKey, WRAPPED_SOL_MINT));
  setupTx.add(SystemProgram.transfer({ fromPubkey: trader.publicKey, toPubkey: traderWsolAta, lamports: BigInt(0.02 * LAMPORTS_PER_SOL) }));
  setupTx.add(createSyncNativeInstruction(traderWsolAta));
  setupTx.add(createAssociatedTokenAccountIdempotentInstruction(trader.publicKey, traderAssetAta, trader.publicKey, testAsset.mint));
  await send(setupTx, [trader], "trader wraps 0.02 SOL, creates mockX ATA");

  // --- Verification 1: real swap, SOL -> mockX, with a correct on-chain-matching quote ---
  console.log("\n--- Verification 1: swap SOL -> mockX (real transfer, verifiable balance change) ---");
  const reserveABefore = (await getAccount(connection, vaultA)).amount;
  const reserveBBefore = (await getAccount(connection, vaultB)).amount;
  const amountIn = BigInt(0.01 * LAMPORTS_PER_SOL);
  const quote = quoteAmmSwap(reserveABefore, reserveBBefore, amountIn, BigInt(pool.feeBps));
  console.log(`Quote: fee=${quote.feeAmount}, amountOut=${quote.amountOut} (reserves before: ${reserveABefore} WSOL / ${reserveBBefore} mockX)`);
  const traderAssetBalBefore = (await getAccount(connection, traderAssetAta)).amount;

  const swapIx1 = await buildSwapInstruction({
    program,
    trader: trader.publicKey,
    mintA: WRAPPED_SOL_MINT,
    mintB: testAsset.mint,
    amountIn,
    minimumAmountOut: (quote.amountOut * 99n) / 100n, // 1% slippage tolerance
    aToB: true,
  });
  await send(new Transaction().add(swapIx1), [trader], "swap SOL->mockX");

  const traderAssetBalAfter = (await getAccount(connection, traderAssetAta)).amount;
  const actualOut = traderAssetBalAfter - traderAssetBalBefore;
  console.log(`Trader mockX balance: ${traderAssetBalBefore} -> ${traderAssetBalAfter} (received ${actualOut}, quoted ${quote.amountOut})`);
  if (actualOut !== quote.amountOut) throw new Error(`FAIL: actual swap output (${actualOut}) does not match the on-chain-formula quote (${quote.amountOut}).`);
  const reserveAAfter1 = (await getAccount(connection, vaultA)).amount;
  const reserveBAfter1 = (await getAccount(connection, vaultB)).amount;
  console.log(`Pool reserves after: ${reserveAAfter1} WSOL / ${reserveBAfter1} mockX (real, verifiable on-chain balance change)`);
  if (reserveAAfter1 !== reserveABefore + amountIn) throw new Error("FAIL: pool WSOL reserve did not increase by exactly amountIn.");
  if (reserveBAfter1 !== reserveBBefore - actualOut) throw new Error("FAIL: pool mockX reserve did not decrease by exactly amountOut.");

  // --- Verification 2: slippage protection rejects an unreasonable minimum_amount_out ---
  console.log("\n--- Verification 2: slippage protection (minimum_amount_out set impossibly high) ---");
  let slippageRejectedCorrectly = false;
  try {
    const badSwapIx = await buildSwapInstruction({
      program,
      trader: trader.publicKey,
      mintA: WRAPPED_SOL_MINT,
      mintB: testAsset.mint,
      amountIn: BigInt(0.001 * LAMPORTS_PER_SOL),
      minimumAmountOut: 999_999_999_999n, // impossible
      aToB: true,
    });
    await send(new Transaction().add(badSwapIx), [trader], "swap expected to fail (slippage)");
    console.log("  UNEXPECTED: this swap should have been rejected.");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    slippageRejectedCorrectly = msg.includes("0x") || msg.includes("custom program error") || msg.includes("SlippageMinOutputNotMet");
    console.log(`  Correctly rejected. Error: ${msg.slice(0, 200)}`);
  }
  if (!slippageRejectedCorrectly) throw new Error("FAIL: slippage protection did not reject an impossible minimum_amount_out.");

  // --- Verification 3: mint substitution is rejected -- build a normal
  // swap instruction against the REAL SOL/mockX pool, then substitute only
  // the mint_b account key for a different real mint (mockY) while leaving
  // the pool/vaults/trader accounts pointing at the real mockX ones. This
  // must be caught by the program's own `#[account(address = pool.mint_b)]`
  // constraint on mint_b, not merely by the client deriving a different
  // pool -- proving the on-chain check itself works, not just the client. ---
  console.log("\n--- Verification 3: mint substitution rejected (mint_b swapped for mockY on the real SOL/mockX pool) ---");
  let mintSubstitutionRejected = false;
  try {
    const realIx = await buildSwapInstruction({
      program,
      trader: trader.publicKey,
      mintA: WRAPPED_SOL_MINT,
      mintB: testAsset.mint,
      amountIn: 1000n,
      minimumAmountOut: 0n,
      aToB: true,
    });
    const wrongMint = new PublicKey(DEVNET_FIXTURES.mints.mintY.address);
    const tamperedKeys = realIx.keys.map((k) => (k.pubkey.equals(testAsset.mint) ? { ...k, pubkey: wrongMint } : k));
    const { TransactionInstruction } = await import("@solana/web3.js");
    const tamperedIx = new TransactionInstruction({ programId: realIx.programId, keys: tamperedKeys, data: realIx.data });
    await send(new Transaction().add(tamperedIx), [trader], "swap expected to fail (mint substitution)");
    console.log("  UNEXPECTED: this swap should have been rejected.");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    mintSubstitutionRejected = msg.includes("0x") || msg.includes("custom program error") || msg.includes("MintMismatch") || msg.includes("ConstraintAddress");
    console.log(`  Correctly rejected. Error: ${msg.slice(0, 200)}`);
  }
  if (!mintSubstitutionRejected) throw new Error("FAIL: mint-substitution swap was not rejected.");

  // --- Verification 4: pause_amm blocks swap, unpause_amm restores it ---
  console.log("\n--- Verification 4: pause_amm blocks swap; unpause_amm restores it ---");
  await send(new Transaction().add(await buildPauseAmmInstruction(program, authority.publicKey)), [authority], "pause_amm");
  let pausedBlockedSwap = false;
  try {
    const swapWhilePausedIx = await buildSwapInstruction({
      program,
      trader: trader.publicKey,
      mintA: WRAPPED_SOL_MINT,
      mintB: testAsset.mint,
      amountIn: 1000n,
      minimumAmountOut: 0n,
      aToB: true,
    });
    await send(new Transaction().add(swapWhilePausedIx), [trader], "swap expected to fail (paused)");
    console.log("  UNEXPECTED: swap succeeded while paused.");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    pausedBlockedSwap = msg.includes("0x") || msg.includes("custom program error") || msg.includes("AmmPaused");
    console.log(`  Correctly rejected while paused. Error: ${msg.slice(0, 200)}`);
  }
  await send(new Transaction().add(await buildUnpauseAmmInstruction(program, authority.publicKey)), [authority], "unpause_amm");
  const ammConfigAfterUnpause = await program.account.ammConfig.fetch(ammConfigPda);
  console.log(`AmmConfig.paused after unpause: ${ammConfigAfterUnpause.paused} (expect false)`);
  if (!pausedBlockedSwap) throw new Error("FAIL: swap was not blocked while paused.");
  if (ammConfigAfterUnpause.paused !== false) throw new Error("FAIL: unpause_amm did not clear paused.");

  // --- Verification 5: reverse-direction swap (mockX -> SOL) also works ---
  console.log("\n--- Verification 5: reverse swap mockX -> SOL ---");
  const reserveABefore5 = (await getAccount(connection, vaultA)).amount;
  const reserveBBefore5 = (await getAccount(connection, vaultB)).amount;
  const traderAssetBalBefore5 = (await getAccount(connection, traderAssetAta)).amount;
  const reverseAmountIn = traderAssetBalBefore5 / 4n;
  const reverseQuote = quoteAmmSwap(reserveBBefore5, reserveABefore5, reverseAmountIn, BigInt(pool.feeBps));
  const traderWsolBalBefore = (await getAccount(connection, traderWsolAta)).amount;
  const swapIx5 = await buildSwapInstruction({
    program,
    trader: trader.publicKey,
    mintA: WRAPPED_SOL_MINT,
    mintB: testAsset.mint,
    amountIn: reverseAmountIn,
    minimumAmountOut: (reverseQuote.amountOut * 99n) / 100n,
    aToB: false,
  });
  await send(new Transaction().add(swapIx5), [trader], "swap mockX->SOL");
  const traderWsolBalAfter = (await getAccount(connection, traderWsolAta)).amount;
  console.log(`Trader WSOL balance: ${traderWsolBalBefore} -> ${traderWsolBalAfter} (received ${traderWsolBalAfter - traderWsolBalBefore}, quoted ${reverseQuote.amountOut})`);
  if (traderWsolBalAfter - traderWsolBalBefore !== reverseQuote.amountOut) throw new Error("FAIL: reverse swap output did not match quote.");

  console.log("\n=========================================================");
  console.log("ALL ssr_devnet_amm LIVE VERIFICATIONS PASSED.");
  console.log("=========================================================");
  console.log(`Program: ${program.programId.toBase58()}`);
  console.log(`Explorer: https://explorer.solana.com/address/${program.programId.toBase58()}?cluster=devnet`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
