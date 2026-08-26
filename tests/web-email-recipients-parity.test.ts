import { describe, it, expect } from 'vitest';
import { MAX_DESTINATAIRES_EMAIL as FRONT } from '../web/lib/nodeMeta';
import { MAX_DESTINATAIRES_EMAIL as BACK } from '../src/workflow/engine';

/**
 * Le plafond de destinataires d'un bloc email existe des DEUX côtés : le front pour masquer le bouton « + »,
 * le serveur pour TRONQUER (`parseGraph` ne regarde pas `data`, donc un graphe fabriqué à la main passerait
 * autant d'adresses qu'il veut). La valeur est recopiée plutôt qu'importée, pour ne pas tirer du code serveur
 * dans le bundle client. Ce test casse dès qu'elles divergent, cas où le bouton proposerait une 4e ligne que
 * le serveur jetterait en silence.
 *
 * Vit dans la suite racine (comme les autres `web-*-parity`) : elle a toutes les dépendances des deux côtés,
 * et importe le front par chemin relatif sans jamais exécuter `web/lib/api.ts` (le type qu'il exporte ici
 * n'est pas utilisé, seule la constante l'est).
 */
describe('parité du plafond de destinataires email front / back', () => {
  it('les deux constantes valent la même chose', () => {
    expect(FRONT).toBe(BACK);
  });
});
