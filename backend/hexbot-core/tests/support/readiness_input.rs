use tokio::process::{Child, ChildStdin};

// Tokio Child::wait closes Child.stdin on its first poll, even in select!.
// Keep that exact input alive outside Child while observing readiness. Drop
// restores ownership on success, error, timeout, cancellation and unwinding.
pub struct ReadinessInput<'a> {
    child: &'a mut Child,
    input: Option<ChildStdin>,
}
impl<'a> ReadinessInput<'a> {
    pub fn new(child: &'a mut Child) -> Self {
        let input = child.stdin.take();
        Self { child, input }
    }
    pub fn child(&mut self) -> &mut Child {
        self.child
    }
}
impl Drop for ReadinessInput<'_> {
    fn drop(&mut self) {
        self.child.stdin = self.input.take();
    }
}
