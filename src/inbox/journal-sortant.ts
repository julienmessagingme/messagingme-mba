import { messageDe } from '../lib/erreur';

/** Le fournisseur a accepté l'envoi ; seul l'état de sa trace dans l'Inbox reste à établir. */
export type EtatJournalSortant = 'recorded' | 'unrecorded';

/**
 * Rejoue uniquement l'écriture idempotente du journal, jamais l'envoi au fournisseur.
 * Une erreur après le commit peut laisser son résultat incertain : la seconde tentative
 * retrouve alors le message par son identifiant fournisseur.
 */
export async function journaliserEnvoiAccepte(
  tenantId: string,
  conversationId: string,
  messageId: string,
  journaliser: () => Promise<void>,
): Promise<EtatJournalSortant> {
  try {
    await journaliser();
    return 'recorded';
  } catch {
    try {
      await journaliser();
      return 'recorded';
    } catch (err) {
      // Pas de corps dans le log : il peut contenir une réponse ou des données personnelles.
      // eslint-disable-next-line no-console
      console.error(`envoi accepté mais journal non confirmé (tenant ${tenantId}, conversation ${conversationId}, message ${messageId}):`, messageDe(err));
      return 'unrecorded';
    }
  }
}
