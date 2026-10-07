import type { Pool } from 'pg';

/**
 * LA PIERRE TOMBALE D'UN ESPACE SUPPRIMÉ (RC8, migration 0219) : cet espace a-t-il été supprimé par l'exploitation ?
 * Lue par la file (`PgBossQueue.abandonnerSi`) quand un job échoue, jamais sur le chemin d'un job qui réussit : un job
 * d'un espace supprimé (campagne, tour d'agent, analyse) se termine alors en silence au lieu de finir dans la file des
 * morts. Une ligne PRÉSENTE fait foi, jamais une absence dans `tenants` : un espace introuvable pour une autre raison
 * reste une panne à voir.
 */
export function creerPierreTombale(pool: Pick<Pool, 'query'>): (tenantId: string) => Promise<boolean> {
  return async (tenantId) => {
    const res = await pool.query('select 1 from espaces_supprimes where tenant_id = $1', [tenantId]);
    return (res.rowCount ?? 0) > 0;
  };
}
