import { describe, it, expect, vi, afterEach } from 'vitest';
import { ApiError } from './http';
import {
  adresseDeRetourSure, autoriserParGoogle, autoriserParSession, capacitesAnnoncees, continuerAvecGoogle, estDemandeExpiree,
  listerAutorisations, ouvrirConsentement, personneDe, peutAutoriserDirectement, revoquerAutorisation,
} from './oauth';
import type { Session } from './session';
import { ACTIONS_JOURNAL } from './journal';

/**
 * LA PAGE DE CONSENTEMENT DE CLAUDE ET LA LISTE DES APPLICATIONS AUTORISÉES, CE QUI SE VÉRIFIE SANS ÉCRAN.
 * Le rendu lui-même, et le clic, sont dans `e2e/autoriser.spec.ts` et `e2e/applications-autorisees.spec.ts`.
 */

type Appel = { url: string; methode: string; corps: unknown };

/**
 * Une API simulée : chaque appel est noté, et `repondeur` donne le statut et le corps selon l'adresse. Le stockage
 * est simulé aussi, pour voir si un 401 vide la session de la console.
 */
function api(repondeur: (url: string) => { status?: number; corps: unknown }): { appels: Appel[]; retirees: string[] } {
  const appels: Appel[] = [];
  const retirees: string[] = [];
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: (k: string) => { retirees.push(k); } });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    appels.push({ url, methode: (init?.method ?? 'GET').toUpperCase(), corps: init?.body ? JSON.parse(String(init.body)) : null });
    const r = repondeur(url);
    return new Response(JSON.stringify(r.corps), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
  }));
  return { appels, retirees };
}

const DEMANDE = { client: 'Claude Code', hoteDeRetour: 'localhost', droits: ['mcp:read', 'mcp:write'] };
const EXPIREE = { error: 'demande expirée ou invalide : relancez la connexion depuis Claude', code: 'demande_expiree' };
const admin: Session = { token: 'jeton-console', email: 'admin@ex.test', role: 'admin', tenantId: 't1' };

/** L'API d'une demande lisible, dont l'espace de la session s'appelle « Mon espace ». */
const demandeLisible = (nom: { status?: number; corps: unknown } = { corps: { nom: 'Mon espace' } }) => (url: string) =>
  (url.endsWith('/oauth/consentement/demande') ? { corps: DEMANDE } : url.endsWith('/tenants/t1/nom') ? nom : { status: 404, corps: {} });

describe('ouvrirConsentement : ce que la page sait avant tout clic', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('sans demande dans l’adresse : « absente », et aucun appel', async () => {
    const { appels } = api(() => ({ corps: {} }));
    expect(await ouvrirConsentement(null, admin)).toEqual({ etat: 'absente' });
    expect(await ouvrirConsentement('', admin)).toEqual({ etat: 'absente' });
    expect(appels).toEqual([]);
  });

  it('🔴 demande expirée (400 `demande_expiree`) : « expirée », et rien d’autre n’est lu', async () => {
    const { appels } = api(() => ({ status: 400, corps: EXPIREE }));
    expect(await ouvrirConsentement('d1', admin)).toEqual({ etat: 'expiree' });
    expect(appels.map((a) => a.url)).toEqual(['/api/backend/oauth/consentement/demande']);
  });

  it('une panne n’est pas une expiration : l’écran propose de réessayer, avec la phrase de la console', async () => {
    api(() => ({ status: 502, corps: null }));
    expect(await ouvrirConsentement('d1', null)).toEqual({ etat: 'erreur', message: 'Incident de notre côté (erreur 502). Réessayez dans un instant.' });
  });

  it('🔴 session admin : la demande et le nom de l’espace, et AUCUN appel d’autorisation avant le clic', async () => {
    const { appels } = api(demandeLisible());
    expect(await ouvrirConsentement('d1', admin)).toEqual({ etat: 'prete', demande: DEMANDE, espaceDirect: { tenantId: 't1', nom: 'Mon espace' } });
    expect(appels.map((a) => `${a.methode} ${a.url}`)).toEqual([
      'POST /api/backend/oauth/consentement/demande',
      'GET /api/backend/tenants/t1/nom',
    ]);
    expect(appels[0]!.corps).toEqual({ demande: 'd1' });
    expect(appels.some((a) => a.url.includes('autoriser'))).toBe(false);
  });

  it('🔴 le bouton direct seulement pour un admin : ni agent, ni manager, ni session d’observation, ni personne', async () => {
    for (const session of [
      { ...admin, role: 'agent' },
      { ...admin, role: 'manager' },
      { ...admin, observation: 'Espace observé' },
      null,
    ]) {
      const { appels } = api(demandeLisible());
      expect(await ouvrirConsentement('d1', session)).toEqual({ etat: 'prete', demande: DEMANDE, espaceDirect: null });
      // Le nom n'est même pas demandé : rien n'a été envoyé avec la session.
      expect(appels.map((a) => a.url)).toEqual(['/api/backend/oauth/consentement/demande']);
      vi.unstubAllGlobals();
    }
  });

  it('🔴 session tombée (401) ou rôle changé (403) : pas de bouton direct, et la session de la console reste', async () => {
    for (const refus of [{ status: 401, corps: { error: 'token invalide ou expiré' } }, { status: 403, corps: { error: 'réservé aux admins' } }]) {
      const { retirees } = api(demandeLisible(refus));
      expect(await ouvrirConsentement('d1', admin)).toEqual({ etat: 'prete', demande: DEMANDE, espaceDirect: null });
      expect(retirees).toEqual([]);
      vi.unstubAllGlobals();
    }
  });
});

describe('les gestes de la page : les bonnes routes, et un 401 qui ne vide jamais la session', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('Google : la demande et le jeton, puis la preuve et les espaces', async () => {
    const choix = { choix: 'preuve', nouveau: true, espaces: [{ tenantId: 't9', nom: 'Espace de Léa', admin: true }] };
    const { appels } = api(() => ({ corps: choix }));
    expect(await continuerAvecGoogle('d1', 'jeton-google')).toEqual(choix);
    expect(appels).toEqual([{ url: '/api/backend/oauth/consentement/google', methode: 'POST', corps: { demande: 'd1', idToken: 'jeton-google' } }]);
  });

  it('les deux clics « Autoriser » : la preuve et l’espace, ou la session ; l’adresse de retour remonte telle quelle', async () => {
    const adresse = 'http://localhost:5555/callback?code=mbc_x&state=s&iss=https%3A%2F%2Fapi.test';
    const { appels } = api(() => ({ corps: { adresse } }));
    expect(await autoriserParGoogle('d1', 'preuve', 't9')).toEqual({ adresse });
    expect(await autoriserParSession('t1', 'd1')).toEqual({ adresse });
    expect(appels).toEqual([
      { url: '/api/backend/oauth/consentement/autoriser', methode: 'POST', corps: { demande: 'd1', choix: 'preuve', tenantId: 't9' } },
      { url: '/api/backend/tenants/t1/oauth/autoriser', methode: 'POST', corps: { demande: 'd1' } },
    ]);
  });

  it('🔴 un 401 (jeton Google refusé, preuve ou session expirée) remonte avec sa raison, et la session reste', async () => {
    const { retirees } = api(() => ({ status: 401, corps: { error: 'connexion Google expirée : reconnectez-vous' } }));
    for (const geste of [() => continuerAvecGoogle('d1', 'j'), () => autoriserParGoogle('d1', 'p', 't9'), () => autoriserParSession('t1', 'd1')]) {
      const err = await geste().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(401);
      expect((err as ApiError).message).toBe('connexion Google expirée : reconnectez-vous');
    }
    expect(retirees).toEqual([]);
  });

  it('un refus du serveur (403, pas admin) remonte avec sa raison : c’est l’état « refus » de la page', async () => {
    api(() => ({ status: 403, corps: { error: 'seul un administrateur de l’espace peut autoriser Claude' } }));
    const err = await autoriserParGoogle('d1', 'p', 't9').catch((e: unknown) => e);
    expect((err as ApiError).status).toBe(403);
    expect((err as ApiError).message).toBe('seul un administrateur de l’espace peut autoriser Claude');
  });
});

describe('ce que la page décide seule', () => {
  it('🔴 une demande expirée se reconnaît à son code, en 400 seulement', () => {
    expect(estDemandeExpiree(new ApiError(400, 'x', EXPIREE))).toBe(true);
    expect(estDemandeExpiree(new ApiError(400, 'x', { error: 'demande requise' }))).toBe(false);
    expect(estDemandeExpiree(new ApiError(401, 'x', EXPIREE))).toBe(false);
    expect(estDemandeExpiree(new ApiError(400, 'x', null))).toBe(false);
    expect(estDemandeExpiree(new Error('demande_expiree'))).toBe(false);
  });

  it('🔴 la page ne part que vers l’hôte qu’elle a montré, et jamais vers autre chose que http ou https', () => {
    expect(adresseDeRetourSure('http://localhost:5555/callback?code=mbc_x&state=s', 'localhost')).toBe(true);
    expect(adresseDeRetourSure('http://127.0.0.1:5555/callback?code=mbc_x', '127.0.0.1')).toBe(true);
    expect(adresseDeRetourSure('https://claude.ai/api/mcp/auth_callback?code=mbc_x', 'claude.ai')).toBe(true);
    expect(adresseDeRetourSure('javascript:alert(1)//localhost', 'localhost')).toBe(false);
    // Le bon hôte sous un autre schéma : c'est le schéma seul qui refuse.
    expect(adresseDeRetourSure('javascript://localhost/%0Aalert(1)', 'localhost')).toBe(false);
    expect(adresseDeRetourSure('ftp://localhost:21/callback', 'localhost')).toBe(false);
    expect(adresseDeRetourSure('http://localhost.evil.test:1/callback', 'localhost')).toBe(false);
    expect(adresseDeRetourSure('http://localhost@evil.test/callback', 'localhost')).toBe(false);
    expect(adresseDeRetourSure('https://evil.test/?claude.ai', 'claude.ai')).toBe(false);
    expect(adresseDeRetourSure('pas une adresse', 'localhost')).toBe(false);
  });

  it('chaque droit demandé est annoncé, et seulement lui', () => {
    expect(capacitesAnnoncees(['mcp:read', 'mcp:write'])).toEqual({ lire: true, faire: true });
    expect(capacitesAnnoncees(['mcp:read'])).toEqual({ lire: true, faire: false });
    expect(capacitesAnnoncees(['mcp:write'])).toEqual({ lire: false, faire: true });
  });

  it('le bouton direct : une session admin qui n’observe pas', () => {
    expect(peutAutoriserDirectement(admin)).toBe(true);
    expect(peutAutoriserDirectement({ ...admin, role: 'agent' })).toBe(false);
    expect(peutAutoriserDirectement({ ...admin, observation: 'Client' })).toBe(false);
    expect(peutAutoriserDirectement(null)).toBe(false);
  });
});

describe('« Applications autorisées » : la liste et la révocation', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  const ligne = {
    id: 'a1', clientId: 'https://claude.ai/oauth/claude-code-client-metadata', client: 'Claude Code', userId: 'u1',
    email: 'lea@ex.test', nom: null, scopes: ['mcp:read', 'mcp:write'], creeLe: '2026-10-03T08:00:00.000Z', dernierUsageLe: null,
  };

  it('la liste se lit sur la route de l’espace, et rend ses lignes', async () => {
    const { appels } = api(() => ({ corps: { autorisations: [ligne] } }));
    expect(await listerAutorisations('t1')).toEqual([ligne]);
    expect(appels.map((a) => `${a.methode} ${a.url}`)).toEqual(['GET /api/backend/tenants/t1/oauth/autorisations']);
  });

  it('une réponse sans la liste rend une liste vide, jamais undefined (la page des clés tomberait avec)', async () => {
    api(() => ({ corps: {} }));
    expect(await listerAutorisations('t1')).toEqual([]);
  });

  it('la révocation vise l’autorisation de l’espace, en DELETE', async () => {
    const { appels } = api(() => ({ corps: { id: 'a1', revoked: true } }));
    expect(await revoquerAutorisation('t1', 'a1')).toEqual({ id: 'a1', revoked: true });
    expect(appels.map((a) => `${a.methode} ${a.url}`)).toEqual(['DELETE /api/backend/tenants/t1/oauth/autorisations/a1']);
  });

  it('⚠️ sur cette page, un 401 est une session tombée : elle se vide, comme pour les clés voisines', async () => {
    const { retirees } = api(() => ({ status: 401, corps: { error: 'token invalide ou expiré' } }));
    await listerAutorisations('t1').catch(() => null);
    expect(retirees).toContain('mba.session');
  });

  it('qui a autorisé : le nom affiché, sinon l’adresse', () => {
    expect(personneDe({ nom: 'Léa Martin', email: 'lea@ex.test' })).toBe('Léa Martin');
    expect(personneDe({ nom: null, email: 'lea@ex.test' })).toBe('lea@ex.test');
    expect(personneDe({ nom: '  ', email: 'lea@ex.test' })).toBe('lea@ex.test');
  });
});

describe('le journal des actions', () => {
  it('les deux actions de l’OAuth ont leur libellé, en français et en anglais (sinon l’écran affiche le code brut)', () => {
    for (const a of ['oauth.autorise', 'oauth.revoque']) {
      const [fr, en] = ACTIONS_JOURNAL[a] ?? ['', ''];
      expect(fr, a).not.toBe('');
      expect(en, a).not.toBe('');
    }
  });
});
