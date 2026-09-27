import type { WebhookEvent } from './parse';
import { extraireTarif, type TarifsMetaSink } from './tarif-meta';
import { asRecord } from './json';
import { tenter } from '../lib/tenter';
import { messageDe } from '../lib/erreur';

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
 * Ce que la remontée des signaux reçoit d'un accusé. Best-effort et gratuit par défaut : ce chemin traite chaque
 * accusé de la plateforme, le puits décide lui-même de ne rien lire, et il ne fait jamais échouer le traitement
 * d'une livraison.
 */
export interface AccuseDuStatut {
  messageId: string;
  status: DeliveryStatus;
  /** Le destinataire tel que Meta le nomme (`recipient_id`) : numéro en chiffres nus, ou BSUID. */
  waId: string | null;
  motif: string | null;
  codeMeta: number | null;
  /** L'instant daté par Meta (`timestamp`), en ISO ; `null` s'il manque. La file des accusés peut avoir du retard. */
  le: string | null;
}
export type SignalAccuse = (phoneNumberId: string, accuse: AccuseDuStatut) => Promise<void>;

/** Le destinataire d'un statut Meta, ou `null`. Ne lève jamais. */
export function destinataireDuStatut(data: unknown): string | null {
  const r = asRecord(data)['recipient_id'];
  return typeof r === 'string' && r.trim() !== '' ? r : null;
}

/** L'instant d'un statut Meta (secondes Unix), en ISO, ou `null`. Ne lève jamais. */
export function instantDuStatut(data: unknown): string | null {
  const brut = asRecord(data)['timestamp'];
  const secondes = typeof brut === 'string' || typeof brut === 'number' ? Number(brut) : Number.NaN;
  return Number.isFinite(secondes) && secondes > 0 ? new Date(secondes * 1000).toISOString() : null;
}

/**
 * Rattache un accusé Meta au bloc de scénario qui a envoyé ce message (« Mes tableaux »). Optionnel ; un
 * identifiant qui n'appartient à aucun envoi de scénario ne crée rien.
 */
export interface NodeStatusSink {
  recordStatusForMessage(metaMessageId: string, kind: 'delivered' | 'read' | 'failed'): Promise<number>;
}

/**
 * La remise du fil à l'agent de Meta, déclenchée par l'accusé de notre dernier envoi. Envoyer un message prend
 * le fil implicitement : relâcher dans la foulée d'un envoi relâcherait un fil que cet envoi reprend. Seul
 * l'accusé dit que Meta a fini de traiter l'envoi (il arrive en une seconde ; un retard vient de notre file).
 * Appelée pour chaque statut : l'implémentation rend la main tout de suite quand aucun fil n'attend ce message.
 * Optionnelle : sans elle, le balayage de contrôle rend les fils plus tard.
 */
export interface RemiseMbaSurAccuse {
  (messageId: string): Promise<void>;
}

/**
 * L'échec d'un message libre. Appelé seulement sur un `failed` qui n'a touché aucun destinataire de campagne
 * (dont la ligne porte déjà l'échec) : un statut ordinaire ne coûte aucune requête de plus. Implémenté par
 * `PgEchecsMessagesStore` (`src/delivery/echecs-messages.pg.ts`).
 */
export interface EchecsLibresSink {
  noter(e: { messageId: string; code: number | null; motif: string | null; tenantId?: string }): Promise<unknown>;
}

/**
 * Les puits secondaires d'un accusé, ce que `processStatuses` fait en plus de la livraison. 🔴 `tarifs` est
 * obligatoire : un puits qu'on peut omettre est un puits qu'on oublie ; un appel qui ne mesure pas les tarifs
 * le dit avec la fixture `aucunTarif` (`tests/webhook-fixtures.ts`).
 */
export interface PuitsAccuses {
  tarifs: TarifsMetaSink;
  /** Obligatoire aussi, pour la même raison ; les tests qui n'en parlent pas passent `aucunEchecLibre`. */
  echecsLibres: EchecsLibresSink;
  nodeEvents?: NodeStatusSink;
  remiseMba?: RemiseMbaSurAccuse;
  /** Les signaux ; requis au niveau du handler, seul appelant de production. */
  signaux?: SignalAccuse;
}

/**
 * Applique les événements de statut aux destinataires (par message_id), et ignore le reste. `nodeEvents` reçoit
 * le même statut pour la mesure par bloc, sauf `sent`, déjà compté par l'exécuteur à l'envoi. Best-effort sur la
 * mesure : une panne de compteur n'empêche pas la mise à jour d'une livraison. Les puits secondaires voyagent
 * dans `puits`, nommés et jamais positionnels.
 */
export async function processStatuses(
  events: WebhookEvent[],
  delivery: DeliveryStore,
  puits: PuitsAccuses,
): Promise<void> {
  const { tarifs, echecsLibres, nodeEvents, remiseMba, signaux } = puits;
  for (const ev of events) {
    if (ev.source !== 'statuses') continue;
    /**
     * Le tarif de Meta (`./tarif-meta.ts`), lu avant la garde de livraison : un statut que la livraison ignore peut
     * porter un tarif. Best-effort : une exception ferait rejouer tout le job ; un tarif manqué laisse le message
     * compté comme payant.
     */
    if (ev.phoneNumberId) {
      const t = extraireTarif(ev.data);
      if (t) {
        try {
          await tarifs.enregistrer(ev.phoneNumberId, t);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error('tarif Meta non enregistré:', messageDe(err));
        }
      }
    }
    const d = extractDelivery(ev.data);
    if (!d) continue;
    const touches = await delivery.updateDeliveryByMessageId(d.messageId, d.status, d.error, d.errorCode);
    /**
     * L'échec d'un message libre (réponse d'Inbox, message d'API ou de bloc) : il ne touche aucun destinataire de
     * campagne (`touches` vaut 0), seul cas qui paie une requête de plus. Best-effort : une exception ferait
     * rejouer tout le job pour un journal.
     */
    if (d.status === 'failed' && touches === 0) {
      await tenter('échec de message libre non journalisé:', () => echecsLibres.noter({ messageId: d.messageId, code: d.errorCode, motif: d.error }));
    }
    /**
     * Tous les statuts, pas seulement `sent` ni les succès : on attend la preuve que Meta a fini de traiter l'envoi,
     * et un `failed` la porte aussi. Plusieurs statuts arrivent pour un même message : la consommation atomique en
     * base fait qu'un seul déclenche la remise. Best-effort : une remise ratée est rattrapée par le balayage, alors
     * qu'une exception ferait rejouer tout le job.
     */
    if (remiseMba) {
      await tenter('remise du fil à l’agent de Meta ignorée:', () => remiseMba(d.messageId));
    }
    if (nodeEvents && d.status !== 'sent') {
      try {
        await nodeEvents.recordStatusForMessage(d.messageId, d.status);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('mesure de bloc (statut) ignorée:', messageDe(err));
      }
    }
    // Les signaux, en dernier et isolés : ils ne décident de rien pour la livraison, et le puits ne lit rien quand
    // personne n'écoute.
    if (signaux && ev.phoneNumberId) {
      try {
        await signaux(ev.phoneNumberId, {
          messageId: d.messageId,
          status: d.status,
          waId: destinataireDuStatut(ev.data),
          motif: d.error,
          codeMeta: d.errorCode,
          le: instantDuStatut(ev.data),
        });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('signal d’accusé ignoré:', messageDe(err));
      }
    }
  }
}
