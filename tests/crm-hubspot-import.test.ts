import { describe, it, expect } from 'vitest';
import { fetchHubspotLists, importHubspotList, disconnectHubspot, flagContactUnreachable, ReconsentRequiredError, HubspotServiceError } from '../src/crm/hubspot-service';
import { signRequest } from '../src/lib/signature';
import type { HttpTransport, HttpResponse } from '../src/meta/http';
import type { ContactStore, ContactUpsert, LotContacts } from '../src/crm/import';
import type { UserFieldStore } from '../src/crm/fields';
import type { UserFieldDef } from '../src/crm/types';
import type { Pool } from 'pg';
import { PgContactStore } from '../src/crm/contact-store.pg';

const SECRET = 'svc-secret';

class FakeTransport implements HttpTransport {
  readonly posts: Array<{ url: string; body: unknown; headers: Record<string, string> }> = [];
  constructor(private readonly responder: (url: string, body: unknown) => HttpResponse) {}
  async post(url: string, body: unknown, headers: Record<string, string>): Promise<HttpResponse> {
    this.posts.push({ url, body, headers });
    return this.responder(url, body);
  }
}
class FakeContactStore implements ContactStore {
  readonly upserts: ContactUpsert[] = [];
  async upsertManyByPhone(lot: LotContacts): Promise<Array<'created' | 'updated'>> {
    // Le lot est re-deplie en upserts unitaires : c'est cette forme que les tests inspectent.
    for (const c of lot.contacts) {
      this.upserts.push({
        tenantId: lot.tenantId,
        phoneE164: c.phoneE164,
        profileName: c.profileName,
        fields: c.fields,
        optInStatus: lot.optInStatus,
        ...(lot.optInSource ? { optInSource: lot.optInSource } : {}),
        ...(lot.tags ? { tags: lot.tags } : {}),
      });
    }
    return lot.contacts.map(() => 'created');
  }
}
class FakeFieldStore implements UserFieldStore {
  readonly defs: UserFieldDef[] = [];
  async list(): Promise<UserFieldDef[]> { return this.defs; }
  async upsert(_t: string, d: UserFieldDef): Promise<void> { this.defs.push(d); }
}
const connector = (t: HttpTransport) => ({ baseUrl: 'http://connector', secret: SECRET, transport: t });

describe('fetchHubspotLists', () => {
  it('POST signé /service/lists -> renvoie les listes', async () => {
    const t = new FakeTransport(() => ({ status: 200, json: { lists: [{ listId: '1', name: 'Chauds', size: 3, processingType: 'DYNAMIC' }] } }));
    const lists = await fetchHubspotLists(connector(t), 't1', 'chaud');
    expect(lists).toEqual([{ listId: '1', name: 'Chauds', size: 3, processingType: 'DYNAMIC' }]);
    // signature du corps au format v1 + endpoint.
    expect(t.posts[0]!.url).toBe('http://connector/service/lists');
    const header = t.posts[0]!.headers['x-mm-service-signature'];
    const m = /^v1=(\d+)\.([0-9a-f]{16})\.([0-9a-f]{64})$/.exec(header ?? '');
    expect(m).not.toBeNull();
    const raw = JSON.stringify({ tenantId: 't1', query: 'chaud' });
    expect(header).toBe(signRequest(SECRET, { ts: Number(m![1]), nonce: m![2]!, method: 'POST', path: '/service/lists', body: raw }));
  });
  it('409 reconsent_required -> ReconsentRequiredError (porte reconsentUrl)', async () => {
    const t = new FakeTransport(() => ({ status: 409, json: { error: 'reconsent_required', reconsentUrl: 'https://hub/install?grant=lists' } }));
    await expect(fetchHubspotLists(connector(t), 't1')).rejects.toMatchObject({ name: 'ReconsentRequiredError', reconsentUrl: 'https://hub/install?grant=lists' });
  });
  it('404 tenant_not_connected -> HubspotServiceError (non rejouable)', async () => {
    const t = new FakeTransport(() => ({ status: 404, json: { error: 'tenant_not_connected' } }));
    await expect(fetchHubspotLists(connector(t), 't1')).rejects.toBeInstanceOf(HubspotServiceError);
  });
});

describe('disconnectHubspot', () => {
  it('POST signé /service/unlink -> {disconnected, revoked}', async () => {
    const t = new FakeTransport(() => ({ status: 200, json: { disconnected: true, revoked: true } }));
    const out = await disconnectHubspot(connector(t), 't1');
    expect(out).toEqual({ disconnected: true, revoked: true });
    expect(t.posts[0]!.url).toBe('http://connector/service/unlink');
    const header = t.posts[0]!.headers['x-mm-service-signature'];
    const m = /^v1=(\d+)\.([0-9a-f]{16})\.([0-9a-f]{64})$/.exec(header ?? '');
    expect(m).not.toBeNull();
    const raw = JSON.stringify({ tenantId: 't1' });
    expect(header).toBe(signRequest(SECRET, { ts: Number(m![1]), nonce: m![2]!, method: 'POST', path: '/service/unlink', body: raw }));
  });
  it('déjà délié ({disconnected:false}) -> SUCCÈS (pas une erreur), revoked false par défaut', async () => {
    const t = new FakeTransport(() => ({ status: 200, json: { disconnected: false } }));
    expect(await disconnectHubspot(connector(t), 't1')).toEqual({ disconnected: false, revoked: false });
  });
  it('échec terminal (404) -> HubspotServiceError (l\'appelant ne coupe pas en base)', async () => {
    const t = new FakeTransport(() => ({ status: 404, json: { error: 'boom' } }));
    await expect(disconnectHubspot(connector(t), 't1')).rejects.toBeInstanceOf(HubspotServiceError);
  });
});

describe('flagContactUnreachable', () => {
  it('POST signé /service/contact-flag {tenantId,e164,flag:unreachable} -> {flagged}', async () => {
    const t = new FakeTransport(() => ({ status: 200, json: { flagged: true } }));
    const out = await flagContactUnreachable(connector(t), 't1', '+33611');
    expect(out).toEqual({ flagged: true });
    expect(t.posts[0]!.url).toBe('http://connector/service/contact-flag');
    expect(t.posts[0]!.body).toEqual({ tenantId: 't1', e164: '+33611', flag: 'unreachable' });
  });
  it('portail non lié (404 tenant_not_connected) -> {flagged:false} SANS throw (rien à marquer)', async () => {
    const t = new FakeTransport(() => ({ status: 404, json: { error: 'tenant_not_connected' } }));
    expect(await flagContactUnreachable(connector(t), 't1', '+33611')).toEqual({ flagged: false });
  });
  it('autre échec terminal (409) -> lève HubspotServiceError', async () => {
    const t = new FakeTransport(() => ({ status: 409, json: { error: 'portal_disconnected' } }));
    await expect(flagContactUnreachable(connector(t), 't1', '+33611')).rejects.toBeInstanceOf(HubspotServiceError);
  });
});

describe('importHubspotList', () => {
  /**
   * ⚠️ CONTRAT INVERSÉ le 2026-08-15, sur décision explicite de Julien. Ce test exigeait l'inverse
   * (`unknown`, « JAMAIS opted_in »).
   *
   * Pourquoi : le consentement est géré DANS HubSpot, c'est lui qui en porte la preuve, et une liste qu'un
   * opérateur choisit pour une campagne est par construction une liste de gens à qui il a le droit d'écrire.
   * L'ancienne règle faisait re-décider mba à partir d'une donnée qu'il n'a pas, et `optInAllows` exigeant un
   * opt-in EXPLICITE pour le marketing, une campagne marketing sur liste HubSpot rendait ZÉRO destinataire,
   * en silence. La source est tracée (`hubspot_list`) pour pouvoir remonter à l'origine du consentement.
   */
  it('opt-in accordé, avec la LISTE HubSpot comme source tracée', async () => {
    const t = new FakeTransport(() => ({ status: 200, json: { contacts: [{ phone: '+33612345678', name: 'Jean' }], truncated: false, skippedNoPhone: 0 } }));
    const contacts = new FakeContactStore();
    const out = await importHubspotList(connector(t), { contacts, userFields: new FakeFieldStore() }, 't1', 'L1', 'Ma liste');
    expect(contacts.upserts).toHaveLength(1);
    expect(contacts.upserts[0]!.optInStatus).toBe('opted_in');
    expect(contacts.upserts[0]!.optInSource).toBe('hubspot_list'); // traçabilité : d'où vient le consentement
    expect(contacts.upserts[0]!.tags).toEqual(['HubSpot: Ma liste']); // tag de traçabilité
    expect(contacts.upserts[0]!.phoneE164).toBe('+33612345678');
    expect(out.report).toMatchObject({ created: 1, skipped: 0 });
    expect(out.tags).toEqual(['HubSpot: Ma liste']); // tag renvoyé = source de vérité pour le filtre front
    expect(t.posts[0]!.url).toBe('http://connector/service/lists/contacts');
  });
  /**
   * 🔴 L'OPT-IN ACCORDÉ NE LÈVE PAS UN STOP (2026-09-26). L'import demande `opted_in` (test du dessus), et c'est
   * la base qui refuse de réabonner quelqu'un qui a dit STOP : ce test suit la liste jusqu'au SQL envoyé par le
   * VRAI dépôt, sans quoi un faux dépôt dirait vert sur un import qui lève le STOP.
   */
  it('🔴 un contact qui a dit STOP le reste : le lot HubSpot ne peut pas lever un STOP', async () => {
    const t = new FakeTransport(() => ({ status: 200, json: { contacts: [{ phone: '+33612345678', name: 'Jean' }], truncated: false, skippedNoPhone: 0 } }));
    const appels: Array<{ sql: string; params: unknown[] }> = [];
    const pool = {
      query: async (sql: string, params: unknown[] = []) => { appels.push({ sql: sql.replace(/\s+/g, ' '), params }); return { rows: [], rowCount: 0 }; },
    } as unknown as Pool;
    await importHubspotList(connector(t), { contacts: new PgContactStore(pool), userFields: new FakeFieldStore() }, 't1', 'L1', 'Ma liste');
    const upsert = appels.find((a) => a.sql.includes('insert into contacts'))!;
    expect(upsert.sql).toMatch(/when excluded\.opt_in_status = 'opted_in' and \(contacts\.opt_in_status <> 'opted_out' or \$6::boolean\)/);
    expect(upsert.params[5]).toBe(false); // $6 : ce lot ne peut pas lever un STOP
  });
  it('remonte truncated + skippedNoPhone', async () => {
    const t = new FakeTransport(() => ({ status: 200, json: { contacts: [{ phone: '+33612345678', name: null }], truncated: true, skippedNoPhone: 7 } }));
    const out = await importHubspotList(connector(t), { contacts: new FakeContactStore(), userFields: new FakeFieldStore() }, 't1', 'L1', 'X');
    expect(out.truncated).toBe(true);
    expect(out.skippedNoPhone).toBe(7);
  });
  it('409 reconsent -> ReconsentRequiredError, aucun contact importé', async () => {
    const t = new FakeTransport(() => ({ status: 409, json: { error: 'reconsent_required', reconsentUrl: 'u' } }));
    const contacts = new FakeContactStore();
    await expect(importHubspotList(connector(t), { contacts, userFields: new FakeFieldStore() }, 't1', 'L1', 'X')).rejects.toBeInstanceOf(ReconsentRequiredError);
    expect(contacts.upserts).toHaveLength(0);
  });
});
