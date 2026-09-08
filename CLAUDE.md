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
npm run auto-attaque     # 540 sondes d'attaque sur les routes REELLES (voir documentation.md)

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

🔴 **CE FICHIER EST LA SEULE SOURCE DU COMPTEUR. Ne le recopiez nulle part.** Trois documents l'ont fait, les
trois étaient faux : `PLAN.md` en retard de 43 migrations (croire sa ligne menait à écrire par-dessus une
migration existante), `brain/PROJECTS.md` de 15, `wip.md` de 5. Il a aussi dérivé DEUX fois dans la seule
journée du 2026-09-03, et dans les deux sens : annoncé 0107 quand la base était à 0111, puis « prochaine libre
= 0112 » alors que 0112 était déjà appliquée. **En cas de doute, la base tranche, jamais ce fichier**
(`select name from public.schema_migrations order by name desc`, qualifié `public.` : plusieurs schémas de
cette base portent une table de ce nom). Ailleurs, on met un POINTEUR vers la ligne ci-dessous.

**Dernière appliquée : 0118**, le 2026-09-08 (la PROVENANCE d'une fiche de connaissance, `source_type` et
`source_nom` : une fiche issue d'un PDF était jusque-là indiscernable d'une fiche tapée à la main, les deux
ayant `source_url` à null, et l'écran ne peut pas montrer ce qu'il ne sait pas). **Prochaine libre = 0119.**

⚠️ **CETTE LIGNE A DÉRIVÉ UNE FOIS DE PLUS LE 2026-09-08, ET DE MON FAIT.** Elle annonçait encore 0116 alors
que 0117 était appliquée : l'édition qui devait la mettre à jour n'a pas pris, et je ne l'ai pas relue. Le
fichier se déclare seule source du compteur et prévient qu'il dérive ; la parade n'est pas d'y faire
attention, c'est de RELIRE la ligne après l'avoir changée, ou de demander à la base.

Avant elle : **0117** le 2026-09-08 (le mot-clé d'un lien de chaîne perd la ponctuation FINALE de sa phrase :
sans ça, un bouton dont la phrase finit par « ! » ne démarrait aucun scénario, l'auto-détection de liens de
WhatsApp excluant cette ponctuation de l'adresse qu'elle ouvre) ; **0116** le 2026-09-07 au soir (la phrase
d'un lien de chaîne devient sa clé de routage : index unique par espace, et bascule des mots-clés des liens
existants du jeton vers la phrase) ; **0114** le 2026-09-07 au matin (les trois tables Channels Me, plus
`possede_par` et `max_fires_per_hour` sur `automations`) ; **0115** le même soir (l'index qui sert « le
parcours actif de ce contact », `CREATE INDEX CONCURRENTLY`, hors transaction, `indisvalid` vérifié après
coup et le planificateur la prend).

🔴 **CE QUI A ÉTÉ VÉRIFIÉ SUR 0116, ET POURQUOI CE N'ÉTAIT PAS FACULTATIF.** Sa précondition (aucune phrase
en double) a été REVÉRIFIÉE juste avant de l'appliquer, pas seulement quand elle a été écrite. Puis ses deux
effets ont été mesurés en base plutôt que déduits de l'absence d'erreur : `indisvalid = true` sur
`channelsme_links_phrase_key`, et les mots-clés des deux liens réellement basculés. Surtout, le point dont
dépendait la survie de tous les posts DÉJÀ PUBLIÉS a été lu dans la donnée : leur automation porte bien
`mode: "contains"`. En `equals`, le texte historique `phrase (cm-xxxx)` aurait cessé de correspondre et tous
les boutons en circulation seraient morts, sans aucun recours.

**0114** a suivi l'ordre que la section impose, et c'est le cas d'école : ses deux colonnes sur `automations`
sont lues par le CHEMIN CHAUD (`PgAutomationStore.listEnabled`, qui sert la correspondance des messages
entrants), donc image construite, puis `migrate`, puis `up -d --build`. Vérifié après coup en interrogeant
`information_schema` ET en exécutant la requête du chemin chaud, pas en constatant l'absence d'erreur dans
les journaux : sans trafic entrant, un silence ne prouve rien.

**Le détail de CHAQUE migration (0093 à 0113), ce qu'elle a coûté et ce qu'elle a appris, vit dans**
**[documentation.md](documentation.md) § « Les migrations, une par une ».** Il occupait un quart de ce
fichier pour raconter des migrations appliquées depuis des semaines : un point d'entrée qui devient une
archive cesse d'être un point d'entrée.

🔴 **CE QUI SE DÉCIDE À CHAQUE DÉPLOIEMENT, et qui reste donc ici : une migration qui AJOUTE une colonne**
**écrite par le code se passe AVANT le déploiement** (sinon le chemin chaud échoue en boucle, `column ... does
not exist` : vécu le 2026-08-17, 1 h 30 sans enregistrer un seul message entrant) ; **une migration qui RETIRE**
**une colonne encore lue par l'ancien code se passe APRÈS**. Le TYPE de la migration décide de l'ordre, et la
question se pose à chaque fois plutôt que de suivre une routine.

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

**Les cinq fichiers de doc**, et ce qu'on y met : [documentation.md](documentation.md) la technique (archi,
stack, schéma DB, env, patterns, et le JOURNAL des lots livrés avec leurs gotchas) · [features.md](features.md)
le fonctionnel vu utilisateur · [wip.md](wip.md) ce sur quoi on bosse MAINTENANT · [todo.md](todo.md) le
backlog · et ce fichier, qui reste le point d'entrée LÉGER.

**Les audits et les plans sont tous CLOS**, et ils ne se lisent plus que pour comprendre une décision :
[PLAN.md](PLAN.md) (les deux programmes, terminés le 2026-09-01),
[docs/PLAN-POST-AUDIT-2026-09-02.md](docs/PLAN-POST-AUDIT-2026-09-02.md) (sept lots, livrés ET déployés le
2026-09-02 au soir), [AUDIT-SYNTHESE-STRUCTURE-SCALABILITE-2026-08-31.md](AUDIT-SYNTHESE-STRUCTURE-SCALABILITE-2026-08-31.md)
(la synthèse qui a produit le programme, constats revérifiés un par un dans le code),
[AUDIT-SCALE-2026-08-25.md](AUDIT-SCALE-2026-08-25.md) (plus aucun rouge ni orange ; sa §7 était la dette de
perf, une dizaine de jaunes fermés, le reste dans `todo.md`) et
[AUDIT-SCALE-2026-07-18.md](AUDIT-SCALE-2026-07-18.md) (supplanté par celui d'août).

⚠️ **Cette section annonçait « sept lots, aucun commencé » jusqu'au 2026-09-04**, alors qu'ils étaient déployés
depuis deux jours. Un pointeur qui décrit un ÉTAT vieillit ; un pointeur qui dit seulement OÙ EST QUOI, non.
Les rapports de contradiction externe et leur tri vivent dans `docs/` et dans `todo.md`.

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
- 🔴 **`gh run list` AVANT tout déploiement**, au même titre que `git log <déployé>..HEAD`. Un `npm test`
  vert en local ne prouve que la moitié : les tests d’intégration ne tournent qu’en CI, sur un Postgres
  jetable. Déployer sans avoir regardé le run, c’est déployer sans avoir vu la moitié des tests.
  🔴 **Et `gh run watch --exit-status` MENT : il a rendu 0 sur un run EN ÉCHEC** (2026-09-07). S'y fier
  aurait envoyé en production du code dont les tests d'intégration échouaient. Le verdict se lit sur
  `gh run view <id> --json jobs`, job par job, jamais sur le code de sortie du watch.
  ⚠️ Un push qui ne touche QUE des `.md` ne déclenche AUCUN run (`paths-ignore`, pour le quota) : l'absence
  de run sur `HEAD` n'est donc pas un échec, c'est le dernier commit DE CODE qu'il faut regarder.
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

🔴 **LES ROUTES AUTHENTIFIÉES ONT UN PLAFOND DE DÉBIT, et 0 le désactive** (2026-09-07). Deux plafonds :
`RATE_LIMIT_USER_PAR_MINUTE` (défaut 300, clé = utilisateur, posé DANS `makeRequireAuth` donc hérité par les
36 modules gardés) et `RATE_LIMIT_COUTEUX_PAR_MINUTE` (défaut 10, clé = ESPACE) sur import, aperçu, action en
masse, purge, export d'historique et lancement de campagne. **Mettre l'une à 0 la désactive**, et c'est le
levier d'urgence : ces plafonds touchent les 235 routes d'un produit en production, un mauvais calibrage
couperait la console de tous les clients, et un `--force-recreate` va plus vite qu'un déploiement de code.
⚠️ Ils sont LOCAUX AU PROCESS : le plafond annoncé est celui d'UNE instance, à lever avant le multi-replica.

⚠️ **`/ops` n'est pas durci, il est SURVEILLÉ** (choix de Julien, 2026-09-03). Une liste blanche d'IP aurait
coupé l'accès dès un changement d'IP. Le jeton reste la garde ; au 5e refus dans une fenêtre de 5 minutes, une
alerte Telegram part, throttlée à une par demi-heure. 🔴 **Le jeton présenté n'est JAMAIS journalisé** : une
tentative est presque toujours un secret voisin du vrai. Chaque refus est journalisé même quand l'alerte est
étouffée.

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
qu'on ajoute un bouton : `tests/lib-adresse-privee.test.ts` le vérifie à chaque exécution. ⚠️ Le « DNS
rebinding » reste ouvert (`fetch` refait sa propre résolution), cf. `todo.md`.

🔴 **Un corps de réponse distante se lit EN FLUX** (`lireCorpsBorne`, `src/lib/corps-borne.ts`), jamais avec
`res.text()` suivi d'un test de taille : le corps entier entrerait en mémoire avant d'être jeté, et `.length`
compte des unités UTF-16, donc un corps d'idéogrammes passe un plafond « en octets » à trois fois sa taille.
Ses TROIS consommateurs doivent lire ses trois verdicts : `trop_gros`, `casse` (un flux coupé n'est pas un
corps vide, sans quoi on annonce un succès sur une lecture ratée) et le texte. ⚠️ Les clients de NOS API (Meta,
Zadarma) n'y passent pas : hôtes fixes et de confiance.

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
- **Secrets serveur concrets** : `META_ACCESS_TOKEN`, `META_APP_SECRET` (signature webhook), `OPS_TOKEN`, `ENCRYPTION_KEY`, `AUTH_SECRET`, `service_role`, tous dans `src/`/worker/`.env.prod`, jamais dans le bundle `web/` ni en `NEXT_PUBLIC_*`.

### Gotchas et décisions

Le journal chronologique (gotchas Meta et décisions par lot) a été déplacé dans [documentation.md](documentation.md) pour garder ce CLAUDE.md léger. À consulter là, à la demande.
