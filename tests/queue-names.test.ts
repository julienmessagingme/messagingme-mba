import { describe, it, expect } from 'vitest';
import { BASE_QUEUES, ALL_QUEUES, dlqName } from '../src/queue/names';

/**
 * Garde-fou anti-drift : /ops, pg-boss et le worker doivent voir la MÊME liste de files. Si on ajoute une file
 * au worker sans l'ajouter à BASE_QUEUES, ou si la convention -dlq diverge de PgBossQueue.ensure(), ce test casse.
 */
describe('queue names (source unique)', () => {
  it('BASE_QUEUES = les 4 files travaillées par le worker', () => {
    expect([...BASE_QUEUES]).toEqual(['webhook', 'campaign-run', 'analyze-conversation', 'push-analysis']);
  });

  it('ALL_QUEUES = 8 entrées : chaque file de base + sa DLQ', () => {
    expect(ALL_QUEUES).toHaveLength(8);
    expect(new Set(ALL_QUEUES).size).toBe(8); // aucun doublon
    for (const q of BASE_QUEUES) {
      expect(ALL_QUEUES).toContain(q);
      expect(ALL_QUEUES).toContain(dlqName(q));
    }
  });

  it('dlqName applique la convention <name>-dlq (identique à PgBossQueue.ensure)', () => {
    expect(dlqName('webhook')).toBe('webhook-dlq');
    expect(dlqName('campaign-run')).toBe('campaign-run-dlq');
  });
});
