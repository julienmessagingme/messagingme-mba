# Avant la bascule Scaleway : les lots, dans l'ordre

> **Spec** : [docs/ARCHITECTURE-CIBLE.md](../../ARCHITECTURE-CIBLE.md), §8, §10 (prérequis 1 à 11), §10 bis et §11.
> Décisions de Julien du 2026-10-14 : §13, points 5 et 9 à 11. Ce plan ne recopie pas le document : il découpe ce
> qui reste en lots livrables, et chaque lot pointe la section qui le justifie.

**But** : arriver au jour J (§10) avec chaque prérequis tenu et prouvé, sans toucher la production autrement que
par ses déploiements habituels.

**Contraintes de tout le plan**
- Rien ne se crée ni ne se supprime chez Scaleway sans l'accord de Julien, ressource par ressource : c'est facturé.
- Aucun secret dans le dépôt, qui est public : les clés vivent chez Scaleway, dans les secrets GitHub ou sur le
  poste de Julien.
- Les lots de code se déploient sur le VPS actuel par la voie habituelle (`DEPLOY.md`), CI lue job par job avant
  le `up`.
- Aucun worker hébergé chez Scaleway ne tourne contre la base de production avant le jour J : il y dépilerait les
  files à la place du VPS.
- La base de la cible se crée sur un disque BLOC (`sbs_5k`), jamais sur le disque local d'une gamme DEV. Scaleway
  impose de quitter le disque local avant de monter vers une gamme à disque bloc : partir sur le bloc garde la
  montée en taille en une seule opération.

## L'ordre

| Lot | Quoi | Dépend de | Touche la production |
|---|---|---|---|
| 1 | HubSpot : le portail lu par le connecteur, plus en cross-schéma | rien | oui, deux dépôts |
| 2 | Trois petits lots de code : gardes des bancs, limites des workers, nom des copies d'API | rien | oui, déploiement habituel |
| 3 | Le socle Scaleway et le chemin de déploiement, éprouvés sur une base jetable | accord de Julien sur les ressources | non |
| 4 | Le banc de charge sur la cible et le budget de connexions | 3 | non |
| 5 | La répétition : mm-hubspot chez Scaleway, sur sa propre base | 1 et 3 | oui, le connecteur |
| 6 | La reprise après sinistre, réécrite et chronométrée | 3, puis 5 | non |
| 7 | Le routage de `mba.messagingme.app` chez Cloudflare, essayé sur un nom de test | 3 | non |
| J | La séquence du §10, quelques jours après le lot 5, jamais le même jour | tous | oui |

Les lots 1 et 2 partent dès maintenant, en parallèle. Les lots 3 à 7 partent quand Julien a validé les ressources.

## Lot 1 : HubSpot, le portail lu par le connecteur

**Pourquoi** (§8) : une fois `mmhs` sur une autre base, la lecture cross-schéma rend `42P01`, que deux
consommateurs traduisent en « aucun portail relié ». L'interrupteur laisserait alors éteindre HubSpot par-dessus
un portail relié, en silence.

**Tâches**
- mm-hubspot : une route `POST /service/portal`, signée comme les autres routes `/service/*`, corps `{ tenantId }`,
  réponse `{ connected: false }` ou `{ connected: true, hubId, hubDomain, listsScopeGranted }`, lue dans ses
  propres tables.
- Messaging Me : `getHubspotPortal` quitte `src/account/store.pg.ts` pour `src/crm/hubspot-service.ts` (même
  `callService`, même signature, même transport).
- Les trois consommateurs perdent leur cas `42P01` : l'écran du compte (`src/http/account.ts`), l'interrupteur et
  le contexte de suppression d'un espace (tous deux câblés dans `src/index.ts`).

**Le contrat qui doit tenir**
- Aucun connecteur configuré (`HUBSPOT_SERVICE_URL` vide) : `{ connected: false }`. C'est le remplaçant légitime
  de `42P01` : sans connecteur, aucun portail ne peut être relié.
- Le connecteur répond : sa réponse, validée par Zod (`safeParse`).
- Connecteur injoignable, délai dépassé, signature refusée, 404 ou 5xx : une ERREUR, jamais `connected: false`.
  L'interrupteur répond alors 503, le contexte de suppression rend `null` (« on ne sait pas »), l'écran du compte
  affiche « non connecté » (affichage seul). Les trois comportements sont ceux d'aujourd'hui.

**Tests attendus**
- mm-hubspot : signature absente ou fausse refusée ; espace sans portail ; espace relié, champs rendus.
- Messaging Me : URL vide donne `connected: false` ; connecteur en panne donne une erreur, pas `false` ;
  l'interrupteur rend 503 connecteur en panne et 409 portail relié ; la suppression d'espace rend `null`
  connecteur en panne ; plus aucune lecture de `mmhs.` dans `src/`.
- Rayon de souffle : cinq tests montent aujourd'hui le schéma `mmhs` (`tests/account-status.test.ts`,
  `tests/db-session-agnostic.test.ts`, `tests/hubspot-interrupteur.test.ts`, `tests/hubspot-masquage.test.ts`,
  `tests/integration/hubspot-actif.integration.test.ts`, ce dernier en CI seulement). Chacun se relit et garde le
  cas qu'il exerçait ; la CI d'intégration se lit job par job.

**Déploiement** : mm-hubspot D'ABORD, pour que la route existe, Messaging Me ensuite. Dans l'autre ordre,
l'interrupteur rendrait 503 pendant la fenêtre.

## Lot 2 : trois petits lots de code

**2a. Les gardes des bancs deviennent positives** (§7.8, point 3). Une aide unique, appelée par les cinq bancs
(`banc-api.mts`, `banc-charge.mts`, `banc-deux-api.mts`, `banc-deux-api-2.mts`, `banc-trente-espaces.mts`), qui
n'accepte qu'une adresse dont le nom d'hôte ou le nom de base contient « banc » ou « jetable » (le banc du lot 14
tourne sur l'hôte `banc14-postgres`), et refuse tout le reste. Une base managée se joint par une adresse IP privée :
chez Scaleway, le marqueur est donc le nom de la base, `banc`, et la base de production ne portera jamais ces mots.
Tests : une adresse Supabase, une adresse de base managée Scaleway et une adresse sans marqueur sont refusées ;
`banc14-postgres` et une base `banc` sont acceptées.

**2b. Chaque worker porte une limite de mémoire et de processeur** (§2). D'abord la mesure, sur le VPS, de ce que
consomme chaque worker sur une journée (`docker stats`, en lecture seule). La limite se pose ensuite dans
`docker-compose.yml`, avec sa marge écrite à côté du chiffre mesuré, et un test exige qu'elle existe pour chaque
worker. ⚠️ Une limite trop basse fait tuer le worker en boucle : l'alerte « redémarre en boucle » de `/ops` existe,
et c'est elle qui le dirait.

**2c. Le nom de chaque copie d'API** (§10, étape 7). `API_COPIE=auto` tire le nom du nom d'hôte de la copie. `/ops` cesse d'afficher une copie qui ne s'est plus signalée depuis un délai :
sans cela, chaque copie recyclée par l'autoscaling s'y accumulerait. Tests : le nom dérivé respecte le format
actuel (`^[a-z0-9-]{0,20}$`) ; une copie muette disparaît de `/ops`.

**Déploiement** : habituel, sur le VPS. Aucune migration attendue ; si 2c en demandait une, elle passerait avant le
code.

## Lot 3 : le socle Scaleway et le chemin de déploiement

**Pourquoi** : §10 bis, plus les étapes 1, 6 et 7 du §10, faites une première fois avant le jour J.

**Tâches**
- Avec l'accord de Julien, ressource par ressource (environ 70 € par mois aux petites tailles, prix relevés le
  2026-10-14) : le réseau privé à Paris, la Public Gateway S et son bastion, le registre privé, l'espace de
  conteneurs privé rattaché au réseau privé, la machine des workers sans adresse publique, une base jetable de la
  gamme visée, sur disque bloc.
- Les commandes de création s'écrivent dans `DEPLOY.md` (section Scaleway), rejouables à la main. Pas de
  Terraform, parce qu'il s'agit d'une seule plateforme et d'une dizaine de ressources créées une fois.
- `npm run migrate` sur la base jetable, depuis la machine des workers : les extensions se créent vraiment
  (prérequis 8 du §10), `schema_migrations` et `french_sans_accent` se relisent.
- Le tunnel par le bastion pour lire une base sans endpoint public, et `npm run migrations` qui passe par lui
  (§10 bis) : sans lui, on ne saurait plus d'un poste ce qui est appliqué en production.
- Le workflow `deploy-scaleway.yml` : `workflow_dispatch` seul, environnement `production` (approbation de
  Julien). Il construit l'image avec `REVISION`, la pousse au registre, migre depuis la machine des workers par le
  bastion, déploie l'API, puis redémarre les workers sur la même image. Le retour arrière est le même workflow
  lancé sur un commit antérieur.
- Une application IAM `github-deploy` (registre et conteneurs, rien d'autre) et une clé SSH pour le bastion, posées
  par Julien dans les secrets de l'environnement `production` : Claude ne voit jamais ces secrets.
- Le jeton d'origine (§7.3) : le conteneur est privé, et le format exact du jeton se relit ce jour-là.

**Tests attendus** : un test lit le workflow et refuse tout autre déclencheur que `workflow_dispatch`, ainsi que
l'absence de l'environnement `production` (le dépôt est public).

## Lot 4 : le banc sur la cible et le budget de connexions

**Pourquoi** (§7.5, §7.8) : les chiffres d'aujourd'hui, mesurés à Londres à 10 ms, ne survivent pas au déménagement.

**Tâches** : relever le nombre de connexions de la base jetable ; mettre à jour `tests/budget-pooler.test.ts` et
les tailles de pool ; rejouer `scripts/banc-api.sh` avec la latence de la région, et le second banc
(`scripts/banc-deux-api-2.mts`, ses cinq épreuves) ; reposer `API_PLAFOND_GLOBAL_PAR_10S` à 70 % de la capacité
mesurée ; revoir `DB_POOL_RECEPTION_MAX` et la concurrence de `webhook-status` ; proposer à Julien la taille de la
base et de la machine sur ces chiffres, avec leur prix. Tout se consigne au journal technique.

## Lot 5 : la répétition, mm-hubspot chez Scaleway

**Pourquoi** (§8, étape 0 du §10) : les gestes du jour J sur un produit qui peut se permettre un raté, et ses
connexions sorties du budget de la base principale avant le calcul définitif.

**Tâches** : sa base managée (endpoint privé) et ses migrations ; l'export des schémas `mmhs` et `pgboss_mmhs`
depuis Supabase, puis leur restauration ; son `DATABASE_URL` basculé ; son API et son worker déployés par un
workflow du même modèle, dans son dépôt. `HUBSPOT_SERVICE_URL` de Messaging Me pointe alors sur une adresse
publique : le canal service passe par Internet, signé et horodaté, et ce passage s'éprouve.

## Lot 6 : la reprise après sinistre

**Tâches** : la section de `DEPLOY.md` réécrite pour la base managée (sauvegardes automatiques, rétention,
instantané manuel avant le jour J) ; une restauration chronométrée sur une base jetable, celle du connecteur
d'abord ; après restauration, les secrets chiffrés relus avec la même `ENCRYPTION_KEY`.

## Lot 7 : le routage de `mba.messagingme.app`

**Tâches** : chez Cloudflare, une réécriture qui retire `/api/backend`, une redirection du reste vers la console,
et le jeton d'origine injecté comme pour `api.` ; le nom déclaré comme second domaine du conteneur de l'API. Essayé
avant le jour J sur un nom de test ; le vrai nom bascule à l'étape 10 du jour J.

## Le jour J

La séquence du §10 et les tests d'acceptation du §11, dans une fenêtre choisie par Julien. 🔴 Le site ne s'ouvre
pas au public avant les tests d'acceptation, et OVH ne se coupe qu'après une période d'observation et un retour
arrière ÉPROUVÉ.

## Méthode de livraison

| Lot | Méthode | Pourquoi | Essai réel qui le clôt |
|---|---|---|---|
| 1 | Implémenteur par lot + revue humaine du diff | parce que la production emprunte ce chemin (l'interrupteur HubSpot), que deux dépôts doivent se déployer dans l'ordre, et que « en panne n'est pas débranché » ne se voit pas au compilateur | en production, l'écran du compte montre le portail du cobaye, et l'interrupteur refuse l'extinction tant qu'il est relié |
| 2 | En direct | parce que chaque morceau est petit, réversible et vérifiable par un test | un banc lancé sur l'adresse de production refuse ; `docker stats` montre les limites sur le VPS ; `/ops` nomme la copie |
| 3 | Implémenteur par lot + revue humaine du diff | parce que chaque déploiement de production passera par ce chemin, avec des clés et des droits | le workflow, approuvé par Julien, déploie `main` sur la cible contre la base jetable ; `/live` répond avec le jeton d'origine et refuse sans |
| 4 | En direct | parce que c'est une mesure, pas une construction | les deux bancs rejoués sur la cible, chiffres au journal |
| 5 | En direct, pas à pas avec Julien | parce que ce sont des opérations d'infrastructure, une ressource facturée à la fois | une synchronisation réelle dans les deux sens (une analyse poussée vers HubSpot, une étape de vente qui revient), et plus aucune session du connecteur dans `pg_stat_activity` de Supabase |
| 6 | En direct | parce que la preuve est une restauration, pas du code | une restauration chronométrée, les secrets relus |
| 7 | En direct | parce que ce sont trois règles Cloudflare | un ancien lien `/r/` résout par le nom de test |

Aucun workflow multi-agents : rien ici n'est un balayage mécanique à grande échelle.
