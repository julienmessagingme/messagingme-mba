import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildServer } from '../src/server';
import { FakeQueue } from './fake-queue';
import { sha256Hex } from '../src/lib/signature';
import { GardeUsageMemoire } from './aide/usage';
import type { ApiKeyLookup } from '../src/auth/api-key-store.pg';
import { cleApiDeTest, aucunJetonOauth } from './aide/cle-api';
import { contactsV1Muets } from './aide/contacts-v1';
import type { DepsGestionEvenements } from '../src/evenements/gestion';
import type { AdresseVue, EnvoiVue } from '../src/evenements/store.pg';

/**
 * LES WEBHOOKS SORTANTS PAR L'API (lot 13, domaine 4) : les routes `/v1/webhooks` sur la gestion de la console. La
 * logique est testée dans `tests/evenements-gestion.test.ts` ; ici, ce que la route ajoute : le droit, l'isolation entre
 * espaces (la gestion est appelée avec l'espace de la CLÉ), la traduction des noms et des refus, le secret montré une fois.
 */
class FakeApiKeys implements ApiKeyLookup {
  private readonly byHash = new Map<string, { id: string; tenantId: string; scopes: string[] }>();
  add(raw: string, rec: { id: string; tenantId: string; scopes: string[] }) { this.byHash.set(sha256Hex(raw), rec); return this; }
  async findActiveByHash(hash: string) { return this.byHash.get(hash) ?? null; }
  async touchLastUsed(): Promise<void> {}
}

const GERANT = cleApiDeTest('gerant');
const VOISIN = cleApiDeTest('voisin');
const AUTRE_DROIT = cleApiDeTest('autre-droit');

const ENVOI: EnvoiVue = {
  id: '7a3d9c10-2e4b-4f6a-b8c1-0d9e8f7a6b5c', evenementId: 'evt_0123456789abcdef0123456789abcdef', type: 'message.received', statut: 'echec',
  tentatives: 3, dernierCode: 500, derniereReponse: 'erreur', prochainEssaiLe: null, creeLe: '2026-10-09T10:00:00.000Z',
  livreLe: null, corps: '{"id":"evt_0123456789abcdef0123456789abcdef"}',
};

function monter(o: { limite?: number | null } = {}) {
  const adresses = new Map<string, AdresseVue & { tenantId: string; secretChiffre: string }>();
  const audit: Array<{ action: string; detail: unknown; acteur?: unknown }> = [];
  const appels: Array<{ quoi: string; tenantId: string }> = [];
  const sansSecret = ({ secretChiffre: _s, tenantId: _t, ...v }: AdresseVue & { tenantId: string; secretChiffre: string }): AdresseVue => v;
  const de = (t: string, id: string) => { const a = adresses.get(id); return a && a.tenantId === t ? a : undefined; };
  const gestion: DepsGestionEvenements = {
    adresses: {
      lister: async (t) => [...adresses.values()].filter((a) => a.tenantId === t).map(sansSecret),
      lire: async (t, id) => { const a = de(t, id); return a ? sansSecret(a) : null; },
      existe: async (t, id) => de(t, id) !== undefined,
      compterActives: async (t) => [...adresses.values()].filter((a) => a.tenantId === t && a.active).length,
      creer: async (t, a) => {
        const id = randomUUID();
        adresses.set(id, {
          id, tenantId: t, url: a.url, description: a.description, types: [...a.types], active: true, creeLe: '2026-10-09T09:00:00.000Z',
          ancienSecretJusqua: null, derniereLivraisonLe: null, enReessai: 0, echecs: 1, secretChiffre: a.secretChiffre,
        });
        return sansSecret(adresses.get(id)!);
      },
      modifier: async (t, id, m) => {
        const a = de(t, id);
        if (!a) return null;
        if (m.active !== undefined) a.active = m.active;
        if (m.types !== undefined) a.types = [...m.types];
        return sansSecret(a);
      },
      tourner: async (t, id, s) => { const a = de(t, id); if (!a) return false; a.secretChiffre = s; return true; },
      supprimer: async (t, id) => (de(t, id) ? adresses.delete(id) : false),
      pourEnvoi: async (t, id) => {
        const a = de(t, id);
        return a ? { url: a.url, active: a.active, rang: 1, secretChiffre: a.secretChiffre, secretPrecedentChiffre: null, secretPrecedentJusqua: null } : null;
      },
    },
    envois: {
      noterEssai: async () => {},
      journal: async (t, _id, p) => { appels.push({ quoi: `journal:${p.limite}:${p.avant?.toISOString() ?? '-'}`, tenantId: t }); return [ENVOI]; },
      rejouer: async (t, envoiId) => { appels.push({ quoi: 'rejouer', tenantId: t }); return envoiId === ENVOI.id && t === 't1' ? { tentative: 4 } : null; },
      rejouerEchecs: async (t, _id, depuis) => { appels.push({ quoi: `rejouerEchecs:${depuis.toISOString()}`, tenantId: t }); return [{ id: ENVOI.id, tentative: 4 }]; },
    },
    limiteAdresses: async () => (o.limite === undefined ? null : o.limite),
    chiffrementPret: true,
    chiffrer: (c) => `chiffre:${c}`,
    dechiffrer: (c) => c.replace(/^chiffre:/, ''),
    verifierAdresse: async () => ({ ok: true }),
    appeler: async () => ({ livre: true, definitif: false, code: 204, extrait: 'ok' }),
    enfiler: async () => {},
    invaliderCache: () => {},
  };
  const usage = new GardeUsageMemoire();
  const keys = new FakeApiKeys()
    .add(GERANT, { id: 'k1', tenantId: 't1', scopes: ['webhooks:write'] })
    .add(VOISIN, { id: 'k2', tenantId: 't2', scopes: ['webhooks:write'] })
    .add(AUTRE_DROIT, { id: 'k3', tenantId: 't1', scopes: ['sends:create', 'contacts:write', 'conversations:read', 'templates:write', 'mcp:write'] });
  const server = buildServer({
    queue: new FakeQueue(),
    usage,
    v1: {
      apiKeys: keys, oauth: aucunJetonOauth, contacts: contactsV1Muets(),
      // Comme `audit_log.actor_user_id` (uuid) : un acteur qui n'est pas un compte fait échouer l'écriture.
      webhooks: {
        gestion,
        audit: async (_t, acteur, action, _c, detail) => {
          if (acteur.userId !== null && !/^[0-9a-f-]{36}$/.test(acteur.userId)) throw new Error('22P02 : uuid invalide');
          audit.push({ action, detail, acteur });
        },
      },
    },
  });
  const appel = (methode: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, cle = GERANT, payload?: unknown) => server.inject({
    method: methode, url, headers: { authorization: `Bearer ${cle}`, ...(payload !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });
  const creer = async (cle = GERANT) => {
    const r = await appel('POST', '/v1/webhooks', cle, { url: 'https://app.client.fr/hook', types: ['message.received', 'template.status_changed'] });
    return r.json() as { webhook: { id: string }; secret: string };
  };
  return { server, appel, creer, audit, appels, usage };
}

describe('les webhooks sortants par l’API', () => {
  it('🔴 le droit webhooks:write est exigé, même pour lire : le journal porte des données de contacts', async () => {
    const { appel, server } = monter();
    const r = await appel('GET', '/v1/webhooks', AUTRE_DROIT);
    expect(r.statusCode).toBe(403);
    expect(r.json()).toMatchObject({ code: 'missing_scope' });
    await server.close();
  });

  it('🔴 créée : 201 avec le secret, une fois ; la liste et la lecture ne le rendent jamais ; l’audit dit « api »', async () => {
    const { appel, creer, audit, server } = monter();
    const { webhook, secret } = await creer();
    expect(secret).toMatch(/^whsec_/);
    const liste = await appel('GET', '/v1/webhooks');
    expect(liste.statusCode).toBe(200);
    expect(liste.body).not.toContain(secret.slice(6));
    expect(liste.json()).toMatchObject({
      data: [{ id: webhook.id, url: 'https://app.client.fr/hook', types: ['message.received', 'template.status_changed'], active: true, retrying: 0, failed: 1 }],
      limit: null, types: expect.arrayContaining(['template.status_changed']),
    });
    const une = await appel('GET', `/v1/webhooks/${webhook.id}`);
    expect(une.json()).toMatchObject({ id: webhook.id, createdAt: '2026-10-09T09:00:00.000Z', previousSecretValidUntil: null });
    // 🔴 L'écriture d'une clé arrive au journal : acteur vide (une clé n'est pas un compte), la clé dans le détail.
    expect(audit).toEqual([{ action: 'evenements.adresse_creee', detail: expect.objectContaining({ via: 'api', acces: 'k1' }), acteur: { userId: null, email: null } }]);
    await server.close();
  });

  it('🔴 une adresse d’un autre espace n’existe pas : lecture, modification, essai, journal, rotation et suppression rendent 404', async () => {
    const { appel, creer, server } = monter();
    const { webhook } = await creer();
    const id = webhook.id;
    for (const [m, url, corps] of [
      ['GET', `/v1/webhooks/${id}`], ['PATCH', `/v1/webhooks/${id}`, { active: false }], ['POST', `/v1/webhooks/${id}/test`],
      ['GET', `/v1/webhooks/${id}/deliveries`], ['POST', `/v1/webhooks/${id}/rotate-secret`], ['DELETE', `/v1/webhooks/${id}`],
      ['POST', `/v1/webhooks/${id}/replay-failures`, { since: '2026-10-09T00:00:00Z' }],
    ] as const) {
      const r = await appel(m, url, VOISIN, corps);
      expect([r.statusCode, r.json().code], `${m} ${url}`).toEqual([404, 'webhook_not_found']);
    }
    expect((await appel('GET', '/v1/webhooks', VOISIN)).json()).toMatchObject({ data: [] });
    await server.close();
  });

  it('pause, rotation, essai, suppression : traduits en anglais', async () => {
    const { appel, creer, server } = monter();
    const { webhook, secret } = await creer();
    expect((await appel('PATCH', `/v1/webhooks/${webhook.id}`, GERANT, { active: false })).json()).toMatchObject({ active: false });
    const tourne = (await appel('POST', `/v1/webhooks/${webhook.id}/rotate-secret`)).json() as { secret: string; previousSecretValidUntil: string };
    expect(tourne.secret).toMatch(/^whsec_/);
    expect(tourne.secret).not.toBe(secret);
    expect(Date.parse(tourne.previousSecretValidUntil)).toBeGreaterThan(Date.now());
    expect((await appel('POST', `/v1/webhooks/${webhook.id}/test`)).json()).toMatchObject({ delivered: true, statusCode: 204, response: 'ok', eventId: expect.stringMatching(/^evt_/) });
    expect((await appel('DELETE', `/v1/webhooks/${webhook.id}`)).statusCode).toBe(204);
    expect((await appel('GET', `/v1/webhooks/${webhook.id}`)).statusCode).toBe(404);
    await server.close();
  });

  it('les refus : saisie (400), limite de l’offre (402 avec son corps), adresse http refusée', async () => {
    const { appel, server } = monter({ limite: 0 });
    const http = await appel('POST', '/v1/webhooks', GERANT, { url: 'http://app.client.fr/hook' });
    expect([http.statusCode, http.json().code]).toEqual([400, 'invalid_body']);
    expect((await appel('POST', '/v1/webhooks', GERANT, { url: 'https://app.client.fr/hook', inconnu: 1 })).statusCode).toBe(400);
    const plein = await appel('POST', '/v1/webhooks', GERANT, { url: 'https://app.client.fr/hook' });
    expect(plein.statusCode).toBe(402);
    expect(plein.json()).toMatchObject({ code: 'plan_limit_reached', max: 0, upgradeUrl: expect.any(String) });
    await server.close();
  });

  it('🔴 le journal : traduit, paginé par before, borné ; le rejeu d’un envoi et des échecs', async () => {
    const { appel, creer, appels, server } = monter();
    const { webhook } = await creer();
    const j = await appel('GET', `/v1/webhooks/${webhook.id}/deliveries?limit=1&before=2026-10-09T11:00:00Z`);
    expect(j.json()).toEqual({
      data: [{
        id: ENVOI.id, eventId: ENVOI.evenementId, type: 'message.received', status: 'failed', attempts: 3, lastStatusCode: 500,
        lastResponse: 'erreur', nextAttemptAt: null, createdAt: ENVOI.creeLe, deliveredAt: null, body: ENVOI.corps,
      }],
      nextBefore: ENVOI.creeLe,
    });
    expect(appels).toContainEqual({ quoi: 'journal:1:2026-10-09T11:00:00.000Z', tenantId: 't1' });
    expect((await appel('GET', `/v1/webhooks/${webhook.id}/deliveries?limit=500`)).json()).toMatchObject({ code: 'invalid_body' });
    expect((await appel('GET', `/v1/webhooks/${webhook.id}/deliveries?before=hier`)).statusCode).toBe(400);

    expect((await appel('POST', `/v1/webhooks/deliveries/${ENVOI.id}/replay`)).json()).toEqual({ replayed: true });
    const ailleurs = await appel('POST', `/v1/webhooks/deliveries/${ENVOI.id}/replay`, VOISIN);
    expect([ailleurs.statusCode, ailleurs.json().code]).toEqual([409, 'delivery_not_replayable']);
    expect((await appel('POST', '/v1/webhooks/deliveries/pas-un-uuid/replay')).json()).toMatchObject({ code: 'delivery_not_found' });

    const echecs = await appel('POST', `/v1/webhooks/${webhook.id}/replay-failures`, GERANT, { since: '2026-10-09T00:00:00Z' });
    expect([echecs.statusCode, echecs.json()]).toEqual([202, { replayed: 1 }]);
    expect((await appel('POST', `/v1/webhooks/${webhook.id}/replay-failures`, GERANT, { depuis: '2026-10-09T00:00:00Z' })).statusCode).toBe(400);
    await server.close();
  });

  it('chaque appel est compté à l’usage, en lecture ou en écriture, hors quota du jour', async () => {
    const { appel, creer, usage, server } = monter();
    await creer();
    await appel('GET', '/v1/webhooks');
    const c = await usage.compteurs();
    expect(c.find((x) => x.operation === 'webhooks.write')).toMatchObject({ appels: 1 });
    expect(c.find((x) => x.operation === 'webhooks.read')).toMatchObject({ appels: 1 });
    await server.close();
  });
});
