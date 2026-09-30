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

/**
 * Ce qui est entre dans le chiffre du haut, pour que l'ecran le dise juste : `reunis` (push et publicites),
 * `push_seul` (aucune publicite mesurable, ou leur liste en panne : rien a dire), `pubs_seules` (aucune campagne push
 * mesurable), `devises_differentes` et `devise_inconnue` (les deux sont mesurables mais ne s'additionnent pas : le
 * chiffre reste celui du push).
 */
export type RaisonToutConfondu = 'reunis' | 'push_seul' | 'pubs_seules' | 'devises_differentes' | 'devise_inconnue';

/** Le chiffre du haut, tout confondu, et ce qui y est entré. */
export interface CoutToutConfondu {
  moyen: CoutMoyen;
  /** La devise du chiffre. */
  devise: string | null;
  raison: RaisonToutConfondu;
}

/**
 * LE CHIFFRE DU HAUT, PUSH ET PUBLICITES REUNIS (Julien, 2026-09-30) : le rapport des totaux sur les deux listes,
 * c'est-a-dire ce qu'a coute une personne engagee, quel que soit le canal qui l'a amenee.
 *
 * 🔴 DEUX DEVISES NE S'ADDITIONNENT PAS. Les tarifs des messages viennent de Meta, la depense publicitaire du compte
 * publicitaire : un compte en dollars ajoute a des envois en euros produirait un montant faux et credible. Le
 * chiffre retombe alors sur le push, et `raison` fait dire pourquoi. Une devise inconnue d'un cote n'est pas une
 * devise egale.
 *
 * `pubs` a `null` = la liste n'a pas pu etre lue : le chiffre est celui du push, sans rien pretendre des publicites.
 */
export function coutToutConfondu(
  push: readonly LigneMesurable[], devisePush: string | null,
  pubs: readonly LigneMesurable[] | null, devisePubs: string | null,
): CoutToutConfondu {
  const mp = coutMoyenParEngagement(push);
  const seulPush = (raison: RaisonToutConfondu): CoutToutConfondu => ({ moyen: mp, devise: devisePush, raison });
  if (pubs === null) return seulPush('push_seul');
  const mb = coutMoyenParEngagement(pubs);
  // Rien de mesurable cote publicites : rien a ajouter, et aucune devise a comparer.
  if (mb.campagnes === 0) return seulPush('push_seul');
  // Rien de mesurable cote push : le chiffre est celui des publicites, dans leur devise.
  if (mp.campagnes === 0) return { moyen: mb, devise: devisePubs, raison: 'pubs_seules' };
  if (devisePush === null || devisePubs === null) return seulPush('devise_inconnue');
  if (devisePush !== devisePubs) return seulPush('devises_differentes');
  return { moyen: coutMoyenParEngagement([...push, ...pubs]), devise: devisePush, raison: 'reunis' };
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
