/**
 * Source UNIQUE des noms de files pg-boss. Avant ce module, la liste vivait en TROIS endroits qui pouvaient
 * diverger en silence : le tableau QUEUE_NAMES de /ops (n'en listait qu'une partie), la convention `-dlq` codée
 * inline dans PgBossQueue.ensure(), et le log de démarrage du worker. Une file renommée d'un côté rendait
 * l'autre aveugle. On la définit ici une fois ; `tests/queue-names.test.ts` garde l'invariant.
 */

/**
 * Les files RÉELLEMENT travaillées par le worker (queue.work). `analyze-conversation` et `push-analysis` ne
 * sont enregistrées qu'à l'exécution (analyse activée / push connecteur), mais la file EXISTE côté /ops même
 * désactivée — getQueueLoad renvoie zéro job si aucun n'a été enfilé — donc on les liste inconditionnellement.
 */
export const BASE_QUEUES = ['webhook', 'campaign-run', 'analyze-conversation', 'push-analysis', 'hubspot-catchup', 'automation-event'] as const;

/**
 * Convention de nommage de la dead-letter queue d'une file. UNE seule définition : PgBossQueue.ensure()
 * l'importe pour créer la DLQ, ainsi le nom lu par /ops et le nom créé par pg-boss ne peuvent pas diverger.
 */
export function dlqName(queue: string): string {
  return `${queue}-dlq`;
}

/** Les 12 files réelles = chaque file de base + sa DLQ. Consommé par PgOpsStore.getQueueLoad (surface /ops). */
export const ALL_QUEUES: string[] = BASE_QUEUES.flatMap((q) => [q, dlqName(q)]);

/**
 * Cadence de POLLING par file, en secondes. pg-boss interroge la base toutes les 2 s par file par DÉFAUT, ce
 * qui est gratuit sur un Postgres à soi et coûteux sur un Postgres managé facturé à l'egress : mesuré le
 * 2026-08-17 sur ce projet Supabase, le polling à vide des 4 process (mba api+worker, mm-hubspot api+worker)
 * produisait 663 000 requêtes/jour et 249 Mo d'egress/jour pour 157 jobs en table, soit 7,5 Go/mois contre
 * 5 Go inclus au plan Free. L'egress d'un poll est du pur overhead : ~550 octets pour une réponse vide.
 *
 * La cadence se règle donc par file, sur la latence RÉELLEMENT utile à l'utilisateur, pas sur un défaut global :
 * - `webhook` : chemin des messages entrants (réponse auto, scénario). La latence est conversationnelle -> 2 s.
 * - `campaign-run` : l'utilisateur vient de cliquer « lancer » et regarde l'écran -> 5 s.
 * - `automation-event` : démarre un scénario sur mot-clé / tag / nouveau contact, donc chemin conversationnel -> 5 s.
 * - `analyze-conversation`, `push-analysis`, `hubspot-catchup` : traitements de fond, personne n'attend -> 30 s.
 *
 * `tests/queue-names.test.ts` garde l'invariant : toute file de `BASE_QUEUES` a une entrée ici.
 */
export const QUEUE_POLLING_SECONDS: Record<(typeof BASE_QUEUES)[number], number> = {
  webhook: 2,
  'campaign-run': 5,
  'automation-event': 5,
  'analyze-conversation': 30,
  'push-analysis': 30,
  'hubspot-catchup': 30,
};

/**
 * Cadence de polling d'une file, DLQ comprise. Une DLQ n'est travaillée par personne aujourd'hui (elle sert de
 * dépôt inspecté par /ops), donc si on venait à en consommer une, 60 s suffisent. Une file inconnue retombe sur
 * 5 s : assez lent pour ne pas ré-ouvrir la fuite d'egress, assez vif pour ne pas casser un chemin interactif
 * qu'on aurait oublié de déclarer.
 */
export function pollingSecondsFor(queue: string): number {
  // La reconnaissance d'une DLQ passe par dlqName, jamais par un `-dlq` réécrit ici : la convention garde UNE
  // seule définition (même raison que ensure() côté PgBossQueue).
  if (BASE_QUEUES.some((q) => dlqName(q) === queue)) return 60;
  return QUEUE_POLLING_SECONDS[queue as (typeof BASE_QUEUES)[number]] ?? 5;
}
