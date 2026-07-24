import { randomBytes } from 'node:crypto';
import { signRequest } from '../lib/signature';
import { withRetry } from '../meta/http';
import type { HttpTransport } from '../meta/http';
import type { StoredConversationAnalysis, OnConversationAnalyzed } from './events';
import { noopOnAnalyzed } from './events';
import type { Enrichment } from './enrichment';

/**
 * Événement self-contained poussé au connecteur mm-hubspot : l'analyse générique + l'identité/canal/fenêtre.
 * `eventId` = clé de dédup côté connecteur (une réanalyse -> analyzedAt différent -> eventId différent -> retraité).
 */
export interface EnrichedAnalyzedEvent {
  eventId: string;
  conversationId: string;
  tenantId: string;
  contactE164: string;
  profileName: string | null;
  whatsappLine: string;
  lastInboundAt: string | null;
  analysis: Omit<StoredConversationAnalysis, 'conversationId' | 'tenantId'>;
}

/** Assemble l'événement (fonction PURE -> testable). */
export function buildEvent(stored: StoredConversationAnalysis, enr: Enrichment): EnrichedAnalyzedEvent {
  const { conversationId, tenantId, ...analysis } = stored;
  return {
    eventId: `${conversationId}:${enr.analyzedAt ?? 'na'}`,
    conversationId,
    tenantId,
    contactE164: enr.contactE164,
    profileName: enr.profileName,
    whatsappLine: enr.whatsappLine,
    lastInboundAt: enr.lastInboundAt,
    analysis,
  };
}

/** Erreur d'appel au connecteur. `retryable` (429/5xx/réseau) -> withRetry rejoue ; 4xx -> terminal (rethrow -> DLQ pg-boss). */
export class PushApiError extends Error {
  constructor(readonly status: number, readonly retryable: boolean) {
    super(`connector push HTTP ${status}`);
    this.name = 'PushApiError';
  }
}

export interface PostAnalysisDeps {
  url: string;
  secret: string;
  transport: HttpTransport;
}

/** POST signé de l'événement au connecteur, avec retry borné (backoff) sur 429/5xx/réseau. */
export async function postAnalysis(event: EnrichedAnalyzedEvent, deps: PostAnalysisDeps): Promise<void> {
  // Chemin signé = pathname de l'URL cible ('/ingest'), tel que mm-hubspot le voit (req.url sans query).
  const path = new URL(deps.url).pathname;
  await withRetry(async () => {
    const raw = JSON.stringify(event);
    // ts + nonce FRAIS par tentative : le backoff peut atteindre ~30 s, un ts figé sortirait de la fenêtre au 2e essai.
    const sig = signRequest(deps.secret, { ts: Date.now(), nonce: randomBytes(8).toString('hex'), method: 'POST', path, body: raw });
    const res = await deps.transport.post(deps.url, event, { 'x-mma-signature': sig });
    if (res.status >= 200 && res.status < 300) return;
    throw new PushApiError(res.status, res.status === 429 || res.status >= 500);
  });
}

/**
 * Fabrique le point de sortie `onAnalyzed`. Désactivé (`enabled=false`) -> no-op (INERTE : rien n'est enfilé).
 * Activé -> enfile un job `push-analysis` (durable, DLQ). BEST-EFFORT : un échec d'enqueue est loggé mais ne
 * REMONTE JAMAIS dans le job d'analyse (sinon pg-boss rejouerait l'analyse/le LLM). La durabilité du traitement
 * (enrichissement + POST) vit dans les retries du job push-analysis lui-même.
 */
export function makeOnAnalyzed(deps: {
  enabled: boolean;
  enqueue: (stored: StoredConversationAnalysis) => Promise<void>;
  onError?: (err: unknown) => void;
}): OnConversationAnalyzed {
  if (!deps.enabled) return noopOnAnalyzed;
  return async (stored) => {
    try {
      await deps.enqueue(stored);
    } catch (err) {
      deps.onError?.(err);
    }
  };
}
