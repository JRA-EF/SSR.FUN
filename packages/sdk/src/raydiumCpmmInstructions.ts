/** Native Raydium CPMM instructions, cp-swap b3187ae. No signing/submission. */
import {PublicKey,TransactionInstruction,type AccountMeta} from '@solana/web3.js';
import {TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID,getAssociatedTokenAddressSync} from '@solana/spl-token';
export const CPMM_PROGRAM=new PublicKey('CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C');
export interface CpmmAccounts {pool:PublicKey;mint0:PublicKey;mint1:PublicKey;vault0:PublicKey;vault1:PublicKey;program0:PublicKey;program1:PublicKey;}
const meta=(pubkey:PublicKey,isWritable=false,isSigner=false):AccountMeta=>({pubkey,isWritable,isSigner});
const pda=(seed:string,pool?:PublicKey)=>PublicKey.findProgramAddressSync([Buffer.from(seed),...(pool?[pool.toBuffer()]:[])],CPMM_PROGRAM)[0];
export const cpmmAuthority=()=>pda('vault_and_lp_mint_auth_seed');
export const cpmmLpMint=(pool:PublicKey)=>pda('pool_lp_mint',pool);
function amount(value:bigint){if(value<0n||value>0xffffffffffffffffn)throw new Error('Invalid liquidity amount');const b=Buffer.alloc(8);b.writeBigUInt64LE(value);return b;}
function liquidityKeys(a:CpmmAccounts,owner:PublicKey){return[meta(owner,false,true),meta(cpmmAuthority()),meta(a.pool,true),
 meta(getAssociatedTokenAddressSync(cpmmLpMint(a.pool),owner,true),true),
 meta(getAssociatedTokenAddressSync(a.mint0,owner,true,a.program0),true),meta(getAssociatedTokenAddressSync(a.mint1,owner,true,a.program1),true),
 meta(a.vault0,true),meta(a.vault1,true),meta(TOKEN_PROGRAM_ID),meta(TOKEN_2022_PROGRAM_ID),meta(a.mint0),meta(a.mint1),meta(cpmmLpMint(a.pool),true)];}
export function buildCpmmDeposit(a:CpmmAccounts,owner:PublicKey,lpAmount:bigint,maximum0:bigint,maximum1:bigint){
 if(lpAmount<=0n||maximum0<=0n||maximum1<=0n)throw new Error('Balanced liquidity and positive LP output are required');
 return new TransactionInstruction({programId:CPMM_PROGRAM,keys:liquidityKeys(a,owner),data:Buffer.concat([Buffer.from([242,35,198,137,82,225,242,182]),amount(lpAmount),amount(maximum0),amount(maximum1)])});
}
export function buildCpmmWithdraw(a:CpmmAccounts,owner:PublicKey,lpAmount:bigint,minimum0:bigint,minimum1:bigint){
 if(lpAmount<=0n||minimum0<=0n||minimum1<=0n)throw new Error('Withdrawal minima must be positive');
 return new TransactionInstruction({programId:CPMM_PROGRAM,keys:[...liquidityKeys(a,owner),meta(new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'))],data:Buffer.concat([Buffer.from([183,18,70,156,148,109,161,34]),amount(lpAmount),amount(minimum0),amount(minimum1)])});
}
export function cpmmSwapAccounts(a:CpmmAccounts,owner:PublicKey,config:PublicKey,inputMint:PublicKey):AccountMeta[]{
 const zero=inputMint.equals(a.mint0);if(!zero&&!inputMint.equals(a.mint1))throw new Error('Input mint is not in this pool');
 return [meta(owner,false,true),meta(cpmmAuthority()),meta(config),meta(a.pool,true),
 meta(getAssociatedTokenAddressSync(inputMint,owner,true,zero?a.program0:a.program1),true),
 meta(getAssociatedTokenAddressSync(zero?a.mint1:a.mint0,owner,true,zero?a.program1:a.program0),true),
 meta(zero?a.vault0:a.vault1,true),meta(zero?a.vault1:a.vault0,true),meta(zero?a.program0:a.program1),meta(zero?a.program1:a.program0),
 meta(inputMint),meta(zero?a.mint1:a.mint0),meta(pda('observation',a.pool),true)];
}
