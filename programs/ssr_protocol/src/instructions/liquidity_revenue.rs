//! Secondary-market revenue only. Never accesses Reserve backing vaults.
//! A pool's native creator must be this PDA, so direct Raydium collection
//! can only deposit into its USDC ATA; it cannot bypass the revenue split.
use anchor_lang::prelude::*;
use anchor_lang::solana_program::{instruction::{AccountMeta, Instruction}, program::invoke};
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use crate::{constants::{PROTOCOL_CONFIG_SEED, RESERVE_SEED}, state::{ProtocolConfig, Reserve}, errors::SsrError};

pub const ROUTER_SEED: &[u8] = b"liquidity_revenue";
pub const RAYDIUM: Pubkey = pubkey!("CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C");
pub const AMM_CONFIG: Pubkey = pubkey!("LNmHRmMvk9kmtepfTSr98kqGLThd61kH1DPWf2cVRaC");
pub const USDC: Pubkey = pubkey!("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

#[account]
pub struct LiquidityRevenue {
    pub reserve: Pubkey,
    pub pool: Pubkey,
    pub treasury: Pubkey,
    pub buy_tax_bps: u16,
    pub sell_tax_bps: u16,
    pub retained_rate: u64,
    /// Carry prevents splitting collections from evading SSR's share.
    pub remainder: u128,
    pub bump: u8,
}
impl LiquidityRevenue { pub const SPACE: usize = 8 + 32*3 + 2*2 + 8 + 16 + 1; }

#[event]
pub struct LiquidityRevenueDistributed {
    pub reserve: Pubkey, pub pool: Pubkey, pub protocol_usdc: u64, pub creator_usdc: u64,
}
#[event]
pub struct ProjectTaxCharged {
    pub reserve: Pubkey, pub pool: Pubkey, pub user: Pubkey, pub buy: bool,
    pub protocol_usdc: u64, pub creator_usdc: u64, pub net_output: u64,
}

#[derive(Accounts)]
pub struct ConfigureLiquidityRevenue<'info> {
    #[account(mut)] pub manager: Signer<'info>,
    #[account(seeds = [PROTOCOL_CONFIG_SEED], bump = protocol_config.bump)]
    pub protocol_config: Account<'info, ProtocolConfig>,
    #[account(seeds = [RESERVE_SEED, reserve.reserve_id.to_le_bytes().as_ref()], bump = reserve.bump,
        constraint = reserve.manager == manager.key() @ SsrError::LiquidityRevenueValidationFailed)]
    pub reserve: Account<'info, Reserve>,
    #[account(init, payer = manager, space = LiquidityRevenue::SPACE,
        seeds = [ROUTER_SEED, reserve.key().as_ref()], bump)]
    pub revenue: Account<'info, LiquidityRevenue>,
    /// CHECK: validated packed Raydium PoolState, including creator and pair.
    pub pool: UncheckedAccount<'info>,
    /// CHECK: validated fixed Raydium AmmConfig.
    #[account(address = AMM_CONFIG)] pub amm_config: UncheckedAccount<'info>,
    /// CHECK: validated canonical optional CreatorFeeShare PDA.
    pub creator_fee_share: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

fn key(data: &[u8], offset: usize) -> Pubkey { Pubkey::new_from_array(data[offset..offset+32].try_into().unwrap()) }
fn u64_at(data: &[u8], offset: usize) -> u64 { u64::from_le_bytes(data[offset..offset+8].try_into().unwrap()) }
fn validate_pool(pool: &AccountInfo, reserve_mint: Pubkey, revenue: Pubkey) -> Result<()> {
    require_keys_eq!(*pool.owner, RAYDIUM, SsrError::LiquidityRevenueValidationFailed);
    let d = pool.try_borrow_data()?;
    require!(d.len() == 637 && d[..8] == [247,237,227,245,215,195,222,70], SsrError::LiquidityRevenueValidationFailed);
    require_keys_eq!(key(&d,8), AMM_CONFIG, SsrError::LiquidityRevenueValidationFailed);
    require_keys_eq!(key(&d,40), revenue, SsrError::LiquidityRevenueValidationFailed);
    let usdc0 = key(&d,168) == USDC;
    require!(if usdc0 { key(&d,200) == reserve_mint } else { key(&d,168) == reserve_mint && key(&d,200) == USDC }, SsrError::LiquidityRevenueValidationFailed);
    require!(d[389] == if usdc0 {1} else {2} && d[390] == 1, SsrError::LiquidityRevenueValidationFailed);
    require_keys_eq!(key(&d,if usdc0 {232} else {264}), token::ID, SsrError::LiquidityRevenueValidationFailed);
    require_keys_eq!(key(&d,if usdc0 {264} else {232}), anchor_spl::token_2022::ID, SsrError::LiquidityRevenueValidationFailed);
    Ok(())
}
fn retained_rate(config: &AccountInfo, override_account: &AccountInfo, revenue: Pubkey) -> Result<u64> {
    require_keys_eq!(*config.owner, RAYDIUM, SsrError::LiquidityRevenueValidationFailed);
    require_keys_eq!(config.key(), AMM_CONFIG, SsrError::LiquidityRevenueValidationFailed);
    let d = config.try_borrow_data()?;
    require!(d.len()==236 && d[..8]==[218,244,33,104,203,203,43,111] && d[9]==0 && u64_at(&d,12)==2500 && u64_at(&d,108)==7500, SsrError::LiquidityRevenueValidationFailed);
    let mut rate = u64_at(&d,116);
    let expected = Pubkey::find_program_address(&[b"creator_fee_share", revenue.as_ref(), AMM_CONFIG.as_ref()], &RAYDIUM).0;
    require_keys_eq!(override_account.key(), expected, SsrError::LiquidityRevenueValidationFailed);
    if !override_account.data_is_empty() {
        require_keys_eq!(*override_account.owner, RAYDIUM, SsrError::LiquidityRevenueValidationFailed);
        let o = override_account.try_borrow_data()?;
        require!(o.len()==145 && o[..8]==[30,235,98,252,26,197,66,86] && key(&o,9)==revenue && key(&o,41)==AMM_CONFIG, SsrError::LiquidityRevenueValidationFailed);
        rate = u64_at(&o,73);
    }
    require!(rate <= 50_000, SsrError::LiquidityRevenueValidationFailed);
    Ok(rate)
}
pub fn configure(ctx: Context<ConfigureLiquidityRevenue>, buy_tax_bps: u16, sell_tax_bps: u16) -> Result<()> {
    require!(!ctx.accounts.protocol_config.paused && buy_tax_bps <= 200 && sell_tax_bps <= 200, SsrError::LiquidityRevenueValidationFailed);
    validate_pool(&ctx.accounts.pool, ctx.accounts.reserve.reserve_token_mint, ctx.accounts.revenue.key())?;
    let rate = retained_rate(&ctx.accounts.amm_config, &ctx.accounts.creator_fee_share, ctx.accounts.revenue.key())?;
    *ctx.accounts.revenue = LiquidityRevenue { reserve: ctx.accounts.reserve.key(), pool: ctx.accounts.pool.key(),
        treasury: ctx.accounts.reserve.fee_config.fee_destination, buy_tax_bps, sell_tax_bps, retained_rate: rate, remainder: 0, bump: ctx.bumps.revenue };
    Ok(())
}

#[derive(Accounts)]
pub struct DistributeLiquidityRevenue<'info> {
    #[account(seeds = [PROTOCOL_CONFIG_SEED], bump = protocol_config.bump)]
    pub protocol_config: Account<'info, ProtocolConfig>,
    #[account(mut, seeds = [ROUTER_SEED, revenue.reserve.as_ref()], bump = revenue.bump)]
    pub revenue: Account<'info, LiquidityRevenue>,
    #[account(mut, constraint = staging.owner == revenue.key() && staging.mint == USDC @ SsrError::LiquidityRevenueValidationFailed)]
    pub staging: Account<'info, TokenAccount>,
    #[account(mut, dup, constraint = protocol_destination.owner == protocol_config.default_protocol_fee_destination && protocol_destination.mint == USDC @ SsrError::LiquidityRevenueValidationFailed)]
    pub protocol_destination: Account<'info, TokenAccount>,
    #[account(mut, dup, constraint = creator_destination.owner == revenue.treasury && creator_destination.mint == USDC @ SsrError::LiquidityRevenueValidationFailed)]
    pub creator_destination: Account<'info, TokenAccount>,
    /// CHECK: config validated before distribution. Changes fail closed.
    #[account(address = AMM_CONFIG)] pub amm_config: UncheckedAccount<'info>,
    /// CHECK: canonical optional override validated before distribution.
    pub creator_fee_share: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}
/// At 5% Raydium retention, ratio is 4/57 of net collected USDC.
/// This corresponds to 0.05% of the native creator-fee base, not gross
/// wallet turnover (output-side fee bases and integer rounding differ).
pub fn base_split(net: u64, retained: u64, carry: u128) -> Result<(u64,u128)> {
    require!(retained<=50_000, SsrError::LiquidityRevenueValidationFailed);
    let denominator = 7500u128 * (1_000_000u128 - retained as u128);
    require!(carry<denominator, SsrError::LiquidityRevenueValidationFailed);
    let numerator = net as u128 * 500 * 1_000_000 + carry;
    Ok((u64::try_from(numerator/denominator).map_err(|_| error!(SsrError::MathOverflow))?, numerator%denominator))
}
pub fn distribute(ctx: Context<DistributeLiquidityRevenue>) -> Result<()> {
    let rate = retained_rate(&ctx.accounts.amm_config, &ctx.accounts.creator_fee_share, ctx.accounts.revenue.key())?;
    require!(rate == ctx.accounts.revenue.retained_rate, SsrError::LiquidityRevenueEconomicsChanged);
    let total = ctx.accounts.staging.amount;
    let (ssr, remainder) = base_split(total, rate, ctx.accounts.revenue.remainder)?;
    let reserve = ctx.accounts.revenue.reserve;
    let bump = [ctx.accounts.revenue.bump];
    let seeds: &[&[u8]] = &[ROUTER_SEED, reserve.as_ref(), &bump];
    for (amount, destination) in [(ssr,ctx.accounts.protocol_destination.to_account_info()),(total-ssr,ctx.accounts.creator_destination.to_account_info())] {
        if amount>0 { token::transfer(CpiContext::new(ctx.accounts.token_program.key(), Transfer {
            from: ctx.accounts.staging.to_account_info(), to: destination, authority: ctx.accounts.revenue.to_account_info(),
        }).with_signer(&[seeds]), amount)?; }
    }
    ctx.accounts.revenue.remainder = remainder;
    emit!(LiquidityRevenueDistributed {reserve, pool:ctx.accounts.revenue.pool, protocol_usdc:ssr, creator_usdc:total-ssr});
    Ok(())
}

#[derive(Accounts)]
pub struct SwapWithProjectTax<'info> {
    // Fixed recipient accounts may coincide with the user's USDC ATA when
    // the creator compounds. SPL Token owns these accounts; Anchor does not
    // serialize cached balances back over CPI updates. `dup` preserves that
    // valid self-recipient case while retaining fixed-owner/mint constraints.
    pub user: Signer<'info>,
    #[account(seeds = [PROTOCOL_CONFIG_SEED], bump = protocol_config.bump)]
    pub protocol_config: Account<'info, ProtocolConfig>,
    #[account(seeds = [ROUTER_SEED, revenue.reserve.as_ref()], bump = revenue.bump)]
    pub revenue: Account<'info, LiquidityRevenue>,
    #[account(mut, constraint = user_usdc.owner == user.key() && user_usdc.mint == USDC @ SsrError::LiquidityRevenueValidationFailed)]
    pub user_usdc: Account<'info, TokenAccount>,
    #[account(mut, dup, constraint = protocol_destination.owner == protocol_config.default_protocol_fee_destination && protocol_destination.mint == USDC @ SsrError::LiquidityRevenueValidationFailed)]
    pub protocol_destination: Account<'info, TokenAccount>,
    #[account(mut, dup, constraint = creator_destination.owner == revenue.treasury && creator_destination.mint == USDC @ SsrError::LiquidityRevenueValidationFailed)]
    pub creator_destination: Account<'info, TokenAccount>,
    /// CHECK: address pins CPI to Raydium.
    #[account(address = RAYDIUM, executable)] pub raydium_program: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    // Exactly the 13 native Swap accounts, in Raydium's documented order.
}
pub fn tax_split(amount: u64, bps: u16) -> Result<(u64,u64)> {
    require!(bps<=200, SsrError::LiquidityRevenueValidationFailed);
    let total = u64::try_from((amount as u128 * bps as u128 + 9999)/10000).map_err(|_| error!(SsrError::MathOverflow))?;
    // Protocol receives rounding remainder; zero tax yields zero shares.
    let creator = ((total as u128) * 3 / 4) as u64;
    Ok((total-creator, creator))
}
pub fn taxed_swap<'info>(ctx: Context<'info, SwapWithProjectTax<'info>>, buy: bool, amount_in: u64, minimum_net_out: u64) -> Result<()> {
    require!(!ctx.accounts.protocol_config.paused && amount_in>0 && minimum_net_out>0, SsrError::LiquidityRevenueValidationFailed);
    let a = ctx.remaining_accounts;
    require!(a.len()==13 && a[0].key()==ctx.accounts.user.key() && a[3].key()==ctx.accounts.revenue.pool, SsrError::LiquidityRevenueValidationFailed);
    require_keys_eq!(a[2].key(), AMM_CONFIG, SsrError::LiquidityRevenueValidationFailed);
    require_keys_eq!(a[if buy {4} else {5}].key(), ctx.accounts.user_usdc.key(), SsrError::LiquidityRevenueValidationFailed);
    require_keys_eq!(a[if buy {10} else {11}].key(), USDC, SsrError::LiquidityRevenueValidationFailed);
    // Raydium validates pool vaults, mints, programs and observation PDA.
    // Only the user's signer is forwarded; no protocol/Reserve PDA signs.
    let before_usdc = ctx.accounts.user_usdc.amount;
    let before_output = {
        let d=a[5].try_borrow_data()?;
        require!(d.len()>=165, SsrError::LiquidityRevenueValidationFailed);
        require_keys_eq!(key(&d,32), ctx.accounts.user.key(), SsrError::LiquidityRevenueValidationFailed);
        u64_at(&d,64)
    };
    let (mut ssr,mut creator) = if buy {tax_split(amount_in,ctx.accounts.revenue.buy_tax_bps)?} else {(0,0)};
    let swap_input = amount_in.checked_sub(ssr+creator).ok_or(error!(SsrError::MathUnderflow))?;
    require!(swap_input>0, SsrError::LiquidityRevenueValidationFailed);
    let mut data=vec![143,190,90,218,196,30,51,222]; // global:swap_base_input
    data.extend_from_slice(&swap_input.to_le_bytes());
    data.extend_from_slice(&1u64.to_le_bytes()); // final user-net minimum checked below
    let ix=Instruction {program_id:RAYDIUM, data, accounts:a.iter().enumerate().map(|(i,x)| {
        let writable=matches!(i,3|4|5|6|7|12);
        if writable {AccountMeta::new(x.key(),i==0)} else {AccountMeta::new_readonly(x.key(),i==0)}
    }).collect()};
    invoke(&ix,a)?;
    ctx.accounts.user_usdc.reload()?;
    let output = {let d=a[5].try_borrow_data()?;u64_at(&d,64).checked_sub(before_output).ok_or(error!(SsrError::MathUnderflow))?};
    if !buy {
        let received=ctx.accounts.user_usdc.amount.checked_sub(before_usdc).ok_or(error!(SsrError::MathUnderflow))?;
        (ssr,creator)=tax_split(received,ctx.accounts.revenue.sell_tax_bps)?;
    }
    let net_output=if buy {output} else {output.checked_sub(ssr+creator).ok_or(error!(SsrError::MathUnderflow))?};
    require!(net_output>=minimum_net_out, SsrError::LiquiditySwapMinimumNotMet);
    for (amount,to) in [(ssr,ctx.accounts.protocol_destination.to_account_info()),(creator,ctx.accounts.creator_destination.to_account_info())] {
        if amount>0 {token::transfer(CpiContext::new(ctx.accounts.token_program.key(),Transfer {
            from:ctx.accounts.user_usdc.to_account_info(),to,authority:ctx.accounts.user.to_account_info(),
        }),amount)?;}
    }
    emit!(ProjectTaxCharged {reserve:ctx.accounts.revenue.reserve,pool:ctx.accounts.revenue.pool,user:ctx.accounts.user.key(),buy,protocol_usdc:ssr,creator_usdc:creator,net_output});
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn base_rate_and_fragmentation() {
        assert_eq!(base_split(712_500,50_000,0).unwrap().0,50_000);
        let mut carry=0; let mut total=0;
        for _ in 0..712_500 {let (p,r)=base_split(1,50_000,carry).unwrap();total+=p;carry=r;}
        assert_eq!(total,50_000); assert_eq!(carry,0);
        assert!(base_split(1,50_001,0).is_err());
    }
    #[test] fn optional_tax_conserves_and_zero_is_zero() {
        assert_eq!(tax_split(1_000_000,200).unwrap(),(5000,15000));
        assert_eq!(tax_split(1_000_000,0).unwrap(),(0,0));
        let (p,c)=tax_split(u64::MAX,200).unwrap();
        let total=((u64::MAX as u128)*200+9999)/10000;
        assert_eq!((p as u128)+(c as u128),total);
        assert_eq!(c as u128,total*3/4);
        for n in 0..1000 {let(p,c)=tax_split(n,100).unwrap();assert_eq!(p+c,(n+99)/100);}
    }
    #[test] fn pool_identity_pair_and_fee_side_are_enforced() {
        let pool_key=Pubkey::new_unique(); let revenue=Pubkey::new_unique(); let mint=Pubkey::new_unique();
        let mut d=vec![0u8;637]; d[..8].copy_from_slice(&[247,237,227,245,215,195,222,70]);
        for (offset,k) in [(8,AMM_CONFIG),(40,revenue),(168,USDC),(200,mint),(232,token::ID),(264,anchor_spl::token_2022::ID)] {d[offset..offset+32].copy_from_slice(k.as_ref());}
        d[389]=1;d[390]=1;
        let mut lamports=1;
        assert!(validate_pool(&AccountInfo::new(&pool_key,false,false,&mut lamports,&mut d,&RAYDIUM,false),mint,revenue).is_ok());
        for offset in [0usize,8,40,168,200,232,264,389,390] {
            d[offset]^=1;
            assert!(validate_pool(&AccountInfo::new(&pool_key,false,false,&mut lamports,&mut d,&RAYDIUM,false),mint,revenue).is_err(),"offset {offset}");
            d[offset]^=1;
        }
        assert!(validate_pool(&AccountInfo::new(&pool_key,false,false,&mut lamports,&mut d,&USDC,false),mint,revenue).is_err());
    }
    #[test] fn mutable_raydium_config_and_override_fail_closed() {
        let revenue=Pubkey::new_unique();let mut d=vec![0u8;236];d[..8].copy_from_slice(&[218,244,33,104,203,203,43,111]);
        d[12..20].copy_from_slice(&2500u64.to_le_bytes());d[108..116].copy_from_slice(&7500u64.to_le_bytes());d[116..124].copy_from_slice(&50000u64.to_le_bytes());
        let override_key=Pubkey::find_program_address(&[b"creator_fee_share",revenue.as_ref(),AMM_CONFIG.as_ref()],&RAYDIUM).0;
        let mut empty=[];let mut lamports=1;let mut override_lamports=0;
        let system_id=System::id();
        let o=AccountInfo::new(&override_key,false,false,&mut override_lamports,&mut empty,&system_id,false);
        assert_eq!(retained_rate(&AccountInfo::new(&AMM_CONFIG,false,false,&mut lamports,&mut d,&RAYDIUM,false),&o,revenue).unwrap(),50000);
        d[108]^=1;
        assert!(retained_rate(&AccountInfo::new(&AMM_CONFIG,false,false,&mut lamports,&mut d,&RAYDIUM,false),&o,revenue).is_err());
    }

}
