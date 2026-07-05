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

```bash
cd /home/ubuntu/mba && git pull && docker compose up -d --build
```
