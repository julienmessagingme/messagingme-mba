import type { Pool } from 'pg';
import { horsEntreeGratuite } from '../stats/entree-gratuite';
import { journaliser } from '../lib/journal';

/**
 * Historique d'un contact : ce qu'on lui a ENVOYÉ, et ce qu'il a ÉCHANGÉ avec nous.
 *
 * Store de LECTURE uniquement, séparé du store d'écriture des contacts (même découpage que
 * `src/stats/conversation-stats.pg.ts` face à `src/analysis/store.pg.ts`).
 *
 * Deux règles de jointure, différentes, et c'est le cœur du sujet :
 *
 *  - les ENVOIS se relient par `campaign_recipients.contact_id`, jamais par le numéro. `to_e164` est figé à la
 *    construction de la campagne : si le contact change de numéro ensuite, une correspondance par numéro rate
 *    tout son passé. (`getCampaignFunnel` joint bien par `to_e164`, mais c'est un funnel de campagne, pas un
 *    historique de personne : ce serait un bug ici.)
 *
 *  - les CONVERSATIONS ne peuvent PAS se relier par `contact_id` seul. Cette colonne est nullable et posée en
 *    `coalesce` dans `upsertConversationByWaId` : une conversation ouverte AVANT que le contact existe garde
 *    `contact_id` null jusqu'au message suivant. S'en tenir à `contact_id` perdrait ces échanges EN SILENCE.
 *    On rattrape donc par `wa_id`, en recopiant la règle d'identité de l'inbox : le numéro en chiffres nus, et
 *    le BSUID brut. Un contact peut porter les deux, donc plusieurs conversations : on renvoie une liste.
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
   * Dernier état de livraison connu : sent < delivered < read, ou failed. NULL sur un envoi parfaitement
   * réussi dont le webhook de statut n'est jamais arrivé : cela veut dire « statut inconnu », JAMAIS
   * « non délivré ». Il n'existe aucun horodatage par étape, seulement celui du dernier changement.
   */
  deliveryStatus: string | null;
  deliveryUpdatedAt: string | null;
  /**
   * La personne a-t-elle RÉAGI à cet envoi : répondu, appuyé sur un bouton, ou CLIQUÉ sur un lien du message.
   *
   * 🔴 Ce n'est PAS « lu ». « Lu » dit que Meta a affiché le message ; « engagé » dit qu'un humain a fait
   * quelque chose. Un message peut être lu par milliers sans qu'une seule personne ne réagisse, et c'est
   * précisément l'écart que cet indicateur rend visible.
   *
   * ⚠️ LE CLIC A ÉTÉ AJOUTÉ LE 2026-09-02, ET IL COMBLAIT UN TROU RÉEL. Un bouton URL fait SORTIR le contact
   * de la conversation : il n'en revient aucun message entrant, donc la personne la plus engagée de la
   * campagne, celle qui a ouvert le lien, s'affichait comme n'ayant pas réagi. C'est aussi ce qui rend enfin
   * VISIBLE l'attribution des clics (migrations 0106 et 0107) : sans elle, on saurait qui a cliqué sans
   * jamais le montrer nulle part.
   *
   * Bornes : après l'envoi, avant le prochain envoi à ce contact, et dans les 24 h. La première borne évite
   * que deux campagnes du même jour se créditent l'une l'autre ; la seconde évite de compter une réponse de
   * la semaine suivante comme une réaction à ce message-là.
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
  /** Date de la DERNIÈRE analyse (upsert sur la clé primaire), pas la date de la conversation. */
  analyzedAt: string;
  /**
   * CE QUI S'EST DIT, en deux ou trois phrases (migration 0100).
   *
   * ⚠️ `null` EST UN CAS NORMAL, ET IL NE VEUT PAS DIRE « CONVERSATION VIDE » : les analyses antérieures à
   * la migration 0100 n'ont pas de résumé et n'en auront jamais (le reconstruire voudrait dire rappeler le
   * modèle sur chaque conversation déjà analysée). L'écran le DIT, il ne laisse pas un vide qui passerait
   * pour une panne. C'est la même règle que sur la fiche d'analyse, et elle a la même formulation :
   * `web/lib/resume-conversation.ts` la porte une seule fois pour les deux écrans.
   *
   * 🔴 ET SURTOUT, IL NE SE SUBSTITUE PAS À `justification` : celle-ci explique le CLASSEMENT
   * (« pourquoi j'ai proposé de rappeler »), pas ce qui s'est dit. Les échanger serait un mensonge discret.
   */
  summary: string | null;
}

/**
 * LE RÉSUMÉ QUI DEVIENT UN CHAMP DE BASE DU MINI-CRM (demande de Julien : « le résumé de la conversation,
 * ce qui serait top c'est que ça devienne un champ du mini CRM, ça serait un champ de base à partir du
 * moment où il y a une conversation »).
 *
 * 🔴 DÉRIVÉ À LA LECTURE, JAMAIS RECOPIÉ DANS `contacts.fields`, et la rétention a fait de ce choix de
 * cohérence un choix de CONFORMITÉ. Recopier créerait une seconde vérité à côté de
 * `conversation_analysis.summary` ; depuis que la rétention descend à 90 jours (migration 0155), ce serait
 * pire : la purge efface la conversation et son analyse EN CASCADE, et la copie, elle, survivrait dans la
 * fiche du contact. On garderait alors un texte tiré de ce que la personne a raconté, précisément au-delà
 * de la durée qu'on s'est engagé à tenir. Dérivé, le champ se vide tout seul, au bon moment.
 *
 * ⚠️ IL N'EST PAS UNE VARIABLE DE MESSAGE, et ce n'est pas un oubli. Deux raisons, chacune suffisante :
 * `contactVars` (`src/crm/render.ts`) est le chemin d'envoi d'une CAMPAGNE, donc une jointure par
 * destinataire sur des envois de plusieurs milliers ; et surtout, envoyer à quelqu'un le résumé que notre
 * modèle a fait de sa propre conversation n'est pas un geste qu'on veut rendre possible en un clic.
 */
export interface ResumeContact {
  /**
   * Le texte du résumé. `null` quand il n'y en a pas, et `conversations`/`analysee` disent POURQUOI : ces
   * trois champs ne se déduisent pas les uns des autres, et les confondre afficherait « pas encore
   * analysée » sur un contact qui n'a jamais ouvert la moindre conversation.
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
  /**
   * Un message est arrivé APRÈS l'analyse : le résumé ne couvre pas la fin du fil. Même règle
   * qu'`analysisStale` sur la liste des conversations, et volontairement le même mot à l'écran.
   */
  perime: boolean;
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
   * true quand une analyse EXISTE mais qu'un message est arrivé depuis (le statut est retombé hors 'done').
   * Sans ce drapeau, l'interface afficherait une analyse périmée comme si elle était fraîche.
   */
  analysisStale: boolean;
  /** Lien vers le fil complet dans l'inbox. Les messages ne sont PAS embarqués ici (voir le commentaire bas). */
  inboxHref: string;
}

export interface ContactHistory {
  sends: ContactSend[];
  conversations: ContactConversation[];
}

/**
 * LES IDENTITÉS D'UN CONTACT, DÉRIVÉES EN SQL. Attend `$1` = tenant, `$2` = contact, et se pose en CTE `ct`.
 *
 * Les identités ne viennent JAMAIS du client : accepter un `wa_id` envoyé par le front ouvrirait la lecture
 * des conversations de n'importe qui. `array_remove` s'appuie dessus plus bas, d'où les deux `nullif` : un
 * contact n'a pas forcément les deux identités, et un `phone_e164` vide donnerait une chaîne vide qui ne
 * doit surtout pas servir de critère.
 */
export const CONTACT_IDENTITES_SQL = `select id,
                nullif(regexp_replace(coalesce(phone_e164, ''), '[^0-9]', '', 'g'), '') as digits,
                nullif(bsuid, '') as bsuid
         from contacts where id = $2 and tenant_id = $1`;

/**
 * LE RATTACHEMENT D'UNE CONVERSATION À UN CONTACT (`c` = `conversations`, `ct` = le CTE ci-dessus).
 *
 * 🔴 FRAGMENT PARTAGÉ, ET CE N'EST PAS UNE COMMODITÉ D'ÉCRITURE. La règle est expliquée en tête de fichier :
 * `contact_id` seul PERD les conversations ouvertes avant que le contact existe, il faut rattraper par
 * `wa_id`. DEUX requêtes la portent maintenant, la liste des conversations et le résumé affiché en champ de
 * base. Recopiée, elle divergerait, et la divergence serait MUETTE : la fiche montrerait le résumé d'une
 * conversation absente de sa propre liste d'historique, ou l'inverse, sans qu'aucune erreur ne le signale.
 */
export const CONVERSATION_DU_CONTACT_SQL =
  `(c.contact_id = ct.id or c.wa_id = any(array_remove(array[ct.digits, ct.bsuid], null)))`;

/** Bornes de lecture : un historique d'écran, pas un export. Au-delà, l'inbox et le détail de campagne. */
const MAX_SENDS = 200;
const MAX_CONVERSATIONS = 100;
/** Borne HAUTE de l'export CSV (F5) : bien au-delà d'un écran, mais bornée pour ne pas ramener un volume illimité. */
const EXPORT_MAX_SENDS = 5000;

export class PgContactHistoryStore {
  constructor(private readonly pool: Pool) {}

  /** null si le contact n'existe pas pour ce tenant (la route en fait un 404, jamais une liste vide trompeuse). */
  async getContactHistory(tenantId: string, contactId: string): Promise<ContactHistory | null> {
    // Le contact est chargé D'ABORD, scopé tenant : c'est lui qui distingue « aucun historique » (listes vides,
    // réponse 200) de « ce contact n'est pas à toi » (404). Sans ce contrôle, un id d'un autre tenant
    // renverrait deux listes vides, c'est-à-dire un 200 rassurant sur une ressource interdite.
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
   * LE RÉSUMÉ DE LA DERNIÈRE CONVERSATION ANALYSÉE, pour la ligne « champ de base » de la fiche contact.
   * `null` si le contact n'est pas dans cet espace (la route en fait un 404, jamais un 200 rassurant sur une
   * ressource interdite : c'est la même garde que `getContactHistory`, pour la même raison).
   *
   * 🔴 ROUTE À PART, ET C'EST LE POINT DE L'ARBITRAGE. La fiche s'ouvre sur l'onglet « Fiche », qui ne
   * charge PAS l'historique (200 envois, 100 conversations et un `count(*)` par conversation) : y brancher
   * ce résumé ferait payer tout l'historique à chaque ouverture. Et il ne rejoint pas non plus `ContactRow` :
   * la LISTE du mini-CRM se lit par `list` et `query`, qui peuvent rendre des centaines de lignes, et une
   * sous-requête par ligne y coûterait une jointure sur les deux tables les plus écrites du produit, pour
   * une valeur que personne ne lit dans une liste. Une seule requête, un seul contact, à l'ouverture.
   *
   * 🔴 LA DERNIÈRE ANALYSÉE, PAS LA DERNIÈRE QUI PORTE UN RÉSUMÉ. Remonter à une conversation plus ancienne
   * parce que la plus récente a été analysée avant la migration 0100 afficherait un texte périmé comme s'il
   * était d'aujourd'hui. On prend la plus récente analysée et, si elle n'a pas de résumé, l'écran le DIT.
   *
   * ⚠️ ET CE CAS N'EST PAS THÉORIQUE : MESURÉ. Sonde en lecture seule du 2026-09-17, jouée PAR CE CODE sur la
   * base de production, sur les cinq contacts qui portent le plus de conversations : les cinq concordent au
   * caractère près avec la première conversation analysée de leur historique, un contact d'un autre espace
   * rend bien `null`, et **DEUX des cinq** ont une analyse SANS résumé. L'état « analysée mais pas de résumé »
   * représente donc 40 % de l'échantillon mesuré, pas un repli rare.
   */
  async resumeContact(tenantId: string, contactId: string): Promise<ResumeContact | null> {
    const res = await this.pool.query<{
      connu: boolean; conversations: number; conversation_id: string | null;
      analysis_status: string | null; analyse_le: Date | null; summary: string | null;
    }>(
      // Les deux fragments sont CITÉS, jamais recopiés : leur justification est à leur définition, plus haut.
      `with ct as (
         ${CONTACT_IDENTITES_SQL}
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
         select id, analysis_status, analyse_le, summary
           from conv
          where analyse_le is not null and sentiment is not null
          order by last_message_at desc
          limit 1
       )
       select exists (select 1 from ct) as connu,
              (select count(*) from conv)::int as conversations,
              (select id from derniere) as conversation_id,
              (select analysis_status from derniere) as analysis_status,
              (select analyse_le from derniere) as analyse_le,
              (select summary from derniere) as summary`,
      [tenantId, contactId],
    );
    const r = res.rows[0];
    if (!r || !r.connu) return null;
    const analysee = r.analyse_le !== null;
    return {
      // Chaîne vide = absence, comme à l'écriture et comme dans la liste des conversations.
      texte: analysee && r.summary !== null && r.summary.trim() !== '' ? r.summary : null,
      analyseLe: r.analyse_le ? r.analyse_le.toISOString() : null,
      conversationId: r.conversation_id,
      conversations: r.conversations,
      analysee,
      // Une analyse existe ET le statut est reparti hors 'done' -> un message est arrivé depuis. Même
      // règle qu'`analysisStale`, et il n'en existe pas de seconde définition.
      perime: analysee && r.analysis_status !== 'done',
    };
  }

  /**
   * LA MATIÈRE DU BILAN D'UN CONTACT : ses envois par catégorie (pour le coût), et la profondeur atteinte
   * parcours par parcours (pour l'entonnoir). Demande de Julien du 2026-09-11.
   *
   * 🔴 UN PARCOURS = UN ENVOI DE CAMPAGNE, BORNÉ COMME `engage` L'EST DÉJÀ : jusqu'au prochain envoi, et au
   * plus 24 h. Ce n'est pas un choix de confort, c'est la seule borne cohérente avec le reste de la fiche.
   * Sans elle, mesuré sur les données réelles, le dernier parcours avalait toute la conversation qui suit et
   * rendait des « niveaux » 27 et 35 : une discussion racontée comme un entonnoir.
   *
   * 🔴 SEULS LES SORTANTS AUTOMATIQUES COMPTENT COMME SOLLICITATION (`sender_user_id is null`). Un opérateur
   * qui écrit depuis l'Inbox ne fait pas avancer un scénario d'un cran : compter ses messages ferait grimper
   * le niveau d'un contact au seul motif qu'on a discuté avec lui, ce qui est l'inverse de ce que l'entonnoir
   * mesure.
   *
   * ⚠️ ET C'EST `sender_user_id`, PAS `origin`, POUR UNE RAISON MESURÉE. La colonne `origin` dit pourtant
   * « humain » en toutes lettres, ce qui serait plus lisible ; mais elle est NULLE sur 73 des 163 sortants
   * de la base (relevé le 2026-09-11), parce qu'elle est arrivée après eux. S'y fier ferait compter tout
   * l'historique comme automatique, sans qu'aucun test le voie : les faux d'un test sont toujours complets.
   *
   * ⚠️ UNE RÉACTION EST UN ENTRANT **OU** UN CLIC ATTRIBUÉ, exactement la définition d'`engage` un peu plus
   * haut, appliquée en profondeur : « cliqué ou répondu, bref il y a eu un engagement » (Julien). Un bouton
   * de réponse rapide arrive comme un entrant portant son `button_payload`, donc il compte ; un bouton URL
   * fait SORTIR le contact de la conversation, d'où le second test.
   *
   * ⚠️ La profondeur est un `max`, pas un compte : le niveau ATTEINT est le plus profond, et c'est
   * `entonnoirEngagement` qui en fait un cumul « au moins N ».
   *
   * 🔴 LA DERNIERE SOLLICITATION D UN PARCOURS EST BORNEE PAR `p.fin`, PAS SEULEMENT PAR 24 H. Sans
   * `s.fin` dans le `coalesce`, elle n avait aucune borne haute autre que la fenetre de service : si la
   * campagne SUIVANTE partait moins de 24 h apres, la reaction qu ELLE provoquait comptait aussi comme un
   * engagement sur le parcours PRECEDENT. L entonnoir surestimait alors la profondeur, et d autant plus que
   * le client enchaine ses campagnes. Releve en revue le 2026-09-11.
   *
   * ⚠️ LES DEPARTS SONT DEDUPLIQUES ET BORNES, et les deux raisons sont ecrites dans la requete : deux
   * envois a la meme milliseconde produisaient une fenetre VIDE, donc un parcours perdu en silence ; et
   * l entonnoir couvre les `MAX_SENDS` derniers departs, exactement la population de la liste d envois
   * affichee juste en dessous.
   *
   * ⚠️ LES ENVOIS DU COÛT excluent les 72 h gratuites qui suivent un clic sur une pub (`horsEntreeGratuite`),
   * comme toute lecture de coût. Ils ne portent PAS, en revanche, les gardes de livraison des autres lectures
   * (`status = 'sent'`, livraison non `failed`, canal WhatsApp) : écart antérieur au lot 1 des pubs, relevé
   * par sa revue et suivi à part, pas corrigé en silence ici.
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
   * Envois d'un contact pour l'EXPORT CSV (F5) : mêmes lignes que l'historique d'écran mais SANS le cap 200 (borné à
   * EXPORT_MAX_SENDS par sûreté, log si atteint). null si le contact n'appartient pas au tenant (404 côté route, pas
   * une liste vide trompeuse sur une ressource interdite). Lecture seule, scopée tenant en SQL.
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
      // `c.tenant_id = $1` en plus du contrôle d'appartenance du contact : double barrière assumée, la même
      // que dans conversation-stats.pg.ts. Une campagne d'un autre tenant ne peut pas remonter ici.
      //
      // 🔴 `engage` : la personne a-t-elle RÉAGI à cet envoi ? Demandé par Julien le 2026-09-02, « en plus de
      // l'indicateur Lu, Engagé, ce qui montre que la personne a au moins réagi ou a appuyé quelque part dans
      // le template envoyé ». « Lu » dit que Meta a affiché le message ; « engagé » dit qu'un humain a fait
      // quelque chose, ce qui n'est pas la même information et n'a pas la même valeur.
      //
      // DEUX BORNES, et chacune corrige une façon de mentir :
      //  - la borne HAUTE de 24 h, parce qu'une réponse trois jours plus tard n'est pas une réaction à ce
      //    message-là ; c'est aussi la fenêtre de service, donc la seule pendant laquelle la personne peut
      //    répondre librement ;
      //  - le PROCHAIN ENVOI, parce que deux campagnes le même jour se créditeraient l'une l'autre : une
      //    réponse arrivée après le second message ne dit rien du premier.
      //
      // Tout message ENTRANT compte, texte comme appui de bouton : un appui arrive comme un entrant portant
      // son `button_payload`, et exiger un payload exclurait « oui » écrit à la main, qui est pourtant la
      // même réaction.
      //
      // 🔴 ET LE CLIC SUR UN LIEN, depuis le 2026-09-02. Un bouton URL fait SORTIR le contact de la
      // conversation : il n'en revient aucun entrant, donc sans ce second test la personne qui a ouvert le
      // lien, la plus engagée de la campagne, s'affichait comme n'ayant pas réagi. Les MÊMES bornes que la
      // réponse, et pour les mêmes raisons.
      //
      // ⚠️ Ne remontent ici que les clics ATTRIBUÉS (`contact_id` non nul), c'est-à-dire ceux dont l'URL
      // portait le jeton du destinataire. Les liens des templates approuvés avant le 2026-09-02 ont une
      // adresse figée chez Meta, sans jeton : leurs clics restent anonymes et ne peuvent créditer personne.
      // C'est une limite physique, pas un oubli, et Julien l'a arbitrée : « on s'en fout des vieux templates ».
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
      // Les deux fragments sont CITÉS, jamais recopiés : leur justification est à leur définition, plus haut.
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
              // ⚠️ Une chaîne VIDE vaut absence, exactement comme à l'écriture (`src/analysis/store.pg.ts`) :
              // le modèle peut rendre le champ vide plutôt que de l'omettre, et la laisser passer afficherait
              // un résumé blanc là où l'écran doit dire qu'il n'y en a pas.
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
        // Une analyse existe ET le statut est reparti hors 'done' -> un message est arrivé depuis.
        analysisStale: analysis !== null && r.analysis_status !== 'done',
        inboxHref: `/inbox?c=${r.id}`,
      };
    });
  }
}
