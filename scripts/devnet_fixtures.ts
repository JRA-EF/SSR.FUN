// Stands up persistent, documented DevNet fixture state for SSR Protocol
// (root manager, 2 restricted delegates with distinct scopes, 2 holders, a
// 2-asset Reserve and a 3-asset Reserve) -- distinct from tests/ssr_protocol.ts,
// whose keypairs are ephemeral and discarded after each run. This script is
// meant to be run once; it prints and records only public keys, never secret
// keys, to docs/protocol/DEVNET_FIXTURES.md. Generated keypair files are
// written under devnet-fixtures/*-keypair.json, which is gitignored (matches
// the existing *-keypair.json pattern) -- never commit them.
//
// Re-entrant: if fixture wallet keypair files already exist under
// devnet-fixtures/, they're reused (and NOT re-funded) rather than
// regenerated, so a partial/interrupted run (e.g. hitting the public RPC's
// rate limit) can be safely re-run without wasting further DevNet SOL on
// re-funding wallets that are already funded.
//
// Usage (from repo root):
//   export PATH="$HOME/.cargo/bin:/c/devtools/mingw64/bin:/c/devtools/solana/solana-release/bin:$PATH"
//   export ANCHOR_PROVIDER_URL="https://api.devnet.solana.com"
//   export ANCHOR_WALLET="C:\Users\JRA DEVNET\.config\solana\devnet-deployer.json"
//   export TS_NODE_PROJECT="scripts/tsconfig.json"
//   export TS_NODE_TRANSPILE_ONLY=true
//   npx ts-node --require ts-node/register scripts/devnet_fixtures.ts

import * as anchor from "@anchor-lang/core";
import { Program, BN } from "@anchor-lang/core";
import { Keypair, PublicKey, SystemProgram, LAMPORTS_PER_SOL, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";
import {
  findProtocolConfig,
  findReserve,
  findReserveAsset,
  findReserveVault,
  findVaultAuthority,
  findReserveTokenMint,
  findMintAuthority,
  findDelegate,
} from "../packages/sdk/src/pda";

const FIXTURES_DIR = path.resolve(__dirname, "..", "devnet-fixtures");
const DOC_PATH = path.resolve(__dirname, "..", "docs", "protocol", "DEVNET_FIXTURES.md");
const CHECKPOINT_PATH = path.join(FIXTURES_DIR, "checkpoint.json");

// The public DevNet RPC is prone to sustained rate-limiting under this
// session's heavy same-day usage. Every major on-chain step's result is
// checkpointed to disk (pubkeys/amounts only) as soon as it succeeds, so a
// run interrupted by a 429 can be safely re-run and will skip everything
// already done instead of re-creating state (and re-spending SOL/rent) or
// re-hammering the rate-limited endpoint for no reason.
type Checkpoint = Record<string, any>;

function loadCheckpoint(): Checkpoint {
  if (fs.existsSync(CHECKPOINT_PATH)) {
    return JSON.parse(fs.readFileSync(CHECKPOINT_PATH, "utf-8"));
  }
  return {};
}

function saveCheckpoint(cp: Checkpoint) {
  fs.mkdirSync(FIXTURES_DIR, { recursive: true });
  fs.writeFileSync(CHECKPOINT_PATH, JSON.stringify(cp, null, 2));
}

const UPDATE_TARGETS_FLAG = 1 << 1;
const PAUSE_RESERVE_FLAG = 1 << 6;
const UNPAUSE_RESERVE_FLAG = 1 << 7;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const delays = [500, 1000, 2000, 4000, 8000, 15000, 15000, 15000];
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      const is429 = msg.includes("429") || msg.includes("Too many requests") || msg.includes("Too Many Requests");
      if (!is429 || attempt >= delays.length) {
        throw e;
      }
      const delay = delays[attempt];
      console.log(`  [${label}] rate-limited, retrying in ${delay}ms (attempt ${attempt + 1})...`);
      await sleep(delay);
    }
  }
}

function loadOrCreateKeypair(name: string): Keypair {
  const file = path.join(FIXTURES_DIR, `${name}-keypair.json`);
  if (fs.existsSync(file)) {
    const secret = JSON.parse(fs.readFileSync(file, "utf-8"));
    return Keypair.fromSecretKey(Uint8Array.from(secret));
  }
  const kp = Keypair.generate();
  fs.mkdirSync(FIXTURES_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(Array.from(kp.secretKey)));
  return kp;
}

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.SsrProtocol as Program<anchor.Idl>;
  const programId = program.programId;
  const connection = provider.connection;
  const deployer = provider.wallet as anchor.Wallet;
  const [protocolConfig] = findProtocolConfig(programId);

  async function fundWalletIfNeeded(pubkey: PublicKey, lamports: number, label: string): Promise<void> {
    const balance = await withRetry(`getBalance:${label}`, () => connection.getBalance(pubkey));
    if (balance >= lamports / 2) {
      console.log(`${label} already funded (${balance / LAMPORTS_PER_SOL} SOL) -- skipping.`);
      return;
    }
    const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: pubkey, lamports }));
    await withRetry(`fund:${label}`, () => sendAndConfirmTransaction(connection, tx, [deployer.payer]));
  }

  console.log("== SSR Protocol: persistent DevNet fixtures ==");
  console.log("Program ID:", programId.toBase58());

  const cp = loadCheckpoint();

  const manager = loadOrCreateKeypair("manager");
  const delegateTargets = loadOrCreateKeypair("delegateTargets");
  const delegatePause = loadOrCreateKeypair("delegatePause");
  const holderA = loadOrCreateKeypair("holderA");
  const holderB = loadOrCreateKeypair("holderB");

  console.log("Funding fixture wallets from the deployer (skipping any already funded)...");
  await fundWalletIfNeeded(manager.publicKey, 0.3 * LAMPORTS_PER_SOL, "manager");
  await sleep(400);
  await fundWalletIfNeeded(delegateTargets.publicKey, 0.02 * LAMPORTS_PER_SOL, "delegateTargets");
  await sleep(400);
  await fundWalletIfNeeded(delegatePause.publicKey, 0.02 * LAMPORTS_PER_SOL, "delegatePause");
  await sleep(400);
  await fundWalletIfNeeded(holderA.publicKey, 0.05 * LAMPORTS_PER_SOL, "holderA");
  await sleep(400);
  await fundWalletIfNeeded(holderB.publicKey, 0.05 * LAMPORTS_PER_SOL, "holderB");
  await sleep(400);

  console.log("Creating asset mints (skipping any already checkpointed)...");
  if (!cp.mintX) {
    const m = await withRetry("createMint:X", () => createMint(connection, manager, manager.publicKey, null, 6));
    cp.mintX = m.toBase58();
    saveCheckpoint(cp);
    await sleep(1500);
  }
  if (!cp.mintY) {
    const m = await withRetry("createMint:Y", () => createMint(connection, manager, manager.publicKey, null, 6));
    cp.mintY = m.toBase58();
    saveCheckpoint(cp);
    await sleep(1500);
  }
  if (!cp.mintZ) {
    const m = await withRetry("createMint:Z", () => createMint(connection, manager, manager.publicKey, null, 9));
    cp.mintZ = m.toBase58();
    saveCheckpoint(cp);
    await sleep(1500);
  }
  const mintX = new PublicKey(cp.mintX);
  const mintY = new PublicKey(cp.mintY);
  const mintZ = new PublicKey(cp.mintZ);

  async function createReserveFixture(key: string, uri: string) {
    if (cp[key]) {
      const saved = cp[key];
      return {
        reserveId: BigInt(saved.reserveId),
        reserve: new PublicKey(saved.reserve),
        reserveTokenMint: new PublicKey(saved.reserveTokenMint),
        mintAuthority: new PublicKey(saved.mintAuthority),
        vaultAuthority: new PublicKey(saved.vaultAuthority),
      };
    }
    const configBefore: any = await withRetry("fetch:protocolConfig", () => (program.account as any).protocolConfig.fetch(protocolConfig));
    const reserveId = BigInt(configBefore.reserveCount.toString());
    const [reserve] = findReserve(reserveId, programId);
    const [reserveTokenMint] = findReserveTokenMint(reserve, programId);
    const [mintAuthority] = findMintAuthority(reserve, programId);
    const [vaultAuthority] = findVaultAuthority(reserve, programId);

    await withRetry("createReserve", () =>
      program.methods
        .createReserve(uri, 50, 0, 100, 8000, 2000, manager.publicKey)
        .accounts({
          protocolConfig,
          reserve,
          mintAuthority,
          reserveTokenMint,
          manager: manager.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([manager])
        .rpc(),
    );
    await sleep(1500);

    cp[key] = {
      reserveId: reserveId.toString(),
      reserve: reserve.toBase58(),
      reserveTokenMint: reserveTokenMint.toBase58(),
      mintAuthority: mintAuthority.toBase58(),
      vaultAuthority: vaultAuthority.toBase58(),
    };
    saveCheckpoint(cp);

    return { reserveId, reserve, reserveTokenMint, mintAuthority, vaultAuthority };
  }

  async function registerAsset(checkpointKey: string, reserve: PublicKey, vaultAuthority: PublicKey, mint: PublicKey, weightBps: number) {
    const [reserveAsset] = findReserveAsset(reserve, mint, programId);
    const [vault] = findReserveVault(reserve, mint, programId);
    if (cp[checkpointKey]) {
      return { mint, reserveAsset, vault };
    }
    await withRetry("initializeReserveAsset", () =>
      program.methods
        .initializeReserveAsset(weightBps)
        .accounts({
          protocolConfig,
          reserve,
          reserveAsset,
          assetMint: mint,
          vault,
          vaultAuthority,
          manager: manager.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([manager])
        .rpc(),
    );
    await sleep(1500);
    cp[checkpointKey] = true;
    saveCheckpoint(cp);
    return { mint, reserveAsset, vault };
  }

  type Leg = { mint: PublicKey; reserveAsset: PublicKey; vault: PublicKey };

  async function seedReserveFixture(
    checkpointKey: string,
    reserve: PublicKey,
    reserveTokenMint: PublicKey,
    mintAuthority: PublicKey,
    legs: Leg[],
    seedAmounts: number[],
    initialShares: number,
    mintExtraForLaterUse: number,
  ) {
    if (cp[checkpointKey]) {
      return;
    }
    const managerReserveTokenAccount = await withRetry("getOrCreateATA:manager-rtm", () =>
      getOrCreateAssociatedTokenAccount(connection, manager, reserveTokenMint, manager.publicKey),
    );
    await sleep(1000);
    const remainingAccounts: { pubkey: PublicKey; isWritable: boolean; isSigner: boolean }[] = [];
    for (const leg of legs) {
      const managerAta = await withRetry("getOrCreateATA:manager-leg", () =>
        getOrCreateAssociatedTokenAccount(connection, manager, leg.mint, manager.publicKey),
      );
      await sleep(1000);
      await withRetry("mintTo:manager-leg", () =>
        mintTo(connection, manager, leg.mint, managerAta.address, manager, BigInt(seedAmounts.reduce((a, b) => a + b, 0)) + BigInt(mintExtraForLaterUse)),
      );
      await sleep(1000);
      remainingAccounts.push(
        { pubkey: leg.reserveAsset, isWritable: false, isSigner: false },
        { pubkey: leg.vault, isWritable: true, isSigner: false },
        { pubkey: managerAta.address, isWritable: true, isSigner: false },
        { pubkey: leg.mint, isWritable: false, isSigner: false },
        { pubkey: TOKEN_PROGRAM_ID, isWritable: false, isSigner: false },
      );
    }

    await withRetry("seedReserve", () =>
      program.methods
        .seedReserve(seedAmounts.map((a) => new BN(a)), new BN(initialShares))
        .accounts({
          protocolConfig,
          reserve,
          reserveTokenMint,
          mintAuthority,
          managerReserveTokenAccount: managerReserveTokenAccount.address,
          manager: manager.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts(remainingAccounts)
        .signers([manager])
        .rpc(),
    );
    await sleep(1500);
    cp[checkpointKey] = true;
    saveCheckpoint(cp);
  }

  async function holderMint(
    holder: Keypair,
    reserve: PublicKey,
    reserveTokenMint: PublicKey,
    mintAuthority: PublicKey,
    legs: Leg[],
    depositAmounts: number[],
    requestedShares: number,
    checkpointKey: string,
  ) {
    if (cp[checkpointKey]) {
      return BigInt(cp[checkpointKey]);
    }
    const holderReserveTokenAccount = await withRetry("getOrCreateATA:holder-rtm", () =>
      getOrCreateAssociatedTokenAccount(connection, holder, reserveTokenMint, holder.publicKey),
    );
    await sleep(1000);
    const remainingAccounts: { pubkey: PublicKey; isWritable: boolean; isSigner: boolean }[] = [];
    for (let i = 0; i < legs.length; i++) {
      const leg = legs[i];
      const holderAta = await withRetry("getOrCreateATA:holder-leg", () =>
        getOrCreateAssociatedTokenAccount(connection, holder, leg.mint, holder.publicKey),
      );
      await sleep(1000);
      await withRetry("mintTo:holder-leg", () => mintTo(connection, manager, leg.mint, holderAta.address, manager, BigInt(depositAmounts[i]) * 10n));
      await sleep(1000);
      remainingAccounts.push(
        { pubkey: leg.reserveAsset, isWritable: false, isSigner: false },
        { pubkey: leg.vault, isWritable: true, isSigner: false },
        { pubkey: holderAta.address, isWritable: true, isSigner: false },
        { pubkey: leg.mint, isWritable: false, isSigner: false },
        { pubkey: TOKEN_PROGRAM_ID, isWritable: false, isSigner: false },
      );
    }

    await withRetry("mintReserveTokensInKind", () =>
      program.methods
        .mintReserveTokensInKind(new BN(requestedShares), new BN(1), depositAmounts.map((a) => new BN(a * 10)))
        .accounts({
          protocolConfig,
          reserve,
          reserveTokenMint,
          mintAuthority,
          depositorReserveTokenAccount: holderReserveTokenAccount.address,
          depositor: holder.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts(remainingAccounts)
        .signers([holder])
        .rpc(),
    );
    await sleep(1500);

    const account = await withRetry("getAccount:holder-rtm", () => getAccount(connection, holderReserveTokenAccount.address));
    cp[checkpointKey] = account.amount.toString();
    saveCheckpoint(cp);
    return account.amount;
  }

  console.log("Creating Reserve One (2-asset: mintX 60% / mintY 40%)...");
  const reserveOne = await createReserveFixture("reserveOne", "https://example.invalid/ssr/fixture-reserve-one.json");
  const r1LegX = await registerAsset("r1AssetX", reserveOne.reserve, reserveOne.vaultAuthority, mintX, 6000);
  const r1LegY = await registerAsset("r1AssetY", reserveOne.reserve, reserveOne.vaultAuthority, mintY, 4000);
  await seedReserveFixture("r1Seeded", reserveOne.reserve, reserveOne.reserveTokenMint, reserveOne.mintAuthority, [r1LegX, r1LegY], [600_000, 400_000], 1_000_000, 2_000_000);
  console.log("Reserve One seeded:", reserveOne.reserve.toBase58());

  console.log("Creating Reserve Two (3-asset: mintX 40% / mintY 30% / mintZ 30%)...");
  const reserveTwo = await createReserveFixture("reserveTwo", "https://example.invalid/ssr/fixture-reserve-two.json");
  const r2LegX = await registerAsset("r2AssetX", reserveTwo.reserve, reserveTwo.vaultAuthority, mintX, 4000);
  const r2LegY = await registerAsset("r2AssetY", reserveTwo.reserve, reserveTwo.vaultAuthority, mintY, 3000);
  const r2LegZ = await registerAsset("r2AssetZ", reserveTwo.reserve, reserveTwo.vaultAuthority, mintZ, 3000);
  await seedReserveFixture(
    "r2Seeded",
    reserveTwo.reserve,
    reserveTwo.reserveTokenMint,
    reserveTwo.mintAuthority,
    [r2LegX, r2LegY, r2LegZ],
    [400_000, 300_000, 300_000],
    1_000_000,
    2_000_000,
  );
  console.log("Reserve Two seeded:", reserveTwo.reserve.toBase58());

  console.log("Adding 2 restricted delegates to Reserve One with distinct scopes...");
  const [delegateTargetsAccount] = findDelegate(reserveOne.reserve, delegateTargets.publicKey, programId);
  if (!cp.delegateTargetsAdded) {
    await withRetry("addDelegate:targets", () =>
      program.methods
        .addDelegate(delegateTargets.publicKey, UPDATE_TARGETS_FLAG, true)
        .accounts({
          reserve: reserveOne.reserve,
          delegateAccount: delegateTargetsAccount,
          actingDelegate: programId,
          signer: manager.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([manager])
        .rpc(),
    );
    await sleep(1500);
    cp.delegateTargetsAdded = true;
    saveCheckpoint(cp);
  }

  const [delegatePauseAccount] = findDelegate(reserveOne.reserve, delegatePause.publicKey, programId);
  if (!cp.delegatePauseAdded) {
    await withRetry("addDelegate:pause", () =>
      program.methods
        .addDelegate(delegatePause.publicKey, PAUSE_RESERVE_FLAG | UNPAUSE_RESERVE_FLAG, true)
        .accounts({
          reserve: reserveOne.reserve,
          delegateAccount: delegatePauseAccount,
          actingDelegate: programId,
          signer: manager.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([manager])
        .rpc(),
    );
    await sleep(1500);
    cp.delegatePauseAdded = true;
    saveCheckpoint(cp);
  }

  console.log("Holder A minting into Reserve One proportionally...");
  const holderABalance = await holderMint(holderA, reserveOne.reserve, reserveOne.reserveTokenMint, reserveOne.mintAuthority, [r1LegX, r1LegY], [60_000, 40_000], 100_000, "holderABalance");
  console.log("Holder A Reserve Token balance:", holderABalance.toString());

  console.log("Holder B minting into Reserve Two proportionally...");
  const holderBBalance = await holderMint(holderB, reserveTwo.reserve, reserveTwo.reserveTokenMint, reserveTwo.mintAuthority, [r2LegX, r2LegY, r2LegZ], [40_000, 30_000, 30_000], 100_000, "holderBBalance");
  console.log("Holder B Reserve Token balance:", holderBBalance.toString());

  console.log("Demonstrating pause -> unpause on Reserve One via the restricted pause delegate...");
  if (!cp.pauseDemoDone) {
    await withRetry("pauseReserve", () =>
      program.methods
        .pauseReserve()
        .accounts({ reserve: reserveOne.reserve, delegate: delegatePauseAccount, signer: delegatePause.publicKey })
        .signers([delegatePause])
        .rpc(),
    );
    await sleep(1500);
    const reserveOneAccountPaused: any = await withRetry("fetch:reserveOne-1", () => (program.account as any).reserve.fetch(reserveOne.reserve));
    console.log("Reserve One status after pause:", JSON.stringify(reserveOneAccountPaused.status));

    await withRetry("unpauseReserve", () =>
      program.methods
        .unpauseReserve()
        .accounts({ reserve: reserveOne.reserve, delegate: delegatePauseAccount, signer: delegatePause.publicKey })
        .signers([delegatePause])
        .rpc(),
    );
    await sleep(1500);
    cp.pauseDemoDone = true;
    saveCheckpoint(cp);
  }
  const reserveOneAccount: any = await withRetry("fetch:reserveOne-2", () => (program.account as any).reserve.fetch(reserveOne.reserve));
  console.log("Reserve One status after unpause (left Active for demo use):", JSON.stringify(reserveOneAccount.status));

  const doc = `<!--
  Generated by scripts/devnet_fixtures.ts. Public keys and transaction facts
  only -- no secret keys are ever written here. Re-running the script creates
  NEW fixtures (new reserve IDs); it does not update this file automatically,
  so if re-run, refresh this file's contents manually against the new output.
-->

# DevNet Fixtures

Persistent, documented fixture state on Solana DevNet for Gate 9/Gate 10, distinct from
\`tests/ssr_protocol.ts\`'s ephemeral, discarded-after-the-run test keypairs. Program ID:
\`${programId.toBase58()}\`.

## Wallets (public keys only; keypairs live locally under \`devnet-fixtures/*.json\`, gitignored, never committed)

| Role | Public key |
|---|---|
| Root Reserve Manager | \`${manager.publicKey.toBase58()}\` |
| Restricted delegate (UPDATE_TARGETS only) | \`${delegateTargets.publicKey.toBase58()}\` |
| Restricted delegate (PAUSE_RESERVE + UNPAUSE_RESERVE only) | \`${delegatePause.publicKey.toBase58()}\` |
| Holder A | \`${holderA.publicKey.toBase58()}\` |
| Holder B | \`${holderB.publicKey.toBase58()}\` |

## Asset mints

| Mint | Decimals | Public key |
|---|---|---|
| mintX | 6 | \`${mintX.toBase58()}\` |
| mintY | 6 | \`${mintY.toBase58()}\` |
| mintZ | 9 | \`${mintZ.toBase58()}\` |

## Reserve One (2-asset)

- Reserve: \`${reserveOne.reserve.toBase58()}\` (reserve_id ${reserveOne.reserveId})
- Reserve Token mint: \`${reserveOne.reserveTokenMint.toBase58()}\`
- Assets: mintX 60% (\`${r1LegX.reserveAsset.toBase58()}\`), mintY 40% (\`${r1LegY.reserveAsset.toBase58()}\`)
- Seeded, then Holder A minted proportionally (balance after: ${holderABalance.toString()} Reserve Tokens).
- Both restricted delegates were added here; pause -> unpause was exercised via the pause-scoped delegate, demonstrating both Active and Paused states. Left in the **Active** state.

## Reserve Two (3-asset / multi-asset)

- Reserve: \`${reserveTwo.reserve.toBase58()}\` (reserve_id ${reserveTwo.reserveId})
- Reserve Token mint: \`${reserveTwo.reserveTokenMint.toBase58()}\`
- Assets: mintX 40% (\`${r2LegX.reserveAsset.toBase58()}\`), mintY 30% (\`${r2LegY.reserveAsset.toBase58()}\`), mintZ 30% (\`${r2LegZ.reserveAsset.toBase58()}\`)
- Seeded, then Holder B minted proportionally (balance after: ${holderBBalance.toString()} Reserve Tokens).

## Abandoned Reserve (real, unplanned example of the documented invariant)

An earlier interrupted run of this script (public RPC rate-limiting mid-flow) created a Reserve
at reserve_id 6 (\`9y18purN7zmHRqBaByzc22BTGx48FkH65HHevq3AxmUc\`) with 2 assets registered but
never seeded -- it is permanently stuck in \`AssetsInitializing\`, exactly matching the
"Reserve-creation partial/abandoned-state handling" behavior documented in
SECURITY_INVARIANTS.md (visible on-chain via \`status\`, not mintable/redeemable, rent
permanently locked, no reclaim instruction exists in v1). Left as-is rather than cleaned up --
it's real, useful evidence of that documented behavior, not a bug.

Generated: ${new Date().toISOString()}
`;

  fs.writeFileSync(DOC_PATH, doc);
  console.log("Wrote", DOC_PATH);
  console.log("Done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
