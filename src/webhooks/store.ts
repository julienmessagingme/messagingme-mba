import type { Pool } from 'pg';

export interface StoredEvent {
  source: string;
  dedupKey: string;
  data: unknown;
  /** Numéro Meta destinataire : le seul rattachement à un espace que porte un payload Meta (cf. `parse.ts`). */
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
    // meta_message_id a un index unique partiel (where meta_message_id is not null) : le ON CONFLICT doit répéter
    // ce prédicat pour cibler l'index.
    const res = await this.pool.query(
      `insert into webhook_events (source, meta_message_id, payload, processed_at, phone_number_id)
       values ($1, $2, $3, now(), $4)
       on conflict (meta_message_id) where meta_message_id is not null do nothing`,
      [e.source, e.dedupKey, JSON.stringify(e.data), e.phoneNumberId ?? null],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /**
   * Purge par rétention. Cette table garde le payload complet de chaque événement Meta (texte des messages, numéro
   * de qui écrit) ; elle ne sert qu'à l'idempotence (quelques minutes) et au débogage d'un incident.
   * La clé d'idempotence part avec la ligne : un événement redélivré après la rétention serait retraité, sans
   * conséquence (Meta redélivre en minutes, et l'aval est idempotent) ; ne pas descendre à quelques heures pour
   * autant. Effacement borné par passage : une première purge peut viser des millions de lignes, et un `delete`
   * unique tiendrait un verrou et gonflerait le WAL. Le sweeper repasse toutes les heures.
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
