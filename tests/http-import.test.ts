import { describe, it, expect, beforeAll } from 'vitest';
import { buildServer } from '../src/server';
import { FakeQueue } from '../src/queue/fake';
import { signSession } from '../src/auth/token';
import type { UserAuthStore, AuthUser } from '../src/auth/store';
import type { ContactStore, ContactUpsert } from '../src/crm/import';
import type { UserFieldStore } from '../src/crm/fields';
import type { UserFieldDef } from '../src/crm/types';

const SECRET = 'test-secret';
let token = '';
beforeAll(async () => {
  token = await signSession({ userId: 'u1', tenantId: 't1', role: 'admin' }, SECRET);
});
const noUsers: UserAuthStore = { findByEmail: async (): Promise<AuthUser | null> => null };
const auth = () => ({ headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` } });

class FakeContacts implements ContactStore {
  readonly upserts: ContactUpsert[] = [];
  async upsertByPhone(c: ContactUpsert): Promise<'created' | 'updated'> {
    this.upserts.push(c);
    return 'created';
  }
}
class FakeFields implements UserFieldStore {
  readonly defs: UserFieldDef[] = [];
  async list(): Promise<UserFieldDef[]> {
    return this.defs;
  }
  async upsert(_tenantId: string, def: UserFieldDef): Promise<void> {
    this.defs.push(def);
  }
}

function inject(contacts: ContactStore, userFields: UserFieldStore) {
  return buildServer({
    queue: new FakeQueue(),
    auth: { users: noUsers, secret: SECRET },
    import: {
      contacts,
      userFields,
      listContacts: async () => [
        { id: 'c1', phoneE164: '+33611111111', profileName: 'Julie', optInStatus: 'opted_in', fields: { ville: 'Lyon' }, tags: ['salon-2026'], createdAt: '2026-07-05T00:00:00.000Z' },
      ],
    },
  });
}

describe('POST /tenants/:tenantId/contacts/import', () => {
  it('parse le CSV, reconnaît les colonnes, upsert les contacts opt-in', async () => {
    const contacts = new FakeContacts();
    const app = inject(contacts, new FakeFields());
    const res = await app.inject({
      method: 'POST',
      url: '/tenants/t1/contacts/import',
      ...auth(),
      payload: { csv: 'Nom,Téléphone,Ville\nJulie,+33611111111,Lyon\nMarc,0622222222,Paris', optIn: true },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ created: number; skipped: number }>();
    expect(body.created).toBe(2);
    expect(contacts.upserts).toHaveLength(2);
    expect(contacts.upserts[0]?.optInStatus).toBe('opted_in');
    expect(contacts.upserts[0]?.phoneE164).toBe('+33611111111');
    expect(contacts.upserts[1]?.phoneE164).toBe('+33622222222'); // normalisé FR
    expect(contacts.upserts[0]?.fields).toMatchObject({ ville: 'Lyon' }); // colonne custom
    await app.close();
  });

  it('POST /import/preview -> colonnes + mapping suggéré (sans écrire)', async () => {
    const contacts = new FakeContacts();
    const app = inject(contacts, new FakeFields());
    const res = await app.inject({
      method: 'POST',
      url: '/tenants/t1/contacts/import/preview',
      ...auth(),
      payload: { csv: 'Nom,Téléphone,Ville\nJulie,+33611111111,Lyon' },
    });
    expect(res.statusCode).toBe(200);
    const b = res.json<{ headers: string[]; rowCount: number; mapping: { columns: Record<string, { target: string }> } }>();
    expect(b.headers).toEqual(['Nom', 'Téléphone', 'Ville']);
    expect(b.rowCount).toBe(1);
    expect(b.mapping.columns['Téléphone']?.target).toBe('phone');
    expect(b.mapping.columns['Nom']?.target).toBe('name');
    expect(b.mapping.columns['Ville']?.target).toBe('custom');
    expect(contacts.upserts).toHaveLength(0); // aperçu = zéro écriture
    await app.close();
  });

  it('mapping explicite respecté (une colonne forcée en Ignorer)', async () => {
    const contacts = new FakeContacts();
    const app = inject(contacts, new FakeFields());
    const res = await app.inject({
      method: 'POST',
      url: '/tenants/t1/contacts/import',
      ...auth(),
      payload: {
        csv: 'A,B,C\nJulie,+33611111111,secret',
        optIn: true,
        mapping: { columns: { A: { target: 'name' }, B: { target: 'phone' }, C: { target: 'ignore' } } },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(contacts.upserts[0]?.profileName).toBe('Julie');
    expect(contacts.upserts[0]?.phoneE164).toBe('+33611111111');
    expect(contacts.upserts[0]?.fields).toEqual({}); // C ignorée
    await app.close();
  });

  it('sans token -> 401', async () => {
    const app = inject(new FakeContacts(), new FakeFields());
    const res = await app.inject({
      method: 'POST',
      url: '/tenants/t1/contacts/import',
      headers: { 'content-type': 'application/json' },
      payload: { csv: 'Tel\n+33611111111' },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('GET liste des contacts du tenant -> 200', async () => {
    const app = inject(new FakeContacts(), new FakeFields());
    const res = await app.inject({ method: 'GET', url: '/tenants/t1/contacts', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ contacts: Array<{ profileName: string }> }>();
    expect(body.contacts[0]?.profileName).toBe('Julie');
    await app.close();
  });

  it('GET contacts sans token -> 401', async () => {
    const app = inject(new FakeContacts(), new FakeFields());
    const res = await app.inject({ method: 'GET', url: '/tenants/t1/contacts' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('token d un autre tenant -> 403', async () => {
    const contacts = new FakeContacts();
    const app = inject(contacts, new FakeFields());
    const res = await app.inject({
      method: 'POST',
      url: '/tenants/AUTRE/contacts/import',
      ...auth(),
      payload: { csv: 'Tel\n+33611111111' },
    });
    expect(res.statusCode).toBe(403);
    expect(contacts.upserts).toHaveLength(0);
    await app.close();
  });

  it('csv absent -> 400', async () => {
    const app = inject(new FakeContacts(), new FakeFields());
    const res = await app.inject({ method: 'POST', url: '/tenants/t1/contacts/import', ...auth(), payload: {} });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('mapping malformé (sans columns) -> 400, pas de 500', async () => {
    const app = inject(new FakeContacts(), new FakeFields());
    const res = await app.inject({
      method: 'POST',
      url: '/tenants/t1/contacts/import',
      ...auth(),
      payload: { csv: 'Tel\n+33611111111', mapping: { foo: 'bar' } },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('sans optIn -> statut unknown', async () => {
    const contacts = new FakeContacts();
    const app = inject(contacts, new FakeFields());
    const res = await app.inject({
      method: 'POST',
      url: '/tenants/t1/contacts/import',
      ...auth(),
      payload: { csv: 'Téléphone\n+33611111111' },
    });
    expect(res.statusCode).toBe(200);
    expect(contacts.upserts[0]?.optInStatus).toBe('unknown');
    await app.close();
  });
});
