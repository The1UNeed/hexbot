/** Hexbot's frozen session tools and approval bridge. Pi owns the agent loop. */
import { readFileSync, writeFileSync } from 'node:fs';
import { registerAcp } from './acp.ts';

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
  const savedPath = config.approvalsPath;
  let saved: string[] = [];
  try { saved = JSON.parse(readFileSync(savedPath, 'utf8')); } catch {}
  const readOnly = new Set(['read', 'grep', 'find', 'ls', 'memory', 'clarify', ...config.readOnlyTools]);

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
  pi.on('before_agent_start', async () => { fallbackUsed = false; iterations = 0; limitReached = false; return { systemPrompt: config.prompt }; });
  pi.on('session_compact', async (_event: any, ctx: any) => {
    const raw = await ctx.ui.input('__HEXBOT_TOOL__' + JSON.stringify({name: 'hexbot_todo_context', args: {}}));
    if (!raw) return;
    const reply = JSON.parse(raw);
    if (reply.result?.text) pi.sendMessage({customType: 'hexbot_todo', content: reply.result.text, display: false});
  });
  pi.on('agent_before_settle', async (event: any, ctx: any) => {
    if (limitReached || event.outcome !== 'error' || fallbackUsed || !config.fallback?.provider || !config.fallback?.model) return;
    fallbackUsed = true;
    const model = ctx.modelRegistry.find(config.fallback.provider, config.fallback.model);
    if (!model || (ctx.model?.provider === model.provider && ctx.model?.id === model.id)) return;
    if (!await pi.setModel(model)) return;
    pi.sendMessage({customType: 'hexbot_fallback', content: 'The model service failed. Continue the current task from the existing conversation and tool results. Do not repeat completed actions.', display: false}, {triggerTurn: true, deliverAs: 'followUp'});
    return {continue: true};
  });
  pi.on('tool_call', async (event: any, ctx: any) => {
    if (config.approvalMode === 'off' || readOnly.has(event.toolName)) return;
    const key = JSON.stringify([event.toolName, event.input]);
    if (allowed.has(key) || saved.includes(key)) return;
    if (config.approvalMode === 'smart') {
      try {
        const reply = await ctx.ui.input('__HEXBOT_TOOL__' + JSON.stringify({name: 'hexbot_auto_approve', args: {tool: event.toolName, input: event.input}}));
        if (reply && JSON.parse(reply).result?.approved === true) return;
      } catch {}
    }
    const choice = await ctx.ui.select('__HEXBOT_APPROVAL__' + JSON.stringify({
      tool: event.toolName, command: JSON.stringify(event.input), reason: 'This tool can change files or call an external service.'
    }), ['once', 'session', 'always', 'deny']);
    if (!choice || choice === 'deny') return { block: true, reason: 'The user denied this action.' };
    if (choice === 'session') allowed.add(key);
    if (choice === 'always') {
      saved = [...new Set([...saved, key])];
      writeFileSync(savedPath, JSON.stringify(saved), { mode: 0o600 });
    }
  });
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
