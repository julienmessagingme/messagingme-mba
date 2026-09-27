import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { creerClientSalesforce, lireQuota, SalesforceApiError, VERSION_API_SALESFORCE } from '../src/salesforce/client';
import { AdresseInterdite } from '../src/lib/connexion-publique';

/**
 * LE CLIENT REST SALESFORCE, contre un faux `fetch` : aucun réseau. L'org et l'utilisateur sont ceux de la forme
 * réelle d'une réponse de jeton (`/id/<orgId>/<userId>`).
 */
const ORIGINE = 'https://acme.my.salesforce.com';
const ORG = '00DQL00000ch3nx2AA';
const USER = '005QL00000abcdeYAB';

type Appel = { url: string; init: RequestInit };
type Reponse = Response | Error;

function fauxFetch(reponses: Reponse[]) {
  const appels: Appel[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    appels.push({ url, init });
    const r = reponses.shift();
    if (!r) throw new Error('plus de réponse prévue');
    if (r instanceof Error) throw r;
    return r;
  }) as unknown as typeof fetch;
  return { fetchImpl, appels };
}

const json = (corps: unknown, status = 200, entetes: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(corps), { status, headers: { 'content-type': 'application/json', ...entetes } });

const jetonOk = (instance = ORIGINE): Response =>
  json({ access_token: 'jeton-1', instance_url: instance, id: `https://login.salesforce.com/id/${ORG}/${USER}` });

const sansAttente = { sleep: async () => {}, random: () => 1 };
const client = (reponses: Reponse[], quotas: Array<{ origine: string; utilise: number; max: number }> = []) => {
  const f = fauxFetch(reponses);
  const c = creerClientSalesforce({
    clientId: 'cle', clientSecret: 'secret', fetchImpl: f.fetchImpl, retry: sansAttente,
    noterQuota: (origine, q) => quotas.push({ origine, ...q }),
  });
  return { c, appels: f.appels, quotas };
};

const schemaLimites = z.object({ DailyApiRequests: z.object({ Max: z.number() }) });
const CHEMIN = `/services/data/${VERSION_API_SALESFORCE}/limits`;

describe('le jeton', () => {
  it('le demande en client credentials À L ORG, et en tire l org et l utilisateur', async () => {
    const { c, appels } = client([jetonOk()]);
    const j = await c.jeton(ORIGINE);
    expect(j).toEqual({ accessToken: 'jeton-1', origine: ORIGINE, orgId: ORG, userId: USER });
    expect(appels[0]!.url).toBe(`${ORIGINE}/services/oauth2/token`);
    expect(String(appels[0]!.init.body)).toContain('grant_type=client_credentials');
    expect(appels[0]!.init.redirect).toBe('error');
  });

  it('le garde en cache, et deux demandes simultanées ne font qu UN appel', async () => {
    const { c, appels } = client([jetonOk()]);
    await Promise.all([c.jeton(ORIGINE), c.jeton(ORIGINE)]);
    await c.jeton(ORIGINE);
    expect(appels).toHaveLength(1);
  });

  it('🔴 refuse un jeton qui désigne une AUTRE adresse (on ne l enverrait jamais ailleurs)', async () => {
    const { c } = client([jetonOk('https://autre.my.salesforce.com')]);
    await expect(c.jeton(ORIGINE)).rejects.toMatchObject({ code: 'reponse_illisible' });
  });

  it('un refus de l org (app non installée, utilisateur non désigné) est définitif, avec le code OAuth', async () => {
    const { c, appels } = client([json({ error: 'invalid_client', error_description: 'app must be installed' }, 400)]);
    await expect(c.jeton(ORIGINE)).rejects.toMatchObject({ code: 'jeton_refuse', errorCode: 'invalid_client', retryable: false });
    expect(appels).toHaveLength(1);
  });

  it('un 503 sur le jeton est passager, et rejoué', async () => {
    const { c, appels } = client([json({}, 503), jetonOk()]);
    await expect(c.jeton(ORIGINE)).resolves.toMatchObject({ accessToken: 'jeton-1' });
    expect(appels).toHaveLength(2);
  });
});

describe('les appels', () => {
  it('passent le jeton, lisent le corps par le schéma, et relèvent le quota du client', async () => {
    const { c, appels, quotas } = client([jetonOk(), json({ DailyApiRequests: { Max: 15000 } }, 200, { 'sforce-limit-info': 'api-usage=18/15000' })]);
    const r = await c.requete(ORIGINE, 'GET', CHEMIN, schemaLimites);
    expect(r).toEqual({ statut: 200, donnees: { DailyApiRequests: { Max: 15000 } } });
    expect((appels[1]!.init.headers as Record<string, string>).authorization).toBe('Bearer jeton-1');
    expect(quotas).toEqual([{ origine: ORIGINE, utilise: 18, max: 15000 }]);
  });

  it('un 204 rend donnees null', async () => {
    const { c } = client([jetonOk(), new Response(null, { status: 204 })]);
    await expect(c.requete(ORIGINE, 'PATCH', '/services/data/v67.0/sobjects/Lead/00Q', z.unknown(), {})).resolves.toEqual({ statut: 204, donnees: null });
  });

  it('🔴 un jeton refusé est renouvelé UNE fois, puis l appel repart', async () => {
    const { c, appels } = client([
      jetonOk(),
      json([{ errorCode: 'INVALID_SESSION_ID', message: 'Session expired' }], 401),
      json({ access_token: 'jeton-2', instance_url: ORIGINE }),
      json({ DailyApiRequests: { Max: 1 } }),
    ]);
    await expect(c.requete(ORIGINE, 'GET', CHEMIN, schemaLimites)).resolves.toMatchObject({ statut: 200 });
    expect((appels[3]!.init.headers as Record<string, string>).authorization).toBe('Bearer jeton-2');
  });

  it('🔴 un second refus après renouvellement est réel : jeton_refuse, et pas de boucle', async () => {
    const refus = () => json([{ errorCode: 'INVALID_SESSION_ID', message: 'Session expired' }], 401);
    const { c, appels } = client([jetonOk(), refus(), jetonOk(), refus()]);
    await expect(c.requete(ORIGINE, 'GET', CHEMIN, schemaLimites)).rejects.toMatchObject({ code: 'jeton_refuse' });
    expect(appels).toHaveLength(4);
  });

  it('UNABLE_TO_LOCK_ROW arrive en 400 mais est PASSAGER : rejoué', async () => {
    const { c, appels } = client([jetonOk(), json([{ errorCode: 'UNABLE_TO_LOCK_ROW', message: 'lock' }], 400), json({ DailyApiRequests: { Max: 1 } })]);
    await expect(c.requete(ORIGINE, 'GET', CHEMIN, schemaLimites)).resolves.toMatchObject({ statut: 200 });
    expect(appels).toHaveLength(3);
  });

  it('REQUEST_LIMIT_EXCEEDED (le quota du jour du client) n est PAS rejoué dans la minute', async () => {
    const { c, appels } = client([jetonOk(), json([{ errorCode: 'REQUEST_LIMIT_EXCEEDED', message: 'limit' }], 403)]);
    await expect(c.requete(ORIGINE, 'GET', CHEMIN, schemaLimites)).rejects.toMatchObject({ code: 'quota_epuise', retryable: false });
    expect(appels).toHaveLength(2);
  });

  it('un refus métier (champ obligatoire) est définitif et garde le code de Salesforce', async () => {
    const { c } = client([jetonOk(), json([{ errorCode: 'REQUIRED_FIELD_MISSING', message: 'Required fields are missing: [Company]' }], 400)]);
    await expect(c.requete(ORIGINE, 'POST', '/services/data/v67.0/sobjects/Lead', z.unknown(), {})).rejects.toMatchObject({
      code: 'refus', errorCode: 'REQUIRED_FIELD_MISSING', retryable: false,
    });
  });

  it('une réponse qui n a pas la forme attendue est refusée, jamais castée', async () => {
    const { c } = client([jetonOk(), json({ autre: true })]);
    await expect(c.requete(ORIGINE, 'GET', CHEMIN, schemaLimites)).rejects.toMatchObject({ code: 'reponse_illisible' });
  });
});

describe('le chemin réseau', () => {
  it('🔴 un refus d adresse interne est DÉFINITIF : jamais rejoué comme une panne', async () => {
    const { c, appels } = client([new TypeError('fetch failed', { cause: new AdresseInterdite() })]);
    await expect(c.jeton(ORIGINE)).rejects.toMatchObject({ code: 'adresse_interne', retryable: false });
    expect(appels).toHaveLength(1);
  });

  it('🔴 une redirection se dit « l adresse de l org a changé », sans rejeu', async () => {
    const { c, appels } = client([new TypeError('fetch failed', { cause: new Error('unexpected redirect') })]);
    await expect(c.jeton(ORIGINE)).rejects.toMatchObject({ code: 'adresse_changee', retryable: false });
    expect(appels).toHaveLength(1);
  });

  it('une panne réseau ordinaire est rejouée', async () => {
    const { c, appels } = client([new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } }), jetonOk()]);
    await expect(c.jeton(ORIGINE)).resolves.toMatchObject({ accessToken: 'jeton-1' });
    expect(appels).toHaveLength(2);
  });

  it('un corps trop gros est refusé sans être rejoué', async () => {
    const f = fauxFetch([new Response('x'.repeat(2000), { status: 200 })]);
    const c = creerClientSalesforce({ clientId: 'c', clientSecret: 's', fetchImpl: f.fetchImpl, retry: sansAttente, maxOctets: 100 });
    await expect(c.jeton(ORIGINE)).rejects.toBeInstanceOf(SalesforceApiError);
    await expect(creerClientSalesforce({ clientId: 'c', clientSecret: 's', fetchImpl: fauxFetch([new Response('x'.repeat(2000))]).fetchImpl, retry: sansAttente, maxOctets: 100 }).jeton(ORIGINE))
      .rejects.toMatchObject({ code: 'reponse_trop_grosse' });
  });
});

describe('lireQuota', () => {
  it('lit l en-tête de Salesforce, et rend null sans lui', () => {
    expect(lireQuota('api-usage=18/15000')).toEqual({ utilise: 18, max: 15000 });
    expect(lireQuota('api-usage=18/15000; per-app-api-usage=2/100(appName=x)')).toEqual({ utilise: 18, max: 15000 });
    expect(lireQuota(null)).toBeNull();
    expect(lireQuota('autre=1')).toBeNull();
  });
});
