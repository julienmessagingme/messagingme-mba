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
  /**
   * La SOURCE externe de cet outil (`agent_tool_sources`, migration 0088), ou `null` pour un outil maison.
   *
   * 🔴 C'est elle qui porte l'adresse de base et le secret, donc la garde anti-SSRF : le résolveur `http` la
   * relit à CHAQUE appel plutôt que de la figer, sinon une source désactivée continuerait d'être appelée
   * jusqu'au prochain redémarrage. La contrainte `agent_tools_origin_src_chk` garantit qu'un outil non
   * maison en a forcément une.
   */
  sourceId: string | null;
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

/** Un outil tel que l'écran de réglage le montre : tout ce que le runtime lit, plus qui a autorisé quoi. */
export interface OutilComplet extends OutilDefini {
  title: string;
  nePasUtiliser: string;
  actif: boolean;
  /** `null` tant que personne ne l'a activé. La migration 0086 refuse `actif` sans lui. */
  activeLe: string | null;
  autonomeLe: string | null;
}

/** Ce qu'un administrateur peut corriger sur un outil. Le `handler` et le risque n'en font PAS partie : ils
 *  viennent du catalogue, et les changer ferait un outil dont le comportement ne suit plus le nom. */
export interface PatchOutil {
  name?: string;
  title?: string;
  description?: string;
  nePasUtiliser?: string;
  /** Valeurs autorisées, paramètre par paramètre. Seuls les paramètres que le catalogue ouvre sont écrits. */
  enums?: Record<string, string[]>;
}

/** Le nom exposé d'un outil est unique par agent (index de la migration 0086). */
export class NomOutilDejaPris extends Error {
  constructor() { super('un outil de cet agent porte déjà ce nom'); this.name = 'NomOutilDejaPris'; }
}

/**
 * L'écriture du catalogue, réservée à l'écran de réglage.
 *
 * 🔴 L'ACTIVATION PORTE LE NOM DE QUI L'A FAITE, et ce n'est pas de la traçabilité de confort. La spec MCP
 * exige un consentement humain avant l'invocation d'un outil ; notre agent n'a aucun humain au runtime. Le
 * consentement est donc déplacé du runtime vers la CONFIGURATION, et la migration 0086 le rend
 * incontournable en base (`actif = false or active_par is not null`). Même doctrine pour l'autonomie.
 *
 * L'identité vient du JETON, jamais du corps de la requête : sinon la trace désignerait qui l'appelant veut.
 */
export interface ToolAdminStore {
  /** TOUS les outils d'un agent, actifs ou non. */
  listToutes(tenantId: string, agentId: string): Promise<OutilComplet[]>;

  /**
   * Ajoute un outil MAISON à un agent, inactif. Rend `null` si l'agent n'existe pas ou appartient à un autre
   * tenant. LÈVE `NomOutilDejaPris` si le nom exposé est déjà porté par un outil de cet agent.
   */
  ajouter(tenantId: string, agentId: string, outil: {
    handler: string; name: string; title: string; description: string; nePasUtiliser: string;
    params: unknown; risk: RisqueOutil;
  }): Promise<OutilComplet | null>;

  /** Corrige les mots d'un outil. Rend `null` s'il n'est pas de ce couple (tenant, agent). */
  patch(tenantId: string, agentId: string, outilId: string, patch: PatchOutil): Promise<OutilComplet | null>;

  /** Active ou désactive. `parUtilisateur` vient du jeton. Rend `null` si l'outil n'est pas de ce couple. */
  activer(tenantId: string, agentId: string, outilId: string, actif: boolean, parUtilisateur: string): Promise<OutilComplet | null>;

  /** Coche ou décoche l'autonomie sur une action irréversible. `parUtilisateur` vient du jeton. */
  autonomie(tenantId: string, agentId: string, outilId: string, autonome: boolean, parUtilisateur: string): Promise<OutilComplet | null>;

  retirer(tenantId: string, agentId: string, outilId: string): Promise<boolean>;
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
