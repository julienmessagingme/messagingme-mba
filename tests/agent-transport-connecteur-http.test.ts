import { describe, expect, it, vi } from 'vitest';
import { AdresseInterdite } from '../src/lib/connexion-publique';
import { creerTransportConnecteurHttp } from '../src/agent/transport-connecteur-http';

const APPEL = (over: Partial<Parameters<ReturnType<typeof creerTransportConnecteurHttp>['executer']>[0]> = {}) => ({
  url: 'https://api.client.fr/v1/action',
  methode: 'POST',
  entetes: { authorization: 'Bearer SECRET', 'content-type': 'application/json' },
  corps: '{"id":"42"}',
  signal: new AbortController().signal,
  lecture: { nature: 'texte' as const, maxOctets: 1024 },
  ...over,
});

describe('transport d’un Connecteur HTTP', () => {
  it('refuse une résolution interne avant toute connexion', async () => {
    const fetch = vi.fn();
    const transport = creerTransportConnecteurHttp({
      fetch: fetch as unknown as typeof globalThis.fetch,
      verifierResolution: async () => ({ ok: false, raison: 'adresse interne' }),
    });

    expect(await transport.executer(APPEL())).toMatchObject({ nature: 'adresse_refusee' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('transporte l’appel préparé avec redirections refusées et lit son corps dans la limite', async () => {
    const fetch = vi.fn(async () => new Response('{"ok":true}', { status: 201 }));
    const transport = creerTransportConnecteurHttp({
      fetch: fetch as unknown as typeof globalThis.fetch,
      verifierResolution: async () => ({ ok: true }),
    });

    const resultat = await transport.executer(APPEL());

    expect(resultat).toMatchObject({ nature: 'reponse', httpStatus: 201, texte: '{"ok":true}' });
    expect(fetch).toHaveBeenCalledWith('https://api.client.fr/v1/action', {
      method: 'POST',
      headers: { authorization: 'Bearer SECRET', 'content-type': 'application/json' },
      body: '{"id":"42"}',
      redirect: 'error',
      signal: expect.any(AbortSignal),
    });
  });

  it('mesure le transport depuis avant la résolution DNS', async () => {
    const horloge = vi.spyOn(Date, 'now')
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(1_075);
    const transport = creerTransportConnecteurHttp({
      fetch: (async () => new Response('{}')) as unknown as typeof fetch,
      verifierResolution: async () => ({ ok: true }),
    });

    try {
      expect(await transport.executer(APPEL())).toMatchObject({ nature: 'reponse', dureeMs: 75 });
    } finally {
      horloge.mockRestore();
    }
  });

  it('normalise les refus d’adresse à la connexion', async () => {
    const transport = creerTransportConnecteurHttp({
      fetch: (async () => { throw new TypeError('fetch failed', { cause: new AdresseInterdite() }); }) as typeof fetch,
      verifierResolution: async () => ({ ok: true }),
    });

    expect(await transport.executer(APPEL())).toMatchObject({ nature: 'adresse_refusee' });
  });

  it('normalise une redirection refusée par Undici et une réponse 3xx rendue par un faux fetch', async () => {
    const parException = creerTransportConnecteurHttp({
      fetch: (async () => {
        throw new TypeError('fetch failed', { cause: new Error('unexpected redirect') });
      }) as typeof fetch,
      verifierResolution: async () => ({ ok: true }),
    });
    const parReponse = creerTransportConnecteurHttp({
      fetch: (async () => new Response('', { status: 307 })) as unknown as typeof fetch,
      verifierResolution: async () => ({ ok: true }),
    });

    expect(await parException.executer(APPEL())).toMatchObject({ nature: 'redirection_refusee' });
    expect(await parReponse.executer(APPEL())).toMatchObject({ nature: 'redirection_refusee', httpStatus: 307 });
  });

  it('classe une panne réseau sans exposer le message ni les secrets de l’exception', async () => {
    const transport = creerTransportConnecteurHttp({
      fetch: (async () => { throw new Error('Bearer SECRET vers 10.0.0.4'); }) as typeof fetch,
      verifierResolution: async () => ({ ok: true }),
    });

    const resultat = await transport.executer(APPEL());
    expect(resultat).toMatchObject({ nature: 'reseau' });
    expect(JSON.stringify(resultat)).not.toContain('SECRET');
    expect(JSON.stringify(resultat)).not.toContain('10.0.0.4');
  });

  it('classe comme abandon un signal déjà coupé et un abandon pendant la lecture', async () => {
    const dejaCoupe = new AbortController();
    dejaCoupe.abort();
    const fetch = vi.fn();
    const transportAvant = creerTransportConnecteurHttp({
      fetch: fetch as unknown as typeof globalThis.fetch,
      verifierResolution: async () => ({ ok: true }),
    });
    expect(await transportAvant.executer(APPEL({ signal: dejaCoupe.signal }))).toMatchObject({ nature: 'abandon' });
    expect(fetch).not.toHaveBeenCalled();

    const pendant = new AbortController();
    const flux = new ReadableStream<Uint8Array>({
      pull(controleur) {
        pendant.abort();
        controleur.error(new Error('socket fermée'));
      },
    });
    const transportPendant = creerTransportConnecteurHttp({
      fetch: (async () => new Response(flux)) as unknown as typeof globalThis.fetch,
      verifierResolution: async () => ({ ok: true }),
    });
    expect(await transportPendant.executer(APPEL({ signal: pendant.signal }))).toMatchObject({ nature: 'abandon' });
  });

  it('distingue un corps trop gros d’un flux interrompu', async () => {
    const tropGros = creerTransportConnecteurHttp({
      fetch: (async () => new Response('abcdef', { status: 200 })) as unknown as typeof fetch,
      verifierResolution: async () => ({ ok: true }),
    });
    expect(await tropGros.executer(APPEL({ lecture: { nature: 'texte', maxOctets: 5 } })))
      .toMatchObject({ nature: 'corps_trop_gros', httpStatus: 200 });

    const flux = new ReadableStream<Uint8Array>({
      pull(controleur) { controleur.error(new Error('flux interrompu')); },
    });
    const interrompu = creerTransportConnecteurHttp({
      fetch: (async () => new Response(flux, { status: 202 })) as unknown as typeof fetch,
      verifierResolution: async () => ({ ok: true }),
    });
    expect(await interrompu.executer(APPEL())).toMatchObject({ nature: 'corps_interrompu', httpStatus: 202 });
  });

  it('libère le flux sans le lire quand l’appelant ne demande aucun corps', async () => {
    let annule = false;
    const flux = new ReadableStream<Uint8Array>({
      cancel() { annule = true; },
    });
    const transport = creerTransportConnecteurHttp({
      fetch: (async () => new Response(flux, { status: 200 })) as unknown as typeof fetch,
      verifierResolution: async () => ({ ok: true }),
    });

    expect(await transport.executer(APPEL({ lecture: { nature: 'aucune' } })))
      .toMatchObject({ nature: 'reponse', httpStatus: 200 });
    expect(annule).toBe(true);
  });
});
