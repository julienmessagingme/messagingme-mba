import type { Pool } from 'pg';
import { horsEntreeGratuite } from '../stats/entree-gratuite';
import { journaliser } from '../lib/journal';
import { analyseDeLaLigne, COLONNES_ANALYSE_FICHE, type LigneAnalyseFiche } from '../analysis/fiche';

/**
 * Historique d'un contact : ce qu'on lui a envoyé, et ce qu'il a échangé avec nous. Store de lecture seule.
 *
 * Deux règles de jointure :
 *  - les envois se relient par `campaign_recipients.contact_id`, jamais par le numéro : `to_e164` est figé à la
 *    construction de la campagne, et un contact qui change de numéro perdrait son passé ;
 *  - les conversations ne se relient pas par `contact_id` seul : nullable et posé en `coalesce`, il reste null
 *    sur une conversation ouverte avant la création du contact. On rattrape par `wa_id` (numéro en chiffres
 *    nus, ou BSUID brut), comme l'inbox ; un contact peut donc avoir plusieurs conversations.
 */

export interface ContactSend {
  campaignId: string;
  campaignName: string;
  category: string;
  /** null quand la campagne envoie un scénario au lieu d'un template (migration 0024). */
  templateName: string | null;
  templateLanguage: string | null;
  /** Nom du scénario envoyé, quand il n'y a pas de template. */
  workflowName: string | null;
  /** Statut du destinataire : pending | sending | sent | failed | skipped. */
  status: string;
  sentAt: string | null;
  error: string | null;
  /**
   * Dernier état de livraison connu : sent < delivered < read, ou failed. NULL sur un envoi réussi dont le
   * webhook de statut n'est jamais arrivé veut dire « statut inconnu », jamais « non délivré ». Un seul
   * horodatage : celui du dernier changement.
   */
  deliveryStatus: string | null;
  deliveryUpdatedAt: string | null;
  /**
   * La personne a-t-elle réagi à cet envoi : répondu, appuyé sur un bouton, ou cliqué sur un lien du message.
   * Ce n'est pas « lu » (Meta a affiché le message) : « engagé » dit qu'un humain a fait quelque chose. Le clic
   * compte parce qu'un bouton URL fait sortir le contact sans message entrant. Bornes : après l'envoi, avant le
   * prochain envoi à ce contact, et dans les 24 h.
   */
  engage: boolean;
}

export interface ContactConversationAnalysis {
  sentiment: string;
  intent: string;
  topic: string;
  resolved: boolean;
  handledBy: string;
  exchangesCount: number;
  actionSuggestion: string;
  /** Date de la dernière analyse (upsert sur la clé primaire), pas la date de la conversation. */
  analyzedAt: string;
  /**
   * Ce qui s'est dit, en deux ou trois phrases. `null` est un cas normal (analyses anciennes, sans résumé) et ne
   * veut pas dire « conversation vide » : l'écran le dit (`web/lib/resume-conversation.ts`). Ne se substitue pas à
   * `justification`, qui explique le classement et non ce qui s'est dit.
   */
  summary: string | null;
}

/**
 * La dernière analyse du contact, lue sur sa FICHE (colonnes `analyse_*`, migration 0196) : la section « Dernière
 * analyse » de l'onglet Fiche. Elle survit à l'effacement de la conversation (décision du 2026-09-30).
 */
export interface DerniereAnalyseFiche {
  intention: string;
  sentiment: string;
  /** `null` = pas de mesure, jamais 0. */
  satisfaction: number | null;
  urgence: number | null;
  resolue: boolean;
  sujet: string;
  traiteePar: string;
  action: string;
  analyseLe: string;
  /** Un message des fils du contact, entrant ou sortant, est plus récent que le dernier message couvert par l'analyse. */
  perimee: boolean;
}

/**
 * Le résumé affiché comme champ de base du mini-CRM.
 * 🔴 Dérivé à la lecture, jamais recopié dans la fiche : il porte les propos du client, et la purge de rétention
 * efface la conversation et son analyse en cascade ; une copie survivrait au-delà de la durée promise. Les CODES
 * de l'analyse, eux, sont recopiés sur la fiche, délibérément (colonnes `analyse_*`, 0196) : ce sont des constats,
 * pas des propos. Ce n'est pas non plus une variable de message : `contactVars` sert les campagnes (une jointure
 * par destinataire), et envoyer à quelqu'un le résumé de sa propre conversation ne doit pas être possible en un
 * clic.
 */
export interface ResumeContact {
  /**
   * Le texte du résumé, `null` quand il n'y en a pas ; `conversations` et `analysee` disent pourquoi (sinon on
   * afficherait « pas encore analysée » à un contact sans aucune conversation).
   */
  texte: string | null;
  /** Date de l'analyse qui porte ce résumé. `null` quand aucune conversation n'a été analysée. */
  analyseLe: string | null;
  /** La conversation d'où il vient, pour ouvrir le fil dans l'Inbox. */
  conversationId: string | null;
  /** Combien de conversations ce contact a tenues. `0` = le champ ne s'affiche pas du tout. */
  conversations: number;
  /** Au moins une conversation est analysée. `false` avec `conversations > 0` = analyse en cours ou échouée. */
  analysee: boolean;
  /** Un message est arrivé après l'analyse : le résumé ne couvre pas la fin du fil (même règle qu'`analysisStale`). */
  perime: boolean;
  /** La dernière analyse recopiée sur la fiche, `null` si la fiche n'a jamais été analysée. */
  derniereAnalyse: DerniereAnalyseFiche | null;
}

export interface ContactConversation {
  conversationId: string;
  waId: string;
  lastMessageAt: string;
  lastPreview: string | null;
  messagesCount: number;
  /** pending | queued | done | failed. */
  analysisStatus: string;
  analysis: ContactConversationAnalysis | null;
  /**
   * true quand une analyse existe mais qu'un message est arrivé depuis (statut retombé hors 'done'), pour ne pas
   * afficher une analyse périmée comme fraîche.
   */
  analysisStale: boolean;
  /** Lien vers le fil complet dans l'inbox ; les messages ne sont pas embarqués ici. */
  inboxHref: string;
}

export interface ContactHistory {
  sends: ContactSend[];
  conversations: ContactConversation[];
}

/**
 * Les identités d'un contact, dérivées en SQL (`$1` = tenant, `$2` = contact), à poser en CTE `ct`.
 * 🔴 Jamais fournies par le client : accepter un `wa_id` du front ouvrirait la lecture des conversations de
 * n'importe qui. Les `nullif` évitent qu'une identité absente devienne une chaîne vide servant de critère.
 */
export const CONTACT_IDENTITES_SQL = `select id,
                nullif(regexp_replace(coalesce(phone_e164, ''), '[^0-9]', '', 'g'), '') as digits,
                nullif(bsuid, '') as bsuid
         from contacts where id = $2 and tenant_id = $1`;

/**
 * Le rattachement d'une conversation à un contact (`c` = `conversations`, `ct` = le CTE ci-dessus), partagé par
 * la liste des conversations et le résumé : recopié, il divergerait en silence (le résumé d'une conversation
 * absente de la liste). À citer, jamais à réécrire.
 */
export const CONVERSATION_DU_CONTACT_SQL =
  `(c.contact_id = ct.id or c.wa_id = any(array_remove(array[ct.digits, ct.bsuid], null)))`;

/** Bornes de lecture : un historique d'écran, pas un export. Au-delà, l'inbox et le détail de campagne. */
const MAX_SENDS = 200;
const MAX_CONVERSATIONS = 100;
/** Borne haute de l'export CSV : bien au-delà d'un écran, mais bornée. */
const EXPORT_MAX_SENDS = 5000;

export class PgContactHistoryStore {
  constructor(private readonly pool: Pool) {}

  /** null si le contact n'existe pas pour ce tenant (la route en fait un 404, jamais une liste vide trompeuse). */
  async getContactHistory(tenantId: string, contactId: string): Promise<ContactHistory | null> {
    // 🔴 Le contact est chargé d'abord, scopé tenant : c'est ce qui distingue « aucun historique » (200) de « ce
    // contact n'est pas à toi » (404), au lieu d'un 200 rassurant sur une ressource interdite.
    const owner = await this.pool.query<{ id: string }>(
      `select id from contacts where id = $1 and tenant_id = $2`,
      [contactId, tenantId],
    );
    if (!owner.rows[0]) return null;

    const [sends, conversations] = await Promise.all([
      this.listSends(tenantId, contactId, MAX_SENDS),
      this.listConversations(tenantId, contactId),
    ]);
    return { sends, conversations };
  }

  /**
   * Le résumé de la dernière conversation analysée, pour la ligne « champ de base » de la fiche. `null` si le
   * contact n'est pas dans cet espace (404, même garde que `getContactHistory`).
   * Route à part : l'onglet « Fiche » ne charge pas l'historique, et la liste du mini-CRM ne doit pas payer une
   * sous-requête par ligne. La dernière analysée, pas la dernière qui porte un résumé : remonter plus loin
   * afficherait un texte périmé comme actuel ; sans résumé, l'écran le dit (cas fréquent, pas un repli rare).
   */
  async resumeContact(tenantId: string, contactId: string): Promise<ResumeContact | null> {
    const res = await this.pool.query<LigneAnalyseFiche & {
      connu: boolean; conversations: number; conversation_id: string | null;
      analysis_status: string | null; analyse_resume_le: Date | null; summary: string | null;
      dernier_message_le: Date | null;
    }>(
      // Les deux fragments sont cités, jamais recopiés : leur justification est à leur définition.
      `with ct as (
         ${CONTACT_IDENTITES_SQL}
       ),
       fiche as (
         select ${COLONNES_ANALYSE_FICHE.join(', ')}
           from contacts where id = $2 and tenant_id = $1
       ),
       conv as (
         select c.id, c.last_message_at, c.analysis_status,
                ca.created_at as analyse_le, ca.sentiment, ca.summary
           from conversations c
             cross join ct
             left join conversation_analysis ca on ca.conversation_id = c.id
          where c.tenant_id = $1
            and ${CONVERSATION_DU_CONTACT_SQL}
       ),
       derniere as (
         -- MÊME ORDRE que la liste des conversations de l'onglet Historique : le résumé de la fiche est donc
         -- celui de la PREMIÈRE conversation analysée de cette liste, et les deux écrans ne peuvent pas se
         -- contredire. Trier ici par date d'ANALYSE les ferait diverger dès qu'une vieille conversation est
         -- réanalysée, sans qu'aucune erreur ne le signale.
         --
         -- « Analysée » = une ligne d'analyse existe ET porte un sentiment, exactement le test que fait le
         -- mapping de listConversations. Une seule définition, sinon la fiche et la liste ne compteraient
         -- pas les mêmes conversations comme analysées.
         --
         -- Une fiche qui porte une copie de l analyse (0196) prend le résumé de la MÊME analyse, celle de la
         -- conversation que la copie désigne : les codes et le résumé ne peuvent pas venir de deux analyses. Une
         -- fiche sans copie (analysée avant 0196, pas de reprise) garde la règle ci-dessus, sinon tous les
         -- résumés disparaîtraient le jour du déploiement.
         select id, analysis_status, analyse_le, summary
           from conv
          where analyse_le is not null and sentiment is not null
            and ((select analyse_le from fiche) is null or id = (select analyse_conversation_id from fiche))
          order by last_message_at desc
          limit 1
       )
       select exists (select 1 from ct) as connu,
              (select count(*) from conv)::int as conversations,
              (select id from derniere) as conversation_id,
              (select analysis_status from derniere) as analysis_status,
              (select analyse_le from derniere) as analyse_resume_le,
              (select summary from derniere) as summary,
              (select max(m.created_at) from conv join conversation_messages m on m.conversation_id = conv.id) as dernier_message_le,
              ${COLONNES_ANALYSE_FICHE.map((k) => `(select ${k} from fiche) as ${k}`).join(',\n              ')}`,
      [tenantId, contactId],
    );
    const r = res.rows[0];
    if (!r || !r.connu) return null;
    const analysee = r.analyse_resume_le !== null;
    const copie = analyseDeLaLigne(r);
    return {
      // Chaîne vide = absence, comme à l'écriture et comme dans la liste des conversations.
      texte: analysee && r.summary !== null && r.summary.trim() !== '' ? r.summary : null,
      analyseLe: r.analyse_resume_le ? r.analyse_resume_le.toISOString() : null,
      conversationId: r.conversation_id,
      conversations: r.conversations,
      analysee,
      // Une analyse existe et le statut est reparti hors 'done' -> un message est arrivé depuis (même règle
      // qu'`analysisStale`).
      perime: analysee && r.analysis_status !== 'done',
      derniereAnalyse: copie === null ? null : {
        intention: copie.intention,
        sentiment: copie.sentiment,
        satisfaction: copie.satisfaction,
        urgence: copie.urgence,
        resolue: copie.resolue,
        sujet: copie.sujet,
        traiteePar: copie.traiteePar,
        action: copie.action,
        analyseLe: copie.analyseLe.toISOString(),
        // Le plus récent MESSAGE des fils du contact, comparé à la borne de l'analyse. Jamais `last_message_at`,
        // posé par now() à chaque écriture : toutes les fiches paraîtraient périmées.
        perimee: r.dernier_message_le !== null && r.dernier_message_le > copie.fenetreFin,
      },
    };
  }

  /**
   * La matière du bilan d'un contact : ses envois par catégorie (pour le coût), et la profondeur atteinte
   * parcours par parcours (pour l'entonnoir).
   *  - Un parcours = un envoi de campagne, borné comme `engage` : jusqu'au prochain envoi (`p.fin`), et au plus
   *    24 h. Sans ces bornes, le dernier parcours avalerait la conversation qui suit, ou la campagne suivante.
   *  - Seuls les sortants automatiques comptent comme sollicitation (`sender_user_id is null`, et non `origin`,
   *    nul sur les sortants anciens) : un opérateur qui discute ne fait pas avancer un scénario.
   *  - Une réaction est un entrant ou un clic attribué, comme `engage`. La profondeur est un `max` ;
   *    `entonnoirEngagement` en fait un cumul.
   *  - Les départs sont dédupliqués et bornés à `MAX_SENDS`, la population de la liste d'envois.
   *  - Les envois du coût excluent les 72 h gratuites après un clic sur une pub (`horsEntreeGratuite`), sans
   *    porter les gardes de livraison des autres lectures de coût (écart connu, suivi à part).
   */
  async bilanContact(tenantId: string, contactId: string): Promise<{ envois: Array<{ category: string | null; count: number }>; profondeurs: number[] } | null> {
    const owner = await this.pool.query<{ id: string }>(
      `select id from contacts where id = $1 and tenant_id = $2`,
      [contactId, tenantId],
    );
    if (!owner.rows[0]) return null;

    const [volumes, profondeurs] = await Promise.all([
      this.pool.query<{ category: string | null; count: string }>(
        `select c.category, count(*)::bigint as count
           from campaign_recipients r join campaigns c on c.id = r.campaign_id
          where r.contact_id = $2 and c.tenant_id = $1 and r.sent_at is not null
            and ${horsEntreeGratuite('r.message_id', 'c.tenant_id')}
          group by c.category`,
        [tenantId, contactId],
      ),
      this.pool.query<{ niveau: string }>(
        `with departs as (
           -- 🔴 DISTINCT, ET IL CORRIGE UNE SOUSTRACTION MUETTE. Deux campagnes parties vers le meme contact
           -- a la MEME milliseconde donnaient deux departs identiques, donc une fenetre
           -- [t, lead(t)) = [t, t) VIDE : ce parcours sortait de l entonnoir sans rien signaler. Et c est
           -- aussi plus juste : deux envois simultanes ne font qu UNE sollicitation vue du contact.
           --
           -- ⚠️ BORNE AU MEME PLAFOND QUE LA LISTE D ENVOIS affichee juste en dessous, pour que les deux
           -- moities de l ecran parlent de la meme population. Sans borne, un contact a plusieurs centaines
           -- d envois faisait reparcourir la conversation entiere une fois par parcours.
           select distinct r.sent_at as debut
             from campaign_recipients r join campaigns c on c.id = r.campaign_id
            where r.contact_id = $2 and c.tenant_id = $1 and r.sent_at is not null
            order by 1 desc
            limit $3
         ),
         parcours as (
           select debut, lead(debut) over (order by debut) as fin from departs
         ),
         sollicitations as (
           select p.debut, p.fin, m.created_at,
                  row_number() over (partition by p.debut order by m.created_at, m.id) as rang,
                  lead(m.created_at) over (partition by p.debut order by m.created_at, m.id) as suivante
             from parcours p
             join conversations cv on cv.tenant_id = $1 and cv.contact_id = $2
             join conversation_messages m on m.conversation_id = cv.id
            where m.direction = 'out'
              and m.sender_user_id is null
              and m.created_at >= p.debut
              and m.created_at < least(coalesce(p.fin, 'infinity'::timestamptz), p.debut + interval '24 hours')
         ),
         touchees as (
           select s.debut, s.rang
             from sollicitations s
            where exists (
               select 1 from conversation_messages m2 join conversations cv2 on cv2.id = m2.conversation_id
                where cv2.tenant_id = $1 and cv2.contact_id = $2 and m2.direction = 'in'
                  and m2.created_at > s.created_at
                  and m2.created_at < least(coalesce(s.suivante, s.fin, 'infinity'::timestamptz), s.created_at + interval '24 hours'))
               or exists (
               select 1 from tracked_link_clicks tc
                where tc.tenant_id = $1 and tc.contact_id = $2
                  and tc.at > s.created_at
                  and tc.at < least(coalesce(s.suivante, s.fin, 'infinity'::timestamptz), s.created_at + interval '24 hours'))
         )
         select max(rang)::bigint as niveau from touchees group by debut`,
        [tenantId, contactId, MAX_SENDS],
      ),
    ]);
    return {
      envois: volumes.rows.map((r) => ({ category: r.category, count: Number(r.count) })),
      profondeurs: profondeurs.rows.map((r) => Number(r.niveau)),
    };
  }

  /**
   * Envois d'un contact pour l'export CSV : les mêmes lignes que l'historique d'écran, bornées à EXPORT_MAX_SENDS
   * (journalisé si atteint). null si le contact n'appartient pas au tenant (404 côté route). Scopé tenant en SQL.
   */
  async listSendsForExport(tenantId: string, contactId: string): Promise<ContactSend[] | null> {
    const owner = await this.pool.query<{ id: string }>(
      `select id from contacts where id = $1 and tenant_id = $2`,
      [contactId, tenantId],
    );
    if (!owner.rows[0]) return null;
    const sends = await this.listSends(tenantId, contactId, EXPORT_MAX_SENDS);
    if (sends.length >= EXPORT_MAX_SENDS) {
      journaliser('warn', 'contact_history_export_truncated', { tenantId, contactId, limit: EXPORT_MAX_SENDS });
    }
    return sends;
  }

  private async listSends(tenantId: string, contactId: string, limit: number): Promise<ContactSend[]> {
    const res = await this.pool.query<{
      campaign_id: string; name: string; category: string;
      template_name: string | null; template_language: string | null; workflow_name: string | null;
      status: string; sent_at: Date | null; error: string | null;
      delivery_status: string | null; delivery_updated_at: Date | null; engage: boolean;
    }>(
      // 🔴 `c.tenant_id = $1` en plus du contrôle d'appartenance du contact : double barrière, une campagne d'un
      // autre tenant ne peut pas remonter ici.
      //
      // `engage` : la personne a-t-elle réagi à cet envoi ? Tout entrant compte (texte ou appui de bouton), et le clic
      // attribué sur un lien aussi (un bouton URL fait sortir le contact sans entrant). Deux bornes : 24 h (une
      // réponse trois jours plus tard n'est pas une réaction, et c'est la fenêtre de service), et le prochain envoi
      // (deux campagnes du même jour se créditeraient l'une l'autre). Seuls les clics attribués (`contact_id` non
      // nul) remontent : les liens des anciens templates n'ont pas de jeton et restent anonymes.
      `with envois as (
         select r.contact_id, r.status, r.sent_at, r.error, r.delivery_status, r.delivery_updated_at,
                c.id as campaign_id, c.name, c.category, c.template_name, c.template_language, c.created_at,
                w.name as workflow_name,
                lead(r.sent_at) over (order by r.sent_at) as prochain_envoi
           from campaign_recipients r
             join campaigns c on c.id = r.campaign_id
             left join workflows w on w.id = c.workflow_id
          where r.contact_id = $2 and c.tenant_id = $1
       )
       select e.campaign_id, e.name, e.category, e.template_name, e.template_language, e.workflow_name,
              e.status, e.sent_at, e.error, e.delivery_status, e.delivery_updated_at,
              (e.sent_at is not null and (exists (
                 select 1
                   from conversation_messages m
                   join conversations cv on cv.id = m.conversation_id
                  where cv.tenant_id = $1 and cv.contact_id = e.contact_id
                    and m.direction = 'in'
                    and m.created_at > e.sent_at
                    and m.created_at < least(coalesce(e.prochain_envoi, 'infinity'::timestamptz),
                                             e.sent_at + interval '24 hours')
              ) or exists (
                 select 1
                   from tracked_link_clicks tc
                  where tc.tenant_id = $1 and tc.contact_id = e.contact_id
                    and tc.at > e.sent_at
                    and tc.at < least(coalesce(e.prochain_envoi, 'infinity'::timestamptz),
                                      e.sent_at + interval '24 hours')
              ))) as engage
         from envois e
        order by e.sent_at desc nulls last, e.created_at desc
        limit ${limit}`,
      [tenantId, contactId],
    );
    return res.rows.map((r) => ({
      campaignId: r.campaign_id,
      campaignName: r.name,
      category: r.category,
      templateName: r.template_name,
      templateLanguage: r.template_language,
      workflowName: r.workflow_name,
      status: r.status,
      sentAt: r.sent_at ? r.sent_at.toISOString() : null,
      error: r.error,
      deliveryStatus: r.delivery_status,
      deliveryUpdatedAt: r.delivery_updated_at ? r.delivery_updated_at.toISOString() : null,
      engage: r.engage,
    }));
  }

  private async listConversations(tenantId: string, contactId: string): Promise<ContactConversation[]> {
    const res = await this.pool.query<{
      id: string; wa_id: string; last_message_at: Date; last_preview: string | null;
      analysis_status: string; messages_count: string;
      sentiment: string | null; intent: string | null; topic: string | null; resolved: boolean | null;
      handled_by: string | null; exchanges_count: number | null; action_suggestion: string | null;
      analyzed_row_at: Date | null; summary: string | null;
    }>(
      // Les deux fragments sont cités, jamais recopiés : leur justification est à leur définition.
      `with ct as (
         ${CONTACT_IDENTITES_SQL}
       )
       select c.id, c.wa_id, c.last_message_at, c.last_preview, c.analysis_status,
              (select count(*) from conversation_messages m where m.conversation_id = c.id)::text as messages_count,
              ca.sentiment, ca.intent, ca.topic, ca.resolved, ca.handled_by, ca.exchanges_count,
              ca.action_suggestion, ca.created_at as analyzed_row_at, ca.summary
       from conversations c
         cross join ct
         left join conversation_analysis ca on ca.conversation_id = c.id
       where c.tenant_id = $1
         and ${CONVERSATION_DU_CONTACT_SQL}
       order by c.last_message_at desc
       limit ${MAX_CONVERSATIONS}`,
      [tenantId, contactId],
    );
    return res.rows.map((r) => {
      const analysis: ContactConversationAnalysis | null =
        r.analyzed_row_at && r.sentiment !== null
          ? {
              sentiment: r.sentiment,
              intent: r.intent ?? '',
              topic: r.topic ?? '',
              resolved: r.resolved ?? false,
              handledBy: r.handled_by ?? '',
              exchangesCount: r.exchanges_count ?? 0,
              actionSuggestion: r.action_suggestion ?? '',
              analyzedAt: r.analyzed_row_at.toISOString(),
              // Une chaîne vide vaut absence, comme à l'écriture (`src/analysis/store.pg.ts`) : le modèle peut rendre le
              // champ vide, et l'écran doit dire qu'il n'y a pas de résumé.
              summary: r.summary !== null && r.summary.trim() !== '' ? r.summary : null,
            }
          : null;
      return {
        conversationId: r.id,
        waId: r.wa_id,
        lastMessageAt: r.last_message_at.toISOString(),
        lastPreview: r.last_preview,
        messagesCount: Number(r.messages_count),
        analysisStatus: r.analysis_status,
        analysis,
        // Une analyse existe et le statut est reparti hors 'done' -> un message est arrivé depuis.
        analysisStale: analysis !== null && r.analysis_status !== 'done',
        inboxHref: `/inbox?c=${r.id}`,
      };
    });
  }
}
