import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { BASE_QUEUES, ALL_QUEUES, dlqName } from '../src/queue/names';

/**
 * Garde-fou anti-drift : /ops, pg-boss et le worker doivent voir la MÊME liste de files. Si on ajoute une file
 * au worker sans l'ajouter à BASE_QUEUES, ou si la convention -dlq diverge de PgBossQueue.ensure(), ce test casse.
 *
 * ⚠️ L'assertion est DÉRIVÉE du worker, pas recopiée. Une liste écrite en dur ici serait purement décorative :
 * c'est exactement ce qui a laissé passer l'ajout de `automation-event` (file réellement travaillée, invisible
 * de /ops, DLQ non surveillée) sans qu'aucun test ne bronche.
 */
describe('queue names (source unique)', () => {
  it('toute file travaillée par le worker figure dans BASE_QUEUES', () => {
    const worker = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');
    // `queue.work('nom', ...)` en littéral, ou via une constante de nom de file (ex. AUTOMATION_EVENT_QUEUE).
    const literals = [...worker.matchAll(/queue\.work\(\s*'([^']+)'/g)].map((m) => m[1]!);
    const viaConst = [...worker.matchAll(/queue\.work\(\s*([A-Z_][A-Z0-9_]*)\s*,/g)].map((m) => m[1]!);
    // Une constante de nom de file doit être définie quelque part avec sa valeur : on la résout par son export.
    const resolved = viaConst.map((name) => {
      if (name === 'AUTOMATION_EVENT_QUEUE') return 'automation-event';
      throw new Error(`constante de file inconnue du test : ${name} (ajoute sa résolution ici)`);
    });
    const worked = [...new Set([...literals, ...resolved])];
    expect(worked.length).toBeGreaterThan(0); // le test doit VRAIMENT trouver des files, sinon il ne prouve rien
    for (const q of worked) expect(BASE_QUEUES as readonly string[], `file ${q} absente de BASE_QUEUES`).toContain(q);
  });

  it('ALL_QUEUES = chaque file de base + sa DLQ, sans doublon', () => {
    expect(ALL_QUEUES).toHaveLength(BASE_QUEUES.length * 2);
    expect(new Set(ALL_QUEUES).size).toBe(ALL_QUEUES.length);
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
