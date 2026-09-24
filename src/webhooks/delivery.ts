import type { WebhookEvent } from './parse';
import { extraireTarif, type TarifsMetaSink } from './tarif-meta';
import { asRecord } from './json';

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
 * Ce que la remontée des SIGNAUX reçoit d'un accusé (spec 2026-09-24, § 8).
 *
 * 🔴 BEST-EFFORT, ET GRATUIT PAR DÉFAUT : ce chemin traite chaque accusé de chaque message de la plateforme. Le
 * puits décide lui-même de ne rien lire (statut `sent`, aucun espace branché) ; il ne doit jamais faire échouer
 * le traitement d'une livraison, qui est la donnée métier.
 */
export interface AccuseDuStatut {
  messageId: string;
  status: DeliveryStatus;
  /** Le destinataire tel que Meta le nomme (`recipient_id`) : numéro en chiffres nus, ou BSUID. */
  waId: string | null;
  motif: string | null;
  codeMeta: number | null;
  /** L'instant que Meta a daté (`timestamp`), en ISO ; `null` s'il manque. La file des accusés peut avoir du retard. */
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
 * Rattache un accusé Meta au bloc de scénario qui a envoyé ce message (« Mes tableaux »). Optionnel : un
 * identifiant qui n'appartient à aucun envoi de scénario ne crée rien, cette fonction voit TOUS les statuts.
 */
export interface NodeStatusSink {
  recordStatusForMessage(metaMessageId: string, kind: 'delivered' | 'read' | 'failed'): Promise<number>;
}

/**
 * LA REMISE DU FIL À L'AGENT DE META, DÉCLENCHÉE PAR L'ACCUSÉ DE NOTRE DERNIER ENVOI (migration 0149).
 *
 * 🔴 C'EST ICI QUE LE SIGNAL VRAI ARRIVE, ET NULLE PART AILLEURS. Envoyer un message PREND le fil
 * implicitement : relâcher dans la foulée d'un envoi relâche donc un fil que cet envoi reprend juste
 * derrière. Le seul moment où l'on SAIT que Meta a fini de traiter notre envoi est celui où son statut nous
 * revient.
 *
 * ⚠️ CE COMMENTAIRE A ANNONCÉ « DEUX MINUTES DE RETARD CHEZ META » : c'était FAUX, corrigé le 2026-09-15 au
 * soir. L'horodatage que Meta met dans ses accusés vaut la seconde de l'envoi, et son webhook arrive une
 * seconde après. Les deux minutes étaient celles de NOTRE file d'accusés. Le détail dans
 * `PgInboxStore.demanderReleaseMba`.
 *
 * ⚠️ APPELÉE POUR CHAQUE STATUT, y compris les millions qui n'attendent rien : l'implémentation rend la main
 * tout de suite quand aucun fil n'attend ce message (un `update ... where` qui ne touche aucune ligne).
 *
 * ⚠️ OPTIONNELLE : absente, les fils sont rendus par le balayage de contrôle, plus tard. C'est une accélération
 * du chemin nominal, pas la seule garantie.
 */
export interface RemiseMbaSurAccuse {
  (messageId: string): Promise<void>;
}

/**
 * L'ÉCHEC D'UN MESSAGE LIBRE (spec 2026-09-24, § 5, « défaut 4 »).
 *
 * 🔴 APPELÉ SEULEMENT SUR UN `failed` QUI N'A TOUCHÉ AUCUN DESTINATAIRE DE CAMPAGNE : un statut ordinaire ne
 * coûte aucune requête de plus, et l'échec d'un destinataire de campagne est déjà porté par sa ligne.
 * Implémenté par `PgEchecsMessagesStore` (`src/delivery/echecs-messages.pg.ts`).
 */
export interface EchecsLibresSink {
  noter(e: { messageId: string; code: number | null; motif: string | null; tenantId?: string }): Promise<unknown>;
}

/**
 * LES PUITS SECONDAIRES D'UN ACCUSÉ, ce que `processStatuses` fait EN PLUS de la livraison.
 *
 * 🔴 `tarifs` EST OBLIGATOIRE, et c'est la leçon des dépendances optionnelles de ce dépôt (`estDesabonne`,
 * `garde`) : un puits qu'on peut omettre est un puits qu'on oublie, sans erreur ni trace. Un appel qui ne
 * mesure pas les tarifs le DIT, avec la fixture `aucunTarif` de `tests/webhook-fixtures.ts`, au lieu de le
 * taire. Les deux autres restent optionnels : ils étaient déjà là, et les rendre obligatoires est un autre
 * sujet que celui de cette revue.
 */
export interface PuitsAccuses {
  tarifs: TarifsMetaSink;
  /**
   * 🔴 OBLIGATOIRE, comme `tarifs` et pour la même raison : un puits qu'on peut omettre est un puits qu'on
   * oublie. Les tests qui n'en parlent pas passent `aucunEchecLibre` (`tests/webhook-fixtures.ts`).
   */
  echecsLibres: EchecsLibresSink;
  nodeEvents?: NodeStatusSink;
  remiseMba?: RemiseMbaSurAccuse;
  /** Les signaux (spec 2026-09-24, § 8). Requis au niveau du handler, qui est le seul appelant de production. */
  signaux?: SignalAccuse;
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
 *
 * Les puits secondaires voyagent dans `puits`, NOMMÉS et jamais positionnels : un quatrième s'ajoute par
 * son nom, là où une queue de paramètres optionnels se perd en silence (revue finale du 2026-09-23).
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
     * LE TARIF DE META (lot 1 des publicités Click-to-WhatsApp, `./tarif-meta.ts`).
     *
     * ⚠️ AVANT la garde de livraison : un statut que la livraison ignore peut porter un tarif.
     * ⚠️ BEST-EFFORT, comme la remise du fil plus bas : une exception ferait rejouer TOUT le job par pg-boss.
     * Un tarif manqué laisse le message compté comme payant, c'est-à-dire le comportement d'avant.
     */
    if (ev.phoneNumberId) {
      const t = extraireTarif(ev.data);
      if (t) {
        try {
          await tarifs.enregistrer(ev.phoneNumberId, t);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error('tarif Meta non enregistré:', err instanceof Error ? err.message : err);
        }
      }
    }
    const d = extractDelivery(ev.data);
    if (!d) continue;
    const touches = await delivery.updateDeliveryByMessageId(d.messageId, d.status, d.error, d.errorCode);
    /**
     * 🔴 L'ÉCHEC D'UN MESSAGE LIBRE, ÉCRIT NULLE PART JUSQU'ICI (défaut 4). Une réponse de l'Inbox, un message
     * de l'API ou d'un bloc de scénario qui échoue n'est pas un destinataire de campagne : `touches` vaut 0,
     * et c'est le seul cas qui paie une requête de plus.
     * ⚠️ BEST-EFFORT : une exception ici ferait rejouer tout le job par pg-boss pour un journal.
     */
    if (d.status === 'failed' && touches === 0) {
      try {
        await echecsLibres.noter({ messageId: d.messageId, code: d.errorCode, motif: d.error });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('échec de message libre non journalisé:', err instanceof Error ? err.message : err);
      }
    }
    /**
     * 🔴 TOUS LES STATUTS, PAS SEULEMENT `sent`, ET PAS SEULEMENT LES SUCCÈS. Ce qu'on attend n'est pas une
     * bonne nouvelle, c'est la PREUVE que Meta a fini de traiter cet envoi : un `failed` la porte aussi, et
     * un fil qui attendrait un `sent` qui ne viendra jamais resterait gelé jusqu'au balayage. Plusieurs
     * statuts arrivent pour le même message : c'est la consommation atomique, côté base, qui fait qu'un seul
     * déclenche la remise.
     *
     * ⚠️ BEST-EFFORT, comme la mesure par bloc juste en dessous : une remise ratée est rattrapée par le
     * balayage de contrôle, tandis qu'une exception ici ferait rejouer TOUT le job par pg-boss, donc
     * re-traiterait des statuts déjà appliqués pour un motif secondaire.
     */
    if (remiseMba) {
      try {
        await remiseMba(d.messageId);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('remise du fil à l’agent de Meta ignorée:', err instanceof Error ? err.message : err);
      }
    }
    if (nodeEvents && d.status !== 'sent') {
      try {
        await nodeEvents.recordStatusForMessage(d.messageId, d.status);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('mesure de bloc (statut) ignorée:', err instanceof Error ? err.message : err);
      }
    }
    // 🔴 LES SIGNAUX (spec 2026-09-24, § 8), EN DERNIER ET ISOLÉS : ils ne décident de rien pour la livraison,
    // et le puits se charge de ne rien lire quand personne n'écoute.
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
        console.error('signal d’accusé ignoré:', err instanceof Error ? err.message : err);
      }
    }
  }
}
