import { describe, it, expect, beforeAll } from 'vitest';
import { buildServer } from '../src/server';
import { FakeQueue } from './fake-queue';
import { signSession } from '../src/auth/token';
import type { ExploitationOps, OpsRouteDeps } from '../src/http/ops';
import { capturerJournal } from './journal';
import { exploitationInerte, opsInerte } from './routes-inertes';
import { accesOps, SECRET_OPS } from './acces-ops';

/** L'exploitant de ce fichier, et sa session d'exploitation, gagnée une fois par le vrai parcours. */
const acces = accesOps();
let OPS = '';
beforeAll(async () => {
  const s = buildServer({ queue: new FakeQueue(), auth: acces.auth });
  OPS = await acces.jeton(s);
  await s.close();
});

const OVERVIEW: Awaited<ReturnType<ExploitationOps['getTenantOverview']>> = [
  { id: 't1', name: 'Acme', createdAt: '2026-07-01T00:00:00.000Z', mbaEnabled: true, users: 2, contacts: 10, messages: 50, templatesUsed: 3, lastSendAt: null, phone: '+33 5 25 68 02 50', phoneStatus: 'CONNECTED', quality: 'GREEN' },
];

/** La tranche d'exploitation se surcharge membre par membre. */
type Surcharges = Partial<Omit<OpsRouteDeps, 'exploitation'>> & { exploitation?: Partial<ExploitationOps> };

function app(over: Surcharges = {}) {
  const { exploitation: surExploitation, ...reste } = over;
  const deps: OpsRouteDeps = {
    ...opsInerte,
    exploitation: {
      ...exploitationInerte,
      getTenantOverview: async () => OVERVIEW,
      getGlobalDaily: async () => [{ date: '2026-07-11', count: 5 }],
      getQueueLoad: async () => [{ queue: 'webhook', backlog: 0, active: 0, failed: 0, ageMaxSecondes: 0 }],
      ...surExploitation,
    },
    ...reste,
  };
  return buildServer({ queue: new FakeQueue(), ops: deps, auth: acces.auth });
}
const withTok = (t: string) => ({ headers: { authorization: `Bearer ${t}` } });

describe('route /ops/overview', () => {
  it('la révision de l’API, posée à la construction de l’image ; « inconnue » sans elle', async () => {
    const avant = process.env.REVISION;
    const server = app();
    try {
      process.env.REVISION = 'abc1234';
      expect((await server.inject({ method: 'GET', url: '/ops/overview', ...withTok(OPS) })).json<{ revision: string }>().revision).toBe('abc1234');
      delete process.env.REVISION;
      expect((await server.inject({ method: 'GET', url: '/ops/overview', ...withTok(OPS) })).json<{ revision: string }>().revision).toBe('inconnue');
    } finally {
      if (avant === undefined) delete process.env.REVISION; else process.env.REVISION = avant;
      await server.close();
    }
  });

  it('🔴 chaque ligne de latence porte le seuil de SA file : 30 s pour un entrant, trois cadences pour le fond', async () => {
    const ligne = (queue: string) => ({ queue, echantillons: 3, attenteP50Secondes: 1, attenteP95Secondes: 40, boutEnBoutP95Secondes: 41, boutEnBoutMaxSecondes: 50 });
    const server = app({ exploitation: { getQueueLatence: async () => [ligne('webhook'), ligne('webhook-status')] } });
    const res = await server.inject({ method: 'GET', url: '/ops/overview', ...withTok(OPS) });
    const latences = res.json<{ latences: Array<{ queue: string; seuilSecondes: number }> }>().latences;
    expect(latences.map((l) => [l.queue, l.seuilSecondes])).toEqual([['webhook', 30], ['webhook-status', 90]]);
    await server.close();
  });

  it('session d’exploitation -> 200 { tenants, daily, queues, workers }', async () => {
    const server = app();
    const res = await server.inject({ method: 'GET', url: '/ops/overview', ...withTok(OPS) });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ tenants: unknown[]; daily: unknown[]; queues: unknown[]; workers: unknown[] }>();
    expect(body.tenants).toHaveLength(1);
    expect(body.daily).toHaveLength(1);
    expect(body.queues).toHaveLength(1);
    // Aucun worker n’a battu : la liste est VIDE, et la route ne casse pas.
    expect(body).toHaveProperty('workers');
    expect(body.workers).toEqual([]);
    await server.close();
  });

  it('porte la latence HTTP lue sur 24 h, et une lecture en échec ne fait pas tomber l’écran', async () => {
    const ligne = { methode: 'POST', route: '/webhooks/meta', code: 200, groupe: 'webhooks' as const, requetes: 4, p50Ms: 10, p95Ms: 25, maxMs: 22, moyenneMs: 10 };
    const heuresLues: number[] = [];
    const lue = app({ latencesHttp: { lire: async (h) => { heuresLues.push(h); return [ligne]; } } });
    const res = await lue.inject({ method: 'GET', url: '/ops/overview', ...withTok(OPS) });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ latencesHttp: unknown[] }>().latencesHttp).toEqual([ligne]);
    expect(heuresLues).toEqual([24]);
    await lue.close();

    const enPanne = app({ latencesHttp: { lire: async () => { throw new Error('relation "http_latences" does not exist'); } } });
    const res2 = await enPanne.inject({ method: 'GET', url: '/ops/overview', ...withTok(OPS) });
    expect(res2.statusCode).toBe(200);
    expect(res2.json<{ latencesHttp: unknown[]; tenants: unknown[] }>()).toMatchObject({ latencesHttp: [], tenants: [{ id: 't1' }] });
    await enPanne.close();
  });

  it('porte les tâches de fond lues sur 24 h, et une lecture en échec ne fait pas tomber l’écran', async () => {
    const ligne = { process: 'worker-principal', tache: 'agregats-analyse', passes: 4, echecs: 0, sautees: 0, sommeMs: 900, maxMs: 400, lignes: 12, maxLignes: 6, derniere: '2026-10-04T12:00:00.000Z' };
    const heuresLues: number[] = [];
    const lue = app({ mesuresTaches: { lire: async (h) => { heuresLues.push(h); return [ligne]; } } });
    const res = await lue.inject({ method: 'GET', url: '/ops/overview', ...withTok(OPS) });
    expect(res.json<{ tachesFond: unknown[] }>().tachesFond).toEqual([ligne]);
    expect(heuresLues).toEqual([24]);
    await lue.close();
    const enPanne = app({ mesuresTaches: { lire: async () => { throw new Error('relation "taches_mesures" does not exist'); } } });
    const res2 = await enPanne.inject({ method: 'GET', url: '/ops/overview', ...withTok(OPS) });
    expect(res2.statusCode).toBe(200);
    expect(res2.json<{ tachesFond: unknown[]; tenants: unknown[] }>()).toMatchObject({ tachesFond: [], tenants: [{ id: 't1' }] });
    await enPanne.close();
  });

  it('🔴 le stockage a SA route, et la vue d’ensemble ne le mesure jamais (il parcourt le catalogue)', async () => {
    const mesure = { baseOctets: 47_000_000, familles: [{ famille: 'rcs' as const, elements: 28, octets: 10_000_000, disqueOctets: 10_700_000 }], tables: [{ table: 'public.rcs_media', octets: 10_700_000 }], mesureLe: '2026-10-04T15:00:00.000Z' };
    let mesures = 0;
    const a = app({ stockage: { mesurer: async () => { mesures += 1; return mesure; } } });
    await a.inject({ method: 'GET', url: '/ops/overview', ...withTok(OPS) });
    expect(mesures).toBe(0);
    const res = await a.inject({ method: 'GET', url: '/ops/stockage', ...withTok(OPS) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(mesure);
    expect(mesures).toBe(1);
    // Sans session d'exploitation, rien.
    expect((await a.inject({ method: 'GET', url: '/ops/stockage' })).statusCode).toBe(401);
    await a.close();
  });

  it('inclut UN battement PAR RÔLE quand le magasin en rend', async () => {
    const hb = [
      { role: 'analyse', beatAt: '2026-07-24T10:00:00.000Z', bootedAt: '2026-07-24T09:00:00.000Z', instance: 'host:2', ageSeconds: 700 },
      { role: 'principal', beatAt: '2026-07-24T10:00:00.000Z', bootedAt: '2026-07-24T09:00:00.000Z', instance: 'host:1', ageSeconds: 12 },
    ];
    const server = app({ heartbeat: { lister: async () => hb } });
    const res = await server.inject({ method: 'GET', url: '/ops/overview', ...withTok(OPS) });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ workers: unknown[] }>().workers).toEqual(hb);
    await server.close();
  });

  it('sans header -> 401', async () => {
    const server = app();
    const res = await server.inject({ method: 'GET', url: '/ops/overview' });
    expect(res.statusCode).toBe(401);
    await server.close();
  });

  it('mauvais jeton -> 401', async () => {
    const server = app();
    const res = await server.inject({ method: 'GET', url: '/ops/overview', ...withTok('mauvais') });
    expect(res.statusCode).toBe(401);
    await server.close();
  });

  it('un JWT admin ne donne PAS accès (autorité séparée du tenant)', async () => {
    const server = app();
    // Signé avec le MÊME secret : c'est la portée qui refuse, pas la signature.
    const jwt = await signSession({ userId: 'u1', tenantId: 't1', role: 'admin' }, SECRET_OPS);
    const res = await server.inject({ method: 'GET', url: '/ops/overview', headers: { authorization: `Bearer ${jwt}` } });
    expect(res.statusCode).toBe(401);
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
    const server = app(deps);
    const res = await server.inject({ method: 'GET', url: `/ops/credits/${T1}`, ...withTok(OPS) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ soldeMicroEur: 9_995_800 });
    await server.close();
  });

  it('recharge, et rend le nouveau solde', async () => {
    const server = app(deps);
    const res = await server.inject({
      method: 'POST', url: `/ops/credits/${T1}`, ...withTok(OPS),
      payload: { montantMicroEur: 5_000_000, note: 'mise en service' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ tenantId: T1, soldeMicroEur: 15_000_000 });
    await server.close();
  });

  it('🔴 SANS la session d exploitation, rien : ni lecture, ni recharge', async () => {
    // C'est toute la protection. Un client qui atteindrait cette route se créditerait lui-même.
    const server = app(deps);
    expect((await server.inject({ method: 'GET', url: `/ops/credits/${T1}` })).statusCode).toBe(401);
    expect((await server.inject({ method: 'GET', url: `/ops/credits/${T1}`, ...withTok('mauvais') })).statusCode).toBe(401);
    expect((await server.inject({ method: 'POST', url: `/ops/credits/${T1}`, ...withTok('mauvais'), payload: recharge(1) })).statusCode).toBe(401);
    await server.close();
  });

  it('🔴 un montant absurde est REFUSÉ, et rien n est écrit', async () => {
    // Il n'existe aucune route de débit : une virgule mal placée ne se rattrape pas, elle doit donc être
    // arrêtée à l'entrée.
    const recharges: number[] = [];
    const server = app({ ...deps, rechargerAgent: async (_t, m) => { recharges.push(m); return m; } });
    for (const montantMicroEur of [0, -5_000, 2_000_000_000, 'beaucoup', null, Number.NaN]) {
      const res = await server.inject({ method: 'POST', url: `/ops/credits/${T1}`, ...withTok(OPS), payload: recharge(montantMicroEur) });
      expect(res.statusCode, String(montantMicroEur)).toBe(400);
    }
    expect((await server.inject({ method: 'POST', url: `/ops/credits/${T1}`, ...withTok(OPS), payload: {} })).statusCode).toBe(400);
    expect(recharges).toEqual([]);
    await server.close();
  });

  it('🔴 une recharge SANS NOTE est refusée, et rien n est écrit', async () => {
    // La session d'exploitation dit QUI (elle signe la note) ; cette phrase dit POURQUOI. Un mouvement
    // d'argent sans explication ne se justifie pas six mois plus tard.
    const recharges: number[] = [];
    const server = app({ ...deps, rechargerAgent: async (_t, m) => { recharges.push(m); return m; } });
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
    const server = app(deps);
    expect((await server.inject({ method: 'GET', url: `/ops/credits/${INCONNU}`, ...withTok(OPS) })).statusCode).toBe(404);
    const res = await server.inject({ method: 'POST', url: `/ops/credits/${INCONNU}`, ...withTok(OPS), payload: recharge(5_000_000) });
    expect(res.statusCode).toBe(404);
    await server.close();
  });

  it('🔴 un identifiant qui n est pas un uuid rend 404, sans toucher la base', async () => {
    // Il partirait tel quel dans un `where id = $1` sur une colonne `uuid` : Postgres LÈVE (`22P02`), donc
    // 500. Une adresse tapée de travers doit rendre 404, pas une page d'incident.
    const vus: string[] = [];
    const server = app({
      soldeAgent: async (t) => { vus.push(t); return { soldeMicroEur: 0, mouvements: [] }; },
      rechargerAgent: async (t) => { vus.push(t); return 1; },
    });
    expect((await server.inject({ method: 'GET', url: '/ops/credits/t1', ...withTok(OPS) })).statusCode).toBe(404);
    expect((await server.inject({ method: 'POST', url: '/ops/credits/t1', ...withTok(OPS), payload: recharge(1000) })).statusCode).toBe(404);
    expect(vus).toEqual([]);
    await server.close();
  });
});


describe('charge des files : l’âge du plus vieux job', () => {
  it('🔴 l’âge remonte jusqu’à la réponse, il n’est pas calculé pour rien', async () => {
    // 🔴 C'est la mesure qui rend observables les objectifs de service (`docs/SLO-2026-09-01.md`) : la
    // profondeur seule ne dit pas si on tient la cadence. Mille jobs avalés en trois secondes vont bien, dix
    // qui attendent depuis un quart d'heure vont mal. Un champ calculé en base mais perdu en route
    // n'afficherait que des zéros, et l'écran passerait pour rassurant.
    const a = app({
      exploitation: {
        getQueueLoad: async () => [
          { queue: 'webhook', backlog: 3, active: 1, failed: 0, ageMaxSecondes: 42 },
          { queue: 'campaign-run', backlog: 0, active: 0, failed: 0, ageMaxSecondes: 0 },
        ],
      },
    });
    const res = await a.inject({ method: 'GET', url: '/ops/overview', ...withTok(OPS) });
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
    const a = app({
      exploitation: {
        getQueueLoadParGroupe: async () => [{ queue: 'campaign-run', groupe: 't-affame', backlog: 3, ageMaxSecondes: 420 }],
      },
    });
    const res = await a.inject({ method: 'GET', url: '/ops/overview', ...withTok(OPS) });
    expect(res.json<{ queuesParGroupe: unknown[] }>().queuesParGroupe)
      .toEqual([{ queue: 'campaign-run', groupe: 't-affame', backlog: 3, ageMaxSecondes: 420 }]);
    await a.close();

    // Une lecture de confort qui échoue ne doit pas emporter l'écran d'exploitation entier : c'est
    // précisément quand ça va mal qu'on en a besoin.
    const b = app({ exploitation: { getQueueLoadParGroupe: async () => { throw new Error('pgboss injoignable'); } } });
    const res2 = await b.inject({ method: 'GET', url: '/ops/overview', ...withTok(OPS) });
    expect(res2.statusCode).toBe(200);
    expect(res2.json<{ queuesParGroupe: unknown[] }>().queuesParGroupe).toEqual([]);
    expect(res2.json<{ queues: unknown[] }>().queues.length).toBeGreaterThan(0);
    await b.close();
  });

  it('une instance sans cette lecture rend une liste vide, pas une erreur', async () => {
    const a = app({});
    const res = await a.inject({ method: 'GET', url: '/ops/overview', ...withTok(OPS) });
    expect(res.json<{ queuesParGroupe: unknown[] }>().queuesParGroupe).toEqual([]);
    await a.close();
  });
});


describe('jobs morts : les voir, puis les rejouer', () => {
  const mort = (id: string, queue: string) => ({ id, queue, data: { x: id }, creeLe: '2026-09-01T00:00:00.000Z', erreur: 'boom' });

  it('lit les jobs morts', async () => {
    const a = app({ exploitation: { listerJobsMorts: async () => [mort('j1', 'webhook')] } });
    const res = await a.inject({ method: 'GET', url: '/ops/dlq', ...withTok(OPS) });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ jobs: Array<{ id: string }> }>().jobs).toHaveLength(1);
    await a.close();
  });

  it('🔴 le rejeu ENFILE PUIS OUBLIE, jamais l’inverse', async () => {
    // 🔴 L'ordre décide du mode de panne. Un crash entre les deux produit un DOUBLON ; l'ordre inverse
    // produirait une PERTE. Le doublon est rattrapé partout où ça compte, la perte nulle part.
    const journal: string[] = [];
    const a = app({
      exploitation: {
        listerJobsMorts: async () => [mort('j1', 'webhook'), mort('j2', 'webhook')],
        oublierJobsMorts: async (ids) => { journal.push(`oublie:${ids.join(',')}`); return ids.length; },
      },
      file: {
        enqueue: async (q) => { journal.push(`enfile:${q}`); },
      },
    });
    const res = await a.inject({ method: 'POST', url: '/ops/dlq/replay', ...withTok(OPS), payload: { queue: 'webhook', limit: 10 } });
    expect(res.json<{ rejoues: number; oublies: number }>()).toEqual({ rejoues: 2, oublies: 2 });
    expect(journal).toEqual(['enfile:webhook', 'enfile:webhook', 'oublie:j1,j2']);
    await a.close();
  });

  it('🔴 un enfilement qui ÉCHOUE n’oublie que ce qui est réellement parti', async () => {
    // Sinon on supprimerait de la file d'échec des traitements qui n'ont jamais été ré-enfilés : une perte
    // silencieuse, et sur un `webhook` c'est un message de client perdu pour de bon.
    const oublies: string[][] = [];
    let enfiles = 0;
    const a = app({
      exploitation: {
        listerJobsMorts: async () => [mort('j1', 'webhook'), mort('j2', 'webhook'), mort('j3', 'webhook')],
        oublierJobsMorts: async (ids) => { oublies.push(ids); return ids.length; },
      },
      file: {
        // Le PREMIER passe, le SECOND échoue : on vérifie qu'on n'oublie que le premier.
        enqueue: async () => { enfiles += 1; if (enfiles === 2) throw new Error('file pleine'); },
      },
    });
    const res = await a.inject({ method: 'POST', url: '/ops/dlq/replay', ...withTok(OPS), payload: { queue: 'webhook' } });
    expect(res.json<{ rejoues: number }>().rejoues).toBe(1);
    expect(oublies).toEqual([['j1']]);
    await a.close();
  });

  it('🔴 la FILE est obligatoire : pas de rejeu « tout » d’un coup', async () => {
    // Un rejeu global relancerait campagnes et webhooks ensemble, sur des causes d'échec différentes qu'on
    // n'a pas toutes corrigées.
    const a = app({ exploitation: { listerJobsMorts: async () => [], oublierJobsMorts: async () => 0 }, file: { enqueue: async () => {} } });
    expect((await a.inject({ method: 'POST', url: '/ops/dlq/replay', ...withTok(OPS), payload: {} })).statusCode).toBe(400);
    expect((await a.inject({ method: 'POST', url: '/ops/dlq/replay', ...withTok(OPS), payload: { queue: 'webhook', limit: 5000 } })).statusCode).toBe(400);
    await a.close();
  });

  it('sans session d’exploitation, ni lecture ni rejeu', async () => {
    // C'est une ÉCRITURE métier : elle ne doit jamais être atteignable depuis un compte de la console.
    const a = app({ exploitation: { listerJobsMorts: async () => [], oublierJobsMorts: async () => 0 }, file: { enqueue: async () => {} } });
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
    const srv = app({ revoquerCleModele: async () => true });
    const r = await srv.inject({ method: 'DELETE', url: `/ops/cle-modele/${T}`, ...withTok(OPS) });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ revoquee: true });
  });

  it('un espace SANS clé n’est pas une erreur', async () => {
    // C'est le cas le plus fréquent : la plupart des espaces n'ont pas d'agent, donc pas de clé. Le traiter
    // en erreur ferait chercher une panne là où il n'y a rien à faire.
    const srv = app({ revoquerCleModele: async () => false });
    const r = await srv.inject({ method: 'DELETE', url: `/ops/cle-modele/${T}`, ...withTok(OPS) });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ revoquee: false });
  });

  it('🔴 Vercel refuse -> 422 qui DIT que la clé est toujours active', async () => {
    // Et pas un 5xx : Cloudflare remplacerait le corps, et l'opérateur croirait à une panne quelconque au
    // lieu de savoir que la clé vit encore et qu'il faut réessayer.
    const srv = app({ revoquerCleModele: async () => { throw new Error('vercel refuse'); } });
    const { resultat: r, lignes } = await capturerJournal(() => srv.inject({ method: 'DELETE', url: `/ops/cle-modele/${T}`, ...withTok(OPS) }));
    expect(r.statusCode).toBe(422);
    expect(r.json().error).toMatch(/toujours active/);
    expect(lignes.find((l) => l.msg === 'ops_revocation_impossible')).toMatchObject({ lvl: 'error', err: 'vercel refuse', tenantId: T });
  });

  it('sans la dépendance, la route se déclare indisponible', async () => {
    const srv = app();
    expect((await srv.inject({ method: 'DELETE', url: `/ops/cle-modele/${T}`, ...withTok(OPS) })).statusCode).toBe(503);
  });

  it('🔴 et elle reste derrière la session d exploitation, comme tout /ops', async () => {
    const srv = app({ revoquerCleModele: async () => true });
    expect((await srv.inject({ method: 'DELETE', url: `/ops/cle-modele/${T}` })).statusCode).toBe(401);
  });
});

/**
 * DÉPÔT D'UN JETON PUBLICITAIRE PAR `/ops` (2026-09-23).
 *
 * Cette porte existe parce que la fenêtre Meta ne peut PAS servir le portefeuille qui possède notre
 * application, c'est-à-dire le nôtre : Meta le grise dans la liste des clients. Le jeton est donc créé à
 * la main et déposé ici. C'est la SEULE route du dépôt qui reçoit un secret Meta dans un corps de
 * requête, d'où les deux cas qui regardent ce qui EN SORT.
 */
describe('/ops : déposer un jeton publicitaire créé à la main', () => {
  const T = '11111111-2222-3333-4444-555555555555';
  const JETON = 'EAAG' + 'x'.repeat(120);
  const DEPOSEE = {
    comptePubId: '475266278124562', compteNom: 'Messaging Me', pageId: '2084133708982860',
    pageNom: 'Messaging Me', devise: 'EUR', fuseau: 'Europe/Paris', pageLiee: 'inconnu',
    ancienRevoque: 'aucun' as const,
  };
  const corps = {
    jeton: JETON, comptePubId: '475266278124562', pageId: '2084133708982860',
    note: 'depot du jeton systeme de notre propre portefeuille',
  };

  it('dépose, et rend les actifs que Meta a confirmés', async () => {
    const vus: Array<[string, string, string, string]> = [];
    const srv = app({ deposerJetonPub: async (t, j, c, pg) => { vus.push([t, j, c, pg]); return DEPOSEE; } });
    const res = await srv.inject({ method: 'POST', url: `/ops/pubs/connexion/${T}`, payload: corps, ...withTok(OPS) });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ connexion: unknown }>().connexion).toEqual(DEPOSEE);
    // Le jeton arrive INTACT au câblage : c'est lui qui le chiffre, la route n'y touche pas.
    expect(vus).toEqual([[T, JETON, '475266278124562', '2084133708982860']]);
    await srv.close();
  });

  it('🔴 le jeton ne ressort NI dans la réponse NI dans le journal', async () => {
    const srv = app({ deposerJetonPub: async () => DEPOSEE });
    const { resultat: res, lignes } = await capturerJournal(() =>
      srv.inject({ method: 'POST', url: `/ops/pubs/connexion/${T}`, payload: corps, ...withTok(OPS) }));
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(JETON);
    // La trace EXISTE (une dépôt de secret ne se fait pas en silence) mais ne porte que les actifs.
    const trace = lignes.find((l) => l.msg === 'ops_jeton_pub_depose');
    expect(trace).toBeDefined();
    expect(JSON.stringify(lignes)).not.toContain(JETON);
    expect(trace?.comptePubId).toBe('475266278124562');
    await srv.close();
  });

  it('🔴 un jeton que Meta refuse n est PAS gardé : 422, et la raison est lisible', async () => {
    const srv = app({ deposerJetonPub: async () => { throw new Error("ce jeton n'accorde pas la Page 42"); } });
    const res = await srv.inject({ method: 'POST', url: `/ops/pubs/connexion/${T}`, payload: corps, ...withTok(OPS) });
    expect(res.statusCode).toBe(422);
    expect(res.json<{ error: string }>().error).toContain('Page 42');
    expect(res.body).not.toContain(JETON);
    await srv.close();
  });

  it('un corps incomplet est refusé AVANT tout appel à Meta', async () => {
    let appele = false;
    const srv = app({ deposerJetonPub: async () => { appele = true; return DEPOSEE; } });
    const court = await srv.inject({ method: 'POST', url: `/ops/pubs/connexion/${T}`, payload: { ...corps, jeton: 'trop-court' }, ...withTok(OPS) });
    expect(court.statusCode).toBe(400);
    const sansPage = await srv.inject({ method: 'POST', url: `/ops/pubs/connexion/${T}`, payload: { jeton: JETON, comptePubId: '1' }, ...withTok(OPS) });
    expect(sansPage.statusCode).toBe(400);
    expect(appele).toBe(false);
    await srv.close();
  });

  it('🔴 sans NOTE -> 400, et rien n est déposé : une écriture d exploitation se relit', async () => {
    // Les trois autres écritures de `/ops` l exigent. Celle-ci REMPLACE la connexion publicitaire d un
    // client : sans la note, on ne sait plus six mois plus tard qui a fait le geste ni pourquoi.
    let appele = false;
    const srv = app({ deposerJetonPub: async () => { appele = true; return DEPOSEE; } });
    const { note: _sans, ...sansNote } = corps;
    void _sans;
    const res = await srv.inject({ method: 'POST', url: `/ops/pubs/connexion/${T}`, payload: sansNote, ...withTok(OPS) });
    expect(res.statusCode).toBe(400);
    expect(appele).toBe(false);
    await srv.close();
  });

  it('🔴 le sort de l ANCIEN accès remonte, et ses cinq valeurs ne se confondent pas', async () => {
    // `aucun` = rien à révoquer ; `echec` = Meta a refusé, donc un accès reste VIVANT et il faudra le
    // retirer à la main ; `meme_entite` = on n'a délibérément PAS révoqué, parce que le retrait aurait
    // aussi désarmé le jeton neuf. Trois gestes différents : les afficher pareil les confondrait.
    const srv = app({ deposerJetonPub: async () => ({ ...DEPOSEE, ancienRevoque: 'echec' as const }) });
    const { resultat: res, lignes } = await capturerJournal(() =>
      srv.inject({ method: 'POST', url: `/ops/pubs/connexion/${T}`, payload: corps, ...withTok(OPS) }));
    expect(res.json<{ connexion: { ancienRevoque: unknown } }>().connexion.ancienRevoque).toBe('echec');
    const trace = lignes.find((l) => l.msg === 'ops_jeton_pub_depose');
    expect(trace?.ancienRevoque).toBe('echec');
    expect(trace?.note).toBe(corps.note);
    await srv.close();
  });

  it('sans session d exploitation -> 401, même avec un corps parfait', async () => {
    const srv = app({ deposerJetonPub: async () => DEPOSEE });
    const res = await srv.inject({ method: 'POST', url: `/ops/pubs/connexion/${T}`, payload: corps });
    expect(res.statusCode).toBe(401);
    await srv.close();
  });
});
