import { describe, it, expect, beforeAll } from 'vitest';
import { buildServer } from '../src/server';
import { FakeQueue } from '../src/queue/fake';
import { signSession } from '../src/auth/token';
import type { UserAuthStore, EmailIdentity } from '../src/auth/store';
import type { InboxRouteDeps } from '../src/http/inbox';

const SECRET = 'test-secret';
let token = '';
beforeAll(async () => {
  token = await signSession({ userId: 'u1', tenantId: 't1', role: 'admin' }, SECRET);
});
const noUsers: UserAuthStore = { findIdentity: async (): Promise<EmailIdentity | null> => null };
const auth = () => ({ headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` } });

function app(over: Partial<InboxRouteDeps> = {}) {
  const deps: InboxRouteDeps = {
    listConversations: async () => [
      { id: 'c1', waId: '33611', profileName: 'Julie', lastPreview: 'Oui', lastMessageAt: '2026-07-06T00:00:00.000Z', controlOwner: 'app_workflow', unread: true, assignedTo: null, assignedToName: null },
    ],
    getConversationContext: async (id) => (id === 'c1' ? { waId: '33611', windowOpen: true, lastInboundAt: '2026-07-06T00:00:00.000Z' } : null),
    getMessages: async () => [
      { id: 'm1', direction: 'in', type: 'text', body: 'coucou', buttonPayload: null, createdAt: '2026-07-06T00:00:00.000Z' },
    ],
    recordOutbound: async () => {},
    getTenantPhoneNumberId: async () => 'pn1',
    sendReply: async () => 'wamid.OUT',
    sendTemplateMessage: async () => 'wamid.TPL',
    ...over,
  };
  return buildServer({ queue: new FakeQueue(), auth: { users: noUsers, secret: SECRET }, inbox: deps });
}

describe('inbox routes', () => {
  it('GET conversations -> liste', async () => {
    const a = app();
    const res = await a.inject({ method: 'GET', url: '/tenants/t1/conversations', ...auth() });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ conversations: Array<{ waId: string }> }>().conversations[0]?.waId).toBe('33611');
    await a.close();
  });

  it('GET messages d une conversation connue -> 200 + windowOpen', async () => {
    const a = app();
    const res = await a.inject({ method: 'GET', url: '/tenants/t1/conversations/c1/messages', ...auth() });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ waId: string; windowOpen: boolean; messages: Array<{ body: string }> }>();
    expect(body.waId).toBe('33611');
    expect(body.windowOpen).toBe(true);
    expect(body.messages[0]?.body).toBe('coucou');
    await a.close();
  });

  it('GET messages conversation inconnue -> 404', async () => {
    const a = app();
    const res = await a.inject({ method: 'GET', url: '/tenants/t1/conversations/nope/messages', ...auth() });
    expect(res.statusCode).toBe(404);
    await a.close();
  });

  it('POST reply (fenêtre ouverte) -> envoie et journalise (200)', async () => {
    let recorded: [string, string, string | null, string | undefined] | null = null;
    let sent: [string, string, string, string] | null = null;
    const a = app({
      recordOutbound: async (id, body, msgId, type) => { recorded = [id, body, msgId, type]; },
      sendReply: async (tenant, pn, to, text) => { sent = [tenant, pn, to, text]; return 'wamid.OUT'; },
    });
    const res = await a.inject({ method: 'POST', url: '/tenants/t1/conversations/c1/reply', ...auth(), payload: { text: 'Merci !' } });
    expect(res.statusCode).toBe(200);
    expect(sent).toEqual(['t1', 'pn1', '33611', 'Merci !']); // tenant passé en 1er (B1 : token par tenant)
    expect(recorded).toEqual(['c1', 'Merci !', 'wamid.OUT', 'text']);
    await a.close();
  });

  it('POST reply -> journalise l auteur (sender_user_id du JWT) en 7e position', async () => {
    let sender: string | null | undefined = 'UNSET';
    const a = app({
      recordOutbound: async (_id, _body, _msg, _type, _cat, _name, s) => { sender = s; },
    });
    const res = await a.inject({ method: 'POST', url: '/tenants/t1/conversations/c1/reply', ...auth(), payload: { text: 'Merci !' } });
    expect(res.statusCode).toBe(200);
    expect(sender).toBe('u1'); // userId du token
    await a.close();
  });

  it('GET messages -> expose senderName sur les bulles sortantes', async () => {
    const a = app({
      getMessages: async () => [
        { id: 'm2', direction: 'out', type: 'text', body: 'Bonjour', buttonPayload: null, createdAt: '2026-07-06T00:00:00.000Z', senderName: 'Julien' },
      ],
    });
    const res = await a.inject({ method: 'GET', url: '/tenants/t1/conversations/c1/messages', ...auth() });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ messages: Array<{ senderName?: string }> }>().messages[0]?.senderName).toBe('Julien');
    await a.close();
  });

  it('POST reply HORS fenêtre 24 h -> 422 (texte libre interdit)', async () => {
    const a = app({
      getConversationContext: async () => ({ waId: '33611', windowOpen: false, lastInboundAt: '2026-07-01T00:00:00.000Z' }),
    });
    const res = await a.inject({ method: 'POST', url: '/tenants/t1/conversations/c1/reply', ...auth(), payload: { text: 'coucou' } });
    expect(res.statusCode).toBe(422);
    expect(res.json<{ code: string }>().code).toBe('window_closed');
    await a.close();
  });

  it('POST send-template -> envoie le template (200), autorisé hors fenêtre', async () => {
    let sent: { tenant: string; pn: string; to: string; tpl: unknown } | null = null;
    let recordedType: string | undefined;
    const a = app({
      getConversationContext: async () => ({ waId: '33611', windowOpen: false, lastInboundAt: '2026-07-01T00:00:00.000Z' }),
      sendTemplateMessage: async (tenant, pn, to, tpl) => { sent = { tenant, pn, to, tpl }; return 'wamid.TPL'; },
      recordOutbound: async (_id, _body, _msg, type) => { recordedType = type; },
    });
    const res = await a.inject({
      method: 'POST',
      url: '/tenants/t1/conversations/c1/send-template',
      ...auth(),
      payload: { templateName: 'promo', language: 'fr', bodyParams: ['Julie'], headerMediaUrl: 'https://x.fr/v.mp4', headerFormat: 'VIDEO' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ messageId: string }>().messageId).toBe('wamid.TPL');
    expect(sent).toMatchObject({ tenant: 't1', pn: 'pn1', to: '33611', tpl: { name: 'promo', language: 'fr', bodyParams: ['Julie'], headerMediaUrl: 'https://x.fr/v.mp4', headerFormat: 'VIDEO' } });
    expect(recordedType).toBe('template');
    await a.close();
  });

  it('POST send-template -> persiste la catégorie normalisée en minuscule (le split dashboard)', async () => {
    let recorded: { type?: string; cat?: string | null; name?: string | null } = {};
    const a = app({
      getConversationContext: async () => ({ waId: '33611', windowOpen: false, lastInboundAt: '2026-07-01T00:00:00.000Z' }),
      recordOutbound: async (_id, _body, _msg, type, cat, name) => { recorded = { type, cat, name }; },
    });
    const res = await a.inject({
      method: 'POST',
      url: '/tenants/t1/conversations/c1/send-template',
      ...auth(),
      payload: { templateName: 'promo', language: 'fr', templateCategory: 'MARKETING' },
    });
    expect(res.statusCode).toBe(200);
    expect(recorded).toEqual({ type: 'template', cat: 'marketing', name: 'promo' });
    await a.close();
  });

  it('POST send-template -> catégorie absente ou invalide persiste null', async () => {
    const cats: Array<string | null> = [];
    const a = app({
      getConversationContext: async () => ({ waId: '33611', windowOpen: false, lastInboundAt: '2026-07-01T00:00:00.000Z' }),
      recordOutbound: async (_id, _body, _msg, _type, cat) => { cats.push(cat ?? null); },
    });
    // catégorie inconnue (ex. AUTHENTICATION / typo) -> null
    const r1 = await a.inject({
      method: 'POST', url: '/tenants/t1/conversations/c1/send-template', ...auth(),
      payload: { templateName: 'otp', language: 'fr', templateCategory: 'AUTHENTICATION' },
    });
    // catégorie absente -> null
    const r2 = await a.inject({
      method: 'POST', url: '/tenants/t1/conversations/c1/send-template', ...auth(),
      payload: { templateName: 'otp', language: 'fr' },
    });
    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
    expect(cats).toEqual([null, null]);
    await a.close();
  });

  it('POST send-template sans templateName -> 400', async () => {
    const a = app();
    const res = await a.inject({ method: 'POST', url: '/tenants/t1/conversations/c1/send-template', ...auth(), payload: { language: 'fr' } });
    expect(res.statusCode).toBe(400);
    await a.close();
  });

  it('POST reply texte vide -> 400', async () => {
    const a = app();
    const res = await a.inject({ method: 'POST', url: '/tenants/t1/conversations/c1/reply', ...auth(), payload: { text: '  ' } });
    expect(res.statusCode).toBe(400);
    await a.close();
  });

  it('POST reply conversation inconnue -> 404', async () => {
    const a = app();
    const res = await a.inject({ method: 'POST', url: '/tenants/t1/conversations/nope/reply', ...auth(), payload: { text: 'x' } });
    expect(res.statusCode).toBe(404);
    await a.close();
  });

  it('sans token -> 401', async () => {
    const a = app();
    const res = await a.inject({ method: 'GET', url: '/tenants/t1/conversations' });
    expect(res.statusCode).toBe(401);
    await a.close();
  });

  it('tenant != token -> 403', async () => {
    const a = app();
    const res = await a.inject({ method: 'GET', url: '/tenants/AUTRE/conversations', ...auth() });
    expect(res.statusCode).toBe(403);
    await a.close();
  });
});

/**
 * Prise de main par un opérateur.
 *
 * Ces deux tests ferment un trou signalé en revue : sans eux, supprimer l'appel `takeControl` des routes
 * (ou son câblage dans index.ts) laissait les 930 tests verts, et le bug d'origine revenait en silence,
 * un humain et un scénario écrivant au client en parallèle.
 */
describe('un opérateur qui écrit PREND le fil', () => {
  it('réponse texte -> takeControl appelé avec le tenant et le wa_id de la conversation', async () => {
    const pris: Array<[string, string]> = [];
    const a = app({ takeControl: async (tenant, waId) => { pris.push([tenant, waId]); } });
    const res = await a.inject({
      method: 'POST', url: '/tenants/t1/conversations/c1/reply', ...auth(),
      payload: { text: 'je regarde ça' },
    });
    expect(res.statusCode).toBe(200);
    expect(pris).toEqual([['t1', '33611']]);
    await a.close();
  });

  it('envoi de template à la main -> takeControl aussi (c’est le même acte d’opérateur)', async () => {
    const pris: Array<[string, string]> = [];
    const a = app({ takeControl: async (tenant, waId) => { pris.push([tenant, waId]); } });
    const res = await a.inject({
      method: 'POST', url: '/tenants/t1/conversations/c1/send-template', ...auth(),
      payload: { templateName: 'relance', language: 'fr' },
    });
    expect(res.statusCode).toBe(200);
    expect(pris).toEqual([['t1', '33611']]);
    await a.close();
  });

  it('un échec de prise de main ne fait pas échouer l’envoi (best-effort)', async () => {
    // Le message est parti chez Meta : rendre une erreur ferait croire à l'opérateur qu'il doit renvoyer.
    const a = app({ takeControl: async () => { throw new Error('base indisponible'); } });
    const res = await a.inject({
      method: 'POST', url: '/tenants/t1/conversations/c1/reply', ...auth(),
      payload: { text: 'coucou' },
    });
    expect(res.statusCode).toBe(200);
    await a.close();
  });
});

describe('rendre la main depuis la conversation', () => {
  it('rend la main et renvoie le nouveau détenteur', async () => {
    const rendus: Array<[string, string]> = [];
    const a = app({ releaseControl: async (t, w) => { rendus.push([t, w]); return 'app_workflow'; } });
    const res = await a.inject({ method: 'POST', url: '/tenants/t1/conversations/c1/release', ...auth() });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ controlOwner: string }>().controlOwner).toBe('app_workflow');
    expect(rendus).toEqual([['t1', '33611']]);
    await a.close();
  });

  it('conversation inconnue -> 404 sans rien rendre', async () => {
    const rendus: string[] = [];
    const a = app({ releaseControl: async (_t, w) => { rendus.push(w); return 'app_workflow'; } });
    const res = await a.inject({ method: 'POST', url: '/tenants/t1/conversations/nope/release', ...auth() });
    expect(res.statusCode).toBe(404);
    expect(rendus).toEqual([]);
    await a.close();
  });

  it('tenant de l’URL != tenant du jeton -> 403', async () => {
    const a = app({ releaseControl: async () => 'app_workflow' });
    const res = await a.inject({ method: 'POST', url: '/tenants/AUTRE/conversations/c1/release', ...auth() });
    expect(res.statusCode).toBe(403);
    await a.close();
  });

  it('le détail de conversation expose QUI détient le fil', async () => {
    const a = app({ getControlOwner: async () => 'mba' });
    const res = await a.inject({ method: 'GET', url: '/tenants/t1/conversations/c1/messages', ...auth() });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ controlOwner: string }>().controlOwner).toBe('mba');
    await a.close();
  });

  it('dep absent -> le détail annonce `app_workflow`, jamais une valeur manquante', async () => {
    const a = app();
    const res = await a.inject({ method: 'GET', url: '/tenants/t1/conversations/c1/messages', ...auth() });
    expect(res.json<{ controlOwner: string }>().controlOwner).toBe('app_workflow');
    await a.close();
  });
});

/**
 * Surcharge de destination de reprise par conversation (C.4) : dit au sweep de handback si CE fil doit
 * repartir au scénario (`resume`) ou rester à l'humain (`inbox`), ou suivre le défaut du tenant (`null`).
 * Elle ne bascule PAS le contrôle : elle n'écrit qu'un réglage lu plus tard par le sweep.
 */

/**
 * Compteur de non-lus (pastille du menu) + marquage « lu » à l'ouverture d'un fil. La notion n'existait
 * nulle part avant : le seul événement qui éteint la pastille est un opérateur qui OUVRE la conversation.
 */
describe('inbox : conversations non lues', () => {
  it('GET unread-count -> le nombre rendu par le store', async () => {
    const a = app({ countUnread: async () => 7 });
    const res = await a.inject({ method: 'GET', url: '/tenants/t1/conversations/unread-count', ...auth() });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ count: number }>().count).toBe(7);
    await a.close();
  });

  it("« unread-count » n'est PAS pris pour un identifiant de conversation", async () => {
    // La route est déclarée avant `/conversations/:conversationId/...` : sans ça, un jour où une route
    // `/conversations/:id` existerait, le compteur partirait chercher une conversation nommée « unread-count ».
    const vus: string[] = [];
    const a = app({ countUnread: async () => 3, getConversationContext: async (id) => { vus.push(id); return null; } });
    const res = await a.inject({ method: 'GET', url: '/tenants/t1/conversations/unread-count', ...auth() });
    expect(res.statusCode).toBe(200);
    expect(vus).toEqual([]);
    await a.close();
  });

  it('dep absente -> 0 (la pastille ne s’affiche pas), jamais une erreur', async () => {
    const a = app();
    const res = await a.inject({ method: 'GET', url: '/tenants/t1/conversations/unread-count', ...auth() });
    expect(res.json<{ count: number }>().count).toBe(0);
    await a.close();
  });

  it('POST read -> marque le fil lu, scopé au tenant du jeton', async () => {
    const lus: Array<[string, string]> = [];
    const a = app({ markConversationRead: async (t, c) => { lus.push([t, c]); } });
    const res = await a.inject({ method: 'POST', url: '/tenants/t1/conversations/c1/read', ...auth() });
    expect(res.statusCode).toBe(200);
    expect(lus).toEqual([['t1', 'c1']]);
    await a.close();
  });

  it('POST read sur une conversation inconnue -> 404 sans rien marquer', async () => {
    const lus: string[] = [];
    const a = app({ markConversationRead: async (_t, c) => { lus.push(c); } });
    const res = await a.inject({ method: 'POST', url: '/tenants/t1/conversations/nope/read', ...auth() });
    expect(res.statusCode).toBe(404);
    expect(lus).toEqual([]);
    await a.close();
  });

  it('POST read : tenant de l’URL != tenant du jeton -> 403', async () => {
    const lus: string[] = [];
    const a = app({ markConversationRead: async (_t, c) => { lus.push(c); } });
    const res = await a.inject({ method: 'POST', url: '/tenants/AUTRE/conversations/c1/read', ...auth() });
    expect(res.statusCode).toBe(403);
    expect(lus).toEqual([]);
    await a.close();
  });

  it('GET unread-count : tenant de l’URL != tenant du jeton -> 403', async () => {
    const a = app({ countUnread: async () => 7 });
    const res = await a.inject({ method: 'GET', url: '/tenants/AUTRE/conversations/unread-count', ...auth() });
    expect(res.statusCode).toBe(403);
    await a.close();
  });
});

/**
 * Envoi d'un CAROUSEL depuis l'inbox. Ses cartes ne sont pas dans la requête : elles se relisent chez Meta
 * et leurs visuels doivent être re-téléversés, sinon Meta ACCEPTE l'envoi (200 + id) puis ne le livre jamais
 * (131053, mesuré en live le 2026-08-15). Un carousel non envoyable doit le DIRE avant de partir.
 */
describe('inbox : envoi d’un template carousel', () => {
  const carte = { mediaId: 'mid-1', body: 'Carte 1' };

  it('les cartes préparées sont transmises à l’envoi', async () => {
    let recu: unknown = null;
    const a = app({
      prepareCarousel: async () => ({ cards: [carte, { mediaId: 'mid-2' }] }),
      sendTemplateMessage: async (_t, _p, _to, tpl) => { recu = tpl; return 'wamid.CAR'; },
    });
    const res = await a.inject({
      method: 'POST', url: '/tenants/t1/conversations/c1/send-template', ...auth(),
      payload: { templateName: 'promo_carousel', language: 'fr' },
    });
    expect(res.statusCode).toBe(200);
    expect(recu).toMatchObject({ carousel: { cards: [carte, { mediaId: 'mid-2' }] } });
    await a.close();
  });

  it('carousel non envoyable -> 422 avec la raison, et AUCUN envoi', async () => {
    let envois = 0;
    const a = app({
      prepareCarousel: async () => ({ refus: "Carousel non envoyable : l'image de la carte 2 n'a pas pu être préparée" }),
      sendTemplateMessage: async () => { envois += 1; return 'wamid.NON'; },
    });
    const res = await a.inject({
      method: 'POST', url: '/tenants/t1/conversations/c1/send-template', ...auth(),
      payload: { templateName: 'promo_carousel', language: 'fr' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json<{ error: string }>().error).toContain('carte 2');
    expect(envois).toBe(0);
    await a.close();
  });

  it('template SANS carousel -> envoi strictement inchangé (aucun champ carousel)', async () => {
    let recu: Record<string, unknown> | null = null;
    const a = app({
      prepareCarousel: async () => null,
      sendTemplateMessage: async (_t, _p, _to, tpl) => { recu = tpl as unknown as Record<string, unknown>; return 'wamid.OK'; },
    });
    const res = await a.inject({
      method: 'POST', url: '/tenants/t1/conversations/c1/send-template', ...auth(),
      payload: { templateName: 'promo', language: 'fr', bodyParams: ['Julie'] },
    });
    expect(res.statusCode).toBe(200);
    expect(recu).not.toBeNull();
    expect(Object.hasOwn(recu!, 'carousel')).toBe(false);
    await a.close();
  });
});

/**
 * Lancer un SCÉNARIO depuis l'Inbox. La règle est dictée par la fenêtre de service : ouverte, tous les
 * scénarios ; fermée, uniquement ceux qui ouvrent par un template configuré (les autres seraient refusés
 * par Meta, 131047). C'est le SERVEUR qui tranche, pas la liste filtrée du navigateur : un fil peut sortir
 * de la fenêtre entre l'affichage de la liste et le clic.
 */
describe('inbox : lancer un scénario sur une conversation', () => {
  it('démarre le scénario et rend 200', async () => {
    const lances: Array<[string, string, string, boolean]> = [];
    const a = app({ startWorkflow: async (t, w, wa, open) => { lances.push([t, w, wa, open]); return true; } });
    const res = await a.inject({ method: 'POST', url: '/tenants/t1/conversations/c1/workflow', ...auth(), payload: { workflowId: 'wf1' } });
    expect(res.statusCode).toBe(200);
    expect(lances).toEqual([['t1', 'wf1', '33611', true]]); // le wa_id vient de la CONVERSATION, pas du corps
    await a.close();
  });

  it("passe l'état RÉEL de la fenêtre, pas ce que l'écran croyait", async () => {
    let vu: boolean | null = null;
    const a = app({
      getConversationContext: async () => ({ waId: '33611', windowOpen: false, lastInboundAt: '2026-07-01T00:00:00.000Z' }),
      startWorkflow: async (_t, _w, _wa, open) => { vu = open; return true; },
    });
    await a.inject({ method: 'POST', url: '/tenants/t1/conversations/c1/workflow', ...auth(), payload: { workflowId: 'wf1' } });
    expect(vu).toBe(false);
    await a.close();
  });

  it('refus -> 422 avec la RAISON exacte, jamais un 200 muet', async () => {
    const a = app({ startWorkflow: async () => "le scénario ouvre par un message rapide ou un formulaire, impossible hors de la fenêtre de 24 h" });
    const res = await a.inject({ method: 'POST', url: '/tenants/t1/conversations/c1/workflow', ...auth(), payload: { workflowId: 'wf1' } });
    expect(res.statusCode).toBe(422);
    expect(res.json<{ error: string }>().error).toContain('fenêtre de 24 h');
    await a.close();
  });

  it('scénario inconnu (ou d’un autre workspace) -> 404', async () => {
    const a = app({ startWorkflow: async () => null });
    const res = await a.inject({ method: 'POST', url: '/tenants/t1/conversations/c1/workflow', ...auth(), payload: { workflowId: 'inconnu' } });
    expect(res.statusCode).toBe(404);
    await a.close();
  });

  it('conversation inconnue -> 404, et AUCUN scénario démarré', async () => {
    let lances = 0;
    const a = app({ startWorkflow: async () => { lances += 1; return true; } });
    const res = await a.inject({ method: 'POST', url: '/tenants/t1/conversations/nope/workflow', ...auth(), payload: { workflowId: 'wf1' } });
    expect(res.statusCode).toBe(404);
    expect(lances).toBe(0);
    await a.close();
  });

  it('workflowId manquant -> 400, et AUCUN scénario démarré', async () => {
    let lances = 0;
    const a = app({ startWorkflow: async () => { lances += 1; return true; } });
    const res = await a.inject({ method: 'POST', url: '/tenants/t1/conversations/c1/workflow', ...auth(), payload: {} });
    expect(res.statusCode).toBe(400);
    expect(lances).toBe(0);
    await a.close();
  });

  it('tenant de l’URL != tenant du jeton -> 403, et AUCUN scénario démarré', async () => {
    let lances = 0;
    const a = app({ startWorkflow: async () => { lances += 1; return true; } });
    const res = await a.inject({ method: 'POST', url: '/tenants/AUTRE/conversations/c1/workflow', ...auth(), payload: { workflowId: 'wf1' } });
    expect(res.statusCode).toBe(403);
    expect(lances).toBe(0);
    await a.close();
  });

  it('dep absente -> 503, jamais un 200 trompeur', async () => {
    const a = app();
    const res = await a.inject({ method: 'POST', url: '/tenants/t1/conversations/c1/workflow', ...auth(), payload: { workflowId: 'wf1' } });
    expect(res.statusCode).toBe(503);
    await a.close();
  });
});

/**
 * Pagination et filtre de l'inbox, faits en SQL et non plus en mémoire.
 *
 * Ce que ces tests protègent : que les paramètres d'URL arrivent bien au store sous la forme attendue, et
 * surtout qu'un paramètre MAL FORMÉ n'aboutisse jamais à une page vide. Une liste vide se lit « aucune
 * conversation », ce qui est le contraire de « je n'ai pas compris votre filtre ».
 */
describe('GET /conversations — pagination et filtre', () => {
  /** Capture les options reçues par le store. */
  function espion() {
    const recus: Array<unknown> = [];
    const a = app({ listConversations: async (_t: string, opts?: unknown) => { recus.push(opts); return []; } });
    return { a, recus };
  }

  it('sans paramètre : aucune option imposée (la page par défaut, comme avant)', async () => {
    const { a, recus } = espion();
    expect((await a.inject({ method: 'GET', url: '/tenants/t1/conversations', ...auth() })).statusCode).toBe(200);
    expect(recus[0]).toEqual({});
    await a.close();
  });

  it('limit, aTraiter et curseur complet sont transmis', async () => {
    const { a, recus } = espion();
    await a.inject({
      method: 'GET',
      url: '/tenants/t1/conversations?limit=25&aTraiter=1&beforeAt=2026-08-21T10:00:00.000Z&beforeId=abc',
      ...auth(),
    });
    expect(recus[0]).toEqual({ limit: 25, aTraiter: true, before: { at: '2026-08-21T10:00:00.000Z', id: 'abc' } });
    await a.close();
  });

  it('🔴 un curseur À MOITIÉ fourni est IGNORÉ (une moitié rendrait une page arbitraire)', async () => {
    const { a, recus } = espion();
    await a.inject({ method: 'GET', url: '/tenants/t1/conversations?beforeAt=2026-08-21T10:00:00.000Z', ...auth() });
    await a.inject({ method: 'GET', url: '/tenants/t1/conversations?beforeId=abc', ...auth() });
    expect(recus).toEqual([{}, {}]);
    await a.close();
  });

  it('🔴 des paramètres absurdes rendent la page NORMALE, jamais une liste vide', async () => {
    const { a, recus } = espion();
    for (const qs of ['limit=abc', 'limit=0', 'limit=-5', 'limit=1.5', 'aTraiter=peut-etre', 'aTraiter=0']) {
      expect((await a.inject({ method: 'GET', url: `/tenants/t1/conversations?${qs}`, ...auth() })).statusCode).toBe(200);
    }
    // Aucun de ces cas ne pose de filtre : l'écran montre ce qu'il montrerait sans paramètre du tout.
    expect(recus).toEqual([{}, {}, {}, {}, {}, {}]);
    await a.close();
  });

  it('le compteur « À traiter » a sa propre route, et vaut 0 si la dep n’est pas câblée', async () => {
    const avec = app({ countATraiter: async () => 42 });
    expect((await avec.inject({ method: 'GET', url: '/tenants/t1/conversations/todo-count', ...auth() })).json<{ count: number }>().count).toBe(42);
    await avec.close();

    const sans = app();
    expect((await sans.inject({ method: 'GET', url: '/tenants/t1/conversations/todo-count', ...auth() })).json<{ count: number }>().count).toBe(0);
    await sans.close();
  });

  it('🔴 `todo-count` n’est pas pris pour un identifiant de conversation', async () => {
    // La route est déclarée AVANT `/conversations/:conversationId` : dans l'ordre inverse, elle serait
    // interceptée et on chercherait une conversation nommée « todo-count ».
    const a = app({ countATraiter: async () => 7 });
    const res = await a.inject({ method: 'GET', url: '/tenants/t1/conversations/todo-count', ...auth() });
    expect(res.json<{ count?: number }>().count).toBe(7);
    await a.close();
  });
});

/**
 * Affectation d'une conversation à un membre.
 *
 * 🔴 Ces tests portent sur le SERVEUR, et c'est tout leur intérêt : l'écran grise un bouton, mais rien
 * n'empêche d'appeler l'API directement. Si le refus n'est pas ici, l'affectation n'est qu'une étiquette.
 */
describe('affectation des conversations', () => {
  /** Trois identités : l'agent affecté, un autre agent, un manager. */
  const jetons = { affecte: '', autre: '', manager: '' };
  beforeAll(async () => {
    jetons.affecte = await signSession({ userId: 'u-affecte', tenantId: 't1', role: 'agent' }, SECRET);
    jetons.autre = await signSession({ userId: 'u-autre', tenantId: 't1', role: 'agent' }, SECRET);
    jetons.manager = await signSession({ userId: 'u-manager', tenantId: 't1', role: 'manager' }, SECRET);
  });
  const comme = (jeton: string) => ({ headers: { 'content-type': 'application/json', authorization: `Bearer ${jeton}` } });

  /** App dont la conversation `c1` est affectée à `assignee`. */
  function appAvecAffectation(assignee: string | null) {
    const poses: Array<{ id: string; assignee: string | null; par: string | null }> = [];
    const a = app({
      getAssignee: async () => assignee,
      setAssignee: async (_t: string, id: string, who: string | null, par: string | null) => { poses.push({ id, assignee: who, par }); return true; },
      // Câblé comme en production : sans lui la route rend 503 « indisponible sur cette instance » AVANT
      // d'arriver à la règle d'affectation, et le test ne prouverait rien du refus.
      startWorkflow: async () => true,
    });
    return { a, poses };
  }

  it('conversation NON affectée : un agent quelconque peut répondre', async () => {
    const { a } = appAvecAffectation(null);
    const res = await a.inject({ method: 'POST', url: '/tenants/t1/conversations/c1/reply', ...comme(jetons.autre), payload: { text: 'bonjour' } });
    expect(res.statusCode).toBe(200);
    await a.close();
  });

  it('affectée : l’agent DÉSIGNÉ peut répondre', async () => {
    const { a } = appAvecAffectation('u-affecte');
    const res = await a.inject({ method: 'POST', url: '/tenants/t1/conversations/c1/reply', ...comme(jetons.affecte), payload: { text: 'bonjour' } });
    expect(res.statusCode).toBe(200);
    await a.close();
  });

  it('🔴 affectée : un AUTRE agent est refusé par le SERVEUR (403)', async () => {
    const { a } = appAvecAffectation('u-affecte');
    const res = await a.inject({ method: 'POST', url: '/tenants/t1/conversations/c1/reply', ...comme(jetons.autre), payload: { text: 'coucou' } });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ code: string }>().code).toBe('assigned_to_other');
    await a.close();
  });

  it('🔴 le refus vaut aussi pour un TEMPLATE et pour un SCÉNARIO', async () => {
    // Les trois routes écrivent au client : protéger la seule réponse texte laisserait deux portes ouvertes.
    const { a } = appAvecAffectation('u-affecte');
    const tpl = await a.inject({
      method: 'POST', url: '/tenants/t1/conversations/c1/send-template', ...comme(jetons.autre),
      payload: { templateName: 'promo', language: 'fr' },
    });
    expect(tpl.statusCode).toBe(403);
    const wf = await a.inject({
      method: 'POST', url: '/tenants/t1/conversations/c1/workflow', ...comme(jetons.autre),
      payload: { workflowId: 'wf1' },
    });
    expect(wf.statusCode).toBe(403);
    await a.close();
  });

  it('un MANAGER peut toujours reprendre la main sur une conversation affectée à un autre', async () => {
    const { a } = appAvecAffectation('u-affecte');
    const res = await a.inject({ method: 'POST', url: '/tenants/t1/conversations/c1/reply', ...comme(jetons.manager), payload: { text: 'je reprends' } });
    expect(res.statusCode).toBe(200);
    await a.close();
  });

  it('un manager affecte ; un agent ne peut pas', async () => {
    const { a, poses } = appAvecAffectation(null);
    const ok = await a.inject({ method: 'PATCH', url: '/tenants/t1/conversations/c1/assignee', ...comme(jetons.manager), payload: { assignee: 'u-affecte' } });
    expect(ok.statusCode).toBe(200);
    expect(poses).toEqual([{ id: 'c1', assignee: 'u-affecte', par: 'u-manager' }]);

    const ko = await a.inject({ method: 'PATCH', url: '/tenants/t1/conversations/c1/assignee', ...comme(jetons.autre), payload: { assignee: 'u-autre' } });
    expect(ko.statusCode).toBe(403);
    expect(poses).toHaveLength(1); // rien d'écrit sur le refus
    await a.close();
  });

  it('`assignee: null` libère la conversation', async () => {
    const { a, poses } = appAvecAffectation('u-affecte');
    const res = await a.inject({ method: 'PATCH', url: '/tenants/t1/conversations/c1/assignee', ...comme(jetons.manager), payload: { assignee: null } });
    expect(res.statusCode).toBe(200);
    expect(poses[0]?.assignee).toBeNull();
    await a.close();
  });

  it('🔴 une valeur bancale ne LIBÈRE pas en silence', async () => {
    // Libérer rouvre la conversation à tout le monde : ça ne doit jamais arriver par accident, seulement sur
    // un `null` explicite.
    const { a, poses } = appAvecAffectation('u-affecte');
    for (const assignee of [undefined, '', '   ', 42, {}, []]) {
      const res = await a.inject({ method: 'PATCH', url: '/tenants/t1/conversations/c1/assignee', ...comme(jetons.manager), payload: { assignee } });
      expect(res.statusCode).toBe(400);
    }
    expect(poses).toEqual([]);
    await a.close();
  });

  it('🔴 sans dépendance câblée, tout le monde écrit (comportement d’avant l’affectation)', async () => {
    // Une instance dont le store n'expose pas l'affectation ne doit pas se retrouver à tout bloquer.
    const a = app();
    const res = await a.inject({ method: 'POST', url: '/tenants/t1/conversations/c1/reply', ...comme(jetons.autre), payload: { text: 'bonjour' } });
    expect(res.statusCode).toBe(200);
    await a.close();
  });
});
