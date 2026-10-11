/** Shared per-addition lock construction; no signing or submission. */
import {randomBytes} from 'node:crypto';
import {type PublicKey,type TransactionInstruction} from '@solana/web3.js';
import {buildLockLiquidityTranche,buildMakeLiquidityTranchePermanent} from '@ssr/sdk';
import type {CompoundReadDeps} from './compoundQuotes';
const check=(ok:unknown,message:string):void=>{if(!ok)throw new Error(message);};
export interface TrancheState{reserve:PublicKey;pool:PublicKey;lp:PublicKey;creator:PublicKey;treasury:PublicKey;time:bigint;registered:{vault0:PublicKey;vault1:PublicKey}|null;}
export type TrancheChoice='unlocked'|'1-month'|'3-month'|'6-month'|'12-month'|'permanent';
const TERMS:Record<string,bigint>={'1-month':30n*86400n,'3-month':90n*86400n,'6-month':180n*86400n,'12-month':365n*86400n};
export async function appendTrancheLock(deps:CompoundReadDeps,s:TrancheState,instructions:TransactionInstruction[],amount:bigint,choice:TrancheChoice){
 if(choice==='unlocked')return null;
 check(choice==='permanent'||TERMS[choice]!==undefined,'Invalid lock term');
 const nonce=randomBytes(8).readBigUInt64LE(),unlockTs=s.time+(TERMS[choice]??3600n);
 const locked=await buildLockLiquidityTranche(deps.program as any,{reserve:s.reserve,pool:s.pool,lpMint:s.lp,creator:s.creator,owner:s.treasury,nonce,amount,unlockTs});instructions.push(locked.instruction);
 if(choice==='permanent')instructions.push(await buildMakeLiquidityTranchePermanent(deps.program as any,{tranche:locked.tranche,creator:s.creator,owner:s.treasury,pool:s.pool,lpMint:s.lp,vault0:s.registered!.vault0,vault1:s.registered!.vault1}));
 return {...locked,nonce,unlockTs,choice};
}
