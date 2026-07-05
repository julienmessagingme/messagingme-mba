# Déploiement — mba.messagingme.app (VPS OVH + NPM)

Trois conteneurs sur le réseau `mcp-robot_default` : `mba-api` (Fastify :8095), `mba-worker`
(pg-boss), `mba-web` (Next.js :3000). NPM expose `mba.messagingme.app` -> `mba-web:3000` ;
le front proxifie `/api/backend/*` -> `mba-api:8095` (interne, pas de CORS, backend non public).

## 0. Prérequis (2 entrées humaines)

1. **DNS Cloudflare** : créer `mba.messagingme.app` -> A `146.59.233.252`, **Proxied** (orange).
2. **DATABASE_URL pooler** : le host direct `db.<ref>.supabase.co` est IPv6-only, injoignable
   depuis un conteneur Docker. Récupérer dans le dashboard Supabase la chaîne **pooler**
   (Connect -> Session mode, port **5432**) :
   `postgres://postgres.npdqnrirxhqsyyvtvtjz:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres`
   (session mode requis par pg-boss ; PAS le transaction mode 6543).

## 1. Sur le VPS

```bash
ssh -i ~/.ssh/id_ed25519 ubuntu@146.59.233.252
cd /home/ubuntu
git clone https://github.com/julienmessagingme/messagingme-mba.git mba
cd mba
cp .env.prod.example .env.prod
# éditer .env.prod :
#   AUTH_SECRET=$(openssl rand -base64 48)
#   DATABASE_URL=<pooler session mode>
#   DRY_RUN=true   (démo ; false pour le live)
nano .env.prod
```

## 2. Migrations (une fois ; déjà appliquées sur la base actuelle)

```bash
# depuis le repo, avec le .env.prod chargé :
docker compose run --rm -e DATABASE_URL="$(grep ^DATABASE_URL .env.prod | cut -d= -f2-)" mba-api npx tsx db/migrate.ts
# seed d'un compte admin (choisir un vrai mot de passe) :
docker compose run --rm --env-file .env.prod -e SEED_EMAIL=julien@messagingme.fr -e SEED_PASSWORD='<motdepasse>' -e SEED_PHONE_NUMBER_ID=<phone_number_id_reel> mba-api npx tsx db/seed.ts
```

## 3. Build + run

```bash
docker compose up -d --build
docker compose ps          # mba-api, mba-worker, mba-web up
docker compose logs -f mba-api mba-web   # verifier "en écoute" + Next ready
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
