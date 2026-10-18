//! DEC-0250 end-to-end check of the rebalance swap and asset compaction,
//! against the REAL compiled program (target/deploy/ssr_protocol.so) in
//! LiteSVM. Run: `cargo +stable-x86_64-pc-windows-msvc run` from this folder
//! after `cargo-build-sbf`. Every check prints PASS or panics.
//!
//! The Jupiter route is stood in for by a plain token transfer from a
//! "market" wallet into the signer's buy account, between begin and end --
//! exactly the position the real route occupies in the transaction.

use anchor_lang::{AccountDeserialize, InstructionData, ToAccountMetas};
use anchor_lang::prelude::Pubkey;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_spl::associated_token::get_associated_token_address_with_program_id as ata;
use litesvm::LiteSVM;
use litesvm_token::{get_spl_account, spl_token, CreateAssociatedTokenAccount, CreateMint, MintTo};
use solana_keypair::Keypair;
use solana_signer::Signer;
use solana_transaction::Transaction;
use ssr_protocol::constants::*;
use ssr_protocol::state::{RebalanceTicket, Reserve, ReserveAsset};

const PID: Pubkey = ssr_protocol::ID;
const TOKEN: Pubkey = anchor_spl::token::ID;
const TOKEN22: Pubkey = anchor_spl::token_2022::ID;

fn pda(seeds: &[&[u8]]) -> Pubkey {
    Pubkey::find_program_address(seeds, &PID).0
}

struct Env {
    svm: LiteSVM,
    admin: Keypair,
    keeper: Keypair,
    market: Keypair,
    reserve: Pubkey,
    rt_mint: Pubkey,
    mints: Vec<Pubkey>, // A, B, C
}

impl Env {
    fn send(&mut self, ixs: &[Instruction], signers: &[&Keypair]) -> Result<(), String> {
        let tx = Transaction::new_signed_with_payer(ixs, Some(&signers[0].pubkey()), signers, self.svm.latest_blockhash());
        let r = self.svm.send_transaction(tx).map(|_| ()).map_err(|e| format!("{:?} | {}", e.err, e.meta.logs.iter().filter(|l| l.contains("Error") || l.contains("failed")).cloned().collect::<Vec<_>>().join(" / ")));
        self.svm.expire_blockhash();
        r
    }
    fn bal(&self, acct: &Pubkey) -> u64 {
        get_spl_account::<spl_token::state::Account>(&self.svm, acct).map(|a| a.amount).unwrap_or(0)
    }
    fn vault(&self, mint: &Pubkey) -> Pubkey {
        pda(&[RESERVE_VAULT_SEED, self.reserve.as_ref(), mint.as_ref()])
    }
    fn reserve_asset(&self, mint: &Pubkey) -> Pubkey {
        pda(&[RESERVE_ASSET_SEED, self.reserve.as_ref(), mint.as_ref()])
    }
    fn read<T: AccountDeserialize>(&self, key: &Pubkey) -> Option<T> {
        let acct = self.svm.get_account(key)?;
        if acct.data.is_empty() {
            return None;
        }
        T::try_deserialize(&mut &acct.data[..]).ok()
    }
    fn begin_ix(&self, signer: &Pubkey, sell: &Pubkey, buy: &Pubkey, amount_in: u64, min_out: u64, quote: &Pubkey) -> Instruction {
        Instruction {
            program_id: PID,
            accounts: ssr_protocol::accounts::RebalanceSwapBegin {
                reserve: self.reserve,
                delegate: pda(&[DELEGATE_SEED, self.reserve.as_ref(), signer.as_ref()]),
                signer: *signer,
                reserve_asset_sell: self.reserve_asset(sell),
                vault_sell: self.vault(sell),
                mint_sell: *sell,
                signer_sell_account: ata(signer, sell, &TOKEN),
                reserve_asset_buy: self.reserve_asset(buy),
                vault_buy: self.vault(buy),
                mint_buy: *buy,
                signer_buy_account: ata(signer, buy, &TOKEN),
                vault_authority: pda(&[VAULT_AUTHORITY_SEED, self.reserve.as_ref()]),
                ticket: pda(&[REBALANCE_TICKET_SEED, self.reserve.as_ref()]),
                settlement_keeper_config: pda(&[SETTLEMENT_KEEPER_CONFIG_SEED]),
                fee_quote_signer: *quote,
                instructions_sysvar: anchor_lang::pubkey!("Sysvar1nstructions1111111111111111111111111"),
                token_program_sell: TOKEN,
                system_program: anchor_lang::system_program::ID,
            }
            .to_account_metas(None),
            data: ssr_protocol::instruction::RebalanceSwapBegin { amount_in, min_out }.data(),
        }
    }
    fn end_ix(&self, signer: &Pubkey, buy: &Pubkey) -> Instruction {
        Instruction {
            program_id: PID,
            accounts: ssr_protocol::accounts::RebalanceSwapEnd {
                reserve: self.reserve,
                signer: *signer,
                ticket: pda(&[REBALANCE_TICKET_SEED, self.reserve.as_ref()]),
                mint_buy: *buy,
                signer_buy_account: ata(signer, buy, &TOKEN),
                vault_buy: self.vault(buy),
                token_program_buy: TOKEN,
            }
            .to_account_metas(None),
            data: ssr_protocol::instruction::RebalanceSwapEnd {}.data(),
        }
    }
    /// The stand-in for the Jupiter route: the market pays `amount` of `buy` to the signer.
    fn swap_ix(&self, signer: &Pubkey, buy: &Pubkey, amount: u64) -> Instruction {
        spl_token::instruction::transfer(&TOKEN, &ata(&self.market.pubkey(), buy, &TOKEN), &ata(signer, buy, &TOKEN), &self.market.pubkey(), &[], amount).unwrap()
    }
    fn legs(&self, owner: &Pubkey, order: &[Pubkey]) -> Vec<AccountMeta> {
        order
            .iter()
            .flat_map(|m| {
                vec![
                    AccountMeta::new(self.reserve_asset(m), false),
                    AccountMeta::new(self.vault(m), false),
                    AccountMeta::new(ata(owner, m, &TOKEN), false),
                    AccountMeta::new_readonly(*m, false),
                    AccountMeta::new_readonly(TOKEN, false),
                ]
            })
            .collect()
    }
}

fn setup() -> Env {
    let mut svm = LiteSVM::new();
    svm.add_program_from_file(PID, "../../target/deploy/ssr_protocol.so").expect("build the program first (cargo-build-sbf)");
    let admin = Keypair::new();
    let keeper = Keypair::new();
    let market = Keypair::new();
    for k in [&admin, &keeper, &market] {
        svm.airdrop(&k.pubkey(), 100_000_000_000).unwrap();
    }
    let mints: Vec<Pubkey> = (0..3).map(|_| CreateMint::new(&mut svm, &admin).decimals(6).send().unwrap()).collect();
    let protocol_config = pda(&[PROTOCOL_CONFIG_SEED]);
    let reserve = pda(&[RESERVE_SEED, &0u64.to_le_bytes()]);
    let rt_mint = pda(&[RESERVE_TOKEN_MINT_SEED, reserve.as_ref()]);
    let mut env = Env { svm, admin, keeper, market, reserve, rt_mint, mints };
    let a = env.admin.insecure_clone();
    let admin_pk = a.pubkey();

    env.send(
        &[Instruction {
            program_id: PID,
            accounts: ssr_protocol::accounts::InitializeProtocol { protocol_config, authority: admin_pk, system_program: anchor_lang::system_program::ID }.to_account_metas(None),
            data: ssr_protocol::instruction::InitializeProtocol { admin_2: Pubkey::new_unique(), max_reserve_assets: 12, default_protocol_fee_bps: 50, default_protocol_fee_destination: admin_pk }.data(),
        }],
        &[&a],
    )
    .expect("initialize_protocol");

    env.send(
        &[Instruction {
            program_id: PID,
            accounts: ssr_protocol::accounts::CreateReserve {
                protocol_config,
                reserve,
                mint_authority: pda(&[MINT_AUTHORITY_SEED, reserve.as_ref()]),
                reserve_token_mint: rt_mint,
                transfer_fee_authority: pda(&[TRANSFER_FEE_AUTHORITY_SEED]),
                manager: admin_pk,
                token_program: TOKEN22,
                system_program: anchor_lang::system_program::ID,
            }
            .to_account_metas(None),
            data: ssr_protocol::instruction::CreateReserve { metadata_uri: "https://ssr.fun/test".into(), mint_fee_bps: 50, redemption_fee_bps: 0, annual_tvl_fee_bps: 100, fee_destination: admin_pk }.data(),
        }],
        &[&a],
    )
    .expect("create_reserve");

    // A and B registered and seeded; C added later as the rebalance target.
    let (m0, m1, m2) = (env.mints[0], env.mints[1], env.mints[2]);
    for m in [m0, m1] {
        env.send(
            &[Instruction {
                program_id: PID,
                accounts: ssr_protocol::accounts::InitializeReserveAsset {
                    protocol_config,
                    reserve,
                    reserve_asset: env.reserve_asset(&m),
                    asset_mint: m,
                    vault: env.vault(&m),
                    vault_authority: pda(&[VAULT_AUTHORITY_SEED, reserve.as_ref()]),
                    manager: admin_pk,
                    token_program: TOKEN,
                    system_program: anchor_lang::system_program::ID,
                }
                .to_account_metas(None),
                data: ssr_protocol::instruction::InitializeReserveAsset { target_weight_bps: 5000 }.data(),
            }],
            &[&a],
        )
        .expect("initialize_reserve_asset");
    }
    for m in [m0, m1, m2] {
        let admin_ata = CreateAssociatedTokenAccount::new(&mut env.svm, &a, &m).owner(&admin_pk).send().unwrap();
        MintTo::new(&mut env.svm, &a, &m, &admin_ata, 10_000_000).send().unwrap();
        let mk = env.market.pubkey();
        let market_ata = CreateAssociatedTokenAccount::new(&mut env.svm, &a, &m).owner(&mk).send().unwrap();
        MintTo::new(&mut env.svm, &a, &m, &market_ata, 10_000_000).send().unwrap();
    }
    let mut seed_metas = ssr_protocol::accounts::SeedReserve {
        protocol_config,
        reserve,
        reserve_token_mint: rt_mint,
        mint_authority: pda(&[MINT_AUTHORITY_SEED, reserve.as_ref()]),
        manager_reserve_token_account: ata(&admin_pk, &rt_mint, &TOKEN22),
        manager: admin_pk,
        fee_settlement: pda(&[FEE_SETTLEMENT_SEED, reserve.as_ref()]),
        fee_vault: ata(&pda(&[FEE_VAULT_AUTHORITY_SEED, reserve.as_ref()]), &rt_mint, &TOKEN22),
        fee_vault_authority: pda(&[FEE_VAULT_AUTHORITY_SEED, reserve.as_ref()]),
        tvl_accrual: pda(&[TVL_ACCRUAL_SEED, reserve.as_ref()]),
        token_program: TOKEN22,
        associated_token_program: anchor_spl::associated_token::ID,
        system_program: anchor_lang::system_program::ID,
    }
    .to_account_metas(None);
    seed_metas.extend(env.legs(&admin_pk, &[m0, m1]));
    env.send(
        &[Instruction { program_id: PID, accounts: seed_metas, data: ssr_protocol::instruction::SeedReserve { seed_amounts: vec![1_000_000, 2_000_000], initial_reserve_tokens: 10_000_000 }.data() }],
        &[&a],
    )
    .expect("seed_reserve");

    let keeper_pk = env.keeper.pubkey();
    env.send(
        &[Instruction {
            program_id: PID,
            accounts: ssr_protocol::accounts::SetFeeSettlementKeeper { protocol_config, settlement_keeper_config: pda(&[SETTLEMENT_KEEPER_CONFIG_SEED]), authority: admin_pk, system_program: anchor_lang::system_program::ID }.to_account_metas(None),
            data: ssr_protocol::instruction::SetFeeSettlementKeeper { new_keeper: keeper_pk }.data(),
        }],
        &[&a],
    )
    .expect("set_fee_settlement_keeper");

    // Register C at zero balance (what the app's Submit Rebalance already does).
    env.send(
        &[Instruction {
            program_id: PID,
            accounts: ssr_protocol::accounts::AddReserveAssetActive {
                protocol_config,
                reserve,
                reserve_asset: env.reserve_asset(&m2),
                asset_mint: m2,
                vault: env.vault(&m2),
                vault_authority: pda(&[VAULT_AUTHORITY_SEED, reserve.as_ref()]),
                delegate: pda(&[DELEGATE_SEED, reserve.as_ref(), admin_pk.as_ref()]),
                signer: admin_pk,
                token_program: TOKEN,
                system_program: anchor_lang::system_program::ID,
            }
            .to_account_metas(None),
            data: ssr_protocol::instruction::AddReserveAssetActive { target_weight_bps: 0 }.data(),
        }],
        &[&a],
    )
    .expect("add_reserve_asset_active");
    env
}

fn expect_err(r: Result<(), String>, needle: &str, what: &str) {
    match r {
        Ok(()) => panic!("FAIL {what}: succeeded but must fail"),
        Err(e) => {
            assert!(e.contains(needle), "FAIL {what}: wrong error, wanted {needle}, got {e}");
            println!("PASS {what} (refused: {needle})");
        }
    }
}

fn main() {
    let mut env = setup();
    let a = env.admin.insecure_clone();
    let k = env.keeper.insecure_clone();
    let m = env.market.insecure_clone();
    let admin = a.pubkey();
    let keeper = k.pubkey();
    let (ma, mb, mc) = (env.mints[0], env.mints[1], env.mints[2]);
    let ticket = pda(&[REBALANCE_TICKET_SEED, env.reserve.as_ref()]);
    assert_eq!(env.bal(&env.vault(&ma)), 1_000_000);
    println!("PASS setup: Reserve seeded with A=1,000,000 B=2,000,000, C registered empty");

    // Custom error numbers (errors.rs, 6000 + index).
    let end_missing = "Custom(6076)";
    let min_not_met = "Custom(6077)";
    let exceeds = "Custom(6078)";

    // 1. begin with no end in the transaction.
    let r = env.send(&[env.begin_ix(&admin, &ma, &mc, 500_000, 1, &keeper)], &[&a, &k]);
    expect_err(r, end_missing, "begin without end");

    // 2. an SSR instruction (a second begin) between begin and end.
    let r = env.send(&[env.begin_ix(&admin, &ma, &mc, 100, 1, &keeper), env.begin_ix(&admin, &mb, &mc, 100, 1, &keeper), env.end_ix(&admin, &mc)], &[&a, &k]);
    expect_err(r, end_missing, "another SSR instruction between begin and end");

    // 3. swap delivers less than min_out.
    let r = env.send(&[env.begin_ix(&admin, &ma, &mc, 500_000, 400_000, &keeper), env.swap_ix(&admin, &mc, 399_999), env.end_ix(&admin, &mc)], &[&a, &k, &m]);
    expect_err(r, min_not_met, "swap output below the quoted minimum");
    assert_eq!(env.bal(&env.vault(&ma)), 1_000_000, "a failed swap must leave the sell vault untouched");

    // 4. no quote signer / wrong quote signer.
    let impostor = Keypair::new();
    env.svm.airdrop(&impostor.pubkey(), 1_000_000_000).unwrap();
    let r = env.send(&[env.begin_ix(&admin, &ma, &mc, 1000, 1, &impostor.pubkey()), env.swap_ix(&admin, &mc, 1000), env.end_ix(&admin, &mc)], &[&a, &impostor, &m]);
    expect_err(r, "Custom(6068)", "a quote signed by anyone but SSR's quote signer");

    // 5. not the manager (and no co-manager record).
    let stranger = Keypair::new();
    env.svm.airdrop(&stranger.pubkey(), 1_000_000_000).unwrap();
    for mint in [ma, mc] {
        let sp = stranger.pubkey();
        CreateAssociatedTokenAccount::new(&mut env.svm, &a, &mint).owner(&sp).send().unwrap();
    }
    let sp = stranger.pubkey();
    let r = env.send(&[env.begin_ix(&sp, &ma, &mc, 1000, 1, &keeper), env.swap_ix(&sp, &mc, 1000), env.end_ix(&sp, &mc)], &[&stranger, &k, &m]);
    expect_err(r, "Custom(6032)", "a wallet that is not the Manager");

    // 6. more than the vault holds.
    let r = env.send(&[env.begin_ix(&admin, &ma, &mc, 1_000_001, 1, &keeper), env.swap_ix(&admin, &mc, 1), env.end_ix(&admin, &mc)], &[&a, &k, &m]);
    expect_err(r, exceeds, "more than the vault holds");

    // 7. THE REAL REBALANCE: all of A into C in one transaction.
    let admin_c_before = env.bal(&ata(&admin, &mc, &TOKEN));
    let admin_a_before = env.bal(&ata(&admin, &ma, &TOKEN));
    env.send(&[env.begin_ix(&admin, &ma, &mc, 1_000_000, 900_000, &keeper), env.swap_ix(&admin, &mc, 950_000), env.end_ix(&admin, &mc)], &[&a, &k, &m])
        .expect("FAIL rebalance swap A -> C");
    assert_eq!(env.bal(&env.vault(&ma)), 0, "A vault must be empty");
    assert_eq!(env.bal(&env.vault(&mc)), 950_000, "C vault must hold what the swap delivered");
    assert_eq!(env.bal(&ata(&admin, &mc, &TOKEN)), admin_c_before, "only what the swap delivered is deposited -- the Manager's own C is untouched");
    assert_eq!(env.bal(&ata(&admin, &ma, &TOKEN)), admin_a_before + 1_000_000, "the lent A sits where the swap route would spend it");
    assert!(env.read::<RebalanceTicket>(&ticket).is_none(), "ticket closed");
    println!("PASS rebalance swap: A vault 1,000,000 -> 0, C vault 0 -> 950,000, ticket closed");

    // 8. remove a non-empty asset is refused.
    let remove = |env: &Env, mint: &Pubkey, last: Option<Pubkey>| Instruction {
        program_id: PID,
        accounts: ssr_protocol::accounts::RemoveReserveAssetCompact {
            reserve: env.reserve,
            reserve_asset: env.reserve_asset(mint),
            asset_mint: *mint,
            vault: env.vault(mint),
            last_reserve_asset: last.map(|l| env.reserve_asset(&l)),
            vault_authority: pda(&[VAULT_AUTHORITY_SEED, env.reserve.as_ref()]),
            manager: admin,
            delegate: pda(&[DELEGATE_SEED, env.reserve.as_ref(), admin.as_ref()]),
            signer: admin,
            token_program: TOKEN,
        }
        .to_account_metas(None),
        data: ssr_protocol::instruction::RemoveReserveAssetCompact {}.data(),
    };
    let r = env.send(&[remove(&env, &mb, Some(mc))], &[&a]);
    expect_err(r, "Custom(6017)", "removing an asset that still holds value");

    // 9. remove the emptied FIRST asset: C (last) takes position 0.
    env.send(&[remove(&env, &ma, Some(mc))], &[&a]).expect("FAIL remove emptied first asset");
    let rc: ReserveAsset = env.read(&env.reserve_asset(&mc)).unwrap();
    let rb: ReserveAsset = env.read(&env.reserve_asset(&mb)).unwrap();
    let res: Reserve = env.read(&env.reserve).unwrap();
    assert_eq!((rc.order_index, rb.order_index, res.asset_count), (0, 1, 2));
    assert!(env.read::<ReserveAsset>(&env.reserve_asset(&ma)).is_none() && env.svm.get_account(&env.vault(&ma)).map(|x| x.lamports).unwrap_or(0) == 0);
    println!("PASS compact remove: A gone (record + vault closed), C moved to position 0, B stays at 1, 2 assets");

    // 10. the Reserve still works in the new order: redeem 10% in kind.
    let mut red = ssr_protocol::accounts::RedeemReserveTokensInKind {
        reserve: env.reserve,
        reserve_token_mint: env.rt_mint,
        vault_authority: pda(&[VAULT_AUTHORITY_SEED, env.reserve.as_ref()]),
        redeemer_reserve_token_account: ata(&admin, &env.rt_mint, &TOKEN22),
        redeemer: admin,
        manager_fee_recipients: None,
        tvl_accrual: pda(&[TVL_ACCRUAL_SEED, env.reserve.as_ref()]),
        mint_authority: pda(&[MINT_AUTHORITY_SEED, env.reserve.as_ref()]),
        fee_settlement: pda(&[FEE_SETTLEMENT_SEED, env.reserve.as_ref()]),
        fee_vault: ata(&pda(&[FEE_VAULT_AUTHORITY_SEED, env.reserve.as_ref()]), &env.rt_mint, &TOKEN22),
        fee_vault_authority: pda(&[FEE_VAULT_AUTHORITY_SEED, env.reserve.as_ref()]),
        token_program: TOKEN22,
        associated_token_program: anchor_spl::associated_token::ID,
        system_program: anchor_lang::system_program::ID,
    }
    .to_account_metas(None);
    red.extend(env.legs(&admin, &[mc, mb]));
    let (c0, b0) = (env.bal(&env.vault(&mc)), env.bal(&env.vault(&mb)));
    env.send(&[Instruction { program_id: PID, accounts: red, data: ssr_protocol::instruction::RedeemReserveTokensInKind { reserve_tokens_to_redeem: 1_000_000, min_asset_amounts_out: vec![0, 0] }.data() }], &[&a])
        .expect("FAIL redeem after compaction");
    let (c1, b1) = (env.bal(&env.vault(&mc)), env.bal(&env.vault(&mb)));
    assert!(c1 < c0 && b1 < b0, "both remaining assets pay out");
    println!("PASS redeem after compaction: C {c0} -> {c1}, B {b0} -> {b1} (pro-rata, new order accepted)");


    println!("ALL PASS");
}
