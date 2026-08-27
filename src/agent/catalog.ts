/**
 * Le catalogue d'outils d'un agent, et le journal de leurs appels.
 *
 * Les deux contrats vivent ensemble parce qu'ils décrivent la même famille (`agent_tools` et
 * `agent_tool_calls`, migration 0086) et qu'aucun consommateur n'a l'un sans l'autre : le tronc commun
 * (`src/agent/executor.ts`) résout dans le premier et journalise dans le second, dans le même appel.
 *
 * ⚠️ `tenantId` est exigé par CHAQUE méthode. Le pooler est en rôle superuser, la RLS est donc bypassée et le
 * filtrage en code est le SEUL contrôle d'isolation. Le nom d'outil vient du modèle : sans ce filtre, une
 * injection réussie dans le message d'un contact appellerait l'outil d'un autre client.
 */

export type OrigineOutil = 'mba' | 'http' | 'mcp';

/** `irreversible` n'est pas refusé en bloc : c'est le drapeau `autonome`, posé outil par outil par un
 *  administrateur, qui décide (tranché le 2026-08-26). */
export type RisqueOutil = 'read' | 'write' | 'irreversible';

/** Les statuts de `agent_tool_calls.status`. `erreur_protocole` est le seul qui arrête le tour. */
export type StatutAppel = 'ok' | 'erreur_outil' | 'refuse' | 'timeout' | 'erreur_protocole' | 'budget';

export interface OutilDefini {
  id: string;
  tenantId: string;
  agentId: string;
  origin: OrigineOutil;
  /** Nom EXPOSÉ au modèle. */
  name: string;
  description: string;
  /** `agent_tools.params`, du jsonb donc OPAQUE : à lire par `paramsOutil` et rien d'autre. */
  params: unknown;
  /** Ce qui dit au résolveur quoi faire (`handler` pour `mba`, gabarit d'URL pour `http`...). Opaque ici. */
  binding: Record<string, unknown>;
  /** Chemins d'extraction de la réponse. Vide = la réponse entière (bornée par `maxBytes`). */
  outputPaths: string[];
  risk: RisqueOutil;
  timeoutMs: number;
  maxBytes: number;
  /** Le client autorise cet outil à agir seul, même sur une action irréversible. */
  autonome: boolean;
}

export interface ToolCatalog {
  /**
   * Un outil ACTIF par son nom exposé. `null` = inconnu, inactif, ou appartenant à un autre agent ou à un
   * autre tenant.
   *
   * 🔴 L'autorisation se relit ICI, à l'exécution. Filtrer ce qu'on envoie au modèle n'est PAS un contrôle :
   * `vercel/ai#8653` documente exactement le cas où le filtrage d'exposition marchait pendant que
   * l'exécuteur tapait dans le catalogue complet.
   */
  byName(tenantId: string, agentId: string, name: string): Promise<OutilDefini | null>;

  /** Les outils actifs d'un agent, pour construire ce qu'on expose au modèle. */
  listActifs(tenantId: string, agentId: string): Promise<OutilDefini[]>;
}

export interface JournalAppels {
  /**
   * Ouvre la ligne d'appel AVANT l'exécution, et rend son identifiant.
   *
   * L'ordre est le sujet : la file est at-least-once et un process peut mourir pendant l'appel. On veut la
   * trace d'une TENTATIVE, sans quoi un outil qui fait mourir le worker à tous les coups serait invisible.
   * Cette table est aussi le grand livre de facturation, volontairement la même (migration 0086).
   */
  ouvrir(input: {
    tenantId: string;
    sessionId: string;
    /** `null` quand l'outil n'a pas été résolu (nom inconnu) : la tentative se journalise quand même. */
    toolId: string | null;
    toolName: string;
    origin: string;
    /** Arguments RÉDIGÉS. Le tronc commun n'y met que ce que le modèle a fourni, jamais les valeurs injectées. */
    argsRediges: unknown;
  }): Promise<string>;

  /** Clôt la ligne avec son issue. Best-effort chez l'appelant : un journal muet ne doit pas tuer un tour. */
  clore(input: {
    tenantId: string;
    id: string;
    status: StatutAppel;
    httpStatus?: number;
    dureeMs: number;
    tailleReponse?: number;
    erreur?: string;
  }): Promise<void>;
}
