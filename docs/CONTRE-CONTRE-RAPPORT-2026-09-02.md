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

## État de déploiement : DÉPLOYÉ le 2026-09-02 à 21h55

Les sept lots, plus le geste 1 du chantier IA, sont en production. Commit déployé : **`7cdab86`**. Le
précédent était `7073b8b`.

**La séquence suivie, et pourquoi elle est dans cet ordre.**

1. `gh run list` : CI verte sur les sept commits (trois jobs chacun, dont un `integration` sur un Postgres
   jetable où les migrations sont rejouées à neuf).
2. `git log 7073b8b..HEAD` avant de pousser quoi que ce soit : plusieurs sessions écrivent sur `main`, on ne
   déploie pas que son propre travail. Douze commits, tous identifiés.
3. `git pull` puis **`docker compose build mba-api` AVANT `migrate`**. 🔴 Ce n'est pas un détail de confort :
   les migrations vivent DANS l'image (`COPY db ./db`), donc un `git pull` suivi d'un `migrate` rejouerait les
   anciennes et répondrait « à jour » sans rien appliquer. Erreur déjà vécue le 2026-08-21.
4. **Vérification que les deux migrations sont dans l'image** avant de les jouer (`ls db/migrations` dans le
   conteneur fraîchement construit).
5. `migrate` : `0108 ... ok`, `0109 ... ok`, « 2 migration(s) appliquée(s) ».
6. `up -d --build`, les trois conteneurs recréés.

**Vérifications faites APRÈS, et pas seulement les logs de démarrage.**

- Les deux tables existent réellement en base (`information_schema`, requête directe) : `pool_attentes` et
  `workflow_advance_failures`.
- `migrate` rejoué : « à jour, rien à appliquer », donc les deux sont bien enregistrées.
- Les trois conteneurs sont `Up`, l'API `healthy`, et le worker annonce ses huit files.
- Zéro erreur `pool-attentes` dans les logs, donc la table est écrivable par le worker.
- **Sur le chemin PUBLIC et pas depuis le conteneur** : `https://mba.messagingme.app/` répond 200. La
  distinction a de l'importance ici : un appel interne réussit précisément là où le proxy est le coupable,
  et c'est ainsi qu'un défaut de rewrite est passé en production le matin même.

**Ce que le déploiement ne prouve pas.** Il prouve que le code démarre et que le schéma est en place. Il ne
prouve **rien** sur le comportement sous charge : le trafic réel de cette instance est proche de zéro.

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

🔴 **UN TOUR N'EST PAS UN APPEL, et c'est ce qui change tout le dimensionnement.** Chaque tour fait jusqu'à
**six allers-retours** (`MAX_ALLERS_RETOURS = 6`), et chacun renvoie l'intégralité du prompt système, des
définitions d'outils et des résultats d'outils déjà accumulés. La partie **constante** de cette charge est donc
payée jusqu'à six fois par tour. Ce qui nous plafonnera n'est pas notre concurrence, c'est le **débit en tokens
par minute** de la passerelle, et la facture.

**Le geste qui décide de la suite est fait : on LIT enfin `prompt_tokens_details.cached_tokens`.** Ce champ
arrivait déjà dans chaque réponse et personne ne le lisait. On n'envoie aucune instruction de cache, ce qui est
vrai ; en conclure que rien n'est caché serait faux, certains fournisseurs cachant les préfixes longs sans
qu'on demande. Une ligne de trace est écrite **par aller-retour** (`agent-cache: agent=… ar=… in=… caches=…
part=…%`), et non par tour : ce qu'on cherche à voir est justement si la part cachée grimpe au deuxième
aller-retour, le préfixe étant alors déjà connu du fournisseur. Un total par tour moyennerait l'information
utile.

⚠️ **Ce que ce geste ne peut pas trancher tout seul** : zéro veut dire soit « pas de cache », soit « champ non
rendu par ce fournisseur ». Les distinguer demande de regarder si le nombre reste nul sur un préfixe long
**répété**, donc de faire tourner de vraies conversations.

### 🔴 LA MESURE A ÉTÉ FAITE, ET ELLE INFIRME UNE PARTIE DE CE QUI PRÉCÈDE

Trois passages d'un banc (`scripts/mesure-tour-agent.mts`) contre le **vrai** Gateway, modèle de production,
avec le corpus Hyundai comme base de connaissance. Détail complet : `docs/MESURE-TOUR-AGENT-2026-09-02.md`.

| Mesure | Valeur |
|---|---|
| Allers-retours par tour | **2,0** (et non les 6 du plafond) |
| Durée d'un tour | **3,0 s** en moyenne, 4,2 s au pire |
| Tokens par tour | ~3 000 en entrée, ~130 en sortie |
| Coût par tour | ~0,00026 $ |
| **Tokens servis depuis un cache** | **0**, dans les trois passages |

**Ce qui est confirmé** : un tour n'est pas un appel, et sa durée réelle (3 s) n'a rien à voir avec le plafond
de 120 s. C'est la durée réelle qui décide de la concurrence.

🔴 **Ce qui est INFIRMÉ : le cache de prompt n'était pas le levier annoncé.** Non seulement `cached_tokens`
vaut zéro partout, y compris sur des tours successifs à préfixe rigoureusement identique et y compris avec un
préfixe de 1 800 tokens (au-dessus du seuil habituel de 1 024) ; mais surtout **notre préfixe constant est
petit**, ~1 100 tokens sur ~3 000 par tour. Un cache parfait n'économiserait qu'un tiers des tokens d'entrée,
et seulement au premier aller-retour. Ce qui fait le volume est le résultat de la recherche de connaissance,
qui varie d'une question à l'autre et n'est donc pas cachable. **Le geste « demander le cache explicitement »
passe en basse priorité**, alors que le raisonnement d'avant en faisait un enjeu majeur.

**Ce que la mesure dit des chiffres choisis.** Loi de Little avec 3 secondes mesurées : 200 conversations à un
message toutes les 90 s font 6,7 tours en vol, toutes les 60 s en font 10, toutes les 30 s en font 20. **12
est donc le bon ordre de grandeur à cadence humaine et devient court si les échanges s'accélèrent**, ce qui
est exactement pourquoi c'est une variable d'environnement.

🔴 **Et le vrai plafond est ailleurs : 600 000 tokens par minute** vers le Gateway dans l'hypothèse à 200
conversations et 60 s. Les limites d'un gateway s'expriment en tokens par minute : c'est ce chiffre-là qu'il
faut confronter au plan Vercel, pas le nombre de requêtes simultanées.

**Ce qui reste honnêtement non résolu :**

1. **Le tuyau externe.** Les limites de débit réelles du Gateway ne sont **toujours pas** connues. On sait
   maintenant quoi leur comparer (600 000 tokens/minute), ce qui est un progrès, mais pas la réponse.
2. **Aucune mesure sous CONCURRENCE.** Les tours du banc sont joués les uns après les autres : il donne la
   durée d'un tour seul, c'est-à-dire l'entrée de la loi de Little, pas sa vérification.
3. **Cette file n'a jamais tourné en production.** Zéro job dans tout l'historique.
4. **Le corpus mesuré est petit** (17 fiches). Un client avec 500 fiches verrait des résultats d'outils bien
   plus gros, donc des tours plus chers.

## Ce qui n'est PAS prouvé (liste exhaustive à ma connaissance)

- **Le déploiement prouve que ça démarre, pas que ça tient.** Le trafic réel de l'instance est proche de zéro :
  aucun des sept lots n'a été éprouvé par de la charge.
- **`agent-turn` n'a jamais tourné en production.** La durée d'un tour est maintenant MESURÉE (3 s), mais sur
  un banc séquentiel, jamais sous concurrence ni sur du trafic réel.
- **On ne sait pas si le cache de prompt opère, et on ne peut pas le savoir depuis notre côté.**
  `cached_tokens` vaut zéro dans les trois passages : « pas de cache » et « champ non rendu » sont
  indiscernables. La conséquence pratique est la même aujourd'hui, et elle est faible (cf. la mesure).
- 🔴 **J'ai sauté l'ordre du plan et Julien l'a relevé.** Le plan faisait commencer le chantier IA par la
  lecture du champ de cache (une ligne, et elle peut annuler le geste le plus coûteux) ; j'étais allé
  directement choisir les chiffres de concurrence. Le geste est fait depuis, mais la méthode a failli, pas
  seulement le contenu : c'est le genre d'écart qu'un audit doit chercher ailleurs dans ce rapport.
- **Aucun banc de charge n'a tourné contre les seuils depuis le 2026-09-02 au matin**, et le profil d'équité
  n'existe pas (il est au backlog, rattaché au lot 6 : l'écrire avant aurait mesuré la configuration d'avant).
- **L'attribution des clics n'est pas prouvée de bout en bout** : aucun clic réel depuis un envoi réel.
- **La mesure du pool n'a jamais enregistré de saturation réelle** : elle n'a rien vu parce qu'il n'y a rien eu
  à voir, ce qui n'est pas la même chose que « elle fonctionne ».
- **Le comportement à deux workers n'est pas éprouvé**, et les plafonds par groupe y doubleraient.

## Ce sur quoi je demande la contradiction

1. **Les chiffres 12 et 4 sur la file d'agent, maintenant qu'un tour est MESURÉ à 3 secondes.** Little donne
   10 tours en vol pour 200 conversations à un message toutes les 60 s, donc 12 tient de justesse et 20
   seraient nécessaires à 30 s. Est-ce que l'hypothèse de cadence est la bonne ? Et surtout : est-ce que
   quelque chose sature avant nous, à 600 000 tokens/minute vers le Gateway ?
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

## Ce qu'il faut surveiller maintenant que c'est en production

Trois signaux, dans l'ordre où ils diraient quelque chose :

1. **`agent-cache:` dans les logs du worker.** Dès la première vraie conversation d'agent, cette ligne dit si
   le cache opère. `part=0%` sur plusieurs allers-retours consécutifs d'un même tour signifie qu'il n'y en a
   pas, et ouvre le geste « demander le cache explicitement ».
2. **La carte « Pool de connexions » dans `/ops`.** Le chiffre qui alarme est `en attente`, jamais le nombre de
   connexions utilisées. Une barre rouge dans la courbe par minute veut dire qu'une acquisition a dépassé
   50 ms sur un pool saturé.
3. **L'origine `scenario` dans le journal des erreurs.** Elle était jusqu'ici invisible par construction : une
   panne d'avance était acquittée en silence. Si des lignes y apparaissent, ce sont des pannes qui existaient
   déjà et que personne ne voyait, pas des pannes nouvelles.

**Retour arrière.** Les deux migrations sont ADDITIVES (deux tables neuves, aucune colonne existante touchée),
donc un retour du code sur `7073b8b` ne demande aucune annulation de schéma : le code d'avant ignore ces tables.
Les valeurs de concurrence sont des variables d'environnement, donc revenir à `1` se fait sans redéployer de
code, par une recréation de conteneur.

## Comment vérifier ces affirmations

Chaque lot est un commit unique sur `main`, avec un message qui porte le raisonnement et la preuve. Les tests
de garde sont nommés en français et commencent par 🔴 quand ils protègent un défaut déjà survenu. Le plan
d'origine, avec le piège de chaque lot, est dans `docs/PLAN-POST-AUDIT-2026-09-02.md`. Les décisions et gotchas
techniques sont dans `documentation.md`, section « Journal des lots livrés ».
