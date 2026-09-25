import type { Pool } from 'pg';

/**
 * DÉLIER ET RELIER LE NUMÉRO D'UN ESPACE (migration 0180, bloc « Canaux et services » de l'Accueil).
 *
 * Délier ne supprime RIEN : la ligne `phone_numbers` reste, avec son compte WhatsApp et le jeton chiffré de
 * `waba_credentials`, et rien n'est demandé à Meta. C'est ce qui permet de relier d'un clic.
 *
 * 🔴 TOUS LES NUMÉROS DE L'ESPACE, PAS SEULEMENT LE PREMIER. L'interrupteur de l'Accueil dit « le canal
 * WhatsApp de cet espace est éteint » ; une campagne peut viser un autre numéro que le principal, et elle
 * partirait sinon d'un espace que l'administrateur croit éteint. Le parc n'a qu'un numéro par espace
 * aujourd'hui (`SecondNumeroRefuseError`), la règle ne change donc rien au cas réel.
 */
export interface ResultatDelier {
  /** Instant de la déliaison (ISO). Celui qu'on vient de poser, ou celui d'avant si le numéro l'était déjà. */
  delieLe: string;
  /** Campagnes passées en pause `numero_delie` par CE geste. */
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
   * Délie les numéros de l'espace et met en pause ses campagnes WhatsApp en cours ou programmées, dans UNE
   * transaction : un numéro délié dont les campagnes tournent encore n'est pas un état qu'on laisse exister.
   * `null` = l'espace n'a aucun numéro.
   *
   * ⚠️ UNE CAMPAGNE EST « WHATSAPP » DÈS QU'UN DE SES ÉTAGES L'EST, repli compris. Une campagne RCS dont le repli
   * est WhatsApp poursuivrait sinon son premier étage et ferait échouer son second, destinataire par
   * destinataire, pour un état qu'un clic défait.
   *
   * ⚠️ `paused_until` à NUL, et c'est la garde du balayage de reprise : il ne reprend que les pauses qui portent
   * une échéance, et que `debit` ou `hors_horaires` (`reprendreCampagnesDues`, index `campaigns_reprise_idx`).
   * `scheduled_at` n'est PAS touché : c'est lui qui dira, à « Relier », qu'une campagne était programmée.
   *
   * ⚠️ Rejouable : un second « Délier » garde la date du premier, et ne remet en pause que ce qui a été lancé
   * depuis (le point de passage des envois l'aurait fait de toute façon, au premier envoi).
   */
  async delier(tenantId: string): Promise<ResultatDelier | null> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const n = await client.query<{ delie_le: Date }>(
        `update phone_numbers set delie_le = coalesce(delie_le, now()) where tenant_id = $1 returning delie_le`,
        [tenantId],
      );
      const premier = n.rows[0];
      if (!premier) { await client.query('rollback'); return null; }
      const c = await client.query(
        `update campaigns c set status = 'paused', pause_reason = 'numero_delie', paused_until = null
          where c.tenant_id = $1 and c.status in ('running', 'scheduled')
            and (c.channel = 'whatsapp'
                 or exists (select 1 from campaign_etages e where e.campaign_id = c.id and e.canal = 'whatsapp'))`,
        [tenantId],
      );
      await client.query('commit');
      return { delieLe: premier.delie_le.toISOString(), campagnesEnPause: c.rowCount ?? 0 };
    } catch (err) {
      await client.query('rollback').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Relie les numéros de l'espace et lève les pauses `numero_delie`, dans UNE transaction. `null` = aucun numéro.
   *
   * 🔴 AUCUN ENFILEMENT ICI, ET C'EST UN CHOIX. Une campagne repassée `running` avec des destinataires en attente
   * et sans verrou d'exécution est exactement ce que le balayage des campagnes gelées (R4, `listCampagnesGelees`)
   * relance à la minute. Enfiler depuis l'API ferait un second chemin de relance à tenir aligné sur le premier.
   *
   * ⚠️ `scheduled_at` décide : non nul = la campagne était programmée quand on l'a mise en pause (le lancement
   * le remet à nul, `markScheduledRunning`), elle redevient `scheduled` et le balayage des programmées la lance à
   * son heure, tout de suite si l'heure est passée. Seules les pauses `numero_delie` sont levées : une pause
   * décidée par un opérateur, ou une pause de qualité, reste une décision humaine.
   */
  async relier(tenantId: string): Promise<ResultatRelier | null> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const n = await client.query(`update phone_numbers set delie_le = null where tenant_id = $1`, [tenantId]);
      if ((n.rowCount ?? 0) === 0) { await client.query('rollback'); return null; }
      const c = await client.query<{ programmee: boolean }>(
        `update campaigns c
            set status = case when c.scheduled_at is not null then 'scheduled' else 'running' end,
                pause_reason = null, paused_until = null
          where c.tenant_id = $1 and c.status = 'paused' and c.pause_reason = 'numero_delie'
          returning (c.scheduled_at is not null) as programmee`,
        [tenantId],
      );
      await client.query('commit');
      const reprogrammees = c.rows.filter((r) => r.programmee).length;
      return { campagnesReprises: c.rows.length - reprogrammees, campagnesReprogrammees: reprogrammees };
    } catch (err) {
      await client.query('rollback').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Met UNE campagne en pause `numero_delie`, depuis un run qui a buté sur la garde du point de passage des envois.
   * `true` = la pause est écrite ; `false` = rien n'a bougé, parce que le numéro est relié en base ou que la
   * campagne ne tourne plus.
   *
   * 🔴 UNE SEULE INSTRUCTION, ET C'EST TOUT LE CORRECTIF (relecture du 2026-09-25). Le run relisait la base puis
   * écrivait la pause sans condition : un « Relier » validé entre les deux laissait une pause `numero_delie` sur un
   * numéro relié, que plus rien ne levait (le balayage de reprise ignore ce motif, et « Relier » était passé). Et
   * l'écriture sans condition écrasait une pause posée par un opérateur, que « Relier » relançait ensuite.
   *
   * 🔴 `for share` SUR LE NUMÉRO, ET C'EST LE VERROU COHÉRENT AVEC `relier` ET `delier`. Tous deux écrivent la ligne
   * du numéro (`update phone_numbers`) avant de toucher aux campagnes : si « Relier » est en cours, cette instruction
   * ATTEND sa fin, puis relit la ligne à jour et n'écrit rien ; si elle passe la première, « Relier » attend la fin
   * de cette instruction, et son `update campaigns`, qui prend un nouvel instantané, voit la pause et la lève.
   * Aucun interblocage : cette instruction ne tient aucune ligne de `campaigns` pendant qu'elle attend.
   *
   * ⚠️ `status in ('running', 'scheduled')` : les deux états que `delier` met lui-même en pause. Une campagne en
   * pause pour une autre raison (un opérateur, la qualité) garde sa raison.
   *
   * 🔴 `tenant_id = $2` SUR LES DEUX TABLES : l'identifiant de campagne et le numéro viennent du run, mais le pool
   * contourne la RLS, et c'est ce filtre qui fait qu'un numéro d'un espace ne décide jamais pour un autre.
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

  /** Le numéro est-il délié ? Lecture par clé primaire. Numéro inconnu -> `false` (le comportement d'avant). */
  async estDelie(phoneNumberId: string): Promise<boolean> {
    const res = await this.pool.query(
      `select 1 from phone_numbers where id = $1 and delie_le is not null`,
      [phoneNumberId],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /**
   * Parmi ces numéros, ceux qui sont déliés. UNE requête pour toutes les clés d'un webhook, par clé primaire.
   * Une liste vide ne coûte rien : pas d'aller-retour.
   */
  async numerosDelies(ids: readonly string[]): Promise<ReadonlySet<string>> {
    if (ids.length === 0) return new Set();
    const res = await this.pool.query<{ id: string }>(
      `select id from phone_numbers where id = any($1::text[]) and delie_le is not null`,
      [[...ids]],
    );
    return new Set(res.rows.map((r) => r.id));
  }
}
