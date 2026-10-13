/** Per-tranche LP custody and Raydium-native permanent conversion. No signing. */
import {PublicKey,SystemProgram,SYSVAR_RENT_PUBKEY,type AccountMeta} from '@solana/web3.js';
import {TOKEN_PROGRAM_ID,ASSOCIATED_TOKEN_PROGRAM_ID,getAssociatedTokenAddressSync} from '@solana/spl-token';
import {BN,type Program,type Idl} from '@anchor-lang/core';
import {findProtocolConfig} from './pda';
import {findLiquidityRevenue} from './liquidityRevenue';
export const RAYDIUM_LOCK_PROGRAM=new PublicKey('LockrWmn6K5twhz3y9w1dQERbmgSaRkfnTeTKbpofwE');
export const RAYDIUM_LOCK_AUTHORITY=new PublicKey('3f7GcQFG397GAaEnv51zR6tsTVihYRydnydDD1cXekxH');
const METADATA=new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
export function findLiquidityTranche(reserve:PublicKey,owner:PublicKey,nonce:bigint,programId:PublicKey){
 if(nonce<0n||nonce>0xffffffffffffffffn)throw new Error('Invalid tranche identifier');
 const data=Buffer.alloc(8);data.writeBigUInt64LE(nonce);
 return PublicKey.findProgramAddressSync([Buffer.from('liquidity_tranche'),reserve.toBuffer(),owner.toBuffer(),data],programId)[0];
}
export function nativeLockAddresses(tranche:PublicKey,owner:PublicKey,lpMint:PublicKey,programId:PublicKey){
 const nftMint=PublicKey.findProgramAddressSync([Buffer.from('liquidity_fee_key'),tranche.toBuffer()],programId)[0];
 return {nftMint,nftAccount:getAssociatedTokenAddressSync(nftMint,owner,true),lockPda:PublicKey.findProgramAddressSync([Buffer.from('locked_liquidity'),nftMint.toBuffer()],RAYDIUM_LOCK_PROGRAM)[0],lockLpVault:getAssociatedTokenAddressSync(lpMint,RAYDIUM_LOCK_AUTHORITY,true),metadata:PublicKey.findProgramAddressSync([Buffer.from('metadata'),METADATA.toBuffer(),nftMint.toBuffer()],METADATA)[0]};
}
export async function buildLockLiquidityTranche(program:Program<Idl>,p:{reserve:PublicKey;pool:PublicKey;lpMint:PublicKey;creator:PublicKey;owner:PublicKey;nonce:bigint;amount:bigint;unlockTs:bigint}){
 if(p.amount<=0n||p.amount>0xffffffffffffffffn||p.unlockTs<=0n||p.unlockTs>0x7fffffffffffffffn)throw new Error('Invalid lock amount or expiry');
 const tranche=findLiquidityTranche(p.reserve,p.owner,p.nonce,program.programId),escrow=getAssociatedTokenAddressSync(p.lpMint,tranche,true);
 const instruction=await program.methods.lockLiquidityTranche(new BN(p.nonce.toString()),new BN(p.amount.toString()),new BN(p.unlockTs.toString())).accounts({protocolConfig:findProtocolConfig(program.programId)[0],reserve:p.reserve,revenue:findLiquidityRevenue(p.reserve,program.programId),manager:p.creator,owner:p.owner,pool:p.pool,lpMint:p.lpMint,tranche,source:getAssociatedTokenAddressSync(p.lpMint,p.owner,true),escrow,tokenProgram:TOKEN_PROGRAM_ID,associatedTokenProgram:ASSOCIATED_TOKEN_PROGRAM_ID,systemProgram:SystemProgram.programId}).instruction();
 return {instruction,tranche,escrow};
}
export async function buildExtendLiquidityTranche(program:Program<Idl>,p:{tranche:PublicKey;creator:PublicKey;owner:PublicKey;unlockTs:bigint}){
 if(p.unlockTs<=0n||p.unlockTs>0x7fffffffffffffffn)throw new Error('Invalid lock expiry');
 return program.methods.extendLiquidityTranche(new BN(p.unlockTs.toString())).accounts({creator:p.creator,owner:p.owner,tranche:p.tranche}).instruction();
}
export async function buildWithdrawLiquidityTranche(program:Program<Idl>,p:{tranche:PublicKey;owner:PublicKey;lpMint:PublicKey}){
 return program.methods.withdrawLiquidityTranche().accounts({owner:p.owner,tranche:p.tranche,escrow:getAssociatedTokenAddressSync(p.lpMint,p.tranche,true),destination:getAssociatedTokenAddressSync(p.lpMint,p.owner,true),tokenProgram:TOKEN_PROGRAM_ID}).instruction();
}
export function nativePermanentLockAccounts(p:{tranche:PublicKey;owner:PublicKey;pool:PublicKey;lpMint:PublicKey;vault0:PublicKey;vault1:PublicKey;programId:PublicKey}):AccountMeta[]{
 const a=nativeLockAddresses(p.tranche,p.owner,p.lpMint,p.programId);
 const keys=[RAYDIUM_LOCK_AUTHORITY,p.owner,p.tranche,p.owner,a.nftMint,a.nftAccount,p.pool,a.lockPda,p.lpMint,getAssociatedTokenAddressSync(p.lpMint,p.tranche,true),a.lockLpVault,p.vault0,p.vault1,a.metadata,SYSVAR_RENT_PUBKEY,SystemProgram.programId,TOKEN_PROGRAM_ID,ASSOCIATED_TOKEN_PROGRAM_ID,METADATA];
 // Tranche + Fee Key mint are signed by SSR PDAs inside CPI, never by a service key.
 return keys.map((pubkey,i)=>({pubkey,isSigner:i===1,isWritable:[1,4,5,7,9,10,11,12,13].includes(i)}));
}
export async function buildMakeLiquidityTranchePermanent(program:Program<Idl>,p:{tranche:PublicKey;creator:PublicKey;owner:PublicKey;pool:PublicKey;lpMint:PublicKey;vault0:PublicKey;vault1:PublicKey}){
 return program.methods.makeLiquidityTranchePermanent().accounts({protocolConfig:findProtocolConfig(program.programId)[0],creator:p.creator,owner:p.owner,tranche:p.tranche,escrow:getAssociatedTokenAddressSync(p.lpMint,p.tranche,true),nativeLock:RAYDIUM_LOCK_PROGRAM}).remainingAccounts(nativePermanentLockAccounts({...p,programId:program.programId})).instruction();
}

export async function buildAuthorizeLiquidityAddition(program:Program<Idl>,p:{reserve:PublicKey;creator:PublicKey;owner:PublicKey}){
 return program.methods.authorizeLiquidityAddition().accounts({protocolConfig:findProtocolConfig(program.programId)[0],reserve:p.reserve,revenue:findLiquidityRevenue(p.reserve,program.programId),manager:p.creator,owner:p.owner}).instruction();
}
