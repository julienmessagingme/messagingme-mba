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
Runbook complet + checklist live : [DEPLOY.md](DEPLOY.md). Mode **`DRY_RUN=true`** (le worker
marque `sent` sans appeler Meta) tant qu'aucun vrai numéro n'est branché. Auth **JWT (login)** +
**RBAC** (écritures réservées aux admins).

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
- **Discipline anti-tailor-made** : pas de flow builder, pas de nodes, inbox minimal borné.
  Voir la liste « on ne construit PAS » du cadrage.
