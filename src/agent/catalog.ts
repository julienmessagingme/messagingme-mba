/**
 * Le catalogue d'outils d'un agent, et le journal de leurs appels : deux contrats d'une même famille
 * (`agent_tools`, `agent_tool_calls`), que le tronc commun (`src/agent/executor.ts`) utilise dans le même
 * appel.
 *
 * 🔴 `tenantId` est exigé par chaque méthode : la RLS est contournée par le pooler, et le nom d'outil vient
 * du modèle. Sans ce filtre, une injection dans le message d'un contact appellerait l'outil d'un autre client.
 */

import type { Geste } from './gestes';

export type OrigineOutil = 'mba' | 'http' | 'mcp';

/** `irreversible` n'est pas refusé en bloc : c'est le drapeau `autonome`, posé outil par outil par un
 *  administrateur, qui décide. */
export type RisqueOutil = 'read' | 'write' | 'irreversible';

/**
 * Qui a déclenché un appel de connecteur, liste fermée gardée par un CHECK en base. À ne pas confondre avec
 * `OrigineOutil` (la nature de l'outil) : ceci dit quel chemin du produit a passé l'appel. `signaux` : la
 * poussée des signaux vers l'outil branché dans Paramètres > Intégrations, dont l'échec est de même nature
 * (le système du client a refusé).
 */
export const SOURCES_APPEL = ['agent', 'scenario', 'optout', 'mba', 'signaux'] as const;

/** Dérivé du tableau, pas l'inverse : le tableau est ce que `tests/sources-appel-parite.test.ts` compare au
 *  CHECK de `agent_tool_calls.source`. */
export type SourceAppel = (typeof SOURCES_APPEL)[number];

/** Les statuts de `agent_tool_calls.status`. `erreur_protocole` est le seul qui arrête le tour. */
export type StatutAppel = 'ok' | 'erreur_outil' | 'refuse' | 'timeout' | 'erreur_protocole' | 'budget';

export interface OutilDefini {
  id: string;
  tenantId: string;
  /** Pas d'`agentId` : un outil appartient à l'espace, le couple (outil, consommateur) porte le consentement. */
  origin: OrigineOutil;
  /** Nom exposé au modèle. */
  name: string;
  description: string;
  /** La clause « quand ne pas l'appeler », exposée au modèle à la suite de la description. Lue par le
   *  runtime, elle appartient donc à `OutilDefini`, pas à `OutilComplet`. */
  nePasUtiliser: string;
  /**
   * Les gestes : ce que nous faisons quand ce moment se produit, sans le demander au modèle, que la réponse
   * principale réussisse ou non (`src/agent/gestes.ts`). Requis : un câblage qui les oublierait ne compile pas.
   */
  gestes: Geste[];
  /** `agent_tools.params`, jsonb opaque : à lire par `paramsOutil` et rien d'autre. */
  params: unknown;
  /** Ce qui dit au résolveur quoi faire (`handler` pour `mba`, gabarit d'URL pour `http`...). Opaque ici. */
  binding: Record<string, unknown>;
  /**
   * La source externe de cet outil (`agent_tool_sources`), ou `null` pour un outil maison. Elle porte l'adresse
   * de base et le secret : le résolveur la relit à chaque appel, pour qu'une source désactivée cesse aussitôt.
   */
  sourceId: string | null;
  /** La requête que cet outil déclenche (`connector_requests`), ou `null` pour un outil maison : l'outil
   *  désigne un appel mis au point une fois dans la bibliothèque, au lieu de le redécrire par agent. */
  requestId: string | null;
  /**
   * Ce que cet agent fait de la réponse.
   *
   * 🔴 `pousse` : l'appel agit, l'agent ne reçoit que le verdict (`ok`, statut, message d'erreur), jamais le
   * corps d'un succès, qui peut porter la fiche entière d'un client et partirait chez le fournisseur du
   * modèle. `integre` : l'agent lit les champs de `outputPaths`, et rien d'autre. Ne se déduit pas de la
   * méthode HTTP : un `POST` peut être une recherche.
   */
  nature: NatureOutil;
  /**
   * Chemins d'extraction de la réponse, quand la nature est `integre` (vide sur un `pousse`). Portés par
   * l'outil, pas par la requête : un appel est partagé entre agents, ce que chaque agent a le droit de lire
   * ne l'est pas. La requête garde les siens comme défaut de pré-remplissage.
   */
  outputPaths: string[];
  risk: RisqueOutil;
  timeoutMs: number;
  maxBytes: number;
  /** Le client autorise cet outil à agir seul, même sur une action irréversible. */
  autonome: boolean;
  /**
   * Ce qu'un outil importé d'un serveur MCP garde de son annonce. Les quatre champs sont requis : un câblage
   * qui les oublierait ne compile pas. `mcpAnnonce` est l'annonce brute : la seule façon de dire ce qui a
   * changé au rafraîchissement, quand le consentement tombe.
   */
  mcpAnnonce: unknown;
  /** `null` = activable. Sinon la raison en clair, affichée telle quelle : le client ne peut pas la corriger. */
  mcpNonActivable: string | null;
  /** L'outil a disparu du catalogue distant. On ne supprime pas la ligne : elle trace ce qui a tourné. */
  mcpIndisponibleLe: Date | null;
  /** Dernier rafraîchissement où le serveur l'annonçait encore. */
  mcpVuLe: Date | null;
}

/** Ce qu'un agent fait de la réponse d'un connecteur. Deux valeurs : « pousse et lit quand même », c'est
 *  `integre` avec les champs qu'on veut. */
export type NatureOutil = 'pousse' | 'integre';

export interface ToolCatalog {
  /**
   * Un outil actif par son nom exposé. `null` = inconnu, inactif, ou appartenant à un autre agent ou tenant.
   * 🔴 L'autorisation se relit ici, à l'exécution : filtrer ce qu'on expose au modèle n'est pas un contrôle
   * (`vercel/ai#8653`).
   */
  byName(tenantId: string, agentId: string, name: string): Promise<OutilDefini | null>;

  /** Les outils actifs d'un agent, pour construire ce qu'on expose au modèle. */
  listActifs(tenantId: string, agentId: string): Promise<OutilDefini[]>;

  /**
   * `listActifsConsommateur` existe sur l'implémentation, pas dans ce contrat : l'y exiger obligerait chaque
   * faux de test à l'écrire sans qu'un appelant du contrat s'en serve.
   */
}

/** Un outil tel que l'écran de réglage le montre : tout ce que le runtime lit, plus qui a autorisé quoi. */
export interface OutilComplet extends OutilDefini {
  title: string;
  actif: boolean;
  /** `null` tant que personne ne l'a activé. La base refuse `actif` sans lui. */
  activeLe: string | null;
  autonomeLe: string | null;
}

/** Ce qu'un administrateur peut corriger sur un outil. Ni le `handler` ni le risque : ils viennent du
 *  catalogue, et les changer ferait un outil dont le comportement ne suit plus le nom. */
export interface PatchOutil {
  name?: string;
  /** Les gestes du moment. Absent = inchangé ; `[]` = le client les a tous retirés, ce qui est un choix. */
  gestes?: Geste[];
  title?: string;
  description?: string;
  nePasUtiliser?: string;
  /** Valeurs autorisées, paramètre par paramètre. Seuls les paramètres que le catalogue ouvre sont écrits. */
  enums?: Record<string, string[]>;
}

/**
 * On ne peut pas activer un outil que l'import a déclaré non activable, ni un outil disparu : il partirait
 * au modèle sans paramètre et appellerait le serveur avec `{}` à chaque tour. L'erreur porte la raison, qui
 * vient du schéma distant : le client devra la dire à son fournisseur.
 */
export class OutilNonActivable extends Error {
  constructor(public readonly raison: string) {
    super(raison);
    this.name = 'OutilNonActivable';
  }
}

/**
 * Le nom exposé est déjà pris, dans l'espace (connecteur) ou chez l'agent (action). La portée se lit sur la
 * contrainte violée, pas chez l'appelant : `patch` renomme un outil sans connaître son origine.
 */
export class NomOutilDejaPris extends Error {
  constructor(portee: 'espace' | 'agent' = 'espace') {
    super(`un outil de cet ${portee} porte déjà ce nom`);
    this.name = 'NomOutilDejaPris';
  }
}

/**
 * Une définition de l'espace, vue de la bibliothèque : ce qu'elle est, et qui s'en sert. La colonne
 * « utilisé par » dit qu'un outil branché sur trois agents est un seul outil, corrigé partout à la fois.
 */
export interface OutilBibliotheque {
  id: string;
  name: string;
  title: string;
  description: string;
  /** Dans la liste pour que l'écran du MBA puisse pré-remplir ce texte et le retoucher. */
  nePasUtiliser: string;
  origin: OrigineOutil;
  risk: RisqueOutil;
  sourceId: string | null;
  /**
   * L'état MCP voyage avec l'outil, sinon la bibliothèque montrerait un outil mort comme un vivant. `null`
   * pour un outil maison ou de connecteur API ; requis pour qu'un câblage qui l'oublie ne compile pas.
   */
  mcpNonActivable: string | null;
  mcpIndisponibleLe: string | null;
  consommateurs: Array<{
    cle: string;
    actif: boolean;
    /** L'identifiant de l'agent, ou `null` quand ce consommateur n'en est pas un (le MBA). */
    agentId: string | null;
    /** Le nom lisible de l'agent, ou `null`. Un écran qui n'afficherait que des UUID ne sert à rien. */
    agentLabel: string | null;
  }>;
}

export interface JournalAppels {
  /**
   * Ouvre la ligne d'appel avant l'exécution, et rend son identifiant : la file est at-least-once et un
   * process peut mourir pendant l'appel, on veut la trace de la tentative. Cette table est aussi le grand
   * livre de facturation.
   */
  ouvrir(input: {
    tenantId: string;
    /**
     * La session d'agent, ou `null` quand l'appel n'en a pas : `creerAppelConnecteur` sert aussi le bloc
     * « Appel HTTP » d'un scénario et la poussée d'un opt-out, qui n'ouvrent pas de session.
     */
    sessionId: string | null;
    /** `null` quand l'outil n'a pas été résolu (nom inconnu) : la tentative se journalise quand même. */
    toolId: string | null;
    toolName: string;
    origin: string;
    /** Arguments rédigés : ce que le modèle a fourni, jamais les valeurs injectées. */
    argsRediges: unknown;
    /** Qui a appelé : sans cette colonne, la ligne d'un scénario et celle d'un agent seraient indiscernables,
     *  y compris pour la facturation. */
    source: SourceAppel;
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
