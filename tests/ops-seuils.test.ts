import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BORNES_SEUILS, SEUILS_DEFAUT, seuilsEnregistres, valideSeuils, type SeuilsCapacite } from '../src/ops/seuils';
import {
  creerVeilleSante, texteAlerte, DELAI_ENTRE_ALERTES_MS, CLE_VERROU_VEILLE_SANTE, EFFECTIF_MIN_ALERTE_API, FENETRE_APRES_DEMARRAGE_MS,
} from '../src/ops/veille-sante';
import { evaluerSante, type BilanSante, type Brique, type EntreesSante, type EtatBrique } from '../src/ops/sante';
import type { WorkerHeartbeatRow } from '../src/ops/heartbeat-store.pg';
import type { AlerteCapacite } from '../src/ops/seuils.pg';
import type { VerrousCourts } from '../src/db/verrous-courts';
import { buildServer } from '../src/server';
import { FakeQueue } from './fake-queue';
import type { OpsRouteDeps } from '../src/http/ops';
import { exploitationInerte, opsInerte } from './routes-inertes';
import { accesOps } from './acces-ops';

/**
 * LES SEUILS RÉGLABLES ET LES ALERTES DE SANTÉ (refonte de /ops, lot 4). La validation refuse sans corriger, comme la
 * grille de prix ; la veille n'alerte qu'à un changement d'état, une copie à la fois, une fois par demi-heure par signal.
 */

const copie = (): SeuilsCapacite => JSON.parse(JSON.stringify(SEUILS_DEFAUT)) as SeuilsCapacite;

describe('valideSeuils : refuser, jamais corriger', () => {
  it('les défauts de la spec sont valides', () => {
    expect(valideSeuils(SEUILS_DEFAUT)).toEqual({ ok: true, seuils: SEUILS_DEFAUT });
  });

  it('🔴 hors bornes, orange au-dessus du rouge, signal manquant ou inconnu : refusé, le champ nommé', () => {
    const hors = copie(); hors.processeurBase.rouge = 101;
    expect(valideSeuils(hors)).toEqual({ ok: false, champ: 'processeurBase.rouge' });
    const inverse = copie(); inverse.accuses = { orange: 120, rouge: 60 };
    expect(valideSeuils(inverse)).toEqual({ ok: false, champ: 'accuses.orange' });
    const egal = copie(); egal.connexions = { orange: 80, rouge: 80 };
    expect(valideSeuils(egal)).toEqual({ ok: false, champ: 'connexions.orange' });
    const { memoireWorker: _retire, ...manque } = copie();
    expect(valideSeuils(manque)).toEqual({ ok: false, champ: 'memoireWorker' });
    expect(valideSeuils({ ...copie(), proceseurBase: { orange: 1, rouge: 2 } })).toEqual({ ok: false, champ: 'proceseurBase' });
    expect(valideSeuils({ ...copie(), erreurs: { orange: '1', rouge: 5 } })).toEqual({ ok: false, champ: 'erreurs.orange' });
    expect(valideSeuils(null)).toEqual({ ok: false, champ: 'seuils' });
  });

  it('la 2e copie : deux unités (montées, minutes), aucun ordre exigé', () => {
    const s = copie(); s.secondeCopie = { orange: 5, rouge: 2 };
    expect(valideSeuils(s).ok).toBe(true);
    expect(BORNES_SEUILS.secondeCopie.max).toBe(7 * 24 * 60);
  });
});

describe('seuilsEnregistres : relus signal par signal, jamais d’exception', () => {
  it('🔴 un signal valide garde sa valeur, un signal absent ou abîmé reprend son défaut', () => {
    const lus = seuilsEnregistres({ processeurBase: { orange: 50, rouge: 70 }, accuses: { orange: 200, rouge: 100 }, inconnu: 3 });
    expect(lus.processeurBase).toEqual({ orange: 50, rouge: 70 });
    expect(lus.accuses).toEqual(SEUILS_DEFAUT.accuses);
    expect(lus.memoireWorker).toEqual(SEUILS_DEFAUT.memoireWorker);
    expect(seuilsEnregistres(null)).toEqual(SEUILS_DEFAUT);
    expect(seuilsEnregistres('abîmé')).toEqual(SEUILS_DEFAUT);
  });
});

const SAINE: EntreesSante = {
  workers: [{ role: 'principal', beatAt: '2026-10-30T10:00:00.000Z', bootedAt: null, instance: null, ageSeconds: 10 }],
  latencesFiles: [], chargeFiles: [], latencesHttp: [], connexions: { utilisees: 20, max: 147 },
  memoires: [{ role: 'principal', utiliseOctets: 130e6, limiteOctets: 1e9 }],
  cockpit: { configure: true, mesures: {
    baseProcesseur: 7, baseMemoire: 28, baseDisque: 6, baseConnexions: 14, machineProcesseur: 2, machineMemoire: 27, apiMemoire: 22, hubspotCopies: 0,
  } },
};

describe('evaluerSante juge avec les seuils RÉGLÉS', () => {
  it('🔴 des seuils abaissés font passer le processeur de la base orange à 7 %', () => {
    const s = copie(); s.processeurBase = { orange: 5, rouge: 10 };
    expect(evaluerSante(SAINE, Date.now(), s).briques.find((b) => b.cle === 'processeur-base')?.etat).toBe('orange');
    expect(evaluerSante(SAINE).briques.find((b) => b.cle === 'processeur-base')?.etat).toBe('vert');
  });
});

describe('texteAlerte', () => {
  it('dit la mesure, les deux seuils et le geste du rouge ; le retour au vert en une phrase', () => {
    const b: Brique = { cle: 'processeur-base', etat: 'orange', mesure: 65.04 };
    expect(texteAlerte(b, SEUILS_DEFAUT)).toBe('Santé : Processeur de la base passe ORANGE : 65 % (orange à 60 %, rouge à 80 %). Au rouge : passer en DB-DEV-L.');
    expect(texteAlerte({ cle: 'accuses', etat: 'rouge', mesure: 150 }, SEUILS_DEFAUT)).toContain('Retard des accusés de Meta passe ROUGE : 150 s (orange à 60 s, rouge à 120 s)');
    expect(texteAlerte({ cle: 'processeur-base', etat: 'vert', mesure: 8 }, SEUILS_DEFAUT)).toBe('Santé : Processeur de la base revient au vert : 8 %.');
  });
});

describe('la veille de Santé', () => {
  const T0 = Date.parse('2026-10-30T10:00:00.000Z');
  const bilanDe = (briques: Brique[]): BilanSante => ({ briques, jauge: { margePourcent: 50, signal: 'base', partielle: false } } as BilanSante);
  const verrouLibre: VerrousCourts = { prendre: async (cles) => ({ jeton: 'j', cles: cles.map((c) => c[0]) }), relacher: async () => {}, prolonger: async () => true };
  const worker = (bootedAt: number): WorkerHeartbeatRow => ({ role: 'principal', beatAt: new Date(T0).toISOString(), bootedAt: new Date(bootedAt).toISOString(), instance: null, ageSeconds: 5 });
  function monter(o: {
    briques: Brique[];
    dernieres?: AlerteCapacite[];
    verrouLibre?: boolean;
    envoye?: boolean;
    maintenant?: number;
    workers?: WorkerHeartbeatRow[] | null;
    evaluer?: () => Promise<never>;
  }) {
    const envoyes: string[] = [];
    const notes: Array<[string, string, number | null]> = [];
    const prises: string[] = [];
    const verrous: VerrousCourts = {
      prendre: async (cles) => { prises.push(cles[0]![0]); return o.verrouLibre === false ? null : { jeton: 'j', cles: cles.map((c) => c[0]) }; },
      relacher: async () => {},
      prolonger: async () => true,
    };
    const veille = creerVeilleSante({
      evaluer: o.evaluer ?? (async () => ({ bilan: bilanDe(o.briques), seuils: SEUILS_DEFAUT, workers: o.workers ?? [] })),
      alertes: {
        dernieres: async () => new Map((o.dernieres ?? []).map((a) => [a.signal, a])),
        noter: async (signal, etat, mesure) => { notes.push([signal, etat, mesure]); },
      },
      verrous,
      envoyer: async (texte) => { envoyes.push(texte); return o.envoye ?? true; },
      maintenant: () => o.maintenant ?? T0,
    });
    return { veille, envoyes, notes, prises };
  }

  it('🔴 un signal qui passe orange : un message, et son état noté ; le même état au passage suivant : rien', async () => {
    const m = monter({ briques: [{ cle: 'processeur-base', etat: 'orange', mesure: 65 }] });
    await m.veille();
    expect(m.prises).toEqual([CLE_VERROU_VEILLE_SANTE]);
    expect(m.envoyes).toHaveLength(1);
    expect(m.notes).toEqual([['processeur-base', 'orange', 65]]);
    const n = monter({
      briques: [{ cle: 'processeur-base', etat: 'orange', mesure: 66 }],
      dernieres: [{ signal: 'processeur-base', etat: 'orange', mesure: 65, envoyeLe: new Date(T0 - 3600_000).toISOString() }],
    });
    await n.veille();
    expect(n.envoyes).toEqual([]);
  });

  it('🔴 une aggravation part aussitôt ; une baisse ou un retour au vert attend la demi-heure, puis passe', async () => {
    const orange = { signal: 'accuses', etat: 'orange' as const, mesure: 70, envoyeLe: new Date(T0 - 10 * 60_000).toISOString() };
    const pire = monter({ briques: [{ cle: 'accuses', etat: 'rouge', mesure: 150 }], dernieres: [orange] });
    await pire.veille();
    expect(pire.envoyes).toEqual([expect.stringContaining('passe ROUGE')]);
    const rouge = { ...orange, etat: 'rouge' as const };
    const baisse = monter({ briques: [{ cle: 'accuses', etat: 'orange', mesure: 80 }], dernieres: [rouge] });
    await baisse.veille();
    expect(baisse.envoyes).toEqual([]);
    const tot = monter({ briques: [{ cle: 'accuses', etat: 'vert', mesure: 3 }], dernieres: [rouge] });
    await tot.veille();
    expect(tot.envoyes).toEqual([]);
    const tard = monter({ briques: [{ cle: 'accuses', etat: 'vert', mesure: 3 }], dernieres: [rouge], maintenant: T0 + DELAI_ENTRE_ALERTES_MS });
    await tard.veille();
    expect(tard.envoyes).toEqual(['Santé : Retard des accusés de Meta revient au vert : 3 s.']);
    expect(tard.notes).toEqual([['accuses', 'vert', 3]]);
  });

  it('la demi-heure se compte depuis la dernière alerte, à la milliseconde', async () => {
    const pile = { signal: 'base', etat: 'rouge' as const, mesure: 90, envoyeLe: new Date(T0 - DELAI_ENTRE_ALERTES_MS).toISOString() };
    const juste = monter({ briques: [{ cle: 'base', etat: 'vert', mesure: 20 }], dernieres: [pile] });
    await juste.veille();
    expect(juste.envoyes).toHaveLength(1);
    const avant = monter({ briques: [{ cle: 'base', etat: 'vert', mesure: 20 }], dernieres: [{ ...pile, envoyeLe: new Date(T0 - DELAI_ENTRE_ALERTES_MS + 1).toISOString() }] });
    await avant.veille();
    expect(avant.envoyes).toEqual([]);
  });

  it('premier passage, sans aucun historique : un signal vert ne dit rien', async () => {
    const m = monter({ briques: [{ cle: 'processeur-base', etat: 'vert', mesure: 7 }, { cle: 'base', etat: 'vert', mesure: 14 }] });
    await m.veille();
    expect(m.envoyes).toEqual([]);
  });

  it('🔴 une oscillation orange, vert, orange, vert, orange en vingt minutes : un seul message', async () => {
    const journal: AlerteCapacite[] = [];
    let t = T0;
    let etat: EtatBrique = 'orange';
    const envoyes: string[] = [];
    const veille = creerVeilleSante({
      evaluer: async () => ({ bilan: bilanDe([{ cle: 'processeur-base', etat, mesure: etat === 'vert' ? 10 : 65 }]), seuils: SEUILS_DEFAUT, workers: [] }),
      alertes: {
        dernieres: async () => new Map(journal.map((a) => [a.signal, a])),
        noter: async (signal, e, mesure) => { journal.push({ signal, etat: e, mesure, envoyeLe: new Date(t).toISOString() }); },
      },
      verrous: verrouLibre,
      envoyer: async (texte) => { envoyes.push(texte); return true; },
      maintenant: () => t,
    });
    for (const [minutes, e] of [[0, 'orange'], [5, 'vert'], [10, 'orange'], [15, 'vert'], [20, 'orange']] as const) {
      t = T0 + minutes * 60_000; etat = e;
      await veille();
    }
    expect(envoyes).toHaveLength(1);
  });

  it('🔴 un worker démarré depuis moins d’un quart d’heure : le retard des files se tait, le reste alerte', async () => {
    const briques: Brique[] = [{ cle: 'entrants', etat: 'rouge', mesure: 45 }, { cle: 'accuses', etat: 'rouge', mesure: 200 }, { cle: 'base', etat: 'rouge', mesure: 90 }];
    const recent = monter({ briques, workers: [worker(T0 - 5 * 60_000)] });
    await recent.veille();
    expect(recent.notes.map((n) => n[0])).toEqual(['base']);
    const ancien = monter({ briques, workers: [worker(T0 - FENETRE_APRES_DEMARRAGE_MS)] });
    await ancien.veille();
    expect(ancien.notes.map((n) => n[0])).toEqual(['entrants', 'accuses', 'base']);
  });

  it('🔴 la part d’erreurs de l’API ne s’alerte qu’au-delà d’un effectif suffisant', async () => {
    const peu = monter({ briques: [{ cle: 'api', etat: 'rouge', mesure: 5, effectif: 20 }] });
    await peu.veille();
    expect(peu.envoyes).toEqual([]);
    const assez = monter({ briques: [{ cle: 'api', etat: 'rouge', mesure: 5, effectif: EFFECTIF_MIN_ALERTE_API }] });
    await assez.veille();
    expect(assez.envoyes).toHaveLength(1);
  });

  it('un passage encore en cours : le suivant de la même copie ne s’empile pas', async () => {
    let liberer: () => void = () => {};
    const prises: number[] = [];
    const vide = { bilan: bilanDe([]), seuils: SEUILS_DEFAUT, workers: [] };
    const veille = creerVeilleSante({
      // Seul le premier passage reste bloqué, jusqu'à `liberer`.
      evaluer: () => (prises.length === 1 ? new Promise((ok) => { liberer = () => ok(vide); }) : Promise.resolve(vide)),
      alertes: { dernieres: async () => new Map(), noter: async () => {} },
      verrous: { ...verrouLibre, prendre: async (cles) => { prises.push(1); return { jeton: 'j', cles: cles.map((c) => c[0]) }; } },
      envoyer: async () => true,
    });
    const premier = veille();
    await veille();
    await new Promise((ok) => setImmediate(ok));
    liberer();
    await premier;
    expect(prises).toHaveLength(1);
    await veille();
    expect(prises).toHaveLength(2);
  });

  it('une lecture en échec (les seuils compris) fait échouer le passage : rien ne part, l’appelant le journalise', async () => {
    const m = monter({ briques: [], evaluer: async () => { throw new Error('seuils illisibles'); } });
    await expect(m.veille()).rejects.toThrow('seuils illisibles');
    expect(m.envoyes).toEqual([]);
  });

  it('🔴 une autre copie tient le verrou : rien ne se juge ni ne s’envoie', async () => {
    const m = monter({ briques: [{ cle: 'processeur-base', etat: 'rouge', mesure: 90 }], verrouLibre: false });
    await m.veille();
    expect(m.envoyes).toEqual([]);
  });

  it('un signal illisible, les workers (déjà surveillés) et la porte HubSpot ne s’alertent pas', async () => {
    const m = monter({ briques: [
      { cle: 'machine', etat: 'orange', mesure: null, indisponible: true },
      { cle: 'workers', etat: 'rouge', mesure: 900, detail: 'analyse' },
      { cle: 'hubspot', etat: 'vert', mesure: 1 },
    ] });
    await m.veille();
    expect(m.envoyes).toEqual([]);
  });

  it('Telegram n’a pas pris le message : rien n’est noté, le passage suivant réessaie', async () => {
    const m = monter({ briques: [{ cle: 'base', etat: 'rouge', mesure: 90 }], envoye: false });
    await m.veille();
    expect(m.envoyes).toHaveLength(1);
    expect(m.notes).toEqual([]);
  });
});

describe('routes /ops/seuils et les seuils dans Santé', () => {
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

  it('🔴 sans session d’exploitation : refusé, en lecture comme en écriture', async () => {
    const s = app();
    expect((await s.inject({ method: 'GET', url: '/ops/seuils' })).statusCode).toBe(401);
    expect((await s.inject({ method: 'PATCH', url: '/ops/seuils', payload: { seuils: SEUILS_DEFAUT, note: 'une raison valable' } })).statusCode).toBe(401);
    await s.close();
  });

  it('la lecture : en vigueur, défauts, bornes, auteur', async () => {
    const s = app({ seuils: { lire: async () => ({ seuils: SEUILS_DEFAUT, modifieLe: '2026-10-30T09:00:00.000Z', modifiePar: 'j@x : raison' }), ecrire: async () => ({ modifieLe: '', modifiePar: '' }), alertesDepuis: async () => [] } });
    const r = (await s.inject({ method: 'GET', url: '/ops/seuils', ...tok() })).json<Record<string, unknown>>();
    expect(r).toEqual({ seuils: SEUILS_DEFAUT, defauts: SEUILS_DEFAUT, bornes: BORNES_SEUILS, modifieLe: '2026-10-30T09:00:00.000Z', modifiePar: 'j@x : raison' });
    await s.close();
  });

  it('🔴 l’écriture : note obligatoire, champ fautif nommé, sinon les seuils signés de leur auteur', async () => {
    const ecrits: Array<[SeuilsCapacite, string]> = [];
    const s = app({ seuils: {
      lire: async () => ({ seuils: SEUILS_DEFAUT, modifieLe: null, modifiePar: null }),
      ecrire: async (x, par) => { ecrits.push([x, par]); return { modifieLe: '2026-10-30T10:00:00.000Z', modifiePar: par }; },
      alertesDepuis: async () => [],
    } });
    expect((await s.inject({ method: 'PATCH', url: '/ops/seuils', ...tok(), payload: { seuils: SEUILS_DEFAUT } })).statusCode).toBe(400);
    const faux = copie(); faux.memoireWorker = { orange: 90, rouge: 85 };
    const r = await s.inject({ method: 'PATCH', url: '/ops/seuils', ...tok(), payload: { seuils: faux, note: 'trop d’alertes la nuit' } });
    expect(r.statusCode).toBe(400);
    expect(r.json<{ champ: string }>().champ).toBe('memoireWorker.orange');
    const bon = copie(); bon.processeurBase = { orange: 50, rouge: 75 };
    const ok = await s.inject({ method: 'PATCH', url: '/ops/seuils', ...tok(), payload: { seuils: bon, note: 'base plus juste après le banc' } });
    expect(ok.statusCode).toBe(200);
    // L'écran affiche l'auteur enregistré sans relire.
    expect(ok.json<{ modifiePar: string; modifieLe: string }>()).toMatchObject({ modifieLe: '2026-10-30T10:00:00.000Z', modifiePar: expect.stringContaining('base plus juste après le banc') });
    expect(ecrits).toHaveLength(1);
    expect(ecrits[0]![0].processeurBase).toEqual({ orange: 50, rouge: 75 });
    expect(ecrits[0]![1]).toContain('base plus juste après le banc');
    await s.close();
  });

  it('🔴 Santé juge avec les seuils de la base, montre les alertes des 24 h ; une lecture des seuils en échec rend les défauts', async () => {
    const regles = copie(); regles.connexions = { orange: 10, rouge: 90 };
    const alerte = { signal: 'base', etat: 'orange' as const, mesure: 14, envoyeLe: '2026-10-30T09:00:00.000Z' };
    let s = app({
      sante: { connexionsBase: async () => ({ utilisees: 20, max: 147 }), signauxMeta: async () => ({ dernierMessage: null, dernierAccuse: null }), memoires: async () => [] },
      seuils: { lire: async () => ({ seuils: regles, modifieLe: null, modifiePar: null }), ecrire: async () => ({ modifieLe: '', modifiePar: '' }), alertesDepuis: async () => [alerte] },
    });
    let b = (await s.inject({ method: 'GET', url: '/ops/sante', ...tok() })).json<{ briques: Array<{ cle: string; etat: string }>; seuils: unknown; incidents: { alertes: unknown[] } }>();
    expect(b.briques.find((x) => x.cle === 'base')?.etat).toBe('orange');
    expect(b.seuils).toEqual(regles);
    expect(b.incidents.alertes).toEqual([alerte]);
    await s.close();
    s = app({ seuils: { lire: async () => { throw new Error('base'); }, ecrire: async () => ({ modifieLe: '', modifiePar: '' }), alertesDepuis: async () => { throw new Error('base'); } } });
    b = (await s.inject({ method: 'GET', url: '/ops/sante', ...tok() })).json();
    expect(b.seuils).toEqual(SEUILS_DEFAUT);
    // Illisibles, pas « aucune » : l'écran le dit.
    expect(b.incidents.alertes).toBeNull();
    await s.close();
  });
});

describe('le câblage de la veille et de la purge', () => {
  const INDEX = readFileSync(resolve(__dirname, '..', 'src', 'index.ts'), 'utf8');
  const WORKER = readFileSync(resolve(__dirname, '..', 'src', 'worker.ts'), 'utf8');
  const ROUTES = readFileSync(resolve(__dirname, '..', 'src', 'http', 'ops.ts'), 'utf8');

  it('🔴 la route et la veille lisent par les MÊMES sources (fenêtres et files écrites une fois) ; la veille sans seuils par défaut', () => {
    expect(INDEX).toContain('lireEntreesSante(sourcesVeilleSante)');
    expect(ROUTES).toContain('lireEntreesSante(sourcesSante({');
    for (const texte of [INDEX, ROUTES]) expect(texte).not.toMatch(/getQueueLatence\(0\.25/);
    expect(INDEX).not.toContain('SEUILS_DEFAUT');
  });

  it('🔴 la veille tourne dans l’API toutes les cinq minutes, s’arrête avec elle, et partage le lecteur Cockpit de l’écran', () => {
    expect(INDEX).toContain('}, INTERVALLE_VEILLE_SANTE_MS);');
    expect(INDEX).toContain('clearInterval(minuterieVeilleSante);');
    expect(INDEX).toContain('cockpit: lecteurCockpit,');
    expect(INDEX.match(/creerLecteurCockpit\(/g)).toHaveLength(1);
  });

  it('le worker purge l’historique des alertes à sa rétention', () => {
    expect(WORKER).toContain('() => seuilsStore.purgeAlertes(RETENTION_ALERTES_JOURS));');
  });
});
