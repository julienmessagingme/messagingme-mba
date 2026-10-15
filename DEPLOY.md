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
Meta appelle réellement** : `api.messagingme.app/webhooks/meta` depuis le 2026-10-15. L'ancienne,
`mba.messagingme.app/api/backend/webhooks/meta`, reste sondée jusqu'à la suppression de `mba.` (son libellé dans
le script la dit encore « actuelle » jusque-là).

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

### Chez Scaleway (le connecteur depuis le 2026-10-15, Messaging Me au jour J)

La base managée porte ses propres sauvegardes : des sauvegardes LOGIQUES automatiques, une par jour, gardées 7 jours,
dans la région (`backup_schedule` de l'instance, la première 24 h après sa création), et des sauvegardes manuelles
(`scaleway-cli rdb backup create instance-id=<base> database-name=rdb name=<nom> expires-at=<date> region=nl-ams`).
Les instantanés de bloc (`rdb snapshot create`, puis `rdb snapshot restore` qui crée une instance) existent aussi,
non éprouvés.

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

**Dernière vérif DR chez Scaleway : 2026-10-15, réussie, sur la base du connecteur** (63 Ko). Sauvegarde manuelle
14 s ; instance jetable prête en 250 s ; restauration 28 s ; vérification 3 s : 20 tables et 247 lignes identiques à
la source, **2 jetons HubSpot sur 2** déchiffrés avec la clé du connecteur, **0 sur 2** avec une clé fausse. Le
chemin des données tient en cinq minutes à cette taille ; le redéploiement pour le nouveau certificat s'y ajoute.

## Scaleway (cible de la bascule) : le socle et le bouton de déploiement

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
| Espace de conteneurs | `messagingme` | `nl-ams` | le conteneur de l'API `mba-api` y est créé : privé, rattaché à `mm-prive`, 2 Go et 1 120 mvCPU, de 0 à 1 copie pendant les essais |
| Passerelle | `mm-passerelle` (VPC-GW-S) | `nl-ams-2` | bastion SSH sur le port 61000, NAT et route par défaut vers `mm-prive` |
| Base JETABLE | `mm-banc` (PostgreSQL 17, DB-DEV-M) | `nl-ams` | adresse privée seule, disque chiffré, sauvegardes en région ; mot de passe dans Secret Manager `mm-banc-db-admin` ; à supprimer après les lots 3 et 4 |
| Machine des workers | `mm-workers` (PLAY2-NANO, Ubuntu 24.04) | `nl-ams-2` | sans adresse publique, disque de 20 Go ; Docker et Compose posés au premier démarrage (cloud-init) ; PRO2-XXS avant le jour J |

Les identifiants se lisent par `scaleway-cli <produit> ... list` dans la région ou la zone ci-dessus, et les adresses
privées par `scaleway-cli ipam ip list private-network-id=<mm-prive> region=nl-ams`.

### Les gestes uniques de Julien (aucun secret ne passe par Claude ni par GitHub)

1. ✅ Une application IAM `github-deploy` : `ContainerRegistryFullAccess` et `ContainersFullAccess` sur le projet,
   RIEN sur Secret Manager ni sur IAM. Sa clé secrète est le secret `SCW_SECRET_KEY` de l'environnement GitHub
   `scaleway` : `gh secret set SCW_SECRET_KEY --env scaleway --body (Get-Clipboard)`.
2. ✅ Une paire de clés SSH dédiée au déploiement (`github-deploy-scaleway`) : la PUBLIQUE dans les clés SSH du projet
   AVANT la création de la machine (Scaleway ne les injecte qu'au premier démarrage), la PRIVÉE en secret
   `DEPLOY_SSH_KEY` de `scaleway`, puis effacée du poste. ⚠️ Le bastion ne connaît une clé ajoutée au projet qu'après
   `scaleway-cli vpc-gw gateway refresh-ssh-keys <passerelle> zone=nl-ams-2`.
3. ✅ L'environnement GitHub `scaleway` (jamais `production`, piège plus bas), avec Julien en relecteur obligatoire,
   limité à la branche `main`, et ses variables `SCALEWAY_BASTION` (`<ip de la passerelle>:61000`),
   `SCALEWAY_WORKERS_IP` (l'adresse PRIVÉE de la machine), `SCALEWAY_KNOWN_HOSTS` et, une fois le conteneur créé,
   `SCALEWAY_CONTAINER_ID`. `SCALEWAY_KNOWN_HOSTS` porte une ligne par hôte, au format de `known_hosts` :
   `[<ip de la passerelle>]:61000 ssh-ed25519 …` pour le bastion, `<ip privée> ssh-ed25519 …` pour la machine,
   relevées à la première connexion depuis le poste et comparées aux empreintes annoncées.
4. Sur la machine : une clé de LECTURE du registre (application IAM `workers-registre`, `ContainerRegistryReadOnly`
   sur le projet), posée par `docker login rg.nl-ams.scw.cloud -u nologin` (la clé du workflow ne quitte jamais
   GitHub) ; puis `/opt/messagingme/.env.prod` (propriétaire root, droits 600), ses valeurs SANS guillemets : la
   migration le lit par `docker run --env-file`, qui les garde, quand compose les retire. Le workflow refuse le
   fichier sinon.
5. Les variables secrètes du conteneur de l'API.

⚠️ **Jusqu'au jour J, les gestes 4 et 5 portent une configuration d'ESSAI**, posée par Claude le 2026-10-14 : la base
jetable, des secrets JETABLES (générés pour l'occasion, jamais affichés) et `DRY_RUN=true`, sans aucune valeur de
production. Au jour J, Julien la remplace par celle de production, sur la machine ET dans le conteneur : les deux
partagent `ENCRYPTION_KEY` et `AUTH_SECRET`, et une différence entre eux casse le déchiffrement ou les sessions.
6. Une application IAM `cloudflare-origine`, avec `ContainersPrivateAccess` pour seul droit : sa clé secrète va dans
   la règle Cloudflare qui écrase `X-Auth-Token` (`docs/ARCHITECTURE-CIBLE.md` §7.3).

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
redémarré pendant 30 secondes. `tests/deploy-scaleway.test.ts` le tient.

**Après un déploiement, les gestes qui restent à la main** (ceux de la section du VPS) :
- le contrôle de fumée public, `node scripts/fumee.mjs`, depuis le poste (il vise encore `mba.` : à repointer sur
  `api.` au lot 7) ;
- `npm run oauth:fiches`, depuis le poste ;
- si un fichier de `docs/aide/fiches/` a bougé, `aide:charger` sur la machine, avec l'image déployée :
  `ssh -J bastion@<ip de la passerelle>:61000 root@<ip privée> "docker run --rm --env-file /opt/messagingme/.env.prod rg.nl-ams.scw.cloud/messagingme/mba:<sha> npm run aide:charger"`.

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
- **L'API des conteneurs est en `v1`** (champ `image`, route `/redeploy`) : la `v1beta1` n'a pas de `/redeploy`
  (mesuré sans clé le 2026-10-14 : 404 en `v1beta1`, 401 en `v1`).
- **Un compte neuf avait ses quotas d'Instances à 0 dans les trois zones de Paris**, ouverts ailleurs, et le support
  a répondu rupture de stock à Paris : c'est ce qui a envoyé la cible à Amsterdam. L'onglet Quotas de l'Organization
  Dashboard les montre (décocher « Show used quotas only », sinon la liste est vide).
- **Le bastion reste ouvert à toutes les adresses** (`0.0.0.0/0`) : les exécuteurs de GitHub n'ont pas d'adresses
  fixes. Il n'accepte que des clés SSH, celles du projet.
- `vpc-gw` n'a pas de sous-commande `wait` (relire par `get`), et `rdb instance get` répond « transient state »
  tant que la base se crée.
- **Le certificat de la base se met dans l'image**, comme celui de Supabase (`certs/`, `DB_SSL_CA_FILE`) : c'est un
  certificat public, PROPRE À CHAQUE BASE (auto-signé, valable dix ans), lu par `scaleway-cli rdb instance
  get-certificate`. Celui de la base jetable (`certs/scaleway-mm-banc.crt`) couvre son adresse PRIVÉE, vérifié le
  2026-10-14 ; il cite aussi une adresse publique sur laquelle rien ne répond (la base n'a aucune entrée publique).
  Celui de la production s'ajoute avant le jour J. Jamais `DB_SSL_INSECURE`.
- **Le conteneur de l'API ne se crée que sur une image qui EXISTE** : le registre étant vide avant le premier
  déploiement, `mba-api` a été créé le 2026-10-14 sur une image publique provisoire (`nginx:alpine`), que le premier
  lancement du workflow remplace ; le workflow ignore l'erreur de l'image qu'il remplace. `PORT` est réservé (Scaleway
  le pose, égal au port déclaré), la mémoire s'écrit en Go (`memory-limit-bytes=2GB`), et une sonde de santé
  déclarée exige tous ses réglages (seuil, intervalle, délai) : sans eux, la sonde par défaut, en TCP sur le port.
