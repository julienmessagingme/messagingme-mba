import { describe, it, expect } from 'vitest';
import { pushAnalysisJob } from '../src/analysis/push-job';
import type { StoredConversationAnalysis } from '../src/analysis/events';
import type { EnrichedAnalyzedEvent } from '../src/analysis/connector-push';
import type { Enrichment } from '../src/analysis/enrichment';

const stored: StoredConversationAnalysis = {
  conversationId: 'c1', tenantId: 't1', sentiment: 'neutre', intent: 'information', topic: 'x', resolved: true,
  entities: {}, action_suggestion: 'aucune', confidence: 0.5, justification: 'x', handled_by: 'humain', exchanges_count: 2,
};
const enr: Enrichment = {
  contactE164: '+33600000001', profileName: 'Jean', whatsappLine: '+33525680250',
  lastInboundAt: '2026-07-14 10:00:00.111+00', analyzedAt: '2026-07-14 10:05:00.222+00',
};

describe('pushAnalysisJob', () => {
  it('succès (numéro connecté HubSpot) -> post appelé avec l\'événement construit', async () => {
    const posted: EnrichedAnalyzedEvent[] = [];
    await pushAnalysisJob(stored, { getEnrichment: async () => enr, isHubspotConnected: async () => true, post: async (e) => { posted.push(e); } });
    expect(posted).toHaveLength(1);
    expect(posted[0]!.eventId).toBe(`c1:${enr.analyzedAt}`);
    expect(posted[0]!.contactE164).toBe('+33600000001');
  });

  it('conversation disparue (enrichment null) -> aucun post', async () => {
    let posts = 0;
    await pushAnalysisJob(stored, { getEnrichment: async () => null, isHubspotConnected: async () => true, post: async () => { posts += 1; } });
    expect(posts).toBe(0);
  });

  it('GATE : numéro NON connecté à HubSpot -> skip (aucun post), log émis', async () => {
    let posts = 0;
    const logs: string[] = [];
    const checked: Array<{ tenantId: string; line: string }> = [];
    await pushAnalysisJob(stored, {
      getEnrichment: async () => enr,
      isHubspotConnected: async (tenantId, line) => { checked.push({ tenantId, line }); return false; },
      post: async () => { posts += 1; },
      log: (m) => logs.push(m),
    });
    expect(posts).toBe(0); // synchro coupée pour ce numéro
    expect(checked).toEqual([{ tenantId: 't1', line: '+33525680250' }]); // gate interrogé avec le bon tenant + ligne
    expect(logs.some((l) => /skip/.test(l))).toBe(true);
  });

  it('payload invalide -> throw (pg-boss ne rejoue pas indéfiniment un job cassé... via DLQ)', async () => {
    await expect(pushAnalysisJob({}, { getEnrichment: async () => enr, isHubspotConnected: async () => true, post: async () => {} })).rejects.toThrow(/invalide/);
  });
});
