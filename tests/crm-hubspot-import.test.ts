import { describe, it, expect } from 'vitest';
import { fetchHubspotLists, importHubspotList, ReconsentRequiredError, HubspotServiceError } from '../src/crm/hubspot-import';
import { signRequest } from '../src/lib/signature';
import type { HttpTransport, HttpResponse } from '../src/meta/http';
import type { ContactStore, ContactUpsert } from '../src/crm/import';
import type { UserFieldStore } from '../src/crm/fields';
import type { UserFieldDef } from '../src/crm/types';

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
  async upsertByPhone(c: ContactUpsert): Promise<'created' | 'updated'> { this.upserts.push(c); return 'created'; }
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

describe('importHubspotList', () => {
  it('CONFORMITÉ : opt-in TOUJOURS unknown (jamais opted_in), même si la réponse tente un champ opt-in', async () => {
    // La réponse « piège » inclut un champ opt-in : importHubspotList ne le lit même pas.
    const t = new FakeTransport(() => ({ status: 200, json: { contacts: [{ phone: '+33612345678', name: 'Jean', optIn: true, opt_in_status: 'opted_in' }], truncated: false, skippedNoPhone: 0 } }));
    const contacts = new FakeContactStore();
    const out = await importHubspotList(connector(t), { contacts, userFields: new FakeFieldStore() }, 't1', 'L1', 'Ma liste');
    expect(contacts.upserts).toHaveLength(1);
    expect(contacts.upserts[0]!.optInStatus).toBe('unknown'); // JAMAIS opted_in
    expect(contacts.upserts[0]!.tags).toEqual(['HubSpot: Ma liste']); // tag de traçabilité
    expect(contacts.upserts[0]!.phoneE164).toBe('+33612345678');
    expect(out.report).toMatchObject({ created: 1, skipped: 0 });
    expect(out.tags).toEqual(['HubSpot: Ma liste']); // tag renvoyé = source de vérité pour le filtre front
    expect(t.posts[0]!.url).toBe('http://connector/service/lists/contacts');
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
