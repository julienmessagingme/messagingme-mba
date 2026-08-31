import { describe, it, expect, afterEach, vi } from 'vitest';
import { withRetry, RateLimiter, FetchTransport, HttpTimeoutError } from '../src/meta/http';
import { MetaApiError } from '../src/meta/errors';

const noSleep = async (): Promise<void> => {};
const noJitter = (): number => 0;

describe('withRetry', () => {
  it('rejoue une erreur retryable puis réussit', async () => {
    let calls = 0;
    const res = await withRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw new MetaApiError(503, null); // retryable
        return 'ok';
      },
      { maxRetries: 4, sleep: noSleep, random: noJitter },
    );
    expect(res).toBe('ok');
    expect(calls).toBe(3);
  });

  it('throw après maxRetries si toujours retryable', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw new MetaApiError(500, null);
        },
        { maxRetries: 2, sleep: noSleep, random: noJitter },
      ),
    ).rejects.toBeInstanceOf(MetaApiError);
    expect(calls).toBe(3); // 1 essai + 2 retries
  });

  it('erreur terminale -> une seule tentative, pas de retry', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw new MetaApiError(400, { code: 100 }); // terminal
        },
        { maxRetries: 5, sleep: noSleep, random: noJitter },
      ),
    ).rejects.toBeInstanceOf(MetaApiError);
    expect(calls).toBe(1);
  });

  it('erreur réseau reconnaissable (fetch failed) est retryable', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw new TypeError('fetch failed');
        },
        { maxRetries: 1, sleep: noSleep, random: noJitter },
      ),
    ).rejects.toBeInstanceOf(TypeError);
    expect(calls).toBe(2);
  });

  it('erreur applicative quelconque (bug) N EST PAS rejouée', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw new Error('bug de programmation');
        },
        { maxRetries: 5, sleep: noSleep, random: noJitter },
      ),
    ).rejects.toThrow('bug de programmation');
    expect(calls).toBe(1);
  });

  it('honore Retry-After (délai du header) au lieu du backoff', async () => {
    const waits: number[] = [];
    let calls = 0;
    const res = await withRetry(
      async () => {
        calls += 1;
        if (calls === 1) throw new MetaApiError(429, null, 5000); // retryAfterMs=5000
        return 'ok';
      },
      { maxRetries: 2, sleep: async (ms) => void waits.push(ms), random: noJitter },
    );
    expect(res).toBe('ok');
    expect(waits).toEqual([5000]);
  });

  it('plafonne Retry-After à maxDelayMs : un délai énorme de Meta ne gèle pas la file webhook', async () => {
    // Ce sommeil a lieu DANS le job de la file `webhook`, sérialisée et partagée par TOUS les tenants. Sans
    // plafond, un `Retry-After: 3600` d'un seul tenant gèle l'inbox de tout le parc une heure PAR tentative.
    const waits: number[] = [];
    let calls = 0;
    const res = await withRetry(
      async () => {
        calls += 1;
        if (calls === 1) throw new MetaApiError(429, null, 3_600_000); // Meta demande 1 h
        return 'ok';
      },
      { maxRetries: 2, sleep: async (ms) => void waits.push(ms), random: noJitter },
    );
    expect(res).toBe('ok');
    expect(waits).toEqual([30_000]); // le défaut de maxDelayMs, pas l'heure demandée
  });

  it("le plafond du Retry-After suit maxDelayMs, il n'est pas une constante en dur", async () => {
    const waits: number[] = [];
    let calls = 0;
    await withRetry(
      async () => {
        calls += 1;
        if (calls === 1) throw new MetaApiError(429, null, 3_600_000);
        return 'ok';
      },
      { maxRetries: 2, maxDelayMs: 5_000, sleep: async (ms) => void waits.push(ms), random: noJitter },
    );
    expect(waits).toEqual([5_000]);
  });
});

describe('RateLimiter', () => {
  it('espace les appels de minIntervalMs', async () => {
    let clock = 0;
    const waits: number[] = [];
    const rl = new RateLimiter(100, {
      now: () => clock,
      sleep: async (ms) => {
        waits.push(ms);
        clock += ms;
      },
    });
    await rl.acquire(); // t=0, pas d'attente
    await rl.acquire(); // attend 100
    await rl.acquire(); // attend 100
    expect(waits).toEqual([100, 100]);
  });
});

/**
 * Le plafond de temps d'un appel sortant (audit de scalabilité du 2026-08-25, resté ouvert jusqu'au
 * 2026-08-31). Sans lui, un fournisseur qui accepte la connexion et ne répond jamais immobilise le job, donc
 * le slot de worker, jusqu'au défaut d'undici (de l'ordre de cinq minutes). Sur la file `webhook`, sérialisée,
 * c'est l'entrant de TOUS les clients qui s'arrête derrière un seul appel pendu.
 */
describe('FetchTransport : plafond de temps', () => {
  afterEach(() => vi.unstubAllGlobals());

  /** Un serveur qui accepte puis se tait : la promesse ne se résout QUE sur abandon. */
  const serveurMuet = (): void => {
    vi.stubGlobal('fetch', (_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject((init.signal as AbortSignal).reason));
      }));
  };

  it('un serveur qui ne répond jamais est coupé, avec une erreur qui le DIT', async () => {
    serveurMuet();
    const t = new FetchTransport(30);
    await expect(t.post('https://graph.example/v23.0/123/messages?x=1', {}, {})).rejects.toBeInstanceOf(HttpTimeoutError);
  });

  it("le message ne recrache pas la query (elle porte des identifiants et finit dans les journaux)", async () => {
    serveurMuet();
    const t = new FetchTransport(30);
    await expect(t.post('https://graph.example/v23.0/123/messages?access_token=SECRET', {}, {})).rejects.toThrow(/messages$/);
  });

  it('🔴 ce dépassement est REJOUABLE : sinon un silence transitoire ferait échouer un envoi rejouable', async () => {
    let appels = 0;
    const res = await withRetry(
      async () => {
        appels += 1;
        if (appels < 3) throw new HttpTimeoutError('https://graph.example/x', 30);
        return 'ok';
      },
      { maxRetries: 4, sleep: noSleep, random: noJitter },
    );
    expect(res).toBe('ok');
    expect(appels).toBe(3);
  });

  it("🔴 l'abandon de l'APPELANT n'est PAS converti, donc PAS rejoué (c'est une décision, pas une panne)", async () => {
    // Le cerveau d'un agent passe son échéance : la rejouer multiplierait sa limite de temps par le nombre
    // de tentatives, ce qui est exactement l'inverse de ce qu'il demande.
    serveurMuet();
    const t = new FetchTransport(60_000);
    const sien = AbortSignal.timeout(20);
    const err = await t.post('https://graph.example/x', {}, {}, { signal: sien }).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(HttpTimeoutError);
    expect((err as { retryable?: unknown }).retryable).not.toBe(true);
  });

  it("un corps COUPÉ en cours de lecture est une panne, pas une réponse vide", async () => {
    // Sans ce cas, le `catch` autour de res.json() avalait l'abandon et l'appel rendait { status: 200,
    // json: null } : un SUCCÈS au corps vide, que l'appelant aurait interprété comme un envoi accepté.
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => ({
      status: 200,
      headers: new Headers(),
      json: () => new Promise((_r, rej) => {
        init.signal?.addEventListener('abort', () => rej((init.signal as AbortSignal).reason));
      }),
    }));
    const t = new FetchTransport(30);
    await expect(t.post('https://graph.example/x', {}, {})).rejects.toBeInstanceOf(HttpTimeoutError);
  });

  it('un JSON illisible reste un corps null (aucune régression du chemin normal)', async () => {
    vi.stubGlobal('fetch', async () => ({
      status: 204,
      headers: new Headers({ 'x-test': 'oui' }),
      json: () => Promise.reject(new SyntaxError('Unexpected end of JSON input')),
    }));
    const res = await new FetchTransport(1000).post('https://graph.example/x', {}, {});
    expect(res).toMatchObject({ status: 204, json: null });
    expect(res.headers?.['x-test']).toBe('oui');
  });

  it('un appel qui répond normalement n\'est pas touché', async () => {
    vi.stubGlobal('fetch', async () => ({
      status: 200,
      headers: new Headers(),
      json: async () => ({ messages: [{ id: 'wamid.X' }] }),
    }));
    const res = await new FetchTransport(1000).post('https://graph.example/x', { a: 1 }, {});
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ messages: [{ id: 'wamid.X' }] });
  });
});
