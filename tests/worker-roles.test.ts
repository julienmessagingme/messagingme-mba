import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BASE_QUEUES } from '../src/queue/names';
import {
  FILES_PAR_ROLE,
  TACHES_PAR_ROLE,
  assume,
  fileDuRole,
  minuterieDuRole,
  nomDuProcessus,
  tachesDuRole,
  type RoleWorker,
} from '../src/worker/roles';
import { registreDeTaches } from '../src/worker/taches';

/**
 * LES DEUX RÔLES DU WORKER : ce qui les tient, c'est ce fichier.
 *
 * 🔴 LA LISTE SE DÉRIVE DE `worker.ts`, ELLE NE SE RECOPIE PAS. C'est le motif de
 * `tests/queue-names.test.ts`, et il est là pour la même raison : une liste écrite à la main dérive dès qu'on
 * ajoute un balayage, et le symptôme serait une minuterie qui ne tourne dans AUCUN rôle, donc une purge ou une
 * reprise qui s'arrête sans que rien ne le dise.
 */
const SOURCE = readFileSync(resolve(__dirname, '..', 'src', 'worker.ts'), 'utf8');

/** Les noms réellement passés à `taches.programmer(...)` dans le worker. */
function minuteriesDuWorker(): string[] {
  const noms = [...SOURCE.matchAll(/programmer\('([^']+)'/g)].map((m) => m[1]!);
  expect(noms.length).toBeGreaterThan(20); // le jour où l'extraction casse, elle ne doit pas rendre 0 en silence
  return [...new Set(noms)];
}

describe('appartenance des files et des minuteries à un rôle', () => {
  it('🔴 chaque minuterie du worker a un rôle, et aucune n’en a deux', () => {
    for (const nom of minuteriesDuWorker()) {
      expect(TACHES_PAR_ROLE[nom], `minuterie « ${nom} » absente de TACHES_PAR_ROLE`).toBeDefined();
    }
  });

  it('🔴 la table ne range AUCUNE minuterie qui n’existe plus', () => {
    // L'autre sens, celui qu'on oublie : une entrée orpheline laisse croire qu'un balayage tourne.
    const vivantes = new Set(minuteriesDuWorker());
    for (const nom of Object.keys(TACHES_PAR_ROLE)) {
      expect(vivantes.has(nom), `TACHES_PAR_ROLE range « ${nom} », que le worker ne programme plus`).toBe(true);
    }
  });

  it('🔴 chaque file de BASE_QUEUES a un rôle', () => {
    for (const q of BASE_QUEUES) expect(FILES_PAR_ROLE[q], `file « ${q} » sans rôle`).toBeDefined();
    expect(Object.keys(FILES_PAR_ROLE).sort()).toEqual([...BASE_QUEUES].sort());
  });

  it('🔴 en `all`, TOUT est assumé : c’est la garantie que le défaut ne change rien', () => {
    for (const a of Object.values(FILES_PAR_ROLE)) expect(assume('all', a)).toBe(true);
    for (const a of Object.values(TACHES_PAR_ROLE)) expect(assume('all', a)).toBe(true);
  });

  it('🔴 les deux rôles ensemble couvrent tout, et une seule fois chacun sauf `tous`', () => {
    const compte = (nom: string, a: 'principal' | 'analyse' | 'tous'): number =>
      (['principal', 'analyse'] as const).filter((r) => assume(r, a)).length;
    for (const [nom, a] of Object.entries({ ...FILES_PAR_ROLE, ...TACHES_PAR_ROLE })) {
      expect(compte(nom, a), `« ${nom} » tourne dans ${compte(nom, a)} rôle(s)`).toBe(a === 'tous' ? 2 : 1);
    }
  });

  it('🔴 le heartbeat et les attentes de pool tournent dans les DEUX rôles', () => {
    // Necessaire, mais PAS SUFFISANT aujourd hui, et c est mesure : `worker_heartbeat` est une ligne UNIQUE
    // (`id = 'worker'` en dur). Les deux roles l ecriraient tous les deux, le survivant rafraichirait la ligne
    // du mort, et /ops la lirait vivante. 🔴 CLEFER LE BATTEMENT PAR ROLE EST UN BLOQUEUR DU DECOUPAGE :
    // ce test garde la moitie qui depend de ce fichier, l autre moitie demande une migration.
    expect(TACHES_PAR_ROLE['heartbeat']).toBe('tous');
    expect(TACHES_PAR_ROLE['pool-attentes']).toBe('tous');
  });

  it('🔴 les agrégats et la purge des conversations restent dans le MÊME rôle', () => {
    // Ils se parlent par un drapeau EN MÉMOIRE (`agregatsAJour`) : séparés, la purge RGPD s'arrêterait pour
    // toujours, en silence. Ce test est la seule chose qui empêche de « ranger proprement » les agrégats avec
    // l'analyse un jour de refactor.
    expect(TACHES_PAR_ROLE['agregats-analyse']).toBe(TACHES_PAR_ROLE['retention-conversations']);
  });
});

describe('le filtre des deux coutures', () => {
  it('un registre de rôle ne programme que ce qui lui appartient', () => {
    const vus: string[] = [];
    const faux = { programmer: (n: string) => { vus.push(n); }, arreterTout: () => {}, noms: () => vus };
    const principal = tachesDuRole(faux as never, 'principal');
    principal.programmer('reclaim', 1000, () => {});
    principal.programmer('analyse-conversations', 1000, () => {});
    principal.programmer('heartbeat', 1000, () => {});
    expect(vus).toEqual(['reclaim', 'heartbeat']);
  });

  it('🔴 une minuterie INCONNUE lève, elle n’est pas ignorée', () => {
    // Un nom qu'on n'a pas rangé est une décision qu'on n'a pas prise. L'ignorer la trancherait au hasard du
    // rôle qui tourne, et le balayage disparaîtrait sans un mot.
    const r = tachesDuRole(registreDeTaches(), 'principal');
    expect(() => r.programmer('balayage-inconnu', 1000, () => {})).toThrow(/sans rôle/);
  });

  it('une file inconnue lève aussi', () => {
    expect(() => fileDuRole('file-inconnue', 'principal')).toThrow(/sans rôle/);
  });

  it('le partage des files est celui qu’on attend', () => {
    expect(fileDuRole('webhook', 'principal')).toBe(true);
    expect(fileDuRole('webhook', 'analyse')).toBe(false);
    expect(fileDuRole('analyze-conversation', 'analyse')).toBe(true);
    expect(fileDuRole('analyze-conversation', 'principal')).toBe(false);
    for (const r of ['principal', 'analyse', 'all'] as RoleWorker[]) {
      expect(fileDuRole('webhook', r)).toBe(r !== 'analyse');
    }
  });
});

describe('ce qui tourne HORS du registre suit le même partage (relecture du 2026-10-03)', () => {
  it('minuterieDuRole rend le partage de la table, et lève sur un nom inconnu', () => {
    expect(minuterieDuRole('agregats-analyse', 'principal')).toBe(true);
    expect(minuterieDuRole('agregats-analyse', 'analyse')).toBe(false);
    expect(minuterieDuRole('agregats-analyse', 'all')).toBe(true);
    for (const r of ['principal', 'analyse', 'all'] as RoleWorker[]) expect(minuterieDuRole('heartbeat', r)).toBe(true);
    expect(() => minuterieDuRole('minuterie-fantome', 'principal')).toThrow(/TACHES_PAR_ROLE/);
  });

  it('🔴 le balayage d’agrégats du DÉMARRAGE est gardé par le rôle de sa minuterie', () => {
    // Il est appelé une fois avant `taches.programmer('agregats-analyse', ...)`, donc hors du registre que
    // `tachesDuRole` filtre : sans cette garde, le rôle `analyse` le jouait à chaque démarrage, en production.
    const debut = SOURCE.indexOf('let agregatsAJour = false;');
    const fin = SOURCE.indexOf("taches.programmer('agregats-analyse'");
    expect(debut).toBeGreaterThan(0);
    expect(fin).toBeGreaterThan(debut);
    const demarrage = SOURCE.slice(debut, fin);
    const garde = demarrage.indexOf("if (minuterieDuRole('agregats-analyse', config.WORKER_ROLE))");
    const appel = demarrage.indexOf('await agregatsSweep()');
    expect(garde, 'garde absente du balayage de démarrage').toBeGreaterThan(0);
    expect(appel, 'garde posée APRÈS l’appel, donc décorative').toBeGreaterThan(garde);
  });

  it('nomDuProcessus : un nom par rôle, et `all` garde le nom d’avant', () => {
    expect(nomDuProcessus('all')).toBe('worker');
    const noms = (['principal', 'analyse'] as RoleWorker[]).map(nomDuProcessus);
    expect(new Set([...noms, nomDuProcessus('all')]).size).toBe(3);
  });

  it('🔴 les attentes de pool et les alertes passent par le nom du processus, jamais par un nom en dur', () => {
    // Un nom en dur fait fusionner les deux workers dans la même courbe de `/ops` et dans les mêmes alertes.
    expect(SOURCE).not.toContain('[mba-worker]');
    expect(SOURCE).toContain('viderVersLaBase(poolAttentesStore, mesureAttentePool, nomDuProcessus(config.WORKER_ROLE)');
    expect(SOURCE.split('sendTelegram(`[mba-${nomDuProcessus(config.WORKER_ROLE)}]').length - 1).toBe(2);
  });
});
