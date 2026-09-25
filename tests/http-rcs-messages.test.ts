import { describe, it, expect, beforeAll } from 'vitest';
import { buildServer } from '../src/server';
import { FakeQueue } from './fake-queue';
import { signSession } from '../src/auth/token';
import type { UserAuthStore, EmailIdentity } from '../src/auth/store';
import type { RcsMessage } from '../src/rcs/message-store.pg';
import type { RcsOutbound } from '../src/rcs/types';

const SECRET = 'test-secret';
let adminToken = '';
let agentToken = '';
beforeAll(async () => {
  adminToken = await signSession({ userId: 'u1', tenantId: 't1', role: 'admin' }, SECRET);
  agentToken = await signSession({ userId: 'u2', tenantId: 't1', role: 'agent' }, SECRET);
});
const noUsers: UserAuthStore = { findIdentity: async (): Promise<EmailIdentity | null> => null };
const asAdmin = () => ({ headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` } });
const asAgent = () => ({ headers: { 'content-type': 'application/json', authorization: `Bearer ${agentToken}` } });

/** Bibliothèque en mémoire, scopée tenant comme le store Postgres : c'est CE scope qu'on veut prouver. */
class FakeStore {
  readonly rows = new Map<string, { tenantId: string; msg: RcsMessage }>();
  private n = 0;
  async list(tenantId: string) {
    return [...this.rows.values()].filter((r) => r.tenantId === tenantId).map((r) => r.msg);
  }
  async create(tenantId: string, name: string, content: RcsOutbound) {
    this.n += 1;
    const msg: RcsMessage = { id: `m${this.n}`, name, content, createdAt: '', updatedAt: '' };
    this.rows.set(msg.id, { tenantId, msg });
    return msg;
  }
  async update(tenantId: string, id: string, name: string, content: RcsOutbound) {
    const r = this.rows.get(id);
    if (!r || r.tenantId !== tenantId) return false;
    r.msg = { ...r.msg, name, content };
    return true;
  }
  async remove(tenantId: string, id: string) {
    const r = this.rows.get(id);
    if (!r || r.tenantId !== tenantId) return false;
    this.rows.delete(id);
    return true;
  }
}

function appWith(store: FakeStore) {
  return buildServer({
    queue: new FakeQueue(),
    auth: { users: noUsers, secret: SECRET },
    rcsMessages: {
      list: (t) => store.list(t),
      create: (t, n, c) => store.create(t, n, c),
      update: (t, i, n, c) => store.update(t, i, n, c),
      remove: (t, i) => store.remove(t, i),
    },
  });
}

const TEXTE: RcsOutbound = {
  kind: 'text',
  text: 'Bonjour, votre offre est disponible.',
  suggestions: [{ kind: 'reply', text: 'En savoir plus', postbackData: 'plus' }],
};

describe('Bibliotheque de messages RCS', () => {
  it('cree un message avec ses reponses rapides et le relit', async () => {
    const store = new FakeStore();
    const app = appWith(store);
    const c = await app.inject({ method: 'POST', url: '/tenants/t1/rcs-messages', ...asAdmin(), payload: { name: 'Offre du jour', content: TEXTE } });
    expect(c.statusCode).toBe(201);

    const l = await app.inject({ method: 'GET', url: '/tenants/t1/rcs-messages', ...asAdmin() });
    expect(l.statusCode).toBe(200);
    expect(l.json().messages).toHaveLength(1);
    expect(l.json().messages[0]).toMatchObject({ name: 'Offre du jour', content: TEXTE });
  });

  it('REFUSE un contenu invalide au lieu de le stocker', async () => {
    const app = appWith(new FakeStore());
    for (const content of [
      { kind: 'text' },                                   // texte manquant
      { kind: 'video', url: 'https://x' },                 // type inconnu
      { kind: 'text', text: 'ok', suggestions: [{ kind: 'openUrl', text: 'Site', url: 'pas-une-url', postbackData: 'x' }] },
      { kind: 'carousel', cards: [{ title: 'seule' }] },    // un carrousel exige au moins 2 cartes
    ]) {
      const r = await app.inject({ method: 'POST', url: '/tenants/t1/rcs-messages', ...asAdmin(), payload: { name: 'X', content } });
      expect(r.statusCode).toBe(400);
      expect(r.json().error).toContain('content');
    }
  });

  it('REFUSE un nom vide', async () => {
    const app = appWith(new FakeStore());
    const r = await app.inject({ method: 'POST', url: '/tenants/t1/rcs-messages', ...asAdmin(), payload: { name: '  ', content: TEXTE } });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toContain('name');
  });

  it('un AGENT peut LIRE la bibliotheque mais pas y ecrire', async () => {
    const store = new FakeStore();
    await store.create('t1', 'deja la', TEXTE);
    const app = appWith(store);

    const lecture = await app.inject({ method: 'GET', url: '/tenants/t1/rcs-messages', ...asAgent() });
    expect(lecture.statusCode).toBe(200);
    expect(lecture.json().messages).toHaveLength(1);

    const ecriture = await app.inject({ method: 'POST', url: '/tenants/t1/rcs-messages', ...asAgent(), payload: { name: 'N', content: TEXTE } });
    expect(ecriture.statusCode).toBe(403);
  });

  it('ne voit ni ne modifie le message d un AUTRE workspace', async () => {
    const store = new FakeStore();
    const autre = await store.create('t2', 'chez le voisin', TEXTE);
    const app = appWith(store);

    const l = await app.inject({ method: 'GET', url: '/tenants/t1/rcs-messages', ...asAdmin() });
    expect(l.json().messages).toEqual([]);

    const u = await app.inject({ method: 'PATCH', url: `/tenants/t1/rcs-messages/${autre.id}`, ...asAdmin(), payload: { name: 'vole', content: TEXTE } });
    expect(u.statusCode).toBe(404);

    const d = await app.inject({ method: 'DELETE', url: `/tenants/t1/rcs-messages/${autre.id}`, ...asAdmin() });
    expect(d.statusCode).toBe(404);

    // Et le message du voisin est INTACT.
    expect((await store.list('t2'))[0]!.name).toBe('chez le voisin');
  });

  it('modifie et supprime un message du tenant', async () => {
    const store = new FakeStore();
    const m = await store.create('t1', 'avant', TEXTE);
    const app = appWith(store);

    const u = await app.inject({ method: 'PATCH', url: `/tenants/t1/rcs-messages/${m.id}`, ...asAdmin(), payload: { name: 'apres', content: TEXTE } });
    expect(u.statusCode).toBe(200);
    expect((await store.list('t1'))[0]!.name).toBe('apres');

    const d = await app.inject({ method: 'DELETE', url: `/tenants/t1/rcs-messages/${m.id}`, ...asAdmin() });
    expect(d.statusCode).toBe(200);
    expect(await store.list('t1')).toEqual([]);
  });
});
