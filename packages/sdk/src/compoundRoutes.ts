/** Compound acquisition policy (DEC-0233). Quote providers must return live,
 * complete plans; this module neither fabricates quotes nor signs transactions. */
export type CompoundRoute = 'mint' | 'pool';
export type CompoundCostKind = 'mintFee' | 'basketExecution' | 'poolTradeFee' |
  'projectTax' | 'transferFee' | 'priceImpact' | 'networkFee' | 'accountRent';
export interface CompoundCost {
  kind: CompoundCostKind;
  unit: 'USDC' | 'ReserveToken' | 'SOL';
  /** Raw units in the stated currency; informational, already included in the plan. */
  amountRaw: bigint;
}
export interface CompoundContext {
  creator: string;
  reserve: string;
  pool: string;
  reserveMint: string;
  lpMint: string;
  /** Creator's net earnings only, after SSR/Raydium distribution. */
  budgetUsdcRaw: bigint;
  snapshotSlot: number;
  /** Account/pricing snapshot digest; must be checked against fresh reads before signing. */
  stateFingerprint: string;
  slippageBps: number;
  /** Bind destination and lock policy; never redirect LP tokens to a service. */
  lpDestination: string;
  lockPolicyId: string;
}
export interface CompoundQuote {
  id: string;
  route: CompoundRoute;
  context: CompoundContext;
  quotedAtMs: number;
  expiresAtMs: number;
  /** Identifies the account snapshot and exact provider plan used to build transactions. */
  planFingerprint: string;
  acquisitionUsdcRaw: bigint;
  depositUsdcRaw: bigint;
  leftoverUsdcRaw: bigint;
  acquiredReserveRaw: bigint;
  depositReserveGrossRaw: bigint;
  /** After the Reserve Token transfer fee on the deposit. */
  depositReserveNetRaw: bigint;
  leftoverReserveRaw: bigint;
  expectedLpRaw: bigint;
  minimumLpRaw: bigint;
  /** Total extra SOL budget, including network fee and newly required accounts. */
  maximumSolCostRaw: bigint;
  costs: readonly CompoundCost[];
}
export type CompoundQuoteProvider = (context: Readonly<CompoundContext>) => Promise<CompoundQuote>;
export interface CompoundComparison {
  context: CompoundContext;
  quotes: readonly CompoundQuote[];
  unavailable: Partial<Record<CompoundRoute, string>>;
  /** Suggestion only. The creator must explicitly choose a route. */
  recommended: CompoundRoute | null;
}
export interface CompoundApproval {
  creator: string;
  route: CompoundRoute;
  quoteBinding: string;
}
const MAX_QUOTE_AGE_MS = 30_000;
function requireValid(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function stable(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => typeof v === 'bigint' ? v.toString() : v);
}
function contextKey(c: CompoundContext): string {
  return stable([c.creator,c.reserve,c.pool,c.reserveMint,c.lpMint,c.budgetUsdcRaw,
    c.snapshotSlot,c.stateFingerprint,c.slippageBps,c.lpDestination,c.lockPolicyId]);
}
export function validateCompoundContext(c: CompoundContext): void {
  requireValid([c.creator,c.reserve,c.pool,c.reserveMint,c.lpMint,c.lpDestination,c.lockPolicyId,c.stateFingerprint].every(s => typeof s === 'string' && s.length > 0), 'Compound destinations and lock policy are required');
  requireValid(typeof c.budgetUsdcRaw === 'bigint' && c.budgetUsdcRaw > 0n && c.budgetUsdcRaw <= 0xffffffffffffffffn, 'No creator earnings available to compound');
  requireValid(Number.isSafeInteger(c.snapshotSlot) && c.snapshotSlot >= 0, 'Invalid pool snapshot');
  requireValid(Number.isInteger(c.slippageBps) && c.slippageBps >= 0 && c.slippageBps <= 1000, 'Invalid Compound slippage');
}
export function validateCompoundQuote(q: CompoundQuote, context: CompoundContext, nowMs: number): void {
  validateCompoundContext(context);
  requireValid(q.route === 'mint' || q.route === 'pool', 'Unknown Compound route');
  requireValid(contextKey(q.context) === contextKey(context), 'Compound quote context changed');
  requireValid(q.id.length > 0 && q.planFingerprint.length > 0, 'Compound quote is missing its execution plan');
  requireValid(Number.isSafeInteger(nowMs) && Number.isSafeInteger(q.quotedAtMs) && Number.isSafeInteger(q.expiresAtMs) &&
    q.quotedAtMs <= nowMs && q.expiresAtMs > nowMs && q.expiresAtMs > q.quotedAtMs &&
    q.expiresAtMs - q.quotedAtMs <= MAX_QUOTE_AGE_MS && nowMs - q.quotedAtMs <= MAX_QUOTE_AGE_MS, 'Compound quote expired; refresh both routes');
  const amounts = [q.acquisitionUsdcRaw,q.depositUsdcRaw,q.leftoverUsdcRaw,q.acquiredReserveRaw,
    q.depositReserveGrossRaw,q.depositReserveNetRaw,q.leftoverReserveRaw,q.expectedLpRaw,q.minimumLpRaw,q.maximumSolCostRaw];
  requireValid(amounts.every(n => typeof n === 'bigint' && n >= 0n && n <= 0xffffffffffffffffn), 'Invalid Compound quote amounts');
  requireValid(q.acquisitionUsdcRaw + q.depositUsdcRaw + q.leftoverUsdcRaw === context.budgetUsdcRaw, 'Compound quote does not conserve the earnings budget');
  requireValid(q.acquisitionUsdcRaw > 0n && q.depositUsdcRaw > 0n && q.depositReserveNetRaw > 0n, 'Compound requires balanced liquidity');
  requireValid(q.depositReserveGrossRaw + q.leftoverReserveRaw === q.acquiredReserveRaw &&
    q.depositReserveNetRaw <= q.depositReserveGrossRaw, 'Compound quote does not account for Reserve Token transfers');
  requireValid(q.minimumLpRaw > 0n && q.expectedLpRaw >= q.minimumLpRaw, 'Compound liquidity minimum is missing');
  requireValid(q.minimumLpRaw >= q.expectedLpRaw * BigInt(10_000-context.slippageBps) / 10_000n, 'Compound minimum allows more slippage than approved');
  const required: CompoundCostKind[] = q.route === 'mint' ?
    ['mintFee','basketExecution','transferFee','priceImpact','networkFee','accountRent'] :
    ['poolTradeFee','projectTax','transferFee','priceImpact','networkFee','accountRent'];
  requireValid(required.every(kind => q.costs.some(c => c.kind === kind)), 'Compound cost breakdown is incomplete');
  const kinds: CompoundCostKind[] = ['mintFee','basketExecution','poolTradeFee','projectTax','transferFee','priceImpact','networkFee','accountRent'];
  requireValid(q.costs.every(c => kinds.includes(c.kind) && ['USDC','ReserveToken','SOL'].includes(c.unit) &&
    typeof c.amountRaw === 'bigint' && c.amountRaw >= 0n && c.amountRaw <= 0xffffffffffffffffn), 'Invalid Compound costs');
  const solCosts = q.costs.filter(c => c.unit === 'SOL').reduce((n,c) => n+c.amountRaw,0n);
  requireValid(solCosts <= q.maximumSolCostRaw, 'Compound SOL cost exceeds the approval budget');
}
/** Fetch both strategies for the same earnings, account snapshot, destinations
 * and lock policy. Each provider solves its own balanced allocation; never
 * assume half the USDC buys exactly the Reserve Token side. */
export async function compareCompoundRoutes(context: CompoundContext,
  providers: Record<CompoundRoute, CompoundQuoteProvider>, now: () => number = Date.now): Promise<CompoundComparison> {
  validateCompoundContext(context);
  const fixed = Object.freeze({...context});
  const routes: CompoundRoute[] = ['mint','pool'];
  const results = await Promise.allSettled(routes.map(route => Promise.resolve().then(() => providers[route](fixed))));
  const quotes: CompoundQuote[] = [];
  const unavailable: CompoundComparison['unavailable'] = {};
  const checkedAt = now();
  results.forEach((result,i) => {
    const route = routes[i];
    try {
      if (result.status === 'rejected') throw result.reason;
      requireValid(result.value.route === route, 'Quote provider returned the wrong route');
      validateCompoundQuote(result.value,fixed,checkedAt);
      // Own immutable copies: a provider must not mutate a displayed/approved quote later.
      quotes.push(Object.freeze({...result.value, context:fixed,
        costs:Object.freeze(result.value.costs.map(c => Object.freeze({...c})))}));
    } catch(error) {
      unavailable[route] = error instanceof Error ? error.message : 'Quote unavailable';
    }
  });
  // LP units are comparable only in the same pool/LP mint. Prefer minimum
  // guaranteed LP received; use expected LP only as a tie-break, then SOL cost.
  const ranked = [...quotes].sort((a,b) => {
    for(const [x,y] of [[a.minimumLpRaw,b.minimumLpRaw],[a.expectedLpRaw,b.expectedLpRaw]]) {
      if(x!==y) return x>y ? -1 : 1;
    }
    return a.maximumSolCostRaw === b.maximumSolCostRaw ? 0 : a.maximumSolCostRaw < b.maximumSolCostRaw ? -1 : 1;
  });
  return Object.freeze({context:fixed,quotes:Object.freeze(quotes),unavailable:Object.freeze(unavailable),recommended:ranked[0]?.route ?? null});
}
/** Content binding, not a wallet signature. The actual creator must still sign
 * the simulated transaction(s); backend execution must enforce this policy. */
function quoteBinding(q: CompoundQuote): string {
  return stable([contextKey(q.context),q.id,q.route,q.quotedAtMs,q.expiresAtMs,q.planFingerprint,
    q.acquisitionUsdcRaw,q.depositUsdcRaw,q.leftoverUsdcRaw,q.acquiredReserveRaw,
    q.depositReserveGrossRaw,q.depositReserveNetRaw,q.leftoverReserveRaw,q.expectedLpRaw,
    q.minimumLpRaw,q.maximumSolCostRaw,q.costs.map(c => [c.kind,c.unit,c.amountRaw])]);
}
export function approveCompoundRoute(comparison: CompoundComparison, route: CompoundRoute,
  connectedCreator: string, nowMs = Date.now()): CompoundApproval {
  requireValid(connectedCreator === comparison.context.creator, 'Only the creator can approve Compound');
  const quote = comparison.quotes.find(q => q.route === route);
  requireValid(!!quote, 'Selected Compound route is unavailable');
  validateCompoundQuote(quote,comparison.context,nowMs);
  return Object.freeze({creator:connectedCreator,route,quoteBinding:quoteBinding(quote)});
}
/** Run immediately before preparing/signing. A new quote, destination, cost,
 * minimum, allocation or lock policy requires a new explicit approval. */
export function assertCompoundApproval(quote: CompoundQuote, approval: CompoundApproval,
  liveContext: CompoundContext, connectedCreator: string, nowMs = Date.now()): void {
  validateCompoundQuote(quote,liveContext,nowMs);
  requireValid(connectedCreator === liveContext.creator && approval.creator === connectedCreator,
    'Creator wallet changed; approve Compound again');
  requireValid(approval.route === quote.route && approval.quoteBinding === quoteBinding(quote),
    'Compound plan changed; approve the selected route again');
}
