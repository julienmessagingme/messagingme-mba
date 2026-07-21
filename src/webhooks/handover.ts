import type { ControlOwner } from '../inbox/store.pg';

/**
 * Changements de contrôle du fil annoncés par Meta (`messaging_handovers`), et messages que l'agent de
 * Meta a envoyés en notre nom (`standby`).
 *
 * PRÉ-CÂBLAGE. Ce module est INERTE tant que MBA n'est activé sur aucun numéro : sans MBA, Meta n'émet ni
 * `messaging_handovers` ni `standby`, donc rien ne l'atteint. Il est écrit maintenant pour que le jour où
 * un numéro devient éligible, le mécanisme soit déjà là et surtout OBSERVABLE : sans lui, on découvrirait
 * les bascules de contrôle en constatant que le bot ne répond plus, sans rien pour comprendre pourquoi.
 *
 * ⚠️ LA FORME DU PAYLOAD EST DEVINÉE. La documentation Meta décrit la SÉMANTIQUE de `standby` et de
 * `messaging_handovers` (qui répond, sur quel champ arrive quoi) mais ne donne NULLE PART la structure du
 * corps. Tout est donc traité en champ optionnel, rien ne plante sur une forme inattendue, et ce qui n'est
 * pas reconnu est JOURNALISÉ intégralement au lieu d'être avalé. C'est cette trace qui permettra, au
 * premier test réel, de découvrir la vraie forme et d'ajuster.
 */

export interface HandoverDeps {
  /** Tenant propriétaire du numéro business. null si inconnu. */
  phoneNumberTenant(phoneNumberId: string): Promise<string | null>;
  /** Pose le détenteur du fil (sans condition : Meta fait autorité sur qui détient quoi). */
  setControlOwner(tenantId: string, waId: string, owner: ControlOwner): Promise<boolean>;
  /** Journalise dans le fil un message envoyé par l'agent de Meta, pour que l'opérateur le voie. */
  recordAgentMessage?(tenantId: string, waId: string, body: string, messageId: string | null): Promise<void>;
}

const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

/** Trace structurée : c'est elle qu'on lira pendant le premier test MBA. */
function trace(msg: string, extra: Record<string, unknown>): void {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ lvl: 'info', msg, ...extra }));
}

/**
 * À qui Meta dit-il que le fil appartient désormais ?
 *
 * Le vocabulaire du protocole de handover vient de Messenger, où l'app cible est désignée par un
 * identifiant. On reconnaît donc les deux formulations plausibles sans en privilégier une : un champ qui
 * nomme explicitement l'agent, ou une paire prise/rendue. Tout le reste rend `null`, ce qui déclenche la
 * journalisation du payload complet plutôt qu'une supposition.
 */
export function ownerFromHandover(value: Record<string, unknown>): ControlOwner | null {
  const brut = JSON.stringify(value).toLowerCase();
  const prise = str(value['take_thread_control']) !== undefined || 'take_thread_control' in value;
  const rendue = str(value['pass_thread_control']) !== undefined || 'pass_thread_control' in value;
  // Un contrôle PRIS par l'app (nous) : le fil revient à notre automate. Un contrôle RENDU (release) le
  // donne à l'agent de Meta, qui redevient le répondeur principal.
  if (prise && !rendue) return 'app_workflow';
  if (rendue && !prise) return 'mba';
  // Repli sur une mention explicite de l'agent, si Meta nomme le nouveau détenteur autrement.
  if (brut.includes('business_agent') || brut.includes('meta_agent')) return 'mba';
  return null;
}

/**
 * Traite les événements `messaging_handovers` et `standby` d'un payload webhook.
 *
 * ISOLÉ par l'appelant : une erreur ici ne doit jamais faire échouer le job webhook partagé avec les
 * statuts de livraison et l'inbox.
 */
export async function processHandovers(payload: unknown, deps: HandoverDeps): Promise<void> {
  for (const entryRaw of asArray(asRecord(payload)['entry'])) {
    for (const changeRaw of asArray(asRecord(entryRaw)['changes'])) {
      const change = asRecord(changeRaw);
      const field = str(change['field']);
      if (field !== 'messaging_handovers' && field !== 'standby') continue;

      const value = asRecord(change['value']);
      const phoneNumberId = str(asRecord(value['metadata'])['phone_number_id']);
      if (!phoneNumberId) {
        trace('handover_sans_numero', { field, value });
        continue;
      }
      const tenantId = await deps.phoneNumberTenant(phoneNumberId);
      if (!tenantId) {
        trace('handover_numero_inconnu', { field, phoneNumberId });
        continue;
      }

      if (field === 'messaging_handovers') {
        // Le destinataire concerné : Meta le nomme `recipient`, `to` ou `wa_id` selon les surfaces.
        const waId = str(value['recipient']) ?? str(value['to']) ?? str(value['wa_id']);
        const owner = ownerFromHandover(value);
        // On journalise TOUJOURS, reconnu ou non : c'est la trace qui servira au premier test réel.
        trace('handover_recu', { tenantId, phoneNumberId, waId: waId ?? null, owner, value });
        if (waId && owner) await deps.setControlOwner(tenantId, waId, owner);
        continue;
      }

      // `standby` : copies des messages que l'agent de Meta a envoyés en notre nom. Les afficher dans
      // l'inbox est ce qui permet à un opérateur de voir la conversation ENTIÈRE, et pas seulement sa
      // moitié. Sans ça, il reprendrait la main sans savoir ce que l'agent vient de dire.
      for (const echoRaw of asArray(value['message_echoes'])) {
        const echo = asRecord(echoRaw);
        const waId = str(echo['to']) ?? str(echo['recipient']) ?? str(value['recipient']);
        const body = str(asRecord(echo['text'])['body']) ?? str(echo['body']);
        const messageId = str(echo['id']) ?? null;
        trace('standby_echo', { tenantId, waId: waId ?? null, messageId, aUnCorps: body !== undefined });
        if (waId && body && deps.recordAgentMessage) {
          await deps.recordAgentMessage(tenantId, waId, body, messageId);
        }
      }
    }
  }
}
