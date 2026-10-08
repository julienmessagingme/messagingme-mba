import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildServer } from '../src/server';
import { FakeQueue } from './fake-queue';
import { signSession } from '../src/auth/token';
import type { UserAuthStore, EmailIdentity } from '../src/auth/store';
import type { DepsGestionEvenements } from '../src/evenements/gestion';
import type { AdresseVue } from '../src/evenements/store.pg';

/**
 * Développeurs > Webhooks sortants (lot 12, livraison A) : les routes de la console. La logique est testée dans
 * `tests/evenements-gestion.test.ts` ; ici, ce que la route ajoute : la garde d'admin (lecture comprise), le secret
 * absent de toute lecture et de l'audit, et le refus d'offre traduit en 402.
 */
const SECRET = 'test-secret';
let admin = '';
let agent = '';
beforeAll(async () => {
  admin = await signSession({ userId: 'u1', tenantId: 't1', role: 'admin' }, SECRET);
  agent = await signSession({ userId: 'u2', tenantId: 't1', role: 'agent' }, SECRET);
});
const noUsers: UserAuthStore = { findIdentity: async (): Promise<EmailIdentity | null> => null };
const en = (jeton: string) => ({ headers: { 'content-type': 'application/json', authorization: `Bearer ${jeton}` } });
const BASE = '/tenants/t1/evenements/adresses';

function monter(o: { limite?: number | null } = {}) {
  const adresses = new Map<string, AdresseVue & { secretChiffre: string }>();
  const audit: Array<{ action: string; detail: unknown }> = [];
  const sansSecret = ({ secretChiffre: _s, ...v }: AdresseVue & { secretChiffre: string }): AdresseVue => v;
  const gestion: DepsGestionEvenements = {
    adresses: {
      lister: async () => [...adresses.values()].map(sansSecret),
      lire: async (_t, id) => { const a = adresses.get(id); return a ? sansSecret(a) : null; },
      existe: async (_t, id) => adresses.has(id),
      compterActives: async () => [...adresses.values()].filter((a) => a.active).length,
      creer: async (_t, a) => {
        const id = randomUUID();
        adresses.set(id, {
          id, url: a.url, description: a.description, types: [...a.types], active: true, creeLe: new Date().toISOString(),
          ancienSecretJusqua: null, derniereLivraisonLe: null, enReessai: 0, echecs: 0, secretChiffre: a.secretChiffre,
        });
        return sansSecret(adresses.get(id)!);
      },
      modifier: async () => null,
      tourner: async (_t, id, s) => { const a = adresses.get(id); if (!a) return false; a.secretChiffre = s; return true; },
      supprimer: async (_t, id) => adresses.delete(id),
      pourEnvoi: async () => null,
    },
    envois: { noterEssai: async () => {}, journal: async () => [], rejouer: async () => null, rejouerEchecs: async () => [] },
    limiteAdresses: async () => (o.limite === undefined ? null : o.limite),
    chiffrementPret: true,
    chiffrer: (c) => `chiffre:${c}`,
    dechiffrer: (c) => c.replace(/^chiffre:/, ''),
    verifierAdresse: async () => ({ ok: true }),
    appeler: async () => ({ livre: true, definitif: false, code: 200, extrait: '' }),
    enfiler: async () => {},
    invaliderCache: () => {},
  };
  const app = buildServer({
    queue: new FakeQueue(), auth: { users: noUsers, secret: SECRET },
    evenements: { gestion, audit: async (_t, _acteur, action, _cible, detail) => { audit.push({ action, detail }); } },
  });
  return { app, audit };
}

describe('les routes des webhooks sortants', () => {
  it('🔴 réservées aux admins, lecture comprise : le journal porte des données de contacts', async () => {
    const { app } = monter();
    expect((await app.inject({ method: 'GET', url: BASE, ...en(agent) })).statusCode).toBe(403);
  });

  it('🔴 le secret est rendu à la création, puis jamais : ni dans la liste, ni dans l’audit', async () => {
    const { app, audit } = monter();
    const cree = await app.inject({ method: 'POST', url: BASE, ...en(admin), payload: { url: 'https://app.client.fr/hook', types: ['message.received'] } });
    expect(cree.statusCode).toBe(201);
    const { secret, adresse } = cree.json() as { secret: string; adresse: { id: string } };
    expect(secret).toMatch(/^whsec_/);

    const liste = await app.inject({ method: 'GET', url: BASE, ...en(admin) });
    expect(liste.statusCode).toBe(200);
    expect(liste.body).not.toContain(secret.slice(6));
    expect(liste.json()).toMatchObject({ limite: null, types: expect.arrayContaining(['message.received', 'conversation.analyzed']) });

    const tourne = await app.inject({ method: 'POST', url: `${BASE}/${adresse.id}/rotation`, ...en(admin) });
    const neuf = (tourne.json() as { secret: string }).secret;
    expect(neuf).toMatch(/^whsec_/);
    expect(neuf).not.toBe(secret);

    expect(audit.map((a) => a.action)).toEqual(['evenements.adresse_creee', 'evenements.secret_tourne']);
    expect(JSON.stringify(audit)).not.toContain(secret.slice(6));
    expect(JSON.stringify(audit)).not.toContain(neuf.slice(6));
  });

  it('🔴 au-delà de l’offre : 402 plan_limit_reached, avec le lien de l’offre', async () => {
    const { app } = monter({ limite: 1 });
    await app.inject({ method: 'POST', url: BASE, ...en(admin), payload: { url: 'https://a.client.fr/h' } });
    const r = await app.inject({ method: 'POST', url: BASE, ...en(admin), payload: { url: 'https://b.client.fr/h' } });
    expect(r.statusCode).toBe(402);
    expect(r.json()).toMatchObject({ code: 'plan_limit_reached', limite: 'adressesWebhook', max: 1, upgradeUrl: expect.stringContaining('/offre') });
  });

  it('une adresse inconnue rend 404, un envoi en cours à rejouer 409', async () => {
    const { app } = monter();
    expect((await app.inject({ method: 'DELETE', url: `${BASE}/${randomUUID()}`, ...en(admin) })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/tenants/t1/evenements/envois/${randomUUID()}/rejeu`, ...en(admin) })).statusCode).toBe(409);
  });
});
