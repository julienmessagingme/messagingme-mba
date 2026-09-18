import { describe, it, expect } from 'vitest';
import { GRILLE_DEFAUT, prixTemplate, grilleDepuisLigne } from '../src/stats/prix';

/**
 * LA GRILLE DE PRIX D'UN ESPACE : ce qu'il FACTURE, la ou Meta dit ce qu'il COUTE.
 *
 * 🔴 CE QUE CES TESTS PROTEGENT VRAIMENT. Le defaut redoute n'est pas « le calcul est faux », il est
 * « le calcul est plausible ET faux » : un prix qui bouge de quelques centimes ne se voit sur aucun ecran,
 * et un client construit un budget dessus. D'ou deux cas qui paraissent triviaux et ne le sont pas : la
 * marge par defaut ne doit RIEN changer, et l'arrondi doit etre le meme que celui des ratios de `cost.ts`,
 * sans quoi le total de la carte et celui du graphe divergent sur un gros volume sans que personne ne
 * puisse dire lequel a raison.
 */
describe('la grille de prix d’un espace', () => {
  it('🔴 marge 100 : le prix facture EGALE le tarif Meta, au centime pres', () => {
    // Le defaut ne doit RIEN changer. Un client qui n'a jamais ouvert le reglage doit lire aujourd'hui le
    // meme chiffre qu'hier. C'est la raison d'etre du defaut a 100, et c'est ce qui rend la migration sans
    // danger : elle ajoute six colonnes dont aucune ne modifie un comportement.
    expect(prixTemplate(0.0432, GRILLE_DEFAUT)).toBe(0.0432);
    expect(prixTemplate(0, GRILLE_DEFAUT)).toBe(0);
  });

  it('marge 150 : une fois et demie le tarif Meta', () => {
    expect(prixTemplate(0.04, { ...GRILLE_DEFAUT, margeTemplate: 150 })).toBe(0.06);
  });

  it('marge 200 : le double', () => {
    expect(prixTemplate(0.0125, { ...GRILLE_DEFAUT, margeTemplate: 200 })).toBe(0.025);
  });

  it('🔴 arrondi a QUATRE decimales, le meme que les ratios de cost.ts', () => {
    // `estimateCoutParCampagne` arrondit ses ratios a 1e-4. Un prix unitaire arrondi plus grossierement
    // ferait diverger le total de la carte de celui du graphe des que le volume monte, et l'ecart serait
    // attribue a n'importe quoi sauf a un arrondi.
    expect(prixTemplate(0.0333, { ...GRILLE_DEFAUT, margeTemplate: 133 })).toBe(0.0443);
    // 0.0432 x 1.37 = 0.059184 -> 0.0592, et surtout PAS 0.06 (deux decimales) ni 0.059184 (brut).
    expect(prixTemplate(0.0432, { ...GRILLE_DEFAUT, margeTemplate: 137 })).toBe(0.0592);
  });

  it('⚠️ la grille se lit depuis la ligne de reglages, et retombe sur le DEFAUT quand la colonne manque', () => {
    // 🔴 LE CAS EST REEL SUR CE PRODUIT, PAS THEORIQUE. La console part sur Vercel a chaque push, l'API se
    // deploie a la main sur le VPS, et la migration 0154 s'applique entre les deux. Une ligne lue avant
    // qu'elle passe n'a aucune de ces colonnes : sans repli, `margeTemplate` vaudrait `undefined`, et
    // `tarif * (undefined / 100)` rend NaN, qui s'affiche a l'ecran comme un prix vide sans rien expliquer.
    expect(grilleDepuisLigne({})).toEqual(GRILLE_DEFAUT);
    expect(grilleDepuisLigne(null)).toEqual(GRILLE_DEFAUT);
  });

  it('⚠️ elle lit les NUMERIC de Postgres, que le pilote rend en CHAINE', () => {
    // 🔴 `numeric` ne rentre PAS dans un `number` JS sans perte, donc `pg` le rend en `string` par defaut.
    // Sans conversion, `prix_service_centimes` vaudrait '2.48' et `'2.48' * 100` marcherait par coercition
    // pendant que `'2.48' + 0` rendrait '2.480'. Le bug ne se voit qu'a l'addition, c'est-a-dire au total.
    const g = grilleDepuisLigne({
      prix_marge_template: 120,
      prix_service_centimes: '3.10',
      prix_service_franchise: 500,
      prix_service_depuis: '2026-11-01',
      prix_rcs_centimes: '7.00',
      prix_rcs_conv_centimes: '9.50',
    });
    expect(g.serviceCentimes).toBe(3.1);
    expect(g.rcsSimpleCentimes).toBe(7);
    expect(g.rcsConversationnelCentimes).toBe(9.5);
    expect(typeof g.serviceCentimes).toBe('number');
  });

  /**
   * ⚠️ CONSTRUITE A MINUIT LOCAL, ET C'EST TOUT LE SUJET. Ce cas passait `Date.UTC(...)`, c'est-a-dire
   * minuit UTC, alors que node-postgres rend une colonne `date` a minuit LOCAL : il n'exercait donc PAS la
   * propriete qu'il pretendait tenir, et il aurait ECHOUE sur une machine a l'ouest de Greenwich. Aligne le
   * 2026-09-18 sur `tests/prix-bornes.test.ts`, qui porte le cas complet et dit ce qu'il ne discrimine pas.
   *
   * La date d'effet se COMPARE a un mois ('2026-09'), donc elle doit voyager en texte : un objet `Date`
   * traverserait JSON en ISO complet avec un fuseau, et la comparaison de mois deviendrait fausse d'un jour
   * pres aux frontieres de mois.
   */
  it('⚠️ une DATE rendue par le pilote devient une chaine ISO courte, jamais un objet Date', () => {
    const g = grilleDepuisLigne({ prix_service_depuis: new Date(2026, 9, 1) });
    expect(g.serviceDepuis).toBe('2026-10-01');
  });

  it('⚠️ le defaut porte les valeurs annoncees a Julien, et elles sont ici pour etre relues', () => {
    // Ces six nombres sont des DECISIONS (2026-09-17), pas des constantes techniques. Les ecrire dans un
    // test les rend relisables sans ouvrir une base, et fait echouer bruyamment une modification distraite.
    expect(GRILLE_DEFAUT).toEqual({
      margeTemplate: 100,
      serviceCentimes: 2.48,
      serviceFranchise: 1000,
      serviceDepuis: '2026-10-01',
      rcsSimpleCentimes: 6,
      rcsConversationnelCentimes: 8,
    });
  });
});
