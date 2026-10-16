import { describe, it, expect, vi } from 'vitest';
import { MetaClientFactory } from '../src/meta/factory';
import { CompteChez360dialog, MetaCredentialsResolver, TokenInvalidError, type CredentialsResolverDeps, type WabaCredential } from '../src/meta/credentials';
import type { HttpTransport, HttpResponse } from '../src/meta/http';
import { Media360dialogClient } from '../src/meta/media-360dialog';
import { MediaTropGros, MediaUploadError } from '../src/meta/media';
import { Cle360dialogRefusee, Config360dialogClient, Erreur360dialog } from '../src/meta/config-360dialog';
import { Template360dialogClient } from '../src/meta/templates-360dialog';
import { MetaTemplateClient } from '../src/meta/templates';
import { MetaFlowClient } from '../src/meta/flows';

/**
 * 360dialog, lot 2, livraison A : un numéro porté par 360dialog envoie par `waba-v2.360dialog.io` avec SA clé, et
 * sa clé n'est JAMAIS rendue à ce qui parle à Graph. Les formes des réponses de 360dialog sont celles mesurées le
 * 2026-10-15 sur le premier numéro.
 */

const jamaisDelie = async (): Promise<boolean> => false;
const jamaisSuspendu = async (): Promise<boolean> => false;
const listeToujoursVide = { retirerAvantUnModele: async (): Promise<void> => {} };
const modelesIllimites = { consommer: async () => ({ ok: true as const }) };

/** Un transport qui note chaque appel et REFUSE Graph pour un espace 360dialog : la preuve que rien n'y part. */
class TransportNotant implements HttpTransport {
  readonly appels: Array<{ url: string; body: unknown; headers: Record<string, string> }> = [];
  constructor(private readonly reponses: HttpResponse[] = []) {}
  async post(url: string, body: unknown, headers: Record<string, string>): Promise<HttpResponse> {
    this.appels.push({ url, body, headers });
    return this.reponses.shift() ?? { status: 200, json: { messages: [{ id: 'wamid.ok' }] } };
  }
}

function resolveur(creds: Record<string, WabaCredential>, tenants: Record<string, string>) {
  const invalides: string[] = [];
  const deps: CredentialsResolverDeps = {
    getWabaIdForTenant: async (t) => tenants[t] ?? null,
    credentials: {
      getCredentialsByWaba: async (w) => creds[w] ?? null,
      markTokenInvalid: async (w) => { invalides.push(w); },
    },
    decrypt: (enc) => enc.replace(/^enc:/, ''),
    fallbackToken: 'GLOBAL',
  };
  return { r: new MetaCredentialsResolver(deps), invalides };
}

const CREDS = {
  w360: { businessTokenEnc: 'enc:CLE_D360', tokenStatus: 'active', fournisseur: '360dialog' },
  wMeta: { businessTokenEnc: 'enc:TOK_META', tokenStatus: 'active', fournisseur: 'meta' },
} satisfies Record<string, WabaCredential>;
const TENANTS = { t360: 'w360', tMeta: 'wMeta' };

function fabrique(r: MetaCredentialsResolver, transport: HttpTransport, marketingViaLite = false) {
  return new MetaClientFactory({
    resolver: r, transport, version: 'v25.0', marketingViaLite,
    numerosDelies: { estDelie: jamaisDelie }, numerosSuspendus: { estSuspendu: jamaisSuspendu },
    listeDeLAgent: listeToujoursVide, quotaModeles: modelesIllimites,
  });
}

describe('le résolveur ne rend une clé 360dialog qu’à la voie d’envoi', () => {
  it('🔴 resolveForTenant et resolveForWaba lèvent CompteChez360dialog : aucun client Graph ne reçoit la clé', async () => {
    const { r } = resolveur(CREDS, TENANTS);
    await expect(r.resolveForTenant('t360')).rejects.toBeInstanceOf(CompteChez360dialog);
    await expect(r.resolveForWaba('w360')).rejects.toBeInstanceOf(CompteChez360dialog);
    // Le cache ne change rien : la seconde lecture lève aussi.
    await r.resolvePourEnvoi('t360');
    await expect(r.resolveForTenant('t360')).rejects.toBeInstanceOf(CompteChez360dialog);
  });

  it('resolvePourEnvoi rend la clé et son fournisseur ; un compte Meta est inchangé', async () => {
    const { r } = resolveur(CREDS, TENANTS);
    expect(await r.resolvePourEnvoi('t360')).toMatchObject({ token: 'CLE_D360', fournisseur: '360dialog', wabaId: 'w360' });
    expect(await r.resolvePourEnvoi('tMeta')).toMatchObject({ token: 'TOK_META', fournisseur: 'meta' });
    expect((await r.resolveForTenant('tMeta')).token).toBe('TOK_META');
  });

  it('une ligne sans fournisseur (avant 0239) vaut Meta', async () => {
    const { r } = resolveur({ w: { businessTokenEnc: 'enc:T', tokenStatus: 'active' } }, { t: 'w' });
    expect((await r.resolveForTenant('t')).token).toBe('T');
  });

  it('🔴 cle360dialog n’échoue jamais : une lecture en échec rend null (le chemin Meta d’avant)', async () => {
    const r = new MetaCredentialsResolver({
      getWabaIdForTenant: async () => 'w',
      credentials: { getCredentialsByWaba: async () => { throw new Error('base injoignable'); }, markTokenInvalid: async () => {} },
      decrypt: (e) => e,
      fallbackToken: 'GLOBAL',
    });
    expect(await r.cle360dialog('t')).toBeNull();
  });

  it('cle360dialog : la clé pour un espace 360dialog, null pour Meta ou un jeton Meta invalide', async () => {
    const { r } = resolveur({ ...CREDS, wMort: { businessTokenEnc: 'enc:X', tokenStatus: 'invalid' } }, { ...TENANTS, tMort: 'wMort' });
    expect(await r.cle360dialog('t360')).toBe('CLE_D360');
    expect(await r.cle360dialog('tMeta')).toBeNull();
    expect(await r.cle360dialog('tMort')).toBeNull();
    expect(await r.cle360dialog('sansCompte')).toBeNull();
  });

  it('une clé 360dialog invalide lève TokenInvalidError à l’envoi, comme un jeton', async () => {
    const { r } = resolveur({ w: { businessTokenEnc: 'enc:K', tokenStatus: 'invalid', fournisseur: '360dialog' } }, { t: 'w' });
    await expect(r.resolvePourEnvoi('t')).rejects.toBeInstanceOf(TokenInvalidError);
  });
});

describe('la fabrique envoie un espace 360dialog chez 360dialog', () => {
  it('🔴 texte, modèle : waba-v2.360dialog.io/messages, en-tête D360-API-KEY, AUCUN appel à Graph', async () => {
    const t = new TransportNotant();
    const f = fabrique(resolveur(CREDS, TENANTS).r, t);
    const c = await f.clientForTenant('t360', '1111');
    await c.sendText('33600000001', 'Bonjour');
    await c.sendTemplate('33600000001', { name: 'promo', language: 'fr' });
    expect(t.appels.map((a) => a.url)).toEqual(['https://waba-v2.360dialog.io/messages', 'https://waba-v2.360dialog.io/messages']);
    for (const a of t.appels) {
      expect(a.headers).toEqual({ 'D360-API-KEY': 'CLE_D360' });
      expect(a.url).not.toContain('graph.facebook.com');
    }
  });

  it('marketing par MM Lite : /marketing_messages, même corps que chez Meta (mesuré, product_policy compris)', async () => {
    const t = new TransportNotant();
    const f = fabrique(resolveur(CREDS, TENANTS).r, t, true);
    await (await f.clientForTenant('t360', '1111')).sendMarketing({ to: '33600000001', template: { name: 'promo', language: 'fr' } });
    expect(t.appels[0]?.url).toBe('https://waba-v2.360dialog.io/marketing_messages');
    expect(t.appels[0]?.body).toMatchObject({ product_policy: 'CLOUD_API_FALLBACK', type: 'template' });
  });

  it('un espace Meta garde Graph et son Bearer', async () => {
    const t = new TransportNotant();
    const f = fabrique(resolveur(CREDS, TENANTS).r, t);
    await (await f.clientForTenant('tMeta', 'pnM')).sendText('33600000001', 'Bonjour');
    expect(t.appels[0]?.url).toBe('https://graph.facebook.com/v25.0/pnM/messages');
    expect(t.appels[0]?.headers).toEqual({ Authorization: 'Bearer TOK_META' });
  });

  it('un 401 de 360dialog invalide la clé de CE compte (même règle qu’un jeton mort)', async () => {
    const t = new TransportNotant([{ status: 401, json: { error: { message: 'clé refusée' } } }]);
    const { r, invalides } = resolveur(CREDS, TENANTS);
    const c = await fabrique(r, t).clientForTenant('t360', '1111');
    await expect(c.sendText('33600000001', 'x')).rejects.toBeTruthy();
    expect(invalides).toEqual(['w360']);
  });

  it('🔴 les clients Graph (statut du numéro, agent de Meta, tarifs, inscription) refusent un espace 360dialog, sans rien invalider', async () => {
    const t = new TransportNotant();
    const { r, invalides } = resolveur(CREDS, TENANTS);
    const f = fabrique(r, t);
    for (const construire of [
      () => f.phoneClientForTenant('t360'), () => f.mbaClientForTenant('t360'),
      () => f.pricingClientForTenant('t360'), () => f.phoneRegisterClientForTenant('t360'),
    ]) {
      await expect(construire()).rejects.toBeInstanceOf(CompteChez360dialog);
    }
    expect(t.appels).toEqual([]);
    expect(invalides).toEqual([]);
  });

  it('🔴 un 401 sur la liste des modèles d’un espace 360dialog n’invalide PAS la clé (seul un envoi la juge)', async () => {
    const { r, invalides } = resolveur(CREDS, TENANTS);
    const f = fabrique(r, new TransportNotant());
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ meta: { developer_message: 'refus' } }), { status: 401 }));
    try {
      await expect((await f.templateClientForTenant('t360')).list('w360')).rejects.toMatchObject({ httpStatus: 401 });
      await expect((await f.flowClientForTenant('t360')).list('w360')).rejects.toMatchObject({ httpStatus: 401 });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(invalides).toEqual([]);
  });

  it('modèles et Flows (livraisons B et C) : un espace 360dialog reçoit le client 360dialog, un espace Meta le client Meta', async () => {
    const f = fabrique(resolveur(CREDS, TENANTS).r, new TransportNotant());
    expect(await f.templateClientForTenant('t360')).toBeInstanceOf(Template360dialogClient);
    expect(await f.templateClientForTenant('tMeta')).toBeInstanceOf(MetaTemplateClient);
    expect(await f.templateClientForTenant('tMeta')).not.toBeInstanceOf(Template360dialogClient);
  });
});

describe('les modèles d’un numéro 360dialog (livraison B)', () => {
  const MODELE = (nom: string, statut: string, extra: Record<string, unknown> = {}) => ({
    id: `d360-${nom}`, external_id: `meta-${nom}`, name: nom, language: 'fr', status: statut, category: 'MARKETING',
    components: [
      { type: 'HEADER', format: 'IMAGE', example: { header_handle: ['https://cdn.ailleurs.example/a.jpg'] } },
      { type: 'BODY', text: 'Bonjour {{1}}' },
    ],
    ...extra,
  });

  it('la liste : identifiant de Meta, statut en MAJUSCULES, jamais modifiable, et la clé en D360-API-KEY', async () => {
    const { appels, fetchImpl } = faussesReponses([{ status: 200, json: { waba_templates: [MODELE('promo', 'approved')], total: 1, count: 1 } }]);
    const [m] = await new Template360dialogClient('CLE', fetchImpl).list('ignoré');
    expect(m).toMatchObject({ id: 'meta-promo', name: 'promo', status: 'APPROVED', category: 'MARKETING', body: 'Bonjour {{1}}', headerFormat: 'IMAGE', headerMediaUrl: 'https://cdn.ailleurs.example/a.jpg', editable: false });
    expect(appels[0]?.url).toBe('https://waba-v2.360dialog.io/v1/configs/templates?limit=100&offset=0');
    expect((appels[0]?.init.headers as Record<string, string>)['D360-API-KEY']).toBe('CLE');
    expect(appels[0]?.init.redirect).toBe('error');
  });

  it('la liste suit limit et offset jusqu’au total, et écarte une ligne illisible', async () => {
    const page = (n: number, depart: number) => Array.from({ length: n }, (_, i) => MODELE(`m${depart + i}`, 'approved'));
    const { appels, fetchImpl } = faussesReponses([
      { status: 200, json: { waba_templates: [...page(99, 0), { name: 'sans statut' }], total: 130 } },
      { status: 200, json: { waba_templates: page(30, 100), total: 130 } },
    ]);
    const liste = await new Template360dialogClient('CLE', fetchImpl).list('w');
    expect(liste).toHaveLength(129);
    expect(appels.map((a) => a.url.split('?')[1])).toEqual(['limit=100&offset=0', 'limit=100&offset=100']);
  });

  it('statutsDuNom : le nom exact seulement, le motif de refus lu, NONE ramené à null', async () => {
    const { fetchImpl } = faussesReponses([{ status: 200, json: { waba_templates: [
      MODELE('promo', 'rejected', { rejected_reason: 'INVALID_FORMAT' }), MODELE('promo2', 'approved'), MODELE('promo', 'approved', { language: 'en', rejected_reason: 'NONE' }),
    ] } }]);
    expect(await new Template360dialogClient('CLE', fetchImpl).statutsDuNom('w', 'promo')).toEqual([
      { language: 'fr', status: 'REJECTED', category: 'MARKETING', rejectedReason: 'INVALID_FORMAT' },
      { language: 'en', status: 'APPROVED', category: 'MARKETING', rejectedReason: null },
    ]);
  });

  it('create : les components de Meta, la forme mesurée (allow_category_change), et l’identifiant de Meta rendu', async () => {
    const { appels, fetchImpl } = faussesReponses([{ status: 201, json: { external_id: '940505762119231', status: 'pending', category: 'UTILITY' } }]);
    const cree = await new Template360dialogClient('CLE', fetchImpl).create('w', { name: 'n', category: 'UTILITY', language: 'fr', body: 'Bonjour' });
    expect(cree).toEqual({ id: '940505762119231', status: 'PENDING', category: 'UTILITY' });
    expect(appels[0]?.init.method).toBe('POST');
    expect(JSON.parse(String(appels[0]?.init.body))).toEqual({ name: 'n', category: 'UTILITY', language: 'fr', allow_category_change: true, components: [{ type: 'BODY', text: 'Bonjour' }] });
  });

  it('remove : DELETE par le nom encodé ; un refus de 360dialog devient une MetaApiError lisible', async () => {
    const ok = faussesReponses([{ status: 200, json: { meta: { success: true } } }]);
    expect(await new Template360dialogClient('CLE', ok.fetchImpl).remove('w', 'a b')).toEqual({ success: true });
    expect(ok.appels[0]?.url).toBe('https://waba-v2.360dialog.io/v1/configs/templates/a%20b');
    const refus = faussesReponses([{ status: 400, json: { meta: { developer_message: 'Invalid payload' } } }]);
    await expect(new Template360dialogClient('CLE', refus.fetchImpl).remove('w', 'x')).rejects.toMatchObject({ httpStatus: 400, message: 'Invalid payload' });
  });

  it('update : refusé en 422, aucun appel', async () => {
    await expect(new Template360dialogClient('CLE', faussesReponses([]).fetchImpl).update()).rejects.toMatchObject({ statusCode: 422 });
  });
});

describe('les Flows d’un numéro 360dialog (livraison C)', () => {
  const entree = { name: 'Formulaire', screens: [], ref: 'ref1' };

  it('chaque méthode vise waba-v2.360dialog.io/flows..., avec la clé, sans Authorization ni redirection', async () => {
    const { appels, fetchImpl } = faussesReponses([
      { status: 200, json: { id: 'F1', success: true, validation_errors: [] } },
      { status: 200, json: { success: true, validation_errors: [] } },
      { status: 200, json: { success: true } },
      { status: 200, json: { success: true } },
      { status: 200, json: { success: true } },
      { status: 200, json: { data: [{ id: 'F1', name: 'Formulaire', status: 'DRAFT', categories: ['OTHER'] }] } },
    ]);
    const c = new MetaFlowClient('CLE', 'v25.0', '7.2', fetchImpl, '360dialog');
    await c.create('w', entree);
    await c.updateDraft('F1', entree);
    await c.publish('F1');
    await c.deprecate('F1');
    await c.delete('F1');
    expect(await c.list('w')).toEqual([{ id: 'F1', name: 'Formulaire', status: 'DRAFT', categories: ['OTHER'] }]);
    expect(appels.map((a) => `${a.init.method ?? 'GET'} ${a.url}`)).toEqual([
      'POST https://waba-v2.360dialog.io/flows',
      'POST https://waba-v2.360dialog.io/flows/F1/assets',
      'POST https://waba-v2.360dialog.io/flows/F1/publish',
      'POST https://waba-v2.360dialog.io/flows/F1/deprecate',
      'DELETE https://waba-v2.360dialog.io/flows/F1',
      'GET https://waba-v2.360dialog.io/flows?limit=100',
    ]);
    for (const a of appels) {
      const h = a.init.headers as Record<string, string>;
      expect(h['D360-API-KEY']).toBe('CLE');
      expect(Object.keys(h).map((k) => k.toLowerCase())).not.toContain('authorization');
      expect(a.init.redirect).toBe('error');
    }
  });

  it('🔴 une page suivante relayée de Graph n’est jamais suivie avec la clé', async () => {
    const { appels, fetchImpl } = faussesReponses([
      { status: 200, json: { data: [{ id: 'F1' }], paging: { next: 'https://graph.facebook.com/v23.0/w/flows?after=X' } } },
    ]);
    await new MetaFlowClient('CLE', 'v25.0', '7.2', fetchImpl, '360dialog').list('w');
    expect(appels).toHaveLength(1);
  });

  it('l’écran d’entrée : les fichiers lus avec la clé, le JSON téléchargé SANS (mesuré : il s’ouvre sans clé)', async () => {
    const { appels, fetchImpl } = faussesReponses([
      { status: 200, json: { data: [{ name: 'flow.json', asset_type: 'FLOW_JSON', download_url: 'https://mmg.whatsapp.net/flow.json' }] } },
      { status: 200, json: { screens: [{ id: 'ECRAN' }] } },
    ]);
    expect(await new MetaFlowClient('CLE', 'v25.0', '7.2', fetchImpl, '360dialog').ecranDEntree('F1')).toBe('ECRAN');
    expect(appels[0]?.url).toBe('https://waba-v2.360dialog.io/flows/F1/assets');
    expect(appels[1]?.init.headers).toBeUndefined();
  });
});

/** Un `fetch` programmable qui note chaque appel. */
function faussesReponses(reponses: Array<{ status: number; json?: unknown; corps?: Buffer }>) {
  const appels: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    appels.push({ url: String(url), init: init ?? {} });
    const r = reponses.shift();
    if (!r) throw new Error(`appel inattendu : ${String(url)}`);
    return new Response(r.corps ? new Uint8Array(r.corps) : JSON.stringify(r.json ?? null), { status: r.status });
  };
  return { appels, fetchImpl: fetchImpl as typeof fetch };
}

describe('les médias d’un numéro 360dialog', () => {
  const LIEN = 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=42&source=getMedia&ext=1&hash=h';

  it('téléchargement : le lien de Meta réécrit sur waba-v2, avec la clé (mesuré : en direct, 401)', async () => {
    const octets = Buffer.from('png');
    const { appels, fetchImpl } = faussesReponses([
      { status: 200, json: { url: LIEN, mime_type: 'image/png', file_size: 3 } },
      { status: 200, corps: octets },
    ]);
    const lu = await new Media360dialogClient('CLE', fetchImpl).telechargerEntrant('42', 1000);
    expect(lu).toEqual({ bytes: octets, mime: 'image/png' });
    expect(appels.map((a) => a.url)).toEqual([
      'https://waba-v2.360dialog.io/42',
      'https://waba-v2.360dialog.io/whatsapp_business/attachments/?mid=42&source=getMedia&ext=1&hash=h',
    ]);
    for (const a of appels) expect((a.init.headers as Record<string, string>)['D360-API-KEY']).toBe('CLE');
  });

  it('🔴 un lien d’un autre hôte n’est jamais appelé avec la clé', async () => {
    const { appels, fetchImpl } = faussesReponses([{ status: 200, json: { url: 'https://ailleurs.example/x', file_size: 3 } }]);
    await expect(new Media360dialogClient('CLE', fetchImpl).telechargerEntrant('42', 1000)).rejects.toBeInstanceOf(MediaUploadError);
    expect(appels).toHaveLength(1);
  });

  it('les deux plafonds de taille : annoncé, puis reçu', async () => {
    const annonce = faussesReponses([{ status: 200, json: { url: LIEN, file_size: 5000 } }]);
    await expect(new Media360dialogClient('CLE', annonce.fetchImpl).telechargerEntrant('42', 1000)).rejects.toBeInstanceOf(MediaTropGros);
    const recu = faussesReponses([{ status: 200, json: { url: LIEN } }, { status: 200, corps: Buffer.alloc(2000) }]);
    await expect(new Media360dialogClient('CLE', recu.fetchImpl).telechargerEntrant('42', 1000)).rejects.toBeInstanceOf(MediaTropGros);
  });

  it('envoi : POST /media rend l’identifiant ; une clé refusée ne se rejoue pas', async () => {
    const ok = faussesReponses([{ status: 200, json: { id: 'm1' } }]);
    expect(await new Media360dialogClient('CLE', ok.fetchImpl).uploadForSend('ignoré', Buffer.from('x'), 'image/png')).toBe('m1');
    expect(ok.appels[0]?.url).toBe('https://waba-v2.360dialog.io/media');
    const refus = faussesReponses([{ status: 401, json: {} }]);
    await expect(new Media360dialogClient('CLE', refus.fetchImpl).uploadForSend('x', Buffer.from('x'), 'image/png', 3)).rejects.toMatchObject({ httpStatus: 401 });
    expect(refus.appels).toHaveLength(1);
  });
});

describe('la configuration d’un numéro 360dialog', () => {
  const SANTE = { health_status: { entities: [
    { entity_type: 'PHONE_NUMBER', id: '1111' }, { entity_type: 'WABA', id: '2222' }, { entity_type: 'BUSINESS', id: '3333' },
  ] } };
  const NOTRE = { name: 'messagingme', url: 'https://api.example/webhooks/360dialog/1111', headers: { Authorization: 'Basic x' } };

  it('lireNumero : le numéro et le compte, lus dans /health_status', async () => {
    const { fetchImpl } = faussesReponses([{ status: 200, json: SANTE }]);
    expect(await new Config360dialogClient('CLE', fetchImpl).lireNumero()).toEqual({ phoneNumberId: '1111', wabaId: '2222' });
  });

  it('une clé refusée : Cle360dialogRefusee', async () => {
    const { fetchImpl } = faussesReponses([{ status: 401, json: {} }]);
    await expect(new Config360dialogClient('CLE', fetchImpl).lireNumero()).rejects.toBeInstanceOf(Cle360dialogRefusee);
  });

  it('🔴 webhooks multiples éteints : allumés avec le webhook EXISTANT recopié, puis le nôtre', async () => {
    const { appels, fetchImpl } = faussesReponses([
      { status: 409, json: { message: 'Multi webhook is disabled' } },
      { status: 200, json: { url: 'https://uchat.example/hook', headers: {} } },
      { status: 200, json: { message: 'started' } },
    ]);
    expect(await new Config360dialogClient('CLE', fetchImpl).poserWebhook(NOTRE)).toBe('allume');
    expect(appels[2]?.init.method).toBe('POST');
    expect(JSON.parse(String(appels[2]?.init.body))).toEqual({ enabled: true, destinations: [
      { name: 'existant', url: 'https://uchat.example/hook', headers: {} }, NOTRE,
    ] });
  });

  it('éteints, et le webhook simple est déjà le nôtre : pas de doublon', async () => {
    const { appels, fetchImpl } = faussesReponses([
      { status: 409, json: {} }, { status: 200, json: { url: NOTRE.url, headers: {} } }, { status: 200, json: {} },
    ]);
    await new Config360dialogClient('CLE', fetchImpl).poserWebhook(NOTRE);
    expect(JSON.parse(String(appels[2]?.init.body)).destinations).toEqual([NOTRE]);
  });

  it('allumés sans le nôtre : ajouté (PUT), les autres intacts ; avec le nôtre : mis à jour (PATCH)', async () => {
    const ajout = faussesReponses([{ status: 200, json: { enabled: true, destinations: [{ name: 'uchat', url: 'https://u' }] } }, { status: 200, json: {} }]);
    expect(await new Config360dialogClient('CLE', ajout.fetchImpl).poserWebhook(NOTRE)).toBe('ajoute');
    expect(ajout.appels[1]?.init.method).toBe('PUT');
    expect(JSON.parse(String(ajout.appels[1]?.init.body))).toEqual({ destinations: [NOTRE] });

    const maj = faussesReponses([{ status: 200, json: { enabled: true, destinations: [{ name: 'uchat', url: 'https://u' }, { name: 'messagingme', url: 'https://ancien' }] } }, { status: 200, json: {} }]);
    expect(await new Config360dialogClient('CLE', maj.fetchImpl).poserWebhook(NOTRE)).toBe('mis_a_jour');
    expect(maj.appels[1]?.init.method).toBe('PATCH');
  });

  it('trois destinations déjà, sans la nôtre : refus, rien n’est remplacé', async () => {
    const { appels, fetchImpl } = faussesReponses([{ status: 200, json: { enabled: true, destinations: [
      { name: 'a', url: 'https://a' }, { name: 'b', url: 'https://b' }, { name: 'c', url: 'https://c' },
    ] } }]);
    await expect(new Config360dialogClient('CLE', fetchImpl).poserWebhook(NOTRE)).rejects.toBeInstanceOf(Erreur360dialog);
    expect(appels).toHaveLength(1);
  });
});
