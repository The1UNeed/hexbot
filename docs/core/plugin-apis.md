# Core extension APIs used by `hexbot/`

Read at the v0.21.0 fork point.

Paths relative to `/tmp/hermes-agent-research`.

## 1. Plugin system (`hermes_cli/plugins.py`, 7182 lines)

**Discovery (module docstring, lines 1–32).** Four sources, later overrides earlier on name collision:
1. bundled `<repo>/plugins/<name>/` (`get_bundled_plugins_dir()`; `HERMES_BUNDLED_PLUGINS` override; `memory/` and `context_engine/` excluded — own discovery)
2. user `~/.hexbot/plugins/<name>/` (really `$HERMES_HOME/plugins`, so per-profile)
3. project `./.hermes/plugins/<name>/`, opt-in via `HERMES_ENABLE_PROJECT_PLUGINS`
4. pip entry points, group `hermes_agent.plugins` (`ENTRY_POINTS_GROUP`, line 457); capability declarations in `hermes_agent.plugin_capabilities`.

A directory plugin **must** contain `plugin.yaml` + `__init__.py` exposing `register(ctx: PluginContext) -> None`. Manifest fields = `PluginManifest` (line 1094): `name, version, description, author, requires_env, provides_tools, provides_hooks, kind, key, portable, skill_namespace, capabilities, manifest_version, api_version, requires_plugins, python_dependencies, config_schema, license, homepage, tags, emits, listens`. Real manifests are tiny (name/version/description/author/`hooks:`). `kind` ∈ `standalone|backend|exclusive|platform|model-provider`; `exclusive` (memory) is skipped by the general scanner.

**Enablement.** User/project plugins are opt-in: `plugins.enabled` allow-list, `plugins.disabled` deny-list (`_get_enabled_plugins`/`_get_disabled_plugins`, lines 633–676). Bundled `platform`/`backend` kinds auto-load. Per-plugin settings live at `plugins.entries.<plugin_id>.settings.*` — read/write via `ctx.get_config(key, default)` / `ctx.set_config(key, value)` (plugin-relative keys only). Durable JSON state: `ctx.state` (`PluginState`, profile-scoped). `plugins.hook_callback_timeout` (default 30s, max 600) bounds each Python callback.

**PluginContext registration surface** (exact signatures):
```python
register_hook(hook_name: str, callback: Callable) -> PluginRegistration
register_tool(name, toolset, schema: dict, handler, check_fn=None, requires_env=None,
              is_async=False, description="", emoji="", override=False) -> Optional[PluginRegistration]
register_cli_command(name, help, setup_fn, handler_fn=None, description="") -> PluginRegistration
register_command(name, handler, description="", args_hint="", argument_mode=None)   # slash command
register_system_prompt_section(id, content, *, position="after_memory", max_chars=...)
register_skill(name, path: Path, description="", frontmatter=None)
register_middleware(kind: str, callback) ; register_auxiliary_task(key, *, display_name, description, defaults=None)
register_memory_provider(provider) -> None            # see §3
register_context_engine(engine) ; register_context_reference(provider)
register_{image_gen,video_gen,web_search,browser,terminal_environment,tts,transcription,dashboard_auth}_provider(provider)
register_secret_source(source)
register_platform(name, label, adapter_factory, check_fn, validate_config=None,
                  required_env=None, install_hint="", **entry_kwargs)
register_platform_handler(platform, factory) ; register_telegram_handler(factory)
register_slack_action_handler(action_id, callback) ; register_approval_transport(name, present_fn)
register_redaction_patterns(patterns) -> int ; on_unload(cb) ; spawn_task(coro, *, name=None)
emit(event, payload=None) -> int ; subscribe(event, callback) ; has_plugin(id) ; has_capability(cap)
inject_message(content, role="user", *, session_key=None) -> bool
dispatch_tool(tool_name, args, **kwargs) -> str ; call_mcp(server, tool, arguments=None, timeout=30)
```
Properties: `plugin_id`, `state`, `llm` (`agent.plugin_llm.PluginLlm`), `subagent_lifecycle`, `profile_name`, `platform_actions`.

**Hooks (`VALID_HOOKS`, lines 163–390).** Full set: `pre_tool_call, post_tool_call, transform_terminal_output, transform_tool_result, transform_llm_output, pre_llm_call, post_llm_call, on_stream_start, on_stream_delta, on_stream_end, on_interim_message, pre_verify, pre_api_request, post_api_request, api_request_error, transform_api_error_classification, on_session_start, on_session_end, on_session_finalize, on_session_reset, on_skill_lifecycle, subagent_start, subagent_stop, pre_gateway_dispatch, pre_approval_request, post_approval_response, pre_transcription, kanban_task_{claimed,completed,blocked}, on_kanban_{worker_spawned,worker_exited,worker_stale_claim,task_updated,dispatch_tick}, gateway_platform_event, pre_command`.

Fire sites and return semantics:
- **Per LLM call/turn:** `pre_llm_call` (`agent/turn_context.py:1429`; kwargs `session_id, task_id, turn_id, user_message, conversation_history, is_first_turn, model, platform`; returned string is injected as extra user-message context). `pre_api_request` / `post_api_request` / `api_request_error` fire per *API request* (`agent/conversation_loop.py:3459`, `:7362`, `run_agent.py:3346`) with `api_request_id, model, provider, base_url, api_mode, api_call_count`. `transform_llm_output` (`agent/turn_finalizer.py:623`) — first non-empty string replaces the response. `post_llm_call` (`turn_finalizer.py:646`, observer).
- **Per tool call:** `pre_tool_call` via `_dispatch_pre_tool_call_hooks` (`model_tools.py:1454`) — fires exactly once; returning `{"action":"block"|"approve", "message":...}` blocks/escalates, `{"action":"modify","args":{...}}` rewrites args. Public helpers `get_pre_tool_call_directive(...) -> (directive, message)` and `get_pre_tool_call_block_message(...)`. `transform_tool_result` (`model_tools.py:1631`, first string wins), `post_tool_call` (`model_tools.py:1232`, observer; `tool_name, args, result, task_id, session_id, tool_call_id, turn_id, api_request_id, duration_ms, status, error_type, error_message`). Both gated on `has_hook()`.
- **Per gateway message:** `pre_gateway_dispatch` (`gateway/run.py:18341`), kwargs `event: MessageEvent, gateway: GatewayRunner, session_store`; return `{"action":"skip"|"rewrite"|"allow", ...}`.
- **Session:** `on_session_start` (`agent/conversation_loop.py:1146`, new sessions only; `session_id, model, platform`), `on_session_end` (`turn_finalizer.py:844`, fires at end of *every* `run_conversation`; `session_id, task_id, turn_id, completed, failed, interrupted, turn_exit_reason, model, platform`). Also `on_session_finalize`, `on_session_reset`.
- **Subagents:** `subagent_start` (`tools/delegate_tool.py:2234`; `parent_session_id, parent_turn_id, parent_subagent_id, child_session_id, child_subagent_id, child_role, child_goal`), `subagent_stop` (`:3769`; `child_summary, child_status, tool_call_history, duration_ms`).

**CLI / HTTP / WebSocket:** CLI subcommand — **yes**, `register_cli_command` (argparse subparser + `set_defaults(func=...)`). HTTP route — **yes, but not via `ctx`**: ship a `dashboard/manifest.json` with `"api": "plugin_api.py"` exposing a FastAPI `router`; `hermes_cli/web_server.py:19180 _mount_plugin_api_routes()` mounts it at `/api/plugins/<name>/` (bundled + enabled *user* plugins only; project plugins refused). WebSocket endpoints can be declared inside that router (`plugins/kanban/dashboard/plugin_api.py:48`). **No** plugin API for adding a JSON-RPC method to the TUI/daemon WebSocket server — `tui_gateway/server.py:3142 @method(name)` writes a module-level `_methods` dict, only reachable via `tui_gateway/method_ctx.HandlerRegistry.install(server)` from in-tree `methods_*` modules (unverified whether monkeypatching is supported).

## 2. Profiles (`hermes_cli/profiles.py`)

Layout: default profile = `~/.hexbot`; named = `~/.hexbot/profiles/<id>/`. Ids must match `^[a-z0-9][a-z0-9_-]{0,63}$`.

```python
create_profile(name, clone_from=None, clone_all=False, clone_config=False,
               no_alias=False, no_skills=False, description=None) -> Path
delete_profile(name, yes=False) -> Path ; rename_profile(old, new) -> Path
list_profile_names() -> List[str]        # cheap dir scan
list_profiles() -> List[ProfileInfo]     # rich (reads config/metadata)
get_profile_dir(name) -> Path            # the profile's HERMES_HOME
profile_exists(name) -> bool ; normalize_profile_name / validate_profile_name
resolve_profile_env(profile_name) -> str # HERMES_HOME string, used pre-import by the CLI
get_active_profile() / set_active_profile(name) / get_active_profile_name()
read_profile_meta(dir) / write_profile_meta(dir, *, description=, description_auto=, display_name=)
profiles_to_serve(multiplex: bool, profile_allowlist=None) -> List[Tuple[str, Path]]
export_profile / import_profile / backfill_profile_envs / seed_profile_skills
```
Scoping a call to another profile at runtime: `hermes_constants.set_hermes_home_override(str(home))` / `reset_hermes_home_override(token)` (contextvar; propagates via `copy_context()`).

**Minimal new profile.** `create_profile` makes the dir plus `_PROFILE_DIRS` = `memories, sessions, skills, skins, logs, plans, workspace, cron, home`, and with no clone source calls `_seed_model_config` which writes a `config.yaml` containing only the active profile's `model:` block. So the true minimum is: `<profile>/config.yaml` with a `model:` block, plus `<profile>/.env` if the provider needs a key. `--clone` copies `_CLONE_CONFIG_FILES = [config.yaml, .env, SOUL.md]` + `_CLONE_SUBDIR_FILES = [memories/MEMORY.md, memories/USER.md]` + skills.

**Model/provider keys** (`_read_config_model`, line 753; `cli-config.yaml.example`):
```yaml
model:
  default: "anthropic/claude-opus-4.6"   # `model:` also accepted as the key name
  provider: "auto"                        # auto|openrouter|anthropic|nous|lmstudio|custom|…
  base_url: "https://openrouter.ai/api/v1"
  api_key: ""                             # normally left in .env
```

**Multiplexing.** Config key `gateway.multiplex_profiles` (top-level `multiplex_profiles` also accepted; `hermes_cli/gateway.py:6329`). `profiles_to_serve(True, allowlist)` returns default + every valid named profile. Per-request profile choice: `SessionStore._resolve_profile_for_key(source)` (`gateway/session.py:2168`) — prefers `source.profile` (set by the `/p/<profile>/` URL prefix or per-credential adapter), else the active profile; the profile becomes the session-key namespace (`agent:<profile>:…`, `main` == default). Content-based routing is separate: `gateway.profile_routes` (list of `{name, platform, guild_id, chat_id, thread_id, profile}`) resolved by `gateway/profile_routing.match_profile_route(...)`, specificity thread(8) > chat(4) > guild(2), with parent-chain matching for threads.

**Secrets.** Each profile has its own `<home>/.env` (chmod 0600). `load_hermes_dotenv(hermes_home=…)` loads `<home>/.env` with `override=True`, then `<home>/.op.env`, then external secret sources. Under multiplexing, `agent/secret_scope.py` is authoritative: `set_multiplex_active(True)` makes `get_secret(name)` raise `UnscopedSecretError` when no scope is installed; `build_profile_secret_scope(hermes_home)` builds the mapping, `set_secret_scope(mapping)`/`reset_secret_scope(token)` install it per turn. `_GLOBAL_ENV_EXACT` names (HERMES_HOME, PATH, API_SERVER_*) always read `os.environ`.

**Root-install credential reuse.** *Yes for `auth.json` OAuth grants only.* `hermes_cli/auth._global_auth_file_path()` returns `~/.hexbot/auth.json` when the process is in profile mode, and `_load_provider_state_with_source()` falls back to it ("borrowing"); rotations are written back to root (`agent/credential_pool._write_through_provider_state_to_global_root`). `--clone-all` deliberately strips cloned single-use OAuth grants so the clone borrows root instead. **`.env` API keys are NOT inherited** — a named profile only sees its own `.env` (plus shell exports, which are not scrubbed).

## 3. Memory

**On disk** (`tools/memory_tool.py`): `get_memory_dir() = get_hermes_home()/"memories"`; `MEMORY.md` (target `"memory"`) and `USER.md` (target `"user"`) — `MemoryStore._path_for`. Format = flat entries joined by `ENTRY_DELIMITER = "\n§\n"` (line 78). `_parse_entries` splits on that exact delimiter and strips/drops empties. Caps: `MemoryStore(memory_char_limit=2200, user_char_limit=1375)`, configured as `memory.memory_char_limit` / `memory.user_char_limit` (`hermes_cli/config_defaults.py:2113`). Caps apply to the delimiter-joined total.

**Mutation API** (all return `{"success": bool, ...}`, file-locked, drift-guarded):
`add(target, content)`, `replace(target, old_text, new_content)`, `remove(target, old_text)`, `apply_batch(target, operations)`, plus the tool entry point `memory_tool(action=None, target="memory", content=None, old_text=None, new_text=None, operations=None, store=None) -> str`. Headless callers use `load_on_disk_store() -> MemoryStore` (honours configured caps) and `apply_memory_pending(payload, store)`.

**Prompt injection.** `MemoryStore._render_block` produces `"═"*46 / "MEMORY (your personal notes) [NN% — cur/limit chars]" / "═"*46 / entries` (`MEMORY_BLOCK_HEADERS`, line 73). `format_for_system_prompt(target)` returns the **frozen snapshot taken at `load_from_disk()`**, not live state — mid-session writes don't change the prompt (prefix-cache stability). Consumed at `agent/system_prompt.py:928-935`. Separately, provider recall is wrapped by `agent/memory_manager.build_memory_context_block(raw_context) -> str` into `<memory-context>…</memory-context>` with a system note; `sanitize_context()` strips pre-wrapped fences.

**`register_memory_provider(provider)`** (`plugins.py:2373`) — note: this implementation is **inert** (records only). Real activation is `memory.provider` in config.yaml + the collector in `plugins/memory/__init__.py` (`discover_memory_providers()`, `load_memory_provider(name)`), which scans bundled `plugins/memory/<name>/`, `$HERMES_HOME/plugins/<name>/`, project plugins, and the `hermes_agent.memory_providers` entry-point group. Exactly one external provider is allowed alongside `builtin`.

`agent/memory_provider.MemoryProvider` (ABC) — implement:
```python
name -> str (property) ; is_available() -> bool ; unavailable_reason() -> str
initialize(session_id, **kwargs)                 # once at agent start
system_prompt_block() -> str                     # during prompt assembly
prefetch(query, *, session_id="") -> str         # before each API call
queue_prefetch(query, *, session_id="")          # after a turn, for the next one
recall_status() -> Optional[RecallStatus]
sync_turn(user_content, assistant_content, *, session_id="", messages=None)   # after each turn, non-blocking
get_tool_schemas() -> List[dict] ; handle_tool_call(tool_name, args, **kwargs) -> str
shutdown()
# optional: on_turn_start(turn_number, message, **kw), on_session_end(messages),
# on_session_switch(new_session_id, *, parent_session_id="", reset=False, rewound=False, **kw),
# on_pre_compress(messages) -> str, on_delegation(task, result, *, child_session_id="", **kw),
# on_memory_write(action, target, content, metadata=None), backup_paths()
```
`agent/memory_manager.MemoryManager` orchestrates (builtin first) and exposes `prefetch_all`, `sync_all`, `on_session_end`, `on_pre_compress`, `notify_memory_tool_write`, `flush_pending`, `initialize_all`, `shutdown_all`.

**Session search (`hermes_state_search.SessionSearchMixin`, mixed into `hermes_state.SessionDB`).** Open another profile's DB with `SessionDB(db_path=<profile_home>/"state.db", read_only=True)` (`SessionDB.__init__(db_path: Path = None, read_only: bool = False)`; default `get_hermes_home()/"state.db"`). Public methods:
```python
search_messages(query, source_filter=None, exclude_sources=None, role_filter=None,
                limit=20, offset=0, sort=None, include_inactive=False, fields=None) -> List[dict]
search_sessions_by_id(query, limit=20, include_archived=True, source=None,
                      sources=None, exclude_sources=None) -> List[dict]
get_anchored_view(session_id, around_message_id, window=5, bookend=3,
                  keep_roles=("user","assistant")) -> dict
list_recent_user_messages(session_id, limit=20, include_inactive=False) -> List[dict]
optimize_fts() -> int ; rebuild_fts() -> int ; optimize_fts_storage(*, progress_cb=None, vacuum=True)
fts_rebuild_status/step ; fts_cjk_rebuild_status/step
```

**SOUL.md.** Read by `agent/prompt_builder.load_soul_md(context_length=None, home_override: Path|None = None)` from `<HERMES_HOME>/SOUL.md`; injected as identity slot #1 of the *stable* prompt tier at `agent/system_prompt.py:472-485` (falls back to `DEFAULT_AGENT_IDENTITY`). Always pass `home_override=_agent_home(agent)` in multi-profile contexts. When SOUL is loaded as identity, `build_context_files_prompt(..., skip_soul=True)`.

## 4. Cron (`cron/`)

Storage: `$HERMES_HOME/cron/jobs.json` (`JOBS_FILE`), output `$HERMES_HOME/cron/output/<job_id>/<YYYY-MM-DD_HH-MM-SS>.md`. **Jobs are per-profile by virtue of the store path.** Scope programmatically with the context manager `cron.jobs.use_cron_store(home)` (plus `set_hermes_home_override`) — exactly what `cron/scheduler_provider._start_multiplex` and `hermes_cli/web_server.py:13075` do.

```python
from cron import create_job, get_job, list_jobs, update_job, remove_job, pause_job, resume_job, trigger_job, tick
create_job(prompt, schedule, name=None, repeat=None, deliver=None, origin=None,
           skill=None, skills=None, model=None, provider=None, base_url=None, script=None,
           context_from=None, enabled_toolsets=None, workdir=None, no_agent=False,
           attach_to_session=None, monitor_script=None, monitor_url=None,
           reasoning_effort=None) -> dict
cron.scheduler.create_job_with_scheduler_registration(**kwargs) -> dict   # also registers first trigger
```
CLI: `hexbot core -p <profile> cron create <schedule> "<prompt>" [--name --deliver --repeat --skill --script ...]` (`hermes_cli/subcommands/cron.py`).

**Schedule** (`parse_schedule`) → `{"kind": "once"|"interval"|"cron", ...}`: `"30m"`/`"2h"`/`"every 30m"` → interval minutes; `"every day at 9am"`, `"every monday 9am"`, `"weekdays at 9am"`, `"0 9 * * *"` → cron (needs `croniter`); ISO timestamp → once. `compute_next_run(schedule, last_run_at=None)` fills `next_run_at`.

**Job record** (from `create_job`): `id, name, prompt, skills, skill, model, provider, provider_snapshot, model_snapshot, base_url, script, no_agent, monitor_script, monitor_url, monitor_state, context_from, schedule, schedule_display, repeat{times,completed}, enabled, state, paused_at, paused_reason, created_at, next_run_at, last_run_at, last_status, last_error, last_delivery_error, last_delivery_unverified, failure_streak, deliver, origin, enabled_toolsets, workdir` (+ optional `attach_to_session`, `reasoning_effort`).

**Delivery.** `deliver` is a comma-separated string of tokens: `local` (no send), `origin`, `all`, `<platform>` (telegram/discord/signal/… using the configured home channel), `<platform>:<chat_id>[:<thread_id>]`, and `bot-chat[:<profile>]` (injects the output into a local profile's canonical Bot Chat as a message the bot answers). Resolved by `_resolve_delivery_targets(job)`; `parse_bot_chat_deliver_token(part)` handles the bot-chat form.

**Execution.** `cron.scheduler.tick(verbose=True, adapters=None, loop=None, sync=True, *, can_dispatch=None)` runs every 60s from the gateway under a file lock (`~/.hexbot/cron/.tick.lock`). Per due job: `run_one_job(job, ...)` → `run_job(job, ...) -> (success, full_output_doc, final_response, error)`. `run_job` builds the prompt with `_build_job_prompt` (job prompt + optional script stdout / monitor diff / `context_from` prior outputs), then constructs `run_agent.AIAgent(..., quiet_mode=True, skip_context_files=not workdir, load_soul_identity=True, skip_memory=False, skip_background_review=True, platform="cron", session_id=..., session_db=...)` and calls `agent.run_conversation(prompt, task_id=...)` on a pool with an inactivity watchdog (`HERMES_CRON_TIMEOUT`, default 600s; 0 = unlimited). So **yes — a normal agent turn, with SOUL.md and MEMORY.md/USER.md loaded**, which is exactly what a per-bot "dreaming" job needs. Results: `save_job_output(job_id, output)` writes the markdown doc (pruned to `cron.output_keep`), then `_deliver_result(...)`, then `mark_job_run(job_id, success, ...)`. Empty/`[SILENT]` output suppresses delivery.

## 5. Approvals, limits, usage

**Modes** (`tools/approval.py`, `config_defaults.py:2605`):
```yaml
approvals:
  mode: smart            # manual | smart | off   (_get_approval_mode, _normalize_approval_mode)
  timeout: 300           # seconds
  cron_mode: deny        # deny | approve   (non-interactive cron)
  single_query_mode: deny ; unattended_mode: deny   # webhook/msgraph_webhook/api_server
  smart_policy: ""       # appended to the guardian SYSTEM prompt (trusted channel)
  denial_breaker_threshold: 3
  deny: []               # fnmatch globs, block BEFORE any yolo/off bypass
```
**Smart approval model**: `_smart_approve(command, description)` calls `agent.auxiliary_client.call_llm` with task `"approval"` → config block `auxiliary.approval.{provider,model,base_url,api_key,timeout,extra_body,reasoning_effort}` (defaults `provider: auto`, `model: ""`, `timeout: 30`; a fast/cheap model is recommended). Verdicts: `APPROVE|DENY|ESCALATE`; shell comments stripped and the command wrapped in `<command>` delimiters first.

**Allowlist persistence**: top-level `command_allowlist` list in config.yaml. `load_permanent_allowlist() -> set` (also calls `load_permanent(patterns)` so `is_approved()` sees them), `save_permanent_allowlist(patterns: set)`, `approve_permanent(pattern_key)`, `approve_session(session_key, pattern_key)`, `is_approved(session_key, pattern_key)`, `clear_session(session_key)`, `enable_session_yolo/disable_session_yolo`.

**Gateway async approval**: `register_gateway_notify(session_key, cb)` where `cb(approval_data: dict) -> None` (`command`, `description`, `pattern_key`, `pattern_keys`); it runs on the agent thread and must schedule the actual send on the loop. `_await_gateway_decision(session_key, notify_cb, approval_data, *, surface="gateway")` enqueues an `_ApprovalEntry`, fires `pre_approval_request`, blocks the agent thread on an event until `approvals.timeout`, then fires `post_approval_response`. Identical concurrent requests coalesce onto a leader. The UI side calls `resolve_gateway_approval(session_key, choice, resolve_all=False, reason=None, request_id=None) -> int` with `choice ∈ once|session|always|deny`. Reconnect/replay helpers: `list_gateway_approvals`, `get_pending_gateway_approval`, `ack_gateway_approval`, `has_blocking_approval`, `unregister_gateway_notify` (releases all blocked threads). Tool-level escalation: `request_tool_approval(tool_name, reason, *, rule_key="", approval_callback=None) -> dict`. Plugins may own the presentation via `ctx.register_approval_transport(name, present_fn)` + `security.approval.transport: <name>`.

**Room / discussion caps.**
- `gateway/hosted_room_discussion.py:29-35`: `MAX_DISCUSSION_MEMBERS = 6`, `MIN_DISCUSSION_MEMBERS = 2`, `MAX_DISCUSSION_ROUNDS = 3`, `MAX_DISCUSSION_MESSAGES = 10`, `MAX_DISCUSSION_DELTA_LINES = 24`, `MAX_USER_TEXT_BYTES = MAX_MEMBER_TEXT_BYTES = 64 KiB`. Enforced in `validate_roster()` (line 369, 2–6 members), the turn-id regex (`p[0-5]`, `r[0-2]`), the message budget at line 1090, and the round loop at 1114/1174.
- `gateway/hosted_rooms.py:32`: `MAX_MEMBERS = 128` — enforced in `_validate_members()` (line 339) plus `MAX_MEMBERS_JSON_BYTES = 128 KiB`. Also `MAX_ROOM_ID_CHARS 128`, `MAX_ROOM_NAME_CHARS 200`, `MAX_ACTIVE_ROOMS 256`, `MAX_EVENTS_PER_ROOM 50_000`, `MAX_ROOM_LIST_LIMIT 500`.
- `tui_gateway/methods_groups.py` enforces **no** cap of its own: `groups.create` (line 508) and `groups.replicate` (line 789) pass `members=params.get("members")` straight through to `HostedRoomService.create_room` / `hosted_room_replicas.ingest_page`, which call `hosted_rooms._validate_members` (128). So the 128 cap is enforced once, in `hosted_rooms.py`; the 6-member cap applies only to Discussion rosters.

**`session_model_usage`** (schema `hermes_state_common.py:484`; columns `session_id, model, billing_provider, billing_base_url, billing_mode, task, api_call_count, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, estimated_cost_usd, actual_cost_usd, cost_status, cost_source, last_seen`; PK includes `task`).
- **Writers:** `SessionDB._record_model_usage(...)` (`hermes_state.py:10072`) — the accumulate primitive, called inside `SessionDB.update_token_counts(...)` (`:9903`) for main-loop calls (`task=''`); and `SessionDB.record_auxiliary_usage(session_id, ..., task=..., api_call_count=1)` (`:10185`) for auxiliary calls (vision, compression, title_generation, session_search, approval, `background_review`), which deliberately does **not** touch the `sessions` summary row.
- **Readers:** `SessionDB.get_dominant_session_model_route(session_id)` (`:10581`, filters `task = ''`); analytics in `agent/insights.py:585,595`; the dashboard endpoint at `hermes_cli/web_server.py:15830`; migration/recovery reads in `hermes_cli/session_lost_and_found.py:516`.
