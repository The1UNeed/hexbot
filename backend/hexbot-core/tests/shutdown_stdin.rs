#![cfg(unix)]
#[path = "support/readiness_input.rs"]
mod readiness_input;
use futures_util::FutureExt;
use readiness_input::ReadinessInput;
use std::{future::Future, panic::AssertUnwindSafe, process::Stdio, task::Poll, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::Command,
};

#[tokio::test]
async fn readiness_wait_preserves_actual_child_input_on_select_cancel_and_panic() {
    for path in ["select", "cancel", "panic"] {
        let mut child = Command::new("/bin/cat")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let mut output = BufReader::new(child.stdout.take().unwrap());
        let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
        let result = AssertUnwindSafe(tokio::time::timeout_at(deadline, async {
            if path == "select" {
                let mut input = ReadinessInput::new(&mut child);
                tokio::select! {
                    biased;
                    status = input.child().wait() => panic!("cat exited during readiness: {status:?}"),
                    _ = std::future::ready(()) => {},
                }
            } else {
                let mut waiting = Box::pin(async {
                    let mut input = ReadinessInput::new(&mut child);
                    input.child().wait().await
                });
                // Poll the actual wait first, then cancel its future. No
                // timers, sleeps or a detached waiter select the outcome.
                std::future::poll_fn(|cx| {
                    assert!(waiting.as_mut().poll(cx).is_pending());
                    Poll::Ready(())
                }).await;
                if path == "panic" {
                    let panicked = std::panic::catch_unwind(AssertUnwindSafe(move || {
                        let _waiting = waiting;
                        panic!("exercise input restoration during unwinding");
                    }));
                    assert!(panicked.is_err());
                } else {
                    drop(waiting);
                }
            }
            let mut input = child.stdin.take().expect("readiness consumed the shutdown input");
            input.write_all(b"later shutdown write\n").await.unwrap();
            let mut echoed = String::new();
            output.read_line(&mut echoed).await.unwrap();
            assert_eq!(echoed,"later shutdown write\n", "cat saw premature EOF on {path}");
            drop(input); // Only explicit shutdown releases the input.
            assert!(child.wait().await.unwrap().success());
        })).catch_unwind().await;
        // Retain and reap only this actual control child, including failure.
        let _ = child.start_kill();
        let reaped = tokio::time::timeout_at(deadline, child.wait()).await;
        let reaped = matches!(reaped, Ok(Ok(_)));
        if !reaped {
            eprintln!("control child cleanup exhausted its bound");
        }
        match result {
            Ok(result) => {
                result.expect("actual-process stdin control timed out");
                assert!(reaped, "control child was not reaped");
            }
            Err(error) => std::panic::resume_unwind(error),
        }
    }
}
