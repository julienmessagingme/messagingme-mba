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
export const BASE_QUEUES = ['webhook', 'webhook-status', 'campaign-run', 'analyze-conversation', 'push-analysis', 'hubspot-catchup', 'automation-event', 'agent-turn', 'optout-poussee'] as const;

/**
 * Convention de nommage de la dead-letter queue d'une file. UNE seule définition : PgBossQueue.ensure()
 * l'importe pour créer la DLQ, ainsi le nom lu par /ops et le nom créé par pg-boss ne peuvent pas diverger.
 */
export function dlqName(queue: string): string {
  return `${queue}-dlq`;
}

/**
 * Les files RÉELLES = chaque file de base PLUS sa DLQ. Consommé par PgOpsStore.getQueueLoad (surface /ops).
 *
 * ⚠️ Le compte n'est PAS écrit ici, et ce commentaire a justement dit « 14 » pendant que la constante en
 * produisait 16 : un nombre à la main devient faux au premier ajout de file, sans que rien ne le signale.
 * Un lecteur qui veut le compte le dérive de `BASE_QUEUES`, comme le fait cette ligne.
 */
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
 * - `optout-poussee` : pousse un refus vers le systeme du client. Traitement de fond lui aussi, et la
 *   demi-minute d'attente ne change rien a la conformite : ce qui compte est que le refus soit ECRIT,
 *   ce qui est deja fait quand le job est enfile -> 30 s.
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
  'optout-poussee': 30,
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
  'optout-poussee': false, // le refus est deja ecrit ; sa diffusion peut attendre le tour d'horloge
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
 * SEUIL DE RAFALE **PAR FILE**, quand le défaut ci-dessus ne convient pas. Absente d'ici = `SEUIL_RAFALE`.
 *
 * 🔴 CE QUE LE SEUIL UNIQUE RATAIT, ET CE N'EST PAS LE CAS QU'IL VISAIT. `SEUIL_RAFALE` a été calibré sur
 * l'avalanche d'une campagne (15 000 accusés) : au-delà de vingt en attente, la file se vide à plein régime,
 * et ce cas-là fonctionne. Mais l'usage ORDINAIRE de `webhook-status` n'est pas une avalanche, c'est un
 * PAQUET : Meta rend trois accusés par message (`sent`, `delivered`, `read`), donc trois à douze jobs
 * arrivent en une seconde puis plus rien. Un paquet de douze n'atteint jamais vingt, la rafale ne s'engage
 * donc JAMAIS, et il se vide à un job toutes les trente secondes, soit six minutes.
 *
 * 🔴 MESURÉ EN PRODUCTION LE 2026-09-15, pas déduit : sur 24 h, p50 d'attente à 96,8 s et pire cas à 316,6 s,
 * pour un traitement de 0,058 s. **Le retard est à 100 % de l'attente.** Et la correction ne s'invente pas
 * non plus : la rafale du 2026-09-10 à 16:06 a vidé vingt accusés en 1,2 s, soit dix-sept par seconde, avec
 * des écarts de 47 à 111 ms lisibles tels quels dans `pgboss.job`.
 *
 * ⚠️ **LA COMPARAISON EST STRICTE (`readyCount > seuil`), DONC LE NOMBRE EST CELUI D'AVANT LE DÉCLENCHEMENT.**
 * `2` veut dire « à partir de TROIS en attente », c'est-à-dire exactement les trois accusés d'un seul message.
 * Écrire `3` en pensant « dès trois » laisserait le cas le plus fréquent du produit hors rafale, sans aucun
 * symptôme visible. Lu dans la source de pg-boss (`manager.js`, `getReadyCount() > burstWhenReadyExceeds`).
 *
 * 🔴 CE QUI REND L'ABAISSEMENT SÛR N'EST PAS LE CHIFFRE, C'EST LA GARDE ANTI-BOUCLE DE pg-boss : la rafale
 * exige que la DERNIÈRE PRISE AIT RAMENÉ UN JOB (`fullBatch`). Une prise à vide la coupe et rend la cadence
 * lente. Un seuil bas ne peut donc pas faire tourner la boucle sur une file vide, quel que soit sa valeur :
 * l'egress au repos est strictement inchangé, ce qui est la seule chose que la cadence de 30 s protégeait.
 *
 * ⚠️ ET LA CONCURRENCE NE BOUGE PAS, c'est elle qui protège les entrants. Un accusé à la fois, avec des
 * requêtes enchaînées l'une après l'autre : cette file occupe au maximum UNE connexion du pool applicatif,
 * quelle que soit la taille de l'avalanche. Le plafond est dans la construction, pas dans un réglage.
 *
 * ⚠️ LES QUATRE AUTRES FILES DE FOND (`analyze-conversation`, `push-analysis`, `hubspot-catchup`,
 * `optout-poussee`) portent le MÊME piège, à la même cadence de 30 s. Elles restent au défaut délibérément :
 * personne n'a mesuré leurs paquets, et un réglage posé sans mesure est exactement ce que cette page reproche
 * au seuil unique. La mécanique est désormais par file, donc les régler sera un nombre, pas un chantier.
 */
export const SEUILS_RAFALE: Partial<Record<(typeof BASE_QUEUES)[number], number>> = {
  'webhook-status': 2,
};

/** Le seuil de rafale d'une file : le sien s'il existe, le défaut sinon. Point de passage unique. */
export function seuilRafalePour(nom: string): number {
  return SEUILS_RAFALE[nom as (typeof BASE_QUEUES)[number]] ?? SEUIL_RAFALE;
}

/**
 * FILET de sondage, en secondes, QUAND la notification est active.
 *
 * 🔴 LA CONCURRENCE EST UN MULTIPLICATEUR DE SONDAGE, ET PERSONNE NE LE SAVAIT. Dans pg-boss, chaque unité de
 * concurrence est un worker AVEC SA PROPRE boucle de sondage (`for (let i = 0; i < localConcurrency; i++)
 * worker.start()`, lu dans sa source le 2026-09-10). La cadence d'une file ne vaut donc pas
 * `1 / pollingIntervalSeconds`, elle vaut `concurrence / pollingIntervalSeconds`. Avec
 * `AGENT_TURN_CONCURRENCY = 12` et un sondage à 2 s, `agent-turn` tapait la base SIX fois par seconde,
 * 518 400 fois par jour, pour une file qui n'a traité AUCUN job en trente jours.
 *
 * MESURE DU 2026-09-10, en production, sur sept minutes : 785 555 requêtes/jour, dont 88 % de sondage à vide.
 * Le modèle `somme(concurrence / cadence)` en prédisait 786 240, soit 0,1 % d'écart. À ~400 octets par
 * sondage à vide, c'est ~300 Mo/jour, donc 9 Go/mois contre 5 Go inclus au plan Free : c'est LA cause du
 * dépassement d'egress, et elle ne se voyait dans aucun écran.
 *
 * 🔴 CE FILET NE COÛTE AUCUNE LATENCE, et c'est vérifié des deux côtés. Dans la source de pg-boss,
 * `worker.notify()` ANNULE le sommeil en cours (`this.loopDelayPromise.abort()`) : une notification réveille
 * le worker à l'instant, quelle que soit la longueur du filet. Et en production, sur 102 jobs `webhook`
 * réels, l'attente entre l'insertion et la prise vaut 37 ms en moyenne, 223 ms au pire : c'est la
 * notification qui livre, le sondage n'a jamais servi sur ce chemin.
 *
 * ⚠️ ET LE REPLI EST AUTOMATIQUE, ce que le commentaire précédent ignorait : pg-boss réévalue
 * `isNotifyActive()` À CHAQUE TOUR et retombe alors sur `pollingIntervalSeconds`. Poser le filet ÉGAL à la
 * cadence de base « pour retrouver le comportement d'hier si l'écouteur tombe » était donc inutile, et c'est
 * cette précaution mal fondée qui a coûté les deux tiers du trafic de la base. Le comportement d'hier est
 * déjà garanti par `pollingIntervalSeconds`, qui ne bouge pas.
 */
export const SONDAGE_FILET_NOTIFIE = 60;

/**
 * Le filet d'une file, jamais plus court que sa cadence de base.
 *
 * ⚠️ Le `max` n'est pas décoratif : pg-boss REFUSE au démarrage un filet plus court que la cadence de base
 * (`assert notifyPollingInterval >= pollingInterval`), donc une file de fond qu'on ralentirait un jour à
 * 120 s ferait planter le worker au boot, pas en test. Fonction PURE, testée.
 */
export function filetNotifieSecondes(queue: string): number {
  return Math.max(SONDAGE_FILET_NOTIFIE, pollingSecondsFor(queue));
}

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
