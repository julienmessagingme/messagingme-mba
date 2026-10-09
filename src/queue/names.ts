/**
 * Source unique des noms de files pg-boss (files de base, convention DLQ, cadences), pour que /ops, la création
 * des files et le worker ne divergent pas. `tests/queue-names.test.ts` garde l'invariant.
 */

/**
 * Les files travaillées par le worker. `analyze-conversation` et `push-analysis` ne sont enregistrées que si la
 * fonction est activée, mais la file existe côté /ops même désactivée : on les liste inconditionnellement.
 */
export const BASE_QUEUES = ['webhook', 'webhook-status', 'campaign-run', 'analyze-conversation', 'push-analysis', 'hubspot-catchup', 'automation-event', 'agent-turn', 'optout-poussee', 'signaux-batch', 'evenements-distribution', 'evenements-envoi'] as const;

/**
 * Le nom de la DLQ d'une file, défini une seule fois : `PgBossQueue.ensure()` l'importe pour la créer, donc le nom
 * lu par /ops et le nom créé ne peuvent pas diverger.
 */
export function dlqName(queue: string): string {
  return `${queue}-dlq`;
}

/** Chaque file de base plus sa DLQ, pour `PgOpsStore.getQueueLoad`. Le compte se dérive, il ne s'écrit pas. */
export const ALL_QUEUES: string[] = BASE_QUEUES.flatMap((q) => [q, dlqName(q)]);

/**
 * Cadence de sondage par file, en secondes. Le défaut de pg-boss (2 s par file) coûte cher sur un Postgres managé
 * facturé à l'egress : un sondage à vide est du pur surcoût. On règle donc sur la latence utile :
 * - `webhook`, `agent-turn` : un contact attend sa réponse -> 2 s.
 * - `campaign-run` (l'opérateur regarde l'écran), `automation-event` (démarrage de scénario) -> 5 s.
 * - `webhook-status` : les accusés de Meta, personne ne les attend et ils arrivent en rafale (trois par
 *   destinataire) ; sur leur propre file pour ne pas retarder les entrants -> 30 s.
 * - `analyze-conversation`, `push-analysis`, `hubspot-catchup`, `optout-poussee` (le refus est déjà écrit quand
 *   le job est enfilé), `signaux-batch` : traitements de fond -> 30 s. La promesse « dans la minute » des signaux
 *   de geste tient à leur priorité (`PRIORITE_SIGNAL`), pas à cette cadence.
 * - `evenements-distribution`, `evenements-envoi` (webhooks sortants, lot 12) : l'application d'un client réagit à un
 *   message reçu, parfois pour répondre -> 5 s, et notifiées. Les accusés n'y entrent que pour une adresse qui les a
 *   cochés (décochés par défaut), et partent en priorité basse.
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
  'optout-poussee': 30,
  'signaux-batch': 30,
  'evenements-distribution': 5,
  'evenements-envoi': 5,
};

/**
 * Files réveillées par LISTEN/NOTIFY, celles dont la latence se ressent.
 *
 * pg-boss émet un `pg_notify` dans la transaction qui insère le job et réveille le worker à l'instant ; sa boucle
 * saute alors son délai, donc une rafale se vide au rythme du traitement et non de l'horloge. La notification
 * passe le pooler Supabase en mode session (port 5432), pas en mode transaction (6543).
 * Les files de fond restent lentes exprès : réveiller les accusés à l'instant laisserait une rafale affamer la
 * réponse à un vrai client. Même règle que `QUEUE_POLLING_SECONDS` : « la latence se ressent-elle ? ».
 */
export const FILES_NOTIFIEES: Record<(typeof BASE_QUEUES)[number], boolean> = {
  webhook: true, // un contact attend sa réponse
  'agent-turn': true, // idem, c'est le même chemin conversationnel
  'campaign-run': true, // l'opérateur vient de cliquer et regarde l'écran
  'automation-event': true, // démarrage de scénario sur mot-clé / tag, chemin conversationnel
  'webhook-status': false, // accusés Meta : personne ne les attend, et les espacer protège les entrants
  'analyze-conversation': false, // traitement de fond
  'push-analysis': false, // traitement de fond
  'hubspot-catchup': false, // traitement de fond
  'optout-poussee': false, // le refus est deja ecrit ; sa diffusion peut attendre le tour d'horloge
  'signaux-batch': false, // traitement de fond, et une rafale d'accusés en produit autant : l'espacer protège la base
  'evenements-distribution': true, // l'application d'un client attend le message reçu (lot 12)
  'evenements-envoi': true, // idem, et un réessai différé n'est pris qu'à son heure (`startAfter`)
};

/**
 * Seuil de rafale : au-delà de ce nombre de jobs prêts, la file cesse d'attendre entre deux prises et se vide à
 * plein régime. Sans lui, `webhook-status` (une prise toutes les 30 s) mettrait des jours à absorber les accusés
 * d'une grosse campagne, compteurs faux pendant ce temps.
 *
 * pg-boss ne remet le délai à zéro que si la file a du retard et que la prise précédente a ramené un job : aucun
 * tour à vide, donc aucun egress ajouté au repos. La concurrence, elle, ne bouge pas : c'est elle qui protège
 * les entrants. Le compte de jobs prêts est mis en cache 60 s par pg-boss (`queueCacheIntervalSeconds`), une
 * rafale peut donc mettre une minute à s'engager.
 */
export const SEUIL_RAFALE = 20;

/**
 * Seuil de rafale par file, quand le défaut ne convient pas. Absente d'ici = `SEUIL_RAFALE`.
 *
 * L'usage ordinaire de `webhook-status` n'est pas une avalanche mais un paquet (Meta rend trois accusés par
 * message) : sous le seuil par défaut, il se viderait à un job toutes les 30 s.
 * La comparaison de pg-boss est stricte (`getReadyCount() > burstWhenReadyExceeds`) : `2` veut dire « à partir de
 * trois en attente ». Un seuil bas reste sûr grâce à la garde de pg-boss (une prise à vide coupe la rafale) :
 * l'egress au repos est inchangé, et la concurrence de 1 borne la file à une connexion du pool.
 * Les autres files de fond restent au défaut tant que leurs paquets n'ont pas été mesurés.
 */
export const SEUILS_RAFALE: Partial<Record<(typeof BASE_QUEUES)[number], number>> = {
  'webhook-status': 2,
};

/** Le seuil de rafale d'une file : le sien s'il existe, le défaut sinon. Point de passage unique. */
export function seuilRafalePour(nom: string): number {
  return SEUILS_RAFALE[nom as (typeof BASE_QUEUES)[number]] ?? SEUIL_RAFALE;
}

/**
 * Filet de sondage, en secondes, quand la notification est active.
 *
 * Dans pg-boss, chaque unité de concurrence a sa propre boucle de sondage : la cadence d'une file vaut
 * `concurrence / pollingIntervalSeconds`, et les files à forte concurrence tapaient la base à vide plusieurs fois
 * par seconde (principale cause d'egress). Ce filet ne coûte aucune latence : `worker.notify()` annule le sommeil
 * en cours. Le repli est automatique : pg-boss réévalue `isNotifyActive()` à chaque tour et retombe sur
 * `pollingIntervalSeconds` si l'écouteur meurt. ⚠️ « Aucune latence » tant qu'un réveil arrive : une notification
 * ne réveille chaque boucle que pour UNE lecture, et ce qui reste en file attend ce filet (`FILES_VIDEES_EN_CONTINU`).
 */
export const SONDAGE_FILET_NOTIFIE = 60;

/**
 * 🔴 LES FILES VIDÉES EN CONTINU : chaque message traité réveille toutes les boucles de sa file, qui relisent jusqu'à
 * ce qu'une lecture revienne vide (`PgBossQueue.work`, par `notifyWorker`, l'API publique de pg-boss).
 *
 * Sans lui, une notification ne réveille chaque boucle que pour UNE lecture (plusieurs notifications reçues pendant
 * un traitement se fondent en un seul drapeau), et une boucle qui a traité un message repart dormir son filet si rien
 * ne l'a notifiée entre-temps. Ce qui arrive plus vite que le worker ne traite restait donc en file jusqu'au filet,
 * et la rafale de pg-boss ne s'engage que sur un compte MIS EN CACHE, vieux de plusieurs dizaines de secondes. Mesuré
 * sur le banc des trente espaces le 2026-10-03 : 120 messages d'un coup, 114 au-delà de 30 s, le pire à 67 s ; avec
 * un filet de 5 s et une rafale à 1, encore 37 s. Coût : au plus une lecture à vide par boucle après le dernier
 * message d'une série. ⚠️ Pas `burstWhenBatchFull`, le vidage instantané de pg-boss : il exige des lots de deux,
 * et `batchSize: 1` est ce qui empêche une tâche en échec de faire rejouer sa voisine réussie.
 */
export const FILES_VIDEES_EN_CONTINU: readonly (typeof BASE_QUEUES)[number][] = ['webhook'];

export function videeEnContinu(queue: string): boolean {
  return (FILES_VIDEES_EN_CONTINU as readonly string[]).includes(queue);
}

/**
 * 🔴 Le délai avant de rejouer une tâche en échec d'une file vidée en continu (pg-boss le double à chaque tentative).
 * Les files sont créées sans délai (`retry_delay = 0`) : une tâche en échec est remise en file aussitôt. Une boucle
 * qui dort son filet l'étalait jusqu'ici sur plusieurs minutes ; le vidage continu la relit tout de suite, et les six
 * tentatives s'enchaîneraient en une seconde jusqu'à la file d'échec, pendant une simple panne passagère de la base
 * (relevé par la relecture du 2026-10-04). Environ 10, 20, 40, 80 puis 160 s : la fenêtre d'avant.
 */
export const DELAI_REJEU_VIDAGE_SECONDES = 10;

/**
 * Le filet d'une file où le relâcher à 60 s coûte un contact qui attend, quand le défaut ne convient pas.
 *
 * `webhook` : la ceinture du vidage continu, si un réveil se perd quand même (une tâche remise en file parce que son
 * contact avait déjà un message en cours, par exemple). Coût au repos : trois boucles (sa concurrence), une lecture à
 * vide chacune toutes les 5 s. ⚠️ `agent-turn` reste au défaut, délibérément : douze boucles, plus de
 * 200 000 lectures à vide par jour à 5 s, et ses arrivées (une par message d'une conversation tenue par un agent) ne
 * dépassent pas son débit.
 */
export const FILETS_NOTIFIES: Partial<Record<(typeof BASE_QUEUES)[number], number>> = {
  webhook: 5,
};

/**
 * 🔴 LE BATTEMENT DE CŒUR DES TÂCHES. Sans lui, une tâche dont le worker meurt (crash, mémoire, `docker kill`) reste
 * « active » jusqu'à son délai d'expiration, 15 min par défaut, avant d'être rejouée : mesuré sur le banc des trente
 * espaces le 2026-10-03, 932 s pour le message en cours. pg-boss rafraîchit le battement SEUL pendant le
 * traitement (toutes les `RAFRAICHISSEMENT_BATTEMENT_SECONDES`), et sa surveillance rejoue une tâche dont le
 * battement s'est tu depuis `BATTEMENT_SECONDES` : il reconnaît un worker MORT sans tuer une tâche LENTE, ce qu'un
 * délai d'expiration court ferait (et la rejouerait en parallèle de celle qui tourne encore).
 * ⚠️ Quatre battements manqués avant de déclarer la tâche orpheline : un battement en retard (pool de pg-boss
 * occupé) ne doit pas la faire rejouer pendant qu'elle tourne. 10 s est le minimum de pg-boss.
 */
export const BATTEMENT_SECONDES = 20;
export const RAFRAICHISSEMENT_BATTEMENT_SECONDES = 5;

/**
 * La cadence de la supervision de pg-boss (tâches expirées ou muettes, comptes des files), sur le seul worker
 * principal (`superviseLesFiles`, `src/worker/roles.ts`). Le défaut, 60 s, ajoutait jusqu'à deux minutes au
 * battement avant de rejouer une orpheline. Le MONITEUR qu'elle lance a sa propre cadence, une seconde de moins :
 * pg-boss compare strictement (`> secondes`), et à cadence égale un passage sur deux serait sauté.
 * ⚠️ Le cache des files de chaque processus (`queueCacheIntervalSeconds`) reste à son défaut de 60 s : chaque
 * rafraîchissement relit toutes les lignes de `pgboss.queue`, et le passer à 10 s sur deux workers coûtait de
 * l'ordre de 150 Mo d'egress par jour (relecture du 2026-10-04). Le vidage continu n'en dépend pas.
 */
export const SURVEILLANCE_FILES_SECONDES = 10;
export const MONITEUR_FILES_SECONDES = SURVEILLANCE_FILES_SECONDES - 1;

/**
 * Le filet d'une file, jamais plus court que sa cadence de base : pg-boss refuse au démarrage un filet plus court
 * (`assert notifyPollingInterval >= pollingInterval`), le worker planterait au boot.
 */
export function filetNotifieSecondes(queue: string): number {
  return Math.max(FILETS_NOTIFIES[queue as (typeof BASE_QUEUES)[number]] ?? SONDAGE_FILET_NOTIFIE, pollingSecondsFor(queue));
}

/**
 * Une file est-elle réveillée par notification ? Ni une DLQ (personne ne la travaille) ni une file inconnue : se
 * tromper doit coûter de la latence, jamais un réveil non voulu sur un chemin de fond.
 */
export function notifieePour(queue: string): boolean {
  if (BASE_QUEUES.some((q) => dlqName(q) === queue)) return false;
  return FILES_NOTIFIEES[queue as (typeof BASE_QUEUES)[number]] ?? false;
}

/**
 * Le seuil d'alerte de `/ops` sur la latence d'une file (p95 de l'attente et de bout en bout, sur 24 h). 30 s, le SLO
 * d'un message entrant ; mais une file LENTE PAR CONSTRUCTION (`webhook-status`, les traitements de fond, sondés toutes
 * les 30 s) attend jusqu'à une cadence avant même d'être vue, et passait au rouge en marchant comme prévu : trois
 * cadences pour elle. DÉRIVÉ de la cadence, jamais recopié : une file ajoutée reçoit le seuil de sa classe.
 */
export const SEUIL_LATENCE_SECONDES = 30;
export function seuilLatenceSecondes(queue: string): number {
  return Math.max(SEUIL_LATENCE_SECONDES, 3 * pollingSecondsFor(queue));
}

/**
 * Cadence de sondage d'une file, DLQ comprise. Une DLQ n'est qu'un dépôt inspecté par /ops -> 60 s. Une file
 * inconnue retombe sur 5 s : assez lent pour l'egress, assez vif pour un chemin interactif non déclaré.
 */
export function pollingSecondsFor(queue: string): number {
  // Une DLQ se reconnaît par `dlqName`, jamais par un `-dlq` réécrit ici.
  if (BASE_QUEUES.some((q) => dlqName(q) === queue)) return 60;
  return QUEUE_POLLING_SECONDS[queue as (typeof BASE_QUEUES)[number]] ?? 5;
}
