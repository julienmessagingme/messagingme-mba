import { z } from 'zod';
import type { VariableDeclaree } from '../agent/requetes';
import type { RisqueOutil } from '../agent/catalog';

/**
 * LES GESTES DE L'AGENT DE META : ce que le relais exécute lui-même, sans système tiers (spec
 * docs/superpowers/specs/2026-09-21-outils-maison-mba-design.md, § 3).
 *
 * 🔴 DES HANDLERS À PART DE CEUX DES AGENTS IA (`src/agent/outils-maison.ts`), et c'est une garde. Un outil de
 * l'agent de Meta qui atteindrait par erreur un agent IA tomberait sur un handler inconnu, donc un refus, au
 * lieu d'être joué avec une autre forme de paramètres. `tests/mba-outils-maison.test.ts` tient la disjonction.
 *
 * 🔴 LA CIBLE EST FIXÉE PAR L'ADMINISTRATEUR, jamais par le modèle (arbitrage de Julien, 2026-09-21 : « fixé
 * d'avance »). L'agent de Meta ne décide que du MOMENT, et pour un champ, de la valeur.
 */
export const HANDLERS_MAISON_MBA = ['tag_fixe', 'champ_fixe'] as const;
export type HandlerMaisonMba = (typeof HANDLERS_MAISON_MBA)[number];

/** Le type d'un outil tel que l'écran le montre. `connecteur` n'est pas un geste maison : il appelle un tiers. */
export type TypeOutilMba = 'tag' | 'champ' | 'bloc' | 'scenario' | 'connecteur';

/**
 * ⚠️ `.strict()` : le `binding` est un jsonb que rien d'autre ne contraint. Une clé en trop veut dire qu'une
 * autre écriture l'a produit, et un outil qu'on ne comprend pas ne s'exécute pas.
 */
export const cibleMaisonSchema = z.discriminatedUnion('handler', [
  z.object({ handler: z.literal('tag_fixe'), tag: z.string().trim().min(1).max(64) }).strict(),
  z.object({
    handler: z.literal('champ_fixe'),
    champ: z.string().trim().min(1).max(64),
    valeurs: z.array(z.string().trim().min(1).max(120)).max(50),
  }).strict(),
]);
export type CibleMaison = z.infer<typeof cibleMaisonSchema>;
export type CibleChamp = Extract<CibleMaison, { handler: 'champ_fixe' }>;

/** La cible d'un outil relu en base, ou `null` : un outil illisible n'est ni exécuté ni publié. */
export function lireCibleMaison(binding: unknown): CibleMaison | null {
  const r = cibleMaisonSchema.safeParse(binding);
  return r.success ? r.data : null;
}

export function typeDeLaCible(c: CibleMaison): Exclude<TypeOutilMba, 'connecteur'> {
  switch (c.handler) {
    case 'tag_fixe': return 'tag';
    case 'champ_fixe': return 'champ';
  }
}

/** Le risque déclaré en base. Meta n'a aucun réglage d'autonomie : il sert au journal et à la lecture. */
export const RISQUE_MAISON: Record<HandlerMaisonMba, RisqueOutil> = {
  tag_fixe: 'write',
  champ_fixe: 'write',
};

/**
 * CE QUE L'AGENT DE META REÇOIT EN CAS DE SUCCÈS (spec § 7).
 *
 * ⚠️ Jamais le nom de l'étiquette ni du champ : ce sont des noms internes, et l'agent les répéterait au client.
 */
export const REPONSE_MAISON: Record<HandlerMaisonMba, string> = {
  tag_fixe: 'C’est fait, c’est enregistré sur la fiche du client. Confirme-le-lui sans citer de nom technique.',
  champ_fixe: 'C’est enregistré sur la fiche du client.',
};

export const VARIABLE_VALEUR = 'valeur';

/**
 * Les variables publiées dans le corps de l'outil chez Meta (`corpsOutilMeta` ne garde que les `modele`).
 * Une étiquette fixée ne demande rien ; un champ demande sa valeur, avec la liste permise quand il y en a une.
 */
export function variablesPourMeta(c: CibleMaison): VariableDeclaree[] {
  if (c.handler !== 'champ_fixe') return [];
  return [{
    nom: VARIABLE_VALEUR,
    type: 'string',
    origine: { type: 'modele' },
    requis: true,
    description: 'La valeur à enregistrer, telle que le client l’a donnée.',
    ...(c.valeurs.length > 0 ? { enum: c.valeurs } : {}),
  }];
}

const corpsChampSchema = z.object({ valeur: z.string().trim().min(1).max(500) });

/** La valeur que l'agent de Meta envoie pour un champ, validée contre la liste permise. */
export function lireValeurChamp(
  c: CibleChamp, corps: unknown,
): { ok: true; valeur: string } | { ok: false; erreur: string } {
  const r = corpsChampSchema.safeParse(corps);
  if (!r.success) return { ok: false, erreur: 'la valeur à enregistrer manque' };
  const valeur = r.data.valeur;
  if (c.valeurs.length > 0 && !c.valeurs.includes(valeur)) {
    return { ok: false, erreur: `valeur refusée : choisir parmi ${c.valeurs.join(', ')}` };
  }
  return { ok: true, valeur };
}
