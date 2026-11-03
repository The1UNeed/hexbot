// The licenses of the crates hexbot-install links, which `--license` prints.
// Release builds write them with `node scripts/desktop/third-party-notices.mjs
// installer` and pass the file in HEXBOT_THIRD_PARTY_NOTICES; other builds say
// how to get them.
use std::{env, fs, path::Path};

fn main() {
    println!("cargo:rerun-if-env-changed=HEXBOT_THIRD_PARTY_NOTICES");
    let out = Path::new(&env::var_os("OUT_DIR").expect("OUT_DIR")).join("THIRD_PARTY_NOTICES");
    match env::var_os("HEXBOT_THIRD_PARTY_NOTICES") {
        Some(notices) => {
            println!("cargo:rerun-if-changed={}", Path::new(&notices).display());
            fs::copy(&notices, &out).expect("read HEXBOT_THIRD_PARTY_NOTICES");
        }
        None => fs::write(
            &out,
            "THIRD-PARTY NOTICES\n\nThis build of hexbot-install was made from source without them. Release builds include them, and `node scripts/desktop/third-party-notices.mjs installer` writes them from a checkout.\n",
        )
        .expect("write THIRD_PARTY_NOTICES"),
    }
}
