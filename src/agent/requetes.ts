/**
 * Les REQUÊTES d'un connecteur : un appel HTTP mis au point une fois, rangé dans la bibliothèque du
 * workspace, puis ouvert aux agents qui en ont besoin (migration 0105).
 *
 * 🔴 POURQUOI CE N'EST PLUS DANS L'AGENT. Jusqu'ici la méthode, le chemin et les paramètres vivaient dans
 * `agent_tools`, donc le même appel était redécrit pour chaque agent qui s'en servait. Julien, le 2026-09-02,
 * décrit l'inverse : « le client choisit dans la liste l'appel API setuppé dans Tools ». C'est aussi ce qui
 * rend l'écran possible : on ne met pas au point une requête DANS le réglage d'un agent, on la met au point
 * une fois, on l'éprouve avec le bouton Test, puis on l'ouvre.
 *
 * ⚠️ La SOURCE (adresse de base, authentification) reste séparée, et ce n'est pas un détail d'organisation :
 * c'est elle qui porte le secret chiffré et la garde anti-SSRF. Une requête ne peut pas sortir de l'adresse
 * de base de sa source, et elle n'a aucun moyen de porter un secret.
 */

import type { MethodeConnecteur } from './http-cible';
import type { GabaritCorps, EnTete, ParametreUrl } from './requete-http';
import { libelleOrigine, type OrigineVariable } from './variables';

/** Le type ANNONCÉ d'une variable. Il décide de ce qui part dans le corps : un « nombre » part en nombre. */
export type TypeVariable = 'string' | 'number' | 'integer' | 'boolean';

export interface VariableDeclaree {
  /** Le nom tel qu'il s'écrit dans les gabarits : `{{ville}}`. */
  nom: string;
  type: TypeVariable;
  origine: OrigineVariable;
  /**
   * EXPOSÉE AU MODÈLE quand l'origine est `modele` : c'est elle qui lui dit quoi mettre dedans. Inutile pour
   * les autres origines, où la valeur ne vient pas de lui.
   */
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
  /** Le nom LISIBLE de l'appel (« Chercher une commande »), celui de la liste où un agent vient piocher. */
  label: string;
  methode: MethodeConnecteur;
  chemin: string;
  parametres: ParametreUrl[];
  entetes: EnTete[];
  corps: GabaritCorps;
  variables: VariableDeclaree[];
  /** 🔴 NON VIDE. Ce que l'agent a le droit de LIRE dans la réponse, et rien d'autre. */
  outputPaths: string[];
  /**
   * Valeurs d'ESSAI du bouton Test, par nom de variable.
   *
   * 🔴 JAMAIS lues à l'exécution, et la séparation est volontaire : un connecteur qui retomberait sur une
   * valeur de test enverrait au système du client une donnée inventée, et sa réponse serait fausse sans que
   * rien ne le signale. L'agent répéterait cette réponse au contact avec assurance.
   */
  valeursTest: Record<string, string | number | boolean>;
  /** Nombre d'outils d'agents qui DÉSIGNENT cette requête : c'est ce qui refuse une suppression qui rendrait
   *  un agent muet. Même rôle que `outilsActifs` sur une source. */
  outils: number;
  updatedAt: string;
}

export type CreationRequete = Omit<RequeteConnecteur, 'id' | 'tenantId' | 'outils' | 'updatedAt'>;
export type PatchRequete = Partial<CreationRequete>;

/**
 * CE QUI PARTIRA dans la requête, en français, pour le faire confirmer au client.
 *
 * 🔴 Julien, le 2026-09-02 : « quand le client choisit dans la liste l'appel API, il faut bien lui faire
 * confirmer à ce moment "ok on envoie telle et telle valeur dans la requête" ». C'est le seul moment où il
 * peut s'apercevoir qu'un connecteur enverra le dernier message de ses contacts à un système tiers.
 *
 * ⚠️ DÉRIVÉ des variables réellement déclarées, jamais d'une liste tenue à part. Une seconde liste finirait
 * par ne plus dire ce qui part, et une confirmation qui ment est pire que pas de confirmation : elle donne
 * l'assurance sans la garantie.
 *
 * Les variables du MODÈLE en font partie, et c'est voulu : « décidée par l'agent » est justement ce que le
 * client doit voir, parce que c'est la seule valeur qu'il ne contrôle pas.
 */
export function resumeEnvoi(requete: Pick<RequeteConnecteur, 'variables'>): Array<{ nom: string; libelle: string }> {
  return requete.variables.map((v) => ({ nom: v.nom, libelle: libelleOrigine(v.origine) }));
}

/** Le libellé est déjà pris pour ce tenant. Erreur TYPÉE : la route rend 409, jamais 500. */
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
  patch(tenantId: string, id: string, patch: PatchRequete): Promise<RequeteConnecteur | null>;
  /** `false` = introuvable. Le refus « des outils la désignent » est porté par la ROUTE, comme pour une source. */
  supprimer(tenantId: string, id: string): Promise<boolean>;
}
