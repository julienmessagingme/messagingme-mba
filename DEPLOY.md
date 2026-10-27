# Déploiement : la production chez Scaleway (depuis le 2026-10-26), et l'ancien VPS

🔴 **LA PRODUCTION TOURNE CHEZ SCALEWAY DEPUIS LE 2026-10-26 À 19 H 08** (Amsterdam, `nl-ams`) : le conteneur
serverless `mba-api` derrière Cloudflare (`api.messagingme.app` en CNAME vers lui, la règle « Jeton d'origine api »
pose son jeton d'accès), les workers et `mba-application` sur la machine `mm-workers`, la base `mm-prod-db` (base
`rdb`, adresse privée seule). On déploie par le workflow (section « Scaleway », plus bas), et les gestes d'après sont
les mêmes qu'avant (la fumée, les fiches OAuth, `aide:charger` sur la machine).
- **Lire la production** : jamais d'un poste, dont le `DATABASE_URL` est l'ANCIENNE base (Supabase). Par la machine,
  avec l'image en service : `ssh -J bastion@<ip de la passerelle>:61000 root@<ip privée> "docker run --rm --env-file
  /opt/messagingme/.env.prod rg.nl-ams.scw.cloud/messagingme/mba:<sha> npm run migrations"`. Les journaux des workers
  se lisent sur la machine (`docker logs`), ceux de l'API dans Cockpit, la console de Scaleway.
- **Changer un secret** : Julien, dans le conteneur (variables secrètes, console de Scaleway) ET dans
  `/opt/messagingme/.env.prod` de la machine, puis les workers redémarrés : les deux partagent `ENCRYPTION_KEY` et
  `AUTH_SECRET`, et une différence casse le déchiffrement ou les sessions.
- **Retour arrière, tant que le VPS existe** : chez Cloudflare, `api` repasse en A vers le VPS et la règle « Jeton
  d'origine api » se désactive ; sur le VPS, `docker compose start` des quatre conteneurs. Ce qui a été écrit chez
  Scaleway depuis 19 h 08 n'est PAS dans Supabase : le recopier d'abord, sinon il est perdu. Pendant l'observation, le
  VPS et Supabase restent ARRÊTÉS et intacts : on n'y relance rien, on n'y écrit rien.

Tout ce qui suit sur le VPS décrit l'ANCIEN hébergement, pour le retour arrière et pour l'histoire.

Quatre conteneurs sur le réseau `mcp-robot_default` : `mba-api` (Fastify :8095), DEUX workers pg-boss
(`mba-worker` au rôle `principal`, `mba-worker-analyse` au rôle `analyse`, depuis le 2026-10-03) et `mba-web`
(Next.js :3000, l'ANCIENNE console). NPM sert l'API sous `api.messagingme.app` (CORS en liste blanche, `CORS_ORIGINS`),
et `mba.messagingme.app` par un routage par CHEMIN : `/api/backend/*` vers `mba-api` (préfixe retiré), `/r/`, `/m/`
et `/mcp` vers `mba-api`, le reste vers `mba-web` ; c'est ce qui garde vivantes les adresses déjà distribuées et le
webhook de Meta. La console (`console.messagingme.app`) et la vitrine (`app.messagingme.fr`) sont sur Vercel et
se déploient au `git push` : ce document ne les concerne pas (`CLAUDE.md`, section Déploiement).

🔴 **`$VPS` N'EST PAS UNE VARIABLE D'ENVIRONNEMENT, C'EST UNE CAVITÉ VOLONTAIRE.** L'adresse IP du VPS ne
figure plus dans ce dépôt : elle vit dans le `CLAUDE.md` global du poste, hors dépôt. Raison, et elle est
concrète : les noms qui mènent à ce serveur (`api.` et `mba.messagingme.app`) sont **proxifiés par
Cloudflare** (la console `console.` ne l'est pas, elle est servie en direct par Vercel), ce qui masque l'adresse
d'ORIGINE. La publier annulerait ce masquage, et permettrait de frapper le serveur en direct, donc de
contourner d'un coup le WAF, la protection anti-déni de service et les règles de Cloudflare. Un dépôt privé
peut redevenir public (c'est arrivé le 2026-09-15) ; une adresse d'origine publiée, elle, ne se reprend pas.

⚠️ **ELLE RESTE DANS L'HISTORIQUE GIT**, ce nettoyage ne porte que sur l'état courant. La parade DURABLE
n'est pas documentaire, elle est côté serveur, et elle est posée depuis le 2026-09-21 :

🔴 **`api.` ET `mba.messagingme.app` N'ACCEPTENT QUE CE QUI ARRIVE PAR CLOUDFLARE.** Deux fichiers
personnalisés de NPM, que NPM ne réécrit jamais : `/data/nginx/custom/http_top.conf` (la liste des plages
de Cloudflare, et la table des hôtes visés) et `/data/nginx/custom/server_proxy.conf` (la ligne de refus).
Un appel direct sur l'IP est fermé sans réponse (`444`). Posé pour ces deux hôtes le 2026-09-21, le filtre
couvre depuis le 2026-10-10 tous les hôtes du VPS qui passent par Cloudflare ; la liste vit dans le fichier,
pas ici (dépôt public).
- 🔴 **Le filtre lit `$realip_remote_addr`, JAMAIS `$remote_addr`.** NPM réécrit `$remote_addr` avec
  l'en-tête `X-Real-IP` (`nginx.conf`), que n'importe qui peut envoyer à travers Cloudflare : un filtre
  posé dessus bloquerait de vrais utilisateurs et se laisserait tromper. Vérifié : un appel direct portant
  un `X-Real-IP` d'une plage Cloudflare est bien refusé.
- ⚠️ **`server_proxy.conf` est inclus dans TOUS les hôtes du VPS**, d'où la table qui restreint l'effet aux
  hôtes listés. Un nouvel hôte derrière Cloudflare s'y ajoute, sinon il reste joignable en direct. Y ajouter quelque chose pour un autre projet se fait À LA SUITE, jamais en écrasant le fichier.
- ⚠️ **En HTTP simple (port 80), l'appel direct reçoit encore un `301` vers l'adresse HTTPS**, parce que la
  redirection de NPM passe avant notre ligne. Rien n'atteint l'application par là, et la redirection renvoie
  vers Cloudflare.
- ⚠️ **Diagnostic d'un 502 inchangé** : l'appel INTERNE se fait sur `mba-api:8095` dans le réseau Docker,
  sans passer par NPM. Un appel direct sur l'IP publique rend désormais une connexion fermée, ce qui est le
  comportement voulu et pas une panne.
- **Les plages de Cloudflare** (`https://www.cloudflare.com/ips-v4` et `/ips-v6`) changent rarement ; les
  relire si Cloudflare annonce un changement.
- **Retour arrière** : supprimer les deux fichiers, puis `nginx -s reload` dans le conteneur NPM.
- **Éprouvé à la pose, pas seulement écrit** : quatre semaines de journaux relues AVANT (aucun appelant
  légitime hors Cloudflare), accès direct refusé sur les deux hôtes, service inchangé via Cloudflare, un autre
  client du VPS intact, un vrai message WhatsApp reçu de bout en bout, et le renouvellement Let's Encrypt
  simulé à travers le filtre (`certbot renew --dry-run`, validation `webroot`, qui arrive par Cloudflare).

## 0. Déjà fait (pré-staging sur le VPS)

- Repo cloné dans `/home/ubuntu/mba`, les 3 images Docker **buildées et validées** sur le VPS.
- `/home/ubuntu/mba/.env.prod` **créé et rempli** : `AUTH_SECRET` généré (openssl), `DATABASE_URL`
  = pooler Supabase **session mode** `aws-1-eu-west-2` (IPv4, joignable des conteneurs ;
  le host direct `db.<ref>.supabase.co` est IPv6-only et injoignable), `DRY_RUN=true`.
- Migrations déjà appliquées (base partagée). Le pg-boss du WORKER créera son schéma au 1er démarrage ; l'API
  ne le crée jamais (elle refuse de démarrer tant qu'il n'existe pas, cf. « Montée de version de pg-boss »).

## 1. La SEULE entrée humaine restante : DNS

Créer dans Cloudflare `mba.messagingme.app` -> A `$VPS`, **Proxied** (orange).

## 2. Démarrer (une commande)

> ⚠️ **Le dépôt est PUBLIC depuis le 2026-09-15** (repassé en public pour que GitHub Actions reste gratuit ; il
> avait été privé du 2026-08-25 au 2026-09-15). Donc rien de sensible ne s'y écrit PLUS : les audits, les plans
> RSSI et tout ce qui décrit une faiblesse ouverte vont désormais dans `docs/prive/`, non versionné (`.gitignore`).
> ⚠️ Les audits committés AVANT cette règle restent suivis, donc publics (`AUDIT-*.md` à la racine, les rapports
> de contradiction de `docs/`) : `.gitignore` le dit, c'était un choix. Le VPS pull
> toujours via une **deploy key dédiée en lecture seule** (`~/.ssh/mba_deploy_key`) et l'alias `github.com-mba`
> de `~/.ssh/config`, avec le remote `git@github.com-mba:julienmessagingme/messagingme-mba.git`.
> Un `git pull` qui redemande un nom d'utilisateur GitHub signifie que le remote est repassé en HTTPS.
> **Ordre à respecter si un autre dépôt bascule un jour** : installer et VÉRIFIER l'accès pendant que le
> dépôt est encore public, et seulement ensuite le passer en privé. L'inverse coupe le déploiement.

```bash
ssh -i ~/.ssh/id_ed25519 ubuntu@$VPS
cd /home/ubuntu/mba
git pull            # si nouveau code
sudo REVISION=$(git rev-parse --short HEAD) docker compose up -d --build
sudo docker compose ps                    # mba-api, mba-worker, mba-web up
sudo docker compose logs --tail=20 mba-api mba-worker mba-web
# attendu : api "en écoute :8095", worker "démarré ... [DRY_RUN]", web "Ready"
```

## 2bis. Seed d'un compte admin (choisir un vrai mot de passe)

```bash
sudo docker compose run --rm --env-file .env.prod \
  -e SEED_EMAIL=julien@messagingme.fr -e SEED_PASSWORD='<motdepasse>' \
  -e SEED_PHONE_NUMBER_ID=demo-pn mba-api npx tsx db/seed.ts
```

## 4. NPM (proxy host + HTTPS)

Via l'UI http://$VPS:81 ou l'API (cf CLAUDE.md) :
- Domain `mba.messagingme.app`, Forward `http` -> host `mba-web`, port `3000`.
- Block exploits ON, Websocket ON.
- SSL : Let's Encrypt (`certificate_id="new"`, `ssl_forced=true`, `letsencrypt_agree=true`)
  — Cloudflare en Full exige un cert cote NPM (sinon HTTP 525).

## 5. Vérifier

- https://mba.messagingme.app -> page de login.
- Login avec le compte seedé -> Contacts / Campagnes.
- Importer un CSV, créer + lancer une campagne. En `DRY_RUN=true`, le worker fait passer les
  destinataires `pending -> sent` (message-id synthétique), sans rien envoyer chez Meta.

## 6. Passer au LIVE (quand le vrai numéro est prêt)

1. Provisionner le numéro Meta dans la base (`phone_numbers`, avec le bon `tenant_id`) et le
   `waba` associé. Le `phone_number_id` doit correspondre à celui choisi dans la campagne.
2. Dans `.env.prod` : `DRY_RUN=false`, `META_ACCESS_TOKEN=<token>` (System User / Cloud API),
   `META_GRAPH_VERSION=v25.0`.
3. `docker compose up -d` (recrée les conteneurs avec les nouvelles env vars).
4. Les templates utilisés doivent exister et être approuvés côté Meta (nom + langue exacts).
5. Lancer une petite campagne test : les statuts passent `sent` avec de vrais `message_id` Meta.

## Redéploiement

⚠️ **Migrations d'abord.** `mba-api`/`mba-worker` écrivent des colonnes ajoutées par migration : si le nouveau
code est déployé AVANT que sa migration ait tourné, le chemin LIVE (webhook inbound, envois) plante en boucle
(`column ... does not exist`). Les migrations ne sont PAS auto-appliquées. Avant `up --build`, appliquer les
migrations en attente sur la base partagée :

```bash
cd /home/ubuntu/mba && git pull
export REVISION=$(git rev-parse --short HEAD)                     # 0) la révision que /ops affichera
sudo REVISION="$REVISION" docker compose build mba-api         # 1) OBLIGATOIRE avant de migrer, cf. ci-dessous
sudo docker compose run --rm --no-deps mba-api npm run migrate   # 2) applique les migrations (idempotent)
sudo REVISION="$REVISION" docker compose up -d --build         # 3) bascule les services
```

⚠️ **`REVISION` passe à CHAQUE `build` et `up --build`**, nommée après `sudo` (qui ne transmet pas l'environnement ;
`sudo -E` le transmettrait TOUT, `HOME` compris) : une reconstruction sans elle
repose « inconnue », que `/ops` affiche sous son titre. Ce n'est qu'un affichage, rien d'autre ne la lit.

⚠️ **Avec une seule copie de l'API, le trou du `up` peut s'allonger jusqu'à ~20 s** si un envoi du relais de l'agent de Meta (ou le signal d'un clic) est en vol : l'arrêt de l'ancien conteneur l'attend (`ATTENTE_GESTES_A_L_ARRET_MS`) avant de rendre la place. Rien n'est perdu : les webhooks de Meta non acquittés sont rejoués par Meta.

⚠️ **`mba-api` et `mba-worker` sont DEUX images distinctes** (même Dockerfile, `image:` implicite `mba-mba-api` / `mba-mba-worker`). `docker compose build mba-api` ne rebuild PAS le worker : un `up --force-recreate` ensuite relance le worker sur son ANCIENNE image (constaté 4.11 : nouvel env `DB_SSL_CA_FILE` + ancienne image sans la CA -> ENOENT crash-loop worker pendant que l'api tournait). Pour un changement de code/fichier baké : `docker compose up -d --build` (rebuild les DEUX), ou builder explicitement `mba-api` ET `mba-worker`.

🔴 **DEUX WORKERS DEPUIS LE 2026-10-03, ET QUATRE RÈGLES QUI EN DÉCOULENT** (`WORKER_ROLE`, `src/worker/roles.ts`).
- **Les déployer en DEUX TEMPS** : `up -d mba-api mba-worker mba-web`, attendre dans les journaux la ligne « démarré » du principal, PUIS `up -d mba-worker-analyse`. Le pooler en mode session est plafonné à « Pool Size » sessions (15 jusqu'au 2026-10-03, 30 depuis) et seuls les workers en tiennent (pg-boss plus l'écoute) : les relancer d'un coup pendant que le pooler retient encore les sessions des conteneurs tués frôle ce plafond, et `EMAXCONNSESSION` fait redémarrer en boucle. Fait ainsi le 2026-10-03, sans un refus.
- **Un `--force-recreate` après un changement de `.env.prod` doit NOMMER `mba-worker-analyse`** : sinon il garde l'ancien environnement, en silence.
- **Une migration qui doit passer APRÈS le `up` casse la routine build, migrate, up**, puisque `migrate` applique tout ce que l'image porte. Cas de 0202 (elle efface une ligne que l'ancien worker réécrivait toutes les 20 s) : build, `up`, PUIS `migrate`.
- **Retirer ou renommer un rôle de worker, c'est aussi effacer sa ligne de `worker_heartbeat`** (comme 0202) : sinon l'API, qui surveille chaque ligne (`src/ops/surveillance-workers.ts`), alerte toutes les heures pour un rôle qui n'existe plus. Contrôle avant le `up` : `select id, now() - beat_at from worker_heartbeat` ne doit rendre que des lignes vivantes.
- **Chaque rôle en UN SEUL exemplaire** : `groupConcurrency` est local au processus pg-boss, deux copies d'un rôle doubleraient le plafond par espace et dédoubleraient les minuteries.

🔴 **Le `build` de l'étape 1 n'est pas optionnel, et son oubli est SILENCIEUX.** `docker compose run mba-api`
démarre un conteneur depuis l'IMAGE, pas depuis le répertoire du VPS. Les migrations sont copiées dans l'image
au build : après un simple `git pull`, les nouveaux `.sql` sont sur le disque de l'hôte mais **absents de
l'image**, donc `npm run migrate` répond fièrement **« à jour, rien à appliquer »** alors que rien n'a été
appliqué. Si on croit ce message et qu'on enchaîne le deploy, on met en production du code qui lit une colonne
inexistante. Constaté le 2026-07-18 sur les migrations 0037-0039.

Vérification en une commande quand il y a un doute :
```bash
sudo docker compose run --rm --no-deps --entrypoint sh mba-api -c 'ls db/migrations | tail -4'
```
La dernière migration du repo doit y figurer. Sinon, l'image est périmée : rebuild avant de migrer.

(En dev, `npm run migrate` local pointe la même base prod via `.env` ; là, « à jour, rien à appliquer » est
fiable, puisqu'il lit le répertoire réel et non une image.)

🔴 **UNE FICHE DU BOT D'AIDE QUI A CHANGÉ DOIT ÊTRE CHARGÉE, ET RIEN NE LE RAPPELLE.** Le dépôt est la
SOURCE des fiches (`docs/aide/fiches/*.md`), la table `aide_fiches` n'en est que l'INDEX : un `git pull` +
`up --build` ne la met pas à jour, et le bot continue de répondre aux clients avec le texte d'avant, sans
qu'aucune erreur ne le signale. À faire après le déploiement, dès qu'un `.md` de ce dossier a bougé, OU que le
découpage a changé (`src/aide/fiches.ts`, `src/aide/structure.ts` : une fiche longue est chargée en morceaux, et
leur texte en dépend) :

```bash
sudo docker compose run --rm --no-deps mba-api npm run aide:charger
```

⚠️ **Idempotent par la clé** (le nom du fichier, ou `<nom>#<n>` pour un morceau) : relancer met à jour, ça ne duplique pas, donc le lancer « au cas
où » ne coûte rien. Il RETIRE aussi les lignes dont le fichier a disparu, sinon le bot répondrait avec une
page effacée du produit. Il ne vectorise rien : la fiche est trouvable par les MOTS tout de suite, par le
SENS au passage suivant du balayage.

⚠️ **Le déclencheur n'est pas seulement « j'ai écrit une fiche ».** Modifier une section de `features.md`
PÉRIME l'empreinte des fiches qui la citent, et `tests/aide-proposer.test.ts` rend la CI rouge tant qu'elles
n'ont pas été relues. Une fiche relue est une fiche à recharger.

⚠️ **Les fiches vivent DANS L'IMAGE** (`COPY docs/aide`) : une fiche poussée sans déploiement de l'API n'y est pas.
Pour la charger SANS déployer le code d'autres lots, monter le `docs/aide` du commit voulu dans l'image en service,
à une condition : `git diff --stat <révision en service> <sha> -- docs/aide src/aide db/charger-aide.ts` ne montre que
des fiches (si le chargeur ou `src/aide` ont bougé, on déploie ; et si une fiche d'un autre lot y décrit un code pas
encore déployé, le bot en parlerait trop tôt). Depuis le dépôt du VPS, sans toucher à son arbre :

```bash
cd /home/ubuntu/mba && git fetch -q origin && mkdir -p /tmp/aide-<sha> && git archive <sha> docs/aide | tar -x -C /tmp/aide-<sha>
sudo docker compose run --rm --no-deps -v /tmp/aide-<sha>/docs/aide:/app/docs/aide:ro mba-api npm run aide:charger
rm -rf /tmp/aide-<sha>
```

⚠️ **Exception — migration qui DROP (ou renomme) une colonne encore lue par l'ANCIEN code** (ex. `0030_drop_workflow_status.sql`) : **ordre INVERSÉ**, deploy le code D'ABORD, migrate ENSUITE. Sinon la colonne disparaît pendant que l'ancien conteneur (qui la lit encore) tourne toujours -> 500 « column … does not exist » le temps du rebuild. Règle générale : une migration qui AJOUTE une colonne se fait avant le deploy (le code neuf en a besoin) ; une migration qui RETIRE une colonne se fait après (le code neuf a cessé de la lire, l'ancien en a encore besoin).

```bash
cd /home/ubuntu/mba && git pull
sudo REVISION=$(git rev-parse --short HEAD) docker compose up -d --build   # 1) deploy le code qui ne lit plus la colonne
sudo docker compose run --rm --no-deps mba-api npm run migrate   # 2) PUIS drop la colonne
```

## 🔴 Montée de version de pg-boss : le WORKER d'abord, l'API ensuite

Depuis le 2026-09-28 (lot C de `docs/superpowers/plans/2026-09-28-api-multi-instances.md`), l'API empile par son
pool applicatif prêté à pg-boss, avec `migrate: false` : elle ne crée ni ne migre JAMAIS le schéma `pgboss`, c'est
le worker. Et pg-boss VÉRIFIE au démarrage de l'API que le schéma est à la version EXACTE de son code (égalité
stricte, donc dans les deux sens). Les déploiements ordinaires ne sont pas concernés. Une version de pg-boss qui
change son schéma impose en revanche deux règles :

- **le worker d'abord** : `sudo REVISION=$(git rev-parse --short HEAD) docker compose up -d --build mba-worker`, attendre dans ses journaux sa ligne
  « démarré » (sa migration est faite), PUIS la même commande pour `mba-api`. Un `up -d --build` des deux
  à la fois marche aussi, en plus bruyant : l'API refuse de démarrer (« c'est le WORKER qui le fait ») et Docker la
  relance (`restart: unless-stopped`) jusqu'à la fin de la migration, pendant quoi Meta reçoit des erreurs et rejoue.
- **un retour arrière de l'image APRÈS cette migration ne redémarre plus l'API** (schéma plus récent que son code) :
  revenir sur une version de pg-boss, c'est revenir aussi sur son schéma.

Le savoir avant de déployer : la version du code
(`sudo docker compose run --rm --no-deps mba-api node -p "require('./node_modules/pg-boss/package.json').pgboss.schema"`)
contre celle de la base (`select version from pgboss.version`). Égales : rien à faire.

## ⚠️ Retour arrière d'une image d'avant « écrire en premier » (migration 0252, lot B de 2026-10-23-shopify-numero-qr)

Une fois des messages Shopify réglés en TEXTE (`shopify_messages.texte`, filière application), une image d'avant ce lot
lit `modele` sans savoir qu'il peut être nul : son `brancher` écrirait un modèle à côté du texte resté en place (23514,
contrainte `shopify_messages_modele_ou_texte`) et son `servir` enverrait un modèle nul. Avant de revenir en arrière,
lire `select count(*) from shopify_messages where texte is not null` ; s'il y en a, les éteindre d'abord
(`update shopify_messages set actif = false where texte is not null`, puis le dire aux espaces concernés). La file
`application_premiers_messages` n'a pas besoin d'être vidée : une image ancienne ne la lit pas, ses lignes attendent.

## ⚠️ Le rechargement nginx n'est plus nécessaire depuis le 2026-10-03, mais s'il sert, il vient APRÈS le `healthy`

Les routes de `mba.` et d'`api.` nomment `mba-api` par une variable, que nginx relit seul (résolveur de Docker,
10 s) : un `up` ne laisse plus de 502 durable (mesuré : 4 à 5 s pendant le redémarrage, puis 200, sans recharger).
Le récit ci-dessous reste vrai pour un amont écrit EN DUR, par exemple une route ajoutée sans variable.

Vécu le 2026-09-08 : `up -d --build && nginx -s reload` enchaînés dans la même commande ont laissé les quatre
chemins d'API en 502, alors que le conteneur était `healthy` et répondait 200 en interne. La raison est le
timing : `up -d` REND LA MAIN avant que la recréation soit finie, donc le reload a résolu l'amont trop tôt,
sur l'ancienne adresse. Un second reload, quelques secondes plus tard, a tout remis d'aplomb.

```bash
sudo REVISION=$(git rev-parse --short HEAD) docker compose up -d --build
until [ "$(sudo docker inspect -f '{{.State.Health.Status}}' mba-api)" = healthy ]; do sleep 2; done
sudo docker exec mcp-robot_nginx-proxy-manager_1 nginx -s reload
```

C'est aussi pourquoi le contrôle ci-dessous n'est pas facultatif : il a attrapé ce cas exact, du premier coup.

⚠️ **La connexion SSH peut couper pendant le build** (vécu le 2026-09-26, « Connection reset by peer »). Ne rien
relancer à l'aveugle : lire `sudo docker inspect -f '{{.Created}}' mba-api mba-worker mba-web` (recréés après le
`pull` ?), puis un `grep` du changement DANS le conteneur, et refaire le `nginx -s reload`, que la coupure a
empêché. Ce jour-là, les trois conteneurs avaient été recréés sur le bon code malgré la coupure.

## 🔴 Dernière étape OBLIGATOIRE : le contrôle de fumée public

À lancer depuis un checkout qui possède Node et ses dépendances (par exemple le poste de développement) : le VPS
n'installe volontairement ni `node` ni `npm` sur l'hôte, ils vivent seulement dans les images Docker.

```bash
node scripts/fumee.mjs
```

Depuis le poste, PAS depuis le VPS : ce qu'on veut savoir, c'est ce que voit un client, à travers Cloudflare
et NPM. Il vérifie les trois adresses qui portent vraiment quelque chose, dont **le webhook Meta à l'adresse que
Meta appelle réellement** : `api.messagingme.app/webhooks/meta` depuis le 2026-10-15. `mba.messagingme.app` n'y
est plus sondé depuis le 2026-10-26 (lot 7 de la bascule) : plus rien ne l'appelait.

⚠️ **Ce n'est pas une formalité.** Le 502 par IP périmée est INTERMITTENT : absent au premier déploiement de
la journée, présent au second, sur exactement la même commande. Un conteneur `healthy` et un appel interne en
200 ne disent RIEN de ce que voit un client. Le script sort en code non nul et rappelle le remède
(`nginx -s reload`), qui n'est pas `docker network connect`.

⚠️ **À chaque déploiement de l'API, relire les fiches des clients OAuth** (Claude Code et claude.ai), depuis le
poste : `npm run oauth:fiches`. `src/oauth/clients.ts` les RECOPIE ; si Anthropic change une adresse de retour,
les connexions de Claude échouent sans rien dire. Code 1 : mettre à jour `CLIENTS_OAUTH` (et le CHECK de 0204 si
un identifiant change). Code 2 : claude.ai injoignable, à relancer.

## 🔴 Le SDK se publie APRÈS le déploiement de l'API, à la main

Le SDK (`sdk/`) embarque le contrat de l'API. Le publier avant le `up` de l'API qui porte ce contrat donnerait aux
intégrateurs des types pour des routes encore en 404. Donc, quand un lot change le contrat :

1. `npm run sdk:contrat` dans le commit qui change le contrat (sinon la CI est rouge), et monter la version de
   `sdk/package.json` si l'on veut la publier ;
2. déployer l'API comme d'habitude, contrôle de fumée compris ;
3. seulement ensuite : `gh workflow run sdk.yml --ref main`, puis lire le run.

Une version déjà publiée ne bouge plus : si son contenu change sans montée de version, le run échoue sans rien pousser.
Le run n'a d'effet que si le secret `SDK_DEPLOY_KEY` existe (commande de création dans `wip.md`, lot 16).

## 🔴 Le plugin Claude Code se publie APRÈS le déploiement de l'API, à la main

Ses skills nomment des outils du serveur MCP : publié avant le `up` de l'API qui les porte, le plugin les appellerait
en vain. Donc, quand `plugin/` change :

1. monter la version de `plugin/.claude-plugin/plugin.json` (Claude Code fige une installation sur elle : sans montée,
   personne ne reçoit le changement), et relancer `npm run plugin:generer` si la FAQ a bougé ;
2. déployer l'API comme d'habitude si un outil a changé ;
3. seulement ensuite : `gh workflow run plugin.yml --ref main`, puis lire le run.

Une version déjà publiée ne bouge plus, comme pour le SDK. Le run n'a d'effet que si le secret `PLUGIN_DEPLOY_KEY`
existe : le dépôt `julienmessagingme/messagingme-plugin` et sa clé de déploiement en écriture se créent une fois, par
Julien (commandes dans le journal, lot 10).

## ⚠️ Deux gestes qu'on oublie, et leur symptôme

**`up -d --build` OBLIGATOIRE dès que `web/next.config.mjs` bouge.** Les `rewrites` sont **gelés au build** de
l'image web : un simple `up -d` laisserait le proxy dans son état d'avant, et le chemin public `/r/:code`
rendrait un 404 Next, donc des liens de templates MORTS chez des destinataires réels.

**`users.password_hash` est un MIROIR transitoire** de `identities.password_hash` (migration 0072), gardé comme
chemin de retour. Ne pas le retirer tant que la confiance sur le multi-espaces n'est pas acquise, et ne jamais
l'utiliser comme source : `findIdentity` lit l'identité, pas le compte.

## 🔴 502 public juste après un `up --build`, alors que le conteneur est sain : NPM tient l'ANCIENNE IP

⚠️ **Corrigé à la source le 2026-10-03** : les quatre routes de `mba.` (`/api/backend/`, `/r/`, `/m/`, `/mcp`)
passent par une variable (`set $mba_api mba-api`), comme l'hôte `api.`. Si un 502 dure encore après un `up`,
chercher une route écrite EN DUR dans un `advanced_config`. La configuration d'avant est sauvegardée sur le VPS
(`/home/ubuntu/npm-backup-21-20261003T173529.json`).

Constaté le 2026-09-03. Après `up -d --build`, `mba-api` est `healthy`, mais `https://api.messagingme.app/health`
rend **502**. Ce n'est pas l'application, c'est nginx : recréer un conteneur lui donne une **nouvelle IP** sur
`mcp-robot_default`, et NPM a résolu son amont **au chargement de sa configuration**. Il tape donc une adresse
qui n'existe plus.

⚠️ **Le réflexe documenté ailleurs (`docker network connect`) ne suffit PAS ici**, et c'est ce qui fait perdre
du temps : le conteneur est DÉJÀ sur le bon réseau (`docker inspect` le montre), la commande ne fait rien, et
on cherche du côté de l'application. Ce qu'il faut, c'est recharger nginx :

```bash
sudo docker exec mcp-robot_nginx-proxy-manager_1 nginx -s reload
```

**Le diagnostic en deux commandes**, et c'est le geste à retenir bien au-delà de ce cas : comparer l'appel
INTERNE et l'appel PUBLIC isole la couche coupable d'un coup.

```bash
sudo docker run --rm --network mcp-robot_default curlimages/curl -s -o /dev/null -w '%{http_code}\n' http://mba-api:8095/health
curl -s -o /dev/null -w '%{http_code}\n' https://api.messagingme.app/health
```

Interne 200 + public 502 = le proxy. Interne 502 = l'application. (Rappel : Cloudflare remplace le corps de
toute réponse 5xx par sa page d'erreur, donc le corps public n'apprend rien.)

## 🔴 Ajouter une copie d'API ou un worker : le budget du pooler AVANT le conteneur

Chaque processus ouvre son propre pool (`DB_POOL_MAX`, fixé par service dans `docker-compose.yml`), et leur
SOMME doit tenir dans le « Pool Size » du pooler de Supabase, sinon les requêtes attendent chez Supavisor sans
aucune trace. Dans cet ordre :
1. Ajouter le service au compose, avec son `DB_POOL_MAX` (et son `PGBOSS_MAX` si c'est un worker, son
   `DB_POOL_RECEPTION_MAX` si c'est une copie d'API : le pool réservé à la réception de Meta, lot 14).
2. `npx vitest run tests/budget-pooler.test.ts` : il refuse un compose qui dépasse le pool, ou une copie d'API
   trop petite pour ses opérations lourdes.
3. S'il refuse : redimensionner chaque copie, ou monter « Pool Size » (Supabase : Database, Settings, Connection
   pooling) dans la limite que le même test calcule (pool plein, sessions et services de Supabase sous 80 % des
   connexions de Postgres).
4. Après tout changement du réglage, le MESURER (la sonde est décrite en tête du test) avant de changer la
   constante du test : un réglage enregistré n'est pas un réglage appliqué.

## ⚠️ Crash-loop transitoire au redéploiement (EMAXCONNSESSION) — normal, s'auto-résout

Juste après `up -d --build`, `mba-api` peut apparaître `Restarting (1)` pendant ~30-60 s. Deux symptômes
possibles, tous deux transitoires : soit le process redémarre (`/health` et `/live` injoignables -> NPM
renvoie une 5xx), soit le process est up mais la DB pas encore joignable (`/health` = **503 readiness**,
tandis que `/live` répond déjà 200). Cause : le pooler Supabase (session mode) est plafonné à **« Pool Size » sessions** (15 jusqu'au 2026-10-03, 30 depuis : le même réglage que le mode transaction, cf. `tests/budget-pooler.test.ts`) ;
quand `mba-api` et `mba-worker` (deux instances pg-boss) cold-start EN MÊME TEMPS pendant que le pooler tient
encore les sessions des conteneurs qu'on vient de tuer, le total dépasse « Pool Size » -> `EMAXCONNSESSION`. pg-boss émet
un event `error` non capté (Timekeeper.onCron) qui tue le process -> Docker le relance -> crash-loop bref.
(Depuis 4.3, le pool applicatif est en mode transaction sur `APP_DATABASE_URL:6543`, hors du budget session ->
la contention au cold-start est réduite mais pas nulle, pg-boss restant en session.)
⚠️ **Depuis le 2026-09-28, seul le WORKER tient encore des sessions** : l'API empile par son pool applicatif prêté
à pg-boss et n'ouvre plus aucune session (tant que `APP_DATABASE_URL` est posée ; vide, c'est le pool applicatif
entier qui retombe en session). Une API en `Restarting` au redéploiement n'est donc plus un `EMAXCONNSESSION` à
elle : lire ses journaux, la cause la plus probable est un schéma `pgboss` que le worker n'a pas encore migré
(ci-dessus, « Montée de version de pg-boss »).
**Ça se résout seul** dès que le pooler libère les sessions des conteneurs tués (quelques dizaines de
secondes). Attendre puis revérifier : `sudo docker ps --filter name=mba-api` doit finir sur `Up` stable
et `/health` sur 200 (readiness OK). Ne PAS restart en boucle manuellement (ça relance le cold-start et
prolonge la contention). Ce n'est pas lié au code déployé.

## Restauration / reprise après sinistre (DR) — item 4.13

L'app est stateless hors base : tout l'état vit dans le projet Supabase `npdqnrirxhqsyyvtvtjz`, jusqu'à la bascule vers
la base managée de Scaleway (qui porte ses propres sauvegardes : cette section se réécrit à ce moment-là, lot 6 de
`docs/superpowers/plans/2026-10-14-avant-bascule-scaleway.md`). La reprise = restaurer la base + repointer l'app.

### Ce qu'il faut sauvegarder (deux choses distinctes)
1. **La base** : CINQ schémas d'un seul projet, `public` (tables mba + `schema_migrations`), `pgboss` (files), `mmhs`
   et `pgboss_mmhs` (le connecteur mm-hubspot), `salesforce` (l'app Salesforce, sans clé étrangère vers `public`).
2. **Les secrets, HORS base et HORS git** : `.env.prod` sur le VPS (`AUTH_SECRET`, `META_ACCESS_TOKEN`,
   `ENCRYPTION_KEY`…) + celui de mm-hubspot. 🔴 **Sans `ENCRYPTION_KEY`, tous les secrets chiffrés en base sont
   INDÉCHIFFRABLES même après une restauration parfaite** : jetons et PIN des numéros (`waba_credentials`), mots de
   passe SMTP, seconds facteurs, jetons RCS, Channels Me et publicité, clés d'IA par espace, secrets Salesforce.
   `AUTH_SECRET` perdu = toutes les sessions invalidées (reconnexion). 🔴 **La copie de la clé hors du VPS se PROUVE
   par son empreinte** (les 16 premiers caractères du SHA-256 de la valeur, calculés de chaque côté) : une copie
   « au coffre » déclarée le 2026-09-23 s'est révélée introuvable le 2026-10-14 ; recopiée par Julien dans son
   gestionnaire de mots de passe le même jour, empreinte identique à celle de la production.

### Les sauvegardes, d'ici la bascule
Le plan de sauvegarde du projet Supabase n'a jamais été relevé : on le tient pour nul. **`scripts/sauvegarde-base.sh`**
fait chaque nuit un `pg_dump` des cinq schémas (format `custom`, ~24 Mo, ~10 s) dans `/home/ubuntu/sauvegardes-mba`
(fichiers lisibles du seul propriétaire, gardés 7 jours), relit la table des matières de la copie, et ne passe jamais
le mot de passe en argument. Planification (geste de Julien, persistance système ; posée le 2026-10-14, chaque nuit à
3 h 17 UTC) :

```bash
( crontab -l 2>/dev/null; echo '17 3 * * * sh /home/ubuntu/mba/scripts/sauvegarde-base.sh >> /home/ubuntu/sauvegardes-mba/journal.log 2>&1' ) | crontab -
```

⚠️ **RPO 24 h, et la sauvegarde vit sur le VPS** : elle protège d'une erreur sur la base (une table écrasée, une
migration fautive), pas d'une perte du serveur. Elle se lit par le pooler en mode SESSION (`DATABASE_URL`, 5432 ; le
mode transaction ne supporte pas `pg_dump`), TLS vérifié par `certs/supabase-pooler-ca.crt`.

### Restaurer
- **Sur une base neuve** (sinistre, ou bascule) : `vector`, `pg_trgm` et `unaccent` se créent AVANT `pg_restore`, car
  un dump par schémas ne porte pas les extensions (vérifié : aucune valeur par défaut ni fonction de nos schémas
  n'appelle le schéma `extensions` de Supabase). Puis `pg_restore --no-owner --no-privileges` ; la seule erreur
  attendue est `schema "public" already exists`.
- **Dégât localisé** : `pg_restore --table` ou `--schema` de la sauvegarde vers une base jetable, puis recopie ciblée.
  JAMAIS de restauration en place sur la production.
- ⚠️ **Migrations FORWARD-ONLY** (`db/migrate.ts`, aucun `*.down.sql`) : une migration destructrice ne se défait pas
  par le code, seulement par une restauration de données ou une migration compensatoire écrite à la main.

### Remise en service de l'app (RTO)
Nouvelle base -> nouvelle adresse. Dans `.env.prod` (mba **ET** mm-hubspot) : `DATABASE_URL`, `APP_DATABASE_URL`,
`DB_SSL_CA_FILE` ; puis `docker compose up -d --force-recreate` (l'env n'est relu qu'à la recréation). Le schéma
`pgboss` revient avec la base. Un `mba-api` de test sur une copie ne démarre que si `pgboss` y est à sa version ; un
worker sur une copie ne tourne qu'en `DRY_RUN=true` (sinon il reprend les campagnes et ENVOIE).

### L'exercice (non destructif, cible JETABLE, jamais la prod)
**`scripts/exercice-restauration.sh`** restaure la dernière sauvegarde dans un Postgres 17 jetable (`mba-exercice-pg`,
écoute `127.0.0.1:55432` seulement), puis `scripts/exercice-dechiffrer.ts` (dans l'image de l'API) relit la copie et
déchiffre TOUS ses secrets avec la clé de production ; tout disparaît à la fin, même en cas d'échec. Le refaire après
chaque changement d'hébergement de la base, et au moins une fois par trimestre.

**Dernière vérif DR : 2026-10-14, réussie.** Sauvegarde 9 s (24 Mo) ; base jetable prête en 3 s (16 s avec le
téléchargement de l'image) ; restauration 4 s ; relecture et déchiffrement 2 s : **29 secrets sur 29** déchiffrés
(16 colonnes), **0 sur 29** avec une clé fausse (le test distingue la clé). Copie identique à la production : neuf
tables comptées à l'identique, dernière migration et dernier message identiques à la microseconde. Hors données, le RTO
réel se mesure à la bascule (création de la base cible, recréation des conteneurs).

### Chez Scaleway (le connecteur depuis le 2026-10-15, Messaging Me depuis le 2026-10-26)

La base managée porte ses propres sauvegardes. 🔴 **Les AUTOMATIQUES sont des INSTANTANÉS du volume** (disque SBS),
nommés `<instance>_autobackup` : un par jour à l'heure de création de l'instance (12 h 40 UTC pour `mm-prod-db`, 20 h UTC
pour `mm-hubspot-db`, `backup_schedule`), gardés 3 jours depuis le 2026-10-27 (7 avant, décision de Julien pour le
coût), dans la région. Ils se lisent par `scaleway-cli rdb snapshot
list instance-id=<base> region=nl-ams` : **`rdb backup list` ne les montre PAS** (lue seule, elle a fait croire le
2026-10-26 que les deux bases n'avaient aucune sauvegarde). Un instantané se restaure en une NOUVELLE instance
(`rdb snapshot restore`), chemin NON ÉPROUVÉ. Les sauvegardes LOGIQUES sont manuelles (`scaleway-cli rdb backup create
instance-id=<base> database-name=rdb name=<nom> expires-at=<date> region=nl-ams`, expiration à 7 jours au plus, § 7.2
de l'architecture cible) et se restaurent dans une base existante, par la procédure éprouvée ci-dessous. ⚠️ Après une
bascule ou une restauration vers une nouvelle instance, en faire une dans la foulée : le prochain instantané part à
l'heure de l'instance, pas à celle de la mise en service.

**Restaurer une sauvegarde logique**, la procédure éprouvée le 2026-10-15 sur la base du connecteur :
1. Une instance de même moteur dans `mm-prive` (adresse privée seule), qui porte les MÊMES UTILISATEURS que la
   source (`mmhs_admin` pour le connecteur), puisque la sauvegarde leur attribue chaque objet.
2. La base cible CRÉÉE d'abord (`rdb database create`), puis les droits de l'utilisateur dessus (`rdb privilege set
   ... permission=all`) : la restauration écrit DANS une base existante.
3. `scaleway-cli rdb backup restore <sauvegarde> instance-id=<cible> database-name=<base> region=nl-ams --wait`.
4. 🔴 **Vérifier par le catalogue** (`pg_namespace`, `pg_class`) que les schémas sont là : sans la base cible ou sans
   le propriétaire d'origine, Scaleway déclare la restauration `ready` SANS RIEN AVOIR ÉCRIT (vécu deux fois le
   2026-10-15). Puis compter table par table contre la source, et déchiffrer les secrets avec la même
   `ENCRYPTION_KEY` (pour le connecteur, ses jetons HubSpot ; pour Messaging Me, `scripts/exercice-dechiffrer.ts`).
5. Remettre en service : une nouvelle instance a une NOUVELLE ADRESSE et un NOUVEAU CERTIFICAT. Le certificat vit dans
   l'image (`certs/`, `DB_SSL_CA_FILE`) : le committer et redéployer par le workflow, puis changer `DATABASE_URL` dans
   les variables secrètes du conteneur et dans le `.env.prod` de la machine, et recréer les workers.

⚠️ **Une copie par `pg_restore` dans `rdb`** (celle du jour J) rend une erreur de plus que dans une base créée par
`mba_admin` : `must be owner of schema public` sur `COMMENT ON SCHEMA public`, `rdb` appartenant au superadministrateur
de Scaleway. Elle est sans effet, `pg_restore` restaure tout le reste ; un script qui n'attend que « schema public
already exists » doit l'accepter aussi, sinon il s'arrête avant ses vérifications (vécu le 2026-10-26).

**Dernière vérif DR chez Scaleway : 2026-10-15, réussie, sur la base du connecteur** (63 Ko). Sauvegarde manuelle
14 s ; instance jetable prête en 250 s ; restauration 28 s ; vérification 3 s : 20 tables et 247 lignes identiques à
la source, **2 jetons HubSpot sur 2** déchiffrés avec la clé du connecteur, **0 sur 2** avec une clé fausse. Le
chemin des données tient en cinq minutes à cette taille ; le redéploiement pour le nouveau certificat s'y ajoute.

**Puis le même jour, sur les VRAIES données de Messaging Me** : copiées de Supabase dans une base `repetition` de
l'instance de production (`mm-prod-db`), sauvegardées par Scaleway (15 s, 24,7 Mo), restaurées dans une base jetable
créée AVEC l'utilisateur `mba_admin` (propriétaire de chaque objet de la copie) et une base cible créée d'abord :
base jetable prête en 192 s, restauration 16 s, vérification 6 s. Le catalogue porte les 124 tables et les
extensions (`vector`, `pg_trgm`, `unaccent` : la sauvegarde logique de Scaleway les recrée), les comptes sont
identiques table par table (55 089 lignes), **30 secrets sur 30** se déchiffrent avec la vraie clé, **0 sur 30**
avec une fausse. Le contrôle de déchiffrement d'une base de Scaleway ne passe pas par `exercice-dechiffrer.ts`, dont
la garde n'accepte qu'une base locale « exercice » : une copie dont la garde n'accepte qu'une adresse privée de
Scaleway et un nom de base jetable, et dont le certificat se lit en clair (l'image de l'API tourne sous un
utilisateur non root : un certificat en 600 rend EACCES).

## Scaleway : le socle et le bouton de déploiement

La cible et ses raisons : `docs/ARCHITECTURE-CIBLE.md` (§7, §10, §10 bis). Le plan : lot 3 de
`docs/superpowers/plans/2026-10-14-avant-bascule-scaleway.md`. Ici, la seule procédure.

🔴 **TOUT EST À AMSTERDAM (`nl-ams`), PAS À PARIS** (décision de Julien du 2026-10-14). Paris refusait toute nouvelle
machine à un compte neuf (quotas à 0, puis rupture de stock confirmée par le support) ; ce qui y avait été créé le
matin est supprimé. Le réseau privé et la base sont RÉGIONAUX : une ressource créée hors de `nl-ams` ne les verrait pas.

### Ce qui existe (créé le 2026-10-14, projet « Messaging Me App », région `nl-ams`)

| Ressource | Nom | Zone | Note |
|---|---|---|---|
| VPC et réseau privé | `mm-vpc`, `mm-prive` | `nl-ams` | 172.16.0.0/22, adresses attribuées par l'IPAM |
| Registre privé | `rg.nl-ams.scw.cloud/messagingme` | `nl-ams` | image `mba:<sha complet>` |
| Bucket des médias | `mm-medias-prod` (Object Storage, créé le 2026-10-27) | `nl-ams` | privé (seul le propriétaire en ACL, lecture anonyme en 403), sans versions : un fichier effacé l'est vraiment ; lot A des médias, plus bas |
| Espace de conteneurs | `messagingme` | `nl-ams` | le conteneur de l'API `mba-api` y est créé : privé, rattaché à `mm-prive` ; sa TAILLE se déclare dans `ops/scaleway/conteneur-api.json` (de 1 à 3 copies, décision de Julien du 2026-10-15 ; 1 120 mvCPU et 2 Go ; sonde HTTP sur `/live` ; pools et plafond), que le workflow applique à chaque déploiement en complétant les variables du script sans les remplacer. ⚠️ Le minimum à 1 garde aussi le conteneur d'ESSAI allumé (environ 40 € par mois) dès le prochain déploiement |
| Passerelle | `mm-passerelle` (VPC-GW-S) | `nl-ams-2` | bastion SSH sur le port 61000, NAT et route par défaut vers `mm-prive` |
| Base JETABLE | `mm-banc` (PostgreSQL 17, DB-DEV-M) | `nl-ams` | adresse privée seule, disque chiffré, sauvegardes en région ; mot de passe dans Secret Manager `mm-banc-db-admin` ; à supprimer après les lots 3 et 4 |
| Base de PRODUCTION | `mm-prod-db` (PostgreSQL 17, DB-DEV-M depuis le 2026-10-27, DB-PRO2-XXS avant ; créée le 2026-10-15) | `nl-ams` | adresse privée seule (172.16.0.8), disque bloc chiffré de 20 Go, sauvegardes quotidiennes en région gardées 3 jours (7 jusqu'au 2026-10-27) ; 150 connexions dont 3 réservées (200 en DB-PRO2-XXS : Scaleway règle `max_connections` selon la gamme, à relire et à reporter dans `tests/deploy-scaleway.test.ts` à chaque changement) ; mot de passe de `mba_admin` dans Secret Manager `mm-prod-db-admin` ; VIDE jusqu'au jour J, les données arrivent dans `rdb` |
| Machine des workers | `mm-workers` (DEV1-M depuis le 2026-10-27, PRO2-XXS avant ; Ubuntu 24.04) | `nl-ams-2` | sans adresse publique, disque de 20 Go ; Docker et Compose posés au premier démarrage (cloud-init) ; un changement de gamme se fait machine arrêtée (`instance server stop`, `update commercial-type=`, `start`), conteneurs repartis seuls (`unless-stopped`) : 52 s de coupure le 2026-10-15, environ une minute le 2026-10-27 |

Les identifiants se lisent par `scaleway-cli <produit> ... list` dans la région ou la zone ci-dessus, et les adresses
privées par `scaleway-cli ipam ip list private-network-id=<mm-prive> region=nl-ams`.

### Les gestes uniques de Julien (aucun secret ne passe par Claude ni par GitHub)

1. ✅ Une application IAM `github-deploy` : `ContainerRegistryFullAccess` et `ContainersFullAccess` sur le projet,
   plus `VPCGatewayFullAccess` (ouvrir et refermer le bastion à l'adresse du runner, 2026-10-26 ; aucun droit plus
   fin n'existe), RIEN sur Secret Manager ni sur IAM. La même clé sert au workflow du connecteur HubSpot. Sa clé secrète est le secret `SCW_SECRET_KEY` de l'environnement GitHub
   `scaleway` : `gh secret set SCW_SECRET_KEY --env scaleway --body (Get-Clipboard)`.
2. ✅ Une paire de clés SSH dédiée au déploiement (`github-deploy-scaleway`) : la PUBLIQUE dans les clés SSH du projet
   AVANT la création de la machine (Scaleway ne les injecte qu'au premier démarrage), la PRIVÉE en secret
   `DEPLOY_SSH_KEY` de `scaleway`, puis effacée du poste. ⚠️ Le bastion ne connaît une clé ajoutée au projet qu'après
   `scaleway-cli vpc-gw gateway refresh-ssh-keys <passerelle> zone=nl-ams-2`.
3. ✅ L'environnement GitHub `scaleway` (jamais `production`, piège plus bas), avec Julien en relecteur obligatoire,
   limité à la branche `main`, et ses variables `SCALEWAY_BASTION` (`<ip de la passerelle>:61000`),
   `SCALEWAY_WORKERS_IP` (l'adresse PRIVÉE de la machine), `SCALEWAY_KNOWN_HOSTS`, une fois le conteneur créé,
   `SCALEWAY_CONTAINER_ID`, et `SCALEWAY_GATEWAY_ID` (l'identifiant de la passerelle : c'est elle qui fait gérer la
   liste du bastion par le workflow, voir plus bas). `SCALEWAY_KNOWN_HOSTS` porte une ligne par hôte, au format de `known_hosts` :
   `[<ip de la passerelle>]:61000 ssh-ed25519 …` pour le bastion, `<ip privée> ssh-ed25519 …` pour la machine,
   relevées à la première connexion depuis le poste et comparées aux empreintes annoncées.
4. Sur la machine : une clé de LECTURE du registre (application IAM `workers-registre`, `ContainerRegistryReadOnly`
   sur le projet), posée par `docker login rg.nl-ams.scw.cloud -u nologin` (la clé du workflow ne quitte jamais
   GitHub) ; puis `/opt/messagingme/.env.prod` (propriétaire root, droits 600), ses valeurs SANS guillemets : la
   migration le lit par `docker run --env-file`, qui les garde, quand compose les retire. Le workflow refuse le
   fichier sinon.
5. Les variables secrètes du conteneur de l'API.

🔴 **Le script des secrets ne pose JAMAIS `DB_POOL_MAX`, `DB_POOL_RECEPTION_MAX`, `API_COPIE` ni
`API_PLAFOND_GLOBAL_PAR_10S`**, ni en clair ni en secret : ils viennent de `ops/scaleway/conteneur-api.json`, que le
workflow applique à chaque déploiement, et le jour J se termine donc par un lancement du workflow. La même clé posée
des deux côtés n'a pas de comportement documenté. ⚠️ La fusion est ADDITIVE : retirer une clé du fichier ne la retire
pas du conteneur, il faut l'y effacer à la main.

⚠️ **Les gestes 4 et 5 portent la configuration de PRODUCTION depuis le 2026-10-26**, posée par le script de Julien
(`docs/prive/bascule/poser-production.cjs`, hors dépôt), qui la construit depuis le `.env.prod` du VPS : la base neuve
et son certificat, sans pooler (`APP_DATABASE_URL` retirée), `PORT` hors du conteneur (Scaleway le réserve), et
`mba-application` jointe depuis le conteneur par l'adresse privée de la machine (`http://172.16.0.4:8090`). Trois
variables en clair dans le conteneur (`NODE_ENV`, `DRY_RUN`, `DB_SSL_CA_FILE`), toutes les autres en secret ; l'API v1
prend les secrets en OBJET (nom vers valeur), la liste de paires était la forme de la v1beta1. La configuration d'essai
du 2026-10-14 reste sur la machine en `.env.prod.essai`. Le conteneur et la machine partagent `ENCRYPTION_KEY` et
`AUTH_SECRET` : une différence entre eux casse le déchiffrement ou les sessions.
6. Une application IAM `cloudflare-origine`, avec `ContainersPrivateAccess` pour seul droit : sa clé secrète va dans
   la règle Cloudflare qui écrase `X-Auth-Token` (`docs/ARCHITECTURE-CIBLE.md` §7.3).
7. Une application IAM `mm-medias` SANS AUCUN droit IAM : c'est la politique du bucket `mm-medias-prod`, posée par
   Claude avec l'IDENTIFIANT de l'application (jamais sa clé), qui l'autorise à lire, écrire et effacer ce seul bucket.
   Sa clé et les quatre autres variables `OBJETS_*` (`https://s3.nl-ams.scw.cloud`, `nl-ams`, `mm-medias-prod`)
   partent ENSEMBLE dans les secrets du conteneur et dans le `.env.prod` de la machine : le démarrage refuse un réglage
   partiel. La suite : « Les médias au bucket », plus bas.

⚠️ **Chaque clé d'API Scaleway a une date d'expiration** (`github-deploy`, `workers-registre`, `cloudflare-origine`),
lisible dans IAM, onglet API keys : la renouveler AVANT, sinon le déploiement, la mise à jour des workers ou l'accès de
Cloudflare s'arrêtent ce jour-là.

### Déployer, et revenir en arrière

`gh workflow run deploy-scaleway.yml --ref main -f migration=aucune`, puis l'approbation dans GitHub. La migration se
choisit à chaque fois (`aucune`, `avant`, `apres`), selon la règle « l'ancien code survit-il ? » de `CLAUDE.md` : le
menu s'ouvre sur `choisir`, que le workflow refuse avant toute construction (décision de Julien du 2026-10-14). Un
retour arrière : le même workflow avec `-f commit=<sha plus ancien>`, après la vérification contre ce que les
migrations appliquées depuis ont resserré. Le workflow refuse un commit hors de l'histoire de `main`, une
configuration incomplète et un `.env.prod` absent ou à guillemets ; l'ordre est la migration « avant », les workers,
l'API, la migration « après ». L'API ne change d'image que si chaque worker a annoncé son démarrage puis n'a pas
redémarré pendant 30 secondes. Elle reçoit dans le MÊME appel sa taille déclarée (`ops/scaleway/conteneur-api.json` :
copies, processeur, mémoire, sonde HTTP sur `/live`, pools, nom des copies, plafond global), ses variables COMPLÉTANT
celles du script, et le workflow la RELIT une fois prête : un écart avec le fichier le fait échouer.
`tests/deploy-scaleway.test.ts` le tient, budget de connexions compris. ⚠️ Un retour arrière réapplique le fichier DE
CE COMMIT ; un commit antérieur au 2026-10-15 n'a pas ce fichier, et la construction échoue franchement sur sa copie,
avant de toucher à quoi que ce soit.

⚠️ **Épingler le commit, et regarder ce qui attend déjà** (2026-10-26). Sans `-f commit=<sha complet>`, le workflow
prend la tête de `main` au moment où il part : le lot d'une autre session poussé entre-temps part avec lui, sous un
accord qui n'était pas le sien. Et un déploiement en attente d'approbation TIENT le groupe de concurrence
`deploiement-scaleway` (`cancel-in-progress: false`) : le suivant reste `pending` derrière lui, sans rien signaler,
tant que Julien ne l'a pas approuvé ou rejeté. Avant d'en lancer un, `gh run list --workflow deploy-scaleway.yml` : un
run `waiting` se règle d'abord, et Julien reçoit les deux liens.

**Après un déploiement, les gestes qui restent à la main** (les mêmes qu'au temps du VPS) :
- le contrôle de fumée public, `node scripts/fumee.mjs`, depuis le poste ;
- `npm run oauth:fiches`, depuis le poste ;
- si un fichier de `docs/aide/fiches/` a bougé, `aide:charger` sur la machine, avec l'image déployée, étiquetée au
  SHA COMPLET du commit :
  `ssh -J bastion@<ip de la passerelle>:61000 root@<ip privée> "docker run --rm --env-file /opt/messagingme/.env.prod rg.nl-ams.scw.cloud/messagingme/mba:<sha complet> npm run aide:charger"`.
  Sa relecture en lecture seule passe par un script envoyé sur la machine et monté dans le conteneur
  (`-v /root/<script>:/app/<script>:ro`, puis `npx tsx <script>`) : l'utilisateur du conteneur n'est pas root, et un
  fichier écrit sous `umask 077` lui rend `EACCES` (`chmod 644`, il ne porte aucun secret) ; il s'efface après.

### Les médias au bucket (lot A des médias)

L'ordre, et ce que chaque pas laisse si on s'arrête là :
1. Déployer le code avec `migration=avant` (0256 : `bytes` nullable, `cle_objet`, le CHECK « l'un ou l'autre »). Sans
   les variables `OBJETS_*`, il fait exactement comme avant : tout reste en base.
2. Poser les cinq variables (geste 7), puis recréer les workers. Dès lors, tout fichier NEUF va au bucket, et la
   lecture sait faire les deux.
3. Sonder le bucket depuis la machine, avec la vraie clé : déposer, lire, effacer sous `essais/`, et le refus de tout
   autre bucket.
4. Recopier l'existant, sur la machine : `docker run --rm --env-file /opt/messagingme/.env.prod <image> npx tsx
   scripts/medias-vers-objets.mts --espaces=<un espace de test>`, puis sans `--espaces`. Rejouable ; la sortie dit
   « encore en base 0 », sinon on relance et on lit ses échecs.
5. Rejouer l'épreuve de la médiathèque froide (`docs/ARCHITECTURE-CIBLE.md` § 11) : aucune attente du pool de l'API.
6. Plus tard, dans un déploiement à part : la migration A2 retire `bytes`, et les variables deviennent obligatoires.

⚠️ Retirer les variables `OBJETS_*` après la recopie ne ramène PAS les fichiers en base : ceux du bucket ne se lisent
plus (erreur à chaque lecture, jamais un 404 muet). Le retour arrière du lot, c'est une image d'avant 0256 TANT QUE la
recopie n'a pas tourné ; après elle, on avance.

### Le connecteur HubSpot chez Scaleway (lot 5, 2026-10-15)

| Ressource | Nom | Note |
|---|---|---|
| Base | `mm-hubspot-db` (PostgreSQL 17, DB-DEV-S) | adresse privée seule (172.16.0.7), disque chiffré, sauvegardes en région ; mot de passe de `mmhs_admin` dans Secret Manager `mm-hubspot-db-admin` ; certificat dans `certs/` du dépôt du connecteur |
| Conteneur de l'API | `mm-hubspot-api` | privé, 1 Go et 560 mvCPU, toujours une copie (min 1, max 1), port 8096 ; domaine `mm-hubspot.messagingme.app` |
| Worker | `mm-hubspot-worker` sur `mm-workers` | `/opt/mm-hubspot` : le compose du dépôt du connecteur, `.env.prod` (root, 600) |
| Cloudflare | `mm-hubspot` en CNAME vers le conteneur, nuage orange | règle « Jeton d'origine mm-hubspot » : `X-Auth-Token` = clé `cloudflare-origine`, posée en Set static (elle écrase celle d'un client) |

- **Déployer** : `gh workflow run deploy-scaleway.yml -R julienmessagingme/mm-hubspot --ref main -f migration=aucune`,
  après l'accord de Julien. Pas de bouton d'approbation : GitHub la réserve aux offres payantes sur un dépôt privé.
- **Ses secrets** (base, `INGEST_SECRET`, `SERVICE_SECRET`, OAuth HubSpot, `ENCRYPTION_KEY`) ont été posés par un
  script lancé par Julien, qui les lit sur le VPS et au coffre sans les afficher. Messaging Me l'appelle par son nom
  public : `HUBSPOT_SERVICE_URL=https://mm-hubspot.messagingme.app`, `CONNECTOR_PUSH_URL=.../ingest` ; il rappelle
  Messaging Me par `MBA_BASE_URL=https://api.messagingme.app`.
- **Retour arrière, tant que le VPS le garde** : l'enregistrement `mm-hubspot` repasse en A vers l'adresse du VPS
  (nuage orange), `sudo docker compose start` dans `/home/ubuntu/mm-hubspot`, et les deux adresses de Messaging Me
  reprennent leur valeur interne (copie `.env.prod.avant-lot5-20261015`) avant un `--force-recreate`. Les données
  écrites chez Scaleway entre-temps seraient perdues : les recopier d'abord.
- **Les pièges du jour** : le domaine d'un conteneur se déclare APRÈS que le nom pointe vers lui ET que le
  conteneur est prêt (déclaré avant, il passe en erreur, et il faut le supprimer puis le recréer) ; depuis Git Bash,
  une valeur `/app/...` passée à `scaleway-cli` arrive en `C:/Program Files/Git/app/...` (`MSYS_NO_PATHCONV=1`) ; un
  workflow d'un dépôt PRIVÉ ne peut pas `git fetch` après un checkout sans identifiants ; `container update` rend
  les variables secrètes sous forme d'objet, et refuse toute modification tant que le conteneur redémarre.

### Les pièges relevés le 2026-10-14

- 🔴 **L'environnement GitHub du déploiement s'appelle `scaleway`, JAMAIS `production`.** GitHub ne distingue pas
  la casse des noms d'environnement, et `Production` existe déjà dans ce dépôt : Vercel l'a créé le 2026-09-03, sans
  aucune règle de protection (l'API le rend quand on lui demande `production`, mesuré le 2026-10-14). Un job qui
  s'y réfère part sans l'approbation de Julien, et un `--env production` y rangerait les secrets, sans erreur.
- 🔴 **Les journaux des workers ne s'impriment jamais dans le workflow** : ils portent des données de clients, et le
  journal d'un dépôt public est lisible par tous. Ils se lisent sur la machine, par le bastion (`docker logs
  mba-worker`).
- **La CLI de Scaleway rend le code 0 même en ERREUR avec `-o json`** (rupture de stock, quota) : tester le
  contenu de la réponse (`"error"`, absence d'`"id"`), jamais le seul code de sortie. Et une suppression RÉUSSIE
  répond `"message": "... successfully deleted"` : un contrôle sur `"message"` seul la prend pour une erreur (vécu).
  `instance private-nic create` range l'identifiant sous `private_nic.id`, pas à la racine.
- **L'API des conteneurs est en `v1`** : la `v1beta1` n'a pas de `/redeploy` (mesuré sans clé le 2026-10-14 : 404 en
  `v1beta1`, 401 en `v1`). Le workflow ne s'en sert plus : un PATCH redéploie même à valeurs identiques (mesuré le
  2026-10-15), donc l'image et la taille partent en un seul PATCH. Un objet `liveness_probe` envoyé REMPLACE l'ancien
  (la sonde TCP par défaut est devenue HTTP, mesuré le même jour sur le conteneur d'essai).
- **Un compte neuf avait ses quotas d'Instances à 0 dans les trois zones de Paris**, ouverts ailleurs, et le support
  a répondu rupture de stock à Paris : c'est ce qui a envoyé la cible à Amsterdam. L'onglet Quotas de l'Organization
  Dashboard les montre (décocher « Show used quotas only », sinon la liste est vide).
- 🔴 **LE BASTION N'EST OUVERT QU'AUX ADRESSES DE SA LISTE** (décision de Julien du 2026-10-26) : le poste de Julien
  en permanence, et l'exécuteur GitHub le temps d'un déploiement. En place depuis le 2026-10-26 au soir, prouvé par un
  déploiement du connecteur liste fermée. Les deux workflows (celui-ci et celui du connecteur) ajoutent l'adresse de
  leur exécuteur avant le premier SSH et la retirent à la fin, même sur un échec ou une annulation (étapes « Ouvrir le
  bastion » et « Refermer le bastion »), sans jamais remplacer la liste : un PUT effacerait l'adresse permanente.
  `SCALEWAY_GATEWAY_ID` est exigée. Les clés SSH du projet restent exigées en plus. Mesuré : une adresse hors liste
  n'obtient même pas de connexion (le délai expire, les paquets sont jetés) ; un ajout ou un retrait passe la
  passerelle en `configuring` environ 5 secondes ; l'adresse est stockée telle qu'envoyée (`x.x.x.x/32`), et le
  retrait prend la barre encodée (`%2F`). Trois gestes, dans la console Scaleway (Network, Public Gateways, zone
  AMS 2, `mm-passerelle`, section SSH bastion, « Allowed IPs ») ou par l'API
  (`/vpc-gw/v2/zones/nl-ams-2/gateways/<id>/bastion-allowed-ips`) :
  - **l'adresse du poste a changé** (le bastion refuse depuis chez Julien) : y ajouter la nouvelle, retirer l'ancienne.
    La production n'en souffre pas, et les déploiements GitHub continuent ;
  - **« Refermer le bastion » a échoué** (l'erreur du journal nomme l'adresse) : retirer cette adresse à la main ;
  - **retour arrière** : remettre `0.0.0.0/0` dans la liste.
- `vpc-gw` n'a pas de sous-commande `wait` (relire par `get`), et `rdb instance get` répond « transient state »
  tant que la base se crée.
- **Le certificat de la base se met dans l'image**, comme celui de Supabase (`certs/`, `DB_SSL_CA_FILE`) : c'est un
  certificat public, PROPRE À CHAQUE BASE (auto-signé, valable dix ans), lu par `scaleway-cli rdb instance
  get-certificate`. Celui de la base jetable (`certs/scaleway-mm-banc.crt`) couvre son adresse PRIVÉE, vérifié le
  2026-10-14 ; il cite aussi une adresse publique sur laquelle rien ne répond (la base n'a aucune entrée publique).
  Celui de la production (`certs/scaleway-mm-prod.crt`, 172.16.0.8) y est depuis le 2026-10-15, ouvert par
  `tests/deploy-scaleway.test.ts`. Jamais `DB_SSL_INSECURE`.
- **Le conteneur de l'API ne se crée que sur une image qui EXISTE** : le registre étant vide avant le premier
  déploiement, `mba-api` a été créé le 2026-10-14 sur une image publique provisoire (`nginx:alpine`), que le premier
  lancement du workflow remplace ; le workflow ignore l'erreur de l'image qu'il remplace. `PORT` est réservé (Scaleway
  le pose, égal au port déclaré), la mémoire s'écrit en Go (`memory-limit-bytes=2GB`), et une sonde de santé
  déclarée exige tous ses réglages (seuil, intervalle, délai) : sans eux, la sonde par défaut, en TCP sur le port.
