import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { WORKFLOW_NODE_TYPES } from '../src/workflow/graph';
import { NODE_META } from '../web/lib/nodeMeta';

/**
 * LES TYPES DE BLOC EXISTENT EN DEUX EXEMPLAIRES, et ce test est ce qui les tient alignés.
 *
 * 🔴 POURQUOI DEUX. Le serveur en fait une constante (`WORKFLOW_NODE_TYPES`) qui VALIDE le graphe à
 * l'enregistrement ; le front en fait un type et une table d'affichage (`NODE_META`) pour dessiner les blocs.
 * Importer l'un dans l'autre tirerait du code serveur dans le bundle client, ce que le dépôt refuse ailleurs
 * pour la même raison (cf. `MAX_DESTINATAIRES_EMAIL`).
 *
 * 🔴 CE QUE COÛTE UNE DIVERGENCE, dans les deux sens :
 *  - type connu du FRONT seulement -> le bloc se pose, puis l'enregistrement est refusé en bloc avec un
 *    « graphe invalide » qui ne nomme pas le coupable ;
 *  - type connu du SERVEUR seulement -> le bloc s'enregistre et l'écran ne sait pas le dessiner.
 * Les deux se découvrent en production, sur un scénario qu'on croyait sauvé.
 */
describe('parité des types de bloc entre le moteur et la console', () => {
  it('🔴 chaque type du moteur a une entrée d’affichage, et réciproquement', () => {
    const moteur = [...WORKFLOW_NODE_TYPES].sort();
    const console_ = Object.keys(NODE_META).sort();
    expect(console_).toEqual(moteur);
  });

  it('🔴 le TYPE TypeScript du front liste exactement les mêmes', () => {
    // `NODE_META` est typé `Record<WorkflowNodeType, …>`, donc un type manquant y serait une erreur de
    // compilation. Mais un type EN TROP dans l'union, jamais mis dans la table, passerait : on lit donc la
    // ligne elle-même. Grossier, et c'est voulu : le contrat est textuel, la vérification aussi.
    const src = readFileSync(new URL('../web/lib/api/scenarios.ts', import.meta.url), 'utf8');
    const ligne = src.split('\n').find((l) => l.startsWith('export type WorkflowNodeType ='));
    expect(ligne, 'la déclaration doit rester sur UNE ligne pour être lisible ici').toBeTruthy();
    const declares = [...(ligne ?? '').matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!).sort();
    expect(declares).toEqual([...WORKFLOW_NODE_TYPES].sort());
  });
});
