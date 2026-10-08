import { describe, it, expect } from 'vitest';
import { buildServer } from '../src/server';
import { FakeQueue } from './fake-queue';
import { sha256Hex } from '../src/lib/signature';
import { GardeUsageMemoire } from './aide/usage';
import type { ApiKeyLookup } from '../src/auth/api-key-store.pg';
import { cleApiDeTest, aucunJetonOauth } from './aide/cle-api';
import { contactsV1Muets } from './aide/contacts-v1';
import {
  decoderCurseur, encoderCurseur, idPublic, lireIdPublic, responsableDe,
  type ConversationV1, type DepotConversationsV1, type MessageV1, type Reprise,
} from '../src/api/conversations-v1';
import { MediaExpire } from '../src/inbox/media-entrant';
import { A_TRAITER_V1_SQL } from '../src/api/conversations-v1.pg';
import { readFileSync } from 'node:fs';

/**
 * LA LECTURE DES FILS PAR L'API (lot 13, domaine 1) : les routes sur un dépôt en mémoire. L'isolation réelle (le
 * filtre SQL sur l'espace) est tenue par `tests/integration/conversations-v1.integration.test.ts`.
 */
class FakeApiKeys implements ApiKeyLookup {
  private readonly byHash = new Map<string, { id: string; tenantId: string; scopes: string[] }>();
  add(raw: string, rec: { id: string; tenantId: string; scopes: string[] }) { this.byHash.set(sha256Hex(raw), rec); return this; }
  async findActiveByHash(hash: string) { return this.byHash.get(hash) ?? null; }
  async touchLastUsed(): Promise<void> {}
}

const CONV = 'c4e1b2a3-9d8f-4e7a-a6b5-1c2d3e4f5a6b';
const INTERNE = 'a1a1a1a1-0000-4000-8000-000000000001';
const LECTEUR = cleApiDeTest('lecteur');
const SANS_DROIT = cleApiDeTest('envoyeur');

const CONVERSATION: ConversationV1 = {
  id: CONV, contact: { id: null, phone: '+33612345678', name: 'Claire', externalId: null }, lastMessageAt: '2026-10-08T09:58:02.123Z',
  lastDirection: 'in', windowExpiresAt: null, handledBy: 'automation', needsReply: false, archived: false,
};
const MESSAGE: MessageV1 = {
  id: 'wamid.photo', conversationId: CONV, direction: 'in', channel: 'whatsapp', type: 'image', text: null, buttonPayload: null,
  transcription: null, media: { mimeType: 'image/jpeg', filename: null, expired: false }, createdAt: '2026-10-08T09:58:02.123Z',
};

function monter(o: { media?: MessageV1['media']; lecture?: Error | 'vide' } = {}) {
  const appels: Array<{ quoi: string; tenantId: string; avant?: Reprise | null; limite?: number; aTraiter?: boolean }> = [];
  const depot: DepotConversationsV1 = {
    lister: async (tenantId, p) => { appels.push({ quoi: 'lister', tenantId, ...p }); return { data: [CONVERSATION], nextCursor: null }; },
    lire: async (tenantId, id) => { appels.push({ quoi: 'lire', tenantId }); return tenantId === 't1' && id === CONV ? CONVERSATION : null; },
    messages: async (tenantId, id, p) => {
      appels.push({ quoi: 'messages', tenantId, ...p });
      return tenantId === 't1' && id === CONV ? { data: [MESSAGE], nextCursor: 'suite' } : null;
    },
    message: async (tenantId, id) => {
      appels.push({ quoi: 'message', tenantId });
      return tenantId === 't1' && id === 'wamid.photo' ? { ...MESSAGE, media: o.media === undefined ? MESSAGE.media : o.media, idInterne: INTERNE } : null;
    },
  };
  const usage = new GardeUsageMemoire();
  const keys = new FakeApiKeys()
    .add(LECTEUR, { id: 'k1', tenantId: 't1', scopes: ['conversations:read'] })
    .add(SANS_DROIT, { id: 'k2', tenantId: 't1', scopes: ['sends:create', 'contacts:read', 'mcp:read'] });
  const server = buildServer({
    queue: new FakeQueue(),
    usage,
    v1: {
      apiKeys: keys,
      oauth: aucunJetonOauth,
      contacts: contactsV1Muets(),
      conversations: {
        conversations: depot,
        lireMediaMessage: async (tenantId, id) => {
          appels.push({ quoi: `media:${id}`, tenantId });
          if (o.lecture instanceof Error) throw o.lecture;
          return o.lecture === 'vide' ? null : { bytes: Buffer.from('JPEG'), mime: 'image/jpeg', nom: null };
        },
      },
    },
  });
  const get = (url: string, cle = LECTEUR) => server.inject({ method: 'GET', url, headers: { authorization: `Bearer ${cle}` } });
  return { server, get, appels, usage };
}

describe('les formes publiques', () => {
  it('🔴 le curseur fait l’aller-retour, et un curseur bricolé est refusé (jamais une page qui recommence)', () => {
    const r = { at: '2026-10-08T09:58:02.123456Z', id: CONV };
    expect(decoderCurseur(encoderCurseur(r))).toEqual(r);
    for (const c of ['', 'x', encoderCurseur({ at: '2026-10-08', id: CONV }), encoderCurseur({ at: r.at, id: 'pas-un-uuid' }),
      Buffer.from(`${r.at}|${CONV}|en-trop`).toString('base64url'), 'a'.repeat(201), 'abc/def']) {
      expect(decoderCurseur(c), c).toBeNull();
    }
  });

  it('🔴 un instant de la bonne FORME mais impossible (30 février, mois 13, an 0000) est refusé : sinon Postgres lève 22008, donc 500', () => {
    for (const at of ['2026-02-30T00:00:00.000000Z', '2026-13-01T00:00:00.000000Z', '2026-10-08T25:00:00.000000Z', '0000-01-01T00:00:00.000000Z']) {
      expect(decoderCurseur(Buffer.from(`${at}|${CONV}`).toString('base64url')), at).toBeNull();
    }
  });

  it('l’identifiant public : celui de Meta, sinon le nôtre préfixé ; les deux formes se relisent', () => {
    expect(idPublic('wamid.HBg=', INTERNE)).toBe('wamid.HBg=');
    expect(idPublic(null, INTERNE)).toBe(`msg_${INTERNE}`);
    expect(lireIdPublic(`msg_${INTERNE}`)).toEqual({ interne: INTERNE });
    expect(lireIdPublic('wamid.HBgLMzM2MTIzNDU2NzgVAgARGBI=')).toEqual({ meta: 'wamid.HBgLMzM2MTIzNDU2NzgVAgARGBI=' });
    expect(lireIdPublic('msg_pas-un-uuid')).toBeNull();
    expect(lireIdPublic("wamid.x' or 1=1")).toBeNull();
  });

  it('🔴 « À traiter » est le MÊME prédicat que l’Inbox (recopié pour ne pas toucher son chemin chaud)', () => {
    expect(readFileSync('src/inbox/store.pg.ts', 'utf8')).toContain(`const A_TRAITER_SQL = \`${A_TRAITER_V1_SQL}\`;`);
  });

  it('qui tient le fil, en trois valeurs publiques', () => {
    expect([responsableDe('app_human'), responsableDe('mba'), responsableDe('app_workflow')]).toEqual(['team', 'meta_agent', 'automation']);
  });
});

describe('les routes /v1 de la lecture des fils', () => {
  it('🔴 sous le droit conversations:read seulement : une clé qui porte tous les autres droits reçoit 403', async () => {
    const b = monter();
    for (const url of ['/v1/conversations', `/v1/conversations/${CONV}`, `/v1/conversations/${CONV}/messages`, '/v1/messages/wamid.photo', '/v1/messages/wamid.photo/media']) {
      const r = await b.get(url, SANS_DROIT);
      expect(r.statusCode, url).toBe(403);
      expect(r.json(), url).toMatchObject({ code: 'missing_scope' });
    }
    expect(b.appels).toEqual([]);
  });

  it('🔴 l’espace vient de la CLÉ, et la page passe ses bornes au dépôt', async () => {
    const b = monter();
    const r = await b.get(`/v1/conversations?limit=20&needsReply=true&cursor=${encoderCurseur({ at: '2026-10-08T09:58:02.123456Z', id: CONV })}`);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ data: [CONVERSATION], nextCursor: null });
    expect(b.appels).toEqual([{ quoi: 'lister', tenantId: 't1', limite: 20, aTraiter: true, avant: { at: '2026-10-08T09:58:02.123456Z', id: CONV } }]);
    expect((await b.get('/v1/conversations')).statusCode).toBe(200);
    expect(b.appels[1]).toMatchObject({ limite: 50, avant: null, aTraiter: false });
  });

  it('une borne ou un curseur faux est un 400 qui le dit, sans rien lire', async () => {
    const b = monter();
    for (const [url, code] of [['/v1/conversations?limit=0', 'invalid_body'], ['/v1/conversations?limit=101', 'invalid_body'],
      ['/v1/conversations?limit=abc', 'invalid_body'], ['/v1/conversations?cursor=bricole', 'invalid_cursor'],
      ['/v1/conversations?needsReply=oui', 'invalid_body'], [`/v1/conversations/${CONV}/messages?cursor=x`, 'invalid_cursor']] as const) {
      const r = await b.get(url);
      expect(r.statusCode, url).toBe(400);
      expect(r.json(), url).toMatchObject({ code });
    }
    expect(b.appels).toEqual([]);
  });

  it('🔴 une conversation inconnue de l’espace, ou un identifiant mal formé, rend 404 (jamais un 500 de Postgres)', async () => {
    const b = monter();
    expect((await b.get(`/v1/conversations/${CONV}`)).json()).toEqual(CONVERSATION);
    for (const url of ['/v1/conversations/b2b2b2b2-0000-4000-8000-000000000000', '/v1/conversations/pas-un-uuid',
      '/v1/conversations/pas-un-uuid/messages', '/v1/conversations/b2b2b2b2-0000-4000-8000-000000000000/messages']) {
      const r = await b.get(url);
      expect(r.statusCode, url).toBe(404);
      expect(r.json(), url).toMatchObject({ code: 'conversation_not_found' });
    }
  });

  it('les messages : la page et son curseur ; un message par son identifiant, sans l’identifiant interne', async () => {
    const b = monter();
    expect((await b.get(`/v1/conversations/${CONV}/messages?limit=10`)).json()).toEqual({ data: [MESSAGE], nextCursor: 'suite' });
    const m = await b.get('/v1/messages/wamid.photo');
    expect(m.json()).toEqual(MESSAGE);
    expect(JSON.stringify(m.json())).not.toContain(INTERNE);
    expect((await b.get('/v1/messages/wamid.inconnu')).json()).toMatchObject({ code: 'message_not_found' });
  });

  it('🔴 le fichier : servi par l’identifiant INTERNE, avec les en-têtes de l’Inbox (nosniff, no-store)', async () => {
    const b = monter();
    const r = await b.get('/v1/messages/wamid.photo/media');
    expect(r.statusCode).toBe(200);
    expect(r.rawPayload.toString()).toBe('JPEG');
    expect(r.headers['content-type']).toMatch(/image\/jpeg/);
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(b.appels).toContainEqual({ quoi: `media:${INTERNE}`, tenantId: 't1' });
  });

  it('🔴 le fichier absent, expiré ou que Meta ne rend pas : 404, 410, 422, jamais un 5xx', async () => {
    expect((await monter({ media: null }).get('/v1/messages/wamid.photo/media')).json()).toMatchObject({ code: 'no_media' });
    const expire = monter({ media: { mimeType: 'image/jpeg', filename: null, expired: true } });
    const r = await expire.get('/v1/messages/wamid.photo/media');
    expect([r.statusCode, r.json().code]).toEqual([410, 'media_expired']);
    expect(expire.appels.some((a) => a.quoi.startsWith('media:')), 'expiré : Meta n’est pas appelé').toBe(false);
    const tard = await monter({ lecture: new MediaExpire() }).get('/v1/messages/wamid.photo/media');
    expect([tard.statusCode, tard.json().code]).toEqual([410, 'media_expired']);
    const panne = await monter({ lecture: new Error('Meta 500') }).get('/v1/messages/wamid.photo/media');
    expect([panne.statusCode, panne.json().code]).toEqual([422, 'media_unavailable']);
  });

  it('chaque appel compte une unité conversations.read, hors quota du jour', async () => {
    const b = monter();
    await b.get('/v1/conversations');
    await b.get('/v1/messages/wamid.photo');
    expect((await b.usage.compteurs()).find((c) => c.operation === 'conversations.read')).toMatchObject({ appels: 2 });
  });
});
