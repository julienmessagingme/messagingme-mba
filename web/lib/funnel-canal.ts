import type { FunnelCanal } from '@/lib/api';

/**
 * LES DEUX RÈGLES DE LECTURE DE LA VENTILATION PAR CANAL (migration 0134).
 *
 * 🔴 ELLES SONT ICI, ET PAS DANS LE COMPOSANT, PARCE QU'ELLES SE VÉRIFIENT. Ce sont des décisions, pas de
 * la mise en page : « ce chiffre est-il inconnu ou nul ? » et « cette ventilation apprend-elle quelque
 * chose ? ». Écrites en ligne dans du JSX, elles ne seraient exerçables que par un rendu complet, donc en
 * pratique jamais ; ici elles ont un test, et ce test échoue quand on les inverse.
 */

/**
 * CE CANAL N'A AUCUNE MESURE DE LIVRAISON : ses colonnes « délivrés » et « lus » valent « — », pas zéro.
 *
 * 🔴 LE SEUIL EST « AUCUN », PAS « CERTAINS », et l'écart entre les deux est tout le sujet. Un accusé
 * manquant sur trois envois sur dix laisse les sept autres parfaitement mesurés : effacer la colonne
 * perdrait une information vraie. C'est quand il n'y en a AUCUN que le zéro devient un mensonge, et ce
 * cas-là n'est pas rare, il est SYSTÉMATIQUE sur une campagne à scénario (identifiant de message
 * synthétique, que l'accusé de Meta ne peut jamais apparier).
 *
 * ⚠️ `reussis > 0` EST INDISPENSABLE : sans lui, un canal qui n'a RIEN envoyé (0 parti, 0 accusé) passerait
 * la comparaison `0 === 0` et afficherait « — », c'est-à-dire « on ne sait pas » là où on sait très bien.
 *
 * ⚠️ LE DÉNOMINATEUR EST `reussis`, PAS `envois` : une tentative échouée n'attend aucun accusé, donc la
 * compter parmi les envois sans accusé rendrait l'égalité presque impossible et éteindrait la règle en
 * silence sur tout canal ayant connu le moindre échec.
 */
export function mesureInconnue(ligne: Pick<FunnelCanal, 'reussis' | 'sansAccuse'>): boolean {
  return ligne.reussis > 0 && ligne.sansAccuse === ligne.reussis;
}

/**
 * FAUT-IL AFFICHER LA VENTILATION ?
 *
 * 🔴 NON EN DESSOUS DE DEUX CANAUX, et ce n'est pas une économie de place. Sur une campagne mono-canal,
 * la ventilation répéterait ligne pour ligne les barres du dessus : deux fois les mêmes chiffres sur le
 * même écran, c'est une invitation à chercher pourquoi ils diffèrent. Comme toute campagne est mono-canal
 * tant que la chaîne de repli n'existe pas, cette règle est aussi ce qui rend l'ajout INVISIBLE aujourd'hui.
 *
 * ⚠️ UNE LISTE VIDE N'EST PAS UNE CAMPAGNE SANS ENVOI. Le journal des tentatives ne contient que ce qui
 * est postérieur à sa mise en service : une campagne plus ancienne n'a aucune ligne, alors que ses
 * compteurs du haut sont complets. Se taire est le seul affichage honnête, et il tombe sous la même règle.
 */
export function ventilationAffichable(parCanal: FunnelCanal[] | undefined): boolean {
  return (parCanal?.length ?? 0) >= 2;
}
