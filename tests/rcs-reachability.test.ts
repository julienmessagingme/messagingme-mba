import { describe, it, expect } from 'vitest';
import { Reachability, TTL_MS } from '../src/rcs/reachability';
import type { ReachabilityStore } from '../src/rcs/reachability';
import type { RcsProvider, RcsCapabilities, RcsOutbound } from '../src/rcs/types';
import type { SendResult } from '../src/meta/types';

class MemStore implements ReachabilityStore {
  readonly rows = new Map<string, { reachable: boolean; checkedAt: number }>();
  async get(agentId: string, e164: string) {
    return this.rows.get(`${agentId}:${e164}`) ?? null;
  }
  async put(agentId: string, e164: string, reachable: boolean, atMs: number) {
    this.rows.set(`${agentId}:${e164}`, { reachable, checkedAt: atMs });
  }
}

/** Provider compteur : on mesure le NOMBRE d'appels, c'est tout l'objet du cache. */
class CountingProvider implements RcsProvider {
  calls = 0;
  constructor(
    private readonly unreachable = new Set<string>(),
    private readonly boom = false,
  ) {}
  async capabilities(_agentId: string, e164: string): Promise<RcsCapabilities | null> {
    this.calls++;
    if (this.boom) throw new Error('provider indisponible');
    return this.unreachable.has(e164) ? null : { features: [] };
  }
  async send(_a: string, _e: string, _m: RcsOutbound, messageId: string): Promise<SendResult> {
    return { messageId };
  }
}

describe('Reachability', () => {
  it('interroge le provider une seule fois puis sert le cache', async () => {
    const provider = new CountingProvider();
    const r = new Reachability(provider, new MemStore(), () => 1_000);
    expect(await r.isReachable('agent-1', '+33600000002')).toBe(true);
    expect(await r.isReachable('agent-1', '+33600000002')).toBe(true);
    expect(provider.calls).toBe(1);
  });

  it('reinterroge le provider quand l entree depasse le TTL', async () => {
    const provider = new CountingProvider();
    let now = 1_000;
    const r = new Reachability(provider, new MemStore(), () => now);
    await r.isReachable('agent-1', '+33600000002');
    now = 1_000 + TTL_MS + 1;
    await r.isReachable('agent-1', '+33600000002');
    expect(provider.calls).toBe(2);
  });

  it('sert encore le cache a la limite EXACTE du TTL', async () => {
    const provider = new CountingProvider();
    let now = 1_000;
    const r = new Reachability(provider, new MemStore(), () => now);
    await r.isReachable('agent-1', '+33600000002');
    now = 1_000 + TTL_MS;
    await r.isReachable('agent-1', '+33600000002');
    expect(provider.calls).toBe(1);
  });

  it('met un NON joignable en cache aussi', async () => {
    const provider = new CountingProvider(new Set(['+33600000001']));
    const store = new MemStore();
    const r = new Reachability(provider, store, () => 5_000);
    expect(await r.isReachable('agent-1', '+33600000001')).toBe(false);
    expect(store.rows.get('agent-1:+33600000001')).toEqual({ reachable: false, checkedAt: 5_000 });
  });

  it('sert une entree PERIMEE quand le provider tombe, plutot que de casser la campagne', async () => {
    const store = new MemStore();
    await store.put('agent-1', '+33600000002', true, 0);
    const provider = new CountingProvider(new Set(), true);
    const r = new Reachability(provider, store, () => TTL_MS + 1_000);
    expect(await r.isReachable('agent-1', '+33600000002')).toBe(true);
    expect(provider.calls).toBe(1);
  });

  it('propage l erreur du provider quand il n y a AUCUNE entree en cache', async () => {
    const provider = new CountingProvider(new Set(), true);
    const r = new Reachability(provider, new MemStore(), () => 0);
    await expect(r.isReachable('agent-1', '+33600000002')).rejects.toThrow('provider indisponible');
  });
});
