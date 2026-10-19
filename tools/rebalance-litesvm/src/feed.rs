//! DEC-0251: liquidity terms v2 and the basket feed, against the real
//! compiled program. Raydium is not loaded, so the pool and its fee config
//! are written as Raydium-owned accounts with exactly the bytes the program
//! validates; the swap-routed project tax is not exercised here.

use super::*;
use anchor_lang::solana_program::clock::Clock;
use solana_account::Account;
use solana_program_pack::Pack;
use ssr_protocol::instructions::liquidity_revenue::{AMM_CONFIG, RAYDIUM, ROUTER_SEED, USDC};
use ssr_protocol::instructions::liquidity_terms::{LiquidityTerms, TERMS_SEED};

fn raydium_account(data: Vec<u8>) -> Account {
    Account { lamports: 1_000_000_000, data, owner: RAYDIUM, executable: false, rent_epoch: 0 }
}

fn install_usdc(env: &mut Env) {
    let mut data = vec![0u8; spl_token::state::Mint::LEN];
    let mint = spl_token::state::Mint {
        mint_authority: Some(env.admin.pubkey()).into(),
        supply: 0,
        decimals: 6,
        is_initialized: true,
        freeze_authority: None.into(),
    };
    spl_token::state::Mint::pack(mint, &mut data).unwrap();
    env.svm.set_account(USDC, Account { lamports: 1_000_000_000, data, owner: TOKEN, executable: false, rent_epoch: 0 }).unwrap();
}

fn install_pool(env: &mut Env, revenue: &Pubkey) -> Pubkey {
    let mut cfg = vec![0u8; 236];
    cfg[..8].copy_from_slice(&[218, 244, 33, 104, 203, 203, 43, 111]);
    cfg[12..20].copy_from_slice(&2500u64.to_le_bytes());
    cfg[108..116].copy_from_slice(&7500u64.to_le_bytes());
    cfg[116..124].copy_from_slice(&50_000u64.to_le_bytes());
    env.svm.set_account(AMM_CONFIG, raydium_account(cfg)).unwrap();
    let pool = Pubkey::new_unique();
    let mut d = vec![0u8; 637];
    d[..8].copy_from_slice(&[247, 237, 227, 245, 215, 195, 222, 70]);
    for (offset, k) in [(8, AMM_CONFIG), (40, *revenue), (168, USDC), (200, env.rt_mint), (232, TOKEN), (264, TOKEN22)] {
        d[offset..offset + 32].copy_from_slice(k.as_ref());
    }
    d[389] = 1;
    d[390] = 1;
    env.svm.set_account(pool, raydium_account(d)).unwrap();
    pool
}

fn warp(env: &mut Env, seconds: i64) {
    let mut clock: Clock = env.svm.get_sysvar();
    clock.unix_timestamp += seconds;
    clock.slot += 1;
    env.svm.set_sysvar(&clock);
}

pub fn run(env: &mut Env) {
    let a = env.admin.insecure_clone();
    let k = env.keeper.insecure_clone();
    let m = env.market.insecure_clone();
    let admin = a.pubkey();
    let keeper = k.pubkey();
    let mb = env.mints[1];
    let revenue = pda(&[ROUTER_SEED, env.reserve.as_ref()]);
    let terms = pda(&[TERMS_SEED, revenue.as_ref()]);
    let feed = ata(&terms, &USDC, &TOKEN);
    let staging = ata(&revenue, &USDC, &TOKEN);
    let protocol_config = pda(&[PROTOCOL_CONFIG_SEED]);
    let creator_fee_share = Pubkey::find_program_address(&[b"creator_fee_share", revenue.as_ref(), AMM_CONFIG.as_ref()], &RAYDIUM).0;
    install_usdc(env);
    let pool = install_pool(env, &revenue);

    // Errors appended after DEC-0250's 6079.
    let v2_required = "Custom(6080)";
    let bad_share = "Custom(6081)";
    let exceeds_released = "Custom(6082)";

    // 1. v1 configure now refuses.
    let v1 = Instruction {
        program_id: PID,
        accounts: ssr_protocol::accounts::ConfigureLiquidityRevenue {
            manager: admin, protocol_config, reserve: env.reserve, revenue, pool, amm_config: AMM_CONFIG, creator_fee_share,
            system_program: anchor_lang::system_program::ID,
        }.to_account_metas(None),
        data: ssr_protocol::instruction::ConfigureLiquidityRevenue { buy_tax_bps: 100, sell_tax_bps: 100 }.data(),
    };
    expect_err(env.send(&[v1], &[&a]), v2_required, "v1 configure for a new pool");

    let reserve = env.reserve;
    let configure = move |holder_share_bps: u16| Instruction {
        program_id: PID,
        accounts: ssr_protocol::accounts::ConfigureLiquidityRevenueV2 {
            manager: admin, protocol_config, reserve, revenue, terms, feed_usdc: feed, usdc_mint: USDC, pool,
            amm_config: AMM_CONFIG, creator_fee_share, token_program: TOKEN,
            associated_token_program: anchor_spl::associated_token::ID, system_program: anchor_lang::system_program::ID,
        }.to_account_metas(None),
        data: ssr_protocol::instruction::ConfigureLiquidityRevenueV2 { buy_tax_bps: 100, sell_tax_bps: 100, holder_share_bps }.data(),
    };
    // 2. holder share above 100% of the creator's portion.
    expect_err(env.send(&[configure(10_001)], &[&a]), bad_share, "holder share above 100%");
    // 3. a stranger pre-creating the feed ATA cannot block configuration.
    let pre = CreateAssociatedTokenAccount::new(&mut env.svm, &m, &USDC).owner(&terms).send().unwrap();
    assert_eq!(pre, feed);
    env.send(&[configure(5_000)], &[&a]).expect("FAIL configure v2");
    let t: LiquidityTerms = env.read(&terms).unwrap();
    assert_eq!((t.holder_share_bps, t.locked, t.unlocked), (5_000, 0, 0));
    println!("PASS configure v2: 50% holder share recorded, feed account created (pre-existing ATA tolerated)");
    // 4. the choice is permanent: a second configure cannot overwrite it.
    let r = env.send(&[configure(0)], &[&a]);
    assert!(r.is_err(), "FAIL re-configure must fail");
    println!("PASS holder share cannot be changed after launch (re-configure refused)");

    // 5. distribute 1,000,000 USDC of collected creator fees.
    let admin_usdc = CreateAssociatedTokenAccount::new(&mut env.svm, &a, &USDC).owner(&admin).send().unwrap();
    CreateAssociatedTokenAccount::new(&mut env.svm, &a, &USDC).owner(&revenue).send().unwrap();
    MintTo::new(&mut env.svm, &a, &USDC, &staging, 1_000_000).send().unwrap();
    let distribute = Instruction {
        program_id: PID,
        accounts: ssr_protocol::accounts::DistributeLiquidityRevenueV2 {
            protocol_config, revenue, terms, staging, protocol_destination: admin_usdc, creator_destination: admin_usdc,
            feed_usdc: feed, amm_config: AMM_CONFIG, creator_fee_share, token_program: TOKEN,
        }.to_account_metas(None),
        data: ssr_protocol::instruction::DistributeLiquidityRevenueV2 {}.data(),
    };
    env.send(&[distribute.clone()], &[&a]).expect("FAIL distribute v2");
    // Protocol and creator destinations coincide in this fixture (admin is both).
    assert_eq!((env.bal(&staging), env.bal(&admin_usdc), env.bal(&feed)), (0, 600_000, 400_000));
    println!("PASS distribute v2: 1,000,000 -> SSR 200,000 + creator 400,000 (same wallet here) + holder feed 400,000");

    // Keeper accounts.
    let keeper_usdc = CreateAssociatedTokenAccount::new(&mut env.svm, &a, &USDC).owner(&keeper).send().unwrap();
    let keeper_b = CreateAssociatedTokenAccount::new(&mut env.svm, &a, &mb).owner(&keeper).send().unwrap();
    let feed_begin = |env: &Env, signer: &Pubkey, buy: &Pubkey, amount_in: u64, min_out: u64| Instruction {
        program_id: PID,
        accounts: ssr_protocol::accounts::BasketFeedBegin {
            reserve: env.reserve, keeper: *signer, settlement_keeper_config: pda(&[SETTLEMENT_KEEPER_CONFIG_SEED]),
            revenue, terms, feed_usdc: feed, keeper_usdc: ata(signer, &USDC, &TOKEN),
            reserve_asset_buy: env.reserve_asset(buy), vault_buy: env.vault(buy), mint_buy: *buy,
            keeper_buy_account: ata(signer, buy, &TOKEN), ticket: pda(&[REBALANCE_TICKET_SEED, env.reserve.as_ref()]),
            instructions_sysvar: anchor_lang::pubkey!("Sysvar1nstructions1111111111111111111111111"),
            token_program: TOKEN, system_program: anchor_lang::system_program::ID,
        }.to_account_metas(None),
        data: ssr_protocol::instruction::BasketFeedBegin { amount_in, min_out }.data(),
    };

    // 6. nothing is released yet at the moment of deposit.
    let r = env.send(&[feed_begin(env, &keeper, &mb, 1, 1), env.swap_ix(&keeper, &mb, 1), env.end_ix(&keeper, &mb)], &[&k, &m]);
    expect_err(r, exceeds_released, "feeding before anything is released");

    // 7. one hour later 1/24 is released: 16,666.
    warp(env, 3_600);
    let r = env.send(&[feed_begin(env, &keeper, &mb, 16_667, 1), env.swap_ix(&keeper, &mb, 1), env.end_ix(&keeper, &mb)], &[&k, &m]);
    expect_err(r, exceeds_released, "feeding more than one hour's release");
    let r = env.send(&[feed_begin(env, &keeper, &mb, 100, 1)], &[&k]);
    expect_err(r, "Custom(6076)", "feed begin without the finish step");
    let stranger = Keypair::new();
    env.svm.airdrop(&stranger.pubkey(), 1_000_000_000).unwrap();
    let sp = stranger.pubkey();
    for mint in [USDC, mb] {
        CreateAssociatedTokenAccount::new(&mut env.svm, &a, &mint).owner(&sp).send().unwrap();
    }
    let r = env.send(&[feed_begin(env, &sp, &mb, 100, 1), env.swap_ix(&sp, &mb, 1), env.end_ix(&sp, &mb)], &[&stranger, &m]);
    expect_err(r, "Custom(6068)", "a feed signed by anyone but SSR's keeper");
    let r = env.send(&[feed_begin(env, &keeper, &mb, 16_666, 5_000), env.swap_ix(&keeper, &mb, 4_999), env.end_ix(&keeper, &mb)], &[&k, &m]);
    expect_err(r, "Custom(6077)", "route delivering below the quoted minimum");

    let b_before = env.bal(&env.vault(&mb));
    env.send(&[feed_begin(env, &keeper, &mb, 16_666, 5_000), env.swap_ix(&keeper, &mb, 5_000), env.end_ix(&keeper, &mb)], &[&k, &m])
        .expect("FAIL basket feed into B");
    assert_eq!(env.bal(&env.vault(&mb)), b_before + 5_000);
    assert_eq!(env.bal(&keeper_b), 0, "only what the route delivered went in; keeper keeps nothing");
    assert_eq!(env.bal(&keeper_usdc), 16_666, "the released USDC sits where the route would spend it");
    assert_eq!(env.bal(&feed), 400_000 - 16_666);
    let t: LiquidityTerms = env.read(&terms).unwrap();
    assert_eq!((t.unlocked, t.total_fed), (0, 16_666));
    println!("PASS basket feed after 1h: 16,666 USDC released, route delivered 5,000 B into the vault, nothing minted");

    // 8. after the 24h window everything is released; a USDC asset takes it directly, no route.
    let protocol_config_k = protocol_config;
    env.send(
        &[Instruction {
            program_id: PID,
            accounts: ssr_protocol::accounts::AddReserveAssetActive {
                protocol_config: protocol_config_k, reserve: env.reserve, reserve_asset: env.reserve_asset(&USDC), asset_mint: USDC,
                vault: env.vault(&USDC), vault_authority: pda(&[VAULT_AUTHORITY_SEED, env.reserve.as_ref()]),
                delegate: pda(&[DELEGATE_SEED, env.reserve.as_ref(), admin.as_ref()]), signer: admin,
                token_program: TOKEN, system_program: anchor_lang::system_program::ID,
            }.to_account_metas(None),
            data: ssr_protocol::instruction::AddReserveAssetActive { target_weight_bps: 0 }.data(),
        }],
        &[&a],
    ).expect("add USDC asset");
    warp(env, 86_400);
    let rest = 400_000 - 16_666;
    env.send(&[feed_begin(env, &keeper, &USDC, rest, rest), env.end_ix(&keeper, &USDC)], &[&k])
        .expect("FAIL direct USDC feed");
    assert_eq!((env.bal(&env.vault(&USDC)), env.bal(&feed)), (rest, 0));
    let t: LiquidityTerms = env.read(&terms).unwrap();
    assert_eq!((t.locked, t.unlocked, t.total_fed), (0, 0, 400_000));
    println!("PASS 24h later: remaining {rest} USDC fed straight into the USDC vault, feed empty, 400,000 fed in total");

    // 9. USDC sent to the feed outside a distribution is picked up by the
    // next distribution (here an empty one) and streams over its own 24h.
    MintTo::new(&mut env.svm, &a, &USDC, &feed, 86_400).send().unwrap();
    env.send(&[distribute.clone()], &[&a]).expect("FAIL empty distribution");
    let r = env.send(&[feed_begin(env, &keeper, &USDC, 1, 1), env.end_ix(&keeper, &USDC)], &[&k]);
    expect_err(r, exceeds_released, "a fresh deposit is not released instantly");
    warp(env, 600);
    env.send(&[feed_begin(env, &keeper, &USDC, 600, 600), env.end_ix(&keeper, &USDC)], &[&k]).expect("FAIL 10-minute release");
    println!("PASS direct deposit to the feed streams too (600 of 86,400 after 10 minutes)");
}
