# CLAUDE.md : messagingme-mba

**Produit : « Engage Me »** (renommé le 2026-09-03 ; le dépôt garde son nom technique
`messagingme-mba`, comme l'identifiant du serveur MCP, qui ne doit PAS changer sous peine de casser
les connexions déjà configurées). Console SaaS plug-and-play qui déploie et pilote la stack native
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

🔴 **TROIS NOMS DEPUIS LE 2026-09-03, et ils n'ont pas le même hébergeur.** Détail et journal d'exécution :
[docs/PLAN-BASCULE-VERCEL-2026-09-03.md](docs/PLAN-BASCULE-VERCEL-2026-09-03.md).

| Nom | Sert | Où | Comment on déploie |
|---|---|---|---|
| `engageme.messagingme.app` | la console | **Vercel** (projet `messagingme-mba`, Root Directory `web`) | automatique à chaque `git push` |
| `api.messagingme.app` | l'API et le worker | VPS Docker (`mba-api`, `mba-worker`) | `git pull` + `compose up -d --build` |
| `mba.messagingme.app` | l'ANCIENNE console, plus toutes les adresses historiques | VPS (`mba-web` + routage NPM) | idem |

⚠️ **`mba.messagingme.app` porte un routage par CHEMIN dans NPM** (`advanced_config` du proxy host 21), et
c'est ce qui rend la migration sans risque : `/api/backend/*` va à `mba-api` **avec le préfixe retiré par
nginx**, `/r/`, `/m/` et `/mcp` y vont directement, tout le reste va à `mba-web`. Conséquences :
- **le webhook Meta répond à son adresse ACTUELLE, pour toujours**, sans rien reconfigurer chez Meta ;
- les liens tracés et visuels RCS déjà envoyés continuent de résoudre ;
- 🔴 **un conteneur de FRONT n'est plus sur le chemin critique de réception des messages clients**. Avant,
  le webhook de Meta traversait `mba-web` : si le site tombait, plus aucun message entrant n'arrivait.

⚠️ **`NEXT_PUBLIC_API_URL` est FIGÉE AU BUILD** côté Vercel : la changer sans redéployer ne fait rien, en
silence. Même piège que `BACKEND_URL` sur l'image Docker.

Runbook VPS complet + checklist live : [DEPLOY.md](DEPLOY.md). **LIVE (`DRY_RUN=false`)**, numéro Zadarma réel.
Auth **JWT (login)** + **RBAC** (écritures réservées aux admins).

⚠️ **Migrations NON auto-appliquées** : toute migration qui ajoute une colonne écrite par le code doit
passer sur le VPS AVANT le déploiement (`sudo docker compose build mba-api` puis
`sudo docker compose run --rm --no-deps mba-api npm run migrate`, PUIS `up -d --build`).

🔴 **CE FICHIER EST LA SEULE SOURCE DU COMPTEUR. Ne le recopiez nulle part.** Au 2026-08-29, trois autres
documents le portaient, et les trois étaient faux : `PLAN.md` en retard de 43 migrations (croire sa ligne
menait à écrire par-dessus une migration existante), `brain/PROJECTS.md` de 15, `wip.md` de 5. Un compteur
recopié est un compteur qui dérive. Ailleurs, on met un POINTEUR vers cette ligne.

**Dernière appliquée : 0112** (la marque de tour d'agent en vol), passée le 2026-09-03, après 0108 à 0111.
**Aucune n'est en attente.**
🔴 **0112 est BLOQUANTE** : `prendreLeTour` écrit `tour_commence_le` à chaque tour, et c'est le chemin chaud du
bloc agent. Déployer sans migrer ferait échouer TOUS les tours. Appliquée AVANT, colonne et index vérifiés en
base, et le SQL du balayage joué à blanc contre la vraie table (0 ligne). ⚠️ Vérifié EN BASE le 2026-09-03
(`select name from public.schema_migrations order by name desc`) parce que cette ligne annonçait encore 0107 :
un compteur tenu à la main dérive dès qu'un déploiement se fait sans repasser par ici. **En cas de doute, la
base tranche, jamais ce fichier.** Et `schema_migrations` existe dans PLUSIEURS schémas de cette base : la
requête doit être qualifiée `public.`, sinon elle lit la table d'un autre outil et rend des colonnes inconnues.
⚠️ 0110 posait `create extension vector`, la première du dépôt à ajouter une EXTENSION, donc le seul point qui
pouvait échouer pour une raison de droits : il est passé sans incident.
**Prochaine libre = 0112.** En pratique on applique aussi via `npm run migrate` en local (même Supabase prod).

🔴 **0107 est BLOQUANTE, et elle CORRIGE la moitié RCS de la 0106, qui s'était trompée de clé.** La 0106
rattachait un lien RCS à la BIBLIOTHÈQUE de messages (`rcs_messages`). Or une campagne porte son message
EMBARQUÉ, un bloc de scénario aussi, et la réponse rapide convertie en RCS le fabrique à la volée : seul
l'envoi manuel depuis l'inbox passe par la bibliothèque. Cette clé aurait donc tracé le cas le moins utile et
laissé sans mesure les deux qui comptent. **La leçon vaut au-delà du RCS : une clé étrangère choisie sur le
schéma, sans avoir suivi les appelants réels, désigne la table qu'on a sous les yeux, pas celle qui produit la
donnée.** Corrigée pendant que la colonne était encore vide (0 ligne, vérifié en base) ; une semaine plus tard
il aurait fallu la migrer au lieu de la retirer.

⚠️ **0107 se relit comme une règle de canal.** La clé d'un lien WhatsApp (template, langue, carte, bouton) sert
l'IDEMPOTENCE DE LA RÉSERVATION, parce qu'un template est soumis puis figé. Un message RCS n'est soumis à
personne, il est composé à l'envoi : il ne reste qu'à ne pas créer une ligne par destinataire, qu'un lien
d'hier résolve encore, et que les clics s'accumulent. `(tenant_id, destination)` fait les trois. Deux
conséquences heureuses : aucun `{{1}}`, donc **aucun risque de 132000 ni de « tout ou rien »** côté RCS ; et le
message STOCKÉ garde l'adresse saisie, donc **rien à ré-habiller à l'affichage**, contrairement aux templates.

⚠️ **0105 n'était PAS bloquante**, et c'est ce qui a permis de l'écrire trois commits avant de l'appliquer :
aucun code ne l'écrivait tant que les routes n'étaient pas livrées, et sa forme pouvait encore bouger en les
construisant. L'appliquer tôt aurait obligé à une 0106 corrective au premier ajustement. La règle « migrer
avant de déployer » vaut pour les migrations que le code ÉCRIT, pas pour celles qu'il ignore encore.

🔴 **0096 et 0097 sont jouées HORS TRANSACTION** (0096 est la première du dépôt à l'être), via la directive
`-- migrate: no-transaction` en tête de fichier, parce que `CREATE INDEX CONCURRENTLY` est interdit dans un
bloc de transaction. Deux conséquences à connaître avant d'en écrire une autre : elle n'a **aucun filet** (un échec à mi-parcours n'annule rien et la
migration est rejouée depuis le début, donc chaque instruction doit être idempotente), et le runner l'envoie
**instruction par instruction**, parce qu'une requête simple multi-instructions est exécutée par Postgres dans
une transaction implicite, ce qui rendrait la directive inopérante. `tests/migration-directives.test.ts` garde
les deux sens de la règle sur les fichiers réels.

🔴 **0104 est BLOQUANTE, et elle ferme le trou le plus cher du produit.** Deux avances concurrentes
(l'API traite un retour RCS pendant que le worker traite un webhook du même contact) ENVOYAIENT toutes les deux :
`setStateSiEncoreSur` protège l'état, mais elle arrive APRÈS les envois. Le contact recevait donc un message
qu'il ne devait jamais voir. Le tour est désormais RÉSERVÉ avant tout envoi, avec les trois pièces d'un vrai
verrou (bail, jeton de garde, libération explicite) et **sans drapeau de relance** : le perdant ne doit RIEN
rejouer, son message a été traité par le gagnant qui lisait le même bloc.
⚠️ **Et « réservé avant tout envoi » ne fermait QUE la course courte**, celle de deux avances qui démarrent
ensemble. La course LONGUE, le porteur pas mort mais seulement LENT, est restée ouverte jusqu'au lot 1 du plan
post-audit (2026-09-02) : un envoi Meta peut durer ~154 s en rejouant ses tentatives et une avance peut en
enchaîner plusieurs, donc le bail expirait pendant qu'on travaillait, un autre prenait le tour, et les deux
envoyaient. Aucune valeur de bail ne pouvait fermer ça, le nombre d'envois d'une avance n'étant pas borné :
seul un signe de vie PÉRIODIQUE distingue un porteur mort d'un porteur lent (`src/workflow/bail-avance.ts`,
cadence à un tiers du bail). Même lot, même famille : l'écriture d'état est désormais clôturée par le JETON,
un porteur périmé ne pouvant plus écrire par-dessus celui qui a repris le tour. Aucune migration, les deux
colonnes de la 0104 suffisaient.
⚠️ **Et battre ne suffisait pas non plus : ça rendait la perte VISIBLE sans rien ARRÊTER** (lot A2 de l'audit
externe, 2026-09-03). Le jeton clôture l'écriture d'ÉTAT ; il n'a jamais rien pu contre un message déjà remis
à Meta. Un porteur déchu finissait donc sa liste d'envois pendant que le nouveau faisait la sienne. Le
battement expose désormais `perduPourquoi()`, **consulté avant CHAQUE effet** (`apply`), avant l'envoi RCS de
`walkResolved` et avant l'enfilement d'un tour d'agent, qui est un appel modèle facturé. **La règle générale :
une garde de concurrence posée à l'ENTRÉE d'une liste d'effets ne prouve rien sur le dixième ; elle se pose
ENTRE les effets.** Même lot : une durée totale maximale de dix minutes (`DUREE_MAX_AVANCE_MS`) abandonne une
avance PENDUE, le seul mode de panne qu'un battement ne distingue pas d'un travail lent, puisqu'un minuteur
renouvelle un bail aussi fidèlement pour une promesse morte que pour un envoi en cours.
⚠️ **L'`AbortSignal` du battement n'est écouté par AUCUN transport, et c'est un choix, pas un oubli.** Un
envoi Meta ne porte pas de clé d'idempotence : couper la connexion en vol échangerait « un message de trop »
contre « un message parti que nous n'avons pas enregistré », donc invisible dans le fil. On laisse finir
l'effet en vol, on ne lance pas le suivant.
🔴 **Un tour d'agent tué par un crash était perdu POUR TOUJOURS** (lot A1, 2026-09-03). `prendreLeTour`
incrémente `tours` AVANT le travail, ce qui est ce qui rend le verrou optimiste atomique : un worker qui meurt
entre les deux fait rejouer le job par pg-boss avec l'ANCIEN numéro, la réservation rend `null`, le rejeu est
classé « doublon », la session reste `en_cours` et le run reste en attente SANS échéance (elle se pose à la fin
du tour, qui n'est jamais arrivée). Un balayage minute (`src/agent/tour-bloque-sweep.ts`) réclame les tours en
vol depuis plus de dix minutes, les clôt et fait sortir le parcours par la branche d'échec du bloc.
⚠️ **On ne REJOUE PAS le tour, on le clôt**, et c'est tranché : le worker a pu mourir APRÈS avoir envoyé le
message au contact, et rien en base ne permet de le savoir. Rejouer risquerait un doublon chez le contact ;
clore fait au pire emprunter une branche que le client a rédigée.
⚠️ **Et il fallait une COLONNE, pas une déduction.** « Session `en_cours` + run en attente + aucune échéance »
semble reconnaître un tour mort : c'est EXACTEMENT l'état d'un tour qui vient d'être enfilé et attend son
passage dans la file, et `derniere_activite` ne les départage pas (elle porte l'instant du tour PRÉCÉDENT,
qui peut remonter à des heures). Un balayage bâti sur cette déduction aurait tué des conversations vivantes.
Le pendant : `tour_commence_le` DOIT être effacé sur les deux sorties qui laissent la session vivante
(l'agent a répondu, un humain a pris la main) ; `clore` s'en charge pour toutes les autres.
🔴 **0103 est BLOQUANTE, et sa règle vaut d'être connue : les deux raisons de pause ne se reprennent PAS
pareil.** Un plafond de DÉBIT (130429, ou un HTTP 429 sans code connu) est une limite de cadence : elle retombe
seule, donc la campagne repart automatiquement après un délai borné. Un plafond de QUALITÉ (131048) est un
jugement de Meta sur le numéro : relancer sans rien changer aggrave le problème et peut coûter le numéro, donc
`paused_until` reste NUL et **aucune machine ne lève cette pause**. `paused_until` nul veut dire « pas de
reprise automatique », et c'est le défaut : une pause dont on ne sait pas quoi penser ne repart pas toute seule.
⚠️ **0102 est bloquante, mais elle DÉGRADE PROPREMENT** : sans la table, chaque envoi retombe sur le frein
LOCAL du process et le signale dans les logs, c'est-à-dire exactement le comportement d'avant. C'est voulu :
un frein de débit protège la qualité d'un numéro, il n'AUTORISE pas l'envoi, donc son indisponibilité ne doit
jamais faire échouer un message. La migrer avant reste la règle, mais l'oublier ne casse rien.
🔴 **0101 est BLOQUANTE, et sa leçon vaut plus que sa ligne de SQL.** `recordOutbound` DÉDUISAIT l'origine de
l'expéditeur (« pas d'expéditeur, donc un scénario »), ce qui était vrai tant que ses seuls appelants étaient les
routes de la console. Le serveur MCP en a ajouté un sans expéditeur humain : chaque réponse d'agent tiers est
partie marquée « scenario ». Le pire n'était pas l'erreur mais son INVISIBILITÉ, la valeur fausse étant écrite
explicitement, donc le repli « indéterminée » ne pouvait pas se déclencher. **Une valeur déduite d'un autre champ
n'est une garde que tant que la liste des appelants ne bouge pas, et une liste d'appelants bouge toujours.** Le
paramètre est désormais obligatoire, comme sur `recordOutboundByWaId`.
⚠️ **0100 est BLOQUANTE** (chaque analyse écrit `summary`), donc migrée AVANT le déploiement. Sa colonne
reste vide pour les analyses d'avant, et elle le restera : reconstruire un résumé voudrait dire rappeler le
LLM sur tout l'historique. La fiche de conversation le DIT au lieu d'afficher `justification` à la place,
qui explique le classement et pas le contenu.
⚠️ **0099 est BLOQUANTE** (les quatre chemins d'envoi écrivent `origin` à chaque message sortant), donc migrée
AVANT le déploiement. Sa colonne est volontairement NULLABLE : un `not null` aurait fait échouer une insertion
sur le chemin chaud le jour d'un oubli d'appelant. La garde contre l'oubli est ailleurs, là où elle ne coûte
rien en production : le paramètre `origine` est OBLIGATOIRE dans la signature TypeScript, donc un chemin
d'écriture oublié ne compile pas. La lecture de l'historique est bornée dans le temps (`src/inbox/origine.ts`) :
après la bascule, une origine absente ressort en « indéterminée » À L'ÉCRAN plutôt que d'être versée en silence
dans le scripté.
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

- 🔴 **[docs/PLAN-POST-AUDIT-2026-09-02.md](docs/PLAN-POST-AUDIT-2026-09-02.md) : CE QU'ON EXÉCUTE
  MAINTENANT, à lire AVANT `PLAN.md`.** Sept lots arbitrés le 2026-09-02, aucun commencé. Son **POINT DE
  REPRISE** en tête dit l'état exact, l'ordre recommandé (lot 1 le bail, puis lot 6 la concurrence) et la
  seule décision qui manque (le plafond de campagne du lot 3). Les lots : (1) fermer le bail du tour
  d'avance · (2) le défilement du fil d'inbox · (3) un plafond serveur de taille de campagne · (4) une panne
  d'avance cesse d'être invisible · (5) retirer deux affirmations qui mentent · (6) six files traitent UN job
  à la fois pour toute la flotte · (7) rendre le pool de connexions visible.
- **[PLAN.md](PLAN.md) : l'HISTORIQUE des programmes, plus aucune liste en cours.** Les DEUX sont terminés le
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
- 🔴 **Un `Pick<T, ...>` recopié pour être RETRANSMIS est une liste à tenir alignée à la main, et elle dérive.**
  Le contrat nomme les membres, le corps les recopie un par un : deux listes, dont le désalignement ne produit
  AUCUNE erreur de compilation. Vécu en production le 2026-09-02 : `boutonsTraces` et `jetonsPourContacts`
  étaient câblées dans le worker, absentes du contrat de `run-job`, donc jamais vues par le moteur, et toutes
  les campagnes à lien tracé échouaient en 131008. Depuis le lot C1 (2026-09-03), les capacités voyagent dans
  un objet IMBRIQUÉ transmis d'un seul spread (`moteur` dans `src/campaign/run-job.ts`) : il n'y a plus de
  liste. ⚠️ **Un `Pick` reste bon** quand ses membres sont CONSOMMÉS sur place (l'oubli est alors une erreur au
  point d'usage) : inventaire fait, 13 des 14 `Pick` du dépôt sont dans ce cas. Le critère n'est pas le `Pick`,
  c'est « est-ce recopié pour être retransmis ? ».
  ⚠️ **Et le compilateur ne voit qu'une moitié du problème** : une propriété en trop écrite DIRECTEMENT dans un
  littéral est refusée (TS2353), mais la même dans un SPREAD passe sans un mot. Un câblage qui construit ses
  dépendances par spread n'a donc aucune garde. Même famille : une flèche à deux paramètres est assignable à un
  contrat qui en déclare trois, et le troisième est avalé en silence (vu le 2026-09-03 sur
  `contactIdsForTarget`, gardé depuis par `tests/campagne-cablage.test.ts`).
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

🔴 **`scopeTenant` ÉCHOUE FERMÉ** (2026-09-03). C'est LE contrôle d'isolation entre clients, pour 235 routes,
et la RLS est contournée (pooler superuser). Elle rendait auparavant le tenant PRIS DANS L'URL quand
`req.auth` était absent : elle n'était donc un contrôle que tant que la garde d'authentification avait été
posée au montage, dans un autre fichier, chaque module la recevant en paramètre OPTIONNEL et la dégradant en
silence. Ce n'était pas un trou vivant, mais la panne aurait été MUETTE. Le garde-fou de `buildServer` couvre
désormais les 36 modules à routes `:tenantId` (il en énumérait 18), gardé par `tests/scope-tenant.test.ts`.

🔴 **LE CORS EST EN LISTE BLANCHE ET SANS `credentials`, et les deux comptent.** `CORS_ORIGINS` refuse `*` AU
CHARGEMENT de la configuration. Et jamais `credentials: true` : la session voyage dans un en-tête
`Authorization`, jamais dans un cookie, donc **il n'y a aucun CSRF aujourd'hui** ; l'activer en créerait un de
toutes pièces. Vide = aucun en-tête CORS n'est posé du tout, ce qui est le bon défaut.

⚠️ **`/ops` n'est pas durci, il est SURVEILLÉ** (choix de Julien, 2026-09-03). Une liste blanche d'IP aurait
coupé l'accès dès un changement d'IP. Le jeton reste la garde ; au 5e refus dans une fenêtre de 5 minutes, une
alerte Telegram part, throttlée à une par demi-heure. 🔴 **Le jeton présenté n'est JAMAIS journalisé** : une
tentative est presque toujours un secret voisin du vrai. Chaque refus est journalisé même quand l'alerte est
étouffée.

⚠️ **L'API était DÉJÀ joignable depuis Internet avant `api.messagingme.app`** : le rewrite Next
`/api/backend/:path*` est un ATTRAPE-TOUT, `/ops` compris. Le nouveau nom n'ouvre rien, il rend les adresses
DEVINABLES. Corollaire : toute règle posée sur l'hôte `mba.` doit être redupliquée sur le nouveau, sinon elle
est simplement contournée.

🔴 **Toute URL saisie par un client se vérifie DEUX fois : sur son texte, ET sur ce vers quoi elle RÉSOUT**
(lot A3, 2026-09-03). `urlRecuperable` lit le texte de l'hôte et refuse `localhost`, les littéraux privés et
toutes leurs formes exotiques (hexadécimale, entière, IPv6, IPv4 mappée : vérifié). Elle ne peut RIEN contre
`crm.exemple.fr` dont l'enregistrement A pointe sur `169.254.169.254` (métadonnées du fournisseur) ou sur
`172.18.x.x` (le réseau Docker du VPS, où vivent l'admin NPM et tous les conteneurs). `resolutionPublique`
(`src/lib/adresse-privee.ts`) ferme ça, sur les TROIS chemins concernés : connecteur en conversation, bouton
« Test » de la console, lecture de page distante (à chaque saut de redirection). Règles qui la rendent juste :
UNE seule adresse interdite condamne le nom, et une résolution qui ÉCHOUE est un REFUS. ⚠️ Le « DNS rebinding »
reste ouvert (`fetch` refait sa propre résolution) : le fermer demande un résolveur maison via `undici`, cf.
`todo.md`.

🔴 **Un corps de réponse distante se lit EN FLUX, jamais avec `res.text()` suivi d'un test de taille.** Deux
défauts dans la même ligne : le corps entier entre en mémoire avant d'être jeté, et `.length` compte des
unités UTF-16, donc un corps d'idéogrammes passe un plafond « en octets » à trois fois sa taille. Le repo
l'écrivait à trois endroits. Point de passage unique : `lireCorpsBorne` (`src/lib/corps-borne.ts`), qui coupe
le flux à l'octet qui dépasse. ⚠️ Les clients de NOS API (Meta, Zadarma) n'y passent pas volontairement :
hôtes fixes et de confiance, le risque n'est pas le même.


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
- **Secrets serveur concrets** : `META_ACCESS_TOKEN`, `META_APP_SECRET` (signature webhook), `OPS_TOKEN`, `ENCRYPTION_KEY`, `AUTH_SECRET`, `service_role`, tous dans `src/`/worker/`.env.prod`, jamais dans le bundle `web/` ni en `NEXT_PUBLIC_*`.

### Gotchas et décisions

Le journal chronologique (gotchas Meta et décisions par lot) a été déplacé dans [documentation.md](documentation.md) pour garder ce CLAUDE.md léger. À consulter là, à la demande.
