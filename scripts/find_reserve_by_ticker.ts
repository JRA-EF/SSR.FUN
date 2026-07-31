// Read-only, zero-transaction lookup: finds the on-chain Reserve whose
// parsed metadataUri ticker matches a given string (case-insensitive),
// via the same canonical discovery layer the frontend uses
// (packages/sdk/src/discovery.ts). Built to locate the exact `EGAYQQ`
// Reserve reported during live testing (see docs/project/PROJECT_STATUS.md's
// corrective pass covering issue #8) -- adapted from the ticker-matching
// pattern already used in scripts/verify_discovery.ts's TestLo investigation.
//
// Usage:
//   npx ts-node -P scripts/tsconfig.json scripts/find_reserve_by_ticker.ts EGAYQQ
import { Connection, PublicKey } from "@solana/web3.js";
import { discoverAllReserves, parseReserveMetadataUri, DEVNET_FIXTURES, WRAPPED_SOL_MINT, DEVUSDC_MINT } from "../packages/sdk/src";

const DOCUMENTED_DEFAULT_RPC_URL = "https://api.devnet.solana.com";
const DOCUMENTED_DEFAULT_PROGRAM_ID = "2dURvmSdHeyaFES5rxaE1zgPSHCBLW5BLNguJ2Tu1mkW";

async function main() {
  const target = (process.argv[2] || "EGAYQQ").toLowerCase();
  const connection = new Connection(process.env.HELIUS_RPC_URL || DOCUMENTED_DEFAULT_RPC_URL, "confirmed");
  const programId = new PublicKey(process.env.SSR_PROGRAM_ID || DOCUMENTED_DEFAULT_PROGRAM_ID);
  const candidateMints = [
    new PublicKey(DEVNET_FIXTURES.mints.mintX.address),
    new PublicKey(DEVNET_FIXTURES.mints.mintY.address),
    new PublicKey(DEVNET_FIXTURES.mints.mintZ.address),
    WRAPPED_SOL_MINT,
    DEVUSDC_MINT,
  ];

  console.log(`Searching for Reserve with ticker "${target}" across live DevNet (program ${programId.toBase58()})...`);
  const { reserves, protocolConfig, issues } = await discoverAllReserves(connection, programId, candidateMints);
  console.log(`ProtocolConfig.reserveCount = ${protocolConfig?.reserveCount ?? "unknown"}, discovered ${reserves.length} Reserve(s), ${issues.length} issue(s) while reading.`);
  if (issues.length > 0) {
    console.log("Issues:", JSON.stringify(issues, null, 2));
  }

  let found = false;
  for (const r of reserves) {
    const parsed = parseReserveMetadataUri(r.metadataUri);
    const ticker = (parsed?.ticker ?? "").toLowerCase();
    const name = (parsed?.name ?? "").toLowerCase();
    console.log(`  reserveId ${r.reserveId} -- address ${r.reserve} -- ticker "${parsed?.ticker ?? "(unparsed)"}" -- name "${parsed?.name ?? "(unparsed)"}" -- status ${r.status} -- assetCount ${r.assetCount} -- manager ${r.manager}`);
    if (ticker === target || name.includes(target)) {
      found = true;
      console.log("  >>> MATCH <<<");
      console.log(JSON.stringify(r, null, 2));
    }
  }
  if (!found) {
    console.log(`No Reserve with ticker/name matching "${target}" found among the ${reserves.length} discovered Reserve(s).`);
  }
}

main().catch((e) => {
  console.error("Lookup failed:", e);
  process.exit(1);
});
