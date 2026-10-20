/** Provider transport and auth only. One-shot calls never register tools. */
import {readFileSync} from 'node:fs';
import {lazyStream} from '@earendil-works/pi-ai';
import {builtinProviders} from '@earendil-works/pi-ai/providers/all';
import {registerAcp} from './acp.ts';

export default function oneShotProvider(pi: any) {
  const config = JSON.parse(process.env.HEXBOT_ONE_SHOT_PROVIDER ?? '{}');
  let context: any;
  pi.on('session_start', (_event: any, ctx: any) => { context = ctx; });
  const bridge = async (name: string, args: any) => {
    if (!context) throw new Error('Provider context is unavailable');
    const raw = await context.ui.input('__HEXBOT_TOOL__' + JSON.stringify({name, args}));
    if (!raw) throw new Error('Provider request interrupted');
    const reply = JSON.parse(raw);
    if (reply.error) throw new Error(reply.error);
    return reply.result;
  };
  registerAcp(pi, config, async (name, args) => {
    if (args.context.tools?.length) throw new Error('One-shot providers cannot use tools');
    const reply = await bridge(name, args);
    if (reply.toolCalls?.length) throw new Error('One-shot providers cannot use tools');
    return reply;
  });
  // Keep the daemon's token refresh and wire rules without loading chat tools,
  // skills, workspace resources, or the section's mutable system prompt.
  const providers = builtinProviders();
  for (const [provider, api] of [
    ['openai-codex', 'openai-codex-responses'],
    ['anthropic', 'anthropic-messages'],
    ['xai', 'openai-responses'],
  ]) {
    const native = providers.find((item: any) => item.id === provider)!;
    pi.registerProvider(provider, {api, streamSimple(model: any, ctx: any, options: any = {}) {
      return lazyStream(model, async () => {
        if (provider === 'xai') {
          const auth = JSON.parse(readFileSync(process.env.PI_CODING_AGENT_DIR + '/auth.json', 'utf8'));
          if (auth.xai?.type !== 'oauth') return native.streamSimple(model, ctx, options);
        }
        const result = await bridge('hexbot_provider_auth', {provider: provider === 'xai' ? 'xai-oauth' : provider});
        const headers = result?.headers ?? {};
        const apiKey = headers['x-api-key'] || headers.authorization?.replace(/^Bearer /, '');
        if (!apiKey) throw new Error('Provider authentication returned no token');
        return native.streamSimple(model, ctx, {...options, apiKey, headers: {...options.headers, ...headers}});
      });
    }});
  }
  pi.on('before_provider_request', async (event: any, ctx: any) => {
    const provider = ctx.model?.provider ?? config.provider;
    if (!['qwen-oauth', 'nous', 'openrouter', 'kimi-coding', 'kimi-coding-cn', 'moonshotai', 'moonshotai-cn', 'deepseek', 'zai', 'minimax', 'minimax-cn', 'minimax-oauth', 'custom', 'ollama'].includes(provider)) return;
    return bridge('hexbot_provider_request', {provider, model: ctx.model?.id, thinking: pi.getThinkingLevel(), payload: event.payload});
  });
  pi.on('before_provider_headers', async (event: any, ctx: any) => {
    const provider = ctx.model?.provider ?? config.provider;
    if (!['nous', 'qwen-oauth', 'minimax-oauth'].includes(provider)) return;
    const result = await bridge('hexbot_provider_auth', {provider});
    Object.assign(event.headers, result?.headers ?? {});
  });
}
