import { describe, it, expect, beforeAll } from 'vitest';
import { computeAccountStatus, normalizeQuality } from '../src/account/service';
import { pullFromInfo, pullFromError } from '../src/account/pull';
import { MetaPhoneNumberClient } from '../src/meta/phone-number';
import { MetaApiError } from '../src/meta/errors';
import { buildServer } from '../src/server';
import { FakeQueue } from './fake-queue';
import { signSession } from '../src/auth/token';
import type { FetchLike } from '../src/meta/templates';
import type { UserAuthStore, EmailIdentity } from '../src/auth/store';
import type { AccountRouteDeps, NumerosDep, PhoneNumberRecord } from '../src/http/account';
import { compteInerte } from './routes-inertes';

/** Enregistrement numéro complet (tous les nouveaux champs à null par défaut ; hubspotConnected=true = backfill). */
function rec(over: Partial<PhoneNumberRecord> = {}): PhoneNumberRecord {
  return {
    id: 'PN1', displayPhoneNumber: '+33 5 25 68 02 50', status: null, qualityRating: null, messagingLimitTier: null,
    nameStatus: null, codeVerificationStatus: null, throughputLevel: null, verifiedName: null,
    wabaHealthStatus: null, accountReviewStatus: null, businessVerificationStatus: null,
    marketingMessagesLiteApiStatus: null, ownerBusinessName: null, hubspotConnected: true, hubspotPausedAt: null,
    delieLe: null,
    wabaPaiementBloque: null,
    ...over,
  };
}

// --- Service pur (composition de la pastille) ---
describe('computeAccountStatus', () => {
  it('token invalide -> rouge (jamais gris)', () => {
    const s = computeAccountStatus({ reachable: false, authError: true, quality: 'GREEN', numberStatus: 'CONNECTED' });
    expect(s.dot).toBe('red');
  });
  it('injoignable (transitoire, sans erreur auth) -> gris', () => {
    expect(computeAccountStatus({ reachable: false, quality: 'GREEN', numberStatus: 'CONNECTED' }).dot).toBe('grey');
  });
  it('numéro en état bloquant -> rouge', () => {
    expect(computeAccountStatus({ reachable: true, quality: 'GREEN', numberStatus: 'RESTRICTED' }).dot).toBe('red');
  });
  it('qualité rouge -> rouge', () => {
    expect(computeAccountStatus({ reachable: true, quality: 'RED', numberStatus: 'CONNECTED' }).dot).toBe('red');
  });
  it('non connecté (PENDING) -> gris', () => {
    expect(computeAccountStatus({ reachable: true, quality: 'GREEN', numberStatus: 'PENDING' }).dot).toBe('grey');
  });
  it('connecté + qualité jaune -> ambre', () => {
    expect(computeAccountStatus({ reachable: true, quality: 'YELLOW', numberStatus: 'CONNECTED' }).dot).toBe('amber');
  });
  it('connecté + qualité verte -> vert', () => {
    expect(computeAccountStatus({ reachable: true, quality: 'GREEN', numberStatus: 'CONNECTED' }).dot).toBe('green');
  });
  it('connecté + qualité inconnue -> gris (JAMAIS faux vert)', () => {
    expect(computeAccountStatus({ reachable: true, quality: 'UNKNOWN', numberStatus: 'CONNECTED' }).dot).toBe('grey');
  });
  it('normalizeQuality : valeurs hors ensemble -> UNKNOWN', () => {
    expect(normalizeQuality('green')).toBe('GREEN');
    expect(normalizeQuality(null)).toBe('UNKNOWN');
    expect(normalizeQuality('FOO')).toBe('UNKNOWN');
  });
});

// --- Mapping du pull (anti faux-vert : la qualité UNKNOWN doit ÉCRASER l'ancienne, pas être omise) ---
describe('pullFromInfo / pullFromError', () => {
  it('🔴 la raison du blocage voyage avec la santé du compte, vrai comme faux', () => {
    expect(pullFromInfo({ status: 'CONNECTED' }, { healthStatus: 'BLOCKED', paiementBloque: true })).toMatchObject({ wabaPaiementBloque: true });
    expect(pullFromInfo({ status: 'CONNECTED' }, { healthStatus: 'AVAILABLE', paiementBloque: false })).toMatchObject({ wabaPaiementBloque: false });
    // Inconnue : rien n'est écrit, le dernier relevé reste (coalesce).
    expect(pullFromInfo({ status: 'CONNECTED' }, { healthStatus: 'AVAILABLE' })).not.toHaveProperty('wabaPaiementBloque');
  });

  it('inclut TOUJOURS qualityRating, y compris UNKNOWN (dégradation doit écraser en base)', () => {
    const r = pullFromInfo({ status: 'CONNECTED', qualityRating: undefined, messagingLimitTier: 'TIER_1K' });
    expect(r).toMatchObject({ ok: true, status: 'CONNECTED', qualityRating: 'UNKNOWN', messagingLimitTier: 'TIER_1K' });
  });
  it('normalise la qualité renvoyée', () => {
    expect(pullFromInfo({ qualityRating: 'green' })).toMatchObject({ ok: true, qualityRating: 'GREEN' });
    expect(pullFromInfo({ qualityRating: 'NA' })).toMatchObject({ ok: true, qualityRating: 'UNKNOWN' });
  });
  it('porte les nouveaux champs Meta (name/verif/throughput/verified_name) + santé WABA + MM Lite + business proprio', () => {
    const r = pullFromInfo(
      { status: 'CONNECTED', nameStatus: 'APPROVED', codeVerificationStatus: 'VERIFIED', throughputLevel: 'STANDARD', verifiedName: 'Acme' },
      { healthStatus: 'AVAILABLE', accountReviewStatus: 'APPROVED', businessVerificationStatus: 'verified', marketingMessagesLiteApiStatus: 'ONBOARDED', ownerBusinessName: 'Messaging Me' },
    );
    expect(r).toMatchObject({
      ok: true, nameStatus: 'APPROVED', codeVerificationStatus: 'VERIFIED', throughputLevel: 'STANDARD', verifiedName: 'Acme',
      wabaHealthStatus: 'AVAILABLE', accountReviewStatus: 'APPROVED', businessVerificationStatus: 'verified',
      marketingMessagesLiteApiStatus: 'ONBOARDED', ownerBusinessName: 'Messaging Me',
    });
  });
  it('champ absent -> omis (coalesce ne l\'écrasera pas) ; WABA absent -> aucun champ WABA', () => {
    const r = pullFromInfo({ status: 'CONNECTED' });
    expect(r).toMatchObject({ ok: true, status: 'CONNECTED' });
    expect(r).not.toHaveProperty('nameStatus');
    expect(r).not.toHaveProperty('wabaHealthStatus');
  });
  it('code 190 / HTTP 401 -> authError ; code 100 générique -> PAS authError (gris, pas rouge token)', () => {
    expect(pullFromError(new MetaApiError(401, { code: 190 }))).toEqual({ ok: false, authError: true });
    expect(pullFromError(new MetaApiError(400, { code: 100 }))).toEqual({ ok: false, authError: false });
    // Le type OAuthException seul n'est pas un jeton mort : la carte du numéro ne passe pas au rouge pour un refus.
    expect(pullFromError(new MetaApiError(400, { code: 100, type: 'OAuthException' }))).toEqual({ ok: false, authError: false });
    expect(pullFromError(new MetaApiError(400, { code: 190, type: 'OAuthException' }))).toEqual({ ok: false, authError: true });
    expect(pullFromError(new Error('boom'))).toEqual({ ok: false, authError: false });
  });
});

// --- Client Graph GET /{phone_number_id} ---
function makeFetch(responses: Array<{ ok: boolean; status: number; json: unknown }>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let i = 0;
  const fn: FetchLike = async (url, init) => {
    calls.push({ url: String(url), init: init as RequestInit });
    const r = responses[Math.min(i, responses.length - 1)]!;
    i += 1;
    return { ok: r.ok, status: r.status, json: async () => r.json } as Response;
  };
  return { fn, calls };
}

describe('MetaPhoneNumberClient.get', () => {
  it('GET avec fields + Bearer -> parse le statut', async () => {
    const { fn, calls } = makeFetch([
      { ok: true, status: 200, json: { status: 'CONNECTED', quality_rating: 'GREEN', messaging_limit_tier: 'TIER_1K', display_phone_number: '+33 5 25 68 02 50' } },
    ]);
    const client = new MetaPhoneNumberClient('tok', 'v25.0', fn);
    const info = await client.get('PN1');
    expect(info).toMatchObject({ status: 'CONNECTED', qualityRating: 'GREEN', messagingLimitTier: 'TIER_1K' });
    expect(calls[0]!.url).toContain('/v25.0/PN1?fields=');
    expect(calls[0]!.url).toContain('quality_rating');
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer tok');
  });

  it('token invalide (401 code 190) -> MetaApiError code 190', async () => {
    const { fn } = makeFetch([{ ok: false, status: 401, json: { error: { code: 190, message: 'token expiré' } } }]);
    const client = new MetaPhoneNumberClient('tok', 'v25.0', fn);
    await expect(client.get('PN1')).rejects.toBeInstanceOf(MetaApiError);
  });

  it('get : parse les nouveaux champs (throughput.level extrait de l\'objet)', async () => {
    const { fn } = makeFetch([
      { ok: true, status: 200, json: { status: 'CONNECTED', name_status: 'APPROVED', code_verification_status: 'VERIFIED', throughput: { level: 'STANDARD' }, verified_name: 'Acme' } },
    ]);
    const info = await new MetaPhoneNumberClient('tok', 'v25.0', fn).get('PN1');
    expect(info).toMatchObject({ status: 'CONNECTED', nameStatus: 'APPROVED', codeVerificationStatus: 'VERIFIED', throughputLevel: 'STANDARD', verifiedName: 'Acme' });
  });
});

describe('MetaPhoneNumberClient.getWabaHealth', () => {
  /** Répond selon les champs demandés : la santé et le statut de la Marketing Messages API sont deux appels. */
  function fetchParChamps(sante: { ok: boolean; status: number; json: unknown }, mm: { ok: boolean; status: number; json: unknown }) {
    const calls: string[] = [];
    const fn: FetchLike = async (url) => {
      calls.push(String(url));
      const r = String(url).includes('marketing_messages') ? mm : sante;
      return { ok: r.ok, status: r.status, json: async () => r.json } as Response;
    };
    return { fn, calls };
  }
  const SANTE = { ok: true, status: 200, json: { health_status: { can_send_message: 'AVAILABLE' }, account_review_status: 'APPROVED', business_verification_status: 'verified', owner_business_info: { name: 'Messaging Me', id: '103185632463539' } } };

  it('extrait can_send_message de l\'objet health_status + les statuts de revue + Marketing Messages API + business proprio', async () => {
    const { fn, calls } = fetchParChamps(SANTE, { ok: true, status: 200, json: { marketing_messages_onboarding_status: 'ONBOARDED', id: 'WABA1' } });
    const waba = await new MetaPhoneNumberClient('tok', 'v25.0', fn).getWabaHealth('WABA1');
    expect(waba).toMatchObject({ healthStatus: 'AVAILABLE', accountReviewStatus: 'APPROVED', businessVerificationStatus: 'verified', marketingMessagesLiteApiStatus: 'ONBOARDED', ownerBusinessName: 'Messaging Me', ownerBusinessId: '103185632463539' });
    const sante = calls.find((u) => u.includes('health_status'))!;
    expect(sante).toContain('/v25.0/WABA1?fields=');
    expect(sante).toContain('owner_business_info');
    // Le champ déprécié n'est plus demandé nulle part, et le statut ne voyage jamais avec la santé.
    expect(calls.some((u) => u.includes('marketing_messages_lite_api_status'))).toBe(false);
    expect(sante).not.toContain('marketing_messages');
    expect(calls.find((u) => u.includes('marketing_messages'))).toContain('/v25.0/WABA1?fields=marketing_messages_onboarding_status');
  });

  it('un statut refusé par Meta (erreur 100) n\'emporte ni la santé ni le propriétaire', async () => {
    const { fn } = fetchParChamps(SANTE, { ok: false, status: 400, json: { error: { code: 100, message: 'Tried accessing nonexisting field' } } });
    const waba = await new MetaPhoneNumberClient('tok', 'v25.0', fn).getWabaHealth('WABA1');
    expect(waba).toMatchObject({ healthStatus: 'AVAILABLE', ownerBusinessId: '103185632463539' });
    expect(waba.marketingMessagesLiteApiStatus).toBeUndefined();
  });

  it('accepte le statut en objet { status, time }, la forme du Business Manager', async () => {
    const { fn } = fetchParChamps(SANTE, { ok: true, status: 200, json: { marketing_messages_onboarding_status: { status: 'ELIGIBLE', time: '2026-10-14' } } });
    const waba = await new MetaPhoneNumberClient('tok', 'v25.0', fn).getWabaHealth('WABA1');
    expect(waba.marketingMessagesLiteApiStatus).toBe('ELIGIBLE');
  });

  it('une santé refusée reste une erreur (le jeton mort se voit toujours)', async () => {
    const { fn } = fetchParChamps({ ok: false, status: 401, json: { error: { code: 190, message: 'token expiré' } } }, { ok: false, status: 401, json: null });
    await expect(new MetaPhoneNumberClient('tok', 'v25.0', fn).getWabaHealth('WABA1')).rejects.toBeInstanceOf(MetaApiError);
  });

  it('tolère un health_status déjà en chaîne (selon version Graph)', async () => {
    const { fn } = makeFetch([{ ok: true, status: 200, json: { health_status: 'AVAILABLE' } }]);
    const waba = await new MetaPhoneNumberClient('tok', 'v25.0', fn).getWabaHealth('WABA1');
    expect(waba.healthStatus).toBe('AVAILABLE');
    // Une chaîne ne dit pas la raison : inconnue, jamais « pas de souci de carte ».
    expect(waba.paiementBloque).toBeUndefined();
  });

  it('🔴 la raison « moyen de paiement » (141006) sur l’entité WABA : le corps mesuré le 2026-10-13', async () => {
    const { fn } = makeFetch([{ ok: true, status: 200, json: { health_status: {
      can_send_message: 'BLOCKED',
      entities: [
        { entity_type: 'WABA', id: '1118096921152299', can_send_message: 'BLOCKED', errors: [{
          error_code: 141006,
          error_description: 'There is an error with the payment method. This will block business initiated conversations.',
          possible_solution: 'There was an error with your payment method. Please add a new payment method to the account.',
        }] },
        { entity_type: 'BUSINESS', id: '1', can_send_message: 'AVAILABLE' },
        { entity_type: 'APP', id: '2', can_send_message: 'AVAILABLE' },
      ],
    } } }]);
    const waba = await new MetaPhoneNumberClient('tok', 'v25.0', fn).getWabaHealth('WABA1');
    expect(waba).toMatchObject({ healthStatus: 'BLOCKED', paiementBloque: true });
  });

  it('🟡 un objet sans entités : inconnu s’il est bloqué (jamais un faux « pas de souci »), faux s’il est disponible', async () => {
    const bloque = makeFetch([{ ok: true, status: 200, json: { health_status: { can_send_message: 'BLOCKED' } } }]);
    expect((await new MetaPhoneNumberClient('tok', 'v25.0', bloque.fn).getWabaHealth('WABA1')).paiementBloque).toBeUndefined();
    const dispo = makeFetch([{ ok: true, status: 200, json: { health_status: { can_send_message: 'AVAILABLE' } } }]);
    expect((await new MetaPhoneNumberClient('tok', 'v25.0', dispo.fn).getWabaHealth('WABA1')).paiementBloque).toBe(false);
  });

  it('un compte disponible, ou bloqué pour une autre raison : pas bloqué pour paiement', async () => {
    const dispo = makeFetch([{ ok: true, status: 200, json: { health_status: { can_send_message: 'AVAILABLE', entities: [{ entity_type: 'WABA', id: '1', can_send_message: 'AVAILABLE' }] } } }]);
    expect((await new MetaPhoneNumberClient('tok', 'v25.0', dispo.fn).getWabaHealth('WABA1')).paiementBloque).toBe(false);
    const autre = makeFetch([{ ok: true, status: 200, json: { health_status: { can_send_message: 'BLOCKED', entities: [
      { entity_type: 'WABA', id: '1', can_send_message: 'BLOCKED', errors: [{ error_code: 141010, error_description: 'autre' }] },
    ] } } }]);
    expect((await new MetaPhoneNumberClient('tok', 'v25.0', autre.fn).getWabaHealth('WABA1')).paiementBloque).toBe(false);
  });
});

// --- Route /account-status ---
const SECRET = 'test-secret';
let adminTok = '';
let agentTok = '';
let otherTenantTok = '';
beforeAll(async () => {
  adminTok = await signSession({ userId: 'u1', tenantId: 't1', role: 'admin' }, SECRET);
  agentTok = await signSession({ userId: 'u2', tenantId: 't1', role: 'agent' }, SECRET);
  otherTenantTok = await signSession({ userId: 'u3', tenantId: 't2', role: 'admin' }, SECRET);
});
const noUsers: UserAuthStore = { findIdentity: async (): Promise<EmailIdentity | null> => null };
const h = (t: string) => ({ headers: { authorization: `Bearer ${t}` } });

function app(over: Partial<Omit<AccountRouteDeps, 'numeros'>> & { numeros?: Partial<NumerosDep> } = {}) {
  const saved: Array<{ id: string; patch: unknown }> = [];
  const hubspotCalls: Array<{ id: string; tenant: string; connected: boolean }> = [];
  const catchupCalls: string[] = [];
  const disconnectCalls: string[] = [];
  const disconnectTenantCalls: string[] = [];
  const { numeros, ...reste } = over;
  const deps: AccountRouteDeps = {
    ...compteInerte,
    numeros: {
      getPhoneNumber: async () => rec(),
      saveStatus: async (id, patch) => { saved.push({ id, patch }); },
      setHubspotConnected: async (id, tenant, connected) => { hubspotCalls.push({ id, tenant, connected }); return { updated: true, resumedFrom: null }; },
      disconnectHubspotTenant: async (tenant) => { disconnectTenantCalls.push(tenant); return { updated: true }; },
      ...numeros,
    },
    pullStatus: async () => ({ ok: true, status: 'CONNECTED', qualityRating: 'GREEN', messagingLimitTier: 'TIER_1K', displayPhoneNumber: '+33 5 25 68 02 50' }),
    enqueueHubspotCatchup: async (tenant) => { catchupCalls.push(tenant); },
    disconnectHubspot: async (tenant) => { disconnectCalls.push(tenant); return { disconnected: true, revoked: true }; },
    ...reste,
  };
  return { server: buildServer({ queue: new FakeQueue(), auth: { users: noUsers, secret: SECRET }, account: deps }), saved, hubspotCalls, catchupCalls, disconnectCalls, disconnectTenantCalls };
}

describe('route account-status', () => {
  it('🔴 le paiement bloqué chez Meta : lu frais, écrit, et rendu à l’Accueil ; sinon le dernier connu', async () => {
    const { server, saved } = app({ pullStatus: async () => ({ ok: true, status: 'CONNECTED', qualityRating: 'GREEN', wabaPaiementBloque: true }) });
    const body = (await server.inject({ method: 'GET', url: '/tenants/t1/account-status', ...h(adminTok) })).json<{ paiementMetaBloque: boolean | null }>();
    expect(body.paiementMetaBloque).toBe(true);
    expect(saved[0]!.patch).toMatchObject({ wabaPaiementBloque: true });
    await server.close();
    // Meta injoignable : le dernier relevé fait foi.
    const repli = app({ numeros: { getPhoneNumber: async () => rec({ wabaPaiementBloque: true }) }, pullStatus: async () => ({ ok: false, authError: false }) });
    expect((await repli.server.inject({ method: 'GET', url: '/tenants/t1/account-status', ...h(adminTok) })).json<{ paiementMetaBloque: boolean | null }>().paiementMetaBloque).toBe(true);
    await repli.server.close();
  });

  it('admin + pull vert -> 200 dot=green + persiste la qualité', async () => {
    const { server, saved } = app();
    const res = await server.inject({ method: 'GET', url: '/tenants/t1/account-status', ...h(adminTok) });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ status: { dot: string }; number: string; hasNumber: boolean }>();
    expect(body.status.dot).toBe('green');
    expect(body.hasNumber).toBe(true);
    expect(saved).toHaveLength(1);
    expect(saved[0]!.patch).toMatchObject({ status: 'CONNECTED', qualityRating: 'GREEN', messagingLimitTier: 'TIER_1K' });
    await server.close();
  });

  it('GREEN persisté + pull frais UNKNOWN -> dot=grey (jamais faux vert) + écrase en base', async () => {
    const { server, saved } = app({
      numeros: { getPhoneNumber: async () => rec({ displayPhoneNumber: '+33123', status: 'CONNECTED', qualityRating: 'GREEN', messagingLimitTier: 'TIER_1K' }) },
      pullStatus: async () => ({ ok: true, status: 'CONNECTED', qualityRating: 'UNKNOWN' }),
    });
    const res = await server.inject({ method: 'GET', url: '/tenants/t1/account-status', ...h(adminTok) });
    expect(res.json<{ status: { dot: string } }>().status.dot).toBe('grey');
    expect(saved[0]!.patch).toMatchObject({ qualityRating: 'UNKNOWN' });
    await server.close();
  });

  it('pull en erreur d\'auth -> dot=red, ne persiste rien', async () => {
    const { server, saved } = app({ pullStatus: async () => ({ ok: false, authError: true }) });
    const res = await server.inject({ method: 'GET', url: '/tenants/t1/account-status', ...h(adminTok) });
    expect(res.json<{ status: { dot: string } }>().status.dot).toBe('red');
    expect(saved).toHaveLength(0);
    await server.close();
  });

  it('🔴 numéro DÉLIÉ (migration 0180) : il reste affiché, avec sa date, et la pastille le dit malgré un pull vert', async () => {
    const { server } = app({ numeros: { getPhoneNumber: async () => rec({ delieLe: '2026-09-25T10:00:00.000Z' }) } });
    const res = await server.inject({ method: 'GET', url: '/tenants/t1/account-status', ...h(adminTok) });
    const body = res.json<{ hasNumber: boolean; delieLe: string | null; status: { dot: string; label: string } }>();
    // Toujours là : c'est ce qui permet de le relier d'un clic.
    expect(body.hasNumber).toBe(true);
    expect(body.delieLe).toBe('2026-09-25T10:00:00.000Z');
    expect(body.status).toMatchObject({ dot: 'grey', label: 'Numéro délié' });
    await server.close();
  });

  it('numéro relié : `delieLe` à null, la pastille de Meta', async () => {
    const { server } = app();
    const body = (await server.inject({ method: 'GET', url: '/tenants/t1/account-status', ...h(adminTok) })).json<{ delieLe: string | null; status: { dot: string } }>();
    expect(body.delieLe).toBeNull();
    expect(body.status.dot).toBe('green');
    await server.close();
  });

  it('pull transitoire (sans auth) -> dot=grey', async () => {
    const { server } = app({ pullStatus: async () => ({ ok: false, authError: false }) });
    const res = await server.inject({ method: 'GET', url: '/tenants/t1/account-status', ...h(adminTok) });
    expect(res.json<{ status: { dot: string } }>().status.dot).toBe('grey');
    await server.close();
  });

  it('aucun numéro -> hasNumber=false, dot=grey', async () => {
    const { server } = app({ numeros: { getPhoneNumber: async () => null } });
    const res = await server.inject({ method: 'GET', url: '/tenants/t1/account-status', ...h(adminTok) });
    const body = res.json<{ hasNumber: boolean; status: { dot: string } }>();
    expect(body.hasNumber).toBe(false);
    expect(body.status.dot).toBe('grey');
    await server.close();
  });

  it('agent -> 403 (réservé admin)', async () => {
    const { server } = app();
    const res = await server.inject({ method: 'GET', url: '/tenants/t1/account-status', ...h(agentTok) });
    expect(res.statusCode).toBe(403);
    await server.close();
  });

  it('tenant croisé -> 403', async () => {
    const { server } = app();
    const res = await server.inject({ method: 'GET', url: '/tenants/t1/account-status', ...h(otherTenantTok) });
    expect(res.statusCode).toBe(403);
    await server.close();
  });

  it('expose hubspotConnected, phoneNumberId + les champs Meta enrichis (frais prime le persisté)', async () => {
    const { server } = app({
      numeros: { getPhoneNumber: async () => rec({ hubspotConnected: false, nameStatus: 'PENDING_REVIEW' }) },
      pullStatus: async () => ({
        ok: true, status: 'CONNECTED', qualityRating: 'GREEN', nameStatus: 'APPROVED',
        codeVerificationStatus: 'VERIFIED', throughputLevel: 'STANDARD', verifiedName: 'Acme', wabaHealthStatus: 'AVAILABLE',
        marketingMessagesLiteApiStatus: 'ONBOARDED', ownerBusinessName: 'Messaging Me',
      }),
    });
    const res = await server.inject({ method: 'GET', url: '/tenants/t1/account-status', ...h(adminTok) });
    const body = res.json<AccountStatusBody>();
    expect(body.phoneNumberId).toBe('PN1');
    expect(body.hubspotConnected).toBe(false); // vient du record (pas du pull)
    expect(body.nameStatus).toBe('APPROVED'); // frais prime le persisté PENDING_REVIEW
    expect(body).toMatchObject({ codeVerificationStatus: 'VERIFIED', throughputLevel: 'STANDARD', verifiedName: 'Acme', wabaHealthStatus: 'AVAILABLE', marketingMessagesLiteApiStatus: 'ONBOARDED', ownerBusinessName: 'Messaging Me' });
    await server.close();
  });

  it('aucun numéro : MM Lite + business proprio à null (pas undefined)', async () => {
    const { server } = app({ numeros: { getPhoneNumber: async () => null } });
    const res = await server.inject({ method: 'GET', url: '/tenants/t1/account-status', ...h(adminTok) });
    const body = res.json<AccountStatusBody>();
    expect(body.marketingMessagesLiteApiStatus).toBeNull();
    expect(body.ownerBusinessName).toBeNull();
    await server.close();
  });

  it('expose hubspotPortal : portail lié -> connected + hubDomain', async () => {
    const { server } = app({ hubspotPortal: async () => ({ connected: true, hubId: '139615673', hubDomain: 'acme.hubspot.com' }) });
    const res = await server.inject({ method: 'GET', url: '/tenants/t1/account-status', ...h(adminTok) });
    const body = res.json<{ hubspotPortal: { connected: boolean; hubId?: string; hubDomain?: string | null } }>();
    expect(body.hubspotPortal).toEqual({ connected: true, hubId: '139615673', hubDomain: 'acme.hubspot.com' });
    await server.close();
  });

  it('hubspotPortal par défaut non connecté ; un échec de lecture NE casse pas la route (best-effort)', async () => {
    const { server } = app({ hubspotPortal: async () => { throw new Error('connecteur injoignable'); } });
    const res = await server.inject({ method: 'GET', url: '/tenants/t1/account-status', ...h(adminTok) });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ hubspotPortal: { connected: boolean } }>().hubspotPortal).toEqual({ connected: false });
    await server.close();
  });
});

interface AccountStatusBody {
  phoneNumberId: string | null; hubspotConnected: boolean; nameStatus: string | null;
  codeVerificationStatus: string | null; throughputLevel: string | null; verifiedName: string | null; wabaHealthStatus: string | null;
  marketingMessagesLiteApiStatus: string | null; ownerBusinessName: string | null;
}

describe('toggle HubSpot par numéro (PATCH .../hubspot)', () => {
  const url = '/tenants/t1/phone-numbers/PN1/hubspot';

  it('admin -> 200, flippe le flag (appel store avec le tenant scopé)', async () => {
    const { server, hubspotCalls } = app();
    const res = await server.inject({ method: 'PATCH', url, ...h(adminTok), payload: { connected: false } });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ hubspotConnected: boolean }>().hubspotConnected).toBe(false);
    expect(hubspotCalls).toEqual([{ id: 'PN1', tenant: 't1', connected: false }]);
    await server.close();
  });

  it('agent -> 403 (réservé admin), aucun appel store', async () => {
    const { server, hubspotCalls } = app();
    const res = await server.inject({ method: 'PATCH', url, ...h(agentTok), payload: { connected: true } });
    expect(res.statusCode).toBe(403);
    expect(hubspotCalls).toHaveLength(0);
    await server.close();
  });

  it('tenant croisé -> 403', async () => {
    const { server } = app();
    const res = await server.inject({ method: 'PATCH', url, ...h(otherTenantTok), payload: { connected: true } });
    expect(res.statusCode).toBe(403);
    await server.close();
  });

  it('body invalide (connected non booléen) -> 400', async () => {
    const { server } = app();
    const res = await server.inject({ method: 'PATCH', url, ...h(adminTok), payload: { connected: 'yes' } });
    expect(res.statusCode).toBe(400);
    await server.close();
  });

  it('numéro inconnu pour le tenant -> 404', async () => {
    const { server } = app({ numeros: { setHubspotConnected: async () => ({ updated: false, resumedFrom: null }) } });
    const res = await server.inject({ method: 'PATCH', url, ...h(adminTok), payload: { connected: true } });
    expect(res.statusCode).toBe(404);
    await server.close();
  });

  it('reprise APRÈS pause (resumedFrom non-null) -> déclenche le rattrapage, catchupTriggered:true', async () => {
    const { server, catchupCalls } = app({ numeros: { setHubspotConnected: async () => ({ updated: true, resumedFrom: '2026-07-20T10:00:00Z' }) } });
    const res = await server.inject({ method: 'PATCH', url, ...h(adminTok), payload: { connected: true } });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ catchupTriggered: boolean }>().catchupTriggered).toBe(true);
    expect(catchupCalls).toEqual(['t1']);
    await server.close();
  });

  it('1re activation (resumedFrom null) -> PAS de rattrapage, catchupTriggered:false', async () => {
    const { server, catchupCalls } = app({ numeros: { setHubspotConnected: async () => ({ updated: true, resumedFrom: null }) } });
    const res = await server.inject({ method: 'PATCH', url, ...h(adminTok), payload: { connected: true } });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ catchupTriggered: boolean }>().catchupTriggered).toBe(false);
    expect(catchupCalls).toHaveLength(0);
    await server.close();
  });

  it('enqueueHubspotCatchup qui throw -> le toggle reste 200 (best-effort), catchupTriggered:false', async () => {
    const { server } = app({
      numeros: { setHubspotConnected: async () => ({ updated: true, resumedFrom: '2026-07-20T10:00:00Z' }) },
      enqueueHubspotCatchup: async () => { throw new Error('pg-boss down'); },
    });
    const res = await server.inject({ method: 'PATCH', url, ...h(adminTok), payload: { connected: true } });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ catchupTriggered: boolean }>().catchupTriggered).toBe(false);
    await server.close();
  });

  // Déconnexion complète (candidat 2) : action:'disconnect' en coupant -> appel connecteur PUIS reset local.
  it('disconnect : appelle le connecteur PUIS coupe en base -> 200 {disconnected:true}, PAS de setHubspotConnected (pause)', async () => {
    const { server, hubspotCalls, disconnectCalls, disconnectTenantCalls } = app();
    const res = await server.inject({ method: 'PATCH', url, ...h(adminTok), payload: { connected: false, action: 'disconnect' } });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ disconnected: boolean; hubspotConnected: boolean }>()).toMatchObject({ disconnected: true, hubspotConnected: false });
    expect(disconnectCalls).toEqual(['t1']); // unlink connecteur avec le tenant scopé
    expect(disconnectTenantCalls).toEqual(['t1']); // reset local ensuite
    expect(hubspotCalls).toHaveLength(0); // le chemin pause n'est PAS emprunté
    await server.close();
  });

  it('disconnect avec connected:true -> 400 (contradiction), aucun appel', async () => {
    const { server, disconnectCalls } = app();
    const res = await server.inject({ method: 'PATCH', url, ...h(adminTok), payload: { connected: true, action: 'disconnect' } });
    expect(res.statusCode).toBe(400);
    expect(disconnectCalls).toHaveLength(0);
    await server.close();
  });

  it('action invalide -> 400', async () => {
    const { server } = app();
    const res = await server.inject({ method: 'PATCH', url, ...h(adminTok), payload: { connected: false, action: 'nope' } });
    expect(res.statusCode).toBe(400);
    await server.close();
  });

  it('disconnect mais canal connecteur non configuré (dep absente) -> 503, aucun reset local', async () => {
    const { server, disconnectTenantCalls } = app({ disconnectHubspot: undefined });
    const res = await server.inject({ method: 'PATCH', url, ...h(adminTok), payload: { connected: false, action: 'disconnect' } });
    expect(res.statusCode).toBe(503);
    expect(disconnectTenantCalls).toHaveLength(0);
    await server.close();
  });

  it('disconnect : le connecteur échoue -> 502 et reset local NON appliqué (anti-drift)', async () => {
    const { server, disconnectTenantCalls } = app({ disconnectHubspot: async () => { throw new Error('connecteur down'); } });
    const res = await server.inject({ method: 'PATCH', url, ...h(adminTok), payload: { connected: false, action: 'disconnect' } });
    expect(res.statusCode).toBe(502);
    expect(disconnectTenantCalls).toHaveLength(0); // on ne coupe PAS en base si l'unlink connecteur a échoué
    await server.close();
  });

  it('disconnect agent -> 403 (réservé admin), aucun appel connecteur', async () => {
    const { server, disconnectCalls } = app();
    const res = await server.inject({ method: 'PATCH', url, ...h(agentTok), payload: { connected: false, action: 'disconnect' } });
    expect(res.statusCode).toBe(403);
    expect(disconnectCalls).toHaveLength(0);
    await server.close();
  });
});

/**
 * Les TREIZE valeurs affichées de l'Accueil, et ce qui est écrit en base, figés champ par champ (audit ponytail
 * du 2026-09-25 : les treize `let` recopiés sont devenus une lecture « pull frais, sinon dernier connu »).
 */
describe('route account-status : le pull frais prime, le dernier connu comble', () => {
  const connu = rec({
    displayPhoneNumber: '+33 1 00 00 00 00', status: 'FLAGGED', qualityRating: 'YELLOW', messagingLimitTier: 'TIER_250',
    nameStatus: 'PENDING', codeVerificationStatus: 'NOT_VERIFIED', throughputLevel: 'STANDARD', verifiedName: 'Ancien',
    wabaHealthStatus: 'LIMITED', accountReviewStatus: 'PENDING', businessVerificationStatus: 'pending',
    marketingMessagesLiteApiStatus: 'INELIGIBLE', ownerBusinessName: 'Ancienne SA',
  });
  const complet = {
    ok: true as const, status: 'CONNECTED', qualityRating: 'GREEN', messagingLimitTier: 'TIER_1K',
    displayPhoneNumber: '+33 5 25 68 02 50', nameStatus: 'APPROVED', codeVerificationStatus: 'VERIFIED',
    throughputLevel: 'HIGH', verifiedName: 'Messaging Me', wabaHealthStatus: 'AVAILABLE', accountReviewStatus: 'APPROVED',
    businessVerificationStatus: 'verified', marketingMessagesLiteApiStatus: 'ONBOARDED', ownerBusinessName: 'SmartLink',
  };
  const champs = (b: Record<string, unknown>) => ({
    number: b.number, tier: b.tier, quality: b.quality, numberStatus: b.numberStatus, nameStatus: b.nameStatus,
    codeVerificationStatus: b.codeVerificationStatus, throughputLevel: b.throughputLevel, verifiedName: b.verifiedName,
    wabaHealthStatus: b.wabaHealthStatus, accountReviewStatus: b.accountReviewStatus,
    businessVerificationStatus: b.businessVerificationStatus, marketingMessagesLiteApiStatus: b.marketingMessagesLiteApiStatus,
    ownerBusinessName: b.ownerBusinessName,
  });

  it('pull COMPLET : tout vient du pull, et tout est enregistré SAUF le numéro d’affichage', async () => {
    const { server, saved } = app({ numeros: { getPhoneNumber: async () => connu }, pullStatus: async () => complet });
    const res = await server.inject({ method: 'GET', url: '/tenants/t1/account-status', ...h(adminTok) });
    const { ok: _ok, displayPhoneNumber: _affiche, ...enregistre } = complet;
    expect(saved).toEqual([{ id: 'PN1', patch: enregistre }]);
    expect(champs(res.json())).toEqual({
      number: '+33 5 25 68 02 50', tier: 'TIER_1K', quality: 'GREEN', numberStatus: 'CONNECTED', nameStatus: 'APPROVED',
      codeVerificationStatus: 'VERIFIED', throughputLevel: 'HIGH', verifiedName: 'Messaging Me', wabaHealthStatus: 'AVAILABLE',
      accountReviewStatus: 'APPROVED', businessVerificationStatus: 'verified', marketingMessagesLiteApiStatus: 'ONBOARDED',
      ownerBusinessName: 'SmartLink',
    });
    await server.close();
  });

  it('pull VIDE : chaque champ retombe sur le dernier connu', async () => {
    const { server, saved } = app({ numeros: { getPhoneNumber: async () => connu }, pullStatus: async () => ({ ok: true }) });
    const res = await server.inject({ method: 'GET', url: '/tenants/t1/account-status', ...h(adminTok) });
    expect(saved).toEqual([{ id: 'PN1', patch: {} }]);
    expect(champs(res.json())).toEqual({
      number: '+33 1 00 00 00 00', tier: 'TIER_250', quality: 'YELLOW', numberStatus: 'FLAGGED', nameStatus: 'PENDING',
      codeVerificationStatus: 'NOT_VERIFIED', throughputLevel: 'STANDARD', verifiedName: 'Ancien', wabaHealthStatus: 'LIMITED',
      accountReviewStatus: 'PENDING', businessVerificationStatus: 'pending', marketingMessagesLiteApiStatus: 'INELIGIBLE',
      ownerBusinessName: 'Ancienne SA',
    });
    await server.close();
  });

  it('pull en ÉCHEC ou absent : rien n’est enregistré, le dernier connu s’affiche, et `null` reste `null`', async () => {
    for (const pull of [{ ok: false as const, authError: false }, null]) {
      const { server, saved } = app({ numeros: { getPhoneNumber: async () => rec({ status: 'CONNECTED' }) }, pullStatus: async () => pull });
      const res = await server.inject({ method: 'GET', url: '/tenants/t1/account-status', ...h(adminTok) });
      expect(saved).toEqual([]);
      expect(champs(res.json())).toMatchObject({ number: '+33 5 25 68 02 50', numberStatus: 'CONNECTED', tier: null, verifiedName: null, ownerBusinessName: null });
      await server.close();
    }
  });
});
