#[test]
fn python_and_rust_upgrade_the_same_persisted_data() {
    let output = std::process::Command::new("python3")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/python_compat.py"
        ))
        .arg(env!("CARGO_BIN_EXE_hexbot-core"))
        .output()
        .expect("python3 is required for storage compatibility tests");
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}
