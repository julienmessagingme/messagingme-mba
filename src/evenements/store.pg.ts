import type { Pool } from 'pg';
import type { MessageRecu } from './types';
import type { LigneEnvoi } from './distribution';
import type { MajEnvoi } from './envoi';

/**
 * 🔴 Les webhooks sortants en Postgres (migration 0223). `tenant_id = $1` sur chaque requête qui sert un espace : le
 * pooler est en rôle superuser, la RLS est contournée, ce filtre est le seul contrôle. Une seule lecture transverse,
 * `espacesEtTypes`, qui alimente le cache de l'émetteur.
 *
 * Le secret ne sort jamais vers un écran : `lister` et `lire` ne le sélectionnent pas, seul `pourEnvoi` (le worker et
 * l'essai) le rend, chiffré.
 */
export interface AdresseVue {
  id: string;
  url: string;
  description: string;
  types: string[];
  active: boolean;
  creeLe: string;
  /** Fin de la fenêtre où l'ancien secret signe encore, après une rotation. `null` = aucune rotation en cours. */
  ancienSecretJusqua: string | null;
  derniereLivraisonLe: string | null;
  /** Envois qui ont échoué au moins une fois et se réessaient encore. */
  enReessai: number;
  /** Envois abandonnés (24 h d'échecs, 410, adresse en pause ou au-delà de l'offre). */
  echecs: number;
}

export interface SecretsAdresse {
  url: string;
  active: boolean;
  /** Place de l'adresse parmi les actives de l'espace, la plus ancienne d'abord : au-delà de l'offre, elle est gelée. */
  rang: number;
  secretChiffre: string;
  secretPrecedentChiffre: string | null;
  secretPrecedentJusqua: Date | null;
}

type LigneAdresse = {
  id: string; url: string; description: string; types: string[]; active: boolean; cree_le: Date;
  secret_precedent_jusqua: Date | null; derniere_livraison: Date | null; en_reessai: number; echecs: number;
};

const vue = (r: LigneAdresse): AdresseVue => ({
  id: r.id, url: r.url, description: r.description, types: r.types, active: r.active, creeLe: r.cree_le.toISOString(),
  ancienSecretJusqua: r.secret_precedent_jusqua && r.secret_precedent_jusqua.getTime() > Date.now() ? r.secret_precedent_jusqua.toISOString() : null,
  derniereLivraisonLe: r.derniere_livraison?.toISOString() ?? null,
  enReessai: r.en_reessai, echecs: r.echecs,
});

/** Les colonnes d'une adresse vue par l'écran, avec l'état de ses envois (servi par l'index du journal). */
const COLONNES_VUE = `a.id, a.url, a.description, a.types, a.active, a.cree_le, a.secret_precedent_jusqua,
  (select max(e.livre_le) from envois_evenements e where e.adresse_id = a.id) as derniere_livraison,
  (select count(*)::int from envois_evenements e where e.adresse_id = a.id and e.statut = 'en_cours' and e.tentatives > 0) as en_reessai,
  (select count(*)::int from envois_evenements e where e.adresse_id = a.id and e.statut = 'echec') as echecs`;

/**
 * Le rang d'une adresse parmi les actives de son espace, la plus ancienne d'abord, à égalité par identifiant : le même
 * ordre que `activesPourDistribution`, sinon la distribution et l'envoi ne gèleraient pas la même adresse.
 */
const RANG_SQL = `(select count(*)::int from adresses_evenements b
   where b.tenant_id = a.tenant_id and b.active and (b.cree_le, b.id) <= (a.cree_le, a.id))`;

export class PgAdressesEvenementsStore {
  constructor(private readonly pool: Pool) {}

  async lister(tenantId: string): Promise<AdresseVue[]> {
    const res = await this.pool.query<LigneAdresse>(
      `select ${COLONNES_VUE} from adresses_evenements a where a.tenant_id = $1 order by a.cree_le, a.id`,
      [tenantId],
    );
    return res.rows.map(vue);
  }

  async lire(tenantId: string, id: string): Promise<AdresseVue | null> {
    const res = await this.pool.query<LigneAdresse>(
      `select ${COLONNES_VUE} from adresses_evenements a where a.tenant_id = $1 and a.id = $2`,
      [tenantId, id],
    );
    return res.rows[0] ? vue(res.rows[0]) : null;
  }

  /** L'adresse existe-t-elle dans cet espace ? Sans agrégat : la garde du journal et du rejeu ne lit pas le journal. */
  async existe(tenantId: string, id: string): Promise<boolean> {
    const res = await this.pool.query(`select 1 from adresses_evenements where tenant_id = $1 and id = $2`, [tenantId, id]);
    return (res.rowCount ?? 0) > 0;
  }

  /** Les adresses actives, `exclure` à part (celle qu'on réactive ne se compte pas elle-même). */
  async compterActives(tenantId: string, exclure: string | null = null): Promise<number> {
    const res = await this.pool.query<{ n: number }>(
      `select count(*)::int as n from adresses_evenements where tenant_id = $1 and active and ($2::uuid is null or id <> $2::uuid)`,
      [tenantId, exclure],
    );
    return res.rows[0]?.n ?? 0;
  }

  async creer(tenantId: string, a: { url: string; description: string; types: readonly string[]; secretChiffre: string }): Promise<AdresseVue> {
    const res = await this.pool.query<{ id: string }>(
      `insert into adresses_evenements (tenant_id, url, description, types, secret_chiffre)
       values ($1, $2, $3, $4::text[], $5) returning id`,
      [tenantId, a.url, a.description, [...a.types], a.secretChiffre],
    );
    return (await this.lire(tenantId, res.rows[0]!.id))!;
  }

  async modifier(tenantId: string, id: string, m: { description?: string; types?: readonly string[]; active?: boolean }): Promise<AdresseVue | null> {
    const res = await this.pool.query(
      `update adresses_evenements set
         description = coalesce($3::text, description),
         types = coalesce($4::text[], types),
         active = coalesce($5::boolean, active),
         maj_le = now()
       where tenant_id = $1 and id = $2`,
      [tenantId, id, m.description ?? null, m.types === undefined ? null : [...m.types], m.active ?? null],
    );
    return (res.rowCount ?? 0) > 0 ? this.lire(tenantId, id) : null;
  }

  /** La rotation : le secret actuel devient l'ancien, qui signe encore jusqu'à `ancienJusqua`. */
  async tourner(tenantId: string, id: string, secretChiffre: string, ancienJusqua: Date): Promise<boolean> {
    const res = await this.pool.query(
      `update adresses_evenements set
         secret_precedent_chiffre = secret_chiffre, secret_precedent_jusqua = $4, secret_chiffre = $3, maj_le = now()
       where tenant_id = $1 and id = $2`,
      [tenantId, id, secretChiffre, ancienJusqua],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /** Supprimer une adresse emporte son journal (cascade) : ses envois en attente deviennent périmés. */
  async supprimer(tenantId: string, id: string): Promise<boolean> {
    const res = await this.pool.query(`delete from adresses_evenements where tenant_id = $1 and id = $2`, [tenantId, id]);
    return (res.rowCount ?? 0) > 0;
  }

  /** Les adresses ACTIVES, dans l'ordre du gel par l'offre : la plus ancienne d'abord. */
  async activesPourDistribution(tenantId: string): Promise<Array<{ id: string; types: string[] }>> {
    const res = await this.pool.query<{ id: string; types: string[] }>(
      `select id, types from adresses_evenements where tenant_id = $1 and active order by cree_le, id`,
      [tenantId],
    );
    return res.rows;
  }

  async pourEnvoi(tenantId: string, id: string): Promise<SecretsAdresse | null> {
    const res = await this.pool.query<{
      url: string; active: boolean; rang: number; secret_chiffre: string; secret_precedent_chiffre: string | null; secret_precedent_jusqua: Date | null;
    }>(
      `select a.url, a.active, ${RANG_SQL} as rang, a.secret_chiffre, a.secret_precedent_chiffre, a.secret_precedent_jusqua
         from adresses_evenements a where a.tenant_id = $1 and a.id = $2`,
      [tenantId, id],
    );
    const r = res.rows[0];
    return r ? {
      url: r.url, active: r.active, rang: r.rang, secretChiffre: r.secret_chiffre,
      secretPrecedentChiffre: r.secret_precedent_chiffre, secretPrecedentJusqua: r.secret_precedent_jusqua,
    } : null;
  }

  /** La seule lecture transverse : les espaces qui ont au moins une adresse active, et les types qu'elles veulent. */
  async espacesEtTypes(): Promise<Map<string, Set<string>>> {
    const res = await this.pool.query<{ tenant_id: string; types: string[] }>(
      `select tenant_id, array_agg(distinct t) as types
         from adresses_evenements, unnest(types) as t where active group by tenant_id`,
    );
    return new Map(res.rows.map((r) => [r.tenant_id, new Set(r.types)]));
  }
}

export interface EnvoiVue {
  id: string;
  evenementId: string;
  type: string;
  statut: 'en_cours' | 'livre' | 'echec';
  tentatives: number;
  dernierCode: number | null;
  derniereReponse: string | null;
  prochainEssaiLe: string | null;
  creeLe: string;
  livreLe: string | null;
  corps: string;
}

type LigneEnvoiVue = {
  id: string; evenement_id: string; type: string; statut: EnvoiVue['statut']; tentatives: number; dernier_code: number | null;
  derniere_reponse: string | null; prochain_essai_le: Date | null; cree_le: Date; livre_le: Date | null; corps: string;
};

/**
 * Un envoi « en cours » dont l'essai est en retard de plus de 15 minutes : son job est perdu (un arrêt du worker au
 * mauvais moment, un job parti en DLQ, un espace verrouillé puis rouvert). Un essai programmé l'est au plus à une heure,
 * et un retard de 15 minutes ne s'explique que par une file très chargée : le rejouer ajoute au pire un job périmé.
 */
export const ORPHELIN_SQL = `coalesce(prochain_essai_le, cree_le) < now() - interval '15 minutes'`;

export class PgEnvoisEvenementsStore {
  constructor(private readonly pool: Pool) {}

  /**
   * Insère les lignes en une instruction. Reviennent les lignes neuves, ET celles qui existaient sans avoir jamais été
   * tentées : une distribution rejouée après un arrêt entre l'écriture et l'enfilement les réenfile (le job en trop se
   * retrouvera périmé). Un événement déjà tenté (livré, en réessai, en échec) n'est jamais renvoyé par là.
   */
  async creer(lignes: readonly LigneEnvoi[]): Promise<Array<{ id: string; type: string }>> {
    if (lignes.length === 0) return [];
    const res = await this.pool.query<{ id: string; type: string }>(
      `insert into envois_evenements (tenant_id, adresse_id, evenement_id, type, contact_id, corps)
       select * from unnest($1::uuid[], $2::uuid[], $3::text[], $4::text[], $5::uuid[], $6::text[])
       on conflict (adresse_id, evenement_id) do update set prochain_essai_le = envois_evenements.prochain_essai_le
         where envois_evenements.tentatives = 0 and envois_evenements.statut = 'en_cours'
       returning id, type`,
      [
        lignes.map((l) => l.tenantId), lignes.map((l) => l.adresseId), lignes.map((l) => l.evenementId),
        lignes.map((l) => l.type), lignes.map((l) => l.contactId), lignes.map((l) => l.corps),
      ],
    );
    return res.rows;
  }

  async pourEnvoi(tenantId: string, envoiId: string): Promise<{
    id: string; adresseId: string; statut: EnvoiVue['statut']; tentatives: number; essaisDepuis: Date; evenementId: string; type: string; corps: string;
  } | null> {
    const res = await this.pool.query<{
      id: string; adresse_id: string; statut: EnvoiVue['statut']; tentatives: number; essais_depuis: Date; evenement_id: string; type: string; corps: string;
    }>(
      `select id, adresse_id, statut, tentatives, essais_depuis, evenement_id, type, corps
         from envois_evenements where tenant_id = $1 and id = $2`,
      [tenantId, envoiId],
    );
    const r = res.rows[0];
    return r ? {
      id: r.id, adresseId: r.adresse_id, statut: r.statut, tentatives: r.tentatives, essaisDepuis: r.essais_depuis,
      evenementId: r.evenement_id, type: r.type, corps: r.corps,
    } : null;
  }

  /**
   * L'issue de la tentative `tentativeAttendue`, écrite seulement si la ligne en est toujours là : un job périmé (un
   * doublon d'enfilement, un rejeu passé entre-temps) n'écrase rien.
   */
  async noter(tenantId: string, envoiId: string, tentativeAttendue: number, maj: MajEnvoi): Promise<void> {
    await this.pool.query(
      `update envois_evenements set
         statut = $4, tentatives = tentatives + 1, dernier_code = $5, derniere_reponse = $6, prochain_essai_le = $7,
         livre_le = case when $4 = 'livre' then now() else livre_le end
       where tenant_id = $1 and id = $2 and tentatives = $3 and statut = 'en_cours'`,
      [tenantId, envoiId, tentativeAttendue, maj.statut, maj.code, maj.extrait === '' ? null : maj.extrait, maj.prochainEssai],
    );
  }

  /** Le journal d'une adresse, le plus récent d'abord, par pages (`avant` : la date de création de la dernière ligne lue). */
  async journal(tenantId: string, adresseId: string, o: { avant: Date | null; limite: number }): Promise<EnvoiVue[]> {
    const res = await this.pool.query<LigneEnvoiVue>(
      `select id, evenement_id, type, statut, tentatives, dernier_code, derniere_reponse, prochain_essai_le, cree_le, livre_le, corps
         from envois_evenements
        where tenant_id = $1 and adresse_id = $2 and ($3::timestamptz is null or cree_le < $3)
        order by cree_le desc limit $4`,
      [tenantId, adresseId, o.avant, o.limite],
    );
    return res.rows.map((r) => ({
      id: r.id, evenementId: r.evenement_id, type: r.type, statut: r.statut, tentatives: r.tentatives, dernierCode: r.dernier_code,
      derniereReponse: r.derniere_reponse, prochainEssaiLe: r.prochain_essai_le?.toISOString() ?? null, creeLe: r.cree_le.toISOString(),
      livreLe: r.livre_le?.toISOString() ?? null, corps: r.corps,
    }));
  }

  /**
   * Rejouer un envoi terminé (livré ou en échec) : il repart avec le même corps et le même identifiant, et la fenêtre
   * des 24 h se rouvre. Rend la tentative à faire, ou `null` si l'envoi est introuvable ou encore en cours.
   */
  async rejouer(tenantId: string, envoiId: string): Promise<{ tentative: number } | null> {
    const res = await this.pool.query<{ tentatives: number }>(
      `update envois_evenements set statut = 'en_cours', essais_depuis = now(), prochain_essai_le = now()
        where tenant_id = $1 and id = $2 and type <> 'test' and (statut <> 'en_cours' or ${ORPHELIN_SQL})
        returning tentatives`,
      [tenantId, envoiId],
    );
    return res.rows[0] ? { tentative: res.rows[0].tentatives } : null;
  }

  /** Rejouer les échecs d'une adresse depuis une date, au plus `max` (les plus anciens d'abord). */
  async rejouerEchecs(tenantId: string, adresseId: string, depuis: Date, max: number): Promise<Array<{ id: string; tentative: number }>> {
    const res = await this.pool.query<{ id: string; tentatives: number }>(
      `update envois_evenements set statut = 'en_cours', essais_depuis = now(), prochain_essai_le = now()
        where id in (
          select id from envois_evenements
           where tenant_id = $1 and adresse_id = $2 and type <> 'test' and cree_le >= $3
             and (statut = 'echec' or (statut = 'en_cours' and ${ORPHELIN_SQL}))
           order by cree_le limit $4)
          and tenant_id = $1
        returning id, tentatives`,
      [tenantId, adresseId, depuis, max],
    );
    return res.rows.map((r) => ({ id: r.id, tentative: r.tentatives }));
  }

  /** L'événement d'essai : une seule tentative, faite tout de suite par l'API, écrite au journal avec son issue. */
  async noterEssai(tenantId: string, adresseId: string, e: { evenementId: string; corps: string; livre: boolean; code: number | null; extrait: string }): Promise<void> {
    await this.pool.query(
      `insert into envois_evenements (tenant_id, adresse_id, evenement_id, type, corps, statut, tentatives, dernier_code, derniere_reponse, livre_le)
       values ($1, $2, $3, 'test', $4, $5, 1, $6, $7, case when $5 = 'livre' then now() end)`,
      [tenantId, adresseId, e.evenementId, e.corps, e.livre ? 'livre' : 'echec', e.code, e.extrait === '' ? null : e.extrait],
    );
  }

  /** La conversation d'un contact, pour que l'application sache à qui répondre (`conversation.needs_reply`). */
  async conversationDuContact(tenantId: string, waId: string): Promise<string | null> {
    const res = await this.pool.query<{ id: string }>(
      `select id from conversations where tenant_id = $1 and wa_id = $2 limit 1`,
      [tenantId, waId],
    );
    return res.rows[0]?.id ?? null;
  }

  /** Une suppression d'espace en cours (`tenants.status = 'locked'`), ou un espace disparu : rien ne part. */
  async espaceVerrouille(tenantId: string): Promise<boolean> {
    const res = await this.pool.query<{ status: string }>(`select status from tenants where id = $1`, [tenantId]);
    return (res.rows[0]?.status ?? 'locked') === 'locked';
  }

  /** Le message d'un contact, pour `message.received` : relu par l'espace, jamais par le seul identifiant de Meta. */
  async messageRecu(tenantId: string, messageId: string): Promise<MessageRecu | null> {
    const res = await this.pool.query<{ type: string | null; body: string | null; transcription: string | null }>(
      `select m.type, m.body, m.transcription from conversation_messages m join conversations c on c.id = m.conversation_id
        where c.tenant_id = $1 and m.meta_message_id = $2 and m.direction = 'in' limit 1`,
      [tenantId, messageId],
    );
    const r = res.rows[0];
    return r ? { type: r.type, text: r.body, transcription: r.transcription } : null;
  }

  /**
   * La purge du journal, selon l'offre de chaque espace (`offre_de_l_espace`, migration 0218). Les durées viennent de la
   * grille (`DROITS`), jamais écrites ici. L'offre se lit une fois par espace, pas une fois par ligne.
   */
  async purger(jours: { base: number; pro: number; entreprise: number }): Promise<number> {
    const res = await this.pool.query(
      `with espaces as (
         select t.id, case offre_de_l_espace(t.id) when 'base' then $1::int when 'pro' then $2::int else $3::int end as jours
           from tenants t where exists (select 1 from envois_evenements e where e.tenant_id = t.id)
       )
       delete from envois_evenements e using espaces s
        where e.tenant_id = s.id and e.cree_le < now() - make_interval(days => s.jours)`,
      [jours.base, jours.pro, jours.entreprise],
    );
    return res.rowCount ?? 0;
  }
}
