import { describe, it, expect } from 'vitest';
import {
  ApiError, createClient, DEFAULT_BASE_URL, type HttpMethod, type PathsWith, type RequestBody, type ResponseBody,
} from '../sdk/src/index';
import { EXEMPLES_CORPS, EXEMPLES_REPONSES } from '../web/lib/api-exemples';

/**
 * LE CLIENT DU SDK (lot 16, livraison B), contre un faux `fetch` : l'adresse, les en-têtes, le corps, les paramètres, et
 * la traduction des réponses (JSON, fichier, 204, erreurs). Au typage : chaque exemple de corps et de réponse de la doc
 * doit être accepté par les types générés du contrat, et un appel faux ne doit pas compiler.
 */

interface Appel { url: string; methode: string; entetes: Headers; corps: string | undefined }

function fauxFetch(reponse: () => Response) {
  const appels: Appel[] = [];
  const f = async (entree: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    appels.push({ url: String(entree), methode: init?.method ?? 'GET', entetes: new Headers(init?.headers), corps: init?.body as string | undefined });
    return reponse();
  };
  return { f: f as typeof fetch, appels };
}

const json = (corps: unknown, statut = 200, entetes: Record<string, string> = {}) =>
  () => new Response(JSON.stringify(corps), { status: statut, headers: { 'content-type': 'application/json; charset=utf-8', ...entetes } });

const CONTACT = '5f0c1e2a-8b7d-4c3e-9a1f-2d6b7e8c9f01';

describe('createClient : la requête', () => {
  it('POST : l’adresse, la clé, le JSON, et la réponse lue', async () => {
    const { f, appels } = fauxFetch(json({ contactId: CONTACT, status: 'created' }));
    const api = createClient({ apiKey: 'mba_test', baseUrl: 'https://api.exemple.fr/', fetch: f });
    const r = await api.POST('/v1/contacts', { body: { phone: '+33612345678', consent: 'opted_in' } });
    expect(r).toEqual({ contactId: CONTACT, status: 'created' });
    expect(appels).toHaveLength(1);
    expect(appels[0]!.url).toBe('https://api.exemple.fr/v1/contacts');
    expect(appels[0]!.methode).toBe('POST');
    expect(appels[0]!.entetes.get('authorization')).toBe('Bearer mba_test');
    expect(appels[0]!.entetes.get('content-type')).toBe('application/json');
    expect(JSON.parse(appels[0]!.corps!)).toEqual({ phone: '+33612345678', consent: 'opted_in' });
  });

  it('les paramètres de chemin sont encodés, ceux de requête posés, les absents omis', async () => {
    const { f, appels } = fauxFetch(json({ data: [], nextCursor: null }));
    const api = createClient({ apiKey: 'mba_test', fetch: f });
    await api.GET('/v1/conversations', { query: { needsReply: true, limit: 20, cursor: undefined } });
    expect(appels[0]!.url).toBe(`${DEFAULT_BASE_URL}/v1/conversations?needsReply=true&limit=20`);
    await api.GET('/v1/messages/{messageId}', { path: { messageId: 'wamid.a/b c' } });
    expect(appels[1]!.url).toBe(`${DEFAULT_BASE_URL}/v1/messages/wamid.a%2Fb%20c`);
    expect(appels[1]!.corps).toBeUndefined();
    expect(appels[1]!.entetes.get('content-type')).toBeNull();
  });

  it('la clé d’idempotence part en en-tête', async () => {
    const { f, appels } = fauxFetch(json({ sendId: CONTACT, opening: 'whatsapp_template', recipientCount: 1, created: 0, matched: 1, skipped: [], skippedTotal: 0 }, 201));
    const api = createClient({ apiKey: 'mba_test', fetch: f });
    await api.POST('/v1/sends', {
      body: { target: { template: { name: 'confirmation_commande', language: 'fr' } }, recipients: [{ phone: '+33612345678' }] },
      idempotencyKey: 'commande-7781',
    });
    expect(appels[0]!.entetes.get('idempotency-key')).toBe('commande-7781');
  });

  it('un 204 rend undefined, un fichier rend un Blob', async () => {
    const vide = fauxFetch(() => new Response(null, { status: 204 }));
    expect(await createClient({ apiKey: 'k', fetch: vide.f }).DELETE('/v1/webhooks/{webhookId}', { path: { webhookId: 'w1' } })).toBeUndefined();
    const fichier = fauxFetch(() => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'image/jpeg' } }));
    const blob = await createClient({ apiKey: 'k', fetch: fichier.f }).GET('/v1/messages/{messageId}/media', { path: { messageId: 'm1' } });
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.size).toBe(3);
  });

  it('une clé vide est refusée tout de suite, un paramètre de chemin manquant aussi', async () => {
    expect(() => createClient({ apiKey: '  ' })).toThrow(TypeError);
    const { f, appels } = fauxFetch(json({}));
    const api = createClient({ apiKey: 'k', fetch: f });
    // Le typage l'interdit ; un appelant en JavaScript peut l'oublier.
    await expect(api.GET('/v1/contacts/{contactId}', {} as never)).rejects.toThrow(/contactId/);
    expect(appels).toHaveLength(0);
  });
});

describe('createClient : les erreurs', () => {
  const echec = async (reponse: () => Response): Promise<ApiError> => {
    const api = createClient({ apiKey: 'k', fetch: fauxFetch(reponse).f });
    try {
      await api.POST('/v1/messages/whatsapp', { body: { contactId: CONTACT, text: 'Bonjour' } });
    } catch (e) {
      if (e instanceof ApiError) return e;
      throw e;
    }
    throw new Error('aucune erreur levée');
  };

  it('le statut, le code et le message de l’API', async () => {
    const e = await echec(json({ error: 'fenêtre de 24 h fermée', code: 'window_closed' }, 422));
    expect([e.status, e.code, e.message, e.retryAfter, e.upgradeUrl]).toEqual([422, 'window_closed', 'fenêtre de 24 h fermée', null, null]);
    expect(e.name).toBe('ApiError');
  });

  it('Retry-After en secondes, ou en date HTTP', async () => {
    expect((await echec(json({ error: 'trop de requêtes', code: 'rate_limited' }, 429, { 'retry-after': '30' }))).retryAfter).toBe(30);
    const dans = new Date(Date.now() + 90_000).toUTCString();
    const e = await echec(json({ error: 'quota', code: 'quota_exceeded' }, 429, { 'retry-after': dans }));
    expect(e.retryAfter).toBeGreaterThanOrEqual(88);
    expect(e.retryAfter).toBeLessThanOrEqual(91);
  });

  it('une panne générique sans code, et une réponse qui n’est pas du JSON', async () => {
    const sansCode = await echec(json({ error: 'corps JSON illisible' }, 400));
    expect([sansCode.code, sansCode.message]).toEqual([null, 'corps JSON illisible']);
    const texte = await echec(() => new Response('Internal Server Error', { status: 500, headers: { 'content-type': 'text/plain' } }));
    expect([texte.status, texte.code, texte.body]).toEqual([500, null, 'Internal Server Error']);
    expect(texte.message).toMatch(/^HTTP 500/);
  });

  it('un 402 porte la page de l’offre', async () => {
    const e = await echec(json({ error: 'non compris dans l’offre', code: 'plan_feature_unavailable', upgradeUrl: 'https://console.messagingme.app/offre' }, 402));
    expect([e.code, e.upgradeUrl]).toEqual(['plan_feature_unavailable', 'https://console.messagingme.app/offre']);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Au typage : les exemples de la doc passent dans les types du contrat, un appel faux ne compile pas.
// ---------------------------------------------------------------------------------------------------------------------
type Mutable<T> = T extends readonly (infer U)[] ? Mutable<U>[] : T extends object ? { -readonly [K in keyof T]: Mutable<T[K]> } : T;
type Route<R> = R extends `${infer M} ${infer P}` ? Lowercase<M> extends infer m extends HttpMethod ? P extends PathsWith<m> ? [P, m] : 'chemin inconnu' : 'méthode inconnue' : never;
type CorpsDe<R> = Route<R> extends [infer P, infer M extends HttpMethod] ? P extends PathsWith<M> ? RequestBody<P, M> : never : never;
type ReponseDe<R> = Route<R> extends [infer P, infer M extends HttpMethod] ? P extends PathsWith<M> ? ResponseBody<P, M> : never : never;
type ToutVrai<T> = [Exclude<T[keyof T], true>] extends [never] ? true : Exclude<T[keyof T], true>;

type VerifCorps = {
  [K in keyof typeof EXEMPLES_CORPS]: Mutable<(typeof EXEMPLES_CORPS)[K]['corps']> extends CorpsDe<(typeof EXEMPLES_CORPS)[K]['route']> ? true : K;
};
const corpsAcceptes: ToutVrai<VerifCorps> = true;

/** La route de chaque réponse d'exemple ; `null` : l'erreur, hors de toute route. Exhaustif par `satisfies`. */
const ROUTE_DE_LA_REPONSE = {
  contactEcrit: 'POST /v1/contacts', contactsLot: 'POST /v1/contacts/batch', contactLu: 'GET /v1/contacts/{contactId}',
  contactTrouve: 'POST /v1/contacts/search', contactModifie: 'PATCH /v1/contacts/{contactId}',
  messageEnvoye: 'POST /v1/messages/whatsapp', envoiCree: 'POST /v1/sends', envoiSuivi: 'GET /v1/sends/{sendId}',
  templates: 'GET /v1/templates', scenarios: 'GET /v1/scenarios', messagesRcs: 'GET /v1/rcs-messages', erreur: null,
  conversationLue: 'GET /v1/conversations/{conversationId}', conversations: 'GET /v1/conversations',
  messageLu: 'GET /v1/messages/{messageId}', champs: 'GET /v1/fields', champCree: 'POST /v1/fields',
  ficheEffacee: 'DELETE /v1/contacts/{contactId}', webhook: 'GET /v1/webhooks/{webhookId}', webhooks: 'GET /v1/webhooks',
  webhookCree: 'POST /v1/webhooks', envoisWebhook: 'GET /v1/webhooks/{webhookId}/deliveries', modeleCree: 'POST /v1/templates',
  statutModele: 'GET /v1/templates/{name}', messagesDuFil: 'GET /v1/conversations/{conversationId}/messages',
} as const satisfies Record<keyof typeof EXEMPLES_REPONSES, string | null>;
type Routes = typeof ROUTE_DE_LA_REPONSE;
type VerifReponses = {
  [K in keyof Routes]: Routes[K] extends null ? true
    : Mutable<(typeof EXEMPLES_REPONSES)[K]> extends ReponseDe<Routes[K]> ? true : K;
};
const reponsesAcceptees: ToutVrai<VerifReponses> = true;

async function appelsFaux(): Promise<void> {
  const api = createClient({ apiKey: 'k', fetch: fauxFetch(json({})).f });
  // @ts-expect-error un chemin qui n'existe pas
  await api.GET('/v1/inexistant');
  // @ts-expect-error une méthode que la route n'a pas
  await api.GET('/v1/sends');
  // @ts-expect-error un corps sans son champ requis (type)
  await api.POST('/v1/fields', { body: { label: 'Date de naissance' } });
  // @ts-expect-error un paramètre de chemin oublié
  await api.GET('/v1/contacts/{contactId}');
  // @ts-expect-error une valeur hors de l'énumération
  await api.POST('/v1/contacts', { body: { phone: '+33612345678', consent: 'oui' } });
  // La réponse est typée : `status` est l'une des deux valeurs du contrat.
  const r = await api.POST('/v1/contacts', { body: { phone: '+33612345678' } });
  const statut: 'created' | 'updated' = r.status;
  void statut;
}

it('les vérifications de typage existent (elles jouent à la compilation)', () => {
  expect([corpsAcceptes, reponsesAcceptees, typeof appelsFaux]).toEqual([true, true, 'function']);
});
