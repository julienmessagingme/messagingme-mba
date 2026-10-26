import { describe, it, expect } from 'vitest';
import type { Pool } from 'pg';
import { PgContactStore, type BulkTarget } from '../src/crm/contact-store.pg';

/**
 * LA REQUÊTE DE LA SÉLECTION D'UNE SUPPRESSION EN MASSE (`PgContactStore.selectionAEffacer`, 2026-10-26), lue sans base :
 * ce que la requête DOIT porter pour que l'isolation, les fiches supprimées et l'ordre tiennent. Ce qu'elle rend vraiment
 * sur des données : `tests/integration/contacts-suppression.integration.test.ts`, en CI.
 */
const T = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';

function store(rows: unknown[] = []) {
  const appels: Array<{ sql: string; params: unknown[] }> = [];
  const pool = { query: async (sql: string, params: unknown[]) => { appels.push({ sql, params }); return { rows }; } } as unknown as Pool;
  return { s: new PgContactStore(pool), appels };
}

/** Chaque paramètre est cité, et rien n'est cité au-delà : sinon Postgres refuse la requête. */
function parametresCoherents(sql: string, params: unknown[]): void {
  const cites = new Set([...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));
  expect([...cites].sort((a, b) => a - b)).toEqual(params.map((_, i) => i + 1));
}

describe('la requête de la sélection', () => {
  const PAR_TAG: BulkTarget = { filters: { tags: ['vieux'] }, excludeIds: [] };

  it('🔴 l’espace et les fiches vivantes par le sélecteur de l’action en masse, l’ordre total, la limite ; jamais les fils', async () => {
    const { s, appels } = store();
    await s.selectionAEffacer(T, PAR_TAG, 51);
    const { sql, params } = appels[0]!;
    expect(sql).toMatch(/where tenant_id = \$1 and deleted_at is null and tags @> \$2::text\[\]/);
    expect(sql).toMatch(/order by created_at asc, id asc limit \$3$/);
    expect(params).toEqual([T, ['vieux'], 51]);
    // Aucune date de dernier message n'est lue : les fils partent avec la conservation et la déconnexion du numéro.
    expect(sql).not.toMatch(/conversations|last_message_at/);
    parametresCoherents(sql, params);
  });

  it('🔴 par identifiants : toujours dans l’espace et vivantes, jamais une fiche nommée d’ailleurs ou supprimée', async () => {
    const { s, appels } = store();
    await s.selectionAEffacer(T, { ids: ['00000000-0000-4000-8000-000000000001'] }, 1001);
    expect(appels[0]!.sql).toMatch(/where tenant_id = \$1 and deleted_at is null and id = any\(\$2::uuid\[\]\)/);
    parametresCoherents(appels[0]!.sql, appels[0]!.params);
  });

  it('une cible vide (aucun identifiant) ne rend personne, sans paramètre orphelin', async () => {
    const { s, appels } = store();
    await s.selectionAEffacer(T, { ids: [] }, 10);
    expect(appels[0]!.sql).toMatch(/from contacts where false/);
    parametresCoherents(appels[0]!.sql, appels[0]!.params);
  });

  it('rend chaque fiche avec sa date de création en ISO', async () => {
    const { s } = store([{ id: 'c1', profile_name: 'Camille', phone_e164: '+33612345678', bsuid: null, created_at: new Date('2026-01-02T10:00:00Z') }]);
    expect(await s.selectionAEffacer(T, PAR_TAG, 10)).toEqual([
      { id: 'c1', profileName: 'Camille', phoneE164: '+33612345678', bsuid: null, createdAt: '2026-01-02T10:00:00.000Z' },
    ]);
  });
});
