import { z } from 'zod';

/**
 * La fiche d'un agent : tout ce que le client décrit de son agent, et rien d'autre.
 *
 * 🔴 Frontière de la colonne `fiche` : ce qui est ici, l'IA de construction peut l'écrire. Plafonds, modèle,
 * mention légale et statut vivent en colonnes, écrits seulement par un administrateur : une IA ne relève pas
 * son propre plafond de dépense et n'efface pas la phrase qui annonce qu'elle est une IA. Validée par
 * `safeParse` : formulaire ou modèle, la source est non fiable.
 */

/**
 * Le code d'une règle d'arrêt. Même alphabet que les noms d'outils, parce qu'il finit dans un handle d'arête
 * `sortie:<code>` du builder. Ni souligné en tête ni en queue : `normaliserCodeSortie` ne peut pas en
 * produire, donc un tel code serait impossible à taper ou à reproduire.
 */
export const CODE_SORTIE_RE = /^[a-z0-9](?:[a-z0-9_]{0,30}[a-z0-9])?$/;

/**
 * Les bornes de longueur des champs de la fiche, en un seul endroit, exportées pour que l'assistant de
 * construction les annonce au modèle. Déclarées avant `sortieAgentSchema`, qui les lit à l'évaluation du
 * module (zone morte temporelle d'un `const`).
 */
export const BORNES_FICHE = {
  nom: 80, objectif: 4000, ton: 1000, personnalite: 1000, reglesTransfert: 4000,
  /** Le libellé d'une règle d'arrêt. */
  label: 60,
  /** Le code d'une règle d'arrêt : la longueur maximale que `CODE_SORTIE_RE` ci-dessus laisse passer. */
  code: 32,
} as const;

/**
 * Ramène un code libre vers ce que `CODE_SORTIE_RE` accepte. Rend une chaîne vide quand il ne reste rien
 * d'exploitable, pour que l'appelant écarte l'entrée.
 *
 * C'est l'autorité ; `web/lib/agent-sorties.ts` en est la copie (pas de code serveur dans le bundle client),
 * et `tests/web-agent-code-sortie-parity.test.ts` compare les deux. Un code déjà valide ressort inchangé,
 * sinon rouvrir une fiche déplacerait ses codes et les arêtes du builder désigneraient des sorties disparues.
 */
export function normaliserCodeSortie(brut: string): string {
  return brut
    // Retrait des marques diacritiques : un accent ne passe pas dans un handle d'arête, la lettre, si.
    .normalize('NFD').replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, BORNES_FICHE.code)
    // Le `slice` peut laisser un souligné final : on le retire après, sinon un code tronqué sortirait avec
    // une terminaison que personne n'a écrite.
    .replace(/_+$/g, '');
}

/**
 * Une règle d'arrêt : « quand l'agent a fini de faire ça, il sort par là ». La fiche est la seule source de
 * ces codes : l'énumération fermée de l'outil `terminer` s'en dérive à la construction du schéma, jamais
 * recopiée en base, sinon l'agent rendrait un code que le graphe ne sait pas router.
 */
export const sortieAgentSchema = z.object({
  code: z.string().regex(CODE_SORTIE_RE),
  label: z.string().trim().min(1).max(BORNES_FICHE.label),
});

/** Plafond de règles d'arrêt. Au-delà, le bloc devient illisible dans le builder, et le modèle choisit mal
 *  dans une énumération trop large. */
export const MAX_SORTIES = 12;

/**
 * Les champs de la fiche, sans défaut. Les deux schémas ci-dessous en dérivent, pour qu'une lecture et un
 * patch ne divergent jamais sur les bornes.
 */
const CHAMPS = {
  /** Le nom que l'agent se donne dans la conversation. Vide -> il n'en donne aucun. */
  nom: z.string().trim().max(BORNES_FICHE.nom),
  /** Ce que l'agent est là pour faire. C'est le champ qui porte le plus de sens pour le modèle. */
  objectif: z.string().trim().max(BORNES_FICHE.objectif),
  ton: z.string().trim().max(BORNES_FICHE.ton),
  personnalite: z.string().trim().max(BORNES_FICHE.personnalite),
  /** Quand passer la main à un humain, en français, tel que le client le dirait. */
  reglesTransfert: z.string().trim().max(BORNES_FICHE.reglesTransfert),
  /**
   * Codes uniques, exigés à l'écriture parce que la lecture (`sortiesDeLaFiche`) écarte un doublon en
   * silence : sinon la fiche cesserait de dire ce que le builder route.
   */
  sorties: z.array(sortieAgentSchema).max(MAX_SORTIES)
    .refine((s) => new Set(s.map((x) => x.code)).size === s.length, 'codes de sortie en double'),
};

/** La fiche complète, telle qu'on la lit : chaque champ absent prend son défaut, ce qui rend une ligne
 *  ancienne ou mal formée éditable au lieu de faire tomber l'écran. */
export const ficheAgentSchema = z.object({
  nom: CHAMPS.nom.default(''),
  objectif: CHAMPS.objectif.default(''),
  ton: CHAMPS.ton.default(''),
  personnalite: CHAMPS.personnalite.default(''),
  reglesTransfert: CHAMPS.reglesTransfert.default(''),
  sorties: CHAMPS.sorties.default([]),
});

/**
 * La fiche en patch : chaque champ optionnel et sans défaut.
 *
 * 🔴 `ficheAgentSchema.partial()` ne suffit pas : le `.default()` en dessous s'applique quand même à
 * l'absence, donc un `{ objectif }` ressortirait en fiche entière, et la fusion jsonb (`fiche || $n`)
 * effacerait le ton, la personnalité et toutes les règles d'arrêt sans erreur.
 * `tests/agent-sorties-fiche.test.ts` ancre les deux schémas.
 */
export const fichePatchSchema = z.object({
  nom: CHAMPS.nom.optional(),
  objectif: CHAMPS.objectif.optional(),
  ton: CHAMPS.ton.optional(),
  personnalite: CHAMPS.personnalite.optional(),
  reglesTransfert: CHAMPS.reglesTransfert.optional(),
  sorties: CHAMPS.sorties.optional(),
});

export type FicheAgentContenu = z.infer<typeof ficheAgentSchema>;

/** Une fiche vide, valide. Sert de valeur par défaut à la création et de repli à la lecture d'un jsonb illisible. */
export function ficheVide(): FicheAgentContenu {
  return { nom: '', objectif: '', ton: '', personnalite: '', reglesTransfert: '', sorties: [] };
}
