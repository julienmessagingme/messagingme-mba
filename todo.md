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

## Programme 16 features (2026-07-16) — lots restants

Lots A-E LIVE (cf `wip.md`). Restent, dans l'ordre recommandé :
- **Lot 4b — fin du socle identifiants** : codes des NODES (mint serveur au save du graphe, `nod_<client>_<ulid>`
  dans node.data, arêtes par node.id inchangées), codes DÉTERMINISTES des champs système
  (`fld_<client>_sys_<key>`), puis endpoints API publics adressés par code. Plan de base : `.loop/lotD-identifiants.md`.
- **Lot 6 — i18n anglais COMPLET (#2)** : `<html lang>`/metadata localisés, `web/lib/day.ts` + `format.ts`
  hardcodés `fr-FR` (7 appelants), bug `i18n.tsx` (setLocaleState au lieu de setLocale → lang non resynchronisée),
  switcher pré-login à trancher. Cartographie faite (session 2026-07-16).
- **Lot 7 — Flow avancé (#6b/#6c)** : multi-pages (screens + navigate + data-passing, ⚠️ SONDE LIVE obligatoire)
  + champs conditionnels (`visible` + piège du caché-mais-requis, sonde aussi) + **fix node `flow` no-op** du
  builder de scénario (atteint mais n'envoie RIEN, run bloqué → envoi interactif flow à sonder). Rappel : #5
  (mapping champ→client) et #6a (choix unique/multiple) sont DÉJÀ en prod.
- **HubSpot import (#14, parké)** : importer une liste HubSpot comme destinataires de campagne. Multi-repo :
  scope `crm.lists.read` sur l'app mm-hubspot + RE-CONSENTEMENT du portail cobaye (action Julien), client lists
  + route service-à-service côté mm-hubspot, proxy + réutilisation `importContacts()` côté mba, opt-in JAMAIS
  posé à 'opted_in' par défaut (conformité). + (todo #5-tail) proposer les internal names HubSpot dans les
  sélecteurs de champs.
- **Analytics palier L (suite #8)** : tracker les erreurs des envois Inbox/Workflow (colonnes d'erreur sur
  `conversation_messages` + toucher le handler de statuts webhook EN PROD, risqué → à froid).
- **Drop différés** : rien (0030 a droppé `workflows.status` ; codes = additifs).

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
- ✅ **Veille MBA POSÉE (2026-07-09)** : cron VPS `ops/mba-eligibility-watch.mjs` (crontab ubuntu,
  toutes les 6h) qui poll `GET api.facebook.com/{pnid}/agent_eligibility` (X-API-Version 2.0.0).
  Baseline = 403 « Meta Business AI Terms » (`BLOCKED_TOS`, état dans `.mba-eligibility-state.json`).
  Alerte Telegram (`@Messagingmeapp_bot`, creds lus au runtime depuis `messagingme-pilot/config.json`)
  au moindre changement d'état (mur ToS levé → MBA ouvre FR). Log `.mba-eligibility.log`.

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

## ✅ Dashboard v2 — prix templates MARCHE EN PROD (corrigé 2026-07-10)

⚠️ CORRECTION d'une conclusion erronée. J'avais écrit que `pricing_analytics` était bloqué par
l'Advanced Access (403 #200). **C'était FAUX** : la sonde avait tourné avec le token du `.env` LOCAL,
qui est limité/périmé, PAS le token permanent de prod. Re-testé DANS le conteneur `mba-api` (vrai token
`.env.prod`) : `pricing_analytics` renvoie **200 + vraies données** (marketing 0,0712 / utility 0,0248…).
Donc **le prix par template s'affiche déjà en prod** (le getPricing déployé utilise le bon token). Aucun
App Review requis pour l'analytics de NOTRE WABA. Pas de dégradation « indisponible » en réalité.

- **Leçon (cf. LEARNINGS)** : le `META_ACCESS_TOKEN` du `.env` LOCAL n'est PAS le token de prod. Toute
  sonde Meta doit tourner **dans le conteneur / avec le token de prod** (`docker cp` + `docker exec mba-api
  node ...`), jamais avec un scratch local, sinon faux négatifs (#200 « Provide valid app ID »).

## Dette Feature 2 — Admin + RBAC (revue adversariale 2026-07-10)

RBAC posé : rôles `admin`/`agent`, agent = inbox uniquement (garde serveur `makeRequireRole`
sur tous les groupes sauf inbox + templates GET, source de vérité), onglet Admin (liste users,
créer un agent, changer un rôle). Corrigé à la revue : 🔴 templates GET remis en `requireAuth`
(l'inbox agent en dépend) ; invariant « ≥1 admin/tenant » forcé EN BASE dans `setRole` (refus
`last_admin` -> 409) ; tests agent->403 ajoutés sur contacts/import. Résidus non bloquants :

- ✅ **JWT figé sur changement de rôle / révocation — RÉSOLU (2026-07-10)** : `requireAuth` relit
  l'état du compte EN BASE à chaque requête authentifiée (`getUserState` -> `PgUserStore.getAuthState`) :
  compte supprimé/révoqué -> 401 immédiat, rôle rafraîchi depuis la base. Un changement de rôle, une
  révocation ou une suppression prennent effet TOUT DE SUITE, plus de fenêtre de 12h. Coût : un lookup
  PK par requête (négligeable à ce volume). Optionnel (absent en test -> JWT seul).
- 🟡 **Oracle d'existence d'email cross-tenant** : POST /users renvoie 409 si l'email existe DÉJÀ
  ailleurs (index unique GLOBAL `lower(email)`, migration 0010). Un admin peut ainsi sonder si un
  email est déjà un compte console d'un autre tenant (fuite limitée à l'existence, message générique,
  pas de PII ni de tenant révélé). Conséquence assumée du design « un email = un compte global ».
  Fermer l'oracle imposerait de repasser à l'unicité par tenant + login scopé au tenant (changement
  de schéma qui touche le login) -> à trancher côté produit, pas en aveugle.
- 🟡 **Course théorique zéro-admin** : deux rétrogradations croisées simultanées (READ COMMITTED)
  pourraient toutes deux voir count>1. Négligeable (2 admins à la milliseconde). Fermer via
  transaction + `SELECT ... FOR UPDATE` si on ajoute un jour token_version.

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

## Raffinement invariant admin (lot 6 P3, non bloquant)

Les sous-requêtes « ≥1 admin actif » de `PgUserStore.setRole/setDisabled/deleteUser` comptent
`role='admin' and disabled_at is null` SANS exclure les comptes **pending** (password_hash null, invitation non
acceptée). Non exploitable (self-block + un pending ne peut pas s'authentifier), mais correctness-of-intent :
ajouter `and password_hash is not null` aux 3 sous-requêtes pour qu'un admin invité jamais activé ne compte pas
comme « admin actif ». Défense en profondeur, à faire à froid (touche du SQL d'invariant sécurité).

## Refonte auth — ✅ FAITE (Lot 6, 2026-07-13)

Inscription libre + Google + invitations Resend + mot de passe perdu/reset/changement, tous LIVE. Détail :
`wip.md §Lot 6`. Domaine Resend vérifié + client OAuth Google configuré (origine JS + app publiée par Julien).

## Vérifier l'identité BSUID au 1er trafic réel (lot 4)

L'envoi route déjà un BSUID en `recipient` (vs `to` pour un numéro) via `messagingTarget`, et l'inbound
auto-crée les fiches (numéro OU BSUID). Mais **aucun contact BSUID n'existe encore** (le BSUID post-octobre
n'a pas commencé à remonter). Au 1er BSUID réel : (1) confirmer le format Meta et l'heuristique
`classifyWaId` (7-15 chiffres = numéro, sinon BSUID) ; (2) vérifier qu'un template part bien via `recipient`
et est délivré ; (3) vérifier que la fiche auto-créée + le matching merge/tag/conversation collent au format
réel. Cf `documentation.md §Identité`.

## Suites builder Lot 5 — node à sorties par bouton (V2, non bloquant)

Signalés à la revue Phase 3 (sous le seuil de confiance, défense en profondeur) :
- **Snapshot des boutons figé** : le node template mémorise `templateButtons` à la sélection. Si on ÉDITE
  ensuite le template (réordonner/renommer les boutons) sans ré-ouvrir le node, le workflow garde l'ancien
  ordre -> un bouton pourrait brancher vers la mauvaise cible (le payload `btn:<i>` reste posé sur l'index i).
  Fix possible : re-fetch les boutons courants du template à l'exécution, ou invalider/re-valider le node quand
  le template change. Conditionnel (édition après câblage), pas bloquant.
- **Arêtes orphelines à la re-sélection** : changer le template d'un node déjà câblé ne purge pas les arêtes des
  anciens `sourceHandle` disparus ; combiné au repli `nextNode` (1re arête), une arête morte pourrait être
  choisie. Fix : purger les arêtes du node dont le `sourceHandle` n'existe plus au changement de template.

## Suites builder Lot 3 (V2, non bloquant)

- **Branche par bouton quick-reply** : PB2 avance aujourd'hui sur N'IMPORTE QUELLE réponse inbound. Pour un
  vrai arbre (bouton A -> bloc X, bouton B -> bloc Y), mapper les arêtes sortantes d'un bloc template sur ses
  boutons (`sourceHandle` déjà prévu dans le modèle de graphe). À faire quand un scénario réel le réclame.
- **Livraison/lecture des campagnes workflow** : message_id synthétique `wf-<id>` -> le funnel affiche
  delivered/read/replied = 0 pour ces campagnes. Câbler un vrai suivi imposerait de relier le wamid du 1er
  template envoyé par le workflow au destinataire de campagne. Limitation V1 assumée.

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

## À durcir / suites (2026-07-15)

- 🔒 **Durcir `/oauth/install?tenant=` du connecteur** : il fait aujourd'hui confiance à un **UUID de tenant nu**
  (signé dans le state, mais l'UUID lui-même n'est pas prouvé). Un tiers qui connaîtrait l'UUID d'un autre tenant
  pourrait relier SON portail HubSpot à ce tenant (détourner ses analyses). Inoffensif au pilote (1 tenant, UUID non
  exposés, bouton rendu au seul admin du tenant). Quand multi-tenant : mba émet un **ticket signé court-lived** que
  le connecteur vérifie, au lieu de l'UUID nu. (Repéré par le reviewer, sous le seuil bloquant.)
- 📊 **Tracking réel de livraison des campagnes WORKFLOW** : remplacer le message_id synthétique `wf-<id>` par le vrai
  wamid du 1er template (rapproché des webhooks de statut) -> funnel delivered/read non figé à 0. Limitation V1 connue.
- ✅ **Bouton FLOW dans l'envoi workflow — FAIT (2026-07-16)** : `buildWorkflowTemplateComponents` génère désormais
  le composant `{sub_type:'flow', parameters:[{type:'action', action:{flow_token}}]}` par bouton FLOW (corrige #131009).
  Vérifié empiriquement contre la Cloud API. Détail : `CLAUDE.md` §Gotchas 2026-07-16.
- ⚠️ **Variables de template non contiguës** (`{{1}}` + `{{3}}` sans `{{2}}`) : le front compte les positions distinctes
  (Set) alors que le backend attend 1..N contigu -> désalignement possible. Pré-existant (mode direct), pas introduit
  ce lot ; à corriger si un template non contigu apparaît.

## Suites Embedded Signup / i18n (2026-07-16)

- 🔄 **Refresh du business token ES (60 j)** : le token BISU par-client expire à 60 j. Aujourd'hui il ne sert qu'à
  l'onboarding (subscribe webhooks), donc son expiration est sans impact. **Quand on enverra les campagnes avec le
  token PAR-CLIENT** (au lieu du `META_ACCESS_TOKEN` global), câbler le refresh + l'alerting d'expiration.
- 📤 **Envoi via le token par-client** : le worker envoie aujourd'hui avec le token global (marche pour NOTRE numéro).
  Pour de vrais clients onboardés, router l'envoi/les lectures sur le business token du WABA du client.
- 🗑️ **Supprimer le compte de test reviewer** `meta-review@messagingme.app` (admin Demo) **après approbation** de
  l'App Review Meta. Le garder tant que la review n'est pas passée (Meta peut re-tester).
- 🌐 **i18n** : spot-check des chaînes visibles restées en français en mode EN (build vert + grep « aucune valeur
  backend traduite » OK, mais quelques chaînes rares ont pu être oubliées). Corriger au fil des retours de Julien.
- 🔒 **Durcir `/oauth/install?tenant=` ES multi-tenant** : l'UUID tenant est nu dans le state (cf. plus bas, connecteur
  mm-hubspot) ; même durcissement (ticket signé court-lived) côté ES quand multi-tenant.

## Bugs connus

(aucun pour l'instant)

## Plus tard (V2+)

- Sync CRM (audiences entrantes + « zéro saisie » sortant : extraction post-conversation).
- Recettes événementielles (agent_event vs template selon fenêtre ouverte).
- Couche pub : wedge CTWA + attribution (referral/ctwa_clid + Conversions API).
- Coexistence (option d'onboarding app → API).
