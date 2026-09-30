import { describe, it, expect } from 'vitest';
import { CLES_SYSTEME, LIBELLES_SYSTEME } from '../src/agent/variables';
import { LIBELLES_VALEURS_SYSTEME, libelleValeurSysteme } from '../web/lib/valeurs-systeme';

/**
 * Les libellés des valeurs système, des deux côtés.
 *
 * 🔴 Le serveur envoie les clés dans le catalogue et la console les nomme. Avant, la console testait
 * `cle === 'maintenant'` et donnait « dernier message du contact » à TOUT le reste : chaque clé ajoutée au serveur
 * aurait porté à l'écran le libellé d'une autre, donc fait choisir une valeur pour une autre.
 */
describe('valeurs système : un libellé pour chaque clé du serveur', () => {
  it('🔴 chaque clé du serveur a son libellé dans la console', () => {
    for (const cle of CLES_SYSTEME) expect(LIBELLES_VALEURS_SYSTEME[cle], cle).toBeDefined();
  });

  it('le libellé français est le même des deux côtés', () => {
    for (const cle of CLES_SYSTEME) expect(LIBELLES_VALEURS_SYSTEME[cle]![0]).toBe(LIBELLES_SYSTEME[cle]);
  });

  it('une clé inconnue s’affiche telle quelle, jamais sous le libellé d’une autre', () => {
    expect(libelleValeurSysteme('cle_future')).toEqual(['cle_future', 'cle_future']);
  });
});
