import type { Pool } from 'pg';
import { matchWaIdPredicat } from '../crm/contact-store.pg';
import { STATS_TZ } from '../stats/range';
import type { ErreurLivraison, FiltreErreurs } from '../ops/erreurs-livraison.pg';

/**
 * LES ÉCHECS DE LIVRAISON DES MESSAGES LIBRES (spec 2026-09-24, § 5, migration 0175, « défaut 4 »).
 *
 * Le rapport de smsmode et les statuts de Meta ne mettaient à jour que les destinataires de CAMPAGNE. Une
 * réponse de l'Inbox, un RCS libre, un message de l'API ou d'un bloc de scénario qui n'arrivait pas n'était
 * écrit nulle part : ni journal des erreurs, ni joignabilité. Cette table est leur seul domicile.
 *
 * 🔴 SEULS LES ÉCHECS SONT ÉCRITS, ET SEULEMENT CEUX QU'AUCUNE CAMPAGNE NE PORTE. L'appelant ne l'appelle que
 * sur un échec qui n'a touché aucun destinataire de campagne ; la requête exclut en plus l'origine
 * `campagne`, pour qu'une tentative ancienne d'un destinataire de campagne n'apparaisse pas deux fois.
 */

/** Ce que les deux traitements de statuts savent d'un échec. */
export interface EchecMessageLibre {
  messageId: string;
  /** Code numérique de Meta. `null` pour smsmode, qui n'en donne pas. */
  code: number | null;
  motif: string | null;
  /**
   * L'espace, quand l'appelant le CONNAÎT : le rappel smsmode le tient du code de son URL, et il devient
   * alors un filtre. Un accusé de Meta ne connaît qu'un identifiant de message : c'est la ligne retrouvée
   * qui dit l'espace.
   */
  tenantId?: string;
}

/**
 * Ce que le rapport smsmode sait d'un échec quand le message N'EST PAS (encore) inscrit dans le fil : son
 * identifiant, l'espace (le code de l'URL de rappel) et le numéro (`to`, en chiffres nus, donc un wa_id).
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
 * La ligne écrite, ou `null` quand aucun message sortant ne porte cet identifiant : c'est ce `null` qui fait
 * replier le rapport smsmode sur `noterSansMessage` (`traiterRapportRcs`).
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
   * NOTE un échec. `null` = rien d'écrit : identifiant inconnu, message entrant, envoi de campagne, message
   * d'un autre espace que celui annoncé, ou échec déjà noté.
   *
   * 🔴 UNE SEULE REQUÊTE, par l'index unique de meta_message_id (0009). Elle n'a lieu que sur un échec : un
   * statut ordinaire n'y arrive jamais.
   *
   * ⚠️ tenant_id N'EST PAS TOUJOURS DANS LE WHERE, ET C'EST LA MÊME EXCEPTION QUE `consommerReleaseMba` : un
   * accusé de Meta ne porte aucun espace, et l'identifiant de message est unique dans toute la base, donc il
   * ne peut désigner qu'une conversation d'un seul espace. Quand l'appelant connaît l'espace, il le passe et
   * il filtre.
   *
   * ⚠️ `on conflict (message_id) do nothing` S'APPUIE SUR L'INDEX UNIQUE de la migration : pg-boss rejoue un
   * job de statuts en entier, et Meta renvoie parfois deux fois le même échec.
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
   * NOTE un échec dont le message N'EST PAS dans conversation_messages, à partir de ce que le rapport en sait.
   *
   * 🔴 LA COURSE QU'ELLE FERME : l'envoi rend la main, PUIS la route (ou l'Inbox) inscrit le message dans le
   * fil. Un rapport smsmode rapide (numéro sans RCS : UNDELIVERABLE) peut arriver entre les deux ; `noter` ne
   * trouve alors rien, et l'échec retombait dans le silence que ce lot répare (défaut 4). L'origine reste
   * `null` : le message n'était pas encore là pour la dire.
   *
   * ⚠️ `where not exists` : si le message EST inscrit, c'est `noter` qui a décidé (entrant, envoi de campagne,
   * autre espace, déjà noté), et cette méthode n'écrit RIEN. Elle ne sert que l'absence.
   * ⚠️ L'espace est CONNU de l'appelant (le code de l'URL de rappel, puis l'agent vérifié) : il est écrit tel
   * quel. Même idempotence que `noter`, par l'index unique sur message_id.
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
   * La QUATRIÈME source du journal des erreurs, origine `message`, avec les mêmes filtres que les autres.
   *
   * ⚠️ Un message libre n'appartient à aucune campagne ni à aucun template : filtrer par campagne ou par
   * template, ou demander les seules campagnes (Analytics), rend une liste vide.
   * ⚠️ Le numéro se compare en CHIFFRES : la table porte le wa_id (sans « + »), l'écran laisse taper un E.164.
   * ⚠️ DÉGRADE PROPREMENT : table absente (migration pas passée), liste vide et une ligne d'erreur.
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
        // Même garde de tenant sur la jointure du contact que les autres sources : le pooler est superuser.
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
      console.error('erreurs-livraison: lecture des échecs de messages libres impossible (migration 0175 passée ?):', err instanceof Error ? err.message : err);
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
