import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { MesureTaches, lignesRendues, SEUIL_TACHE_LENTE_MS } from '../src/ops/mesure-taches';
import { heureDe, viderMesuresTachesVersLaBase } from '../src/ops/mesure-taches.pg';
import { registreDeTaches } from '../src/worker/taches';
import { SEUIL_FICHIERS_EN_BASE_OCTETS } from '../src/ops/stockage.pg';
import { SEUIL_TACHE_LENTE_MS as SEUIL_ECRAN_TACHE, SEUIL_FICHIERS_EN_BASE_OCTETS as SEUIL_ECRAN_FICHIERS, tacheEnAlerte, fmtOctets, fichiersEnBase } from '../web/lib/ops-mesures';

afterEach(() => vi.useRealTimers());

/**
 * La durée et les lignes des tâches de fond (migration 0207), et le stockage en base, vus de `/ops`.
 */
describe('mesure des tâches de fond', () => {
  it('agrège passes, échecs, durées et lignes ; null n’est pas zéro', () => {
    const m = new MesureTaches();
    m.noter('risque', 120, 500, true);
    m.noter('risque', 80, 300, true);
    m.noter('risque', 40, null, false);
    m.noter('heartbeat', 3, null, true);
    m.noterSaut('risque');
    const [risque, battement] = m.vider().sort((a, b) => (a.tache < b.tache ? 1 : -1));
    expect(risque).toEqual({ tache: 'risque', passes: 3, echecs: 1, sautees: 1, sommeMs: 240, maxMs: 120, lignes: 800, maxLignes: 500 });
    // Une tâche qui ne compte rien n'affiche pas zéro ligne.
    expect(battement!.lignes).toBeNull();
    expect(m.vider()).toEqual([]);
  });

  it('une écriture ratée réinjecte ses lignes, fusionnées avec ce qui est arrivé entre-temps', async () => {
    const m = new MesureTaches();
    m.noter('purge', 100, 10, true);
    const ecrit = await viderMesuresTachesVersLaBase({ enregistrer: async () => { throw new Error('base indisponible'); } }, m, 'worker-principal', new Date());
    expect(ecrit).toBe(false);
    m.noter('purge', 300, 5, true);
    expect(m.vider()).toEqual([{ tache: 'purge', passes: 2, echecs: 0, sautees: 0, sommeMs: 400, maxMs: 300, lignes: 15, maxLignes: 10 }]);
  });

  it('écrit dans l’heure de l’instant, sous le nom du processus', async () => {
    const m = new MesureTaches();
    m.noter('purge', 100, 10, true);
    const ecrits: Array<[string, string]> = [];
    await viderMesuresTachesVersLaBase({ enregistrer: async (p, f) => { ecrits.push([p, f.toISOString()]); } }, m, 'worker-analyse', new Date('2026-10-04T14:47:31.250Z'));
    expect(ecrits).toEqual([['worker-analyse', '2026-10-04T14:00:00.000Z']]);
    expect(heureDe(new Date('2026-10-04T00:00:00.000Z')).toISOString()).toBe('2026-10-04T00:00:00.000Z');
  });

  it('seul un nombre fini compte comme des lignes', () => {
    expect(lignesRendues(12)).toBe(12);
    expect(lignesRendues(undefined)).toBeNull();
    expect(lignesRendues(NaN)).toBeNull();
    expect(lignesRendues('12')).toBeNull();
  });
});

describe('🔴 le registre mesure CHAQUE passe, sans que la tâche y pense', () => {
  it('rend la durée, les lignes rendues et le succès ; un échec est mesuré aussi', async () => {
    vi.useFakeTimers();
    const notes: Array<[string, number | null, boolean]> = [];
    const registre = registreDeTaches({ passe: (tache, _ms, lignes, ok) => { notes.push([tache, lignes, ok]); }, saut: () => {} });
    registre.programmer('compte', 1000, async () => 7, { immediat: true });
    registre.programmer('muette', 1000, () => {}, { immediat: true });
    registre.programmer('casse', 1000, async () => { throw new Error('boom'); }, { immediat: true, enEchec: () => {} });
    await vi.advanceTimersByTimeAsync(0);
    expect(notes).toEqual(expect.arrayContaining([['compte', 7, true], ['muette', null, true], ['casse', null, false]]));
    registre.arreterTout();
  });

  it('une mesure qui lève ne casse ni la passe ni son échec', async () => {
    vi.useFakeTimers();
    const echecs: unknown[] = [];
    let faites = 0;
    const panne = (): never => { throw new Error('mesure en panne'); };
    const registre = registreDeTaches({ passe: panne, saut: panne });
    registre.programmer('ok', 1000, () => { faites += 1; }, { immediat: true });
    registre.programmer('ko', 1000, () => { throw new Error('boom'); }, { immediat: true, enEchec: (e) => { echecs.push(e); } });
    // 4 s : la seconde tâche démarre décalée (lissage du registre), sa première passe périodique tombe à 3,3 s.
    await vi.advanceTimersByTimeAsync(4000);
    expect(faites).toBeGreaterThanOrEqual(2);
    expect(echecs.length).toBeGreaterThanOrEqual(2);
    registre.arreterTout();
  });
});

describe('🔴 une passe bloquée laisse une trace : ses tours sautés', () => {
  it('chaque tour sauté est déclaré, et aucune passe n’est mesurée tant que la première ne finit pas', async () => {
    vi.useFakeTimers();
    const sauts: string[] = [];
    const passes: string[] = [];
    const registre = registreDeTaches({ passe: (t) => { passes.push(t); }, saut: (t) => { sauts.push(t); } });
    registre.programmer('bloquee', 1000, () => new Promise<void>(() => {}), { immediat: true });
    await vi.advanceTimersByTimeAsync(3000);
    expect(sauts).toEqual(['bloquee', 'bloquee', 'bloquee']);
    expect(passes).toEqual([]);
    registre.arreterTout();
  });
});

describe('🔴 parité des seuils entre l’écran et le serveur', () => {
  it('le rouge des tâches lentes et celui des fichiers en base sont les mêmes des deux côtés', () => {
    expect(SEUIL_ECRAN_TACHE).toBe(SEUIL_TACHE_LENTE_MS);
    expect(SEUIL_ECRAN_FICHIERS).toBe(SEUIL_FICHIERS_EN_BASE_OCTETS);
  });

  it('l’écran passe une tâche en rouge au seuil ou sur un échec, et additionne les familles de fichiers', () => {
    const base = { process: 'worker-principal', tache: 't', passes: 1, echecs: 0, sautees: 0, sommeMs: 1, maxMs: 1, lignes: null, maxLignes: null, derniere: '' };
    expect(tacheEnAlerte(base)).toBe(false);
    expect(tacheEnAlerte({ ...base, maxMs: SEUIL_TACHE_LENTE_MS })).toBe(true);
    expect(tacheEnAlerte({ ...base, echecs: 1 })).toBe(true);
    expect(tacheEnAlerte({ ...base, sautees: 1 })).toBe(true);
    expect(fichiersEnBase({ baseOctets: 0, tables: [], mesureLe: '', familles: [
      { famille: 'rcs', elements: 1, octets: 10, disqueOctets: 99 },
      { famille: 'flows', elements: 1, octets: 5, disqueOctets: 99 },
    ] })).toBe(15);
    expect(fmtOctets(10_276_044, 'fr-FR')).toMatch(/^9,8\s?Mo$/);
    expect(fmtOctets(980, 'en-GB')).toBe('980 B');
  });
});

/**
 * 🔴 LE CÂBLAGE, LU DANS LA SOURCE. Débrancher la mesure du registre, son vidage ou la surveillance de l'API ne
 * casserait aucun test unitaire : chacun éprouve sa fonction, pas son branchement. C'est le même parti que les autres
 * tests de câblage du dépôt : un test de source vaut mieux qu'un branchement que personne ne relit.
 */
describe('câblage de l’observabilité', () => {
  const worker = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');
  const api = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');

  it('le worker branche la mesure sur le registre, la vide chaque minute, et purge la table', () => {
    expect(worker).toContain('passe: (tache, dureeMs, lignes, ok) => mesureTaches.noter(tache, dureeMs, lignes, ok),');
    expect(worker).toContain('saut: (tache) => mesureTaches.noterSaut(tache),');
    // La passe des statistiques du démarrage, hors registre, mesurée à la main.
    expect(worker).toContain("mesureTaches.noter('agregats-analyse', performance.now() - debut, n, true);");
    const vidage = worker.slice(worker.indexOf("taches.programmer('pool-attentes'"), worker.indexOf("taches.programmer('pool-attentes'") + 1200);
    expect(vidage).toContain('viderMesuresTachesVersLaBase(mesuresTachesStore, mesureTaches,');
    expect(worker).toContain('mesuresTachesStore.purgeOlderThan(RETENTION_TACHES_JOURS)');
    // La rétention générale signale ses étapes en échec à la mesure, au lieu de « succès, 0 ligne ».
    expect(worker).toContain("if (enEchec.length > 0) throw new Error(`étape(s) en échec : ${enEchec.join(', ')}`);");
  });

  it('l’API surveille les workers à chaque minute, et sert les deux lectures à /ops', () => {
    const minuterie = api.slice(api.indexOf('const minuteriePoolAttentes = setInterval('), api.indexOf('minuteriePoolAttentes.unref'));
    expect(minuterie).toContain('void surveillerWorkers()');
    expect(api).toContain('mesuresTaches: mesuresTachesStore,');
    expect(api).toContain('stockage: new PgStockageStore(pool),');
  });
});
