# AUDIT messagingme-mba + mm-hubspot

## 1. VERDICT EN CINQ LIGNES

Non, pas en l'état. Le code est de bonne qualité (TypeScript strict, injection de dépendances réelle, zéro TODO, zéro `any`, idempotence correcte sur les webhooks), mais il est câblé pour **un tenant et un numéro**, et trois choses l'empêchent mécaniquement d'en accueillir trente.

Un : tous les envois Meta passent par `config.META_ACCESS_TOKEN`, un token global unique, alors que le token business de chaque client est déjà chiffré et stocké en base et n'est **jamais relu** (`decryptSecret` a zéro appelant en production). La promesse "chaque client connecte son numéro" n'est pas implémentée, elle est simulée.

Deux : le budget de connexions Postgres de mba n'est borné nulle part (pool applicatif et deux instances pg-boss aux défauts, soit jusqu'à 42 sessions) face à un pooler Supabase en mode session plafonné à 15, déjà partagé avec mm-hubspot. C'est la cause du bug "internal error" que tu vois aujourd'hui, avec un seul client.

Trois : un seul process worker traite un job à la fois pour toutes les files et tous les clients, et le numéro expéditeur est résolu par `order by created_at limit 1`. Deux numéros chez un même client suffisent à casser l'inbox.

Rien de tout ça n'est irréparable. Compte deux à trois semaines de travail sérieux avant d'ouvrir à des clients payants.

---

## 2. LES BLOQUANTS DU SCALE

Regroupés par cause racine, classés par gravité. Chacun vérifié dans le code.

---

### B1. Le multi-tenant Meta n'est pas câblé (rouge)

**Ce qui casse :** tous les appels Meta, sans exception, utilisent un token unique d'environnement. 12 sites de construction de client Meta, vérifiés par grep :

```
src/index.ts:72,74,75,76,127,142,146
src/worker.ts:79,111,177,195,221
```
tous avec `token: config.META_ACCESS_TOKEN`.

En face, `src/account/es-store.pg.ts:49` (`saveCredentials`) écrit bien le token business chiffré du client à l'Embedded Signup. Et `decryptSecret` (`src/crypto/secretbox.ts:23`) n'a **aucun appelant dans src/ ni web/** : le chemin de lecture n'existe pas. Le chiffrement AES-GCM au repos ne protège rien puisque le secret réellement utilisé vit en clair dans une variable d'environnement.

**À partir de combien de clients :** dès le deuxième, si le token global n'est pas partagé sur son WABA. Le commentaire de `src/meta/embedded-signup.ts:57` dit lui-même "le token global ne voit PAS les WABA clients". Même si le System User du BM partenaire y a accès via l'Embedded Signup (cas probable), tu as alors deux problèmes : point de défaillance unique (l'expiration du token coupe les 30 clients d'un coup, envois, templates, flows, statut de numéro, pricing) et une fuite de cette seule variable donne le droit d'envoyer des WhatsApp depuis les 30 numéros clients.

**Mode d'échec le plus vicieux :** sur le chemin workflow, `src/worker.ts:79` appelle `tplClient.list(waba)` avec le token global. Sur un WABA client cet appel renvoie vide, `templateVarInfo` retourne null, et `worker.ts:135-140` fait un `console.error` puis `return`. L'envoi est **sauté en silence**, sans même marquer le destinataire en `failed`.

**Correctif :** introduire `resolveMetaCredentials(tenantId)` qui remonte `phone_number_id -> waba -> waba_credentials`, déchiffre, et met en cache TTL court. Remplacer les 12 sites par une fabrique `metaClientFor(tenantId, phoneNumberId)` injectée. Repli sur `META_ACCESS_TOKEN` uniquement pour les WABA du portfolio MM. Attention : `exchangeCode` (`src/meta/embedded-signup.ts:38-44`) renvoie le token brut sans échange en token longue durée, il faut traiter l'expiration et la révocation, sinon tu remplaces une panne globale par 30 pannes individuelles. Ajouter un état `token_invalid` par tenant qui coupe les envois au lieu de les faire échouer un par un.

**Effort :** L (une semaine).

---

### B2. Budget de connexions Postgres non borné (rouge)

**Ce qui casse :** `src/db/pool.ts:6` est un `new Pool({ connectionString, ssl: pgSsl() })` nu. Ni `max` (défaut pg = 10), ni `connectionTimeoutMillis` (défaut = attente **illimitée**). Les deux instances pg-boss (`src/index.ts:50` et `src/worker.ts:45`) sont construites sans le troisième argument, alors que `PgBossQueue` (`src/queue/pgboss.ts:15`) accepte explicitement `opts.max` et ne le propage que s'il est fourni. pg-boss retombe donc sur son défaut de 10, plus une connexion pinnée pour LISTEN/NOTIFY.

Budget théorique mba : 2 process x (10 + 10 + 1) = **42 sessions**, face aux 15 du pooler Supabase en mode session, partagé avec mm-hubspot.

mm-hubspot, lui, a compris la contrainte et l'a codée : `DB_POOL_MAX` à 2, `PGBOSS_MAX` à 2, `DB_CONN_TIMEOUT_MS` à 8000 (`mm-hubspot/src/config.ts:22-28`), avec le commentaire "Budget du pooler Supabase partagé => max reste bas". Le service prudent se fait affamer par le service imprudent.

**À partir de combien de clients :** **déjà aujourd'hui avec un seul.** `DEPLOY.md:87-97` documente l'EMAXCONNSESSION au redéploiement et le présente comme "normal, s'auto-résout". Ce n'est pas normal, c'est le symptôme. Et un défaut aggravant y est signalé : "pg-boss émet un event error non capté (Timekeeper.onCron) qui tue le process". Aucun `boss.on('error')` n'existe dans src/, et `private readonly boss: PgBoss` n'est pas exposé par la classe, donc on ne peut même pas en attacher un depuis l'extérieur.

Effet différentiel qui explique les symptômes : pg-boss se pose lui-même un `connectionTimeoutMillis` de 10 s, donc le worker crie. Le pool applicatif, lui, attend indéfiniment, donc l'API se fige sans erreur exploitable.

**Correctif :** ajouter `DB_POOL_MAX`, `PGBOSS_MAX`, `DB_CONN_TIMEOUT_MS` au zod de `src/config.ts`, les câbler dans `pool.ts` et dans les **deux** `new PgBossQueue`. Exposer un `onError(cb)` sur `PgBossQueue` et l'attacher, sinon une saturation ponctuelle continuera de tuer le process. Réécrire la section `DEPLOY.md:87` qui rationalise le symptôme. Note : `opts.max ? ...` en `pgboss.ts:21` ignorerait silencieusement `max: 0`.

**Effort :** S (une demi-journée). C'est le meilleur rapport gain/effort de tout l'audit.

---

### B3. Un seul numéro par tenant, câblé en dur (rouge)

**Ce qui casse :** `getTenantPhoneNumberId` (`src/campaign/store.pg.ts:312`) fait `select id from phone_numbers where tenant_id = $1 order by created_at limit 1`. Cinq chemins d'envoi l'utilisent sans aucun override possible : `src/http/inbox.ts:93` (réponse), `src/http/inbox.ts:132` (template depuis l'inbox), `src/worker.ts:105`, `:171`, `:189` (template, message rapide, flow de workflow).

Pire, la table `conversations` (`db/migrations/0009_inbox.sql`, vérifié, 31 lignes) n'a **aucune colonne `phone_number_id`** et porte `unique (tenant_id, wa_id)`. Un client qui écrit au numéro 2 crée donc la même ligne de conversation que s'il écrivait au numéro 1, et l'agent qui répond répond depuis le numéro 1.

La cause est en amont : `src/webhooks/inbound.ts:167` fait `store.phoneNumberTenant(m.phoneNumberId)`, ce qui réduit le numéro destinataire à un tenant et **jette l'information nécessaire au routage correct**.

**À partir de combien de clients :** aucun rapport avec le nombre de tenants. **Un seul client avec deux numéros** (SAV + commercial) suffit. Résultat : Meta refuse le texte libre en 131047 (pas de fenêtre 24 h ouverte sur le numéro 1), ou pire il passe et le client reçoit une réponse depuis un numéro avec lequel il n'a jamais parlé.

Un chemin fait déjà les choses correctement et prouve que le repo sait comment : `src/http/v1-sends.ts:119-128` accepte un `phoneNumberId` explicite validé par `phoneNumberBelongsToTenant`, avec repli.

**Correctif :** ajouter `phone_number_id` sur `conversations` (renseigné par le webhook depuis `metadata.phone_number_id`), passer l'unicité à `(tenant_id, phone_number_id, wa_id)`, ajouter `phone_number_id` sur `workflow_runs`. Faire répondre l'inbox depuis le numéro de la conversation. Remplacer `order by created_at` par une colonne `is_default` explicite sur `phone_numbers`.

**Effort :** L. Il y a une migration de données à prévoir sur l'unicité.

---

### B4. Le worker est strictement sérialisé (rouge)

**Ce qui casse :** `src/queue/pgboss.ts:72` fait `this.boss.work(name, { batchSize: 1 }, ...)` sans aucune option de concurrence, et `docker-compose.yml:14` déclare un seul conteneur `mba-worker` sans replicas. Le job `campaign-run` est monolithique : `src/campaign/engine.ts:98` charge tous les pending puis boucle inline avec `rateLimiter.acquire()`.

**À partir de combien de clients :** dès le deuxième client qui lance une campagne en même temps qu'un autre. Tenant A avec 5000 destinataires à 10/min occupe le worker pendant environ 500 minutes. Les campagnes des 29 autres restent en file `created`. Le `ratePerMinute` censé être **par campagne** (`src/campaign/run-job.ts:55-58`) devient de facto un **débit global de la plateforme**.

Précision : contrairement à ce que je craignais, l'inbox ne gèle pas (les files `webhook` et `campaign-run` sont des workers pg-boss distincts, et l'attente du rate limiter est un `setTimeout` asynchrone). Mais le blocage inter-tenants des campagnes est réel et total.

Un défaut adjacent, plus grave sur le court terme : `deps.rateLimiter` n'est pas câblé dans le worker (`src/worker.ts:228-249`), donc la branche de repli de `run-job.ts:58` vaut toujours `undefined`. Une campagne dont `ratePerMinute` est `null` (valeur acceptée par `src/http/campaigns.ts:103-109`) s'exécute **aujourd'hui, sans aucune limitation de débit**, en boucle à pleine vitesse.

**Correctif :** pg-boss 12 n'a plus de `teamSize`. Les options sont `localConcurrency` (nombre de workers par file et par node) et surtout `groupConcurrency` / `localGroupConcurrency`, qui donnent exactement un plafond par groupe, donc un fair-share par tenant. Il faut aussi découper `campaign-run` en jobs par lot de destinataires ré-enfilés, sinon même avec `localConcurrency=N` on plafonne à N campagnes simultanées. En le faisant : recalculer `campaignJobExpireSeconds` (`src/campaign/pacing.ts`) et revoir le `singletonKey: campaignId` qui interdit aujourd'hui deux jobs pour la même campagne.

**Prérequis absolu :** le limiteur de débit est instancié **par job, en mémoire du process** (`src/meta/http.ts:107`, un simple `nextAllowed` d'instance). Les limites Meta sont **par numéro**. Dès qu'on ajoute de la concurrence ou une réplique, deux campagnes sur le même numéro à 10/min donnent 20/min et grillent un numéro neuf en palier 250/24h. Il faut déplacer le throttle au niveau du numéro et le rendre distribué (advisory lock par `phone_number_id`, ou token bucket en base) **avant** d'augmenter la concurrence.

**Effort :** L pour l'ensemble, S pour câbler d'abord le rate limiter manquant.

---

### B5. Trois frontières d'appartenance non gardées (rouge)

Trois bugs distincts, une même cause : le système fait confiance à un identifiant qu'il ne devrait pas.

**a) L'Embedded Signup réaffecte silencieusement un numéro.** `src/account/es-store.pg.ts:23-24` et `:32-34` (vérifié) font `on conflict (id) do update set tenant_id = excluded.tenant_id`, sans condition. `phone_numbers.id` et `waba.id` sont les ids Meta, clés primaires **globales**. Le commentaire de tête assume la réaffectation ("démo : le même numéro passe d'un workspace à un autre") : c'est un choix conçu pour un tenant unique, jamais réévalué.

La route est protégée contre le hijack malveillant (`src/http/embedded-signup.ts:76-77`, `verifyWaba` puis `getPhone`, bloquants). Le vecteur est **accidentel** et courant à 30 clients : une agence, un ancien prestataire, un salarié qui a gardé l'accès au Business Manager, un client qui refait son onboarding. Conséquence : split-brain silencieux. Le tenant A voit son inbox s'arrêter net sans erreur, le tenant B reçoit dans son inbox des messages de clients qui ne sont pas les siens, `saveCredentials` réaffecte aussi le token donc A perd l'envoi, et aucune trace n'est écrite (`deps.link` appelé sans log à `embedded-signup.ts:85`).

Aggravant : `campaigns.phone_number_id` est un `text not null` **sans foreign key** (`db/migrations/0003_campaigns.sql:6`), la propriété n'est vérifiée qu'à la création (`src/http/campaigns.ts:142`), et `campaignRunJob` relit la campagne via `getCampaign(id)` **sans tenantId** (`src/campaign/store.pg.ts:97`). Campagne programmée lundi, numéro réaffecté mardi, envois mercredi depuis le mauvais espace.

**Correctif :** `on conflict (id) do update ... where phone_numbers.tenant_id = excluded.tenant_id`, 0 ligne affectée renvoie un 409 explicite. Chemin d'admin séparé pour la migration voulue. Revalider l'appartenance dans `campaignRunJob` avant le premier envoi. FK sur `campaigns.phone_number_id`. **Effort S.**

**b) `/oauth/install` accepte un tenantId mba arbitraire sans authentification.** Vérifié : `mm-hubspot/src/oauth/routes.ts:29-41`, le paramètre `?tenant=` est validé sur son charset puis directement signé dans le state. Le state signé empêche de falsifier le tenant **au callback**, mais c'est nous qui mintons le state depuis une query publique.

Un tiers qui connaît le tenantId d'un client (UUID visible dans les URL de la console, une capture d'écran, un ticket support) appelle `/oauth/install?tenant=<UUID_victime>`, termine l'OAuth sur **son** portail, et `linkTenant` (ligne 70) écrit le mapping. La garde anti-hijack lignes 58-62 ne se déclenche que si le tenant est **déjà** lié : sur un client qui n'a pas encore branché HubSpot, elle ne fait rien.

Trois conséquences, dont deux immédiates. Déni d'onboarding : la victime ne peut plus jamais connecter son vrai portail en self-serve, elle prend un 409 à chaque tentative, déblocage par SQL manuel. Injection inverse : `src/service/route.ts:44` résout le portail par le même mapping, donc `/service/lists` sert à la victime **les listes de contacts du portail de l'attaquant**, qu'elle importe et à qui elle envoie des campagnes WhatsApp depuis son propre numéro vérifié. Exfiltration : conditionnée à ce que la victime active elle-même le toggle de synchronisation, ce que le hijack rend crédible puisque sa console affiche "HubSpot connecté".

**Correctif :** faire générer le lien d'install par mba sur une route JWT (`GET /tenants/:tenantId/hubspot/install-url`) qui renvoie un jeton court signé par le secret partagé, et n'accepter que ce jeton, vérifié et consommé au callback. **Effort M.**

**c) `POST /card/action` a une garde cross-portail conditionnelle.** `mm-hubspot/src/actions/route.ts:37` ne compare `portalId` à `ctx.hubId` que `if (typeof q.portalId === 'string')`, et `getContext` (`src/actions/store.pg.ts:38`) résout le portail depuis la seule conversation, sans filtre `hub_id`. Deux façons de sauter la garde : l'omettre, ou la **dupliquer** (`?portalId=A&portalId=B` que Fastify parse en tableau, donc `typeof` échoue). `GET /card/context` (`src/card/route.ts:26`) fait bien de `hubId` une ancre obligatoire : les deux routes ne suivent pas la même règle, c'est une incohérence et non un choix. `getContext` prend d'ailleurs `res.rows[0]` sans `order by`, donc un tenant avec deux portails (bac à sable + prod, fréquent) obtient un hub_id non déterministe sans aucun attaquant impliqué.

**Correctif :** pousser le filtre dans le SQL (`and tp.hub_id = $2`, null sinon) et exiger `portalId` en 400 s'il est absent ou non-string. Supprimer le fallback bearer `CARD_SECRET` (`src/card/auth.ts:70`), secret unique partagé par tous les portails, que le CLAUDE.md dit retiré alors qu'il ne tient qu'à une variable d'environnement. **Effort S.**

---

### B6. L'opt-out n'existe qu'en lecture (rouge, conformité)

**Ce qui casse :** vérifié par grep et lecture de `src/crm/contact-store.pg.ts`. L'upsert (lignes 55-58) fait `opt_in_status = case when excluded.opt_in_status = 'opted_in' then 'opted_in' else contacts.opt_in_status end` : **promotion uniquement**. `markOptedIn` (ligne 122) : promotion uniquement, et son commentaire assume explicitement de gagner sur un `opted_out` antérieur. `src/api/contacts-upsert.ts:81` ne sait produire que `opted_in` ou `unknown`. Les occurrences dans `src/http/import.ts:45` et `contact-store.pg.ts:284` sont des **filtres de recherche**, pas des écritures.

Il n'existe donc **aucun chemin pour désinscrire un contact existant**. `src/webhooks/inbound.ts` ne connaît ni STOP ni DESABONNER. `src/http/contacts.ts` n'expose aucune route de mise à jour du consentement. Le front affiche pourtant déjà un badge rouge "opt-out" (`web/app/contacts/page.tsx:115`) et un filtre : le contrat visuel promet une fonctionnalité absente.

**À partir de combien de clients :** dès le premier volume marketing réel. Un destinataire répond STOP, l'agent le voit dans l'inbox, et rien ne peut le sortir de la base. La campagne suivante le recible, il bloque le numéro côté WhatsApp, ce qui dégrade le quality rating du client, lequel n'est de toute façon plus rafraîchi (voir B7). Trou de conformité direct sur la politique commerce Meta et sur le RGPD.

**Correctif :** trois écritures symétriques. Route PATCH scopée tenant sur la fiche contact et depuis l'inbox. `optOut` accepté par l'API v1. Détection de mots-clés dans `processInbound` appelant une `markOptedOut` symétrique de `markOptedIn`.

**Effort :** M.

---

### B7. Les garde-fous de qualité de numéro sont décoratifs (rouge à trente numéros)

**Ce qui casse :** `quality_rating` n'est écrit que par `saveStatus` (`src/account/store.pg.ts:47`), appelé depuis **une seule route HTTP**, `src/http/account.ts:149`, c'est-à-dire quand un humain **admin** ouvre la page d'accueil (la route est montée avec `requireAdmin`, `src/server.ts:196`). Aucun sweeper du worker, aucun webhook : `src/webhooks/parse.ts` ne connaît que `messages`, `statuses`, `standby`, `messaging_handovers`.

Un tenant dont les utilisateurs sont tous en rôle `agent` ne déclenche **jamais** le pull, même en se connectant quotidiennement. Le gate de campagne (`src/campaign/engine.ts:103`) lit donc une valeur figée à `UNKNOWN` (défaut de `db/migrations/0004_phone_quality.sql:5`), qui passe le gate puisque `guardrails.ts:31` ne pause que sur `RED`.

Second volet : `messaging_limit_tier` est pullé, stocké et affiché ("TIER_250" vers "250 clients / 24 h") mais n'est lu **ni** à la création de campagne, **ni** au dimensionnement du débit, **ni** dans la boucle d'envoi. À 30 numéros neufs issus de l'Embedded Signup, la majorité démarre à 250 conversations/24h. Un client qui importe 5000 contacts consomme silencieusement une centaine de destinataires en `failed` **non rejouables** (l'erreur de plafond n'est ni dans `RETRYABLE_CODES` ni dans `TERMINAL_CODES`, `src/meta/errors.ts:14-16`, donc `classify` retombe sur `false`) avant que la campagne ne se mette en pause avec un message générique sur le taux d'échec.

**Atténuation honnête :** le gate de taux d'échec (`guardrails.ts:33-38`) reste actif et finit par pauser. Le système n'est pas sans filet, il est sans **diagnostic**.

**Correctif :** sweeper worker qui pull `GET /{phone_number_id}` pour tous les numéros toutes les 15 min, persiste, et alerte sur toute transition vers RED ou vers un statut différent de CONNECTED, plus sur `authError: true` que `PullResult` distingue déjà (`src/account/pull.ts:26`). Lire `messaging_limit_tier` à la création de campagne et refuser ou avertir explicitement quand le nombre de destinataires dépasse le palier. Faire aussi lire le `status` du numéro par `qualityGate`, pas seulement le rating.

**Effort :** M.

---

### B8. Croissance non bornée et index manquants (rouge sur le RGPD, jaune sur la perf)

Trois problèmes distincts sur la même table de fond.

**a) `webhook_events` est une bombe.** `db/migrations/0001_init.sql:65`, vérifié : pas de `tenant_id`, pas d'index sur `received_at`, jamais purgée (le seul `delete from` de purge du repo concerne `api_idempotency`). Chaque événement Meta y est inséré avec son payload. Et `src/webhooks/handler.ts:35` fait `await store.insertEvent(...)` **sans exploiter le booléen retourné**, alors que `store.ts:11-12` le documente comme "true si nouveau" : la table est purement write-only, elle ne protège rien.

Le point RGPD est pire que "difficile" : `src/webhooks/parse.ts:65-98` ne stocke pas l'enveloppe Meta mais l'objet événement unitaire, donc `value.metadata.phone_number_id`, **unique discriminant de tenant dans un webhook Meta**, n'est jamais stocké. Il est structurellement impossible de répondre à une demande d'effacement. Les données personnelles, elles, y sont bien (`recipient_id`, `from`, corps du message).

Ironie : `mm-hubspot/db/migrations/0001_init.sql:18-22` (`ingested_events`) est exactement le design maigre qu'il faut. Le même auteur a construit la version saine dans un repo et l'obèse dans l'autre.

**b) Aucune rétention nulle part.** Vérifié : mba n'expose **aucune route de suppression de contact**. Les `app.delete` existants couvrent api-keys, user-fields, flows, tags, templates, users, workflows. Aucune suppression d'une personne physique n'est possible, même manuellement via l'API. Conversations, messages et analyses LLM sont conservés indéfiniment, avec une copie dans le schéma `mmhs` et un envoi à un LLM tiers. À 30 clients tu es sous-traitant : la première demande d'effacement ou le premier audit DPO d'un grand compte se paie en plusieurs jours de dev en urgence.

**c) Index manquants.** Vérifié dans `0001_init.sql` : les deux seuls index portant `tenant_id` sur `contacts` sont **partiels** (`where phone_e164 is not null`, `where bsuid is not null`). Un prédicat `where tenant_id = $1` seul ne les implique pas. Le chemin le plus chaud du produit (page Contacts, build de campagne, baseline du dashboard) fait donc un seq scan complet de la table tous tenants confondus. À 600 000 lignes ce n'est pas un timeout, c'est quelques centaines de millisecondes, mais avec un pooler à 15 sessions, une requête qui passe de 5 ms à 500 ms retient sa connexion cent fois plus longtemps : l'épuisement du pool arrive avant que la lenteur ne devienne visible.

Même diagnostic sur `conversation_messages`, qui n'a ni `tenant_id` ni index sur `created_at` seul, alors que `src/stats/store.pg.ts:107`, `:128` et `:169` filtrent par tenant et par plage de dates, et que `src/ops/store.pg.ts:96` fait `where m.created_at >= now() - N jours`.

**Correctif, par ordre d'utilité :**
1. `create index concurrently on contacts (tenant_id, created_at desc)` et `create index concurrently on conversation_messages (created_at)`. Deux index, dix minutes, gain immédiat. **Effort S.**
2. Décider ce que sert `webhook_events`. Si c'est l'idempotence : ne garder que `(dedup_key, received_at)` sans payload, index sur `received_at`, purge à 7 jours dans le sweeper existant, et **exploiter enfin le booléen de retour**. Si c'est un journal d'audit : `tenant_id` plus partitionnement mensuel. **Effort M.**
3. Rétention configurable par tenant, sweeper de purge, et routine d'effacement par `phone_e164` qui purge les deux schémas. **Effort M.**
4. Dénormaliser `tenant_id` sur `conversation_messages` (attention, `recordOutbound`, `src/inbox/store.pg.ts:187`, ne reçoit pas le tenantId, il faut changer sa signature). **Effort M.**

**Index FK manquants, à faire au passage (effort S) :** `conversation_messages.sender_user_id` (le commentaire de `src/user/store.pg.ts:220` affirme faussement qu'aucune FK ne référence `users`, c'est faux depuis la migration 0017), `waba.tenant_id`, `phone_numbers.tenant_id`, `phone_numbers.waba_id`, `campaigns.tenant_id`, `campaigns.workflow_id`, `campaign_recipients.contact_id`, `workflow_runs.workflow_id`, `workflow_runs.contact_id`.

---

### B9. Zéro observabilité, zéro alerte (rouge opérationnel)

Ce n'est pas un bug, c'est ce qui fait que tous les autres restent invisibles.

**Les deux Fastify tournent avec `logger: false`** (`mba/src/server.ts:124`, `mm-hubspot/src/server.ts:29`) et leur `setErrorHandler` renvoie `Internal Server Error` **sans jamais logger l'exception**. Toute erreur non anticipée sur une route HTTP (erreur SQL, pool saturé, bug de sérialisation) produit un 500 sans stack, sans méthode, sans URL, sans tenant, nulle part. C'est déjà le cas aujourd'hui : SSH sur le VPS ne restitue pas une trace jamais émise. Railway ne crée pas le problème, il supprime seulement les moyens d'inspection annexes.

**Le worker, seul composant qui envoie les messages, n'a aucun signal de vie.** Pas d'endpoint, pas de healthcheck compose, pas de heartbeat en base. `restart: unless-stopped` fait boucler un worker qui crashe au boot pendant que l'API répond 200 sur `/health` et que la console s'affiche normalement. Il existe un signal indirect (`/ops/overview` montre le backlog des files) mais c'est du pull, personne n'est notifié, et `QUEUE_NAMES` (`src/ops/store.pg.ts:39`) ne couvre que 4 files sur 8 : `analyze-conversation`, `push-analysis` et leurs DLQ sont invisibles.

**Un webhook Meta rejeté pour signature invalide est totalement muet** (`src/webhooks/receiver.ts:66-68`). Le déclencheur le plus probable n'est pas une rotation côté Meta mais un déploiement avec `META_APP_SECRET` vide : `src/config.ts:5` lui donne `.default('')`, aucune garde au boot, et `src/lib/signature.ts` commence par `if (!secret || !header) return false`. Le service démarre, `/health` répond ok, et 100 % des webhooks partent en 403 indéfiniment sans une trace.

**Un webhook entrant dont le `phone_number_id` est inconnu est jeté en silence** (`src/webhooks/inbound.ts:168`, `if (!tenantId) continue`). Or l'abonnement est posé au niveau du **WABA** (`src/meta/embedded-signup.ts:73-78`), pas du numéro, alors que l'Embedded Signup n'insère qu'**une** ligne `phone_numbers`. Un client qui ajoute un second numéro dans son WhatsApp Manager perd tous ses messages, sans log, sans compteur, sans ligne en base. Le client jure qu'il a reçu des messages et tu n'as littéralement rien pour le prouver ou l'infirmer.

**La seule alerte du système** est `ops/mba-eligibility-watch.mjs`, un script cron autonome codé pour un unique numéro, dont `sendTelegram` lit ses credentials uniquement depuis un fichier JSON sur disque, sans fallback d'environnement.

**Correctif, ordonné :**
1. Logger l'erreur avant de la masquer dans les deux `setErrorHandler` (stack, méthode, URL, tenant), et activer un logger pino JSON sur stdout. **Effort S.** C'est le prérequis à tout le reste.
2. Fail-fast sur `META_APP_SECRET` vide et sur `DATABASE_URL` vide (aujourd'hui la seule variable structurante sans garde dans les deux superRefine). **Effort S.**
3. Logger et compter les rejets de signature et les webhooks orphelins, les exposer dans `/ops`. **Effort S.**
4. Heartbeat du worker en base écrit par le sweeper, exposé dans `/ops`, plus alerte Telegram (le module existe, il faut l'extraire du script). Compléter `QUEUE_NAMES` à partir de la même source que le worker. **Effort M.**
5. `/health` qui fait un `select 1` avec timeout court et renvoie 503 sinon, avec un `/live` trivial séparé. Sans ça, le healthcheck Railway ne détectera que le crash total, cas déjà couvert par le fait que le process ne bind pas s'il n'a pas de base. **Effort S.**

---

### B10. Aucun filet sous l'isolation tenant (rouge structurel)

**Ce qui casse :** vérifié, `grep -riE "row level security|create policy" db/migrations/` renvoie **zéro** dans les deux repos. Le rôle applicatif est le `postgres.<ref>` du pooler, qui porte `BYPASSRLS` de toute façon. La seule barrière entre le client A et le client B est qu'un développeur seul n'oublie jamais un `and tenant_id = $n` dans les 200 appels `query(` des 25 stores.

À la décharge du code : il **existe** une barrière route. `scopeTenant` compare le `:tenantId` d'URL au JWT et rend 403 sur désaccord, et en production `requireAuth` est toujours construit. Le vol de tenant par l'URL est donc bloqué. Mais cette fonction est copiée **octet pour octet dans 19 fichiers** de `src/http/` (account, api-keys, campaigns, contacts, embedded-signup, fields, flows, hubspot-import, import, inbox, me, media, settings, stats, support, tags, templates, users, workflows). La fonction la plus critique de l'application n'a pas de propriétaire, pas de test transverse, et son repli `return authTenant ?? tenantId` fait confiance à l'URL quand `req.auth` est absent.

Le trou latent réel n'est pas celui qu'on croit : le garde-fou de `src/server.ts:118-122`, qui refuse de démarrer sans auth, a une **liste incomplète**. Il omet inbox, stats, settings, media, tags et fields. Un `buildServer({ inbox, stats })` sans auth démarre sans erreur, `guard` vaut `{}`, et le repli sur l'URL s'active : lecture non authentifiée de l'inbox de n'importe quel tenant.

**Correctif :**
1. Extraire `scopeTenant` dans `src/auth/tenant-scope.ts`, remplacer le repli par `if (!req.auth) return null`, et rendre la condition du throw de `server.ts:118` exhaustive par construction. **Effort M.**
2. Test paramétré qui boucle sur toutes les routes `/tenants/:tenantId` enregistrées et vérifie un 403 avec un JWT d'un autre tenant. **Effort S.**
3. Test qui parcourt tous les `src/**/*.pg.ts` et échoue si une requête touche une table tenant-scopée sans le mot `tenant_id`. Ce test attraperait `getMessages`, qui est le seul cas résiduel réel. **Effort S.**
4. RLS : voir la recommandation tranchée en section 4.

---

### B11. Rate limiting en mémoire de process, sur une IP qui n'existe pas (rouge à la bascule)

**Ce qui casse :** deux défauts qui se composent.

D'abord, mba n'active pas `trustProxy` (`src/server.ts:124`) alors que mm-hubspot le fait (`src/server.ts:29`). Or c'est mba qui utilise `req.ip` pour limiter le débit, dans les six limiteurs d'authentification de `src/auth/routes.ts:60-65`. Et le mécanisme est plus dur qu'il n'y paraît : le navigateur n'atteint jamais l'API directement, il passe par `/api/backend/*` que Next relaie vers `mba-api:8095` (`web/next.config.mjs:18`). Il y a deux sauts, et `req.ip` est l'IP du conteneur `mba-web`, c'est-à-dire une **constante unique pour 100 % du trafic navigateur, déjà aujourd'hui**. Le plafond de 10 logins/minute est global à la plateforme. Un seul poste émettant 10 POST `/auth/login` par minute bloque la connexion de tous les tenants, indéfiniment, sans authentification. `forgot-password` est à 5/minute pour la plateforme entière.

Ensuite, tous ces compteurs vivent dans une `Map` en mémoire (`src/auth/rate-limit.ts:6`, dont le commentaire assume explicitement le mono-process). Avec N répliques Railway, chaque plafond est multiplié par N. Pour `/v1` c'est une protection du pooler qui saute ; pour `/auth/login` c'est une protection anti-brute-force qui se divise silencieusement.

**Attention au correctif évident :** `trustProxy: true` seul est **dangereux**. proxy-addr prend l'entrée la plus à gauche de `X-Forwarded-For`, contrôlée par le client : un attaquant y met une valeur aléatoire par requête et contourne intégralement la limite, ce qui est pire que l'état actuel. Cette réserve vaut aussi pour mm-hubspot, qui est donc moins correct que l'asymétrie ne le suggère.

**Correctif :** vérifier d'abord que le rewrite Next propage `X-Forwarded-For`, puis fixer `trustProxy` à un nombre de sauts ou au sous-réseau Docker (jamais `true`), et cler le login sur `(IP, email normalisé)`. Sortir le compteur en base (table de buckets, même pattern que `api_idempotency`) avant d'activer plus d'une réplique. Noter aussi que la `Map` n'évince jamais les entrées expirées, ce qui devient une fuite mémoire dès que la clé sera une vraie IP.

**Effort :** M.

---

## 3. VERDICT RAILWAY

**Non, pas prêt.** Mais les blocages sont peu nombreux et bien identifiés. Les deux services sont fondamentalement portables : pas d'écriture disque, `PORT` lu depuis l'environnement, SIGTERM géré, sweepers sûrs en multi-réplique grâce à des claims SQL atomiques (`markScheduledRunning` avec garde `and status='scheduled'`, `singletonKey` sur les enqueues, `reclaimStale` idempotent). Ce n'est pas la portabilité qui pose problème, ce sont quatre couplages non explicites et un budget de connexions qui explose.

### Sinon ça ne démarre pas, ou ça démarre cassé

1. **Bind IPv4 seul.** `messagingme-mba/src/index.ts:369` et `mm-hubspot/src/index.ts:52` font `app.listen({ host: '0.0.0.0' })`. Le réseau privé Railway (`*.railway.internal`) est IPv6 uniquement. Les appels mba vers mm-hubspot (`HUBSPOT_SERVICE_URL`, `CONNECTOR_PUSH_URL`) échoueront en ECONNREFUSED dès la bascule. Passer à `'::'` (dual-stack), idéalement configurable. **Un caractère par fichier.**

2. **Budget de connexions.** Voir B2. 3 répliques d'API x 21 sessions = 63, plus le worker, contre 15 au pooler. Le dépassement est certain au premier boot, pas seulement sous charge. Et le rolling replace de Railway garde l'ancien réplica vivant pendant que le nouveau boote, donc la fenêtre de chevauchement est plus longue qu'un `docker compose up -d`. **Bloquant absolu.**

3. **`BACKEND_URL` figé au build du front.** `web/next.config.mjs:18` compile le rewrite dans trois artefacts (`routes-manifest.json`, `standalone/server.js`, `required-server-files.json`), et la sortie standalone n'embarque pas `next.config.mjs` du tout : aucune relecture d'env n'est possible au démarrage. Pire, `docker-compose.yml:30` déclare `BACKEND_URL` sous `environment:` (runtime) et non sous `build.args:` : cette ligne est un **no-op complet** aujourd'hui, ça ne marche que parce que la valeur par défaut de l'ARG est identique. Elle documente un mécanisme faux. Symptôme à la bascule si mal fait : le front charge (la page de login est statique) et seules les requêtes API tombent, ce qui ressemble à un problème d'authentification. **Corriger le compose maintenant, et sur Railway déclarer `BACKEND_URL` en variable de BUILD, ou remplacer le rewrite par un route handler Next lisant `process.env` au runtime.**

4. **`npm start` n'a jamais fonctionné dans aucun des deux repos.** `package.json:11` pointe sur `dist/index.js` alors que `tsconfig.json:14` fixe `rootDir: "."` avec `include: ["src","tests"]`, donc tsc émet dans `dist/src/index.js`. Et même au bon chemin, avec `"type": "module"` et `moduleResolution: "Bundler"`, Node refuse les imports sans extension (vérifié : ERR_MODULE_NOT_FOUND). La prod tourne exclusivement sur `npx tsx` via le Dockerfile. Railway préférera le Dockerfile racine, donc ce n'est pas un crash garanti, mais **le jour où quelqu'un crée un service sans le réutiliser, ça ne démarre jamais**. Soit un `railway.json` avec `builder: DOCKERFILE` pour verrouiller le chemin, soit supprimer le script mort, soit le rendre réel.

5. **`DATABASE_URL` n'a pas de fail-fast.** `.default('')` dans les deux configs, absent des deux superRefine, alors que six secrets en ont un. Le service crashe au boot sur ECONNREFUSED localhost:5432 avec une stack pg opaque au lieu d'un message nommant la variable. Sur quatre services le jour J, c'est du temps de diagnostic pur. **Effort S.**

### Sinon ça marche mal

6. **`/service/*` perd sa seule garde réseau.** Aujourd'hui fermé au public par un `advanced_config` NPM (`location ^~ /service/ { return 404; }`). Sur Railway ce blocage disparaît. La signature HMAC ne couvre que le corps : pas d'horodatage, pas de nonce, pas de liaison au chemin. Un corps signé capturé est rejouable indéfiniment, et la même signature vaut pour les deux routes `/service/*`. L'exploitation exige la capture préalable d'un corps déjà signé, donc ce n'est pas une porte ouverte, mais **le blocage réseau ne doit jamais être la seule garde d'un endpoint qui va devenir public**. Ajouter `x-mm-timestamp` inclus dans le HMAC, rejeter au-delà de 5 minutes, inclure méthode et chemin dans la chaîne signée. `src/card/auth.ts` fournit déjà le patron à recopier. `/ingest` est protégé de fait par la dédup sur `eventId`, mais mérite le même traitement.

7. **Rate limiting en mémoire.** Voir B11. À traiter avant d'activer la deuxième réplique, sinon les plafonds annoncés aux clients et la protection anti-brute-force deviennent faux d'un facteur N, sans qu'aucun test ni log ne le signale. Effet secondaire vicieux : les en-têtes `x-ratelimit-remaining` (`src/auth/api-key.ts:35-36`) deviennent non monotones entre deux requêtes selon la réplique atteinte, ce qui casse tout client implémentant un backoff dessus.

8. **Migrations sans verrou.** `db/migrate.ts` lit l'ensemble des migrations appliquées puis boucle, sans `pg_advisory_lock`. Sur Railway, la façon standard est une release command exécutée à chaque déploiement : si `mba-api` et `mba-worker` sont deux services avec la même release command, les deux runners démarrent en parallèle, le second se prend un conflit de clé primaire, rollback, exit 1, et Railway marque le déploiement en échec alors que la migration est passée. Le seul DDL non idempotent des 43 migrations est `0034_campaign_schedule.sql:5` (`add column scheduled_at`) : le risque de blocage réel est limité, celui de faux échec de déploiement ne l'est pas. Encadrer par un advisory lock (clé différente par repo suffit, les schémas sont disjoints), sortir en code 0 si le verrou est pris, et **désigner un seul service porteur**.

9. **`tsx` est une devDependency et la prod tourne dessus** (`package.json:35` / Dockerfile:14 des deux repos). Aujourd'hui inoffensif (le Dockerfile ne déclare pas d'ARG et Railway n'élaguera pas tout seul), mais l'image de prod embarque vitest, typescript et les @types, et chaque démarrage transpile tout le code. Le risque devient réel si quelqu'un ajoute `ENV NODE_ENV=production` ou `--omit=dev`. Déplacer `tsx` en dependencies, ou réparer le chemin compilé.

10. **`DB_SSL_INSECURE=true` est recommandé dans `.env.prod.example:21`**, ce qui donne `{ rejectUnauthorized: false }` : chiffré mais sans vérification de certificat, donc aucune protection MITM sur du trafic qui transporte tokens Meta, tokens HubSpot déchiffrés, numéros et contenus de conversations. **Attention, le correctif évident casse la prod** : le commentaire du fichier qui dit que le pooler AWS a un certificat public est **périmé et faux**, `todo.md:167-172` documente le test réel ("la vérif complète échoue, chaîne self-signed du pooler Supabase"). Le bon correctif est le cas 1 de `pgSsl()` : télécharger la CA Supabase, la monter dans les conteneurs (secret de fichier côté Railway), poser `DB_SSL_CA_FILE`, **puis** retirer `DB_SSL_INSECURE`. Et réécrire le commentaire trompeur.

11. **Aucune procédure de sauvegarde ni de restauration** n'existe dans les deux repos (grep `pg_dump|backup|restore|PITR` sur tous les .md : rien). 43 migrations à plat, aucun `*.down.sql`, aucun `migrate:down`. Le point de récupération dépend entièrement du plan Supabase, non documenté. La bascule Railway est le bon moment pour écrire et **tester une fois** la procédure, avec le RPO/RTO réel.

**Point non négociable côté mm-hubspot :** `hubspot-app/src/app/app-hsmeta.json:10` fige `mm-hubspot.messagingme.app` dans le redirect OAuth, l'allowlist fetch, et une troisième fois dans `AnalyseCard.jsx:15`. Ces valeurs vivent dans l'app HubSpot, poussée à la main par `hs project upload`, sans CI et sans remote GitHub, avec `"distribution": "marketplace"` donc cycle de version. **Conserver `mm-hubspot.messagingme.app` en CNAME devant Railway**, ne jamais adopter une URL `*.railway.app`. Sinon le callback OAuth casse pour toute nouvelle installation et la carte des portails déjà installés tombe en erreur `permittedUrls`, non rattrapable par un rollback d'infra.

---

## 4. SUPABASE

**État actuel.** Le schéma est propre dans la forme : `timestamptz` partout, `CHECK` plutôt que des enums figés, migrations additives et idempotentes, commentées, clé d'idempotence sur chaque chemin webhook. Les stores sont pour l'immense majorité correctement scopés tenant : je n'ai trouvé aucune requête applicative qui oublie franchement le `tenant_id`. La séparation mba (`public` + `pgboss`) / mm-hubspot (`mmhs` + `pgboss_mmhs`, avec `search_path` forcé dès la connexion) est bien faite.

Les écarts réels ont été traités en B8 et B10. Voici les quatre décisions tranchées.

### RLS : oui, mais pas tout de suite, et pas comme filet principal

Activer RLS aujourd'hui coûte cher (rôle applicatif dédié sans `BYPASSRLS`, `set local app.tenant_id` dans un wrapper de pool, policies sur toutes les tables portant `tenant_id` **plus les tables filles par jointure**, `conversation_messages` et `campaign_recipients` en tête, ce qui suppose d'abord la dénormalisation de `tenant_id`) et n'attrape aucun bug existant, puisque je n'ai pas trouvé de requête sans filtre.

**Fais d'abord les deux mesures qui attrapent le même risque pour 5 % du coût :** le test paramétré sur toutes les routes `/tenants/:tenantId` avec un JWT étranger, et le test statique qui échoue si un `.pg.ts` touche une table tenant-scopée sans le mot `tenant_id`. Ces deux tests attrapent exactement la classe de bug que RLS protégerait, et ils tournent en CI.

**Puis active RLS quand tu embauches.** Le jour où un deuxième développeur écrit du SQL, la discipline manuelle cesse d'être une garantie. C'est le déclencheur, pas le nombre de clients. Quand tu le feras : rôle `mba_app` **sans BYPASSRLS** (le rôle `postgres` de Supabase n'est déjà pas superuser, il porte l'attribut `BYPASSRLS`, la nuance compte pour la commande à écrire).

### Pooler : mode transaction pour l'API, mode session uniquement pour pg-boss

C'est la bonne architecture et c'est ce qui débloque Railway. Le mode session est nécessaire uniquement à pg-boss (LISTEN/NOTIFY). L'API mba ne fait que des `pool.query()` autonomes, sans transaction longue ni état de session : elle n'a rien à faire sur un pooler plafonné à 15.

**Mais ne fais pas la bascule à l'aveugle.** mm-hubspot s'appuie sur `options=-c search_path=mmhs,public` appliqué au démarrage de connexion (`src/db/pool.ts:17`), et ce type d'état de session doit être testé en mode transaction avant d'être recommandé. Pour mba, qui n'utilise pas de `search_path` custom, la bascule est sûre.

**Ordre :** (1) borner les quatre pools tout de suite, ça règle 90 % du problème pour une demi-journée ; (2) migrer `DATABASE_URL` de l'API mba en mode transaction (port 6543) après test ; (3) garder le mode session pour la seule connexion pg-boss du worker.

### Un projet ou plusieurs : un seul, mais dédié

Ne sépare pas mba et mm-hubspot en deux projets. Les schémas dédiés font déjà le travail d'isolation, et deux projets t'obligeraient à gérer deux jeux de sauvegardes, deux poolers, deux jeux de credentials, pour zéro gain. Le couplage entre les deux services est déjà propre (HTTP signé HMAC, pas de jointure cross-schéma).

**En revanche, sors du plan actuel avant d'ouvrir.** Un plafond de 15 sessions partagées entre deux services multi-process n'est pas un plan de production, c'est un plan de pilote. Un projet Supabase dédié avec un pooler correctement dimensionné, ou pgbouncer en mode transaction, devient obligatoire avant le dixième client. Le coût est marginal comparé au premier incident.

**Effet de bord à connaître :** projet unique veut dire qu'un point-in-time recovery restaure les **deux** schémas, y compris celui qui n'avait pas de problème. C'est acceptable, mais ça doit être écrit dans la procédure de restauration.

### Rétention : par tenant, configurable, avec `webhook_events` en priorité absolue

Trois niveaux, dans cet ordre.

`webhook_events` d'abord, parce que c'est la seule table dont la croissance est proportionnelle au **volume de messages** (Meta envoie 3 à 4 événements par message sortant) et qui ne sert à rien. Réduis-la au strict nécessaire pour l'idempotence : `(dedup_key, received_at)`, index sur `received_at`, purge à 7 jours dans le sweeper existant, et **exploite enfin le booléen que `insertEvent` retourne déjà**. Si tu veux garder un journal d'audit, alors partitionne par mois : détacher une partition est instantané, un `DELETE` massif sur des dizaines de millions de lignes tiendra une connexion d'un pool à 15 places pendant des minutes.

Puis conversations, messages et analyses : colonne de rétention sur `tenants` (défaut 24 mois, ajustable par contrat), sweeper de purge, et surtout une **routine d'effacement par contact** qui purge les deux schémas en une transaction. Sans ça tu ne peux pas honorer une demande d'effacement, et à 30 clients dont chacun est responsable de traitement, c'est une question de quand, pas de si.

Enfin `ingested_events` côté mm-hubspot : le design est déjà bon, il lui manque juste un index sur `received_at` et une purge. `action_log` n'a pas besoin de purge, il est borné par `unique (conversation_id, action)`.

---

## 5. STRUCTURE DU CODE ET DETTE

### Est-ce que la structure tient

**Le squelette tient, le câblage non.**

Ce qui est bon, et objectivement au-dessus de la moyenne pour un développeur seul : injection de dépendances appliquée avec rigueur (un seul import de store dans les 23 fichiers de routes, vérifié par grep), TypeScript strict avec `noUncheckedIndexedAccess` des deux côtés, zéro `.js` égaré, zéro `as any` dans web, 84 fichiers de tests pour 883 tests, aucun module orphelin, aucune dépendance inutilisée dans les trois `package.json`, zéro TODO, zéro `ts-ignore`, zéro catch vide. Les commentaires expliquent le **pourquoi** et non le quoi, ce qui est rare.

Ce qui ne tient pas se ramène à trois choses.

**Le multi-tenant est câblé à moitié.** Le modèle de données accepte N numéros par tenant et N tokens par WABA, l'interface expose un sélecteur de numéro, et le chemin d'exécution ignore les deux. C'est la forme la plus coûteuse de dette : elle donne l'illusion que la fonctionnalité existe.

**Les invariants critiques sont dupliqués au lieu d'être encapsulés.** `scopeTenant` copié 19 fois. La règle d'identité contact écrite quatre fois. Six modules d'infrastructure copiés entre les deux repos et **déjà divergents**. C'est le mécanisme exact qui a produit B2 : `pool.ts` a été durci d'un seul côté, et c'est mba, le gros consommateur, qui est resté sans plafond.

**Les deux frontières du système sont implicites.** `web/lib/api.ts` est un module de 960 lignes qui redéclare à la main 63 interfaces de réponses backend, avec un `return body as T` ligne 32 comme unique point de contact : un cast non vérifié. Quatre de ces interfaces sont des copies verbatim de types serveur (`CampaignSummary`, `CampaignDetail.recipients`, `UserFieldDef`, `WorkflowGraph`), commentaires compris. Un renommage de champ côté serveur compile partout et produit des `undefined` en production, détectables uniquement par un clic manuel.

Même problème sur le contrat mba vers mm-hubspot : déclaré en TypeScript (`src/analysis/connector-push.ts:12`), redéclaré en zod (`mm-hubspot/src/ingest/event.ts:9`) avec `analysis: z.record(z.string(), z.unknown())`, donc **sans valider le contenu**, puis lu par chaînes littérales dans `src/crm/mapping.ts:28-38`. Aucun numéro de version. Le vecteur vraiment silencieux n'est pas le renommage d'une clé (TypeScript est bruyant à l'intérieur de mba) mais le changement d'une **valeur d'enum** : si `ACTIONS` passait de `'escalader'` à `'escalade'`, mba ne casserait nulle part et `mm_handoff_requested` passerait à `'false'` sur 100 % des escalades des 30 clients, sans DLQ, sans alerte.

**Pour un deuxième développeur, le point d'entrée est hostile.** `index.ts` fait 378 lignes de câblage pur. `worker.ts` en fait 386, dont 113 (lignes 89 à 201) de logique métier dans un littéral d'objet passé à `new WorkflowExecutor`, à l'intérieur d'une fonction `main()` non exportée, donc **inatteignable par tout test**. `web/app/campaigns/page.tsx` fait 1384 lignes dont un composant `CreateForm` de 929 lignes avec 36 `useState` et 5 `useEffect`. Et ce n'est pas théorique : un commentaire du fichier référence un bug passé "ça n'envoie à personne" causé par un reset d'état mal maîtrisé. La coordination manuelle de 36 états provoque déjà des bugs d'envoi réels, sur un écran qu'aucun test ne couvre.

### Incohérences réellement constatées

- **`trustProxy`** : présent dans mm-hubspot avec un commentaire explicatif, absent de mba, alors que c'est mba qui utilise `req.ip`.
- **Plafonnement du pool** : `DB_POOL_MAX`, `PGBOSS_MAX`, `DB_CONN_TIMEOUT_MS` dans mm-hubspot, aucun équivalent dans mba.
- **`expireInSeconds`** : ajouté côté mba, absent côté mm-hubspot. Et `mm-hubspot/src/queue/fake.ts:14` nomme le paramètre `_opts` et le **jette**, alors que la version mba le conserve. Conséquence : le `singletonKey` de `/ingest` (`src/ingest/route.ts:59`) n'est asserté par aucun des sept tests, parce que le fake ne l'expose pas.
- **Chiffrement au repos** : deux réimplémentations indépendantes aux formats **incompatibles**. `v1.<iv>.<tag>.<ct>` versionné côté mba, `<iv>:<tag>:<ct>` non versionné côté mm-hubspot. Et `mm-hubspot/src/oauth/crypto.ts:10` ne valide **pas** la longueur de clé, là où `secretbox.ts:11` lève sur `key.length !== 32` : une `ENCRYPTION_KEY` tronquée échoue en erreur Node opaque au moment de chiffrer un refresh token OAuth, pas au démarrage. L'absence de préfixe de version ferme aussi la porte à toute rotation d'algo.
- **Transport HTTP** : `src/meta/http.ts` côté mba, `src/http/transport.ts` côté mm-hubspot, avec le bloc retry copié octet pour octet mais des interfaces de transport qui ont réellement bifurqué. `src/db/ssl.ts` est identique octet pour octet dans les deux repos : c'est le premier candidat évident à une extraction.
- **Convention `t` dans les deps de hooks** : 11 fichiers déclarent `t`, au moins 4 l'omettent (dashboard:68, contacts:45, fields:42, admin:29). Cause mécanique : **aucun linter n'est installé**. Pas de config ESLint, ni `eslint` ni `eslint-config-next` dans `web/package.json`, alors que `"lint": "next lint"` (ligne 9) laisse croire le contraire et que le code porte des `// eslint-disable-next-line` qui ne désactivent rien.

### Code mort et slop identifiés

Peu, et honnêtement peu grave. Voici la liste exhaustive de ce qui est réellement mort :

- **`contactIdentity`** (`src/crm/identity.ts:11`) : zéro appelant en production, seul son test l'exerce. Le fichier se déclare "règle unique, réutilisée partout" alors que la règle est réécrite à la main dans `sends-build.ts:24`, `campaign/build.ts:47` et `web/lib/api.ts:82`. Le commentaire est mensonger. Supprimer la fonction et son test, corriger l'en-tête.
- **`systemFieldCode`** (`src/ids/code.ts:53`) : aucun appelant en production, seul `tests/ids-code.test.ts` l'importe. Couverture en trompe-l'œil : le test protège un générateur mort pendant que le générateur vivant (`web/lib/fields.ts:42`) n'a aucun test.
- **`resolveTag`** (`src/ids/resolve.ts:62`) : 16 lignes, zéro appelant, avec un commentaire qui avoue "chemin gardé par symétrie" et "ambiguïté impossible". De l'abstraction bâtie pour la forme.
- **`FLOW_TEXT_KINDS`** (`src/meta/flow-json.ts:114`) : seule occurrence dans tout le repo, src, web et tests confondus. Code mort au sens strict.
- **`pullPending`** dans mm-hubspot (`src/queue/pgboss.ts:53`) : copié depuis mba **sans son unique raison d'exister**. Plus large : le script `test:integration` et `vitest.integration.config.ts` pointent sur un répertoire `tests/integration/` qui **n'existe pas** dans mm-hubspot. Tout le harnais est orphelin et laisse croire à une couverture DLQ inexistante.
- **`conversations.hub_id`** (`mm-hubspot/db/migrations/0001_init.sql:10`) : jamais écrite, toujours NULL, alors que tout le code résout le portail via `tenant_portals`. Piège pour le prochain lecteur, qui écrira `where hub_id = $1` et obtiendra zéro ligne. `alter table conversations drop column if exists hub_id`.
- **`ensureGroup` et `GROUP`** (`mm-hubspot/src/hubspot/properties.ts:65` et `:4`) : exportés sans consommateur hors de leur fichier.
- **`createLlmClient`** (`src/analysis/llm-client.ts:72`) : fabrique à une seule branche, dont le commentaire ligne 9 promet "agnostique du provider, OpenAI possible" alors que toute autre valeur de `LLM_PROVIDER` **tue le conteneur worker au boot**. Passer en `z.enum(['anthropic'])` pour que l'erreur vienne de la validation de config, et corriger le commentaire.
- **`web/lib/api.ts:154`, `listAllContacts`** : pagine correctement par pages de 500 avec le commentaire "ne jamais tronquer silencieusement", et n'est appelée nulle part. La page Contacts est justement son cas d'usage.

### Le point le plus dangereux, qui n'est pas dans le code

**mm-hubspot n'a aucune CI** (`ls .github` : rien) **et aucun remote GitHub** (`git remote -v` : seulement `vps`). Ses 5 fichiers de tests d'intégration sont gardés par `describe.skipIf(!url)`, ses 19 fichiers de tests unitaires ne sont déclenchés par rien. Le déploiement se fait par push sur le bare repo et `docker compose up --build`, sans gate. Une migration qui casse le schéma `mmhs` ou une régression sur `withActionLock` part en production **sur les portails clients** sans qu'un seul test ait tourné.

Pire : le `DATABASE_URL` du `.env` local pointe sur le pooler **de production**, et `ingest.integration.test.ts:23-24` exécute `delete from conversations where conversation_id like 'itest-%'`. Le seul mode d'exécution existant de ces tests écrit et supprime dans la base qui sert les clients.

Côté mba, la CI existe et est correcte (`postgres:16` éphémère, migrations rejouées) mais **ne compile ni ne lint jamais `web/`** : le `tsconfig.json` racine a `include: ["src", "tests"]`, aucun step ne fait `cd web`, et `web/package.json` n'a même pas de script `typecheck`. La première personne à découvrir une erreur de type dans le frontend est le build Docker sur le VPS de production.

---

## 6. LES DEUX RÉPONSES CIBLÉES

### A. Le bug "internal error au clic sur le bouton homepage"

**Deux défauts indépendants qui se composent. Le premier produit l'erreur, le second produit le symptôme visible.**

**Cause de l'erreur.** Le pool Postgres de `mba-api` n'est pas borné (`src/db/pool.ts:6`, défaut pg = 10) et pg-boss non plus, face à un pooler Supabase en mode session plafonné à 15, partagé avec `mba-worker` et mm-hubspot. Le repo documente déjà l'EMAXCONNSESSION comme un fait établi (`DEPLOY.md:87-95`), et `.loop/palier3-b2-et-robustesse.md:69` le constate même sur les tests d'intégration "parce que la prod en tient une partie". Le repo traite ça comme un incident de redéploiement. Ça n'en est pas un : ça se produit en régime normal.

L'enchaînement, en cliquant sur le logo de l'AppShell (`web/components/AppShell.tsx:136`, href `/accueil`) : `AccueilInner` tire d'un coup 6 appels backend, `getMe` + `getSettings` + `getAccountStatus` (lignes 67-71, vérifié) et `getStats` + `getTemplateStats` + `getCostSeries` (lignes 86-90). Si tu viens de `/dashboard`, ses appels peuvent encore être en vol : **il n'y a aucun `AbortController` dans tout `web/`** (vérifié par grep), et une navigation client n'annule rien. Le pool tente d'ouvrir des sessions supplémentaires, le pooler refuse, pg rejette, et `src/http/account.ts:110` (`const pn = await deps.getPhoneNumber(tenant)`) **n'est pas protégé**, contrairement à `getHubspotPortal` ligne 108 qui a son filet. L'erreur remonte au `setErrorHandler` de `src/server.ts:143`, qui renvoie `{ error: 'Internal Server Error' }` : exactement la chaîne que tu vois.

**Pourquoi le refresh corrige.** Un seul écart est démontrable par le code, et c'est le bon : **il n'existe aucun retry**. Le `useEffect` de `web/app/accueil/page.tsx:100-103` ne tire qu'au montage, et le rendu d'erreur ligne 167 n'a pas de bouton de relance. Une fois l'écran en erreur, il y reste jusqu'au remontage. Le F5 est littéralement le seul moyen de re-déclencher le fetch, d'où "je dois refresher pour que ça apparaisse". S'y ajoute le fait qu'entre l'échec et le F5 il s'écoule quelques secondes, pendant lesquelles les sessions des autres process sont libérées et les sockets du pool redeviennent chaudes.

**Cause du symptôme visible ("le numéro n'apparaît pas").** Le `Promise.all` de `web/app/accueil/page.tsx:67` est all-or-nothing (vérifié). Le catch ligne 76 n'appelle jamais `setAccount`, donc `account` reste `null`. Ligne 187, `account && !account.hasNumber` est faux quand `account` est null, on tombe dans la branche else, et ligne 201 `account?.number ? ... : t('Aucun numéro')` affiche **"Aucun numéro"**. Un échec transitoire de `getMe` (qui ne sert qu'à afficher un prénom) suffit à effacer l'affichage du numéro WhatsApp.

Incohérence interne notable : `loadKpis` ligne 84 a justement été isolé avec le commentaire "Un hoquet des stats/coût n'efface pas la carte statut". Le bon pattern est connu et appliqué à un endroit, mais les trois appels critiques sont restés couplés entre eux.

**Pourquoi ça a duré sans diagnostic :** `logger: false` plus un `setErrorHandler` qui masque sans journaliser. `docker logs mba-api` ne contient pas une seule ligne permettant de savoir que c'était un EMAXCONNSESSION plutôt qu'un bug applicatif. C'est pour ça que tu décris un symptôme et pas une cause.

**Correctif, dans l'ordre :**
1. Borner les quatre pools (`max` et `connectionTimeoutMillis`). **Une heure.**
2. Logger l'erreur avant de la masquer dans le `setErrorHandler`. **Trente minutes.**
3. Passer `/accueil` en `Promise.allSettled` avec un état par appel, sortir `getAccountStatus` de la rafale comme `loadKpis` l'est déjà, et distinguer "statut indisponible, réessayer" de "aucun numéro". **Une heure.**
4. Retry automatique unique sur 5xx dans `web/lib/api.ts:22` plus un bouton "Réessayer". **Une heure.**
5. Migrer l'API en mode transaction sur le pooler.

### B. Le formulaire de support envoie-t-il un mail, et à qui

**Oui, un vrai mail part, et il arrive chez toi.**

`POST /tenants/:tenantId/support` appelle directement l'API Resend (`POST https://api.resend.com/emails`). En production `RESEND_API_KEY` est renseignée (36 caractères, préfixe `re_`), `SUPPORT_TO=julien@messagingme.fr`, `SUPPORT_FROM=support@messagingme.app`. Le flag `enabled` est donc vrai. Le mail part vers ta boîte, avec l'email du demandeur en `reply-to` (`src/index.ts:322`), et un corps qui contient sujet, message, tenantId, userId et email.

**Ce qui ne va pas :**

- **Aucune persistance, aucun log.** Il n'existe aucune table de support (grep sur `db/migrations/` : rien) et le catch de `src/http/support.ts:48` est un `catch {` **sans binding** : l'erreur n'est jamais journalisée. Un échec Resend (domaine qui perd sa vérification, 429 sur quota, hoquet DNS) détruit définitivement le message. L'utilisateur voit bien un 502 et un bandeau rouge, donc ce n'est pas silencieux pour lui, mais **toi tu ne sauras jamais qu'un message a existé**. Le client qui signale "mes campagnes ne partent plus" disparaît en silence. Note pour le correctif : `req.log.error` serait un no-op ici, Fastify injecte un logger noop quand `logger: false`. Utilise `console.error` (canal de fait du repo, 23 occurrences) ou active pino.

- **Aucun rate limit, sur une clé Resend partagée avec l'authentification.** La route n'a que `requireAuth` (`src/server.ts:180`), et l'inscription est libre (`/auth/signup` et `/auth/google` rendent un JWT immédiatement). N'importe qui peut donc boucler dessus. Or la même `RESEND_API_KEY` sert aux liens de reset et d'invitation (`src/index.ts:78-80`). L'effet de bord n'est pas "le support ne marche plus" mais **"plus personne ne peut réinitialiser son mot de passe"**, et c'est silencieux : l'envoi du reset est en fire-and-forget (`void deps.sendEmail`, `src/auth/routes.ts:152`) derrière une réponse anti-énumération, donc un 429 Resend ne remonte nulle part.

- **`SUPPORT_TO` est mono-destinataire.** `src/support/resend.ts:41` fait `to: [input.to]`. Le jour où tu écris `SUPPORT_TO=julien@...,support@...`, Resend reçoit une adresse unique invalide et renvoie 422. Ce n'est pas silencieux (tu le verras au premier test), mais c'est un piège au geste de config le plus naturel.

- **Le reply-to vient du corps de la requête, pas du JWT.** `src/http/support.ts:37` prend `b.email`. Le front l'alimente avec `session.email`, mais rien côté serveur ne le vérifie (le jeton ne porte pas d'email). Un utilisateur authentifié, y compris un simple agent, peut faire pointer le reply-to où il veut, et ta réponse (détails de configuration, état des envois) part ailleurs. Correctif trivial : la résolution serveur existe déjà et est déjà câblée, `userStore.getSessionUser(userId)` renvoie l'email (`src/user/store.pg.ts:105`) et est utilisée en `src/index.ts:94`. Il suffit de la réutiliser et d'ignorer `b.email`.

- **Le mail ne dit pas qui c'est.** `Tenant : 01JX...` en UUID brut. À 30 clients tu ouvres une console SQL avant même de lire la demande. Une jointure sur `tenants.name` suffit.

**Correctif consolidé :** écrire le message en base **avant** l'appel Resend (`support_messages` avec status et error), rate limit dédié (5 par utilisateur et par heure, en cléant sur `userId`), clés Resend séparées pour l'auth et le support, parser `SUPPORT_TO` en liste, résoudre l'email et le nom du tenant côté serveur. **Effort M au total, S si tu ne fais que le rate limit et le log.**

---

## 7. PLAN D'ACTION ORDONNÉ

Trois vagues. Estimations pour un développeur seul, à temps plein.

### Vague 1 : avant le prochain client (5 à 7 jours)

Sans ça, le deuxième client dégrade le premier.

| # | Action | Constat | Effort |
|---|---|---|---|
| 1 | Borner les 4 pools (`DB_POOL_MAX`, `PGBOSS_MAX`, `DB_CONN_TIMEOUT_MS` au zod, câblés dans `pool.ts` et les deux `PgBossQueue`), exposer `onError` sur `PgBossQueue` et l'attacher | B2 | S |
| 2 | Logger les 5xx avant de les masquer dans les deux `setErrorHandler`, activer pino JSON sur stdout | B9 | S |
| 3 | Fail-fast au boot sur `DATABASE_URL` et `META_APP_SECRET` vides | B9, Railway 5 | S |
| 4 | Corriger `/accueil` en `Promise.allSettled` + bouton Réessayer + retry unique sur 5xx dans `api.ts` | Bug dashboard | S |
| 5 | Deux index : `contacts(tenant_id, created_at desc)` et `conversation_messages(created_at)`, plus les index FK manquants | B8c | S |
| 6 | Refuser la réaffectation de numéro à l'Embedded Signup (409 explicite) + revalider l'appartenance dans `campaignRunJob` | B5a | S |
| 7 | Fermer `/oauth/install` : lien d'install généré par mba sur route JWT | B5b | M |
| 8 | Filtre `hub_id` dans le SQL de `getContext`, `portalId` obligatoire, supprimer le fallback `CARD_SECRET` | B5c | S |
| 9 | Câbler le rate limiter manquant du worker (une campagne à `ratePerMinute: null` envoie aujourd'hui sans aucun frein) | B4 | S |
| 10 | Pousser mm-hubspot sur GitHub, y copier la CI de mba (`APP_SCHEMA=mmhs`), sortir les tests d'intégration de la base de prod, `throw` au lieu de `skipIf` quand `CI` est défini | Section 5 | S |
| 11 | Ajouter un job CI `web` : `cd web && npm ci && npx tsc --noEmit && npm run build`. Installer eslint + eslint-config-next, ou supprimer le script mort et les `eslint-disable` | Section 5 | S |
| 12 | Rate limit sur `/support` + log de l'échec Resend + persistance du message | Section 6B | M |

### Vague 2 : avant la bascule Railway (8 à 12 jours)

| # | Action | Constat | Effort |
|---|---|---|---|
| 13 | **Résolution du token Meta par tenant** : `resolveMetaCredentials`, fabrique `metaClientFor`, les 12 sites, gestion de l'expiration et de la révocation, test qui prouve que deux tenants produisent deux tokens | B1 | L |
| 14 | Passer l'API mba en mode transaction sur le pooler (après test du `search_path` côté mm-hubspot) | Section 4 | M |
| 15 | Bind `'::'` dans les deux `index.ts` | Railway 1 | S |
| 16 | `BACKEND_URL` : déplacer du bloc `environment` vers `build.args` dans le compose, déclarer en variable de BUILD sur Railway, ou route handler Next runtime | Railway 3 | M |
| 17 | Horodatage + nonce + méthode/chemin dans le HMAC de `/service/*` et `/ingest` | Railway 6 | M |
| 18 | `trustProxy` correctement borné (jamais `true`) + compteurs d'auth en base | B11 | M |
| 19 | `/health` avec `select 1` et 503, `/live` séparé | Railway/B9 | S |
| 20 | Advisory lock dans `db/migrate.ts`, un seul service porteur de la release command | Railway 8 | M |
| 21 | Heartbeat du worker en base, exposé dans `/ops`, `QUEUE_NAMES` complété, alerte Telegram extraite du script cron | B9 | M |
| 22 | Sweeper de rafraîchissement du statut/qualité des numéros + alerte sur RED / status != CONNECTED / authError | B7 | M |
| 23 | CA Supabase montée + `DB_SSL_CA_FILE`, puis retrait de `DB_SSL_INSECURE`, et correction du commentaire trompeur du `.env.prod.example` | Railway 10 | S |
| 24 | `tsx` en dependencies, ou réparer le chemin compilé + `railway.json` avec `builder: DOCKERFILE` | Railway 4, 9 | S |
| 25 | Écrire et **tester une fois** la procédure de restauration, avec RPO/RTO réel dans DEPLOY.md | Railway 11 | M |

### Vague 3 : après, par ordre de valeur

| # | Action | Constat | Effort |
|---|---|---|---|
| 26 | **Opt-out écrivable** (route PATCH, `optOut` en API v1, détection STOP dans `processInbound`) | B6 | M |
| 27 | Rétention et purge : `webhook_events` d'abord (design maigre + index + purge 7 j + exploiter le booléen), puis conversations/messages/analyses, puis routine d'effacement par contact | B8a, B8b | M |
| 28 | Concurrence worker : `localConcurrency` + `groupConcurrency` par tenant, découpage de `campaign-run` en lots, throttle déplacé au niveau du **numéro** avec advisory lock | B4 | L |
| 29 | Multi-numéro : `phone_number_id` sur `conversations` et `workflow_runs`, unicité `(tenant_id, phone_number_id, wa_id)`, `is_default` sur `phone_numbers`, suppression de `getTenantPhoneNumberId` | B3 | L |
| 30 | Appliquer `messaging_limit_tier` à la création de campagne et au dimensionnement | B7 | M |
| 31 | Extraire `scopeTenant`, compléter la garde de boot, test paramétré cross-tenant, test statique sur les `.pg.ts` | B10 | M |
| 32 | `schemaVersion` obligatoire dans le contrat mba/mm-hubspot, schéma zod complet du bloc `analysis` couvrant les **valeurs d'enum**, test de round-trip | Section 5 | M |
| 33 | Frontend : pagination et recherche serveur sur Contacts (le plafond serveur de 500 est en dur dans `contact-store.pg.ts:352`) et sur l'Inbox (limit 100 en dur), plus le deep-link `?c=` qui échoue silencieusement | Section 5 | M |
| 34 | Frontend : `AbortController`, `Promise.allSettled` sur dashboard, distinguer erreur et état vide dans les 3 composants qui affichent "Aucun envoi" / "Aucun template approuvé" sur un échec réseau, mapper les 5xx sur un message bilingue | Section 5 | M |
| 35 | Extraire les modules infra réellement communs (`ssl.ts` identique, bloc retry, signature HMAC, interface `Queue`). **Laisser diverger** `pool.ts`, `migrate.ts`, `config.ts`. Aligner le chiffrement de mm-hubspot sur le format versionné + validation de longueur de clé (migration des blobs OAuth) | Section 5 | L |
| 36 | Nettoyage : supprimer `contactIdentity`, `systemFieldCode`, `resolveTag`, `FLOW_TEXT_KINDS`, `pullPending` + harnais orphelin, `conversations.hub_id`, `listAllContacts` ou l'utiliser. Corriger les commentaires mensongers (`identity.ts:2`, `user/store.pg.ts:220`, `llm-client.ts:9`, `queue.ts:9-12` côté mm-hubspot, `ingest/event.ts:4-5`) | Section 5 | S |
| 37 | Découper `web/app/campaigns/page.tsx` (`useReducer` sur un `CampaignDraft`, composants par étape) et extraire `src/workflow/send-actions.ts` du corps de `main()` | Section 5 | L |
| 38 | Sortir le pilote Supabase vers un projet dédié ou pgbouncer transaction, avant le dixième client | Section 4 | M |

**Réalisme :** vagues 1 et 2 font environ trois semaines pleines. C'est le minimum avant de vendre. La vague 3 est du travail de fond que tu peux étaler, à l'exception de l'opt-out (#26), qui est une question de conformité et devrait remonter en vague 1 si tu envoies du marketing en volume avant.

---

## 8. CE QUE JE N'AI PAS PU VÉRIFIER

Court et honnête.

**Constats non vérifiés :** aucun. Tous les constats de cet audit ont reçu un verdict.

**Ce qui exige un test de charge :**
- Le comportement réel du pooler Supabase sous 30 tenants concurrents. J'ai le budget théorique (42 sessions demandées contre 15 disponibles) et l'incident documenté en prod, mais pas le seuil exact de bascule.
- Les temps de réponse réels du seq scan sur `contacts` et du fan-out sur `conversation_messages`. J'affirme la dégradation, pas son ampleur.
- La compatibilité du `options=-c search_path` de mm-hubspot avec le mode transaction du pooler. C'est le seul point qui pourrait invalider ma recommandation de section 4.

**Ce qui exige un accès prod :**
- Le contenu réel de `.env.prod` sur le VPS, notamment `CONVERSATION_ANALYSIS_ENABLED` et `CONNECTOR_PUSH_URL`. S'ils sont à leurs valeurs par défaut (`'false'` et `''`), la chaîne d'analyse est inerte et le trou de `/ops` sur les files `analyze-conversation` / `push-analysis` est nul. Sinon il est réel.
- Les droits exacts du System User Meta sur les WABA clients. Ça détermine si B1 se manifeste par un échec immédiat au deuxième onboarding, ou par un point de défaillance unique qui fonctionne jusqu'au jour où il tombe. Les deux cas exigent le même correctif, mais l'urgence diffère.
- Le plan Supabase actuel (backup quotidien ou PITR) et donc le RPO réel.
- Si les tests d'intégration ont déjà créé des tenants orphelins (`itest-stores`, `itest-e2e`) en base de prod. Un `select` sur `tenants` où le nom commence par `itest-` répond en dix secondes.

**Ce qui exige une décision produit, pas une décision technique :**
- Faut-il autoriser plusieurs numéros par tenant, ou verrouiller à un seul et le documenter. B3 coûte L si oui, S si non (il suffit alors de refuser le second numéro proprement au lieu de le casser silencieusement).
- Quelle rétention par défaut proposer aux clients, et si c'est un paramètre contractuel ou un réglage.
- Si le cap anti-répétition marketing (`frequencyWindowMs: 0`, désactivé en dur dans `src/campaign/engine.ts:77` par décision du 2026-07-15) doit rester la politique des 30 clients ou devenir un réglage par tenant. Note : si tu le réactives, crée **d'abord** `create index concurrently on campaign_recipients (to_e164, sent_at desc) where status = 'sent'`, sinon la garde coûtera plus cher que l'envoi qu'elle protège.

---

## Ce que j'écarte comme du bruit

Constats confirmés par la vérification que je juge sans conséquence réelle pour toi, à trente clients. Une ligne chacun.

- **`getRating` appelé par destinataire dans la boucle d'envoi.** La boucle est séquentielle, une connexion à la fois, la requête est négligeable devant l'appel Meta de chaque itération. Le vrai problème est que la valeur n'est jamais rafraîchie, pas qu'elle est relue.
- **Import CSV synchrone avec un aller-retour par ligne.** Réel, mais `pool.query()` rend la connexion à chaque appel, donc pas de famine du pool. Le coût est une requête HTTP longue et un 504 NPM sur les gros fichiers, avec un réessai idempotent grâce au `ON CONFLICT`. À traiter, pas à traiter en premier.
- **Refresh OAuth HubSpot sans verrou.** HubSpot ne rote pas ses refresh tokens : aujourd'hui ça produit des appels redondants, pas des déconnexions. À traiter le jour où HubSpot annonce la rotation, pas avant.
- **`resolveTag`, `pullPending` en tant que tels, `ensureGroup` exporté.** Fonctions pures sans effet de bord ni chemin d'exécution. Zéro impact runtime. À nettoyer par hygiène en vague 3, pas à discuter.
- **`SUPPORT_TO` mono-destinataire et `SUPPORT_FROM` partagé.** Choix assumés, verrouillés par un test, et l'échec serait visible dès le premier essai de reconfiguration. Confort, pas dette.
- **Deux architectures pour "créer un envoi" (console vs API v1).** Elles servent des cas d'usage réellement différents (brouillon depuis une sélection CRM vs envoi transactionnel plafonné à 50 avec idempotence), les règles de consentement sont déjà factorisées dans `optInAllows`, et l'exécution converge sur `runCampaign`. Fusionner créerait une fonction à paramètres contradictoires.
- **Les cinq modales sans `role="dialog"` ni piège de focus.** Dette d'accessibilité réelle, mais strictement identique à 1 tenant et à 30. Aucun couplage au scale. Et contrairement à ce qui m'a été remonté, la croix est un vrai bouton donc la fermeture au clavier fonctionne, elle est juste pénible.
- **`toLocaleString()` sans tag BCP47 sur les dates de campagne planifiée.** Deux occurrences, effet limité à un format de date en français dans une interface anglaise. Le volet fuseau horaire du constat est faux : la saisie et l'affichage sont cohérents, tous deux en fuseau navigateur.
- **`t` manquant dans les deps du `useCallback` du dashboard.** La branche concernée est du code mort (`ApiError` étend `Error`, donc `err instanceof Error` est toujours vrai). Le vrai constat est l'absence de linter, déjà en vague 1.
- **Les trois constantes miroir front/back (`WHATSAPP_OPTIN_FIELD_KEY`, `SYSTEM_FIELD_KEYS`, `systemFieldCode`).** Le scénario du 403 muet ne tient pas (le message serveur remonte bien à l'utilisateur), et les champs système n'ont pas de ligne en base donc le chemin de suppression n'existe pas. Reste l'invisibilité d'un champ promu dans les sélecteurs de variables : événement rare, non bloquant.
- **Le rejeu de `/ingest` en tant que faille.** La dédup sur `eventId` le neutralise en écriture. Le seul effet résiduel est un statut de conversation remis à `received`, sans conséquence puisqu'aucun sweeper ne relit ce champ.
- **`GET /v1/sends/:sendId` qui exige le scope d'écriture.** Symptôme d'une limite structurelle (le `guard` est appliqué par `register*` et non par route), pas un défaut isolé. Ne se corrige pas sans revoir tout le câblage des scopes, ce qui n'urge pas à 30 clients.
- **`campaigns(tenant_id)` sans index.** Table de quelques milliers de lignes, seq scan sub-milliseconde. À ajouter avec les autres index FK, pas à justifier.
- **Le polling de l'inbox (4 s / 15 s).** Les deux intervalles sont déjà conditionnés par `document.visibilityState === 'visible'` avec un listener de refocus : un onglet en arrière-plan ne génère aucun trafic. Le SSE est une optimisation, pas une correction.
- **`reclaimStale` qui ne ré-enfile pas.** La fenêtre de perte réelle est étroite (petites campagnes, au plus un destinataire par run crashé), l'écart est affiché dans l'interface ("terminée · N en attente"), et un relancement manuel le récupère. Fiabilité de comptage, pas bloqueur.
- **`web/lib/api.ts` en 960 lignes et l'écran campagnes en 1384.** Vrais problèmes de maintenabilité, faux problèmes de scale. Je les ai gardés en section 5 et en vague 3, mais ils ne méritent pas une ligne de plus tant que tu es seul développeur. L'argument "merge conflict si deux personnes touchent aux campagnes la même semaine" ne s'applique pas à toi.

Ce que je n'écarte surtout pas, même si ça paraît cosmétique : les **commentaires mensongers**. `identity.ts:2` qui promet une "règle unique réutilisée partout" pour une fonction morte, `user/store.pg.ts:220` qui affirme qu'aucune FK ne référence `users` alors que deux le font depuis 2017, `queue.ts:9-12` côté mm-hubspot qui documente une dédup de file que le code ne fait pas, `.env.prod.example:19-20` qui recommande une manœuvre TLS qui coupe la prod. Ces quatre-là dissuadent activement le prochain lecteur de chercher le problème. C'est exactement le type de dette que tu veux voir nommée, et ça se corrige en dix minutes.