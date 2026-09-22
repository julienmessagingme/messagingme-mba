import { describe, it, expect } from 'vitest';
import { CORPS_OPAQUE_5XX } from '../src/server';
import { OPAQUE_DU_SERVEUR, messageDErreur } from '../web/lib/http';

/**
 * LE CORPS OPAQUE D'UN 5xx, VU DES DEUX CÔTÉS DE LA FRONTIÈRE DE BUILD.
 *
 * Le serveur écrit un texte volontairement vide de sens sur sa propre panne ; la console le RECONNAÎT pour
 * afficher à la place une phrase traduite qui dit quoi faire. La frontière de build interdit de partager la
 * constante, donc elle existe deux fois : changer l'une sans l'autre ne casse aucun compilateur, et l'écran
 * se remet à afficher « Internal Server Error ».
 */
describe('corps opaque d’un 5xx', () => {
  it('🔴 la console reconnaît EXACTEMENT ce que le serveur écrit', () => {
    expect(OPAQUE_DU_SERVEUR).toBe(CORPS_OPAQUE_5XX);
  });

  it('et la reconnaissance a un effet : ce texte ne s’affiche jamais tel quel', () => {
    expect(messageDErreur(500, { error: CORPS_OPAQUE_5XX }, 'fr')).not.toContain(CORPS_OPAQUE_5XX);
  });
});
