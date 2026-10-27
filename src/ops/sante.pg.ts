import type { Pool } from 'pg';

/**
 * Les deux lectures que l'onglet Santé ajoute aux mesures existantes (refonte de /ops, lot 1) : les connexions de la
 * base et les derniers signaux de Meta. Au mieux, comme le reste de `/ops`.
 */
export class PgSanteStore {
  constructor(private readonly pool: Pool) {}

  /**
   * Les connexions ouvertes sur cette base, rapportées à ce qu'elle accepte hors réserve du superutilisateur. C'est
   * le plafond que compte le budget de `tests/deploy-scaleway.test.ts` (150 en DB-DEV-M, dont 3 réservées).
   */
  async connexionsBase(): Promise<{ utilisees: number; max: number }> {
    const res = await this.pool.query<{ utilisees: number; max: number }>(
      `select (select count(*)::int from pg_stat_activity where datname = current_database()) as utilisees,
              (current_setting('max_connections')::int - current_setting('superuser_reserved_connections')::int) as max`,
    );
    const ligne = res.rows[0];
    return { utilisees: ligne?.utilisees ?? 0, max: ligne?.max ?? 0 };
  }

  /**
   * Quand Meta a parlé pour la dernière fois : un message, un accusé. Un silence anormal (une heure sans rien en pleine
   * journée) dit un webhook coupé chez Meta, qu'aucune autre mesure ne voit. Lu dans les événements gardés quelques
   * jours (`webhook_events`), un par ligne, par la forme de leur clé (`src/webhooks/parse.ts`).
   * ⚠️ Ces lignes sont écrites par le WORKER quand il traite l'événement (`received_at` à l'insertion) : une file en
   * retard ressemble à un silence, d'où « enregistré » à l'écran, et la pastille des entrants pour départager.
   * Une requête par préfixe, chacune arrêtée à la première ligne trouvée en remontant `webhook_events_received_idx`,
   * plutôt qu'un `max` qui visiterait les sept jours à chaque ouverture de l'onglet.
   */
  async signauxMeta(): Promise<{ dernierMessage: string | null; dernierAccuse: string | null }> {
    const res = await this.pool.query<{ dernier_message: Date | null; dernier_accuse: Date | null }>(
      `select (select received_at from webhook_events
                where meta_message_id like 'msg:%' and received_at > now() - interval '7 days'
                order by received_at desc limit 1) as dernier_message,
              (select received_at from webhook_events
                where meta_message_id like 'status:%' and received_at > now() - interval '7 days'
                order by received_at desc limit 1) as dernier_accuse`,
    );
    const ligne = res.rows[0];
    return {
      dernierMessage: ligne?.dernier_message ? ligne.dernier_message.toISOString() : null,
      dernierAccuse: ligne?.dernier_accuse ? ligne.dernier_accuse.toISOString() : null,
    };
  }
}
