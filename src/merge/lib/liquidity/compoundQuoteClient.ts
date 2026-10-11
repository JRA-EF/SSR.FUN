/** Browser entry point for read-only Compound comparisons. Credentials remain
 * on the server. This never invokes a wallet or enables spending. */
import { validateCompoundContext, validateCompoundQuote,
  type CompoundComparison, type CompoundQuote, type CompoundContext } from '@ssr/sdk';
export interface LiveCompoundRequest {
  reserve:string;pool:string;creator:string;lpDestination:string;
  budgetUsdcRaw:bigint;slippageBps:number;lockPolicyId:'unlocked'|'1-month'|'3-month'|'6-month'|'12-month'|'permanent';
}
const AMOUNTS=['acquisitionUsdcRaw','depositUsdcRaw','leftoverUsdcRaw','acquiredReserveRaw',
  'depositReserveGrossRaw','depositReserveNetRaw','leftoverReserveRaw','expectedLpRaw',
  'minimumLpRaw','maximumSolCostRaw'] as const;
function integer(v:unknown):bigint {
  if(typeof v!=='string'||!/^\d{1,20}$/.test(v))throw new Error('Invalid live quote amount');
  return BigInt(v);
}
export function decodeLiveCompoundResponse(wire:any,request:LiveCompoundRequest,nowMs=Date.now()):CompoundComparison {
  if(wire?.executionReady!==false||!wire.comparison)throw new Error('Invalid Compound quote response');
  const c=wire.comparison;
  const context:CompoundContext={...c.context,budgetUsdcRaw:integer(c.context?.budgetUsdcRaw)};
  validateCompoundContext(context);
  for(const key of ['reserve','pool','creator','lpDestination','slippageBps','lockPolicyId'] as const)
    if(context[key]!==request[key])throw new Error('Compound quote destination or policy changed');
  if(context.budgetUsdcRaw!==request.budgetUsdcRaw)throw new Error('Compound earnings budget changed');
  if(!Array.isArray(c.quotes)||c.quotes.length>2)throw new Error('Invalid Compound routes');
  const quotes:CompoundQuote[]=c.quotes.map((q:any)=>{
    if(!Array.isArray(q.costs)||q.costs.length>20)throw new Error('Invalid Compound costs');
    const decoded={...q,context:{...q.context,budgetUsdcRaw:integer(q.context?.budgetUsdcRaw)},
      costs:q.costs.map((cost:any)=>Object.freeze({...cost,amountRaw:integer(cost.amountRaw)}))};
    for(const name of AMOUNTS)decoded[name]=integer(q[name]);
    validateCompoundQuote(decoded,context,nowMs);
    return Object.freeze({...decoded,context:Object.freeze(context),costs:Object.freeze(decoded.costs)});
  });
  if(new Set(quotes.map(q=>q.route)).size!==quotes.length)throw new Error('Duplicate Compound route');
  if(c.recommended!==null&&!quotes.some(q=>q.route===c.recommended))throw new Error('Invalid Compound suggestion');
  return Object.freeze({context:Object.freeze(context),quotes:Object.freeze(quotes),recommended:c.recommended,
    unavailable:Object.freeze(Object.fromEntries((['mint','pool'] as const).flatMap(route=>typeof c.unavailable?.[route]==='string'?[[route,c.unavailable[route]]]:[])))});
}
export async function fetchLiveCompoundQuotes(request:LiveCompoundRequest,signal?:AbortSignal):Promise<CompoundComparison> {
  const response=await fetch('/api/mainnet/compound-quotes',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({...request,budgetUsdcRaw:request.budgetUsdcRaw.toString()}),signal,cache:'no-store'});
  const wire=await response.json();
  if(!response.ok)throw new Error(typeof wire?.error==='string'?wire.error:'Compound quotes are unavailable');
  return decodeLiveCompoundResponse(wire,request);
}

export interface LiveCompoundBundle {comparison:CompoundComparison;acquisitionPlans:Record<string,unknown>;}
/** Preserve the reviewed provider plan for exact-route preparation. */
export async function fetchLiveCompoundBundle(request:LiveCompoundRequest,signal?:AbortSignal):Promise<LiveCompoundBundle> {
  const response=await fetch('/api/mainnet/compound-quotes',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify(request,(_key,v)=>typeof v==='bigint'?v.toString():v),signal,cache:'no-store'});
  const wire=await response.json();
  if(!response.ok)throw new Error(typeof wire?.error==='string'?wire.error:'Compound quotes are unavailable');
  const comparison=decodeLiveCompoundResponse(wire,request);
  const acquisitionPlans=Object.fromEntries(comparison.quotes.map(q=>{
    const plan=wire.acquisitionPlans?.[q.planFingerprint];
    if(!plan||typeof plan!=='object')throw new Error('Compound acquisition plan is missing');
    return [q.planFingerprint,plan];
  }));
  return {comparison,acquisitionPlans};
}
