# wip.md — travail en cours

## Fait (2026-07-05)

- Scaffold du repo : structure, docs (5 fichiers), config TS/Fastify/vitest.
- Baseline verte : `GET /health` + stubs `/webhooks/meta` (POST + handshake GET), 1 test qui
  passe.
- Migration DB initiale `0001_init.sql` (tenants, users, waba, phone_numbers, contacts,
  webhook_events).
- **Supabase branché** : projet `messagingme-MBA` (ref `npdqnrirxhqsyyvtvtjz`), migration
  0001 appliquée et vérifiée (7 tables live). Runner `npm run migrate` (`db/migrate.ts`,
  suivi via `schema_migrations`). Connexion directe IPv6 OK depuis le poste ; fallback pooler
  IPv4 documenté dans `.env` (region à confirmer si besoin). ⚠️ le MCP Supabase ne voit PAS
  ce projet (autre org) → connexion directe uniquement. Creds en `.env` (gitignoré) + brain.

## Fait — Loop 1 (feature-loop, reviewer PASS, commit 44a73f0)

Webhook receiver async : signature `X-Hub-Signature-256` timing-safe, ACK bouclier (enqueue
pg-boss durable, zéro parse/DB dans la route), dédup idempotente par clé d'événement, worker
+ `PgEventStore` (insert `ON CONFLICT` sur l'index partiel), DLQ pg-boss, BSUID-native.
`src/{lib/signature,webhooks/*,queue/*,db/pool,worker}.ts`. **23 tests unitaires + 2
intégration** (Supabase `pgboss_test`), typecheck clean. Le test d'intégration a attrapé un
bug réel (ON CONFLICT sur index partiel).

## Fait — Loop 2 (feature-loop, reviewer PASS, à committer)

Wrapper Meta typé : `src/meta/{errors,http,client,types}.ts`. `classify` (retryable/terminal,
+429/408/425/5xx), `MetaApiError`, `withRetry` (backoff + sleep injectable), `RateLimiter`,
`FetchTransport` + `HttpTransport` injectable, `MetaClient` (sendText/sendTemplate/sendMarketing
avec `to` E.164 | `recipient` BSUID, `to` prime). **43 tests** (transport mocké, zéro réseau).

## Fait — Loop 3 (feature-loop, reviewer PASS tour 2, à committer)

Mini-CRM end-to-end : migration 0002 (user_fields + contacts.fields jsonb) ;
`src/crm/{types,fields,csv,recognize,phone,template,import}.ts` — slugify + ensureField,
parseCsv (papaparse), recognizeColumns (alias FR+EN, `numéro` exact -> phone), normalizePhone
(libphonenumber E.164), resolveTemplateParams (field/attribute/literal + validation positions),
importContacts (dédup téléphone, fields merge documenté, opt-in, rapport avec ligne fichier).
**75 tests**. Chaîne CSV -> user fields -> variables de template livrée (l'envoi = Loop 4).

## Prochaine étape

- **Loop 4 (feature-loop) : Moteur de campagne + garde-fous** (sélection audience, pacing,
  fréquence max/contact, coupure sur dégradation du quality rating ; envoi via MetaClient
  MM Lite/Cloud API + résolution des variables par contact).

## En attente (dépendances externes)

- **Numéro sandbox** : commandé, activation attendue (prochain jour ouvré) → validation
  end-to-end (premier envoi réel + webhooks sur NOTRE receiver).
- **MBA** : bloqué par les ToS (403 « Meta Business AI Terms »), l'onglet WhatsApp Manager
  n'est pas encore apparu (gating vertical). Parqué.
- **Supabase prod** : à créer au déploiement (pas bloquant, tests sur Postgres local).
- **Pilote OTP Zadarma** : gaté sur le KYC Zadarma (jours), indépendant du numéro sandbox.

## Faits vérifiés utiles (2026-07-05)

- Notre WABA démo (`586049727914883`) : `verified` + `APPROVED` + MM Lite `ONBOARDED`.
  → la brique campagnes est testable sur l'existant sans attendre le numéro sandbox.
