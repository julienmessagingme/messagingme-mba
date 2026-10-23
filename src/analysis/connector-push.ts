import { randomBytes } from 'node:crypto';
import { signRequest } from '../lib/signature';
import { withRetry } from '../meta/http';
import type { HttpTransport } from '../meta/http';
import type { StoredConversationAnalysis } from './events';
import { noopOnAnalyzed } from './events';
import type { Enrichment } from './enrichment';

/**
 * Événement autonome poussé au connecteur mm-hubspot : l'analyse plus l'identité, le canal et la fenêtre.
 * `eventId` = clé de dédup côté connecteur (une réanalyse change analyzedAt, donc l'eventId).
 */
export interface EnrichedAnalyzedEvent {
  eventId: string;
  conversationId: string;
  tenantId: string;
  contactE164: string;
  profileName: string | null;
  whatsappLine: string;
  lastInboundAt: string | null;
  /**
   * L'adresse de la conversation dans l'Inbox (URL https absolue), la même que l'e-mail et la tâche du passage à
   * l'équipe. Facultative pour le connecteur, qui accepte encore un événement sans (2026-10-23). Absente quand la
   * console n'est pas servie en https (`APP_URL` d'un poste) : le connecteur refuserait l'événement ENTIER pour un lien
   * dont l'analyse n'a pas besoin.
   */
  lienConversation?: string;
  analysis: Omit<StoredConversationAnalysis, 'conversationId' | 'tenantId'>;
}

/** Assemble l'événement (fonction pure). `lienConversation` : la fonction de lien du socle, fournie par le câblage. */
export function buildEvent(
  stored: StoredConversationAnalysis,
  enr: Enrichment,
  lienConversation: (conversationId: string) => string,
): EnrichedAnalyzedEvent {
  const { conversationId, tenantId, ...analysis } = stored;
  const lien = lienConversation(conversationId);
  return {
    eventId: `${conversationId}:${enr.analyzedAt ?? 'na'}`,
    conversationId,
    tenantId,
    contactE164: enr.contactE164,
    profileName: enr.profileName,
    whatsappLine: enr.whatsappLine,
    lastInboundAt: enr.lastInboundAt,
    ...(lien.startsWith('https://') ? { lienConversation: lien } : {}),
    analysis,
  };
}

/** Erreur d'appel au connecteur. `retryable` (429, 5xx, réseau) : withRetry rejoue ; 4xx : terminal (DLQ pg-boss). */
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
    // ts et nonce frais par tentative : le backoff atteint ~30 s, un ts figé sortirait de la fenêtre au 2e essai.
    const sig = signRequest(deps.secret, { ts: Date.now(), nonce: randomBytes(8).toString('hex'), method: 'POST', path, body: raw });
    const res = await deps.transport.post(deps.url, event, { 'x-mma-signature': sig });
    if (res.status >= 200 && res.status < 300) return;
    throw new PushApiError(res.status, res.status === 429 || res.status >= 500);
  });
}

/**
 * Fabrique le point de sortie `onAnalyzed`. Désactivé : no-op, rien n'est enfilé. Activé : enfile un job
 * `push-analysis` durable. Un échec d'enfilement est journalisé mais ne remonte jamais dans le job d'analyse, que
 * pg-boss rejouerait (LLM compris).
 */
export function makeOnAnalyzed(deps: {
  enabled: boolean;
  enqueue: (stored: StoredConversationAnalysis) => Promise<void>;
  onError?: (err: unknown) => void;
}): (stored: StoredConversationAnalysis) => Promise<void> {
  // Le contrat de la poussée reste l'analyse stockée, sans la copie de fiche : il reste assignable au point de
  // sortie (`OnConversationAnalyzed`, `./events`), qui lui passe une `AnalyseTerminee`.
  if (!deps.enabled) return noopOnAnalyzed;
  return async (stored) => {
    try {
      await deps.enqueue(stored);
    } catch (err) {
      deps.onError?.(err);
    }
  };
}
