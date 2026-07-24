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
npm run test:integration # vitest intégration (⚠️ le DATABASE_URL local = la PROD, cf. ci-dessous)
npm run typecheck        # tsc --noEmit

# Frontend (dans web/)
npm run dev              # Next.js :3000 (proxifie /api/backend/* -> BACKEND_URL)
npm run build            # build standalone
```

⚠️ **`npm test` en local ne prouve que la moitié des tests.** Les tests d'intégration
(stores, pg-boss, e2e) ont besoin d'un Postgres, et le `DATABASE_URL` du `.env` local pointe
sur la **base de production** : les lancer d'ici y crée et y supprime des tenants. Ne pas les
lancer en local. La CI monte un Postgres jetable pour ça (job `integration`), donc **après un
push, regarder le run GitHub** : un `npm test` vert en local n'a rien vérifié côté base. Vu le
2026-07-21, quatre commits rouges d'affilée sur une attente de test périmée qu'aucun test
unitaire ne pouvait voir.

⚠️ En prod l'app tourne **via tsx en conteneur** (`node dist` casse : ESM `moduleResolution:
Bundler` sans extensions). `npm run build` (tsc) n'est pas le chemin de déploiement.

## Déploiement

Déployé sur **`mba.messagingme.app`** (VPS Docker : `mba-api` + `mba-worker` + `mba-web`).
Runbook complet + checklist live : [DEPLOY.md](DEPLOY.md). **LIVE (`DRY_RUN=false`)**, numéro Zadarma réel.
Auth **JWT (login)** + **RBAC** (écritures réservées aux admins).

⚠️ **Migrations NON auto-appliquées** : toute migration qui ajoute une colonne écrite par le code doit
passer sur le VPS AVANT le déploiement (`sudo docker compose build mba-api` puis
`sudo docker compose run --rm --no-deps mba-api npx tsx db/migrate.ts`, PUIS `up -d --build`). Dernière : **0026**
(`auth_tokens` + `tenants.status`). En pratique on applique aussi via `npm run migrate` en local (même Supabase prod).

## Docs du repo (séparation stricte)

- **[PLAN.md](PLAN.md) — le plan global, à lire en premier.** Audit de scalabilité et lot de
  features séquencés ensemble en 6 blocs, avec les efforts et les décisions déjà tranchées.
- [AUDIT-SCALE-2026-07-18.md](AUDIT-SCALE-2026-07-18.md) — le détail de chaque constat de l'audit
  (référencé par `PLAN.md` sous la forme Bn). Verdict : pas prêt pour des dizaines de clients.
- [documentation.md](documentation.md) — technique : archi, stack, schéma DB, env, patterns
- [features.md](features.md) — fonctionnel : les features vues utilisateur, statut
- [wip.md](wip.md) — ce sur quoi on bosse maintenant
- [todo.md](todo.md) — backlog et historique des lots livrés

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

### Sécurité (deltas projet)

Conventions génériques (secrets serveur, `.env` non committé, Zod `safeParse` sur webhooks + JSON LLM, signature de webhook entrant, entrée LLM délimitée) : section « Conventions de code » du CLAUDE.md global. Spécifique à MBA :

- **Isolation tenant = cas « accès médié par un serveur » du global** : `tenant_id=$1` sur CHAQUE requête. La connexion pooler est un rôle superuser, donc la RLS serait bypassée, le filtrage en code est le seul contrôle. IDOR = leçon convanalyzer.
- **Secrets serveur concrets** : `META_ACCESS_TOKEN`, `META_APP_SECRET` (signature webhook), `OPS_TOKEN`, `ENCRYPTION_KEY`, `AUTH_SECRET`, `service_role`, tous dans `src/`/worker/`.env.prod`, jamais dans le bundle `web/` ni en `NEXT_PUBLIC_*`.

### Gotchas et décisions

Le journal chronologique (gotchas Meta et décisions par lot) a été déplacé dans [documentation.md](documentation.md) pour garder ce CLAUDE.md léger. À consulter là, à la demande.
