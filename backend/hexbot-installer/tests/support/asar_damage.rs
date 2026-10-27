//! Test-only corruption of the actual package.json entry, preserving all offsets.
use serde_json::Value;
use std::ops::Range;

fn value(bytes: &[u8], at: &mut usize) -> Value {
    while bytes.get(*at).is_some_and(u8::is_ascii_whitespace) {
        *at += 1;
    }
    let mut stream = serde_json::Deserializer::from_slice(&bytes[*at..]).into_iter::<Value>();
    let value = stream
        .next()
        .expect("JSON value")
        .expect("valid JSON value");
    *at += stream.byte_offset();
    value
}
fn version_value(package: &[u8], expected: &str) -> Range<usize> {
    let parsed: Value = serde_json::from_slice(package).expect("real package JSON");
    assert_eq!(
        parsed["version"].as_str(),
        Some(expected),
        "actual top-level packaged version"
    );
    let mut at = 0;
    while package.get(at).is_some_and(u8::is_ascii_whitespace) {
        at += 1;
    }
    assert_eq!(package[at], b'{');
    at += 1;
    loop {
        let key = value(package, &mut at);
        while package.get(at).is_some_and(u8::is_ascii_whitespace) {
            at += 1;
        }
        assert_eq!(package[at], b':');
        at += 1;
        while package.get(at).is_some_and(u8::is_ascii_whitespace) {
            at += 1;
        }
        let start = at;
        let entry = value(package, &mut at);
        if key == "version" {
            assert_eq!(entry.as_str(), Some(expected));
            return start..at;
        }
        while package.get(at).is_some_and(u8::is_ascii_whitespace) {
            at += 1;
        }
        assert_eq!(package[at], b',', "missing top-level version");
        at += 1;
    }
}
pub fn corrupt_package_version(asar: &mut [u8], expected: &str) -> Value {
    let word = |at: usize| {
        u32::from_le_bytes(
            asar.get(at..at + 4)
                .expect("ASAR word bounds")
                .try_into()
                .unwrap(),
        ) as usize
    };
    assert_eq!(word(0), 4);
    let header_end = 16usize.checked_add(word(12)).unwrap();
    let data_start = 8usize.checked_add(word(4)).unwrap();
    assert!(header_end <= data_start && data_start <= asar.len());
    let header: Value = serde_json::from_slice(&asar[16..header_end]).unwrap();
    let entry = &header["files"]["package.json"];
    assert!(entry.get("unpacked").is_none_or(|v| v != true));
    let start = data_start
        .checked_add(entry["offset"].as_str().unwrap().parse::<usize>().unwrap())
        .unwrap();
    let end = start
        .checked_add(usize::try_from(entry["size"].as_u64().unwrap()).unwrap())
        .unwrap();
    let package = asar.get(start..end).expect("ASAR package bounds");
    let range = version_value(package, expected);
    assert!(range.len() > 2 && package[range.start] == b'"' && package[range.end - 1] == b'"');
    let compact = package.windows(11).any(|w| w == b"\"version\":\"");
    let diagnostic = serde_json::json!({"topLevelVersion":expected,"packageBytes":package.len(),"compactVersionField":compact,"valueOffset":range.start,"valueBytes":range.len(),"asarBytes":asar.len()});
    // Replace one byte inside that value only. No JSON layout, ASAR size,
    // header offsets, nested version fields, or unrelated archive bytes move.
    asar[start + range.start + 1] = b'!';
    diagnostic
}
