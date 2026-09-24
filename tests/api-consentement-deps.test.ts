import { describe, it, expect } from 'vitest';
import { depsConsentementDe } from '../src/api/consentement';
import type { AuditSink } from '../src/audit/journal';

/**
 * LES DÉPENDANCES DU CONSENTEMENT, CONSTRUITES À UN SEUL ENDROIT (`/v1/contacts` et `/v1/sends`).
 *
 * 🔴 Deux constructions divergeraient : une route journaliserait un consentement que l'autre écrirait sans
 * trace. `tests/v1-cablage.test.ts` vérifie que les deux appelants passent par cette fonction.
 */
describe('depsConsentementDe', () => {
  it('🔴 les quatre paramètres atteignent le dépôt, et l’audit est celui qu’on donne', async () => {
    const recus: unknown[][] = [];
    const audit: AuditSink = async () => {};
    const deps = depsConsentementDe({ ecrireConsentementParId: async (...a) => { recus.push(a); return 'change'; } }, audit);
    expect(await deps.ecrireConsentementParId('t1', 'fiche-1', 'opted_out', 'formulaire-site')).toBe('change');
    expect(recus).toEqual([['t1', 'fiche-1', 'opted_out', 'formulaire-site']]);
    expect(deps.audit).toBe(audit);
  });

  it('⚠️ le dépôt garde son `this` : une méthode de classe passée telle quelle le perdrait', async () => {
    class Depot {
      appels = 0;
      async ecrireConsentementParId(): Promise<'inchange'> { this.appels += 1; return 'inchange'; }
    }
    const depot = new Depot();
    await depsConsentementDe(depot, async () => {}).ecrireConsentementParId('t1', 'fiche-1', 'opted_in', 'api');
    expect(depot.appels).toBe(1);
  });
});
