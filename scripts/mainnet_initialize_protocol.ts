// One-time Mainnet genesis: calls initialize_protocol on the freshly-deployed
// ssr_protocol Mainnet program. Run ONCE, by Creator, after `solana program
// deploy` has landed and been verified on-chain.
//
// This script never touches, requests, or prints any private key material --
// the signer keypair is loaded purely from the file path in ANCHOR_WALLET
// (only its PUBLIC key is ever read/printed, for the pre-flight match-check
// below); the RPC URL is read directly out of .env.local's
// HELIUS_MAINNET_RPC_URL so it never needs to be typed into a shell command.
//
// Usage (from repo root, PowerShell or Git Bash):
//   export ANCHOR_WALLET="<path to the CgHFxD4X... keypair file>"
//   export TS_NODE_PROJECT="scripts/tsconfig.json"
//   export TS_NODE_TRANSPILE_ONLY=true
//   npx ts-node --require ts-node/register scripts/mainnet_initialize_protocol.ts

import * as anchor from "@anchor-lang/core";
import { Program, Wallet } from "@anchor-lang/core";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";

function loadMainnetRpcUrl(): string {
  const envPath = path.resolve(__dirname, "..", ".env.local");
  const content = fs.readFileSync(envPath, "utf-8");
  const match = content.match(/^HELIUS_MAINNET_RPC_URL="([^"]+)"/m);
  if (!match) {
    throw new Error("HELIUS_MAINNET_RPC_URL not found in .env.local");
  }
  return match[1];
}

function loadWalletKeypair(): Keypair {
  const walletPath = process.env.ANCHOR_WALLET;
  if (!walletPath) {
    throw new Error("ANCHOR_WALLET env var (path to your keypair file) is required.");
  }
  const secretKey = Uint8Array.from(JSON.parse(fs.readFileSync(walletPath, "utf-8")));
  return Keypair.fromSecretKey(secretKey);
}

const EXPECTED_AUTHORITY = new PublicKey("CgHFxD4XHZzmSGEomnMXipGo75ejqhVd5aNY4GHg4Rw8");
const BOSS_ADMIN_2 = new PublicKey("PSpQGPvw7tZedKJvN21dJkh3vdDQeXkwA5n9DKBRZw5");
const TREASURY_VAULT = new PublicKey("3CBpVMPDQD75b5bXgDunkpVJ3EeQWcwU9DCSLsTjWQL5");

// v1 DevNet-proven default (see docs/protocol/ACCOUNT_MODEL.md) -- not
// changeable after genesis by any current instruction, so kept at the
// already-proven value rather than guessed higher.
const MAX_RESERVE_ASSETS = 12;
// Documented as stored but never read by any fee-computation path (each
// Reserve sets its own fees at create_reserve time) -- vestigial field,
// matches the value used throughout DevNet's own initialize_protocol calls.
const DEFAULT_PROTOCOL_FEE_BPS = 0;

const PROTOCOL_CONFIG_SEED = Buffer.from("protocol_config");

async function main() {
  const rpcUrl = loadMainnetRpcUrl();
  const keypair = loadWalletKeypair();
  const connection = new Connection(rpcUrl, "confirmed");
  const wallet = new Wallet(keypair);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  anchor.setProvider(provider);

  const signerPubkey = provider.wallet.publicKey;
  console.log("Signer public key:", signerPubkey.toBase58());
  if (!signerPubkey.equals(EXPECTED_AUTHORITY)) {
    throw new Error(
      `STOP: ANCHOR_WALLET's public key (${signerPubkey.toBase58()}) does not match the approved Creator Protocol Admin wallet (${EXPECTED_AUTHORITY.toBase58()}). Refusing to proceed.`,
    );
  }

  const idlPath = path.resolve(__dirname, "..", "packages", "sdk", "idl", "ssr_protocol.json");
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));
  console.log("IDL program address:", idl.address);

  const program = new Program(idl as anchor.Idl, provider) as Program<anchor.Idl>;
  const programId = program.programId;

  const [protocolConfig] = PublicKey.findProgramAddressSync([PROTOCOL_CONFIG_SEED], programId);
  console.log("ProtocolConfig PDA:", protocolConfig.toBase58());

  const existing = await (program.account as any).protocolConfig.fetchNullable(protocolConfig);
  if (existing !== null) {
    throw new Error(
      `STOP: ProtocolConfig already exists at ${protocolConfig.toBase58()} (authority=${existing.authority?.toBase58?.() ?? existing.authority}). initialize_protocol can only run once -- refusing to re-send. If this is unexpected, investigate before doing anything else.`,
    );
  }

  const balance = await provider.connection.getBalance(signerPubkey);
  console.log("Signer balance (SOL):", balance / 1_000_000_000);

  console.log("\nAbout to call initialize_protocol with:");
  console.log("  authority (signer):     ", signerPubkey.toBase58());
  console.log("  admin_2 (Boss):         ", BOSS_ADMIN_2.toBase58());
  console.log("  max_reserve_assets:     ", MAX_RESERVE_ASSETS);
  console.log("  default_protocol_fee_bps:", DEFAULT_PROTOCOL_FEE_BPS);
  console.log("  default_protocol_fee_destination (Treasury vault):", TREASURY_VAULT.toBase58());

  const sig = await program.methods
    .initializeProtocol(BOSS_ADMIN_2, MAX_RESERVE_ASSETS, DEFAULT_PROTOCOL_FEE_BPS, TREASURY_VAULT)
    .accounts({
      protocolConfig,
      authority: signerPubkey,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  console.log("\nSUCCESS. initialize_protocol signature:", sig);

  const config = await (program.account as any).protocolConfig.fetch(protocolConfig);
  console.log("\nVerified on-chain ProtocolConfig:");
  console.log("  authority:", config.authority.toBase58());
  console.log("  admin2:   ", config.admin2.toBase58());
  console.log("  paused:   ", config.paused);
  console.log("  maxReserveAssets:", config.maxReserveAssets);
  console.log("  defaultProtocolFeeDestination:", config.defaultProtocolFeeDestination.toBase58());
}

main().catch((e) => {
  console.error("\nFAILED:", e.message ?? e);
  process.exit(1);
});
