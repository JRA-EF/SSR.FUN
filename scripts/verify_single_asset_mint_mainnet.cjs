// READ-ONLY Mainnet verification (DEC-0160): finds the live single-asset
// Reserve(s) (e.g. ALPHA, 100% SSR), builds the now-generalized one-leg
// mint via buildDirectMultiAssetMintInstructions, and simulates it
// (sigVerify off, nothing lands on-chain). Proves the exact composition
// that failed live ("requires a genuinely multi-asset Reserve; found 1")
// now builds and executes. Run with HELIUS_URL exported. Expected: err null.
const { Connection, PublicKey, Transaction } = require("@solana/web3.js");
const sdk = require("C:/Users/JRA DEVNET/Projects/SSR.FUN/packages/sdk/dist/src/index.js");

(async () => {
  const connection = new Connection(process.env.HELIUS_URL, "confirmed");
  const program = sdk.buildReadOnlyProgram(connection);
  const USER = new PublicKey("6BjTPAWGjUYjL2Hrvz7iVmzWv8yKHNDqUAif5DEPWZen");
  const TREASURY = new PublicKey("3CBpVMPDQD75b5bXgDunkpVJ3EeQWcwU9DCSLsTjWQL5");
  const mints = await sdk.enumerateReserveAssetMintsOnChain(connection);
  const { reserves } = await sdk.discoverAllReserves(connection, program.programId, mints.map((m) => new PublicKey(m)));
  const singles = reserves.filter((r) => r.assetCount === 1 && r.assets.length === 1 && Number(r.reserveTokenSupplyRaw) > 0);
  console.log("single-asset reserves found:", singles.map((r) => `${r.reserve.slice(0, 8)} (${r.assets[0].assetMint.slice(0, 6)})`).join(", ") || "none");
  for (const r of singles) {
    if (r.assets[0].assetMint === "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v") continue; // pure USDC uses the direct amountIn path
    const assets = r.assets.map((a) => ({ mint: a.assetMint, decimals: a.decimals, reserveAsset: a.reserveAsset, vault: a.vault, vaultBalanceRaw: a.vaultBalanceRaw }));
    const [protocolConfig] = sdk.findProtocolConfig(program.programId);
    const { instructions, requiredAmountsRaw } = await sdk.buildDirectMultiAssetMintInstructions({
      program,
      protocolConfig,
      protocolFeeDestination: TREASURY,
      reserve: new PublicKey(r.reserve),
      reserveTokenMint: new PublicKey(r.reserveTokenMint),
      mintAuthority: sdk.findMintAuthority(new PublicKey(r.reserve), program.programId)[0],
      user: USER,
      assets,
      reserveTokenSupplyRaw: r.reserveTokenSupplyRaw,
      reserveTokensRequested: 1_000_000n, // 1 Reserve Token -- SIMULATION ONLY, never signed or submitted
    });
    console.log(`\n=== ${r.reserve.slice(0, 8)}... asset ${assets[0].mint.slice(0, 6)} requires ${requiredAmountsRaw[0]} raw for 1 RT`);
    const tx = new Transaction().add(...instructions);
    tx.feePayer = USER;
    tx.recentBlockhash = "11111111111111111111111111111111";
    const sim = await connection.simulateTransaction(tx, undefined, undefined);
    console.log("err:", JSON.stringify(sim.value.err));
    for (const l of (sim.value.logs || []).slice(-4)) console.log("  " + l);
  }
})().catch((e) => {
  console.error("ERR:", e.message);
  process.exit(1);
});
