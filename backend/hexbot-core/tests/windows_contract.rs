#![cfg(windows)]
//! Native CI only. Requires the real signed update ZIP generated from this build.
#[tokio::test]
#[ignore = "requires HEXBOT_WINDOWS_UPDATE_ROOT with a real locally built runtime"]
async fn signed_zip_update_and_connect_executable() {
    hexbot_core::services::windows_contract_tests::windows_contract_signed_zip_update_and_connect_executable().await;
}

#[test]
fn damaged_manifests_cannot_lower_the_native_publication_floor() {
    hexbot_core::services::windows_contract_tests::publication_floor();
}
