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
   * L'adresse e-mail du contact, LUE DANS LE JSONB `contacts.fields` sous la clé que l'étage e-mail de
   * la chaîne désigne (`campaign_etages.email_champ`, migration 0135).
   *
   * 🔴 ELLE EST RÉSOLUE DEPUIS LE 2026-09-12, et ce champ ne vaut plus toujours `null` : ce commentaire
   * annonçait « tant qu'aucun étage e-mail n'existe », et il en existe. C'est
   * `PgCampaignRepo.poserLesAdresses` qui la pose, sur les seuls candidats dont la chaîne porte un
   * étage e-mail.
   *
   * ⚠️ `null` VEUT DIRE « PAS D'ADRESSE EXPLOITABLE », ce qui couvre trois cas indiscernables ici et qui
   * appellent la même décision : la chaîne n'a pas d'étage e-mail, l'étage n'a pas de clé de champ, ou
   * la fiche n'a rien sous cette clé. Dans les trois, l'étage e-mail n'est pas servable pour ce
   * contact, et il est SAUTÉ.
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

/**
 * L'ADRESSE EST-ELLE EXPLOITABLE ?
 *
 * ⚠️ UNE CHAÎNE VIDE OU BLANCHE N'EST PAS UNE ADRESSE. Le jsonb d'un contact peut porter la clé avec une
 * valeur vide (import CSV à colonne vide, champ effacé à l'écran) : la lire comme « il a une adresse »
 * ferait partir un envoi vers rien, et le fournisseur SMTP refuserait l'envoi entier, pas seulement ce
 * destinataire.
 */
function adresseExploitable(email: string | null): boolean {
  return email !== null && email.trim() !== '';
}

/**
 * LE PROCHAIN ÉTAGE QU'ON PEUT RÉELLEMENT SERVIR, en sautant ceux dont le destinataire n'existe pas.
 *
 * 🔴 IL N'Y A QU'UN SEUL CANAL CONCERNÉ, ET C'EST L'E-MAIL. WhatsApp et RCS partent vers le NUMÉRO du
 * destinataire, qui est présent par construction (`campaign_recipients.to_e164`). L'adresse e-mail, elle,
 * vit dans le jsonb `fields` du contact, sous une clé que le client a choisie : elle peut manquer sur une
 * fiche et pas sur la suivante. `contacts` N'A PAS de colonne `email` (vérifié dans les migrations : 0001
 * crée la table sans, 0002 ajoute `fields`, aucun `alter table contacts` n'en a ajouté depuis).
 *
 * 🔴 ON SAUTE, ON NE CLÔT PAS. Rien n'impose que l'e-mail soit le dernier rang : la migration 0134 borne
 * les rangs à 3, pas leurs canaux. S'arrêter sur un étage e-mail injoignable retirerait au destinataire
 * un canal qui, lui, le joindrait. C'est la même doctrine que `rangSuivant`, qui cherche le prochain rang
 * QUI EXISTE au lieu de `rang + 1`.
 */
function prochainEtageServable(entree: EntreeDeDecision): number | null {
  let rang = entree.rangCourant;
  for (;;) {
    const suivant = rangSuivant(entree.chaine, rang);
    if (suivant === null) return null;
    const etage = entree.chaine.find((e) => e.rang === suivant);
    if (etage?.canal !== 'email' || adresseExploitable(entree.emailDuContact)) return suivant;
    rang = suivant;
  }
}

export function decider(entree: EntreeDeDecision): Geste {
  // 1. LA CHAÎNE D'ABORD, ET SANS REGARDER LE CODE. C'est la règle tranchée : avec un repli, tout
  //    échec bascule DÈS LE PREMIER. Réessayer le même canal avant de basculer doublerait le délai
  //    de rattrapage pour n'ajouter qu'une chance sur un canal qui vient déjà d'échouer.
  //
  // ⚠️ LA SEULE EXCEPTION EST UN ÉTAGE DONT LE DESTINATAIRE N'EXISTE PAS (un e-mail sans adresse) :
  //    il est SAUTÉ, pas servi. Basculer vers lui produirait un envoi vide, compté comme une tentative
  //    et rangé en échec sous un code de fournisseur qui n'expliquerait rien.
  const suivant = prochainEtageServable(entree);
  if (suivant !== null) return { type: 'bascule', rang: suivant };

  // 1 bis. LA CHAÎNE AVAIT UN ÉTAGE APRÈS, MAIS IL N'ÉTAIT PAS SERVABLE. Le motif doit être le VRAI :
  //    « pas d'adresse e-mail » se corrige (on remplit la fiche), « plus d'étage disponible » non.
  //    Les confondre ferait chercher une panne d'envoi là où il manque une donnée de contact.
  if (rangSuivant(entree.chaine, entree.rangCourant) !== null) {
    return { type: 'terminal', motif: 'pas d adresse e-mail' };
  }

  // 2. PLUS AUCUN ÉTAGE APRÈS CELUI-CI, ET IL Y EN AVAIT AVANT : la chaîne EST le rattrapage, elle est
  //    épuisée, on s'arrête. ⚠️ Le cas « il y avait un étage après, mais pas servable » est traité en
  //    1 bis, avec SON motif : les deux ne se réparent pas pareil.
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
