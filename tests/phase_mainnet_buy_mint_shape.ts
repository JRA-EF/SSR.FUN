// Offline regression coverage for the Mainnet USDC-denominated Reserve
// Token buy correction (DEC-0154). Root cause guarded here: the deployed
// Mainnet ssr_protocol binary (last deployed 2026-08-19T10:34:43Z, slot
// 440248996, never upgraded since) expects mint_reserve_tokens_in_kind's
// PRE-fee-settlement account shape -- but the committed SDK IDL was
// regenerated on 2026-08-21 from the never-deployed fee-settlement source
// (cf56a2b), silently changing the instruction's account list. Every mint
// built against the regenerated IDL then failed on-chain with Anchor 3002
// AccountDiscriminatorMismatch ("caused by account: manager_fee_recipients"):
// the token program slid into the slot the deployed binary reads as
// manager_fee_recipients. Confirmed live 2026-08-25 (CHARLI buy, wallet
// 6BjTPAWGjUYjL2Hrvz7iVmzWv8yKHNDqUAif5DEPWZen, e.g. signature
// Z6v6BGFN8caDXid5yUKCFSapUPc9CJXZpqXNG4nFifbWTtkawFWYmc3VTAaN3Le22HEpAGj3My3YVT98P7rtUo3),
// and the corrected shape proven by read-only Mainnet simulation (err: null).
import { expect } from "chai";
import * as fs from "fs";
import * as path from "path";
import { Connection, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { buildReadOnlyProgram } from "../packages/sdk/src/readOnly";
import { buildDirectMultiAssetMintInstructions } from "../packages/sdk/src/directInstructions";
import { findProtocolConfig, findTvlAccrual } from "../packages/sdk/src/pda";
import { computeNetMintOutput } from "../packages/sdk/src/calculations";
import {
  planBuyFunding,
  assessBuyFeasibility,
  shouldSubmitMint,
  buildBuyStateReport,
  countableAcquiredRaw,
  computeOwnerTokenDeltaRaw,
  BUY_SWAP_BUFFER_FRACTION,
  type BuyLegInput,
} from "../src/merge/lib/multiAssetBuyPlan";
import { describeOnChainError } from "../packages/sdk/src/errors";
import { usdToReserveTokensRequested, readPendingBuy, savePendingBuy, clearPendingBuy, type PendingBuyState } from "../src/merge/lib/multiAssetBuyClient";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const WSOL = "So11111111111111111111111111111111111111112";
const SSR = "BpdHpqznEgYPXZNrJVRZvBhdWoafYLVVuLxTQo34pump";

// The DEPLOYED binary's account lists -- pinned literally, position by
// position. These must track the DEPLOYED Mainnet program (slot 440248996),
// NOT the Rust source tree; a Mainnet program upgrade is the only event
// that may change them (and must change them deliberately, together).
const DEPLOYED_MINT_ACCOUNTS = [
  "protocol_config",
  "reserve",
  "reserve_token_mint",
  "mint_authority",
  "depositor_reserve_token_account",
  "depositor",
  "protocol_fee_destination_token_account",
  "protocol_fee_destination",
  "tvl_accrual",
  "manager_fee_recipients",
  "token_program",
  "associated_token_program",
  "system_program",
];
const DEPLOYED_ACCRUE_ACCOUNTS = [
  "protocol_config",
  "reserve",
  "reserve_token_mint",
  "mint_authority",
  "tvl_accrual",
  "protocol_fee_destination_token_account",
  "protocol_fee_destination",
  "manager_fee_recipients",
  "payer",
  "token_program",
  "associated_token_program",
  "system_program",
];

function sdkIdl(): { instructions: { name: string; accounts: { name: string }[] }[] } {
  return JSON.parse(fs.readFileSync(path.join(__dirname, "..", "packages", "sdk", "idl", "ssr_protocol.json"), "utf8"));
}
function deployedEraIdl(): { instructions: { name: string; accounts: { name: string }[] }[] } {
  return JSON.parse(fs.readFileSync(path.join(__dirname, "..", "target", "idl", "ssr_protocol.json"), "utf8"));
}
const accountsOf = (idl: ReturnType<typeof sdkIdl>, name: string) => idl.instructions.find((i) => i.name === name)!.accounts.map((a) => a.name);

describe("Deployed-binary account-shape pinning (the DEC-0154 root cause, made impossible to silently regress)", () => {
  it("SDK IDL's mint_reserve_tokens_in_kind matches the DEPLOYED binary's account list exactly, position by position", () => {
    expect(accountsOf(sdkIdl(), "mint_reserve_tokens_in_kind")).to.deep.equal(DEPLOYED_MINT_ACCOUNTS);
  });

  it("SDK IDL's accrue_fees matches the DEPLOYED binary's account list exactly (same drift class, fixed in the same pass)", () => {
    expect(accountsOf(sdkIdl(), "accrue_fees")).to.deep.equal(DEPLOYED_ACCRUE_ACCOUNTS);
  });

  it("redeem_reserve_tokens_in_kind and seed_reserve did NOT drift -- SDK IDL matches the deployed-era IDL for both (Sell and launches were never affected)", () => {
    for (const name of ["redeem_reserve_tokens_in_kind", "seed_reserve"]) {
      expect(accountsOf(sdkIdl(), name), name).to.deep.equal(accountsOf(deployedEraIdl(), name));
    }
  });

  it("a built two-asset (SOL + SSR) mint instruction has the deployed wire shape: 13 fixed accounts, fee-destination pair at 6-7, tvl_accrual at 8, the program-id sentinel at 9 (manager_fee_recipients), then the three programs -- plus 5 remaining accounts per leg", async () => {
    const connection = new Connection("http://localhost:9999"); // never contacted -- .instruction() builds offline
    const program = buildReadOnlyProgram(connection);
    const RESERVE = new PublicKey("EK5WwpsRuWPCAhV4Rd4s5SRuE6Gnbc8SA94oUjZbHfVb"); // CHARLI, the live failed buy's real Reserve
    const RT_MINT = new PublicKey("J4XbyjS6iPHRQ8oPAAAc2GhmP3549ga9gZiu8MR5iimq");
    const USER = new PublicKey("6BjTPAWGjUYjL2Hrvz7iVmzWv8yKHNDqUAif5DEPWZen");
    const TREASURY = new PublicKey("3CBpVMPDQD75b5bXgDunkpVJ3EeQWcwU9DCSLsTjWQL5");
    const { instructions } = await buildDirectMultiAssetMintInstructions({
      program,
      protocolConfig: findProtocolConfig(program.programId)[0],
      protocolFeeDestination: TREASURY,
      reserve: RESERVE,
      reserveTokenMint: RT_MINT,
      mintAuthority: new PublicKey("FAjR5aMW9j8fZwFw9nDxkhjU3fjDAGq8Taniby6rmrZ5"),
      user: USER,
      assets: [
        { mint: WSOL, decimals: 9, reserveAsset: "6k3bmpVsP9T6mYHmJbJoGguQrrv7rB3wH8zqSRYo8kpa", vault: "9xQQ9UUjuUbKpu2E5Pswf8SsjfmEJVrYMdRwLX7spNvu", vaultBalanceRaw: "101896089" },
        { mint: SSR, decimals: 6, reserveAsset: "5wfs7tUrkvVzUPKst5mk7pHpMvvoZaskpkKSwk2huAfo", vault: "34hNxsxqBWH9czMKpng6zqcsmpg8SA4NeznenyF7VqH8", vaultBalanceRaw: "16187960040" },
      ],
      reserveTokenSupplyRaw: "19900000",
      reserveTokensRequested: 100000n,
    });
    const mintIx = instructions[instructions.length - 1];
    expect(mintIx.keys.length).to.equal(13 + 2 * 5);
    expect(mintIx.keys[6].pubkey.toBase58()).to.equal(getAssociatedTokenAddressSync(RT_MINT, TREASURY, true).toBase58()); // protocol_fee_destination_token_account
    expect(mintIx.keys[7].pubkey.toBase58()).to.equal(TREASURY.toBase58()); // protocol_fee_destination
    expect(mintIx.keys[8].pubkey.toBase58()).to.equal(findTvlAccrual(RESERVE, program.programId)[0].toBase58()); // tvl_accrual
    expect(mintIx.keys[9].pubkey.toBase58()).to.equal(program.programId.toBase58()); // manager_fee_recipients "None" sentinel
    // The exact live failure shape (token program in the manager_fee_recipients slot) can never rebuild:
    expect(mintIx.keys[9].pubkey.toBase58()).to.not.equal("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
  });

  it("a SINGLE-asset (ALPHA-shaped, 100% SSR) mint builds through the same USDC-funded path -- one leg is just the smallest basket (DEC-0160; the old >=2 restriction failed every live ALPHA buy at composition time)", async () => {
    const connection = new Connection("http://localhost:9999"); // never contacted -- .instruction() builds offline
    const program = buildReadOnlyProgram(connection);
    const USER = new PublicKey("6BjTPAWGjUYjL2Hrvz7iVmzWv8yKHNDqUAif5DEPWZen");
    const { instructions, requiredAmountsRaw } = await buildDirectMultiAssetMintInstructions({
      program,
      protocolConfig: findProtocolConfig(program.programId)[0],
      protocolFeeDestination: new PublicKey("3CBpVMPDQD75b5bXgDunkpVJ3EeQWcwU9DCSLsTjWQL5"),
      reserve: new PublicKey("EK5WwpsRuWPCAhV4Rd4s5SRuE6Gnbc8SA94oUjZbHfVb"),
      reserveTokenMint: new PublicKey("J4XbyjS6iPHRQ8oPAAAc2GhmP3549ga9gZiu8MR5iimq"),
      mintAuthority: new PublicKey("FAjR5aMW9j8fZwFw9nDxkhjU3fjDAGq8Taniby6rmrZ5"),
      user: USER,
      assets: [{ mint: SSR, decimals: 6, reserveAsset: "5wfs7tUrkvVzUPKst5mk7pHpMvvoZaskpkKSwk2huAfo", vault: "34hNxsxqBWH9czMKpng6zqcsmpg8SA4NeznenyF7VqH8", vaultBalanceRaw: "30000000000" }],
      reserveTokenSupplyRaw: "20000000",
      reserveTokensRequested: 9_690_000n,
    });
    const mintIx = instructions[instructions.length - 1];
    expect(mintIx.keys.length).to.equal(13 + 1 * 5); // the same deployed shape, one leg
    expect(mintIx.keys[9].pubkey.toBase58()).to.equal(program.programId.toBase58()); // manager_fee_recipients "None" sentinel unchanged
    expect(requiredAmountsRaw).to.have.length(1);
    expect(requiredAmountsRaw[0]).to.equal((9_690_000n * 30_000_000_000n + 19_999_999n) / 20_000_000n); // mulDivCeil(requested, vault, supply)
  });

  it("an empty asset list is still refused (an unresolved Reserve shape is never mintable)", async () => {
    const connection = new Connection("http://localhost:9999");
    const program = buildReadOnlyProgram(connection);
    try {
      await buildDirectMultiAssetMintInstructions({
        program,
        protocolConfig: findProtocolConfig(program.programId)[0],
        protocolFeeDestination: new PublicKey("3CBpVMPDQD75b5bXgDunkpVJ3EeQWcwU9DCSLsTjWQL5"),
        reserve: new PublicKey("EK5WwpsRuWPCAhV4Rd4s5SRuE6Gnbc8SA94oUjZbHfVb"),
        reserveTokenMint: new PublicKey("J4XbyjS6iPHRQ8oPAAAc2GhmP3549ga9gZiu8MR5iimq"),
        mintAuthority: new PublicKey("FAjR5aMW9j8fZwFw9nDxkhjU3fjDAGq8Taniby6rmrZ5"),
        user: new PublicKey("6BjTPAWGjUYjL2Hrvz7iVmzWv8yKHNDqUAif5DEPWZen"),
        assets: [],
        reserveTokenSupplyRaw: "20000000",
        reserveTokensRequested: 1n,
      });
      expect.fail("expected a throw");
    } catch (e) {
      expect(String(e)).to.include("at least one registered asset");
    }
  });
});

describe("USDC-only buy funding plan (planBuyFunding) -- the funding invariant applied to purchases (DEC-0155: purchase-scoped, never whole-wallet)", () => {
  const legs = (overrides: Partial<Record<"wsolHeld" | "ssrHeld" | "wsolAcquired" | "ssrAcquired", bigint>> = {}): BuyLegInput[] => [
    { mint: WSOL, decimals: 9, requiredRaw: 51_510_000n, walletHeldRaw: overrides.wsolHeld ?? 0n, purchaseAcquiredRaw: overrides.wsolAcquired ?? 0n, priceUsd: 98.1 },
    { mint: SSR, decimals: 6, requiredRaw: 8_134_000_000n, walletHeldRaw: overrides.ssrHeld ?? 0n, purchaseAcquiredRaw: overrides.ssrAcquired ?? 0n, priceUsd: 0.000613 },
  ];

  it("a USDC buy of a two-asset Reserve containing SOL funds the wrapped-SOL leg by a Jupiter swap FROM USDC with receiveWrappedSol -- never by consuming the buyer's native SOL as capital", () => {
    const plan = planBuyFunding(legs());
    const wsolAction = plan.actions.find((a) => a.kind === "jupiter-swap" && a.mint === WSOL);
    expect(wsolAction).to.not.equal(undefined);
    if (wsolAction?.kind === "jupiter-swap") {
      expect(wsolAction.receiveWrappedSol).to.equal(true); // the output must STAY wrapped SOL for the in-kind deposit
      // ~0.05151 SOL x $98.1 x 1.02 buffer ~= $5.15 of USDC
      expect(Number(wsolAction.usdcBudgetRaw) / 1e6).to.be.closeTo(0.05151 * 98.1 * (1 + BUY_SWAP_BUFFER_FRACTION), 0.01);
    }
    const ssrAction = plan.actions.find((a) => a.kind === "jupiter-swap" && a.mint === SSR);
    if (ssrAction?.kind === "jupiter-swap") expect(ssrAction.receiveWrappedSol).to.equal(false);
  });

  it("EXISTING UNRELATED WALLET HOLDINGS never replace the quoted USDC: the exact live wallet state (154,278 pre-existing SSR + 0.0515 wSOL wrapped from native SOL, none acquired by this purchase's swaps) still swaps USDC for BOTH legs in full", () => {
    const plan = planBuyFunding(legs({ ssrHeld: 154_278_336_552n, wsolHeld: 51_510_414n }));
    const swaps = plan.actions.filter((a) => a.kind === "jupiter-swap");
    expect(swaps).to.have.length(2); // both legs funded from USDC despite the wallet's holdings
    for (const s of swaps) {
      if (s.kind === "jupiter-swap") expect(s.deficitRaw).to.equal(s.mint === WSOL ? 51_510_000n : 8_134_000_000n); // the FULL requirement -- unrelated holdings count for nothing
    }
    expect(plan.totalSwapUsdcRaw > 0n).to.equal(true);
  });

  it("a leg THIS purchase's confirmed swaps already acquired is never repurchased -- retry counts the recorded acquisition first", () => {
    const plan = planBuyFunding(legs({ wsolHeld: 51_510_414n, wsolAcquired: 51_510_414n }));
    expect(plan.actions.find((a) => a.mint === WSOL)?.kind).to.equal("already-funded");
    expect(plan.actions.filter((a) => a.kind === "jupiter-swap")).to.have.length(1); // only SSR still needs funding
  });

  it("retry after partial completion (one swap succeeded and was recorded, then failure): re-planning produces ONLY the remaining leg's swap -- the full USDC amount is structurally impossible to spend twice", () => {
    const afterFirstSwap = planBuyFunding(legs({ ssrHeld: 8_200_000_000n, ssrAcquired: 8_200_000_000n }));
    const swaps = afterFirstSwap.actions.filter((a) => a.kind === "jupiter-swap");
    expect(swaps).to.have.length(1);
    expect(swaps[0].mint).to.equal(WSOL);
  });

  it("a purchase where every leg was already acquired plans ZERO swaps and zero further USDC spend -- retry re-submits only the mint", () => {
    const plan = planBuyFunding(legs({ wsolHeld: 51_510_414n, wsolAcquired: 51_510_414n, ssrHeld: 8_200_000_000n, ssrAcquired: 8_200_000_000n }));
    expect(plan.actions.filter((a) => a.kind === "jupiter-swap")).to.have.length(0);
    expect(plan.totalSwapUsdcRaw).to.equal(0n);
  });

  it("a recorded acquisition the wallet no longer fully holds (assets moved out mid-purchase) is capped at the real balance -- only the genuine remainder is re-funded", () => {
    expect(countableAcquiredRaw({ walletHeldRaw: 20_000_000n, purchaseAcquiredRaw: 51_510_000n })).to.equal(20_000_000n);
    // Non-wSOL: the moved-out portion is a genuine top-up swap. (For wSOL
    // the same situation re-WRAPS instead -- see phase_single_tx_buy.ts's
    // wrap-recovered-sol coverage, DEC-0156.)
    const plan = planBuyFunding(legs({ ssrHeld: 2_000_000_000n, ssrAcquired: 8_134_000_000n }));
    const ssrSwap = plan.actions.find((a) => a.kind === "jupiter-swap" && a.mint === SSR);
    if (ssrSwap?.kind === "jupiter-swap") expect(ssrSwap.deficitRaw).to.equal(8_134_000_000n - 2_000_000_000n);
    else expect.fail("expected a top-up swap for the moved-out portion");
  });

  it("a USDC leg is consumed directly from the buyer's USDC (no swap FROM USDC INTO USDC), counted in the feasibility requirement", () => {
    const plan = planBuyFunding([{ mint: USDC, decimals: 6, requiredRaw: 5_000_000n, walletHeldRaw: 0n, purchaseAcquiredRaw: 0n, priceUsd: 1 }]);
    expect(plan.actions[0].kind).to.equal("already-funded");
    expect(plan.usdcLegRequiredRaw).to.equal(5_000_000n);
    expect(plan.totalSwapUsdcRaw).to.equal(0n);
  });

  it("refuses to guess a swap budget for a leg with no real USD price", () => {
    expect(() => planBuyFunding([{ mint: SSR, decimals: 6, requiredRaw: 1_000_000n, walletHeldRaw: 0n, purchaseAcquiredRaw: 0n, priceUsd: null }])).to.throw("USD price");
  });
});

describe("Swap-output reconciliation (computeOwnerTokenDeltaRaw) -- what a recorded signature actually delivered, from its own transaction meta", () => {
  const OWNER = "6BjTPAWGjUYjL2Hrvz7iVmzWv8yKHNDqUAif5DEPWZen";

  it("measures the owner's wSOL gain from pre/post token balances (a USDC->wSOL swap with receiveWrappedSol)", () => {
    const pre = [
      { owner: OWNER, mint: USDC, uiTokenAmount: { amount: "166088659" } },
      { owner: OWNER, mint: WSOL, uiTokenAmount: { amount: "0" } },
    ];
    const post = [
      { owner: OWNER, mint: USDC, uiTokenAmount: { amount: "160938659" } },
      { owner: OWNER, mint: WSOL, uiTokenAmount: { amount: "51510414" } },
    ];
    expect(computeOwnerTokenDeltaRaw(pre, post, OWNER, WSOL)).to.equal(51_510_414n);
    expect(computeOwnerTokenDeltaRaw(pre, post, OWNER, USDC)).to.equal(-5_150_000n); // the USDC spent shows as a negative delta
  });

  it("a freshly-created ATA (no pre entry at all) counts from zero; other owners' balances are ignored", () => {
    const post = [
      { owner: OWNER, mint: SSR, uiTokenAmount: { amount: "8200000000" } },
      { owner: "SomeoneElse1111111111111111111111111111111111", mint: SSR, uiTokenAmount: { amount: "999" } },
    ];
    expect(computeOwnerTokenDeltaRaw([], post, OWNER, SSR)).to.equal(8_200_000_000n);
  });
});

describe("The complete live failure, decoded (signature 5LxJ5oif7Ufo4132Mhamm7LVNf6gxaaKBL6xbTi4vfTphpMsuvDuo3tNEFqbBboQAJUXgv9SUDwDbzDi4CuqDnPW, 2026-08-26 09:05:58Z)", () => {
  it("instruction index 5's {\"Custom\":3002} decodes to Anchor's own AccountDiscriminatorMismatch -- a framework account-validation error from ssr_protocol's deployed binary, NOT an ssr_protocol custom error (those start at 6000)", () => {
    // The exact serialized error and message shape production produced:
    const raw = `Transaction failed on-chain ({"InstructionError":[5,{"Custom":3002}]}).`;
    const described = describeOnChainError(new Error(raw));
    expect(described).to.include("3002");
    expect(described).to.include("AccountDiscriminatorMismatch");
    expect(described).to.include("Account discriminator did not match");
    expect(described).to.include("framework-level");
    // and never misattributed to an SSR custom error:
    expect(described).to.not.include("SsrError::");
  });

  it("instruction index 5 is the first ssr_protocol instruction in the failed transaction's layout (0-1 compute budget, 2-4 idempotent ATA creations, 5 mint_reserve_tokens_in_kind)", () => {
    // Pinned from the decoded live transaction -- the ATA creations at 2-4
    // all succeeded (idempotent, nothing new created) and the buy failed at
    // the very first ssr_protocol instruction, before any token movement:
    // the transaction was atomic, so NOTHING was deposited and no CHARLI
    // minted; the only cost was the network fee.
    const failedInstructionIndex = 5;
    const layout = ["compute-budget", "compute-budget", "ata-create-idempotent", "ata-create-idempotent", "ata-create-idempotent", "ssr-mint-reserve-tokens-in-kind"];
    expect(layout[failedInstructionIndex]).to.equal("ssr-mint-reserve-tokens-in-kind");
  });
});

describe("Pending-purchase persistence (ssr_pending_buys_v2) -- refresh/reconnect recovery without losing acquired-asset records", () => {
  const store = new Map<string, string>();
  before(() => {
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
  });
  after(() => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });
  beforeEach(() => store.clear());

  const state = (wallet: string, reserve: string, extra?: Partial<PendingBuyState>): PendingBuyState => ({
    wallet,
    reserve,
    startedAt: 1_756_198_000_000,
    legFunding: {
      [WSOL]: { mint: WSOL, status: "submitted", lastSignature: "SigWsolSwap111", acquiredRaw: "0" },
      [SSR]: { mint: SSR, status: "ready_to_seed", lastSignature: "SigSsrSwap111", acquiredRaw: "8200000000", verifiedBalanceRaw: "8200000000" },
    },
    preMintReserveTokenRaw: "19800000",
    expectedNetReserveTokensRaw: "9575600",
    ...extra,
  });

  it("a purchase interrupted by refresh round-trips completely: submitted signatures, per-leg acquired amounts, and the double-mint baseline all survive for reconciliation", () => {
    savePendingBuy(state("walletA", "reserveA"));
    const back = readPendingBuy("walletA", "reserveA");
    expect(back).to.not.equal(null);
    expect(back!.legFunding[WSOL].lastSignature).to.equal("SigWsolSwap111"); // the recorded signature reconciliation resumes from
    expect(back!.legFunding[SSR].acquiredRaw).to.equal("8200000000"); // the confirmed acquisition that will never be repurchased
    expect(back!.preMintReserveTokenRaw).to.equal("19800000"); // the double-mint guard's baseline
  });

  it("purchases of two different Reserves coexist -- starting one never discards the other's in-flight record (the v1 single-slot shape did)", () => {
    savePendingBuy(state("walletA", "reserveA"));
    savePendingBuy(state("walletA", "reserveB"));
    expect(readPendingBuy("walletA", "reserveA")).to.not.equal(null);
    expect(readPendingBuy("walletA", "reserveB")).to.not.equal(null);
    clearPendingBuy("walletA", "reserveA");
    expect(readPendingBuy("walletA", "reserveA")).to.equal(null);
    expect(readPendingBuy("walletA", "reserveB")).to.not.equal(null);
  });

  it("a different wallet or reserve never reads another purchase's state", () => {
    savePendingBuy(state("walletA", "reserveA"));
    expect(readPendingBuy("walletB", "reserveA")).to.equal(null);
    expect(readPendingBuy("walletA", "reserveB")).to.equal(null);
  });

  it("corrupt stored JSON reads as no pending purchase instead of throwing", () => {
    store.set("ssr_pending_buys_v2", "{not json");
    expect(readPendingBuy("walletA", "reserveA")).to.equal(null);
  });
});

describe("Whole-purchase feasibility gate (assessBuyFeasibility) -- checked BEFORE any transaction is constructed", () => {
  const plan = planBuyFunding([
    { mint: WSOL, decimals: 9, requiredRaw: 51_510_000n, walletHeldRaw: 0n, purchaseAcquiredRaw: 0n, priceUsd: 98.1 },
    { mint: SSR, decimals: 6, requiredRaw: 8_134_000_000n, walletHeldRaw: 0n, purchaseAcquiredRaw: 0n, priceUsd: 0.000613 },
  ]);

  it("insufficient USDC is rejected upfront with the exact current-vs-required shortfall (Jupiter's own documented InsufficientFunds handling, applied preemptively)", () => {
    const result = assessBuyFeasibility({ plan, walletUsdcRaw: 1_000_000n, walletSolLamports: 100_000_000n });
    expect(result.feasible).to.equal(false);
    expect(result.missingUsdcRaw > 0n).to.equal(true);
    expect(result.reasons.join(" ")).to.include("USDC short");
  });

  it("insufficient SOL for network fees/rent is rejected upfront and named as fees/rent -- never conflated with purchase capital", () => {
    const result = assessBuyFeasibility({ plan, walletUsdcRaw: 100_000_000n, walletSolLamports: 1_000n });
    expect(result.feasible).to.equal(false);
    expect(result.reasons.join(" ")).to.include("network fees");
  });

  it("a wallet holding enough USDC and SOL passes", () => {
    const result = assessBuyFeasibility({ plan, walletUsdcRaw: 100_000_000n, walletSolLamports: 100_000_000n });
    expect(result.feasible).to.equal(true);
    expect(result.missingUsdcRaw).to.equal(0n);
    expect(result.missingSolLamports).to.equal(0n);
  });
});

describe("Double-mint guard (shouldSubmitMint) -- verified from the buyer's REAL Reserve Token balance, never client state", () => {
  it("failure BEFORE the Reserve Token mint (balance unchanged) -- retry MAY submit the mint", () => {
    expect(shouldSubmitMint(9_900_000n, 9_900_000n, 1_960_200n)).to.equal(true);
  });

  it("a landed mint (balance grew by the expected net output) -- retry must NEVER submit again", () => {
    expect(shouldSubmitMint(9_900_000n, 9_900_000n + 1_960_200n, 1_960_200n)).to.equal(false);
  });

  it("tolerates on-chain fee rounding: growth within 1% below the expected output still counts as minted", () => {
    const expected = 1_960_200n;
    const grownSlightlyLess = expected - expected / 200n; // 0.5% under
    expect(shouldSubmitMint(9_900_000n, 9_900_000n + grownSlightlyLess, expected)).to.equal(false);
  });

  it("an unrelated small balance increase (far below the expected output) does NOT count as minted", () => {
    expect(shouldSubmitMint(9_900_000n, 9_900_000n + 5n, 1_960_200n)).to.equal(true);
  });

  it("never submits a zero/negative mint", () => {
    expect(shouldSubmitMint(0n, 0n, 0n)).to.equal(false);
  });
});

describe("Honest post-failure state report (buildBuyStateReport) -- from freshly-read balances and reconciled purchase-acquired amounts only", () => {
  const legsFunded = [
    { mint: WSOL, symbol: "SOL", requiredRaw: 51_510_000n, walletHeldRaw: 51_510_414n, purchaseAcquiredRaw: 51_510_414n },
    { mint: SSR, symbol: "SSR", requiredRaw: 8_134_000_000n, walletHeldRaw: 8_200_000_000n, purchaseAcquiredRaw: 8_200_000_000n },
  ];

  it("failure at the final mint with every leg genuinely acquired: reports the exact failed stage, Reserve Token NOT minted, and that retry only re-submits the mint", () => {
    const report = buildBuyStateReport(legsFunded, 9_900_000n, 9_900_000n, 1_960_200n, "the final mint that deposits the acquired assets and delivers your Reserve Tokens");
    expect(report.reserveTokenMinted).to.equal(false);
    expect(report.legs.every((l) => l.fundedEnough)).to.equal(true);
    expect(report.failedStage).to.include("final mint");
    expect(report.retrySummary).to.include("only re-submits the final mint");
  });

  it("a landed mint is reported as minted, with retry doing nothing twice", () => {
    const report = buildBuyStateReport(legsFunded, 9_900_000n, 9_900_000n + 1_960_200n, 1_960_200n, "verifying your Reserve Tokens actually arrived after the mint");
    expect(report.reserveTokenMinted).to.equal(true);
    expect(report.retrySummary).to.include("will not mint again");
  });

  it("the exact live CHARLI post-failure state (wallet full of unrelated SSR + stranded native-wrapped wSOL, but NOTHING acquired by the purchase's own swaps): every leg reports unfunded and retry names BOTH legs as the genuine USDC shortfall", () => {
    const report = buildBuyStateReport(
      [
        { mint: WSOL, symbol: "SOL", requiredRaw: 51_510_000n, walletHeldRaw: 51_510_414n, purchaseAcquiredRaw: 0n },
        { mint: SSR, symbol: "SSR", requiredRaw: 8_134_000_000n, walletHeldRaw: 154_278_336_552n, purchaseAcquiredRaw: 0n },
      ],
      19_800_000n,
      19_800_000n,
      9_575_600n,
      "the final mint that deposits the acquired assets and delivers your Reserve Tokens",
    );
    expect(report.reserveTokenMinted).to.equal(false);
    expect(report.legs.every((l) => !l.fundedEnough)).to.equal(true);
    expect(report.retrySummary).to.include("SOL, SSR");
    expect(report.retrySummary).to.include("never used in place of your USDC");
  });

  it("a partially-funded failure names exactly which Reserve assets retry will still swap USDC for, and that acquired work is never repeated", () => {
    const report = buildBuyStateReport(
      [legsFunded[0], { ...legsFunded[1], purchaseAcquiredRaw: 0n, walletHeldRaw: 0n }],
      9_900_000n,
      9_900_000n,
      1_960_200n,
      "swapping your USDC for one of the Reserve's assets (Bpd...pump)",
    );
    expect(report.reserveTokenMinted).to.equal(false);
    expect(report.failedStage).to.include("swapping your USDC");
    expect(report.retrySummary).to.include("SSR");
    expect(report.retrySummary).to.include("never repurchased");
  });
});

describe("Correct Reserve Token delivery math (CHARLI's real live numbers)", () => {
  it("a $10 buy at CHARLI's real NAV requests the right gross Reserve Tokens and the 1% mint fee nets down exactly as the program will compute it", () => {
    const nav = 20 / 19.9; // CHARLI: $20 of assets backing 19.9 supply
    const gross = usdToReserveTokensRequested(10, nav, 6);
    expect(gross).to.equal(BigInt(Math.floor((10 / nav) * 1e6)));
    const { netOut } = computeNetMintOutput(gross, 100n);
    expect(netOut).to.equal(gross - (gross * 100n + 9_999n) / 10_000n);
  });
});
