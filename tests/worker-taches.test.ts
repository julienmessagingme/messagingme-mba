import { describe, it, expect, vi, afterEach } from 'vitest';
import { registreDeTaches } from '../src/worker/taches';

afterEach(() => vi.useRealTimers());

/**
 * Registre des tâches périodiques du worker (lot 3 du programme, 2026-08-31).
 *
 * Ce qu'il ferme : le worker programmait dix-sept minuteries et devait les arrêter une par une, à la main.
 * Deux étaient déjà passées à travers historiquement, et les deux balayages de rétention du 2026-08-31 aussi.
 * Enregistrer et arrêter deviennent le même geste.
 */
describe('registre des tâches périodiques', () => {
  it('programme une passe à intervalle régulier', async () => {
    vi.useFakeTimers();
    const registre = registreDeTaches();
    let passes = 0;
    registre.programmer('balayage', 1000, () => { passes += 1; });
    expect(passes).toBe(0); // 🔴 PAS de première passe implicite : l'appelant garde la sienne, à sa place
    await vi.advanceTimersByTimeAsync(3000);
    expect(passes).toBe(3);
  });

  it('🔴 arreterTout() arrête TOUTES les tâches, y compris celle qu’on aurait oubliée', async () => {
    vi.useFakeTimers();
    const registre = registreDeTaches();
    const compte = { a: 0, b: 0, c: 0 };
    registre.programmer('a', 1000, () => { compte.a += 1; });
    registre.programmer('b', 1000, () => { compte.b += 1; });
    registre.programmer('c', 1000, () => { compte.c += 1; });
    await vi.advanceTimersByTimeAsync(1000);
    expect(compte).toEqual({ a: 1, b: 1, c: 1 });

    registre.arreterTout();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(compte).toEqual({ a: 1, b: 1, c: 1 }); // plus rien ne part
    expect(registre.noms()).toEqual([]);
  });

  it('les noms sont rendus dans l’ordre de programmation (diagnostic)', () => {
    const registre = registreDeTaches();
    registre.programmer('premier', 60_000, () => {});
    registre.programmer('second', 60_000, () => {});
    expect(registre.noms()).toEqual(['premier', 'second']);
    registre.arreterTout();
  });

  it('🔴 deux tâches du même nom -> refus, plutôt qu’une minuterie perdue', () => {
    // Sans ce refus, la première minuterie deviendrait impossible à arrêter : exactement le défaut que ce
    // registre existe pour supprimer.
    const registre = registreDeTaches();
    registre.programmer('doublon', 60_000, () => {});
    expect(() => registre.programmer('doublon', 60_000, () => {})).toThrow(/déjà programmée/);
    registre.arreterTout();
  });

  it('🔴 une passe qui REJETTE est rattrapée et journalisée, elle ne tue pas le process', async () => {
    // `setInterval(() => void f())` laisse un rejet NON RATTRAPÉ si `f` rejette, et depuis Node 15 un rejet
    // non rattrapé TUE le process. Chaque balayage du worker attrape déjà ses erreurs, mais rien ne le
    // garantissait : il suffisait que le `catch` lui-même échoue (l'alerte Telegram qui lève) pour que le
    // worker meure en silence. Ce test a trouvé le défaut avant la production : il produisait un « unhandled
    // rejection » dans vitest.
    vi.useFakeTimers();
    const journal: unknown[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { journal.push(a[0]); });
    const registre = registreDeTaches();
    let passes = 0;
    registre.programmer('fragile', 1000, async () => { passes += 1; throw new Error('base indisponible'); });
    await vi.advanceTimersByTimeAsync(3000);
    await vi.waitFor(() => expect(journal.length).toBeGreaterThanOrEqual(3));
    expect(passes).toBe(3); // les passes suivantes partent quand même
    expect(String(journal[0])).toContain('fragile');
    registre.arreterTout();
    spy.mockRestore();
  });

  it('🔴 une passe LENTE ne se superpose pas à elle-même, et le saut est journalisé', async () => {
    // `setInterval` ne saute pas un tour parce que le précédent n'est pas fini : sans garde, deux exemplaires
    // du même balayage lisent puis écrivent les mêmes lignes. Un seul des dix-sept se protégeait.
    vi.useFakeTimers();
    const avertissements: string[] = [];
    const spy = vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { avertissements.push(String(a[0])); });
    const registre = registreDeTaches();
    let demarrees = 0;
    let fini: (() => void) | null = null;
    registre.programmer('lente', 1000, () => {
      demarrees += 1;
      return new Promise<void>((r) => { fini = r; });
    });

    await vi.advanceTimersByTimeAsync(1000);
    expect(demarrees).toBe(1);
    // Trois tours de plus pendant que la passe traîne : AUCUNE nouvelle passe ne démarre.
    await vi.advanceTimersByTimeAsync(3000);
    expect(demarrees).toBe(1);
    expect(avertissements).toHaveLength(3);
    expect(avertissements[0]).toContain('lente');
    expect(avertissements[2]).toContain("3 d'affilée"); // le compteur dit la gravité

    // La passe se termine : le tour suivant repart normalement.
    fini!();
    await vi.advanceTimersByTimeAsync(1000);
    expect(demarrees).toBe(2);
    registre.arreterTout();
    spy.mockRestore();
  });

  it('🔴 une passe qui ÉCHOUE libère quand même la garde (sinon la tâche est morte à vie)', async () => {
    vi.useFakeTimers();
    const spyErr = vi.spyOn(console, 'error').mockImplementation(() => {});
    const spyWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const registre = registreDeTaches();
    let passes = 0;
    registre.programmer('fragile', 1000, async () => { passes += 1; throw new Error('boum'); });
    await vi.advanceTimersByTimeAsync(3000);
    await vi.waitFor(() => expect(passes).toBe(3)); // 3 tours, 3 passes : rien n'est resté verrouillé
    registre.arreterTout();
    spyErr.mockRestore();
    spyWarn.mockRestore();
  });
});
