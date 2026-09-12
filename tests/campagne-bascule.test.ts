import { describe, expect, it } from 'vitest';
import { decider } from '../src/campaign/bascule';
import type { Etage } from '../src/campaign/etages';

const CHAINE: Etage[] = [{ rang: 1, canal: 'whatsapp' }, { rang: 2, canal: 'rcs' }];
const SEUL: Etage[] = [{ rang: 1, canal: 'whatsapp' }];
const base = { rangCourant: 1, reessayer: true, dejaReessaye: false, emailDuContact: null };

describe('decider', () => {
  // 🔴 AVEC CHAÎNE : TOUT code bascule au PREMIER échec, sans exception.
  it('avec chaine, 131026 bascule des le premier echec', () => {
    expect(decider({ ...base, codeErreur: 131026, chaine: CHAINE })).toEqual({ type: 'bascule', rang: 2 });
  });
  it('avec chaine, 131049 bascule des le premier echec', () => {
    expect(decider({ ...base, codeErreur: 131049, chaine: CHAINE })).toEqual({ type: 'bascule', rang: 2 });
  });
  it('avec chaine, un code quelconque bascule des le premier echec', () => {
    expect(decider({ ...base, codeErreur: 133016, chaine: CHAINE })).toEqual({ type: 'bascule', rang: 2 });
  });

  // 🔴 SANS CHAÎNE : 131026 est terminal MÊME si l'option de réessai est cochée.
  it('sans chaine, 131026 est terminal meme avec l option cochee', () => {
    expect(decider({ ...base, codeErreur: 131026, chaine: SEUL, reessayer: true }))
      .toEqual({ type: 'terminal', motif: 'numero sans WhatsApp' });
  });

  it('sans chaine, 131049 reessaie le lendemain matin', () => {
    expect(decider({ ...base, codeErreur: 131049, chaine: SEUL })).toEqual({ type: 'reessai_demain_matin' });
  });

  it('sans chaine, un autre code reessaie si l option est cochee', () => {
    expect(decider({ ...base, codeErreur: 133016, chaine: SEUL })).toEqual({ type: 'reessai' });
  });

  it('sans chaine et option decochee, terminal du premier coup', () => {
    expect(decider({ ...base, codeErreur: 133016, chaine: SEUL, reessayer: false }))
      .toEqual({ type: 'terminal', motif: 'reessai desactive' });
  });

  it('un reessai deja consomme devient terminal', () => {
    expect(decider({ ...base, codeErreur: 133016, chaine: SEUL, dejaReessaye: true }))
      .toEqual({ type: 'terminal', motif: 'reessai deja consomme' });
  });

  // ⚠️ Au dernier étage d'une chaîne, il n'y a plus rien après.
  it('au dernier etage, terminal', () => {
    expect(decider({ ...base, rangCourant: 2, codeErreur: 131026, chaine: CHAINE }))
      .toEqual({ type: 'terminal', motif: 'plus d etage disponible' });
  });
});

/**
 * Les cas que la spec n'énumère pas mais dont l'implémentation dépend. Ils sont ici parce qu'un
 * lecteur qui change `decider` doit voir ce qui casse, pas le deviner.
 *
 * 🔴 LE JEU DE DONNÉES SÉPARE L'IMPLÉMENTATION JUSTE DE LA FAUSSE, c'est sa seule raison d'être. Une
 * chaîne `[1, 2]` ne discrimine pas `rangSuivant` d'un `rangCourant + 1` ni d'un « élément suivant du
 * tableau » : les trois rendent 2. La chaîne trouée et la chaîne désordonnée ci-dessous, si.
 */
describe('decider : les cas qui discriminent', () => {
  // Chaîne TROUÉE (l'étage 2 a été retiré) : le repli utile est le 3, pas « rien ».
  const TROUEE: Etage[] = [{ rang: 1, canal: 'whatsapp' }, { rang: 3, canal: 'email' }];
  it('une chaine trouee bascule au rang REELLEMENT suivant, pas a rangCourant + 1', () => {
    expect(decider({ ...base, codeErreur: 131026, chaine: TROUEE })).toEqual({ type: 'bascule', rang: 3 });
  });

  // Chaîne DÉSORDONNÉE : rien ne trie les lignes d'un `select`, et un appelant ne trie pas non plus.
  // 🔴 LES RANGS SONT `[3, 1]` ET NON `[3, 1, 2]`, ET C'EST TOUT L'INTÉRÊT DU JEU DE DONNÉES. Avec le
  // 2 au milieu, une implémentation par « élément suivant du tableau » trouve le rang 1 en position 1,
  // prend la position 2, y lit le rang 2, et rend la BONNE réponse par hasard : c'est le cas de test
  // qui ne discriminait rien au lot 2. Sans le 2, la même implémentation sort du tableau et rend un
  // terminal, donc elle se voit.
  const DESORDRE: Etage[] = [{ rang: 3, canal: 'email' }, { rang: 1, canal: 'whatsapp' }];
  it('une chaine desordonnee ne fait pas revenir en arriere', () => {
    expect(decider({ ...base, codeErreur: 131026, chaine: DESORDRE })).toEqual({ type: 'bascule', rang: 3 });
  });

  // ⚠️ Une chaîne VIDE n'est pas une chaîne de repli : c'est le cas dégradé (campagne créée avant
  // 0134 et non reprise, ou chaîne effacée). On retombe sur la politique de réessai, jamais sur un
  // terminal « plus d'étage » qui ferait croire qu'un repli a été tenté.
  it('une chaine vide retombe sur la politique de reessai', () => {
    expect(decider({ ...base, codeErreur: 133016, chaine: [] })).toEqual({ type: 'reessai' });
  });

  // Un échec SANS code (coupure réseau dont le transport a épuisé les tentatives) n'est ni 131026 ni
  // 131049 : il suit la règle générale.
  it('un echec sans code suit la regle generale', () => {
    expect(decider({ ...base, codeErreur: null, chaine: SEUL })).toEqual({ type: 'reessai' });
    expect(decider({ ...base, codeErreur: null, chaine: CHAINE })).toEqual({ type: 'bascule', rang: 2 });
  });

  // 🔴 131026 EST TERMINAL AVANT TOUT LE RESTE, et le motif le dit. Décoché ou déjà consommé, le
  // geste ne change pas, mais « numéro sans WhatsApp » est la vraie raison et « réessai désactivé »
  // en serait une fausse : l'écran la recopierait.
  it('sans chaine, 131026 garde son motif meme quand le reessai est ferme par ailleurs', () => {
    expect(decider({ ...base, codeErreur: 131026, chaine: SEUL, reessayer: false }))
      .toEqual({ type: 'terminal', motif: 'numero sans WhatsApp' });
    expect(decider({ ...base, codeErreur: 131026, chaine: SEUL, dejaReessaye: true }))
      .toEqual({ type: 'terminal', motif: 'numero sans WhatsApp' });
  });

  // ⚠️ La fenêtre matinale de 131049 est UN réessai, elle en consomme donc le budget : une fois
  // consommé, plus de seconde chance le lendemain.
  it('131049 deja reessaye ne repart pas le lendemain matin', () => {
    expect(decider({ ...base, codeErreur: 131049, chaine: SEUL, dejaReessaye: true }))
      .toEqual({ type: 'terminal', motif: 'reessai deja consomme' });
  });

  // 🔴 AU DERNIER ÉTAGE, LA POLITIQUE DE RÉESSAI NE REPREND PAS LA MAIN. La chaîne EST le rattrapage :
  // lui ajouter un réessai par étage multiplierait les envois sans que personne ne l'ait demandé.
  it('au dernier etage, ni reessai ni reessai_demain_matin', () => {
    expect(decider({ ...base, rangCourant: 2, codeErreur: 133016, chaine: CHAINE }))
      .toEqual({ type: 'terminal', motif: 'plus d etage disponible' });
    expect(decider({ ...base, rangCourant: 2, codeErreur: 131049, chaine: CHAINE }))
      .toEqual({ type: 'terminal', motif: 'plus d etage disponible' });
  });
});
