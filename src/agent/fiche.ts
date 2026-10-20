import { z } from 'zod';
import { CODE_SORTIE_RE, LONGUEUR_CODE_SORTIE, MAX_SORTIES } from '../../web/lib/partage/sorties-agent';
import { asArray, asRecord } from '../webhooks/json';
import type { SortieAgent } from './agent-store';

/** La règle du code d'une règle d'arrêt est partagée avec la console, qui l'applique sous les yeux du client. */
export { CODE_SORTIE_RE, MAX_SORTIES, normaliserCodeSortie } from '../../web/lib/partage/sorties-agent';

/**
 * La fiche d'un agent : tout ce que le client décrit de son agent, et rien d'autre.
 *
 * 🔴 Frontière de la colonne `fiche` : ce qui est ici, l'IA de construction peut l'écrire. Plafonds, modèle,
 * mention légale et statut vivent en colonnes, écrits seulement par un administrateur : une IA ne relève pas
 * son propre plafond de dépense et n'efface pas la phrase qui annonce qu'elle est une IA. Validée par
 * `safeParse` : formulaire ou modèle, la source est non fiable.
 */

/**
 * Les bornes de longueur des champs de la fiche, en un seul endroit, exportées pour que l'assistant de
 * construction les annonce au modèle. Déclarées avant `sortieAgentSchema`, qui les lit à l'évaluation du
 * module (zone morte temporelle d'un `const`).
 */
export const BORNES_FICHE = {
  nom: 80, objectif: 4000, ton: 1000, personnalite: 1000, reglesTransfert: 4000,
  /** Le libellé d'une règle d'arrêt. */
  label: 60,
  /** Le code d'une règle d'arrêt : la longueur maximale que `CODE_SORTIE_RE` laisse passer. */
  code: LONGUEUR_CODE_SORTIE,
} as const;

/**
 * Une règle d'arrêt : « quand l'agent a fini de faire ça, il sort par là ». La fiche est la seule source de
 * ces codes : l'énumération fermée de l'outil `terminer` s'en dérive à la construction du schéma, jamais
 * recopiée en base, sinon l'agent rendrait un code que le graphe ne sait pas router.
 */
export const sortieAgentSchema = z.object({
  code: z.string().regex(CODE_SORTIE_RE),
  label: z.string().trim().min(1).max(BORNES_FICHE.label),
  /**
   * « Elle passe à un humain » (`SortieAgent.humain`). Absente d'une écriture qui remplace la liste (l'assistant de
   * construction, un outil MCP qui ne la connaît pas) : la valeur d'avant est gardée, par code (`modifierAgent`).
   */
  humain: z.boolean().optional(),
});

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

/**
 * Les règles d'arrêt d'une fiche, lues défensivement (jsonb écrit par l'IA de construction) : une entrée
 * inutilisable est écartée plutôt que de faire tomber le builder. Le code passe par `CODE_SORTIE_RE`, la
 * même règle qu'à l'écriture (`src/agent/fiche.ts`).
 */
export function sortiesDeLaFiche(fiche: unknown): SortieAgent[] {
  const out: SortieAgent[] = [];
  const vus = new Set<string>();
  for (const brut of asArray(asRecord(fiche).sorties)) {
    const o = asRecord(brut);
    const code = typeof o.code === 'string' ? o.code.trim().toLowerCase() : '';
    if (!CODE_SORTIE_RE.test(code) || vus.has(code)) continue;
    vus.add(code);
    out.push({
      code, label: typeof o.label === 'string' && o.label.trim() !== '' ? o.label.trim() : code,
      // Seulement quand elle est cochée : une règle sans la case reste `{ code, label }`, comme avant.
      ...(o.humain === true ? { humain: true } : {}),
    });
  }
  return out;
}
