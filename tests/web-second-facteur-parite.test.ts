import { describe, it, expect } from 'vitest';
import { MESSAGE_CODE_INVALIDE as DU_SERVEUR } from '../src/auth/mfa-routes';
import { MESSAGE_CODE_INVALIDE as DE_LA_CONSOLE, estCorpsCodeRefuse } from '../web/lib/second-facteur';

/**
 * LE CODE REFUSÉ, VU DES DEUX CÔTÉS DE LA FRONTIÈRE DE BUILD (double authentification, 2026-09-26).
 *
 * Le serveur répond 401 à un code faux ET à une session tombée ; seul son texte les distingue. La console le
 * RECONNAÎT pour garder la session quand un code est mal tapé sur la page Compte, et pour rester sur l'étape à
 * la connexion. La frontière de build interdit de partager la constante : changer l'une sans l'autre ne casse
 * aucun compilateur, et un code mal tapé se remet à déconnecter.
 */
describe('code refusé : parité serveur / console', () => {
  it('🔴 la console reconnaît EXACTEMENT ce que le serveur écrit', () => {
    expect(DE_LA_CONSOLE).toBe(DU_SERVEUR);
    expect(estCorpsCodeRefuse({ error: DU_SERVEUR })).toBe(true);
  });
});
