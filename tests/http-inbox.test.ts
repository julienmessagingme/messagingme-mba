import { jamaisDesabonne } from './consentement';
import { describe, it, expect, beforeAll } from 'vitest';
import { buildServer } from '../src/server';
import { FakeQueue } from '../src/queue/fake';
import { signSession } from '../src/auth/token';
import type { UserAuthStore, EmailIdentity } from '../src/auth/store';
import type { InboxRouteDeps } from '../src/http/inbox';
import { MediaExpire } from '../src/inbox/media-entrant';
import { MediaTropGros } from '../src/meta/media';

const SECRET = 'test-secret';
const CONV = '11111111-1111-4111-8111-111111111111';
let token = '';
let tokenAgent = '';
beforeAll(async () => {
  token = await signSession({ userId: 'u1', tenantId: 't1', role: 'admin' }, SECRET);
  tokenAgent = await signSession({ userId: 'u2', tenantId: 't1', role: 'agent' }, SECRET);
});
const noUsers: UserAuthStore = { findIdentity: async (): Promise<EmailIdentity | null> => null };
const auth = () => ({ headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` } });
const authAgent = () => ({ headers: { 'content-type': 'application/json', authorization: `Bearer ${tokenAgent}` } });

function app(over: Partial<InboxRouteDeps> = {}) {
  const deps: InboxRouteDeps = {
    estDesabonne: jamaisDesabonne,
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
      recordOutbound: async (id, body, msgId, _origine, type) => { recorded = [id, body, msgId, type]; },
      sendReply: async (tenant, pn, to, text) => { sent = [tenant, pn, to, text]; return 'wamid.OUT'; },
    });
    const res = await a.inject({ method: 'POST', url: '/tenants/t1/conversations/c1/reply', ...auth(), payload: { text: 'Merci !' } });
    expect(res.statusCode).toBe(200);
    expect(sent).toEqual(['t1', 'pn1', '33611', 'Merci !']); // tenant passé en 1er (B1 : token par tenant)
    expect(recorded).toEqual(['c1', 'Merci !', 'wamid.OUT', 'text']);
    await a.close();
  });

  it('POST reply -> journalise l auteur (sender_user_id du JWT) et l origine « humain »', async () => {
    let sender: string | null | undefined = 'UNSET';
    const origines: string[] = [];
    const a = app({
      recordOutbound: async (_id, _body, _msg, origine, _type, _cat, _name, s) => { sender = s; origines.push(origine); },
    });
    const res = await a.inject({ method: 'POST', url: '/tenants/t1/conversations/c1/reply', ...auth(), payload: { text: 'Merci !' } });
    expect(res.statusCode).toBe(200);
    expect(sender).toBe('u1'); // userId du token
    // 🔴 L'origine est POSÉE, plus déduite de l'expéditeur. Cette route n'est atteignable qu'avec un JWT de
    // console, donc c'est bien un humain ; la déduction, elle, mentait dès qu'un appelant sans expéditeur
    // humain apparaissait, et c'est ce qui est arrivé avec le serveur MCP.
    expect(origines).toEqual(['humain']);
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
      recordOutbound: async (_id, _body, _msg, _origine, type) => { recordedType = type; },
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
      recordOutbound: async (_id, _body, _msg, _origine, type, cat, name) => { recorded = { type, cat, name }; },
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
      recordOutbound: async (_id, _body, _msg, _origine, _type, cat) => { cats.push(cat ?? null); },
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

  /**
   * Micro-cache des compteurs (AUDIT-SCALE-2026-08-25.md, R7). Les 25 personnes d'un même client
   * interrogent la pastille toutes les 30 s depuis toutes les pages : sans mutualisation, c'est 25 fois le
   * même comptage sur TOUTES les conversations de l'espace.
   */
  it('plusieurs relectures rapprochées du compteur -> UN seul comptage en base', async () => {
    let comptages = 0;
    const a = app({ countUnread: async () => { comptages += 1; return 7; } });
    const lire = async (): Promise<number> =>
      (await a.inject({ method: 'GET', url: '/tenants/t1/conversations/unread-count', ...auth() })).json<{ count: number }>().count;
    expect([await lire(), await lire(), await lire()]).toEqual([7, 7, 7]);
    expect(comptages).toBe(1);
    await a.close();
  });

  it('marquer un fil comme lu -> le compteur suivant RECOMPTE (la pastille retombe tout de suite)', async () => {
    let restants = 7;
    let comptages = 0;
    const a = app({
      countUnread: async () => { comptages += 1; return restants; },
      markConversationRead: async () => { restants -= 1; },
    });
    const lire = async (): Promise<number> =>
      (await a.inject({ method: 'GET', url: '/tenants/t1/conversations/unread-count', ...auth() })).json<{ count: number }>().count;
    expect(await lire()).toBe(7);
    expect((await a.inject({ method: 'POST', url: '/tenants/t1/conversations/c1/read', ...auth() })).statusCode).toBe(200);
    // Sans invalidation, l'écran afficherait encore 7 pendant toute la durée de vie du cache, alors que
    // l'opérateur vient justement d'ouvrir le fil : le cache ferait le bug qu'il est censé ne pas créer.
    expect(await lire()).toBe(6);
    expect(comptages).toBe(2);
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

/**
 * DELTA du fil (lot 5 du programme II). L'écran se rafraîchit toutes les 4 secondes et retéléchargeait
 * jusqu'à 500 messages à chaque tour, par onglet ouvert. Il ne demande plus que la suite.
 */
describe('inbox : ne redemander que la suite du fil', () => {
  const AT = '2026-07-06T00:00:00.000Z';
  const ID = '11111111-1111-4111-8111-111111111111';

  /** Rend l'app et ce que la route a transmis au store (undefined = « tout le fil »). */
  function appDelta() {
    const vus: Array<{ at: string; id: string } | undefined> = [];
    const a = app({ getMessages: async (_id, apres) => { vus.push(apres); return []; } });
    return { a, vus };
  }

  it('sans paramètre : le fil ENTIER', async () => {
    const { a, vus } = appDelta();
    await a.inject({ method: 'GET', url: '/tenants/t1/conversations/c1/messages', ...auth() });
    expect(vus[0]).toBeUndefined();
    await a.close();
  });

  it('avec le couple complet : seulement la suite', async () => {
    const { a, vus } = appDelta();
    await a.inject({ method: 'GET', url: `/tenants/t1/conversations/c1/messages?afterAt=${encodeURIComponent(AT)}&afterId=${ID}`, ...auth() });
    expect(vus[0]).toEqual({ at: AT, id: ID });
    await a.close();
  });

  it('🔴 un couple INCOMPLET ou mal formé est ignoré : on rend TOUT, jamais un fil tronqué', async () => {
    // Le repli sûr est de voir trop de messages. Partir d'un point inventé escamoterait des bulles sans que
    // personne ne le voie : l'écran afficherait un fil incomplet en croyant être à jour.
    const cas = [
      `?afterAt=${encodeURIComponent(AT)}`,               // id manquant
      `?afterId=${ID}`,                                    // date manquante
      `?afterAt=${encodeURIComponent(AT)}&afterId=pas-un-uuid`,
      `?afterAt=pas-une-date&afterId=${ID}`,
    ];
    for (const q of cas) {
      const { a, vus } = appDelta();
      await a.inject({ method: 'GET', url: `/tenants/t1/conversations/c1/messages${q}`, ...auth() });
      expect(vus[0], `cas ${q}`).toBeUndefined();
      await a.close();
    }
  });
});

/**
 * EFFACER LE CONTENU d'une conversation (2026-09-02).
 *
 * 🔴 Trois gardes, et elles ne sont nulle part ailleurs : c'est RÉSERVÉ AUX ADMINISTRATEURS (un opérateur
 * répond aux clients, il n'efface pas des traces), la trace part au Journal des actions SANS le contenu qu'on
 * vient d'effacer, et une conversation d'un autre espace rend 404 plutôt que d'effacer chez le voisin.
 */
describe('effacer le contenu d’une conversation', () => {
  function harnais(effaces: number | null = 3) {
    const traces: Array<{ action: string; target: { kind: string; id: string }; detail?: Record<string, unknown> }> = [];
    const srv = app({
      effacerMessages: async () => effaces,
      audit: async (_t, _a, action, target, detail) => { traces.push({ action, target, ...(detail ? { detail } : {}) }); },
    });
    return { srv, traces };
  }

  it('efface, rend le compte, et TRACE au journal', async () => {
    const { srv, traces } = harnais(3);
    const res = await srv.inject({ method: 'DELETE', url: `/tenants/t1/conversations/${CONV}/messages`, ...auth() });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ effaces: number }>().effaces).toBe(3);
    expect(traces).toEqual([{ action: 'conversation.effacee', target: { kind: 'conversation', id: CONV }, detail: { messages: 3 } }]);
    await srv.close();
  });

  it('🔴 la trace ne porte NI le numéro NI le texte des messages effacés', async () => {
    // Y écrire ce qu'on vient d'effacer annulerait l'effacement, dans une table conçue pour ne jamais être
    // modifiée. Le journal ne connaît que l'identifiant interne et un compteur.
    const { srv, traces } = harnais(2);
    await srv.inject({ method: 'DELETE', url: `/tenants/t1/conversations/${CONV}/messages`, ...auth() });
    const tout = JSON.stringify(traces);
    expect(tout).not.toContain('33611');
    expect(tout).not.toContain('coucou');
    await srv.close();
  });

  it('🔴 un OPÉRATEUR ne peut pas effacer : le geste est réservé aux administrateurs', async () => {
    const { srv, traces } = harnais();
    const res = await srv.inject({ method: 'DELETE', url: `/tenants/t1/conversations/${CONV}/messages`, ...authAgent() });
    expect(res.statusCode).toBe(403);
    expect(traces).toEqual([]);
    await srv.close();
  });

  it('une conversation d’un AUTRE espace rend 404, et rien n’est tracé', async () => {
    const { srv, traces } = harnais(null);
    const res = await srv.inject({ method: 'DELETE', url: `/tenants/t1/conversations/${CONV}/messages`, ...auth() });
    expect(res.statusCode).toBe(404);
    expect(traces).toEqual([]);
    await srv.close();
  });

  it('un identifiant qui n’est pas un uuid rend 404 sans toucher au magasin', async () => {
    let appele = false;
    const srv = app({ effacerMessages: async () => { appele = true; return 1; } });
    const res = await srv.inject({ method: 'DELETE', url: '/tenants/t1/conversations/pas-un-uuid/messages', ...auth() });
    expect(res.statusCode).toBe(404);
    expect(appele).toBe(false);
    await srv.close();
  });

  it('sans la dépendance, la route le DIT (503) au lieu de répondre 200 sans rien faire', async () => {
    const srv = app();
    const res = await srv.inject({ method: 'DELETE', url: `/tenants/t1/conversations/${CONV}/messages`, ...auth() });
    expect(res.statusCode).toBe(503);
    await srv.close();
  });
});

/**
 * RANGER UNE CONVERSATION AILLEURS QUE DANS LES ARCHIVES (2026-09-09, demande de Julien).
 *
 * 🔴 CE QUE CES DEUX ROUTES FERMENT. Seul « Archivé » était atteignable ; remettre une conversation « à
 * traiter » exigeait d'ENVOYER un message au client (c'est l'envoi qui prend le fil), et signaler à la main
 * n'existait pas du tout. On écrivait donc à un client pour un geste de rangement interne.
 */
describe('signaler à la main, et prendre le fil', () => {
  it('🔴 signaler passe l’auteur pris dans la SESSION, jamais dans le corps', async () => {
    // Un identifiant fourni par l'appelant laisserait signaler au nom d'un collègue, sur la conversation
    // d'un client. C'est la seule chose que cette route ne doit pas déléguer.
    const vus: Array<{ id: string; signale: boolean; par: string | null }> = [];
    const a = app({ signalerConversation: async (_t, id, signale, par) => { vus.push({ id, signale, par }); return true; } });
    const res = await a.inject({ method: 'POST', url: `/tenants/t1/conversations/c1/signaler`, ...auth(), payload: { parUserId: 'u-quelqu-un-dautre' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ signalee: true });
    expect(vus).toEqual([{ id: 'c1', signale: true, par: 'u1' }]); // u1 = la session, pas le corps
  });

  it('« ne plus signaler » est une adresse à part, pas un drapeau dans le corps', async () => {
    // Même doctrine que archive/unarchive : l'intention se lit dans l'URL, et un corps mal formé ne peut pas
    // transformer un signalement en son contraire.
    const vus: boolean[] = [];
    const a = app({ signalerConversation: async (_t, _id, signale) => { vus.push(signale); return true; } });
    const res = await a.inject({ method: 'POST', url: `/tenants/t1/conversations/c1/ne-plus-signaler`, ...auth() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ signalee: false });
    expect(vus).toEqual([false]);
  });

  it('🔴 ouvert aux OPÉRATEURS : ranger sa boîte n’est pas une décision d’administration', async () => {
    const a = app({ signalerConversation: async () => true });
    expect((await a.inject({ method: 'POST', url: `/tenants/t1/conversations/c1/signaler`, ...authAgent() })).statusCode).toBe(200);
  });

  it('conversation inconnue -> 404, jamais un 200 qui annoncerait un rangement qui n’a pas eu lieu', async () => {
    const a = app({ signalerConversation: async () => false });
    expect((await a.inject({ method: 'POST', url: `/tenants/t1/conversations/${CONV}/signaler`, ...auth() })).statusCode).toBe(404);
  });

  it('câblage absent -> 503, comme l’archivage', async () => {
    const a = app();
    expect((await a.inject({ method: 'POST', url: `/tenants/t1/conversations/c1/signaler`, ...auth() })).statusCode).toBe(503);
  });

  it('tenant croisé -> 403', async () => {
    const a = app({ signalerConversation: async () => true });
    expect((await a.inject({ method: 'POST', url: `/tenants/AUTRE/conversations/c1/signaler`, ...auth() })).statusCode).toBe(403);
  });

  it('🔴 « prendre » bascule le fil sur l’humain, sans envoyer le moindre message', async () => {
    // Le point de la route : avant elle, entrer dans « À traiter » demandait d'écrire au client.
    const pris: string[] = [];
    const envois: string[] = [];
    const a = app({
      takeControl: async (_t, waId) => { pris.push(waId); },
      sendReply: async () => { envois.push('envoi'); return 'wamid.X'; },
    });
    const res = await a.inject({ method: 'POST', url: `/tenants/t1/conversations/c1/prendre`, ...auth() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ controlOwner: 'app_human' });
    expect(pris).toEqual(['33611']);
    expect(envois).toEqual([]); // rien n'est parti chez le contact
  });

  it('🔴 un échec de bascule n’est PAS avalé, contrairement aux chemins d’envoi', async () => {
    // Sur un envoi, `takeControl` est best-effort : le message est déjà parti. Ici la bascule EST le geste,
    // l'avaler afficherait un rangement qui n'a pas eu lieu.
    const a = app({ takeControl: async () => { throw new Error('base indisponible'); } });
    const res = await a.inject({ method: 'POST', url: `/tenants/t1/conversations/c1/prendre`, ...auth() });
    expect(res.statusCode).toBeGreaterThanOrEqual(500);
  });

  it('« prendre » : conversation inconnue -> 404, câblage absent -> 503', async () => {
    const a = app({ takeControl: async () => {} });
    expect((await a.inject({ method: 'POST', url: `/tenants/t1/conversations/${CONV}/prendre`, ...auth() })).statusCode).toBe(404);
    expect((await app().inject({ method: 'POST', url: `/tenants/t1/conversations/c1/prendre`, ...auth() })).statusCode).toBe(503);
  });

  it('🔴 META D’ABORD, notre état local ENSUITE', async () => {
    // L'ordre inverse est le bug du 2026-09-11 : on écrivait « c'est à moi » pendant que Meta continuait de
    // router les entrants vers son agent. Un état local qui annonce ce que Meta n'a pas fait est pire
    // qu'une erreur, parce qu'il rend le problème invisible jusqu'au message suivant du client.
    const ordre: string[] = [];
    const a = app({
      prendreLeFil: async (_t, waId) => { ordre.push(`meta:${waId}`); },
      takeControl: async () => { ordre.push('local'); },
    });
    const res = await a.inject({ method: 'POST', url: `/tenants/t1/conversations/c1/prendre`, ...auth() });
    expect(res.statusCode).toBe(200);
    expect(ordre).toEqual(['meta:33611', 'local']);
  });

  it('🔴 Meta refuse -> 409 qui donne la porte de secours, et AUCUNE écriture locale', async () => {
    // 409 et non 500 : Cloudflare remplace le corps de toute réponse 5xx par sa page d'erreur, donc un
    // message destiné à l'opérateur n'arriverait jamais à l'écran. Et le refus est un cas NORMAL, Meta
    // réservant `take` au « configured escalation partner ».
    let localEcrit = false;
    const a = app({
      prendreLeFil: async () => { throw new Error('not the configured escalation partner'); },
      takeControl: async () => { localEcrit = true; },
    });
    const res = await a.inject({ method: 'POST', url: `/tenants/t1/conversations/c1/prendre`, ...auth() });
    expect(res.statusCode).toBe(409);
    // La porte de secours est DITE, parce qu'elle est vraie quoi qu'il arrive : écrire prend le fil.
    expect(res.json().error).toContain('Envoyez un message');
    expect(localEcrit).toBe(false);
  });

  it('sans câblage Meta, le bouton garde son ancien comportement purement local', async () => {
    // Le bon repli pour une instance sans MBA : `prendreLeFil` est optionnelle, son absence ne doit pas
    // faire disparaître un geste de rangement qui n'a rien à voir avec Meta.
    const pris: string[] = [];
    const a = app({ takeControl: async (_t, waId) => { pris.push(waId); } });
    expect((await a.inject({ method: 'POST', url: `/tenants/t1/conversations/c1/prendre`, ...auth() })).statusCode).toBe(200);
    expect(pris).toEqual(['33611']);
  });
});

describe('marquer « Traité », à la main (migration 0160)', () => {
  it('« traiter » et « ne-plus-traiter » sont deux adresses, et chacune écrit son sens', async () => {
    // Même doctrine qu'archive/unarchive et signaler/ne-plus-signaler : l'intention se lit dans l'URL.
    const vus: Array<{ id: string; traitee: boolean }> = [];
    const a = app({ marquerTraitee: async (_t, id, traitee) => { vus.push({ id, traitee }); return true; } });
    const pose = await a.inject({ method: 'POST', url: `/tenants/t1/conversations/${CONV}/traiter`, ...auth() });
    expect(pose.statusCode).toBe(200);
    expect(pose.json()).toEqual({ traitee: true });
    const retire = await a.inject({ method: 'POST', url: `/tenants/t1/conversations/${CONV}/ne-plus-traiter`, ...auth() });
    expect(retire.json()).toEqual({ traitee: false });
    expect(vus).toEqual([{ id: CONV, traitee: true }, { id: CONV, traitee: false }]);
  });

  it('🔴 ouvert aux OPÉRATEURS : dire « j’ai fini avec ce fil » est le geste de celui qui le traite', async () => {
    const a = app({ marquerTraitee: async () => true });
    expect((await a.inject({ method: 'POST', url: `/tenants/t1/conversations/${CONV}/traiter`, ...authAgent() })).statusCode).toBe(200);
  });

  it('conversation inconnue -> 404, et un identifiant mal formé aussi, SANS toucher la base', async () => {
    // Un identifiant qui n'est pas un uuid ferait lever Postgres (22P02), donc un 500 illisible. La route
    // le refuse avant : le magasin ne doit même pas être appelé.
    let appels = 0;
    const a = app({ marquerTraitee: async () => { appels += 1; return false; } });
    expect((await a.inject({ method: 'POST', url: `/tenants/t1/conversations/${CONV}/traiter`, ...auth() })).statusCode).toBe(404);
    expect((await a.inject({ method: 'POST', url: `/tenants/t1/conversations/pas-un-uuid/traiter`, ...auth() })).statusCode).toBe(404);
    expect(appels).toBe(1);
  });

  it('câblage absent -> 503, tenant croisé -> 403', async () => {
    expect((await app().inject({ method: 'POST', url: `/tenants/t1/conversations/${CONV}/traiter`, ...auth() })).statusCode).toBe(503);
    const a = app({ marquerTraitee: async () => true });
    expect((await a.inject({ method: 'POST', url: `/tenants/AUTRE/conversations/${CONV}/traiter`, ...auth() })).statusCode).toBe(403);
  });

  it('🔴 le geste INVALIDE les compteurs : « À traiter » et « Traité » ne gardent pas l’ancien chiffre', async () => {
    // Le menu relit ses compteurs juste après le geste. Servis depuis le micro-cache, ils annonceraient
    // encore la conversation dans « À traiter » pendant la durée du cache, alors que la liste ne la montre plus.
    let lectures = 0;
    const a = app({
      marquerTraitee: async () => true,
      compterConversations: async () => {
        lectures += 1;
        return { tout: 1, aTraiter: 0, signalees: 0, archivees: 0, traitees: 0, nonAffectees: 0, parMembre: [] };
      },
    });
    await a.inject({ method: 'GET', url: '/tenants/t1/conversations/counts', ...auth() });
    await a.inject({ method: 'POST', url: `/tenants/t1/conversations/${CONV}/traiter`, ...auth() });
    await a.inject({ method: 'GET', url: '/tenants/t1/conversations/counts', ...auth() });
    expect(lectures).toBe(2);
  });
});

describe('servir une pièce jointe reçue (2026-09-19)', () => {
  const MSG = '22222222-2222-4222-8222-222222222222';
  const url = `/tenants/t1/conversations/c1/messages/${MSG}/media`;

  it('🔴 une photo s’affiche : inline, son type, et nosniff', async () => {
    const a = app({ lireMediaMessage: async () => ({ bytes: Buffer.from('jpg'), mime: 'image/jpeg', nom: null }) });
    const res = await a.inject({ method: 'GET', url, ...auth() });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/jpeg');
    expect(String(res.headers['content-disposition'])).toMatch(/^inline;/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toBe('private, no-store');
  });

  it('🔴 un document reçu se TÉLÉCHARGE sous son nom, même s’il se dit HTML', async () => {
    // Le type vient de l'EXPÉDITEUR. Servi « inline », un HTML s'exécuterait dans l'origine de la console.
    const a = app({ lireMediaMessage: async () => ({ bytes: Buffer.from('<script>'), mime: 'text/html', nom: 'devis.html' }) });
    const res = await a.inject({ method: 'GET', url, ...auth() });
    expect(res.statusCode).toBe(200);
    expect(String(res.headers['content-disposition'])).toMatch(/^attachment; filename="devis\.html"/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('🔴 un média EXPIRÉ chez Meta rend 410 avec son code, pas une panne', async () => {
    const a = app({ lireMediaMessage: async () => { throw new MediaExpire(); } });
    const res = await a.inject({ method: 'GET', url, ...auth() });
    expect(res.statusCode).toBe(410);
    expect(res.json()).toMatchObject({ code: 'media_expire' });
  });

  it('un fichier TROP LOURD rend 422 avec sa taille, pour que l’écran la dise', async () => {
    const a = app({ lireMediaMessage: async () => { throw new MediaTropGros(40 * 1024 * 1024, 25 * 1024 * 1024); } });
    const res = await a.inject({ method: 'GET', url, ...auth() });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: 'media_trop_gros' });
    expect(res.json().error).toContain('40 Mo');
  });

  it('une autre panne reste un 422 générique, jamais un 5xx', async () => {
    // Cloudflare remplacerait le corps d'un 5xx par sa page, et l'écran n'aurait rien à dire.
    const a = app({ lireMediaMessage: async () => { throw new Error('reseau'); } });
    expect((await a.inject({ method: 'GET', url, ...auth() })).statusCode).toBe(422);
  });

  it('🔴 la transcription d’un vocal EXPIRÉ rend 410, pas « réessayez »', async () => {
    const a = app({ transcrireMessage: async () => { throw new MediaExpire(); } });
    const res = await a.inject({ method: 'POST', url: `/tenants/t1/conversations/c1/messages/${MSG}/transcrire`, ...auth(), payload: {} });
    expect(res.statusCode).toBe(410);
    expect(res.json()).toMatchObject({ code: 'media_expire' });
  });
});

describe('un agent PREND une conversation du pot commun (migration 0160)', () => {
  const jetons = { agent: '', manager: '' };
  beforeAll(async () => {
    jetons.agent = await signSession({ userId: 'u-agent', tenantId: 't1', role: 'agent' }, SECRET);
    jetons.manager = await signSession({ userId: 'u-manager', tenantId: 't1', role: 'manager' }, SECRET);
  });
  const comme = (jeton: string) => ({ headers: { 'content-type': 'application/json', authorization: `Bearer ${jeton}` } });
  const url = `/tenants/t1/conversations/${CONV}/assignee/moi`;

  function monter(o: { reglage: boolean; assignee?: string | null; prendre?: boolean }) {
    const prises: Array<{ id: string; userId: string }> = [];
    const a = app({
      getAssignee: async () => (o.assignee === undefined ? null : o.assignee),
      agentsPeuventPrendre: async () => o.reglage,
      prendreSiLibre: async (_t, id, userId) => { prises.push({ id, userId }); return o.prendre ?? true; },
    });
    return { a, prises };
  }

  it('🔴 réglage activé : l’agent prend, et c’est À LUI, jamais à l’identifiant du corps', async () => {
    // Un affectataire pris dans le corps ferait de cette route un « donner à un collègue », précisément
    // ce que le réglage n'autorise pas.
    const { a, prises } = monter({ reglage: true });
    const res = await a.inject({ method: 'POST', url, ...comme(jetons.agent), payload: { assignee: 'u-quelqu-un-dautre' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ conversationId: CONV, assignee: 'u-agent' });
    expect(prises).toEqual([{ id: CONV, userId: 'u-agent' }]);
  });

  it('🔴 réglage COUPÉ : 403, et rien n’est écrit', async () => {
    const { a, prises } = monter({ reglage: false });
    const res = await a.inject({ method: 'POST', url, ...comme(jetons.agent) });
    expect(res.statusCode).toBe(403);
    expect(prises).toEqual([]);
  });

  it('🔴 déjà à un collègue : 409, et rien n’est écrit', async () => {
    const { a, prises } = monter({ reglage: true, assignee: 'u-collegue' });
    const res = await a.inject({ method: 'POST', url, ...comme(jetons.agent) });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'deja_prise' });
    expect(prises).toEqual([]);
  });

  it('🔴 un collègue la prend ENTRE la lecture et l’écriture : 409, pas un faux succès', async () => {
    // L'écriture conditionnelle ne touche aucune ligne : la route doit le dire, pas annoncer une prise.
    const { a } = monter({ reglage: true, prendre: false });
    const res = await a.inject({ method: 'POST', url, ...comme(jetons.agent) });
    expect(res.statusCode).toBe(409);
  });

  it('conversation inconnue ou identifiant mal formé : 404', async () => {
    const { a } = monter({ reglage: true, assignee: undefined });
    const inconnue = app({ getAssignee: async () => undefined, agentsPeuventPrendre: async () => true, prendreSiLibre: async () => true });
    expect((await inconnue.inject({ method: 'POST', url, ...comme(jetons.agent) })).statusCode).toBe(404);
    expect((await a.inject({ method: 'POST', url: '/tenants/t1/conversations/pas-un-uuid/assignee/moi', ...comme(jetons.agent) })).statusCode).toBe(404);
  });

  it('un manager prend, même réglage coupé : il peut déjà tout affecter', async () => {
    const { a } = monter({ reglage: false });
    expect((await a.inject({ method: 'POST', url, ...comme(jetons.manager) })).statusCode).toBe(200);
  });

  it('🔴 la liste dit à l’écran si l’agent peut prendre, par la MÊME règle', async () => {
    const lire = async (reglage: boolean, jeton: string) => {
      const { a } = monter({ reglage });
      return (await a.inject({ method: 'GET', url: '/tenants/t1/conversations', ...comme(jeton) })).json().peutPrendre;
    };
    expect(await lire(true, jetons.agent)).toBe(true);
    expect(await lire(false, jetons.agent)).toBe(false);
  });

  it('🔴 un réglage ILLISIBLE ne fait pas tomber la liste : il vaut « non »', async () => {
    // Sans garde, un échec de cette lecture rendait 500 sur la liste entière, donc l'Inbox vide pour tout le
    // monde, pour un simple bouton.
    const a = app({ agentsPeuventPrendre: async () => { throw new Error('base'); }, prendreSiLibre: async () => true });
    const res = await a.inject({ method: 'GET', url: '/tenants/t1/conversations', ...comme(jetons.agent) });
    expect(res.statusCode).toBe(200);
    expect(res.json().peutPrendre).toBe(false);
  });

  it('🔴 un réglage illisible à la PRISE : refus qui dit la vraie raison, et rien d’écrit', async () => {
    // « Votre espace ne le permet pas » serait peut-être faux : on n'en sait rien, la lecture a échoué.
    const prises: string[] = [];
    const a = app({
      getAssignee: async () => null,
      agentsPeuventPrendre: async () => { throw new Error('base'); },
      prendreSiLibre: async (_t, id) => { prises.push(id); return true; },
    });
    const res = await a.inject({ method: 'POST', url, ...comme(jetons.agent) });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'reglage_illisible' });
    expect(prises).toEqual([]);
  });

  it('l’encadrement ne fait pas lire le réglage : il n’en a pas besoin', async () => {
    let lectures = 0;
    const a = app({ agentsPeuventPrendre: async () => { lectures += 1; return false; }, prendreSiLibre: async () => true });
    const res = await a.inject({ method: 'GET', url: '/tenants/t1/conversations', ...comme(jetons.manager) });
    expect(res.json().peutPrendre).toBe(true);
    expect(lectures).toBe(0);
  });

  it('sans câblage de la prise, la liste ne propose jamais le geste', async () => {
    // Un bouton qui mènerait à un 503 serait « offert et inerte », ce que le produit s'interdit.
    const a = app({ agentsPeuventPrendre: async () => true });
    expect((await a.inject({ method: 'GET', url: '/tenants/t1/conversations', ...comme(jetons.agent) })).json().peutPrendre).toBe(false);
  });

  it('🔴 la liste des membres affectables s’ouvre au MANAGER, pas à l’agent', async () => {
    // Elle était lue sur `GET /users`, réservé aux admins : chez un manager, le sélecteur revenait vide.
    const a = app({ membresPourAffectation: async () => [{ id: 'u-jean', nom: 'Jean' }] });
    const m = await a.inject({ method: 'GET', url: '/tenants/t1/conversations/membres-affectables', ...comme(jetons.manager) });
    expect(m.statusCode).toBe(200);
    expect(m.json()).toEqual({ membres: [{ id: 'u-jean', nom: 'Jean' }] });
    expect((await a.inject({ method: 'GET', url: '/tenants/t1/conversations/membres-affectables', ...comme(jetons.agent) })).statusCode).toBe(403);
  });
});

/**
 * 🔴 LES FILTRES DE DOSSIER TRAVERSENT-ILS VRAIMENT LA ROUTE ?
 *
 * Constaté par Julien le 2026-09-15 : cliquer sur un membre dans l'Inbox ne filtrait rien, toutes les
 * conversations restaient affichées. Le magasin SUPPORTAIT `affectee`, l'écran l'ENVOYAIT, et cette
 * route-ci ne le LISAIT pas. Le motif « une capacité câblée sur deux consommateurs sur trois », avec le
 * maillon du milieu manquant : aucun test ne regardait ce que la route TRANSMET au magasin.
 */
describe('les filtres de la liste arrivent au magasin', () => {
  const vus: Array<Record<string, unknown>> = [];
  const espion = () => app({
    listConversations: async (_t, opts) => { vus.push({ ...(opts ?? {}) }); return []; },
  });

  it('🔴 le filtre par MEMBRE est transmis', async () => {
    vus.length = 0;
    const a = espion();
    await a.inject({ method: 'GET', url: '/tenants/t1/conversations?affectee=u2', ...auth() });
    expect(vus[0]?.affectee).toBe('u2');
    await a.close();
  });

  it('🔴 « aucune » est une VALEUR, c’est le dossier « Non affectées »', async () => {
    // La confondre avec un paramètre absent rendrait ce dossier identique à « Tout ».
    vus.length = 0;
    const a = espion();
    await a.inject({ method: 'GET', url: '/tenants/t1/conversations?affectee=aucune', ...auth() });
    expect(vus[0]?.affectee).toBe('aucune');
    await a.close();
  });

  it('⚠️ absent ou vide ne pose AUCUN filtre : la page normale, jamais une page vide', async () => {
    vus.length = 0;
    const a = espion();
    await a.inject({ method: 'GET', url: '/tenants/t1/conversations', ...auth() });
    await a.inject({ method: 'GET', url: '/tenants/t1/conversations?affectee=', ...auth() });
    expect(vus[0]).not.toHaveProperty('affectee');
    expect(vus[1]).not.toHaveProperty('affectee');
    await a.close();
  });

  it('les autres dossiers passent toujours, eux aussi', async () => {
    vus.length = 0;
    const a = espion();
    await a.inject({ method: 'GET', url: '/tenants/t1/conversations?aTraiter=1&signalees=1&archivees=1&traitees=1', ...auth() });
    // `traitees` (migration 0160) : le maillon qu'on oublie est la ROUTE, cf. le docblock de ce bloc.
    expect(vus[0]).toMatchObject({ aTraiter: true, signalees: true, archivees: true, traitees: true });
    await a.close();
  });
});
