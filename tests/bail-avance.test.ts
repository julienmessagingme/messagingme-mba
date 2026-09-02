import { describe, it, expect, vi, afterEach } from 'vitest';
import { renouvelerLeBail, BAIL_AVANCE_S, PERIODE_RENOUVELLEMENT_MS } from '../src/workflow/bail-avance';

/**
 * LE BATTEMENT QUI GARDE LE BAIL D'AVANCE VIVANT (lot 1 du plan post-audit, 2026-09-02).
 *
 * 🔴 Pourquoi ce module existe : la réservation du tour (migration 0104) ferme la course COURTE, deux avances
 * qui démarrent ensemble. Elle ne fermait pas la course LONGUE, celle du porteur LENT : un envoi Meta peut
 * durer ~154 s en rejouant ses tentatives, une avance peut en enchaîner plusieurs, donc le bail expirait
 * pendant qu'on travaillait, un autre reprenait le tour, et les deux envoyaient.
 *
 * Le battement se teste ici avec des minuteurs simulés, ce qui est précisément la raison pour laquelle il est
 * un module à part et non trois lignes dans `advance()`.
 */
describe('renouvellement du bail d’avance', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('la cadence est un TIERS du bail, pour survivre à deux battements manqués', () => {
    // Ce n'est pas cosmétique : à la moitié du bail, un seul raté suffirait à perdre le tour.
    expect(PERIODE_RENOUVELLEMENT_MS).toBe(Math.floor((BAIL_AVANCE_S * 1000) / 3));
    expect(PERIODE_RENOUVELLEMENT_MS * 2).toBeLessThan(BAIL_AVANCE_S * 1000);
  });

  it('bat tant qu’on ne l’arrête pas', async () => {
    vi.useFakeTimers();
    let appels = 0;
    const b = renouvelerLeBail({ prolonger: async () => { appels += 1; return true; }, perdu: () => {} });
    await vi.advanceTimersByTimeAsync(PERIODE_RENOUVELLEMENT_MS * 3);
    expect(appels).toBe(3);
    b.arreter();
    await vi.advanceTimersByTimeAsync(PERIODE_RENOUVELLEMENT_MS * 3);
    expect(appels).toBe(3); // plus rien après l'arrêt : un battement qui survit tiendrait un tour pour rien
  });

  it('🔴 bail REPRIS par un autre : on cesse de battre et on le dit', async () => {
    vi.useFakeTimers();
    let appels = 0;
    let perdus = 0;
    renouvelerLeBail({ prolonger: async () => { appels += 1; return false; }, perdu: () => { perdus += 1; } });
    await vi.advanceTimersByTimeAsync(PERIODE_RENOUVELLEMENT_MS * 3);
    // Un seul appel : le verdict est définitif, continuer à battre sur un bail qui n'est plus à nous serait
    // du bruit sur la base, et le signal ne doit être émis qu'une fois.
    expect(appels).toBe(1);
    expect(perdus).toBe(1);
  });

  it('🔴 une ERREUR ne fait PAS lâcher le bail : elle ne prouve rien sur sa propriété', async () => {
    // C'est la distinction qui compte. `false` est un verdict (un autre l'a repris), une exception n'est
    // qu'un hoquet de la base. Abandonner dessus ferait perdre un tour parfaitement sain, alors qu'il reste
    // deux tiers de bail devant nous.
    vi.useFakeTimers();
    let appels = 0;
    const echecs: unknown[] = [];
    let perdus = 0;
    renouvelerLeBail({
      prolonger: async () => { appels += 1; throw new Error('base injoignable'); },
      perdu: () => { perdus += 1; },
      echec: (err) => { echecs.push(err); },
    });
    await vi.advanceTimersByTimeAsync(PERIODE_RENOUVELLEMENT_MS * 3);
    expect(appels).toBe(3);
    expect(echecs).toHaveLength(3);
    expect(perdus).toBe(0);
  });

  it('un battement LENT n’empile pas les suivants', async () => {
    // Sur une base lente, des renouvellements empilés feraient la queue sur le pool de connexions au moment
    // précis où il est déjà sous tension.
    vi.useFakeTimers();
    let enVol = 0;
    let maxEnVol = 0;
    renouvelerLeBail({
      prolonger: async () => {
        enVol += 1;
        maxEnVol = Math.max(maxEnVol, enVol);
        await new Promise((r) => setTimeout(r, PERIODE_RENOUVELLEMENT_MS * 3));
        enVol -= 1;
        return true;
      },
      perdu: () => {},
    });
    await vi.advanceTimersByTimeAsync(PERIODE_RENOUVELLEMENT_MS * 6);
    expect(maxEnVol).toBe(1);
  });
});
