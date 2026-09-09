# documentation.md : le manuel technique d'Engage Me

> **Ce fichier décrit le système TEL QU'IL EST.** Il ne raconte pas comment on y est arrivé : ça, c'est
> [docs/JOURNAL-TECHNIQUE.md](docs/JOURNAL-TECHNIQUE.md), qui ne fait jamais autorité sur le présent.

## Table des matières

1. [Objet, public, et qui dit la vérité](#1-objet-public-et-qui-dit-la-vérité)
2. [Le système en dix minutes](#2-le-système-en-dix-minutes)
3. [Carte des domaines](#3-carte-des-domaines)
4. [Les quatre flux critiques](#4-les-quatre-flux-critiques)
5. [Données et multi-tenant](#5-données-et-multi-tenant)
6. [Asynchrone, concurrence, idempotence](#6-asynchrone-concurrence-idempotence)
7. [Sécurité et secrets](#7-sécurité-et-secrets)
8. [Configuration](#8-configuration)
9. [Tests et preuves](#9-tests-et-preuves)
10. [Exploitation](#10-exploitation)
11. [Limites connues](#11-limites-connues)
12. [Invariants actifs](#12-invariants-actifs)
13. [Modules partagés](#13-modules-partagés)
14. [Gouvernance documentaire](#14-gouvernance-documentaire)

---

## 1. Objet, public, et qui dit la vérité

**Engage Me** est une console SaaS qui déploie et pilote la stack conversationnelle d'un client : WhatsApp
(Cloud API, Marketing Messages, Meta Business Agent), RCS, e-mail. Un client y branche son numéro, importe ses
contacts, construit des scénarios, envoie des campagnes, répond dans une boîte de réception, et laisse un
agent IA tenir une partie des conversations.

Ce manuel s'adresse à quelqu'un qui va **modifier le code**. Le fonctionnel vu utilisateur vit dans
[features.md](features.md), et il vaut mieux le lire d'abord si la question est « qu'est-ce que ça fait ».

### 🔴 Qui dit la vérité, selon la question

C'est le point le plus important de ce fichier. Une documentation qui demande au lecteur de départager
plusieurs affirmations ne sert à rien : pour chaque fait qui BOUGE, voici sa source canonique, et ce manuel ne
la recopie pas.

| La question | La source qui tranche | Pourquoi pas ici |
|---|---|---|
| Comment le code se comporte | **le code**, et les tests qui le tiennent | un manuel vieillit, un test échoue |
| Quelles migrations sont APPLIQUÉES en production | **la base** : `select name from public.schema_migrations order by name desc` | qualifier `public.` : plusieurs schémas de cette base portent une table de ce nom |
| Quelle est la dernière migration, et le prochain nom libre | **[CLAUDE.md](CLAUDE.md)**, section Déploiement, seule source du compteur | ce compteur a déjà dérivé dans quatre documents |
| Quelles variables existent et quels sont leurs défauts | **`src/config.ts`** (schéma zod), gabarits dans `.env.example` et `.env.prod.example` | une centaine de clés, recopiées elles dérivent |
| Quelles files existent | **`src/queue/names.ts`** (`BASE_QUEUES`) | un compte écrit à la main est faux au premier ajout |
| Comment on déploie, et comment on revient en arrière | **[DEPLOY.md](DEPLOY.md)** | c'est un runbook exécutable, pas un récit |
| Ce que le produit fait, vu du client | **[features.md](features.md)** | |
| Ce qui reste à faire | **[todo.md](todo.md)**, et lui seul | un « reste à faire » qui existe à deux endroits en existe zéro |
| Ce sur quoi on travaille en ce moment | **[wip.md](wip.md)** | |
| Pourquoi telle décision a été prise en juillet | **[docs/JOURNAL-TECHNIQUE.md](docs/JOURNAL-TECHNIQUE.md)** | il décrit l'état d'alors, jamais celui d'aujourd'hui |

### 🔴 Trois notions de « dernière migration », à ne jamais confondre

Elles divergent régulièrement, et les confondre coûte une collision de nom ou un déploiement dans le mauvais
ordre, c'est-à-dire un risque de production.

1. **la dernière PRÉSENTE dans le dépôt** : `ls db/migrations/ | tail -1` ;
2. **la dernière APPLIQUÉE en production** : la requête ci-dessus, et rien d'autre. Un fichier peut être
   commité et poussé sans être appliqué ;
3. **le prochain NOM libre** : le numéro suivant celui du point 1, pas du point 2.

`CLAUDE.md` porte 1 et 3 et se déclare seule source du compteur. Il ne peut pas porter 2 : seule la base le
sait, et personne ne doit l'affirmer sans avoir posé la question.

---

## 2. Le système en dix minutes

### Trois noms, deux hébergeurs

```
        navigateur, Meta, contacts, opérateur télécom
                             |
                        Cloudflare (tous les sous-domaines sont Proxied)
        /                    |                        \
engageme.messagingme.app  api.messagingme.app   mba.messagingme.app
   la console                 l'API                l'ANCIENNE console
     VERCEL             un NOM, pas une machine    + toutes les adresses
  (root dir = web/)     -> VPS OVH aujourd'hui       déjà distribuées
                          mba-api + mba-worker      mba-web + routage NPM
                             |
                        Supabase (Postgres)
```

| Nom | Sert | Où | Déploiement |
|---|---|---|---|
| `engageme.messagingme.app` | la console | **Vercel**, projet `messagingme-mba`, Root Directory `web` | automatique à chaque `git push` |
| `api.messagingme.app` | l'API et le worker | VPS OVH, Docker | `git pull` + `compose up -d --build` |
| `mba.messagingme.app` | l'ancienne console, plus les adresses historiques | VPS, `mba-web` + routage NPM | idem |

🔴 **`api.messagingme.app` est un NOM, pas une machine, et c'est tout l'intérêt.** Le front, les contacts qui
cliquent un lien tracé et l'opérateur télécom ne connaissent que cette étiquette. Déménager l'API vers un
autre hébergeur ne coûte qu'un enregistrement DNS.

🔴 **MAIS ÉTEINDRE OVH NE SE RÉSUME PAS À CE CHANGEMENT DE DNS.** Meta appelle toujours
`mba.messagingme.app/api/backend/webhooks/meta`, et `mba.` EST le VPS. Les anciens `/r/`, `/m/` et `/mcp` y
vivent aussi. Repointer seulement `api.` couperait le webhook entrant et toutes les adresses déjà
distribuées. Ce qu'il faut faire AVANT, dans cet ordre : déplacer le routage de compatibilité de `mba.` vers
un point d'entrée indépendant du VPS (règle Cloudflare ou équivalent) qui retire le préfixe `/api/backend/`
vers `api.`, y route `/r/`, `/m/` et `/mcp`, et redirige le reste vers `engageme.`. Cette voie a un RETOUR
ARRIÈRE et ne demande aucun geste chez Meta. Reconfigurer le webhook chez Meta est possible mais se fait sans
filet : le temps que Meta reprenne l'adresse, les messages entrants tombent.

**Le routage par chemin de `mba.`** (`advanced_config` du proxy host NPM 21) : `/api/backend/*` va à
`mba-api` **avec le préfixe retiré par nginx**, `/r/`, `/m/` et `/mcp` y vont directement, tout le reste va à
`mba-web`. C'est ce qui a permis de migrer la console vers Vercel sans toucher à la configuration du webhook
chez Meta, et ce qui a retiré un conteneur de FRONT du chemin critique de réception des messages clients.

### Les trois conteneurs

Sur le réseau Docker `mcp-robot_default` du VPS :

| Conteneur | Ce que c'est | Adresse |
|---|---|---|
| `mba-api` | Fastify : webhooks, API console, API publique v1, `/ops`, `/r/`, `/m/`, `/w/`, `/mcp` | `:8095` |
| `mba-worker` | pg-boss (les files) plus une quinzaine de balayeurs. **Aucune adresse, personne ne l'appelle** | |
| `mba-web` | Next.js, l'ancienne console | `:3000` |

Le worker voyage avec l'API : il lit la base et travaille.

### Stack

- **Runtime** : Node >= 22 (`engines` de `package.json`, images `node:22-alpine`), TypeScript ESM.
  ⚠️ **`tsx` en dev ET en production** : le conteneur lance `npx tsx`, jamais `node dist`. La configuration est
  en `moduleResolution: Bundler` sans extensions, donc `node dist` casse. `npm run build` (tsc) n'est PAS le
  chemin de déploiement, c'est un typecheck.
- **API** : Fastify 5. **Validation** : zod, toujours `safeParse`, jamais `parse`.
- **File** : pg-boss, sur le même Postgres que les données (schéma `pgboss`). Pas de file en mémoire : elle
  perdrait les jobs au redémarrage.
- **Base** : Postgres = **Supabase**, projet `messagingme-MBA` (ref `npdqnrirxhqsyyvtvtjz`). Organisation
  distincte de leadgen et EDH, donc **invisible du MCP Supabase** : on y accède par `pg` en direct. L'hôte
  direct `db.<ref>` est IPv6-only et injoignable depuis Docker, on passe par le **pooler**.
- **Front** : Next.js 15 App Router (`web/`), **Tailwind pur** (pas de shadcn), tokens maison
  (brand/ink/mint/coral/gold/navy). Deux dépendances de production hors React et Next : `@xyflow/react`
  (l'éditeur de graphe) et `qrcode`. **Aucune bibliothèque de graphiques** : les courbes, donuts et nuages de
  points sont du SVG écrit à la main.
- **Auth** : JWT (jose HS256), scrypt asynchrone, session dans un en-tête `Authorization`, jamais un cookie.
- **E-mail** : deux chemins sans rapport. **Resend** pour les mails du produit (support, invitation,
  réinitialisation), destinataire et expéditeur fixés côté serveur. **nodemailer / SMTP par workspace** pour le
  CANAL e-mail du builder, boîte déclarée par le client, mot de passe chiffré au repos.

### Comment le navigateur trouve l'API

`web/lib/http.ts` lit `NEXT_PUBLIC_API_URL`, avec repli sur `/api/backend` (le proxy de même origine, donc
zéro CORS). ⚠️ **`NEXT_PUBLIC_API_URL` est FIGÉE AU BUILD côté Vercel** : la changer sans redéployer ne fait
rien, en silence. Même piège que `BACKEND_URL` sur l'image Docker.

---

## 3. Carte des domaines

Où regarder avant de modifier quoi que ce soit.

| Domaine | Responsabilité | Backend | Front | Tables | File ou balayeur |
|---|---|---|---|---|---|
| **Réception** | recevoir, dédupliquer et router tout ce qui entre de Meta | `src/webhooks/` | | `webhook_events` | `webhook`, `webhook-status` |
| **Contacts (mini-CRM)** | identité, champs, tags, consentement, import, purge | `src/crm/` | `/contacts` | `contacts`, `user_fields`, `tags` | |
| **Campagnes** | envoi de masse, cadence, garde-fous, planification, reprise | `src/campaign/` | `/campaigns` | `campaigns`, `campaign_recipients` | `campaign-run` + 4 balayeurs |
| **Scénarios** | le graphe, son moteur pur, l'exécution par contact | `src/workflow/` | `/workflows` | `workflows`, `workflow_runs`, `workflow_node_events` | `wake-sweep` |
| **Automations** | déclencher un scénario sur un événement | `src/automation/` | `/automations` | `automations`, `automation_fires` | `automation-event`, `date-sweep` |
| **Inbox** | la conversation, son détenteur, son affectation, l'archivage | `src/inbox/` | `/inbox` | `conversations`, `conversation_messages` | `control-sweep` |
| **Agent IA** | un bloc de scénario qui tient la conversation seul, avec des outils | `src/agent/` | `/agents` | `agents`, `agent_tools`, `agent_sessions`, `agent_knowledge`, `agent_credits` | `agent-turn` |
| **Meta Business Agent** | l'agent de META (pas le nôtre) : activation, passage de main | `src/mba/` | `/mba` | `tenant_settings` | `handoff-sweep` |
| **Canal RCS** | deuxième canal, agent de marque chez smsmode | `src/rcs/`, `src/channels-me/` | `/rcs-messages`, `/chaine` | `rcs_agents`, `rcs_media` | |
| **Canal e-mail** | troisième canal, SMTP par workspace | `src/email/` | `/email-templates` | `email_accounts`, `email_templates` | |
| **Formulaires (Flows)** | les WhatsApp Flows et leur mapping vers les fiches | `src/flow/`, `src/meta/flow-json.ts` | `/flows` | `flows` | |
| **Analyse de conversation** | ce que le LLM comprend d'un fil clos | `src/analysis/` | `/dashboard`, `/performance` | `conversation_analysis` | `analyze-conversation`, `push-analysis` |
| **Statistiques** | volumes, funnel, erreurs, coût | `src/stats/` | `/dashboard` | lecture seule | |
| **Liens tracés** | compter les clics sur les boutons URL d'un template | `src/links/` | | `tracked_links`, `tracked_link_clicks` | |
| **Webhooks entrants** | un tiers poste du JSON, on en fait un contact et un événement | `src/webhook-entrant/` | `/webhooks` | `webhooks` | |
| **Connecteur HubSpot** | import de listes, étapes de deal | `src/hubspot/` | `/tuto-hubspot` | | `hubspot-catchup` |
| **API publique v1** | ce qu'un intégrateur du client appelle | `src/api/`, `src/http/v1-*.ts` | `/developers` | `api_keys`, `api_idempotency` | |
| **Exploitation** | vue cross-tenant, recharge de crédit, alertes | `src/ops/` | `/ops` | `worker_heartbeat`, `audit_log` | `dlq-sweep` |
| **Auth et comptes** | connexion, invitations, rôles, multi-espace | `src/auth/`, `src/user/` | `/login`, `/admin` | `users`, `identities`, `auth_tokens` | |

---

## 4. Les quatre flux critiques

### 4.1 Un message arrive

```
Meta -> POST /webhooks/meta (mba-api)
   signature X-Hub-Signature-256 vérifiée AVANT de lire le corps
   -> payload brut enfilé dans `webhook`
   -> 200 immédiat (cible < 50 ms), zéro logique métier
                      |
      worker, job `webhook` :
        dédup par meta_message_id (les webhooks arrivent en double)
        auto-création ou mise à jour du contact (isolée : un échec ne casse pas l'inbox)
        capture du referral CTWA (premier message seulement)
        enregistrement dans le fil
        puis, DANS CET ORDRE et chacun isolé en try/catch :
          1. mapping de formulaire  (nfm_reply -> champs de la fiche)
          2. jeton de test          (CONSOMME le message, personne d'autre ne le voit)
          3. automations            (mot-clé, tag, lien de chaîne) -- CONSOMMENT aussi
          4. avance de scénario     (le contact a répondu, sur ce qui reste)
```

🔴 **L'ordre n'est pas décoratif, et chaque maillon est isolé.** Ils partagent le MÊME job : une exception
dans l'un rejouerait le job entier, donc les statuts de livraison et l'avance de scénario avec. Aucun ne throw.

🔴 **LES AUTOMATIONS PASSENT AVANT L'AVANCE, et le message est CONSOMMÉ.** Quand un message est à la fois une
réponse attendue par le parcours en cours et le déclencheur d'un autre scénario, **le déclencheur gagne,
toujours** (décision produit). Dans l'ordre inverse, l'ancien parcours avançait et ENVOYAIT son bloc suivant,
puis le nouveau scénario démarrait et le tuait : le client recevait deux messages, dont un venant d'un
parcours qu'on venait d'abandonner. ⚠️ Fermer le parcours ne suffit pas, il faut lui RETIRER le message.

⚠️ **« Consommé » se propage par union**, du jeton de test vers les automations puis vers l'avance : un seul
message ne déclenche jamais deux choses.

⚠️ **`webhook-status` est une file SÉPARÉE** de `webhook`. Les accusés de livraison de Meta (sent, delivered,
read) arrivent par rafales : une campagne de 5 000 messages en produit trois par destinataire. Sur la même
file, une rafale d'accusés retardait la réponse à un vrai client.

⚠️ **Le referral d'une publicité Click-to-WhatsApp n'arrive que sur le PREMIER message** après le clic. Ne pas
le capter à l'arrivée, c'est perdre l'origine du lead définitivement. Il atterrit dans deux champs de contact
(`pub_id`, `pub_titre`) plutôt que dans une colonne dédiée : l'origine devient ainsi filtrable, utilisable
comme variable et segmentable en campagne, sans migration. `ctwa_clid` peut arriver VIDE, n'en jamais faire
une condition.

### 4.2 Une campagne part

```
POST /campaigns          création : destinataires matérialisés, variables résolues
POST /campaigns/:id/run  -> job `campaign-run` (expiration DIMENSIONNÉE au volume et au débit)
   runCampaign :
     verrou d'exécution (bail + jeton de garde + drapeau de relance)
     pour chaque destinataire pending :
       arrêt du service ? durée max du lot atteinte ? hors heures ouvrées ?
       relecture du statut (l'opérateur a pu mettre en pause)
       quality gate Meta, plafond de fréquence marketing
       claim ATOMIQUE (pending -> sending)   <- ce qui empêche le double envoi
       envoi, puis résultat persisté HORS du catch d'envoi
```

🔴 **Le claim atomique par destinataire est la seule garantie anti-double-envoi.** Ni la file ni le verrou ne
la donnent : aucune file de ce dépôt ne déduplique quoi que ce soit (voir § 6).

🔴 **Un plafond de numéro Meta ne se compte pas en échec du destinataire.** Le refus vise le numéro émetteur,
pas ce contact : on le rend à la file, on met la campagne en pause, et le balayage de reprise la relance. Le
compter en échec le rendrait injoignable sans intervention, et le suivant échouerait pareil.

**Trois motifs de pause, deux se reprennent seuls** : `debit` (une limite de cadence, qui retombe) et
`hors_horaires` (la fenêtre d'envoi du client, qui rouvre) portent un `paused_until` ; `qualite` (Meta juge le
numéro dégradé) n'en a jamais et attend une décision humaine. Relancer une pause de qualité sans rien changer
aggrave le problème et peut coûter le numéro.

⚠️ **L'expiration du job est DIMENSIONNÉE**, pas fixe : un timeout fixe ne couvre pas un run throttlé long, et
pg-boss le rejouerait en parallèle, doublant le débit. Elle est plafonnée à 23 h, parce que pg-boss REFUSE
toute expiration atteignant 24 h par un assert strict.

⚠️ **Une campagne AU FIL DE L'EAU ne se TERMINE pas** : elle sort en `running` au lieu de `completed`, sinon
son webhook cesserait de la nourrir et plus aucun lead ne serait contacté, sans le moindre signal. Son seul
point final est `POST /campaigns/:id/stop`.

### 4.3 Un scénario s'exécute

`walk(graph, startNodeId, ctx?, opts?)` est **PUR** : aucune IO. Il rend les actions à jouer et un état de
repos ; `executor` fait l'IO et persiste.

| Repos rendu par `walk` | Ce que ça veut dire | Qui reprend |
|---|---|---|
| `waiting` | on attend une réponse du contact | `advance`, sur le message suivant |
| `waiting` + `timeoutInMs` | bloc Question : la réponse OU l'échéance | `advance` ou `claimDueQuestions` |
| `sleeping` + `resumeInMs` | bloc Attente : on attend le temps | `wake-sweep` |
| `rcs_send` | main rendue : `walk` ne peut pas savoir si le numéro est joignable | l'executor, après l'IO |
| `agent_turn` | main rendue : `walk` ne peut pas savoir ce que le modèle décidera | l'executor, après le tour |
| `inbox` | terminal, la conversation remonte à un humain | |
| `done` | fin de chaîne | |

🔴 **Le bloc Question est le seul à attendre la réponse ET le temps.** Il reste `waiting` et porte EN PLUS un
`resume_at` : le mettre en `sleeping` pour obtenir l'échéance ferait perdre la réponse du contact, ce qu'un
bloc Question ne peut pas se permettre.

🔴 **Le canal est porté par le PARCOURS, pas par le bloc** (`workflow_runs.channel`). Un bloc « message
rapide » dit l'INTENTION, pas le tuyau : WhatsApp et RCS savent tous deux le faire. Un bloc RCS réellement
envoyé fait passer le parcours en `rcs`, un template le ramène à `whatsapp`, un message rapide suit le canal
courant. Un bloc RCS **sauté** (opt-out, agent absent) ne bascule rien : le repli « non joignable » est
WhatsApp, et le faire partir en RCS chez un contact qu'on vient de constater injoignable n'aurait aucun sens.

🔴 **La fenêtre de 24 h de WhatsApp gouverne ce qui peut OUVRIR et ce qui peut SUIVRE, et ce sont deux règles
distinctes.** Peuvent ouvrir à froid : un **template** WhatsApp, ou un **bloc RCS** configuré (le RCS n'a
aucune fenêtre, c'est une règle de WhatsApp et pas du monde). Après une attente, seul un template part encore ;
un message rapide, une question ou un formulaire seront refusés. Cette règle a **trois détenteurs** :
`besoinsFenetre` (reprise), la garde de `runFrom` (ouverture à froid) et `exigeFenetre24h` (API publique).

⚠️ **Répondre à un message RCS ne rouvre pas la fenêtre WhatsApp** : ce sont deux tuyaux distincts. Seul le
formulaire reste impossible derrière un RCS, n'ayant aucun équivalent : le parcours ne fait pas semblant, il
remonte la conversation à un humain.

⚠️ **Le builder MIROITE cette analyse côté front** (`web/lib/campaign-eligibility.ts`), parce que la frontière
de build interdit de partager un module. `tests/web-campaign-eligibility.test.ts` compare les DEUX
implémentations sur une table de graphes. 🔴 **Cette table doit contenir une valeur INCONNUE**, pas seulement
les valeurs légitimes : c'est le seul cas où deux formulations « équivalentes » (liste blanche contre
négation) se séparent, et c'est exactement celui qu'on n'écrit pas parce qu'il « n'arrive jamais ».

⚠️ **L'index d'une réponse EST sa sortie** (`btn:<i>`, `row:<i>`). Les libellés vides sont filtrés APRÈS
numérotation : filtrer avant renuméroterait, et le contact partirait dans la mauvaise branche. Supprimer une
ligne depuis le panneau passe par un événement que le BUILDER traite, parce que lui seul voit les arêtes.

### 4.4 Un agent IA répond

```
bloc agent atteint -> executor ouvre une session -> job `agent-turn`
   run-turn : garde de solde (à l'ENTRÉE du tour, jamais à l'écriture)
     brain.gateway.penserTrace :   <- LA boucle, partagée par la production ET le bac à sable
       prompt : mention d'IA EN TÊTE, si le régime de l'agent la demande pour CE tour (0126)
       appel du modèle (Vercel AI Gateway)
       si appel d'outil : executor d'outil (validation, injection, budget de temps, journal, troncature)
         résultat encadré par `blocResultatOutil`, jamais concaténé au prompt
       jusqu'à une SORTIE nommée, un plafond, ou une erreur
   -> le parcours repart par le handle `sortie:<code>`
```

🔴 **Le consentement humain est porté par la BASE, pas par une convention** : deux CHECK sur `agent_tools`
(`actif = false or active_par is not null`, `autonome = false or autonome_par is not null`). La spec MCP exige
un consentement humain avant invocation ; notre agent n'a aucun humain au runtime, donc le consentement est
déplacé du runtime vers la CONFIGURATION.

🔴 **Le modèle ne choisit jamais une cible.** Sur un connecteur API client, l'adresse est figée sur la source,
le gabarit est écrit par un administrateur, et `construireCible` vérifie que l'URL finale reste SOUS l'adresse
de base, segment par segment, après encodage. Le `wa_id` vient du TOUR, pas de la projection du contact : la
projection part chez le fournisseur de modèle et ne porte donc pas le numéro.

🔴 **Le risque d'un outil est DÉRIVÉ de la méthode HTTP** (`GET` -> read, `POST`/`PUT`/`PATCH` -> write,
`DELETE` -> irréversible) et ne peut être que MONTÉ. Un client qui déclarerait `read` un `DELETE` désarmerait
la garde d'autonomie sur une action irréversible.

🔴 **Le filtre de sortie est obligatoire.** `outputPaths` dit ce que l'agent a le droit de lire d'une réponse
client. Sur un outil maison, c'est nous qui écrivons la réponse ; sur un connecteur, non.

⚠️ **Le bac à sable SIMULE un connecteur.** Un essai depuis la console ne doit pas taper sur le système de
production d'un client, même en lecture : il consommerait son quota, apparaîtrait dans ses journaux, et un
connecteur mal déclaré ferait un dégât réel pendant qu'on croit essayer.

**Deux modèles, deux métiers** : `AGENT_SETUP_MODEL` (l'assistant de construction, sortie structurée
imbriquée, tourne rarement) et `AGENT_MODEL` (le runtime, à chaque message). Le boot REFUSE la clé du Gateway
sans les deux : le repli sur `LLM_MODEL` donnerait à un agent l'identifiant de l'ANALYSE de conversation,
servie en direct par Anthropic, que le Gateway ne connaît pas.

**Le catalogue proposé au client** est une liste CHOISIE (`src/agent/modeles.ts`), intersectée avec le
catalogue réel du Gateway et tarifée en direct. Deux critères pour y entrer : le modèle sait **appeler des
outils** (sinon il n'a pas une réponse dégradée, il en a une INVENTÉE) et il parle correctement français.

---

## 5. Données et multi-tenant

### 🔴 L'isolation entre clients est en CODE, pas en base

La connexion passe par un pooler dont le rôle est superuser : **la RLS serait contournée**. Le filtrage
`tenant_id = $1` sur CHAQUE requête est donc le SEUL contrôle.

`scopeTenant` (`src/http/scope.ts`) est ce contrôle, pour plus de 230 routes, et il **ÉCHOUE FERMÉ** : sans
`req.auth`, il refuse au lieu de rendre le tenant pris dans l'URL. Un garde-fou de `buildServer` couvre les
modules à routes `:tenantId`, tenu par `tests/scope-tenant.test.ts`.

### Identité d'un contact : un numéro OU un BSUID

`src/crm/identity.ts` : `waIdOf(phone, bsuid)` est la clé de routage WhatsApp, `classifyWaId(waId)` la lit à
l'envers (7 à 15 chiffres -> numéro, sinon BSUID). `contacts` porte `phone_e164` **ou** `bsuid`, contrainte
« au moins un », deux index uniques partiels.

⚠️ **Trois formats coexistent et se confondent facilement** : le fil porte un `wa_id` SANS `+`
(`33612345678`), la fiche un E.164 (`+33612345678`), et le cache de joignabilité RCS a pour clé l'E.164. La
correspondance passe par le prédicat partagé `MATCH_BY_WAID_SQL`, jamais par une égalité directe.

⚠️ **La règle d'AFFICHAGE « numéro sinon BSUID » n'est PAS factorisée** : elle est réécrite à la main dans
`web/lib/api.ts` (`contactIdentity`, le seul vivant), `src/api/sends-build.ts` et `src/campaign/build.ts`.
Chantier ouvert, pas un acquis.

### Les tables, par domaine

Les colonnes citées sont celles dont le comportement dépend. La forme complète se lit dans `db/migrations/`.

**Comptes et accès**

- `tenants` (`status` ∈ trial | active | locked, `public_code`), `users` (`role` ∈ **admin | manager |
  agent**), `identities` (le mot de passe vit sur l'ADRESSE, pas sur le compte : « une adresse = UN mot de
  passe » est exprimé par la structure), `auth_tokens` (invite | reset, `token_hash` sha256, consommation
  atomique dans le `update ... returning`).
- ⚠️ **Trois rôles, mais un seul niveau de droits** : tout ce qui est réservé l'est à `admin`. Un `manager` a
  aujourd'hui les accès d'un `agent` ; c'est un statut, pas encore des droits.
- 🔴 **La connexion multi-espace est en deux temps.** Un seul espace -> session directe. Plusieurs -> le
  serveur rend la LISTE et un jeton de CHOIX, jamais une session. Ce jeton ne peut pas tenir lieu de session
  (pas de `tenantId` ni de `role` à la racine, `kind` vérifié) et il PORTE la liste signée des espaces
  autorisés : sans elle, présenter un jeton légitime avec l'identifiant d'un espace quelconque suffirait à y
  entrer.

**Contacts**

- `contacts` : `fields jsonb` (merge qui n'écrase jamais une clé absente), `tags text[]`, opt-in tracé,
  `deleted_at` (soft delete, index partiel), `anonymized_at`, `blocked_at`.
- 🔴 **`opted_out` et `unknown` ne veulent pas dire la même chose.** `optInAllows` exige un opt-in EXPLICITE
  pour une campagne **marketing** : un contact `unknown` est donc écarté **en silence**, seul `utility` passe.
  La saisie manuelle et l'import CSV créent en opt-in par défaut ; l'API publique et l'import HubSpot gardent
  l'exigence inverse, leur appelant chargeant une liste dont il ne connaît pas chaque ligne. ⚠️ Conséquence :
  les contacts venus de HubSpot arrivent `unknown`, donc hors marketing tant qu'on ne les bascule pas.
- 🔴 **Un seul geste de destruction.** `POST /contacts/purge` exige `confirm: 'SUPPRIMER'`. Il EFFACE ce qui
  identifie (conversation, messages, analyse, parcours, déclenchements, cache RCS) et ANONYMISE ce qui porte
  le quantitatif : le numéro devient `anon:<uuid>` ALÉATOIRE, pas une empreinte, qui serait réversible sur un
  espace de numéros français. Les totaux d'envoi et de livraison restent donc justes.
- 🔴 **Bloqué n'est pas supprimé.** `contacts.blocked_at` est une DÉCISION humaine (plus aucun envoi,
  conversation masquée) ; `conversation_analysis.abusive` est un CONSTAT posé par l'analyse, qui ne déclenche
  rien. Les mélanger laisserait un modèle bloquer des clients tout seul. Les messages d'un contact bloqué
  restent ENREGISTRÉS : filtrer à la réception ferait disparaître une résiliation ou une menace juridique.

**Campagnes**

- `campaigns` : `status` ∈ draft | scheduled | running | paused | completed | failed. `template_name` et
  `workflow_id` sont **exclusifs** (couplage au template par CHAÎNE, pas de FK). `webhook_id` = campagne au
  fil de l'eau, `business_hours_only`, `pause_reason` + `paused_until`, `rate_per_minute` (1 à 80).
- `campaign_recipients` : `status` interne ∈ pending | sending | sent | failed | skipped, plus
  `delivery_status` (le cycle Meta, écrit MONOTONE par message_id). Contrainte
  `(campaign_id, contact_id)` : c'est elle qui empêche un doublon au fil de l'eau.

**Scénarios**

- `workflows` (`graph jsonb`, plus un brouillon : l'enregistrement automatique n'atteint pas les contacts,
  seul « Publier » met en ligne), `workflow_runs` (`status` ∈ waiting | sleeping | inbox | done, `resume_at`,
  `channel`, `last_message_id` pour la dédup d'avance), `workflow_node_events`.
- 🔴 **Un run endormi est CLOS par le démarrage suivant, pas préservé.** `closeActiveByWaId` couvre `waiting`
  ET `sleeping` et efface `resume_at`. Sans les deux, une automation lancerait un second parcours en parallèle
  et les deux écriraient au réveil.

**Conversations**

- `conversations` (`control_owner`, `assigned_to`, `archived_at`), `conversation_messages`.
- 🔴 **LES CINQ DOSSIERS N'ONT PAS LA MÊME NATURE, et c'est ce qui décide de ce qu'on peut y ranger.**
  « Archivé » (`archived_at`) et l'affectation (`assigned_to`) sont des ÉTATS ÉCRITS ; « À traiter » est
  DÉRIVÉ de `control_owner <> 'app_workflow'`, donc y ranger une conversation veut dire PRENDRE le fil ; et
  « Signalé » réunit DEUX sources, le constat de l'analyse (`conversation_analysis.abusive`) et un
  signalement humain (`signalee_le`, migration 0123). ⚠️ Les deux sources restent SÉPARÉES : `abusive` est
  recalculé à chaque ré-analyse, un signalement humain écrit dedans disparaîtrait au passage suivant. La
  liste rend `signaleeMain` pour que l'écran sache quoi proposer.
- 🔴 **`control_owner` et `assigned_to` sont ORTHOGONAUX** : le premier dit QU'EST-CE QUI parle (scénario,
  humain, agent Meta), le second QUEL HUMAIN s'en occupe. Une conversation peut être affectée ET tenue par le
  scénario. La règle d'accès vit dans `src/inbox/assignment.ts`, PURE, et ne reçoit même pas `control_owner` :
  si quelqu'un le lui passait, le code ne compilerait plus. Griser un bouton ne protège rien, le refus vient
  du serveur.
- ⚠️ `on delete set null` sur l'affectataire : supprimer un membre LIBÈRE ses conversations. Une conversation
  que plus personne ne peut prendre serait invisible et sans réponse.
- ⚠️ `control_changed_at` ne se rafraîchit PAS quand un opérateur répond une seconde fois : le compte à
  rebours de reprise part de la PREMIÈRE intervention.

**Réglages d'espace** (`tenant_settings`, une ligne par tenant, aucun défaut « allumé »)

| Colonne | Ce qu'elle gouverne |
|---|---|
| `mba_enabled` | l'agent Meta Business Agent est actif sur cet espace |
| `hubspot_lists_enabled` | l'import de contacts HubSpot (pas les étapes de deal) |
| `campaigns_paused` | coupe-circuit d'envoi pour tout l'espace |
| `auto_retry_enabled` | auto-relance des échecs |
| `timezone` et `business_hours` | le fuseau (une heure murale sans fuseau est interprétée là) et les horaires |
| `mba_handoff_mode` | `always` \| `business_hours` \| `never` |

**Journal**

- `webhook_events` : le corps brut de chaque webhook Meta, `meta_message_id` unique (c'est l'idempotence).
  ⚠️ **Purgé** : balayage du worker sur `WEBHOOK_EVENTS_RETENTION_DAYS`.
- `audit_log` : **AJOUT SEUL**, ni update ni delete, sinon il ne prouve rien. Il ne porte JAMAIS de donnée
  personnelle, seulement l'identifiant interne du contact : y écrire le numéro au moment d'une suppression
  annulerait la suppression. `actor_email` est DÉNORMALISÉ pour que l'historique reste lisible après le départ
  d'un collaborateur ; acteur `null` = le système. Écriture best-effort : une panne de journal ne doit pas
  empêcher un client d'exercer son droit à l'effacement.

### Les identifiants publics

Chaque entité porte un code `<type>_<code-client>_<ULID>` (ex. `scn_by5p57_01KXNVZD0NP4WY7WAEHA4765G5`),
ADDITIF strict : les uuid internes restent la source de vérité des relations. `src/ids/code.ts` est PUR. Les
codes de bloc sont mintés **côté serveur** au save du graphe, avec une regex anti-forge : un code valide du
même tenant est préservé par référence, tout le reste est re-minté.

⚠️ **Deux longueurs de code, deux raisons.** Une clé d'ACCÈS publique (webhook entrant, visuel RCS) fait 26
caractères base32, soit 130 bits : c'est elle qui tient l'accès à elle seule. Un code de lien tracé se
contente de 60 bits parce qu'il doit tenir dans l'URL d'un bouton WhatsApp.

---

## 6. Asynchrone, concurrence, idempotence

### Les files

**Source unique : `BASE_QUEUES` dans `src/queue/names.ts`.** Le nombre réel de files côté `/ops` est **chaque
file de base plus sa DLQ** (`dlqName`) : ne l'écrivez pas en chiffres, il a déjà été faux ici ET dans un
commentaire du code.

La cadence de polling se règle **par file**, sur la latence réellement utile, pas sur un défaut global :

| Latence | Cadence | Files |
|---|---|---|
| conversationnelle (quelqu'un attend) | 2 s | `webhook`, `agent-turn` |
| interactive (l'opérateur regarde l'écran) | 5 s | `campaign-run`, `automation-event` |
| de fond (personne n'attend) | 30 s | `webhook-status`, `analyze-conversation`, `push-analysis`, `hubspot-catchup` |
| dépôt inspecté, consommé par personne | 60 s | toute DLQ |

🔴 **Pourquoi pas le défaut de pg-boss (2 s partout)** : mesuré, le polling à vide des quatre process (mba api
et worker, mm-hubspot api et worker) produisait 663 000 requêtes et 249 Mo d'egress par jour pour 157 jobs en
table, soit 7,5 Go par mois contre 5 Go inclus. L'egress d'un sondage à vide est du pur overhead.

**Deux mécanismes corrigent la lenteur sans la supprimer** : les files dont la latence se RESSENT sont
réveillées par LISTEN/NOTIFY (`FILES_NOTIFIEES`), et toute file qui accumule au-delà de `SEUIL_RAFALE` cesse
d'attendre entre deux prises jusqu'à s'être vidée. ⚠️ La concurrence, elle, ne bouge pas : c'est elle qui
protège les entrants, pas la cadence. Rendre une rafale rapide n'autorise pas à en traiter deux ensemble.

🔴 **Toute nouvelle file entre dans `BASE_QUEUES`**, sinon elle est invisible de `/ops` et sa DLQ n'est
surveillée par personne. `tests/queue-names.test.ts` dérive la liste des `queue.work(...)` du worker et casse
si on l'oublie ; `QUEUE_POLLING_SECONDS` et `FILES_NOTIFIEES` doivent aussi porter une entrée.

### 🔴 Aucune file de ce dépôt ne déduplique quoi que ce soit

Elles sont créées sans `policy`, donc en `standard`, et pg-boss n'y applique aucun index unique (vérifié dans
sa source ; le paramètre `singletonKey`, qui n'a jamais rien fait, a été retiré). **N'écrivez jamais de code
ni de commentaire qui compte sur « un seul job vivant par clé »** : deux enfilements = deux jobs qui tournent.
La policy étant IMMUABLE après création, on ne peut pas non plus la rattraper sur les files existantes.

### L'unicité d'exécution se pose à l'EXÉCUTION

Modèle de référence : `src/campaign/run-lock.ts`. Trois pièces en font un verrou et pas un drapeau :

1. un **bail**, sinon un worker tué en plein envoi bloque la campagne à vie ;
2. un **jeton de garde**, sinon le porteur d'un bail périmé supprime le verrou de celui qui l'a repris ;
3. un **drapeau de relance**, sinon le travail arrivé pendant le run est perdu.

🔴 **Une réclamation de balayage POSE UN BAIL, elle n'efface pas la marque.** `claimDueSleeping` repousse
`resume_at` de quelques minutes en RESTANT `sleeping` ; effacer l'échéance garantirait de la PERDRE au premier
refus de Meta ou redéploiement, laissant un fil tenu par un parcours mort que rien ne répare. Passer à
`waiting` serait pire encore : le run redeviendrait visible d'`advance`, et un message du contact pendant la
reprise rejouerait le même bloc.

### Les balayeurs du worker

Tous en `unref()`, chacun avec sa variable de cadence (les valeurs sont dans `src/config.ts`).

| Balayeur | Ce qu'il fait |
|---|---|
| reclaim | ramène à `pending` un destinataire `sending` trop vieux |
| `campaign/schedule-sweep` | enfile les campagnes programmées dues, PUIS marque `running` |
| campagne au fil de l'eau | relance celles qui ont un destinataire en attente |
| `campaign/reprise-sweep` | reprend les pauses à échéance (`debit`, `hors_horaires`) |
| `campaign/retry-sweep` | auto-relance des échecs |
| `workflow/wake-sweep` | réveille les parcours endormis et réclame les blocs Question à échéance |
| `inbox/control-sweep` | rend la main au scénario après le délai de reprise |
| `mba/handoff-sweep` | applique le mode `business_hours` du passage de main Meta |
| `analysis/sweep` | réclame les conversations closes à analyser |
| `automation/date-sweep` | déclencheur « X avant ou après la date d'un champ » |
| `account/status-sweep` | statut et qualité des numéros Meta |
| rattrapage HubSpot | relance les marques restées sur un numéro reconnecté |
| purge des payloads webhook | rétention du dernier payload d'un webhook entrant |
| purge des événements Meta | `WEBHOOK_EVENTS_RETENTION_DAYS` |
| `ops/dlq-sweep` | alerte Telegram sur les DLQ non vides |
| heartbeat | écrit `worker_heartbeat`, lu par `/ops` pour voir un worker mort |

⚠️ **L'ordre enfiler / marquer n'est pas le même partout, et c'est voulu.** Le balayage des campagnes
PROGRAMMÉES enfile puis marque : un échec d'enfilement laisse la campagne `scheduled`, reprise au tour
suivant. Celui des REPRISES marque d'abord, parce que c'est l'écriture qui RÉCLAME la ligne, sinon deux
balayages enfileraient deux runs. On échange un double envoi possible contre un retard d'une minute.

### Deux pools Postgres

- **`DATABASE_URL`** = pooler en mode **SESSION** (port 5432). Sert **pg-boss** et **tous les scripts CLI**
  (`db/migrate.ts`, `db/seed.ts`, `db/backfill-codes.ts`), qui lisent cette variable en direct.
  🔴 pg-boss ne peut PAS aller en mode transaction : il maintient des connexions longues et une maintenance
  qui ne survivent pas à la réassignation du backend entre transactions.
- **`APP_DATABASE_URL`** = pooler en mode **TRANSACTION** (port 6543), pour le pool applicatif. Vide -> repli
  sur `DATABASE_URL`, dégradation SÛRE.
- **`DB_POOL_MAX`** est instancié **PAR PROCESS** : l'API et le worker importent le même module, donc le
  double du réglage vers le pooler. Au-delà d'environ 16 clients simultanés, la latence double sans qu'aucune
  erreur ne remonte. Monter plus haut déplacerait la file d'attente de NOTRE pool vers celle de Supavisor, où
  elle est MUETTE, et `DB_CONN_TIMEOUT_MS` ne protégerait plus de rien.
- **`PGBOSS_MAX`** vit dans un budget d'environ 15 sessions **partagé avec mm-hubspot**. Ne pas le relever
  sans refaire cette arithmétique.
- **`DB_CONN_TIMEOUT_MS`** : le défaut `pg` est une attente ILLIMITÉE, donc un pool saturé rend une requête
  HTTP qui ne répond jamais, sans erreur ni trace.

⚠️ Le partage de base avec mm-hubspot est sûr parce que mba est **search_path-agnostique** (tables en `public`
par défaut, `mmhs` TOUJOURS qualifié) et que toutes ses transactions passent par un client dédié.

---

## 7. Sécurité et secrets

### Les gardes, et ce que chacune ferme

| Garde | Où | Ce qu'elle ferme |
|---|---|---|
| Signature du webhook | avant de lire le corps | un tiers qui se ferait passer pour Meta |
| `scopeTenant` | toute route `:tenantId` | l'accès aux données d'un autre client (IDOR) |
| `requireAdmin` / `forbidNonAdmin` | écritures | un opérateur d'inbox qui modifierait la configuration |
| Plafonds de débit | routes authentifiées | l'épuisement par un client, volontaire ou non |
| `OPS_TOKEN` | `/ops` | l'exploitation cross-tenant |
| `urlRecuperable` + `resolutionPublique` | toute URL saisie par un client | le SSRF vers le réseau interne |
| `lireCorpsBorne` | toute réponse distante | l'épuisement mémoire par un corps géant |

🔴 **LE CORS EST EN LISTE BLANCHE ET SANS `credentials`, et les deux comptent.** `CORS_ORIGINS` refuse `*` AU
CHARGEMENT de la configuration. Jamais `credentials: true` : la session voyage dans un en-tête
`Authorization`, jamais dans un cookie, donc **il n'y a aucun CSRF aujourd'hui** ; l'activer en créerait un de
toutes pièces. Vide = aucun en-tête CORS n'est posé, ce qui est le bon défaut.

🔴 **Deux plafonds de débit, et 0 les désactive.** `RATE_LIMIT_USER_PAR_MINUTE` (clé = utilisateur, posé DANS
`makeRequireAuth` donc hérité par tous les modules gardés) et `RATE_LIMIT_COUTEUX_PAR_MINUTE` (clé = ESPACE)
sur import, aperçu, action en masse, purge, export et lancement de campagne. Mettre l'une à 0 est le levier
d'urgence : un mauvais calibrage couperait la console de tous les clients, et un `--force-recreate` va plus
vite qu'un déploiement de code. ⚠️ Ils sont LOCAUX AU PROCESS : le plafond annoncé est celui d'UNE instance,
à lever avant le multi-replica.

🔴 **Une URL saisie par un client se vérifie DEUX FOIS : sur son TEXTE, et sur ce vers quoi elle RÉSOUT.**
`urlRecuperable` lit le texte de l'hôte (elle refuse `localhost`, les littéraux privés et leurs formes
hexadécimale, entière, IPv6 et IPv4 mappée) ; `resolutionPublique` (`src/lib/adresse-privee.ts`) ferme ce
qu'un texte ne peut pas voir : un nom public dont l'enregistrement A pointe sur les métadonnées du fournisseur
ou sur le réseau Docker. Trois règles la rendent juste : **une seule adresse interdite condamne le nom** ;
**une résolution qui ÉCHOUE ou qui TRAÎNE est un REFUS** ; et une **plage se compare en ARITHMÉTIQUE, jamais
en préfixe de chaîne** (`fe80::/10` fait dix bits, pas quatre caractères). L'inventaire des chemins concernés
est tenu par `tests/lib-adresse-privee.test.ts`, plus par une page qui dérive.

⚠️ **Le DNS rebinding reste ouvert** : `urlRecuperable` valide le NOM, pas l'IP finalement résolue par
`fetch`. Un administrateur de tenant peut déclarer un domaine à lui, passer la validation, puis repointer son
DNS. C'est un risque d'ADMINISTRATEUR, pas de contact, et il est dans `todo.md`. ⚠️ Le pare-feu de l'hôte ne
protège pas ce chemin : le trafic reste dans le réseau Docker, il ne traverse jamais l'interface publique.

🔴 **Un corps de réponse distante se lit EN FLUX** (`lireCorpsBorne`), jamais avec `res.text()` suivi d'un test
de taille : le corps entier entrerait en mémoire avant d'être jeté, et `.length` compte des unités UTF-16,
donc un corps d'idéogrammes passe un plafond « en octets » à trois fois sa taille. Ses consommateurs doivent
lire ses TROIS verdicts : `trop_gros`, `casse` (un flux coupé n'est pas un corps vide, sans quoi on annonce un
succès sur une lecture ratée) et le texte. ⚠️ Les clients de NOS API (Meta, Zadarma) n'y passent pas : hôtes
fixes et de confiance.

🔴 **Ce qui est servi est décidé par la SIGNATURE du fichier**, jamais par le type déclaré au téléversement.
Servir un fichier pour ce qu'il prétend être est la façon classique de transformer un hébergeur d'images en
hébergeur de pages : un PDF renommé en `.png` est refusé en **415**. Trois formats seulement (JPEG, PNG, GIF),
pas de SVG, qui est du XML exécutable. La réponse porte `nosniff` et le type réel.

### 🔴 Aucun message destiné à l'utilisateur dans un 5xx

Mesuré : par l'URL publique, un `502 {"error":"..."}` revient en `text/html` de 6 429 octets, la page de
Cloudflare, notre corps disparu. **Tous les sous-domaines `messagingme.app` sont Proxied.** Un refus lisible
sort donc en **422** (409 pour une ambiguïté, 400 pour une saisie invalide), et il est **journalisé côté
serveur** en plus : le corps peut être détruit en route, le log reste.

**Astuce de diagnostic** : comparer l'appel INTERNE (dans le réseau Docker) et l'appel PUBLIC isole la couche
coupable en une mesure.

### Les secrets

Tous côté serveur, jamais dans le bundle `web/` ni en `NEXT_PUBLIC_*` : `META_ACCESS_TOKEN`,
`META_APP_SECRET`, `OPS_TOKEN`, `ENCRYPTION_KEY`, `AUTH_SECRET`, `AI_GATEWAY_API_KEY`, `VERCEL_API_TOKEN`,
la clé Supabase.

🔴 **`VERCEL_API_TOKEN` n'est pas un secret comme les autres, et le confondre avec `AI_GATEWAY_API_KEY`
coûterait cher.** La seconde ne sait que DÉPENSER sous un plafond ; le premier sait FABRIQUER des clés
facturées à l'équipe, autant qu'on veut. Sa compromission n'est donc pas bornée par nos plafonds applicatifs.
Le seul contre-feu est le **plafond d'ÉQUIPE posé chez Vercel**, hors de ce dépôt et hors d'atteinte de qui
lirait le `.env.prod` : il borne les dégâts quel que soit le nombre de clés créées.

**Chiffrés au repos** (AES-256-GCM, `src/crypto/secretbox.ts`, même patron partout) : les tokens business
d'Embedded Signup (`waba_credentials`), les clés RCS par workspace (`rcs_agents.api_key_enc`), les clés AI Gateway par espace (`agent_gateway_keys.cle_chiffree`), les mots de
passe SMTP (`email_accounts.password_enc`), les secrets de connecteur API (`agent_tool_sources`).

**Hachés, jamais stockés en clair** : les clés d'API publiques (`api_keys`, sha256), les jetons d'invitation et
de réinitialisation (`auth_tokens`), les secrets de webhook entrant.

⚠️ **`/ops` n'est pas durci, il est SURVEILLÉ** (choix produit). Une liste blanche d'IP aurait coupé l'accès
dès un changement d'IP. Le jeton reste la garde ; au 5e refus dans une fenêtre de 5 minutes, une alerte
Telegram part, throttlée. 🔴 **Le jeton présenté n'est JAMAIS journalisé** : une tentative est presque toujours
un secret voisin du vrai.

⚠️ **`/ops` n'est plus en lecture seule** : `POST /ops/observe` ouvre un espace en observation, et
`POST /ops/credits/:tenantId` recharge le solde prépayé d'un workspace. C'est la seule écriture d'argent du
produit, et elle est là précisément pour qu'un client ne puisse pas créditer son propre compte.

🔴 **La session d'observation est en LECTURE SEULE par une garde GLOBALE fondée sur la MÉTHODE HTTP** :
`GET` et `HEAD` passent, tout le reste est refusé. Une garde route par route aurait laissé passer celle qu'on
oublie, et surtout toute route d'écriture AJOUTÉE DEMAIN est couverte sans que personne y pense. Effet
heureux : le marquage « lu » est un POST, donc refusé, et regarder une conversation ne fait pas disparaître
les non-lus du client.

🔴 **Changer le nom du front casse tout tiers qui VÉRIFIE L'ORIGINE**, pas seulement ceux à qui on donne une
URL. Un webhook se reconfigure parce qu'on lui a donné une adresse ; une liste d'origines se reconfigure parce
que le tiers vérifie D'OÙ VIENT L'APPEL. Les deux concernés, à compléter SANS retirer l'ancienne origine :
**Google Sign-In** (Cloud Console, « Origines JavaScript autorisées ») et **Meta Embedded Signup** (Connexion
Facebook, « Valid OAuth Redirect URIs » ET « Allowed Domains for the JavaScript SDK »).

---

## 8. Configuration

**La source canonique est `src/config.ts`**, un schéma zod qui refuse au démarrage ce qui est incohérent. Les
gabarits `.env.example` et `.env.prod.example` n'en montrent qu'une partie : ils servent à démarrer, pas à
inventorier.

Les clés se rangent en cinq familles, et savoir laquelle on touche dit le risque :

| Famille | Exemples | Ce qu'un mauvais réglage coûte |
|---|---|---|
| **Secrets obligatoires** | `AUTH_SECRET`, `META_APP_SECRET`, `DATABASE_URL`, `ENCRYPTION_KEY` | le boot échoue, ou une faille |
| **Interrupteurs de fonctionnalité** | `META_ES_CONFIG_ID`, `AI_GATEWAY_API_KEY`, `DRY_RUN`, `CONVERSATION_ANALYSIS_ENABLED` | vide = la fonctionnalité est OFF, proprement (503 explicite, file non consommée) |
| **Capacité** | `DB_POOL_MAX`, `PGBOSS_MAX`, `RATE_LIMIT_*`, `CAMPAIGN_RUN_MAX_MS` | latence, saturation muette, ou coupure de service |
| **Rétention** | `WEBHOOK_EVENTS_RETENTION_DAYS`, `WEBHOOK_PAYLOAD_RETENTION_DAYS` | une réponse RGPD fausse |
| **Paramètres commerciaux** | `EUR_PER_USD`, `COMMISSION_MODELE_PCT` | ce qu'on facture, ou ce qu'on annonce |
| **Provisionnement des clés client** | `VERCEL_API_TOKEN` + `VERCEL_TEAM_ID` | les deux vides = éteint ; une seule moitié = refus au boot (chaque création d'agent échouerait, donc plus aucun client ne pourrait en créer) |

🔴 **Le boot ÉCHOUE VITE plutôt que de dégrader en silence**, et c'est délibéré : `AUTH_SECRET` trop court en
production, `CORS_ORIGINS` à `*`, `AI_GATEWAY_API_KEY` sans ses deux modèles, une seule moitié des clés
Zadarma, `VERCEL_API_TOKEN` sans `VERCEL_TEAM_ID` ou sans `ENCRYPTION_KEY`. Chacun de ces cas produirait sinon une panne en pleine conversation, des semaines plus tard.

⚠️ **`EUR_PER_USD` est un paramètre commercial, pas un cours.** Le Gateway facture en dollars, tous nos
compteurs sont en micro-euros. Aller chercher un cours en temps réel ferait varier le prix d'une même
conversation d'un jour à l'autre, pour un gain nul, et ajouterait une dépendance réseau sur le chemin d'un
tour. Un taux absent ou aberrant retombe sur 1, JAMAIS sur 0 : un zéro rendrait toute consommation gratuite,
donc désarmerait le plafond en silence.

⚠️ **`COMMISSION_MODELE_PCT` est un AFFICHAGE**, pas une facturation : le tarif annoncé dans la liste des
modèles la porte, la consommation réellement décomptée reste le coût brut du Gateway. L'écart est dit à
l'écran plutôt que subi.

⚠️ **Un changement de `.env.prod` exige `docker compose up -d --force-recreate`** : `env_file` n'est rechargé
qu'à la recréation, pas à un `restart`.

⚠️ **`DB_SSL`, `DB_SSL_CA_FILE` et `DB_SSL_INSECURE` sont lues par `src/db/ssl.ts`, PAS par `config.ts`.**

---

## 9. Tests et preuves

### Les niveaux, et ce que chacun prouve

| Niveau | Commande | Ce que ça prouve | Ce que ça NE prouve pas |
|---|---|---|---|
| **Unitaire** (`tests/`) | `npm test` | la logique pure, les gardes, les formes | rien de ce qui touche la base |
| **Intégration** (`tests/integration/`) | `npm run test:integration` | les requêtes réelles, les contraintes, les index | l'écran |
| **Bout en bout** (`web/e2e/`) | `npx playwright test`, dans `web/` | ce que l'utilisateur voit et déclenche, l'API étant simulée | le serveur |
| **Typecheck** | `npm run typecheck` | les contrats | le comportement |

### 🔴 Le `DATABASE_URL` local pointe la PRODUCTION

Lancer les tests d'intégration en local **crée et supprime des tenants en production**. Ne pas les lancer
d'ici. La CI monte un Postgres jetable (job `integration`) : **c'est le run GitHub qui fait foi**, jamais un
`npm test` vert en local, qui n'a vérifié que la moitié.

Pour un besoin ponctuel, la voie documentée est un Postgres jetable (image pgvector sur le VPS, tunnel SSH,
`DB_SSL=off`, `ENCRYPTION_KEY` requis même pour un test non cryptographique).

### 🔴 Trois règles de preuve, chacune apprise à ses dépens

1. **Un test de non-régression se vérifie DANS LES DEUX SENS.** Un test qui passe après un correctif ne prouve
   rien tant qu'on n'a pas vu qu'il ÉCHOUE sans lui : remettre le code fautif, constater l'échec ET son
   symptôme, restaurer. ⚠️ Une mutation qui ne COMPILE pas ne prouve rien non plus : c'est le compilateur qui
   garde, pas le test. ⚠️ Et une mutation doit reproduire la VRAIE régression : une mutation qui produit une
   autre situation, elle aussi correcte, ne prouve rien.
2. **Un test qui recopie l'hypothèse du code ne la vérifie pas, il l'immunise.** Vécu : un test exigeait
   `signer(corps_envoyé) === X-Signature`, ce qui était l'invariant du module, juste partout sauf dans le cas
   qui échouait. Le test vert a donné la confiance qui a empêché d'aller mesurer.
3. **Un test instable se QUANTIFIE avant d'être accusé** : N exécutions sur le code d'avant. Jamais supposer,
   et jamais l'affaiblir pour le faire taire.

⚠️ **Une promesse d'effacement ne se teste pas avec un faux.** Les tests à faux store prouvaient que la route
appelle `purgeMany`, jamais que `purgeMany` efface quelque chose : c'est ainsi que trois pièges de format sont
partis en production. `tests/integration/purge-rgpd.integration.test.ts` écrit, purge, et RELIT ce qui reste.

⚠️ **Une garantie de MISE EN PAGE se vérifie géométriquement**, pas textuellement : une classe de grille
perdue au prochain refactor ne casse aucune assertion de texte. Les rectangles se mesurent
(`boundingBox()`).

⚠️ **`inbox-envoi-scenario.spec.ts` est INSTABLE, y compris en isolé, et ce n'est pas le code qui bouge.**
Mesuré le 2026-09-08 : 15 exécutions isolées, 15 succès. Re-mesuré le 2026-09-09 sur la MÊME machine, après
une journée de suites lourdes : **1 échec sur 5 en isolé**. Et surtout, **la RÉFÉRENCE échoue au même taux**
(5 exécutions sur le code d'avant le lot du jour : 1 échec) : le changement en cours n'y est pour rien.

🔴 **C'est la mesure sur la référence qui vaut, pas le souvenir d'une mesure précédente.** Sans elle, on
s'attribue une instabilité de machine et on part corriger un code qui n'a rien. La note « 15/15 » écrite la
veille aurait suffi à faire conclure l'inverse.

**Ne pas l'affaiblir**, et ne pas le réparer non plus tant que la CI reste verte (`retries: 1`, ressources
dédiées) : le jour où il tombe EN CI, c'est un vrai défaut.

### Sondes committées

Certaines vérités ne s'obtiennent qu'en interrogeant le tiers. Ces scripts sont dans le dépôt et se rejouent :
`scripts/sonde-flow-live.mts` (le générateur de flow_json contre le WABA réel), `scripts/fumee.mjs` (tous les
chemins publics après un déploiement), `npm run auto-attaque` (sondes d'attaque sur les routes RÉELLES,
inventoriées depuis le serveur).

---

## 10. Exploitation

**La procédure exécutable vit dans [DEPLOY.md](DEPLOY.md).** Ce qui suit est ce qu'il faut avoir en tête avant
de l'ouvrir.

### 🔴 Ce qui se décide à chaque déploiement

- **`gh run list` AVANT**, et le verdict se lit sur `gh run view <id> --json jobs`, **job par job**.
  `gh run watch --exit-status` a rendu 0 sur un run EN ÉCHEC : ne jamais s'y fier. ⚠️ Un push qui ne touche
  que des `.md` ne déclenche aucun run (`paths-ignore`) : c'est le dernier commit DE CODE qu'il faut regarder.
- **`git log <commit-déployé>..HEAD` AVANT**, parce que plusieurs sessions poussent sur `main` : on n'embarque
  pas que son propre travail.
- **L'ordre migration / déploiement dépend du TYPE de la migration.** Une migration qui AJOUTE une colonne
  écrite par le code passe **AVANT** (sinon le chemin chaud échoue en boucle : vécu, 1 h 30 sans enregistrer
  un seul message entrant). Une migration qui RETIRE une colonne encore lue par l'ancien code passe **APRÈS**.
  La question se pose à chaque fois plutôt que de suivre une routine.
- 🔴 **Les migrations vivent DANS L'IMAGE** (`COPY db ./db`), pas sur le disque du VPS. Un `git pull` suivi de
  `compose run ... npm run migrate` rejoue les ANCIENNES sans rien signaler : la séquence commence par
  `compose build mba-api`.
- **Une seule exécution de `migrate` à la fois** (verrou d'avis Postgres) : le conteneur du VPS et le poste de
  Julien pointent la MÊME base. La seconde est refusée tout de suite, avec le message qui le dit.
- **Une migration HORS TRANSACTION** (`-- migrate: no-transaction`, obligatoire pour `CREATE INDEX
  CONCURRENTLY`) n'a **aucun filet** : un échec à mi-parcours n'annule rien et la migration est rejouée depuis
  le début, donc chaque instruction doit être idempotente. `tests/migration-directives.test.ts` garde les deux
  sens de la règle sur les fichiers réels.
- 🔴 **Vérifier la migration EN BASE après coup**, pas par l'absence d'erreur : `information_schema` pour une
  colonne, `pg_indexes` pour un index, `pg_constraint` pour une contrainte, et la requête du chemin chaud
  EXÉCUTÉE. Sans trafic, un silence dans les journaux ne prouve rien.
- ⚠️ **Le nom d'une contrainte créée en ligne est généré par Postgres.** Avant d'écrire un `drop constraint if
  exists`, LIRE ce nom en base : un nom deviné à côté laisserait l'ancienne contrainte en place ET ajouterait
  la nouvelle, un `if exists` ne protégeant que de l'absence.

### 🔴 Le 502 après un `up --build`, alors que le conteneur est `healthy`

Recréer un conteneur lui donne une nouvelle IP sur `mcp-robot_default`, et nginx a résolu son amont au
CHARGEMENT de sa configuration. ⚠️ **`docker network connect` ne répare PAS ça** : le conteneur est déjà sur
le bon réseau, la commande ne fait rien, et c'est ce qui fait chercher du côté de l'application. Le remède est
`nginx -s reload` dans le conteneur NPM.

🔴 **Il est INTERMITTENT** : absent au premier déploiement de la journée, présent au second, sur exactement la
même commande. Le contrôle public est donc obligatoire après CHAQUE `up --build`, pas seulement quand on se
méfie, et il se fait sur le BON chemin : sur un hôte à routage par chemin, une URL servie par un AUTRE
conteneur rend 404 et ressemble à une panne qui n'existe pas. `node scripts/fumee.mjs` fait ce contrôle.

### Une porte à sens unique

🔴 **Dès qu'un template portant un lien `/r/<code>` est approuvé et ENVOYÉ, son adresse circule dans des
messages livrés.** Retirer la route `/r/:code`, la table `tracked_links` ou le rewrite Next les casserait
TOUS, sans recours. Le retour arrière n'existe qu'avant le premier envoi tracé. Même raisonnement pour
`/m/<code>` (les visuels RCS) et pour les liens de chaîne déjà publiés.

⚠️ **Ces adresses publiques passent par un rewrite de `web/next.config.mjs`, GELÉ au build de l'image web.**
Une route publique nouvelle vaut mieux sous le rewrite attrape-tout `/api/backend/:path*`, qui lui n'est pas
gelé.

### Surveillance

`/ops/overview` (jeton d'exploitation) : rollup par tenant, charge des files, heartbeat du worker. Les DLQ non
vides déclenchent une alerte Telegram. Le SLO vit dans [docs/SLO-2026-09-01.md](docs/SLO-2026-09-01.md).

---

## 11. Limites connues

**Elles vivent dans [todo.md](todo.md), et nulle part ailleurs.** Un « reste à faire » qui existe à deux
endroits en existe zéro : l'un des deux sera fait sans que l'autre le sache.

Les trois qui ont le plus de conséquences aujourd'hui :

- **DNS rebinding** sur les URL saisies par un administrateur de tenant (connecteur API, import de
  connaissance). Le nom est validé, l'IP finalement résolue ne l'est pas.
- **Plafonds de débit locaux au process** : à lever avant tout multi-replica, sinon le plafond annoncé est
  multiplié par le nombre d'instances.
- **`web/lib/api.ts`** reste un hub de plus de 200 exports, dette connue et en croissance.

---

## 12. Invariants actifs

Ce qui gouverne encore le code aujourd'hui. Le récit de la découverte de chacun est dans le journal ; ce qui
suit est la règle, en une formulation courte.

### Sur les données

1. **`tenant_id = $1` sur CHAQUE requête.** La RLS est contournée par le pooler, c'est le seul contrôle.
2. **`null` n'est pas `0`.** Une mesure absente et une mesure nulle sont deux faits différents ; un
   `if (!valeur)` fait disparaître la seconde, et l'écran reste crédible sans elle.
3. **Un merge jsonb n'écrase jamais une clé absente**, et un patch de fiche importe TOUJOURS
   `fichePatchSchema` : `ficheAgentSchema.partial()` ne rend PAS un objet partiel, le `.default()` survit au
   `.partial()`, et enregistrer l'objectif effacerait le ton et toutes les règles d'arrêt.
4. **Un index PARTIEL est un contrat avec une requête PRÉCISE.** Élargir le `where` sans élargir le prédicat
   ne produit aucune erreur, seulement un plan d'exécution différent.
5. **Une garde de validation se calcule sur l'état EFFECTIF après écriture** (`patch ?? courant`), jamais sur
   le corps de la requête : sinon elle ne ferme qu'un sens.
6. **On refuse une donnée ambiguë en le DISANT, on ne la devine pas.** Une date mal devinée ne ressemble pas à
   un bug, elle ressemble à une date : elle ne se voit qu'au moment où un rappel part un mois trop tôt, chez
   le client.

### Sur les envois

7. **L'émission d'un événement d'automation est gouvernée par le CHEMIN appelant**, jamais par la dépendance
   partagée. L'exécuteur de scénario sert AUSSI les campagnes : publier depuis la pose de tag ferait émettre
   un événement par destinataire. Le défaut est « n'émet pas ».
8. **Aucun chemin de MASSE n'émet** (action en masse, import CSV, API publique, campagne). Ajouter une
   émission sur l'un d'eux = envoi de masse involontaire et facturé.
9. **Un template avec en-tête média ou carousel EXIGE son média à CHAQUE envoi**, et il faut envoyer un
   `media id`, jamais un `link` : l'URL du CDN de Meta est ACCEPTÉE puis échoue deux secondes plus tard en
   `131053`, son propre téléchargeur se prenant un 403. Le piège est invisible à une sonde qui se contente de
   lire l'URL. ⚠️ La clé du cache de préparation porte le NUMÉRO d'envoi : un `media id` est scopé au numéro
   qui l'a téléversé.
10. **Le refus d'un visuel est AVANT la boucle** : y passer dans la boucle ferait voir 100 % d'échecs au
    quality gate, qui mettrait la campagne en pause avec un diagnostic trompeur.
11. **Un envoi qui n'a rien montré au contact ne se journalise pas** ; un envoi qui est parti se journalise
    toujours, quel que soit son déclencheur (campagne, inbox, bloc de scénario). Un opérateur qui voit la
    réponse sans voir la question ne peut pas reprendre la conversation.

### Sur les contrats externes

12. **Toujours `safeParse`, jamais `parse`**, sur tout webhook entrant et toute sortie JSON d'un LLM. Jamais
    de `as` sur un payload externe.
13. **Signature vérifiée AVANT de lire le corps** d'un webhook entrant.
14. **Une entrée utilisateur dans un prompt LLM est un bloc de données DÉLIMITÉ**, jamais concaténée au prompt
    système. `blocResultatOutil` encadre chaque résultat d'outil pour la même raison.
15. **Toujours 200 sur un appel bien formé d'un tiers, même si rien n'a été fait.** Un tiers qui reçoit une
    erreur réessaie en boucle, et beaucoup désactivent le webhook après quelques échecs. Le détail passe dans
    le corps.
16. **Un mapping s'applique en itérant sur NOTRE mapping, jamais sur les clés reçues** : sinon un tiers écrit
    où il veut en nommant ses clés comme nos champs.
17. **Le tenant vient du CODE de l'URL, jamais du corps**, sur toute route publique remise à un tiers.
18. **Ce qui est servi est décidé par la SIGNATURE du fichier**, jamais par le type déclaré au téléversement.

### Sur le code

19. **Avant d'écrire un helper, chercher s'il existe déjà** (§ 13). Un audit a supprimé une centaine de copies
    de fonctions que le dépôt possédait déjà.
20. **Un `Pick<T, ...>` recopié pour être RETRANSMIS est une liste à tenir alignée à la main, et elle
    dérive.** 🔴 Et le contrôle des propriétés en trop **NE TRAVERSE PAS un spread** : littéral direct ->
    TS2353, spread -> rien, `satisfies` EXTÉRIEUR -> rien, `satisfies` sur l'objet INTÉRIEUR du spread ->
    TS2561. Un câblage qui construit ses dépendances par spread n'a AUCUNE garde tant qu'on ne la pose pas
    SUR le spread.
21. **Un module `.ts` qui produit du texte destiné à l'écran prend un `locale` REQUIS**, ou porte ses libellés
    en paires `[fr, en]`. ⚠️ TypeScript ne protège PAS le rendu : `{f.label}` où `label` est une paire compile
    sans broncher et React affiche « NomName ».
22. **Les tags BCP47 sont confinés à `web/lib/day.ts` et `web/lib/format.ts`.** ⚠️ `Intl.NumberFormat` en
    français insère une espace INSÉCABLE ÉTROITE (U+202F) devant l'unité : un test qui compare sans le savoir
    échoue en affichant un attendu et un reçu visuellement identiques.
23. **Jamais de backtick dans un commentaire SQL** : nos requêtes vivent dans des gabarits JS délimités par
    des backticks, un seul dans un commentaire `--` ferme la chaîne et tsc rend une cascade d'erreurs qui ne
    pointent pas sur la vraie ligne.
24. **Un `count` d'agrégat SANS `group by` rend TOUJOURS une ligne**, même quand aucune ligne n'entre. Une
    requête censée distinguer « rien à mesurer » de « zéro » rend donc zéro dans les deux cas.
25. **Changer la NATURE d'une entrée de nav casse ses appelants**, comme un changement de signature : `href`
    et `children` s'excluent dans `NavEntree`, donc passer de l'un à l'autre change le rôle ARIA rendu, et
    tout ce qui visait l'entrée par son rôle vise désormais le mauvais.

### Sur la méthode

26. **Avant de commiter, énumérer les DÉPENDANTS de ce qu'on a changé** : qui LIT ce symbole, qui suppose son
    ancienne valeur, quelle constante d'un AUTRE fichier doit lui rester ordonnée, quel index le sert, quel
    commentaire l'affirme, quel TEXTE d'écran est devenu faux. Le hook `rayon-de-souffle.js` en calcule la
    moitié mécanique au `git commit`.
27. **Un câblage n'a par construction aucun dépendant** : la seule question à lui poser est l'INVERSE,
    « qu'est-ce que ce câblage suppose du module que je viens de changer ? ».
28. **Élargir le domaine d'une réparation sans élargir ce qu'elle TRANSPORTE** est le motif de régression
    numéro un : une valeur en dur juste sur l'ancien domaine devient fausse sans que rien ne le signale.
29. **Une transition terminale faite de deux écritures doit laisser, ENTRE LES DEUX, l'état que son réparateur
    sait reconnaître.** La réparation passe par la MARQUE, pas par l'ordre : inverser l'ordre paraît plus sûr
    et peut être FAUX.
30. **Un texte d'écran est un LECTEUR du comportement qu'on change.** Un avertissement qui décrit une
    conséquence devient faux dès qu'on élargit le domaine, et il envoie alors l'opérateur chercher un réglage
    qui n'existe pas.
31. **Un menu ne propose jamais un choix SANS EFFET VISIBLE, ni le même choix à deux endroits.** Les deux
    défauts sont invisibles de la couche serveur : l'appel part, la route rend 200, et l'écran ne change pas.
    L'opérateur en conclut que la console est cassée. Le cas de référence est le rangement de l'Inbox
    (`web/lib/inbox-rangement.ts`) : ranger dans le dossier où l'on est déjà, marquer « signalé » une
    conversation archivée alors que le dossier « Signalé » exclut les archivées, ou proposer « ne plus
    signaler » sur un constat de l'analyse, qui n'est pas effaçable à la main. ⚠️ Cette règle se teste sur le
    CHOIX DES OPTIONS, pas sur l'appel : un test qui vérifie qu'une requête est partie passe dans les deux
    sens.

---

## 13. Modules partagés

Points de passage OBLIGÉS. Chacun existe parce que la même chose était écrite plusieurs fois et avait commencé
à diverger. **Avant d'écrire un helper, chercher ici.**

### Backend

| Module | Ce qu'il porte |
|---|---|
| `src/http/scope.ts` | `scopeTenant` (le contrôle d'accès tenant), `nonEmpty`, `estUuid` |
| `src/crm/contact-store.pg.ts` -> `MATCH_BY_WAID_SQL` | résoudre un contact par `wa_id` (E.164 exact, chiffres nus, BSUID) |
| `src/crm/identity.ts` -> `waIdOfTarget` | la règle wa_id pour une cible d'envoi |
| `src/crm/date-iso.ts` | normaliser une date venue d'un tiers, et REFUSER l'ambigu en le disant |
| `src/crm/contact-filters.ts` | les règles de filtrage des contacts (bornes, opérateurs, plafonds) |
| `src/stats/range.ts` -> `BOUNDS_CTE` | les bornes de date, robustes au changement d'heure |
| `src/stats/store.pg.ts` -> `envoisTemplateFacturables()` | les envois facturables d'une période, et 🔴 l'UNIQUE heuristique d'attribution d'un fait à une campagne à scénario, désormais lue par TROIS mesures (les envois, les événements de bloc, les clics de lien) : la dernière campagne scénario réclamée pour ce numéro avant le fait. Une seconde heuristique, même voisine, donnerait deux vérités sur le même écran |
| `src/campaign/echecs-sql.ts` | 🔴 la POPULATION d'un échec d'envoi et sa DATE, lues par quatre écrans |
| `src/campaign/store.pg.ts` -> `insertCampaignRow`, `summarySelect()` | l'INSERT d'une campagne et la projection des résumés |
| `src/campaign/pause.ts` | pourquoi une campagne est en pause, et ce que l'opérateur lit |
| `src/meta/template-components.ts` | le SEUL constructeur de composants d'envoi (en-tête média, carousel, boutons tracés) |
| `src/meta/template-media.ts` | préparer un visuel, pour les cartes comme pour l'en-tête |
| `src/crypto/secretbox.ts` | AES-256-GCM, le seul chiffrement au repos du dépôt |
| `src/lib/adresse-privee.ts` | `resolutionPublique` : ce qu'un texte d'URL ne peut pas voir |
| `src/lib/page-distante.ts` | `urlRecuperable` (garde SSRF) et `fetchUrlBorne` (redirections revalidées saut par saut) |
| `src/lib/corps-borne.ts` | lire un corps distant EN FLUX, avec ses trois verdicts |
| `src/lib/cache-court.ts` | le micro-cache du dépôt : durée de vie ET mutualisation des appels en vol |
| `src/lib/http-get.ts` | une lecture GET injectable, testable sans réseau |
| `src/lib/heures-ouvrees.ts` -> `prochaineOuverture` | « quand est le prochain créneau ouvert ? », pour le bloc Attente et les campagnes |
| `src/lib/adresses-publiques.ts` | les adresses que le produit DISTRIBUE (`/r/`, `/m/`, `/w/`) |
| `src/agent/devise.ts` | dollars du Gateway -> micro-euros, en UN endroit |
| `src/agent/modeles.ts` | les modèles proposables et leur tarif client : le menu ET la garde d'écriture y lisent |
| `src/agent/llm/tool-schema.ts` -> `paramsOutil` | 🔴 la séparation des sources d'un paramètre (`modele` vs `contact` ou `fixe`). Deux lectures divergentes rendraient la cible au modèle, donc un IDOR |
| `src/agent/setup/proposition.ts` | ce que l'IA de construction a le DROIT de proposer |
| `src/agent/poser-tag.ts` | les TROIS effets de « poser un tag » depuis un agent |
| `src/agent/contexte.ts` | ce que le cerveau doit savoir d'un agent (production ET bac à sable) |
| `src/agent/fiche.ts` | les DEUX schémas de fiche : celui qui LIT, celui qui PATCHE |
| `src/webhooks/json.ts` | `asArray`, `asRecord` : lecture défensive d'un payload Meta |
| `src/queue/names.ts` | les files, leur cadence, leur DLQ, leur réveil |
| `src/ids/code.ts` | les identifiants publics et les codes de lien |

### Front

| Module | Ce qu'il porte |
|---|---|
| `web/lib/format.ts`, `web/lib/day.ts` | les seuls porteurs des tags BCP47 |
| `web/lib/campaign-eligibility.ts` | 🔴 le MIROIR de l'analyse d'ouverture serveur, tenu par un test de parité |
| `web/lib/chemin-json.ts` | le miroir de `src/webhook-entrant/chemin.ts` : mêmes chemins d'or dans les deux jeux de tests |
| `web/lib/contact-filters.ts` | les filtres du mini-CRM, miroir du parse serveur |
| `web/lib/rcs.ts` | déduire le format d'un message RCS de sa saisie, miroir de `rcsOutboundOf` |
| `web/lib/flow-mapping.ts` | la cible d'un champ de formulaire, avec la sentinelle `@profile_name` |
| `web/lib/inbox-rangement.ts` | les gestes de rangement de l'Inbox : leurs libellés, et les destinations qu'une SÉLECTION peut prendre selon le dossier |
| `web/components/VariableBodyEditor.tsx` | l'éditeur à chips, partagé par les variables Meta (positionnelles) et RCS (nommées) |
| `web/lib/session.ts` -> `pageDArrivee` | où atterrit un compte après connexion, selon son rôle |
| `src/agent/devise.ts` | LES DEUX SENS de la conversion dollars/micro-euros : le coût d'un appel, et le plafond d'une clé du Gateway |
| `src/agent/llm/cles-gateway.ts` | les deux appels Vercel du provisionnement, qui n'ont ni le même hôte ni la même authentification |

⚠️ **Un miroir front/serveur n'est pas une copie tolérée, c'est un contrat gardé par un test de parité.** La
frontière de build interdit de partager un module ; le test compare les DEUX implémentations sur une table de
cas qui doit contenir une valeur INCONNUE.

⚠️ **Un DTO recopié de part et d'autre de cette frontière** (`ConsommationAgent`, `ModeleProposable`) est la
convention du dépôt pour une forme simple. Renommer un champ d'un seul côté ne casse aucun compilateur, ça
vide la valeur à l'écran : les deux se relisent ensemble.

---

## 14. Gouvernance documentaire

### Quel document pour quelle information

Une livraison ne « met pas à jour tous les fichiers ». Elle choisit selon la NATURE de l'information :

| Ce qui a changé | Le fichier |
|---|---|
| le comportement vu par l'utilisateur | `features.md` |
| l'architecture, un invariant, le modèle de données, l'exploitation | **ce manuel** |
| la procédure de mise en production | `DEPLOY.md` |
| le travail encore en cours | `wip.md` |
| une limite ou un travail futur confirmé | `todo.md` |
| le récit d'une livraison, une mesure ponctuelle, un incident | `docs/JOURNAL-TECHNIQUE.md` |
| le compteur de migrations, les commandes, les règles de travail | `CLAUDE.md` |

### 🔴 Ce qui n'entre PAS dans ce manuel

- **Un compteur calculable.** Nombre de files, de tests, de migrations, de routes : tous ont été faux ici.
  Écrire « chaque file de `BASE_QUEUES` et sa DLQ » est plus robuste ET tout aussi compréhensible.
- **Un titre `DÉPLOYÉ`, `LIVRÉ`, `PROCHAINE ÉTAPE`, `EN ATTENTE` ou `RESTE À FAIRE`.** Ces contenus vont au
  journal, au WIP ou au backlog. Un manuel qui date ses sections devient une archive.
- **Le récit d'un bug.** L'INVARIANT durable qu'il a révélé reste ici, en une formulation courte ; sa
  découverte va au journal.
- **Un détail de `DEPLOY.md`.** Le manuel dit ce qui se DÉCIDE, le runbook dit ce qui s'EXÉCUTE.

### Avant de fusionner

1. **Quelle ancienne vérité ce changement invalide-t-il ?** C'est la bonne question, pas « ai-je ajouté une
   note ? ». Le commit qui a précédé l'audit du 2026-09-08 modifiait une phrase sur les compteurs de l'Inbox
   et laissait périmés ceux des files, des migrations et des tests.
2. **Cette affirmation décrit-elle le dépôt, la production, ou un travail non déployé ?** Le dire.
3. **Le « reste à faire » n'existe-t-il qu'une fois, dans `todo.md` ?**
4. **Les liens pointent-ils sur quelque chose ?**

### Le patron d'une section de domaine

Toutes n'ont pas besoin de tous les champs, mais ce patron évite le récit chronologique :

```md
### Nom du domaine
Responsabilité : ce qu'il fait, et ce qu'il ne fait pas.
Points d'entrée : backend, front, worker, tests principaux.
Données et invariants : tables possédées, portée tenant, règles à ne pas casser.
Flux : déroulé nominal et effets externes.
Pannes : retries, idempotence, DLQ, diagnostic.
Limites : liens vers todo.md.
```
