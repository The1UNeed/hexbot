//! Private read-only Python probe capture. No uv mutation runs through here.
//!
//! Cleanup eligibility is separate from probe health. Crossing the cleanup
//! threshold permanently preserves scratch, even if ownership settles later.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ChildState {
    NoChild,
    Unconfirmed,
    Reaped,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum WorkerState {
    NotStarted,
    Running,
    Joined,
}
#[derive(Clone, Copy, Debug)]
pub(crate) struct Settlement {
    pub child: ChildState,
    pub natural_eof: [bool; 2],
    pub pipes_closed: bool,
    pub worker: WorkerState,
    pub cleanup_unconfirmed: bool,
}
impl Settlement {
    pub fn cleanup_eligible(&self) -> bool {
        self.child != ChildState::Unconfirmed
            && self.pipes_closed
            && self.worker != WorkerState::Running
            && !self.cleanup_unconfirmed
    }
    pub fn complete(&self) -> bool {
        self.cleanup_eligible()
            && self.child == ChildState::Reaped
            && self.worker == WorkerState::Joined
            && self.natural_eof == [true; 2]
    }
}
pub(super) const OUTPUT_LIMIT: usize = 1024 * 1024;
pub(crate) struct Output {
    pub status: Option<i32>,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub capture_failure: Option<String>,
    pub settlement: Settlement,
}
impl Output {
    pub fn reaped(&self) -> bool {
        self.settlement.child == ChildState::Reaped
    }
    pub fn complete(&self) -> bool {
        self.settlement.complete()
            && self.capture_failure.is_none()
            && self.stdout.len() <= OUTPUT_LIMIT
            && self.stderr.len() <= OUTPUT_LIMIT
    }
    pub fn empty() -> Self {
        Self {
            status: None,
            stdout: Vec::new(),
            stderr: Vec::new(),
            capture_failure: None,
            settlement: Settlement {
                child: ChildState::NoChild,
                natural_eof: [false; 2],
                pipes_closed: true,
                worker: WorkerState::NotStarted,
                cleanup_unconfirmed: false,
            },
        }
    }
    pub fn fail(&mut self, cause: impl std::fmt::Display) {
        match &mut self.capture_failure {
            Some(primary) => primary.push_str(&format!("; {cause}")),
            None => self.capture_failure = Some(cause.to_string()),
        }
    }
    pub fn cleanup_unconfirmed(&mut self) {
        if !self.settlement.cleanup_unconfirmed {
            self.settlement.cleanup_unconfirmed = true;
            self.fail("CleanupUnconfirmed: shared cleanup threshold exceeded; scratch retained permanently for this invocation");
        }
    }
    pub fn append(&mut self, stream: usize, bytes: &[u8]) {
        let output = if stream == 0 {
            &mut self.stdout
        } else {
            &mut self.stderr
        };
        let was_over = output.len() > OUTPUT_LIMIT;
        let count = bytes.len().min(OUTPUT_LIMIT + 1 - output.len());
        output.extend_from_slice(&bytes[..count]);
        if !was_over && output.len() > OUTPUT_LIMIT {
            self.fail(format!(
                "{} output exceeded 1 MiB",
                if stream == 0 { "stdout" } else { "stderr" }
            ));
        }
    }
}

#[cfg(windows)]
#[path = "setup_python_capture_windows.rs"]
mod windows;
#[cfg(windows)]
pub(super) use windows::capture;
