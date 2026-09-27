import type { Pool } from 'pg';
import { matchWaIdPredicat } from '../crm/contact-store.pg';
import { STATS_TZ } from '../stats/range';
import type { ErreurLivraison, FiltreErreurs } from '../ops/erreurs-livraison.pg';
import { messageDe } from '../lib/erreur';

/**
 * Les échecs de livraison des messages libres (réponse de l'Inbox, RCS libre, API, bloc de scénario) : les statuts
 * de Meta et le rapport smsmode ne mettent à jour que les destinataires de campagne, et cette table est le seul
 * domicile de ces échecs.
 * Seuls les échecs qu'aucune campagne ne porte sont écrits : la requête exclut en plus l'origine `campagne`, pour
 * qu'une tentative ancienne d'un destinataire n'apparaisse pas deux fois.
 */

/** Ce que les deux traitements de statuts savent d'un échec. */
export interface EchecMessageLibre {
  messageId: string;
  /** Code numérique de Meta. `null` pour smsmode, qui n'en donne pas. */
  code: number | null;
  motif: string | null;
  /**
   * L'espace, quand l'appelant le connaît (le rappel smsmode le tient de son URL) : il devient un filtre. Un accusé
   * de Meta n'a que l'identifiant de message, et c'est la ligne retrouvée qui dit l'espace.
   */
  tenantId?: string;
}

/**
 * Ce que le rapport smsmode sait d'un échec quand le message n'est pas (encore) dans le fil : identifiant, espace
 * (code de l'URL de rappel) et numéro (`to`, en chiffres nus, donc un wa_id).
 */
export interface EchecSansMessage {
  messageId: string;
  tenantId: string;
  waId: string;
  canal: 'whatsapp' | 'rcs';
  code: number | null;
  motif: string | null;
}

/**
 * La ligne écrite, ou `null` quand aucun message sortant ne porte cet identifiant : ce `null` fait replier le
 * rapport smsmode sur `noterSansMessage`.
 */
export interface EchecEcrit {
  tenantId: string;
  waId: string;
  canal: string;
  origine: string | null;
}

export class PgEchecsMessagesStore {
  constructor(private readonly pool: Pool) {}

  /**
   * Note un échec. `null` = rien d'écrit : identifiant inconnu, message entrant, envoi de campagne, autre espace que
   * celui annoncé, ou échec déjà noté. Une seule requête, par l'index unique de meta_message_id, et seulement sur un
   * échec.
   * 🔴 `tenant_id` n'est pas toujours dans le WHERE (même exception que `consommerReleaseMba`) : un accusé de Meta ne
   * porte aucun espace, et l'identifiant de message, unique dans toute la base, ne désigne qu'un espace. Quand
   * l'appelant connaît l'espace, il filtre.
   * `on conflict (message_id) do nothing` : pg-boss rejoue un job en entier, et Meta renvoie parfois un échec deux fois.
   */
  async noter(e: EchecMessageLibre): Promise<EchecEcrit | null> {
    const res = await this.pool.query<{ tenant_id: string; wa_id: string; canal: string; origine: string | null }>(
      `insert into echecs_messages (tenant_id, message_id, wa_id, canal, origine, code, motif)
       select c.tenant_id, m.meta_message_id, c.wa_id, m.channel, m.origin, $2::integer, $3
         from conversation_messages m
         join conversations c on c.id = m.conversation_id
        where m.meta_message_id = $1
          and m.direction = 'out'
          and m.origin is distinct from 'campagne'
          and ($4::uuid is null or c.tenant_id = $4::uuid)
       on conflict (message_id) do nothing
       returning tenant_id, wa_id, canal, origine`,
      [e.messageId, e.code, e.motif === null ? null : e.motif.slice(0, 2000), e.tenantId ?? null],
    );
    const r = res.rows[0];
    return r ? { tenantId: r.tenant_id, waId: r.wa_id, canal: r.canal, origine: r.origine } : null;
  }

  /**
   * Note un échec dont le message n'est pas dans conversation_messages : un rapport smsmode rapide peut arriver
   * entre l'envoi et l'inscription du message dans le fil. L'origine reste `null`.
   * `where not exists` : si le message est inscrit, c'est `noter` qui décide, et rien n'est écrit ici. L'espace est
   * connu de l'appelant (URL de rappel, agent vérifié). Même idempotence que `noter`.
   */
  async noterSansMessage(e: EchecSansMessage): Promise<EchecEcrit | null> {
    const res = await this.pool.query<{ tenant_id: string; wa_id: string; canal: string; origine: string | null }>(
      `insert into echecs_messages (tenant_id, message_id, wa_id, canal, origine, code, motif)
       select $1::uuid, $2::text, $3::text, $4::text, null, $5::integer, $6::text
        where not exists (select 1 from conversation_messages m where m.meta_message_id = $2::text)
       on conflict (message_id) do nothing
       returning tenant_id, wa_id, canal, origine`,
      [e.tenantId, e.messageId, e.waId, e.canal, e.code, e.motif === null ? null : e.motif.slice(0, 2000)],
    );
    const r = res.rows[0];
    return r ? { tenantId: r.tenant_id, waId: r.wa_id, canal: r.canal, origine: r.origine } : null;
  }

  /**
   * La source `message` du journal des erreurs, avec les mêmes filtres que les autres. Un message libre n'a ni
   * campagne ni template : ces filtres, ou « campagnes seulement », rendent une liste vide. Le numéro se compare en
   * chiffres (wa_id sans « + »). Table absente : liste vide et une ligne d'erreur.
   */
  async lister(tenantId: string, filtre: FiltreErreurs, limit: number): Promise<ErreurLivraison[]> {
    if (filtre.campagnesSeulement) return [];
    if (filtre.campaignIds?.length || filtre.templateNames?.length) return [];

    const where = ['e.tenant_id = $1'];
    const params: unknown[] = [tenantId];
    const ajouter = (fragment: (n: number) => string, valeur: unknown): void => {
      params.push(valeur);
      where.push(fragment(params.length));
    };
    if (filtre.telephone) {
      const chiffres = filtre.telephone.replace(/[^0-9]/g, '');
      ajouter((n) => `e.wa_id ilike '%' || $${n} || '%'`, chiffres !== '' ? chiffres : filtre.telephone);
    }
    if (filtre.code !== undefined) ajouter((n) => `e.code = $${n}`, filtre.code);
    if (filtre.from && filtre.to) {
      params.push(filtre.from, filtre.to, STATS_TZ);
      const [a, b, tz] = [params.length - 2, params.length - 1, params.length];
      where.push(`e.at >= ($${a}::date)::timestamp at time zone $${tz}`);
      where.push(`e.at < (($${b}::date) + 1)::timestamp at time zone $${tz}`);
    }
    if (filtre.q) {
      ajouter(
        (n) => `(e.motif ilike '%' || $${n} || '%' or e.code::text ilike '%' || $${n} || '%' or e.wa_id ilike '%' || $${n} || '%')`,
        filtre.q,
      );
    }
    params.push(Math.min(Math.max(limit, 1), 1000));

    try {
      const res = await this.pool.query<{
        id: string; wa_id: string; canal: string; origine: string | null; code: number | null; motif: string | null;
        at: Date; contact_id: string | null; contact_nom: string | null;
      }>(
        // 🔴 Garde d'espace sur la jointure du contact aussi : le pooler est superuser.
        `select e.id, e.wa_id, e.canal, e.origine, e.code, e.motif, e.at,
                ct.id as contact_id, ct.profile_name as contact_nom
           from echecs_messages e
             left join lateral (
               select c2.id, c2.profile_name
                 from contacts c2
                where c2.tenant_id = e.tenant_id and c2.deleted_at is null
                  and ${matchWaIdPredicat('c2.', 'e.wa_id')}
                order by (c2.phone_e164 = '+' || e.wa_id) desc
                limit 1
             ) ct on true
          where ${where.join(' and ')}
          order by e.at desc
          limit $${params.length}`,
        params,
      );
      return res.rows.map((r) => ({
        recipientId: r.id,
        campaignId: null,
        campaignName: null,
        telephone: r.wa_id,
        contactId: r.contact_id,
        contactNom: r.contact_nom,
        code: r.code,
        message: r.motif === null ? null : r.motif.slice(0, 500),
        origine: 'message' as const,
        at: r.at.toISOString(),
        origineMessage: r.origine,
        canal: r.canal === 'rcs' ? 'rcs' as const : 'whatsapp' as const,
      }));
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('erreurs-livraison: lecture des échecs de messages libres impossible (migration 0175 passée ?):', messageDe(err));
      return [];
    }
  }

  /** Purge de rétention, appelée par le balayage général du worker. De l'exploitation, pas une preuve. */
  async purgerAvant(jours: number): Promise<number> {
    const res = await this.pool.query(
      `delete from echecs_messages where at < now() - make_interval(days => $1::int)`,
      [Math.max(1, Math.floor(jours))],
    );
    return res.rowCount ?? 0;
  }
}
