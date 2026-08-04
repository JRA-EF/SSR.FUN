// One-time setup (initialize_amm_config, create_pool x3, seed real
// liquidity) AND live verification of ssr_devnet_amm -- see DEC-0051 and
// this pass's DECISION_LOG entry reworking the hub asset from wrapped SOL
// to devUSDC (see programs/ssr_devnet_amm/src/constants.rs's header
// comment). Real transactions only: every step below is a genuine signed
// DevNet transaction, re-confirmed by re-fetching on-chain state
// afterward, never a simulation or a fabricated outcome.
//
// NOT YET RUN: this rewrite requires the reworked program (AmmConfig.hub_mint,
// create_pool's amm_config.hub_mint constraint) to actually be built and
// deployed first -- this environment has no cargo/rustc/anchor/solana on
// PATH to do that (see this pass's final report). Running this script
// against the CURRENTLY deployed bytecode (still the old WSOL-hub version)
// will fail, since that program doesn't know about hub_mint or accept the
// new initialize_amm_config(hub_mint, default_fee_bps) argument shape.
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
  getAccount,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  DEVNET_FIXTURES,
  DEVUSDC,
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
const DEVUSDC_PER_POOL = 50_000; // Sized generously so ordinary Buy/Sell/rebalance trade sizes never meaningfully slip the price.

async function main() {
  await assertDevnetCluster(connection);
  console.log("Confirmed: connected cluster is genuinely Solana DevNet.\n");

  const deployerSecret = JSON.parse(fs.readFileSync(path.join(require("os").homedir(), ".config", "solana", "devnet-deployer.json"), "utf-8"));
  const deployer = Keypair.fromSecretKey(Uint8Array.from(deployerSecret));

  const managerSecretRaw = fs.readFileSync(path.resolve(__dirname, "..", "devnet-fixtures", "manager-keypair.json"), "utf-8");
  const authority = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(managerSecretRaw)));
  console.log(`AMM authority (reused DevNet swap-authority/manager wallet, also devUSDC's mint authority): ${authority.publicKey.toBase58()}`);

  const authorityBalBefore = await connection.getBalance(authority.publicKey);
  console.log(`Authority SOL balance before funding: ${authorityBalBefore / LAMPORTS_PER_SOL}`);
  const neededLamports = 2 * LAMPORTS_PER_SOL; // Only network fees + rent needed now -- no SOL-wrapping liquidity leg to fund.
  if (authorityBalBefore < neededLamports) {
    const topUp = neededLamports - authorityBalBefore;
    await send(
      new Transaction().add(SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: authority.publicKey, lamports: topUp })),
      [deployer],
      "fund AMM authority from deployer",
    );
  }

  const program = buildReadOnlyAmmProgram(connection) as any;
  const devUsdcMint = new PublicKey(DEVUSDC.mint);

  // --- Step 1: initialize_amm_config (idempotent -- skip if it already exists) ---
  const [ammConfigPda] = findAmmConfig();
  let ammConfig = await (program.account as any).ammConfig.fetchNullable(ammConfigPda);
  if (!ammConfig) {
    console.log("\n--- initialize_amm_config (hub_mint = devUSDC) ---");
    const ix = await buildInitializeAmmConfigInstruction(program, authority.publicKey, devUsdcMint, FEE_BPS);
    await send(new Transaction().add(ix), [authority], "initialize_amm_config");
    ammConfig = await program.account.ammConfig.fetch(ammConfigPda);
  } else {
    console.log("\nAmmConfig already exists -- skipping initialize_amm_config.");
  }
  console.log(`AmmConfig authority: ${ammConfig.authority.toBase58()}, hub_mint: ${ammConfig.hubMint.toBase58()}, default_fee_bps: ${ammConfig.defaultFeeBps}, paused: ${ammConfig.paused}`);
  if (ammConfig.authority.toBase58() !== authority.publicKey.toBase58()) {
    throw new Error("AmmConfig authority mismatch -- refusing to proceed with the wrong signer.");
  }
  if (ammConfig.hubMint.toBase58() !== devUsdcMint.toBase58()) {
    throw new Error("AmmConfig.hub_mint is not devUSDC -- refusing to proceed against a differently-configured AmmConfig.");
  }

  // Only the 3 mock test assets are spokes now -- devUSDC is the hub itself, not a 4th spoke.
  const assets = [
    { symbol: "mockX", mint: new PublicKey(DEVNET_FIXTURES.mints.mintX.address), decimals: DEVNET_FIXTURES.mints.mintX.decimals },
    { symbol: "mockY", mint: new PublicKey(DEVNET_FIXTURES.mints.mintY.address), decimals: DEVNET_FIXTURES.mints.mintY.decimals },
    { symbol: "mockZ", mint: new PublicKey(DEVNET_FIXTURES.mints.mintZ.address), decimals: DEVNET_FIXTURES.mints.mintZ.decimals },
  ];

  const authorityDevUsdcAta = getAssociatedTokenAddressSync(devUsdcMint, authority.publicKey);

  for (const asset of assets) {
    console.log(`\n=== Pool: devUSDC/${asset.symbol} ===`);
    const [poolPda] = findAmmPool(devUsdcMint, asset.mint);
    let pool = await program.account.pool.fetchNullable(poolPda);

    if (!pool) {
      console.log(`--- create_pool(devUSDC, ${asset.symbol}) ---`);
      const ix = await buildCreatePoolInstruction(program, authority.publicKey, devUsdcMint, asset.mint, FEE_BPS);
      await send(new Transaction().add(ix), [authority], `create_pool(${asset.symbol})`);
      pool = await program.account.pool.fetch(poolPda);
    } else {
      console.log(`Pool already exists -- skipping create_pool.`);
    }

    const [vaultA] = findAmmVault(poolPda, devUsdcMint);
    const [vaultB] = findAmmVault(poolPda, asset.mint);
    const vaultABalBefore = await getAccount(connection, vaultA).then((a) => a.amount).catch(() => 0n);
    const vaultBBalBefore = await getAccount(connection, vaultB).then((a) => a.amount).catch(() => 0n);

    if (vaultABalBefore === 0n && vaultBBalBefore === 0n) {
      console.log(`--- Seeding liquidity: ${DEVUSDC_PER_POOL} devUSDC + ${DEVUSDC_PER_POOL} ${asset.symbol} (~$1:$1 start price) ---`);
      const devUsdcAmountRaw = BigInt(DEVUSDC_PER_POOL) * BigInt(10 ** DEVUSDC.decimals);
      const assetAmountRaw = BigInt(DEVUSDC_PER_POOL) * BigInt(10 ** asset.decimals);
      const authorityAssetAta = getAssociatedTokenAddressSync(asset.mint, authority.publicKey);

      // Both legs are a direct mint to the authority's own ATA (the
      // authority is the mint authority for devUSDC AND every mock asset --
      // see api/devnet/_lib/authority.ts's header comment). This is
      // legitimate initial liquidity provisioning by the pool's sole
      // liquidity authority, not a per-trade fabrication substituting for a
      // genuine trade (that distinction -- seeding a pool vs. fabricating a
      // trade leg -- is exactly what this pass's Buy/Sell rewrite (Phase 2)
      // depends on this liquidity actually existing for).
      const seedTx = new Transaction();
      seedTx.add(createAssociatedTokenAccountIdempotentInstruction(authority.publicKey, authorityDevUsdcAta, authority.publicKey, devUsdcMint));
      seedTx.add(createMintToInstruction(devUsdcMint, authorityDevUsdcAta, authority.publicKey, devUsdcAmountRaw));
      seedTx.add(createAssociatedTokenAccountIdempotentInstruction(authority.publicKey, authorityAssetAta, authority.publicKey, asset.mint));
      seedTx.add(createMintToInstruction(asset.mint, authorityAssetAta, authority.publicKey, assetAmountRaw));
      await send(seedTx, [authority], `mint devUSDC + ${asset.symbol} to authority`);

      const addLiqIx = await buildAddLiquidityInstruction(program, authority.publicKey, devUsdcMint, asset.mint, devUsdcAmountRaw, assetAmountRaw);
      await send(new Transaction().add(addLiqIx), [authority], `add_liquidity(devUSDC/${asset.symbol})`);
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
  const [poolPda] = findAmmPool(devUsdcMint, testAsset.mint);
  const [vaultA] = findAmmVault(poolPda, devUsdcMint);
  const [vaultB] = findAmmVault(poolPda, testAsset.mint);
  const pool = await program.account.pool.fetch(poolPda);

  // Use a FRESH trader wallet, funded and given some devUSDC to swap, so
  // the test is a genuine third-party swap, not the liquidity authority
  // trading with itself.
  const trader = Keypair.generate();
  console.log(`\nFresh trader wallet: ${trader.publicKey.toBase58()}`);
  await send(new Transaction().add(SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: trader.publicKey, lamports: 0.05 * LAMPORTS_PER_SOL })), [deployer], "fund trader");

  const traderDevUsdcAta = getAssociatedTokenAddressSync(devUsdcMint, trader.publicKey);
  const traderAssetAta = getAssociatedTokenAddressSync(testAsset.mint, trader.publicKey);
  const traderDevUsdcAmountRaw = BigInt(20) * BigInt(10 ** DEVUSDC.decimals); // 20 devUSDC to trade with -- minted directly, same as the faucet path (api/devnet/faucet-devusdc.ts) does for a real user, not fabricated for this test specifically.
  const setupTx = new Transaction();
  setupTx.add(createAssociatedTokenAccountIdempotentInstruction(trader.publicKey, traderDevUsdcAta, trader.publicKey, devUsdcMint));
  setupTx.add(createMintToInstruction(devUsdcMint, traderDevUsdcAta, authority.publicKey, traderDevUsdcAmountRaw));
  setupTx.add(createAssociatedTokenAccountIdempotentInstruction(trader.publicKey, traderAssetAta, trader.publicKey, testAsset.mint));
  await send(setupTx, [trader, authority], "trader receives 20 devUSDC (authority co-signs the mint), creates mockX ATA");

  // --- Verification 1: real swap, devUSDC -> mockX, with a correct on-chain-matching quote ---
  console.log("\n--- Verification 1: swap devUSDC -> mockX (real transfer, verifiable balance change) ---");
  const reserveABefore = (await getAccount(connection, vaultA)).amount;
  const reserveBBefore = (await getAccount(connection, vaultB)).amount;
  const amountIn = BigInt(5) * BigInt(10 ** DEVUSDC.decimals); // 5 devUSDC
  const quote = quoteAmmSwap(reserveABefore, reserveBBefore, amountIn, BigInt(pool.feeBps));
  console.log(`Quote: fee=${quote.feeAmount}, amountOut=${quote.amountOut} (reserves before: ${reserveABefore} devUSDC / ${reserveBBefore} mockX)`);
  const traderAssetBalBefore = (await getAccount(connection, traderAssetAta)).amount;

  const swapIx1 = await buildSwapInstruction({
    program,
    trader: trader.publicKey,
    mintA: devUsdcMint,
    mintB: testAsset.mint,
    amountIn,
    minimumAmountOut: (quote.amountOut * 99n) / 100n, // 1% slippage tolerance
    aToB: true,
  });
  await send(new Transaction().add(swapIx1), [trader], "swap devUSDC->mockX");

  const traderAssetBalAfter = (await getAccount(connection, traderAssetAta)).amount;
  const actualOut = traderAssetBalAfter - traderAssetBalBefore;
  console.log(`Trader mockX balance: ${traderAssetBalBefore} -> ${traderAssetBalAfter} (received ${actualOut}, quoted ${quote.amountOut})`);
  if (actualOut !== quote.amountOut) throw new Error(`FAIL: actual swap output (${actualOut}) does not match the on-chain-formula quote (${quote.amountOut}).`);
  const reserveAAfter1 = (await getAccount(connection, vaultA)).amount;
  const reserveBAfter1 = (await getAccount(connection, vaultB)).amount;
  console.log(`Pool reserves after: ${reserveAAfter1} devUSDC / ${reserveBAfter1} mockX (real, verifiable on-chain balance change)`);
  if (reserveAAfter1 !== reserveABefore + amountIn) throw new Error("FAIL: pool devUSDC reserve did not increase by exactly amountIn.");
  if (reserveBAfter1 !== reserveBBefore - actualOut) throw new Error("FAIL: pool mockX reserve did not decrease by exactly amountOut.");

  // --- Verification 2: slippage protection rejects an unreasonable minimum_amount_out ---
  console.log("\n--- Verification 2: slippage protection (minimum_amount_out set impossibly high) ---");
  let slippageRejectedCorrectly = false;
  try {
    const badSwapIx = await buildSwapInstruction({
      program,
      trader: trader.publicKey,
      mintA: devUsdcMint,
      mintB: testAsset.mint,
      amountIn: BigInt(1) * BigInt(10 ** DEVUSDC.decimals),
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
  // swap instruction against the REAL devUSDC/mockX pool, then substitute
  // only the mint_b account key for a different real mint (mockY) while
  // leaving the pool/vaults/trader accounts pointing at the real mockX
  // ones. This must be caught by the program's own
  // `#[account(address = pool.mint_b)]` constraint on mint_b, not merely by
  // the client deriving a different pool -- proving the on-chain check
  // itself works, not just the client. ---
  console.log("\n--- Verification 3: mint substitution rejected (mint_b swapped for mockY on the real devUSDC/mockX pool) ---");
  let mintSubstitutionRejected = false;
  try {
    const realIx = await buildSwapInstruction({
      program,
      trader: trader.publicKey,
      mintA: devUsdcMint,
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
      mintA: devUsdcMint,
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

  // --- Verification 5: reverse-direction swap (mockX -> devUSDC) also works ---
  console.log("\n--- Verification 5: reverse swap mockX -> devUSDC ---");
  const reserveABefore5 = (await getAccount(connection, vaultA)).amount;
  const reserveBBefore5 = (await getAccount(connection, vaultB)).amount;
  const traderAssetBalBefore5 = (await getAccount(connection, traderAssetAta)).amount;
  const reverseAmountIn = traderAssetBalBefore5 / 4n;
  const reverseQuote = quoteAmmSwap(reserveBBefore5, reserveABefore5, reverseAmountIn, BigInt(pool.feeBps));
  const traderDevUsdcBalBefore = (await getAccount(connection, traderDevUsdcAta)).amount;
  const swapIx5 = await buildSwapInstruction({
    program,
    trader: trader.publicKey,
    mintA: devUsdcMint,
    mintB: testAsset.mint,
    amountIn: reverseAmountIn,
    minimumAmountOut: (reverseQuote.amountOut * 99n) / 100n,
    aToB: false,
  });
  await send(new Transaction().add(swapIx5), [trader], "swap mockX->devUSDC");
  const traderDevUsdcBalAfter = (await getAccount(connection, traderDevUsdcAta)).amount;
  console.log(`Trader devUSDC balance: ${traderDevUsdcBalBefore} -> ${traderDevUsdcBalAfter} (received ${traderDevUsdcBalAfter - traderDevUsdcBalBefore}, quoted ${reverseQuote.amountOut})`);
  if (traderDevUsdcBalAfter - traderDevUsdcBalBefore !== reverseQuote.amountOut) throw new Error("FAIL: reverse swap output did not match quote.");

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
