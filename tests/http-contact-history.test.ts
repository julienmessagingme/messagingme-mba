import { describe, it, expect, beforeAll } from 'vitest';
import { buildServer } from '../src/server';
import { FakeQueue } from '../src/queue/fake';
import { signSession } from '../src/auth/token';
import type { UserAuthStore, EmailIdentity } from '../src/auth/store';
import type { ContactsRouteDeps } from '../src/http/contacts';
import type { ContactHistory, ContactSend } from '../src/crm/contact-history.pg';

/**
 * Route d'historique d'un contact.
 *
 * L'invariant qui compte : le contact d'un AUTRE compte doit rendre 404, PAS deux listes vides. Un 200 avec
 * `{sends: [], conversations: []}` sur un identifiant qui ne nous appartient pas est une réponse rassurante
 * sur une ressource interdite : elle ne dit pas « accès refusé », elle dit « ce contact n'a rien fait », ce qui
 * est une information sur un contact d'autrui. C'est pour ça que le store charge le contact AVANT de lire
 * quoi que ce soit, et que la route distingue null (404) de listes vides (200).
 */
const SECRET = 'test-secret';
let adminTok = '';
let agentTok = '';
beforeAll(async () => {
  adminTok = await signSession({ userId: 'u1', tenantId: 't1', role: 'admin' }, SECRET);
  agentTok = await signSession({ userId: 'u2', tenantId: 't1', role: 'agent' }, SECRET);
});
const noUsers: UserAuthStore = { findIdentity: async (): Promise<EmailIdentity | null> => null };
const h = (tok: string) => ({ headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` } });

const FULL: ContactHistory = {
  sends: [{
    campaignId: 'camp-1', campaignName: 'Promo été', category: 'marketing',
    templateName: 'promo', templateLanguage: 'fr', workflowName: null,
    status: 'sent', sentAt: '2026-07-01T10:00:00.000Z', error: null,
    deliveryStatus: 'read', deliveryUpdatedAt: '2026-07-01T10:05:00.000Z', engage: true,
  }],
  conversations: [{
    conversationId: 'conv-1', waId: '33612345678',
    lastMessageAt: '2026-07-02T09:00:00.000Z', lastPreview: 'merci !',
    messagesCount: 4, analysisStatus: 'done',
    analysis: {
      sentiment: 'positive', intent: 'question', topic: 'livraison', resolved: true,
      handledBy: 'bot', exchangesCount: 4, actionSuggestion: 'none',
      analyzedAt: '2026-07-02T09:10:00.000Z',
    },
    analysisStale: false,
    inboxHref: '/inbox?c=conv-1',
  }],
};

/** `c1` appartient à t1 ; tout autre identifiant est inconnu (le store renvoie null). */
function app(
  history: (tenantId: string, contactId: string) => Promise<ContactHistory | null>,
  exportSends?: (tenantId: string, contactId: string) => Promise<ContactSend[] | null>,
  bilan?: ContactsRouteDeps['getBilanContact'],
) {
  const contacts: ContactsRouteDeps = {
    applyEdits: async () => null,
    applyEditsMany: async () => 0,
    listUserFields: async () => [],
    getContactHistory: history,
    listSendsForExport: exportSends ?? (async (_t, id) => (id === 'c1' ? FULL.sends : null)),
    ...(bilan ? { getBilanContact: bilan } : {}),
  };
  return buildServer({ queue: new FakeQueue(), auth: { users: noUsers, secret: SECRET }, contacts });
}
const known = async (_t: string, id: string) => (id === 'c1' ? FULL : null);

describe('GET /tenants/:t/contacts/:id/history', () => {
  it('contact connu -> 200 avec les envois ET les conversations', async () => {
    const a = app(known);
    const res = await a.inject({ method: 'GET', url: '/tenants/t1/contacts/c1/history', ...h(adminTok) });
    expect(res.statusCode).toBe(200);
    const body = res.json<ContactHistory>();
    expect(body.sends[0]).toMatchObject({ campaignName: 'Promo été', deliveryStatus: 'read' });
    expect(body.conversations[0]).toMatchObject({ conversationId: 'conv-1', inboxHref: '/inbox?c=conv-1' });
    await a.close();
  });

  it('contact SANS historique -> 200 avec deux listes vides (pas un 404)', async () => {
    // Un contact importé et jamais contacté existe : répondre 404 laisserait croire qu'il a disparu.
    const a = app(async () => ({ sends: [], conversations: [] }));
    const res = await a.inject({ method: 'GET', url: '/tenants/t1/contacts/c1/history', ...h(adminTok) });
    expect(res.statusCode).toBe(200);
    expect(res.json<ContactHistory>()).toEqual({ sends: [], conversations: [] });
    await a.close();
  });

  it('contact inconnu du compte -> 404, jamais des listes vides', async () => {
    const a = app(known);
    const res = await a.inject({ method: 'GET', url: '/tenants/t1/contacts/AUTRUI/history', ...h(adminTok) });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: string }>().error).toBe('contact inconnu');
    await a.close();
  });

  it('le tenant transmis au store est celui du JETON, pas celui de l’URL', async () => {
    // Le scope vient du JWT : une URL forgée ne doit pas pouvoir désigner un autre compte.
    const seen: string[] = [];
    const a = app(async (tenant) => { seen.push(tenant); return { sends: [], conversations: [] }; });
    await a.inject({ method: 'GET', url: '/tenants/t1/contacts/c1/history', ...h(adminTok) });
    expect(seen).toEqual(['t1']);
    await a.close();
  });

  it('tenant de l’URL != tenant du jeton -> 403 sans toucher au store', async () => {
    let called = false;
    const a = app(async () => { called = true; return null; });
    const res = await a.inject({ method: 'GET', url: '/tenants/AUTRE/contacts/c1/history', ...h(adminTok) });
    expect(res.statusCode).toBe(403);
    expect(called).toBe(false);
    await a.close();
  });

  it('agent -> 403 (les routes contacts sont admin-only)', async () => {
    const a = app(known);
    const res = await a.inject({ method: 'GET', url: '/tenants/t1/contacts/c1/history', ...h(agentTok) });
    expect(res.statusCode).toBe(403);
    await a.close();
  });

  it('sans jeton -> 401', async () => {
    const a = app(known);
    const res = await a.inject({ method: 'GET', url: '/tenants/t1/contacts/c1/history' });
    expect(res.statusCode).toBe(401);
    await a.close();
  });
});

describe('GET /tenants/:t/contacts/:id/history/export (F5)', () => {
  it('contact connu -> 200 { sends: [...] } (les envois non capés)', async () => {
    const a = app(known);
    const res = await a.inject({ method: 'GET', url: '/tenants/t1/contacts/c1/history/export', ...h(adminTok) });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ sends: ContactSend[] }>().sends[0]).toMatchObject({ campaignName: 'Promo été' });
    await a.close();
  });

  it('contact inconnu -> 404', async () => {
    const a = app(known);
    const res = await a.inject({ method: 'GET', url: '/tenants/t1/contacts/AUTRUI/history/export', ...h(adminTok) });
    expect(res.statusCode).toBe(404);
    await a.close();
  });

  it('tenant de l\'URL != jeton -> 403 sans toucher au store', async () => {
    let called = false;
    const a = app(known, async () => { called = true; return null; });
    const res = await a.inject({ method: 'GET', url: '/tenants/AUTRE/contacts/c1/history/export', ...h(adminTok) });
    expect(res.statusCode).toBe(403);
    expect(called).toBe(false);
    await a.close();
  });

  it('agent -> 403 (admin-only)', async () => {
    const a = app(known);
    const res = await a.inject({ method: 'GET', url: '/tenants/t1/contacts/c1/history/export', ...h(agentTok) });
    expect(res.statusCode).toBe(403);
    await a.close();
  });
});

// Pas de test de non-collision avec `/contacts/count` et `/contacts/ids` : ces routes sont montées par
// `registerImport`, dans un autre routeur, qu'un serveur de test câblé sur les seules deps `contacts` ne monte
// pas. Le risque a été écarté PAR CONCEPTION (le segment `/history` au lieu d'un `/contacts/:contactId` nu),
// pas par une assertion, et un test qui ne monte qu'un des deux routeurs ne prouverait rien.

/**
 * LE BILAN D'UN CONTACT (2026-09-11) : ce qu'il a coûté, et jusqu'où il est allé.
 *
 * ⚠️ ROUTE À PART DE `/history`, et ces cas disent pourquoi : elle appelle META pour les tarifs, donc elle
 * est plus lente et elle peut manquer là où l'historique est servi. Les fondre ferait dépendre l'ouverture
 * d'une fiche contact d'un aller-retour réseau chez Meta.
 */
describe('GET /tenants/:t/contacts/:id/bilan', () => {
  const BILAN = {
    cout: { envoyes: 5, cout: 0.34, nonChiffrables: 0, sansCategorie: 0, sansTarif: 0, currency: 'EUR' },
    entonnoir: [{ niveau: 1, parcours: 3 }, { niveau: 2, parcours: 1 }],
  };

  it('contact connu -> 200 avec le coût ET l’entonnoir', async () => {
    const a = app(known, undefined, async (_t, id) => (id === 'c1' ? BILAN : null));
    const res = await a.inject({ method: 'GET', url: '/tenants/t1/contacts/c1/bilan', ...h(adminTok) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(BILAN);
    await a.close();
  });

  it('🔴 contact d’un AUTRE compte -> 404, même invariant que l’historique', async () => {
    // Un 200 avec un coût à zéro sur un identifiant qui ne nous appartient pas serait une information sur
    // le contact d'autrui : « il ne leur a rien coûté » est une information.
    const a = app(known, undefined, async (_t, id) => (id === 'c1' ? BILAN : null));
    const res = await a.inject({ method: 'GET', url: '/tenants/t1/contacts/AUTRUI/bilan', ...h(adminTok) });
    expect(res.statusCode).toBe(404);
    await a.close();
  });

  it('câblage absent -> 503, et l’historique continue de répondre', async () => {
    // C'est tout l'intérêt des deux routes : une instance sans jeton Meta ne peut pas chiffrer, et la fiche
    // contact doit quand même s'ouvrir.
    const a = app(known);
    expect((await a.inject({ method: 'GET', url: '/tenants/t1/contacts/c1/bilan', ...h(adminTok) })).statusCode).toBe(503);
    expect((await a.inject({ method: 'GET', url: '/tenants/t1/contacts/c1/history', ...h(adminTok) })).statusCode).toBe(200);
    await a.close();
  });

  it('tenant croisé -> 403', async () => {
    const a = app(known, undefined, async () => BILAN);
    expect((await a.inject({ method: 'GET', url: '/tenants/AUTRE/contacts/c1/bilan', ...h(adminTok) })).statusCode).toBe(403);
    await a.close();
  });

  it('agent -> 403, comme tout le mini-CRM', async () => {
    // ⚠️ Vérifié plutôt que supposé : les routes contacts sont admin-only, et une route neuve qui s'en
    // écarterait ouvrirait le coût de chaque contact aux opérateurs sans que personne l'ait décidé.
    const a = app(known, undefined, async () => BILAN);
    expect((await a.inject({ method: 'GET', url: '/tenants/t1/contacts/c1/bilan', ...h(agentTok) })).statusCode).toBe(403);
    await a.close();
  });
});
