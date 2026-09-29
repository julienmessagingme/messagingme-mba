import type { Pool } from 'pg';
import type { InboxStore, InboundMessage } from '../webhooks/inbound';
import { MATCH_BY_WAID_SQL } from '../crm/contact-store.pg';
import type { OrigineMessage } from './origine';
import { visibiliteSql, voitTout, type ActeurConversation } from './assignment';
import { MEDIA_EXPIRE_SQL } from './media-entrant';
import { FENETRE_SERVICE_MS } from '../workflow/engine';
import type { EcritureDuFil } from './fil';
import {
  CAUSE_MESSAGE_DU_CONTACT, HISTORIQUE_MAX, acteurSql, borner, colonnesAuteur,
  type AuteurDuChangement, type DetailConversation, type EvenementConversation, type QuiEvenement, type TypeEvenement,
} from './evenements';

/**
 * Au-delà de cet âge, notre dernier envoi n'est plus « en vol » : Meta l'a traité (il acquitte en une seconde),
 * et rendre le fil ne peut plus faire la course avec lui. Lu par `demanderReleaseMba`. Large exprès : une file
 * d'accusés en retard ne doit pas rouvrir la course.
 */
export const ENVOI_EN_VOL = '10 minutes';

/**
 * Qui détient la conversation, et donc qui répond au client. `app_workflow` est le seul état qui autorise un
 * scénario à avancer ou à démarrer. `mba` ne s'écrit que sur la parole de Meta : un `release` qu'il a accepté, ou
 * un entrant `standby`. Qui écrit cette colonne, et dans quel ordre : `src/inbox/fil.ts`, seul.
 */
export type ControlOwner = 'app_workflow' | 'app_human' | 'mba';


export interface ConversationSummary {
  id: string;
  waId: string;
  profileName: string | null;
  lastPreview: string | null;
  lastMessageAt: string;
  /**
   * Le point de reprise de la pagination, opaque, et surtout pas `lastMessageAt` : tronqué à la milliseconde
   * alors que Postgres stocke la microseconde, il ferait sauter sans bruit les conversations actives dans la
   * même milliseconde (`(last_message_at, id) < (curseur, id)`). Optionnel pour les faux de test.
   */
  curseur?: string;
  controlOwner: ControlOwner;
  /** Un message entrant est arrivé depuis la dernière ouverture du fil par un opérateur. */
  unread: boolean;
  /**
   * Membre à qui la conversation est confiée (`null` = personne, ouverte à tous). Indépendant de
   * `controlOwner`, qui dit ce qui parle : une conversation peut être affectée et tenue par le scénario.
   */
  assignedTo: string | null;
  /** Nom du membre affecté, pour l'afficher sans un second aller-retour. */
  assignedToName: string | null;
  /**
   * La conversation a-t-elle été signalée à la main ? Distinct du dossier « Signalé », qui montre aussi le
   * constat de l'analyse : l'écran ne doit proposer « ne plus signaler » que sur un signalement manuel.
   * Optionnel, lu comme `false`.
   */
  signaleeMain?: boolean;
  /**
   * Un opérateur l'a marquée « Traité » et le contact n'a rien écrit depuis : la pastille de la ligne et le
   * geste inverse du menu. Optionnel, lu comme « pas traitée ».
   */
  traitee?: boolean;
}
/** Les chiffres du menu de dossiers de l'Inbox, lus ensemble puisqu'ils sont affichés ensemble. */
export interface CompteursInbox {
  /** Toutes les conversations non archivées de l'espace. */
  tout: number;
  aTraiter: number;
  signalees: number;
  archivees: number;
  /** Non archivées et marquées « Traité ». Elles sont aussi comptées dans `tout`. */
  traitees: number;
  /** Non archivées et confiées à personne. */
  nonAffectees: number;
  /** Tous les membres de l'espace, y compris ceux qui n'ont aucune conversation. */
  parMembre: Array<{ userId: string; nom: string; n: number }>;
}

/** Options de lecture de l'inbox, toutes optionnelles : sans elles, la première page. */
export interface ListConversationsOptions {
  /**
   * Une conversation précise, par son identifiant (lien « Ouvrir la conversation » du mini-CRM). Ignore les
   * dossiers, sinon une conversation archivée ou traitée rendrait une liste vide ; la garde d'espace reste
   * posée.
   */
  id?: string;
  /** Taille de page. Défaut 100, borné à 200 : la valeur vient d'une query string. */
  limit?: number;
  /**
   * Curseur : reprendre strictement après cette conversation, dans l'ordre d'affichage. On passe le dernier
   * élément de la page précédente. `at` est l'horodatage de son dernier message, `id` départage les ex æquo.
   */
  before?: { at: string; id: string };
  /** N'garder que les fils dont le scénario ne s'occupe plus (onglet « À traiter »). */
  aTraiter?: boolean;
  /** Le dossier archivé. Absent ou faux = les dossiers ordinaires, qui excluent les archivées. */
  archivees?: boolean;
  /** Le dossier « Traité » : non archivées, marquées « Traité ». Pas exclusif : elles restent dans « Tout ». */
  traitees?: boolean;
  /**
   * Filtrer sur l'affectation : un identifiant de membre, ou `'aucune'` pour les conversations que personne
   * ne s'est vu confier. Absent = toutes, affectées ou non.
   */
  affectee?: string | 'aucune';
  /**
   * Le dossier « Signalé » : l'union du signalement posé à la main (`signalee_le`) et du constat d'injure de
   * l'analyse.
   */
  signalees?: boolean;
}

export interface ConversationMessage {
  id: string;
  direction: 'in' | 'out';
  type: string | null;
  body: string | null;
  buttonPayload: string | null;
  createdAt: string;
  /**
   * Le point de reprise du delta, opaque, et surtout pas `createdAt` : un `Date` JavaScript n'a que la
   * milliseconde quand Postgres stocke la microseconde, et un curseur tronqué ferait revenir le dernier message
   * à chaque rafraîchissement. Un curseur est fabriqué par le serveur et renvoyé tel quel, jamais reconstruit.
   * Optionnel pour les faux de test.
   */
  curseur?: string;
  /** Auteur d'un message sortant (name sinon partie locale de l'email). null = pas d'auteur (legacy/auto).
   *  Optionnel : les mocks de test qui omettent le champ restent valides. */
  senderName?: string | null;
  /** Canal de cette bulle : le fil est unique par contact, c'est le message qui porte le tuyau emprunté.
   *  Optionnel : les faux de test qui omettent le champ restent valides (traités en WhatsApp). */
  channel?: 'whatsapp' | 'rcs';
  /**
   * Ce message porte-t-il un fichier chez Meta ? Un booléen, jamais l'identifiant : seul le serveur s'en sert
   * (l'URL de Meta exige notre jeton), l'écran doit seulement savoir s'il propose le fichier.
   */
  aMedia?: boolean;
  /**
   * Le fichier a-t-il dépassé le délai de Meta (`DUREE_MEDIA_RECU_JOURS`) ? L'écran dit alors « expiré » au
   * lieu d'un bouton qui échoue. Vrai seulement si le message porte un média.
   */
  mediaExpire?: boolean;
  /** Le nom de fichier d'un document reçu, tel que WhatsApp l'annonce. */
  mediaNom?: string | null;
  /**
   * La transcription du vocal, quand un opérateur l'a demandée. Séparée de `body` et marquée comme telle à
   * l'écran : c'est la lecture d'un modèle, pas ce que le client a dit.
   */
  transcription?: string | null;
  /**
   * La langue dans laquelle le vocal a été dit, selon le modèle de transcription : évite de traduire un vocal
   * déjà dans la langue du lecteur, et alimente la langue du contact.
   */
  transcriptionLangue?: string | null;
  /**
   * Notre lecture d'un message entrant, dans la langue de la console. À côté de `body`, jamais à sa place :
   * `body` garde ce que le client a écrit, et c'est lui qui fait foi.
   */
  traduction?: string | null;
  /** La langue de `traduction`, bornée à nos deux langues de console. */
  traductionLangue?: string | null;
  /**
   * Ce que l'opérateur a écrit avant de faire traduire, sur un message sortant. Le sens s'inverse ici : sur un
   * sortant, `body` porte ce qui est parti (le texte traduit), et cette colonne l'original.
   */
  redactionOrigine?: string | null;
}

/**
 * « Non lu » = un message entrant plus récent que la dernière ouverture du fil (`last_read_at` null = jamais
 * ouvert). Seul l'entrant compte, sinon chaque campagne rallumerait le compteur. Fragment partagé par la liste
 * et le compteur, pour que la pastille ne montre pas un nombre que la liste ignore. `c` = alias de
 * `conversations`.
 */
const UNREAD_SQL = `exists (
  select 1 from conversation_messages m
  where m.conversation_id = c.id and m.direction = 'in'
    and m.created_at > coalesce(c.last_read_at, to_timestamp(0))
)`;

/**
 * Le dossier « À traiter », défini une fois : « quelqu'un attend quelque chose de nous ». Fragment partagé par
 * la liste, les compteurs du menu et la vieille route de comptage. `c` = alias de `conversations`.
 *
 *  - le scénario ne gère plus le fil (`control_owner <> 'app_workflow'`) ;
 *  - le contact a parlé en dernier, quel que soit le détenteur (humain ou robot) : un fil où l'on vient de
 *    répondre attend le contact. Un sens nul veut dire aucun message (fil ouvert depuis la fiche), il n'y entre
 *    pas. `is not null and <> 'out'` et non `not (... = 'out')` : en logique à trois valeurs, un prédicat NULL
 *    exclut la ligne ;
 *  - ou l'agent de Meta a escaladé (`escaladee_le`) : sa dernière phrase est sortante, mais le client attend un
 *    humain, jusqu'à la première réponse d'un opérateur ;
 *  - et personne ne l'a marqué « Traité » : le prochain vrai message du contact efface ce statut, une réaction
 *    (👍) non.
 */
const A_TRAITER_SQL = `c.control_owner <> 'app_workflow' and ((c.last_direction is not null and c.last_direction <> 'out') or c.escaladee_le is not null) and c.traitee_le is null`;

/** Voir `PgInboxStore.empreinteDuFil`. */
export interface EmpreinteDuFil { detenteur: string | null; changeLe: string | null; dernierEnvoi: string | null }

/**
 * Le `wa_id` d'un contact qui peut avoir un fil (`$1` = l'espace, `$2` = le contact) : actif, non bloqué,
 * chiffres nus de son téléphone sinon son bsuid. Un fragment pour `ouvrirConversationDuContact` et
 * `filDuContact`, qui doivent chercher le fil sous la même clé.
 */
const CIBLE_DU_CONTACT_SQL = `cible as (
         select coalesce(nullif(regexp_replace(coalesce(c.phone_e164, ''), '[^0-9]', '', 'g'), ''), c.bsuid) as wa_id
           from contacts c
          where c.id = $2::uuid and c.tenant_id = $1 and c.deleted_at is null and c.blocked_at is null
       )`;

/**
 * Le fil d'un contact, cherché sans être créé (`PgInboxStore.filDuContact`). `injoignable` : fiche inconnue de
 * l'espace, supprimée, bloquée, ou sans identité WhatsApp. `sans_fil` : joignable, mais aucun fil n'existe.
 */
export type FilDuContact = { etat: 'fil'; conversationId: string } | { etat: 'sans_fil' } | { etat: 'injoignable' };

/**
 * Store Postgres de la boîte de réception (conversations + messages).
 *
 * ⚠️ LE VERROU DES ÉCRITURES QUI JOURNALISENT (migration 0192) : l'état d'avant se lit dans un sous-select
 * `for no key update`, jamais `for update` (relecture du 2026-09-29). C'est exactement le verrou que l'`update`
 * lui-même prend (aucune de ces écritures ne touche une clé de `conversations`) : il sérialise deux gestes sur la
 * même conversation, et c'est tout ce qu'on lui demande. `for update` en prend un plus fort, qui bloque aussi les
 * insertions FILLES (un message, un événement, une analyse : leur clé étrangère pose `for key share` sur la
 * conversation), qui n'avaient aucune raison d'attendre un geste de la console.
 */
export class PgInboxStore implements InboxStore {
  constructor(private readonly pool: Pool) {}

  async phoneNumberTenant(phoneNumberId: string): Promise<string | null> {
    const res = await this.pool.query<{ tenant_id: string }>(
      `select tenant_id from phone_numbers where id = $1`,
      [phoneNumberId],
    );
    return res.rows[0]?.tenant_id ?? null;
  }

  /**
   * Upsert la conversation par (tenant, wa_id), lie le contact si son identité correspond, avance
   * last_message_at et last_preview, rend l'id. Le wa_id est en chiffres nus ou un BSUID : on tente '+wa_id',
   * puis les seuls chiffres, puis le bsuid. Partagé par l'inbound et les envois sortants automatisés : même
   * conversation, jamais de doublon.
   */
  private async upsertConversationByWaId(
    tenantId: string,
    waId: string,
    preview: string,
    /**
     * Ce message rouvre-t-il la conversation ? Gouverné par le chemin appelant, jamais deviné ici : cet upsert
     * sert aussi les envois automatisés, et une campagne ne doit pas faire remonter chaque contact archivé.
     * Requis, pour qu'un nouvel appelant tranche. `archive` la sort d'Archivé (toute entrée du contact), `traite`
     * retire « Traité » (un vrai message, pas une réaction : « merci 👍 » est le cas que ce statut règle).
     */
    rouvre: { archive: boolean; traite: boolean },
    /**
     * Qui vient de parler : `in` le contact, `out` nous, `reaction` le contact par un emoji. Une réaction ne
     * change pas qui a parlé en dernier (sauf sur une conversation neuve) : le sens n'est lu que par « À
     * traiter ». Obligatoire, sans défaut : un oubli rangerait le fil au mauvais endroit en silence.
     */
    sens: 'in' | 'out' | 'reaction',
  ): Promise<string> {
    const conv = await this.pool.query<{ id: string }>(
      // Un contact = une conversation, quel que soit le canal : c'est le message qui porte son canal. L'unique
      // (tenant_id, wa_id) arbitre ce ON CONFLICT, et la reprise de main vaut pour le contact entier.
      //
      // 🔴 CHEMIN DE CHAQUE MESSAGE REÇU, ET UNE SEULE INSTRUCTION. L'evenement « rouverte » (migration 0192)
      // s'ecrit dans la meme requete que l'upsert, et seulement si archived_at ou traitee_le etait pose AVANT
      // et ne l'est plus APRES : un message sur une conversation ni archivee ni traitee n'ecrit rien, et une
      // reaction sur une conversation seulement traitee non plus (elle ne retire pas ce statut).
      // « avant » est lu dans l'instantane de la requete (toutes les parties d'un WITH partagent le meme) : il
      // porte donc l'etat d'avant l'upsert. Ne le lit que le chemin qui peut rouvrir ($4 ou $6) : un envoi
      // sortant ne paie pas cette lecture. Fenetre residuelle, assumee : un rangement ecrit par une autre
      // transaction entre l'instantane et le verrou de ligne ; les entrants d'un meme contact sont serialises.
      // ⚠️ Aucun accent grave dans ce commentaire : il vit DANS un gabarit TypeScript.
      `with avant as (
         select id, archived_at, traitee_le from conversations
          where tenant_id = $1 and wa_id = $2 and ($4::boolean or $6::boolean)
       ),
       maj as (
       insert into conversations (tenant_id, wa_id, contact_id, last_message_at, last_preview, last_direction)
       values ($1, $2, (select id from contacts where tenant_id = $1
         ${MATCH_BY_WAID_SQL}), now(), $3, $5)
       on conflict (tenant_id, wa_id) do update set
         last_message_at = now(),
         last_preview = excluded.last_preview,
         -- 🔴 LE SENS DU DERNIER MESSAGE, ecrit dans la MEME ecriture que l apercu. Deux ecritures
         -- laisseraient une fenetre ou l apercu montre la reponse de l operateur pendant que le dossier
         -- « A traiter » compte encore le fil comme du : l ecran se contredirait lui-meme.
         -- ⚠️ Aucun accent grave dans ce commentaire : il vit DANS un gabarit TypeScript, et un accent grave
         -- y fermerait la chaine. Deja paye une fois dans ce depot (sources.pg.ts).
         last_direction = case when $7::boolean then conversations.last_direction else excluded.last_direction end,
         contact_id = coalesce(conversations.contact_id, excluded.contact_id),
         -- Un nouveau message ROUVRE l'analyse : une conversation déjà analysée (done/failed) qui reçoit un message
         -- redevient 'pending' -> ré-analysée à la prochaine inactivité (sinon un contact qui revient n'est jamais réanalysé).
         analysis_status = case when conversations.analysis_status in ('done', 'failed') then 'pending' else conversations.analysis_status end,
         -- Un message du CONTACT sort la conversation d'Archive, dans la MEME ecriture que celle qui avance
         -- last_message_at. Deux ecritures laisseraient une fenetre ou la conversation a un message neuf et
         -- reste rangee dans Archive : precisement l'etat que personne ne regarde.
         archived_at = case when $4::boolean then null else conversations.archived_at end,
         -- Et il lui retire le statut « Traite » (migration 0160), pour la meme raison et dans la meme
         -- ecriture : c'est ce qui la fait revenir dans « A traiter », que le fragment de ce dossier exclut
         -- tant que la colonne est posee. Drapeau A PART ($6) : une reaction ne le retire pas.
         traitee_le = case when $6::boolean then null else conversations.traitee_le end
       returning id, archived_at, traitee_le
       ),
       rouverte as (
         insert into conversation_evenements (tenant_id, conversation_id, type, cause)
         select $1, maj.id, 'rouverte', $8::text
           from maj join avant on avant.id = maj.id
          where (avant.archived_at is not null and maj.archived_at is null)
             or (avant.traitee_le is not null and maj.traitee_le is null)
       )
       select id from maj`,
      [tenantId, waId, preview, rouvre.archive, sens === 'out' ? 'out' : 'in', rouvre.traite, sens === 'reaction', CAUSE_MESSAGE_DU_CONTACT],
    );
    return conv.rows[0]!.id;
  }

  /**
   * Affecte une conversation à un membre, par son numéro (l'appelant, le moteur de scénario, ne connaît que le
   * contact). Elle écrase une affectation existante : le bloc « passer à un humain » nomme explicitement qui
   * doit traiter le fil. `assigned_by` reste NULL : un routage automatique se distingue d'une distribution à la
   * main.
   *
   * 🔴 L'`exists` sur `users` est la garde : un membre d'un autre espace, ou un compte révoqué, ne reçoit rien.
   *
   * `cause` est REQUISE (« automatique : scénario Bienvenue ») : c'est ce que la frise du panneau Détail dit à la
   * place d'un auteur. L'événement ne s'écrit que si l'affectataire change : un scénario rejoué qui renomme la
   * même personne ne remplit pas la frise.
   */
  async setAssigneeByWaId(tenantId: string, waId: string, assignee: string, cause: string): Promise<boolean> {
    const res = await this.pool.query(
      // L'ancien affectataire est lu dans un sous-select VERROUILLÉ (`for no key update`, cf. la classe) : c'est la
      // valeur que l'update remplace, même sous une écriture concurrente, pas celle d'un instantané périmé.
      `with maj as (
         update conversations c set assigned_to = $3::uuid, assigned_at = now(), assigned_by = null
           from (select id as avant_id, assigned_to as ancien
                   from conversations where tenant_id = $1 and wa_id = $2 for no key update) avant
          where c.id = avant.avant_id
            and exists (select 1 from users u where u.id = $3::uuid and u.tenant_id = $1 and u.disabled_at is null)
         returning c.id, avant.ancien
       ),
       evenement as (
         insert into conversation_evenements (tenant_id, conversation_id, type, cible_id, cause)
         select $1, maj.id, 'assignee', $3::uuid, $4::text from maj where maj.ancien is distinct from $3::uuid
       )
       select id from maj`,
      [tenantId, waId, assignee, borner(cause)],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /**
   * Affecte une conversation qui n'est encore à personne, et rend `false` si elle l'est déjà. Contrairement à
   * `setAssigneeByWaId`, elle n'écrase pas : l'appelant est un roulement de campagne, qui n'a rien nommé.
   *
   * `assigned_to is null` est dans le `where`, pas dans une lecture préalable : deux réponses simultanées ne
   * peuvent pas écrire toutes les deux. 🔴 Même garde d'espace que sa jumelle. `assigned_by` reste NULL.
   * `cause` REQUISE (« automatique : campagne Rentrée ») ; une écriture qui a lieu est toujours un changement.
   */
  async assignerSiLibre(tenantId: string, waId: string, assignee: string, cause: string): Promise<boolean> {
    const res = await this.pool.query(
      `with maj as (
         update conversations set assigned_to = $3::uuid, assigned_at = now(), assigned_by = null
          where tenant_id = $1 and wa_id = $2 and assigned_to is null
            and exists (select 1 from users u where u.id = $3::uuid and u.tenant_id = $1 and u.disabled_at is null)
         returning id
       ),
       evenement as (
         insert into conversation_evenements (tenant_id, conversation_id, type, cible_id, cause)
         select $1, maj.id, 'assignee', $3::uuid, $4::text from maj
       )
       select id from maj`,
      [tenantId, waId, assignee, borner(cause)],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /**
   * Les membres qui peuvent recevoir une conversation, dans un ordre stable : le roulement lit
   * `membres[rang % membres.length]`, un ordre changeant reviendrait à tirer au sort (`id` départage les
   * `created_at` égaux). Ni révoqués ni jamais connectés : leur confier une conversation, c'est la ranger là
   * où personne ne la lira.
   */
  async membresAffectables(tenantId: string): Promise<string[]> {
    const res = await this.pool.query<{ id: string }>(
      // `last_login_at is not null` et surtout pas `password_hash is not null` : la connexion par Google ne pose
      // aucun mot de passe. Le critère juste est « cette personne s'est déjà connectée ».
      `select id from users
        where tenant_id = $1 and disabled_at is null and last_login_at is not null
        order by created_at asc, id asc`,
      [tenantId],
    );
    return res.rows.map((r) => r.id);
  }

  /**
   * Détenteur courant du fil. L'absence de conversation vaut `app_workflow` : une campagne peut viser un contact
   * qui n'a jamais écrit, et rien ne doit être bloqué.
   */
  async getControlOwner(tenantId: string, waId: string): Promise<ControlOwner> {
    const res = await this.pool.query<{ control_owner: ControlOwner }>(
      `select control_owner from conversations where tenant_id = $1 and wa_id = $2`,
      [tenantId, waId],
    );
    return res.rows[0]?.control_owner ?? 'app_workflow';
  }

  /**
   * Pose le détenteur du fil. Rend true si la bascule a eu lieu, false si la garde l'a refusée ou si l'état
   * était déjà celui visé (jamais une erreur).
   *
   * `only` restreint la transition aux détenteurs courants listés : c'est ce qui empêche un envoi automatisé de
   * révoquer un opérateur engagé (une campagne qui repose `app_workflow` par-dessus l'humain). La garde est dans
   * le WHERE, donc atomique.
   *
   * Update seul, jamais de création : une ligne absente vaut déjà `app_workflow`, et créer une conversation vide
   * la ferait apparaître sans message dans l'inbox.
   */
  async setControlOwner(
    tenantId: string,
    waId: string,
    owner: ControlOwner,
    /**
     * Les options d'écriture (`EcritureDuFil`, `src/inbox/fil.ts`), dont `par`, REQUIS : qui demande la bascule
     * (un collaborateur, ou une cause automatique). `escalade` : cette prise de fil est une escalade (bloc
     * « passer à un humain », agent IA, agent de Meta) ; sans ce drapeau la conversation n'entrerait pas dans « À
     * traiter » et serait rendue à l'agent au bout de 2 h. N'écrit que si la bascule a lieu.
     */
    opts: EcritureDuFil,
  ): Promise<boolean> {
    const only = opts.only;
    const auteur = colonnesAuteur(opts.par);
    // `effacerEscalade` : l'appelant décide, et la règle vit dans `src/inbox/fil.ts` (un robot qui reprend le fil,
    // ou un opérateur qui le rend, efface l'escalade ; le fil qui va à l'équipe la garde). `saufEscalade` : un
    // `standby` traité après l'escalade est un retardataire, sauf s'il est plus récent qu'elle (`messageEnvoyeLe`,
    // preuve que l'agent a repris le fil) ; sans date, la garde reste stricte.
    //
    // 🔴 LE JOURNAL (migration 0192), DANS LA MÊME REQUÊTE : `prise_mba` quand le fil quitte l'agent de Meta,
    // `rendue_mba` quand il y va. Entre scénario et équipe (0194, les demandes du Quantitatif > Performance) :
    // `escaladee` quand le drapeau d'escalade fait passer un fil d'un robot (`app_workflow`) à l'équipe, et
    // `rendue_scenario` quand l'équipe le rend à un scénario. Un opérateur qui prend le fil en écrivant (sans
    // drapeau) n'écrit rien : ce n'est pas une attente du client, et il ouvrirait une demande déjà répondue. Et
    // l'escalade qui sort la conversation d'Archivé ou de Traité le dit aussi (`desarchivee`, `non_traitee`), sans
    // quoi la frise la montrerait encore rangée. L'état d'avant est lu dans un sous-select VERROUILLÉ.
    // ⚠️ `rendAgentDeMeta` passe AVANT la lecture des colonnes : « Rendre la main » sur un fil que notre colonne
    // croit déjà `mba` écrit `app_workflow` (on ne rouvre que notre côté), et la règle des colonnes y lisait un fil
    // qui QUITTE l'agent, donc `prise_mba` signée de l'opérateur, l'inverse de son geste (relecture du 2026-09-29).
    const res = await this.pool.query(
      `with maj as (
         update conversations c set control_owner = $3, control_changed_at = now(),
                escaladee_le = case when $6::boolean then null
                                    when $8::boolean and $3 = 'app_human' then now()
                                    else c.escaladee_le end,
                traitee_le = case when $8::boolean and $3 = 'app_human' then null else c.traitee_le end,
                archived_at = case when $8::boolean and $3 = 'app_human' then null else c.archived_at end
           from (select id as avant_id, control_owner as ancien_detenteur, traitee_le as ancienne_traitee,
                        archived_at as ancienne_archive
                   from conversations where tenant_id = $1 and wa_id = $2 for no key update) avant
          where c.id = avant.avant_id
            and c.control_owner is distinct from $3
            and ($4::text[] is null or c.control_owner = any($4::text[]))
            and (not $5::boolean or c.escaladee_le is null
                 or ($7::timestamptz is not null and $7::timestamptz > c.escaladee_le))
         returning c.id, avant.ancien_detenteur, avant.ancienne_traitee, avant.ancienne_archive,
                   c.traitee_le, c.archived_at
       ),
       evenement as (
         insert into conversation_evenements (tenant_id, conversation_id, type, acteur_id, cause)
         select $1, maj.id, e.type, ${acteurSql('$9', '$1')}, $10::text
           from maj
           cross join lateral (values
             (case when $11::boolean then 'rendue_mba'
                   when maj.ancien_detenteur = 'mba' then 'prise_mba' when $3 = 'mba' then 'rendue_mba'
                   when $8::boolean and $3 = 'app_human' and maj.ancien_detenteur = 'app_workflow' then 'escaladee'
                   when $3 = 'app_workflow' and maj.ancien_detenteur = 'app_human' then 'rendue_scenario' end),
             (case when maj.ancienne_archive is not null and maj.archived_at is null then 'desarchivee' end),
             (case when maj.ancienne_traitee is not null and maj.traitee_le is null then 'non_traitee' end)
           ) as e(type)
          where e.type is not null
       )
       select id from maj`,
      [tenantId, waId, owner, only ? [...only] : null, opts.saufEscalade === true, opts.effacerEscalade === true,
       opts.messageEnvoyeLe ?? null, opts.escalade === true, auteur.acteur, auteur.cause, opts.rendAgentDeMeta === true],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /**
   * L'agent de Meta a passé la main à l'équipe (`control_passed`) : la conversation devient `app_human`, entre
   * dans « À traiter » (`escaladee_le`) et sort d'« Archivées » et de « Traité ». Upsert : la passation peut
   * être traitée avant l'écho de la phrase de l'agent, qui crée d'habitude la conversation.
   *
   * `cause` REQUISE. L'événement `passee_par_mba` ne s'écrit que si quelque chose change (fil qui n'était pas à
   * l'équipe, ou escalade pas encore posée) : un `control_passed` redélivré ne double pas la ligne.
   */
  async marquerEscalade(tenantId: string, waId: string, cause: string): Promise<void> {
    await this.pool.query(
      // Upsert : pas de sous-select verrouillé possible, l'état d'avant est lu dans l'instantané de la requête
      // (toutes les parties d'un WITH partagent le même), donc avant l'upsert. Une conversation neuve n'y est
      // pas : la passation s'écrit quand même, c'en est une.
      `with avant as (
         select id, control_owner, escaladee_le, traitee_le, archived_at
           from conversations where tenant_id = $1 and wa_id = $2
       ),
       maj as (
         insert into conversations (tenant_id, wa_id, contact_id, control_owner, control_changed_at, escaladee_le)
         values ($1, $2, (select id from contacts where tenant_id = $1 ${MATCH_BY_WAID_SQL}), 'app_human', now(), now())
         on conflict (tenant_id, wa_id) do update set
           control_owner = 'app_human', control_changed_at = now(), escaladee_le = now(),
           traitee_le = null, archived_at = null
         returning id
       ),
       evenement as (
         insert into conversation_evenements (tenant_id, conversation_id, type, cause)
         select $1, maj.id, e.type, $3::text
           from maj
           left join avant on avant.id = maj.id
           cross join lateral (values
             (case when avant.id is null or avant.control_owner is distinct from 'app_human'
                        or avant.escaladee_le is null then 'passee_par_mba' end),
             (case when avant.archived_at is not null then 'desarchivee' end),
             (case when avant.traitee_le is not null then 'non_traitee' end)
           ) as e(type)
          where e.type is not null
       )
       select id from maj`,
      [tenantId, waId, borner(cause)],
    );
  }

  /**
   * Marque un fil « à rendre à l'agent de Meta dès que notre dernier envoi sera acquitté », et rend
   * l'identifiant de ce message, ou `null`.
   *
   * On ne relâche pas dans la foulée de l'envoi : envoyer un message prend le fil implicitement chez Meta, et un
   * release émis juste après serait repris par cet envoi. On attend la preuve que Meta a traité le dernier envoi
   * (le dernier, pas un : l'accusé du premier arrive souvent après le départ du dernier). Pas d'attente, donc
   * `null`, si ce dernier envoi :
   *  - est suivi d'un message entrant (le client l'a reçu ; on lit les messages, pas `last_direction`) ;
   *  - est déjà acquitté (`accuse_le`, posé par `consommerReleaseMba`) ;
   *  - date de plus de `ENVOI_EN_VOL` (Meta acquitte en une seconde, et d'anciens envois n'ont pas d'accusé
   *    écrit) ;
   *  - ou n'existe pas (parcours sans envoi) : l'appelant relâche tout de suite.
   * L'écho de l'agent de Meta (`type = 'mba'`) n'est pas notre envoi. Fenêtre résiduelle : un client qui écrit
   * dans la seconde de notre envoi ; le balayage reste le filet.
   */
  async demanderReleaseMba(tenantId: string, waId: string): Promise<string | null> {
    const res = await this.pool.query<{ release_mba_apres_message: string | null }>(
      `update conversations c
          set release_mba_apres_message = (
            select d.meta_message_id
              from (select m.meta_message_id, m.accuse_le, m.created_at
                      from conversation_messages m
                     where m.conversation_id = c.id and m.direction = 'out' and m.meta_message_id is not null
                       and m.type is distinct from 'mba'
                     order by m.created_at desc limit 1) d
             where d.accuse_le is null
               and d.created_at > now() - $3::interval
               and not exists (select 1 from conversation_messages i
                                where i.conversation_id = c.id and i.direction = 'in'
                                  and i.created_at > d.created_at))
        where c.tenant_id = $1 and c.wa_id = $2
       returning c.release_mba_apres_message`,
      [tenantId, waId, ENVOI_EN_VOL],
    );
    return res.rows[0]?.release_mba_apres_message ?? null;
  }

  /**
   * Consomme la demande de remise que ce message portait, et rend le fil concerné (`null` dans l'écrasante
   * majorité des statuts). Une seule requête : Meta envoie plusieurs statuts par message, et seul le premier
   * appelant obtient une ligne. Elle pose aussi l'accusé du message, que `demanderReleaseMba` lit.
   *
   * `tenant_id` n'est pas dans le `where`, et c'est juste ici : le webhook ne connaît que l'identifiant de
   * message, unique dans toute la base (`conversation_messages_wamid_uidx`), et c'est le `tenant_id` rendu qui
   * lui apprend l'espace.
   */
  async consommerReleaseMba(messageId: string): Promise<{ tenantId: string; waId: string } | null> {
    const res = await this.pool.query<{ tenant_id: string; wa_id: string }>(
      `with accuse as (
         update conversation_messages set accuse_le = now()
          where meta_message_id = $1 and accuse_le is null
       )
       update conversations c set release_mba_apres_message = null
        where c.release_mba_apres_message = $1
       returning c.tenant_id, c.wa_id`,
      [messageId],
    );
    const r = res.rows[0];
    return r ? { tenantId: r.tenant_id, waId: r.wa_id } : null;
  }

  /**
   * Les conversations dont le contrôle est détenu, les plus anciennes d'abord : alimente le garde-fou
   * d'inactivité (Meta n'a aucun release automatique). Pas de filtre d'âge en SQL pour les fils humains ou MBA
   * (délai réglable par client, décision en mémoire). `control_changed_at` null est éligible.
   */
  async listHeldControl(
    limit = 500,
    ageScenarioMs = 0,
  ): Promise<Array<{ tenantId: string; waId: string; owner: ControlOwner; changedAt: Date | null; lastMessageAt: Date | null; escaladee: boolean }>> {
    /**
     * Les fils tenus par un scénario entrent aussi, puisque `take` prend le fil pour de vrai : un parcours
     * abandonné le garderait à jamais. Leur délai est fixe, donc filtré ici ; sans ce filtre, `app_workflow`
     * (l'état normal) saturerait le lot de 500 et les fils humains à rendre ne seraient jamais atteints.
     *
     * `control_changed_at is null` est éligible : envoyer un message prend le fil chez Meta, donc une
     * conversation née d'un envoi sortant porte `app_workflow` + `null` alors que nous tenons le fil. C'est la
     * fenêtre qui borne (activité dans les dernières 24 h), pas l'âge du contrôle : un `coalesce` sur
     * `last_message_at` rendrait la branche morte. Un dernier message vieux de plus de 24 h prouve une fenêtre
     * fermée ; l'inverse n'est pas vrai, le balayage appelle Meta avant d'écrire.
     *
     * Les escalades sortent du lot en SQL : elles s'accumulaient en tête du tri et pouvaient remplir les 500
     * places. La garde de `runControlSweep` reste le contrat.
     */
    const res = await this.pool.query<{ tenant_id: string; wa_id: string; control_owner: ControlOwner; control_changed_at: Date | null; last_message_at: Date | null; escaladee: boolean }>(
      `select tenant_id, wa_id, control_owner, control_changed_at, last_message_at, escaladee_le is not null as escaladee
       from conversations
       where (escaladee_le is null or control_owner <> 'app_human')
         and (control_owner <> 'app_workflow'
          or (
            $2::bigint > 0
            and last_message_at > now() - interval '24 hours'
            and (
              control_changed_at is null
              or control_changed_at < now() - make_interval(secs => $2::bigint / 1000.0)
            )
          ))
       order by control_changed_at nulls first
       limit $1`,
      [limit, Math.max(0, Math.floor(ageScenarioMs))],
    );
    return res.rows.map((r) => ({
      tenantId: r.tenant_id,
      waId: r.wa_id,
      owner: r.control_owner,
      changedAt: r.control_changed_at,
      lastMessageAt: r.last_message_at,
      escaladee: r.escaladee === true,
    }));
  }

  /**
   * Marque le fil comme une conversation de test (jeton de test d'un scénario). Sens unique. Exclut le fil de
   * l'analyse (donc du push HubSpot) et des statistiques. Update seul : `recordInbound` a déjà créé la
   * conversation.
   */
  async markConversationTest(tenantId: string, waId: string): Promise<void> {
    await this.pool.query(
      `update conversations set is_test = true where tenant_id = $1 and wa_id = $2 and not is_test`,
      [tenantId, waId],
    );
  }

  /**
   * Cette conversation est-elle un fil de test ? Absente -> `false`. Sert à ne pas renvoyer le fil chez l'agent
   * de Meta au milieu d'une série d'essais : un testeur le réenclenche lui-même depuis l'Inbox.
   */
  async estConversationDeTest(tenantId: string, waId: string): Promise<boolean> {
    const res = await this.pool.query<{ is_test: boolean }>(
      `select is_test from conversations where tenant_id = $1 and wa_id = $2`,
      [tenantId, waId],
    );
    return res.rows[0]?.is_test === true;
  }

  /** `channel` : le fil est unique par contact, c'est la bulle qui porte le tuyau. Absent -> WhatsApp. */
  async recordInbound(tenantId: string, m: InboundMessage, channel: 'whatsapp' | 'rcs' = 'whatsapp'): Promise<void> {
    const preview = m.body ?? m.buttonPayload ?? `[${m.type}]`;
    // Un message du contact rouvre la conversation (hors d'Archivé, plus « Traité ») : seul chemin qui le fait.
    // Une réaction (👍) sort seulement d'Archivé, sans retirer « Traité » ni changer qui a parlé en dernier.
    const reaction = m.type === 'reaction';
    const conversationId = await this.upsertConversationByWaId(
      tenantId, m.waId, preview, { archive: true, traite: !reaction }, reaction ? 'reaction' : 'in',
    );
    await this.pool.query(
      // `media_id`, `media_mime` et `media_nom` sont écrits ici et nulle part ailleurs : seul instant où le corps
      // du webhook est sous la main, un média non capté à l'insertion est perdu.
      `insert into conversation_messages (conversation_id, direction, type, body, button_payload, meta_message_id, channel, media_id, media_mime, media_nom)
       values ($1, 'in', $2, $3, $4, $5, $6, $7, $8, $9)
       on conflict (meta_message_id) where meta_message_id is not null do nothing`,
      [conversationId, m.type, m.body, m.buttonPayload, m.messageId, channel, m.media?.id ?? null, m.media?.mime ?? null, m.media?.nom ?? null],
    );
  }

  /**
   * Journalise un envoi sortant automatisé (template de campagne ou de scénario) par wa_id : upsert la
   * conversation et insère le message 'out' avec `sender_user_id = null` (pas de pastille agent). Idempotent
   * sur `meta_message_id`. À appeler en best-effort : un échec de journal ne doit pas casser l'envoi Meta.
   */
  async recordOutboundByWaId(
    tenantId: string,
    waId: string,
    msg: { body: string; messageId: string | null; type?: string; templateCategory?: string | null; templateName?: string | null; channel?: 'whatsapp' | 'rcs'; origine: OrigineMessage },
  ): Promise<void> {
    // Un envoi automatisé ne rouvre rien : une campagne ferait sinon remonter tous les contacts rangés ou traités.
    const conversationId = await this.upsertConversationByWaId(tenantId, waId, msg.body, { archive: false, traite: false }, 'out');
    await this.pool.query(
      // `origine` est obligatoire : c'est la seule chose qui distingue un envoi de scénario d'une réponse d'agent
      // IA, et le type l'exige pour que l'oubli ne compile pas.
      `insert into conversation_messages (conversation_id, direction, type, body, meta_message_id, template_category, template_name, sender_user_id, channel, origin)
       values ($1, 'out', $2, $3, $4, $5, $6, null, $7, $8)
       on conflict (meta_message_id) where meta_message_id is not null do nothing`,
      [conversationId, msg.type ?? 'template', msg.body, msg.messageId, msg.templateCategory ?? null, msg.templateName ?? null, msg.channel ?? 'whatsapp', msg.origine],
    );
  }

  /**
   * Trouve ou crée la conversation d'un contact (« Ouvrir la conversation » du mini-CRM), et rend son
   * identifiant.
   *
   * Elle ne fait semblant de rien : contrairement à `upsertConversationByWaId`, aucun sens n'est écrit (rien n'a
   * été dit), donc le fil n'entre pas dans « À traiter ». Un fil neuf prend `last_message_at = now()` et
   * apparaît en tête ; un fil existant n'est pas remonté. L'unique `(tenant_id, wa_id)` empêche un doublon du
   * fil que l'inbound alimentera.
   *
   * `null` quand le contact est inconnu de l'espace, supprimé, bloqué (il n'apparaît nulle part dans l'inbox :
   * on refuse plutôt que d'ouvrir un cul-de-sac) ou sans identité WhatsApp.
   */
  async ouvrirConversationDuContact(tenantId: string, contactId: string): Promise<string | null> {
    const res = await this.pool.query<{ id: string }>(
      `with ${CIBLE_DU_CONTACT_SQL}
       insert into conversations (tenant_id, wa_id, contact_id)
       select $1, cible.wa_id, $2::uuid from cible where cible.wa_id is not null
       on conflict (tenant_id, wa_id) do update
         set contact_id = coalesce(conversations.contact_id, excluded.contact_id)
       returning id::text as id`,
      [tenantId, contactId],
    );
    return res.rows[0]?.id ?? null;
  }

  /**
   * Le fil d'un contact, cherché sans être créé (`POST /v1/messages/whatsapp`) : lecture seule, aucun refus ne
   * laisse de fil vide en tête de l'Inbox. Sans fil, la fenêtre de 24 h est fermée par construction. Un fil
   * existant sans `contact_id` n'est pas rattaché ici (le prochain entrant ou envoi le fera). Servi par la clé
   * primaire de `contacts` et l'unique `(tenant_id, wa_id)`.
   */
  async filDuContact(tenantId: string, contactId: string): Promise<FilDuContact> {
    const res = await this.pool.query<{ id: string | null }>(
      `with ${CIBLE_DU_CONTACT_SQL}
       select conv.id::text as id
         from cible
         left join conversations conv on conv.tenant_id = $1 and conv.wa_id = cible.wa_id
        where cible.wa_id is not null`,
      [tenantId, contactId],
    );
    const ligne = res.rows[0];
    if (!ligne) return { etat: 'injoignable' };
    return ligne.id === null ? { etat: 'sans_fil' } : { etat: 'fil', conversationId: ligne.id };
  }

  /**
   * Une page de conversations, de la plus récente à la plus ancienne. Filtrage et pagination en SQL : filtrer
   * en mémoire une page chargée ferait mentir « À traiter » au-delà. Pas de `hasMore` : une page pleine veut
   * dire qu'il peut y en avoir d'autres, et un drapeau coûterait un `count`.
   */
  async listConversations(tenantId: string, opts: ListConversationsOptions = {}): Promise<ConversationSummary[]> {
    // Borné des deux côtés : un `limit` de query string ne doit ni vider la page ni ramener la table entière.
    const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 100), 1), 200);
    const params: unknown[] = [tenantId];
    const where: string[] = ['c.tenant_id = $1'];

    /**
     * Une conversation par son identifiant, avant tout filtre de dossier (`ListConversationsOptions.id`). Une
     * seule lecture de `opts.id` pour les deux conditions qui en dépendent (celle-ci et l'archivage), sinon
     * `{ id: '' }` désarmerait l'exclusion des archivées sans viser aucun fil.
     */
    const unSeulFil = typeof opts.id === 'string' && opts.id !== '';
    if (unSeulFil) {
      params.push(opts.id);
      where.push(`c.id = $${params.length}::uuid`);
    }

    if (opts.aTraiter === true) {
      where.push(A_TRAITER_SQL);
    }
    // Contact bloqué : sa conversation disparaît de l'inbox. Ses messages restent enregistrés, et l'écran des
    // contacts bloqués est la seule porte de sortie.
    where.push(`(ct.blocked_at is null)`);
    // Les dossiers ordinaires excluent les archivées, le dossier Archivé ne montre qu'elles ; « Traité » n'est
    // pas exclusif. Un fil demandé par son identifiant échappe à ce filtre : sans cela, le lien « Ouvrir la
    // conversation » vers un fil archivé mènerait à une Inbox vide.
    if (!unSeulFil) {
      where.push(opts.archivees === true ? 'c.archived_at is not null' : 'c.archived_at is null');
    }
    if (opts.signalees === true) {
      // Union des deux sources, le signalement manuel en premier : indexé (`conversations_signalees_main_idx`),
      // il se teste sans sous-requête et laisse court-circuiter le constat de l'analyse.
      where.push(`(c.signalee_le is not null or exists (select 1 from conversation_analysis a where a.conversation_id = c.id and a.abusive))`);
    }
    if (opts.traitees === true) where.push('c.traitee_le is not null');
    if (opts.affectee === 'aucune') {
      where.push('c.assigned_to is null');
    } else if (opts.affectee !== undefined) {
      params.push(opts.affectee);
      where.push(`c.assigned_to = $${params.length}::uuid`);
    }
    if (opts.before) {
      // Comparaison de tuple : `(a, b) < (x, y)` suit exactement l'ordre de tri, donc la page suivante reprend
      // pile où la précédente s'est arrêtée, même quand deux fils partagent le même horodatage.
      params.push(opts.before.at, opts.before.id);
      where.push(`(c.last_message_at, c.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
    }
    params.push(limit);

    const res = await this.pool.query<{
      id: string; wa_id: string; profile_name: string | null; last_preview: string | null; last_message_at: Date; curseur: string;
      control_owner: ControlOwner; unread: boolean; assigned_to: string | null; assigned_name: string | null;
      signalee_main: boolean; traitee: boolean;
    }>(
      // curseur : le même instant que last_message_at, en texte à la microseconde (`ConversationSummary.curseur`).
      `select c.id, c.wa_id, ct.profile_name, c.last_preview, c.last_message_at, c.control_owner,
              to_char(c.last_message_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as curseur,
              ${UNREAD_SQL} as unread, c.assigned_to,
              -- ⚠️ coalesce ET NON u.name SEUL : sans nom, l ecran affichait « suivi par … », c est-a-dire
              -- rien du tout, alors qu il a toujours l adresse sous la main. Le repli est le meme que partout
              -- ailleurs (charge par membre, selecteur d affectation) : un nom si on en a un, l adresse sinon.
              -- ⚠️ Aucun accent grave dans ce commentaire : il vit DANS un gabarit TypeScript.
              coalesce(u.name, u.email) as assigned_name,
              (c.signalee_le is not null) as signalee_main,
              (c.traitee_le is not null) as traitee
       from conversations c
       left join contacts ct on ct.id = c.contact_id
       left join users u on u.id = c.assigned_to
       where ${where.join(' and ')}
       order by c.last_message_at desc, c.id desc
       limit $${params.length}`,
      params,
    );
    return res.rows.map((r) => ({
      id: r.id,
      waId: r.wa_id,
      profileName: r.profile_name,
      lastPreview: r.last_preview,
      lastMessageAt: r.last_message_at.toISOString(),
      curseur: r.curseur,
      controlOwner: r.control_owner,
      unread: r.unread,
      assignedTo: r.assigned_to,
      assignedToName: r.assigned_name,
      signaleeMain: r.signalee_main === true,
      traitee: r.traitee === true,
    }));
  }

  /**
   * Purge par rétention des conversations dont la dernière activité dépasse la durée de leur espace (sinon
   * `days`, le défaut de l'instance), tous espaces confondus.
   *
   * 🔴 Irréversible : les messages et l'analyse (texte libre produit à partir de ce que la personne a raconté)
   * partent avec, par les cascades, en une commande atomique. La fiche du contact reste (l'effacement d'une
   * personne passe par `purgeMany`).
   *
   * Le `coalesce` est dans les deux moitiés de la condition (filtre et âge), sinon on effacerait selon une
   * durée que personne n'a choisie. `left join` : un espace sans ligne de réglages doit être purgé au défaut.
   * Effacement borné par passage (verrou, WAL) : le balayage repasse.
   */
  async purgeConversationsOlderThan(days: number, maxParPassage = 500): Promise<number> {
    /**
     * 🔴 `days <= 0` arrête tout, y compris les espaces qui ont réglé leur propre durée : c'est le levier
     * d'urgence de la seule opération irréversible du dépôt (sans lui, `make_interval(days => 0)` viserait
     * tout). Le `0` par espace ne désactive que cet espace (`coalesce(...) > 0`).
     */
    if (days <= 0) return 0;
    const res = await this.pool.query(
      `delete from conversations
        where id in (
          select cv.id
            from conversations cv
            left join tenant_settings ts on ts.tenant_id = cv.tenant_id
           where coalesce(ts.conversation_retention_days, $1::int) > 0
             and cv.last_message_at < now() - make_interval(days => coalesce(ts.conversation_retention_days, $1::int))
           limit $2
        )`,
      [Math.floor(days), Math.max(1, maxParPassage)],
    );
    return res.rowCount ?? 0;
  }

  /**
   * 🔴 Nombre de conversations non lues visibles par cet acteur (pastille de l'onglet Inbox), selon la règle de
   * `peutEcrire` : le pot commun pour tout le monde, le reste pour son affectataire, tout pour un manager ou un
   * admin. `acteur` est obligatoire, sans défaut : un oubli rendrait la pastille de l'espace à qui n'a pas le
   * droit de la voir.
   */
  async countUnread(tenantId: string, acteur: ActeurConversation): Promise<number> {
    const res = await this.pool.query<{ n: string }>(
      // Les mêmes exclusions que la liste (archivées, bloquées) : une pastille qui compte ce que l'écran ne
      // montre pas ne peut plus être éteinte.
      `select count(*)::text as n
         from conversations c
         left join contacts ct on ct.id = c.contact_id
        where c.tenant_id = $1 and c.archived_at is null and ct.blocked_at is null
          and ${visibiliteSql('$2', '$3')} and ${UNREAD_SQL}`,
      // L'identifiant ne sert qu'à un acteur qui ne voit pas tout : l'identité d'observation de /ops n'est pas
      // un uuid et ferait planter la conversion `::uuid` de `visibiliteSql`.
      [tenantId, voitTout(acteur), voitTout(acteur) ? null : acteur.userId],
    );
    return Number(res.rows[0]?.n ?? 0);
  }

  /**
   * Les compteurs du menu de dossiers, en une requête pour tous les dossiers et une seconde pour la charge :
   * des chiffres lus à des instants différents ne s'accorderaient pas à l'écran. Les contacts bloqués sont
   * exclus partout, comme dans la liste, et « Tout » exclut les archivées.
   */
  async compterConversations(tenantId: string): Promise<CompteursInbox> {
    const res = await this.pool.query<{
      tout: string; a_traiter: string; signalees: string; archivees: string; traitees: string; non_affectees: string;
    }>(
      `select
         count(*) filter (where c.archived_at is null)::text as tout,
         count(*) filter (where c.archived_at is null and ${A_TRAITER_SQL})::text as a_traiter,
         count(*) filter (where c.archived_at is null and (c.signalee_le is not null or exists (
           select 1 from conversation_analysis a where a.conversation_id = c.id and a.abusive)))::text as signalees,
         count(*) filter (where c.archived_at is not null)::text as archivees,
         count(*) filter (where c.archived_at is null and c.traitee_le is not null)::text as traitees,
         count(*) filter (where c.archived_at is null and c.assigned_to is null)::text as non_affectees
         from conversations c
         left join contacts ct on ct.id = c.contact_id
        where c.tenant_id = $1 and ct.blocked_at is null`,
      [tenantId],
    );
    /**
     * La charge par membre : tous les membres de l'espace, y compris à zéro (c'est l'information cherchée).
     * Tri par nombre puis par nom, pour que deux membres à égalité ne changent pas de place.
     */
    const membres = await this.pool.query<{ user_id: string; nom: string | null; email: string; n: string }>(
      `select u.id as user_id, u.name as nom, u.email,
              count(c.id) filter (where c.archived_at is null and ct.blocked_at is null)::text as n
         from users u
         left join conversations c on c.assigned_to = u.id and c.tenant_id = $1
         left join contacts ct on ct.id = c.contact_id
        where u.tenant_id = $1
        group by u.id, u.name, u.email
        order by count(c.id) filter (where c.archived_at is null and ct.blocked_at is null) desc,
                 coalesce(u.name, u.email) asc`,
      [tenantId],
    );
    const r = res.rows[0];
    return {
      tout: Number(r?.tout ?? 0),
      aTraiter: Number(r?.a_traiter ?? 0),
      signalees: Number(r?.signalees ?? 0),
      archivees: Number(r?.archivees ?? 0),
      traitees: Number(r?.traitees ?? 0),
      nonAffectees: Number(r?.non_affectees ?? 0),
      // Le nom affichable, jamais vide : un membre sans nom se reconnaît à son e-mail.
      parMembre: membres.rows.map((m) => ({ userId: m.user_id, nom: m.nom ?? m.email, n: Number(m.n) })),
    };
  }

  /**
   * Nombre de conversations « À traiter », pour le compteur de l'onglet, calculé en base et non sur la page
   * chargée.
   */
  async countATraiter(tenantId: string): Promise<number> {
    const res = await this.pool.query<{ n: string }>(
      // Les mêmes exclusions que le menu et la liste (archivées, bloquées). La route qui l'expose n'a plus
      // d'appelant, mais une route qui rendrait un chiffre faux serait un piège pour qui la rebranchera.
      `select count(*)::text as n
         from conversations c
         left join contacts ct on ct.id = c.contact_id
        where c.tenant_id = $1 and ${A_TRAITER_SQL}
          and c.archived_at is null and ct.blocked_at is null`,
      [tenantId],
    );
    return Number(res.rows[0]?.n ?? 0);
  }

  /**
   * Range une conversation dans Archivé, ou l'en sort. `false` si la conversation est inconnue dans cet espace
   * (404, jamais un succès silencieux). 🔴 Le `tenant_id` du `where` est le contrôle d'isolation : le pooler
   * est superuser, la RLS est contournée. Idempotent, et désarchiver ce qui ne l'est pas rend `true`.
   */
  async archiverConversation(tenantId: string, conversationId: string, archive: boolean, par: AuteurDuChangement): Promise<boolean> {
    return this.basculerRangement(tenantId, conversationId, 'archived_at', archive, par, ['archivee', 'desarchivee']);
  }

  /**
   * Marque une conversation « Traité », ou retire ce statut. Même contrat que `archiverConversation`. Retirer
   * le statut ne remet pas forcément « À traiter » : la conversation retourne là où son dernier message la
   * range, d'où « Ne plus marquer traité » à l'écran et non « Remettre à traiter ».
   */
  async marquerTraitee(tenantId: string, conversationId: string, traitee: boolean, par: AuteurDuChangement): Promise<boolean> {
    return this.basculerRangement(tenantId, conversationId, 'traitee_le', traitee, par, ['traitee', 'non_traitee']);
  }

  /**
   * Le rangement « Archivé » ou « Traité », posé ou retiré, et son événement dans la même requête. Les deux
   * gestes clôturent aussi une escalade quand ils se posent : « Traité », l'opérateur a jugé qu'il n'y avait rien
   * à répondre ; « Archivé », sinon le fil quitte la liste sans que rien ne le rende jamais à l'agent (le balayage
   * saute les escalades).
   *
   * Idempotent pour l'appelant (rendre `true` sur une conversation déjà rangée), mais pas pour le journal :
   * l'événement ne s'écrit que si la colonne passe de nulle à posée, ou l'inverse. `colonne` ne vient jamais
   * d'une entrée : c'est l'un des deux littéraux du type.
   */
  private async basculerRangement(
    tenantId: string,
    conversationId: string,
    colonne: 'archived_at' | 'traitee_le',
    pose: boolean,
    par: AuteurDuChangement,
    types: readonly [TypeEvenement, TypeEvenement],
  ): Promise<boolean> {
    const auteur = colonnesAuteur(par);
    const res = await this.pool.query(
      // Le drapeau passe en paramètre, jamais concaténé ; la colonne est un littéral du code. L'état d'avant est
      // lu dans un sous-select VERROUILLÉ : c'est lui qui dit si le geste change quelque chose.
      `with maj as (
         update conversations c set ${colonne} = case when $3::boolean then now() else null end,
                escaladee_le = case when $3::boolean then null else c.escaladee_le end
           from (select id as avant_id, ${colonne} as avant_valeur
                   from conversations where id = $1 and tenant_id = $2 for no key update) avant
          where c.id = avant.avant_id
         returning c.id, avant.avant_valeur
       ),
       evenement as (
         insert into conversation_evenements (tenant_id, conversation_id, type, acteur_id, cause)
         select $2, maj.id, case when $3::boolean then $6::text else $7::text end, ${acteurSql('$4', '$2')}, $5::text
           from maj where (maj.avant_valeur is null) = $3::boolean
       )
       select id from maj`,
      [conversationId, tenantId, pose, auteur.acteur, auteur.cause, types[0], types[1]],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /**
   * Signale une conversation à la main, ou retire ce signalement. N'écrit jamais
   * `conversation_analysis.abusive`, constat du modèle recalculé à chaque analyse, qui effacerait un
   * signalement humain. L'auteur est effacé avec le signalement, sinon il laisserait croire à un signalement
   * actif. Événement `signalee` / `designalee` seulement si le signalement manuel change.
   */
  async signalerConversation(tenantId: string, conversationId: string, signale: boolean, par: AuteurDuChangement): Promise<boolean> {
    const auteur = colonnesAuteur(par);
    const res = await this.pool.query(
      // Le drapeau est un paramètre ; l'auteur suit le drapeau. `signalee_par` reçoit l'acteur NETTOYÉ
      // (`colonnesAuteur`) : un identifiant qui n'est pas un uuid faisait échouer le signalement entier.
      `with maj as (
         update conversations c
            set signalee_le = case when $3::boolean then now() else null end,
                signalee_par = case when $3::boolean then ${acteurSql('$4', '$2')} else null end
           from (select id as avant_id, signalee_le as avant_valeur
                   from conversations where id = $1 and tenant_id = $2 for no key update) avant
          where c.id = avant.avant_id
         returning c.id, avant.avant_valeur
       ),
       evenement as (
         insert into conversation_evenements (tenant_id, conversation_id, type, acteur_id, cause)
         select $2, maj.id, case when $3::boolean then 'signalee' else 'designalee' end, ${acteurSql('$4', '$2')}, $5::text
           from maj where (maj.avant_valeur is null) = $3::boolean
       )
       select id from maj`,
      [conversationId, tenantId, signale, auteur.acteur, auteur.cause],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /**
   * Affecte une conversation à un membre, ou la libère (`assignee` à null). 🔴 Scopée au tenant, et
   * l'affectataire est vérifié dans le même espace par la même requête : un utilisateur d'un autre client
   * rendrait la conversation inaccessible à tous. `false` si la conversation est inconnue ou l'affectataire
   * étranger (404).
   *
   * `par` : un collaborateur (la console), ou une cause (agent tiers par MCP). L'événement suit la VALEUR :
   * `assignee` quand l'affectataire change (la cible est le nouveau), `desassignee` quand une conversation
   * affectée est libérée (la cible est l'ancien) ; réassigner au même ou libérer une libre n'écrit rien.
   */
  async setAssignee(tenantId: string, conversationId: string, assignee: string | null, par: AuteurDuChangement): Promise<boolean> {
    const auteur = colonnesAuteur(par);
    if (assignee === null) {
      const res = await this.pool.query(
        `with maj as (
           update conversations c set assigned_to = null, assigned_at = null, assigned_by = null
             from (select id as avant_id, assigned_to as ancien
                     from conversations where id = $1 and tenant_id = $2 for no key update) avant
            where c.id = avant.avant_id
           returning c.id, avant.ancien
         ),
         evenement as (
           insert into conversation_evenements (tenant_id, conversation_id, type, acteur_id, cible_id, cause)
           select $2, maj.id, 'desassignee', ${acteurSql('$3', '$2')}, maj.ancien, $4::text
             from maj where maj.ancien is not null
         )
         select id from maj`,
        [conversationId, tenantId, auteur.acteur, auteur.cause],
      );
      return (res.rowCount ?? 0) > 0;
    }
    const res = await this.pool.query(
      // `assigned_by` reçoit l'acteur résolu dans l'espace : c'était l'identifiant brut de la session.
      `with maj as (
         update conversations c set assigned_to = $3::uuid, assigned_at = now(), assigned_by = ${acteurSql('$4', '$2')}
           from (select id as avant_id, assigned_to as ancien
                   from conversations where id = $1 and tenant_id = $2 for no key update) avant
          where c.id = avant.avant_id
            and exists (select 1 from users u where u.id = $3::uuid and u.tenant_id = $2 and u.disabled_at is null)
         returning c.id, avant.ancien
       ),
       evenement as (
         insert into conversation_evenements (tenant_id, conversation_id, type, acteur_id, cible_id, cause)
         select $2, maj.id, 'assignee', ${acteurSql('$4', '$2')}, $3::uuid, $5::text
           from maj where maj.ancien is distinct from $3::uuid
       )
       select id from maj`,
      [conversationId, tenantId, assignee, auteur.acteur, auteur.cause],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /**
   * Prend une conversation du pot commun : l'affecte à `userId` seulement si elle n'est à personne.
   * `assigned_to is null` est dans le `where` : deux agents qui cliquent ensemble ne peuvent pas se la prendre
   * l'un à l'autre. `assigned_by` vaut l'agent lui-même (prise), distinct d'une distribution ou d'un routage
   * (`null`). Même garde d'espace que `setAssignee`. `false` si inconnue ou déjà prise (l'appelant relit pour
   * dire 404 ou 409). Une prise qui a lieu est toujours un changement : son événement porte l'agent comme
   * acteur ET comme cible, que la lecture marque `prise` et que la frise dit « Prise en charge », par lui.
   */
  async prendreSiLibre(tenantId: string, conversationId: string, userId: string): Promise<boolean> {
    const res = await this.pool.query(
      `with maj as (
         update conversations set assigned_to = $3::uuid, assigned_at = now(), assigned_by = $3::uuid
          where id = $1 and tenant_id = $2 and assigned_to is null
            and exists (select 1 from users u where u.id = $3::uuid and u.tenant_id = $2 and u.disabled_at is null)
         returning id
       ),
       evenement as (
         insert into conversation_evenements (tenant_id, conversation_id, type, acteur_id, cible_id)
         select $2, maj.id, 'assignee', $3::uuid, $3::uuid from maj
       )
       select id from maj`,
      [conversationId, tenantId, userId],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /**
   * Les membres à qui l'encadrement peut confier une conversation, pour le sélecteur de l'Inbox (`GET /users`
   * est réservé aux admins, un manager y trouvait une liste vide). Seulement le nom affichable. Même critère que
   * `setAssignee` (compte non révoqué) et non celui du tour de rôle : proposer moins que ce que l'écriture
   * accepte cacherait un geste permis.
   */
  async membresPourAffectation(tenantId: string): Promise<Array<{ id: string; nom: string }>> {
    const res = await this.pool.query<{ id: string; nom: string }>(
      `select id, coalesce(nullif(name, ''), email) as nom from users
        where tenant_id = $1 and disabled_at is null
        order by lower(coalesce(nullif(name, ''), email)) asc, id asc`,
      [tenantId],
    );
    return res.rows;
  }

  /**
   * À qui cette conversation est-elle confiée ? 🔴 `undefined` = inconnue pour ce tenant, pas `null` (connue,
   * confiée à personne) : les confondre laisserait écrire dans la conversation d'un autre espace, « personne »
   * valant « ouverte à tous ».
   */
  async getAssignee(tenantId: string, conversationId: string): Promise<string | null | undefined> {
    const res = await this.pool.query<{ assigned_to: string | null }>(
      `select assigned_to from conversations where id = $1 and tenant_id = $2`,
      [conversationId, tenantId],
    );
    if (res.rows.length === 0) return undefined;
    return res.rows[0]!.assigned_to;
  }

  /**
   * Le panneau Détail d'une conversation : qui est la personne, où en est la conversation, ce qui lui est arrivé
   * (cadrage du 2026-09-28). `null` = inconnue dans cet espace, OU invisible de cet acteur, et les deux se disent
   * pareil (404) : un agent n'apprend pas qu'une conversation existe chez un collègue.
   *
   * 🔴 LA VISIBILITÉ EST CELLE DE `src/inbox/assignment.ts` (`visibiliteSql`, la même règle que `peutEcrire`) :
   * l'encadrement voit tout, un agent les siennes et le pot commun. L'identifiant ne part en `::uuid` que pour un
   * acteur qui ne voit pas tout, et seulement s'il en est un : une clé d'API ou l'identité d'observation de /ops
   * ferait sinon échouer la requête au lieu de ne rien montrer.
   */
  async detailConversation(tenantId: string, conversationId: string, acteur: ActeurConversation): Promise<DetailConversation | null> {
    const tout = voitTout(acteur);
    const moi = !tout ? colonnesAuteur({ collaborateur: acteur.userId }).acteur : null;
    const res = await this.pool.query<{
      id: string; wa_id: string; contact_id: string | null; nom: string | null; prenom: string | null;
      telephone: string | null; email: string | null; tags: string[] | null; desabonne: boolean | null;
      bloque: boolean | null; assigned_to: string | null; assigne_nom: string | null; resume: string | null;
    }>(
      // Le contact est relu DANS l'espace et vivant : une fiche supprimée ne prête plus son identité. `name`
      // et `phone` sont des colonnes, `prenom` et `email` des clés du jsonb (champs système, `src/crm/fields.ts`).
      `select c.id, c.wa_id, ct.id as contact_id, ct.profile_name as nom, ct.fields ->> 'prenom' as prenom,
              ct.phone_e164 as telephone, ct.fields ->> 'email' as email, ct.tags,
              (ct.opt_in_status = 'opted_out') as desabonne, (ct.blocked_at is not null) as bloque,
              c.assigned_to, coalesce(nullif(u.name, ''), u.email) as assigne_nom, a.summary as resume
         from conversations c
         left join contacts ct on ct.id = c.contact_id and ct.tenant_id = c.tenant_id and ct.deleted_at is null
         left join users u on u.id = c.assigned_to and u.tenant_id = c.tenant_id
         left join conversation_analysis a on a.conversation_id = c.id
        where c.id = $1 and c.tenant_id = $2 and ${visibiliteSql('$3', '$4')}`,
      [conversationId, tenantId, tout, moi],
    );
    const r = res.rows[0];
    if (!r) return null;

    const ev = await this.pool.query<{
      id: string; type: TypeEvenement; at: Date; cause: string | null;
      acteur_id: string | null; acteur_trouve: boolean; acteur_nom: string | null;
      cible_id: string | null; cible_trouvee: boolean; cible_nom: string | null;
      reassignation: boolean;
    }>(
      // La réassignation se lit sur l'événement d'assignation qui PRÉCÈDE celui-ci dans toute la vie de la
      // conversation, pas seulement dans les 50 rendus : servie par l'index (conversation_id, at desc, id desc).
      // L'identité départage deux événements de la même seconde dans leur ordre d'écriture.
      // 🔴 Les noms ne se lisent que DANS l'espace (`u.tenant_id = e.tenant_id`, relecture du 2026-09-29) : les
      // écritures le garantissent (`acteurSql`), mais l'amorçage de 0192 a recopié `assigned_by` et `signalee_par`
      // sans ce filtre. Un identifiant d'un autre espace n'y prête donc jamais son nom.
      `select e.id::text as id, e.type, e.at, e.cause,
              e.acteur_id, (ua.id is not null) as acteur_trouve, coalesce(nullif(ua.name, ''), ua.email) as acteur_nom,
              e.cible_id, (uc.id is not null) as cible_trouvee, coalesce(nullif(uc.name, ''), uc.email) as cible_nom,
              (e.type = 'assignee' and coalesce((
                 select p.type = 'assignee'
                   from conversation_evenements p
                  where p.conversation_id = e.conversation_id and p.tenant_id = $2
                    and p.type in ('assignee', 'desassignee')
                    and (p.at, p.id) < (e.at, e.id)
                  order by p.at desc, p.id desc
                  limit 1), false)) as reassignation
         from conversation_evenements e
         left join users ua on ua.id = e.acteur_id and ua.tenant_id = e.tenant_id
         left join users uc on uc.id = e.cible_id and uc.tenant_id = e.tenant_id
        where e.conversation_id = $1 and e.tenant_id = $2
        order by e.at desc, e.id desc
        limit $3`,
      [conversationId, tenantId, HISTORIQUE_MAX],
    );

    const historique: EvenementConversation[] = ev.rows.map((e) => {
      const assignation = e.type === 'assignee' || e.type === 'desassignee';
      /**
       * Un acteur nul SANS cause est un collaborateur supprimé depuis (`on delete set null`) : un changement
       * automatique porte toujours sa cause, et une identité qui n'est pas un collaborateur (clé d'API, session sans
       * compte) aussi, depuis le 2026-09-29 (`colonnesAuteur`). Un identifiant qu'on ne retrouve pas DANS l'espace ne
       * se nomme pas non plus. La cible n'a de sens que pour une assignation, où elle est toujours écrite : nulle ou
       * introuvable, c'est elle aussi un collaborateur parti.
       */
      const acteurVu: QuiEvenement = e.acteur_id !== null
        ? (e.acteur_trouve ? { nom: e.acteur_nom ?? '' } : { ancien: true })
        : e.cause === null ? { ancien: true } : null;
      const cibleVue: QuiEvenement = !assignation ? null
        : e.cible_id !== null && e.cible_trouvee ? { nom: e.cible_nom ?? '' } : { ancien: true };
      return {
        id: e.id, type: e.type, at: e.at.toISOString(), acteur: acteurVu, cible: cibleVue,
        cause: e.cause, reassignation: e.reassignation === true,
        // Une assignation que le collaborateur se fait à lui-même : l'écran dit « Prise en charge ».
        prise: e.type === 'assignee' && e.acteur_id !== null && e.acteur_id === e.cible_id,
      };
    });

    return {
      conversationId: r.id,
      identite: {
        contactId: r.contact_id,
        waId: r.wa_id,
        nom: r.nom,
        prenom: r.prenom,
        telephone: r.telephone,
        email: r.email,
        tags: Array.isArray(r.tags) ? r.tags : [],
        desabonne: r.desabonne === true,
        bloque: r.bloque === true,
      },
      resume: r.resume,
      assignation: r.assigned_to !== null ? { userId: r.assigned_to, nom: r.assigne_nom ?? '' } : null,
      historique,
    };
  }

  /**
   * Marque un fil comme lu (un opérateur vient de l'ouvrir). Scopé au tenant : un id de conversation d'un autre
   * espace ne marque rien. Idempotent.
   */
  async markConversationRead(tenantId: string, conversationId: string): Promise<void> {
    await this.pool.query(
      `update conversations set last_read_at = now() where id = $1 and tenant_id = $2`,
      [conversationId, tenantId],
    );
  }

  /**
   * Contexte pour répondre : wa_id et état de la fenêtre de service 24 h, ouverte si le dernier message entrant
   * WhatsApp a moins de 24 h (hors fenêtre, Meta refuse le texte libre en 131047). null si conversation absente
   * ou d'un autre tenant. `channel = 'whatsapp'` est indispensable : le fil mêle RCS et WhatsApp, et une
   * réponse RCS n'ouvre pas la fenêtre de Meta.
   */
  async getConversationContext(
    conversationId: string,
    tenantId: string,
  ): Promise<{ waId: string; lastInboundAt: string | null; windowOpen: boolean; langueContact?: string | null } | null> {
    const res = await this.pool.query<{ wa_id: string; last_in: Date | null; langue_detectee: string | null }>(
      // `contacts.langue_detectee` est nommée ici : sa migration doit passer avant le code, sinon ce `select`
      // rend `42703` et toutes les routes de l'inbox qui lisent un contexte tombent.
      `select c.wa_id, ct.langue_detectee,
              max(m.created_at) filter (where m.direction = 'in' and m.channel = 'whatsapp') as last_in
       from conversations c
       left join contacts ct on ct.id = c.contact_id
       left join conversation_messages m on m.conversation_id = c.id
       where c.id = $1 and c.tenant_id = $2
       group by c.wa_id, ct.langue_detectee`,
      [conversationId, tenantId],
    );
    const r = res.rows[0];
    if (!r) return null;
    const lastIn = r.last_in;
    const windowOpen = !!lastIn && Date.now() - lastIn.getTime() < FENETRE_SERVICE_MS;
    /**
     * `langueContact` : la langue apprise du contact, `null` tant qu'on n'a rien appris. `null` n'est pas
     * « français » : le bouton de traduction sortante nommerait sinon une mauvaise cible.
     */
    return { waId: r.wa_id, lastInboundAt: lastIn ? lastIn.toISOString() : null, windowOpen, langueContact: r.langue_detectee };
  }

  /**
   * Fenêtre de service 24 h pour un lot de wa_id (cible node de /v1/sends), même règle que
   * `getConversationContext`, en une requête. Un wa_id sans entrant est absent de la map : l'appelant le
   * traite comme fermé.
   */
  async getWindowOpenByWaIds(tenantId: string, waIds: string[]): Promise<Map<string, boolean>> {
    const out = new Map<string, boolean>();
    if (waIds.length === 0) return out;
    const res = await this.pool.query<{ wa_id: string; last_in: Date | null }>(
      `select c.wa_id, max(m.created_at) filter (where m.direction = 'in' and m.channel = 'whatsapp') as last_in
       from conversations c
       left join conversation_messages m on m.conversation_id = c.id
       where c.tenant_id = $1 and c.wa_id = any($2::text[])
       group by c.wa_id`,
      [tenantId, waIds],
    );
    for (const r of res.rows) {
      if (!r.last_in) continue; // aucun inbound -> fenêtre jamais ouverte, on laisse absent
      out.set(r.wa_id, Date.now() - r.last_in.getTime() < FENETRE_SERVICE_MS);
    }
    return out;
  }

  /**
   * Les messages d'un fil, ou seulement ceux d'après un point donné : le fil ouvert se rafraîchit toutes les
   * 4 s, et retélécharger 500 messages à chaque tour serait du gaspillage.
   *
   * Le point de reprise est le couple `(created_at, id)`, jamais l'identifiant seul : deux messages peuvent
   * porter le même horodatage. L'`order by` porte les deux colonnes pour que comparaison et tri parlent de la
   * même chose ; le tri doit être déterministe, l'ordre d'affichage de deux messages simultanés est indifférent.
   */
  async getMessages(conversationId: string, apres?: { at: string; id: string }): Promise<ConversationMessage[]> {
    const res = await this.pool.query<{
      id: string; direction: 'in' | 'out'; type: string | null; body: string | null; button_payload: string | null; created_at: Date; curseur: string; sender_name: string | null; channel: string | null; a_media: boolean; media_expire: boolean; media_nom: string | null; transcription: string | null; transcription_langue: string | null; traduction: string | null; traduction_langue: string | null; redaction_origine: string | null;
    }>(
      // sender_name : name, sinon la partie locale de l'email. curseur : cf. `ConversationMessage.curseur`. Les
      // colonnes de traduction et de transcription sont nommées ici : leur migration passe avant le code.
      `select m.id, m.direction, m.type, m.body, m.button_payload, m.created_at, m.channel,
              (m.media_id is not null) as a_media, m.transcription, m.transcription_langue,
              -- 🔴 media_nom (migration 0160) est NOMMEE ici : la migration passe donc AVANT le deploiement,
              -- sans quoi ce select rend 42703 et le fil entier tombe, toutes les 4 s.
              (m.media_id is not null and ${MEDIA_EXPIRE_SQL}) as media_expire, m.media_nom,
              m.traduction, m.traduction_langue, m.redaction_origine,
              to_char(m.created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as curseur,
              coalesce(nullif(u.name, ''), split_part(u.email, '@', 1)) as sender_name
       from conversation_messages m
       left join users u on u.id = m.sender_user_id
       where m.conversation_id = $1
         and ($2::timestamptz is null or (m.created_at, m.id) > ($2::timestamptz, $3::uuid))
       order by m.created_at, m.id limit 500`,
      [conversationId, apres?.at ?? null, apres?.id ?? null],
    );
    return res.rows.map((r) => ({
      id: r.id,
      direction: r.direction,
      type: r.type,
      body: r.body,
      buttonPayload: r.button_payload,
      createdAt: r.created_at.toISOString(),
      curseur: r.curseur,
      senderName: r.sender_name,
      // `channel` null en base (message ancien) -> WhatsApp.
      channel: r.channel === 'rcs' ? 'rcs' : 'whatsapp',
      aMedia: r.a_media === true,
      mediaExpire: r.media_expire === true,
      mediaNom: r.media_nom,
      transcription: r.transcription,
      transcriptionLangue: r.transcription_langue,
      traduction: r.traduction,
      traductionLangue: r.traduction_langue,
      redactionOrigine: r.redaction_origine,
    }));
  }

  /**
   * Le message à transcrire, relu dans son espace. 🔴 La jointure sur `conversations` est le contrôle
   * d'isolation : `conversation_messages` ne porte pas de `tenant_id`, et un identifiant deviné donnerait accès
   * au vocal d'un autre client (la RLS est contournée).
   */
  async lireMessagePourTranscription(tenantId: string, messageId: string, conversationId?: string): Promise<{ id: string; mediaId: string | null; mediaMime: string | null; mediaNom: string | null; mediaExpire: boolean; transcription: string | null; transcriptionLangue: string | null; traduction: string | null; traductionLangue: string | null } | null> {
    // `conversationId`, quand il est fourni, empêche l'URL de viser une autre conversation du même espace.
    const res = await this.pool.query<{ id: string; media_id: string | null; media_mime: string | null; media_nom: string | null; media_expire: boolean; transcription: string | null; transcription_langue: string | null; traduction: string | null; traduction_langue: string | null }>(
      // Les colonnes de langue et de traduction évitent de repayer (vocal déjà dans la langue du lecteur,
      // traduction déjà rangée). `media_expire` : le même fragment que l'écran, pour ne pas appeler Meta en vain.
      `select m.id, m.media_id, m.media_mime, m.media_nom, ${MEDIA_EXPIRE_SQL} as media_expire,
              m.transcription, m.transcription_langue,
              m.traduction, m.traduction_langue
         from conversation_messages m
         join conversations c on c.id = m.conversation_id
        where m.id = $1 and c.tenant_id = $2
          and ($3::uuid is null or m.conversation_id = $3::uuid)`,
      [messageId, tenantId, conversationId ?? null],
    );
    const r = res.rows[0];
    return r ? {
      id: r.id, mediaId: r.media_id, mediaMime: r.media_mime, mediaNom: r.media_nom, mediaExpire: r.media_expire === true,
      transcription: r.transcription,
      transcriptionLangue: r.transcription_langue, traduction: r.traduction, traductionLangue: r.traduction_langue,
    } : null;
  }

  /**
   * Écrit la transcription, son modèle et la langue détectée, sous la même garde d'espace que la lecture. La
   * langue évite de payer une traduction inutile et une détection de plus. `langue` en dernière position avec
   * un défaut : un câblage qui l'oublie compile quand même.
   */
  async ecrireTranscription(tenantId: string, messageId: string, texte: string, modele: string, langue: string | null = null): Promise<void> {
    await this.pool.query(
      `update conversation_messages m
          set transcription = $3, transcription_modele = $4, transcription_langue = $5
         from conversations c
        where m.id = $1 and c.id = m.conversation_id and c.tenant_id = $2`,
      [messageId, tenantId, texte, modele, langue],
    );
  }

  /**
   * Les messages échangés avec un contact depuis un instant donné, pour la mémoire d'un agent IA. Lue ici plutôt
   * que reçue : `recordInbound` tourne toujours avant `advance`, le fil est donc à jour, et passer le texte
   * changerait la signature du chemin le plus chaud.
   *
   * 🔴 `tenant_id` est dans le `where` : cette lecture part dans le contexte d'un modèle, un fil du mauvais
   * client serait recopié chez le fournisseur. Bornée dans le temps (depuis l'ouverture de la session) et en
   * nombre (le contexte se paie à chaque tour) ; les plus récents, rendus dans l'ordre chronologique.
   */
  async messagesDepuis(
    tenantId: string, waId: string, depuis: string, limite: number,
  ): Promise<Array<{ direction: 'in' | 'out'; body: string }>> {
    const res = await this.pool.query<{ direction: 'in' | 'out'; body: string | null }>(
      `select direction, body from (
         select m.direction, m.body, m.created_at
           from conversation_messages m
           join conversations c on c.id = m.conversation_id
          where c.tenant_id = $1 and c.wa_id = $2 and m.created_at >= $3::timestamptz
            and m.body is not null and m.body <> ''
          order by m.created_at desc
          limit $4::int
       ) recents order by created_at`,
      [tenantId, waId, depuis, Math.max(1, Math.floor(limite))],
    );
    return res.rows.map((r) => ({ direction: r.direction, body: r.body ?? '' }));
  }

  /**
   * Efface le contenu d'une conversation : ses messages et l'aperçu. Rend le nombre de messages effacés, ou
   * `null` si la conversation n'est pas de cet espace.
   *
   * 🔴 Irréversible, et ferme la fenêtre de service : sans message entrant, plus personne ne peut répondre
   * librement à ce contact (l'écran le dit avant). La conversation est gardée (affectation, détenteur, analyse),
   * et `last_message_at` n'est pas remis à zéro, sinon elle disparaîtrait du classement.
   */
  async effacerMessages(tenantId: string, conversationId: string): Promise<number | null> {
    // L'appartenance est vérifiée dans la suppression, pas avant : un seul énoncé, pas de fenêtre de course.
    const res = await this.pool.query(
      `delete from conversation_messages m
        using conversations c
        where m.conversation_id = c.id and c.id = $1 and c.tenant_id = $2`,
      [conversationId, tenantId],
    );
    // `rowCount` à 0 ne dit pas si la conversation existe : une lecture scopée tranche, pour rendre 404.
    const existe = await this.pool.query(
      'select 1 from conversations where id = $1 and tenant_id = $2',
      [conversationId, tenantId],
    );
    if (existe.rowCount === 0) return null;
    await this.pool.query(
      `update conversations set last_preview = null where id = $1 and tenant_id = $2`,
      [conversationId, tenantId],
    );
    return res.rowCount ?? 0;
  }

  /**
   * Le texte d'un message entrant, par son identifiant Meta, dans cet espace. Lu par la réponse « à côté » :
   * c'est ce message qu'elle transmet, pas la dernière saisie du contact.
   */
  async corpsDuMessage(tenantId: string, messageId: string): Promise<string | null> {
    const res = await this.pool.query<{ body: string | null }>(
      `select m.body
         from conversation_messages m
         join conversations c on c.id = m.conversation_id
        where c.tenant_id = $1 and m.meta_message_id = $2 and m.direction = 'in'`,
      [tenantId, messageId],
    );
    return res.rows[0]?.body ?? null;
  }

  /**
   * L'identifiant du dernier message de l'agent de Meta dans cette conversation (son écho, `type = 'mba'`), ou
   * `null`. Lu par `attendreFinDuTour` : un identifiant qui change dit que l'agent a parlé, sans comparer
   * l'horloge de ce serveur à celle de la base.
   */
  async dernierMessageDeLAgent(tenantId: string, waId: string): Promise<string | null> {
    const res = await this.pool.query<{ id: string }>(
      `select m.id
         from conversation_messages m
         join conversations c on c.id = m.conversation_id
        where c.tenant_id = $1 and c.wa_id = $2 and m.direction = 'out' and m.type = 'mba'
        order by m.created_at desc, m.id desc
        limit 1`,
      [tenantId, waId],
    );
    return res.rows[0]?.id ?? null;
  }

  /**
   * L'empreinte du fil, relue avant et après l'attente de fin de tour d'un outil de l'agent de Meta : le
   * détenteur, la date de son dernier changement et notre dernier envoi (écho de l'agent exclu). Le détenteur
   * seul ne suffit pas : un parcours lancé pendant l'attente réécrit `app_workflow`, valeur identique, mais il
   * envoie. Servie par `conversation_messages_origin_idx`. `null` = aucune conversation.
   */
  async empreinteDuFil(tenantId: string, waId: string): Promise<EmpreinteDuFil | null> {
    const res = await this.pool.query<{ control_owner: string | null; control_changed_at: Date | null; dernier_envoi: string | null }>(
      `select c.control_owner, c.control_changed_at,
              (select m.id
                 from conversation_messages m
                where m.conversation_id = c.id and m.direction = 'out' and m.type is distinct from 'mba'
                order by m.created_at desc, m.id desc
                limit 1) as dernier_envoi
         from conversations c
        where c.tenant_id = $1 and c.wa_id = $2`,
      [tenantId, waId],
    );
    const r = res.rows[0];
    return r
      ? { detenteur: r.control_owner, changeLe: r.control_changed_at ? r.control_changed_at.toISOString() : null, dernierEnvoi: r.dernier_envoi }
      : null;
  }

  /**
   * L'identifiant du dernier message reçu du client, ou `null` : il entre dans la clé d'anti-rejeu des outils
   * de l'agent de Meta. Une réaction n'est pas une demande. Servie par `conversation_messages_conv_idx`.
   */
  async dernierMessageDuClient(tenantId: string, waId: string): Promise<string | null> {
    const res = await this.pool.query<{ id: string }>(
      `select m.id
         from conversation_messages m
         join conversations c on c.id = m.conversation_id
        where c.tenant_id = $1 and c.wa_id = $2 and m.direction = 'in' and m.type is distinct from 'reaction'
        order by m.created_at desc, m.id desc
        limit 1`,
      [tenantId, waId],
    );
    return res.rows[0]?.id ?? null;
  }

  /**
   * La dernière saisie du contact : le dernier message qu'il a écrit, tous canaux confondus, pour transmettre au
   * système d'un client ce que la personne vient d'écrire sans le faire recopier par le modèle. Lue à la
   * demande plutôt que dénormalisée (pas d'écriture de plus sur le chemin chaud). Surtout pas `last_preview`,
   * écrit dans les deux sens : il porte parfois notre propre message. Corps non vide : un appui de bouton n'a
   * pas de texte.
   */
  async derniereSaisieDuContact(tenantId: string, waId: string): Promise<string | null> {
    const res = await this.pool.query<{ body: string }>(
      `select m.body
         from conversation_messages m
         join conversations c on c.id = m.conversation_id
        where c.tenant_id = $1 and c.wa_id = $2 and m.direction = 'in'
          and m.body is not null and m.body <> ''
        order by m.created_at desc, m.id desc
        limit 1`,
      [tenantId, waId],
    );
    return res.rows[0]?.body ?? null;
  }

  /**
   * Journalise une réponse sortante (texte libre ou template). Pour un template, `templateCategory` et
   * `templateName` alimentent les stats. `senderUserId` = auteur, pastille dans l'inbox (null pour les réponses
   * auto). `channel` : c'est la bulle qui porte le tuyau, absent -> WhatsApp.
   */
  async recordOutbound(
    conversationId: string,
    body: string,
    messageId: string | null,
    /**
     * Obligatoire, et avant les paramètres à défaut pour que le compilateur trouve les appelants. Déduite de
     * `senderUserId`, elle marquait « scénario » chaque réponse d'un agent tiers MCP.
     */
    origine: OrigineMessage,
    type = 'text',
    templateCategory: string | null = null,
    templateName: string | null = null,
    senderUserId: string | null = null,
    channel: 'whatsapp' | 'rcs' = 'whatsapp',
    /**
     * Ce que l'opérateur a écrit avant de faire traduire. `body` porte ce qui est parti (le client l'a reçu, la
     * trace doit y correspondre) ; `last_preview` aussi, pour que la liste et le fil s'accordent.
     */
    redactionOrigine: string | null = null,
  ): Promise<void> {
    await this.pool.query(
      // `last_direction = 'out'` : on attend désormais le client. Une réponse humaine repousse le dégel (le délai
      // court depuis sa dernière réponse, pas depuis la prise du fil) ; un automate ne prolonge pas un gel humain.
      `update conversations set last_message_at = now(), last_preview = $2, last_direction = 'out',
         control_changed_at = case when $3::boolean and control_owner = 'app_human'
                                   then now() else control_changed_at end,
         -- 🔴 LA PREMIÈRE RÉPONSE D'UN HUMAIN CLÔT L'ESCALADE (0164) : le balayage pourra rendre le fil à l'agent
         -- après les 2 h habituelles de silence, pas avant (arbitrage de Julien du 2026-09-23).
         escaladee_le = case when $3::boolean then null else escaladee_le end,
         analysis_status = case when analysis_status in ('done', 'failed') then 'pending' else analysis_status end
       where id = $1`,
      [conversationId, body, origine === 'humain'],
    );
    await this.pool.query(
      `insert into conversation_messages (conversation_id, direction, type, body, meta_message_id, template_category, template_name, sender_user_id, channel, origin, redaction_origine)
       values ($1, 'out', $4, $2, $3, $5, $6, $7, $8, $9, $10)`,
      [conversationId, body, messageId, type, templateCategory, templateName, senderUserId, channel, origine, redactionOrigine],
    );
  }
}
