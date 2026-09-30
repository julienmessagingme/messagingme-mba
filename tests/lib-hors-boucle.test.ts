import { describe, it, expect } from 'vitest';
import { threadId } from 'node:worker_threads';
import { avecLecteur, horsBoucle, type Lecteur } from '../src/lib/hors-boucle';
import type { ParsedCsv } from '../src/crm/csv';
import { csvLent as lent, retardPendant } from './boucle';

/**
 * La lecture d'un fichier déposé, hors de la boucle d'événements.
 *
 * 🔴 POURQUOI. Relevé le 2026-09-30 par deux relectures : sous toutes les bornes posées (colonnes, lignes), des
 * fichiers de quelques centaines de Ko tenaient la boucle de `mba-api` des minutes, donc la console et les webhooks
 * de Meta de TOUS les espaces. Chaque borne fermait une forme, chaque relecture en trouvait d'autres : on borne donc
 * le TEMPS, dans un worker qu'on peut tuer, et plus la forme.
 */

const CSV = new URL('../src/crm/csv.ts', import.meta.url);

describe('horsBoucle : lire un fichier hors de la boucle d’événements', () => {
  it('rend le résultat de la fonction', async () => {
    await expect(horsBoucle<ParsedCsv>(CSV, 'parseCsv', ['nom;tel\nJulie;0612345678'])).resolves
      .toEqual({ headers: ['nom', 'tel'], rows: [{ nom: 'Julie', tel: '0612345678' }] });
  });

  it('rend une erreur de la fonction avec son message et son statusCode', async () => {
    await expect(horsBoucle(CSV, 'parseCsv', [`${Array(16_385).fill('a').join(';')}\nx`])).rejects
      .toMatchObject({ statusCode: 400, message: expect.stringContaining('16385 colonnes') });
  });

  it('🔴 coupe une lecture qui dépasse son échéance, en 400, et ne garde pas le lecteur occupé', async () => {
    const debut = performance.now();
    await expect(horsBoucle(CSV, 'parseCsv', [lent(2_000, 200_000)], { delaiMs: 300 })).rejects
      .toMatchObject({ statusCode: 400, message: expect.stringContaining('dépassé') });
    expect(performance.now() - debut).toBeLessThan(3_000);
    await expect(horsBoucle<ParsedCsv>(CSV, 'parseCsv', ['a;b\n1;2'])).resolves.toMatchObject({ headers: ['a', 'b'] });
  });

  it('🔴 la boucle du fil principal reste libre pendant une lecture qui dure', async () => {
    const { retard, duree } = await retardPendant(() => horsBoucle(CSV, 'parseCsv', [lent(1_000, 200_000)]));
    expect(duree).toBeGreaterThan(500);
    expect(retard).toBeLessThan(duree / 4);
  }, 30_000);

  it('🔴 une lecture qui ne part pas ne garde pas de place : la lecture suivante passe', async () => {
    // Relevé par la relecture du 2026-09-30 : le compteur montait avant `new Worker`. Quatre échecs au départ (ici un
    // argument que le clonage refuse) suffisaient à rendre 429 à tout le monde, jusqu'au redémarrage. Depuis le lecteur,
    // l'argument part par message : la place ne se prend qu'une fois ce message posté.
    for (let i = 0; i < 5; i += 1) {
      await expect(horsBoucle(CSV, 'parseCsv', [() => 'non clonable'])).rejects.toBeDefined();
    }
    await expect(horsBoucle<ParsedCsv>(CSV, 'parseCsv', ['a;b\n1;2'])).resolves.toMatchObject({ headers: ['a', 'b'] });
  });

  it('au-delà de quatre lectures à la fois, la suivante est refusée en 429', async () => {
    const issues = await Promise.all(Array.from({ length: 5 }, () =>
      horsBoucle(CSV, 'parseCsv', [lent(200, 50_000)]).then(() => 'lu', (e: { statusCode?: number }) => e.statusCode)));
    expect(issues.filter((i) => i === 429)).toHaveLength(1);
    expect(issues.filter((i) => i === 'lu')).toHaveLength(4);
  });
});

/** Les sondes de `tests/boucle.ts`, lues dans le worker. */
const SONDE = new URL('./boucle.ts', import.meta.url);
const pause = (ms: number): Promise<void> => new Promise((fin) => setTimeout(fin, ms));

describe('avecLecteur : plusieurs lectures sur un même worker, le temps d’une requête', { timeout: 20_000 }, () => {
  /**
   * 🔴 POURQUOI. Un parcours de site lit jusqu'à cinquante pages, deux lectures chacune (les liens, les fiches) : un
   * worker par lecture coûterait 0,5 s de démarrage chacune, 50 s de plus sur un aperçu. Un lecteur garde son worker
   * le temps d'une requête ; la fin du travail le tue.
   */
  it('lit plusieurs fois sur UN worker, hors du fil principal', async () => {
    const fils = await avecLecteur({}, async (l) => [await l.lire<number>(SONDE, 'fil', []), await l.lire<number>(SONDE, 'fil', [])]);
    expect(fils[0]).not.toBe(threadId);
    expect(fils[1]).toBe(fils[0]);
  });

  it('rend le résultat du travail, et le lecteur ne lit plus une fois le travail fini', async () => {
    let garde: Lecteur | undefined;
    await expect(avecLecteur({}, async (l) => { garde = l; return l.lire<number>(SONDE, 'attendre', [1]); })).resolves.toBe(1);
    await expect(garde!.lire(SONDE, 'fil', [])).rejects.toThrow('fermé');
  });

  it('🔴 la fin du travail TUE le worker, même au repos', async () => {
    // Sans quoi chaque aperçu laisserait un worker vivant derrière lui, et la mémoire de `mba-api` monterait jusqu'à
    // sa chute. Le compteur prouve d'abord qu'il bat, sans quoi son arrêt ne prouverait rien.
    const pouls = new Int32Array(new SharedArrayBuffer(4));
    await avecLecteur({}, async (l) => {
      await l.lire(SONDE, 'battre', [pouls]);
      await pause(100);
      expect(Atomics.load(pouls, 0)).toBeGreaterThan(0);
    });
    await pause(100);
    const apres = Atomics.load(pouls, 0);
    await pause(200);
    expect(Atomics.load(pouls, 0)).toBe(apres);
  });

  it('🔴 l’échéance est CUMULÉE sur ses lectures : un parcours de cinquante pages n’en a pas cinquante', async () => {
    // Deux lectures de 3 s, chacune sous une échéance de 5 s : à la suite, elles la dépassent. Une échéance par
    // lecture laisserait une page hostile tenir un worker 10 s, cinquante fois, pour un seul aperçu.
    await expect(avecLecteur({ delaiMs: 5_000 }, async (l) => {
      await l.lire(SONDE, 'attendre', [3_000]);
      await l.lire(SONDE, 'attendre', [3_000]);
    })).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('dépassé 5 s') });
  });

  it('🔴 à l’échéance, le worker est TUÉ et le lecteur refuse toute autre lecture', async () => {
    const pouls = new Int32Array(new SharedArrayBuffer(4));
    const issues = await avecLecteur({ delaiMs: 1_500 }, async (l) => {
      await l.lire(SONDE, 'battre', [pouls]);
      return [
        await l.lire(SONDE, 'attendre', [10_000]).catch((e: unknown) => e),
        await l.lire(SONDE, 'fil', []).catch((e: unknown) => e),
      ];
    });
    expect(issues[0]).toMatchObject({ statusCode: 400, message: expect.stringContaining('dépassé') });
    expect(issues[1]).toMatchObject({ statusCode: 400 });
    expect(Atomics.load(pouls, 0)).toBeGreaterThan(0);
    await pause(100);
    const apres = Atomics.load(pouls, 0);
    await pause(200);
    expect(Atomics.load(pouls, 0)).toBe(apres);
  });

  it('🔴 un lecteur au repos n’occupe aucune place : seules les lectures en cours comptent', async () => {
    // Un aperçu attend le réseau entre deux pages. Garder une place pendant ce temps rendrait 429 à tous les espaces
    // dès que quatre sites seraient parcourus à la fois.
    let liberer!: () => void;
    const repos = new Promise<void>((fin) => { liberer = fin; });
    const prets: Array<Promise<void>> = [];
    const lecteurs = Array.from({ length: 4 }, () => {
      let pret!: () => void;
      prets.push(new Promise<void>((fin) => { pret = fin; }));
      return avecLecteur({}, async (l) => { await l.lire(SONDE, 'fil', []); pret(); await repos; });
    });
    await Promise.all(prets);
    await expect(horsBoucle<number>(SONDE, 'fil', [])).resolves.toEqual(expect.any(Number));
    liberer();
    await Promise.all(lecteurs);
  });

  it('une lecture à la fois par lecteur : une seconde lecture simultanée est refusée', async () => {
    // Les réponses du worker ne portent pas d'identifiant : deux lectures en vol se verraient rendre la réponse l'une
    // de l'autre. On refuse plutôt que de les mélanger en silence.
    await avecLecteur({}, async (l) => {
      const premiere = l.lire(SONDE, 'attendre', [300]);
      await expect(l.lire(SONDE, 'fil', [])).rejects.toThrow('une lecture à la fois');
      await expect(premiere).resolves.toBe(300);
    });
  });

  it('parle de pages quand il lit des pages', async () => {
    await expect(avecLecteur({ nature: 'pages', delaiMs: 1_000 }, (l) => l.lire(SONDE, 'attendre', [5_000])))
      .rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('ces pages') });
  });
});
