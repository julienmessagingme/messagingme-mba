import type { FicheAgentContenu } from './fiche';

/**
 * Les plafonds d'un agent, lus sur sa fiche. Ce sont des gardes de SÉCURITÉ, pas un détail de facturation :
 * une injection qui fait boucler l'agent brûlerait le compte prépayé du tenant.
 *
 * Déclarés ICI et non dans `run-turn.ts` : `FicheAgent` les porte, et le tour lit la fiche entière (il a
 * besoin de l'inactivité en plus). Les garder là-bas obligeait les deux modules à s'importer l'un l'autre.
 */
export interface PlafondsAgent {
  maxTours: number;
  maxAppelsOutils: number;
  budgetMicroEur: number;
}

/**
 * La fiche d'un agent, vue du runtime. Volontairement RÉDUITE à ce dont un tour a besoin : ses plafonds, son
 * modèle, sa mention d'IA et son statut. Le contenu éditorial (objectif, ton, règles) vit dans la colonne
 * `fiche` en jsonb et n'est lu que par le cerveau, pas par le tour.
 */
/** Les trois régimes d'annonce. Fermé, et gardé par un CHECK en base : une valeur inattendue est refusée
 *  par la base, pas seulement par un schéma applicatif. */
export type FrequenceMentionIa = 'jamais' | 'session' | 'chaque_message';

export const FREQUENCES_MENTION_IA: readonly FrequenceMentionIa[] = ['jamais', 'session', 'chaque_message'];

/** Une valeur venue de la base est-elle un régime connu ? Sert au repli sûr d'une base en retard. */
export function estFrequenceMention(v: unknown): v is FrequenceMentionIa {
  return typeof v === 'string' && (FREQUENCES_MENTION_IA as readonly string[]).includes(v);
}

export interface FicheAgent {
  id: string;
  tenantId: string;
  /** Phrase annonçant que l'interlocuteur parle à une IA. Jamais vide ; QUAND elle est dite dépend du
   *  régime ci-dessous (migration 0126), elle n'est plus systématique. */
  mentionIa: string;
  /**
   * QUAND cette phrase est dite (migration 0126, demande de Julien du 2026-09-09).
   *
   * 🔴 C'EST LE CODE QUI DÉCIDE, PLUS LE MODÈLE. Avant, la consigne système disait « au tout premier message
   * d'une conversation, annonce que tu es une IA » : le modèle devait deviner depuis un transcript où
   * commence une conversation, ce qu'il ne sait pas. Un réglage « une fois par session » posé sur cette base
   * n'aurait jamais pu être tenu. Le tour sait, lui, si l'agent a déjà parlé dans CETTE session.
   *
   * ⚠️ `jamais` est un choix EXPLICITE du client, obtenu en le lui demandant à la construction. L'obligation
   * d'information (AI Act, article 50) ne joue que lorsqu'elle n'est pas évidente du contexte, et elle pèse
   * sur la marque déployante : c'est donc à elle de trancher, pas à nous de décider en silence.
   */
  mentionIaFrequence: FrequenceMentionIa;
  modele: string;
  plafonds: PlafondsAgent;
  /** Minutes d'inactivité avant que le parcours reprenne la main. */
  inactiviteMinutes: number;
  /** Ce que l'agent a le droit de faire quand il ne sait pas à qui il parle. Lu par le TOUR, pas seulement
   *  par l'écran de réglage : c'est une garde d'exécution, appliquée à chaque appel d'outil. */
  contactInconnu: 'aucun_outil' | 'lecture_seule' | 'tous';
  status: 'draft' | 'active' | 'disabled';
}

/**
 * Une SORTIE déclarée par le client sur la fiche de son agent : sa règle d'arrêt. Le code est ce que l'outil
 * `mba_terminer` rend, et il devient le handle `sortie:<code>` du bloc dans le builder.
 *
 * Les sorties vivent sur la FICHE : c'est là que le client les déclare, une fois, pour tous les blocs qui
 * servent cet agent.
 *
 * ⚠️ Le builder les COPIE dans le bloc au moment du choix, et cette copie peut ensuite diverger de la fiche
 * (une règle ajoutée après coup n'apparaît pas toute seule dans un bloc déjà configuré). L'issue d'un code
 * non câblé n'est pas silencieuse pour autant : `advance` remonte la conversation en inbox avec une trace,
 * comme pour un bouton non branché.
 */
export interface SortieAgent {
  code: string;
  label: string;
}

/** Ce que le builder a besoin de savoir d'un agent pour le proposer et dessiner ses sorties. */
export interface AgentResume {
  id: string;
  label: string;
  status: StatutAgent;
  sorties: SortieAgent[];
}

export type StatutAgent = 'draft' | 'active' | 'disabled';

/** La fiche ENTIÈRE, telle que l'écran de réglage l'édite. `contenu` est la partie jsonb (ce que l'IA de
 *  construction pourra écrire), le reste vit en colonnes et n'est écrit que par un administrateur. */
export interface AgentComplet {
  id: string;
  label: string;
  status: StatutAgent;
  mentionIa: string;
  /**
   * ⚠️ PLUS DE `mentionIaFrequence` ICI DEPUIS LA MIGRATION 0140 : le régime d'annonce d'IA appartient à
   * l'ESPACE, pas à l'agent (l'AI Act fait peser l'obligation sur la marque déployante). Il se lit et
   * s'écrit par `TenantSettings.mentionIaFrequence`, et l'écran Sécurité > IA le porte. Le laisser ici
   * ferait une SECONDE vérité à côté, et le jour où les deux divergent c'est celle qu'on n'édite plus qui
   * serait lue.
   */
  modele: string;
  maxTours: number;
  maxAppelsOutils: number;
  budgetMicroEur: number;
  inactiviteMinutes: number;
  contactInconnu: 'aucun_outil' | 'lecture_seule' | 'tous';
  contenu: FicheAgentContenu;
  /** Compteur d'écritures de la fiche. L'écran le renvoie tel quel dans son patch : c'est le verrou. */
  ficheVersion: number;
}

/** Ce qu'un administrateur peut écrire. Tout est optionnel : l'écran enregistre champ par champ. */
export interface PatchAgent {
  label?: string;
  status?: StatutAgent;
  mentionIa?: string;
  modele?: string;
  maxTours?: number;
  maxAppelsOutils?: number;
  budgetMicroEur?: number;
  inactiviteMinutes?: number;
  contactInconnu?: 'aucun_outil' | 'lecture_seule' | 'tous';
  /**
   * La partie jsonb, DÉJÀ validée. PARTIELLE : seules les clés présentes sont écrites, les autres restent
   * telles quelles en base.
   *
   * 🔴 POURQUOI UNE FUSION ET NON UN REMPLACEMENT. Deux surfaces éditent la même fiche (le formulaire, et
   * l'IA de construction qui vient), et le formulaire enregistre CHAMP PAR CHAMP. Un remplacement total
   * ferait qu'enregistrer l'objectif depuis un onglet efface la règle d'arrêt qu'un autre onglet vient
   * d'ajouter, sans la moindre erreur. Et un `{}` envoyé par erreur viderait la fiche entière.
   */
  contenu?: Partial<FicheAgentContenu>;
  /**
   * Verrou optimiste sur la fiche. Fourni -> l'écriture n'a lieu QUE si la version en base est celle-là.
   *
   * La fusion ci-dessus protège les clés que l'appelant ne touche pas ; ce verrou protège celles qu'il
   * touche. Sans lui, deux surfaces qui réécrivent `sorties` en même temps se recouvrent en silence, et le
   * plan exige justement qu'elles cohabitent.
   */
  ficheVersionAttendue?: number;
}

/** L'écriture a été refusée parce que la fiche a changé entre la lecture et l'enregistrement. */
export class FicheAgentPerimee extends Error {
  constructor() { super('la fiche a changé depuis son chargement'); this.name = 'FicheAgentPerimee'; }
}

/** Le libellé d'un agent est unique par workspace (index de la migration 0086). */
export class LabelAgentDejaPris extends Error {
  constructor() { super('un agent porte déjà ce nom'); this.name = 'LabelAgentDejaPris'; }
}

export interface AgentStore {
  /**
   * Une fiche d'agent par son identifiant. `null` si elle n'existe pas OU si elle appartient à un autre
   * tenant : `node.data.agentId` est opaque et fourni par le client, il peut donc pointer l'agent d'un autre.
   * Le filtrage par tenant est le SEUL contrôle (le pooler est superuser, la RLS est bypassée).
   */
  byId(tenantId: string, id: string): Promise<FicheAgent | null>;

  /**
   * Les agents ACTIFS d'un tenant, pour la palette du builder.
   *
   * Actifs seulement : un agent en brouillon n'est pas prêt à tenir une conversation, et le proposer dans un
   * scénario promettrait un envoi qui n'aurait pas lieu. Même doctrine que les blocs RCS et email, grisés
   * tant que ce qu'il y a derrière n'existe pas.
   */
  listActifs(tenantId: string): Promise<AgentResume[]>;

  /** TOUS les agents d'un tenant, brouillons et désactivés compris : c'est la liste de l'écran de réglage. */
  listToutes(tenantId: string): Promise<AgentResume[]>;

  /** La fiche entière d'un agent, pour l'éditer. `null` si elle n'existe pas ou appartient à un autre tenant. */
  complet(tenantId: string, id: string): Promise<AgentComplet | null>;

  /**
   * Crée un agent, en BROUILLON. Jamais actif d'emblée : un agent est prêt quand un humain le dit, et
   * l'activer serait le rendre proposable dans les scénarios avant que quiconque ait relu ce qu'il dira.
   */
  create(tenantId: string, label: string, mentionIa: string, modele: string): Promise<AgentComplet>;

  /** Supprime un agent. Rend `false` s'il n'existe pas ou appartient à un autre tenant. */
  remove(tenantId: string, id: string): Promise<boolean>;

  /**
   * Écrit un patch d'administrateur. Rend `null` si l'agent n'existe pas ou appartient à un autre tenant.
   * LÈVE `FicheAgentPerimee` si un `ficheVersionAttendue` est fourni et ne correspond plus, et
   * `LabelAgentDejaPris` si le libellé est déjà porté par un autre agent du workspace.
   */
  patch(tenantId: string, id: string, patch: PatchAgent): Promise<AgentComplet | null>;
}
