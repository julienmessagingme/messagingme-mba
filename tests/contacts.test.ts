import { describe, it, expect, beforeAll } from 'vitest';
import { buildServer } from '../src/server';
import { FakeQueue } from '../src/queue/fake';
import { signSession } from '../src/auth/token';
import type { UserAuthStore, AuthUser } from '../src/auth/store';
import type { ContactsRouteDeps } from '../src/http/contacts';
import type { ContactRow } from '../src/crm/contact-store.pg';
import type { UserFieldDef } from '../src/crm/types';

const SECRET = 'test-secret';
let adminTok = '';
let agentTok = '';
beforeAll(async () => {
  adminTok = await signSession({ userId: 'u1', tenantId: 't1', role: 'admin' }, SECRET);
  agentTok = await signSession({ userId: 'u2', tenantId: 't1', role: 'agent' }, SECRET);
});
const noUsers: UserAuthStore = { findByEmail: async (): Promise<AuthUser | null> => null };
const h = (t: string) => ({ headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` } });

const CONTACT: ContactRow = {
  id: 'c1', phoneE164: '+33611', bsuid: null, profileName: 'Marc', optInStatus: 'opted_in',
  fields: { prenom: 'Marc' }, tags: ['vip'], createdAt: '2026-07-10T00:00:00.000Z',
};
const FIELDS: UserFieldDef[] = [
  { key: 'prenom', label: 'Prénom', type: 'text' },
  { key: 'age', label: 'Âge', type: 'number' },
  { key: 'date_rdv', label: 'Date RDV', type: 'date' },
];

interface Cap { merged: Array<Record<string, string>>; added: string[][]; removed: string[][]; removedFields: string[][]; names: Array<string | null> }

function app(over: Partial<ContactsRouteDeps> = {}, opts: { contact?: ContactRow | null } = {}) {
  const cap: Cap = { merged: [], added: [], removed: [], removedFields: [], names: [] };
  const deps: ContactsRouteDeps = {
    applyEdits: async (_t, _id, edits) => {
      const result = opts.contact === undefined ? CONTACT : opts.contact;
      if (result === null) return null; // contact inconnu -> transaction rollback, aucune écriture
      if (Object.keys(edits.fields).length) cap.merged.push(edits.fields);
      if (edits.addTags.length) cap.added.push(edits.addTags);
      if (edits.removeTags.length) cap.removed.push(edits.removeTags);
      if (edits.removeFields && edits.removeFields.length) cap.removedFields.push(edits.removeFields);
      if (edits.profileName !== undefined) cap.names.push(edits.profileName);
      return result;
    },
    listUserFields: async () => FIELDS,
    ...over,
  };
  return { server: buildServer({ queue: new FakeQueue(), auth: { users: noUsers, secret: SECRET }, contacts: deps }), cap };
}

describe('routes contacts — édition fiche', () => {
  it('PATCH champ connu + valeur valide -> 200, mergeFields appelé, renvoie le contact', async () => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'PATCH', url: '/tenants/t1/contacts/c1', ...h(adminTok), payload: { fields: { age: '42' } } });
    expect(res.statusCode).toBe(200);
    expect(cap.merged).toEqual([{ age: '42' }]);
    expect(res.json<{ contact: { id: string } }>().contact.id).toBe('c1');
    await server.close();
  });

  it('PATCH champ INCONNU -> 400', async () => {
    const { server } = app();
    const res = await server.inject({ method: 'PATCH', url: '/tenants/t1/contacts/c1', ...h(adminTok), payload: { fields: { inexistant: 'x' } } });
    expect(res.statusCode).toBe(400);
    await server.close();
  });

  it('PATCH valeur invalide pour le type (age=abc) -> 400', async () => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'PATCH', url: '/tenants/t1/contacts/c1', ...h(adminTok), payload: { fields: { age: 'abc' } } });
    expect(res.statusCode).toBe(400);
    expect(cap.merged).toHaveLength(0); // rien écrit
    await server.close();
  });

  it('PATCH date mal formée -> 400', async () => {
    const { server } = app();
    const res = await server.inject({ method: 'PATCH', url: '/tenants/t1/contacts/c1', ...h(adminTok), payload: { fields: { date_rdv: '01/08/2026' } } });
    expect(res.statusCode).toBe(400);
    await server.close();
  });

  it('PATCH addTags + removeTags -> 200, les deux appelés', async () => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'PATCH', url: '/tenants/t1/contacts/c1', ...h(adminTok), payload: { addTags: ['prospect'], removeTags: ['vip'] } });
    expect(res.statusCode).toBe(200);
    expect(cap.added).toEqual([['prospect']]);
    expect(cap.removed).toEqual([['vip']]);
    await server.close();
  });

  it('PATCH vide (rien à modifier) -> 400', async () => {
    const { server } = app();
    const res = await server.inject({ method: 'PATCH', url: '/tenants/t1/contacts/c1', ...h(adminTok), payload: {} });
    expect(res.statusCode).toBe(400);
    await server.close();
  });

  it('PATCH removeFields (clé connue) -> 200, suppression transmise', async () => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'PATCH', url: '/tenants/t1/contacts/c1', ...h(adminTok), payload: { removeFields: ['prenom'] } });
    expect(res.statusCode).toBe(200);
    expect(cap.removedFields).toEqual([['prenom']]);
    await server.close();
  });

  it('PATCH removeFields accepte une clé SANS définition (champ orphelin, doit rester supprimable)', async () => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'PATCH', url: '/tenants/t1/contacts/c1', ...h(adminTok), payload: { removeFields: ['metier_orphelin'] } });
    expect(res.statusCode).toBe(200);
    expect(cap.removedFields).toEqual([['metier_orphelin']]);
    await server.close();
  });

  it('PATCH removeFields vide (que des espaces) -> 400 (rien à modifier)', async () => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'PATCH', url: '/tenants/t1/contacts/c1', ...h(adminTok), payload: { removeFields: ['  ', ''] } });
    expect(res.statusCode).toBe(400);
    expect(cap.removedFields).toHaveLength(0);
    await server.close();
  });

  it('PATCH profileName (Nom) -> 200, transmis', async () => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'PATCH', url: '/tenants/t1/contacts/c1', ...h(adminTok), payload: { profileName: 'Marc Dupont' } });
    expect(res.statusCode).toBe(200);
    expect(cap.names).toEqual(['Marc Dupont']);
    await server.close();
  });

  it('PATCH profileName vide -> null (on vide le Nom)', async () => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'PATCH', url: '/tenants/t1/contacts/c1', ...h(adminTok), payload: { profileName: '   ' } });
    expect(res.statusCode).toBe(200);
    expect(cap.names).toEqual([null]);
    await server.close();
  });

  it('PATCH mise à jour en place d\'un champ déjà rempli (prenom) -> 200, merge écrase', async () => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'PATCH', url: '/tenants/t1/contacts/c1', ...h(adminTok), payload: { fields: { prenom: 'Marco' } } });
    expect(res.statusCode).toBe(200);
    expect(cap.merged).toEqual([{ prenom: 'Marco' }]);
    await server.close();
  });

  it('PATCH contact hors tenant (getContact null) -> 404, aucune écriture', async () => {
    const { server, cap } = app({}, { contact: null });
    const res = await server.inject({ method: 'PATCH', url: '/tenants/t1/contacts/ghost', ...h(adminTok), payload: { fields: { age: '30' } } });
    expect(res.statusCode).toBe(404);
    expect(cap.merged).toHaveLength(0);
    await server.close();
  });

  it('PATCH tenant != token -> 403', async () => {
    const { server } = app();
    const res = await server.inject({ method: 'PATCH', url: '/tenants/AUTRE/contacts/c1', ...h(adminTok), payload: { addTags: ['x'] } });
    expect(res.statusCode).toBe(403);
    await server.close();
  });

  it('PATCH agent -> 403 (admin-only)', async () => {
    const { server } = app();
    const res = await server.inject({ method: 'PATCH', url: '/tenants/t1/contacts/c1', ...h(agentTok), payload: { addTags: ['x'] } });
    expect(res.statusCode).toBe(403);
    await server.close();
  });

  it('sans token -> 401', async () => {
    const { server } = app();
    const res = await server.inject({ method: 'PATCH', url: '/tenants/t1/contacts/c1', headers: { 'content-type': 'application/json' }, payload: { addTags: ['x'] } });
    expect(res.statusCode).toBe(401);
    await server.close();
  });
});
