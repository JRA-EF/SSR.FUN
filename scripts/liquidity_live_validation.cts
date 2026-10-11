/** Read-only evidence: no signing, transaction building or submission. */
import {Connection,PublicKey} from '@solana/web3.js';
import {buildReadOnlyProgram} from '@ssr/sdk';
import {TOKEN_2022_PROGRAM_ID} from '@solana/spl-token';
import {permissionAddress,verifyPermission,decodeConfig,SSR_CPMM_CONFIG} from '../src/merge/lib/liquidity/raydiumCpmm';
import {resolveRpcUrl,redactRpcSecrets} from '../api/mainnet/_lib/rpc';
import {writeFileSync} from 'node:fs';
async function main(){
const connection=new Connection(resolveRpcUrl(),{commitment:'confirmed',disableRetryOnRateLimit:true});
const report:any={observedAt:new Date().toISOString(),readOnly:true,credentialConfigured:!!process.env.JUPITER_API_KEY};
const attempt=async(name:string,fn:()=>Promise<unknown>)=>{try{report[name]=await fn();}catch(e){report[name]={available:false,reason:redactRpcSecrets(e instanceof Error?e.message:String(e))};}};
await attempt('raydium',async()=>{
 const result=await connection.getMultipleAccountsInfoAndContext([permissionAddress(),SSR_CPMM_CONFIG]);
 verifyPermission(result.value[0]);const c=decodeConfig(result.value[1]);
 return {slot:result.context.slot,permissionVerified:true,config9:c};
});
await attempt('reserves',async()=>{
 const program=buildReadOnlyProgram(connection) as any;
 const rows=await program.account.reserve.all();
 const mints=rows.map((r:any)=>new PublicKey(r.account.reserveTokenMint));
 const infos=await connection.getMultipleAccountsInfo(mints);
 return rows.map((r:any,i:number)=>({reserve:r.publicKey.toBase58(),mint:mints[i].toBase58(),assetCount:r.account.assetCount,token2022:infos[i]?.owner.equals(TOKEN_2022_PROGRAM_ID)??false}));
});
await attempt('jupiter',async()=>{
 const response=await fetch('https://api.jup.ag/swap/v1/quote?inputMint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&outputMint=So11111111111111111111111111111111111111112&amount=1000000&swapMode=ExactOut&slippageBps=50',{headers:process.env.JUPITER_API_KEY?{'x-api-key':process.env.JUPITER_API_KEY}:{},signal:AbortSignal.timeout(15000)});
 if(!response.ok)return{available:false,httpStatus:response.status};
 const q=await response.json() as any;
 return {available:true,swapMode:q.swapMode,inputMint:q.inputMint,outputMint:q.outputMint,inAmount:q.inAmount,outAmount:q.outAmount,maximumInput:q.otherAmountThreshold,contextSlot:q.contextSlot};
});
await attempt('basketChecks',async()=>{
 const program=buildReadOnlyProgram(connection) as any;
 const reserves=await program.account.reserve.all();
 const results=[];
 const headers=process.env.JUPITER_API_KEY?{'x-api-key':process.env.JUPITER_API_KEY}:{};
 const pause=()=>new Promise(resolve=>setTimeout(resolve,1200));
 for(const count of [1,5,10]){
  let chosen:any,registrations:any[],vaults:any[];
  for(const candidate of reserves.filter((r:any)=>r.account.assetCount===count&&r.account.status.active)){
   const rows=await program.account.reserveAsset.all([{dataSize:111},{memcmp:{offset:8,bytes:candidate.publicKey.toBase58()}}]);
   const balances=await connection.getMultipleAccountsInfo(rows.map((r:any)=>r.account.vault));
   if(rows.length===count&&balances.every((b:any)=>b&&b.data.length>=165&&b.data.readBigUInt64LE(64)>0n)){chosen=candidate;registrations=rows;vaults=balances;break;}
  }
  if(!chosen){results.push({assetCount:count,available:false,reason:'No active fully funded deployed composition with this asset count'});continue;}
  const mints=registrations.map((r:any)=>r.account.assetMint.toBase58());
  await pause();
  const priceResponse=await fetch('https://api.jup.ag/price/v3?ids='+mints.join(','),{headers,signal:AbortSignal.timeout(15000)});
  if(!priceResponse.ok){results.push({assetCount:count,available:false,priceStatus:priceResponse.status});continue;}
  const prices=await priceResponse.json() as any;
  const legs=registrations.map((r:any,i:number)=>({mint:mints[i],decimals:r.account.decimals,balance:vaults[i]?.data.readBigUInt64LE(64)??0n,price:mints[i]==='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'?1:prices[mints[i]]?.usdPrice}));
  if(legs.some((l:any)=>!l.price)){results.push({assetCount:count,available:false,reason:'Missing current constituent valuation'});continue;}
  const value=legs.reduce((n:number,l:any)=>n+Number(l.balance)/10**l.decimals*l.price,0);
  if(!Number.isFinite(value)||value<=0){results.push({assetCount:count,available:false,reason:'Invalid basket valuation'});continue;}
  const checks=[];
  for(const leg of legs){
   const target=BigInt(Math.floor(Number(leg.balance)*1000/value));
   const get=async(mode:string,input:string,output:string)=>{
    if(input===output)return{available:true,inAmount:target.toString(),outAmount:target.toString(),otherAmountThreshold:target.toString()};
    await pause();
    const response=await fetch('https://api.jup.ag/swap/v1/quote?inputMint='+input+'&outputMint='+output+'&amount='+target+'&swapMode='+mode+'&slippageBps=50',{headers,signal:AbortSignal.timeout(15000)});
    if(!response.ok)return{available:false,status:response.status};
    const q=await response.json() as any;return{available:true,inAmount:q.inAmount,outAmount:q.outAmount,otherAmountThreshold:q.otherAmountThreshold,slot:q.contextSlot};
   };
   const usdc='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
   checks.push({mint:leg.mint,targetRaw:target.toString(),mintFunding:await get('ExactOut',usdc,leg.mint),redemptionExecution:await get('ExactIn',leg.mint,usdc)});
  }
  results.push({assetCount:count,notionalUsdc:1000,compositionSource:chosen.publicKey.toBase58(),newTokenEndToEndTest:false,legs:checks});
 }
 return results;
});
const output=JSON.stringify(report,(_k,v)=>typeof v==='bigint'?v.toString():v,2);
writeFileSync('/tmp/ssr-liquidity-live-validation.json',output);console.log(JSON.stringify({observedAt:report.observedAt,raydium:report.raydium,reserveCount:Array.isArray(report.reserves)?report.reserves.length:0,eligibleToken2022Reserves:Array.isArray(report.reserves)?report.reserves.filter((r:any)=>r.token2022).length:null,jupiter:report.jupiter,basketChecks:report.basketChecks},(_k,v)=>typeof v==='bigint'?v.toString():v,2));

}
main().catch(()=>{console.error("Read-only validation failed");process.exitCode=1;});
