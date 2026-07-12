# CLAUDE.md — messagingme-mba

**Produit :** console SaaS plug-and-play qui déploie et pilote la stack native Meta pour
WhatsApp (Cloud API + Marketing Messages API/MM Lite + Meta Business Agent) pour des clients.
Pitch : « Envoie des campagnes WhatsApp qui se répondent toutes seules. »

**Cadrage produit (source de vérité) :** `messagingme-pilot/docs/PROJET-MBA-CONSOLE.md`
(+ `META-BUSINESS-AGENT-API.md` pour la référence API). Ce repo = l'implémentation.

## Commandes

```bash
# Backend (racine)
npm install              # deps
npm run dev              # API Fastify en watch (charge .env)
npm run worker           # worker pg-boss : webhooks + campaign-run + sweeper (charge .env)
npm run migrate          # applique db/migrations/*.sql (suivi schema_migrations)
npm run seed             # compte/tenant démo (SEED_PASSWORD requis, ou SEED_DEMO=true)
npm test                 # vitest unitaires (sans DB)
npm run test:integration # vitest intégration (contre Supabase, DATABASE_URL requis)
npm run typecheck        # tsc --noEmit

# Frontend (dans web/)
npm run dev              # Next.js :3000 (proxifie /api/backend/* -> BACKEND_URL)
npm run build            # build standalone
```

⚠️ En prod l'app tourne **via tsx en conteneur** (`node dist` casse : ESM `moduleResolution:
Bundler` sans extensions). `npm run build` (tsc) n'est pas le chemin de déploiement.

## Déploiement

Déployé sur **`mba.messagingme.app`** (VPS Docker : `mba-api` + `mba-worker` + `mba-web`).
Runbook complet + checklist live : [DEPLOY.md](DEPLOY.md). **LIVE (`DRY_RUN=false`)**, numéro Zadarma réel.
Auth **JWT (login)** + **RBAC** (écritures réservées aux admins).

⚠️ **Migrations NON auto-appliquées** : toute migration qui ajoute une colonne écrite par le code doit
passer sur le VPS AVANT le déploiement (`sudo docker compose build mba-api` puis
`sudo docker compose run --rm --no-deps mba-api npx tsx db/migrate.ts`, PUIS `up -d --build`). Dernière : 0017.

## Docs du repo (séparation stricte)

- [documentation.md](documentation.md) — technique : archi, stack, schéma DB, env, patterns
- [features.md](features.md) — fonctionnel : les features vues utilisateur, statut
- [wip.md](wip.md) — ce sur quoi on bosse maintenant
- [todo.md](todo.md) — backlog (dont le plan des boucles feature-loop)

## Règles spécifiques au projet

- **Construction par briques via `feature-loop`** : une boucle par brique testable (voir
  `todo.md`). Le scaffold + le schéma DB sont posés en direct ; les briques déterministes
  (receiver, wrapper API, contacts, campagnes) passent par des boucles plan → exécute →
  vérifie → reviewer. L'UI (inbox/dashboard) n'est PAS pour feature-loop.
- **On vérifie contre des mocks des contrats Meta + des tests** (unitaires + intégration
  Supabase), pas contre le Meta live tant qu'on n'a pas de numéro branché. La chaîne tourne
  déjà end-to-end en **DRY_RUN** sur le déploiement ; l'envoi Meta réel se valide en live plus tard.
- **Pas de tirets longs** dans la doc (« — » / « – » interdits).
- Git : rester sur `main`, committer sur `main`, push `origin`.
- **Discipline anti-tailor-made** : inbox minimal borné, pas de multicanal/segments avancés/A-B testing.
  (Un **constructeur de Flow** riche EXISTE désormais, cf `features.md` : formulaires de collecte, pas un
  workflow builder générique.)

### Gotchas Meta du lot (2026-07-12)
- **Édition d'un template Meta REMPLACE tous les components** (pas de patch) : un HEADER/FOOTER/CAROUSEL
  serait supprimé s'il n'est pas re-fourni -> on **bloque l'édition** de ces templates (flag `editable`).
- **Éditer le flow_json d'un DRAFT = `POST /{flow_id}/assets` en MULTIPART** (le create est du JSON inline) ;
  un flow PUBLISHED est immuable -> « dupliquer pour modifier ».
- **Funnel read receipts** : `delivery_status IS DISTINCT FROM 'failed'` (PAS `<> 'failed'` : la colonne est
  souvent NULL, `NULL <> x` = NULL = faux -> sortirait les null du dénominateur).
