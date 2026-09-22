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

🔴 **UN ÉCRAN QUI APPELLE UNE ROUTE NEUVE CASSE DÈS LE PUSH, PAS AU DÉPLOIEMENT** (2026-09-21). Vercel publie
la console à chaque `git push`, l'API attend sa revue finale et son `up -d --build` : entre les deux, l'écran
appelle une route que la production n'a pas. Vécu avec l'onglet « Outils » de l'agent de Meta, en 404 en
production pendant plus d'une heure, pour un espace qui avait des outils publiés et à qui l'écran disait
« Aucun outil ». La parade : pousser l'écran APRÈS le déploiement de l'API qui porte sa route, ou le faire
tolérer l'absence de la route ; sinon, dire la fenêtre dans le plan et la réduire (revue finale et
déploiement dans la foulée). ⚠️ **Ce que la garde de déploiement couvre, exactement** (`.claude/deploy.json`,
lu par `~/.claude/hooks/deploiement-garde.js`) : un `docker compose up`, un `pm2 restart|reload|start` ou une
MIGRATION (`npm run migrate`, ajoutée le 2026-09-22 sur décision de Julien : elle change la base de production
AVANT le `up`), lancés par `ssh` dans une commande qui nomme `/home/ubuntu/mba`, sans revue finale attestée.
Elle ne couvre NI le `compose build` (rien ne change en production), NI une migration lancée depuis ce poste
(la garde ne lit que le `ssh`, alors que le `.env` local pointe AUSSI sur la production), NI Vercel
(`pushDeploie` y est délibérément à `false`).

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

**Dernière appliquée : 0162**, le 2026-09-21 au soir (`outils_maison_mba`, les outils maison de l'agent de
Meta, lot 2). **Prochaine libre = 0163.** 0162 AJOUTE `agent_tools.pour_agent_meta` (écrit par la création
d'un outil maison) et `conversation_messages.accuse_le` (que PERSONNE n'écrit encore : c'est le lot 4 ; les
messages acquittés d'ici là garderont `null`), RELÂCHE `agent_tools_action_par_agent_chk` et AJOUTE
`agent_tools_pour_agent_meta_chk` (le drapeau n'existe que sur un outil `mba` sans agent) : l'ancien code y
survit, donc AVANT le déploiement. 🔴 **RELUE EN BASE JUSTE APRÈS `migrate`** : 0162 en tête de
`schema_migrations`, `pour_agent_meta` en `boolean NOT NULL DEFAULT false`, `accuse_le` en `timestamptz`
nullable SANS défaut, les deux CHECK avec leur définition exacte (`pg_get_constraintdef`), AUCUN index, et rien
n'a bougé pour personne (zéro outil ne porte le drapeau, zéro message ne porte d'accusé, un seul outil en base).

Avant elle, **0161**, le 2026-09-21 (`relais_mba`, le relais du Meta Business Agent).
0161 RELÂCHE le CHECK `agent_tool_calls_source_check` (l'appelant `mba` s'ajoute ;
l'ancien code y survit) et AJOUTE `tenant_settings.mba_relais_cle_id` (la clé posée chez Meta, écrite par la
publication), donc AVANT le déploiement. 🔴 **RELUE EN BASE JUSTE APRÈS `migrate`** : 0161 en tête de
`schema_migrations`, le CHECK avec `mba`, la colonne `uuid` nullable SANS défaut, sa clé étrangère vers
`api_keys` en `on delete set null` (`confdeltype = 'n'`), et zéro espace portant une clé retenue.

Avant elle, **0160**, le 2026-09-19 après-midi (`inbox_traite_medias_prise`, chantier Inbox). Elle AJOUTE
trois colonnes que le code écrit ou nomme, donc AVANT le déploiement :
`conversations.traitee_le` (le statut « Traité »), `conversation_messages.media_nom` (le nom de fichier d'un
document reçu, NOMMÉ dans le `select` du fil, donc bloquante pour l'Inbox) et
`tenant_settings.agents_peuvent_prendre` (`false` par défaut). 🔴 **RELUE EN BASE JUSTE APRÈS `migrate`** :
0160 en tête de `schema_migrations`, les trois colonnes avec leur type, leur nullabilité et leur défaut exacts,
AUCUN index sur `traitee_le` (délibéré), et rien n'a bougé pour personne (zéro conversation traitée, zéro nom,
zéro espace avec la prise activée).

Avant elle, **0159**, le 2026-09-18 au soir, avec **0156, 0157 et 0158** le même soir : tout le
chantier des MOMENTS d'un agent IA. Ces quatre-là portent : **0156**
(`agent_transfert_mode`, quand l'équipe est joignable pour un agent IA), **0157** (`outils_par_agent`, une
ACTION appartient à l'agent, un CONNECTEUR à l'espace, deux index partiels complémentaires), **0158**
(`outil_gestes`, les GESTES d'un moment, ce que NOUS faisons sans le demander au modèle) et **0159**
(`actions_orphelines`, la seule irréversible). Avant elles, **0155** (`analyse_jour`) et **0154** (la grille
de prix par espace).

🔴 **L'ORDRE N'ÉTAIT PAS UNIFORME, ET 0159 A ÉTÉ MISE DE CÔTÉ SUR LE VPS AVANT LE BUILD.** 0156 à 0158
ajoutent des colonnes que le code écrit, donc AVANT le déploiement ; 0159 ferme un CHECK que l'ANCIEN
`ajouter` viole, donc APRÈS. Or les migrations vivent DANS L'IMAGE et `migrate` applique tout ce qu'il y
trouve : les quatre étant poussées ensemble, un seul `build` puis `migrate` les aurait appliquées d'un bloc.
Même parade qu'en 0141 : `mv` de 0159 hors du dépôt avant le build, `ls` DANS L'IMAGE pour vérifier qu'elle
n'y est pas, migrate, déploiement, puis remise, rebuild, et migrate pour elle seule.

🔴 **RELUES EN BASE JUSTE APRÈS `migrate`, POINT PAR POINT.** `schema_migrations` rend bien 0159 puis 0158 en
tête ; `agent_transfert_mode` est `text` NULLABLE SANS défaut ; `agent_id` est `uuid` nullable avec un
`on delete cascade` (`confdeltype = 'c'`) ; `gestes` est `jsonb NOT NULL DEFAULT '[]'` ; les quatre CHECK
sont posés avec leur définition exacte ; et les TROIS index de 0157 existent avec leurs prédicats
(`agent_tools_nom_espace_uidx` sur `agent_id is null`, `agent_tools_nom_agent_uidx` sur `agent_id is not
null`, `agent_tools_par_agent_idx`), l'ancien `agent_tools_nom_espace_idx` ayant bien disparu.

⚠️ **AUCUN COMPORTEMENT N'A BOUGÉ POUR PERSONNE, ET C'EST MESURÉ** : zéro espace porte un mode de transfert
(donc tous en `always`, le comportement d'hier), zéro outil porte un geste, zéro outil porte un
propriétaire.

🔴 **CE QUE 0159 A SUPPRIMÉ, COMPTÉ AVANT ET APRÈS.** Ses DEUX requêtes de contrôle ont été jouées juste
avant de l'appliquer : la première rend les **7** définitions `mba_*` sans AUCUN consommateur
(`mba_escalader_humain`, `mba_chercher_connaissance`, `mba_terminer`, `mba_envoyer_bloc`, `mba_poser_tag`,
`mba_lire_contact`, `mba_ecrire_variable`), la seconde, celle qui dit ce qui BLOQUERAIT le CHECK, rend
**zéro**. Après : plus aucune action au niveau de l'espace, aucun consentement orphelin laissé derrière, et
le CHECK strict posé. Aucune de ces 7 n'était rattachée à quoi que ce soit, donc aucun agent n'a rien perdu.

⚠️ **LA SECONDE REQUÊTE DE CONTRÔLE A ÉTÉ AJOUTÉE PAR LA REVUE FINALE, ET ELLE MANQUAIT.** La migration ne
mesurait que ce qu'elle allait SUPPRIMER, ce qui ne répond pas à la question que pose son CHECK : une action
créée par l'ancien code porte un consommateur, survit donc au `delete`, et viole le CHECK. La CI a ensuite
trouvé la suite : le consentement n'est pas une clé étrangère, donc il peut nommer un agent supprimé, et
l'adoption y aurait écrit un `agent_id` fantôme. **`0153` reste RÉSERVÉ** au
CHECK strict de `agent_tools.source_kind` du chantier MCP (cf. `todo.md`) : le numéro est pris, le fichier
n'existe pas, et le runner n'exige aucune continuité.

🔴 **RELUES EN BASE JUSTE APRÈS `migrate`, POINT PAR POINT, PAS EN ÉCRIVANT CETTE LIGNE.**
`schema_migrations` rend bien 0155 puis 0154 en tête ; les six colonnes de prix existent, `NOT NULL` avec
leurs défauts ; `prix_marge_template` est un **`numeric(6,2)`** (précision et échelle relues dans
`information_schema`, pas déduites) ; les trois CHECK sont posés avec leur définition exacte ;
`analyse_jour` a sa clé primaire `(tenant_id, jour)` et un `on delete cascade` (`confdeltype = 'c'`) ; et
`conversation_retention_days` est nullable SANS défaut.

⚠️ **AUCUN COMPORTEMENT N'A BOUGÉ POUR PERSONNE, ET C'EST MESURÉ** : zéro espace porte un réglage neuf
(marge à 100 partout, rétention non réglée), donc chacun lit le même chiffre qu'hier. Et **zéro
conversation** n'a plus de 90 jours, donc la purge nouvellement abaissée n'efface rien aujourd'hui : la
seule opération irréversible du dépôt a été allumée au moment où elle ne peut rien détruire.

🔴 **LE BALAYAGE D'AGRÉGATS A TOURNÉ AVANT LA PURGE, ET ON L'A VU.** Au démarrage du worker :
`agregats-analyse: 6 journee(s) ecrite(s)`. Vérifié ensuite en base par le vrai code : sur les deux espaces,
la lecture directe et la table d'agrégats rendent des journées **IDENTIQUES**. C'est la propriété qui
autorise à effacer, et elle est constatée en production, pas seulement en CI.

Avant elles : **0152**, le 2026-09-16 (les quatre colonnes MCP d'`agent_tools` plus la garde de `kind`).
Relue en base juste après `migrate`, pas en écrivant cette ligne :
`schema_migrations` rend bien `0152_outils_mcp.sql` en tête, les cinq colonnes sont nullables SANS défaut,
`pg_indexes` n'en porte AUCUN, la clé étrangère composite existe en `confmatchtype = 's'`, et **zéro ligne
sur quatre n'en porte une valeur**, donc aucun comportement n'a bougé.

🔴 **ELLE EST DÉLIBÉRÉMENT PERMISSIVE, ET C'EST LA LEÇON DE 0128 APPLIQUÉE À L'AVANCE.** Elle NE POSE PAS le
CHECK qui exigerait `source_kind`. Le code DÉPLOYÉ au moment où elle s'applique ignore cette colonne : un
CHECK strict aurait fait échouer **toute création d'outil de connecteur** pendant la fenêtre censée être la
plus sûre, celle où l'on peut encore revenir en arrière. Le CHECK strict fera l'objet d'une migration
SUIVANTE, appliquée APRÈS le déploiement du code qui renseigne la colonne. « Avant ou après le déploiement »
ne se décide pas sur *ajoute / retire*, mais sur **« l'ancien code survit-il à ce changement ? »**.

🔴 **LA GARDE DE `kind` SE TIENT PAR UNE CLÉ ÉTRANGÈRE COMPOSITE, PAS PAR UN DÉCLENCHEUR.** Rien n'empêchait
un outil `origin = 'mcp'` de pointer vers une source `kind = 'http'`, ni l'inverse : `agent_tools_origin_src_chk`
(0088) vérifie qu'une source EXISTE, pas LAQUELLE, et le résolveur serait parti dans la mauvaise branche. Un
déclencheur est le réflexe et c'est le mauvais : il se teste mal et ne se voit pas quand on lit le schéma.
⚠️ Le trou était nommé depuis des semaines dans `AGENT-IA-PLAN-L4.md` (« le trou n°3 »), un plan MCP
antérieur que le cadrage du 2026-09-16 a été écrit **sans connaître**.

⚠️ **MESURÉE EN BASE AVANT D'ÊTRE ÉCRITE** : 4 outils, tous `origin='mba'` et sans source ; 1 source
`kind='http'` en brouillon ; ZÉRO croisement `origin`/`kind` déjà faux. Sans cette mesure, la clé étrangère
aurait pu échouer à l'application, en production, sur une donnée qu'on n'avait pas regardée.

Avant elle : **0151**, le 2026-09-16 (`workflow_runs.graphe_fige` : le graphe qu'un parcours de test
joue, figé à son démarrage). Relue en base juste après `migrate`, pas en écrivant
cette ligne : `schema_migrations` rend bien `0151_run_graphe_fige.sql` en tête, la colonne est `jsonb`
nullable SANS défaut dans `information_schema`, `pg_indexes` n'en porte AUCUN (délibéré), et zéro parcours
existant n'en porte un, donc aucun comportement n'a bougé.

🔴 **ELLE RÉPARE UN DÉFAUT EXISTANT, PAS SEULEMENT LA NOUVELLE FONCTIONNALITÉ.** Un test DÉMARRE sur le
brouillon (`startTestRun` passe `grapheEditable(wf)`) et REPRENAIT sur le publié : les trois points de reprise
de l'exécuteur (`resume`, `runEnAttenteSur`, `advance`) demandaient le graphe à `getGraph`, que le câblage
résout en `row.graph`. Un test qui atteignait un bloc d'attente et recevait une réponse CHANGEAIT donc de
version en cours de route, en silence ; si le bloc courant n'existait pas dans le publié, le parcours se
figeait sans un mot.

🔴 **UN SEUL POINT DE PASSAGE, ET C'EST TOUT L'INTÉRÊT** : `grapheDuRun(run, lirePublie)`
(`src/workflow/executor.ts`). Poser la préférence dans chacun des trois points de reprise ferait trois
endroits où l'oublier, et le quatrième point ajouté demain ne l'aurait pas. Le figeage se DEMANDE
(`runFrom(..., { figerLeGraphe: true })`), il n'est jamais implicite.

⚠️ **NULLABLE, ET `null` EST LE CAS NORMAL** : aucun parcours réel n'en porte. Figer le graphe de chaque
destinataire d'une campagne de 5 000 personnes recopierait 5 000 fois le même objet. `null` = on lit le
publié, c'est-à-dire exactement le comportement d'avant pour tout ce qui n'est pas un test. La colonne est
REQUISE dans `WorkflowRunRow` et dans `DueRun` : un câblage qui l'oublierait ne compile pas, et c'est ce qui
garantit que le graphe figé survit AUSSI au balayage des parcours endormis.

⚠️ **RIEN À PURGER EN PLUS** : `purgeTerminesOlderThan` supprime les parcours terminés, le graphe figé part
avec eux.

Avant elle : **0150**, le 2026-09-15 après-midi (`agent_tools.nature` : un outil dit si l'agent
POUSSE de l'info ou s'il INTÈGRE la réponse). Relue en base juste après `migrate` :
`schema_migrations` rend bien 0150 en tête, la colonne est `text NOT NULL DEFAULT 'integre'`, le CHECK borne
à `pousse`/`integre`, et les 4 outils existants sont tous en `integre`, donc aucun comportement n'a bougé.

🔴 **ELLE RÉPARE UNE QUESTION QU'ON NE POSAIT PAS.** Tout appel de connecteur était supposé RENDRE quelque
chose : la déclaration exigeait des champs de réponse et le résolveur refusait un appel sans. Or la moitié des
appels qu'un client veut brancher ne rendent rien d'utile (poser une étiquette, créer une fiche, pousser un
opt-out). Julien, bloqué sur un `POST /subscriber/add-tag` : « la question c'est qu'est-ce que cet appel
fait ? pousser de l'info, ou avoir un retour de payload qui enrichirait la discussion ».

🔴 **ELLE NE SE DÉDUIT PAS DE LA MÉTHODE HTTP**, d'où une colonne et pas un calcul : un `POST` peut être une
RECHERCHE (l'API de UChat en a). Dériver du verbe rangerait ces appels en « pousse » et rendrait leur réponse
invisible à l'agent, sans aucune erreur.

🔴 **ET ELLE DÉPLACE LE FILTRE DE SORTIE DE L'APPEL VERS L'OUTIL, ce qui est le vrai changement.** Un appel est
PARTAGÉ entre agents ; ce que CET agent a le droit de lire ne l'est pas. Tant que `output_paths` vivait sur
`connector_requests`, restreindre pour un agent restreignait pour tous. La requête garde la sienne comme
DÉFAUT de pré-remplissage, et ne gouverne plus rien à l'exécution.

⚠️ **`agent_tools.output_paths` EXISTAIT DÉJÀ (0086) ET ÉTAIT DÉLIBÉRÉMENT LAISSÉE VIDE**, avec une
justification (« la REQUÊTE les porte, les remplir en double créerait deux vérités ») juste pour l'ancienne
conception. Deux vérités existaient pourtant : `connecteurSimule` bouclait DÉJÀ sur cette colonne vide et
rendait zéro champ, alors que le bac à sable promet « exactement ce que l'agent recevra ». **Il mentait depuis
le 2026-09-02** ; remplir la colonne le répare, et deux tests empêchent la promesse de redevenir fausse.

Avant elle : **0149**, le 2026-09-15 au matin (`conversations.release_mba_apres_message` : le fil
attend l'accusé de NOTRE dernier envoi avant de repartir chez l'agent de Meta).
Relue en base juste après `migrate`, pas en écrivant cette ligne : `schema_migrations` rend bien 0149 en tête,
la colonne est `text` et nullable dans `information_schema`, et `pg_indexes` n'en porte AUCUN, comme prévu.

🔴 **ELLE RÉPARE UNE COURSE, ET C'EST LA MESURE QUI L'A MONTRÉE.** La fin d'un parcours relâchait le fil dans
la seconde suivant son dernier envoi. Or la documentation de Meta dit qu'ENVOYER UN MESSAGE PREND LE FIL
implicitement : l'envoi reprenait donc le fil juste après notre remise. Trois releases émis deux secondes
après un envoi ont échoué, celui émis quatorze minutes après a marché.

🔴 **ET LA CAUSE DES « DEUX MINUTES » A ÉTÉ MAL ATTRIBUÉE PENDANT TOUTE LA JOURNÉE DU 2026-09-15.** Cette page
a affirmé que « Meta acquitte nos envois avec DEUX MINUTES de retard », sur une corrélation par identifiant
(envoi 07:42:17 -> 07:44:04 ; 08:26:47 -> 08:28:42). **C'était une erreur de lecture** : les heures d'arrivée
étaient celles où NOTRE worker traitait l'accusé, pas celles où Meta l'envoyait. Vérifié le soir même dans le
journal brut des webhooks : l'horodatage que Meta inscrit dans l'accusé du message de 08:26:47 vaut
**08:26:47**, et son webhook nous parvient à **08:26:48**. Meta acquitte en UNE SECONDE ; les deux minutes
venaient de la file `webhook-status`, qui se vidait à deux accusés par minute.

⚠️ **LE MARQUEUR RESTE JUSTE, ET C'EST CE QUI COMPTE** : ce qu'on attend n'est pas un délai, c'est la PREUVE
que Meta a fini de traiter l'envoi. Seul l'accusé la porte, qu'il arrive en une seconde ou en deux minutes.
La leçon est ailleurs : **un écart mesuré ne dit pas à qui il appartient**, et attribuer le sien à un tiers
est la façon la plus sûre de ne jamais le corriger.

🔴 **UN MARQUEUR, PAS UNE TEMPORISATION, et il NOMME le message attendu.** Un délai fixe serait un nombre
deviné, faux le jour où Meta ralentit. Et un simple « quelque chose est en attente » ne suffirait pas : un
parcours envoie plusieurs messages, l'accusé du PREMIER arrive souvent après que le DERNIER soit parti, donc
il reproduirait la course. N'importe lequel des statuts de ce message la lève (`sent`, `delivered`, `read`,
`failed`) : ce qu'on attend n'est pas une bonne nouvelle, c'est la preuve que Meta a fini de traiter l'envoi.

⚠️ **L'ÉTAT D'ATTENTE EST `app_human`, ET AUCUNE AUTRE VALEUR NE CONVIENT.** `mba` mentirait tant que Meta n'a
pas confirmé, et `app_workflow` est la SEULE valeur que le dossier « À traiter » exclut : un client qui écrit
pendant cette fenêtre ne produirait alors aucune ligne de travail, ce qui est exactement le symptôme signalé.
C'est aussi ce qui arme le filet, `CONTROL_HUMAN_TIMEOUT_MS` reprenant les fils `app_human` immobiles et les
rendant pour de vrai.

🔴 **LE `sous-select` A ÉTÉ EXÉCUTÉ SUR LES VRAIES DONNÉES, faute de CI.** GitHub Actions refusait alors de
démarrer le moindre job (« recent account payments have failed or your spending limit needs to be
increased »), donc le job `integration` n'a PAS tourné ce jour-là, et c'est le seul qui voit une base. La
moitié LECTURE de la requête a donc été jouée en production, en lecture seule : sur la conversation d'essai,
elle désigne bien l'envoi de 08:26:47, c'est-à-dire précisément celui dont l'accusé est arrivé à 08:28:42.
⚠️ **CE BLOCAGE EST LEVÉ** : les runs repartent depuis, vérifié le 2026-09-17 (`gh run list`). La phrase
restait au présent et serait devenue une excuse permanente pour sauter la CI.

⚠️ **CETTE LIGNE AVAIT DÉRIVÉ UNE HUITIÈME FOIS**, relevée par la revue finale du chantier des assistants :
elle annonçait 0144 quand la base en portait CINQ de plus, toutes appliquées la même nuit. Même cause que les
sept précédentes, et même parade : **la base tranche**, on RELIT `schema_migrations` juste après `migrate`,
jamais après avoir écrit le fichier SQL.

Avant elle, dans l'ordre d'application : **0147** (`agent_setup_conversations.auteurs` : QUI a écrit chaque
tour du fil, tableau PARALLÈLE à `messages` et pas une clé dedans, `tourSchema` étant strict — l'y ajouter
aurait fait échouer la relecture de TOUS les entretiens existants, qui seraient retombés sur l'entretien
vierge, donc le client aurait perdu sa conversation en silence) ; **0146** (`reglages_historique`, à rétention
ILLIMITÉE, et `assistant_depense_mois`, NOTRE dépense d'assistants, PAR ESPACE et pas par assistant) ;
**0145** (`campaign_etages.devenir` retombe à DEUX valeurs et perd `agent_id`) ; **0144** (`campaign_etages.devenir`
et `.agent_id` : ce qui se passe quand le contact répond, étage par étage).

🔴 **0145 RETIRE CE QUE 0144 VENAIT D'AJOUTER, et le désordre est délibéré** : 0144 ouvrait le devenir à
trois choix dont « un agent IA prend la main », arbitré ensuite à deux. Les deux sont passées la même nuit,
avant le déploiement, sur une colonne qu'aucun code déployé ne lisait encore.

🔴 **0146 PORTE DEUX TABLES QUE LE CODE ÉCRIT, donc elle passe AVANT le déploiement.** `reglages_historique`
n'est PAS `audit_log` : ce dernier est PURGÉ (deux ans), quand la rétention demandée ici est illimitée parce
que ces lignes portent le seul exemplaire d'un contenu que Meta ne garde pas. ⚠️ Elle ne porte AUCUN index
sur `at` seul, délibérément : un tel index ne sert qu'à une purge par date, et son absence est ce qui dit au
prochain lecteur que cette table ne se purge pas.

🔴 **ELLE CÂBLE UNE QUESTION QUI EXISTAIT DÉJÀ À L'ÉCRAN ET DONT DEUX RÉPONSES SUR TROIS N'ALLAIENT NULLE
PART.** Seule « la conversation arrive dans l'Inbox » avait une traduction serveur (`campaigns.assignation`) ;
« l'agent de Meta prend la main » et « un agent IA prend la main » ne quittaient pas le navigateur, alors que
la seconde fait CHOISIR un agent précis dans une liste. C'est le motif « offert-et-inerte », que le produit
s'interdit ailleurs. Le défaut était décrit dans `todo.md` et attendait un arbitrage, tranché par Julien le
2026-09-14 : on câble les trois.

⚠️ **PAR ÉTAGE, ET L'ASSIGNATION RESTE SUR LA CAMPAGNE.** Une chaîne de repli peut servir un modèle seul en
WhatsApp (réponses à l'équipe) et un scénario en RCS (qui décide lui-même), d'où le devenir sur l'étage. Mais
« qui, dans l'équipe » reste une politique de campagne : le tour de rôle compte ses réponses sur un rang
unique (`campaigns.tour_de_role_rang`), et un rang par étage ferait tourner deux roulements indépendants sur
la même équipe, donc servirait deux fois la même personne.

⚠️ **AUCUNE REPRISE DE DONNÉES, délibérément.** `null` = campagne d'avant, qui retombe sur l'ancien
comportement. Écrire 'inbox' sur les étages des campagnes qui portent déjà une assignation paraîtrait plus
propre, mais inventerait une intention : ces campagnes sont parties SANS que personne ne prenne le fil à
l'agent de Meta, et leur donner rétroactivement un devenir qui change ce comportement ferait diverger ce qui
s'est passé de ce que la fiche annonce.

🔴 **LUE EN BASE APRÈS `migrate`** : les deux colonnes dans `information_schema`, le `on delete set null` de
la clé étrangère (une cascade détruirait l'étage, donc la chaîne, pour la suppression d'un agent), les deux
CHECK avec leur définition exacte, et `schema_migrations` relue. ⚠️ Le CHECK `agent_id is null or devenir =
'agent'` ne contraint QU'UN SENS : `devenir = 'agent'` avec `agent_id` à null est un état ATTEIGNABLE (agent
supprimé après coup), et le refuser ferait échouer la suppression d'un agent sur une contrainte de campagne.

Avant elle : **0143**, le 2026-09-14 au matin (elle RETIRE `tenant_settings_optout_request_idx`, un
index partiel que 0139 avait créé et qui ne servait AUCUNE requête).

🔴 **UN INDEX PARTIEL EST UN CONTRAT AVEC UNE REQUÊTE PRÉCISE, ET CELUI-LÀ N'EN AVAIT AUCUNE.** 0139
l'annonçait comme servant « quelles requêtes sont branchées sur le consentement ? » ; cette question n'est
jamais posée ainsi, `brancheeSurConsentement` lit les réglages de l'espace par CLÉ PRIMAIRE. Ce qu'on retire
n'est pas un coût (`tenant_settings` porte une ligne par espace) : **c'est une justification fausse inscrite
dans le schéma**, que le prochain lecteur aurait crue, et qui l'aurait autorisé à élargir un `where` en
pensant rester dans son contrat. Vérifié en base après coup : l'index inutile est parti, les DEUX qui servent
vraiment (`contacts_opted_out_idx`, `agent_tool_calls_echecs_idx`) sont là, et aucun réglage n'a bougé.

Avant elle : **0142**, le 2026-09-14 au matin (le journal des appels de connecteur s'ouvre à SES
TROIS APPELANTS : `agent_tool_calls.session_id` devient NULLABLE, une colonne `source` dit qui appelait, et
un index PARTIEL sert la lecture des échecs).

🔴 **CE QU'ELLE RÉPARE EST UNE EXHAUSTIVITÉ, PAS UNE FONCTIONNALITÉ.** `creerAppelConnecteur`
(`src/agent/resolvers/http.ts`) est le point de passage unique des appels vers le système d'un client, et il
a TROIS appelants : l'agent IA, le bloc « Appel HTTP » d'un scénario, et la poussée d'un opt-out. UN SEUL
journalisait ses échecs. Les deux autres n'écrivaient qu'un `console.warn` : un connecteur qui refusait
l'appel d'un scénario, ou qui ne recevait jamais le refus d'un contact, ne laissait AUCUNE trace
consultable. C'est le motif « une capacité câblée sur un consommateur sur trois », payé plusieurs fois ici.

🔴 **DEUX VERROUS DE SCHÉMA LES EN EMPÊCHAIENT, ET C'EST POUR ÇA QU'ILS NE LE FAISAIENT PAS.** `session_id`
était `NOT NULL` et référençait `agent_sessions` : un scénario n'ouvre pas de session, une poussée non plus.
Et rien ne disait QUI appelait, donc les lignes auraient été indiscernables. **Le champ `journal` est
désormais OBLIGATOIRE dans `AppelConnecteur`** : un quatrième appelant devra écrire `null` et se demander
pourquoi, au lieu de l'oublier. Un test garde cette propriété, qu'un `journal?:` ferait disparaître sans bruit.

⚠️ **ET LA JUSTIFICATION DE `JOURNAL_MUET` A CESSÉ D'ÊTRE VRAIE** : elle invoquait précisément ce `NOT NULL`.
Corrigée. Ce qui reste est un choix produit (les essais du bac à sable n'ont pas à apparaître comme des
pannes dans le journal que le client consulte), plus une contrainte.

🔴 **LU EN BASE APRÈS `migrate`, ET LE CHEMIN COMPLET EXÉCUTÉ PAR LE VRAI CODE** : `session_id` nullable, la
colonne `source` et son défaut, le PRÉDICAT EXACT de l'index partiel, puis une ligne SANS session d'agent
ÉCRITE par `PgJournalAppels` et RELUE par `PgErreursLivraisonStore.listerEchecsSysteme`. La sonde a été
effacée ensuite : le journal d'un client n'a pas à porter nos essais.

Avant elle : **0141**, le 2026-09-13 dans la nuit (elle RETIRE `agents.mention_ia_frequence`, que
0140 venait de remonter au niveau de l'ESPACE dans `tenant_settings.mention_ia_frequence`).

🔴 **0140 ET 0141 SONT UNE PAIRE, ET ELLES N'ONT PAS ÉTÉ APPLIQUÉES AU MÊME MOMENT.** 0140 AJOUTE et
REPREND, donc avant le déploiement ; 0141 RETIRE une colonne que le code déployé lisait encore, donc APRÈS.
Même séquence que 0128 après 0129, et pour la même raison : migrer d'abord aurait fait tomber chaque lecture
de fiche d'agent en `42703` pendant toute la durée du déploiement.

⚠️ **ET LE PIÈGE EST DANS LE DÉPÔT, PAS DANS LA BASE** : les migrations vivent DANS L'IMAGE, et `migrate`
applique TOUT ce qu'il y trouve. 0141 étant poussée en même temps que 0140, un `compose build` suivi d'un
`migrate` les aurait appliquées ENSEMBLE. 0141 a donc été mise de côté sur le VPS AVANT le build, remise
après le déploiement, et l'image reconstruite pour elle seule.

🔴 **CE QUE 0140 REPREND, ET POURQUOI LA MESURE DÉCIDAIT DE TOUT.** La spec demandait « un réglage d'espace »
ET « ne change rien aux agents existants », ce qui ne se concilie que si aucun espace ne porte deux agents
divergents. Mesure faite AVANT d'écrire la migration : UN seul agent en production, sur un seul espace, en
`session`. La reprise est donc EXACTE. La règle pour le jour où la divergence existera est écrite quand même,
et elle va vers PLUS de déclaration (`chaque_message` > `session` > `jamais`) : rassembler deux agents sous
une politique unique oblige à bouger l'un des deux, et entre les deux erreurs possibles, une seule se
rattrape.

🔴 **LU EN BASE APRÈS `migrate`**, pour les deux : la colonne et son CHECK sur `tenant_settings`, la reprise
espace par espace, puis après 0141 la disparition de la colonne d'agent et de son CHECK, et surtout les
CHEMINS CHAUDS exécutés PAR LE VRAI CODE (`PgAgentStore.byId`, celui de chaque tour d'agent, et
`listerPourConformite`) : ils rendent `session`, donc l'agent de production fait exactement ce qu'il faisait.

⚠️ **`agents.mention_ia` NE BOUGE PAS** : la PHRASE reste la voix de l'agent, seul le QUAND est monté à
l'espace. L'écran Sécurité > IA montre les deux, sans quoi il ne montrerait qu'un interrupteur.

Avant elles : **0139**, le 2026-09-13 dans la nuit (`tenant_settings.optout_request_id` : QUEL
connecteur prévenir quand quelqu'un se désabonne, plus son index partiel).

🔴 **LUE EN BASE APRÈS `migrate`, PAS EN ÉCRIVANT CETTE LIGNE**, et les quatre points l'ont été : la colonne
dans `information_schema`, le PRÉDICAT EXACT de l'index partiel dans `pg_indexes`, `confdeltype = 'n'` sur la
clé étrangère (c'est-à-dire `on delete set null`, et surtout pas `restrict`), et `schema_migrations` relue.

🔴 **ELLE DÉSIGNE UNE REQUÊTE, PAS UN OUTIL D'AGENT, et la nuance décide de tout.** Un « outil » est une
surface exposée à un MODÈLE : nom exposé, description destinée au modèle, paramètres que le modèle remplit.
Il n'y a aucun modèle ici. C'est exactement le cas du bloc « Appel HTTP » d'un scénario, qui DÉSIGNE une
requête de la bibliothèque : les trois appelants passent donc par `creerAppelConnecteur`, avec les mêmes sept
gardes. ⚠️ Trois commentaires de ce fichier-là disaient « DEUX appelants » : le compte n'y est plus écrit.

🔴 **`on delete set null` EST LA CEINTURE, LE REFUS LISIBLE EST DANS LA ROUTE.** Le compteur `outils` d'une
requête ne voit que les outils d'agent : une requête branchée sur le consentement y compte ZÉRO, donc elle se
supprimait, et la cascade débranchait la conformité EN SILENCE. La suppression rend désormais 409. La
contrainte reste `set null` et surtout pas `restrict` : une contrainte qui BLOQUERAIT rendrait 500 sur un
geste ordinaire, donc une page Cloudflare sans explication.

⚠️ **`null` PAR DÉFAUT POUR TOUS LES ESPACES** : personne n'est prévenu tant que personne ne l'a demandé. Un
défaut qui enverrait quoi que ce soit à un système tiers sans qu'on l'ait choisi serait l'inverse de ce que
le centre de sécurité garantit.

Avant elle : **0138**, le 2026-09-13 au soir (`contacts.opt_out_at` : QUAND un contact s'est
désabonné, plus l'index partiel `contacts_opted_out_idx` qui sert la liste du centre de Sécurité).

🔴 **LUE EN BASE APRÈS `migrate`, PAS EN ÉCRIVANT CETTE LIGNE** : la colonne dans `information_schema`, le
PRÉDICAT EXACT de l'index partiel dans `pg_indexes` (il doit reprendre mot pour mot le `where` de
`listeDesabonnes`, sans quoi cette page retombe sur un balayage complet de la table des contacts sans
qu'aucune erreur ne le signale), et `schema_migrations` relue.

🔴 **CE QU'ELLE RÉPARE : le dépôt savait QUI avait posé un opt-out et pas QUAND.** `opt_in_source` portait
déjà l'origine ('crm', 'scenario', 'flow', 'webhook:<nom>') ; `updated_at` ne répond PAS à la question,
il bouge à la moindre modification de la fiche, si bien qu'un contact désabonné en mars et renommé hier
paraîtrait s'être désabonné hier. Sur un écran de conformité, afficher cette date aurait été pire que de
n'en afficher aucune, et les lignes antérieures restent donc à `null` avec « date inconnue » à l'écran.

⚠️ **ELLE SE REMET À NULL AU RETOUR EN `opted_in`, SUR LES QUATRE CHEMINS D'ÉCRITURE.** Trois étaient
évidents (le parcours/webhook, la fiche contact, l'action en masse) ; le QUATRIÈME, relevé en revue, est
l'upsert d'import CSV et de l'API publique, qui peut faire régresser un statut sans que personne y pense.
Un invariant énoncé dans une migration se tient partout ou nulle part.

Avant elle : **0137**, le 2026-09-13 (la traduction des conversations :
`conversation_messages.traduction`, `.traduction_langue`, `.redaction_origine`, `.transcription_langue`,
plus `contacts.langue_detectee` et `.langue_detectee_le`). Vérifiée EN BASE après `migrate`, pas déduite
de l'absence d'erreur : les six colonnes dans `information_schema`, le CHECK qui borne
`traduction_langue` à `fr`/`en` dans `pg_constraint`, et `schema_migrations` relue.

🔴 **ELLE ÉTAIT BLOQUANTE, ET LA SÉQUENCE A ÉTÉ SUIVIE DANS CET ORDRE** : `git pull`, `compose build
mba-api`, `compose run --rm --no-deps mba-api npm run migrate`, PUIS `up -d --build`. Ces colonnes ne
sont pas seulement écrites, elles sont NOMMÉES dans les `select` du chemin chaud (`getMessages`,
rafraîchi toutes les 4 secondes). Déployer d'abord aurait rendu `42703` en boucle sur l'Inbox entière,
comme le 2026-08-17.

⚠️ **ET LE 502 PUBLIC EST ARRIVÉ, une fois de plus** : conteneurs `healthy`, appel interne à 200, appel
public à 502 sur `api.` comme sur le chemin `/api/backend/` de `mba.`. NPM tenait l'ancienne IP.
`sudo docker exec mcp-robot_nginx-proxy-manager_1 nginx -s reload` a suffi. Le contrôle public après
CHAQUE `up --build` n'est pas une précaution de circonstance, c'est la seule façon de voir ce défaut.

Avant elle : **0136**, le 2026-09-12 au soir (`campaigns.tour_de_role_rang` passe de `smallint` à
`integer`, ce qui retire le repliage `% 32767` du tour de rôle).

⚠️ **LU EN BASE APRÈS `migrate`, PAS EN ÉCRIVANT CETTE LIGNE.** Le fichier avait dérivé une SIXIÈME fois
dans la journée (il annonçait 0131 quand la base portait 0134). Le moment où cette ligne se met à jour est
l'exécution de `migrate`, et il faut la RELIRE juste après, jamais après avoir écrit le fichier SQL.

Avant elle : **0135** le même soir (`campaign_etages.email_champ` : QUELLE clé du jsonb `contacts.fields`
porte l'adresse e-mail d'un étage). 🔴 **Il n'y a PAS de colonne `contacts.email`, et c'est délibéré** :
l'adresse vit dans le jsonb depuis 0002, sous une clé que le client nomme lui-même, et le dépôt porte la
trace d'un espace qui l'appelait « mail » quand un autre disait « email » (`src/workflow/wiring.ts`,
2026-08-25). Ajouter une colonne aurait créé une SECONDE vérité à côté du jsonb, et le jour où les deux
divergent, c'est la neuve, vide, que la campagne aurait lue.

Avant elle : **0134** (la CHAÎNE d'étages : `campaign_etages`, `campaign_envois`,
`campaign_recipients.etage_courant`, et les cinq réglages de l'assistant sur `campaigns`), et **0133**
(`contacts.whatsapp_joignable` : garder le verdict qu'on calculait déjà et qu'on jetait dans HubSpot).

⚠️ **CETTE LIGNE A DÉRIVÉ UNE SEPTIÈME FOIS, ET DOUBLEMENT, le 2026-09-13.** Elle annonçait à la fois
« 0137 EST ÉCRITE ET PAS ENCORE APPLIQUÉE » et « 0136 EST ÉCRITE ET PAS ENCORE APPLIQUÉE », alors que
0136 l'était depuis la veille au soir et que 0137 venait de l'être. Deux affirmations fausses d'un coup,
dans un fichier qui se déclare seule source du compteur et qui prévient qu'il dérive. La parade n'a pas
changé et elle a encore fonctionné : **la base tranche**. Ce qui ne fonctionne toujours pas, c'est
d'écrire la ligne au moment où l'on écrit le fichier SQL : le moment juste est l'exécution de `migrate`,
et il faut RELIRE la base juste après.

**0136** (`campaigns.tour_de_role_rang` passe de `smallint` à
`integer`). Elle RETIRE un repliage, et c'est la vraie raison : le `% 32767` qui protégeait le `smallint`
créait un point où deux rangs consécutifs valent 32766 puis 0, donc la MÊME personne servie deux fois
d'affilée pour une équipe de 2, 3 ou 6 (mesuré ; seules les tailles divisant 32767 = 7 x 31 x 151 y
échappaient). Il échangeait une panne visible contre une double affectation silencieuse. Elle est un
ÉLARGISSEMENT, donc l'ancien code y survit, mais elle passe quand même AVANT le déploiement : le code neuf
n'a plus de repliage et lèverait `22003` sur un `smallint`.

🔴 **CE N'EST PAS LA MIGRATION QUE LE PLAN ANNONÇAIT, ET C'EST LE VRAI RÉSULTAT DE CE LOT.** Il prévoyait une
colonne `contacts.email`, sur l'idée que « le destinataire sera l'adresse e-mail présente sur la fiche du
mini-CRM ». Vérification faite dans les migrations : `contacts` n'a effectivement PAS de colonne `email`
(0001 crée la table sans, aucun `alter table contacts` n'en ajoute), mais l'adresse EXISTE, dans le jsonb
`fields` de 0002, sous une clé que le CLIENT crée. Et il n'y a **aucune convention de nom** : le dépôt porte
la trace d'un espace qui l'appelait « mail » quand un autre l'appelait « email » (`src/workflow/wiring.ts`,
cas du 2026-08-25). Une colonne `contacts.email` aurait donc créé une SECONDE vérité à côté du jsonb, et le
jour où les deux divergent, c'est la neuve, vide, que la campagne aurait lue.

Avant elle : **0132** (`french_sans_accent` : la recherche plein texte cessait de trouver un mot écrit sans
accent), **0133** (la joignabilité WhatsApp MÉMORISÉE d'un contact) et **0134** (la chaîne d'étages). ⚠️ Cette
page décrivait encore 0132 comme « écrite, pas encore appliquée » : elle l'est, comme 0133 et 0134. C'est la
même dérive, pour la même raison, et la base a encore tranché.

⚠️ **ET CETTE LIGNE A DÉRIVÉ UNE CINQUIÈME FOIS** : elle annonçait 0130 alors que 0131 était appliquée depuis
le matin même. Toujours la même cause, et toujours la même parade : la base tranche. Relire la ligne APRÈS
avoir lancé `migrate`, jamais après avoir écrit le fichier SQL.

Avant elle : **0130**, le 2026-09-11 (`conversations.last_direction` : le SENS du dernier message
d'une conversation, plus son CHECK et sa reprise de l'historique. C'est ce qui permet au dossier « À traiter »
de vouloir dire « la balle est dans notre camp » plutôt que « quelqu'un a écrit »). Avant elle, **0129** le
2026-09-10 à 20h50 (`agent_tool_sources.secret_publie_le` : se souvenir du secret qu'on a POSÉ chez Meta, seul
moyen de savoir quand le reposer), et **0127** le même jour à 19h35 (`agent_tool_consommateurs` : la
DÉFINITION d'un outil appartient à l'ESPACE, le CONSENTEMENT au couple (outil, consommateur), où le Meta
Business Agent est un consommateur comme un agent).

⚠️ **CETTE LIGNE A DÉRIVÉ UNE QUATRIÈME FOIS, le 2026-09-11** : elle annonçait 0129 et « prochaine libre =
0130 » alors que 0130 était écrite ET appliquée depuis le matin. Relevée en écrivant une spec qui avait
besoin du prochain numéro, donc par quelqu'un qui allait s'en servir. La parade reste la même et elle a encore
fonctionné : **la base tranche**. Ce qui ne fonctionne toujours pas, c'est de compter sur le souvenir d'avoir
mis à jour la ligne : le moment où elle se met à jour est l'exécution de `migrate`, et il faut la RELIRE
juste après.

⚠️ **0128 A ÉTÉ APPLIQUÉE APRÈS 0129, et le désordre des numéros est délibéré** : elle RETIRE `agent_id` et
les six colonnes de consentement de `agent_tools`, donc elle devait passer après que le nouveau code ait été
vu en production, quand 0129 devait passer avant. Le runner applique les fichiers absents de
`schema_migrations` par ordre de nom, sans exiger que la suite soit continue ni que l'ordre d'application la
suive.

🔴 **L'ORDRE DE LA SÉQUENCE S'INVERSE POUR UNE MIGRATION QUI RETIRE** : build, `up -d --build`, PUIS
`migrate`. La routine documentée (migrer d'abord) vaut pour une migration qui AJOUTE une colonne que le code
écrit. Ici, migrer d'abord aurait cassé la production pendant toute la durée du déploiement. Et avant de
lancer `migrate`, le code DÉPLOYÉ a été mesuré dans le conteneur (`grep` dans `mba-api` et `mba-worker` :
zéro écriture restante sur les colonnes qui partaient), pas déduit du fait qu'on venait de le pousser.

🔴 **DEUX LECTEURS ÉCRIVAIENT ENCORE CES COLONNES, ET AUCUN N'ÉTAIT VISIBLE D'UN TEST UNITAIRE.**
`PgUserStore.deleteUser` éteignait les outils du partant sur `agent_tools` EN PLUS de la table de liaison :
tout `delete` d'un compte serait tombé en `42703`, sur un chemin qu'on n'emprunte que le jour d'un départ de
collaborateur. Et trois fixtures d'intégration inséraient encore `agent_id`, `actif` et `active_par`, donc la
CI serait devenue rouge sur une base fraîche. La question « qui écrit encore ceci ? » se pose AVANT d'écrire
le `drop column`, pas après l'avoir appliqué.

Vérifiée EN BASE après coup : les 7 colonnes parties, les deux CHECK partis, les deux index remplacés
(`agent_tools_name_idx` et `agent_tools_actifs_idx` absents, `agent_tools_nom_espace_idx` présent), et les
chemins chauds exécutés PAR LE VRAI CODE (`listActifs`, `listToutes`, `byName`, `listActifsConsommateur`,
`listCatalogue`, `PgSourceStore.lister`), plus les deux écritures de `deleteUser` jouées pour de vrai dans
une transaction annulée.

🔴 **UN SECRET NE SE COMPARE PAS, IL SE SOUVIENT (0129).** Meta ne rend JAMAIS le secret d'un connecteur : la
publication ne le posait donc qu'à la CRÉATION, et un commentaire du code affirmait qu'un bouton dédié
permettait de le faire tourner. Ce bouton n'existait pas, et ce texte partait vers `features.md` comme une
fonctionnalité. **Une justification fausse est pire qu'aucune, parce qu'elle sera recopiée**, et c'est en
écrivant la doc que le défaut est sorti. Le drapeau retombe dès qu'on touche à l'authentification de la
source (le secret, mais aussi le MODE et le NOM D'EN-TÊTE, qui décident du corps envoyé), et la publication
suivante repose le secret. À secret inchangé, publier deux fois ne produit toujours aucun geste.

Vérifiée EN BASE après coup : `information_schema` pour la colonne, `schema_migrations` pour l'ordre, et le
chemin chaud exécuté PAR LE VRAI CODE (`PgSourceStore.lister` sur l'espace réel rend `secretPublie: false`,
pas `undefined`).

Vérifiée EN BASE après coup : les trois CHECK (dont celui qui verrouille la FORME de la clé de consommateur,
recopiée verbatim depuis `src/agent/consommateur.ts` et tenue par un test qui LIT le fichier SQL), les deux
index, `agent_id` devenu nullable, ZÉRO clé étrangère restante sur `agent_id`, les 2 lignes reprises (le
compte exact des outils existants), et la requête du chemin chaud exécutée sur les vraies données.

🔴 **« ELLE N'AJOUTE QUE » ÉTAIT FAUX, ET C'EST LA LEÇON DE CE LOT.** La migration a été écrite en croyant
qu'ajouter suffisait, puis la CI a rendu ONZE tests d'intégration rouges d'un coup : le nouveau code n'écrit
plus `agent_id`, or la colonne était `NOT NULL`. Toute création d'outil aurait échoué **pendant la fenêtre
censée être la plus sûre**, celle où l'on peut encore revenir en arrière. Et le même raisonnement cachait un
second piège, trouvé par un test : `agent_id` portait `on delete cascade`, donc supprimer UN agent aurait
détruit les définitions que plusieurs agents partagent.

⚠️ **LA RÈGLE CORRIGÉE, ET ELLE VAUT POUR TOUTES LES MIGRATIONS À VENIR** : « avant ou après le déploiement »
ne se décide pas sur *ajoute / retire*, mais sur **« l'ancien code survit-il à ce changement ? »**. RELÂCHER
une contrainte le laisse vivre (il continue de renseigner la colonne), RETIRER non. Un `drop not null` et un
`drop constraint` de cascade ont donc leur place AVANT, un `drop column` APRÈS.

⚠️ **ET CETTE LIGNE A ENCORE DÉRIVÉ, une troisième fois.** Elle annonçait « écrite, PAS ENCORE APPLIQUÉE »
alors que la base portait 0124, 0125 et 0126 depuis le jour même. La parade est écrite juste au-dessus et
elle a fonctionné : **la base tranche**. Ce qui n'a pas fonctionné, c'est de relire la ligne après avoir
appliqué la migration plutôt qu'après l'avoir écrite. Le moment où elle se met à jour est l'exécution de
`migrate`, pas la rédaction du fichier SQL.

🔴 **LA REVUE DE L'AGENT A TROUVÉ QUE L'ANNONCE ÉTAIT CONFIÉE AU MODÈLE**, et c'est ce que 0126 corrige. La
consigne système disait « au tout premier message d'une conversation, tu annonces que tu es une IA » : rien
ne garantissait qu'elle parte, et surtout « le premier message d'une conversation » est une notion que le
MODÈLE devait deviner depuis un transcript. Il ne sait pas où commence une session, donc un réglage « une
fois par session » posé sur cette base n'aurait jamais pu être tenu. **C'est le code qui choisit désormais
l'instruction avant l'appel** : dire la phrase maintenant, ou ne pas en parler. Le modèle n'a plus de
décision à prendre.

⚠️ **`jamais` est un choix EXPLICITE du client, obtenu en le lui demandant à la construction du bot**
(décision de Julien du 2026-09-09 : « par principe non, on ne demande pas à l'IA de dire systématiquement je
suis une IA »). L'AI Act article 50 n'impose l'information que lorsqu'elle n'est pas évidente du contexte, et
l'obligation pèse sur la marque DÉPLOYANTE : c'est donc à elle de trancher, pas à nous en silence. Défaut
`session`, qui ne change rien aux agents existants.

Avant elle : **0125** (`conversation_messages.media_id`, `.media_mime`, `.transcription`,
`.transcription_modele` : garder de quoi RETROUVER un média entrant, et ce qu'on en a lu).

🔴 **L'IDENTIFIANT DU MÉDIA ÉTAIT JETÉ À LA PORTE, et c'est le vrai sujet de 0125.** Meta ne transmet pas le
fichier dans le webhook, il transmet un identifiant avec lequel on va chercher une URL de téléchargement.
`contentOf` n'en gardait rien : un vocal se réduisait au libellé `[audio]` et devenait **inatteignable pour
toujours**. Aucun correctif ultérieur ne rattrape ça, et Meta ne garde un média REÇU que **sept jours** : c'est
pourquoi cette migration passe AVANT que quoi que ce soit sache transcrire. ⚠️ Cette ligne a dit « 30 jours »
jusqu'au 2026-09-19 : c'est le délai des médias qu'on TÉLÉVERSE, et la mesure l'a démenti ce jour-là (deux vocaux
de 7,9 et 8,9 jours introuvables chez Meta). La constante qui fait foi : `DUREE_MEDIA_RECU_JOURS`.

⚠️ **`body` NE CHANGE PAS** : il garde la légende, sinon `[audio]`. Tout ce qui le lit (aperçu de l'Inbox,
historique de l'agent, analyse) continue à l'identique, et la transcription vit dans SA colonne. Même règle
qu'en 0123 : la lecture d'un modèle n'est pas ce que le client a écrit, et un opérateur qui reprend une
conversation menée par l'IA doit pouvoir écouter ce qui a réellement été dit.

Avant elle : **0124**, le 2026-09-09 (`agent_gateway_keys` : une clé AI Gateway par espace,
provisionnée chez Vercel à la création du premier agent).

Vérifiée EN BASE après coup, comme 0120 à 0123 : `information_schema` pour les six colonnes,
`pg_constraint` pour la clé PRIMAIRE sur `tenant_id` (c'est elle qui rend le provisionnement IDEMPOTENT sans
verrou applicatif : deux créations d'agent simultanées ne peuvent pas produire deux clés Vercel) et pour la
clé étrangère, et `schema_migrations` pour l'ordre.

🔴 **LE PLAFOND DE LA CLÉ EST LE CRÉDIT ACHETÉ, jamais un nombre que le client saisit** (tranché par Julien
le 2026-09-09). La nuance décide de tout : un plafond que le client choisit ne protège personne, il suffit
d'y taper 10 000 pour vider le pot commun ; un plafond égal à ce qu'il a payé est une garantie. Corollaire
assumé : **pas de crédit, pas de clé, donc pas d'agent**, parce que le bac à sable appelle vraiment le
modèle et qu'un client à zéro mettrait son agent au point sur notre argent.

🔴 **DEUX APPELS VERCEL, DEUX HÔTES, DEUX AUTHENTIFICATIONS**, et c'est le piège du lot : créer une clé va
sur `api.vercel.com/v1/api-keys?teamId=` avec le JETON DE COMPTE ; bouger son plafond va sur
`ai-gateway.vercel.sh/v1/quotas?quotaEntityId=api_key_id_<id>` avec la CLÉ GATEWAY maison. Trois façons
indépendantes de se tromper, aucune visible du compilateur, toutes découvertes en production au moment où un
client crée son premier agent. Lues dans la documentation avant d'écrire une ligne, et figées par
`tests/agent-cles-gateway.test.ts`.

🔴 **ET LA DOCUMENTATION DE VERCEL EST FAUSSE SUR LA RÉPONSE DE CRÉATION.** Elle annonce `apiKeyString` ET
`id` à la RACINE ; le serveur rend `apiKeyString` à la racine et l'identifiant sous **`apiKey.id`**. Mesuré
le 2026-09-09 à la première création réelle. Le `safeParse` a refusé, donc rien n'a été enregistré : sans
lui, `id` valait `undefined`, on gardait une ligne à l'identifiant vide, et on perdait DÉFINITIVEMENT le
moyen de replafonner ou de révoquer une clé qui facture (Vercel ne rend le secret qu'une fois, il n'y a
aucune session de rattrapage). ⚠️ La leçon générale n'est pas « Vercel se trompe », c'est **qu'une réponse
d'API se VÉRIFIE, y compris quand sa documentation est explicite** : c'est exactement ce que la règle
« `safeParse`, jamais `as` » achète, et c'est la deuxième fois en deux jours qu'elle paie.

🔴 **`VERCEL_API_TOKEN` EST BIEN PLUS DANGEREUX QUE `AI_GATEWAY_API_KEY`** : la seconde ne sait que dépenser
sous un plafond, le premier sait FABRIQUER des clés facturées à l'équipe. La parade ne vit pas dans le code,
c'est le **plafond d'ÉQUIPE** posé chez Vercel, qui borne les dégâts quel que soit le nombre de clés créées.
**Posé le 2026-09-09 : 100 $/mois, actif**, vérifié en relecture (⚠️ la relecture juste après l'écriture rend
`Quota not found` pendant quelques secondes, c'est une propagation, pas un échec).

⚠️ **`monthly` pour l'ÉQUIPE, `none` pour les clés CLIENT**, et l'inverse serait faux des deux côtés : le
plafond d'équipe est un budget de fonctionnement mensuel, en `none` il couperait tout définitivement une fois
atteint ; le crédit d'un client est prépayé, en `monthly` il lui redonnerait chaque mois ce qu'il n'a pas
acheté. 🔴 Et le plafond d'équipe coupe **TOUS** les projets du Gateway d'un coup, y compris les bots
clients en production (Odalys, Hyundai, Gan Prévoyance, les deux Leadgen) : le calibrer bas n'est pas
« prudent », c'est une panne.

🔴 **RÉVOQUER LA CLÉ AVANT DE SUPPRIMER UN ESPACE, le jour où ça existera** (question de Julien du
2026-09-09). `agent_gateway_keys.tenant_id` porte un `on delete cascade`, qui reste le bon choix (une
contrainte qui BLOQUERAIT la suppression d'un espace serait pire), mais il a une conséquence que personne
n'aura en tête le jour venu : notre ligne part avec l'espace, et **la clé survit chez Vercel avec son
identifiant PERDU**, donc facturable et irrévocable pour toujours. Le geste est
`DELETE /ops/cle-modele/:tenantId`, qui supprime chez Vercel **puis** chez nous et refuse d'oublier la ligne
si Vercel n'a pas confirmé : échouer dans ce sens-là garde de quoi réessayer.
⚠️ Aucun chemin ne supprime un espace aujourd'hui : c'est un piège ARMÉ, pas une fuite ouverte.

⚠️ **Supprimer un AGENT, en revanche, ne touche à rien, et c'est correct** : la clé est par ESPACE. Un espace
sans agent ne peut plus rien dépenser (les deux seuls chemins, tour et bac à sable, passent par une fiche
d'agent), et s'il en recrée un, la clé existante est RÉUTILISÉE au lieu d'en ouvrir une seconde.

⚠️ **NON BLOQUANTE dans l'autre sens** : le code lit la clé en tolérant son absence (l'espace retombe sur la
clé maison, comme un espace RCS sans clé propre). Elle passe AVANT le déploiement parce que la route de
création d'agent l'écrit.

Avant elle : **0123**, le 2026-09-09 (`conversations.signalee_le` et `.signalee_par` : signaler une
conversation À LA MAIN, sans écraser le constat de l'analyse).

🔴 **UNE COLONNE À PART, ET PAS `conversation_analysis.abusive`.** Ce champ-là est un CONSTAT posé par un
modèle, RECALCULÉ à chaque ré-analyse : un signalement humain écrit dedans disparaîtrait au passage suivant,
sans cause visible. Le dossier « Signalé » montre donc l'UNION des deux sources, et chacune reste lisible pour
elle-même. C'est la séparation que le dépôt fait déjà tenir entre `abusive` (constat, ne déclenche rien) et
`contacts.blocked_at` (décision, a des effets) : la casser ici la rendrait discutable là-bas.

⚠️ NON BLOQUANTE (le code tolère la colonne absente), mais passée AVANT le déploiement : la requête du
dossier est sur le chemin d'affichage de l'Inbox.

Vérifiée EN BASE après coup, comme 0120 à 0122 : `information_schema` pour les deux colonnes,
`pg_indexes` pour le prédicat exact de l'index partiel, et `pg_constraint` pour le `on delete set null` de
l'auteur (`confdeltype = 'n'`, sans quoi le départ d'un collaborateur DÉSIGNALERAIT ses conversations).
Puis la requête du dossier exécutée PAR LE VRAI CODE (`PgInboxStore`), pas par un SQL recopié : compteurs et
listes concordent, et `signaleeMain` remonte à `false`, pas à `undefined`.

⚠️ **ET C'EST UNE SONDE RATÉE QUI A TROUVÉ LE SEUL RESTE DU LOT.** Le premier appel passait
`{ dossier: 'signalees' }` là où l'option s'appelle `signalees: true` : une clé inconnue ne lève rien, le
filtre n'est pas posé, et la liste rend TOUT. Le symptôme n'a été lisible que parce que le compteur était
lu dans le même passage et disait 0. **Une sonde de vérification se lit à côté d'un chiffre qui la contredit**,
sinon elle confirme ce qu'on croyait.

Avant elle : **0122** le 2026-09-08 (`campaigns.business_hours_only` : une campagne peut n'envoyer
que pendant les heures d'ouverture de l'espace, s'arrêter à la fermeture et REPRENDRE au créneau suivant).

🔴 **ELLE NE CRÉE AUCUNE MÉCANIQUE DE REPRISE, ELLE ÉLARGIT CELLE DE 0103**, et c'est ce qui la rend petite :
une campagne hors créneau se met `paused` avec un `paused_until`, exactement comme sur un plafond de débit,
et le balayage existant la relance. D'où ses TROIS changements, dont le troisième est celui qu'on oublie :
la colonne, le CHECK de `pause_reason` (qui n'acceptait que `debit` et `qualite`, donc la mise en pause
aurait échoué à l'écriture, en pleine campagne), et **l'index partiel `campaigns_reprise_idx`, qui est un
CONTRAT AVEC UNE REQUÊTE PRÉCISE** : élargir le `where` de `reprendreCampagnesDues` sans élargir le prédicat
de l'index ne produit AUCUNE erreur, juste un balayage qui parcourt la table des campagnes chaque minute.
`qualite` reste hors des deux : cette pause-là n'a jamais d'échéance.

Le nom de la contrainte de 0103 (créée en ligne, donc nommée automatiquement) a été LU EN BASE avant
d'écrire le `drop constraint if exists` : un nom deviné à côté aurait laissé l'ancienne contrainte en place
ET ajouté la nouvelle, donc rejeté `hors_horaires` en silence, un `if exists` ne protégeant que de l'absence.

Avant elle : **0121** le 2026-09-08 (`conversation_analysis.satisfaction` et `.urgence`, deux `smallint`
NULLABLES bornés 0-10 par un CHECK : l'analyse note où en est le client et à quel point ça presse, et la page
de synthèse en fait un nuage de points).

🔴 **`null` N'EST PAS `0`, ET C'EST TOUTE LA MIGRATION 0121.** Les analyses d'avant n'ont aucune mesure (14 en
base au moment de l'appliquer, toutes à null, vérifié) et n'en auront jamais : on ne réanalyse pas. Les
compter comme zéro rangerait tout l'historique dans le coin « client furieux, urgence nulle ». À l'inverse,
une satisfaction de 0 est une mesure PARFAITEMENT valide, celle qui alarme : un `if (!satisfaction)` la
ferait disparaître de l'écran, qui resterait crédible sans elle. Les deux sens sont tenus par des tests
d'intégration, vérifiés par MUTATION contre une vraie base.

Vérifiée EN BASE après coup, comme la 0120 : `information_schema` pour les deux colonnes, `pg_constraint`
pour les deux CHECK, et la requête du chemin chaud exécutée pour de vrai (elle rend bien 13 lignes à
`(null, null)` sur le premier espace, donc « sans mesure », et aucune à `(0, 0)`).

Avant elle : **0120** le 2026-09-08 (`conversations.archived_at` et son index PARTIEL : ranger une
conversation finie sans rien effacer, l'Inbox étant passée en boîte mail).

Vérifiée AVANT le déploiement du code qui l'écrit, et vérifiée EN BASE plutôt que par l'absence d'erreur :
`information_schema` pour la colonne, `pg_indexes` pour l'index partiel, et la requête du chemin chaud
exécutée pour de vrai. Sans trafic, un silence dans les journaux ne prouve rien.

Avant elle : **0119** le 2026-09-08 (`agent_test_runs`, l'historique des essais du bac à sable, gardé
14 jours).

0119 est le cas d'école de l'ordre : elle CRÉE une table que le code écrit, donc elle est passée AVANT le
déploiement (image construite, `migrate`, puis `up -d --build`). La route, elle, tient sans : son dépôt
d'essais est OPTIONNEL et la liste rend `{essais: []}` quand il manque, ce qui permet de déployer l'écran
avant la table sans que rien ne casse. Vérifiée après coup en interrogeant `pg_indexes` et
`schema_migrations`, pas en constatant l'absence d'erreur dans les journaux.

Avant elle : **0118** le 2026-09-08 (la PROVENANCE d'une fiche de connaissance, `source_type` et
`source_nom` : une fiche issue d'un PDF était jusque-là indiscernable d'une fiche tapée à la main, les deux
ayant `source_url` à null, et l'écran ne peut pas montrer ce qu'il ne sait pas).

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
**[docs/JOURNAL-TECHNIQUE.md](docs/JOURNAL-TECHNIQUE.md) § « Les migrations, une par une ».** Il occupait un
quart de ce fichier pour raconter des migrations appliquées depuis des semaines : un point d'entrée qui
devient une archive cesse d'être un point d'entrée. ⚠️ Il est passé de `documentation.md` à l'archive le
2026-09-09, quand le manuel a été séparé du journal.

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
- 🔴 **QUI PAIE QUOI, ET TOUT N'EST PAS SUR LA MÊME CLÉ.** La **traduction** des conversations
  (`TRADUCTION_MODELE`, `google/gemini-2.5-flash`) et les **tours d'agent** tombent sur le **crédit prépayé
  du client** : ils passent par `gateway`, celui qui porte le résolveur de clé PAR ESPACE. Sur **notre** clé
  maison (`gatewayAide`, construit SANS résolveur) : la **transcription** d'un vocal (décision du 2026-09-09,
  « on le paie nous-mêmes, on verra après si je le refacture »), le **bot d'aide** de la console, et depuis le
  2026-09-14 les **DEUX assistants de configuration** (Meta Business Agent et agent IA) : facturer quelqu'un
  pour apprendre à se servir du produit se retourne contre nous. Cet écart ne se « corrige » pas.
  🔴 **ET CE QUI EST SUR NOTRE CLÉ DOIT PORTER UN PLAFOND, SANS EXCEPTION.** Sur le crédit du client, un
  bavardage se paie tout seul ; sur le nôtre, rien ne le borne. `ASSISTANT_PLAFOND_EUROS_MOIS` (défaut 2 €)
  est compté PAR ESPACE et PARTAGÉ par les deux assistants (`assistant_depense_mois`, migration 0146) ;
  0 le désactive. ⚠️ Il a été câblé sur UN SEUL des deux pendant tout le chantier, alors que le commentaire
  du câblage annonçait lui-même que « les deux moitiés vont ensemble » : relevé par la revue finale du
  2026-09-15, gardé depuis par `tests/agent-setup-evolution.test.ts`.
  ⚠️ `TRADUCTION_MODELE` vide = traduction ÉTEINTE, et l'écran le dit avec la cause `instance` (rien à
  faire côté client) plutôt qu'en parlant d'un crédit qui n'est pas en cause.
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

🔴 **`scopeTenant` ÉCHOUE FERMÉ** (2026-09-03). C'est LE contrôle d'isolation entre clients, pour 235 routes,
et la RLS est contournée (pooler superuser). Elle rendait auparavant le tenant PRIS DANS L'URL quand
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
`signature-meta`, `signature-service`, `jeton-ops`. ⚠️ `jeton-ops` porte AUSSI des `:tenantId`
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

Le journal chronologique (gotchas Meta et décisions par lot) vit dans
[docs/JOURNAL-TECHNIQUE.md](docs/JOURNAL-TECHNIQUE.md), l'archive. Il a d'abord quitté ce fichier pour
`documentation.md`, puis `documentation.md` pour l'archive le 2026-09-09 : la même dérive, deux fois, et
c'est pour ça que le manuel porte désormais une règle qui l'interdit et un test qui la tient.
