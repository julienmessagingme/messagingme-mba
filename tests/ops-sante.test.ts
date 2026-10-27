import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { EFFECTIF_MIN_API, evaluerSante, SEUILS_SANTE, type EntreesSante } from '../src/ops/sante';
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
const http = (code: number, requetes: number, route = '/x') => ({ methode: 'GET', route, code, groupe: 'autres' as const, requetes, p50Ms: 1, p95Ms: 1, maxMs: 1, moyenneMs: 1 });

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

  it('la base : connexions rapportées à ce qu’elle accepte', () => {
    expect(brique({ ...SAINE, connexions: { utilisees: 110, max: 147 } }, 'base').etat).toBe('orange');
    expect(brique({ ...SAINE, connexions: { utilisees: 130, max: 147 } }, 'base').etat).toBe('rouge');
  });

  it('🔴 une lecture en échec n’est pas « aucun trafic » : orange, marquée illisible, jamais verte', () => {
    const illisible = { etat: 'orange', mesure: null, indisponible: true };
    expect(brique({ ...SAINE, connexions: null }, 'base')).toEqual({ cle: 'base', ...illisible });
    expect(brique({ ...SAINE, latencesHttp: null }, 'api')).toEqual({ cle: 'api', ...illisible });
    expect(brique({ ...SAINE, workers: null }, 'workers')).toEqual({ cle: 'workers', ...illisible });
    // Les deux lectures des files : l'une manque, le retard ne se juge pas.
    expect(brique({ ...SAINE, chargeFiles: null }, 'entrants')).toEqual({ cle: 'entrants', ...illisible });
    expect(brique({ ...SAINE, latencesFiles: null }, 'accuses')).toEqual({ cle: 'accuses', ...illisible });
    // Lues, les briques ne portent pas la marque.
    expect(evaluerSante(SAINE).briques.every((b) => b.indisponible === undefined)).toBe(true);
  });

  it('l’API : la part de 5xx de l’heure', () => {
    expect(brique({ ...SAINE, latencesHttp: [http(200, 980), http(502, 20)] }, 'api')).toMatchObject({ etat: 'orange', mesure: 2 });
    expect(brique({ ...SAINE, latencesHttp: [http(200, 900), http(500, 100)] }, 'api').etat).toBe('rouge');
  });

  it('🔴 l’API : sous le minimum de requêtes rien ne se juge, et ni la sonde de vie ni /ops ne comptent', () => {
    // Une requête en échec sur dix : 10 %, mais trop peu pour juger.
    expect(brique({ ...SAINE, latencesHttp: [http(200, EFFECTIF_MIN_API - 2), http(500, 1)] }, 'api')).toMatchObject({ etat: 'vert', mesure: null });
    // La sonde de vie (360 par heure) ne dilue plus les vraies erreurs : 3 en échec sur 30 requêtes du service, 10 %.
    expect(brique({ ...SAINE, latencesHttp: [http(200, 360, '/live'), http(200, 27), http(500, 3)] }, 'api')).toMatchObject({ etat: 'rouge', mesure: 10 });
    // Le 502 de la carte Vercel de /ops n'est pas une panne de l'API.
    expect(brique({ ...SAINE, latencesHttp: [http(200, 100), http(502, 50, '/ops/vercel')] }, 'api')).toMatchObject({ etat: 'vert', mesure: 0 });
  });
});

describe('evaluerSante : la jauge de capacité', () => {
  it('🔴 le signal le plus tendu décide, et la marge ne descend pas sous zéro', () => {
    const tendue = evaluerSante({ ...SAINE, latencesFiles: [latence('webhook-status', SEUILS_SANTE.accuses.rouge * 2)] });
    expect(tendue.jauge).toEqual({ margePourcent: 0, signal: 'accuses', partielle: false });
    const base = evaluerSante({ ...SAINE, latencesFiles: [], connexions: { utilisees: 100, max: 147 } });
    expect(base.jauge.signal).toBe('base');
    expect(base.jauge.margePourcent).toBe(Math.round(100 * (1 - (100 * 100 / 147) / SEUILS_SANTE.connexions.rouge)));
  });

  it('🔴 une lecture de capacité en échec : la jauge le dit, au lieu d’une marge pleine muette', () => {
    expect(evaluerSante({ ...SAINE, chargeFiles: null }).jauge.partielle).toBe(true);
    expect(evaluerSante({ ...SAINE, connexions: null }).jauge.partielle).toBe(true);
    // Les workers et l'API ne sont pas des signaux de capacité.
    expect(evaluerSante({ ...SAINE, workers: null, latencesHttp: null }).jauge.partielle).toBe(false);
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

  it('🔴 une lecture en échec rend sa brique illisible (orange), jamais l’écran vide ni une pastille verte', async () => {
    const s = app(
      {
        heartbeat: { lister: async () => { throw new Error('battements'); } },
        sante: { connexionsBase: async () => { throw new Error('base'); }, signauxMeta: async () => { throw new Error('meta'); } },
      },
      { getQueueLoad: async () => { throw new Error('charge'); } },
    );
    const r = await s.inject({ method: 'GET', url: '/ops/sante', ...tok() });
    expect(r.statusCode).toBe(200);
    const b = r.json<{ connexions: unknown; meta: unknown; briques: Array<{ cle: string; etat: string; indisponible?: boolean }>; incidents: { demarrages: unknown[] } }>();
    expect(b).toMatchObject({ connexions: null, meta: { dernierMessage: null, dernierAccuse: null } });
    expect(b.briques.filter((x) => x.indisponible).map((x) => [x.cle, x.etat])).toEqual([
      ['workers', 'orange'], ['base', 'orange'], ['entrants', 'orange'], ['accuses', 'orange'],
    ]);
    expect(b.incidents.demarrages).toEqual([]);
    await s.close();
  });

  it('le retard des files se juge sur le dernier quart d’heure, et la révision est rendue', async () => {
    const fenetres: number[] = [];
    const s = app({}, { getQueueLatence: async (h) => { fenetres.push(h); return []; } });
    const r = await s.inject({ method: 'GET', url: '/ops/sante', ...tok() });
    expect(fenetres).toEqual([0.25]);
    expect(typeof r.json<{ revision: unknown }>().revision).toBe('string');
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

describe('le relevé des files, dans le worker', () => {
  const WORKER = readFileSync(resolve(__dirname, '..', 'src', 'worker.ts'), 'utf8');

  it('🔴 toutes les 15 minutes, l’heure en cours et la précédente, et un échec LÈVE (le registre le compte)', () => {
    expect(WORKER).toContain("taches.programmer('mesures-files', 15 * 60_000, () => mesuresFilesStore.relever(new Date(Date.now() - 60 * 60_000)), {");
    // Un `.catch` qui avale l'erreur ferait passer la passe pour réussie dans la carte « Tâches de fond ».
    expect(WORKER).not.toContain('mesuresFilesStore.relever(new Date(Date.now() - 60 * 60_000)).catch');
  });

  it('le worker purge la table à sa rétention', () => {
    expect(WORKER).toContain('() => mesuresFilesStore.purgeOlderThan(RETENTION_FILES_HEURES_JOURS));');
  });
});
