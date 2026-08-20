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
`sudo docker compose run --rm --no-deps mba-api npm run migrate`, PUIS `up -d --build`). Dernière appliquée :
**0066** (liens tracés ; 0065 rôle manager le 2026-08-20). **Prochaine = 0067.** En pratique on applique aussi
via `npm run migrate` en local (même Supabase prod).

⚠️ **`up -d --build` OBLIGATOIRE dès que `web/next.config.mjs` bouge** : les `rewrites` sont **gelés au build**
de l'image web. Un simple `up -d` laisserait le proxy dans son état d'avant, et le chemin public `/r/:code`
rendrait un 404 Next, donc des liens de templates morts.

🔴 **Les liens tracés sont une porte à SENS UNIQUE.** Dès qu'un template portant un lien `/r/<code>` est
approuvé et **envoyé**, son adresse circule dans des messages livrés. Retirer la route `/r/:code`, la table
`tracked_links` ou le rewrite Next les casserait **tous**, sans recours possible. Le retour arrière n'existe
qu'avant le premier envoi tracé.

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
- **Avant d'écrire un helper, regarder s'il existe déjà.** L'audit du 2026-08-18 a supprimé une centaine de
  copies de fonctions que le repo possédait déjà (dont `scopeTenant`, le contrôle d'accès tenant, présent dans
  22 fichiers de routes). Les points de passage obligés sont listés dans `documentation.md` (« Modules
  partagés ») : un fragment SQL, une classe Tailwind ou une normalisation de texte s'y importe, ne se recopie pas.
- Git : rester sur `main`, committer sur `main`, push `origin`.
- **Discipline anti-tailor-made** : inbox minimal borné, pas de multicanal/segments avancés/A-B testing.
  (Un **constructeur de Flow** riche EXISTE désormais, cf `features.md` : formulaires de collecte, pas un
  workflow builder générique.)

### Automation (règles d'archi issues des revues, 2026-08-03)

- **Prochaine migration libre = 0059.** Les migrations ne sont PAS auto-appliquées : construire l'image AVANT de
  migrer (une migration ajoutée après le dernier build est absente de l'image, et `migrate` répond « à jour »
  sans rien appliquer). Cf `DEPLOY.md`.
- **L'émission d'un événement d'automation est gouvernée par le CHEMIN appelant, jamais par la dépendance
  partagée.** L'exécuteur de scénario sert AUSSI les campagnes : publier depuis la pose de tag ferait émettre un
  événement par destinataire d'une campagne. Le défaut est « n'émet pas » ; seuls les démarrages unitaires
  (réponse d'un contact, automation, test) passent le drapeau.
- **Aucun chemin de MASSE n'émet** (action en masse du mini-CRM, import CSV, API publique, campagne). Ajouter
  une émission sur un de ces chemins = envoi de masse involontaire et facturé. Test de garde dans
  `tests/contacts.test.ts` et `tests/workflow-executor.test.ts`.
- **Toute nouvelle file pg-boss doit entrer dans `BASE_QUEUES`** (`src/queue/names.ts`), sinon elle est
  invisible de `/ops` et sa DLQ n'est surveillée par personne. Le test `tests/queue-names.test.ts` dérive la
  liste des `queue.work(...)` du worker et casse si on l'oublie.
- **Une garde de validation se calcule sur l'état EFFECTIF après écriture** (`patch ?? courant`), jamais sur le
  corps de la requête : sinon elle ne ferme qu'un sens (cf. la garde anti-boucle de « conversation analysée »).

### Sécurité (deltas projet)

Conventions génériques (secrets serveur, `.env` non committé, Zod `safeParse` sur webhooks + JSON LLM, signature de webhook entrant, entrée LLM délimitée) : section « Conventions de code » du CLAUDE.md global. Spécifique à MBA :

- **Isolation tenant = cas « accès médié par un serveur » du global** : `tenant_id=$1` sur CHAQUE requête. La connexion pooler est un rôle superuser, donc la RLS serait bypassée, le filtrage en code est le seul contrôle. IDOR = leçon convanalyzer.
- **Secrets serveur concrets** : `META_ACCESS_TOKEN`, `META_APP_SECRET` (signature webhook), `OPS_TOKEN`, `ENCRYPTION_KEY`, `AUTH_SECRET`, `service_role`, tous dans `src/`/worker/`.env.prod`, jamais dans le bundle `web/` ni en `NEXT_PUBLIC_*`.

### Gotchas et décisions

Le journal chronologique (gotchas Meta et décisions par lot) a été déplacé dans [documentation.md](documentation.md) pour garder ce CLAUDE.md léger. À consulter là, à la demande.
