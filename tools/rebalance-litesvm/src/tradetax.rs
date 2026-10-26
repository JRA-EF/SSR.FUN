//! DEC-0257: the creator's trade tax carried by the Reserve Token's transfer
//! fee, against the real compiled program. Trades are stood in for by plain
//! Token-2022 transfers: a Raydium or Jupiter swap moves the Reserve Token
//! with exactly such a transfer, so the token charges it the same way.

use super::*;
use anchor_lang::solana_program::clock::Clock;
use anchor_spl::token_2022::spl_token_2022;
use spl_token_2022::extension::{transfer_fee::TransferFeeConfig, BaseStateWithExtensions, StateWithExtensions};
use ssr_protocol::instructions::liquidity_revenue::{LiquidityRevenue, AMM_CONFIG, RAYDIUM, ROUTER_SEED, USDC};
use ssr_protocol::instructions::liquidity_terms::TERMS_SEED;
use ssr_protocol::instructions::trade_tax::{TradeTax, TRADE_TAX_SEED};

const SYSVAR_IX: Pubkey = anchor_lang::pubkey!("Sysvar1nstructions1111111111111111111111111");

struct Ctx { revenue: Pubkey, terms: Pubkey, trade_tax: Pubkey, pool: Pubkey, creator_fee_share: Pubkey }

fn ctx(env: &mut Env) -> Ctx {
    let revenue = pda(&[ROUTER_SEED, env.reserve.as_ref()]);
    feed::install_usdc(env);
    let pool = feed::install_pool(env, &revenue);
    Ctx {
        revenue, terms: pda(&[TERMS_SEED, revenue.as_ref()]), trade_tax: pda(&[TRADE_TAX_SEED, env.reserve.as_ref()]), pool,
        creator_fee_share: Pubkey::find_program_address(&[b"creator_fee_share", revenue.as_ref(), AMM_CONFIG.as_ref()], &RAYDIUM).0,
    }
}

fn configure_v2(env: &Env, c: &Ctx, buy: u16, sell: u16, holder_share_bps: u16) -> Instruction {
    Instruction {
        program_id: PID,
        accounts: ssr_protocol::accounts::ConfigureLiquidityRevenueV2 {
            manager: env.admin.pubkey(), protocol_config: pda(&[PROTOCOL_CONFIG_SEED]), reserve: env.reserve, revenue: c.revenue,
            terms: c.terms, feed_usdc: ata(&c.terms, &USDC, &TOKEN), usdc_mint: USDC, pool: c.pool, amm_config: AMM_CONFIG,
            creator_fee_share: c.creator_fee_share, token_program: TOKEN, associated_token_program: anchor_spl::associated_token::ID,
            system_program: anchor_lang::system_program::ID,
        }.to_account_metas(None),
        data: ssr_protocol::instruction::ConfigureLiquidityRevenueV2 { buy_tax_bps: buy, sell_tax_bps: sell, holder_share_bps }.data(),
    }
}

fn enable(env: &Env, c: &Ctx) -> Instruction {
    Instruction {
        program_id: PID,
        accounts: ssr_protocol::accounts::EnableTradeTax {
            manager: env.admin.pubkey(), protocol_config: pda(&[PROTOCOL_CONFIG_SEED]), reserve: env.reserve, revenue: c.revenue,
            terms: c.terms, trade_tax: c.trade_tax, reserve_token_mint: env.rt_mint, transfer_fee_authority: pda(&[TRANSFER_FEE_AUTHORITY_SEED]),
            instructions_sysvar: SYSVAR_IX, token_program: TOKEN22, system_program: anchor_lang::system_program::ID,
        }.to_account_metas(None),
        data: ssr_protocol::instruction::EnableTradeTax {}.data(),
    }
}

fn collect(env: &Env, c: &Ctx, creator: &Pubkey, sources: &[Pubkey]) -> Instruction {
    let admin = env.admin.pubkey();
    let mut accounts = ssr_protocol::accounts::CollectTradeTax {
        protocol_config: pda(&[PROTOCOL_CONFIG_SEED]), reserve: env.reserve, trade_tax: c.trade_tax, reserve_token_mint: env.rt_mint,
        transfer_fee_authority: pda(&[TRANSFER_FEE_AUTHORITY_SEED]), staging: ata(&c.trade_tax, &env.rt_mint, &TOKEN22),
        protocol_treasury: admin, protocol_token_account: ata(&admin, &env.rt_mint, &TOKEN22),
        creator_treasury: *creator, creator_token_account: ata(creator, &env.rt_mint, &TOKEN22),
        payer: env.keeper.pubkey(), token_program: TOKEN22, associated_token_program: anchor_spl::associated_token::ID,
        system_program: anchor_lang::system_program::ID,
    }.to_account_metas(None);
    accounts.extend(sources.iter().map(|s| AccountMeta::new(*s, false)));
    Instruction { program_id: PID, accounts, data: ssr_protocol::instruction::CollectTradeTax {}.data() }
}

fn collect_v1(env: &Env) -> Instruction {
    let admin = env.admin.pubkey();
    Instruction {
        program_id: PID,
        accounts: ssr_protocol::accounts::CollectTransferFees {
            protocol_config: pda(&[PROTOCOL_CONFIG_SEED]), reserve: env.reserve, reserve_token_mint: env.rt_mint,
            transfer_fee_authority: pda(&[TRANSFER_FEE_AUTHORITY_SEED]), treasury: admin, treasury_token_account: ata(&admin, &env.rt_mint, &TOKEN22),
            payer: env.keeper.pubkey(), token_program: TOKEN22, associated_token_program: anchor_spl::associated_token::ID,
            system_program: anchor_lang::system_program::ID,
        }.to_account_metas(None),
        data: ssr_protocol::instruction::CollectTransferFees {}.data(),
    }
}

fn update_fee(env: &Env, bps: u16) -> Instruction {
    Instruction {
        program_id: PID,
        accounts: ssr_protocol::accounts::UpdateTransferFee {
            protocol_config: pda(&[PROTOCOL_CONFIG_SEED]), reserve: env.reserve, reserve_token_mint: env.rt_mint,
            transfer_fee_authority: pda(&[TRANSFER_FEE_AUTHORITY_SEED]), authority: env.admin.pubkey(), token_program: TOKEN22,
        }.to_account_metas(None),
        data: ssr_protocol::instruction::UpdateTransferFee { new_transfer_fee_bps: bps }.data(),
    }
}

/// A trade, as the token sees it: `amount` Reserve Tokens from the admin to `to`.
fn trade(env: &Env, to: &Pubkey, amount: u64) -> Vec<Instruction> {
    let admin = env.admin.pubkey();
    vec![
        anchor_spl::associated_token::spl_associated_token_account::instruction::create_associated_token_account_idempotent(&admin, to, &env.rt_mint, &TOKEN22),
        spl_token_2022::instruction::transfer_checked(&TOKEN22, &ata(&admin, &env.rt_mint, &TOKEN22), &env.rt_mint, &ata(to, &env.rt_mint, &TOKEN22), &admin, &[], amount, 6).unwrap(),
    ]
}

fn mint_fee(env: &Env) -> (u16, u16, u64, u64) {
    let acct = env.svm.get_account(&env.rt_mint).unwrap();
    let mint = StateWithExtensions::<spl_token_2022::state::Mint>::unpack(&acct.data).unwrap();
    let fee = mint.get_extension::<TransferFeeConfig>().unwrap();
    let epoch = env.svm.get_sysvar::<Clock>().epoch;
    (u16::from(fee.get_epoch_fee(epoch).transfer_fee_basis_points), u16::from(fee.newer_transfer_fee.transfer_fee_basis_points),
        u64::from(fee.withheld_amount), mint.base.supply)
}

fn rt_balance(env: &Env, owner: &Pubkey) -> u64 {
    env.svm.get_account(&ata(owner, &env.rt_mint, &TOKEN22))
        .map(|a| StateWithExtensions::<spl_token_2022::state::Account>::unpack(&a.data).unwrap().base.amount).unwrap_or(0)
}

pub fn run() {
    let custom = |n: u32| format!("Custom({n})");
    let (invalid, not_at_launch, active) = (custom(6088), custom(6089), custom(6090));

    // A. Only in the launch transaction, and only with a tax.
    {
        let mut env = setup();
        let c = ctx(&mut env);
        let a = env.admin.insecure_clone();
        expect_err(env.send(&[configure_v2(&env, &c, 0, 0, 0), enable(&env, &c)], &[&a]), &invalid, "a trade tax of 0%");
        env.send(&[configure_v2(&env, &c, 100, 100, 0)], &[&a]).expect("configure v2 alone");
        expect_err(env.send(&[enable(&env, &c)], &[&a]), &not_at_launch, "setting the trade tax after the pool launched");
    }

    // B. Launch: 1% buy / 0.5% sell, 50% of the creator's 80% to holders.
    let mut env = setup();
    let c = ctx(&mut env);
    let a = env.admin.insecure_clone();
    let k = env.keeper.insecure_clone();
    env.send(&[configure_v2(&env, &c, 100, 50, 5_000), enable(&env, &c)], &[&a]).expect("FAIL launch with trade tax");
    let t: TradeTax = env.read(&c.trade_tax).unwrap();
    assert_eq!((t.tax_bps, t.protocol_bps, t.holder_share_bps, t.treasury), (100, 15, 5_000, env.admin.pubkey()));
    let (now, newer, _, _) = mint_fee(&env);
    assert_eq!((now, newer), (15, 115), "the combined rate is scheduled, the current one unchanged");
    let r: LiquidityRevenue = env.read(&c.revenue).unwrap();
    assert_eq!((r.buy_tax_bps, r.sell_tax_bps), (0, 0), "the swap wrapper must not tax again");
    println!("PASS launch: 1% tax (larger of 1% / 0.5%) recorded, mint fee 0.15% -> 1.15% from epoch +2, wrapper rates zeroed");
    let r = env.send(&[configure_v2(&env, &c, 100, 50, 5_000), enable(&env, &c)], &[&a]);
    assert!(r.is_err(), "FAIL the trade tax must not be set twice");
    println!("PASS the trade tax cannot be set again");

    // The harness uses one wallet for the protocol treasury and the creator;
    // give the creator its own so the two payouts can be told apart.
    let creator = Pubkey::new_unique();
    let mut acct = env.svm.get_account(&c.trade_tax).unwrap();
    acct.data[8 + 64..8 + 96].copy_from_slice(creator.as_ref());
    env.svm.set_account(c.trade_tax, acct).unwrap();

    // C. The protocol-only paths refuse the mint from the moment it is set.
    expect_err(env.send(&[collect_v1(&env)], &[&k]), &active, "collect_transfer_fees on a trade-taxed mint");
    expect_err(env.send(&[update_fee(&env, 25)], &[&a]), &active, "update_transfer_fee on a trade-taxed mint");

    // D. Before the switch the token still charges 0.15%: all of it is protocol fee.
    let trader = Pubkey::new_unique();
    let trader_rt = ata(&trader, &env.rt_mint, &TOKEN22);
    env.send(&trade(&env, &trader, 1_000_000), &[&a]).expect("trade before the switch");
    let (_, _, _, supply0) = mint_fee(&env);
    let admin_before = rt_balance(&env, &env.admin.pubkey());
    env.send(&[collect(&env, &c, &creator, &[trader_rt])], &[&k]).expect("FAIL collect before the switch");
    let t: TradeTax = env.read(&c.trade_tax).unwrap();
    assert_eq!((t.total_protocol, t.total_creator, t.total_burned), (1_500, 0, 0));
    assert_eq!(rt_balance(&env, &env.admin.pubkey()) - admin_before, 1_497, "1,500 to SSR, less the 0.15% (rounded up: 3) the payout itself pays");
    println!("PASS before the switch: 1,500 withheld (0.15%) all to SSR");

    // E. Two epochs later every transfer pays 1.15%.
    let mut clock: Clock = env.svm.get_sysvar();
    clock.epoch += 2;
    clock.slot += 1;
    env.svm.set_sysvar(&clock);
    let (now, _, _, _) = mint_fee(&env);
    assert_eq!(now, 115);
    env.send(&trade(&env, &trader, 1_000_000), &[&a]).expect("trade after the switch");
    assert_eq!(rt_balance(&env, &trader), 2 * 1_000_000 - 1_500 - 11_500, "the trader received the amount less the fee");
    let (_, _, _, supply1) = mint_fee(&env);
    env.send(&[collect(&env, &c, &creator, &[trader_rt])], &[&k]).expect("FAIL collect after the switch");
    // 11,500 at 1.15%: protocol 1,500, tax 10,000; creator 80% = 8,000, half burned.
    let t: TradeTax = env.read(&c.trade_tax).unwrap();
    assert_eq!((t.total_protocol - 1_500, t.total_creator, t.total_burned), (3_500, 4_000, 4_000));
    let (_, _, _, supply2) = mint_fee(&env);
    assert_eq!(supply1 - supply2, 4_000, "the holder share is burned");
    assert_eq!(supply0, supply1);
    assert_eq!(rt_balance(&env, &creator), 4_000 - 46, "creator paid 4,000, less the 1.15% the payout pays (46, withheld again)");
    assert_eq!(rt_balance(&env, &c.trade_tax), 0, "nothing stays in staging");
    println!("PASS after the switch: 11,500 withheld (1.15%) -> SSR 3,500 (0.15% + 20% of the tax), creator 4,000, 4,000 burned for holders");

    // F. The payouts' own fees are withheld again and split on the next run.
    let creator_rt = ata(&creator, &env.rt_mint, &TOKEN22);
    let admin_rt = ata(&env.admin.pubkey(), &env.rt_mint, &TOKEN22);
    env.send(&[collect(&env, &c, &creator, &[creator_rt, admin_rt])], &[&k]).expect("FAIL second collect");
    let t2: TradeTax = env.read(&c.trade_tax).unwrap();
    assert!(t2.total_creator > t.total_creator && t2.total_burned > t.total_burned, "re-withheld payout fees are split too");
    println!("PASS the payouts' own fees are collected and split on the next run ({} more to the creator)", t2.total_creator - t.total_creator);
}
