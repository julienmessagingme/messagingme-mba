import { describe, it, expect } from 'vitest';
import { horsBoucle } from '../src/lib/hors-boucle';
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

  it('🔴 un worker qui ne démarre pas ne garde pas de place : la lecture suivante passe', async () => {
    // Relevé par la relecture du 2026-09-30 : le compteur montait avant `new Worker`. Quatre échecs au démarrage (ici un
    // argument que le clonage refuse) suffisaient à rendre 429 à tout le monde, jusqu'au redémarrage.
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
