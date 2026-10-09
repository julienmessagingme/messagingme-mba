import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { repeterAvecGigue } from './poll';
import { SESSION_EXPIRED_EVENT } from './http';

/**
 * Le relevé périodique s'arrête à l'expiration de la session : sans session, chaque relevé rend 401, et un onglet
 * expiré laissé ouvert les enchaînait jusqu'à sa fermeture. `window` est un simple `EventTarget` (tests en Node).
 */
describe('repeterAvecGigue', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal('window', new EventTarget()); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('répète à la période, à 20 % près', () => {
    let n = 0;
    const arreter = repeterAvecGigue(() => { n += 1; }, 1000);
    vi.advanceTimersByTime(1200 * 3);
    expect(n).toBeGreaterThanOrEqual(3);
    arreter();
  });

  it('🔴 s’arrête de lui-même quand la session expire', () => {
    let n = 0;
    repeterAvecGigue(() => { n += 1; }, 1000);
    vi.advanceTimersByTime(1200);
    const avant = n;
    window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
    vi.advanceTimersByTime(60_000);
    expect(avant).toBe(1);
    expect(n).toBe(avant);
  });

  it('la fonction d’arrêt arrête toujours, et décroche l’écoute', () => {
    let n = 0;
    const arreter = repeterAvecGigue(() => { n += 1; }, 1000);
    arreter();
    vi.advanceTimersByTime(60_000);
    expect(n).toBe(0);
  });
});
