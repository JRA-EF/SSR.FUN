// READ-ONLY Mainnet verification (DEC-0154): builds the current SDK mint
// instruction for CHARLI and simulates it (sigVerify off, nothing ever
// lands on-chain, no signature involved) -- proves the SDK account shape
// matches the DEPLOYED binary. Run with HELIUS_MAINNET_RPC_URL exported.
// Expected result: err: null.
const { Connection, PublicKey, Transaction } = require("@solana/web3.js");
const sdk = require("C:/Users/JRA DEVNET/Projects/SSR.FUN/packages/sdk/dist/src/index.js");
(async () => {
  const connection = new Connection(process.env.HELIUS_URL, "confirmed");
  const program = sdk.buildReadOnlyProgram(connection);
  const RESERVE = new PublicKey("EK5WwpsRuWPCAhV4Rd4s5SRuE6Gnbc8SA94oUjZbHfVb");
  const USER = new PublicKey("6BjTPAWGjUYjL2Hrvz7iVmzWv8yKHNDqUAif5DEPWZen");
  const candidates = ["So11111111111111111111111111111111111111112", "BpdHpqznEgYPXZNrJVRZvBhdWoafYLVVuLxTQo34pump", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"].map(m => new PublicKey(m));
  const live = await sdk.fetchReserveOnChain(connection, program.programId, RESERVE, candidates);
  if (!live) throw new Error("reserve not found");
  console.log("CHARLI live: status", live.status, "| supply", live.reserveTokenSupplyRaw, "| assets:", live.assets.map(a => a.assetMint.slice(0,6) + ":" + a.vaultBalanceRaw).join(" "));
  const assets = live.assets.map(a => ({ mint: a.assetMint, decimals: a.decimals, reserveAsset: a.reserveAsset, vault: a.vault, vaultBalanceRaw: a.vaultBalanceRaw }));
  const [protocolConfig] = sdk.findProtocolConfig(program.programId);
  const { instructions } = await sdk.buildDirectMultiAssetMintInstructions({
    program, protocolConfig,
    protocolFeeDestination: new PublicKey("3CBpVMPDQD75b5bXgDunkpVJ3EeQWcwU9DCSLsTjWQL5"),
    reserve: RESERVE,
    reserveTokenMint: new PublicKey(live.reserveTokenMint),
    mintAuthority: sdk.findMintAuthority(RESERVE, program.programId)[0],
    user: USER, assets,
    reserveTokenSupplyRaw: live.reserveTokenSupplyRaw,
    reserveTokensRequested: 100000n, // 0.1 CHARLI -- SIMULATION ONLY, never signed or submitted
  });
  const tx = new Transaction().add(...instructions);
  tx.feePayer = USER;
  tx.recentBlockhash = "11111111111111111111111111111111"; // replaced by simulation
  const sim = await connection.simulateTransaction(tx, undefined, undefined);
  console.log("=== SIMULATION (sigVerify off, nothing lands on-chain) ===");
  console.log("err:", JSON.stringify(sim.value.err));
  for (const l of (sim.value.logs || []).slice(-12)) console.log("  ", l);
})().catch(e => { console.error("ERR:", e.message); process.exit(1); });
