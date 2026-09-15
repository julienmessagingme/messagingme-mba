import { extractInbound } from './inbound';

/**
 * L'AGENT DE META REPREND LA MAIN QUAND UN CLIENT REVIENT ET QUE PERSONNE NE SUIT (2026-09-15).
 *
 * Demande de Julien, le jour de l'incident : « quand un client te parle 3 mois après, il faut que ce soit le
 * MBA qui réponde, c'est pour ça que ça a été créé le MBA, pour répondre quand on n'a rien préparé ».
 *
 * 🔴 LE MOMENT EST TOUT, ET C'EST LA LEÇON DES DEUX INCIDENTS. L'agent de Meta ne peut prendre un fil que
 * s'il existe une session ouverte, et cette session s'ouvre EXACTEMENT quand le client écrit. Une passation
 * décidée AVANT, par le balayage, sur un fil muet depuis huit jours, ne transmet rien : mesuré le 2026-09-15,
 * dix conversations rendues d'un coup alors qu'elles dormaient depuis 166 à 281 heures, et le message suivant
 * est arrivé en `messages` (donc chez NOUS) au lieu de `standby` (donc chez l'agent). Décidée ICI, à
 * l'arrivée du message, elle fonctionne quel que soit le temps écoulé.
 *
 * 🔴 ET ELLE RATTRAPE L'AUTRE INCIDENT SANS LE VISER. Une conversation créée par un envoi sortant porte
 * `control_owner = 'app_workflow'` (la valeur par DÉFAUT) et `control_changed_at = null`, alors qu'envoyer
 * PREND le fil chez Meta. Le balayage l'ignore, et `A_TRAITER` exclut `app_workflow` : elle était donc
 * invisible ET muette. Le message entrant la répare, puisque c'est lui qui rouvre la fenêtre.
 */
export interface RemiseMbaEntrantDeps {
  /** Tenant propriétaire du numéro business. `null` si le numéro nous est inconnu. */
  phoneNumberTenant(phoneNumberId: string): Promise<string | null>;
  /**
   * Rend le fil à l'agent de Meta SI personne d'autre ne s'en occupe. Les gardes (agent allumé, aucun
   * parcours en attente, aucun humain dessus) vivent dans le câblage, pas ici : ce module ne sait que lire
   * un payload Meta.
   */
  remettre(tenantId: string, waId: string): Promise<void>;
}

/**
 * Pour chaque message entrant d'un payload, rend le fil à l'agent de Meta quand personne ne suit.
 *
 * ⚠️ `standby` EST EXCLU, et c'est la première garde. Un `standby` signifie que l'agent de Meta tient DÉJÀ le
 * fil et que Meta nous en envoie une copie : il n'y a rien à lui rendre, et un release sur un fil qu'il
 * détient serait au mieux inutile, au pire une reprise. C'est la même lecture que `processWorkflowAdvance`
 * fait juste à côté, pour la raison symétrique.
 *
 * ⚠️ `consumed` EST RESPECTÉ. Un message qui vient de DÉMARRER un parcours, ou qui a été avalé par un jeton
 * de test, n'est pas un client qui revient sans que rien ne soit prévu : c'est exactement le contraire. La
 * garde du câblage le rattraperait (un parcours en attente existe alors), mais s'en remettre à elle ferait
 * dépendre la justesse d'ici d'un détail de là-bas.
 *
 * ⚠️ ISOLÉ PAR MESSAGE, comme ses voisins : Meta groupe plusieurs contacts dans un même webhook, et l'échec
 * de l'un ne doit pas priver les autres. Un échec ici n'est jamais fatal, le balayage reste le filet.
 */
export async function processRemiseMbaEntrant(
  payload: unknown,
  deps: RemiseMbaEntrantDeps,
  consumed?: ReadonlySet<string>,
): Promise<void> {
  for (const m of extractInbound(payload)) {
    if (consumed?.has(m.messageId)) continue;
    // `field` absent = anciennes fixtures, traitées comme des messages normaux (rétro-compat, comme l'avance).
    if (m.field && m.field !== 'messages') continue;
    try {
      const tenantId = await deps.phoneNumberTenant(m.phoneNumberId);
      if (tenantId) await deps.remettre(tenantId, m.waId);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('processRemiseMbaEntrant: remise ignorée:', err instanceof Error ? err.message : err);
    }
  }
}
