import { describe, it, expect } from 'vitest';
import type { Pool } from 'pg';
import { PgWorkerHeartbeatStore } from '../src/ops/heartbeat-store.pg';

/** Pool factice : renvoie ce que `impl` produit pour chaque query (aucune vraie DB), et garde les appels. */
function fakePool(impl: () => unknown): Pool & { appels: { text: string; values: unknown[] }[] } {
  const appels: { text: string; values: unknown[] }[] = [];
  return {
    appels,
    query: async (text: string, values: unknown[] = []) => {
      appels.push({ text, values });
      return impl();
    },
  } as unknown as Pool & { appels: { text: string; values: unknown[] }[] };
}

describe('PgWorkerHeartbeatStore.lister', () => {
  it('aucune ligne -> liste vide', async () => {
    const store = new PgWorkerHeartbeatStore(fakePool(() => ({ rows: [] })));
    expect(await store.lister()).toEqual([]);
  });

  it('ligne présente -> role/beatAt/bootedAt/instance/ageSeconds (âge calculé côté DB)', async () => {
    const beat = new Date('2026-07-24T10:00:00.000Z');
    const booted = new Date('2026-07-24T09:00:00.000Z');
    const store = new PgWorkerHeartbeatStore(
      fakePool(() => ({ rows: [{ id: 'principal', beat_at: beat, booted_at: booted, instance: 'host:42', age_seconds: '17' }] })),
    );
    expect(await store.lister()).toEqual([{
      role: 'principal',
      beatAt: beat.toISOString(),
      bootedAt: booted.toISOString(),
      instance: 'host:42',
      ageSeconds: 17,
    }]);
  });

  it('🔴 deux rôles -> DEUX lignes, chacune avec son rôle', async () => {
    // C'est tout l'enjeu de la clé par rôle : une ligne unique laisserait le survivant rafraîchir la ligne du
    // mort, et la mort de l'un serait invisible depuis /ops.
    const t = new Date('2026-10-03T08:00:00.000Z');
    const store = new PgWorkerHeartbeatStore(fakePool(() => ({ rows: [
      { id: 'analyse', beat_at: t, booted_at: t, instance: 'a:1', age_seconds: '600' },
      { id: 'principal', beat_at: t, booted_at: t, instance: 'p:1', age_seconds: '4' },
    ] })));
    const lignes = await store.lister();
    expect(lignes.map((l) => [l.role, l.ageSeconds])).toEqual([['analyse', 600], ['principal', 4]]);
  });

  it('booted_at null (worker jamais redémarré proprement) -> bootedAt null', async () => {
    const beat = new Date('2026-07-24T10:00:00.000Z');
    const store = new PgWorkerHeartbeatStore(
      fakePool(() => ({ rows: [{ id: 'all', beat_at: beat, booted_at: null, instance: null, age_seconds: '3.6' }] })),
    );
    const [hb] = await store.lister();
    expect(hb?.bootedAt).toBeNull();
    expect(hb?.instance).toBeNull();
    expect(hb?.ageSeconds).toBe(4); // arrondi
  });

  it('erreur SQL -> propagée, jamais avalée', async () => {
    const store = new PgWorkerHeartbeatStore(
      fakePool(() => {
        throw new Error('boom');
      }),
    );
    await expect(store.lister()).rejects.toThrow('boom');
  });

  it('🔴 aucune ligne n’est filtrée sur une liste de rôles « connus »', async () => {
    // Un filtre rendrait invisible exactement ce qu'on veut voir : une ligne qui a cessé de battre.
    const pool = fakePool(() => ({ rows: [] }));
    await new PgWorkerHeartbeatStore(pool).lister();
    expect(pool.appels[0]!.text).not.toMatch(/where/i);
  });
});

describe('PgWorkerHeartbeatStore.beat', () => {
  it('🔴 le rôle est la clé de la ligne, au démarrage comme au battement courant', async () => {
    const pool = fakePool(() => ({ rows: [] }));
    const store = new PgWorkerHeartbeatStore(pool);
    await store.beat('analyse', 'host:7', true);
    await store.beat('principal', 'host:8', false);
    expect(pool.appels.map((a) => a.values)).toEqual([['analyse', 'host:7'], ['principal', 'host:8']]);
    // Plus aucune clé écrite en dur : c'est elle qui faisait partager une seule ligne à deux processus.
    for (const a of pool.appels) expect(a.text).not.toContain("'worker'");
  });

  it('le démarrage rafraîchit booted_at, le battement courant non', async () => {
    const pool = fakePool(() => ({ rows: [] }));
    const store = new PgWorkerHeartbeatStore(pool);
    await store.beat('principal', 'h', true);
    await store.beat('principal', 'h', false);
    expect(pool.appels[0]!.text).toMatch(/do update set beat_at = now\(\), booted_at = now\(\)/);
    expect(pool.appels[1]!.text).not.toMatch(/do update set[^;]*booted_at/);
  });
});
