import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { relative, resolve } from 'node:path';

/**
 * TOUT SPEC E2E PASSE PAR LA GARDE DE LA CSP (`web/e2e/aide/test.ts`, lot 6 du bilan des audits).
 *
 * La garde est une fixture automatique : elle ne tourne que dans les specs qui importent SON `test`. Un spec qui
 * importerait celui de `@playwright/test` resterait vert en violant la politique, et c'est exactement le spec que
 * personne ne regarderait. Les annotations de type (`import('@playwright/test').Page`) restent permises.
 */
const E2E = resolve(__dirname, '../web/e2e');

function specs(dossier: string): string[] {
  return readdirSync(dossier, { withFileTypes: true }).flatMap((e) => {
    const chemin = resolve(dossier, e.name);
    if (e.isDirectory()) return specs(chemin);
    return e.name.endsWith('.spec.ts') ? [chemin] : [];
  });
}

describe('la garde de la CSP dans les e2e', () => {
  const tous = specs(E2E);

  it('les specs existent (sans quoi les assertions suivantes seraient vides)', () => {
    expect(tous.length).toBeGreaterThan(100);
  });

  it('🔴 chaque spec importe `test` de la garde, aucun de `@playwright/test`, et aucun n’ouvre son propre contexte', () => {
    const fautifs = tous.filter((f) => {
      const source = readFileSync(f, 'utf8');
      const deLaGarde = /^import \{[^}]*\btest\b[^}]*\} from '(\.\/|(\.\.\/)+)aide\/test';$/m.test(source);
      const direct = /^import \{[^}]*\btest\b[^}]*\} from '@playwright\/test';$/m.test(source);
      // Un contexte ouvert par le spec lui-même n'est pas celui que la garde écoute.
      const contextePropre = /\bnewContext\(/.test(source);
      return !deLaGarde || direct || contextePropre;
    }).map((f) => relative(E2E, f));
    expect(fautifs).toEqual([]);
  });
});
