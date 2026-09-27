import type { Pool } from 'pg';
import { enTransaction } from '../db/transaction';

/**
 * Délier et relier le numéro d'un espace. Délier ne supprime rien et ne demande rien à Meta (numéro, compte et
 * jeton chiffré restent) : c'est ce qui permet de relier d'un clic.
 * Tous les numéros de l'espace, pas seulement le premier : une campagne visant un autre numéro partirait sinon
 * d'un espace que l'administrateur croit éteint.
 */
export interface ResultatDelier {
  /** Instant de la déliaison (ISO). Celui qu'on vient de poser, ou celui d'avant si le numéro l'était déjà. */
  delieLe: string;
  /** Campagnes passées en pause `numero_delie` par ce geste. */
  campagnesEnPause: number;
}

export interface ResultatRelier {
  /** Campagnes repassées `running` : le balayage des campagnes gelées les relance dans la minute. */
  campagnesReprises: number;
  /** Campagnes repassées `scheduled` : elles partiront à leur heure, ou dans la minute si elle est passée. */
  campagnesReprogrammees: number;
}

export class PgNumeroDelieStore {
  constructor(private readonly pool: Pool) {}

  /**
   * Délie les numéros de l'espace et met en pause ses campagnes WhatsApp en cours ou programmées, dans une
   * transaction. `null` = l'espace n'a aucun numéro.
   *
   * Une campagne est « WhatsApp » dès qu'un de ses étages l'est, repli compris.
   * `paused_until` à nul : le balayage de reprise (`reprendreCampagnesDues`) ne reprend que les pauses datées.
   * `scheduled_at` n'est pas touché : il dira, à « Relier », qu'une campagne était programmée.
   * Rejouable : un second « Délier » garde la date du premier.
   */
  async delier(tenantId: string): Promise<ResultatDelier | null> {
    return enTransaction(this.pool, async (client) => {
      const n = await client.query<{ delie_le: Date }>(
        `update phone_numbers set delie_le = coalesce(delie_le, now()) where tenant_id = $1 returning delie_le`,
        [tenantId],
      );
      const premier = n.rows[0];
      if (!premier) return null;
      const c = await client.query(
        `update campaigns c set status = 'paused', pause_reason = 'numero_delie', paused_until = null
          where c.tenant_id = $1 and c.status in ('running', 'scheduled')
            and (c.channel = 'whatsapp'
                 or exists (select 1 from campaign_etages e where e.campaign_id = c.id and e.canal = 'whatsapp'))`,
        [tenantId],
      );
      return { delieLe: premier.delie_le.toISOString(), campagnesEnPause: c.rowCount ?? 0 };
    });
  }

  /**
   * Relie les numéros de l'espace et lève les pauses `numero_delie`, dans une transaction. `null` = aucun numéro.
   *
   * Aucun enfilement ici : une campagne repassée `running` sans verrou d'exécution est relancée à la minute par le
   * balayage des campagnes gelées (`listCampagnesGelees`), un second chemin de relance serait à tenir aligné.
   * `scheduled_at` non nul = la campagne était programmée : elle redevient `scheduled` et part à son heure. Seules
   * les pauses `numero_delie` sont levées : celles d'un opérateur ou de qualité restent une décision humaine.
   */
  async relier(tenantId: string): Promise<ResultatRelier | null> {
    return enTransaction(this.pool, async (client) => {
      const n = await client.query(`update phone_numbers set delie_le = null where tenant_id = $1`, [tenantId]);
      if ((n.rowCount ?? 0) === 0) return null;
      const c = await client.query<{ programmee: boolean }>(
        `update campaigns c
            set status = case when c.scheduled_at is not null then 'scheduled' else 'running' end,
                pause_reason = null, paused_until = null
          where c.tenant_id = $1 and c.status = 'paused' and c.pause_reason = 'numero_delie'
          returning (c.scheduled_at is not null) as programmee`,
        [tenantId],
      );
      const reprogrammees = c.rows.filter((r) => r.programmee).length;
      return { campagnesReprises: c.rows.length - reprogrammees, campagnesReprogrammees: reprogrammees };
    });
  }

  /**
   * Met une campagne en pause `numero_delie`, depuis un run qui a buté sur la garde des envois. `true` = pause
   * écrite ; `false` = numéro relié en base ou campagne arrêtée.
   *
   * Une seule instruction conditionnelle : lire puis écrire laisserait un « Relier » intercalé poser une pause que
   * plus rien ne lève, et écraserait la pause d'un opérateur.
   * `for share` sur le numéro, cohérent avec `relier` et `delier` qui écrivent le numéro avant les campagnes : l'un
   * attend l'autre, et le perdant voit l'état à jour. Aucun interblocage (aucune ligne de `campaigns` tenue).
   * 🔴 `tenant_id = $2` sur les deux tables : un numéro d'un espace ne décide jamais pour un autre.
   */
  async pauserCampagne(campaignId: string, tenantId: string, phoneNumberId: string): Promise<boolean> {
    const res = await this.pool.query(
      `update campaigns c set status = 'paused', pause_reason = 'numero_delie', paused_until = null
        where c.id = $1 and c.tenant_id = $2 and c.status in ('running', 'scheduled')
          and exists (select 1 from phone_numbers p
                       where p.id = $3 and p.tenant_id = $2 and p.delie_le is not null
                       for share)`,
      [campaignId, tenantId, phoneNumberId],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /** Le numéro est-il délié ? Lecture par clé primaire. Numéro inconnu : `false`. */
  async estDelie(phoneNumberId: string): Promise<boolean> {
    const res = await this.pool.query(
      `select 1 from phone_numbers where id = $1 and delie_le is not null`,
      [phoneNumberId],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /** Parmi ces numéros, ceux qui sont déliés : une requête pour toutes les clés d'un webhook, aucune si vide. */
  async numerosDelies(ids: readonly string[]): Promise<ReadonlySet<string>> {
    if (ids.length === 0) return new Set();
    const res = await this.pool.query<{ id: string }>(
      `select id from phone_numbers where id = any($1::text[]) and delie_le is not null`,
      [[...ids]],
    );
    return new Set(res.rows.map((r) => r.id));
  }
}
