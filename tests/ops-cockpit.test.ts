import { describe, it, expect } from 'vitest';
import { creerLecteurCockpit, REQUETES_COCKPIT, SIGNAUX_HISTORIQUE } from '../src/ops/cockpit';
import { interpreterCgroup, lireMemoireConteneur } from '../src/ops/memoire-worker';
import type { HttpGet } from '../src/lib/http-get';

/**
 * COCKPIT EN LECTURE ET LA MÉMOIRE D'UN WORKER (refonte de /ops, lot 2). Le client ne voit jamais le vrai Cockpit ici :
 * un faux GET rend des réponses de la forme mesurée le 2026-10-28 (`docs/prive/cockpit-formules.txt`).
 */

const URL_SOURCE = 'https://source.metrics.cockpit.nl-ams.scw.cloud';
type Appel = { url: string; headers: Record<string, string>; signal?: AbortSignal };

/** Un faux Cockpit : `repondre(requete PromQL, chemin)` rend { status, json } ; chaque appel est gardé. */
function fauxCockpit(repondre: (q: string, chemin: string) => { status: number; json: unknown } | 'jette') {
  const appels: Appel[] = [];
  const http: HttpGet = {
    async get(url, headers, opts) {
      appels.push({ url, headers, ...(opts?.signal ? { signal: opts.signal } : {}) });
      const u = new URL(url);
      const r = repondre(u.searchParams.get('query') ?? '', u.pathname);
      if (r === 'jette') throw new Error('réseau');
      return r;
    },
  };
  return { http, appels };
}
const vecteur = (...valeurs: string[]) => ({ status: 200, json: { status: 'success', data: { resultType: 'vector', result: valeurs.map((v) => ({ metric: {}, value: [1761645600, v] })) } } });
const matrice = (...series: Array<Array<[number, string]>>) => ({ status: 200, json: { status: 'success', data: { resultType: 'matrix', result: series.map((values) => ({ metric: {}, values })) } } });

describe('le lecteur Cockpit : l’instant', () => {
  it('chaque signal par sa requête, le jeton en Bearer vers la source, la pire série retenue', async () => {
    const { http, appels } = fauxCockpit((q) => (q === REQUETES_COCKPIT.apiMemoire ? vecteur('12.5', '22.3') : vecteur('6.7')));
    const m = await creerLecteurCockpit({ url: `${URL_SOURCE}/`, jeton: 'jeton-test', http }).mesures();
    expect(m).toMatchObject({ baseProcesseur: 6.7, apiMemoire: 22.3, hubspotCopies: 6.7 });
    expect(appels).toHaveLength(Object.keys(REQUETES_COCKPIT).length);
    expect(appels.every((a) => a.url.startsWith(`${URL_SOURCE}/prometheus/api/v1/query?query=`))).toBe(true);
    expect(appels[0]!.headers).toEqual({ authorization: 'Bearer jeton-test' });
  });

  it('🔴 la porte HubSpot endormie n’a AUCUNE série : zéro copie, pas une lecture en échec', async () => {
    const { http } = fauxCockpit((q) => (q === REQUETES_COCKPIT.hubspotCopies ? vecteur() : vecteur('5')));
    expect((await creerLecteurCockpit({ url: URL_SOURCE, jeton: 'j', http }).mesures())?.hubspotCopies).toBe(0);
  });

  it('🔴 un signal refusé, jeté, d’une autre forme ou NaN vaut null ; les autres restent ; rien qui réponde : null', async () => {
    const signales: Array<{ signal: string; status: number | null }> = [];
    const { http } = fauxCockpit((q) => {
      if (q === REQUETES_COCKPIT.baseProcesseur) return { status: 403, json: { error: 'interdit' } };
      if (q === REQUETES_COCKPIT.baseMemoire) return 'jette';
      if (q === REQUETES_COCKPIT.baseDisque) return { status: 200, json: { autre: 'forme' } };
      if (q === REQUETES_COCKPIT.machineMemoire) return vecteur('NaN');
      return vecteur('3');
    });
    const m = await creerLecteurCockpit({ url: URL_SOURCE, jeton: 'j', http, signaler: (d) => signales.push(d) }).mesures();
    expect(m).toMatchObject({ baseProcesseur: null, baseMemoire: null, baseDisque: null, machineMemoire: null, machineProcesseur: 3 });
    expect(signales).toEqual(expect.arrayContaining([
      { signal: 'baseProcesseur', status: 403 }, { signal: 'baseMemoire', status: null }, { signal: 'baseDisque', status: 200 },
    ]));
    // Le jeton ne part jamais dans ce qui se journalise.
    expect(JSON.stringify(signales)).not.toContain('j"');
    const { http: muet } = fauxCockpit(() => ({ status: 503, json: null }));
    expect(await creerLecteurCockpit({ url: URL_SOURCE, jeton: 'j', http: muet }).mesures()).toBeNull();
  });

  it('une minute de cache : l’écran rechargé ne relance pas huit requêtes', async () => {
    let t = 0;
    const { http, appels } = fauxCockpit(() => vecteur('1'));
    const l = creerLecteurCockpit({ url: URL_SOURCE, jeton: 'j', http, maintenant: () => t });
    await l.mesures();
    t = 59_000;
    await l.mesures();
    expect(appels).toHaveLength(8);
    t = 61_000;
    await l.mesures();
    expect(appels).toHaveLength(16);
  });
});

describe('le lecteur Cockpit : trente jours', () => {
  const MAINTENANT = Date.parse('2026-10-28T12:00:00.000Z');

  it('le pire de chaque heure par sous-requête, un point par heure, les séries fusionnées au pire, NaN écarté', async () => {
    const { http, appels } = fauxCockpit(() => matrice(
      [[1761645600, '10.04'], [1761649200, 'NaN']],
      [[1761645600, '12.26'], [1761649200, '3']],
    ));
    const h = await creerLecteurCockpit({ url: URL_SOURCE, jeton: 'j', http, maintenant: () => MAINTENANT }).historique(30);
    expect(h?.baseProcesseur).toEqual([{ heure: '2025-10-28T10:00:00.000Z', valeur: 12.3 }, { heure: '2025-10-28T11:00:00.000Z', valeur: 3 }]);
    expect(appels).toHaveLength(SIGNAUX_HISTORIQUE.length);
    const u = new URL(appels[0]!.url);
    expect(u.pathname).toBe('/prometheus/api/v1/query_range');
    expect(u.searchParams.get('query')).toBe(`max_over_time((${REQUETES_COCKPIT.baseProcesseur})[1h:5m])`);
    expect(u.searchParams.get('step')).toBe('3600');
    expect(Number(u.searchParams.get('end')) - Number(u.searchParams.get('start'))).toBe(30 * 86_400);
  });

  it('🔴 une sous-requête refusée (400) : la requête simple, plutôt que rien', async () => {
    const { http, appels } = fauxCockpit((q) => (q.startsWith('max_over_time') ? { status: 400, json: null } : matrice([[1761645600, '4']])));
    const h = await creerLecteurCockpit({ url: URL_SOURCE, jeton: 'j', http, maintenant: () => MAINTENANT }).historique(7);
    expect(h?.machineProcesseur).toEqual([{ heure: '2025-10-28T10:00:00.000Z', valeur: 4 }]);
    expect(appels).toHaveLength(2 * SIGNAUX_HISTORIQUE.length);
  });

  it('rien qui réponde : null ; un signal seul en échec : null pour lui', async () => {
    const { http: muet } = fauxCockpit(() => 'jette');
    expect(await creerLecteurCockpit({ url: URL_SOURCE, jeton: 'j', http: muet }).historique(30)).toBeNull();
    const { http } = fauxCockpit((q) => (q.includes('MemAvailable') ? { status: 500, json: null } : matrice([[1761645600, '1']])));
    const h = await creerLecteurCockpit({ url: URL_SOURCE, jeton: 'j', http }).historique(30);
    expect(h?.baseMemoire).toBeNull();
    expect(h?.baseDisque).toHaveLength(1);
  });
});

describe('le lecteur Cockpit : les jaunes de la relecture', () => {
  const MAINTENANT = Date.parse('2026-10-28T12:00:00.000Z');

  it('🔴 chaque appel porte une échéance : un Cockpit qui pend ne bloque pas /ops', async () => {
    const { http, appels } = fauxCockpit(() => vecteur('1'));
    await creerLecteurCockpit({ url: URL_SOURCE, jeton: 'j', http }).mesures();
    expect(appels.every((a) => a.signal instanceof AbortSignal)).toBe(true);
    // Un GET qui ne rend jamais la main : l'échéance de l'appel l'interrompt, le signal vaut null.
    const pend: HttpGet = { get: (_u, _h, opts) => new Promise((_ok, ko) => { opts?.signal?.addEventListener('abort', () => ko(new Error('abort'))); }) };
    const m = await creerLecteurCockpit({ url: URL_SOURCE, jeton: 'j', http: pend, delaiMs: 20 }).mesures();
    expect(m).toBeNull();
  });

  it('une sous-requête refusée en 422 aussi : la requête simple ; un seul signalement par signal en échec', async () => {
    const signales: string[] = [];
    const { http } = fauxCockpit((q) => (q.startsWith('max_over_time') ? { status: 422, json: null } : { status: 500, json: null }));
    const h = await creerLecteurCockpit({ url: URL_SOURCE, jeton: 'j', http, signaler: (d) => signales.push(d.signal) }).historique(7);
    expect(h).toBeNull();
    expect(signales.filter((x) => x === 'baseProcesseur')).toHaveLength(1);
  });

  it('🔴 une matrice vide (ressource renommée, jeton sans accès) : indisponible, pas trente jours à zéro', async () => {
    const { http } = fauxCockpit((q) => (q.includes('cpu_seconds') ? matrice() : matrice([[1761645600, '2']])));
    const h = await creerLecteurCockpit({ url: URL_SOURCE, jeton: 'j', http, maintenant: () => MAINTENANT }).historique(30);
    expect(h?.baseProcesseur).toBeNull();
    expect(h?.machineProcesseur).toBeNull();
    expect(h?.baseMemoire).toHaveLength(1);
  });

  it('🔴 un échec se garde 30 s, un succès son temps (une minute pour l’instant, dix pour les trente jours)', async () => {
    let t = 0;
    let panne = true;
    const { http, appels } = fauxCockpit(() => (panne ? { status: 503, json: null } : vecteur('1')));
    const l = creerLecteurCockpit({ url: URL_SOURCE, jeton: 'j', http, maintenant: () => t });
    expect(await l.mesures()).toBeNull();
    panne = false;
    t = 29_000;
    expect(await l.mesures()).toBeNull();
    t = 31_000;
    expect((await l.mesures())?.baseProcesseur).toBe(1);
    const avant = appels.length;
    t = 31_000 + 59_000;
    await l.mesures();
    expect(appels.length).toBe(avant);
  });

  it('les trente jours : dix minutes de cache, et une fenêtre bornée à 31 jours quoi qu’on demande', async () => {
    let t = MAINTENANT;
    const { http, appels } = fauxCockpit(() => matrice([[1761645600, '1']]));
    const l = creerLecteurCockpit({ url: URL_SOURCE, jeton: 'j', http, maintenant: () => t });
    await l.historique(999);
    const u = new URL(appels[0]!.url);
    expect(Number(u.searchParams.get('end')) - Number(u.searchParams.get('start'))).toBe(31 * 86_400);
    const avant = appels.length;
    t += 9 * 60_000;
    await l.historique(999);
    expect(appels.length).toBe(avant);
    t += 2 * 60_000;
    await l.historique(999);
    expect(appels.length).toBe(2 * avant);
  });
});

describe('la mémoire d’un worker, dans son groupe de contrôle', () => {
  it('🔴 l’usage de `docker stats` : memory.current moins inactive_file ; la limite de memory.max', () => {
    // Les valeurs relevées sur `mba-worker` le 2026-10-28.
    const m = interpreterCgroup('146104320\n', 'anon 129589248\nfile 4931584\ninactive_file 4931584\n', '1073741824\n');
    expect(m).toEqual({ utiliseOctets: 141172736, limiteOctets: 1073741824 });
  });

  it('sans limite (`max`), la limite vaut null ; un contenu illisible ne se devine pas', () => {
    expect(interpreterCgroup('1000', 'inactive_file 0', 'max')).toEqual({ utiliseOctets: 1000, limiteOctets: null });
    expect(interpreterCgroup('abc', '', '1')).toBeNull();
  });

  it('hors d’un conteneur (fichiers absents) : la mémoire du processus seul, sans limite', async () => {
    const m = await lireMemoireConteneur(async () => { throw new Error('ENOENT'); }, () => 42);
    expect(m).toEqual({ utiliseOctets: 42, limiteOctets: null });
  });

  it('dans un conteneur, les trois fichiers du groupe de contrôle', async () => {
    const lus: string[] = [];
    const contenu: Record<string, string> = {
      '/sys/fs/cgroup/memory.current': '2000', '/sys/fs/cgroup/memory.stat': 'inactive_file 500', '/sys/fs/cgroup/memory.max': '4000',
    };
    const m = await lireMemoireConteneur(async (c) => { lus.push(c); return contenu[c]!; }, () => 1);
    expect(m).toEqual({ utiliseOctets: 1500, limiteOctets: 4000 });
    expect(lus.sort()).toEqual(Object.keys(contenu).sort());
  });
});
