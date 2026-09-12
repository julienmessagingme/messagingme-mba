import { RANG_INITIAL, rangSuivant, type Etage } from './etages';

/**
 * QUE FAIRE D'UN DESTINATAIRE QUI VIENT D'ÉCHOUER : basculer à l'étage suivant, réessayer, attendre
 * demain matin, ou s'arrêter. C'est la règle, et elle est PURE : ni base, ni horloge, ni réseau.
 *
 * 🔴 ELLE EST PLUS SIMPLE QU'ELLE N'EN A L'AIR PARCE QUE LE TRANSPORT FAIT DÉJÀ LA MOITIÉ DU TRAVAIL.
 * `src/meta/errors.ts` rejoue tout seul ce qui mérite de l'être (429, 408, 425, 5xx, coupures réseau)
 * AVANT qu'un destinataire soit marqué `failed`. Quand cette fonction est appelée, les tentatives de
 * transport sont donc déjà épuisées : « échec transitoire » n'est plus une catégorie utile ici, et
 * c'est ce qui autorise la règle « avec une chaîne, TOUT code bascule » sans liste d'exceptions.
 * Une liste d'exceptions par code serait la dette classique : personne ne sait la tenir à jour, et
 * un code oublié devient un contact perdu en silence.
 *
 * ⚠️ ELLE NE DÉCIDE PAS DU *MOMENT*. « Rattraper maintenant ou attendre l'ouverture » est une
 * question d'horaires, portée par `rattrapage_hors_horaires` et tranchée par le balayage
 * (`retry-sweep.ts`). La mélanger ici rendrait la règle impossible à tester sans horloge.
 */

/** Le numéro n'est pas un numéro WhatsApp (ou la personne n'a pas accepté les conditions). */
const CODE_SANS_WHATSAPP = 131026;
/** Meta a plafonné le marketing pour ce destinataire. Le plafond se libère avec le temps. */
const CODE_PLAFOND_MARKETING = 131049;

export type Geste =
  | { type: 'bascule'; rang: number }
  | { type: 'reessai' }
  | { type: 'reessai_demain_matin' }
  | { type: 'terminal'; motif: string };

export interface EntreeDeDecision {
  /** Le code Meta de l'échec. `null` quand il n'y en a pas (coupure réseau, refus sans corps). */
  codeErreur: number | null;
  /** La chaîne d'étages de la campagne, dans n'importe quel ordre (cf. `etages.ts`). */
  chaine: Etage[];
  /** L'étage où EST le destinataire, pas celui qu'il vise. */
  rangCourant: number;
  /** L'option « réessayer les échecs » de la campagne (`campaigns.reessayer`). */
  reessayer: boolean;
  /** Un réessai a-t-il DÉJÀ été consommé pour ce destinataire ? Le budget est de un. */
  dejaReessaye: boolean;
  /**
   * Adresse du contact. ⚠️ DANS LA SIGNATURE DÈS MAINTENANT, même si l'étage e-mail n'arrive que
   * plus tard : l'ajouter après coup changerait la signature d'une fonction déjà testée, et un
   * appelant oublié se contenterait d'un `undefined` qu'aucun compilateur ne signale sur un objet
   * dont toutes les autres clés sont fournies. Vaut `null` tant qu'aucun étage e-mail n'existe.
   */
  emailDuContact: string | null;
}

/**
 * La campagne a-t-elle un REPLI, c'est-à-dire un étage après le premier ?
 *
 * 🔴 C'EST UNE PROPRIÉTÉ DE LA CHAÎNE, PAS DU TRAJET, et la nuance décide du motif terminal. Deux
 * lectures étaient possibles pour « pourquoi ne peut-on plus basculer » : « la campagne n'a pas de
 * repli » (ce qu'on lit ici) ou « j'ai déjà basculé » (`rangCourant > RANG_INITIAL`). VÉRIFIÉ : les
 * deux donnent la même réponse sur tous les états ATTEIGNABLES, puisqu'on n'arrive au-delà du
 * premier étage qu'en ayant basculé. Elles divergent sur un seul cas, un destinataire resté sur un
 * étage que l'opérateur vient de retirer de la chaîne ; la lecture retenue lui rend alors la
 * politique de réessai, ce qui est moins faux que de lui annoncer un repli qui n'existe plus.
 *
 * ⚠️ Une chaîne VIDE (campagne d'avant 0134 non reprise, chaîne effacée) n'est pas un repli : on
 * retombe sur la politique de réessai, jamais sur « plus d'étage disponible », qui laisserait croire
 * qu'un repli a été tenté.
 */
function aUnRepli(chaine: Etage[]): boolean {
  return rangSuivant(chaine, RANG_INITIAL) !== null;
}

export function decider(entree: EntreeDeDecision): Geste {
  // 1. LA CHAÎNE D'ABORD, ET SANS REGARDER LE CODE. C'est la règle tranchée : avec un repli, tout
  //    échec bascule DÈS LE PREMIER. Réessayer le même canal avant de basculer doublerait le délai
  //    de rattrapage pour n'ajouter qu'une chance sur un canal qui vient déjà d'échouer.
  const suivant = rangSuivant(entree.chaine, entree.rangCourant);
  if (suivant !== null) return { type: 'bascule', rang: suivant };

  // 2. PLUS D'ÉTAGE, MAIS IL Y EN AVAIT : la chaîne EST le rattrapage, elle est épuisée, on s'arrête.
  //    ⚠️ La politique de réessai ne reprend PAS la main ici. Lui rendre la main à chaque étage
  //    multiplierait les envois par le nombre d'étages sans que personne ne l'ait demandé.
  if (aUnRepli(entree.chaine)) return { type: 'terminal', motif: 'plus d etage disponible' };

  // 3. SANS CHAÎNE : la politique de réessai de la campagne, inchangée depuis F6.

  // 🔴 131026 EST TERMINAL MÊME SI L'OPTION EST COCHÉE, et il passe AVANT les deux gardes suivantes
  //    pour que le motif soit le VRAI. Le numéro n'est pas un numéro WhatsApp : réessayer ne peut
  //    rien y changer, seul un autre canal le peut. C'est aussi pour ça qu'il a quitté
  //    `RETRYABLE_CODES` au niveau transport : son rattrapage est ici, ou nulle part.
  if (entree.codeErreur === CODE_SANS_WHATSAPP) return { type: 'terminal', motif: 'numero sans WhatsApp' };

  if (!entree.reessayer) return { type: 'terminal', motif: 'reessai desactive' };
  // Le budget est d'UN réessai, tous motifs confondus. ⚠️ La fenêtre matinale de 131049 en est un :
  // elle le consomme, donc pas de seconde chance le surlendemain.
  if (entree.dejaReessaye) return { type: 'terminal', motif: 'reessai deja consomme' };

  // ⚠️ 131049 attend DEMAIN MATIN, il ne se réessaie pas dans la foulée : le plafond marketing de
  //    Meta se libère avec le temps, re-taper tout de suite ne fait que re-échouer. C'est le
  //    mécanisme existant de `retry-sweep` (fenêtre matinale + 24 h), pas un nouveau.
  if (entree.codeErreur === CODE_PLAFOND_MARKETING) return { type: 'reessai_demain_matin' };

  return { type: 'reessai' };
}
