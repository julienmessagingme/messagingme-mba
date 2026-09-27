import type { Pool } from 'pg';
import type { RcsOptoutStore } from './sender';

/**
 * Agents RCS d'un tenant (`rcs_agents`). 🔴 Ce mapping porte l'isolation multi-tenant du canal : le
 * partenaire RBM est global (une seule clé de service account), rien d'autre n'empêche un tenant d'envoyer
 * sous la marque d'un autre. Toute résolution d'agent passe par ici, scopée tenant.
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

  /**
   * Clé d'API du canal RCS de ce tenant, déchiffrée. null = pas de clé propre : l'appelant retombe sur celle
   * du serveur. Le déchiffrement est injecté : ce store ne connaît pas la clé maîtresse.
   */
  async apiKeyFor(tenantId: string, decrypt: (enc: string) => string): Promise<string | null> {
    const res = await this.pool.query<{ api_key_enc: string | null }>(
      'select api_key_enc from rcs_agents where tenant_id = $1 and api_key_enc is not null order by created_at asc limit 1',
      [tenantId],
    );
    const enc = res.rows[0]?.api_key_enc;
    if (!enc) return null;
    try {
      return decrypt(enc);
    } catch {
      // Clé illisible (clé maîtresse changée, valeur corrompue) : on ne fait pas semblant d'avoir une clé ;
      // l'appelant retombe sur celle du serveur, et l'écran d'activation invite à la ressaisir.
      return null;
    }
  }

  /**
   * Code d'URL des rappels smsmode de ce tenant (DLR + MO). null = pas d'agent, donc aucune adresse à donner
   * au fournisseur. Lu à chaque envoi, comme la clé : une réactivation change le code, et un message parti
   * après doit porter la nouvelle adresse.
   */
  async webhookCodePour(tenantId: string): Promise<string | null> {
    const res = await this.pool.query<{ webhook_code: string }>(
      'select webhook_code from rcs_agents where tenant_id = $1 order by created_at asc limit 1',
      [tenantId],
    );
    return res.rows[0]?.webhook_code ?? null;
  }

  /**
   * Workspace et agent portés par un code d'URL de rappel. 🔴 C'est la clé d'autorisation du webhook smsmode :
   * le tenant vient du code, jamais du corps de la requête (qu'un tiers peut forger). L'`agent_id` rendu sert
   * à la deuxième garde : le canal annoncé dans le corps doit être celui-là.
   */
  async parWebhookCode(code: string): Promise<{ tenantId: string; agentId: string } | null> {
    const res = await this.pool.query<{ tenant_id: string; agent_id: string }>(
      'select tenant_id, agent_id from rcs_agents where webhook_code = $1',
      [code],
    );
    const r = res.rows[0];
    return r ? { tenantId: r.tenant_id, agentId: r.agent_id } : null;
  }

  /** Le tenant a-t-il au moins un agent RCS ? C'est ce test qui allume ou éteint le canal dans l'interface :
   *  pas de drapeau à basculer à la main, l'outil suit l'état réel du dépôt d'agent. */
  async hasAgent(tenantId: string): Promise<boolean> {
    const res = await this.pool.query('select 1 from rcs_agents where tenant_id = $1 limit 1', [tenantId]);
    return (res.rowCount ?? 0) > 0;
  }

  /** État du canal RCS d'un workspace, pour l'écran d'activation. Jamais la clé, seulement ce qu'elle ouvre. */
  async etatPour(tenantId: string): Promise<{
    agentId: string; brandName: string; displayName: string | null; status: string; checkedAt: string | null;
  } | null> {
    const res = await this.pool.query<{
      agent_id: string; brand_name: string; display_name: string | null; status: string; checked_at: Date | null;
    }>(
      'select agent_id, brand_name, display_name, status, checked_at from rcs_agents where tenant_id = $1 order by created_at asc limit 1',
      [tenantId],
    );
    const r = res.rows[0];
    return r ? {
      agentId: r.agent_id,
      brandName: r.brand_name,
      displayName: r.display_name,
      status: r.status,
      checkedAt: r.checked_at ? r.checked_at.toISOString() : null,
    } : null;
  }

  /** Active (ou réactive) le canal RCS d'un workspace avec une clé déjà vérifiée et chiffrée. */
  async activer(
    tenantId: string,
    canal: { channelId: string; agentName: string },
    apiKeyEnc: string,
    clientTokenEnc: string,
    webhookCode: string,
  ): Promise<void> {
    await this.pool.query(
      `insert into rcs_agents (tenant_id, agent_id, brand_name, webhook_code, client_token_enc, api_key_enc, display_name, region, status, checked_at)
       values ($1,$2,$3,$4,$5,$6,$7,'europe','testing', now())
       on conflict (tenant_id, agent_id) do update
         set api_key_enc = excluded.api_key_enc, display_name = excluded.display_name, brand_name = excluded.brand_name, checked_at = now()`,
      [tenantId, canal.channelId, canal.agentName || 'Agent RCS', webhookCode, clientTokenEnc, apiKeyEnc, canal.agentName],
    );
  }

  /** Désactive le canal : la ligne est supprimée, donc `hasAgent` redevient faux et l'interface s'éteint. */
  async desactiver(tenantId: string): Promise<boolean> {
    const res = await this.pool.query('delete from rcs_agents where tenant_id = $1', [tenantId]);
    return (res.rowCount ?? 0) > 0;
  }

  /**
   * Garde le dernier rappel reçu du fournisseur, tel quel, écrit avant toute lecture et en best-effort : sans
   * lui, un rappel rejeté par notre parseur ne laisse aucune trace de ce que smsmode a envoyé. Un seul corps
   * conservé, écrasé au suivant : c'est de la donnée tierce, potentiellement personnelle.
   */
  async noterRappel(tenantId: string, corps: unknown): Promise<void> {
    await this.pool.query(
      'update rcs_agents set last_callback = $2::jsonb, last_callback_at = now() where tenant_id = $1',
      [tenantId, JSON.stringify(corps ?? null)],
    );
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
 * Opt-out RCS d'un contact (`contacts.rcs_optout_at`). 🔴 Le numéro arrive en chiffres nus ou avec `+` selon
 * le chemin : on tente les deux formes, car un opt-out qu'on ne retrouve pas, c'est un STOP non respecté.
 */
export class PgRcsOptoutStore implements RcsOptoutStore {
  constructor(private readonly pool: Pool) {}

  async isOptedOut(tenantId: string, e164: string): Promise<boolean> {
    // Comparaisons exactes sur la colonne, jamais une fonction dessus : `regexp_replace(phone_e164, …)` rendrait
    // inutilisable l'index unique (tenant_id, phone_e164), donc un balayage des contacts par destinataire. La
    // liste de deux valeurs couvre les deux formes et garde l'index.
    const nu = e164.replace(/[^0-9]/g, '');
    const res = await this.pool.query(
      `select 1 from contacts
       where tenant_id = $1 and rcs_optout_at is not null and phone_e164 in ($2, $3)
       limit 1`,
      [tenantId, `+${nu}`, nu],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /**
   * Enregistre un STOP reçu en RCS. Idempotent : `rcs_optout_at is null` garde la date du premier refus, celle
   * que l'opérateur ou la CNIL demanderait. Ne crée pas le contact : un numéro jamais enregistré ne reçoit pas
   * nos campagnes, et `false` le dit à l'appelant plutôt que de fabriquer une fiche vide.
   */
  async markOptedOut(tenantId: string, e164: string): Promise<boolean> {
    const nu = e164.replace(/[^0-9]/g, '');
    const res = await this.pool.query(
      `update contacts set rcs_optout_at = now()
       where tenant_id = $1 and phone_e164 in ($2, $3) and rcs_optout_at is null`,
      [tenantId, `+${nu}`, nu],
    );
    return (res.rowCount ?? 0) > 0;
  }
}
