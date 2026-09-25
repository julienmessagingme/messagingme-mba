import '../../src/charger-env';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgUserFieldStore } from '../../src/crm/field-store.pg';
import { USER_FIELD_TYPES } from '../../src/crm/fields';

/**
 * ANTI-DÉRIVE entre les types de champ déclarés en TypeScript et ce que la BASE accepte.
 *
 * 🔴 Ce test existe parce que l'écart a réellement existé, et longtemps. `datetime` figurait dans
 * `USER_FIELD_TYPES` et dans le menu de l'écran Champs, alors que la contrainte CHECK de la migration 0002
 * ne le connaissait pas : créer un champ « date et heure » rendait « Internal error », par tous les chemins.
 * Le type était donc PROPOSÉ sans avoir jamais été créable. Constaté en production le 2026-08-24, corrigé
 * par la migration 0076.
 *
 * Aucun test unitaire ne pouvait l'attraper : la contrainte vit dans Postgres, pas dans le code. Il faut
 * toucher la vraie base, et c'est ce que fait celui-ci, pour CHAQUE type déclaré.
 */

const url = process.env.DATABASE_URL ?? '';

describe.skipIf(!url)('types de champ : le code et la base sont d’accord', () => {
  let pool: Pool;
  let tenantId: string;
  let store: PgUserFieldStore;

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl() });
    store = new PgUserFieldStore(pool);
    tenantId = (await pool.query<{ id: string }>(
      `insert into tenants (name) values ('itest-field-types') returning id`,
    )).rows[0]!.id;
  });

  afterAll(async () => {
    if (tenantId) await pool.query('delete from tenants where id = $1', [tenantId]);
    await pool.end();
  });

  it('🔴 CHAQUE type déclaré en TypeScript est réellement acceptable par la base', async () => {
    // Boucle sur `USER_FIELD_TYPES` et non sur une liste recopiée : ajouter un type sans migration fera
    // échouer ce test, ce qui est exactement le filet qui manquait.
    for (const type of USER_FIELD_TYPES) {
      await expect(
        store.upsert(tenantId, { key: `sonde_${type}`, label: `Sonde ${type}`, type }),
        `le type « ${type} » est déclaré côté code mais refusé par la base`,
      ).resolves.not.toThrow();
    }
    const relus = await store.list(tenantId);
    expect(relus.map((f) => f.type).sort()).toEqual([...USER_FIELD_TYPES].sort());
  });

  it('un type inconnu de la base reste refusé (la contrainte n’a pas été supprimée)', async () => {
    // L'élargissement ne doit pas être devenu un « tout est permis » : la contrainte garde son rôle.
    await expect(
      pool.query("insert into user_fields (tenant_id, key, label, type) values ($1, 'sonde_x', 'X', 'inexistant')", [tenantId]),
    ).rejects.toThrow();
  });
});
