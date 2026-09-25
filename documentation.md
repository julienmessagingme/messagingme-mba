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
        |                                    |
        | (en direct, SANS Cloudflare)   Cloudflare (Proxied : api. et mba.)
        |                            /                        \
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

🔴 **`engageme.` NE RELAIE RIEN VERS L'API.** Les rewrites de `web/next.config` (`/api/backend/*`, `/r/`,
`/m/`) visent `BACKEND_URL`, absente chez Vercel : elles retombent sur `localhost` et rendent
`404 DNS_HOSTNAME_RESOLVED_PRIVATE` (mesuré sur les trois le 2026-09-21). Une adresse que le produit DISTRIBUE
(lien tracé, visuel, rappel d'un fournisseur, webhook entrant) se construit donc TOUJOURS par
`adressesPubliques` (`src/lib/adresses-publiques.ts`), jamais sur `APP_URL`, qui est le nom du front. Le rappel
smsmode et les boutons RCS l'ont oublié jusqu'au 2026-09-21 : `tests/rcs-adresses-cablage.test.ts` les garde.

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
  en `moduleResolution: Bundler` sans extensions, donc `node dist` casse. Plus de script `build` ni `start` à la
  racine : le contrôle est `npm run typecheck`.
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
| **Traduction** | lire les entrants dans sa langue, traduire un sortant avant l'envoi | `src/traduction/` | `/inbox` | `conversation_messages` (`traduction`), `contacts` (`langue_detectee`) | |
| **Agent IA** | un bloc de scénario qui tient la conversation seul, avec des outils | `src/agent/` | `/agents` | `agents`, `agent_tools`, `agent_tool_consommateurs`, `agent_sessions`, `agent_knowledge`, `agent_credits` | `agent-turn` |
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

🔴 **DEUX FORMES DE PAYLOAD, ET LA SECONDE EST IMBRIQUÉE.** Un `change` de champ `standby` place son
contenu **sous `value.standby`**, en laissant `metadata` au premier niveau. Tout lecteur d'un `change` passe
donc par **`valeurEffective` (`src/webhooks/change.ts`)**, qui remonte le contenu ; sur un payload normal,
elle le rend inchangé. Lire `value.messages` en direct est un défaut : il ne lève rien, il rend un tableau
vide, et le job se termine « avec succès ».

🔴 **CE QUE `standby` VEUT DIRE, MESURÉ, ET CETTE PAGE A DIT L'INVERSE PENDANT DES SEMAINES.** Elle
affirmait : « quand le Meta Business Agent tient le fil, Meta n'envoie plus `field: "messages"` mais
`field: "standby"` ». **Faux.** Relevé sur 30 jours de webhooks réels le 2026-09-15 :

| | |
|---|---|
| messages ENTRANTS du client | **126, tous en `messages`** |
| entrants arrivés en `standby` | **zéro** |
| payloads `standby` | **23, aucun ne porte d'expéditeur**, tous un `message` SORTANT |

`standby` est donc **l'ÉCHO de ce que l'agent de Meta ENVOIE**, pas un canal d'entrants. Le cas décisif est
daté : le 2026-09-15 à 07:58:39 un message du client est arrivé en `messages` alors que l'agent de Meta
tenait le fil, ce que prouve sa réponse sept secondes plus tard. **Un entrant arrive toujours sur
`messages`, que l'agent tienne le fil ou non.**

⚠️ **CONSÉQUENCE SUR LA GARDE `field !== 'messages'`, ET ELLE EST OUVERTE.** Ce qui doit se TAIRE quand le
MBA tient le fil (déclencheurs d'automation, avance de scénario, jeton de test) teste `field !== 'messages'`.
Puisqu'un entrant est toujours `messages`, **cette garde ne fait rien taire du tout**. Le risque est
aujourd'hui borné par le fait qu'un scénario qui démarre PREND le fil explicitement
(`reprendreLeFilPourLApp`), donc il ne parle plus par-dessus l'agent : c'est un garde-fou de ceinture qui
s'est révélé inerte, pas un trou vivant. À retrancher sur un signal vrai, cf. `todo.md`.

⚠️ **ET ON N'EN DÉDUIT PLUS LE DÉTENTEUR** (2026-09-15). `accorderLeDetenteur` écrivait `app_workflow` sur
chaque entrant qu'on croyait tenu par l'agent, donc sur chaque message de chaque client : c'est la valeur que
le dossier « À traiter » EXCLUT, et elle rendait invisible toute conversation dont le scénario venait de
finir. Les deux seuls signaux fiables sont un `standby` (l'agent vient de parler) et un
`messaging_handovers` / `control_passed` (il nous passe la main). L'Inbox et les accusés de livraison, eux,
enregistrent les deux formes. **Enregistrer n'est pas répondre.**

⚠️ **Un écho porte son contenu sous `message`** : `{id, timestamp, message: {to, text: {body}, recipient}}`.
`message.to` est le `wa_id`, `message.recipient` est le BSUID : les intervertir rattache le message de
l'agent à un contact qui n'existe pas.


```
Meta -> POST /webhooks/meta (mba-api)
   signature X-Hub-Signature-256 vérifiée AVANT de lire le corps
   -> payload brut enfilé dans `webhook`
   -> 200 immédiat (cible < 50 ms), zéro logique métier
                      |
      worker, job `webhook` :
        dédup par meta_message_id (les webhooks arrivent en double)
        auto-création ou mise à jour du contact (isolée : un échec ne casse pas l'inbox)
        capture du referral CTWA (premier message seulement) : champs de la fiche
        enregistrement dans le fil
        arrivée publicitaire (`arrivees_pub`, ctwa_clid et standby compris), isolée
        routage du lead publicitaire (lot 3), isolé : il ANNOTE l'arrivée ci-dessus et
          RESTREINT les déclencheurs ci-dessous, et il reprend le fil à l'agent de Meta
          quand la publicité confie ses prospects à un scénario
        puis, DANS CET ORDRE et chacun isolé en try/catch :
          1. mapping de formulaire  (nfm_reply -> champs de la fiche)
          2. jeton de test          (CONSOMME le message, personne d'autre ne le voit)
          3. automations            (mot-clé, tag, lien de chaîne) -- CONSOMMENT aussi,
             et le routage publicitaire peut n'en autoriser QU'UNE, ou aucune
          4. rendu des fils pris pour rien (le routage a pris le fil, rien n'a démarré)
          5. avance de scénario     (le contact a répondu, sur ce qui reste)
```

🔴 **LE ROUTAGE PUBLICITAIRE EST ENCADRÉ PAR SES DEUX VOISINS, ET C'EST LA MOITIÉ DE SON COMPORTEMENT.**
Après l'arrivée, parce qu'il annote la ligne qu'elle vient d'écrire ; avant les déclencheurs, parce que
c'est eux qu'il restreint. Il perce aussi, pour UN cas et un seul, la doctrine « un message `standby` ne
déclenche rien » : un lead dont il a DÉJÀ repris le fil chez Meta. Le rendu des fils pris pour rien vient
après les déclencheurs, parce qu'eux seuls savent si quelque chose a réellement démarré.

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

🔴 **Les accusés gardent le tarif que Meta annonce** (`tarifs_meta`, migration 0163), sur les DEUX files qui
voient des accusés : `WebhookJobDeps` rend `tarifsMeta` obligatoire avec `delivery`. Toute lecture de COÛT
exclut les messages `free_entry_point` (les 72 h gratuites qui suivent un clic sur une pub) par un fragment
unique, `horsEntreeGratuite` (`src/stats/entree-gratuite.ts`) ; les courbes de VOLUME les comptent,
délibérément. Un message sans ligne de
tarif reste compté comme payant.

⚠️ **Le referral d'une publicité Click-to-WhatsApp n'arrive que sur le PREMIER message** après le clic. Ne pas
le capter à l'arrivée, c'est perdre l'origine du lead définitivement. Il atterrit dans deux champs de contact
(`pub_id`, `pub_titre`) plutôt que dans une colonne dédiée : l'origine devient ainsi filtrable, utilisable
comme variable et segmentable en campagne, sans migration. `ctwa_clid` peut arriver VIDE, n'en jamais faire
une condition. Chaque arrivée garde aussi sa ligne dans `arrivees_pub` (migration 0163), `standby` compris :
c'est la seule trace de `ctwa_clid`. La purge RGPD efface `ctwa_clid` et garde la ligne (elle anonymise la
fiche sans la supprimer, donc la cascade ne joue pas). `WebhookJobDeps` rend `arriveesPub` obligatoire avec
`inbox`.

### 4.2 Une campagne part

```
POST /campaigns          création : destinataires matérialisés, variables résolues
POST /campaigns/:id/run  -> job `campaign-run` (expiration DIMENSIONNÉE au volume et au débit)
   runCampaign :
     verrou d'exécution (bail + jeton de garde + drapeau de relance)
     pour chaque destinataire pending :
       arrêt du service ? durée max du lot atteinte ? hors heures ouvrées ?
       relecture du statut (l'opérateur a pu mettre en pause)
       quality gate Meta
       claim ATOMIQUE (pending -> sending)   <- ce qui empêche le double envoi
         et relit la fiche : STOP ou blocage posés depuis -> écarté (`skipped`), rien ne part
       envoi, puis résultat persisté HORS du catch d'envoi
```

🔴 **Le claim atomique par destinataire est la seule garantie anti-double-envoi.** Ni la file ni le verrou ne
la donnent : aucune file de ce dépôt ne déduplique quoi que ce soit (voir § 6).

🔴 **Le consentement se lit DEUX fois : à la construction de la liste (`optInAllows`), puis au moment d'envoyer,
par le claim** (`PgRecipientStore.claim`, son `returning` lit la fiche par sa clé primaire). Une campagne étalée
(débit bas, pause, heures ouvrées) part des heures après sa construction : un STOP ou un blocage posés entre les
deux rendent un écart, marqué `skipped` avec son motif (`MOTIF_ECART_A_L_ENVOI`, celui du STOP étant le texte du
scénario), jamais `failed` (la porte de qualité ne le compte pas). Le destinataire est réservé quand même : un
seul run l'écarte.

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
`besoinsFenetre` (reprise), la garde de `runFrom` (ouverture à froid) et `ouvertureApi` (API publique,
`src/workflow/ouverture-api.ts`, qui juge ce qui part en PREMIER depuis l'entrée ou depuis le bloc visé).

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
       prompt : mention d'IA EN TÊTE, si le régime de l'ESPACE la demande pour CE tour (0126, remontée à
       l'espace par 0140 : l'obligation pèse sur la marque déployante, pas sur chaque robot)
       appel du modèle (Vercel AI Gateway, seul chemin livré aujourd'hui)
       si appel d'outil : executor d'outil (validation, injection, budget de temps, journal, troncature)
         résultat encadré par `blocResultatOutil`, jamais concaténé au prompt
       jusqu'à une SORTIE nommée, un plafond, ou une erreur
   -> le parcours repart par le handle `sortie:<code>`
```

⚠️ **LE FOURNISSEUR IA N'EST PAS ENCORE INTERCHANGEABLE.** `GatewayChatClient`, le catalogue, le coût rendu
par le Gateway et les clés par espace sont spécifiques à Vercel. La cible prévoit une route Azure OpenAI
régionale France activable manuellement pour certains contrats, sans bouton dans Engage Me ; tant que le lot
n'est pas livré et testé, elle reste une option d'architecture et non une capacité de production. La source
unique de cette cible et de ses limites est `docs/ARCHITECTURE-CIBLE.md`, §2.1.

🔴 **LA DÉFINITION D'UN OUTIL APPARTIENT À L'ESPACE, LE CONSENTEMENT AU COUPLE (outil, consommateur).**
`agent_tools` porte ce qu'un outil EST (son nom, unique par espace, sa description, ses paramètres, sa
liaison, son risque, ses plafonds) ; `agent_tool_consommateurs` porte qui a le droit de s'en servir. Les
tenir ensemble obligeait à redécrire le même outil pour chaque agent, donc à corriger ses mots à N endroits,
et rendait impossible de l'exposer au Meta Business Agent sans lui inventer une fiche d'agent.

⚠️ **LE CONSOMMATEUR EST UNE CLÉ TEXTE**, `agent:<uuid>` ou `mba:<phone_number_id>`, fabriquée par
`src/agent/consommateur.ts` et jamais concaténée ailleurs ; sa FORME est verrouillée par un CHECK, parce
qu'une faute de frappe produirait une ligne MUETTE (aucun consommateur ne la lit, l'outil paraît simplement
inactif, et il n'y a rien à diagnostiquer). Une clé texte plutôt qu'une clé étrangère parce qu'un
consommateur n'est pas toujours une ligne de notre base : **le MBA est un numéro chez Meta**, et c'est
précisément ce qui en fait un consommateur comme un agent.

🔴 **Le consentement humain est porté par la BASE, pas par une convention** : deux CHECK sur
`agent_tool_consommateurs` (`actif = false or active_par is not null`, `autonome = false or autonome_par is
not null`). La spec MCP exige un consentement humain avant invocation ; notre agent n'a aucun humain au
runtime, donc le consentement est déplacé du runtime vers la CONFIGURATION. Ils sont RECOPIÉS À L'IDENTIQUE
depuis 0086 : les perdre en remontant la définition aurait vidé 0086 de son contenu sans que rien ne le
signale.

🔴 **CE QU'ENGAGE ME A, META L'A : la publication ÉCRASE** (décision de Julien du 2026-09-10). La
réconciliation se fait sur les NOMS, jamais sur un identifiant Meta qu'on stockerait (une table de
correspondance dériverait dès qu'un client supprime un connecteur dans WhatsApp Manager). Corollaire assumé :
renommer un outil chez nous se lit « supprimer l'ancien, créer le nouveau », et l'aperçu le dit avant le clic.
Le plan est PUR (`src/mba/publication.ts`, aucune IO) et il compare la description et TOUTE la définition
envoyée (méthode, chemin, en-têtes, corps), normalisée : en comparer une partie rendait la publication
silencieusement incomplète.

🔴 **META APPELLE LE RELAIS, PLUS LE SYSTÈME DU CLIENT** (migration 0161, spec
`docs/superpowers/specs/2026-09-21-relais-mba-design.md`). Un espace qui expose au moins un outil a UN
connecteur chez Meta, `EngageMe`, dont l'adresse est `PUBLIC_API_URL` + `/mba/relais` ; chaque outil y est un
`POST /outils/<id>`. Les invariants :
- **L'espace vient de la CLÉ** (`POST /mba/relais/outils/:outilId`, monté dans l'entrée `v1`, même
  `requireApiKey` et même limiteur que l'API publique), jamais de l'adresse ; l'outil doit être exposé ET
  actif pour `mba:<numéro de l'espace>`.
- **Le contact vient d'un en-tête lié à la macro `WHATSAPP_PHONE_NUMBER`** (`X-Contact-WhatsApp`) : Meta le
  remplit, son modèle ne le choisit pas. Pas de contact identifié, pas d'appel.
- **Seules les variables `modele` sont déclarées chez Meta** et lues dans le corps (`lireValeursModele`, Zod) ;
  les autres viennent du mini-CRM, dans `creerAppelConnecteur`, avec la lecture `entier` (réponse complète,
  bornée) et le journal sous l'appelant `mba`. Un échec métier rend 200 `{ succes: false, erreur }`.
- **La clé « Agent de Meta »** est une clé d'API de l'espace au droit `mba:relais`, absent de
  `VALID_API_SCOPES` : aucun écran ne l'attribue. `tenant_settings.mba_relais_cle_id` retient celle qui est
  chez Meta (Meta ne rend jamais un secret) ; toute écriture du connecteur pose une clé NEUVE dans l'ordre
  de `src/mba/cle-relais.ts` (créer, écrire chez Meta, retenir après l'accusé, révoquer TOUTE autre clé
  `mba:relais` de l'espace ; après un échec, plus aucune n'est retenue, donc la publication suivante en
  repose une). Chaque création et révocation est auditée (`cle_api.creee`, `cle_api.revoquee`).
- 🔴 **Une seule publication à la fois par espace** (`POST /mba-publication` rend 409 à la seconde) : deux
  poses de clé entrelacées se révoqueraient l'une l'autre. Verrou LOCAL AU PROCESS, suffisant tant que l'API
  tourne en une instance (`todo.md`).
- ⚠️ `agent_tool_sources.secret_publie_le` (0129) et `marquerSecretPublie` ne sont plus lus : le secret d'un
  client ne part plus chez Meta. Colonne morte, à retirer (`todo.md`).

🔴 **UN OUTIL MAISON DE L'AGENT DE META N'APPELLE PERSONNE** (migration 0162, spec
`docs/superpowers/specs/2026-09-21-outils-maison-mba-design.md`). Il est publié sous `EngageMe` comme un
connecteur, mais le relais exécute son geste lui-même. Les invariants :
- **Stockage** : une ligne d'`agent_tools` avec `origin = 'mba'`, `agent_id` null et `pour_agent_meta = true`,
  exposée par une ligne de consentement `mba:<numéro>` née active au nom de l'administrateur qui crée. La cible
  (l'étiquette, le champ, le bloc, le scénario) vit dans `binding`, validée à CHAQUE lecture par `cibleMaisonSchema`
  (`src/mba/outils-maison.ts`, `.strict()`) : une cible illisible n'est ni publiée ni exécutée.
- **Les handlers sont À PART de ceux des agents IA** (`tag_fixe`, `champ_fixe`… contre `poser_tag`…), et un test
  tient leur disjonction : un outil de l'agent de Meta qui atteindrait un agent IA serait refusé, pas joué.
- **Jamais proposé ni rattachable à un agent IA** : `listCatalogue` l'exclut, `rattacherConsommateur` refuse un
  consommateur `agent:` sur un outil `pour_agent_meta`. Son nom partage l'index unique de l'espace
  (`agent_tools_nom_espace_uidx`) : deux outils ne peuvent pas porter le même nom sous `EngageMe`.
- **La cible est FIXÉE par l'administrateur** ; Meta ne fournit que la valeur d'un champ (`{"valeur": …}`,
  bornée à la liste permise). Les gestes réutilisent `creerPoserTagAgent` (déclaration, `tag_added` si nouveau)
  et `mergeFieldsByPhone`. Le journal ne porte que la nature du geste, jamais une valeur du client.
- **Ce qui part chez Meta** se calcule dans `src/mba/outils-a-publier.ts` (appels de connecteur ET gestes
  maison), testé ; un MCP, une action d'agent IA exposée par l'ancienne route ou une cible illisible ne partent pas.
- **L'onglet « Outils » du MBA** parle aux routes `src/http/mba-outils.ts` (`/tenants/:tenantId/mba-outils`),
  qui ne voient que le consommateur `mba:<numéro>`. `src/http/agent-catalogue.ts` ne garde que la lecture de la
  bibliothèque (agents IA, assistant). « Supprimer » retire l'outil à l'agent de Meta (`retirerDeMba` : SUPPRIME
  un outil qui n'a plus de consommateur, DÉTACHE un connecteur partagé). Le départ d'un collaborateur éteint ses
  consentements (`deleteUser`) : l'outil passe « Désactivé » et se rallume par `PUT …/:id/actif`.

🔴 **UNE ACTION OU UN CONNECTEUR HTTP QUE PLUS PERSONNE N'UTILISE PART ; UN OUTIL MCP RESTE** (décision de
Julien, 2026-09-21). Plus aucun écran ne supprime une définition à la main : l'effacement suit le DERNIER
détachement, par trois chemins qui portent la même condition (plus aucun consommateur) : `detacher` (un agent IA
retire l'outil), `PgAgentStore.remove` (un agent est supprimé) et `retirerDeMba` (l'agent de Meta le retire).
Sans elle, un connecteur orphelin gardait son nom pris et bloquait la suppression de sa requête dans Connecteurs
API, sans écran pour s'en défaire. Un outil MCP reste parce qu'il vient d'un import et doit rester branchable.
- 🔴 **L'effacement VERROUILLE la définition avant son `not exists`** (`verrouillerDefinitions`,
  `src/agent/catalog.pg.ts`) : sans ce verrou, un rattachement concurrent, pas encore validé donc invisible,
  partait dans la cascade. Et tout insert de consentement sur une définition existante prend `for key share`
  (`rattacherConsommateur`) : il attend un effacement en cours et rend `false`, jamais une erreur de clé
  étrangère. 🔴 **UN ORDRE DE VERROUS POUR LES CONSENTEMENTS ET LE JOURNAL** : l'AGENT, ses SESSIONS, les
  DÉFINITIONS (triées par identifiant), puis ce qui en dépend (lignes de consentement, appels journalisés). Le
  journal d'un appel prend la session avant l'outil (l'ordre de ses déclencheurs de clé étrangère, figé par un
  test) ; un consentement `agent:` verrouille son agent avant l'outil (`verrouillerAgentDuConsommateur`) ;
  `detacher` et `retirerDeMba` prennent la définition avant la ligne de consentement, et l'effacement d'une
  définition touche ensuite les appels (`tool_id on delete set null`). D'où `PgAgentStore.remove` : verrouiller
  l'agent et ses sessions, lire ses consentements, verrouiller leurs définitions, et SEULEMENT ENSUITE la cascade
  et le retrait. Les trois autres ordres essayés interbloquaient (40P01, donc un 500) ; le JSDoc de `remove` les
  nomme. Les chemins VOISINS s'y alignent : l'import d'un serveur MCP verrouille d'un bloc, par identifiant, les
  définitions existantes qu'il va écrire, AVANT ses insertions (chacune prend le serveur par sa clé étrangère, et
  la suppression d'un serveur prend ses outils puis le serveur) ; la suppression d'un serveur MCP verrouille ses
  outils par identifiant avant sa cascade ; la
  relecture d'une source de connaissance prend l'agent avant ses fiches. Tout nouveau chemin qui écrit plusieurs
  définitions passe par `verrouillerDefinitions` ; `tests/integration/outils-maison-mba.integration.test.ts`
  rejoue chacun de ces interblocages, le consommateur fantôme et le cas inverse.
- 🔴 **UN BLOC PART SEUL** (`blocSeul`, `src/mba/outils-maison.ts`) : le bloc désigné par son CODE public
  (`nod_…`), dans un graphe RÉDUIT à lui seul, et seulement si ce graphe se termine sans rien attendre (`walk`,
  `mbaActif: true`). Un bloc à boutons, une question, un formulaire, une attente, un agent IA ou un bloc RCS sont
  refusés, avec leur raison. Vérifié à la création (route) et à CHAQUE appel du relais : le scénario PUBLIÉ a pu
  changer. Le relais l'envoie par `startFromNode` (le chemin de l'API publique vers un bloc) : il REPREND le fil à
  l'agent de Meta, envoie, et le lui rend à l'accusé (0149). Hors fenêtre de 24 h, seul un bloc fait de modèles part.
- **Lancer un scénario** passe par `lancerScenarioPourContact` (`src/index.ts`), le MÊME chemin que le bouton de
  l'Inbox (fenêtre ouverte : `startInWindow`, fermée : `start`), et un scénario sans bloc publié est refusé.
- 🔴 **TOUT ÉCHEC APRÈS LA REPRISE DU FIL LE REND, EXCEPTION COMPRISE** (`src/mba/gestes-envoi.ts`, testé) :
  `runFrom` reprend le fil puis peut refuser (désabonné, envoi refusé), et rend alors une raison SANS rendre la
  main, parce que ses autres appelants ont un opérateur ; il peut aussi LEVER (Meta refuse un modèle en pause,
  coupure réseau), et l'exception traverse tout. Dans les deux cas le relais appelle `rendreLaMainApresParcours`
  (le geste de fin de parcours, nommé dans `wiring.ts` et rendu par `buildWorkflowRuntime`). Si la reprise
  elle-même a échoué, ce geste ne touche à rien (`only: ['app_workflow']`). Une PANNE d'envoi ne s'invite pas à
  réessayer (`erreurDePanne`) : le message a pu partir avant l'exception.
  Un contact bloqué ne reçoit ni bloc ni scénario (`DepsMaison.estBloque`, lu AVANT tout envoi).
- 🔴 **LA RÉPONSE « À CÔTÉ » PART CHEZ L'AGENT DE META** : dans la branche « il a écrit » d'`advance`, le fil est
  rendu PUIS CE message du client (lu par son identifiant, `corpsDuMessage`) lui est transmis par `agent_event`
  (`src/mba/transmettre-hors-parcours.ts`, testé ; l'événement dans `src/mba/evenement.ts`, `payload` en chaîne
  JSON bornée à 4 096 caractères APRÈS échappement, `to` en E.164 avec « + », mesuré). Seulement sur un VRAI
  message WhatsApp : cette branche reçoit aussi une réaction (sa charge porte le message visé) et un rapport RCS,
  qui ne se transmettent pas. Seulement si le fil est vraiment à lui (`mba`) : une conversation de test, un
  release refusé ou un marqueur en attente laissent un autre détenteur. Rien sur une fin normale de parcours ni
  sur un bouton sans suite (qui part à un humain), ni pour un message sans texte.
- 🔴 **LE MARQUEUR DE 0149 NE SE POSE PLUS SUR UN ENVOI DÉJÀ TRAITÉ PAR META** (`demanderReleaseMba`) : il
  n'attend que si notre dernier envoi est le dernier message du fil (aucun ENTRANT plus récent), n'est pas acquitté
  (`conversation_messages.accuse_le`, posé au premier statut par `consommerReleaseMba`, 0162) et a moins de
  `ENVOI_EN_VOL` (dix minutes : Meta acquitte en une seconde). Sans cela, la réponse « à côté » et la question
  expirée gelaient le fil en `app_human` jusqu'au balayage. La borne de temps traite aussi les envois ANTÉRIEURS
  au lot 4, acquittés sans que personne n'écrive `accuse_le`.
- Le relais REFUSE d'écrire un champ supprimé du mini-CRM (`DepsMaison.champExiste`, même liste que la ligne
  rouge de l'onglet). Un outil « Désactivé » (départ de son auteur) reste LISTÉ chez Meta jusqu'au prochain
  envoi, rien ne republiant à ce départ : la ligne propose de l'en retirer. La vue porte le RISQUE, et l'onglet
  dit « irréversible » : l'agent de Meta appelle sans validation humaine.

🔴 **UN SERVEUR MCP EST UNE SOURCE COMME UNE AUTRE, et c'est ce qui rend le lot petit.** Il n'y a pas de
table dédiée : un serveur est une ligne d'`agent_tool_sources` avec `kind = 'mcp'`, ses outils sont des
lignes d'`agent_tools` avec `origin = 'mcp'`, et tout ce qui existe déjà (consentement par consommateur,
plafonds, journal des appels, risque, autonomie) s’applique sans être réécrit. Ce que l’import ajoute vit
dans quatre colonnes nullables (`mcp_annonce`, `mcp_non_activable`, `mcp_indisponible_le`, `mcp_vu_le`).
Le transport est à part (`src/mcp/client.ts`), la traduction d’une annonce en outil est PURE
(`src/agent/mcp/`), et la route n’orchestre que les deux.

🔴 **LE CROISEMENT origin/kind EST FERMÉ PAR UNE CLÉ ÉTRANGÈRE COMPOSITE, PAS PAR UN DÉCLENCHEUR** (0152) :
`agent_tools (source_id, source_kind)` référence `agent_tool_sources (id, kind)`. Sans elle, un outil
`origin='mcp'` pouvait pointer une source `kind='http'`, et le résolveur serait parti dans la mauvaise
branche, c'est-à-dire aurait POSTé une enveloppe JSON-RPC sur l'API métier d'un client.
⚠️ **Elle est en `MATCH SIMPLE`** : une ligne dont `source_kind` est null lui échappe, ce qui est exactement
ce qui permet au code d’avant le déploiement de continuer à créer des outils. Le résolveur porte donc la
même vérification en ceinture, et le CHECK strict viendra APRÈS le déploiement.
⚠️ **Elle n’a PAS de clause `on delete`, et la suppression d’un connecteur marche quand même** : sa jumelle
sur `source_id` seul porte `on delete cascade`, qui s’exécute d’abord, si bien que le `NO ACTION` de la
composite, différé en fin d’instruction, ne trouve plus rien. Vérifié sur PostgreSQL 17.6 en reconstruisant
la topologie exacte sur des tables TEMPORAIRES, contre-épreuve comprise (sans la cascade, la composite
refuse en `23503`) : ce n’est pas de la chance, c’est la cascade qui l’autorise.

🔴 **UNE LISTE PARTIELLE NE FAIT JAMAIS DISPARAÎTRE UN OUTIL.** `tools/list` est paginé ; une page qui
échoue rend un ÉCHEC, jamais les pages déjà lues, et un catalogue tronqué (bornes atteintes) pose
`tronque: true`. Dans les deux cas la règle est la même : **on AJOUTE et on MET À JOUR, on ne RETIRE
jamais**. Un appelant qui prendrait une liste partielle pour le catalogue entier marquerait « disparus » la
moitié des outils d'un client et ferait tomber leurs consentements, pour une panne réseau d'une seconde.

🔴 **CE QUE LE MODÈLE VOIT EST UN SOUS-ENSEMBLE DE CE QUI PART.** `ParamOutil.source` vaut `modele`,
`contact`, `champ` ou `fixe` ; seul `modele` entre dans le schéma envoyé au fournisseur, les trois autres
sont injectés par le runtime à l'appel. C'est la garde anti-IDOR du lot : un paramètre cloué ne peut pas
être influencé par ce qu’un contact raconte. `reporterClouage` rejoue ces choix à chaque rafraîchissement,
par `cheminMcp` : sans lui, un changement de schéma rouvrirait la garde en silence.

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
modules à routes `:tenantId`, tenu par `tests/scope-tenant.test.ts`. Sa couverture est **dérivée** du registre
des modules de routes (`modulesDeRoutes`, `src/server.ts`), où chaque module déclare sa classe d'accès : il n'y
a aucune liste de modules à tenir à jour.

### Identité d'un contact : un numéro OU un BSUID

`src/crm/identity.ts` : `waIdOf(phone, bsuid)` est la clé de routage WhatsApp, `classifyWaId(waId)` la lit à
l'envers (7 à 15 chiffres -> numéro, sinon BSUID). `contacts` porte `phone_e164` **ou** `bsuid`, contrainte
« au moins un », deux index uniques partiels.

⚠️ **Trois formats coexistent et se confondent facilement** : le fil porte un `wa_id` SANS `+`
(`33612345678`), la fiche un E.164 (`+33612345678`), et le cache de joignabilité RCS a pour clé l'E.164. La
correspondance passe par le prédicat partagé `MATCH_BY_WAID_SQL`, jamais par une égalité directe.

⚠️ **Le cache de joignabilité RCS est écrit par le RAPPORT DE LIVRAISON**, smsmode ne sachant pas la dire avant
l'envoi : un échec définitif y pose « injoignable », une livraison « joignable », pour l'agent qui a envoyé et
toujours en E.164 (`traiterRapportRcs`, `src/rcs/rapport-livraison.ts`). `envoyerRcsLibre` le lit directement
pour une MACHINE seulement (l'opérateur de l'Inbox n'y est pas soumis), et un « injoignable » plus vieux que
`TTL_MS` ne refuse plus rien.

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
- ⚠️ **Trois rôles, et DEUX niveaux de droits.** Un `agent` n'a que l'Inbox. Un `manager` y ajoute les écrans
  de CONFORMITÉ (Sécurité : accueil, Consentement, IA, Audit trails, Journal des erreurs), qu'il CONSULTE, et
  il affecte les conversations. Il RÈGLE une seule chose : `tenant_settings.agents_peuvent_prendre`, la seule
  écriture du module de réglages montée sous `gardeEncadrement` (`/settings/agents-peuvent-prendre`) ; l'écran
  Paramètres ne lui montre que cette section. Tout le reste est `admin`.
  ⚠️ Le sélecteur d'affectation lit `GET /conversations/membres-affectables` (encadrement), PAS `GET /users`
  (admin) : avec la seconde, un manager avait un menu vide.
  🔴 **La liste est UNE, et trois choses en dérivent** : `ECRANS_ENCADREMENT` / `accesAutorise`
  (`web/lib/nav.ts`) servent la garde d'accès de la console, le FILTRAGE du menu, et la carte du bot d'aide.
  Côté serveur, la garde correspondante est `requireEncadrement` (`src/server.ts`). Les deux moitiés doivent
  bouger ensemble : une garde serveur qui nomme un rôle sans que la console y mène n'est pas une capacité,
  c'est une promesse, et c'est exactement ce que la revue du chantier 6 a trouvé.
  ⚠️ **Le reste des prérogatives d'un manager n'est pas décidé** (campagnes, contacts, scénarios, réglages) :
  ça se décide écriture par écriture, cf. `todo.md`.
- 🔴 **La connexion multi-espace est en deux temps.** Un seul espace -> session directe. Plusieurs -> le
  serveur rend la LISTE et un jeton de CHOIX, jamais une session. Ce jeton ne peut pas tenir lieu de session
  (pas de `tenantId` ni de `role` à la racine, `kind` vérifié) et il PORTE la liste signée des espaces
  autorisés : sans elle, présenter un jeton légitime avec l'identifiant d'un espace quelconque suffirait à y
  entrer.

**Contacts**

- `contacts` : `fields jsonb` (merge qui n'écrase jamais une clé absente), `tags text[]`, opt-in tracé,
  `deleted_at` (soft delete, index partiel), `anonymized_at`, `blocked_at`.
- 🔴 **Le risque de désengagement vit SUR LA FICHE** (migration 0178, lot 7 de l'API publique) :
  `risque_niveau`, `risque_score`, `risque_raisons`, `risque_calcule_le`, nuls tant que la fiche n'a jamais été
  calculée (les raisons valent alors un tableau vide). La cohérence est un CHECK en base : `inconnu` n'a jamais
  de score, et un niveau ne va jamais sans sa date. Le SEUL écrivain est le balayage de nuit (§ 6). La grille
  (points, seuils, niveaux, codes) vit dans `src/engagement/risque.ts`, en règles PURES, et sa justification
  dans la spec (`docs/superpowers/specs/2026-09-24-api-publique-coherente-design.md` § 19) : elle n'est pas
  recopiée ici. Trois lecteurs : la fiche de l'API publique (`engagementRisk`), la ligne de la console
  (`ContactRow.risque`, dont chaque `select` nomme `COLONNES_RISQUE`) et le filtre de la liste.
- 🔴 **`risque_calcule_le` veut dire « à ce niveau DEPUIS le », pas « calculé le »** (2026-09-25). Le balayage
  ne réécrit QUE les fiches dont la valeur change (garde `is distinct from` sur le niveau, le score et les
  raisons, dans `PgRisqueStore.ecrire`) : réécrire chaque nuit toutes les fiches évaluées produisait une version
  morte par fiche et par nuit dans la table du chemin chaud. La date ne bouge qu'au changement de NIVEAU ; un
  score ou des raisons qui changent au même niveau sont réécrits sans elle. La console dit « depuis le », l'API
  le dit de `computedAt`. C'est aussi la trace que lit le plafond du jour du déclencheur « risque élevé » (§ 6).
- ⚠️ **L'index du risque `contacts_tenant_risque_idx` ne sert PAS la lecture des fiches à réévaluer**, contrairement
  à ce que dit le commentaire de la migration 0178 : `risque_niveau is not null` n'y est qu'une branche d'un OU
  dont une autre est un `exists`, et aucun index ne sert la condition entière (la requête parcourt les fiches de
  l'espace). Il sert le filtre par niveau et le compte du plafond du jour, deux égalités nues. Une migration
  appliquée ne se réécrit pas : la correction vit dans `PgRisqueStore.contactsAEvaluer` et ici.
- 🔴 **Le filtre par niveau de risque est le SEUL filtre de contacts qui se REFUSE au lieu de s'ignorer.** Une
  valeur hors des quatre niveaux lève `FiltreContactInvalide` dans `buildContactFilters`, et son `statusCode`
  la fait rendre en 400 par le gestionnaire d'erreurs, sur toute route qui lit des filtres, sans que la route
  ait à le traiter. Ignorée, elle ne poserait aucune clause, et « risque élevé » rendrait tout l'espace à une
  campagne. ⚠️ Son prédicat est une égalité NUE, `risque_niveau = $n`, derrière `tenant_id = $1 and deleted_at
  is null` : c'est le contrat de l'index partiel `contacts_tenant_risque_idx (tenant_id, risque_niveau) where
  deleted_at is null`, et `tests/contact-where.test.ts` relit la migration pour le tenir. Une fiche jamais
  calculée n'est dans aucun niveau, `inconnu` compris : `inconnu` est un calcul qui n'a rien pu observer.
  ⚠️ La console ne PROPOSE ce filtre que si l'API a montré qu'elle le connaît (une ligne de `/contacts` porte la
  clé `risque`, `apiConnaitLeRisque`) : une API qui ne le connaît pas l'ignorerait, et « élevé » rendrait tout
  l'espace. Un filtre déjà posé reste affiché.
- 🔴 **`/v1/contacts` désigne une personne par sa FICHE, et UNE fonction la trouve** : `resoudreFiche`
  (`src/api/fiche.ts`). Quatre clés, `contactId`, `externalId`, `phone`, `bsuid` : toutes celles qu'on donne
  doivent désigner la même fiche (sinon `identity_conflict`, et la fiche n'est pas modifiée) ; une clé que la
  fiche ne porte pas encore lui est RATTACHÉE, jamais substituée, et le rattachement est tout ou rien (le
  `where` de `rattacherCles` et celui du `do update` de `creerFicheApi` gardent chaque clé demandée) ;
  `contactId` ne crée jamais rien. Elle rend une fiche, jamais une adresse : l'adresse d'envoi se calcule sur
  la fiche. `contacts.external_id` est unique PAR ESPACE (index partiel `contacts_tenant_external_id_uidx`), et
  la purge l'efface avec le numéro. ⚠️ Exception assumée à « rien n'est écrit » : une définition de champ a pu
  être créée (la préparation des champs passe avant la résolution), et elle compte dans le plafond de
  l'espace. ⚠️ `/v1/sends` (mode `phone`, `jamais` pour une ouverture de session), `/v1/messages/whatsapp` et `/v1/messages/rcs` (mode `jamais`) passent par cette même résolution ; les deux dernières rattachent une clé neuve même quand le message est ensuite refusé.
  ⚠️ Rattacher un numéro à une fiche qui n'avait qu'un BSUID change son adresse WhatsApp (`waIdOf` préfère
  le numéro).
- 🔴 **L'API écrit champs, étiquettes et nom par `editerFicheApi`, jamais par `applyEdits`** : une requête
  filtrée par `deleted_at is null`, sans transaction ni client dédié. Une fiche purgée entre la résolution et
  l'écriture n'est donc pas réécrite (`unknown_contact`), et un lot ne retient pas une connexion par élément.
  `applyEdits` (la fiche de la console) verrouille sans ce filtre.
- 🔴 **Un consentement posé par l'API passe par `ecrireConsentementParId`**, qui n'écrit RIEN quand la valeur
  ne change pas : un outil qui renvoie `opted_out` à chaque appel ne repousse pas la date du désabonnement et
  n'écrit pas une ligne d'audit par appel. Sur une fiche déjà `opted_in`, un `opted_in` d'une autre source ne
  réécrit rien : la source d'origine du consentement est gardée. L'opt-out s'annonce au connecteur du client
  comme sur les autres chemins, et l'audit porte `contact.optin` ou `contact.optout` avec la source `api`.
  Une fiche purgée entre la résolution et cette écriture rend `unknown_contact`, jamais « mis à jour ».
- 🔴 **L'API ne réabonne jamais** (décision de Julien du 2026-09-24) : un `consent: "opted_in"` sur une fiche
  `opted_out` rend 409 `opted_out` et n'écrit RIEN, ni le consentement, ni les champs, ni les étiquettes, ni une
  clé rattachée : le refus tombe AVANT la résolution de la fiche, qui écrit (`clesDesignentUnStop`,
  `src/api/contacts-v1.ts`) ; dans `/v1/contacts/batch`, l'élément est en erreur `opted_out`. Un STOP arrivé
  pendant l'appel est refusé par le dépôt lui-même (`ecrireConsentementParId` rend `refuse`). Sur `/v1/sends`, le
  destinataire est écarté `opted_out` et la fiche reste désabonnée. Lever un STOP est un geste d'opérateur,
  depuis la fiche de la console, ou de la personne elle-même.
- **Dans `/v1/contacts/batch`, les éléments d'une même personne s'écrivent DANS L'ORDRE** : deux éléments qui
  partagent une clé normalisée forment une chaîne séquentielle (`enChaines`, `src/api/contacts-v1.ts`), les
  chaînes partant par vagues bornées. En parallèle, le second pouvait se résoudre avant que le premier ait
  créé la fiche.
- 🔴 **`opted_out` et `unknown` ne veulent pas dire la même chose.** `optInAllows` exige un opt-in EXPLICITE
  pour une campagne **marketing** : un contact `unknown` est donc écarté **en silence**, seul `utility` passe.
  La saisie manuelle et l'import CSV créent en opt-in par défaut ; l'import HubSpot garde l'exigence inverse,
  son appelant chargeant une liste dont il ne connaît pas chaque ligne. L'API publique crée en `unknown`, sauf
  `consent` explicite, et sait écrire `opted_out` comme `opted_in` (jamais lever un STOP, cf. plus haut). ⚠️ Conséquence :
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
- 🔴 **UN PARCOURS JOUE LE MÊME GRAPHE DU DÉBUT À LA FIN**, et un seul point de passage le décide :
  `grapheDuRun(run, lirePublie)` (`src/workflow/executor.ts`), lu par les TROIS reprises (`resume`,
  `runEnAttenteSur`, `advance`). Il rend `workflow_runs.graphe_fige` s'il y en a un, le publié sinon.
  `graphe_fige` est `null` pour tout parcours réel : seul le LIEN DE TEST le pose, parce qu'il est le seul
  chemin d'exécution à jouer le brouillon. La poser par campagne recopierait le même objet une fois par
  destinataire. La colonne est REQUISE dans `WorkflowRunRow` et dans `DueRun`, donc le compilateur oblige
  chaque lecture de parcours à la transporter, balayage des endormis compris.
- 🔴 **UN CONTACT RÉEL NE TOMBE JAMAIS DANS UN BROUILLON.** `grapheEditable(wf)` n'apparaît qu'à UN endroit
  des câblages d'exécution (`startTestRun`, `src/worker.ts`) ; le lancement depuis l'Inbox (`src/index.ts`)
  et les campagnes jouent `wf.graph`. Rien dans le langage ne le dit, `tests/workflow-graphe-fige.test.ts`
  le tient.

**Conversations**

- `conversations` (`control_owner`, `assigned_to`, `archived_at`, `traitee_le`, `last_direction`,
  `escaladee_le`), `conversation_messages` (`media_id`, `media_mime`, `media_nom`).
- 🔴 **UNE ESCALADE EST « À TRAITER » TOUT DE SUITE** (`escaladee_le`, migration 0164), et TROIS chemins la
  posent : l'agent de Meta qui nous passe le fil (`control_passed`), le bloc « passer à un humain » d'un
  scénario, et l'escalade d'un agent IA. Les trois font la même promesse au client, et souffraient du même
  défaut : leur dernière phrase est SORTANTE, donc la conversation n'entrait dans le dossier qu'au message
  suivant du client. Elle devient `app_human`, entre dans le dossier même si la dernière phrase est sortante,
  et sort d'« Archivé » et de « Traité ». Elle y reste jusqu'à ce que quelqu'un agisse : la PREMIÈRE réponse
  d'un opérateur, « Traité », « Archiver » ou le bouton « Rendre la main » la clôt, et le balayage de reprise
  ne rend JAMAIS un fil escaladé à l'agent (arbitrage de Julien : on ne le lui rend qu'après une réponse
  humaine, puis les 2 h habituelles).
  ⚠️ Un `standby` de Meta postérieur à l'escalade fait exception : il prouve que l'agent a repris le fil.
  🔴 CE QUI N'EST PAS UNE ESCALADE, et la nuance décide du sort du fil : un ÉCHEC (fenêtre de 24 h fermée à la
  reprise d'un parcours, envoi refusé, bouton qui ne mène nulle part) remonte bien la conversation à l'équipe,
  mais SANS le drapeau. Le contact vient d'écrire dans la plupart de ces cas, donc « À traiter » la porte déjà
  par son `last_direction` ; poser le drapeau n'ajouterait que la collance, et l'agent de Meta ne reprendrait
  plus jamais ce fil. Le choix se fait au POINT D'APPEL (`escalateToHuman(..., escalade)`), jamais dans le
  câblage, qui le relaie.
  ⚠️ DEUX POINTS D'APPEL NE RÉPONDENT PAS PAR OUI OU PAR NON, ils LISENT. Au DÉMARRAGE d'un scénario (le
  chemin des campagnes), le drapeau suit ce que le contact a reçu : un scénario qui ouvre directement sur
  « passer à un humain » sans rien envoyer poserait une escalade par destinataire, sur des gens à qui on n'a
  rien promis, et aucune action de masse ne les libère. Et au rattrapage d'un parcours resté sur un bloc
  d'agent IA sans session vivante, le drapeau suit le STATUT de la session close : `sortie` est une fin
  délibérée (c'est l'escalade de l'agent), `erreur`, `plafond` et `inactivite` sont des pannes.
- 🔴 **LES DOSSIERS N'ONT PAS LA MÊME NATURE, et c'est ce qui décide de ce qu'on peut y ranger.**
  « Archivé » (`archived_at`), « Traité » (`traitee_le`) et l'affectation (`assigned_to`) sont des ÉTATS
  ÉCRITS ; « À traiter » est DÉRIVÉ (`A_TRAITER_SQL`, `src/inbox/store.pg.ts` : scénario qui ne tient pas le
  fil, dernier message qui n'est pas de nous OU escalade de l'agent de Meta en cours, pas marquée traitée),
  donc y ranger une conversation veut dire PRENDRE le fil ; et
  « Signalé » réunit DEUX sources, le constat de l'analyse (`conversation_analysis.abusive`) et un
  signalement humain (`signalee_le`, migration 0123). ⚠️ Les deux sources restent SÉPARÉES : `abusive` est
  recalculé à chaque ré-analyse, un signalement humain écrit dedans disparaîtrait au passage suivant. La
  liste rend `signaleeMain` pour que l'écran sache quoi proposer.
- 🔴 **UN MESSAGE DU CONTACT ROUVRE, DANS L'ÉCRITURE QUI L'ENREGISTRE** (`upsertConversationByWaId`) : il
  sort d'Archivé et retire « Traité ». Le chemin appelant décide (`rouvre: { archive, traite }`), jamais la
  dépendance partagée : un envoi automatisé ne rouvre rien. ⚠️ Une RÉACTION emoji sort d'Archivé mais ne
  retire pas « Traité » ni ne change `last_direction` (arbitrage du 2026-09-19) ; `last_direction` n'est lu
  QUE par « À traiter ». « Traité » n'est pas exclusif : la conversation reste dans « Tout ».
  ⚠️ **Un fil SANS AUCUN message n'entre pas dans « À traiter »** (2026-09-23) : c'est le cas d'une
  conversation qu'un opérateur vient d'OUVRIR depuis la fiche d'un contact. Le dossier veut dire « la balle
  est dans notre camp », et l'ouvrir soi-même ne met la balle dans aucun camp. Elle y entre au premier
  message du contact. ⚠️ Un `last_direction` nul voulait dire « on ne sait pas » jusqu'à la reprise de la
  migration 0130 ; il veut dire « aucun message » depuis, et c'est ce qui autorise à l'exclure.
- 🔴 **UNE PIÈCE JOINTE REÇUE N'EST PAS COPIÉE CHEZ NOUS** : on garde l'identifiant de Meta et on sert les
  octets à la demande (`lireMediaRecu`, `src/inbox/media-entrant.ts`). Meta efface un média REÇU au bout de
  SEPT jours (`DUREE_MEDIA_RECU_JOURS`, mesuré ; trente jours ne vaut que pour ce qu'on téléverse) : le fil
  rend `mediaExpire`, la route rend 410 `media_expire`. Seules les images matricielles se servent `inline`,
  tout le reste en `attachment` + `nosniff` (`MIMES_AFFICHABLES`, parité avec l'écran tenue par un test).
  Plafond propre, `MEDIA_ENTRANT_TAILLE_MAX_KO`, indépendant de la transcription.
- 🔴 **UN AGENT PEUT PRENDRE, JAMAIS RÉAFFECTER** : `peutPrendre` (`src/inbox/assignment.ts`), conversation à
  personne et `agents_peuvent_prendre` activé (ou encadrement). L'écriture est CONDITIONNELLE
  (`prendreSiLibre`, `assigned_to is null` dans le `where`) ; la liste rend `peutPrendre` par la même règle.
- 🔴 **`control_owner` et `assigned_to` sont ORTHOGONAUX** : le premier dit QU'EST-CE QUI parle (scénario,
  humain, agent Meta), le second QUEL HUMAIN s'en occupe. Une conversation peut être affectée ET tenue par le
  scénario. La règle d'accès vit dans `src/inbox/assignment.ts`, PURE, et ne reçoit même pas `control_owner` :
  si quelqu'un le lui passait, le code ne compilerait plus. Griser un bouton ne protège rien, le refus vient
  du serveur.
- ⚠️ `on delete set null` sur l'affectataire : supprimer un membre LIBÈRE ses conversations. Une conversation
  que plus personne ne peut prendre serait invisible et sans réponse.
- ⚠️ `control_changed_at` ne se rafraîchit PAS quand un opérateur répond une seconde fois : le compte à
  rebours de reprise part de la PREMIÈRE intervention.
- 🔴 **`conversation_messages.body` N'A PAS LE MÊME SENS DANS LES DEUX DIRECTIONS, et tous ses lecteurs
  en dépendent.** Sur un message ENTRANT, `body` porte ce que le client a ÉCRIT, et `traduction` porte
  notre lecture dans la langue de l'opérateur. Sur un message SORTANT, `body` porte ce qui est PARTI,
  donc le texte traduit quand l'opérateur a fait traduire sa réponse, et `redaction_origine` porte ce
  qu'il avait écrit. Le principe est le même des deux côtés : **`body` est ce que le CLIENT a vu ou
  écrit**, jamais notre version de confort.
  ⚠️ Les lecteurs de `body` héritent donc de ce sens : l'aperçu de l'Inbox, l'historique donné à
  l'agent, l'analyse de conversation et l'export lisent ce que le client a vu. C'est cohérent, et c'est
  ce qui fait foi le jour d'un litige.
  ⚠️ `traduction_langue` est bornée aux deux langues de la console (`fr`, `en`) par un CHECK : une
  valeur hors de cet ensemble ne serait jamais reconnue comme « déjà traduit », et la même traduction
  serait repayée à chaque ouverture du fil.
- 🔴 **UNE REQUÊTE DE FIL PEUT DURER PLUS LONGTEMPS QUE LA PÉRIODE DE RAFRAÎCHISSEMENT, et l'écran en
  tient compte.** Le fil se redemande toutes les 4 secondes ; traduire ses entrants s'accorde jusqu'à
  20 secondes. Un tour qui tombe pendant qu'une requête est en vol PASSE SON TOUR
  (`enCoursRef`, `web/app/inbox/page.tsx`) au lieu de l'annuler : annuler ne fait qu'abandonner la
  réponse, l'appel au modèle est déjà parti et déjà facturé. C'est une borne de dépense, pas un confort,
  et elle est tenue par `web/e2e/inbox-traduction-polling.spec.ts`, qui COMPTE les requêtes.

**Réglages d'espace** (`tenant_settings`, une ligne par tenant, aucun défaut « allumé »)

| Colonne | Ce qu'elle gouverne |
|---|---|
| `mba_enabled` | l'agent Meta Business Agent est actif sur cet espace |
| `hubspot_lists_enabled` | l'import de contacts HubSpot (pas les étapes de deal) |
| `hubspot_actif` | l'interrupteur HubSpot de l'espace (0179, Paramètres > Intégrations) : allumé, le bloc HubSpot de l'Accueil s'affiche, numéro ou pas. `false` par défaut ; la reprise de 0179 l'a allumé pour les espaces reliés à un portail (`mmhs.tenant_portals` joint à `mmhs.portals`, la lecture de `getHubspotPortal`), gardée par `to_regclass` parce qu'une base sans connecteur n'a pas ce schéma. 🔴 **On ne l'éteint pas tant qu'un portail est relié** : `PATCH /settings/hubspot-actif` rend 409, sinon les analyses continueraient de partir vers HubSpot depuis un espace où il paraît éteint. 🔴 Et une lecture du portail en ÉCHEC refuse l'extinction (503, « réessayez »), elle ne vaut jamais « pas relié » ici : seul un schéma du connecteur absent (`42P01`) rend `false` dans le câblage (`src/index.ts`), toute autre erreur remonte, et seul l'affichage (`GET /settings`) la rattrape en « pas relié ». On délie d'abord (« Déconnexion complète »), et un espace SANS numéro le fait par `POST /hubspot/deconnexion`, la même fonction que la porte d'un numéro. ⚠️ Il ne gouverne PAS le masquage des fonctions HubSpot des campagnes et des automations, qui suit le portail relié (`hubspotPortalConnecte`). ⚠️ Côté console, `undefined` (API plus ancienne) n'est pas `false` : `affichageHubspotAccueil` (`web/lib/hubspot-actif.ts`) garde alors l'ancien comportement |
| `campaigns_paused` | coupe-circuit d'envoi pour tout l'espace |
| `auto_retry_enabled` | auto-relance des échecs des campagnes d'AVANT la migration 0165 ; ce réglage n'a plus d'écran et ne s'écrit plus. Une campagne créée depuis obéit à SA case `campaigns.reessayer` (`campaigns.reessai_par_campagne`) |
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
  🔴 **LA RÈGLE « PAS DE DONNÉE PERSONNELLE » EST MÉCANIQUE, PLUS UNE CONVENTION** : `PgAuditStore.record` est
  le point de passage unique de toutes les écritures, et il FILTRE les clés interdites (`CLES_INTERDITES`)
  avant l'`insert`. Il filtre au lieu de lever, parce que lever ferait perdre la ligne entière, donc
  échangerait une donnée de trop contre une trace manquante ; et le retrait est ANNONCÉ (`__refuses` dans le
  détail, plus une erreur en console), parce qu'une transformation silencieuse ferait croire à son auteur que
  sa trace est complète. ⚠️ La comparaison porte sur la **clé exacte**, jamais en sous-chaîne : `emailSent`
  contient « email » sans être une donnée personnelle, et une garde en sous-chaîne l'effacerait.
  ⚠️ `action` est un `text` LIBRE, sans CHECK : le type `AuditAction` est la SEULE garde contre une faute de
  frappe, et un nom mal orthographié s'écrirait sans que rien ne proteste.

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
| de fond (personne n'attend) | 30 s | `webhook-status`, `analyze-conversation`, `push-analysis`, `hubspot-catchup`, `optout-poussee`, les files d'adaptateur de signaux (`signaux-batch`, et toute future `signaux-*`) |
| dépôt inspecté, consommé par personne | 60 s | toute DLQ |

🔴 **Pourquoi pas le défaut de pg-boss (2 s partout)** : mesuré, le polling à vide des quatre process (mba api
et worker, mm-hubspot api et worker) produisait 663 000 requêtes et 249 Mo d'egress par jour pour 157 jobs en
table, soit 7,5 Go par mois contre 5 Go inclus. L'egress d'un sondage à vide est du pur overhead.

**Deux mécanismes corrigent la lenteur sans la supprimer** : les files dont la latence se RESSENT sont
réveillées par LISTEN/NOTIFY (`FILES_NOTIFIEES`), et toute file qui accumule au-delà de son seuil de rafale
cesse d'attendre entre deux prises jusqu'à s'être vidée. ⚠️ La concurrence, elle, ne bouge pas : c'est elle qui
protège les entrants, pas la cadence. Rendre une rafale rapide n'autorise pas à en traiter deux ensemble.

🔴 **LE SEUIL DE RAFALE EST PAR FILE** (`SEUILS_RAFALE`, défaut `SEUIL_RAFALE`), et la distinction qui l'impose
est celle entre une AVALANCHE et un PAQUET. Le défaut est calibré sur l'avalanche d'une campagne ; l'usage
ordinaire d'une file d'accusés est un paquet de trois à douze, qui n'atteint jamais ce défaut et se vide donc
au rythme de l'horloge. ⚠️ La comparaison de pg-boss est STRICTE (`readyCount > seuil`) : le nombre écrit est
celui d'AVANT le déclenchement, et un seuil de `3` posé en pensant « dès trois » laisserait hors rafale le cas
le plus fréquent, sans aucun symptôme. ⚠️ Ce qui rend un seuil bas SÛR n'est pas sa valeur, c'est la garde
anti-boucle de pg-boss : la rafale exige que la dernière prise ait ramené un job, donc une file vide retombe
toujours sur sa cadence lente et l'egress au repos ne bouge pas.

🔴 **LA CONCURRENCE MULTIPLIE LE SONDAGE, et le tableau ci-dessus ne se lit pas sans elle.** Chaque unité de
concurrence est un worker pg-boss avec SA PROPRE boucle : une file sonde `concurrence / cadence` fois par
seconde, pas `1 / cadence`. `agent-turn` (concurrence 12, cadence 2 s) tapait ainsi la base six fois par
seconde pour une file vide. C'est pourquoi le FILET de sondage, celui qui s'applique quand la notification
est vivante, vaut `SONDAGE_FILET_NOTIFIE` (60 s) et non la cadence de base : la notification annule le
sommeil du worker à l'instant (vérifié dans la source de pg-boss et mesuré à 37 ms sur 102 jobs réels), et
`pollingIntervalSeconds` reste le repli automatique si l'écouteur meurt.

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
| `engagement/balayage` | le risque de désengagement, une fois par nuit (3 h à 6 h, heure de Paris) et par espace : relit les faits par lots, écrit le niveau, émet les signaux sur un CHANGEMENT de niveau et l'événement d'automation `risque_eleve` sur un PASSAGE en élevé. Aussi à la demande, pour un espace : `POST /ops/risque/:tenantId` |
| `account/status-sweep` | statut et qualité des numéros Meta |
| rattrapage HubSpot | relance les marques restées sur un numéro reconnecté |
| purge des payloads webhook | rétention du dernier payload d'un webhook entrant |
| purge des événements Meta | `WEBHOOK_EVENTS_RETENTION_DAYS` |
| `ops/dlq-sweep` | alerte Telegram sur les DLQ non vides |
| heartbeat | écrit `worker_heartbeat`, lu par `/ops` pour voir un worker mort |

🔴 **LE BALAYAGE DU RISQUE EST LE SEUL CHEMIN DE MASSE QUI ÉMET UN ÉVÉNEMENT D'AUTOMATION** (exception décidée,
spec § 19, invariant 8). Ses bornes en sont la condition, et elles vivent au point d'émission
(`src/engagement/balayage.ts`) : il n'émet que sur un PASSAGE en élevé, jamais chaque nuit où le contact y
reste ; au plus `PLAFOND_DECLENCHEMENTS_PAR_JOUR` (200) par JOUR (Paris) et par espace, `/ops` compris (au-delà,
le niveau est écrit, rien ne part, et le bilan le compte) ; puis le plafond horaire de chaque automation, et un
anti-rebond de 30 jours par contact pour une automation « risque élevé » qui n'en règle pas (`antiRebondParDefaut`,
`src/automation/match.ts`) : la grille n'a pas d'hystérésis, un contact qui oscille autour d'un seuil repasserait
en élevé. Un STOP ou un blocage donne « élevé » SANS déclencher.
🔴 **Le plafond se compte depuis minuit (Paris), pas par exécution** : chaque passage commence par compter les
passages en élevé déclenchables déjà écrits aujourd'hui (`PgRisqueStore.declenchablesDepuis`, lu sur la fiche :
un niveau `eleve` daté d'aujourd'hui, hors STOP, blocage et fiche sans adresse) et ne garde que le reste. Compté
par exécution, un lancement `/ops` à 10 h s'ajoutait aux 200 de la nuit. ⚠️ Ce compte peut sur-compter (automation
éteinte, publication en échec), ce qui ne fait que restreindre, et deux passages SIMULTANÉS sur un même espace
comptent chacun avant d'écrire.
🔴 **Et l'automation ne part pas la nuit** : l'événement est enfilé avec un départ différé (`startAfter` de
pg-boss, `enfilerEvenementAutomation(..., depart)`) jusqu'à la prochaine ouverture de l'espace
(`departDuDeclencheur`, par `prochaineOuverture`, la brique des campagnes « heures ouvrées ») ; un espace sans
ouverture exploitable part à 9 h, heure de Paris. Le NIVEAU, lui, est écrit tout de suite. Il ÉCRIT avant de déclencher : un arrêt entre les deux perd un déclenchement, l'ordre
inverse en doublerait un, facturé. Chaque espace est isolé (une panne est dans son bilan, le suivant passe). Le
« déjà balayé aujourd'hui » vit en mémoire du worker : un redémarrage dans la fenêtre relance un passage sans
effet, puisqu'aucun niveau ne change.

⚠️ **L'ordre enfiler / marquer n'est pas le même partout, et c'est voulu.** Le balayage des campagnes
PROGRAMMÉES enfile puis marque : un échec d'enfilement laisse la campagne `scheduled`, reprise au tour
suivant. Celui des REPRISES marque d'abord, parce que c'est l'écriture qui RÉCLAME la ligne, sinon deux
balayages enfileraient deux runs. On échange un double envoi possible contre un retard d'une minute.

🔴 **LES DÉPARTS SONT LISSÉS, et ce n'est pas une optimisation de latence.** Toutes ces tâches sont
programmées au démarrage, donc elles partent de t=0, et leurs cadences sont des multiples les unes des autres :
elles se REJOIGNENT périodiquement, et une minute de rendez-vous demande deux fois plus de connexions qu'une
minute ordinaire sur un pool qui n'en a que huit. `registreDeTaches` décale donc le premier tour de chaque
tâche selon son RANG d'enregistrement (`decalageDeLissage`, déterministe, borné par la minute ET par la
cadence de la tâche, donc aucune ne tourne moins souvent qu'on l'a demandée). ⚠️ Ce qu'on protège est un
INDICATEUR, pas une latence : l'attente sur pool saturé est le seul signal de saturation du produit, et un
signal allumé en permanence par une cause structurelle ne signale plus rien (même leçon que la migration
0111). ⚠️ Le décalage ne lance AUCUNE passe : la première arrive à `décalage + cadence`, le registre ne
déclenchant toujours pas de passe implicite.

### Deux pools Postgres

- **`DATABASE_URL`** = pooler en mode **SESSION** (port 5432). Sert **pg-boss** et **tous les scripts CLI**
  (`db/migrate.ts`, `db/seed.ts`), qui lisent cette variable en direct.
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
| Filtre d'origine Cloudflare | NPM, hôtes `api.` et `mba.` (`DEPLOY.md`) | un appel direct sur l'IP du VPS qui contournerait Cloudflare |
| Signature du webhook | avant de lire le corps | un tiers qui se ferait passer pour Meta |
| `scopeTenant` | toute route `:tenantId` | l'accès aux données d'un autre client (IDOR) |
| `requireAdmin` / `forbidNonAdmin` | écritures | un opérateur d'inbox qui modifierait la configuration |
| Plafonds de débit | routes authentifiées | l'épuisement par un client, volontaire ou non |
| `OPS_TOKEN` | `/ops` | l'exploitation cross-tenant |
| `urlRecuperable` + `resolutionPublique` | toute URL saisie par un client | le SSRF vers le réseau interne |
| `lireCorpsBorne` | toute réponse distante | l'épuisement mémoire par un corps géant |
| En-têtes de sécurité | toute réponse de l'API et de la console | ce qu'une faille future pourrait faire depuis le navigateur |

🔴 **LES EN-TÊTES DE SÉCURITÉ SONT ENFORÇANTS CÔTÉ API ET EN OBSERVATION CÔTÉ CONSOLE** (2026-09-10). La
surface de l'API est petite et connue (du JSON, deux redirections, des images, deux pages HTML d'erreur de
lien) : sa CSP est donc fermée, `default-src 'none'`, et elle vit dans `src/http/entetes-securite.ts`. La
console est une application Next entière avec le SDK Meta et Google Sign-In : sa CSP part en
**Report-Only** dans `web/next.config.mjs`, et n'a rien à bloquer tant qu'on n'a pas observé ce qu'elle
signale. Les quatre autres en-têtes (anti-frame, `nosniff`, référent, capacités) sont enforçants des deux
côtés.

⚠️ **`Referrer-Policy: no-referrer` sur l'API ferme une fuite RÉELLE**, la seule de cette liste :
`/r/<code>/<jeton>` identifie un destinataire, et un référent le livrerait au site de destination.

⚠️ **HSTS n'est posé NULLE PART par nous** : Cloudflare le pose devant l'API, Vercel devant la console
(mesuré). Le reposer créerait une seconde source pour une valeur unique, et c'est le plus court des deux
`max-age` qui gagnerait sans qu'on le sache.

🔴 **LE CONTENEUR TOURNE EN `node` (uid 1000), PAS EN ROOT** (2026-09-10). Ce qui le rend tenable est
vérifié et non supposé : l'application n'écrit RIEN sur disque à l'exécution et le compose ne monte aucun
volume. Le jour où un chemin écrira quelque chose, il lui faudra un répertoire possédé par `node`, et le
conteneur le dira en refusant de démarrer plutôt qu'en silence. La CI le vérifie à chaque exécution, et
c'est le SEUL de ses contrôles de sécurité qui bloque : il ne dépend d'aucune base de vulnérabilités
extérieure, seulement d'une propriété que nous choisissons.

🔴 **LE MINIMUM DU MOT DE PASSE EST DE 12 CARACTÈRES, SANS RÈGLE DE COMPOSITION** (2026-09-10), et il ne
mord que sur les quatre chemins qui en CHOISISSENT un. `/auth/login` compare un hash et ne regarde jamais
la longueur : un compte existant continue de se connecter, et ne rencontre la règle qu'au prochain
changement. La valeur est arrimée entre le serveur et les quatre écrans par
`web/lib/mot-de-passe.test.ts`, parce qu'elle était écrite huit fois et que quatre copies ont dérivé le
jour même du changement.

🔴 **LE CORS EST EN LISTE BLANCHE ET SANS `credentials`, et les deux comptent.** `CORS_ORIGINS` refuse `*` AU
CHARGEMENT de la configuration. Jamais `credentials: true` : la session voyage dans un en-tête
`Authorization`, jamais dans un cookie, donc **il n'y a aucun CSRF aujourd'hui** ; l'activer en créerait un de
toutes pièces. Vide = aucun en-tête CORS n'est posé, ce qui est le bon défaut.

🔴 **Deux plafonds de débit, et 0 les désactive.** `RATE_LIMIT_USER_PAR_MINUTE` (clé = utilisateur, posé DANS
`makeRequireAuth` donc hérité par tous les modules gardés) et `RATE_LIMIT_COUTEUX_PAR_MINUTE` (clé = ESPACE)
sur import, aperçu, action en masse, purge, export, lancement de campagne, et les routes lourdes de la
connaissance d'un agent (suppression en masse, import d'un document, aperçu et import d'un site). Mettre l'une à 0 est le levier
d'urgence : un mauvais calibrage couperait la console de tous les clients, et un `--force-recreate` va plus
vite qu'un déploiement de code. ⚠️ Ils sont LOCAUX AU PROCESS : le plafond annoncé est celui d'UNE instance,
à lever avant le multi-replica.

🔴 **Les portes publiques ont leurs propres plafonds, et un plafond ne compte que des clés qui EXISTENT.**
- `/v1` et `/mcp` : un budget GLOBAL (`API_KEY_PREFILTRE_MAX`, clé constante) freine les empreintes jamais
  résolues par ce process AVANT la requête en base ; une empreinte résolue en est exemptée, sinon une attaque qui
  l'épuise couperait tous les clients. Puis le plafond de l'ESPACE (`src/auth/plafond-espace.ts`, 2026-09-25),
  commun à toutes ses clés : deux fenêtres fixes qui s'appliquent ensemble (`API_PLAFOND_MINUTE`, défaut 60,
  `API_PLAFOND_HEURE`, défaut 1 000), vérifiées avant qu'aucune ne consomme, comptées sur l'ESPACE d'une clé
  résolue (avant la base dès que la clé est connue, l'espace étant retenu avec l'empreinte dans `ClesResolues` ;
  après la lecture la première fois). Une fausse clé n'entre donc jamais dans sa table. Il compte des APPELS : le
  travail reste mesuré par le garde d'usage. Un espace peut porter son réglage (`tenant_settings.api_plafond_minute`
  et `_heure`, migration 0181, `null` = défaut, CHECK > 0), lu à travers un cache de 30 s (une lecture partagée par
  rafale ; en cas d'échec, le dernier réglage connu, sinon le défaut) et réglé par `GET`/`PUT
  /ops/plafond-api/:tenantId` (jeton d'exploitation, note obligatoire, ligne `ops_plafond_api` avec l'état d'avant,
  la route pose dans le cache le réglage écrit (`poser`), qui reste le dernier réglage connu si une relecture
  échoue). Refus : 429 `rate_limited`, `Retry-After` = la fenêtre pleine qui se libère le
  plus tard, message qui la nomme avec son plafond ; les `x-ratelimit-*` décrivent la fenêtre la plus proche de
  son plafond. `0` en configuration éteint la fenêtre pour les espaces sans réglage (levier d'urgence) ; un
  réglage d'espace reste appliqué. Local au process : le plafond est celui d'UNE instance.
- La clé du relais du Meta Business Agent (droit `mba:relais`, attribué par la seule publication) n'entre PAS
  dans ce plafond : elle garde un compteur PAR CLÉ (`API_KEY_RATE_LIMIT_MAX`, sur l'empreinte), pour qu'un
  intégrateur qui charge l'API ne coupe pas les outils de l'agent de Meta en pleine conversation.
- `/w/:code` et `/rcs/callback/:code` : AVANT la base, un budget COMMUN (`CODES_INCONNUS_PAR_MINUTE`, clé
  constante, en silence) freine les codes jamais résolus par ce process, et un code résolu en est exempté, comme
  une clé sur `/v1`. APRÈS la lecture, le plafond par code EXISTANT (`WEBHOOK_IN_RATE_LIMIT_*`,
  `RCS_CALLBACK_PAR_MINUTE`). Le second se calcule sur le débit RCS d'un run de campagne, et ne tient que parce
  qu'un seul run tourne à la fois par espace ; des tests tiennent le débit, la concurrence par groupe et le
  `groupId` de chaque enfilement. Les envois RCS d'un scénario n'y passent pas : la marge les absorbe. Un code
  déjà résolu prend aussi son plafond AVANT la base (un refus ne coûte plus de lecture), et un budget épuisé se
  journalise au plus une fois par minute. ⚠️ `/r/:code` et `/m/:code` n'ont PAS ce frein, délibérément : leurs
  codes réels sont très nombreux et cliqués en rafale par des contacts, un tel budget y refuserait des clics réels
  après un redémarrage.
- La règle qui les unit : un limiteur consulté AVANT la base sur une clé choisie par l'appelant, avec une table
  bornée, se remplit de clés inventées, et le vrai client, dont l'entrée expire à chaque fenêtre, revient comme
  une clé neuve et se fait refuser. La protection devient un moyen de couper un client.
- Un rappel RCS doit désigner l'agent de son code : sans `channelId`, 403. Le CODE reste l'authentification
  (smsmode ne signe pas ses rappels, et le `channelId` n'est pas un secret) ; exiger le canal ferme la forme la
  plus simple d'un corps forgé, celle qui l'omet.
- Les en-têtes `x-ratelimit-*` ne décrivent que le plafond de l'appelant (sa clé, son compte, son espace). Un
  budget partagé se consomme EN SILENCE (`consommerEnSilence`) : ses en-têtes diraient à n'importe qui où en
  est le budget de tous. Tout limiteur à 0 est désactivé, et ne pose aucun en-tête.
- UNE opération lourde de l'API publique à la fois (`API_MAX_LOURDES_SIMULTANEES`), pour tout le process : un
  lot de contacts prend la moitié du pool. Un autre espace attend donc son tour en 429 ; c'est un choix (la
  réception des messages passe avant l'équité entre intégrateurs).

🔴 **Une URL saisie par un client se vérifie DEUX FOIS : sur son TEXTE, et sur ce vers quoi elle RÉSOUT.**
`urlRecuperable` lit le texte de l'hôte (elle refuse `localhost`, les littéraux privés et leurs formes
hexadécimale, entière, IPv6 et IPv4 mappée) ; `resolutionPublique` (`src/lib/adresse-privee.ts`) ferme ce
qu'un texte ne peut pas voir : un nom public dont l'enregistrement A pointe sur les métadonnées du fournisseur
ou sur le réseau Docker. Trois règles la rendent juste : **une seule adresse interdite condamne le nom** ;
**une résolution qui ÉCHOUE ou qui TRAÎNE est un REFUS** ; et une **plage se compare en ARITHMÉTIQUE, jamais
en préfixe de chaîne** (`fe80::/10` fait dix bits, pas quatre caractères). L'inventaire des chemins concernés
est tenu par `tests/lib-adresse-privee.test.ts`, plus par une page qui dérive.

🔴 **L'adresse se revérifie à l'OUVERTURE de la connexion.** La vérification ci-dessus et l'appel faisaient
deux résolutions distinctes : un DNS hostile pouvait répondre public à la première, interne à la seconde
(« DNS rebinding »). Tout appel HTTP vers une adresse saisie par un client passe donc par `fetchPublic`
(`src/lib/connexion-publique.ts`) : un littéral y est jugé tout de suite, un nom est résolu par un `lookup`
qui refuse l'intérieur, et la socket s'ouvre sur ce qui a été vérifié. Le SMTP d'une boîte d'envoi, qui n'est
pas du HTTP, reçoit sa socket de nous (option `getSocket` de nodemailer) : `ouvrirSocketPublique` applique la
même garde, essaie les adresses vérifiées l'une après l'autre, et laisse à nodemailer le nom d'hôte pour TLS.
Le même test d'inventaire exige ces branchements de chaque chemin, client MCP et SMTP compris, et chaque chemin
HTTP dit au refus à la connexion ce que dit la vérification préalable (redirection refusée comprise).
⚠️ `fetch` et `Agent` viennent du MÊME paquet `undici` : la
production tourne en Node 22 (undici 6 embarqué), le poste en Node 24, et mélanger les deux versions est le
piège. ⚠️ Pour le HTTP, la vérification préalable reste : elle rend un refus lisible, là où un refus à la
connexion ne remonte que comme une panne réseau. Le SMTP n'en a pas : son refus arrive à l'envoi, et le bouton
« Tester » le traduit. ⚠️ Le pare-feu de l'hôte ne protège pas ce chemin : le trafic reste dans
le réseau Docker, il ne traverse jamais l'interface publique.

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
Cloudflare, notre corps disparu. **Les deux noms qui servent l'API (`api.` et `mba.`) sont Proxied** ; la
console `engageme.`, servie en direct par Vercel, ne l'est pas, et ne porte aucune réponse de l'API. Un refus lisible
sort donc en **422** (409 pour une ambiguïté, 400 pour une saisie invalide), et il est **journalisé côté
serveur** en plus : le corps peut être détruit en route, le log reste.

🔴 **UN `catch` LARGE NE RENVOIE JAMAIS `err.message` DANS UN 4xx.** Il attrape aussi NOTRE panne (une lecture
en base, une clé déchiffrée), et un 4xx traverse Cloudflare : le texte d'une erreur Postgres partirait au
navigateur. Pour un appel au modèle, seule une panne du FOURNISSEUR se dit, en phrase rédigée par
`direPanneModele` ; tout le reste est RELANCÉ, et le gestionnaire global rend un 500 opaque qu'il journalise.
Côté console, `messageDErreur` fait de ce 500 (ou de la page HTML de Cloudflare) une phrase traduite qui garde
le statut.

⚠️ **Un 5xx reste juste quand l'écran ne lit pas le corps ET que la panne est la nôtre** : l'aide et le récap
de la console (le panneau pose son propre texte), la déconnexion HubSpot (connecteur interne, déjà rejoué). La
raison est écrite au-dessus de chaque 502 gardé. ⚠️ La mesure qui fonde cette section a été faite sur un
**502** : qu'un 503 soit remplacé de la même façon n'a pas été mesuré.

🔴 **`req.log` ET `app.log` SONT MUETS** : Fastify tourne en `logger: false`, et son journal est alors une
fonction vide (mesuré : `app.log.error` vaut `function noop () { }`). Toute trace passe par `journaliser`, et
`tests/journal-muet.test.ts` refuse tout ACCÈS au journal de Fastify dans `src/` : un appel, mais aussi le
journal passé en valeur ou déstructuré. Il le lit sur l'arbre syntaxique, parce qu'une recherche ligne à ligne
n'a pas vu `reglagePrise(tenant, acteur, req.log)`.

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
passe SMTP (`email_accounts.password_enc`), les secrets de connecteur API (`agent_tool_sources`), les clés d'un
outil qui reçoit les signaux (la table de son adaptateur, dans `src/signaux/`).

**Hachés, jamais stockés en clair** : les clés d'API publiques (`api_keys`, sha256), les jetons d'invitation et
de réinitialisation (`auth_tokens`), les secrets de webhook entrant.

⚠️ **`/ops` n'est pas durci, il est SURVEILLÉ** (choix produit). Une liste blanche d'IP aurait coupé l'accès
dès un changement d'IP. Le jeton reste la garde ; au 5e refus dans une fenêtre de 5 minutes, une alerte
Telegram part, throttlée. 🔴 **Le jeton présenté n'est JAMAIS journalisé** : une tentative est presque toujours
un secret voisin du vrai.

⚠️ **`/ops` n'est plus en lecture seule, et il porte NEUF écritures.** `POST /ops/observe` (ouvrir une
observation), `POST /ops/credits/:tenantId` (recharger le solde prépayé, **la seule écriture d'argent du
produit**, là précisément pour qu'un client ne puisse pas créditer son propre compte),
`POST /ops/verrou/:tenantId`, `PATCH /ops/prix`, `DELETE /ops/cle-modele/:tenantId`,
`POST /ops/pubs/connexion/:tenantId`, `POST /ops/dlq/replay` et `POST /ops/risque/:tenantId` (le balayage
du risque de désengagement d'un espace, lancé tout de suite : il écrit les fiches, émet les signaux et peut
déclencher des automations, sous le plafond du JOUR qu'il partage avec la nuit), plus
`PUT /ops/plafond-api/:tenantId` (le plafond de l'API d'un espace), qui vit dans `src/http/ops-plafond-api.ts`.
Compté dans ces deux fichiers le 2026-09-25.

🔴 **LA NOTE OBLIGATOIRE N'EST PAS UN INVARIANT DE `/ops` : SIX SUR NEUF L'EXIGENT.** Mesuré route
par route le 2026-09-23 : `credits`, `verrou`, `prix` et `pubs/connexion` refusent sans note (et `risque`
puis `plafond-api`, ajoutées le 2026-09-25, aussi) ; `observe`,
`cle-modele` et `dlq/replay` acceptent sans. ⚠️ **Cette page a affirmé le contraire le jour même**, en
corrigeant une liste qui ne citait que deux écritures sur six : la correction a énoncé un invariant
général à partir des quatre routes qu'elle venait de lire, et elle a en plus oublié la septième
(`dlq/replay`, qui renfile des campagnes et des webhooks). **Un compte en prose se mesure ou ne s'écrit
pas** : un lecteur qui croit « toutes traçables » ne cherchera pas la trace qui manque. Le trou le plus
gênant est `cle-modele`, qui révoque une clé facturée chez Vercel sans dire qui ni pourquoi.

⚠️ **Ce qui vaut, lui, pour les huit** : elles sont délibérément **cross-espace**, parce que `/ops`
s'authentifie par un JETON d'exploitation (`x-ops-token`) et jamais par une session. ⚠️ Le comportement
quand une dépendance manque n'est PAS uniforme : la plupart rendent **503**, mais `dlq/replay` n'est pas
montée du tout et rend donc **404**.

🔴 **ET UNE SESSION, D'OBSERVATION OU NON, N'ATTEINT JAMAIS `/ops` : elle est refusée en 401 par
`makeRequireOps`, faute de `x-ops-token`.** Ce n'est PAS la garde de méthode qui l'arrête : celle-là vit
dans `makeRequireAuth` et ne s'exécute pas sur cette surface, qui n'a qu'un `preHandler`,
`makeRequireOps`, et ne lit jamais `req.auth`. La protection réelle est donc plus forte que celle qui
était écrite : une autorité séparée, pas un filtre de verbe. `scripts/auto-attaque.mts` le tient, en
attendant **401** sur la classe `jeton-ops` (« un admin de tenant n'entre pas ») et en ne balayant la
garde d'observation que sur les routes de tenant.

⚠️ **CETTE LIGNE A ÉTÉ FAUSSE TROIS FOIS DE SUITE, LE MÊME JOUR, ET C'EST ÇA QUI EST INSTRUCTIF.** Elle
a d'abord nommé « la garde de MÉTHODE », puis « la garde d'observation » : deux mécanismes réels, aucun
des deux à cet endroit. À chaque fois la correction a changé le NOM sans aller lire QUI monte le
`preHandler`, dans le paragraphe même qui prêche la mesure. **Un mécanisme de sécurité se nomme en
l'ayant suivi jusqu'à son point de montage**, jamais de mémoire.

🔴 **`POST /ops/pubs/connexion/:tenantId` est la SEULE route du dépôt qui reçoit un secret Meta dans
un corps de requête**, et la seule qui REMPLACE une connexion existante là où l'écran la refuse. Elle
existe parce que Meta interdit au portefeuille qui possède l'application d'être son propre client : sans
elle, MessagingMe ne pourrait pas faire ses propres publicités avec son propre produit. Le jeton est
vérifié chez Meta avant d'être gardé, chiffré au repos, jamais renvoyé ni journalisé.

🔴 **ET L'ANCIEN ACCÈS N'EST PAS TOUJOURS RÉVOQUÉ, DÉLIBÉRÉMENT.** Cette page a affirmé qu'il l'était
« avant d'être écrasé », sans condition. C'est faux dans le cas le plus COURANT, et le croire ferait
conclure qu'aucun accès vivant ne reste derrière. `DELETE /me/permissions/<perm>` porte sur le couple
(application, **entité**), pas sur LE jeton : remplacer le jeton d'un utilisateur système par un autre
du même portefeuille, c'est-à-dire l'usage normal de cette route, donne deux jetons de la MÊME entité,
et retirer les permissions de l'ancien DÉSARMERAIT le neuf. Le dépôt compare donc les identités
(`GET /me`) et ne retire que si elles DIFFÈRENT. Sinon il le DIT, et il y a **deux** cas de non-retrait, pas un :
`meme_entite` (identités égales) et `indetermine` (Meta n'a pas dit qui portait l'un des deux jetons).
Les deux appellent le même geste, et l'ancienne chaîne
reste VALIDE jusqu'à ce qu'on régénère le jeton de l'utilisateur système chez Meta. ⚠️ Ce geste-là
invalide AUSSI le jeton qu'on vient de déposer : il faut le redéposer derrière.

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

Les clés se rangent en cinq familles, et savoir laquelle on touche dit le risque. Les réglages que personne ne
réglait (délais internes, concurrences, `CAMPAIGN_RUN_MAX_MS`, `WEBHOOK_PAYLOAD_RETENTION_DAYS`…) sont des
constantes du bloc `constantes` en fin de `src/config.ts` depuis le 2026-09-25 : on les change dans le code.

| Famille | Exemples | Ce qu'un mauvais réglage coûte |
|---|---|---|
| **Secrets obligatoires** | `AUTH_SECRET`, `META_APP_SECRET`, `DATABASE_URL`, `ENCRYPTION_KEY` | le boot échoue, ou une faille |
| **Interrupteurs de fonctionnalité** | `META_ES_CONFIG_ID`, `AI_GATEWAY_API_KEY`, `DRY_RUN`, `CONVERSATION_ANALYSIS_ENABLED` | vide = la fonctionnalité est OFF, proprement (503 explicite, file non consommée) |
| **Capacité** | `DB_POOL_MAX`, `PGBOSS_MAX`, `RATE_LIMIT_*` | latence, saturation muette, ou coupure de service |
| **Rétention** | `WEBHOOK_EVENTS_RETENTION_DAYS` | une réponse RGPD fausse |
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

`/ops/verrou/:tenantId` (jeton d'exploitation, POST, note obligatoire) : pose ou retire le verrou d'un
espace (`tenants.status`). Il ferme la console ET l'API publique (`/v1`, `/mcp` rendent 403
`tenant_locked`). 🔴 Il n'arrête PAS les campagnes déjà enfilées : la séquence complète (verrouiller,
lister les campagnes en cours, les mettre en pause) est dans le runbook de `DEPLOY.md`.

`/ops/risque/:tenantId` (jeton d'exploitation, POST, note obligatoire) : lance TOUT DE SUITE le balayage du
risque de désengagement d'un espace, pour l'essai réel et le dépannage, et rend son bilan (fiches évaluées,
changements de niveau, automations déclenchées, passages au-delà du plafond, échecs). Il tourne DANS la
requête. Rejoué, il ne redéclenche rien : un passage en élevé déjà écrit n'en est plus un. Un espace
verrouillé n'est pas sauté (c'est un geste explicite). Son plafond est celui du JOUR, partagé avec la nuit : ce
que la nuit a déjà déclenché compte (`dejaDeclenches` dans le bilan). Les automations qu'il publie partent à
l'ouverture de l'espace (`departLe` dans le bilan) : tout de suite pendant les heures d'ouverture, sinon à la
suivante.

`/ops/usage` (jeton d'exploitation) : l'usage de l'API publique agrégé PAR MINUTE, par espace, par clé et
par opération, avec le TRAVAIL demandé (un lot de 500 contacts y compte 500, pas 1). En mémoire du process
qui sert la requête, jamais en base : une ligne SQL par appel ferait amplifier par la journalisation la
charge qu'elle observe. Aucun seuil n'est posé à ce jour, ces compteurs OBSERVENT.

`/ops/overview` (jeton d'exploitation) : rollup par tenant, charge des files, heartbeat du worker. Les DLQ non
vides déclenchent une alerte Telegram. Le SLO vit dans [docs/SLO-2026-09-01.md](docs/SLO-2026-09-01.md).

---

## 11. Limites connues

**Elles vivent dans [todo.md](todo.md), et nulle part ailleurs.** Un « reste à faire » qui existe à deux
endroits en existe zéro : l'un des deux sera fait sans que l'autre le sache.

Les deux qui ont le plus de conséquences aujourd'hui :

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
   émission sur l'un d'eux = envoi de masse involontaire et facturé. ⚠️ UNE exception, décidée et bornée : le
   balayage du risque de désengagement émet `risque_eleve` (§ 6, « Les balayeurs du worker »).
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

Ajoutés par le lot 3 de l'API publique, et numérotés après le dernier invariant de ce § 12 pour ne décaler
aucun renvoi :

32. **L'échec d'un message LIBRE s'écrit dans `echecs_messages`, et lui seul** (`processStatuses` pour Meta,
   `traiterRapportRcs` pour smsmode) : un échec qui a touché un destinataire de campagne est déjà porté par sa
   ligne, et un message d'origine `campagne` est exclu à l'écriture. La lecture de plus n'a lieu que sur un
   échec qui n'a touché aucun destinataire : un statut ordinaire de Meta ne coûte aucune requête. Un rapport
   smsmode qui DEVANCE l'inscription du message dans le fil est écrit quand même, origine inconnue
   (`noterSansMessage`). Le journal des erreurs le lit en quatrième source (`message`) ; Analytics l'exclut
   (`campagnesSeulement`), parce que son compteur par code ne compte que les campagnes ; la purge RGPD efface
   les lignes de la personne.
33. **Un RCS libre a UN chemin, `envoyerRcsLibre`**, pour le bouton de l'Inbox et `POST /v1/messages/rcs`.
   Une MACHINE ne l'envoie qu'à une fiche qui a consenti ou nous a déjà écrit, qui n'a dit STOP ni en général
   ni en RCS, et que le cache ne dit pas injoignable ; l'OPÉRATEUR n'est soumis qu'au STOP RCS, par le point de
   passage unique de l'envoi, et son bouton reste celui d'avant.
34. **Les variables d'un destinataire de l'API ne touchent jamais la fiche** : `campaign_recipients.variables`,
   relues à l'envoi d'un message RCS (elles priment sur le champ de fiche du même nom) et au renvoi F7, remises
   à `null` par la purge RGPD. Un scénario ou un bloc les refuse (400) : il n'a nulle part où les ranger.

Ajouté par le lot 4 de l'API publique :

35. **Le catalogue `/v1/templates` et l'envoi `/v1/sends` jugent un template par la MÊME construction**,
   `modeleLuDe` (`src/api/modele-envoi.ts`), que la lecture partagée `templateVarInfo` emploie aussi, puis
   `verdictModele`. Elle porte `raisonNonEnvoyable` : un en-tête d'un format qu'aucun envoi ne remplit, ce que
   le moteur refuse avant de partir (`carouselSendBlocker`, `headerMediaSendBlocker`, l'adresse du visuel
   tenant lieu d'identifiant), un en-tête TEXTE à variable (aucun paramètre d'en-tête texte n'est produit) et
   une adresse de bouton à variable qui n'est pas un lien tracé à jeton (`estLienTraceAvecJeton`,
   `src/links/rewrite.ts`). Le catalogue n'annonce pas ce template, l'envoi le refuse en 422
   `unsendable_target` (cible template, template d'ouverture d'un scénario, template d'un bloc), et
   `tests/v1-sends.test.ts` tient les deux sur les mêmes templates. Le jour où l'envoi remplit l'un de ces
   paramètres, `raisonNonEnvoyable` cesse de l'écarter, pour les deux à la fois. Un scénario publié est listé
   même s'il ne peut pas partir : `opening` le dit, et `entryNode` donne le bloc à viser pour une ouverture de
   session. Le nombre de variables du template d'ouverture n'est PAS relu pour `/v1/scenarios` (il coûterait la
   liste complète du WABA par appel) : il se lit dans `/v1/templates`.
36. **Le template qu'une cible `node` fait partir est lu chez Meta, comme celui d'un scénario**
   (`modeleDOuverture(graph, depuis)`) : la catégorie retenue est la plus stricte de la lue et de la déclarée
   (`categoriePlusStricte`), illisible = refus. Le nombre de variables, lui, ne se compare PAS : `params` est
   refusé sur un bloc, dont le template résout ses variables par les sources de la console, contact par contact.
37. **`POST /v1/messages/whatsapp` cherche le fil, il ne le crée jamais** (`PgInboxStore.filDuContact`, même
   fragment de `wa_id` que `ouvrirConversationDuContact`) : sans fil, pas d'entrant, donc fenêtre fermée par
   construction, 422 sans rien écrire. `POST /v1/messages/rcs`, lui, ouvre le fil APRÈS l'envoi, et rend
   `conversationId: null` si ce fil est devenu introuvable entre-temps (le message, lui, est parti).
38. **Un numéro DÉLIÉ n'envoie rien, et c'est `MetaClientFactory.clientForTenant` qui le refuse** (migration
   0180, bloc « Canaux et services » de l'Accueil). Délier ne touche à rien chez Meta : `phone_numbers.delie_le`
   est posé sur tous les numéros de l'espace, le jeton chiffré reste, et « Relier » le remet à nul. Le refus
   (`NumeroDelieError`, `statusCode = 409`) sort en 409 lisible de toute route d'envoi par le gestionnaire
   d'erreurs, sans qu'aucune ne le connaisse. La garde est REQUISE dans `MetaClientFactoryOpts` (`numeroDelie`).
   ⚠️ Elle est mise en cache 5 s par process (`NUMERO_DELIE_TTL_MS`) : un envoi peut encore partir du worker 5 s
   après « Délier » ; le process de l'API vide son cache au geste. Dans l'autre sens, le worker peut refuser à tort
   pendant 5 s après « Relier » : aucune pause `numero_delie` ne s'écrit sans relecture en base hors cache
   (`pauserSiNumeroDelie`, `PgNumeroDelieStore.pauserCampagne` : une seule instruction, `status in
   ('running','scheduled')` et `exists` sur `phone_numbers.delie_le` avec `for share`, sérialisée avec `relier` ; elle
   n'écrase jamais une pause d'opérateur ; requise dans `RunJobDeps`, transmise au moteur), et une automation refusée efface son tir,
   SAUF un rappel « avant la date » : son balayage republie tout rappel sans marqueur, donc l'effacer le relancerait
   chaque minute et rejouerait ce que le parcours a fait avant l'envoi refusé.
   `POST /v1/messages/whatsapp` rend ce refus en 409 `number_unlinked` dans l'enveloppe `{ error, code }` ;
   `POST /v1/sends` refuse avant de créer l'envoi, en 409 `number_unlinked`, quand le premier envoi est WhatsApp ; le
   MCP le traduit en `RefusOutil` ; les routes de la console le rendent en 409 `{ error }`. Un parcours qui démarre
   (`runFrom`) vérifie le numéro avant tout effet dès qu'il enverra par WhatsApp (`verifierNumeroWhatsApp`,
   `envoieParWhatsApp`, câblé sur `MetaClientFactory.verifierNumero`) : l'e-mail et l'appel API qui précèdent ne
   partent pas et ne se rejouent pas. Limite : le cache de 5 s.
39. **Délier met en pause `numero_delie` les campagnes `running` et `scheduled` de l'espace dont un étage est
   WhatsApp** (repli compris), `paused_until` à nul, `scheduled_at` gardé. Le balayage de reprise ne les voit
   jamais (motif hors du `where` de `reprendreCampagnesDues` et du prédicat de `campaigns_reprise_idx`, tenu par
   `tests/numero-delie-migration.test.ts`). « Relier » les rend `scheduled` si `scheduled_at` est posé, `running`
   sinon, et c'est le balayage des campagnes gelées qui les relance dans la minute : aucun enfilement depuis
   l'API. Une campagne lancée ou reprise PENDANT la déliaison est mise en pause au premier refus du point de
   passage, même quand WhatsApp n'est qu'un repli. En cours de run, un scénario démarré par destinataire
   (campagne de scénario, cible `node`) qui bute sur ce refus rend son destinataire à la file (`relacher`, jamais
   `failed`) et arrête le run ; sur un étage « message et scénario », le destinataire reste `sent` (message parti,
   scénario non démarré) et le run s'arrête après lui, sauf s'il était le dernier : la campagne sort alors par son
   statut normal. Une campagne « Au fil de l'eau » en pause n'inscrit aucun
   arrivant (`listRunningByWebhook` ne lit que `running`).
40. **Les entrants d'un numéro délié sont écartés en TÊTE du job `webhook`** (`ecarterLesEntrantsDelies`), avant
   le journal brut et chaque étape : messages, échos de l'agent de Meta et bascules de contrôle. Les ACCUSÉS de
   livraison sont gardés. Coût : une lecture par clé primaire de `phone_numbers` par lot, zéro pour un lot
   d'accusés purs. Une lecture en échec rend le lot tel quel (comportement d'avant), jamais un job en échec.
   Routes : `POST /tenants/:tenantId/numero/delier` et `/numero/relier` (admin), journalisées `numero.delie` et
   `numero.relie`. **Débrancher la chaîne** (`DELETE /tenants/:tenantId/channels-me/connection`, admin) supprime la
   seule ligne `channelsme_connections` : liens et publications n'ont aucune clé étrangère vers elle, les posts
   déjà parus et leurs boutons continuent de démarrer leur scénario. Sur l'Accueil, la pastille d'une carte se
   déduit de son interrupteur par `teinte(ligne, aTerminer)` (`web/lib/canaux-services.ts`) : `null` quand l'état est
   inconnu, jamais un gris (un gris dirait « éteint », ce qu'on n'a pas lu) ; `ligneRcs('echec')` ne donne ni
   interrupteur ni pastille ; la pastille du numéro passe à l'ambre quand `status.dot` est rouge ou ambre
   (`numeroASurveiller`). Les logos vivent dans
   `web/components/LogosCanaux.tsx` (SVG inline, tracés Simple Icons ; icône de la Chaîne WhatsApp dessinée maison) ;
   `LogoHubSpot` y sert aussi le bloc HubSpot de l'Accueil.
   Les chiffres des cartes : `GET /tenants/:tenantId/accueil/volumes` (module stats, garde admin) rend `{ jours,
   whatsapp: { envoyes, recus }, rcs: { envoyes, recus } }` sur une fenêtre glissante de `JOURS_VOLUMES` (30) jours,
   calculé par `PgStatsStore.volumesParCanal` depuis `conversation_messages` (par `channel` et `direction`, fils de
   test exclus, modèles INCLUS, isolation par `cv.tenant_id = $1`, préfiltre `cv.last_message_at > now() - jours - 1 h`
   servi par `conversations_tenant_recent_idx`, exact parce que les trois écritures de message avancent
   `last_message_at`). Ce périmètre diffère volontairement de
   « Messages échangés », qui exclut les modèles sortants : sans eux, un espace qui ne fait que des campagnes lirait
   « 3 envoyés » après 5 000 messages. La console ne lit la réponse que par `lireVolumesCanaux`
   (`web/lib/chiffres-canaux.ts`), qui rend `null` sur toute forme inattendue : la carte n'affiche alors rien,
   jamais un zéro inventé. Le chiffre de l'agent de Meta : `GET /tenants/:tenantId/mba/:phoneNumberId/messages` rend
   `{ messages }`, le nombre de messages `direction = 'out'` dont l'origine effective (`ORIGINE_EFFECTIVE_SQL`) vaut
   `mba`, sur les fils non test de l'espace (`c.tenant_id = $1`), sans borne de date
   (`PgStatsStore.messagesEcritsParMba`) ; `messages: null` quand la dépendance n'est pas câblée, jamais 0 ;
   `direction = 'out'` tient le prédicat de l'index partiel `conversation_messages_origin_idx` (0099). Il s'affiche
   par `ChiffreMessagesTenus` (`web/components/EnteteAgent.tsx`) en mode MBA (`mba: true`, libellé seul), dans le
   cadre de l'agent de Meta de l'Accueil et dans MBA > Paramètres ; l'agent IA garde `{ messages, jours }` et sa
   légende. La colonne des dossiers de l'Inbox mesure `calc(theme(spacing.60) + theme(spacing.px))` et part du bord,
   pour que sa bordure tombe sous le séparateur de l'entête (`lg:w-60` puis `w-px`, `AppShell`) ;
   `inbox-dossiers.spec.ts` le mesure.
41. **Le nom de l'espace** : `GET /tenants/:tenantId/nom` rend `{ nom }`, `PATCH` avec `{ nom }` le change. Les deux
   vivent dans le module `admin` (`src/http/users.ts`, monté avec `g.admin`) : `scopeTenant` et la garde admin du
   groupe, un agent ou un manager reçoit 403. Validation par `nomEspace` (`src/user/nom-espace.ts`), partagée avec
   `/auth/signup` et le nom construit par l'inscription Google : rogné, 1 à 80 caractères, sans `\p{Cc}`, `\p{Cf}`,
   `\p{Zl}`, `\p{Zp}` ni remplissage hangul, au moins une lettre ou un chiffre. Écriture par `PgUserStore.setTenantName`, sans migration
   (`tenants.name` existe depuis 0001). Un nom inchangé n'écrit rien. Audit `espace.renomme`, cible
   `{ kind: 'tenant', id }`, détail VIDE : un nom d'espace peut être celui d'une personne
   (« Espace de <nom complet> » à l'inscription Google), et `audit_log` est gardé deux ans. La carte « Espace » de Compte & équipe traduit le 404 d'une API pas encore déployée par un
   message au lieu d'une panne.

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
26. 🔴 **Une règle qui doit tenir PARTOUT ne voyage jamais dans une dépendance optionnelle.** Un consommateur
    qui la reçoit absente la dégrade en silence : le programme est valide, rien ne le signale, et la règle ne
    s'applique pas sur ce chemin. C'est vrai de la garde d'authentification comme du consentement, et les
    deux ont été fermées pour cette raison. Le corollaire est dans les tests : une fixture qui OMET la
    dépendance cache son hypothèse, une fixture qui déclare `gardeOuverte` ou `jamaisDesabonne` la dit.
27. 🔴 **Un type qui EXIGE une dépendance ne dit pas qu'elle est POSÉE.** Un module peut la recevoir et ne
    pas s'en servir : des options de route écrites `{ ...garde }` au lieu de `{ ...opts }` répandent la garde
    au lieu de l'objet qui la porte, et la route part sans `preHandler`. Le compilateur ne voit rien, et le
    symptôme est un 403 sur un geste légitime (ou une porte ouverte, dans l'autre sens). C'est ce que vérifie
    `tests/scope-tenant.test.ts` en inspectant ce que Fastify a réellement enregistré.

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
| `src/api/modele-envoi.ts` | ce qu'un envoi de l'API sait d'un template : `modeleLuDe` (la construction de la lecture partagée `templateVarInfo` ET du catalogue `/v1/templates`), `raisonNonEnvoyable` (ce qu'aucun envoi ne peut faire partir) et `verdictModele`. Le catalogue n'annonce que ce que l'envoi accepte |
| `src/server.ts` -> `modulesDeRoutes` | 🔴 le point de passage OBLIGÉ pour monter un module de routes. Chaque entrée déclare sa `ClasseDAcces` (six valeurs, pas deux), et la couverture du garde-fou d'authentification s'en DÉRIVE au lieu d'être recopiée. Monter une route ailleurs la sort du garde-fou sans qu'aucune erreur ne le dise |
| `src/crm/contact-store.pg.ts` -> `MATCH_BY_WAID_SQL` | résoudre un contact par `wa_id` (E.164 exact, chiffres nus, BSUID) |
| `src/crm/identity.ts` -> `waIdOfTarget` | la règle wa_id pour une cible d'envoi |
| `src/api/fiche.ts` -> `resoudreFiche` | 🔴 trouver la fiche d'une personne à partir des clés reçues par l'API publique. Une seconde résolution divergerait sur la règle multi-clés, et une personne aurait deux fiches |
| `src/api/consentement.ts` -> `appliquerConsentement` | le consentement écrit par une machine, et sa ligne d'audit |
| `src/api/erreurs.ts` | `STATUT_PAR_CODE` et `refuser` : la forme `{ error, code }` des erreurs de `/v1/contacts`, `/v1/sends`, `/v1/messages/whatsapp`, `/v1/messages/rcs`, des catalogues et de la garde de clé ; tout nouveau refus de l'API publique passe par là |
| `src/crm/date-iso.ts` | normaliser une date venue d'un tiers, et REFUSER l'ambigu en le disant |
| `src/crm/contact-filters.ts` | les règles de filtrage des contacts (bornes, opérateurs, plafonds), et le refus d'un niveau de risque inconnu (`FiltreContactInvalide`, 400) |
| `src/engagement/risque.ts` | 🔴 la grille du risque de désengagement, en règles PURES (`calculerRisque`), ses niveaux et ses codes de raisons (`NIVEAUX_RISQUE`, `RAISONS_RISQUE`), les seuils par défaut et `passeEnEleve`. La base (CHECK de 0178), l'API, les signaux et la console (`web/lib/risque.ts`, par `tests/web-risque-parite.test.ts`) lui sont tenus |
| `src/stats/range.ts` -> `BOUNDS_CTE` | les bornes de date, robustes au changement d'heure |
| `src/inbox/origine.ts` -> `ORIGINE_EFFECTIVE_SQL` | 🔴 le fragment SQL qui dit d'OÙ vient un message sortant, avec sa dérivation bornée pour l'historique d'avant la migration 0099. Il attend l'alias `m` pour `conversation_messages`. Le recopier ferait diverger un total de sa ventilation : la ventilation du Performance Lab et le compte de messages de l'en-tête de l'agent de Meta doivent classer un message de la même façon. ⚠️ Une requête qui le lit se restreint aux SORTANTS (`m.direction = 'out'`), sans quoi elle sort du prédicat de l'index partiel `conversation_messages_origin_idx`, sans qu'aucune erreur ne le dise. `THEME_DE_ORIGINE` et `DETAIL_IA` vivent dans le même fichier, pour la même raison |
| `src/stats/prix.ts` -> `coutRcsEuros()` | le prix d'un lot de RCS depuis la grille UNIQUE (simple / conversationnel ; « de l'espace » jusqu'au 2026-09-23, où la grille est devenue globale, migration 0168). 🔴 Deux écrans l'appliquent, « coût des messages envoyés » et « coût par engagement » : la formule tient en une ligne, ce qui est exactement pourquoi elle allait être recopiée, et deux copies donneraient deux prix pour le même envoi |
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
| `src/lib/journal.ts` -> `journaliser` | la ligne de journal JSON du dépôt (`{ lvl, msg, ... }`). 🔴 `req.log` et `app.log` sont MUETS (`logger: false`). Une `Error` y garde son message, sa CAUSE sur un niveau (un `fetch failed` sans son `ENOTFOUND` ne dit rien) et sa pile au niveau `error` ; un champ illisible est remplacé SEUL, sans emporter ses voisins ; elle ne lève jamais. L'espace s'y écrit `tenantId`, tenu par un test |
| `src/meta/numero-espace.ts` | le numéro Meta d'un espace, mis en cache. 🔴 Il ne garde QUE les réponses POSITIVES : une réponse nulle devient fausse à l'instant où un client branche son premier numéro, et le cache étant par process, aucune invalidation ne traverse l'API et le worker. C'est ce qui rend acceptable de mettre en cache une décision |
| `src/lib/http-get.ts` | une lecture GET injectable, testable sans réseau |
| `src/lib/heures-ouvrees.ts` -> `prochaineOuverture` | « quand est le prochain créneau ouvert ? », pour le bloc Attente et les campagnes |
| `src/lib/heures-ouvrees.ts` -> `fenetreDeRattrapageOuverte` | « a-t-on le droit de RATTRAPER maintenant ? ». 🔴 Autre question que `business_hours_only` (l'envoi initial, côté moteur), et une semaine entièrement fermée y rend `true` : sinon ses rattrapages gèlent pour toujours |
| `src/lib/adresses-publiques.ts` | les adresses que le produit DISTRIBUE (`/r/`, `/m/`, `/w/`) |
| `src/agent/devise.ts` | dollars du Gateway -> micro-euros, en UN endroit |
| `src/agent/modeles.ts` | les modèles proposables et leur tarif client : le menu ET la garde d'écriture y lisent |
| `src/llm/errors.ts` -> `direPanneModele` | ce qu'un échec d'appel au modèle a le droit de dire au client, ou `null` : c'est alors NOTRE panne, que l'appelant RELANCE en 500 opaque. ⚠️ `fetch failed` et un abandon n'y sont attribués au modèle que parce que, dans ses quatre appelants, le seul `fetch` est l'appel au modèle |
| `src/agent/llm/tool-schema.ts` -> `paramsOutil` | 🔴 la séparation des sources d'un paramètre (`modele` vs `contact` ou `fixe`). Deux lectures divergentes rendraient la cible au modèle, donc un IDOR |
| `src/agent/setup/proposition.ts` | ce que l'IA de construction a le DROIT de proposer. 🔴 La FRONTIÈRE est la liste des CLÉS et les énumérations FERMÉES, jamais une longueur : les bornes sont de l'hygiène, et `assainirProposition` les RAMÈNE avant que Zod ne juge, au lieu de perdre le tour. ⚠️ Toute borne appliquée est annoncée dans le schéma envoyé au modèle, et un test le dérive plutôt que de le relire |
| `src/agent/poser-tag.ts` | les TROIS effets de « poser un tag » depuis un agent |
| `src/agent/contexte.ts` | ce que le cerveau doit savoir d'un agent (production ET bac à sable) |
| `src/agent/fiche.ts` | les DEUX schémas de fiche : celui qui LIT, celui qui PATCHE |
| `src/webhooks/json.ts` | `asArray`, `asRecord` : lecture défensive d'un payload Meta |
| `src/queue/names.ts` | les files, leur cadence, leur DLQ, leur réveil |
| `src/signaux/types.ts` | 🔴 le DICTIONNAIRE des signaux remontés vers l'outil d'un client, indépendant de tout outil : noms d'événements et d'attributs, noms des CHAMPS de chaque événement (`CHAMPS_EVENEMENT`), borne des textes, résumé en morceaux, `idSignal` (l'`em_event_id` STABLE et opaque), `identifiantPoussable` (la fiche se pousse-t-elle, et sous quel identifiant : une règle pour le complément et pour l'adaptateur), libellé neutre du journal des erreurs. Un adaptateur le traduit, il ne l'étend ni ne le renomme. La documentation publique (`web/lib/signaux-dictionnaire.ts`) lui est tenue par `tests/web-signaux-parite.test.ts`, sans nommer aucun outil |
| `src/signaux/emetteur.ts` | 🔴 le SEUL point d'émission d'un signal : il ne lève jamais, ne lit rien tant qu'aucun espace n'a branché d'outil, ne transporte que ce que le chemin chaud sait déjà, et enfile des jobs bornés (`SIGNAUX_PAR_JOB`) avec leur priorité (`PRIORITE_SIGNAL` : les accusés derrière). La fiche, l'origine et l'analyse se relisent au moment de pousser (`completer.ts`) |
| `src/signaux/completer.ts` | relit, au moment de pousser, ce qu'un signal ne transporte pas (fiche et consentement courants, contexte d'un message, lien, analyse). 🔴 CONTRAT : il porte la règle d'identité de l'adaptateur actuel (`identifiantPoussable`, une fiche ne se pousse que sous son `externalId`, sinon ni contexte ni lien ne sont relus). Un adaptateur qui désignerait un profil autrement devra lui passer SON critère, sinon il recevrait des signaux amputés sans erreur |
| `src/ids/code.ts` | les identifiants publics et les codes de lien |

### Front

| Module | Ce qu'il porte |
|---|---|
| `web/lib/format.ts`, `web/lib/day.ts` | les seuls porteurs des tags BCP47. ⚠️ Un nombre affiché passe par `fmtNum`, jamais par un `toLocaleString('fr-FR')` écrit sur place : celui-là ignore la langue choisie |
| `web/components/EnteteAgent.tsx` | l'en-tête des DEUX écrans de réglage d'agent (l'agent de Meta, la fiche d'un agent IA) : logo, identité, état, ce qui reste à régler, ce qu'on ne sait pas, et le nombre de messages. 🔴 Purement présentationnel, il ne lit rien : les deux écrans le remplissent depuis des sources différentes. Trois de ses props distinguent `null` (« on ne sait pas ») d'une liste vide (« tout est réglé ») ; les confondre fait AFFIRMER à l'écran ce que personne n'a mesuré |
| `web/components/MbaTabs.tsx` | le menu d'onglets de ces deux mêmes écrans, en barre ou en colonne (`orientation`). 🔴 Une SEULE liste est rendue dans les deux cas : un second bloc ferait exister chaque `data-testid` en double et casserait les clics de toutes les suites e2e qui les utilisent |
| `web/components/PastilleNumero.tsx` | l'état d'un numéro WhatsApp (puce colorée + libellé), tel que `getAccountStatus` le rend. Extrait de l'Accueil pour l'en-tête de l'agent de Meta |
| `web/lib/ui.ts` -> `DOT_HEX` | la couleur d'une pastille de statut, en hexadécimal DIRECT : une classe `bg-<couleur>-500` calculée n'est pas vue par le balayage de Tailwind, donc absente du CSS, donc la pastille sort sans couleur |
| `web/lib/couleurs.ts` | la palette : `brand` seul accent, `ink` neutres, une teinte par état (`danger`, `alerte`, `succes`, nuances 50 à 900, `DEFAULT` = la nuance lisible en texte sur blanc). `tailwind.config.ts` la lit ; le canevas, les pastilles et les graphiques l'importent au lieu d'écrire un hexadécimal. Texte gris : 900 courant, 500 secondaire. `ink-400` est réservé aux icônes, aux indications de saisie, aux états désactivés et à « n/d ». Un texte blanc se pose sur `brand-600`, jamais sur `brand-500` |
| `web/tailwind.config.ts` | TROIS rayons (`controle`, `carte`, `full`, plus `none`). Le thème est remplacé, pas étendu : `rounded-lg` ne génère plus rien. DEUX largeurs de contenu : `max-w-liste` (72rem), `max-w-formulaire` (48rem). Tenu par `tests/web-formes.test.ts` |
| `web/components/Icone.tsx` | les icônes (Phosphor), par leur nom. Seul importeur de `@phosphor-icons/react`, épaisseur `regular` unique, une taille par contexte (`nav`, `ligne`, `petite`, `mini`, `grande`). `lib/nav.ts`, `nodeMeta.ts` et `rcs-boutons.ts` désignent une icône par son NOM. Tenu par `tests/web-icones.test.ts` |
| `web/components/Modale.tsx` | LA fenêtre modale : dialogue, Échap (fenêtre du dessus seulement), clic sur le voile, focus rendu à la fermeture ; `pied`, `testId`, `fermeture="boutons"` pour une fenêtre dont la fermeture perd un travail. Aucun autre voile `fixed inset-0` que `VoileMenu` (`Flottant.tsx`) et le tiroir d'`AppShell` |
| `web/components/Confirmation.tsx` | `BoutonConfirme` (sur place, pour un geste de ligne) et `useConfirmation()` (fenêtre, pour un geste lourd : promesse, à la place de `window.confirm`). Le fournisseur est posé une fois dans `app/layout.tsx` ; sans lui la réponse est « non ». Repères e2e : `confirmation-oui`, `confirmation-non` (`e2e/aide/confirmation.ts`) |
| `web/components/Squelette.tsx` | l'attente d'un contenu (`lignes`, `carte`, `fil`), à la place de « Chargement… ». Un état d'attente DANS un contrôle reste un mot |
| `web/components/Nd.tsx` | `Nd` : une valeur absente, « n/d » en gris, jamais un zéro ni un tiret. `ErreursRegroupees` et `useErreurRegroupee` : une seule phrase d'erreur par écran (Performance), les cartes en panne n'affichent plus que « n/d » |
| `web/lib/ui.ts` -> `cadreCls` | la carte sans rembourrage, pour une carte découpée en bandes par des filets |
| `web/components/Bouton.tsx` | le bouton : `principal` / `secondaire` / `discret`, `normale` / `petite`, `enCours`. Aucun `type` par défaut (un `<button>` sans type vaut `submit` dans un formulaire). `classesBouton()` pour un `Link` ou un `label`. Les boutons d'icône restent des `<button>` simples |
| `web/components/TitrePage.tsx` | `TitrePage`, le seul `h1` d'une page (`text-xl`), et `IntroPage`, la phrase sous le titre (`max-w-prose`). Police : Geist et Geist Mono (`next/font/google`, `web/app/layout.tsx`) |
| `web/lib/libelles-mba.ts` -> `LIBELLES` | le seul lien entre une clé de tâche de complétion (serveur) et un onglet de l'écran, plus le libellé de repli quand le serveur ne joint pas de raison |
| `web/lib/logos-llm.ts` | le logo d'un modèle, dérivé du PRÉFIXE de son identifiant, et la pastille de repli. 🔴 L'`alt` est VIDE délibérément : il entrerait dans le nom accessible du bouton qui porte l'image, que deux suites ciblent par ce nom |
| `web/lib/campaign-eligibility.ts` | 🔴 le MIROIR de l'analyse d'ouverture serveur, tenu par un test de parité |
| `web/lib/api-exemples.ts` | les exemples (corps et réponses), les codes d'erreur et les bornes des pages de la documentation API (`FICHIERS_DOC`). 🔴 Aucun fichier de la doc n'écrit de JSON à la main : `tests/api-exemples.test.ts` passe chaque corps aux règles de sa route (schéma zod, règles de cible), type chaque réponse par ce que sa route rend, tient la table des codes égale à `CodeApi` (au typecheck), vérifie que les exemples se répondent (l'appel de scénario décrit les variables du template d'ouverture montré) et refuse tout nom d'outil tiers. ⚠️ Aucun import : il est lu par la console ET par la suite racine |
| `web/lib/doc-api-pages.ts` | la carte de la documentation publique : ses pages (adresse, fichier, groupe, titre, ancres) et la liste FERMÉE de ses fichiers (`FICHIERS_DOC`). 🔴 Les gardes de source (`tests/api-exemples.test.ts`, `tests/web-signaux-parite.test.ts`, `tests/web-risque-parite.test.ts`, `web/lib/api-base.test.ts`) lisent cette liste, jamais tout `web/`, et chacune exige d'y trouver ce qu'elle cherche. Une page posée sous `web/app/developers/api/` sans y figurer fait tomber la suite. L'e2e ouvre chaque page (console, sans compte, anglais, mobile) et vérifie chaque ancre. ⚠️ Aucun import de valeur ; plus `ANCRES_DEPLACEES` (anciennes ancres, et la page de départ vers la nouvelle adresse) et `LIENS_NAV` (entrées de navigation qui ne sont pas des pages) ; la liste fermée couvre aussi `web/components/doc-api/` et les modules de texte |
| `web/lib/api-champs.ts` | les tableaux de champs de chaque corps de requête, les cibles d'un envoi et les sources de `params`. 🔴 `tests/api-champs-parite.test.ts` les tient égaux aux schémas zod des routes, dans les deux sens : clés, obligation dérivée du schéma, type, valeurs d'énumération, clés refusées, et sort d'une clé inconnue. `params` est éprouvé par `validateParamMapping`. ⚠️ Aucun code d'erreur dans ses textes : un code se cite par `<Code>` |
| `web/lib/api-doc-endpoints.ts` | l'index des douze endpoints, source unique de l'index de l'Accueil de la doc, du « Sur cette page », de l'en-tête de chaque route et du tableau des droits. 🔴 `tests/api-doc-endpoints.test.ts` monte l'entrée `v1` du registre du serveur et compare méthodes, chemins et droits dans les deux sens |
| `web/components/doc-api/` | `CadreDoc` : le cadre de chaque page de doc ; il décide console ou public une fois pour toutes, porte la navigation et suit l'ancre après le rendu. `elements.tsx` : titre, route avec badge de méthode, bloc avec Copier, encadrés, lien typé vers une ancre déclarée, et `ADRESSE_API`, dérivée de `BASE`, définie ici seulement ; `Route` prend la clé d'un endpoint ; `Champs`, `Erreurs` et `Refus` lisent le statut d'un code dans la table (`statutDe`), jamais écrit à la main |
| `web/lib/intentions.ts` | 🔴 la SEULE copie des intentions d'une conversation analysée côté console : la liste, l'ordre d'affichage (fixe, `autre` en dernier) et les libellés, pour la carte du Performance Lab ET l'Analyse des conversations. Miroir de `INTENTS` (`src/analysis/schema.ts`), tenu par `tests/intentions-parite.test.ts` (à la racine : seul `ci.yml` tourne quand `src/` change). Une intention absente d'une API plus ancienne vaut zéro (`comptesParIntention`) |
| `web/lib/erreurs-livraison.ts` | l'ORIGINE d'une ligne du journal des erreurs de livraison, en mots (canal et provenance d'un message libre non délivré), et l'export CSV de ce journal : les mêmes mots à l'écran et dans l'export |
| `web/lib/chemin-json.ts` | le miroir de `src/webhook-entrant/chemin.ts` : mêmes chemins d'or dans les deux jeux de tests |
| `web/lib/contact-filters.ts` | les filtres du mini-CRM, miroir du parse serveur |
| `web/lib/risque.ts` | le risque de désengagement à l'écran : badges des niveaux, libellés des raisons en deux langues, choix du filtre, et `risqueLu`, qui lit le champ venu du réseau et rend `null` (« pas encore calculé ») pour un champ absent, nul ou illisible, jamais un niveau inventé |
| `web/lib/rcs.ts` | déduire le format d'un message RCS de sa saisie, miroir de `rcsOutboundOf` |
| `web/lib/rcs-carrousel.ts` | le carrousel RCS côté écran (brouillon, message envoyable, manques carte par carte) et la relecture STRICTE d'un carrousel copié dans un brouillon de campagne : mal formé, il est jeté. Tenu contre `rcsOutboundSchema` par `tests/web-rcs-carrousel.test.ts` |
| `web/components/Field.tsx` | le libellé de champ des formulaires de contenu (templates, messages RCS). Hors de `TemplateForm` pour ne pas embarquer ce module lourd |
| `web/components/RcsPhoneFrame.tsx` | le cadre de téléphone des aperçus RCS, pendant de `PhoneFrame` (nom de marque de l'agent, une requête par espace) |
| `web/lib/flow-mapping.ts` | la cible d'un champ de formulaire, avec la sentinelle `@profile_name` |
| `web/lib/inbox-rangement.ts` | les gestes de rangement de l'Inbox : leurs libellés, et les destinations qu'une SÉLECTION peut prendre selon le dossier |
| `web/components/VariableBodyEditor.tsx` | l'éditeur à chips, partagé par les variables Meta (positionnelles) et RCS (nommées) |
| `web/lib/session.ts` -> `pageDArrivee` | où atterrit un compte après connexion, selon son rôle |
| `web/lib/http.ts` -> `messageDErreur` | le texte d'une réponse en échec : la raison écrite par le serveur, sinon, pour un 5xx, une phrase traduite qui garde le statut |
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
