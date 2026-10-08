/**
 * Les requêtes d'un connecteur : un appel HTTP mis au point une fois, rangé dans la bibliothèque du
 * workspace, puis ouvert aux agents qui en ont besoin.
 *
 * 🔴 La source (adresse de base, authentification) reste séparée : elle porte le secret chiffré et la garde
 * anti-SSRF. Une requête ne peut pas sortir de l'adresse de base de sa source ni porter un secret.
 */

import type { MethodeConnecteur } from './http-cible';
import type { GabaritCorps, EnTete, ParametreUrl } from './requete-http';
import type { ParamOutil } from './llm/tool-schema';
import { libelleOrigine, normaliserOrigine, type OrigineVariable } from './variables';

/** Le type annoncé d'une variable. Il décide de ce qui part dans le corps : un « nombre » part en nombre. */
export type TypeVariable = 'string' | 'number' | 'integer' | 'boolean';

export interface VariableDeclaree {
  /** Le nom tel qu'il s'écrit dans les gabarits : `{{ville}}`. */
  nom: string;
  type: TypeVariable;
  origine: OrigineVariable;
  /** Montrée au modèle quand l'origine est `modele` : elle lui dit quoi mettre dedans. */
  description?: string;
  /** Une variable du modèle peut être facultative. Les autres origines rendent `null` quand la valeur manque. */
  requis?: boolean;
  /** Valeurs autorisées, quand l'origine est `modele`. Vide = libre. */
  enum?: string[];
}

export interface RequeteConnecteur {
  id: string;
  tenantId: string;
  sourceId: string;
  /** Le nom lisible de l'appel (« Chercher une commande »), celui de la liste où un agent vient piocher. */
  label: string;
  methode: MethodeConnecteur;
  chemin: string;
  parametres: ParametreUrl[];
  entetes: EnTete[];
  corps: GabaritCorps;
  variables: VariableDeclaree[];
  /** 🔴 Non vide. Ce que l'agent a le droit de lire dans la réponse, et rien d'autre. */
  outputPaths: string[];
  /**
   * Valeurs d'essai du bouton Test, par nom de variable. Jamais lues à l'exécution : un connecteur qui y
   * retomberait enverrait au client une donnée inventée, et l'agent répéterait la réponse avec assurance.
   */
  valeursTest: Record<string, string | number | boolean>;
  /** Nombre d'outils d'agents qui désignent cette requête : c'est ce qui refuse une suppression qui rendrait
   *  un agent muet. */
  outils: number;
  updatedAt: string;
}

export type CreationRequete = Omit<RequeteConnecteur, 'id' | 'tenantId' | 'outils' | 'updatedAt'>;
export type PatchRequete = Partial<CreationRequete>;

/**
 * Ce qui partira dans la requête, en français, pour le faire confirmer au client : le seul moment où il
 * peut voir qu'un connecteur enverra le dernier message de ses contacts à un système tiers.
 *
 * 🔴 Dérivé des variables réellement déclarées, jamais d'une liste à part : une confirmation qui ment est
 * pire qu'aucune. Les variables du modèle en font partie, c'est la seule valeur que le client ne contrôle pas.
 */
export function resumeEnvoi(requete: Pick<RequeteConnecteur, 'variables'>): Array<{ nom: string; libelle: string }> {
  return requete.variables.map((v) => ({ nom: v.nom, libelle: libelleOrigine(v.origine) }));
}

/**
 * Les variables déclarées, relues depuis le jsonb de `connector_requests`. Une origine illisible écarte l'entrée : une
 * variable manquante refuse l'appel en le disant, une origine devinée enverrait au client une valeur venue d'ailleurs.
 * Ici et pas dans `requetes.pg.ts` : le catalogue d'outils relit les mêmes variables (`paramsDuConnecteur`), et deux
 * relectures pourraient exposer au modèle une variable que le résolveur ne cherche pas.
 */
export function lireVariables(v: unknown): VariableDeclaree[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((x) => {
    const o = (x ?? {}) as Partial<VariableDeclaree> & { origine?: unknown };
    if (typeof o.nom !== 'string' || o.nom === '') return [];
    if (typeof o.type !== 'string') return [];
    // Les formes anciennes (`contact:*`, `systeme:analyse_*`) sont RÉÉCRITES en origine `fiche`, pas refusées :
    // une requête enregistrée avant le lot 2 garde toutes ses variables, sans reprise en base.
    const origine = normaliserOrigine(o.origine);
    if (origine === null) return [];
    return [{ ...(o as VariableDeclaree), origine }];
  });
}

/**
 * 🔴 CE QUE LE MODÈLE REMPLIT POUR UN APPEL DE CONNECTEUR : les variables « décidée par l'agent » de la requête, et
 * elles seules. Les autres (fiche, champ, valeur système, constante) sont résolues par le serveur : les exposer
 * inviterait le modèle à les fournir lui-même, donc à désigner la ressource d'un autre (garde anti-IDOR).
 *
 * Dérivé à CHAQUE lecture de l'outil (`versOutil`, `catalog.pg.ts`), jamais recopié sur l'outil : le résolveur lit les
 * variables courantes de la requête (`creerAppelConnecteur`), et la copie que la création écrivait jusqu'au
 * 2026-10-08 divergeait au premier renommage (le modèle remplissait l'ancien nom, chaque appel était refusé).
 */
export function paramsDuConnecteur(variables: readonly VariableDeclaree[]): ParamOutil[] {
  return variables
    .filter((v) => v.origine.type === 'modele')
    .map((v) => ({
      name: v.nom, type: v.type, source: 'modele' as const,
      ...(v.description ? { description: v.description } : {}),
      ...(v.requis ? { required: true } : {}),
      ...(v.enum && v.enum.length > 0 ? { enum: v.enum } : {}),
    }));
}

/** Le libellé est déjà pris pour ce tenant. Erreur typée : la route rend 409, jamais 500. */
export class LabelRequeteDejaPris extends Error {
  constructor(label: string) { super(`une requête nommée « ${label} » existe déjà`); this.name = 'LabelRequeteDejaPris'; }
}

/** La source désignée n'existe pas, ou appartient à un autre espace. */
export class SourceIntrouvable extends Error {
  constructor() { super('cette source n’existe pas'); this.name = 'SourceIntrouvable'; }
}

export interface RequeteStore {
  lister(tenantId: string): Promise<RequeteConnecteur[]>;
  parId(tenantId: string, id: string): Promise<RequeteConnecteur | null>;
  creer(tenantId: string, input: CreationRequete): Promise<RequeteConnecteur>;
  /** Monte au plancher de la méthode écrite le risque des outils branchés, sans jamais le redescendre. */
  patch(tenantId: string, id: string, patch: PatchRequete): Promise<RequeteConnecteur | null>;
  /** `false` = introuvable. Le refus « des outils la désignent » est porté par la route, comme pour une source. */
  supprimer(tenantId: string, id: string): Promise<boolean>;
}
