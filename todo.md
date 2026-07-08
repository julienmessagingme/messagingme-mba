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

- ✅ **Token permanent POSÉ (2026-07-08).** `META_ACCESS_TOKEN` = token System User permanent
  (`expires_at:0`, scopes messaging+management), dans `.env.prod` du VPS. Templates create+list
  validés en live via l'app. Détails : `brain/PROJECTS.md` §Meta/WhatsApp.
- ✅ **Placeholders demo supprimés (2026-07-08).** `demo-pn`/`demo-waba` (seed) traînaient sous le
  tenant réel et gagnaient le `order by created_at limit 1` -> 502 templates. DELETE des 2 lignes.
- 🟡 **Robustesse `getTenantWabaId`/`getTenantPhoneNumberId`** : sélectionnent par
  `order by created_at limit 1`. OK aujourd'hui (une seule vraie ligne), mais fragile si un 2e numéro
  réel est onboardé (choix arbitraire) ou si un placeholder de seed réapparaît. À terme : filtrer sur
  un critère de validité (id numérique / flag actif) plutôt que l'ordre d'insertion. Cf. LEARNINGS 2026-07-08.
- **Template `mba_console_test`** (id `1507311428074574`, PENDING) : template de test créé pour prouver
  la feature. Supprimable depuis l'onglet Templates quand tu veux.
- **Onboarding client (Embedded Signup)** : Facebook Login for Business (config_id) → bouton ES +
  échange de token BISU côté backend → **Access Verification (Tech Provider)** + **App Review**
  (Advanced Access sur les perms WhatsApp, screencast par permission). Ni l'un ni l'autre requis
  pour NOTRE propre numéro (rôle sur l'app), mais requis pour brancher les WABA de clients.
- **Veille MBA** : cron qui poll `GET api.facebook.com/{phone_number_id}/agent_eligibility`
  (baseline = 403 « Meta Business AI Terms »), alerte au changement. **NON posé** (service de
  triggers KO + creds Telegram non accessibles) — à recâbler (cron VPS + canal d'alerte fourni par Julien).

## ✅ Suites revue templates + inbox — TOUT RÉSOLU (2026-07-08)

- ✅ **Bouton URL dynamique** : `buildComponents` émet l'`example` bouton quand l'URL contient `{{n}}`.
- ✅ **Types interactifs Flows** : `nfm_reply` capturé (corps + `response_json` en payload), réaction
  (emoji), médias (légende ou `[type]`), localisation, sous-type inconnu -> `[interactif]`. Plus de
  perte silencieuse.
- ✅ **Liaison contact** : match `'+'||wa_id` PUIS chiffres normalisés (`regexp_replace`) -> tolère un
  formatage différent.
- ✅ **Message Meta** : 502 tronqué à 200 car., espaces compactés.
- ✅ **Templates list** : pagination complète (suit `paging.next`, cap 20 pages).

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
- ⏳ **TLS pooler** (BLOQUÉ sur un fichier externe, pas de la flemme) : la vérif complète échoue
  (chaîne self-signed du pooler Supabase) -> `DB_SSL_INSECURE=true` (chiffré mais non vérifié). Le
  code est PRÊT (`DB_SSL_CA_FILE` -> vérif stricte, `pgSsl()`), il ne manque QUE la CA : la
  télécharger dans le dashboard Supabase (Project Settings -> Database -> SSL Configuration ->
  « Download certificate »), la monter dans le conteneur, poser `DB_SSL_CA_FILE=/chemin/ca.crt` et
  retirer `DB_SSL_INSECURE`. Action Julien (accès dashboard).
- ✅ **Unicité email** : tranché -> email GLOBAL insensible à la casse. Migration 0010 (index
  `users_email_lower_unique` sur `lower(email)`), `findByEmail` matche `lower(email)`. Fin du
  non-déterminisme multi-tenant.

## Suites de la revue Loops 3-5

- ✅ **Réconciliation `sending`** : sweeper `reclaimStale` en place (worker.ts, `STALE_SENDING_MS`),
  reset `sending` -> `pending` au-delà du timeout.
- ✅ **createCampaign transactionnel + bulk** : `createWithRecipients` est dans un BEGIN/COMMIT et
  insère les destinataires en UNE requête (`unnest`, helper `bulkInsertRecipients`, idempotent
  `on conflict do nothing`). `insertRecipients` idem.
- 🟡 **quality getRating** : lu à chaque destinataire (point-query PK). Mémoïser (TTL court) si la
  volumétrie l'exige. Dominé par l'appel Meta aujourd'hui -> laissé tel quel.
- 🟡 **Stress-test concurrence** : le claim atomique (pending->sending) + `singletonKey` sont en place
  et testés au niveau claim ; un test « 2 runs concurrents -> zéro double-envoi » sous vraie course
  reste à ajouter (nice-to-have, pas un bug connu).

## Décisions ouvertes

- **OTP post-octobre** : espérer un équivalent WABA-only en ES v4 ; sinon construire le
  fallback « copy-paste assisté ». Solution Partner écarté (hors de portée court terme).
- **Vertical de notre WABA** vs les 5 verticaux MBA : trancher via `agent_eligibility`
  post-ToS.
- **PaaS** : point de décision à l'entrée Phase 3 (Fly.io Paris / Railway EU, critère RGPD).

## Dette de la revue Loops 1-2

- ⏳ **TLS Supabase** : idem « TLS pooler » ci-dessus (bloqué sur la CA à télécharger au dashboard).
- ✅ **Test DLQ** : test d'intégration qui prouve job qui throw -> `<name>-dlq` (retryLimit
  configurable + `pullPending`, 1 seule tentative avec retryLimit:0).
- ✅ **CI intégration** : job `integration` (service Postgres 16, `DB_SSL=off`, migrate +
  `test:integration`) ajouté à `.github/workflows/ci.yml`.
- 🟢 **parse.ts** : VÉRIFIÉ, pas de double-comptage. Chaque sous-événement a une `dedupKey`
  distincte par source (rien ne collapse) ; messages+statuses arrivent sous le même `field:messages`
  donc le routage par tableau est le bon choix (gater par `field` serait fragile aux versions Meta).
- ⏸️ **`webhook_events` renommage `meta_message_id` -> `dedup_key`** : décision de NE PAS le faire.
  Renommer une colonne sur le chemin chaud du webhook (coordination migration+déploiement, fenêtre
  d'échec d'insert) pour un gain purement cosmétique n'en vaut pas le risque ; la couche appli
  utilise déjà `dedupKey` et la colonne est documentée. `tenant_id`/`waba_id` : prématuré tant
  qu'aucun consommateur analytique n'existe (colonnes vides = spéculatif).
- ⏸️ **`processed_at`/`error`** : sémantique à trancher (log brut d'ingestion vs statut de
  traitement réel). Décision produit, pas un bug.

## Raffinements notés

- ✅ **Loop 3 / import collision** : deux colonnes -> même custom key est signalé (`report.errors`
  « colonnes fusionnées »), 1re valeur non vide gagne.
- ⏸️ **Loop 3 / slugify** : deux labels distincts -> même key = fusion (1er gagne) + warning.
  Décision : on GARDE ce comportement. Disambiguer en `ville_2` casserait silencieusement le mapping
  des variables de template (l'utilisateur mappe sur `ville`). Le warning est le bon compromis.
- ✅ **Loop 2 / `withRetry`** : ne rejoue QUE `MetaApiError.retryable` + codes réseau connus
  (`NETWORK_CODES`), pas un throw arbitraire.
- ✅ **Loop 2 / `MetaClient`** : test « `rateLimiter.acquire()` appelé à chaque tentative » ajouté.
- ✅ **Loop 5 / existence campagne** : `campaignBelongsTo` = `select 1 ... where id and tenant_id`.
- ✅ **Loop 5 / `insertRecipients`** : bulk insert (`unnest`).
- 🟡 **Loop 5 / état `queued`** : la route `run` enqueue sans état intermédiaire visible (reste
  `draft` jusqu'à `running`). Une future UI voudra peut-être un `queued`. Décision produit.
- 🟡 **Loop 5 / quality rating** : `PgQualityProvider` lit `phone_numbers.quality_rating` (défaut
  UNKNOWN). Câbler l'alimentation par webhook `phone_number_quality_update` (feature, pas un bug).

## Bugs connus

(aucun pour l'instant)

## Plus tard (V2+)

- Sync CRM (audiences entrantes + « zéro saisie » sortant : extraction post-conversation).
- Recettes événementielles (agent_event vs template selon fenêtre ouverte).
- Couche pub : wedge CTWA + attribution (referral/ctwa_clid + Conversions API).
- Coexistence (option d'onboarding app → API).
