import {
  collapseSystemMessages, createAssistantMessageEventStream,
  getCurrentSystemPrompt, getCurrentTools,
} from '@earendil-works/pi-ai';

/** ACP remains a Rust-owned process; this module only translates Pi's stream contract. */
export function registerAcp(pi: any, config: any, bridge: (name: string, args: any) => Promise<any>) {
  const ids = new Set(['copilot-acp']);
  if (config.provider === 'copilot-acp' && config.model) ids.add(config.model);
  if (config.fallback?.provider === 'copilot-acp') ids.add(config.fallback.model);
  pi.registerProvider('copilot-acp', {
    baseUrl: 'acp://copilot', api: 'hexbot-acp', apiKey: 'external-process',
    models: [...ids].filter(Boolean).map(id => ({
      id, name: id, reasoning: true, input: ['text'],
      cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0},
      contextWindow: 128000, maxTokens: 16384,
    })),
    streamSimple(model: any, context: any, options: any = {}) {
      const stream = createAssistantMessageEventStream();
      const output: any = {
        role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
        usage: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}},
        stopReason: 'pending', timestamp: Date.now(),
      };
      (async () => {
        try {
          if (options.signal?.aborted) throw new Error('The turn was interrupted');
          stream.push({type: 'start', partial: output});
          const transcript = collapseSystemMessages(context);
          let payload: any = {model: model.id, context: {
            systemPrompt: getCurrentSystemPrompt(transcript.messages),
            tools: getCurrentTools(transcript.messages), messages: transcript.messages,
          }};
          payload = await options.onPayload?.(payload, model) ?? payload;
          const reply = await bridge('hexbot_acp_complete', payload);
          if (options.signal?.aborted) throw new Error('The turn was interrupted');
          for (const [kind, value] of [['thinking', reply.thinking], ['text', reply.text]]) {
            if (!value) continue;
            const contentIndex = output.content.length;
            output.content.push({type: kind, [kind]: value});
            stream.push({type: `${kind}_start`, contentIndex, partial: output} as any);
            stream.push({type: `${kind}_delta`, contentIndex, delta: value, partial: output} as any);
            stream.push({type: `${kind}_end`, contentIndex, content: value, partial: output} as any);
          }
          for (const call of reply.toolCalls ?? []) {
            const contentIndex = output.content.length;
            const toolCall = {type: 'toolCall', id: call.id, name: call.name, arguments: call.arguments};
            output.content.push(toolCall);
            stream.push({type: 'toolcall_start', contentIndex, partial: output});
            stream.push({type: 'toolcall_delta', contentIndex, delta: JSON.stringify(call.arguments), partial: output});
            stream.push({type: 'toolcall_end', contentIndex, toolCall, partial: output} as any);
          }
          output.stopReason = reply.stopReason ?? (reply.toolCalls?.length ? 'toolUse' : 'stop');
          stream.push({type: 'done', reason: output.stopReason, message: output});
        } catch (error) {
          output.stopReason = options.signal?.aborted ? 'aborted' : 'error';
          output.errorMessage = error instanceof Error ? error.message : String(error);
          stream.push({type: 'error', reason: output.stopReason, error: output});
        } finally { stream.end(); }
      })();
      return stream;
    },
  });
}
