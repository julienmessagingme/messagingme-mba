import { describe, it, expect, vi, afterEach } from 'vitest';
import { registreDeTaches, decalageDeLissage } from '../src/worker/taches';

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
    // ⚠️ DEUX SECONDES, ET PAS UNE : depuis le lissage (2026-09-15), `b` et `c` démarrent décalées, donc
    // leur première passe tombe à `décalage + 1000`. Le cas que ce test exerce est « arreterTout arrête TOUT,
    // y compris celle qu'on aurait oubliée » : il faut donc que les trois aient VRAIMENT démarré avant
    // d'arrêter, sinon on prouverait seulement qu'une tâche jamais partie ne part pas.
    await vi.advanceTimersByTimeAsync(2000);
    expect(compte.a, 'a doit avoir tourné').toBeGreaterThanOrEqual(1);
    expect(compte.b, 'b doit avoir tourné').toBeGreaterThanOrEqual(1);
    expect(compte.c, 'c doit avoir tourné').toBeGreaterThanOrEqual(1);
    const gele = { ...compte };

    registre.arreterTout();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(compte).toEqual(gele); // plus rien ne part
    expect(registre.noms()).toEqual([]);
  });

  it('🔴 arreterTout() arrête aussi une tâche ENCORE DANS SON DÉCALAGE, jamais démarrée', async () => {
    // 🔴 LE PIÈGE QUE LE LISSAGE A OUVERT, et il est invisible du test précédent. Une tâche en attente de son
    // décalage n'a pas encore de minuterie : n'arrêter que les minuteries la laisserait DÉMARRER après la
    // fermeture, donc une passe qui part pendant qu'on ferme le pool. C'est exactement l'erreur que ce
    // registre existe pour rendre impossible, réintroduite par la petite porte.
    vi.useFakeTimers();
    const registre = registreDeTaches();
    let partie = 0;
    registre.programmer('premiere', 60_000, () => {});   // rang 0 : décalage nul
    registre.programmer('decalee', 60_000, () => { partie += 1; }); // rang 1 : décalage non nul

    // On arrête AVANT que le décalage soit écoulé : la minuterie de `decalee` n'existe pas encore.
    registre.arreterTout();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(partie, 'une tâche arrêtée pendant son décalage ne doit JAMAIS démarrer').toBe(0);
    expect(registre.noms()).toEqual([]);
  });

  it('🔴 une tâche dans son décalage est DÉJÀ inscrite : noms() la voit, un doublon est refusé', () => {
    // Sans l'inscription immédiate, `noms()` raterait la tâche pendant sa première minute (diagnostic faux),
    // et surtout le refus de doublon laisserait passer un second enregistrement du même nom, dont la
    // minuterie deviendrait impossible à arrêter.
    vi.useFakeTimers();
    const registre = registreDeTaches();
    registre.programmer('premiere', 60_000, () => {});
    registre.programmer('decalee', 60_000, () => {});
    expect(registre.noms()).toEqual(['premiere', 'decalee']);
    expect(() => registre.programmer('decalee', 60_000, () => {})).toThrow(/déjà programmée/);
    registre.arreterTout();
  });

  it('🔴 le lissage étale les départs, sinon les tâches se rejoignent toutes les 5 minutes', () => {
    // Mesuré en production le 2026-09-15 : une minute ordinaire coûte 13 requêtes et zéro attente, une minute
    // de rendez-vous 26 requêtes et 5 à 10 attentes sur un pool de 8. Les 23 tâches partent toutes de t=0 et
    // leurs cadences sont des multiples les unes des autres, donc elles se retrouvent périodiquement.
    const decalages = Array.from({ length: 23 }, (_, i) => decalageDeLissage(i, 60_000));
    expect(new Set(decalages).size, 'les 23 tâches doivent avoir 23 départs distincts').toBe(23);
    // Et aucune ne retombe sur le battement de coeur (20 s) : c'est ce que le pas non rond achète.
    for (const d of decalages.slice(1)) expect(d % 20_000, 'aucun départ en face du battement de coeur').not.toBe(0);
  });

  it('🔴 le décalage ne DÉPASSE jamais l’intervalle : une tâche ne peut pas tourner moins souvent', () => {
    // La seule façon dont ce lissage pourrait faire un dégât réel. Un décalage supérieur à l'intervalle
    // retarderait la première passe au-delà d'un tour complet, ce qui n'est plus un lissage mais une panne
    // de cadence. Éprouvé sur les cadences réelles du worker, de la plus courte à la plus longue.
    for (const interval of [20_000, 60_000, 5 * 60_000, 15 * 60_000, 20 * 60_000, 60 * 60_000, 6 * 60 * 60_000]) {
      for (let i = 0; i < 40; i += 1) {
        expect(decalageDeLissage(i, interval), `rang ${i}, cadence ${interval}`).toBeLessThan(interval);
      }
    }
    // Et il reste borné à la minute : décaler un balayage de 6 h de plusieurs heures serait un changement de
    // comportement, pas un lissage.
    expect(decalageDeLissage(39, 6 * 60 * 60_000)).toBeLessThan(60_000);
  });

  it('⚠️ la première tâche n’est PAS décalée : le cas le plus courant garde le comportement d’avant', () => {
    expect(decalageDeLissage(0, 60_000)).toBe(0);
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
