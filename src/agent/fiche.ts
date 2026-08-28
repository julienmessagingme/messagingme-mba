import { z } from 'zod';

/**
 * La FICHE d'un agent : tout ce que le client décrit de son agent, et rien d'autre.
 *
 * 🔴 CETTE FRONTIÈRE EST LE SUJET DE LA COLONNE `fiche`. Ce qui est ici est ce que l'IA de construction
 * pourra écrire un jour à partir d'une conversation. Ce qui n'y est PAS (plafonds, modèle, mention légale,
 * statut) vit en colonnes, hors du jsonb, et n'est écrit que par un administrateur authentifié : une IA ne
 * relève pas elle-même son propre plafond de dépense, et n'efface pas la phrase qui annonce qu'elle est une
 * IA (obligation légale, AI Act article 50).
 *
 * Validé par `safeParse`, jamais `parse` : la fiche vient d'un formulaire ou d'un modèle, donc d'une source
 * non fiable dans les deux cas.
 */

/**
 * Le code d'une règle d'arrêt. Même alphabet que les noms d'outils, parce qu'il finit dans un handle d'arête
 * `sortie:<code>` du builder : un caractère exotique y produirait des écarts silencieux entre ce que le
 * builder dessine et ce que le moteur route.
 *
 * ⚠️ NI SOULIGNÉ EN TÊTE, NI EN QUEUE, et c'est exigé plutôt que toléré : la normalisation du champ de saisie
 * (`web/lib/agent-sorties.ts`) ne peut pas en produire, donc accepter `_rdv` côté serveur créerait un code
 * que le client ne peut pas taper et que personne ne pourrait plus reproduire ni corriger.
 */
export const CODE_SORTIE_RE = /^[a-z0-9](?:[a-z0-9_]{0,30}[a-z0-9])?$/;

/**
 * Une règle d'arrêt : « quand l'agent a fini de faire ÇA, il sort par là ».
 *
 * 🔴 LA FICHE FAIT AUTORITÉ, et elle est la SEULE source de ces codes. L'outil maison `terminer` expose au
 * modèle une énumération fermée des sorties possibles : cette énumération se DÉRIVE d'ici au moment de
 * construire le schéma envoyé au modèle, elle ne se recopie jamais en base. Deux copies finiraient par
 * diverger, et l'agent rendrait un code que le graphe ne sait pas router.
 */
export const sortieAgentSchema = z.object({
  code: z.string().regex(CODE_SORTIE_RE),
  label: z.string().trim().min(1).max(60),
});

/** Plafond de règles d'arrêt. Au-delà, le bloc devient illisible dans le builder, et le modèle choisit mal
 *  dans une énumération trop large. */
export const MAX_SORTIES = 12;

export const ficheAgentSchema = z.object({
  /** Le nom que l'agent se donne dans la conversation. Vide -> il n'en donne aucun. */
  nom: z.string().trim().max(80).default(''),
  /** Ce que l'agent est là pour faire. C'est le champ qui porte le plus de sens pour le modèle. */
  objectif: z.string().trim().max(4000).default(''),
  ton: z.string().trim().max(1000).default(''),
  personnalite: z.string().trim().max(1000).default(''),
  /** Quand passer la main à un humain, en français, tel que le client le dirait. */
  reglesTransfert: z.string().trim().max(4000).default(''),
  /**
   * 🔴 CODES UNIQUES, exigé ICI parce que la LECTURE le suppose déjà : `sortiesDeLaFiche` écarte un doublon
   * en silence. Sans cette garde, l'écriture accepterait ce que la lecture jette, et la fiche cesserait de
   * dire ce que le builder route. Le formulaire bloque déjà le doublon, mais l'IA de construction écrira ici
   * aussi.
   */
  sorties: z.array(sortieAgentSchema).max(MAX_SORTIES)
    .refine((s) => new Set(s.map((x) => x.code)).size === s.length, 'codes de sortie en double')
    .default([]),
});

export type FicheAgentContenu = z.infer<typeof ficheAgentSchema>;

/** Une fiche vide, valide. Sert de valeur par défaut à la création et de repli à la lecture d'un jsonb illisible. */
export function ficheVide(): FicheAgentContenu {
  return { nom: '', objectif: '', ton: '', personnalite: '', reglesTransfert: '', sorties: [] };
}
