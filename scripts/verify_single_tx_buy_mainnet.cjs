// READ-ONLY Mainnet verification (DEC-0156): composes the EXACT single
// transaction the new buy client will build for the Creator's current
// CHARLI retry -- re-wrap of the purchase's recovered SOL + ATA creations
// + mint_reserve_tokens_in_kind -- and simulates it (sigVerify off,
// nothing lands on-chain, no signature involved). Proves the one-approval
// retry succeeds before it is ever offered to a wallet.
// Run with HELIUS_URL exported. Expected result: err: null.
const { Connection, PublicKey, SystemProgram, ComputeBudgetProgram, TransactionMessage, VersionedTransaction } = require("@solana/web3.js");
const { getAssociatedTokenAddressSync, createSyncNativeInstruction } = require("@solana/spl-token");
const sdk = require("C:/Users/JRA DEVNET/Projects/SSR.FUN/packages/sdk/dist/src/index.js");

(async () => {
  const connection = new Connection(process.env.HELIUS_URL, "confirmed");
  const program = sdk.buildReadOnlyProgram(connection);
  const RESERVE = new PublicKey("EK5WwpsRuWPCAhV4Rd4s5SRuE6Gnbc8SA94oUjZbHfVb");
  const USER = new PublicKey("6BjTPAWGjUYjL2Hrvz7iVmzWv8yKHNDqUAif5DEPWZen");
  const WSOL = new PublicKey("So11111111111111111111111111111111111111112");
  const candidates = ["So11111111111111111111111111111111111111112", "BpdHpqznEgYPXZNrJVRZvBhdWoafYLVVuLxTQo34pump", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"].map((m) => new PublicKey(m));
  const live = await sdk.fetchReserveOnChain(connection, program.programId, RESERVE, candidates);
  if (!live) throw new Error("reserve not found");
  console.log("CHARLI live: supply", live.reserveTokenSupplyRaw, "| assets:", live.assets.map((a) => a.assetMint.slice(0, 6) + ":" + a.vaultBalanceRaw).join(" "));

  // The same request the UI's "$10" produces: ~9.69 gross Reserve Tokens.
  const reserveTokensRequested = 9_690_000n;
  const assets = live.assets.map((a) => ({ mint: a.assetMint, decimals: a.decimals, reserveAsset: a.reserveAsset, vault: a.vault, vaultBalanceRaw: a.vaultBalanceRaw }));
  const requirements = sdk.computeMintRequirements(
    reserveTokensRequested,
    BigInt(live.reserveTokenSupplyRaw),
    assets.map((a) => ({ mint: a.mint, vaultBalance: BigInt(a.vaultBalanceRaw) })),
  );
  const wsolRequired = requirements.find((r) => r.mint === WSOL.toBase58()).requiredAmount;
  console.log("required deposits:", requirements.map((r) => `${r.mint.slice(0, 6)}:${r.requiredAmount}`).join(" "), "| wrap lamports:", wsolRequired.toString());

  const [protocolConfig] = sdk.findProtocolConfig(program.programId);
  const { instructions } = await sdk.buildDirectMultiAssetMintInstructions({
    program,
    protocolConfig,
    protocolFeeDestination: new PublicKey("3CBpVMPDQD75b5bXgDunkpVJ3EeQWcwU9DCSLsTjWQL5"),
    reserve: RESERVE,
    reserveTokenMint: new PublicKey(live.reserveTokenMint),
    mintAuthority: sdk.findMintAuthority(RESERVE, program.programId)[0],
    user: USER,
    assets,
    reserveTokenSupplyRaw: live.reserveTokenSupplyRaw,
    reserveTokensRequested,
  });
  const wsolAta = getAssociatedTokenAddressSync(WSOL, USER);
  const ixs = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }),
    ...instructions.slice(0, -1), // the ATA creations (incl. the wSOL ATA the sweep closed)
    SystemProgram.transfer({ fromPubkey: USER, toPubkey: wsolAta, lamports: wsolRequired }),
    createSyncNativeInstruction(wsolAta),
    instructions[instructions.length - 1], // the mint, last
  ];
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({ payerKey: USER, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message([]);
  const tx = new VersionedTransaction(message);
  console.log("composed:", ixs.length, "instructions,", tx.serialize().length, "bytes (limit 1232)");

  const sim = await connection.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
  console.log("=== SIMULATION (sigVerify off, nothing lands on-chain) ===");
  console.log("err:", JSON.stringify(sim.value.err));
  for (const l of (sim.value.logs || []).slice(-12)) console.log("  " + l);
})().catch((e) => {
  console.error(String(e.stack || e.message || e));
  process.exit(1);
});
