import { describe, it, expect } from 'vitest';
import { CHAMP_MAINTENANT, nomDeParametreSur } from '../web/lib/partage/fonction-js';

/**
 * LA RÈGLE « QUEL NOM DE PARAMÈTRE » DU BLOC FONCTION JS, partagée par le moteur (qui injecte le paramètre) et l'écran
 * (qui l'annonce, `function (ville)`).
 *
 * 🔴 ELLE A EXISTÉ EN DEUX COPIES, ET ELLES AVAIENT DIVERGÉ : l'écran écartait `now`, que le moteur accepte. Il annonçait
 * `function (valeur)` là où `function (now)` marchait aussi. ⚠️ Le sens du défaut comptait : l'écran promettait MOINS que
 * le moteur, donc rien ne cassait, et c'est pour ça que ça pouvait durer. Il n'y a plus qu'une règle ; ces cas disent ce
 * qu'elle doit rendre.
 */
describe('le nom de paramètre d’une Fonction JS', () => {
  it('⚠️ `now` passe : c’est la divergence qui a motivé ce test', () => {
    expect(nomDeParametreSur(CHAMP_MAINTENANT)).toBe('now');
  });

  it('une clé qui est déjà un identifiant sûr devient le nom du paramètre', () => {
    for (const cle of ['ville', 'prenom', 'date_naissance', '_x', '$y', 'champ2']) expect(nomDeParametreSur(cle), cle).toBe(cle);
  });

  it('une clé qui n’en est pas un retombe sur `valeur` (la règle rend null)', () => {
    for (const cle of [undefined, '', 'mail pro', 'date-naissance', '2eme', 'é']) expect(nomDeParametreSur(cle), String(cle)).toBeNull();
  });

  it('🔴 un mot réservé, ou `valeur` déjà pris, rendrait le code invalide : refusés', () => {
    for (const cle of ['valeur', 'class', 'return', 'await', 'arguments', 'eval', 'yield']) expect(nomDeParametreSur(cle), cle).toBeNull();
  });
});
