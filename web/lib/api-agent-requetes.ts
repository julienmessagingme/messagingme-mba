import { request } from './http';

/**
 * Les REQUÊTES de connecteur : un appel HTTP mis au point une fois dans la bibliothèque du workspace, éprouvé
 * avec son bouton Test, puis ouvert aux agents (migration 0105).
 *
 * 🔴 CE QUI A CHANGÉ, ET POURQUOI. Un appel était décrit PAR AGENT, donc redécrit pour chaque agent qui s'en
 * servait, et le corriger quelque part ne le corrigeait pas ailleurs. Il vit désormais dans la bibliothèque ;
 * un agent ne fait plus que le DÉSIGNER, avec ses propres mots.
 */

export type MethodeRequete = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** D'où vient la valeur d'une variable. Liste FERMÉE, alignée sur `src/agent/variables.ts`. */
export type OrigineVariable =
  | { type: 'modele' }
  | { type: 'contact'; cle: string }
  | { type: 'champ'; cle: string }
  | { type: 'systeme'; cle: string }
  | { type: 'fixe'; valeur: string | number | boolean };

export interface VariableRequete {
  nom: string;
  type: 'string' | 'number' | 'integer' | 'boolean';
  origine: OrigineVariable;
  description?: string;
  requis?: boolean;
  enum?: string[];
}

export interface Paire { cle: string; valeur: string }
export interface EnTeteRequete { nom: string; valeur: string }

/**
 * Le corps, dans l'une des DEUX façons de le saisir : du JSON brut pour qui connaît les API, une liste de
 * champs pour qui ne veut pas voir d'accolade. Un seul moteur de substitution dessous, côté serveur.
 */
export type CorpsRequete =
  | { mode: 'aucun' }
  | { mode: 'json'; gabarit: string }
  | { mode: 'champs'; champs: Paire[] };

export interface RequeteApi {
  id: string;
  tenantId: string;
  sourceId: string;
  label: string;
  methode: MethodeRequete;
  chemin: string;
  parametres: Paire[];
  entetes: EnTeteRequete[];
  corps: CorpsRequete;
  variables: VariableRequete[];
  outputPaths: string[];
  valeursTest: Record<string, string | number | boolean>;
  /** Nombre d'outils d'agents qui la désignent : c'est ce qui refuse une suppression qui rendrait un agent muet. */
  outils: number;
  updatedAt: string;
}

/** Ce que le serveur propose, pour que l'écran ne recopie pas une liste qui vit là-bas. Deux listes
 *  finiraient par diverger, et celle de l'écran proposerait une origine que le serveur refuse. */
export interface CatalogueVariables {
  contact: readonly string[];
  systeme: readonly string[];
  entetesReserves: readonly string[];
}

export interface ResultatTest {
  ok: boolean;
  erreur?: string;
  httpStatus?: number;
  dureeMs?: number;
  /** Ce qui est PARTI, pour que le client voie ce que sa configuration produit. Sans l'authentification. */
  envoye?: { url: string; methode: string; corps: string | null; entetes?: Record<string, string> };
  apercu?: string;
  /** Les chemins à cocher, dérivés de la réponse RÉELLE : c'est ce qui remplace « écris `livraison.date` ». */
  chemins?: string[];
  risqueMinimum?: 'read' | 'write' | 'irreversible';
}

const base = (tenantId: string) => `/tenants/${tenantId}/agent-requetes`;

export async function listRequetes(tenantId: string): Promise<{ requetes: RequeteApi[]; champs: string[]; catalogue: CatalogueVariables }> {
  return request(base(tenantId));
}

export type CreationRequete = Omit<RequeteApi, 'id' | 'tenantId' | 'outils' | 'updatedAt'>;

export async function creerRequete(tenantId: string, input: CreationRequete): Promise<RequeteApi> {
  const r = await request<{ requete: RequeteApi }>(base(tenantId), { method: 'POST', body: JSON.stringify(input) });
  return r.requete;
}

/**
 * ⚠️ N'envoyer QUE ce qui change. Le serveur fusionne sur l'état effectif, mais envoyer un champ inchangé le
 * réécrit quand même, ce qui écraserait une modification faite entre-temps depuis un autre onglet.
 */
export async function patchRequete(tenantId: string, id: string, patch: Partial<CreationRequete>): Promise<RequeteApi> {
  const r = await request<{ requete: RequeteApi }>(`${base(tenantId)}/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
  return r.requete;
}

export async function supprimerRequete(tenantId: string, id: string): Promise<void> {
  await request(`${base(tenantId)}/${id}`, { method: 'DELETE' });
}

/**
 * Éprouve un BROUILLON, c'est-à-dire ce qui est à l'écran, enregistré ou non.
 *
 * 🔴 C'EST CE QUE L'ÉCRAN DOIT APPELER, et son absence rendait la création d'un appel IMPOSSIBLE : on ne peut
 * enregistrer qu'avec au moins un champ de sortie, ces champs se cochent dans la réponse d'un essai, et
 * l'essai exigeait un appel déjà enregistré. Le cycle était fermé.
 *
 * ⚠️ Elle envoie CE QUI EST À L'ÉCRAN, pas ce qui est en base : sur un appel déjà enregistré qu'on modifie,
 * l'ancienne route éprouvait la version STOCKÉE, donc répondait sur une adresse que le client venait
 * justement de changer.
 */
export async function testerBrouillon(
  tenantId: string,
  brouillon: Omit<CreationRequete, 'label' | 'outputPaths'>,
): Promise<ResultatTest> {
  return request(`${base(tenantId)}/test`, { method: 'POST', body: JSON.stringify(brouillon) });
}
