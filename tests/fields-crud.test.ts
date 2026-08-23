import { describe, it, expect, beforeAll } from 'vitest';
import { buildServer } from '../src/server';
import { FakeQueue } from '../src/queue/fake';
import { signSession } from '../src/auth/token';
import type { UserAuthStore, EmailIdentity } from '../src/auth/store';
import type { FieldsRouteDeps } from '../src/http/fields';
import type { UserFieldType } from '../src/crm/types';

const SECRET = 'test-secret';
let adminTok = '';
let agentTok = '';
beforeAll(async () => {
  adminTok = await signSession({ userId: 'u1', tenantId: 't1', role: 'admin' }, SECRET);
  agentTok = await signSession({ userId: 'u2', tenantId: 't1', role: 'agent' }, SECRET);
});
const noUsers: UserAuthStore = { findIdentity: async (): Promise<EmailIdentity | null> => null };
const h = (t: string) => ({ headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` } });

interface Cap { created: Array<{ key: string; label: string; type: UserFieldType }>; updated: Array<{ key: string; patch: { label?: string; type?: UserFieldType } }>; deleted: string[] }
function app(over: Partial<FieldsRouteDeps> = {}) {
  const cap: Cap = { created: [], updated: [], deleted: [] };
  const deps: FieldsRouteDeps = {
    listFields: async () => [{ key: 'ville', label: 'Ville', type: 'text' }],
    createField: async (_t, def) => { cap.created.push(def); return def.key === 'ville' ? 'exists' : 'created'; },
    updateField: async (_t, key, patch) => { cap.updated.push({ key, patch }); return key === 'ville'; },
    deleteField: async (_t, key) => { cap.deleted.push(key); return key === 'ville'; },
    ...over,
  };
  return { server: buildServer({ queue: new FakeQueue(), auth: { users: noUsers, secret: SECRET }, fields: deps }), cap };
}

describe('routes user-fields (CRUD)', () => {
  it('GET admin -> 200 + liste', async () => {
    const { server } = app();
    const res = await server.inject({ method: 'GET', url: '/tenants/t1/user-fields', ...h(adminTok) });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ fields: Array<{ key: string }> }>().fields[0]?.key).toBe('ville');
    await server.close();
  });

  it('GET agent -> 403', async () => {
    const { server } = app();
    const res = await server.inject({ method: 'GET', url: '/tenants/t1/user-fields', ...h(agentTok) });
    expect(res.statusCode).toBe(403);
    await server.close();
  });

  it('POST create field -> 201 (clé dérivée du libellé)', async () => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/user-fields', ...h(adminTok), payload: { label: 'Code postal', type: 'text' } });
    expect(res.statusCode).toBe(201);
    expect(res.json<{ key: string }>().key).toBe('code_postal'); // slug du libellé
    expect(cap.created[0]).toMatchObject({ key: 'code_postal', label: 'Code postal', type: 'text' });
    await server.close();
  });

  it('POST create field clé existante -> 409', async () => {
    const { server } = app();
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/user-fields', ...h(adminTok), payload: { label: 'Ville', type: 'text' } });
    expect(res.statusCode).toBe(409); // slug 'ville' déjà présent -> le mock renvoie 'exists'
    await server.close();
  });

  it('POST create field type invalide -> 400 ; agent -> 403', async () => {
    const { server } = app();
    const bad = await server.inject({ method: 'POST', url: '/tenants/t1/user-fields', ...h(adminTok), payload: { label: 'X', type: 'json' } });
    const agent = await server.inject({ method: 'POST', url: '/tenants/t1/user-fields', ...h(agentTok), payload: { label: 'X', type: 'text' } });
    expect(bad.statusCode).toBe(400);
    expect(agent.statusCode).toBe(403);
    await server.close();
  });

  it('PATCH label seul -> 200 (updateField appelé, la clé ne bouge pas)', async () => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'PATCH', url: '/tenants/t1/user-fields/ville', ...h(adminTok), payload: { label: 'Ville de résidence' } });
    expect(res.statusCode).toBe(200);
    expect(cap.updated).toEqual([{ key: 'ville', patch: { label: 'Ville de résidence' } }]);
    await server.close();
  });

  it('PATCH type invalide -> 400', async () => {
    const { server } = app();
    const res = await server.inject({ method: 'PATCH', url: '/tenants/t1/user-fields/ville', ...h(adminTok), payload: { type: 'json' } });
    expect(res.statusCode).toBe(400);
    await server.close();
  });

  it('PATCH sans label ni type -> 400', async () => {
    const { server } = app();
    const res = await server.inject({ method: 'PATCH', url: '/tenants/t1/user-fields/ville', ...h(adminTok), payload: {} });
    expect(res.statusCode).toBe(400);
    await server.close();
  });

  it('PATCH clé inconnue -> 404 (updateField renvoie false)', async () => {
    const { server } = app();
    const res = await server.inject({ method: 'PATCH', url: '/tenants/t1/user-fields/ghost', ...h(adminTok), payload: { label: 'X' } });
    expect(res.statusCode).toBe(404);
    await server.close();
  });

  it('DELETE admin -> 200 ; clé inconnue -> 404', async () => {
    const { server } = app();
    const ok = await server.inject({ method: 'DELETE', url: '/tenants/t1/user-fields/ville', ...h(adminTok) });
    const ko = await server.inject({ method: 'DELETE', url: '/tenants/t1/user-fields/ghost', ...h(adminTok) });
    expect(ok.statusCode).toBe(200);
    expect(ko.statusCode).toBe(404);
    await server.close();
  });

  it('POST dont le slug percute une clé système (« Prénom » -> prenom) -> 409, jamais créé', async () => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/user-fields', ...h(adminTok), payload: { label: 'Prénom', type: 'text' } });
    expect(res.statusCode).toBe(409);
    expect(cap.created).toHaveLength(0);
    await server.close();
  });

  it('PATCH/DELETE champ SYSTÈME (prenom) -> 403, jamais délégué au store', async () => {
    // Les champs de base (name/phone/bsuid/wa_id/prenom/email) sont non modifiables/supprimables.
    const { server, cap } = app();
    const p = await server.inject({ method: 'PATCH', url: '/tenants/t1/user-fields/prenom', ...h(adminTok), payload: { label: 'X' } });
    const d = await server.inject({ method: 'DELETE', url: '/tenants/t1/user-fields/email', ...h(adminTok) });
    expect(p.statusCode).toBe(403);
    expect(d.statusCode).toBe(403);
    expect(cap.updated).toHaveLength(0);
    expect(cap.deleted).toHaveLength(0);
    await server.close();
  });

  it('PATCH/DELETE agent -> 403', async () => {
    const { server, cap } = app();
    const p = await server.inject({ method: 'PATCH', url: '/tenants/t1/user-fields/ville', ...h(agentTok), payload: { label: 'X' } });
    const d = await server.inject({ method: 'DELETE', url: '/tenants/t1/user-fields/ville', ...h(agentTok) });
    expect(p.statusCode).toBe(403);
    expect(d.statusCode).toBe(403);
    expect(cap.updated).toHaveLength(0);
    expect(cap.deleted).toHaveLength(0);
    await server.close();
  });
});

/**
 * Le libellé d'un champ perso ne doit pas fantômiser un champ de BASE.
 *
 * Vécu à corriger : le garde-fou comparait le slug du libellé aux seules CLÉS, qui sont anglaises
 * (`name`, `phone`), alors que l'écran affiche des libellés FRANÇAIS. Un espace réel s'est retrouvé avec
 * deux « Nom » et deux « Téléphone » indiscernables dans tous les sélecteurs, dont un exemplaire qu'aucun
 * chemin d'écriture ne peut remplir.
 */
describe('routes user-fields : doublons d’un champ de base', () => {
  it('🔴 POST d’un libellé de base -> 409 et rien de créé', async () => {
    for (const label of ['Nom', 'Téléphone', 'nom', '  Nom  ', 'Name', 'Phone', 'Prénom', 'Email']) {
      const { server, cap } = app();
      const res = await server.inject({ method: 'POST', url: '/tenants/t1/user-fields', ...h(adminTok), payload: { label, type: 'text' } });
      expect(res.statusCode, label).toBe(409);
      expect(res.json<{ error: string }>().error, label).toMatch(/champ de base/);
      expect(cap.created, label).toHaveLength(0);
      await server.close();
    }
  });

  it('un libellé qui n’est PAS un champ de base passe toujours', async () => {
    // Le garde-fou ne doit pas devenir un filtre à tout : ces libellés-là sont légitimes.
    for (const label of ['Nom de la société', 'Téléphone du bureau', 'Date de livraison']) {
      const { server, cap } = app();
      const res = await server.inject({ method: 'POST', url: '/tenants/t1/user-fields', ...h(adminTok), payload: { label, type: 'text' } });
      expect(res.statusCode, label).toBe(201);
      expect(cap.created, label).toHaveLength(1);
      await server.close();
    }
  });

  it('🔴 RENOMMER un champ perso en « Nom » -> 409 (le doublon se crée aussi par cette porte)', async () => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'PATCH', url: '/tenants/t1/user-fields/ville', ...h(adminTok), payload: { label: 'Nom' } });
    expect(res.statusCode).toBe(409);
    expect(cap.updated).toHaveLength(0);
    await server.close();
  });

  it('renommer vers un libellé libre reste possible', async () => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'PATCH', url: '/tenants/t1/user-fields/ville', ...h(adminTok), payload: { label: 'Commune' } });
    expect(res.statusCode).toBe(200);
    expect(cap.updated[0]).toMatchObject({ key: 'ville', patch: { label: 'Commune' } });
    await server.close();
  });
});
