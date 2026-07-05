import type { Pool } from 'pg';

export interface StoredEvent {
  source: string;
  dedupKey: string;
  data: unknown;
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
      `insert into webhook_events (source, meta_message_id, payload, processed_at)
       values ($1, $2, $3, now())
       on conflict (meta_message_id) where meta_message_id is not null do nothing`,
      [e.source, e.dedupKey, JSON.stringify(e.data)],
    );
    return (res.rowCount ?? 0) > 0;
  }
}
