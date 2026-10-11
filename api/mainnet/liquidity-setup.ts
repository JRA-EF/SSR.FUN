import {Connection,PublicKey} from '@solana/web3.js';
import {buildReadOnlyProgram} from '@ssr/sdk';
import {type ApiRequest,type ApiResponse,parseJsonBody} from '../devnet/_lib/apiTypes';
import {checkRateWindow} from '../devnet/_lib/rateLimit';
import {resolveRpcUrl,redactRpcSecrets} from './_lib/rpc';
import {prepareLiquiditySetup} from '../../lib/mainnet/liquiditySetup';
export default async function handler(req:ApiRequest,res:ApiResponse & {setHeader?(name:string,value:string):void}){
 res.setHeader?.('Cache-Control','no-store');if(req.method!=='POST'){res.status(405).json({error:'Method not allowed'});return;}
 const f=req.headers['x-forwarded-for'],ip=(Array.isArray(f)?f[0]:f??'unknown').split(',')[0].trim();if(!checkRateWindow(`liquidity-setup:${ip}`,60000,8)){res.status(429).json({error:'Please wait before another setup request.'});return;}
 let input;
 try{const b:any=parseJsonBody(req);if(!Array.isArray(b?.addresses)||b.addresses.length>128||typeof b.maximumSolRaw!=='string'||!/^\d{1,10}$/.test(b.maximumSolRaw)||BigInt(b.maximumSolRaw)<=0n||BigInt(b.maximumSolRaw)>1000000000n)throw new Error('Invalid transaction setup');input={reserve:new PublicKey(b.reserve),actor:new PublicKey(b.actor),addresses:b.addresses.map((a:any)=>new PublicKey(a)),table:b.table?new PublicKey(b.table):undefined,maximumSolRaw:BigInt(b.maximumSolRaw)};}catch(e){res.status(400).json({error:e instanceof Error?e.message:'Invalid request'});return;}
 try{const connection=new Connection(resolveRpcUrl(),'confirmed');const result=await prepareLiquiditySetup({connection,program:buildReadOnlyProgram(connection) as any,programId:new PublicKey('8hTW7fHwn8t8hcgTVeyAhHMiCTHGUP3783NWUTBBFwH9'),executionEnabled:false},input);res.status(200).json(result);}catch(e){res.status(422).json({error:redactRpcSecrets(e instanceof Error?e.message:String(e)),executionEnabled:false});}
}
