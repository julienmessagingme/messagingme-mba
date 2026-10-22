import { DisconnectReason } from '@whiskeysockets/baileys';
import { describe, expect, it } from 'vitest';
import { codeDeconnexion, delaiBackoff, surDeconnexion, surOuverture } from '../src/application/transport/connexion';
import { causeDeFermeture, estRelie } from '../src/application/transport/session';

/**
 * LA MACHINE D'ÉTATS DE LA CONNEXION, recopiée de wagroups (commit 526d3cc, `src/transport/connectionState.test.ts`),
 * plus ce que la filière application y ajoute : la cause d'une fermeture dans nos statuts, et la reconnaissance d'un
 * compte relié par QR code.
 */
describe('machine a etats de connexion (recopiée de wagroups 526d3cc)', () => {
  it('passe a connected a l ouverture', () => {
    const t = surOuverture();
    expect(t.statut).toBe('connected');
    expect(t.reconnecter).toBe(false);
    expect(t.delaiMs).toBe(0);
  });

  it('reconnecte sur une perte de connexion', () => {
    const t = surDeconnexion('connected', DisconnectReason.connectionLost, 0);
    expect(t.statut).toBe('reconnecting');
    expect(t.reconnecter).toBe(true);
    expect(t.delaiMs).toBe(delaiBackoff(0));
  });

  it('branche par defaut : le delai renvoye est bien celui de delaiBackoff, pas un delai fige', () => {
    const t = surDeconnexion('connected', DisconnectReason.connectionLost, 3);
    expect(t.statut).toBe('reconnecting');
    expect(t.delaiMs).toBe(delaiBackoff(3));
  });

  it('reconnecte immediatement sur restartRequired, qui suit toujours un pairing', () => {
    const t = surDeconnexion('pairing', DisconnectReason.restartRequired, 0);
    expect(t.statut).toBe('reconnecting');
    expect(t.reconnecter).toBe(true);
    expect(t.delaiMs).toBe(0);
  });

  it('un restartRequired qui se repete au-dela de la premiere tentative applique le backoff', () => {
    const t = surDeconnexion('reconnecting', DisconnectReason.restartRequired, 2);
    expect(t.reconnecter).toBe(true);
    expect(t.delaiMs).toBe(delaiBackoff(2));
  });

  it('passe a dead sur loggedOut et ne reconnecte pas', () => {
    const t = surDeconnexion('connected', DisconnectReason.loggedOut, 0);
    expect(t.statut).toBe('dead');
    expect(t.reconnecter).toBe(false);
    expect(t.raison).toContain('401');
  });

  it('passe a banned sur forbidden et ne reconnecte pas', () => {
    const t = surDeconnexion('connected', DisconnectReason.forbidden, 0);
    expect(t.statut).toBe('banned');
    expect(t.reconnecter).toBe(false);
    expect(t.raison).toContain('403');
  });

  it('un 403 fait basculer vers banned meme depuis dead : le ban domine dead', () => {
    const t = surDeconnexion('dead', DisconnectReason.forbidden, 0);
    expect(t.statut).toBe('banned');
    expect(t.reconnecter).toBe(false);
  });

  it('ne sort jamais de banned, meme sur un evenement anodin', () => {
    const t = surDeconnexion('banned', DisconnectReason.connectionLost, 0);
    expect(t.statut).toBe('banned');
    expect(t.reconnecter).toBe(false);
  });

  it('ne reconnecte pas non plus depuis dead', () => {
    const t = surDeconnexion('dead', DisconnectReason.connectionLost, 0);
    expect(t.statut).toBe('dead');
    expect(t.reconnecter).toBe(false);
  });

  it('reconnecte sur un code inconnu ou absent, sans jamais supposer un ban', () => {
    expect(surDeconnexion('connected', 999, 0).reconnecter).toBe(true);
    expect(surDeconnexion('connected', undefined, 0).reconnecter).toBe(true);
  });

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

  it('un compte relié par QR code se reconnaît à son identité, même sans `registered` (essai du 2026-10-21)', () => {
    expect(estRelie({ me: { id: '441555479304:1@s.whatsapp.net' }, registered: false })).toBe(true);
    expect(estRelie({ registered: true })).toBe(true);
    expect(estRelie({ registered: false })).toBe(false);
  });
});
