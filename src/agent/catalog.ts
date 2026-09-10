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
  /**
   * ⚠️ PLUS D'`agentId` DEPUIS LA MIGRATION 0127. Un outil appartient désormais à l'ESPACE, et le couple
   * (outil, consommateur) porte le consentement. L'agent qui a demandé cet outil est connu de l'APPELANT,
   * qui vient de le nommer : le remettre sur la ligne recréerait la duplication qu'on vient de retirer.
   */
  origin: OrigineOutil;
  /** Nom EXPOSÉ au modèle. */
  name: string;
  description: string;
  /**
   * La clause « quand NE PAS l'appeler ». EXPOSÉE AU MODÈLE, à la suite de la description.
   *
   * 🔴 ELLE NE L'ÉTAIT PAS, ET PERSONNE NE POUVAIT LE VOIR. Jusqu'au 2026-08-29, cette colonne ne vivait que
   * dans la projection d'ADMINISTRATION : le runtime ne la lisait même pas, et `outilExpose` ne construisait
   * que `{name, description, parameters}`. Or la colonne existe, la route l'exige pour un connecteur, l'écran
   * l'affiche, l'assistant de construction la rédige, et le CLAUDE.md dit d'elle qu'« elle évite les appels
   * de trop ». C'était donc du travail demandé au client sur le SEUL levier qui décide quand un outil se
   * déclenche, et ce travail ne produisait rien.
   *
   * ⚠️ Elle est lue par le RUNTIME, elle appartient donc à `OutilDefini` et pas à `OutilComplet`.
   */
  nePasUtiliser: string;
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
  /**
   * La REQUÊTE que cet outil déclenche (`connector_requests`, migration 0105), ou `null` pour un outil maison.
   *
   * 🔴 C'est ce qui a remplacé la description de l'appel DANS l'outil. Avant, la méthode, le chemin et les
   * paramètres vivaient ici, donc le même appel était redécrit pour chaque agent qui s'en servait, et le
   * corriger quelque part ne le corrigeait pas ailleurs. L'outil DÉSIGNE désormais un appel mis au point une
   * fois dans la bibliothèque du workspace.
   */
  requestId: string | null;
  /**
   * Chemins d'extraction de la réponse. Vide = la réponse entière (bornée par `maxBytes`).
   *
   * ⚠️ Pour un connecteur, c'est la REQUÊTE qui porte cette liste, et c'est elle que le résolveur lit : ce
   * qu'un agent a le droit de lire dans une réponse est une propriété de l'appel, pas de l'agent. Ce champ-ci
   * ne sert plus qu'aux outils maison.
   */
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

  /**
   * ⚠️ `listActifsConsommateur` EXISTE SUR L'IMPLÉMENTATION, PAS DANS CE CONTRAT, et c'est délibéré. C'est
   * la porte par laquelle le Meta Business Agent entrera sans qu'on lui invente une fiche d'agent, mais
   * aucun appelant ne l'utilise encore : l'exiger ici obligerait huit faux de test à écrire une méthode que
   * personne n'appelle. Elle entrera dans le contrat le jour où un consommateur non-agent existe.
   */
}

/** Un outil tel que l'écran de réglage le montre : tout ce que le runtime lit, plus qui a autorisé quoi. */
export interface OutilComplet extends OutilDefini {
  title: string;
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

/** Le nom exposé d'un outil est unique par ESPACE (index de la migration 0127, il l'était par agent avant). */
export class NomOutilDejaPris extends Error {
  constructor() { super('un outil de cet espace porte déjà ce nom'); this.name = 'NomOutilDejaPris'; }
}

/**
 * Une DÉFINITION de l'espace, vue de la bibliothèque : ce qu'elle est, et QUI s'en sert.
 *
 * 🔴 LA COLONNE « UTILISÉ PAR » EST TOUTE LA RAISON DE CET ÉCRAN. Un outil déclaré une fois et branché sur
 * trois agents était jusqu'ici trois outils qui se ressemblaient, et corriger ses mots à un endroit ne les
 * corrigeait pas aux deux autres. Sans ce chiffre, la bibliothèque ne serait qu'une liste de plus.
 */
export interface OutilBibliotheque {
  id: string;
  name: string;
  title: string;
  description: string;
  origin: OrigineOutil;
  risk: RisqueOutil;
  sourceId: string | null;
  consommateurs: Array<{
    cle: string;
    actif: boolean;
    /** L'identifiant de l'agent, ou `null` quand ce consommateur n'en est pas un (le MBA). */
    agentId: string | null;
    /** Le nom lisible de l'agent, ou `null`. Un écran qui n'afficherait que des UUID ne sert à rien. */
    agentLabel: string | null;
  }>;
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

  /**
   * Rend cet outil de l'espace disponible pour cet agent, INACTIF.
   *
   * ⚠️ LE RATTACHEMENT ET L'ACTIVATION SONT DEUX GESTES. Les fondre ferait qu'ajouter un outil de la
   * bibliothèque à un agent l'exposerait au modèle dans la foulée, sans que personne ait relu ses mots :
   * exactement ce que la migration 0086 existe pour empêcher.
   * `false` = l'outil n'existe pas dans cet espace, ou il y est déjà rattaché.
   */
  rattacher(tenantId: string, agentId: string, outilId: string): Promise<boolean>;

  /** Même geste, pour un consommateur qui n'est pas un agent (le MBA). */
  rattacherConsommateur(tenantId: string, consommateur: string, outilId: string): Promise<boolean>;

  /** Retire l'outil de CET agent. La définition reste dans l'espace. */
  detacher(tenantId: string, agentId: string, outilId: string): Promise<boolean>;

  /** Active ou désactive pour un consommateur qui n'est pas un agent. */
  activerConsommateur(tenantId: string, consommateur: string, outilId: string, actif: boolean, parUtilisateur: string): Promise<OutilComplet | null>;

  /**
   * Supprime la DÉFINITION, donc pour tout le monde.
   *
   * 🔴 REFUSE tant qu'un consommateur y est rattaché (`'rattachee'`), même inactif. La contrainte de la
   * migration 0127 est en `on delete cascade` : sans ce refus applicatif, supprimer une définition
   * emporterait EN SILENCE le consentement d'agents qu'on ne regardait pas.
   */
  supprimerDefinition(tenantId: string, outilId: string): Promise<'ok' | 'rattachee' | 'introuvable'>;

  /** TOUTES les définitions de l'espace, avec qui s'en sert. C'est l'écran Bibliothèque. */
  listCatalogue(tenantId: string): Promise<OutilBibliotheque[]>;
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
