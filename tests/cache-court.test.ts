import { describe, it, expect } from 'vitest';
import { cacheCourt } from '../src/lib/cache-court';

/** Horloge pilotée : la durée de vie se teste en avançant le temps, jamais en attendant. */
function horloge(): { now: () => number; avancer: (ms: number) => void } {
  let t = 1_000_000;
  return { now: () => t, avancer: (ms) => { t += ms; } };
}

/** Calcul qui rend un compteur croissant, et qu'on peut retenir pour orchestrer la concurrence. */
function compteur(): { appels: number; calcul: () => Promise<number> } {
  const c = { appels: 0, calcul: async () => { c.appels += 1; return c.appels; } };
  return c;
}

describe('cacheCourt (micro-cache des compteurs, R7)', () => {
  it('deux lectures dans la durée de vie -> UN seul calcul', async () => {
    const h = horloge();
    const cache = cacheCourt<number>(5000, h.now);
    const c = compteur();
    expect(await cache.lire('t1', c.calcul)).toBe(1);
    h.avancer(4999);
    expect(await cache.lire('t1', c.calcul)).toBe(1);
    expect(c.appels).toBe(1);
  });

  it('après la durée de vie -> recalcul', async () => {
    const h = horloge();
    const cache = cacheCourt<number>(5000, h.now);
    const c = compteur();
    await cache.lire('t1', c.calcul);
    h.avancer(5001);
    expect(await cache.lire('t1', c.calcul)).toBe(2);
    expect(c.appels).toBe(2);
  });

  it('deux espaces différents ne se mélangent pas', async () => {
    const h = horloge();
    const cache = cacheCourt<number>(5000, h.now);
    const c = compteur();
    expect(await cache.lire('t1', c.calcul)).toBe(1);
    expect(await cache.lire('t2', c.calcul)).toBe(2);
    expect(await cache.lire('t1', c.calcul)).toBe(1);
  });

  it('lectures SIMULTANÉES (cache vide) -> un seul calcul, tout le monde a la même valeur', async () => {
    const h = horloge();
    const cache = cacheCourt<number>(5000, h.now);
    let appels = 0;
    let debloquer: (n: number) => void = () => {};
    const calcul = (): Promise<number> => {
      appels += 1;
      return new Promise<number>((resolve) => { debloquer = resolve; });
    };
    // 25 onglets tapent dans la même milliseconde : c'est le cas que la durée de vie seule ne couvre pas.
    const vagues = Array.from({ length: 25 }, () => cache.lire('t1', calcul));
    debloquer(42);
    expect(await Promise.all(vagues)).toEqual(Array.from({ length: 25 }, () => 42));
    expect(appels).toBe(1);
  });

  it('invalider -> la lecture suivante recalcule, même dans la durée de vie', async () => {
    const h = horloge();
    const cache = cacheCourt<number>(5000, h.now);
    const c = compteur();
    await cache.lire('t1', c.calcul);
    cache.invalider('t1');
    expect(await cache.lire('t1', c.calcul)).toBe(2);
  });

  it('invalidation PENDANT un calcul en vol : la valeur d\'avant n\'est jamais mise en cache', async () => {
    const h = horloge();
    const cache = cacheCourt<number>(5000, h.now);
    let debloquer: (n: number) => void = () => {};
    let appels = 0;
    const lent = (): Promise<number> => {
      appels += 1;
      return new Promise<number>((resolve) => { debloquer = resolve; });
    };
    const enVol = cache.lire('t1', lent);
    // Le fil est marqué comme lu pendant que le comptage est en vol.
    cache.invalider('t1');
    debloquer(7);
    expect(await enVol).toBe(7); // celui qui avait demandé avant reçoit bien sa réponse
    // ... mais la lecture SUIVANTE ne doit pas resservir ce 7 périmé.
    expect(await cache.lire('t1', async () => 3)).toBe(3);
    expect(appels).toBe(1);
  });

  it('un échec n\'est pas mis en cache (la lecture suivante réessaie)', async () => {
    const h = horloge();
    const cache = cacheCourt<number>(5000, h.now);
    await expect(cache.lire('t1', async () => { throw new Error('base injoignable'); })).rejects.toThrow('base injoignable');
    expect(await cache.lire('t1', async () => 5)).toBe(5);
  });
});
