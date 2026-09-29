import type { Pool, PoolClient } from 'pg';
import { enTransaction } from '../db/transaction';
import type { MotifDePause } from './pause';
import type { Campaign, CampaignStatus, CampaignCategory, Recipient, QualityRating } from './types';
import type { CampaignStore, RecipientStore, QualityProvider, EcartALEnvoi } from './engine';
import type { BuildContact, BuiltRecipient, ContactEnvoi } from './build';
import type { WorkflowGraph } from '../workflow/graph';
import { resolveTemplateParams, type TemplateParam } from '../crm/template';
import { MATCH_BY_WAID_SQL } from '../crm/contact-store.pg';
import { RECIPIENT_FAILED_SQL } from './echecs-sql';
import type { CampagneAssignante } from '../inbox/assignation-campagne';
import { RANG_INITIAL, normaliserChaine, type CanalEtage, type DevenirEtage, type Etage, type EtageEntrant } from './etages';
import type { EntreeDeDecision } from './bascule';
import type { DeliveryStore, DeliveryStatus } from '../webhooks/delivery';

export interface CreateCampaignInput {
  tenantId: string;
  /**
   * Ce qui se passe quand le contact répond au premier étage. Il vit ici et pas dans `chaine` : le rang 1 est la
   * campagne elle-même, ses colonnes en sont la seule source. Une campagne sans repli n'envoie pas de `chaine`
   * et doit pourtant dire ce que devient sa réponse.
   */
  devenir?: DevenirEtage;
  /** '' pour une campagne RCS : il n'y a pas de numéro Meta (colonne nullable). */
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
  /** Cible node (/v1/sends) : démarre le workflow à ce bloc au lieu de son entrée. Requiert `workflowId`. */
  startNodeId?: string;
  /** Débit max en messages/minute (1..80). Absent/null = aucun throttle. */
  ratePerMinute?: number | null;
  /** N'envoyer que pendant les heures d'ouverture de l'espace. Absent = aucune contrainte. */
  businessHoursOnly?: boolean;
  /** Canal d'envoi. Absent = 'whatsapp'. */
  channel?: 'whatsapp' | 'rcs';
  /** Agent RCS (`rcs_agents.agent_id`). Requis si `channel = 'rcs'` ou si la chaîne porte un étage RCS. */
  rcsAgentId?: string;
  /** Message RCS, validé par zod à la création. Requis si `channel = 'rcs'`. */
  rcsMessage?: unknown;
  /**
   * Campagne au fil de l'eau : le webhook entrant qui lui amène ses destinataires. Elle naît sans destinataire
   * (`contactIds` n'a plus de sens) et ne se termine pas toute seule.
   */
  webhookId?: string;
  /**
   * La chaîne d'étages, quand la campagne en a une. Absente = un seul étage, celui de la campagne.
   * `insertCampaignRow` en est le seul écrivain.
   *
   * Ses rangs sont une intention d'ordre, renumérotés 1..N par `normaliserChaine` ; `problemeDeChaine` refuse
   * en amont ce que le CHECK refuserait en 5xx. Le contenu du rang 1 est ignoré : il vient des colonnes de
   * `campaigns`.
   */
  chaine?: EtageEntrant[];
  /** « Réessayer les envois qui échouent » (`campaigns.reessayer`). Absent = le défaut de la table (vrai). */
  reessayer?: boolean;
  /** Le rattrapage peut-il partir hors des heures d'ouverture ? Absent = le défaut de la table (faux). */
  rattrapageHorsHoraires?: boolean;
  /** Comment les réponses se répartissent dans l'Inbox. Absent/null = aucune assignation. */
  assignation?: 'personne' | 'tour_de_role' | null;
  /** La personne, quand `assignation` vaut `personne`. Ignoré sinon. */
  assignationUserId?: string | null;
}

/** Ligne SQL d'un résumé de campagne (liste + détail : même projection). */
export interface CampaignSummaryRow {
  id: string; name: string; category: CampaignCategory; status: CampaignStatus;
  phone_number_id: string; template_name: string | null; template_language: string | null;
  workflow_name?: string | null;
  webhook_id?: string | null;
  webhook_name?: string | null;
  created_at: Date; scheduled_at?: Date | null; archived_at?: Date | null;
  total: string; pending: string; sending: string; sent: string; failed: string; skipped: string;
}

/**
 * Ligne SQL -> CampaignSummary. Fonction pure. Ne coerce pas un null en chaîne vide : une campagne scénario n'a
 * pas de template, et l'écran doit le savoir.
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
    webhookId: r.webhook_id ?? null,
    webhookName: r.webhook_name ?? null,
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
  /** null pour une campagne scénario (c'est le scénario qui envoie). Nullable à dessein : chaque appelant doit
   *  traiter le cas, une chaîne vide s'afficherait en « template () ». */
  templateName: string | null;
  templateLanguage: string | null;
  /** Nom du scénario d'une campagne scénario. null = campagne template, ou scénario supprimé depuis. */
  workflowName: string | null;
  /** Webhook qui alimente la campagne au fil de l'eau. null = campagne ordinaire (liste figée à la création). */
  webhookId: string | null;
  /** Nom de ce webhook, pour l'afficher sans second appel. null = campagne ordinaire, ou adresse supprimée. */
  webhookName: string | null;
  createdAt: string;
  /** Instant de lancement programmé (ISO UTC) quand status = 'scheduled'. null sinon. */
  scheduledAt: string | null;
  /** Instant d'archivage (ISO UTC). null = campagne active. Orthogonal au statut : une campagne archivée garde
   *  son statut d'origine et ses destinataires, qui portent l'historique. */
  archivedAt: string | null;
  counts: RecipientCounts;
}
export interface CampaignDetail extends CampaignSummary {
  /**
   * La chaîne telle qu'elle a été lancée, étage par étage : ce qui a été envoyé (message, scénario, repli) doit
   * rester consultable après coup. Jamais vide pour une campagne créée par ce code (le rang 1 est toujours
   * écrit).
   */
  chaine: Etage[];
  /** Mapping des variables du template (positions -> source) : dit au front quel champ corriger. */
  paramMapping: TemplateParam[];
  recipients: Array<{
    id: string;
    contactId: string;
    toE164: string;
    status: string;
    messageId: string | null;
    error: string | null;
    /** Code d'erreur Meta numérique (null hors échec). Pilote le bouton « Corriger + renvoyer ». */
    errorCode: number | null;
    sentAt: string | null;
    deliveryStatus: string | null;
    deliveryError: string | null;
  }>;
}

/**
 * Ce que la lecture d'un envoi de l'API rend, avant mise en forme (`formaterSuiviEnvoi`). Distinct de
 * `CampaignDetail` pour qu'un changement de la console ne change pas l'API.
 *
 * `graph` est le graphe publié relu maintenant : l'ouverture d'un envoi de scénario se recalcule dessus.
 * `channel` est lu parce que `GET /v1/sends/{sendId}` lit n'importe quelle campagne de l'espace : une campagne
 * RCS de la console a `template_name` à `''`, et passerait sinon pour un template WhatsApp au nom vide.
 * `recipients` est borné à 500 lignes, `recipientsTotal` dit combien il y en a. Le rang et le canal sont lus
 * par destinataire : une chaîne de repli le fait passer sur un autre canal.
 */
export interface EnvoiApiBrut {
  id: string;
  status: CampaignStatus;
  createdAt: string;
  /** `campaigns.channel` (`not null default 'whatsapp'`). Une campagne RCS n'a jamais de scénario. */
  channel: 'whatsapp' | 'rcs';
  /**
   * Le nom de la campagne. Pour un envoi RCS de l'API, `[API] <nom du message>`, jamais coupé : c'est là que le
   * suivi relit la cible `rcsMessage` (`nomDuMessageRcs`), la campagne ne gardant que le contenu.
   */
  name: string;
  templateName: string | null;
  templateLanguage: string | null;
  /** Code public `scn_…` du scénario. null pour un template, ou un scénario supprimé depuis. */
  workflowCode: string | null;
  startNodeId: string | null;
  graph: WorkflowGraph | null;
  counts: { pending: number; sending: number; sent: number; failed: number; skipped: number };
  /** Le nombre de destinataires de la campagne, que `recipients` soit tronqué ou non. */
  recipientsTotal: number;
  recipients: Array<{
    contactId: string;
    externalId: string | null;
    /** `campaign_recipients.etage_courant` : 1 tant qu'aucune bascule ne l'a fait avancer. */
    rang: number;
    /** Le canal de l'étage où est le destinataire (`campaign_etages.canal`). null si l'étage n'existe pas. */
    canalEtage: 'whatsapp' | 'rcs' | 'email' | null;
    status: string;
    messageId: string | null;
    error: string | null;
    errorCode: number | null;
    sentAt: string | null;
    deliveryStatus: string | null;
    deliveryError: string | null;
  }>;
}

/** Codes d'erreur Meta « variable de template » : renvoyables après correction de la donnée du contact. */
export const RETRYABLE_TEMPLATE_VAR_CODES = new Set([131009, 132012, 132000]);

/**
 * « Cette campagne n'a pas de repli », c'est-à-dire rien au-delà du premier étage.
 *
 * C'est la frontière entre les deux politiques de rattrapage, posée en SQL parce que c'est ce qui la rend
 * exclusive : avec un repli la bascule gouverne, sans repli la politique de réessai. Sans cette clause, un même
 * échec serait basculé et relancé, donc un envoi de trop.
 *
 * `${RANG_INITIAL}` est interpolé et non paramétré : constante du code, jamais une entrée.
 */
const SANS_REPLI_SQL = `not exists (select 1 from campaign_etages ce where ce.campaign_id = r.campaign_id and ce.rang > ${RANG_INITIAL})`;

/**
 * Un destinataire repris par le balayage de relance. `contactId` sert à écrire la joignabilité sur la ligne
 * `contacts` : retrouver le contact par son numéro serait une seconde définition de son identité.
 */
export interface AutoRetryRecipient {
  id: string; campaignId: string; tenantId: string; contactId: string; toE164: string;
  /**
   * L'option `rattrapage_hors_horaires` de sa campagne, portée par le destinataire : un tour de balayage sert
   * plusieurs campagnes aux réglages différents.
   */
  rattrapageHorsHoraires: boolean;
}

/**
 * Un destinataire en échec dont la campagne porte un repli, avec ce que la règle de bascule demande. Il étend
 * `EntreeDeDecision` au lieu d'en recopier les champs : un champ ajouté à la règle devient une erreur de
 * compilation ici, au seul endroit qui sait le remplir.
 */
export interface CandidatBascule extends AutoRetryRecipient, EntreeDeDecision {}

/** Résultat d'une tentative de renvoi, discriminé pour que la route mappe 404/409/422/202. */
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


/**
 * Projection commune de la liste et du détail d'une campagne (en-tête, nom du scénario, compteurs par statut) :
 * les deux requêtes ne diffèrent que par leur `where` et leur `group by`.
 *
 * `colonnesEnPlus` sert au détail (le `param_mapping`, que la liste ne doit pas payer). Le `group by c.id`
 * porte sur la clé primaire : toute colonne de `campaigns` y est sélectionnable sans agrégat.
 */
const summarySelect = (colonnesEnPlus = '') => `select c.id, c.name, c.category, c.status, c.phone_number_id,
              c.template_name, c.template_language, c.created_at, c.scheduled_at, c.archived_at,
              (select w.name from workflows w where w.id = c.workflow_id and w.tenant_id = c.tenant_id) as workflow_name,
              c.webhook_id,
              (select h.name from webhooks h where h.id = c.webhook_id and h.tenant_id = c.tenant_id) as webhook_name,
              count(r.id) as total,
              count(r.id) filter (where r.status = 'pending') as pending,
              count(r.id) filter (where r.status = 'sending') as sending,
              count(r.id) filter (where r.status = 'sent' and r.delivery_status is distinct from 'failed') as sent,
              count(r.id) filter (where ${RECIPIENT_FAILED_SQL}) as failed,
              count(r.id) filter (where r.status = 'skipped') as skipped${colonnesEnPlus}
       from campaigns c
       left join campaign_recipients r on r.campaign_id = c.id`;

/** Lecture/écriture des campagnes et de leurs destinataires (assemblage). */
export class PgCampaignRepo {
  constructor(private readonly pool: Pool) {}

  /**
   * Crée une campagne, sans destinataire (tests d'intégration, API de bas niveau). Transactionnelle : une chaîne
   * à plusieurs étages écrite à moitié donnerait une campagne que personne ne peut servir, `getCampaign` lisant
   * la chaîne pour décider ce qu'un run envoie.
   */
  async insertCampaign(input: CreateCampaignInput): Promise<string> {
    return enTransaction(this.pool, (client) => insertCampaignRow(client, input));
  }

  async getCampaign(id: string): Promise<Campaign | null> {
    const res = await this.pool.query<{
      id: string;
      tenant_id: string;
      /** null pour une campagne RCS, qui n'a pas de numéro Meta. */
      phone_number_id: string | null;
      category: CampaignCategory;
      template_name: string | null;
      template_language: string | null;
      param_mapping: TemplateParam[];
      status: CampaignStatus;
      workflow_id: string | null;
      rate_per_minute: number | null;
      start_node_id: string | null;
      channel: 'whatsapp' | 'rcs' | null;
      rcs_agent_id: string | null;
      rcs_message: unknown;
      webhook_id: string | null;
      business_hours_only: boolean | null;
    }>(
      // `channel`, `rcs_agent_id`, `rcs_message` et `webhook_id` sont relus : cette lecture alimente le job de
      // run. Sans eux, une campagne RCS repartirait sur le chemin WhatsApp avec un phone_number_id nul, et une
      // campagne au fil de l'eau se terminerait à la première file vide.
      `select id, tenant_id, phone_number_id, category, template_name, template_language,
              param_mapping, status, workflow_id, rate_per_minute, start_node_id,
              channel, rcs_agent_id, rcs_message, webhook_id, business_hours_only
       from campaigns where id = $1`,
      [id],
    );
    const r = res.rows[0];
    if (!r) return null;
    return {
      id: r.id,
      tenantId: r.tenant_id,
      phoneNumberId: r.phone_number_id ?? '',
      category: r.category,
      templateName: r.template_name ?? '',
      templateLanguage: r.template_language ?? '',
      paramMapping: r.param_mapping,
      status: r.status,
      workflowId: r.workflow_id,
      ratePerMinute: r.rate_per_minute,
      startNodeId: r.start_node_id,
      // Campagne ancienne : `channel` null en base -> WhatsApp.
      channel: r.channel ?? 'whatsapp',
      rcsAgentId: r.rcs_agent_id,
      rcsMessage: r.rcs_message,
      webhookId: r.webhook_id,
      // `null` ne vient que d'une ligne antérieure à la colonne (défaut false) : aucune contrainte d'horaire.
      businessHoursOnly: r.business_hours_only === true,
      chaine: await this.lireChaine(id),
    };
  }

  /**
   * La chaîne d'étages d'une campagne, triée par rang. Une requête de plus par appel de `getCampaign`, jamais
   * par destinataire ; la joindre à la lecture principale dupliquerait la ligne de campagne par étage.
   *
   * `order by rang` sert au lecteur, pas à la correction : `rangSuivant` et `etageAuRang` ne supposent aucun
   * ordre. Pas de `tenant_id` ici : `getCampaign` lit `where id = $1` et rend le tenant pour que l'appelant
   * tranche (`getForRun`), filtrer la chaîne seule ne protégerait rien.
   */
  private async lireChaine(campaignId: string): Promise<Etage[]> {
    return (await this.lireChainesDe([campaignId])).get(campaignId) ?? [];
  }

  /**
   * Les chaînes de plusieurs campagnes en une requête, indexées par campagne : point de passage unique de la
   * traduction `campaign_etages` -> `Etage`, pour qu'un champ ajouté à un étage ne diverge pas entre deux
   * copies. La clé primaire `(campaign_id, rang)` sert `= any($1::uuid[])`.
   */
  private async lireChainesDe(campaignIds: string[]): Promise<Map<string, Etage[]>> {
    const parCampagne = new Map<string, Etage[]>();
    if (campaignIds.length === 0) return parCampagne;
    const res = await this.pool.query<{
      campaign_id: string;
      rang: number;
      canal: CanalEtage;
      template_name: string | null;
      template_language: string | null;
      rcs_message: unknown;
      email_template_id: string | null;
      email_champ: string | null;
      workflow_id: string | null;
      workflow_name: string | null;
      devenir: 'mba' | 'inbox' | null;
    }>(
      // Jointure externe : un scénario supprimé depuis ne doit pas faire disparaître l'étage de l'écran.
      `select e.campaign_id, e.rang, e.canal, e.template_name, e.template_language, e.rcs_message,
              e.email_template_id, e.email_champ, e.workflow_id, w.name as workflow_name, e.devenir
         from campaign_etages e
         left join workflows w on w.id = e.workflow_id
        where e.campaign_id = any($1::uuid[]) order by e.campaign_id, e.rang`,
      [campaignIds],
    );
    for (const e of res.rows) {
      const etage: Etage = {
        rang: e.rang,
        canal: e.canal,
        ...(e.template_name !== null ? { templateName: e.template_name } : {}),
        ...(e.template_language !== null ? { templateLanguage: e.template_language } : {}),
        ...(e.rcs_message !== null ? { rcsMessage: e.rcs_message } : {}),
        ...(e.email_template_id !== null ? { emailTemplateId: e.email_template_id } : {}),
        ...(e.email_champ !== null ? { emailChamp: e.email_champ } : {}),
        ...(e.workflow_id !== null ? { workflowId: e.workflow_id } : {}),
        ...(e.workflow_name !== null ? { workflowName: e.workflow_name } : {}),
        ...(e.devenir !== null ? { devenir: e.devenir } : {}),
      };
      const deja = parCampagne.get(e.campaign_id);
      if (deja) deja.push(etage); else parCampagne.set(e.campaign_id, [etage]);
    }
    return parCampagne;
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

  /** Débit choisi + nb de destinataires en attente : dimensionne le timeout du job de run (pacing.ts). */
  async getRunSizing(campaignId: string): Promise<{ tenantId: string; ratePerMinute: number | null; pendingCount: number } | null> {
    // `tenant_id` est rendu ici parce que tout enfilement de run en a besoin : c'est le groupe de la file, sur
    // lequel s'applique la concurrence par espace.
    const res = await this.pool.query<{ tenant_id: string; rate_per_minute: number | null; pending: string }>(
      `select c.tenant_id, c.rate_per_minute,
              (select count(*) from campaign_recipients r where r.campaign_id = c.id and r.status = 'pending')::text as pending
       from campaigns c where c.id = $1`,
      [campaignId],
    );
    const r = res.rows[0];
    return r ? { tenantId: r.tenant_id, ratePerMinute: r.rate_per_minute, pendingCount: Number(r.pending) } : null;
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

  /** Campagnes programmées dues (scheduled_at <= maintenant) et leur dimensionnement de run. Le sweeper les
   *  enfile puis les passe en 'running'. Cross-tenant (le sweeper tourne pour tous). */
  async listDueScheduled(now: Date = new Date()): Promise<Array<{ id: string; tenantId: string; ratePerMinute: number | null; pendingCount: number }>> {
    const res = await this.pool.query<{ id: string; tenant_id: string; rate_per_minute: number | null; pending: string }>(
      `select c.id, c.tenant_id, c.rate_per_minute,
              (select count(*) from campaign_recipients r where r.campaign_id = c.id and r.status = 'pending')::text as pending
       from campaigns c
       where c.status = 'scheduled' and c.scheduled_at <= $1`,
      [now.toISOString()],
    );
    return res.rows.map((r) => ({ id: r.id, tenantId: r.tenant_id, ratePerMinute: r.rate_per_minute, pendingCount: Number(r.pending) }));
  }

  /** Passe une campagne programmée en 'running' (claim du sweeper, garde `status='scheduled'` anti-double).
   *  true si claimée par cet appel (une seule fois même avec plusieurs sweepers). */
  async markScheduledRunning(campaignId: string): Promise<boolean> {
    const res = await this.pool.query(
      `update campaigns set status = 'running', scheduled_at = null where id = $1 and status = 'scheduled'`,
      [campaignId],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /**
   * Campagnes actives (draft, running, paused, scheduled) qui référencent un template (par nom ; langue
   * optionnelle, omise = toutes). Éditer ou supprimer un template utilisé casserait leurs envois : un draft a
   * déjà ses destinataires construits, un running/paused est relançable, et un edit repasse le template en
   * PENDING.
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
   * Résumé des campagnes du tenant avec le décompte des destinataires par statut. Par défaut les campagnes
   * actives ; `opts.archived = true` rend exclusivement les archivées (ensembles disjoints).
   */
  async listCampaignSummaries(tenantId: string, opts?: { archived?: boolean }): Promise<CampaignSummary[]> {
    // Prédicat choisi sur un booléen interne, jamais sur une entrée. Écrit en littéral pour que la branche par
    // défaut touche l'index partiel `campaigns_active_idx ... where archived_at is null`.
    const archivedFilter = opts?.archived ? 'c.archived_at is not null' : 'c.archived_at is null';
    const res = await this.pool.query<CampaignSummaryRow>(
      // Nom du scénario en sous-requête scalaire : avec `group by c.id`, Postgres refuserait `w.name` d'une table
      // jointe.
      `${summarySelect()}
       where c.tenant_id = $1 and ${archivedFilter}
       group by c.id
       order by c.created_at desc`,
      [tenantId],
    );
    return res.rows.map((r) => rowToSummary(r));
  }

  /**
   * Archive une campagne (scopée tenant). Réversible : un masquage de liste, pas une suppression, les
   * analytics continuent de la compter. rowCount = 0 veut dire « déjà archivée » comme « pas à toi », d'où le
   * contrôle d'appartenance séparé dans la route.
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
   * Supprime définitivement une campagne, seulement si elle n'a jamais rien envoyé. `campaign_recipients` part
   * avec elle par `on delete cascade`.
   *
   * 🔴 La garde n'est pas `status = 'draft'` seul : `POST /run` enfile sans changer le statut, donc une campagne
   * lancée reste un brouillon jusqu'à sa prise en charge. On exige aussi qu'aucun destinataire n'ait quitté
   * `pending`, dans le même WHERE (atomique). Fenêtre résiduelle : job enfilé mais aucun destinataire touché,
   * la suppression passe et le job finit en « campagne inconnue », sans donnée corrompue.
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
    const head = await this.pool.query<CampaignSummaryRow & { param_mapping: TemplateParam[] | null }>(
      // Le détail ne filtre pas sur archived_at : une campagne archivée reste consultable, et la colonne est
      // sélectionnée pour que `archivedAt` soit juste.
      `${summarySelect(',\n              c.param_mapping')}
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
    // Même lecture que le reste du store (`lireChainesDe`), pas une seconde traduction des colonnes.
    const chaines = await this.lireChainesDe([campaignId]);
    return {
      ...rowToSummary(h),
      chaine: chaines.get(campaignId) ?? [],
      // jsonb renvoyé déjà parsé par node-pg (comme getCampaign) ; null -> [].
      paramMapping: h.param_mapping ?? [],
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
   * Renvoi d'un destinataire en échec de variable de template. Recharge le destinataire, sa campagne (scopé
   * tenant) et le contact à jour, re-résout le paramMapping, et si tout est résolu remet le destinataire à
   * `pending` avec les nouvelles valeurs (atomique, `where status='failed'`) : le prochain `campaign-run` le
   * renvoie. Une variable encore manquante rend `missing_var` sans reset (on renverrait le même 131009).
   * L'appelant enfile le run sur `queued`.
   */
  async resetRecipientForRetry(tenantId: string, campaignId: string, recipientId: string): Promise<RetryReset> {
    const rec = await this.pool.query<{ contact_id: string; status: string; error_code: number | null; param_mapping: TemplateParam[] | null; variables: Record<string, string> | null }>(
      `select r.contact_id, r.status, r.error_code, c.param_mapping, r.variables
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
    // Les variables du destinataire repartent avec lui : sans elles, une source « variable » d'un envoi de
    // l'API serait toujours manquante au renvoi.
    }, { now: new Date(), ...(row.variables ? { variables: row.variables } : {}) });
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
   * Destinataires 131049 (marketing plafonné par Meta) prêts à une auto-relance : relance permise,
   * `retry_count=0`, échec il y a plus de 24 h. La fenêtre « début de journée » est décidée par l'appelant.
   */
  async listRetry131049(nowMs: number, limit = 500): Promise<AutoRetryRecipient[]> {
    return this.listAutoRetry(`r.error_code = 131049 and r.retry_count = 0
       and coalesce(r.delivery_updated_at, r.sent_at) < to_timestamp($1::double precision / 1000.0) - interval '24 hours'`, [nowMs], limit);
  }

  /** Destinataires 131026 (non délivrable) à retenter une fois (retry_count=0). */
  async listRetry131026(limit = 500): Promise<AutoRetryRecipient[]> {
    return this.listAutoRetry(`r.error_code = 131026 and r.retry_count = 0`, [], limit);
  }

  /** Destinataires 131026 déjà relancés une fois et re-échoués (retry_count=1) -> à marquer injoignables. */
  async listRetry131026SecondFail(limit = 500): Promise<AutoRetryRecipient[]> {
    return this.listAutoRetry(`r.error_code = 131026 and r.retry_count = 1`, [], limit);
  }

  /**
   * Fabrique commune : destinataires en échec dont la relance est permise, selon `cond`. « En échec » inclut
   * `delivery_status='failed'` : 131049 et 131026 arrivent presque toujours par le webhook. Scopé par la
   * jointure.
   *
   * La relance est permise par la case « Réessayer » de la campagne (`reessai_par_campagne`), ou pour une
   * campagne plus ancienne par la case de l'espace (`auto_retry_enabled`). `left join` : une campagne d'un
   * espace sans ligne de réglages doit être listée.
   */
  private async listAutoRetry(cond: string, params: unknown[], limit: number): Promise<AutoRetryRecipient[]> {
    const res = await this.pool.query<{
      id: string; campaign_id: string; tenant_id: string; contact_id: string; to_e164: string;
      rattrapage_hors_horaires: boolean;
    }>(
      `select r.id, r.campaign_id, c.tenant_id, r.contact_id, r.to_e164, c.rattrapage_hors_horaires
       from campaign_recipients r
         join campaigns c on c.id = r.campaign_id
         left join tenant_settings ts on ts.tenant_id = c.tenant_id
       where (case when c.reessai_par_campagne then c.reessayer else coalesce(ts.auto_retry_enabled, false) end)
         and (${RECIPIENT_FAILED_SQL}) and ${cond}
         and ${SANS_REPLI_SQL}
       order by r.id
       limit ${limit}`,
      params,
    );
    return res.rows.map((r) => ({
      id: r.id, campaignId: r.campaign_id, tenantId: r.tenant_id, contactId: r.contact_id, toE164: r.to_e164,
      rattrapageHorsHoraires: r.rattrapage_hors_horaires,
    }));
  }

  /**
   * Les destinataires en échec d'une campagne qui a un repli : la matière première de la bascule.
   *
   * Elle ne décide rien : le `where` dit « la campagne a un étage au-delà du premier », et c'est `decider` qui
   * répond « plus d'étage disponible » (la règle reste testable hors SQL). Elle n'est pas soumise à la
   * permission de relance : une chaîne de repli est une configuration explicite de la campagne.
   *
   * Le `in (select ...)` part de `campaign_etages` (rangs > 1 rares) et rejoint `campaign_recipients` par
   * `campaign_id`, servi par l'unique `(campaign_id, contact_id)` : sans ce sens de lecture, la condition
   * d'échec seule parcourrait la plus grosse table à chaque balayage.
   */
  async listCandidatsBascule(limit = 500): Promise<CandidatBascule[]> {
    const res = await this.pool.query<{
      id: string; campaign_id: string; tenant_id: string; contact_id: string; to_e164: string;
      error_code: number | null; etage_courant: number; retry_count: number; reessayer: boolean;
      rattrapage_hors_horaires: boolean;
    }>(
      `select r.id, r.campaign_id, c.tenant_id, r.contact_id, r.to_e164,
              r.error_code, r.etage_courant, r.retry_count, c.reessayer, c.rattrapage_hors_horaires
       from campaign_recipients r
         join campaigns c on c.id = r.campaign_id
       where (${RECIPIENT_FAILED_SQL})
         and r.campaign_id in (select campaign_id from campaign_etages where rang > ${RANG_INITIAL})
       order by r.id
       limit ${limit}`,
    );
    const chaines = await this.lireChainesDe([...new Set(res.rows.map((r) => r.campaign_id))]);
    const candidats: CandidatBascule[] = res.rows.map((r) => ({
      id: r.id, campaignId: r.campaign_id, tenantId: r.tenant_id, contactId: r.contact_id, toE164: r.to_e164,
      rattrapageHorsHoraires: r.rattrapage_hors_horaires,
      codeErreur: r.error_code,
      chaine: chaines.get(r.campaign_id) ?? [],
      rangCourant: r.etage_courant,
      reessayer: r.reessayer,
      // Le budget de réessai est d'un, tous motifs confondus : `retry_count` le porte déjà.
      dejaReessaye: r.retry_count > 0,
      emailDuContact: null,
    }));
    return this.poserLesAdresses(candidats, chaines);
  }

  /**
   * L'adresse e-mail de chaque candidat dont la chaîne porte un étage e-mail, lue dans le jsonb `fields` sous
   * la clé de l'étage (`campaign_etages.email_champ`) : `contacts` n'a pas de colonne `email`.
   *
   * 🔴 Une requête par (espace, clé), scopée tenant : le pooler est superuser, et les candidats d'un même tour
   * appartiennent à plusieurs espaces. La clé passe en paramètre (`fields ->> $3`), jamais interpolée : elle
   * vient d'un écran. L'index est la clé primaire de `contacts`, le lot est borné par `listCandidatsBascule`.
   */
  private async poserLesAdresses(
    candidats: CandidatBascule[],
    chaines: Map<string, Etage[]>,
  ): Promise<CandidatBascule[]> {
    // Clé de groupe en JSON et non par concaténation : une clé de champ est un texte libre qui peut contenir
    // n'importe quel séparateur, et deux groupes se confondraient.
    const groupes = new Map<string, { tenantId: string; champ: string; contacts: Set<string> }>();
    for (const c of candidats) {
      const champ = (chaines.get(c.campaignId) ?? []).find((e) => e.canal === 'email')?.emailChamp;
      if (!champ) continue;
      const cle = JSON.stringify([c.tenantId, champ]);
      const deja = groupes.get(cle);
      if (deja) deja.contacts.add(c.contactId);
      else groupes.set(cle, { tenantId: c.tenantId, champ, contacts: new Set([c.contactId]) });
    }
    if (groupes.size === 0) return candidats;

    const adresses = new Map<string, string>();
    for (const g of groupes.values()) {
      const res = await this.pool.query<{ id: string; email: string | null }>(
        `select id, fields ->> $3 as email from contacts where tenant_id = $1 and id = any($2::uuid[])`,
        [g.tenantId, [...g.contacts], g.champ],
      );
      for (const row of res.rows) {
        if (row.email !== null) adresses.set(JSON.stringify([g.tenantId, row.id]), row.email);
      }
    }
    return candidats.map((c) => ({
      ...c,
      emailDuContact: adresses.get(JSON.stringify([c.tenantId, c.contactId])) ?? null,
    }));
  }

  /**
   * La campagne à laquelle ce contact répond, quand elle décide de quelque chose (un devenir d'étage ou une
   * affectation), ou `null` (le cas très majoritaire, ce qui la rend acceptable sur le chemin de chaque message
   * entrant). Elle lit le devenir de l'étage où se trouvait le destinataire (`etage_courant`), pas de la campagne.
   *
   * 🔴 LA CAMPAGNE À LAQUELLE ON RÉPOND EST LA PLUS RÉCENTE SERVIE À CE CONTACT, et c'est seulement ensuite qu'on
   * regarde si elle décide de quelque chose : la sous-requête choisit la ligne (`order by ... limit 1`), le `where`
   * extérieur la filtre. Filtrer avant le `limit` ferait passer une vieille campagne « Inbox » devant la campagne à
   * scénario d'hier, à laquelle le contact répond vraiment : le fil serait pris pour l'équipe, et ce scénario ne
   * pourrait plus jamais avancer pour lui.
   *
   * 🔴 `premiere_reponse` : la conversation compte au plus UN message entrant depuis l'envoi, celui qu'on traite
   * (`recordInbound` l'enregistre avant l'appel d'affectation, `processInbound`). Seule cette réponse-là prend le
   * fil (`assignerReponse`) : sinon chaque message du contact le reprendrait pour l'équipe, pour toujours, et
   * défairait un « Rendre la main ». `created_at` (horloge de la base) et `sent_at` (horloge du worker, posée quand
   * Meta a accepté l'envoi) sont comparables à la seconde, bien en deçà du délai d'une réponse humaine. Le compte
   * s'arrête à deux (`limit 2`) : on veut savoir « un ou plus », pas combien, sur un fil qui peut être long.
   * ⚠️ Deux messages du même contact traités EN MÊME TEMPS se compteraient l'un l'autre, et aucun ne prendrait le
   * fil : c'est la sérialisation par contact de la file `webhook` (`groupConcurrency: 1`, `src/worker.ts`) qui
   * l'exclut, et elle est locale au process.
   *
   * `cv.assigned_to is null` est dans le `where` de la sous-requête et doit y rester : le rang du tour de rôle est
   * pris avant `assigner`, donc sans ce filtre chaque message d'un contact déjà assigné consommerait un rang et
   * décalerait la répartition de toute l'équipe. `c.tenant_id = $1` y reste aussi : un filtre d'isolation se pose
   * avant de choisir la ligne, pas après.
   *
   * Index : l'unique `(tenant_id, wa_id)` rend la conversation, puis `campaign_recipients_contact_idx`
   * (`contact_id, sent_at desc`) ses destinataires triés, la clé primaire de `campaigns` et celle de
   * `campaign_etages` (`campaign_id, rang`) pour la seule ligne retenue ; une clause sur `to_e164` ne serait servie
   * par aucun index. Le compte des entrants est servi par l'index partiel `conversation_messages_unread_idx`
   * (`conversation_id, created_at`, `where direction = 'in'`, migration 0092), dont le prédicat est celui de la
   * sous-requête. Aucune fenêtre de temps : `assigned_to is null` borne l'affectation à une par conversation, et
   * `premiere_reponse` la prise du fil à une par envoi.
   */
  async campagneAssignanteDuContact(
    tenantId: string,
    waId: string,
  ): Promise<CampagneAssignante | null> {
    const res = await this.pool.query<{
      id: string;
      nom: string;
      assignation: 'personne' | 'tour_de_role' | null;
      assignation_user_id: string | null;
      devenir: 'mba' | 'inbox' | null;
      premiere_reponse: boolean;
    }>(
      `select d.id, d.nom, d.assignation, d.assignation_user_id, e.devenir,
              (select count(*) from (
                 select 1 from conversation_messages m
                  where m.conversation_id = d.conversation_id and m.direction = 'in' and m.created_at > d.sent_at
                  limit 2
               ) entrants) <= 1 as premiere_reponse
         from (
           select c.id, c.name as nom, c.assignation, c.assignation_user_id, r.etage_courant, r.sent_at, cv.id as conversation_id
             from conversations cv
             join campaign_recipients r on r.contact_id = cv.contact_id
             join campaigns c on c.id = r.campaign_id
            where cv.tenant_id = $1 and cv.wa_id = $2 and cv.assigned_to is null
              and c.tenant_id = $1 and r.sent_at is not null
            order by r.sent_at desc
            limit 1
         ) d
         left join campaign_etages e on e.campaign_id = d.id and e.rang = d.etage_courant
        where d.assignation is not null or e.devenir is not null`,
      [tenantId, waId],
    );
    const row = res.rows[0];
    return row
      ? {
        campaignId: row.id,
        nom: row.nom,
        devenir: row.devenir,
        assignation: row.assignation,
        assignationUserId: row.assignation_user_id,
        premiereReponse: row.premiere_reponse,
      }
      : null;
  }

  /**
   * Prend le prochain rang du tour de rôle de cette campagne et l'avance, en une seule écriture.
   *
   * Lire puis écrire serait faux sous charge : deux réponses simultanées liraient le même rang. `update ...
   * returning` fait les deux sous le verrou de ligne. Elle rend la valeur nouvelle telle quelle (`RETURNING`
   * ne rend jamais l'ancienne) : un tour de rôle n'a besoin que de valeurs consécutives et distinctes, c'est
   * `prochainAssigne` qui ramène le rang dans l'équipe. Le premier rang consommé vaut donc 1.
   *
   * Pas de repliage modulo dans le SQL (la colonne est un `integer`) : un repliage à 32767 ferait tomber deux
   * rangs consécutifs sur la même personne pour les petites équipes.
   *
   * Campagne inconnue -> `0` : lever casserait l'enregistrement d'un message entrant pour une affectation de
   * confort.
   */
  async prendreUnRangDeTourDeRole(tenantId: string, campaignId: string): Promise<number> {
    const res = await this.pool.query<{ rang: number }>(
      `update campaigns set tour_de_role_rang = tour_de_role_rang + 1
        where tenant_id = $1 and id = $2
        returning tour_de_role_rang as rang`,
      [tenantId, campaignId],
    );
    return res.rows[0]?.rang ?? 0;
  }

  /**
   * Fait avancer un destinataire à l'étage `rang` : il repart `pending`, le prochain run le reprend.
   *
   * `etage_courant < $2` est le verrou : deux balayages qui se chevauchent basculeraient deux fois (deux runs
   * pour un échec) ; l'étage ne reculant jamais, la seconde écriture ne touche rien. `retry_count` n'est pas
   * incrémenté : une bascule n'est pas un réessai.
   *
   * Elle efface l'erreur, le `message_id` et l'état de livraison comme `resetForRetry` : sinon un accusé Meta
   * tardif sur l'ancien identifiant réécrirait `delivery_status = 'failed'` pendant l'envoi du nouvel étage.
   */
  async basculerEtage(id: string, rang: number): Promise<boolean> {
    const res = await this.pool.query(
      `update campaign_recipients set etage_courant = $2, status = 'pending', retried_at = now(),
         error = null, error_code = null, message_id = null, delivery_status = null, delivery_error = null,
         delivery_updated_at = null, claimed_at = null
       where id = $1 and etage_courant < $2 and (status = 'failed' or delivery_status = 'failed')`,
      [id, rang],
    );
    return (res.rowCount ?? 0) === 1;
  }

  /**
   * Remet un destinataire en `pending` pour une auto-relance : incrémente retry_count, pose retried_at, efface
   * l'erreur (le prochain run le renvoie avec ses resolved_params). Atomique (`where status='failed'`).
   */
  async resetForRetry(id: string): Promise<boolean> {
    // Efface aussi l'état de livraison et l'ancien message_id : sinon le compteur d'échecs resterait faux, et
    // une redélivrance tardive du webhook Meta (at-least-once) sur l'ancien wamid réécrirait `delivery_status =
    // 'failed'` pendant la relance (`updateDeliveryByMessageId` filtre sur message_id).
    const res = await this.pool.query(
      `update campaign_recipients set status = 'pending', retry_count = retry_count + 1, retried_at = now(),
         error = null, error_code = null, message_id = null, delivery_status = null, delivery_error = null, delivery_updated_at = null, claimed_at = null
       where id = $1 and (status = 'failed' or delivery_status = 'failed')`,
      [id],
    );
    return (res.rowCount ?? 0) === 1;
  }

  /** Marque un destinataire injoignable traité (second 131026) : retry_count=2, terminal. À appeler après le
   *  flag HubSpot et la note de joignabilité, tous deux réussis. Atomique sur l'état attendu (131026, retry_count=1). */
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

  /**
   * Comme listContactsForBuild mais bornée à des ids précis (la console, liste explicite). L'API publique lit
   * les bloqués aussi (`listContactsPourEnvoiApi`), pour les écarter avec le motif `blocked_contact`.
   */
  async listContactsForBuildByIds(tenantId: string, ids: string[]): Promise<BuildContact[]> {
    if (ids.length === 0) return [];
    const res = await this.pool.query<{
      id: string; phone_e164: string | null; bsuid: string | null; profile_name: string | null;
      fields: Record<string, unknown>; opt_in_status: 'opted_in' | 'opted_out' | 'unknown';
    }>(
      `select id, phone_e164, bsuid, profile_name, fields, opt_in_status
       -- Un contact bloqué n'est pas un destinataire d'une campagne de la console : filtré ici, avant le build.
       -- L'API publique lit les bloqués (listContactsPourEnvoiApi) pour les écarter avec leur motif
       -- (trierDestinataires, blocked_contact) : elle ne les atteint pas davantage.
       from contacts where tenant_id = $1 and deleted_at is null and blocked_at is null and id = any($2::uuid[])`,
      [tenantId, ids],
    );
    return res.rows.map((r) => ({
      id: r.id, phone_e164: r.phone_e164, bsuid: r.bsuid, profile_name: r.profile_name, fields: r.fields, optInStatus: r.opt_in_status,
    }));
  }

  /**
   * Les contacts d'un envoi de l'API publique, bloqués compris, avec ce qui les écarte. Elle ne filtre pas
   * `blocked_at` : l'API doit dire qu'un contact est bloqué, sinon il est compté puis perdu en silence. Une
   * fiche supprimée reste absente (la route l'écarte `unknown_contact`).
   */
  async listContactsPourEnvoiApi(tenantId: string, ids: string[]): Promise<ContactEnvoi[]> {
    if (ids.length === 0) return [];
    const res = await this.pool.query<{
      id: string; phone_e164: string | null; bsuid: string | null; profile_name: string | null;
      fields: Record<string, unknown>; opt_in_status: 'opted_in' | 'opted_out' | 'unknown';
      bloque: boolean; rcs_desabonne: boolean;
    }>(
      `select id, phone_e164, bsuid, profile_name, fields, opt_in_status,
              blocked_at is not null as bloque, rcs_optout_at is not null as rcs_desabonne
         from contacts
        where tenant_id = $1 and deleted_at is null and id = any($2::uuid[])`,
      [tenantId, ids],
    );
    return res.rows.map((r) => ({
      id: r.id, phone_e164: r.phone_e164, bsuid: r.bsuid, profile_name: r.profile_name, fields: r.fields,
      optInStatus: r.opt_in_status, bloque: r.bloque, rcsDesabonne: r.rcs_desabonne,
    }));
  }

  /**
   * Un envoi de l'API, tel que `GET /v1/sends/{sendId}` le décrit. null si absent ou d'un autre espace.
   *
   * 🔴 Trois requêtes, toutes tenues à l'espace : l'en-tête filtre `c.tenant_id = $2`, et les deux lectures de
   * destinataires joignent la campagne sur ce même espace. Mêmes définitions que les compteurs de la console
   * (`summarySelect`, `RECIPIENT_FAILED_SQL`).
   */
  async lireEnvoiApi(campaignId: string, tenantId: string): Promise<EnvoiApiBrut | null> {
    const tete = await this.pool.query<{
      id: string; status: CampaignStatus; created_at: Date; channel: string; name: string; template_name: string | null; template_language: string | null;
      start_node_id: string | null; workflow_code: string | null; graph: WorkflowGraph | null;
    }>(
      `select c.id, c.status, c.created_at, c.channel, c.name, c.template_name, c.template_language, c.start_node_id,
              w.code as workflow_code, w.graph
         from campaigns c
         left join workflows w on w.id = c.workflow_id and w.tenant_id = c.tenant_id
        where c.id = $1 and c.tenant_id = $2`,
      [campaignId, tenantId],
    );
    const t = tete.rows[0];
    if (!t) return null;
    const compte = await this.pool.query<{ total: string; pending: string; sending: string; sent: string; failed: string; skipped: string }>(
      `select count(r.id) as total,
              count(r.id) filter (where r.status = 'pending') as pending,
              count(r.id) filter (where r.status = 'sending') as sending,
              count(r.id) filter (where r.status = 'sent' and r.delivery_status is distinct from 'failed') as sent,
              count(r.id) filter (where ${RECIPIENT_FAILED_SQL}) as failed,
              count(r.id) filter (where r.status = 'skipped') as skipped
         from campaign_recipients r
         join campaigns c on c.id = r.campaign_id and c.tenant_id = $2
        where r.campaign_id = $1`,
      [campaignId, tenantId],
    );
    const k = compte.rows[0];
    const dest = await this.pool.query<{
      contact_id: string; external_id: string | null; status: string; message_id: string | null; error: string | null;
      error_code: number | null; sent_at: Date | null; delivery_status: string | null; delivery_error: string | null;
      etage_courant: number; canal_etage: string | null;
    }>(
      // Même ordre que le détail de la console (`order by status, id`) : une liste tronquée garde un sens.
      `select r.contact_id, ct.external_id, r.status, r.message_id, r.error, r.error_code, r.sent_at,
              r.delivery_status, r.delivery_error, r.etage_courant, e.canal as canal_etage
         from campaign_recipients r
         join campaigns c on c.id = r.campaign_id and c.tenant_id = $2
         left join contacts ct on ct.id = r.contact_id and ct.tenant_id = $2
         left join campaign_etages e on e.campaign_id = c.id and e.rang = r.etage_courant
        where r.campaign_id = $1
        order by r.status, r.id
        limit 500`,
      [campaignId, tenantId],
    );
    return {
      id: t.id,
      status: t.status,
      createdAt: t.created_at.toISOString(),
      // Deux valeurs en base (0056) ; toute autre retombe sur WhatsApp, le défaut de la colonne.
      channel: t.channel === 'rcs' ? 'rcs' : 'whatsapp',
      name: t.name,
      templateName: t.template_name,
      templateLanguage: t.template_language,
      workflowCode: t.workflow_code,
      startNodeId: t.start_node_id,
      graph: t.graph,
      counts: {
        pending: Number(k?.pending ?? 0),
        sending: Number(k?.sending ?? 0),
        sent: Number(k?.sent ?? 0),
        failed: Number(k?.failed ?? 0),
        skipped: Number(k?.skipped ?? 0),
      },
      recipientsTotal: Number(k?.total ?? 0),
      recipients: dest.rows.map((r) => ({
        contactId: r.contact_id,
        externalId: r.external_id,
        rang: r.etage_courant,
        // Trois valeurs en base (CHECK de 0134) ; toute autre est rendue inconnue plutôt qu'inventée.
        canalEtage: r.canal_etage === 'whatsapp' || r.canal_etage === 'rcs' || r.canal_etage === 'email' ? r.canal_etage : null,
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
       -- Même raison que ci-dessus : bloqué = plus jamais destinataire d'une campagne.
       from contacts where tenant_id = $1 and deleted_at is null and blocked_at is null`,
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
   * Un contact prêt pour buildRecipients, résolu par son `wa_id` (campagne au fil de l'eau : un arrivant à la
   * fois). Mêmes exclusions que la liste complète et même fragment de résolution que l'inbox
   * (`MATCH_BY_WAID_SQL`) : un contact est reconnu à l'identique quelle que soit la porte d'entrée.
   */
  async contactForBuildByWaId(tenantId: string, waId: string): Promise<BuildContact | null> {
    const res = await this.pool.query<{
      id: string;
      phone_e164: string | null;
      bsuid: string | null;
      profile_name: string | null;
      fields: Record<string, unknown>;
      opt_in_status: 'opted_in' | 'opted_out' | 'unknown';
    }>(
      `select id, phone_e164, bsuid, profile_name, fields, opt_in_status
       from contacts
       where tenant_id = $1 and deleted_at is null and blocked_at is null
       ${MATCH_BY_WAID_SQL}`,
      [tenantId, waId],
    );
    const r = res.rows[0];
    return r
      ? { id: r.id, phone_e164: r.phone_e164, bsuid: r.bsuid, profile_name: r.profile_name, fields: r.fields, optInStatus: r.opt_in_status }
      : null;
  }

  /**
   * Les campagnes vivantes nourries par ce webhook. `running` uniquement : une campagne en pause, terminée ou
   * jamais lancée ne prend pas les arrivants, c'est ce qui rend « Arrêter » efficace.
   */
  async listRunningByWebhook(tenantId: string, webhookId: string): Promise<Campaign[]> {
    const res = await this.pool.query<{ id: string }>(
      `select id from campaigns
       where tenant_id = $1 and webhook_id = $2 and status = 'running'
       order by created_at`,
      [tenantId, webhookId],
    );
    // Relecture par `getCampaign` : une seule projection de campagne, aucune colonne décisive ne peut manquer.
    const out: Campaign[] = [];
    for (const r of res.rows) {
      const c = await this.getCampaign(r.id);
      if (c) out.push(c);
    }
    return out;
  }

  /**
   * Les campagnes gelées : `running`, du travail en attente, et aucun run vivant. Un déploiement tue le worker
   * en plein envoi ; sans ce balayage, la campagne resterait `running` et plus rien ne la reprendrait.
   *
   * « Aucun run vivant » se lit sur le verrou d'exécution (`campaign_run_locks`), dont le bail court expire en
   * deux minutes après la mort d'un process. Couvre aussi les campagnes au fil de l'eau.
   */
  async listCampagnesGelees(): Promise<Array<{ id: string; tenantId: string; ratePerMinute: number | null; pendingCount: number }>> {
    const res = await this.pool.query<{ id: string; tenant_id: string; rate_per_minute: number | null; pending: string }>(
      `select c.id, c.tenant_id, c.rate_per_minute,
              (select count(*) from campaign_recipients r where r.campaign_id = c.id and r.status = 'pending')::text as pending
       from campaigns c
       where c.status = 'running'
         and exists (select 1 from campaign_recipients r where r.campaign_id = c.id and r.status = 'pending')
         and not exists (select 1 from campaign_run_locks l where l.campaign_id = c.id and l.expires_at > now())`,
    );
    return res.rows.map((r) => ({ id: r.id, tenantId: r.tenant_id, ratePerMinute: r.rate_per_minute, pendingCount: Number(r.pending) }));
  }

  /**
   * Ferme une campagne au fil de l'eau : elle cesse de prendre les arrivants. `completed` et pas `paused` :
   * c'est un arrêt décidé, « Reprendre » n'aurait ici aucun sens. Bornée aux statuts vivants et au tenant :
   * false = rien de fermé (déjà arrêtée, ou pas la sienne).
   */
  async stopWebhookCampaign(campaignId: string, tenantId: string): Promise<boolean> {
    const res = await this.pool.query(
      `update campaigns set status = 'completed'
       where id = $1 and tenant_id = $2 and webhook_id is not null and status in ('running', 'paused', 'scheduled')`,
      [campaignId, tenantId],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /**
   * Arrête une campagne en cours d'envoi. Bornée à `running` et au tenant : false = rien fait. Le run en vol le
   * voit à sa prochaine relecture de statut et sort ; les destinataires non traités restent `pending`.
   * `paused` et pas `completed` : une suspension, « Reprendre » repart là où on s'est arrêté (contrairement à
   * `stopWebhookCampaign`, arrêt définitif).
   */
  async pauseCampaign(campaignId: string, tenantId: string): Promise<boolean> {
    const res = await this.pool.query(
      `update campaigns set status = 'paused' where id = $1 and tenant_id = $2 and status = 'running'`,
      [campaignId, tenantId],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /**
   * Lève la pause avant d'enfiler le run de reprise, sinon le job refuserait de démarrer une campagne en pause.
   * Bornée à `paused` : ailleurs c'est un no-op, l'appeler sans condition est sûr.
   */
  async resumeCampaign(campaignId: string, tenantId: string): Promise<boolean> {
    const res = await this.pool.query(
      // Les deux colonnes de pause sont effacées : une campagne relancée à la main ne doit pas garder une
      // échéance qui la ferait reprendre une seconde fois par le balayage.
      `update campaigns set status = 'running', pause_reason = null, paused_until = null
        where id = $1 and tenant_id = $2 and status = 'paused'`,
      [campaignId, tenantId],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /**
   * Reprend les campagnes dont la pause à échéance est arrivée à terme. Rend celles réellement reprises.
   *
   * Réclamation atomique : l'`update ... returning` prend et rend dans la même instruction, deux balayages
   * concurrents ne reprennent pas la même campagne. Seuls `debit` et `hors_horaires` repartent seuls ; la
   * qualité n'a pas d'échéance, et la nommer ici protège d'une ligne mal formée (relancer peut coûter le
   * numéro).
   *
   * Ce `where` est le contrat de l'index partiel `campaigns_reprise_idx` : les deux listes de motifs doivent
   * rester identiques, sinon le balayage parcourt la table des campagnes chaque minute, sans erreur.
   */
  async reprendreCampagnesDues(limite = 50): Promise<Array<{ id: string; tenantId: string }>> {
    const res = await this.pool.query<{ id: string; tenant_id: string }>(
      `update campaigns set status = 'running', pause_reason = null, paused_until = null
        where id in (
          select id from campaigns
           where status = 'paused' and pause_reason in ('debit', 'hors_horaires')
             and paused_until is not null and paused_until <= now()
           order by paused_until asc
           limit $1
           for update skip locked
        )
       returning id, tenant_id`,
      [Math.max(1, limite)],
    );
    return res.rows.map((r) => ({ id: r.id, tenantId: r.tenant_id }));
  }

  /**
   * Une campagne encore vivante se nourrit-elle de ce webhook ? Interroge la suppression d'un webhook : la
   * laisser passer ferait une campagne « en cours » qui ne recevrait plus jamais rien.
   */
  async webhookFeedsLiveCampaign(tenantId: string, webhookId: string): Promise<string | null> {
    const res = await this.pool.query<{ name: string }>(
      `select name from campaigns
       where tenant_id = $1 and webhook_id = $2 and status in ('draft', 'scheduled', 'running', 'paused')
       limit 1`,
      [tenantId, webhookId],
    );
    return res.rows[0]?.name ?? null;
  }

  /**
   * Crée la campagne et ses destinataires dans une transaction : un échec en cours de route
   * ne laisse pas de campagne draft orpheline avec des destinataires partiels.
   */
  async createWithRecipients(
    input: CreateCampaignInput,
    recipients: BuiltRecipient[],
  ): Promise<{ campaignId: string; recipientCount: number }> {
    return enTransaction(this.pool, async (client) => {
      const campaignId = await insertCampaignRow(client, input);
      const inserted = await bulkInsertRecipients(client, campaignId, recipients);
      return { campaignId, recipientCount: inserted };
    });
  }

  /** Insère les destinataires (idempotent par (campaign_id, contact_id)). Retourne le nb inséré. */
  async insertRecipients(campaignId: string, recipients: BuiltRecipient[]): Promise<number> {
    return bulkInsertRecipients(this.pool, campaignId, recipients);
  }

  /**
   * Un arrivant d'une campagne au fil de l'eau. L'unicité `(campaign_id, contact_id)` fait tout le travail :
   * la même personne qui repasse par le webhook ne reçoit pas le message deux fois. `false` = déjà
   * destinataire. `skipped` (écarté par `buildRecipients`) est inscrit quand même, avec son motif.
   */
  async insertWebhookRecipient(
    campaignId: string,
    r: { contactId: string; toE164: string; resolvedParams: string[]; statut: 'pending' | 'skipped'; motif?: string },
  ): Promise<boolean> {
    const res = await this.pool.query(
      `insert into campaign_recipients (campaign_id, contact_id, to_e164, resolved_params, status, error)
       values ($1, $2, $3, $4::jsonb, $5, $6)
       on conflict (campaign_id, contact_id) do nothing`,
      [campaignId, r.contactId, r.toE164, JSON.stringify(r.resolvedParams), r.statut, r.motif ?? null],
    );
    return (res.rowCount ?? 0) > 0;
  }
}

/**
 * Insert d'une campagne, seule définition des colonnes écrites (client transactionnel de
 * `createWithRecipients` ou pool de `insertCampaign`) : une nouvelle colonne se pose ici, et les deux chemins
 * la portent.
 */
async function insertCampaignRow(q: Pool | PoolClient, input: CreateCampaignInput): Promise<string> {
  // Campagne workflow : pas de template propre -> template_name/language null + workflow_id posé.
  const isWorkflow = !!input.workflowId;
  /**
   * Le contenu, calculé une fois pour les deux écritures : ces valeurs partent dans `campaigns` et dans
   * l'étage 1 de `campaign_etages`, et doivent être les mêmes.
   */
  const canal: CanalEtage = input.channel ?? 'whatsapp';
  const templateName = isWorkflow ? null : input.templateName;
  const templateLanguage = isWorkflow ? null : input.templateLanguage;
  const rcsMessage = input.rcsMessage === undefined ? null : JSON.stringify(input.rcsMessage);
  const res = await q.query<{ id: string }>(
    `insert into campaigns
       (tenant_id, phone_number_id, name, category, template_name, template_language, param_mapping, workflow_id, rate_per_minute, start_node_id, channel, rcs_agent_id, rcs_message, webhook_id, business_hours_only, reessayer, rattrapage_hors_horaires, assignation, assignation_user_id, reessai_par_campagne)
     values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12, $13::jsonb, $14, $15, $16, $17, $18, $19, $20)
     returning id`,
    [
      input.tenantId,
      // Campagne RCS : aucun numéro Meta, null plutôt que ''.
      input.phoneNumberId === '' ? null : input.phoneNumberId,
      input.name,
      input.category,
      templateName,
      templateLanguage,
      JSON.stringify(input.paramMapping),
      input.workflowId ?? null,
      input.ratePerMinute ?? null,
      // start_node_id n'a de sens qu'avec un workflow : sans lui, on force null (pas de campagne bâtarde).
      isWorkflow ? input.startNodeId ?? null : null,
      canal,
      input.rcsAgentId ?? null,
      rcsMessage,
      input.webhookId ?? null,
      input.businessHoursOnly === true,
      /**
       * Les réglages de l'assistant, écrits ici et nulle part ailleurs (lus par la bascule et l'assignation).
       * `?? true` et `?? false` reproduisent les défauts de la table : une création qui ne dit rien obtient ce
       * qu'elle obtenait avant.
       */
      input.reessayer ?? true,
      input.rattrapageHorsHoraires ?? false,
      input.assignation ?? null,
      // L'identifiant ne survit qu'avec `personne` : sinon une personne désignée que plus rien ne lit.
      input.assignation === 'personne' ? input.assignationUserId ?? null : null,
      /**
       * La campagne obéit à sa case « Réessayer » seulement si la création l'a exprimée. La console transmet
       * toujours son choix, l'API publique jamais : un `true` en dur ferait relancer chaque envoi de l'API
       * (131049 renvoyé, contact marqué injoignable dans HubSpot) sans que personne l'ait choisi. Sans choix,
       * la règle de l'espace s'applique.
       */
      input.reessayer !== undefined,
    ],
  );
  const id = res.rows[0]?.id;
  if (!id) throw new Error('insertCampaignRow : aucun id retourné');

  /**
   * La chaîne. Absente = un seul étage, celui de la campagne.
   *
   * Le rang 1 ne vient jamais de la chaîne reçue mais des colonnes de `campaigns`, que `contenuDeLEtage` lit
   * pour lui : recopier le contenu du premier étage du client ouvrirait deux vérités (la nôtre part, la sienne
   * est journalisée). Les rangs sont renumérotés, pas crus : le CHECK et la clé primaire trancheraient en 5xx.
   *
   * `on conflict do nothing` garde la ligne idempotente si la fonction est rejouée. Les deux écritures sont dans
   * la même transaction sur les deux chemins : une campagne sans ses étages ne peut être servie par aucun run.
   */
  const etages: Etage[] = input.chaine && input.chaine.length > 0
    ? normaliserChaine(input.chaine).map((e) => (e.rang === RANG_INITIAL
      ? { rang: RANG_INITIAL, canal, ...(templateName !== null && templateName !== undefined ? { templateName } : {}),
          ...(templateLanguage !== null && templateLanguage !== undefined ? { templateLanguage } : {}),
          ...(input.rcsMessage !== undefined ? { rcsMessage: input.rcsMessage } : {}),
          ...(input.workflowId ? { workflowId: input.workflowId } : {}),
          ...(input.devenir ? { devenir: input.devenir } : {}) }
      : e))
    : [{
      rang: RANG_INITIAL, canal,
      ...(templateName !== null && templateName !== undefined ? { templateName } : {}),
      ...(templateLanguage !== null && templateLanguage !== undefined ? { templateLanguage } : {}),
      ...(input.rcsMessage !== undefined ? { rcsMessage: input.rcsMessage } : {}),
      ...(input.workflowId ? { workflowId: input.workflowId } : {}),
      ...(input.devenir ? { devenir: input.devenir } : {}),
    }];
  // Une seule requête pour toute la chaîne (`unnest`), comme `bulkInsertRecipients` : pas d'allers-retours au
  // milieu d'une transaction.
  await q.query(
    `insert into campaign_etages (campaign_id, rang, canal, template_name, template_language, rcs_message, email_template_id, email_champ, workflow_id, devenir)
     select $1, r, c, tn, tl, rm::jsonb, et::uuid, ec, wf::uuid, dv
     from unnest($2::smallint[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[], $10::text[]) as u(r, c, tn, tl, rm, et, ec, wf, dv)
     on conflict (campaign_id, rang) do nothing`,
    [
      id,
      etages.map((e) => e.rang),
      etages.map((e) => e.canal),
      // `?? null` et non `|| null` : une chaîne vide (campagne RCS, `templateName: ''`) doit rester ce que la
      // table porte déjà.
      etages.map((e) => e.templateName ?? null),
      etages.map((e) => e.templateLanguage ?? null),
      etages.map((e) => (e.rcsMessage === undefined ? null : JSON.stringify(e.rcsMessage))),
      etages.map((e) => e.emailTemplateId ?? null),
      etages.map((e) => e.emailChamp ?? null),
      etages.map((e) => e.workflowId ?? null),
      etages.map((e) => e.devenir ?? null),
    ],
  );
  return id;
}

/**
 * Insert bulk des destinataires en une requête (`unnest`). Idempotent par (campaign_id, contact_id) ; rend le
 * nombre réellement inséré. Fonctionne avec un client transactionnel comme avec le pool.
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
  // null (et pas '{}') pour un destinataire sans variables : « il n'en porte pas » reste distinguable d'un
  // objet vide.
  const variables = recipients.map((r) => (r.variables ? JSON.stringify(r.variables) : null));
  const res = await q.query(
    `insert into campaign_recipients (campaign_id, contact_id, to_e164, resolved_params, variables)
     select $1, c, t, p::jsonb, v::jsonb
     from unnest($2::uuid[], $3::text[], $4::text[], $5::text[]) as u(c, t, p, v)
     on conflict (campaign_id, contact_id) do nothing`,
    [campaignId, contactIds, toE164s, params, variables],
  );
  return res.rowCount ?? 0;
}

export class PgCampaignStore implements CampaignStore {
  constructor(private readonly pool: Pool) {}
  async setStatus(
    campaignId: string,
    status: CampaignStatus,
    pause?: { raison: MotifDePause; reprise: Date | null },
  ): Promise<void> {
    // Les deux colonnes de pause sont toujours écrites, à null sans `pause` : une campagne repartie garderait
    // sinon l'échéance de sa pause d'avant, et le balayage la reprendrait une seconde fois.
    await this.pool.query(
      `update campaigns set status = $2, pause_reason = $3, paused_until = $4 where id = $1`,
      [campaignId, status, pause?.raison ?? null, pause?.reprise ?? null],
    );
  }

  /** Statut courant, scopé tenant. Sert au run pour voir qu'un opérateur l'a mis en pause. */
  async getStatus(campaignId: string, tenantId: string): Promise<CampaignStatus | null> {
    const res = await this.pool.query<{ status: CampaignStatus }>(
      `select status from campaigns where id = $1 and tenant_id = $2`,
      [campaignId, tenantId],
    );
    return res.rows[0]?.status ?? null;
  }
}

export class PgRecipientStore implements RecipientStore, DeliveryStore {
  /**
   * Destinataires réservés mais pas encore résolus (`sending`) : le moteur ne déclare pas une campagne terminée
   * tant qu'il en reste, sinon un worker tué en plein envoi laisserait un destinataire que le reclaim remet en
   * `pending` sur une campagne que plus aucune reprise ne regarde.
   */
  async countSending(campaignId: string): Promise<number> {
    const res = await this.pool.query<{ n: string }>(
      `select count(*)::text as n from campaign_recipients where campaign_id = $1 and status = 'sending'`,
      [campaignId],
    );
    return Number(res.rows[0]?.n ?? 0);
  }

  constructor(private readonly pool: Pool) {}

  /**
   * Applique un statut de livraison Meta (par message_id), en monotone : sent -> delivered -> read ne régresse
   * jamais, `failed` s'applique toujours. Rend le nombre de destinataires touchés (0 si le wamid n'est pas à
   * nous).
   *
   * Elle met à jour `campaign_recipients` et le journal `campaign_envois` dans la même instruction : le premier
   * ne garde que la dernière tentative, et sans le second le funnel par canal attribuerait l'accusé au mauvais
   * canal ou n'en verrait aucun. Une seule instruction, donc les deux tables ne peuvent pas diverger ; la règle
   * de monotonie est la même des deux côtés. Le compte rendu reste celui des destinataires (`maj`).
   */
  async updateDeliveryByMessageId(messageId: string, status: DeliveryStatus, error: string | null, errorCode: number | null): Promise<number> {
    const res = await this.pool.query<{ n: number }>(
      `with maj as (
         update campaign_recipients
         set delivery_status = $2, delivery_error = $3, delivery_updated_at = now(),
             error_code = $4::integer
         where message_id = $1 and (
           $2 = 'failed'
           or (case $2 when 'read' then 3 when 'delivered' then 2 when 'sent' then 1 else 0 end)
              > (case delivery_status when 'read' then 3 when 'delivered' then 2 when 'sent' then 1 else 0 end)
         )
         returning 1 as touche
       ),
       journal as (
         update campaign_envois
         set delivery_status = $2
         where message_id = $1 and (
           $2 = 'failed'
           or (case $2 when 'read' then 3 when 'delivered' then 2 when 'sent' then 1 else 0 end)
              > (case delivery_status when 'read' then 3 when 'delivered' then 2 when 'sent' then 1 else 0 end)
         )
         returning 1 as touche
       )
       select (select count(*) from maj)::int as n`,
      [messageId, status, error, errorCode],
    );
    // `rowCount` ne convient pas : l'énoncé rend toujours une ligne (le `select` final). C'est le compte porté
    // par cette ligne qui répond.
    return Number(res.rows[0]?.n ?? 0);
  }

  async listPending(campaignId: string): Promise<Recipient[]> {
    const res = await this.pool.query<{
      id: string;
      contact_id: string;
      to_e164: string;
      resolved_params: string[];
      status: Recipient['status'];
      etage_courant: number;
      variables: Record<string, string> | null;
    }>(
      // `etage_courant` est relu ici parce que c'est le moteur qui décide quoi envoyer : sans lui, le run
      // repartirait sur le contenu du rang 1. La colonne est `not null default 1`.
      `select id, contact_id, to_e164, resolved_params, status, etage_courant, variables
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
      etageCourant: r.etage_courant,
      variables: r.variables,
    }));
  }

  /**
   * Claim atomique pending -> sending (rowCount=1 si ce run réserve, 0 si déjà pris).
   *
   * 🔴 Elle relit la fiche au moment d'envoyer : un STOP ou un blocage posé depuis la construction de la liste
   * rend `{ ecart }`, que le moteur marque `skipped`. Le destinataire est réservé quand même, ce qui garantit
   * qu'un seul run l'écarte. Le STOP prime sur le blocage.
   *
   * La sous-requête lit une fiche par sa clé primaire. Une fiche disparue rend `null` : le moteur envoie. Le
   * `contact_id` vient d'une liste construite sur l'espace de la campagne, aucune fiche d'un autre espace n'y
   * est lue.
   */
  async claim(id: string): Promise<boolean | { ecart: EcartALEnvoi }> {
    const res = await this.pool.query<{ ecart: EcartALEnvoi | null }>(
      `update campaign_recipients set status = 'sending', claimed_at = now()
       where id = $1 and status = 'pending'
       returning (select case when c.opt_in_status = 'opted_out' then 'desabonne'
                              when c.blocked_at is not null then 'bloque' end
                    from contacts c where c.id = campaign_recipients.contact_id) as ecart`,
      [id],
    );
    if ((res.rowCount ?? 0) !== 1) return false;
    const ecart = res.rows[0]?.ecart ?? null;
    return ecart === null ? true : { ecart };
  }

  /**
   * Sweeper : ramène à `pending` les destinataires bloqués en `sending` depuis plus de `olderThanMs` (crash
   * entre le claim et l'envoi). Si l'envoi avait réussi mais pas sa persistance, ce reclaim peut renvoyer
   * (rare) : compromis assumé face à un destinataire figé à vie.
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

  /**
   * Rend un destinataire réservé à la file, l'inverse de `claim`, quand le refus vise le numéro (plafond de
   * numéro, numéro délié) : le compter en échec le rendrait injoignable, le laisser `sending` le ferait
   * attendre le balayage de récupération. Scopé sur `status = 'sending'` : jamais un destinataire déjà résolu.
   */
  async relacher(id: string): Promise<void> {
    await this.pool.query(
      `update campaign_recipients set status = 'pending', claimed_at = null where id = $1 and status = 'sending'`,
      [id],
    );
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
