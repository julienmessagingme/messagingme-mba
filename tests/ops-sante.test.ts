import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { EFFECTIF_MIN_API, evaluerSante, SEUILS_SANTE, type EntreesSante } from '../src/ops/sante';
import type { MesuresCockpit } from '../src/ops/cockpit';
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
  memoires: [{ role: 'principal', utiliseOctets: 134e6, limiteOctets: 1073741824 }],
  cockpit: { configure: false },
};
const MESURES: MesuresCockpit = {
  baseProcesseur: 7, baseMemoire: 28, baseDisque: 6, baseConnexions: 17, machineProcesseur: 2, machineMemoire: 27,
  apiMemoire: 22, hubspotCopies: 0,
};
const AVEC_COCKPIT: EntreesSante = { ...SAINE, cockpit: { configure: true, mesures: MESURES } };
const brique = (e: EntreesSante, cle: string) => evaluerSante(e).briques.find((b) => b.cle === cle)!;

describe('evaluerSante : une pastille par brique', () => {
  it('tout va bien : six pastilles vertes (sans Cockpit), et une marge large', () => {
    const b = evaluerSante(SAINE);
    expect(b.briques.map((x) => [x.cle, x.etat])).toEqual([
      ['api', 'vert'], ['workers', 'vert'], ['memoire-workers', 'vert'], ['base', 'vert'], ['entrants', 'vert'], ['accuses', 'vert'],
    ]);
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
      sante: {
        connexionsBase: async () => ({ utilisees: 30, max: 147 }),
        signauxMeta: async () => ({ dernierMessage: '2026-10-27T18:00:00.000Z', dernierAccuse: null }),
        memoires: async () => [],
      },
    });
    const r = await s.inject({ method: 'GET', url: '/ops/sante', ...tok() });
    expect(r.statusCode).toBe(200);
    const b = r.json<{ briques: unknown[]; jauge: unknown; meta: unknown; incidents: { fileEchec: number; tachesEnEchec: number; demarrages: unknown[] }; seuils: unknown }>();
    // Sans jeton Cockpit : ni machine, ni processeur de la base, ni porte HubSpot.
    expect(b.briques).toHaveLength(6);
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
        sante: {
          connexionsBase: async () => { throw new Error('base'); },
          signauxMeta: async () => { throw new Error('meta'); },
          memoires: async () => { throw new Error('memoire'); },
        },
      },
      { getQueueLoad: async () => { throw new Error('charge'); } },
    );
    const r = await s.inject({ method: 'GET', url: '/ops/sante', ...tok() });
    expect(r.statusCode).toBe(200);
    const b = r.json<{ connexions: unknown; meta: unknown; briques: Array<{ cle: string; etat: string; indisponible?: boolean }>; incidents: { demarrages: unknown[] } }>();
    expect(b).toMatchObject({ connexions: null, meta: { dernierMessage: null, dernierAccuse: null } });
    expect(b.briques.filter((x) => x.indisponible).map((x) => [x.cle, x.etat])).toEqual([
      ['workers', 'orange'], ['memoire-workers', 'orange'], ['base', 'orange'], ['entrants', 'orange'], ['accuses', 'orange'],
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
    const s = app({ capacite: { parHeure: async (j) => { vus.push(j); return []; }, files: async () => [], memoires: async () => [] } });
    expect((await s.inject({ method: 'GET', url: '/ops/capacite', ...tok() })).json<{ jours: number }>().jours).toBe(30);
    expect((await s.inject({ method: 'GET', url: '/ops/capacite?jours=7', ...tok() })).statusCode).toBe(200);
    expect(vus).toEqual([30, 7]);
    for (const jours of ['0', '31', 'abc']) {
      expect((await s.inject({ method: 'GET', url: `/ops/capacite?jours=${jours}`, ...tok() })).statusCode, jours).toBe(400);
    }
    await s.close();
  });
});

describe('evaluerSante : Cockpit et la mémoire des workers (lot 2)', () => {
  it('sans jeton Cockpit, ses briques n’existent pas ; avec, quatre de plus, dans l’ordre de l’écran', () => {
    expect(evaluerSante(SAINE).briques.map((b) => b.cle)).toEqual(['api', 'workers', 'memoire-workers', 'base', 'entrants', 'accuses']);
    expect(evaluerSante(AVEC_COCKPIT).briques.map((b) => [b.cle, b.etat])).toEqual([
      ['api', 'vert'], ['workers', 'vert'], ['memoire-workers', 'vert'], ['machine', 'vert'], ['base', 'vert'],
      ['processeur-base', 'vert'], ['entrants', 'vert'], ['accuses', 'vert'], ['hubspot', 'vert'],
    ]);
  });

  it('🔴 les seuils de la spec : processeur 60 et 80 %, mémoire d’un worker 70 et 85 % de sa limite', () => {
    const avec = (m: Partial<MesuresCockpit>): EntreesSante => ({ ...SAINE, cockpit: { configure: true, mesures: { ...MESURES, ...m } } });
    expect(brique(avec({ baseProcesseur: 65 }), 'processeur-base').etat).toBe('orange');
    expect(brique(avec({ baseProcesseur: 85 }), 'processeur-base').etat).toBe('rouge');
    expect(brique(avec({ machineProcesseur: 81 }), 'machine').etat).toBe('rouge');
    const limite = 1000;
    expect(brique({ ...SAINE, memoires: [{ role: 'analyse', utiliseOctets: 750, limiteOctets: limite }] }, 'memoire-workers'))
      .toMatchObject({ etat: 'orange', mesure: 75, detail: 'analyse' });
    // Le PIRE des workers décide, et c'est lui qu'on nomme.
    expect(brique({ ...SAINE, memoires: [
      { role: 'principal', utiliseOctets: 100, limiteOctets: limite }, { role: 'analyse', utiliseOctets: 900, limiteOctets: limite },
    ] }, 'memoire-workers')).toMatchObject({ etat: 'rouge', mesure: 90, detail: 'analyse' });
  });

  it('🔴 Cockpit muet : ses briques sont illisibles (orange), la jauge partielle, le reste jugé normalement', () => {
    const muet = evaluerSante({ ...SAINE, cockpit: { configure: true, mesures: null } });
    expect(muet.briques.filter((b) => b.indisponible).map((b) => b.cle)).toEqual(['machine', 'processeur-base', 'hubspot']);
    expect(muet.briques.find((b) => b.cle === 'base')?.etat).toBe('vert');
    expect(muet.jauge.partielle).toBe(true);
    // Un seul signal illisible : seule sa brique.
    const un = evaluerSante({ ...SAINE, cockpit: { configure: true, mesures: { ...MESURES, machineProcesseur: null } } });
    expect(un.briques.filter((b) => b.indisponible).map((b) => b.cle)).toEqual(['machine']);
  });

  it('la porte HubSpot : endormie (0) ou éveillée, jamais une panne', () => {
    expect(brique(AVEC_COCKPIT, 'hubspot')).toMatchObject({ etat: 'vert', mesure: 0 });
    const eveillee = { ...SAINE, cockpit: { configure: true as const, mesures: { ...MESURES, hubspotCopies: 1 } } };
    expect(brique(eveillee, 'hubspot')).toMatchObject({ etat: 'vert', mesure: 1 });
  });

  it('mémoire : aucun relevé frais n’est pas une panne (vert, sans mesure) ; une lecture en échec, si (orange)', () => {
    expect(brique({ ...SAINE, memoires: [] }, 'memoire-workers')).toMatchObject({ etat: 'vert', mesure: null });
    expect(brique({ ...SAINE, memoires: [{ role: 'principal', utiliseOctets: 5, limiteOctets: null }] }, 'memoire-workers').mesure).toBeNull();
    expect(brique({ ...SAINE, memoires: null }, 'memoire-workers')).toMatchObject({ etat: 'orange', indisponible: true });
  });

  it('🔴 un worker qui bat sans relevé frais de sa mémoire, démarré depuis plus de 3 min : orange, pas vert', () => {
    const maintenant = Date.parse('2026-10-28T12:00:00.000Z');
    const demarre = (minutes: number) => new Date(maintenant - minutes * 60_000).toISOString();
    const vivant = (role: string, minutes: number) => ({ ...battement(role, 10), bootedAt: demarre(minutes) });
    const memoires = [{ role: 'principal', utiliseOctets: 100, limiteOctets: 1000 }];
    const b = evaluerSante({ ...SAINE, workers: [vivant('principal', 60), vivant('analyse', 60)], memoires }, maintenant);
    expect(b.briques.find((x) => x.cle === 'memoire-workers')).toMatchObject({ etat: 'orange', indisponible: true, detail: 'analyse' });
    expect(b.jauge.partielle).toBe(true);
    // Démarré il y a une minute : son premier relevé n'a pas encore eu lieu.
    const jeune = evaluerSante({ ...SAINE, workers: [vivant('principal', 60), vivant('analyse', 1)], memoires }, maintenant);
    expect(jeune.briques.find((x) => x.cle === 'memoire-workers')?.etat).toBe('vert');
  });

  it('🔴 la jauge compte les nouveaux signaux : le processeur de la base au rouge la vide', () => {
    const j = evaluerSante({ ...SAINE, cockpit: { configure: true, mesures: { ...MESURES, baseProcesseur: 80 } } }).jauge;
    expect(j).toEqual({ margePourcent: 0, signal: 'processeur-base', partielle: false });
    expect(evaluerSante({ ...SAINE, memoires: [{ role: 'principal', utiliseOctets: 425, limiteOctets: 500 }] }).jauge.signal).toBe('memoire-workers');
  });
});

describe('routes : Cockpit et la mémoire des workers (lot 2)', () => {
  const acces = accesOps();
  let OPS = '';
  beforeAll(async () => {
    const s = buildServer({ queue: new FakeQueue(), auth: acces.auth });
    OPS = await acces.jeton(s);
    await s.close();
  });
  const app = (over: Partial<OpsRouteDeps> = {}) => buildServer({
    queue: new FakeQueue(), auth: acces.auth,
    ops: {
      ...opsInerte,
      exploitation: { ...exploitationInerte, getTenantOverview: async () => [], getGlobalDaily: async () => [], getQueueLoad: async () => [] },
      ...over,
    } as OpsRouteDeps,
  });
  const tok = () => ({ headers: { authorization: `Bearer ${OPS}` } });

  it('Santé : les mesures de Cockpit entrent dans le jugement ; Cockpit qui lève n’abat pas la route', async () => {
    let s = app({ cockpit: { mesures: async () => MESURES, historique: async () => null } });
    let b = (await s.inject({ method: 'GET', url: '/ops/sante', ...tok() })).json<{ briques: Array<{ cle: string; etat: string }> }>();
    expect(b.briques.map((x) => x.cle)).toContain('processeur-base');
    await s.close();
    s = app({ cockpit: { mesures: async () => { throw new Error('cockpit'); }, historique: async () => null } });
    const r = await s.inject({ method: 'GET', url: '/ops/sante', ...tok() });
    expect(r.statusCode).toBe(200);
    b = r.json();
    expect(b.briques.find((x) => x.cle === 'processeur-base')?.etat).toBe('orange');
    await s.close();
  });

  it('Capacité : la mémoire des workers et les courbes de Cockpit ; sans jeton, « non configuré »', async () => {
    const point = { role: 'principal', heure: '2026-10-28T10:00:00.000Z', maxOctets: 134e6, limiteOctets: 1073741824 };
    const series = { baseProcesseur: [{ heure: '2026-10-28T10:00:00.000Z', valeur: 7 }], baseMemoire: null, baseDisque: [], baseConnexions: [],
      machineProcesseur: [], machineMemoire: [], apiMemoire: [] };
    let s = app({
      capacite: { parHeure: async () => [], files: async () => [], memoires: async () => [point] },
      cockpit: { mesures: async () => null, historique: async () => series },
    });
    let c = (await s.inject({ method: 'GET', url: '/ops/capacite', ...tok() })).json<{ memoires: unknown[]; cockpit: unknown }>();
    expect(c.memoires).toEqual([point]);
    expect(c.cockpit).toEqual({ configure: true, series });
    await s.close();
    s = app();
    c = (await s.inject({ method: 'GET', url: '/ops/capacite', ...tok() })).json();
    expect(c.cockpit).toEqual({ configure: false });
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

describe('le relevé de la mémoire, dans chaque worker (lot 2)', () => {
  const WORKER = readFileSync(resolve(__dirname, '..', 'src', 'worker.ts'), 'utf8');
  const ROLES = readFileSync(resolve(__dirname, '..', 'src', 'worker', 'roles.ts'), 'utf8');

  it('🔴 chaque minute, sur CHAQUE rôle, à part du battement, et un échec lève (le registre le compte)', () => {
    expect(WORKER).toContain("taches.programmer('memoire-workers', 60_000, async () => {");
    expect(WORKER).toContain('await memoireWorkersStore.noter(config.WORKER_ROLE, await lireMemoireConteneur());');
    expect(ROLES).toContain("'memoire-workers': 'tous',");
  });

  it('le worker purge la table à sa rétention', () => {
    expect(WORKER).toContain('() => memoireWorkersStore.purgeOlderThan(RETENTION_MEMOIRE_WORKERS_JOURS));');
  });
});
