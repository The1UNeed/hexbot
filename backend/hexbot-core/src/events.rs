use serde_json::{Value, json};
use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, Mutex},
};
use tokio::sync::broadcast;

const RETAINED: usize = 512;
const MAX_LOGS: usize = 1024;
const MAX_REPLAY_BYTES: usize = 32 * 1024 * 1024;
#[derive(Clone, Debug)]
pub struct Event {
    pub owner: String,
    /// Other users who watch the session live, such as a room's members.
    pub viewers: Vec<String>,
    pub frame: Value,
    /// What the viewers get instead of `frame`; see `viewer_payload`.
    pub shared: Option<Value>,
}
impl Event {
    pub fn visible_to(&self, user: &str) -> bool {
        self.frame_for(user).is_some()
    }
    pub fn frame_for(&self, user: &str) -> Option<&Value> {
        if self.owner == user {
            Some(&self.frame)
        } else if self.viewers.iter().any(|v| v == user) {
            self.shared.as_ref()
        } else {
            None
        }
    }
}
/// Who watches a shared session and the name its waiting status shows.
#[derive(Clone)]
struct Viewers {
    users: Vec<String>,
    owner_name: String,
}
/// Room members watch a bot that runs as the owner: they see its words, its
/// status, which tool it uses, and that it waits on the owner. Tool arguments
/// (even the short label), results, reasoning, usage and error details stay
/// private. Status text must stay free of tool output: it reaches viewers as is.
fn viewer_payload(kind: &str, payload: &Value, owner_name: &str) -> Option<(&'static str, Value)> {
    Some(match kind {
        "message.start" => ("message.start", json!({})),
        "message.delta" => ("message.delta", json!({"text":payload["text"]})),
        "message.interim" => (
            "message.interim",
            json!({"text":payload["text"],"already_streamed":payload["already_streamed"]}),
        ),
        "message.complete" => (
            "message.complete",
            json!({"text":payload["text"],"status":payload["status"],"partial":payload["partial"]}),
        ),
        "status.update" => (
            "status.update",
            json!({"kind":payload["kind"],"text":payload["text"]}),
        ),
        "tool.start" => (
            "tool.start",
            json!({"tool_id":payload["tool_id"],"name":payload["name"]}),
        ),
        "tool.complete" => {
            let failed = payload["result"].get("error").is_some();
            (
                "tool.complete",
                json!({
                    "tool_id": payload["tool_id"],
                    "name": payload["name"],
                    "duration_s": payload["duration_s"],
                    "result": if failed { json!({"error":"Tool failed"}) } else { Value::Null },
                }),
            )
        }
        "approval.request" | "clarify.request" => (
            "status.update",
            json!({"kind":"waiting","text":format!("Waiting for {owner_name}")}),
        ),
        _ => return None,
    })
}
#[derive(Default)]
struct Log {
    seq: u64,
    discarded: u64,
    bytes: usize,
    frames: VecDeque<(Value, usize)>,
}
#[derive(Default)]
struct Replay {
    seq: u64,
    bytes: usize,
    logs: HashMap<(String, String), Log>,
    shared: HashMap<(String, String), Viewers>,
}
struct Inner {
    epoch: String,
    replay: Mutex<Replay>,
    sender: broadcast::Sender<Event>,
}
#[derive(Clone)]
pub struct EventHub(Arc<Inner>);
impl Default for EventHub {
    fn default() -> Self {
        Self::new()
    }
}
impl EventHub {
    pub fn new() -> Self {
        let (sender, _) = broadcast::channel(2048);
        Self(Arc::new(Inner {
            epoch: crate::common::id(),
            replay: Mutex::new(Replay::default()),
            sender,
        }))
    }
    pub fn epoch(&self) -> &str {
        &self.0.epoch
    }
    pub fn subscribe(&self) -> broadcast::Receiver<Event> {
        self.0.sender.subscribe()
    }
    /// Let other users watch one session live; an empty list stops sharing.
    /// `owner_name` is who they see the bot waiting for.
    pub fn share(&self, owner: &str, session: &str, viewers: Vec<String>, owner_name: &str) {
        let mut replay = self.0.replay.lock().unwrap_or_else(|e| e.into_inner());
        let key = (owner.to_owned(), session.to_owned());
        if viewers.is_empty() {
            replay.shared.remove(&key);
        } else {
            replay.shared.insert(
                key,
                Viewers {
                    users: viewers,
                    owner_name: owner_name.to_owned(),
                },
            );
        }
    }
    /// Send one viewer the same sanitized event they would receive live.
    pub(crate) fn emit_to_viewer(
        &self,
        owner: &str,
        session: &str,
        viewer: &str,
        kind: &str,
        payload: Value,
    ) {
        let shared = {
            let replay = self.0.replay.lock().unwrap_or_else(|e| e.into_inner());
            replay
                .shared
                .get(&(owner.to_owned(), session.to_owned()))
                .filter(|v| v.users.iter().any(|user| user == viewer))
                .and_then(|v| viewer_payload(kind, &payload, &v.owner_name))
        };
        if let Some((kind, payload)) = shared {
            self.emit(viewer, Some(session), kind, payload);
        }
    }
    pub fn emit(&self, owner: &str, session: Option<&str>, kind: &str, payload: Value) -> Value {
        let mut replay = self.0.replay.lock().unwrap_or_else(|e| e.into_inner());
        // The client requires increasing watermarks, not contiguous numbers.
        // Global numbering prevents a retired session's reused ID from resetting.
        replay.seq += 1;
        let seq = replay.seq;
        // Only the owner answers approvals and questions; viewers get an
        // allowlisted copy without them.
        let (viewers, shared) = session
            .and_then(|session| replay.shared.get(&(owner.to_owned(), session.to_owned())))
            .and_then(|viewers| {
                let (kind, payload) = viewer_payload(kind, &payload, &viewers.owner_name)?;
                Some((
                    viewers.users.clone(),
                    json!({"jsonrpc":"2.0","method":"event","params":{"type":kind,"session_id":session,"seq":seq,"payload":payload}}),
                ))
            })
            .map_or((vec![], None), |(users, frame)| (users, Some(frame)));
        let frame = json!({"jsonrpc":"2.0","method":"event","params":{"type":kind,"session_id":session,"seq":seq,"payload":payload}});
        let size = frame.to_string().len();
        let log = replay
            .logs
            .entry((owner.into(), session.unwrap_or("").into()))
            .or_insert_with(|| Log {
                discarded: seq - 1,
                ..Log::default()
            });
        let previous = log.bytes;
        log.seq = seq;
        log.frames.push_back((frame.clone(), size));
        log.bytes += size;
        while log.frames.len() > RETAINED || log.bytes > MAX_REPLAY_BYTES {
            if let Some((old, size)) = log.frames.pop_front() {
                log.bytes -= size;
                log.discarded = old["params"]["seq"].as_u64().unwrap_or(seq);
            }
        }
        let retained = log.bytes;
        replay.bytes = replay.bytes - previous + retained;
        while replay.logs.len() > MAX_LOGS || replay.bytes > MAX_REPLAY_BYTES {
            let oldest = replay
                .logs
                .iter()
                .min_by_key(|(_, log)| log.seq)
                .map(|(key, _)| key.clone());
            if let Some(key) = oldest {
                let old = replay.logs.remove(&key).unwrap();
                replay.bytes -= old.bytes;
            } else {
                break;
            }
        }
        // Publish under the same lock to preserve ordering between emitters.
        let _ = self.0.sender.send(Event {
            owner: owner.into(),
            viewers,
            frame: frame.clone(),
            shared,
        });
        frame
    }
    pub fn since(&self, owner: &str, session: &str, last: u64) -> Value {
        let replay = self.0.replay.lock().unwrap_or_else(|e| e.into_inner());
        let log = replay.logs.get(&(owner.into(), session.into()));
        let latest = log.map_or(last, |log| log.seq);
        let frames = log
            .map(|log| {
                log.frames
                    .iter()
                    .filter(|(f, _)| f["params"]["seq"].as_u64().unwrap_or(0) > last)
                    .map(|(f, _)| f["params"].clone())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let truncated = log.map_or(last > 0, |log| last < log.discarded || last > log.seq);
        json!({"count":frames.len(),"events":frames,"latest_seq":latest,"truncated":truncated,"epoch":self.epoch()})
    }
    pub fn forget(&self, owner: &str, session: &str) {
        let mut replay = self.0.replay.lock().unwrap_or_else(|e| e.into_inner());
        replay.shared.remove(&(owner.into(), session.into()));
        if let Some(log) = replay.logs.remove(&(owner.into(), session.into())) {
            replay.bytes -= log.bytes;
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn replay_is_bounded_and_owner_isolated() {
        let hub = EventHub::new();
        for n in 0..600 {
            hub.emit(
                "a",
                Some("s"),
                "message.delta",
                json!({"text":n.to_string()}),
            );
        }
        assert_eq!(hub.since("a", "s", 0)["count"], 512);
        assert_eq!(hub.since("a", "s", 0)["truncated"], true);
        assert_eq!(hub.since("a", "s", 599)["count"], 1);
        assert_eq!(hub.since("b", "s", 0)["count"], 0);
    }
    #[test]
    fn shared_sessions_reach_viewers_as_an_allowlist_until_closed() {
        let hub = EventHub::new();
        let mut events = hub.subscribe();
        hub.share("a", "s", vec!["b".into()], "Alice");
        hub.emit("a", Some("s"), "message.delta", json!({"text":"Hi"}));
        let args = json!({"command":"cat ~/.ssh/id_rsa"});
        hub.emit(
            "a",
            Some("s"),
            "tool.start",
            json!({"tool_id":"t","name":"terminal","context":"cat ~/.ssh/id_rsa","args":args}),
        );
        hub.emit(
            "a",
            Some("s"),
            "tool.complete",
            json!({"tool_id":"t","name":"terminal","result":{"error":"secret"},"result_text":"secret"}),
        );
        hub.emit("a", Some("s"), "approval.request", json!({"command":"rm"}));
        hub.emit("a", Some("s"), "clarify.request", json!({"question":"Why"}));
        hub.emit("a", Some("s"), "reasoning.delta", json!({"text":"private"}));
        hub.emit("a", Some("s"), "session.usage", json!({"usage":{}}));
        hub.emit(
            "a",
            Some("s"),
            "message.complete",
            json!({"text":"Done","error":"stack","status":"error","usage":{"cost":1}}),
        );
        hub.emit("a", Some("other"), "message.delta", json!({}));
        hub.forget("a", "s");
        hub.emit("a", Some("s"), "message.delta", json!({}));
        let seen = (0..10)
            .map(|_| {
                let event = events.try_recv().unwrap();
                assert!(event.visible_to("a"));
                event.frame_for("b").map(|f| f["params"].clone())
            })
            .collect::<Vec<_>>();
        for frame in seen.iter().flatten() {
            assert!(!frame.to_string().contains("id_rsa"), "{frame}");
            assert!(!frame.to_string().contains("secret"), "{frame}");
        }
        let shown = |i: usize| {
            seen[i]
                .as_ref()
                .map(|p| (p["type"].clone(), p["payload"].clone()))
        };
        assert_eq!(
            shown(0),
            Some((json!("message.delta"), json!({"text":"Hi"})))
        );
        assert_eq!(
            shown(1),
            Some((
                json!("tool.start"),
                json!({"tool_id":"t","name":"terminal"})
            ))
        );
        assert_eq!(
            shown(2),
            Some((
                json!("tool.complete"),
                json!({"tool_id":"t","name":"terminal","duration_s":null,"result":{"error":"Tool failed"}})
            ))
        );
        let waiting = Some((
            json!("status.update"),
            json!({"kind":"waiting","text":"Waiting for Alice"}),
        ));
        assert_eq!(shown(3), waiting);
        assert_eq!(shown(4), waiting);
        assert_eq!(shown(5), None);
        assert_eq!(shown(6), None);
        assert_eq!(
            shown(7),
            Some((
                json!("message.complete"),
                json!({"text":"Done","status":"error","partial":null})
            ))
        );
        assert_eq!(shown(8), None);
        assert_eq!(shown(9), None);
    }
    #[test]
    fn retired_live_ids_never_reset_and_many_sessions_stay_bounded() {
        let hub = EventHub::new();
        let first = hub.emit("a", Some("s"), "old", json!({}))["params"]["seq"]
            .as_u64()
            .unwrap();
        hub.forget("a", "s");
        hub.emit("a", Some("s"), "new", json!({}));
        let replay = hub.since("a", "s", first);
        assert_eq!(replay["count"], 1);
        assert!(replay["events"][0]["seq"].as_u64().unwrap() > first);
        for n in 0..2000 {
            hub.emit("a", Some(&n.to_string()), "new", json!({}));
        }
        let state = hub.0.replay.lock().unwrap();
        assert!(state.logs.len() <= MAX_LOGS);
        assert!(state.bytes <= MAX_REPLAY_BYTES);
    }
}
