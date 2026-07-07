# todo.md — backlog

## Plan des boucles feature-loop (ordre)

1. ✅ **Loop 1 — Webhook receiver + file + idempotence** (le socle que tout consomme).
2. ✅ **Loop 2 — Wrapper Cloud API + MM Lite** (send text/template, statuts, marketing_messages,
   erreurs + retries + throttling).
3. ✅ **Loop 3 — Contacts BSUID-native + import CSV + user fields** (parsing, dédup, merge CTA).
4. ✅ **Loop 4 — Moteur de campagne + garde-fous** (pacing, fréquence max, coupure quality rating).
5. ✅ **Loop 5 — Adaptateurs Postgres + run E2E** (stores PG, services create/run, routes HTTP
   import/campagne/run, worker campaign-run ; E2E CSV->campagne->envoi prouvé contre Supabase).

Fait ✅ : UI (login, contacts/import, campagnes) + auth JWT/RBAC + déployé **LIVE** sur
`mba.messagingme.app` (1er envoi WhatsApp réel le 2026-07-06, numéro Zadarma).

## Post-live — prochaines actions

- ⚠️ **URGENT : token permanent.** Le `META_ACCESS_TOKEN` en prod est temporaire (24 h). Générer
  un token System User permanent (Business Settings → System Users → assigner le WABA → scopes
  `whatsapp_business_messaging` + `_management`), `sed` dans `.env.prod`, `up -d --force-recreate`.
- **Template `promo_test`** (Marketing, FR, variable {{1}}=nom) à faire approuver par Meta pour de
  vraies campagnes marketing (pour le 1er test on a utilisé `hello_world`, pré-approuvé).
- **Onboarding client (Embedded Signup)** : Facebook Login for Business (config_id) → bouton ES +
  échange de token BISU côté backend → **Access Verification (Tech Provider)** + **App Review**
  (Advanced Access sur les perms WhatsApp, screencast par permission). Ni l'un ni l'autre requis
  pour NOTRE propre numéro (rôle sur l'app), mais requis pour brancher les WABA de clients.
- **Veille MBA** : cron qui poll `GET api.facebook.com/{phone_number_id}/agent_eligibility`
  (baseline = 403 « Meta Business AI Terms »), alerte au changement. **NON posé** (service de
  triggers KO + creds Telegram non accessibles) — à recâbler (cron VPS + canal d'alerte fourni par Julien).

## ✅ Sécurité / auth — RÉSOLU (était BLOQUANT à la revue Loops 3-5)

Auth construite et déployée : login JWT (scrypt async, rate-limit, hash leurre anti-énumération),
isolation tenant sur toutes les routes (tenant DÉRIVÉ du JWT, 403 si mismatch), RBAC (écritures
admin-only via `forbidNonAdmin`), ownership `phoneNumberId` validée, `AUTH_SECRET` fail-fast en
prod. Résidus non bloquants ci-dessous.

## Suites de la revue sécurité auth

- ✅ **RBAC** : `forbidNonAdmin` applique le rôle admin sur les écritures (import, création + run
  de campagne). Reads ouverts aux comptes authentifiés. Matrice à affiner si un rôle `agent` est
  réellement provisionné.
- ✅ **Compte démo** `admin@demo.test` désactivé en prod (password_hash null, réversible).
- ✅ **AUTH_SECRET** : boot prod échoue si absent/faible ; posé sur le VPS.
- ⏳ **TLS pooler** : la vérif complète échoue (chaîne self-signed du pooler Supabase) ->
  `DB_SSL_INSECURE=true` (chiffré mais non vérifié). Pour la vérif complète : télécharger la CA
  Supabase (dashboard) et pointer `DB_SSL_CA_FILE` en prod.
- ⏳ **Unicité email** : `findByEmail` déterministe (ORDER BY + LIMIT 1). Décider email global
  (`unique (email)`) vs par-tenant (login avec sélection de tenant).

## Suites de la revue Loops 3-5 (non bloquant)

- **Réconciliation `sending`** : le claim atomique (fix double-envoi) laisse un destinataire en
  `sending` si l'envoi réussit mais la persistance `sent` échoue (sous-livraison, sens sûr). Ajouter
  un sweeper (reset `sending` → `pending` au-delà d'un timeout) ou une réconciliation via le
  `message_id` du webhook de statut. Aujourd'hui : jamais re-livré (pas de double-envoi), OK.
- **createCampaign transactionnel** : le build se fait désormais AVANT l'insert (plus d'orphelin
  draft si le mapping est invalide), mais insertCampaign + insertRecipients ne sont pas dans une
  transaction unique → un crash entre les deux laisse une campagne draft à destinataires partiels
  (borné : draft inerte). Envelopper dans BEGIN/COMMIT + INSERT multi-lignes si besoin.
- **quality getRating** : lu à chaque destinataire (point-query PK). Mémoïser avec un TTL court côté
  PgQualityProvider si la volumétrie l'exige (dominé par l'appel Meta aujourd'hui).
- **Stress-test concurrence** : ajouter un test qui lance 2 runs concurrents de la même campagne et
  prouve zéro double-envoi (le claim + singletonKey sont en place, mais non testés sous vraie course).

## Décisions ouvertes

- **OTP post-octobre** : espérer un équivalent WABA-only en ES v4 ; sinon construire le
  fallback « copy-paste assisté ». Solution Partner écarté (hors de portée court terme).
- **Vertical de notre WABA** vs les 5 verticaux MBA : trancher via `agent_eligibility`
  post-ToS.
- **PaaS** : point de décision à l'entrée Phase 3 (Fly.io Paris / Railway EU, critère RGPD).

## Dette identifiée par la revue Loops 1-2 (différée, non bloquante)

- **TLS Supabase** : aujourd'hui `DB_SSL_INSECURE=true` (fallback dev, endpoint direct = CA
  auto-signée). Upgrade : télécharger la CA Supabase (dashboard) et pointer `DB_SSL_CA_FILE`
  pour la vérif complète, OU basculer sur le pooler (cert AWS publiquement approuvé).
- **Test DLQ** : ajouter un test d'intégration qui prouve qu'un job qui throw finit en
  `<name>-dlq` après épuisement des retries (rendre retryLimit configurable dans PgBossQueue
  pour un test rapide).
- **CI intégration** : job GitHub Actions avec service Postgres qui lance `test:integration`
  (le job unitaire existe déjà).
- **`webhook_events`** : colonne nommée `meta_message_id` porte en fait une dedup key
  synthétique -> renommer en `dedup_key` (migration additive) ; et ajouter `tenant_id`/`waba_id`
  + index pour les jointures analytiques des Loops à venir.
- **`processed_at`/`error`** de `webhook_events` : sémantique à trancher (log brut d'ingestion
  vs statut de traitement réel).
- **parse.ts** : uniformiser le routage des sous-événements (messages/statuses par tableau,
  handovers par `field`) pour éviter tout double-comptage sur un payload composite.

## Raffinements notés (non bloquants)

- **Loop 3 / import** : si deux colonnes CSV mappent la même custom key, la dernière écrase
  silencieusement (responsabilité du mapping UI). Ajouter un warning/validation à l'étape mapping.
- **Loop 3 / slugify** : collision de labels distincts -> même key (dedup, 1er gagne). Si on
  veut de la disambiguation (`ville`, `ville_2`), à implémenter dans ensureField.

- **Loop 2 / `withRetry`** : toute erreur non-`MetaApiError` est rejouée (conforme au plan
  « réseau = retryable »), ce qui masque un bug de programmation sous des retries. À terme :
  ne rejouer que des erreurs réseau connues (fetch failed / ECONNRESET / ETIMEDOUT).
- **Loop 2 / `MetaClient`** : le `rateLimiter.acquire()` par tentative est correct mais non
  couvert par un test au niveau client (ajouter « rateLimiter appelé N fois »).

- **Loop 5 / `campaignExists`** (`src/index.ts`) : fait un `getCampaign` complet (SELECT toutes
  colonnes) juste pour un test d'existence -> un `select 1 from campaigns where id=$1` suffirait.
- **Loop 5 / état `queued`** : la route `run` enqueue sans transition d'état visible (campagne
  reste `draft` jusqu'à ce que le worker la passe `running`). Une future UI voudra peut-être un
  état `queued` intermédiaire.
- **Loop 5 / `insertRecipients`** : boucle un INSERT par destinataire (N allers-retours). Correct
  et idempotent ; passer en bulk insert si forte volumétrie.
- **Loop 5 / quality rating** : `PgQualityProvider` lit `phone_numbers.quality_rating` (défaut
  UNKNOWN). Câbler l'alimentation par webhook (account/phone_number_quality_update) pour que le
  garde-fou qualité protège au-delà du seul taux d'échec.

## Bugs connus

(aucun pour l'instant)

## Plus tard (V2+)

- Sync CRM (audiences entrantes + « zéro saisie » sortant : extraction post-conversation).
- Recettes événementielles (agent_event vs template selon fenêtre ouverte).
- Couche pub : wedge CTWA + attribution (referral/ctwa_clid + Conversions API).
- Coexistence (option d'onboarding app → API).
