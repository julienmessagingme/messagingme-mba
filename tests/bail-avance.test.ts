import { describe, it, expect, vi, afterEach } from 'vitest';
import { renouvelerLeBail, BAIL_AVANCE_S, PERIODE_RENOUVELLEMENT_MS, DUREE_MAX_AVANCE_MS } from '../src/workflow/bail-avance';

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

/**
 * 🔴 CE QUE LE BATTEMENT DIT AU TRAVAIL (lot A2 du plan du 2026-09-02).
 *
 * Le lot 1 rendait la perte du tour VISIBLE (un `perdu()` qui journalise) sans rien arrêter : l'ancien porteur
 * finissait tranquillement sa liste d'envois pendant que le nouveau faisait la sienne. Le battement doit donc
 * exposer un ÉTAT consultable, et pas seulement notifier une fois.
 */
describe('bail d’avance : l’état de perte est consultable, et la durée est bornée', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('tant que le bail tient, rien n’est perdu et le signal n’est pas abattu', async () => {
    vi.useFakeTimers();
    const b = renouvelerLeBail({ prolonger: async () => true, perdu: () => {} });
    await vi.advanceTimersByTimeAsync(PERIODE_RENOUVELLEMENT_MS * 3);
    expect(b.perduPourquoi()).toBeNull();
    expect(b.signal.aborted).toBe(false);
    b.arreter();
  });

  it('🔴 bail repris : la RAISON est lisible et le signal est abattu', async () => {
    // La raison, pas un booléen : c'est elle qui part dans le journal et dans le message d'interruption. Un
    // `true` ne dirait pas quoi chercher le jour où l'on cherche pourquoi un contact n'a pas eu sa suite.
    vi.useFakeTimers();
    const b = renouvelerLeBail({ prolonger: async () => false, perdu: () => {} });
    await vi.advanceTimersByTimeAsync(PERIODE_RENOUVELLEMENT_MS);
    expect(b.perduPourquoi()).toContain('repris');
    expect(b.signal.aborted).toBe(true);
  });

  it('🔴 une avance PENDUE est abandonnée au bout de la durée maximale, bail vivant ou non', async () => {
    // Le mode de panne que le battement seul ne couvre PAS : une promesse qui ne se résout jamais fait
    // renouveler le bail indéfiniment, donc le tour reste tenu à vie et le contact n'a plus jamais de suite.
    // `prolonger` rend TOUJOURS `true` ici : c'est bien la durée, et rien d'autre, qui doit trancher.
    vi.useFakeTimers();
    let horloge = 0;
    let perdus = 0;
    const b = renouvelerLeBail({
      prolonger: async () => true,
      perdu: () => { perdus += 1; },
      maintenant: () => horloge,
      dureeMaxMs: 90_000,
    });
    // Cinq battements de 20 s : le cinquième voit 100 s écoulées, donc au-delà des 90 s permises.
    for (let i = 0; i < 5; i += 1) {
      horloge += 20_000;
      await vi.advanceTimersByTimeAsync(20_000);
    }
    expect(b.perduPourquoi()).toContain('durée maximale');
    expect(b.signal.aborted).toBe(true);
    expect(perdus).toBe(1);

    // Et on cesse VRAIMENT de battre : le tour doit se libérer tout seul, pas être tenu par un minuteur
    // increvable.
    const avant = perdus;
    horloge += 60_000;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(perdus).toBe(avant);
  });

  it('la durée maximale par défaut laisse largement passer une avance normale', () => {
    // Un envoi Meta au pire ~154 s, une avance en enchaîne quelques-uns : la borne doit être un garde-fou
    // d'anomalie, jamais une limite qu'un parcours sain rencontre.
    expect(DUREE_MAX_AVANCE_MS).toBeGreaterThan(5 * 60 * 1000);
  });
});
