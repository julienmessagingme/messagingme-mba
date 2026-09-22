import type { Pool } from 'pg';
import type { InboxStore, InboundMessage } from '../webhooks/inbound';
import { MATCH_BY_WAID_SQL } from '../crm/contact-store.pg';
import type { OrigineMessage } from './origine';
import { visibiliteSql, voitTout, type ActeurConversation } from './assignment';
import { MEDIA_EXPIRE_SQL } from './media-entrant';

/**
 * Au-delà de cet âge, notre dernier envoi n'est plus « en vol » : Meta l'a traité (il acquitte en une seconde), et
 * rendre le fil ne peut plus faire la course de 0149. Lu par `demanderReleaseMba`. Large exprès : la course se
 * joue en secondes, et une file d'accusés en retard (vécu : deux accusés par minute) ne doit pas la rouvrir.
 */
export const ENVOI_EN_VOL = '10 minutes';

/**
 * Qui détient la conversation, et donc qui répond au client.
 *
 * `app_workflow` est le SEUL état qui autorise un scénario à avancer ou à démarrer. `mba` n'est jamais
 * déduit d'une de nos actions : il vient exclusivement d'un webhook `messaging_handovers`.
 */
export type ControlOwner = 'app_workflow' | 'app_human' | 'mba';


export interface ConversationSummary {
  id: string;
  waId: string;
  profileName: string | null;
  lastPreview: string | null;
  lastMessageAt: string;
  /**
   * 🔴 LE POINT DE REPRISE DE LA PAGINATION, OPAQUE, et surtout PAS `lastMessageAt`.
   *
   * Même défaut que `ConversationMessage.curseur`, mais le sens de la comparaison en fait le plus dangereux
   * des deux. La page suivante demande `(last_message_at, id) < (curseur, id)`. Avec un curseur tronqué à la
   * milliseconde (`.043` pour un `.043689` réel), toute conversation dont la dernière activité tombe ENTRE
   * les deux, à `.043200` par exemple, est PLUS PETITE que le vrai point d'arrêt mais PLUS GRANDE que le
   * curseur envoyé : elle n'apparaît sur AUCUNE page. On ne dupliquait pas, on escamotait, en silence.
   *
   * Le cas demande deux conversations actives dans la même milliseconde, ce qu'une rafale de campagne produit.
   *
   * Optionnel : les mocks de test qui omettent le champ restent valides.
   */
  curseur?: string;
  controlOwner: ControlOwner;
  /** Un message ENTRANT est arrivé depuis la dernière ouverture du fil par un opérateur. */
  unread: boolean;
  /**
   * Membre à qui la conversation est confiée. `null` = personne, donc ouverte à tous.
   *
   * ⚠️ Indépendant de `controlOwner` : celui-ci dit QU'EST-CE QUI parle (scénario, humain, agent Meta),
   * celui-là QUEL HUMAIN en a la charge. Une conversation peut être affectée ET tenue par le scénario.
   */
  assignedTo: string | null;
  /** Nom du membre affecté, pour l'afficher sans un second aller-retour. */
  assignedToName: string | null;
  /**
   * La conversation a-t-elle été signalée À LA MAIN (migration 0123) ?
   *
   * 🔴 DISTINCT du dossier « Signalé », qui montre l'UNION de ce drapeau et du constat de l'analyse. Sans
   * cette distinction, l'écran ne saurait pas quoi proposer : sur une conversation signalée par le MODÈLE,
   * un bouton « ne plus signaler » n'aurait aucun effet visible, et l'opérateur cliquerait deux fois avant
   * de conclure que l'écran est cassé.
   *
   * Optionnel : les faux de test qui omettent le champ restent valides, et l'écran le lit comme `false`.
   */
  signaleeMain?: boolean;
  /**
   * Un opérateur l'a marquée « Traité », et le contact n'a rien écrit depuis (migration 0160).
   *
   * Sert à la PASTILLE de la ligne et au choix du geste inverse dans le menu de la conversation ouverte.
   * Optionnel pour la même raison que `signaleeMain` : un faux de test qui l'omet vaut « pas traitée ».
   */
  traitee?: boolean;
}
/**
 * Options de lecture de l'inbox. Toutes optionnelles : sans elles, on obtient exactement la première page
 * telle qu'elle existait avant la pagination.
 */
/**
 * Les chiffres du menu de dossiers de l'Inbox.
 *
 * Un seul objet et non cinq nombres épars : ils sont affichés ensemble, ils doivent donc être LUS ensemble.
 */
export interface CompteursInbox {
  /** Toutes les conversations NON archivées de l'espace. */
  tout: number;
  aTraiter: number;
  signalees: number;
  archivees: number;
  /** Non archivées et marquées « Traité » (migration 0160). Elles sont AUSSI comptées dans `tout`. */
  traitees: number;
  /** Non archivées et confiées à personne. */
  nonAffectees: number;
  /** Tous les membres de l'espace, y compris ceux qui n'ont aucune conversation. */
  parMembre: Array<{ userId: string; nom: string; n: number }>;
}

export interface ListConversationsOptions {
  /** Taille de page. Défaut 100, borné à 200 : la valeur vient d'une query string. */
  limit?: number;
  /**
   * Curseur : reprendre STRICTEMENT après cette conversation, dans l'ordre d'affichage. On passe le dernier
   * élément de la page précédente. `at` est l'horodatage de son dernier message, `id` départage les ex æquo.
   */
  before?: { at: string; id: string };
  /** N'garder que les fils dont le scénario ne s'occupe plus (onglet « À traiter »). */
  aTraiter?: boolean;
  /** Le dossier ARCHIVÉ. Absent ou faux = les dossiers ordinaires, qui excluent les archivées. */
  archivees?: boolean;
  /**
   * Le dossier « Traité » (migration 0160) : non archivées, marquées « Traité ».
   *
   * ⚠️ PAS un dossier EXCLUSIF comme Archivé : une conversation traitée reste aussi dans « Tout », c'est
   * l'arbitrage de Julien du 2026-09-19 qui distingue les deux statuts.
   */
  traitees?: boolean;
  /**
   * Filtrer sur l'affectation : un identifiant de membre, ou `'aucune'` pour les conversations que personne
   * ne s'est vu confier. Absent = toutes, affectées ou non.
   */
  affectee?: string | 'aucune';
  /**
   * Le dossier « Signalé » (onglet de modération) : l'UNION du signalement posé À LA MAIN (`signalee_le`,
   * migration 0123) et du constat d'injure de l'analyse. ⚠️ Ce commentaire a dit « signalées par l'analyse »
   * après que la main soit devenue une source à part entière : une des deux moitiés du dossier était alors
   * invisible pour qui lisait le contrat au lieu de la requête.
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
   * 🔴 LE POINT DE REPRISE DU DELTA, OPAQUE, et surtout PAS `createdAt`.
   *
   * `createdAt` traverse un `Date` JavaScript, qui n'a que la milliseconde, alors que Postgres stocke la
   * MICROSECONDE. Le fil renvoyait donc un curseur tronqué (`.043` pour un `.043689` réel), la comparaison
   * `.043689 > .043000` était vraie, et le dernier message revenait à CHAQUE tour de rafraîchissement : il
   * était ré-ajouté au fil toutes les 4 secondes, ce qui redéclenchait le défilement automatique. Mesuré le
   * 2026-09-02 sur la production : 126 messages sur 127 portent une précision sous la milliseconde, donc le
   * défaut se produisait quasiment toujours.
   *
   * La règle qui évite d'y revenir : **un curseur est fabriqué par le serveur et renvoyé tel quel**. Dès qu'un
   * client le RECONSTRUIT depuis une valeur affichée, il le reconstruit dans la précision de SON langage.
   *
   * Optionnel : les mocks de test qui omettent le champ restent valides.
   */
  curseur?: string;
  /** Auteur d'un message sortant (name sinon partie locale de l'email). null = pas d'auteur (legacy/auto).
   *  Optionnel : les mocks de test qui omettent le champ restent valides. */
  senderName?: string | null;
  /** Canal de CETTE bulle. Le fil est unique par contact, c'est le message qui porte le tuyau emprunté.
   *  Optionnel : les mocks de test qui omettent le champ restent valides (traités en WhatsApp). */
  channel?: 'whatsapp' | 'rcs';
  /**
   * Ce message porte-t-il un fichier chez Meta ? (migration 0125)
   *
   * ⚠️ On rend un BOOLÉEN, jamais l'identifiant : celui-ci ne sert qu'au serveur pour aller chercher le
   * fichier, et le donner au navigateur ne lui apprendrait rien d'utile (l'URL de Meta exige notre jeton et
   * expire en quelques minutes). L'écran a seulement besoin de savoir s'il doit proposer d'écouter.
   */
  aMedia?: boolean;
  /**
   * Le fichier a-t-il dépassé le délai de Meta (`DUREE_MEDIA_RECU_JOURS`, sept jours) ?
   *
   * 🔴 L'ÉCRAN DIT « EXPIRÉ » AU LIEU DE PROPOSER UN FICHIER QUI N'EXISTE PLUS. Sans ce drapeau, une photo de
   * huit jours afficherait un bouton qui échoue à chaque clic, et l'opérateur conclurait à une panne. Vrai
   * seulement si le message PORTE un média.
   */
  mediaExpire?: boolean;
  /** Le nom de fichier d'un document reçu, tel que WhatsApp l'annonce (migration 0160). */
  mediaNom?: string | null;
  /**
   * La transcription du vocal, quand un opérateur l'a demandée (migration 0125).
   *
   * 🔴 SÉPARÉE DE `body`, et l'écran doit la MARQUER comme telle. C'est la lecture d'un modèle, pas ce que le
   * client a écrit : la présenter comme une citation ferait prendre une supposition pour un fait, et
   * l'opérateur qui reprend une conversation menée par l'IA n'aurait plus aucun moyen de le savoir.
   */
  transcription?: string | null;
  /**
   * La langue dans laquelle le vocal a ete DIT, telle que le modele de transcription la lit
   * (migration 0137).
   *
   * ⚠️ Elle etait rendue par `transcrire` depuis le 2026-09-09 et JETEE. Elle sert deux fois : ne pas
   * traduire un vocal deja dans la langue du lecteur, et alimenter la langue du contact.
   */
  transcriptionLangue?: string | null;
  /**
   * NOTRE LECTURE d'un message ENTRANT, dans la langue de la console (migration 0137).
   *
   * 🔴 A COTE de `body`, jamais a sa place : `body` garde ce que le CLIENT a ecrit, et c'est lui qui
   * fait foi. Meme separation qu'entre `transcription` et `body` (0125), et pour la meme raison : la
   * lecture d'un modele n'est pas ce que le client a ecrit.
   */
  traduction?: string | null;
  /** La langue de `traduction`. Bornee a nos deux langues de console par la migration 0137. */
  traductionLangue?: string | null;
  /**
   * Ce que l'OPERATEUR a ecrit avant de faire traduire, sur un message SORTANT (migration 0137).
   *
   * 🔴 LE SENS S'INVERSE ICI, et c'est le piege du lot : sur un sortant, `body` porte ce qui est PARTI
   * (donc le texte traduit, c'est ce que le client a recu), et cette colonne porte l'original. Ne
   * garder qu'un des deux est faux dans les deux sens.
   */
  redactionOrigine?: string | null;
}

/**
 * « Non lu » = il existe un message ENTRANT plus récent que la dernière ouverture du fil (`last_read_at`
 * null = jamais ouvert). Seul l'ENTRANT compte : nos propres envois (campagne, scénario) ne doivent pas
 * rallumer le compteur, sinon il s'allumerait tout seul à chaque campagne.
 *
 * Fragment SQL partagé par la liste et le compteur : deux écritures divergeraient au premier ajustement,
 * et la pastille afficherait un nombre que la liste ne montre pas. `c` = alias de `conversations`.
 */
const UNREAD_SQL = `exists (
  select 1 from conversation_messages m
  where m.conversation_id = c.id and m.direction = 'in'
    and m.created_at > coalesce(c.last_read_at, to_timestamp(0))
)`;

/**
 * LE DOSSIER « À TRAITER », défini UNE fois.
 *
 * 🔴 DEUX CONDITIONS, ET LA SECONDE MANQUAIT. « À traiter » valait seulement « le scénario ne gère plus ce
 * fil » (`control_owner <> 'app_workflow'`). Un opérateur prenait donc la main, RÉPONDAIT au client, et la
 * conversation restait dans le dossier alors qu'on attend désormais le CLIENT. Constaté par Julien le
 * 2026-09-10 : le dossier se remplissait de fils où il n'y a rien à faire, et cessait d'être une liste de
 * travail. La possession du fil ne suffit pas, il faut savoir QUI A PARLÉ EN DERNIER (migration 0130).
 *
 * 🔴 ELLE VAUT POUR TOUT DÉTENTEUR, HUMAIN COMME ROBOT (tranché par Julien le 2026-09-11). La première
 * version la restreignait aux fils tenus par un humain, pour garder les fils du Meta Business Agent sous
 * surveillance. Julien a tranché l'inverse, et c'est cohérent avec le nom du dossier : « À traiter » ne veut
 * pas dire « à surveiller », il veut dire « quelqu'un attend quelque chose de nous ». Un fil où le robot vient
 * de répondre n'attend rien : la balle est chez le contact, et il reste dans « Tout ».
 * ⚠️ Corollaire assumé : pour VOIR ce que le robot mène, on ouvre « Tout », pas « À traiter ». Un fil MBA
 * revient dans le dossier dès que le contact réécrit et tant que le robot n'a pas répondu.
 *
 * 🔴 `is distinct from` ET NON `= 'out'`, ET UNE ÉCRITURE INTERMÉDIAIRE ÉTAIT FAUSSE POUR CETTE RAISON.
 * Écrite `not (c.control_owner = 'app_human' and c.last_direction = 'out')`, elle valait NULL quand
 * `last_direction` est NULL (logique à TROIS valeurs de SQL), et un prédicat NULL EXCLUT la ligne. Toutes les
 * conversations d'avant la migration auraient donc DISPARU du dossier au déploiement, c'est-à-dire l'inverse
 * exact de ce que le commentaire promettait. Attrapé par le test d'intégration « un fil SANS sens connu reste
 * dans le dossier » : aucun test unitaire ne peut voir ça, la faute est dans le SQL.
 *
 * ⚠️ Une conversation sans valeur connue reste donc dans le dossier, exactement comme avant la migration. Un
 * filtre qui ferait DISPARAÎTRE des fils au déploiement serait la pire façon de l'introduire, personne ne
 * cherchant ce qu'il ne sait pas avoir perdu.
 *
 * ⚠️ Fragment PARTAGÉ par les trois lecteurs (la liste, les compteurs du menu, la vieille route de comptage) :
 * les écrire trois fois les ferait diverger au premier ajustement, et le dossier afficherait un nombre que la
 * liste ne montre pas. C'est déjà la raison d'être d'`UNREAD_SQL` juste au-dessus. `c` = alias de
 * `conversations`.
 *
 * 🔴 UNE TROISIÈME CONDITION DEPUIS LE 2026-09-19 : ce qu'un opérateur a marqué « Traité » n'y est plus
 * (migration 0160). C'est tout l'intérêt du statut : le contact a écrit en dernier (« merci, bonne journée »),
 * il n'y a rien à lui répondre, et sans lui la ligne restait dans le dossier pour toujours. Elle y revient
 * d'elle-même au message SUIVANT du contact, parce que cette écriture-là efface `traitee_le`
 * (`upsertConversationByWaId`). ⚠️ Sauf une RÉACTION (👍), qui ne retire pas le statut ni ne change qui a
 * parlé en dernier (arbitrage de Julien du 2026-09-19).
 *
 * 🔴 ET UNE ESCALADE DE L'AGENT DE META Y ENTRE TOUT DE SUITE (migration 0164, Julien, 2026-09-23). Sa dernière
 * phrase (« un membre de l'équipe va vous répondre ») est SORTANTE : la conversation n'arrivait ici que si le
 * client réécrivait, alors qu'il attend justement qu'on lui réponde. `escaladee_le` la fait entrer jusqu'à la
 * première réponse d'un opérateur.
 */
const A_TRAITER_SQL = `c.control_owner <> 'app_workflow' and (c.last_direction is distinct from 'out' or c.escaladee_le is not null) and c.traitee_le is null`;

/** Voir `PgInboxStore.empreinteDuFil`. */
export interface EmpreinteDuFil { detenteur: string | null; changeLe: string | null; dernierEnvoi: string | null }

/** Store Postgres de la boîte de réception (conversations + messages). */
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
   * Upsert la conversation par (tenant, wa_id), lie le contact si son identité correspond, avance last_message_at +
   * last_preview, renvoie l'id. Le wa_id est en chiffres nus (numéro) OU un BSUID : on tente '+wa_id' (E.164 exact),
   * PUIS les seuls chiffres (tolère un formatage différent), PUIS le bsuid (contact sans numéro). Partagé par
   * l'inbound (webhook) et les envois sortants automatisés (campagne / workflow) -> même conversation, jamais de
   * doublon.
   */
  private async upsertConversationByWaId(
    tenantId: string,
    waId: string,
    preview: string,
    /**
     * 🔴 CE MESSAGE ROUVRE-T-IL LA CONVERSATION ? Gouverné par le CHEMIN APPELANT, jamais deviné ici.
     *
     * DEUX rangements, et ils ne se rouvrent pas pour les mêmes messages : `archive` la sort d'Archivé,
     * `traite` lui retire le statut « Traité » (migration 0160). Le paramètre était un seul booléen,
     * `desarchive`, tant qu'il n'y avait qu'un rangement.
     *
     * ⚠️ UNE RÉACTION (👍) NE RETIRE PAS « TRAITÉ » (arbitrage de Julien du 2026-09-19) : « merci 👍 » en
     * réponse à notre « bonne journée » est précisément le cas que ce statut existe pour régler. Un vrai
     * message du contact, lui, le retire toujours. Archivé n'est pas concerné par cet arbitrage et garde son
     * comportement : toute entrée du contact le sort d'Archivé.
     *
     * Cet upsert est partagé par l'INBOUND (un message du contact) et par les ENVOIS SORTANTS AUTOMATISÉS
     * (campagne, scénario). Décider dans la dépendance partagée ferait remonter dans l'inbox de tout le
     * monde chaque contact archivé qu'une campagne touche. Le dépôt applique déjà cette règle aux
     * événements d'automation, mot pour mot et pour la même raison.
     *
     * Requis et non optionnel : c'est le compilateur qui doit obliger un futur troisième appelant à
     * trancher, plutôt qu'un défaut qui le laisserait hériter d'un choix qu'il n'a pas fait.
     */
    rouvre: { archive: boolean; traite: boolean },
    /**
     * QUI VIENT DE PARLER : `in` le contact, `out` nous, `reaction` le contact par un emoji (👍).
     *
     * ⚠️ UNE RÉACTION NE CHANGE PAS QUI A PARLÉ EN DERNIER (arbitrage de Julien du 2026-09-19, « une réaction
     * ne rouvre pas »). Notre « bonne journée » sort la conversation d'« À traiter » ; le 👍 qui y répond l'y
     * remettait en réécrivant le sens, alors qu'il n'attend rien. Le sens n'est lu QUE par ce dossier
     * (`A_TRAITER_SQL`). Sur une conversation NEUVE, la réaction compte comme une entrée : il n'y a pas
     * d'ancien sens à garder.
     *
     * 🔴 OBLIGATOIRE, SANS VALEUR PAR DÉFAUT. C'est ce qui décide du dossier « À traiter », donc un appelant
     * qui l'oublierait rangerait le fil au mauvais endroit, en silence. Sans défaut, l'oubli est une erreur
     * du compilateur : c'est la même raison qui a rendu `origine` obligatoire sur `recordOutbound` (migration
     * 0101), après qu'une valeur DÉDUITE eut marqué « scénario » toutes les réponses du serveur MCP.
     */
    sens: 'in' | 'out' | 'reaction',
  ): Promise<string> {
    const conv = await this.pool.query<{ id: string }>(
      // UN contact = UNE conversation, quel que soit le canal : c'est le MESSAGE qui porte son canal
      // (`conversation_messages.channel`, migration 0056), pas le fil. L'unique (tenant_id, wa_id) de 0009
      // reste donc l'arbitre de ce ON CONFLICT, et la reprise de main par un opérateur continue de valoir
      // pour le contact entier, pas pour un tuyau.
      `insert into conversations (tenant_id, wa_id, contact_id, last_message_at, last_preview, last_direction)
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
       returning id`,
      [tenantId, waId, preview, rouvre.archive, sens === 'out' ? 'out' : 'in', rouvre.traite, sens === 'reaction'],
    );
    return conv.rows[0]!.id;
  }

  /**
   * AFFECTE une conversation à un membre, par son numéro.
   *
   * 🔴 POURQUOI PAR `wa_id` ET NON PAR IDENTIFIANT DE CONVERSATION : l'appelant est le moteur de scénario,
   * qui ne connaît que le contact. Sa jumelle `setAssignee` sert l'Inbox, qui a la conversation sous la main.
   *
   * ⚠️ ELLE ÉCRASE une affectation existante, et c'est voulu : le bloc « passer à un humain » nomme
   * explicitement qui doit traiter ce fil, c'est une décision de routage plus récente que la précédente.
   *
   * ⚠️ `assigned_by` reste NULL : personne n'a cliqué, c'est le scénario. Le journal d'affectation distingue
   * ainsi un routage automatique d'une distribution faite à la main, ce qu'un identifiant d'emprunt aurait
   * rendu impossible.
   *
   * 🔴 L'`exists` sur `users` est la garde : un membre d'un AUTRE espace, ou un compte révoqué, ne reçoit
   * rien. Sans lui, un identifiant recopié dans le graphe affecterait une conversation à quelqu'un qui n'a
   * pas le droit de la lire, et elle disparaîtrait de la vue de tous les autres.
   */
  async setAssigneeByWaId(tenantId: string, waId: string, assignee: string): Promise<boolean> {
    const res = await this.pool.query(
      `update conversations set assigned_to = $3, assigned_at = now(), assigned_by = null
        where tenant_id = $1 and wa_id = $2
          and exists (select 1 from users u where u.id = $3 and u.tenant_id = $1 and u.disabled_at is null)`,
      [tenantId, waId, assignee],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /**
   * AFFECTE UNE CONVERSATION QUI N'EST ENCORE À PERSONNE, et rend `false` si elle l'est déjà.
   *
   * 🔴 SA JUMELLE `setAssigneeByWaId` ÉCRASE, ET C'EST CORRECT LÀ-BAS : le bloc « passer à un humain »
   * d'un scénario NOMME explicitement qui doit traiter le fil, c'est une décision de routage plus récente
   * que la précédente. Ici, l'appelant est l'arrivée d'une réponse de campagne, donc un ROULEMENT : il
   * n'a rien nommé, il prend son tour. Écraser reviendrait à retirer une conversation à l'opérateur qui
   * est peut-être déjà en train d'y répondre, au deuxième message du même contact.
   *
   * 🔴 LE `assigned_to is null` EST DANS LE `where`, PAS DANS UNE LECTURE PRÉALABLE. Deux réponses
   * simultanées du même contact liraient toutes deux « libre » et écriraient toutes deux : la seconde
   * écrasait la première, et le rang consommé par l'une était perdu. Ici la seconde ne touche aucune
   * ligne et l'appelant l'apprend.
   *
   * ⚠️ MÊME GARDE D'ESPACE que sa jumelle : un membre d'un AUTRE espace, ou un compte révoqué, ne reçoit
   * rien. Sans elle, un identifiant recopié affecterait une conversation à quelqu'un qui n'a pas le droit
   * de la lire, et elle disparaîtrait de la vue de tous les autres.
   *
   * ⚠️ `assigned_by` reste NULL : personne n'a cliqué. Le journal d'affectation distingue ainsi un routage
   * automatique d'une distribution faite à la main.
   */
  async assignerSiLibre(tenantId: string, waId: string, assignee: string): Promise<boolean> {
    const res = await this.pool.query(
      `update conversations set assigned_to = $3, assigned_at = now(), assigned_by = null
        where tenant_id = $1 and wa_id = $2 and assigned_to is null
          and exists (select 1 from users u where u.id = $3 and u.tenant_id = $1 and u.disabled_at is null)`,
      [tenantId, waId, assignee],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /**
   * LES MEMBRES QUI PEUVENT RECEVOIR UNE CONVERSATION, dans un ordre STABLE.
   *
   * 🔴 L'ORDRE EST LA MOITIÉ DU TOUR DE RÔLE. Le roulement lit `membres[rang % membres.length]` : un ordre
   * qui change entre deux réponses reviendrait à tirer au sort. `created_at` seul ne suffit pas (deux
   * comptes créés dans la même transaction partagent l'horodatage), d'où `id` en second critère.
   *
   * ⚠️ NI RÉVOQUÉ NI JAMAIS CONNECTÉ, exactement comme le sélecteur de l'assistant : affecter une
   * conversation à quelqu'un qui ne peut pas la lire, c'est la ranger là où personne ne la lira.
   *
   * 🔴 UNE VERSION DE CE DOCBLOC DISAIT QUE `password_hash is null` EST LE MARQUEUR D'UNE INVITATION NON
   * ACCEPTÉE. C'était faux, et c'est la faute de ce lot : ce champ est nul pour tout compte qui se connecte
   * par GOOGLE, donc pour des gens parfaitement actifs. La justification fausse a voyagé du commentaire au
   * code, puis du code à trois écrans. C'est l'illustration exacte de « une justification fausse est pire
   * qu'aucune, parce qu'elle sera recopiée ».
   */
  async membresAffectables(tenantId: string): Promise<string[]> {
    const res = await this.pool.query<{ id: string }>(
      // 🔴 `last_login_at is not null`, ET SURTOUT PAS `password_hash is not null`. Ce second critère a
      // été écrit ici le 2026-09-12 et il était FAUX : la connexion par Google ne pose aucun mot de passe,
      // donc le tour de rôle écartait silencieusement toute personne qui se connecte ainsi. Mesuré en
      // production le soir même : sur quatre comptes tous actifs, DEUX étaient écartés, et un espace dont
      // toute l'équipe passe par Google aurait rendu une liste VIDE, donc aucune affectation, sans erreur.
      // ⚠️ Le critère juste est « cette personne s'est déjà connectée », parce que c'est exactement ce
      // qu'on lui demande : pouvoir lire la conversation qu'on lui confie.
      `select id from users
        where tenant_id = $1 and disabled_at is null and last_login_at is not null
        order by created_at asc, id asc`,
      [tenantId],
    );
    return res.rows.map((r) => r.id);
  }

  /**
   * Détenteur courant du fil. L'ABSENCE de conversation vaut `app_workflow` : une campagne peut viser un
   * contact qui n'a jamais écrit, sa conversation n'existe alors pas encore et rien ne doit être bloqué.
   */
  async getControlOwner(tenantId: string, waId: string): Promise<ControlOwner> {
    const res = await this.pool.query<{ control_owner: ControlOwner }>(
      `select control_owner from conversations where tenant_id = $1 and wa_id = $2`,
      [tenantId, waId],
    );
    return res.rows[0]?.control_owner ?? 'app_workflow';
  }

  /**
   * Pose le détenteur du fil.
   *
   * `only` restreint la transition aux détenteurs courants listés. C'est LE mécanisme qui empêche un envoi
   * automatisé de révoquer un opérateur engagé : sans lui, un opérateur répond à 10h00, une campagne
   * programmée touche le même contact à 10h02 et repose `app_workflow`, et le scénario redémarre par-dessus
   * l'humain au message suivant. La garde est DANS le WHERE, donc évaluée atomiquement, sans lecture
   * préalable et donc sans course entre la lecture et l'écriture.
   *
   * UPDATE SEUL, volontairement : ne crée jamais la conversation. Si la ligne n'existe pas, le détenteur
   * vaut déjà `app_workflow` (défaut de la colonne ET valeur rendue par `getControlOwner`), donc une pose
   * automatisée n'aurait rien à écrire ; et créer une conversation vide juste pour porter un état la ferait
   * apparaître sans le moindre message dans l'inbox. Les deux poses non automatiques (un humain qui répond,
   * un handover Meta) portent par construction sur une conversation qui a déjà des messages.
   *
   * Renvoie true si la bascule a eu lieu, false si la garde l'a refusée ou si l'état était déjà celui visé
   * (cas normaux, jamais une erreur).
   */
  async setControlOwner(
    tenantId: string,
    waId: string,
    owner: ControlOwner,
    opts?: {
      only?: readonly ControlOwner[]; saufEscalade?: boolean; effacerEscalade?: boolean; messageEnvoyeLe?: Date;
      /**
       * 🔴 CETTE PRISE DE FIL EST UNE ESCALADE (arbitrage de Julien du 2026-09-23, étendu aux TROIS chemins).
       *
       * Le bloc « passer à un humain » d'un scénario et l'escalade d'un agent IA posaient `app_human` comme
       * l'agent de Meta, avec le même symptôme : leur dernière phrase est SORTANTE, donc la conversation
       * n'entrait pas dans « À traiter », et le balayage la rendait à l'agent au bout de 2 h sans réponse.
       * ⚠️ N'écrit que si la bascule a lieu (`control_owner is distinct from` + `only`) : si quelqu'un tenait
       * déjà le fil, il n'y a pas d'escalade à poser, et le booléen rendu le dit à l'appelant.
       */
      escalade?: boolean;
    },
  ): Promise<boolean> {
    const only = opts?.only;
    // 🔴 RENDRE LE FIL À L'AGENT DE META N'EFFACE L'ESCALADE QUE SI ON LE DEMANDE (revue finale du 2026-09-23).
    // Elle s'effaçait dès qu'une écriture posait `mba`, donc aussi quand la FIN D'UN PARCOURS rendait le fil
    // (`rendreLeFilMaintenant`) : la conversation sortait d'« À traiter » sans que personne ait répondu, ce que
    // l'arbitrage de Julien interdit. Ne le demandent que les DEUX gestes qui disent vraiment « l'agent reprend » :
    // le bouton « Rendre la main » de l'Inbox (dans ses QUATRE branches : elles n'écrivent pas toutes `mba`, et
    // trois d'entre elles laissaient le drapeau sur une conversation qui quittait « À traiter », donc un piège
    // armé pour le jour où elle redeviendrait `app_human`), et le balayage quand il déplace un fil qui n'est
    // PAS une escalade en cours (il saute les `app_human` escaladées avant d'en arriver là).
    // ⚠️ `saufEscalade` : n'écrit PAS sur une conversation escaladée. Posé par le `standby` d'un entrant
    // (`accorderLeDetenteur`) : une fois le fil passé à l'équipe, Meta nous envoie les messages sur `messages`,
    // donc un `standby` traité après l'escalade est un RETARDATAIRE (traitements en parallèle), et il rendait
    // la conversation à l'agent sous le nez de l'équipe.
    // 🔴 SAUF S'IL EST PLUS RÉCENT QUE L'ESCALADE (`messageEnvoyeLe`, revue finale du 2026-09-23) : Meta ne nous
    // envoie un standby que lorsqu'une AUTRE app tient le fil, donc un standby postérieur prouve que l'agent l'a
    // repris. Sans cette porte, l'escalade ne se levait que par un geste humain, donc éventuellement jamais.
    // ⚠️ SANS DATE, LA GARDE RESTE STRICTE : une donnée externe manquante n'ouvre rien.
    const res = await this.pool.query(
      `update conversations set control_owner = $3, control_changed_at = now(),
              escaladee_le = case when $6::boolean then null
                                  when $8::boolean and $3 = 'app_human' then now()
                                  else escaladee_le end,
              traitee_le = case when $8::boolean and $3 = 'app_human' then null else traitee_le end,
              archived_at = case when $8::boolean and $3 = 'app_human' then null else archived_at end
       where tenant_id = $1 and wa_id = $2
         and control_owner is distinct from $3
         and ($4::text[] is null or control_owner = any($4::text[]))
         and (not $5::boolean or escaladee_le is null
              or ($7::timestamptz is not null and $7::timestamptz > escaladee_le))`,
      [tenantId, waId, owner, only ? [...only] : null, opts?.saufEscalade === true, opts?.effacerEscalade === true,
       opts?.messageEnvoyeLe ?? null, opts?.escalade === true],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /**
   * L'AGENT DE META A PASSÉ LA MAIN À L'ÉQUIPE (`control_passed`, migration 0164, Julien, 2026-09-23).
   *
   * La conversation devient la nôtre (`app_human`), entre dans « À traiter » (`escaladee_le`) même si la dernière
   * phrase est celle de l'agent, sort d'« Archivées » et de « Traité » : quelqu'un attend une réponse humaine.
   * 🔴 UPSERT : la passation peut être traitée AVANT l'écho de la phrase de l'agent, qui crée d'habitude la
   * conversation (traitements en parallèle). Sans la créer ici, l'escalade serait perdue.
   */
  async marquerEscalade(tenantId: string, waId: string): Promise<void> {
    await this.pool.query(
      `insert into conversations (tenant_id, wa_id, contact_id, control_owner, control_changed_at, escaladee_le)
       values ($1, $2, (select id from contacts where tenant_id = $1 ${MATCH_BY_WAID_SQL}), 'app_human', now(), now())
       on conflict (tenant_id, wa_id) do update set
         control_owner = 'app_human', control_changed_at = now(), escaladee_le = now(),
         traitee_le = null, archived_at = null`,
      [tenantId, waId],
    );
  }

  /**
   * MARQUE un fil « à rendre à l'agent de Meta dès que notre DERNIER envoi sera acquitté » (0149), et rend
   * l'identifiant de ce message, ou `null` s'il n'y en a aucun.
   *
   * 🔴 ON NE RELÂCHE PLUS DANS LA FOULÉE DE L'ENVOI, et c'est tout le sujet. Sa documentation dit qu'envoyer
   * un message PREND le fil implicitement : un release émis deux secondes après un envoi relâche donc un fil
   * que cet envoi reprend juste derrière. Trois échecs sur trois, contre un succès à quatorze minutes d'écart.
   *
   * ⚠️ LE RETARD DE DEUX MINUTES N'EST PAS CELUI DE META, CORRIGÉ LE 2026-09-15 AU SOIR. Cette page l'a
   * affirmé toute la journée, et c'était une erreur de lecture : l'horodatage que Meta inscrit dans l'accusé
   * du message de 08:26:47 vaut **08:26:47**, et son webhook nous parvient à 08:26:48. Meta acquitte en une
   * seconde. Les deux minutes étaient les NÔTRES, celles de la file `webhook-status` qui se vidait à deux
   * accusés par minute ; ce qu'on lisait comme « l'heure de Meta » était l'heure à laquelle notre worker
   * traitait l'accusé. Le marqueur reste néanmoins juste : ce qu'on attend n'est pas un délai, c'est la
   * PREUVE que Meta a fini de traiter l'envoi, et seul l'accusé la porte.
   *
   * 🔴 LE DERNIER, ET NON « UN » : un parcours envoie plusieurs messages, et l'accusé du PREMIER arrive
   * souvent APRÈS que le dernier soit parti. Attendre n'importe quel accusé reproduirait la course.
   *
   * ⚠️ `null` EN RETOUR N'EST PAS UNE PANNE : un parcours peut se terminer sans avoir rien envoyé (toutes ses
   * branches sautées, un envoi refusé). Il n'y a alors AUCUNE course à éviter, et l'appelant relâche tout de
   * suite. La colonne est laissée à `null` dans ce cas, sans quoi elle attendrait un accusé qui ne viendra
   * jamais.
   *
   * 🔴 LE MARQUEUR NE SE POSE PLUS SUR UN ENVOI DÉJÀ TRAITÉ PAR META (spec 2026-09-21-outils-maison-mba, § 5.1).
   * Deux cas le posaient sur un accusé déjà reçu, donc qui ne reviendrait jamais : la réponse « à côté » (le client
   * a écrit depuis notre envoi) et le délai d'une question sans sortie (notre question est partie il y a longtemps).
   * Le fil restait alors en `app_human` jusqu'au balayage, et l'agent de Meta muet. On attend donc SEULEMENT si
   * notre dernier envoi est aussi le dernier message du fil, n'est pas acquitté, et est RÉCENT :
   *  - un message ENTRANT plus récent prouve que Meta a traité l'envoi (le client l'a reçu). La règle lit les
   *    MESSAGES, pas `last_direction`, qui ignore une réaction et vaut `null` avant 0130 ;
   *  - `accuse_le` (0162) est posé au premier statut reçu (`consommerReleaseMba`) ;
   *  - ⚠️ ET UN ENVOI DE PLUS DE `ENVOI_EN_VOL` N'EST PLUS EN VOL : Meta acquitte en une seconde, la course de 0149
   *    se joue dans les secondes qui suivent l'envoi. Cette borne est aussi ce qui traite les envois ANTÉRIEURS au
   *    lot 4, acquittés sans que personne n'écrive `accuse_le` : pour eux, `null` ne veut pas dire « pas encore
   *    acquitté », et sans elle la règle reposerait le marqueur sur des fils déjà réglés.
   * ⚠️ Fenêtre résiduelle assumée : un client qui écrit dans la seconde même de notre envoi. Le balayage reste le filet.
   *
   * 🔴 L'ÉCHO DE L'AGENT DE META N'EST PAS « NOTRE » ENVOI (`type = 'mba'`, revue du 2026-09-22). Depuis que le relais
   * attend la phrase d'annonce de l'agent avant d'envoyer (`src/mba/fin-de-tour.ts`), cet écho est souvent le dernier
   * sortant quand un envoi échoue : le marqueur s'y posait, le fil restait en `app_human`, et l'événement qui devait
   * prévenir l'agent (`signalerEchecTardif`) ne partait jamais.
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
   * CONSOMME la demande de remise que ce message portait, et rend le fil concerné. `null` = ce message
   * n'était attendu par personne, ce qui est le cas de l'écrasante majorité des statuts.
   *
   * 🔴 UNE SEULE REQUÊTE, ET C'EST CE QUI REND L'OPÉRATION UNIQUE. Meta envoie PLUSIEURS statuts par message
   * (`sent`, puis `delivered`, puis `read`) : lire puis écrire relâcherait plusieurs fois, et les fois
   * suivantes nous ne détenons plus le fil, donc hors contrat. L'`update ... returning` conditionné sur
   * l'égalité ne rend une ligne qu'au PREMIER appelant.
   *
   * ⚠️ `tenant_id` N'EST PAS DANS LE `where`, ET C'EST LE SEUL ENDROIT OÙ C'EST JUSTE : l'appelant est un
   * webhook de Meta, qui ne connaît qu'un identifiant de message et aucun espace. C'est justement la colonne
   * `tenant_id` RENDUE qui lui apprend de quel espace il s'agit. L'identifiant est unique dans toute la base
   * (`conversation_messages_wamid_uidx`), donc il ne peut désigner qu'une conversation d'un seul espace.
   *
   * ⚠️ ELLE POSE AUSSI L'ACCUSÉ du message (0162), dans la même requête : c'est la preuve que `demanderReleaseMba`
   * lit pour ne plus attendre ce qui est déjà arrivé. Un seul aller-retour sur ce chemin très chaud, par l'index
   * unique de `meta_message_id`, et `accuse_le is null` n'écrit qu'au premier statut.
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
   * TOUTES les conversations dont le contrôle est détenu (hors `app_workflow`), les plus anciennes d'abord.
   *
   * Alimente le garde-fou d'inactivité : il n'existe AUCUN release automatique côté Meta, donc un contrôle
   * jamais rendu (opérateur parti, onglet fermé, crash) gèlerait la conversation indéfiniment.
   *
   * AUCUN filtre d'âge en SQL, volontairement : le délai de reprise est réglable PAR CLIENT, et un client
   * peut choisir un délai plus court que le défaut du serveur. Filtrer ici avec le défaut raterait
   * silencieusement ses conversations. Le tri est donc fait en SQL, la décision en mémoire, avec le
   * réglage du bon client. Un état détenu est transitoire par construction, donc ce lot reste petit ; si
   * le plafond était atteint, ce sont les plus anciennes qui passent d'abord, ce qui est la bonne priorité.
   *
   * `control_changed_at` null = bascule d'avant la migration 0040 : traitée comme éligible, sinon ces
   * conversations resteraient bloquées pour toujours.
   */
  async listHeldControl(
    limit = 500,
    ageScenarioMs = 0,
  ): Promise<Array<{ tenantId: string; waId: string; owner: ControlOwner; changedAt: Date | null; lastMessageAt: Date | null; escaladee: boolean }>> {
    /**
     * 🔴 LES FILS TENUS PAR UN SCÉNARIO ENTRENT ICI DEPUIS LE 2026-09-14, ET SEULEMENT LES VIEUX.
     *
     * Ils en étaient exclus (`control_owner <> 'app_workflow'`), ce qui était sans conséquence tant que
     * `reclaimControl` n'écrivait que notre colonne : Meta gardait le fil, son agent reprenait la main tout
     * seul. Depuis qu'on le prend POUR DE VRAI (`thread_control` action `take`), un parcours abandonné le
     * garderait à jamais et l'agent de Meta ne répondrait plus jamais sur cette conversation.
     *
     * 🔴 ET LE FILTRE D'ÂGE EST EN SQL ICI, ALORS QUE LE DÉLAI HUMAIN N'Y EST PAS. Ce n'est pas une
     * incohérence, c'est ce que le choix « délai FIXE » autorise (tranché par Julien le 2026-09-14) : le
     * délai humain est réglable PAR CLIENT et peut être plus court que le défaut du serveur, donc un filtre
     * SQL raterait silencieusement les conversations des clients pressés. Celui du scénario ne se règle pas,
     * donc il se filtre.
     *
     * ⚠️ SANS CE FILTRE, LE BALAYAGE HUMAIN CESSERAIT DE FONCTIONNER. `app_workflow` est l'état NORMAL de
     * toute conversation : les ramener toutes saturerait le lot de 500 avec des fils parfaitement sains, et
     * les `app_human` à rendre, plus anciens, ne seraient jamais atteints. La régression serait invisible,
     * puisque le balayage continuerait de tourner et de ne rien trouver.
     *
     * 🔴 `control_changed_at is null` ÉTAIT EXCLU AVEC UNE JUSTIFICATION FAUSSE, CORRIGÉE LE 2026-09-15.
     * Elle disait : « c'est la marque d'une conversation qui n'a JAMAIS basculé, donc d'un fil que personne
     * n'a pris. Il n'y a rien à rendre. » L'équivalence ne tient pas : `app_workflow` est la valeur PAR
     * DÉFAUT de la colonne, et **envoyer un message PREND le fil chez Meta implicitement**. Une conversation
     * née d'un envoi sortant porte donc `app_workflow` + `null` alors que nous tenons le fil pour de vrai.
     *
     * 🔴 MESURÉ SUR UN CAS RÉEL (`33634264992`, 2026-09-15) : deux envois sortants le 09-08, `null` depuis,
     * et le résultat est une conversation que ce balayage ignore ET que « À traiter » exclut (ce dossier
     * écarte `app_workflow`). Invisible et muette, sans le moindre symptôme.
     *
     * 🔴 C'EST LA FENÊTRE QUI BORNE, PAS L'ÂGE DU CONTRÔLE, et l'ordre des deux conditions n'est pas
     * cosmétique. Une première version écrivait `coalesce(control_changed_at, last_message_at) < now() - âge`
     * ET `last_message_at > now() - 24 h` : pour une conversation jamais basculée, le `coalesce` retombe sur
     * `last_message_at`, et les deux conditions exigent alors ce message à la fois PLUS VIEUX et PLUS RÉCENT
     * que 24 h. La branche était donc MORTE, pendant qu'un test affirmait le contraire. Relevé en revue, le
     * jour même. Une conversation qui n'a jamais basculé n'a pas d'âge de contrôle : elle est éligible dès
     * que sa fenêtre est ouverte, point.
     *
     * ⚠️ ET LE GARDE-FOU DE VOLUME DU COMMENTAIRE D'ORIGINE RESTE TENU, par la fenêtre elle-même : seules
     * les conversations actives dans les dernières 24 h entrent, jamais l'historique entier. Sans elle,
     * `app_workflow` étant l'état normal de tout le monde, le lot de 500 serait saturé de fils sains et les
     * fils humains à rendre, plus anciens, ne seraient jamais atteints. La régression serait invisible.
     *
     * 🔴 LA BORNE DE FENÊTRE EST UN PROXY À SENS UNIQUE, et c'est ce qui la rend sûre. Un dernier message
     * vieux de plus de 24 h PROUVE que la fenêtre de Meta est fermée (le dernier entrant est au plus vieux
     * que lui), donc qu'il n'y a rien à transmettre. L'inverse n'est pas vrai : un dernier message RÉCENT
     * mais SORTANT peut recouvrir une fenêtre fermée. C'est le balayage qui absorbe cette imprécision, en
     * appelant Meta AVANT d'écrire.
     *
     * 🔴 LES ESCALADES SORTENT DU LOT EN SQL (revue finale du 2026-09-23). Le lot est plafonné à 500 et trié par
     * ancienneté : les escalades, qui ne se vident jamais tant que personne n'a répondu, s'y accumulaient en TÊTE
     * et n'étaient écartées qu'en mémoire, après la coupe. À 500 escalades en attente, tous espaces confondus, le
     * balayage cessait de rendre le moindre autre fil. La garde de `runControlSweep` reste, elle, pour les
     * dépôts qui ne filtrent pas (elle est le contrat, ce SQL n'en est qu'une mise en œuvre).
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
   * Marque le fil comme une conversation de TEST (jeton de test d'un scénario, Lot F). Sens unique : une
   * conversation née d'un test le reste, ses messages de test y sont pour toujours. Exclut le fil de l'analyse
   * (donc du push HubSpot par construction) et des statistiques, pour qu'un essai interne ne soit pas compté
   * comme un vrai client dans le tableau de bord.
   *
   * UPDATE SEUL : le message entrant qui porte le jeton a déjà créé la conversation (`recordInbound` tourne
   * avant), donc il n'y a jamais rien à créer ici.
   */
  async markConversationTest(tenantId: string, waId: string): Promise<void> {
    await this.pool.query(
      `update conversations set is_test = true where tenant_id = $1 and wa_id = $2 and not is_test`,
      [tenantId, waId],
    );
  }

  /**
   * Cette conversation est-elle un fil de TEST ? Absente de la base -> `false`, donc un fil inconnu se
   * comporte comme un fil ordinaire.
   *
   * 🔴 CE QU'ELLE SERT : empêcher que le fil reparte chez l'agent de Meta au milieu d'une série d'essais
   * (décision de Julien, 2026-09-16, après son essai réel : « ceux qui vont utiliser ce bouton sont des
   * testeurs ou des super admin du compte ; s'ils veulent le réenclencher, ils pourront le faire en appuyant
   * sur le bouton de leur conversation dans l’Inbox »).
   */
  async estConversationDeTest(tenantId: string, waId: string): Promise<boolean> {
    const res = await this.pool.query<{ is_test: boolean }>(
      `select is_test from conversations where tenant_id = $1 and wa_id = $2`,
      [tenantId, waId],
    );
    return res.rows[0]?.is_test === true;
  }

  /** `channel` : le fil est unique par contact, c'est la BULLE qui porte le tuyau. Absent -> WhatsApp, donc
   *  tous les appelants historiques écrivent exactement ce qu'ils écrivaient. */
  async recordInbound(tenantId: string, m: InboundMessage, channel: 'whatsapp' | 'rcs' = 'whatsapp'): Promise<void> {
    const preview = m.body ?? m.buttonPayload ?? `[${m.type}]`;
    // Un message du CONTACT rouvre la conversation : hors d'Archivé, et plus « Traité ». C'est le seul chemin
    // qui le fait. ⚠️ Sauf une RÉACTION (👍), qui ne retire pas « Traité » et ne change pas qui a parlé en
    // dernier (arbitrage du 2026-09-19) : elle sort seulement d'Archivé, que l'arbitrage ne visait pas.
    const reaction = m.type === 'reaction';
    const conversationId = await this.upsertConversationByWaId(
      tenantId, m.waId, preview, { archive: true, traite: !reaction }, reaction ? 'reaction' : 'in',
    );
    await this.pool.query(
      // ⚠️ `media_id`, `media_mime` et `media_nom` sont ecrits ICI ET NULLE PART AILLEURS (migrations 0125 et
      // 0160) : c est le seul instant ou le corps du webhook est encore sous la main. Un media non capte a
      // l insertion est perdu, aucun chemin en aval ne peut le retrouver.
      `insert into conversation_messages (conversation_id, direction, type, body, button_payload, meta_message_id, channel, media_id, media_mime, media_nom)
       values ($1, 'in', $2, $3, $4, $5, $6, $7, $8, $9)
       on conflict (meta_message_id) where meta_message_id is not null do nothing`,
      [conversationId, m.type, m.body, m.buttonPayload, m.messageId, channel, m.media?.id ?? null, m.media?.mime ?? null, m.media?.nom ?? null],
    );
  }

  /**
   * Journalise un envoi sortant AUTOMATISÉ (template de campagne ou de workflow) par wa_id : upsert la conversation
   * + insère le message 'out' avec `sender_user_id = null` (pas un humain -> pas de pastille agent). Idempotent sur
   * `meta_message_id`. Sans ça, les envois campagne/workflow n'apparaissaient PAS dans le fil d'inbox et manquaient
   * au transcript d'analyse. À appeler en BEST-EFFORT côté appelant (un échec de log ne doit pas casser l'envoi Meta).
   */
  async recordOutboundByWaId(
    tenantId: string,
    waId: string,
    msg: { body: string; messageId: string | null; type?: string; templateCategory?: string | null; templateName?: string | null; channel?: 'whatsapp' | 'rcs'; origine: OrigineMessage },
  ): Promise<void> {
    // `{ archive: false, traite: false }` : un envoi AUTOMATISÉ (campagne, scénario) ne rouvre rien. Une
    // campagne qui touche mille contacts ferait sinon remonter dans l'inbox tous ceux qu'on avait rangés, ou
    // marqués « Traité ».
    const conversationId = await this.upsertConversationByWaId(tenantId, waId, msg.body, { archive: false, traite: false }, 'out');
    await this.pool.query(
      // `channel` : le fil est unique par contact, c'est la bulle qui porte le tuyau. Absent -> WhatsApp,
      // donc tous les appelants historiques écrivent exactement ce qu'ils écrivaient.
      // `origine` est OBLIGATOIRE (migration 0099) : c'est la seule chose qui distingue un envoi de
      // scénario d'une réponse d'agent IA, et la rendre optionnelle aurait laissé un appelant l'oublier
      // en silence. Le type l'exige, donc l'oubli ne compile pas.
      `insert into conversation_messages (conversation_id, direction, type, body, meta_message_id, template_category, template_name, sender_user_id, channel, origin)
       values ($1, 'out', $2, $3, $4, $5, $6, null, $7, $8)
       on conflict (meta_message_id) where meta_message_id is not null do nothing`,
      [conversationId, msg.type ?? 'template', msg.body, msg.messageId, msg.templateCategory ?? null, msg.templateName ?? null, msg.channel ?? 'whatsapp', msg.origine],
    );
  }

  /**
   * Une page de conversations, de la plus récente à la plus ancienne.
   *
   * Le filtrage et la pagination sont faits en SQL, et c'est le point. L'écran filtrait auparavant en mémoire
   * les 100 conversations chargées : passé la centième, « À traiter » ignorait le reste sans le dire. Un
   * filtre qui ment est pire qu'un filtre absent, parce qu'on le croit.
   *
   * Pas de `hasMore` dans la réponse : une page pleine (autant de lignes que `limit`) veut dire qu'il peut y
   * en avoir d'autres, et l'appelant reprend au dernier élément. Un drapeau de plus coûterait un `count`
   * sur toute la table pour dire ce que la longueur dit déjà.
   */
  async listConversations(tenantId: string, opts: ListConversationsOptions = {}): Promise<ConversationSummary[]> {
    // Borné des DEUX côtés : un `limit` venu de la query string ne doit ni vider la page (0) ni ramener la
    // table entière. 100 reste le défaut, donc un appelant qui ne demande rien voit ce qu'il voyait avant.
    const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 100), 1), 200);
    const params: unknown[] = [tenantId];
    const where: string[] = ['c.tenant_id = $1'];

    if (opts.aTraiter === true) {
      where.push(A_TRAITER_SQL);
    }
    // 🔴 Contact BLOQUÉ : sa conversation disparaît de l'inbox, décision produit du 2026-08-21. Ses messages
    // restent ENREGISTRÉS et le contact est retrouvable dans l'écran des contacts bloqués, qui est la seule
    // porte de sortie : sans lui, un contact bloqué serait perdu pour de bon.
    where.push(`(ct.blocked_at is null)`);
    // Les dossiers ordinaires excluent les archivées ; le dossier Archivé ne montre qu'elles. Une conversation
    // archivée n'est donc comptée nulle part ailleurs. ⚠️ « Traité », lui, n'est PAS exclusif : une
    // conversation traitée est aussi dans « Tout » (arbitrage du 2026-09-19), seul Archivé cache.
    where.push(opts.archivees === true ? 'c.archived_at is not null' : 'c.archived_at is null');
    if (opts.signalees === true) {
      // 🔴 UNION des DEUX sources, et l'ordre des membres compte pour le planificateur : le signalement
      // manuel est indexé (`conversations_signalees_main_idx`) et se teste sans sortir de la ligne, le
      // constat de l'analyse demande une sous-requête. Le mettre en premier laisse court-circuiter.
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
      // Comparaison de TUPLE : `(a, b) < (x, y)` suit exactement l'ordre de tri, donc la page suivante
      // reprend pile où la précédente s'est arrêtée, même quand deux fils partagent le même horodatage.
      params.push(opts.before.at, opts.before.id);
      where.push(`(c.last_message_at, c.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
    }
    params.push(limit);

    const res = await this.pool.query<{
      id: string; wa_id: string; profile_name: string | null; last_preview: string | null; last_message_at: Date; curseur: string;
      control_owner: ControlOwner; unread: boolean; assigned_to: string | null; assigned_name: string | null;
      signalee_main: boolean; traitee: boolean;
    }>(
      // curseur : le même instant que last_message_at, mais en TEXTE à la microseconde. Voir
      // `ConversationSummary.curseur` : ici le défaut de précision faisait SAUTER des conversations, pas les
      // dupliquer, ce qui est le sens le plus dangereux des deux.
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
   * Purge par RÉTENTION des conversations (PLAN.md 5.2, lot 2). Supprime celles dont la DERNIÈRE ACTIVITÉ est
   * plus vieille que `days`, tous espaces confondus, comme les autres balayages d'entretien.
   *
   * 🔴 Ce que ça emporte, et c'est voulu : les MESSAGES et l'ANALYSE qualitative de la conversation partent
   * avec elle, par les cascades déjà déclarées en base (migrations 0009 et 0027), donc en une seule commande
   * atomique. L'analyse est le pire de ce qu'on garde : son `topic` et sa `justification` sont du texte libre
   * produit par un modèle à partir de ce que la personne a raconté.
   *
   * Ce que ça n'emporte PAS : la FICHE du contact. Une conversation périmée n'est pas un contact supprimé.
   * L'effacement d'une personne, lui, passe par `purgeMany` du store de contacts, qui anonymise en plus.
   *
   * ⚠️ `days <= 0` DÉSACTIVE la purge. Sans ce test, `make_interval(days => 0)` viserait tout ce qui est
   * antérieur à maintenant, c'est-à-dire l'intégralité des conversations.
   *
   * Effacement BORNÉ par passage : une première purge sur une base qui n'en a jamais eu peut viser beaucoup
   * de lignes, et un `delete` unique tiendrait un verrou et gonflerait le WAL d'un coup. Le balayage repasse.
   */
  /**
   * ⚠️ LA RETENTION EST CELLE DE L'ESPACE QUAND IL EN A UNE (migration 0155), SINON CELLE DE L'INSTANCE.
   *
   * 🔴 LE RESPONSABLE DE TRAITEMENT EST LE CLIENT : c'est a lui de dire combien de temps ses conversations
   * se gardent, pas a nous. `days` reste le DEFAUT applique a tout espace qui n'a rien regle, et un espace
   * a `0` (comme une instance a `0`) n'est jamais purge.
   *
   * ⚠️ LE `coalesce` EST DANS LES DEUX MOITIES DE LA CONDITION, et l'oublier dans l'une des deux serait le
   * genre de defaut qui ne se voit pas : une purge qui filtrerait sur la retention de l'espace mais
   * calculerait l'age sur celle de l'instance effacerait selon une duree que personne n'a choisie.
   *
   * ⚠️ `left join` ET PAS `join` : un espace sans ligne de reglages existe (elle se cree a la premiere
   * modification), et une jointure stricte l'exclurait de la purge en silence, donc le garderait pour
   * toujours sans que rien ne le dise.
   */
  async purgeConversationsOlderThan(days: number, maxParPassage = 500): Promise<number> {
    /**
     * 🔴 LE ZERO D'INSTANCE ARRETE TOUT, Y COMPRIS LES ESPACES QUI ONT REGLE LEUR PROPRE RETENTION, ET CE
     * RETOUR ANTICIPE EST CE QUI LE GARANTIT. Une premiere version l'avait retire au profit du seul
     * `coalesce` en SQL : un espace ayant choisi 90 jours aurait continue a etre purge alors que
     * l'exploitation venait de tout couper. `CONVERSATION_RETENTION_DAYS = 0` est le LEVIER D'URGENCE de
     * la seule operation irreversible du depot ; un levier qui n'arrete pas tout n'est pas un levier.
     *
     * ⚠️ Le `0` PAR ESPACE, lui, ne desactive que cet espace : c'est le `coalesce(...) > 0` ci-dessous.
     * Les deux zeros ne disent pas la meme chose, et c'est voulu.
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

  /** Nombre de conversations NON LUES du tenant (pastille de l'ONGLET Inbox, depuis le lot du 2026-09-08 ;
   *  elle vivait dans la barre latérale avant). Requête dédiée : la pastille est affichée sur toutes les
   *  pages, elle ne doit pas rapatrier 100 conversations pour afficher un nombre. */
  /**
   * 🔴 LA PASTILLE EST CELLE DE L'UTILISATEUR, PAS CELLE DE L'ESPACE. Elle comptait TOUTES les conversations
   * non lues du client, pour tout le monde : un agent voyait « 12 » alors qu'aucune ne lui revenait, et un
   * manager voyait le même chiffre. Une pastille qu'on ne peut pas éteindre soi-même cesse d'être regardée.
   * La règle est celle de `peutEcrire` (`src/inbox/assignment.ts`) : le pot commun pour tout le monde, le
   * reste pour son affectataire, et tout pour un manager ou un admin.
   *
   * ⚠️ `acteur` est OBLIGATOIRE, sans valeur par défaut : un appelant qui l'oublierait rendrait la pastille
   * de l'espace à quelqu'un qui n'a pas le droit de la voir, en silence. Sans défaut, l'oubli est une erreur
   * du compilateur.
   */
  async countUnread(tenantId: string, acteur: ActeurConversation): Promise<number> {
    const res = await this.pool.query<{ n: string }>(
      // 🔴 LES MÊMES EXCLUSIONS QUE LA LISTE, et les deux ont été ajoutées le 2026-09-08 pour la même
      // raison : une pastille qui compte ce que l'écran ne montre pas est un compteur qui ment, et on le
      // croit. On clique, on cherche, on ne trouve pas.
      //  - ARCHIVÉES : elles ne sont plus dans « Tout ». Sans ce filtre, ranger une conversation non lue
      //    laissait la pastille l'annoncer pour toujours, sans aucun moyen de la faire descendre.
      //  - BLOQUÉES : elles n'apparaissent nulle part depuis le 2026-08-21, et la pastille les comptait
      //    quand même. Défaut ANTÉRIEUR à ce lot ; `countATraiter` portait le même, corrigé le 2026-09-09.
      `select count(*)::text as n
         from conversations c
         left join contacts ct on ct.id = c.contact_id
        where c.tenant_id = $1 and c.archived_at is null and ct.blocked_at is null
          and ${visibiliteSql('$2', '$3')} and ${UNREAD_SQL}`,
      [tenantId, voitTout(acteur), acteur.userId],
    );
    return Number(res.rows[0]?.n ?? 0);
  }

  /**
   * Les compteurs du menu de dossiers, en UNE requête pour tous les dossiers et une seconde pour la charge.
   *
   * 🔴 PAS SIX ALLERS-RETOURS, et ce n'est pas de l'optimisation prématurée : six lectures, ce sont six
   * occasions que deux chiffres pris à deux instants différents ne s'accordent pas, et le menu les affiche
   * l'un sous l'autre. Un « Tout (12) » au-dessus d'un « À traiter (13) » se remarque tout de suite.
   *
   * ⚠️ LES CONTACTS BLOQUÉS SONT EXCLUS PARTOUT, comme dans `listConversations`. L'ancien `countATraiter`
   * ne le faisait pas : son chiffre pouvait dépasser le nombre de lignes que la liste montrait, sans que
   * rien ne l'explique. Le compteur unifié ferme cette contradiction, ce qui peut faire BAISSER le nombre
   * affiché chez un client qui a des contacts bloqués. C'est le bon sens de la correction.
   *
   * ⚠️ « Tout » exclut les ARCHIVÉES : sinon deux dossiers compteraient la même conversation, et leur somme
   * dépasserait le nombre de conversations.
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
     * La charge par membre : TOUS les membres de l'espace, y compris à ZÉRO.
     *
     * C'est ce qui répond à la question du manager. Un collaborateur sans conversation est une information,
     * et ne le montrer que lorsqu'il en a le rendrait invisible au moment précis où on le cherche.
     *
     * Tri par nombre décroissant PUIS par nom : sans le second critère, deux membres à égalité
     * changeraient de place d'un rafraîchissement à l'autre.
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
      // Le nom AFFICHABLE, jamais vide : un membre sans nom se reconnaît à son e-mail, et une ligne muette
      // dans une liste de charge ne désigne personne.
      parMembre: membres.rows.map((m) => ({ userId: m.user_id, nom: m.nom ?? m.email, n: Number(m.n) })),
    };
  }

  /**
   * Nombre de conversations « À traiter », pour le compteur de l'onglet.
   *
   * Même raison d'être que `countUnread` : l'écran le calculait sur les conversations CHARGÉES, donc il
   * plafonnait à la taille de la page et affichait un nombre plus petit que la réalité dès qu'un client
   * dépassait cent conversations.
   */
  async countATraiter(tenantId: string): Promise<number> {
    const res = await this.pool.query<{ n: string }>(
      // 🔴 LES MÊMES EXCLUSIONS QUE LE MENU ET QUE LA LISTE (revue du 2026-09-09). Ce compteur-ci les
      // ignorait toutes les deux : il comptait les conversations ARCHIVÉES et celles de contacts BLOQUÉS,
      // donc il rendait un nombre plus grand que le dossier « À traiter » du menu, pour le même espace.
      // La route qui l'expose n'a plus d'appelant depuis que le menu rend tous ses compteurs en une lecture
      // (cf. `todo.md`), mais une route morte qui rend un chiffre FAUX n'est pas du code inerte : c'est un
      // piège armé pour celui qui la rebranchera. Le commentaire de `countUnread` nommait déjà ce défaut.
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
   * Range une conversation dans Archivé, ou l'en sort.
   *
   * Rend `false` si la conversation est inconnue DANS CET ESPACE : l'appelant en fait un 404, jamais un
   * succès silencieux. Le `tenant_id` dans le `where` n'est pas une ceinture de plus, c'est LE contrôle
   * d'isolation : le pooler est superuser, la RLS est contournée.
   *
   * Idempotent : archiver deux fois réécrit l'horodatage, ce qui est sans conséquence. Désarchiver ce qui ne
   * l'est pas ne fait rien non plus, et rend quand même `true` (la conversation existe, l'état voulu est
   * atteint) : distinguer les deux obligerait l'écran à expliquer une nuance que personne ne se pose.
   */
  async archiverConversation(tenantId: string, conversationId: string, archive: boolean): Promise<boolean> {
    const res = await this.pool.query(
      // Le drapeau passe en PARAMÈTRE plutôt que d'être concaténé dans la requête. Il vient d'un booléen,
      // donc rien n'était injectable, mais une requête construite par concaténation demande à chaque
      // relecture de vérifier d'où vient le morceau. Celle-ci ne le demande plus.
      // 🔴 ARCHIVER CLÔT AUSSI UNE ESCALADE (revue finale du 2026-09-23), exactement comme « Traité » : sinon
      // la conversation quitte la liste sans que rien ne la rende jamais à l'agent (le balayage saute les
      // escalades), et le fil reste à l'équipe pour toujours.
      `update conversations set archived_at = case when $3::boolean then now() else null end,
              escaladee_le = case when $3::boolean then null else escaladee_le end
        where id = $1 and tenant_id = $2`,
      [conversationId, tenantId, archive],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /**
   * Marque une conversation « Traité », ou retire ce statut (migration 0160).
   *
   * Même contrat que `archiverConversation` juste au-dessus : `false` = inconnue DANS CET ESPACE, donc un
   * 404, jamais un succès silencieux ; le drapeau passe en PARAMÈTRE ; idempotent dans les deux sens.
   *
   * ⚠️ RETIRER LE STATUT NE REMET PAS FORCÉMENT « À TRAITER » : la conversation retourne là où son dernier
   * message la range. Si c'est NOUS qui avons écrit en dernier, la balle est chez le contact et elle reste
   * dans « Tout ». C'est pourquoi l'écran dit « Ne plus marquer traité » et non « Remettre à traiter ».
   */
  async marquerTraitee(tenantId: string, conversationId: string, traitee: boolean): Promise<boolean> {
    const res = await this.pool.query(
      // « Traité » clôt aussi une escalade (0164) : l'opérateur a jugé qu'il n'y avait rien à répondre.
      `update conversations set traitee_le = case when $3::boolean then now() else null end,
              escaladee_le = case when $3::boolean then null else escaladee_le end
        where id = $1 and tenant_id = $2`,
      [conversationId, tenantId, traitee],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /**
   * Signale une conversation À LA MAIN, ou retire ce signalement (migration 0123).
   *
   * 🔴 N'ÉCRIT JAMAIS `conversation_analysis.abusive`, et c'est tout l'intérêt d'avoir une colonne à part :
   * ce champ-là est un CONSTAT posé par un modèle, recalculé à chaque ré-analyse. Un signalement humain
   * écrit dedans disparaîtrait au passage suivant de l'analyse, sans cause visible. Le dossier « Signalé »
   * montre l'UNION des deux, et chacune reste lisible pour elle-même.
   *
   * L'AUTEUR est enregistré quand on signale, et effacé quand on désignale : garder le nom de celui qui
   * avait signalé une conversation qui ne l'est plus laisserait croire à un signalement toujours actif.
   */
  async signalerConversation(tenantId: string, conversationId: string, signale: boolean, parUserId: string | null): Promise<boolean> {
    const res = await this.pool.query(
      // Même forme que `archiverConversation` : le drapeau est un PARAMÈTRE, pas un morceau de requête
      // concaténé. L'auteur suit le drapeau, il n'a aucun sens sans lui.
      `update conversations
          set signalee_le = case when $3::boolean then now() else null end,
              signalee_par = case when $3::boolean then $4::uuid else null end
        where id = $1 and tenant_id = $2`,
      [conversationId, tenantId, signale, parUserId],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /**
   * Affecte une conversation à un membre, ou la libère (`assignee` à null).
   *
   * Scopé au tenant, et l'affectataire est VÉRIFIÉ appartenir au même espace, dans la même requête : sans
   * cette sous-requête, un identifiant d'utilisateur d'un autre client rendrait la conversation inaccessible
   * à tout le monde, puisque plus personne ne correspondrait à l'affectataire.
   *
   * Renvoie `false` si la conversation est inconnue OU si l'affectataire n'appartient pas au tenant :
   * l'appelant en fait un 404, jamais une affectation silencieusement ignorée.
   */
  async setAssignee(tenantId: string, conversationId: string, assignee: string | null, parUserId: string | null): Promise<boolean> {
    if (assignee === null) {
      const res = await this.pool.query(
        `update conversations set assigned_to = null, assigned_at = null, assigned_by = null
          where id = $1 and tenant_id = $2`,
        [conversationId, tenantId],
      );
      return (res.rowCount ?? 0) > 0;
    }
    const res = await this.pool.query(
      `update conversations set assigned_to = $3, assigned_at = now(), assigned_by = $4
        where id = $1 and tenant_id = $2
          and exists (select 1 from users u where u.id = $3 and u.tenant_id = $2 and u.disabled_at is null)`,
      [conversationId, tenantId, assignee, parUserId],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /**
   * PREND une conversation du pot commun : l'affecte à `userId` SEULEMENT si elle n'est à personne
   * (migration 0160, arbitrage de Julien du 2026-09-19).
   *
   * 🔴 LE `assigned_to is null` EST DANS LE `where`, PAS DANS UNE LECTURE PRÉALABLE, pour la même raison que
   * `assignerSiLibre` : deux agents qui cliquent en même temps liraient tous deux « libre » et écriraient tous
   * deux, et le second retirerait la conversation au premier, qui est peut-être déjà en train de répondre.
   * Ici le second ne touche aucune ligne, et l'appelant le dit.
   *
   * ⚠️ `assigned_by` VAUT L'AGENT LUI-MÊME : le journal d'affectation distingue ainsi une prise (par soi),
   * une distribution (par un manager) et un routage automatique (`null`).
   *
   * ⚠️ MÊME GARDE D'ESPACE que `setAssignee` : un compte d'un autre espace, ou révoqué, ne prend rien.
   *
   * Rend `false` si la conversation est inconnue OU déjà prise : l'appelant relit l'affectation pour dire
   * lequel des deux (404 ou 409).
   */
  async prendreSiLibre(tenantId: string, conversationId: string, userId: string): Promise<boolean> {
    const res = await this.pool.query(
      `update conversations set assigned_to = $3, assigned_at = now(), assigned_by = $3
        where id = $1 and tenant_id = $2 and assigned_to is null
          and exists (select 1 from users u where u.id = $3 and u.tenant_id = $2 and u.disabled_at is null)`,
      [conversationId, tenantId, userId],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /**
   * LES MEMBRES À QUI L'ENCADREMENT PEUT CONFIER UNE CONVERSATION, pour le sélecteur de l'Inbox.
   *
   * 🔴 CE SÉLECTEUR LISAIT `GET /users`, RÉSERVÉ AUX ADMINS : chez un MANAGER, qui a pourtant le droit
   * d'affecter, la liste revenait vide et le menu ne proposait que « Non affectée ». Relevé le 2026-09-19 en
   * préparant la prise par un agent ; personne ne l'avait vu parce que tous les comptes existants étaient
   * admin. Cette lecture-ci ne rend que ce dont le sélecteur a besoin : ni rôle, ni état, ni e-mail
   * au-delà du nom affichable.
   *
   * ⚠️ MÊME CRITÈRE QUE `setAssignee` (compte non révoqué), et PAS celui du tour de rôle
   * (`membresAffectables` exige en plus une première connexion) : un manager peut vouloir confier une
   * conversation à quelqu'un qu'il vient d'inviter, et l'écriture l'accepterait. Proposer moins que ce que
   * l'écriture accepte cacherait un geste permis.
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
   * À qui cette conversation est-elle confiée ? `undefined` = conversation inconnue pour ce tenant, ce qui
   * n'est PAS la même chose que `null` (connue, mais confiée à personne). Les confondre laisserait écrire
   * dans la conversation d'un autre espace, puisque « personne » vaut « ouverte à tous ».
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
   * Marque un fil comme LU (un opérateur vient de l'ouvrir). Scopé au tenant : un id de conversation d'un
   * autre workspace ne marque rien. Idempotent.
   */
  async markConversationRead(tenantId: string, conversationId: string): Promise<void> {
    await this.pool.query(
      `update conversations set last_read_at = now() where id = $1 and tenant_id = $2`,
      [conversationId, tenantId],
    );
  }

  /**
   * Contexte pour répondre : wa_id + état de la fenêtre de service 24 h. La fenêtre est ouverte
   * si le DERNIER message ENTRANT (du client) a moins de 24 h. Hors fenêtre -> texte libre
   * interdit par Meta (131047), il faut un template. null si conversation absente/autre tenant.
   *
   * 🔴 `channel = 'whatsapp'` est INDISPENSABLE, et son absence était un vrai bug (signalé par Julien le
   * 2026-08-25). Depuis la migration 0058, le fil est UNIQUE par contact : les bulles RCS et WhatsApp y
   * cohabitent. Or la fenêtre de 24 h est une règle de MESSAGERIE META, et Meta ne sait rien d'une réponse
   * RCS. Sans ce filtre, un contact qui tapait une suggestion RCS ouvrait la fenêtre WhatsApp à l'écran :
   * l'opérateur lisait « ouvert », envoyait du texte libre, et Meta le refusait en 131047.
   * Mesuré sur la conversation de Julien : dernier entrant tous canaux à 15 h (fenêtre annoncée ouverte),
   * dernier entrant WhatsApp à 50 h (fenêtre réellement fermée).
   */
  async getConversationContext(
    conversationId: string,
    tenantId: string,
  ): Promise<{ waId: string; lastInboundAt: string | null; windowOpen: boolean; langueContact?: string | null } | null> {
    const res = await this.pool.query<{ wa_id: string; last_in: Date | null; langue_detectee: string | null }>(
      // ⚠️ `contacts.langue_detectee` (migration 0137) est NOMMEE ici : la migration est BLOQUANTE,
      // sans elle ce `select` rend `42703` et toutes les routes de l'inbox qui lisent un contexte
      // tombent d'un coup (le fil, la reponse, le template, la transcription).
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
    const windowOpen = !!lastIn && Date.now() - lastIn.getTime() < 24 * 3600 * 1000;
    /**
     * `langueContact` : la langue APPRISE du contact, `null` tant qu'on n'a rien appris.
     *
     * 🔴 `null` N'EST PAS « francais ». C'est le bouton de traduction sortante qui la lit pour NOMMER
     * sa cible : supposer une langue ferait promettre « Traduire en espagnol » a un anglophone, et
     * l'operateur ne s'en apercevrait qu'apres l'envoi. Sans rien d'appris, le bouton nomme la langue
     * par defaut, donc il ne ment pas.
     */
    return { waId: r.wa_id, lastInboundAt: lastIn ? lastIn.toISOString() : null, windowOpen, langueContact: r.langue_detectee };
  }

  /**
   * Fenêtre de service 24 h pour un LOT de wa_id (cible node de /v1/sends, D-1). Même règle que
   * `getConversationContext` : dernier message ENTRANT strictement < 24 h. Un wa_id sans conversation, ou avec
   * une conversation mais aucun inbound, est ABSENT de la map -> l'appelant le traite comme fermé
   * (`.get()` -> undefined -> falsy). Une seule requête pour tout le lot (pas de N+1).
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
      out.set(r.wa_id, Date.now() - r.last_in.getTime() < 24 * 3600 * 1000);
    }
    return out;
  }

  /**
   * Les messages d'un fil, ou seulement CEUX D'APRÈS un point donné (lot 5 du programme II).
   *
   * 🔴 Pourquoi un delta. Le fil ouvert se rafraîchit toutes les 4 secondes et retéléchargeait jusqu'à 500
   * messages à chaque tour, par onglet ouvert : sur une conversation vivante, la même charge partait quinze
   * fois par minute pour n'ajouter parfois qu'une bulle.
   *
   * Le point de reprise est le COUPLE `(created_at, id)`, jamais l'identifiant seul : deux messages peuvent
   * porter le même horodatage (une salve d'un scénario, un import), et l'un des deux se perdrait alors à
   * chaque poll. C'est le même keyset que la pagination des conversations, et l'`order by` porte les deux
   * colonnes pour que la comparaison et le tri parlent de la même chose.
   *
   * ⚠️ Deux messages du MÊME horodatage sortent donc dans l'ordre de leur `id`, un uuid aléatoire : ce n'est
   * pas leur ordre d'arrivée, et rien ne l'enregistre à la milliseconde près pour qu'il puisse l'être. Ce qui
   * compte ici est que le tri soit DÉTERMINISTE (sans quoi le curseur sauterait des messages) ; l'ordre
   * d'affichage de deux messages simultanés, lui, est indifférent. Avant, le tri portait sur `created_at`
   * seul et les ex aequo sortaient dans l'ordre du tas, donc pas même de façon stable.
   */
  async getMessages(conversationId: string, apres?: { at: string; id: string }): Promise<ConversationMessage[]> {
    const res = await this.pool.query<{
      id: string; direction: 'in' | 'out'; type: string | null; body: string | null; button_payload: string | null; created_at: Date; curseur: string; sender_name: string | null; channel: string | null; a_media: boolean; media_expire: boolean; media_nom: string | null; transcription: string | null; transcription_langue: string | null; traduction: string | null; traduction_langue: string | null; redaction_origine: string | null;
    }>(
      // sender_name : name du user, sinon la partie locale de son email ; null si pas d'auteur (legacy/auto).
      // channel : le fil est UNIQUE par contact, c'est chaque bulle qui dit par quel tuyau elle est passée.
      // curseur : le MÊME instant que created_at, mais rendu en TEXTE à la microseconde, parce que la colonne
      // `created_at` ci-dessus traverse un Date JavaScript qui n'en garde que la milliseconde. Voir le
      // commentaire de `ConversationMessage.curseur` : c'est ce qui faisait revenir le dernier message à
      // chaque tour et redéclencher le défilement du fil.
      // 🔴 `traduction`, `traduction_langue`, `redaction_origine` et `transcription_langue` (migration
      // 0137) sont NOMMEES ici, donc cette migration est BLOQUANTE : sans elles, ce `select` rend
      // `42703` et le fil entier tombe, sur la requete la plus appelee du produit (toutes les 4 s).
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
      // Message d'avant la migration 0056 : `channel` est null en base -> WhatsApp.
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
   * Le message à transcrire, RELU DANS SON ESPACE (migration 0125).
   *
   * 🔴 LA JOINTURE SUR `conversations` N'EST PAS DÉCORATIVE, c'est le contrôle d'isolation. `conversation_messages`
   * ne porte pas de `tenant_id` : sans passer par sa conversation, un identifiant de message deviné donnerait
   * accès au vocal d'un AUTRE client. La RLS est contournée (pooler superuser), donc ce filtre est le seul
   * contrôle, comme partout ailleurs dans ce dépôt.
   */
  async lireMessagePourTranscription(tenantId: string, messageId: string, conversationId?: string): Promise<{ id: string; mediaId: string | null; mediaMime: string | null; mediaNom: string | null; mediaExpire: boolean; transcription: string | null; transcriptionLangue: string | null; traduction: string | null; traductionLangue: string | null } | null> {
    // ⚠️ `conversationId` est vérifié quand il est fourni : la route le nomme dans son chemin, et transcrire
    // le message d'une AUTRE conversation ferait mentir l'URL. Ce n'est pas une faille (le filtre d'espace
    // tient au-dessus), c'est une route qui ne fait pas ce qu'elle dit, et ça se paie plus tard.
    const res = await this.pool.query<{ id: string; media_id: string | null; media_mime: string | null; media_nom: string | null; media_expire: boolean; transcription: string | null; transcription_langue: string | null; traduction: string | null; traduction_langue: string | null }>(
      // ⚠️ Les trois dernières colonnes (migration 0137) servent à NE PAS REPAYER : la langue déjà
      // détectée évite de traduire un vocal déjà dans la langue du lecteur, et une traduction déjà
      // rangée dans la bonne langue se relit au lieu de se recalculer.
      // `media_expire` : LE MÊME fragment que l'écran (`MEDIA_EXPIRE_SQL`). Lu ici, il évite un appel à Meta
      // dont on sait d'avance qu'il échouera, et il dit « expiré » plutôt qu'une panne.
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
   * Écrit la transcription, le modèle qui l'a produite, et LA LANGUE DÉTECTÉE. Même garde d'espace
   * que la lecture.
   *
   * 🔴 LA LANGUE ÉTAIT RENDUE PAR `transcrire` DEPUIS LE 2026-09-09 ET JETÉE (migration 0137). Elle
   * sert deux fois, et les deux sont de l'argent : ne pas traduire un vocal déjà dans la langue du
   * lecteur, et alimenter la langue du contact sans un second appel de détection.
   *
   * ⚠️ `langue` en DERNIÈRE position et à défaut `null` : un câblage qui l'oublie compile toujours
   * (une flèche à quatre paramètres reste assignable à un contrat qui en déclare cinq), donc les deux
   * sites d'appel ont été relus plutôt que supposés.
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
   * Les messages ÉCHANGÉS avec un contact depuis un instant donné, pour donner sa mémoire à un agent IA.
   *
   * 🔴 POURQUOI LE TOUR LIT LA CONVERSATION ICI PLUTÔT QUE DE LA RECEVOIR. `advance` ne reçoit pas le texte
   * du message entrant, et le lui faire recevoir changerait la signature du chemin le plus chaud du produit
   * (appelé sur CHAQUE message de CHAQUE client) et de ses trois appelants. `recordInbound` tourne toujours
   * avant `advance` : le fil est donc déjà à jour quand le tour s'exécute, et le lire est gratuit en
   * comparaison. Sans ça l'agent redemande son nom au contact à chaque message.
   *
   * ⚠️ `tenant_id` est dans le `where`, et pas seulement `wa_id` : le pooler est superuser, la RLS est
   * bypassée, et cette lecture part directement dans le contexte d'un modèle. Un fil du mauvais client s'y
   * retrouverait recopié chez le fournisseur.
   *
   * BORNÉE DEUX FOIS. Dans le temps (`depuis` = l'ouverture de la session : l'agent voit la conversation
   * depuis qu'il a la main, pas dix mois d'historique) et en nombre, parce que le contexte se paie à chaque
   * tour. Les plus RÉCENTS sont gardés, et rendus dans l'ordre chronologique.
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
   * EFFACE LE CONTENU d'une conversation : ses messages, et l'aperçu qui en découle. Rend le nombre de
   * messages effacés, ou `null` si la conversation n'est pas de cet espace.
   *
   * 🔴 IRRÉVERSIBLE, ET IL FERME LA FENÊTRE DE SERVICE. `windowOpen` se calcule sur le dernier message
   * ENTRANT (`getConversationContext`) : sans messages, il n'y en a plus, donc la fenêtre de 24 h est close et
   * plus personne ne peut répondre librement à ce contact, ni un opérateur ni un scénario. Ce n'est pas une
   * raison de ne pas le faire, c'est une raison de le DIRE avant de le faire, et l'écran le dit.
   *
   * ⚠️ La CONVERSATION est gardée, seuls ses messages partent. La supprimer emporterait son affectation, son
   * détenteur, sa date de dernière lecture, et surtout l'analyse qui y est rattachée. Effacer un contenu et
   * effacer un fil sont deux gestes différents ; celui-ci est le premier.
   *
   * `last_message_at` n'est PAS remis à zéro : il ordonne la liste de l'inbox, et le mettre à null ferait
   * disparaître la conversation du classement, donc de l'écran, ce qui ressemblerait à une suppression que
   * personne n'a demandée.
   */
  async effacerMessages(tenantId: string, conversationId: string): Promise<number | null> {
    // L'appartenance est vérifiée DANS la suppression, pas avant : entre une vérification et une écriture, le
    // scope pourrait changer. Un seul énoncé ne laisse pas cette fenêtre.
    const res = await this.pool.query(
      `delete from conversation_messages m
        using conversations c
        where m.conversation_id = c.id and c.id = $1 and c.tenant_id = $2`,
      [conversationId, tenantId],
    );
    // `rowCount` à 0 ne dit pas si la conversation existe : un fil vide en rend autant qu'un fil d'un autre
    // espace. On tranche par une lecture scopée, pour rendre 404 plutôt qu'un faux succès.
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
   * La DERNIÈRE SAISIE du contact : le dernier message qu'il a ÉCRIT, tous canaux confondus.
   *
   * Julien, le 2026-09-02 : « il faut qu'on ait un champ système genre last text input, que systématiquement
   * la dernière chose que le client ait dit soit un champ mis à jour constamment ». Elle sert à envoyer au
   * système d'un client ce que la personne vient d'écrire, sans demander au modèle de le recopier, donc sans
   * risquer qu'il le reformule au passage.
   *
   * 🔴 LUE À LA DEMANDE, PAS DÉNORMALISÉE, et c'est le choix qui compte ici. La stocker sur le contact
   * imposerait une écriture de plus sur le chemin le plus chaud du produit (chaque message entrant de chaque
   * client) pour une valeur que très peu de connecteurs réclament, et créerait une seconde vérité qui peut
   * dériver. Ici il n'y a rien à tenir à jour : la source est le fil lui-même.
   *
   * ⚠️ Et surtout PAS `conversations.last_preview`, qui semblait tout indiqué : cette colonne est écrite par
   * les DEUX sens (l'upsert est partagé par le webhook entrant et les envois de campagne ou de scénario).
   * Elle porte donc parfois notre propre message, et un connecteur enverrait alors au client ce que NOUS
   * venons de dire en croyant transmettre ce que le contact a demandé.
   *
   * `direction = 'in'` et un corps non vide : un appui de bouton arrive sans texte, et l'envoyer comme
   * « dernière chose dite » serait faux.
   */
  /**
   * Le texte d'UN message entrant, par son identifiant Meta, dans cet espace. Lu par la réponse « à côté » : c'est
   * CE message qu'elle transmet, pas la dernière saisie du contact (revue finale du 2026-09-22).
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
   * L'identifiant du DERNIER message de l'agent de Meta dans cette conversation (son écho, `type = 'mba'`), ou
   * `null`. Lu par `attendreFinDuTour` (`src/mba/fin-de-tour.ts`) : un identifiant qui CHANGE dit que l'agent a
   * parlé, sans comparer l'horloge de ce serveur à celle de la base.
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
   * L'EMPREINTE DU FIL, relue avant et après l'attente de fin de tour d'un outil de l'agent de Meta
   * (`src/mba/gestes-envoi.ts`) : le détenteur, la date de son dernier changement, et NOTRE dernier envoi (l'écho de
   * l'agent exclu). 🔴 LE DÉTENTEUR SEUL NE SUFFIT PAS (revue du 2026-09-22) : un parcours lancé pendant l'attente
   * réécrit `app_workflow`, qui est aussi la valeur d'une conversation menée par l'agent depuis le début, et
   * `setControlOwner` ne touche à rien sur une valeur identique. Ce parcours, lui, ENVOIE : c'est ce que le dernier
   * envoi voit. Servie par `conversation_messages_origin_idx` (0099). `null` = aucune conversation.
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
   * L'identifiant du dernier message REÇU du client dans cette conversation, ou `null`. Il entre dans la clé de
   * l'anti-rejeu des outils de l'agent de Meta (`src/mba/executer-maison.ts`) : une nouvelle demande du client est
   * un nouveau message. ⚠️ Une RÉACTION n'en est pas une (`recordInbound` l'écrit en `in`, type `reaction`) : elle
   * ne demande rien. Servie par `conversation_messages_conv_idx` (conversation, date).
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

  /** Journalise une réponse sortante de l'agent (texte libre ou template). Pour un template,
   *  `templateCategory` (marketing|utility) + `templateName` alimentent les stats du dashboard.
   *  `senderUserId` (EN FIN de signature) = auteur -> pastille dans l'inbox ; null pour les réponses auto. */
  /** `channel` : le fil est unique par contact, c'est la BULLE qui porte le tuyau. Absent -> WhatsApp, donc
   *  tous les appelants historiques écrivent exactement ce qu'ils écrivaient. */
  async recordOutbound(
    conversationId: string,
    body: string,
    messageId: string | null,
    /**
     * 🔴 OBLIGATOIRE, et placée AVANT les paramètres à défaut pour que ce soit le compilateur qui trouve
     * les appelants (migration 0101).
     *
     * Elle était DÉDUITE de `senderUserId` : « un expéditeur, donc un humain ; pas d'expéditeur, donc un
     * scénario ». C'était vrai tant que ce chemin n'avait que des appelants de la console. Le serveur MCP
     * en a ajouté un sans expéditeur humain, et chaque réponse d'agent tiers est partie marquée
     * « scénario », en silence, sans même déclencher le repli « indéterminée » puisque la valeur était
     * écrite. Une valeur déduite d'un autre champ ne tient que tant que la liste des appelants ne bouge
     * pas, et une liste d'appelants bouge toujours.
     */
    origine: OrigineMessage,
    type = 'text',
    templateCategory: string | null = null,
    templateName: string | null = null,
    senderUserId: string | null = null,
    channel: 'whatsapp' | 'rcs' = 'whatsapp',
    /**
     * Ce que l'opérateur a ÉCRIT avant de faire traduire (migration 0137).
     *
     * 🔴 `body` PORTE CE QUI EST PARTI, y compris traduit : c'est ce que le client a reçu, et notre
     * trace doit y correspondre le jour d'un litige. Cette colonne garde l'original, sans quoi
     * l'opérateur ne peut plus se relire. Ne garder qu'un des deux est faux dans les deux sens.
     *
     * ⚠️ `last_preview` N'EST PAS TOUCHÉ : l'aperçu de la liste montre ce qui est parti, comme avant.
     * Y mettre la rédaction d'origine ferait diverger la liste du fil pour le même message.
     */
    redactionOrigine: string | null = null,
  ): Promise<void> {
    await this.pool.query(
      // `last_direction = 'out'` : c'est LE chemin de la réponse d'un opérateur, de l'agent IA et du serveur
      // MCP. Sans lui, répondre à un client laissait la conversation dans « À traiter » alors qu'on attend
      // désormais le CLIENT, et le dossier cessait d'être une liste de travail.
      //
      // 🔴 ET LA RÉPONSE D'UN HUMAIN REPOUSSE LE DÉGEL. Le balayage rend la main au bout de
      // `CONTROL_HUMAN_TIMEOUT_MS` (deux heures par défaut) comptées depuis `control_changed_at`, qui n'était
      // écrite qu'au CHANGEMENT de détenteur. Un opérateur qui prenait un fil à 10 h et discutait encore à
      // 11 h 55 se le faisait donc reprendre à 12 h, EN PLEINE CONVERSATION, par l'agent de Meta. Le délai
      // court désormais depuis sa dernière réponse, ce qui est la règle telle que Julien l'énonce.
      // ⚠️ `origine = 'humain'` SEULEMENT : une réponse d'agent IA ou de scénario ne prolonge pas un gel
      // humain, sinon un fil resterait gelé par le seul fait qu'un automate parle dedans.
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
