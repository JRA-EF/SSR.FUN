//! DEC-0268: the trade tax on REAL Raydium CPMM buys and sells. tradetax.rs
//! stands trades in with plain transfers; this loads the Mainnet Raydium CPMM
//! binary and its accounts (fixtures/, fetched read-only by
//! fetch_raydium_fixtures.mjs), launches the pool exactly as the app does
//! ([initialize_with_permission, configure_liquidity_revenue_v2,
//! enable_trade_tax] in one transaction), then buys and sells through it.
//!
//! The only stand-in is the Raydium permission: Mainnet's is issued to the
//! SSR pool payer, whose key the test does not hold, so the same account is
//! written at the test payer's permission address.

use super::*;
use super::tradetax::{collect, configure_v2, enable, mint_fee, rt_balance, Ctx};
use anchor_lang::solana_program::clock::Clock;
use anchor_spl::token_2022::spl_token_2022;
use solana_account::Account;
use spl_token_2022::extension::{transfer_fee::TransferFeeAmount, BaseStateWithExtensions, StateWithExtensions};
use ssr_protocol::instructions::liquidity_revenue::{AMM_CONFIG, RAYDIUM, ROUTER_SEED, USDC};
use ssr_protocol::instructions::liquidity_terms::TERMS_SEED;
use ssr_protocol::instructions::trade_tax::{TradeTax, TRADE_TAX_SEED};

const POOL_FEE: Pubkey = anchor_lang::pubkey!("DNXgeM9EiiaAbaWvwjHj9fQQLAX5ZsfHyvmYUNRAdNC8");
const ATA_PROGRAM: Pubkey = anchor_spl::associated_token::ID;
const SYSTEM: Pubkey = anchor_lang::system_program::ID;

fn ray_pda(seeds: &[&[u8]]) -> Pubkey {
    Pubkey::find_program_address(seeds, &RAYDIUM).0
}

fn fixture(name: &str) -> Option<Vec<u8>> {
    let dir = std::env::var("RAYDIUM_FIXTURES").unwrap_or_else(|_| "fixtures".into());
    std::fs::read(format!("{dir}/{name}")).ok()
}

struct Pool { pool: Pubkey, mint0: Pubkey, mint1: Pubkey, vault0: Pubkey, vault1: Pubkey, prog0: Pubkey, prog1: Pubkey, observation: Pubkey }

impl Pool {
    fn new(rt_mint: Pubkey) -> Pool {
        let usdc0 = USDC.to_bytes() < rt_mint.to_bytes();
        let (mint0, mint1) = if usdc0 { (USDC, rt_mint) } else { (rt_mint, USDC) };
        let (prog0, prog1) = if usdc0 { (TOKEN, TOKEN22) } else { (TOKEN22, TOKEN) };
        let pool = ray_pda(&[b"pool", AMM_CONFIG.as_ref(), mint0.as_ref(), mint1.as_ref()]);
        Pool {
            pool, mint0, mint1, prog0, prog1,
            vault0: ray_pda(&[b"pool_vault", pool.as_ref(), mint0.as_ref()]),
            vault1: ray_pda(&[b"pool_vault", pool.as_ref(), mint1.as_ref()]),
            observation: ray_pda(&[b"observation", pool.as_ref()]),
        }
    }
    fn rt_vault(&self, rt_mint: &Pubkey) -> Pubkey {
        if self.mint0 == *rt_mint { self.vault0 } else { self.vault1 }
    }
    fn usdc0(&self) -> bool {
        self.mint0 == USDC
    }

    /// The app's launch instruction (src/merge/lib/liquidity/raydiumCpmm.ts prepareRevenuePool).
    fn initialize(&self, payer: &Pubkey, revenue: &Pubkey, rt_amount: u64, usdc_amount: u64) -> Instruction {
        let lp = ray_pda(&[b"pool_lp_mint", self.pool.as_ref()]);
        let (a0, a1) = if self.usdc0() { (usdc_amount, rt_amount) } else { (rt_amount, usdc_amount) };
        let mut data = vec![63, 55, 254, 65, 49, 178, 89, 121];
        data.extend_from_slice(&a0.to_le_bytes());
        data.extend_from_slice(&a1.to_le_bytes());
        data.extend_from_slice(&0u64.to_le_bytes());
        data.push(if self.usdc0() { 1 } else { 2 });
        Instruction {
            program_id: RAYDIUM,
            accounts: vec![
                AccountMeta::new(*payer, true), AccountMeta::new_readonly(*revenue, false), AccountMeta::new_readonly(AMM_CONFIG, false),
                AccountMeta::new_readonly(ray_pda(&[b"vault_and_lp_mint_auth_seed"]), false), AccountMeta::new(self.pool, false),
                AccountMeta::new_readonly(self.mint0, false), AccountMeta::new_readonly(self.mint1, false), AccountMeta::new(lp, false),
                AccountMeta::new(ata(payer, &self.mint0, &self.prog0), false), AccountMeta::new(ata(payer, &self.mint1, &self.prog1), false),
                AccountMeta::new(ata(payer, &lp, &TOKEN), false), AccountMeta::new(self.vault0, false), AccountMeta::new(self.vault1, false),
                AccountMeta::new(POOL_FEE, false), AccountMeta::new(self.observation, false),
                AccountMeta::new_readonly(ray_pda(&[b"permission", payer.as_ref()]), false),
                AccountMeta::new_readonly(TOKEN, false), AccountMeta::new_readonly(self.prog0, false), AccountMeta::new_readonly(self.prog1, false),
                AccountMeta::new_readonly(ATA_PROGRAM, false), AccountMeta::new_readonly(SYSTEM, false),
            ],
            data,
        }
    }

    /// Native swap_base_input (packages/sdk/src/raydiumCpmmInstructions.ts).
    fn swap(&self, owner: &Pubkey, input_mint: &Pubkey, amount_in: u64) -> Instruction {
        let zero = *input_mint == self.mint0;
        let (in_mint, out_mint) = if zero { (self.mint0, self.mint1) } else { (self.mint1, self.mint0) };
        let (in_prog, out_prog) = if zero { (self.prog0, self.prog1) } else { (self.prog1, self.prog0) };
        let (in_vault, out_vault) = if zero { (self.vault0, self.vault1) } else { (self.vault1, self.vault0) };
        let mut data = vec![143, 190, 90, 218, 196, 30, 51, 222];
        data.extend_from_slice(&amount_in.to_le_bytes());
        data.extend_from_slice(&1u64.to_le_bytes());
        Instruction {
            program_id: RAYDIUM,
            accounts: vec![
                AccountMeta::new_readonly(*owner, true), AccountMeta::new_readonly(ray_pda(&[b"vault_and_lp_mint_auth_seed"]), false),
                AccountMeta::new_readonly(AMM_CONFIG, false), AccountMeta::new(self.pool, false),
                AccountMeta::new(ata(owner, &in_mint, &in_prog), false), AccountMeta::new(ata(owner, &out_mint, &out_prog), false),
                AccountMeta::new(in_vault, false), AccountMeta::new(out_vault, false),
                AccountMeta::new_readonly(in_prog, false), AccountMeta::new_readonly(out_prog, false),
                AccountMeta::new_readonly(in_mint, false), AccountMeta::new_readonly(out_mint, false), AccountMeta::new(self.observation, false),
            ],
            data,
        }
    }
}

/// (balance, fee withheld in the account) of a Reserve Token account.
fn rt_account(env: &Env, account: &Pubkey) -> (u64, u64) {
    let a = env.svm.get_account(account).expect("token account");
    let s = StateWithExtensions::<spl_token_2022::state::Account>::unpack(&a.data).unwrap();
    let withheld = s.get_extension::<TransferFeeAmount>().map(|f| u64::from(f.withheld_amount)).unwrap_or(0);
    (s.base.amount, withheld)
}

fn usdc_balance(env: &Env, owner: &Pubkey) -> u64 {
    env.bal(&ata(owner, &USDC, &TOKEN))
}

/// Token-2022's fee on a transfer of `amount` at `bps`: rounded up.
fn fee(amount: u64, bps: u64) -> u64 {
    (amount * bps).div_ceil(10_000)
}

/// One buy and one sell through the real pool; returns what each withheld.
fn buy_and_sell(env: &mut Env, p: &Pool, trader: &Keypair, usdc_in: u64, rt_in: u64, bps: u64, label: &str) -> (u64, u64) {
    let t = trader.pubkey();
    let trader_rt = ata(&t, &env.rt_mint, &TOKEN22);
    let vault = p.rt_vault(&env.rt_mint);

    // BUY: USDC in, Reserve Token out of the pool vault into the trader's account.
    let (rt0, w0) = rt_account(env, &trader_rt);
    let (vault0, _) = rt_account(env, &vault);
    env.send(&[p.swap(&t, &USDC, usdc_in)], &[trader]).unwrap_or_else(|e| panic!("FAIL {label} buy: {e}"));
    let (rt1, w1) = rt_account(env, &trader_rt);
    let (vault1, _) = rt_account(env, &vault);
    let gross = vault0 - vault1;
    let buy_fee = w1 - w0;
    assert_eq!(buy_fee, fee(gross, bps), "FAIL {label} buy: the token must withhold {bps} bps of the {gross} the pool paid out");
    assert_eq!(rt1 - rt0, gross - buy_fee, "FAIL {label} buy: the trader receives the payout less the tax");
    println!("PASS {label} BUY : pool paid {gross} RT, {buy_fee} withheld ({:.2}%) in the buyer's account, buyer got {}", buy_fee as f64 * 100.0 / gross as f64, rt1 - rt0);

    // SELL: Reserve Token in from the trader into the pool vault, USDC out.
    let (_, vw0) = rt_account(env, &vault);
    let (vault2, _) = rt_account(env, &vault);
    let (rt2, _) = rt_account(env, &trader_rt);
    let usdc_before = usdc_balance(env, &t);
    env.send(&[p.swap(&t, &env.rt_mint, rt_in)], &[trader]).unwrap_or_else(|e| panic!("FAIL {label} sell: {e}"));
    let (vault3, vw1) = rt_account(env, &vault);
    let (rt3, _) = rt_account(env, &trader_rt);
    let sell_fee = vw1 - vw0;
    assert_eq!(rt2 - rt3, rt_in, "FAIL {label} sell: the trader spends exactly the amount sold");
    assert_eq!(sell_fee, fee(rt_in, bps), "FAIL {label} sell: the token must withhold {bps} bps of the {rt_in} sold");
    assert_eq!(vault3 - vault2, rt_in - sell_fee, "FAIL {label} sell: the pool receives the amount less the tax");
    println!("PASS {label} SELL: trader sold {rt_in} RT, {sell_fee} withheld ({:.2}%) in the pool vault, pool got {}, trader got {} USDC",
        sell_fee as f64 * 100.0 / rt_in as f64, vault3 - vault2, usdc_balance(env, &t) - usdc_before);
    (buy_fee, sell_fee)
}

pub fn run() {
    let (Some(cpmm), Some(cfg), Some(perm), Some(pool_fee)) =
        (fixture("raydium_cpmm.so"), fixture("amm_config.bin"), fixture("permission.bin"), fixture("pool_fee.bin"))
    else {
        println!("SKIP real Raydium buy/sell: no fixtures (node fetch_raydium_fixtures.mjs)");
        return;
    };
    let mut env = setup();
    let a = env.admin.insecure_clone();
    let k = env.keeper.insecure_clone();
    env.svm.add_program(RAYDIUM, &cpmm).expect("load Raydium CPMM");
    let raydium = |data: Vec<u8>| Account { lamports: 10_000_000, data, owner: RAYDIUM, executable: false, rent_epoch: 0 };
    env.svm.set_account(AMM_CONFIG, raydium(cfg)).unwrap();
    // A wrapped-SOL account: its lamports must cover its recorded amount plus rent, as on Mainnet.
    let wsol_lamports = u64::from_le_bytes(pool_fee[64..72].try_into().unwrap()) + u64::from_le_bytes(pool_fee[109..117].try_into().unwrap());
    env.svm.set_account(POOL_FEE, Account { lamports: wsol_lamports, data: pool_fee, owner: TOKEN, executable: false, rent_epoch: 0 }).unwrap();
    feed::install_usdc(&mut env);

    // The launching wallet, with Mainnet's permission account re-addressed to it.
    let payer = Keypair::new();
    let pk = payer.pubkey();
    env.svm.airdrop(&pk, 100_000_000_000).unwrap();
    let mut perm = perm;
    perm[8..40].copy_from_slice(pk.as_ref());
    env.svm.set_account(ray_pda(&[b"permission", pk.as_ref()]), raydium(perm)).unwrap();

    let trader = Keypair::new();
    let t = trader.pubkey();
    env.svm.airdrop(&t, 10_000_000_000).unwrap();
    for owner in [pk, t] {
        let usdc_ata = CreateAssociatedTokenAccount::new(&mut env.svm, &a, &USDC).owner(&owner).send().unwrap();
        MintTo::new(&mut env.svm, &a, &USDC, &usdc_ata, 50_000_000).send().unwrap();
    }
    // Pool liquidity and the trader's first Reserve Tokens come from the manager.
    let admin_rt = rt_balance(&env, &a.pubkey());
    env.send(&tradetax::trade(&env, &pk, admin_rt / 2), &[&a]).expect("fund the payer");
    env.send(&tradetax::trade(&env, &t, 500_000), &[&a]).expect("fund the trader");
    let payer_rt = rt_balance(&env, &pk);

    let revenue = pda(&[ROUTER_SEED, env.reserve.as_ref()]);
    let p = Pool::new(env.rt_mint);
    let c = Ctx {
        revenue, terms: pda(&[TERMS_SEED, revenue.as_ref()]), trade_tax: pda(&[TRADE_TAX_SEED, env.reserve.as_ref()]), pool: p.pool,
        creator_fee_share: ray_pda(&[b"creator_fee_share", revenue.as_ref(), AMM_CONFIG.as_ref()]),
    };
    // 1% buy / 1% sell (one rate both ways), 25% of the creator's 80% to holders.
    env.send(&[p.initialize(&pk, &revenue, payer_rt, 5_000_000), configure_v2(&env, &c, 100, 100, 2_500), enable(&env, &c)], &[&payer, &a])
        .expect("FAIL launch: initialize_with_permission + configure v2 + enable_trade_tax in one transaction");
    let (now, newer, _, _) = mint_fee(&env);
    assert_eq!((now, newer), (15, 115));
    println!("PASS launch on real Raydium CPMM: pool {} opened, token fee 0.15% now, 1.15% from epoch +2", p.pool);
    feed::warp(&mut env, 10);

    // The harness uses one wallet for the protocol treasury and the creator;
    // give the creator its own so the payouts can be told apart.
    let creator = Pubkey::new_unique();
    let mut acct = env.svm.get_account(&c.trade_tax).unwrap();
    acct.data[8 + 64..8 + 96].copy_from_slice(creator.as_ref());
    env.svm.set_account(c.trade_tax, acct).unwrap();
    let trader_rt = ata(&t, &env.rt_mint, &TOKEN22);
    let vault = p.rt_vault(&env.rt_mint);
    let harvest = |env: &Env| -> Vec<Pubkey> {
        [trader_rt, vault, ata(&pk, &env.rt_mint, &TOKEN22), ata(&env.admin.pubkey(), &env.rt_mint, &TOKEN22), ata(&creator, &env.rt_mint, &TOKEN22)]
            .into_iter().filter(|x| env.svm.get_account(x).is_some()).collect()
    };

    // Before the switch: 0.15% on both sides, all of it SSR's (the keeper's daily run).
    let (b0, s0) = buy_and_sell(&mut env, &p, &trader, 1_000_000, 200_000, 15, "before the switch (0.15%)");
    env.send(&[collect(&env, &c, &creator, &harvest(&env))], &[&k]).expect("FAIL collect before the switch");
    let t0: TradeTax = env.read(&c.trade_tax).unwrap();
    assert_eq!((t0.total_creator, t0.total_burned), (0, 0), "0.15%-era fees are all SSR's");
    assert!(t0.total_protocol >= b0 + s0);
    println!("PASS before the switch: buy {b0} + sell {s0} withheld, all collected to SSR ({})", t0.total_protocol);

    // Two epochs later: 1.15% on both sides.
    let mut clock: Clock = env.svm.get_sysvar();
    clock.epoch += 2;
    clock.slot += 1;
    env.svm.set_sysvar(&clock);
    assert_eq!(mint_fee(&env).0, 115);
    // The SSR payout above paid its own 0.15% fee, still withheld; it is harvested with the next run.
    let (_, _, on_mint_before, _) = mint_fee(&env);
    let leftover: u64 = harvest(&env).iter().map(|x| rt_account(&env, x).1).sum::<u64>() + on_mint_before;

    let (b1, s1) = buy_and_sell(&mut env, &p, &trader, 1_000_000, 200_000, 115, "after the switch (1.15%)");
    let supply0 = mint_fee(&env).3;
    env.send(&[collect(&env, &c, &creator, &harvest(&env))], &[&k]).expect("FAIL collect after the switch");
    let t1: TradeTax = env.read(&c.trade_tax).unwrap();
    let (ssr, cr, burned) = (t1.total_protocol - t0.total_protocol, t1.total_creator, t1.total_burned);
    let withheld = b1 + s1 + leftover;
    assert_eq!(ssr + cr + burned, withheld, "every withheld unit is paid out or burned");
    let (es, ec, eb) = ssr_protocol::instructions::trade_tax::trade_tax_split(withheld, 115, 15, 2_500);
    assert_eq!((ssr, cr, burned), (es, ec, eb));
    assert_eq!(supply0 - mint_fee(&env).3, burned, "the holder share is burned");
    println!("PASS after the switch: buy {b1} + sell {s1} (+{leftover} payout fees) = {withheld} withheld -> SSR {ssr}, creator {cr}, burned for holders {burned}");
    println!("PASS buy and sell are both taxed at the full rate on real Raydium swaps, and collect_trade_tax harvests the pool vault (sells) and buyer accounts (buys)");
}
