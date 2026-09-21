import { describe, it, expect } from 'vitest';
import { creerEprouverSource } from '../src/agent/eprouver-source';
import { AdresseInterdite } from '../src/lib/connexion-publique';
import type { SourceAppel } from '../src/agent/sources';

/**
 * LE BOUTON « ÉPROUVER » D'UNE SOURCE DE CONNECTEUR.
 *
 * 🔴 IL VIVAIT DANS LE CÂBLAGE DE `src/index.ts`, SANS AUCUN TEST, jusqu'au 2026-09-21. Deux de ses verdicts
 * n'étaient donc éprouvés par rien : le refus d'une adresse interne À LA CONNEXION, et la redirection refusée,
 * qui s'affichait « injoignable » alors que le résolveur de la même source disait « redirection refusée ».
 *
 * La résolution et le `fetch` sont injectés : un test unitaire qui interroge le DNS ou le réseau n'en est pas un.
 */

const SOURCE: SourceAppel = {
  id: 's1', kind: 'http', baseUrl: 'https://crm.client.fr/api', status: 'active',
  authKind: 'bearer', authHeaderName: null, authSecret: 'JETON-SECRET',
};

function monter(opts: {
  source?: SourceAppel | null;
  resolution?: { ok: boolean; raison?: string };
  reponse?: () => Promise<Response>;
} = {}) {
  const epreuves: Array<{ ok: boolean; erreur?: string }> = [];
  const appels: Array<{ url: string; auth: string | null }> = [];
  const eprouver = creerEprouverSource({
    pourAppel: async () => (opts.source === undefined ? SOURCE : opts.source),
    marquerEpreuve: async (_t, _i, ok, erreur) => { epreuves.push({ ok, ...(erreur ? { erreur } : {}) }); },
    verifierResolution: async () => opts.resolution ?? { ok: true },
    fetchImpl: (async (url: string, init?: RequestInit) => {
      appels.push({ url, auth: new Headers(init?.headers).get('authorization') });
      return (opts.reponse ?? (async () => new Response('{}', { status: 200 })))();
    }) as unknown as typeof fetch,
  });
  return { eprouver, epreuves, appels };
}

const leve = (err: unknown) => async (): Promise<Response> => { throw err; };

describe('éprouver une source', () => {
  it('un système qui répond 200 : ok, avec l’authentification de la source', async () => {
    const m = monter();
    expect(await m.eprouver('t1', 's1', '/ping')).toEqual({ ok: true, httpStatus: 200 });
    expect(m.appels).toEqual([{ url: 'https://crm.client.fr/api/ping', auth: 'Bearer JETON-SECRET' }]);
    expect(m.epreuves).toEqual([{ ok: true, erreur: 'HTTP 200' }]);
  });

  it('un 401 se dit « authentification refusée », sur la ligne comme à l’écran', async () => {
    const m = monter({ reponse: async () => new Response('', { status: 401 }) });
    expect(await m.eprouver('t1', 's1', '/ping')).toEqual({ ok: false, httpStatus: 401, erreur: 'authentification refusee' });
  });

  it('🔴 un nom qui résout vers l’intérieur : refusé AVANT l’appel', async () => {
    const m = monter({ resolution: { ok: false, raison: 'adresse interne' } });
    const r = await m.eprouver('t1', 's1', '/ping');
    expect(r).toEqual({ ok: false, erreur: 'cette adresse n est pas joignable depuis notre infrastructure' });
    expect(m.appels).toHaveLength(0);
    expect(m.epreuves).toEqual([{ ok: false, erreur: 'adresse non joignable' }]);
  });

  it('🔴 un refus d’adresse interne À LA CONNEXION rend le même verdict que la vérification préalable', async () => {
    const m = monter({ reponse: leve(new TypeError('fetch failed', { cause: new AdresseInterdite() })) });
    expect(await m.eprouver('t1', 's1', '/ping')).toEqual({ ok: false, erreur: 'cette adresse n est pas joignable depuis notre infrastructure' });
    expect(m.epreuves).toEqual([{ ok: false, erreur: 'adresse non joignable' }]);
  });

  it('🔴 une redirection refusée se dit comme telle, comme le résolveur de la même source', async () => {
    const m = monter({ reponse: leve(new TypeError('fetch failed', { cause: new Error('unexpected redirect') })) });
    expect((await m.eprouver('t1', 's1', '/ping')).ok).toBe(false);
    expect(m.epreuves).toEqual([{ ok: false, erreur: 'redirection refusée' }]);
  });

  it('une panne ordinaire reste « injoignable », sans repasser le message (il peut porter l’URL et un jeton)', async () => {
    const m = monter({ reponse: leve(new TypeError('fetch failed https://crm.client.fr/api/ping?token=SECRET')) });
    const r = await m.eprouver('t1', 's1', '/ping');
    expect(r).toEqual({ ok: false, erreur: 'systeme injoignable' });
    expect(JSON.stringify(r)).not.toContain('SECRET');
  });

  it('🔴 une source MCP, ou absente, n’est pas éprouvée en HTTP', async () => {
    for (const source of [null, { ...SOURCE, kind: 'mcp' as const }]) {
      const m = monter({ source });
      expect(await m.eprouver('t1', 's1', '/ping')).toEqual({ ok: false, erreur: 'source introuvable' });
      expect(m.appels).toHaveLength(0);
    }
  });
});
