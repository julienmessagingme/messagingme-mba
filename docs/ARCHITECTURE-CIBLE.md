# Bascule Scaleway : le document qu'on actionne

> Écrit le 2026-09-15 à la demande de Julien, qui a raison : la matière était éparpillée entre `todo.md`,
> `CLAUDE.md` et `documentation.md`. **Ceci est la source unique.** Ailleurs, on met un pointeur vers ce
> fichier, jamais une copie.
>
> **Enrichi le 2026-09-21** avec un mémo externe sur l'architecture et la sécurité (daté du 2026-09-19),
> **vérifié contre le code et la production avant d'être repris**. Ce qui en a été écarté, et pourquoi, est
> au §14. Trois décisions de Julien du même jour : **deux workers** (§5), **les fichiers hors de Postgres**
> (§6) et **Cloudflare Pro retenu pour la cible** (§7.7).

🔴 **DEPUIS LE 2026-09-25, LA VITRINE PUBLIQUE L'ANNONCE COMME FAIT.** Le pied de page de
`engageme.messagingme.fr` (`site/index.html`, classe `heberge`) affiche « Vos données hébergées en France
chez Scaleway », sur décision de Julien (« tu fais comme si c'était fait »). Or la base tourne encore sur
`aws-1-eu-west-2`, à Londres. Cette bascule n'est donc plus seulement une architecture cible : c'est une
promesse publique, et chaque semaine sans migration la rend fausse un peu plus longtemps. Si la bascule est
abandonnée ou repoussée sans date, la pastille se retire, elle ne se reformule pas.
⚠️ **La phrase couvre le STOCKAGE, rien de plus** : la base et les fichiers. Elle ne couvre ni les appels IA
(Vercel AI Gateway, §2.1), ni le transit des messages par Meta. Une question RSSI se répond avec le §2.1,
jamais avec le pied de page.

Ce document ne décrit pas ce qui tourne aujourd'hui (voir `documentation.md`). Il décrit **ce qu'on vise**,
**les chantiers à finir avant**, et **la séquence du jour J**.

✅ **Mis à jour le 2026-10-03, et c'est ce qui reste pour l'autoscaling.** Le code est prêt pour plusieurs copies
d'API, et c'est PROUVÉ, plus seulement écrit : deux bancs à deux copies (§11), le correctif qu'ils ont imposé (une
copie tuée ne coince plus aucune clé, §3.5), les deux workers en production (§5), le budget de connexions mesuré
et tenu par un test (§7.5). Julien a tranché le même jour (§13) : **l'autoscaling se fait à Scaleway, pas sur le
VPS**, où des copies se partageraient la même machine. Ce qui reste est donc l'INFRASTRUCTURE de la cible, dans la
séquence du §10 : les conteneurs (minimum 1 copie), le budget recalculé sur la vraie base (§7.5), le nom de chaque
copie dans `/ops` (§10, étape 7), et le second banc rejoué sur la cible (§11).

---

## 1. La règle qui gouverne tout : deux tiers, deux besoins OPPOSÉS

**L'API est élastique et sans mémoire.** « Élastique » veut dire que l'hébergeur démarre et arrête tout seul
des copies du programme selon le trafic. Aujourd'hui rien ne l'est : il y a exactement un exemplaire de
chaque, en permanence.

**Le worker est fixe et permanent.** Il tient des abonnements aux files et une écoute de notifications. Il ne
se réveille pas sur une requête HTTP, donc **un worker qui descend à zéro ne dépile rien, par construction.**

🔴 **Ces deux besoins ne se mélangent pas, et trois conséquences en découlent mécaniquement.** Elles ne
dépendent d'AUCUN fournisseur : elles valent chez Scaleway, chez Fly, chez n'importe qui. C'est la partie
ferme de ce document.

1. **Un tiers élastique doit avoir un nombre de connexions BORNÉ.** Le nombre de copies varie, le nombre de
   connexions que la base accepte, non. Tant que le maximum de copies déduit du budget tient dans les connexions
   directes (§7.5 : deux copies sur la base Micro actuelle), le budget se calcule à la main. Au-delà, **un pooler
   devient obligatoire** : sans lui, la dixième copie tue la base au lieu d'ajouter de la capacité.
2. **Un tiers élastique ne peut tenir AUCUNE connexion de session.** Une connexion de session est retenue pour
   la vie du processus et ne se partage pas. Multipliée par un nombre de copies variable, elle donne une
   consommation que personne ne peut borner.
3. **Un tiers élastique ne peut porter AUCUN état en mémoire qui compte.** Un plafond compté dans un processus
   est un plafond multiplié par le nombre de copies, sans que rien ne le dise ; un fichier déposé sur une
   copie est introuvable depuis l'autre.

---

## 2. La cible

```
   Front public                               Backend public
   engageme.messagingme.app                   api.messagingme.app
            |                                          |
          Vercel                                  Cloudflare
   (direct, SANS Cloudflare)                           |
                                  jeton d'origine injecté par Cloudflare (§7.3)
                                                       |
                                  Scaleway Serverless Container, API
                                  PRIVÉ, min 1 copie, max fixé par le budget de connexions
                                                       |
                                     Private Network (VPC), région PAR
             +---------------------------+-------------+---------------+
             |                           |                             |
     PostgreSQL managé           worker PRINCIPAL               worker ANALYSE
     endpoint privé seul         (instance privée)             (instance privée)
                                             \                     /
                                          Public Gateway (sortie seule, §7.4)
                                          vers Meta, fournisseurs IA, HubSpot

   Object Storage privé (HTTPS + IAM, §6) : médias RCS
   Connecteur HubSpot ----> SA PROPRE base (§8)
```

🔴 **L'API garde TOUJOURS une copie allumée (min 1), et c'est une correction.** La version du 2026-09-15
prévoyait `min-scale 0`. C'était une erreur : l'application démarre via `tsx` et met plusieurs secondes à
être prête, et le premier appel après un silence est souvent le webhook de Meta, celui qui porte les
messages entrants. Une copie permanente coûte un petit conteneur allumé ; un démarrage à froid sur ce
chemin coûte des rejeux de Meta et une réponse en retard au client.

🔴 **L'API s'autoscale sans plafond de copies imposé par le code : décidé par Julien le 2026-09-28.** Plus rien
de ce qu'une copie garde en mémoire ne doit devenir faux avec N copies (verrous, anti-rejeu, plafonds de débit,
connexions de pg-boss) : c'est le chantier `docs/superpowers/plans/2026-09-28-api-multi-instances.md`, qui
remplace l'ancienne borne de DEUX copies. Le maximum de l'autoscaler reste un NOMBRE, mais il se déduit du seul
budget de connexions de la base (§7.5), plus du code. Le worker, lui, reste UN exemplaire par rôle (§5).

🔴 **La base part AVEC le calcul, jamais après.** Calcul à Paris et base à Londres, chaque requête traverse
internet. L'aller-retour est aujourd'hui de 11 ms mesurés ; entre deux fournisseurs il serait bien pire, et il
serait payé sur chacune des 131 transactions par minute mesurées AU REPOS, avant tout client. **Le calcul et
la base dans la même région, toujours.** Déménager l'un sans l'autre est un pas en arrière.

### 2.1 Deux routes IA, choisies manuellement — aucune bascule automatique

Le chemin qui existe aujourd'hui reste **Vercel AI Gateway**. Une deuxième route est prévue pour les contrats
qui imposent que l'inférence conversationnelle de l'agent soit traitée en France : **Azure OpenAI appelé
directement depuis le worker**, avec un déploiement régional en France. Ce n'est ni une migration générale
vers Azure, ni Azure Foundry Agent Service : l'orchestration, les outils, la mémoire, la base de connaissance,
les conversations et les fichiers restent dans Engage Me sur Scaleway.

```text
worker Engage Me, Scaleway France
             |
             +-- route ordinaire --> Vercel AI Gateway --> modèles autorisés
             |
             +-- route France -----> Azure OpenAI régional France
                                      (appel direct, sans Vercel au milieu)
```

🔴 **Cette route Azure n'est PAS livrée aujourd'hui.** Le client de complétion, le catalogue, les coûts et les
clés par espace sont encore couplés au Gateway Vercel. Tant que le lot correspondant de `todo.md` n'est pas
terminé et éprouvé contre une vraie ressource Azure, la réponse RSSI exacte est « option architecturée, non
activée », jamais « disponible » ou « hébergée en France ».

Le choix n'a pas besoin d'un bouton dans Engage Me. Il est posé par un opérateur, à la signature du contrat,
dans une configuration backend rattachée à l'espace. Le défaut reste Vercel. Le secret et l'endpoint Azure
restent côté serveur. Si plusieurs clients « France » partagent une ressource Azure, leurs plafonds et leur
comptabilité restent séparés dans Engage Me ; une ressource Azure dédiée n'est créée que si le contrat paie
et exige cette isolation.

🔴 **Aucun repli silencieux d'Azure vers Vercel.** Pour un espace soumis à une résidence France, une panne
Azure doit produire les retries bornés, l'alerte et le comportement de panne prévus. Envoyer ensuite le prompt
à Vercel rendrait la promesse fausse précisément au moment où le système est dégradé. Un repli vers une autre
région n'existe que s'il est explicitement autorisé par le contrat.

Le pré-câblage doit réutiliser la frontière étroite qui existe déjà, pas en créer une deuxième :

- `GatewayBrainDeps.completer` est déjà le contrat injecté dans le cerveau, le bac à sable et le worker ; au
  besoin, ses types peuvent être déplacés hors du fichier nommé `chat-client`, mais la boucle d'agent ne bouge
  pas et aucune nouvelle interface parallèle n'est ajoutée ;
- un résolveur backend par espace, administré hors de l'interface client ;
- un adaptateur Vercel qui garde strictement le comportement actuel ;
- un client Azure qui satisfait le même contrat et réutilise transport, délais, retries et erreurs existants ;
  avec l'API Azure OpenAI v1, `model` porte le nom du déploiement ;
- une comptabilité indépendante de `provider_metadata.gateway.cost`, absent chez Azure : les jetons sont la
  mesure commune, et le tarif Azure est une configuration versionnée ;
- des journaux qui portent fournisseur, région et déploiement, mais jamais la clé ni le prompt.

Le premier lot injecte ce résolveur **uniquement** dans les deux entrées du même cerveau : bac à sable
`agentTest` dans `src/index.ts` et production dans `src/worker.ts`. Réutiliser sans discernement l'objet
`gateway` de l'API ferait aussi basculer la traduction ; toucher `gatewayAide` ferait basculer l'assistant de
construction et le bot d'aide, alors que ce premier lot ne les promet pas en France.

⚠️ **« L'agent conversationnel est inféré en France » et « aucun traitement IA ne sort de France » ne sont
pas la même promesse.** L'assistant de construction, les embeddings, le reranking, la transcription, la
traduction et l'analyse de conversations font aussi des appels IA. Le premier lot peut ne router que les tours
de l'agent, mais la réponse RSSI doit alors se limiter à ces tours. Pour promettre que *tous* les traitements IA
d'un espace restent en France, chacun de ces chemins doit être inventorié, routé vers un service régional
compatible et testé. Un modèle indisponible en déploiement **Standard/Régional ou provisionné régional** en
France empêche cette promesse ; créer une ressource `francecentral` ne suffit pas si son type est `Data Zone
EU` (traitement possible ailleurs dans l'UE) ou `Global` (traitement possible ailleurs dans le monde).

Références à revalider au moment de l'achat : [disponibilité des modèles par région et type de déploiement
Azure](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/models-sold-directly-by-azure-region-availability),
[API v1 Azure OpenAI](https://learn.microsoft.com/en-us/rest/api/microsoft-foundry/azureopenai/chat), [données
et confidentialité Azure OpenAI](https://learn.microsoft.com/en-us/azure/foundry/responsible-ai/openai/data-privacy),
[résidence européenne de l'API OpenAI](https://openai.com/index/introducing-data-residency-in-europe/). La résidence
OpenAI directe en Europe est une troisième possibilité future, mais **elle ne prouve pas un traitement en
France**.

---

## 3. 🔴 Les chantiers à finir AVANT de basculer

État au 2026-10-03 : §3.1 et §3.3 livrés ET éprouvés au banc, §3.4 retiré, §3.5 trouvé et corrigé par le banc ;
§3.2 ne bloque la bascule que si un RÔLE de worker doit avoir deux copies (aujourd'hui, une copie par rôle).

Les quatre premiers ont la MÊME cause : **un état qui vit dans un processus, alors que le processus va devenir
multiple.** Aucun ne se voit aujourd'hui ; tous se découvriraient en production le jour du premier `scale`,
c'est-à-dire au pire moment.

### 3.1 L'API ne doit plus réserver de connexion

✅ **Livré et éprouvé au banc (voir la fin de ce paragraphe).** Une copie d'API n'ouvre plus aucune connexion de
session pg-boss : ce point ne borne plus le nombre de copies, que seul le budget de connexions décide (§7.5). Ce
qui suit décrit le problème tel qu'il se posait, et pourquoi la solution tient.

**Le problème.** `src/index.ts` construit un client pg-boss sur `DATABASE_URL`, donc en mode SESSION, pour la
seule raison qu'elle EMPILE des tâches. Elle n'en dépile aucune et ne fait aucune maintenance
(`supervise: false`). Chaque copie d'API retient donc jusqu'à `PGBOSS_MAX` connexions réservées.

⚠️ **La panne existe déjà en miniature** : `DEPLOY.md` documente `EMAXCONNSESSION` au démarrage à froid **avec
deux processus seulement**, quand le pooler tient encore les sessions des conteneurs qu'on vient de tuer.
Aujourd'hui ça se résout seul en trente secondes. Avec des copies élastiques, ça devient permanent.

**La solution, et elle est prévue par la bibliothèque** (vérifié dans pg-boss 12.25 le 2026-09-15) :
`DatabaseOptions.db?: IDatabase` accepte une connexion FOURNIE, dont la seule méthode obligatoire est
`executeSql(text, values)`. Notre pool applicatif la satisfait trivialement. 🔴 Et le point décisif est dans
le code de `start()` : `if (this.#db._pgbdb && !this.#db.opened) await this.#db.open()`. Un `db` fourni n'a
pas ce marqueur, donc **pg-boss n'ouvre aucun pool à lui**.

**Ce qui reste actif côté API avec cette option** : la vérification de version du schéma, et la mise en cache
des files (des `select`). Le superviseur, l'écouteur de notifications et le planificateur sont déjà désactivés.

⚠️ **Poser aussi `migrate: false` sur l'API.** Sinon chaque copie vérifie et migre le schéma pg-boss au
démarrage. C'est le worker qui migre.

**Livré le 2026-09-28** (lot C de `docs/superpowers/plans/2026-09-28-api-multi-instances.md`, aucune migration), et
**éprouvé au banc le 2026-10-03** (`scripts/banc-deux-api-2.mts`, épreuve `connexions`) : sous charge, chaque copie
ouvre au plus son `DB_POOL_MAX`, et AUCUNE connexion en écoute côté API ; seul le worker écoute. Revérifié dans la source de pg-boss **12.25.1**
(schéma 36) : `getDb()` rend `config.db` quand il est fourni (`dist/index.js`, l. 351), `start()` n'ouvre un pool
que sur `_pgbdb` (l. 91), `migrate: false` remplace la migration par `Contractor.check()` (l. 95-100,
`dist/contractor.js` l. 47-56). L'API construit `new PgBossQueue(pool)` : le prêt pose `db`, `migrate: false`,
`supervise: false`, `schedule: false` et `useListenNotify: false` DANS `PgBossQueue`, et le type y refuse toute
option de pool ou d'écoute. Deux choses que ce paragraphe ne disait pas :
- **la vérification est une ÉGALITÉ STRICTE** (`schemaVersion !== version`) : une API refuse de démarrer sur un
  schéma plus ANCIEN (worker pas encore migré) comme plus RÉCENT (retour arrière d'image). Une montée de version
  de pg-boss se déploie donc worker d'abord (DEPLOY.md, « Montée de version de pg-boss »), et une copie ancienne
  lancée par l'autoscaler après la migration ne démarre pas, ce qui est le bon échec : elle n'empile rien de faux.
- **l'accusé d'un webhook de Meta attend désormais sur le pool applicatif**, partagé avec la console : son
  attente se lit dans `pool_attentes` (ligne `api`), à regarder pendant l'essai réel.

### 3.2 Les balayages doivent être sérialisés (avant deux exemplaires d'un MÊME rôle)

⏳ **Toujours ouvert, et pas un préalable tant que chaque rôle tourne en UNE copie** (règle écrite au-dessus de
`WORKER_ROLE`, `src/config.ts`). L'autoscaling vise l'API ; il ne doit jamais multiplier un worker.

**Le problème.** Les tâches minutées vivent dans le processus (`src/worker/taches.ts`). Deux exemplaires du
même worker, deux exemplaires de chaque balayage : deux reprises de contrôle, deux réveils de parcours, deux
relances d'échecs. Certains sont idempotents, d'autres non.

⚠️ **Le découpage en deux RÔLES (§5) ne pose pas ce problème**, parce qu'il RÉPARTIT les tâches : chacune
appartient à un seul rôle. Le problème revient dès qu'un rôle a deux exemplaires.

**La solution.** Un verrou d'exécution, et **le modèle existe déjà dans le dépôt** : `src/campaign/run-lock.ts`
(migration 0089). Trois pièces, chacune pour une raison écrite : un **bail** (sinon un worker tué bloque le
balayage à vie), un **jeton de garde** (sinon le porteur d'un bail périmé supprime le verrou de son
successeur), un **drapeau de relance** (sinon le travail arrivé pendant la passe est perdu).

⚠️ Le lissage des départs livré le 2026-09-15 ne protège de RIEN ici : il décale, il ne sérialise pas.

### 3.3 Les plafonds de débit doivent quitter la mémoire (avant de relever le plafond de copies)

**Le problème.** `RATE_LIMIT_USER_PAR_MINUTE`, `RATE_LIMIT_COUTEUX_PAR_MINUTE`, le plafond par ESPACE de l'API
publique (une minute et une heure, `/v1` et `/mcp` confondus, `src/auth/plafond-espace.ts`, depuis le 2026-09-25),
le compteur par clé du relais du Meta Business Agent, le préfiltre, les opérations lourdes simultanées et le
compteur d'usage de `/ops/usage` comptent en mémoire, par processus. N copies servent N fois le plafond annoncé,
et `/ops` ne voit que la copie qu'il interroge.

⚠️ **Tant que l'API était bornée à deux copies, le pire cas était un plafond DOUBLÉ, connu et borné** (120 appels
par minute et 2 000 par heure pour un espace, au lieu de 60 et 1 000). Une API élastique n'a plus cette borne :
d'où le passage en base des plafonds partagés, ci-dessous.

**La solution : Postgres d'abord, Redis quand la mesure le demande.** Voir §9.

**Livré le 2026-09-28** (lot B de `docs/superpowers/plans/2026-09-28-api-multi-instances.md`, migration 0186), et
**éprouvé au banc le 2026-10-02** (`scripts/banc-deux-api.mts`) : le plafond par espace est global (54 appels
acceptés et 76 refusés sur 130 tirs alternés entre les deux copies, plafond 60), et une clé révoquée est refusée
tout de suite par les DEUX copies.
Un compteur Postgres par fenêtre fixe (`compteurs_debit`, derrière l'interface `CompteurDebit` de
`src/db/debit.ts` : le jour de Redis, c'est un adaptateur de plus), une écriture par appel compté, précédé dans
chaque copie de la mémoire de ses fenêtres pleines (un refus répété ne coûte plus rien). Comptent au TOTAL : le
plafond par espace de l'API publique et ses `x-ratelimit-*`, les opérations coûteuses, les plafonds de connexion,
l'usage de `/ops/usage`, les refus de `/ops` et le repos de leur alerte ; la minute entre deux demandes de code d'un
numéro est un verrou court. Chaque plafond a sa politique écrite quand la base ne répond pas (connexion et code :
refus ; API publique, coûteux, usage : l'appel passe). Restent par copie, délibérément et écrit dans
`documentation.md` § 7 : le plafond par utilisateur (le plus fréquent), les petits plafonds (aide, support,
chaîne, relais du Meta Business Agent, budgets des clés et codes jamais vus, codes de `/w` et `/rcs/callback`,
second facteur), les places d'opérations lourdes simultanées (elles protègent le pool DE LA COPIE) et les caches
sans invalidation. La borne « deux copies au plus » tombe donc pour les plafonds ; le maximum de l'autoscaler se
déduit du budget de connexions (§7.5).

⚠️ **La clé « par IP » de la connexion n'est pas l'adresse du client** (`req.ip` = le proxy, Fastify sans
`trustProxy`) : aujourd'hui un plafond par identité tentée pour toute la plateforme, ce qui est juste. Derrière un
répartiteur qui présenterait plusieurs adresses sources, une même identité se répartirait sur plusieurs clés. À
régler côté infra (§7.3, §7.7), pas dans le code des plafonds.

### 3.4 Les pièces jointes de l'assistant MBA doivent quitter la mémoire

**Le problème, que la version du 2026-09-15 avait oublié** et que le mémo du 2026-09-19 a relevé.
`src/mba/assistant/pieces-jointes.ts` range en MÉMOIRE, pendant deux heures, les documents qu'un client dépose
dans la conversation de l'assistant, en attendant qu'il accepte le diff. Le fichier le dit lui-même (« LE
MAGASIN EST EN MÉMOIRE, DONC LOCAL AU PROCESS »). Avec deux copies d'API, le dépôt arrive sur l'une et
l'application sur l'autre : « document déposé plus disponible ».

**La solution** : l'Object Storage (§6), avec une expiration automatique de deux heures. Le magasin est déjà
derrière une interface (`MagasinPiecesJointes`) : c'est un remplacement d'implémentation, pas une réécriture.

✅ **Résolu autrement le 2026-09-28 : retiré.** La route de dépôt n'avait plus d'appelant depuis le retrait du
bouton « Joindre » (2026-09-24) ; elle est partie avec son magasin et l'opération `fichier.ajouter`. Un document se
dépose par l'onglet Fichiers, qui l'envoie à Meta sans rien garder (lot A de
`docs/superpowers/plans/2026-09-28-api-multi-instances.md`).

### 3.5 Une copie tuée ne doit coincer aucune clé d'idempotence

✅ **Trouvé par le second banc et corrigé le 2026-10-03** (`0c476865` puis `f74ebb59`, migration 0203). Une copie
tuée net (SIGKILL) entre la pose d'une clé de `POST /v1/sends` et son scellement la laissait « en cours » 24 h :
trois arrêts brutaux sur cinq. Avec l'autoscaling, chaque réduction du nombre de copies qui tue sans arrêt propre
l'aurait reproduit. Le correctif donne à la clé les pièces d'un verrou (un bail de 5 min et un jeton de garde), et
crée la campagne ET scelle la clé dans UNE transaction : jamais de campagne sans la clé qui la désigne. Rejoué au
banc : la clé coupée aboutit une fois le bail passé, zéro campagne orpheline. ⚠️ Ce que la cible doit respecter :
le délai d'arrêt d'une copie (SIGTERM puis SIGKILL) reste très en deçà du bail, et l'arrêt propre laisse finir ce
qui est en vol (mesuré : zéro requête coupée sur 909 à l'arrêt propre).

---

## 4. Ce qui est DÉJÀ juste, et qu'il ne faut surtout pas casser

Vérifié dans le code le 2026-09-15. C'est la vraie réponse à « devra-t-on tout reconstruire » : **non**, parce
que ces sept propriétés sont déjà là, et aucune n'est un hasard.

- **L'API et le worker sont déjà deux points d'entrée distincts** (`src/index.ts`, `src/worker.ts`) qui
  partagent le code sans partager le cycle de vie. Le découpage que la cible exige est fait.
- **`tenant_id = $1` sur chaque requête**, tenu par `tests/scope-tenant.test.ts`. Clé d'isolation aujourd'hui,
  clé de découpage le jour où une base ne suffira plus.
- **Aucun état sur disque.** Les médias RCS vivent aujourd'hui en base (`rcs_media`). Un conteneur qui meurt
  n'emporte rien. ⚠️ Ils sortiront de Postgres vers l'Object Storage (§6), qui GARDE cette propriété : un
  bucket n'est pas un disque local.
- **Aucun websocket**, l'Inbox interroge en HTTP. Donc aucune session collante devant plusieurs copies.
- **Le schéma vit dans `db/migrations/`**, pas dans un tableau de bord. Base neuve + `npm run migrate` le
  reproduit entièrement, configuration de recherche `french_sans_accent` comprise.
- **Aucune dépendance spécifique à Supabase** : ni bibliothèque maison, ni Storage, ni Auth, ni PostgREST.
  Du PostgreSQL nu. ⚠️ **C'est la propriété la plus fragile de la liste** : elle se perd le jour où quelqu'un
  branche une brique propriétaire pour aller vite, et personne ne s'en aperçoit avant le devis de migration.
  L'Object Storage de §6 se parle en protocole S3, standard : il ne la casse pas.
- **`api.messagingme.app` est un NOM derrière Cloudflare.** Changer d'hébergeur coûte un enregistrement DNS,
  et le webhook de Meta n'a jamais à être reconfiguré.

---

## 5. Deux workers : décidé par Julien le 2026-09-21, en production depuis le 2026-10-03

✅ **Déployés le 2026-10-03** (`WORKER_ROLE`, partition dans `src/worker/roles.ts`, un battement par rôle dans
`/ops`). Essai réel fait le même jour : un message entrant traité par le principal, son analyse par l'autre. UNE
copie par rôle, toujours (§3.2).

« Je veux vraiment à terme deux workers. » **Deux RÔLES, pas deux microservices.**

**Le worker principal** porte tout ce qui fait fonctionner le produit dans l'instant : messages entrants
(`webhook`), accusés (`webhook-status`), campagnes (`campaign-run`), scénarios et automations, tours d'agent
(`agent-turn`), poussées d'opt-out, et les tâches d'exploitation indispensables.

**Le worker d'analyse** porte les traitements différés que personne n'attend : `analyze-conversation`,
`push-analysis`, `hubspot-catchup`, le balayage des conversations à analyser, les agrégats et la rétention
propres aux analyses.

### 5.1 Ce que ça apporte, et ce que ça n'apporte pas

- Une panne, une fuite mémoire ou un redémarrage de l'analyse ne touche plus les entrants ni les campagnes.
- Chaque rôle a son processeur, sa mémoire et ses concurrences ; l'analyse peut grandir seule.
- ⚠️ **Ça ne réduit PAS la charge de la base** : les deux rôles parlent à la même. Mal borné, ça l'augmente
  (un pool et une écoute de notifications de plus).
- ⚠️ **Ça ne débloque rien aujourd'hui** : un appel lent au modèle ne bloque déjà pas le worker (les places
  de chaque file sont séparées, et l'attente du modèle ne tient aucune connexion). Le gain est l'ISOLATION,
  pas le débit.

### 5.2 La forme, et elle reste simple

- Même dépôt, même image Docker, mêmes types, mêmes stores. **Aucun copier-coller** de `worker.ts`.
- Une variable **`WORKER_ROLE=principal|analyse`** décide seulement quelles files et quelles tâches minutées
  sont enregistrées.
- Aucune API HTTP entre les deux : pg-boss sur Postgres est déjà le contrat durable.

### 5.3 Les pièges à traiter au découpage, tous

1. **Un seul superviseur pg-boss** : le principal. L'analyse démarre avec `supervise: false`, sinon la
   maintenance des files est faite deux fois.
2. **Le heartbeat devient PAR RÔLE.** La table porte aujourd'hui une seule ligne `worker` : deux processus
   l'écraseraient à tour de rôle et `/ops` croirait les deux vivants tant que l'un l'est. `/ops` contrôle
   chaque rôle séparément.
3. **Les tâches minutées sont RÉPARTIES, jamais dupliquées** : chacune appartient à un rôle (§3.2).
4. **Arrêt propre** : chaque rôle n'arrête que ses consommateurs et ses minuteries, avec la garantie d'aujourd'hui.
5. **Alertes identifiables** : préfixes `[worker-principal]` et `[worker-analyse]`.
6. **Pools bornés par rôle**, et le total recalculé (§7.5), écoute de notifications comprise.
7. **Concurrence d'analyse bornée.** Sortir l'analyse n'autorise pas à vider la file en parallèle : la base et
   le fournisseur du modèle restent les mêmes.
8. **L'arbitre de débit Meta reste PARTAGÉ.** Aucun limiteur local par worker.

### 5.4 Pas de troisième worker pour `webhook-status`

La file est déjà séparée des entrants, et sa concurrence reste à un pour protéger la base. ⚠️ **Le mémo
affirmait que son seuil de rafale était « corrigé » : c'est faux.** Mesuré le 2026-09-16 dans `pgboss.job`, la
rafale ne se déclenche presque jamais sur les petits paquets d'accusés, parce que pg-boss décide sur un
compteur qui peut avoir deux minutes de retard (détail : `todo.md`). Elle fonctionne sur l'avalanche d'une
campagne, et **Julien a arbitré le 2026-09-16 que seul ce cas compte**. Un troisième processus ajouterait un
pool, un heartbeat et une surface d'exploitation sans rien régler de mesuré.

---

## 6. Les fichiers sortent de Postgres : décidé par Julien le 2026-09-21

📅 **Quand : APRÈS la bascule Scaleway, en lot séparé** (décidé par Julien le 2026-10-04). Les médias RCS partent
donc dans le dump du jour J, ce qui ne coûte rien à notre taille (10 Mo pour 28 images, mesuré le 2026-10-04), et leur
volume est suivi dans `/ops` (carte « Stockage en base », rouge au-delà de 500 Mo de fichiers) : c'est elle qui dira
si le lot doit être avancé.

« Avoir une base à part pour les fichiers RCS et MBA, ça nettoie l'architecture de la base Postgres. »

**« À part » veut dire l'Object Storage, pas une seconde base PostgreSQL.** Une seconde base garderait tous
les défauts qu'on veut retirer (sauvegardes alourdies, dump de bascule plus long, connexions en plus) ; un
stockage objet est fait pour des fichiers, se facture au volume et expire seul.

- **Médias RCS** : les originaux et les variantes nécessaires à l'envoi, bucket privé, conservés selon une
  durée métier **à décider** (§13).
- ~~Pièces jointes de l'assistant MBA~~ : plus rien à stocker, le dépôt est retiré (§3.4).
- **Postgres ne garde que les métadonnées** : `tenant_id`, clé d'objet, type constaté, taille, expiration,
  statut.
- **Jamais un bucket public**, même pour simplifier une URL. L'accès tiers passe par une URL signée courte ou
  par une route contrôlée ; les droits IAM sont limités, par programme, à ses préfixes.

🔴 **LES ADRESSES `/m/` DÉJÀ ENVOYÉES DOIVENT CONTINUER DE RÉPONDRE.** Un visuel RCS parti dans un message
livré porte une adresse `/m/<code>` qui circule chez le destinataire : c'est une porte à SENS UNIQUE, comme
`/r/`. La route `/m/` reste donc, et va chercher l'objet dans le bucket au lieu de la table. On ne donne
jamais l'adresse du bucket à l'extérieur.

🔴 **LA SORTIE DE `rcs_media.bytes` SE FAIT EN DEUX MIGRATIONS**, selon la règle du dépôt (« l'ancien code
survit-il à ce changement ? ») : d'abord écrire les nouveaux fichiers dans le bucket et savoir lire les deux
emplacements, puis recopier l'existant, et SEULEMENT APRÈS retirer la colonne. Retirer d'abord casserait
chaque visuel déjà distribué.

⚠️ **Durée des URL signées, à décider (§13)** : elle doit couvrir un téléchargement TARDIF par l'opérateur RCS,
pas seulement l'envoi.

---

## 7. Réseau et sécurité à Scaleway

### 7.1 Le réseau privé n'est pas une adresse

Le VPC (Private Network) est le réseau commun des composants. Il n'est pas joignable depuis Internet et n'a pas
d'URL. Cloudflare n'y « entre » jamais. L'API serverless a deux côtés : une porte HTTP gérée par Scaleway,
appelée par Cloudflare, et une sortie vers le réseau privé, qu'utilise son code pour parler à la base.
**L'API ne doit jamais devenir un relais générique vers le réseau privé** : seul son code y appelle quelque
chose. (Scaleway permet ce rattachement d'un conteneur serverless à un réseau privé, vérifié dans sa
documentation le 2026-09-21.)

### 7.2 La base : endpoint privé, et l'endpoint public SUPPRIMÉ

À sa création, une base managée reçoit un endpoint public. La séquence est **obligatoire et dans cet ordre** :
créer l'endpoint privé, basculer les programmes dessus, puis **supprimer** l'endpoint public. ⚠️ Une liste
d'adresses autorisées sur l'endpoint public n'est pas équivalente : elle se desserre par erreur, une absence
d'endpoint ne se desserre pas.

### 7.3 Cloudflare reste la SEULE porte de l'API

```
Meta, opérateur RCS, client /v1
   -> api.messagingme.app -> Cloudflare (ajoute ou ÉCRASE X-Auth-Token)
   -> conteneur Scaleway PRIVÉ -> API Engage Me
```

- Le conteneur est **privé** : un appel direct sur son nom technique `*.scw.cloud`, sans le jeton, est refusé
  AVANT d'atteindre l'application. ⚠️ Le nom technique n'est pas un secret, il ne protège rien à lui seul.
- Le jeton est **un secret technique d'ORIGINE**, sans rapport avec les clés `mba_...` des clients : le
  premier autorise Cloudflare à joindre le conteneur, les secondes autorisent un client à se servir d'Engage Me.
- **Solution retenue : une règle de réécriture d'en-tête (Request Header Transform Rule) sur le nom
  `api.messagingme.app`**, qui ÉCRASE `X-Auth-Token` (écraser, pas ajouter : sinon un client pourrait envoyer
  le sien). **Disponible sur l'offre gratuite de Cloudflare**, dix règles actives, vérifié le 2026-09-21.
  Variante si l'on veut le jeton masqué dans l'interface : un Cloudflare Worker avec un secret (offre payante
  des Workers, qui n'est PAS Cloudflare Pro). Pas de Worker si la règle suffit.
- ⚠️ **Le format exact du jeton côté Scaleway est à relire le jour du chantier** : la documentation annonce une
  migration de l'authentification des conteneurs privés vers IAM, donc le jeton est vraisemblablement une clé
  IAM à droits restreints, à faire tourner comme telle.

### 7.4 Les workers sortent par une Public Gateway, et n'entrent par rien

Les workers vivent sur des instances **sans adresse publique**. Or ils APPELLENT l'extérieur : Meta, Anthropic,
le Gateway de Vercel, HubSpot, les connecteurs des clients. **Sans passerelle de sortie, ils ne joignent rien.**
Il faut une **Public Gateway** sur le réseau privé (sortie seule, aucune entrée), et son coût. ⚠️ Le mémo du
2026-09-19 l'avait oubliée : c'est la pièce qui aurait manqué le jour J.

⚠️ **L'API APPELLE AUSSI LES CONNECTEURS DES CLIENTS, depuis le relais du Meta Business Agent (2026-09-21,
migration 0161).** Meta appelle `POST /mba/relais/outils/:id` et attend la réponse pendant que l'API fait
l'appel au système du client, de façon SYNCHRONE (`src/http/mba-relais.ts`). Deux conséquences pour la cible :
l'API a besoin elle aussi d'une sortie vers Internet, et le temps de ces appels (jusqu'au `timeoutMs` de
l'outil) occupe une requête de l'API, donc compte dans son dimensionnement, pas seulement dans celui des
workers.

### 7.5 Le budget de connexions se recalcule, il ne se recopie pas

```
  N x API        (pool applicatif SEUL : DB_POOL_MAX chacune ; pg-boss l'emprunte, §3.1)
+ worker principal (pool applicatif + consommateur pg-boss PGBOSS_MAX + écoute de notifications)
+ worker analyse   (pool applicatif + consommateur pg-boss, écoute seulement si elle sert)
+ marge pour les migrations et l'administration
  <= nombre de connexions de l'offre choisie, relu À LA CRÉATION de la base
```

🔴 **Le coût d'une copie d'API ne dépend plus de `PGBOSS_MAX`** (§3.1, livré le 2026-09-28) : elle ne tient plus
aucune session, seulement ses `DB_POOL_MAX` clients du pool applicatif, qui portent aussi ses enfilements. Le
maximum de l'autoscaler se lit donc dans ce calcul : ce qui reste après les workers et la marge, divisé par
`DB_POOL_MAX`. Derrière un pooler en mode transaction, ce reste se compte en CLIENTS du pooler (sa limite de
clients), pas en connexions de la base, qui restent celles du pool du pooler.

⚠️ **Ne pas recopier `DB_POOL_MAX=8` sur chaque processus sans ce calcul.** Un pooler ne crée aucune capacité
Postgres : il fait partager des connexions qui, sinon, resteraient occupées pour rien.

🔴 **CE CALCUL EST DÉSORMAIS UN TEST, ET IL SE NOURRIT D'UNE MESURE** (2026-10-03). `tests/budget-pooler.test.ts`
lit `docker-compose.yml`, où chaque service fixe ses tailles, et refuse un compose qui dépasse le pool du pooler,
des sessions au-delà du même pool, ou un pire cas au-delà de 80 % des connexions de Postgres. Ce que la mesure a
appris sur Supabase : la « capacité de 16 clients » était le réglage « Pool Size » (15, plus un), qui vaut par
utilisateur, base et MODE, et que Julien a monté à 30 ; nos pools en promettaient déjà 19, et celui de l'API
saturait 6 % de ses prises de connexion. **Sur la base Micro actuelle, le budget plafonne à DEUX copies d'API de 8
connexions.** À la cible : relever la limite de connexions de l'offre (et l'éventuel pooler, dont le réglage se
MESURE avec la sonde décrite en tête du test, puisqu'un réglage enregistré n'est pas un réglage appliqué), mettre
à jour les constantes du test, et c'est lui qui donne le maximum de copies de l'autoscaler. ⚠️ pg-boss garde ses
connexions en mode SESSION (écoute, supervision, migration) : la cible doit offrir des connexions directes aux
workers, pas seulement un pooler en mode transaction.

### 7.6 Les webhooks de statut ne subissent JAMAIS les quotas des clients

Le même limiteur de clé API protège volontairement `/v1/*`, `/mcp` et le relais d'outils du MBA
`/mba/relais/outils/*` ; ce dernier porte une clé et un droit dédiés à Meta. Il ne doit **jamais** déborder sur
`/webhooks/meta`, `/rcs/callback/*`, `/w/*`, `/hubspot/deal-stage`, ni par effet de bord à `/r/*` et `/m/*`.
Meta peut renvoyer une
rafale de statuts après un retard, et un appel de machine à machine ne passe pas de défi navigateur. Ces
chemins gardent leurs protections propres : signature Meta, code opaque RCS, secret du webhook entrant,
limites de taille, mise en file immédiate. C'est déjà le cas aujourd'hui (le plafond par utilisateur est posé
dans `makeRequireAuth`, que les webhooks ne traversent pas) : la règle est à ne pas casser dans les règles
Cloudflare de demain.

### 7.7 Deux vérités sur Cloudflare à ne pas perdre

- **La console n'est PAS derrière Cloudflare** : `engageme.messagingme.app` pointe directement sur Vercel
  (vérifié par DNS le 2026-09-21). On ne met pas Cloudflare devant Vercel pour rendre un schéma vrai.
- **L'adresse que Cloudflare annonce pour le client (`CF-Connecting-IP`) n'est fiable que si l'origine refuse
  tout ce qui ne vient pas de Cloudflare.** Sinon quiconque joint l'origine en direct l'invente. Notre code ne
  s'y fie nulle part (Fastify est construit sans `trustProxy`) : la règle vaut pour le jour où il s'y fierait.
- **Cloudflare Pro est retenu pour la cible**, non parce que le mot « Pro » constitue une preuve, mais pour
  activer et régler le Cloudflare Managed Ruleset, davantage de règles personnalisées et jusqu'à deux règles
  de limitation de débit. L'OWASP Core Ruleset reste éteint par défaut et ne s'ajoute qu'après une mesure qui
  justifie ses faux positifs possibles. La protection DDoS standard existe déjà sur toutes les offres ; elle
  ne doit pas être présentée comme un gain propre à Pro.
- **Pro ne remplace pas les contrôles applicatifs.** Ses limites de débit ne savent pas porter nos quotas par
  clé et par espace avec la précision du code : Pro compte seulement par IP et ses compteurs ne sont pas exacts
  à la requête près. On ne configure pas deux règles pour remplir deux cases. Les deux candidats utiles sont
  un fusible large sur l'API externe (`/v1` **et** `/mcp`) et les seuls chemins anonymes d'authentification qui
  écrivent. Les quotas et limites par discriminant restent dans Engage Me.
- **Cloudflare voit bien l'IP du navigateur sur l'auth actuelle.** `engageme.` ne relaie rien : le navigateur
  appelle `api.` directement (`documentation.md`, §2). Le seuil doit néanmoins tolérer une entreprise entière
  derrière une IP partagée. La règle vise la liste exacte des POST sensibles, jamais `/auth/config` ni le
  préfixe `/auth/*` entier ; un refus HTTP est plus sûr qu'un challenge sur un appel `fetch`.
- **Pro ne fournit pas la MFA de `/ops`.** Le plan de zone Cloudflare et Cloudflare Access sont deux produits
  différents ; la cible de comptes nominatifs et MFA applicative pour l'administration reste entière.
- **Aucun challenge navigateur sur les appels machine à machine**, y compris `/v1`, `/mcp`, Meta, RCS,
  HubSpot et les webhooks entrants. Ils ne peuvent pas résoudre un CAPTCHA. Une exception WAF est étroite et
  vise seulement la règle qui produit un faux positif ; elle ne retire ni validation de signature, ni limite
  de taille, ni mise en file rapide (§7.6).
- **Les événements WAF de Pro ne sont pas un journal de sécurité durable.** La rétention du tableau Security
  Events est courte et Logpush HTTP n'est pas inclus dans Pro. Cockpit et les journaux applicatifs restent la
  preuve durable ; Cloudflare apporte une preuve de filtrage et des captures/export périodiques, pas un SIEM.
- **`engageme.messagingme.app` reste hors de Cloudflare.** Le frontend continue d'utiliser les protections
  Vercel. Il est faux de dessiner Cloudflare devant les trois domaines pour simplifier un questionnaire.

---

## 8. Le connecteur HubSpot : sa propre base, et il dort quand personne ne s'en sert

🔴 **Décidé par Julien le 2026-10-04 : le connecteur part sur sa propre base CHEZ SCALEWAY, EN PREMIER, comme
RÉPÉTITION, quelques jours avant le jour J d'Engage Me (§10, étape 0).** Trois raisons :
- c'est petit (un seul portail branché) et moins critique : on répète chez Scaleway les gestes du jour J (base
  managée, réseau privé, endpoint privé, migrations, restauration, chaînes de connexion) sur un produit qui peut se
  permettre un raté ;
- ses connexions sortent du budget de la base principale AVANT qu'on refasse le calcul du §7.5 avec le vrai chiffre ;
- 🔴 **jamais le même jour que la bascule de la base principale** (audit du 2026-10-02) : deux déménagements à la
  fois, un incident devient impossible à attribuer et à annuler.

⚠️ **Le préalable bloquant de cette étape** : `mba` lit le schéma `mmhs` en cross-schéma, en un seul point
(`getHubspotPortal`, `src/account/store.pg.ts`, le portail lié à un espace) qui a deux consommateurs : l'écran du
compte et l'interrupteur HubSpot des réglages (`hubspotPortalConnecte`, `src/index.ts`). 🔴 Ce second-là traduit
`42P01` (schéma absent) en « aucun portail relié » : une fois `mmhs` sur une autre base, il affirmerait EN SILENCE
qu'aucun espace n'a de portail, et laisserait éteindre HubSpot par-dessus un portail relié. Ce point doit donc
passer par un appel au connecteur AVANT la répétition, en lot à part.

Ce qui suit est le raisonnement d'origine, toujours juste sur le fond ; seule sa conclusion « c'est la présence de
clients réels qui déclenche » est remplacée par la décision ci-dessus.

**Le constat de Julien** : un client qui n'a pas HubSpot subit quand même les connexions du connecteur.
C'est exact. Mesuré le 2026-09-15 : **un seul portail branché**, le portail cobaye, pour 4 connexions de
session retenues (2 processus x 2).

⚠️ **Mais le grain n'est pas le client, c'est le PROGRAMME.** Le connecteur est UN programme qui sert TOUS
les clients : il tient ses connexions parce qu'il TOURNE, pas parce qu'un client s'en sert. « Un client sans
HubSpot ne prend pas de lignes » n'est donc pas réalisable tel quel, il faudrait un programme par client.

L'intention est juste, et elle s'obtient par deux gestes distincts :

**a) Sa propre base (la réponse structurelle).** Le connecteur a DÉJÀ son schéma séparé (`mmhs`), mais un
schéma est un DOSSIER : les connexions, la mémoire et le processeur appartiennent au SERVEUR, pas au dossier.
C'est pour ça que le partage se voit malgré la séparation déjà faite.

🔴 **« Sa propre base » veut donc dire SA PROPRE MACHINE, et une seconde base sur le MÊME serveur ne règle
rien** : la limite de connexions est celle du serveur. La nuance décide de tout, et elle a un prix, un second
serveur managé.

⚠️ **LA QUESTION N'EST DONC PAS TECHNIQUE, ELLE EST COMMERCIALE.** Tant que le connecteur est une démo à un
portail, lui payer une machine pour libérer quelques connexions serait absurde ; on baisse sa consommation,
c'est une variable d'environnement. Le jour où il porte de vrais clients, il prend sa machine et le couplage
disparaît pour toujours. ~~C'est la présence de clients réels qui déclenche, pas la bascule Scaleway.~~ Remplacé par la décision du 2026-10-04, en tête de ce paragraphe.

⚠️ Vérifier avant, dans les deux cas : `mba` lit `mmhs` en cross-schéma aujourd'hui (voir `CLAUDE.md`), il
faut savoir OÙ et remplacer ces lectures par un appel.

**b) L'endormir (l'économie, en bonus).** Un conteneur serverless peut descendre à zéro copie et se réveiller
à la première requête. Zéro portail branché, zéro copie, zéro connexion ; un client s'y branche, ça se
réveille. ⚠️ Sa partie WORKER ne peut pas dormir de la même façon (§1) : si elle doit tourner, elle tourne,
mais sur sa propre base ça n'impacte plus personne.

**(a) supprime le problème, (b) supprime le coût.** (a) est celle qui compte.

---

## 9. Redis : oui un jour, non maintenant, et pas pour la raison qu'on croit

⚠️ **Redis n'est PAS ce qui rend possible d'avoir plusieurs API.** Plusieurs copies fonctionnent sans lui ; ce
qui a besoin d'un état partagé, ce sont seulement les **compteurs** (§3.3). Redis est l'outil de l'état
partagé à haute fréquence et courte vie, ce que des plafonds par minute sont exactement.

**Pourquoi Postgres d'abord.** Un compteur de plafond, c'est une écriture PAR REQUÊTE sur le chemin chaud.
Postgres le tient sans difficulté à notre volume, et n'ajouter aucun composant, c'est n'ajouter aucune panne
possible.

⚠️ **Le mémo du 2026-09-19 tenait Redis pour OBLIGATOIRE avant deux copies d'API. Position non reprise** :
les plafonds partagés sont comptés en base au total des copies depuis le 2026-09-28 (§3.3), et Redis ajouterait
un service payant et un mode de panne de plus sans rien fermer de plus.

**Le déclencheur qui ferait passer à Redis** : quand l'écriture du compteur devient elle-même une charge
visible, c'est-à-dire quand on mesure des écritures de plafond au même ordre de grandeur que le trafic métier.
Le nombre de copies n'en est plus un depuis le 2026-09-28 : le compteur en base tient le plafond au total, quel
que soit ce nombre. Scaleway a un Redis managé, qui se rattache au même réseau privé ; la bascule sera un
changement d'implémentation derrière la même interface.

🔴 **Écrire le compteur derrière une interface DÈS le chantier 3.3**, précisément pour que ce jour-là ce soit
un remplacement et pas une réécriture. ✅ Fait : `CompteurDebit` (`src/db/debit.ts`), un adaptateur Postgres et un
compteur en mémoire pour les tests ; Redis en serait un troisième.

---

## 10. Le jour J : la séquence

**Prérequis, à valider AVANT de commencer :**

1. Les chantiers du §3 sont finis et déployés sur l'infrastructure actuelle. ✅ Fait au 2026-10-03 (§3.1, §3.3
   et §3.5 éprouvés au banc, §3.4 retiré) ; §3.2 seulement si un rôle de worker passe à deux copies.
1 bis. ✅ **La migration 0060, vérifiée le 2026-10-03** : la ligne `0060_email.sql` de la production est l'ancien
   nom de `0062_email.sql`, dont le SQL est identique (seuls des commentaires diffèrent) et entièrement en
   `if not exists`. Une base neuve obtient les mêmes objets (`CLAUDE.md`, compteur de migrations).
2. **pgvector existe chez la destination.** Seule extension non universelle dont ce produit dépend
   (`agent_knowledge.embedding`, fiches d'aide). `pg_trgm` et `unaccent` sont des contribs standard.
   `pgcrypto` ne sert qu'à `gen_random_uuid()`, natif depuis PostgreSQL 13.
3. **Le connecteur HubSpot tourne déjà chez Scaleway, sur sa propre base** (étape 0 ci-dessous), et `mba` ne lit plus
   `mmhs` en cross-schéma (§8).
4. **Les fichiers RCS restent en base pour la bascule** (décidé le 2026-10-04) : ils partent dans le dump et sortent
   vers l'Object Storage APRÈS, en lot séparé (§6).

**La séquence :**

0. **Quelques jours avant, la répétition : le connecteur HubSpot** sur sa propre base Scaleway (§8). Les mêmes gestes
   qu'aux étapes 1, 2, 4, 5 et 8, sur ce seul produit ; puis vérifier dans `pg_stat_activity` de la base Engage Me
   qu'il n'y ouvre plus aucune session, et qu'une synchronisation réelle passe dans les deux sens. Ce qui a coincé
   s'écrit ici avant le jour J.
1. Créer le projet, le réseau privé et tous les composants dans **une seule région, PAR**.
2. Créer la base managée, relever son nombre de connexions, **créer l'endpoint privé**, et refaire le calcul
   du §7.5 avec le vrai chiffre : mesurer (la sonde), puis mettre à jour les constantes de
   `tests/budget-pooler.test.ts` et les tailles de chaque service.
3. ~~Créer l'Object Storage privé~~ : reporté au lot des fichiers, APRÈS la bascule (§6).
4. `npm run migrate` sur la base neuve. Vérifier `schema_migrations` et la présence de `french_sans_accent`.
5. **Fenêtre de maintenance**, puis `pg_dump` / `pg_restore` des données.
   🔴 **À notre taille (30 Mo), quelques minutes de fenêtre suffisent, et c'est un luxe qu'on perd en
   grandissant.** C'est un argument pour basculer TÔT : à 30 Go il faudra de la réplication logique, donc un
   chantier au lieu d'une commande. Sortir les fichiers de la base (§6) garde ce luxe plus longtemps.
6. Poser la **Public Gateway**, puis déployer les deux rôles de worker sur des instances sans adresse publique.
7. Déployer l'API : conteneur **privé**, **min 1 / max donné par le budget du §7.5**, rattaché au réseau privé,
   secrets fournis par le gestionnaire de secrets de Scaleway (jamais dans l'image), contrôle de vie léger qui ne
   dépend pas de la base, délai d'arrêt très en deçà du bail de la clé d'idempotence (§3.5). ⚠️ **Le nom de chaque
   copie dans `/ops`** (`API_COPIE`) : si l'hébergeur donne la même configuration à toutes les copies, leurs
   attentes de pool se fondront dans une seule courbe ; dériver alors le nom du nom d'hôte de la copie (petit lot
   de code à prévoir avant, `src/index.ts`).
8. **Supprimer l'endpoint public de la base.**
9. Brancher Cloudflare : pendant la validation du certificat chez Scaleway, l'enregistrement peut rester en
   « DNS only » ; ensuite, proxy activé, règle du jeton d'origine posée, et **vérifier que l'appel direct au
   conteneur est refusé**. ⚠️ Le webhook de Meta n'a rien à reconfigurer, c'est tout l'intérêt d'avoir un NOM.
10. Garder `mba.messagingme.app` : `/api/backend/webhooks/meta` vers la nouvelle API (préfixe retiré), les
    anciens `/r/`, `/m/` et `/mcp` vers la nouvelle API, le reste du site vers `engageme.messagingme.app`
    (l'ancien conteneur `mba-web` disparaît).
11. ~~Le connecteur HubSpot~~ : déjà parti, à l'étape 0 (§8).
12. Dérouler les **tests d'acceptation du §11**.
13. **Ne couper OVH qu'après une période d'observation et un retour arrière ÉPROUVÉ**, pas seulement écrit.

**Ce qu'on garde à Supabase le temps de vérifier** : rien. Une base lue par deux endroits est une base qui
diverge. La bascule est franche, et le retour arrière est la restauration du dump.

---

## 11. Les tests d'acceptation : la bascule n'est finie que si ces preuves existent

**Le chemin public**
- `https://api.messagingme.app/live` répond, à travers Cloudflare.
- Le nom technique du conteneur, appelé en direct sans le jeton d'origine, **refuse**.
- `mba.messagingme.app/api/backend/webhooks/meta`, les anciens `/r/` et `/m/` fonctionnent toujours.
- Les Managed Rules Cloudflare sont actives sur `api.` et `mba.`, avec leur configuration exportée ou capturée.
- Toute règle de débit Pro réellement activée est testée sur ses chemins exacts ; un dépassement est visible
  dans Security Events et ne touche aucun webhook, callback RCS, relais MBA/HubSpot, lien `/r/` ni média `/m/`.
- Un échantillon de faux positifs est relu avant de passer une règle sensible en blocage.

**Ce qui doit rester fermé**
- La base n'a plus d'endpoint public ; ni elle ni Redis (s'il existe) ne sont joignables d'Internet.
- Les buckets et les objets sont privés par défaut.

**Les vrais échanges**, jamais des simulations
- Un vrai message WhatsApp entrant est enregistré et traité.
- De vrais statuts `sent`, `delivered` et `read` sont consommés.
- Un vrai rappel RCS est traité, et un visuel RCS reste lisible pendant toute la durée qu'exige l'opérateur.
- ~~Une pièce jointe de l'assistant MBA est lisible depuis les DEUX copies d'API~~ : sans objet depuis le retrait
  de ce magasin (§3.4).

**L'API publique**
- `/v1` applique ses plafonds et rend un `429`, **sans que les webhooks en soient affectés**.
- Une clé révoquée est refusée par les DEUX copies d'API.
- Une copie d'API de plus n'ajoute aucune connexion de session à la base (compte avant et après, §3.1).
- **Le second banc rejoué sur la cible** (`scripts/banc-deux-api-2.mts`, ses cinq épreuves) : une clé, un envoi,
  entre deux copies ; arrêt propre sans requête coupée ; arrêt brutal, toute clé coupée aboutit une fois le bail
  passé, ZÉRO campagne orpheline ; webhooks acquittés sous pression de pool ; chaque copie sous son `DB_POOL_MAX`.
  Sa recette de montage est en tête de `scripts/banc-deux-api.mts`.

**Les deux workers**
- Tuer le worker d'analyse ne ralentit ni les entrants ni les campagnes.
- Tuer le worker principal déclenche l'alerte de heartbeat qui le NOMME.
- Les deux rôles sont visibles séparément dans `/ops`.

**La route IA optionnelle, seulement si elle a été achetée et livrée**
- Un espace témoin configuré Vercel passe toujours par Vercel et conserve outils, coûts et plafonds actuels.
- Un espace témoin configuré Azure appelle directement le déploiement régional attendu, avec un vrai appel
  d'outil et une réponse complète.
- Couper Azure ne provoque aucun appel à Vercel pour cet espace ; l'échec est borné, visible et alerté.
- Les preuves consignent fournisseur, région, type de déploiement et modèle, sans prompt ni secret.
- La liste des autres traitements IA encore hors de cette route est jointe à la réponse RSSI ; aucun « tout
  en France » n'est déclaré par extension.

**L'exploitation**
- Le commit déployé se lit depuis `/ops`, sans être exposé publiquement.

---

## 12. Ce qu'on ne fait PAS, et pourquoi

- **Kubernetes, service mesh, Kafka, RabbitMQ.** Ils résolvent l'orchestration de nombreux services sur de
  nombreuses machines. La marche d'avant, c'est un hébergeur de conteneurs avec un curseur « nombre de
  copies » : on déplace le curseur, on ne construit rien.
- **Des microservices.** Deux workers sont deux RÔLES d'un même programme (§5).
- **Plusieurs bases métier avant qu'un client ne gêne un autre.** Le découpage par client est PRÉPARÉ (§4), il
  n'est pas à faire. Le faire tôt coûterait des requêtes croisées impossibles et une exploitation doublée,
  pour un problème que personne n'a. (Le cas HubSpot du §8 est différent : ce n'est pas un client, c'est un
  autre produit. Et l'Object Storage du §6 n'est pas une base métier.)
- **Redis maintenant** (§9).
- **Un troisième worker pour les accusés** sans mesure nouvelle (§5.4).
- **Plus de copies d'API que le budget de connexions n'en permet** : il est tenu par `tests/budget-pooler.test.ts`
  (§7.5), qui refuse une copie de trop (deux sur la base Micro actuelle).
- **Un bucket public** pour simplifier une adresse, **des fichiers dans une seconde base PostgreSQL**, **un
  endpoint public de base laissé ouvert** « derrière une liste d'adresses ».
- **Un plafond de débit global** qui toucherait aussi les webhooks (§7.6).
- **Cloudflare Business/Enterprise, Logpush ou Bot Management** sans exigence précise. Pro est la cible ; les
  étages supérieurs ne s'achètent que pour une preuve ou une capacité absente et contractuellement nécessaire.
- **Un bouton de choix du fournisseur IA dans Engage Me.** C'est une option contractuelle posée par
  l'exploitation, pas une préférence utilisateur.
- **Azure Foundry Agent Service.** Engage Me possède déjà l'orchestration, la mémoire, les outils et la base
  de connaissance ; ajouter un deuxième moteur d'agents disperserait l'état sans répondre mieux au RSSI.
- **Un fallback automatique Azure vers Vercel** pour un espace dont le contrat exige la France (§2.1).

---

## 13. Ce qui reste à décider, et qui revient à Julien

Aucun de ces choix ne doit être remplacé par une valeur technique arbitraire.

1. **Les quotas par espace de l'API publique** : tranché par Julien le 2026-10-04, **à implémenter**. Par espace et
   par jour (remise à zéro à minuit, heure de Paris) : **2 000 envois** (destinataires de `/v1/sends` et messages
   libres WhatsApp ou RCS) et **20 000 fiches écrites** (`/v1/contacts`, une par fiche d'un lot). Réglables par espace
   depuis `/ops`, pour relever un client qui en a besoin ; refus lisible en 429 au-delà. Les lectures, les catalogues
   et le MCP restent sous le plafond d'appels existant (60 par minute, 1 000 par heure). Les campagnes lancées depuis
   la console ne comptent pas. Compteur en panne : l'appel passe, comme aujourd'hui, avec une alerte. Repères
   mesurés le jour de la décision : nos numéros sont au palier Meta de 250 personnes par jour ou sans palier connu,
   l'API sert 6 appels en deux heures, et sans quota une boucle pouvait viser 50 000 destinataires par heure.
2. **La durée de conservation des médias RCS**, et la purge qui va avec.
3. **La durée des URL signées RCS**, qui doit couvrir un téléchargement tardif par l'opérateur.
4. **Quand** les deux workers : tranché, déployés le 2026-10-03 (§5).
4 bis. **Où se fait l'autoscaling** : tranché par Julien le 2026-10-03, **à Scaleway**. Pas de seconde copie fixe
   sur le VPS (elle n'y créerait aucune capacité, toutes les copies partageant la même machine).
5. **Le niveau de disponibilité** acheté pour la base (développement, production, haute disponibilité) au
   premier client important.
6. **L'utilité réelle des règles de rate limiting Cloudflare Pro.** Candidats : un fusible large sur l'API
   externe (`/v1` et `/mcp`) et les chemins anonymes d'authentification qui écrivent. Ne les activer qu'avec
   des seuils mesurés tolérant les IP d'entreprise partagées ; ne jamais limiter `/auth/config`.
7. **L'accès à `/ops`** : tranché le 2026-09-28, comptes nominatifs (liste d'adresses) avec second facteur, jeton
   partagé supprimé (`docs/superpowers/plans/2026-09-28-ops-nominatif.md`).
8. **Le périmètre exact d'une option IA France.** Tours conversationnels seulement, ou également construction,
   embeddings, reranking, transcription, traduction et analyses. Le prix et la disponibilité régionale des
   modèles décident ; la documentation commerciale doit nommer le périmètre réellement testé.

---

## 14. Ce qui a été écarté du mémo du 2026-09-19, et pourquoi

- **« Le seuil de rafale de `webhook-status` a été corrigé »** : faux, mesuré le 2026-09-16 (§5.4). Sa
  conclusion (pas de troisième worker) reste juste.
- **« Redis est requis avant deux réplicas »** : non repris (§9).
- **« `/ops` avec MFA, cible décidée »** : c'est une recommandation, pas une décision (§13.7).
- **Les workers sans adresse publique, sans passerelle de sortie** : complété par la Public Gateway (§7.4).
- **L'absence de pooler dans son schéma** : acceptable tant que le maximum de copies déduit du budget tient dans
  les connexions directes (§7.5), à la condition écrite au §1.1.

---

## 15. La règle de fond

**On ne construit pas pour une échelle qu'on n'a pas mesurée.** Chaque plafond réel de ce produit a été
trouvé par la mesure, jamais par le raisonnement : les 16 clients vers le pooler (qui étaient le réglage « Pool
Size » de Supabase, 15, monté à 30 le 2026-10-03 : `tests/budget-pooler.test.ts`), les deux accusés par minute,
les dix-sept par seconde en rafale, les 738 000 jetons par minute du Gateway sans un seul refus.

Ce document ne demande donc rien à construire « au cas où ». Il nomme **quatre états-dans-un-processus à
supprimer avant de multiplier les processus**, **sept propriétés à ne pas casser** d'ici là, et **trois
décisions de structure** prises par Julien (deux workers, fichiers hors de Postgres, Cloudflare Pro). Tout le reste se
décidera avec des chiffres qu'on n'a pas encore.
