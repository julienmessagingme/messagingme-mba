import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * 🔴 L'ARRÊT D'UN PROCESSUS COUPE LE RÉVEIL COURT AVANT LA FILE ET LE POOL (relecture du lot « Attente en secondes »).
 * Sans ça, des minuteries continuaient de réclamer et de reprendre des parcours pendant la fermeture, et une reprise
 * coupée entre l'envoi et l'écriture laissait le parcours sous bail : le balayage du processus suivant renvoyait le même
 * message. Le compilateur ne voit pas un appel oublié dans un nettoyage : ce test lit les deux nettoyages.
 */
const lire = (f: string) => readFileSync(resolve(__dirname, '..', f), 'utf8');

function nettoyage(source: string): string {
  const debut = source.indexOf('installGracefulShutdown(async () => {');
  expect(debut).toBeGreaterThan(-1);
  return source.slice(debut, source.indexOf('\n  }', debut));
}

describe('le réveil court s’arrête avant la file et le pool', () => {
  it.each(['src/worker.ts', 'src/index.ts'])('%s', (fichier) => {
    const corps = nettoyage(lire(fichier));
    const arret = corps.indexOf('reveilCourt.arreter(');
    expect(arret, 'arrêt du réveil court absent du nettoyage').toBeGreaterThan(-1);
    expect(arret).toBeLessThan(corps.indexOf('queue.stop()'));
    expect(arret).toBeLessThan(corps.indexOf('pool.end()'));
  });
});
