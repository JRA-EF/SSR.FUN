import {AddressLookupTableAccount,AddressLookupTableProgram,type Connection,type PublicKey,type TransactionInstruction} from '@solana/web3.js';
export class LiquidityLookupRequired extends Error{
 readonly code='LIQUIDITY_LOOKUP_REQUIRED';readonly addresses:string[];
 constructor(instructions:TransactionInstruction[],reserve:PublicKey){super('One-time transaction setup is required to keep this operation atomic. No liquidity funds were moved.');this.addresses=[...new Set([reserve.toBase58(),...instructions.flatMap(ix=>ix.keys.filter(k=>!k.isSigner).map(k=>k.pubkey.toBase58()))])];}
}
export async function loadLiquidityTables(connection:Connection,reserve:PublicKey,addresses:PublicKey[]=[]){
 if(addresses.length>4||new Set(addresses.map(a=>a.toBase58())).size!==addresses.length)throw new Error('Invalid liquidity lookup tables');
 if(!addresses.length)return [];
 const result=await connection.getMultipleAccountsInfoAndContext(addresses,{commitment:'confirmed'});
 // A saved table that was never created (its setup transaction was signed but never landed, e.g. an expired review)
 // is skipped, not fatal: if the operation still does not fit, the caller asks for setup again and a new table is made.
 return result.value.flatMap((a,i)=>a?[[a,i] as const]:[]).map(([a,i])=>{if(!a.owner.equals(AddressLookupTableProgram.programId))throw new Error('Liquidity lookup table unavailable');const table=new AddressLookupTableAccount({key:addresses[i],state:AddressLookupTableAccount.deserialize(a.data)});if(!table.isActive()||!table.state.addresses.some(k=>k.equals(reserve))||table.state.lastExtendedSlot>=result.context.slot)throw new Error('Liquidity lookup table is inactive or still warming up');return table;});
}
