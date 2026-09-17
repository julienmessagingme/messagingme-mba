import { describe, it, expect } from 'vitest';
import { coutMoyenParEngagement } from './cout-moyen';

/**
 * LE CHIFFRE UNIQUE EN HAUT DE LA CARTE « COUTS ».
 *
 * 🔴 CE QUE CES TESTS PROTEGENT : il y a DEUX moyennes possibles et elles ne donnent pas le meme nombre.
 * Sur une campagne A de 5000 envois a 2 euros par engage et une campagne B de 10 envois a 40 euros, le
 * rapport des totaux rend 2,08 quand la moyenne des ratios rend 21. Les deux sont « une moyenne », les deux
 * sont plausibles, et une seule repond a la question posee. Julien a tranche le 2026-09-17 : le rapport des
 * totaux, parce que le chiffre repond a « ce que m'a coute en moyenne une personne engagee », qui est une
 * question de budget. La moyenne des ratios repond a « mes campagnes sont-elles bien calibrees », ou un
 * essai a 10 envois pese autant qu une campagne a 5000.
 *
 * ⚠️ Aucun test ici ne verifie « la fonction rend un nombre ». Ce qui casse en production, ce n'est pas
 * l'absence de resultat, c'est un resultat CREDIBLE et faux.
 */

const L = (cout: number | null, engagements: number | null | undefined) => ({ cout, engagements });

describe('le cout moyen par engagement', () => {
  it('🔴 c est le COUT TOTAL divise par les ENGAGES TOTAUX, pas la moyenne des ratios', () => {
    // A : 10 000 euros pour 5000 engages (2 euros). B : 400 euros pour 10 engages (40 euros).
    // Rapport des totaux : 10 400 / 5010 = 2,0758. Moyenne des ratios : 21. L'ecart entre les deux est
    // exactement ce que ce test existe pour empecher.
    expect(coutMoyenParEngagement([L(10000, 5000), L(400, 10)]).valeur).toBe(2.0758);
  });

  it('une seule campagne : le chiffre est son propre ratio', () => {
    expect(coutMoyenParEngagement([L(100, 50)]).valeur).toBe(2);
  });

  it('🔴 une campagne SANS cout chiffrable sort des DEUX termes, et se compte a part', () => {
    // La garder au denominateur ferait BAISSER le cout moyen a cause d'une campagne dont on ignore le prix.
    // Le chiffre descendrait sans qu'un seul euro soit economise, ce qui est pire que de ne pas la compter.
    const r = coutMoyenParEngagement([L(100, 50), L(null, 30)]);
    expect(r.valeur).toBe(2);
    expect(r.campagnes).toBe(1);
    expect(r.ecartees).toBe(1);
  });

  it('🔴 une campagne sans AUCUN engage sort aussi : elle n est pas une division par zero', () => {
    const r = coutMoyenParEngagement([L(100, 50), L(80, 0)]);
    expect(r.valeur).toBe(2);
    expect(r.ecartees).toBe(1);
  });

  it('🔴 aucune campagne chiffrable : `null`, JAMAIS zero', () => {
    // Un « 0 euro par engage » se lirait « c'est gratuit ». La carte doit dire qu'elle ne sait pas, ce qui
    // est la regle que tout `cost.ts` applique deja a ses cases vides.
    expect(coutMoyenParEngagement([L(null, 10)]).valeur).toBeNull();
    expect(coutMoyenParEngagement([L(100, 0)]).valeur).toBeNull();
    expect(coutMoyenParEngagement([]).valeur).toBeNull();
  });

  it('⚠️ `undefined` se traite comme `null` : une API plus ancienne ne rend pas encore le champ', () => {
    // 🔴 LE CAS EST REEL SUR CE PRODUIT. La console part sur Vercel a chaque push, l'API se deploie a la
    // main sur le VPS : entre les deux, `engagements` est absent de la reponse. Le traiter comme zero
    // ferait afficher un cout moyen calcule sur un denominateur invente.
    const r = coutMoyenParEngagement([L(100, 50), L(80, undefined)]);
    expect(r.valeur).toBe(2);
    expect(r.ecartees).toBe(1);
  });

  it('⚠️ un cout de ZERO est une mesure VALIDE, il ne sort pas', () => {
    // Zero euro pour 10 engages est une campagne dont tous les envois etaient gratuits (franchise). C'est
    // different de « on ne sait pas ce qu'elle a coute », et un `if (!cout)` les confondrait.
    const r = coutMoyenParEngagement([L(0, 10), L(100, 40)]);
    expect(r.valeur).toBe(2);
    expect(r.campagnes).toBe(2);
    expect(r.ecartees).toBe(0);
  });

  it('⚠️ arrondi a QUATRE decimales, comme les autres ratios de coût du depot', () => {
    // 7 / 3 = 2,333333... Deux arrondis differents sur le meme ecran feraient diverger ce chiffre de la
    // somme de l'accordeon juste en dessous.
    expect(coutMoyenParEngagement([L(7, 3)]).valeur).toBe(2.3333);
  });

  it('⚠️ il compte les campagnes RETENUES, pas celles qu on lui a passees', () => {
    // Le chiffre « sur N campagnes mesurees » qui accompagne le total doit designer le denominateur reel,
    // sinon la phrase de l'ecran decrit un ensemble qui n'est pas celui du calcul.
    const r = coutMoyenParEngagement([L(100, 50), L(null, 30), L(80, 0), L(20, 10)]);
    expect(r.campagnes).toBe(2);
    expect(r.ecartees).toBe(2);
  });
});
