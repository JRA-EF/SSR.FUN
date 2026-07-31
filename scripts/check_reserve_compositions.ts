// Read-only, zero-transaction check: lists every on-chain Reserve's asset
// composition and flags which ones are genuinely 100%-devUSDC-backed (the
// only composition shape the corrected Buy architecture can currently fund
// without any hidden/fabricated asset legs -- see docs/project/DECISION_LOG.md's
// devUSDC-Buy-architecture correction).
//
// Usage:
//   npx ts-node -P scripts/tsconfig.json scripts/check_reserve_compositions.ts
import { Connection, PublicKey } from "@solana/web3.js";
import { discoverAllReserves, parseReserveMetadataUri, DEVNET_FIXTURES, WRAPPED_SOL_MINT, DEVUSDC_MINT } from "../packages/sdk/src";

async function main() {
  const connection = new Connection(process.env.HELIUS_RPC_URL || "https://api.devnet.solana.com", "confirmed");
  const programId = new PublicKey(DEVNET_FIXTURES.programId);
  const candidateMints = [
    new PublicKey(DEVNET_FIXTURES.mints.mintX.address),
    new PublicKey(DEVNET_FIXTURES.mints.mintY.address),
    new PublicKey(DEVNET_FIXTURES.mints.mintZ.address),
    WRAPPED_SOL_MINT,
    DEVUSDC_MINT,
  ];
  const { reserves } = await discoverAllReserves(connection, programId, candidateMints);
  let pureDevUsdcCount = 0;
  for (const r of reserves) {
    const parsed = parseReserveMetadataUri(r.metadataUri);
    const isPureDevUsdc = r.assets.length > 0 && r.assets.every((a) => a.assetMint === DEVUSDC_MINT.toBase58());
    if (isPureDevUsdc) pureDevUsdcCount++;
    const mints = r.assets
      .map((a) => (a.assetMint === DEVUSDC_MINT.toBase58() ? "devUSDC" : a.assetMint === WRAPPED_SOL_MINT.toBase58() ? "SOL" : a.assetMint.slice(0, 6)))
      .join("+");
    console.log(
      `reserveId ${r.reserveId} ticker=${parsed?.ticker ?? "?"} status=${r.status} assetCount=${r.assetCount} assets=[${mints}] PURE_DEVUSDC=${isPureDevUsdc}`,
    );
  }
  console.log(`\n${pureDevUsdcCount} of ${reserves.length} discovered Reserve(s) are genuinely 100% devUSDC-backed.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
