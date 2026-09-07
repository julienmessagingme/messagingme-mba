import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * LE CÂBLAGE DE LA RÈGLE « lancer un scénario remplace celui en cours », lu dans les SOURCES.
 *
 * 🔴 POURQUOI LIRE LE TEXTE PLUTÔT QUE LE COMPORTEMENT. Un câblage n'a par construction aucun dépendant :
 * le retirer ne casse aucun appelant, donc aucun test unitaire ne s'en aperçoit, et un test unitaire monte
 * de toute façon son PROPRE faux, qui bouge avec le code. C'est le même motif que
 * `tests/workflow-cablage-categorie.test.ts` : là-bas, retirer le contexte de catégorie passait tsc ET
 * toute la suite.
 *
 * Ce que ces trois lectures protègent, et qui a coûté une semaine de mutisme en production le 2026-09-07 :
 * un lien de chaîne cliqué pendant qu'un autre parcours attendait n'ouvrait jamais son scénario.
 */
const lire = (p: string): string => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

describe('la règle « un démarrage remplace le parcours en cours » reste câblée', () => {
  it('🔴 A6 : l’exécuteur clôt bien le parcours actif sur le chemin COMMUN', async () => {
    const src = lire('src/workflow/executor.ts');
    expect(src).toContain('closeActiveByWaId');
    // Dans `runFrom`, donc APRÈS les gardes et AVANT la persistance : c'est ce placement qui fait qu'un
    // démarrage refusé ne tue pas le parcours en cours. Les tests de comportement le prouvent ; celui-ci
    // garde le fait que l'appel existe encore quelque part, ce qu'aucun faux ne peut simuler.
    const iFerme = src.indexOf('runs.closeActiveByWaId');
    const iPersiste = src.indexOf('this.deps.runs.start(tenantId, workflowId, contact.waId');
    expect(iFerme, 'la fermeture a disparu de l’exécuteur').toBeGreaterThan(0);
    expect(iPersiste, 'la persistance du run a bougé, ce test doit être relu').toBeGreaterThan(0);
    expect(iFerme, 'la fermeture doit précéder la persistance du nouveau parcours').toBeLessThan(iPersiste);
  });

  it('🔴 A6 : la garde qui BLOQUAIT ne revient pas dans le runner d’automations', async () => {
    // Elle sautait le déclenchement quand un parcours attendait. Le risque qu'elle défendait est fermé à la
    // source ; la réintroduire rendrait le défaut à l'identique, et rien d'autre ne le dirait.
    const src = lire('src/automation/runner.ts');
    const declare = /hasWaitingRun\s*\(/.test(src);
    expect(declare, 'hasWaitingRun est revenu dans le contrat du runner').toBe(false);
  });

  it('🔴 A6 : le réglage devenu mort ne traîne pas dans la configuration', async () => {
    // Une variable d'environnement qui ne pilote plus rien est pire qu'absente : quelqu'un la réglera en
    // croyant agir, et rien ne se passera.
    const src = lire('src/config.ts');
    expect(src).not.toContain('AUTOMATION_WAITING_RUN_MAX_AGE_MS');
  });
});
