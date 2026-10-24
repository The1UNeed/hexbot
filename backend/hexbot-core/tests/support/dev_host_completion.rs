use serde_json::Value;

// A signalled host can still report that descendant completion was unconfirmed.
// Call this on the retained handle snapshot before any fallback cleanup.
pub fn assert_parent_completion(host: &Value) {
    assert_eq!(host["wait"], 0, "Parent-death host did not signal: {host}");
    assert_eq!(
        host["exitCode"], 0,
        "Parent-death host did not acknowledge completion: {host}"
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn complete_containment_cannot_hide_a_parent_only_acknowledgement_failure() {
        let descendants = [
            json!({"wait":0,"exitCode":1}),
            json!({"wait":0,"exitCode":1}),
        ];
        let mut host = json!({"pid":42,"created":"100","wait":0,"exitCode":0});
        assert_parent_completion(&host);
        // Keep the entire tree signalled, as in the old false-positive control.
        // Mutate only the host acknowledgement; containment is still complete.
        for code in [json!(125), json!(126), Value::Null] {
            host["exitCode"] = code;
            assert!(
                descendants
                    .iter()
                    .chain([&host])
                    .all(|process| process["wait"] == 0)
            );
            assert!(
                std::panic::catch_unwind(|| assert_parent_completion(&host)).is_err(),
                "Unconfirmed parent death passed: {host}"
            );
        }
        host["exitCode"] = json!(0);
        for wait in [json!(258), Value::Null] {
            host["wait"] = wait;
            assert!(
                std::panic::catch_unwind(|| assert_parent_completion(&host)).is_err(),
                "Unsignalled/unknown host passed: {host}"
            );
        }
    }
}
