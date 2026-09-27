import { RANG_INITIAL, rangSuivant, type Etage } from './etages';

/**
 * Que faire d'un destinataire qui vient d'échouer : basculer à l'étage suivant, réessayer, attendre demain
 * matin, ou s'arrêter. Règle pure : ni base, ni horloge, ni réseau.
 *
 * Le transport (`src/meta/errors.ts`) a déjà rejoué ce qui mérite de l'être (429, 408, 425, 5xx, réseau) avant
 * qu'un destinataire soit `failed` : d'où la règle « avec une chaîne, tout code bascule », sans liste
 * d'exceptions par code qu'on ne saurait pas tenir à jour.
 *
 * Elle ne décide pas du moment (rattraper maintenant ou à l'ouverture) : c'est le balayage (`retry-sweep.ts`),
 * via `rattrapage_hors_horaires`.
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
  /** L'étage où est le destinataire, pas celui qu'il vise. */
  rangCourant: number;
  /** L'option « réessayer les échecs » de la campagne (`campaigns.reessayer`). */
  reessayer: boolean;
  /** Un réessai a-t-il déjà été consommé pour ce destinataire ? Le budget est de un. */
  dejaReessaye: boolean;
  /**
   * L'adresse e-mail du contact, lue dans le jsonb `contacts.fields` sous la clé que l'étage e-mail désigne
   * (`campaign_etages.email_champ`), posée par `PgCampaignRepo.poserLesAdresses`.
   *
   * `null` = pas d'adresse exploitable (pas d'étage e-mail, pas de clé, ou rien sous la clé) : dans les trois
   * cas, l'étage e-mail est sauté pour ce contact.
   */
  emailDuContact: string | null;
}

/**
 * La campagne a-t-elle un repli, c'est-à-dire un étage après le premier ? Propriété de la chaîne, pas du
 * trajet : un destinataire resté sur un étage retiré de la chaîne retrouve ainsi la politique de réessai, au
 * lieu d'un repli qui n'existe plus. Une chaîne vide n'est pas un repli.
 */
function aUnRepli(chaine: Etage[]): boolean {
  return rangSuivant(chaine, RANG_INITIAL) !== null;
}

/**
 * Une chaîne vide ou blanche n'est pas une adresse (import CSV à colonne vide, champ effacé) : l'envoyer ferait
 * refuser par le fournisseur SMTP l'envoi entier, pas seulement ce destinataire.
 */
function adresseExploitable(email: string | null): boolean {
  return email !== null && email.trim() !== '';
}

/**
 * Le prochain étage réellement servable, en sautant ceux dont le destinataire n'existe pas.
 *
 * Seul l'e-mail est concerné : WhatsApp et RCS partent vers le numéro, présent par construction, alors que
 * l'adresse vit dans le jsonb `fields` sous une clé choisie par le client (`contacts` n'a pas de colonne
 * `email`). On saute, on ne clôt pas : l'e-mail n'est pas forcément le dernier rang, et un canal suivant
 * pourrait joindre le destinataire.
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
  // 1. La chaîne d'abord, sans regarder le code : avec un repli, tout échec bascule dès le premier. Réessayer le
  //    même canal doublerait le délai de rattrapage. Seule exception : un étage dont le destinataire n'existe
  //    pas (e-mail sans adresse) est sauté, pas servi.
  const suivant = prochainEtageServable(entree);
  if (suivant !== null) return { type: 'bascule', rang: suivant };

  // 1 bis. Il y avait un étage après, mais pas servable. Le vrai motif : « pas d'adresse e-mail » se corrige en
  //    remplissant la fiche, « plus d'étage disponible » non.
  if (rangSuivant(entree.chaine, entree.rangCourant) !== null) {
    return { type: 'terminal', motif: 'pas d adresse e-mail' };
  }

  // 2. Plus aucun étage après celui-ci, et il y en avait avant : la chaîne est le rattrapage, elle est épuisée.
  //    La politique de réessai ne reprend pas la main, sinon les envois se multiplieraient par le nombre d'étages.
  if (aUnRepli(entree.chaine)) return { type: 'terminal', motif: 'plus d etage disponible' };

  // 3. Sans chaîne : la politique de réessai de la campagne.

  // 131026 est terminal même si l'option est cochée, et passe avant les gardes suivantes pour que le motif soit
  // le vrai : le numéro n'a pas WhatsApp, seul un autre canal peut le rattraper.
  if (entree.codeErreur === CODE_SANS_WHATSAPP) return { type: 'terminal', motif: 'numero sans WhatsApp' };

  if (!entree.reessayer) return { type: 'terminal', motif: 'reessai desactive' };
  // Le budget est d'un réessai, tous motifs confondus : la fenêtre matinale de 131049 le consomme.
  if (entree.dejaReessaye) return { type: 'terminal', motif: 'reessai deja consomme' };

  // 131049 attend demain matin : le plafond marketing de Meta se libère avec le temps, re-taper tout de suite ne
  // fait que re-échouer (fenêtre matinale + 24 h de `retry-sweep`).
  if (entree.codeErreur === CODE_PLAFOND_MARKETING) return { type: 'reessai_demain_matin' };

  return { type: 'reessai' };
}
