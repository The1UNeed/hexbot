use serde_json::{Value, json};
use std::{
    pin::Pin,
    sync::{Arc, Mutex},
    task::{Context, Poll},
};
use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader, ReadBuf};
use tokio::sync::mpsc;

#[derive(Clone, Default)]
pub struct Output(Arc<Mutex<(u64, Vec<u8>)>>);
impl Output {
    pub fn snapshot(&self) -> Value {
        let state = self.0.lock().unwrap();
        // Output can contain credentials. Retain only known diagnostic labels
        // and numeric OS errors, never arbitrary suffixes or command bodies.
        let text = String::from_utf8_lossy(&state.1);
        let labels = [
            "create daemon job",
            "configure daemon job",
            "assign daemon job",
            "Cannot verify the live Windows service creator",
            "Windows service creator already exited",
            "Cannot identify the Windows service creator",
            "a daemon already owns this home",
            "Windows tool isolation is not implemented",
        ];
        let mut tail = labels
            .into_iter()
            .filter(|label| text.contains(label))
            .map(str::to_owned)
            .collect::<Vec<_>>();
        let errors = regex::Regex::new(r"os error [0-9]{1,10}").unwrap();
        tail.extend(
            errors
                .find_iter(&text)
                .take(8)
                .map(|m| m.as_str().to_owned()),
        );
        json!({"observedBytes":state.0,"sanitizedTail":tail,"otherText":"redacted","retainedBytes":state.1.len()})
    }
    pub fn drain(
        &self,
        reader: impl AsyncRead + Unpin + Send + 'static,
        ready: Option<mpsc::Sender<Result<u16, String>>>,
    ) -> tokio::task::JoinHandle<()> {
        let mut reader = Counted {
            reader,
            output: self.clone(),
        };
        tokio::spawn(async move {
            if let Some(tx) = ready {
                // Preserve the fixture's original Tokio line/UTF-8 handling,
                // exact readiness prefix and u16 parser. Only capture is new.
                let mut lines = BufReader::new(reader).lines();
                loop {
                    match lines.next_line().await {
                        Ok(Some(line)) => {
                            if let Some(port) = line.strip_prefix("HERMES_BACKEND_READY port=") {
                                let _ = tx.try_send(
                                    port.parse::<u16>()
                                        .map_err(|_| "invalid real readiness port".to_owned()),
                                );
                            }
                        }
                        Ok(None) => break,
                        Err(error) => {
                            let _ = tx.try_send(Err(format!("stdout read: {error}")));
                            break;
                        }
                    }
                }
            } else {
                let _ = tokio::io::copy(&mut reader, &mut tokio::io::sink()).await;
            }
        })
    }
}
// Count at the byte boundary, before the unchanged readiness parser buffers
// lines. Diagnostic storage stays at 2 KiB regardless of total stream length.
struct Counted<R> {
    reader: R,
    output: Output,
}
impl<R: AsyncRead + Unpin> AsyncRead for Counted<R> {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        let this = self.get_mut();
        let before = buffer.filled().len();
        let result = Pin::new(&mut this.reader).poll_read(cx, buffer);
        if let Poll::Ready(Ok(())) = &result {
            let mut state = this.output.0.lock().unwrap();
            let bytes = &buffer.filled()[before..];
            state.0 += bytes.len() as u64;
            // Avoid copying an unbounded caller buffer into the retained tail.
            state
                .1
                .extend_from_slice(&bytes[bytes.len().saturating_sub(2048)..]);
            let excess = state.1.len().saturating_sub(2048);
            state.1.drain(..excess);
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncWriteExt;
    #[tokio::test]
    async fn real_line_is_required_and_capture_is_bounded_and_redacted() {
        let (reader, mut writer) = tokio::io::duplex(8192);
        let capture = Output::default();
        let (tx, mut rx) = mpsc::channel(2);
        let drained = capture.drain(reader, Some(tx));
        writer
            .write_all(b"not HERMES_BACKEND_READY port=3\nHERMES_BACKEND_READY port=")
            .await
            .unwrap();
        assert!(rx.try_recv().is_err());
        writer.write_all(b"42\r\n").await.unwrap();
        assert_eq!(rx.recv().await.unwrap(), Ok(42));
        writer
            .write_all(b"HERMES_BACKEND_READY port=42\r\r\n")
            .await
            .unwrap();
        assert!(rx.recv().await.unwrap().is_err());
        writer.write_all(&vec![b'x'; 4096]).await.unwrap();
        writer
            .write_all(b" secret=sk-private assign daemon job: os error 5\n")
            .await
            .unwrap();
        drop(writer);
        drained.await.unwrap();
        let snapshot = capture.snapshot();
        assert_eq!(snapshot["retainedBytes"], 2048);
        assert!(snapshot["observedBytes"].as_u64().unwrap() > 4096);
        assert!(snapshot.to_string().contains("assign daemon job"));
        assert!(!snapshot.to_string().contains("sk-private"));
    }
}
