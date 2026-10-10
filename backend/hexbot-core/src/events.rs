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
    pub frame: Value,
}
impl Event {
    pub fn visible_to(&self, user: &str) -> bool {
        self.owner == user
    }
    pub fn frame_for(&self, user: &str) -> Option<&Value> {
        self.visible_to(user).then_some(&self.frame)
    }
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
    pub fn emit(&self, owner: &str, session: Option<&str>, kind: &str, payload: Value) -> Value {
        let mut replay = self.0.replay.lock().unwrap_or_else(|e| e.into_inner());
        // The client requires increasing watermarks, not contiguous numbers.
        // Global numbering prevents a retired session's reused ID from resetting.
        replay.seq += 1;
        let seq = replay.seq;
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
            frame: frame.clone(),
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
