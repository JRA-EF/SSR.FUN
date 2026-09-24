// Proves the fee gross-up: a Reserve funded with a FEE-BEARING Token-2022 mint
// must end up holding the amount the Manager asked for, not amount-minus-fee.
// Without gross_up_for_transfer_fee the shortfall is silently paid by existing
// holders on every deposit.
//
// Needs the validator from verify_mint_extensions_local.ts's header.
//   npx tsx scripts/verify_transfer_fee_local.ts
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction, LAMPORTS_PER_SOL } from "@solana/web3.js";
import {
  ExtensionType, TOKEN_2022_PROGRAM_ID, createInitializeMintInstruction,
  createInitializeTransferFeeConfigInstruction, getAccount, getMintLen, mintTo,
  getOrCreateAssociatedTokenAccount,
} from "@solana/spl-token";
import { AnchorProvider, Program } from "@anchor-lang/core";
import type { Idl } from "@anchor-lang/core";
import idlJson from "../packages/sdk/idl/ssr_protocol.json";
import {
  buildCreateReserveInstruction, buildInitializeReserveAssetInstruction,
  deriveNewReserveAddresses, deriveReserveAssetAddresses,
} from "../packages/sdk/src/createReserveFlow";
import { buildSeedReserveInstruction } from "../packages/sdk/src/createReserveFlow";
import { findProtocolConfig } from "../packages/sdk/src/pda";

const PROGRAM_ID = new PublicKey("8hTW7fHwn8t8hcgTVeyAhHMiCTHGUP3783NWUTBBFwH9");
const FEE_BPS = 100; // 1%, same as PreStocks
const DECIMALS = 6;
const FUND_AMOUNT = 1_000_000n; // 1.000000 token

async function main() {
  const connection = new Connection("http://127.0.0.1:8899", "confirmed");
  const payer = Keypair.generate();
  await connection.confirmTransaction(await connection.requestAirdrop(payer.publicKey, 50 * LAMPORTS_PER_SOL), "confirmed");

  // A Token-2022 mint that charges 1% on every transfer.
  const mintKp = Keypair.generate();
  const len = getMintLen([ExtensionType.TransferFeeConfig]);
  const lamports = await connection.getMinimumBalanceForRentExemption(len);
  await sendAndConfirmTransaction(connection, new Transaction().add(
    SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: mintKp.publicKey, space: len, lamports, programId: TOKEN_2022_PROGRAM_ID }),
    createInitializeTransferFeeConfigInstruction(mintKp.publicKey, payer.publicKey, payer.publicKey, FEE_BPS, BigInt("18446744073709551615"), TOKEN_2022_PROGRAM_ID),
    createInitializeMintInstruction(mintKp.publicKey, DECIMALS, payer.publicKey, null, TOKEN_2022_PROGRAM_ID),
  ), [payer, mintKp], { commitment: "confirmed" });
  // The program derives the Manager's ATA, so fund that exact account.
  const ata = (await getOrCreateAssociatedTokenAccount(connection, payer, mintKp.publicKey, payer.publicKey, false, "confirmed", { commitment: "confirmed" }, TOKEN_2022_PROGRAM_ID)).address;
  await mintTo(connection, payer, mintKp.publicKey, ata, payer, 1_000_000_000n, [], { commitment: "confirmed" }, TOKEN_2022_PROGRAM_ID);
  console.log(`fee mint created: ${FEE_BPS / 100}% transfer fee`);

  const provider = new AnchorProvider(connection, { publicKey: payer.publicKey, signTransaction: async (t: never) => t, signAllTransactions: async (t: never) => t } as never, { commitment: "confirmed" });
  const program = new Program(idlJson as Idl, provider);

  const [protocolConfig] = findProtocolConfig(PROGRAM_ID);
  if (!(await connection.getAccountInfo(protocolConfig))) {
    await sendAndConfirmTransaction(connection, new Transaction().add(
      await program.methods.initializeProtocol(Keypair.generate().publicKey, 10, 0, payer.publicKey)
        .accounts({ protocolConfig, authority: payer.publicKey, systemProgram: SystemProgram.programId } as never).instruction(),
    ), [payer], { commitment: "confirmed" });
  }

  const addresses = await deriveNewReserveAddresses(program as never, PROGRAM_ID);
  await sendAndConfirmTransaction(connection, new Transaction().add(
    await buildCreateReserveInstruction(program as never, addresses, payer.publicKey, {
      metadataUri: "https://ssr.fun/api/mainnet/reserve-metadata?id=0000000000000000",
      mintFeeBps: 0, redemptionFeeBps: 0, tvlFeeBps: 0, feeDestination: payer.publicKey,
    } as never),
  ), [payer], { commitment: "confirmed" });

  const asset = deriveReserveAssetAddresses(addresses.reserve, mintKp.publicKey, PROGRAM_ID, TOKEN_2022_PROGRAM_ID);
  await sendAndConfirmTransaction(connection, new Transaction().add(
    await buildInitializeReserveAssetInstruction(program as never, addresses, asset, payer.publicKey, 10_000),
  ), [payer], { commitment: "confirmed" });
  console.log("fee-bearing mint ACCEPTED as a Reserve asset");

  const before = BigInt((await getAccount(connection, ata, "confirmed", TOKEN_2022_PROGRAM_ID)).amount);
  // seed_reserve is the FIRST deposit path -- the one a fresh Reserve uses.
  await sendAndConfirmTransaction(connection, new Transaction().add(
    await buildSeedReserveInstruction(program as never, addresses, [asset], payer.publicKey, [FUND_AMOUNT], 1_000_000_000n),
  ), [payer], { commitment: "confirmed" });

  const vault = BigInt((await getAccount(connection, asset.vault, "confirmed", TOKEN_2022_PROGRAM_ID)).amount);
  const spent = before - BigInt((await getAccount(connection, ata, "confirmed", TOKEN_2022_PROGRAM_ID)).amount);
  const naive = FUND_AMOUNT - (FUND_AMOUNT * BigInt(FEE_BPS)) / 10_000n;

  console.log(`\nManager asked to fund : ${FUND_AMOUNT}`);
  console.log(`vault actually holds  : ${vault}   (without gross-up it would be ${naive})`);
  console.log(`depositor was debited : ${spent}   (the fee is paid by them)`);
  const ok = vault === FUND_AMOUNT && spent > FUND_AMOUNT;
  console.log(`\n${ok ? "PASS -- the Reserve received the full amount; the fee came out of the depositor" : "FAIL -- the Reserve was short-changed"}`);
  process.exit(ok ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
