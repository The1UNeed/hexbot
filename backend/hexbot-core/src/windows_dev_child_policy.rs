//! Dev-only admission. The caller supplies filesystem and platform path facts.
pub(super) fn arguments(args: &[String], absolute: bool, ordinary: bool) -> bool {
    args.len() >= 3
        && !args[0].is_empty()
        && args[1] == "--"
        && args[2].to_ascii_lowercase().ends_with(".exe")
        && absolute
        && ordinary
}

pub(super) struct Parent {
    pub pid: u32,
    pub created: u64,
    pub alive: bool,
    pub same_owner: bool,
}
impl Parent {
    pub(super) fn verified(&self, host_pid: u32, host_created: u64, second_parent: u32) -> bool {
        self.pid != 0
            && self.pid != host_pid
            && self.pid == second_parent
            && self.created != 0
            && host_created != 0
            && self.created <= host_created
            && self.alive
            && self.same_owner
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn argument_table() {
        for (input, absolute, ordinary, expected) in [
            (
                vec!["web", "--", "C:\\工具 path\\node.EXE", "a&b", ""],
                true,
                true,
                true,
            ),
            (vec!["web", "--", "node.exe"], false, true, false),
            (vec!["web", "--", "C:\\npm.cmd"], true, true, false),
            (vec!["web", "--", "C:\\npm.bat"], true, true, false),
            (vec!["web", "--", "C:\\run.sh"], true, true, false),
            (vec!["web", "C:\\node.exe"], true, true, false),
            (vec!["web", "--", "C:\\directory.exe"], true, false, false),
            (vec!["", "--", "C:\\node.exe"], true, true, false),
            (vec![], true, true, false),
        ] {
            let args = input.into_iter().map(String::from).collect::<Vec<_>>();
            assert_eq!(arguments(&args, absolute, ordinary), expected, "{args:?}");
        }
    }
    #[test]
    fn parent_table_fails_closed() {
        for (pid, created, alive, same_owner, host_created, second, expected) in [
            (10, 20, true, true, 30, 10, true),
            (10, 30, true, true, 30, 10, true),
            (0, 20, true, true, 30, 0, false),
            (11, 20, true, true, 30, 11, false),
            (10, 0, true, true, 30, 10, false),
            (10, 20, true, true, 0, 10, false),
            (10, 31, true, true, 30, 10, false),
            (10, 20, true, true, 30, 12, false),
            (10, 20, false, true, 30, 10, false),
            (10, 20, true, false, 30, 10, false),
        ] {
            assert_eq!(
                Parent {
                    pid,
                    created,
                    alive,
                    same_owner
                }
                .verified(11, host_created, second),
                expected
            );
        }
    }
}
