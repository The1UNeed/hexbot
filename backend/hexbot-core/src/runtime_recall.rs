//! Recall: the owner takes back their latest message in a bot's chat. Pi moves
//! the conversation back to just before it, so the next request starts with
//! the same cached prefix, and the rows after it leave the history. The
//! private extension makes the move (`hexbot-recall` in `extension.ts`).
use super::*;

/// The private extension's command. Typed messages may not start with it.
const RECALL_COMMAND: &str = "/hexbot-recall";

/// Sent and steered text never runs the command; Recall goes through
/// `session.recall`, which keeps the history in step with Pi.
pub(super) fn refuse_typed(text: &str) -> Result<()> {
    if text.trim_start().starts_with(RECALL_COMMAND) {
        return Err(Error::new(4202, "Use Recall to take back a message"));
    }
    Ok(())
}

fn busy() -> Error {
    Error::new(4002, "session is already working")
}

fn latest_only() -> Error {
    Error::new(4202, "Only your latest message can be recalled")
}

impl Runtime {
    pub(super) async fn recall(&self, s: &Arc<Live>, p: &Value) -> Result<Value> {
        let input_id = p["input_id"].as_str().filter(|id| !id.is_empty());
        let row_id = p["row_id"].as_str().filter(|id| !id.is_empty());
        if input_id.is_none() && row_id.is_none() {
            return Err(Error::new(4200, "missing parameter: input_id"));
        }
        // Rooms, threads between bots and Check-ins keep what was said.
        let chat: bool = db::open(&self.home)?.query_row(
            "SELECT EXISTS(SELECT 1 FROM sections WHERE id=? AND bot=? AND owner_id=? AND peer_bot IS NULL AND purpose IS NULL)",
            params![s.stored, s.bot, s.owner],
            |r| r.get(0),
        )?;
        if !chat {
            return Err(Error::new(
                4202,
                "Only messages in a bot's chat can be recalled",
            ));
        }
        // A history row names its input, if it has one.
        let named = match (input_id, row_id) {
            (Some(id), _) => Some(id.to_owned()),
            (None, Some(row)) => store::row_input(&self.home, &s.stored, row)?,
            (None, None) => None,
        };
        // A turn still working on it stops first, as Stop would. A stale
        // Recall leaves a newer message's turn alone, and one still queued
        // behind another turn waits for its own: Stop would replay it.
        let working = {
            let state = s.state.lock().unwrap();
            let running = state.input_run.as_deref();
            let newest = state.inputs.back().map(|i| i.intent.as_str()).or(running);
            if state.busy && newest.is_some() {
                if newest != named.as_deref() {
                    return Err(latest_only());
                }
                if running != named.as_deref() {
                    return Err(Error::new(4002, "Recall it once the bot starts on it"));
                }
            }
            state.busy
        };
        if working {
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
        match &result {
            // Every open view drops the message and what followed it.
            Ok(row) => {
                let recalled = json!({"row_id":row["row_id"],"input_id":row["input_id"]});
                self.events.emit(
                    &s.owner,
                    None,
                    "hexbot.sections.changed",
                    json!({"id":s.stored,"bot":s.bot,"reload":true,"recalled":recalled}),
                );
            }
            Err(_) if reread => self.reload(s),
            Err(_) => {}
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
        result.map(|row| json!({"recalled":true,"text":row["text"]}))
    }

    /// The recalled row.
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
            return Err(latest_only());
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
        Ok(row)
    }
}
