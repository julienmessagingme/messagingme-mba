# Contre-contre-rapport, 2026-09-02

> Document écrit **pour être audité**. Il rend compte des sept lots livrés dans la soirée du 2026-09-02 sur
> `messagingme-mba`, et il se termine par une liste de questions sur lesquelles je demande explicitement la
> contradiction. Ce qui n'est pas prouvé est signalé comme tel : un rapport qui ne distingue pas ce qui est
> mesuré de ce qui est raisonné ne vaut pas d'être audité.

## Contexte en cinq lignes

`messagingme-mba` est une console SaaS multi-espaces qui pilote WhatsApp (Cloud API) et RCS pour des clients.
Trois conteneurs : une API Fastify, un worker pg-boss, un front Next. Base Postgres (Supabase, via pooler).
En production, avec très peu de trafic réel à ce jour (une douzaine de contacts en base, la plus grosse
campagne jamais créée en portait deux). L'enjeu du programme est la **trajectoire à 25 clients**, pas la
charge d'aujourd'hui.

Les sept lots viennent d'un plan écrit le matin même, lui-même issu d'un contre-audit externe et d'une
re-vérification de chaque constat dans le code.

## 🔴 État de déploiement : RIEN N'EST DÉPLOYÉ

Les sept lots sont commités et poussés sur `main`, CI verte (unitaires + intégration sur un Postgres jetable).
**Aucun n'est en production.** Deux migrations sont écrites et **non appliquées** (0108, 0109). Les deux sont
volontairement **non bloquantes** : sans elles, le code se comporte exactement comme avant (écriture
best-effort, lecture qui rend une liste vide).

C'est un point à charge autant qu'à décharge : rien de ce qui suit n'a été éprouvé par du trafic réel.

## Ce qui a été livré

### Lot 1 : le bail du tour d'avance se renouvelle

**Le défaut.** Une migration antérieure (0104) réservait le tour d'avance d'un parcours avant tout envoi, ce
qui fermait la course COURTE : deux traitements qui démarrent ensemble, un seul passe. Restait la course
LONGUE, celle du porteur qui n'est pas mort mais seulement LENT. Le client HTTP autorise cinq tentatives à
30 s de plafond plus le backoff, soit environ **154 secondes au pire pour un seul envoi Meta**, et une avance
peut en enchaîner plusieurs. Le bail de 60 s expirait donc pendant que le premier porteur travaillait encore,
un second prenait le tour, et **les deux envoyaient**. Le contact recevait un message qu'il ne devait pas voir.

**Pourquoi allonger le bail ne pouvait pas suffire.** Le nombre d'envois d'une avance n'est pas borné, donc sa
durée non plus, donc aucune constante n'est sûre. Seul un signe de vie périodique distingue un porteur mort
d'un porteur lent.

**Le correctif.** Un battement qui prolonge le bail à un tiers de sa durée (pour survivre à deux battements
manqués), arrêté dans un `finally`. Et une seconde moitié : l'écriture d'état est désormais **clôturée par le
jeton** du tour, un porteur périmé ne pouvant plus écrire par-dessus celui qui a repris.

**Distinction volontaire** : un renouvellement qui rend `false` est un VERDICT (un autre a repris), on cesse de
battre ; une EXCEPTION ne prouve rien sur la propriété du bail, on continue.

**Preuve.** Un test où la première avance est suspendue 80 secondes avec un bail de 60 : sans le battement, le
contact reçoit deux fois le message ; avec, une seule fois. Le test jumeau, gardé en permanence, montre le
double envoi quand la dépendance de renouvellement est absente. Quatre tests d'intégration sur le SQL.

### Lot 2 : le défilement du fil d'inbox

Régression introduite le matin même. L'effet mesurait « suis-je en bas ? » **après** l'ajout des messages, donc
à l'ouverture d'une conversation longue la réponse était « non » (`scrollTop` à 0) et le fil ne descendait pas ;
et à l'arrivée d'un message plus haut que la tolérance de 80 px, le fil ne suivait plus. La mesure est
désormais prise sur l'événement de défilement, avant que le contenu ne bouge, et le premier chargement est un
cas explicite.

**Preuve en E2E, sur la vraie page.** Remettre la mesure postérieure fait tomber deux tests ; retirer la garde
anti-arrachement fait tomber le troisième, et lui seul.

### Lot 3 : un plafond de campagne (20 000)

Aucune constante n'existait. Le chemin par filtres était borné à 100 000 identifiants par un cap technique
enfoui dans un store, la liste explicite ne l'était que par la taille du corps HTTP, et le chemin « tous les
contacts » **ne l'était par rien**. Une garde unique, au seul point où les trois chemins se rejoignent, avec un
comptage EN BASE pour le troisième (le plafond doit se prononcer avant le chargement). Refus en 422 portant les
deux nombres. La campagne au fil de l'eau est exclue : elle naît vide.

### Lot 4 : une panne d'avance cesse d'être invisible

Le traitement des messages entrants attrapait chaque exception par message, écrivait dans les logs, et le job
se terminait **en succès** : aucun rejeu, aucune file d'échec, aucune trace consultable. Le contact restait
bloqué sur son bloc et personne ne l'apprenait. L'isolation par message est bonne et ne change pas ; c'est
l'acquittement silencieux qui est fermé. L'échec atterrit dans le journal des erreurs déjà à l'écran, sous une
troisième origine `scenario`, distincte de « jamais parti » et de « parti, non délivré ».

### Lot 5 : retirer deux affirmations qui mentent

Deux textes étaient des **secondes spécifications**. Un tableau de commandes du banc de charge listait un
profil `equite` que le script ne contient pas. Et un commentaire affirmait qu'une campagne n'écrase pas un fil
tenu par un humain, alors que les trois câblages réels passent le drapeau inverse (comportement délibéré :
la campagne est déclenchée par un opérateur, donc c'est un humain qui a la main). Le texte dit maintenant ce que
fait le code, et un test garde le câblage plutôt que l'exécuteur nu.

### Lot 6 : six files traitaient un job à la fois pour toute la flotte

**Le constat, non fait par l'audit externe.** Sur les huit consommateurs du worker, deux seulement passaient des
options de concurrence. Les six autres tournaient sur le défaut de pg-boss (`localConcurrency = 1`, vérifié
dans sa source) : **un seul job à la fois, tous clients confondus**.

**La conséquence qui compte.** La file des tours d'agent IA traitait un tour à la fois pour la flotte entière,
avec un plafond de 120 s par appel au modèle. À 25 clients, cela fait **30 tours par heure pour tout le monde**.

**Ce qui change, et ce qui ne change pas.**

| File | Avant | Après | Raison |
|---|---|---|---|
| `agent-turn` | 1, aucun groupe | 12 en vol, groupe = client, 4 par client | le facteur limitant |
| `analyze-conversation` | 1, aucun groupe | 3, groupe = client, 1 par client | équité, pas débit |
| `automation-event` | 1, aucun groupe | 3, groupe = client, 1 par client | une rafale d'un client gelait les autres |
| `webhook-status` | 1, groupe contact | inchangé | lente exprès, 0,1 s par job |
| `push-analysis` | 1 | inchangé | volume faible |
| `hubspot-catchup` | 1 | inchangé | rattrapage, pas du temps réel |
| `webhook` | 3, groupe contact | inchangé | 0,2 s de travail réel par job |
| `campaign-run` | 4, groupe client | inchangé | déjà équitable |

**Sur les files de fond, le GROUPE compte plus que le nombre.** Monter les analyses de 1 à 3 ne change presque
rien au débit ; ce qui change tout, c'est qu'un client qui importe dix mille contacts ne puisse plus faire
passer dix mille analyses avant la première de tous les autres.

⚠️ **Piège de pg-boss** : `groupConcurrency` est un **no-op** tant que `localConcurrency` vaut 1. Poser la clé
de groupe seule aurait donné une équité qu'on croirait active. Les deux options vont donc ensemble partout, et
un test garde les deux sens.

**Un helper plutôt que six recopies.** La file d'automations était enfilée depuis six endroits : six occasions
d'oublier la clé de groupe, et un oubli produit un job sans groupe, qui échappe au plafond, sans que rien ne le
signale. Une seule fonction déduit désormais le groupe du job.

### Lot 7 : rendre le pool de connexions visible

**Le calcul tranche avant le code.** À 11 ms d'aller-retour mesuré, huit connexions tiennent environ
700 requêtes/s par process. Le scénario à 25 clients en demande quelques dizaines (sondage des inbox, une
campagne à 80/min, des tours d'agent qui ne tiennent aucune connexion pendant l'attente du modèle). **Le pool
n'est pas ce qui cassera.** Et l'autoscaling serait la mauvaise réponse : chaque instance arrive avec son propre
pool, donc ajouter des instances augmente la pression sur la ressource qui ne scale pas avec elles.

**Le vrai défaut était l'aveuglement** : la console d'exploitation n'exposait rien du pool. Le comportement à
saturation est pourtant correct (chaque requête attend puis échoue proprement au bout de 8 s, avec une trace),
mais personne ne regarde.

**Mesurer, pas échantillonner.** Une jauge lue à l'ouverture de l'écran afficherait zéro presque toujours et
raterait le pic. On mesure donc le temps d'obtention de **chaque** connexion, en enveloppant `connect` au point
unique de création du pool (`pg.Pool.query` l'appelle en interne, donc tous les stores sont couverts sans en
toucher un seul). Agrégation par minute en base, seul canal par lequel le worker peut se montrer, la console
étant servie par l'API.

⚠️ **Deux choses se cachent dans « attendre »** : ouvrir une connexion neuve (TCP + TLS, quelques ms, normal,
massif au démarrage) et attendre qu'une connexion se libère sur un pool saturé. Seule la seconde est le signal.
Deux compteurs distincts.

## Les deux questions de Julien, et ce qui a été répondu

### « Un seul worker pour tous les clients ? »

Oui, un seul process worker pour toute la flotte, et ce n'était pas le problème. Le problème était que **six de
ses huit files ne traitaient qu'un job à la fois**, ce qui est une propriété de configuration, pas de nombre de
process. Un second worker aurait fait passer les tours d'agent de 1 à 2 tout en dupliquant les dix-neuf
balayages périodiques et en cassant l'ordre des messages d'un même contact. **Le correctif est une option par
file, pas une réplique.**

Ce que le lot 6 ne règle pas : à deux workers, les plafonds par groupe **doublent**, la concurrence de pg-boss
utilisée ici étant locale au process. Une variante coordonnée par la base existe et n'est pas utilisée.

### « L'IA, à 100 ou 200 conversations simultanées ? »

Le calcul de dimensionnement retenu est celui de Little : le nombre de tours EN VOL n'est pas le nombre de
conversations, c'est **taux d'arrivée x durée**. Deux cents conversations où quelqu'un écrit toutes les 30 s,
avec un tour de 5 s, font environ **33 tours en vol**, pas 200. C'est ce qui rend 12 en vol défendable comme
point de départ, et absurde comme point d'arrivée.

**Ce qui est honnêtement non résolu, et que le lot 6 ne prétend pas résoudre :**

1. **Le tuyau externe.** Tous les appels partent par une clé unique vers une passerelle de modèles. Ses limites
   de débit réelles ne sont **pas mesurées**. Monter la concurrence côté worker peut donc déplacer la file
   d'attente de chez nous vers chez eux, où elle est muette.
2. **Le cache de prompt.** Vérifié : on n'envoie jamais de directive de cache **et** on ne lit jamais le champ
   qui dirait si le cache opère. On ne sait donc pas s'il opère déjà. L'affirmation « on ne cache pas » n'était
   pas fausse, elle était **non fondée**.
3. **Cette file n'a jamais tourné en production.** Zéro job dans tout l'historique. La durée réelle d'un tour
   est donc inconnue, et c'est elle qui décide de tout le dimensionnement.

## Ce qui n'est PAS prouvé (liste exhaustive à ma connaissance)

- **Rien n'est déployé.** Les sept lots sont sur `main`, CI verte, et pas en production.
- **Les migrations 0108 et 0109 ne sont pas appliquées.** Non bloquantes par construction.
- **`agent-turn` n'a jamais tourné en production.** Les valeurs 12 et 4 sont un raisonnement, pas une mesure.
- **Aucun banc de charge n'a tourné contre les seuils depuis le 2026-09-02 au matin**, et le profil d'équité
  n'existe pas (il est au backlog, rattaché au lot 6 : l'écrire avant aurait mesuré la configuration d'avant).
- **L'attribution des clics n'est pas prouvée de bout en bout** : aucun clic réel depuis un envoi réel.
- **La mesure du pool n'a jamais enregistré de saturation réelle** : elle n'a rien vu parce qu'il n'y a rien eu
  à voir, ce qui n'est pas la même chose que « elle fonctionne ».
- **Le comportement à deux workers n'est pas éprouvé**, et les plafonds par groupe y doubleraient.

## Ce sur quoi je demande la contradiction

1. **Les chiffres 12 et 4 sur la file d'agent.** L'argument est qu'un tour ne tient aucune connexion pendant
   l'appel au modèle (les stores prennent et rendent la connexion par instruction). Est-ce que quelque chose
   d'autre est saturé avant : la passerelle de modèles, la mémoire, la boucle d'événements ?
2. **Le plafond de 1 par client sur les files de fond.** Il garantit l'équité mais plafonne aussi le débit d'un
   client seul à ce qu'il était. Est-ce le bon arbitrage pour un déploiement où un client pèse 90 % du trafic ?
3. **Le renouvellement du bail à un tiers.** Suffisant contre une boucle d'événements bloquée, un décalage
   d'horloge, une pause du process (conteneur gelé) ? Y a-t-il un mode de panne où le battement continue alors
   que le travail, lui, est mort ?
4. **La leçon du `Pick` passe-plat.** Une liste de dépendances recopiée d'un module à l'autre est un filtre
   silencieux : les propriétés arrivées par un spread échappent au contrôle des propriétés en trop, donc le
   compilateur accepte ce qu'il va jeter. On a mis un commentaire et un test. **Existe-t-il un correctif
   STRUCTUREL** qui rende l'oubli impossible plutôt que détectable ?
5. **La mesure du pool.** Est-ce que mesurer chaque acquisition coûte quelque chose de mesurable au débit ?
   Est-ce que la distinction « connexion neuve » contre « pool saturé » tient dans tous les cas de `pg` ?
6. **Ce que ce rapport ne voit pas.** La question la plus utile : quel angle mort ce document a-t-il, du fait
   même de son auteur, qui est aussi celui du code ?

## Comment vérifier ces affirmations

Chaque lot est un commit unique sur `main`, avec un message qui porte le raisonnement et la preuve. Les tests
de garde sont nommés en français et commencent par 🔴 quand ils protègent un défaut déjà survenu. Le plan
d'origine, avec le piège de chaque lot, est dans `docs/PLAN-POST-AUDIT-2026-09-02.md`. Les décisions et gotchas
techniques sont dans `documentation.md`, section « Journal des lots livrés ».
