# PLAN.md : plan global (programme arrêté le 2026-08-31)

Ce fichier est la référence de SÉQUENCEMENT. Ce qu'on exécute est la section **« LE PROGRAMME »**, sept lots
dans l'ordre ; tout ce qui la précède est l'historique, gardé pour son récit.

**Les quatre sources de constats**, par ordre d'autorité quand elles se recouvrent :
[AUDIT-SYNTHESE-STRUCTURE-SCALABILITE-2026-08-31.md](AUDIT-SYNTHESE-STRUCTURE-SCALABILITE-2026-08-31.md) (la
plus récente, et ses constats ont été REVÉRIFIÉS dans le code), puis
[AUDIT-SCALE-2026-08-25.md](AUDIT-SCALE-2026-08-25.md), puis
[AUDIT-ANTI-SLOP-2026-08-18.md](AUDIT-ANTI-SLOP-2026-08-18.md), puis `AUDIT-SCALE-2026-07-18.md` (les
références Bn et « Railway n » y renvoient).

🔴 **Un document de séquencement qui ne se met pas à jour envoie travailler sur un état périmé.** Ce fichier
l'a fait pendant cinq semaines (revue du 2026-08-29 ci-dessous), puis de nouveau pendant deux jours (il
annonçait R4, R10, R9, R7 ouverts alors qu'ils étaient déployés). Quand un lot est fini, sa ligne bouge ICI,
le jour même.

**Estimations** : développeur seul, à temps plein. « S » = moins d'une journée, « M » = 1 à 3 jours, « L » = une semaine.

---

## Reprise à froid : à lire dans cet ordre

Pour une session qui démarre sans contexte.

1. **`docs/MBA-ARCHITECTURE.md`** (10 min). Ce que MBA implique pour notre code, et pourquoi le
   chantier n° 1 se construit sans attendre Meta. C'est le document qui donne le sens du reste.
2. **Ce fichier**, la section **« LE PROGRAMME »** (arrêté le 2026-08-31). C'est la seule liste à suivre,
   avec ses sept lots dans l'ordre. Les blocs 0 à 5 plus haut sont l'HISTORIQUE : chaque ligne y porte son
   état vérifié, mais on n'y entre que pour comprendre un item, jamais pour choisir quoi faire.
3. **`docs/MBA-API-REFERENCE.md`** seulement quand on code un appel MBA. 3 700 lignes, à consulter
   par chapitre, jamais en entier.

Ne PAS relire `AUDIT-SCALE-2026-07-18.md` en entier : les constats qui restent sont déjà résumés ici.

## 🔴 REVUE DU 2026-08-29 : ce document mentait, et voici l'état vérifié

Cinq semaines sans mise à jour. Les **tableaux** des blocs 1 à 5 présentaient encore comme « à faire » des
items livrés et déployés depuis. La consigne de lecture envoyait droit dessus (« section Bloc 1, le prochain
chantier »), c'est-à-dire vers quatre failles de sécurité annoncées « exploitables aujourd'hui, sur la prod »
et dont **deux sont fermées en production**.

Chaque item a été rouvert et jugé **dans le code**, pas sur son message de commit. Les états portés dans les
tableaux ci-dessous viennent de cette revue. Résultat d'ensemble, sur les 32 items techniques :

| État | À la revue | Après le bloc 1, clos le même jour |
|---|---|---|
| ✅ FAIT | 14 | **16** |
| 🟡 PARTIEL | 12 | **10** |
| 🔴 PAS FAIT | 6 | 6 |

**Deux documents mentaient, et c'est le résultat le plus utile de cette revue :**

- le **tableau du Bloc 3** présentait ses trois items comme à faire ; ils sont faits depuis la migration 0042.
  L'en-tête, lui, disait vrai. Deux récits d'état dans le même fichier, c'est un de trop ;
- le **message du commit `43232c1`** (mm-hubspot) affirme « fin du foot-gun base de prod » et « ce garde-fou
  évite qu'un run local écrive dessus ». **C'est faux** : le garde-fou posé ne couvre que le cas inverse (la CI
  sans base). Un `npm run test:integration` lancé en local écrit toujours sur la base de production. Voir 1.4.

Et une doc périmée trouvée au passage : `documentation.md:1788` décrit encore le lien d'installation
`mm-hubspot.messagingme.app/oauth/install?tenant=<tenantId>`, qui **ne fonctionne plus** (c'est précisément la
faille 1.1, fermée). Quelqu'un qui suit cette ligne conclura que le connecteur est cassé.

**État au 2026-07-24** (conservé tel quel, il reste le meilleur récit du COMMENT) : blocs 0, 2, **3** et **1**
livrés ET DÉPLOYÉS ; bloc **4 à 10/13** ; bloc A aux 3/5.

**TOUT est en production et vérifié** (mba VPS = commit `385ec01`, migrations 0042/0043/0044 appliquées, `APP_DATABASE_URL`=6543 + `DB_SSL_CA_FILE` posées, DB_SSL_INSECURE retiré ; mm-hubspot VPS = `d27ba3f`, dépôt GitHub privé). Détail :
- **Bloc 3** ✅ déployé : migration 0042 (index), frein débit 30/min actif (worker redéployé), CI web.
- **Bloc 1** ✅ déployé (phasé) : `/oauth/install?tenant=` forgeable FERMÉ (jeton signé `?t=`, `HUBSPOT_INSTALL_ALLOW_LEGACY_TENANT=false` en prod), verrou réaffectation numéro, garde cross-portail `/card/action`, CI mm-hubspot. 2 déferrages assumés : retrait `CARD_SECRET` (inerte), route admin réaffectation numéro (feature).
- **Bloc 4** en cours (décision Julien 2026-07-24 : TOUT le bloc 4, dans l'ordre par valeur, Railway ACTÉ) :
  - **4.1 / B1** ✅ déployé, DORMANT (token Meta par tenant ; repli global tant qu'aucun `waba_credentials` -> Zadarma inchangé). Migration 0043.
  - **4.6** ✅ déployé (cœur) : rate-limit login clé sur `ip::email` (plus de plafond global). RESTE : borner trustProxy (needs vérif chaîne XFF Cloudflare->NPM->Next) + compteur DB (Railway multi-réplique).
  - **4.9** ✅ déployé + vérifié live : heartbeat worker (0044, `worker_heartbeat` battu toutes les 20s, best-effort) exposé dans `/ops` (champ `worker` + carte dashboard) ; `QUEUE_NAMES` 4 -> 8 files (source unique `src/queue/names.ts`) ; alerte Telegram env-first (bot ops) sur `queue.onError` + échecs sweepers, throttlée. Crash-loop boot couvert par staleness (pas auto-alerté). Reviewer PASS.
  - **4.5** ✅ déployé + vérifié live (rollout phasé) : anti-rejeu HMAC des canaux /ingest + /service. Format `v1=<ts>.<nonce>.<hex>` (lie ts+nonce+method+path+body) + fenêtre 5 min, remplace `sha256=<corps>` rejouable. mba signe (`signRequest`), mm-hubspot vérifie (`verifyRequest`/`acceptRequestSignature`, legacy gardé derrière `HMAC_ALLOW_LEGACY`, en prod = false). Préimage byte-identique gardée par vecteur d'or (tests des 2 repos). Vérifié end-to-end depuis le conteneur mba. Reviewer PASS.
  - **4.10** ✅ déployé + vérifié live : sweeper worker (~20 min) qui rafraîchit status/quality_rating de tous les numéros (le pull n'était branché que dans la route Accueil) + alerte Telegram sur authError / non-CONNECTED / RED. `status-sweep.ts` (classification pure + dedup par transition Set mémoire, nettoyage sur `pull.ok` seul) ; `PgOpsStore.listNumbersForStatusSweep` (cross-tenant read-only). Pas de migration. Palliatif polling (webhook quality non câblé). Reviewer PASS (après correction d'un 🔴 sur la dedup).
  - **4.3** ✅ déployé + vérifié live (2 temps) : pool applicatif (API + worker) sur le pooler mode TRANSACTION via `APP_DATABASE_URL` (6543) ; pg-boss reste en session (5432). `resolveAppDatabaseUrl = APP_DATABASE_URL || DATABASE_URL` (repli sûr). Sûr car mba search_path-agnostique (public par défaut, mmhs qualifié, transactions via client dédié). Vérifié : /ops (queues 8 + heartbeat via 6543), transaction connect/begin/commit OK, zéro prepared-statement/EMAXCONN. Budget session ~18 -> ~8. Reviewer PASS.
  - **4.7** ✅ déployé + vérifié live : `/live` liveness triviale (zéro DB) + `/health` readiness (`select 1` timeout 2s, 503 si DB KO, catch+reply.code(503) pour éviter le 500). `checkReadiness` optionnel (tests DB-free gardent 200). Healthcheck compose sur `/live` (⚠️ `127.0.0.1` : busybox wget résout localhost en ::1, app bind IPv4 -> bug runtime attrapé en prod). health=healthy vérifié. Reviewer PASS.
  - **4.11** ✅ déployé + vérifié live : vérif TLS COMPLÈTE anti-MITM du pooler (avant : `DB_SSL_INSECURE`, chiffré non vérifié). CA Supabase (intermediate+root) bakée dans l'image (`certs/supabase-pooler-ca.crt`, cert public committé) -> `DB_SSL_CA_FILE`. `pgSsl()` CA_FILE prime sur INSECURE (rollback sûr), readFileSync durci. Couvre 5432 (pg-boss) + 6543 (app). DB_SSL_INSECURE retiré. Pré-vol en conteneur jetable. ⚠️ 2 images (api/worker) à rebuilder séparément (noté DEPLOY.md). CA expire 2031. Reviewer PASS.
  - **4.12** ✅ déployé + vérifié, 2 repos : tsx déplacé devDependencies -> dependencies (mba + mm-hubspot). La prod tourne en runtime tsx ; une install prod-only (npm ci --omit=dev, Railway) l'aurait cassé. Locks régénérés (reclassif seule, zéro bump). Inerte sur le VPS. /health 200 x2, tsx en image. Reviewer-agent sauté (manifeste trivial, auto-vérifié).
  - **4.4-A** ✅ déployé + vérifié : BACKEND_URL du front en `build.args` (le rewrite Next est gelé au build) au lieu du `environment:` no-op. Comportement VPS inchangé (/api/backend/health -> 200). **Option B (route handler proxy runtime) DIFFÉRÉE au groupe Railway** (proxy sur 100% du trafic live, à QA golden paths dans ce contexte).
  - **4.13-doc** ✅ : runbook DR écrit (DEPLOY.md §Restauration), ancré dans le code (3 schémas restaurés ensemble, migrations forward-only, gotcha ENCRYPTION_KEY, secrets hors base, 2 chemins de restore, remise en service). ⚠️ **DRILL + RPO/RTO réels À FAIRE par Julien** (accès dashboard Supabase pour relever le plan de backup + restore vers projet jetable ; non faisable en autonome, MCP Supabase non authentifié).
  - **RESTE (needs Julien / Railway)** : 4.13-drill (dashboard Supabase), puis **groupe Railway** : 4.4-B (proxy runtime), 4.2 (bind IPv6), 4.8 (advisory lock migrations) — à faire à la bascule Railway. Plans détaillés + vérifs : `.loop/bloc4.md` + `scratchpad/bloc4-plans.json` / `bloc4-verifs.json`.
**Tous les items bloc 4 VPS-autonomes sont FAITS.** Reste : 4.13-drill (Julien/Supabase) + groupe Railway (4.4-B/4.2/4.8). Puis A.3/A.5 (attendent MBA), puis 5.

🔴 **~~Dernière migration = 0044, prochaine = 0045.~~ FAUX ET DANGEREUX, corrigé le 2026-08-29 : quarante-trois
migrations de retard.** La dernière APPLIQUÉE est la **0087**, la **0088** attend son déploiement, et la
**prochaine libre est la 0089**. Quelqu'un qui aurait cru cette ligne aurait écrit un fichier `0045_*.sql`
par-dessus une migration existante. Le compteur de référence vit dans `CLAUDE.md` et `DEPLOY.md`, jamais ici :
un numéro recopié dans un troisième document est un numéro qui dérive.

---

## La thèse produit, qui commande tout le séquencement

`mba.messagingme.app` est **la couche de pilotage du MBA de Meta**, pas un constructeur de bot
concurrent. Cinq piliers : onboarder MBA, contrôler finement ce à quoi l'agent répond, **passer la
main à un humain** (le cœur), lancer des campagnes (ce que MBA ne fait pas), analyser et remonter
dans HubSpot. Ce qui ne sert aucun des cinq est probablement hors sujet.

Pari sous-jacent, énoncé par Julien : Meta pousse vers la réponse full IA via MBA, et **au 01/10 les
messages de service deviennent facturables sauf si c'est MBA qui répond**. MBA cesse alors d'être
une option pour les clients. Reste le point d'entrée, qui est notre terrain : un bouton sur le site
laisse MBA répondre, sinon il faut des campagnes ou des pubs CTWA.

**Blocage actuel, contractuel et non technique.** `agent_eligibility` renvoie 403 « Terms of Service
must be accepted ». Aucune ligne de code n'accélère cette date. Deux veilles tournent sur le VPS,
toutes les 6 heures, avec alerte Telegram : `ops/mba-eligibility-watch.mjs` (l'accès) et
`ops/mba-docs-watch.mjs` (la doc, qui arrive au compte-gouttes avant le 01/08).

---

## Décision produit prise le 2026-07-20 : qui répond après une campagne

Chaque campagne **déclare qui reprend la main une fois le message parti**. La règle par défaut se
déduit de la forme de la campagne :

| Forme de la campagne | Détenteur visé après envoi | Raison |
|---|---|---|
| Workflow qui se termine par un bloc **inbox** | `app_human` | le bloc inbox dit explicitement qu'un humain prend le relais |
| Workflow sans bloc inbox | `app_workflow` | le scénario continue de piloter la conversation |
| **Template seul, sans workflow** | `mba` | personne de notre côté n'attend la réponse, MBA doit répondre |

Le défaut est déduit, mais **surchargeable par campagne** dans l'écran de création : c'est
exactement le « ça je fais répondre automatiquement, ça non » qui fait la valeur du produit.

⚠️ **Question non tranchée, et qui doit l'être en conditions réelles** : un envoi sortant prend-il
implicitement le contrôle du fil ? La doc ne le dit nulle part. Si oui, une campagne « template
seul » coupe MBA sur tous ses destinataires jusqu'à un `release` explicite, donc il faudra un
`release` **par destinataire** après l'envoi, avec le coût et le débit que ça implique. C'est le
premier test à faire le jour de l'ouverture, avant toute campagne de volume.

Note sur l'audience : `ai_audience` n'accepte que `ALLOWLISTED_ONLY` ou `EVERYONE`, et l'allowlist
est une liste de **numéros**. Meta n'offre aucune segmentation (pas de « seulement les prospects »,
pas de « seulement ceux venus de CTWA »). **La règle qui produit la liste, c'est notre produit** :
un segment CRM chez nous, poussé dans l'allowlist. C'est typiquement ce qu'une couche d'agence
apporte et que Meta ne fera pas.

---

## ✅ Bloc A : FAIT aux 3/5 (2026-07-21), déployé en production

**A.1, A.2 et A.4 sont livrés et déployés** (migrations 0040 et 0041 appliquées). Le bug de production
est corrigé : un opérateur qui répond dans l'inbox gèle le scénario sur cette conversation.

| # | État | Quoi |
|---|---|---|
| A.1 | ✅ | `control_owner` sur `conversations` (app_workflow / app_human / mba) + `control_changed_at`. Pose sur les deux familles d'émetteurs. Badge dans l'inbox, bouton « Rendre la main », réglage de la durée sur l'Accueil |
| A.2 | ✅ | Gel du scénario en DEUX points : `advance()` et `runFrom()` (ce dernier couvre `start` et `startFromNode`, qui envoient sans rien demander) |
| A.4 | ✅ | Garde-fou d'inactivité (`src/inbox/control-sweep.ts`), délai réglable **par client** (`tenant_settings.control_handback_seconds`), défaut serveur 2 h |
| A.3 | 🔲 | Consommer `standby` et `messaging_handovers`. **Le module existe** (`src/webhooks/handover.ts`, câblé et testé), mais il est INERTE tant que MBA n'est actif nulle part. Il reste à confronter la forme devinée du payload au réel |
| A.5 | 🔲 | Intention de campagne (qui reprend la main après l'envoi). Voir `docs/PLAN-BLOC-A.md` §A.5, réécrit après la chasse aux pièges |

**Ce qui a été RETIRÉ en cours de route, décision de Julien** : le garde qui bloquait les campagnes vers
un contact tenu par un opérateur. Une campagne est un acte délibéré de l'entreprise, pas la continuation
automatique d'un scénario. La règle est « un humain a la main, le scénario se tait », rien de plus.

**À vérifier au premier test MBA réel** (rien de tout ça n'est documenté par Meta) : la forme exacte des
payloads `standby` et `messaging_handovers` (chercher `handover_recu` et `standby_echo` dans les logs du
worker, le payload complet y est journalisé), si un envoi sortant prend le contrôle du fil, ce que fait
un `release` quand on ne détient pas le contrôle, et le délai avant que MBA reprenne effectivement.

---

## La tension à trancher (rédigée le 2026-07-18, toujours valable)

Ton objectif est « des dizaines de clients connectent leur numéro ». **Aujourd'hui cette promesse
est simulée** : les 12 sites d'envoi utilisent un token Meta global unique, et le token business
chiffré de chaque client, écrit en base par l'Embedded Signup, n'est jamais relu (`decryptSecret`
n'a aucun appelant en production). C'est le constat **B1**, effort L.

Or B1 est en bloc 4 ci-dessous. C'est un choix, pas une évidence :

- si le prochain jalon est de **montrer** le produit (démos, premiers rendez-vous), B1 ne se voit
  pas en démo et peut attendre ;
- si le prochain jalon est de **faire signer** un client qui branchera son propre numéro, B1
  remonte avant tout le reste, parce que c'est lui qui rend la promesse vraie.

**Ce que MBA change à cet arbitrage** : le jour où MBA s'ouvre, chaque client aura son propre numéro
et sa propre configuration d'agent, pilotés **par numéro** (Meta ne partage rien entre numéros).
B1 cesse alors d'être une dette de scalabilité pour devenir un prérequis d'exploitation. Il remonte
donc mécaniquement dès que l'éligibilité passe au vert.

Le bloc 1 est à faire dans les deux cas, juste après le bloc A.

---

## ✅ Bloc 0 : FAIT (2026-07-18), déployé en production

| # | Action | Constat | État |
|---|---|---|---|
| 0.1 | `DB_POOL_MAX` (3), `PGBOSS_MAX` (2), `DB_CONN_TIMEOUT_MS` (8000) au zod, câblés dans `src/db/pool.ts` **et** dans les deux `PgBossQueue`. `poolOptions` extrait en fonction pure (piège `max: 0`). `onError` exposé et attaché avant `start()` dans les deux process | B2 | ✅ |
| 0.2 | Les deux `setErrorHandler` journalisent un JSON (méthode, url, tenant, message, stack) sur les 5xx avant de renvoyer le corps opaque. Côté mm-hubspot l'URL est tronquée avant la query | B9 | ✅ |
| 0.3 | Fail-fast production sur `DATABASE_URL` et `META_APP_SECRET` vides. Vérifié : `.env.prod` porte bien `NODE_ENV=production`, donc le `superRefine` s'exécute réellement | B9 | ✅ |
| 0.4 | `getAccountStatus` sorti de la rafale dans son propre `loadAccount` avec son état `accountLoading`, le reste en `Promise.allSettled`, branche « Statut indisponible » + bouton Réessayer, retry unique sur 5xx réservé aux GET/HEAD | bug Dashboard | ✅ |

**Invariant posé par ce bloc** : « Aucun numéro » ne s'affiche QUE si le statut est chargé ET dit qu'il n'y en
a pas. Ne jamais affirmer une absence qu'on n'a pas constatée.

Reviewer séparé : FAIL au premier passage (un trou réel dans 0.4, `loading` passait à false avant que le statut
n'arrive, ce qui affichait « Aucun numéro » de façon transitoire mais systématique), puis PASS après correction.
5 🟡 fermés dans la foulée, dont une fuite du code d'autorisation HubSpot dans les logs que 0.2 venait
d'introduire, et deux tests qui étaient des faux témoins. Tests : 875 -> 886.

**Reportés en backlog, arbitrage assumé** : `/ops/overview` consomme les 3 connexions du pool d'un coup
(surface admin rare, protégée par `OPS_TOKEN`) ; abaisser les plafonds à 2/1 pour rentrer strictement sous les
15 coûte en latence pour un gain marginal tant que le mode transaction (bloc 4) n'est pas fait.

---

## ✅ Bloc 1 : sécurité. Les quatre failles sont FERMÉES en production (revue 2026-08-29)

⚠️ Ce bloc annonçait quatre points « exploitables aujourd'hui, sur la prod ». **Aucun ne l'est plus.** Il
reste deux gestes d'hygiène, sans exploitation possible en l'état.

| # | Action | État vérifié le 2026-08-29 |
|---|---|---|
| 1.1 | `/oauth/install` acceptait un `?tenant=` arbitraire sans authentification | ✅ **FAIT, et en prod.** Le lien est émis par mba sur une route JWT admin (`src/http/hubspot-install.ts`, tenant pris par `scopeTenant`, jamais dans l'URL) et vérifié côté connecteur (HMAC, TTL 10 min, `timingSafeEqual`, fail-closed si le secret est vide). Le conteneur qui tourne sur le VPS porte bien `HUBSPOT_INSTALL_ALLOW_LEGACY_TENANT=false`. Test : `?tenant=nimporte-qui` rend 400. ⚠️ Le drapeau reste dans le code comme voie de retour : le reposer à `true` rouvrirait la faille à l'identique |
| 1.2 | L'Embedded Signup réaffectait silencieusement un numéro d'un tenant à un autre | ✅ **FAIT, et en prod, les deux moitiés.** La garde `where tenant_id = excluded.tenant_id` est sur les trois tables (`es-store.pg.ts`), chacune suivie d'un `TenantConflictError` traduit en 409 AVANT tout appel Meta, le tout en transaction. Et la revalidation dans `campaignRunJob` existe et est câblée par le worker. 🔸 Seul déferrage assumé : la route admin de réaffectation VOULUE d'un numéro entre workspaces. C'est une feature d'exploitation, pas un trou |
| 1.3 | ~~`POST /card/action` : garde cross-portail contournable~~ | ✅ **FAIT EN ENTIER le 2026-08-29, déployé.** `portalId` exigé (un doublon arrive en tableau, donc 400), filtre `hub_id` poussé dans le SQL des deux routes avec 404 uniforme (pas d'oracle), **et le repli bearer `CARD_SECRET` est supprimé du code**, pas seulement de la production. Vérifié en prod : `/card/context` rend 401 sans signature, et 401 avec un faux bearer. `tests/card-auth.test.ts` interdit son retour |
| 1.4 | ~~mm-hubspot sans CI ni remote GitHub, `DATABASE_URL` local sur la prod~~ | ✅ **FAIT EN ENTIER le 2026-08-29.** Remote GitHub privé, CI à deux jobs qui tourne vraiment, `throw` au lieu de `skipIf` en CI, **et surtout le dernier quart** : `tests/integration/env.ts` refuse désormais tout hôte qui n'est ni `localhost` ni `127.0.0.1`, dérogation explicite `ITEST_ALLOW_REMOTE=1`. Vérifié dans six directions, dont l'URL illisible (refusée, fail closed). ⚠️ Le commit `43232c1` prétendait ce travail fait : il ne l'était pas |

---

## ✅ Bloc 2 : FAIT (2026-07-19/20), le lot de features demandé, 8/8

Arbitrages déjà tranchés par Julien le 2026-07-18, intégrés ci-dessous.

> Les 8 items sont livrés et revus (commits 10cef93, 07b8d40, 01156ab). Aucune migration restante :
> 0037, 0038 et 0039 étaient déjà appliquées, le code les lit désormais.
>
> `.loop/lot2-cartographie.md` (cartographie des points d'insertion, ~500k tokens à produire) reste sur disque,
> gitignorée. Elle a servi et a attrapé plusieurs pièges non évidents ; la garder tant que le lot n'est pas
> validé à l'écran par Julien.

| # | Action | Décision / note | Effort |
|---|---|---|---|
| 2.1 | ✅ **FAIT** Menu « Developers » en bas de la sidebar, avec deux entrées : documentation de l'API et gestion des clés. Aujourd'hui les clés se créent en curl, la page n'existe pas (c'est la « Phase C » différée du Palier 3) | **Plusieurs clés nommées** par espace (ce que le backend fait déjà) : créer, lister, révoquer. Clé affichée en clair une seule fois à la création | M |
| 2.2 | ✅ **FAIT** Analytics en sous-menus quanti / quali dans la sidebar | quanti = le dashboard actuel ; quali = le bloc Conversations (analyse) déjà construit au Lot 9, extrait dans sa propre page | S |
| 2.3 | ✅ **FAIT (2026-07-18)** Date de dernière connexion par compte sur la page Équipe | Migration 0037 appliquée. Écrite sur les **5** émissions de session (login, login Google, inscription, inscription Google, acceptation d'invitation), en fire-and-forget, et APRÈS le contrôle `disabled` du chemin Google. 5 tests | ✅ |
| 2.4 | ✅ **FAIT** Créer un template depuis l'écran Campagne, dans la liste de choix, en réutilisant le formulaire de création existant | ⚠️ La liste est filtrée sur `APPROVED` : un template neuf n'y apparaîtra pas tant que Meta ne l'a pas approuvé. À dire explicitement à l'écran, sinon le bouton paraît cassé | M |
| 2.5 | ✅ **FAIT** Bouton supprimer sur la liste des campagnes | **Archivage**, sauf les brouillons jamais lancés qui sont supprimés pour de bon. Une campagne envoyée porte l'historique qui alimente les analytics : la masquer, pas l'effacer. Filtre « voir les archivées » | M |
| 2.6 | ✅ **FAIT** Historique par contact : quelle campagne et quel template lui ont été envoyés et quand, plus toutes les conversations tenues avec lui et leur analyse | Nouvelle route de lecture scopée tenant, plus un onglet sur la fiche contact. Le plus gros item du lot | M |
| 2.7 | ✅ **FAIT (2026-07-18)** Renommer « Contacts » en « mini-CRM » dans la sidebar | Libellé seulement, l'URL `/contacts` ne bouge pas | ✅ |
| 2.8 | ✅ **FAIT** Support : le mail part déjà, et il arrive déjà chez toi. Rien à changer sur la destination. Ce qu'il faut corriger : le `catch {}` sans binding qui perd le message en silence, l'absence de rate limit sur une clé Resend partagée avec les mails de reset, et le reply-to pris dans le corps de la requête au lieu du JWT | §6B | M |

---

## ✅ Bloc 3 : FAIT en entier (vérifié le 2026-08-29), déployé

C'est ce tableau qui a menti le plus longtemps : il présentait ses trois items comme à faire alors qu'ils
étaient livrés.

| # | Action | État vérifié le 2026-08-29 |
|---|---|---|
| 3.1 | Les index manquants | ✅ Migration `0042_scale_indexes.sql`, six index, dont les deux nommés par l'item |
| 3.2 | Rate limiter du worker | ✅ Point de résolution unique `resolveRatePerMinute` (`src/campaign/pacing.ts`), défaut serveur à 30/min, et le MÊME calcul sert au dimensionnement de l'expiration du job, ce qui évite le désalignement pacing / run-job |
| 3.3 | Job CI pour `web/` | ✅ Le front est compilé et buildé par la CI |

---

## Bloc 4 : avant la bascule Railway. 6 faits, 5 partiels, 2 intacts (revue 2026-08-29)

Verdict Railway : **pas prêt**, mais les blocages sont peu nombreux et identifiés. Les deux services
sont fondamentalement portables (pas d'écriture disque, `PORT` lu de l'environnement, SIGTERM géré,
sweepers sûrs en multi-réplique).

**État vérifié le 2026-08-29.** Le tableau détaillé qui suit décrit ce que chaque item DEMANDAIT ; cette
grille dit où il en est. Presque tout ce qui restait est du côté **connecteur** ou attend Railway.

| # | État | Ce qui reste, s'il reste quelque chose |
|---|---|---|
| 4.1 | 🟡 PARTIEL | Le cœur est déployé (dormant). Reste : exposer `token_status` dans la réponse de statut de compte et l'afficher, et faire persister le `paused` de run-job (sinon une campagne bloquée par un jeton mort reste `running` en silence) |
| 4.2 | 🔴 PAS FAIT | Remplacer `'0.0.0.0'` par `'::'` dans les deux `index.ts`, puis rebasculer le healthcheck du compose sur `localhost`. **Attend la bascule Railway** |
| 4.3 | ✅ FAIT | Pool applicatif en mode transaction via `APP_DATABASE_URL`, pg-boss reste en session |
| 4.4 | ✅ FAIT | `BACKEND_URL` en `build.args`. Reste seulement l'option B (proxy runtime), différée au groupe Railway |
| 4.5 | ✅ FAIT | Anti-rejeu HMAC (`v1=<ts>.<nonce>.<hex>`), vérifié de bout en bout |
| 4.6 | 🟡 PARTIEL | Le cœur est fait (plafond de login par `ip::email`). Reste : borner `trustProxy` sur mba après vérification de la chaîne Cloudflare vers NPM vers Next, remplacer le `trustProxy: true` du connecteur, et porter les compteurs en base pour le multi-réplique |
| 4.7 | 🟡 PARTIEL | Fait sur mba (`/live` + `/health` avec `select 1` et 503). **Pas sur le connecteur**, dont le `/health` répond 200 même base morte : il ne dit donc rien de son état |
| 4.8 | 🔴 PAS FAIT | Advisory lock autour de la boucle de `migrate.ts`, sortie en 0 si le verrou est pris, un seul service porteur. **Attend Railway** (sans réplique, le risque est nul) |
| 4.9 | ✅ FAIT | Heartbeat worker, `/ops`, files 4 vers 8 avec source unique, alerte Telegram |
| 4.10 | ✅ FAIT | Sweeper de statut et qualité des numéros, avec alertes |
| 4.11 | 🟡 PARTIEL, et c'est le plus gênant du bloc | Fait sur mba (CA bakée, `DB_SSL_INSECURE` retiré). **Pas du tout sur le connecteur** : mesuré le 2026-08-29 sur le VPS, `mm-hubspot` tourne toujours avec `DB_SSL_INSECURE=true`, donc son trafic Postgres est chiffré mais **non vérifié**, sans authentification du serveur. Et c'est le service qui manipule les jetons OAuth HubSpot déchiffrés. Le constat d'origine reste donc entièrement ouvert là où il compte le plus |
| 4.12 | ✅ FAIT | `tsx` en dependencies dans les deux dépôts |
| 4.13 | 🟡 PARTIEL | Le runbook est écrit (`DEPLOY.md`). **Le drill n'a jamais été fait** : RPO et RTO restent théoriques. Demande le dashboard Supabase, donc Julien |

| # | Action | Constat | Effort |
|---|---|---|---|
| 4.1 | **Résolution du token Meta par tenant** : `resolveMetaCredentials`, fabrique `metaClientFor`, les 12 sites, expiration et révocation, état `token_invalid` par tenant, test prouvant que deux tenants produisent deux tokens | **B1** | L |
| 4.2 | Bind `'::'` au lieu de `'0.0.0.0'` dans les deux `index.ts` : le réseau privé Railway est **IPv6 uniquement**, les appels mba vers mm-hubspot échoueront dès la bascule | Railway 1 | S |
| 4.3 | Passer l'API mba en mode **transaction** sur le pooler (après test du `search_path` de mm-hubspot). Le mode session n'est nécessaire qu'à pg-boss | §4 | M |
| 4.4 | `BACKEND_URL` est figé au **build** du front : la ligne `environment:` du compose est un no-op complet aujourd'hui. Déplacer en `build.args`, déclarer en variable de build sur Railway, ou route handler Next au runtime | Railway 3 | M |
| 4.5 | Horodatage, nonce, méthode et chemin dans le HMAC de `/service/*` et `/ingest` : sur Railway le blocage NPM disparaît, et un corps signé capturé est rejouable indéfiniment | Railway 6 | M |
| 4.6 | `trustProxy` correctement borné (**jamais** `true`, sinon contournement total par `X-Forwarded-For`) et compteurs d'authentification en base. Aujourd'hui `req.ip` est l'IP du conteneur `mba-web` : le plafond de 10 logins par minute est **global à la plateforme** | B11 | M |
| 4.7 | `/health` avec `select 1` et 503, `/live` trivial séparé | Railway/B9 | S |
| 4.8 | Advisory lock dans `db/migrate.ts`, un seul service porteur de la release command | Railway 8 | M |
| 4.9 | Heartbeat du worker en base exposé dans `/ops`, `QUEUE_NAMES` complété (4 files sur 8 aujourd'hui), alerte Telegram extraite du script cron | B9 | M |
| 4.10 | Sweeper de rafraîchissement du statut et de la qualité des numéros, alerte sur RED, sur `status != CONNECTED` et sur `authError`. Aujourd'hui `quality_rating` n'est écrit que quand un **admin** ouvre la page d'accueil | B7 | M |
| 4.11 | CA Supabase montée + `DB_SSL_CA_FILE`, puis retrait de `DB_SSL_INSECURE`. ⚠️ Le commentaire du `.env.prod.example` qui dit que le certificat est public est **faux et périmé** : le correctif naïf casse la prod | Railway 10 | S |
| 4.12 | `tsx` en dependencies (la prod tourne dessus alors que c'est une devDependency), ou réparer le chemin compilé. `npm start` n'a **jamais** fonctionné dans aucun des deux repos | Railway 4, 9 | S |
| 4.13 | Écrire et **tester une fois** la procédure de restauration, avec RPO et RTO réels | Railway 11 | M |

**Point non négociable** : garder `mm-hubspot.messagingme.app` en CNAME devant Railway. L'URL est figée
dans le redirect OAuth et l'allowlist de l'app HubSpot, poussée à la main, en distribution marketplace.
Une URL `*.railway.app` casse le callback OAuth de toute nouvelle installation, sans rollback possible.

---

## Bloc 5 : après, par ordre de valeur. 1 fait, 7 partiels, 4 intacts (revue 2026-08-29)

**État vérifié le 2026-08-29**, avant le tableau d'origine qui dit ce que chaque item demandait.

| # | État | Ce qui reste |
|---|---|---|
| 5.1 | 🟡 PARTIEL | La moitié CONFORMITÉ est faite le 2026-08-29 : un STOP en WhatsApp désabonne, par le prédicat partagé `src/crm/consentement.ts`. Reste la moitié INTÉGRATION : `/v1/contacts` ne sait toujours pas dire « désabonné » (il faut un champ `optOut` explicite ET une seconde écriture après l'upsert, qui ne sait que promouvoir). Détail dans `todo.md` |
| 5.2 | 🟡 PARTIEL | **La partie structurelle est FAITE le 2026-08-31** (migration 0093) : `webhook_events` porte le numéro destinataire, donc son espace ; purge par rétention de 30 j ; et la purge par contact l'efface, scopée au tenant. Reste la rétention des CONVERSATIONS et analyses, qui attend UN NOMBRE DE JOURS de Julien (décision produit n°2 plus bas) |
| 5.3 | 🟡 PARTIEL | La file `agent-turn` a apporté une partie du mécanisme. Reste : `groupId = tenantId` à l'enfilage, découper `campaign-run` en lots, et surtout **déplacer le throttle au niveau du NUMÉRO** |
| 5.4 | 🔴 PAS FAIT | L'item entier. Bloquant dès qu'un client veut un second numéro |
| 5.5 | 🔴 PAS FAIT | L'item entier. Aggravant intact : l'erreur Meta de plafond n'est ni retryable ni terminale |
| 5.6 | 🟡 PARTIEL | L'extraction est faite (audit du 2026-08-18). Reste : remplacer le repli de `scope.ts` par un refus, et rendre la garde de boot exhaustive **par construction** plutôt qu'énumérée à la main, puisque c'est l'énumération manuelle qui a laissé passer les trous |
| 5.7 | 🔴 PAS FAIT | `schemaVersion` dans le contrat vers le connecteur, et zod sur les VALEURS d'enum |
| 5.8 | 🟡 PARTIEL | Pagination Contacts non exposée (ou au minimum dire que la liste est tronquée à 500), `AbortController`, et un `catch` silencieux à remplacer par un état d'erreur affiché |
| 5.9 | 🔴 PAS FAIT | Et légèrement empiré : la divergence de `ssl.ts` fait que le durcissement de 4.11 ne protège pas le connecteur |
| 5.10 | ✅ FAIT | Code mort nettoyé et les quatre commentaires mensongers corrigés |
| 5.11 | 🟡 PARTIEL | Le travail a changé de fichier sans être fait. Le volume à extraire du worker a été multiplié par près de 8 |
| 5.12 | 🟡 PARTIEL | Préalable jamais fait, et il bloque aussi 4.13 : relever le plan Supabase réel au dashboard |

| # | Action | Constat | Effort |
|---|---|---|---|
| 5.1 | **Opt-out écrivable** : aucun chemin n'existe aujourd'hui pour désinscrire un contact (`markOptedIn` ne fait que promouvoir, le webhook ne connaît ni STOP ni DESABONNER), alors que le front affiche déjà un badge « opt-out ». ⚠️ **À remonter en bloc 1 si tu envoies du marketing en volume avant** : c'est de la conformité | B6 | M |
| 5.2 | Rétention et purge : `webhook_events` d'abord (jamais purgée, sans `tenant_id`, donc effacement RGPD structurellement impossible), puis conversations et analyses, puis routine d'effacement par contact | B8a, B8b | M |
| 5.3 | Concurrence worker : `localConcurrency` et `groupConcurrency` par tenant, découpage de `campaign-run` en lots, throttle au niveau du **numéro** | B4 | L |
| 5.4 | Multi-numéro : `phone_number_id` sur `conversations` et `workflow_runs`, unicité `(tenant_id, phone_number_id, wa_id)`, `is_default`, suppression de `getTenantPhoneNumberId` | **B3** | L |
| 5.5 | Appliquer `messaging_limit_tier` à la création de campagne et au dimensionnement du débit | B7 | M |
| 5.6 | Extraire `scopeTenant` (copié **19 fois**), compléter la garde de boot (liste incomplète : inbox, stats, settings, media, tags, fields), test paramétré cross-tenant, test statique sur les `.pg.ts` | B10 | M |
| 5.7 | `schemaVersion` dans le contrat mba vers mm-hubspot, schéma zod couvrant les **valeurs d'enum** (aujourd'hui `z.record(z.unknown())` : un changement de valeur passerait sans bruit sur 100 % des escalades) | §5 | M |
| 5.8 | Frontend : pagination et recherche serveur sur Contacts et Inbox, `AbortController`, distinguer erreur et état vide | §5 | M |
| 5.9 | Extraire les modules infra réellement communs (`ssl.ts` est identique octet pour octet). Aligner le chiffrement de mm-hubspot sur le format versionné de mba (formats **incompatibles** aujourd'hui) | §5 | L |
| 5.10 | Nettoyage du code mort : `contactIdentity`, `systemFieldCode`, `resolveTag`, `FLOW_TEXT_KINDS`, `pullPending` et son harnais orphelin, `conversations.hub_id`, `listAllContacts`. Et surtout **corriger les commentaires mensongers** (`identity.ts:2`, `user/store.pg.ts:220`, `llm-client.ts:9`, `.env.prod.example:19`) qui dissuadent activement le prochain lecteur de chercher le problème | §5 | S |
| 5.11 | Découper `web/app/campaigns/page.tsx` (1384 lignes, dont un composant de 929 lignes avec 36 `useState`) et extraire la logique métier du corps de `main()` dans `worker.ts` (113 lignes inatteignables par tout test) | §5 | L |
| 5.12 | Sortir du plan Supabase actuel vers un projet dédié ou pgbouncer en mode transaction, **avant le dixième client** | §4 | M |

---

## Ce qui n'attend pas du code

- **Phase 3 HubSpot** : activer le toggle, cliquer le CTA de re-consentement sur le portail cobaye 139615673, approuver « Lists », faire un import de test et vérifier que les contacts ne sont pas en `opted_in`.
- **App Review Meta** : en review depuis le 2026-07-17, environ 20 jours. Débloque l'Embedded Signup de bout en bout.
- **Un template Marketing FR à variable** à faire approuver.
- **Les vérifications visuelles accumulées** (Palier 3 B2, Palier 2, Lots 7, 8 et 9), détaillées dans `todo.md`, plus les 8 items du bloc 2 livrés le 2026-07-20 et jamais vus à l'écran.
- **MBA** : accepter les Terms of Service Meta Business Agent dans WhatsApp Manager le jour où l'onglet apparaît, et les Tech Provider ToS dans le portail développeur. Rien de tout ceci n'est faisable par API, et les deux veilles alertent sur Telegram quand ça bouge.

---

## 🔴 LE PROGRAMME (arrêté le 2026-08-31 avec Julien) — c'est LA liste à suivre

Les blocs 0 à 5 plus haut sont l'HISTORIQUE. Ce programme-ci est ce qu'on exécute, dans cet ordre.

**Origine.** Les trois audits (`AUDIT-SCALE-2026-07-18`, `AUDIT-ANTI-SLOP-2026-08-18`,
`AUDIT-SCALE-2026-08-25`) plus la synthèse `AUDIT-SYNTHESE-STRUCTURE-SCALABILITE-2026-08-31.md`, dont **chaque
constat factuel a été revérifié dans le code le 2026-08-31** (codes Meta, limiteur par run, absence de
concurrence sur `campaign-run`, `setStateSiEncoreSur` à un seul appelant, absence de version de graphe, file
`webhook` unique, heartbeat à ligne unique, `GET /nodes`, recherche de connaissance dupliquée, tailles de
fichiers). Aucun constat faux trouvé, et un sous-estimé : les codes de plafond Meta ne sont pas « non
classés », ils tombent dans le défaut TERMINAL, donc ils brûlent les destinataires.

### 🔴 Deux règles de méthode, tranchées par Julien le 2026-08-31

1. **On ne conditionne PAS ces chantiers à l'arrivée des clients.** J'avais proposé des déclencheurs (« à la
   première campagne de 2 000 destinataires ») ; Julien a tranché l'inverse, et son argument est le bon : un
   quota par numéro ou un claim atomique **se posent à froid**. Sous charge, avec des clients qui râlent,
   c'est une opération à cœur ouvert. Le commercial est son terrain, pas une condition technique.
2. **Un refactor n'est pas de la vélocité, c'est du temps de diagnostic quand ça pète.** Un fichier de 1 686
   lignes à 48 états se paie au pire moment, pas au moment tranquille. Les refactors sont donc des LOTS à part
   entière, placés AVANT le chantier qui touche le même fichier. ⚠️ Ce qui reste non négociable : **un refactor
   et un changement de comportement ne partent jamais dans le même commit** — sinon on ne sait pas lequel des
   deux a cassé.

| Lot | Contenu | Migration | Ce que ça achète |
|---|---|---|---|
| **1** | Codes de plafond Meta + pause · claim atomique de l'avance · recherche de connaissance mutualisée · refus explicite du 2e numéro | non | Ce qui casse AUJOURD'HUI |
| **2** | Rétention des conversations et analyses (12 mois) | oui | Ferme 5.2 pour de bon |
| **3** | Registre de tâches du `worker.ts`, `register*Jobs` | non | Ranger AVANT d'y ajouter files et timers (lots 5 et 6) |
| **4** | Throttle partagé par numéro, sur les 4 chemins d'envoi | à voir | Le prérequis de TOUTE concurrence |
| **5** | Campagnes en lots courts, puis `groupId` + concurrence | non | Une campagne cesse d'être un job de 3 h |
| **6** | Découpage de `CampaignCreateForm`, puis files webhook séparées | non | L'entrant cesse d'attendre derrière les accusés |
| **7** | Extraction du `WorkflowBuilder`, puis versions publiées de scénarios | oui | Modifier un scénario cesse de changer les parcours en cours |

**En fil de l'eau, quand le fichier est déjà ouvert** : découpage de `web/lib/api.ts` derrière un barrel, et
les index des jaunes de la §7 de l'audit du 25 août — dont le `regexp_replace` NON INDEXABLE de la résolution
`wa_id -> contact`, qui est le chemin le plus chaud du produit (chaque message entrant y passe).

**Le niveau « deux workers »** est largement fermé par les lots 4, 5 et 6. Ce qui restera : heartbeat par
INSTANCE (aujourd'hui une ligne unique `id='worker'`, donc un worker mort est masqué par un vivant), advisory
lock des migrations, audit des sweepers, et recalcul du budget de connexions (les pools se multiplient par le
nombre de process). Une demi-session, le jour où un deuxième worker est voulu.

### Détail des lots, et le piège de chacun

- **Lot 1.** Les codes `130429` et `131048` sont absents des deux listes de `src/meta/errors.ts`, donc traités
  par le défaut « 4xx sans code connu = terminal » : un plafond Meta ne ralentit pas la campagne, il **échoue
  définitivement chaque destinataire restant**. Le claim d'avance : `setStateSiEncoreSur` existe, est testé, et
  n'a qu'UN appelant (le tour d'agent) ; les huit écritures de l'exécuteur passent par `setState`, un `update
  where id` nu. La course API/worker est atteignable dès aujourd'hui sur les rappels RCS. La recherche de
  connaissance est recopiée à l'identique entre production et bac à sable, et leurs erreurs ont déjà divergé :
  c'est le garde-fou anti-hallucination.
- **Lot 2.** 12 mois, pas 3 : Julien a donné un PLANCHER de 3 mois (RGPD), et l'effacement est irréversible.
  Quatre fois le plancher, une variable d'environnement pour descendre, dans ce sens-là sans danger.
- **Lot 4.** Le limiteur est instancié PAR RUN (`run-job.ts`) : deux campagnes du même numéro ont deux budgets.
  Et les envois inbox, scénario et automation n'ont **aucun** limiteur. Version mono-worker d'abord (registre
  en mémoire par `phone_number_id`) ; distribué seulement au deuxième worker.
- **Lot 5.** `queue.work('campaign-run')` ne passe AUCUNE option : un job traite sa campagne jusqu'à
  épuisement, soit 2 h 47 pour 5 000 destinataires à 30/min. Viser une DURÉE de lot bornée, pas un nombre fixe.
- **Lot 7.** `workflow_runs` porte `workflow_id` et `current_node`, jamais une version : modifier un bloc
  change les parcours déjà démarrés. Version partagée référencée, jamais une copie du graphe par run.

---

## Ce qui reste HORS programme, et l'historique des reprises précédentes

Le programme ci-dessus est la liste à suivre. Ce qui suit est ce qui n'y entre pas (parce que ça n'attend que
Julien, ou une bascule d'infrastructure), plus les reprises précédentes gardées pour leur récit.

### ~~1. Conformité : l'opt-out WhatsApp (5.1)~~ ✅ FAIT le 2026-08-29, déployé

Un contact qui écrit STOP est désinscrit. Le prédicat de détection existait déjà (écrit et testé pour le RCS),
il n'était simplement pas relié au canal WhatsApp ; il vit maintenant dans `src/crm/consentement.ts`, partagé
par les deux canaux.

### ~~1-bis. L'audit du 25 août~~ ✅ CLOS le 2026-08-31 : plus aucun rouge ni orange

R1, R1-bis, R13, R4, R10+J2, R9 et R7 sont faits et déployés. Restent R11+J3, sans objet tant qu'un seul
worker tourne, et **les 23 jaunes de sa §7, qui n'ont jamais été ouverts** : ils se relisent à la source,
c'est la seule liste de dette de performance encore intacte de cet audit. Deux leviers ont été laissés
sciemment avec leur condition de réouverture (file d'import, colonne `unread` dénormalisée), en tête de
[todo.md](todo.md), qui est la liste vivante. Pas ici.

### ~~2. Deux gestes d'hygiène de sécurité~~ ✅ FAIT le 2026-08-29, déployé

Le **bloc 1 est clos en entier**, code et production. `CARD_SECRET` n'existe plus (vérifié en prod :
`/card/context` rend 401 sans signature ET avec un faux bearer), et un `test:integration` local refuse
désormais tout hôte distant. Détail dans le tableau du bloc 1.

### ~~3. Le connecteur est le parent pauvre du durcissement~~ ✅ FAIT le 2026-08-31, déployé

Les trois items faits sur mba et jamais portés sur mm-hubspot sont fermés en une passe : **4.7** (son `/health`
rendait 200 base morte, il rend 503, et `/live` prend le rôle de cible de redémarrage), **4.11** (CA du pooler
bakée dans son image, `DB_SSL_INSECURE` retiré du `.env.prod` — il a tourné SIX SEMAINES en chiffré mais non
vérifié, sur le service qui manipule les jetons OAuth HubSpot déchiffrés), **4.6b** (`trustProxy: true` retiré :
rien ne lisait `req.ip`, donc zéro changement de comportement). Plus `npm ci --omit=dev`.
⚠️ Il reste UN trou du même type là-bas, consigné dans le `todo.md` du connecteur : son transport HTTP n'a
aucun plafond de temps, alors que mba a fermé le sien le même jour.

### 4. Ce qui attend Julien et rien d'autre — S de temps, mais bloquant

- **4.13-drill et 5.12** : relever le plan de backup au dashboard Supabase. Ce seul relevé débloque le RPO
  réel, le drill de restauration, ET la décision de sortir du plan partagé. Trois items pour un login.
- **H1, H2, H3** : Phase 3 HubSpot, App Review Meta, template Marketing FR. Aucun code.

### 5. Ce qui attend la bascule Railway, et seulement elle

**4.2** (bind IPv6) et **4.8** (advisory lock de migration). Sans réplique et sans réseau privé IPv6, ni l'un
ni l'autre ne protège de quoi que ce soit aujourd'hui. Les faire maintenant serait du travail rangé d'avance.

### 6. Le reste, par valeur décroissante

⚠️ Ces numéros sont désormais REPRIS par le programme ci-dessus, qui fait foi : **5.2-reste** = lot 2,
**5.3** = lot 4, **5.5** = lot 1, **5.4** = tranché (un seul numéro par client, donc refus explicite, lot 1),
**5.11** = lots 3, 6 et 7. Restent hors programme, par valeur décroissante : **5.6** (garde de boot exhaustive
par construction), **5.7** (`schemaVersion` du contrat vers le connecteur), **5.8** (pagination et
`AbortController` côté front), **5.9** (modules infra communs aux deux dépôts).

### Ce qui ne devrait PLUS être fait

- **H4, les vérifications visuelles accumulées.** Un écran regardé ne laisse aucune trace : l'item est
  invérifiable par construction et il ne se videra jamais. À reconstruire depuis ce qui reste réellement
  ouvert dans `todo.md`, ou à supprimer.
- **La route admin de réaffectation d'un numéro** (le reste de 1.2). Elle est listée comme un item de
  sécurité alors que la faille est fermée : c'est une feature d'exploitation, à traiter comme telle, le jour
  où quelqu'un en a besoin.

---

## Décisions produit

### ✅ Tranchées par Julien le 2026-08-31

1. **UN SEUL numéro WhatsApp par client.** Le chantier multi-numéro (5.4, effort L) sort du plan. À la place,
   un **refus explicite** du second numéro, avec un message clair, dans le lot 1 : aujourd'hui il serait
   accepté et fusionnerait des conversations en silence. À rouvrir si le produit vend un jour le multi-numéro,
   et la liste des chemins à propager est dans le §A8 de la synthèse du 2026-08-31.
2. **Conversations gardées AU MOINS 3 mois** (plancher donné par Julien, motif RGPD). Retenu : **12 mois par
   défaut**, quatre fois le plancher, parce que l'effacement est irréversible et qu'un an est la durée
   défendable devant une DSI. Variable d'environnement : descendre est sans danger, c'est l'inverse qui ne se
   rattrape pas.

### Encore à trancher

Elles changent le coût, pas la faisabilité.

1. **Le cap anti-répétition marketing** (désactivé en dur depuis le 2026-07-15) reste-t-il la politique des 30 clients ? Si tu le réactives, crée l'index d'abord, sinon la garde coûte plus cher que l'envoi qu'elle protège.
4. **Le segment CRM qui alimente l'allowlist MBA** : quels critères (tags, opt-in, origine CTWA, ancienneté) et qui a le droit de les modifier ? C'est la brique qui rend `ALLOWLISTED_ONLY` utilisable, et Meta n'en fournit aucun équivalent. À cadrer avant de coder l'écran, pas pendant.
