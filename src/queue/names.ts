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
export const BASE_QUEUES = ['webhook', 'webhook-status', 'campaign-run', 'analyze-conversation', 'push-analysis', 'hubspot-catchup', 'automation-event', 'agent-turn'] as const;

/**
 * Convention de nommage de la dead-letter queue d'une file. UNE seule définition : PgBossQueue.ensure()
 * l'importe pour créer la DLQ, ainsi le nom lu par /ops et le nom créé par pg-boss ne peuvent pas diverger.
 */
export function dlqName(queue: string): string {
  return `${queue}-dlq`;
}

/** Les 14 files réelles = chaque file de base + sa DLQ. Consommé par PgOpsStore.getQueueLoad (surface /ops). */
export const ALL_QUEUES: string[] = BASE_QUEUES.flatMap((q) => [q, dlqName(q)]);

/**
 * Cadence de POLLING par file, en secondes. pg-boss interroge la base toutes les 2 s par file par DÉFAUT, ce
 * qui est gratuit sur un Postgres à soi et coûteux sur un Postgres managé facturé à l'egress : mesuré le
 * 2026-08-17 sur ce projet Supabase, le polling à vide des 4 process (mba api+worker, mm-hubspot api+worker)
 * produisait 663 000 requêtes/jour et 249 Mo d'egress/jour pour 157 jobs en table, soit 7,5 Go/mois contre
 * 5 Go inclus au plan Free. L'egress d'un poll est du pur overhead : ~550 octets pour une réponse vide.
 *
 * La cadence se règle donc par file, sur la latence RÉELLEMENT utile à l'utilisateur, pas sur un défaut global :
 * - `webhook` : chemin des messages ENTRANTS (réponse auto, scénario). La latence est conversationnelle -> 2 s.
 * - `webhook-status` : les ACCUSÉS de livraison de Meta (sent/delivered/read). Personne ne les attend, et ils
 *   arrivent par rafales : une campagne de 5 000 messages en produit trois par destinataire. Ils vivaient sur
 *   la MÊME file que les entrants, donc une rafale d'accusés retardait la réponse à un vrai client (lot 6).
 *   30 s : c'est du traitement de fond, et les espacer réduit d'autant l'egress de la rafale.
 * - `agent-turn` : un tour d'agent IA (appel LLM plus outils) répond à un message du contact, donc même
 *   chemin conversationnel que `webhook` -> 2 s.
 * - `campaign-run` : l'utilisateur vient de cliquer « lancer » et regarde l'écran -> 5 s.
 * - `automation-event` : démarre un scénario sur mot-clé / tag / nouveau contact, donc chemin conversationnel -> 5 s.
 * - `analyze-conversation`, `push-analysis`, `hubspot-catchup` : traitements de fond, personne n'attend -> 30 s.
 *
 * `tests/queue-names.test.ts` garde l'invariant : toute file de `BASE_QUEUES` a une entrée ici.
 */
export const QUEUE_POLLING_SECONDS: Record<(typeof BASE_QUEUES)[number], number> = {
  webhook: 2,
  'webhook-status': 30,
  'campaign-run': 5,
  'automation-event': 5,
  'analyze-conversation': 30,
  'push-analysis': 30,
  'hubspot-catchup': 30,
  'agent-turn': 2,
};

/**
 * Files RÉVEILLÉES par LISTEN/NOTIFY, c'est-à-dire celles dont la latence se RESSENT.
 *
 * Ce que ça change. pg-boss 12.25 sait émettre un `pg_notify` DANS LA MÊME TRANSACTION que l'insertion du job
 * et réveiller le worker à l'instant, au lieu de le laisser dormir jusqu'à son prochain sondage. Le plafond
 * de débit des entrants mesuré le 2026-09-02 (1,5 message/s, soit `concurrence / cadence de sondage`) vient
 * précisément de ce sommeil : la boucle du worker SAUTE son délai quand une notification est arrivée pendant
 * qu'il travaillait, donc une rafale se vide au rythme du traitement, plus à celui de l'horloge.
 *
 * ✅ Vérifié le 2026-09-02, pas supposé : la notification passe le pooler Supabase en mode SESSION (port 5432),
 * session tenue (même pid backend avant/après), reçue en moins de 50 ms. Elle ne passerait PAS en mode
 * transaction (port 6543), que ce projet n'utilise pas pour pg-boss.
 *
 * ⚠️ Ce n'est délibérément PAS « toutes les files ». Les files de FOND restent lentes EXPRÈS : une campagne de
 * 5 000 messages produit trois accusés de livraison par destinataire, et les espacer est exactement ce qui
 * empêche une rafale d'accusés d'affamer la réponse à un vrai client (lot 6). Les réveiller à l'instant
 * re-créerait le problème que cette cadence a fermé. La règle est donc « la latence se ressent-elle ? », la
 * même que celle de `QUEUE_POLLING_SECONDS`, et pas « peut-on aller plus vite ».
 *
 * `tests/queue-names.test.ts` garde l'invariant : toute file de `BASE_QUEUES` est classée ici.
 */
export const FILES_NOTIFIEES: Record<(typeof BASE_QUEUES)[number], boolean> = {
  webhook: true, // un contact attend sa réponse
  'agent-turn': true, // idem, c'est le même chemin conversationnel
  'campaign-run': true, // l'opérateur vient de cliquer et regarde l'écran
  'automation-event': true, // démarrage de scénario sur mot-clé / tag, chemin conversationnel
  'webhook-status': false, // accusés Meta : personne ne les attend, et les espacer PROTÈGE les entrants
  'analyze-conversation': false, // traitement de fond
  'push-analysis': false, // traitement de fond
  'hubspot-catchup': false, // traitement de fond
};

/**
 * SEUIL DE RAFALE : au-delà de ce nombre de jobs prêts, la file cesse d'attendre entre deux prises et se vide
 * à plein régime. Constat A4 de l'audit externe du 2026-09-02, mesuré en PRODUCTION le 2026-09-03.
 *
 * 🔴 CE QU'ON A MESURÉ, ET QUI N'ÉTAIT PAS UNE HYPOTHÈSE. `webhook-status` sonde toutes les 30 s, prend UN
 * job par sondage (`batchSize: 1`, concurrence 1) et le traite en 0,05 s. Débit réel : DEUX jobs par minute,
 * lisible tel quel dans `pgboss.job` (deux prises par minute, minute après minute, de 18:05 à 18:11 le
 * 2026-09-02). Or une campagne de 5 000 destinataires produit environ 15 000 accusés de livraison : à deux
 * par minute, il faut CENT VINGT-CINQ HEURES pour les absorber. Les compteurs de la campagne resteraient
 * faux pendant des jours, et le client verrait « 5 000 envoyés, 12 délivrés ».
 *
 * La cadence lente était un bon choix pour le REPOS (l'egress d'un sondage à vide est du pur gaspillage, cf.
 * `QUEUE_POLLING_SECONDS`). Elle était un mauvais choix pour la RAFALE, et c'est exactement ce que ce
 * réglage sépare : pg-boss remet le délai à zéro tant que la file a du retard ET que la prise précédente a
 * ramené quelque chose. Dès qu'elle se vide, une prise revient bredouille et le sondage lent reprend. Aucun
 * tour à vide, donc aucun egress ajouté au repos.
 *
 * ⚠️ La concurrence, elle, ne bouge PAS. C'est elle qui protège les entrants (un seul accusé traité à la
 * fois), pas la cadence. Rendre une rafale rapide n'autorise pas à en traiter deux ensemble.
 *
 * ⚠️ Le compte de jobs prêts que pg-boss consulte est mis en cache et rafraîchi toutes les 60 s (lu dans sa
 * source, `queueCacheIntervalSeconds`), donc une rafale peut mettre jusqu'à une minute à s'engager. Sans
 * conséquence sur une file de fond, et c'est ce décalage qui justifie un seuil bas plutôt que zéro.
 */
export const SEUIL_RAFALE = 20;

/**
 * Une file est-elle réveillée par notification ? Une DLQ ne l'est jamais (personne ne la travaille), et une
 * file inconnue non plus : le défaut est « sondage seul », c'est-à-dire le comportement d'avant. Se tromper
 * ici doit coûter de la latence, jamais un réveil non voulu sur un chemin de fond.
 */
export function notifieePour(queue: string): boolean {
  if (BASE_QUEUES.some((q) => dlqName(q) === queue)) return false;
  return FILES_NOTIFIEES[queue as (typeof BASE_QUEUES)[number]] ?? false;
}

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
