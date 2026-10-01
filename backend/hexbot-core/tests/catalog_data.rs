use serde_json::Value;

#[test]
fn pi_catalog_matches_the_pinned_runtime() {
    let catalog: Value = serde_json::from_str(include_str!("../src/pi_catalog.json")).unwrap();
    let runtime: Value =
        serde_json::from_str(include_str!("../../pi-runtime/package.json")).unwrap();
    assert_eq!(
        catalog["version"],
        runtime["dependencies"]["@earendil-works/pi-coding-agent"]
    );
    // Pi loads its own nested pi-ai for extensions; the top-level copy only serves
    // the node tests, so it stays out of the shipped runtime.
    assert_eq!(
        catalog["version"],
        runtime["devDependencies"]["@earendil-works/pi-ai"]
    );
    assert!(runtime["dependencies"]["@earendil-works/pi-ai"].is_null());
}
