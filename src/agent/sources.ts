/**
 * Les SOURCES externes d'outils : l'adresse de base d'un système client, son mode d'authentification et son
 * secret (migration 0088, lot L2).
 *
 * 🔴 DEUX PROJECTIONS, ET ELLES NE SE MÉLANGENT PAS. `SourceVue` est ce qu'une route rend : jamais le secret,
 * seulement le fait qu'il existe. `SourceAppel` est ce que le résolveur lit, secret déchiffré compris, et
 * cette méthode n'a qu'UN appelant. Une projection unique finirait par renvoyer le secret à l'écran le jour
 * où quelqu'un ajoute un champ, et personne ne le verrait : un secret dans une réponse JSON ne casse rien.
 *
 * ⚠️ L'adresse de base est FIGÉE ici, et c'est la garde anti-SSRF du lot : le modèle ne compose qu'un gabarit
 * de chemin, et `src/agent/http-cible.ts` vérifie que la cible reste sous cette adresse.
 */

export type KindSource = 'http' | 'mcp';
export type AuthSource = 'none' | 'bearer' | 'header';
export type StatutSource = 'draft' | 'active' | 'disabled';

/** Ce qu'une route rend. Le secret n'y est pas, et il ne doit jamais y entrer. */
export interface SourceVue {
  id: string;
  tenantId: string;
  kind: KindSource;
  label: string;
  baseUrl: string;
  authKind: AuthSource;
  authHeaderName: string | null;
  /** Le secret EXISTE-t-il. Sa valeur ne sort jamais du serveur. */
  aAuthentification: boolean;
  status: StatutSource;
  lastOkAt: string | null;
  lastError: string | null;
  /** Nombre d'outils ACTIFS qui en dépendent : c'est ce qui refuse une suppression qui rendrait un agent muet. */
  outilsActifs: number;
  /**
   * Nombre d'AGENTS qui tapent dans cette source.
   *
   * 🔴 C'est ce qui rend la BIBLIOTHÈQUE lisible : une source est déclarée une fois pour le workspace, et
   * plusieurs agents s'en servent. Sans ce chiffre, l'écran laisserait croire qu'une source appartient à
   * l'agent depuis lequel on l'a vue, et on la supprimerait en cassant les autres.
   */
  agents: number;
}

/** Ce que le RÉSOLVEUR lit, et lui seul : le secret est déchiffré ici, au moment de l'appel. */
export interface SourceAppel {
  id: string;
  baseUrl: string;
  authKind: AuthSource;
  authHeaderName: string | null;
  authSecret: string | null;
  status: StatutSource;
}

export interface CreationSource {
  kind: KindSource;
  label: string;
  baseUrl: string;
  authKind: AuthSource;
  authHeaderName?: string;
  authSecret?: string;
}

export interface PatchSource {
  label?: string;
  baseUrl?: string;
  authKind?: AuthSource;
  authHeaderName?: string | null;
  /** ABSENT = inchangé. Un secret qu'on ne renvoie pas ne doit pas s'effacer parce qu'on a renommé la source. */
  authSecret?: string;
  status?: StatutSource;
}

/** Le libellé est déjà pris pour ce tenant. Erreur TYPÉE : la route rend 409, pas 500. */
export class LabelSourceDejaPris extends Error {
  constructor(label: string) { super(`une source nommée « ${label} » existe déjà`); this.name = 'LabelSourceDejaPris'; }
}

export interface SourceStore {
  lister(tenantId: string): Promise<SourceVue[]>;
  parId(tenantId: string, id: string): Promise<SourceVue | null>;
  creer(tenantId: string, input: CreationSource): Promise<SourceVue>;
  patch(tenantId: string, id: string, patch: PatchSource): Promise<SourceVue | null>;
  /** `false` = introuvable. Le refus « des outils actifs en dépendent » est porté par la ROUTE, pas ici. */
  supprimer(tenantId: string, id: string): Promise<boolean>;
  /** 🔴 UN SEUL APPELANT : le résolveur `http`, au moment de l'appel. Rend le secret EN CLAIR. */
  pourAppel(tenantId: string, id: string): Promise<SourceAppel | null>;
  /** Résultat de la dernière épreuve. Best-effort chez l'appelant : jamais bloquant. */
  marquerEpreuve(tenantId: string, id: string, ok: boolean, erreur?: string): Promise<void>;
}
