/** Read-only route comparison. Never constructs, signs or submits a spend. */
import { Connection, PublicKey } from '@solana/web3.js';
import { buildReadOnlyProgram } from '@ssr/sdk';
import { type ApiRequest, type ApiResponse, parseJsonBody } from '../devnet/_lib/apiTypes';
import { checkRateWindow } from '../devnet/_lib/rateLimit';
import { resolveRpcUrl, redactRpcSecrets } from './_lib/rpc';
import { fetchJupiterPrices } from './asset-prices';
import { readCompoundSnapshot, compareLiveCompound } from '../../lib/mainnet/compoundQuotes';
import { serializeBuildResult } from '../../lib/mainnet/buildCommon';
import { BASE58_RE } from '../../lib/mainnet/jupiter';
import { LIQUIDITY_USDC } from '../../src/merge/lib/liquidity/raydiumCpmm';

const PROGRAM_ID=new PublicKey('8hTW7fHwn8t8hcgTVeyAhHMiCTHGUP3783NWUTBBFwH9');
export function parseCompoundQuoteRequest(body:Record<string,unknown>) {
  const address=(name:string)=>{if(typeof body[name]!=='string'||!BASE58_RE.test(body[name] as string))throw new Error(`${name} is required`);return new PublicKey(body[name] as string);};
  if(typeof body.budgetUsdcRaw!=='string'||!/^\d{1,20}$/.test(body.budgetUsdcRaw))throw new Error('Invalid earnings budget');
  const budgetUsdcRaw=BigInt(body.budgetUsdcRaw);
  if(budgetUsdcRaw<=0n||budgetUsdcRaw>0xffffffffffffffffn)throw new Error('Invalid earnings budget');
  if(!Number.isInteger(body.slippageBps)||Number(body.slippageBps)<1||Number(body.slippageBps)>500)throw new Error('Slippage must be between 1 and 500 basis points');
  if(!['unlocked','1-month','3-month','6-month','12-month','permanent'].includes(String(body.lockPolicyId)))throw new Error('Invalid Compound lock term');
  return {reserve:address('reserve'),pool:address('pool'),creator:address('creator'),lpDestination:address('lpDestination'),budgetUsdcRaw,slippageBps:Number(body.slippageBps),lockPolicyId:body.lockPolicyId as 'unlocked'|'1-month'|'3-month'|'6-month'|'12-month'|'permanent'};
}
export default async function handler(req:ApiRequest,res:ApiResponse & {setHeader?(name:string,value:string):void}) {
  res.setHeader?.('Cache-Control','no-store');
  if(req.method!=='POST'){res.status(405).json({error:'Method not allowed'});return;}
  const forwarded=req.headers['x-forwarded-for'];
  const ip=(Array.isArray(forwarded)?forwarded[0]:forwarded??'unknown').split(',')[0].trim();
  if(!checkRateWindow(`mainnet-compound-quotes:${ip}`,60_000,4)){
    res.setHeader?.('Retry-After','15');res.status(429).json({error:'Please wait before refreshing both routes again.'});return;
  }
  let input;
  try{input=parseCompoundQuoteRequest(parseJsonBody(req));}catch(e){res.status(400).json({error:e instanceof Error?e.message:'Invalid quote request'});return;}
  const connection=new Connection(resolveRpcUrl(),'confirmed');
  try {
    const snapshot=await readCompoundSnapshot({connection,program:buildReadOnlyProgram(connection) as any,programId:PROGRAM_ID},input);
    const mints=snapshot.assets.map(a=>a.mint).filter(m=>m!==LIQUIDITY_USDC.toBase58());
    // Use the official endpoint with an optional configured key. Service failures disable only mint.
    const prices=await fetchJupiterPrices(mints).catch(()=>new Map());
    const plans:Record<string,unknown>={};
    const comparison=await compareLiveCompound(snapshot,{jupiterApiKey:process.env.JUPITER_API_KEY??'',prices,recordPlan:(id,plan)=>{plans[id]=plan;}});
    const acquisitionPlans=Object.fromEntries(comparison.quotes.map(q=>[q.planFingerprint,plans[q.planFingerprint]]));
    res.status(200).json(serializeBuildResult({comparison,acquisitionPlans,executionReady:false,
      costBasis:'SOL amounts are planning caps; mint execution premium includes venue fees. Basket execution allowance reserves input slippage. Exact costs and fresh approval are required before spending.',
      allocationSearch:'Bounded primary-mint search; not a guarantee of the globally optimal route.',
      treasuryAuthorizationRequired:true}));
  } catch(e) {
    const message=redactRpcSecrets(e instanceof Error?e.message:String(e));
    res.status(422).json({error:message,executionReady:false});
  }
}
