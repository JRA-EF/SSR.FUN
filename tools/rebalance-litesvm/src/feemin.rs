//! DEC-0269: a Reserve configured at a 0% mint fee and a 0% TVL fee still pays
//! the Protocol its 0.5% minimum on both, against the real compiled program.
//! Before DEC-0269 a configured 0% was a real zero fee (no fee shares at all).

use super::*;
use ssr_protocol::state::{FeeSettlement, TvlAccrual};

pub(crate) fn run() {
    let mut env = setup_with_fees(0, 0);
    let a = env.admin.insecure_clone();
    let reserve = env.reserve;
    let settlement = pda(&[FEE_SETTLEMENT_SEED, reserve.as_ref()]);

    // Seed: 10,000,000 gross tokens at the 0.5% floor -> 50,000 fee shares, all Protocol.
    let fs: FeeSettlement = env.read(&settlement).expect("fee settlement after seed");
    assert_eq!((fs.protocol_shares_in_vault, fs.manager_shares_in_vault), (50_000, 0), "0% mint fee pays the Protocol 0.5%");
    let r: Reserve = env.read(&reserve).unwrap();
    assert_eq!((r.fee_config.protocol_fee_share_bps, r.fee_config.manager_fee_share_bps), (50, 0));
    println!("PASS 0% mint fee: seed paid the Protocol 50,000 of 10,000,000 (0.5%), the Manager 0");

    // One day at 10,000,000 supply and the 0.5% floor: ceil(1e7 * 86,400 * 50 / (1e4 * 31,536,000)) = 137.
    feed::warp(&mut env, 86_400);
    let fee_vault_authority = pda(&[FEE_VAULT_AUTHORITY_SEED, reserve.as_ref()]);
    let ix = Instruction {
        program_id: PID,
        accounts: ssr_protocol::accounts::AccrueFees {
            protocol_config: pda(&[PROTOCOL_CONFIG_SEED]),
            reserve,
            reserve_token_mint: env.rt_mint,
            mint_authority: pda(&[MINT_AUTHORITY_SEED, reserve.as_ref()]),
            tvl_accrual: pda(&[TVL_ACCRUAL_SEED, reserve.as_ref()]),
            fee_settlement: settlement,
            fee_vault: ata(&fee_vault_authority, &env.rt_mint, &TOKEN22),
            fee_vault_authority,
            payer: a.pubkey(),
            token_program: TOKEN22,
            associated_token_program: anchor_spl::associated_token::ID,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
        data: ssr_protocol::instruction::AccrueFees {}.data(),
    };
    env.send(&[ix], &[&a]).expect("accrue_fees");
    let fs: FeeSettlement = env.read(&settlement).unwrap();
    assert_eq!((fs.protocol_shares_in_vault, fs.manager_shares_in_vault), (50_000 + 137, 0), "0% TVL fee accrues the Protocol's 0.5%");
    let acc: TvlAccrual = env.read(&pda(&[TVL_ACCRUAL_SEED, reserve.as_ref()])).unwrap();
    assert_eq!(acc.period_supply_seconds, 0);
    println!("PASS 0% TVL fee: one day at 10,000,000 supply accrued 137 to the Protocol (0.5%/yr), the Manager 0");
}
