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
export interface FicheAgent {
  id: string;
  tenantId: string;
  /** Phrase annonçant que l'interlocuteur parle à une IA. Obligation légale (AI Act, article 50). */
  mentionIa: string;
  modele: string;
  plafonds: PlafondsAgent;
  /** Minutes d'inactivité avant que le parcours reprenne la main. */
  inactiviteMinutes: number;
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
  sorties: SortieAgent[];
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
}
