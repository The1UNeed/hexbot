//! Stop recovery clears Pi 1.0.1's actual queues, then replays the daemon's
//! unprojected input ledger. Pi's returned text metadata can omit queued input.
use super::*;

impl Runtime {
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
    pub(super) fn accept_input(&self, s: &Arc<Live>, event: &Value) {
        let stop = {
            let mut state = s.state.lock().unwrap();
            let Some(index) = state
                .inputs
                .iter()
                .position(|input| input.intent == event["intent"])
            else {
                return;
            };
            let mut input = state.inputs.remove(index).unwrap();
            input.preflight = true;
            let disposition = event["disposition"].as_str().unwrap_or("");
            let mut stop = None;
            if matches!(disposition, "started" | "queued") {
                input.queued = disposition == "queued";
                if !input.queued {
                    // A started prompt owns a new Pi operation, even if the daemon
                    // still considered the previous operation busy at enqueue.
                    state.busy = true;
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
    }

    pub(super) async fn input_slot(s: &Live) -> Result<tokio::sync::MutexGuard<'_, ()>> {
        let mut ended = s.run_ended.subscribe();
        // Keep one lock future so ordinary wakeups retain this input's FIFO
        // position. Close must reject it before process/attachment cleanup.
        let slot = s.input_gate.lock();
        tokio::pin!(slot);
        loop {
            if s.state.lock().unwrap().closed {
                return Err(Error::new(4001, "session not found"));
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

    pub(super) async fn steer(&self, s: &Arc<Live>, text: &str) -> Result<Value> {
        if text.trim().is_empty() {
            return Err(Error::new(4200, "missing parameter: text"));
        }
        if text.len() > 1024 * 1024 {
            return Err(Error::new(4202, "prompt exceeds 1 MiB"));
        }
        self.register_worker_bridge(s);
        let _reservation = InputAdmission::start(s);
        let _input = Self::input_slot(s).await?;
        let mut ended = s.run_ended.subscribe();
        loop {
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
                    // Pi's steer queues even while idle. An idle owner steer
                    // must start a run so it cannot strand display metadata.
                    let fresh = !state.busy;
                    let command = json!({"type":if fresh {"prompt"} else {"steer"},"message":text});
                    let intent = store::stage_prompt(&self.home, &s.stored, text, "normal")?;
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
                    }
                    state.busy = true;
                    state.last_activity = common::now();
                    state.submitting += 1;
                    Some((intent, reply, fresh))
                }
            };
            if let Some((intent, reply, fresh)) = admitted {
                let runtime = self
                    .weak
                    .upgrade()
                    .ok_or_else(|| Error::new(5201, "daemon is stopping"))?;
                let s = s.clone();
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
                    response.map(|()| json!({"status":"queued"}))
                })
                .await
                .map_err(|error| Error::new(5201, error.to_string()))?;
            }
            ended
                .changed()
                .await
                .map_err(|_| Error::new(5201, "session closed"))?;
        }
    }
}
