/**
 * LE RISQUE DE DÉSENGAGEMENT, À L'ÉCRAN (lot 7 de l'API publique, spec du 2026-09-24 § 19).
 *
 * Module PUR (aucune dépendance React/Next/navigateur au chargement) : testé par `web/lib/risque.test.ts`, et
 * tenu aligné sur le serveur (`src/engagement/risque.ts`) par `tests/web-risque-parite.test.ts`, qui compare les
 * niveaux et les codes de raisons dans les deux sens. Un code ajouté au serveur sans son libellé ici ferait
 * échouer ce test, pas l'écran.
 *
 * Les libellés portent les DEUX langues [fr, en], résolues au rendu par `t(...)` : ces constantes vivent au niveau
 * module, où `useT()` est inappelable (même idiome que `OPT_IN_LABEL` dans `components/ContactDetail.tsx`).
 */

export const NIVEAUX_RISQUE = ['inconnu', 'faible', 'moyen', 'eleve'] as const;
export type NiveauRisque = (typeof NIVEAUX_RISQUE)[number];

export function estNiveauRisque(v: unknown): v is NiveauRisque {
  return typeof v === 'string' && (NIVEAUX_RISQUE as readonly string[]).includes(v);
}

/**
 * Le badge de chaque niveau. 🔴 `inconnu` est GRIS, comme « Jamais testé » pour la joignabilité : c'est un contact
 * qu'on n'a pas pu observer (rien ne lui a été délivré sur 90 jours), pas un contact fidèle.
 */
export const BADGE_NIVEAU_RISQUE: Record<NiveauRisque, { text: readonly [string, string]; cls: string }> = {
  eleve: { text: ['élevé', 'high'], cls: 'bg-red-50 text-red-700' },
  moyen: { text: ['moyen', 'medium'], cls: 'bg-amber-50 text-amber-700' },
  faible: { text: ['faible', 'low'], cls: 'bg-emerald-50 text-emerald-700' },
  inconnu: { text: ['inconnu', 'unknown'], cls: 'bg-ink-100 text-ink-600' },
};

/** L'ordre des choix du filtre : du plus urgent au moins observé. */
export const NIVEAUX_DU_FILTRE: readonly NiveauRisque[] = ['eleve', 'moyen', 'faible', 'inconnu'];

/** Ce que veut dire chaque code de raison que le serveur rend (`RAISONS_RISQUE`). */
export const LIBELLES_RAISON_RISQUE = {
  stop: ['A demandé à ne plus recevoir de messages (STOP)', 'Asked to stop receiving messages (STOP)'],
  bloque: ['Contact bloqué', 'Contact blocked'],
  silence_60j: ['Aucune réponse, aucun clic ni aucune lecture depuis plus de 60 jours', 'No reply, click or read for more than 60 days'],
  silence_30j: ['Aucune réponse, aucun clic ni aucune lecture depuis plus de 30 jours', 'No reply, click or read for more than 30 days'],
  sans_reponse: ['Ni réponse ni clic aux trois derniers messages', 'No reply or click to the last three messages'],
  non_lu: ['Les trois derniers messages n’ont pas été lus, alors qu’il lit d’habitude', 'The last three messages were not read, though they usually read'],
  reclamation: ['Dernière conversation : une réclamation non résolue', 'Last conversation: an unresolved complaint'],
  negatif: ['Dernière conversation : un ressenti négatif', 'Last conversation: a negative sentiment'],
  insatisfait: ['Dernière conversation : une satisfaction de 3 sur 10 ou moins', 'Last conversation: a satisfaction of 3 out of 10 or less'],
  injoignable: ['Injoignable au dernier envoi', 'Unreachable on the last send'],
} as const satisfies Record<string, readonly [string, string]>;
export type RaisonRisque = keyof typeof LIBELLES_RAISON_RISQUE;

/**
 * Le libellé d'un code. ⚠️ Un code que cette console ne connaît pas encore (le serveur en ajoute un avant qu'elle
 * soit redéployée) s'affiche TEL QUEL plutôt que de disparaître : une raison muette ferait croire à un niveau
 * sans cause.
 */
export function libelleRaisonRisque(code: string): readonly [string, string] {
  // `hasOwnProperty` et pas `in` : `'toString' in {}` est vrai.
  const connu = (c: string): c is RaisonRisque => Object.prototype.hasOwnProperty.call(LIBELLES_RAISON_RISQUE, c);
  return connu(code) ? LIBELLES_RAISON_RISQUE[code] : [code, code];
}

/** Le risque d'une fiche, tel que l'écran le montre. */
export interface RisqueContact {
  niveau: NiveauRisque;
  /** `null` pour `inconnu`, et seulement pour lui. */
  score: number | null;
  /** Les codes tels que le serveur les rend (trois au plus), dans l'ordre de leur poids. */
  raisons: string[];
  /** La date du dernier calcul (ISO). */
  calculeLe: string;
}

/**
 * Le risque lu sur une fiche venue du RÉSEAU, jamais casté.
 *
 * 🔴 `null` VEUT DIRE « PAS ENCORE CALCULÉ », et il couvre trois cas qu'on ne distingue pas à l'écran : le champ
 * absent (une API d'avant le lot 7), `null` (jamais calculé), et une forme illisible. Aucun des trois ne doit
 * afficher un niveau : un niveau inventé serait pire qu'un blanc, puisqu'on cible une campagne dessus.
 */
export function risqueLu(v: unknown): RisqueContact | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (!estNiveauRisque(o.niveau) || typeof o.calculeLe !== 'string' || o.calculeLe === '') return null;
  const score = o.niveau !== 'inconnu' && typeof o.score === 'number' && Number.isFinite(o.score) ? o.score : null;
  const raisons = Array.isArray(o.raisons) ? o.raisons.filter((r): r is string => typeof r === 'string' && r !== '') : [];
  return { niveau: o.niveau, score, raisons, calculeLe: o.calculeLe };
}
