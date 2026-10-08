import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { enTetesSignes, genererSecret, secretsQuiSignent, signer } from '../src/evenements/signature';

/**
 * La signature des webhooks sortants suit Standard Webhooks (standardwebhooks.com) : `webhook-id`, `webhook-timestamp`
 * et `webhook-signature: v1,<base64>` sur `id.timestamp.corps`, HMAC-SHA256, clé = le base64 qui suit `whsec_`.
 * Les bibliothèques de vérification de tous les langages lisent ce format : s'en écarter d'un octet les casse toutes.
 */
describe('la signature Standard Webhooks', () => {
  it('🔴 reproduit le vecteur de test publié par Standard Webhooks', () => {
    // Le cas de la suite de tests de la spécification : secret, identifiant, horodatage et corps publiés avec la valeur
    // attendue. Une bibliothèque de vérification du client calcule exactement la même.
    expect(signer({
      secret: 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw',
      id: 'msg_p5jXN8AQM9LWM0D4loKWxJek',
      horodatage: 1614265330,
      corps: '{"test": 2432232314}',
    })).toBe('v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=');
  });

  it('les trois en-têtes, et un horodatage en secondes', () => {
    const e = enTetesSignes({ secrets: ['whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw'], id: 'evt_1', maintenant: new Date('2026-10-08T12:00:00.500Z'), corps: '{}' });
    expect(e['webhook-id']).toBe('evt_1');
    expect(e['webhook-timestamp']).toBe(String(Date.parse('2026-10-08T12:00:00Z') / 1000));
    expect(e['webhook-signature']).toMatch(/^v1,[A-Za-z0-9+/]+=*$/);
    expect(e['content-type']).toBe('application/json');
  });

  it('🔴 pendant une rotation, les deux secrets signent, séparés par une espace', () => {
    const ancien = genererSecret();
    const neuf = genererSecret();
    const e = enTetesSignes({ secrets: [neuf, ancien], id: 'evt_2', maintenant: new Date(0), corps: '{"a":1}' });
    const [s1, s2] = e['webhook-signature'].split(' ');
    const attendue = (secret: string) =>
      'v1,' + createHmac('sha256', Buffer.from(secret.slice('whsec_'.length), 'base64')).update('evt_2.0.{"a":1}').digest('base64');
    expect(s1).toBe(attendue(neuf));
    expect(s2).toBe(attendue(ancien));
  });

  it('un secret neuf : préfixe whsec_, 32 octets aléatoires, jamais deux fois le même', () => {
    const a = genererSecret();
    expect(a).toMatch(/^whsec_[A-Za-z0-9+/]{43}=$/);
    expect(Buffer.from(a.slice(6), 'base64')).toHaveLength(32);
    expect(genererSecret()).not.toBe(a);
  });

  it('🔴 l’ancien secret ne signe plus une fois sa fenêtre passée', () => {
    const maintenant = new Date('2026-10-08T12:00:00Z');
    expect(secretsQuiSignent({ actuel: 'whsec_A', precedent: 'whsec_B', precedentJusqua: new Date('2026-10-08T13:00:00Z') }, maintenant))
      .toEqual(['whsec_A', 'whsec_B']);
    expect(secretsQuiSignent({ actuel: 'whsec_A', precedent: 'whsec_B', precedentJusqua: new Date('2026-10-08T11:59:59Z') }, maintenant))
      .toEqual(['whsec_A']);
    expect(secretsQuiSignent({ actuel: 'whsec_A', precedent: null, precedentJusqua: null }, maintenant)).toEqual(['whsec_A']);
  });
});
