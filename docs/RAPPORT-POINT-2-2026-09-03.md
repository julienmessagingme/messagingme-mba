# Rapport sur le point 2 de l'audit externe, 2026-09-03

> Document écrit **pour être contredit**. Il rend compte de tout ce qui a été livré le 2026-09-03 sur
> `messagingme-mba` (désormais **Engage Me**), en réponse à l'audit externe du 2026-09-02, et il se termine
> par les questions sur lesquelles je demande explicitement la contradiction.
>
> 🔴 **Règle que je m'impose et qu'on peut me reprocher de violer** : ce qui est MESURÉ et ce qui est RAISONNÉ
> sont marqués différemment. Un rapport qui confond les deux ne vaut pas d'être audité. Quand j'écris un
> chiffre, il vient d'une exécution, jamais d'une estimation.

## Contexte en cinq lignes

Console SaaS multi-espaces qui pilote WhatsApp (Cloud API) et RCS pour des clients. Trois conteneurs : API
Fastify, worker pg-boss, front Next. Postgres (Supabase, via pooler). En production, avec très peu de trafic
réel à ce jour. L'enjeu n'est pas la charge d'aujourd'hui, c'est la **trajectoire à 25 clients**.

L'audit du 2026-09-02 classait ses constats en A (bloquants avant scale), B (à faire vite) et C (structurel).
Le « lot immédiat » avait été livré la veille au soir. Ce rapport couvre **A1 à A4, puis B et C**.

## État de déploiement

**Tout est en production.** Commit déployé : `30c7d89`. Le précédent était `f711743`. Onze commits.

La séquence a été suivie à chaque fois, dans cet ordre : `gh run list` (CI verte, trois jobs dont un
`integration` sur Postgres jetable) → `git log <déployé>..HEAD` → `git pull` sur le VPS → **`docker compose
build` AVANT `migrate`** (les migrations vivent DANS l'image, un `pull` suivi d'un `migrate` rejouerait les
anciennes et répondrait « à jour » sans rien appliquer) → vérification que la migration est dans l'image →
`migrate` → `up -d --build` → vérification que le code déployé porte bien chaque changement, dans les
conteneurs, pas dans les logs de démarrage.

---

## 1. Ce que l'audit demandait, et ce qui a été fait

### A2, arrêter les effets à la perte du tour d'avance

**Le constat était juste, et plus grave que je ne l'avais compris.** Le battement livré la veille rendait la
perte du tour VISIBLE (un log) sans rien ARRÊTER. Le jeton SQL clôture l'écriture d'ÉTAT ; il n'a jamais rien
pu contre un message déjà remis à Meta. Un porteur déchu finissait donc sa liste d'envois pendant que le
nouveau faisait la sienne.

**La règle générale que j'en tire** : une garde de concurrence posée à l'ENTRÉE d'une liste d'effets ne prouve
rien sur le dixième ; elle se pose ENTRE les effets.

Trois points de contrôle, parce qu'il y a trois chemins d'effets et non un seul :

1. `apply`, la boucle qui émet tag, champ, e-mail, template, message rapide, flow, question ;
2. l'envoi RCS **en ligne** de `walkResolved`, qui part AVANT que `apply` ne voie quoi que ce soit ;
3. l'enfilement d'un tour d'agent, qui commande un appel modèle facturé.

Plus une **durée totale maximale de dix minutes**, pour le seul mode de panne qu'un battement ne distingue pas
d'un travail lent : l'avance PENDUE. Un minuteur renouvelle un bail aussi fidèlement pour une promesse morte
que pour un envoi en cours.

⚠️ **Ce que je n'ai PAS fait, et c'est un choix, pas un oubli.** L'audit demandait « un `AbortSignal` propagé
aux transports ». Le signal existe, **aucun transport ne l'écoute**. Un envoi Meta ne porte pas de clé
d'idempotence : couper la connexion en vol échangerait « un message de trop » contre « un message parti que
nous n'avons pas enregistré », donc invisible dans le fil de l'opérateur. C'est pire. On laisse finir l'effet
en vol, on ne lance pas le suivant.

### A1, le tour d'agent tué par un crash

`prendreLeTour` incrémente `tours` AVANT le travail, et c'est précisément ce qui rend le verrou optimiste
atomique. Un worker qui meurt entre les deux fait rejouer le job par pg-boss avec l'ANCIEN numéro : la
réservation rend `null`, le rejeu est classé « doublon », la session reste `en_cours` et le run reste en
attente **sans échéance** (elle se pose à la fin du tour, qui n'est jamais arrivée). Plus rien ne réveille
cette conversation.

Balayage à la minute qui réclame et clôt en UNE requête les tours en vol depuis plus de dix minutes, puis fait
sortir le parcours par la branche d'échec du bloc.

⚠️ **On ne rejoue pas, on clôt**, conformément à l'arbitrage : le worker a pu mourir APRÈS avoir envoyé le
message au contact, et rien en base ne permet de le savoir. Rejouer risquerait un doublon chez le contact ;
clore fait au pire emprunter une branche que le client a rédigée.

🔴 **Le piège, et il a failli me coûter des conversations vivantes.** « Session `en_cours` + run en attente +
aucune échéance » semble reconnaître un tour mort. C'est EXACTEMENT l'état d'un tour qui vient d'être enfilé
et attend son passage dans la file, et `derniere_activite` ne les départage pas (elle porte l'instant du tour
PRÉCÉDENT, qui peut remonter à des heures). Un balayage bâti sur cette déduction aurait tué des conversations
saines. Il a donc fallu une colonne (`tour_commence_le`, migration 0112), **et surtout l'effacer sur les deux
sorties qui laissent la session vivante**, sans quoi le balayage aurait tué un parcours dix minutes après une
réponse réussie. Les deux sens sont testés.

### A3, les deux bornes de sécurité des connecteurs

Vérifié avant de coder : **aucune résolution DNS nulle part** dans le dépôt.

Le contrôle existant lit le TEXTE de l'hôte. Mesuré : il refuse `localhost`, les littéraux privés et toutes
leurs formes exotiques (hexadécimale, entière, IPv6 entre crochets, IPv4 mappée). Il ne peut rien contre
`crm.exemple.fr` dont l'enregistrement A pointe sur `169.254.169.254` (métadonnées du fournisseur) ou sur
`172.18.x.x` (le réseau Docker du VPS, où vivent l'admin NPM et tous les conteneurs du parc).

Résolution contrôlée posée sur les **trois** chemins qui appellent une adresse saisie par un client : le
connecteur en conversation, le bouton « Test » de la console, et la lecture de page distante à **chaque saut
de redirection**. ⚠️ Le bouton « Test » n'était pas dans l'énoncé de l'audit, et c'est le chemin le plus facile
à atteindre du produit.

Deux règles la rendent juste : **une seule** adresse interdite condamne le nom (sinon la pile réseau choisit
au hasard), et une résolution qui **échoue** est un refus, pas un laissez-passer.

Lecture bornée EN FLUX sur les mêmes chemins. `await res.text()` suivi d'un test de taille portait deux
défauts dans la même ligne : le corps entier entrait en mémoire avant d'être jeté, et `.length` compte des
unités UTF-16, pas des octets. Testé : « 世 » ×100 = 300 octets pour 100 unités, donc un corps d'idéogrammes
passait un plafond « en octets » à trois fois sa taille réelle.

⚠️ **Ce qui reste ouvert, et je le dis plutôt que de l'enterrer** : le **DNS rebinding**. `fetch` refait sa
propre résolution après la nôtre. Le fermer exige de fournir son PROPRE résolveur à la couche HTTP (`undici`,
`connect.lookup`), donc une dépendance directe de plus, pour un scénario qui suppose un administrateur client
hostile disposant déjà de son compte. Le cas réaliste est fermé, celui-là ne l'est pas.

### A4, la preuve de capacité

**L'audit avait raison sur les deux points, et le second m'a mené à une découverte que personne n'avait
faite.**

**(a) La jauge mentait.** L'âge du plus vieux job ne comptait que les états `created` et `retry` : elle
retombait à ZÉRO à l'instant où un job était PRIS, même s'il restait coincé dix minutes dedans. Le document de
SLO en tirait « le pire cas instantané, donc plus sévère : s'il tient, le p95 tient ». Faux dans le seul cas
qui compte. Les jobs `active` sont désormais comptés, et l'affirmation est retirée du document.

**(b) Le vrai p95 existait déjà en base.** pg-boss horodate `start_after`, `started_on` et `completed_on` et
garde les jobs terminés le temps de sa rétention. **Aucune instrumentation n'a été ajoutée** : elle était là,
personne ne la lisait. Un p50/p95 d'attente et un p95 de bout en bout sur 24 h sont calculés et affichés dans
`/ops`, dans une carte SÉPARÉE de la jauge, pour qu'on cesse de confondre « qui attend maintenant » et « à
quoi ressemblaient les 24 h ».

**Premier chiffre RÉEL du SLO entrant, sur de vrais messages et non un banc en `DRY_RUN` :**

| File | Jobs | Attente p50 | Attente p95 | Bout en bout p95 |
|---|---|---|---|---|
| `webhook` | 65 | 2,3 s | **8,7 s** | 8,7 s |
| `webhook-status` | 45 | 177,6 s | **505,7 s** | 505,8 s |
| `analyze-conversation` | 7 | 30,0 s | 30,0 s | 32,8 s |
| `push-analysis` | 7 | 27,7 s | 30,4 s | 31,0 s |
| `campaign-run` | 6 | 0,04 s | 0,11 s | 2,1 s |

SLO 1 tient largement : **8,7 s contre 30 s visés**.

---

## 2. Ce que la mesure a trouvé, et qu'aucun audit n'avait vu

🔴 **`webhook-status` se vidait à DEUX jobs par minute.**

La lecture brute le montre sans ambiguïté : deux prises par minute, minute après minute, de 18:05 à 18:11 le
2026-09-02, pour un travail qui dure **0,05 s**. Ce n'est ni la base ni le réseau, c'est de l'arithmétique :
sondage toutes les 30 s, un job par sondage (`batchSize: 1`), concurrence 1.

**Ce que ça coûtait.** Une campagne de 5 000 destinataires produit environ 15 000 accusés de livraison. À deux
par minute : **125 heures** pour les absorber. Les compteurs de la campagne seraient restés faux pendant cinq
jours, et le client aurait lu « 5 000 envoyés, 12 délivrés ».

**Pourquoi personne ne l'avait vu.** Parce que la seule mesure disponible était la jauge, et que la jauge
restait verte : à chaque instant un seul job attendait vraiment. Le p95 rétrospectif, lui, le crie.

**Le correctif** : `burstWhenReadyExceeds` (une option de pg-boss). La cadence lente reste juste au REPOS, où
l'egress d'un sondage à vide est du pur gaspillage (mesuré le 2026-08-17 : 663 000 requêtes/jour pour 157 jobs
en table) ; sous retard, le délai tombe à zéro et la file se vide à plein régime, puis une prise revient
bredouille et le sondage lent reprend. **La concurrence ne bouge pas** : c'est elle qui protège les entrants,
pas la cadence.

⚠️ **La leçon générale, et elle vaut au-delà de cette file** : le débit d'une file vaut `1 / cadence de
sondage` tant que rien ne la réveille. Une cadence choisie pour l'egress AU REPOS devient un plafond de débit
SOUS CHARGE. Les deux régimes n'ont pas le même bon réglage.

---

## 3. Le banc agent, tenu six minutes

L'audit reprochait des rafales de dix secondes. Il avait raison, et pour une raison précise : **une rafale
plus courte que la fenêtre d'un plafond tient toujours**, quelle que soit la limite. Elle mesure la capacité
d'un seau plein, pas le débit auquel il se remplit.

Rejoué sur le VPS (la clé du Gateway n'existe que là), douze tours en parallèle, `zai/glm-4.7-flash`.

| | |
|---|---|
| Durée tenue | **361 s** |
| Tours joués | **1 406** |
| Allers-retours | 2 827, soit 2,01 par tour |
| Débit | **737 942 tokens / minute** |
| **Refus (429 ou autre)** | **0** |
| Coût | 0,376 $ |

Durée d'un tour : p50 **2,4 s**, p95 **6,9 s**, p99 **11,7 s**.

**Aucune dérive.** La durée moyenne ne monte pas, elle DESCEND (1 445 ms à la première minute, 1 217 ms à la
sixième) et le débit monte. C'est le contraire exact de la signature d'un seau qui se vide. La conclusion tient
donc pour de bon, et ce n'est plus une extrapolation depuis une rafale.

**Ce que la mesure longue a montré en plus : la queue.** Le tour le plus lent a duré **113 secondes** contre
2,4 s de médiane, soit un facteur 47. **0,14 % des tours** dépassent 30 secondes. C'est exactement ce que
l'échéance de production coupe : sans elle, deux conversations sur mille auraient pendu près de deux minutes
en tenant leur place dans la file. Le banc appelle le transport SANS échéance, ce qui est précisément pourquoi
il peut la mesurer.

Le cache de prompt reste à zéro sur 2 827 allers-retours, sur un échantillon cinquante fois plus grand que
celui de la veille.

---

## 4. Les lots B et C : le tri avant le code

**J'ai fait vérifier les six items restants dans le code, chacun avec un contre-vérificateur chargé de le
RÉFUTER.** Ça a évité du travail inutile et attrapé mes propres erreurs. Résultat du tri :

- **B2, B3, B5 étaient déjà clos** par le lot immédiat de la veille. L'audit est périmé sur ces points.
- **C4 (découpage des gros fichiers) est refusé.** Mesures réelles : `worker.ts` 877 lignes de code (1 430
  avec les commentaires), `executor.ts` 680, `CampaignCreateForm` 1 319. Le dépôt avait déjà refusé ce
  découpage nommément le 2026-08-31 avec un meilleur argument que celui de l'audit.
- **C1 était surdimensionné.** Inventaire : 14 `Pick<` dans `src/`, **13 sont sains**, un seul était un
  passe-plat.

### B4, la course du plafond de campagne

Le chemin « tous les contacts » COMPTAIT, validait le plafond sur ce compte, puis CHARGEAIT les contacts plus
tard **sans borne**. Deux requêtes séparées : un import concurrent entre les deux faisait partir une campagne
au-dessus du plafond qu'on venait d'autoriser, et le CRM entier passait en mémoire du process. Il résout et
FIGE désormais son jeu d'identifiants, borné à `plafond + 1`.

🔴 **Et le contre-vérificateur a trouvé le trou que MON PROPRE correctif laissait.** Le câblage relayait
`(tenant, target)` vers un contrat qui en déclare trois : la borne était avalée EN SILENCE et le store
retombait sur son plafond technique de 100 000. **Vérifié : la version fautive passe `tsc` sans un mot.** Une
flèche à deux paramètres est parfaitement assignable à un contrat qui en déclare trois. C'est maintenant gardé
par un test qui lit la source, parce qu'aucun type ne peut l'exprimer.

### C2, une promesse fausse faite au client DANS LE PRODUIT

Le pire des trois n'était pas un document. L'infobulle du badge « vous avez la main », affichée à l'opérateur
sur **chaque** conversation qu'il détient, en français et en anglais, affirmait que « les campagnes ne
l'enverront pas ».

C'est l'inverse exact du code : une campagne passe `ignoreHumanControl` et **REPREND la main**, délibérément,
parce que c'est un opérateur qui la déclenche. Un opérateur qui croyait l'infobulle pensait le contact protégé
d'un envoi de masse. Corrigé, plus `features.md`, et gardé par un test qui exige que l'écran DISE ce qui se
passe vraiment, pas seulement qu'il se taise.

### C1, la cause de la panne du 2 septembre

`run-job` nommait onze capacités dans son contrat puis les recopiait une par une dans les options du moteur :
deux listes à tenir alignées à la main, dont le désalignement ne produit AUCUNE erreur de compilation. C'est
comme ça que `boutonsTraces` et `jetonsPourContacts` se sont perdues et que **toutes les campagnes portant un
template à lien tracé ont échoué en 131008**.

Elles voyagent désormais dans un objet imbriqué transmis d'un seul spread. Il n'y a plus de liste.

⚠️ **La moitié moins connue du problème, vérifiée au compilateur** : une propriété en trop ÉCRITE dans un
littéral est refusée (TS2353), la même dans un SPREAD passe sans un mot. Un câblage qui construit ses
dépendances par spread n'a donc aucune garde.

### B1, le journal des échecs d'avance

Le contexte (parcours, run, canal) traverse enfin : les trois colonnes de la migration 0108 étaient NULLES sur
100 % des lignes, donc la jointure qui cherche le nom du scénario ne rendait jamais rien.

⚠️ **Trois points de B1 restent ouverts, et c'est un choix** : la déduplication, l'état acquitté/résolu et
l'index de purge demandent une migration et une route d'écriture pour un journal que personne n'a encore eu à
exploiter. Le contre-vérificateur a aussi écarté une fausse piste que j'aurais pu suivre : passer le signal de
rejeu `alreadySeen` à l'avance pour dédupliquer **casserait la reprise**, l'événement étant marqué dès la
première tentative.

---

## 5. Méthode : ce que je m'impose, pour qu'on puisse me le reprocher

- **Chaque garde vérifiée dans les DEUX sens.** Neutralisée → le test doit devenir rouge, restaurée → vert. Un
  test qui passe après un correctif ne prouve rien tant qu'on n'a pas vu qu'il ÉCHOUE sans lui.
- **Ça a servi.** Trois assertions de câblage existantes étaient **vacuous** : elles matchaient le nom de
  l'option même quand le câblage était neutralisé en `...(false ? { option } : {})`. Elles sont désormais
  ancrées sur la ligne entière, et la neutralisation les fait échouer.
- **Les migrations sont appliquées AVANT le déploiement**, et le compteur est vérifié EN BASE, pas dans un
  document. Il annonçait 0107 alors que la base portait 0111 : un compteur tenu à la main dérive.
- **Les tests d'intégration ne tournent jamais en local** (le `DATABASE_URL` local pointe la production). La
  CI monte un Postgres jetable pour ça.

---

## 6. Les questions sur lesquelles je demande la contradiction

1. **Le `burstWhenReadyExceeds` est-il le bon levier, ou faut-il monter la concurrence ?** J'ai gardé la
   concurrence à 1 sur `webhook-status` parce que c'est elle qui protège les entrants, et je n'ai touché que
   la cadence. Est-ce que je me trompe de variable ? Et le seuil de 20 est-il défendable, sachant que le
   compte de jobs prêts que pg-boss consulte est mis en cache et rafraîchi toutes les 60 s ?

2. **Refuser de propager l'`AbortSignal` aux transports : est-ce le bon arbitrage ?** Mon raisonnement est
   qu'un envoi Meta sans clé d'idempotence rend l'annulation en vol plus dangereuse que l'effet en trop. Y
   a-t-il un cas où c'est faux ?

3. **Clore plutôt que rejouer un tour d'agent mort : ai-je payé trop cher la prudence ?** Le contact peut
   recevoir la branche d'échec alors qu'il avait déjà reçu la réponse de l'agent. L'alternative demanderait de
   rendre les effets d'un tour idempotents. Vaut-elle le coût ?

4. **Le DNS rebinding vaut-il une dépendance de plus (`undici`) ?** Mon arbitrage : non, parce que le scénario
   suppose un administrateur client hostile qui a déjà son compte. Mais je peux sous-estimer le cas de
   l'administrateur simplement TROMPÉ, qui colle une URL qu'on lui a donnée.

5. **Le p95 lu sur `pgboss.job` est-il un indicateur honnête ?** Il ne voit que ce que la rétention de pg-boss
   a laissé, et une fenêtre qui contient un redémarrage de worker mesure le redémarrage. Est-ce qu'il faut une
   instrumentation propre plutôt que de lire la table d'un tiers ?

6. **Trois points de B1 laissés ouverts : est-ce que je me raconte une histoire ?** Un journal d'incidents
   sans acquittement ni déduplication est-il un outil d'exploitation, ou juste une table qu'on regardera une
   fois ?

7. **Le vrai angle mort.** Le produit n'a quasiment pas de trafic réel. Tous mes chiffres viennent soit d'un
   banc, soit de 65 messages en production. **Qu'est-ce qui, dans ce que j'affirme, ne survivrait pas au
   premier client à volume ?**
