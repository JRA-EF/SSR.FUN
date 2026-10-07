// End-to-end check of the DEC-0229 Token-2022 Reserve Token against a
// throwaway DevNet deployment of the freshly built program (declare_id! = a
// temporary key -- see the build-gotchas recipe; the real DevNet program's
// ProtocolConfig has a stale layout and cannot be used):
//
//   RPC=https://api.devnet.solana.com PROGRAM_ID=<temp id> FUNDER_KEYPAIR=~/.config/solana/devnet-deployer.json \
//     npx ts-node -P scripts/tsconfig.json scripts/verify_token2022_reserve_token_live.ts
//
// Exercises, with real signed transactions:
//  1. create_reserve builds a Token-2022 mint: TransferFeeConfig at 15 bps,
//     no practical cap, both fee authorities = the program's PDA, 6 decimals,
//     mint authority = the Reserve's PDA, no freeze authority.
//  2. initialize_reserve_asset + seed_reserve + mint_reserve_tokens_in_kind:
//     minting withholds NO transfer fee.
//  3. A wallet-to-wallet transfer withholds exactly 0.15% in the recipient.
//  4. collect_transfer_fees harvests it and pays the treasury's ATA; a wrong
//     treasury is refused.
//  5. update_transfer_fee: a stranger is refused, 26 bps is refused, 25 bps
//     is accepted and scheduled two epochs out.
//  6. create_token_metadata (Metaplex) works on the Token-2022 mint.
//  7. accrue_fees works against the Token-2022 fee vault.
//  8. redeem_reserve_tokens_in_kind burns with no transfer fee.
//  9. Co-manager containment (9111fd0): a restricted co-manager holding only
//     ADD_RESTRICTED_DELEGATE cannot raise its own permissions, nor grant
//     another wallet more than it holds; the manager still can.
import * as fs from "fs";
import * as os from "os";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction, LAMPORTS_PER_SOL } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  createMint,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
  getOrCreateAssociatedTokenAccount,
  getTransferFeeAmount,
  getTransferFeeConfig,
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
  buildSeedReserveInstruction,
  buildDirectMultiAssetMintInstructions,
  buildDirectMultiAssetRedeemInstructions,
  buildCollectTransferFeesInstruction,
  buildUpdateTransferFeeInstruction,
  buildCreateTokenMetadataInstruction,
  fetchReserveTokenMetadata,
  fetchReserveTokenTransferFee,
  findWithheldFeeAccounts,
  findDelegate,
  findFeeSettlement,
  findFeeVaultAta,
  findFeeVaultAuthority,
  findMintAuthority,
  findProtocolConfig,
  findTransferFeeAuthority,
  findTvlAccrual,
  describeOnChainError,
  buildAddDelegateInstruction,
  buildUpdateDelegatePermissionsInstruction,
} from "../packages/sdk/src";

const PROGRAM_ID = new PublicKey(process.env.PROGRAM_ID ?? "8hTW7fHwn8t8hcgTVeyAhHMiCTHGUP3783NWUTBBFwH9");
const RPC = process.env.RPC ?? "http://127.0.0.1:8899";
const U64_MAX = BigInt("18446744073709551615");

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error("ASSERTION FAILED: " + msg);
}
const loadKeypair = (p: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p.replace(/^~/, os.homedir()), "utf8"))));

async function fund(connection: Connection, funder: Keypair, to: PublicKey, sol: number) {
  await sendAndConfirmTransaction(connection, new Transaction().add(SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: to, lamports: Math.round(sol * LAMPORTS_PER_SOL) })), [funder], { commitment: "confirmed" });
}
const send = (connection: Connection, ixs: Parameters<Transaction["add"]>[0][], signers: Keypair[]) =>
  sendAndConfirmTransaction(connection, new Transaction().add(...ixs), signers, { commitment: "confirmed" });

async function expectFailure(label: string, p: Promise<unknown>, needle: RegExp) {
  try {
    await p;
  } catch (e) {
    const logs = (e as { logs?: string[] }).logs?.join(" ") ?? "";
    const msg = `${describeOnChainError(e)} ${e instanceof Error ? e.message : String(e)} ${logs}`;
    assert(needle.test(msg), `${label}: failed for the wrong reason: ${msg.slice(0, 600)}`);
    console.log(`  ok  ${label} rejected (${msg.match(needle)?.[0]})`);
    return;
  }
  throw new Error(`${label}: expected failure, but it succeeded`);
}

async function main() {
  const connection = new Connection(RPC, "confirmed");
  const funder = loadKeypair(process.env.FUNDER_KEYPAIR ?? "~/.config/solana/devnet-deployer.json");
  const authority = Keypair.generate();
  const admin2 = Keypair.generate();
  const manager = Keypair.generate();
  const holder = Keypair.generate();
  const stranger = Keypair.generate();
  const treasury = Keypair.generate();
  for (const [kp, sol] of [[authority, 0.05], [admin2, 0.01], [manager, 0.12], [holder, 0.06], [stranger, 0.03]] as const) await fund(connection, funder, kp.publicKey, sol);
  const wallet = { publicKey: manager.publicKey, signTransaction: async (t: any) => t, signAllTransactions: async (t: any) => t };
  const program = new Program({ ...(idlJson as Idl), address: PROGRAM_ID.toBase58() } as Idl, new AnchorProvider(connection, wallet as any, { commitment: "confirmed" })) as any;
  console.log(`program=${PROGRAM_ID.toBase58()} rpc=${RPC.replace(/api-key=[^&]+/, "api-key=***")}`);

  // 0. initialize_protocol on the fresh program; the treasury is a fresh wallet.
  const [protocolConfig] = findProtocolConfig(PROGRAM_ID);
  await send(connection, [await program.methods.initializeProtocol(admin2.publicKey, 12, 0, treasury.publicKey).accounts({ protocolConfig, authority: authority.publicKey, systemProgram: SystemProgram.programId }).instruction()], [authority]);
  console.log("  ok  initialize_protocol");

  // 1. create_reserve -> Token-2022 mint with the transfer fee.
  const addresses = await deriveNewReserveAddresses(program, PROGRAM_ID);
  const createIx = await buildCreateReserveInstruction(program, addresses, manager.publicKey, { metadataUri: "https://ssr.fun/api/mainnet/reserve-metadata?id=0123456789abcdef", mintFeeBps: 100, redemptionFeeBps: 0, tvlFeeBps: 100, feeDestination: manager.publicKey });
  const createSig = await send(connection, [createIx], [manager]);
  const rtMint = addresses.reserveTokenMint;
  const mintInfo = await connection.getAccountInfo(rtMint);
  assert(mintInfo && mintInfo.owner.equals(TOKEN_2022_PROGRAM_ID), "Reserve Token mint is owned by Token-2022");
  const mint = await getMint(connection, rtMint, "confirmed", TOKEN_2022_PROGRAM_ID);
  const feeCfg = getTransferFeeConfig(mint);
  const [feeAuthority] = findTransferFeeAuthority(PROGRAM_ID);
  assert(feeCfg, "TransferFeeConfig extension present");
  assert(feeCfg.newerTransferFee.transferFeeBasisPoints === 15 && feeCfg.olderTransferFee.transferFeeBasisPoints === 15, `15 bps: ${feeCfg.newerTransferFee.transferFeeBasisPoints}`);
  assert(feeCfg.newerTransferFee.maximumFee === U64_MAX, "no practical per-transfer cap");
  assert(feeCfg.transferFeeConfigAuthority?.equals(feeAuthority) && feeCfg.withdrawWithheldAuthority?.equals(feeAuthority), "both fee authorities are the program PDA");
  assert(mint.decimals === 6 && mint.mintAuthority?.equals(addresses.mintAuthority) && mint.freezeAuthority === null, "decimals/mint authority/no freeze");
  console.log(`  ok  create_reserve ${createSig}: Token-2022 mint ${rtMint.toBase58()}, 15 bps, PDA fee authorities`);

  // 2. One classic asset; register, seed, mint.
  const assetMint = await createMint(connection, funder, manager.publicKey, null, 6, undefined, { commitment: "confirmed" }, TOKEN_PROGRAM_ID);
  const mgrAsset = await getOrCreateAssociatedTokenAccount(connection, funder, assetMint, manager.publicKey);
  const holderAsset = await getOrCreateAssociatedTokenAccount(connection, funder, assetMint, holder.publicKey);
  await mintTo(connection, funder, assetMint, mgrAsset.address, manager, 10_000_000n);
  await mintTo(connection, funder, assetMint, holderAsset.address, manager, 10_000_000n);
  const asset = deriveReserveAssetAddresses(addresses.reserve, assetMint, PROGRAM_ID, TOKEN_PROGRAM_ID);
  await send(connection, [await buildInitializeReserveAssetInstruction(program, addresses, asset, manager.publicKey, 10_000)], [manager]);
  await send(connection, [await buildSeedReserveInstruction(program, addresses, [asset], manager.publicKey, [2_000_000n], 2_000_000n)], [manager]);
  const mgrRtAta = getAssociatedTokenAddressSync(rtMint, manager.publicKey, false, TOKEN_2022_PROGRAM_ID);
  const mgrRt = await getAccount(connection, mgrRtAta, "confirmed", TOKEN_2022_PROGRAM_ID);
  assert(mgrRt.amount > 0n, "manager holds Reserve Tokens in the Token-2022 ATA after seeding");
  assert((getTransferFeeAmount(mgrRt)?.withheldAmount ?? 0n) === 0n, "seeding withheld no transfer fee");
  console.log(`  ok  seed_reserve: manager holds ${mgrRt.amount} raw, nothing withheld`);

  const leg = { mint: assetMint.toBase58(), decimals: 6, reserveAsset: asset.reserveAsset.toBase58(), vault: asset.vault.toBase58(), vaultBalanceRaw: (await getAccount(connection, asset.vault)).amount.toString(), tokenProgram: TOKEN_PROGRAM_ID.toBase58() };
  const supply = (await getMint(connection, rtMint, "confirmed", TOKEN_2022_PROGRAM_ID)).supply;
  const mintRes = await buildDirectMultiAssetMintInstructions({
    program, protocolConfig, protocolFeeDestination: treasury.publicKey, reserve: addresses.reserve, reserveTokenMint: rtMint,
    mintAuthority: addresses.mintAuthority, user: holder.publicKey, assets: [leg], reserveTokenSupplyRaw: supply.toString(), reserveTokensRequested: 500_000n,
  } as any);
  await send(connection, mintRes.instructions, [holder]);
  const holderRtAta = getAssociatedTokenAddressSync(rtMint, holder.publicKey, false, TOKEN_2022_PROGRAM_ID);
  const holderRt = await getAccount(connection, holderRtAta, "confirmed", TOKEN_2022_PROGRAM_ID);
  assert(holderRt.amount > 0n && (getTransferFeeAmount(holderRt)?.withheldAmount ?? 0n) === 0n, "mint paid out with no transfer fee withheld");
  console.log(`  ok  mint_reserve_tokens_in_kind: holder got ${holderRt.amount} raw, nothing withheld (resolver found Token-2022 on its own)`);

  // 3. A plain wallet-to-wallet transfer pays 0.15%.
  const sendAmount = 100_000n;
  await send(connection, [
    createAssociatedTokenAccountIdempotentInstruction(manager.publicKey, holderRtAta, holder.publicKey, rtMint, TOKEN_2022_PROGRAM_ID),
    createTransferCheckedInstruction(mgrRtAta, rtMint, holderRtAta, manager.publicKey, sendAmount, 6, [], TOKEN_2022_PROGRAM_ID),
  ], [manager]);
  const expectedFee = (sendAmount * 15n + 9_999n) / 10_000n; // Token-2022 rounds the fee up
  const afterSend = await getAccount(connection, holderRtAta, "confirmed", TOKEN_2022_PROGRAM_ID);
  const withheld = getTransferFeeAmount(afterSend)?.withheldAmount ?? 0n;
  assert(withheld === expectedFee, `withheld ${withheld}, expected ${expectedFee}`);
  console.log(`  ok  transfer of ${sendAmount} raw withheld ${withheld} raw (0.15%) in the recipient`);

  // 4. Keeper collection to the treasury; a wrong treasury is refused.
  const found = await findWithheldFeeAccounts(connection, rtMint).catch(() => null);
  if (found) {
    assert(found.some((f) => f.address.equals(holderRtAta) && f.withheldRaw === expectedFee), "scan finds the account holding withheld fees");
    console.log(`  ok  findWithheldFeeAccounts found ${found.length} account(s) holding withheld fees`);
  } else console.log("  --  findWithheldFeeAccounts skipped (this RPC refuses getProgramAccounts)");
  await expectFailure(
    "collect to a non-treasury wallet",
    (async () => send(connection, [await buildCollectTransferFeesInstruction({ program, programId: PROGRAM_ID, reserve: addresses.reserve, treasury: stranger.publicKey, payer: holder.publicKey, harvestSources: [holderRtAta] })], [holder]))(),
    /TransferFeeTreasuryMismatch|6065/,
  );
  const collectSig = await send(connection, [await buildCollectTransferFeesInstruction({ program, programId: PROGRAM_ID, reserve: addresses.reserve, treasury: treasury.publicKey, payer: holder.publicKey, harvestSources: [holderRtAta] })], [holder]);
  const treasuryAta = getAssociatedTokenAddressSync(rtMint, treasury.publicKey, true, TOKEN_2022_PROGRAM_ID);
  const treasuryBal = (await getAccount(connection, treasuryAta, "confirmed", TOKEN_2022_PROGRAM_ID)).amount;
  assert(treasuryBal === expectedFee, `treasury received ${treasuryBal}, expected ${expectedFee}`);
  assert((getTransferFeeAmount(await getAccount(connection, holderRtAta, "confirmed", TOKEN_2022_PROGRAM_ID))?.withheldAmount ?? 0n) === 0n, "harvested account is empty");
  assert((await fetchReserveTokenTransferFee(connection, rtMint))!.withheldOnMintRaw === 0n, "nothing left withheld on the mint");
  console.log(`  ok  collect_transfer_fees ${collectSig}: treasury ATA holds ${treasuryBal} raw`);

  // 5. Rate changes.
  await expectFailure(
    "update_transfer_fee by a stranger",
    (async () => send(connection, [await buildUpdateTransferFeeInstruction({ program, programId: PROGRAM_ID, reserve: addresses.reserve, authority: stranger.publicKey, newTransferFeeBps: 20 })], [stranger]))(),
    /NotProtocolAuthority|6\d{3}/,
  );
  await expectFailure(
    "update_transfer_fee to 26 bps",
    (async () => send(connection, [await program.methods.updateTransferFee(26).accounts({ protocolConfig, reserve: addresses.reserve, reserveTokenMint: rtMint, transferFeeAuthority: feeAuthority, authority: authority.publicKey, tokenProgram: TOKEN_2022_PROGRAM_ID }).instruction()], [authority]))(),
    /TransferFeeExceedsMaximum|6063/,
  );
  const epoch = BigInt((await connection.getEpochInfo()).epoch);
  // Signed by the SECOND admin: either Protocol Admin may change the rate.
  const updSig = await send(connection, [await buildUpdateTransferFeeInstruction({ program, programId: PROGRAM_ID, reserve: addresses.reserve, authority: admin2.publicKey, newTransferFeeBps: 25 })], [admin2]);
  const after = await fetchReserveTokenTransferFee(connection, rtMint);
  assert(after && after.newerBps === 25 && after.currentBps === 15, `pending 25, current 15: ${JSON.stringify(after, (_, v) => (typeof v === "bigint" ? v.toString() : v))}`);
  assert(after.newerEpoch === epoch + 2n || after.newerEpoch === epoch + 3n, `effective two epochs out: ${after.newerEpoch} vs ${epoch}`);
  console.log(`  ok  update_transfer_fee ${updSig}: 25 bps from epoch ${after.newerEpoch} (now ${epoch}), 15 bps until then`);

  // 6. Metaplex metadata on the Token-2022 mint.
  const [managerDelegate] = findDelegate(addresses.reserve, manager.publicKey, PROGRAM_ID);
  const metaSig = await send(connection, [await buildCreateTokenMetadataInstruction(program, PROGRAM_ID, addresses.reserve, manager.publicKey, managerDelegate, "Token2022 Test Reserve", "T22SSR", "https://ssr.fun/api/mainnet/token-metadata?id=0123456789abcdef")], [manager]);
  const meta = await fetchReserveTokenMetadata(connection, rtMint);
  assert(meta && meta.name === "Token2022 Test Reserve" && meta.symbol === "T22SSR", `metadata read back: ${meta?.name}`);
  console.log(`  ok  create_token_metadata ${metaSig} on the Token-2022 mint`);

  // 7. accrue_fees against the Token-2022 fee vault (permissionless).
  const accrueIx = await program.methods.accrueFees().accounts({
    protocolConfig, reserve: addresses.reserve, reserveTokenMint: rtMint, mintAuthority: findMintAuthority(addresses.reserve, PROGRAM_ID)[0],
    tvlAccrual: findTvlAccrual(addresses.reserve, PROGRAM_ID)[0], feeSettlement: findFeeSettlement(addresses.reserve, PROGRAM_ID)[0],
    feeVault: findFeeVaultAta(addresses.reserve, rtMint, PROGRAM_ID, TOKEN_2022_PROGRAM_ID), feeVaultAuthority: findFeeVaultAuthority(addresses.reserve, PROGRAM_ID)[0],
    payer: holder.publicKey, tokenProgram: TOKEN_2022_PROGRAM_ID, associatedTokenProgram: new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"), systemProgram: SystemProgram.programId,
  }).instruction();
  for (const k of accrueIx.keys) if (k.pubkey.equals(rtMint)) k.isWritable = true; // DEC-0192 deployed-binary note
  console.log(`  ok  accrue_fees ${await send(connection, [accrueIx], [holder])} against the Token-2022 fee vault`);

  // 8. Redeem: burn, no transfer fee.
  const holderNow = await getAccount(connection, holderRtAta, "confirmed", TOKEN_2022_PROGRAM_ID);
  const supplyNow = (await getMint(connection, rtMint, "confirmed", TOKEN_2022_PROGRAM_ID)).supply;
  const vaultNow = (await getAccount(connection, asset.vault)).amount;
  const redeemRes = await buildDirectMultiAssetRedeemInstructions({
    program, reserve: addresses.reserve, reserveTokenMint: rtMint, vaultAuthority: addresses.vaultAuthority, user: holder.publicKey,
    assets: [{ ...leg, vaultBalanceRaw: vaultNow.toString() }], reserveTokenSupplyRaw: supplyNow.toString(), redemptionFeeBps: 0n, reserveTokensToRedeem: holderNow.amount,
  });
  const assetBefore = (await getAccount(connection, holderAsset.address)).amount;
  const redeemSig = await send(connection, redeemRes.instructions, [holder]);
  const holderAfter = await getAccount(connection, holderRtAta, "confirmed", TOKEN_2022_PROGRAM_ID);
  const assetAfter = (await getAccount(connection, holderAsset.address)).amount;
  assert(holderAfter.amount === 0n && (getTransferFeeAmount(holderAfter)?.withheldAmount ?? 0n) === 0n, "redeemed everything, nothing withheld");
  assert(assetAfter - assetBefore === redeemRes.entitlementsRaw[0], `asset paid out ${assetAfter - assetBefore}, expected ${redeemRes.entitlementsRaw[0]}`);
  console.log(`  ok  redeem_reserve_tokens_in_kind ${redeemSig}: burned ${holderNow.amount} raw, paid ${assetAfter - assetBefore} raw of the asset`);

  // 9. Co-manager containment.
  const ADD_RESTRICTED = 1 << 8;
  const MANAGE_FEES = 1 << 4;
  const [managerSelf] = findDelegate(addresses.reserve, manager.publicKey, PROGRAM_ID); // never exists: root-manager path
  await send(connection, [await buildAddDelegateInstruction(program, PROGRAM_ID, addresses.reserve, manager.publicKey, managerSelf, stranger.publicKey, ADD_RESTRICTED, true)], [manager]);
  const [strangerRecord] = findDelegate(addresses.reserve, stranger.publicKey, PROGRAM_ID);
  await expectFailure(
    "co-manager raising its own permissions",
    (async () => send(connection, [await buildUpdateDelegatePermissionsInstruction(program, PROGRAM_ID, addresses.reserve, stranger.publicKey, strangerRecord, stranger.publicKey, ADD_RESTRICTED | MANAGE_FEES)], [stranger]))(),
    /DelegateSelfModification|6067/,
  );
  const third = Keypair.generate().publicKey;
  await expectFailure(
    "co-manager granting more than it holds",
    (async () => send(connection, [await buildAddDelegateInstruction(program, PROGRAM_ID, addresses.reserve, stranger.publicKey, strangerRecord, third, MANAGE_FEES, true)], [stranger]))(),
    /DelegatePermissionEscalation|6066/,
  );
  await send(connection, [await buildUpdateDelegatePermissionsInstruction(program, PROGRAM_ID, addresses.reserve, manager.publicKey, managerSelf, stranger.publicKey, ADD_RESTRICTED | MANAGE_FEES)], [manager]);
  console.log("  ok  the root manager can still raise a co-manager's permissions");

  console.log("ALL CHECKS PASSED");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
