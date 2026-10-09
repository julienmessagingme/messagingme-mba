import type { Pool } from 'pg';
import { detailDuChangement, type PlafondApiStore, type ReglagePlafondApi } from './plafond-espace';
import type { PgAuditStore } from '../audit/store.pg';

/**
 * Le réglage du plafond et des quotas de l'API d'un espace (`tenant_settings.api_plafond_minute`, `api_plafond_heure`,
 * `api_quota_envois_jour`, `api_quota_fiches_jour` ; `null` = le défaut de la configuration). La lecture part de `tenants` : un espace sans ligne de réglages
 * est au défaut, et seule l'absence de l'espace rend `null`, pour que la route d'exploitation dise 404.
 */
export class PgPlafondEspaceStore implements PlafondApiStore {
  /** `audit` : le journal d'audit des espaces, requis. Sans lui, un changement de limites ne laisserait aucune trace durable. */
  constructor(private readonly pool: Pool, private readonly audit: Pick<PgAuditStore, 'record'>) {}

  async lire(tenantId: string): Promise<ReglagePlafondApi | null> {
    const r = await this.pool.query<{ minute: number | null; heure: number | null; envois: number | null; fiches: number | null }>(
      `select s.api_plafond_minute as minute, s.api_plafond_heure as heure,
              s.api_quota_envois_jour as envois, s.api_quota_fiches_jour as fiches
         from tenants t left join tenant_settings s on s.tenant_id = t.id
        where t.id = $1`,
      [tenantId],
    );
    const ligne = r.rows[0];
    return ligne ? { minute: ligne.minute, heure: ligne.heure, envoisJour: ligne.envois, fichesJour: ligne.fiches } : null;
  }

  /**
   * Upsert ciblé : n'écrase aucun autre réglage. Le `select ... from tenants` fait qu'un espace inconnu
   * n'écrit rien (`false`), au lieu de lever sur la clé étrangère, donc de rendre un 500.
   */
  async ecrire(tenantId: string, reglage: ReglagePlafondApi): Promise<boolean> {
    const r = await this.pool.query(
      `insert into tenant_settings (tenant_id, api_plafond_minute, api_plafond_heure, api_quota_envois_jour, api_quota_fiches_jour, updated_at)
       select id, $2::integer, $3::integer, $4::integer, $5::integer, now() from tenants where id = $1
       on conflict (tenant_id) do update set
         api_plafond_minute = excluded.api_plafond_minute,
         api_plafond_heure = excluded.api_plafond_heure,
         api_quota_envois_jour = excluded.api_quota_envois_jour,
         api_quota_fiches_jour = excluded.api_quota_fiches_jour,
         updated_at = now()`,
      [tenantId, reglage.minute, reglage.heure, reglage.envoisJour, reglage.fichesJour],
    );
    return (r.rowCount ?? 0) > 0;
  }

  /**
   * L'acteur est l'adresse de l'exploitant, sans compte dans l'espace (`userId` à `null`), comme la réinitialisation
   * du second facteur depuis `/ops` (`mfa.reinitialise`). La cible est l'espace lui-même.
   */
  async tracer(tenantId: string, trace: { par: string; avant: ReglagePlafondApi; apres: ReglagePlafondApi }): Promise<void> {
    await this.audit.record(
      tenantId,
      { userId: null, email: trace.par },
      'api.limites_modifiees',
      { kind: 'tenant', id: tenantId },
      detailDuChangement(trace.avant, trace.apres),
    );
  }
}
