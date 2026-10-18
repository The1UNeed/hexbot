//! Observes ordered transport events. These IDs never enter Pi or model context.
use crate::common::id;
use serde_json::{Value, json};
use std::collections::{HashMap, VecDeque};

#[derive(Clone)]
pub(super) struct Ending {
    pub fields: Value,
    pub text: String,
    pub error: Option<String>,
    will_retry: bool,
}
struct Operation {
    turn: String,
    fragment: Option<String>,
    last_fragment: Option<String>,
    initial: bool,
    intent: Option<String>,
    user: Option<String>,
}
#[derive(Default)]
pub(super) struct Identity {
    started: Vec<String>,
    active: Option<Operation>,
    endings: VecDeque<Ending>,
    latest: Option<String>,
    unmatched: bool,
    unbound_settlements: usize,
    // A duplicate toolCallId is ambiguous, even across fragments.
    tools: HashMap<String, Option<Value>>,
}
pub(super) struct Observed {
    pub fields: Value,
    pub seed: Option<Value>,
}
impl Identity {
    pub fn turn_fields(&self) -> Value {
        if let Some(op) = &self.active {
            json!({"turn_id":op.turn})
        } else {
            json!({})
        }
    }
    fn fragment_fields(&self) -> Value {
        let mut fields = self.turn_fields();
        if let Some(fragment) = self.active.as_ref().and_then(|op| op.fragment.as_ref()) {
            fields["message_id"] = json!(fragment);
        }
        fields
    }
    pub fn observe(&mut self, event: &Value, text: &str, error: Option<String>) -> Observed {
        let kind = event["type"].as_str().unwrap_or("");
        let mut seed = None;
        match kind {
            "hexbot_input_preflight" if event["disposition"] == "started" => {
                if let Some(intent) = event["intent"].as_str() {
                    self.started.push(intent.into());
                }
            }
            "agent_start" => {
                let started = std::mem::take(&mut self.started);
                // Pi's prompt preflight immediately precedes its initial run.
                // A continuation has no new started preflight and shares its
                // pending settlement, while still receiving a new turn_id.
                if started.is_empty() {
                    self.endings.pop_back();
                }
                let turn = id();
                self.latest = Some(turn.clone());
                self.active = Some(Operation {
                    turn,
                    fragment: None,
                    last_fragment: None,
                    initial: true,
                    intent: (started.len() == 1).then(|| started[0].clone()),
                    user: None,
                });
            }
            "message_start" => {
                if let Some(op) = &mut self.active {
                    let role = event["message"]["role"].as_str().unwrap_or("");
                    if role == "user" {
                        // Only the first real user slot in prompt(messages) is
                        // proved by started. No queue/text/ordinal matcher.
                        op.user = if op.initial { op.intent.take() } else { None };
                    }
                    if role != "system" {
                        op.initial = false;
                    }
                    if role == "assistant" {
                        op.fragment = Some(id());
                    }
                }
            }
            "message_end" => {
                let message = &event["message"];
                let mut fields = self.turn_fields();
                if let Some(op) = &mut self.active {
                    match message["role"].as_str() {
                        Some("user") => {
                            if let Some(intent) = op.user.take() {
                                fields["_input_intent"] = json!(intent);
                                fields["input_id"] = json!(intent);
                            }
                        }
                        Some("assistant") => {
                            if let Some(fragment) = &op.fragment {
                                fields["row_id"] = json!(fragment);
                            }
                            op.last_fragment = if message["stopReason"] == "error" {
                                None
                            } else {
                                op.fragment.clone()
                            };
                        }
                        _ => {}
                    }
                }
                seed = Some(fields);
            }
            "agent_end" => {
                if let Some(op) = self.active.take() {
                    if self.unbound_settlements > 0 {
                        self.unbound_settlements += 1;
                        return Observed {
                            fields: json!({}),
                            seed: None,
                        };
                    }
                    let mut fields = json!({"turn_id":op.turn});
                    if let Some(fragment) = op.last_fragment {
                        fields["message_id"] = json!(fragment);
                    }
                    self.endings.push_back(Ending {
                        fields,
                        text: text.into(),
                        error,
                        will_retry: event["willRetry"] == true,
                    });
                }
            }
            _ => {}
        }
        // Tool ownership comes from the actual assistant content, never the
        // currently visible bubble or a parent/nested call guess.
        if matches!(kind, "message_update" | "message_end")
            && event["message"]["role"] == "assistant"
        {
            let fields = self.fragment_fields();
            if fields.get("message_id").is_some() {
                for call in event["message"]["content"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|b| b["type"] == "toolCall")
                {
                    if let Some(call) = call["id"].as_str().filter(|id| !id.is_empty()) {
                        self.tools
                            .entry(call.into())
                            .and_modify(|old| {
                                if old.as_ref() != Some(&fields) {
                                    *old = None;
                                }
                            })
                            .or_insert_with(|| Some(fields.clone()));
                    }
                }
            }
        }
        let fields = if matches!(kind, "tool_execution_start" | "tool_execution_end") {
            self.tools
                .get(event["toolCallId"].as_str().unwrap_or(""))
                .and_then(Clone::clone)
                .unwrap_or_else(|| self.turn_fields())
        } else if matches!(kind, "message_update" | "message_end") {
            self.fragment_fields()
        } else {
            self.turn_fields()
        };
        Observed { fields, seed }
    }
    pub fn settle(&mut self) -> Option<Ending> {
        self.unmatched = !self.started.is_empty();
        if self.unmatched {
            self.started.clear();
            return None;
        }
        if self.endings.len() > 1 {
            // Independent prompt activities may settle in either order. Pi's
            // untagged settlement cannot select one of these ended operations.
            self.unbound_settlements += self.endings.len();
            self.endings.clear();
        }
        if self.unbound_settlements > 0 {
            self.unbound_settlements -= 1;
            self.unmatched = self.unbound_settlements > 0 || self.active.is_some();
            return None;
        }
        let mut end = self.endings.pop_front();
        // A retry disposition predicts continuation, not another settlement.
        // If Pi settles instead, it still belongs to this captured operation.
        if let Some(end) = &mut end
            && end.will_retry
        {
            end.fields.as_object_mut().unwrap().remove("message_id");
        }
        if self.active.is_none() && self.endings.is_empty() {
            self.tools.clear();
        }
        end
    }
    pub fn is_latest(&self, end: &Ending) -> bool {
        self.active.is_none() && self.latest.as_deref() == end.fields["turn_id"].as_str()
    }
    pub fn unmatched_settlement(&mut self) -> bool {
        // A prompt can pass preflight while another prompt is preparing, then
        // fail Agent.prompt's active-run check. It settles without agent_start
        // or agent_end. That ACK cannot identify a row or finish the real run.
        std::mem::take(&mut self.unmatched)
    }
}
pub(super) fn with_fields(mut payload: Value, fields: &Value) -> Value {
    for (key, value) in fields.as_object().into_iter().flatten() {
        payload[key] = value.clone();
    }
    payload
}

#[cfg(test)]
mod tests {
    use super::*;
    fn see(ids: &mut Identity, event: Value) -> Observed {
        ids.observe(&event, "captured", None)
    }
    fn start(ids: &mut Identity, input: &str) -> Value {
        see(
            ids,
            json!({"type":"hexbot_input_preflight","intent":input,"disposition":"started"}),
        );
        see(ids, json!({"type":"agent_start"})).fields
    }
    #[test]
    fn real_fragments_and_tool_owners_stay_distinct() {
        let mut ids = Identity::default();
        let turn = start(&mut ids, "input");
        assert!(turn.get("message_id").is_none());
        see(
            &mut ids,
            json!({"type":"message_start","message":{"role":"assistant"}}),
        );
        let first = see(
            &mut ids,
            json!({"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","id":"tool"}]}}),
        );
        let first_id = &first.fields["message_id"];
        assert_eq!(first.seed.unwrap()["row_id"], *first_id);
        see(
            &mut ids,
            json!({"type":"message_start","message":{"role":"assistant"}}),
        );
        let second = see(&mut ids, json!({"type":"message_update"})).fields;
        assert_ne!(second["message_id"], *first_id);
        let tool = see(
            &mut ids,
            json!({"type":"tool_execution_end","toolCallId":"tool"}),
        )
        .fields;
        assert_eq!(tool["message_id"], *first_id);
        assert_eq!(tool["turn_id"], turn["turn_id"]);
        assert!(
            see(
                &mut ids,
                json!({"type":"tool_execution_start","toolCallId":"nested"})
            )
            .fields
            .get("message_id")
            .is_none()
        );
        let result = see(
            &mut ids,
            json!({"type":"message_end","message":{"role":"toolResult","toolCallId":"tool"}}),
        )
        .seed
        .unwrap();
        assert!(result.get("row_id").is_none());
        assert!(result.get("message_id").is_none());
        see(
            &mut ids,
            json!({"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","id":""}]}}),
        );
        assert!(
            see(&mut ids, json!({"type":"tool_execution_start"}))
                .fields
                .get("message_id")
                .is_none()
        );
    }
    #[test]
    fn initial_slot_only_and_queued_acks_never_bind_users() {
        let mut ids = Identity::default();
        start(&mut ids, "started");
        see(
            &mut ids,
            json!({"type":"message_start","message":{"role":"system"}}),
        );
        see(
            &mut ids,
            json!({"type":"message_start","message":{"role":"user"}}),
        );
        assert_eq!(
            see(
                &mut ids,
                json!({"type":"message_end","message":{"role":"user"}})
            )
            .seed
            .unwrap()["input_id"],
            "started"
        );
        for disposition in ["queued", "handled", "queued"] {
            see(
                &mut ids,
                json!({"type":"hexbot_input_preflight","intent":"identical","disposition":disposition}),
            );
            see(
                &mut ids,
                json!({"type":"message_start","message":{"role":"user"}}),
            );
            assert!(
                see(
                    &mut ids,
                    json!({"type":"message_end","message":{"role":"user"}})
                )
                .seed
                .unwrap()
                .get("input_id")
                .is_none()
            );
        }
    }
    #[test]
    fn ambiguous_started_and_missing_message_start_omit_input() {
        let mut ids = Identity::default();
        see(
            &mut ids,
            json!({"type":"hexbot_input_preflight","intent":"a","disposition":"started"}),
        );
        start(&mut ids, "b");
        see(
            &mut ids,
            json!({"type":"message_start","message":{"role":"user"}}),
        );
        assert!(
            see(
                &mut ids,
                json!({"type":"message_end","message":{"role":"user"}})
            )
            .seed
            .unwrap()
            .get("input_id")
            .is_none()
        );
        start(&mut ids, "c");
        assert!(
            see(
                &mut ids,
                json!({"type":"message_end","message":{"role":"user"}})
            )
            .seed
            .unwrap()
            .get("input_id")
            .is_none()
        );
    }
    #[test]
    fn delayed_settlement_uses_ending_snapshot_and_cannot_finish_new_run() {
        let mut ids = Identity::default();
        let old = start(&mut ids, "old");
        see(
            &mut ids,
            json!({"type":"message_start","message":{"role":"assistant"}}),
        );
        let fragment = see(
            &mut ids,
            json!({"type":"message_end","message":{"role":"assistant"}}),
        )
        .fields;
        ids.observe(
            &json!({"type":"agent_end","willRetry":false}),
            "old output",
            Some("old error".into()),
        );
        let new = start(&mut ids, "new");
        let end = ids.settle().unwrap();
        assert_eq!(end.fields["turn_id"], old["turn_id"]);
        assert_eq!(end.fields["message_id"], fragment["message_id"]);
        assert_eq!(end.text, "old output");
        assert_eq!(end.error.as_deref(), Some("old error"));
        assert!(!ids.is_latest(&end));
        assert_eq!(ids.turn_fields(), new);
    }
    #[test]
    fn retry_operations_get_new_turns_and_no_fictitious_fragment() {
        let mut ids = Identity::default();
        let first = start(&mut ids, "input");
        see(
            &mut ids,
            json!({"type":"message_start","message":{"role":"assistant"}}),
        );
        see(
            &mut ids,
            json!({"type":"message_end","message":{"role":"assistant","stopReason":"error"}}),
        );
        see(&mut ids, json!({"type":"agent_end","willRetry":true}));
        let second = see(&mut ids, json!({"type":"agent_start"})).fields;
        assert_ne!(first["turn_id"], second["turn_id"]);
        see(&mut ids, json!({"type":"agent_end","willRetry":false}));
        let end = ids.settle().unwrap();
        assert_eq!(end.fields["turn_id"], second["turn_id"]);
        assert!(end.fields.get("message_id").is_none());
        assert!(ids.settle().is_none());
        assert!(
            see(&mut ids, json!({"type":"compaction_end"}))
                .fields
                .is_object()
        );
        assert!(ids.turn_fields().get("message_id").is_none());
    }
    #[test]
    fn an_unstarted_ack_cannot_steal_an_already_ended_newer_operation() {
        let mut ids = Identity::default();
        let newer = start(&mut ids, "newer");
        see(&mut ids, json!({"type":"agent_end","willRetry":false}));
        see(
            &mut ids,
            json!({"type":"hexbot_input_preflight","intent":"older-prepared","disposition":"started"}),
        );
        assert!(ids.settle().is_none());
        assert!(ids.unmatched_settlement());
        let actual = ids.settle().unwrap();
        assert_eq!(actual.fields["turn_id"], newer["turn_id"]);
        assert!(ids.is_latest(&actual));
    }
    #[test]
    fn reordered_settlements_stay_unbound_and_cannot_end_a_later_active_operation() {
        let mut ids = Identity::default();
        start(&mut ids, "one");
        see(&mut ids, json!({"type":"agent_end"}));
        start(&mut ids, "two");
        see(&mut ids, json!({"type":"agent_end"}));
        assert!(ids.settle().is_none());
        assert!(ids.unmatched_settlement());
        let three = start(&mut ids, "three");
        assert!(ids.settle().is_none());
        assert!(ids.unmatched_settlement());
        assert_eq!(ids.turn_fields(), three);
        see(&mut ids, json!({"type":"agent_end"}));
        let end = ids.settle().unwrap();
        assert_eq!(end.fields["turn_id"], three["turn_id"]);
    }
}
