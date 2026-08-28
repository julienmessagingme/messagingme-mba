import { describe, it, expect, beforeAll } from 'vitest';
import { buildServer } from '../src/server';
import { FakeQueue } from '../src/queue/fake';
import { signSession } from '../src/auth/token';
import type { UserAuthStore, EmailIdentity } from '../src/auth/store';
import type { AgentKnowledgeRouteDeps } from '../src/http/agent-knowledge';
import type { FicheAEcrire, FicheConnaissance } from '../src/agent/knowledge';
import type { PageDistante } from '../src/lib/page-distante';
import { MAX_CORPS, MAX_FICHES_PAR_PAGE } from '../src/agent/scrape';

/**
 * Routes de la base de connaissance d'un agent IA.
 *
 * Ce qu'elles verrouillent :
 *  1. l'isolation tenant : la cible vient du JETON, jamais de l'URL ;
 *  2. l'import ne va PAS chercher une adresse interne, et n'appelle même pas le réseau dans ce cas ;
 *  3. tout échec d'import sort en 4xx : Cloudflare remplace le corps d'une 5xx par sa page d'erreur, et le
 *     client ne saurait jamais que son site a répondu 404 ;
 *  4. les écritures sont réservées aux administrateurs, comme les routes d'agents qu'elles prolongent.
 */
const SECRET = 'test-secret';
/** Forme d'uuid exigée : un identifiant mal formé ferait LEVER Postgres sur une colonne `uuid`. */
const AG = '11111111-1111-4111-8111-111111111111';
const FICHE_ID = '22222222-2222-4222-8222-222222222222';
let adminTok = '';
let agentTok = '';
beforeAll(async () => {
  adminTok = await signSession({ userId: 'u1', tenantId: 't1', role: 'admin' }, SECRET);
  agentTok = await signSession({ userId: 'u2', tenantId: 't1', role: 'agent' }, SECRET);
});
const noUsers: UserAuthStore = { findIdentity: async (): Promise<EmailIdentity | null> => null };
const h = (t: string) => ({ headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` } });

const FICHE: FicheConnaissance = {
  id: FICHE_ID, titre: 'La piscine', corps: 'Ouverte de 9 h à 20 h.',
  sourceUrl: null, derniereLectureAt: null, updatedAt: '2026-08-28T10:00:00.000Z',
};

const PAGE_HTML = '<html><head><title>Résidence</title></head><body><h1>La piscine</h1><p>La piscine chauffée est ouverte tous les jours de 9 h à 20 h.</p></body></html>';

function app(page?: PageDistante | Error) {
  const cap = {
    listes: [] as Array<{ tenant: string; agentId: string }>,
    crees: [] as Array<{ tenant: string; agentId: string; fiche: FicheAEcrire }>,
    modifs: [] as Array<{ tenant: string; agentId: string; ficheId: string; patch: unknown }>,
    supprimes: [] as Array<{ tenant: string; agentId: string; ficheId: string }>,
    remplacements: [] as Array<{ tenant: string; agentId: string; url: string; fiches: FicheAEcrire[] }>,
    lues: [] as string[],
  };
  const deps: AgentKnowledgeRouteDeps = {
    lister: async (tenant, agentId) => { cap.listes.push({ tenant, agentId }); return [FICHE]; },
    creer: async (tenant, agentId, fiche) => {
      cap.crees.push({ tenant, agentId, fiche });
      // L'agent « inconnu » joue le cas d'un identifiant valide mais d'un AUTRE tenant : le store rend null.
      return agentId === AG ? { ...FICHE, ...fiche } : null;
    },
    modifier: async (tenant, agentId, ficheId, patch) => {
      cap.modifs.push({ tenant, agentId, ficheId, patch });
      return ficheId === FICHE_ID ? { ...FICHE, ...patch } : null;
    },
    supprimer: async (tenant, agentId, ficheId) => { cap.supprimes.push({ tenant, agentId, ficheId }); return ficheId === FICHE_ID; },
    remplacerSource: async (tenant, agentId, url, fiches) => {
      cap.remplacements.push({ tenant, agentId, url, fiches });
      return agentId === AG ? { retirees: 2, ecrites: fiches.length } : null;
    },
    fetchUrl: async (u) => {
      cap.lues.push(u);
      if (page instanceof Error) throw page;
      return page ?? { status: 200, contentType: 'text/html; charset=utf-8', body: PAGE_HTML };
    },
  };
  return { cap, srv: buildServer({ queue: new FakeQueue(), auth: { users: noUsers, secret: SECRET }, agentKnowledge: deps }) };
}

const base = (tenant: string, agentId = AG) => `/tenants/${tenant}/agents/${agentId}/knowledge`;

describe('base de connaissance : lecture et écriture', () => {
  it('liste les fiches d’un agent, dans le tenant du jeton', async () => {
    const { cap, srv } = app();
    const res = await srv.inject({ method: 'GET', url: base('t1'), ...h(adminTok) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ fiches: [FICHE] });
    expect(cap.listes[0]).toEqual({ tenant: 't1', agentId: AG });
  });

  it('🔴 le tenant de l’URL ne peut pas dépasser celui du jeton', async () => {
    const { cap, srv } = app();
    for (const [method, url, payload] of [
      ['GET', base('t2'), undefined],
      ['POST', base('t2'), { titre: 'X', corps: 'Y' }],
      ['PATCH', `${base('t2')}/${FICHE_ID}`, { titre: 'X' }],
      ['DELETE', `${base('t2')}/${FICHE_ID}`, undefined],
      ['POST', `${base('t2')}/import`, { url: 'https://exemple.fr/p' }],
    ] as const) {
      const res = await srv.inject({ method, url, ...h(adminTok), ...(payload ? { payload } : {}) });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
    // Et surtout : rien n'a été tenté en aval. Un 403 rendu APRÈS l'appel au store ne protégerait rien.
    expect(cap.listes).toHaveLength(0);
    expect(cap.crees).toHaveLength(0);
    expect(cap.modifs).toHaveLength(0);
    expect(cap.supprimes).toHaveLength(0);
    expect(cap.lues).toHaveLength(0);
  });

  it('crée une fiche, et rend 404 quand l’agent n’est pas celui de ce tenant', async () => {
    const { srv } = app();
    const ok = await srv.inject({ method: 'POST', url: base('t1'), ...h(adminTok), payload: { titre: ' La piscine ', corps: 'Ouverte de 9 h à 20 h.' } });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().fiche.titre).toBe('La piscine'); // découpé aux extrémités

    const autre = await srv.inject({
      method: 'POST', url: base('t1', '99999999-9999-4999-8999-999999999999'), ...h(adminTok),
      payload: { titre: 'X', corps: 'Un corps de fiche.' },
    });
    expect(autre.statusCode).toBe(404);
  });

  it('refuse une fiche vide ou démesurée, en 400', async () => {
    const { srv } = app();
    for (const payload of [
      {},
      { titre: '', corps: 'x' },
      { titre: 'T', corps: '   ' },
      { titre: 'T', corps: 'x'.repeat(MAX_CORPS + 1) },
      { titre: 'T'.repeat(201), corps: 'x' },
    ]) {
      const res = await srv.inject({ method: 'POST', url: base('t1'), ...h(adminTok), payload });
      expect(res.statusCode, JSON.stringify(payload).slice(0, 40)).toBe(400);
    }
  });

  it('corrige une fiche, refuse un patch vide, et rend 404 sur une fiche d’ailleurs', async () => {
    const { cap, srv } = app();
    const ok = await srv.inject({ method: 'PATCH', url: `${base('t1')}/${FICHE_ID}`, ...h(adminTok), payload: { corps: 'Ouverte de 8 h à 21 h.' } });
    expect(ok.statusCode).toBe(200);
    // L'AGENT de l'adresse descend jusqu'au store : sans lui, la requete ne controlerait que le tenant, et
    // l'adresse promettrait un perimetre qu'elle ne tient pas.
    expect(cap.modifs[0]).toMatchObject({ tenant: 't1', agentId: AG, ficheId: FICHE_ID, patch: { corps: 'Ouverte de 8 h à 21 h.' } });

    expect((await srv.inject({ method: 'PATCH', url: `${base('t1')}/${FICHE_ID}`, ...h(adminTok), payload: {} })).statusCode).toBe(400);
    const ailleurs = await srv.inject({ method: 'PATCH', url: `${base('t1')}/33333333-3333-4333-8333-333333333333`, ...h(adminTok), payload: { titre: 'X' } });
    expect(ailleurs.statusCode).toBe(404);
  });

  it('supprime une fiche, et rend 404 si elle n’est pas de ce tenant', async () => {
    const { srv } = app();
    expect((await srv.inject({ method: 'DELETE', url: `${base('t1')}/${FICHE_ID}`, ...h(adminTok) })).statusCode).toBe(204);
    expect((await srv.inject({ method: 'DELETE', url: `${base('t1')}/33333333-3333-4333-8333-333333333333`, ...h(adminTok) })).statusCode).toBe(404);
  });

  it('🔴 un identifiant qui n’a pas la forme d’un uuid rend 404, pas une erreur de base', async () => {
    // Sans ce contrôle, la valeur part telle quelle dans un `where id = $1` sur une colonne `uuid`, Postgres
    // LÈVE (22P02) et la console rend un 500, dont Cloudflare remplace le corps par sa page d'erreur.
    const { cap, srv } = app();
    expect((await srv.inject({ method: 'GET', url: base('t1', 'pas-un-uuid'), ...h(adminTok) })).statusCode).toBe(404);
    expect((await srv.inject({ method: 'DELETE', url: `${base('t1')}/pas-un-uuid`, ...h(adminTok) })).statusCode).toBe(404);
    expect(cap.listes).toHaveLength(0);
    expect(cap.supprimes).toHaveLength(0);
  });

  it('les écritures sont réservées aux administrateurs', async () => {
    const { srv } = app();
    expect((await srv.inject({ method: 'GET', url: base('t1'), ...h(agentTok) })).statusCode).toBe(403);
    expect((await srv.inject({ method: 'POST', url: base('t1'), ...h(agentTok), payload: { titre: 'T', corps: 'Un corps.' } })).statusCode).toBe(403);
    expect((await srv.inject({ method: 'POST', url: `${base('t1')}/import`, ...h(agentTok), payload: { url: 'https://exemple.fr/p' } })).statusCode).toBe(403);
  });
});

describe('base de connaissance : import d’une page', () => {
  it('lit la page, la découpe, et REMPLACE les fiches de la même adresse', async () => {
    const { cap, srv } = app();
    const res = await srv.inject({ method: 'POST', url: `${base('t1')}/import`, ...h(adminTok), payload: { url: 'https://exemple.fr/residence' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ url: 'https://exemple.fr/residence', retirees: 2, ecrites: 1, plafond: MAX_FICHES_PAR_PAGE });
    expect(cap.remplacements[0]!.fiches[0]).toMatchObject({ titre: 'La piscine' });
  });

  it('🔴 une adresse interne est refusée en 400, et AUCUNE lecture réseau n’est tentée', async () => {
    // Le serveur vit dans le réseau Docker du VPS : il voit l'admin NPM et les autres conteneurs. Un refus
    // rendu après la lecture aurait déjà fait la requête, donc déjà fui la réponse par le message d'erreur.
    const { cap, srv } = app();
    for (const url of ['http://127.0.0.1:81/api/tokens', 'http://169.254.169.254/latest/meta-data', 'http://10.0.0.5/', 'file:///etc/passwd']) {
      const res = await srv.inject({ method: 'POST', url: `${base('t1')}/import`, ...h(adminTok), payload: { url } });
      expect(res.statusCode, url).toBe(400);
    }
    expect(cap.lues).toHaveLength(0);
    expect(cap.remplacements).toHaveLength(0);
  });

  it('🔴 une page injoignable, en erreur ou illisible rend 422, jamais 500', async () => {
    const injoignable = app(new Error('getaddrinfo ENOTFOUND'));
    const a = await injoignable.srv.inject({ method: 'POST', url: `${base('t1')}/import`, ...h(adminTok), payload: { url: 'https://exemple.fr/p' } });
    expect(a.statusCode).toBe(422);
    expect(a.json().error).toContain('injoignable');

    const erreur = app({ status: 404, contentType: 'text/html', body: 'nope' });
    const b = await erreur.srv.inject({ method: 'POST', url: `${base('t1')}/import`, ...h(adminTok), payload: { url: 'https://exemple.fr/p' } });
    expect(b.statusCode).toBe(422);
    expect(b.json().error).toContain('404');

    const pdf = app({ status: 200, contentType: 'application/pdf', body: '%PDF-1.4 binaire' });
    const c = await pdf.srv.inject({ method: 'POST', url: `${base('t1')}/import`, ...h(adminTok), payload: { url: 'https://exemple.fr/p.pdf' } });
    expect(c.statusCode).toBe(422);

    const vide = app({ status: 200, contentType: 'text/html', body: '<html><body><nav>Accueil</nav></body></html>' });
    const d = await vide.srv.inject({ method: 'POST', url: `${base('t1')}/import`, ...h(adminTok), payload: { url: 'https://exemple.fr/p' } });
    expect(d.statusCode).toBe(422);
    expect(d.json().error).toContain('exploitable');
    // Aucune de ces issues n'a touché la base : une page illisible ne doit pas VIDER la source précédente.
    for (const cas of [injoignable, erreur, pdf, vide]) expect(cas.cap.remplacements).toHaveLength(0);
  });

  it('canonise l’adresse, pour qu’une relecture remplace bien la même source', async () => {
    // Sans forme canonique, « https://exemple.fr » et « https://exemple.fr/ » feraient deux sources, donc
    // deux jeux de fiches jumelles qu'aucune relecture ne remplacerait jamais ensemble.
    const { cap, srv } = app();
    await srv.inject({ method: 'POST', url: `${base('t1')}/import`, ...h(adminTok), payload: { url: '  https://exemple.fr  ' } });
    expect(cap.remplacements[0]!.url).toBe('https://exemple.fr/');
    expect(cap.lues[0]).toBe('https://exemple.fr/');
  });

  it('rend 503 quand la lecture de page n’est pas branchée', async () => {
    const srv = buildServer({
      queue: new FakeQueue(), auth: { users: noUsers, secret: SECRET },
      agentKnowledge: {
        lister: async () => [], creer: async () => null, modifier: async () => null,
        supprimer: async () => false, remplacerSource: async () => null,
      },
    });
    const res = await srv.inject({ method: 'POST', url: `${base('t1')}/import`, ...h(adminTok), payload: { url: 'https://exemple.fr/p' } });
    expect(res.statusCode).toBe(503);
  });
});
