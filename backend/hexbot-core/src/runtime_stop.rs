//! Stop recovery clears Pi 1.0.1's actual queues, then replays the daemon's
//! unprojected input ledger. Pi's returned text metadata can omit queued input.
use super::*;

pub(super) struct InputBoundary {
    // Keep deletion outside the actual enqueue, including callers that reuse
    // a Live after its opener's admission has ended.
    _admission: SessionAdmission,
    _open: Option<tokio::sync::OwnedMutexGuard<()>>,
    _landing: Option<Landing>,
}

impl InputBoundary {
    // Recovery releases process guards, but keeps the same lifecycle reader
    // until enqueue instead of re-entering behind a queued deletion writer.
    pub(super) fn admission(&self) -> SessionAdmission {
        self._admission.clone()
    }
}

impl Runtime {
    fn check_input_alias(&self, s: &Live) -> Result<()> {
        if s.input_generation != s.input_queue.generation.load(Ordering::Acquire)
            || (s.state.lock().unwrap().closed && !s.replaced.load(Ordering::Acquire))
        {
            return Err(Error::new(4001, "session not found"));
        }
        let valid: bool = store::open(&self.home)?.query_row(
            "SELECT EXISTS(SELECT 1 FROM native_live_sessions l JOIN native_sessions n ON n.stored_id=l.stored_id WHERE l.live_id=? AND l.stored_id=? AND n.owner=? AND n.bot=?)",
            params![s.id, s.stored, s.owner, s.bot],
            |r| r.get(0),
        )?;
        if !valid {
            return Err(Error::new(4001, "session not found"));
        }
        Ok(())
    }

    /// The input gate is already owned. Revalidate after every wait; a landing
    /// or the open lock protects the chosen process through the actual enqueue.
    pub(super) async fn input_session(
        &self,
        previous: &Arc<Live>,
        refresh: bool,
        admission: Option<SessionAdmission>,
    ) -> Result<(Arc<Live>, InputBoundary)> {
        self.check_input_alias(previous)?;
        let admission = match admission {
            Some(admission) => admission,
            None => Arc::new(self.admit_session(&previous.bot, &previous.stored, None)?),
        };
        let target = self
            .sessions
            .lock()
            .unwrap()
            .get(&previous.stored)
            .cloned()
            .filter(|current| {
                current.id == previous.id && current.input_generation == previous.input_generation
            })
            // A failed replacement can leave only the retired Live and its
            // waiters. The validated configuration alias may retry startup.
            .unwrap_or_else(|| previous.clone());
        let previous = &target;
        // Unchanged or unsettled input only needs a landing guard. In particular
        // it must not wait on another caller opening this already-live session.
        {
            let _gate = previous.event_gate.lock().unwrap();
            let state = previous.state.lock().unwrap();
            let idle = !state.busy && state.stops == 0 && !state.recovering;
            if !state.closed
                && !(refresh
                    && idle
                    && (self.model_changed(previous)?
                        || self.tools_stale(&previous.owner, &previous.bot, &previous.stored)?))
            {
                drop(state);
                self.check_input_alias(previous)?;
                store::session_dir(&self.home, &previous.stored)?;
                common::bot_owner(&self.home, &previous.owner, &previous.bot)?;
                let landing = Landing::new(previous)?;
                self.register_worker_bridge(previous);
                return Ok((
                    previous.clone(),
                    InputBoundary {
                        _admission: admission,
                        _open: None,
                        _landing: Some(landing),
                    },
                ));
            }
        }
        loop {
            let mut changed = previous.run_ended.subscribe();
            let opening = self.open_lock(&previous.stored).lock_owned();
            tokio::pin!(opening);
            let open = loop {
                if previous.state.lock().unwrap().closed {
                    self.check_input_alias(previous)?;
                }
                tokio::select! {
                    open = &mut opening => break open,
                    result = changed.changed() => result.map_err(|_| Error::new(5201, "session closed"))?,
                }
            };
            self.check_input_alias(previous)?;
            let s = self
                .open_session_locked(
                    &previous.owner,
                    &previous.bot,
                    &previous.stored,
                    None,
                    None,
                    refresh,
                    true,
                    admission.clone(),
                )
                .await?;
            if s.input_generation != previous.input_generation {
                return Err(Error::new(4001, "session not found"));
            }
            let mut ended = s.run_ended.subscribe();
            let idle = {
                let state = s.state.lock().unwrap();
                if state.closed {
                    return Err(Error::new(4001, "session not found"));
                }
                !state.busy && state.stops == 0 && !state.recovering
            };
            if refresh
                && idle
                && (self.model_changed(&s)? || self.tools_stale(&s.owner, &s.bot, &s.stored)?)
            {
                if !s.requests.lock().unwrap().is_empty() {
                    // A settlement can still be publishing usage or finishing a
                    // bridge reply. Join outside all open/event/state locks, then
                    // recheck the alias and actual admission state again.
                    drop(open);
                    let drained = std::future::poll_fn(|cx| {
                        let mut tasks = s.requests.lock().unwrap();
                        while let std::task::Poll::Ready(Some(_)) = tasks.poll_join_next(cx) {}
                        if tasks.is_empty() {
                            std::task::Poll::Ready(())
                        } else {
                            std::task::Poll::Pending
                        }
                    });
                    tokio::select! {
                        _ = drained => {},
                        _ = ended.changed() => {},
                    }
                    continue;
                }
                // Another upload or tool can still own this process. Preserve it
                // and its inputs rather than run with obsolete capabilities.
                return Err(Error::new(
                    4002,
                    "This conversation's tools or model changed. Try again when its pending work finishes.",
                ));
            }
            self.register_worker_bridge(&s);
            return Ok((
                s,
                InputBoundary {
                    _admission: admission,
                    _open: Some(open),
                    _landing: None,
                },
            ));
        }
    }

    /// Transport replies may arrive before their private event is dispatched.
    /// Keep submitting owned until that event has bound disposition and lifetime.
    pub(super) async fn input_preflight(
        s: &Live,
        intent: &str,
        reply: crate::pi::InputReply,
    ) -> Result<crate::pi::PiResponse> {
        let mut ended = s.run_ended.subscribe();
        let response = reply.wait().await.map_err(pi_error)?;
        loop {
            {
                let state = s.state.lock().unwrap();
                if state.closed {
                    return Err(Error::new(5201, "session closed"));
                }
                // Removal also proves dispatch: user projections follow preflight.
                if state
                    .inputs
                    .iter()
                    .find(|input| input.intent == intent)
                    .is_none_or(|input| input.preflight)
                {
                    return Ok(response);
                }
            }
            ended
                .changed()
                .await
                .map_err(|_| Error::new(5201, "session closed"))?;
        }
    }

    /// Runs under event_gate in transport order, before any new run's events.
    pub(super) fn accept_input(&self, s: &Arc<Live>, event: &Value) -> Result<()> {
        let stop = {
            let mut state = s.state.lock().unwrap();
            let Some(index) = state
                .inputs
                .iter()
                .position(|input| input.intent == event["intent"])
            else {
                return Ok(());
            };
            let mut input = state.inputs.remove(index).unwrap();
            input.preflight = true;
            let disposition = event["disposition"].as_str().unwrap_or("");
            let mut stop = None;
            if disposition == "handled" {
                // Extension commands have no projection or agent_settled. They
                // finish only this intent, even when issued during another run.
                if let Err(error) = store::reject_prompt(&self.home, &s.stored, &input.intent) {
                    input.preflight = false;
                    state.inputs.insert(index, input);
                    s.run_ended.send_modify(|v| *v += 1);
                    let s = s.clone();
                    tokio::spawn(async move {
                        let _ = s.process.shutdown().await;
                    });
                    return Err(error);
                }
                if input.stop_epoch == state.stop_epoch {
                    state.display.remove(index);
                }
                if state.input_run.as_deref() == Some(&input.intent) {
                    if state.end_turn() {
                        self.reload(s);
                    }
                    state.input_run = None;
                    s.settled.send_modify(|v| *v += 1);
                    self.emit(s, "status.update", json!({"kind":"idle","text":""}));
                }
            } else if matches!(disposition, "started" | "queued") {
                input.queued = disposition == "queued";
                if !input.queued {
                    // A started prompt owns a new Pi operation, even if the daemon
                    // still considered the previous operation busy at enqueue.
                    state.busy = true;
                    state.input_run = Some(input.intent.clone());
                    let late = state.stop_epoch != input.stop_epoch;
                    if late && (state.stops != 0 || input.replaying) {
                        // An active Stop, or a second Stop of replay, still owns
                        // this operation. Claim before waking its acknowledgement.
                        state.interrupted = true;
                        stop = Some(StopGuard::claim(s, &mut state));
                    } else if state.stops == 0 {
                        state.output.clear();
                        state.error = None;
                        state.interrupted = false;
                        state.chain = input.chain.clone();
                        if !input.replaying && input.command["streamingBehavior"] == "followUp" {
                            state.chain.askers.clear();
                        }
                        if late {
                            state.display.push_front(input.display.clone());
                        }
                    }
                }
                let at = if !input.queued {
                    0
                } else if input.command["type"] == "steer" {
                    state
                        .inputs
                        .iter()
                        .position(|other| other.queued && other.command["type"] != "steer")
                        .unwrap_or(state.inputs.len())
                } else {
                    state.inputs.len()
                };
                state.inputs.insert(at, input);
            } else {
                state.inputs.insert(index, input);
            }
            s.run_ended.send_modify(|v| *v += 1);
            stop
        };
        if let Some(stop) = stop {
            let runtime = self.weak.upgrade().unwrap();
            tokio::spawn(async move {
                let _ = runtime.finish_stop(stop, DEADLINE).await;
            });
        }
        Ok(())
    }

    pub(super) async fn input_slot(&self, s: &Live) -> Result<tokio::sync::OwnedMutexGuard<()>> {
        let mut ended = s.run_ended.subscribe();
        // Keep one lock future so ordinary wakeups retain this input's FIFO
        // position. Close must reject it before process/attachment cleanup.
        let slot = s.input_gate.clone().lock_owned();
        tokio::pin!(slot);
        loop {
            if s.input_generation != s.input_queue.generation.load(Ordering::Acquire) {
                return Err(Error::new(4001, "session not found"));
            }
            if s.state.lock().unwrap().closed {
                if !s.replaced.load(Ordering::Acquire) {
                    return Err(Error::new(4001, "session not found"));
                }
                // A configuration restart closes the old Live while preserving
                // its alias and shared FIFO. Explicit close removes the alias.
                self.check_input_alias(s)?;
            }
            tokio::select! {
                slot = &mut slot => return Ok(slot),
                result = ended.changed() => result.map_err(|_| Error::new(5201, "session closed"))?,
            }
        }
    }

    pub(super) async fn resume_stopped_inputs(self: Arc<Self>, s: Arc<Live>) {
        let _recovery = s.recovery_gate.lock().await;
        let mut ended = s.run_ended.subscribe();
        let result = async {
            loop {
                loop {
                    let ready = {
                        let state = s.state.lock().unwrap();
                        if state.closed || !state.recovering {
                            return Ok(());
                        }
                        state.stops == 0 && !state.busy && state.submitting == 0
                    };
                    if ready {
                        break;
                    }
                    ended
                        .changed()
                        .await
                        .map_err(|_| Error::new(5201, "session closed"))?;
                }
                self.reclaim_pi_queue(&s).await?;
                let epoch = s.state.lock().unwrap().stop_epoch;
                loop {
                    let next = {
                        let _gate = s.event_gate.lock().unwrap();
                        let mut state = s.state.lock().unwrap();
                        if state.closed {
                            return Err(Error::new(4001, "session not found"));
                        }
                        if state.stops != 0 || state.stop_epoch != epoch {
                            break;
                        }
                        let Some(index) = state.inputs.iter().position(|input| !input.in_pi) else {
                            state.recovering = false;
                            s.run_ended.send_modify(|v| *v += 1);
                            return Ok(());
                        };
                        let mut input = state.inputs[index].clone();
                        input.command["type"] = json!("prompt");
                        input.command["streamingBehavior"] = json!("followUp");
                        let reply = s
                            .process
                            .try_input(&input.command, &input.intent)
                            .map_err(pi_error)?;
                        input.in_pi = true;
                        input.queued = false;
                        input.stop_epoch = state.stop_epoch;
                        input.preflight = false;
                        input.replaying = true;
                        state.inputs[index] = input.clone();
                        let fresh = !state.busy;
                        if fresh {
                            state.output.clear();
                            state.error = None;
                            state.interrupted = false;
                            state.chain = input.chain;
                            state.input_run = Some(input.intent.clone());
                        }
                        state.busy = true;
                        state.last_activity = common::now();
                        state.display.push_back(input.display);
                        state.submitting += 1;
                        (reply, input.intent, fresh)
                    };
                    let response = Self::input_preflight(&s, &next.1, next.0).await;
                    let retry = {
                        let _gate = s.event_gate.lock().unwrap();
                        let mut state = s.state.lock().unwrap();
                        state.submitting -= 1;
                        // A later Stop can reject replay's preflight before Pi
                        // accepts it. This input was already accepted before
                        // the earlier Stop, so retain its original envelope.
                        let retry = state.stop_epoch != epoch
                            && response.as_ref().is_ok_and(|reply| !reply.success);
                        if retry {
                            if let Some(input) =
                                state.inputs.iter_mut().find(|input| input.intent == next.1)
                            {
                                input.in_pi = false;
                                input.queued = false;
                            }
                            if next.2 && state.end_turn() {
                                self.reload(&s);
                            }
                        }
                        s.run_ended.send_modify(|v| *v += 1);
                        retry
                    };
                    if retry {
                        break;
                    }
                    let response = response?;
                    if !response.success {
                        return Err(Error::new(
                            5201,
                            response
                                .error
                                .unwrap_or_else(|| "Queued input rejected".into()),
                        ));
                    }
                }
            }
        }
        .await;
        if let Err(error) = result {
            self.emit(
                &s,
                "warning",
                json!({"message":"Queued input could not be resumed", "error":error.message}),
            );
            // An ambiguous failure cannot let later input kick a stale queue.
            let _ = s.process.shutdown().await;
        }
    }

    async fn reclaim_pi_queue(&self, s: &Arc<Live>) -> Result<()> {
        if !s
            .state
            .lock()
            .unwrap()
            .inputs
            .iter()
            .any(|input| input.in_pi)
        {
            return Ok(());
        }
        // Stop has finished and the old command/run and preflights have ended.
        // Its queue can now be moved without racing any new input admission.
        let queues = Self::command(s, json!({"type":"clear_queue"})).await?;
        let _gate = s.event_gate.lock().unwrap();
        let mut state = s.state.lock().unwrap();
        let mut available = state.inputs.clone();
        for (key, lane) in [("steering", "steer"), ("followUp", "prompt")] {
            let texts = queues[key]
                .as_array()
                .ok_or_else(|| Error::new(5201, "Pi did not return its queued inputs"))?;
            for text in texts {
                let index = available
                    .iter()
                    .position(|input| {
                        input.in_pi
                            && input.command["type"] == lane
                            && input.command["message"] == *text
                    })
                    .ok_or_else(|| {
                        Error::new(5201, "Pi queued input has no matching original intent")
                    })?;
                available.remove(index);
            }
        }
        // Pi removes queue metadata by text when an earlier identical user
        // message starts. clear_queue still clears the actual queues. Only a
        // known queued preflight authorizes an omitted entry; unexplained
        // metadata and ambiguous acceptance keep the fail-closed behavior.
        if available.iter().any(|input| input.in_pi && !input.queued) {
            return Err(Error::new(5201, "Pi omitted an unprojected input"));
        }
        // Ordered preflights and actual user projections already maintain the
        // daemon's intent order, including steering priority and duplicate text.
        // Never select replay envelopes or their identities from Pi's text list.
        for input in &mut state.inputs {
            input.in_pi = false;
        }
        Ok(())
    }

    pub(super) async fn steer(
        &self,
        s: &Arc<Live>,
        text: &str,
        input_id: Option<&str>,
    ) -> Result<Value> {
        if text.trim().is_empty() {
            return Err(Error::new(4200, "missing parameter: text"));
        }
        if text.len() > 1024 * 1024 {
            return Err(Error::new(4202, "prompt exceeds 1 MiB"));
        }
        let mut s = s.clone();
        let _reservation = InputAdmission::start(&s);
        let _input = self.input_slot(&s).await?;
        loop {
            let (current, _open) = self.input_session(&s, true, None).await?;
            s = current;
            let mut ended = s.run_ended.subscribe();
            let admitted = {
                let _gate = s.event_gate.lock().unwrap();
                let mut state = s.state.lock().unwrap();
                if state.closed {
                    return Err(Error::new(4001, "session not found"));
                }
                if state.stops != 0
                    || state.recovering
                    || state.compacting
                    || (state.busy && state.interrupted)
                {
                    None
                } else {
                    if !state.busy
                        && (self.model_changed(&s)?
                            || self.tools_stale(&s.owner, &s.bot, &s.stored)?)
                    {
                        continue;
                    }
                    // Pi's steer queues even while idle. An idle owner steer
                    // must start a run so it cannot strand display metadata.
                    let fresh = !state.busy;
                    let command = json!({"type":if fresh {"prompt"} else {"steer"},"message":text});
                    let intent = store::stage_prompt_with_id(
                        &self.home, &s.stored, text, "normal", input_id,
                    )?;
                    let reply = match s.process.try_input(&command, &intent) {
                        Ok(reply) => reply,
                        Err(error) => {
                            store::reject_prompt(&self.home, &s.stored, &intent)?;
                            return Err(pi_error(error));
                        }
                    };
                    let chain = if fresh {
                        Chain::default()
                    } else {
                        state.chain.clone()
                    };
                    let stop_epoch = state.stop_epoch;
                    state.inputs.push_back(PendingInput {
                        intent: intent.clone(),
                        in_pi: true,
                        queued: false,
                        stop_epoch,
                        preflight: false,
                        replaying: false,
                        command,
                        display: "normal".into(),
                        chain: chain.clone(),
                    });
                    state.display.push_back("normal".into());
                    if fresh {
                        state.output.clear();
                        state.error = None;
                        state.interrupted = false;
                        state.chain = chain;
                        state.input_run = Some(intent.clone());
                    }
                    state.busy = true;
                    state.last_activity = common::now();
                    state.submitting += 1;
                    Some((intent, reply, fresh))
                }
            };
            if let Some((intent, reply, fresh)) = admitted {
                drop(_open);
                let runtime = self
                    .weak
                    .upgrade()
                    .ok_or_else(|| Error::new(5201, "daemon is stopping"))?;
                let s = s.clone();
                let echo = input_id.is_some();
                return tokio::spawn(async move {
                    let response =
                        Self::input_preflight(&s, &intent, reply)
                            .await
                            .and_then(|reply| {
                                if reply.success {
                                    Ok(())
                                } else {
                                    Err(Error::new(
                                        5201,
                                        reply.error.unwrap_or_else(|| "Steering rejected".into()),
                                    ))
                                }
                            });
                    let _gate = s.event_gate.lock().unwrap();
                    let mut state = s.state.lock().unwrap();
                    state.submitting -= 1;
                    let rejected = if response.is_err() {
                        let rejected = store::reject_prompt(&runtime.home, &s.stored, &intent);
                        if let Some(index) =
                            state.inputs.iter().position(|input| input.intent == intent)
                        {
                            state.inputs.remove(index);
                            if !state.interrupted {
                                state.display.remove(index);
                            }
                        }
                        if fresh && state.end_turn() {
                            runtime.reload(&s);
                        }
                        rejected
                    } else {
                        Ok(())
                    };
                    s.run_ended.send_modify(|v| *v += 1);
                    rejected?;
                    response.map(|()| {
                        let mut result = json!({"status":"queued"});
                        if echo {
                            result["input_id"] = json!(intent);
                        }
                        result
                    })
                })
                .await
                .map_err(|error| Error::new(5201, error.to_string()))?;
            }
            drop(_open);
            ended
                .changed()
                .await
                .map_err(|_| Error::new(5201, "session closed"))?;
        }
    }
}
