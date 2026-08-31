//! Checks the addresses derived by the SDK against the program's seeds.
//!
//! A mismatch here fails neither at build time nor in a logic test: the client would simply
//! look for the account somewhere other than where the program creates it, and it would look
//! like "account not found" — the most expensive class of bug, because the search starts in the wrong place.

use std::str::FromStr;

use anchor_lang::prelude::Pubkey;
use serde_json::Value;

use treasury_runway::state::YieldSource;

fn fixture() -> Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/pdas.json");
    let raw = std::fs::read_to_string(path).expect("fixtures/pdas.json");
    serde_json::from_str(&raw).expect("valid json")
}

fn pubkey(v: &Value) -> Pubkey {
    Pubkey::from_str(v.as_str().expect("string")).expect("base58")
}

#[test]
fn sdk_addresses_match_the_program_seeds() {
    let f = fixture();

    let program_id = pubkey(&f["program_id"]);
    assert_eq!(program_id, treasury_runway::ID, "the SDK takes the program id from the IDL");

    let asset_mint = pubkey(&f["asset_mint"]);
    let source = YieldSource::Deterministic { rate_bps: 0 };

    let (market, _) = Pubkey::find_program_address(
        &[b"market", asset_mint.as_ref(), &source.seed()],
        &program_id,
    );
    assert_eq!(market, pubkey(&f["market"]), "market");

    let (vault, _) = Pubkey::find_program_address(&[b"vault", market.as_ref()], &program_id);
    assert_eq!(vault, pubkey(&f["vault"]), "vault");

    let (buffer, _) = Pubkey::find_program_address(&[b"buffer", market.as_ref()], &program_id);
    assert_eq!(buffer, pubkey(&f["buffer_vault"]), "buffer");

    for case in f["epochs"].as_array().expect("epochs") {
        let maturity_ts = case["maturity_ts"].as_i64().expect("maturity_ts");
        let (epoch, _) = Pubkey::find_program_address(
            &[b"epoch", market.as_ref(), &maturity_ts.to_le_bytes()],
            &program_id,
        );
        assert_eq!(epoch, pubkey(&case["address"]), "epoch {maturity_ts}");
    }

    // The ladder number is an unsigned u64, unlike the maturity date. It is easy to get
    // wrong here precisely because both are eight bytes.
    let owner = pubkey(&f["ladder_owner"]);
    let seed = f["ladder_seed"].as_u64().expect("ladder_seed");
    let (ladder, _) =
        Pubkey::find_program_address(&[b"ladder", owner.as_ref(), &seed.to_le_bytes()], &program_id);
    assert_eq!(ladder, pubkey(&f["ladder"]), "ladder");

    for case in f["rungs"].as_array().expect("rungs") {
        let maturity_ts = case["maturity_ts"].as_i64().expect("maturity_ts");
        let (epoch, _) = Pubkey::find_program_address(
            &[b"epoch", market.as_ref(), &maturity_ts.to_le_bytes()],
            &program_id,
        );
        let (rung, _) = Pubkey::find_program_address(
            &[b"rung", ladder.as_ref(), epoch.as_ref()],
            &program_id,
        );
        assert_eq!(rung, pubkey(&case["address"]), "rung {maturity_ts}");
    }
}

#[test]
fn source_parameters_stay_out_of_the_market_seeds() {
    // A market with a different base rate is the same market. Otherwise every change
    // of the source rate would spawn a separate vault, while the funds stayed
    // in the previous one.
    let a = YieldSource::Deterministic { rate_bps: 0 };
    let b = YieldSource::Deterministic { rate_bps: 9_999 };

    assert_eq!(a.seed(), b.seed());
}
