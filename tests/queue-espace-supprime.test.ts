import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PgBossQueue, espaceDuJob } from '../src/queue/pgboss';
import { capturerJournal } from './journal';

/**
 * LES JOBS D'UN ESPACE SUPPRIMÉ (RC8). Après la purge, les jobs encore en file de cet espace (une campagne, un tour
 * d'agent, une analyse, une automation différée) échouent sur un espace disparu : sans abandon, chacun se rejouerait
 * jusqu'à la file des morts, celle que l'essai réel de la suppression regarde. La pierre tombale (`espaces_supprimes`)
 * les reconnaît ; un faux `PgBoss` rend le traitement réellement enregistré par la file.
 */
const etat = vi.hoisted(() => ({
  travaux: [] as Array<[string, (jobs: Array<{ id: string; data: unknown; groupId?: string | null }>) => Promise<void>]>,
}));

vi.mock('pg-boss', () => ({
  PgBoss: class {
    on(): void {}
    async createQueue(): Promise<void> {}
    async updateQueue(): Promise<void> {}
    async work(nom: string, _o: unknown, h: (jobs: Array<{ id: string; data: unknown; groupId?: string | null }>) => Promise<void>): Promise<string> {
      etat.travaux.push([nom, h]);
      return 'boucle';
    }
    notifyWorker(): void {}
    async start(): Promise<void> {}
    async stop(): Promise<void> {}
  },
}));

beforeEach(() => { etat.travaux.length = 0; });

const SUPPRIME = '0b8e2f8a-1c2d-4e3f-9a0b-1c2d3e4f5a6b';
const VIVANT = '9c7d6e5f-4a3b-4c2d-8e1f-0a9b8c7d6e5f';

/** Une file qui travaille `campaign-run` avec un traitement qui lève toujours, et la pierre tombale qui connaît SUPPRIME. */
async function file(o: { pierreTombale?: boolean; lectureEnPanne?: boolean } = {}) {
  const lus: string[] = [];
  const q = new PgBossQueue('postgres://faux', 'pgboss');
  if (o.pierreTombale !== false) {
    q.abandonnerSi(async (t) => {
      lus.push(t);
      if (o.lectureEnPanne) throw new Error('base indisponible');
      return t === SUPPRIME;
    });
  }
  let appels = 0;
  await q.work('campaign-run', async () => { appels += 1; throw new Error('campagne introuvable'); });
  const traiter = etat.travaux[0]![1];
  return { traiter, lus, appels: () => appels };
}

describe('espaceDuJob', () => {
  it('le tenantId des données, sinon le groupe s’il est un identifiant d’espace, sinon rien', () => {
    expect(espaceDuJob({ tenantId: SUPPRIME, x: 1 }, null)).toBe(SUPPRIME);
    expect(espaceDuJob({ campaignId: 'c1' }, SUPPRIME)).toBe(SUPPRIME);
    // Un webhook brut de Meta est groupé par CONTACT, jamais par espace.
    expect(espaceDuJob({ entry: [] }, '33612345678:pn-1')).toBeNull();
    expect(espaceDuJob({ tenantId: 'pas-un-uuid' }, undefined)).toBeNull();
    expect(espaceDuJob(null, null)).toBeNull();
  });
});

describe('🔴 l’abandon d’un job d’un espace supprimé', () => {
  it('un job qui échoue pour un espace de la pierre tombale se termine en silence, avec une ligne de journal', async () => {
    const { traiter, lus } = await file();
    const { lignes } = await capturerJournal(() => traiter([{ id: 'j1', data: { campaignId: 'c1' }, groupId: SUPPRIME }]));
    expect(lus).toEqual([SUPPRIME]);
    expect(lignes).toContainEqual(expect.objectContaining({ msg: 'job_espace_supprime', file: 'campaign-run', job: 'j1', tenantId: SUPPRIME }));
  });

  it('🔴 un espace VIVANT : l’échec remonte, pg-boss le rejouera (une panne reste une panne)', async () => {
    const { traiter } = await file();
    await expect(traiter([{ id: 'j2', data: { tenantId: VIVANT }, groupId: VIVANT }])).rejects.toThrow('campagne introuvable');
  });

  it('un job qui RÉUSSIT ne lit pas la pierre tombale', async () => {
    const lus: string[] = [];
    const q = new PgBossQueue('postgres://faux', 'pgboss');
    q.abandonnerSi(async (t) => { lus.push(t); return true; });
    await q.work('agent-turn', async () => {});
    await etat.travaux[0]![1]([{ id: 'j3', data: { tenantId: SUPPRIME }, groupId: SUPPRIME }]);
    expect(lus).toEqual([]);
  });

  it('une lecture de la pierre tombale en panne laisse remonter l’erreur d’origine', async () => {
    const { traiter } = await file({ lectureEnPanne: true });
    await expect(traiter([{ id: 'j4', data: {}, groupId: SUPPRIME }])).rejects.toThrow('campagne introuvable');
  });

  it('sans pierre tombale branchée (l’API, les tests) : le comportement d’avant, tout échec remonte', async () => {
    const { traiter } = await file({ pierreTombale: false });
    await expect(traiter([{ id: 'j5', data: {}, groupId: SUPPRIME }])).rejects.toThrow('campagne introuvable');
  });

  it('🔴 le worker la branche, sur la table que la purge écrit', async () => {
    const { readFileSync } = await import('node:fs');
    const worker = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');
    expect(worker).toMatch(/queue\.abandonnerSi\(creerPierreTombale\(pool\)\);/);
  });
});
