use serde_json::Value;

#[test]
fn embedded_catalogs_are_valid_and_match_the_pinned_runtime() {
    let catalog: Value = serde_json::from_str(include_str!("../src/pi_catalog.json")).unwrap();
    let runtime: Value =
        serde_json::from_str(include_str!("../../pi-runtime/package.json")).unwrap();
    assert_eq!(
        catalog["version"],
        runtime["dependencies"]["@earendil-works/pi-coding-agent"]
    );
    assert_eq!(
        catalog["version"],
        runtime["dependencies"]["@earendil-works/pi-ai"]
    );
    for source in [
        include_str!("../src/providers.json"),
        include_str!("../src/connectors.json"),
        include_str!("../src/fal_image_models.json"),
    ] {
        let value: Value = serde_json::from_str(source).unwrap();
        assert!(value.is_object() || value.is_array());
    }
}
