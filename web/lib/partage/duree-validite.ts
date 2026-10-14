/**
 * LA DURÉE DE VALIDITÉ D'UN MODÈLE (`message_send_ttl_seconds` chez Meta, plan du 2026-10-14) : passé ce délai, un
 * message que WhatsApp n'a pas pu livrer est abandonné. La console PROPOSE ces durées, le serveur REFUSE ce que Meta
 * refuserait : une seule source pour les deux.
 *
 * Marketing : de 12 h à 30 jours, appliquée par Meta seulement aux envois par la Marketing Messages API. Utility : de
 * 30 secondes à 12 h, appliquée par la Cloud API ; `-1` vaut 30 jours, le défaut.
 *
 * ⚠️ AUCUN IMPORT DE VALEUR : lu par le build de la console ET par le serveur.
 */

export type CategorieModele = 'MARKETING' | 'UTILITY';

/** La durée que Meta applique sans réglage : 30 jours dans les deux catégories, écrite comme Meta l'accepte. */
export const DUREE_PAR_DEFAUT: Readonly<Record<CategorieModele, number>> = { MARKETING: 2_592_000, UTILITY: -1 };

/** Les durées proposées par l'éditeur, de la plus courte au défaut. */
export const DUREES_VALIDITE: Readonly<Record<CategorieModele, ReadonlyArray<{ secondes: number; libelle: readonly [string, string] }>>> = {
  MARKETING: [
    { secondes: 43_200, libelle: ['12 heures', '12 hours'] },
    { secondes: 86_400, libelle: ['24 heures', '24 hours'] },
    { secondes: 172_800, libelle: ['48 heures', '48 hours'] },
    { secondes: 604_800, libelle: ['7 jours', '7 days'] },
    { secondes: 2_592_000, libelle: ['30 jours (par défaut)', '30 days (default)'] },
  ],
  UTILITY: [
    { secondes: 3_600, libelle: ['1 heure', '1 hour'] },
    { secondes: 21_600, libelle: ['6 heures', '6 hours'] },
    { secondes: 43_200, libelle: ['12 heures', '12 hours'] },
    { secondes: -1, libelle: ['30 jours (par défaut)', '30 days (default)'] },
  ],
};

/** Vrai si Meta accepte cette durée pour cette catégorie (bornes de la page « Time-to-live », relue le 2026-10-14). */
export function dureeValide(categorie: CategorieModele, secondes: number): boolean {
  if (!Number.isInteger(secondes)) return false;
  if (categorie === 'MARKETING') return secondes >= 43_200 && secondes <= 2_592_000;
  return secondes === -1 || (secondes >= 30 && secondes <= 43_200);
}

/**
 * La durée d'un modèle telle que l'éditeur l'affiche : celle lue chez Meta si elle vaut pour la catégorie, le défaut
 * sinon. Absente (jamais réglée, ou effacée par un reclassement de Meta), c'est le défaut. 30 jours écrits autrement
 * (2 592 000 pour une utility) se ramènent au défaut, pour ne pas montrer deux « 30 jours ».
 */
export function dureeAffichee(categorie: CategorieModele, lue: number | null | undefined): number {
  if (lue === null || lue === undefined) return DUREE_PAR_DEFAUT[categorie];
  if (categorie === 'UTILITY' && lue === 2_592_000) return DUREE_PAR_DEFAUT.UTILITY;
  return dureeValide(categorie, lue) ? lue : DUREE_PAR_DEFAUT[categorie];
}

/**
 * Le libellé d'une durée, proposée ou non : une durée réglée hors de l'éditeur (par Meta ou un autre outil) reste
 * lisible dans la liste de choix au lieu d'y être remplacée en silence.
 */
export function libelleDuree(secondes: number, locale: 'fr' | 'en'): string {
  const i = locale === 'en' ? 1 : 0;
  if (secondes === -1) return ['30 jours', '30 days'][i]!;
  const [n, unite]: [number, readonly [string, string]] = secondes % 86_400 === 0 ? [secondes / 86_400, ['jour', 'day']]
    : secondes % 3_600 === 0 ? [secondes / 3_600, ['heure', 'hour']]
      : secondes % 60 === 0 ? [secondes / 60, ['minute', 'minute']]
        : [secondes, ['seconde', 'second']];
  return `${n} ${unite[i]}${n > 1 ? 's' : ''}`;
}
