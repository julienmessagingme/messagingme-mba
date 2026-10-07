import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { makeRequireAuth, makeRequireRole, makeRequireAdminOuLien, type UserStateLoader } from '../src/auth/middleware';
import { signSession, signLienNumero } from '../src/auth/token';

/**
 * LA GARDE DES ROUTES DE LA CONNEXION DU NUMÉRO (lot 3c, livraison A, tâche 2). Elle accepte une session d'admin,
 * exactement comme la garde `admin`, OU le jeton du lien que donne Claude Code. Pour le jeton, l'utilisateur est relu
 * en base à chaque appel, et une écriture est refusée une fois le numéro connecté : c'est ce qui fait mourir le lien.
 * 🔴 L'espace de l'URL n'est PAS jugé ici : c'est l'étape d'espace, posée après elle au montage
 * (`tests/scope-tenant.test.ts` le prouve sur le serveur construit).
 */
const SECRET = 'secret-de-test';
type Etat = { role: string; disabled: boolean; tenantStatus?: string } | null;

describe('la garde adminOuLien', () => {
  let app: FastifyInstance;
  const etats = new Map<string, Etat>();
  const connectes = new Set<string>();
  const aActiver = new Set<string>();
  const lectures: string[] = [];
  const loadState: UserStateLoader = async (userId, tenantId) => { lectures.push(`${userId}@${tenantId}`); const e = etats.get(userId) ?? null; return e && { ...e, horsOffre: null }; };

  beforeAll(async () => {
    const requireAuth = makeRequireAuth(SECRET, loadState);
    const garde = makeRequireAdminOuLien({
      requireAdmin: [requireAuth, makeRequireRole(['admin'])],
      secret: SECRET,
      loadState,
      numeroActif: async (tenantId) => connectes.has(tenantId) && !aActiver.has(tenantId),
      ecrituresApresConnexion: new Set(['/abandonner']),
    });
    const sansChargeur = makeRequireAdminOuLien({
      requireAdmin: [requireAuth, makeRequireRole(['admin'])],
      secret: SECRET,
      loadState: undefined,
      numeroActif: async () => false,
      ecrituresApresConnexion: new Set(),
    });
    app = Fastify();
    app.get('/x', { preHandler: garde }, async (req) => ({ auth: req.auth }));
    app.post('/x', { preHandler: garde }, async (req) => ({ auth: req.auth }));
    app.post('/abandonner', { preHandler: garde }, async () => ({ ok: true }));
    app.get('/sans-chargeur', { preHandler: sansChargeur }, async () => ({ ok: true }));
    await app.ready();
  });
  afterAll(async () => { await app.close(); });

  const appeler = (methode: 'GET' | 'POST', jeton?: string) => app.inject({
    method: methode, url: '/x', ...(jeton ? { headers: { authorization: `Bearer ${jeton}` } } : {}), ...(methode === 'POST' ? { payload: {} } : {}),
  });
  const lien = (userId = 'u-admin', tenantId = 't-1') => signLienNumero({ tenantId, userId, mode: 'fourni' }, SECRET);

  it('une session d’admin passe comme aujourd’hui, une session de membre est refusée, rien n’est refusé en 401', async () => {
    etats.set('u-admin', { role: 'admin', disabled: false });
    etats.set('u-membre', { role: 'agent', disabled: false });
    const admin = await appeler('GET', await signSession({ userId: 'u-admin', tenantId: 't-1', role: 'admin' }, SECRET));
    expect(admin.statusCode).toBe(200);
    expect(admin.json().auth).toEqual({ userId: 'u-admin', tenantId: 't-1', role: 'admin' });
    const membre = await appeler('GET', await signSession({ userId: 'u-membre', tenantId: 't-1', role: 'agent' }, SECRET));
    expect(membre.statusCode).toBe(403);
    expect((await appeler('GET')).statusCode).toBe(401);
    expect((await appeler('GET', 'pas-un-jeton')).statusCode).toBe(401);
  });

  it('le jeton du lien passe, et pose une autorité d’admin de SON espace, marquée comme venant du lien', async () => {
    etats.set('u-admin', { role: 'admin', disabled: false });
    lectures.length = 0;
    const r = await appeler('GET', await lien());
    expect(r.statusCode).toBe(200);
    expect(r.json().auth).toEqual({ userId: 'u-admin', tenantId: 't-1', role: 'admin', viaLien: true });
    expect(lectures).toEqual(['u-admin@t-1']);
  });

  it('🔴 l’utilisateur qui a demandé le lien est relu : révoqué, supprimé ou rétrogradé, le lien ne sert plus', async () => {
    etats.set('u-revoque', { role: 'admin', disabled: true });
    expect((await appeler('GET', await lien('u-revoque'))).statusCode).toBe(401);
    expect((await appeler('GET', await lien('u-inconnu'))).statusCode).toBe(401);
    etats.set('u-retrograde', { role: 'agent', disabled: false });
    expect((await appeler('GET', await lien('u-retrograde'))).statusCode).toBe(403);
    etats.set('u-suspendu', { role: 'admin', disabled: false, tenantStatus: 'locked' });
    expect((await appeler('GET', await lien('u-suspendu'))).statusCode).toBe(403);
  });

  it('🔴 une fois le numéro connecté, le lien n’écrit plus rien, mais se lit encore', async () => {
    etats.set('u-admin', { role: 'admin', disabled: false });
    connectes.add('t-2');
    const jeton = await lien('u-admin', 't-2');
    const ecriture = await appeler('POST', jeton);
    expect(ecriture.statusCode).toBe(409);
    expect(ecriture.json().code).toBe('lien_termine');
    expect((await appeler('GET', jeton)).statusCode).toBe(200);
    // Le numéro pas encore connecté : l'écriture passe.
    expect((await appeler('POST', await lien('u-admin', 't-1'))).statusCode).toBe(200);
  });

  it('un numéro relié mais pas encore activé ne tue pas le lien : l’activation reste possible', async () => {
    etats.set('u-admin', { role: 'admin', disabled: false });
    connectes.add('t-3');
    aActiver.add('t-3');
    expect((await appeler('POST', await lien('u-admin', 't-3'))).statusCode).toBe(200);
  });

  it('« Abandonner » reste permis après la connexion d’un AUTRE numéro : la route juge elle-même', async () => {
    etats.set('u-admin', { role: 'admin', disabled: false });
    connectes.add('t-4');
    const r = await app.inject({ method: 'POST', url: '/abandonner', headers: { authorization: `Bearer ${await lien('u-admin', 't-4')}` }, payload: {} });
    expect(r.statusCode).toBe(200);
  });

  it('🔴 sans chargeur d’état, le lien est refusé : jamais de lien sans relecture de son auteur', async () => {
    const r = await app.inject({ method: 'GET', url: '/sans-chargeur', headers: { authorization: `Bearer ${await lien()}` } });
    expect(r.statusCode).toBe(401);
  });

  it('une session d’admin écrit toujours, même numéro connecté : la mort du lien ne touche que le lien', async () => {
    connectes.add('t-1');
    const r = await appeler('POST', await signSession({ userId: 'u-admin', tenantId: 't-1', role: 'admin' }, SECRET));
    expect(r.statusCode).toBe(200);
    connectes.delete('t-1');
  });
});
