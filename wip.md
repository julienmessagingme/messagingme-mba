# wip.md — travail en cours

## État (2026-07-06) : V1 LIVE — 1er envoi WhatsApp réel fait ✅

`mba.messagingme.app` est en **prod LIVE** (`DRY_RUN=false`). Un numéro **Zadarma**
(WABA neuf hors UChat) est branché sur l'app Meta dédiée « Messaging Me MBA »,
webhook actif (statuts de livraison), et le **premier message WhatsApp réel a été envoyé depuis
la console** (template `hello_world`, wamid Meta, livraison remontée). Assets/secrets Meta :
`brain/PROJECTS.md` §Meta/WhatsApp.

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

## Lot MBA — Contenu/Analytics/Support (2026-07-12) : phases 0-7 LIVE ✅

Grand lot exécuté en feature-loop (plan validé, revue transversale multi-agents + vérif adversariale par
phase, commit + deploy à chaque phase). Détail des décisions : `documentation.md §Décisions D1-D10`.
- **Ph 0** dette + aperçu WhatsApp du carousel. **Ph 1** refonte shell (sidebar gauche, pleine largeur,
  menu Compte à droite, slot Support). **Ph 2** Contenu I : Tags + User fields éditables (répercutés contacts).
- **Ph 3** Flows riches (texte/image/champ + mapping user field + création inline depuis un template),
  webhook mapping isolé, **migration 0016** (elements/ref/mapping).
- **Ph 4** Contenu II : édition/suppression Templates (garde-fou campagne active, header/footer/carousel
  non éditables) + édition-draft / « dupliquer pour modifier » Flows.
- **Ph 5** Analytics : plage de dates libre, funnel de lecture (read receipts), coût par campagne.
- **Ph 6** pastille initiales de l'agent dans l'inbox, **migration 0017** (sender_user_id).
- **Ph 7** Support : formulaire branché sur Resend.

Tests : **~380 verts**. Aucune régression. 2 migrations appliquées (0016, 0017).

### Suivis ouverts du lot
- **Support (ph 7)** : en **mode test** Resend (n'envoie qu'à l'adresse du compte `testsuperchatjd@gmail.com`).
  Pour router vers `julien@messagingme.fr` : vérifier un domaine chez resend.com/domains (records DNS
  Cloudflare) puis basculer `SUPPORT_FROM=support@messagingme.app` + `SUPPORT_TO=julien@messagingme.fr` dans
  `.env.prod` + `docker compose up -d --force-recreate`. Clé Resend déjà dans `.env.prod` (dormante avant ph 7).
- **Analytics (ph 5)** : le filet de revue multi-agents a stallé (souci workflow) ; revue manuelle + 32 tests
  stats clean, déployé pour test par Julien. À re-vérifier si un retour terrain remonte un souci.
- Coup d'œil navigateur (Julien) sur les visuels des phases 3-7.

## Prochaine étape

1. ⚠️ **URGENT — remplacer le token temporaire (24 h)** par un token System User permanent
   (Business Settings → System Users → assigner le WABA → scopes `whatsapp_business_messaging`
   + `whatsapp_business_management`), sinon l'envoi casse à expiration. Puis `sed` dans
   `.env.prod` + `docker compose up -d --force-recreate`.
2. Faire approuver le template `promo_test` (Marketing, FR, 1 variable) pour de vraies campagnes.
3. **Onboarding client (Embedded Signup)** : configurer Facebook Login for Business (config_id),
   coder le bouton ES + l'échange de token, puis Access Verification (Tech Provider) + App Review
   (screencast). Voir `todo.md`.

## En attente (dépendances externes)

- **MBA (agent auto-réponse)** : bloqué par les ToS (403 « Meta Business AI Terms »), gating
  vertical. Veille à mettre en place (cron `agent_eligibility`). Parqué.

## Reste (non bloquant) — voir `todo.md`

- TLS pooler en vérif complète (pinner la CA Supabase).
- Unicité email globale (décision produit).
- Pagination contacts UI, quality rating alimenté par webhook, tests DLQ/CI intégration.
