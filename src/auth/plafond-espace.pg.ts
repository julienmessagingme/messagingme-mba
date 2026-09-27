import type { Pool } from 'pg';
import type { PlafondApiStore, ReglagePlafondApi } from './plafond-espace';

/**
 * Le réglage du plafond de l'API d'un espace (`tenant_settings.api_plafond_minute` et `api_plafond_heure`,
 * `null` = le défaut de la configuration). La lecture part de `tenants` : un espace sans ligne de réglages
 * est au défaut, et seule l'absence de l'espace rend `null`, pour que la route d'exploitation dise 404.
 */
export class PgPlafondEspaceStore implements PlafondApiStore {
  constructor(private readonly pool: Pool) {}

  async lire(tenantId: string): Promise<ReglagePlafondApi | null> {
    const r = await this.pool.query<{ minute: number | null; heure: number | null }>(
      `select s.api_plafond_minute as minute, s.api_plafond_heure as heure
         from tenants t left join tenant_settings s on s.tenant_id = t.id
        where t.id = $1`,
      [tenantId],
    );
    const ligne = r.rows[0];
    return ligne ? { minute: ligne.minute, heure: ligne.heure } : null;
  }

  /**
   * Upsert ciblé : n'écrase aucun autre réglage. Le `select ... from tenants` fait qu'un espace inconnu
   * n'écrit rien (`false`), au lieu de lever sur la clé étrangère, donc de rendre un 500.
   */
  async ecrire(tenantId: string, reglage: ReglagePlafondApi): Promise<boolean> {
    const r = await this.pool.query(
      `insert into tenant_settings (tenant_id, api_plafond_minute, api_plafond_heure, updated_at)
       select id, $2::integer, $3::integer, now() from tenants where id = $1
       on conflict (tenant_id) do update set
         api_plafond_minute = excluded.api_plafond_minute,
         api_plafond_heure = excluded.api_plafond_heure,
         updated_at = now()`,
      [tenantId, reglage.minute, reglage.heure],
    );
    return (r.rowCount ?? 0) > 0;
  }
}
