import { messageDe } from '../lib/erreur';
import type { EntrantRattache } from './rattachement';
import type { InboundMessage } from './inbound';

/**
 * L'agent de Meta (ou l'agent IA répondeur de l'espace, lot 5) prend la conversation quand un client écrit et que
 * personne ne suit, et il y répond tout de suite. L'agent ne peut prendre un fil que dans une session ouverte, qui s'ouvre exactement quand le client écrit :
 * décidée à l'arrivée du message, la passation fonctionne quel que soit le temps écoulé ; décidée avant, sur un fil
 * muet, elle ne transmet rien. Elle répare aussi une conversation née d'un envoi sortant (`control_owner =
 * 'app_workflow'` par défaut, `control_changed_at` null), que le balayage ignore et que « À traiter » exclut.
 */
export interface RemiseMbaEntrantDeps {
  /**
   * Confie la conversation à l'agent de Meta si personne d'autre ne s'en occupe, et lui passe `contenu` pour qu'il y
   * réponde. Les gardes (agent allumé, aucun parcours en attente, l'équipe dans son délai de reprise) vivent dans le
   * câblage (`ControleDuFil.remettreSiPersonneNeSuit`) ; ce module ne sait que lire un payload Meta. `entree.rouverte` :
   * un message de ce contact vient de sortir la conversation de « Traité » ou d'Archivé, ce qui ouvre une demande
   * quand l'équipe garde le fil. `entree.messageDeclencheur` : le dernier message retenu du contact ;
   * `entree.redelivre` : Meta les avait tous déjà livrés (`alreadySeen`) ; `entree.reactionsSeules` : ce ne sont que
   * des réactions (un emoji posé sur un de nos messages, ou son retrait). Le répondeur IA en a besoin pour ne pas
   * répondre deux fois au même message, ni à un pouce levé ; l'agent de Meta les ignore.
   */
  remettre(
    tenantId: string, waId: string, contenu: string,
    entree: { rouverte: boolean; messageDeclencheur: string | null; redelivre: boolean; reactionsSeules: boolean },
  ): Promise<void>;
}

/**
 * Ce qu'un message dit à l'agent : son corps enregistré (texte, légende, ou libellé du média). Un vocal part donc
 * comme `[audio]`, jamais avec sa transcription : elle ne se fait qu'à la demande d'un opérateur, bien après ce
 * webhook. Une réaction n'en dit rien : son corps est un emoji posé sur un de nos messages, pas quelque chose à quoi
 * répondre.
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
 *
 * `rouvertes` : les messages dont l'écriture a rouvert la conversation (`processInbound`). Un contact est dit rouvert
 * si l'un de ses messages retenus l'a fait, hors réaction : un 👍 sort d'Archivé sans rien demander à l'équipe.
 *
 * `dejaVus` : les messages que Meta avait déjà livrés (`alreadySeen` du handler). Un contact est dit redélivré si TOUS
 * ses messages retenus l'étaient : un seul message neuf suffit à ce que quelqu'un lui doive une réponse.
 *
 * 🔴 UNE RÉACTION SE RECONNAÎT À SON TYPE, JAMAIS À UN TEXTE VIDE (relecture du lot 5, J1). Un contact n'a que des
 * réactions dans ce lot : `reactionsSeules`, et le répondeur IA ne démarre pas (l'agent de Meta, prévenu d'un texte
 * vide, se tait de même). Le texte ne suffit pas à le dire : la réponse « à côté » d'un parcours qui finit arrive à la
 * remise avec un contenu vide par construction (`confierAuRepondeur`), et à elle, il faut répondre. Le message
 * déclencheur est le dernier qui n'est PAS une réaction : redélivré, c'est lui que le parcours du répondeur doit
 * reconnaître comme déjà reçu.
 */
export async function processRemiseMbaEntrant(
  entrants: readonly EntrantRattache[],
  deps: RemiseMbaEntrantDeps,
  consumed?: ReadonlySet<string>,
  rouvertes: ReadonlySet<string> = new Set(),
  dejaVus: ReadonlySet<string> = new Set(),
): Promise<void> {
  const parContact = new Map<string, {
    tenantId: string; waId: string; textes: string[]; rouverte: boolean; dernier: string | null; redelivre: boolean;
    reactionsSeules: boolean;
  }>();
  for (const { message: m, tenantId } of entrants) {
    if (consumed?.has(m.messageId)) continue;
    // `field` absent = anciennes fixtures, traitées comme des messages normaux (rétro-compat, comme l'avance).
    if (m.field && m.field !== 'messages') continue;
    if (!tenantId) continue;
    const cle = `${tenantId}:${m.waId}`;
    const contact = parContact.get(cle)
      ?? { tenantId, waId: m.waId, textes: [], rouverte: false, dernier: null, redelivre: true, reactionsSeules: true };
    const texte = texteDuMessage(m);
    if (texte !== '') contact.textes.push(texte);
    const reaction = m.type === 'reaction';
    if (!reaction && rouvertes.has(m.messageId)) contact.rouverte = true;
    if (!reaction) contact.reactionsSeules = false;
    // Le dernier dans l'ordre du lot, celui de Meta, en sautant les réactions dès que le contact a écrit autre chose :
    // c'est lui que le parcours du répondeur naît en ayant reçu.
    if (!reaction || contact.reactionsSeules) contact.dernier = m.messageId;
    if (!dejaVus.has(m.messageId)) contact.redelivre = false;
    parContact.set(cle, contact);
  }
  for (const { tenantId, waId, textes, rouverte, dernier, redelivre, reactionsSeules } of parContact.values()) {
    try {
      await deps.remettre(tenantId, waId, textes.join('\n'), { rouverte, messageDeclencheur: dernier, redelivre, reactionsSeules });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('processRemiseMbaEntrant: remise ignorée:', messageDe(err));
    }
  }
}
