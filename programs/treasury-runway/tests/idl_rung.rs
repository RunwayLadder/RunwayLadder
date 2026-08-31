//! A temporary bridge: emits the `Rung` layout in machine form.
//!
//! Anchor puts into the IDL only the accounts mentioned by type in `#[derive(Accounts)]`.
//! Rungs are created from `remaining_accounts` — the treasurer chooses their count,
//! and a fixed set of accounts cannot describe that — so `Rung` does not make it into the
//! IDL, and without it the SDK has nothing to decode a rung with.
//!
//! Writing its layout by hand in TypeScript is not an option: then there are two copies, and
//! they drift silently. Instead, the same `IdlBuild` Anchor uses for the rest of the
//! IDL runs here — the source stays single, and it is in Rust.
//!
//! **This dies in M2.** `redeem_rung`, `roll_rung` and `exit_rung` take
//! `Account<'info, Rung>`, and Anchor will put the type into the IDL itself. Then this file
//! and the `idl-rung` step in `scripts/program-wsl.sh` are deleted together.

#![cfg(feature = "idl-build")]

use std::collections::BTreeMap;

use anchor_lang::idl::types::IdlTypeDef;
use anchor_lang::idl::IdlBuild;
use anchor_lang::Discriminator;

use treasury_runway::state::Rung;

#[test]
fn writes_the_rung_idl_fragment() {
    // `insert_types` pulls in everything the type is made of — in particular
    // `RungStatus`, without which the fragment does not decode.
    let mut types: BTreeMap<String, IdlTypeDef> = BTreeMap::new();
    Rung::insert_types(&mut types);

    let mut defs: Vec<IdlTypeDef> = types.into_values().collect();
    defs.push(Rung::create_type().expect("Rung must have a type definition"));
    defs.sort_by(|a, b| a.name.cmp(&b.name));

    let fragment = serde_json::json!({
        "accounts": [{ "name": "Rung", "discriminator": Rung::DISCRIMINATOR }],
        "types": defs,
    });

    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../target/idl/rung-fragment.json");
    std::fs::write(path, serde_json::to_string_pretty(&fragment).expect("serialises"))
        .expect("target/idl must exist — the fragment is written after anchor build");
}
