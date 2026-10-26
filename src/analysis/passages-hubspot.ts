import type { Pool } from 'pg';
import { journaliser } from '../lib/journal';
import type { IssueCloture } from '../crm/hubspot-service';
import { REPONSE_DE_L_EQUIPE_SQL } from '../inbox/origine';

/**
 * LES PASSAGES POUSSÉS À HUBSPOT, ET LEUR CLÔTURE (lot 2b de la reprise humaine, plan
 * `~/mm-hubspot/docs/2026-10-26-lot2b-cloture-relance-plan.md`, migration 0254).
 *
 * 🔴 LA CLÔTURE SE CONSTATE, ELLE NE S'ÉCRIT PAS (décision A). Trois écritures effacent une escalade (`recordOutgoing`,
 * la première réponse humaine, sur le chemin chaud de chaque message ; `basculerRangement`, Traité et Archivé ;
 * `setControlOwner(effacerEscalade)`, appelée par une dizaine de chemins). Y brancher un envoi toucherait le chemin
 * chaud et une dizaine d'appelants, et le prochain chemin ajouté l'oublierait. Un balayage d'une minute compare donc
 * chaque passage ouvert à l'état de sa conversation, et prévient le connecteur, qui coche la tâche.
 *
 * Il cherche aussi les RELANCES dues (décision C) : l'équipe tient la conversation, aucune escalade n'est ouverte, et
 * le dernier message du client attend une réponse depuis `HUBSPOT_RELANCE_EQUIPE_MINUTES`. Une relance s'inscrit
 * AVANT d'être enfilée : la ligne est ce qui empêche de relancer deux fois le même message (aucune file de ce dépôt ne
 * déduplique), et `push-handoff` la clôt s'il ne la pousse pas.
 */

/** Combien de passages un tour traite au plus, de chaque sorte : le suivant reprend la suite une minute après. */
export const LOT_PASSAGES = 50;

export type NaturePassage = 'escalade' | 'relance';

export interface PassageAClore { occasion: string; tenantId: string; conversationId: string }
export interface RelanceDue { tenantId: string; waId: string; conversationId: string; depuis: Date }

export interface PassagesHubspot {
  /** Inscrit un passage ; `false` s'il l'était déjà (même occasion). */
  inscrire(p: { occasion: string; tenantId: string; conversationId: string; nature: NaturePassage; depuis: Date }): Promise<boolean>;
  /** Clôt un passage. Idempotent. */
  clore(occasion: string): Promise<void>;
  /** Retire une relance inscrite qui n'a pas pu être enfilée : le tour suivant la retentera. */
  oublier(occasion: string): Promise<void>;
  /** Une clôture refusée ou en panne : reportée d'une heure, pour ne pas occuper la tête de file. */
  reporter(occasion: string): Promise<void>;
  /** Les passages ouverts que l'état de leur conversation dit clos, les plus anciens d'abord. */
  aClore(limite: number): Promise<PassageAClore[]>;
  /** Les conversations dont le dernier message du client attend depuis `minutes`, sans passage pour ce message. */
  relancesDues(minutes: number, limite: number): Promise<RelanceDue[]>;
}

/** L'occasion d'une relance, la clé que le connecteur garde : la conversation et l'instant du message relancé. */
export function occasionRelance(conversationId: string, depuis: Date): string {
  return `${conversationId}:relance:${depuis.toISOString()}`;
}

export class PgPassagesHubspot implements PassagesHubspot {
  constructor(private readonly pool: Pool) {}

  async inscrire(p: { occasion: string; tenantId: string; conversationId: string; nature: NaturePassage; depuis: Date }): Promise<boolean> {
    const res = await this.pool.query(
      `insert into passages_hubspot (occasion, tenant_id, conversation_id, nature, depuis)
       values ($1, $2, $3, $4, $5)
       on conflict (occasion) do nothing`,
      [p.occasion, p.tenantId, p.conversationId, p.nature, p.depuis],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async clore(occasion: string): Promise<void> {
    await this.pool.query(`update passages_hubspot set clos_le = now() where occasion = $1 and clos_le is null`, [occasion]);
  }

  async oublier(occasion: string): Promise<void> {
    await this.pool.query(`delete from passages_hubspot where occasion = $1 and clos_le is null`, [occasion]);
  }

  async reporter(occasion: string): Promise<void> {
    await this.pool.query(`update passages_hubspot set tentee_le = now() where occasion = $1 and clos_le is null`, [occasion]);
  }

  async aClore(limite: number): Promise<PassageAClore[]> {
    const res = await this.pool.query<{ occasion: string; tenant_id: string; conversation_id: string }>(
      // Une ESCALADE est close quand `escaladee_le` est vidée, ou remplacée par une plus récente (une nouvelle demande,
      // qui a son propre passage). Une RELANCE l'est quand le client n'attend plus : une réponse de l'équipe après le
      // message relancé (`REPONSE_DE_L_EQUIPE_SQL`, la définition des statistiques : une réaction n'en est pas une), un
      // robot qui reprend le fil, Traité, Archivé, ou une escalade qui prend le relais avec son propre passage.
      // 🔴 `depuis` est à la MILLISECONDE (relu en `Date`), les colonnes de la conversation à la MICROSECONDE (`now()`) :
      // on compare la valeur tronquée, sinon chaque escalade paraît « plus récente » que son propre passage et chaque
      // tâche se coche la minute qui suit sa création (relecture du lot 2b).
      `select p.occasion, p.tenant_id, p.conversation_id
         from passages_hubspot p
         join conversations c on c.id = p.conversation_id and c.tenant_id = p.tenant_id
        where p.clos_le is null
          and (p.tentee_le is null or p.tentee_le < now() - interval '1 hour')
          and ((p.nature = 'escalade' and (c.escaladee_le is null or date_trunc('milliseconds', c.escaladee_le) > p.depuis))
            or (p.nature = 'relance' and (
                  c.control_owner <> 'app_human' or c.escaladee_le is not null
               or c.traitee_le is not null or c.archived_at is not null
               or exists (select 1 from conversation_messages m
                           where m.conversation_id = c.id and m.direction = 'out'
                             and date_trunc('milliseconds', m.created_at) > p.depuis and ${REPONSE_DE_L_EQUIPE_SQL}))))
        order by coalesce(p.tentee_le, p.created_at)
        limit $1`,
      [limite],
    );
    return res.rows.map((r) => ({ occasion: r.occasion, tenantId: r.tenant_id, conversationId: r.conversation_id }));
  }

  async relancesDues(minutes: number, limite: number): Promise<RelanceDue[]> {
    const res = await this.pool.query<{ tenant_id: string; wa_id: string; id: string; depuis: Date }>(
      // Seulement les espaces qui ont choisi HubSpot (`hubspot_choix_valide_le`) et gardé la tâche immédiate. Le
      // message du client a moins de 24 h : au-delà, la fenêtre est fermée et la carte ne peut plus répondre.
      // L'attente d'une fin de parcours (`release_mba_apres_message`) n'est pas l'équipe.
      `select c.tenant_id, c.wa_id, c.id, c.last_message_at as depuis
         from conversations c
         join tenant_settings s on s.tenant_id = c.tenant_id
        where s.hubspot_choix_valide_le is not null and coalesce(s.hubspot_passage, true)
          and c.control_owner = 'app_human' and c.escaladee_le is null and c.release_mba_apres_message is null
          and c.traitee_le is null and c.archived_at is null
          and c.last_direction = 'in'
          and c.last_message_at <= now() - make_interval(mins => $1)
          and c.last_message_at > now() - interval '24 hours'
          and not exists (select 1 from passages_hubspot p
                           where p.conversation_id = c.id and p.depuis >= date_trunc('milliseconds', c.last_message_at))
        order by c.last_message_at
        limit $2`,
      [minutes, limite],
    );
    return res.rows.map((r) => ({ tenantId: r.tenant_id, waId: r.wa_id, conversationId: r.id, depuis: new Date(r.depuis) }));
  }
}

export interface BalayagePassagesDeps {
  passages: PassagesHubspot;
  /** `cloreHandoff` : rend une issue, LÈVE sur 429, 5xx et réseau. */
  clore(corps: { tenantId: string; occasion: string }): Promise<IssueCloture>;
  /** Enfile le `push-handoff` d'une relance. */
  enfilerRelance(job: { tenantId: string; waId: string; relance: { occasion: string } }): Promise<void>;
  /** `HUBSPOT_RELANCE_EQUIPE_MINUTES` ; 0 éteint la relance. */
  relanceMinutes: number;
}

/**
 * Un tour du balayage `hubspot-clotures` : clôt ce qui doit l'être, puis enfile les relances dues. Rend le nombre de
 * passages traités. Un échec sur un passage est journalisé et n'arrête pas le tour : le suivant le reprend.
 */
export async function balayerPassages(deps: BalayagePassagesDeps): Promise<number> {
  let traites = 0;
  for (const p of await deps.passages.aClore(LOT_PASSAGES)) {
    try {
      const issue = await deps.clore({ tenantId: p.tenantId, occasion: p.occasion });
      if (issue === 'clos' || issue === 'sans_objet') {
        await deps.passages.clore(p.occasion);
        traites += 1;
      } else {
        // Reste ouvert : un portail à re-consentir ou déconnecté, un connecteur pas encore déployé. Reporté d'une heure,
        // pour qu'un espace en refus n'occupe pas la tête de file des autres.
        journaliser('error', 'hubspot_cloture_refusee', { tenantId: p.tenantId, conversationId: p.conversationId, status: issue.refuse, code: issue.code });
        await deps.passages.reporter(p.occasion);
      }
    } catch (err) {
      journaliser('error', 'hubspot_cloture_impossible', { err, tenantId: p.tenantId, conversationId: p.conversationId });
      await deps.passages.reporter(p.occasion).catch(() => {});
    }
  }
  if (deps.relanceMinutes <= 0) return traites;
  for (const r of await deps.passages.relancesDues(deps.relanceMinutes, LOT_PASSAGES)) {
    const occasion = occasionRelance(r.conversationId, r.depuis);
    if (!(await deps.passages.inscrire({ occasion, tenantId: r.tenantId, conversationId: r.conversationId, nature: 'relance', depuis: r.depuis }))) continue;
    try {
      await deps.enfilerRelance({ tenantId: r.tenantId, waId: r.waId, relance: { occasion } });
      traites += 1;
    } catch (err) {
      journaliser('error', 'hubspot_relance_enfilement_impossible', { err, tenantId: r.tenantId, conversationId: r.conversationId });
      await deps.passages.oublier(occasion);
    }
  }
  return traites;
}
