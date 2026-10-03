import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildServer } from '../src/server';
import { FakeQueue } from './fake-queue';
import {
  BORNES_LATENCE_MS, MesureLatenceHttp, ROUTE_INCONNUE, centile, groupeDeRoute, trancheDe, versLigneOps, type LigneLatence,
} from '../src/ops/latence-http';
import { fenetreDe, viderLatencesVersLaBase } from '../src/ops/latence-http.pg';

/**
 * LA LATENCE HTTP PAR ROUTE (audit de performance du 2026-10-02, § 11). Le SQL (fusion des tranches, agrégat entre
 * copies et fenêtres) est éprouvé en intégration ; ici, la mesure, le centile, le crochet sur un VRAI serveur et
 * le vidage.
 */

const N = BORNES_LATENCE_MS.length + 1;
const seauxAvec = (paires: [number, number][]): number[] => {
  const s = new Array<number>(N).fill(0);
  for (const [i, n] of paires) s[i] = n;
  return s;
};

describe('la tranche d’une durée', () => {
  it('borne haute INCLUSE : 10 ms tombe dans « ≤ 10 », 10,1 dans la suivante', () => {
    expect(trancheDe(0)).toBe(0);
    expect(trancheDe(10)).toBe(0);
    expect(trancheDe(10.1)).toBe(1);
    expect(trancheDe(500)).toBe(BORNES_LATENCE_MS.indexOf(500));
    expect(trancheDe(800)).toBe(BORNES_LATENCE_MS.indexOf(800));
  });

  it('au-delà de la dernière borne : la tranche ouverte', () => {
    expect(trancheDe(10_000.5)).toBe(N - 1);
    expect(trancheDe(600_000)).toBe(N - 1);
  });

  it('les seuils de l’audit sont des bornes, sinon « p95 > 800 » ne se lirait pas exactement', () => {
    expect(BORNES_LATENCE_MS).toContain(500);
    expect(BORNES_LATENCE_MS).toContain(800);
    expect([...BORNES_LATENCE_MS].sort((a, b) => a - b)).toEqual([...BORNES_LATENCE_MS]);
  });
});

describe('la mesure', () => {
  it('additionne sous la même méthode, route et code, et sépare les codes', () => {
    const m = new MesureLatenceHttp();
    m.enregistrer('GET', '/contacts/:id', 200, 5);
    m.enregistrer('GET', '/contacts/:id', 200, 120);
    m.enregistrer('GET', '/contacts/:id', 404, 3);
    const lignes = m.vider();
    expect(lignes).toHaveLength(2);
    const ok = lignes.find((l) => l.code === 200)!;
    expect(ok.seaux.reduce((s, x) => s + x, 0)).toBe(2);
    expect(ok.seaux[trancheDe(5)]).toBe(1);
    expect(ok.seaux[trancheDe(120)]).toBe(1);
    expect(ok.sommeMs).toBe(125);
    expect(ok.maxMs).toBe(120);
  });

  it('une requête sans route reconnue tombe sous UN seul nom', () => {
    const m = new MesureLatenceHttp();
    m.enregistrer('GET', undefined, 404, 1);
    m.enregistrer('POST', '', 404, 1);
    expect(m.vider().map((l) => l.route)).toEqual([ROUTE_INCONNUE, ROUTE_INCONNUE]);
  });

  it('une durée absurde (négative, NaN) compte, à zéro, sans casser la somme', () => {
    const m = new MesureLatenceHttp();
    m.enregistrer('GET', '/x', 200, -4);
    m.enregistrer('GET', '/x', 200, Number.NaN);
    const [l] = m.vider();
    expect(l!.seaux[0]).toBe(2);
    expect(l!.sommeMs).toBe(0);
  });

  it('vider repart à zéro', () => {
    const m = new MesureLatenceHttp();
    m.enregistrer('GET', '/x', 200, 1);
    expect(m.vider()).toHaveLength(1);
    expect(m.vider()).toEqual([]);
  });

  it('réinjecter FUSIONNE avec ce qui s’est accumulé entre-temps, tranche à tranche', () => {
    const m = new MesureLatenceHttp();
    m.enregistrer('GET', '/x', 200, 1);
    m.enregistrer('GET', '/x', 200, 900);
    const perdues = m.vider();
    m.enregistrer('GET', '/x', 200, 30);
    m.enregistrer('GET', '/y', 500, 2);
    m.reinjecter(perdues);
    const lignes = m.vider();
    const x = lignes.find((l) => l.route === '/x')!;
    expect(x.seaux.reduce((s, n) => s + n, 0)).toBe(3);
    expect(x.seaux[trancheDe(900)]).toBe(1);
    expect(x.sommeMs).toBe(931);
    expect(x.maxMs).toBe(900);
    expect(lignes.find((l) => l.route === '/y')!.seaux.reduce((s, n) => s + n, 0)).toBe(1);
  });

  it('réinjecter une ligne absente ne partage pas son tableau avec l’appelant', () => {
    const m = new MesureLatenceHttp();
    const l: LigneLatence = { methode: 'GET', route: '/z', code: 200, seaux: seauxAvec([[0, 1]]), sommeMs: 1, maxMs: 1 };
    m.reinjecter([l]);
    m.enregistrer('GET', '/z', 200, 1);
    expect(l.seaux[0]).toBe(1);
  });
});

describe('le centile tiré des tranches', () => {
  it('aucune requête : null, pas zéro (zéro serait une mesure)', () => {
    expect(centile(seauxAvec([]), 0.95, 0)).toBeNull();
  });

  it('la borne haute de la tranche où tombe la requête de rang ceil(q × n)', () => {
    // 100 requêtes : 94 sous 100 ms, 6 entre 300 et 500 ms. Le rang 95 tombe dans « ≤ 500 ».
    const s = seauxAvec([[trancheDe(100), 94], [trancheDe(500), 6]]);
    expect(centile(s, 0.95, 480)).toBe(480); // plafonné par le maximum mesuré
    expect(centile(s, 0.95, 5000)).toBe(500);
    expect(centile(s, 0.5, 5000)).toBe(100);
  });

  it('94 % sous le seuil ne suffit pas, 95 % oui : le rang est exact', () => {
    const s95 = seauxAvec([[trancheDe(100), 95], [trancheDe(500), 5]]);
    expect(centile(s95, 0.95, 5000)).toBe(100);
  });

  it('la tranche ouverte n’a pas d’autre borne que le maximum', () => {
    expect(centile(seauxAvec([[N - 1, 3]]), 0.95, 42_000)).toBe(42_000);
  });

  it('une seule requête : p50 et p95 la désignent toutes deux', () => {
    const s = seauxAvec([[trancheDe(250), 1]]);
    expect(centile(s, 0.5, 260)).toBe(260);
    expect(centile(s, 0.95, 260)).toBe(260);
  });
});

describe('le groupe d’une route', () => {
  it('webhooks, Inbox et API publique en tête, comme l’audit le demande', () => {
    expect(groupeDeRoute('/webhooks/meta')).toBe('webhooks');
    expect(groupeDeRoute('/webhooks/stripe')).toBe('webhooks');
    expect(groupeDeRoute('/tenants/:tenantId/conversations')).toBe('inbox');
    expect(groupeDeRoute('/tenants/:tenantId/conversations/:conversationId/messages')).toBe('inbox');
    expect(groupeDeRoute('/v1/sends')).toBe('v1');
    expect(groupeDeRoute('/tenants/:tenantId/contacts')).toBe('autres');
    expect(groupeDeRoute(ROUTE_INCONNUE)).toBe('autres');
  });

  it('la ligne de l’écran porte effectif, centiles, maximum et moyenne', () => {
    const r = versLigneOps({ methode: 'POST', route: '/webhooks/meta', code: 200, seaux: seauxAvec([[0, 3], [1, 1]]), sommeMs: 40, maxMs: 22 });
    expect(r).toEqual({ methode: 'POST', route: '/webhooks/meta', code: 200, groupe: 'webhooks', requetes: 4, p50Ms: 10, p95Ms: 22, maxMs: 22, moyenneMs: 10 });
  });
});

describe('🔴 le crochet, sur un VRAI serveur', () => {
  it('enregistre le MOTIF de la route, jamais l’identifiant de l’adresse, avec le bon code', async () => {
    const mesure = new MesureLatenceHttp();
    const app = buildServer({ queue: new FakeQueue(), mesureLatence: mesure });
    app.get('/essai/:contactId', async (_req, reply) => reply.code(201).send({ ok: true }));
    expect((await app.inject({ method: 'GET', url: '/essai/7f3c-un-identifiant-reel' })).statusCode).toBe(201);
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    const lignes = mesure.vider();
    await app.close();
    expect(lignes.map((l) => `${l.methode} ${l.route} ${l.code}`).sort()).toEqual(['GET /essai/:contactId 201', 'GET /health 200']);
    expect(JSON.stringify(lignes)).not.toContain('7f3c');
  });

  it('une adresse qu’aucune route ne reconnaît tombe sous `(aucune route)`, sans son chemin', async () => {
    const mesure = new MesureLatenceHttp();
    const app = buildServer({ queue: new FakeQueue(), mesureLatence: mesure });
    expect((await app.inject({ method: 'GET', url: '/wp-admin/secret-123.php' })).statusCode).toBe(404);
    const lignes = mesure.vider();
    await app.close();
    expect(lignes).toHaveLength(1);
    expect(lignes[0]).toMatchObject({ methode: 'GET', route: ROUTE_INCONNUE, code: 404 });
    expect(JSON.stringify(lignes)).not.toContain('wp-admin');
  });

  it('une erreur du handler est mesurée sous son code 500', async () => {
    const mesure = new MesureLatenceHttp();
    const app = buildServer({ queue: new FakeQueue(), mesureLatence: mesure });
    app.get('/essai-panne', async () => { throw new Error('panne'); });
    expect((await app.inject({ method: 'GET', url: '/essai-panne' })).statusCode).toBe(500);
    const lignes = mesure.vider();
    await app.close();
    expect(lignes[0]).toMatchObject({ route: '/essai-panne', code: 500 });
  });

  it('sans mesure (les tests), le serveur sert normalement', async () => {
    const app = buildServer({ queue: new FakeQueue() });
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    await app.close();
  });
});

describe('le vidage en base', () => {
  it('la fenêtre de cinq minutes qui contient l’instant', () => {
    expect(fenetreDe(new Date('2026-10-03T12:07:31.500Z')).toISOString()).toBe('2026-10-03T12:05:00.000Z');
    expect(fenetreDe(new Date('2026-10-03T12:05:00.000Z')).toISOString()).toBe('2026-10-03T12:05:00.000Z');
    expect(fenetreDe(new Date('2026-10-03T12:04:59.999Z')).toISOString()).toBe('2026-10-03T12:00:00.000Z');
  });

  it('rien à écrire au repos : aucune écriture, `false`', async () => {
    const ecrits: unknown[] = [];
    const ecrit = await viderLatencesVersLaBase({ enregistrer: async (...a) => { ecrits.push(a); } }, new MesureLatenceHttp(), 'api', new Date());
    expect(ecrit).toBe(false);
    expect(ecrits).toEqual([]);
  });

  it('écrit sous le nom de la copie, dans sa fenêtre', async () => {
    const m = new MesureLatenceHttp();
    m.enregistrer('GET', '/x', 200, 3);
    const ecrits: [string, Date, LigneLatence[]][] = [];
    const ecrit = await viderLatencesVersLaBase(
      { enregistrer: async (p, f, l) => { ecrits.push([p, f, l]); } }, m, 'api-b', new Date('2026-10-03T12:07:31Z'),
    );
    expect(ecrit).toBe(true);
    expect(ecrits).toHaveLength(1);
    expect(ecrits[0]![0]).toBe('api-b');
    expect(ecrits[0]![1].toISOString()).toBe('2026-10-03T12:05:00.000Z');
    expect(ecrits[0]![2]).toHaveLength(1);
  });

  it('🔴 une écriture en échec ne remonte pas, et ses lignes sont reprises au vidage suivant', async () => {
    const m = new MesureLatenceHttp();
    m.enregistrer('GET', '/x', 200, 3);
    const erreurs: unknown[] = [];
    const ecrit = await viderLatencesVersLaBase({ enregistrer: async () => { throw new Error('KO'); } }, m, 'api', new Date(), (e) => erreurs.push(e));
    expect(ecrit).toBe(false);
    expect(erreurs).toHaveLength(1);
    const reprises = m.vider();
    expect(reprises).toHaveLength(1);
    expect(reprises[0]!.seaux.reduce((s, n) => s + n, 0)).toBe(1);
  });
});

describe('🔴 le câblage', () => {
  const INDEX = readFileSync(resolve(__dirname, '..', 'src', 'index.ts'), 'utf8');
  const WORKER = readFileSync(resolve(__dirname, '..', 'src', 'worker.ts'), 'utf8');

  it('l’API passe la mesure au serveur, la vide sous le nom de sa copie, et la lit dans `/ops`', () => {
    expect(INDEX).toContain('const mesureLatence = new MesureLatenceHttp();');
    // Sur sa propre ligne : la seule propriété abrégée de ce nom est dans l'appel à `buildServer`.
    expect(INDEX).toMatch(/\n\s+mesureLatence,\n/);
    expect(INDEX).toContain('viderLatencesVersLaBase(latences, mesureLatence, NOM_API,');
    expect(INDEX).toContain('latencesHttp: httpLatencesStore,');
  });

  it('le vidage ne se mesure pas lui-même dans le pool', () => {
    expect(INDEX).toContain('mesureAttentePool.sansSeMesurer(() => httpLatencesStore.enregistrer(p, f, l))');
  });

  it('le worker purge la table à sa rétention', () => {
    expect(WORKER).toContain('httpLatencesStore.purgeOlderThan(RETENTION_LATENCES_JOURS)');
  });
});
