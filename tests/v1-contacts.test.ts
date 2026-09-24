// tests/v1-contacts.test.ts
import { describe, it, expect } from 'vitest';
import { buildServer } from '../src/server';
import { FakeQueue } from '../src/queue/fake';
import { sha256Hex } from '../src/lib/signature';
import type { ApiKeyLookup } from '../src/auth/api-key-store.pg';
import type { ContactV1, FicheApi, ServiceContactsV1 } from '../src/api/contacts-v1';
import { contactsV1Muets } from './aide/contacts-v1';
import { cleApiDeTest } from './aide/cle-api';

/** Fake du lookup de clé : mappe des clés claires -> {tenantId, scopes} via leur hash sha256. */
class FakeApiKeys implements ApiKeyLookup {
  private readonly byHash = new Map<string, { id: string; tenantId: string; scopes: string[] }>();
  touched: string[] = [];
  add(raw: string, rec: { id: string; tenantId: string; scopes: string[] }) { this.byHash.set(sha256Hex(raw), rec); return this; }
  async findActiveByHash(hash: string) { return this.byHash.get(hash) ?? null; }
  async touchLastUsed(id: string) { this.touched.push(id); }
}

const ECRITURE = cleApiDeTest('valide');
const LECTURE = cleApiDeTest('lecture');
const NOSCOPE = cleApiDeTest('sans_scope');
const ID = '00000000-0000-4000-8000-000000000001';

const FICHE: FicheApi = {
  contactId: ID, externalId: 'crm-7781', phone: '+33612345678', bsuid: null, name: 'Camille Roy',
  fields: { ville: 'Lyon' }, tags: ['prospect'], consent: { status: 'opted_in', source: 'formulaire-site', optedOutAt: null },
  rcsOptedOutAt: null, blocked: false, reachability: { whatsapp: true, rcs: null }, createdAt: '2026-09-24T10:00:00.000Z',
};

function app(over: Partial<ServiceContactsV1> = {}) {
  const cap = { ecrits: [] as Array<{ tenant: string; items: ContactV1[] }>, lus: [] as Array<{ tenant: string; id: string }> };
  const keys = new FakeApiKeys()
    .add(ECRITURE, { id: 'k1', tenantId: 't1', scopes: ['contacts:write', 'sends:create'] })
    .add(LECTURE, { id: 'k3', tenantId: 't1', scopes: ['contacts:read'] })
    .add(NOSCOPE, { id: 'k2', tenantId: 't1', scopes: ['sends:create'] });
  const contacts = contactsV1Muets({
    ecrireFiches: async (tenant, items) => { cap.ecrits.push({ tenant, items }); return items.map((_, i) => ({ index: i, status: 'created' as const, contactId: `c${i}` })); },
    lireFiche: async (tenant, id) => { cap.lus.push({ tenant, id }); return id === ID ? FICHE : null; },
    ...over,
  });
  return { server: buildServer({ queue: new FakeQueue(), v1: { apiKeys: keys, contacts } }), cap, keys };
}
const auth = (key: string) => ({ headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` } });

describe('POST /v1/contacts', () => {
  it('clé valide + droit : 200, espace issu de la clé, touchLastUsed', async () => {
    const { server, cap, keys } = app();
    const res = await server.inject({ method: 'POST', url: '/v1/contacts', ...auth(ECRITURE), payload: { phone: '+33612345678', externalId: 'crm-7781', name: 'Marc' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ contactId: 'c0', status: 'created' });
    // L'espace vient de la clé, jamais du corps.
    expect(cap.ecrits[0]!.tenant).toBe('t1');
    expect(cap.ecrits[0]!.items[0]).toMatchObject({ phone: '+33612345678', externalId: 'crm-7781' });
    expect(keys.touched).toEqual(['k1']);
    await server.close();
  });

  it('🔴 sans clé, préfixe étranger ou clé inconnue : 401 `unauthorized` ; droit d’écriture manquant : 403 `missing_scope`, même avec le droit de lecture', async () => {
    const { server } = app();
    const sans = await server.inject({ method: 'POST', url: '/v1/contacts', headers: { 'content-type': 'application/json' }, payload: { phone: '+33612345678' } });
    expect(sans.statusCode).toBe(401);
    expect(sans.json()).toMatchObject({ code: 'unauthorized' });
    // Les deux cas d'origine de ce fichier, GARDÉS (réécrire un test conserve ses cas) : une clé qui n'a pas
    // le préfixe des nôtres, et une clé au bon format que personne n'a émise.
    for (const cle of ['jwt_or_whatever', cleApiDeTest('inconnue')]) {
      const res = await server.inject({ method: 'POST', url: '/v1/contacts', ...auth(cle), payload: { phone: '+33612345678' } });
      expect(res.statusCode, cle).toBe(401);
      expect(res.json()).toMatchObject({ code: 'unauthorized' });
    }
    for (const cle of [NOSCOPE, LECTURE]) {
      const res = await server.inject({ method: 'POST', url: '/v1/contacts', ...auth(cle), payload: { phone: '+33612345678' } });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ code: 'missing_scope' });
    }
    await server.close();
  });

  it('corps mal formé : 400 `invalid_body` qui nomme le champ ; en-têtes x-ratelimit-* posés', async () => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'POST', url: '/v1/contacts', ...auth(ECRITURE), payload: { phone: '+33612345678', consent: 'oui' } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'invalid_body' });
    expect(res.json<{ error: string }>().error).toMatch(/consent/);
    expect(res.headers['x-ratelimit-limit']).toBeDefined();
    expect(res.headers['x-ratelimit-remaining']).toBeDefined();
    expect(cap.ecrits).toHaveLength(0);
    await server.close();
  });

  it('🔴 un refus du service sort avec SON code et le statut de la table', async () => {
    const cas = [
      { code: 'invalid_recipient', statut: 400 },
      // Le cas d'origine « téléphone invalide côté service -> 400 », gardé, avec son code désormais.
      { code: 'invalid_phone', statut: 400 },
      { code: 'unknown_contact', statut: 404 },
      { code: 'identity_conflict', statut: 409 },
    ] as const;
    for (const c of cas) {
      const { server } = app({ ecrireFiches: async () => [{ index: 0, status: 'error', code: c.code, reason: 'motif' }] });
      const res = await server.inject({ method: 'POST', url: '/v1/contacts', ...auth(ECRITURE), payload: { externalId: 'crm-7781' } });
      expect(res.statusCode, c.code).toBe(c.statut);
      expect(res.json()).toEqual({ error: 'motif', code: c.code });
      await server.close();
    }
  });
});

describe('POST /v1/contacts/batch', () => {
  it('lot : 200 avec compteurs, un résultat par index', async () => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'POST', url: '/v1/contacts/batch', ...auth(ECRITURE), payload: { contacts: [{ phone: '+33611' }, { externalId: 'crm-1' }] } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ created: 2, updated: 0, errors: 0 });
    expect(cap.ecrits[0]!.items).toHaveLength(2);
    await server.close();
  });

  it('conteneur absent, vide, ou au-delà de 500 : 400 `invalid_body`', async () => {
    const { server } = app();
    for (const payload of [{}, { contacts: [] }, { contacts: 'x' }, { contacts: Array.from({ length: 501 }, () => ({ phone: '+33611' })) }]) {
      const res = await server.inject({ method: 'POST', url: '/v1/contacts/batch', ...auth(ECRITURE), payload });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: 'invalid_body' });
    }
    await server.close();
  });
});

describe('GET /v1/contacts/:contactId', () => {
  it('🔴 avec `contacts:read` : 200 et la fiche, espace issu de la clé', async () => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'GET', url: `/v1/contacts/${ID}`, ...auth(LECTURE) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(FICHE);
    expect(cap.lus).toEqual([{ tenant: 't1', id: ID }]);
    await server.close();
  });

  it('🔴 une clé qui ÉCRIT sans lire : 403 `missing_scope`', async () => {
    const { server } = app();
    const res = await server.inject({ method: 'GET', url: `/v1/contacts/${ID}`, ...auth(ECRITURE) });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'missing_scope' });
    await server.close();
  });

  it('fiche inconnue : 404 `unknown_contact`', async () => {
    const { server } = app();
    const res = await server.inject({ method: 'GET', url: '/v1/contacts/00000000-0000-4000-8000-999999999999', ...auth(LECTURE) });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'unknown_contact' });
    await server.close();
  });
});

describe('POST /v1/contacts/search', () => {
  it('🔴 le numéro voyage dans le CORPS ; la réponse est `{ contact }`', async () => {
    const vus: unknown[] = [];
    const { server } = app({ chercherFiche: async (_t, r) => { vus.push(r); return { ok: true, fiche: FICHE }; } });
    const res = await server.inject({ method: 'POST', url: '/v1/contacts/search', ...auth(LECTURE), payload: { phone: '+33612345678' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ contact: FICHE });
    expect(vus).toEqual([{ phone: '+33612345678' }]);
    await server.close();
  });

  it('deux clés ou aucune : 400 `invalid_body` ; numéro illisible : 400 `invalid_phone`', async () => {
    const { server } = app({ chercherFiche: async () => ({ ok: false, code: 'invalid_phone', reason: 'illisible' }) });
    for (const payload of [{ phone: '+33612345678', externalId: 'crm-7781' }, {}]) {
      const res = await server.inject({ method: 'POST', url: '/v1/contacts/search', ...auth(LECTURE), payload });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: 'invalid_body' });
    }
    const illisible = await server.inject({ method: 'POST', url: '/v1/contacts/search', ...auth(LECTURE), payload: { phone: 'n-importe-quoi' } });
    expect(illisible.statusCode).toBe(400);
    expect(illisible.json()).toEqual({ error: 'illisible', code: 'invalid_phone' });
    await server.close();
  });

  it('🔴 sans le droit `contacts:read` (une clé qui écrit, ou qui envoie) : 403 `missing_scope`, et rien n’est cherché', async () => {
    // La recherche rend un numéro, un consentement et une joignabilité : c'est une LECTURE de fiche, et elle
    // exige le même droit que `GET /v1/contacts/{contactId}`, jamais celui d'écrire.
    const vus: unknown[] = [];
    const { server } = app({ chercherFiche: async (_t, r) => { vus.push(r); return { ok: true, fiche: FICHE }; } });
    for (const cle of [ECRITURE, NOSCOPE]) {
      const res = await server.inject({ method: 'POST', url: '/v1/contacts/search', ...auth(cle), payload: { phone: '+33612345678' } });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ code: 'missing_scope' });
    }
    expect(vus).toEqual([]);
    await server.close();
  });
});

describe('PATCH /v1/contacts/:contactId', () => {
  it('200 `{ contactId }`', async () => {
    const { server } = app();
    const res = await server.inject({ method: 'PATCH', url: `/v1/contacts/${ID}`, ...auth(ECRITURE), payload: { consent: 'opted_out' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ contactId: ID });
    await server.close();
  });

  it('🔴 le numéro ne se modifie pas : 400 `invalid_body` qui le dit', async () => {
    const { server } = app();
    const res = await server.inject({ method: 'PATCH', url: `/v1/contacts/${ID}`, ...auth(ECRITURE), payload: { phone: '+33698765432' } });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string; code: string }>()).toMatchObject({ code: 'invalid_body' });
    expect(res.json<{ error: string }>().error).toMatch(/ne se modifie pas/);
    await server.close();
  });

  it('un refus du service : son code et son statut ; une clé de lecture seule : 403', async () => {
    const { server } = app({ modifierFiche: async () => ({ ok: false, code: 'identity_conflict', reason: 'déjà porté' }) });
    const conflit = await server.inject({ method: 'PATCH', url: `/v1/contacts/${ID}`, ...auth(ECRITURE), payload: { externalId: 'crm-2' } });
    expect(conflit.statusCode).toBe(409);
    expect(conflit.json()).toEqual({ error: 'déjà porté', code: 'identity_conflict' });
    const lecture = await server.inject({ method: 'PATCH', url: `/v1/contacts/${ID}`, ...auth(LECTURE), payload: { name: 'x' } });
    expect(lecture.statusCode).toBe(403);
    await server.close();
  });
});
