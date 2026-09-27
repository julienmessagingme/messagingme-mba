import { describe, it, expect } from 'vitest';
import { pushAnalysisJob, type PushJobDeps } from '../src/analysis/push-job';
import type { StoredConversationAnalysis } from '../src/analysis/events';
import type { EnrichedAnalyzedEvent } from '../src/analysis/connector-push';
import type { Enrichment } from '../src/analysis/enrichment';

const REF = { conversationId: 'c1', tenantId: 't1' };
const stored: StoredConversationAnalysis = {
  conversationId: 'c1', tenantId: 't1', sentiment: 'neutre', intent: 'information', topic: 'x', resolved: true,
  entities: {}, action_suggestion: 'aucune', confidence: 0.5, justification: 'x', handled_by: 'humain', exchanges_count: 2, abusive: false,
};
const enr: Enrichment = {
  contactE164: '+33600000001', profileName: 'Jean', whatsappLine: '+33525680250',
  lastInboundAt: '2026-07-14 10:00:00.111+00', analyzedAt: '2026-07-14 10:05:00.222+00',
};

/** Deps par défaut : numéro connecté, analyse + enrichissement présents. `over` surcharge. */
type Surcharges = Partial<Omit<PushJobDeps, 'analyses'>> & { analyses?: Partial<PushJobDeps['analyses']> };

function deps(over: Surcharges = {}): { d: PushJobDeps; posted: EnrichedAnalyzedEvent[]; marked: string[]; cleared: string[]; logs: string[] } {
  const posted: EnrichedAnalyzedEvent[] = [];
  const marked: string[] = [];
  const cleared: string[] = [];
  const logs: string[] = [];
  const { analyses: surAnalyses, ...reste } = over;
  const d: PushJobDeps = {
    analyses: {
      getStored: async () => stored,
      markPendingCatchup: async (id) => { marked.push(id); },
      clearPendingCatchup: async (id) => { cleared.push(id); },
      ...surAnalyses,
    },
    getEnrichment: async () => enr,
    numeros: {
      getHubspotGateStatus: async () => ({ connected: true, pausedAt: null }),
    },
    post: async (e) => { posted.push(e); },
    log: (m) => logs.push(m),
    ...reste,
  };
  return { d, posted, marked, cleared, logs };
}

describe('pushAnalysisJob (contrat ref-only + snapshot unique gate/pause)', () => {
  it('succès (connecté) -> refetch, post avec l\'événement, marque effacée, jamais marquée', async () => {
    const { d, posted, cleared, marked } = deps();
    await pushAnalysisJob(REF, d);
    expect(posted).toHaveLength(1);
    expect(posted[0]!.eventId).toBe(`c1:${enr.analyzedAt}`);
    expect(cleared).toEqual(['c1']);
    expect(marked).toHaveLength(0);
  });

  it('analyse disparue (getStoredAnalysis null) -> aucun post', async () => {
    const { d, posted } = deps({ analyses: { getStored: async () => null } });
    await pushAnalysisJob(REF, d);
    expect(posted).toHaveLength(0);
  });

  it('conversation disparue (enrichment null) -> aucun post', async () => {
    const { d, posted } = deps({ getEnrichment: async () => null });
    await pushAnalysisJob(REF, d);
    expect(posted).toHaveLength(0);
  });

  it('EN PAUSE (snapshot connected=false, pausedAt renseigné) -> skip + MARQUE (décision sur le snapshot, pas de re-lecture)', async () => {
    const { d, posted, marked, logs } = deps({ numeros: { getHubspotGateStatus: async () => ({ connected: false, pausedAt: '2026-07-20T10:00:00Z' }) } });
    await pushAnalysisJob(REF, d);
    expect(posted).toHaveLength(0);
    expect(marked).toEqual(['c1']); // marqué inconditionnellement sur la base du snapshot vu
    expect(logs.some((l) => /skip/.test(l))).toBe(true);
  });

  it('JAMAIS ACTIVÉ (connected=false, pausedAt null) -> skip mais PAS de marque (pas d\'historique surprise)', async () => {
    const { d, posted, marked } = deps({ numeros: { getHubspotGateStatus: async () => ({ connected: false, pausedAt: null }) } });
    await pushAnalysisJob(REF, d);
    expect(posted).toHaveLength(0);
    expect(marked).toHaveLength(0);
  });

  it('skip en pause : une erreur de markPendingCatchup REMONTE (pg-boss rejoue, pas de perte silencieuse)', async () => {
    const { d } = deps({ numeros: { getHubspotGateStatus: async () => ({ connected: false, pausedAt: 'x' }) }, analyses: { markPendingCatchup: async () => { throw new Error('db down'); } } });
    await expect(pushAnalysisJob(REF, d)).rejects.toThrow('db down');
  });

  it('post réussi mais clearPendingCatchup échoue -> best-effort : la promesse résout, le post a bien eu lieu', async () => {
    const { d, posted } = deps({ analyses: { clearPendingCatchup: async () => { throw new Error('clear KO'); } } });
    await expect(pushAnalysisJob(REF, d)).resolves.toBeUndefined();
    expect(posted).toHaveLength(1);
  });

  it('payload invalide -> throw', async () => {
    const { d } = deps();
    await expect(pushAnalysisJob({}, d)).rejects.toThrow(/invalide/);
    await expect(pushAnalysisJob({ conversationId: 'c1' }, d)).rejects.toThrow(/invalide/);
  });
});
