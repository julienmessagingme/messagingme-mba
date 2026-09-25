import type { Pool } from 'pg';
import { matchWaIdPredicat } from '../crm/contact-store.pg';
import { RECIPIENT_FAILED_SQL, INSTANT_ECHEC_SQL } from '../campaign/echecs-sql';
import { STATS_TZ } from '../stats/range';
import { PgEchecsMessagesStore } from '../delivery/echecs-messages.pg';
import { messageDe } from '../lib/erreur';

/**
 * LE JOURNAL DES ERREURS DE LIVRAISON : ce que Meta nous a répondu quand un message n'est pas parti, ou n'est
 * pas arrivé.
 *
 * Julien, le 2026-09-02 : « n'est-il pas nécessaire d'avoir un log des erreurs qui nous sont retournées ?
 * genre le log de retour de l'api meta avec le code erreur... utile quand on a des campagnes et qu'on a des
 * messages d'erreur car tel ou tel message n'est pas délivré ». La donnée existait déjà, par destinataire,
 * mais il fallait ouvrir chaque campagne une par une pour la voir : personne ne le fait, donc personne ne
 * voyait rien.
 *
 * 🔴 CE JOURNAL PORTE LES NUMÉROS, CONTRAIREMENT AU JOURNAL DES ACTIONS, et ce n'est pas une inconséquence.
 * Les deux répondent à des questions opposées :
 *  - le journal des ACTIONS est une preuve immuable de qui a fait quoi. Y écrire un numéro annulerait la purge
 *    d'un contact, en le réinscrivant dans une table faite pour ne jamais être modifiée (migration 0061) ;
 *  - celui-ci est de l'EXPLOITATION : « quel message n'est pas arrivé, et à qui ». Sans le numéro, il ne
 *    répond à rien. Il n'a rien d'immuable, il se lit depuis `campaign_recipients`, et il DISPARAÎT avec le
 *    contact quand on le purge, ce qui est exactement le comportement voulu.
 *
 * Store de LECTURE pour les erreurs de CAMPAGNE : rien n'y est écrit, elles sont déjà posées par l'envoi et
 * par le webhook de statut. Une table de plus qui recopierait ces lignes serait une seconde vérité à tenir à
 * jour.
 *
 * 🔴 Depuis le lot 4 du plan post-audit (2026-09-02), il lit AUSSI les échecs d'avance de scénario, et cette
 * source-là a bien une table (migration 0108). Ce n'est pas une entorse à la règle du dessus : ces échecs
 * n'étaient écrits NULLE PART, la table est leur seul domicile et ne double aucune ligne existante. Une avance
 * qui échouait était acquittée en silence, le contact restait bloqué à son bloc, et personne ne l'apprenait.
 * Même raison pour les échecs de messages LIBRES (migration 0175, lot 3 de l'API publique) : ils n'avaient
 * aucun domicile.
 */

export interface ErreurLivraison {
  /** Identifiant de LIGNE, quelle qu'en soit la source : destinataire de campagne, échec d'avance, ou échec d'un message libre. */
  recipientId: string;
  /** `null` pour un échec de scénario : il n'y a pas de campagne derrière. */
  campaignId: string | null;
  campaignName: string | null;
  /** Le numéro tel qu'il a été appelé. Figé à la construction de la campagne, comme `to_e164`. */
  telephone: string;
  contactId: string | null;
  contactNom: string | null;
  /** Code numérique de Meta (131049, 131026, 130429...). `null` quand l'échec n'en portait pas. */
  code: number | null;
  /** Message d'erreur tel qu'il nous est revenu, borné à l'affichage. */
  message: string | null;
  /**
   * D'où vient l'échec, et la distinction compte pour diagnostiquer :
   *  - `envoi` : Meta a refusé l'appel lui-même (`status = 'failed'`), donc le message n'est jamais parti ;
   *  - `livraison` : l'appel a réussi, et c'est le webhook de statut qui a ensuite signalé l'échec ;
   *  - `scenario` : l'avance d'un parcours a échoué sur un message ENTRANT. Ni l'un ni l'autre des deux
   *    précédents : rien n'a été refusé ni perdu en route, c'est notre traitement qui n'a pas abouti, et le
   *    contact reste posé sur son bloc en attendant.
   *  - `message` : un message LIBRE n'est pas arrivé (migration 0175). Jamais un envoi de campagne, que les
   *    deux premières portent déjà.
   */
  origine: 'envoi' | 'livraison' | 'scenario' | 'message';
  at: string | null;
  /**
   * Ligne `message` seulement (migration 0175) : un message LIBRE (réponse de l'Inbox, API, MCP, bloc de
   * scénario, agent) n'est pas arrivé. `origineMessage` est la colonne origin du message, `canal` son tuyau.
   * Absents sur les trois autres origines.
   */
  origineMessage?: string | null;
  canal?: 'whatsapp' | 'rcs';
}

export interface FiltreErreurs {
  limit?: number;
  /** Cherche dans le message, le code, le nom de la campagne et le numéro. */
  q?: string;
  telephone?: string;
  code?: number;
  /**
   * Bornes de dates (jour civil `YYYY-MM-DD`, fuseau Europe/Paris), pour l'écran Analytics.
   *
   * 🔴 ELLES S'APPLIQUENT SUR `INSTANT_ECHEC_SQL`, et c'est tout l'enjeu. L'ancrage de cette requête
   * s'arrêtait à `coalesce(delivery_updated_at, sent_at)` : mesuré sur la base de production le 2026-09-07,
   * **24 échecs sur 25** n'ont ni l'un ni l'autre (un refus à l'envoi n'a jamais rien envoyé), donc leur
   * date était `null`. Une plage posée sur cet ancrage-là aurait fait disparaître 24 échecs sur 25 de
   * l'écran, silencieusement. Les deux bornes se donnent ensemble ou pas du tout.
   */
  from?: string;
  to?: string;
  /**
   * Restreint à CES campagnes, ou à CES templates. Deux axes que l'écran Analytics tient mutuellement
   * exclusifs (les croiser décrirait leur intersection). Une liste vide vaut « tout », comme leur absence.
   */
  campaignIds?: string[];
  templateNames?: string[];
  /**
   * Les seules erreurs de CAMPAGNE (Analytics). Le détail d'un code s'y ouvre depuis un compteur que
   * `getErrorBreakdown` calcule sur les destinataires de campagne seulement : y mêler les messages libres
   * ferait ouvrir quatorze lignes sous un « 12 ».
   */
  campagnesSeulement?: boolean;
}

interface Ligne {
  recipient_id: string; campaign_id: string; campaign_name: string; to_e164: string;
  contact_id: string | null; contact_nom: string | null;
  error_code: number | null; error: string | null; status: string;
  delivery_status: string | null; at: Date | null;
}

/**
 * LA MOITIÉ SYSTÈME : un appel vers UN SYSTÈME DU CLIENT qui n'a pas abouti (migration 0142).
 *
 * 🔴 ELLE EST D'UNE AUTRE NATURE QUE LA MOITIÉ CLIENT, et c'est pour ça qu'elle ne se mélange pas à elle.
 * Au-dessus, c'est Meta qui refuse un message vers un CONTACT ; ici, c'est le système du CLIENT (son CRM,
 * son ERP, son back-office) qui refuse un appel que NOUS lui passons. Les mêmes colonnes n'auraient aucun
 * sens pour les deux : il n'y a ici ni destinataire, ni campagne, ni code Meta.
 *
 * 🔴 CE QUE L'INVENTAIRE DE LA TÂCHE 9 A TROUVÉ. `agent_tool_calls` est écrite à CHAQUE appel d'outil depuis
 * la migration 0086 et n'est LUE PAR PERSONNE, pas même par la facturation dont son propre commentaire dit
 * qu'elle la sert. Tout ce que le système d'un client nous a répondu de travers y dort depuis des semaines.
 */
export interface EchecAppelSysteme {
  id: string;
  /** Le nom lisible de l'appel : le nom d'outil exposé au modèle, ou le libellé de la requête. */
  nom: string;
  /** QUI a appelé : l'agent IA, un bloc de scénario, ou la poussée d'un opt-out. */
  source: string;
  /** L'issue : `erreur_outil`, `timeout`, `refuse`, `erreur_protocole`, `budget`. */
  statut: string;
  /** Le code HTTP rendu par le système du client, quand il y en a eu un. */
  httpStatus: number | null;
  /** La raison, telle que le résolveur l'a notée. JAMAIS le corps brut de l'erreur du client. */
  erreur: string | null;
  dureeMs: number | null;
  at: string;
}

export class PgErreursLivraisonStore {
  /**
   * `echecsMessages` : la quatrième source (migration 0175). Injectable pour un test, construite ici par
   * défaut : les deux câblages (API et worker) n'ont qu'un `pool` à passer.
   */
  constructor(
    private readonly pool: Pool,
    private readonly echecsMessages: PgEchecsMessagesStore = new PgEchecsMessagesStore(pool),
  ) {}

  /**
   * Les appels de connecteur EN ÉCHEC d'un espace, du plus récent au plus ancien.
   *
   * ⚠️ `status <> 'ok'` ET RIEN D'AUTRE dans le `where`, parce que c'est le PRÉDICAT EXACT de l'index
   * partiel `agent_tool_calls_echecs_idx` (0142). En sortir ne produirait aucune erreur, juste un balayage
   * complet du journal d'appels à chaque ouverture de l'écran.
   *
   * ⚠️ `tenant_id = $1` : le pooler est superuser, la RLS est contournée, le filtrage en code est le seul
   * contrôle. Ce journal nomme les systèmes internes d'un client.
   */
  async listerEchecsSysteme(tenantId: string, limit = 100): Promise<EchecAppelSysteme[]> {
    const n = Math.min(Math.max(limit, 1), 500);
    const res = await this.pool.query<{
      id: string; tool_name: string; source: string; status: string;
      http_status: number | null; erreur: string | null; duree_ms: number | null; at: Date;
    }>(
      `select id, tool_name, source, status, http_status, erreur, duree_ms, at
         from agent_tool_calls
        where tenant_id = $1 and status <> 'ok'
        order by at desc
        limit $2`,
      [tenantId, n],
    );
    return res.rows.map((r) => ({
      id: r.id,
      nom: r.tool_name,
      source: r.source,
      statut: r.status,
      httpStatus: r.http_status,
      erreur: r.erreur,
      dureeMs: r.duree_ms,
      at: r.at.toISOString(),
    }));
  }

  /**
   * Les échecs d'un espace, du plus récent au plus ancien.
   *
   * ⚠️ « En échec » a DEUX définitions en base, et n'en prendre qu'une en cacherait la moitié. Elles ne sont
   * plus écrites ici : `RECIPIENT_FAILED_SQL` et `INSTANT_ECHEC_SQL` (`src/campaign/echecs-sql.ts`) portent
   * la population ET la date, et les quatre lecteurs du dépôt les importent. Elles étaient recopiées, ce qui
   * est exactement la façon dont trois lectures donnent trois chiffres différents du même fait.
   *
   * 🔴 L'ancrage a CHANGÉ le 2026-09-07, et c'est une réparation : il s'arrêtait à
   * `coalesce(delivery_updated_at, sent_at)`, or 24 échecs sur 25 en production n'ont ni l'un ni l'autre
   * (un refus à l'envoi n'envoie rien). Cet écran affichait donc une date vide pour la quasi-totalité de ses
   * lignes, et les reléguait toutes en fin de tri.
   */
  async lister(tenantId: string, filtre: FiltreErreurs = {}): Promise<ErreurLivraison[]> {
    const limit = Math.min(Math.max(filtre.limit ?? 200, 1), 1000);
    const where = [
      'c.tenant_id = $1',
      `(${RECIPIENT_FAILED_SQL})`,
    ];
    const params: unknown[] = [tenantId];
    const ajouter = (fragment: (n: number) => string, valeur: unknown): void => {
      params.push(valeur);
      where.push(fragment(params.length));
    };
    if (filtre.telephone) ajouter((n) => `r.to_e164 ilike '%' || $${n} || '%'`, filtre.telephone);
    if (filtre.code !== undefined) ajouter((n) => `r.error_code = $${n}`, filtre.code);
    // Les bornes sont posées sur le MÊME ancrage que le reste de la requête, et dans le fuseau des
    // statistiques : c'est ce qui permet à un clic sur « 12 » dans Analytics d'ouvrir exactement 12 lignes.
    if (filtre.from && filtre.to) {
      // Le fuseau passe en PARAMÈTRE, comme dans `BOUNDS_CTE` : une constante interpolée dans du SQL est
      // une habitude qui finit par accueillir une valeur qui, elle, ne sera pas constante.
      params.push(filtre.from, filtre.to, STATS_TZ);
      const [a, b, tz] = [params.length - 2, params.length - 1, params.length];
      where.push(`${INSTANT_ECHEC_SQL} >= ($${a}::date)::timestamp at time zone $${tz}`);
      where.push(`${INSTANT_ECHEC_SQL} < (($${b}::date) + 1)::timestamp at time zone $${tz}`);
    }
    // Listes VIDES -> aucun filtre, pas un `= any('{}')` qui ne matcherait rien et viderait l'écran.
    if (filtre.campaignIds?.length) ajouter((n) => `c.id = any($${n}::uuid[])`, filtre.campaignIds);
    if (filtre.templateNames?.length) ajouter((n) => `c.template_name = any($${n}::text[])`, filtre.templateNames);
    if (filtre.q) {
      ajouter(
        (n) => `(r.error ilike '%' || $${n} || '%' or r.error_code::text ilike '%' || $${n} || '%'
                 or c.name ilike '%' || $${n} || '%' or r.to_e164 ilike '%' || $${n} || '%')`,
        filtre.q,
      );
    }
    params.push(limit);

    const res = await this.pool.query<Ligne>(
      // `ct.tenant_id = c.tenant_id` sur la jointure du contact : sans lui, un identifiant de contact d'un
      // autre espace remonterait son nom ici. Le pooler est superuser, la RLS ne joue pas.
      `select r.id as recipient_id, c.id as campaign_id, c.name as campaign_name, r.to_e164,
              ct.id as contact_id, ct.profile_name as contact_nom,
              r.error_code, r.error, r.status, r.delivery_status,
              ${INSTANT_ECHEC_SQL} as at
         from campaign_recipients r
           join campaigns c on c.id = r.campaign_id
           left join contacts ct on ct.id = r.contact_id and ct.tenant_id = c.tenant_id
        where ${where.join(' and ')}
        order by ${INSTANT_ECHEC_SQL} desc nulls last
        limit $${params.length}`,
      params,
    );

    const campagnes: ErreurLivraison[] = res.rows.map((r) => ({
      recipientId: r.recipient_id,
      campaignId: r.campaign_id,
      campaignName: r.campaign_name,
      telephone: r.to_e164,
      contactId: r.contact_id,
      contactNom: r.contact_nom,
      code: r.error_code,
      // Borné : un message d'erreur de Meta peut embarquer une trace, et l'écran n'en a pas besoin pour
      // diagnostiquer. La ligne complète reste dans la campagne.
      message: r.error === null ? null : r.error.slice(0, 500),
      origine: r.status === 'failed' ? 'envoi' : 'livraison',
      at: r.at ? r.at.toISOString() : null,
    }));

    // Analytics ne veut QUE les campagnes : son compteur par code n'en compte pas d'autres (`getErrorBreakdown`).
    if (filtre.campagnesSeulement) return campagnes;

    const avances = await this.listerEchecsAvance(tenantId, filtre, limit);
    // La QUATRIÈME source (migration 0175) : les messages libres non délivrés.
    const messages = await this.echecsMessages.lister(tenantId, filtre, limit);

    /**
     * Fusion en MÉMOIRE plutôt qu'en `union` SQL, et c'est un choix. Les sources n'ont ni les mêmes colonnes
     * ni les mêmes filtres, donc une union ferait cohabiter plusieurs jeux de fragments de WHERE dans une seule
     * requête. Chaque lecture étant bornée par `limit`, on tient au plus trois fois `limit` lignes le temps du tri.
     */
    return [...campagnes, ...avances, ...messages]
      .sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''))
      .slice(0, limit);
  }

  /**
   * Les échecs d'avance de scénario (migration 0108).
   *
   * ⚠️ DÉGRADE PROPREMENT : si cette lecture échoue, on rend une liste vide au lieu de faire échouer tout
   * l'écran. Le journal des erreurs de campagne, lui, doit continuer de s'afficher.
   */
  private async listerEchecsAvance(tenantId: string, filtre: FiltreErreurs, limit: number): Promise<ErreurLivraison[]> {
    // Un échec d'avance ne porte AUCUN code Meta : filtrer par code, c'est demander des erreurs de Meta, donc
    // cette source n'a rien à répondre. Rendre ses lignes quand même serait un filtre qui ne filtre pas.
    if (filtre.code !== undefined) return [];

    const where = ['f.tenant_id = $1'];
    const params: unknown[] = [tenantId];
    const ajouter = (fragment: (n: number) => string, valeur: unknown): void => {
      params.push(valeur);
      where.push(fragment(params.length));
    };
    if (filtre.telephone) ajouter((n) => `f.wa_id ilike '%' || $${n} || '%'`, filtre.telephone);
    if (filtre.q) ajouter((n) => `(f.erreur ilike '%' || $${n} || '%' or f.wa_id ilike '%' || $${n} || '%')`, filtre.q);
    params.push(limit);

    try {
      const res = await this.pool.query<{
        id: string; wa_id: string; erreur: string; at: Date;
        contact_id: string | null; contact_nom: string | null; workflow_nom: string | null;
      }>(
        // Mêmes gardes de tenant que ci-dessus sur les jointures : le pooler est superuser, la RLS ne joue pas.
        //
        // Le rattachement du contact passe par `matchWaIdPredicat`, la règle de routage des entrants du CRM
        // (E.164 exact, puis chiffres nus, puis BSUID) : il n'existe pas de colonne `wa_id` sur `contacts`, et
        // réécrire une correspondance approchante ici en ferait une dixième copie d'une règle déjà partagée.
        `select f.id, f.wa_id, f.erreur, f.at,
                ct.id as contact_id, ct.profile_name as contact_nom, w.name as workflow_nom
           from workflow_advance_failures f
             left join lateral (
               select c2.id, c2.profile_name
                 from contacts c2
                where c2.tenant_id = f.tenant_id and c2.deleted_at is null
                  and ${matchWaIdPredicat('c2.', 'f.wa_id')}
                order by (c2.phone_e164 = '+' || f.wa_id) desc
                limit 1
             ) ct on true
             left join workflows w on w.id = f.workflow_id and w.tenant_id = f.tenant_id
          where ${where.join(' and ')}
          order by f.at desc
          limit $${params.length}`,
        params,
      );
      return res.rows.map((r) => ({
        recipientId: r.id,
        campaignId: null,
        campaignName: r.workflow_nom,
        telephone: r.wa_id,
        contactId: r.contact_id,
        contactNom: r.contact_nom,
        code: null,
        message: r.erreur.slice(0, 500),
        origine: 'scenario' as const,
        at: r.at ? r.at.toISOString() : null,
      }));
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('erreurs-livraison: lecture des échecs d’avance impossible:', messageDe(err));
      return [];
    }
  }

  /**
   * ENREGISTRE un échec d'avance de scénario. Le seul chemin d'écriture de ce fichier.
   *
   * 🔴 BEST-EFFORT, et l'appelant ne doit surtout pas attendre autre chose : un journal d'échec qui ferait
   * échouer le traitement qu'il observe serait une très mauvaise idée. Sans la table, on retombe exactement
   * sur le comportement d'avant, un message dans les logs.
   */
  async enregistrerEchecAvance(e: {
    tenantId: string; waId: string; erreur: string;
    messageId?: string | null; workflowId?: string | null; runId?: string | null; canal?: string | null;
  }): Promise<void> {
    await this.pool.query(
      `insert into workflow_advance_failures (tenant_id, wa_id, message_id, workflow_id, run_id, canal, erreur)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [e.tenantId, e.waId, e.messageId ?? null, e.workflowId ?? null, e.runId ?? null, e.canal ?? null, e.erreur.slice(0, 2000)],
    );
  }

  /**
   * Purge les échecs d'avance trop vieux. C'est de l'EXPLOITATION, pas une preuve : ça ne se garde pas
   * indéfiniment, contrairement au journal d'audit. Appelée par le balayage de rétention général du worker.
   */
  async purgeEchecsAvanceOlderThan(jours: number): Promise<number> {
    const res = await this.pool.query(
      `delete from workflow_advance_failures where at < now() - make_interval(days => $1::int)`,
      [Math.max(1, Math.floor(jours))],
    );
    return res.rowCount ?? 0;
  }
}
