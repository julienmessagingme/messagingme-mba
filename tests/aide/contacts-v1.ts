// tests/aide/contacts-v1.ts
import type { ServiceContactsV1 } from '../../src/api/contacts-v1';

/**
 * UN SERVICE DE FICHES QUI NE FAIT RIEN, pour les tests qui montent `/v1` sans éprouver les contacts
 * (envois, messages, MCP, usage, arrêt d'urgence). Écrire rend « créé » pour chaque élément, lire et
 * chercher ne trouvent rien, modifier réussit. Un test qui éprouve une route de contacts remplace la
 * méthode qui l'intéresse.
 */
export function contactsV1Muets(over: Partial<ServiceContactsV1> = {}): ServiceContactsV1 {
  return {
    ecrireFiches: async (_t, items) => items.map((_, i) => ({ index: i, status: 'created' as const, contactId: `c${i}` })),
    lireFiche: async () => null,
    chercherFiche: async () => ({ ok: true as const, fiche: null }),
    modifierFiche: async (_t, contactId) => ({ ok: true as const, contactId }),
    ...over,
  };
}
