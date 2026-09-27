import type { FicheAgentContenu } from './fiche';

/**
 * Les plafonds d'un agent, lus sur sa fiche. 🔴 Des gardes de sécurité, pas un détail de facturation : une
 * injection qui fait boucler l'agent brûlerait le compte prépayé du tenant. Déclarés ici et non dans
 * `run-turn.ts` pour éviter un import circulaire.
 */
export interface PlafondsAgent {
  maxTours: number;
  maxAppelsOutils: number;
  budgetMicroEur: number;
}

/** Les trois régimes d'annonce, liste fermée et gardée par un CHECK en base. */
export type FrequenceMentionIa = 'jamais' | 'session' | 'chaque_message';

export const FREQUENCES_MENTION_IA: readonly FrequenceMentionIa[] = ['jamais', 'session', 'chaque_message'];

/** Une valeur venue de la base est-elle un régime connu ? Sert au repli sûr d'une base en retard. */
export function estFrequenceMention(v: unknown): v is FrequenceMentionIa {
  return typeof v === 'string' && (FREQUENCES_MENTION_IA as readonly string[]).includes(v);
}

export interface FicheAgent {
  id: string;
  tenantId: string;
  /** Phrase annonçant que l'interlocuteur parle à une IA. Jamais vide ; quand elle est dite dépend du
   *  régime ci-dessous. */
  mentionIa: string;
  /**
   * Quand cette phrase est dite. C'est le code qui décide, pas le modèle : le tour sait si l'agent a déjà
   * parlé dans cette session. `jamais` est un choix explicite du client : l'obligation d'information (AI Act,
   * article 50) pèse sur la marque déployante, et ne joue que si ce n'est pas évident du contexte.
   */
  mentionIaFrequence: FrequenceMentionIa;
  modele: string;
  plafonds: PlafondsAgent;
  /** Minutes d'inactivité avant que le parcours reprenne la main. */
  inactiviteMinutes: number;
  /** Ce que l'agent a le droit de faire quand il ne sait pas à qui il parle. Garde d'exécution, appliquée
   *  par le tour à chaque appel d'outil. */
  contactInconnu: 'aucun_outil' | 'lecture_seule' | 'tous';
  status: 'draft' | 'active' | 'disabled';
}

/**
 * Une sortie déclarée sur la fiche de l'agent : sa règle d'arrêt. Le code est ce que l'outil `mba_terminer`
 * rend, et devient le handle `sortie:<code>` du bloc. Le builder les copie dans le bloc au moment du choix,
 * et la copie peut diverger : un code non câblé remonte la conversation en inbox avec une trace.
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
  /** Le modèle qui fait tourner cet agent. La liste en dérive le logo du fournisseur, sans relire la fiche. */
  modele: string;
}

export type StatutAgent = 'draft' | 'active' | 'disabled';

/** La fiche entière, telle que l'écran de réglage l'édite. `contenu` est la partie jsonb (ce que l'IA de
 *  construction peut écrire), le reste vit en colonnes et n'est écrit que par un administrateur. */
export interface AgentComplet {
  id: string;
  label: string;
  status: StatutAgent;
  mentionIa: string;
  /** Pas de `mentionIaFrequence` ici : le régime d'annonce appartient à l'espace (`TenantSettings`). */
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
   * La partie jsonb, déjà validée et partielle : seules les clés présentes sont écrites (fusion, pas
   * remplacement). Le formulaire enregistre champ par champ et l'IA de construction écrit aussi : un
   * remplacement effacerait ce qu'un autre onglet vient d'ajouter, et un `{}` viderait la fiche.
   */
  contenu?: Partial<FicheAgentContenu>;
  /**
   * Verrou optimiste sur la fiche : fourni, l'écriture n'a lieu que si la version en base est celle-là. La
   * fusion protège les clés que l'appelant ne touche pas, ce verrou celles qu'il touche.
   */
  ficheVersionAttendue?: number;
}

/** L'écriture a été refusée parce que la fiche a changé entre la lecture et l'enregistrement. */
export class FicheAgentPerimee extends Error {
  constructor() { super('la fiche a changé depuis son chargement'); this.name = 'FicheAgentPerimee'; }
}

/** Le libellé d'un agent est unique par workspace (index en base). */
export class LabelAgentDejaPris extends Error {
  constructor() { super('un agent porte déjà ce nom'); this.name = 'LabelAgentDejaPris'; }
}

export interface AgentStore {
  /**
   * Une fiche d'agent par son identifiant. 🔴 `null` si elle n'existe pas ou appartient à un autre tenant :
   * `node.data.agentId` vient du client, et le filtrage par tenant est le seul contrôle (RLS contournée).
   */
  byId(tenantId: string, id: string): Promise<FicheAgent | null>;

  /**
   * Les agents actifs d'un tenant, pour la palette du builder : un brouillon proposé dans un scénario
   * promettrait un envoi qui n'aurait pas lieu.
   */
  listActifs(tenantId: string): Promise<AgentResume[]>;

  /** Tous les agents d'un tenant, brouillons et désactivés compris : la liste de l'écran de réglage. */
  listToutes(tenantId: string): Promise<AgentResume[]>;

  /** La fiche entière d'un agent, pour l'éditer. `null` si elle n'existe pas ou appartient à un autre tenant. */
  complet(tenantId: string, id: string): Promise<AgentComplet | null>;

  /**
   * Crée un agent, en brouillon. Jamais actif d'emblée : un agent est prêt quand un humain l'a relu et le dit.
   */
  create(tenantId: string, label: string, mentionIa: string, modele: string): Promise<AgentComplet>;

  /** Supprime un agent. Rend `false` s'il n'existe pas ou appartient à un autre tenant. */
  remove(tenantId: string, id: string): Promise<boolean>;

  /**
   * Écrit un patch d'administrateur. Rend `null` si l'agent n'existe pas ou appartient à un autre tenant.
   * Lève `FicheAgentPerimee` si `ficheVersionAttendue` ne correspond plus, et `LabelAgentDejaPris` si le
   * libellé est déjà porté par un autre agent du workspace.
   */
  patch(tenantId: string, id: string, patch: PatchAgent): Promise<AgentComplet | null>;
}
