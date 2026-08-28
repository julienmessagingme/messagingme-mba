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

export interface AgentStore {
  /**
   * Une fiche d'agent par son identifiant. `null` si elle n'existe pas OU si elle appartient à un autre
   * tenant : `node.data.agentId` est opaque et fourni par le client, il peut donc pointer l'agent d'un autre.
   * Le filtrage par tenant est le SEUL contrôle (le pooler est superuser, la RLS est bypassée).
   */
  byId(tenantId: string, id: string): Promise<FicheAgent | null>;
}
