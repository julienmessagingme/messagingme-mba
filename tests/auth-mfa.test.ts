import { describe, it, expect } from 'vitest';
import { SignJWT } from 'jose';
import { buildServer } from '../src/server';
import { FakeQueue } from './fake-queue';
import { hashPasswordSync } from '../src/auth/password';
import {
  signSession, verifySession, signChoice, verifyChoice, signMfa, verifyMfa, signEnrolement, verifyEnrolement,
  type EtapeConnexion,
} from '../src/auth/token';
import { codeAuPas, pasDe } from '../src/auth/totp';
import type { AuthUser } from '../src/auth/store';
import type { AuthRouteDeps } from '../src/auth/routes';
import type { ActionMfa } from '../src/auth/mfa-routes';
import { MfaEnMemoire, UtilisateursFaux, comptesDe, connecter, identiteDe, passerLeSecondFacteur } from './mfa';

/**
 * LA DOUBLE AUTHENTIFICATION DES ADMINISTRATEURS (plan `docs/superpowers/plans/2026-09-25-mfa-admins.md`).
 *
 * 🔴 L'INVARIANT : aucune session d'admin sans second facteur, sauf par Google. Chaque test de garde ci-dessous a
 * été vérifié dans les DEUX sens (le défaut remis, l'échec constaté avec son symptôme, puis restauré).
 */

const SECRET = 'test-secret-mfa';
const HASH = hashPasswordSync('pw');
const json = { 'content-type': 'application/json' };
const ADMIN: AuthUser = { id: 'u-admin', tenantId: 't1', email: 'admin@x.fr', role: 'admin', passwordHash: HASH };
const AGENT: AuthUser = { id: 'u-agent', tenantId: 't1', email: 'agent@x.fr', role: 'agent', passwordHash: HASH };

interface Journal { identityId: string; action: ActionMfa; detail?: Record<string, unknown> }

function serveur(users: AuthUser[] = [ADMIN, AGENT], over: Partial<AuthRouteDeps> = {}) {
  const mfa = new MfaEnMemoire(comptesDe(users));
  const journal: Journal[] = [];
  const deps: AuthRouteDeps = {
    users: new UtilisateursFaux(users, mfa),
    secret: SECRET,
    mfa,
    auditMfa: async (identityId, action, detail) => { journal.push({ identityId, action, ...(detail ? { detail } : {}) }); },
    ...over,
  };
  // L'inbox donne une vraie route gardée : un jeton d'étape présenté comme session doit y rendre 401.
  const app = buildServer({
    queue: new FakeQueue(),
    auth: deps,
    inbox: {
      listConversations: async () => [],
      getConversationContext: async () => null,
      getMessages: async () => [],
      recordOutbound: async () => {},
      getTenantPhoneNumberId: async () => 'pn1',
      sendReply: async () => 'wamid.1',
      sendTemplateMessage: async () => 'wamid.2',
    },
  } as never);
  return { app, mfa, journal };
}

const post = (app: ReturnType<typeof buildServer>, url: string, payload: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url, headers: { ...json, ...headers }, payload: payload as object });
const login = (app: ReturnType<typeof buildServer>, email: string, password = 'pw') => post(app, '/auth/login', { email, password });
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
/** Un jeton est-il une session ? La preuve par une vraie route gardée, pas seulement par `verifySession`. */
async function ouvreUneSession(app: ReturnType<typeof buildServer>, jeton: string): Promise<boolean> {
  const res = await app.inject({ method: 'GET', url: '/tenants/t1/conversations', headers: bearer(jeton) });
  return res.statusCode !== 401;
}

const ETAPE: EtapeConnexion = {
  identityId: identiteDe('admin@x.fr'),
  email: 'admin@x.fr',
  comptes: [{ userId: 'u-admin', tenantId: 't1', role: 'admin', tenantName: 'Espace 1' }],
};

describe('les jetons d’étape ne sont pas des sessions', () => {
  it('🔴 verifySession refuse un jeton `mfa` et un jeton `enrolement`', async () => {
    expect(await verifySession(await signMfa(ETAPE, SECRET), SECRET)).toBeNull();
    expect(await verifySession(await signEnrolement(ETAPE, SECRET), SECRET)).toBeNull();
    // Témoin : une vraie session passe, sinon le refus ci-dessus ne prouverait rien.
    expect(await verifySession(await signSession({ userId: 'u', tenantId: 't1', role: 'admin' }, SECRET), SECRET)).not.toBeNull();
  });

  it('🔴 un jeton qui porte un `kind` n’est jamais une session, même s’il portait tenantId et role', async () => {
    // Le jour où quelqu'un « simplifierait » un jeton d'étape en y mettant tenantId et role : verifySession tient.
    const hybride = await new SignJWT({ kind: 'mfa', tenantId: 't1', role: 'admin' })
      .setProtectedHeader({ alg: 'HS256' }).setSubject('u-admin').setIssuedAt().setExpirationTime('5m')
      .sign(new TextEncoder().encode(SECRET));
    expect(await verifySession(hybride, SECRET)).toBeNull();
  });

  it('🔴 chaque vérification refuse le jeton d’un autre usage', async () => {
    const mfa = await signMfa(ETAPE, SECRET);
    const enrol = await signEnrolement(ETAPE, SECRET);
    const choix = await signChoice({ email: 'admin@x.fr', comptes: [{ userId: 'u-admin', tenantId: 't1', role: 'admin' }] }, SECRET);
    const session = await signSession({ userId: 'u-admin', tenantId: 't1', role: 'admin' }, SECRET);
    expect(await verifyMfa(mfa, SECRET)).toEqual(ETAPE);
    expect(await verifyEnrolement(enrol, SECRET)).toEqual(ETAPE);
    for (const autre of [enrol, choix, session]) expect(await verifyMfa(autre, SECRET)).toBeNull();
    for (const autre of [mfa, choix, session]) expect(await verifyEnrolement(autre, SECRET)).toBeNull();
    for (const autre of [mfa, enrol]) expect(await verifyChoice(autre, SECRET)).toBeNull();
    expect(await verifyMfa(mfa, 'un-autre-secret')).toBeNull();
  });

  it('les jetons d’étape rendus par la connexion n’ouvrent aucune route gardée', async () => {
    const { app, mfa } = serveur();
    const { enrolToken } = (await login(app, 'admin@x.fr')).json<{ enrolToken: string }>();
    expect(await ouvreUneSession(app, enrolToken)).toBe(false);
    mfa.poserFacteur('agent@x.fr');
    const { mfaToken } = (await login(app, 'agent@x.fr')).json<{ mfaToken: string }>();
    expect(await ouvreUneSession(app, mfaToken)).toBe(false);
    await app.close();
  });
});

describe('POST /auth/login et le second facteur', () => {
  it('agent sans facteur : la session d’avant, inchangée', async () => {
    const { app } = serveur();
    const b = (await login(app, 'agent@x.fr')).json<{ token: string; user: { role: string } }>();
    expect(b.user.role).toBe('agent');
    expect(await verifySession(b.token, SECRET)).toMatchObject({ userId: 'u-agent', role: 'agent' });
    await app.close();
  });

  it('🔴 admin sans facteur : un `enrolToken`, et AUCUNE session ni liste d’espaces', async () => {
    const { app, mfa } = serveur();
    const res = await login(app, 'admin@x.fr');
    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.json())).toEqual(['enrolToken']);
    // Puis l'enrôlement complet : secret, premier code, dix codes de secours, et la session.
    const fin = await passerLeSecondFacteur(app, res, mfa, 'admin@x.fr');
    expect(fin.statusCode).toBe(200);
    const b = fin.json<{ token: string; codesSecours: string[] }>();
    expect(await verifySession(b.token, SECRET)).toMatchObject({ userId: 'u-admin', tenantId: 't1', role: 'admin' });
    expect(b.codesSecours).toHaveLength(10);
    expect(mfa.estActif('admin@x.fr')).toBe(true);
    await app.close();
  });

  it('🔴 facteur actif : un `mfaToken`, puis la session après le code', async () => {
    const { app, mfa } = serveur();
    mfa.poserFacteur('admin@x.fr');
    const res = await login(app, 'admin@x.fr');
    expect(Object.keys(res.json())).toEqual(['mfaToken']);
    const fin = await passerLeSecondFacteur(app, res, mfa, 'admin@x.fr');
    expect(fin.statusCode).toBe(200);
    expect(await verifySession(fin.json<{ token: string }>().token, SECRET)).toMatchObject({ userId: 'u-admin' });
    await app.close();
  });

  it('un agent qui a posé un facteur de lui-même donne son code aussi', async () => {
    const { app, mfa } = serveur();
    mfa.poserFacteur('agent@x.fr');
    expect(Object.keys((await login(app, 'agent@x.fr')).json())).toEqual(['mfaToken']);
    await app.close();
  });

  it('🔴 plusieurs espaces : le jeton de choix n’est rendu qu’APRÈS le code', async () => {
    const deux: AuthUser[] = [ADMIN, { ...ADMIN, id: 'u-admin-2', tenantId: 't2', role: 'agent' }];
    const { app, mfa } = serveur(deux);
    mfa.poserFacteur('admin@x.fr');
    const res = await login(app, 'admin@x.fr');
    expect(Object.keys(res.json())).toEqual(['mfaToken']);
    const fin = (await passerLeSecondFacteur(app, res, mfa, 'admin@x.fr')).json<{ token?: string; choiceToken: string; workspaces: Array<{ tenantId: string }> }>();
    expect(fin.token).toBeUndefined();
    expect(fin.workspaces.map((w) => w.tenantId)).toEqual(['t1', 't2']);
    expect(await verifyChoice(fin.choiceToken, SECRET)).toMatchObject({ email: 'admin@x.fr' });
    await app.close();
  });

  it('🔴 sans magasin du second facteur, un admin n’obtient JAMAIS de session : l’absence ferme, elle n’ouvre pas', async () => {
    const { app } = serveur([ADMIN], { mfa: undefined });
    const res = await login(app, 'admin@x.fr');
    expect(Object.keys(res.json())).toEqual(['enrolToken']);
    const { enrolToken } = res.json<{ enrolToken: string }>();
    expect((await post(app, '/auth/mfa/enroler', { enrolToken })).statusCode).toBe(503);
    expect((await post(app, '/auth/mfa/activer', { enrolToken, code: '000000' })).statusCode).toBe(503);
    await app.close();
  });
});

describe('POST /auth/mfa/verifier', () => {
  async function etapeCode() {
    const s = serveur();
    const secret = s.mfa.poserFacteur('admin@x.fr');
    const { mfaToken } = (await login(s.app, 'admin@x.fr')).json<{ mfaToken: string }>();
    return { ...s, secret, mfaToken };
  }

  it('🔴 mauvais code : 401, message court, et une ligne `mfa.echec` SANS le code', async () => {
    const { app, mfaToken, journal } = await etapeCode();
    const res = await post(app, '/auth/mfa/verifier', { mfaToken, code: '000000' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'Code invalide ou expiré.' });
    await new Promise((r) => setImmediate(r));
    expect(journal).toEqual([{ identityId: identiteDe('admin@x.fr'), action: 'mfa.echec', detail: { etape: 'connexion' } }]);
    expect(JSON.stringify(journal)).not.toContain('000000');
    await app.close();
  });

  it('🔴 le même pas rejoué : 401, avec le MÊME message qu’un code faux', async () => {
    const { app, mfaToken, secret } = await etapeCode();
    const code = codeAuPas(secret, pasDe(Date.now()));
    expect((await post(app, '/auth/mfa/verifier', { mfaToken, code })).statusCode).toBe(200);
    const rejeu = await post(app, '/auth/mfa/verifier', { mfaToken, code });
    expect(rejeu.statusCode).toBe(401);
    expect(rejeu.json()).toEqual({ error: 'Code invalide ou expiré.' });
    await app.close();
  });

  it('un code hors fenêtre (deux pas en arrière) : 401', async () => {
    const { app, mfaToken, secret } = await etapeCode();
    const res = await post(app, '/auth/mfa/verifier', { mfaToken, code: codeAuPas(secret, pasDe(Date.now()) - 2) });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'Code invalide ou expiré.' });
    await app.close();
  });

  it('🔴 un code de secours est accepté UNE fois, refusé la seconde', async () => {
    const { app, mfa } = serveur();
    // Un enrôlement réel, pour tenir de vrais codes de secours.
    const fin = await passerLeSecondFacteur(app, await login(app, 'admin@x.fr'), mfa, 'admin@x.fr');
    const [premier] = fin.json<{ codesSecours: string[] }>().codesSecours;
    const tenter = async () => {
      const { mfaToken } = (await login(app, 'admin@x.fr')).json<{ mfaToken: string }>();
      return post(app, '/auth/mfa/verifier', { mfaToken, code: premier!.toLowerCase().replace('-', ' ') });
    };
    const une = await tenter();
    expect(une.statusCode).toBe(200);
    expect(une.json<{ codesSecoursRestants: number }>().codesSecoursRestants).toBe(9);
    expect(await verifySession(une.json<{ token: string }>().token, SECRET)).toMatchObject({ userId: 'u-admin' });
    const deux = await tenter();
    expect(deux.statusCode).toBe(401);
    expect(deux.json()).toEqual({ error: 'Code invalide ou expiré.' });
    await app.close();
  });

  it('🔴 jeton d’étape expiré, falsifié ou absent : 401, et aucune vérification de code', async () => {
    const { app, secret } = await etapeCode();
    const expire = await new SignJWT({ kind: 'mfa', identityId: ETAPE.identityId, email: ETAPE.email, comptes: ETAPE.comptes })
      .setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime(Math.floor(Date.now() / 1000) - 10)
      .sign(new TextEncoder().encode(SECRET));
    const code = codeAuPas(secret, pasDe(Date.now()));
    for (const mfaToken of [expire, await signMfa(ETAPE, 'autre-secret'), await signEnrolement(ETAPE, SECRET), '', undefined]) {
      const res = await post(app, '/auth/mfa/verifier', { mfaToken, code });
      expect(res.statusCode).toBe(401);
      expect(res.json<{ token?: string }>().token).toBeUndefined();
    }
    await app.close();
  });

  it('🔴 au-delà de 5 essais par minute pour une identité : 429, même avec le bon code', async () => {
    const { app, mfaToken, secret } = await etapeCode();
    for (let i = 0; i < 5; i += 1) expect((await post(app, '/auth/mfa/verifier', { mfaToken, code: '000000' })).statusCode).toBe(401);
    const res = await post(app, '/auth/mfa/verifier', { mfaToken, code: codeAuPas(secret, pasDe(Date.now())) });
    expect(res.statusCode).toBe(429);
    await app.close();
  });

  it('⚠️ l’écriture du journal d’échec n’est pas ATTENDUE sur le chemin de réponse', async () => {
    let fini = false;
    let debloquer: () => void = () => {};
    const bloque = new Promise<void>((r) => { debloquer = r; });
    const { app, mfa } = serveur([ADMIN], { auditMfa: async () => { await bloque; fini = true; } });
    mfa.poserFacteur('admin@x.fr');
    const { mfaToken } = (await login(app, 'admin@x.fr')).json<{ mfaToken: string }>();
    expect((await post(app, '/auth/mfa/verifier', { mfaToken, code: '000000' })).statusCode).toBe(401);
    expect(fini).toBe(false);
    debloquer();
    await app.close();
  });
});

describe('POST /auth/mfa/enroler et /auth/mfa/activer (enrôlement obligatoire)', () => {
  it('🔴 un jeton d’enrôlement ne REMPLACE jamais un facteur actif', async () => {
    const { app, mfa } = serveur();
    const { enrolToken } = (await login(app, 'admin@x.fr')).json<{ enrolToken: string }>();
    // Le facteur est posé entre-temps (un autre onglet) : le vieux jeton d'enrôlement ne doit plus rien pouvoir.
    const avant = mfa.poserFacteur('admin@x.fr');
    expect((await post(app, '/auth/mfa/enroler', { enrolToken })).statusCode).toBe(409);
    expect((await post(app, '/auth/mfa/activer', { enrolToken, code: '123456' })).statusCode).toBe(409);
    expect(mfa.codeSuivant('admin@x.fr')).toBe(codeAuPas(avant, pasDe(Date.now())));
    await app.close();
  });

  it('un mauvais premier code n’active rien : 401, et une ligne `mfa.echec`', async () => {
    const { app, mfa, journal } = serveur();
    const { enrolToken } = (await login(app, 'admin@x.fr')).json<{ enrolToken: string }>();
    expect((await post(app, '/auth/mfa/enroler', { enrolToken })).statusCode).toBe(200);
    expect((await post(app, '/auth/mfa/activer', { enrolToken, code: '000000' })).statusCode).toBe(401);
    expect(mfa.estActif('admin@x.fr')).toBe(false);
    await new Promise((r) => setImmediate(r));
    expect(journal.map((j) => j.action)).toEqual(['mfa.echec']);
    await app.close();
  });

  it('activer sans avoir demandé de secret : 401', async () => {
    const { app } = serveur();
    const { enrolToken } = (await login(app, 'admin@x.fr')).json<{ enrolToken: string }>();
    expect((await post(app, '/auth/mfa/activer', { enrolToken, code: '123456' })).statusCode).toBe(401);
    await app.close();
  });

  it('l’enrôlement rend le secret et l’URI de l’application, au nom du produit', async () => {
    const { app, journal, mfa } = serveur();
    const { enrolToken } = (await login(app, 'admin@x.fr')).json<{ enrolToken: string }>();
    const b = (await post(app, '/auth/mfa/enroler', { enrolToken })).json<{ secret: string; uri: string }>();
    expect(b.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(b.uri).toContain(`secret=${b.secret}`);
    expect(b.uri).toContain('issuer=Engage+Me');
    const fin = await post(app, '/auth/mfa/activer', { enrolToken, code: codeAuPas(b.secret, pasDe(Date.now())) });
    expect(fin.statusCode).toBe(200);
    expect(mfa.estActif('admin@x.fr')).toBe(true);
    await new Promise((r) => setImmediate(r));
    expect(journal.map((j) => j.action)).toEqual(['mfa.active']);
    await app.close();
  });
});

describe('inscription et invitation passent par la même porte', () => {
  function inscription(mfa: MfaEnMemoire, motDePasseExistant: Record<string, string> = {}) {
    return {
      // Une adresse déjà connue ne s'inscrit qu'avec SON mot de passe (`motDePasseDeLAdresse`).
      motDePasseDeLAdresse: async (email: string) => motDePasseExistant[email],
      createTenantWithAdmin: async (_nom: string, admin: { email: string }) => {
        mfa.ajouterCompte({ userId: 'u-neuf', tenantId: 't-neuf', role: 'admin', email: admin.email });
        return { tenantId: 't-neuf', userId: 'u-neuf' };
      },
    };
  }

  it('🔴 une inscription sur une adresse qui a DÉJÀ un facteur demande son code, pas un nouvel enrôlement', async () => {
    const mfa = new MfaEnMemoire(comptesDe([ADMIN]));
    mfa.poserFacteur('admin@x.fr');
    const { app } = serveur([ADMIN], { mfa, users: new UtilisateursFaux([ADMIN], mfa), ...inscription(mfa, { 'admin@x.fr': hashPasswordSync('motdepasse-longue') }) });
    const res = await post(app, '/auth/signup', { workspaceName: 'Deuxième', email: 'admin@x.fr', password: 'motdepasse-longue' });
    expect(res.statusCode).toBe(201);
    expect(Object.keys(res.json())).toEqual(['mfaToken']);
    await app.close();
  });

  it('🔴 une invitation d’ADMIN acceptée rend un `enrolToken`, pas une session', async () => {
    const mfa = new MfaEnMemoire([{ userId: 'u-inv', tenantId: 't1', role: 'admin', email: 'inv@x.fr' }]);
    const { app } = serveur([], {
      mfa,
      setPassword: async () => true,
      sessionUser: async () => ({ tenantId: 't1', role: 'admin', email: 'inv@x.fr' }),
      tokens: { create: async () => 'x', consume: async () => 'u-inv' },
    });
    const res = await post(app, '/auth/invitations/accept', { token: 'BON', password: 'motdepasse-longue' });
    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.json())).toEqual(['enrolToken']);
    const fin = await passerLeSecondFacteur(app, res, mfa, 'inv@x.fr');
    expect(await verifySession(fin.json<{ token: string }>().token, SECRET)).toMatchObject({ userId: 'u-inv', tenantId: 't1', role: 'admin' });
    await app.close();
  });

  it('🔴 une invitation d’AGENT pour une personne déjà admin ailleurs enrôle aussi (l’obligation suit l’identité)', async () => {
    const mfa = new MfaEnMemoire([
      { userId: 'u-inv', tenantId: 't1', role: 'agent', email: 'inv@x.fr' },
      { userId: 'u-inv-2', tenantId: 't2', role: 'admin', email: 'inv@x.fr' },
    ]);
    const { app } = serveur([], {
      mfa,
      setPassword: async () => true,
      sessionUser: async () => ({ tenantId: 't1', role: 'agent', email: 'inv@x.fr' }),
      tokens: { create: async () => 'x', consume: async () => 'u-inv' },
    });
    const res = await post(app, '/auth/invitations/accept', { token: 'BON', password: 'motdepasse-longue' });
    expect(Object.keys(res.json())).toEqual(['enrolToken']);
    await app.close();
  });
});

describe('/auth/google ne change pas (décision de Julien)', () => {
  it('un admin qui a un facteur actif entre par Google SANS étape de code', async () => {
    const mfa = new MfaEnMemoire(comptesDe([ADMIN]));
    mfa.poserFacteur('admin@x.fr');
    const { app } = serveur([ADMIN], {
      mfa,
      users: new UtilisateursFaux([ADMIN], mfa),
      verifyGoogle: async () => ({ email: 'admin@x.fr', emailVerified: true, name: 'Admin', sub: 'g-1' }),
      getUserByEmail: async () => [{ id: 'u-admin', tenantId: 't1', tenantName: 'Espace 1', role: 'admin', disabled: false }],
      createTenantWithAdmin: async () => ({ tenantId: 'x', userId: 'x' }),
    });
    const b = (await post(app, '/auth/google', { idToken: 'jeton-google' })).json<{ token: string }>();
    expect(await verifySession(b.token, SECRET)).toMatchObject({ userId: 'u-admin', role: 'admin' });
    await app.close();
  });
});

describe('/auth/mfa/moi (avec une session)', () => {
  async function sessionDe(email: string, users: AuthUser[] = [ADMIN, AGENT]) {
    const s = serveur(users);
    const res = await connecter(s.app, s.mfa, email, 'pw');
    return { ...s, jeton: res.json<{ token: string }>().token };
  }

  it('sans session : 401 partout', async () => {
    const { app } = serveur();
    expect((await app.inject({ method: 'GET', url: '/auth/mfa/moi' })).statusCode).toBe(401);
    for (const url of ['/auth/mfa/moi/enroler', '/auth/mfa/moi/activer', '/auth/mfa/moi/codes', '/auth/mfa/moi/desactiver']) {
      expect((await post(app, url, {})).statusCode, url).toBe(401);
    }
    await app.close();
  });

  it('l’enrôlement volontaire d’un agent, puis la désactivation par un code', async () => {
    const { app, mfa, jeton, journal } = await sessionDe('agent@x.fr');
    const etat = (await app.inject({ method: 'GET', url: '/auth/mfa/moi', headers: bearer(jeton) })).json();
    expect(etat).toEqual({ actif: false, activeLe: null, codesSecoursRestants: 0, obligatoire: false });
    const { secret } = (await post(app, '/auth/mfa/moi/enroler', {}, bearer(jeton))).json<{ secret: string }>();
    const act = await post(app, '/auth/mfa/moi/activer', { code: codeAuPas(secret, pasDe(Date.now())) }, bearer(jeton));
    expect(act.json<{ codesSecours: string[] }>().codesSecours).toHaveLength(10);
    expect(mfa.estActif('agent@x.fr')).toBe(true);
    // Désactiver exige un code : sans lui, 401 et rien ne bouge.
    expect((await post(app, '/auth/mfa/moi/desactiver', { code: '000000' }, bearer(jeton))).statusCode).toBe(401);
    expect(mfa.estActif('agent@x.fr')).toBe(true);
    expect((await post(app, '/auth/mfa/moi/desactiver', { code: mfa.codeSuivant('agent@x.fr') }, bearer(jeton))).statusCode).toBe(200);
    expect(mfa.estActif('agent@x.fr')).toBe(false);
    await new Promise((r) => setImmediate(r));
    expect(journal.map((j) => j.action)).toEqual(['mfa.active', 'mfa.echec', 'mfa.desactive']);
    await app.close();
  });

  it('🔴 un admin ne peut PAS désactiver son facteur, même avec un code juste', async () => {
    const { app, mfa, jeton } = await sessionDe('admin@x.fr');
    const res = await post(app, '/auth/mfa/moi/desactiver', { code: mfa.codeSuivant('admin@x.fr') }, bearer(jeton));
    expect(res.statusCode).toBe(403);
    expect(mfa.estActif('admin@x.fr')).toBe(true);
    await app.close();
  });

  it('🔴 régénérer les codes exige un code, et les anciens cessent de valoir', async () => {
    const s = serveur();
    const fin = await passerLeSecondFacteur(s.app, await login(s.app, 'admin@x.fr'), s.mfa, 'admin@x.fr');
    const { token, codesSecours: anciens } = fin.json<{ token: string; codesSecours: string[] }>();
    expect((await post(s.app, '/auth/mfa/moi/codes', { code: '000000' }, bearer(token))).statusCode).toBe(401);
    const neufs = await post(s.app, '/auth/mfa/moi/codes', { code: s.mfa.codeSuivant('admin@x.fr') }, bearer(token));
    expect(neufs.json<{ codesSecours: string[] }>().codesSecours).toHaveLength(10);
    const { mfaToken } = (await login(s.app, 'admin@x.fr')).json<{ mfaToken: string }>();
    expect((await post(s.app, '/auth/mfa/verifier', { mfaToken, code: anciens[0] })).statusCode).toBe(401);
    await s.app.close();
  });

  it('l’enrôlement volontaire est refusé quand un facteur est déjà actif', async () => {
    const { app, jeton } = await sessionDe('admin@x.fr');
    expect((await post(app, '/auth/mfa/moi/enroler', {}, bearer(jeton))).statusCode).toBe(409);
    await app.close();
  });
});
