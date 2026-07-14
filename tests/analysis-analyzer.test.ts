import { describe, it, expect } from 'vitest';
import { analyzeConversation, InvalidLlmOutputError, type AnalysisContext } from '../src/analysis/analyzer';
import type { LlmClient, LlmPrompt } from '../src/analysis/llm-client';

const validJson = JSON.stringify({
  sentiment: 'neutre', intent: 'information', topic: 'horaires', resolved: true,
  entities: {}, action_suggestion: 'aucune', confidence: 0.7, justification: 'Question sur les horaires.',
});

class ScriptedLlm implements LlmClient {
  calls = 0;
  constructor(private readonly outputs: string[]) {}
  async complete(_p: LlmPrompt): Promise<string> {
    const o = this.outputs[this.calls] ?? '';
    this.calls += 1;
    return o;
  }
}

const ctx: AnalysisContext = {
  messages: [
    { direction: 'in', body: 'Vos horaires ?', type: 'text' },
    { direction: 'out', body: '9h-18h', type: 'text', senderUserId: 'u1' },
  ],
  signals: { hasHumanOutbound: true, hasAutomated: false },
};

describe('analyzeConversation', () => {
  it('valide direct -> analyse + faits déterministes (handled_by, exchanges_count)', async () => {
    const llm = new ScriptedLlm([validJson]);
    const a = await analyzeConversation(ctx, { llm });
    expect(llm.calls).toBe(1);
    expect(a).toMatchObject({ intent: 'information', handled_by: 'humain', exchanges_count: 1 });
  });

  it('invalide puis valide -> retry 1x réussit', async () => {
    const llm = new ScriptedLlm(['pas du json', validJson]);
    const a = await analyzeConversation(ctx, { llm });
    expect(llm.calls).toBe(2);
    expect(a.intent).toBe('information');
  });

  it('invalide x2 -> InvalidLlmOutputError (pas de 3e essai)', async () => {
    const llm = new ScriptedLlm(['nope', 'encore nope']);
    await expect(analyzeConversation(ctx, { llm })).rejects.toBeInstanceOf(InvalidLlmOutputError);
    expect(llm.calls).toBe(2);
  });
});
