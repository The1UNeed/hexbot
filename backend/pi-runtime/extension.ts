/** Hexbot's frozen session tools and approval bridge. Pi owns the agent loop. */
import { readFileSync, realpathSync, lstatSync, readlinkSync, statSync, readdirSync, openSync, fstatSync, closeSync, accessSync, constants } from 'node:fs';
import { resolve, dirname, basename, relative, sep, join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { createBashTool, createReadTool, createWriteTool, createEditTool, createGrepTool, createFindTool, createLsTool, estimateTokens, detectSupportedImageMimeTypeFromFile } from '@earendil-works/pi-coding-agent';
import {credentialPolicy, fold, isolatedCommand, isolationAvailable, policyRegex, policyRoot, privateKeyName, probeIsolation, NO_GUEST_SANDBOX} from './isolation.ts';
import { registerAcp } from './acp.ts';
import { lazyStream } from '@earendil-works/pi-ai';
import { builtinProviders } from '@earendil-works/pi-ai/providers/all';

export default function hexbot(pi: any) {
  probeIsolation();
  const config = JSON.parse(readFileSync(process.env.HEXBOT_SESSION_CONFIG!, 'utf8'));
  let currentContext: any;
  pi.on('session_start', async (_event: any, ctx: any) => {
    currentContext = ctx;
    // --tools also filters deferred registrations in Pi 1.0.1. Select the
    // frozen declarations here so later MCP registrations remain callable.
    if (!Array.isArray(config.restricted) && config.mcpServers?.length) {
      pi.setActiveTools([...config.tools.map((tool: any) => tool.name), ...wrapped, 'codemode']);
    }
  });
  registerAcp(pi, config, async (name: string, args: any) => {
    if (!currentContext) throw new Error('Pi session context is unavailable');
    const raw = await currentContext.ui.input('__HEXBOT_TOOL__' + JSON.stringify({name, args}));
    if (!raw) throw new Error('Provider request interrupted');
    const reply = JSON.parse(raw);
    if (reply.error) throw new Error(reply.error);
    return reply.result;
  });
  // Pi resolves auth before its header hook, and Codex then rebuilds Authorization.
  // Pass the daemon's current token into the native stream itself. Refresh tokens
  // stay in the daemon; the transcript and native transport options pass through.
  const nativeProviders = builtinProviders();
  for (const [provider, api] of [
    ['openai-codex', 'openai-codex-responses'],
    ['anthropic', 'anthropic-messages'],
    ['xai', 'openai-responses'],
  ]) {
    const native = nativeProviders.find((item: any) => item.id === provider)!;
    pi.registerProvider(provider, {api, streamSimple(model: any, context: any, options: any = {}) {
      return lazyStream(model, async () => {
        if (provider === 'xai') {
          const auth = JSON.parse(readFileSync(process.env.PI_CODING_AGENT_DIR + '/auth.json', 'utf8'));
          if (auth.xai?.type !== 'oauth') return native.streamSimple(model, context, options);
        }
        if (!currentContext) throw new Error('Provider authentication is unavailable');
        const raw = await currentContext.ui.input('__HEXBOT_TOOL__' + JSON.stringify({name: 'hexbot_provider_auth', args: {provider: provider === 'xai' ? 'xai-oauth' : provider}}));
        if (!raw) throw new Error('Provider authentication interrupted');
        const reply = JSON.parse(raw);
        if (reply.error) throw new Error(reply.error);
        const headers = reply.result?.headers ?? {};
        const apiKey = headers['x-api-key'] || headers.authorization?.replace(/^Bearer /, '');
        if (!apiKey) throw new Error('Provider authentication returned no token');
        return native.streamSimple(model, context, {...options, apiKey, headers: {...options.headers, ...headers}});
      });
    }});
  }
  let fallbackUsed = false;
  let iterations = 0;
  let limitReached = false;
  const maxTurns = Number(config.maxTurns);
  // Shortly before Pi would compact, clear old tool output once. Pi's compaction
  // check runs right after this boundary, on the edited context. The edits are
  // persisted context_edit entries, so the cached prefix changes once per
  // crossing and never per request; the request-local `context` event would
  // move the prefix every turn. Armed again once usage is back under the line.
  // The compaction settings are read once here, where Pi has just loaded its
  // own copy; the daemon rewrites the file for later sections, and this
  // process keeps compacting under the settings it started with.
  const compaction = compactionSettings();
  let trimArmed = true;
  const trim = (event: any, ctx: any) => {
    const usage = ctx.getContextUsage?.();
    if (!usage || usage.tokens === null || !(usage.contextWindow > 0)) return;
    const compactAt = compactionPoint(compaction, usage.contextWindow, ctx.model);
    if (compactAt === undefined) return;
    if (usage.tokens < compactAt - usage.contextWindow * TRIM_MARGIN) { trimArmed = true; return; }
    if (!trimArmed) return;
    const stale = staleToolResults(event.context?.contextEntries ?? []);
    const saved = stale.reduce((sum, {message}) => sum + estimateTokens(message) - estimateTokens(cleared(message)), 0);
    // Not worth a cache rewrite: let compaction run. Checked again next turn,
    // when more results have aged past the kept turns.
    if (usage.tokens - saved > compactAt * TRIM_TARGET) return;
    trimArmed = false;
    return stale.map(({id, message}) => ({type: 'context_edit', targetId: id, replacement: {content: cleared(message).content}}));
  };
  pi.on('turn_end', async (event: any, ctx: any) => {
    iterations++;
    if (Number.isFinite(maxTurns) && maxTurns > 0 && iterations >= maxTurns && event.message?.stopReason === 'toolUse') {
      limitReached = true;
      await ctx.ui.input('__HEXBOT_TOOL__' + JSON.stringify({name: 'hexbot_turn_limit', args: {limit: maxTurns}}));
      ctx.abort();
    }
    const edits = trim(event, ctx);
    if (edits?.length) return {entries: [...event.entries ?? [], ...edits]};
  });
  const bridge = async (ctx: any, name: string, args: any = {}) => {
    const raw = await ctx.ui.input('__HEXBOT_TOOL__' + JSON.stringify({name, args}));
    if (!raw) throw new Error('Daemon request interrupted');
    const reply = JSON.parse(raw);
    if (reply.error) throw new Error(reply.error);
    return reply.result;
  };
  let live = config;
  let primary: any;
  // The system prompt is frozen with the section, with one exception: at
  // compaction, when the history cache is already lost, the daemon rebuilds it
  // so a long section picks up its bot's current soul, memory and About you.
  // The tool declarations never change, so their cached prefix survives.
  let prompt = config.prompt;
  const refresh = async (ctx: any) => { live = {...config, ...await bridge(ctx, 'hexbot_session_settings')}; };
  // Resolve credentials in memory on the first prompt. RPC cannot answer a
  // bridge request during session_start, before its stdin reader is attached.
  let mcpRegistered = false;
  let mcpState = '';
  const mcpRevisions = new Map<string, string>();
  const registerMcp = async (ctx: any) => {
    if (Array.isArray(config.restricted) || !config.mcpServers?.length) return;
    const state = JSON.stringify(live.mcpState);
    if (mcpRegistered && state === mcpState) return;
    let servers: any[];
    try { servers = await bridge(ctx, 'hexbot_mcp_servers'); }
    catch (error: any) { ctx.ui.notify(`Connected tools are unavailable: ${error.message}`, 'warning'); return; }
    for (const name of mcpRevisions.keys()) {
      if (!servers.some(server => server.name === name && server.config)) {
        pi.unregisterMcpServer(name);
        mcpRevisions.delete(name);
        sessionAllowed.delete(`mcp:${name}`);
      }
    }
    let complete = true;
    for (const {name, config: entry, revision, error} of servers) {
      if (error) { ctx.ui.notify(error, 'warning'); continue; }
      if (mcpRevisions.has(name) && mcpRevisions.get(name) === revision) continue;
      try {
        const resolved = {...entry, ...(entry.env && {env: escapeMcpValues(entry.env)}), ...(entry.headers && {headers: escapeMcpValues(entry.headers)})};
        pi.registerMcpServer(name, resolved);
        mcpRevisions.set(name, revision);
        sessionAllowed.delete(`mcp:${name}`);
      } catch (error: any) { complete = false; ctx.ui.notify(`Connected tool ${name}: ${error.message}`, 'warning'); }
    }
    mcpRegistered = complete;
    mcpState = state;
    // Pi hides old tools and closes their client before awaiting reconnect.
    // A call during reconnect may be unavailable, but cannot use the old client.
    // Deferred registrations never change the model's declarations.
    await new Promise(resolve => setImmediate(resolve));
  };
  const mcpServer = (tool: string) => config.mcpServers?.filter((name: string) => tool.startsWith(`mcp__${name.replace(/-/g, '_')}__`)).sort((a: string, b: string) => b.length - a.length)[0];
  const mcpDenial = (tool: string) => serverDenial(mcpServer(tool));
  const serverDenial = (server: string) => {
    const current = live.mcpState?.[server];
    if (!current) return 'This connected tool was removed or disabled.';
    if (current.error) return current.error;
    if (!mcpRevisions.has(server) || mcpRevisions.get(server) !== current.revision) return 'This connected tool changed. Try again in the next message to reconnect.';
  };
  // Approval modes follow Codex. Auto ('smart'): commands run in a sandbox with
  // no network that writes only to the workspace, and the file tools write freely
  // inside it. Manual: the sandbox is read-only and every file change asks. Off
  // (Bypass): no approval prompts or sandbox. Revocation still applies. A command
  // that needs more sets full_access, and the user decides.
  const workspaceRoots = () => [live.cwd ?? config.cwd, ...live.outputDirs ?? [], tmpdir(), '/tmp'];
  const workspace = () => live.approvalMode === 'manual' ? [] : workspaceRoots();
  const inWorkspace = (path: string) => {
    const target = canonicalPath(path, process.cwd());
    return workspaceRoots().some(root => under(target, canonicalPath(root, process.cwd())));
  };
  type Level = 'none' | 'base' | 'confined';
  // A guest session (a shared bot in someone else's room) never leaves the
  // workspace sandbox: the base layer keeps the host's service brokers
  // reachable, and a reader they start would run outside any sandbox.
  const levelFor = (input: any): Level => live.approvalMode === 'off' ? 'none' : input.full_access === true && live.guest !== true ? 'base' : 'confined';
  // What the gate allowed for each call: the mode it decided under, how bash
  // runs, and the file it checked. Pi may gate several calls before running
  // them, so execution refuses a call whose mode or target has changed since.
  const allowedCalls = new Map<string, {mode: string, cwd: string, level: Level, target?: string}>();
  const wrapped = new Set<string>();
  const sessionAllowed = new Set<string>();
  const gate = async (event: any, ctx: any) => {
    let target: string | undefined;
    const denial = await check(event, ctx, path => { target = path; });
    if (!denial && event.toolCallId && wrapped.has(event.toolName)) allowedCalls.set(event.toolCallId, {mode: live.approvalMode, cwd: live.cwd ?? config.cwd, level: levelFor(event.input), target});
    return denial;
  };
  const check = async (event: any, ctx: any, checked: (path: string) => void = () => {}) => {
    const browser = event.toolName === 'browser_console' && typeof event.input.expression === 'string';
    const mcp = event.toolName.startsWith('mcp__');
    const resource = ['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource'].includes(event.toolName);
    const script = event.toolName === 'codemode' && typeof event.input?.code === 'string' && config.mcpServers?.length;
    if (!['bash', 'read', 'grep', 'find', 'ls', 'write', 'edit'].includes(event.toolName) && !browser && !mcp && !resource && !script) return;
    try {
      await refresh(ctx);
      if (script) {
        // A revoked server's tools are gone once the next prompt unregisters it,
        // so a script naming them would fail inside the VM with a bare TypeError.
        const named = config.mcpServers.filter((name: string) => event.input.code.includes(`mcp__${name.replace(/-/g, '_')}__`));
        const reason = named.map(serverDenial).find(Boolean);
        return reason ? {block: true, reason} : undefined;
      }
      if (resource) {
        // Resources need no approval, but a revoked or changed server's open
        // client must not answer before the next prompt reconnects it.
        const named = typeof event.input?.server === 'string' ? [event.input.server] : [...mcpRevisions.keys()];
        const reason = named.filter(server => mcpRevisions.has(server)).map(serverDenial).find(Boolean);
        return reason ? {block: true, reason} : undefined;
      }
      if (mcp) {
        const reason = mcpDenial(event.toolName);
        if (reason) return {block: true, reason};
      }
      if (live.approvalMode === 'off') return;
      const cwd = live.cwd ?? config.cwd;
      let ask: {key: string, command: string, reason: string} | undefined;
      if (mcp) {
        const tool = pi.getAllTools().find((candidate: any) => candidate.name === event.toolName);
        if (live.approvalMode === 'manual' || tool?.annotations?.readOnlyHint !== true) {
          const namespace = tool?.namespace?.name ?? event.toolName;
          const server = mcpServer(event.toolName) ?? namespace;
          const label = `${server}/${event.toolName.slice(namespace.length + 2) || event.toolName}`;
          const args = JSON.stringify(event.input ?? {});
          ask = {key: `mcp:${server}`, command: args === '{}' ? label : `${label} ${args.length > 300 ? args.slice(0, 300) + '…' : args}`,
            reason: live.approvalMode === 'manual' ? 'Manual mode asks before a connected tool runs.' : 'Auto mode asks before a connected tool changes anything.'};
        }
      }
      if (['read', 'grep', 'find', 'ls', 'write', 'edit'].includes(event.toolName)) {
        const input = event.input.path ?? '.';
        const path = canonicalPath(input, cwd);
        checked(path);
        if (credentialPath(resolve(cwd, input), live.home) || credentialPath(path, live.home)) return {block: true, reason: 'Credential files are private.'};
        if (live.guest === true && (privatePath(resolve(cwd, input), live.home, live.session) || privatePath(path, live.home, live.session))) return {block: true, reason: PRIVATE_TO_OWNER};
        if (['write', 'edit'].includes(event.toolName)) {
          const denial = writeDenial(input, cwd, live.home, live.outputDirs);
          if (denial) return {block: true, reason: denial};
          if (live.approvalMode === 'manual') ask = {key: 'file', command: path, reason: 'Manual mode asks before every file change.'};
          else if (hostWriteTier(input, cwd) === 'ask') ask = {key: 'file:host-config', command: path, reason: 'This changes a shell profile, login item or other host configuration file.'};
          else if (!inWorkspace(path)) ask = {key: 'file:outside', command: path, reason: 'This changes a file outside the workspace.'};
        }
      }
      if (event.toolName === 'bash') {
        if (event.input.full_access === true) {
          if (live.guest === true) return {block: true, reason: NO_GUEST_FULL_ACCESS};
          const why = typeof event.input.reason === 'string' && event.input.reason.trim() ? event.input.reason.trim() : 'No reason given.';
          ask = {key: 'shell:full-access', command: event.input.command, reason: 'Run outside the sandbox, with internet access and writes outside the workspace. ' + why};
        } else if (!isolationAvailable()) {
          // Without an OS sandbox nothing confines a command, so each one asks.
          // In a guest session the one who would approve is the room owner,
          // the person the sandbox keeps the files from, so it is refused.
          if (live.guest === true) return {block: true, reason: NO_GUEST_SANDBOX};
          ask = {key: 'shell:unsandboxed', command: event.input.command, reason: 'Hexbot has no OS sandbox on this system, so this command can read and change any file you can. Install bubblewrap and restart the daemon to restore isolation.'};
        }
      }
      if (browser) ask = {key: 'browser_console', command: event.input.expression, reason: 'This runs code in a web page.'};
      if (!ask || sessionAllowed.has(ask.key)) return;
      if (mcp && live.canAsk === false) return {block: true, reason: 'This connected tool needs approval. Run it in a visible section.'};
      const mode = live.approvalMode;
      const choice = await ctx.ui.select('__HEXBOT_APPROVAL__' + JSON.stringify({tool: event.toolName, command: ask.command, reason: ask.reason}), ['once', 'session', 'deny']);
      if (mcp) {
        // Pi emits execution_start before tool_call. Its public API has no MCP
        // execute wrapper; the last blocking hook is this gate. Recheck after UI.
        await refresh(ctx);
        if (mode !== live.approvalMode) return {block: true, reason: 'The approval mode changed before this ran. Try again.'};
        const reason = mcpDenial(event.toolName);
        if (reason) return {block: true, reason};
      }
      if (choice === 'session') sessionAllowed.add(ask.key);
      else if (choice !== 'once') return {block: true, reason: 'The user denied this action.'};
    } catch {
      return {block: true, reason: 'The approval settings could not be checked. Try again.'};
    }
  };
  // The user's own commands and the code runtime's terminal have no full_access.
  // A guest session's sandbox also hides what privatePath() hides from the file
  // tools, in the base layer too, and keeps the guest's own section readable.
  const guestSection = () => live.guest === true ? String(live.session ?? '') : undefined;
  const spawnFor = (level: Level, command: string) => level === 'none' ? command :
    isolatedCommand(command, live.home, live.outputDirs, level === 'confined' ? workspace() : undefined, guestSection());
  const sandboxNote = () => (live.approvalMode === 'manual'
    ? '[The command ran in the read-only sandbox, without internet access. '
    : `[The command ran in the sandbox, without internet access and with writes only in ${live.cwd ?? config.cwd}, its output folders, and temporary folders. `)
    + (live.guest === true ? NO_GUEST_FULL_ACCESS : 'If it failed for that reason, run it again with full_access and a reason.') + ']';

  // What the file tools never show outside Bypass: credential files, and in a
  // shared bot's session in someone else's room, its owner's memory and notes,
  // every About you and every other section's folder (the daemon says so with
  // `guest` and the section's own id in the live settings).
  const hidden = (path: string, home: string) => credentialPath(path, home) || (live.guest === true && privatePath(path, home, live.session));
  // Keep the built-in schemas and select tools only from the frozen configuration.
  // Refresh cwd at execution time without rewriting the cached prompt or history.
  // The bash schema gains Codex's escalation fields in every mode, so a mode
  // change never changes the cached tool list.
  const factories: any = {bash: createBashTool, read: createReadTool, write: createWriteTool, edit: createEditTool, grep: createGrepTool, find: createFindTool, ls: createLsTool};
  const enabled = (name: string) => Array.isArray(config.restricted) ? config.restricted.includes(name) :
    config.enabledToolsets?.includes(name === 'bash' ? 'terminal' : 'file');
  for (const [name, factory] of Object.entries(factories) as [string, any][]) {
    if (!enabled(name)) continue;
    wrapped.add(name);
    const bypass = () => live.approvalMode === 'off';
    // An owner session reads by path. A guest session's call (`files`) opens
    // first and judges the descriptor, so a link swapped in after the path was
    // checked cannot reach a private file.
    const options = (level: Level = 'confined', files?: GuestFiles) => {
      if (name === 'bash') return {spawnHook: (c: any) => level === 'none' ? c : {...c, command: spawnFor(level, c.command), env: shellEnvironment(c.env)}};
      if (bypass()) return {};
      if (name === 'grep') return {operations: {isDirectory: (path: string) => statSync(path).isDirectory(), readFile: async (path: string) => hidden(path, live.home) ? '' : files ? (await files.open(path, fd => readFileSync(fd, 'utf8'))) ?? '' : readFileSync(path, 'utf8')}};
      if (name === 'read' && files) {
        const judged = async <T>(path: string, use: (fd: number) => T | Promise<T>) => { const result = await files.open(path, use); if (result === undefined) throw new Error(PRIVATE_TO_OWNER); return result; };
        // The image sniff reads the judged descriptor through /dev/fd.
        return {operations: {access: async (path: string) => accessSync(path, constants.R_OK), detectImageMimeType: (path: string) => judged(path, fd => detectSupportedImageMimeTypeFromFile(`/dev/fd/${fd}`)), readFile: (path: string) => judged(path, fd => readFileSync(fd))}};
      }
      return {};
    };
    const tool = factory(config.cwd, options());
    const definition = name === 'bash' ? {
      description: tool.description + ' Commands may run in a sandbox that blocks internet access and writes outside the workspace. When a command needs either, set full_access and give a reason.',
      parameters: {type: 'object', properties: {
        command: {type: 'string', description: 'Shell command to execute'},
        timeout: {type: 'number', description: 'Timeout in seconds (optional, no default timeout)'},
        full_access: {type: 'boolean', description: 'Run outside the sandbox, with internet access and writes outside the workspace. The user may be asked first.'},
        reason: {type: 'string', description: 'With full_access: one short sentence, shown to the user, saying why the command needs it.'}
      }, required: ['command']}
    } : {};
    pi.registerTool({...tool, ...definition, async execute(id: string, args: any, signal: any, update: any, ctx: any) {
      const allowed = allowedCalls.get(id);
      allowedCalls.delete(id);
      if (ctx) await refresh(ctx);
      if (!allowed || allowed.mode !== live.approvalMode) throw new Error('The approval mode changed before this ran. Try again.');
      if (allowed.cwd !== (live.cwd ?? config.cwd)) throw new Error('The working directory changed before this ran. Try again.');
      const cwd = live.cwd ?? config.cwd;
      if (name === 'bash') {
        const level = allowed.level;
        try {
          const result = await factory(cwd, options(level)).execute(id, {command: args.command, timeout: args.timeout}, signal, update);
          if (level === 'confined' && result.isError) result.content.push({type: 'text', text: sandboxNote()});
          return result;
        } catch (error: any) {
          if (level !== 'confined' || !/Command exited with code/.test(error?.message ?? '')) throw error;
          throw new Error(error.message + '\n\n' + sandboxNote());
        }
      }
      if (bypass()) return factory(cwd, options()).execute(id, args, signal, ['grep', 'find', 'ls'].includes(name) ? undefined : update);
      // Pass the checked canonical target to Pi too: its lexical normalization
      // of '..' must not select a different file after a symlink was checked.
      const path = canonicalPath(args.path ?? '.', cwd);
      if (credentialPath(resolve(cwd, args.path ?? '.'), live.home) || credentialPath(path, live.home)) throw new Error('Credential files are private.');
      if (live.guest === true && (privatePath(resolve(cwd, args.path ?? '.'), live.home, live.session) || privatePath(path, live.home, live.session))) throw new Error(PRIVATE_TO_OWNER);
      if (['write', 'edit'].includes(name)) {
        // The approval covered the file the gate resolved, not a link swapped in since.
        if (path !== allowed.target) throw new Error('The file changed after it was checked. Try again.');
        const denial = writeDenial(args.path ?? '.', cwd, live.home, live.outputDirs);
        if (denial) throw new Error(denial);
      }
      args = {...args, path};
      // A guest's call judges what it opens and what it lists by identity too
      // (ripgrep reads the match lines itself): a hard link to a note is a
      // path the checks above do not know.
      const files = live.guest === true ? guestFiles(live.home, live.session) : undefined;
      // Avoid streaming unfiltered search output.
      const result = await factory(cwd, options('confined', files)).execute(id, args, signal, ['grep', 'find', 'ls'].includes(name) ? undefined : update);
      if (['grep', 'find', 'ls'].includes(name)) {
        const base = statSync(path).isDirectory() ? path : dirname(path);
        return sanitizeSearchResult(result, name, base, live.home, files ? (path, home) => hidden(path, home) || files.names(path) : hidden);
      }
      return result;
    }});
  }
  pi.on('user_bash', async (event: any, ctx: any) => {
    const denial = await gate({toolName: 'bash', input: {command: event.command}}, ctx);
    if (denial) return {result: {output: denial.reason, exitCode: 1, cancelled: false, truncated: false}};
    const level = levelFor({});
    return {operations: {exec: async (command: string, cwd: string, opts: any) => {
      const {createLocalBashOperations} = await import('@earendil-works/pi-coding-agent');
      if (level === 'none') return createLocalBashOperations().exec(command, live.cwd ?? cwd, opts);
      return createLocalBashOperations().exec(spawnFor(level, command), live.cwd ?? cwd, {...opts, env: shellEnvironment(opts.env ?? process.env)});
    }}};
  });

  pi.on('before_provider_request', async (event: any, ctx: any) => {
    const provider = ctx.model?.provider ?? config.provider;
    if (!['qwen-oauth', 'nous', 'openrouter', 'kimi-coding', 'kimi-coding-cn', 'moonshotai', 'moonshotai-cn', 'deepseek', 'zai', 'minimax', 'minimax-cn', 'minimax-oauth', 'custom', 'ollama'].includes(provider)) return;
    const raw = await ctx.ui.input('__HEXBOT_TOOL__' + JSON.stringify({name: 'hexbot_provider_request', args: {provider, model: ctx.model?.id, thinking: pi.getThinkingLevel(), payload: event.payload}}));
    if (!raw) throw new Error('Provider request interrupted');
    const reply = JSON.parse(raw);
    if (reply.error) throw new Error(reply.error);
    return reply.result;
  });
  pi.on('before_provider_headers', async (event: any, ctx: any) => {
    const provider = ctx.model?.provider ?? config.provider;
    if (!['nous', 'qwen-oauth', 'minimax-oauth'].includes(provider)) return;
    const raw = await ctx.ui.input('__HEXBOT_TOOL__' + JSON.stringify({name: 'hexbot_provider_auth', args: {provider}}));
    if (!raw) throw new Error('Provider authentication interrupted');
    const reply = JSON.parse(raw);
    if (reply.error) throw new Error(reply.error);
    Object.assign(event.headers, reply.result?.headers ?? {});
  });
  pi.on('before_agent_start', async (_event: any, ctx: any) => {
    await refresh(ctx);
    await registerMcp(ctx);
    primary ??= ctx.model;
    const model = ctx.modelRegistry.find(live.provider, live.model) ?? primary;
    if (model && (ctx.model?.provider !== model.provider || ctx.model?.id !== model.id)) await pi.setModel(model);
    fallbackUsed = false; iterations = 0; limitReached = false;
    return {systemPrompt: prompt};
  });
  pi.on('session_compact', async (_event: any, ctx: any) => {
    // The todo list and the prompt are two requests; one failing or empty
    // never stops the other.
    try {
      const todo = await bridge(ctx, 'hexbot_todo_context');
      if (todo?.text) pi.sendMessage({customType: 'hexbot_todo', content: todo.text, display: false});
    } catch {}
    // Null means the prompt is unchanged. A failed request keeps the prompt the
    // section had, which is what every turn before this one used.
    try {
      const fresh = await bridge(ctx, 'hexbot_session_prompt');
      if (typeof fresh?.text === 'string' && fresh.text) prompt = fresh.text;
    } catch {}
  });
  pi.on('agent_before_settle', async (event: any, ctx: any) => {
    if (limitReached || event.outcome !== 'error' || fallbackUsed) return;
    await refresh(ctx);
    if (!live.fallback?.provider || !live.fallback?.model) return;
    fallbackUsed = true;
    const model = ctx.modelRegistry.find(live.fallback.provider, live.fallback.model);
    if (!model || (ctx.model?.provider === model.provider && ctx.model?.id === model.id)) return;
    if (!await pi.setModel(model)) return;
    pi.sendMessage({customType: 'hexbot_fallback', content: 'The model service failed. Continue the current task from the existing conversation and tool results. Do not repeat completed actions.', display: false}, {triggerTurn: true, deliverAs: 'followUp'});
    return {continue: true};
  });
  pi.on('tool_call', gate);
  for (const tool of config.tools) {
    pi.registerTool({
      name: tool.name,
      label: tool.label ?? tool.name,
      description: tool.description,
      parameters: tool.parameters ?? tool.inputSchema ?? { type: 'object', properties: {} },
      async execute(_id: string, args: any, signal: AbortSignal | undefined, _update: any, ctx: any) {
        if (signal?.aborted) throw new Error('Tool interrupted');
        if (tool.name === 'clarify') {
          if (!args.question && !args.questions?.length) throw new Error('A question is required');
          const answer = await ctx.ui.input('__HEXBOT_CLARIFY__' + JSON.stringify(args));
          return { content: [{ type: 'text', text: answer ?? 'The question was cancelled.' }], details: {} };
        }
        const reply = await ctx.ui.input('__HEXBOT_TOOL__' + JSON.stringify({ name: tool.name, args }), undefined, { signal });
        if (reply === undefined) throw new Error('Tool interrupted');
        const result = JSON.parse(reply);
        if (result.error) throw new Error(result.error);
        const content = Array.isArray(result.result?.content) ? result.result.content.filter((item: any) => item.type === 'text' || item.type === 'image') : undefined;
        return { content: content?.length ? content : [{ type: 'text', text: JSON.stringify(result.result) }], details: result.result ?? {} };
      }
    });
  }
}

// Old tool output is cleared when usage passes the compaction point minus a
// tenth of the window, and only if that would bring it under 70% of the point.
// Results since the third most recent user message are kept: Pi ends a turn
// after every tool round, so the bot may still be using them mid-task, and a
// single long run is never trimmed under its own user message. Results under
// about 1,000 characters are not worth an edit. The bot must keep what the
// user answered, its own notes, soul and todo list, what another bot said, a
// skill's instructions and a delegate's report, word for word.
const TRIM_MARGIN = 0.1;
const TRIM_TARGET = 0.7;
const KEEP_TURNS = 3;
const FLOOR_TOKENS = 250;
const VERBATIM = new Set(['clarify', 'memory', 'hexbot_soul', 'todo', 'todo_list', 'message_bot', 'skill_view', 'delegate_task']);
// The compaction key the daemon writes into the bot's Pi settings.json
// (providers.rs, write_pi_settings; the daemon snapshots the same key when it
// launches this process, so the meter agrees). Empty when the file is unreadable.
function compactionSettings(): any {
  try { return JSON.parse(readFileSync(join(process.env.PI_CODING_AGENT_DIR!, 'settings.json'), 'utf8')).compaction ?? {}; } catch { return {}; }
}
// Where Pi compacts: the window minus the model's reserve, Pi's own default
// when the key has none, and never below half the window (the daemon's floor).
function compactionPoint(compaction: any, window: number, model: any): number | undefined {
  if (compaction.enabled === false) return;
  const reserve = compaction.modelOverrides?.[`${model?.provider}/${model?.id}`]?.reserveTokens ?? compaction.reserveTokens ?? 16384;
  return Math.max(window - reserve, Math.floor(window / 2));
}
// Tool results in the projected context that are old and large enough to clear:
// behind the first user message, before the third most recent user message,
// not from a verbatim tool. A result cleared earlier is already under the floor.
export function staleToolResults(contextEntries: any[]): {id: string, message: any}[] {
  const flat = contextEntries.flatMap(entry => (entry.messages ?? []).map((message: any) => ({entry, message})));
  const users = flat.filter(({message}) => message.role === 'user').length;
  let prompted = 0;
  const stale: {id: string, message: any}[] = [];
  for (const {entry, message} of flat) {
    if (message.role === 'user') prompted++;
    if (message.role !== 'toolResult' || !prompted || prompted > users - KEEP_TURNS) continue;
    if (entry.sourceEntry?.type !== 'message' || VERBATIM.has(message.toolName)) continue;
    if (estimateTokens(message) < FLOOR_TOKENS) continue;
    stale.push({id: entry.sourceEntry.id, message});
  }
  return stale;
}
export function cleared(message: any): any {
  const chars = (message.content ?? []).reduce((sum: number, block: any) => sum + (block.type === 'text' ? block.text.length : 0), 0);
  return {...message, content: [{type: 'text', text: `[Old tool output (${chars.toLocaleString('en-US')} characters) cleared to save context; the call and its arguments are kept. Run it again if the output is needed.]`}]};
}

// Filenames can contain grep's line delimiters too (for example owl-2-beta).
// Check every possible path prefix, including text nested in truncation details.
export function sanitizeSearchResult(value: any, name: string, base: string, home: string, isHidden: (path: string, home: string) => boolean = credentialPath): any {
  if (typeof value === 'string') return value.split('\n').filter(line => {
    const paths = name === 'grep' ? [...line.matchAll(/(:\d+:|-\d+-)/g)].map(match => line.slice(0, match.index)) : [line.replace(/\/$/, '')];
    return !paths.some(path => isHidden(resolve(base, path), home) || isHidden(canonicalPath(path, base), home));
  }).join('\n');
  if (Array.isArray(value)) return value.map(part => sanitizeSearchResult(part, name, base, home, isHidden));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, part]) => [key, sanitizeSearchResult(part, name, base, home, isHidden)]));
  return value;
}

// Shell spellings of the user's home: ~, ~/x, ~user/x, $HOME and ${HOME}.
export function expandHome(path: string): string {
  const user = process.env.USER ?? basename(homedir());
  return path.replace(/\$\{HOME\}|\$HOME\b/g, homedir())
    .replace(/^~([^/]*)/, (_match, name) => !name || name === user ? homedir() : join(dirname(homedir()), name));
}
// realpathSync.native returns the on-disk case; comparisons fold it (isolation.ts).
export function canonicalPath(path: string, cwd: string, depth = 0): string {
  if (depth > 40) throw new Error("Too many symbolic links");
  const expanded = expandHome(path);
  // Resolve each component before '..', including a symlink followed by a parent.
  let current = expanded.startsWith(sep) ? sep : cwd;
  for (const part of expanded.split(sep)) {
    if (!part || part === '.') continue;
    current = part === '..' ? dirname(current) : join(current, part);
    try { current = realpathSync.native(current); }
    catch (error: any) {
      if (error.code !== 'ENOENT') throw error;
      try {
        if (lstatSync(current).isSymbolicLink()) current = canonicalPath(readlinkSync(current), dirname(current), depth + 1);
      } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  return current;
}
const under = (path: string, root: string) => fold(path) === fold(root) || fold(path).startsWith(fold(root) + sep);
export function credentialPath(path: string, home: string): boolean {
  const lexical = resolve(path);
  path = canonicalPath(path, process.cwd());
  if (lexical !== path && credentialName(lexical, home)) return true;
  return credentialName(path, home);
}
function credentialName(path: string, home: string): boolean {
  for (const ssh of [join(homedir(), '.ssh'), canonicalPath(join(homedir(), '.ssh'), process.cwd())]) {
    if (under(path, ssh) && (fold(dirname(path)) !== fold(ssh) || privateKeyName(basename(path)))) return true;
  }
  if (credentialPolicy.user.some((local: string) => {
    const secret = join(homedir(), local);
    return under(path, secret) || under(path, canonicalPath(secret, process.cwd()));
  })) return true;
  // Credential stores such as ~/.aws and ~/.netrc are private to reads too.
  if ((credentialPolicy.write.deny as string[]).some(entry => {
    const store = policyRoot(entry);
    return under(path, store) || under(path, canonicalPath(store, process.cwd()));
  })) return true;
  const name = basename(path);

  if (!home) throw new Error('Hexbot home is unavailable');
  const root = under(path, resolve(home)) ? resolve(home) : canonicalPath(home, process.cwd());
  const local = relative(fold(root), fold(path)).split(sep).join('/');
  return !local.startsWith('../') && (policyRegex(credentialPolicy.basename).test(name) || policyRegex(credentialPolicy.home).test(local));
}
const PRIVATE_TO_OWNER = "The bot's memory and notes, every About you, and other sections' history are private to their owners and stay out of this room.";
const NO_GUEST_FULL_ACCESS = "Full access is not available to a shared bot in someone else's room.";
// A bot's memory and daily notes, every user's About you, and every section
// folder under runtime/sessions but the session's own (`section`), as the file
// tools of a shared bot in someone else's room must not read them: it gets no
// About you there, its memory tool refuses notes, and other sections' history
// quotes both. The path as given and its target are both checked, so a link
// cannot disguise one, and so is the identity of the target's folders, for an
// alias that resolving leaves in place (a macOS firmlink such as
// /System/Volumes/Data, or a mount).
export function privatePath(path: string, home: string, section?: string): boolean {
  const lexical = resolve(path);
  path = canonicalPath(path, process.cwd());
  return privateName(lexical, home, section) || privateName(path, home, section) || privateIdentity(path, home, section);
}
function privateName(path: string, home: string, section?: string): boolean {
  const root = under(path, resolve(home)) ? resolve(home) : canonicalPath(home, process.cwd());
  const local = relative(fold(root), fold(path)).split(sep).join('/');
  if (local.startsWith('../')) return false;
  const own = section ? fold(`runtime/sessions/${section}`) : undefined;
  if (own && (local === own || local.startsWith(own + '/'))) return false;
  return /^(users\/[^/]+\/user\.md|profiles\/[^/]+\/memories(\/.*)?|runtime\/sessions(\/.*)?)$/.test(local);
}
const identity = (path: string) => { try { const stat = statSync(path); return `${stat.dev}:${stat.ino}`; } catch { return undefined; } };
const names = (dir: string) => { try { return readdirSync(dir); } catch { return []; } };
function privateIdentity(path: string, home: string, section?: string): boolean {
  const sessions = join(home, 'runtime/sessions');
  const own = section ? identity(join(sessions, section)) : undefined;
  const roots = new Set([identity(sessions), ...names(join(home, 'users')).map(user => identity(join(home, 'users', user, 'user.md'))), ...names(join(home, 'profiles')).map(bot => identity(join(home, 'profiles', bot, 'memories')))].filter(Boolean));
  for (let current = path; ; current = dirname(current)) {
    const id = identity(current);
    if (id && id === own) return false;
    if (id && roots.has(id)) return true;
    if (dirname(current) === current) return false;
  }
}
// The identities (device and inode) of every file and folder a guest session
// is refused: everything under `users`, under every bot's `memories`, and
// under `runtime/sessions` but the guest's own section, as PrivateFiles in
// credentials.rs collects them for the daemon's file bridge. privatePath()
// judges the path a request names; this judges the file the request opened.
function privateIdentities(home: string, section?: string): Set<string> {
  const sessions = join(home, 'runtime/sessions');
  const pending = [join(home, 'users'), sessions, ...names(join(home, 'profiles')).map(bot => join(home, 'profiles', bot, 'memories'))];
  const ids = new Set<string>();
  for (let path = pending.pop(); path !== undefined; path = pending.pop()) {
    // Links are not followed: a link the owner left inside is only itself.
    let stat; try { stat = lstatSync(path); } catch { continue; }
    ids.add(`${stat.dev}:${stat.ino}`);
    if (stat.isDirectory()) for (const name of names(path)) if (path !== sessions || name !== section) pending.push(join(path, name));
  }
  return ids;
}
// One guest tool call's view of those identities, collected on first use, so
// a file that existed when the call opened or listed it is in the set.
type GuestFiles = ReturnType<typeof guestFiles>;
function guestFiles(home: string, section?: string) {
  let ids: Set<string> | undefined;
  const has = (stat: {dev: number | bigint, ino: number | bigint}) => (ids ??= privateIdentities(home, section)).has(`${stat.dev}:${stat.ino}`);
  return {
    // Opens `path` and hands the descriptor to `use`, or returns undefined
    // when what it opened is private.
    open: async <T>(path: string, use: (fd: number) => T | Promise<T>): Promise<T | undefined> => {
      const fd = openSync(path, 'r');
      try { return has(fstatSync(fd)) ? undefined : await use(fd); } finally { closeSync(fd); }
    },
    // Whether the file `path` names now is private (a listing's result).
    names: (path: string) => { try { return has(statSync(path)); } catch { return false; } },
  };
}
const NEVER_WRITTEN = 'Credential and system configuration files are never written by tools.';
// credential-policy.json "write": deny entries are credential stores that tools
// never write; ask entries (shell profiles, login items) prompt in Manual and
// Auto; fileDeny entries (system configuration) are denied to the file tools.
export function hostWriteTier(input: string, cwd: string, fileTool = false): 'deny' | 'ask' | undefined {
  const targets = [resolve(cwd, expandHome(input)), canonicalPath(input, cwd)];
  const tiers = [['deny', 'deny'], [fileTool ? 'deny' : 'ask', 'fileDeny'], ['ask', 'ask']] as const;
  for (const [tier, list] of tiers) {
    for (const entry of credentialPolicy.write[list] as string[]) {
      const root = policyRoot(entry);
      if (targets.some(target => under(target, root) || under(target, canonicalPath(root, cwd)))) return tier;
    }
  }
}
// Inside the home only the daemon-chosen output folders are writable, never the cwd.
function writeDenial(input: string, cwd: string, home: string, outputs: string[] = []): string | undefined {
  const path = canonicalPath(input, cwd);
  if (protectedPath(path, home, outputs)) return 'This path is protected. Use the soul or memory tool for bot notes.';
  if (hostWriteTier(input, cwd, true) === 'deny') return NEVER_WRITTEN;
}
function protectedHomePath(path: string, home: string, writable: string[]): boolean {
  const root = canonicalPath(home, process.cwd());
  path = canonicalPath(path, process.cwd());
  return under(path, root) && !writable.some(p => {
    const allowed = canonicalPath(p, process.cwd());
    return allowed !== root && under(allowed, root) && under(path, allowed);
  });
}
export function protectedPath(path: string, home: string, writable: string[] = []): boolean {
  path = canonicalPath(path, process.cwd());
  return protectedHomePath(path, home, writable) || path.split(sep).some(part => fold(part).startsWith('.env') || ['.git', 'node_modules', '.ssh'].includes(fold(part)));
}
export function shellEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // Explicit inheritance prevents unfamiliar connector keys and runtime injection
  // variables (BASH_ENV, NODE_OPTIONS, etc.) from reaching code children. The
  // daemon applies the same list from credential-policy.json to its children.
  const inherited = new Set((credentialPolicy.environment as string[]).map(name => name.toUpperCase()));
  return Object.fromEntries(Object.entries(env).filter(([name]) => inherited.has(name.toUpperCase()) || /^LC_/i.test(name)));
}

export function escapeMcpValues(values: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value.replace(/\$/g, '$$$$').replace(/^!/, '$!')]));
}
