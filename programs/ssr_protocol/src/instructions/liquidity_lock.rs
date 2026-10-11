//! Per-tranche CPMM LP custody. No Reserve backing or creator-fee accounts are moved.
use anchor_lang::prelude::*;
use anchor_lang::solana_program::{instruction::{AccountMeta, Instruction}, program::invoke_signed};
use anchor_spl::{associated_token::{self,AssociatedToken},token::{self,Mint,Token,TokenAccount,Transfer}};
use crate::{constants::{PROTOCOL_CONFIG_SEED,RESERVE_SEED},state::{ProtocolConfig,Reserve},errors::SsrError};
use super::liquidity_revenue::{LiquidityRevenue,ROUTER_SEED,RAYDIUM,validate_pool};
pub const TRANCHE_SEED:&[u8]=b"liquidity_tranche";
pub const NATIVE_LOCK:Pubkey=pubkey!("LockrWmn6K5twhz3y9w1dQERbmgSaRkfnTeTKbpofwE");
pub const NATIVE_AUTH:Pubkey=pubkey!("3f7GcQFG397GAaEnv51zR6tsTVihYRydnydDD1cXekxH");
const METADATA:Pubkey=pubkey!("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
#[account]
pub struct LiquidityTranche {
 pub reserve:Pubkey,pub pool:Pubkey,pub lp_mint:Pubkey,pub creator:Pubkey,pub beneficiary:Pubkey,
 pub nonce:u64,pub unlock_ts:i64,pub permanent:bool,pub withdrawn:bool,pub bump:u8,
}
impl LiquidityTranche {pub const SPACE:usize=8+32*5+8+8+3;}
#[event]
pub struct LiquidityTrancheChanged {pub tranche:Pubkey,pub unlock_ts:i64,pub permanent:bool,pub withdrawn:bool,pub lp_amount:u64,}

#[derive(Accounts)]
#[instruction(nonce:u64)]
pub struct LockLiquidityTranche<'info>{
 #[account(seeds=[PROTOCOL_CONFIG_SEED],bump=protocol_config.bump)] pub protocol_config:Box<Account<'info,ProtocolConfig>>,
 #[account(seeds=[RESERVE_SEED,reserve.reserve_id.to_le_bytes().as_ref()],bump=reserve.bump,has_one=manager)] pub reserve:Box<Account<'info,Reserve>>,
 #[account(seeds=[ROUTER_SEED,reserve.key().as_ref()],bump=revenue.bump,constraint=revenue.pool==pool.key(),constraint=revenue.treasury==owner.key())] pub revenue:Box<Account<'info,LiquidityRevenue>>,
 pub manager:Signer<'info>,
 #[account(mut)] pub owner:Signer<'info>,
 /// CHECK: Raydium owner, layout, pair and creator verified in handler.
 pub pool:UncheckedAccount<'info>,
 pub lp_mint:Box<Account<'info,Mint>>,
 #[account(init,payer=owner,space=LiquidityTranche::SPACE,seeds=[TRANCHE_SEED,reserve.key().as_ref(),owner.key().as_ref(),nonce.to_le_bytes().as_ref()],bump)] pub tranche:Box<Account<'info,LiquidityTranche>>,
 #[account(mut,token::mint=lp_mint,token::authority=owner)] pub source:Box<Account<'info,TokenAccount>>,
 #[account(init,payer=owner,associated_token::mint=lp_mint,associated_token::authority=tranche)] pub escrow:Box<Account<'info,TokenAccount>>,
 pub token_program:Program<'info,Token>,pub associated_token_program:Program<'info,AssociatedToken>,pub system_program:Program<'info,System>,
}
fn event(t:&Account<LiquidityTranche>,amount:u64){emit!(LiquidityTrancheChanged{tranche:t.key(),unlock_ts:t.unlock_ts,permanent:t.permanent,withdrawn:t.withdrawn,lp_amount:amount});}
fn require_future(now:i64,unlock:i64)->Result<()> {require!(unlock>now,SsrError::LiquidityLockTermInvalid);Ok(())}
fn require_release(t:&LiquidityTranche,now:i64)->Result<()> {require!(!t.permanent&&!t.withdrawn&&now>=t.unlock_ts,SsrError::LiquidityPrincipalLocked);Ok(())}
pub fn deposit(ctx:Context<LockLiquidityTranche>,nonce:u64,amount:u64,unlock_ts:i64)->Result<()>{
 require!(!ctx.accounts.protocol_config.paused&&amount>0,SsrError::LiquidityLockTermInvalid);
 require_future(Clock::get()?.unix_timestamp,unlock_ts)?;
 validate_pool(&ctx.accounts.pool,ctx.accounts.reserve.reserve_token_mint,ctx.accounts.revenue.key())?;
 let expected=Pubkey::find_program_address(&[b"pool_lp_mint",ctx.accounts.pool.key().as_ref()],&RAYDIUM).0;
 require_keys_eq!(ctx.accounts.lp_mint.key(),expected,SsrError::LiquidityRevenueValidationFailed);
 let t=&mut ctx.accounts.tranche;
 t.set_inner(LiquidityTranche{reserve:ctx.accounts.reserve.key(),pool:ctx.accounts.pool.key(),lp_mint:expected,creator:ctx.accounts.manager.key(),beneficiary:ctx.accounts.owner.key(),nonce,unlock_ts,permanent:false,withdrawn:false,bump:ctx.bumps.tranche});
 token::transfer(CpiContext::new(ctx.accounts.token_program.key(),Transfer{from:ctx.accounts.source.to_account_info(),to:ctx.accounts.escrow.to_account_info(),authority:ctx.accounts.owner.to_account_info()}),amount)?;
 event(t,amount);Ok(())
}
#[derive(Accounts)]
pub struct ExtendLiquidityTranche<'info>{
 pub creator:Signer<'info>,pub owner:Signer<'info>,
 #[account(mut,seeds=[TRANCHE_SEED,tranche.reserve.as_ref(),tranche.beneficiary.as_ref(),tranche.nonce.to_le_bytes().as_ref()],bump=tranche.bump,constraint=tranche.creator==creator.key(),constraint=tranche.beneficiary==owner.key())] pub tranche:Box<Account<'info,LiquidityTranche>>,
}
pub fn extend(ctx:Context<ExtendLiquidityTranche>,unlock_ts:i64)->Result<()>{
 let t=&mut ctx.accounts.tranche;
 require!(!t.permanent&&!t.withdrawn&&unlock_ts>t.unlock_ts,SsrError::LiquidityLockTermInvalid);
 require_future(Clock::get()?.unix_timestamp,unlock_ts)?;t.unlock_ts=unlock_ts;event(t,0);Ok(())
}
#[derive(Accounts)]
pub struct WithdrawLiquidityTranche<'info>{
 pub owner:Signer<'info>,
 #[account(mut,seeds=[TRANCHE_SEED,tranche.reserve.as_ref(),tranche.beneficiary.as_ref(),tranche.nonce.to_le_bytes().as_ref()],bump=tranche.bump,constraint=tranche.beneficiary==owner.key())] pub tranche:Box<Account<'info,LiquidityTranche>>,
 #[account(mut,constraint=escrow.key()==associated_token::get_associated_token_address(&tranche.key(),&tranche.lp_mint),constraint=escrow.owner==tranche.key(),constraint=escrow.mint==tranche.lp_mint)] pub escrow:Box<Account<'info,TokenAccount>>,
 #[account(mut,constraint=destination.owner==tranche.beneficiary,constraint=destination.mint==tranche.lp_mint)] pub destination:Box<Account<'info,TokenAccount>>,
 pub token_program:Program<'info,Token>,
}
pub fn withdraw(ctx:Context<WithdrawLiquidityTranche>)->Result<()>{
 let t=&mut ctx.accounts.tranche;require_release(t,Clock::get()?.unix_timestamp)?;
 let nonce=t.nonce.to_le_bytes();let bump=[t.bump];let seeds:&[&[u8]]=&[TRANCHE_SEED,t.reserve.as_ref(),t.beneficiary.as_ref(),&nonce,&bump];
 let amount=ctx.accounts.escrow.amount;
 token::transfer(CpiContext::new(ctx.accounts.token_program.key(),Transfer{from:ctx.accounts.escrow.to_account_info(),to:ctx.accounts.destination.to_account_info(),authority:t.to_account_info()}).with_signer(&[seeds]),amount)?;
 t.withdrawn=true;event(t,amount);Ok(())
}
#[derive(Accounts)]
pub struct MakeLiquidityTranchePermanent<'info>{
 #[account(seeds=[PROTOCOL_CONFIG_SEED],bump=protocol_config.bump)] pub protocol_config:Box<Account<'info,ProtocolConfig>>,
 pub creator:Signer<'info>,
 #[account(mut)] pub owner:Signer<'info>,
 #[account(mut,seeds=[TRANCHE_SEED,tranche.reserve.as_ref(),tranche.beneficiary.as_ref(),tranche.nonce.to_le_bytes().as_ref()],bump=tranche.bump,constraint=tranche.creator==creator.key(),constraint=tranche.beneficiary==owner.key())] pub tranche:Box<Account<'info,LiquidityTranche>>,
 #[account(mut,constraint=escrow.key()==associated_token::get_associated_token_address(&tranche.key(),&tranche.lp_mint),constraint=escrow.owner==tranche.key(),constraint=escrow.mint==tranche.lp_mint)] pub escrow:Box<Account<'info,TokenAccount>>,
 /// CHECK: fixed executable Raydium Burn & Earn program; no arbitrary CPI.
 #[account(address=NATIVE_LOCK,executable)] pub native_lock:UncheckedAccount<'info>,
}
pub fn permanent<'info>(ctx:Context<'info,MakeLiquidityTranchePermanent<'info>>)->Result<()>{
 require!(!ctx.accounts.protocol_config.paused,SsrError::ProtocolPaused);
 let t=&mut ctx.accounts.tranche;require!(!t.permanent&&!t.withdrawn&&ctx.accounts.escrow.amount>0,SsrError::LiquidityPrincipalLocked);
 let a=ctx.remaining_accounts;require!(a.len()==19,SsrError::LiquidityRevenueValidationFailed);
 let tranche_key=t.key();let (nft,nft_bump)=Pubkey::find_program_address(&[b"liquidity_fee_key",tranche_key.as_ref()],&crate::ID);
 let lock=Pubkey::find_program_address(&[b"locked_liquidity",nft.as_ref()],&NATIVE_LOCK).0;
 let nft_ata=associated_token::get_associated_token_address(&t.beneficiary,&nft);
 let lp_vault=associated_token::get_associated_token_address(&NATIVE_AUTH,&t.lp_mint);
 let metadata=Pubkey::find_program_address(&[b"metadata",METADATA.as_ref(),nft.as_ref()],&METADATA).0;
 for (i,key) in [(0,NATIVE_AUTH),(1,t.beneficiary),(2,tranche_key),(3,t.beneficiary),(4,nft),(5,nft_ata),(6,t.pool),(7,lock),(8,t.lp_mint),(9,ctx.accounts.escrow.key()),(10,lp_vault),(13,metadata),(14,pubkey!("SysvarRent111111111111111111111111111111111")),(15,anchor_lang::system_program::ID),(16,token::ID),(17,associated_token::ID),(18,METADATA)]{require_keys_eq!(a[i].key(),key,SsrError::LiquidityRevenueValidationFailed);}
 require_keys_eq!(*a[6].owner,RAYDIUM,SsrError::LiquidityRevenueValidationFailed);
 {let data=a[6].try_borrow_data()?;require!(data.len()==637,SsrError::LiquidityRevenueValidationFailed);for (i,offset) in [(11,72),(12,104)]{require_keys_eq!(a[i].key(),Pubkey::new_from_array(data[offset..offset+32].try_into().unwrap()),SsrError::LiquidityRevenueValidationFailed);}}
 let amount=ctx.accounts.escrow.amount;let mut data=vec![216,157,29,78,38,51,31,26];data.extend_from_slice(&amount.to_le_bytes());data.push(0); // no metadata creation; fee key remains a native SPL NFT
 let writable=[1,4,5,7,9,10,11,12,13];let metas=a.iter().enumerate().map(|(i,v)|{let signer=[1,2,4].contains(&i);if writable.contains(&i){AccountMeta::new(v.key(),signer)}else{AccountMeta::new_readonly(v.key(),signer)}}).collect();
 let nonce=t.nonce.to_le_bytes();let bump=[t.bump];let seeds:&[&[u8]]=&[TRANCHE_SEED,t.reserve.as_ref(),t.beneficiary.as_ref(),&nonce,&bump];let nft_b=[nft_bump];let nft_seeds:&[&[u8]]=&[b"liquidity_fee_key",tranche_key.as_ref(),&nft_b];
 let mut infos=a.to_vec();infos.push(ctx.accounts.native_lock.to_account_info());
 invoke_signed(&Instruction{program_id:NATIVE_LOCK,accounts:metas,data},&infos,&[seeds,nft_seeds])?;
 t.permanent=true;event(t,amount);Ok(())
}
#[cfg(test)]mod tests{use super::*;
 fn tranche()->LiquidityTranche{LiquidityTranche{reserve:Pubkey::new_unique(),pool:Pubkey::new_unique(),lp_mint:Pubkey::new_unique(),creator:Pubkey::new_unique(),beneficiary:Pubkey::new_unique(),nonce:1,unlock_ts:100,permanent:false,withdrawn:false,bump:1}}
 #[test]fn principal_is_locked_until_expiry(){let mut t=tranche();assert!(require_release(&t,99).is_err());assert!(require_release(&t,100).is_ok());t.permanent=true;assert!(require_release(&t,i64::MAX).is_err());t.permanent=false;t.withdrawn=true;assert!(require_release(&t,101).is_err());}
 #[test]fn lock_must_be_future(){assert!(require_future(100,100).is_err());assert!(require_future(100,99).is_err());assert!(require_future(100,101).is_ok());}
}
