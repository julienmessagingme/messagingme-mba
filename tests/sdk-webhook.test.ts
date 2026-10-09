import { describe, it, expect, vi } from 'vitest';
import { verifyWebhook, WebhookVerificationError, type WebhookEvent } from '../sdk/src/index';
import { enTetesSignes, genererSecret } from '../src/evenements/signature';
import { donneesEssai, enveloppe } from '../src/evenements/types';

/**
 * 🔴 CE QUE LE SERVEUR SIGNE, LE SDK LE VÉRIFIE (lot 16, livraison B). Les en-têtes sont produits par le VRAI code
 * d'envoi (`enTetesSignes`), pas recopiés : une divergence entre les deux côtés casse ici, avant qu'un client ne
 * rejette tous nos événements.
 */
const MAINTENANT = new Date('2026-10-09T12:00:00.000Z');
const ID = 'evt_0123456789abcdef0123456789abcdef';
const corpsEssai = JSON.stringify(enveloppe({ id: ID, type: 'test', le: MAINTENANT.toISOString(), tenantId: 't1', data: donneesEssai() }));

async function refus(p: Promise<unknown>): Promise<string> {
  try { await p; } catch (e) {
    if (e instanceof WebhookVerificationError) return e.message;
    throw e;
  }
  throw new Error('la vérification a accepté');
}

describe('verifyWebhook contre la signature du serveur', () => {
  const secret = genererSecret();
  // Recopiés dans un objet littéral, comme les en-têtes d'une requête Node ou Express (un type à signature d'index).
  const signes = { ...enTetesSignes({ secrets: [secret], id: ID, maintenant: MAINTENANT, corps: corpsEssai }) };

  it('un événement signé par le serveur se vérifie, et ressort typé', async () => {
    const e = await verifyWebhook({ secret, headers: signes, body: corpsEssai, now: MAINTENANT.getTime() });
    expect(e.id).toBe(ID);
    expect(e.type).toBe('test');
    if (e.type === 'test') {
      const essai: WebhookEvent<'test'> = e;
      expect(essai.data.message).toMatch(/essai/i);
    }
  });

  it('les en-têtes passent aussi en objet Headers, et le corps en octets', async () => {
    const e = await verifyWebhook({ secret, headers: new Headers(signes), body: new TextEncoder().encode(corpsEssai), now: MAINTENANT.getTime() });
    expect(e.type).toBe('test');
  });

  it('un corps altéré, un autre secret, ou une signature d’une autre version sont refusés', async () => {
    const t = MAINTENANT.getTime();
    expect(await refus(verifyWebhook({ secret, headers: signes, body: corpsEssai.replace('test', 'tesT'), now: t }))).toBe('signature invalide');
    expect(await refus(verifyWebhook({ secret: genererSecret(), headers: signes, body: corpsEssai, now: t }))).toBe('signature invalide');
    const v2 = { ...signes, 'webhook-signature': signes['webhook-signature'].replace(/^v1,/, 'v2,') };
    expect(await refus(verifyWebhook({ secret, headers: v2, body: corpsEssai, now: t }))).toBe('signature invalide');
  });

  it('un horodatage hors tolérance est refusé (5 minutes par défaut), dans les deux sens', async () => {
    expect(await refus(verifyWebhook({ secret, headers: signes, body: corpsEssai, now: MAINTENANT.getTime() + 301_000 }))).toMatch(/tolérance/);
    expect(await refus(verifyWebhook({ secret, headers: signes, body: corpsEssai, now: MAINTENANT.getTime() - 301_000 }))).toMatch(/tolérance/);
    await expect(verifyWebhook({ secret, headers: signes, body: corpsEssai, now: MAINTENANT.getTime() + 299_000 })).resolves.toBeDefined();
    await expect(verifyWebhook({ secret, headers: signes, body: corpsEssai, now: MAINTENANT.getTime() + 600_000, toleranceSeconds: 900 })).resolves.toBeDefined();
  });

  it('pendant une rotation, l’ancien secret vérifie encore (deux signatures dans l’en-tête)', async () => {
    const nouveau = genererSecret();
    const rotation = { ...enTetesSignes({ secrets: [nouveau, secret], id: ID, maintenant: MAINTENANT, corps: corpsEssai }) };
    expect(rotation['webhook-signature'].split(' ')).toHaveLength(2);
    for (const s of [nouveau, secret, [genererSecret(), secret]]) {
      await expect(verifyWebhook({ secret: s, headers: rotation, body: corpsEssai, now: MAINTENANT.getTime() })).resolves.toBeDefined();
    }
  });

  it('une configuration fausse est une TypeError, jamais un refus de signature (ni une tolérance éteinte)', async () => {
    const t = MAINTENANT.getTime();
    const base = { headers: signes, body: corpsEssai, now: t };
    for (const s of ['', 'whsec_', 'whsec_%%%', [] as string[]]) {
      await expect(verifyWebhook({ ...base, secret: s })).rejects.toBeInstanceOf(TypeError);
    }
    // `Number(process.env.X)` sans la variable : NaN ne doit pas éteindre la protection contre le rejeu.
    await expect(verifyWebhook({ ...base, secret, toleranceSeconds: Number.NaN })).rejects.toBeInstanceOf(TypeError);
    await expect(verifyWebhook({ ...base, secret, toleranceSeconds: -1 })).rejects.toBeInstanceOf(TypeError);
    await expect(verifyWebhook({ ...base, secret, now: Number.NaN })).rejects.toBeInstanceOf(TypeError);
  });

  it('un en-tête en tableau, ou des signatures jointes par Node (« , »), se vérifient', async () => {
    const [, valide] = signes['webhook-signature'].split(',');
    const autre = `v1,${btoa(String.fromCharCode(...new Uint8Array(32).fill(7)))}`;
    const t = MAINTENANT.getTime();
    await expect(verifyWebhook({ secret, headers: { ...signes, 'webhook-signature': [autre, `v1,${valide}`] }, body: corpsEssai, now: t })).resolves.toBeDefined();
    await expect(verifyWebhook({ secret, headers: { ...signes, 'webhook-signature': `${autre}, v1,${valide}` }, body: corpsEssai, now: t })).resolves.toBeDefined();
  });

  it('🔴 une signature qui ne fait pas 32 octets est écartée sans calcul', async () => {
    const t = MAINTENANT.getTime();
    // Deux cents candidates courtes et toutes différentes, puis la vraie : sans le filtre, le plafond serait atteint
    // avant elle et l'événement refusé.
    const courtes = Array.from({ length: 200 }, (_, i) => `v1,${btoa(String.fromCharCode(i % 256, Math.floor(i / 256)))}`);
    const espion = vi.spyOn(globalThis.crypto.subtle, 'verify');
    try {
      const entetes = { ...signes, 'webhook-signature': [...courtes, signes['webhook-signature']].join(' ') };
      await expect(verifyWebhook({ secret, headers: entetes, body: corpsEssai, now: t })).resolves.toBeDefined();
      expect(espion.mock.calls.length).toBe(1);
    } finally {
      espion.mockRestore();
    }
  });

  it('🔴 un en-tête bourré de candidates de 32 octets ne fait pas calculer un HMAC par candidate', async () => {
    const t = MAINTENANT.getTime();
    const candidates = Array.from({ length: 200 }, (_, i) => `v1,${btoa(String.fromCharCode(...new Uint8Array(32).fill(i % 256)))}`);
    const espion = vi.spyOn(globalThis.crypto.subtle, 'verify');
    try {
      const entetes = { ...signes, 'webhook-signature': [...candidates, signes['webhook-signature']].join(' ') };
      expect(await refus(verifyWebhook({ secret, headers: entetes, body: corpsEssai, now: t }))).toBe('signature invalide');
      expect(espion.mock.calls.length).toBe(10);
    } finally {
      espion.mockRestore();
    }
  });

  it('des en-têtes absents sont refusés sans calcul', async () => {
    const { 'webhook-signature': _s, ...sansSignature } = signes;
    expect(await refus(verifyWebhook({ secret, headers: sansSignature, body: corpsEssai }))).toMatch(/absents/);
  });

  it('le vecteur publié par Standard Webhooks : la signature passe, son corps n’est pas un événement', async () => {
    const entetes = {
      'webhook-id': 'msg_p5jXN8AQM9LWM0D4loKWxJek',
      'webhook-timestamp': '1614265330',
      'webhook-signature': 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=',
    };
    const base = { secret: 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw', headers: entetes, now: 1614265330_000 };
    // Un refus APRÈS la signature (le corps n'est pas un de nos événements) prouve que le calcul est le bon.
    expect(await refus(verifyWebhook({ ...base, body: '{"test": 2432232314}' }))).toMatch(/pas un événement/);
    expect(await refus(verifyWebhook({ ...base, body: '{"test": 2432232315}' }))).toBe('signature invalide');
  });
});
