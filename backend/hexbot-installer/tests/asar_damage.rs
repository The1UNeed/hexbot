#[path = "support/asar_damage.rs"]
mod damage;
#[test]
fn actual_asar_version_damage_handles_compact_pretty_and_nested_duplicate_values() {
    for package in [
        r#"{"nested":{"version":"1.2.3"},"version":"1.2.3","other":"1.2.3"}"#,
        "{\n  \"nested\": {\"version\":\"1.2.3\"},\n  \"version\": \"1.2.3\",\n  \"other\":\"1.2.3\"\n}",
    ] {
        let header = serde_json::to_vec(
            &serde_json::json!({"files":{"package.json":{"offset":"0","size":package.len()}}}),
        )
        .unwrap();
        let size = (header.len() + 11) & !3;
        let mut bytes = Vec::new();
        for word in [4, size as u32, (size - 4) as u32, header.len() as u32] {
            bytes.extend(word.to_le_bytes());
        }
        bytes.extend(header);
        bytes.resize(size + 8, 0);
        bytes.extend(package.as_bytes());
        let original = bytes.clone();
        let diagnostic = damage::corrupt_package_version(&mut bytes, "1.2.3");
        assert_eq!(diagnostic["topLevelVersion"], "1.2.3");
        assert_eq!(bytes.len(), original.len());
        assert_eq!(
            bytes.iter().zip(&original).filter(|(a, b)| a != b).count(),
            1
        );
        let after: serde_json::Value = serde_json::from_slice(&bytes[size + 8..]).unwrap();
        assert_eq!(after["version"], "!.2.3");
        assert_eq!(after["nested"]["version"], "1.2.3");
        assert_eq!(after["other"], "1.2.3");
    }
}
