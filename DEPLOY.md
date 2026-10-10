# Déploiement : l'API et les workers sur le VPS (OVH + NPM)

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
qu'aucune erreur ne le signale. À faire après le déploiement, dès qu'un `.md` de ce dossier a bougé :

```bash
sudo docker compose run --rm --no-deps mba-api npm run aide:charger
```

⚠️ **Idempotent par le nom du fichier** : relancer met à jour, ça ne duplique pas, donc le lancer « au cas
où » ne coûte rien. Il RETIRE aussi les lignes dont le fichier a disparu, sinon le bot répondrait avec une
page effacée du produit. Il ne vectorise rien : la fiche est trouvable par les MOTS tout de suite, par le
SENS au passage suivant du balayage.

⚠️ **Le déclencheur n'est pas seulement « j'ai écrit une fiche ».** Modifier une section de `features.md`
PÉRIME l'empreinte des fiches qui la citent, et `tests/aide-proposer.test.ts` rend la CI rouge tant qu'elles
n'ont pas été relues. Une fiche relue est une fiche à recharger.

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

```bash
node scripts/fumee.mjs
```

Depuis le poste, PAS depuis le VPS : ce qu'on veut savoir, c'est ce que voit un client, à travers Cloudflare
et NPM. Il vérifie les six chemins qui portent vraiment quelque chose, dont **le webhook Meta à l'adresse que
Meta appelle réellement** (`mba.messagingme.app/api/backend/webhooks/meta`, pas `api.`).

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
1. Ajouter le service au compose, avec son `DB_POOL_MAX` (et son `PGBOSS_MAX` si c'est un worker).
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

⚠️ **Runbook écrit, DRILL À FAIRE (accès dashboard Supabase requis).** L'app est stateless hors base : tout
l'état vit dans le projet Supabase `npdqnrirxhqsyyvtvtjz`. La reprise = restaurer la base + repointer l'app.

### Ce qu'il faut sauvegarder (deux choses distinctes)
1. **La base** (Supabase) : porte les 4 schémas d'UN SEUL projet : `public` (tables mba + schema_migrations),
   `pgboss` (files), `mmhs` (connecteur mm-hubspot, lu en cross-schéma par mba) et, depuis la migration 0183,
   `salesforce` (l'app Salesforce, lu et écrit par son seul store, sans clé étrangère vers `public`). Un restore
   physique/PITR restaure **les 4 ENSEMBLE** à l'instant T (on ne PITR pas un schéma seul).
2. **Les secrets, HORS base et HORS git** : `.env.prod` sur le VPS (`AUTH_SECRET`, `META_ACCESS_TOKEN`,
   `ENCRYPTION_KEY`…) + celui de mm-hubspot. 🔴 **Sans `ENCRYPTION_KEY`, `waba_credentials` (tokens/PIN business ES,
   AES-256-GCM) est INDÉCHIFFRABLE même après un restore parfait de la base**, et `salesforce.orgs.secret_entrant_chiffre`
   aussi : chaque org Salesforce reliée devrait alors être reconnectée. Sauvegarder cette clé SÉPARÉMENT de
   la base (un backup DB seul ne suffit pas). `AUTH_SECRET` perdu = toutes les sessions JWT invalidées (re-login).

### RPO (perte max) — dépend du plan Supabase, À RELEVER au dashboard (Database > Backups)
- **PITR** activé -> RPO ~2 min. **Daily** (Pro, rétention ~7 j) -> RPO ~24 h. **Free** sans backup planifié ->
  RPO = PERTE TOTALE (seul un `pg_dump` manuel sauve). ⚠️ **Étape 1 du drill = ouvrir le dashboard et relever le
  plan réel** (l'org est invisible au MCP Supabase, non déterminable d'ici).

### Deux chemins de restauration
- **(a) Sinistre total** : restore Supabase natif, vers un **NOUVEAU projet** (JAMAIS in-place sur la prod : le
  restore Supabase est destructif). Ramène les 4 schémas à l'instant T.
- **(b) Dégât localisé** (une table écrasée) : `pg_dump`/`pg_restore` d'un schéma via le **pooler session mode**
  `aws-1-eu-west-2.pooler.supabase.com:5432` (le host direct `db.<ref>.supabase.co` est IPv6-only, injoignable).
  Non fourni par le plan : dump à lancer soi-même, read-only, hors pic (consomme une session du budget « Pool Size »).

### Remise en service de l'app (RTO)
Restore vers un nouveau projet -> l'host du pooler change. Dans `.env.prod` (mba **ET** mm-hubspot) : mettre à jour
`DATABASE_URL` (5432), `APP_DATABASE_URL` (6543), et vérifier `DB_SSL_CA_FILE` (même CA Supabase, même chaîne
`*.pooler.supabase.com` -> bundle inchangé). Puis `docker compose up -d --force-recreate` (env_file rechargé à la
recréation seulement). Le schéma `pgboss` revient avec la base ; s'il manquait, le WORKER le recréerait au boot
(l'API l'attend, elle ne le crée pas) ; NPM route déjà ; l'app est redéployable en minutes depuis
git. ⚠️ **Migrations FORWARD-ONLY** (`db/migrate.ts`, aucun `*.down.sql`) : une migration destructrice (ex. un DROP)
ne se défait PAS par le code -> seule issue = restore de données OU migration compensatoire écrite à la main.

### Drill (à faire UNE fois, non destructif — cible JETABLE, jamais la prod)
1. Relever le plan de backup au dashboard (fixe le RPO théorique).
2. Restaurer le dernier backup vers un **projet neuf** ; **chronométrer** le temps total = **RTO réel**.
3. Comparer l'horodatage de la donnée la plus récente restaurée à l'instant du sinistre simulé = **RPO réel**.
4. Sur la cible : `schema_migrations` contient la dernière migration (**0044**) ; comptes tenants/contacts/campaigns
   cohérents ; `mmhs.portals` présent ; booter un `mba-api` de TEST pointé dessus (`DATABASE_URL` isolé, **jamais la
   prod**) -> il démarre si le schéma `pgboss` restauré est à la version de son pg-boss. ⚠️ Il ne le crée ni ne le
   migre plus (2026-09-28) : s'il refuse de démarrer, c'est le schéma qui manque ou diffère, et seul un worker le
   répare, à ne démarrer sur une copie qu'en `DRY_RUN=true` (sinon il reprend les campagnes et ENVOIE).
5. Drill de la clé : redéchiffrer une ligne `waba_credentials` avec l'`ENCRYPTION_KEY` sauvegardée à part (sans elle,
   échec attendu -> prouve le gotcha).
6. Consigner ici les chiffres RÉELS (RPO/RTO mesurés) + `dernière vérif DR : <date>` (re-tester périodiquement).

**Dernière vérif DR : jamais (drill à réaliser).**
