use serde::Deserialize;
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Witness {
    pub pid: u32,
    pub created: String,
    pub executable: String,
    pub selected: String,
    pub owner: String,
    pub expected_owner: String,
    pub parent: u32,
    pub engine_pid: u32,
    pub instance: String,
    pub task_path: String,
    pub expected_task_path: String,
    pub record_hash: String,
    pub record_epoch: String,
    pub identity_pid: u32,
    pub install: String,
    pub expected_install: String,
    pub live: bool,
    pub lock_held: bool,
}
impl Witness {
    pub fn ready(&self, excluded: &[u32]) -> bool {
        self.pid != 0
            && !excluded.contains(&self.pid)
            && self.live
            && self.lock_held
            && !self.created.is_empty()
            && self.executable.eq_ignore_ascii_case(&self.selected)
            && self.owner == self.expected_owner
            && !self.owner.is_empty()
            && self.parent != 0
            && self.parent == self.engine_pid
            && !self.instance.is_empty()
            && self.task_path == self.expected_task_path
            && self.identity_pid == self.pid
            && !self.install.is_empty()
            && self.install == self.expected_install
            && self.record_hash.len() == 64
            && !self.record_epoch.is_empty()
    }
    pub fn retained(&self, fresh: &Self, created: &str, alive: bool) -> bool {
        self == fresh && self.created == created && alive
    }
}
