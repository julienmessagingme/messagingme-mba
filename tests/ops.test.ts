import { describe, it, expect } from 'vitest';
import { buildServer } from '../src/server';
import { FakeQueue } from '../src/queue/fake';
import { signSession } from '../src/auth/token';
import type { OpsRouteDeps } from '../src/http/ops';

const OPS = 'ops-secret-token-of-at-least-32-bytes!!';

const OVERVIEW: Awaited<ReturnType<OpsRouteDeps['getTenantOverview']>> = [
  { id: 't1', name: 'Acme', createdAt: '2026-07-01T00:00:00.000Z', mbaEnabled: true, users: 2, contacts: 10, messages: 50, templatesUsed: 3, lastSendAt: null, phone: '+33 5 25 68 02 50', phoneStatus: 'CONNECTED', quality: 'GREEN' },
];

function app(opsToken = OPS, over: Partial<OpsRouteDeps> = {}) {
  const deps: OpsRouteDeps = {
    getTenantOverview: async () => OVERVIEW,
    getGlobalDaily: async () => [{ date: '2026-07-11', count: 5 }],
    getQueueLoad: async () => [{ queue: 'webhook', backlog: 0, active: 0, failed: 0, ageMaxSecondes: 0 }],
    ...over,
  };
  return buildServer({ queue: new FakeQueue(), ops: deps, opsToken });
}
const withTok = (t: string) => ({ headers: { 'x-ops-token': t } });

describe('route /ops/overview', () => {
  it('token correct -> 200 { tenants, daily, queues, worker }', async () => {
    const server = app();
    const res = await server.inject({ method: 'GET', url: '/ops/overview', ...withTok(OPS) });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ tenants: unknown[]; daily: unknown[]; queues: unknown[]; worker: unknown }>();
    expect(body.tenants).toHaveLength(1);
    expect(body.daily).toHaveLength(1);
    expect(body.queues).toHaveLength(1);
    // getWorkerHeartbeat est OPTIONNEL : non fourni par app() -> worker = null, la route ne casse pas.
    expect(body).toHaveProperty('worker');
    expect(body.worker).toBeNull();
    await server.close();
  });

  it('inclut le heartbeat worker quand le getter est fourni', async () => {
    const hb = { beatAt: '2026-07-24T10:00:00.000Z', bootedAt: '2026-07-24T09:00:00.000Z', instance: 'host:1', ageSeconds: 12 };
    const server = app(OPS, { getWorkerHeartbeat: async () => hb });
    const res = await server.inject({ method: 'GET', url: '/ops/overview', ...withTok(OPS) });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ worker: unknown }>().worker).toEqual(hb);
    await server.close();
  });

  it('sans header -> 401', async () => {
    const server = app();
    const res = await server.inject({ method: 'GET', url: '/ops/overview' });
    expect(res.statusCode).toBe(401);
    await server.close();
  });

  it('mauvais token -> 401', async () => {
    const server = app();
    const res = await server.inject({ method: 'GET', url: '/ops/overview', ...withTok('mauvais') });
    expect(res.statusCode).toBe(401);
    await server.close();
  });

  it('OPS_TOKEN vide -> 401 même avec un header (surface désactivée)', async () => {
    const server = app('');
    const res = await server.inject({ method: 'GET', url: '/ops/overview', ...withTok('') });
    expect(res.statusCode).toBe(401);
    await server.close();
  });

  it('un JWT admin ne donne PAS accès (autorité séparée du tenant)', async () => {
    const server = app();
    const jwt = await signSession({ userId: 'u1', tenantId: 't1', role: 'admin' }, 'secret');
    const res = await server.inject({ method: 'GET', url: '/ops/overview', headers: { authorization: `Bearer ${jwt}` } });
    expect(res.statusCode).toBe(401); // pas de x-ops-token
    await server.close();
  });

  it('lecture seule : aucune route de mutation (POST -> 404)', async () => {
    const server = app();
    const res = await server.inject({ method: 'POST', url: '/ops/overview', ...withTok(OPS) });
    expect(res.statusCode).toBe(404);
    await server.close();
  });
});

/**
 * Le solde prépayé d'un workspace, sur la surface d'exploitation.
 *
 * 🔴 LA RECHARGE EST LA PREMIÈRE ÉCRITURE MÉTIER DE `/ops`, et elle est ici pour une raison qui ne se
 * négocie pas : créditer le compte prépayé d'un client ne doit JAMAIS être accessible depuis un compte de la
 * console, sans quoi un client se rechargerait lui-même. L'autorité de `/ops` est séparée du JWT client,
 * c'est exactement celle qu'il faut.
 */
describe('solde prépayé sur /ops', () => {
  // Des identifiants qui ont la FORME d'un uuid : ils partent tels quels dans un `where id = $1` sur une
  // colonne `uuid`, et une valeur mal formée y fait LEVER Postgres au lieu de rendre zéro ligne.
  const T1 = '11111111-1111-4111-8111-111111111111';
  const INCONNU = '22222222-2222-4222-8222-222222222222';
  const deps = {
    soldeAgent: async (tenantId: string) => (tenantId === T1 ? { soldeMicroEur: 9_995_800, mouvements: [] } : null),
    rechargerAgent: async (tenantId: string, montant: number) => (tenantId === T1 ? 10_000_000 + montant : null),
  };
  const recharge = (montantMicroEur: unknown, note: unknown = 'virement du 27/08') => ({ montantMicroEur, note });

  it('lit le solde et son journal', async () => {
    const server = app(OPS, deps);
    const res = await server.inject({ method: 'GET', url: `/ops/credits/${T1}`, ...withTok(OPS) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ soldeMicroEur: 9_995_800 });
    await server.close();
  });

  it('recharge, et rend le nouveau solde', async () => {
    const server = app(OPS, deps);
    const res = await server.inject({
      method: 'POST', url: `/ops/credits/${T1}`, ...withTok(OPS),
      payload: { montantMicroEur: 5_000_000, note: 'mise en service' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ tenantId: T1, soldeMicroEur: 15_000_000 });
    await server.close();
  });

  it('🔴 SANS le jeton d exploitation, rien : ni lecture, ni recharge', async () => {
    // C'est toute la protection. Un client qui atteindrait cette route se créditerait lui-même.
    const server = app(OPS, deps);
    expect((await server.inject({ method: 'GET', url: `/ops/credits/${T1}` })).statusCode).toBe(401);
    expect((await server.inject({ method: 'GET', url: `/ops/credits/${T1}`, ...withTok('mauvais') })).statusCode).toBe(401);
    expect((await server.inject({ method: 'POST', url: `/ops/credits/${T1}`, ...withTok('mauvais'), payload: recharge(1) })).statusCode).toBe(401);
    await server.close();
  });

  it('🔴 un montant absurde est REFUSÉ, et rien n est écrit', async () => {
    // Il n'existe aucune route de débit : une virgule mal placée ne se rattrape pas, elle doit donc être
    // arrêtée à l'entrée.
    const recharges: number[] = [];
    const server = app(OPS, { ...deps, rechargerAgent: async (_t, m) => { recharges.push(m); return m; } });
    for (const montantMicroEur of [0, -5_000, 2_000_000_000, 'beaucoup', null, Number.NaN]) {
      const res = await server.inject({ method: 'POST', url: `/ops/credits/${T1}`, ...withTok(OPS), payload: recharge(montantMicroEur) });
      expect(res.statusCode, String(montantMicroEur)).toBe(400);
    }
    expect((await server.inject({ method: 'POST', url: `/ops/credits/${T1}`, ...withTok(OPS), payload: {} })).statusCode).toBe(400);
    expect(recharges).toEqual([]);
    await server.close();
  });

  it('🔴 une recharge SANS NOTE est refusée, et rien n est écrit', async () => {
    // Le jeton d'exploitation est partagé : il n'y a aucune identité d'opérateur à enregistrer, donc cette
    // phrase est la SEULE trace de qui a rechargé et pourquoi. Un mouvement d'argent sans explication ne se
    // justifie pas six mois plus tard.
    const recharges: number[] = [];
    const server = app(OPS, { ...deps, rechargerAgent: async (_t, m) => { recharges.push(m); return m; } });
    for (const note of ['', '   ', 'ok', 42, null]) {
      const res = await server.inject({ method: 'POST', url: `/ops/credits/${T1}`, ...withTok(OPS), payload: { montantMicroEur: 5_000_000, note } });
      expect(res.statusCode, String(note)).toBe(400);
    }
    // Et une note absente, pas seulement vide.
    expect((await server.inject({ method: 'POST', url: `/ops/credits/${T1}`, ...withTok(OPS), payload: { montantMicroEur: 5_000_000 } })).statusCode).toBe(400);
    expect(recharges).toEqual([]);
    await server.close();
  });

  it('🔴 un espace INCONNU rend 404, jamais un solde de zéro ni une 500', async () => {
    // Deux pièges d'un coup. En lecture, un « 0 » sur un identifiant mal tapé se lit « client à sec » et
    // appelle une recharge sur un espace qui n'existe pas. En écriture, la clé étrangère lèverait, donc un
    // 500 dont Cloudflare remplace le corps par sa page d'erreur, sur la seule route qui écrit de l'argent.
    const server = app(OPS, deps);
    expect((await server.inject({ method: 'GET', url: `/ops/credits/${INCONNU}`, ...withTok(OPS) })).statusCode).toBe(404);
    const res = await server.inject({ method: 'POST', url: `/ops/credits/${INCONNU}`, ...withTok(OPS), payload: recharge(5_000_000) });
    expect(res.statusCode).toBe(404);
    await server.close();
  });

  it('🔴 un identifiant qui n est pas un uuid rend 404, sans toucher la base', async () => {
    // Il partirait tel quel dans un `where id = $1` sur une colonne `uuid` : Postgres LÈVE (`22P02`), donc
    // 500. Une adresse tapée de travers doit rendre 404, pas une page d'incident.
    const vus: string[] = [];
    const server = app(OPS, {
      soldeAgent: async (t) => { vus.push(t); return { soldeMicroEur: 0, mouvements: [] }; },
      rechargerAgent: async (t) => { vus.push(t); return 1; },
    });
    expect((await server.inject({ method: 'GET', url: '/ops/credits/t1', ...withTok(OPS) })).statusCode).toBe(404);
    expect((await server.inject({ method: 'POST', url: '/ops/credits/t1', ...withTok(OPS), payload: recharge(1000) })).statusCode).toBe(404);
    expect(vus).toEqual([]);
    await server.close();
  });

  it('une instance sans solde câblé rend 503, pas une erreur', async () => {
    const server = app(OPS, {});
    expect((await server.inject({ method: 'GET', url: `/ops/credits/${T1}`, ...withTok(OPS) })).statusCode).toBe(503);
    expect((await server.inject({ method: 'POST', url: `/ops/credits/${T1}`, ...withTok(OPS), payload: recharge(1000) })).statusCode).toBe(503);
    await server.close();
  });
});


describe('charge des files : l’âge du plus vieux job', () => {
  it('🔴 l’âge remonte jusqu’à la réponse, il n’est pas calculé pour rien', async () => {
    // 🔴 C'est la mesure qui rend observables les objectifs de service (`docs/SLO-2026-09-01.md`) : la
    // profondeur seule ne dit pas si on tient la cadence. Mille jobs avalés en trois secondes vont bien, dix
    // qui attendent depuis un quart d'heure vont mal. Un champ calculé en base mais perdu en route
    // n'afficherait que des zéros, et l'écran passerait pour rassurant.
    const a = app(OPS, {
      getQueueLoad: async () => [
        { queue: 'webhook', backlog: 3, active: 1, failed: 0, ageMaxSecondes: 42 },
        { queue: 'campaign-run', backlog: 0, active: 0, failed: 0, ageMaxSecondes: 0 },
      ],
    });
    const res = await a.inject({ method: 'GET', url: '/ops/overview', headers: { 'x-ops-token': OPS } });
    expect(res.statusCode).toBe(200);
    const files = res.json<{ queues: Array<{ queue: string; ageMaxSecondes: number }> }>().queues;
    expect(files.find((q) => q.queue === 'webhook')?.ageMaxSecondes).toBe(42);
    expect(files.find((q) => q.queue === 'campaign-run')?.ageMaxSecondes).toBe(0);
    await a.close();
  });
});


describe('équité : les groupes qui attendent le plus', () => {
  it('🔴 remontent dans la réponse, et une lecture en ÉCHEC ne prive pas de tout le reste', async () => {
    // 🔴 C'est le SLO 3 (`docs/SLO-2026-09-01.md`), et le trou que ce document signalait comme son propre
    // angle mort : la profondeur et l'âge par file disent « la file avance », pas « tout le monde est
    // servi ». Un espace affamé derrière un espace bavard est invisible d'une moyenne.
    const a = app(OPS, {
      getQueueLoadParGroupe: async () => [{ queue: 'campaign-run', groupe: 't-affame', backlog: 3, ageMaxSecondes: 420 }],
    });
    const res = await a.inject({ method: 'GET', url: '/ops/overview', headers: { 'x-ops-token': OPS } });
    expect(res.json<{ queuesParGroupe: unknown[] }>().queuesParGroupe)
      .toEqual([{ queue: 'campaign-run', groupe: 't-affame', backlog: 3, ageMaxSecondes: 420 }]);
    await a.close();

    // Une lecture de confort qui échoue ne doit pas emporter l'écran d'exploitation entier : c'est
    // précisément quand ça va mal qu'on en a besoin.
    const b = app(OPS, { getQueueLoadParGroupe: async () => { throw new Error('pgboss injoignable'); } });
    const res2 = await b.inject({ method: 'GET', url: '/ops/overview', headers: { 'x-ops-token': OPS } });
    expect(res2.statusCode).toBe(200);
    expect(res2.json<{ queuesParGroupe: unknown[] }>().queuesParGroupe).toEqual([]);
    expect(res2.json<{ queues: unknown[] }>().queues.length).toBeGreaterThan(0);
    await b.close();
  });

  it('une instance sans cette lecture rend une liste vide, pas une erreur', async () => {
    const a = app(OPS, {});
    const res = await a.inject({ method: 'GET', url: '/ops/overview', headers: { 'x-ops-token': OPS } });
    expect(res.json<{ queuesParGroupe: unknown[] }>().queuesParGroupe).toEqual([]);
    await a.close();
  });
});


describe('jobs morts : les voir, puis les rejouer', () => {
  const mort = (id: string, queue: string) => ({ id, queue, data: { x: id }, creeLe: '2026-09-01T00:00:00.000Z', erreur: 'boom' });

  it('la route de lecture est ABSENTE sans la dépendance : rien ne s’expose par défaut', async () => {
    const a = app(OPS, {});
    expect((await a.inject({ method: 'GET', url: '/ops/dlq', headers: { 'x-ops-token': OPS } })).statusCode).toBe(404);
    await a.close();
  });

  it('lit les jobs morts', async () => {
    const a = app(OPS, { listerJobsMorts: async () => [mort('j1', 'webhook')] });
    const res = await a.inject({ method: 'GET', url: '/ops/dlq', headers: { 'x-ops-token': OPS } });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ jobs: Array<{ id: string }> }>().jobs).toHaveLength(1);
    await a.close();
  });

  it('🔴 le rejeu ENFILE PUIS OUBLIE, jamais l’inverse', async () => {
    // 🔴 L'ordre décide du mode de panne. Un crash entre les deux produit un DOUBLON ; l'ordre inverse
    // produirait une PERTE. Le doublon est rattrapé partout où ça compte, la perte nulle part.
    const journal: string[] = [];
    const a = app(OPS, {
      listerJobsMorts: async () => [mort('j1', 'webhook'), mort('j2', 'webhook')],
      reenfiler: async (q) => { journal.push(`enfile:${q}`); },
      oublierJobsMorts: async (ids) => { journal.push(`oublie:${ids.join(',')}`); return ids.length; },
    });
    const res = await a.inject({ method: 'POST', url: '/ops/dlq/replay', headers: { 'x-ops-token': OPS }, payload: { queue: 'webhook', limit: 10 } });
    expect(res.json<{ rejoues: number; oublies: number }>()).toEqual({ rejoues: 2, oublies: 2 });
    expect(journal).toEqual(['enfile:webhook', 'enfile:webhook', 'oublie:j1,j2']);
    await a.close();
  });

  it('🔴 un enfilement qui ÉCHOUE n’oublie que ce qui est réellement parti', async () => {
    // Sinon on supprimerait de la file d'échec des traitements qui n'ont jamais été ré-enfilés : une perte
    // silencieuse, et sur un `webhook` c'est un message de client perdu pour de bon.
    const oublies: string[][] = [];
    let enfiles = 0;
    const a = app(OPS, {
      listerJobsMorts: async () => [mort('j1', 'webhook'), mort('j2', 'webhook'), mort('j3', 'webhook')],
      // Le PREMIER passe, le SECOND échoue : on vérifie qu'on n'oublie que le premier.
      reenfiler: async () => { enfiles += 1; if (enfiles === 2) throw new Error('file pleine'); },
      oublierJobsMorts: async (ids) => { oublies.push(ids); return ids.length; },
    });
    const res = await a.inject({ method: 'POST', url: '/ops/dlq/replay', headers: { 'x-ops-token': OPS }, payload: { queue: 'webhook' } });
    expect(res.json<{ rejoues: number }>().rejoues).toBe(1);
    expect(oublies).toEqual([['j1']]);
    await a.close();
  });

  it('🔴 la FILE est obligatoire : pas de rejeu « tout » d’un coup', async () => {
    // Un rejeu global relancerait campagnes et webhooks ensemble, sur des causes d'échec différentes qu'on
    // n'a pas toutes corrigées.
    const a = app(OPS, { listerJobsMorts: async () => [], reenfiler: async () => {}, oublierJobsMorts: async () => 0 });
    expect((await a.inject({ method: 'POST', url: '/ops/dlq/replay', headers: { 'x-ops-token': OPS }, payload: {} })).statusCode).toBe(400);
    expect((await a.inject({ method: 'POST', url: '/ops/dlq/replay', headers: { 'x-ops-token': OPS }, payload: { queue: 'webhook', limit: 5000 } })).statusCode).toBe(400);
    await a.close();
  });

  it('sans jeton d’exploitation, ni lecture ni rejeu', async () => {
    // C'est une ÉCRITURE métier : elle ne doit jamais être atteignable depuis un compte de la console.
    const a = app(OPS, { listerJobsMorts: async () => [], reenfiler: async () => {}, oublierJobsMorts: async () => 0 });
    expect((await a.inject({ method: 'GET', url: '/ops/dlq' })).statusCode).toBe(401);
    expect((await a.inject({ method: 'POST', url: '/ops/dlq/replay', payload: { queue: 'webhook' } })).statusCode).toBe(401);
    await a.close();
  });
});

/**
 * RÉVOQUER la clé de modèle d'un espace (2026-09-09, question de Julien).
 *
 * 🔴 CE QUE CE GESTE EMPÊCHE. `agent_gateway_keys.tenant_id` porte un `on delete cascade` : sans révocation
 * préalable, supprimer un espace emporte notre ligne et laisse la clé chez Vercel avec son identifiant
 * PERDU, donc facturable et irrévocable. Le geste vit sur `/ops` parce que ce n'est pas au client de
 * nettoyer nos clés.
 */
describe('/ops : révoquer la clé de modèle', () => {
  const T = '11111111-1111-4111-8111-111111111111';

  it('révoque, et le dit', async () => {
    const srv = app(OPS, { revoquerCleModele: async () => true });
    const r = await srv.inject({ method: 'DELETE', url: `/ops/cle-modele/${T}`, ...withTok(OPS) });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ revoquee: true });
  });

  it('un espace SANS clé n’est pas une erreur', async () => {
    // C'est le cas le plus fréquent : la plupart des espaces n'ont pas d'agent, donc pas de clé. Le traiter
    // en erreur ferait chercher une panne là où il n'y a rien à faire.
    const srv = app(OPS, { revoquerCleModele: async () => false });
    const r = await srv.inject({ method: 'DELETE', url: `/ops/cle-modele/${T}`, ...withTok(OPS) });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ revoquee: false });
  });

  it('🔴 Vercel refuse -> 422 qui DIT que la clé est toujours active', async () => {
    // Et pas un 5xx : Cloudflare remplacerait le corps, et l'opérateur croirait à une panne quelconque au
    // lieu de savoir que la clé vit encore et qu'il faut réessayer.
    const srv = app(OPS, { revoquerCleModele: async () => { throw new Error('vercel refuse'); } });
    const r = await srv.inject({ method: 'DELETE', url: `/ops/cle-modele/${T}`, ...withTok(OPS) });
    expect(r.statusCode).toBe(422);
    expect(r.json().error).toMatch(/toujours active/);
  });

  it('sans la dépendance, la route se déclare indisponible', async () => {
    const srv = app(OPS);
    expect((await srv.inject({ method: 'DELETE', url: `/ops/cle-modele/${T}`, ...withTok(OPS) })).statusCode).toBe(503);
  });

  it('🔴 et elle reste derrière le jeton, comme tout /ops', async () => {
    const srv = app(OPS, { revoquerCleModele: async () => true });
    expect((await srv.inject({ method: 'DELETE', url: `/ops/cle-modele/${T}` })).statusCode).toBe(401);
  });
});
