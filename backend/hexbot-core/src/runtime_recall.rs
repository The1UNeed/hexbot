//! Recall: the owner takes back their latest message in a bot's chat. Pi moves
//! the conversation back to just before it, so the next request starts with
//! the same cached prefix, and the rows after it leave the history. The
//! private extension makes the move (`hexbot-recall` in `extension.ts`).
use super::*;

/// The private extension's command. Typed messages may not start with it.
pub(super) const RECALL_COMMAND: &str = "/hexbot-recall";

fn busy() -> Error {
    Error::new(4002, "session is already working")
}

impl Runtime {
    pub(super) async fn recall(&self, s: &Arc<Live>, p: &Value) -> Result<Value> {
        let input_id = p["input_id"].as_str().filter(|id| !id.is_empty());
        let row_id = p["row_id"].as_str().filter(|id| !id.is_empty());
        if input_id.is_none() && row_id.is_none() {
            return Err(Error::new(4200, "missing parameter: input_id"));
        }
        // Rooms and threads between bots keep what was said.
        let chat: bool = db::open(&self.home)?.query_row(
            "SELECT EXISTS(SELECT 1 FROM sections WHERE id=? AND bot=? AND owner_id=? AND peer_bot IS NULL)",
            params![s.stored, s.bot, s.owner],
            |r| r.get(0),
        )?;
        if !chat {
            return Err(Error::new(
                4202,
                "Only messages in a bot's chat can be recalled",
            ));
        }
        // A turn still working on it stops first, as Stop would.
        if s.state.lock().unwrap().busy {
            self.interrupt(s, DEADLINE).await?;
        }
        let _input = s.input_gate.clone().try_lock_owned().map_err(|_| busy())?;
        let mut ended = s.run_ended.subscribe();
        loop {
            {
                let _gate = s.event_gate.lock().unwrap();
                let mut state = s.state.lock().unwrap();
                if state.closed {
                    return Err(Error::new(4001, "session not found"));
                }
                // Stop recovery hands retained input back to Pi before it is idle.
                if !state.recovering && state.stops == 0 {
                    if state.busy
                        || state.submitting != 0
                        || !state.inputs.is_empty()
                        || s.input_waiters.load(Ordering::Acquire) != 0
                    {
                        return Err(busy());
                    }
                    state.busy = true;
                    break;
                }
            }
            tokio::time::timeout(DEADLINE, ended.changed())
                .await
                .map_err(|_| busy())?
                .map_err(|_| Error::new(5201, "session closed"))?;
        }
        let result = self.recall_latest(s, input_id, row_id).await;
        let reread = s.state.lock().unwrap().end_turn();
        s.run_ended.send_modify(|v| *v += 1);
        if result.is_ok() || reread {
            self.reload(s);
        }
        // A turn that failed on the recalled message went with it.
        if result.is_ok()
            && db::open(&self.home)
                .and_then(|conn| {
                    crate::settings::resolve_private_turn_failures(
                        &conn, &s.stored, &s.bot, &s.owner,
                    )
                })
                .is_ok_and(|count| count > 0)
        {
            self.events
                .emit(&s.owner, None, "hexbot.bots.changed", json!({"name":s.bot}));
        }
        result
    }

    async fn recall_latest(
        &self,
        s: &Arc<Live>,
        input_id: Option<&str>,
        row_id: Option<&str>,
    ) -> Result<Value> {
        // A row still waiting to be written would land after the move.
        self.retry_messages(s);
        if !s.state.lock().unwrap().unsaved.is_empty() {
            return Err(Error::new(
                4002,
                "The conversation is still being saved. Try again.",
            ));
        }
        let latest = store::latest_input(&self.home, &s.stored)?;
        let Some((entry, row)) = latest.filter(|(_, row)| {
            row["display_kind"] != "hidden"
                && ((input_id.is_some() && row["input_id"].as_str() == input_id)
                    || (row_id.is_some() && row["row_id"].as_str() == row_id))
        }) else {
            return Err(Error::new(
                4202,
                "Only your latest message can be recalled",
            ));
        };
        let reply = s
            .process
            .request(
                json!({"type":"prompt","message":format!("{RECALL_COMMAND} {entry}")}),
                DEADLINE,
            )
            .await
            .map_err(pi_error)?;
        if !reply.success {
            return Err(Error::new(
                5201,
                reply
                    .error
                    .unwrap_or_else(|| "The message could not be recalled".into()),
            ));
        }
        // The command reports a failure only as an extension error, so the
        // conversation file is the proof that Pi moved.
        store::follow_branch(&self.home, &s.stored, &entry)?;
        Ok(json!({"recalled":true,"text":row["text"]}))
    }
}
