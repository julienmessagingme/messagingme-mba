# AUDIT SCALABILITÉ messagingme-mba, 2026-08-25

Cible de l'audit : 10, 20 puis 100 clients, chacun avec environ 25 utilisateurs connectés, des campagnes
de milliers de contacts, des imports simultanés et des webhooks tiers en continu. Périmètre : le code, la
structure, la dette. L'hébergement est explicitement hors sujet (la bascule est prévue et actée).

Méthode : six lecteurs spécialisés sur le dépôt (file d'attente, débit Meta, injection de contacts, base de
données, état mémoire, surface HTTP), puis contre-vérification adversariale de chaque constat rouge par un
relecteur indépendant chargé de le RÉFUTER. Huit constats ont été rétrogradés par cette contre-vérification,
dont un dont le mécanisme était faux. Les constats marqués « vérifié en propre » ont été recontrôlés à la
main, plusieurs directement sur la base de production.

Succède à `AUDIT-SCALE-2026-07-18.md`. Le statut de chacun de ses onze bloquants est en section 6.

---

## 1. Verdict

Le socle anti-double-envoi est solide et le restera. Le claim atomique par destinataire, l'idempotence des
webhooks, la pagination keyset de l'inbox, les index posés en juillet : tout ça tient à n'importe quel volume.
Ce n'est pas là qu'il faut investir.

Ce qui ne tient pas, c'est **le partage**. Le système est écrit comme si un seul client à la fois avait
quelque chose à faire. Une campagne occupe la file de toute la plateforme pendant des heures. Les messages
entrants de tous les clients passent par une file unique qui appelle Meta en synchrone. Et le mécanisme censé
garantir « un seul job par campagne » ne fonctionne pas du tout, ce qui n'était dans aucun audit précédent.

Trois choses cassent **déjà aujourd'hui**, sans attendre le dixième client : une campagne au-delà d'un
certain volume est refusée par la file et ne part jamais, un déploiement gèle une campagne en cours pour des
heures, et un message client entrant dort dans la file d'échec depuis le 17 août sans que rien ne l'ait
signalé.

Le reste casse dans la bande 10 à 25 clients, c'est-à-dire bien avant les 100 visés. L'inbox est le premier
à tomber, vers 200 utilisateurs simultanés.

Compte deux à trois semaines pour les rouges, dont une première journée qui traite à elle seule les quatre
défauts les plus graves.

---

## 2. Ce qui casse déjà, aujourd'hui

### R1. `singletonKey` ne déduplique rien, nulle part (vérifié en propre, sur la production)

**Le fait.** `PgBossQueue.ensure()` (`src/queue/pgboss.ts:113-121`) crée les files sans passer de `policy`.
pg-boss retombe alors sur `standard` (`node_modules/pg-boss/dist/manager.js:1335`). Or **tous** les index
uniques qui font la déduplication par `singleton_key` sont conditionnés à une policy qui n'est pas
`standard` : `job_i1` exige `short`, `job_i2` `singleton`, `job_i3` `stately`, `job_i6` `exclusive`, `job_i8`
`key_strict_fifo` (`node_modules/pg-boss/dist/plans.js:612-635`). L'insertion se fait en
`ON CONFLICT DO NOTHING` (`plans.js:1500`) : sans index applicable, il n'y a aucun conflit, les deux lignes
entrent.

Relevé sur la base de production, les treize files sont en `policy = standard`, et la table `pgboss.job_common`
ne porte que les index ci-dessus. **Aucun `singletonKey` de ce dépôt n'a jamais dédupliqué quoi que ce soit.**

**Ce que ça emporte.** Huit sites d'appel en production s'appuient dessus, chacun avec un commentaire qui
affirme une garantie que le code ne rend pas :

| Site | Ce que le commentaire promet |
|---|---|
| `src/http/campaigns.ts:351` | « deux POST /run concurrents n'empilent pas deux jobs » |
| `src/campaign/enqueue.ts:14` | idempotence de l'enfilement d'un run |
| `src/campaign/schedule-sweep.ts:20` | « l'enqueue est idempotent » |
| `src/worker.ts:497`, `:560` | reprise programmée et relance automatique |
| `src/http/v1-sends.ts:214` | « le RETENTER est sans risque » (3 tentatives) |
| `src/worker.ts:448` | une analyse par conversation |
| `src/worker.ts:398`, `src/index.ts:699` | un rattrapage HubSpot par tenant |

**Le dégât réel.** Aucun contact ne reçoit deux messages : le claim atomique par destinataire
(`src/campaign/store.pg.ts:761-768`) tient, et c'est la partie la plus solide du système. Mais deux runs
concurrents de la même campagne instancient **chacun leur propre limiteur de débit** en mémoire
(`src/campaign/run-job.ts:84-87`) : le débit réel double. Sur un numéro neuf en palier 250, c'est exactement
ce qui le grille. Le cas le plus atteignable est `v1-sends`, qui retente l'enfilement trois fois en se croyant
protégé.

**Correctif.** ⚠️ La policy d'une file est **immuable après création** (`manager.js:1381`) : on ne peut pas
simplement ajouter `policy` à `ensure()` sur les files existantes. Deux voies : recréer les files concernées
lors d'une fenêtre sans trafic, ou porter la déduplication dans notre code (une table de verrous, même patron
que `api_idempotency`, déjà éprouvé). En attendant, **corriger les huit commentaires** : un commentaire qui
promet une garantie inexistante est pire que pas de commentaire, il empêche le prochain lecteur de chercher.
**Effort S pour la vérité des commentaires, M pour le mécanisme.**

### R2. Une campagne au-delà d'un certain volume est refusée par la file et ne part jamais (vérifié en propre)

`campaignJobExpireSeconds` (`src/campaign/pacing.ts:36`) dimensionne le timeout du job sur le travail réel,
sans plafond. pg-boss refuse toute expiration atteignant 24 h (`attorney.js:403`). Mesuré en exécutant la
vraie validation de pg-boss sur nos vraies valeurs :

```
 5000 contacts à  5 msg/min -> 90600 s (25,2 h) -> REJET
 1000 contacts à  1 msg/min -> 90600 s (25,2 h) -> REJET
  950 contacts à  1 msg/min -> 86100 s (23,9 h) -> accepté
 5000 contacts à 30 msg/min -> 15600 s ( 4,3 h) -> accepté
```

Le seuil est à 954 contacts à 1/min, 4767 à 5/min, 28600 à 30/min. Le débit est réglable de 1 à 80 par les
deux entrées (`src/http/campaigns.ts:230`), donc un client qui baisse son débit pour ménager son numéro rend
sa campagne inlançable.

En lancement immédiat, l'enfilement lève et remonte en 500, que Cloudflare remplace par sa page d'erreur :
l'opérateur voit une erreur générique. En **programmé**, c'est pire : `runCampaignScheduleSweep`
(`src/campaign/schedule-sweep.ts:36-39`) attrape par campagne et se contente d'un `console.error`. Le balayage
lui-même réussit, donc **aucune alerte Telegram ne part**, `markRunning` n'est jamais appelé, et la campagne
reste `scheduled` à jamais, réessayée toutes les 60 secondes en silence.

**Correctif.** `Math.min(expire, 23 * 3600)` dans `campaignJobExpireSeconds`, commenté : si un run dépasse et
est rejoué, le claim atomique empêche le double envoi, au prix d'un doublement temporaire du débit pendant le
chevauchement. **Effort S.** C'est le meilleur rapport gain sur effort de tout l'audit.

### R3. Un message client dort dans la file d'échec depuis le 17 août (vérifié en propre, sur la production)

Relevé sur la base :

```
webhook-dlq | created | 2026-08-17T13:05:38Z | column "channel" of relation "conversations" does not exist
```

C'est un message entrant d'un client, perdu il y a huit jours par l'incident de migration manquante. Rien ne
consomme les files d'échec (`src/queue/names.ts:51` l'assume : dépôt inspecté par `/ops`), aucun outil de
rejeu n'existe, et **aucune alerte ne surveille leur profondeur**. Les alertes du worker couvrent les erreurs
pg-boss et les échecs de balayage, pas le remplissage d'une file d'échec.

À 100 clients, tout incident de schéma draine l'entrant de tout le parc de la même façon, et personne ne
l'apprend.

**Correctif.** Alerte sur profondeur de file d'échec supérieure à zéro, par le patron de balayage plus alerte
déjà en place (`src/worker.ts:81-89`, `PgOpsStore.getQueueLoad` et `names.ts` fournissent déjà tout). ⚠️ Pour
le rejeu, `/ops` est en lecture seule **par conception** (`src/http/ops.ts:7`) : passer par un script en ligne
de commande plutôt que casser cet invariant. **Effort S pour l'alerte, M pour le rejeu.**

### R4. Un déploiement gèle une campagne en cours pour des heures

`installGracefulShutdown` (`src/shutdown.ts:5`) force `process.exit(1)` après 10 secondes. Un run de campagne
de deux heures ne finit pas en dix secondes : le process est tué en plein envoi. Le job reste `active` et
n'est rejoué qu'à l'expiration de son propre timeout, dimensionné en heures. La campagne est donc figée après
**chaque** déploiement, sans erreur visible.

Chaque interruption consomme un des cinq rejeux. À la sixième, le job part en file d'échec que rien ne
consomme, et la campagne reste `running` pour toujours : aucun balayage ne reprend une campagne `running` avec
des destinataires en attente.

⚠️ Précision de la contre-vérification : monter le délai d'arrêt à 60 ou 120 secondes est **inopérant seul**,
car sans `stop_grace_period` dans `docker-compose.yml`, Docker envoie SIGKILL vers 10 secondes de toute façon.

**Correctif.** `stop_grace_period` dans le compose **et** délai d'arrêt aligné, plus un balayage qui détecte
une campagne `running` avec des destinataires en attente et aucun job vivant, et la ré-enfile. **Effort M.**

---

## 3. Ce qui casse entre 10 et 25 clients

### R5. Une seule campagne à la fois pour toute la plateforme

`this.boss.work(name, { batchSize: 1, ... })` (`src/queue/pgboss.ts:141`) sans `localConcurrency` ni
`groupConcurrency`. L'abstraction n'expose même pas l'option. Le worker pg-boss attend la fin du handler avant
de reprendre (`dist/worker.js`, `await this.onFetch(jobs)`), le run est une boucle séquentielle en ligne
(`src/campaign/engine.ts:195`), et il n'y a qu'un conteneur worker.

5000 contacts au débit par défaut de 30 par minute occupent le worker 2 h 47. Pendant ce temps, les campagnes
de tous les autres clients restent en file, en premier arrivé premier servi. **Le débit maximal de la
plateforme est celui d'UNE campagne**, environ 1800 messages par heure. 100 clients à 1000 messages par jour
chacun est mécaniquement impossible. Les opérateurs cliquent « lancer » et ne voient rien partir pendant des
heures, sans explication.

**Correctif.** `localConcurrency` par file et `groupConcurrency` par tenant existent nativement dans le
pg-boss installé (`dist/types.d.ts:522-538`), et se combinent avec `batchSize: 1` sans casser l'invariant
per-job que le commentaire protège. **Prérequis absolu** : le throttle par numéro partagé (voir J1), sinon la
concurrence multiplie le débit réel sur un même numéro. Le découpage de `campaign-run` en lots ré-enfilés est
la partie lourde et peut attendre. **Effort M pour la concurrence, L pour le découpage.**

### R6. Les entrants de tous les clients derrière une file unique qui appelle Meta en synchrone

Tous les webhooks Meta, messages entrants comme accusés de livraison, passent par la file `webhook`
(`src/webhooks/receiver.ts:69`) en `batchSize: 1`. Le handler fait l'avance de scénario et les automations
**en ligne** (`src/worker.ts:228-262`), donc des envois Meta synchrones (`src/workflow/wiring.ts:425`).

Deux conséquences. Un envoi en échec rejouable bloque la file environ 105 secondes (quatre tentatives). Et le
délai `Retry-After` de Meta est **dormi tel quel, sans plafond** (`src/meta/http.ts:100`, seul le backoff est
plafonné à 30 s) : un seul client à qui Meta répond `Retry-After: 3600` gèle l'entrant de tous les autres
pendant une heure, par tentative.

Par ailleurs une campagne de 5000 envois génère environ 15 000 accusés de livraison qui passent **devant** les
messages conversationnels des autres clients.

**Correctif.** Dans l'ordre : plafonner `retryAfterMs` (trois lignes, à faire tout de suite), puis sortir les
envois du job webhook, ou au minimum séparer la file des accusés de celle des messages. ⚠️ La contre-vérification
déconseille d'ajouter simplement de la concurrence sur cette file : l'avance de scénario n'est pas totalement
idempotente et paralléliser peut désordonner deux messages d'un même contact. Si concurrence, la partitionner
par contact. **Effort S pour le plafond, M pour le reste.**

### R7. L'inbox devient inutilisable vers 200 utilisateurs simultanés

Trois pollings cumulés, sans aucun SSE ni WebSocket nulle part dans le dépôt : le fil ouvert toutes les 4
secondes (`web/app/inbox/page.tsx:568`, trois requêtes SQL et jusqu'à 500 messages rechargés sans pagination),
la liste toutes les 15 secondes (`page.tsx:229`), et la pastille de non-lus toutes les 30 secondes **depuis
toutes les pages et pour tous les rôles** (`web/components/AppShell.tsx:151`).

La pastille est le pire morceau : `countUnread` (`src/inbox/store.pg.ts:330`) compte avec un `exists` corrélé
sur **toutes** les conversations du tenant, et l'index de `conversation_messages` ne porte pas `direction`
(`db/migrations/0009_inbox.sql:28`). Un client à 20 000 conversations paie environ 20 000 sondages par
comptage, répété par chacun de ses 25 utilisateurs.

J'ai mesuré la latence réelle depuis le conteneur : **11,2 ms de médiane** par aller-retour vers la base. Avec
un pool applicatif de 3 connexions, le plafond est de l'ordre de 250 requêtes par seconde. La
contre-vérification place la saturation vers 200 utilisateurs, soit moins de 10 clients. Le retry front sur
5xx (`web/lib/http.ts:57-70`) double la charge de lecture au moment exact de la saturation.

**Correctif, du moins cher au plus lourd.** (1) Relever `DB_POOL_MAX`, voir J0 ci-dessous, c'est une variable
d'environnement. (2) Micro-cache serveur par tenant, 5 à 10 secondes, sur les compteurs : les 25 utilisateurs
d'un même client se mutualisent en une requête. (3) Dénormaliser une colonne `unread` sur `conversations`,
maintenue aux deux écritures qui existent déjà. (4) Ajouter du jitter aux intervalles. **Effort S, S, M, S.**

### J0. `DB_POOL_MAX` est resté calibré pour une contrainte qui n'existe plus (vérifié en propre)

Le commentaire de `src/config.ts:88-96` raisonne sur le pooler « en SESSION mode, plafonné à ~15 clients,
PARTAGÉ avec mm-hubspot », et conclut lui-même : « Le vrai correctif est le mode TRANSACTION pour l'API, pas
un plafond plus fin. »

Ce correctif est passé. Vérifié sur la production : `APP_DATABASE_URL` est bien défini et pointe sur le port
6543, le pool applicatif est en mode transaction. Mais `DB_POOL_MAX` est resté au défaut de **3**, la valeur
calibrée pour la contrainte d'avant. Le plafond provisoire a survécu au correctif qu'il attendait, et sa
justification écrite est devenue fausse.

C'est le levier le moins cher de tout l'audit : une variable d'environnement, et c'est le plafond direct de
R7. **Effort S.** Le relever raisonnablement (10 à 15) et réécrire le commentaire.

---

## 4. Ce qui perd des données en silence

### R8. Un webhook entrant jette le contact entier sur une valeur de champ invalide, en répondant `ok:true`

Dans `upsertContactsFromApi` (`src/api/contacts-upsert.ts:76-89`), une valeur qui ne passe pas la validation
de son type interrompt le traitement **avant** l'upsert : le contact n'est pas créé du tout, téléphone et nom
perdus avec, et le scénario n'est jamais déclenché. La route répond 200 avec `ok:true`
(`src/http/webhook-entrant.ts:182-187`) : Zapier ou Make affichent l'exécution en vert.

100 % des leads de cette intégration sont perdus jusqu'à ce qu'un humain compare les volumes. La seule trace
est `last_payload`, écrasée à chaque appel. Sur 10 à 100 espaces branchés, la fraction qui vise un champ
date, c'est-à-dire le montage « rappel avant date » qui est la fonctionnalité phare, est en perte permanente.

C'est une dette déjà consignée (`todo.md`), classée « à trancher si le cas se présente vraiment ». À l'échelle
cible il se présente statistiquement. Impact réel aujourd'hui : nul, aucun vrai outil du marché n'est encore
branché. C'est la seule raison de discuter le rouge.

**Correctif.** Écriture partielle dans le chemin partagé : upserter téléphone, nom et champs valides, et
remonter les champs rejetés dans la réponse. ⚠️ À faire en deux temps : l'écriture partielle plus le retour
des champs rejetés suffit à arrêter la perte, sans migration. **Effort M.**

### R9. L'import CSV est synchrone, une requête par ligne

`importContacts` (`src/crm/import.ts:127`) fait un `await` par ligne, et tourne **en ligne dans le handler
HTTP** (`src/http/import.ts:171`), sans file. À 11,2 ms d'aller-retour mesurés, plus le travail réel de
l'upsert, un fichier de 5000 lignes prend une à deux minutes et dépasse le timeout de 100 secondes de
Cloudflare : l'opérateur voit une erreur alors que le serveur continue de travailler. Le commentaire du code
lui-même parle de contacts « souvent par milliers d'un coup » (`src/http/import.ts:24`).

⚠️ Deux corrections apportées par la contre-vérification, qui évitent de traiter le faux problème :

- **Il n'y a PAS de famine du pool.** `pool.query` rend la connexion après **chaque** requête
  (`pg-pool/index.js:448`) et la file d'attente du pool est un FIFO strict à la granularité de la requête. Un
  import n'a qu'une requête en vol et se remet en queue à chaque ligne : une requête console qui arrive
  pendant trois imports attend un aller-retour, pas huit secondes. Le mécanisme de famine que j'avais avancé
  est faux, le vrai problème est le nombre de requêtes et l'absence de file, pas un verrou long.
- **Le mur du volume tombe plus tôt et ailleurs.** Le `bodyLimit` global est de 1 Mo (`src/server.ts:189`) et
  la route d'import ne le relève pas, alors que flows, media et workflows le font. Au-delà d'environ 14 000
  lignes, c'est un 413 avec le message anglais brut de Fastify. Et ce mur tombe **au choix du fichier**, pas
  au moment de l'import, parce que l'aperçu envoie lui aussi le CSV entier pour n'en extraire que les en-têtes
  et quatre lignes.

**Correctif ordonné.** (1) Ne transmettre que les premiers kilo-octets à l'aperçu, c'est le moins cher et ça
lève le mur immédiat. (2) `bodyLimit` dédié sur la route d'import, plus un message explicite en français.
(3) Upsert par lots (`unnest`), qui divise le nombre d'allers-retours par cinquante. (4) File pg-boss pour
l'import, dont l'import HubSpot hérite gratuitement (le chemin est déjà mutualisé). **Effort S, S, M, M.**

---

## 5. Ce qui interdit le passage à deux workers

Les chemins **campagne** sont prêts : claims SQL atomiques partout, c'est du bon travail et ça se voit. Ce
sont les ajouts d'août qui ne le sont pas. La contre-vérification a rétrogradé la plupart de ces points en
jaune, parce que le compose fige une seule instance et que les files sont sérialisées : rien de tout cela ne
mord aujourd'hui. Mais c'est la liste exacte des prérequis à lever avant tout passage à l'échelle horizontale,
et deux d'entre eux mordent déjà.

### R10. Le déclencheur « avant date » peut envoyer le même rappel deux ou trois fois (mord déjà)

La déduplication vit **uniquement** dans le balayage, jamais dans le runner : `runner.ts:122` saute
volontairement l'anti-rebond pour `avant_date`, et `markFired` (`runner.ts:159`) écrase sans condition. Tant
que l'événement publié n'est pas consommé, le balayage suivant revoit le contact comme dû et republie.

La contre-vérification juge le constat **sous-estimé** : le seuil n'est pas un backlog exotique, c'est environ
douze événements dans la minute sur une file plafonnée à un job toutes les 5 secondes. Un client avec une
quinzaine de rendez-vous à la même heure fabrique lui-même son backlog. Symptôme : des rappels WhatsApp
identiques envoyés deux ou trois fois, facturés, visibles du client final, avec le risque de note de qualité
Meta qui va avec.

**Correctif.** ⚠️ Le `singletonKey` ne sert à rien (voir R1), c'est précisément là que je l'ai découvert. Le
vrai verrou est un claim conditionnel sur le marqueur d'occurrence dans le runner. ⚠️ Attention à ne pas
casser un comportement voulu au passage : `date-sweep.ts:15-22` documente que si le scénario ne démarre pas,
le tir est annulé et le balayage **republie**, ce qui est le rattrapage souhaité. **Effort S.**

### R11. L'avance d'un parcours n'est pas claimée

`advance` (`src/workflow/executor.ts:816-818`) lit le run, applique les blocs, puis `setState` fait un
`update ... where id = $1` **inconditionnel** (`src/workflow/run-store.pg.ts:118-131`). Deux messages
différents du même contact passent tous deux la déduplication (qui ne compare que le dernier `messageId`) et
avancent le run deux fois.

Le même fichier sait pourtant faire le bon claim quarante lignes plus loin (`claimDueSleeping`, `:141-172`,
`for update skip locked`).

⚠️ Aujourd'hui le chemin WhatsApp est protégé par le worker unique et sa file sérialisée. La seule course
réellement atteignable est celle du process API sur les rappels RCS (`src/index.ts:801`) pendant qu'un webhook
du même contact est traité par le worker. À deux workers, le dégât n'est pas cosmétique : message envoyé deux
fois, deux branches jouées, `current_node` écrasé en dernier écrivain gagnant, donc parcours faux sans trace.

**Correctif.** Claim atomique en tête d'`advance`, même patron que `claimDueSleeping`. ⚠️ Il ne couvre pas le
rejeu d'un ancien `wamid`, contrairement à ce que je pensais : à traiter séparément. **Effort M.**

### Les trois autres prérequis (jaunes tant qu'il n'y a qu'un worker)

- **J1. Aucun throttle par numéro** (`src/meta/factory.ts:41`, `src/meta/http.ts:107`). Le limiteur est une
  instance mémoire **par job**, et les envois inbox, scénario et automation n'en passent par aucun. C'était
  déjà le « prérequis absolu » de l'audit de juillet avant toute concurrence. Il devient rouge le jour où on
  ajoute de la concurrence, donc il doit être livré **avant** R5. **Effort M.**
- **J2. Anti-rebond des automations en check-then-act** (`src/automation/runner.ts:123` puis `:159`). Un
  `SELECT` puis un `UPSERT` inconditionnel, avec trois `await` entre les deux. ⚠️ Le claim proposé casserait
  `avant_date` s'il était appliqué tel quel : le `markFired` y a une seconde mission, écrire le marqueur
  d'occurrence. **Effort S.**
- **J3. Heartbeat sur une ligne unique** (`src/ops/heartbeat-store.pg.ts:35`). À deux workers, un mort est
  masqué par le vivant. **Effort S.**

---

## 6. Statut des onze bloquants de juillet

| Item | Statut | Preuve |
|---|---|---|
| B1 token Meta global | **Corrigé** | Résolveur par tenant avec cache 5 min, état `token_invalid`, proxy sur toutes les méthodes (`src/meta/credentials.ts`, `factory.ts`). Exception assumée : le client media du resumable upload reste sur le token global. |
| B2 budget de connexions | **Corrigé, et au-delà** | Plafonds câblés, `onError` attaché des deux côtés, pooler en mode transaction pour l'applicatif. Reste J0 : le plafond de 3 n'a pas suivi. |
| B3 mono-numéro par tenant | **Toujours ouvert** | `order by created_at limit 1` (`src/campaign/store.pg.ts:554`), aucune colonne `phone_number_id` sur `conversations`, et la migration 0058 a réaffirmé l'unicité `(tenant_id, wa_id)` pour le canal RCS. Atténué côté campagnes seulement. |
| B4 worker sérialisé | **Partiel** | Le défaut adjacent le plus urgent est corrigé (débit par défaut 30/min). La sérialisation elle-même est intacte : c'est R5. |
| B5 frontières d'appartenance | **Corrigé pour mba** | Revalidation du numéro juste avant chaque run (`run-job.ts:69-77`). |
| B6 opt-out en lecture seule | **Corrigé** | Écriture depuis la fiche, en masse, et par `wa_id` pour les scénarios. L'injection ne régresse jamais un statut, c'est délibéré et documenté. |
| B7 qualité de numéro décorative | **Partiel** | Le balayage de statut existe (toutes les 20 min, alertes sur RED, auth, déconnexion). Mais `messaging_limit_tier` n'est **jamais lu** côté campagne, et les codes de palier 24 h (130429, 131048) sont absents des jeux de classification : c'est R12 ci-dessous. |
| B8 croissance et index | **Corrigé pour l'essentiel** | Les index prioritaires et de clé étrangère sont posés (0039, 0042). Restent `webhook_events` sans purge ni `tenant_id`, et aucune rétention générale. |
| B9 observabilité | **Corrigé** | Heartbeat en base, alertes Telegram par balayage, source unique des noms de files, journalisation des 5xx, fail-fast au boot. Trou restant : le rejet 403 d'un webhook à signature invalide reste muet. |
| B10 isolation tenant | **Corrigé** | `scopeTenant` extrait en un point unique (`src/http/scope.ts`). |
| B11 rate limiting mémoire | **Partiel** | Clé par identité au lieu de l'IP, purge de la Map. Tout reste en mémoire par process, `trustProxy` toujours absent. |

**Un item écarté en juillet est à requalifier.** Le polling de l'inbox avait été classé « bruit »
(`AUDIT-SCALE-2026-07-18.md:516`). C'était juste à 30 utilisateurs. À la cible c'est le bloquant numéro un de
la surface HTTP, c'est R7.

### R12. Les paliers Meta sont inconnus du code (report de B7, vérifié en propre)

Les codes 130429 et 131048, ceux du plafond 24 h, ne sont **ni** dans `RETRYABLE_CODES` **ni** dans
`TERMINAL_CODES` (`src/meta/errors.ts:14-16`) : ils retombent sur le défaut « 4xx inconnu donc terminal ». Et
`messaging_limit_tier` est pullé, stocké, affiché, mais jamais lu côté campagne (grep : zéro usage dans
`src/campaign/`).

Un client avec un numéro neuf en palier 250 qui importe 5000 contacts et lance : les 250 premiers partent, les
suivants échouent terminalement, environ 430 avant que le garde-fou de taux d'échec ne mette en pause. Ces
destinataires ne sont **rejouables par aucune voie**, ni le balayage de relance ni le renvoi manuel. Et le
motif affiché est « taux d'échec », pas « vous avez atteint votre plafond ».

**Correctif.** Lire le palier à la création de campagne et **avertir** plutôt que refuser (le palier compte
les uniques sur 24 h, tous envois confondus, la comparaison est approximative), et classer les deux codes pour
qu'ils mettent la campagne en pause au lieu de brûler les destinataires. **Effort M.**

### R13. Une campagne lancée est instoppable (vérifié en propre)

Il n'existe **aucune route de pause** : seulement `cancel-schedule` pour une campagne pas encore partie
(`src/http/campaigns.ts:382`). Et la boucle d'envoi (`src/campaign/engine.ts:195`) ne relit jamais le statut de
la campagne, donc écrire `paused` en base ne l'arrêterait pas.

Une erreur de ciblage sur 5000 destinataires part jusqu'au bout. C'est le genre d'incident qui coûte un client
et une note de qualité Meta.

**Correctif.** Route de pause plus relecture périodique du statut dans la boucle, noyée dans le N+1 qui existe
déjà pour le quality gate. La reprise après pause existe **déjà** côté store : la route complète un mécanisme
à moitié câblé. **Effort S.**

---

## 7. Les jaunes, groupés

Aucun ne casse, tous dégradent. Ils sont classés par ce qu'ils coûtent.

**Index et requêtes qui se dégradent avec le volume**
- `reclaimStale` fait un seq scan de `campaign_recipients` toutes les 5 minutes (`src/campaign/store.pg.ts:779`). Index partiel sur `(claimed_at) where status = 'sending'`, minuscule par construction. **S**
- La résolution `wa_id` vers contact utilise un `regexp_replace` non indexable, sur le chemin le plus chaud du produit (`src/crm/contact-store.pg.ts:44`). Aucun index d'expression dans les 83 migrations. **S**
- Le funnel de campagne fait un `NOT EXISTS` corrélé sur une colonne sans index (`src/stats/store.pg.ts:103`). **S**
- Les filtres contacts par téléphone et par champ perso scannent le tenant (`contact-store.pg.ts:796`). **S**
- La liste des campagnes recalcule les compteurs sur **tous** les destinataires de **toutes** les campagnes du tenant à chaque affichage (`campaign/store.pg.ts:325`). **M**
- Le dashboard recalcule tous les agrégats sur les tables brutes, sans pré-agrégat (`src/stats/store.pg.ts:123`). **M**
- Le balayage « avant date » scanne les contacts avec comparaison de plage sur `fields->>key` toutes les 60 secondes (`src/automation/store.pg.ts:197`). Passer la cadence à 5 minutes coûte trois caractères et la tolérance est de 60 minutes. **S puis M**

**Croissance non bornée**
- `webhook_events` stocke le payload complet, sans `tenant_id`, sans index de date, sans **aucune** purge (`db/migrations/0001_init.sql:64`). L'effacement RGPD y est structurellement impossible puisque le discriminant de tenant n'est pas stocké. Le patron de purge existe déjà à côté (`worker.ts:657`). **M**
- Aucune rétention générale : conversations, messages, événements de blocs, runs terminés, journal d'audit, clics tracés. **M**
- Le runner de migrations interdit `CREATE INDEX CONCURRENTLY` (`db/migrate.ts:47`), donc le premier index sur une grosse table bloquera les écritures pendant sa construction, en plein déploiement. Une directive `-- migrate: no-transaction` par fichier suffit. **S**

**Files et balayages**
- `retry-sweep` enfile sans `expireInSeconds` (`src/worker.ts:560`), donc 15 minutes par défaut et rejeu parallèle au-delà de 450 destinataires. **S**
- Le balayage de statut des numéros est plafonné à 200 par `order by created_at` : les numéros suivants ne sont **jamais** surveillés (`src/ops/store.pg.ts:160`). Trier par ancienneté de rafraîchissement donne un tourniquet naturel. **S**
- Un seul des quatorze balayages a une garde de ré-entrance (`src/worker.ts:518`). **S**
- La file `automation-event` a le même défaut que la file webhook, en plus petit. **M**

**Surface HTTP**
- Le fil ouvert retélécharge jusqu'à 500 messages toutes les 4 secondes, sans delta (`src/http/inbox.ts:195`). Un paramètre `?after=` suffit, le front garde déjà la référence. **M**
- Chaque requête traverse deux process Node (rewrite Next puis Fastify) (`web/next.config.mjs:19`). **M**
- L'upload media passe en base64 dans du JSON, jusqu'à 65 Mo en vol par vidéo (`src/http/media.ts:21`). **M**
- Un webhook Meta rejeté pour signature invalide est totalement muet (`src/webhooks/receiver.ts:66`) : la panne 100 % entrants reste indiagnosticable. **S**
- Aucun `AbortController` dans tout `web/` : les requêtes d'une page quittée continuent. **S**
- Le rate limit du webhook entrant se prend **après** la requête SQL (`src/http/webhook-entrant.ts:105`). Le code est déjà validé par regex avant, il suffit de cler dessus. **S**
- `/v1/contacts/batch` traite 500 contacts en 500 allers-retours, et le plafond compte des requêtes, pas des lignes (`src/api/contacts-upsert.ts:57`). **M**
- La création de campagne sans liste explicite charge tous les contacts du tenant en mémoire (`src/campaign/create.ts:24`). **M**
- Tous les rate limits sont des Map en mémoire par process (`src/auth/rate-limit.ts:6`). **M**

---

## 8. Ce qui est solide, et où ne pas investir

Cette liste compte autant que les autres : elle dit où **ne pas** perdre de temps.

- **L'anti-double-envoi de campagne.** Claim atomique `pending` vers `sending` avant l'appel Meta, succès
  persisté hors du catch, seule fenêtre de re-envoi documentée et assumée. Tient les rejeux et les runs
  concurrents à n'importe quel volume. C'est la partie la plus solide du système.
- **Le balayage de réveil des parcours.** Claim par bail en une requête avec `for update skip locked`, bail
  dimensionné sur le pire lot, garde de ré-entrance, clôture des dormants. C'est le patron à recopier partout
  ailleurs.
- **L'upsert de contact.** Un seul `INSERT ON CONFLICT` ciblant l'index unique partiel, en autocommit. Deux
  imports simultanés du même tenant ne produisent ni deadlock ni doublon. L'opt-in ne régresse jamais, les
  tags s'unionnent, les champs se mergent clé par clé. Rien à fortifier ici.
- **Une seule écriture partagée par les cinq portes d'entrée** (import, API, webhook, HubSpot, fiche). Aucune
  divergence possible, et c'est ce qui rend les correctifs de la section 4 mutualisables.
- **L'anti N+1 côté Meta.** Liste des templates cachée 5 minutes, carousel et média d'en-tête lus une fois par
  run, visuel retéléversé une fois puis caché 7 jours. Une campagne de 5000 ne réuploade pas 5000 fois.
- **L'hygiène pg-boss.** `onError` attaché des deux côtés, `supervise:false` côté API, cadence de polling par
  file depuis une source unique testée. La fuite d'egress mesurée en août est fermée par construction.
- **La pagination keyset de l'inbox** et les index de statuts de livraison : O(page) et idempotents quel que
  soit le volume.
- **La résolution de token par tenant** avec cache, invalidation sur erreur d'auth et état `token_invalid` qui
  met la campagne en pause avec un motif lisible.
- **Le front ne rejoue jamais un POST** : le retry est limité aux GET. Aucun double import automatique.

---

## 9. Plan d'action ordonné

### Jour 1, quatre correctifs, environ une journée

Ils traitent les quatre défauts les plus graves et sont tous petits.

1. **Plafonner l'expiration du job de campagne** à 23 h (R2). Une ligne. Débloque les campagnes aujourd'hui
   inlançables.
2. **Plafonner `retryAfterMs`** (R6). Trois lignes. Supprime le mode d'échec où un client gèle l'entrant de
   tous les autres.
3. **Alerter sur la profondeur des files d'échec** (R3), et rejouer à la main le message du 17 août.
4. **Relever `DB_POOL_MAX`** et réécrire son commentaire périmé (J0). Une variable d'environnement.

### Semaine 1, avant le prochain client

5. **Corriger les huit commentaires qui mentent sur `singletonKey`** (R1), et décider du mécanisme de
   remplacement.
6. **Route de pause de campagne** plus relecture du statut dans la boucle (R13).
7. **Claim conditionnel sur le marqueur « avant date »** (R10). Ce sont des rappels envoyés en double, chez de
   vrais clients.
8. **Aperçu d'import tronqué**, `bodyLimit` dédié et message explicite (R9, points 1 et 2).
9. **`stop_grace_period` et balayage de reprise de campagne** (R4).

### Semaine 2 et 3, avant de dépasser la dizaine de clients

10. **Throttle par numéro, partagé et en base** (J1). C'est le prérequis, il passe avant la concurrence.
11. **Concurrence par file et par tenant** sur `campaign-run` (R5), une fois 10 livré.
12. **Sortir les envois du job webhook**, ou séparer les accusés des messages (R6).
13. **Micro-cache des compteurs et colonne `unread` dénormalisée** (R7).
14. **Écriture partielle sur le webhook entrant** (R8).
15. **Lire le palier Meta et classer les codes de plafond** (R12).
16. **Upsert par lots et file d'import** (R9, points 3 et 4).

### Ensuite, et seulement ensuite

Le lot « prêt pour deux workers » (R11, J2, J3), la purge de `webhook_events` et la rétention, les index de la
section 7, le découpage de `campaign-run` en lots.

---

## 10. Ce que je n'ai pas pu vérifier

- **Aucune mesure sous charge réelle.** La production est minuscule : 251 lignes dans la plus grosse table.
  Tous les seuils de cet audit sont calculés à partir du code et de latences mesurées à vide, pas observés.
  Les ordres de grandeur sont fiables, les chiffres exacts ne le sont pas.
- **Le comportement réel de Meta sur les paliers** n'a jamais été observé sur un numéro qui les atteint.
- **Le découpage exact des seuils de R7** dépend du coût réel de `countUnread` sur un gros tenant, qui n'existe
  pas encore. La fourchette 200 utilisateurs vient de la contre-vérification, pas d'une mesure.
- **Je n'ai pas testé empiriquement le double enfilement** avec le même `singletonKey` (R1) : la preuve est
  documentaire (index en production plus source pg-boss), et elle est concluante, mais un test aurait écrit
  dans la file de production.
