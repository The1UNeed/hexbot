//! Bounded evidence of job associations, not a notification counter.
use std::{collections::BTreeMap, io};
pub(super) const LIMIT: usize = 4096;
#[derive(Default)]
pub(super) struct Ledger {
    members: BTreeMap<u32, Member>,
    total: u32,
}
struct Member {
    created: Option<u64>,
    announced: bool,
}
impl Ledger {
    pub(super) fn observe(
        &mut self,
        pid: u32,
        created: io::Result<Option<u64>>,
        announced: bool,
    ) -> io::Result<()> {
        let created = created?;
        if pid == 0 || created == Some(0) {
            return Err(io::Error::other("Invalid Pi job member identity"));
        }
        if let Some(member) = self.members.get_mut(&pid) {
            // A retained handle prevents reuse of a known identity. A historical
            // absent PID can cover one slot only, never a later live identity.
            if (announced && member.announced)
                || created.is_some_and(|value| member.created != Some(value))
            {
                return Err(io::Error::other("Ambiguous or reused Pi job process ID"));
            }
            member.announced |= announced;
        } else {
            if self.members.len() == LIMIT {
                return Err(io::Error::other("Pi job member budget exceeded"));
            }
            self.members.insert(pid, Member { created, announced });
        }
        Ok(())
    }
    pub(super) fn total(&mut self, total: u32) -> io::Result<()> {
        if total < self.total || total as usize > LIMIT || self.members.len() > total as usize {
            return Err(io::Error::other(
                "Pi job association count regressed or exceeded its budget",
            ));
        }
        self.total = total;
        Ok(())
    }
    pub(super) fn complete(&self) -> bool {
        self.members.len() == self.total as usize && self.total != 0
    }
}
pub(super) fn process_ids(
    assigned: u32,
    listed: u32,
    slots: &[usize],
    returned: usize,
    capacity: usize,
) -> io::Result<Vec<u32>> {
    if assigned != listed
        || listed as usize > LIMIT
        || listed as usize > slots.len()
        || returned > capacity
        || returned < 8 + listed as usize * std::mem::size_of::<usize>()
    {
        return Err(io::Error::other("Incomplete Pi job process list"));
    }
    let mut pids = Vec::with_capacity(listed as usize);
    for value in &slots[..listed as usize] {
        let pid =
            u32::try_from(*value).map_err(|_| io::Error::other("Invalid Pi job process ID"))?;
        if pid == 0 || pids.contains(&pid) {
            return Err(io::Error::other("Duplicate Pi job process ID"));
        }
        pids.push(pid);
    }
    Ok(pids)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn root_snapshot_and_one_event_cover_one_creation_identity() {
        let mut ledger = Ledger::default();
        ledger.observe(1, Ok(Some(10)), false).unwrap(); // retained before Resume
        ledger.observe(1, Ok(Some(10)), false).unwrap(); // snapshot overlap
        ledger.observe(1, Ok(Some(10)), true).unwrap(); // root NEW exactly once
        ledger.total(1).unwrap();
        assert!(ledger.complete());
        assert!(ledger.observe(1, Ok(Some(10)), true).is_err());
    }
    #[test]
    fn snapshots_can_cover_dropped_new_but_missing_historical_slots_cannot() {
        let mut ledger = Ledger::default();
        ledger.observe(1, Ok(Some(10)), false).unwrap();
        ledger.observe(2, Ok(Some(20)), false).unwrap();
        ledger.total(3).unwrap();
        assert!(!ledger.complete());
        ledger.observe(3, Ok(None), true).unwrap(); // definitive absence, one historical slot
        ledger.total(3).unwrap();
        assert!(ledger.complete());
        assert!(ledger.observe(3, Ok(None), true).is_err());
        assert!(ledger.observe(3, Ok(Some(30)), false).is_err());
        assert!(ledger.observe(2, Ok(Some(21)), false).is_err());
    }
    #[test]
    fn delayed_new_and_racing_child_require_exact_final_coverage() {
        let mut ledger = Ledger::default();
        ledger.observe(1, Ok(Some(10)), false).unwrap();
        ledger.total(1).unwrap();
        ledger.total(2).unwrap();
        assert!(!ledger.complete());
        ledger.observe(2, Ok(Some(20)), true).unwrap();
        ledger.observe(2, Ok(Some(20)), false).unwrap();
        assert!(ledger.complete());
        // A rejected association increments TotalProcesses but supplies no
        // provable member. Never manufacture that missing slot.
        ledger.total(3).unwrap();
        assert!(!ledger.complete());
        assert!(ledger.total(2).is_err());
        assert!(ledger.total(u32::MAX).is_err());
    }
    #[test]
    fn absent_snapshot_and_delayed_event_deduplicate_without_crediting_reuse() {
        let mut ledger = Ledger::default();
        ledger.observe(1, Ok(None), false).unwrap();
        ledger.observe(1, Ok(None), true).unwrap();
        ledger.total(2).unwrap();
        assert!(!ledger.complete());
        assert!(ledger.observe(1, Ok(None), true).is_err());
        assert!(ledger.observe(1, Ok(Some(42)), false).is_err());
    }
    #[test]
    fn uncertain_or_unrelated_members_never_supply_coverage() {
        let mut ledger = Ledger::default();
        ledger.observe(1, Ok(Some(10)), false).unwrap();
        ledger.total(2).unwrap();
        let denied = io::Error::from_raw_os_error(5);
        assert_eq!(
            ledger
                .observe(2, Err(denied), true)
                .unwrap_err()
                .raw_os_error(),
            Some(5)
        );
        assert!(
            ledger
                .observe(2, Err(io::Error::other("live other-job process")), true)
                .is_err()
        );
        assert!(!ledger.complete());
    }
    #[test]
    fn job_lists_require_complete_bounded_unique_process_ids() {
        let size = 8 + 2 * std::mem::size_of::<usize>();
        assert_eq!(process_ids(2, 2, &[10, 20], size, size).unwrap(), [10, 20]);
        for (assigned, listed, slots, returned, capacity) in [
            (2, 1, vec![10], size, size),
            (2, 2, vec![10], size, size),
            (2, 2, vec![10, 20], size - 1, size),
            (2, 2, vec![10, 20], size + 1, size),
            (2, 2, vec![10, 10], size, size),
            (2, 2, vec![10, 0], size, size),
            (u32::MAX, u32::MAX, vec![], size, size),
        ] {
            assert!(process_ids(assigned, listed, &slots, returned, capacity).is_err());
        }
    }
    #[test]
    fn invalid_and_over_budget_evidence_never_completes() {
        let mut ledger = Ledger::default();
        assert!(ledger.observe(0, Ok(None), true).is_err());
        assert!(ledger.observe(1, Ok(Some(0)), true).is_err());
        for pid in 1..=LIMIT as u32 {
            ledger.observe(pid, Ok(None), true).unwrap();
        }
        assert!(ledger.observe(LIMIT as u32 + 1, Ok(None), true).is_err());
        assert!(ledger.total((LIMIT - 1) as u32).is_err());
    }
}
