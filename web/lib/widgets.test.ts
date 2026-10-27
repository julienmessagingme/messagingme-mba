import { describe, it, expect, vi } from 'vitest';

// Le socle HTTP est remplacé : ce module n'en a besoin que pour ses appels, que ces tests n'exercent pas.
vi.mock('./http', () => ({ request: () => Promise.resolve({}) }));

import { CLES_DE_SAISIE, ecartsDeSaisie, saisieDuWidget, sansApparence, type Widget } from './widgets';

/**
 * Ce que le formulaire envoie à la modification : l'ÉCART, et rien d'autre. C'est ce qui laisse modifier la couleur
 * d'un widget dont le scénario a été supprimé : renvoyer le devenir « scénario » sans scénario serait le CHOISIR, et
 * le serveur le refuse.
 */
const WIDGET: Widget = {
  id: 'w1', code: 'k7m2p3q4r5s6', nom: 'Blog', phrase: 'Je viens du blog', devenir: 'scenario', workflowId: null,
  couleur: '#25d366', position: 'bas_droite', libelle: null, avatarUrl: null, badge: true, actif: true, maxParHeure: null,
  createdAt: '2026-10-02T10:00:00.000Z', updatedAt: '2026-10-02T10:00:00.000Z',
  adresseScript: 'https://api.exemple.test/widget/k7m2p3q4r5s6.js',
  balise: '<script src="https://api.exemple.test/widget/k7m2p3q4r5s6.js" async></script>',
  waMeUrl: null, scenarioSupprime: true,
};

describe('ecartsDeSaisie', () => {
  it('rien de changé : rien à envoyer', () => {
    expect(ecartsDeSaisie(saisieDuWidget(WIDGET), saisieDuWidget(WIDGET))).toEqual({});
  });

  it('🔴 seule la couleur change : seule la couleur part, pas le devenir d’un widget inerte', () => {
    const avant = saisieDuWidget(WIDGET);
    expect(ecartsDeSaisie(avant, { ...avant, couleur: '#000000' })).toEqual({ couleur: '#000000' });
  });

  it('un champ facultatif vidé part en null, pour être effacé', () => {
    const avant = { ...saisieDuWidget(WIDGET), libelle: 'Une question ?' };
    expect(ecartsDeSaisie(avant, { ...avant, libelle: null })).toEqual({ libelle: null });
  });

  it('la liste des clés couvre toute la saisie : une clé oubliée ne partirait jamais', () => {
    expect([...CLES_DE_SAISIE].sort()).toEqual(Object.keys(saisieDuWidget(WIDGET)).sort());
  });
});

describe('saisieDuWidget', () => {
  it('le devenir « agent » (refusé par le serveur, absent de l’écran) ne se saisit pas : le formulaire part du réglage de l’espace', () => {
    expect(saisieDuWidget({ ...WIDGET, devenir: 'agent' }).devenir).toBeNull();
  });
});

/** Relecture de B, rouge 1 : hors offre, l’apparence ne part jamais, pour qu’aucune API ne puisse l’écrire à la place du client. */
describe('sansApparence', () => {
  it('🔴 hors offre : ni couleur, ni position, ni libellé, ni avatar dans ce qui part ; le reste part tel quel', () => {
    const saisie = { ...saisieDuWidget(WIDGET), nom: 'Nouveau', couleur: '#25d366' };
    const envoye = sansApparence(saisie, false);
    for (const cle of ['couleur', 'position', 'libelle', 'avatarUrl']) expect(envoye, cle).not.toHaveProperty(cle);
    expect(envoye).toMatchObject({ nom: 'Nouveau', phrase: 'Je viens du blog', actif: true });
  });

  it('dans l’offre : tout part', () => {
    const saisie = saisieDuWidget(WIDGET);
    expect(sansApparence(saisie, true)).toEqual(saisie);
  });
});
