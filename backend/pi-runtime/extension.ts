/** Hexbot's frozen session tools and approval bridge. Pi owns the agent loop. */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, realpathSync, lstatSync, readlinkSync, statSync, existsSync } from 'node:fs';
import { open, rename, unlink, mkdir, readFile, access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, dirname, basename, relative, sep, join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { createBashTool, createReadTool, createWriteTool, createEditTool, createGrepTool, createFindTool, createLsTool } from '@earendil-works/pi-coding-agent';
import {credentialPolicy, fold, isolatedCommand, isolationAvailable, policyRegex, policyRoots, userHomes, managedRuntimeRoots, requireSupportedExecution, WINDOWS_ISOLATION_UNAVAILABLE, privateKeyName, probeIsolation, readDenied, secretFileName, gitDirectory, SCAN_REASON, SCAN_FILE_REASON, within, workspaceProtected, lockedGit, scanFailureReason} from './isolation.ts';
import { registerAcp } from './acp.ts';
import { lazyStream } from '@earendil-works/pi-ai';
import { builtinProviders } from '@earendil-works/pi-ai/providers/all';

// Replacing the directory entry does not truncate other hard links to its inode.
// This is used only by restricted file tools; Bypass retains upstream behavior.
async function atomicWrite(path: string, content: string): Promise<void> {
  const mode = await stat(path).then(info => info.mode & 0o777, error => {
    if (error.code !== 'ENOENT') throw error;
    return 0o600;
  });
  const temporary = join(dirname(path), `.hexbot-write-${randomUUID()}`);
  const file = await open(temporary, 'wx', mode);
  try {
    await file.writeFile(content, 'utf8');
    await file.sync();
    await file.close();
    await rename(temporary, path);
  } finally {
    await file.close();
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

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
  pi.on('turn_end', async (event: any, ctx: any) => {
    iterations++;
    if (Number.isFinite(maxTurns) && maxTurns > 0 && iterations >= maxTurns && event.message?.stopReason === 'toolUse') {
      limitReached = true;
      await ctx.ui.input('__HEXBOT_TOOL__' + JSON.stringify({name: 'hexbot_turn_limit', args: {limit: maxTurns}}));
      ctx.abort();
    }
  });
  const bridge = async (ctx: any, name: string, args: any = {}) => {
    const raw = await ctx.ui.input('__HEXBOT_TOOL__' + JSON.stringify({name, args}));
    // Stop cancels pending requests; callers skip warnings for it.
    if (!raw) throw Object.assign(new Error('Daemon request interrupted'), {interrupted: true});
    const reply = JSON.parse(raw);
    if (reply.error) throw new Error(reply.error);
    return reply.result;
  };
  let live = config;
  let primary: any;
  // Pi 1.0.1 holds its forced prompt for the whole run. Only adopt a rebuilt
  // prompt if the first request after compaction starts a new run. A resumed
  // request caches the old prompt again, so discard the replacement then.
  let prompt = config.prompt;
  let pendingPrompt: string | undefined;
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
    catch (error: any) { if (!error.interrupted) ctx.ui.notify(`Connected tools are unavailable: ${error.message}`, 'warning'); return; }
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
  // that needs more sets full_access; Auto reviews it before asking the user.
  const workspaceRoots = () => [live.cwd ?? config.cwd, ...live.outputDirs ?? [], tmpdir(), '/tmp'];
  const workspace = () => live.approvalMode === 'manual' ? [] : workspaceRoots();
  const inWorkspace = (path: string) => {
    const target = canonicalPath(path, process.cwd());
    return workspaceRoots().some(root => under(target, canonicalPath(root, process.cwd())));
  };
  type Level = 'none' | 'base' | 'confined';
  type AllowedCall = {mode: string, cwd: string, level: Level, target?: string, overwrites?: boolean};
  const levelFor = (input: any): Level => live.approvalMode === 'off' ? 'none' : input?.full_access === true ? 'base' : 'confined';
  // What the gate allowed for each call: the mode it decided under, how bash
  // runs, and the file it checked. Pi may gate several calls before running
  // them, so execution refuses a call whose mode or target has changed since.
  const allowedCalls = new Map<string, AllowedCall>();
  const wrapped = new Set<string>();
  const sessionAllowed = new Set<string>();
  const gate = async (event: any, ctx: any) => {
    const allowed: AllowedCall = {mode: live.approvalMode, cwd: live.cwd ?? config.cwd, level: levelFor(event.input)};
    const denial = await check(event, ctx, call => Object.assign(allowed, call));
    if (!denial && event.toolCallId && wrapped.has(event.toolName)) allowedCalls.set(event.toolCallId, allowed);
    return denial;
  };
  const check = async (event: any, ctx: any, checked: (call: Partial<AllowedCall>) => void = () => {}) => {
    const browser = event.toolName === 'browser_console' && typeof event.input.expression === 'string';
    const mcp = event.toolName.startsWith('mcp__');
    const resource = ['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource'].includes(event.toolName);
    const script = event.toolName === 'codemode' && typeof event.input?.code === 'string' && config.mcpServers?.length;
    if (!['bash', 'read', 'grep', 'find', 'ls', 'write', 'edit'].includes(event.toolName) && !browser && !mcp && !resource && !script) return;
    try {
      await refresh(ctx);
      // Retain what this check saw, even if another gate refreshes live settings.
      checked({mode: live.approvalMode, cwd: live.cwd ?? config.cwd, level: levelFor(event.input)});
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
      if (process.platform === 'win32' && ['bash', 'read', 'grep', 'find', 'ls', 'write', 'edit'].includes(event.toolName)) {
        // No approvals or remembered grants can bypass an unavailable boundary.
        return {block: true, reason: WINDOWS_ISOLATION_UNAVAILABLE};
      }
      const cwd = live.cwd ?? config.cwd;
      // `once` approvals cannot be remembered for the section.
      let ask: {key: string, command: string, reason: string, once?: boolean} | undefined;
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
        checked({target: path});
        if (credentialPath(resolve(cwd, input), live.home) || credentialPath(path, live.home)) return {block: true, reason: 'Credential files are private.'};
        if (['write', 'edit'].includes(event.toolName)) {
          const scan = workspaceProtected([cwd, ...live.outputDirs ?? []]);
          const denial = writeDenial(input, cwd, live.home, live.outputDirs, scan);
          if (denial) return {block: true, reason: denial};
          if (live.approvalMode === 'manual') ask = {key: 'file', command: path, reason: 'Manual mode asks before every file change.'};
          else if (hostWriteTier(input, cwd) === 'ask') ask = {key: 'file:host-config', command: path, reason: 'This changes a shell profile, login item or other host configuration file.'};
          else if (!inWorkspace(path)) ask = {key: 'file:outside', command: path, reason: 'This changes a file outside the workspace.'};
          // An incomplete scan is about this destination alone, so it asks every
          // time and never widens what the section already allows.
          const uncertain = scan.failure ?? (scan.exhausted ? SCAN_FILE_REASON : undefined);
          if (uncertain) ask = {key: ask?.key ?? 'file:scan', command: path, reason: ask ? `${ask.reason} ${uncertain}` : uncertain, once: true};
        }
      }
      if (event.toolName === 'bash') {
        if (!isolationAvailable()) {
          // Requesting full access cannot bypass the missing-sandbox user card.
          ask = {key: 'shell:unsandboxed', command: event.input.command, reason: 'Hexbot has no OS sandbox on this system, so this command can read and change any file you can. Install bubblewrap and restart the daemon to restore isolation.'};
        } else if (event.input.full_access === true) {
          const why = typeof event.input.reason === 'string' && event.input.reason.trim() ? event.input.reason.trim() : 'No reason given.';
          ask = {key: 'shell:full-access', command: event.input.command, reason: 'Run outside the sandbox, with internet access and writes outside the workspace. ' + why};
        }
      }
      if (process.platform === 'linux' && event.toolName === 'bash' && levelFor(event.input) === 'confined' && isolationAvailable()) {
        try {
          const scan = workspaceProtected([cwd, ...live.outputDirs ?? []]);
          if (scan.exhausted || scan.failure) return {block: true, reason: scan.exhausted ? SCAN_REASON : scanFailureReason(scan)};
          // A missing hooks folder that would pin a whole repository read-only, or a
          // replaceable link to Git metadata, asks instead.
          lockedGit(scan, workspace().filter(existsSync).map(root => realpathSync(root)).filter(root => root !== '/tmp'), true);
        }
        catch (error: any) { return {block: true, reason: error.message}; }
      }
      if (browser) ask = {key: 'browser_console', command: event.input.expression, reason: 'This runs code in a web page.'};
      if (!ask) return;
      if (live.canAsk === false) return {block: true, reason: 'This action needs approval. Run it in a visible section.'};
      const mode = live.approvalMode;
      // In Auto the daemon's reviewer answers routine steps outside the sandbox
      // one at a time, so a grant remembered in another mode does not cover them.
      // Host configuration uses user approvals; incomplete scans ask every time.
      const review = mode === 'smart' && !ask.once && (REVIEWED.includes(ask.key) || ask.key.startsWith('mcp:'));
      if (sessionAllowed.has(ask.key) && !ask.once && !review) return;
      // The reviewer reads the whole input the tool will run with, not the card's preview,
      // and uses the model Pi runs now, which is the fallback after the primary failed.
      const overwrites = review && event.toolName === 'write' ? existsSync(ask.command) : undefined;
      if (overwrites !== undefined) checked({overwrites});
      const model = ctx.model ? {model: {provider: ctx.model.provider, model: ctx.model.id}} : {};
      const reviewed = review ? {review: true, input: event.input, cwd, ...model, ...overwrites !== undefined ? {overwrites} : {}} : {};
      const choice = await ctx.ui.select('__HEXBOT_APPROVAL__' + JSON.stringify({tool: event.toolName, command: ask.command, reason: ask.reason, ...reviewed}),
        ask.once ? ['once', 'deny'] : ['once', 'session', 'deny']);
      if (mcp || review) {
        // Pi emits execution_start before tool_call. Its public API has no MCP
        // execute wrapper; the last blocking hook is this gate. Recheck after UI,
        // and after a review: the user may change the mode or working directory.
        await refresh(ctx);
        if (mode !== live.approvalMode) return {block: true, reason: 'The approval mode changed before this ran. Try again.'};
        if (cwd !== (live.cwd ?? config.cwd)) return {block: true, reason: 'The working directory changed before this ran. Try again.'};
        const reason = mcp && mcpDenial(event.toolName);
        if (reason) return {block: true, reason};
      }
      if (choice === 'session' && !ask.once && !review) sessionAllowed.add(ask.key);
      else if (choice !== 'once' && choice !== 'session') return {block: true, reason: 'The user denied this action.'};
    } catch {
      return {block: true, reason: 'The approval settings could not be checked. Try again.'};
    }
  };
  // The user's own commands and the code runtime's terminal have no full_access.
  const spawnFor = (level: Level, command: string) => level === 'none' ? command :
    isolatedCommand(command, live.home, live.outputDirs, level === 'confined' ? workspace() : undefined, [live.cwd ?? config.cwd, ...live.outputDirs ?? []]);
  const sandboxNote = () => live.approvalMode === 'manual'
    ? '[The command ran in the read-only sandbox, without internet access. If it failed for that reason, run it again with full_access and a reason.]'
    : `[The command ran in the sandbox, without internet access and with writes only in ${live.cwd ?? config.cwd}, its output folders, and temporary folders. If it failed for that reason, run it again with full_access and a reason.]`;

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
    const options = (level: Level = 'confined', denied?: string[]) => name === 'bash' ? {spawnHook: (c: any) => level === 'none' ? c : {...c, command: spawnFor(level, c.command), env: shellEnvironment(c.env)}} :
      name === 'write' && !bypass() ? {operations: {writeFile: atomicWrite, mkdir: (path: string) => mkdir(path, {recursive:true}).then(() => {})}} :
      name === 'edit' && !bypass() ? {operations: {writeFile: atomicWrite, readFile, access: (path: string) => access(path, constants.R_OK | constants.W_OK)}} :
      name === 'grep' && !bypass() ? {operations: {isDirectory: (path: string) => statSync(path).isDirectory(), readFile: (path: string) => credentialPath(path, live.home, denied) ? '' : readFileSync(path, 'utf8')}} : {};
    const tool = factory(config.cwd, options());
    const definition = name === 'bash' ? {
      description: tool.description + (process.platform === 'win32'
        ? ' Windows is unsupported: Auto and Manual refuse local tools, including full_access. In Bypass this is Pi\'s Bash shell, such as Git Bash, with no sandbox. Use Bash syntax, not cmd.exe or PowerShell syntax.'
        : ' Commands may run in a sandbox that blocks internet access and writes outside the workspace. When a command needs either, set full_access and give a reason.'),
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
      if (!bypass()) requireSupportedExecution();
      if (!allowed || allowed.mode !== live.approvalMode) throw new Error('The approval mode changed before this ran. Try again.');
      if (allowed.cwd !== (live.cwd ?? config.cwd)) throw new Error('The working directory changed before this ran. Try again.');
      const cwd = live.cwd ?? config.cwd;
      // Recheck at execution too, before a factory can touch files or launch.
      if (!bypass()) requireSupportedExecution();
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
      if (['write', 'edit'].includes(name)) {
        // The approval covered the file the gate resolved, not a link swapped in since.
        if (path !== allowed.target) throw new Error('The file changed after it was checked. Try again.');
        if (allowed.overwrites !== undefined && existsSync(path) !== allowed.overwrites) throw new Error('The file changed after it was reviewed. Try again.');
        const denial = writeDenial(args.path ?? '.', cwd, live.home, live.outputDirs);
        if (denial) throw new Error(denial);
      }
      args = {...args, path};
      // Reuse the same read-deny roots for every candidate and the output filter.
      const denied = readDenied();
      // Avoid streaming unfiltered search output.
      const result = await factory(cwd, options('confined', denied)).execute(id, args, signal, ['grep', 'find', 'ls'].includes(name) ? undefined : update);
      if (['grep', 'find', 'ls'].includes(name)) {
        const base = statSync(path).isDirectory() ? path : dirname(path);
        return sanitizeSearchResult(result, name, base, live.home, denied);
      }
      return result;
    }});
  }
  pi.on('user_bash', async (event: any, ctx: any) => {
    const denial = await gate({toolName: 'bash', input: {command: event.command}}, ctx);
    if (denial) return {result: {output: denial.reason, exitCode: 1, cancelled: false, truncated: false}};
    const level = levelFor({});
    const approvedCwd = live.cwd ?? config.cwd;
    return {operations: {exec: async (command: string, cwd: string, opts: any) => {
      await refresh(ctx);
      if (level !== levelFor({}) || approvedCwd !== (live.cwd ?? config.cwd)) throw new Error('The approval mode or working directory changed before this ran. Try again.');
      if (level !== 'none') requireSupportedExecution();
      const {createLocalBashOperations} = await import('@earendil-works/pi-coding-agent');
      if (level === 'none') return createLocalBashOperations().exec(command, live.cwd ?? cwd, opts);
      return createLocalBashOperations().exec(spawnFor(level, command), live.cwd ?? cwd, {...opts, env: shellEnvironment(opts.env ?? process.env)});
    }}};
  });

  pi.on('before_provider_request', async (event: any, ctx: any) => {
    pendingPrompt = undefined;
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
    // Pi 1.0.1 drops the result of a handler that throws and runs on its
    // launch prompt, which is stale once a section adopts a refreshed one.
    // Whatever fails here, still return the prompt Pi is running.
    try {
      await refresh(ctx);
      await registerMcp(ctx);
      primary ??= ctx.model;
      const model = ctx.modelRegistry.find(live.provider, live.model) ?? primary;
      if (model && (ctx.model?.provider !== model.provider || ctx.model?.id !== model.id)) await pi.setModel(model);
    } catch (error: any) {
      if (!error?.interrupted) ctx.ui.notify(`Could not load this bot's latest settings, so this message uses the previous ones.\n${error?.message ?? error}`, 'warning');
    }
    fallbackUsed = false; iterations = 0; limitReached = false;

    if (pendingPrompt !== undefined) {
      // The daemon saves the prompt as our adoption arrives, before an
      // interrupt can cancel it, so a reopened section starts on the prompt
      // Pi used. Switch unless it refuses: an interrupted or lost reply means
      // it was saved. A refused offer waits for the next compaction.
      const adopt = createHash('sha256').update(pendingPrompt).digest('hex');
      let reply: any;
      try {
        const raw = await ctx.ui.input('__HEXBOT_TOOL__' + JSON.stringify({name: 'hexbot_session_prompt', args: {adopt}}));
        if (raw) reply = JSON.parse(raw);
      } catch {}
      if (!reply?.error) prompt = pendingPrompt;
      pendingPrompt = undefined;
    }

    // What the primary bot said here from check-ins, while the user was away.
    // Pi adds it after the user's message, so the cached prefix stays intact.
    if (live.pendingCheckins === true) {
      try {
        const checkins = await bridge(ctx, 'hexbot_checkin_context');
        if (typeof checkins?.text === 'string' && checkins.text) {
          // The ids come back on message_end, which tells the daemon Pi has it.
          return {systemPrompt: prompt, message: {customType: 'hexbot_checkin', content: checkins.text, display: false, details: {checkins: checkins.ids ?? []}}};
        }
      } catch {}
    }
    return {systemPrompt: prompt};
  });
  pi.on('session_compact', async (_event: any, ctx: any) => {
    pendingPrompt = undefined;
    // The todo list and the prompt are two requests; one failing or empty
    // never stops the other.
    try {
      const todo = await bridge(ctx, 'hexbot_todo_context');
      if (todo?.text) pi.sendMessage({customType: 'hexbot_todo', content: todo.text, display: false});
    } catch {}
    // Compare with the live prompt: an earlier offer may have been lost, or a
    // mid-run request discarded it.
    try {
      const current = createHash('sha256').update(prompt).digest('hex');
      const fresh = await bridge(ctx, 'hexbot_session_prompt', {current});
      if (typeof fresh?.text === 'string' && fresh.text) pendingPrompt = fresh.text;
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

// Filenames can contain grep's line delimiters too (for example owl-2-beta).
// Check every possible path prefix, including text nested in truncation details.
export function sanitizeSearchResult(value: any, name: string, base: string, home: string, denied = readDenied()): any {
  if (typeof value === 'string') return value.split('\n').filter(line => {
    const paths = name === 'grep' ? [...line.matchAll(/(:\d+:|-\d+-)/g)].map(match => line.slice(0, match.index)) : [line.replace(/\/$/, '')];
    return !paths.some(path => credentialPath(resolve(base, path), home, denied) || credentialPath(canonicalPath(path, base), home, denied));
  }).join('\n');
  if (Array.isArray(value)) return value.map(part => sanitizeSearchResult(part, name, base, home, denied));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, part]) => [key, sanitizeSearchResult(part, name, base, home, denied)]));
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
  // The Unix component walker is not a Windows handle-based file boundary.
  // Refuse drive-relative, UNC, device, ADS and reparse paths alike until one exists.
  requireSupportedExecution();
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
export function credentialPath(path: string, home: string, denied = readDenied()): boolean {
  const lexical = resolve(path);
  path = canonicalPath(path, process.cwd());
  if (lexical !== path && credentialName(lexical, home, denied)) return true;
  return credentialName(path, home, denied);
}
function credentialName(path: string, home: string, denied: string[]): boolean {
  for (const ssh of userHomes().flatMap(user => [join(user, '.ssh'), canonicalPath(join(user, '.ssh'), process.cwd())])) {
    if (under(path, ssh) && (fold(dirname(path)) !== fold(ssh) || privateKeyName(basename(path)))) return true;
  }
  if (userHomes().some(user => credentialPolicy.user.some((local: string) => {
    const secret = join(user, local);
    return under(path, secret) || under(path, canonicalPath(secret, process.cwd()));
  }))) return true;
  // Credential stores such as ~/.aws and ~/.netrc are private to reads too.
  if ((credentialPolicy.write.deny as string[]).flatMap(policyRoots).some(store => {
    return under(path, store) || under(path, canonicalPath(store, process.cwd()));
  })) return true;
  if (denied.some(store => under(path, store))) return true;
  const name = basename(path);
  if (secretFileName(name)) {
    try { if (!statSync(path).isDirectory()) return true; } catch { return true; }
  }

  if (!home) throw new Error('Hexbot home is unavailable');
  const root = under(path, resolve(home)) ? resolve(home) : canonicalPath(home, process.cwd());
  const local = relative(fold(root), fold(path)).split(sep).join('/');
  return !local.startsWith('../') && (policyRegex(credentialPolicy.basename).test(name) || policyRegex(credentialPolicy.home).test(local));
}
// Steps outside the sandbox that Auto's reviewer may let through; connected tools too.
const REVIEWED = ['shell:full-access', 'file:outside', 'browser_console'];
const NEVER_WRITTEN = 'Credential and system configuration files are never written by tools.';
// credential-policy.json "write": deny entries are credential stores that tools
// never write; ask entries (shell profiles, login items) prompt in Manual and
// Auto; fileDeny entries (system configuration) are denied to the file tools.
export function hostWriteTier(input: string, cwd: string, fileTool = false): 'deny' | 'ask' | undefined {
  const targets = [resolve(cwd, expandHome(input)), canonicalPath(input, cwd)];
  const tiers = [['deny', 'deny'], [fileTool ? 'deny' : 'ask', 'fileDeny'], ['ask', 'ask']] as const;
  for (const [tier, list] of tiers) {
    for (const root of (credentialPolicy.write[list] as string[]).flatMap(policyRoots)) {
      if (targets.some(target => under(target, root) || under(target, canonicalPath(root, cwd)))) return tier;
    }
  }
}
// Inside the home only the daemon-chosen output folders are writable, never the cwd.
export function writeDenial(input: string, cwd: string, home: string, outputs: string[] = [], scan = workspaceProtected([cwd, ...outputs])): string | undefined {
  const path = canonicalPath(input, cwd);
  for (let parent = path; dirname(parent) !== parent; parent = dirname(parent)) {
    if (gitDirectory(parent)) return 'Git metadata is read-only. Use an approved full_access command.';
  }
  // A repository config can name any folder as its hooks path. One that holds a
  // writable root (hooksPath = / or the home) would refuse every write, so it is
  // ignored here as it is in the sandboxes; the folders it can name outside the
  // workspace stay refused.
  const roots = [cwd, ...outputs, tmpdir(), '/tmp'].map(root => canonicalPath(root, cwd));
  const git = scan.git.filter(target => !roots.some(root => within(root, [target]) && fold(root) !== fold(target)));
  if (git.some(root => under(path, root) || under(root, path))) return 'Git metadata is read-only. Use an approved full_access command.';
  if (protectedPath(path, home, outputs)) return 'This path is protected. Use the soul or memory tool for bot notes.';
  if (hostWriteTier(input, cwd, true) === 'deny') return NEVER_WRITTEN;
}
function protectedHomePath(path: string, home: string, writable: string[]): boolean {
  const root = canonicalPath(home, process.cwd());
  path = canonicalPath(path, process.cwd());
  // Runtime selection and immutable builds must never become an output exception.
  if (managedRuntimeRoots(home).some(managed => under(path, managed) || under(managed, path))) return true;
  return under(path, root) && !writable.some(p => {
    const allowed = canonicalPath(p, process.cwd());
    return allowed !== root && under(allowed, root) && under(path, allowed);
  });
}
export function protectedPath(path: string, home: string, writable: string[] = []): boolean {
  path = canonicalPath(path, process.cwd());
  return protectedHomePath(path, home, writable) || path.split(sep).some(part => secretFileName(part) || ['.git', 'node_modules', '.ssh'].includes(fold(part)));
}
export function shellEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // Explicit inheritance prevents unfamiliar connector keys and runtime injection
  // variables (BASH_ENV, NODE_OPTIONS, etc.) from reaching code children. The
  // daemon applies the same list from credential-policy.json to its children.
  const inherited = new Set((credentialPolicy.environment as string[]).map(name => name.toUpperCase()));
  if (process.platform === 'win32') for (const name of credentialPolicy.windowsEnvironment) inherited.add(name.toUpperCase());
  return Object.fromEntries(Object.entries(env).filter(([name]) => inherited.has(name.toUpperCase()) || /^LC_/i.test(name)));
}

export function escapeMcpValues(values: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value.replace(/\$/g, '$$$$').replace(/^!/, '$!')]));
}
