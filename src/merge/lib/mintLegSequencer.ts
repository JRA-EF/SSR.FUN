// DEC-0294: send each swap leg of a many-asset mint while its blockhash is
// still young, instead of signing everything first and broadcasting late.
//
// Why. A batch mint (lib/mainnet/buildBuy.ts "batch" mode) is N Jupiter swap
// legs + the mint, all stamped with ONE blockhash (~150 blocks, 60-90 s). A
// wallet without signAllTransactions approves them one by one; at 5-10 s per
// approval a 10-asset Reserve (#26, beta report 2026-11-17) took 1-2 minutes
// before anything was sent, so the later legs expired and nothing minted. A
// wallet WITH signAllTransactions can hit the same wall when the user leaves
// the single prompt open for a minute.
//
// What this does. Legs are independent (each is its own USDC -> asset swap),
// so each one is broadcast the moment it is signed. Before every signature,
// and again right after it, the leg's blockhash is checked against the live
// block height: a leg too close to expiry is never sent dead -- the legs not
// yet sent are rebuilt with a fresh blockhash (legsOnly) and signed again.
// Rebuilds wait for the legs already in flight to settle first, so the
// purchase's acquired amounts are recorded and the server's funding plan
// does not count in-flight legs as still unfunded.
//
// Pure orchestration over injected effects (sign, send, block height,
// rebuild), so the sequencing is unit-tested without a wallet or an RPC.

/** Before asking the wallet to sign a leg, at least this many block heights must remain: ~30 s at 400 ms/block covers a slow approval (5-10 s) plus the broadcast, with room to spare. */
export const LEG_SIGN_MARGIN_BLOCKS = 75;
/** After the wallet signed, at least this many block heights must remain to send it: ~8 s, enough for the first broadcasts (re-sent every 3 s) to land. Below this the leg is rebuilt instead of being sent to expire. */
export const LEG_SEND_MARGIN_BLOCKS = 20;
/** Fresh-blockhash rebuilds of the unsent legs per round before the remaining legs are sent as they are (an expired leg then goes through the normal retry path). 10 legs at ~10 s each need about two. */
export const MAX_LEG_REBUILDS = 4;

/** Pure: true when a transaction with this lastValidBlockHeight should not be signed/sent at `heightNow` with `margin` blocks to spare. An unknown height (0) is never treated as stale -- sending is then still safe, the rebroadcast loop reports an expiry. */
export function isBlockhashStale(lastValidBlockHeight: number, heightNow: number, margin: number): boolean {
  if (!(heightNow > 0) || !(lastValidBlockHeight > 0)) return false;
  return heightNow > lastValidBlockHeight - margin;
}

/** Pure: splits legs into those still fresh enough at `heightNow` and those that must be rebuilt. Order is kept. */
export function partitionByFreshness<T extends { lastValidBlockHeight: number }>(legs: T[], heightNow: number, margin: number): { fresh: T[]; stale: T[] } {
  const fresh: T[] = [];
  const stale: T[] = [];
  for (const l of legs) (isBlockhashStale(l.lastValidBlockHeight, heightNow, margin) ? stale : fresh).push(l);
  return { fresh, stale };
}

export interface SequencedLeg<S> {
  mint: string;
  lastValidBlockHeight: number;
  /** Already signed (the wallet's one sign-all prompt); otherwise the sequencer asks for a signature. */
  presigned?: S;
}

export interface LegSequencerDeps<L extends SequencedLeg<S>, S> {
  /** true: sign every pending leg in one prompt (signAllTransactions); false: one leg per prompt, each sent as soon as it is signed. */
  signAllAtOnce: boolean;
  /** Live block height; 0 when unknown. */
  blockHeight(): Promise<number>;
  /** Signs exactly these legs, in order (one wallet prompt when signAllAtOnce, else called with a single leg). */
  sign(legs: L[]): Promise<S[]>;
  /** Broadcasts one signed leg and resolves/rejects with its final outcome. `index` is its position among legs sent this round (for staggering). */
  send(leg: L, signed: S, index: number): Promise<void>;
  /** Rebuilds these legs with a fresh blockhash (unsigned). A leg the server no longer needs may be left out. */
  rebuild(mints: string[]): Promise<L[]>;
  signMarginBlocks?: number;
  sendMarginBlocks?: number;
  maxRebuilds?: number;
  log?: (msg: string, data?: Record<string, unknown>) => void;
}

export interface LegSequencerResult<L> {
  /** Every leg that was sent, in send order, with its settled outcome (same shape partitionSwapOutcomes takes). */
  legs: L[];
  outcomes: PromiseSettledResult<void>[];
  rebuilds: number;
}

/**
 * Signs and sends swap legs so no leg is broadcast with a blockhash that is
 * already (nearly) dead. Resolves once every sent leg has settled; never
 * rejects for a leg's own failure (those are in `outcomes`), only when
 * signing or rebuilding itself fails.
 */
export async function signAndSendLegs<L extends SequencedLeg<S>, S>(initial: L[], deps: LegSequencerDeps<L, S>): Promise<LegSequencerResult<L>> {
  const signMargin = deps.signMarginBlocks ?? LEG_SIGN_MARGIN_BLOCKS;
  const sendMargin = deps.sendMarginBlocks ?? LEG_SEND_MARGIN_BLOCKS;
  const maxRebuilds = deps.maxRebuilds ?? MAX_LEG_REBUILDS;
  const sentLegs: L[] = [];
  const inFlight: Promise<PromiseSettledResult<void>>[] = [];
  let rebuilds = 0;
  let queue = initial.slice();

  const dispatch = (leg: L, signed: S) => {
    const index = sentLegs.length;
    sentLegs.push(leg);
    inFlight.push(
      deps.send(leg, signed, index).then(
        (): PromiseSettledResult<void> => ({ status: "fulfilled", value: undefined }),
        (reason): PromiseSettledResult<void> => ({ status: "rejected", reason }),
      ),
    );
  };
  const rebuildQueue = async (reason: string) => {
    rebuilds++;
    // Let every leg already sent settle first: its delivered amount is then
    // recorded, so the rebuild plans only what is still missing.
    await Promise.all(inFlight);
    const mints = queue.map((l) => l.mint);
    deps.log?.("swap leg blockhash too old -- rebuilding the legs not sent yet with a fresh blockhash", { reason, mints, rebuild: rebuilds });
    queue = await deps.rebuild(mints);
  };

  while (queue.length > 0) {
    const chunk = deps.signAllAtOnce ? queue.slice() : queue.slice(0, 1);
    const canRebuild = rebuilds < maxRebuilds;

    const needSigning = chunk.filter((l) => l.presigned === undefined);
    if (needSigning.length > 0 && canRebuild) {
      const h = await deps.blockHeight();
      if (needSigning.some((l) => isBlockhashStale(l.lastValidBlockHeight, h, signMargin))) {
        await rebuildQueue("before signing");
        continue;
      }
    }
    const signedFresh = needSigning.length > 0 ? await deps.sign(needSigning) : [];
    let k = 0;
    const signedChunk = chunk.map((l) => (l.presigned !== undefined ? l.presigned : signedFresh[k++]));

    const h = canRebuild ? await deps.blockHeight() : 0;
    const unsent: L[] = [];
    chunk.forEach((leg, i) => {
      if (canRebuild && isBlockhashStale(leg.lastValidBlockHeight, h, sendMargin)) unsent.push(leg);
      else dispatch(leg, signedChunk[i]);
    });
    queue = [...unsent, ...queue.slice(chunk.length)];
    if (unsent.length > 0) await rebuildQueue("after signing");
  }

  const outcomes = await Promise.all(inFlight);
  return { legs: sentLegs, outcomes, rebuilds };
}
