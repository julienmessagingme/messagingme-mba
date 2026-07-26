# Déploiement — mba.messagingme.app (VPS OVH + NPM)

Trois conteneurs sur le réseau `mcp-robot_default` : `mba-api` (Fastify :8095), `mba-worker`
(pg-boss), `mba-web` (Next.js :3000). NPM expose `mba.messagingme.app` -> `mba-web:3000` ;
le front proxifie `/api/backend/*` -> `mba-api:8095` (interne, pas de CORS, backend non public).

## 0. Déjà fait (pré-staging sur le VPS)

- Repo cloné dans `/home/ubuntu/mba`, les 3 images Docker **buildées et validées** sur le VPS.
- `/home/ubuntu/mba/.env.prod` **créé et rempli** : `AUTH_SECRET` généré (openssl), `DATABASE_URL`
  = pooler Supabase **session mode** `aws-1-eu-west-2` (IPv4, joignable des conteneurs ;
  le host direct `db.<ref>.supabase.co` est IPv6-only et injoignable), `DRY_RUN=true`.
- Migrations déjà appliquées (base partagée). pg-boss créera son schéma au 1er démarrage.

## 1. La SEULE entrée humaine restante : DNS

Créer dans Cloudflare `mba.messagingme.app` -> A `146.59.233.252`, **Proxied** (orange).

## 2. Démarrer (une commande)

```bash
ssh -i ~/.ssh/id_ed25519 ubuntu@146.59.233.252
cd /home/ubuntu/mba
git pull            # si nouveau code
sudo docker compose up -d --build
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

Via l'UI http://146.59.233.252:81 ou l'API (cf CLAUDE.md) :
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
sudo docker compose build mba-api                                # 1) OBLIGATOIRE avant de migrer, cf. ci-dessous
sudo docker compose run --rm --no-deps mba-api npm run migrate   # 2) applique les migrations (idempotent)
sudo docker compose up -d --build                                # 3) bascule les services
```

⚠️ **`mba-api` et `mba-worker` sont DEUX images distinctes** (même Dockerfile, `image:` implicite `mba-mba-api` / `mba-mba-worker`). `docker compose build mba-api` ne rebuild PAS le worker : un `up --force-recreate` ensuite relance le worker sur son ANCIENNE image (constaté 4.11 : nouvel env `DB_SSL_CA_FILE` + ancienne image sans la CA -> ENOENT crash-loop worker pendant que l'api tournait). Pour un changement de code/fichier baké : `docker compose up -d --build` (rebuild les DEUX), ou builder explicitement `mba-api` ET `mba-worker`.

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

⚠️ **Exception — migration qui DROP (ou renomme) une colonne encore lue par l'ANCIEN code** (ex. `0030_drop_workflow_status.sql`) : **ordre INVERSÉ**, deploy le code D'ABORD, migrate ENSUITE. Sinon la colonne disparaît pendant que l'ancien conteneur (qui la lit encore) tourne toujours -> 500 « column … does not exist » le temps du rebuild. Règle générale : une migration qui AJOUTE une colonne se fait avant le deploy (le code neuf en a besoin) ; une migration qui RETIRE une colonne se fait après (le code neuf a cessé de la lire, l'ancien en a encore besoin).

```bash
cd /home/ubuntu/mba && git pull
sudo docker compose up -d --build                                # 1) deploy le code qui ne lit plus la colonne
sudo docker compose run --rm --no-deps mba-api npm run migrate   # 2) PUIS drop la colonne
```

## ⚠️ Crash-loop transitoire au redéploiement (EMAXCONNSESSION) — normal, s'auto-résout

Juste après `up -d --build`, `mba-api` peut apparaître `Restarting (1)` pendant ~30-60 s. Deux symptômes
possibles, tous deux transitoires : soit le process redémarre (`/health` et `/live` injoignables -> NPM
renvoie une 5xx), soit le process est up mais la DB pas encore joignable (`/health` = **503 readiness**,
tandis que `/live` répond déjà 200). Cause : le pooler Supabase (session mode) est plafonné à **15 sessions** ;
quand `mba-api` et `mba-worker` (deux instances pg-boss) cold-start EN MÊME TEMPS pendant que le pooler tient
encore les sessions des conteneurs qu'on vient de tuer, le total dépasse 15 -> `EMAXCONNSESSION`. pg-boss émet
un event `error` non capté (Timekeeper.onCron) qui tue le process -> Docker le relance -> crash-loop bref.
(Depuis 4.3, le pool applicatif est en mode transaction sur `APP_DATABASE_URL:6543`, hors du budget session ->
la contention au cold-start est réduite mais pas nulle, pg-boss restant en session.)
**Ça se résout seul** dès que le pooler libère les sessions des conteneurs tués (quelques dizaines de
secondes). Attendre puis revérifier : `sudo docker ps --filter name=mba-api` doit finir sur `Up` stable
et `/health` sur 200 (readiness OK). Ne PAS restart en boucle manuellement (ça relance le cold-start et
prolonge la contention). Ce n'est pas lié au code déployé.

## Restauration / reprise après sinistre (DR) — item 4.13

⚠️ **Runbook écrit, DRILL À FAIRE (accès dashboard Supabase requis).** L'app est stateless hors base : tout
l'état vit dans le projet Supabase `npdqnrirxhqsyyvtvtjz`. La reprise = restaurer la base + repointer l'app.

### Ce qu'il faut sauvegarder (deux choses distinctes)
1. **La base** (Supabase) : porte les 3 schémas d'UN SEUL projet — `public` (tables mba + schema_migrations),
   `pgboss` (files), `mmhs` (connecteur mm-hubspot, lu en cross-schéma par mba). Un restore physique/PITR restaure
   **les 3 ENSEMBLE** à l'instant T (on ne PITR pas un schéma seul).
2. **Les secrets, HORS base et HORS git** : `.env.prod` sur le VPS (`AUTH_SECRET`, `META_ACCESS_TOKEN`,
   `ENCRYPTION_KEY`…) + celui de mm-hubspot. 🔴 **Sans `ENCRYPTION_KEY`, `waba_credentials` (tokens/PIN business ES,
   AES-256-GCM) est INDÉCHIFFRABLE même après un restore parfait de la base.** Sauvegarder cette clé SÉPARÉMENT de
   la base (un backup DB seul ne suffit pas). `AUTH_SECRET` perdu = toutes les sessions JWT invalidées (re-login).

### RPO (perte max) — dépend du plan Supabase, À RELEVER au dashboard (Database > Backups)
- **PITR** activé -> RPO ~2 min. **Daily** (Pro, rétention ~7 j) -> RPO ~24 h. **Free** sans backup planifié ->
  RPO = PERTE TOTALE (seul un `pg_dump` manuel sauve). ⚠️ **Étape 1 du drill = ouvrir le dashboard et relever le
  plan réel** (l'org est invisible au MCP Supabase, non déterminable d'ici).

### Deux chemins de restauration
- **(a) Sinistre total** : restore Supabase natif, vers un **NOUVEAU projet** (JAMAIS in-place sur la prod : le
  restore Supabase est destructif). Ramène les 3 schémas à l'instant T.
- **(b) Dégât localisé** (une table écrasée) : `pg_dump`/`pg_restore` d'un schéma via le **pooler session mode**
  `aws-1-eu-west-2.pooler.supabase.com:5432` (le host direct `db.<ref>.supabase.co` est IPv6-only, injoignable).
  Non fourni par le plan : dump à lancer soi-même, read-only, hors pic (consomme une session du budget 15).

### Remise en service de l'app (RTO)
Restore vers un nouveau projet -> l'host du pooler change. Dans `.env.prod` (mba **ET** mm-hubspot) : mettre à jour
`DATABASE_URL` (5432), `APP_DATABASE_URL` (6543), et vérifier `DB_SSL_CA_FILE` (même CA Supabase, même chaîne
`*.pooler.supabase.com` -> bundle inchangé). Puis `docker compose up -d --force-recreate` (env_file rechargé à la
recréation seulement). pg-boss recrée son schéma au boot ; NPM route déjà ; l'app est redéployable en minutes depuis
git. ⚠️ **Migrations FORWARD-ONLY** (`db/migrate.ts`, aucun `*.down.sql`) : une migration destructrice (ex. un DROP)
ne se défait PAS par le code -> seule issue = restore de données OU migration compensatoire écrite à la main.

### Drill (à faire UNE fois, non destructif — cible JETABLE, jamais la prod)
1. Relever le plan de backup au dashboard (fixe le RPO théorique).
2. Restaurer le dernier backup vers un **projet neuf** ; **chronométrer** le temps total = **RTO réel**.
3. Comparer l'horodatage de la donnée la plus récente restaurée à l'instant du sinistre simulé = **RPO réel**.
4. Sur la cible : `schema_migrations` contient la dernière migration (**0044**) ; comptes tenants/contacts/campaigns
   cohérents ; `mmhs.portals` présent ; booter un `mba-api` de TEST pointé dessus (`DATABASE_URL` isolé, **jamais la
   prod** : sinon EMAXCONNSESSION sur les vrais conteneurs) -> pg-boss recrée `pgboss`.
5. Drill de la clé : redéchiffrer une ligne `waba_credentials` avec l'`ENCRYPTION_KEY` sauvegardée à part (sans elle,
   échec attendu -> prouve le gotcha).
6. Consigner ici les chiffres RÉELS (RPO/RTO mesurés) + `dernière vérif DR : <date>` (re-tester périodiquement).

**Dernière vérif DR : jamais (drill à réaliser).**
