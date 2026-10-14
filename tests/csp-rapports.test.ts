import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { extraireRapports, normaliserBloque, normaliserChemin, MAX_RAPPORTS_PAR_REQUETE, type RapportCsp } from '../src/csp/rapports';
import { registerCspRapports } from '../src/http/csp-rapports';

/**
 * LE COLLECTEUR DES RAPPORTS CSP (lot 6 B3) : ce qu'on garde d'un rapport, ce qu'on ignore, et que la route ne rend
 * jamais rien.
 */
const CONSOLE = 'https://console.messagingme.app';
const ORIGINES = [CONSOLE, 'https://mba.messagingme.app'];

const rapportUri = (document: string, extra: Record<string, string> = {}) => ({
  'csp-report': {
    'document-uri': document,
    'effective-directive': 'connect-src',
    'violated-directive': 'connect-src',
    'blocked-uri': 'https://api.messagingme.app/auth/config?jeton=secret',
    disposition: 'report',
    'original-policy': "default-src 'self'",
    ...extra,
  },
});

describe('extraireRapports', () => {
  it('🔴 le format `report-uri` : la règle, l’ORIGINE bloquée et le CHEMIN de la page, rien d’autre', () => {
    const r = extraireRapports(rapportUri(`${CONSOLE}/reset-password?token=abc#x`), ORIGINES);
    expect(r).toEqual([{ directive: 'connect-src', bloque: 'https://api.messagingme.app', page: '/reset-password', disposition: 'report' }]);
    // Ni le jeton de la page, ni la requête de la ressource bloquée.
    expect(JSON.stringify(r)).not.toMatch(/abc|secret|token|jeton/);
  });

  it('la Reporting API : seuls les `csp-violation` comptent', () => {
    const corps = [
      { type: 'csp-violation', body: { documentURL: `${CONSOLE}/inbox`, effectiveDirective: 'style-src-elem', blockedURL: 'inline', disposition: 'enforce' } },
      { type: 'deprecation', body: { documentURL: `${CONSOLE}/inbox` } },
    ];
    expect(extraireRapports(corps, ORIGINES)).toEqual([{ directive: 'style-src-elem', bloque: 'inline', page: '/inbox', disposition: 'enforce' }]);
  });

  it('🔴 une page d’une autre origine ne compte pas : un faux rapport ne remplit pas la table', () => {
    expect(extraireRapports(rapportUri('https://ailleurs.example/page'), ORIGINES)).toEqual([]);
    expect(extraireRapports(rapportUri('pas une adresse'), ORIGINES)).toEqual([]);
  });

  it('un corps illisible, ou une règle qui n’en est pas une, n’en donne aucun', () => {
    for (const corps of [null, 'texte', 42, {}, { 'csp-report': {} }, [{ type: 'csp-violation' }]]) {
      expect(extraireRapports(corps, ORIGINES), JSON.stringify(corps)).toEqual([]);
    }
    expect(extraireRapports(rapportUri(`${CONSOLE}/`, { 'effective-directive': 'pas;une règle', 'violated-directive': '' }), ORIGINES)).toEqual([]);
  });

  it('🔴 une règle inventée ne compte pas : la liste des règles est fermée', () => {
    expect(extraireRapports(rapportUri(`${CONSOLE}/`, { 'effective-directive': 'bruit-invente', 'violated-directive': '' }), ORIGINES)).toEqual([]);
  });

  it('une adresse de page très longue se réduit au lieu d’être refusée (la requête est jetée de toute façon)', () => {
    const r = extraireRapports(rapportUri(`${CONSOLE}/autoriser?demande=${'x'.repeat(5000)}`), ORIGINES);
    expect(r[0]?.page).toBe('/autoriser');
  });

  it('la règle se lit dans `violated-directive` quand l’effective manque, sans sa valeur', () => {
    const r = extraireRapports({ 'csp-report': { 'document-uri': `${CONSOLE}/`, 'violated-directive': "img-src 'self' https:" } }, ORIGINES);
    expect(r[0]?.directive).toBe('img-src');
  });

  it('une requête porte au plus vingt rapports', () => {
    const corps = Array.from({ length: 60 }, () => ({ type: 'csp-violation', body: { documentURL: `${CONSOLE}/x`, effectiveDirective: 'img-src', blockedURL: 'data' } }));
    expect(extraireRapports(corps, ORIGINES)).toHaveLength(MAX_RAPPORTS_PAR_REQUETE);
  });
});

describe('normaliser', () => {
  it('🔴 les identifiants d’un chemin deviennent `:id`', () => {
    expect(normaliserChemin('/contacts/3f2a1b4c-1d2e-4f5a-8b9c-0d1e2f3a4b5c')).toBe('/contacts/:id');
    expect(normaliserChemin('/campaigns/12345/edit')).toBe('/campaigns/:id/edit');
    expect(normaliserChemin('/r/abcdefghjkmnpqrstvwxyz0123')).toBe('/r/:id');
    expect(normaliserChemin('/agents')).toBe('/agents');
    expect(normaliserChemin('')).toBe('/');
    // Hors de l'alphabet stocké, un caractère devient `_` : la table se lit par des requêtes écrites à la main.
    expect(normaliserChemin("/agents/l'outil;drop")).toBe('/agents/l_outil_drop');
  });

  it('ce qui a été bloqué : l’origine, ou un mot-clé', () => {
    expect(normaliserBloque('https://connect.facebook.net/fr_FR/sdk.js?v=1')).toBe('https://connect.facebook.net');
    expect(normaliserBloque('data:image/png;base64,AAAA')).toBe('data');
    expect(normaliserBloque('blob:https://console.messagingme.app/1234')).toBe('blob');
    expect(normaliserBloque('eval')).toBe('eval');
    expect(normaliserBloque('')).toBe('inconnu');
    expect(normaliserBloque('chrome-extension://abc/x.js')).toBe('autre');
    expect(normaliserBloque('mot-cle-invente')).toBe('autre');
    expect(normaliserBloque('data')).toBe('data');
  });
});

describe('POST /csp-rapports', () => {
  const monter = (noter: (r: RapportCsp) => Promise<void>) => {
    const app = Fastify();
    registerCspRapports(app, { origines: ORIGINES, noter });
    return app;
  };

  it('🔴 un rapport retenu est noté, dans les deux types des navigateurs, et la réponse est 204 sans corps', async () => {
    const notes: RapportCsp[] = [];
    const app = monter(async (r) => { notes.push(r); });
    for (const type of ['application/csp-report', 'application/json']) {
      const res = await app.inject({ method: 'POST', url: '/csp-rapports', headers: { 'content-type': type }, payload: JSON.stringify(rapportUri(`${CONSOLE}/accueil`)) });
      expect(res.statusCode, type).toBe(204);
      expect(res.body).toBe('');
    }
    const res = await app.inject({
      method: 'POST', url: '/csp-rapports', headers: { 'content-type': 'application/reports+json' },
      payload: JSON.stringify([{ type: 'csp-violation', body: { documentURL: `${CONSOLE}/accueil`, effectiveDirective: 'connect-src', blockedURL: 'https://api.messagingme.app/x' } }]),
    });
    expect(res.statusCode).toBe(204);
    expect(notes).toHaveLength(3);
    expect(notes[0]).toEqual({ directive: 'connect-src', bloque: 'https://api.messagingme.app', page: '/accueil', disposition: 'report' });
    await app.close();
  });

  it('🔴 refusé, illisible ou en panne : TOUJOURS 204, rien ne se distingue', async () => {
    const app = monter(async () => { throw new Error('base indisponible'); });
    const essais = [
      { type: 'application/csp-report', corps: JSON.stringify(rapportUri('https://ailleurs.example/')) },
      { type: 'application/csp-report', corps: '{pas du json' },
      { type: 'application/reports+json', corps: '[]' },
      { type: 'application/csp-report', corps: JSON.stringify(rapportUri(`${CONSOLE}/`)) },
    ];
    for (const e of essais) {
      const res = await app.inject({ method: 'POST', url: '/csp-rapports', headers: { 'content-type': e.type }, payload: e.corps });
      expect(res.statusCode, e.corps).toBe(204);
      expect(res.body).toBe('');
    }
    await app.close();
  });

  it('🔴 une base en panne arrête la requête au premier échec, sans changer la réponse', async () => {
    let appels = 0;
    const app = monter(async () => { appels += 1; throw new Error('base muette'); });
    const corps = Array.from({ length: 5 }, () => ({ type: 'csp-violation', body: { documentURL: `${CONSOLE}/x`, effectiveDirective: 'img-src', blockedURL: 'data' } }));
    const res = await app.inject({ method: 'POST', url: '/csp-rapports', headers: { 'content-type': 'application/reports+json' }, payload: JSON.stringify(corps) });
    expect(res.statusCode).toBe(204);
    expect(appels).toBe(1);
    await app.close();
  });

  it('un corps trop gros est refusé avant d’être lu', async () => {
    const app = monter(async () => undefined);
    const res = await app.inject({ method: 'POST', url: '/csp-rapports', headers: { 'content-type': 'application/csp-report' }, payload: 'x'.repeat(40_000) });
    expect(res.statusCode).toBe(413);
    await app.close();
  });

  it('au-delà du plafond, les rapports ne sont plus écrits, et la réponse ne change pas', async () => {
    let notes = 0;
    const app = monter(async () => { notes += 1; });
    const corps = JSON.stringify(rapportUri(`${CONSOLE}/accueil`));
    for (let i = 0; i < 605; i += 1) {
      const res = await app.inject({ method: 'POST', url: '/csp-rapports', headers: { 'content-type': 'application/csp-report' }, payload: corps });
      expect(res.statusCode).toBe(204);
    }
    expect(notes).toBe(600);
    await app.close();
  });

  it('🔴 le plafond compte les RAPPORTS, pas les requêtes : vingt par requête usent vingt places', async () => {
    let notes = 0;
    const app = monter(async () => { notes += 1; });
    const corps = JSON.stringify(Array.from({ length: 20 }, () => ({ type: 'csp-violation', body: { documentURL: `${CONSOLE}/x`, effectiveDirective: 'img-src', blockedURL: 'data' } })));
    for (let i = 0; i < 31; i += 1) {
      await app.inject({ method: 'POST', url: '/csp-rapports', headers: { 'content-type': 'application/reports+json' }, payload: corps });
    }
    expect(notes).toBe(600);
    await app.close();
  });
});
