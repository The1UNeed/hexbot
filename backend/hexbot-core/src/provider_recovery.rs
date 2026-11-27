//! Automatic recovery detection for provider usage-limit and credit-exhaustion
//! incidents. Only runs while at least one bot has an open quota/billing incident.

use super::*;
use crate::{events::EventHub, settings};
use reqwest::header::HeaderMap;
use std::collections::{BTreeMap, HashSet};
use tokio::task::JoinSet;

const FREE_AUTO_INTERVAL_SECS: f64 = 300.0;
const FREE_INITIAL_DELAY_SECS: f64 = 60.0;
const FREE_DEMAND_COOLDOWN_SECS: f64 = 30.0;
const FREE_MAX_BACKOFF_SECS: f64 = 900.0;

const PROBE_AUTO_INTERVAL_SECS: f64 = 600.0;
const PROBE_DEMAND_COOLDOWN_SECS: f64 = 60.0;
const PROBE_MAX_BACKOFF_SECS: f64 = 3600.0;
const PROBE_AUTO_MAX_AGE_SECS: f64 = 48.0 * 3600.0;

const FLAP_WINDOW_SECS: f64 = 600.0;
const PROBE_TIMEOUT_SECS: u64 = 10;
const ERROR_BODY_LIMIT: usize = 64 * 1024;

/// `(home, canonical_provider, credential_scope, model_scope)`.
/// Provider-wide free checks use `model_scope = None`; paid inference probes use
/// `model_scope = Some(model_id)` so per-model limits stay isolated.
type WatchKey = (PathBuf, String, Option<String>, Option<String>);

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum RecoveryStatus {
    Recovered,
    StillLimited { retry_at: Option<f64> },
    Unknown,
}

#[derive(Clone, Debug, Default)]
struct WatchState {
    in_flight: bool,
    last_checked: f64,
    next_auto_check: f64,
    retry_at: Option<f64>,
    consecutive_failures: u32,
    limited_checks: u32,
    auto_paused: bool,
}

fn hubs() -> &'static Mutex<HashMap<PathBuf, EventHub>> {
    static HUBS: OnceLock<Mutex<HashMap<PathBuf, EventHub>>> = OnceLock::new();
    HUBS.get_or_init(Default::default)
}

fn states() -> &'static Mutex<HashMap<WatchKey, WatchState>> {
    static STATES: OnceLock<Mutex<HashMap<WatchKey, WatchState>>> = OnceLock::new();
    STATES.get_or_init(Default::default)
}

fn auto_resolved_times() -> &'static Mutex<HashMap<WatchKey, f64>> {
    static RESOLVED: OnceLock<Mutex<HashMap<WatchKey, f64>>> = OnceLock::new();
    RESOLVED.get_or_init(Default::default)
}

/// Returns `Some(bot)` when `bot`'s profile defines its own credentials or endpoint
/// for `slug` (distinct from the daemon's shared credentials), or `None` when it
/// shares the daemon's credentials.
pub(crate) fn bot_credential_scope(home: &Path, bot: &str, slug: &str) -> Option<String> {
    if bot.is_empty() || slug.is_empty() {
        return None;
    }
    let slug = canonical_provider(slug);
    let profile_dir = home.join("profiles").join(bot);
    if !profile_dir.is_dir() {
        return None;
    }
    let profile_cfg = common::read_config(&profile_dir)
        .ok()
        .unwrap_or_else(|| json!({}));
    if canonical_provider(string(&profile_cfg["model"], "provider")) == slug
        && (profile_cfg["model"]["api_key"]
            .as_str()
            .is_some_and(|k| !k.is_empty())
            || profile_cfg["model"]["base_url"]
                .as_str()
                .is_some_and(|u| !u.is_empty()))
    {
        return Some(bot.to_owned());
    }
    if custom_profiles(&profile_cfg).iter().any(|p| {
        p["name"] == slug
            || p["aliases"]
                .as_array()
                .is_some_and(|a| a.iter().any(|v| v.as_str() == Some(slug.as_str())))
    }) {
        return Some(bot.to_owned());
    }
    if let Ok(state) = oauth(&profile_dir, &slug)
        && (!string(&state, "access_token").is_empty() || state["tokens"].is_object())
    {
        return Some(bot.to_owned());
    }
    if let Some(p) = find_profile(home, Some(&profile_dir), &slug) {
        let profile_key = custom_key(&profile_dir, &p).ok().flatten();
        let root_key = custom_key(home, &p).ok().flatten();
        if profile_key.is_some() && profile_key != root_key {
            return Some(bot.to_owned());
        }
        let env_name = string(&p, "base_url_env_var");
        if !env_name.is_empty() {
            let profile_base = common::env_values(&profile_dir)
                .ok()
                .and_then(|env| env.get(env_name).cloned())
                .filter(|s| !s.is_empty());
            let root_base = common::env_values(home)
                .ok()
                .and_then(|env| env.get(env_name).cloned())
                .filter(|s| !s.is_empty());
            if profile_base.is_some() && profile_base != root_base {
                return Some(bot.to_owned());
            }
        }
    }
    None
}

/// Register the daemon's event hub for background provider recovery checks.
pub fn attach(home: &Path, events: EventHub) {
    hubs()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(home.to_path_buf(), events);
}

/// Remove the daemon's event hub and cached recovery state on shutdown.
pub fn detach(home: &Path) {
    hubs()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(home);
    states()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .retain(|(path, _, _, _), _| path != home);
    auto_resolved_times()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .retain(|(path, _, _, _), _| path != home);
}

/// Broadcast resolved incidents through the daemon's attached hub, if active.
pub(crate) fn notify_resolved(home: &Path, resolved: &[Value]) {
    if resolved.is_empty() {
        return;
    }
    let hub = hubs()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(home)
        .cloned();
    if let Some(events) = hub {
        settings::emit_resolved_incidents(&events, resolved);
    }
}

/// Schedule or update recovery watching when a quota incident lands.
/// Preserves existing cooldowns and future `retry_at` on repeat failures so
/// periodic heartbeats do not reset paid probe backoffs. If the same scope was
/// automatically cleared within `FLAP_WINDOW_SECS`, pauses automatic clearing
/// until a real turn succeeds or credentials change.
pub fn note_quota_incident(home: &Path, provider: &str, scope: Option<&str>, model: Option<&str>) {
    let slug = canonical_provider(provider);
    if slug.is_empty() {
        return;
    }
    let now = common::now();
    let profile_dir = scope.map(|b| home.join("profiles").join(b));
    let free = is_free_check(home, profile_dir.as_deref(), &slug);
    let initial_delay = if free {
        FREE_INITIAL_DELAY_SECS
    } else {
        PROBE_AUTO_INTERVAL_SECS
    };
    let model_key = (!free)
        .then(|| model.filter(|m| !m.is_empty()).map(str::to_owned))
        .flatten();
    let key: WatchKey = (
        home.to_path_buf(),
        slug.clone(),
        scope.map(str::to_owned),
        model_key.clone(),
    );
    let wide_key: WatchKey = (home.to_path_buf(), slug, scope.map(str::to_owned), None);
    let recently_auto_resolved = {
        let resolved = auto_resolved_times()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        resolved
            .get(&key)
            .or_else(|| resolved.get(&wide_key))
            .is_some_and(|&ts| now - ts < FLAP_WINDOW_SECS)
    };
    let mut map = states().lock().unwrap_or_else(|e| e.into_inner());
    let existed = map.contains_key(&key);
    let entry = map.entry(key).or_default();
    if !existed {
        entry.consecutive_failures = 0;
        entry.limited_checks = 0;
        entry.retry_at = None;
        entry.last_checked = 0.0;
        entry.next_auto_check = now + initial_delay;
    } else {
        // Keep last_checked and any future retry_at so repeated failures don't bypass cooldowns.
        if entry.retry_at.is_some_and(|ts| ts <= now) {
            entry.retry_at = None;
        }
        let earliest = entry.retry_at.unwrap_or(now + initial_delay);
        if entry.next_auto_check == 0.0 {
            entry.next_auto_check = earliest;
        } else if let Some(retry) = entry.retry_at {
            entry.next_auto_check = entry.next_auto_check.max(retry);
        }
    }
    if recently_auto_resolved {
        entry.auto_paused = true;
    }
}

/// Clear cached recovery scheduling and flap-guard state once a real turn
/// succeeds or credentials change for `(provider, scope, model)`.
pub fn note_provider_recovered(
    home: &Path,
    provider: &str,
    scope: Option<&str>,
    model: Option<&str>,
) {
    let slug = canonical_provider(provider);
    if slug.is_empty() {
        return;
    }
    let scope_owned = scope.map(str::to_owned);
    let model_owned = model.filter(|m| !m.is_empty()).map(str::to_owned);
    let matches_key = |(path, s, sc, m): &WatchKey| -> bool {
        path == home
            && *s == slug
            && *sc == scope_owned
            && match &model_owned {
                // Provider-wide recovery (e.g. credential update) clears every model entry.
                None => true,
                // Model-specific turn success clears that model's entry and the provider-wide flap record.
                Some(target) => m.is_none() || m.as_deref() == Some(target.as_str()),
            }
    };
    states()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .retain(|key, _| !matches_key(key));
    auto_resolved_times()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .retain(|key, _| !matches_key(key));
}

/// Resolve open shared-scope quota incidents when daemon credentials are saved
/// or refreshed by sign-in.
pub(crate) fn on_credentials_updated(home: &Path, provider: &str) {
    let slug = canonical_provider(provider);
    if slug.is_empty() {
        return;
    }
    note_provider_recovered(home, &slug, None, None);
    if let Ok(resolved) =
        settings::resolve_provider_quota_incidents(home, &slug, None, None, None, None)
    {
        notify_resolved(home, &resolved);
    }
}

/// Called every minute from the scheduler tick. Spawns a single non-overlapping
/// background check only when at least one visible open quota incident exists.
pub fn watch(home: &Path) {
    let open = match settings::open_quota_incidents(home) {
        Ok(rows) => rows,
        Err(_) => return,
    };
    if open.is_empty() {
        states()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .retain(|(path, _, _, _), state| path != home || state.in_flight);
        return;
    }
    let Some(events) = hubs()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(home)
        .cloned()
    else {
        return;
    };
    static WATCHING: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();
    let watching = WATCHING.get_or_init(Default::default);
    if !watching
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(home.to_path_buf())
    {
        return;
    }
    struct Done(&'static Mutex<HashSet<PathBuf>>, PathBuf);
    impl Drop for Done {
        fn drop(&mut self) {
            self.0
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&self.1);
        }
    }
    let done = Done(watching, home.to_path_buf());
    let home = home.to_path_buf();
    tokio::spawn(async move {
        let _done = done;
        let _ = check_recovery(&home, &events, false).await;
    });
}

#[derive(Default)]
struct IncidentGroup {
    bots: Vec<String>,
    newest_incident_at: f64,
    only_credit_incidents: bool,
}

/// Check providers that currently have open quota/billing incidents and resolve
/// those incidents automatically once a provider is usable again.
pub async fn check_recovery(home: &Path, events: &EventHub, on_demand: bool) -> Result<Value> {
    check_recovery_at(home, events, on_demand, common::now()).await
}

/// Same as `check_recovery`, parameterized by `now` for deterministic scheduling tests.
pub async fn check_recovery_at(
    home: &Path,
    events: &EventHub,
    on_demand: bool,
    now: f64,
) -> Result<Value> {
    let incidents = settings::open_quota_incidents(home)?;
    let mut groups: BTreeMap<(String, Option<String>, Option<String>), IncidentGroup> =
        BTreeMap::new();
    for row in incidents {
        let Some(provider) = row["effective_provider"]
            .as_str()
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
        else {
            continue;
        };
        let bot = row["bot"].as_str().unwrap_or("").to_owned();
        let scope = bot_credential_scope(home, &bot, &provider);
        let profile_dir = scope.as_deref().map(|b| home.join("profiles").join(b));
        let free = is_free_check(home, profile_dir.as_deref(), &provider);
        // Paid minimal-inference probes are scoped by model so per-model limits stay isolated.
        let model_key = if free {
            None
        } else {
            incident_recovery_model(home, &row, &provider)
        };
        let created_at = row["created_at"].as_f64().unwrap_or(0.0);
        let credit_only = settings::is_credit_error(row["text"].as_str().unwrap_or(""));
        let entry = groups
            .entry((provider, scope, model_key))
            .or_insert_with(|| IncidentGroup {
                bots: vec![],
                newest_incident_at: 0.0,
                only_credit_incidents: true,
            });
        if !bot.is_empty() && !entry.bots.iter().any(|b| b == &bot) {
            entry.bots.push(bot);
        }
        if created_at > entry.newest_incident_at {
            entry.newest_incident_at = created_at;
        }
        if !credit_only {
            entry.only_credit_incidents = false;
        }
    }

    // Drop cached states for groups that no longer have open quota incidents,
    // while preserving any entry currently mid-probe in a concurrent caller.
    {
        let mut map = states().lock().unwrap_or_else(|e| e.into_inner());
        map.retain(|(path, slug, scope, model), state| {
            path != home
                || state.in_flight
                || groups.contains_key(&(slug.clone(), scope.clone(), model.clone()))
        });
    }

    if groups.is_empty() {
        return Ok(json!({"checked": [], "resolved": 0}));
    }

    let mut tasks: JoinSet<Result<(String, usize)>> = JoinSet::new();
    for ((provider, scope, model_key), group) in groups {
        if !can_probe(&provider, group.only_credit_incidents) {
            continue;
        }
        let profile_dir = scope.as_deref().map(|b| home.join("profiles").join(b));
        let is_connected = connected(home, profile_dir.as_deref(), &provider).unwrap_or(false);
        if !is_connected {
            continue;
        }

        let free = is_free_check(home, profile_dir.as_deref(), &provider);
        let key: WatchKey = (
            home.to_path_buf(),
            provider.clone(),
            scope.clone(),
            model_key.clone(),
        );
        let allowed = {
            let mut map = states().lock().unwrap_or_else(|e| e.into_inner());
            let state = map.entry(key.clone()).or_default();
            if state.in_flight
                || !should_check(state, free, on_demand, now, group.newest_incident_at)
            {
                false
            } else {
                state.in_flight = true;
                true
            }
        };
        if !allowed {
            continue;
        }

        let home_owned = home.to_path_buf();
        let events_owned = events.clone();
        let bots = group.bots;
        let only_credit = group.only_credit_incidents;
        tasks.spawn(async move {
            check_group(
                home_owned,
                events_owned,
                provider,
                scope,
                model_key,
                profile_dir,
                bots,
                only_credit,
                free,
                now,
            )
            .await
        });
    }

    let mut checked = Vec::new();
    let mut resolved_total = 0usize;
    while let Some(joined) = tasks.join_next().await {
        if let Ok(Ok((provider, resolved))) = joined {
            if !checked.contains(&provider) {
                checked.push(provider);
            }
            resolved_total += resolved;
        }
    }
    checked.sort();

    Ok(json!({
        "checked": checked,
        "resolved": resolved_total,
    }))
}

/// True when `slug` has an active recovery check for the group's incident type.
/// Local/Copilot/SDK providers are never probed, and balance-only endpoints
/// (OpenRouter, DeepSeek, Moonshot) are only checked for credit/billing errors
/// so non-credit 429s neither waste polls nor falsely clear.
fn can_probe(slug: &str, only_credit_incidents: bool) -> bool {
    match slug {
        "custom" | "ollama" | "lmstudio" | "copilot" | "copilot-acp" | "bedrock" | "vertex"
        | "azure-foundry" => false,
        "openrouter" | "deepseek" | "kimi-coding" | "kimi-coding-cn" => only_credit_incidents,
        _ => true,
    }
}

#[allow(clippy::too_many_arguments)]
async fn check_group(
    home: PathBuf,
    events: EventHub,
    provider: String,
    scope: Option<String>,
    model_key: Option<String>,
    profile_dir: Option<PathBuf>,
    bots: Vec<String>,
    only_credit_incidents: bool,
    free: bool,
    now: f64,
) -> Result<(String, usize)> {
    let key: WatchKey = (
        home.clone(),
        provider.clone(),
        scope.clone(),
        model_key.clone(),
    );
    struct FlightGuard(WatchKey);
    impl Drop for FlightGuard {
        fn drop(&mut self) {
            let mut map = states().lock().unwrap_or_else(|e| e.into_inner());
            if let Some(state) = map.get_mut(&self.0) {
                state.in_flight = false;
            }
        }
    }
    let _flight = FlightGuard(key.clone());

    // Use real wall-clock time as the incident cutoff so newly arriving
    // failures during the HTTP check are never swept away.
    let started_at = common::now();
    let outcome = probe_provider(
        &home,
        profile_dir.as_deref(),
        &provider,
        &bots,
        model_key.as_deref(),
        only_credit_incidents,
        now,
    )
    .await;

    let mut resolved_count = 0usize;
    match outcome {
        RecoveryStatus::Recovered => {
            let resolved = settings::resolve_provider_quota_incidents(
                &home,
                &provider,
                Some(started_at),
                scope.as_deref(),
                model_key.as_deref(),
                None,
            )?;
            resolved_count = resolved.len();
            if !resolved.is_empty() {
                auto_resolved_times()
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .insert(key.clone(), common::now());
                settings::emit_resolved_incidents(&events, &resolved);
            }
            // Keep watching only if a brand-new incident landed while we checked.
            let still_open = settings::open_quota_incidents(&home)
                .unwrap_or_default()
                .iter()
                .any(|row| {
                    let row_bot = row["bot"].as_str().unwrap_or("");
                    row["effective_provider"].as_str() == Some(provider.as_str())
                        && bot_credential_scope(&home, row_bot, &provider) == scope
                        && match &model_key {
                            None => true,
                            Some(m) => {
                                incident_recovery_model(&home, row, &provider).as_deref()
                                    == Some(m.as_str())
                            }
                        }
                });
            let mut map = states().lock().unwrap_or_else(|e| e.into_inner());
            if !still_open {
                map.remove(&key);
            } else if let Some(state) = map.get_mut(&key) {
                state.last_checked = now;
                state.retry_at = None;
                state.consecutive_failures = 0;
                state.limited_checks = 0;
                state.next_auto_check = now
                    + if free {
                        FREE_AUTO_INTERVAL_SECS
                    } else {
                        PROBE_AUTO_INTERVAL_SECS
                    };
            }
        }
        RecoveryStatus::StillLimited { retry_at } => {
            let mut map = states().lock().unwrap_or_else(|e| e.into_inner());
            // Use get_mut so detach() during an in-flight check does not leak state back in.
            if let Some(state) = map.get_mut(&key) {
                state.last_checked = now;
                state.consecutive_failures = 0;
                state.limited_checks = state.limited_checks.saturating_add(1);
                state.retry_at = retry_at.filter(|ts| *ts > now);
                state.next_auto_check =
                    next_limited_check(free, now, state.retry_at, state.limited_checks);
            }
        }
        RecoveryStatus::Unknown => {
            let mut map = states().lock().unwrap_or_else(|e| e.into_inner());
            if let Some(state) = map.get_mut(&key) {
                state.last_checked = now;
                // Clear stale retry_at so exponential backoff governs retries after transient errors.
                state.retry_at = None;
                state.consecutive_failures = state.consecutive_failures.saturating_add(1);
                state.next_auto_check = next_error_check(free, now, state.consecutive_failures);
            }
        }
    }

    Ok((provider, resolved_count))
}

fn should_check(
    state: &WatchState,
    free: bool,
    on_demand: bool,
    now: f64,
    newest_incident_at: f64,
) -> bool {
    if state.auto_paused {
        return false;
    }
    let cooldown = if free {
        FREE_DEMAND_COOLDOWN_SECS
    } else {
        PROBE_DEMAND_COOLDOWN_SECS
    };
    if on_demand {
        if !free && state.retry_at.is_some_and(|ts| now < ts) {
            return false;
        }
        return state.last_checked == 0.0 || now >= state.last_checked + cooldown;
    }
    if !free && newest_incident_at > 0.0 && now - newest_incident_at > PROBE_AUTO_MAX_AGE_SECS {
        return false;
    }
    if let Some(retry_at) = state.retry_at
        && now >= retry_at
        && now >= state.last_checked + cooldown
    {
        return true;
    }
    state.next_auto_check == 0.0 || now >= state.next_auto_check
}

fn next_limited_check(free: bool, now: f64, retry_at: Option<f64>, limited_checks: u32) -> f64 {
    if free {
        let regular = now + FREE_AUTO_INTERVAL_SECS;
        match retry_at {
            // Check right when the reset window arrives, or every 5 min in case
            // the user purchased/redeemed an early reset or added extra credits.
            Some(ts) if ts > now => ts.min(regular).max(now + FREE_DEMAND_COOLDOWN_SECS),
            _ => regular,
        }
    } else {
        let shift = limited_checks.saturating_sub(1).min(3);
        let regular =
            now + (PROBE_AUTO_INTERVAL_SECS * f64::from(1u32 << shift)).min(PROBE_MAX_BACKOFF_SECS);
        match retry_at {
            Some(ts) if ts > now => ts.max(now + PROBE_DEMAND_COOLDOWN_SECS),
            _ => regular,
        }
    }
}

fn next_error_check(free: bool, now: f64, failures: u32) -> f64 {
    let shift = failures.saturating_sub(1).min(3);
    if free {
        now + (FREE_AUTO_INTERVAL_SECS * f64::from(1u32 << shift)).min(FREE_MAX_BACKOFF_SECS)
    } else {
        now + (PROBE_AUTO_INTERVAL_SECS * f64::from(1u32 << shift)).min(PROBE_MAX_BACKOFF_SECS)
    }
}

fn is_free_check(home: &Path, profile_home: Option<&Path>, slug: &str) -> bool {
    match slug {
        "openai-codex" | "openrouter" | "deepseek" | "kimi-coding" | "kimi-coding-cn" => true,
        "anthropic" => resolve_api_key(home, profile_home, "anthropic").is_none(),
        _ => false,
    }
}

fn probe_client() -> Result<reqwest::Client> {
    crate::http::client(PROBE_TIMEOUT_SECS, 0)
        .map_err(|_| Error::new(5200, "HTTP client unavailable"))
}

fn find_profile(home: &Path, profile_home: Option<&Path>, slug: &str) -> Option<Value> {
    if let Some(p) = profiles().iter().find(|p| p["name"] == slug) {
        return Some(p.clone());
    }
    let mut cfg = common::read_config(home).ok()?;
    if let Some(dir) = profile_home
        && let Ok(profile_cfg) = common::read_config(dir)
    {
        for key in ["providers", "custom_providers"] {
            if profile_cfg.get(key).is_some() {
                cfg[key] = profile_cfg[key].clone();
            }
        }
    }
    custom_profiles(&cfg).into_iter().find(|p| {
        p["name"] == slug
            || p["aliases"]
                .as_array()
                .is_some_and(|a| a.iter().any(|v| v == slug))
    })
}

fn resolve_api_key(home: &Path, profile_home: Option<&Path>, slug: &str) -> Option<String> {
    if read_json(&home.join("providers-disabled.json"))
        .ok()
        .is_some_and(|d| d[slug] == true)
    {
        return None;
    }
    let p = find_profile(home, profile_home, slug)?;
    let root_cfg = common::read_config(home).ok().unwrap_or_else(|| json!({}));
    let profile_cfg = profile_home
        .and_then(|dir| common::read_config(dir).ok())
        .unwrap_or_else(|| json!({}));
    let inline = [&profile_cfg, &root_cfg].into_iter().find_map(|cfg| {
        if canonical_provider(string(&cfg["model"], "provider")) == slug {
            cfg["model"]["api_key"]
                .as_str()
                .filter(|k| !k.is_empty())
                .map(str::to_owned)
        } else {
            None
        }
    });
    inline
        .or_else(|| profile_home.and_then(|dir| custom_key(dir, &p).ok().flatten()))
        .or_else(|| custom_key(home, &p).ok().flatten())
}

fn provider_base_url(home: &Path, profile_home: Option<&Path>, slug: &str) -> Option<String> {
    let p = find_profile(home, profile_home, slug)?;
    let root_cfg = common::read_config(home).ok().unwrap_or_else(|| json!({}));
    let profile_cfg = profile_home
        .and_then(|dir| common::read_config(dir).ok())
        .unwrap_or_else(|| json!({}));
    let env_name = string(&p, "base_url_env_var");
    let configured = [&profile_cfg, &root_cfg]
        .into_iter()
        .find_map(|cfg| {
            (canonical_provider(string(&cfg["model"], "provider")) == slug)
                .then(|| cfg["model"]["base_url"].as_str())
                .flatten()
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
        })
        .or_else(|| {
            (!env_name.is_empty())
                .then(|| {
                    profile_home
                        .and_then(|dir| common::env_values(dir).ok()?.get(env_name).cloned())
                        .or_else(|| common::env_values(home).ok()?.get(env_name).cloned())
                        .or_else(|| std::env::var(env_name).ok())
                })
                .flatten()
                .filter(|s| !s.is_empty())
        });
    let base = configured.or_else(|| {
        let s = string(&p, "base_url");
        (!s.is_empty()).then(|| s.to_owned())
    })?;
    let trimmed = base.trim().trim_end_matches('/').to_owned();
    let parsed = url::Url::parse(&trimmed).ok()?;
    let valid = matches!(parsed.scheme(), "https" | "http") && parsed.host_str().is_some();
    valid.then_some(trimmed)
}

fn validated_override_url(url: &str) -> Option<String> {
    let trimmed = url.trim().trim_end_matches('/');
    let parsed = url::Url::parse(trimmed).ok()?;
    let allowed = parsed.scheme() == "https"
        || (parsed.scheme() == "http"
            && matches!(parsed.host_str(), Some("127.0.0.1" | "localhost" | "[::1]")));
    allowed.then(|| trimmed.to_owned())
}

/// Single source of truth for the model associated with a quota incident row.
/// Prefers the model recorded directly on the incident (accurate for fallback
/// models too), falling back to `probe_model` for legacy rows without one.
pub(crate) fn incident_recovery_model(home: &Path, row: &Value, slug: &str) -> Option<String> {
    if let Some(model) = row["model"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        return Some(model.to_owned());
    }
    let bots: Vec<String> = row["bot"]
        .as_str()
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .into_iter()
        .collect();
    probe_model(home, &bots, slug)
}

fn probe_model(home: &Path, bots: &[String], slug: &str) -> Option<String> {
    for bot in bots {
        if let Ok(model) = crate::catalog::section_model(home, bot)
            && canonical_provider(model["provider"].as_str().unwrap_or("")) == slug
            && let Some(id) = model["model"].as_str().filter(|s| !s.is_empty())
        {
            return Some(id.to_owned());
        }
    }
    let root = common::read_config(home).ok().unwrap_or_else(|| json!({}));
    if canonical_provider(string(&root["model"], "provider")) == slug
        && let Some(id) = root["model"]["default"].as_str().filter(|s| !s.is_empty())
    {
        return Some(id.to_owned());
    }
    find_profile(
        home,
        bots.first()
            .map(|b| home.join("profiles").join(b))
            .as_deref(),
        slug,
    )
    .and_then(|p| {
        p["models"]
            .as_array()
            .and_then(|arr| arr.first())
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
    })
}

async fn probe_provider(
    home: &Path,
    profile_home: Option<&Path>,
    slug: &str,
    bots: &[String],
    model_override: Option<&str>,
    only_credit_incidents: bool,
    now: f64,
) -> RecoveryStatus {
    match slug {
        "openai-codex" => check_codex_usage(home, profile_home, now).await,
        "openrouter" => check_openrouter_credits(home, profile_home, only_credit_incidents).await,
        "deepseek" => check_deepseek_balance(home, profile_home, only_credit_incidents).await,
        "kimi-coding" | "kimi-coding-cn" => {
            check_moonshot_balance(home, profile_home, slug, only_credit_incidents).await
        }
        "anthropic" => check_anthropic(home, profile_home, bots, model_override, now).await,
        "custom" | "ollama" | "lmstudio" | "copilot" | "copilot-acp" | "bedrock" | "vertex"
        | "azure-foundry" => RecoveryStatus::Unknown,
        _ => {
            check_minimal_inference_probe(home, profile_home, slug, bots, model_override, now).await
        }
    }
}

async fn check_codex_usage(home: &Path, profile_home: Option<&Path>, now: f64) -> RecoveryStatus {
    let cfg = common::read_config(home).ok().unwrap_or_else(|| json!({}));
    let url = cfg["provider_auth"]["openai-codex"]["usage_url"]
        .as_str()
        .and_then(validated_override_url)
        .or_else(|| {
            let base = provider_base_url(home, profile_home, "openai-codex")?;
            let derived = if let Some(prefix) = base.strip_suffix("/codex") {
                format!("{prefix}/wham/usage")
            } else {
                let parsed = url::Url::parse(&base).ok()?;
                format!(
                    "{}/backend-api/wham/usage",
                    parsed.origin().ascii_serialization()
                )
            };
            validated_override_url(&derived)
        });
    let Some(url) = url else {
        return RecoveryStatus::Unknown;
    };
    let auth_home = profile_home.unwrap_or(home);
    let Ok(auth) = credential_headers(home, auth_home, "openai-codex").await else {
        return RecoveryStatus::Unknown;
    };
    let bearer = string(&auth["headers"], "authorization");
    if bearer.is_empty() {
        return RecoveryStatus::Unknown;
    }
    let Ok(http) = probe_client() else {
        return RecoveryStatus::Unknown;
    };
    let mut req = http.get(url).header("authorization", bearer);
    if let Some(account) = bearer
        .strip_prefix("Bearer ")
        .and_then(jwt_claims)
        .and_then(|claims| {
            claims["https://api.openai.com/auth"]["chatgpt_account_id"]
                .as_str()
                .map(str::to_owned)
        })
    {
        req = req.header("chatgpt-account-id", account);
    }
    let Ok(response) = req.send().await else {
        return RecoveryStatus::Unknown;
    };
    if !response.status().is_success() {
        return RecoveryStatus::Unknown;
    }
    let Ok(data) = limited_json(response).await else {
        return RecoveryStatus::Unknown;
    };
    parse_codex_usage(&data, now)
}

pub(crate) fn parse_codex_usage(data: &Value, now: f64) -> RecoveryStatus {
    let rl = &data["rate_limit"];
    if !rl.is_object() {
        return RecoveryStatus::Unknown;
    }
    let allowed = rl["allowed"].as_bool();
    let limit_reached = rl["limit_reached"].as_bool();
    let credits = &data["credits"];
    let credits_available = credits["unlimited"] == true
        || (credits["has_credits"] == true && parse_balance(&credits["balance"]) > 0.0);

    if allowed == Some(false) {
        return RecoveryStatus::StillLimited {
            retry_at: codex_reset_at(rl, now),
        };
    }
    if limit_reached == Some(true) && !credits_available {
        return RecoveryStatus::StillLimited {
            retry_at: codex_reset_at(rl, now),
        };
    }
    if allowed == Some(true) || limit_reached == Some(false) {
        return RecoveryStatus::Recovered;
    }
    RecoveryStatus::Unknown
}

fn parse_balance(value: &Value) -> f64 {
    value
        .as_f64()
        .or_else(|| value.as_str().and_then(|s| s.trim().parse::<f64>().ok()))
        .unwrap_or(0.0)
}

fn window_reset_at(window: &Value, now: f64) -> Option<f64> {
    if !window.is_object() {
        return None;
    }
    window["reset_at"]
        .as_f64()
        .or_else(|| {
            window["reset_after_seconds"]
                .as_f64()
                .filter(|s| *s > 0.0)
                .map(|s| now + s)
        })
        .filter(|ts| *ts > now)
}

fn codex_reset_at(rl: &Value, now: f64) -> Option<f64> {
    let primary = &rl["primary_window"];
    let secondary = &rl["secondary_window"];
    let primary_full = primary["used_percent"].as_f64().is_some_and(|p| p >= 100.0);
    let secondary_full = secondary["used_percent"]
        .as_f64()
        .is_some_and(|p| p >= 100.0);
    let p_reset = window_reset_at(primary, now);
    let s_reset = window_reset_at(secondary, now);
    match (primary_full, secondary_full) {
        (true, true) => match (p_reset, s_reset) {
            (Some(a), Some(b)) => Some(a.max(b)),
            (a, b) => a.or(b),
        },
        (false, true) => s_reset.or(p_reset),
        _ => p_reset.or(s_reset),
    }
}

async fn check_openrouter_credits(
    home: &Path,
    profile_home: Option<&Path>,
    only_credit_incidents: bool,
) -> RecoveryStatus {
    if !only_credit_incidents {
        return RecoveryStatus::Unknown;
    }
    let Some(base) = provider_base_url(home, profile_home, "openrouter") else {
        return RecoveryStatus::Unknown;
    };
    let Some(key) = resolve_api_key(home, profile_home, "openrouter") else {
        return RecoveryStatus::Unknown;
    };
    let Ok(http) = probe_client() else {
        return RecoveryStatus::Unknown;
    };

    let mut key_limit_remaining: Option<f64> = None;
    if let Ok(resp) = http
        .get(format!("{base}/key"))
        .bearer_auth(&key)
        .send()
        .await
    {
        if resp.status().as_u16() == 402 {
            return RecoveryStatus::StillLimited { retry_at: None };
        }
        if resp.status().is_success()
            && let Ok(data) = limited_json(resp).await
        {
            if let Some(remaining) = data["data"]["limit_remaining"].as_f64() {
                if remaining <= 0.0 {
                    return RecoveryStatus::StillLimited { retry_at: None };
                }
                key_limit_remaining = Some(remaining);
            }
        } else {
            return RecoveryStatus::Unknown;
        }
    } else {
        return RecoveryStatus::Unknown;
    }

    if let Ok(resp) = http
        .get(format!("{base}/credits"))
        .bearer_auth(&key)
        .send()
        .await
        && resp.status().is_success()
        && let Ok(data) = limited_json(resp).await
        && let (Some(total), Some(usage)) = (
            data["data"]["total_credits"].as_f64(),
            data["data"]["total_usage"].as_f64(),
        )
    {
        return if total - usage > 0.0 {
            RecoveryStatus::Recovered
        } else {
            RecoveryStatus::StillLimited { retry_at: None }
        };
    }

    if key_limit_remaining.is_some_and(|rem| rem > 0.0) {
        RecoveryStatus::Recovered
    } else {
        RecoveryStatus::Unknown
    }
}

async fn check_deepseek_balance(
    home: &Path,
    profile_home: Option<&Path>,
    only_credit_incidents: bool,
) -> RecoveryStatus {
    if !only_credit_incidents {
        return RecoveryStatus::Unknown;
    }
    let Some(base) = provider_base_url(home, profile_home, "deepseek") else {
        return RecoveryStatus::Unknown;
    };
    let Some(key) = resolve_api_key(home, profile_home, "deepseek") else {
        return RecoveryStatus::Unknown;
    };
    let Ok(http) = probe_client() else {
        return RecoveryStatus::Unknown;
    };
    let root = base.strip_suffix("/v1").unwrap_or(&base);
    let Ok(resp) = http
        .get(format!("{root}/user/balance"))
        .bearer_auth(&key)
        .send()
        .await
    else {
        return RecoveryStatus::Unknown;
    };
    if !resp.status().is_success() {
        return RecoveryStatus::Unknown;
    }
    let Ok(data) = limited_json(resp).await else {
        return RecoveryStatus::Unknown;
    };
    match data["is_available"].as_bool() {
        Some(true) => RecoveryStatus::Recovered,
        Some(false) => RecoveryStatus::StillLimited { retry_at: None },
        None => RecoveryStatus::Unknown,
    }
}

async fn check_moonshot_balance(
    home: &Path,
    profile_home: Option<&Path>,
    slug: &str,
    only_credit_incidents: bool,
) -> RecoveryStatus {
    if !only_credit_incidents {
        return RecoveryStatus::Unknown;
    }
    let Some(base) = provider_base_url(home, profile_home, slug) else {
        return RecoveryStatus::Unknown;
    };
    let Some(key) = resolve_api_key(home, profile_home, slug) else {
        return RecoveryStatus::Unknown;
    };
    let Ok(http) = probe_client() else {
        return RecoveryStatus::Unknown;
    };
    let Ok(resp) = http
        .get(format!("{base}/users/me/balance"))
        .bearer_auth(&key)
        .send()
        .await
    else {
        return RecoveryStatus::Unknown;
    };
    if !resp.status().is_success() {
        return RecoveryStatus::Unknown;
    }
    let Ok(data) = limited_json(resp).await else {
        return RecoveryStatus::Unknown;
    };
    match data["data"]["available_balance"].as_f64() {
        Some(balance) if balance > 0.0 => RecoveryStatus::Recovered,
        Some(_) => RecoveryStatus::StillLimited { retry_at: None },
        None => RecoveryStatus::Unknown,
    }
}

async fn check_anthropic(
    home: &Path,
    profile_home: Option<&Path>,
    bots: &[String],
    model_override: Option<&str>,
    now: f64,
) -> RecoveryStatus {
    let auth_home = profile_home.unwrap_or(home);
    let Ok(auth) = credential_headers(home, auth_home, "anthropic").await else {
        return RecoveryStatus::Unknown;
    };
    let api_key = string(&auth["headers"], "x-api-key");
    let bearer = string(&auth["headers"], "authorization");
    if api_key.is_empty() && !bearer.is_empty() {
        return check_anthropic_oauth_usage(home, profile_home, bearer, now).await;
    }
    if api_key.is_empty() {
        return RecoveryStatus::Unknown;
    }
    let Some(base) = provider_base_url(home, profile_home, "anthropic") else {
        return RecoveryStatus::Unknown;
    };
    let Some(model) = model_override
        .map(str::to_owned)
        .or_else(|| probe_model(home, bots, "anthropic"))
    else {
        return RecoveryStatus::Unknown;
    };
    let Ok(http) = probe_client() else {
        return RecoveryStatus::Unknown;
    };
    let url = if base.ends_with("/v1") {
        format!("{base}/messages")
    } else {
        format!("{base}/v1/messages")
    };
    let Ok(resp) = http
        .post(url)
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .json(&json!({
            "model": model,
            "max_tokens": 1,
            "messages": [{"role": "user", "content": "."}]
        }))
        .send()
        .await
    else {
        return RecoveryStatus::Unknown;
    };
    classify_probe_response(resp, now).await
}

async fn check_anthropic_oauth_usage(
    home: &Path,
    profile_home: Option<&Path>,
    bearer: &str,
    now: f64,
) -> RecoveryStatus {
    let cfg = common::read_config(home).ok().unwrap_or_else(|| json!({}));
    let url = cfg["provider_auth"]["anthropic"]["usage_url"]
        .as_str()
        .and_then(validated_override_url)
        .or_else(|| {
            let base = provider_base_url(home, profile_home, "anthropic")?;
            let root = base.strip_suffix("/v1").unwrap_or(&base);
            validated_override_url(&format!("{root}/api/oauth/usage"))
        });
    let Some(url) = url else {
        return RecoveryStatus::Unknown;
    };
    let Ok(http) = probe_client() else {
        return RecoveryStatus::Unknown;
    };
    let Ok(resp) = http
        .get(url)
        .header("authorization", bearer)
        .header("anthropic-beta", "oauth-2025-04-20")
        .send()
        .await
    else {
        return RecoveryStatus::Unknown;
    };
    if !resp.status().is_success() {
        return RecoveryStatus::Unknown;
    }
    let Ok(data) = limited_json(resp).await else {
        return RecoveryStatus::Unknown;
    };
    parse_anthropic_oauth_usage(&data, now)
}

pub(crate) fn parse_anthropic_oauth_usage(data: &Value, now: f64) -> RecoveryStatus {
    let Some(map) = data.as_object() else {
        return RecoveryStatus::Unknown;
    };
    let mut saw_window = false;
    let mut blocked_reset: Option<f64> = None;
    let mut blocked = false;
    for (key, window) in map {
        if key != "five_hour" && !key.starts_with("seven_day") {
            continue;
        }
        if let Some(utilization) = window["utilization"].as_f64() {
            saw_window = true;
            if utilization >= 100.0 {
                blocked = true;
                if let Some(ts) = window["resets_at"]
                    .as_str()
                    .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                    .map(|dt| dt.timestamp() as f64)
                    .filter(|ts| *ts > now)
                {
                    blocked_reset = Some(blocked_reset.map_or(ts, |prev| prev.max(ts)));
                }
            }
        }
    }
    if !saw_window {
        return RecoveryStatus::Unknown;
    }
    if blocked {
        let extra = &data["extra_usage"];
        if extra["is_enabled"] == true && extra["utilization"].as_f64().is_some_and(|u| u < 100.0) {
            return RecoveryStatus::Recovered;
        }
        return RecoveryStatus::StillLimited {
            retry_at: blocked_reset,
        };
    }
    RecoveryStatus::Recovered
}

async fn check_minimal_inference_probe(
    home: &Path,
    profile_home: Option<&Path>,
    slug: &str,
    bots: &[String],
    model_override: Option<&str>,
    now: f64,
) -> RecoveryStatus {
    let Some(base) = provider_base_url(home, profile_home, slug) else {
        return RecoveryStatus::Unknown;
    };
    let Some(model) = model_override
        .map(str::to_owned)
        .or_else(|| probe_model(home, bots, slug))
    else {
        return RecoveryStatus::Unknown;
    };
    let Ok(http) = probe_client() else {
        return RecoveryStatus::Unknown;
    };
    let api_mode = find_profile(home, profile_home, slug)
        .and_then(|p| p["api_mode"].as_str().map(str::to_owned))
        .unwrap_or_default();
    let is_anthropic_api = matches!(api_mode.as_str(), "anthropic_messages" | "anthropic")
        || matches!(
            slug,
            "minimax"
                | "minimax-cn"
                | "minimax-oauth"
                | "tencent-tokenplan"
                | "commandcode-anthropic"
        );
    let is_responses_api =
        slug == "openai-api" || matches!(api_mode.as_str(), "responses" | "codex_responses");

    // Resolve auth headers: API key first, else OAuth headers for signed-in providers.
    let mut headers: Vec<(String, String)> = Vec::new();
    if let Some(key) = resolve_api_key(home, profile_home, slug) {
        if slug == "gemini" {
            headers.push(("x-goog-api-key".into(), key));
        } else if is_anthropic_api {
            headers.push(("x-api-key".into(), key));
            headers.push(("anthropic-version".into(), "2023-06-01".into()));
        } else {
            headers.push(("authorization".into(), format!("Bearer {key}")));
        }
    } else if matches!(slug, "nous" | "qwen-oauth" | "minimax-oauth" | "xai-oauth") {
        let auth_home = profile_home.unwrap_or(home);
        let Ok(auth) = credential_headers(home, auth_home, slug).await else {
            return RecoveryStatus::Unknown;
        };
        for (name, val) in auth["headers"].as_object().into_iter().flatten() {
            if let Some(val) = val.as_str().filter(|s| !s.is_empty()) {
                headers.push((name.clone(), val.to_owned()));
            }
        }
        if is_anthropic_api {
            headers.push(("anthropic-version".into(), "2023-06-01".into()));
        }
    } else {
        return RecoveryStatus::Unknown;
    }
    if headers.is_empty() {
        return RecoveryStatus::Unknown;
    }

    let (url, body) = if slug == "gemini" {
        let model_id = model.strip_prefix("models/").unwrap_or(&model);
        if model_id.is_empty()
            || model_id.contains(['/', '?', '#', '\\'])
            || model_id.contains("..")
        {
            return RecoveryStatus::Unknown;
        }
        (
            format!("{base}/models/{model_id}:generateContent"),
            json!({
                "contents": [{"parts": [{"text": "."}]}],
                "generationConfig": {"maxOutputTokens": 1}
            }),
        )
    } else if is_anthropic_api {
        (
            if base.ends_with("/v1") {
                format!("{base}/messages")
            } else {
                format!("{base}/v1/messages")
            },
            json!({
                "model": model,
                "max_tokens": 1,
                "messages": [{"role": "user", "content": "."}]
            }),
        )
    } else if is_responses_api {
        (
            format!("{base}/responses"),
            json!({
                "model": model,
                "input": ".",
                "max_output_tokens": 16,
                "store": false
            }),
        )
    } else {
        (
            format!("{base}/chat/completions"),
            json!({
                "model": model,
                "max_tokens": 1,
                "messages": [{"role": "user", "content": "."}]
            }),
        )
    };

    let mut req = http.post(url).json(&body);
    for (name, val) in headers {
        req = req.header(name, val);
    }
    let Ok(resp) = req.send().await else {
        return RecoveryStatus::Unknown;
    };
    classify_probe_response(resp, now).await
}

async fn classify_probe_response(response: reqwest::Response, now: f64) -> RecoveryStatus {
    let status = response.status().as_u16();
    if (200..300).contains(&status) {
        return RecoveryStatus::Recovered;
    }
    let retry_at = parse_retry_after(response.headers(), now);
    if matches!(status, 402 | 429) {
        return RecoveryStatus::StillLimited { retry_at };
    }
    if matches!(status, 400 | 403) {
        let body = read_error_body(response).await;
        if settings::is_quota_error(&body) {
            return RecoveryStatus::StillLimited { retry_at };
        }
    }
    RecoveryStatus::Unknown
}

async fn read_error_body(mut response: reqwest::Response) -> String {
    let mut bytes = Vec::new();
    while let Ok(Some(chunk)) = response.chunk().await {
        let room = ERROR_BODY_LIMIT.saturating_sub(bytes.len());
        if room == 0 {
            break;
        }
        bytes.extend_from_slice(&chunk[..chunk.len().min(room)]);
    }
    String::from_utf8_lossy(&bytes).into_owned()
}

fn parse_retry_after(headers: &HeaderMap, now: f64) -> Option<f64> {
    let raw = headers.get("retry-after")?.to_str().ok()?.trim();
    let target = if let Ok(secs) = raw.parse::<f64>() {
        now + secs
    } else if let Ok(dt) = chrono::DateTime::parse_from_rfc2822(raw) {
        dt.timestamp() as f64
    } else {
        return None;
    };
    if !target.is_finite() || target <= now {
        return None;
    }
    Some(target.clamp(now + 5.0, now + 86_400.0))
}
