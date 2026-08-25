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
  BUY_SWAP_BUFFER_FRACTION,
  type BuyLegInput,
} from "../src/merge/lib/multiAssetBuyPlan";
import { usdToReserveTokensRequested } from "../src/merge/lib/multiAssetBuyClient";

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
});

describe("USDC-only buy funding plan (planBuyFunding) -- the funding invariant applied to purchases", () => {
  const legs = (overrides: Partial<Record<"wsolHeld" | "ssrHeld", bigint>> = {}): BuyLegInput[] => [
    { mint: WSOL, decimals: 9, requiredRaw: 51_510_000n, heldRaw: overrides.wsolHeld ?? 0n, priceUsd: 98.1 },
    { mint: SSR, decimals: 6, requiredRaw: 8_134_000_000n, heldRaw: overrides.ssrHeld ?? 0n, priceUsd: 0.000613 },
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

  it("an already-held leg is never repurchased -- the exact live stranded-wSOL state (a failed attempt's 0.0515 wrapped SOL in the buyer's own ATA) is counted first on retry", () => {
    const plan = planBuyFunding(legs({ wsolHeld: 51_510_000n }));
    expect(plan.actions.find((a) => a.mint === WSOL)?.kind).to.equal("already-held");
    expect(plan.actions.filter((a) => a.kind === "jupiter-swap")).to.have.length(1); // only SSR still needs funding
  });

  it("retry after partial completion (one swap succeeded, then failure): re-planning with the funded balance produces ONLY the remaining leg's swap -- duplicate underlying purchases are structurally impossible", () => {
    const afterFirstSwap = planBuyFunding(legs({ ssrHeld: 8_134_000_000n }));
    const swaps = afterFirstSwap.actions.filter((a) => a.kind === "jupiter-swap");
    expect(swaps).to.have.length(1);
    expect(swaps[0].mint).to.equal(WSOL);
  });

  it("a USDC leg is consumed directly from the buyer's USDC (no swap FROM USDC INTO USDC), counted in the feasibility requirement", () => {
    const plan = planBuyFunding([{ mint: USDC, decimals: 6, requiredRaw: 5_000_000n, heldRaw: 0n, priceUsd: 1 }]);
    expect(plan.actions[0].kind).to.equal("already-held");
    expect(plan.usdcLegRequiredRaw).to.equal(5_000_000n);
    expect(plan.totalSwapUsdcRaw).to.equal(0n);
  });

  it("refuses to guess a swap budget for a leg with no real USD price", () => {
    expect(() => planBuyFunding([{ mint: SSR, decimals: 6, requiredRaw: 1_000_000n, heldRaw: 0n, priceUsd: null }])).to.throw("USD price");
  });
});

describe("Whole-purchase feasibility gate (assessBuyFeasibility) -- checked BEFORE any transaction is constructed", () => {
  const plan = planBuyFunding([
    { mint: WSOL, decimals: 9, requiredRaw: 51_510_000n, heldRaw: 0n, priceUsd: 98.1 },
    { mint: SSR, decimals: 6, requiredRaw: 8_134_000_000n, heldRaw: 0n, priceUsd: 0.000613 },
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

describe("Honest post-failure state report (buildBuyStateReport) -- from freshly-read balances only", () => {
  const legsHeld = [
    { mint: WSOL, symbol: "SOL", requiredRaw: 51_510_000n, heldRaw: 51_510_000n },
    { mint: SSR, symbol: "SSR", requiredRaw: 8_134_000_000n, heldRaw: 8_134_000_000n },
  ];

  it("failure before minting with every leg funded: reports Reserve Token NOT minted, every asset held in the buyer's wallet, and that retry only re-submits the mint (the exact live CHARLI state)", () => {
    const report = buildBuyStateReport(legsHeld, 9_900_000n, 9_900_000n, 1_960_200n);
    expect(report.reserveTokenMinted).to.equal(false);
    expect(report.legs.every((l) => l.fundedEnough)).to.equal(true);
    expect(report.retrySummary).to.include("only re-submits the final mint");
  });

  it("a landed mint is reported as minted, with retry doing nothing twice", () => {
    const report = buildBuyStateReport(legsHeld, 9_900_000n, 9_900_000n + 1_960_200n, 1_960_200n);
    expect(report.reserveTokenMinted).to.equal(true);
    expect(report.retrySummary).to.include("will not mint again");
  });

  it("a partially-funded failure names exactly which Reserve assets retry will still swap USDC for", () => {
    const report = buildBuyStateReport(
      [legsHeld[0], { ...legsHeld[1], heldRaw: 0n }],
      9_900_000n,
      9_900_000n,
      1_960_200n,
    );
    expect(report.reserveTokenMinted).to.equal(false);
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
