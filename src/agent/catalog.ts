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

import type { Geste } from './gestes';

export type OrigineOutil = 'mba' | 'http' | 'mcp';

/** `irreversible` n'est pas refusé en bloc : c'est le drapeau `autonome`, posé outil par outil par un
 *  administrateur, qui décide (tranché le 2026-08-26). */
export type RisqueOutil = 'read' | 'write' | 'irreversible';

/**
 * QUI a déclenché un appel de connecteur (migration 0142). Fermé, et gardé par un CHECK en base.
 *
 * ⚠️ CE N'EST PAS `OrigineOutil`. Celle-ci dit de quelle NATURE est l'outil (`mba`, `http`, `mcp`) ;
 * celle-là dit quel CHEMIN du produit a passé l'appel. Un connecteur `http` peut être appelé par chacun
 * d'eux, l'agent de Meta compris depuis le relais (migration 0161).
 */
export const SOURCES_APPEL = ['agent', 'scenario', 'optout', 'mba'] as const;

/**
 * ⚠️ DÉRIVÉ DU TABLEAU, et pas l'inverse : un appelant ajouté au seul type laissait le tableau (donc le test de
 * parité avec le CHECK de `agent_tool_calls.source`, `tests/sources-appel-parite.test.ts`) sans rien voir.
 */
export type SourceAppel = (typeof SOURCES_APPEL)[number];

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
  /**
   * LES GESTES : ce que NOUS faisons quand ce moment se produit, sans le demander au modèle (0158).
   *
   * 🔴 REQUIS, pas optionnel, et pour la même raison que les quatre colonnes MCP : un câblage qui les
   * oublierait ne compile pas. Un `?:` aurait laissé une lecture les perdre en silence, et le symptôme
   * aurait été un tag qui ne se pose jamais, c'est-à-dire un trou dans le mini-CRM que personne ne relie à
   * un outil.
   *
   * ⚠️ Ils sont INDÉPENDANTS de la réussite de la réponse principale : ils marquent que la SITUATION s'est
   * produite. Détail et conséquence sur les libellés : `src/agent/gestes.ts`.
   */
  gestes: Geste[];
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
   * CE QUE CET AGENT FAIT DE LA RÉPONSE (migration 0150, décision de Julien du 2026-09-15).
   *
   * 🔴 `pousse` : l'appel AGIT (poser une étiquette, créer une fiche) et son corps ne sert à rien. L'agent
   * reçoit le VERDICT (`ok`, statut, et le message d'erreur quand ça rate), jamais le contenu d'un succès :
   * une réponse de succès peut porter la fiche entière d'un client, qui partirait sinon chez le fournisseur
   * du modèle sans que personne l'ait demandé.
   *
   * 🔴 `integre` : l'agent lit les champs listés dans `outputPaths`, et rien d'autre.
   *
   * ⚠️ ELLE NE SE DÉDUIT PAS DE LA MÉTHODE HTTP, et c'est pour ça qu'on la demande : un `POST` peut
   * parfaitement être une RECHERCHE (l'API de UChat en a). Dériver la nature du verbe classerait ces
   * appels-là en « pousse » et rendrait leur réponse invisible à l'agent.
   */
  nature: NatureOutil;
  /**
   * Chemins d'extraction de la réponse, quand la nature est `integre`. Vide sur un `pousse`.
   *
   * 🔴 C'EST L'OUTIL QUI LES PORTE DEPUIS LE 2026-09-15, PLUS LA REQUÊTE, et l'inversion est le cœur du
   * chantier. Un appel est PARTAGÉ entre agents ; ce que CET agent a le droit de lire ne l'est pas. Tant que
   * la liste vivait sur l'appel, restreindre pour un agent restreignait pour tous, et l'élargir pour un
   * autre élargissait pour tous. La requête garde la sienne, mais comme simple DÉFAUT de pré-remplissage au
   * moment du rattachement.
   *
   * ⚠️ Cette colonne existait déjà (migration 0086) et était délibérément laissée VIDE pour les connecteurs.
   * Conséquence mesurée le 2026-09-15 : le bac à sable (`connecteurSimule`) bouclait dessus et rendait `{}`,
   * alors que son commentaire promettait « exactement ce que l'agent recevra ». La remplir répare ça.
   */
  outputPaths: string[];
  risk: RisqueOutil;
  timeoutMs: number;
  maxBytes: number;
  /** Le client autorise cet outil à agir seul, même sur une action irréversible. */
  autonome: boolean;
  /**
   * CE QU'UN OUTIL IMPORTÉ D'UN SERVEUR MCP GARDE DE SON ANNONCE (migration 0152).
   *
   * 🔴 LES QUATRE SONT REQUIS, PAS OPTIONNELS, et c'est ce qui les fait voyager. Un câblage qui les
   * oublierait ne compile pas : c'est exactement ce qui a fait tenir `grapheFige` jusque dans le balayage
   * des parcours endormis, là où un `?:` l'aurait laissé se perdre en silence sur un chemin sur deux.
   *
   * `mcpAnnonce` est l'annonce BRUTE du serveur. Elle n'est pas un doublon de `params` : elle est la seule
   * façon de DIRE CE QUI A CHANGÉ au rafraîchissement, quand le consentement tombe parce que le schéma a
   * bougé. Sans elle, le client devrait réautoriser à l'aveugle.
   */
  mcpAnnonce: unknown;
  /** `null` = activable. Sinon la raison en clair, affichée telle quelle : le client ne peut pas la corriger. */
  mcpNonActivable: string | null;
  /** L'outil a disparu du catalogue distant. On ne supprime PAS la ligne : elle trace ce qui a tourné. */
  mcpIndisponibleLe: Date | null;
  /** Dernier rafraîchissement où le serveur l'annonçait encore. */
  mcpVuLe: Date | null;
}

/**
 * Ce qu'un agent fait de la réponse d'un connecteur. DEUX valeurs, et pas trois : « pousse et lit quand
 * même » n'existe pas, c'est `integre` avec les champs qu'on veut.
 */
export type NatureOutil = 'pousse' | 'integre';

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
  /** Les gestes du moment. Absent = inchangé ; `[]` = le client les a tous retirés, ce qui est un choix. */
  gestes?: Geste[];
  title?: string;
  description?: string;
  nePasUtiliser?: string;
  /** Valeurs autorisées, paramètre par paramètre. Seuls les paramètres que le catalogue ouvre sont écrits. */
  enums?: Record<string, string[]>;
}

/** Le nom exposé d'un outil est unique par ESPACE (index de la migration 0127, il l'était par agent avant). */
/**
 * ON NE PEUT PAS ACTIVER UN OUTIL QUE L'IMPORT A DÉCLARÉ NON ACTIVABLE, NI UN OUTIL DISPARU.
 *
 * 🔴 CE REFUS N'EXISTAIT NULLE PART, et c'est la revue à froid qui l'a vu. `mcp_non_activable` était écrit
 * par l'import, rendu par le store, affiché par l'écran MCP... et lu par AUCUNE garde. L'écran qui porte la
 * case d'activation est `Tools > Outils`, qui ne connaissait pas la colonne : rien n'empêchait donc
 * d'activer un outil dont l'aplatisseur avait refusé le schéma. Il partait alors au modèle avec ZÉRO
 * paramètre (`aplatirSchema` rend `feuilles: []` sur un refus) et appelait le serveur avec `{}` à chaque
 * tour. La spec et le commentaire de la migration 0152 affirment tous les deux « on les IMPORTE et on les
 * MONTRE, on ne les active pas » : personne ne le tenait.
 *
 * 🔴 ELLE PORTE LA RAISON, parce que le client ne peut pas la deviner : elle vient du schéma du serveur
 * distant, et c'est à son fournisseur qu'il devra la dire.
 */
export class OutilNonActivable extends Error {
  constructor(public readonly raison: string) {
    super(raison);
    this.name = 'OutilNonActivable';
  }
}

/**
 * 🔴 LE MESSAGE DIT LA BONNE PORTÉE DEPUIS 0157, ET C'ÉTAIT LE DÉFAUT SIGNALÉ PAR JULIEN LUI-MÊME.
 *
 * « un outil de cet espace porte déjà ce nom » est la phrase exacte dont il demandait ce qu'elle voulait
 * dire. La migration 0157 a corrigé la CAUSE (une action est unique par AGENT, plus par espace), mais le
 * message est resté à l'ancienne portée : il continuait donc de désigner un conflit qui n'existe plus, et
 * d'envoyer le client chercher chez le voisin un outil qui est chez lui.
 *
 * ⚠️ LA PORTÉE SE LIT SUR LA CONTRAINTE VIOLÉE, elle ne se devine pas à l'appelant. C'est la base qui sait
 * lequel des deux index partiels a refusé, et `patch` en particulier ne peut pas le savoir autrement : il
 * renomme un outil sans connaître son origine.
 */
export class NomOutilDejaPris extends Error {
  constructor(portee: 'espace' | 'agent' = 'espace') {
    super(`un outil de cet ${portee} porte déjà ce nom`);
    this.name = 'NomOutilDejaPris';
  }
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
  /*
   * ⚠️ IL N'Y A PLUS DE `handler` ICI, ET SON DÉPART EST LE RÉSULTAT DE 0157 (revue finale du 2026-09-18).
   * Il avait été ajouté le matin même pour un bouton « Brancher » : l'onglet d'un agent proposait de créer
   * un outil maison que l'espace définissait déjà, et l'ajout se faisait refuser en 409 sans aucun chemin
   * pour s'en sortir. 0157 a supprimé la CAUSE (une action appartient à son agent, il n'y a plus rien à
   * brancher), le bouton est parti avec elle, et ce champ n'était plus lu par personne. Un champ que plus
   * personne ne lit, dont le commentaire justifie encore un écran qui n'existe plus, est ce qui fait croire
   * au prochain lecteur qu'un mécanisme est en place.
   */
  name: string;
  title: string;
  description: string;
  /**
   * ⚠️ IL EST DANS LA LISTE DEPUIS LE 2026-09-18, parce qu'on ne peut pas CORRIGER ce qu'on ne voit pas.
   * L'écran du MBA doit pré-remplir ce texte pour le retoucher, et le laisser dehors obligerait à le
   * retaper de mémoire, c'est-à-dire à l'écraser par autre chose.
   */
  nePasUtiliser: string;
  origin: OrigineOutil;
  risk: RisqueOutil;
  sourceId: string | null;
  /**
   * 🔴 L'ÉTAT MCP VOYAGE AVEC L'OUTIL, sinon la bibliothèque montre un outil mort comme un outil vivant.
   * Le plan avait posé un paragraphe entier pour que cet oubli soit impossible, et l'oubli a eu lieu quand
   * même : `listCatalogue` ne sélectionnait pas ces deux colonnes, donc `Tools > Outils` et l'onglet
   * Outils du MBA affichaient un outil non activable ou disparu du serveur EXACTEMENT comme les autres.
   * Le client ne l'apprenait qu'en cliquant « activer » et en recevant un 409.
   *
   * ⚠️ `null` PARTOUT AILLEURS, et c'est le cas normal : un outil maison ou de connecteur API n'a pas
   * d'état MCP. Les champs sont REQUIS pour qu'un câblage qui les oublierait ne compile pas.
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
  /**
   * Le même geste pour un consommateur qui n'est pas un agent (le Meta Business Agent).
   *
   * ⚠️ REQUIS, PAS OPTIONNEL : un câblage qui l'oublierait laisserait les outils du MBA figés pour
   * toujours, et c'est exactement l'état dans lequel ils étaient avant le 2026-09-18.
   */
  patchConsommateur(
    tenantId: string, consommateur: string, outilId: string, patch: PatchOutil,
  ): Promise<OutilComplet | null>;

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

  /** Même geste, pour un consommateur qui n'est pas un agent (le MBA). */
  detacherConsommateur(tenantId: string, consommateur: string, outilId: string): Promise<boolean>;

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
    /**
     * La session d'agent, ou `null` quand l'appel n'appartient à aucune (migration 0142).
     *
     * 🔴 NULLABLE DEPUIS QUE LE JOURNAL A TROIS APPELANTS. `creerAppelConnecteur` est le point de passage
     * unique des appels vers le système d'un client : l'agent IA, le bloc « Appel HTTP » d'un scénario, et
     * la poussée d'un opt-out. Les deux derniers n'ouvrent pas de session, et c'est exactement ce qui les
     * empêchait d'écrire ici : leurs échecs ne laissaient qu'un `console.warn`.
     */
    sessionId: string | null;
    /** `null` quand l'outil n'a pas été résolu (nom inconnu) : la tentative se journalise quand même. */
    toolId: string | null;
    toolName: string;
    origin: string;
    /** Arguments RÉDIGÉS. Le tronc commun n'y met que ce que le modèle a fourni, jamais les valeurs injectées. */
    argsRediges: unknown;
    /**
     * QUI a appelé (migration 0142). Sans cette colonne, la ligne d'un scénario et celle d'un agent sont
     * indiscernables, et le jour où la facturation lira cette table (son commentaire de 0086 le promet, et
     * rien ne la lit aujourd'hui, vérifié) elle compterait les unes pour les autres.
     */
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
