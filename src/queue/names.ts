/**
 * Source UNIQUE des noms de files pg-boss. Avant ce module, la liste vivait en TROIS endroits qui pouvaient
 * diverger en silence : le tableau QUEUE_NAMES de /ops (n'en listait que 4 sur 8), la convention `-dlq` codée
 * inline dans PgBossQueue.ensure(), et le log de démarrage du worker. Une file renommée d'un côté rendait
 * l'autre aveugle. On la définit ici une fois ; `tests/queue-names.test.ts` garde l'invariant.
 */

/**
 * Les files RÉELLEMENT travaillées par le worker (queue.work). `analyze-conversation` et `push-analysis` ne
 * sont enregistrées qu'à l'exécution (analyse activée / push connecteur), mais la file EXISTE côté /ops même
 * désactivée — getQueueLoad renvoie zéro job si aucun n'a été enfilé — donc on les liste inconditionnellement.
 */
export const BASE_QUEUES = ['webhook', 'campaign-run', 'analyze-conversation', 'push-analysis'] as const;

/**
 * Convention de nommage de la dead-letter queue d'une file. UNE seule définition : PgBossQueue.ensure()
 * l'importe pour créer la DLQ, ainsi le nom lu par /ops et le nom créé par pg-boss ne peuvent pas diverger.
 */
export function dlqName(queue: string): string {
  return `${queue}-dlq`;
}

/** Les 8 files réelles = chaque file de base + sa DLQ. Consommé par PgOpsStore.getQueueLoad (surface /ops). */
export const ALL_QUEUES: string[] = BASE_QUEUES.flatMap((q) => [q, dlqName(q)]);
