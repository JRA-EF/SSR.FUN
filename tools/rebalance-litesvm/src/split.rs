//! DEC-0255: the holder share's backing/pool split and the keeper's pool leg,
//! against the real compiled program. Raydium is not loaded (as in feed.rs):
//! the pool, its fee config and its LP mint are written at their real
//! addresses, and the keeper's swap + deposit are stood in for by plain token
//! moves between `pool_feed_begin` and `pool_feed_end` -- exactly the position
//! the real Raydium instructions occupy in the transaction. The program never
//! calls Raydium itself; it checks only what the keeper ends up with.

use super::*;
use solana_account::Account;
use solana_program_pack::Pack;
use ssr_protocol::instructions::liquidity_revenue::{AMM_CONFIG, RAYDIUM, ROUTER_SEED, USDC};
use ssr_protocol::instructions::liquidity_split::{LiquiditySplit, PoolFeedTicket, POOL_FEED_TICKET_SEED, SPLIT_SEED};
use ssr_protocol::instructions::liquidity_terms::{LiquidityTerms, TERMS_SEED};

struct Ctx {
    revenue: Pubkey,
    terms: Pubkey,
    split: Pubkey,
    feed: Pubkey,
    pool: Pubkey,
    lp_mint: Pubkey,
    creator_fee_share: Pubkey,
}

fn ctx(env: &mut Env) -> Ctx {
    let revenue = pda(&[ROUTER_SEED, env.reserve.as_ref()]);
    let terms = pda(&[TERMS_SEED, revenue.as_ref()]);
    let split = pda(&[SPLIT_SEED, terms.as_ref()]);
    feed::install_usdc(env);
    let pool = feed::install_pool(env, &revenue);
    let lp_mint = Pubkey::find_program_address(&[b"pool_lp_mint", pool.as_ref()], &RAYDIUM).0;
    let mut data = vec![0u8; spl_token::state::Mint::LEN];
    spl_token::state::Mint::pack(spl_token::state::Mint {
        mint_authority: Some(env.admin.pubkey()).into(), supply: 0, decimals: 9, is_initialized: true, freeze_authority: None.into(),
    }, &mut data).unwrap();
    env.svm.set_account(lp_mint, Account { lamports: 1_000_000_000, data, owner: TOKEN, executable: false, rent_epoch: 0 }).unwrap();
    Ctx {
        revenue, terms, split, feed: ata(&terms, &USDC, &TOKEN), pool, lp_mint,
        creator_fee_share: Pubkey::find_program_address(&[b"creator_fee_share", revenue.as_ref(), AMM_CONFIG.as_ref()], &RAYDIUM).0,
    }
}

fn configure_v2(env: &Env, c: &Ctx, holder_share_bps: u16) -> Instruction {
    Instruction {
        program_id: PID,
        accounts: ssr_protocol::accounts::ConfigureLiquidityRevenueV2 {
            manager: env.admin.pubkey(), protocol_config: pda(&[PROTOCOL_CONFIG_SEED]), reserve: env.reserve, revenue: c.revenue,
            terms: c.terms, feed_usdc: c.feed, usdc_mint: USDC, pool: c.pool, amm_config: AMM_CONFIG, creator_fee_share: c.creator_fee_share,
            token_program: TOKEN, associated_token_program: anchor_spl::associated_token::ID, system_program: anchor_lang::system_program::ID,
        }.to_account_metas(None),
        data: ssr_protocol::instruction::ConfigureLiquidityRevenueV2 { buy_tax_bps: 0, sell_tax_bps: 0, holder_share_bps }.data(),
    }
}

fn configure_split(env: &Env, c: &Ctx, pool_share_bps: u16) -> Instruction {
    Instruction {
        program_id: PID,
        accounts: ssr_protocol::accounts::ConfigureLiquiditySplit {
            manager: env.admin.pubkey(), reserve: env.reserve, revenue: c.revenue, terms: c.terms, split: c.split,
            instructions_sysvar: anchor_lang::pubkey!("Sysvar1nstructions1111111111111111111111111"),
            system_program: anchor_lang::system_program::ID,
        }.to_account_metas(None),
        data: ssr_protocol::instruction::ConfigureLiquiditySplit { pool_share_bps }.data(),
    }
}

fn begin(env: &Env, c: &Ctx, keeper: &Pubkey, amount_in: u64, min_lp: u64) -> Instruction {
    Instruction {
        program_id: PID,
        accounts: ssr_protocol::accounts::PoolFeedBegin {
            reserve: env.reserve, keeper: *keeper, settlement_keeper_config: pda(&[SETTLEMENT_KEEPER_CONFIG_SEED]),
            revenue: c.revenue, terms: c.terms, split: c.split, feed_usdc: c.feed, keeper_usdc: ata(keeper, &USDC, &TOKEN),
            keeper_reserve_token: ata(keeper, &env.rt_mint, &TOKEN22), lp_mint: c.lp_mint, keeper_lp: ata(keeper, &c.lp_mint, &TOKEN),
            ticket: pda(&[POOL_FEED_TICKET_SEED, env.reserve.as_ref()]),
            instructions_sysvar: anchor_lang::pubkey!("Sysvar1nstructions1111111111111111111111111"),
            token_program: TOKEN, system_program: anchor_lang::system_program::ID,
        }.to_account_metas(None),
        data: ssr_protocol::instruction::PoolFeedBegin { amount_in, min_lp }.data(),
    }
}

fn end(env: &Env, c: &Ctx, keeper: &Pubkey) -> Instruction {
    Instruction {
        program_id: PID,
        accounts: ssr_protocol::accounts::PoolFeedEnd {
            reserve: env.reserve, keeper: *keeper, revenue: c.revenue, terms: c.terms, split: c.split,
            ticket: pda(&[POOL_FEED_TICKET_SEED, env.reserve.as_ref()]), feed_usdc: c.feed,
            keeper_usdc: ata(keeper, &USDC, &TOKEN), keeper_reserve_token: ata(keeper, &env.rt_mint, &TOKEN22),
            keeper_lp: ata(keeper, &c.lp_mint, &TOKEN), lp_mint: c.lp_mint, split_lp: ata(&c.split, &c.lp_mint, &TOKEN),
            reserve_token_mint: env.rt_mint, split_reserve_token: ata(&c.split, &env.rt_mint, &TOKEN22),
            token_program: TOKEN, reserve_token_program: TOKEN22,
            associated_token_program: anchor_spl::associated_token::ID, system_program: anchor_lang::system_program::ID,
        }.to_account_metas(None),
        data: ssr_protocol::instruction::PoolFeedEnd {}.data(),
    }
}

/// The keeper's swap + deposit, stood in for: `spent` USDC leaves the keeper
/// for the pool, the pool mints `lp` LP tokens to the keeper.
fn add_liquidity(env: &Env, c: &Ctx, keeper: &Pubkey, spent: u64, lp: u64) -> Vec<Instruction> {
    vec![
        spl_token::instruction::transfer(&TOKEN, &ata(keeper, &USDC, &TOKEN), &ata(&env.market.pubkey(), &USDC, &TOKEN), keeper, &[], spent).unwrap(),
        spl_token::instruction::mint_to(&TOKEN, &c.lp_mint, &ata(keeper, &c.lp_mint, &TOKEN), &env.admin.pubkey(), &[], lp).unwrap(),
    ]
}

pub fn run() {
    let custom = |n: u32| format!("Custom({n})");
    let (invalid, not_at_launch, exceeds_share, end_missing, min_not_met) = (custom(6083), custom(6084), custom(6085), custom(6086), custom(6087));

    // A. The split can only be chosen in the launch transaction.
    {
        let mut env = setup();
        let c = ctx(&mut env);
        let a = env.admin.insecure_clone();
        env.send(&[configure_v2(&env, &c, 5_000)], &[&a]).expect("configure v2 alone");
        expect_err(env.send(&[configure_split(&env, &c, 3_000)], &[&a]), &not_at_launch, "choosing the split after the pool launched");
    }

    let mut env = setup();
    let c = ctx(&mut env);
    let a = env.admin.insecure_clone();
    let k = env.keeper.insecure_clone();
    let m = env.market.insecure_clone();
    let (admin, keeper) = (a.pubkey(), k.pubkey());

    // B. Invalid choices revert the whole launch.
    expect_err(env.send(&[configure_v2(&env, &c, 0), configure_split(&env, &c, 3_000)], &[&a]), &invalid, "a pool split without a holder share");
    expect_err(env.send(&[configure_v2(&env, &c, 5_000), configure_split(&env, &c, 0)], &[&a]), &invalid, "a 0% pool split");
    expect_err(env.send(&[configure_v2(&env, &c, 5_000), configure_split(&env, &c, 10_001)], &[&a]), &invalid, "a pool split above 100%");
    assert!(env.svm.get_account(&c.terms).map(|x| x.data.is_empty()).unwrap_or(true), "a refused split leaves no terms behind");

    // C. Launch: 50% of the creator's 80% to holders, 30% of that to the pool.
    env.send(&[configure_v2(&env, &c, 5_000), configure_split(&env, &c, 3_000)], &[&a]).expect("FAIL launch with split");
    let s: LiquiditySplit = env.read(&c.split).unwrap();
    assert_eq!((s.terms, s.pool_share_bps, s.pool_fed, s.lp_locked), (c.terms, 3_000, 0, 0));
    println!("PASS launch: holder share 50%, of which 30% to the pool, recorded with the terms");
    let r = env.send(&[configure_v2(&env, &c, 5_000), configure_split(&env, &c, 10_000)], &[&a]);
    assert!(r.is_err(), "FAIL the split must not be re-chosen");
    println!("PASS the split cannot be changed after launch (second launch refused)");

    // D. 1,000,000 USDC of creator fees -> 400,000 to holders, all released after 24h.
    let admin_usdc = CreateAssociatedTokenAccount::new(&mut env.svm, &a, &USDC).owner(&admin).send().unwrap();
    let staging = CreateAssociatedTokenAccount::new(&mut env.svm, &a, &USDC).owner(&c.revenue).send().unwrap();
    MintTo::new(&mut env.svm, &a, &USDC, &staging, 1_000_000).send().unwrap();
    env.send(&[Instruction {
        program_id: PID,
        accounts: ssr_protocol::accounts::DistributeLiquidityRevenueV2 {
            protocol_config: pda(&[PROTOCOL_CONFIG_SEED]), revenue: c.revenue, terms: c.terms, staging, protocol_destination: admin_usdc,
            creator_destination: admin_usdc, feed_usdc: c.feed, amm_config: AMM_CONFIG, creator_fee_share: c.creator_fee_share, token_program: TOKEN,
        }.to_account_metas(None),
        data: ssr_protocol::instruction::DistributeLiquidityRevenueV2 {}.data(),
    }], &[&a]).expect("distribute");
    assert_eq!(env.bal(&c.feed), 400_000);
    feed::warp(&mut env, 86_401);

    let mk = m.pubkey();
    CreateAssociatedTokenAccount::new(&mut env.svm, &a, &USDC).owner(&mk).send().unwrap();
    let keeper_usdc = CreateAssociatedTokenAccount::new(&mut env.svm, &a, &USDC).owner(&keeper).send().unwrap();
    let keeper_rt = CreateAssociatedTokenAccount::new(&mut env.svm, &a, &env.rt_mint).owner(&keeper).token_program_id(&TOKEN22).send().unwrap();
    let keeper_lp = CreateAssociatedTokenAccount::new(&mut env.svm, &a, &c.lp_mint).owner(&keeper).send().unwrap();

    // E. Guard rails.
    let r = env.send(&[begin(&env, &c, &keeper, 1_000, 1)], &[&k]);
    expect_err(r, &end_missing, "pool leg without its finish step");
    let mut ixs = vec![begin(&env, &c, &keeper, 120_001, 1)];
    ixs.extend(add_liquidity(&env, &c, &keeper, 1, 1));
    ixs.push(end(&env, &c, &keeper));
    expect_err(env.send(&ixs, &[&k, &a]), &exceeds_share, "more than 30% of the 400,000 released into the pool");
    let mut ixs = vec![begin(&env, &c, &keeper, 120_000, 1_000)];
    ixs.extend(add_liquidity(&env, &c, &keeper, 120_000, 999));
    ixs.push(end(&env, &c, &keeper));
    expect_err(env.send(&ixs, &[&k, &a]), &min_not_met, "fewer pool shares than SSR's quoted minimum");
    let stranger = Keypair::new();
    env.svm.airdrop(&stranger.pubkey(), 1_000_000_000).unwrap();
    let sp = stranger.pubkey();
    CreateAssociatedTokenAccount::new(&mut env.svm, &a, &USDC).owner(&sp).send().unwrap();
    CreateAssociatedTokenAccount::new(&mut env.svm, &a, &env.rt_mint).owner(&sp).token_program_id(&TOKEN22).send().unwrap();
    CreateAssociatedTokenAccount::new(&mut env.svm, &a, &c.lp_mint).owner(&sp).send().unwrap();
    let mut ixs = vec![begin(&env, &c, &sp, 1_000, 1)];
    ixs.extend(add_liquidity(&env, &c, &sp, 1_000, 1));
    ixs.push(end(&env, &c, &sp));
    expect_err(env.send(&ixs, &[&stranger, &a]), "Custom(6068)", "a pool leg signed by anyone but SSR's keeper");
    assert_eq!(env.bal(&c.feed), 400_000, "refused legs moved nothing");

    // F. The pool leg: 120,000 lent, 110,000 spent, 1,000 LP minted, 50 Reserve Tokens left over.
    let rt_dust: u64 = 50;
    let mut ixs = vec![begin(&env, &c, &keeper, 120_000, 1_000)];
    ixs.extend(add_liquidity(&env, &c, &keeper, 110_000, 1_000));
    // Token-2022 TransferChecked (12): amount, decimals.
    let mut data = vec![12u8];
    data.extend_from_slice(&rt_dust.to_le_bytes());
    data.push(6);
    ixs.push(Instruction { program_id: TOKEN22, data, accounts: vec![
        AccountMeta::new(ata(&admin, &env.rt_mint, &TOKEN22), false), AccountMeta::new_readonly(env.rt_mint, false),
        AccountMeta::new(keeper_rt, false), AccountMeta::new_readonly(admin, true)] });
    ixs.push(end(&env, &c, &keeper));
    env.send(&ixs, &[&k, &a]).expect("FAIL pool leg");
    assert_eq!(env.bal(&ata(&c.split, &c.lp_mint, &TOKEN)), 1_000, "the LP sits in the split's own account");
    assert_eq!((env.bal(&keeper_usdc), env.bal(&keeper_lp)), (0, 0), "the keeper keeps nothing");
    assert_eq!(env.bal(&c.feed), 400_000 - 110_000, "unspent USDC went back to the feed");
    let t: LiquidityTerms = env.read(&c.terms).unwrap();
    let s: LiquiditySplit = env.read(&c.split).unwrap();
    assert_eq!((t.unlocked, t.total_fed, s.pool_fed, s.lp_locked), (290_000, 110_000, 110_000, 1_000));
    let keeper_rt_after = env.svm.get_account(&keeper_rt).unwrap();
    assert_eq!(u64::from_le_bytes(keeper_rt_after.data[64..72].try_into().unwrap()), 0, "Reserve Token leftovers left the keeper");
    let split_rt = env.svm.get_account(&ata(&c.split, &env.rt_mint, &TOKEN22)).unwrap();
    let split_rt_amount = u64::from_le_bytes(split_rt.data[64..72].try_into().unwrap());
    assert!(split_rt_amount > 0 && split_rt_amount <= rt_dust, "leftover Reserve Tokens stay with the split (less the transfer fee)");
    assert!(env.read::<PoolFeedTicket>(&pda(&[POOL_FEED_TICKET_SEED, env.reserve.as_ref()])).is_none(), "ticket closed");
    println!("PASS pool leg: 120,000 lent, 110,000 added, 10,000 back to the feed as released, 1,000 LP locked, {split_rt_amount} Reserve Token dust kept by the split");

    // G. Catch-up: the pool may take up to 30% of the 400,000 released (120,000) in total, never more.
    let mut ixs = vec![begin(&env, &c, &keeper, 10_001, 1)];
    ixs.extend(add_liquidity(&env, &c, &keeper, 10_001, 1));
    ixs.push(end(&env, &c, &keeper));
    expect_err(env.send(&ixs, &[&k, &a]), &exceeds_share, "topping the pool past its share");
    let mut ixs = vec![begin(&env, &c, &keeper, 10_000, 1)];
    ixs.extend(add_liquidity(&env, &c, &keeper, 10_000, 90));
    ixs.push(end(&env, &c, &keeper));
    env.send(&ixs, &[&k, &a]).expect("FAIL catch-up leg");
    let s: LiquiditySplit = env.read(&c.split).unwrap();
    assert_eq!((s.pool_fed, s.lp_locked), (120_000, 1_090));
    println!("PASS catch-up: 10,001 more was refused, 10,000 brought the pool to exactly its 30% (120,000 of 400,000)");

    // H. Nothing can take the LP back: the split's LP account is owned by the split PDA and no instruction signs for it.
    let lp_account = get_spl_account::<spl_token::state::Account>(&env.svm, &ata(&c.split, &c.lp_mint, &TOKEN)).unwrap();
    assert_eq!((lp_account.owner, lp_account.amount, lp_account.delegate.is_none(), lp_account.close_authority.is_none()), (c.split, 1_090, true, true));
    println!("PASS the locked LP account is owned by the split, with no delegate and no close authority");
}
