import type { WebhookEvent } from './parse';

export type DeliveryStatus = 'sent' | 'delivered' | 'read' | 'failed';

export interface DeliveryStore {
  /** Met à jour le statut de livraison d'un destinataire par message_id. Retourne le nb de lignes touchées. */
  updateDeliveryByMessageId(messageId: string, status: DeliveryStatus, error: string | null, errorCode: number | null): Promise<number>;
}

const VALID = new Set<DeliveryStatus>(['sent', 'delivered', 'read', 'failed']);

/** Code d'erreur Meta numérique depuis `errors[0].code` (number, ou string de chiffres). null sinon. */
function numericCode(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string' && /^\d+$/.test(raw)) return Number(raw);
  return null;
}

/**
 * Extrait (messageId, status, error, errorCode) d'un objet statut Meta, ou null si inexploitable
 * (ex. statut d'un message entrant non issu d'une campagne, ou champ absent). `error` = texte aplati
 * `"<code> <titre>"` (affichage), `errorCode` = le code numérique isolé (breakdown analytics).
 */
export function extractDelivery(
  data: unknown,
): { messageId: string; status: DeliveryStatus; error: string | null; errorCode: number | null } | null {
  if (!data || typeof data !== 'object') return null;
  const s = data as { id?: unknown; status?: unknown; errors?: unknown };
  if (typeof s.id !== 'string' || typeof s.status !== 'string' || !VALID.has(s.status as DeliveryStatus)) {
    return null;
  }
  let error: string | null = null;
  let errorCode: number | null = null;
  if (Array.isArray(s.errors) && s.errors.length > 0) {
    const e = s.errors[0] as { code?: unknown; title?: unknown; message?: unknown };
    errorCode = numericCode(e.code);
    const parts = [e.code, e.title ?? e.message].filter((x) => x !== undefined && x !== null).map(String);
    error = parts.join(' ').trim() || null;
  }
  return { messageId: s.id, status: s.status as DeliveryStatus, error, errorCode };
}

/**
 * Rattache un accusé Meta au bloc de scénario qui a envoyé ce message (« Mes tableaux »). Optionnel : un
 * identifiant qui n'appartient à aucun envoi de scénario ne crée rien, cette fonction voit TOUS les statuts.
 */
export interface NodeStatusSink {
  recordStatusForMessage(metaMessageId: string, kind: 'delivered' | 'read' | 'failed'): Promise<number>;
}

/**
 * Applique les événements de statut aux destinataires (par message_id). Ignore le reste.
 *
 * `nodeEvents` (optionnel) reçoit le MÊME statut pour la mesure par bloc. Les accusés Meta ne parlent que d'un
 * identifiant de message, sans rien savoir des scénarios : c'est ici qu'ils retrouvent leur bloc. `sent` est
 * exclu à dessein, l'envoi étant déjà compté par l'exécuteur au moment où il part ; le recompter ici
 * doublerait chaque envoi.
 *
 * BEST-EFFORT sur la mesure : une panne de compteur ne doit pas empêcher la mise à jour d'une livraison, qui
 * est la donnée métier. L'échec reste visible en console.
 */
export async function processStatuses(
  events: WebhookEvent[],
  delivery: DeliveryStore,
  nodeEvents?: NodeStatusSink,
): Promise<void> {
  for (const ev of events) {
    if (ev.source !== 'statuses') continue;
    const d = extractDelivery(ev.data);
    if (!d) continue;
    await delivery.updateDeliveryByMessageId(d.messageId, d.status, d.error, d.errorCode);
    if (nodeEvents && d.status !== 'sent') {
      try {
        await nodeEvents.recordStatusForMessage(d.messageId, d.status);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('mesure de bloc (statut) ignorée:', err instanceof Error ? err.message : err);
      }
    }
  }
}
