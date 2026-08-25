import { describe, it, expect } from 'vitest';
import { MAX_DESTINATAIRES_EMAIL as FRONT } from './nodeMeta';
import { MAX_DESTINATAIRES_EMAIL as BACK } from '../../src/workflow/engine';

/**
 * Le plafond de destinataires d'un bloc email existe des DEUX côtés : le front pour masquer le bouton « + »,
 * le serveur pour TRONQUER (`parseGraph` ne regarde pas `data`, donc un graphe fabriqué à la main passerait
 * autant d'adresses qu'il veut). La valeur est recopiée plutôt qu'importée, pour ne pas tirer du code serveur
 * dans le bundle client. Ce test casse dès qu'elles divergent, cas où le bouton proposerait une 4e ligne que
 * le serveur jetterait en silence.
 *
 * ⚠️ Il vit dans `web/` et non dans `tests/` : la suite racine n'a pas la lib DOM, et importer `web/lib/nodeMeta`
 * depuis là tire `web/lib/api` puis `http.ts`, qui référence `window`. Même raison que `web/lib/fields.test.ts`.
 */
describe('parité du plafond de destinataires email front / back', () => {
  it('les deux constantes valent la même chose', () => {
    expect(FRONT).toBe(BACK);
  });
});
