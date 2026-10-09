import { describe, it, expect, beforeAll, vi } from 'vitest';
import { buildServer } from '../src/server';
import { FakeQueue } from './fake-queue';
import { signSession } from '../src/auth/token';
import type { UserAuthStore, EmailIdentity } from '../src/auth/store';
import type { EmbeddedSignupRouteDeps, MetaInscriptionDep } from '../src/http/embedded-signup';
import { TenantConflictError, SecondNumeroRefuseError } from '../src/account/es-store.pg';
import { metaInscriptionInerte, signupInerte } from './routes-inertes';

const SECRET = 'test-secret';
let adminTok = '';
let agentTok = '';
beforeAll(async () => {
  adminTok = await signSession({ userId: 'u1', tenantId: 't1', role: 'admin' }, SECRET);
  agentTok = await signSession({ userId: 'u2', tenantId: 't1', role: 'agent' }, SECRET);
});
const noUsers: UserAuthStore = { findIdentity: async (): Promise<EmailIdentity | null> => null };
const h = (t: string) => ({ headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` } });

interface Cap {
  exchanged: string[];
  verifiedWaba: string[];
  linked: Array<{ tenantId: string; wabaId: string; phoneNumberId: string; displayPhoneNumber: string | null }>;
  subscribed: string[];
  registered: Array<{ phoneNumberId: string; pin: string }>;
  saved: Array<{ wabaId: string; tenantId: string; token: string; pin: string | null }>;
  /** Les numéros pour lesquels la route a demandé le crédit de bienvenue. */
  offerts: Array<{ tenantId: string; phoneNumberId: string }>;
  /** Les comptes WhatsApp reliés SANS numéro (fin de fenêtre sans numéro, lot 3b). */
  sansNumero: Array<{ tenantId: string; wabaId: string }>;
}

function app(
  over: Partial<MetaInscriptionDep> & { configId?: string; numeroDuTenant?: EmbeddedSignupRouteDeps['numeroDuTenant'] } = {},
  linkTenant?: EmbeddedSignupRouteDeps['inscriptions']['linkTenant'],
  offrirCredit?: EmbeddedSignupRouteDeps['offrirCredit'],
  lierCompteSansNumero?: EmbeddedSignupRouteDeps['inscriptions']['lierCompteSansNumero'],
) {
  const cap: Cap = { exchanged: [], verifiedWaba: [], linked: [], subscribed: [], registered: [], saved: [], offerts: [], sansNumero: [] };
  const { configId = 'cfg-123', numeroDuTenant, ...meta } = over;
  const deps: EmbeddedSignupRouteDeps = {
    ...signupInerte,
    configId,
    appId: 'app-1',
    graphVersion: 'v25.0',
    meta: {
      ...metaInscriptionInerte,
      exchangeCode: async (code) => { cap.exchanged.push(code); return 'BIZ_TOKEN'; },
      verifyWaba: async (wabaId) => { cap.verifiedWaba.push(wabaId); },
      getPhone: async () => ({ displayPhoneNumber: '+33525680250', verifiedName: 'Messaging Me Tech', status: 'CONNECTED' }),
      subscribeApp: async (wabaId) => { cap.subscribed.push(wabaId); },
      register: async (phoneNumberId, _tok, pin) => { cap.registered.push({ phoneNumberId, pin }); },
      ...meta,
    },
    inscriptions: {
      linkTenant: linkTenant ?? (async (input) => { cap.linked.push({ tenantId: input.tenantId, wabaId: input.wabaId, phoneNumberId: input.phoneNumberId, displayPhoneNumber: input.displayPhoneNumber }); }),
      lierCompteSansNumero: lierCompteSansNumero ?? (async (input) => { cap.sansNumero.push({ tenantId: input.tenantId, wabaId: input.wabaId }); }),
    },
    saveCredentials: async (wabaId, tenantId, token, pin) => { cap.saved.push({ wabaId, tenantId, token, pin }); },
    offrirCredit: offrirCredit ?? (async (tenantId, phoneNumberId) => { cap.offerts.push({ tenantId, phoneNumberId }); }),
    // L'activation du numéro a son propre fichier (`tests/numero-activation.test.ts`). Ici, ces dépendances
    // LÈVENT au lieu de ne rien faire : si un chemin d'inscription se mettait à les appeler, il faut le voir,
    // pas le laisser passer sous un faux silence.
    // Lu par l'inscription seulement pour départager plusieurs comptes ou numéros (un renouvellement) : ailleurs, il lève.
    numeroDuTenant: numeroDuTenant ?? (async () => { throw new Error('non attendu dans ce test'); }),
    etatNumero: async () => { throw new Error('non attendu dans ce test'); },
    demanderCode: async () => { throw new Error('non attendu dans ce test'); },
    verifierCode: async () => { throw new Error('non attendu dans ce test'); },
    enregistrerNumero: async () => { throw new Error('non attendu dans ce test'); },
    sauverPin: async () => { throw new Error('non attendu dans ce test'); },
    // Délier et relier (migration 0180) ont leurs tests dans `tests/numero-activation.test.ts`.
    delierNumero: async () => { throw new Error('non attendu dans ce test'); },
    relierNumero: async () => { throw new Error('non attendu dans ce test'); },
    // La minute entre deux demandes de code : `tests/numero-activation.test.ts` l'éprouve. Ici, aucun chemin ne la prend.
    verrous: { prendre: async () => { throw new Error('non attendu dans ce test'); } },
  };
  return { server: buildServer({ queue: new FakeQueue(), auth: { users: noUsers, secret: SECRET }, embeddedSignup: deps }), cap };
}

const BODY = { code: 'code-abc', wabaId: 'waba-1', phoneNumberId: 'pn-1' };

describe('GET /embedded-signup/config', () => {
  it('admin -> 200 avec appId/configId (enabled true)', async () => {
    const { server } = app();
    const res = await server.inject({ method: 'GET', url: '/tenants/t1/embedded-signup/config', ...h(adminTok) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ enabled: true, appId: 'app-1', configId: 'cfg-123', graphVersion: 'v25.0' });
    await server.close();
  });

  it('configId vide -> enabled false (le front garde le placeholder)', async () => {
    const { server } = app({ configId: '' });
    const res = await server.inject({ method: 'GET', url: '/tenants/t1/embedded-signup/config', ...h(adminTok) });
    expect(res.json()).toMatchObject({ enabled: false });
    await server.close();
  });

  it('agent -> 403', async () => {
    const { server } = app();
    const res = await server.inject({ method: 'GET', url: '/tenants/t1/embedded-signup/config', ...h(agentTok) });
    expect(res.statusCode).toBe(403);
    await server.close();
  });
});

describe('POST /embedded-signup/complete', () => {
  it('numéro déjà CONNECTED : échange + link + subscribe + credentials, SANS register', async () => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/embedded-signup/complete', ...h(adminTok), payload: BODY });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ connected: true, wabaId: 'waba-1', phoneNumberId: 'pn-1', displayPhoneNumber: '+33525680250' });
    expect(cap.exchanged).toEqual(['code-abc']);
    expect(cap.linked[0]).toMatchObject({ tenantId: 't1', wabaId: 'waba-1', phoneNumberId: 'pn-1', displayPhoneNumber: '+33525680250' });
    expect(cap.subscribed).toEqual(['waba-1']);
    expect(cap.registered).toHaveLength(0); // déjà connecté -> pas de register
    expect(cap.saved[0]).toMatchObject({ wabaId: 'waba-1', tenantId: 't1', token: 'BIZ_TOKEN', pin: null });
    await server.close();
  });

  it('numéro NEUF (status non CONNECTED) : register appelé avec un pin 6 chiffres, pin conservé', async () => {
    const { server, cap } = app({ getPhone: async () => ({ displayPhoneNumber: null, verifiedName: null, status: 'PENDING' }) });
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/embedded-signup/complete', ...h(adminTok), payload: BODY });
    expect(res.statusCode).toBe(200);
    expect(cap.registered).toHaveLength(1);
    expect(cap.registered[0]!.pin).toMatch(/^\d{6}$/);
    expect(cap.saved[0]!.pin).toBe(cap.registered[0]!.pin);
    await server.close();
  });

  it('échange du code échoue -> 422, RIEN n\'est rattaché', async () => {
    const { server, cap } = app({ exchangeCode: async () => { throw new Error('Graph 400 (#100) : code expiré'); } });
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/embedded-signup/complete', ...h(adminTok), payload: BODY });
    expect(res.statusCode).toBe(422);
    expect(cap.linked).toHaveLength(0);
    expect(cap.saved).toHaveLength(0);
    await server.close();
  });

  it('numéro déjà rattaché à un AUTRE workspace (link throw TenantConflictError) -> 409, pas de subscribe/register/save', async () => {
    const { server, cap } = app({}, async () => { throw new TenantConflictError('phone_number', 'pn-1'); });
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/embedded-signup/complete', ...h(adminTok), payload: BODY });
    expect(res.statusCode).toBe(409);
    // le conflit interrompt AVANT les étapes suivantes : rien n'est abonné, registré, ni sauvegardé.
    expect(cap.subscribed).toHaveLength(0);
    expect(cap.registered).toHaveLength(0);
    expect(cap.saved).toHaveLength(0);
    await server.close();
  });

  /**
   * UN SEUL numéro par espace (décision produit du 2026-08-31). Le message compte autant que le refus : sans
   * lui, l'opérateur conclut à une panne de l'embarquement et recommence en boucle.
   */
  it('second numéro sur le MÊME workspace -> 409, un message qui NOMME le numéro déjà là et dit quoi faire', async () => {
    const { server, cap } = app({}, async () => { throw new SecondNumeroRefuseError('pn-deja', 'pn-nouveau'); });
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/embedded-signup/complete', ...h(adminTok), payload: BODY });
    expect(res.statusCode).toBe(409);
    const message = res.json<{ error: string }>().error;
    expect(message).toContain('pn-deja');
    expect(message).toContain('un seul numéro WhatsApp');
    expect(message).toContain('second espace');
    // Le renouvellement de l'Accueil aboutit ici quand l'admin choisit un autre numéro : le message dit quoi faire.
    expect(message).toContain('choisis ce même numéro');
    expect(message).not.toContain('détache');
    // Comme pour le conflit inter-workspace : rien n'est abonné, registré ni sauvegardé derrière un refus.
    expect(cap.subscribed).toHaveLength(0);
    expect(cap.registered).toHaveLength(0);
    expect(cap.saved).toHaveLength(0);
    await server.close();
  });

  it('anti-hijack : le token ne possède PAS le WABA (verifyWaba throw) -> 422, RIEN persisté', async () => {
    const { server, cap } = app({ verifyWaba: async () => { throw new Error('Graph 403 (#200) : accès refusé au WABA'); } });
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/embedded-signup/complete', ...h(adminTok), payload: BODY });
    expect(res.statusCode).toBe(422);
    expect(cap.linked).toHaveLength(0);
    expect(cap.subscribed).toHaveLength(0);
    expect(cap.saved).toHaveLength(0);
    await server.close();
  });

  it('anti-hijack : le token ne possède PAS le numéro (getPhone throw) -> 422, RIEN persisté', async () => {
    const { server, cap } = app({ getPhone: async () => { throw new Error('Graph 403 (#200) : accès refusé au numéro'); } });
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/embedded-signup/complete', ...h(adminTok), payload: BODY });
    expect(res.statusCode).toBe(422);
    expect(cap.linked).toHaveLength(0);
    expect(cap.saved).toHaveLength(0);
    await server.close();
  });

  it('subscribe échoue -> 200 avec warnings (jamais de demi-échec silencieux)', async () => {
    const { server, cap } = app({ subscribeApp: async () => { throw new Error('Graph 403 : permission'); } });
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/embedded-signup/complete', ...h(adminTok), payload: BODY });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ warnings?: string[] }>().warnings?.[0]).toMatch(/abonnement webhooks/);
    expect(cap.saved).toHaveLength(1); // le token est quand même conservé
    await server.close();
  });

  it('register échoue -> 200 avec warning et pin NON stocké', async () => {
    const { server, cap } = app({
      getPhone: async () => ({ displayPhoneNumber: null, verifiedName: null, status: null }),
      register: async () => { throw new Error('Graph 400 : pin mismatch'); },
    });
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/embedded-signup/complete', ...h(adminTok), payload: BODY });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ warnings?: string[] }>().warnings?.some((w) => w.includes('register'))).toBe(true);
    expect(cap.saved[0]!.pin).toBeNull();
    await server.close();
  });

  it('body incomplet -> 400 ; agent -> 403 ; feature OFF -> 503', async () => {
    const { server } = app();
    // Sans `code` : le repêchage des identifiants est toujours câblé depuis le lot 3 de l'audit ponytail, donc
    // un corps qui n'a QUE le code n'est plus « incomplet ». Le code, lui, reste indispensable.
    const bad = await server.inject({ method: 'POST', url: '/tenants/t1/embedded-signup/complete', ...h(adminTok), payload: {} });
    const agent = await server.inject({ method: 'POST', url: '/tenants/t1/embedded-signup/complete', ...h(agentTok), payload: BODY });
    expect(bad.statusCode).toBe(400);
    expect(agent.statusCode).toBe(403);
    await server.close();
    const { server: off } = app({ configId: '' });
    const disabled = await off.inject({ method: 'POST', url: '/tenants/t1/embedded-signup/complete', ...h(adminTok), payload: BODY });
    expect(disabled.statusCode).toBe(503);
    await off.close();
  });
});

/**
 * Popup MUETTE sur les identifiants. Meta ne les annonce que lorsqu'il exécute vraiment les étapes de
 * configuration : un client qui rouvre un parcours DÉJÀ abouti n'obtient qu'un code. Mesuré le 2026-08-17,
 * toute trace de filtrage retirée : le seul message reçu de facebook.com était le canal interne du SDK
 * portant le code. Tant qu'on exigeait les identifiants, ce client restait bloqué SANS RECOURS.
 */
describe('POST /embedded-signup/complete sans identifiants (parcours déjà abouti chez Meta)', () => {
  const repechage = {
    wabasForToken: async () => ['waba-decouvert'],
    listPhones: async () => [{ id: 'pn-decouvert' }],
  };

  it('🔴 code SEUL -> identifiants retrouvés depuis le token, rattachement complet', async () => {
    const { server, cap } = app(repechage);
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/embedded-signup/complete', ...h(adminTok), payload: JSON.stringify({ code: 'code-abc' }) });
    expect(res.statusCode).toBe(200);
    expect(cap.linked).toEqual([{ tenantId: 't1', wabaId: 'waba-decouvert', phoneNumberId: 'pn-decouvert', displayPhoneNumber: '+33525680250' }]);
    // La preuve d'appartenance reste JOUÉE sur l'identifiant retrouvé : le repêchage ne l'a pas court-circuitée.
    expect(cap.verifiedWaba).toEqual(['waba-decouvert']);
    expect(cap.subscribed).toEqual(['waba-decouvert']);
    await server.close();
  });

  it('les identifiants ANNONCÉS par la popup restent prioritaires (aucun appel de repêchage)', async () => {
    let repeches = 0;
    const { server, cap } = app({ wabasForToken: async () => { repeches += 1; return ['autre']; }, listPhones: async () => [{ id: 'autre-pn' }] });
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/embedded-signup/complete', ...h(adminTok), payload: JSON.stringify(BODY) });
    expect(res.statusCode).toBe(200);
    expect(repeches).toBe(0);
    expect(cap.linked[0]).toMatchObject({ wabaId: 'waba-1', phoneNumberId: 'pn-1' });
    await server.close();
  });

  it('token n’exposant AUCUN compte -> 422 qui dit quoi faire, et RIEN n’est rattaché', async () => {
    const { server, cap } = app({ ...repechage, wabasForToken: async () => [] });
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/embedded-signup/complete', ...h(adminTok), payload: JSON.stringify({ code: 'code-abc' }) });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toContain('aucun compte WhatsApp');
    expect(cap.linked).toHaveLength(0);
    await server.close();
  });

  it('🔴 AMBIGUÏTÉ (plusieurs comptes, ou plusieurs numéros) -> 409, jamais un choix au hasard', async () => {
    // Rattacher le mauvais numéro serait bien pire qu'un message d'erreur.
    // L'espace n'a pas encore de numéro : rien ne départage.
    const sansNumeroActuel = { numeroDuTenant: async () => null };
    const deuxWabas = app({ ...repechage, ...sansNumeroActuel, wabasForToken: async () => ['w1', 'w2'] });
    const r1 = await deuxWabas.server.inject({ method: 'POST', url: '/tenants/t1/embedded-signup/complete', ...h(adminTok), payload: JSON.stringify({ code: 'c' }) });
    expect(r1.statusCode).toBe(409);
    expect(deuxWabas.cap.linked).toHaveLength(0);
    await deuxWabas.server.close();

    const deuxNums = app({ ...repechage, ...sansNumeroActuel, listPhones: async () => [{ id: 'a' }, { id: 'b' }] });
    const r2 = await deuxNums.server.inject({ method: 'POST', url: '/tenants/t1/embedded-signup/complete', ...h(adminTok), payload: JSON.stringify({ code: 'c' }) });
    expect(r2.statusCode).toBe(409);
    expect(deuxNums.cap.linked).toHaveLength(0);
    await deuxNums.server.close();
  });

  /** Deux comptes, chacun son numéro : le renouvellement d'un espace qui porte DÉJÀ l'un d'eux (mesuré le 2026-10-09). */
  const deuxComptes = {
    wabasForToken: async () => ['w-autre', 'w-espace'],
    listPhones: async (w: string) => (w === 'w-espace' ? [{ id: 'pn-espace' }] : [{ id: 'pn-autre' }]),
  };
  // Une fonction : le jeton admin n'existe qu'une fois le `beforeAll` passé.
  const corpsSeul = () => ({ method: 'POST' as const, url: '/tenants/t1/embedded-signup/complete', ...h(adminTok), payload: JSON.stringify({ code: 'c' }) });

  it('🔴 renouvellement : plusieurs comptes, l’espace porte déjà un numéro -> son compte et son numéro sont retenus', async () => {
    const { server, cap } = app({ ...deuxComptes, numeroDuTenant: async () => 'pn-espace' });
    const res = await server.inject(corpsSeul());
    expect(res.statusCode).toBe(200);
    expect(cap.linked).toEqual([{ tenantId: 't1', wabaId: 'w-espace', phoneNumberId: 'pn-espace', displayPhoneNumber: '+33525680250' }]);
    // La preuve d'appartenance reste jouée sur le compte retenu.
    expect(cap.verifiedWaba).toEqual(['w-espace']);
    await server.close();
  });

  it('renouvellement : le numéro de l’espace n’est dans aucun compte, ou dans deux -> 409, rien n’est rattaché', async () => {
    const aucun = app({ ...deuxComptes, numeroDuTenant: async () => 'pn-inconnu' });
    expect((await aucun.server.inject(corpsSeul())).statusCode).toBe(409);
    expect(aucun.cap.linked).toHaveLength(0);
    await aucun.server.close();
    const deux = app({ ...deuxComptes, listPhones: async () => [{ id: 'pn-espace' }], numeroDuTenant: async () => 'pn-espace' });
    expect((await deux.server.inject(corpsSeul())).statusCode).toBe(409);
    expect(deux.cap.linked).toHaveLength(0);
    await deux.server.close();
  });

  it('renouvellement : plusieurs numéros dans le compte -> celui que l’espace porte, jamais un autre', async () => {
    const { server, cap } = app({ ...repechage, listPhones: async () => [{ id: 'a' }, { id: 'pn-espace' }], numeroDuTenant: async () => 'pn-espace' });
    expect((await server.inject(corpsSeul())).statusCode).toBe(200);
    expect(cap.linked[0]).toMatchObject({ wabaId: 'waba-decouvert', phoneNumberId: 'pn-espace' });
    await server.close();
  });

  it('trop de comptes à interroger (plus de 10) -> 409 sans en lire aucun', async () => {
    let lus = 0;
    const { server, cap } = app({
      wabasForToken: async () => Array.from({ length: 11 }, (_, i) => `w${i}`),
      listPhones: async () => { lus += 1; return [{ id: 'pn-espace' }]; },
      numeroDuTenant: async () => 'pn-espace',
    });
    expect((await server.inject(corpsSeul())).statusCode).toBe(409);
    expect([lus, cap.linked.length]).toEqual([0, 0]);
    await server.close();
  });

  it('code absent -> 400 (le code, lui, reste indispensable)', async () => {
    const { server } = app(repechage);
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/embedded-signup/complete', ...h(adminTok), payload: JSON.stringify({ wabaId: 'w', phoneNumberId: 'p' }) });
    expect(res.statusCode).toBe(400);
    await server.close();
  });

  it('agent -> 403 : le repêchage n’ouvre aucune porte (l’embarquement reste admin)', async () => {
    const { server } = app(repechage);
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/embedded-signup/complete', ...h(agentTok), payload: JSON.stringify({ code: 'code-abc' }) });
    expect(res.statusCode).toBe(403);
    await server.close();
  });
});

/**
 * 🔴 UN COMPTE WHATSAPP SANS NUMÉRO EST GARDÉ, PLUS REFUSÉ (lot 3b, spec 2026-10-05-numero-fourni-design.md).
 *
 * En v4, la fenêtre de Meta laisse le client finir SANS numéro (`FINISH_ONLY_WABA`) ; c'est le parcours du numéro
 * fourni, où le serveur ajoute ensuite le nôtre à son compte. La route rendait 422 (« ce compte WhatsApp ne contient
 * aucun numéro ») et jetait le jeton : sans lui, rien ne peut plus être ajouté au compte du client. Elle relie
 * désormais le compte à l'espace, sans numéro, et garde son jeton, après la même preuve d'appartenance.
 */
describe('POST /embedded-signup/complete : compte WhatsApp SANS numéro', () => {
  const sansNumero = { listPhones: async () => [] };
  const COMPLET = '/tenants/t1/embedded-signup/complete';

  it('🔴 compte annoncé, aucun numéro : relié sans numéro, jeton gardé, abonné ; ni numéro, ni register, ni offre', async () => {
    const { server, cap } = app(sansNumero);
    const res = await server.inject({ method: 'POST', url: COMPLET, ...h(adminTok), payload: JSON.stringify({ code: 'code-abc', wabaId: 'waba-1', evenement: 'FINISH_ONLY_WABA' }) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ connected: false, sansNumero: true, wabaId: 'waba-1' });
    expect(res.json().warnings?.[0]).toContain('sans numéro');
    expect(cap.verifiedWaba).toEqual(['waba-1']);
    expect(cap.sansNumero).toEqual([{ tenantId: 't1', wabaId: 'waba-1' }]);
    expect(cap.saved).toEqual([{ wabaId: 'waba-1', tenantId: 't1', token: 'BIZ_TOKEN', pin: null }]);
    expect(cap.subscribed).toEqual(['waba-1']);
    expect(cap.linked).toHaveLength(0);
    expect(cap.registered).toHaveLength(0);
    expect(cap.offerts).toHaveLength(0);
    await server.close();
  });

  it('code SEUL, compte retrouvé depuis le jeton et sans numéro : même chemin', async () => {
    const { server, cap } = app({ ...sansNumero, wabasForToken: async () => ['waba-decouvert'] });
    const res = await server.inject({ method: 'POST', url: COMPLET, ...h(adminTok), payload: JSON.stringify({ code: 'code-abc' }) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ sansNumero: true, wabaId: 'waba-decouvert' });
    expect(cap.sansNumero).toEqual([{ tenantId: 't1', wabaId: 'waba-decouvert' }]);
    await server.close();
  });

  it('🔴 preuve d’appartenance refusée -> 422, RIEN n’est relié ni gardé', async () => {
    const { server, cap } = app({ ...sansNumero, verifyWaba: async () => { throw new Error('(#100) no permission'); } });
    const res = await server.inject({ method: 'POST', url: COMPLET, ...h(adminTok), payload: JSON.stringify({ code: 'c', wabaId: 'waba-x' }) });
    expect(res.statusCode).toBe(422);
    expect(cap.sansNumero).toHaveLength(0);
    expect(cap.saved).toHaveLength(0);
    await server.close();
  });

  it('compte d’un AUTRE espace -> 409, jeton non gardé', async () => {
    const { server, cap } = app(sansNumero, undefined, undefined, async () => { throw new TenantConflictError('waba', 'waba-1'); });
    const res = await server.inject({ method: 'POST', url: COMPLET, ...h(adminTok), payload: JSON.stringify({ code: 'c', wabaId: 'waba-1' }) });
    expect(res.statusCode).toBe(409);
    expect(cap.saved).toHaveLength(0);
    expect(cap.subscribed).toHaveLength(0);
    await server.close();
  });

  it('espace qui a DÉJÀ un numéro -> 409 qui le nomme, jeton non gardé', async () => {
    const { server, cap } = app(sansNumero, undefined, undefined, async () => { throw new SecondNumeroRefuseError('+33 5 25 68 02 50', ''); });
    const res = await server.inject({ method: 'POST', url: COMPLET, ...h(adminTok), payload: JSON.stringify({ code: 'c', wabaId: 'waba-1' }) });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain('+33 5 25 68 02 50');
    expect(cap.saved).toHaveLength(0);
    await server.close();
  });

  it('abonnement des webhooks refusé -> 200 avec avertissement, le jeton est quand même gardé', async () => {
    const { server, cap } = app({ ...sansNumero, subscribeApp: async () => { throw new Error('boom'); } });
    const res = await server.inject({ method: 'POST', url: COMPLET, ...h(adminTok), payload: JSON.stringify({ code: 'c', wabaId: 'waba-1' }) });
    expect(res.statusCode).toBe(200);
    expect(res.json().warnings.join(' ')).toContain('boom');
    expect(cap.saved).toHaveLength(1);
    await server.close();
  });
});

/**
 * 🔴 POURQUOI 422 ET NON 502 sur un refus que l'utilisateur doit LIRE.
 *
 * Mesuré le 2026-08-17 : le domaine passe par Cloudflare, qui traite tout 5xx comme une panne d'origine et
 * REMPLACE le corps de la réponse par sa propre page HTML (« 502: Bad gateway », 6,4 ko). Notre message
 * n'atteignait donc JAMAIS l'utilisateur : il voyait « Erreur 502 » et nous cherchions une panne inexistante.
 * Un 4xx, lui, traverse intact. Cette garde interdit le retour en arrière.
 */
describe('aucun refus destiné à l’utilisateur ne part en 5xx (Cloudflare détruirait le message)', () => {
  it('échange du code refusé par Meta -> 422 avec le message de Meta, pas un 5xx', async () => {
    const { server } = app({ exchangeCode: async () => { throw new Error('Graph 400 (#100) : Invalid verification code format.'); } });
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/embedded-signup/complete', ...h(adminTok), payload: JSON.stringify(BODY) });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toContain('Invalid verification code format');
    await server.close();
  });

  it('preuve d’appartenance refusée -> 422, et rien n’est rattaché', async () => {
    const { server, cap } = app({ verifyWaba: async () => { throw new Error('Graph 403 : no access'); } });
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/embedded-signup/complete', ...h(adminTok), payload: JSON.stringify(BODY) });
    expect(res.statusCode).toBe(422);
    expect(cap.linked).toHaveLength(0);
    await server.close();
  });
});

/**
 * v4 de l'inscription : on peut y terminer avec un numéro NON vérifié (la v2 imposait un numéro vérifié). Le
 * register d'un tel numéro échoue (133006), et chaque tentative consomme une des 10 permises par numéro sur
 * 72 h (au-delà : erreur 133016 et numéro bloqué 72 h). On ne le tente donc pas.
 *
 * 🔴 ON RATTACHE QUAND MÊME, et c'est l'arbitrage du 2026-09-22 au soir : refuser le parcours entier obligerait
 * le client à tout recommencer chez Meta pour un code qu'il peut saisir chez nous. Le numéro est rattaché, dit
 * « à activer », et le bouton d'activation fait le reste.
 */
describe('POST /embedded-signup/complete : numéro non vérifié (v4)', () => {
  it('NOT_VERIFIED : rattaché et abonné, register JAMAIS tenté, aActiver + avertissement', async () => {
    const { server, cap } = app({
      getPhone: async () => ({ displayPhoneNumber: '+33600000000', verifiedName: null, status: 'PENDING', codeVerificationStatus: 'NOT_VERIFIED' }),
    });
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/embedded-signup/complete', ...h(adminTok), payload: BODY });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ aActiver?: boolean; warnings?: string[] }>();
    expect(body.aActiver).toBe(true);
    expect(body.warnings?.join(' ')).toMatch(/vérifié/);
    expect(cap.linked).toHaveLength(1);
    expect(cap.subscribed).toEqual(['waba-1']);
    expect(cap.registered).toHaveLength(0);
    expect(cap.saved[0]).toMatchObject({ pin: null }); // aucun PIN posé : rien à conserver
    await server.close();
  });

  it('déjà CONNECTED : rattaché sans register quel que soit code_verification_status (le statut prime)', async () => {
    const { server, cap } = app({
      getPhone: async () => ({ displayPhoneNumber: '+33600000000', verifiedName: 'X', status: 'CONNECTED', codeVerificationStatus: 'NOT_VERIFIED' }),
    });
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/embedded-signup/complete', ...h(adminTok), payload: BODY });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ aActiver?: boolean }>().aActiver).toBeUndefined();
    expect(cap.linked).toHaveLength(1);
    expect(cap.registered).toHaveLength(0);
    await server.close();
  });

  it('EXPIRED sur un numéro neuf : register TENTÉ comme avant (valeur jamais mesurée, on ne la refuse pas)', async () => {
    const { server, cap } = app({
      getPhone: async () => ({ displayPhoneNumber: null, verifiedName: null, status: 'PENDING', codeVerificationStatus: 'EXPIRED' }),
    });
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/embedded-signup/complete', ...h(adminTok), payload: BODY });
    expect(res.statusCode).toBe(200);
    expect(cap.registered).toHaveLength(1);
    await server.close();
  });
});

/**
 * LE CRÉDIT DE BIENVENUE, SEULEMENT POUR UN NUMÉRO QUE META DIT VÉRIFIÉ (relecture du 2026-09-29).
 *
 * 🔴 L'offre partait à la LIAISON (étape 3), avant le constat `NOT_VERIFIED` de l'étape 5 : un numéro que Meta n'a
 * pas vérifié recevait ses 5 €. Les bornes « une fois par espace, jamais deux fois par numéro » sont des contraintes
 * de la base (`tests/integration/agent-credits.integration.test.ts`) ; ici, QUAND la route demande l'offre.
 */
describe('POST /embedded-signup/complete : le crédit de bienvenue', () => {
  const inscrire = async (phone: Awaited<ReturnType<MetaInscriptionDep['getPhone']>>, over: Partial<MetaInscriptionDep> = {}) => {
    const { server, cap } = app({ getPhone: async () => phone, ...over });
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/embedded-signup/complete', ...h(adminTok), payload: BODY });
    await server.close();
    return { res, cap };
  };

  it('🔴 numéro NOT_VERIFIED : relié, et RIEN n’est offert', async () => {
    const { res, cap } = await inscrire({ displayPhoneNumber: '+33600000000', verifiedName: null, status: 'PENDING', codeVerificationStatus: 'NOT_VERIFIED' });
    expect(res.statusCode).toBe(200);
    expect(cap.linked).toHaveLength(1);
    expect(cap.offerts).toEqual([]);
  });

  it('numéro déjà CONNECTED, ou VERIFIED : l’offre est demandée, une fois, pour CE numéro', async () => {
    expect((await inscrire({ displayPhoneNumber: '+33600000000', verifiedName: 'X', status: 'CONNECTED' })).cap.offerts)
      .toEqual([{ tenantId: 't1', phoneNumberId: 'pn-1' }]);
    expect((await inscrire({ displayPhoneNumber: '+33600000000', verifiedName: 'X', status: 'PENDING', codeVerificationStatus: 'VERIFIED' })).cap.offerts)
      .toEqual([{ tenantId: 't1', phoneNumberId: 'pn-1' }]);
  });

  it('numéro sans statut de vérification : offert SEULEMENT si Meta accepte son enregistrement', async () => {
    const neuf = { displayPhoneNumber: null, verifiedName: null, status: 'PENDING', codeVerificationStatus: null };
    expect((await inscrire(neuf)).cap.offerts).toHaveLength(1);
    const refuse = await inscrire(neuf, { register: async () => { throw new Error('Graph 400 : 133006 not verified'); } });
    expect(refuse.res.statusCode).toBe(200);
    expect(refuse.cap.offerts).toEqual([]);
  });

  it('🔴 une offre qui échoue ne fait pas échouer l’inscription : Meta a déjà relié le numéro', async () => {
    const erreurs = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { server, cap } = app({}, undefined, async () => { throw new Error('base indisponible'); });
      const res = await server.inject({ method: 'POST', url: '/tenants/t1/embedded-signup/complete', ...h(adminTok), payload: BODY });
      expect(res.statusCode).toBe(200);
      expect(cap.saved).toHaveLength(1);
      expect(erreurs.mock.calls.flat().join(' ')).toContain('credit offert');
      await server.close();
    } finally {
      erreurs.mockRestore();
    }
  });

  it('une inscription refusée (numéro d’un autre espace) n’offre rien', async () => {
    const { server, cap } = app({}, async () => { throw new TenantConflictError('phone_number', 'pn-1'); });
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/embedded-signup/complete', ...h(adminTok), payload: BODY });
    expect(res.statusCode).toBe(409);
    expect(cap.offerts).toEqual([]);
    await server.close();
  });
});
