//! Acquisition checks for the actual service creator, never a lock-file PID.
pub struct Identity {
    pub pid: u32,
    pub created: u64,
    pub alive: bool,
    pub same_owner: bool,
    pub system_powershell: bool,
}
impl Identity {
    pub fn verified(&self, child_pid: u32, child_created: u64, current_parent: u32) -> bool {
        self.pid != 0
            && self.pid != child_pid
            && self.pid == current_parent
            && self.created != 0
            && self.created <= child_created
            && self.alive
            && self.same_owner
            && self.system_powershell
    }
}
