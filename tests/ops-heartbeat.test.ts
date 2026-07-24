import { describe, it, expect } from 'vitest';
import type { Pool } from 'pg';
import { PgWorkerHeartbeatStore } from '../src/ops/heartbeat-store.pg';

/** Pool factice : renvoie ce que `impl` produit pour chaque query (aucune vraie DB). */
function fakePool(impl: () => unknown): Pool {
  return { query: async () => impl() } as unknown as Pool;
}

describe('PgWorkerHeartbeatStore.get', () => {
  it('aucune ligne -> null', async () => {
    const store = new PgWorkerHeartbeatStore(fakePool(() => ({ rows: [] })));
    expect(await store.get()).toBeNull();
  });

  it('table absente (42P01) -> null, pas de throw (fenêtre deploy avant migration 0044)', async () => {
    const store = new PgWorkerHeartbeatStore(
      fakePool(() => {
        const e = new Error('relation "worker_heartbeat" does not exist') as Error & { code: string };
        e.code = '42P01';
        throw e;
      }),
    );
    expect(await store.get()).toBeNull();
  });

  it('ligne présente -> beatAt/bootedAt/instance/ageSeconds (âge calculé côté DB)', async () => {
    const beat = new Date('2026-07-24T10:00:00.000Z');
    const booted = new Date('2026-07-24T09:00:00.000Z');
    const store = new PgWorkerHeartbeatStore(
      fakePool(() => ({ rows: [{ beat_at: beat, booted_at: booted, instance: 'host:42', age_seconds: '17' }] })),
    );
    expect(await store.get()).toEqual({
      beatAt: beat.toISOString(),
      bootedAt: booted.toISOString(),
      instance: 'host:42',
      ageSeconds: 17,
    });
  });

  it('booted_at null (worker jamais redémarré proprement) -> bootedAt null', async () => {
    const beat = new Date('2026-07-24T10:00:00.000Z');
    const store = new PgWorkerHeartbeatStore(
      fakePool(() => ({ rows: [{ beat_at: beat, booted_at: null, instance: null, age_seconds: '3.6' }] })),
    );
    const hb = await store.get();
    expect(hb?.bootedAt).toBeNull();
    expect(hb?.instance).toBeNull();
    expect(hb?.ageSeconds).toBe(4); // arrondi
  });

  it('autre erreur SQL -> propagée (pas avalée comme 42P01)', async () => {
    const store = new PgWorkerHeartbeatStore(
      fakePool(() => {
        throw new Error('boom');
      }),
    );
    await expect(store.get()).rejects.toThrow('boom');
  });
});
