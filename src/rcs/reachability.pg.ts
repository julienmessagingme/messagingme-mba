import type { Pool } from 'pg';
import type { ReachabilityStore } from './reachability';

/** Cache de joignabilité RCS en base (table `rcs_capabilities_cache`, migration 0057). Clé (agent, numéro) :
 *  un même numéro peut être joignable pour un agent lancé et pas pour un agent encore en test. */
export class PgReachabilityStore implements ReachabilityStore {
  constructor(private readonly pool: Pool) {}

  async get(agentId: string, e164: string): Promise<{ reachable: boolean; checkedAt: number } | null> {
    const res = await this.pool.query<{ reachable: boolean; checked_at: Date }>(
      'select reachable, checked_at from rcs_capabilities_cache where agent_id = $1 and phone_e164 = $2',
      [agentId, e164],
    );
    const row = res.rows[0];
    return row ? { reachable: row.reachable, checkedAt: row.checked_at.getTime() } : null;
  }

  async put(agentId: string, e164: string, reachable: boolean, atMs: number): Promise<void> {
    await this.pool.query(
      `insert into rcs_capabilities_cache (agent_id, phone_e164, reachable, checked_at)
       values ($1, $2, $3, to_timestamp($4 / 1000.0))
       on conflict (agent_id, phone_e164)
       do update set reachable = excluded.reachable, checked_at = excluded.checked_at`,
      [agentId, e164, reachable, atMs],
    );
  }
}
