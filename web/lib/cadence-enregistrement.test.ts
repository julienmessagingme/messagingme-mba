import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CADENCE_SCENARIO, CadenceEnregistrement, type DependancesCadence } from './cadence-enregistrement';

/**
 * La cadence de l'enregistrement automatique d'un scénario, sur une horloge simulée. L'incident qu'elle ferme
 * (2026-10-20) : 434 enregistrements en cinq minutes, le plafond de 300 requêtes par minute dépassé, la console
 * entière en « trop de requêtes ».
 */
const LATENCE_MS = 36; // la durée mesurée d'un enregistrement côté serveur ce jour-là

class RefusDeDebit extends Error {
  constructor(readonly attenteMs: number) { super('trop de requêtes, patientez un instant'); }
}

function monter(options: { echec?: (n: number) => Error | null; latenceMs?: number } = {}) {
  let etat = 'v0';
  const envois: Array<{ contenu: string; a: number }> = [];
  let enVol = 0;
  let maxEnVol = 0;
  const deps: DependancesCadence = {
    lire: () => etat,
    envoyer: async (contenu) => {
      enVol += 1;
      maxEnVol = Math.max(maxEnVol, enVol);
      envois.push({ contenu, a: Date.now() });
      await new Promise((r) => { setTimeout(r, options.latenceMs ?? LATENCE_MS); });
      enVol -= 1;
      const e = options.echec?.(envois.length) ?? null;
      if (e) throw e;
    },
    pauseApres: (e) => (e instanceof RefusDeDebit ? e.attenteMs : null),
  };
  const cadence = new CadenceEnregistrement(deps, CADENCE_SCENARIO, etat);
  return {
    cadence,
    envois,
    maxEnVol: () => maxEnVol,
    changer: (v: string) => { etat = v; cadence.modifie(); },
    /** Une sélection, une mesure de bloc : la liste change, ce qui s'enregistre non. */
    toucherSansChanger: () => { cadence.modifie(); },
  };
}

describe('cadence de l’enregistrement d’un scénario', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
  afterEach(() => { vi.useRealTimers(); });

  it('🔴 une édition continue d’une minute (un changement toutes les 16 ms, un glisser) part au plus une fois toutes les 5 s, et le dernier état part', async () => {
    const m = monter();
    // Un premier envoi en vol, pour reproduire l'enchaînement de l'incident : une modification pendant un envoi.
    m.changer('depart');
    await vi.advanceTimersByTimeAsync(1200);
    for (let i = 0; i < 60_000 / 16; i += 1) {
      m.changer(`glisser-${i}`);
      await vi.advanceTimersByTimeAsync(16);
    }
    m.changer('fin');
    await vi.advanceTimersByTimeAsync(10_000);
    const surLaMinute = m.envois.filter((e) => e.a < 61_200).length;
    expect(surLaMinute).toBeLessThanOrEqual(13);
    for (let i = 1; i < m.envois.length; i += 1) expect(m.envois[i]!.a - m.envois[i - 1]!.a).toBeGreaterThanOrEqual(5000);
    expect(m.envois.at(-1)!.contenu).toBe('fin');
    expect(m.maxEnVol()).toBe(1);
  });

  it('🔴 une modification arrivée pendant un envoi ne relance pas tout de suite : elle attend le délai et l’espacement', async () => {
    const m = monter();
    m.changer('a');
    await vi.advanceTimersByTimeAsync(1200 + 10); // l'envoi de « a » est en vol
    m.changer('b');
    await vi.advanceTimersByTimeAsync(LATENCE_MS + 100);
    expect(m.envois.map((e) => e.contenu)).toEqual(['a']);
    await vi.advanceTimersByTimeAsync(5000);
    expect(m.envois.map((e) => e.contenu)).toEqual(['a', 'b']);
    expect(m.envois[1]!.a - m.envois[0]!.a).toBeGreaterThanOrEqual(5000);
  });

  it('🔴 une sélection, une mesure, l’ouverture du scénario : aucun envoi', async () => {
    const m = monter();
    for (let i = 0; i < 50; i += 1) {
      m.toucherSansChanger();
      await vi.advanceTimersByTimeAsync(300);
    }
    await vi.advanceTimersByTimeAsync(10_000);
    expect(m.envois).toEqual([]);
  });

  it('un retour à l’état déjà enregistré n’envoie rien', async () => {
    const m = monter();
    m.changer('x');
    m.changer('v0');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(m.envois).toEqual([]);
  });

  it('🔴 un 429 met l’enregistrement en pause le temps demandé, puis il reprend seul avec le dernier état', async () => {
    const m = monter({ echec: (n) => (n === 1 ? new RefusDeDebit(30_000) : null) });
    m.changer('a');
    await vi.advanceTimersByTimeAsync(1200 + LATENCE_MS);
    expect(m.envois).toHaveLength(1);
    const refuseA = Date.now();
    m.changer('b');
    await vi.advanceTimersByTimeAsync(29_000);
    expect(m.envois).toHaveLength(1);
    expect(await m.cadence.maintenant()).toBe(false); // publier pendant la pause : refusé, rien ne part
    expect(m.envois).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(m.envois).toHaveLength(2);
    expect(m.envois[1]!.contenu).toBe('b');
    expect(m.envois[1]!.a).toBeGreaterThanOrEqual(refuseA + 30_000 - LATENCE_MS);
  });

  it('un autre échec ne relance rien tout seul (une session expirée bouclerait) ; la modification suivante reprend', async () => {
    const m = monter({ echec: (n) => (n === 1 ? new Error('session expirée') : null) });
    m.changer('a');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(m.envois).toHaveLength(1);
    m.changer('b');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(m.envois.map((e) => e.contenu)).toEqual(['a', 'b']);
  });

  it('« maintenant » (avant de publier) attend l’envoi en vol, envoie le dernier état sans délai ni espacement, et dit que tout est parti', async () => {
    const m = monter();
    m.changer('a');
    await vi.advanceTimersByTimeAsync(1200 + 10);
    m.changer('b');
    const fini = m.cadence.maintenant();
    await vi.advanceTimersByTimeAsync(2 * LATENCE_MS + 10);
    expect(await fini).toBe(true);
    expect(m.envois.map((e) => e.contenu)).toEqual(['a', 'b']);
    expect(m.maxEnVol()).toBe(1);
  });

  it('après un échec, revenir à l’état que le serveur a efface l’erreur : Publier n’est plus bloqué', async () => {
    const m = monter({ echec: (n) => (n === 1 ? new Error('réseau coupé') : null) });
    m.changer('a');
    await vi.advanceTimersByTimeAsync(1200 + LATENCE_MS);
    expect(m.envois).toHaveLength(1);
    m.changer('v0'); // l'annulation de la modification
    expect(await m.cadence.maintenant()).toBe(true);
    expect(m.envois).toHaveLength(1);
  });

  it('« maintenant » n’attend pas sans fin un envoi qui traîne : au bout de 4 s, il rend faux', async () => {
    const m = monter({ latenceMs: 60_000 });
    m.changer('a');
    await vi.advanceTimersByTimeAsync(1200 + 10);
    m.changer('b');
    const fini = m.cadence.maintenant();
    await vi.advanceTimersByTimeAsync(4_100);
    expect(await fini).toBe(false);
  });

  it('🔴 fermer l’éditeur pendant une pause tente quand même le dernier envoi (keepalive) ; refusé, plus rien ne repart ensuite', async () => {
    const m = monter({ echec: (n) => (n <= 2 ? new RefusDeDebit(30_000) : null) });
    m.changer('a');
    await vi.advanceTimersByTimeAsync(1200 + LATENCE_MS);
    m.changer('b');
    void m.cadence.maintenant(true); // la fermeture, en pleine pause
    m.cadence.arreter();
    await vi.advanceTimersByTimeAsync(LATENCE_MS + 10);
    expect(m.envois.map((e) => e.contenu)).toEqual(['a', 'b']);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(m.envois).toHaveLength(2); // aucun envoi fantôme de l'éditeur fermé
  });

  it('« maintenant » sans rien de changé n’envoie rien et rend vrai', async () => {
    const m = monter();
    expect(await m.cadence.maintenant()).toBe(true);
    expect(m.envois).toEqual([]);
  });
});
