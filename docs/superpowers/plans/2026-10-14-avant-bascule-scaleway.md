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
- La double authentification est active sur les comptes de Julien chez Scaleway, GitHub, Cloudflare, Vercel et
  Meta avant le lot 3 : le compte propriétaire de Scaleway peut tout faire, c'est le maillon le plus faible.
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
| 7 | Une seule adresse pour l'API (`mba.` supprimé, relais de la console retiré), et mm-hubspot réservé à Cloudflare | rien | oui, le webhook de Meta |
| J | La séquence du §10, quelques jours après le lot 5, jamais le même jour | tous | oui |

Les lots 1, 2 et 7 partent dès maintenant. Les lots 3 à 6 partent quand Julien a validé les ressources.

## Lot 1 : HubSpot, le portail lu par le connecteur

✅ **Déployé le 2026-10-14** : mm-hubspot `44c742e` d'abord (la route), Messaging Me `bfa345b0` ensuite, relu sans
rouge. Prouvé dans les deux sens par une sonde du vrai code en production : avant la route, une erreur 404 (jamais
« pas relié ») ; après, le portail cobaye exact pour l'espace relié et « pas relié » pour un témoin. Reste l'essai à
l'écran (Accueil et Paramètres de l'espace relié). Jaunes de la relecture faits le même jour, à relire avec le lot
suivant : un seul essai sous 3 s pour l'écran et les réglages (un connecteur figé les aurait tenus jusqu'à 155 s), le
portail lu en parallèle du numéro, une trace `hubspot_portail_illisible` quand la lecture échoue, les textes qui
décrivaient l'ancienne lecture, la garde de test élargie à toute mention de `mmhs.` hors commentaire. Reste un état
« inconnu » distinct de « non connecté » à l'écran (`todo.md`).

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

✅ **Déployé sur le VPS le 2026-10-14** (`e9be2d39`), relu sans rouge : les deux workers tournent à 1 Go et 1 CPU,
leur tas V8 plafonne à 524 Mo (Node le cale sur la moitié de la limite), contrôle de fumée vert. Reste des jaunes
de la relecture : relire le `RestartCount` des workers le 2026-10-15 (la mesure n'a duré que 32 minutes, les
travaux de nuit n'y étaient pas) ; vérifier sur les vrais noms d'hôte de Scaleway, au premier essai à deux copies,
que la FIN du nom (`API_COPIE=auto`) distingue bien les copies, sinon passer à une empreinte du nom entier.

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

✅ **Éprouvé le 2026-10-14 à Amsterdam**, sur la base jetable : le premier déploiement a construit et poussé l'image,
joué les 234 migrations, démarré les deux workers et passé l'API sur l'image ; l'API privée refuse tout appel sans
jeton. Restent : l'appel avec le jeton d'origine (clé `cloudflare-origine`), la mesure d'une requête de 23 Mo, et le
tunnel de `npm run migrations` (éprouvé à la main pour les tests d'intégration). ⚠️ Deux jaunes de la relecture, à
fermer avant que le workflow serve la production : un worker qui échoue à démarrer laisse les deux workers sur
l'image neuve et l'API sur l'ancienne, sans retour automatique (on relance le workflow sur l'ancien commit) ; et le
compose et le `.env` de la machine sont remplacés AVANT le `pull`, donc un `pull` refusé laisse un `IMAGE_TAG` qui
ne décrit plus les conteneurs.

**Pourquoi** : §10 bis, plus les étapes 1, 6 et 7 du §10, faites une première fois avant le jour J.

**Tâches**
- Avec l'accord de Julien, ressource par ressource (environ 70 € par mois aux petites tailles, prix relevés le
  2026-10-14) : le réseau privé à Amsterdam (`nl-ams` : Paris refusait toute nouvelle machine), la Public Gateway S et son bastion, le registre privé, l'espace de
  conteneurs privé rattaché au réseau privé, la machine des workers sans adresse publique, une base jetable de la
  gamme visée, sur disque bloc, avec le chiffrement du disque activé (une option de Scaleway, à cocher à la création).
- La connexion à la base chiffrée ET vérifiée : `DB_SSL_CA_FILE` avec le certificat de Scaleway (le code le prévoit
  déjà, `src/db/ssl.ts`). À vérifier sur l'adresse PRIVÉE, que le certificat doit couvrir ; jamais `DB_SSL_INSECURE`.
- Les commandes de création s'écrivent dans `DEPLOY.md` (section Scaleway), rejouables à la main. Pas de
  Terraform, parce qu'il s'agit d'une seule plateforme et d'une dizaine de ressources créées une fois.
- `npm run migrate` sur la base jetable, depuis la machine des workers : les extensions se créent vraiment
  (prérequis 8 du §10), `schema_migrations` et `french_sans_accent` se relisent.
- Le tunnel par le bastion pour lire une base sans endpoint public, et `npm run migrations` qui passe par lui
  (§10 bis) : sans lui, on ne saurait plus d'un poste ce qui est appliqué en production.
- Le workflow `deploy-scaleway.yml` : `workflow_dispatch` seul, environnement `scaleway` (approbation de
  Julien). Il construit l'image avec `REVISION`, la pousse au registre, migre depuis la machine des workers par le
  bastion, redémarre les workers sur la même image, puis déploie l'API une fois chaque worker démarré. Le retour arrière est le même workflow
  lancé sur un commit antérieur.
- Une application IAM `github-deploy` (registre et conteneurs, rien d'autre) et une clé SSH pour le bastion, posées
  par Julien dans les secrets de l'environnement `scaleway` : Claude ne voit jamais ces secrets.
- Le jeton d'origine (§7.3) : le conteneur est privé, et le format exact du jeton se relit ce jour-là.
- La taille maximale d'une requête vers le conteneur : une requête de 23 Mo, à travers Cloudflare (§11).

**Tests attendus** : un test lit le workflow et refuse tout autre déclencheur que `workflow_dispatch`, ainsi que
l'absence de l'environnement `scaleway` (le dépôt est public).

## Lot 4 : le banc sur la cible et le budget de connexions

✅ **Banc rejoué le 2026-10-14** sur la base jetable d'Amsterdam (DB-DEV-M, 150 connexions), base `banc`, chiffres au
journal technique : 300 appels/s par copie d'API, réception de Meta à 24 ms en rupture, file des statuts à
27,8 accusés/s, `API_PLAFOND_GLOBAL_PAR_10S=2100` à poser au jour J. La gamme de la base de production est choisie par
Julien le même jour : DB-PRO2-XXS, DB-POP2-2C-8G si rupture (§13, point 9). Restent : le budget de connexions,
recalculé sur le `max_connections` relu à la création de cette base (`tests/budget-pooler.test.ts`) ; le second banc (`banc-deux-api-2.mts`), à rejouer sur le
conteneur serverless lui-même plutôt que sur la machine, son épreuve d'arrêt étant ce que l'autoscaling fera.

**Pourquoi** (§7.5, §7.8) : les chiffres d'aujourd'hui, mesurés à Londres à 10 ms, ne survivent pas au déménagement.

**Tâches** : relever le nombre de connexions de la base jetable ; mettre à jour `tests/budget-pooler.test.ts` et
les tailles de pool ; rejouer `scripts/banc-api.sh` avec la latence de la région, et le second banc
(`scripts/banc-deux-api-2.mts`, ses cinq épreuves) ; reposer `API_PLAFOND_GLOBAL_PAR_10S` à 70 % de la capacité
mesurée ; revoir `DB_POOL_RECEPTION_MAX` et la concurrence de `webhook-status` ; proposer à Julien la taille de la
base et de la machine sur ces chiffres, avec leur prix. Tout se consigne au journal technique.

## Lot 5 : la répétition, mm-hubspot chez Scaleway

✅ **Fait le 2026-10-15.** Le connecteur tourne chez Scaleway : base `mm-hubspot-db`, conteneur privé derrière
Cloudflare, worker sur la machine des workers. Données copiées à l'identique (20 tables, 244 lignes), plus aucune
session chez Supabase, la sonde du lot 1 concorde par Internet, et Julien a vu la carte et la synchronisation dans
HubSpot. Restent : la relecture du lot, puis, après quelques jours d'observation, le retrait du connecteur du VPS
(`todo.md`).

**Pourquoi** (§8, étape 0 du §10) : les gestes du jour J sur un produit qui peut se permettre un raté, et ses
connexions sorties du budget de la base principale avant le calcul définitif.

**Tâches** : sa base managée (endpoint privé) et ses migrations ; l'export des schémas `mmhs` et `pgboss_mmhs`
depuis Supabase, puis leur restauration ; son `DATABASE_URL` basculé ; son API et son worker déployés par un
workflow du même modèle, dans son dépôt. `HUBSPOT_SERVICE_URL` de Messaging Me pointe alors sur une adresse
publique : le canal service passe par Internet, signé et horodaté, et ce passage s'éprouve. Sa forme, décidée le
2026-10-14 (§8) : son API en conteneur privé derrière Cloudflare, avec le jeton d'origine, comme `api.` ; son worker
en troisième conteneur borné sur la machine des workers, sans les secrets de Messaging Me.

⚠️ **Depuis le lot 1, l'écran du compte et les réglages lisent le portail PAR LE CONNECTEUR.** Pendant la répétition,
chaque arrêt ou redéploiement du connecteur, un retour arrière sous `44c742e`, ou un `SERVICE_SECRET` changé d'un seul
côté fait dire « non connecté » à l'espace relié et refuser en 503 l'extinction de l'interrupteur, le temps qu'il
dure ; la trace `hubspot_portail_illisible` le dit dans les journaux de l'API. Le canal passé par Internet s'éprouve
donc aussi par la sonde du lot 1 (le vrai code, comparé à la vérité de `mmhs`), avant et après la bascule de
`HUBSPOT_SERVICE_URL`.

## Lot 6 : la reprise après sinistre

✅ **Fait le 2026-10-15 sur la base du connecteur.** Sauvegarde manuelle (14 s), instance jetable (250 s), restauration
(28 s), vérification (3 s) : comptes identiques à la source, 2 jetons HubSpot sur 2 déchiffrés, 0 avec une clé fausse.
La procédure est dans `DEPLOY.md`, avec son piège : sans base cible ou sans le propriétaire d'origine, la restauration
se dit réussie et n'écrit rien. Reste : la rejouer sur la base de production de Messaging Me, dès sa création.

**Tâches** : la section de `DEPLOY.md` réécrite pour la base managée (sauvegardes automatiques, rétention,
instantané manuel avant le jour J) ; une restauration chronométrée sur une base jetable, celle du connecteur
d'abord ; après restauration, les secrets chiffrés relus avec la même `ENCRYPTION_KEY`.

## Lot 7 : supprimer `mba.messagingme.app`

⏳ **Commencé le 2026-10-14.** Un mois de journaux lu (journal technique, même date) : y arrivent encore le webhook de
Meta, deux sondes UptimeRobot et le contrôle de fumée ; le MCP de Claude Desktop de Julien est repointé sur `api.` ; le
logo de chaque e-mail, qui venait de `mba.`, est passé sur la console (`f8db19fd`, à déployer avant la suppression).
Restent, dans l'ordre : le webhook de Meta et UptimeRobot (Julien), des journaux muets quelques jours, une
vérification chez Meta qu'aucun modèle approuvé ne porte un bouton en `mba.…/r/`, puis la suppression.

**Pourquoi** : décision de Julien du 2026-10-14, une seule adresse de production (§13, point 13). Le faire sur le
VPS, avant la bascule, retire une étape au jour J.

**Tâches, dans cet ordre**
1. Lire les journaux du proxy NPM pour `mba.` sur plusieurs jours : tout ce qui y arrive encore (webhook de Meta,
   rappels RCS, webhooks entrants `/w/` de clients, `/mcp`) doit avoir trouvé une autre adresse avant la coupure.
2. Julien passe le webhook de l'app Meta « Messaging Me MBA » sur `https://api.messagingme.app/webhooks/meta`.
3. Les configurations MCP qui visent `mba.` (dont celle du poste de Julien) passent sur `https://api.messagingme.app/mcp`.
4. Une fois les journaux muets : l'hôte NPM de `mba.` retiré, l'enregistrement DNS supprimé chez Cloudflare (Julien),
   le conteneur `mba-web` arrêté.
5. Le relais attrape-tout `/api/backend/:path*` de la console (`web/next.config.mjs`) est retiré EN PRODUCTION
   (§13, point 14), après lecture des journaux de Vercel : aucun appel attendu dessus, en particulier d'anciens
   webhooks entrants `/w/` donnés à des clients. Seulement quand `NEXT_PUBLIC_API_URL` est posée : la topologie de
   même origine des e2e et du développement garde son relais. `/r/` et `/m/` restent.
6. Le filtre « seul Cloudflare » du proxy NPM est étendu à `mm-hubspot.messagingme.app` (§13, point 16), après
   lecture de ses journaux. Messaging Me l'appelle par le réseau Docker interne, que le filtre ne touche pas.
7. `CLAUDE.md`, `documentation.md` et `brain/INFRA.md` disent l'état nouveau : leurs passages sur le routage par
   chemin de `mba.`, sur l'attrape-tout de la console et sur l'accès à mm-hubspot deviennent faux à cet instant, pas
   avant.

**Assumé par Julien** : les liens `/r/` et visuels `/m/` déjà envoyés sous `mba.` cessent de répondre, sans
redirection.

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
| 7 | En direct, pas à pas avec Julien | parce que c'est de la configuration, et que le changement du webhook de Meta se surveille en direct | un vrai message WhatsApp entrant traité juste après le changement du webhook, puis `mba.` qui ne répond plus, `console.messagingme.app/api/backend/live` qui ne relaie plus rien, et un appel direct au VPS sur `mm-hubspot.` refusé |

Aucun workflow multi-agents : rien ici n'est un balayage mécanique à grande échelle.
