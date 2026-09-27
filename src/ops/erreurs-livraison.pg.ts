import type { Pool } from 'pg';
import { matchWaIdPredicat } from '../crm/contact-store.pg';
import { RECIPIENT_FAILED_SQL, INSTANT_ECHEC_SQL } from '../campaign/echecs-sql';
import { STATS_TZ } from '../stats/range';
import { PgEchecsMessagesStore } from '../delivery/echecs-messages.pg';
import { messageDe } from '../lib/erreur';

/**
 * Le journal des erreurs de livraison : ce que Meta nous a répondu quand un message n'est pas parti, ou n'est
 * pas arrivé, vu sur tout l'espace plutôt que campagne par campagne.
 *
 * Il porte les numéros, contrairement au journal des actions : celui-là est une preuve immuable, où un numéro
 * annulerait la purge d'un contact ; celui-ci est de l'exploitation (« quel message n'est pas arrivé, et à
 * qui »), lu depuis `campaign_recipients`, et il disparaît avec le contact purgé.
 *
 * En lecture pour les échecs de campagne, déjà posés par l'envoi et le webhook de statut : les recopier ferait
 * une seconde vérité. Les échecs d'avance de scénario et de messages libres ont leur table, parce qu'ils
 * n'étaient écrits nulle part ailleurs.
 */

export interface ErreurLivraison {
  /** Identifiant de ligne, quelle qu'en soit la source : destinataire de campagne, échec d'avance, ou échec
   *  d'un message libre. */
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
   * D'où vient l'échec :
   *  - `envoi` : Meta a refusé l'appel (`status = 'failed'`), le message n'est jamais parti ;
   *  - `livraison` : l'appel a réussi, le webhook de statut a ensuite signalé l'échec ;
   *  - `scenario` : l'avance d'un parcours a échoué sur un message entrant, le contact reste posé sur son bloc ;
   *  - `message` : un message libre n'est pas arrivé (jamais un envoi de campagne).
   */
  origine: 'envoi' | 'livraison' | 'scenario' | 'message';
  at: string | null;
  /**
   * Ligne `message` seulement : `origineMessage` est la colonne origin du message libre (Inbox, API, MCP, bloc
   * de scénario, agent), `canal` son tuyau. Absents sur les trois autres origines.
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
   * Bornes de dates (jour civil `YYYY-MM-DD`, fuseau Europe/Paris), données ensemble ou pas du tout. Elles
   * s'appliquent sur `INSTANT_ECHEC_SQL` : la plupart des échecs n'ont ni `delivery_updated_at` ni `sent_at`
   * (un refus à l'envoi n'a rien envoyé), un autre ancrage les ferait disparaître de l'écran.
   */
  from?: string;
  to?: string;
  /**
   * Restreint à ces campagnes, ou à ces templates (deux axes qu'Analytics tient exclusifs). Une liste vide vaut
   * « tout », comme leur absence.
   */
  campaignIds?: string[];
  templateNames?: string[];
  /**
   * Les seules erreurs de campagne (Analytics) : le détail d'un code s'ouvre depuis un compteur que
   * `getErrorBreakdown` calcule sur les campagnes seulement, y mêler les messages libres ne tomberait pas juste.
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
 * Un appel vers un système du client (CRM, ERP, back-office) qui n'a pas abouti, lu depuis `agent_tool_calls`.
 * D'une autre nature que les échecs Meta vers un contact (ni destinataire, ni campagne, ni code Meta), d'où un
 * type à part.
 */
export interface EchecAppelSysteme {
  id: string;
  /** Le nom lisible de l'appel : le nom d'outil exposé au modèle, ou le libellé de la requête. */
  nom: string;
  /** Qui a appelé : l'agent IA, un bloc de scénario, ou la poussée d'un opt-out. */
  source: string;
  /** L'issue : `erreur_outil`, `timeout`, `refuse`, `erreur_protocole`, `budget`. */
  statut: string;
  /** Le code HTTP rendu par le système du client, quand il y en a eu un. */
  httpStatus: number | null;
  /** La raison, telle que le résolveur l'a notée. Jamais le corps brut de l'erreur du client. */
  erreur: string | null;
  dureeMs: number | null;
  at: string;
}

export class PgErreursLivraisonStore {
  /** `echecsMessages` est injectable pour un test ; les câblages n'ont qu'un `pool` à passer. */
  constructor(
    private readonly pool: Pool,
    private readonly echecsMessages: PgEchecsMessagesStore = new PgEchecsMessagesStore(pool),
  ) {}

  /**
   * Les appels de connecteur en échec d'un espace, du plus récent au plus ancien.
   *
   * `status <> 'ok'` et rien d'autre dans le `where` : c'est le prédicat exact de l'index partiel
   * `agent_tool_calls_echecs_idx`, en sortir ferait balayer tout le journal à chaque ouverture de l'écran.
   * 🔴 `tenant_id = $1` est le seul contrôle (pooler superuser, RLS contournée), et ce journal nomme les
   * systèmes internes d'un client.
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
   * Les échecs d'un espace, du plus récent au plus ancien. « En échec » a deux définitions en base :
   * `RECIPIENT_FAILED_SQL` et `INSTANT_ECHEC_SQL` (`src/campaign/echecs-sql.ts`) portent la population et la
   * date pour tous les lecteurs, pour que deux écrans ne donnent pas deux chiffres du même fait.
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
    // Bornes posées sur le même ancrage que le reste de la requête, dans le fuseau des statistiques : un clic sur
    // « 12 » dans Analytics ouvre exactement 12 lignes.
    if (filtre.from && filtre.to) {
      // Le fuseau passe en paramètre, comme dans `BOUNDS_CTE`, plutôt qu'interpolé dans le SQL.
      params.push(filtre.from, filtre.to, STATS_TZ);
      const [a, b, tz] = [params.length - 2, params.length - 1, params.length];
      where.push(`${INSTANT_ECHEC_SQL} >= ($${a}::date)::timestamp at time zone $${tz}`);
      where.push(`${INSTANT_ECHEC_SQL} < (($${b}::date) + 1)::timestamp at time zone $${tz}`);
    }
    // Listes vides : aucun filtre, pas un `= any('{}')` qui ne matcherait rien et viderait l'écran.
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
      // 🔴 `ct.tenant_id = c.tenant_id` : sans lui, un contact d'un autre espace remonterait son nom ici (pooler
      // superuser, la RLS ne joue pas).
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
      // Borné : un message d'erreur de Meta peut embarquer une trace ; la ligne complète reste dans la campagne.
      message: r.error === null ? null : r.error.slice(0, 500),
      origine: r.status === 'failed' ? 'envoi' : 'livraison',
      at: r.at ? r.at.toISOString() : null,
    }));

    // Analytics ne veut que les campagnes : son compteur par code n'en compte pas d'autres.
    if (filtre.campagnesSeulement) return campagnes;

    const avances = await this.listerEchecsAvance(tenantId, filtre, limit);
    const messages = await this.echecsMessages.lister(tenantId, filtre, limit);

    /**
     * Fusion en mémoire plutôt qu'en `union` SQL : les sources n'ont ni les mêmes colonnes ni les mêmes filtres.
     * Chaque lecture étant bornée par `limit`, on tient au plus trois fois `limit` lignes le temps du tri.
     */
    return [...campagnes, ...avances, ...messages]
      .sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''))
      .slice(0, limit);
  }

  /**
   * Les échecs d'avance de scénario. Une lecture en échec rend une liste vide : le journal des erreurs de
   * campagne doit continuer de s'afficher.
   */
  private async listerEchecsAvance(tenantId: string, filtre: FiltreErreurs, limit: number): Promise<ErreurLivraison[]> {
    // Un échec d'avance ne porte aucun code Meta : filtrer par code ne doit rien rendre de cette source.
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
        // Mêmes gardes de tenant sur les jointures. Le contact se rattache par `matchWaIdPredicat`, la règle de
        // routage des entrants (E.164 exact, chiffres nus, BSUID) : `contacts` n'a pas de colonne `wa_id`.
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
   * Enregistre un échec d'avance de scénario, seul chemin d'écriture de ce fichier. Best-effort pour
   * l'appelant : un journal d'échec ne doit pas faire échouer le traitement qu'il observe.
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
   * Purge les échecs d'avance trop vieux (de l'exploitation, pas une preuve), appelée par le balayage de
   * rétention du worker.
   */
  async purgeEchecsAvanceOlderThan(jours: number): Promise<number> {
    const res = await this.pool.query(
      `delete from workflow_advance_failures where at < now() - make_interval(days => $1::int)`,
      [Math.max(1, Math.floor(jours))],
    );
    return res.rowCount ?? 0;
  }
}
