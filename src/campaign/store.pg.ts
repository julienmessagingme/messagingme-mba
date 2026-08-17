import type { Pool, PoolClient } from 'pg';
import type { Campaign, CampaignStatus, CampaignCategory, Recipient, QualityRating } from './types';
import type { CampaignStore, RecipientStore, FrequencyStore, QualityProvider } from './engine';
import type { BuildContact, BuiltRecipient } from './build';
import { resolveTemplateParams, type TemplateParam } from '../crm/template';
import type { DeliveryStore, DeliveryStatus } from '../webhooks/delivery';

export interface CreateCampaignInput {
  tenantId: string;
  /** '' pour une campagne RCS : il n'y a pas de numéro Meta (colonne nullable depuis la migration 0056). */
  phoneNumberId: string;
  name: string;
  category: CampaignCategory;
  /** '' pour une campagne workflow (pas de template propre). */
  templateName: string;
  templateLanguage: string;
  paramMapping: TemplateParam[];
  /** Restreint les destinataires à ces contacts. Absent/vide -> tous les contacts éligibles. */
  contactIds?: string[];
  /** Campagne workflow : démarre ce workflow par destinataire au lieu d'envoyer un template. */
  workflowId?: string;
  /** Cible NODE (/v1/sends) : démarre le workflow à CE bloc au lieu de son entrée. Requiert `workflowId`. */
  startNodeId?: string;
  /** Débit max en messages/minute (1..80). Absent/null = aucun throttle. */
  ratePerMinute?: number | null;
  /** Canal d'envoi. Absent = 'whatsapp' (comportement historique). */
  channel?: 'whatsapp' | 'rcs';
  /** Agent RCS (`rcs_agents.agent_id`). Requis si `channel = 'rcs'`. */
  rcsAgentId?: string;
  /** Message RCS, validé par zod à la création. Requis si `channel = 'rcs'`. */
  rcsMessage?: unknown;
}

/** Ligne SQL d'un résumé de campagne (liste + détail : même projection). */
export interface CampaignSummaryRow {
  id: string; name: string; category: CampaignCategory; status: CampaignStatus;
  phone_number_id: string; template_name: string | null; template_language: string | null;
  workflow_name?: string | null;
  created_at: Date; scheduled_at?: Date | null; archived_at?: Date | null;
  total: string; pending: string; sending: string; sent: string; failed: string; skipped: string;
}

/**
 * Ligne SQL -> CampaignSummary. Fonction PURE (testable sans base). Ne COERCE PAS un null en chaîne vide :
 * une campagne scénario n'a pas de template, et le dire est le seul moyen d'empêcher le retour du « template () ».
 */
export function rowToSummary(r: CampaignSummaryRow): CampaignSummary {
  return {
    id: r.id,
    name: r.name,
    category: r.category,
    status: r.status,
    phoneNumberId: r.phone_number_id,
    templateName: r.template_name,
    templateLanguage: r.template_language,
    workflowName: r.workflow_name ?? null,
    createdAt: r.created_at.toISOString(),
    scheduledAt: r.scheduled_at ? r.scheduled_at.toISOString() : null,
    archivedAt: r.archived_at ? r.archived_at.toISOString() : null,
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
  /** null pour une campagne SCÉNARIO (c'est le scénario qui envoie, la campagne ne porte pas de template).
   *  Nullable À DESSEIN : le `?? ''` d'avant transformait cette absence en valeur vide, que l'écran rendait
   *  en « template () ». Le type oblige désormais chaque appelant à traiter le cas. */
  templateName: string | null;
  templateLanguage: string | null;
  /** Nom du scénario d'une campagne scénario. null = campagne template, ou scénario supprimé depuis. */
  workflowName: string | null;
  createdAt: string;
  /** Instant de lancement programmé (ISO UTC) quand status = 'scheduled'. null sinon. */
  scheduledAt: string | null;
  /** Instant d'archivage (ISO UTC). null = campagne active. ORTHOGONAL au statut : une campagne archivée
   *  garde son statut d'origine (completed, failed...) et ses destinataires, qui portent l'historique. */
  archivedAt: string | null;
  counts: RecipientCounts;
}
export interface CampaignDetail extends CampaignSummary {
  /** Mapping des variables du template (positions -> source). Sert au front F7 (savoir quel champ corriger). */
  paramMapping: TemplateParam[];
  recipients: Array<{
    id: string;
    contactId: string;
    toE164: string;
    status: string;
    messageId: string | null;
    error: string | null;
    /** Code d'erreur Meta numérique (null hors échec). Pilote le bouton « Corriger + renvoyer » (F7, famille variables). */
    errorCode: number | null;
    sentAt: string | null;
    deliveryStatus: string | null;
    deliveryError: string | null;
  }>;
}

/** Codes d'erreur Meta « variable de template » (F7) : renvoyables après correction de la donnée du contact. */
export const RETRYABLE_TEMPLATE_VAR_CODES = new Set([131009, 132012, 132000]);

/** Destinataire candidat à une auto-relance (F6). */
export interface AutoRetryRecipient { id: string; campaignId: string; tenantId: string; toE164: string; }

/** Résultat d'une tentative de renvoi (F7). Discriminé pour que la route mappe proprement 404/409/422/202. */
export type RetryReset =
  | { result: 'queued'; campaignId: string }
  | { result: 'not_found' }
  | { result: 'not_retryable' }
  | { result: 'missing_var'; missing: number[] }
  | { result: 'conflict' };
export interface PhoneNumberRow {
  id: string;
  displayPhoneNumber: string | null;
  verifiedName: string | null;
}

/** Lecture/écriture des campagnes et de leurs destinataires (assemblage). */
export class PgCampaignRepo {
  constructor(private readonly pool: Pool) {}

  async insertCampaign(input: CreateCampaignInput): Promise<string> {
    // Campagne workflow : pas de template propre -> template_name/language null.
    const isWorkflow = !!input.workflowId;
    const res = await this.pool.query<{ id: string }>(
      `insert into campaigns
         (tenant_id, phone_number_id, name, category, template_name, template_language, param_mapping, workflow_id, rate_per_minute, start_node_id, channel, rcs_agent_id, rcs_message)
       values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12, $13::jsonb)
       returning id`,
      [
        input.tenantId,
        // Campagne RCS : aucun numéro Meta. La colonne est nullable depuis 0056, on y met null plutôt que ''.
        input.phoneNumberId === '' ? null : input.phoneNumberId,
        input.name,
        input.category,
        isWorkflow ? null : input.templateName,
        isWorkflow ? null : input.templateLanguage,
        JSON.stringify(input.paramMapping),
        input.workflowId ?? null,
        input.ratePerMinute ?? null,
        // start_node_id n'a de sens qu'avec un workflow : sans lui, on force null (pas de campagne bâtarde).
        isWorkflow ? input.startNodeId ?? null : null,
        input.channel ?? 'whatsapp',
        input.rcsAgentId ?? null,
        input.rcsMessage === undefined ? null : JSON.stringify(input.rcsMessage),
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
      template_name: string | null;
      template_language: string | null;
      param_mapping: TemplateParam[];
      status: CampaignStatus;
      workflow_id: string | null;
      rate_per_minute: number | null;
      start_node_id: string | null;
    }>(
      `select id, tenant_id, phone_number_id, category, template_name, template_language,
              param_mapping, status, workflow_id, rate_per_minute, start_node_id
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
      templateName: r.template_name ?? '',
      templateLanguage: r.template_language ?? '',
      paramMapping: r.param_mapping,
      status: r.status,
      workflowId: r.workflow_id,
      ratePerMinute: r.rate_per_minute,
      startNodeId: r.start_node_id,
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

  /** Débit choisi + nb de destinataires EN ATTENTE : dimensionne le timeout du job de run (pacing.ts). */
  async getRunSizing(campaignId: string): Promise<{ ratePerMinute: number | null; pendingCount: number } | null> {
    const res = await this.pool.query<{ rate_per_minute: number | null; pending: string }>(
      `select c.rate_per_minute,
              (select count(*) from campaign_recipients r where r.campaign_id = c.id and r.status = 'pending')::text as pending
       from campaigns c where c.id = $1`,
      [campaignId],
    );
    const r = res.rows[0];
    return r ? { ratePerMinute: r.rate_per_minute, pendingCount: Number(r.pending) } : null;
  }

  /** Programme une campagne pour un lancement futur (scopé tenant). Seul un brouillon ou une campagne en pause
   *  se programme (pas une déjà en cours/terminée). `scheduledAt` = instant absolu UTC. true si programmée. */
  async scheduleCampaign(campaignId: string, tenantId: string, scheduledAt: Date): Promise<boolean> {
    const res = await this.pool.query(
      `update campaigns set status = 'scheduled', scheduled_at = $3
       where id = $1 and tenant_id = $2 and status in ('draft', 'paused')`,
      [campaignId, tenantId, scheduledAt.toISOString()],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /** Annule une programmation (scopé tenant) : la campagne repasse en brouillon. true si annulée. */
  async cancelSchedule(campaignId: string, tenantId: string): Promise<boolean> {
    const res = await this.pool.query(
      `update campaigns set status = 'draft', scheduled_at = null
       where id = $1 and tenant_id = $2 and status = 'scheduled'`,
      [campaignId, tenantId],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /** Campagnes programmées DUES (scheduled_at <= maintenant) + leur dimensionnement de run. Le sweeper les
   *  enfile puis les passe en 'running'. Cross-tenant (le sweeper tourne pour tous). */
  async listDueScheduled(now: Date = new Date()): Promise<Array<{ id: string; ratePerMinute: number | null; pendingCount: number }>> {
    const res = await this.pool.query<{ id: string; rate_per_minute: number | null; pending: string }>(
      `select c.id, c.rate_per_minute,
              (select count(*) from campaign_recipients r where r.campaign_id = c.id and r.status = 'pending')::text as pending
       from campaigns c
       where c.status = 'scheduled' and c.scheduled_at <= $1`,
      [now.toISOString()],
    );
    return res.rows.map((r) => ({ id: r.id, ratePerMinute: r.rate_per_minute, pendingCount: Number(r.pending) }));
  }

  /** Passe une campagne programmée en 'running' (claim du sweeper, garde `status='scheduled'` anti-double).
   *  true si claimée par CET appel (une seule fois même avec plusieurs sweepers). */
  async markScheduledRunning(campaignId: string): Promise<boolean> {
    const res = await this.pool.query(
      `update campaigns set status = 'running', scheduled_at = null where id = $1 and status = 'scheduled'`,
      [campaignId],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /**
   * Campagnes ACTIVES (draft/running/paused) référençant un template (par nom ; langue optionnelle).
   * Garde-fou D1 : éditer/supprimer un template utilisé par une de ces campagnes casserait des envois
   * (un draft a déjà ses recipients construits ; un running/paused est relançable via POST /run ; un edit
   * repasse le template en PENDING donc en 422 par destinataire). completed/failed = terminaux -> exclus.
   * Langue omise = toutes langues (cas de la suppression par nom, qui efface toutes les langues chez Meta).
   */
  async listActiveCampaignsForTemplate(
    tenantId: string,
    templateName: string,
    templateLanguage?: string,
  ): Promise<Array<{ id: string; name: string; status: CampaignStatus; templateLanguage: string }>> {
    const res = await this.pool.query<{ id: string; name: string; status: CampaignStatus; template_language: string }>(
      `select id, name, status, template_language
       from campaigns
       where tenant_id = $1 and template_name = $2
         and ($3::text is null or template_language = $3)
         and status in ('draft', 'running', 'paused', 'scheduled')
       order by created_at desc`,
      [tenantId, templateName, templateLanguage ?? null],
    );
    return res.rows.map((r) => ({ id: r.id, name: r.name, status: r.status, templateLanguage: r.template_language }));
  }

  /**
   * Résumé des campagnes du tenant avec le décompte des destinataires par statut.
   * Par défaut, seules les campagnes ACTIVES : `opts.archived = true` renvoie exclusivement les archivées
   * (les deux ensembles sont disjoints, jamais réunis, sinon la liste mélangerait actif et corbeille).
   */
  async listCampaignSummaries(tenantId: string, opts?: { archived?: boolean }): Promise<CampaignSummary[]> {
    // Prédicat choisi sur un BOOLÉEN interne, jamais sur une valeur d'entrée : pas d'interpolation de donnée
    // utilisateur. Écrit en littéral (et non `(archived_at is not null) = $2`) pour que la branche par défaut
    // touche l'index partiel `campaigns_active_idx ... where archived_at is null` de la migration 0038.
    const archivedFilter = opts?.archived ? 'c.archived_at is not null' : 'c.archived_at is null';
    const res = await this.pool.query<CampaignSummaryRow>(
      // Nom du scénario en SOUS-REQUÊTE SCALAIRE, pas en jointure : la requête agrège avec `group by c.id`, et
      // Postgres refuserait `w.name` d'une table jointe (« must appear in the GROUP BY clause »). Au pire une
      // lecture par clé primaire et par campagne.
      `select c.id, c.name, c.category, c.status, c.phone_number_id,
              c.template_name, c.template_language, c.created_at, c.scheduled_at, c.archived_at,
              (select w.name from workflows w where w.id = c.workflow_id and w.tenant_id = c.tenant_id) as workflow_name,
              count(r.id) as total,
              count(r.id) filter (where r.status = 'pending') as pending,
              count(r.id) filter (where r.status = 'sending') as sending,
              count(r.id) filter (where r.status = 'sent' and r.delivery_status is distinct from 'failed') as sent,
              count(r.id) filter (where r.status = 'failed' or r.delivery_status = 'failed') as failed,
              count(r.id) filter (where r.status = 'skipped') as skipped
       from campaigns c
       left join campaign_recipients r on r.campaign_id = c.id
       where c.tenant_id = $1 and ${archivedFilter}
       group by c.id
       order by c.created_at desc`,
      [tenantId],
    );
    return res.rows.map((r) => rowToSummary(r));
  }

  /**
   * Archive une campagne (scopée tenant). Réversible, et la ligne comme ses destinataires restent en base :
   * c'est un masquage de liste, PAS une suppression. Les analytics continuent de la compter.
   * Idempotent côté appelant : rowCount = 0 signifie « déjà archivée » aussi bien que « pas à toi », d'où le
   * contrôle d'appartenance séparé dans la route (qui seul peut rendre un 404 honnête).
   */
  async archiveCampaign(campaignId: string, tenantId: string): Promise<boolean> {
    const res = await this.pool.query(
      `update campaigns set archived_at = now()
       where id = $1 and tenant_id = $2 and archived_at is null`,
      [campaignId, tenantId],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /** Sort une campagne de l'archive (scopée tenant). true si elle y était. */
  async unarchiveCampaign(campaignId: string, tenantId: string): Promise<boolean> {
    const res = await this.pool.query(
      `update campaigns set archived_at = null
       where id = $1 and tenant_id = $2 and archived_at is not null`,
      [campaignId, tenantId],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /**
   * Supprime DÉFINITIVEMENT une campagne, et seulement si elle n'a jamais rien envoyé. `campaign_recipients`
   * part avec elle par `on delete cascade` (0003) : c'est la seule FK vers `campaigns`, rien d'autre à nettoyer.
   *
   * La garde n'est PAS `status = 'draft'` seul. `POST /run` enfile le job SANS changer le statut (c'est le
   * moteur qui passe à 'running') : entre le 202 et la prise en charge par le worker, une campagne lancée est
   * encore un brouillon. On exige donc aussi qu'AUCUN destinataire n'ait quitté 'pending'. Les deux conditions
   * sont dans le WHERE, donc évaluées atomiquement : pas de lecture-puis-écriture, pas de course.
   *
   * Fenêtre résiduelle assumée : si le job est enfilé mais que le worker n'a encore touché aucun destinataire,
   * la suppression passe et le job échouera ensuite en « campagne inconnue » (job en DLQ, aucune donnée
   * corrompue). Elle dure les quelques secondes entre le lancement et la prise en charge, sur une campagne
   * qu'on vient précisément de lancer : la fermer exigerait d'interroger la file, ce qui ne vaut pas ce prix.
   */
  async deleteDraftCampaign(campaignId: string, tenantId: string): Promise<boolean> {
    const res = await this.pool.query(
      `delete from campaigns
       where id = $1 and tenant_id = $2 and status = 'draft'
         and not exists (
           select 1 from campaign_recipients r
           where r.campaign_id = campaigns.id and r.status <> 'pending'
         )`,
      [campaignId, tenantId],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /** Détail d'une campagne (scopée tenant) + ses destinataires. null si absente/autre tenant. */
  async getCampaignDetail(campaignId: string, tenantId: string): Promise<CampaignDetail | null> {
    const head = await this.pool.query<CampaignSummaryRow>(
      // Le détail ne filtre PAS sur archived_at : une campagne archivée reste consultable (c'est tout l'intérêt
      // d'archiver plutôt que de supprimer). On sélectionne quand même la colonne, sinon `toSummary` rendrait
      // `archivedAt: null` sur une campagne archivée, c'est-à-dire une réponse fausse.
      `select c.id, c.name, c.category, c.status, c.phone_number_id,
              c.template_name, c.template_language, c.created_at, c.scheduled_at, c.archived_at,
              (select w.name from workflows w where w.id = c.workflow_id and w.tenant_id = c.tenant_id) as workflow_name,
              count(r.id) as total,
              count(r.id) filter (where r.status = 'pending') as pending,
              count(r.id) filter (where r.status = 'sending') as sending,
              count(r.id) filter (where r.status = 'sent' and r.delivery_status is distinct from 'failed') as sent,
              count(r.id) filter (where r.status = 'failed' or r.delivery_status = 'failed') as failed,
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
      id: string; contact_id: string; to_e164: string; status: string; message_id: string | null; error: string | null;
      error_code: number | null; sent_at: Date | null; delivery_status: string | null; delivery_error: string | null;
    }>(
      `select id, contact_id, to_e164, status, message_id, error, error_code, sent_at, delivery_status, delivery_error
       from campaign_recipients where campaign_id = $1 order by status, id limit 500`,
      [campaignId],
    );
    // param_mapping est un jsonb, renvoyé déjà parsé par node-pg (comme getCampaign). '{}' -> [] si null.
    const mapRes = await this.pool.query<{ param_mapping: TemplateParam[] | null }>(
      `select param_mapping from campaigns where id = $1 and tenant_id = $2`,
      [campaignId, tenantId],
    );
    return {
      ...rowToSummary(h),
      paramMapping: mapRes.rows[0]?.param_mapping ?? [],
      recipients: recs.rows.map((r) => ({
        id: r.id,
        contactId: r.contact_id,
        toE164: r.to_e164,
        status: r.status,
        messageId: r.message_id,
        error: r.error,
        errorCode: r.error_code,
        sentAt: r.sent_at ? r.sent_at.toISOString() : null,
        deliveryStatus: r.delivery_status,
        deliveryError: r.delivery_error,
      })),
    };
  }

  /**
   * Renvoi d'UN destinataire en échec de variable de template (F7). Recharge le destinataire + sa campagne (scopé
   * tenant) et le contact À JOUR, re-résout le paramMapping sur ce contact, et si tout est résolu remet le destinataire
   * à `pending` avec les NOUVELLES valeurs (atomique, `where status='failed'`) -> le prochain `campaign-run` le renvoie
   * (aucun nouveau chemin d'envoi : on réutilise runCampaign). Gardes : destinataire du tenant, status='failed', code
   * d'erreur dans la famille variables. Une variable encore manquante -> `missing_var` (pas de reset : on renverrait le
   * même 131009). L'appelant (route) enfile le run sur `queued`.
   */
  async resetRecipientForRetry(tenantId: string, campaignId: string, recipientId: string): Promise<RetryReset> {
    const rec = await this.pool.query<{ contact_id: string; status: string; error_code: number | null; param_mapping: TemplateParam[] | null }>(
      `select r.contact_id, r.status, r.error_code, c.param_mapping
       from campaign_recipients r join campaigns c on c.id = r.campaign_id
       where r.id = $1 and r.campaign_id = $2 and c.tenant_id = $3`,
      [recipientId, campaignId, tenantId],
    );
    const row = rec.rows[0];
    if (!row) return { result: 'not_found' };
    if (row.status !== 'failed' || row.error_code === null || !RETRYABLE_TEMPLATE_VAR_CODES.has(row.error_code)) {
      return { result: 'not_retryable' };
    }
    const ct = await this.pool.query<{ phone_e164: string | null; bsuid: string | null; profile_name: string | null; fields: Record<string, unknown> | null }>(
      `select phone_e164, bsuid, profile_name, fields from contacts where id = $1 and tenant_id = $2`,
      [row.contact_id, tenantId],
    );
    const contact = ct.rows[0];
    if (!contact) return { result: 'not_found' };
    const { values, missing } = resolveTemplateParams(row.param_mapping ?? [], {
      phone_e164: contact.phone_e164, bsuid: contact.bsuid, profile_name: contact.profile_name, fields: contact.fields ?? {},
    }, { now: new Date() });
    if (missing.length > 0) return { result: 'missing_var', missing };
    const upd = await this.pool.query(
      `update campaign_recipients set status = 'pending', resolved_params = $2::jsonb, error = null, error_code = null, claimed_at = null
       where id = $1 and status = 'failed'`,
      [recipientId, JSON.stringify(values)],
    );
    if ((upd.rowCount ?? 0) === 0) return { result: 'conflict' };
    return { result: 'queued', campaignId };
  }

  /**
   * Destinataires 131049 (marketing plafonné par Meta) prêts à une auto-relance (F6) : tenant `auto_retry_enabled`,
   * `failed`, `retry_count=0`, échec il y a plus de 24 h (on relance « plus tard », pas dans la foulée). Le fenêtrage
   * « début de journée » est décidé par l'appelant (fuseau), pas ici.
   */
  async listRetry131049(nowMs: number, limit = 500): Promise<AutoRetryRecipient[]> {
    return this.listAutoRetry(`r.error_code = 131049 and r.retry_count = 0
       and coalesce(r.delivery_updated_at, r.sent_at) < to_timestamp($1::double precision / 1000.0) - interval '24 hours'`, [nowMs], limit);
  }

  /** Destinataires 131026 (non délivrable) à retenter UNE fois (retry_count=0). */
  async listRetry131026(limit = 500): Promise<AutoRetryRecipient[]> {
    return this.listAutoRetry(`r.error_code = 131026 and r.retry_count = 0`, [], limit);
  }

  /** Destinataires 131026 ayant DÉJÀ été relancés une fois et re-échoué (retry_count=1) -> à marquer injoignable. */
  async listRetry131026SecondFail(limit = 500): Promise<AutoRetryRecipient[]> {
    return this.listAutoRetry(`r.error_code = 131026 and r.retry_count = 1`, [], limit);
  }

  /**
   * Fabrique commune : destinataires EN ÉCHEC d'un tenant `auto_retry_enabled` matchant `cond`. « En échec » =
   * `status='failed'` (rejet SYNCHRONE à l'envoi) OU `delivery_status='failed'` (échec ASYNCHRONE signalé par le
   * webhook de livraison, `status` reste 'sent'). 131049/131026 arrivent quasi toujours par le webhook -> on DOIT
   * inclure delivery_status (même définition d'échec que getCampaignDetail/les stats). Scopé par la jointure.
   */
  private async listAutoRetry(cond: string, params: unknown[], limit: number): Promise<AutoRetryRecipient[]> {
    const res = await this.pool.query<{ id: string; campaign_id: string; tenant_id: string; to_e164: string }>(
      `select r.id, r.campaign_id, c.tenant_id, r.to_e164
       from campaign_recipients r
         join campaigns c on c.id = r.campaign_id
         join tenant_settings ts on ts.tenant_id = c.tenant_id
       where ts.auto_retry_enabled = true and (r.status = 'failed' or r.delivery_status = 'failed') and ${cond}
       order by r.id
       limit ${limit}`,
      params,
    );
    return res.rows.map((r) => ({ id: r.id, campaignId: r.campaign_id, tenantId: r.tenant_id, toE164: r.to_e164 }));
  }

  /**
   * Remet un destinataire en `pending` pour une auto-relance (F6) : incrémente retry_count, pose retried_at, efface
   * l'erreur (le prochain run le renvoie avec ses resolved_params inchangés). Atomique (`where status='failed'`).
   */
  async resetForRetry(id: string): Promise<boolean> {
    // Efface AUSSI l'état de livraison périmé ET l'ancien message_id : sans ça, un destinataire relancé garderait
    // `delivery_status='failed'` (fausse le compteur d'échecs), et une redélivrance tardive du webhook Meta
    // (at-least-once) sur l'ANCIEN message_id ré-écrirait `delivery_status='failed'` pendant la relance. En nullifiant
    // message_id, un webhook sur l'ancien wamid ne matche plus cette ligne (updateDeliveryByMessageId filtre message_id).
    // Atomique sur « en échec » (synchrone OU webhook), même définition que listAutoRetry.
    const res = await this.pool.query(
      `update campaign_recipients set status = 'pending', retry_count = retry_count + 1, retried_at = now(),
         error = null, error_code = null, message_id = null, delivery_status = null, delivery_error = null, delivery_updated_at = null, claimed_at = null
       where id = $1 and (status = 'failed' or delivery_status = 'failed')`,
      [id],
    );
    return (res.rowCount ?? 0) === 1;
  }

  /** Marque un destinataire comme injoignable traité (F6, 2e 131026) : retry_count=2 (terminal) pour ne plus le
   *  re-marquer. À appeler APRÈS le flag HubSpot réussi. Atomique sur l'état attendu (131026, retry_count=1). */
  async markUnreachableDone(id: string): Promise<boolean> {
    const res = await this.pool.query(
      `update campaign_recipients set retry_count = 2, retried_at = now()
       where id = $1 and error_code = 131026 and retry_count = 1 and (status = 'failed' or delivery_status = 'failed')`,
      [id],
    );
    return (res.rowCount ?? 0) === 1;
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

  /** Comme listContactsForBuild mais BORNÉ à des ids précis (API /v1/sends : évite de charger tout le CRM). */
  async listContactsForBuildByIds(tenantId: string, ids: string[]): Promise<BuildContact[]> {
    if (ids.length === 0) return [];
    const res = await this.pool.query<{
      id: string; phone_e164: string | null; bsuid: string | null; profile_name: string | null;
      fields: Record<string, unknown>; opt_in_status: 'opted_in' | 'opted_out' | 'unknown';
    }>(
      `select id, phone_e164, bsuid, profile_name, fields, opt_in_status
       from contacts where tenant_id = $1 and deleted_at is null and id = any($2::uuid[])`,
      [tenantId, ids],
    );
    return res.rows.map((r) => ({
      id: r.id, phone_e164: r.phone_e164, bsuid: r.bsuid, profile_name: r.profile_name, fields: r.fields, optInStatus: r.opt_in_status,
    }));
  }

  /** Contacts du tenant prêts pour buildRecipients (id, phone, bsuid, name, fields, opt-in). */
  async listContactsForBuild(tenantId: string): Promise<BuildContact[]> {
    const res = await this.pool.query<{
      id: string;
      phone_e164: string | null;
      bsuid: string | null;
      profile_name: string | null;
      fields: Record<string, unknown>;
      opt_in_status: 'opted_in' | 'opted_out' | 'unknown';
    }>(
      `select id, phone_e164, bsuid, profile_name, fields, opt_in_status
       from contacts where tenant_id = $1 and deleted_at is null`,
      [tenantId],
    );
    return res.rows.map((r) => ({
      id: r.id,
      phone_e164: r.phone_e164,
      bsuid: r.bsuid,
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
      // Campagne workflow : pas de template propre -> template_name/language null + workflow_id posé.
      const isWorkflow = !!input.workflowId;
      const cRes = await client.query<{ id: string }>(
        `insert into campaigns
           (tenant_id, phone_number_id, name, category, template_name, template_language, param_mapping, workflow_id, rate_per_minute, start_node_id, channel, rcs_agent_id, rcs_message)
         values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12, $13::jsonb)
         returning id`,
        [
          // Campagne RCS : aucun numéro Meta (colonne nullable depuis 0056).
          input.tenantId, input.phoneNumberId === '' ? null : input.phoneNumberId, input.name, input.category,
          isWorkflow ? null : input.templateName, isWorkflow ? null : input.templateLanguage,
          JSON.stringify(input.paramMapping), input.workflowId ?? null, input.ratePerMinute ?? null,
          // start_node_id n'a de sens qu'avec un workflow : sans lui, on force null.
          isWorkflow ? input.startNodeId ?? null : null,
          input.channel ?? 'whatsapp', input.rcsAgentId ?? null,
          input.rcsMessage === undefined ? null : JSON.stringify(input.rcsMessage),
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
  async updateDeliveryByMessageId(messageId: string, status: DeliveryStatus, error: string | null, errorCode: number | null): Promise<number> {
    const res = await this.pool.query(
      `update campaign_recipients
       set delivery_status = $2, delivery_error = $3, delivery_updated_at = now(),
           error_code = $4::integer
       where message_id = $1 and (
         $2 = 'failed'
         or (case $2 when 'read' then 3 when 'delivered' then 2 when 'sent' then 1 else 0 end)
            > (case delivery_status when 'read' then 3 when 'delivered' then 2 when 'sent' then 1 else 0 end)
       )`,
      [messageId, status, error, errorCode],
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
    r: { status: 'sent' | 'failed' | 'skipped'; messageId?: string; error?: string; sentAt?: number; errorCode?: number },
  ): Promise<void> {
    // Invariant sent_at <-> status='sent' : hors 'sent', sent_at est remis à null. error_code : posé sur
    // 'failed' (échec d'envoi), effacé sur 'sent' (un succès n'a pas d'erreur).
    await this.pool.query(
      `update campaign_recipients
       set status = $2,
           message_id = $3,
           error = $4,
           error_code = case when $2 = 'sent' then null::integer else $6::integer end,
           sent_at = case
             when $2 = 'sent' and $5::double precision is not null
               then to_timestamp($5::double precision / 1000.0)
             when $2 = 'sent' then sent_at
             else null
           end
       where id = $1`,
      [id, r.status, r.messageId ?? null, r.error ?? null, r.sentAt ?? null, r.errorCode ?? null],
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
      // Un envoi dont la LIVRAISON a échoué (delivery_status = 'failed', ex. 131042) n'a jamais
      // atteint l'utilisateur : il ne doit pas bloquer un renvoi. On l'exclut du plafond.
      `select (extract(epoch from max(r.sent_at)) * 1000)::bigint as ms
       from campaign_recipients r
       join campaigns c on c.id = r.campaign_id
       where c.tenant_id = $1 and r.to_e164 = $2 and r.status = 'sent'
         and c.category = 'marketing'
         and (r.delivery_status is null or r.delivery_status <> 'failed')`,
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
