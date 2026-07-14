import { describe, it, expect } from 'vitest';
import { analyzeConversationJob, type AnalyzeStore } from '../src/analysis/job';
import type { AnalysisContext } from '../src/analysis/analyzer';
import type { LlmClient } from '../src/analysis/llm-client';
import type { StoredConversationAnalysis } from '../src/analysis/events';
import type { ConversationAnalysis } from '../src/analysis/schema';

const validJson = JSON.stringify({
  sentiment: 'positif', intent: 'demande_devis', topic: 'devis', resolved: false,
  entities: {}, action_suggestion: 'creer_devis', confidence: 0.9, justification: 'veut un devis',
});

class Llm implements LlmClient {
  constructor(private readonly out: string | Error) {}
  async complete(): Promise<string> {
    if (this.out instanceof Error) throw this.out;
    return this.out;
  }
}

interface Cap { saved: Array<{ id: string; a: ConversationAnalysis; windowEnd: Date | null }>; failed: string[]; done: string[] }
function fakeStore(ctx: AnalysisContext | null): { store: AnalyzeStore; cap: Cap } {
  const cap: Cap = { saved: [], failed: [], done: [] };
  const store: AnalyzeStore = {
    getContext: async () => ctx,
    save: async (id, _t, a, _m, windowEnd) => { cap.saved.push({ id, a, windowEnd }); },
    markDone: async (id) => { cap.done.push(id); },
    markFailed: async (id) => { cap.failed.push(id); },
  };
  return { store, cap };
}

const windowEnd = new Date('2026-01-01T00:00:00Z');
const ctx: AnalysisContext = { messages: [{ direction: 'in', body: 'devis ?', type: 'text' }], signals: { hasHumanOutbound: false, hasAutomated: false }, windowEnd };
const model = { provider: 'anthropic', model: 'm' };

describe('analyzeConversationJob', () => {
  it('succès -> save + onAnalyzed appelés', async () => {
    const { store, cap } = fakeStore(ctx);
    const analyzed: StoredConversationAnalysis[] = [];
    await analyzeConversationJob({ conversationId: 'c1', tenantId: 't1' }, { store, llm: new Llm(validJson), onAnalyzed: async (a) => { analyzed.push(a); }, model });
    expect(cap.saved.map((s) => s.id)).toEqual(['c1']);
    expect(cap.saved[0]!.windowEnd).toEqual(windowEnd); // borne de fenêtre transmise à save (course d'analyse)
    expect(analyzed[0]).toMatchObject({ conversationId: 'c1', tenantId: 't1', intent: 'demande_devis' });
  });

  it('JSON invalide x2 -> markFailed, PAS de rethrow, pas de save', async () => {
    const { store, cap } = fakeStore(ctx);
    await analyzeConversationJob({ conversationId: 'c1', tenantId: 't1' }, { store, llm: new Llm('nope'), onAnalyzed: async () => {}, model });
    expect(cap.failed).toEqual(['c1']);
    expect(cap.saved).toHaveLength(0);
  });

  it('erreur réseau LLM (retryable) -> rethrow (pg-boss retry), pas de markFailed', async () => {
    const { store, cap } = fakeStore(ctx);
    const err = Object.assign(new Error('down'), { retryable: true });
    await expect(analyzeConversationJob({ conversationId: 'c1', tenantId: 't1' }, { store, llm: new Llm(err), onAnalyzed: async () => {}, model })).rejects.toThrow('down');
    expect(cap.failed).toHaveLength(0);
    expect(cap.saved).toHaveLength(0);
  });

  it('contexte vide (rien de nouveau) -> markDone, aucun appel LLM/save', async () => {
    const { store, cap } = fakeStore({ messages: [], signals: { hasHumanOutbound: false, hasAutomated: false } });
    await analyzeConversationJob({ conversationId: 'c1', tenantId: 't1' }, { store, llm: new Llm(validJson), onAnalyzed: async () => {}, model });
    expect(cap.done).toEqual(['c1']);
    expect(cap.saved).toHaveLength(0);
  });

  it('conversation disparue -> no-op', async () => {
    const { store, cap } = fakeStore(null);
    await analyzeConversationJob({ conversationId: 'c1', tenantId: 't1' }, { store, llm: new Llm(validJson), onAnalyzed: async () => {}, model });
    expect(cap.saved).toHaveLength(0);
    expect(cap.done).toHaveLength(0);
    expect(cap.failed).toHaveLength(0);
  });

  it('payload sans conversationId -> throw', async () => {
    const { store } = fakeStore(ctx);
    await expect(analyzeConversationJob({}, { store, llm: new Llm(validJson), onAnalyzed: async () => {}, model })).rejects.toThrow(/manquant/);
  });
});
