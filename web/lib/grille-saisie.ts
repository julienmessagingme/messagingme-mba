/**
 * LA GRILLE DE PRIX VERS LES CHAMPS DE SAISIE, ET RETOUR.
 *
 * 🔴 CE MODULE EXISTE PARCE QUE LA SEULE PIECE NON TESTEE DU LOT ETAIT AUSSI LA SEULE QUI ETAIT CASSEE.
 * La premiere version de l ecran convertissait la saisie en nombre A CHAQUE FRAPPE, sur un champ CONTROLE,
 * alors que son propre commentaire annoncait l inverse. Consequences, toutes verifiables :
 *  - taper « 3 » puis « . » donne `Number('3.') === 3`, le point est reecrit hors du champ et disparait,
 *    donc on ne peut JAMAIS ecrire un separateur decimal ;
 *  - vider le champ donne `Number('') === 0`, et le champ se remplit tout seul d un « 0 » qu on n a pas
 *    saisi, c est-a-dire exactement le symptome que le commentaire disait avoir evite ;
 *  - « 3,15 » a la francaise donne `NaN`, affiche tel quel.
 * Sur un ecran dont un defaut vaut 2,48, passer de 2,48 a 3,10 rendait 310, refuse par les bornes.
 * Releve en revue finale le 2026-09-18.
 *
 * ⚠️ DEUX CONVERSIONS, AUX DEUX BOUTS, ET RIEN ENTRE LES DEUX. Tant qu on tape, la valeur est le TEXTE
 * tape. Module PUR : aucune dependance React, donc eprouvable.
 */

/** Miroir minimal de `GrillePrix` : ce module ne dependra pas du client d API pour six nombres. */
export interface GrilleSaisissable {
  margeTemplate: number;
  serviceCentimes: number;
  serviceFranchise: number;
  serviceDepuis: string;
  rcsSimpleCentimes: number;
  rcsConversationnelCentimes: number;
}

/** Les six champs, en TEXTE, tels que les `input` les portent. */
export function enChamps(g: GrilleSaisissable): Record<string, string> {
  return {
    margeTemplate: String(g.margeTemplate),
    serviceCentimes: String(g.serviceCentimes),
    serviceFranchise: String(g.serviceFranchise),
    serviceDepuis: g.serviceDepuis,
    rcsSimpleCentimes: String(g.rcsSimpleCentimes),
    rcsConversationnelCentimes: String(g.rcsConversationnelCentimes),
  };
}

/**
 * Les champs vers la grille, a l ENREGISTREMENT seulement.
 *
 * ⚠️ LA VIRGULE FRANCAISE EST ACCEPTEE, et c est le seul endroit ou on la traduit. Un client francais tape
 * « 2,48 » ; sans cette ligne `Number('2,48')` rend `NaN`, le serveur refuse, et l ecran lui dit que sa
 * valeur est invalide alors qu elle est celle qu il a toujours ecrite.
 *
 * 🔴 UNE CHAINE VIDE DEVIENT `NaN`, PAS ZERO. Zero est un prix VALIDE (« je ne facture pas ce canal ») :
 * traduire un champ vide en zero enregistrerait un prix que personne n a choisi, et le client ne saurait
 * jamais que son oubli a ete rempli a sa place. `NaN` est refuse par le serveur, qui NOMME le champ.
 */
export function depuisChamps(c: Record<string, string>): GrilleSaisissable {
  const n = (v: string | undefined): number => {
    const t = (v ?? '').trim();
    return t === '' ? Number.NaN : Number(t.replace(',', '.'));
  };
  return {
    margeTemplate: n(c.margeTemplate),
    serviceCentimes: n(c.serviceCentimes),
    serviceFranchise: n(c.serviceFranchise),
    serviceDepuis: c.serviceDepuis ?? '',
    rcsSimpleCentimes: n(c.rcsSimpleCentimes),
    rcsConversationnelCentimes: n(c.rcsConversationnelCentimes),
  };
}
