import { messageDe } from '../lib/erreur';
import type { EntrantRattache } from './rattachement';
import type { InboundMessage } from './inbound';

/**
 * L'agent de Meta prend la conversation quand un client écrit et que personne ne suit, et il y répond tout de
 * suite. L'agent ne peut prendre un fil que dans une session ouverte, qui s'ouvre exactement quand le client écrit :
 * décidée à l'arrivée du message, la passation fonctionne quel que soit le temps écoulé ; décidée avant, sur un fil
 * muet, elle ne transmet rien. Elle répare aussi une conversation née d'un envoi sortant (`control_owner =
 * 'app_workflow'` par défaut, `control_changed_at` null), que le balayage ignore et que « À traiter » exclut.
 */
export interface RemiseMbaEntrantDeps {
  /**
   * Confie la conversation à l'agent de Meta si personne d'autre ne s'en occupe, et lui passe `contenu` pour qu'il y
   * réponde. Les gardes (agent allumé, aucun parcours en attente, aucun humain dessus) vivent dans le câblage
   * (`ControleDuFil.remettreSiPersonneNeSuit`) ; ce module ne sait que lire un payload Meta.
   */
  remettre(tenantId: string, waId: string, contenu: string): Promise<void>;
}

/**
 * Ce qu'un message dit à l'agent : son corps enregistré (texte, légende, ou libellé du média). Une réaction n'en dit
 * rien : son corps est un emoji posé sur un de nos messages, pas quelque chose à quoi répondre.
 */
function texteDuMessage(m: InboundMessage): string {
  if (m.type === 'reaction') return '';
  return m.body?.trim() ?? '';
}

/**
 * Pour chaque contact qui écrit dans ce payload, confie la conversation à l'agent de Meta quand personne ne suit.
 * Un seul geste par contact : plusieurs messages du même contact dans le même lot partent en un seul événement, leurs
 * textes mis bout à bout (la borne de l'événement s'applique au tout, `src/mba/evenement.ts`). `standby` est exclu :
 * l'agent tient déjà le fil et parle à ce contact (un `standby` d'un contact absent de sa liste est déjà devenu un
 * `messages`, `./standby-hors-liste.ts`). `consumed` est respecté : un message qui vient de démarrer un parcours, ou
 * avalé par un jeton de test, n'est pas un client qui écrit sans que rien ne soit prévu. Isolé par contact (Meta
 * groupe plusieurs contacts) ; un échec n'est jamais fatal, le balayage reste le filet.
 */
export async function processRemiseMbaEntrant(
  entrants: readonly EntrantRattache[],
  deps: RemiseMbaEntrantDeps,
  consumed?: ReadonlySet<string>,
): Promise<void> {
  const parContact = new Map<string, { tenantId: string; waId: string; textes: string[] }>();
  for (const { message: m, tenantId } of entrants) {
    if (consumed?.has(m.messageId)) continue;
    // `field` absent = anciennes fixtures, traitées comme des messages normaux (rétro-compat, comme l'avance).
    if (m.field && m.field !== 'messages') continue;
    if (!tenantId) continue;
    const cle = `${tenantId}:${m.waId}`;
    const contact = parContact.get(cle) ?? { tenantId, waId: m.waId, textes: [] };
    const texte = texteDuMessage(m);
    if (texte !== '') contact.textes.push(texte);
    parContact.set(cle, contact);
  }
  for (const { tenantId, waId, textes } of parContact.values()) {
    try {
      await deps.remettre(tenantId, waId, textes.join('\n'));
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('processRemiseMbaEntrant: remise ignorée:', messageDe(err));
    }
  }
}
