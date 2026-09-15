# Bascule Scaleway : le document qu'on actionne

> Écrit le 2026-09-15 à la demande de Julien, qui a raison : la matière était éparpillée entre `todo.md`,
> `CLAUDE.md` et `documentation.md`. **Ceci est la source unique.** Ailleurs, on met un pointeur vers ce
> fichier, jamais une copie.

Ce document ne décrit pas ce qui tourne aujourd'hui (voir `documentation.md`). Il décrit **ce qu'on vise**,
**les trois chantiers à finir avant**, et **la séquence du jour J**.

---

## 1. La règle qui gouverne tout : deux tiers, deux besoins OPPOSÉS

**L'API est élastique et sans mémoire.** « Élastique » veut dire que l'hébergeur démarre et arrête tout seul
des copies du programme selon le trafic : une visite, une copie ; cinq cents visites, dix copies ; la nuit,
zéro. Aujourd'hui rien ne l'est : il y a exactement un exemplaire de chaque, en permanence.

**Le worker est fixe et permanent.** Il tient des abonnements aux files et une écoute de notifications. Il ne
se réveille pas sur une requête HTTP, donc **un worker qui descend à zéro ne dépile rien, par construction.**

🔴 **Ces deux besoins ne se mélangent pas, et trois conséquences en découlent mécaniquement.** Elles ne
dépendent d'AUCUN fournisseur : elles valent chez Scaleway, chez Fly, chez n'importe qui. C'est la partie
ferme de ce document.

1. **Un tiers élastique DOIT passer par un pooler.** Le nombre de copies est élastique, le nombre de
   connexions à la base ne l'est pas. Sans pooler, la dixième copie tue la base au lieu d'ajouter de la
   capacité. Ce n'est pas une optimisation, c'est la condition d'existence de l'élasticité.
2. **Un tiers élastique ne peut tenir AUCUNE connexion de session.** Une connexion de session est retenue pour
   la vie du processus et ne se partage pas. Multipliée par un nombre de copies variable, elle donne une
   consommation que personne ne peut borner.
3. **Un tiers élastique ne peut porter AUCUN compteur en mémoire qui gouverne une décision.** Un plafond
   compté dans un processus est un plafond multiplié par le nombre de copies, sans que rien ne le dise.

---

## 2. La cible

```
                         Cloudflare
                              |
         +--------------------+--------------------+
         |                                         |
   Console (Vercel)                      api.messagingme.app
   engageme.messagingme.app                        |
                                    Scaleway Serverless Containers
                                        API x N  (ELASTIQUE, 0..N)
                                                   |
                                          [ POOLER, transaction ]
                                                   |
                                     PostgreSQL manage, region PAR
                                                   |
                                          [ SESSION, direct ]
                                                   |
                                        Workers x M  (FIXE, min 1)


   Connecteur HubSpot ----> SA PROPRE base (voir §5)
```

🔴 **La base part AVEC le calcul, jamais après.** Calcul à Paris et base à Londres, chaque requête traverse
internet. L'aller-retour est aujourd'hui de 11 ms mesurés ; entre deux fournisseurs il serait bien pire, et il
serait payé sur chacune des 131 transactions par minute mesurées AU REPOS, avant tout client. **Le calcul et
la base dans la même région, toujours.** Déménager l'un sans l'autre est un pas en arrière.

---

## 3. 🔴 Les trois chantiers à finir AVANT de basculer

Tous les trois ont la MÊME cause : **un état qui vit dans un processus, alors que le processus va devenir
multiple.** Aucun ne se voit aujourd'hui ; tous les trois se découvriraient en production le jour du premier
`scale`, c'est-à-dire au pire moment.

### 3.1 L'API ne doit plus réserver de connexion (le seul BLOQUANT)

⚠️ **RIEN N'EST CASSÉ AUJOURD'HUI, et il faut le dire avant tout le reste.** L'API réserve deux connexions
pour rien : c'est du gaspillage, pas une panne, et ça ne coûte aucune performance tant qu'il y a UN exemplaire.
Ce chantier est **facultatif maintenant, obligatoire avant de multiplier l'API**. Le faire tôt n'a qu'un
avantage, mais il est réel : le chemin touché est celui du dépôt de TOUTES les tâches, donc de l'arrivée de
tous les messages, et c'est plus sûr de l'éprouver sans trafic que le jour de la bascule.

**Le problème.** `src/index.ts` construit un client pg-boss sur `DATABASE_URL`, donc en mode SESSION, pour la
seule raison qu'elle EMPILE des tâches. Elle n'en dépile aucune et ne fait aucune maintenance
(`supervise: false`). Chaque copie d'API retient donc jusqu'à `PGBOSS_MAX` connexions réservées. Dix copies
élastiques en demanderaient vingt.

⚠️ **La panne existe déjà en miniature** : `DEPLOY.md` documente `EMAXCONNSESSION` au démarrage à froid **avec
deux processus seulement**, quand le pooler tient encore les sessions des conteneurs qu'on vient de tuer.
Aujourd'hui ça se résout seul en trente secondes. Avec des copies élastiques, ça devient permanent.

**La solution, et elle est prévue par la bibliothèque** (vérifié dans pg-boss 12.25 le 2026-09-15) :
`DatabaseOptions.db?: IDatabase` accepte une connexion FOURNIE, dont la seule méthode obligatoire est
`executeSql(text, values)`. Notre pool applicatif (mode transaction, qui multiplexe) la satisfait
trivialement. 🔴 Et le point décisif est dans le code de `start()` : `if (this.#db._pgbdb && !this.#db.opened)
await this.#db.open()`. Un `db` fourni n'a pas ce marqueur, donc **pg-boss n'ouvre aucun pool à lui**.

**Ce qui reste actif côté API avec cette option**, et qui est compatible avec le mode transaction : la
vérification de version du schéma, et la mise en cache des files (des `select`). Le superviseur, l'écouteur de
notifications et le planificateur sont déjà désactivés.

⚠️ **Poser aussi `migrate: false` sur l'API.** Sinon chaque copie vérifie et migre le schéma pg-boss au
démarrage. C'est le worker qui migre, lui est en exemplaire unique.

### 3.2 Les balayages doivent être sérialisés (avant le SECOND WORKER)

**Le problème.** Les 23 tâches minutées vivent dans le processus (`src/worker/taches.ts`). Deux workers, deux
exemplaires de chaque balayage : deux reprises de contrôle, deux réveils de parcours, deux relances d'échecs.
Certains sont idempotents, d'autres non.

**La solution.** Un verrou d'exécution, et **le modèle existe déjà dans le dépôt** : `src/campaign/run-lock.ts`
(migration 0089). Trois pièces, chacune pour une raison écrite : un **bail** (sinon un worker tué bloque le
balayage à vie), un **jeton de garde** (sinon le porteur d'un bail périmé supprime le verrou de son
successeur), un **drapeau de relance** (sinon le travail arrivé pendant la passe est perdu).

⚠️ Le lissage des départs livré le 2026-09-15 ne protège de RIEN ici : il décale, il ne sérialise pas.

### 3.3 Les plafonds de débit doivent quitter la mémoire (avant de MULTIPLIER l'API)

**Le problème.** `RATE_LIMIT_USER_PAR_MINUTE`, `RATE_LIMIT_COUTEUX_PAR_MINUTE` et le préfiltre des clés d'API
comptent en mémoire, par processus. N copies servent N fois le plafond annoncé, sans que ni l'écran ni la
configuration ne le disent.

**La solution : Postgres d'abord, Redis quand la mesure le demande.** Voir §6.

---

## 4. Ce qui est DÉJÀ juste, et qu'il ne faut surtout pas casser

Vérifié dans le code le 2026-09-15. C'est la vraie réponse à « devra-t-on tout reconstruire » : **non**, parce
que ces sept propriétés sont déjà là, et aucune n'est un hasard.

- **L'API et le worker sont déjà deux points d'entrée distincts** (`src/index.ts`, `src/worker.ts`) qui
  partagent le code sans partager le cycle de vie. Le découpage que la cible exige est fait.
- **`tenant_id = $1` sur chaque requête**, tenu par `tests/scope-tenant.test.ts`. Clé d'isolation aujourd'hui,
  clé de découpage le jour où une base ne suffira plus.
- **Aucun état sur disque.** Les médias RCS vivent en base (`rcs_media`). Un conteneur qui meurt n'emporte rien.
- **Aucun websocket**, l'Inbox interroge en HTTP. Donc aucune session collante devant N copies.
- **Le schéma vit dans `db/migrations/`**, pas dans un tableau de bord. Base neuve + `npm run migrate` le
  reproduit entièrement, configuration de recherche `french_sans_accent` comprise.
- **Aucune dépendance spécifique à Supabase** : ni bibliothèque maison, ni Storage, ni Auth, ni PostgREST.
  Du PostgreSQL nu. ⚠️ **C'est la propriété la plus fragile de la liste** : elle se perd le jour où quelqu'un
  branche une brique propriétaire pour aller vite, et personne ne s'en aperçoit avant le devis de migration.
- **`api.messagingme.app` est un NOM derrière Cloudflare.** Changer d'hébergeur coûte un enregistrement DNS,
  et le webhook de Meta n'a jamais à être reconfiguré.

---

## 5. Le connecteur HubSpot : sa propre base, et il dort quand personne ne s'en sert

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

⚠️ **LA QUESTION N'EST DONC PAS TECHNIQUE, ELLE EST COMMERCIALE.** Mesuré le 2026-09-15 : **un seul portail
branché**, le portail cobaye. Tant que le connecteur est une démo à un portail, lui payer une machine pour
libérer quelques connexions serait absurde ; on baisse sa consommation, c'est une variable d'environnement. Le
jour où il porte de vrais clients, il prend sa machine et le couplage disparaît pour toujours. **C'est la
présence de clients réels qui déclenche, pas la bascule Scaleway.**

⚠️ Vérifier avant, dans les deux cas : `mba` lit `mmhs` en cross-schéma aujourd'hui (voir `CLAUDE.md`), il
faut savoir OÙ et remplacer ces lectures par un appel.

**b) L'endormir (l'économie, en bonus).** Un conteneur serverless peut descendre à zéro copie et se réveiller
à la première requête. Zéro portail branché, zéro copie, zéro connexion ; un client s'y branche, ça se
réveille. ⚠️ Sa partie WORKER ne peut pas dormir de la même façon (§1) : si elle doit tourner, elle tourne,
mais sur sa propre base ça n'impacte plus personne.

**(a) supprime le problème, (b) supprime le coût.** (a) est celle qui compte.

---

## 6. Redis : oui un jour, non maintenant, et pas pour la raison qu'on croit

⚠️ **Redis n'est PAS ce qui rend possible d'avoir plusieurs API.** Plusieurs copies fonctionnent sans lui ; ce
qui a besoin d'un état partagé, ce sont seulement les **compteurs** (§3.3). Redis est l'outil de l'état
partagé à haute fréquence et courte vie, ce que des plafonds par minute sont exactement.

**Pourquoi Postgres d'abord.** Un compteur de plafond, c'est une écriture PAR REQUÊTE sur le chemin chaud.
Postgres le tient sans difficulté à notre volume, et n'ajouter aucun composant, c'est n'ajouter aucune panne
possible.

**Le déclencheur qui ferait passer à Redis** : quand l'écriture du compteur devient elle-même une charge
visible, c'est-à-dire quand on mesure des écritures de plafond au même ordre de grandeur que le trafic métier.
Scaleway a un Redis managé, la bascule sera un changement d'implémentation derrière la même interface.

🔴 **Écrire le compteur derrière une interface DÈS le chantier 3.3**, précisément pour que ce jour-là ce soit
un remplacement et pas une réécriture.

---

## 7. Le jour J : la séquence

**Prérequis, à valider AVANT de commencer :**

1. Les trois chantiers du §3 sont finis et déployés sur l'infrastructure actuelle.
2. **pgvector existe chez la destination.** Seule extension non universelle dont ce produit dépend
   (`agent_knowledge.embedding`, fiches d'aide). `pg_trgm` et `unaccent` sont des contribs standard.
   `pgcrypto` ne sert qu'à `gen_random_uuid()`, natif depuis PostgreSQL 13.
3. On sait où `mba` lit le schéma `mmhs` en cross-schéma (§5a).

**La séquence :**

1. Créer la base managée, région **PAR**, et relever son nombre de connexions.
2. `npm run migrate` sur la base neuve. Vérifier `schema_migrations` et la présence de `french_sans_accent`.
3. **Fenêtre de maintenance**, puis `pg_dump` / `pg_restore` des données.
   🔴 **À notre taille (30 Mo), quelques minutes de fenêtre suffisent, et c'est un luxe qu'on perd en
   grandissant.** C'est un argument pour basculer TÔT : à 30 Go il faudra de la réplication logique, donc un
   chantier au lieu d'une commande.
4. Déployer les conteneurs : **API en `min-scale 0`**, **worker en `min-scale >= 1`** (§1).
5. Poser le pooler devant la base (celui du fournisseur, ou un PgBouncer à nous). L'API passe par lui, le
   worker garde des connexions de session directes.
6. Basculer le DNS de `api.messagingme.app`. ⚠️ Le webhook de Meta n'a rien à reconfigurer, c'est tout
   l'intérêt d'avoir un NOM.
7. Le connecteur HubSpot part sur sa propre base (§5a).
8. **Vérifications publiques** : `/health` sur chaque nom, un message entrant réel de bout en bout, un envoi
   réel, et la carte `/ops` (files et pools) relue avant de fermer la fenêtre.

**Ce qu'on garde à Supabase le temps de vérifier** : rien. Une base lue par deux endroits est une base qui
diverge. La bascule est franche, et le retour arrière est la restauration du dump.

---

## 8. Ce qu'on ne fait PAS, et pourquoi

- **Kubernetes.** Il résout l'orchestration de nombreux services sur de nombreuses machines. La marche d'avant,
  c'est un hébergeur de conteneurs avec un curseur « nombre de copies » : on déplace le curseur, on ne
  construit rien. K8s ajouterait une charge d'exploitation permanente sans une seule unité de capacité en plus.
- **Plusieurs bases métier avant qu'un client ne gêne un autre.** Le découpage par client est PRÉPARÉ (§4), il
  n'est pas à faire. Le faire tôt coûterait des requêtes croisées impossibles et une exploitation doublée,
  pour un problème que personne n'a. (Le cas HubSpot du §5 est différent : ce n'est pas un client, c'est un
  autre produit.)
- **Redis maintenant** (§6).

---

## 9. La règle de fond

**On ne construit pas pour une échelle qu'on n'a pas mesurée.** Chaque plafond réel de ce produit a été
trouvé par la mesure, jamais par le raisonnement : les 16 clients vers le pooler, les deux accusés par minute,
les dix-sept par seconde en rafale, les 738 000 jetons par minute du Gateway sans un seul refus.

Ce document ne demande donc rien à construire « au cas où ». Il nomme **trois états-dans-un-processus à
supprimer avant de multiplier les processus**, et **sept propriétés à ne pas casser** d'ici là. Tout le reste
se décidera avec des chiffres qu'on n'a pas encore.
