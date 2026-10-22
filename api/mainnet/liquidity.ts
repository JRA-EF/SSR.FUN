import {prepareCreateLiquidity,isLiquidityTermsV2Live,isLiquiditySplitLive} from '../../lib/mainnet/createLiquidity';
import {SSR_POOL_PAYER} from '../../src/merge/lib/liquidity/raydiumCpmm';
import {loadPoolPayer,coSignPoolPayer,PoolPayerUnavailable} from '../../lib/mainnet/poolPayer';
import {LIQUIDITY_EXECUTION_ENABLED} from '../../lib/mainnet/liquidityRelease';
import {fetchJupiterPrices} from './asset-prices';
import {LiquidityLookupRequired} from '../../lib/mainnet/liquidityLookup';
import {Connection,PublicKey} from '@solana/web3.js';
import {buildReadOnlyProgram,findLiquidityTranche} from '@ssr/sdk';
import {getAssociatedTokenAddressSync,unpackAccount,TOKEN_PROGRAM_ID} from '@solana/spl-token';
import {type ApiRequest,type ApiResponse,parseJsonBody} from '../devnet/_lib/apiTypes';
import {checkRateWindow} from '../devnet/_lib/rateLimit';
import {resolveRpcUrl,redactRpcSecrets} from './_lib/rpc';
import {prepareLiquidityLifecycle,readLiquidityState,type LifecycleInput,type TrancheChoice} from '../../lib/mainnet/liquidityLifecycle';
const actions=['create','add','withdraw','collect','lock','extend','unlock','permanent'];
const locks=['unlocked','1-month','3-month','6-month','12-month','permanent'];
function amount(v:unknown,required=false){if(v===undefined&&!required)return undefined;if(typeof v!=='string'||!/^\d{1,20}$/.test(v)||BigInt(v)>0xffffffffffffffffn)throw new Error('Invalid raw token amount');return BigInt(v);}
export function parseLifecycleRequest(body:any):LifecycleInput & {buyTaxBps:number;sellTaxBps:number;holderShareBps:number;poolShareBps:number}{
 if(!body||JSON.stringify(body).length>4000||!actions.includes(body.action))throw new Error('Invalid liquidity action');
 const lock=body.lock??'unlocked',slippageBps=body.slippageBps??50;
 if(!locks.includes(lock)||!Number.isInteger(slippageBps)||slippageBps<0||slippageBps>100)throw new Error('Invalid lock or slippage');
 const maximumSolRaw=amount(body.maximumSolRaw,true)!;if(maximumSolRaw<=0n||maximumSolRaw>1_000_000_000n)throw new Error('Choose a positive SOL cost cap of at most one SOL');
 const unlockTs=amount(body.unlockTs);if(unlockTs!==undefined&&unlockTs>0x7fffffffffffffffn)throw new Error('Invalid lock expiry');
 const buyTaxBps=body.buyTaxBps??0,sellTaxBps=body.sellTaxBps??0;for(const bps of [buyTaxBps,sellTaxBps])if(!Number.isInteger(bps)||bps<0||bps>200)throw new Error('Project tax must be between zero and two percent');
 // DEC-0251: share of the creator's pool earnings fed to holders, chosen once at pool creation.
 const holderShareBps=body.holderShareBps??0;if(!Number.isInteger(holderShareBps)||holderShareBps<0||holderShareBps>10000)throw new Error('Holder share must be between zero and one hundred percent');
 // DEC-0255: share of that holder share added to the pool as locked liquidity, also chosen once at pool creation.
 const poolShareBps=body.poolShareBps??0;if(!Number.isInteger(poolShareBps)||poolShareBps<0||poolShareBps>10000)throw new Error('Pool share must be between zero and one hundred percent');
 if(poolShareBps>0&&holderShareBps===0)throw new Error('Adding holder earnings to the pool needs a holder share');
 const lookupTables=body.lookupTables??[];if(!Array.isArray(lookupTables)||lookupTables.length>4)throw new Error('Invalid lookup tables');
 return {buyTaxBps,sellTaxBps,holderShareBps,poolShareBps,lookupTables:lookupTables.map((k:any)=>new PublicKey(k)),action:body.action,reserve:new PublicKey(body.reserve),actor:new PublicKey(body.actor),maximumSolRaw,maximumUsdcRaw:amount(body.maximumUsdcRaw),maximumReserveRaw:amount(body.maximumReserveRaw),lpAmountRaw:amount(body.lpAmountRaw),slippageBps,lock:lock as TrancheChoice,tranche:body.tranche?new PublicKey(body.tranche):undefined,unlockTs};
}
export default async function handler(req:ApiRequest,res:ApiResponse & {setHeader?(name:string,value:string):void}){
 res.setHeader?.('Cache-Control','no-store');if(req.method!=='POST'){res.status(405).json({error:'Method not allowed'});return;}
 const forwarded=req.headers['x-forwarded-for'],ip=(Array.isArray(forwarded)?forwarded[0]:forwarded??'unknown').split(',')[0].trim();
 if(!checkRateWindow(`liquidity:${ip}`,60000,8)){res.status(429).json({error:'Please wait before refreshing liquidity.'});return;}
 let body:any,input:ReturnType<typeof parseLifecycleRequest>|undefined,reserve:PublicKey;
 try{body=parseJsonBody(req);if(body?.action==='read')reserve=new PublicKey(body.reserve);else {input=parseLifecycleRequest(body);reserve=input.reserve;}}catch(e){res.status(400).json({error:e instanceof Error?e.message:'Invalid request'});return;}
 try{
  const connection=new Connection(resolveRpcUrl(),'confirmed'),deps={connection,program:buildReadOnlyProgram(connection) as any,programId:new PublicKey('8hTW7fHwn8t8hcgTVeyAhHMiCTHGUP3783NWUTBBFwH9'),executionEnabled:LIQUIDITY_EXECUTION_ENABLED};
  let result:any;
  if(!input){const s=await readLiquidityState(deps,reserve);
   const rows=await connection.getProgramAccounts(deps.programId,{commitment:'confirmed',filters:[{dataSize:187},{memcmp:{offset:8,bytes:reserve.toBase58()}}]});
   const tranches=rows.map(row=>{const t=deps.program.coder.accounts.decode('liquidityTranche',row.account.data);if(!new PublicKey(t.pool).equals(s.pool)||!new PublicKey(t.beneficiary).equals(s.treasury)||!findLiquidityTranche(reserve,s.treasury,BigInt(t.nonce.toString()),deps.programId).equals(row.pubkey))throw new Error('Invalid liquidity tranche');return {address:row.pubkey.toBase58(),unlockTs:t.unlockTs.toString(),permanent:t.permanent,withdrawn:t.withdrawn};});
   // Each lock holds its LP in an escrow owned by the tranche PDA; permanent locks have moved theirs into Raydium's lock.
   const escrows=tranches.map(t=>getAssociatedTokenAddressSync(s.lp,new PublicKey(t.address),true,TOKEN_PROGRAM_ID)),escrowInfos=escrows.length?await connection.getMultipleAccountsInfo(escrows,'confirmed'):[];
   const lockedTranches=tranches.map((t,i)=>{const info=escrowInfos[i];if(!info)return {...t,lpRaw:'0'};const acc=unpackAccount(escrows[i],info,TOKEN_PROGRAM_ID);if(!acc.mint.equals(s.lp))throw new Error('Invalid liquidity escrow');return {...t,lpRaw:acc.amount.toString()};});
   result={tranches:lockedTranches,reserve:s.reserve,pool:s.pool,mint:s.mint,creator:s.creator,treasury:s.treasury,hasPool:!!s.registered,paused:s.paused,reserveDecimals:s.rt.decimals,lpDecimals:s.lpDecimals,usdcBalanceRaw:s.usdcBalance,reserveBalanceRaw:s.reserveBalance,lpBalanceRaw:s.lpBalance,nativeEarningsUsdcRaw:s.registered?.accruedUsdc??0n,stagedEarningsUsdcRaw:s.staged,poolUsdcRaw:s.usdc,poolReserveRaw:s.tokens,lpSupplyRaw:s.lpSupply,slot:s.slot,executionEnabled:LIQUIDITY_EXECUTION_ENABLED,
    // DEC-0251: the pool's permanent fee terms (v1 = created before liquidity terms v2).
    termsVersion:s.terms?2:s.registered?1:null,buyTaxBps:s.router?.buyTaxBps??null,sellTaxBps:s.router?.sellTaxBps??null,holderShareBps:s.terms?.holderShareBps??0,basketFeedUsdcRaw:s.feedBalance,basketFedUsdcRaw:s.terms?.totalFed??0n,
    // DEC-0255: the split (0 = all to backing) and what it has locked in the pool.
    poolShareBps:s.split?.poolShareBps??0,poolFedUsdcRaw:s.split?.poolFed??0n,poolLpLockedRaw:s.split?.lpLocked??0n,
    // Which terms a NEW pool would get right now (v1 until the DEC-0251 upgrade executes).
    termsV2Available:s.registered?undefined:await isLiquidityTermsV2Live(connection,SSR_POOL_PAYER,deps.programId).catch(()=>false),
    splitAvailable:s.registered?undefined:await isLiquiditySplitLive(connection,SSR_POOL_PAYER,deps.programId).catch(()=>false)};}
  else if(input.action==='create'){const payer=loadPoolPayer();const prepared=await prepareCreateLiquidity({...deps,prices:fetchJupiterPrices},{reserve:input.reserve,actor:input.actor,usdcRaw:input.maximumUsdcRaw??0n,maximumSolRaw:input.maximumSolRaw,buyTaxBps:input.buyTaxBps,sellTaxBps:input.sellTaxBps,holderShareBps:input.holderShareBps,poolShareBps:input.poolShareBps,lock:input.lock,lookupTables:input.lookupTables});
   result={...prepared,transactionBase64:coSignPoolPayer(prepared.transactionBase64,payer,BigInt(prepared.payerNetCostLamports))};}
  else result=await prepareLiquidityLifecycle(deps,input);
  res.status(200).json(JSON.parse(JSON.stringify(result,(_k,v)=>typeof v==='bigint'?v.toString():v)));
 }catch(e){if(e instanceof PoolPayerUnavailable){res.status(503).json({error:e.message,executionEnabled:false});return;}if(e instanceof LiquidityLookupRequired){res.status(422).json({error:e.message,code:e.code,addresses:e.addresses,executionEnabled:LIQUIDITY_EXECUTION_ENABLED});return;}res.status(422).json({error:redactRpcSecrets(e instanceof Error?e.message:String(e)),executionEnabled:LIQUIDITY_EXECUTION_ENABLED});}
}
