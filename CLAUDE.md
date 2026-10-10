# CLAUDE.md : messagingme-mba

**Produit : « Messaging Me »** (« Engage Me » du 2026-09-03 au 2026-10-06, revenu au nom historique ; le
dépôt garde son nom technique `messagingme-mba`, comme l'identifiant du serveur MCP, qui ne doit PAS changer sous
peine de casser les connexions déjà configurées). ⚠️ **Restent `engageme` à dessein** : le connecteur `EngageMe`
publié chez Meta pour chaque espace (le renommer oblige chaque espace à republier, décision de Julien), le
namespace Salesforce `engagemeapp` et le projet Vercel `engageme-site`. La vitrine est passée sur
`app.messagingme.fr` ; `engageme.messagingme.fr` y redirige (`site/vercel.json`). La console est passée sur
`console.messagingme.app` le même jour (`APP_URL`, `CORS_ORIGINS` qui garde l'ancien nom, Google Sign-In et
Meta Embedded Signup déclarés) ; `engageme.messagingme.app` reste servi par le même projet Vercel, à rediriger. Console SaaS plug-and-play qui déploie et pilote la stack native
Meta pour WhatsApp (Cloud API + Marketing Messages API/MM Lite + Meta Business Agent) pour des clients.
Accroche du produit : « La plateforme conversationnelle qui comprend chaque conversation. »

⚠️ **« Meta Business Agent » et « MBA » restent tels quels PARTOUT** : c'est le nom du produit de META,
pas le nôtre. Notre console le configure, elle ne le porte pas.

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
npm run auto-attaque     # sondes d'attaque sur les routes REELLES, inventoriees depuis le serveur (voir documentation.md)

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
Bundler` sans extensions). Plus de script `build` ni `start` à la racine : le contrôle est `npm run typecheck`.

⚠️ **La CI `unit` lance aussi l'auto-attaque** (`npx tsx scripts/auto-attaque.mts`), que `npm test` ne couvre pas.
Un module de routes ajouté au registre hors classe `tenant` doit déclarer sa fausse autorité dans
`FAUSSES_AUTORITES`, sinon le job est rouge alors que tout est vert en local (vécu le 2026-09-30) : la lancer en
local avant de pousser.

## Déploiement

🔴 **TROIS NOMS DEPUIS LE 2026-09-03 (QUATRE avec la vitrine du 2026-09-25), et ils n'ont pas le même hébergeur.** Détail et journal d'exécution :
[docs/PLAN-BASCULE-VERCEL-2026-09-03.md](docs/PLAN-BASCULE-VERCEL-2026-09-03.md).

| Nom | Sert | Où | Comment on déploie |
|---|---|---|---|
| `console.messagingme.app` (ex-`engageme.messagingme.app`, même projet) | la console | **Vercel** (projet `messagingme-mba`, Root Directory `web`) | automatique à chaque `git push` |
| `api.messagingme.app` | l'API et le worker | VPS Docker (`mba-api`, `mba-worker`) | `git pull` + `compose up -d --build` |
| `mba.messagingme.app` | l'ANCIENNE console, plus toutes les adresses historiques | VPS (`mba-web` + routage NPM) | idem |
| `app.messagingme.fr` | la VITRINE publique (`site/`, HTML statique) | **Vercel** (projet `engageme-site`, Root Directory `site`, CNAME chez OVH) | automatique au `git push` qui touche `site/` (Ignored Build Step dans `site/vercel.json`, sur `VERCEL_GIT_PREVIOUS_SHA`) |

⚠️ **La vitrine n'a AUCUNE variable d'environnement, et elle ne doit pas en avoir.** À l'import, Vercel
propose les 31 variables du `.env.example` RACINE (le backend), même avec `site` pour Root Directory : on les
supprime toutes. `ci.yml` ignore `site/**` (aucun test ne la lit) ; les docs API et MCP de la console, vers
lesquelles elle pointe, sont PUBLIQUES depuis le 2026-09-25.

⚠️ **La vitrine appelle UNE route de l'API** (2026-09-30) : son formulaire de contact (`site/contact/`) poste
`POST /vitrine/contact` en formulaire HTML natif, et la route répond par une redirection 303 vers la vitrine, donc
aucun CORS. Chaque adresse est écrite en dur chez l'autre : `api.messagingme.app` dans `site/contact/index.html`, la
vitrine dans `VITRINE` (`src/http/contact-vitrine.ts`). Renommer l'une casse le formulaire sans erreur ailleurs, et
une page qui poste vers une route pas encore déployée aussi : l'API se déploie AVANT la vitrine.

⚠️ **Le référencement de la vitrine tient à des fichiers à tenir à jour** (2026-09-30) : `site/sitemap.xml`
(l'accueil et chaque page indexable ; une page ajoutée y entre, une page `noindex` non), `site/robots.txt`,
`site/llms.txt`, et le bloc JSON-LD de chaque page (fil d'Ariane, fiche du film). `site/vercel.json` redirige
`engageme-site.vercel.app`, `/index.html` et les adresses sans barre finale vers l'adresse canonique.

⚠️ **Les images et les films de la vitrine restent un jour en cache chez le visiteur** (2026-10-08) :
`max-age=86400` plus une semaine de `stale-while-revalidate` sur `/img/` et `/films/` (`site/vercel.json`). Un
fichier remplacé sous le MÊME nom prend donc un `?v=` incrémenté dans chaque page qui le cite, sinon qui l'a déjà vu
garde l'ancien (vécu : les films des pages, repassés en Messaging Me, montraient encore Engage Me). Au téléphone
(moins de 640 px), `site.js` met à la place d'un film sa version 9:16 désignée par `data-vertical` et
`data-affiche-verticale`. Les films se fabriquent dans `~/engageme-motion` (son `CLAUDE.md`).

🔴 **L'IGNORED BUILD STEP DE LA VITRINE NE DOIT JAMAIS FINIR EN ERROR, et il vit dans `site/vercel.json`**
(2026-09-26). `VERCEL_GIT_PREVIOUS_SHA` est le SHA du dernier déploiement READY (un CANCELED ne l'avance pas),
et Vercel clone en profondeur 10 SANS aucun remote, mesuré. Dès dix commits sans changement dans `site/`, ce SHA
sort du clone : l'ancienne commande (`git diff` nu) rendait 128 et chaque push finissait en ERROR, sept de suite.
La commande va chercher ce commit sur l'URL PUBLIQUE du dépôt (pas `origin`, qui n'existe pas) et construit sur
toute autre issue qu'un diff vide. ⚠️ Le réglage du tableau de bord garde l'ancienne commande : `vercel.json`
prime, il est sans effet (le connecteur Vercel n'a pas le droit d'écrire ce réglage, 403). ⚠️ Si le dépôt
redevient privé, le fetch échoue et la vitrine se redéploie à l'identique une fois tous les dix commits.

🔴 **`/mcp` REND 404 SUR `engageme.messagingme.app`** (mesuré le 2026-09-25 ; `api.` et `mba.` rendent 401) :
toute adresse MCP donnée à un intégrateur se dérive de `BASE` (l'API), jamais du domaine de la console.

⚠️ **`mba.messagingme.app` porte un routage par CHEMIN dans NPM** (`advanced_config` du proxy host 21), et
c'est ce qui rend la migration sans risque : `/api/backend/*` va à `mba-api` **avec le préfixe retiré par
nginx**, `/r/`, `/m/` et `/mcp` y vont directement, tout le reste va à `mba-web`. Conséquences :
- **le webhook Meta répond à son adresse ACTUELLE, pour toujours**, sans rien reconfigurer chez Meta ;
- les liens tracés et visuels RCS déjà envoyés continuent de résoudre ;
- 🔴 **un conteneur de FRONT n'est plus sur le chemin critique de réception des messages clients**. Avant,
  le webhook de Meta traversait `mba-web` : si le site tombait, plus aucun message entrant n'arrivait.

⚠️ **`NEXT_PUBLIC_API_URL` est FIGÉE AU BUILD** côté Vercel : la changer sans redéployer ne fait rien, en
silence. Même piège que `BACKEND_URL` sur l'image Docker.

🔴 **UN ÉCRAN QUI APPELLE UNE ROUTE NEUVE CASSE DÈS LE PUSH, PAS AU DÉPLOIEMENT** (2026-09-21). Vercel publie
la console à chaque `git push`, l'API attend sa revue finale et son `up -d --build` : entre les deux, l'écran
appelle une route que la production n'a pas. Vécu avec l'onglet « Outils » de l'agent de Meta, en 404 en
production pendant plus d'une heure, pour un espace qui avait des outils publiés et à qui l'écran disait
« Aucun outil ». La parade : pousser l'écran APRÈS le déploiement de l'API qui porte sa route, ou le faire
tolérer l'absence de la route ; sinon, dire la fenêtre dans le plan et la réduire (revue finale et
déploiement dans la foulée).

🔴 **AUCUNE GARDE MÉCANIQUE NE BLOQUE UN DÉPLOIEMENT, et c'est décidé** (Julien, 2026-09-24). Le hook
`~/.claude/hooks/deploiement-garde.js` (et sa configuration `.claude/deploy.json`) existe mais n'est branché
dans AUCUN `settings.json` : il n'a jamais rien bloqué, et il reste débranché. Cette page a longtemps décrit ce
qu'il « couvrait » ; c'était faux. Ce qui tient l'ordre, c'est la discipline : une relecture par lot (un rouge =
ce qui casse la production), la CI lue avant le `up`, la migration AVANT le code qui la lit.

🔴 **TROIS PIÈGES DE LA RECHARGE STRIPE (2026-09-29).**
- `STRIPE_SECRET_KEY` et `STRIPE_WEBHOOK_SECRET` se posent ENSEMBLE ou pas du tout : une seule des deux fait
  REFUSER le démarrage de l'API. Les deux sont posées par Julien dans `.env.prod`, jamais par Claude.
- Une migration qui touche `agent_credit_mouvements` bloque TOUT mouvement de crédit, donc chaque débit de tour
  d'agent dans le WORKER : elle passe AVANT le `up` des DEUX conteneurs (vécu avec 0193, colonne nommée par
  l'insertion commune `bouger`).
- Un override dans `.env.prod` (`CREDIT_OFFERT_MICRO_EUR=0`) coupe une offre sans déployer de code : c'est ainsi
  que les 5 € ont été éteints entre la relecture qui les a jugés récoltables et le correctif. Le retirer ensuite,
  sinon le défaut du code ne s'applique jamais.

Runbook VPS complet + checklist live : [DEPLOY.md](DEPLOY.md). **LIVE (`DRY_RUN=false`)**, numéro Zadarma réel.
Auth **JWT (login)** + **RBAC** (écritures réservées aux admins).

⚠️ **Migrations NON auto-appliquées** : toute migration qui ajoute une colonne écrite par le code doit
passer sur le VPS AVANT le déploiement (`sudo REVISION=$(git rev-parse --short HEAD) docker compose build mba-api` puis
`sudo docker compose run --rm --no-deps mba-api npm run migrate`, PUIS `up -d --build` avec la même `REVISION`, `DEPLOY.md`).

🔴 **LE COMPTEUR TIENT EN UNE LIGNE, ET IL N'EST ÉCRIT QU'ICI.** Ailleurs, un POINTEUR vers elle : trois documents
l'avaient recopié, les trois étaient faux. Elle se met à jour DANS le commit qui prend le numéro, et se relit après
`migrate`. **Le DOSSIER tranche sur ce qui est PRIS, la BASE sur ce qui est APPLIQUÉ** (`select name from
public.schema_migrations order by name desc`, qualifié `public.` : plusieurs schémas portent une table de ce nom).

**Dernière appliquée : 0227** (`oauth_autres_clients`, le 2026-10-09 à 15 h 48 UTC). **Prochaine libre = 0228.** Le
dossier a deux trous voulus : 0153 (réservé, jamais écrit) et 0060 (appliquée sans fichier : l'ancien nom de
`0062_email.sql`, même SQL, sans conséquence, vérifié le 2026-10-03).

Le récit de chaque migration (0093 à 0227 : ce qu'elle a coûté, ce qu'elle a appris, comment elle a été relue) vit
dans [docs/JOURNAL-TECHNIQUE.md](docs/JOURNAL-TECHNIQUE.md) § « Les migrations, une par une » ; il a quitté ce
fichier le 2026-10-10, où il occupait 820 lignes sur 1 391. Ce qui suit en est la règle.

🔴 **« Avant ou après le déploiement » se décide sur « l'ancien code survit-il ? », pas sur « ajoute ou retire ».**
Ajouter une colonne que le code écrit, relâcher une contrainte (`drop not null`, `drop constraint` d'une cascade) :
AVANT, sinon le chemin chaud échoue en boucle (`column ... does not exist` : 1 h 30 sans un message entrant enregistré
le 2026-08-17). Un `drop column` encore lu par l'ancien code, ou un CHECK qui exige ce que seul le code neuf
renseigne : APRÈS (0128 croyait « n'ajouter que » et a rendu onze tests rouges ; 0152 a laissé son CHECK strict à une
migration suivante). La question se pose à chaque fois plutôt que de suivre une routine.

🔴 **AVANT `migrate`** : construire l'image, puis vérifier DANS l'image que seules les migrations attendues seront
appliquées ; lire `pg_stat_activity` (aucune transaction longue, aucun verrou sur les tables touchées) ; poser un
`lock_timeout` de 5 s pour une clé étrangère ou un CHECK sur une table chaude.

🔴 **APRÈS `migrate`, RELIRE EN BASE POINT PAR POINT** : colonnes, types, nullabilité, défauts, contraintes sous leur
nom (`pg_get_constraintdef`), `confdeltype` des clés étrangères, prédicat EXACT des index partiels, `indisvalid` d'un
index construit `CONCURRENTLY` ; puis exécuter le chemin chaud PAR LE VRAI CODE, en lecture seule. Sans trafic, une
absence d'erreur dans les journaux ne prouve rien.

🔴 **Une migration que la purge RGPD ou un chemin chaud NOMME est bloquante** : poussée SEULE et appliquée avant que son
code n'arrive sur `main` (0163, 0201, 0218 ; une table absente fait échouer la purge entière en `42P01`).

⚠️ **Deux migrations d'ordre opposé poussées ensemble** : `migrate` applique tout ce que l'image contient. Mettre de côté
(`mv` hors du dépôt) celle d'après avant le build, le vérifier par `ls` dans l'image, migrer, déployer, puis la
remettre, reconstruire et migrer pour elle seule (0141, 0159).

⚠️ **Le nom d'une contrainte créée en ligne se LIT en base** avant un `drop constraint if exists` : un nom deviné laisse
l'ancienne en place, en silence (0122). **Un index partiel est un contrat avec UNE requête** : son prédicat reprend mot
pour mot son `where`, et élargir l'un sans l'autre ne produit qu'un balayage, sans erreur (0122, 0138, 0143).

⚠️ **Un retour arrière d'image se vérifie contre ce que les migrations appliquées depuis ont RESSERRÉ** : une image
antérieure à `2a6c2046` échouerait en 23502 à chaque création ou rattachement d'outil (0213, `tool_name` NOT NULL), il
faudrait d'abord `alter table agent_tool_consommateurs alter column tool_name drop not null`.

🔴 **Une migration peut être jouée HORS TRANSACTION** (`-- migrate: no-transaction` en tête, obligatoire pour
`CREATE INDEX CONCURRENTLY`). Elle n'a alors **aucun filet** : un échec à mi-parcours n'annule rien et la
migration est rejouée depuis le début, donc chaque instruction doit être idempotente. Le runner l'envoie
instruction par instruction, parce qu'une requête multi-instructions serait exécutée dans une transaction
implicite. `tests/migration-directives.test.ts` garde les deux sens de la règle sur les fichiers réels.

🔴 **Une seule exécution de `migrate` à la fois** (verrou d'avis Postgres, lot 8). Deux exécutions
simultanées (le conteneur du VPS et le poste de Julien pointent la MÊME base) rejoueraient la même migration.
La seconde est REFUSÉE tout de suite, avec le message qui le dit. ⚠️ Et `db/` est désormais dans
`tsconfig.include` : le runner n'était pas type-checké, une faute de syntaxe n'y devenait visible qu'à
l'exécution, en plein déploiement.

🔴 **Les migrations vivent DANS L'IMAGE, pas sur le disque du VPS** (`COPY db ./db`). Un `git pull` suivi de
`compose run ... npm run migrate` rejoue donc les ANCIENNES migrations sans rien signaler : il faut
`compose build` AVANT. C'est pour ça que la séquence commence par le build. (Vécu le 2026-08-21.)

🔴 **Les liens tracés sont une porte à SENS UNIQUE.** Dès qu'un template portant un lien `/r/<code>` est
approuvé et **envoyé**, son adresse circule dans des messages livrés. Retirer la route `/r/:code`, la table
`tracked_links` ou le rewrite Next les casserait **tous**, sans recours possible. Le retour arrière n'existe
qu'avant le premier envoi tracé.

## Docs du repo (séparation stricte)

**Les fichiers de doc**, et ce qu'on y met : [documentation.md](documentation.md) le MANUEL technique de ce
qui est VRAI aujourd'hui (topologie, domaines, flux, invariants) · [docs/JOURNAL-TECHNIQUE.md](docs/JOURNAL-TECHNIQUE.md)
l'ARCHIVE des livraisons, incidents et mesures · [features.md](features.md) le fonctionnel vu utilisateur ·
[wip.md](wip.md) ce sur quoi on bosse MAINTENANT · [todo.md](todo.md) le backlog · et ce fichier, qui reste le
point d'entrée LÉGER.

🔴 **LE MANUEL ET L'ARCHIVE ONT ÉTÉ SÉPARÉS LE 2026-09-09, et la règle qui les sépare est TEMPORELLE.**
`documentation.md` faisait 5 576 lignes dont 61,6 % de journal, et sa partie « courante » contenait cinq
affirmations vérifiablement fausses (hébergement, compteur de migrations, rôles, rétention des webhooks,
nombre de files). Le journal est parti VERBATIM dans l'archive, qui ne fait jamais autorité sur le présent.
Ce qui ne doit plus JAMAIS entrer dans le manuel : un compteur calculable (files, tests, migrations), un titre
`DÉPLOYÉ` / `LIVRÉ` / `PROCHAINE ÉTAPE` / `RESTE À FAIRE`, le récit d'un bug (seul l'invariant qu'il révèle
reste), ou un détail de `DEPLOY.md`. La § « Gouvernance documentaire » du manuel porte la règle complète.

🔴 **LES AUDITS ONT QUITTÉ LE DÉPÔT LE 2026-09-23, ET ON LIT LE BILAN À LEUR PLACE.** Ils décrivent des
faiblesses, dont certaines encore ouvertes, avec le scénario pour les exploiter ; le dépôt est PUBLIC depuis le
2026-09-15. Les quatorze groupes d'audits (2026-07-18 au 2026-09-21) vivent donc dans `docs/prive/`, non
versionné, et **`docs/prive/BILAN-AUDITS-2026-09-22.md` les remplace à la lecture** : 389 constats, 130 faits,
46 écartés par une décision écrite, le reste ouvert, avec l'ordre des lots validé par Julien et, en annexe,
chaque point restant et son statut. Un audit ne se lit plus que pour comprendre une décision précise.
⚠️ Ils restent dans l'HISTORIQUE git : ce déplacement ne porte que sur l'état courant, comme pour l'adresse
d'origine du VPS. La parade durable est côté serveur, jamais documentaire.

**Le seul plan encore dans le dépôt** : [PLAN.md](PLAN.md), les deux programmes terminés le 2026-09-01. Le
backlog vit dans `todo.md`, le récit daté dans `docs/JOURNAL-TECHNIQUE.md`.

⚠️ **Cette section annonçait « sept lots, aucun commencé » jusqu'au 2026-09-04**, alors qu'ils étaient déployés
depuis deux jours. Un pointeur qui décrit un ÉTAT vieillit ; un pointeur qui dit seulement OÙ EST QUOI, non.

## Règles spécifiques au projet

- **Construction par briques via `feature-loop`** : une boucle par brique testable (voir
  `todo.md`). Le scaffold + le schéma DB sont posés en direct ; les briques déterministes
  (receiver, wrapper API, contacts, campagnes) passent par des boucles plan → exécute →
  vérifie → reviewer. L'UI (inbox/dashboard) n'est PAS pour feature-loop.
- **On vérifie contre des mocks des contrats Meta + des tests** (unitaires + intégration Supabase), jamais
  contre le Meta live : la production ENVOIE VRAIMENT depuis le 2026-07-06 (`DRY_RUN=false`, numéro Zadarma).
  ⚠️ Cette ligne a dit « tant qu'on n'a pas de numéro branché » pendant deux mois après la mise en service.
- **Pas de tirets longs** dans la doc : ni cadratin ni demi-cadratin, on met une virgule, deux-points,
  des parenthèses ou un point. (Cette règle avait perdu son propre exemple, remplacé par deux `:` identiques
  qui ne montraient plus rien.)
- 🔴 **Un `Pick<T, ...>` recopié pour être RETRANSMIS est une liste à tenir alignée à la main, et elle dérive.**
  Vécu en production le 2026-09-02 : deux capacités câblées dans le worker, absentes du contrat, donc jamais
  vues par le moteur, et toutes les campagnes à lien tracé échouaient en 131008. Les capacités voyagent depuis
  dans un objet IMBRIQUÉ transmis d'un seul spread. ⚠️ Un `Pick` reste bon quand ses membres sont CONSOMMÉS sur
  place (l'oubli est alors une erreur au point d'usage) : 13 des 14 `Pick` du dépôt sont dans ce cas. Le critère
  n'est pas le `Pick`, c'est « est-ce recopié pour être retransmis ? ».
  🔴 **Et le contrôle des propriétés en trop NE TRAVERSE PAS un spread.** Mesuré, quatre formes, quatre
  résultats : littéral direct → TS2353 ; spread → **rien** ; `satisfies` EXTÉRIEUR → **rien** ; `satisfies` sur
  l'objet INTÉRIEUR du spread → TS2561. Un câblage qui construit ses dépendances par spread n'a donc AUCUNE
  garde tant qu'on ne la pose pas sur le spread lui-même (`src/worker.ts`, tenu par
  `tests/campagne-cablage.test.ts`). Même famille : une flèche à deux paramètres est assignable à un contrat
  qui en déclare trois, et le troisième est avalé en silence.
- **Avant d'écrire un helper, regarder s'il existe déjà.** L'audit du 2026-08-18 a supprimé une centaine de
  copies de fonctions que le repo possédait déjà (dont `scopeTenant`, le contrôle d'accès tenant, présent dans
  22 fichiers de routes). Les points de passage obligés sont listés dans `documentation.md` (« Modules
  partagés ») : un fragment SQL, une classe Tailwind ou une normalisation de texte s'y importe, ne se recopie pas.
- Git : rester sur `main`, committer sur `main`, push `origin`.
- 🔴 **TROIS ANNONCES ENTRE SESSIONS QUI PARTAGENT CET ARBRE** (2026-09-23) : avant d'éditer un fichier de
  CÂBLAGE partagé (`src/index.ts`, `src/server.ts`, `src/worker.ts`), avant un `git checkout -- ` dessus, et
  avant une suite e2e. Un message, pas de verrou. ⚠️ La deuxième est celle qu'on oublie : un
  `git checkout -- <fichier>` ÉCRIT dans l'arbre de l'autre, n'apparaît pas comme une modification et ne
  laisse aucune trace de commit. Vécu ce jour-là : le geste qui a débloqué un pair le matin lui a fait
  perdre vingt lignes l'après-midi, et son `git commit --only` a ensuite commité le travail d'en face.
  `main` est resté rouge dix minutes. ⚠️ Corollaire : `--only` ne protège que si le CONTENU du fichier est
  encore le sien, donc `git diff <ses chemins>` juste avant de commiter.
- 🔴 **UNE QUATRIÈME ANNONCE : MUTER UN FILTRE D'ISOLATION** (2026-09-23). Vérifier un test de
  non-régression dans les deux sens reste obligatoire, mais sur un filtre `tenant_id` cela laisse, le temps
  de la mesure, un arbre PARTAGÉ d'où une fuite entre clients partirait si quelqu'un construisait une image.
  Vécu ce jour-là : `c.tenant_id = $1` retiré dix minutes de `session-store.pg.ts`, plus un `.bak` non
  ignoré. Rien n'en est sorti parce que le VPS construit depuis son propre `git pull`, donc par chance et
  non par conception. La mutation se fait, elle s'annonce, et la restauration se vérifie par comparaison
  avec `origin` plutôt qu'à l'œil.
- 🔴 **LE HOOK `rayon-de-souffle` AGRANDIT LA FENÊTRE QU'IL AIDE À SURVEILLER** (2026-09-23), et c'est la
  cause EXACTE de l'incident du soir. La séquence sûre est « je lis `git diff`, je commite » ; le hook
  refuse le premier commit pour faire relire sa liste, donc la séquence devient « je lis le diff, j'attends,
  je relance sans relire ». L'arbre partagé change entre les deux. Une session a ainsi emporté la ligne de
  câblage d'une autre dans son `--only`, et `main` n'a plus compilé. **Parade qui ne dépend d'aucun
  timing** : pour un fichier de CÂBLAGE PARTAGÉ, on ne commite pas en `--only`, on construit le commit en
  PLOMBERIE (`GIT_INDEX_FILE` temporaire hors du dépôt, `git read-tree origin/main`, puis SON diff en patch :
  `git diff HEAD -- <ses chemins> > lot.patch` et `git apply --cached --3way lot.patch`, `git write-tree`,
  `git commit-tree -p origin/main`, `git push origin <sha>:main`). Ni l'index partagé ni l'arbre sur disque
  ne sont touchés, et le commit ne peut PAS emporter ce qu'on n'a pas nommé.
  🔴 **Jamais `git hash-object` sur un fichier de l'arbre : l'arbre peut être EN RETARD sur origin**
  (2026-09-26). Un pair qui pousse depuis un worktree laisse l'arbre sans son commit ; un blob reconstruit
  depuis l'arbre aurait défait le correctif STOP (738a7c3d) dans `features.md` et `contact-store.pg.ts`. Le
  patch, lui, s'applique sur la version d'origin, et un vrai conflit échoue au lieu d'écraser.
  ⚠️ Corollaire pour le reste : après un refus du hook, on relit son `git diff` AVANT de relancer.
- 🔴 **DEUX DÉFAUTS DISTINCTS DE L'E2E, LONGTEMPS PRIS POUR UN SEUL** parce que leurs symptômes se
  suivent. Les séparer est ce qui évite de chercher au mauvais endroit.
  **`ENOENT` sur un fichier de `.next` : DEUX BUILDS SIMULTANÉS** (2026-09-23, revécu trois fois le
  2026-09-24, chaque fois avec confirmation du voisin). La sortie est `rm -rf web/.next`. Le symptôme accuse
  le code, et c'est ce qui fait chercher ailleurs.
  **« Timed out waiting 180000ms from config.webServer » : LE `webServer` REFAIT UN BUILD COMPLET**, quelle
  que soit la concurrence (mesuré le 2026-09-24 sans aucun voisin, après trois builds perdus à chercher du
  côté de `.next`). Il lance `npm run build && npm run start`, donc un `next build` entier, qui ne tient pas
  dans ses 180 s même avec un cache chaud : **préconstruire à la main n'y change RIEN**, Playwright rebuild
  quand même. La sortie est de **démarrer le serveur SOI-MÊME**
  (`cd web && NEXT_TELEMETRY_DISABLED=1 BACKEND_URL=http://127.0.0.1:9 NODE_ENV=production sh -c 'npm run
  build && npm run start'`, l'environnement étant celui de `playwright.config.ts`), puis d'attendre que le
  port 3000 réponde : `reuseExistingServer` vaut `!CI`, donc hors CI Playwright RÉUTILISE ce serveur et la
  suite part en quelques secondes. ⚠️ Penser au bundle : `next start` sert `.next`, donc après une mutation
  il faut tuer le serveur, reconstruire et le relancer, sinon on mesure l'ancien code.
  ⚠️ **ET LE VERDICT SE LIT DANS LA SORTIE, PAS DANS `$?`.** Ce timeout a été observé avec un code de
  sortie à 0, mais la commande passait par `| tail` : le 0 était celui du PIPE et ne dit rien de Playwright.
  L'affirmation « `playwright test` rend 0 sur ce timeout » n'est donc PAS établie, et elle a été retirée
  d'ici. Ce qui reste vrai suffit : **un `| tail` masque le code de sortie de ce qui précède**, mesuré le
  même jour sur `tsc`, où un « code 0 » annonçait un typecheck en échec.
- 🔴 **`gh run list` AVANT tout déploiement**, au même titre que `git log <déployé>..HEAD`. Un `npm test`
  vert en local ne prouve que la moitié : les tests d’intégration ne tournent qu’en CI, sur un Postgres
  jetable. Déployer sans avoir regardé le run, c’est déployer sans avoir vu la moitié des tests.
  🔴 **Et `gh run watch --exit-status` MENT : il a rendu 0 sur un run EN ÉCHEC** (2026-09-07). S'y fier
  aurait envoyé en production du code dont les tests d'intégration échouaient. Le verdict se lit sur
  `gh run view <id> --json jobs`, job par job, jamais sur le code de sortie du watch.
  ⚠️ **LA CI EST DÉCOUPÉE EN DEUX WORKFLOWS, et l'asymétrie est voulue** : `ci-web.yml` ne part que sur `web/**`, `ci.yml`
  garde un `paths-ignore` et jamais un filtre positif, parce que des tests de la racine LISENT `web/`
  (`tests/ci-decoupage.test.ts`). ⚠️ Un job `integration` ou `securite` rouge sur `toomanyrequests` (Docker Hub refuse
  le tirage anonyme) n'a RIEN vérifié : relancer, ne jamais déployer sur ce rouge-là ni le lire comme un succès.
  ⚠️ Un push qui ne touche QUE des `.md` ne déclenche AUCUN run (`paths-ignore`, pour le quota) : l'absence
  de run sur `HEAD` n'est donc pas un échec, c'est le dernier commit DE CODE qu'il faut regarder.
  🔴 **ET CE PUSH-LÀ PEUT QUAND MÊME CASSER LA CI DU SUIVANT** : `tests/aide-proposer.test.ts` lit les sections de
  `features.md` dont les fiches d'aide (`docs/aide/fiches/`) portent l'empreinte. Toute retouche de `features.md`
  se vérifie par ce test AVANT de pousser, la fiche relue et son empreinte dans le MÊME commit, et le push ne part
  que sur ce test vert (`&&`, jamais `;`). Vécu deux fois (2026-09-30 et 10-01) : le job `unit` d'un pair est devenu
  rouge sur un commit qui n'y était pour rien.
- 🔴 **QUI PAIE QUOI, ET TOUT N'EST PAS SUR LA MÊME CLÉ.** La **traduction** des conversations
  (`TRADUCTION_MODELE`, `google/gemini-2.5-flash`) et les **tours d'agent** tombent sur le **crédit prépayé
  du client** : ils passent par `gateway`, celui qui porte le résolveur de clé PAR ESPACE. Depuis le lot 6 (C), le
  crédit du client paie AUSSI, mais l'appel part sur NOTRE clé et son coût est débité : la **recherche** dans la
  connaissance (ajoutée au tour), la **vectorisation** de ses fiches et la **transcription** d'un vocal de l'Inbox (la
  décision du 2026-09-09, « on le paie nous-mêmes », est remplacée par la spec du lot 6). Sur **notre** clé
  maison et à nos frais (`gatewayAide`, construit SANS résolveur) : le **bot d'aide** de la console, la transcription
  du pont des codes, et depuis le 2026-09-14 les **DEUX assistants de configuration** (Meta Business Agent et agent
  IA) : facturer quelqu'un pour apprendre à se servir du produit se retourne contre nous. Cet écart ne se « corrige » pas.
  🔴 **ET CE QUI EST SUR NOTRE CLÉ DOIT PORTER UN PLAFOND, SANS EXCEPTION.** Sur le crédit du client, un
  bavardage se paie tout seul ; sur le nôtre, rien ne le borne. `ASSISTANT_PLAFOND_EUROS_MOIS` (défaut 2 €)
  est compté PAR ESPACE et PARTAGÉ par les deux assistants (`assistant_depense_mois`, migration 0146) ;
  0 le désactive. ⚠️ Il a été câblé sur UN SEUL des deux pendant tout le chantier, alors que le commentaire
  du câblage annonçait lui-même que « les deux moitiés vont ensemble » : relevé par la revue finale du
  2026-09-15, gardé depuis par `tests/agent-setup-evolution.test.ts`.
  🔴 **CE QUI TOMBE SUR LE CRÉDIT DU CLIENT EST DÉBITÉ AU PRIX CLIENT, ET PAR UN SEUL CALCUL** (2026-09-28) :
  `prixClientMicroEur` (`src/agent/devise.ts`), coût du Gateway majoré de la commission de l'OFFRE de l'espace
  (`commissionPour`, `src/offres/commission.ts`, 50 % en Base et 10 % en Pro et en Entreprise depuis le lot 6), la même
  commission que le tarif affiché. Le cerveau de l'agent (tour et bac à sable) et la traduction l'importent ;
  `microEurosDepuisDollars` (coût brut) ne sert qu'à NOTRE dépense, les deux assistants, et
  `tests/agent-devise.test.ts` la refuse ailleurs. La traduction usait la clé du client SANS rien inscrire au
  solde jusqu'à ce jour : elle est désormais gardée par le solde (> 0), débitée, agrégée en une ligne de
  journal par jour (migration 0190), et ouvre la clé de l'espace à sa première traduction
  (`creerAssureurDeCle`, SANS que le GET du fil l'attende : une ouverture en vol par espace). ⚠️ Le plafond Vercel reste le cumul acheté au coût BRUT : notre solde mord avant lui.
  🔴 **LE CRÉDIT ENTRE PAR TROIS PORTES, ET LE PLAFOND VERCEL SUIT LES TROIS** (2026-09-29) : l'**achat** Stripe
  (webhook signé, une fois par session, `src/http/credit-stripe.ts`, migration 0191), la **recharge** manuelle
  (`/ops`), et le crédit **offert** (`CREDIT_OFFERT_MICRO_EUR`, 5 € par défaut) à la connexion du PREMIER numéro
  WhatsApp, dans la transaction de `linkTenant`, une fois par espace et jamais deux fois pour un numéro
  (`credits_offerts`). Plus à la création d'un espace : sans preuve, l'offre s'y récoltait par script et vidait le
  plafond d'équipe Vercel. Chaque porte appelle `remonterPlafondApresRecharge` après sa transaction.
  ⚠️ `TRADUCTION_MODELE` vide = traduction ÉTEINTE, et l'écran le dit avec la cause `instance` (rien à
  faire côté client) plutôt qu'en parlant d'un crédit qui n'est pas en cause. Les autres causes :
  `credit` (épuisé, recharger règle), `credit_insuffisant` (positif mais sous le minimum d'une clé, environ
  0,92 €), `cle_en_preparation` (la clé s'ouvre, quelques secondes) et `cle` (l'espace a du crédit, sa clé n'a
  pas pu s'ouvrir, ou elle est illisible en base).
- **La console a trois rayons, deux largeurs, une modale, une famille d'icônes** (refonte visuelle, 2026-09-25).
  `tests/web-formes.test.ts` et `tests/web-icones.test.ts` refusent le reste. Un e2e qui confirmait par
  `page.on('dialog')` passe par `e2e/aide/confirmation.ts`.
- **Discipline anti-tailor-made** : inbox minimal borné, pas de multicanal/segments avancés/A-B testing.
  (Un **constructeur de Flow** riche EXISTE désormais, cf `features.md` : formulaires de collecte, pas un
  workflow builder générique.)
- 🔴 **TOUTE BORNE QU'ON APPLIQUE À LA SORTIE D'UN MODÈLE EST ANNONCÉE DANS LE SCHÉMA QU'ON LUI ENVOIE**
  (2026-09-17). Deux schémas coexistent dès qu'on impose une sortie structurée : celui qu'on ANNONCE et celui
  qu'on APPLIQUE. Ce que le second refuse sans que le premier l'annonce est une panne qu'AUCUNE coopération
  du modèle ne peut éviter. Mesuré sur l'assistant de construction : **31 bornes sur 31** appliquées par Zod
  sans qu'aucune ne figure dans le schéma envoyé, et un code de règle d'arrêt de 36 caractères (la regex
  plafonne à 32, nombre écrit nulle part ailleurs qu'en elle) faisait perdre le dernier tour de l'entretien,
  message du client compris. ⚠️ **La parité se DÉRIVE, elle ne se relit pas** : le test de miroir qui existait
  comparait des NOMS DE CLÉS et n'a rien vu pendant des semaines. `tests/agent-setup-bornes.test.ts` extrait
  les bornes de Zod et exige que le schéma annoncé les porte toutes.
- 🔴 **L'HYGIÈNE SE RAMÈNE, LA FRONTIÈRE SE REFUSE, et les confondre coûte du travail client** (2026-09-17).
  Dans une validation de sortie de modèle, la FRONTIÈRE DE SÉCURITÉ est la **liste des clés** (ce que le
  modèle a le droit de proposer) et les **énumérations fermées** (le catalogue de handlers) : elles restent
  fatales. Une longueur, un alphabet de slug, un doublon sont de l'HYGIÈNE : ils se RAMÈNENT
  (`assainirProposition`), parce que tout ce qui passe est de toute façon relu par un humain dans un diff.
  ⚠️ **Sauf quand un champ est REMPLACÉ et non fusionné** : une liste dont plus rien ne survit doit
  DISPARAÎTRE, pas devenir une liste vide, sinon l'assainissement fabrique une proposition d'effacement à
  partir de bruit. Vu en revue sur le correctif lui-même, sur `fiche.sorties`.

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
- 🔴 **AVANT DE COMMITER, ÉNUMÉRER LES DÉPENDANTS DE CE QU'ON A CHANGÉ** (2026-09-04). La seule des règles de
  ce bloc qui soit VÉRIFIABLE de l'extérieur : Julien peut réclamer la liste. Pour chaque symbole, constante ou
  requête touchée : qui la LIT, qui suppose son ancienne valeur, quelle constante d'un AUTRE fichier doit lui
  rester ordonnée, quel index la sert, quel commentaire l'affirme. Le hook `rayon-de-souffle.js` en calcule la
  moitié mécanique au `git commit` ; la section « Rayon de souffle » de `/revue` couvre le reste. Quatre
  corollaires, tous CONSTATÉS : **(a)** un test qui touche le réseau n'est pas un test unitaire ; **(b)**
  réécrire un test doit CONSERVER le cas qu'il exerçait, même mal asserté ; **(c)** corriger un compte à un
  endroit et le laisser à trois autres, c'est le laisser faux ; **(d)** une justification placée APRÈS ce
  qu'elle justifie est orpheline. Le détail : `documentation.md` § lots des 3 et 4 septembre.
- 🔴 **ÉLARGIR LE DOMAINE D'UNE RÉPARATION SANS ÉLARGIR CE QU'ELLE TRANSPORTE** (2026-09-03). Quand on élargit
  ce qu'une réparation RAMASSE, on relit tout ce qu'elle SUPPOSAIT de ce qu'elle ramassait : une valeur en dur
  juste sur l'ancien domaine devient fausse sans que rien ne le signale, et un **index PARTIEL est un contrat
  avec une requête précise**, dont sortir ne produit qu'un plan d'exécution différent. Trois instances la même
  semaine, aucune visible du compilateur.
- 🔴 **UNE REPRISE AUTOMATIQUE NE VAUT MIEUX QU'UNE REPRISE EXISTANTE QUE SI ELLE PRODUIT LE MÊME ÉTAT FINAL**
  (2026-09-03). Avant d'uniformiser un chemin sur ses voisins, comparer les ÉTATS FINAUX, pas les mécanismes.
  `src/agent/escalade.ts` est le seul couple « clore puis sortir » à ne PAS préserver la marque, et c'est
  délibéré : la raison est écrite dans le fichier, ne pas l'aligner par réflexe.
- 🔴 **UNE TRANSITION TERMINALE FAITE DE DEUX ÉCRITURES DOIT LAISSER, ENTRE LES DEUX, L'ÉTAT QUE SON
  RÉPARATEUR SAIT RECONNAÎTRE** (2026-09-03). **La réparation passe par la MARQUE, pas par l'ordre**, et c'est
  le piège : inverser l'ordre paraît plus sûr et peut être FAUX (ici, faire sortir le parcours le fait AVANCER
  pendant que la session est encore vivante). Donc : on écrit d'abord, on LAISSE la marque tant que la suite
  reste due, on l'efface une fois la suite passée. Deux corollaires : **la réclamation d'un balayage POSE UN
  BAIL, elle n'efface pas la marque** (sinon le réparateur reproduit chez lui le défaut qu'il répare) ; et
  l'effaceur de chaque chemin porte une garde MIROIR, pour que deux chemins concurrents ne s'effacent pas la
  marque l'un de l'autre. Le récit complet : `documentation.md` § lots des 3 et 4 septembre.
- **Une garde de validation se calcule sur l'état EFFECTIF après écriture** (`patch ?? courant`), jamais sur le
  corps de la requête : sinon elle ne ferme qu'un sens (cf. la garde anti-boucle de « conversation analysée »).

### Sécurité (deltas projet)

🔴 **`scopeTenant` ÉCHOUE FERMÉ** (2026-09-03). C'est LE contrôle d'isolation entre clients, et la RLS est
contournée (pooler superuser). Depuis le lot 3 de l'audit ponytail (2026-09-26), il n'est plus recopié dans les
handlers : `etapeEspace` (`src/http/scope.ts`) le pose AU MONTAGE, après la garde d'authentification, sur chaque
route `:tenantId` d'un module `tenant` (jamais `session-ops`), et le handler lit l'espace par `espaceVerifie(req)`,
qui échoue fermé si l'étape manque. La preuve est dynamique : `tests/scope-tenant.test.ts` appelle chaque route
d'espace avec une session d'un autre espace. Elle rendait auparavant le tenant PRIS DANS L'URL quand
`req.auth` était absent : elle n'était donc un contrôle que tant que la garde d'authentification avait été
posée au montage, dans un autre fichier, chaque module la recevant en paramètre OPTIONNEL et la dégradant en
silence. Ce n'était pas un trou vivant, mais la panne aurait été MUETTE.

🔴 **LA GARDE N'EST PLUS OPTIONNELLE NULLE PART (2026-09-15, lot 2 du même plan).** Les modules de routes la
déclaraient `guard?` ou `requireAuth?` (deux noms pour un rôle) et l'appliquaient par
`garde ? { preHandler: garde } : {}`, motif présent à **45 endroits** : une route montée sans garde était
servie SANS AUCUN CONTRÔLE. Elle est désormais REQUISE par le type, sous un seul nom (`garde`), et
`gardeEtendue` aussi, qui acceptait `undefined` et rendait alors des options vides pour sept modules. Quand
l'authentification n'est pas câblée, `buildServer` fabrique une garde qui **refuse**, jamais `undefined` :
c'est la différence entre « personne ne s'en sert » et « quelqu'un s'en sert et elle ne fait rien ».
⚠️ **Un type qui exige une garde ne dit pas qu'elle est POSÉE** : `tests/scope-tenant.test.ts` vérifie que
toute route portant `:tenantId` a un `preHandler`, et ce test a attrapé, pendant le lot lui-même, une route
dont les options s'écrivaient `{ ...garde, bodyLimit }` au lieu de `{ ...opts, bodyLimit }`, donc partie sans
garde. ⚠️ La garde « ouverte » des tests vit dans `tests/gardes.ts`, **jamais dans `src/`** : elle y serait
importable par le câblage de production.

🔴 **« A-T-IL DIT STOP ? » N'EST PLUS UNE DÉPENDANCE OPTIONNELLE (2026-09-15, lot 3 du même plan).**
`estDesabonne` était déclarée `estDesabonne?()` dans les QUATRE interfaces qui la consomment (scénario, agent
IA, Inbox, MCP) : absente, la garde ne tournait pas, et un câblage qui l'oubliait compilait, se déployait et
écrivait au contact qui avait répondu STOP. **C'est arrivé deux fois en 48 heures**, les 13 et 14 septembre.
Elle est requise ; les fixtures déclarent `jamaisDesabonne` (`tests/consentement.ts`), qui reproduit
exactement l'ancien comportement et DIT l'hypothèse au lieu de la cacher.
⚠️ **Trois fixtures mentaient au compilateur** (`as never`, `Record<string, unknown>`) : elles n'ont pas
échoué au typecheck mais au RUNTIME, avec `estDesabonne is not a function`. C'est la preuve, dans les deux
sens et sans l'avoir cherchée, que la garde s'exécute désormais là où elle était sautée.
🔴 **`optInAllows` RESTE DEHORS, et c'est mesuré** : deux appelants seulement, tous deux à la CONSTRUCTION
de la liste (campagne, API publique), quand `estDesabonne` se pose À L'ENVOI. Deux questions distinctes ;
les réunir ferait entrer une décision qui dépend du chemin dans une dépendance partagée (invariant §12.7).
⚠️ **`tests/optout-chemins.test.ts` est GARDÉ**, alors que le plan prévoyait de le remplacer : l'inventaire
couvre ce que le type ne peut pas voir, un CINQUIÈME chemin d'envoi qui ne déclarerait aucune des quatre
interfaces. Ce qui a été retiré, ce sont les cas qui affirmaient le défaut permissif disparu et les greps qui
vérifiaient un câblage que le compilateur impose (`npm run typecheck` tourne en CI).

🔴 **LA COUVERTURE DU GARDE-FOU NE S'ÉCRIT PLUS À LA MAIN, ELLE SE DÉRIVE (2026-09-14, lot 1 du plan
`docs/superpowers/plans/2026-09-14-dependances-non-optionnelles.md`).** `src/server.ts` porte un REGISTRE
(`modulesDeRoutes`) où chaque module de routes déclare sa classe d'accès, et le garde-fou filtre sur
`acces: 'tenant'`. Avant, c'était une seconde liste écrite à côté des montages, qu'il fallait penser à
allonger : elle a déjà couvert 18 modules sur 36, et un test relisait le TEXTE de `server.ts` avec sa PROPRE
copie de la liste, qui avait trois noms de retard. Mesuré avant de commencer : les 40 noms d'alors étaient
exacts, donc il n'y avait pas de trou vivant, le défaut était dans la FORME et il attendait le 41e module.
⚠️ **Ne recopiez pas de compte ici** : `tests/scope-tenant.test.ts` monte désormais chaque module tenant un
par un, et une parité compare la classe DÉCLARÉE aux adresses réellement montées par Fastify (les deux
mutations ont été vérifiées). La `ClasseDAcces` en compte **six**, pas deux : `tenant`, `anonyme`, `code-url`,
`signature-meta`, `signature-service`, `session-ops`. ⚠️ `session-ops` porte AUSSI des `:tenantId`
(`/ops/credits/:tenantId`) et c'est correct, l'exploitation est délibérément cross-espace.

🔴 **LE CORS EST EN LISTE BLANCHE ET SANS `credentials`, et les deux comptent.** `CORS_ORIGINS` refuse `*` AU
CHARGEMENT de la configuration. Et jamais `credentials: true` : la session voyage dans un en-tête
`Authorization`, jamais dans un cookie, donc **il n'y a aucun CSRF aujourd'hui** ; l'activer en créerait un de
toutes pièces. Vide = aucun en-tête CORS n'est posé du tout, ce qui est le bon défaut.

🔴 **LES ROUTES AUTHENTIFIÉES ONT UN PLAFOND DE DÉBIT, et 0 le désactive** (2026-09-07). Deux plafonds :
`RATE_LIMIT_USER_PAR_MINUTE` (défaut 300, clé = utilisateur, posé DANS `makeRequireAuth` donc hérité par les
36 modules gardés) et `RATE_LIMIT_COUTEUX_PAR_MINUTE` (défaut 10, clé = ESPACE) sur import, aperçu, action en
masse, purge, export d'historique, lancement de campagne, et les QUATRE routes lourdes de la connaissance d'un
agent (suppression en masse, import d'un document, aperçu et import d'un site, ajoutées le 2026-09-15). **Mettre l'une à 0 la désactive**, et c'est le
levier d'urgence : ces plafonds touchent toutes les routes authentifiées d'un produit en production, un mauvais calibrage
couperait la console de tous les clients, et un `--force-recreate` va plus vite qu'un déploiement de code.
⚠️ Le premier reste LOCAL À LA COPIE, délibérément (le plus fréquent : une écriture en base par requête de la console) ;
le second compte au TOTAL des copies depuis le lot B (2026-09-28, compteur `compteurs_debit`, migration 0186), comme
le plafond de l'API publique et ceux de la connexion. Ce qui compte où, et le comportement de chacun quand la base
ne répond pas : `documentation.md` § 7, les plafonds.

🔴 **`/ops` EST NOMINATIF, AVEC SECOND FACTEUR** (2026-09-28, plan `docs/superpowers/plans/2026-09-28-ops-nominatif.md`).
`OPS_TOKEN` n'existe plus, sans accès de secours : n'entrent que les adresses de `OPS_EMAILS` (vide = fermé pour
tous), par la connexion habituelle avec `ops: true`, PUIS leur second facteur (enrôlement obligatoire sans
facteur). Au bout, une session de portée `ops` de 12 h, qu'aucune route d'espace n'accepte (et une session
d'espace n'ouvre pas `/ops`). La garde (`makeRequireOps`) relit À CHAQUE REQUÊTE l'adresse de l'identité EN BASE
dans la liste et son facteur actif : retirer une adresse (puis `--force-recreate`) coupe l'accès tout de suite.
Chaque écriture signe sa trace de l'adresse de son auteur (`par`, `auteurOps`). La surveillance reste : au 5e
refus en 5 minutes, alerte Telegram throttlée à une par demi-heure, chaque refus journalisé, 🔴 **le jeton présenté
JAMAIS**. Le détail et ses trois remparts : `documentation.md` § 7.

⚠️ **L'API était DÉJÀ joignable depuis Internet avant `api.messagingme.app`** : le rewrite Next
`/api/backend/:path*` est un ATTRAPE-TOUT, `/ops` compris. Le nouveau nom n'ouvre rien, il rend les adresses
DEVINABLES. Corollaire : toute règle posée sur l'hôte `mba.` doit être redupliquée sur le nouveau, sinon elle
est simplement contournée.

🔴 **UNE URL SAISIE PAR UN CLIENT SE VÉRIFIE DEUX FOIS : sur son TEXTE, et sur ce vers quoi elle RÉSOUT.**
`urlRecuperable` lit le texte de l'hôte (elle refuse `localhost`, les littéraux privés et leurs formes
hexadécimale, entière, IPv6 et IPv4 mappée) ; `resolutionPublique` (`src/lib/adresse-privee.ts`) ferme ce
qu'un texte ne peut pas voir, un nom public dont l'enregistrement A pointe sur les métadonnées du fournisseur
ou sur le réseau Docker du VPS. Trois règles la rendent juste : **une seule adresse interdite condamne le
nom** ; **une résolution qui ÉCHOUE ou qui TRAÎNE est un REFUS** (plafond de 3 s, `dns.lookup` n'acceptant
aucun signal d'abandon) ; et une **plage d'adresses se compare en ARITHMÉTIQUE, jamais en préfixe de chaîne**
(le préfixe `fe80::/10` fait dix bits, pas quatre caractères).

🔴 **L'INVENTAIRE DE CES CHEMINS EST TENU PAR UN TEST, plus par cette page.** Elle a affirmé qu'il y en avait
TROIS ; il y en avait QUATRE, et le manquant était le seul non gardé. Un inventaire écrit à la main dérive dès
qu'on ajoute un bouton : `tests/lib-adresse-privee.test.ts` le vérifie à chaque exécution.

🔴 **ET L'ADRESSE SE REVÉRIFIE À L'OUVERTURE DE LA CONNEXION** (2026-09-21, le « DNS rebinding » est fermé).
La vérification ci-dessus et `fetch` faisaient DEUX résolutions : un DNS hostile pouvait répondre public à la
première, interne à la seconde. Tout appel HTTP vers une adresse saisie par un client passe par `fetchPublic`
(`src/lib/connexion-publique.ts`), dont le connecteur juge un littéral tout de suite et fait résoudre un nom
par un `lookup` qui refuse l'intérieur : la socket s'ouvre sur ce qui a été vérifié. Le SMTP d'une boîte
d'envoi, seul appel sortant qui n'est pas du HTTP, reçoit sa socket de nous (`getSocket`) : `ouvrirSocketPublique`
applique la même garde et laisse à nodemailer le nom d'hôte pour TLS. Le même test d'inventaire exige ces
branchements de chaque chemin, client MCP et SMTP compris. Chaque chemin HTTP rend le MÊME message au refus à
la connexion qu'à la vérification préalable (`estRefusAdresseInterne`) : c'est la même cause, vue plus tard.
⚠️ **`fetch` ET `Agent` viennent du MÊME paquet `undici`** : la production tourne en Node 22 (undici 6 embarqué),
le poste en Node 24 ; donner un `Agent` d'une version au `fetch` intégré d'une autre est le piège. ⚠️ Pour le
HTTP, la vérification préalable RESTE : elle donne un refus lisible avant l'appel, là où un refus à la
connexion ne remonte que comme une panne réseau. Le SMTP n'en a pas : son refus arrive à l'envoi, et le bouton
« Tester » le traduit (`estRefusAdresseInterne`).

🔴 **Un corps de réponse distante se lit EN FLUX** (`lireCorpsBorne`, `src/lib/corps-borne.ts`), jamais avec
`res.text()` suivi d'un test de taille : le corps entier entrerait en mémoire avant d'être jeté, et `.length`
compte des unités UTF-16, donc un corps d'idéogrammes passe un plafond « en octets » à trois fois sa taille.
Ses TROIS consommateurs doivent lire ses trois verdicts : `trop_gros`, `casse` (un flux coupé n'est pas un
corps vide, sans quoi on annonce un succès sur une lecture ratée) et le texte. ⚠️ Les clients de NOS API (Meta)
n'y passent pas : hôtes fixes et de confiance.

Le détail de ces trois lots, et la mesure qui a montré que cinq cas IPv6 sur huit passaient, sont dans
[documentation.md](documentation.md).

🔴 **CHANGER LE NOM DU FRONT CASSE TOUT TIERS QUI VÉRIFIE L'ORIGINE**, pas seulement ceux à qui on donne une
URL (2026-09-03). Un webhook se reconfigure parce qu'on lui a donné une adresse ; une liste d'origines se
reconfigure parce que le tiers vérifie D'OÙ VIENT L'APPEL. On pense au premier, on oublie le second. Découvert
par un `origin_mismatch` de Google à la première connexion depuis `engageme`. Les deux concernés, à compléter
SANS retirer l'ancienne origine : **Google Sign-In** (Cloud Console, « Origines JavaScript autorisées ») et
**Meta Embedded Signup** (Connexion Facebook, « Valid OAuth Redirect URIs » ET « Allowed Domains for the
JavaScript SDK », au format complet `https://.../`). HubSpot n'est PAS concerné, vérifié : son lien
d'installation se construit sur l'adresse du connecteur.

⚠️ **`APP_URL` NE FAIT PLUS DEUX MÉTIERS.** Elle servait à la fois de base aux liens d'e-mail (des pages du
FRONT) et aux adresses que le produit DISTRIBUE et qui sont servies par l'API (`/r/`, `/m/`, `/w/`). Depuis la
séparation du front et de l'API, `PUBLIC_API_URL` porte les secondes. Point de passage unique :
`src/lib/adresses-publiques.ts`, qui porte le cas particulier facile à recopier de travers (`/r/` et `/m/`
sont servis à la RACINE, `/w/` vit sous le préfixe du proxy). Les deux variables sont VIDES par défaut et tout
retombe alors sur l'ancien comportement : une variable dont l'oubli casse la production serait une mauvaise
variable, surtout sur des adresses déjà parties dans des messages.

Conventions génériques (secrets serveur, `.env` non committé, Zod `safeParse` sur webhooks + JSON LLM, signature de webhook entrant, entrée LLM délimitée) : section « Conventions de code » du CLAUDE.md global. Spécifique à MBA :

- **Isolation tenant = cas « accès médié par un serveur » du global** : `tenant_id=$1` sur CHAQUE requête. La connexion pooler est un rôle superuser, donc la RLS serait bypassée, le filtrage en code est le seul contrôle. IDOR = leçon convanalyzer.
- **Secrets serveur concrets** : `META_ACCESS_TOKEN`, `META_APP_SECRET` (signature webhook), `ENCRYPTION_KEY`, `AUTH_SECRET` (qui signe aussi les sessions d'exploitation), `service_role`, tous dans `src/`/worker/`.env.prod`, jamais dans le bundle `web/` ni en `NEXT_PUBLIC_*`.

### Gotchas et décisions

Le journal chronologique (gotchas Meta et décisions par lot) vit dans
[docs/JOURNAL-TECHNIQUE.md](docs/JOURNAL-TECHNIQUE.md), l'archive. Il a d'abord quitté ce fichier pour
`documentation.md`, puis `documentation.md` pour l'archive le 2026-09-09 : la même dérive, deux fois, et
c'est pour ça que le manuel porte désormais une règle qui l'interdit et un test qui la tient.
