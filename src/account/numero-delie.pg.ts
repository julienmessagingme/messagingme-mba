import type { Pool } from 'pg';
import { enTransaction } from '../db/transaction';
import type { MotifBlocage } from '../meta/numero-delie';

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
  async pauserCampagne(campaignId: string, tenantId: string, phoneNumberId: string, motif: MotifBlocage): Promise<boolean> {
    if (motif === 'numero_suspendu') {
      // La suspension (lot 4) ne se relit pas en SQL (elle se calcule sur des dates) : la pause est écrite sur la foi
      // de la garde, et une pause devenue fausse (paiement dans la fenêtre du cache) est levée par le balayage des
      // abonnements, toutes les 15 minutes, ou par le paiement lui-même. Toujours sur une campagne qui tourne encore.
      const res = await this.pool.query(
        `update campaigns c set status = 'paused', pause_reason = 'numero_suspendu', paused_until = null
          where c.id = $1 and c.tenant_id = $2 and c.status in ('running', 'scheduled')`,
        [campaignId, tenantId],
      );
      return (res.rowCount ?? 0) > 0;
    }
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

  /**
   * Lève les pauses `numero_suspendu` de l'espace (lot 4) : son abonnement est payé de nouveau. Même reprise que
   * `relier` (une campagne programmée redevient `scheduled`, les autres `running`, relancées par le balayage des
   * campagnes gelées) ; seules ces pauses-là sont levées. Rend le nombre de campagnes reprises.
   */
  async leverPausesSuspension(tenantId: string): Promise<number> {
    const c = await this.pool.query(
      `update campaigns c
          set status = case when c.scheduled_at is not null then 'scheduled' else 'running' end,
              pause_reason = null, paused_until = null
        where c.tenant_id = $1 and c.status = 'paused' and c.pause_reason = 'numero_suspendu'`,
      [tenantId],
    );
    return c.rowCount ?? 0;
  }

  /**
   * L'espace d'un numéro d'envoi et ses chiffres (lot 4, la lecture de la suspension) : `display_phone_number` porte
   * le « + » et des espaces (« +44 1259 797311 »), le numéro fourni est en chiffres seuls. Inconnu : `null`.
   */
  async telephone(phoneNumberId: string): Promise<{ tenantId: string; chiffres: string } | null> {
    const res = await this.pool.query<{ tenant_id: string; chiffres: string }>(
      `select tenant_id, regexp_replace(coalesce(display_phone_number, ''), '[^0-9]', '', 'g') as chiffres
         from phone_numbers where id = $1`,
      [phoneNumberId],
    );
    const l = res.rows[0];
    return l ? { tenantId: l.tenant_id, chiffres: l.chiffres } : null;
  }

  /**
   * Les espaces qui ont une campagne en pause `numero_suspendu` (lot 4), pour le balayage qui lève celles d'un espace
   * qui n'est plus suspendu. Toute la table, délibérément : c'est le worker qui la demande.
   */
  async espacesEnPauseSuspension(): Promise<string[]> {
    const res = await this.pool.query<{ tenant_id: string }>(
      `select distinct tenant_id from campaigns where status = 'paused' and pause_reason = 'numero_suspendu'`,
    );
    return res.rows.map((r) => r.tenant_id);
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
