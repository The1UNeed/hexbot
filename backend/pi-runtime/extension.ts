/** Hexbot's frozen session tools and approval bridge. Pi owns the agent loop. */
import { readFileSync, realpathSync, lstatSync, readlinkSync, statSync } from 'node:fs';
import { resolve, dirname, basename, relative, sep, join } from 'node:path';
import { homedir } from 'node:os';
import { createBashTool, createReadTool, createWriteTool, createEditTool, createGrepTool, createFindTool, createLsTool } from '@earendil-works/pi-coding-agent';
import {credentialPolicy, isolatedCommand} from './isolation.ts';
import { registerAcp } from './acp.ts';
import { lazyStream } from '@earendil-works/pi-ai';
import { builtinProviders } from '@earendil-works/pi-ai/providers/all';

export default function hexbot(pi: any) {
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
      if (['read', 'grep', 'find', 'ls', 'write', 'edit'].includes(event.toolName)) {
        const path = canonicalPath(event.input.path ?? '.', cwd);
        if (credentialPath(resolve(cwd, event.input.path ?? '.'), home) || credentialPath(path, home)) return {block: true, reason: 'Credential files are private.'};
        if (live.approvalMode !== 'off' && ['write', 'edit'].includes(event.toolName) && protectedPath(path, home)) {
          return {block: true, reason: 'This path is protected. Use the soul or memory tool for bot notes.'};
        }
      }
      if (event.toolName === 'bash') {
        const reason = hardlineCommand(event.input.command, cwd);
        if (reason) return {block: true, reason: 'Command blocked: ' + reason};
      }
      const patterns = event.toolName === 'bash' ? dangerousCommand(event.input.command, home) :
        event.toolName === 'browser_console' && typeof event.input.expression === 'string' ? ['browser_console:expression'] : [];
      if (live.approvalMode === 'off' || !patterns.length) return;
      if (patterns.every(key => allowed.has(key) || live.allowedPatterns?.includes(key))) return;
      let smartDenied = false;
      if (live.approvalMode === 'smart') {
        try {
          if ((await bridge(ctx, 'hexbot_auto_approve', {tool: event.toolName, input: event.input})).approved === true) return;
        } catch {}
        smartDenied = true;
      }
      const choice = await ctx.ui.select('__HEXBOT_APPROVAL__' + JSON.stringify({
        tool: event.toolName, command: JSON.stringify(event.input), reason: 'This action matches a dangerous command or executes code in a page.', smart_denied: smartDenied
      }), ['once', 'session', 'always', 'deny']);
      if (!['once', 'session', 'always'].includes(choice)) return {block: true, reason: 'The user denied this action.'};
      if (choice === 'session') patterns.forEach(key => allowed.add(key));
      if (choice === 'always') await bridge(ctx, 'hexbot_allow_patterns', {patterns});
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
    const options = () => name === 'bash' ? {spawnHook: (c: any) => { const reason = hardlineCommand(c.command, c.cwd); if (reason) throw new Error('Command blocked: ' + reason); return {...c, command: isolatedCommand(c.command, live.home), env: shellEnvironment(c.env)}; }} :
      name === 'grep' ? {operations: {isDirectory: (path: string) => statSync(path).isDirectory(), readFile: (path: string) => credentialPath(path, live.home) ? '' : readFileSync(path, 'utf8')}} : {};
    const tool = factory(config.cwd, options());
    pi.registerTool({...tool, async execute(id: string, args: any, signal: any, update: any) {
      // Pass the checked canonical target to Pi too: its lexical normalization
      // of '..' must not select a different file after a symlink was checked.
      if (name !== 'bash') {
        const path = canonicalPath(args.path ?? '.', live.cwd ?? config.cwd);
        if (credentialPath(resolve(live.cwd ?? config.cwd, args.path ?? '.'), live.home) || credentialPath(path, live.home)) throw new Error('Credential files are private.');
        if (live.approvalMode !== 'off' && ['write', 'edit'].includes(name) && protectedPath(path, live.home)) throw new Error('This path is protected.');
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
      return createLocalBashOperations().exec(isolatedCommand(command, live.home), live.cwd ?? cwd, {...opts, env: shellEnvironment(opts.env ?? process.env)});
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
const dangerousPatterns: [string, string][] = [
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
    "world/other-writable permissions"
  ],
  [
    "\\bchmod\\s+--recursive\\b.*(777|666|o\\+[rwx]*w|a\\+[rwx]*w)",
    "recursive world/other-writable (long flag)"
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
    "overwrite system config"
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
    "overwrite system file via tee"
  ],
  [
    ">>?\\s*[\"\\']?(?:(?:/etc/|/private/(?:etc|var|tmp|home)/)|/dev/sd|(?:~|\\$home|\\$\\{home\\})/\\.ssh(?:/|$)|(?:~\\/\\.(?:hermes|hexbot)/|(?:\\$home|\\$\\{home\\})/\\.(?:hermes|hexbot)/|(?:\\$(?:hermes|hexbot)_home|\\$\\{(?:hermes|hexbot)_home\\})/)\\.env\\b|(?:~\\/\\.(?:hermes|hexbot)/|(?:\\$home|\\$\\{home\\})/\\.(?:hermes|hexbot)/|(?:\\$(?:hermes|hexbot)_home|\\$\\{(?:hermes|hexbot)_home\\})/)config\\.yaml\\b|(?:~|\\$home|\\$\\{home\\})/\\.(?:bashrc|zshrc|profile|bash_profile|zprofile)\\b|(?:~|\\$home|\\$\\{home\\})/\\.(?:netrc|pgpass|npmrc|pypirc)\\b)",
    "overwrite system file via redirection"
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
    "gateway\\s+run\\b.*(&\\s*$|&\\s*;|\\bdisown\\b|\\bsetsid\\b)",
    "start gateway outside systemd (use 'systemctl --user restart hermes-gateway')"
  ],
  [
    "\\bnohup\\b.*gateway\\s+run\\b",
    "start gateway outside systemd (use 'systemctl --user restart hermes-gateway')"
  ],
  [
    "\\b(pkill|killall)\\b.*\\b(hermes|gateway|cli\\.py)\\b",
    "kill hermes/gateway process (self-termination)"
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
    "(?=[\\s\\S]*\\blaunchctl\\s+(?:stop|kickstart|bootout|unload|kill|disable|remove)\\b)(?=[\\s\\S]*\\b(?:hermes|ai\\.hermes)\\b)",
    "stop/restart hermes launchd service (kills running agents)"
  ],
  [
    "\\b(cp|mv|install)\\b.*\\s(?:/etc/|/private/(?:etc|var|tmp|home)/)",
    "copy/move file into system config path"
  ],
  [
    "\\b(cp|mv|install)\\b.*\\s[\"\\']?(?:(?:(?:/|\\.{1,2}/)?(?:[^\\s/\"\\'`]+/)*\\.env(?:\\.[^/\\s\"\\'`]+)*)|(?:(?:/|\\.{1,2}/)?(?:[^\\s/\"\\'`]+/)*config\\.yaml))[\"\\']?(?:\\s*(?:&&|\\|\\||;).*)?$",
    "overwrite project env/config file"
  ],
  [
    "\\b(cp|mv|install)\\b.*\\s[\"\\']?(?:(?:/etc/|/private/(?:etc|var|tmp|home)/)|/dev/sd|(?:~|\\$home|\\$\\{home\\})/\\.ssh(?:/|$)|(?:~\\/\\.(?:hermes|hexbot)/|(?:\\$home|\\$\\{home\\})/\\.(?:hermes|hexbot)/|(?:\\$(?:hermes|hexbot)_home|\\$\\{(?:hermes|hexbot)_home\\})/)\\.env\\b|(?:~\\/\\.(?:hermes|hexbot)/|(?:\\$home|\\$\\{home\\})/\\.(?:hermes|hexbot)/|(?:\\$(?:hermes|hexbot)_home|\\$\\{(?:hermes|hexbot)_home\\})/)config\\.yaml\\b|(?:~|\\$home|\\$\\{home\\})/\\.(?:bashrc|zshrc|profile|bash_profile|zprofile)\\b|(?:~|\\$home|\\$\\{home\\})/\\.(?:netrc|pgpass|npmrc|pypirc)\\b)[^\\s\"\\']*[\"\\']?(?:\\s*(?:&&|\\|\\||;).*)?$",
    "copy/move file into sensitive credential/SSH/shell-rc path"
  ],
  [
    "\\bsed\\s+-[^\\s]*i.*(?:(?:(?:~|\\$home|\\$\\{home\\})/\\.ssh(?:/|$)|(?:~|\\$home|\\$\\{home\\})/\\.(?:bashrc|zshrc|profile|bash_profile|zprofile)\\b|(?:~|\\$home|\\$\\{home\\})/\\.(?:netrc|pgpass|npmrc|pypirc)\\b))[^\\s\"\\']*",
    "in-place edit of sensitive credential/SSH/shell-rc path"
  ],
  [
    "\\bsed\\s+--in-place\\b.*(?:(?:(?:~|\\$home|\\$\\{home\\})/\\.ssh(?:/|$)|(?:~|\\$home|\\$\\{home\\})/\\.(?:bashrc|zshrc|profile|bash_profile|zprofile)\\b|(?:~|\\$home|\\$\\{home\\})/\\.(?:netrc|pgpass|npmrc|pypirc)\\b))[^\\s\"\\']*",
    "in-place edit of sensitive credential/SSH/shell-rc path (long flag)"
  ],
  [
    "\\b(?:perl|ruby)\\b.*(?:^|\\s)-[^\\s]*i\\b.*(?:(?:(?:~|\\$home|\\$\\{home\\})/\\.ssh(?:/|$)|(?:~|\\$home|\\$\\{home\\})/\\.(?:bashrc|zshrc|profile|bash_profile|zprofile)\\b|(?:~|\\$home|\\$\\{home\\})/\\.(?:netrc|pgpass|npmrc|pypirc)\\b))[^\\s\"\\']*",
    "in-place edit of sensitive credential/SSH/shell-rc path (perl/ruby)"
  ],
  [
    "\\bsed\\s+-[^\\s]*i.*\\s(?:/etc/|/private/(?:etc|var|tmp|home)/)",
    "in-place edit of system config"
  ],
  [
    "\\bsed\\s+--in-place\\b.*\\s(?:/etc/|/private/(?:etc|var|tmp|home)/)",
    "in-place edit of system config (long flag)"
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
    "shell execution via heredoc"
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
    "sudo with privilege flag (stdin/askpass/shell/list)"
  ],
  [
    "\\bsudo\\b[^;|&\\n]*?\\s+-[a-z]*[sa][a-z]*\\b",
    "sudo with combined-flag privilege escalation"
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

export function canonicalPath(path: string, cwd: string, depth = 0): string {
  if (depth > 40) throw new Error("Too many symbolic links");
  const expanded = path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
  // Resolve each component before '..', including a symlink followed by a parent.
  let current = expanded.startsWith(sep) ? sep : cwd;
  for (const part of expanded.split(sep)) {
    if (!part || part === '.') continue;
    current = part === '..' ? dirname(current) : join(current, part);
    try { current = realpathSync(current); }
    catch (error: any) {
      if (error.code !== 'ENOENT') throw error;
      try {
        if (lstatSync(current).isSymbolicLink()) current = canonicalPath(readlinkSync(current), dirname(current), depth + 1);
      } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  return current;
}
const under = (path: string, root: string) => path === root || path.startsWith(root + sep);
export function credentialPath(path: string, home: string): boolean {
  const lexical = resolve(path);
  path = canonicalPath(path, process.cwd());
  if (lexical !== path && credentialName(lexical, home)) return true;
  return credentialName(path, home);
}
function credentialName(path: string, home: string): boolean {
  if (under(path, canonicalPath(join(homedir(), '.ssh'), process.cwd())) || under(path, join(homedir(), '.ssh'))) return true;
  const name = basename(path);
  if (new RegExp(credentialPolicy.basename).test(name)) return true;
  if (!home) throw new Error('Hexbot home is unavailable');
  const root = under(path, resolve(home)) ? resolve(home) : canonicalPath(home, process.cwd());
  const local = relative(root, path).split(sep).join('/');
  return new RegExp(credentialPolicy.home).test(local);
}
export function protectedPath(path: string, home: string): boolean {
  path = canonicalPath(path, process.cwd());
  return under(path, canonicalPath(home, process.cwd())) || path.split(sep).some(part => part.startsWith('.env') || ['.git', 'node_modules', '.ssh'].includes(part));
}
export function shellEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // Explicit inheritance prevents unfamiliar connector keys and runtime injection
  // variables (BASH_ENV, NODE_OPTIONS, etc.) from reaching code children.
  return Object.fromEntries(Object.entries(env).filter(([name]) => /^(PATH|HOME|USER|LOGNAME|SHELL|TMPDIR|TMP|TEMP|LANG|LANGUAGE|LC_[A-Z_]+|TERM|COLORTERM|TZ|SystemRoot|WINDIR|PATHEXT|COMSPEC)$/i.test(name)));
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
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '{' && word.endsWith('$')) {
      const end = command.indexOf('}', i + 1);
      if (end >= 0) { word += command.slice(i, end + 1); i = end; continue; }
    }
    if ((c === '{' || c === '}') && word) { word += c; continue; }
    if (/\s|[;|&(){}<>`]/.test(c)) {
      if (word) tokens.push(word);
      word = '';
      if (!/\s/.test(c) || c === '\n') tokens.push(c);
    } else word += c;
  }
  if (word) tokens.push(word);
  return tokens;
}
export function hardlineCommand(command: string, cwd = process.cwd(), depth = 0): string | undefined {
  if (depth > 8) return 'Nested command cannot be checked';
  const unquoted = command.replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, '');
  if (/:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/.test(unquoted)) return 'fork bomb';
  // Inspect command substitutions even inside a quoted argument.
  for (const match of command.matchAll(/\$\(([^()]*)\)|`([^`]*)`/g)) {
    const reason = hardlineCommand(match[1] ?? match[2], cwd, depth + 1);
    if (reason) return reason;
  }
  const tokens = shellTokens(command);
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === '>' && /^\/dev\/(sd|nvme|hd|mmcblk|vd|xvd|disk|rdisk)/.test(tokens[i + 1] ?? '')) return 'write to raw disk';
    if (i && ![';', '|', '&', '(', '{', 'then', 'do', 'else', '!', '\n', '`'].includes(tokens[i - 1])) continue;
    let start = i;
    while (['sudo', 'env', 'exec', 'nohup', 'setsid', 'time', 'command', 'timeout', 'nice', 'ionice', 'stdbuf', 'doas', 'xargs', 'busybox'].includes(basename(tokens[start] ?? '')) || /^\w+=/.test(tokens[start] ?? '')) {
      const wrapper = basename(tokens[start++]);
      while (tokens[start]?.startsWith('-') || /^\w+=/.test(tokens[start] ?? '')) {
        const flag = tokens[start++];
        if (wrapper === 'env' && ['-S', '--split-string'].includes(flag)) { const reason = hardlineCommand(tokens[start++] ?? '', cwd, depth + 1); if (reason) return reason; }
        if (['sudo', 'doas'].includes(wrapper) && ['-u', '-g', '-h', '-p', '-C', '-T', '--user', '--group', '--host', '--prompt', '--chdir'].includes(flag) || wrapper === 'env' && ['-u', '--unset', '-C', '--chdir'].includes(flag) || ['nice', 'ionice', 'stdbuf', 'xargs', 'timeout'].includes(wrapper) && ['-n', '-p', '-c', '-t', '-i', '-o', '-e', '-a', '-I', '-L', '-P', '-d', '-s', '-k', '--adjustment', '--class', '--classdata', '--pid', '--input', '--output', '--error', '--max-lines', '--max-args', '--max-procs', '--arg-file', '--delimiter', '--signal', '--kill-after'].includes(flag)) start++;
      }
      if (wrapper === 'timeout' && /^[0-9.]+[smhd]?$/.test(tokens[start] ?? '')) start++;
    }
    const name = basename(tokens[start] ?? '');
    const args: string[] = [];
    for (let j = start + 1; j < tokens.length && ![';', '|', '&', '\n', ')'].includes(tokens[j]); j++) args.push(tokens[j]);
    if (['sh', 'bash', 'zsh', 'ksh', 'dash', 'eval'].includes(name)) {
      const index = args.findIndex(a => /^-[^-]*c/.test(a));
      const payload = name === 'eval' ? args.join(' ') : index >= 0 ? args[index + 1] : undefined;
      if (payload) { const reason = hardlineCommand(payload, cwd, depth + 1); if (reason) return reason; }
    }
    if (/^mkfs(?:\.|$)/.test(name)) return 'format filesystem';
    if (['shutdown', 'reboot', 'halt', 'poweroff'].includes(name) || ['init', 'telinit'].includes(name) && ['0', '6'].includes(args[0]) || name === 'systemctl' && args.some(a => ['poweroff', 'reboot', 'halt', 'kexec'].includes(a))) return 'system shutdown';
    if (name === 'kill' && args.includes('-1')) return 'kill all processes';
    if (name === 'dd' && args.some(a => /^of=\/dev\/(sd|nvme|hd|mmcblk|vd|xvd|disk|rdisk)/.test(a))) return 'overwrite raw disk';
    if (name === 'rm') {
      const end = args.indexOf('--');
      const flags = end < 0 ? args : args.slice(0, end);
      if (!flags.some(a => /^-[^-]*[rR]/.test(a) || a === '--recursive')) continue;
      for (const arg of args.filter(a => !a.startsWith('-'))) {
        const expanded = arg.replace(/\$\{HOME\}|\$HOME\b/g, homedir()).replace(/\$\{USER\}|\$USER\b/g, process.env.USER ?? basename(homedir())).replace(/\/\*$/, '') || '/';
        const path = canonicalPath(expanded, cwd);
        const roots = ['/', '/home', '/root', '/etc', '/usr', '/var', '/bin', '/sbin', '/boot', '/lib', '/private', '/System', '/Library', '/Users', homedir()];
        if (roots.some(root => path === canonicalPath(root, cwd))) return 'recursive delete of home or system directory';
      }
    }
  }
}
export function dangerousCommand(command: string, home?: string): string[] {
  const normalized = shellTokens(command).join(' ').replaceAll(' ; ', '\n').replaceAll(' | ', '\n').replaceAll(' & ', '\n');
  return [...new Set([
    ...((home && (command.includes(home) || command.includes(canonicalPath(home, process.cwd()))) || /\$\{?HEXBOT_HOME\}?|[~$]HOME|~\/\.hexbot|\.ssh|\.env|auth\.json|connect\.json|local-device\.token|hexbot(?:-runtime)?\.db|pi-approvals|provider-auth|\.anthropic_oauth\.json/.test(command)) ? ['credential access'] : []),
    ...(/\$\(|`|(?:^|[;|&\n{}]|\b(?:then|do|else)\s)\s*(?:\w+=\S+\s+)*(?:eval\b|\$)/.test(command) ? ['dynamic command'] : []),
    ...dangerousPatterns.filter(([pattern]) => new RegExp(pattern, 'im').test(command) || new RegExp(pattern, 'im').test(normalized)).map(([pattern]) => pattern),
    ...(/\bsudo\b/i.test(normalized) ? ['\\bsudo\\b'] : []),
    ...(/\b(chmod|chown)\b.*777/i.test(normalized) ? ['\\b(chmod|chown)\\b.*777'] : []),
  ])];
}
