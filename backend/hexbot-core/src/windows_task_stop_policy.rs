//! Task Stop wait authority is narrower than attach/kill authority.
use std::io;
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Instances {
    pub state: Option<u8>,
    pub engines: Vec<u32>,
}
impl Instances {
    pub fn parse(text: &str) -> io::Result<Self> {
        if text.len() > 4096 {
            return Err(io::Error::other("Oversized Windows task instances"));
        }
        let raw: serde_json::Value = serde_json::from_str(text).map_err(io::Error::other)?;
        if raw.get("state").is_none() {
            return Err(io::Error::other("Missing Windows task state"));
        }
        let value: Self = serde_json::from_value(raw).map_err(io::Error::other)?;
        if value.state.is_some_and(|state| state > 4)
            || (value.state == Some(4) && value.engines.is_empty())
            || (value.state.is_none() && !value.engines.is_empty())
            || value.engines.len() > 16
            || value
                .engines
                .iter()
                .enumerate()
                .any(|(index, pid)| *pid == 0 || value.engines[..index].contains(pid))
        {
            return Err(io::Error::other(
                "Incomplete Windows task instance identities",
            ));
        }
        Ok(value)
    }
}
pub fn engine_matches(
    created: u64,
    before_query: u64,
    same_owner: bool,
    system_powershell: bool,
) -> bool {
    created != 0 && created <= before_query && same_owner && system_powershell
}
pub struct Child {
    pub parent: u32,
    pub created: u64,
    pub same_owner: bool,
    pub managed_image: bool,
}
impl Child {
    pub fn matches(&self, engine: u32, engine_created: u64, confirmed_parent: Option<u32>) -> bool {
        engine != 0
            && self.parent == engine
            && confirmed_parent == Some(engine)
            && engine_created != 0
            && self.created >= engine_created
            && self.same_owner
            && self.managed_image
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn instances_are_bounded_complete_nonzero_and_not_guessed_from_state() {
        for text in [
            r#"{"state":null,"engines":[]}"#,
            r#"{"state":3,"engines":[]}"#,
            r#"{"state":4,"engines":[17,21]}"#,
        ] {
            assert!(Instances::parse(text).is_ok(), "{text}");
        }
        for text in [
            r#"{"state":4,"engines":[]}"#,
            r#"{"state":null,"engines":[1]}"#,
            r#"{"state":5,"engines":[]}"#,
            r#"{"state":4,"engines":[0]}"#,
            r#"{"state":4,"engines":[1,1]}"#,
            r#"{"state":4,"engines":["17"]}"#,
            r#"{"state":4,"engines":[4294967296]}"#,
            r#"{"state":3}"#,
            r#"{"engines":[]}"#,
            r#"{"state":3,"engines":[],"other":true}"#,
        ] {
            assert!(Instances::parse(text).is_err(), "{text}");
        }
        assert!(
            Instances::parse(&format!(
                "{{\"state\":4,\"engines\":{:?}}}",
                (1..=17).collect::<Vec<_>>()
            ))
            .is_err()
        );
    }
    #[test]
    fn new_or_unverified_live_engines_are_not_already_gone() {
        assert!(engine_matches(100, 200, true, true));
        for (created, before, owner, image) in [
            (0, 200, true, true),
            (201, 200, true, true),
            (100, 200, false, true),
            (100, 200, true, false),
        ] {
            assert!(!engine_matches(created, before, owner, image));
        }
    }
    #[test]
    fn children_require_two_snapshot_parent_and_creation_owner_and_image() {
        let candidate = || Child {
            parent: 17,
            created: 200,
            same_owner: true,
            managed_image: true,
        };
        assert!(candidate().matches(17, 100, Some(17)));
        for case in 0..7 {
            let mut child = candidate();
            let mut second = Some(17);
            let mut engine = 17;
            match case {
                0 => child.parent = 18,
                1 => child.created = 99,
                2 => child.same_owner = false,
                3 => child.managed_image = false,
                4 => second = None,
                5 => second = Some(18),
                _ => engine = 0,
            }
            assert!(!child.matches(engine, 100, second), "case {case}");
        }
    }
}
