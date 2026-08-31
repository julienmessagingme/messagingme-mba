import { describe, it, expect } from 'vitest';
import { nAQueDesAccuses } from '../src/webhooks/parse';

const statut = (id: string, status: string) => ({
  entry: [{ changes: [{ field: 'statuses', value: { metadata: { phone_number_id: 'pn' }, statuses: [{ id, status }] } }] }],
});
const message = (id: string) => ({
  entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: 'pn' }, messages: [{ id, text: { body: 'coucou' } }] } }] }],
});

/**
 * AIGUILLAGE DES WEBHOOKS (lot 6 du programme, 2026-08-31).
 *
 * 🔴 Ce que ce test protège. Une campagne de 5 000 messages produit TROIS accusés de livraison par
 * destinataire. Sur une file unique, cette rafale de quinze mille jobs passait DEVANT la réponse d'un vrai
 * client, qui attendait derrière. Le classement doit donc être juste dans les deux sens : rater un accusé,
 * c'est perdre l'optimisation ; classer un MESSAGE comme un accusé, c'est retarder une conversation de
 * trente secondes et la traiter avec des dépendances amputées.
 */
describe('aiguillage : ce payload ne contient-il QUE des accusés ?', () => {
  it('accusés seuls -> oui', () => {
    expect(nAQueDesAccuses(statut('wamid.A', 'delivered'))).toBe(true);
  });

  it('🔴 message entrant -> NON (c’est une conversation, elle passe devant)', () => {
    expect(nAQueDesAccuses(message('wamid.A'))).toBe(false);
  });

  it('🔴 payload MIXTE -> NON : on renonce à l’optimisation plutôt que de risquer un retard', () => {
    const mixte = {
      entry: [{ changes: [
        { field: 'statuses', value: { statuses: [{ id: 'wamid.A', status: 'sent' }] } },
        { field: 'messages', value: { messages: [{ id: 'wamid.B' }] } },
      ] }],
    };
    expect(nAQueDesAccuses(mixte)).toBe(false);
  });

  it('🔴 un echo (MBA tient le fil) n’est PAS un accusé', () => {
    const echo = { entry: [{ changes: [{ field: 'messages', value: { message_echoes: [{ id: 'wamid.E' }] } }] }] };
    expect(nAQueDesAccuses(echo)).toBe(false);
  });

  it('🔴 un changement de contrôle du fil n’est PAS un accusé', () => {
    const handover = { entry: [{ changes: [{ field: 'messaging_handovers', value: { control_passed: {} } }] }] };
    expect(nAQueDesAccuses(handover)).toBe(false);
  });

  it('payload vide, inconnu ou malformé -> NON (défaut prudent : la file des entrants sait tout traiter)', () => {
    expect(nAQueDesAccuses({})).toBe(false);
    expect(nAQueDesAccuses(null)).toBe(false);
    expect(nAQueDesAccuses({ entry: [] })).toBe(false);
    expect(nAQueDesAccuses({ entry: [{ changes: [{ field: 'inconnu', value: {} }] }] })).toBe(false);
    expect(nAQueDesAccuses('pas un objet')).toBe(false);
  });

  it('plusieurs accusés dans plusieurs entrées -> oui', () => {
    const deux = {
      entry: [
        { changes: [{ field: 'statuses', value: { statuses: [{ id: 'wamid.A', status: 'sent' }] } }] },
        { changes: [{ field: 'statuses', value: { statuses: [{ id: 'wamid.B', status: 'read' }] } }] },
      ],
    };
    expect(nAQueDesAccuses(deux)).toBe(true);
  });
});
