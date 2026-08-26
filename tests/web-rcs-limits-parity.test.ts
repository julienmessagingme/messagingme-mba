import { describe, it, expect } from 'vitest';
import { RCS_TEXTE_MAX } from '../web/lib/rcs-limits';
import { RCS_TEXTE_MAX as SERVEUR } from '../src/rcs/schema';

/**
 * Parité front / back de la borne du texte RCS. La valeur est recopiée côté écran (les deux builds ne
 * partagent aucun module) : ce test casse si elles divergent, ce qui ferait accepter par l'écran un message
 * que le serveur refuse, ou l'inverse.
 *
 * Vit dans la suite racine (comme les autres `web-*-parity`) : elle a les dépendances des deux côtés.
 */
describe('borne du texte RCS', () => {
  it('la valeur du front est celle du schéma serveur', () => {
    expect(RCS_TEXTE_MAX).toBe(SERVEUR);
  });
});
