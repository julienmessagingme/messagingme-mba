import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgContactStore } from '../../src/crm/contact-store.pg';

// Intégration mini-CRM (actions en masse + nouveaux filtres). ISOLÉ par tenant jetable (créé/détruit ici),
// jamais la prod « métier ». NON lancé dans le gate unitaire (`vitest run` exclut tests/integration) ni en
// local (DATABASE_URL pointe la prod, cf CLAUDE.md) : tourne en CI/VPS. Typé par `tsc --noEmit` du gate.

const url = process.env.DATABASE_URL ?? '';

describe.skipIf(!url)('mini-CRM — actions en masse + soft-delete', () => {
  let pool: Pool;
  let tenantId: string;
  let store: PgContactStore;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl() });
    tenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-minicrm') returning id`)).rows[0]!.id;
    store = new PgContactStore(pool);
    // A: Paris/vip ; B: Lyon/prospect ; C: ville vide ; D: ville absente/spam.
    ids.A = (await store.upsertByPhoneReturningId({ tenantId, phoneE164: '+33600000101', profileName: 'A', fields: { ville: 'Paris', segment: 'vip' }, optInStatus: 'opted_in', tags: ['vip'] })).id;
    ids.B = (await store.upsertByPhoneReturningId({ tenantId, phoneE164: '+33600000102', profileName: 'B', fields: { ville: 'Lyon' }, optInStatus: 'opted_in', tags: ['prospect'] })).id;
    ids.C = (await store.upsertByPhoneReturningId({ tenantId, phoneE164: '+33600000103', profileName: 'C', fields: { ville: '' }, optInStatus: 'opted_in', tags: [] })).id;
    ids.D = (await store.upsertByPhoneReturningId({ tenantId, phoneE164: '+33600000104', profileName: 'D', fields: {}, optInStatus: 'opted_in', tags: ['spam'] })).id;
  });

  afterAll(async () => {
    if (tenantId) await pool.query('delete from tenants where id = $1', [tenantId]);
    await pool.end();
  });

  const names = async (f: Parameters<PgContactStore['query']>[1]): Promise<string[]> =>
    (await store.query(tenantId, f, 500)).map((c) => c.profileName ?? '').sort();

  it('filtre empty : ville vide OU absente -> C, D', async () => {
    expect(await names({ fieldFilters: [{ key: 'ville', op: 'empty', value: '' }] })).toEqual(['C', 'D']);
  });

  it('filtre not_empty : ville renseignée -> A, B', async () => {
    expect(await names({ fieldFilters: [{ key: 'ville', op: 'not_empty', value: '' }] })).toEqual(['A', 'B']);
  });

  it('filtre not_contains « paris » : tous sauf A', async () => {
    expect(await names({ fieldFilters: [{ key: 'ville', op: 'not_contains', value: 'paris' }] })).toEqual(['B', 'C', 'D']);
  });

  it('filtre tagsExclude [spam] : tous sauf D (contact sans tag INCLUS)', async () => {
    expect(await names({ tagsExclude: ['spam'] })).toEqual(['A', 'B', 'C']);
  });

  it('applyEditsMany par ids : add_tag ciblé sur A seulement', async () => {
    const affected = await store.applyEditsMany(tenantId, { ids: [ids.A!] }, { addTags: ['gold'] });
    expect(affected).toBe(1);
    expect(await names({ tags: ['gold'] })).toEqual(['A']);
  });

  it('applyEditsMany par filtres + excludeIds : set_field appliqué à B seulement (A exclu)', async () => {
    const affected = await store.applyEditsMany(
      tenantId,
      { filters: { fieldFilters: [{ key: 'ville', op: 'not_empty', value: '' }] }, excludeIds: [ids.A!] },
      { setField: { key: 'ville', value: 'Marseille' } },
    );
    expect(affected).toBe(1);
    expect(await names({ fieldFilters: [{ key: 'ville', op: 'eq', value: 'Marseille' }] })).toEqual(['B']);
    // A inchangé (toujours Paris)
    expect(await names({ fieldFilters: [{ key: 'ville', op: 'eq', value: 'Paris' }] })).toEqual(['A']);
  });

  it('applyEditsMany remove_tag par ids', async () => {
    await store.applyEditsMany(tenantId, { ids: [ids.A!] }, { removeTags: ['gold'] });
    expect(await names({ tags: ['gold'] })).toEqual([]);
  });

  it('applyEditsMany add + remove tags dans le MÊME appel (une seule assignation SQL, pas de crash)', async () => {
    const affected = await store.applyEditsMany(tenantId, { ids: [ids.A!] }, { addTags: ['nouveau'], removeTags: ['vip'] });
    expect(affected).toBe(1);
    expect(await names({ tags: ['nouveau'] })).toEqual(['A']); // ajouté
    expect(await names({ tags: ['vip'] })).toEqual([]);        // retiré (A était le seul « vip »)
  });

  it('ré-upsert par téléphone RESSUSCITE un contact masqué (deleted_at remis à null)', async () => {
    // `deleted_at` survit au retrait de la suppression douce : la purge le pose en même temps que
    // l'anonymisation, pour que la fiche vidée quitte le CRM. Le comportement de l'upsert reste donc vivant,
    // et on le pose ici à la main, faute d'une action de l'écran qui le fasse encore.
    await pool.query('update contacts set deleted_at = now() where id = $1', [ids.C!]);
    expect((await store.query(tenantId, {}, 500)).some((c) => c.id === ids.C)).toBe(false);
    const r = await store.upsertByPhoneReturningId({ tenantId, phoneE164: '+33600000103', profileName: 'C', fields: {}, optInStatus: 'opted_in' });
    expect(r.created).toBe(false); // conflit sur la ligne existante, pas une nouvelle ligne
    expect((await store.query(tenantId, {}, 500)).some((c) => c.id === ids.C)).toBe(true);
  });

  it('isolation tenant : une action sur un AUTRE tenant ne touche pas nos contacts', async () => {
    const other = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-minicrm-other') returning id`)).rows[0]!.id;
    try {
      const affected = await store.applyEditsMany(other, { ids: [ids.A!, ids.B!] }, { addTags: ['leak'] });
      expect(affected).toBe(0); // ids d'un autre tenant -> 0 touché
      expect(await names({ tags: ['leak'] })).toEqual([]);
    } finally {
      await pool.query('delete from tenants where id = $1', [other]);
    }
  });
});
