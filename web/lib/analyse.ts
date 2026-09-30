/**
 * LES CODES D'UNE ANALYSE DE CONVERSATION, CÔTÉ CONSOLE : sentiment, action suggérée, « traitée par », et leurs
 * libellés. Les intentions ont leur propre module (`@/lib/intentions`).
 *
 * 🔴 MIROIRS DE `SENTIMENTS`, `ACTIONS` et `HANDLED_BY` (`src/analysis/schema.ts`), ET C'EST UN TEST QUI LES
 * TIENT : la console n'importe jamais `src/`, et `tests/analyse-libelles-parite.test.ts` (à la RACINE, parce que
 * seul `ci.yml` tourne sur un changement de `src/`) exige des listes identiques et un libellé par valeur.
 *
 * Un seul module pour les écrans qui les nomment : l'Analyse des conversations et la section « Dernière analyse »
 * de la fiche contact. La carte d'analyse portait sa propre copie.
 */
export const SENTIMENTS = ['positif', 'neutre', 'negatif'] as const;
export const ACTIONS = ['creer_devis', 'rappeler', 'relancer', 'escalader', 'aucune'] as const;
export const TRAITE_PAR = ['humain', 'automatise', 'mba'] as const;

type Tr = (fr: string, en?: string) => string;

/**
 * Le libellé d'un sentiment. ⚠️ Une valeur INCONNUE (une API plus récente que la console) s'affiche telle
 * quelle, jamais vide : un vide passerait pour une donnée manquante. Même règle pour les deux suivants.
 */
export function sentimentLabel(s: string, t: Tr): string {
  switch (s) {
    case 'positif': return t('Positif', 'Positive');
    case 'neutre': return t('Neutre', 'Neutral');
    case 'negatif': return t('Négatif', 'Negative');
    default: return s;
  }
}

export function actionLabel(a: string, t: Tr): string {
  switch (a) {
    case 'creer_devis': return t('Créer un devis', 'Create a quote');
    case 'rappeler': return t('Rappeler', 'Call back');
    case 'relancer': return t('Relancer', 'Follow up');
    case 'escalader': return t('Escalader', 'Escalate');
    case 'aucune': return t('Aucune', 'None');
    default: return a;
  }
}

/** Qui a traité la conversation. « MBA » reste tel quel : c'est le nom du produit de Meta. */
export function traiteParLabel(h: string, t: Tr): string {
  switch (h) {
    case 'humain': return t('Humain', 'Human');
    case 'automatise': return t('Automatisé', 'Automated');
    case 'mba': return 'MBA';
    default: return h;
  }
}

/** Classe de badge selon le sentiment (3 couleurs). */
export function sentimentBadge(s: string): string {
  if (s === 'positif') return 'bg-succes-50 text-succes-700';
  if (s === 'negatif') return 'bg-danger-50 text-danger-700';
  return 'bg-ink-100 text-ink-500';
}
