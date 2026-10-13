// End-to-end check of DEC-0238 (mint fee paid in USDC at mint/seed time)
// against a throwaway DevNet deployment of the freshly built program
// (declare_id! = a temporary key -- see the build-gotchas recipe):
//
//   RPC=<devnet rpc> PROGRAM_ID=<temp id> FUNDER_KEYPAIR=~/.config/solana/devnet-deployer.json \
//     npx ts-node -P scripts/tsconfig.json scripts/verify_usdc_mint_fee_live.ts
//
// With real signed transactions:
//  1. seed_reserve_usdc_fee: the creator receives the FULL initial Reserve
//     Tokens, and exactly 1% of the seed value in USDC lands in the Treasury
//     (protocol half) and the legacy fee destination (manager half), in the
//     same transaction. No fee vault is created.
//  2. mint_reserve_tokens_in_kind_usdc_fee refuses: a co-signer that is not
//     the configured keeper, a zero fee on a fee-charging Reserve, and a
//     Treasury other than the configured one.
//  3. A valid mint pays the Treasury and the legacy destination, and the
//     minter receives the full requested amount.
//  4. With ManagerFeeRecipients (60/40), the manager half is apportioned
//     across both recipients' USDC accounts.
//  5. The keeper co-signs but pays nothing (not fee payer, SOL unchanged).
//  6. The original share-fee mint_reserve_tokens_in_kind still works.
import * as fs from "fs";
import * as os from "os";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction, LAMPORTS_PER_SOL } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  createMint,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import { AnchorProvider, Program } from "@anchor-lang/core";
import type { Idl } from "@anchor-lang/core";
import idlJson from "../packages/sdk/idl/ssr_protocol.json";
import {
  deriveNewReserveAddresses,
  deriveReserveAssetAddresses,
  buildCreateReserveInstruction,
  buildInitializeReserveAssetInstruction,
  buildInitializeManagerFeeRecipientsInstruction,
  buildSetFeeSettlementKeeperInstruction,
  buildDirectMultiAssetMintInstructions,
  buildMintWithUsdcFeeInstructions,
  buildSeedReserveUsdcFeeInstruction,
  buildUsdcFeeDestinationAtaInstructions,
  computeUsdcMintFeeRaw,
  findDelegate,
  findFeeSettlement,
  findProtocolConfig,
  describeOnChainError,
} from "../packages/sdk/src";

const PROGRAM_ID = new PublicKey(process.env.PROGRAM_ID ?? "8hTW7fHwn8t8hcgTVeyAhHMiCTHGUP3783NWUTBBFwH9");
const RPC = process.env.RPC ?? "http://127.0.0.1:8899";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error("ASSERTION FAILED: " + msg);
}
const loadKeypair = (p: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p.replace(/^~/, os.homedir()), "utf8"))));

async function fund(connection: Connection, funder: Keypair, to: PublicKey, sol: number) {
  await sendAndConfirmTransaction(connection, new Transaction().add(SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: to, lamports: Math.round(sol * LAMPORTS_PER_SOL) })), [funder], { commitment: "confirmed" });
}
// The first signer is the fee payer.
const send = (connection: Connection, ixs: Parameters<Transaction["add"]>[0][], signers: Keypair[]) =>
  sendAndConfirmTransaction(connection, new Transaction().add(...ixs), signers, { commitment: "confirmed" });

async function expectFailure(label: string, p: Promise<unknown>, needle: RegExp) {
  try {
    await p;
  } catch (e) {
    const logs = (e as { logs?: string[] }).logs?.join(" ") ?? "";
    const msg = `${describeOnChainError(e)} ${e instanceof Error ? e.message : String(e)} ${logs}`;
    assert(needle.test(msg), `${label}: failed for the wrong reason: ${msg.slice(0, 800)}`);
    console.log(`  ok  ${label} rejected (${msg.match(needle)?.[0]})`);
    return;
  }
  throw new Error(`${label}: expected failure, but it succeeded`);
}

const usdcBal = async (connection: Connection, mint: PublicKey, owner: PublicKey) => {
  try {
    return (await getAccount(connection, getAssociatedTokenAddressSync(mint, owner, true), "confirmed")).amount;
  } catch {
    return 0n;
  }
};

async function main() {
  const connection = new Connection(RPC, "confirmed");
  const funder = loadKeypair(process.env.FUNDER_KEYPAIR ?? "~/.config/solana/devnet-deployer.json");
  const authority = Keypair.generate();
  const admin2 = Keypair.generate();
  const manager = Keypair.generate();
  const holder = Keypair.generate();
  const stranger = Keypair.generate();
  const keeper = Keypair.generate();
  const treasury = Keypair.generate();
  const recipientA = Keypair.generate().publicKey;
  const recipientB = Keypair.generate().publicKey;
  for (const [kp, sol] of [[authority, 0.05], [admin2, 0.005], [manager, 0.15], [holder, 0.08], [stranger, 0.01], [keeper, 0.002]] as const) await fund(connection, funder, kp.publicKey, sol);
  const wallet = { publicKey: manager.publicKey, signTransaction: async (t: any) => t, signAllTransactions: async (t: any) => t };
  const program = new Program({ ...(idlJson as Idl), address: PROGRAM_ID.toBase58() } as Idl, new AnchorProvider(connection, wallet as any, { commitment: "confirmed" })) as any;
  console.log(`program=${PROGRAM_ID.toBase58()} rpc=${RPC.replace(/api-key=[^&]+/, "api-key=***")}`);

  const [protocolConfig] = findProtocolConfig(PROGRAM_ID);
  await send(connection, [await program.methods.initializeProtocol(admin2.publicKey, 12, 0, treasury.publicKey).accounts({ protocolConfig, authority: authority.publicKey, systemProgram: SystemProgram.programId }).instruction()], [authority]);
  await send(connection, [await buildSetFeeSettlementKeeperInstruction(program, PROGRAM_ID, authority.publicKey, keeper.publicKey)], [authority]);
  console.log("  ok  initialize_protocol + set_fee_settlement_keeper");

  // A stand-in USDC (classic SPL, 6 decimals) and one reserve asset.
  const usdc = await createMint(connection, funder, funder.publicKey, null, 6, undefined, { commitment: "confirmed" }, TOKEN_PROGRAM_ID);
  const assetMint = await createMint(connection, funder, funder.publicKey, null, 6, undefined, { commitment: "confirmed" }, TOKEN_PROGRAM_ID);
  for (const owner of [manager.publicKey, holder.publicKey, stranger.publicKey]) {
    await mintTo(connection, funder, usdc, (await getOrCreateAssociatedTokenAccount(connection, funder, usdc, owner)).address, funder, 10_000_000n);
    await mintTo(connection, funder, assetMint, (await getOrCreateAssociatedTokenAccount(connection, funder, assetMint, owner)).address, funder, 10_000_000n);
  }

  // 1. create (1% mint fee, legacy fee destination = manager) + seed with the USDC fee.
  const addresses = await deriveNewReserveAddresses(program, PROGRAM_ID);
  await send(connection, [await buildCreateReserveInstruction(program, addresses, manager.publicKey, { metadataUri: "https://ssr.fun/api/mainnet/reserve-metadata?id=0123456789abcdef", mintFeeBps: 100, redemptionFeeBps: 0, tvlFeeBps: 100, feeDestination: manager.publicKey })], [manager]);
  const rtMint = addresses.reserveTokenMint;
  const asset = deriveReserveAssetAddresses(addresses.reserve, assetMint, PROGRAM_ID, TOKEN_PROGRAM_ID);
  await send(connection, [await buildInitializeReserveAssetInstruction(program, addresses, asset, manager.publicKey, 10_000)], [manager]);

  const legacyRouting = { protocolFeeDestination: treasury.publicKey, managerRecipients: [], legacyManagerDestination: manager.publicKey };
  // Seed 2.0 asset units priced at $1 => $2.00 seed value => 1% = 20_000 raw USDC.
  const seedFee = computeUsdcMintFeeRaw(2_000_000n, 100);
  assert(seedFee === 20_000n, `seed fee ${seedFee}`);
  const treasury0 = await usdcBal(connection, usdc, treasury.publicKey);
  const manager0 = await usdcBal(connection, usdc, manager.publicKey);
  const keeperSol0 = await connection.getBalance(keeper.publicKey);
  const seedIx = await buildSeedReserveUsdcFeeInstruction({
    program, addresses, assets: [asset], manager: manager.publicKey, seedAmounts: [2_000_000n], initialReserveTokens: 2_000_000n,
    usdcFeeRaw: seedFee, usdcMint: usdc, feeQuoteSigner: keeper.publicKey, routing: legacyRouting,
  });
  const seedSig = await send(connection, [...buildUsdcFeeDestinationAtaInstructions(manager.publicKey, usdc, legacyRouting), seedIx], [manager, keeper]);
  const mgrRt = (await getAccount(connection, getAssociatedTokenAddressSync(rtMint, manager.publicKey, false, TOKEN_2022_PROGRAM_ID), "confirmed", TOKEN_2022_PROGRAM_ID)).amount;
  assert(mgrRt === 2_000_000n, `creator holds the full seed, got ${mgrRt}`);
  const treasury1 = await usdcBal(connection, usdc, treasury.publicKey);
  const manager1 = await usdcBal(connection, usdc, manager.publicKey);
  assert(treasury1 - treasury0 === 10_000n, `treasury got ${treasury1 - treasury0}`);
  assert(manager0 - manager1 === 10_000n, `manager net paid ${manager0 - manager1} (20_000 out, 10_000 back as the manager half)`);
  assert((await connection.getAccountInfo(findFeeSettlement(addresses.reserve, PROGRAM_ID)[0])) === null, "no fee vault/settlement created on the USDC path");
  console.log(`  ok  seed_reserve_usdc_fee ${seedSig}: creator holds all 2.000000 RT, treasury +0.010000 USDC, manager half 0.010000 USDC`);

  const leg = async () => ({ mint: assetMint.toBase58(), decimals: 6, reserveAsset: asset.reserveAsset.toBase58(), vault: asset.vault.toBase58(), vaultBalanceRaw: (await getAccount(connection, asset.vault)).amount.toString(), tokenProgram: TOKEN_PROGRAM_ID.toBase58() });
  const supply = async () => (await getMint(connection, rtMint, "confirmed", TOKEN_2022_PROGRAM_ID)).supply.toString();
  const buildMint = async (o: { feeQuoteSigner?: PublicKey; usdcFeeRaw?: bigint; routing?: typeof legacyRouting | any; requested?: bigint }) =>
    buildMintWithUsdcFeeInstructions({
      program, protocolConfig, reserve: addresses.reserve, reserveTokenMint: rtMint, mintAuthority: addresses.mintAuthority, reserveTokenProgram: TOKEN_2022_PROGRAM_ID,
      user: holder.publicKey, assets: [await leg()], reserveTokenSupplyRaw: await supply(), reserveTokensRequested: o.requested ?? 500_000n,
      usdcFeeRaw: o.usdcFeeRaw ?? 5_000n, usdcMint: usdc, feeQuoteSigner: o.feeQuoteSigner ?? keeper.publicKey, routing: o.routing ?? legacyRouting,
    });

  // 2. Refusals.
  await expectFailure("co-signed by a wallet that is not the keeper", (async () => send(connection, (await buildMint({ feeQuoteSigner: stranger.publicKey })).instructions, [holder, stranger]))(), /NotFeeQuoteSigner|6068/);
  await expectFailure("zero USDC fee on a 1% Reserve", (async () => send(connection, (await buildMint({ usdcFeeRaw: 0n })).instructions, [holder, keeper]))(), /UsdcMintFeeRequired|6069/);
  await expectFailure("paying a Treasury other than the configured one", (async () => send(connection, (await buildMint({ routing: { ...legacyRouting, protocolFeeDestination: stranger.publicKey } })).instructions, [holder, keeper]))(), /InvalidFeeShareSplit|ConstraintAddress|6\d{3}|2012/);

  // 3. Valid mint, legacy destination.
  const holderRtAta = getAssociatedTokenAddressSync(rtMint, holder.publicKey, false, TOKEN_2022_PROGRAM_ID);
  const t0 = await usdcBal(connection, usdc, treasury.publicKey);
  const m0 = await usdcBal(connection, usdc, manager.publicKey);
  const h0 = await usdcBal(connection, usdc, holder.publicKey);
  const mintSig = await send(connection, (await buildMint({ usdcFeeRaw: 5_000n })).instructions, [holder, keeper]);
  const holderRt = (await getAccount(connection, holderRtAta, "confirmed", TOKEN_2022_PROGRAM_ID)).amount;
  assert(holderRt === 500_000n, `holder got the full 500_000, got ${holderRt}`);
  assert((await usdcBal(connection, usdc, treasury.publicKey)) - t0 === 2_500n, "treasury +2_500");
  assert((await usdcBal(connection, usdc, manager.publicKey)) - m0 === 2_500n, "manager +2_500");
  assert(h0 - (await usdcBal(connection, usdc, holder.publicKey)) === 5_000n, "holder paid 5_000");
  console.log(`  ok  mint_reserve_tokens_in_kind_usdc_fee ${mintSig}: holder got all 0.500000 RT, treasury +0.002500, manager +0.002500 USDC`);

  // 4. Multi-recipient routing (60/40).
  const [managerDelegate] = findDelegate(addresses.reserve, manager.publicKey, PROGRAM_ID);
  await send(connection, [await buildInitializeManagerFeeRecipientsInstruction(program, PROGRAM_ID, addresses.reserve, manager.publicKey, managerDelegate, manager.publicKey, [{ wallet: recipientA.toBase58(), allocationBps: 6_000 }, { wallet: recipientB.toBase58(), allocationBps: 4_000 }] as any)], [manager]);
  const multiRouting = { protocolFeeDestination: treasury.publicKey, managerRecipients: [{ wallet: recipientA }, { wallet: recipientB }] };
  await expectFailure("legacy destination once recipients exist", (async () => send(connection, (await buildMint({ usdcFeeRaw: 10_000n })).instructions, [holder, keeper]))(), /RemainingAccountsMismatch|ConstraintSeeds|AccountNotInitialized|6\d{3}|20\d\d|3012/);
  const t1 = await usdcBal(connection, usdc, treasury.publicKey);
  const multiIxs = (await buildMint({ usdcFeeRaw: 10_000n, routing: multiRouting })).instructions;
  const multiSig = await send(connection, [...buildUsdcFeeDestinationAtaInstructions(holder.publicKey, usdc, multiRouting), ...multiIxs], [holder, keeper]);
  assert((await usdcBal(connection, usdc, treasury.publicKey)) - t1 === 5_000n, "treasury +5_000");
  assert((await usdcBal(connection, usdc, recipientA)) === 3_000n, `recipient A +3_000, got ${await usdcBal(connection, usdc, recipientA)}`);
  assert((await usdcBal(connection, usdc, recipientB)) === 2_000n, `recipient B +2_000, got ${await usdcBal(connection, usdc, recipientB)}`);
  console.log(`  ok  multi-recipient USDC fee ${multiSig}: treasury +0.005000, recipients +0.003000 / +0.002000`);

  // 5. The keeper only signed.
  assert((await connection.getBalance(keeper.publicKey)) === keeperSol0, "keeper SOL unchanged: it never paid a fee or rent");
  console.log("  ok  the fee quote signer paid nothing");

  // 6. The original share-fee instruction is untouched.
  const legacyMint = await buildDirectMultiAssetMintInstructions({
    program, protocolConfig, protocolFeeDestination: treasury.publicKey, reserve: addresses.reserve, reserveTokenMint: rtMint, reserveTokenProgram: TOKEN_2022_PROGRAM_ID,
    mintAuthority: addresses.mintAuthority, user: stranger.publicKey, assets: [await leg()], reserveTokenSupplyRaw: await supply(), reserveTokensRequested: 100_000n,
  } as any);
  const legacySig = await send(connection, legacyMint.instructions, [stranger]);
  const strangerRt = (await getAccount(connection, getAssociatedTokenAddressSync(rtMint, stranger.publicKey, false, TOKEN_2022_PROGRAM_ID), "confirmed", TOKEN_2022_PROGRAM_ID)).amount;
  assert(strangerRt === 99_000n, `share-fee mint nets 99%, got ${strangerRt}`);
  console.log(`  ok  mint_reserve_tokens_in_kind (share fee) still works ${legacySig}: 0.099000 RT net`);

  console.log("ALL CHECKS PASSED");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
