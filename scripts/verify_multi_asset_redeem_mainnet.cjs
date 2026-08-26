// READ-ONLY Mainnet verification (DEC-0158): builds the new multi-asset
// redeem for CHARLI (the Creator's real 29.3-token position after the
// successful one-transaction buy) and simulates it -- sigVerify off,
// nothing lands on-chain, no signature involved. Proves the deployed binary
// accepts buildDirectMultiAssetRedeemInstructions' account shape and pays
// both legs. Run with HELIUS_URL exported. Expected result: err: null.
const { Connection, PublicKey, Transaction } = require("@solana/web3.js");
const sdk = require("C:/Users/JRA DEVNET/Projects/SSR.FUN/packages/sdk/dist/src/index.js");

(async () => {
  const connection = new Connection(process.env.HELIUS_URL, "confirmed");
  const program = sdk.buildReadOnlyProgram(connection);
  const RESERVE = new PublicKey("EK5WwpsRuWPCAhV4Rd4s5SRuE6Gnbc8SA94oUjZbHfVb");
  const USER = new PublicKey("6BjTPAWGjUYjL2Hrvz7iVmzWv8yKHNDqUAif5DEPWZen");
  const candidates = ["So11111111111111111111111111111111111111112", "BpdHpqznEgYPXZNrJVRZvBhdWoafYLVVuLxTQo34pump", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"].map((m) => new PublicKey(m));
  const live = await sdk.fetchReserveOnChain(connection, program.programId, RESERVE, candidates);
  if (!live) throw new Error("reserve not found");
  console.log("CHARLI live: supply", live.reserveTokenSupplyRaw, "| redemptionFeeBps", live.redemptionFeeBps, "| assets:", live.assets.map((a) => a.assetMint.slice(0, 6) + ":" + a.vaultBalanceRaw).join(" "));
  const assets = live.assets.map((a) => ({ mint: a.assetMint, decimals: a.decimals, reserveAsset: a.reserveAsset, vault: a.vault, vaultBalanceRaw: a.vaultBalanceRaw }));
  const { instructions, entitlementsRaw } = await sdk.buildDirectMultiAssetRedeemInstructions({
    program,
    reserve: RESERVE,
    reserveTokenMint: new PublicKey(live.reserveTokenMint),
    vaultAuthority: sdk.findVaultAuthority(RESERVE, program.programId)[0],
    user: USER,
    assets,
    reserveTokenSupplyRaw: live.reserveTokenSupplyRaw,
    redemptionFeeBps: BigInt(live.redemptionFeeBps),
    reserveTokensToRedeem: 1_000_000n, // 1 CHARLI -- SIMULATION ONLY, never signed or submitted
  });
  console.log("entitlements (raw):", entitlementsRaw.map((e, i) => `${assets[i].mint.slice(0, 6)}:${e}`).join(" "));
  const tx = new Transaction().add(...instructions);
  tx.feePayer = USER;
  tx.recentBlockhash = "11111111111111111111111111111111"; // replaced by simulation
  const sim = await connection.simulateTransaction(tx, undefined, undefined);
  console.log("=== SIMULATION (sigVerify off, nothing lands on-chain) ===");
  console.log("err:", JSON.stringify(sim.value.err));
  for (const l of (sim.value.logs || []).slice(-10)) console.log("  " + l);
})().catch((e) => {
  console.error("ERR:", e.message);
  process.exit(1);
});
