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

## En cours / prochaine étape

- **Loop 1 (feature-loop) : Webhook receiver + file + idempotence.** Plan à valider puis
  boucle. Critères d'acceptation : signature `X-Hub-Signature-256` validée, ACK < 50 ms,
  enqueue pg-boss durable, dédup par `meta_message_id`, worker qui persiste `webhook_events`,
  DLQ, tests contre payloads simulés (messages, statuses, standby, messaging_handovers).

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
