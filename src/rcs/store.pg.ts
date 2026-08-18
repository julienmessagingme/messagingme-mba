import type { Pool } from 'pg';
import type { RcsOptoutStore } from './sender';

/**
 * Agents RCS d'un tenant (table `rcs_agents`, migration 0057).
 *
 * C'est ce mapping qui porte l'isolation multi-tenant du canal : le partenaire RBM est GLOBAL (MessagingMe,
 * une seule clé de service account), donc rien d'autre n'empêche un tenant d'envoyer sous la marque d'un
 * autre. Toute résolution d'agent passe par ici, scopée tenant, sans exception.
 */
export class PgRcsAgentStore {
  constructor(private readonly pool: Pool) {}

  /** Agent RCS du tenant. null = aucun agent configuré. Le plus ancien d'abord (un seul agent par tenant
   *  aujourd'hui ; l'ordre rend le choix déterministe le jour où il y en aura plusieurs). */
  async agentIdForTenant(tenantId: string): Promise<string | null> {
    const res = await this.pool.query<{ agent_id: string }>(
      'select agent_id from rcs_agents where tenant_id = $1 order by created_at asc limit 1',
      [tenantId],
    );
    return res.rows[0]?.agent_id ?? null;
  }

  /** Agents du tenant, pour le sélecteur de l'assistant de campagne. Scopé tenant, comme tout le reste ici. */
  async listForTenant(tenantId: string): Promise<Array<{ agentId: string; brandName: string; status: string }>> {
    const res = await this.pool.query<{ agent_id: string; brand_name: string; status: string }>(
      'select agent_id, brand_name, status from rcs_agents where tenant_id = $1 order by created_at asc',
      [tenantId],
    );
    return res.rows.map((r) => ({ agentId: r.agent_id, brandName: r.brand_name, status: r.status }));
  }

  /** Le tenant a-t-il au moins un agent RCS ? C'est CE test qui allume ou éteint le canal dans l'interface :
   *  pas de drapeau à basculer à la main, l'outil suit l'état réel du dépôt d'agent. */
  async hasAgent(tenantId: string): Promise<boolean> {
    const res = await this.pool.query('select 1 from rcs_agents where tenant_id = $1 limit 1', [tenantId]);
    return (res.rowCount ?? 0) > 0;
  }

  /** L'agent appartient-il au tenant ? Garde d'isolation de la création de campagne, symétrique de
   *  `phoneNumberBelongsToTenant`. */
  async belongsToTenant(agentId: string, tenantId: string): Promise<boolean> {
    const res = await this.pool.query(
      'select 1 from rcs_agents where agent_id = $1 and tenant_id = $2',
      [agentId, tenantId],
    );
    return (res.rowCount ?? 0) > 0;
  }
}

/**
 * Opt-out RCS d'un contact (`contacts.rcs_optout_at`, migration 0057).
 *
 * `wa_id` est un E.164 en chiffres nus OU avec `+` selon le chemin d'appel : on tente les deux formes, comme
 * la réconciliation de l'inbox. Un opt-out qu'on ne retrouve pas parce que le numéro est formaté autrement,
 * c'est un STOP non respecté.
 */
export class PgRcsOptoutStore implements RcsOptoutStore {
  constructor(private readonly pool: Pool) {}

  async isOptedOut(tenantId: string, e164: string): Promise<boolean> {
    // Comparaisons EXACTES sur la colonne, jamais une fonction dessus : `regexp_replace(phone_e164, …)`
    // rendait inutilisable l'index unique (tenant_id, phone_e164) de 0001, donc un balayage complet des
    // contacts du tenant PAR DESTINATAIRE. Sur une campagne de 5 000 numéros, 5 000 balayages.
    // Les deux formes de stockage sont couvertes par une liste de valeurs, ce qui garde l'index.
    const nu = e164.replace(/[^0-9]/g, '');
    const res = await this.pool.query(
      `select 1 from contacts
       where tenant_id = $1 and rcs_optout_at is not null and phone_e164 in ($2, $3)
       limit 1`,
      [tenantId, `+${nu}`, nu],
    );
    return (res.rowCount ?? 0) > 0;
  }
}
