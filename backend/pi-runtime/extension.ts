/** Hexbot's frozen session tools and approval bridge. Pi owns the agent loop. */
import { readFileSync, realpathSync, lstatSync, readlinkSync, statSync } from 'node:fs';
import { resolve, dirname, basename, relative, sep, join, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { createBashTool, createReadTool, createWriteTool, createEditTool, createGrepTool, createFindTool, createLsTool } from '@earendil-works/pi-coding-agent';
import {credentialPolicy, fold, isolatedCommand, isolationAvailable, policyRegex, policyRoot, privateKeyName, probeIsolation} from './isolation.ts';
import { registerAcp } from './acp.ts';
import { lazyStream } from '@earendil-works/pi-ai';
import { builtinProviders } from '@earendil-works/pi-ai/providers/all';

export default function hexbot(pi: any) {
  probeIsolation();
  const config = JSON.parse(readFileSync(process.env.HEXBOT_SESSION_CONFIG!, 'utf8'));
  let currentContext: any;
  pi.on('session_start', async (_event: any, ctx: any) => { currentContext = ctx; });
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
  const allowed = new Set<string>();
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
    if (!raw) throw new Error('Daemon request interrupted');
    const reply = JSON.parse(raw);
    if (reply.error) throw new Error(reply.error);
    return reply.result;
  };
  let live = config;
  let primary: any;
  const refresh = async (ctx: any) => { live = {...config, ...await bridge(ctx, 'hexbot_session_settings')}; };
  const gate = async (event: any, ctx: any) => {
    if (!['bash', 'read', 'grep', 'find', 'ls', 'write', 'edit'].includes(event.toolName) && !(event.toolName === 'browser_console' && typeof event.input.expression === 'string')) return;
    try {
      await refresh(ctx);
      const cwd = live.cwd ?? config.cwd;
      const home = live.home;
      let patterns: string[] = [];
      let reason = 'This action matches a dangerous command or executes code in a page.';
      if (['read', 'grep', 'find', 'ls', 'write', 'edit'].includes(event.toolName)) {
        const path = canonicalPath(event.input.path ?? '.', cwd);
        if (credentialPath(resolve(cwd, event.input.path ?? '.'), home) || credentialPath(path, home)) return {block: true, reason: 'Credential files are private.'};
        if (['write', 'edit'].includes(event.toolName)) {
          const denial = writeDenial(event.input.path ?? '.', cwd, home, live.approvalMode, live.outputDirs);
          if (denial) return {block: true, reason: denial};
          if (live.approvalMode !== 'off' && hostWriteTier(event.input.path ?? '.', cwd) === 'ask') {
            patterns = [HOST_CONFIG_WRITE];
            reason = 'This writes a shell profile, login item, or other host configuration file.';
          }
        }
      }
      if (event.toolName === 'bash') {
        const blocked = hardlineCommand(event.input.command, cwd);
        if (blocked) return {block: true, reason: 'Command blocked: ' + blocked};
        patterns = dangerousCommand(event.input.command, home, cwd);
        if (patterns.includes(CREDENTIAL_STORE)) reason = 'This command names a credential store, which a program it starts could read or create.';
      }
      if (event.toolName === 'browser_console' && typeof event.input.expression === 'string') patterns = ['browser_console:expression'];
      if (live.approvalMode === 'off') return;
      // Without an OS sandbox a shell command can read every file the user can, so
      // Manual asks every time and Auto never decides alone. Only the user's own
      // "session" choice can quiet it; the daemon never stores it as "always".
      const unsandboxed = event.toolName === 'bash' && !isolationAvailable();
      if (unsandboxed) {
        patterns = [UNSANDBOXED, ...patterns];
        reason = 'Hexbot has no OS sandbox on this system, so this command can read any file you can, including credentials. Install bubblewrap and restart the daemon to restore isolation. Always allow covers the current section only.';
      }
      if (!patterns.length) return;
      if (patterns.every(key => allowed.has(key) || key !== UNSANDBOXED && live.allowedPatterns?.includes(key))) return;
      let smartDenied = false;
      if (live.approvalMode === 'smart' && !unsandboxed) {
        try {
          if ((await bridge(ctx, 'hexbot_auto_approve', {tool: event.toolName, input: event.input})).approved === true) return;
        } catch {}
        smartDenied = true;
      }
      const choice = await ctx.ui.select('__HEXBOT_APPROVAL__' + JSON.stringify({
        tool: event.toolName, command: JSON.stringify(event.input), reason, smart_denied: smartDenied
      }), ['once', 'session', 'always', 'deny']);
      if (!['once', 'session', 'always'].includes(choice)) return {block: true, reason: 'The user denied this action.'};
      if (choice === 'session') patterns.forEach(key => allowed.add(key));
      if (choice === 'always') {
        if (unsandboxed) allowed.add(UNSANDBOXED);
        const stored = patterns.filter(key => key !== UNSANDBOXED);
        if (stored.length) await bridge(ctx, 'hexbot_allow_patterns', {patterns: stored});
      }
    } catch {
      return {block: true, reason: 'The approval settings could not be checked. Try again.'};
    }
  };

  // Keep the built-in schemas and select tools only from the frozen configuration.
  // Refresh cwd at execution time without rewriting the cached prompt or history.
  const factories: any = {bash: createBashTool, read: createReadTool, write: createWriteTool, edit: createEditTool, grep: createGrepTool, find: createFindTool, ls: createLsTool};
  const enabled = (name: string) => Array.isArray(config.restricted) ? config.restricted.includes(name) :
    config.enabledToolsets?.includes(name === 'bash' ? 'terminal' : 'file');
  for (const [name, factory] of Object.entries(factories) as [string, any][]) {
    if (!enabled(name)) continue;
    const options = () => name === 'bash' ? {spawnHook: (c: any) => { const reason = hardlineCommand(c.command, c.cwd); if (reason) throw new Error('Command blocked: ' + reason); return {...c, command: isolatedCommand(c.command, live.home, live.outputDirs), env: shellEnvironment(c.env)}; }} :
      name === 'grep' ? {operations: {isDirectory: (path: string) => statSync(path).isDirectory(), readFile: (path: string) => credentialPath(path, live.home) ? '' : readFileSync(path, 'utf8')}} : {};
    const tool = factory(config.cwd, options());
    pi.registerTool({...tool, async execute(id: string, args: any, signal: any, update: any) {
      // Pass the checked canonical target to Pi too: its lexical normalization
      // of '..' must not select a different file after a symlink was checked.
      if (name !== 'bash') {
        const path = canonicalPath(args.path ?? '.', live.cwd ?? config.cwd);
        if (credentialPath(resolve(live.cwd ?? config.cwd, args.path ?? '.'), live.home) || credentialPath(path, live.home)) throw new Error('Credential files are private.');
        if (['write', 'edit'].includes(name)) {
          const denial = writeDenial(args.path ?? '.', live.cwd ?? config.cwd, live.home, live.approvalMode, live.outputDirs);
          if (denial) throw new Error(denial);
        }
        args = {...args, path};
      }
      // Avoid streaming unfiltered search output.
      const result = await factory(live.cwd ?? config.cwd, options()).execute(id, args, signal, ['grep', 'find', 'ls'].includes(name) ? undefined : update);
      if (['grep', 'find', 'ls'].includes(name)) {
        const search = canonicalPath(args.path ?? '.', live.cwd ?? config.cwd);
        const base = statSync(search).isDirectory() ? search : dirname(search);
        return sanitizeSearchResult(result, name, base, live.home);
      }
      return result;
    }});
  }
  pi.on('user_bash', async (event: any, ctx: any) => {
    const denial = await gate({toolName: 'bash', input: {command: event.command}}, ctx);
    if (denial) return {result: {output: denial.reason, exitCode: 1, cancelled: false, truncated: false}};
    return {operations: {exec: async (command: string, cwd: string, opts: any) => {
      const {createLocalBashOperations} = await import('@earendil-works/pi-coding-agent');
      const reason = hardlineCommand(command, live.cwd ?? cwd);
      if (reason) throw new Error('Command blocked: ' + reason);
      return createLocalBashOperations().exec(isolatedCommand(command, live.home, live.outputDirs), live.cwd ?? cwd, {...opts, env: shellEnvironment(opts.env ?? process.env)});
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
    primary ??= ctx.model;
    const model = ctx.modelRegistry.find(live.provider, live.model) ?? primary;
    if (model && (ctx.model?.provider !== model.provider || ctx.model?.id !== model.id)) await pi.setModel(model);
    fallbackUsed = false; iterations = 0; limitReached = false;
    return {systemPrompt: config.prompt};
  });
  pi.on('session_compact', async (_event: any, ctx: any) => {
    const raw = await ctx.ui.input('__HEXBOT_TOOL__' + JSON.stringify({name: 'hexbot_todo_context', args: {}}));
    if (!raw) return;
    const reply = JSON.parse(raw);
    if (reply.result?.text) pi.sendMessage({customType: 'hexbot_todo', content: reply.result.text, display: false});
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

// Ported from tools/approval.py DANGEROUS_PATTERNS, plus the stock permission gate.
// The optional third field routes a pattern by a stable id rather than its
// description: ssh and heredoc patterns apply only when the scanner agrees,
// host-config and login-item share the host configuration key when a command
// writes such a path, and sudo and world-writable patterns share one key each.
type Route = 'ssh' | 'login-item' | 'heredoc' | 'host-config' | 'sudo' | 'world-writable';
const dangerousPatterns: [string, string, Route?][] = [
  [
    "\\brm\\s+(-[^\\s]*\\s+)*/",
    "delete in root path"
  ],
  [
    "\\brm\\s+-[^\\s]*r",
    "recursive delete"
  ],
  [
    "\\brm\\s+--recursive\\b",
    "recursive delete (long flag)"
  ],
  [
    "\\brm\\s+(?!--(?:\\s|$))(?:(?!\\s--(?:\\s|$))[^\\n\"\\';|&])*\\s(?:-[a-z]*r[a-z]*\\b|--recursive\\b)",
    "recursive delete (flags after operands)"
  ],
  [
    "\\bcmd(?:\\.exe)?\\s+/(?:c|k)\\s+.*\\b(?:del|erase|rd|rmdir)\\b",
    "Windows cmd destructive delete"
  ],
  [
    "\\b(?:powershell|pwsh)(?:\\.exe)?\\b(?:\\s+-\\S+)*\\s+(?:-(?:command|c)\\s+)?[\"\\']?(?:remove-item|rmdir|erase|del|rd|ri|rm)\\b",
    "Windows PowerShell destructive delete"
  ],
  [
    "\\b(?:powershell|pwsh)(?:\\.exe)?\\b.*\\s-(?:encodedcommand|enc|e)\\b",
    "PowerShell encoded command execution"
  ],
  [
    "\\bremove-item\\b[^\\n;|&]*\\s-(?:recurse|force)\\b",
    "PowerShell destructive delete (Remove-Item)"
  ],
  [
    "\\b(?:del|erase|rd|rmdir)\\s+(?:/[a-z]\\s+)*/[sq]\\b",
    "Windows destructive delete (recursive/quiet switch)"
  ],
  [
    "\\b(?:iwr|invoke-webrequest|invoke-restmethod|irm|curl|wget)\\b[^\\n]*\\|\\s*(?:iex|invoke-expression)\\b",
    "pipe remote content to PowerShell (iwr | iex)"
  ],
  [
    "\\b(?:iex|invoke-expression)\\s*\\(\\s*(?:iwr|invoke-webrequest|invoke-restmethod|irm)\\b",
    "execute remote content via Invoke-Expression"
  ],
  [
    "\\btaskkill\\b[^\\n]*\\s/f\\b",
    "force kill processes (taskkill /F)"
  ],
  [
    "\\bstop-process\\b[^\\n]*\\s-force\\b",
    "force kill processes (Stop-Process -Force)"
  ],
  [
    "\\bformat-volume\\b",
    "format filesystem (Format-Volume)"
  ],
  [
    "\\bclear-disk\\b",
    "wipe disk (Clear-Disk)"
  ],
  [
    "\\bdiskpart\\b",
    "disk partitioning (diskpart)"
  ],
  [
    "\\bformat(?:\\.com)?\\s+[a-z]:",
    "format drive (format.com)"
  ],
  [
    "\\bcipher\\s+/w\\b",
    "wipe free space (cipher /w)"
  ],
  [
    "\\bicacls\\b[^\\n]*\\s/grant\\b[^\\n]*\\b(?:everyone|todos|jeder|tout\\s+le\\s+monde|\\*s-1-1-0)\\b",
    "grant Everyone access (icacls)"
  ],
  [
    "\\bicacls\\b[^\\n]*\\s/reset\\b",
    "reset ACLs recursively (icacls /reset)"
  ],
  [
    "\\bvssadmin\\b[^\\n]*\\bdelete\\s+shadows\\b",
    "delete volume shadow copies (vssadmin)"
  ],
  [
    "\\bwbadmin\\b[^\\n]*\\bdelete\\b",
    "delete backups (wbadmin)"
  ],
  [
    "\\bbcdedit\\b[^\\n]*\\s/set\\b",
    "modify boot configuration (bcdedit /set)"
  ],
  [
    "\\breg(?:\\.exe)?\\s+delete\\b",
    "registry delete (reg delete)"
  ],
  [
    "\\bremove-itemproperty\\b[^\\n]*\\s-force\\b",
    "registry value delete (Remove-ItemProperty -Force)"
  ],
  [
    "\\bstop-service\\b[^\\n]*\\s-force\\b",
    "force stop service (Stop-Service -Force)"
  ],
  [
    "\\bsc(?:\\.exe)?\\s+(?:stop|delete)\\b",
    "stop/delete service (sc)"
  ],
  [
    "\\busers[\\\\/][^\\\\/\\s]+[\\\\/]\\.ssh\\b",
    "access to SSH keys (Windows path)"
  ],
  [
    "\\bappdata[\\\\/](?:local|roaming)[\\\\/]hermes[^\\n]*\\.env\\b",
    "access to Hexbot secrets (Windows path)"
  ],
  [
    "\\bchmod\\s+(-[^\\s]*\\s+)*(777|666|o\\+[rwx]*w|a\\+[rwx]*w)\\b",
    "world/other-writable permissions",
    "world-writable"
  ],
  [
    "\\bchmod\\s+--recursive\\b.*(777|666|o\\+[rwx]*w|a\\+[rwx]*w)",
    "recursive world/other-writable (long flag)",
    "world-writable"
  ],
  [
    "\\bchown\\s+(-[^\\s]*)?R\\s+root",
    "recursive chown to root"
  ],
  [
    "\\bchown\\s+--recur[a-z]*\\b.*root",
    "recursive chown to root (long flag)"
  ],
  [
    "(?:^|[\\n`]|\\$\\()\\s*(?:sudo\\s+(?:-[^\\s]+\\s+)*)?(?:env\\s+(?:\\w+=\\S*\\s+)*)?(?:(?:exec|nohup|setsid|time)\\s+)*\\s*mkfs\\b",
    "format filesystem"
  ],
  [
    "(?:^|[\\n`]|\\$\\()\\s*(?:sudo\\s+(?:-[^\\s]+\\s+)*)?(?:env\\s+(?:\\w+=\\S*\\s+)*)?(?:(?:exec|nohup|setsid|time)\\s+)*\\s*dd\\s+.*if=",
    "disk copy"
  ],
  [
    ">\\s*/dev/sd",
    "write to block device"
  ],
  [
    "\\bDROP\\s+(TABLE|DATABASE)\\b",
    "SQL DROP"
  ],
  [
    "\\bDELETE\\s+FROM\\b(?![^\\n]*\\bWHERE\\b)",
    "SQL DELETE without WHERE"
  ],
  [
    "\\bTRUNCATE\\s+(TABLE)?\\s*\\w",
    "SQL TRUNCATE"
  ],
  [
    ">\\s*(?:/etc/|/private/(?:etc|var|tmp|home)/)",
    "overwrite system config",
    "host-config"
  ],
  [
    "\\bsystemctl\\s+(-[^\\s]+\\s+)*(stop|restart|disable|mask)\\b",
    "stop/restart system service"
  ],
  [
    "\\bkill\\s+-9\\s+-1\\b",
    "kill all processes"
  ],
  [
    "\\bpkill\\s+-9\\b",
    "force kill processes"
  ],
  [
    "\\bkillall\\s+(-[^\\s]*\\s+)*-(9|KILL|SIGKILL)\\b",
    "force kill processes (killall -KILL)"
  ],
  [
    "\\bkillall\\s+(-[^\\s]*\\s+)*-s\\s+(KILL|SIGKILL|9)\\b",
    "force kill processes (killall -s KILL)"
  ],
  [
    "\\bkillall\\s+(-[^\\s]*\\s+)*-r\\b",
    "kill processes by regex (killall -r)"
  ],
  [
    ":\\(\\)\\s*\\{\\s*:\\s*\\|\\s*:\\s*&\\s*\\}\\s*;\\s*:",
    "fork bomb"
  ],
  [
    "\\b(curl|wget)\\b.*\\|\\s*(?:[/\\w]*/)?(?:ba)?sh(?:\\s|$|-c)",
    "pipe remote content to shell"
  ],
  [
    "\\b(bash|sh|zsh|ksh)\\s+<\\s*<?\\s*\\(\\s*(curl|wget)\\b",
    "execute remote script via process substitution"
  ],
  [
    "(?:\\beval\\b|\\bsource\\b|\\.)\\s*(?:\\$\\(\\s*|`\\s*)(?:curl|wget)\\b",
    "execute remote content via command substitution"
  ],
  [
    "\\b(base64|base32|base16)\\s+(?:-[dD]|--decode)\\b.*\\|\\s*\\b(bash|sh|zsh|ksh|dash)\\b",
    "pipe decoded content to shell (possible command obfuscation)"
  ],
  [
    "\\bxxd\\s+-r\\b.*\\|\\s*\\b(bash|sh|zsh|ksh|dash)\\b",
    "pipe xxd-decoded content to shell (possible command obfuscation)"
  ],
  [
    "\\becho\\b[^|]*\\|\\s*\\btr\\b[^|]*\\|\\s*\\b(bash|sh|zsh|ksh|dash)\\b",
    "pipe tr-transformed output to shell (possible command obfuscation)"
  ],
  [
    "\\bopenssl\\b.*\\b(?:base64|enc)\\b[^|]*\\s+-[dD]\\b[^|]*\\|\\s*\\b(bash|sh|zsh|ksh|dash)\\b",
    "pipe openssl-decoded content to shell (possible command obfuscation)"
  ],
  [
    "\\btee\\b.*[\"\\']?(?:(?:/etc/|/private/(?:etc|var|tmp|home)/)|/dev/sd|(?:~|\\$home|\\$\\{home\\})/\\.ssh(?:/|$)|(?:~\\/\\.(?:hermes|hexbot)/|(?:\\$home|\\$\\{home\\})/\\.(?:hermes|hexbot)/|(?:\\$(?:hermes|hexbot)_home|\\$\\{(?:hermes|hexbot)_home\\})/)\\.env\\b|(?:~\\/\\.(?:hermes|hexbot)/|(?:\\$home|\\$\\{home\\})/\\.(?:hermes|hexbot)/|(?:\\$(?:hermes|hexbot)_home|\\$\\{(?:hermes|hexbot)_home\\})/)config\\.yaml\\b|(?:~|\\$home|\\$\\{home\\})/\\.(?:bashrc|zshrc|profile|bash_profile|zprofile)\\b|(?:~|\\$home|\\$\\{home\\})/\\.(?:netrc|pgpass|npmrc|pypirc)\\b)",
    "overwrite system file via tee",
    "host-config"
  ],
  [
    ">>?\\s*[\"\\']?(?:(?:/etc/|/private/(?:etc|var|tmp|home)/)|/dev/sd|(?:~|\\$home|\\$\\{home\\})/\\.ssh(?:/|$)|(?:~\\/\\.(?:hermes|hexbot)/|(?:\\$home|\\$\\{home\\})/\\.(?:hermes|hexbot)/|(?:\\$(?:hermes|hexbot)_home|\\$\\{(?:hermes|hexbot)_home\\})/)\\.env\\b|(?:~\\/\\.(?:hermes|hexbot)/|(?:\\$home|\\$\\{home\\})/\\.(?:hermes|hexbot)/|(?:\\$(?:hermes|hexbot)_home|\\$\\{(?:hermes|hexbot)_home\\})/)config\\.yaml\\b|(?:~|\\$home|\\$\\{home\\})/\\.(?:bashrc|zshrc|profile|bash_profile|zprofile)\\b|(?:~|\\$home|\\$\\{home\\})/\\.(?:netrc|pgpass|npmrc|pypirc)\\b)",
    "overwrite system file via redirection",
    "host-config"
  ],
  [
    "\\btee\\b.*[\"\\']?(?:(?:(?:/|\\.{1,2}/)?(?:[^\\s/\"\\'`]+/)*\\.env(?:\\.[^/\\s\"\\'`]+)*)|(?:(?:/|\\.{1,2}/)?(?:[^\\s/\"\\'`]+/)*config\\.yaml))[\"\\']?(?=[\\s;&|<>\"\\']|$)",
    "overwrite project env/config via tee"
  ],
  [
    ">>?\\s*[\"\\']?(?:(?:(?:/|\\.{1,2}/)?(?:[^\\s/\"\\'`]+/)*\\.env(?:\\.[^/\\s\"\\'`]+)*)|(?:(?:/|\\.{1,2}/)?(?:[^\\s/\"\\'`]+/)*config\\.yaml))[\"\\']?(?=[\\s;&|<>\"\\']|$)",
    "overwrite project env/config via redirection"
  ],
  [
    "\\bxargs\\s+.*\\brm\\b",
    "xargs with rm"
  ],
  [
    "\\bfind\\b.*-exec(?:dir)?\\s+(/\\S*/)?rm\\b",
    "find -exec/-execdir rm"
  ],
  [
    "\\bfind\\b.*-delete\\b",
    "find -delete"
  ],
  [
    "\\b(?:hermes|hexbot\\s+(?:core|hermes))\\s+(?:-{1,2}\\S+(?:\\s+\\S+)?\\s+)*gateway\\s+(stop|restart)\\b",
    "stop/restart Hexbot daemon (kills running agents)"
  ],
  [
    "\\b(?:hermes|hexbot\\s+(?:core|hermes))\\s+update\\b",
    "Hexbot update (restarts gateway, kills running agents)"
  ],
  [
    "\\bdocker\\s+(?:-{1,2}\\S+(?:[=\\s]\\S+)?\\s+)*(?:-h|--host)[=\\s]+\\S+",
    "docker with remote daemon redirect (-H/--host)"
  ],
  [
    "\\bdocker\\s+(?:-{1,2}\\S+(?:[=\\s]\\S+)?\\s+)*(?:-c|--context)[=\\s]+\\S+",
    "docker with daemon redirect (--context: alternate daemon)"
  ],
  [
    "\\bdocker\\s+context\\s+use\\b",
    "docker context use (switches default daemon for future commands)"
  ],
  [
    "\\bpodman\\s+(?:-{1,2}\\S+(?:[=\\s]\\S+)?\\s+)*(?:--url|--connection|--identity)[=\\s]+\\S+",
    "podman with remote daemon redirect (--url/--connection/--identity)"
  ],
  [
    "\\bpodman\\s+(?:-{1,2}\\S+(?:[=\\s]\\S+)?\\s+)*(?:-r\\b|--remote\\b)",
    "podman remote mode (-r/--remote: remote daemon)"
  ],
  [
    "\\b(?:docker_host|docker_context|container_host|container_connection)=\\S+",
    "docker/podman daemon redirect via environment (DOCKER_HOST/CONTAINER_HOST)"
  ],
  [
    "\\bdocker(?:-compose|\\s+compose)\\s+(?:-{1,2}\\S+(?:[=\\s]\\S+)?\\s+)*(restart|stop|kill|down)\\b",
    "docker compose restart/stop/kill/down (container lifecycle)"
  ],
  [
    "\\bdocker\\s+(?:-{1,2}\\S+(?:[=\\s]\\S+)?\\s+)*(restart|stop|kill)\\b",
    "docker restart/stop/kill (container lifecycle)"
  ],
  [
    "\\b(?:gateway\\s+run|hexbot\\s+serve)\\b.*(&\\s*$|&\\s*;|\\bdisown\\b|\\bsetsid\\b)",
    "start a daemon outside its service (restart the Hexbot service instead)"
  ],
  [
    "\\bnohup\\b.*\\b(?:gateway\\s+run|hexbot\\s+serve)\\b",
    "start a daemon outside its service (restart the Hexbot service instead)"
  ],
  [
    "\\b(pkill|killall)\\b.*\\b(hexbot|hermes|gateway|cli\\.py)\\b",
    "kill the Hexbot daemon (self-termination)"
  ],
  [
    "\\bkill\\b.*\\$\\(\\s*(pgrep|pidof)\\b",
    "kill process via pgrep/pidof expansion (self-termination)"
  ],
  [
    "\\bkill\\b.*`\\s*(pgrep|pidof)\\b",
    "kill process via backtick pgrep/pidof expansion (self-termination)"
  ],
  [
    "(?=[\\s\\S]*\\blaunchctl\\s+(?:stop|kickstart|bootout|unload|kill|disable|remove)\\b)(?=[\\s\\S]*\\b(?:hexbot|app\\.hexbot|hermes|ai\\.hermes)\\b)",
    "stop/restart the Hexbot daemon service (kills running agents)"
  ],
  [
    "(?:^|[;|&\\n(`]|\\b(?:then|do|else)\\s)\\s*(?:\\w+=\\S+\\s+)*(?:(?:env|nice|nohup|exec|command|time|timeout|xargs|stdbuf|ionice)\\s+(?:\\S+\\s+)*?)?(?:ssh|scp|sftp)\\s",
    "remote shell or copy over SSH (uses your SSH agent)",
    "ssh"
  ],
  [
    "\\brsync\\b[^\\n]*\\s(?:-e\\s|--rsh\\b|rsync://|(?!--)[^\\s/:]+:[^\\s]*)",
    "remote copy over SSH (uses your SSH agent)"
  ],
  [
    "(?:>>?|\\btee\\b.*|\\b(?:cp|mv|install|ln)\\b.*\\s|\\bsed\\s+-[^\\s]*i.*)\\s*[\"\\']?(?:(?:~|\\$home|\\$\\{home\\})/(?:Library/LaunchAgents|\\.config/(?:autostart|systemd|gh|gcloud)|\\.(?:zshenv|gitconfig|git-credentials|aws|gnupg|kube|docker|azure))(?:/|\\b)|/Library/Launch(?:Agents|Daemons)/)",
    "write to a login item or host configuration path",
    "login-item"
  ],
  [
    "\\b(cp|mv|install)\\b.*\\s(?:/etc/|/private/(?:etc|var|tmp|home)/)",
    "copy/move file into system config path",
    "host-config"
  ],
  [
    "\\b(cp|mv|install)\\b.*\\s[\"\\']?(?:(?:(?:/|\\.{1,2}/)?(?:[^\\s/\"\\'`]+/)*\\.env(?:\\.[^/\\s\"\\'`]+)*)|(?:(?:/|\\.{1,2}/)?(?:[^\\s/\"\\'`]+/)*config\\.yaml))[\"\\']?(?:\\s*(?:&&|\\|\\||;).*)?$",
    "overwrite project env/config file"
  ],
  [
    "\\b(cp|mv|install)\\b.*\\s[\"\\']?(?:(?:/etc/|/private/(?:etc|var|tmp|home)/)|/dev/sd|(?:~|\\$home|\\$\\{home\\})/\\.ssh(?:/|$)|(?:~\\/\\.(?:hermes|hexbot)/|(?:\\$home|\\$\\{home\\})/\\.(?:hermes|hexbot)/|(?:\\$(?:hermes|hexbot)_home|\\$\\{(?:hermes|hexbot)_home\\})/)\\.env\\b|(?:~\\/\\.(?:hermes|hexbot)/|(?:\\$home|\\$\\{home\\})/\\.(?:hermes|hexbot)/|(?:\\$(?:hermes|hexbot)_home|\\$\\{(?:hermes|hexbot)_home\\})/)config\\.yaml\\b|(?:~|\\$home|\\$\\{home\\})/\\.(?:bashrc|zshrc|profile|bash_profile|zprofile)\\b|(?:~|\\$home|\\$\\{home\\})/\\.(?:netrc|pgpass|npmrc|pypirc)\\b)[^\\s\"\\']*[\"\\']?(?:\\s*(?:&&|\\|\\||;).*)?$",
    "copy/move file into sensitive credential/SSH/shell-rc path",
    "host-config"
  ],
  [
    "\\bsed\\s+-[^\\s]*i.*(?:(?:(?:~|\\$home|\\$\\{home\\})/\\.ssh(?:/|$)|(?:~|\\$home|\\$\\{home\\})/\\.(?:bashrc|zshrc|profile|bash_profile|zprofile)\\b|(?:~|\\$home|\\$\\{home\\})/\\.(?:netrc|pgpass|npmrc|pypirc)\\b))[^\\s\"\\']*",
    "in-place edit of sensitive credential/SSH/shell-rc path",
    "host-config"
  ],
  [
    "\\bsed\\s+--in-place\\b.*(?:(?:(?:~|\\$home|\\$\\{home\\})/\\.ssh(?:/|$)|(?:~|\\$home|\\$\\{home\\})/\\.(?:bashrc|zshrc|profile|bash_profile|zprofile)\\b|(?:~|\\$home|\\$\\{home\\})/\\.(?:netrc|pgpass|npmrc|pypirc)\\b))[^\\s\"\\']*",
    "in-place edit of sensitive credential/SSH/shell-rc path (long flag)",
    "host-config"
  ],
  [
    "\\b(?:perl|ruby)\\b.*(?:^|\\s)-[^\\s]*i\\b.*(?:(?:(?:~|\\$home|\\$\\{home\\})/\\.ssh(?:/|$)|(?:~|\\$home|\\$\\{home\\})/\\.(?:bashrc|zshrc|profile|bash_profile|zprofile)\\b|(?:~|\\$home|\\$\\{home\\})/\\.(?:netrc|pgpass|npmrc|pypirc)\\b))[^\\s\"\\']*",
    "in-place edit of sensitive credential/SSH/shell-rc path (perl/ruby)",
    "host-config"
  ],
  [
    "\\bsed\\s+-[^\\s]*i.*\\s(?:/etc/|/private/(?:etc|var|tmp|home)/)",
    "in-place edit of system config",
    "host-config"
  ],
  [
    "\\bsed\\s+--in-place\\b.*\\s(?:/etc/|/private/(?:etc|var|tmp|home)/)",
    "in-place edit of system config (long flag)",
    "host-config"
  ],
  [
    "\\bsed\\s+-[^\\s]*i.*(?:(?:~\\/\\.(?:hermes|hexbot)/|(?:\\$home|\\$\\{home\\})/\\.(?:hermes|hexbot)/|(?:\\$(?:hermes|hexbot)_home|\\$\\{(?:hermes|hexbot)_home\\})/)config\\.yaml\\b|(?:~\\/\\.(?:hermes|hexbot)/|(?:\\$home|\\$\\{home\\})/\\.(?:hermes|hexbot)/|(?:\\$(?:hermes|hexbot)_home|\\$\\{(?:hermes|hexbot)_home\\})/)\\.env\\b)",
    "in-place edit of Hexbot config/env"
  ],
  [
    "\\bsed\\s+--in-place\\b.*(?:(?:~\\/\\.(?:hermes|hexbot)/|(?:\\$home|\\$\\{home\\})/\\.(?:hermes|hexbot)/|(?:\\$(?:hermes|hexbot)_home|\\$\\{(?:hermes|hexbot)_home\\})/)config\\.yaml\\b|(?:~\\/\\.(?:hermes|hexbot)/|(?:\\$home|\\$\\{home\\})/\\.(?:hermes|hexbot)/|(?:\\$(?:hermes|hexbot)_home|\\$\\{(?:hermes|hexbot)_home\\})/)\\.env\\b)",
    "in-place edit of Hexbot config/env (long flag)"
  ],
  [
    "\\b(?:perl|ruby)\\b.*(?:^|\\s)-[^\\s]*i\\b.*(?:(?:~\\/\\.(?:hermes|hexbot)/|(?:\\$home|\\$\\{home\\})/\\.(?:hermes|hexbot)/|(?:\\$(?:hermes|hexbot)_home|\\$\\{(?:hermes|hexbot)_home\\})/)config\\.yaml\\b|(?:~\\/\\.(?:hermes|hexbot)/|(?:\\$home|\\$\\{home\\})/\\.(?:hermes|hexbot)/|(?:\\$(?:hermes|hexbot)_home|\\$\\{(?:hermes|hexbot)_home\\})/)\\.env\\b)",
    "in-place edit of Hexbot config/env (perl/ruby)"
  ],
  [
    "\\b(bash|sh|zsh|ksh)\\s+<<",
    "shell execution via heredoc",
    "heredoc"
  ],
  [
    "\\bgit\\s+reset\\s+--h(?:a(?:r(?:d)?)?)?\\b",
    "git reset --hard (destroys uncommitted changes)"
  ],
  [
    "\\bgit\\s+push\\b.*--forc[a-z]*\\b",
    "git force push (rewrites remote history)"
  ],
  [
    "\\bgit\\s+push\\b.*-f\\b",
    "git force push short flag (rewrites remote history)"
  ],
  [
    "\\bgit\\s+clean\\s+-[^\\s]*f",
    "git clean with force (deletes untracked files)"
  ],
  [
    "\\bgit\\s+branch\\s+-D\\b",
    "git branch force delete"
  ],
  [
    "\\bgit\\s+branch\\b[^;|&\\n]*?(?:-d\\b|--delete\\b)[^;|&\\n]*?(?:-f\\b|--force\\b)",
    "git branch force delete (long flags)"
  ],
  [
    "\\bgit\\s+branch\\b[^;|&\\n]*?(?:-f\\b|--force\\b)[^;|&\\n]*?(?:-d\\b|--delete\\b)",
    "git branch force delete (long flags, force-first)"
  ],
  [
    "\\bchmod\\s+\\+x\\b.*[;&|]+\\s*\\./",
    "chmod +x followed by immediate execution"
  ],
  [
    "\\bsudo\\b[^;|&\\n]*?\\s+(?:-s\\b|--st[a-z]*\\b|-a\\b|--a[a-z]*\\b)",
    "sudo with privilege flag (stdin/askpass/shell/list)",
    "sudo"
  ],
  [
    "\\bsudo\\b[^;|&\\n]*?\\s+-[a-z]*[sa][a-z]*\\b",
    "sudo with combined-flag privilege escalation",
    "sudo"
  ]
];

// Filenames can contain grep's line delimiters too (for example owl-2-beta).
// Check every possible path prefix, including text nested in truncation details.
export function sanitizeSearchResult(value: any, name: string, base: string, home: string): any {
  if (typeof value === 'string') return value.split('\n').filter(line => {
    const paths = name === 'grep' ? [...line.matchAll(/(:\d+:|-\d+-)/g)].map(match => line.slice(0, match.index)) : [line.replace(/\/$/, '')];
    return !paths.some(path => credentialPath(resolve(base, path), home) || credentialPath(canonicalPath(path, base), home));
  }).join('\n');
  if (Array.isArray(value)) return value.map(part => sanitizeSearchResult(part, name, base, home));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, part]) => [key, sanitizeSearchResult(part, name, base, home)]));
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
  const name = basename(path);

  if (!home) throw new Error('Hexbot home is unavailable');
  const root = under(path, resolve(home)) ? resolve(home) : canonicalPath(home, process.cwd());
  const local = relative(fold(root), fold(path)).split(sep).join('/');
  return !local.startsWith('../') && (policyRegex(credentialPolicy.basename).test(name) || policyRegex(credentialPolicy.home).test(local));
}
const UNSANDBOXED = 'unsandboxed command';
const HOST_CONFIG_WRITE = 'file:host-config';
const CREDENTIAL_STORE = 'file:credential-store';
const NEVER_WRITTEN = 'Credential and system configuration files are never written by tools.';
// credential-policy.json "write": deny entries are credential stores that tools
// never write; ask entries (shell profiles, login items) prompt in Manual and
// Auto; fileDeny entries (system configuration) are denied to the file tools
// and ask in shell commands.
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
function writeDenial(input: string, cwd: string, home: string, mode: string, outputs: string[] = []): string | undefined {
  const path = canonicalPath(input, cwd);
  if (protectedHomePath(path, home, outputs) || mode !== 'off' && protectedPath(path, home, outputs)) return 'This path is protected. Use the soul or memory tool for bot notes.';
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

// Tokenize enough shell syntax to distinguish commands from quoted prose and to
// inspect shell -c/eval payloads. This is a command guard, not an OS sandbox.
function shellTokens(command: string): string[] {
  const tokens: string[] = [];
  let word = '', quote = '';
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (c === '\\' && quote !== "'") { if (command[i + 1] !== '\n') word += command[++i] ?? ''; else i++; continue; }
    if (quote) { if (c === quote) quote = ''; else word += c; continue; }
    if (c === '"' || c === "'") { if (!word && command[i + 1] === '~') word = './'; quote = c; continue; }
    if (c === '{' && word.endsWith('$')) {
      const end = command.indexOf('}', i + 1);
      if (end >= 0) { word += command.slice(i, end + 1); i = end; continue; }
    }
    if ((c === '{' || c === '}') && word) { word += c; continue; }
    if (c === '>' || c === '<' || c === '&' && command[i + 1] === '>') {
      const fd = /^\d+$/.test(word) && c !== '&' ? word : '';
      if (!fd && word) tokens.push(word);
      word = '';
      const op = /^(?:&>>?|>>?[|&]?|<<<|<<-?|<&|<)/.exec(command.slice(i))![0];
      tokens.push(fd + op);
      i += op.length - 1;
      continue;
    }
    if (/\s|[;|&(){}<>`]/.test(c)) {
      if (word) tokens.push(word);
      word = '';
      if (!/\s/.test(c) || c === '\n') tokens.push(c);
    } else word += c;
  }
  if (word) tokens.push(word);
  return tokens;
}
const WRAPPERS = ['coproc', 'sudo', 'doas', 'env', 'exec', 'nohup', 'setsid', 'time', 'command', 'timeout', 'nice', 'ionice', 'stdbuf', 'xargs', 'busybox', 'caffeinate', 'script'];
const VALUE_FLAGS: Record<string, string[]> = {
  exec: ['-a'],
  sudo: ['-u', '-g', '-h', '-p', '-C', '-T', '--user', '--group', '--host', '--prompt', '--chdir'],
  doas: ['-u', '-g', '-h', '-p', '-C', '-T', '--user', '--group', '--host', '--prompt', '--chdir'],
  env: ['-u', '--unset', '-C', '--chdir'],
  caffeinate: ['-t', '-w'],
  script: ['-F', '-t', '-T', '-I', '-O', '-B', '-E'],
};
for (const wrapper of ['nice', 'ionice', 'stdbuf', 'xargs', 'timeout']) VALUE_FLAGS[wrapper] = ['-n', '-p', '-c', '-t', '-i', '-o', '-e', '-a', '-I', '-L', '-P', '-d', '-s', '-k', '--adjustment', '--class', '--classdata', '--pid', '--input', '--output', '--error', '--max-lines', '--max-args', '--max-procs', '--arg-file', '--delimiter', '--signal', '--kill-after'];
const SEPARATORS = [';', '|', '&', '(', '{', 'then', 'do', 'else', 'if', 'elif', 'while', 'until', ')', '!', '\n', '`'];
const TERMINATORS = [';', '|', '&', '\n', ')'];
const SHELLS = ['sh', 'bash', 'zsh', 'ksh', 'dash'];
// Programs that run what they read from stdin, so a heredoc they consume is code.
const INTERPRETERS = /^(?:python[0-9.]*|node|nodejs|deno|bun|perl|ruby|php|lua|osascript)$/;
const runsStdin = (name: string) => SHELLS.includes(name) || name === 'eval' || INTERPRETERS.test(name);
const isRedirect = (token: string) => /^\d*(?:>>?[|&]?|&>>?|<<-?|<<<|<&|<)$/.test(token);
const writesFile = (token: string, target: string) => /^\d*(?:>>?\|?|>&|&>>?)$/.test(token) && !/^\d+$|^-$/.test(target);
// Remove heredoc data before looking for commands, leaving a numbered marker as
// each delimiter so the walker can find the body a shell or interpreter would
// run. Unquoted delimiters still permit substitutions, which are visited
// separately from the body text.
function withoutHeredocs(command: string): {text: string, substitutions: string[], bodies: string[]} {
  const lines = command.split('\n'), kept: string[] = [], substitutions: string[] = [], bodies: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    let quote = '';
    const pending: {delimiter: string, quoted: boolean, tabs: boolean, start: number, end: number}[] = [];
    for (let j = 0; j < line.length; j++) {
      const c = line[j];
      if (c === '\\' && quote !== "'") { j++; continue; }
      if (quote) { if (c === quote) quote = ''; continue; }
      if (c === "'" || c === '"') { quote = c; continue; }
      if (c === '#' && (j === 0 || /\s/.test(line[j - 1]))) break;
      if (line.slice(j, j + 3) === '<<<') { j += 2; continue; }
      if (line.slice(j, j + 2) !== '<<') continue;
      const tabs = line[j + 2] === '-';
      const rest = line.slice(j + (tabs ? 3 : 2)).trimStart();
      const raw = /^(?:'[^']*'|"[^"]*"|\\.|[^\s;|&<>])+/.exec(rest)?.[0];
      if (!raw) continue;
      const start = line.length - rest.length;
      pending.push({delimiter: shellTokens(raw)[0] ?? '', quoted: /['"\\]/.test(raw), tabs, start, end: start + raw.length});
      j = start + raw.length - 1;
    }
    let shift = 0;
    for (const {delimiter, quoted, tabs, start, end} of pending) {
      const body: string[] = [];
      while (++i < lines.length) {
        if ((tabs ? lines[i].replace(/^\t+/, '') : lines[i]) === delimiter) break;
        body.push(lines[i]);
      }
      const marker = 'HEREDOC' + (bodies.push(body.join('\n')) - 1);
      line = line.slice(0, start + shift) + marker + line.slice(end + shift);
      shift += marker.length - (end - start);
      if (!quoted) for (const match of body.join('\n').matchAll(/\$\(([^()]*(?:\([^()]*\)[^()]*)*)\)|`([^`]*)`/g)) substitutions.push(match[1] ?? match[2]);
    }
    kept.push(line);
  }
  return {text: kept.join('\n'), substitutions, bodies};
}
// Skip assignments and wrappers to the executable. Commands a wrapper takes as
// one string (env -S, script -c) go to `nested`.
function commandWord(tokens: string[], start: number, nested: (command: string) => void): number {
  while (WRAPPERS.includes(fold(basename(tokens[start] ?? ''))) || /^\w+=/.test(tokens[start] ?? '')) {
    const wrapper = fold(basename(tokens[start++]));
    if (wrapper === 'command' && /^-[^-]*[vV]/.test(tokens[start] ?? '')) return start - 1;
    while (tokens[start]?.startsWith('-') || /^\w+=/.test(tokens[start] ?? '')) {
      const flag = tokens[start++];
      if (wrapper === 'env' && ['-S', '--split-string'].includes(flag) || wrapper === 'script' && /^-[^-]*c$|^--command$/.test(flag)) nested(tokens[start++] ?? '');
      else if (wrapper === 'env' && /^-S.|^--split-string=/.test(flag)) nested(flag.replace(/^-S|^--split-string=/, ''));
      else if (VALUE_FLAGS[wrapper]?.includes(flag)) start++;
    }
    if (wrapper === 'timeout' && /^[0-9.]+[smhd]?$/.test(tokens[start] ?? '')) start++;
    // script's first operand is the typescript file (macOS: `script -q /dev/null cmd`).
    if (wrapper === 'script' && tokens[start] && !SEPARATORS.includes(tokens[start])) start++;
  }
  return start;
}
// Every simple command: after separators and control words, behind wrappers, inside
// substitutions, inside shell -c and eval payloads, and inside a heredoc that a
// shell or interpreter in the same pipeline reads. The visitor gets the
// executable, its arguments and the files its redirections write; `inspect` sees
// every command string, nested ones included. Either returns a reason to stop.
type Visit = (name: string, args: string[], targets: string[]) => string | undefined;
function visitCommands(command: string, visit: Visit, depth = 0, inspect?: (command: string) => string | undefined): string | undefined {
  if (depth > 8) return 'Nested command cannot be checked';
  const source = withoutHeredocs(command);
  for (const payload of source.substitutions) {
    const stopped = visitCommands(payload, visit, depth + 1, inspect);
    if (stopped) return stopped;
  }
  command = source.text;
  const inspected = inspect?.(command);
  if (inspected) return inspected;
  // Check substitutions separately, then replace their output with an argument.
  // Their closing parenthesis is not a new command position (unlike case arms).
  let plain = command;
  const substitution = /\$\(([^()]*)\)|`([^`]*)`/g;
  while (substitution.test(plain)) {
    substitution.lastIndex = 0;
    let stopped: string | undefined;
    plain = plain.replace(substitution, (_match, dollar, backtick) => {
      stopped ??= visitCommands(dollar ?? backtick, visit, depth + 1, inspect);
      return 'SUBSTITUTION';
    });
    if (stopped) return stopped;
  }
  const tokens = shellTokens(plain);
  // Heredoc bodies of the current pipeline; `cat <<EOF | bash` runs the one cat read.
  let fed: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (i && !SEPARATORS.includes(tokens[i - 1])) continue;
    // Redirections can sit anywhere in the segment, even before the executable.
    const words: string[] = [], targets: string[] = [];
    let j = i;
    for (; j < tokens.length && !TERMINATORS.includes(tokens[j]); j++) {
      if (!isRedirect(tokens[j])) { words.push(tokens[j]); continue; }
      const target = tokens[j + 1];
      if (target === undefined || TERMINATORS.includes(target) || ['(', '{', '}'].includes(target)) continue;
      if (writesFile(tokens[j], target)) targets.push(target);
      else if (/^<<-?$/.test(tokens[j]) && /^HEREDOC\d+$/.test(target)) fed.push(source.bodies[Number(target.slice(7))] ?? '');
      j++;
    }
    let stopped: string | undefined;
    const start = commandWord(words, 0, nested => { stopped ??= visitCommands(nested, visit, depth + 1, inspect); });
    if (stopped) return stopped;
    // PATH lookup ignores case where the file system does, so RM is rm there.
    const name = fold(basename(words[start] ?? ''));
    const args = words.slice(start + 1);
    if (SHELLS.includes(name) || name === 'eval') {
      const index = args.findIndex(a => /^-[^-]*c/.test(a));
      const payload = name === 'eval' ? args.join(' ') : index >= 0 ? args[index + 1] : undefined;
      if (payload) { stopped = visitCommands(payload, visit, depth + 1, inspect); if (stopped) return stopped; }
    }
    if (runsStdin(name)) for (const body of fed.splice(0)) { stopped = visitCommands(body, visit, depth + 1, inspect); if (stopped) return stopped; }
    stopped = visit(name, args, targets);
    if (stopped) return stopped;
    const piped = tokens[j] === '|' && tokens[j + 1] !== '|' || tokens[j] === '&' && tokens[j - 1] === '|';
    if (!piped) fed = [];
  }
}
const forkBomb = (command: string) => /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/.test(command.replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, '')) ? 'fork bomb' : undefined;
// The floor is an early, plain refusal; the OS sandbox enforces the credential
// stores and the approval prompts cover the rest.
export function hardlineCommand(command: string, cwd = process.cwd(), depth = 0): string | undefined {
  if (hostConfigWriteTier(command, cwd) === 'deny') return 'write to a credential store';
  return visitCommands(command, (name, args, targets) => {
    if (targets.some(target => /^\/dev\/(sd|nvme|hd|mmcblk|vd|xvd|disk|rdisk)/.test(target))) return 'write to raw disk';
    if (/^mkfs(?:\.|$)/.test(name)) return 'format filesystem';
    if (['shutdown', 'reboot', 'halt', 'poweroff'].includes(name) || ['init', 'telinit'].includes(name) && ['0', '6'].includes(args[0]) || name === 'systemctl' && args.some(a => ['poweroff', 'reboot', 'halt', 'kexec'].includes(a))) return 'system shutdown';
    if (name === 'kill' && args.includes('-1')) return 'kill all processes';
    if (name === 'dd' && args.some(a => /^of=\/dev\/(sd|nvme|hd|mmcblk|vd|xvd|disk|rdisk)/.test(a))) return 'overwrite raw disk';
    if (name === 'rm') {
      const end = args.indexOf('--');
      const flags = end < 0 ? args : args.slice(0, end);
      if (!flags.some(a => /^-[^-]*[rR]/.test(a) || a === '--recursive')) return;
      for (const arg of args.filter(a => !a.startsWith('-'))) {
        let expanded = expandHome(arg.replace(/\$\{USER\}|\$USER\b/g, process.env.USER ?? basename(homedir()))).replace(/\/+$/, '') || '/';
        // A glob or brace in the last component names that directory's children
        // (~/*, ~/.*, ~/.[!.]*, ~/{*,.*}), so the directory itself is the target.
        while (/[*?[{]/.test(basename(expanded))) expanded = dirname(expanded);
        const path = canonicalPath(expanded, cwd);
        const roots = ['/', '/home', '/root', '/etc', '/usr', '/var', '/bin', '/sbin', '/boot', '/lib', '/private', '/System', '/Library', '/Users', homedir()];
        if (roots.some(root => path === canonicalPath(root, cwd))) return 'recursive delete of home or system directory';
      }
    }
  }, depth, forkBomb);
}
// Files a command writes by name: redirections and the targets of tee, truncate,
// dd, cp, mv, install, ln and in-place edits. The tier comes from hostWriteTier, so
// bash and the file tools agree on deny versus ask. A cd makes relative targets
// uncertain (subshells are not scoped): they are checked against every directory
// the command may be in and ask rather than refuse.
function hostConfigWriteTier(command: string, cwd: string): 'deny' | 'ask' | undefined {
  let dirs = [cwd];
  let moved = false;
  let tier: 'deny' | 'ask' | undefined;
  const move = (target: string) => {
    moved = true;
    if (/\$|SUBSTITUTION/.test(target)) { tier ??= 'ask'; return; }
    dirs = [...new Set([...dirs, ...dirs.map(dir => resolve(dir, expandHome(target)))])].slice(0, 16);
  };
  const consider = (target: string) => {
    const expanded = expandHome(target);
    if (/\$|SUBSTITUTION/.test(expanded)) { tier ??= 'ask'; return; }
    for (const base of isAbsolute(expanded) ? [cwd] : dirs) {
      let found: 'deny' | 'ask' | undefined;
      try { found = hostWriteTier(expanded, base); } catch { found = 'ask'; }
      if (found === 'deny' && moved && !isAbsolute(expanded)) found = 'ask';
      if (found === 'deny' || found === 'ask' && !tier) tier = found;
    }
  };
  visitCommands(command, (name, args, targets) => {
    const operands = args.filter(a => !a.startsWith('-'));
    targets.forEach(consider);
    if (['cd', 'pushd'].includes(name)) { move(operands[0] ?? '~'); return tier === 'deny' ? 'deny' : undefined; }
    if (name === 'tee' || name === 'truncate') operands.forEach(consider);
    if (name === 'ln') (args.some(a => /^-[^-]*s|^--symbolic$/.test(a)) ? operands.slice(-1) : operands).forEach(consider);
    if (['cp', 'mv', 'install'].includes(name) && operands.length) {
      const attached = args.find(a => a.startsWith('--target-directory='))?.slice('--target-directory='.length);
      const separate = args.findIndex(a => a === '-t' || a === '--target-directory');
      consider(attached ?? (separate >= 0 ? args[separate + 1] ?? '' : operands[operands.length - 1]));
    }
    if (name === 'dd') args.filter(a => a.startsWith('of=')).forEach(a => consider(a.slice(3)));
    if (name === 'sed' && args.some(a => /^-[^-]*i|^--in-place/.test(a)) || ['perl', 'ruby'].includes(name) && args.some(a => /^-[^-]*i/.test(a))) operands.forEach(consider);
    return tier === 'deny' ? 'deny' : undefined;
  });
  return tier;
}
const SSH_CLIENT = 'remote shell or copy over SSH (uses your SSH agent)';
function sshCommand(command: string): boolean {
  return !!visitCommands(command, name => ['ssh', 'scp', 'sftp', 'autossh', 'ssh-copy-id'].includes(name) ? SSH_CLIENT : undefined);
}
// The regex gates see the whole text, heredoc data included; the scanner-based
// gates decide what the data feeds.
export function dangerousCommand(command: string, home?: string, cwd = process.cwd()): string[] {
  const normalized = shellTokens(command).join(' ').replaceAll(' ; ', '\n').replaceAll(' | ', '\n').replaceAll(' & ', '\n');
  const host = hostConfigWriteTier(command, cwd) === 'ask';
  const ssh = sshCommand(command);
  const sudo = /\bsudo\b/i.test(normalized);
  const symbolicLink = !!visitCommands(command, (name, args) => name === 'ln' && args.some(a => /^-[^-]*s|^--symbolic$/.test(a)) ? 'symbolic link' : undefined);
  let credentials: boolean, store: boolean;
  try { credentials = namesCredentials(command, home, cwd); } catch { credentials = true; }
  try { store = namesStore(command, cwd); } catch { store = true; }
  const matches = dangerousPatterns.filter(([pattern, , route]) => {
    if (route === 'ssh' && !ssh) return false;
    if (route === 'login-item' && symbolicLink && !host) return false;
    if (route === 'heredoc' && !visitCommands(command, name => SHELLS.includes(name) ? 'shell' : undefined)) return false;
    return new RegExp(pattern, 'im').test(command) || new RegExp(pattern, 'im').test(normalized);
  });
  // Keep the regex gates as well as the scanner. Equivalent gates share one key
  // so an always-allow decision covers the action only once.
  return [...new Set([
    ...(credentials ? ['credential access'] : []),
    ...(/\$\(|`|(?:^|[;|&\n{}]|\b(?:then|do|else)\s)\s*(?:\w+=\S+\s+)*(?:eval\b|\$)/.test(command) ? ['dynamic command'] : []),
    ...matches.map(([pattern, , route]) =>
      route === 'ssh' ? SSH_CLIENT :
      host && (route === 'host-config' || route === 'login-item') ? HOST_CONFIG_WRITE :
      sudo && route === 'sudo' ? '\\bsudo\\b' :
      route === 'world-writable' ? 'world-writable permissions' : pattern),
    ...(ssh ? [SSH_CLIENT] : []),
    ...(host ? [HOST_CONFIG_WRITE] : []),
    ...(store ? [CREDENTIAL_STORE] : []),
    ...(sudo ? ['\\bsudo\\b'] : []),
    ...(/\b(chmod|chown)\b.*777/i.test(normalized) ? ['world-writable permissions'] : []),
  ])];
}

// A command that names a credential store asks, whatever it does with it: the
// hard floor and the OS sandbox stop the writes they can see, but bubblewrap
// cannot bind a store that does not exist yet, so an interpreter, a downloader
// or touch could create one there. Interpreter code spells the home as "~",
// as "/.npmrc" after HOME, or as a bare name under Path.home().
function namesStore(command: string, cwd: string): boolean {
  const tokens = shellTokens(command);
  const candidates = tokens.map(token => token.replace(/^.*?=/, ''));
  if (tokens.some(token => INTERPRETERS.test(fold(basename(token))))) {
    for (const literal of command.split(/['"]/)) candidates.push(literal, join(homedir(), literal));
  }
  return candidates.some(path => hostWriteTier(path, cwd) === 'deny');
}
function namesCredentials(command: string, home?: string, cwd = process.cwd()): boolean {
  cwd = canonicalPath(cwd, process.cwd());
  const tokens = shellTokens(command);
  const recursive = tokens.some(token => ['tar', 'rsync', 'zip', 'find'].includes(basename(token)))
    || tokens.some(token => /^--recursive$|^-[^-]*[rR]/.test(token));
  const inlineCode = tokens.some(token => /^(python[0-9.]*|node)$/.test(basename(token)))
    && tokens.some(token => ['-c', '-e', '--eval'].includes(token));
  const root = home ? canonicalPath(home, cwd) : undefined;
  return tokens.some(token => {
    // Also inspect quoted path literals inside interpreter one-liners.
    const candidates = inlineCode ? [token, ...Array.from(token.matchAll(/['"]([^'"\n]+)['"]/g), m => m[1])] : [token];
    return candidates.some(candidate => {
      const path = expandHome(candidate.replace(/^.*?=/, '').replace(/\$\{HEXBOT_HOME\}|\$HEXBOT_HOME\b/g, home ?? ''));
      if (policyRegex(credentialPolicy.basename).test(basename(path)) || fold(basename(path)) === '.env') return true;
      const resolved = canonicalPath(path, cwd);
      if (home && credentialPath(resolved, home)) return true;
      if (recursive && root && under(root, resolved)) return true;
      const glob = path.search(/[*?[]/);
      if (glob >= 0) {
        const prefix = canonicalPath(path.slice(0, path.lastIndexOf('/', glob) + 1) || '.', cwd);
        if (root && under(prefix, root) || under(prefix, canonicalPath(join(homedir(), '.ssh'), cwd))) return true;
      }
      return !!(inlineCode && (candidate !== token || path.includes('/')) && root && under(resolved, root));
    });
  });
}
