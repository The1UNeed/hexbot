//! A temporary Hexbot home with its workspace beside it; a workdir may never sit inside the home.
#![allow(dead_code)]
use std::path::{Path, PathBuf};

pub struct TestHome {
    root: tempfile::TempDir,
    home: PathBuf,
}
impl TestHome {
    pub fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        std::fs::create_dir(&home).unwrap();
        Self { root, home }
    }
    pub fn path(&self) -> &Path {
        &self.home
    }
    pub fn workspace(&self) -> PathBuf {
        self.root.path().join("workspace")
    }
}

/// Pair test devices through the same code redemption path as clients.
pub fn mint_device(
    home: &Path,
    name: &str,
    platform: &str,
    owner: &str,
) -> hexbot_core::Result<serde_json::Value> {
    let code = hexbot_core::auth::new_code(home, owner)?;
    hexbot_core::auth::redeem_code_from(
        home,
        code["code"].as_str().unwrap(),
        name,
        platform,
        "fixture",
    )
}
