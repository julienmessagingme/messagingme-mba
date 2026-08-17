import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { BASE_QUEUES, ALL_QUEUES, dlqName, pollingSecondsFor, QUEUE_POLLING_SECONDS } from '../src/queue/names';

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

/**
 * La cadence de polling n'est pas un détail de confort : le défaut pg-boss (2 s par file) a coûté un dépassement
 * du quota d'egress Supabase (663 000 requêtes/jour à vide, 249 Mo/jour, cf. `names.ts`). Ces tests gardent les
 * deux invariants qui empêchent la fuite de revenir : toute file déclarée a une cadence PENSÉE, et une file
 * oubliée retombe sur un défaut lent plutôt que sur les 2 s de pg-boss.
 */
describe('cadence de polling par file', () => {
  it('toute file de BASE_QUEUES a une cadence déclarée', () => {
    for (const q of BASE_QUEUES) {
      expect(QUEUE_POLLING_SECONDS[q], `cadence manquante pour ${q}`).toBeTypeOf('number');
      expect(QUEUE_POLLING_SECONDS[q]).toBeGreaterThanOrEqual(2); // plancher pg-boss : >= 0,5 s, mais 2 s est notre seuil de bruit
    }
  });

  it('le chemin conversationnel reste vif, le traitement de fond est lent', () => {
    // Si quelqu'un ralentit `webhook` pour gagner de l'egress, il dégrade la latence des réponses WhatsApp :
    // c'est l'arbitrage à NE PAS faire, et ce test le dit.
    expect(pollingSecondsFor('webhook')).toBe(2);
    expect(pollingSecondsFor('campaign-run')).toBe(5);
    expect(pollingSecondsFor('analyze-conversation')).toBe(30);
  });

  it('une file inconnue retombe sur un défaut lent, pas sur les 2 s de pg-boss', () => {
    expect(pollingSecondsFor('file-jamais-declaree')).toBe(5);
  });

  it('une DLQ poll lentement (dépôt inspecté par /ops, personne ne la travaille)', () => {
    for (const q of BASE_QUEUES) expect(pollingSecondsFor(dlqName(q))).toBe(60);
  });

  /**
   * Tester les fonctions pures ne prouve PAS qu'elles sont branchées : `maintenanceOptions` pourrait rendre le bon
   * objet sans que personne ne l'appelle, et `pollingSecondsFor` pourrait ne jamais atteindre pg-boss. Ces trois
   * assertions lisent le câblage réel, faute de pouvoir instancier pg-boss sans base dans un test unitaire.
   */
  it('le câblage réel est en place : API sans supervision, worker avec, cadence passée à pg-boss', () => {
    const api = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
    const worker = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');
    const wrapper = readFileSync(new URL('../src/queue/pgboss.ts', import.meta.url), 'utf8');
    expect(api, 'l’API doit démarrer pg-boss sans supervision (elle empile, elle ne dépile pas)').toMatch(/supervise:\s*false/);
    expect(worker, 'le worker doit rester le SEUL à superviser : pas de supervise: false ici').not.toMatch(/supervise:\s*false/);
    expect(worker, 'le worker doit espacer la maintenance flow').toMatch(/flowIntervalSeconds:\s*60/);
    expect(wrapper, 'la cadence par file doit réellement atteindre boss.work').toMatch(/pollingIntervalSeconds:\s*pollingSecondsFor\(name\)/);
  });
});
