import { describe, it, expect } from 'vitest';
import { SignJWT } from 'jose';
import { buildServer } from '../src/server';
import { FakeQueue } from './fake-queue';
import { hashPasswordSync } from '../src/auth/password';
import { signSession, verifySession, signSessionOps, verifySessionOps, signMfa } from '../src/auth/token';
import type { OpsRouteDeps } from '../src/http/ops';
import type { AuthRouteDeps } from '../src/auth/routes';
import type { AuthUser } from '../src/auth/store';
import type { GoogleIdentity } from '../src/auth/google';
import { exploitationInerte, opsInerte } from './routes-inertes';
import { accesOps, ADRESSE_OPS, EXPLOITANT, MOT_DE_PASSE_OPS, SECRET_OPS } from './acces-ops';
import { identiteDe, passerLeSecondFacteur } from './mfa';
import { capturerJournal } from './journal';
import { schema } from '../src/config';

/**
 * `/ops` NOMINATIF, AVEC SECOND FACTEUR (plan `docs/superpowers/plans/2026-09-28-ops-nominatif.md`).
 *
 * 🔴 L'accès le plus puissant du produit (tous les espaces, crédits, prix, verrous, rejeu, observation) ne
 * s'ouvre plus avec un jeton partagé : une adresse de `OPS_EMAILS`, son compte habituel, son second facteur, et
 * une session d'exploitation relue à chaque requête. Chaque garde ci-dessous a été vérifiée dans les DEUX sens :
 * le défaut remis, l'échec constaté avec son symptôme, puis restauré (le détail est dans le compte rendu du lot).
 */

const json = { 'content-type': 'application/json' };
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
const T = '11111111-1111-4111-8111-111111111111';

const HASH = hashPasswordSync('mot-de-passe-du-voisin');
/** Un admin d'espace, hors de la liste : il a tout ce qu'il faut pour un espace, rien pour `/ops`. */
const ADMIN: AuthUser = { id: 'u-admin', tenantId: 't-client', email: 'admin@client.test', role: 'admin', passwordHash: HASH };
/** Une adresse de la liste SANS facteur : elle doit être enrôlée, jamais entrer sur le seul mot de passe. */
const SANS_FACTEUR: AuthUser = { id: 'u-neuf', tenantId: 't-exploitation', email: 'neuf@exploitation.test', role: 'agent', passwordHash: HASH };

function serveur(options: Parameters<typeof accesOps>[0] = {}, ops: Partial<OpsRouteDeps> = {}) {
  const acces = accesOps({ autres: [ADMIN, SANS_FACTEUR], ...options });
  const deps: OpsRouteDeps = {
    ...opsInerte,
    exploitation: { ...exploitationInerte, getTenantOverview: async () => [], getGlobalDaily: async () => [], getQueueLoad: async () => [] },
    ...ops,
  };
  // Une vraie route d'espace, pour éprouver l'autre sens de la séparation.
  const app = buildServer({
    queue: new FakeQueue(),
    auth: acces.auth,
    ops: deps,
    me: { getById: async () => ({ email: ADRESSE_OPS, name: null, role: 'agent' }) },
  });
  return { app, acces };
}

const post = (app: ReturnType<typeof buildServer>, url: string, payload: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url, headers: { ...json, ...headers }, payload: payload as object });
const overview = (app: ReturnType<typeof buildServer>, headers: Record<string, string> = {}) =>
  app.inject({ method: 'GET', url: '/ops/overview', headers });

describe('la connexion d’exploitation', () => {
  it('🔴 le mot de passe seul n’ouvre rien : il rend l’étape du CODE, jamais une session', async () => {
    const { app } = serveur();
    const res = await post(app, '/auth/login', { email: ADRESSE_OPS, password: MOT_DE_PASSE_OPS, ops: true });
    expect(res.statusCode).toBe(200);
    const corps = res.json<Record<string, unknown>>();
    expect(Object.keys(corps)).toEqual(['mfaToken']);
    // Le jeton d'étape n'ouvre pas `/ops`.
    expect((await overview(app, bearer(String(corps.mfaToken)))).statusCode).toBe(401);
    await app.close();
  });

  it('🔴 le code juste rend une session d’EXPLOITATION, et elle ouvre `/ops`', async () => {
    const { app, acces } = serveur();
    const res = await post(app, '/auth/login', { email: ADRESSE_OPS, password: MOT_DE_PASSE_OPS, ops: true });
    const fin = await passerLeSecondFacteur(app, res, acces.mfa, ADRESSE_OPS);
    expect(fin.statusCode).toBe(200);
    const corps = fin.json<{ sessionOps: string; email: string; token?: unknown }>();
    expect(corps.email).toBe(ADRESSE_OPS);
    expect(corps.token, 'jamais une session d’espace au bout d’une connexion d’exploitation').toBeUndefined();
    expect(await verifySessionOps(corps.sessionOps, SECRET_OPS)).toEqual({ identityId: identiteDe(ADRESSE_OPS), email: ADRESSE_OPS, facteur: 'totp' });
    expect((await overview(app, bearer(corps.sessionOps))).statusCode).toBe(200);
    await app.close();
  });

  it('🔴 un code FAUX : 401, et aucune session', async () => {
    const { app } = serveur();
    const res = await post(app, '/auth/login', { email: ADRESSE_OPS, password: MOT_DE_PASSE_OPS, ops: true });
    const faux = await post(app, '/auth/mfa/verifier', { mfaToken: res.json<{ mfaToken: string }>().mfaToken, code: '000000' });
    expect(faux.statusCode).toBe(401);
    expect(faux.body).not.toContain('sessionOps');
    await app.close();
  });

  it('🔴 une adresse de la liste SANS facteur est enrôlée, et n’entre qu’après son premier code', async () => {
    const { app, acces } = serveur({ liste: [ADRESSE_OPS, SANS_FACTEUR.email] });
    const res = await post(app, '/auth/login', { email: SANS_FACTEUR.email, password: 'mot-de-passe-du-voisin', ops: true });
    // Un agent sans facteur, hors de l'exploitation, entrerait directement dans son espace : ici, non.
    expect(Object.keys(res.json())).toEqual(['enrolToken']);
    const fin = await passerLeSecondFacteur(app, res, acces.mfa, SANS_FACTEUR.email);
    expect(fin.statusCode).toBe(200);
    const corps = fin.json<{ sessionOps: string; codesSecours: string[] }>();
    expect(corps.codesSecours).toHaveLength(10);
    expect((await overview(app, bearer(corps.sessionOps))).statusCode).toBe(200);
    await app.close();
  });

  it('🔴 une adresse HORS de la liste : 403 après le mot de passe, et aucune étape', async () => {
    const { app } = serveur();
    const res = await post(app, '/auth/login', { email: ADMIN.email, password: 'mot-de-passe-du-voisin', ops: true });
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toMatch(/mfaToken|enrolToken|sessionOps/);
    await app.close();
  });

  it('🔴 liste VIDE : personne n’entre, même avec son mot de passe', async () => {
    const { app } = serveur({ liste: [] });
    const res = await post(app, '/auth/login', { email: ADRESSE_OPS, password: MOT_DE_PASSE_OPS, ops: true });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('un mauvais mot de passe reste le 401 de la connexion : la liste ne se devine pas', async () => {
    const { app } = serveur();
    const res = await post(app, '/auth/login', { email: ADRESSE_OPS, password: 'pas-le-bon-mot-de-passe', ops: true });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('la liste se compare sans la casse, des deux côtés', async () => {
    const { app, acces } = serveur({ liste: ['  EXPLOITANT@Exploitation.TEST '] });
    const res = await post(app, '/auth/login', { email: ADRESSE_OPS, password: MOT_DE_PASSE_OPS, ops: true });
    const fin = await passerLeSecondFacteur(app, res, acces.mfa, ADRESSE_OPS);
    expect((await overview(app, bearer(fin.json<{ sessionOps: string }>().sessionOps))).statusCode).toBe(200);
    await app.close();
  });

  it('🔴 sans `ops: true`, la même adresse ouvre son ESPACE, jamais `/ops`', async () => {
    const { app, acces } = serveur();
    const res = await post(app, '/auth/login', { email: ADRESSE_OPS, password: MOT_DE_PASSE_OPS });
    const fin = await passerLeSecondFacteur(app, res, acces.mfa, ADRESSE_OPS);
    const corps = fin.json<{ token: string; sessionOps?: unknown }>();
    expect(corps.sessionOps).toBeUndefined();
    expect((await overview(app, bearer(corps.token))).statusCode).toBe(401);
    await app.close();
  });

  it('🔴 un jeton de CODE ordinaire (sans la marque d’exploitation) ne mène jamais à `/ops`', async () => {
    // La marque est signée avec le reste de l'étape : un jeton d'étape d'espace ne devient pas une entrée.
    const { app, acces } = serveur();
    const etape = { identityId: identiteDe(ADRESSE_OPS), email: ADRESSE_OPS, comptes: [{ userId: EXPLOITANT.id, tenantId: EXPLOITANT.tenantId, role: 'agent' }] };
    const fin = await post(app, '/auth/mfa/verifier', { mfaToken: await signMfa(etape, SECRET_OPS), code: acces.mfa.codeSuivant(ADRESSE_OPS) });
    expect(fin.statusCode).toBe(200);
    expect(fin.json<{ sessionOps?: unknown; token?: unknown }>().sessionOps).toBeUndefined();
    await app.close();
  });
});

describe('une adresse d’exploitation ne naît pas par l’inscription libre', () => {
  /** Des comptes où l'adresse n'existe pas encore : l'inscription créerait l'identité, avec le mot de passe de l'appelant. */
  function inscription(liste: string[]) {
    const crees: string[] = [];
    const { app } = serveur({
      liste,
      auth: {
        comptes: {
          motDePasseDeLAdresse: async () => undefined,
          createTenantWithAdmin: async (_nom: string, a: { email: string }) => { crees.push(a.email); return { tenantId: 't-squat', userId: 'u-squat' }; },
        },
      },
    });
    return { app, crees };
  }
  const corps = (email: string) => ({ workspaceName: 'Espace', email, password: 'un-mot-de-passe-long', name: null });

  it('🔴 une adresse de la liste SANS compte : 409 comme une adresse prise, et rien n’est créé', async () => {
    // Sans ce refus, un tiers crée le compte d'un futur exploitant, pose son propre facteur et ouvre `/ops`.
    const { app, crees } = inscription([ADRESSE_OPS, 'futur@exploitation.test']);
    const res = await post(app, '/auth/signup', corps('Futur@Exploitation.test'));
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'un compte existe déjà avec cet email' });
    expect(crees).toEqual([]);
    await app.close();
  });

  it('une adresse hors de la liste s’inscrit comme avant', async () => {
    const { app, crees } = inscription([ADRESSE_OPS]);
    const res = await post(app, '/auth/signup', corps('client@ailleurs.test'));
    expect(crees).toEqual(['client@ailleurs.test']);
    expect(res.statusCode).not.toBe(409);
    await app.close();
  });
});

describe('la connexion d’exploitation par Google', () => {
  const google = (idToken: string): Promise<GoogleIdentity | null> => {
    if (idToken === 'OPS') return Promise.resolve({ email: ADRESSE_OPS, name: null, emailVerified: true, sub: 'g-ops' });
    if (idToken === 'ADMIN') return Promise.resolve({ email: ADMIN.email, name: null, emailVerified: true, sub: 'g-admin' });
    if (idToken === 'INCONNU') return Promise.resolve({ email: 'inconnu@exploitation.test', name: null, emailVerified: true, sub: 'g-x' });
    return Promise.resolve(null);
  };
  function serveurGoogle(liste = [ADRESSE_OPS, 'inconnu@exploitation.test']) {
    const crees: string[] = [];
    const auth: Partial<AuthRouteDeps> = {
      verifyGoogle: google,
      googleClientId: 'client',
      comptes: {
        getByEmail: async (email) => [EXPLOITANT, ADMIN].filter((u) => u.email === email)
          .map((u) => ({ id: u.id, tenantId: u.tenantId, tenantName: 'Espace', role: u.role, disabled: false })),
        createTenantWithAdmin: async (nom) => { crees.push(nom); return { tenantId: 't-neuf', userId: 'u-neuf' }; },
      },
    };
    return { ...serveur({ liste, auth }), crees };
  }

  it('🔴 Google prouve l’adresse, jamais le second facteur : il rend l’étape du CODE', async () => {
    const { app, acces } = serveurGoogle();
    const res = await post(app, '/auth/google', { idToken: 'OPS', ops: true });
    expect(Object.keys(res.json())).toEqual(['mfaToken']);
    const fin = await passerLeSecondFacteur(app, res, acces.mfa, ADRESSE_OPS);
    expect((await overview(app, bearer(fin.json<{ sessionOps: string }>().sessionOps))).statusCode).toBe(200);
    await app.close();
  });

  it('🔴 hors de la liste : 403 ; une adresse inconnue : 403, et AUCUN espace n’est créé', async () => {
    const { app, crees } = serveurGoogle();
    expect((await post(app, '/auth/google', { idToken: 'ADMIN', ops: true })).statusCode).toBe(403);
    const inconnu = await post(app, '/auth/google', { idToken: 'INCONNU', ops: true });
    expect(inconnu.statusCode).toBe(403);
    expect(crees).toEqual([]);
    await app.close();
  });
});

describe('la garde de `/ops`, à chaque requête', () => {
  it('🔴 une adresse RETIRÉE de la liste perd l’accès à la requête suivante', async () => {
    const { app, acces } = serveur();
    const entetes = await acces.entetes(app);
    expect((await overview(app, entetes)).statusCode).toBe(200);
    acces.liste.splice(0, acces.liste.length);
    expect((await overview(app, entetes)).statusCode).toBe(401);
    await app.close();
  });

  it('🔴 un second facteur RETIRÉ après l’émission : refus', async () => {
    const { app, acces } = serveur();
    const entetes = await acces.entetes(app);
    expect((await overview(app, entetes)).statusCode).toBe(200);
    await acces.mfa.desactiver(identiteDe(ADRESSE_OPS));
    expect((await overview(app, entetes)).statusCode).toBe(401);
    await app.close();
  });

  it('🔴 liste VIDE : même une session parfaitement signée est refusée', async () => {
    const { app } = serveur({ liste: [] });
    const jeton = await signSessionOps({ identityId: identiteDe(ADRESSE_OPS), email: ADRESSE_OPS, facteur: 'totp' }, SECRET_OPS);
    expect((await overview(app, bearer(jeton))).statusCode).toBe(401);
    await app.close();
  });

  it('🔴 l’adresse qui compte est celle de la BASE, pas celle que le jeton annonce', async () => {
    // Une session bien signée qui annonce une adresse de la liste mais désigne une identité qui n'y est pas.
    // Cette identité a un facteur ACTIF : seule l'adresse relue en base peut la refuser.
    const { app, acces } = serveur();
    acces.mfa.poserFacteur(ADMIN.email);
    const jeton = await signSessionOps({ identityId: identiteDe(ADMIN.email), email: ADRESSE_OPS, facteur: 'totp' }, SECRET_OPS);
    expect((await overview(app, bearer(jeton))).statusCode).toBe(401);
    await app.close();
  });

  it('🔴 une session d’ESPACE, même d’admin et au même secret, n’ouvre pas `/ops`', async () => {
    const { app } = serveur();
    const jeton = await signSession({ userId: ADMIN.id, tenantId: ADMIN.tenantId, role: 'admin' }, SECRET_OPS);
    expect((await overview(app, bearer(jeton))).statusCode).toBe(401);
    await app.close();
  });

  it('🔴 une session d’EXPLOITATION n’ouvre aucune route d’espace', async () => {
    const { app, acces } = serveur();
    const ops = await acces.jeton(app);
    expect((await app.inject({ method: 'GET', url: `/tenants/${EXPLOITANT.tenantId}/me`, headers: bearer(ops) })).statusCode).toBe(401);
    // Témoin : une session d'espace passe, sinon le refus ci-dessus ne prouverait rien.
    const espace = await signSession({ userId: EXPLOITANT.id, tenantId: EXPLOITANT.tenantId, role: 'agent' }, SECRET_OPS);
    expect((await app.inject({ method: 'GET', url: `/tenants/${EXPLOITANT.tenantId}/me`, headers: bearer(espace) })).statusCode).toBe(200);
    await app.close();
  });

  it('🔴 l’ancien en-tête `x-ops-token`, seul : 401', async () => {
    const { app } = serveur();
    for (const valeur of ['x'.repeat(32), SECRET_OPS, '']) {
      expect((await overview(app, { 'x-ops-token': valeur })).statusCode).toBe(401);
    }
    await app.close();
  });

  it('🔴 sans la preuve du facteur, ce n’est pas une session d’exploitation', async () => {
    // Même secret, même portée, mais sans le moyen qui a prouvé le second facteur.
    const cle = new TextEncoder().encode(SECRET_OPS);
    const sansFacteur = await new SignJWT({ kind: 'ops', email: ADRESSE_OPS })
      .setProtectedHeader({ alg: 'HS256' }).setSubject(identiteDe(ADRESSE_OPS)).setIssuedAt().setExpirationTime('1h').sign(cle);
    expect(await verifySessionOps(sansFacteur, SECRET_OPS)).toBeNull();
    const { app } = serveur();
    expect((await overview(app, bearer(sansFacteur))).statusCode).toBe(401);
    await app.close();
  });

  it('🔴 sans la portée `ops`, une adresse et un facteur ne font pas une session d’exploitation', async () => {
    const cle = new TextEncoder().encode(SECRET_OPS);
    const sansPortee = await new SignJWT({ email: ADRESSE_OPS, facteur: 'totp' })
      .setProtectedHeader({ alg: 'HS256' }).setSubject(identiteDe(ADRESSE_OPS)).setIssuedAt().setExpirationTime('1h').sign(cle);
    expect(await verifySessionOps(sansPortee, SECRET_OPS)).toBeNull();
    const { app } = serveur();
    expect((await overview(app, bearer(sansPortee))).statusCode).toBe(401);
    await app.close();
  });

  it('les deux portées se refusent l’une l’autre, au niveau du jeton', async () => {
    const ops = await signSessionOps({ identityId: 'i', email: ADRESSE_OPS, facteur: 'secours' }, SECRET_OPS);
    const espace = await signSession({ userId: 'u', tenantId: 't', role: 'admin' }, SECRET_OPS);
    expect(await verifySession(ops, SECRET_OPS)).toBeNull();
    expect(await verifySessionOps(espace, SECRET_OPS)).toBeNull();
    expect(await verifySessionOps(ops, SECRET_OPS)).toMatchObject({ facteur: 'secours' });
  });
});

describe('OPS_EMAILS, au chargement de la configuration', () => {
  it('🔴 une liste mal formée refuse de démarrer plutôt que de fermer l’accès sans rien dire', () => {
    for (const valeur of ['', 'julien@messagingme.fr', ' a@b.fr , c@d.io ']) {
      expect(schema.safeParse({ OPS_EMAILS: valeur }).success, valeur).toBe(true);
    }
    for (const valeur of ['julien@messagingme.fr;autre@x.fr', 'julien', 'julien@messagingme']) {
      expect(schema.safeParse({ OPS_EMAILS: valeur }).success, valeur).toBe(false);
    }
  });

  it('🔴 `OPS_TOKEN` n’existe plus : le poser ne rouvre rien', () => {
    expect(Object.keys(schema.shape)).not.toContain('OPS_TOKEN');
  });
});

describe('chaque écriture d’exploitation porte l’adresse de son auteur', () => {
  it('🔴 une recharge : la note gardée en base est signée, et la ligne de journal nomme l’auteur', async () => {
    const notes: string[] = [];
    const { app, acces } = serveur({}, { rechargerAgent: async (_t, montant, note) => { notes.push(note); return montant; } });
    const entetes = await acces.entetes(app);
    const { resultat: res, lignes } = await capturerJournal(() =>
      post(app, `/ops/credits/${T}`, { montantMicroEur: 5_000_000, note: 'virement du 28/09' }, entetes));
    expect(res.statusCode).toBe(200);
    expect(notes).toEqual([`${ADRESSE_OPS} : virement du 28/09`]);
    expect(lignes.find((l) => l.msg === 'ops_recharge_agent')).toMatchObject({ par: ADRESSE_OPS, note: 'virement du 28/09' });
    await app.close();
  });

  it('🔴 la connexion elle-même laisse sa trace, avec l’adresse et le moyen', async () => {
    const { app, acces } = serveur();
    const { lignes } = await capturerJournal(() => acces.jeton(app));
    expect(lignes.find((l) => l.msg === 'ops_connexion')).toMatchObject({ par: ADRESSE_OPS, facteur: 'totp' });
    await app.close();
  });
});
