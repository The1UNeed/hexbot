//! What Settings, Advanced, Diagnostics shows: how long the daemon took to
//! launch, its process tree and resource history, spans of RPCs and runs,
//! failures, load, and the prompt and local database caches.
//!
//! Everything but the prompt cache lives in memory and starts again with the
//! daemon. Recording is cheap and never fails the work it observes: no span
//! holds message text, only names, timings, token counts and error messages.

use crate::{Result, common};
use regex::Regex;
use rusqlite::ffi;
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    ffi::CStr,
    os::raw::{c_char, c_int, c_void},
    path::Path,
    sync::{
        LazyLock, Mutex, Once,
        atomic::{AtomicU64, AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};

/// Spans kept, newest last. Names, the span log and traces read from these.
const SPANS: usize = 4000;
const FAILURES: usize = 200;
const FAILURE_GROUPS: usize = 200;
/// One hour of samples at `SAMPLE_EVERY`.
const SAMPLES: usize = 720;
/// Ten minutes per process.
const PROCESS_SAMPLES: usize = 120;
pub const SAMPLE_EVERY: Duration = Duration::from_secs(5);
/// Distinct SQL statements tracked; later ones count under one row.
const STATEMENTS: usize = 1000;
const OPEN_RUNS: usize = 256;
const RECENT_SPANS: usize = 200;
const RECENT_TRACES: usize = 50;
/// RPCs a client polls; recording them would bury everything else.
const QUIET_METHODS: &[&str] = &[
    "gateway.ping",
    "hexbot.diagnostics.get",
    "hexbot.diagnostics.trace",
];
const OTHER_STATEMENTS: &str = "(other statements)";

fn now_ms() -> f64 {
    common::now() * 1000.
}

fn clip(text: &str, limit: usize) -> String {
    match text.char_indices().nth(limit) {
        Some((end, _)) => format!("{}…", &text[..end]),
        None => text.to_owned(),
    }
}

/// The diagnostics of this process.
pub fn get() -> &'static Diagnostics {
    static DIAGNOSTICS: LazyLock<Diagnostics> = LazyLock::new(Diagnostics::default);
    &DIAGNOSTICS
}

#[derive(Clone)]
struct Span {
    id: u64,
    trace: u64,
    parent: Option<u64>,
    name: String,
    kind: &'static str,
    start: f64,
    duration: f64,
    error: Option<String>,
    attrs: Value,
}

impl Span {
    fn json(&self) -> Value {
        json!({
            "id": self.id,
            "trace": self.trace,
            "parent": self.parent,
            "name": self.name,
            "kind": self.kind,
            "start": self.start,
            "duration_ms": self.duration,
            "error": self.error,
            "attrs": self.attrs,
        })
    }
}

struct OpenTool {
    id: u64,
    start: f64,
    name: String,
}

/// A run from `agent_start` to `agent_settled`, with its model calls and tools.
struct OpenRun {
    trace: u64,
    start: f64,
    bot: String,
    section: String,
    /// When the current model call began: the run's start, or the end of the
    /// last model call or tool.
    boundary: f64,
    first_token: Option<f64>,
    tools: HashMap<String, OpenTool>,
    models: u64,
    tool_calls: u64,
    input: i64,
    output: i64,
    cache_read: i64,
    cache_write: i64,
    cost: f64,
    model: String,
    error: Option<String>,
    /// Pi ended the operation without a retry; its settlement may still come.
    ended: bool,
    /// Settlements of earlier operations that have not arrived yet.
    owed: usize,
}

struct Failure {
    at: f64,
    kind: &'static str,
    source: String,
    message: String,
    trace: Option<u64>,
}

struct FailureGroup {
    kind: &'static str,
    source: String,
    pattern: String,
    example: String,
    count: u64,
    first: f64,
    last: f64,
}

#[derive(Default)]
struct Failures {
    recent: VecDeque<Failure>,
    groups: HashMap<String, FailureGroup>,
}

#[derive(Default)]
struct Launch {
    phases: Vec<(String, f64, f64)>,
    total: Option<f64>,
}

/// One process as the OS reports it.
#[derive(Clone, Debug, PartialEq)]
struct RawProcess {
    pid: u32,
    ppid: u32,
    rss: u64,
    cpu_seconds: f64,
    name: String,
}

#[derive(Clone)]
struct TreeProcess {
    pid: u32,
    ppid: u32,
    depth: usize,
    name: String,
    cpu: f64,
    rss: u64,
}

#[derive(Default)]
struct Resources {
    samples: VecDeque<[f64; 6]>,
    previous: HashMap<u32, f64>,
    previous_at: Option<Instant>,
    tree: Vec<TreeProcess>,
    history: HashMap<u32, VecDeque<[f64; 3]>>,
    error: Option<String>,
}

#[derive(Default)]
struct Statement {
    count: u64,
    total_ns: u64,
    max_ns: u64,
}

#[derive(Default)]
struct Sqlite {
    opens: AtomicU64,
    open_ns: AtomicU64,
    open_max_ns: AtomicU64,
    hits: AtomicU64,
    misses: AtomicU64,
    statements: Mutex<HashMap<Box<[u8]>, Statement>>,
}

pub struct Diagnostics {
    started: f64,
    next: AtomicU64,
    launch: Mutex<Launch>,
    spans: Mutex<VecDeque<Span>>,
    runs: Mutex<HashMap<String, OpenRun>>,
    failures: Mutex<Failures>,
    resources: Mutex<Resources>,
    labels: Mutex<HashMap<u32, String>>,
    sockets: AtomicUsize,
    sqlite: Sqlite,
}

impl Default for Diagnostics {
    fn default() -> Self {
        Self {
            started: now_ms(),
            next: AtomicU64::new(1),
            launch: Mutex::default(),
            spans: Mutex::default(),
            runs: Mutex::default(),
            failures: Mutex::default(),
            resources: Mutex::default(),
            labels: Mutex::default(),
            sockets: AtomicUsize::new(0),
            sqlite: Sqlite::default(),
        }
    }
}

/// Counts an open WebSocket while it lives.
pub struct SocketGuard(&'static Diagnostics);
impl Drop for SocketGuard {
    fn drop(&mut self) {
        self.0.sockets.fetch_sub(1, Ordering::Relaxed);
    }
}

impl Diagnostics {
    fn id(&self) -> u64 {
        self.next.fetch_add(1, Ordering::Relaxed)
    }

    fn push(&self, span: Span) {
        if let Ok(mut spans) = self.spans.lock() {
            if spans.len() == SPANS {
                spans.pop_front();
            }
            spans.push_back(span);
        }
    }

    // ----------------------------------------------------------------- launch

    /// Records one launch phase that began at `since`.
    pub fn launch_phase(&self, name: &str, since: Instant) {
        let duration = since.elapsed().as_secs_f64() * 1000.;
        let start = now_ms() - duration - self.started;
        if let Ok(mut launch) = self.launch.lock() {
            launch
                .phases
                .push((name.to_owned(), start.max(0.), duration));
        }
    }

    /// The daemon is ready: launch took from process start until now.
    pub fn launched(&self) {
        if let Ok(mut launch) = self.launch.lock() {
            launch.total.get_or_insert(now_ms() - self.started);
        }
    }

    // ------------------------------------------------------------------- RPCs

    pub fn rpc(&self, method: &str, start: f64, result: &Result<Value>) {
        if QUIET_METHODS.contains(&method) {
            return;
        }
        let id = self.id();
        let error = result.as_ref().err();
        self.push(Span {
            id,
            trace: id,
            parent: None,
            name: method.to_owned(),
            kind: "rpc",
            start,
            duration: now_ms() - start,
            error: error.map(|e| clip(&e.message, 300)),
            attrs: error.map_or(json!({}), |e| json!({"code": e.code})),
        });
        if let Some(error) = error {
            self.failure("rpc", method, &error.message, Some(id));
        }
    }

    // ------------------------------------------------------------------- runs

    /// Follows one Pi event of a bot's section: runs, model calls and tools.
    pub fn pi_event(&self, session: &str, bot: &str, section: &str, event: &Value) {
        let Ok(mut runs) = self.runs.lock() else {
            return;
        };
        let now = now_ms();
        match event["type"].as_str().unwrap_or("") {
            "agent_start" => {
                // Retries and compaction recovery start again inside the same
                // run. A new prompt can start before the last one settles: that
                // run ends here, and its late settlement is owed.
                let mut owed = 0;
                if let Some(run) = runs.get_mut(session) {
                    if !run.ended {
                        run.boundary = now;
                        return;
                    }
                    if let Some(run) = runs.remove(session) {
                        owed = run.owed + 1;
                        self.finish_run(run, now, true);
                    }
                }
                if runs.len() >= OPEN_RUNS {
                    // Sections that vanished without settling.
                    if let Some(oldest) = runs
                        .iter()
                        .min_by(|a, b| a.1.start.total_cmp(&b.1.start))
                        .map(|(key, _)| key.clone())
                    {
                        runs.remove(&oldest);
                    }
                }
                runs.insert(
                    session.to_owned(),
                    OpenRun {
                        trace: self.id(),
                        start: now,
                        bot: bot.to_owned(),
                        section: section.to_owned(),
                        boundary: now,
                        first_token: None,
                        tools: HashMap::new(),
                        models: 0,
                        tool_calls: 0,
                        input: 0,
                        output: 0,
                        cache_read: 0,
                        cache_write: 0,
                        cost: 0.,
                        model: String::new(),
                        error: None,
                        ended: false,
                        owed,
                    },
                );
            }
            // Some providers announce the message before any content arrives.
            "message_update"
                if event["assistantMessageEvent"]["type"]
                    .as_str()
                    .is_some_and(|kind| kind.ends_with("_delta")) =>
            {
                if let Some(run) = runs.get_mut(session) {
                    run.first_token.get_or_insert(now);
                }
            }
            "message_end" if event["message"]["role"] == "assistant" => {
                let Some(run) = runs.get_mut(session) else {
                    return;
                };
                let message = &event["message"];
                let usage = &message["usage"];
                let tokens = |key: &str| usage[key].as_i64().unwrap_or(0);
                let (input, output, read, write) = (
                    tokens("input"),
                    tokens("output"),
                    tokens("cacheRead"),
                    tokens("cacheWrite"),
                );
                let cost = usage["cost"]["total"].as_f64().unwrap_or(0.);
                let model = message["model"].as_str().unwrap_or("").to_owned();
                let error = match message["stopReason"].as_str() {
                    Some("error") => Some(
                        message["errorMessage"]
                            .as_str()
                            .unwrap_or("The model request failed")
                            .to_owned(),
                    ),
                    _ => None,
                };
                run.models += 1;
                run.input += input;
                run.output += output;
                run.cache_read += read;
                run.cache_write += write;
                run.cost += cost;
                run.model.clone_from(&model);
                run.error = match message["stopReason"].as_str() {
                    Some("aborted") => Some("The turn was interrupted".into()),
                    _ => error.clone(),
                };
                self.push(Span {
                    id: self.id(),
                    trace: run.trace,
                    parent: Some(run.trace),
                    name: format!("model {}", if model.is_empty() { "?" } else { &model }),
                    kind: "model",
                    start: run.boundary,
                    duration: now - run.boundary,
                    error: error.map(|e| clip(&e, 300)),
                    attrs: json!({
                        "provider": message["provider"],
                        "model": model,
                        "input": input,
                        "output": output,
                        "cache_read": read,
                        "cache_write": write,
                        "cache_hit_rate": hit_rate(read, input + read + write),
                        "cost": cost,
                        "stop_reason": message["stopReason"],
                        "first_token_ms": run.first_token.map(|t| t - run.boundary),
                    }),
                });
                run.boundary = now;
                run.first_token = None;
            }
            "tool_execution_start" => {
                if let Some(run) = runs.get_mut(session) {
                    run.tools.insert(
                        event["toolCallId"].as_str().unwrap_or("").to_owned(),
                        OpenTool {
                            id: self.id(),
                            start: now,
                            name: event["toolName"].as_str().unwrap_or("?").to_owned(),
                        },
                    );
                }
            }
            "tool_execution_end" => {
                let Some(run) = runs.get_mut(session) else {
                    return;
                };
                let Some(tool) = run.tools.remove(event["toolCallId"].as_str().unwrap_or(""))
                else {
                    return;
                };
                let failed = event["isError"] == true || event["result"]["isError"] == true;
                let error = failed.then(|| {
                    let text = crate::runtime_store::text(&event["result"]["content"]);
                    clip(
                        if text.is_empty() {
                            "Tool failed"
                        } else {
                            text.trim()
                        },
                        300,
                    )
                });
                run.tool_calls += 1;
                run.boundary = run.boundary.max(now);
                self.push(Span {
                    id: tool.id,
                    trace: run.trace,
                    parent: Some(run.trace),
                    name: format!("tool {}", tool.name),
                    kind: "tool",
                    start: tool.start,
                    duration: now - tool.start,
                    error,
                    attrs: json!({"tool": tool.name}),
                });
            }
            "agent_end" if event["willRetry"] != true => {
                if let Some(run) = runs.get_mut(session) {
                    run.ended = true;
                }
            }
            "agent_settled" => {
                if let Some(run) = runs.get_mut(session)
                    && run.owed > 0
                {
                    run.owed -= 1;
                    return;
                }
                if let Some(run) = runs.remove(session) {
                    self.finish_run(run, now, true);
                }
            }
            _ => {}
        }
    }

    /// Ends a run. `fails` records its error as a run failure too.
    fn finish_run(&self, mut run: OpenRun, now: f64, fails: bool) {
        // A stopped run or a crash can end without the tool's own end event.
        for (_, tool) in run.tools.drain() {
            run.tool_calls += 1;
            self.push(Span {
                id: tool.id,
                trace: run.trace,
                parent: Some(run.trace),
                name: format!("tool {}", tool.name),
                kind: "tool",
                start: tool.start,
                duration: now - tool.start,
                error: None,
                attrs: json!({"tool": tool.name, "unfinished": true}),
            });
        }
        let error = run
            .error
            .clone()
            .filter(|e| e != "The turn was interrupted");
        if let Some(error) = error.as_ref().filter(|_| fails) {
            self.failure("run", &run.bot, error, Some(run.trace));
        }
        self.push(Span {
            id: run.trace,
            trace: run.trace,
            parent: None,
            name: format!("run {}", run.bot),
            kind: "run",
            start: run.start,
            duration: now - run.start,
            error: error.map(|e| clip(&e, 300)),
            attrs: json!({
                "bot": run.bot,
                "section": run.section,
                "model": run.model,
                "model_calls": run.models,
                "tool_calls": run.tool_calls,
                "input": run.input,
                "output": run.output,
                "cache_read": run.cache_read,
                "cache_write": run.cache_write,
                "cache_hit_rate": hit_rate(run.cache_read, run.input + run.cache_read + run.cache_write),
                "cost": run.cost,
                "interrupted": run.error.as_deref() == Some("The turn was interrupted"),
            }),
        });
    }

    /// A bot's Pi process ended while its section was open.
    pub fn process_exit(&self, session: &str, bot: &str, message: &str) {
        let run = self
            .runs
            .lock()
            .ok()
            .and_then(|mut runs| runs.remove(session));
        let trace = run.as_ref().map(|run| run.trace);
        if let Some(mut run) = run {
            run.error = Some(message.to_owned());
            self.finish_run(run, now_ms(), false);
        }
        self.failure("process", bot, message, trace);
    }

    /// Names a process in the tree, such as a bot's Pi process.
    pub fn label_process(&self, pid: Option<u32>, label: String) {
        if let (Some(pid), Ok(mut labels)) = (pid, self.labels.lock()) {
            labels.insert(pid, label);
        }
    }

    pub fn socket(&'static self) -> SocketGuard {
        self.sockets.fetch_add(1, Ordering::Relaxed);
        SocketGuard(self)
    }

    // --------------------------------------------------------------- failures

    fn failure(&self, kind: &'static str, source: &str, message: &str, trace: Option<u64>) {
        let Ok(mut failures) = self.failures.lock() else {
            return;
        };
        let at = now_ms();
        let message = clip(message.trim(), 500);
        let pattern = failure_pattern(&message);
        let key = format!("{kind}\u{0}{source}\u{0}{pattern}");
        if let Some(group) = failures.groups.get_mut(&key) {
            group.count += 1;
            group.last = at;
            group.example.clone_from(&message);
        } else {
            if failures.groups.len() >= FAILURE_GROUPS
                && let Some(oldest) = failures
                    .groups
                    .iter()
                    .min_by(|a, b| a.1.last.total_cmp(&b.1.last))
                    .map(|(key, _)| key.clone())
            {
                failures.groups.remove(&oldest);
            }
            failures.groups.insert(
                key,
                FailureGroup {
                    kind,
                    source: source.to_owned(),
                    pattern,
                    example: message.clone(),
                    count: 1,
                    first: at,
                    last: at,
                },
            );
        }
        if failures.recent.len() == FAILURES {
            failures.recent.pop_front();
        }
        failures.recent.push_back(Failure {
            at,
            kind,
            source: source.to_owned(),
            message,
            trace,
        });
    }

    // -------------------------------------------------------------- resources

    /// Reads the process table and records one sample of this daemon's tree.
    pub fn sample(&self) {
        let processes = read_processes();
        let Ok(mut resources) = self.resources.lock() else {
            return;
        };
        let processes = match processes {
            Ok(processes) => processes,
            Err(error) => {
                resources.error = Some(error);
                return;
            }
        };
        resources.error = None;
        let now = Instant::now();
        let elapsed = resources
            .previous_at
            .map(|at| now.duration_since(at).as_secs_f64())
            .filter(|s| *s > 0.);
        let tree = tree(&processes, std::process::id());
        let mut previous = HashMap::new();
        let mut rows = Vec::with_capacity(tree.len());
        for (process, depth) in tree {
            let cpu = match (elapsed, resources.previous.get(&process.pid)) {
                (Some(elapsed), Some(before)) => {
                    ((process.cpu_seconds - before).max(0.) / elapsed) * 100.
                }
                _ => 0.,
            };
            previous.insert(process.pid, process.cpu_seconds);
            rows.push(TreeProcess {
                pid: process.pid,
                ppid: process.ppid,
                depth,
                name: process.name.clone(),
                cpu,
                rss: process.rss,
            });
        }
        let t = now_ms();
        let own = rows.first();
        let sample = [
            t,
            rows.iter().map(|p| p.cpu).sum(),
            rows.iter().map(|p| p.rss as f64).sum(),
            rows.len() as f64,
            own.map_or(0., |p| p.cpu),
            own.map_or(0., |p| p.rss as f64),
        ];
        if resources.samples.len() == SAMPLES {
            resources.samples.pop_front();
        }
        resources.samples.push_back(sample);
        let alive = rows.iter().map(|p| p.pid).collect::<HashSet<_>>();
        resources.history.retain(|pid, _| alive.contains(pid));
        for row in &rows {
            let history = resources.history.entry(row.pid).or_default();
            if history.len() == PROCESS_SAMPLES {
                history.pop_front();
            }
            history.push_back([t, row.cpu, row.rss as f64]);
        }
        if let Ok(mut labels) = self.labels.lock() {
            labels.retain(|pid, _| alive.contains(pid));
        }
        resources.previous = previous;
        resources.previous_at = Some(now);
        resources.tree = rows;
    }

    // ------------------------------------------------------------- snapshots

    /// Everything the Diagnostics page shows. `load` comes from the runtime.
    pub fn snapshot(&self, home: &Path, owner: &str, load: Value, params: &Value) -> Value {
        let now = now_ms();
        let spans = self
            .spans
            .lock()
            .map(|spans| spans.iter().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        let open_runs = self.runs.lock().map(|runs| runs.len()).unwrap_or(0);
        let mut load = load;
        load["sockets"] = json!(self.sockets.load(Ordering::Relaxed));
        load["open_runs"] = json!(open_runs);
        load["rpc_per_minute"] = json!(
            spans
                .iter()
                .filter(|s| s.kind == "rpc" && now - s.start <= 60_000.)
                .count()
        );
        load["runs_last_hour"] = json!(
            spans
                .iter()
                .filter(|s| s.kind == "run" && now - s.start <= 3_600_000.)
                .count()
        );
        json!({
            "generated_at": now,
            "daemon": self.daemon(home, now),
            "host": host(home),
            "launch": self.launch_json(),
            "resources": self.resources_json(),
            "load": load,
            "caches": {
                "prompt": prompt_cache(home, owner).unwrap_or_else(|error| json!({"error": error.message})),
                "sqlite": self.sqlite_json(home),
            },
            "spans": spans_json(&spans, params["span_name"].as_str()),
            "failures": self.failures_json(),
        })
    }

    /// Every span of one trace, oldest first.
    pub fn trace(&self, trace: u64) -> Value {
        let mut spans = self
            .spans
            .lock()
            .map(|spans| {
                spans
                    .iter()
                    .filter(|s| s.trace == trace)
                    .map(Span::json)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        // The run first, then its steps in the order they began.
        spans.sort_by(|a, b| {
            let start = |span: &Value| span["start"].as_f64().unwrap_or(0.);
            (!a["parent"].is_null())
                .cmp(&!b["parent"].is_null())
                .then(start(a).total_cmp(&start(b)))
                .then(a["id"].as_u64().cmp(&b["id"].as_u64()))
        });
        json!({"trace": trace, "spans": spans})
    }

    fn daemon(&self, home: &Path, now: f64) -> Value {
        json!({
            "pid": std::process::id(),
            "version": crate::version(),
            "pi_version": serde_json::from_str::<Value>(include_str!("../../pi-runtime/package.json"))
                .ok()
                .and_then(|p| p["dependencies"]["@earendil-works/pi-coding-agent"].as_str().map(str::to_owned)),
            "started_at": self.started,
            "uptime_s": (now - self.started) / 1000.,
            "supervisor": std::env::var("HEXBOT_SUPERVISOR").ok(),
            "home": home,
        })
    }

    fn launch_json(&self) -> Value {
        let Ok(launch) = self.launch.lock() else {
            return json!({});
        };
        json!({
            "total_ms": launch.total,
            "phases": launch.phases.iter().map(|(name, start, duration)| {
                json!({"name": name, "start_ms": start, "duration_ms": duration})
            }).collect::<Vec<_>>(),
        })
    }

    fn resources_json(&self) -> Value {
        let Ok(resources) = self.resources.lock() else {
            return json!({});
        };
        let labels = self.labels.lock().map(|l| l.clone()).unwrap_or_default();
        let own = std::process::id();
        json!({
            "interval_s": SAMPLE_EVERY.as_secs(),
            "error": resources.error,
            "samples": resources.samples.iter().map(|s| json!({
                "t": s[0], "cpu": s[1], "rss": s[2], "processes": s[3],
                "daemon_cpu": s[4], "daemon_rss": s[5],
            })).collect::<Vec<_>>(),
            "processes": resources.tree.iter().map(|p| json!({
                "pid": p.pid,
                "ppid": p.ppid,
                "depth": p.depth,
                "name": p.name,
                "label": if p.pid == own { Some("Hexbot daemon".to_owned()) } else { labels.get(&p.pid).cloned() },
                "cpu": p.cpu,
                "rss": p.rss,
                "history": resources.history.get(&p.pid).map(|h| h.iter().collect::<Vec<_>>()),
            })).collect::<Vec<_>>(),
        })
    }

    fn sqlite_json(&self, home: &Path) -> Value {
        let s = &self.sqlite;
        let opens = s.opens.load(Ordering::Relaxed);
        let hits = s.hits.load(Ordering::Relaxed);
        let misses = s.misses.load(Ordering::Relaxed);
        let mut rows = s
            .statements
            .lock()
            .map(|map| {
                map.iter()
                    .map(|(sql, stat)| {
                        (
                            String::from_utf8_lossy(sql).into_owned(),
                            stat.count,
                            stat.total_ns,
                            stat.max_ns,
                        )
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let statements: u64 = rows.iter().map(|r| r.1).sum();
        let total_ns: u64 = rows.iter().map(|r| r.2).sum();
        let row = |r: &(String, u64, u64, u64)| {
            json!({
                "sql": clip(&r.0.split_whitespace().collect::<Vec<_>>().join(" "), 400),
                "count": r.1,
                "total_ms": r.2 as f64 / 1e6,
                "avg_ms": r.2 as f64 / 1e6 / r.1.max(1) as f64,
                "max_ms": r.3 as f64 / 1e6,
            })
        };
        rows.sort_by_key(|r| std::cmp::Reverse(r.2));
        let busiest = rows.iter().take(8).map(row).collect::<Vec<_>>();
        rows.sort_by_key(|r| std::cmp::Reverse(r.3));
        let slowest = rows.iter().take(8).map(row).collect::<Vec<_>>();
        let size = |name: &str| std::fs::metadata(home.join(name)).map(|m| m.len()).ok();
        json!({
            "opens": opens,
            "open_avg_ms": s.open_ns.load(Ordering::Relaxed) as f64 / 1e6 / opens.max(1) as f64,
            "open_max_ms": s.open_max_ns.load(Ordering::Relaxed) as f64 / 1e6,
            "cache_hits": hits,
            "cache_misses": misses,
            "cache_hit_rate": hit_rate(hits as i64, (hits + misses) as i64),
            "statements": statements,
            "statement_avg_ms": total_ns as f64 / 1e6 / statements.max(1) as f64,
            "statement_total_ms": total_ns as f64 / 1e6,
            "busiest": busiest,
            "slowest": slowest,
            "db_bytes": size("hexbot.db"),
            "runtime_db_bytes": size("hexbot-runtime.db"),
            "wal_bytes": size("hexbot.db-wal"),
        })
    }

    fn failures_json(&self) -> Value {
        let Ok(failures) = self.failures.lock() else {
            return json!({});
        };
        let mut common = failures.groups.values().collect::<Vec<_>>();
        common.sort_by(|a, b| b.count.cmp(&a.count).then(b.last.total_cmp(&a.last)));
        json!({
            "total": failures.groups.values().map(|g| g.count).sum::<u64>(),
            "recent": failures.recent.iter().rev().map(|f| json!({
                "at": f.at, "kind": f.kind, "source": f.source, "message": f.message, "trace": f.trace,
            })).collect::<Vec<_>>(),
            "common": common.iter().take(30).map(|g| json!({
                "kind": g.kind, "source": g.source, "pattern": g.pattern, "example": g.example,
                "count": g.count, "first": g.first, "last": g.last,
            })).collect::<Vec<_>>(),
        })
    }
}

fn hit_rate(hits: i64, total: i64) -> Option<f64> {
    (total > 0).then(|| hits as f64 / total as f64)
}

/// A failure message with the parts that change between occurrences replaced,
/// so repeats of one problem count together.
fn failure_pattern(message: &str) -> String {
    static RULES: LazyLock<Vec<(Regex, &str)>> = LazyLock::new(|| {
        [
            (r#""[^"]*""#, "\"…\""),
            (r"'[^']*'", "'…'"),
            (r"`[^`]*`", "`…`"),
            (r"https?://\S+", "<url>"),
            (
                r"\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b",
                "<id>",
            ),
            (r"\b[A-Za-z]+[-_][0-9a-fA-F]{6,}\b", "<id>"),
            (r"\b[0-9a-fA-F]*[0-9][0-9a-fA-F]{7,}\b", "<id>"),
            (r"\d+(\.\d+)?", "#"),
        ]
        .into_iter()
        .map(|(rule, with)| (Regex::new(rule).unwrap(), with))
        .collect()
    });
    let mut pattern = message.to_owned();
    for (rule, with) in RULES.iter() {
        pattern = rule.replace_all(&pattern, *with).into_owned();
    }
    pattern
}

fn spans_json(spans: &[Span], name: Option<&str>) -> Value {
    let mut by_name: HashMap<&str, Vec<&Span>> = HashMap::new();
    for span in spans {
        by_name.entry(&span.name).or_default().push(span);
    }
    let mut names = by_name
        .into_iter()
        .map(|(name, spans)| {
            let mut durations = spans.iter().map(|s| s.duration).collect::<Vec<_>>();
            durations.sort_by(f64::total_cmp);
            let count = durations.len();
            json!({
                "name": name,
                "kind": spans[0].kind,
                "count": count,
                "errors": spans.iter().filter(|s| s.error.is_some()).count(),
                "avg_ms": durations.iter().sum::<f64>() / count as f64,
                "p95_ms": percentile(&durations, 0.95),
                "max_ms": durations.last(),
                "total_ms": durations.iter().sum::<f64>(),
                "last_at": spans.iter().map(|s| s.start).fold(0., f64::max),
            })
        })
        .collect::<Vec<_>>();
    names.sort_by(|a, b| {
        let total = |name: &Value| name["total_ms"].as_f64().unwrap_or(0.);
        total(b).total_cmp(&total(a))
    });
    let recent = spans
        .iter()
        .rev()
        .filter(|s| name.is_none_or(|name| s.name == name))
        .take(RECENT_SPANS)
        .map(Span::json)
        .collect::<Vec<_>>();
    let mut children: HashMap<u64, (usize, usize)> = HashMap::new();
    for span in spans.iter().filter(|s| s.parent.is_some()) {
        let entry = children.entry(span.trace).or_default();
        entry.0 += 1;
        entry.1 += usize::from(span.error.is_some());
    }
    let traces = spans
        .iter()
        .rev()
        .filter(|s| s.kind == "run")
        .take(RECENT_TRACES)
        .map(|s| {
            let (count, errors) = children.get(&s.trace).copied().unwrap_or_default();
            let mut trace = s.json();
            trace["spans"] = json!(count + 1);
            trace["errors"] = json!(errors + usize::from(s.error.is_some()));
            trace
        })
        .collect::<Vec<_>>();
    json!({
        "kept": spans.len(),
        "capacity": SPANS,
        "names": names,
        "recent": recent,
        "traces": traces,
    })
}

fn percentile(sorted: &[f64], p: f64) -> Option<f64> {
    if sorted.is_empty() {
        return None;
    }
    let rank = ((sorted.len() as f64) * p).ceil() as usize;
    sorted
        .get(rank.saturating_sub(1).min(sorted.len() - 1))
        .copied()
}

/// Prompt cache use over the last day, by bot and model. A hit is an input
/// token read from the provider's cache.
fn prompt_cache(home: &Path, owner: &str) -> Result<Value> {
    // Usage lives in the runtime store, which exists once a bot has run.
    let conn = if home.join("hexbot-runtime.db").exists() {
        crate::runtime_store::open(home)?
    } else {
        rusqlite::Connection::open_in_memory()?
    };
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS native_usage(session_id TEXT,owner_id TEXT,bot TEXT,model TEXT,provider TEXT,input_tokens INTEGER,output_tokens INTEGER,cache_read_tokens INTEGER,cache_write_tokens INTEGER,cost REAL,timestamp REAL)",
    )?;
    let since = common::now() - 86_400.;
    let query = |group: &str| {
        common::rows(
            &conn,
            &format!(
                "SELECT {group} AS name,COUNT(*) AS calls,SUM(input_tokens) AS input,SUM(cache_read_tokens) AS cache_read,SUM(cache_write_tokens) AS cache_write,SUM(output_tokens) AS output,SUM(cost) AS cost FROM native_usage WHERE owner_id=?1 AND timestamp>=?2 GROUP BY {group} ORDER BY SUM(input_tokens+cache_read_tokens+cache_write_tokens) DESC LIMIT 30"
            ),
            &[&owner, &since],
        )
    };
    let rate = |mut rows: Vec<Value>| {
        for row in &mut rows {
            let read = row["cache_read"].as_i64().unwrap_or(0);
            let total = row["input"].as_i64().unwrap_or(0)
                + read
                + row["cache_write"].as_i64().unwrap_or(0);
            row["hit_rate"] = json!(hit_rate(read, total));
        }
        rows
    };
    let by_bot = rate(query("bot")?);
    let by_model = rate(query("model")?);
    // The totals cover every bot, not only the 30 listed.
    let totals = common::rows(
        &conn,
        "SELECT COUNT(*) AS calls,SUM(input_tokens) AS input,SUM(cache_read_tokens) AS cache_read,SUM(cache_write_tokens) AS cache_write,SUM(output_tokens) AS output FROM native_usage WHERE owner_id=?1 AND timestamp>=?2",
        &[&owner, &since],
    )?;
    let sum = |key: &str| totals.first().and_then(|r| r[key].as_i64()).unwrap_or(0);
    let (input, read, write) = (sum("input"), sum("cache_read"), sum("cache_write"));
    Ok(json!({
        "window_h": 24,
        "calls": sum("calls"),
        "input": input,
        "cache_read": read,
        "cache_write": write,
        "output": sum("output"),
        "hit_rate": hit_rate(read, input + read + write),
        "by_bot": by_bot,
        "by_model": by_model,
    }))
}

// --------------------------------------------------------------------- SQLite

/// Follows every SQLite connection this process opens from now on: each
/// statement's duration, and the page cache hits and misses it caused.
///
/// This uses SQLite's profile callback, not `sqlite3_trace_v2`, because a
/// connection keeps only one v2 trace: a profile callback leaves another
/// tracer in place, and a later v2 trace (as some tests install) replaces it.
pub(crate) fn trace_connections() {
    static REGISTER: Once = Once::new();
    REGISTER.call_once(|| {
        // SAFETY: SQLite keeps the static callback for future connections.
        unsafe {
            ffi::sqlite3_auto_extension(Some(profile_connection));
        }
    });
}

/// Records how long `db::open` took to open its connection.
pub(crate) fn opened(since: Instant) {
    let s = &get().sqlite;
    let ns = since.elapsed().as_nanos() as u64;
    s.opens.fetch_add(1, Ordering::Relaxed);
    s.open_ns.fetch_add(ns, Ordering::Relaxed);
    s.open_max_ns.fetch_max(ns, Ordering::Relaxed);
}

unsafe extern "C" fn profile_connection(
    db: *mut ffi::sqlite3,
    _error: *mut *mut c_char,
    _api: *const ffi::sqlite3_api_routines,
) -> c_int {
    // SAFETY: SQLite passes the connection it is opening. The callback gets
    // it back only while one of its statements runs.
    unsafe {
        ffi::sqlite3_profile(db, Some(profile), db.cast());
    }
    ffi::SQLITE_OK
}

unsafe extern "C" fn profile(db: *mut c_void, sql: *const c_char, ns: u64) {
    let _ = std::panic::catch_unwind(|| {
        if sql.is_null() {
            return;
        }
        let (mut hits, mut misses, mut highwater) = (0, 0, 0);
        // SAFETY: `db` is the connection whose statement just finished and
        // `sql` its text, both valid during the callback. Reading the cache
        // counters with reset leaves what the next statement adds.
        let sql = unsafe {
            ffi::sqlite3_db_status(
                db.cast(),
                ffi::SQLITE_DBSTATUS_CACHE_HIT,
                &mut hits,
                &mut highwater,
                1,
            );
            ffi::sqlite3_db_status(
                db.cast(),
                ffi::SQLITE_DBSTATUS_CACHE_MISS,
                &mut misses,
                &mut highwater,
                1,
            );
            CStr::from_ptr(sql).to_bytes()
        };
        let s = &get().sqlite;
        s.hits.fetch_add(hits.max(0) as u64, Ordering::Relaxed);
        s.misses.fetch_add(misses.max(0) as u64, Ordering::Relaxed);
        s.statement(sql, ns);
    });
}

impl Sqlite {
    fn statement(&self, sql: &[u8], ns: u64) {
        let Ok(mut map) = self.statements.lock() else {
            return;
        };
        let key: &[u8] = if map.contains_key(sql) || map.len() < STATEMENTS {
            sql
        } else {
            OTHER_STATEMENTS.as_bytes()
        };
        let stat = match map.get_mut(key) {
            Some(stat) => stat,
            None => map.entry(key.into()).or_default(),
        };
        stat.count += 1;
        stat.total_ns += ns;
        stat.max_ns = stat.max_ns.max(ns);
    }
}

// ------------------------------------------------------------------ processes

/// Samples the process tree every `SAMPLE_EVERY` for as long as the daemon runs.
pub fn start_sampler() {
    static STARTED: Once = Once::new();
    STARTED.call_once(|| {
        tokio::spawn(async {
            let mut tick = tokio::time::interval(SAMPLE_EVERY);
            loop {
                tick.tick().await;
                let _ = tokio::task::spawn_blocking(|| get().sample()).await;
            }
        });
    });
}

/// The subtree under `root`, depth first, with each process's depth.
fn tree(processes: &[RawProcess], root: u32) -> Vec<(&RawProcess, usize)> {
    let mut children: HashMap<u32, Vec<&RawProcess>> = HashMap::new();
    for process in processes {
        if process.pid != process.ppid {
            children.entry(process.ppid).or_default().push(process);
        }
    }
    for list in children.values_mut() {
        list.sort_by_key(|p| p.pid);
    }
    let mut out = Vec::new();
    let Some(top) = processes.iter().find(|p| p.pid == root) else {
        return out;
    };
    let mut stack = vec![(top, 0)];
    while let Some((process, depth)) = stack.pop() {
        out.push((process, depth));
        if let Some(list) = children.get(&process.pid) {
            for child in list.iter().rev() {
                stack.push((child, depth + 1));
            }
        }
    }
    out
}

#[cfg(target_os = "linux")]
fn read_processes() -> std::result::Result<Vec<RawProcess>, String> {
    // SAFETY: sysconf only reads configuration values.
    let (ticks, page) = unsafe {
        (
            libc::sysconf(libc::_SC_CLK_TCK).max(1) as f64,
            libc::sysconf(libc::_SC_PAGESIZE).max(1) as u64,
        )
    };
    let entries = std::fs::read_dir("/proc").map_err(|e| e.to_string())?;
    Ok(entries
        .filter_map(|entry| {
            let entry = entry.ok()?;
            entry.file_name().to_str()?.parse::<u32>().ok()?;
            let stat = std::fs::read_to_string(entry.path().join("stat")).ok()?;
            parse_proc_stat(&stat, ticks, page)
        })
        .collect())
}

/// One `/proc/<pid>/stat` line. The name sits in parentheses and may hold spaces.
#[cfg(any(target_os = "linux", test))]
fn parse_proc_stat(stat: &str, ticks: f64, page: u64) -> Option<RawProcess> {
    let open = stat.find('(')?;
    let close = stat.rfind(')')?;
    let pid = stat[..open].trim().parse().ok()?;
    let name = stat[open + 1..close].to_owned();
    let fields = stat[close + 1..].split_whitespace().collect::<Vec<_>>();
    let number = |index: usize| fields.get(index)?.parse::<u64>().ok();
    Some(RawProcess {
        pid,
        ppid: number(1)? as u32,
        cpu_seconds: (number(11)? + number(12)?) as f64 / ticks,
        rss: number(21)? * page,
        name,
    })
}

#[cfg(target_os = "macos")]
fn read_processes() -> std::result::Result<Vec<RawProcess>, String> {
    let child = std::process::Command::new("/bin/ps")
        .args(["-axo", "pid=,ppid=,rss=,time=,comm="])
        .stdout(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    let sampler = child.id();
    let output = child.wait_with_output().map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err("ps failed".into());
    }
    // The sampler's own `ps` is not part of the daemon's work.
    let mut processes = parse_ps(&String::from_utf8_lossy(&output.stdout));
    processes.retain(|p| p.pid != sampler);
    Ok(processes)
}

/// `ps -axo pid=,ppid=,rss=,time=,comm=`: RSS in KiB, CPU time as
/// `[[dd-]hh:]mm:ss[.cc]`, and the command, which may hold spaces.
#[cfg(any(target_os = "macos", test))]
fn parse_ps(text: &str) -> Vec<RawProcess> {
    text.lines()
        .filter_map(|line| {
            let mut parts = line.split_whitespace();
            let pid = parts.next()?.parse().ok()?;
            let ppid = parts.next()?.parse().ok()?;
            let rss = parts.next()?.parse::<u64>().ok()? * 1024;
            let cpu_seconds = cpu_time(parts.next()?)?;
            let command = parts.collect::<Vec<_>>().join(" ");
            let name = command.rsplit('/').next().unwrap_or(&command).to_owned();
            Some(RawProcess {
                pid,
                ppid,
                rss,
                cpu_seconds,
                name,
            })
        })
        .collect()
}

#[cfg(any(target_os = "macos", test))]
fn cpu_time(text: &str) -> Option<f64> {
    let (days, rest) = match text.split_once('-') {
        Some((days, rest)) => (days.parse::<f64>().ok()?, rest),
        None => (0., text),
    };
    let mut seconds = 0.;
    for part in rest.split(':') {
        seconds = seconds * 60. + part.parse::<f64>().ok()?;
    }
    Some(days * 86_400. + seconds)
}

// ----------------------------------------------------------------------- host

fn host(home: &Path) -> Value {
    static FIXED: LazyLock<Value> = LazyLock::new(|| {
        let (kernel, machine) = uname();
        json!({
            "hostname": hostname(),
            "os": std::env::consts::OS,
            "os_version": os_version(),
            "kernel": kernel,
            "arch": machine.unwrap_or_else(|| std::env::consts::ARCH.to_owned()),
            "cpu_model": cpu_model(),
            "cpu_cores": std::thread::available_parallelism().map(|n| n.get()).ok(),
            "memory_total": memory_total(),
        })
    });
    let mut host = FIXED.clone();
    if let Some(load) = load_average() {
        host["load"] = json!(load);
    }
    host["memory_available"] = json!(memory_available());
    if let Some((total, available)) = disk(home) {
        host["disk_total"] = json!(total);
        host["disk_available"] = json!(available);
    }
    host
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn load_average() -> Option<[f64; 3]> {
    let mut load = [0f64; 3];
    // SAFETY: getloadavg writes at most three values into the array.
    (unsafe { libc::getloadavg(load.as_mut_ptr(), 3) } == 3).then_some(load)
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn hostname() -> Option<String> {
    let mut name = [0 as libc::c_char; 256];
    // SAFETY: the buffer is writable for its whole length.
    if unsafe { libc::gethostname(name.as_mut_ptr(), name.len()) } != 0 {
        return None;
    }
    // SAFETY: gethostname wrote a NUL-terminated name into the buffer.
    let name = unsafe { CStr::from_ptr(name.as_ptr()) };
    Some(name.to_string_lossy().into_owned())
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn uname() -> (Option<String>, Option<String>) {
    // SAFETY: utsname is plain data, and uname fills it.
    let mut info: libc::utsname = unsafe { std::mem::zeroed() };
    if unsafe { libc::uname(&mut info) } != 0 {
        return (None, None);
    }
    // SAFETY: uname writes NUL-terminated strings.
    let text = |field: &[libc::c_char]| unsafe {
        CStr::from_ptr(field.as_ptr())
            .to_string_lossy()
            .into_owned()
    };
    (
        Some(format!("{} {}", text(&info.sysname), text(&info.release))),
        Some(text(&info.machine)),
    )
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn disk(home: &Path) -> Option<(u64, u64)> {
    use std::os::unix::ffi::OsStrExt;
    let path = std::ffi::CString::new(home.as_os_str().as_bytes()).ok()?;
    #[cfg(target_os = "macos")]
    {
        // SAFETY: statfs fills the struct for a NUL-terminated path.
        let mut stat: libc::statfs = unsafe { std::mem::zeroed() };
        if unsafe { libc::statfs(path.as_ptr(), &mut stat) } != 0 {
            return None;
        }
        let block = stat.f_bsize as u64;
        Some((stat.f_blocks * block, stat.f_bavail * block))
    }
    #[cfg(target_os = "linux")]
    {
        // SAFETY: statvfs fills the struct for a NUL-terminated path.
        let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
        if unsafe { libc::statvfs(path.as_ptr(), &mut stat) } != 0 {
            return None;
        }
        let block = stat.f_frsize as u64;
        Some((stat.f_blocks as u64 * block, stat.f_bavail as u64 * block))
    }
}

#[cfg(target_os = "macos")]
fn sysctl_bytes(name: &str) -> Option<Vec<u8>> {
    let name = std::ffi::CString::new(name).ok()?;
    let mut size = 0usize;
    // SAFETY: a null buffer asks sysctl for the size only.
    if unsafe {
        libc::sysctlbyname(
            name.as_ptr(),
            std::ptr::null_mut(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    } != 0
    {
        return None;
    }
    let mut buffer = vec![0u8; size];
    // SAFETY: the buffer holds `size` bytes, which sysctl may fill.
    if unsafe {
        libc::sysctlbyname(
            name.as_ptr(),
            buffer.as_mut_ptr().cast(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    } != 0
    {
        return None;
    }
    buffer.truncate(size);
    Some(buffer)
}

#[cfg(target_os = "macos")]
fn os_version() -> Option<String> {
    let version = sysctl_bytes("kern.osproductversion")?;
    Some(format!(
        "macOS {}",
        String::from_utf8_lossy(&version).trim_end_matches('\0')
    ))
}

#[cfg(target_os = "linux")]
fn os_version() -> Option<String> {
    let release = std::fs::read_to_string("/etc/os-release").ok()?;
    release.lines().find_map(|line| {
        line.strip_prefix("PRETTY_NAME=")
            .map(|name| name.trim_matches('"').to_owned())
    })
}

#[cfg(target_os = "macos")]
fn cpu_model() -> Option<String> {
    let model = sysctl_bytes("machdep.cpu.brand_string")?;
    Some(
        String::from_utf8_lossy(&model)
            .trim_end_matches('\0')
            .to_owned(),
    )
}

#[cfg(target_os = "linux")]
fn cpu_model() -> Option<String> {
    let info = std::fs::read_to_string("/proc/cpuinfo").ok()?;
    info.lines().find_map(|line| {
        let (key, value) = line.split_once(':')?;
        matches!(key.trim(), "model name" | "Model").then(|| value.trim().to_owned())
    })
}

#[cfg(target_os = "macos")]
fn memory_total() -> Option<u64> {
    let bytes = sysctl_bytes("hw.memsize")?;
    Some(u64::from_ne_bytes(bytes.get(..8)?.try_into().ok()?))
}

#[cfg(target_os = "linux")]
fn memory_total() -> Option<u64> {
    meminfo("MemTotal:")
}

#[cfg(target_os = "linux")]
fn memory_available() -> Option<u64> {
    meminfo("MemAvailable:")
}

#[cfg(target_os = "linux")]
fn meminfo(key: &str) -> Option<u64> {
    let info = std::fs::read_to_string("/proc/meminfo").ok()?;
    let line = info.lines().find(|line| line.starts_with(key))?;
    Some(
        line[key.len()..]
            .trim()
            .trim_end_matches("kB")
            .trim()
            .parse::<u64>()
            .ok()?
            * 1024,
    )
}

// The daemon runs on macOS and Linux only. These keep the module building
// for the Windows security probe, which compiles the daemon without its
// platform guard; there the host and process figures are simply missing.
#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn read_processes() -> std::result::Result<Vec<RawProcess>, String> {
    Err("Process sampling needs macOS or Linux".into())
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn load_average() -> Option<[f64; 3]> {
    None
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn hostname() -> Option<String> {
    None
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn uname() -> (Option<String>, Option<String>) {
    (None, None)
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn disk(_home: &Path) -> Option<(u64, u64)> {
    None
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn os_version() -> Option<String> {
    None
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn cpu_model() -> Option<String> {
    None
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn memory_total() -> Option<u64> {
    None
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn memory_available() -> Option<u64> {
    None
}

/// Free, inactive, speculative and purgeable pages: what macOS can hand out
/// without swapping.
#[cfg(target_os = "macos")]
fn memory_available() -> Option<u64> {
    let output = std::process::Command::new("/usr/bin/vm_stat")
        .output()
        .ok()?;
    parse_vm_stat(&String::from_utf8_lossy(&output.stdout))
}

#[cfg(any(target_os = "macos", test))]
fn parse_vm_stat(text: &str) -> Option<u64> {
    let page = text
        .lines()
        .next()?
        .split("page size of ")
        .nth(1)?
        .split_whitespace()
        .next()?
        .parse::<u64>()
        .ok()?;
    let pages = |name: &str| {
        text.lines()
            .find(|line| line.starts_with(name))
            .and_then(|line| line.rsplit(':').next())
            .and_then(|n| n.trim().trim_end_matches('.').parse::<u64>().ok())
            .unwrap_or(0)
    };
    Some(
        (pages("Pages free")
            + pages("Pages inactive")
            + pages("Pages speculative")
            + pages("Pages purgeable"))
            * page,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raw(pid: u32, ppid: u32) -> RawProcess {
        RawProcess {
            pid,
            ppid,
            rss: 0,
            cpu_seconds: 0.,
            name: format!("p{pid}"),
        }
    }

    #[test]
    fn tree_walks_only_the_daemons_descendants_depth_first() {
        let processes = [
            raw(1, 0),
            raw(10, 1),
            raw(12, 10),
            raw(11, 10),
            raw(13, 12),
            raw(20, 1),
        ];
        let tree = tree(&processes, 10)
            .into_iter()
            .map(|(p, depth)| (p.pid, depth))
            .collect::<Vec<_>>();
        assert_eq!(tree, [(10, 0), (11, 1), (12, 1), (13, 2)]);
        assert!(super::tree(&processes, 99).is_empty());
    }

    #[test]
    fn ps_lines_keep_spaced_commands_and_cpu_time() {
        let parsed = parse_ps(
            "  412     1  20480   0:01.50 /Applications/Hexbot.app/Contents/MacOS/Hexbot Helper (Renderer)\n\
             garbage\n\
             500   412   1024 1-02:03:04 node\n",
        );
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].name, "Hexbot Helper (Renderer)");
        assert_eq!(parsed[0].rss, 20480 * 1024);
        assert_eq!(parsed[0].cpu_seconds, 1.5);
        assert_eq!(parsed[1].cpu_seconds, 86_400. + 2. * 3600. + 3. * 60. + 4.);
    }

    #[test]
    fn proc_stat_reads_names_with_parentheses_and_spaces() {
        let stat = "321 (node (pi) x) S 300 321 321 0 -1 4194304 1 0 0 0 250 50 0 0 20 0 7 0 100 1000 42 18446744073709551615";
        let process = parse_proc_stat(stat, 100., 4096).unwrap();
        assert_eq!(process.pid, 321);
        assert_eq!(process.ppid, 300);
        assert_eq!(process.name, "node (pi) x");
        assert_eq!(process.cpu_seconds, 3.);
        assert_eq!(process.rss, 42 * 4096);
    }

    #[test]
    fn vm_stat_counts_reclaimable_pages() {
        let text = "Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free:                               10.\nPages active:                            99.\nPages inactive:                            5.\nPages speculative:                         1.\nPages purgeable:                           4.\n";
        assert_eq!(parse_vm_stat(text), Some(20 * 16384));
    }

    #[test]
    fn failure_patterns_group_repeats_of_one_problem() {
        let a = failure_pattern(
            "Provider returned 529 for request req_8f3a9c21: \"overloaded\" after 3.2s",
        );
        let b =
            failure_pattern("Provider returned 503 for request req_00aa11bb: \"busy\" after 12s");
        assert_eq!(a, b);
        assert_eq!(
            failure_pattern("bot 4f1c2d3e-0000-4000-8000-123456789abc not found"),
            "bot <id> not found"
        );
    }

    #[test]
    fn percentile_takes_the_nearest_rank() {
        let values = (1..=20).map(f64::from).collect::<Vec<_>>();
        assert_eq!(percentile(&values, 0.95), Some(19.));
        assert_eq!(percentile(&[4.], 0.95), Some(4.));
        assert_eq!(percentile(&[], 0.95), None);
    }

    #[test]
    fn a_run_records_model_and_tool_spans_and_its_failure() {
        let d = Diagnostics::default();
        let events = [
            json!({"type":"agent_start"}),
            json!({"type":"message_start","message":{"role":"assistant"}}),
            json!({"type":"message_end","message":{"role":"assistant","model":"m1","provider":"p","stopReason":"toolUse","usage":{"input":10,"output":5,"cacheRead":30,"cacheWrite":0,"cost":{"total":0.5}}}}),
            json!({"type":"tool_execution_start","toolCallId":"t1","toolName":"bash"}),
            json!({"type":"tool_execution_end","toolCallId":"t1","toolName":"bash","isError":true,"result":{"content":[{"type":"text","text":"exit 1"}]}}),
            json!({"type":"message_end","message":{"role":"assistant","model":"m1","stopReason":"error","errorMessage":"Rate limited","usage":{"input":40}}}),
            json!({"type":"agent_settled"}),
        ];
        for event in &events {
            d.pi_event("live-1", "owl", "sec-1", event);
        }
        let spans = Vec::from(d.spans.lock().unwrap().clone());
        let kinds = spans.iter().map(|s| s.kind).collect::<Vec<_>>();
        assert_eq!(kinds, ["model", "tool", "model", "run"]);
        let run = spans.last().unwrap();
        assert!(spans.iter().all(|s| s.trace == run.trace));
        assert_eq!(run.name, "run owl");
        assert_eq!(run.error.as_deref(), Some("Rate limited"));
        assert_eq!(run.attrs["model_calls"], 2);
        assert_eq!(run.attrs["tool_calls"], 1);
        assert_eq!(run.attrs["cache_read"], 30);
        assert_eq!(spans[1].error.as_deref(), Some("exit 1"));
        assert_eq!(spans[0].attrs["cache_hit_rate"], 0.75);
        let failures = d.failures_json();
        assert_eq!(failures["recent"][0]["kind"], "run");
        assert_eq!(failures["recent"][0]["trace"], run.trace);
        // Tool errors stay in their spans; they are not failures of the daemon.
        assert_eq!(failures["total"], 1);
        let trace = d.trace(run.trace);
        assert_eq!(trace["spans"].as_array().unwrap().len(), 4);
        assert_eq!(trace["spans"][0]["kind"], "run");
    }

    #[test]
    fn a_retried_run_stays_one_run_and_recovers() {
        let d = Diagnostics::default();
        for event in [
            json!({"type":"agent_start"}),
            json!({"type":"message_end","message":{"role":"assistant","stopReason":"error","errorMessage":"Overloaded"}}),
            json!({"type":"agent_end","willRetry":true}),
            json!({"type":"auto_retry_start"}),
            json!({"type":"agent_start"}),
            json!({"type":"message_end","message":{"role":"assistant","stopReason":"stop"}}),
            json!({"type":"agent_settled"}),
        ] {
            d.pi_event("s", "owl", "x", &event);
        }
        let spans = Vec::from(d.spans.lock().unwrap().clone());
        let runs = spans.iter().filter(|s| s.kind == "run").collect::<Vec<_>>();
        assert_eq!(runs.len(), 1);
        assert!(runs[0].error.is_none());
        assert_eq!(runs[0].attrs["model_calls"], 2);
        assert!(spans.iter().all(|s| s.trace == runs[0].trace));
        assert_eq!(d.failures_json()["total"], 0);
    }

    #[test]
    fn an_interrupted_run_is_not_a_failure() {
        let d = Diagnostics::default();
        d.pi_event("s", "owl", "x", &json!({"type":"agent_start"}));
        d.pi_event(
            "s",
            "owl",
            "x",
            &json!({"type":"message_end","message":{"role":"assistant","stopReason":"aborted"}}),
        );
        d.pi_event("s", "owl", "x", &json!({"type":"agent_settled"}));
        let spans = Vec::from(d.spans.lock().unwrap().clone());
        assert_eq!(spans.last().unwrap().attrs["interrupted"], true);
        assert!(spans.last().unwrap().error.is_none());
        assert_eq!(d.failures_json()["total"], 0);
    }

    #[test]
    fn rpc_errors_are_failures_and_polling_is_quiet() {
        let d = Diagnostics::default();
        d.rpc("gateway.ping", now_ms(), &Ok(json!({})));
        d.rpc("hexbot.bots.get", now_ms(), &Ok(json!({})));
        d.rpc(
            "hexbot.bots.get",
            now_ms(),
            &Err(crate::Error::new(4205, "bot owl not found")),
        );
        d.rpc(
            "hexbot.bots.get",
            now_ms(),
            &Err(crate::Error::new(4205, "bot fox not found")),
        );
        let spans = spans_json(
            &d.spans.lock().unwrap().iter().cloned().collect::<Vec<_>>(),
            None,
        );
        assert_eq!(spans["names"].as_array().unwrap().len(), 1);
        assert_eq!(spans["names"][0]["count"], 3);
        assert_eq!(spans["names"][0]["errors"], 2);
        let failures = d.failures_json();
        assert_eq!(failures["recent"].as_array().unwrap().len(), 2);
        // Two bots, two patterns: names are not numbers or ids.
        assert_eq!(failures["common"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn a_dead_process_ends_its_run_with_one_failure() {
        let d = Diagnostics::default();
        d.pi_event("s", "owl", "x", &json!({"type":"agent_start"}));
        d.process_exit("s", "owl", "Pi exited");
        let failures = d.failures_json();
        assert_eq!(failures["total"], 1);
        assert_eq!(failures["recent"][0]["kind"], "process");
        let spans = Vec::from(d.spans.lock().unwrap().clone());
        assert_eq!(spans.last().unwrap().error.as_deref(), Some("Pi exited"));
        assert!(d.runs.lock().unwrap().is_empty());
    }

    #[test]
    fn statements_beyond_the_limit_count_together() {
        let s = Sqlite::default();
        for i in 0..STATEMENTS + 5 {
            s.statement(format!("SELECT {i}").as_bytes(), 10);
        }
        s.statement(b"SELECT 0", 30);
        let map = s.statements.lock().unwrap();
        assert_eq!(map.len(), STATEMENTS + 1);
        assert_eq!(map[OTHER_STATEMENTS.as_bytes()].count, 5);
        assert_eq!(map[b"SELECT 0".as_slice()].max_ns, 30);
    }

    #[test]
    fn database_connections_report_statements_and_cache_use() {
        let home = tempfile::tempdir().unwrap();
        let s = &get().sqlite;
        let statements = || {
            s.statements
                .lock()
                .unwrap()
                .values()
                .map(|stat| stat.count)
                .sum::<u64>()
        };
        let (looked_up, counted) = (
            s.hits.load(Ordering::Relaxed) + s.misses.load(Ordering::Relaxed),
            statements(),
        );
        {
            let conn = crate::db::open(home.path()).unwrap();
            conn.execute_batch("CREATE TABLE diag_probe(x); INSERT INTO diag_probe VALUES(1);")
                .unwrap();
            let _: i64 = conn
                .query_row("SELECT COUNT(*) FROM diag_probe", [], |r| r.get(0))
                .unwrap();
        }
        // Other tests open connections too, so only growth is certain.
        assert!(s.hits.load(Ordering::Relaxed) + s.misses.load(Ordering::Relaxed) > looked_up);
        assert!(statements() >= counted + 3);
    }

    #[test]
    fn prompt_cache_reads_usage_from_the_runtime_store() {
        let home = tempfile::tempdir().unwrap();
        assert_eq!(prompt_cache(home.path(), "local").unwrap()["calls"], 0);
        crate::runtime_store::open(home.path())
            .unwrap()
            .execute_batch(&format!(
                "INSERT INTO native_usage(session_id,owner_id,bot,model,provider,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,cost,timestamp) VALUES('s','local','owl','m','p',10,5,30,0,0.1,{now}),('s','other','fox','m','p',99,0,0,0,0,{now})",
                now = common::now()
            ))
            .unwrap();
        let cache = prompt_cache(home.path(), "local").unwrap();
        assert_eq!(cache["calls"], 1);
        assert_eq!(cache["hit_rate"], 0.75);
        assert_eq!(cache["by_bot"][0]["name"], "owl");
        // Totals count every bot, past the 30 listed.
        let more = (0..31)
            .map(|i| format!("('s','local','bot{i}','m','p',1,0,0,0,0,{})", common::now()))
            .collect::<Vec<_>>()
            .join(",");
        crate::runtime_store::open(home.path())
            .unwrap()
            .execute_batch(&format!(
                "INSERT INTO native_usage(session_id,owner_id,bot,model,provider,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,cost,timestamp) VALUES{more}"
            ))
            .unwrap();
        let cache = prompt_cache(home.path(), "local").unwrap();
        assert_eq!(cache["by_bot"].as_array().unwrap().len(), 30);
        assert_eq!(cache["calls"], 32);
        assert_eq!(cache["input"], 41);
    }

    #[test]
    fn a_late_settlement_cannot_end_the_next_run() {
        let d = Diagnostics::default();
        for event in [
            json!({"type":"agent_start"}),
            json!({"type":"message_end","message":{"role":"assistant","stopReason":"stop"}}),
            json!({"type":"agent_end","willRetry":false}),
            // The next prompt starts before the first one settles.
            json!({"type":"agent_start"}),
            json!({"type":"agent_settled"}),
            json!({"type":"message_end","message":{"role":"assistant","stopReason":"error","errorMessage":"Overloaded"}}),
            json!({"type":"agent_end","willRetry":false}),
            json!({"type":"agent_settled"}),
        ] {
            d.pi_event("s", "owl", "x", &event);
        }
        let spans = Vec::from(d.spans.lock().unwrap().clone());
        let runs = spans.iter().filter(|s| s.kind == "run").collect::<Vec<_>>();
        assert_eq!(runs.len(), 2);
        assert!(runs[0].error.is_none());
        assert_eq!(runs[1].error.as_deref(), Some("Overloaded"));
        assert_eq!(runs[1].attrs["model_calls"], 1);
        assert_eq!(d.failures_json()["total"], 1);
    }

    #[test]
    fn first_token_waits_for_content_and_open_tools_close_with_the_run() {
        let d = Diagnostics::default();
        for event in [
            json!({"type":"agent_start"}),
            json!({"type":"message_start","message":{"role":"assistant"}}),
            json!({"type":"message_update","assistantMessageEvent":{"type":"start"}}),
        ] {
            d.pi_event("s", "owl", "x", &event);
        }
        assert!(d.runs.lock().unwrap()["s"].first_token.is_none());
        for event in [
            json!({"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"hi"}}),
            json!({"type":"message_end","message":{"role":"assistant","stopReason":"toolUse"}}),
            json!({"type":"tool_execution_start","toolCallId":"t1","toolName":"bash"}),
            // Stopped during the tool: Pi settles without its end event.
            json!({"type":"agent_settled"}),
        ] {
            d.pi_event("s", "owl", "x", &event);
        }
        let spans = Vec::from(d.spans.lock().unwrap().clone());
        assert!(spans[0].attrs["first_token_ms"].is_number());
        let tool = spans.iter().find(|s| s.kind == "tool").unwrap();
        assert_eq!(tool.attrs["unfinished"], true);
        assert_eq!(spans.last().unwrap().attrs["tool_calls"], 1);
    }
}
