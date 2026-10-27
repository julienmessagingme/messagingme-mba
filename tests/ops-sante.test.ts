import { describe, it, expect, beforeAll } from 'vitest';
import { evaluerSante, SEUILS_SANTE, type EntreesSante } from '../src/ops/sante';
import { buildServer } from '../src/server';
import { FakeQueue } from './fake-queue';
import type { ExploitationOps, OpsRouteDeps } from '../src/http/ops';
import { exploitationInerte, opsInerte } from './routes-inertes';
import { accesOps } from './acces-ops';

/**
 * L'ONGLET SANTÉ DE /OPS (refonte, lot 1). La fonction juge, la route assemble : chaque pastille se vérifie par cas,
 * et la route dans sa forme. Les seuils sont ceux des bancs du 2026-10-27 (`SEUILS_SANTE`).
 */

const battement = (role: string, ageSeconds: number) => ({ role, beatAt: '2026-10-27T18:00:00.000Z', bootedAt: null, instance: null, ageSeconds });
const latence = (queue: string, p95: number) => ({ queue, echantillons: 10, attenteP50Secondes: 0, attenteP95Secondes: p95, boutEnBoutP95Secondes: p95, boutEnBoutMaxSecondes: p95 });
const charge = (queue: string, ageMaxSecondes: number) => ({ queue, backlog: 0, active: 0, failed: 0, ageMaxSecondes });
const http = (code: number, requetes: number) => ({ methode: 'GET', route: '/x', code, groupe: 'autres' as const, requetes, p50Ms: 1, p95Ms: 1, maxMs: 1, moyenneMs: 1 });

const SAINE: EntreesSante = {
  workers: [battement('principal', 10), battement('analyse', 12)],
  latencesFiles: [latence('webhook', 0.2), latence('webhook-status', 28)],
  chargeFiles: [charge('webhook', 0), charge('webhook-status', 0)],
  latencesHttp: [http(200, 1000)],
  connexions: { utilisees: 40, max: 147 },
};
const brique = (e: EntreesSante, cle: string) => evaluerSante(e).briques.find((b) => b.cle === cle)!;

describe('evaluerSante : une pastille par brique', () => {
  it('tout va bien : cinq pastilles vertes, et une marge large', () => {
    const b = evaluerSante(SAINE);
    expect(b.briques.map((x) => [x.cle, x.etat])).toEqual([['api', 'vert'], ['workers', 'vert'], ['base', 'vert'], ['entrants', 'vert'], ['accuses', 'vert']]);
    expect(b.jauge.margePourcent).toBeGreaterThan(50);
  });

  it('🔴 un worker arrêté garde son vieux battement : rouge, et c’est lui qu’on nomme', () => {
    const b = brique({ ...SAINE, workers: [battement('principal', 10), battement('analyse', 900)] }, 'workers');
    expect(b).toMatchObject({ etat: 'rouge', mesure: 900, detail: 'analyse' });
    expect(brique({ ...SAINE, workers: [battement('principal', 150)] }, 'workers').etat).toBe('orange');
  });

  it('🔴 aucun worker n’a jamais battu : rouge (rien ne traite les files)', () => {
    expect(brique({ ...SAINE, workers: [] }, 'workers')).toMatchObject({ etat: 'rouge', mesure: null });
  });

  it('les accusés : le p95 de l’heure OU l’âge du plus vieux en attente, le pire des deux', () => {
    expect(brique({ ...SAINE, latencesFiles: [latence('webhook-status', 70)] }, 'accuses').etat).toBe('orange');
    expect(brique({ ...SAINE, latencesFiles: [latence('webhook-status', 130)] }, 'accuses').etat).toBe('rouge');
    // Une file figée : aucun accusé fini dans l'heure, mais le plus vieux attend depuis 5 minutes.
    expect(brique({ ...SAINE, latencesFiles: [], chargeFiles: [charge('webhook-status', 300)] }, 'accuses')).toMatchObject({ etat: 'rouge', mesure: 300 });
  });

  it('aucun trafic : rien à mesurer, donc vert (une nuit calme n’est pas une panne)', () => {
    const calme = { ...SAINE, latencesFiles: [], chargeFiles: [], latencesHttp: [] };
    expect(brique(calme, 'entrants')).toMatchObject({ etat: 'vert', mesure: null });
    expect(brique(calme, 'api')).toMatchObject({ etat: 'vert', mesure: null });
  });

  it('la base : connexions rapportées à ce qu’elle accepte ; lecture en échec, pas de valeur', () => {
    expect(brique({ ...SAINE, connexions: { utilisees: 110, max: 147 } }, 'base').etat).toBe('orange');
    expect(brique({ ...SAINE, connexions: { utilisees: 130, max: 147 } }, 'base').etat).toBe('rouge');
    expect(brique({ ...SAINE, connexions: null }, 'base')).toMatchObject({ etat: 'vert', mesure: null });
  });

  it('l’API : la part de 5xx de l’heure', () => {
    expect(brique({ ...SAINE, latencesHttp: [http(200, 980), http(502, 20)] }, 'api')).toMatchObject({ etat: 'orange', mesure: 2 });
    expect(brique({ ...SAINE, latencesHttp: [http(200, 900), http(500, 100)] }, 'api').etat).toBe('rouge');
  });
});

describe('evaluerSante : la jauge de capacité', () => {
  it('🔴 le signal le plus tendu décide, et la marge ne descend pas sous zéro', () => {
    const tendue = evaluerSante({ ...SAINE, latencesFiles: [latence('webhook-status', SEUILS_SANTE.accuses.rouge * 2)] });
    expect(tendue.jauge).toEqual({ margePourcent: 0, signal: 'accuses' });
    const base = evaluerSante({ ...SAINE, latencesFiles: [], connexions: { utilisees: 100, max: 147 } });
    expect(base.jauge.signal).toBe('base');
    expect(base.jauge.margePourcent).toBe(Math.round(100 * (1 - (100 * 100 / 147) / SEUILS_SANTE.connexions.rouge)));
  });
});

describe('routes /ops/sante et /ops/capacite', () => {
  const acces = accesOps();
  let OPS = '';
  beforeAll(async () => {
    const s = buildServer({ queue: new FakeQueue(), auth: acces.auth });
    OPS = await acces.jeton(s);
    await s.close();
  });
  const app = (over: Partial<OpsRouteDeps> = {}, exploitation: Partial<ExploitationOps> = {}) => buildServer({
    queue: new FakeQueue(),
    auth: acces.auth,
    ops: {
      ...opsInerte,
      exploitation: {
        ...exploitationInerte,
        getTenantOverview: async () => [], getGlobalDaily: async () => [],
        getQueueLoad: async () => [charge('webhook', 0), { ...charge('webhook-dlq', 0), backlog: 2 }, { ...charge('webhook-status', 0), failed: 3 }],
        ...exploitation,
      },
      ...over,
    } as OpsRouteDeps,
  });
  const tok = () => ({ headers: { authorization: `Bearer ${OPS}` } });

  it('🔴 sans session d’exploitation : refusé', async () => {
    const s = app();
    expect((await s.inject({ method: 'GET', url: '/ops/sante' })).statusCode).toBe(401);
    expect((await s.inject({ method: 'GET', url: '/ops/capacite' })).statusCode).toBe(401);
    await s.close();
  });

  it('la santé : les briques, la jauge, les signaux de Meta, les incidents et les seuils', async () => {
    const s = app({
      heartbeat: { lister: async () => [{ ...battement('principal', 5), bootedAt: new Date().toISOString() }] },
      sante: { connexionsBase: async () => ({ utilisees: 30, max: 147 }), signauxMeta: async () => ({ dernierMessage: '2026-10-27T18:00:00.000Z', dernierAccuse: null }) },
    });
    const r = await s.inject({ method: 'GET', url: '/ops/sante', ...tok() });
    expect(r.statusCode).toBe(200);
    const b = r.json<{ briques: unknown[]; jauge: unknown; meta: unknown; incidents: { fileEchec: number; tachesEnEchec: number; demarrages: unknown[] }; seuils: unknown }>();
    expect(b.briques).toHaveLength(5);
    expect(b.meta).toEqual({ dernierMessage: '2026-10-27T18:00:00.000Z', dernierAccuse: null });
    // La file d'échec et les tâches en échec ne se confondent pas.
    expect(b.incidents.fileEchec).toBe(2);
    expect(b.incidents.tachesEnEchec).toBe(3);
    expect(b.incidents.demarrages).toHaveLength(1);
    expect(b.seuils).toEqual(SEUILS_SANTE);
    await s.close();
  });

  it('une lecture en échec laisse sa brique sans valeur, jamais l’écran vide', async () => {
    const s = app({ sante: { connexionsBase: async () => { throw new Error('base'); }, signauxMeta: async () => { throw new Error('meta'); } } });
    const r = await s.inject({ method: 'GET', url: '/ops/sante', ...tok() });
    expect(r.statusCode).toBe(200);
    expect(r.json<{ connexions: unknown; meta: unknown }>()).toMatchObject({ connexions: null, meta: { dernierMessage: null, dernierAccuse: null } });
    await s.close();
  });

  it('la capacité : trente jours par défaut, de 1 à 30, et rien d’autre', async () => {
    const vus: number[] = [];
    const s = app({ capacite: { parHeure: async (j) => { vus.push(j); return []; }, files: async () => [] } });
    expect((await s.inject({ method: 'GET', url: '/ops/capacite', ...tok() })).json<{ jours: number }>().jours).toBe(30);
    expect((await s.inject({ method: 'GET', url: '/ops/capacite?jours=7', ...tok() })).statusCode).toBe(200);
    expect(vus).toEqual([30, 7]);
    for (const jours of ['0', '31', 'abc']) {
      expect((await s.inject({ method: 'GET', url: `/ops/capacite?jours=${jours}`, ...tok() })).statusCode, jours).toBe(400);
    }
    await s.close();
  });
});
