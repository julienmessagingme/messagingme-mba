import { describe, expect, it } from 'vitest';
import { detailDesEcartes, messageAucunDestinataire } from './campagne-ecartes';

/**
 * CE QUE CES CAS SÉPARENT.
 *
 * 🔴 LA PHRASE ENVOIE CORRIGER QUELQUE CHOSE, et la mauvaise phrase envoie corriger la mauvaise chose.
 * L'écran en service portait un texte FIGÉ sur « la variable du template » : sur un écart de consentement
 * il envoyait l'opérateur compléter des fiches qui n'avaient rien, et sur une campagne RCS il nommait une
 * variable que ce canal n'a pas. Chaque motif est donc exercé SEUL, puis MÉLANGÉ.
 */
describe('le detail des ecartes', () => {
  it('un motif seul ne nomme que lui', () => {
    expect(detailDesEcartes([{ reason: 'not_opted_in' }, { reason: 'not_opted_in' }]))
      .toBe('2 sans opt-in (une campagne marketing l’exige)');
  });

  it('l autre motif seul ne nomme que lui non plus', () => {
    expect(detailDesEcartes([{ reason: 'missing_variable' }])).toBe('1 sans valeur pour une variable du modèle');
  });

  // ⚠️ LES DEUX À LA FOIS : chacun avec SON compte, pas un total attribué au premier trouvé.
  it('les deux motifs sont ventiles, chacun avec son compte', () => {
    const d = detailDesEcartes([
      { reason: 'missing_variable' }, { reason: 'not_opted_in' }, { reason: 'missing_variable' },
    ]);
    expect(d).toContain('2 sans valeur');
    expect(d).toContain('1 sans opt-in');
  });
});

describe('le message « aucun destinataire »', () => {
  /**
   * 🔴 LA CORRECTION SUIT LE MOTIF. Tous sans consentement : le geste est de passer la campagne en
   * « Service » ou de changer d'audience, JAMAIS de compléter des fiches.
   */
  it('tous sans consentement : la correction ne parle pas de fiches', () => {
    const m = messageAucunDestinataire([{ reason: 'not_opted_in' }, { reason: 'not_opted_in' }]);
    expect(m).toMatch(/consentement/i);
    expect(m).not.toMatch(/fiches/i);
  });

  // 🔴 L'AUTRE SENS : dès qu'UN SEUL écart vient d'une variable, la correction parle des fiches. Sans ce
  // cas, une implémentation qui donnerait toujours la phrase du consentement passerait le cas du dessus.
  it('un seul ecart de variable suffit a changer la correction', () => {
    const m = messageAucunDestinataire([{ reason: 'not_opted_in' }, { reason: 'missing_variable' }]);
    expect(m).toMatch(/variable|fiches/i);
  });

  /**
   * 🔴 ZÉRO ÉCART ET ZÉRO DESTINATAIRE EST UN CAS RÉEL (une audience dont tout est bloqué ou déjà sorti),
   * et la phrase de l'écran en service y devenait absurde : « les 0 contact(s) sélectionné(s) ont été
   * écartés ». On constate au lieu de compter.
   */
  it('sans aucun ecart, la phrase ne compte pas zero ecarte', () => {
    const m = messageAucunDestinataire([]);
    expect(m).not.toMatch(/les 0 contact/);
    expect(m).toMatch(/aucun contact joignable/i);
  });

  /**
   * 🔴 LA CAMPAGNE EXISTE DÉJÀ quand cette phrase s'affiche : la création a réussi, seul le LANCEMENT est
   * refusé. Sans cette précision, l'opérateur corrige puis recommence depuis le début et se retrouve avec
   * deux campagnes du même nom, dont une vide.
   */
  it('elle dit que la campagne est deja creee, pour ne pas la recreer en double', () => {
    expect(messageAucunDestinataire([{ reason: 'missing_variable' }])).toMatch(/déjà|bien été créée/i);
  });
});
