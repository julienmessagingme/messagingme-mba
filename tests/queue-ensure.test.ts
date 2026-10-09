import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PgBossQueue } from '../src/queue/pgboss';

/**
 * LA PRÉPARATION D'UNE FILE SE PARTAGE (lot 3 du plan de performance). `ensure` crée la file et sa file des morts puis
 * pose ses réglages, soit 3 à 5 requêtes : des envois simultanés vers une file pas encore préparée (le démarrage d'une
 * copie de l'API, une rafale de webhooks) refaisaient chacun tout ce travail. Un faux `PgBoss` compte les créations.
 */
const etat = vi.hoisted(() => ({ creations: [] as string[], echecs: 0 }));

vi.mock('pg-boss', () => ({
  PgBoss: class {
    on(): void {}
    async createQueue(nom: string): Promise<void> {
      // Un aller-retour vers la base : sans lui, les appels simultanés ne se chevaucheraient pas.
      await new Promise((r) => setTimeout(r, 5));
      if (etat.echecs > 0) { etat.echecs -= 1; throw new Error('base indisponible'); }
      etat.creations.push(nom);
    }
    async updateQueue(): Promise<void> {}
    async send(): Promise<string> { return 'job'; }
    async start(): Promise<void> {}
    async stop(): Promise<void> {}
  },
}));

beforeEach(() => { etat.creations.length = 0; etat.echecs = 0; });

describe('ensure : une préparation par file, partagée par les appels simultanés', () => {
  it('🔴 dix envois simultanés vers une file neuve ne la préparent qu’une fois', async () => {
    const q = new PgBossQueue('postgres://faux', 'pgboss');
    await Promise.all(Array.from({ length: 10 }, () => q.enqueue('webhook-status', {})));
    expect(etat.creations).toEqual(['webhook-status-dlq', 'webhook-status']);
    await q.enqueue('webhook-status', {});
    expect(etat.creations).toHaveLength(2);
  });

  it('🔴 une préparation en échec n’est pas retenue : l’appel suivant réessaie', async () => {
    const q = new PgBossQueue('postgres://faux', 'pgboss');
    etat.echecs = 1;
    await expect(q.enqueue('webhook-status', {})).rejects.toThrow('base indisponible');
    await q.enqueue('webhook-status', {});
    expect(etat.creations).toEqual(['webhook-status-dlq', 'webhook-status']);
  });
});
