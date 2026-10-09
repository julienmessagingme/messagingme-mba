import { describe, it, expect } from 'vitest';
import { buildServer } from '../src/server';
import { FakeQueue } from './fake-queue';
import { sha256Hex } from '../src/lib/signature';
import { GardeUsageMemoire } from './aide/usage';
import type { ApiKeyLookup } from '../src/auth/api-key-store.pg';
import { cleApiDeTest, aucunJetonOauth } from './aide/cle-api';
import { contactsV1Muets } from './aide/contacts-v1';
import { modelesInertes, aucuneCampagneActive } from './routes-inertes';
import { MetaTemplateClient, type FetchLike } from '../src/meta/templates';

/**
 * LES MODÈLES PAR L'API (lot 13, domaine 3) : `POST /v1/templates` au format de Meta, traduit vers la création de la
 * console, et `GET /v1/templates/{name}` pour suivre la validation. Meta est un faux `fetch` qui garde chaque appel.
 */
class FakeApiKeys implements ApiKeyLookup {
  private readonly byHash = new Map<string, { id: string; tenantId: string; scopes: string[] }>();
  add(raw: string, rec: { id: string; tenantId: string; scopes: string[] }) { this.byHash.set(sha256Hex(raw), rec); return this; }
  async findActiveByHash(hash: string) { return this.byHash.get(hash) ?? null; }
  async touchLastUsed(): Promise<void> {}
}

const AUTEUR = cleApiDeTest('auteur');
const ENVOYEUR = cleApiDeTest('envoyeur');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]);

interface Options {
  waba?: string | null;
  meta?: Array<{ ok: boolean; status: number; json: unknown }>;
  telechargement?: { octets: Buffer; mime: string } | { refus: string };
}

function monter(o: Options = {}) {
  const appelsMeta: Array<{ url: string; corps: Record<string, unknown> | null }> = [];
  const reponses = o.meta ?? [{ ok: true, status: 200, json: { id: 'tid', status: 'PENDING', category: 'UTILITY' } }];
  let i = 0;
  const fetchMeta: FetchLike = async (url, init) => {
    appelsMeta.push({ url, corps: typeof init.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : null });
    const r = reponses[Math.min(i, reponses.length - 1)]!;
    i += 1;
    return { ok: r.ok, status: r.status, json: async () => r.json } as Response;
  };
  const telechargements: string[] = [];
  const depots: Array<{ taille: number; mime: string }> = [];
  const usage = new GardeUsageMemoire();
  const keys = new FakeApiKeys()
    .add(AUTEUR, { id: 'k1', tenantId: 't1', scopes: ['templates:write'] })
    .add(ENVOYEUR, { id: 'k2', tenantId: 't1', scopes: ['sends:create', 'contacts:write', 'mcp:write', 'conversations:read'] });
  const server = buildServer({
    queue: new FakeQueue(),
    usage,
    v1: {
      apiKeys: keys,
      oauth: aucunJetonOauth,
      contacts: contactsV1Muets(),
      templates: {
        modeles: {
          ...modelesInertes,
          meta: { templateClientForTenant: async () => new MetaTemplateClient('tok', 'v23.0', fetchMeta) },
          repo: { getTenantWabaId: async () => (o.waba === undefined ? 'waba1' : o.waba), listActiveCampaignsForTemplate: aucuneCampagneActive },
        },
        telechargerEntete: async (_format, url) => {
          telechargements.push(url);
          return o.telechargement ?? { octets: JPEG, mime: 'image/jpeg' };
        },
        deposerEntete: async (octets, mime) => { depots.push({ taille: octets.length, mime }); return '4::handle'; },
      },
    },
  });
  const poster = (corps: unknown, cle = AUTEUR) => server.inject({
    method: 'POST', url: '/v1/templates', headers: { authorization: `Bearer ${cle}`, 'content-type': 'application/json' }, payload: corps as object,
  });
  const lire = (url: string, cle = AUTEUR) => server.inject({ method: 'GET', url, headers: { authorization: `Bearer ${cle}` } });
  return { server, poster, lire, appelsMeta, telechargements, depots, usage };
}

const MODELE = {
  name: 'commande_prete', language: 'fr', category: 'UTILITY',
  components: [
    { type: 'BODY', text: 'Bonjour {{1}}, votre commande est prête.', example: { body_text: [['Marie']] } },
    { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Merci' }] },
  ],
};

describe('POST /v1/templates', () => {
  it('🔴 le corps de Meta crée le modèle chez Meta, par la création de la console', async () => {
    const { poster, appelsMeta, server } = monter();
    const res = await poster(MODELE);
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ id: 'tid', name: 'commande_prete', language: 'fr', category: 'utility', status: 'pending' });
    expect(appelsMeta).toHaveLength(1);
    expect(appelsMeta[0]!.url).toMatch(/\/waba1\/message_templates$/);
    expect(appelsMeta[0]!.corps).toMatchObject({
      name: 'commande_prete', language: 'fr', category: 'UTILITY',
      components: [
        { type: 'BODY', text: 'Bonjour {{1}}, votre commande est prête.', example: { body_text: [['Marie']] } },
        { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Merci' }] },
      ],
    });
    await server.close();
  });

  it('🔴 la catégorie rendue est celle de Meta, qui peut reclasser', async () => {
    const { poster, server } = monter({ meta: [{ ok: true, status: 200, json: { id: 'tid', status: 'PENDING', category: 'MARKETING' } }] });
    expect((await poster(MODELE)).json()).toMatchObject({ category: 'marketing' });
    await server.close();
  });

  it('🔴 le droit templates:write est exigé : une clé qui envoie ne crée pas de modèle', async () => {
    const { poster, appelsMeta, server } = monter();
    const res = await poster(MODELE, ENVOYEUR);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'missing_scope' });
    expect(appelsMeta).toHaveLength(0);
    await server.close();
  });

  it('un corps mal formé : 400 invalid_body, le champ nommé, rien chez Meta', async () => {
    const { poster, appelsMeta, server } = monter();
    const res = await poster({ ...MODELE, category: 'AUTHENTICATION' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'invalid_body', error: expect.stringMatching(/category/) });
    expect(appelsMeta).toHaveLength(0);
    await server.close();
  });

  it('🔴 l’en-tête image par son adresse : téléchargé, déposé chez Meta, et son handle part dans le modèle', async () => {
    const { poster, appelsMeta, telechargements, depots, server } = monter();
    const res = await poster({
      ...MODELE,
      components: [{ type: 'HEADER', format: 'IMAGE', example: { header_url: ['https://exemple.fr/a.jpg'] } }, ...MODELE.components],
    });
    expect(res.statusCode).toBe(201);
    expect(telechargements).toEqual(['https://exemple.fr/a.jpg']);
    expect(depots).toEqual([{ taille: JPEG.length, mime: 'image/jpeg' }]);
    expect((appelsMeta[0]!.corps!.components as unknown[])[0]).toEqual({ type: 'HEADER', format: 'IMAGE', example: { header_handle: ['4::handle'] } });
    await server.close();
  });

  it('🔴 un téléchargement refusé : 422 invalid_header_media, rien déposé, rien créé', async () => {
    const { poster, appelsMeta, depots, server } = monter({ telechargement: { refus: 'ce nom pointe vers une adresse interne' } });
    const res = await poster({
      ...MODELE,
      components: [{ type: 'HEADER', format: 'IMAGE', example: { header_url: ['https://exemple.fr/a.jpg'] } }, ...MODELE.components],
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: 'invalid_header_media', error: expect.stringMatching(/adresse interne/) });
    expect(depots).toHaveLength(0);
    expect(appelsMeta).toHaveLength(0);
    await server.close();
  });

  it('🔴 un espace sans compte WhatsApp : 409, et le fichier n’est même pas téléchargé', async () => {
    const { poster, telechargements, server } = monter({ waba: null });
    const res = await poster({
      ...MODELE,
      components: [{ type: 'HEADER', format: 'IMAGE', example: { header_url: ['https://exemple.fr/a.jpg'] } }, ...MODELE.components],
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'no_whatsapp_number' });
    expect(telechargements).toHaveLength(0);
    await server.close();
  });

  it('🔴 Meta refuse : 422 meta_rejected avec son motif, pas une erreur du serveur', async () => {
    const { poster, server } = monter({
      meta: [{ ok: false, status: 400, json: { error: { message: 'Invalid parameter', error_user_msg: 'Ce nom existe déjà dans cette langue', code: 100 } } }],
    });
    const res = await poster(MODELE);
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: 'meta_rejected', error: expect.stringMatching(/existe déjà/) });
    await server.close();
  });

  it('chaque création est comptée à l’usage, sans prendre la place lourde des envois', async () => {
    const { poster, usage, server } = monter();
    await poster(MODELE);
    expect((await usage.compteurs()).find((c) => c.operation === 'templates.create')).toMatchObject({ appels: 1, unites: 1 });
    await server.close();
  });
});

describe('GET /v1/templates/{name}', () => {
  const STATUTS = {
    data: [
      { name: 'commande_prete', language: 'fr', status: 'REJECTED', category: 'UTILITY', rejected_reason: 'INVALID_FORMAT' },
      { name: 'commande_prete', language: 'en_US', status: 'APPROVED', category: 'UTILITY', rejected_reason: 'NONE' },
    ],
  };

  it('🔴 chaque langue avec son statut et le motif d’un refus', async () => {
    const { lire, server } = monter({ meta: [{ ok: true, status: 200, json: STATUTS }] });
    const res = await lire('/v1/templates/commande_prete');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      name: 'commande_prete',
      languages: [
        { language: 'fr', status: 'rejected', category: 'utility', rejectedReason: 'INVALID_FORMAT' },
        { language: 'en_US', status: 'approved', category: 'utility', rejectedReason: null },
      ],
    });
    await server.close();
  });

  it('?language filtre une langue ; un nom inconnu rend 404, une langue hors liste 400', async () => {
    const { lire, server } = monter({ meta: [{ ok: true, status: 200, json: STATUTS }] });
    expect((await lire('/v1/templates/commande_prete?language=fr')).json()).toMatchObject({ languages: [{ language: 'fr' }] });
    expect((await lire('/v1/templates/commande_prete?language=de')).json()).toMatchObject({ code: 'template_not_found' });
    expect((await lire('/v1/templates/autre')).statusCode).toBe(404);
    expect((await lire('/v1/templates/Pas%20un%20nom')).statusCode).toBe(404);
    expect((await lire('/v1/templates/commande_prete?language=klingon')).json()).toMatchObject({ code: 'invalid_body' });
    await server.close();
  });

  it('🔴 le même droit que la création ; le catalogue GET /v1/templates reste sous sends:create', async () => {
    const { lire, server } = monter({ meta: [{ ok: true, status: 200, json: STATUTS }] });
    expect((await lire('/v1/templates/commande_prete', ENVOYEUR)).statusCode).toBe(403);
    await server.close();
  });
});
