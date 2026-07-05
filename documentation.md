# documentation.md — technique

## Architecture (async découplé, 3 étages)

Le traitement synchrone est exclu (timeout Meta au moindre pic). Flux entrant :

1. **Webhook Receiver (bouclier)** : Fastify. Valide la signature `X-Hub-Signature-256`,
   pousse le payload brut en file, répond `200` immédiatement (cible < 50 ms). Zéro logique
   métier. Route `POST /webhooks/meta` (+ handshake `GET /webhooks/meta` avec `hub.challenge`).
2. **File durable** : `pg-boss` sur Postgres (PAS en RAM : une file mémoire perd les jobs au
   crash). Transactionnelle avec nos données. Interface abstraite pour basculer BullMQ+Redis
   si l'échelle Phase 3 le justifie.
3. **Workers** : dépilent à rythme maîtrisé. Réconciliation contacts (E.164/BSUID, merge CTA),
   mises à jour DB, notifications.

File OUTBOUND critique (campagnes) : pacing (plafond Meta), lissage, ralentissement auto sur
dégradation du quality rating, fréquence max par contact. C'est là que vivent les garde-fous.

## Stack

- **Runtime** : Node.js >= 20, TypeScript (ESM), `tsx` en dev.
- **API/Receiver** : Fastify 5.
- **Validation** : zod.
- **File** : pg-boss (Loop 1).
- **DB** : Postgres = **Supabase** (projet `messagingme-MBA`, ref `npdqnrirxhqsyyvtvtjz`,
  org distincte de leadgen/EDH → invisible au MCP Supabase, connexion directe uniquement).
  Migrations SQL versionnées dans `db/migrations/`, appliquées via `npm run migrate`
  (`db/migrate.ts`, suivi `schema_migrations`). Connexion directe `db.<ref>` en IPv6-only ;
  fallback pooler IPv4 (session mode) documenté dans `.env`. Un Postgres local (Docker) peut
  servir pour des tests isolés si on veut éviter de taper la prod.
- **Frontend** (à venir) : Next.js (control plane, inbox minimal, 2 rôles admin/agent).
- **Tests** : vitest.
- **Hosting** : VPS OVH + Docker en V1 ; décision PaaS (Fly.io/Railway EU) à l'entrée Phase 3.

## Schéma DB (initial, migration 0001)

Voir `db/migrations/0001_init.sql`. Tables foncières :

- `tenants` — les clients de la console.
- `users` — comptes de la console, `role` ∈ (`admin`, `agent`).
- `waba` — WhatsApp Business Accounts (id = id Meta), rattachés à un tenant.
- `phone_numbers` — numéros (id = phone_number_id Meta), rattachés à un WABA.
- `contacts` — **identité BSUID-native** : `phone_e164` OU `bsuid` (au moins un), unicité par
  tenant sur chacun. Opt-in tracé. Merge BSUID → numéro via le Phone Number Request CTA.
- `webhook_events` — log brut des webhooks, `meta_message_id` unique pour l'idempotence.

Les tables campagnes/templates arrivent avec leur boucle (migrations additives).
pg-boss crée son propre schéma (`pgboss`), hors de nos migrations.

## Variables d'environnement

Voir `.env.example`. Clés : `PORT`, `META_APP_SECRET` (validation signature webhook),
`META_VERIFY_TOKEN` (handshake), `DATABASE_URL`.

## Patterns

- **Idempotence** : dédup par `meta_message_id` avant traitement (les webhooks arrivent en
  double).
- **ACK d'abord** : le receiver ne fait jamais de travail lourd en synchrone.
- **BSUID-native** : toute identité = E.164 OU BSUID ; ne jamais supposer un numéro présent
  (usernames : `from`/`wa_id` peuvent être omis, cf. cadrage §5bis).
- **Mocks des contrats Meta** : les wrappers API se testent contre des réponses mockées
  tirées de la spec (`META-BUSINESS-AGENT-API.md`), pas contre le live.
