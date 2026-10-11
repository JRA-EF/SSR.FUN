import {LiquidityLookupRequired} from '../../lib/mainnet/liquidityLookup';
/** Build + simulate an unsigned atomic transaction. No server signing/submission. */
import {Connection,PublicKey} from '@solana/web3.js';
import {buildReadOnlyProgram,assertCompoundApproval} from '@ssr/sdk';
import {type ApiRequest,type ApiResponse,parseJsonBody} from '../devnet/_lib/apiTypes';
import {checkRateWindow} from '../devnet/_lib/rateLimit';
import {resolveRpcUrl,redactRpcSecrets} from './_lib/rpc';
import {parseCompoundQuoteRequest} from './compound-quotes';
import {decodeLiveCompoundResponse} from '../../src/merge/lib/liquidity/compoundQuoteClient';
import {prepareCompound,type CompoundPlanInput} from '../../lib/mainnet/prepareCompound';

export function parsePrepareCompound(body:any,now=Date.now()):CompoundPlanInput {
  if(JSON.stringify(body).length>250_000)throw new Error('Compound plan is too large');
  if(!body?.quote?.context||!body.approval||!body.acquisitionPlan)throw new Error('A selected route and creator approval are required');
  const parsed=parseCompoundQuoteRequest(body.quote.context);
  const request={...parsed,reserve:parsed.reserve.toBase58(),pool:parsed.pool.toBase58(),creator:parsed.creator.toBase58(),lpDestination:parsed.lpDestination.toBase58()};
  const comparison=decodeLiveCompoundResponse({executionReady:false,comparison:{context:body.quote.context,quotes:[body.quote],recommended:null}},request,now);
  const quote=comparison.quotes[0];
  assertCompoundApproval(quote,body.approval,comparison.context,request.creator,now);
  // Only scalar amounts consumed by construction are decoded; Jupiter's quote
  // remains its original wire shape and is independently checked before use.
  const acquisitionPlan={...body.acquisitionPlan};
  for(const field of quote.route==='pool'?['amount']:['gross']){
    const raw=acquisitionPlan[field];
    if(typeof raw!=='string'||!/^\d{1,20}$/.test(raw)||BigInt(raw)>0xffffffffffffffffn)throw new Error('Invalid acquisition plan');
    acquisitionPlan[field]=BigInt(raw);
  }
  const lookupTables=body.lookupTables??[];if(!Array.isArray(lookupTables)||lookupTables.length>4)throw new Error('Invalid lookup tables');
  return {quote,approval:body.approval,acquisitionPlan,lookupTables:lookupTables.map((k:any)=>new PublicKey(k))};
}
export default async function handler(req:ApiRequest,res:ApiResponse & {setHeader?(name:string,value:string):void}) {
  res.setHeader?.('Cache-Control','no-store');
  if(req.method!=='POST'){res.status(405).json({error:'Method not allowed'});return;}
  const forwarded=req.headers['x-forwarded-for'];
  const ip=(Array.isArray(forwarded)?forwarded[0]:forwarded??'unknown').split(',')[0].trim();
  if(!checkRateWindow(`prepare-compound:${ip}`,60_000,4)){res.status(429).json({error:'Please wait before preparing another route.'});return;}
  let input;
  try{input=parsePrepareCompound(parseJsonBody(req));}catch(e){res.status(400).json({error:e instanceof Error?e.message:'Invalid request'});return;}
  try{
    const connection=new Connection(resolveRpcUrl(),'confirmed');
    const prepared=await prepareCompound({connection,program:buildReadOnlyProgram(connection) as any,
      programId:new PublicKey('8hTW7fHwn8t8hcgTVeyAhHMiCTHGUP3783NWUTBBFwH9'),jupiterApiKey:process.env.JUPITER_API_KEY,
      // Deliberately not env-toggleable before the program/runtime release gate.
      executionEnabled:false},input);
    res.status(200).json(prepared);
  }catch(e){if(e instanceof LiquidityLookupRequired){res.status(422).json({error:e.message,code:e.code,addresses:e.addresses,executionEnabled:false});return;}res.status(422).json({error:redactRpcSecrets(e instanceof Error?e.message:String(e)),executionEnabled:false});}
}
