import { describe, it, expect, beforeAll } from 'vitest';
import { buildServer } from '../src/server';
import { FakeQueue } from '../src/queue/fake';
import { signSession } from '../src/auth/token';
import type { UserAuthStore, EmailIdentity } from '../src/auth/store';
import type { EmbeddedSignupRouteDeps } from '../src/http/embedded-signup';

/**
 * « Activer le numéro » : finir chez nous ce que la fenêtre Meta a laissé en plan.
 *
 * 🔴 CE QUE CES TESTS PROTÈGENT, ET QUI NE SE VOIT PAS DANS LE CODE. Meta plafonne à DIX requêtes par numéro
 * sur 72 heures, toutes étapes confondues (demande de code, vérification, enregistrement) ; au-delà, erreur
 * 133016 et numéro bloqué 72 heures. Chaque appel évité ici est un essai gardé pour le client. D'où trois
 * propriétés tenues une par une : on LIT l'état avant d'agir, on ne redemande pas un code dans la minute, et
 * on ne tente jamais un geste que Meta refuserait de toute façon (un code sur un numéro déjà vérifié rend
 * 136024, un register sur un numéro non vérifié rend 133006).
 */
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
  codes: Array<{ phoneNumberId: string; methode: string }>;
  verifies: Array<{ phoneNumberId: string; code: string }>;
  registres: Array<{ phoneNumberId: string; pin: string }>;
  pins: string[];
  /** Espaces passés à `delierNumero` / `relierNumero` (migration 0180). */
  delies: string[];
  relies: string[];
  /** Actions écrites au journal d'audit. */
  audit: string[];
}

function app(over: Partial<EmbeddedSignupRouteDeps> = {}) {
  const cap: Cap = { codes: [], verifies: [], registres: [], pins: [], delies: [], relies: [], audit: [] };
  const deps: EmbeddedSignupRouteDeps = {
    audit: async (_t, _acteur, action) => { cap.audit.push(action); },
    configId: 'cfg-123',
    appId: 'app-1',
    graphVersion: 'v25.0',
    exchangeCode: async () => 'BIZ_TOKEN',
    verifyWaba: async () => {},
    getPhone: async () => ({ displayPhoneNumber: null, verifiedName: null, status: 'CONNECTED' }),
    subscribeApp: async () => {},
    register: async () => {},
    link: async () => {},
    saveCredentials: async () => {},
    numeroDuTenant: async () => 'pn-1',
    etatNumero: async () => ({ status: 'PENDING', codeVerificationStatus: 'NOT_VERIFIED' }),
    demanderCode: async (_t, phoneNumberId, methode) => { cap.codes.push({ phoneNumberId, methode }); },
    verifierCode: async (_t, phoneNumberId, code) => { cap.verifies.push({ phoneNumberId, code }); },
    enregistrerNumero: async (_t, phoneNumberId, pin) => { cap.registres.push({ phoneNumberId, pin }); },
    sauverPin: async (_t, pin) => { cap.pins.push(pin); },
    delierNumero: async (t) => { cap.delies.push(t); return { delieLe: '2026-09-25T10:00:00.000Z', campagnesEnPause: 2 }; },
    relierNumero: async (t) => { cap.relies.push(t); return { campagnesReprises: 1, campagnesReprogrammees: 1 }; },
    ...over,
  };
  return { server: buildServer({ queue: new FakeQueue(), auth: { users: noUsers, secret: SECRET }, embeddedSignup: deps }), cap };
}

const CODE_URL = '/tenants/t1/numero/code';
const ACTIVER_URL = '/tenants/t1/numero/activer';

describe('POST /tenants/:tenantId/numero/code', () => {
  it('appel (VOICE) par défaut : Meta appelle le numéro et dicte le code', async () => {
    // VOICE et non SMS : Meta déconseille le SMS sur un numéro VoIP, et le client peut toujours choisir l'autre.
    const { server, cap } = app();
    const res = await server.inject({ method: 'POST', url: CODE_URL, ...h(adminTok), payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ envoye: true, methode: 'VOICE' });
    expect(cap.codes).toEqual([{ phoneNumberId: 'pn-1', methode: 'VOICE' }]);
    await server.close();
  });

  it('SMS accepté, canal inconnu refusé en 400 sans appeler Meta', async () => {
    const { server, cap } = app();
    const sms = await server.inject({ method: 'POST', url: CODE_URL, ...h(adminTok), payload: { methode: 'SMS' } });
    expect(sms.statusCode).toBe(200);
    expect(cap.codes[0]).toMatchObject({ methode: 'SMS' });
    const faux = await server.inject({ method: 'POST', url: CODE_URL, ...h(adminTok), payload: { methode: 'PIGEON' } });
    expect(faux.statusCode).toBe(400);
    expect(cap.codes).toHaveLength(1);
    await server.close();
  });

  it('aucun numéro rattaché -> 404, et Meta n’est pas appelé', async () => {
    const { server, cap } = app({ numeroDuTenant: async () => null });
    const res = await server.inject({ method: 'POST', url: CODE_URL, ...h(adminTok), payload: {} });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: string }>().error).toMatch(/aucun numéro/); // le 404 vient de la ROUTE, pas d'une adresse inconnue
    expect(cap.codes).toHaveLength(0);
    await server.close();
  });

  it('numéro déjà CONNECTED -> 409, aucun essai consommé', async () => {
    const { server, cap } = app({ etatNumero: async () => ({ status: 'CONNECTED', codeVerificationStatus: 'VERIFIED' }) });
    const res = await server.inject({ method: 'POST', url: CODE_URL, ...h(adminTok), payload: {} });
    expect(res.statusCode).toBe(409);
    expect(cap.codes).toHaveLength(0);
    await server.close();
  });

  it('numéro déjà VÉRIFIÉ -> 409 : Meta refuserait (136024), on ne brûle pas un essai pour l’apprendre', async () => {
    const { server, cap } = app({ etatNumero: async () => ({ status: 'PENDING', codeVerificationStatus: 'VERIFIED' }) });
    const res = await server.inject({ method: 'POST', url: CODE_URL, ...h(adminTok), payload: {} });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: string }>().error).toMatch(/activer/i);
    expect(cap.codes).toHaveLength(0);
    await server.close();
  });

  it('second envoi dans la minute -> 429, Meta n’est PAS rappelé', async () => {
    // Aucune relance automatique nulle part, et pas de bouton qui se re-clique en rafale : c'est le plafond
    // des 10 requêtes sur 72 h qu'on protège, pas notre serveur.
    const { server, cap } = app();
    expect((await server.inject({ method: 'POST', url: CODE_URL, ...h(adminTok), payload: {} })).statusCode).toBe(200);
    const deuxieme = await server.inject({ method: 'POST', url: CODE_URL, ...h(adminTok), payload: {} });
    expect(deuxieme.statusCode).toBe(429);
    expect(cap.codes).toHaveLength(1);
    await server.close();
  });

  it('refus de Meta -> 422 portant SON message (c’est la seule chose qui aide à débloquer)', async () => {
    const { server } = app({ demanderCode: async () => { throw new Error('Graph 400 (#133016) : too many attempts'); } });
    const res = await server.inject({ method: 'POST', url: CODE_URL, ...h(adminTok), payload: {} });
    expect(res.statusCode).toBe(422);
    expect(res.json<{ error: string }>().error).toMatch(/133016/);
    await server.close();
  });

  it('agent -> 403 (le module entier est admin)', async () => {
    const { server } = app();
    expect((await server.inject({ method: 'POST', url: CODE_URL, ...h(agentTok), payload: {} })).statusCode).toBe(403);
    await server.close();
  });
});

describe('POST /tenants/:tenantId/numero/activer', () => {
  it('déjà CONNECTED -> 200 sans rien appeler (le bouton lit l’état avant d’agir)', async () => {
    const { server, cap } = app({ etatNumero: async () => ({ status: 'CONNECTED', codeVerificationStatus: 'VERIFIED' }) });
    const res = await server.inject({ method: 'POST', url: ACTIVER_URL, ...h(adminTok), payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ actif: true });
    expect(cap.verifies).toHaveLength(0);
    expect(cap.registres).toHaveLength(0);
    await server.close();
  });

  it('non vérifié SANS code -> 400, et rien n’est tenté', async () => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'POST', url: ACTIVER_URL, ...h(adminTok), payload: {} });
    expect(res.statusCode).toBe(400);
    expect(cap.verifies).toHaveLength(0);
    expect(cap.registres).toHaveLength(0);
    await server.close();
  });

  it('non vérifié AVEC code : vérification puis enregistrement, PIN à 6 chiffres conservé', async () => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'POST', url: ACTIVER_URL, ...h(adminTok), payload: { code: '123456' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ actif: true });
    expect(cap.verifies).toEqual([{ phoneNumberId: 'pn-1', code: '123456' }]);
    expect(cap.registres).toHaveLength(1);
    expect(cap.registres[0]!.pin).toMatch(/^\d{6}$/);
    expect(cap.pins).toEqual([cap.registres[0]!.pin]);
    await server.close();
  });

  it('déjà VÉRIFIÉ mais pas enregistré : register SEUL, aucune vérification (Meta la refuserait)', async () => {
    const { server, cap } = app({ etatNumero: async () => ({ status: 'PENDING', codeVerificationStatus: 'VERIFIED' }) });
    const res = await server.inject({ method: 'POST', url: ACTIVER_URL, ...h(adminTok), payload: {} });
    expect(res.statusCode).toBe(200);
    expect(cap.verifies).toHaveLength(0);
    expect(cap.registres).toHaveLength(1);
    await server.close();
  });

  it('code refusé -> 422, et le register n’est JAMAIS tenté', async () => {
    const { server, cap } = app({ verifierCode: async () => { throw new Error('Graph 400 (#136025) : invalid code'); } });
    const res = await server.inject({ method: 'POST', url: ACTIVER_URL, ...h(adminTok), payload: { code: '000000' } });
    expect(res.statusCode).toBe(422);
    expect(res.json<{ error: string }>().error).toMatch(/136025/);
    expect(cap.registres).toHaveLength(0);
    await server.close();
  });

  it('register refusé -> 422, et le PIN n’est PAS conservé (il n’a pas été posé)', async () => {
    // Conserver un PIN que Meta n'a pas accepté donnerait un secret faux en base, qui ferait échouer la
    // prochaine re-régistration sans que personne ne comprenne pourquoi.
    const { server, cap } = app({ enregistrerNumero: async () => { throw new Error('Graph 400 (#133006) : verify first'); } });
    const res = await server.inject({ method: 'POST', url: ACTIVER_URL, ...h(adminTok), payload: { code: '123456' } });
    expect(res.statusCode).toBe(422);
    expect(cap.pins).toHaveLength(0);
    await server.close();
  });

  it('aucun numéro rattaché -> 404', async () => {
    const { server } = app({ numeroDuTenant: async () => null });
    const res = await server.inject({ method: 'POST', url: ACTIVER_URL, ...h(adminTok), payload: {} });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: string }>().error).toMatch(/aucun numéro/);
    await server.close();
  });

  it('agent -> 403', async () => {
    const { server } = app();
    expect((await server.inject({ method: 'POST', url: ACTIVER_URL, ...h(agentTok), payload: {} })).statusCode).toBe(403);
    await server.close();
  });
});

/**
 * Les deux défauts trouvés par la revue du 2026-09-22, chacun tenu par son test.
 */
describe('ce que la revue a corrigé', () => {
  it('🔴 un envoi de code REFUSÉ arme quand même le délai : Meta compte les requêtes, pas les succès', async () => {
    // Sans ça, le chemin d'échec était le seul non protégé, c'est-à-dire celui où le client reclique parce
    // que « rien ne s'est passé ». Dix clics et le numéro est bloqué 72 h.
    let appels = 0;
    const { server } = app({ demanderCode: async () => { appels += 1; throw new Error('Graph 400 (#131000)'); } });
    expect((await server.inject({ method: 'POST', url: CODE_URL, ...h(adminTok), payload: {} })).statusCode).toBe(422);
    const deuxieme = await server.inject({ method: 'POST', url: CODE_URL, ...h(adminTok), payload: {} });
    expect(deuxieme.statusCode).toBe(429);
    expect(appels).toBe(1); // Meta n'a PAS été rappelé
    await server.close();
  });

  it('🔴 PIN non conservé : l’activation RÉUSSIT quand même (Meta a déjà activé le numéro)', async () => {
    // Un numéro branché à la main n'a aucune ligne de credentials où écrire le PIN. Rendre une erreur
    // annoncerait une panne sur un numéro qui marche, et inviterait à recommencer, donc à brûler un essai.
    const { server, cap } = app({ sauverPin: async () => { throw new Error('aucune ligne de credentials'); } });
    const res = await server.inject({ method: 'POST', url: ACTIVER_URL, ...h(adminTok), payload: { code: '123456' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ actif: true });
    expect(cap.registres).toHaveLength(1);
    await server.close();
  });
});

/**
 * « DÉLIER » ET « RELIER » LE NUMÉRO (migration 0180, bloc « Canaux et services » de l'Accueil).
 *
 * 🔴 CE QUE CES TESTS PROTÈGENT : les deux gestes ne parlent JAMAIS à Meta (le numéro reste relié à son compte
 * WhatsApp, c'est ce qui rend la reconnexion d'un clic possible), ils sont réservés aux admins, et ils ne
 * portent que sur l'espace du jeton. Ce qu'ils font en base est tenu par
 * `tests/integration/numero-delie.integration.test.ts`.
 */
describe('POST /tenants/:tenantId/numero/delier et /relier', () => {
  const DELIER_URL = '/tenants/t1/numero/delier';
  const RELIER_URL = '/tenants/t1/numero/relier';

  it('🔴 délier : 200, l’espace du jeton, le compte de campagnes en pause, et AUCUN appel à Meta', async () => {
    let meta = 0;
    const { server, cap } = app({
      etatNumero: async () => { meta += 1; return { status: 'CONNECTED', codeVerificationStatus: 'VERIFIED' }; },
      demanderCode: async () => { meta += 1; },
      enregistrerNumero: async () => { meta += 1; },
    });
    const res = await server.inject({ method: 'POST', url: DELIER_URL, ...h(adminTok), payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ delie: true, delieLe: '2026-09-25T10:00:00.000Z', campagnesEnPause: 2 });
    expect(cap.delies).toEqual(['t1']);
    expect(cap.audit).toEqual(['numero.delie']);
    expect(meta).toBe(0);
    await server.close();
  });

  it('relier : 200 sans confirmation, et ce qui repart', async () => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'POST', url: RELIER_URL, ...h(adminTok), payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ relie: true, campagnesReprises: 1, campagnesReprogrammees: 1 });
    expect(cap.relies).toEqual(['t1']);
    expect(cap.audit).toEqual(['numero.relie']);
    await server.close();
  });

  it('aucun numéro : 404 des deux côtés, et rien au journal', async () => {
    const { server, cap } = app({ delierNumero: async () => null, relierNumero: async () => null });
    expect((await server.inject({ method: 'POST', url: DELIER_URL, ...h(adminTok), payload: {} })).statusCode).toBe(404);
    expect((await server.inject({ method: 'POST', url: RELIER_URL, ...h(adminTok), payload: {} })).statusCode).toBe(404);
    expect(cap.audit).toEqual([]);
    await server.close();
  });

  it('🔴 un agent est refusé (403) et rien n’est délié', async () => {
    const { server, cap } = app();
    expect((await server.inject({ method: 'POST', url: DELIER_URL, ...h(agentTok), payload: {} })).statusCode).toBe(403);
    expect((await server.inject({ method: 'POST', url: RELIER_URL, ...h(agentTok), payload: {} })).statusCode).toBe(403);
    expect(cap.delies).toEqual([]);
    expect(cap.relies).toEqual([]);
    await server.close();
  });

  it('🔴 isolation : un admin ne délie pas le numéro d’un AUTRE espace', async () => {
    const { server, cap } = app();
    expect((await server.inject({ method: 'POST', url: '/tenants/t2/numero/delier', ...h(adminTok), payload: {} })).statusCode).toBe(403);
    expect((await server.inject({ method: 'POST', url: '/tenants/t2/numero/relier', ...h(adminTok), payload: {} })).statusCode).toBe(403);
    expect(cap.delies).toEqual([]);
    expect(cap.relies).toEqual([]);
    await server.close();
  });
});
