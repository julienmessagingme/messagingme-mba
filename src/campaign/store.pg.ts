import type { Pool } from 'pg';
import type { Campaign, CampaignStatus, CampaignCategory, Recipient, QualityRating } from './types';
import type { CampaignStore, RecipientStore, FrequencyStore, QualityProvider } from './engine';
import type { BuildContact, BuiltRecipient } from './build';
import type { TemplateParam } from '../crm/template';

export interface CreateCampaignInput {
  tenantId: string;
  phoneNumberId: string;
  name: string;
  category: CampaignCategory;
  templateName: string;
  templateLanguage: string;
  paramMapping: TemplateParam[];
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

  /** Insère les destinataires (idempotent par (campaign_id, contact_id)). Retourne le nb inséré. */
  async insertRecipients(campaignId: string, recipients: BuiltRecipient[]): Promise<number> {
    let inserted = 0;
    for (const rcp of recipients) {
      const res = await this.pool.query(
        `insert into campaign_recipients (campaign_id, contact_id, to_e164, resolved_params)
         values ($1, $2, $3, $4::jsonb)
         on conflict (campaign_id, contact_id) do nothing`,
        [campaignId, rcp.contactId, rcp.toE164, JSON.stringify(rcp.resolvedParams)],
      );
      inserted += res.rowCount ?? 0;
    }
    return inserted;
  }
}

export class PgCampaignStore implements CampaignStore {
  constructor(private readonly pool: Pool) {}
  async setStatus(campaignId: string, status: CampaignStatus): Promise<void> {
    await this.pool.query(`update campaigns set status = $2 where id = $1`, [campaignId, status]);
  }
}

export class PgRecipientStore implements RecipientStore {
  constructor(private readonly pool: Pool) {}

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
      `update campaign_recipients set status = 'sending'
       where id = $1 and status = 'pending'`,
      [id],
    );
    return (res.rowCount ?? 0) === 1;
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
