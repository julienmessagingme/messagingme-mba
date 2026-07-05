# todo.md — backlog

## Plan des boucles feature-loop (ordre)

1. **Loop 1 — Webhook receiver + file + idempotence** (le socle que tout consomme).
2. **Loop 2 — Wrapper Cloud API + MM Lite** (mocks des contrats : send text/template, statuts,
   marketing_messages, gestion erreurs + retries + throttling).
3. **Loop 3 — Contacts BSUID-native + import CSV + opt-out** (parsing, dédup, merge CTA).
4. **Loop 4 — Moteur de campagne + garde-fous** (pacing, fréquence max, coupure quality rating).

Après les boucles backend : UI (inbox minimal + 2 rôles, dashboard) en direct (hors feature-loop).

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

- **Loop 2 / `withRetry`** : toute erreur non-`MetaApiError` est rejouée (conforme au plan
  « réseau = retryable »), ce qui masque un bug de programmation sous des retries. À terme :
  ne rejouer que des erreurs réseau connues (fetch failed / ECONNRESET / ETIMEDOUT).
- **Loop 2 / `MetaClient`** : le `rateLimiter.acquire()` par tentative est correct mais non
  couvert par un test au niveau client (ajouter « rateLimiter appelé N fois »).

## Bugs connus

(aucun pour l'instant)

## Plus tard (V2+)

- Sync CRM (audiences entrantes + « zéro saisie » sortant : extraction post-conversation).
- Recettes événementielles (agent_event vs template selon fenêtre ouverte).
- Couche pub : wedge CTWA + attribution (referral/ctwa_clid + Conversions API).
- Coexistence (option d'onboarding app → API).
