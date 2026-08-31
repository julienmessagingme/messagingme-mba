import type { Pool } from 'pg';

export interface StoredEvent {
  source: string;
  dedupKey: string;
  data: unknown;
  /** Numéro Meta destinataire : le SEUL rattachement à un espace que porte un payload Meta (cf. `parse.ts`). */
  phoneNumberId?: string;
}

/** Abstraction du stockage des événements (fake en test, Postgres en prod). */
export interface EventStore {
  /** Insère l'événement. Retourne true si nouveau, false si déjà vu (idempotent). */
  insertEvent(e: StoredEvent): Promise<boolean>;
}

export class PgEventStore implements EventStore {
  constructor(private readonly pool: Pool) {}

  async insertEvent(e: StoredEvent): Promise<boolean> {
    // meta_message_id a un index unique PARTIEL (where meta_message_id is not null) :
    // le ON CONFLICT doit répéter ce prédicat pour cibler l'index.
    const res = await this.pool.query(
      `insert into webhook_events (source, meta_message_id, payload, processed_at, phone_number_id)
       values ($1, $2, $3, now(), $4)
       on conflict (meta_message_id) where meta_message_id is not null do nothing`,
      [e.source, e.dedupKey, JSON.stringify(e.data), e.phoneNumberId ?? null],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /**
   * Purge par RÉTENTION (PLAN.md 5.2). Cette table garde le payload complet de chaque événement Meta, donc le
   * texte des messages entrants et le numéro de qui écrit. Elle n'existe que pour l'idempotence (fenêtre de
   * quelques minutes) et le débogage d'un incident : passé le délai de rétention, elle ne sert plus à rien et
   * ne fait que garder des données personnelles.
   *
   * ⚠️ La ligne effacée l'est DÉFINITIVEMENT : la clé d'idempotence part avec. Une redélivrance Meta d'un
   * événement plus vieux que la rétention serait donc retraitée. C'est sans conséquence : Meta redélivre dans
   * les minutes qui suivent, jamais après des semaines, et les traitements en aval (upsert de contact, statut
   * de livraison) sont eux-mêmes idempotents. Ne pas descendre la rétention à quelques heures pour autant.
   *
   * Effacement BORNÉ par passage : une première purge sur une table qui n'en a jamais eu peut viser des
   * millions de lignes, et un `delete` unique tiendrait un verrou et gonflerait le WAL d'un coup. Le sweeper
   * repasse toutes les heures, il rattrapera.
   */
  async purgeOlderThan(days: number, maxParPassage = 50_000): Promise<number> {
    if (days <= 0) return 0;
    const res = await this.pool.query(
      `delete from webhook_events
        where id in (
          select id from webhook_events
           where received_at < now() - make_interval(days => $1)
           limit $2
        )`,
      [Math.floor(days), Math.max(1, maxParPassage)],
    );
    return res.rowCount ?? 0;
  }
}
