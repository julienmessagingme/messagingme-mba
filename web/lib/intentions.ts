/**
 * LES INTENTIONS D'UNE CONVERSATION ANALYSÉE, CÔTÉ CONSOLE : la liste, l'ordre d'affichage et les libellés.
 *
 * 🔴 MIROIR DE `INTENTS` (`src/analysis/schema.ts`), ET C'EST UN TEST QUI LE TIENT, PAS CE COMMENTAIRE. La
 * console n'importe jamais `src/` (`tests/ci-decoupage.test.ts`) : la liste existe donc en deux exemplaires,
 * et `tests/intentions-parite.test.ts` (à la RACINE, parce que seul `ci.yml` tourne sur un changement de
 * `src/`) exige qu'ils soient identiques, dans le même ordre, et que chaque valeur ait son libellé.
 *
 * ⚠️ L'ORDRE EST CELUI DE L'AFFICHAGE, ET IL EST FIXE : un classement par volume ferait danser les barres
 * d'une période à l'autre, et l'œil prendrait ce mouvement pour une information. `autre` reste la dernière.
 *
 * Un seul module pour les deux écrans qui les nomment (la carte du Performance Lab et l'Analyse des
 * conversations) : chacun portait sa copie de la liste et des libellés.
 */
export const INTENTIONS = [
  'demande_devis', 'sav', 'reclamation', 'information', 'prise_rdv', 'achat', 'suivi_commande', 'retour', 'autre',
] as const;
export type Intention = (typeof INTENTIONS)[number];

type Tr = (fr: string, en?: string) => string;

/** Une valeur venue d'une adresse ou du réseau est-elle une intention connue de CETTE console ? */
export function estIntention(v: string): v is Intention {
  return (INTENTIONS as readonly string[]).includes(v);
}

/**
 * Le libellé d'une intention.
 *
 * ⚠️ Une valeur INCONNUE (une API plus récente que la console) s'affiche telle quelle, jamais vide : un vide
 * passerait pour une donnée manquante.
 */
export function libelleIntention(i: string, t: Tr): string {
  switch (i) {
    case 'demande_devis': return t('Demande de devis', 'Quote request');
    case 'sav': return t('SAV', 'After-sales');
    case 'reclamation': return t('Réclamation', 'Complaint');
    case 'information': return t('Information', 'Information');
    case 'prise_rdv': return t('Prise de RDV', 'Appointment');
    case 'achat': return t('Achat', 'Purchase');
    case 'suivi_commande': return t('Suivi de commande', 'Order tracking');
    case 'retour': return t('Retour ou échange', 'Return or exchange');
    case 'autre': return t('Autre', 'Other');
    default: return i;
  }
}

/**
 * Les comptes par intention, dans l'ordre d'affichage, une intention absente valant ZÉRO.
 *
 * 🔴 L'ABSENCE EST UN CAS RÉEL : la console part sur Vercel à chaque push quand l'API se déploie à la main
 * sur le VPS. Une API plus ancienne ne connaît pas les intentions ajoutées depuis, et sans ce repli l'Analyse
 * des conversations tomberait en entier : `Math.max` rendrait NaN, puis `fmtNum(undefined)` lèverait une
 * TypeError pendant le rendu.
 */
export function comptesParIntention(
  intent: Partial<Record<Intention, number>> | null | undefined,
): Array<{ intention: Intention; n: number }> {
  return INTENTIONS.map((intention) => ({ intention, n: intent?.[intention] ?? 0 }));
}
