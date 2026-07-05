# wip.md — travail en cours

## État (2026-07-05) : V1 construite et déployée en DRY_RUN

Tout le backend + l'UI + le déploiement sont faits. `mba.messagingme.app` tourne en
**DRY_RUN** (le worker marque `sent` sans appeler Meta). Il ne manque que le vrai numéro pour
l'envoi live.

**Backend (feature-loop, chaque brique reviewée par un agent séparé) :**
- Loop 1 — webhook receiver async (signature timing-safe, ACK bouclier, file pg-boss durable,
  dédup idempotente, DLQ, BSUID-native).
- Loop 2 — wrapper Meta typé (`MetaClient`, retries/backoff, rate limiter, transport injectable).
- Loop 3 — mini-CRM + import CSV (user fields, reconnaissance colonnes, E.164, variables template).
- Loop 4 — moteur de campagne + garde-fous (opt-in, fréquence marketing-only, quality gate,
  **claim atomique** anti double-envoi, idempotent, report).
- Loop 5 — adaptateurs Postgres + services + routes HTTP + run bout-en-bout (prouvé E2E Supabase).

**Depuis (revues + corrections) :**
- Revue multi-agent Loops 3-5 (23 constats corrigés) + revue sécurité auth (12 constats).
- **Auth** : login JWT (scrypt async, rate-limit, hash leurre anti-énumération), isolation
  tenant sur toutes les routes, **RBAC** (écritures admin-only), `AUTH_SECRET` fail-fast en prod.
- **Suivi de livraison** : webhooks statut Meta -> `delivery_status` par message_id (monotone).
- **Robustesse** : création de campagne transactionnelle + sweeper des `sending` bloqués.
- **UI Next.js** (`web/`) : login, contacts + import CSV, campagnes (création + lancement +
  détail des statuts, auto-refresh).
- **Déploiement** : `mba.messagingme.app` (Docker VPS, NPM + Let's Encrypt). Cf `DEPLOY.md`.

Tests : ~148 unitaires + 10 intégration verts.

## Prochaine étape : passage au LIVE (dépend du vrai numéro)

1. Provisionner le numéro Meta dans `phone_numbers` (+ `waba`, bon `tenant_id`).
2. `.env.prod` sur le VPS : `DRY_RUN=false` + `META_ACCESS_TOKEN`.
3. `docker compose up -d`, vérifier que les templates sont approuvés côté Meta.
4. Petite campagne test -> statuts `sent` puis `delivered`/`read` via vrais webhooks Meta.

## En attente (dépendances externes)

- **Numéro Meta réel** : attendu (Julien le branche). Bloque le seul envoi live.
- **MBA** : bloqué par les ToS (403 « Meta Business AI Terms »), gating vertical. Parqué.
- **Pilote OTP Zadarma** : gaté sur le KYC Zadarma.

## Reste (non bloquant) — voir `todo.md`

- TLS pooler en vérif complète (pinner la CA Supabase).
- Unicité email globale (décision produit).
- Pagination contacts UI, quality rating alimenté par webhook, tests DLQ/CI intégration.
