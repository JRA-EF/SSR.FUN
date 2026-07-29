// Read-only, bounded live-DevNet verification of the Phase A canonical
// discovery layer (packages/sdk/src/discovery.ts). See
// docs/project/DEVNET_IMPLEMENTATION_PLAN_2026-07-29.md "Phase A" for the
// requirement this proves and docs/protocol/FRONTEND_INTEGRATION.md's
// "Canonical discovery" section for the architecture this exercises.
//
// THIS SCRIPT SENDS ZERO TRANSACTIONS. Every call below is a read
// (getAccountInfo / getTokenSupply / getAccount / getMint via a read-only,
// non-signing Anchor provider) -- no keypair is loaded, no instruction is
// built, and nothing is signed or submitted. It reuses the EXACT SAME
// discovery/decoding functions the frontend calls (packages/sdk/src/
// discovery.ts, src/merge/lib/onChainReserve.ts's buildDtrFromDiscoveredReserve)
// rather than re-implementing discovery logic, so a pass here is evidence
// the frontend's own code path works against live DevNet, not just that
// *some* code can read these accounts.
//
// Usage:
//   npx ts-node -P scripts/tsconfig.json scripts/verify_discovery.ts
import { Connection, PublicKey } from "@solana/web3.js";
import { getMint, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import {
  discoverAllReserves,
  discoverDelegatesForReserve,
  fetchProtocolConfig,
  parseReserveMetadataUri,
  DEVNET_FIXTURES,
  WRAPPED_SOL_MINT,
  DEVUSDC_MINT,
  findReserve,
  findReserveAsset,
  findReserveVault,
  findVaultAuthority,
} from "../packages/sdk/src";
import { buildDtrFromDiscoveredReserve } from "../src/merge/lib/onChainReserve";
import idl from "../packages/sdk/idl/ssr_protocol.json";

// ---------------------------------------------------------------------------
// 1-2. Explicit RPC/program/cluster confirmation, mirroring the repo's
// documented default configuration (src/merge/lib/solana-config.ts). Scripts
// run under plain Node/ts-node, which has no `import.meta.env` (a Vite-only
// mechanism), so the same literal default is used here rather than imported --
// exactly the existing convention already used by scripts/verify_reads.ts.
// ---------------------------------------------------------------------------
const DOCUMENTED_DEFAULT_RPC_URL = "https://api.devnet.solana.com"; // matches SOLANA_RPC_URL's default in src/merge/lib/solana-config.ts
const DOCUMENTED_DEFAULT_CLUSTER = "devnet"; // matches SOLANA_CLUSTER's default in src/merge/lib/solana-config.ts
const DOCUMENTED_DEFAULT_PROGRAM_ID = "2dURvmSdHeyaFES5rxaE1zgPSHCBLW5BLNguJ2Tu1mkW"; // matches SSR_PROGRAM_ID's default in src/merge/lib/solana-config.ts

const ACCOUNT_DISCRIMINATORS: Record<string, number[]> = Object.fromEntries(
  (idl as { accounts: { name: string; discriminator: number[] }[] }).accounts.map((a) => [a.name, a.discriminator]),
);

interface Issue {
  scope: string;
  detail: string;
  message: string;
}

function bytesEqual(a: number[] | Buffer, b: number[] | Buffer): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

async function verifyAccountOwnerAndDiscriminator(
  connection: Connection,
  label: string,
  address: PublicKey,
  expectedOwner: PublicKey,
  expectedAccountName: keyof typeof ACCOUNT_DISCRIMINATORS,
  issues: Issue[],
): Promise<boolean> {
  let info: Awaited<ReturnType<typeof connection.getAccountInfo>>;
  try {
    info = await connection.getAccountInfo(address);
  } catch (e) {
    // RPC failure (e.g. sustained 429 rate-limiting on the public DevNet
    // endpoint, confirmed to occur under this script's own call volume) must
    // be recorded as an honest "could not verify," never silently treated as
    // pass OR allowed to abort verification of every other account.
    issues.push({ scope: "integrity", detail: `${label} ${address.toBase58()}`, message: `getAccountInfo failed (RPC error, not a decode/ownership failure): ${e instanceof Error ? e.message : String(e)}` });
    return false;
  }
  if (!info) {
    issues.push({ scope: "integrity", detail: `${label} ${address.toBase58()}`, message: "account does not exist (getAccountInfo returned null)" });
    return false;
  }
  let ok = true;
  if (!info.owner.equals(expectedOwner)) {
    issues.push({
      scope: "integrity",
      detail: `${label} ${address.toBase58()}`,
      message: `unexpected owner: got ${info.owner.toBase58()}, expected ${expectedOwner.toBase58()}`,
    });
    ok = false;
  }
  const expectedDisc = ACCOUNT_DISCRIMINATORS[expectedAccountName];
  const actualDisc = Array.from(info.data.subarray(0, 8));
  if (!bytesEqual(actualDisc, expectedDisc)) {
    issues.push({
      scope: "integrity",
      detail: `${label} ${address.toBase58()}`,
      message: `discriminator mismatch: got [${actualDisc}], expected ${expectedAccountName} [${expectedDisc}]`,
    });
    ok = false;
  }
  return ok;
}

async function main() {
  console.log("=".repeat(78));
  console.log("SSR Phase A canonical discovery -- bounded live DevNet verification");
  console.log("READ-ONLY: no keypair loaded, no instruction built, no transaction sent.");
  console.log("=".repeat(78));

  // --- 1/2: connect + confirm cluster/program ---------------------------
  const rpcUrl = DOCUMENTED_DEFAULT_RPC_URL;
  const programId = new PublicKey(DEVNET_FIXTURES.programId);
  console.log(`\nRPC endpoint: ${rpcUrl}`);
  console.log(`Expected cluster (per src/merge/lib/solana-config.ts default): ${DOCUMENTED_DEFAULT_CLUSTER}`);
  console.log(`Expected program ID (per src/merge/lib/solana-config.ts default): ${DOCUMENTED_DEFAULT_PROGRAM_ID}`);
  console.log(`Program ID actually used (per packages/sdk/fixtures/devnet-fixtures.json): ${programId.toBase58()}`);
  if (programId.toBase58() !== DOCUMENTED_DEFAULT_PROGRAM_ID) {
    throw new Error("Program ID mismatch between solana-config.ts's documented default and devnet-fixtures.json -- refusing to proceed against an unexpected program.");
  }
  console.log("Program ID confirmed to match the documented default. Proceeding.");

  const connection = new Connection(rpcUrl, "confirmed");
  const genesisHash = await connection.getGenesisHash();
  // DevNet's well-known genesis hash -- an independent cluster-identity check
  // beyond just trusting the RPC URL string.
  const DEVNET_GENESIS_HASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
  console.log(`Genesis hash: ${genesisHash} (${genesisHash === DEVNET_GENESIS_HASH ? "confirmed DevNet" : "NOT the known DevNet genesis hash -- STOP and investigate"})`);
  if (genesisHash !== DEVNET_GENESIS_HASH) {
    throw new Error(`Refusing to proceed: genesis hash ${genesisHash} does not match known DevNet genesis ${DEVNET_GENESIS_HASH}.`);
  }

  const programAccountInfo = await connection.getAccountInfo(programId);
  if (!programAccountInfo) throw new Error(`No account found at program ID ${programId.toBase58()} on this cluster -- is the program actually deployed here?`);
  console.log(`Program account found, executable=${programAccountInfo.executable}, owner=${programAccountInfo.owner.toBase58()} (expected the BPFLoaderUpgradeable program).`);

  // --- 3: canonical discovery, via the EXACT SAME function the frontend uses ---
  const CANDIDATE_ASSET_MINTS = [WRAPPED_SOL_MINT, DEVUSDC_MINT, ...Object.values(DEVNET_FIXTURES.mints).map((m) => new PublicKey(m.address))];
  console.log(`\nCandidate asset-mint hints used (see discovery.ts's documented limitation): ${CANDIDATE_ASSET_MINTS.map((m) => m.toBase58()).join(", ")}`);
  console.log("These are ONLY discovery hints -- every one is independently fetched, owned-checked, and decoded below; none is trusted as canonical without that verification.");

  const protocolConfig = await fetchProtocolConfig(connection, programId);
  if (!protocolConfig) throw new Error("ProtocolConfig account not found -- program not initialized on this cluster.");
  console.log(`\nProtocolConfig: reserveCount=${protocolConfig.reserveCount}, paused=${protocolConfig.paused}, authority=${protocolConfig.authority}, maxReserveAssets=${protocolConfig.maxReserveAssets}`);

  const { reserves, issues: discoveryIssues } = await discoverAllReserves(connection, programId, CANDIDATE_ASSET_MINTS);
  console.log(`\nDiscovery method actually exercised: enumerate reserveId 0..${protocolConfig.reserveCount - 1n} via findReserve() PDA derivation + program.account.reserve.fetchNullable() (NO getProgramAccounts call was made).`);
  console.log(`Discovered ${reserves.length} genuine Decentralized Token Reserve account(s) (of ${protocolConfig.reserveCount} possible reserveIds).`);
  if (discoveryIssues.length > 0) {
    console.log(`Non-fatal discovery issues encountered (malformed/unreadable accounts did NOT abort the rest of discovery): ${discoveryIssues.length}`);
    for (const iss of discoveryIssues) console.log(`  - [${iss.scope}] reserveId=${iss.reserveId} ${iss.detail}: ${iss.message}`);
  } else {
    console.log("No malformed/unreadable accounts encountered during this pass.");
  }

  // --- 5: confirm discovery does NOT depend on hardcoded fixture identity ---
  const knownFixtureAddresses = new Set([DEVNET_FIXTURES.reserveOne.reserve, DEVNET_FIXTURES.reserveTwo.reserve]);
  const nonFixtureReserves = reserves.filter((r) => !knownFixtureAddresses.has(r.reserve));
  console.log(`\nOf ${reserves.length} discovered Reserves, ${nonFixtureReserves.length} are NOT one of the 2 committed fixtures -- these could only have been found by the reserveId-enumeration method, proving discovery is not fixture-list-driven.`);

  // --- per-Reserve deep verification ---
  const globalIssues: Issue[] = [];
  const seenReserveAddresses = new Set<string>();
  const seenReserveTokenMints = new Set<string>();
  // A plain object wrapper (rather than a bare `let`) so TypeScript doesn't
  // over-narrow this to `never` at the read site below -- it's mutated from
  // inside verifyOneReserve, a separately-declared nested function, which TS's
  // control-flow analysis can't see through for a directly reassigned `let`.
  const testLoMatchBox: { current: { reserveId: string; reserve: string; matchedOn: string } | null } = { current: null };

  for (const reserve of reserves) {
    console.log("\n" + "-".repeat(78));
    console.log(`Reserve id=${reserve.reserveId}  PDA=${reserve.reserve}`);
    console.log("-".repeat(78));
    try {
      await verifyOneReserve(reserve);
    } catch (e) {
      // Defense in depth: an unexpected failure verifying ONE Reserve's
      // extra integrity checks (e.g. sustained RPC rate-limiting, confirmed
      // to occur under this script's own call volume against the public
      // DevNet endpoint) must not abort verification of every OTHER
      // Reserve -- record it honestly and continue.
      globalIssues.push({ scope: "reserve", detail: reserve.reserve, message: `verification of this Reserve did not complete: ${e instanceof Error ? e.message : String(e)}` });
      console.log(`  !! verification of this Reserve did not complete (recorded as an issue, continuing): ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function verifyOneReserve(reserve: (typeof reserves)[number]): Promise<void> {
    // --- duplicate canonical identity check ---
    if (seenReserveAddresses.has(reserve.reserve)) {
      globalIssues.push({ scope: "integrity", detail: reserve.reserve, message: "DUPLICATE Reserve PDA discovered twice in one pass" });
    }
    seenReserveAddresses.add(reserve.reserve);
    if (seenReserveTokenMints.has(reserve.reserveTokenMint)) {
      globalIssues.push({ scope: "integrity", detail: reserve.reserveTokenMint, message: "DUPLICATE Reserve Token mint shared by two different Reserves" });
    }
    seenReserveTokenMints.add(reserve.reserveTokenMint);

    // --- integrity: owner + discriminator + PDA rederivation for the Reserve account itself ---
    const [rederivedReserve] = findReserve(BigInt(reserve.reserveId), programId);
    if (rederivedReserve.toBase58() !== reserve.reserve) {
      globalIssues.push({ scope: "integrity", detail: reserve.reserve, message: `PDA rederivation mismatch: expected ${rederivedReserve.toBase58()}` });
    }
    await verifyAccountOwnerAndDiscriminator(connection, "Reserve", new PublicKey(reserve.reserve), programId, "Reserve", globalIssues);

    // --- Manager authority ---
    console.log(`Manager authority: ${reserve.manager}`);

    // --- Reserve Token mint + decimals + supply ---
    const reserveTokenMintPk = new PublicKey(reserve.reserveTokenMint);
    let reserveTokenDecimals: number | null = null;
    try {
      const mintInfo = await getMint(connection, reserveTokenMintPk);
      reserveTokenDecimals = mintInfo.decimals;
    } catch (e) {
      globalIssues.push({ scope: "mint", detail: reserve.reserveTokenMint, message: `getMint failed: ${e instanceof Error ? e.message : String(e)}` });
    }
    const supplyHuman = reserveTokenDecimals !== null ? (Number(reserve.reserveTokenSupplyRaw) / 10 ** reserveTokenDecimals).toLocaleString() : "unknown (decimals unresolved)";
    console.log(`Reserve Token mint: ${reserve.reserveTokenMint}`);
    console.log(`Reserve Token decimals (verified via getMint, not assumed): ${reserveTokenDecimals ?? "FAILED TO RESOLVE"}`);
    console.log(`Reserve Token supply (raw): ${reserve.reserveTokenSupplyRaw}  (human: ${supplyHuman})`);

    // --- Pause / lifecycle state ---
    console.log(`Status (pause/lifecycle state currently supported by the deployed program): ${reserve.status}`);

    // --- Assets: mint, vault, verified balance, target weight ---
    console.log(`Assets: ${reserve.resolvedAssetCount} of ${reserve.assetCount} on-chain-reported asset(s) resolved via candidate-mint hints${reserve.resolvedAssetCount < reserve.assetCount ? "  <-- UNDER-RESOLVED, see limitation note below" : ""}`);
    for (const asset of reserve.assets) {
      console.log(`  - mint=${asset.assetMint} vault=${asset.vault} targetWeightBps=${asset.targetWeightBps} enabled=${asset.enabled} decimals(on ReserveAsset)=${asset.decimals}`);
      console.log(`    vault balance (verified via getAccount, raw): ${asset.vaultBalanceRaw}  (human: ${(Number(asset.vaultBalanceRaw) / 10 ** asset.decimals).toLocaleString()})`);

      // integrity: ReserveAsset owner/discriminator/cross-contamination
      const [reserveAssetPda] = findReserveAsset(new PublicKey(reserve.reserve), new PublicKey(asset.assetMint), programId);
      if (reserveAssetPda.toBase58() !== asset.reserveAsset) {
        globalIssues.push({ scope: "integrity", detail: asset.reserveAsset, message: `ReserveAsset PDA rederivation mismatch: expected ${reserveAssetPda.toBase58()}` });
      }
      await verifyAccountOwnerAndDiscriminator(connection, "ReserveAsset", new PublicKey(asset.reserveAsset), programId, "ReserveAsset", globalIssues);

      // integrity: vault PDA + vault owner (token program) + vault.mint matches asset mint + vault authority
      const [vaultPda] = findReserveVault(new PublicKey(reserve.reserve), new PublicKey(asset.assetMint), programId);
      if (vaultPda.toBase58() !== asset.vault) {
        globalIssues.push({ scope: "integrity", detail: asset.vault, message: `Vault PDA rederivation mismatch: expected ${vaultPda.toBase58()}` });
      }
      const [vaultAuthority] = findVaultAuthority(new PublicKey(reserve.reserve), programId);
      let vaultAccountInfo: Awaited<ReturnType<typeof connection.getAccountInfo>> = null;
      let vaultFetchFailed = false;
      try {
        vaultAccountInfo = await connection.getAccountInfo(new PublicKey(asset.vault));
      } catch (e) {
        vaultFetchFailed = true;
        globalIssues.push({ scope: "vault", detail: asset.vault, message: `getAccountInfo failed (RPC error, not a decode/ownership failure): ${e instanceof Error ? e.message : String(e)}` });
      }
      if (!vaultAccountInfo && !vaultFetchFailed) {
        globalIssues.push({ scope: "vault", detail: asset.vault, message: "vault account does not exist" });
      } else if (vaultAccountInfo && !vaultAccountInfo.owner.equals(TOKEN_PROGRAM_ID) && !vaultAccountInfo.owner.equals(TOKEN_2022_PROGRAM_ID)) {
        globalIssues.push({ scope: "vault", detail: asset.vault, message: `vault owned by unsupported/unexpected program ${vaultAccountInfo.owner.toBase58()} (expected SPL Token or Token-2022)` });
      }
      try {
        const { getAccount } = await import("@solana/spl-token");
        const vaultParsed = await getAccount(connection, new PublicKey(asset.vault), undefined, vaultAccountInfo?.owner);
        if (!vaultParsed.mint.equals(new PublicKey(asset.assetMint))) {
          globalIssues.push({ scope: "vault", detail: asset.vault, message: `vault's mint (${vaultParsed.mint.toBase58()}) does not match the declared asset mint (${asset.assetMint}) -- possible cross-Reserve contamination` });
        }
        if (!vaultParsed.owner.equals(vaultAuthority)) {
          globalIssues.push({ scope: "vault", detail: asset.vault, message: `vault authority (${vaultParsed.owner.toBase58()}) does not match this Reserve's derived vaultAuthority (${vaultAuthority.toBase58()})` });
        }
      } catch (e) {
        globalIssues.push({ scope: "vault", detail: asset.vault, message: `failed to parse vault token account: ${e instanceof Error ? e.message : String(e)}` });
      }

      // integrity: underlying asset mint decimals cross-check against what ReserveAsset recorded
      try {
        const assetMintInfo = await getMint(connection, new PublicKey(asset.assetMint), undefined, vaultAccountInfo?.owner);
        if (assetMintInfo.decimals !== asset.decimals) {
          globalIssues.push({ scope: "mint", detail: asset.assetMint, message: `mint decimals (${assetMintInfo.decimals}) do not match ReserveAsset's recorded decimals (${asset.decimals})` });
        }
      } catch (e) {
        globalIssues.push({ scope: "mint", detail: asset.assetMint, message: `getMint failed (unsupported token program or malformed mint?): ${e instanceof Error ? e.message : String(e)}` });
      }
    }
    if (reserve.assetCount === 0) {
      console.log("  (no assets registered yet)");
    }

    // --- Delegates: discover via candidate wallets, decode capabilities/scope/status ---
    const candidateWallets = Array.from(
      new Set([reserve.manager, DEVNET_FIXTURES.delegates.updateTargets.wallet, DEVNET_FIXTURES.delegates.pauseUnpause.wallet]),
    ).map((w) => new PublicKey(w));
    const delegates = await discoverDelegatesForReserve(connection, programId, new PublicKey(reserve.reserve), candidateWallets);
    console.log(`Delegates: ${delegates.length} resolved via candidate-wallet hints, of ${reserve.delegateCount} reported on-chain${delegates.length < reserve.delegateCount ? "  <-- UNDER-RESOLVED, see limitation note below" : ""}`);
    for (const d of delegates) {
      await verifyAccountOwnerAndDiscriminator(connection, "Delegate", new PublicKey(d.delegateAccount), programId, "Delegate", globalIssues);
      console.log(`  - wallet=${d.wallet} account=${d.delegateAccount} permissions(bitmask)=${d.permissions} restricted=${d.restricted} addedAt=${new Date(d.addedAt * 1000).toISOString()}`);
    }

    // --- Metadata / name / ticker resolution, source clearly separated from canonical identity ---
    const parsedMeta = parseReserveMetadataUri(reserve.metadataUri);
    console.log(`metadataUri (raw, on-chain field): ${reserve.metadataUri || "(empty)"}`);
    if (parsedMeta) {
      console.log(`Resolved display name: "${parsedMeta.name}"  ticker: "${parsedMeta.ticker}"  (source: this Reserve's own on-chain metadataUri field, decoded as data:application/json -- NOT a substitute for the canonical PDA/mint addresses printed above)`);
    } else if (reserve.reserve === DEVNET_FIXTURES.reserveOne.reserve || reserve.reserve === DEVNET_FIXTURES.reserveTwo.reserve) {
      console.log(`Resolved display name: falls back to a hardcoded committed-fixture description (source: src/merge/lib/onChainReserve.ts's KNOWN_FIXTURE_META, since this Reserve predates the metadataUri convention) -- NOT parsed from on-chain metadata.`);
    } else {
      console.log(`Resolved display name: UNRESOLVED from on-chain metadata (metadataUri is not a data:application/json URI) -- frontend honestly falls back to "Unnamed Decentralized Token Reserve (#${reserve.reserveId})", never a fabricated name.`);
    }

    // --- TestLo/MOCX investigation: match on resolved metadata content, never on candidate-list position ---
    const tickerLower = parsedMeta?.ticker?.toLowerCase() ?? "";
    const nameLower = parsedMeta?.name?.toLowerCase() ?? "";
    if (tickerLower === "testlo" || nameLower.includes("strategic sol reserve")) {
      testLoMatchBox.current = { reserveId: reserve.reserveId, reserve: reserve.reserve, matchedOn: tickerLower === "testlo" ? "ticker == 'TestLo' (on-chain metadataUri)" : "name contains 'Strategic Sol Reserve' (on-chain metadataUri)" };
      console.log(`>>> METADATA MATCH: this Reserve's own on-chain metadataUri identifies it as TestLo/Strategic Sol Reserve (matched on: ${testLoMatchBox.current.matchedOn}) <<<`);
    }

    // --- Also build the exact DTR object the frontend would render, to prove frontend-consistency ---
    const dtr = buildDtrFromDiscoveredReserve(reserve, delegates, null);
    console.log(`Frontend-equivalent DTR object: id=${dtr.id} name=${JSON.stringify(dtr.name)} ticker=${JSON.stringify(dtr.ticker)} aum(simulated USD)=${dtr.aum.toFixed(2)} nav(simulated USD)=${dtr.nav.toFixed(4)} onChain.reserve=${dtr.onChain?.reserve}`);
  }

  // --- TestLo summary ---
  console.log("\n" + "=".repeat(78));
  console.log("TestLo / MOCX investigation result");
  console.log("=".repeat(78));
  if (testLoMatchBox.current) {
    console.log(`FOUND via general discovery (not a hardcoded special case): reserveId=${testLoMatchBox.current.reserveId} PDA=${testLoMatchBox.current.reserve}, matched on ${testLoMatchBox.current.matchedOn}.`);
  } else {
    console.log("NOT FOUND: no discovered Reserve's on-chain metadataUri resolved to a ticker of 'TestLo' or a name containing 'Strategic Sol Reserve'.");
    console.log("Most efficient single item to supply next: the TestLo Decentralized Token Reserve's PDA/account address (or its reserveId) -- with that, this same script can target it directly regardless of whether its metadata parses.");
  }
  console.log('Note: "MOCX" cannot be resolved from any on-chain metadata account -- SPL mints on Solana have no intrinsic on-chain name/symbol field, and this program integrates no Metaplex/token-metadata program at all (confirmed by repo-wide search). The only place "mockX/Y/Z" symbols exist is the hardcoded devnet-fixtures.json registry cross-referencing a real mint address to a human label -- if TestLo\'s underlying asset mint is NOT one of the 3 fixture mints, it will show as an unresolved/unnamed asset (or simply not be found at all, since it also would not be in the candidate-mint hint list), not as "MOCX".');

  // --- integrity summary ---
  console.log("\n" + "=".repeat(78));
  console.log(`Account-integrity issues found: ${globalIssues.length + discoveryIssues.length}`);
  console.log("=".repeat(78));
  for (const iss of globalIssues) console.log(`  - [${iss.scope}] ${iss.detail}: ${iss.message}`);
  if (globalIssues.length === 0 && discoveryIssues.length === 0) {
    console.log("None. Every discovered account matched its expected program owner, Anchor discriminator, and PDA derivation; no cross-Reserve contamination, no duplicate canonical identities, no unsupported token program encountered.");
  }

  console.log("\n" + "=".repeat(78));
  console.log("CONFIRMED: this script sent zero transactions. No account was created, modified, closed, or transferred.");
  console.log("=".repeat(78));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
