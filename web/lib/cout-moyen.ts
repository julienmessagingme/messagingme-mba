/**
 * LE CHIFFRE UNIQUE DE LA CARTE « COUTS » : ce qu'a coute en moyenne une personne engagee.
 *
 * 🔴 LE RAPPORT DES TOTAUX, PAS LA MOYENNE DES RATIOS, ET LES DEUX SONT PLAUSIBLES. Sur une campagne A de
 * 5000 envois a 2 euros par engage et une campagne B de 10 envois a 40 euros, le rapport des totaux rend
 * 2,08 quand la moyenne des ratios rend 21. Tranche par Julien le 2026-09-17 : ce chiffre repond a « ce que
 * m'a coute en moyenne une personne engagee sur la periode », qui est une question de BUDGET, donc une
 * grosse campagne doit y peser plus qu'une petite. La moyenne des ratios repond a « mes campagnes
 * sont-elles bien calibrees », ou un essai a 10 envois pese autant qu'une campagne a 5000 : c'est une autre
 * question, et elle n'est pas celle de cette carte.
 *
 * 🔴 UNE CAMPAGNE NON MESURABLE SORT DES DEUX TERMES, ET SE COMPTE A PART. La garder au denominateur ferait
 * BAISSER le cout moyen a cause d'une campagne dont on ignore le prix : le chiffre descendrait sans qu'un
 * seul euro soit economise. C'est la meme regle que les cases vides de `cost.ts`, appliquee a un total.
 *
 * Module PUR : aucun appel, aucun etat. Il se teste sans navigateur.
 */

/** Ce dont le calcul a besoin sur une ligne de campagne. Volontairement minimal : tout le reste est du rendu. */
export interface LigneMesurable {
  /** `null` = aucun envoi chiffrable. ⚠️ `0` est une mesure VALIDE, pas une absence. */
  cout: number | null;
  /**
   * Les PERSONNES engagees. `null` = mesure faite, personne. `undefined` = l'API ne rend pas encore le
   * champ, ce qui arrive vraiment entre le deploiement de Vercel et celui du VPS.
   */
  engagements?: number | null;
}

export interface CoutMoyen {
  /** `null` quand rien n'est mesurable. JAMAIS `0`, qui se lirait « c'est gratuit ». */
  valeur: number | null;
  /** Les campagnes RETENUES dans le calcul, c'est-a-dire le denominateur reel. */
  campagnes: number;
  /** Celles qui en sont sorties, faute de cout ou faute d'engage. L'ecran peut le DIRE. */
  ecartees: number;
}

export function coutMoyenParEngagement(lignes: readonly LigneMesurable[]): CoutMoyen {
  let cout = 0;
  let engages = 0;
  let campagnes = 0;
  let ecartees = 0;
  for (const l of lignes) {
    // ⚠️ `l.cout === null` et pas `!l.cout` : un cout de ZERO est une mesure valide (tous les envois dans
    // la franchise), et un `!` la confondrait avec « on ne sait pas », donc la ferait disparaitre du calcul.
    const e = l.engagements;
    if (l.cout === null || e === null || e === undefined || e <= 0) { ecartees += 1; continue; }
    cout += l.cout;
    engages += e;
    campagnes += 1;
  }
  // Le ratio n'existe que si son denominateur existe. Un `0` ici se lirait « gratuit », ce qui est la
  // reponse a une question qu'on n'a pas pu poser.
  const valeur = engages > 0 ? Math.round((cout / engages) * 10000) / 10000 : null;
  return { valeur, campagnes, ecartees };
}
