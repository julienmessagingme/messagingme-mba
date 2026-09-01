# CLAUDE.md : messagingme-mba

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
`sudo docker compose run --rm --no-deps mba-api npm run migrate`, PUIS `up -d --build`).

🔴 **CE FICHIER EST LA SEULE SOURCE DU COMPTEUR. Ne le recopiez nulle part.** Au 2026-08-29, trois autres
documents le portaient, et les trois étaient faux : `PLAN.md` en retard de 43 migrations (croire sa ligne
menait à écrire par-dessus une migration existante), `brain/PROJECTS.md` de 15, `wip.md` de 5. Un compteur
recopié est un compteur qui dérive. Ailleurs, on met un POINTEUR vers cette ligne.

**Dernière appliquée : 0098** (`phone_numbers.status_checked_at`, le tourniquet du balayage de statut),
passée le 2026-09-01 avec la séquence complète (build de l'image, vérification que la migration est DEDANS,
`migrate`, vérification en base). **Prochaine libre = 0099.** En pratique on applique aussi via `npm run migrate` en local (même Supabase prod).

🔴 **0096 et 0097 sont jouées HORS TRANSACTION** (0096 est la première du dépôt à l'être), via la directive
`-- migrate: no-transaction` en tête de fichier, parce que `CREATE INDEX CONCURRENTLY` est interdit dans un
bloc de transaction. Deux conséquences à connaître avant d'en écrire une autre : elle n'a **aucun filet** (un échec à mi-parcours n'annule rien et la
migration est rejouée depuis le début, donc chaque instruction doit être idempotente), et le runner l'envoie
**instruction par instruction**, parce qu'une requête simple multi-instructions est exécutée par Postgres dans
une transaction implicite, ce qui rendrait la directive inopérante. `tests/migration-directives.test.ts` garde
les deux sens de la règle sur les fichiers réels.

⚠️ **0098 était BLOQUANTE** (`saveStatus` écrit `status_checked_at` à chaque relevé), donc migrée AVANT le
déploiement. **0095 l'était aussi** (le code écrit `draft_graph` à chaque enregistrement de l'éditeur), donc migrée
AVANT le déploiement. **0094 n'était qu'un INDEX, donc non bloquante. 0093, elle, l'ÉTAIT** : son code écrit
`phone_number_id` à chaque webhook entrant, et déployer avant de migrer aurait fait échouer TOUS les entrants,
exactement l'incident du 2026-08-17. C'est le cas d'école de la règle ci-dessus : le type de la migration
décide de l'ordre, et il faut se poser la question à chaque fois plutôt que d'appliquer une routine.

🔴 **Une seule exécution de `migrate` à la fois** (verrou d'avis Postgres, lot 8). Deux exécutions
simultanées (le conteneur du VPS et le poste de Julien pointent la MÊME base) rejoueraient la même migration.
La seconde est REFUSÉE tout de suite, avec le message qui le dit. ⚠️ Et `db/` est désormais dans
`tsconfig.include` : le runner n'était pas type-checké, une faute de syntaxe n'y devenait visible qu'à
l'exécution, en plein déploiement.

🔴 **Les migrations vivent DANS L'IMAGE, pas sur le disque du VPS** (`COPY db ./db`). Un `git pull` suivi de
`compose run ... npm run migrate` rejoue donc les ANCIENNES migrations sans rien signaler : il faut
`compose build` AVANT. C'est pour ça que la séquence commence par le build. (Vécu le 2026-08-21.)

⚠️ **`users.password_hash` est un MIROIR transitoire** de `identities.password_hash` (migration 0072), gardé
comme chemin de retour. Ne pas le retirer tant que la confiance sur le multi-espaces n'est pas acquise, et
ne jamais l'utiliser comme source : `findIdentity` lit l'identité, pas le compte.

⚠️ **`up -d --build` OBLIGATOIRE dès que `web/next.config.mjs` bouge** : les `rewrites` sont **gelés au build**
de l'image web. Un simple `up -d` laisserait le proxy dans son état d'avant, et le chemin public `/r/:code`
rendrait un 404 Next, donc des liens de templates morts.

🔴 **Les liens tracés sont une porte à SENS UNIQUE.** Dès qu'un template portant un lien `/r/<code>` est
approuvé et **envoyé**, son adresse circule dans des messages livrés. Retirer la route `/r/:code`, la table
`tracked_links` ou le rewrite Next les casserait **tous**, sans recours possible. Le retour arrière n'existe
qu'avant le premier envoi tracé.

## Docs du repo (séparation stricte)

- **[PLAN.md](PLAN.md) : le plan global, à lire en premier.** Les DEUX programmes sont terminés le
  2026-09-01 : le I (sept lots) et le II (huit lots, dont le 8e volontairement incomplet, arbitré item par
  item). Le fichier reste la référence de séquencement et porte le piège de chaque lot ; il n'y a plus de
  liste en cours. Ce qui reste ouvert est listé dans `todo.md` et dans la §7 de l'audit du 25 août.
- [AUDIT-SYNTHESE-STRUCTURE-SCALABILITE-2026-08-31.md](AUDIT-SYNTHESE-STRUCTURE-SCALABILITE-2026-08-31.md) :
  la synthèse des trois audits, source du programme. ⚠️ Ses constats factuels ont été **revérifiés un par un
  dans le code** le 2026-08-31 (aucun faux, un sous-estimé) ; ses PRIORITÉS, elles, ont été retriées avec
  Julien. En cas d'écart, c'est `PLAN.md` qui fait foi.
- [AUDIT-SCALE-2026-08-25.md](AUDIT-SCALE-2026-08-25.md) : plus aucun rouge ni orange (clos le 2026-08-31).
  ⚠️ Sa **§7, 23 jaunes**, était la dette de performance restante, et elle a structuré le programme II. Au
  2026-09-01, après les huit lots : une dizaine sont fermés (purge `webhook_events`, `expireInSeconds` du
  retry-sweep, ré-entrance des balayages, rejet de webhook muet, rétention générale, index des chemins chauds,
  index des rétentions, delta du fil, `AbortController`, batch de contacts, création de campagne en mémoire,
  balayage de statut plafonné à 200). **Deux ont été fermés par la MESURE, sans code** : l'index du funnel ne
  change rien (191 ms avant et après), et l'upload média est déjà borné. Le reste est dans `todo.md`.
- [AUDIT-SCALE-2026-07-18.md](AUDIT-SCALE-2026-07-18.md) : le détail de chaque constat de l'audit
  (référencé par `PLAN.md` sous la forme Bn). Supplanté par celui d'août quand les deux se recouvrent.
- [documentation.md](documentation.md) : technique : archi, stack, schéma DB, env, patterns
- [features.md](features.md) : fonctionnel : les features vues utilisateur, statut
- [wip.md](wip.md) : ce sur quoi on bosse maintenant
- [todo.md](todo.md) : backlog et historique des lots livrés

## Règles spécifiques au projet

- **Construction par briques via `feature-loop`** : une boucle par brique testable (voir
  `todo.md`). Le scaffold + le schéma DB sont posés en direct ; les briques déterministes
  (receiver, wrapper API, contacts, campagnes) passent par des boucles plan → exécute →
  vérifie → reviewer. L'UI (inbox/dashboard) n'est PAS pour feature-loop.
- **On vérifie contre des mocks des contrats Meta + des tests** (unitaires + intégration
  Supabase), pas contre le Meta live tant qu'on n'a pas de numéro branché. La chaîne tourne
  déjà end-to-end en **DRY_RUN** sur le déploiement ; l'envoi Meta réel se valide en live plus tard.
- **Pas de tirets longs** dans la doc (« : » / « : » interdits).
- **Avant d'écrire un helper, regarder s'il existe déjà.** L'audit du 2026-08-18 a supprimé une centaine de
  copies de fonctions que le repo possédait déjà (dont `scopeTenant`, le contrôle d'accès tenant, présent dans
  22 fichiers de routes). Les points de passage obligés sont listés dans `documentation.md` (« Modules
  partagés ») : un fragment SQL, une classe Tailwind ou une normalisation de texte s'y importe, ne se recopie pas.
- Git : rester sur `main`, committer sur `main`, push `origin`.
- 🔴 **`gh run list` AVANT tout déploiement**, au même titre que `git log <déployé>..HEAD`. Un `npm test`
  vert en local ne prouve que la moitié : les tests d’intégration ne tournent qu’en CI, sur un Postgres
  jetable. Déployer sans avoir regardé le run, c’est déployer sans avoir vu la moitié des tests.
- **Discipline anti-tailor-made** : inbox minimal borné, pas de multicanal/segments avancés/A-B testing.
  (Un **constructeur de Flow** riche EXISTE désormais, cf `features.md` : formulaires de collecte, pas un
  workflow builder générique.)

### Automation (règles d'archi issues des revues, 2026-08-03)

- **Le compteur de migrations est plus haut, section Déploiement, et il n'est écrit qu'une fois.** Elles ne sont PAS auto-appliquées : construire l'image AVANT de
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
- 🔴 **AUCUNE file de ce dépôt ne déduplique quoi que ce soit.** Elles sont créées sans `policy`, donc en
  `standard`, et pg-boss n'y applique aucun index unique sur `singleton_key` (vérifié dans sa source le
  2026-08-31 ; le paramètre `singletonKey`, qui n'a jamais rien fait, a été retiré). N'écrivez jamais de code
  ni de commentaire qui compte sur « un seul job vivant par clé » : deux enfilements = deux jobs qui tournent.
  La policy étant IMMUABLE après création, on ne peut pas non plus la rattraper sur les files existantes.
- **L'unicité d'exécution se pose à l'EXÉCUTION, jamais à l'enfilement.** Modèle de référence :
  `src/campaign/run-lock.ts` (migration 0089), qui sérialise les runs d'une même campagne. Trois choses en font
  un verrou et pas un drapeau : un **bail** (sinon un worker tué en plein envoi bloque la campagne à vie), un
  **jeton de garde** (sinon le porteur d'un bail périmé supprime le verrou de celui qui l'a repris), et un
  **drapeau de relance** (sinon le travail arrivé pendant le run est perdu). Réécrire le même verrou ailleurs
  se fait sur ces trois pièces, pas sur deux.
- **Une garde de validation se calcule sur l'état EFFECTIF après écriture** (`patch ?? courant`), jamais sur le
  corps de la requête : sinon elle ne ferme qu'un sens (cf. la garde anti-boucle de « conversation analysée »).

### Sécurité (deltas projet)

Conventions génériques (secrets serveur, `.env` non committé, Zod `safeParse` sur webhooks + JSON LLM, signature de webhook entrant, entrée LLM délimitée) : section « Conventions de code » du CLAUDE.md global. Spécifique à MBA :

- **Isolation tenant = cas « accès médié par un serveur » du global** : `tenant_id=$1` sur CHAQUE requête. La connexion pooler est un rôle superuser, donc la RLS serait bypassée, le filtrage en code est le seul contrôle. IDOR = leçon convanalyzer.
- **Secrets serveur concrets** : `META_ACCESS_TOKEN`, `META_APP_SECRET` (signature webhook), `OPS_TOKEN`, `ENCRYPTION_KEY`, `AUTH_SECRET`, `service_role`, tous dans `src/`/worker/`.env.prod`, jamais dans le bundle `web/` ni en `NEXT_PUBLIC_*`.

### Gotchas et décisions

Le journal chronologique (gotchas Meta et décisions par lot) a été déplacé dans [documentation.md](documentation.md) pour garder ce CLAUDE.md léger. À consulter là, à la demande.
