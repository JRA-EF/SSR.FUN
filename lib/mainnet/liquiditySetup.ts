import {PublicKey,AddressLookupTableProgram,type TransactionInstruction} from '@solana/web3.js';
import type {CompoundReadDeps} from './compoundQuotes';
import {readLiquidityState} from './liquidityLifecycle';
import {simulateLiquidityTransaction} from './prepareCompound';
/** At most 20 addresses per reviewed setup transaction. Retry reads the actual
 * table first, so landed setup stages are never repeated or treated as deposits. */
export async function prepareLiquiditySetup(deps:CompoundReadDeps & {executionEnabled:boolean},p:{reserve:PublicKey;actor:PublicKey;addresses:PublicKey[];table?:PublicKey;maximumSolRaw:bigint}){
 const s=await readLiquidityState(deps,p.reserve),addresses=[...new Map([p.reserve,...p.addresses].map(k=>[k.toBase58(),k])).values()];
 if(addresses.length>128||!PublicKey.isOnCurve(p.actor.toBytes()))throw new Error('Invalid transaction setup');
 const instructions:TransactionInstruction[]=[];let table=p.table,existing:PublicKey[]=[];
 if(table){const info=await deps.connection.getAccountInfo(table,'confirmed');if(info){if(!info.owner.equals(AddressLookupTableProgram.programId))throw new Error('Setup account is not an address table');const read=await deps.connection.getAddressLookupTable(table,{commitment:'confirmed'});if(!read.value?.isActive()||!read.value.state.authority?.equals(p.actor))throw new Error('Connect the wallet that created this transaction setup');existing=read.value.state.addresses;}else table=undefined;}
 if(!table){const recentSlot=await deps.connection.getSlot('finalized');const created=AddressLookupTableProgram.createLookupTable({authority:p.actor,payer:p.actor,recentSlot});instructions.push(created[0]);table=created[1];}
 const remaining=addresses.filter(k=>!existing.some(v=>v.equals(k)));
 if(!remaining.length)return {complete:true as const,table:table.toBase58(),remaining:0};
 if(existing.length+remaining.length>256)throw new Error('Address table has insufficient capacity');
 instructions.push(AddressLookupTableProgram.extendLookupTable({lookupTable:table,authority:p.actor,payer:p.actor,addresses:remaining.slice(0,20)}));
 const now=deps.now??Date.now,prepared=await simulateLiquidityTransaction({connection:deps.connection,instructions,treasury:s.treasury,creator:p.actor,feePayer:p.actor,action:'setup',reserve:p.reserve,pool:s.pool,expiresAtMs:now()+25000,executionEnabled:deps.executionEnabled,maximumSol:p.maximumSolRaw,now});
 return {complete:false as const,table:table.toBase58(),remaining:Math.max(0,remaining.length-20),prepared};
}
