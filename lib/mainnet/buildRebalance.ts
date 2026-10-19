// DEC-0250: SERVER-BUILT real rebalance for a Mainnet Reserve.
//
// Given the Reserve and the target weights the Manager wants, builds every
// transaction needed so the vaults really end up holding that composition:
//   1. (only if the targets change) register new assets + write the targets;
//   2. one transaction per swap leg: rebalance_swap_begin -> Jupiter route ->
//      rebalance_swap_end, co-signed by SSR's fee quote signer, which is what
//      binds the minimum the vault must receive (programs/ssr_protocol/src/
//      instructions/rebalance_swap.rs);
//   3. (only if an asset goes to 0%) remove the emptied assets
//      (remove_reserve_asset_compact) so they leave the Reserve.
// The Manager's wallet signs all of them in ONE approval (signAllTransactions)
// and the browser submits them in order. Nothing here can move value on its
// own: every transaction still needs the Manager's signature.
import { ComputeBudgetProgram, Keypair, PublicKey, TransactionInstruction, VersionedTransaction, type AddressLookupTableAccount } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import {
  assessMintAccount,
  assetAta,
  buildAddReserveAssetActiveInstruction,
  buildRebalanceSwapBeginInstruction,
  buildRebalanceSwapEndInstruction,
  buildRemoveReserveAssetCompactInstruction,
  buildUpdateTargetsInstruction,
  describeIncompatibleAsset,
  findDelegate,
  findReserveAsset,
} from "@ssr/sdk";
import { deserializeJupiterInstruction, fetchLookupTables, isComputeBudgetInstruction, SINGLE_TX_MICRO_LAMPORTS_PER_CU, type JupiterInstructionJson } from "../../src/merge/lib/singleTxBuy";
import { BuildError, compileV0, fitsV0, readReserveAndWallet, toBase64, type ReadDeps } from "./buildCommon";
import { MAINNET_USDC_MINT, routeLabelsOf, type JupiterCallResult, type JupiterQuote } from "./jupiter";
import { coSignFee } from "./usdcMintFee";
import { compactRemovalSteps, planRebalance, type PlanAsset, type PlannedLeg } from "./rebalancePlan";

/** A leg that would lose more than this against SSR's prices is not built (thin route, bad quote). */
export const REBALANCE_MAX_LOSS_FRACTION = 0.05;
/** Jupiter slippage for a rebalance swap. The program additionally enforces the quote's minimum. */
export const REBALANCE_SLIPPAGE_BPS = 100;
/** Account budgets tried for a leg's route, so begin + route + end fit one transaction. */
const LEG_MAX_ACCOUNTS = [28, 18];
const MAX_LEGS = 12;
const LEG_COMPUTE_UNITS = 1_000_000;

export interface BuildRebalanceInput {
  reserve: PublicKey;
  signer: PublicKey;
  /** Every asset the Reserve should hold afterwards plus every current asset (0 to drop it), with its target. Existing assets keep their on-chain order; new ones are appended in this order. */
  targets: { mint: string; targetBps: number }[];
}

export interface BuildRebalanceDeps extends ReadDeps {
  fetchPrices(mints: string[]): Promise<Map<string, { usdPrice: number | null | undefined }>>;
  feeQuoteSigner: Keypair | null;
  jupiterQuote(p: { inputMint: string; outputMint: string; amount: bigint; slippageBps: number; maxAccounts: number | null }): Promise<JupiterCallResult<JupiterQuote>>;
  jupiterInstructions(quote: JupiterQuote, userPublicKey: string): Promise<JupiterCallResult<{ setupInstructions: JupiterInstructionJson[]; swapInstruction: JupiterInstructionJson; addressLookupTableAddresses: string[] }>>;
  simulate?: (tx: VersionedTransaction) => Promise<{ err: unknown; logs: string[] | null }>;
}

export interface BuiltRebalanceTx {
  kind: "targets" | "swap" | "cleanup";
  base64: string;
  bytes: number;
  lastValidBlockHeight: number;
  sellMint?: string;
  buyMint?: string;
  amountInRaw?: string;
  minOutRaw?: string;
  expectedOutRaw?: string;
  usd?: number;
  route?: string[];
  /** Mints the cleanup transaction removes. */
  removes?: string[];
  /** Index of the swap this one relies on (the first half of a route via a hub); sent only if that one confirmed. */
  dependsOn?: number;
  /** Hub asset a two-step swap goes through. */
  via?: string;
}

export interface BuildRebalanceResult {
  transactions: BuiltRebalanceTx[];
  totalUsd: number;
  rows: { mint: string; valueUsd: number; targetUsd: number; targetBps: number }[];
  /** Legs that could not be built, with the reason -- the rest still go ahead. */
  skipped: { sellMint: string; buyMint: string; reason: string }[];
}

export async function buildRebalanceTransactions(deps: BuildRebalanceDeps, input: BuildRebalanceInput): Promise<BuildRebalanceResult> {
  if (!deps.feeQuoteSigner) throw new BuildError(503, "Rebalancing is temporarily unavailable: SSR's quote signer is not configured on this deployment. Nothing was submitted.");
  const quoteSigner = deps.feeQuoteSigner;
  const { connection, program, ssrProgramId } = deps;
  const total = input.targets.reduce((s, t) => s + t.targetBps, 0);
  if (total !== 10_000) throw new BuildError(400, `Target weights must add up to exactly 100% (they add up to ${(total / 100).toFixed(2)}%). Nothing was submitted.`);
  if (new Set(input.targets.map((t) => t.mint)).size !== input.targets.length) throw new BuildError(400, "Each asset can be listed once. Nothing was submitted.");

  const targetMints = input.targets.map((t) => new PublicKey(t.mint));
  const read = await readReserveAndWallet(deps, input.reserve, input.signer, targetMints);
  const reserveAccount = read.reserveAccount;
  if (!("active" in (reserveAccount.status ?? {}))) throw new BuildError(409, "Only an active Reserve can be rebalanced (this one is paused, winding down or not seeded yet). Nothing was submitted.");
  const existing = read.orderedAssets; // on-chain order
  const existingSet = new Set(existing.map((a) => a.mint));
  const newTargets = input.targets.filter((t) => !existingSet.has(t.mint));

  // New assets: decimals and token program from the mint, refused if the
  // program cannot hold them (same check as Create Reserve, DEC-0205).
  const newInfos = newTargets.length ? await connection.getMultipleAccountsInfo(newTargets.map((t) => new PublicKey(t.mint))) : [];
  const newMeta = newTargets.map((t, i) => {
    const info = newInfos[i];
    if (!info) throw new BuildError(400, `${t.mint} is not a token on Mainnet. Nothing was submitted.`);
    const compat = assessMintAccount(new PublicKey(t.mint), info as never);
    if (!compat.supported) throw new BuildError(422, `${describeIncompatibleAsset(t.mint, compat)} Nothing was submitted.`);
    const tokenProgram = info.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
    return { mint: t.mint, decimals: info.data[44], tokenProgram };
  });

  // Final order: existing (on-chain order) then new, exactly what update_targets needs.
  const finalOrder = [...existing.map((a) => a.mint), ...newMeta.map((m) => m.mint)];
  const programOf = new Map<string, PublicKey>([
    ...existing.map((a) => [a.mint, new PublicKey(a.tokenProgram ?? TOKEN_PROGRAM_ID.toBase58())] as const),
    ...newMeta.map((m) => [m.mint, m.tokenProgram] as const),
  ]);
  const decimalsOf = new Map<string, number>([...existing.map((a) => [a.mint, a.decimals] as const), ...newMeta.map((m) => [m.mint, m.decimals] as const)]);
  const targetOf = new Map(input.targets.map((t) => [t.mint, t.targetBps]));

  const onChainTargets = (await program.account.reserveAsset.fetchMultiple(existing.map((a) => findReserveAsset(input.reserve, new PublicKey(a.mint), ssrProgramId)[0]))) as ({ targetWeightBps: number } | null)[];
  const targetsChange = newMeta.length > 0 || existing.some((a, i) => Number(onChainTargets[i]?.targetWeightBps ?? -1) !== targetOf.get(a.mint));

  const priceMap = await deps.fetchPrices(finalOrder.filter((m) => m !== MAINNET_USDC_MINT)).catch(() => new Map<string, { usdPrice: number | null | undefined }>());
  const priceOf = (m: string): number | null => (m === MAINNET_USDC_MINT ? 1 : (priceMap.get(m)?.usdPrice ?? null) || null);
  const planAssets: PlanAsset[] = finalOrder.map((m) => ({
    mint: m,
    decimals: decimalsOf.get(m)!,
    balanceRaw: BigInt(existing.find((a) => a.mint === m)?.vaultBalanceRaw ?? "0"),
    priceUsd: priceOf(m),
    targetBps: targetOf.get(m)!,
  }));
  const plan = planRebalance(planAssets);
  if (plan.unpriced.length > 0) throw new BuildError(422, `No live price for ${plan.unpriced.join(", ")}, so a fair swap amount cannot be worked out. Try again in a minute. Nothing was submitted.`);
  if (plan.legs.length > MAX_LEGS) throw new BuildError(422, `This rebalance needs ${plan.legs.length} swaps; at most ${MAX_LEGS} fit one approval. Change fewer weights at once. Nothing was submitted.`);

  const [delegate] = findDelegate(input.reserve, input.signer, ssrProgramId);
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const out: BuiltRebalanceTx[] = [];
  const skipped: BuildRebalanceResult["skipped"] = [];
  const cu = (units: number) => [ComputeBudgetProgram.setComputeUnitLimit({ units }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: SINGLE_TX_MICRO_LAMPORTS_PER_CU })];

  // 1. Targets.
  if (targetsChange) {
    const ixs: TransactionInstruction[] = [...cu(400_000)];
    for (const m of newMeta) ixs.push(await buildAddReserveAssetActiveInstruction(program, ssrProgramId, input.reserve, input.signer, delegate, new PublicKey(m.mint), 0, m.tokenProgram));
    ixs.push(await buildUpdateTargetsInstruction(program, ssrProgramId, input.reserve, input.signer, delegate, finalOrder.map((m) => new PublicKey(m)), finalOrder.map((m) => targetOf.get(m)!)));
    const tx = compileV0(input.signer, blockhash, ixs, []);
    out.push({ kind: "targets", ...toBase64(tx), lastValidBlockHeight });
  }

  // 2. One transaction per swap leg. A leg whose direct route will not fit one
  // transaction (typically a two-pool route into a thin token) goes through a
  // liquid hub the Reserve already holds instead: sell -> hub, then hub -> buy,
  // the second sent only if the first confirmed.
  const failedSells = new Set<string>();
  const legCtx = { delegate, quoteSigner, blockhash, lastValidBlockHeight, programOf, decimalsOf, priceOf, cu };
  const balanceOf = new Map(planAssets.map((a) => [a.mint, a.balanceRaw]));
  for (const leg of plan.legs) {
    try {
      out.push(await buildLeg(deps, input, leg, { ...legCtx, simulate: targetsChange ? undefined : deps.simulate }));
    } catch (e) {
      const directReason = e instanceof Error ? e.message : String(e);
      const viaHub = await buildViaHub(deps, input, leg, finalOrder, balanceOf, { ...legCtx, simulate: targetsChange ? undefined : deps.simulate }).catch(() => null);
      if (viaHub) {
        const first = out.length;
        out.push(viaHub[0], { ...viaHub[1], dependsOn: first });
      } else {
        skipped.push({ sellMint: leg.sellMint, buyMint: leg.buyMint, reason: directReason });
        failedSells.add(leg.sellMint);
      }
    }
  }

  // 3. Remove the assets the legs empty (never one whose sale was skipped).
  const removals = plan.removals.filter((m) => !failedSells.has(m));
  if (removals.length > 0) {
    const ixs: TransactionInstruction[] = [...cu(200_000)];
    for (const step of compactRemovalSteps(finalOrder, removals)) {
      ixs.push(
        await buildRemoveReserveAssetCompactInstruction(program, ssrProgramId, {
          reserve: input.reserve,
          reserveManager: new PublicKey(reserveAccount.manager),
          signer: input.signer,
          delegate,
          assetMint: new PublicKey(step.mint),
          assetTokenProgram: programOf.get(step.mint) ?? null,
          lastAssetMint: step.lastAssetMint ? new PublicKey(step.lastAssetMint) : null,
        }),
      );
    }
    out.push({ kind: "cleanup", ...toBase64(compileV0(input.signer, blockhash, ixs, [])), lastValidBlockHeight, removes: removals });
  }
  if (out.every((t) => t.kind !== "swap") && plan.legs.length > 0) {
    throw new BuildError(422, `None of the swaps could be built: ${skipped.map((s) => s.reason).join(" ")} Nothing was submitted.`);
  }
  return { transactions: out, totalUsd: plan.totalUsd, rows: plan.rows, skipped };
}

/** Liquid assets a leg may route through when its direct route does not fit; used only if the Reserve holds them. */
export const REBALANCE_HUB_MINTS = [MAINNET_USDC_MINT, "So11111111111111111111111111111111111111112"];

/**
 * sell -> hub, then hub -> buy, each its own atomic swap. The second sells no
 * more of the hub than the vault has now plus the first leg's guaranteed
 * minimum, so it never depends on more than the first one is sure to deliver.
 */
async function buildViaHub(
  deps: BuildRebalanceDeps,
  input: BuildRebalanceInput,
  leg: PlannedLeg,
  finalOrder: string[],
  balanceOf: Map<string, bigint>,
  ctx: Parameters<typeof buildLeg>[3],
): Promise<[BuiltRebalanceTx, BuiltRebalanceTx] | null> {
  for (const hub of REBALANCE_HUB_MINTS) {
    if (hub === leg.sellMint || hub === leg.buyMint || !finalOrder.includes(hub)) continue;
    const hubPrice = ctx.priceOf(hub);
    if (!hubPrice) continue;
    try {
      const first = await buildLeg(deps, input, { ...leg, buyMint: hub }, ctx);
      const fairHub = BigInt(Math.floor((leg.usd / hubPrice) * 10 ** ctx.decimalsOf.get(hub)!));
      const available = (balanceOf.get(hub) ?? 0n) + BigInt(first.minOutRaw!);
      const amountInRaw = fairHub < available ? fairHub : available;
      if (amountInRaw <= 0n) continue;
      const usd = (Number(amountInRaw) / 10 ** ctx.decimalsOf.get(hub)!) * hubPrice;
      // Not simulated: it relies on the first leg having landed.
      const second = await buildLeg(deps, input, { sellMint: hub, buyMint: leg.buyMint, amountInRaw, usd, sellsAll: false }, { ...ctx, simulate: undefined });
      return [{ ...first, via: hub }, { ...second, via: hub }];
    } catch {
      continue;
    }
  }
  return null;
}

async function buildLeg(
  deps: BuildRebalanceDeps,
  input: BuildRebalanceInput,
  leg: PlannedLeg,
  ctx: {
    delegate: PublicKey;
    quoteSigner: Keypair;
    blockhash: string;
    lastValidBlockHeight: number;
    programOf: Map<string, PublicKey>;
    decimalsOf: Map<string, number>;
    priceOf: (m: string) => number | null;
    cu: (units: number) => TransactionInstruction[];
    simulate?: (tx: VersionedTransaction) => Promise<{ err: unknown; logs: string[] | null }>;
  },
): Promise<BuiltRebalanceTx> {
  const sell = new PublicKey(leg.sellMint);
  const buy = new PublicKey(leg.buyMint);
  const sellProgram = ctx.programOf.get(leg.sellMint)!;
  const buyProgram = ctx.programOf.get(leg.buyMint)!;
  const signerSell = assetAta(sell, input.signer, sellProgram);
  const signerBuy = assetAta(buy, input.signer, buyProgram);
  // SSR's fair amount of the buy asset for this leg; the route must come within 5%.
  const fairOut = (leg.usd / (ctx.priceOf(leg.buyMint) as number)) * 10 ** ctx.decimalsOf.get(leg.buyMint)!;

  let lastReason = "";
  for (const maxAccounts of LEG_MAX_ACCOUNTS) {
    const q = await deps.jupiterQuote({ inputMint: leg.sellMint, outputMint: leg.buyMint, amount: leg.amountInRaw, slippageBps: REBALANCE_SLIPPAGE_BPS, maxAccounts });
    if (q.kind !== "ok") {
      lastReason = q.kind === "specific-error" ? `Jupiter found no route: ${q.message}.` : "Jupiter was busy; try again in a moment.";
      continue;
    }
    const quote = q.value;
    const expectedOut = BigInt(quote.outAmount);
    const minOut = BigInt(String(quote.otherAmountThreshold ?? quote.outAmount));
    if (Number(expectedOut) < fairOut * (1 - REBALANCE_MAX_LOSS_FRACTION)) {
      throw new Error(`The best route would lose more than ${REBALANCE_MAX_LOSS_FRACTION * 100}% against current prices (thin liquidity). This swap was left out.`);
    }
    const built = await deps.jupiterInstructions(quote, input.signer.toBase58());
    if (built.kind !== "ok") {
      lastReason = built.kind === "specific-error" ? `Jupiter could not build the swap: ${built.message}.` : "Jupiter was busy; try again in a moment.";
      continue;
    }
    const routeIxs = [...built.value.setupInstructions.map(deserializeJupiterInstruction).filter((ix) => !isComputeBudgetInstruction(ix)), deserializeJupiterInstruction(built.value.swapInstruction)];
    const ixs: TransactionInstruction[] = [
      ...ctx.cu(LEG_COMPUTE_UNITS),
      createAssociatedTokenAccountIdempotentInstruction(input.signer, signerSell, input.signer, sell, sellProgram),
      createAssociatedTokenAccountIdempotentInstruction(input.signer, signerBuy, input.signer, buy, buyProgram),
      await buildRebalanceSwapBeginInstruction(deps.program, deps.ssrProgramId, {
        reserve: input.reserve,
        signer: input.signer,
        delegate: ctx.delegate,
        mintSell: sell,
        mintBuy: buy,
        signerSellAccount: signerSell,
        signerBuyAccount: signerBuy,
        tokenProgramSell: sellProgram,
        feeQuoteSigner: ctx.quoteSigner.publicKey,
        amountIn: leg.amountInRaw,
        minOut,
      }),
      ...routeIxs,
      await buildRebalanceSwapEndInstruction(deps.program, deps.ssrProgramId, { reserve: input.reserve, signer: input.signer, mintBuy: buy, signerBuyAccount: signerBuy, tokenProgramBuy: buyProgram }),
    ];
    const tables: AddressLookupTableAccount[] = await fetchLookupTables(deps.connection, built.value.addressLookupTableAddresses);
    if (!fitsV0(input.signer, ixs, tables)) {
      lastReason = "The route is too large to fit one transaction with the rebalance steps.";
      continue;
    }
    const tx = compileV0(input.signer, ctx.blockhash, ixs, tables);
    if (ctx.simulate) {
      const sim = await ctx.simulate(tx).catch(() => null);
      if (sim && sim.err) {
        lastReason = `A read-only simulation of this swap failed (${JSON.stringify(sim.err)}).`;
        continue;
      }
    }
    coSignFee(tx, ctx.quoteSigner);
    return {
      kind: "swap",
      ...toBase64(tx),
      lastValidBlockHeight: ctx.lastValidBlockHeight,
      sellMint: leg.sellMint,
      buyMint: leg.buyMint,
      amountInRaw: leg.amountInRaw.toString(),
      minOutRaw: minOut.toString(),
      expectedOutRaw: expectedOut.toString(),
      usd: leg.usd,
      route: routeLabelsOf(quote),
    };
  }
  throw new Error(lastReason || "This swap could not be built.");
}

/**
 * Does the DEPLOYED program have rebalance_swap_end yet? Simulates the bare
 * instruction with no accounts: Anchor answers an unknown instruction with
 * InstructionFallbackNotFound (custom error 101) before it looks at accounts,
 * and a known one with an account error. Lets the app switch the real
 * rebalance on the moment the Mainnet upgrade executes, independent of which
 * frontend build is live (an env flag set on one project only is how three
 * Reserves launched nameless, DEC-0226).
 */
export async function isRebalanceSwapLive(simulate: (tx: VersionedTransaction) => Promise<{ err: unknown }>, payer: PublicKey, programId: PublicKey): Promise<boolean> {
  const { createHash } = await import("node:crypto");
  const data = createHash("sha256").update("global:rebalance_swap_end").digest().subarray(0, 8);
  const ix = new TransactionInstruction({ programId, keys: [], data: Buffer.from(data) });
  const tx = compileV0(payer, "11111111111111111111111111111111", [ix], []);
  const { err } = await simulate(tx);
  const text = JSON.stringify(err ?? null);
  return !/"Custom":101\b/.test(text);
}
