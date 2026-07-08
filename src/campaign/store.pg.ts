import type { Pool, PoolClient } from 'pg';
import type { Campaign, CampaignStatus, CampaignCategory, Recipient, QualityRating } from './types';
import type { CampaignStore, RecipientStore, FrequencyStore, QualityProvider } from './engine';
import type { BuildContact, BuiltRecipient } from './build';
import type { TemplateParam } from '../crm/template';
import type { DeliveryStore, DeliveryStatus } from '../webhooks/delivery';

export interface CreateCampaignInput {
  tenantId: string;
  phoneNumberId: string;
  name: string;
  category: CampaignCategory;
  templateName: string;
  templateLanguage: string;
  paramMapping: TemplateParam[];
  /** Restreint les destinataires à ces contacts. Absent/vide -> tous les contacts éligibles. */
  contactIds?: string[];
}

export interface RecipientCounts {
  total: number;
  pending: number;
  sending: number;
  sent: number;
  failed: number;
  skipped: number;
}
export interface CampaignSummary {
  id: string;
  name: string;
  category: CampaignCategory;
  status: CampaignStatus;
  phoneNumberId: string;
  templateName: string;
  templateLanguage: string;
  createdAt: string;
  counts: RecipientCounts;
}
export interface CampaignDetail extends CampaignSummary {
  recipients: Array<{
    id: string;
    toE164: string;
    status: string;
    messageId: string | null;
    error: string | null;
    sentAt: string | null;
    deliveryStatus: string | null;
    deliveryError: string | null;
  }>;
}
export interface PhoneNumberRow {
  id: string;
  displayPhoneNumber: string | null;
  verifiedName: string | null;
}

/** Lecture/écriture des campagnes et de leurs destinataires (assemblage). */
export class PgCampaignRepo {
  constructor(private readonly pool: Pool) {}

  async insertCampaign(input: CreateCampaignInput): Promise<string> {
    const res = await this.pool.query<{ id: string }>(
      `insert into campaigns
         (tenant_id, phone_number_id, name, category, template_name, template_language, param_mapping)
       values ($1, $2, $3, $4, $5, $6, $7::jsonb)
       returning id`,
      [
        input.tenantId,
        input.phoneNumberId,
        input.name,
        input.category,
        input.templateName,
        input.templateLanguage,
        JSON.stringify(input.paramMapping),
      ],
    );
    const id = res.rows[0]?.id;
    if (!id) throw new Error('insertCampaign : aucun id retourné');
    return id;
  }

  async getCampaign(id: string): Promise<Campaign | null> {
    const res = await this.pool.query<{
      id: string;
      tenant_id: string;
      phone_number_id: string;
      category: CampaignCategory;
      template_name: string;
      template_language: string;
      param_mapping: TemplateParam[];
      status: CampaignStatus;
    }>(
      `select id, tenant_id, phone_number_id, category, template_name, template_language,
              param_mapping, status
       from campaigns where id = $1`,
      [id],
    );
    const r = res.rows[0];
    if (!r) return null;
    return {
      id: r.id,
      tenantId: r.tenant_id,
      phoneNumberId: r.phone_number_id,
      category: r.category,
      templateName: r.template_name,
      templateLanguage: r.template_language,
      paramMapping: r.param_mapping,
      status: r.status,
    };
  }

  /** Le numéro appartient-il au tenant ? (garde-fou anti envoi depuis le numéro d'autrui.) */
  async phoneNumberBelongsToTenant(phoneNumberId: string, tenantId: string): Promise<boolean> {
    const res = await this.pool.query(
      `select 1 from phone_numbers where id = $1 and tenant_id = $2`,
      [phoneNumberId, tenantId],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /** La campagne appartient-elle au tenant ? (scope le run.) */
  async campaignBelongsTo(campaignId: string, tenantId: string): Promise<boolean> {
    const res = await this.pool.query(
      `select 1 from campaigns where id = $1 and tenant_id = $2`,
      [campaignId, tenantId],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /** Résumé des campagnes du tenant avec le décompte des destinataires par statut. */
  async listCampaignSummaries(tenantId: string): Promise<CampaignSummary[]> {
    const res = await this.pool.query<{
      id: string; name: string; category: CampaignCategory; status: CampaignStatus;
      phone_number_id: string; template_name: string; template_language: string; created_at: Date;
      total: string; pending: string; sending: string; sent: string; failed: string; skipped: string;
    }>(
      `select c.id, c.name, c.category, c.status, c.phone_number_id,
              c.template_name, c.template_language, c.created_at,
              count(r.id) as total,
              count(r.id) filter (where r.status = 'pending') as pending,
              count(r.id) filter (where r.status = 'sending') as sending,
              count(r.id) filter (where r.status = 'sent') as sent,
              count(r.id) filter (where r.status = 'failed') as failed,
              count(r.id) filter (where r.status = 'skipped') as skipped
       from campaigns c
       left join campaign_recipients r on r.campaign_id = c.id
       where c.tenant_id = $1
       group by c.id
       order by c.created_at desc`,
      [tenantId],
    );
    return res.rows.map((r) => this.toSummary(r));
  }

  /** Détail d'une campagne (scopée tenant) + ses destinataires. null si absente/autre tenant. */
  async getCampaignDetail(campaignId: string, tenantId: string): Promise<CampaignDetail | null> {
    const head = await this.pool.query<{
      id: string; name: string; category: CampaignCategory; status: CampaignStatus;
      phone_number_id: string; template_name: string; template_language: string; created_at: Date;
      total: string; pending: string; sending: string; sent: string; failed: string; skipped: string;
    }>(
      `select c.id, c.name, c.category, c.status, c.phone_number_id,
              c.template_name, c.template_language, c.created_at,
              count(r.id) as total,
              count(r.id) filter (where r.status = 'pending') as pending,
              count(r.id) filter (where r.status = 'sending') as sending,
              count(r.id) filter (where r.status = 'sent') as sent,
              count(r.id) filter (where r.status = 'failed') as failed,
              count(r.id) filter (where r.status = 'skipped') as skipped
       from campaigns c
       left join campaign_recipients r on r.campaign_id = c.id
       where c.id = $1 and c.tenant_id = $2
       group by c.id`,
      [campaignId, tenantId],
    );
    const h = head.rows[0];
    if (!h) return null;
    const recs = await this.pool.query<{
      id: string; to_e164: string; status: string; message_id: string | null; error: string | null;
      sent_at: Date | null; delivery_status: string | null; delivery_error: string | null;
    }>(
      `select id, to_e164, status, message_id, error, sent_at, delivery_status, delivery_error
       from campaign_recipients where campaign_id = $1 order by status, id limit 500`,
      [campaignId],
    );
    return {
      ...this.toSummary(h),
      recipients: recs.rows.map((r) => ({
        id: r.id,
        toE164: r.to_e164,
        status: r.status,
        messageId: r.message_id,
        error: r.error,
        sentAt: r.sent_at ? r.sent_at.toISOString() : null,
        deliveryStatus: r.delivery_status,
        deliveryError: r.delivery_error,
      })),
    };
  }

  /** WABA du tenant (pour les opérations de templates, qui sont au niveau WABA). null si aucun. */
  async getTenantWabaId(tenantId: string): Promise<string | null> {
    const res = await this.pool.query<{ id: string }>(
      `select id from waba where tenant_id = $1 order by created_at limit 1`,
      [tenantId],
    );
    return res.rows[0]?.id ?? null;
  }

  /** Numéro (phone_number_id) du tenant, pour répondre depuis l'inbox. null si aucun. */
  async getTenantPhoneNumberId(tenantId: string): Promise<string | null> {
    const res = await this.pool.query<{ id: string }>(
      `select id from phone_numbers where tenant_id = $1 order by created_at limit 1`,
      [tenantId],
    );
    return res.rows[0]?.id ?? null;
  }

  /** Numéros WhatsApp du tenant (pour choisir l'expéditeur d'une campagne). */
  async listPhoneNumbers(tenantId: string): Promise<PhoneNumberRow[]> {
    const res = await this.pool.query<{ id: string; display_phone_number: string | null; verified_name: string | null }>(
      `select id, display_phone_number, verified_name from phone_numbers where tenant_id = $1 order by created_at`,
      [tenantId],
    );
    return res.rows.map((r) => ({ id: r.id, displayPhoneNumber: r.display_phone_number, verifiedName: r.verified_name }));
  }

  private toSummary(r: {
    id: string; name: string; category: CampaignCategory; status: CampaignStatus;
    phone_number_id: string; template_name: string; template_language: string; created_at: Date;
    total: string; pending: string; sending: string; sent: string; failed: string; skipped: string;
  }): CampaignSummary {
    return {
      id: r.id,
      name: r.name,
      category: r.category,
      status: r.status,
      phoneNumberId: r.phone_number_id,
      templateName: r.template_name,
      templateLanguage: r.template_language,
      createdAt: r.created_at.toISOString(),
      counts: {
        total: Number(r.total),
        pending: Number(r.pending),
        sending: Number(r.sending),
        sent: Number(r.sent),
        failed: Number(r.failed),
        skipped: Number(r.skipped),
      },
    };
  }

  /** Contacts du tenant prêts pour buildRecipients (id, phone, name, fields, opt-in). */
  async listContactsForBuild(tenantId: string): Promise<BuildContact[]> {
    const res = await this.pool.query<{
      id: string;
      phone_e164: string | null;
      profile_name: string | null;
      fields: Record<string, unknown>;
      opt_in_status: 'opted_in' | 'opted_out' | 'unknown';
    }>(
      `select id, phone_e164, profile_name, fields, opt_in_status
       from contacts where tenant_id = $1`,
      [tenantId],
    );
    return res.rows.map((r) => ({
      id: r.id,
      phone_e164: r.phone_e164,
      profile_name: r.profile_name,
      fields: r.fields,
      optInStatus: r.opt_in_status,
    }));
  }

  /**
   * Crée la campagne ET ses destinataires dans UNE transaction : un échec en cours de route
   * ne laisse pas de campagne draft orpheline avec des destinataires partiels.
   */
  async createWithRecipients(
    input: CreateCampaignInput,
    recipients: BuiltRecipient[],
  ): Promise<{ campaignId: string; recipientCount: number }> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const cRes = await client.query<{ id: string }>(
        `insert into campaigns
           (tenant_id, phone_number_id, name, category, template_name, template_language, param_mapping)
         values ($1, $2, $3, $4, $5, $6, $7::jsonb)
         returning id`,
        [
          input.tenantId, input.phoneNumberId, input.name, input.category,
          input.templateName, input.templateLanguage, JSON.stringify(input.paramMapping),
        ],
      );
      const campaignId = cRes.rows[0]?.id;
      if (!campaignId) throw new Error('createWithRecipients : aucun id retourné');
      const inserted = await bulkInsertRecipients(client, campaignId, recipients);
      await client.query('commit');
      return { campaignId, recipientCount: inserted };
    } catch (err) {
      await client.query('rollback');
      throw err;
    } finally {
      client.release();
    }
  }

  /** Insère les destinataires (idempotent par (campaign_id, contact_id)). Retourne le nb inséré. */
  async insertRecipients(campaignId: string, recipients: BuiltRecipient[]): Promise<number> {
    return bulkInsertRecipients(this.pool, campaignId, recipients);
  }
}

/**
 * Insert bulk des destinataires en UNE requête (`unnest`) au lieu de N allers-retours.
 * Idempotent par (campaign_id, contact_id) ; retourne le nombre réellement inséré. Fonctionne
 * avec un client transactionnel (createWithRecipients) comme avec le pool.
 */
async function bulkInsertRecipients(
  q: Pool | PoolClient,
  campaignId: string,
  recipients: BuiltRecipient[],
): Promise<number> {
  if (recipients.length === 0) return 0;
  const contactIds = recipients.map((r) => r.contactId);
  const toE164s = recipients.map((r) => r.toE164);
  const params = recipients.map((r) => JSON.stringify(r.resolvedParams));
  const res = await q.query(
    `insert into campaign_recipients (campaign_id, contact_id, to_e164, resolved_params)
     select $1, c, t, p::jsonb
     from unnest($2::uuid[], $3::text[], $4::text[]) as u(c, t, p)
     on conflict (campaign_id, contact_id) do nothing`,
    [campaignId, contactIds, toE164s, params],
  );
  return res.rowCount ?? 0;
}

export class PgCampaignStore implements CampaignStore {
  constructor(private readonly pool: Pool) {}
  async setStatus(campaignId: string, status: CampaignStatus): Promise<void> {
    await this.pool.query(`update campaigns set status = $2 where id = $1`, [campaignId, status]);
  }
}

export class PgRecipientStore implements RecipientStore, DeliveryStore {
  constructor(private readonly pool: Pool) {}

  /**
   * Applique un statut de livraison Meta (par message_id), en MONOTONE : sent -> delivered
   * -> read ne régresse jamais (un `delivered` tardif n'écrase pas un `read`). `failed`
   * s'applique toujours. Retourne le nb de lignes touchées (0 si le wamid n'est pas à nous).
   */
  async updateDeliveryByMessageId(messageId: string, status: DeliveryStatus, error: string | null): Promise<number> {
    const res = await this.pool.query(
      `update campaign_recipients
       set delivery_status = $2, delivery_error = $3, delivery_updated_at = now()
       where message_id = $1 and (
         $2 = 'failed'
         or (case $2 when 'read' then 3 when 'delivered' then 2 when 'sent' then 1 else 0 end)
            > (case delivery_status when 'read' then 3 when 'delivered' then 2 when 'sent' then 1 else 0 end)
       )`,
      [messageId, status, error],
    );
    return res.rowCount ?? 0;
  }

  async listPending(campaignId: string): Promise<Recipient[]> {
    const res = await this.pool.query<{
      id: string;
      contact_id: string;
      to_e164: string;
      resolved_params: string[];
      status: Recipient['status'];
    }>(
      `select id, contact_id, to_e164, resolved_params, status
       from campaign_recipients
       where campaign_id = $1 and status = 'pending'
       order by id`,
      [campaignId],
    );
    return res.rows.map((r) => ({
      id: r.id,
      contactId: r.contact_id,
      toE164: r.to_e164,
      resolvedParams: r.resolved_params,
      status: r.status,
    }));
  }

  /** Claim atomique pending -> sending (rowCount=1 si CE run réserve, 0 si déjà pris). */
  async claim(id: string): Promise<boolean> {
    const res = await this.pool.query(
      `update campaign_recipients set status = 'sending', claimed_at = now()
       where id = $1 and status = 'pending'`,
      [id],
    );
    return (res.rowCount ?? 0) === 1;
  }

  /**
   * Sweeper : ramène à `pending` les destinataires bloqués en `sending` depuis plus de
   * `olderThanMs` (crash entre le claim et l'envoi). Retourne le nb récupéré.
   * NB : si l'envoi avait réussi mais que la persistance `sent` avait échoué, ce reclaim
   * peut re-envoyer (rare) ; c'est le compromis assumé face à un destinataire figé à vie.
   */
  async reclaimStale(olderThanMs: number): Promise<number> {
    const res = await this.pool.query(
      `update campaign_recipients set status = 'pending', claimed_at = null
       where status = 'sending' and claimed_at is not null
         and claimed_at < now() - ($1::double precision * interval '1 millisecond')`,
      [olderThanMs],
    );
    return res.rowCount ?? 0;
  }

  async markResult(
    id: string,
    r: { status: 'sent' | 'failed' | 'skipped'; messageId?: string; error?: string; sentAt?: number },
  ): Promise<void> {
    // Invariant sent_at <-> status='sent' : hors 'sent', sent_at est remis à null.
    await this.pool.query(
      `update campaign_recipients
       set status = $2,
           message_id = $3,
           error = $4,
           sent_at = case
             when $2 = 'sent' and $5::double precision is not null
               then to_timestamp($5::double precision / 1000.0)
             when $2 = 'sent' then sent_at
             else null
           end
       where id = $1`,
      [id, r.status, r.messageId ?? null, r.error ?? null, r.sentAt ?? null],
    );
  }
}

/**
 * Fréquence cross-campagne SANS table dédiée : la source est le `sent_at` déjà écrit
 * par PgRecipientStore.markResult. `record` est donc un no-op.
 */
export class PgFrequencyStore implements FrequencyStore {
  constructor(private readonly pool: Pool) {}

  async lastSentAt(tenantId: string, toE164: string): Promise<number | null> {
    // Seuls les envois MARKETING comptent pour la fréquence : un utility récent ne doit
    // pas bloquer un marketing, et le moteur n'applique de toute façon la fréquence qu'au
    // marketing (cohérence de la sémantique de catégorie).
    const res = await this.pool.query<{ ms: string | null }>(
      `select (extract(epoch from max(r.sent_at)) * 1000)::bigint as ms
       from campaign_recipients r
       join campaigns c on c.id = r.campaign_id
       where c.tenant_id = $1 and r.to_e164 = $2 and r.status = 'sent'
         and c.category = 'marketing'`,
      [tenantId, toE164],
    );
    const ms = res.rows[0]?.ms;
    return ms == null ? null : Number(ms);
  }

  async record(): Promise<void> {
    // no-op : sent_at est persisté par markResult ; lastSentAt lit cette source unique.
  }
}

export class PgQualityProvider implements QualityProvider {
  constructor(private readonly pool: Pool) {}
  async getRating(phoneNumberId: string): Promise<QualityRating> {
    const res = await this.pool.query<{ quality_rating: QualityRating }>(
      `select quality_rating from phone_numbers where id = $1`,
      [phoneNumberId],
    );
    return res.rows[0]?.quality_rating ?? 'UNKNOWN';
  }
}
