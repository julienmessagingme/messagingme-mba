import '../../src/charger-env';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgContactStore, type BulkTarget } from '../../src/crm/contact-store.pg';

/**
 * LA SÉLECTION D'UNE SUPPRESSION EN MASSE DEPUIS CLAUDE (`PgContactStore.selectionAEffacer`, plan
 * `docs/superpowers/plans/2026-10-26-free-au-dela-de-100-contacts.md`), sur une vraie base : les fiches vivantes de
 * l'espace, la cible de l'action en masse, l'ordre total, la limite. Ce que les outils en font :
 * `tests/mcp-suppression.test.ts`.
 *
 * ⚠️ Ne PAS le lancer en local : le `DATABASE_URL` du `.env` local pointe sur la base de PRODUCTION. La CI monte un
 * Postgres jetable pour ça (job `integration`).
 */
const url = process.env.DATABASE_URL ?? '';
const tel = (n: number) => `+3369991${String(n).padStart(4, '0')}`;

describe.skipIf(!url)('la sélection d’une suppression en masse', () => {
  let pool: Pool;
  let store: PgContactStore;
  let t = '';
  let autre = '';

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl() });
    store = new PgContactStore(pool);
    t = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-suppression-contacts') returning id`)).rows[0]!.id;
    autre = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-suppression-contacts-autre') returning id`)).rows[0]!.id;
  });
  beforeEach(async () => {
    await pool.query('delete from contacts where tenant_id = any($1::uuid[])', [[t, autre]]);
  });
  afterAll(async () => {
    await pool.query('delete from tenants where id = any($1::uuid[])', [[t, autre]]);
    await pool.end();
  });

  /** Une fiche, créée à une date choisie (c'est l'ordre de la sélection). Rend son identifiant. */
  async function creer(tenant: string, n: number, o: { creeLe?: string; tags?: string[]; optIn?: string } = {}): Promise<string> {
    const r = await pool.query<{ id: string }>(
      'insert into contacts (tenant_id, phone_e164, tags, opt_in_status, created_at) values ($1, $2, $3, $4, $5) returning id',
      [tenant, tel(n), o.tags ?? [], o.optIn ?? 'unknown', o.creeLe ?? '2026-01-01T10:00:00Z'],
    );
    return r.rows[0]!.id;
  }
  const ids = (fiches: Array<{ id: string }>) => fiches.map((f) => f.id);
  const TOUT: BulkTarget = { filters: {}, excludeIds: [] };

  it('🔴 les fiches vivantes de l’espace, les plus anciennes d’abord, à date égale par identifiant, jusqu’à la limite', async () => {
    const a = await creer(t, 1, { creeLe: '2026-01-03T10:00:00Z' });
    const b = await creer(t, 2, { creeLe: '2026-01-01T10:00:00Z' });
    const c = await creer(t, 3, { creeLe: '2026-01-02T10:00:00Z' });
    const d = await creer(t, 4, { creeLe: '2026-01-02T10:00:00Z' });
    const supprimee = await creer(t, 5, { creeLe: '2025-01-01T10:00:00Z' });
    await pool.query('update contacts set deleted_at = now() where id = $1', [supprimee]);
    await creer(autre, 6, { creeLe: '2024-01-01T10:00:00Z' });
    const [c1, c2] = [c, d].sort();
    expect(ids(await store.selectionAEffacer(t, TOUT, 10))).toEqual([b, c1, c2, a]);
    expect(ids(await store.selectionAEffacer(t, TOUT, 2))).toEqual([b, c1]);
  });

  it('🔴 la cible de l’action en masse : étiquettes, consentement, identifiants ; un identifiant supprimé ou d’ailleurs ne rend rien', async () => {
    const vieux = await creer(t, 1, { tags: ['vieux'], optIn: 'opted_out' });
    await creer(t, 2, { tags: ['neuf'], optIn: 'opted_in' });
    const supprimee = await creer(t, 3, { tags: ['vieux'] });
    await pool.query('update contacts set deleted_at = now() where id = $1', [supprimee]);
    const ailleurs = await creer(autre, 4, { tags: ['vieux'] });
    expect(ids(await store.selectionAEffacer(t, { filters: { tags: ['vieux'] }, excludeIds: [] }, 10))).toEqual([vieux]);
    expect(ids(await store.selectionAEffacer(t, { filters: { optIn: 'opted_out' }, excludeIds: [] }, 10))).toEqual([vieux]);
    expect(ids(await store.selectionAEffacer(t, { ids: [vieux, supprimee, ailleurs] }, 10))).toEqual([vieux]);
  });
});
