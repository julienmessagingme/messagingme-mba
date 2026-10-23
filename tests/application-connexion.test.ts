import { DisconnectReason } from '@whiskeysockets/baileys';
import { describe, expect, it } from 'vitest';
import { codeDeconnexion, delaiBackoff } from '../src/application/transport/connexion';
import { causeDeFermeture } from '../src/application/transport/session';

/**
 * LA CONNEXION, recopiée de wagroups (commit 526d3cc, `src/transport/connectionState.test.ts`) : le délai de
 * reconnexion et la lecture du code de fermeture, plus ce que la filière application y ajoute, la cause d'une
 * fermeture dans nos statuts. La machine d'états de wagroups n'est pas recopiée : le gestionnaire des sessions décide.
 */
describe('le délai de reconnexion (recopié de wagroups 526d3cc)', () => {
  it('applique un backoff exponentiel plafonne a cinq minutes, et clampe un tentative hors domaine', () => {
    expect(delaiBackoff(0)).toBe(1000);
    expect(delaiBackoff(4)).toBe(16000);
    expect(delaiBackoff(50)).toBe(300000);
    expect(delaiBackoff(Number.NaN)).toBe(1000);
    expect(delaiBackoff(-5)).toBe(1000);
  });
});

describe('codeDeconnexion (recopié de wagroups 526d3cc)', () => {
  it('lit le code d’une erreur Boom quelle que soit la copie du paquet dont elle vient', () => {
    const boomDUneAutreCopie = { isBoom: true, output: { statusCode: 403, payload: {} } };
    expect(codeDeconnexion(boomDUneAutreCopie)).toBe(DisconnectReason.forbidden);
  });

  it('rend undefined sur tout ce qui ne porte pas de code numérique', () => {
    for (const cas of [undefined, null, new Error('reseau'), {}, { output: {} }, { output: { statusCode: '403' } }]) {
      expect(codeDeconnexion(cas), JSON.stringify(cas)).toBeUndefined();
    }
  });
});

describe('la filière application', () => {
  it('🔴 la cause d’une fermeture : 403 banni, 401 déconnecté, le reste une reprise', () => {
    expect(causeDeFermeture(DisconnectReason.forbidden)).toBe('banni');
    expect(causeDeFermeture(DisconnectReason.loggedOut)).toBe('deconnecte');
    expect(causeDeFermeture(DisconnectReason.restartRequired)).toBe('reprise');
    expect(causeDeFermeture(DisconnectReason.connectionLost)).toBe('reprise');
    expect(causeDeFermeture(undefined)).toBe('reprise');
  });

});
