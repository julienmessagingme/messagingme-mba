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
`mba-api` **avec le préfixe retiré par nginx** (`rewrite`), `/r/`, `/m/` et `/mcp` y vont directement, tout le
reste va à `mba-web`. 🔴 **Chaque route nomme `mba-api` par une VARIABLE** (`set $mba_api mba-api`), résolue à
l'exécution par le résolveur de Docker que NPM déclare (`127.0.0.11`, relu toutes les 10 s), comme le fait déjà
l'hôte `api.` : un nom écrit en dur dans un `proxy_pass` est figé au chargement de nginx. C'est ce qui a permis de migrer la console vers Vercel sans toucher à la configuration du webhook
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
- **E-mail** : deux chemins sans rapport. **Resend** pour les mails du produit (support, formulaire de contact de
  la vitrine, invitation, réinitialisation), destinataire et expéditeur fixés côté serveur. **nodemailer / SMTP par workspace** pour le
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
| **Publicités Click-to-WhatsApp** | connecter le compte publicitaire, créer (image ou vidéo, audiences), publier, suivre, router le prospect | `src/pubs/`, `src/meta/pubs*.ts`, `src/http/pubs.ts` | `/publicites` | `pub_connexion`, `publicites`, `pubs_brouillons`, `pubs_connues`, `arrivees_pub` | balayage de suivi |
| **Widget WhatsApp** | une bulle sur le site du client qui ouvre WhatsApp avec une phrase, et ce qui se passe quand cette phrase arrive | `src/widgets/`, `src/http/widgets.ts`, `src/http/widget-public.ts` | `/widgets` | `widgets`, `widget_tirs` | aucune : une étape de `processInbound` |
| **API publique v1** | ce qu'un intégrateur du client appelle | `src/api/`, `src/http/v1-*.ts` | `/developers` | `api_keys`, `api_idempotency` | |
| **Serveur MCP et son OAuth** | Claude (Claude Code, claude.ai) lit et agit dans un espace, par une clé d'API ou un jeton OAuth (§ 7) | `src/mcp/`, `src/http/mcp.ts`, `src/oauth/`, `src/http/oauth.ts`, `src/http/oauth-consentement.ts` | `/developers/mcp` | `oauth_autorisations`, `oauth_codes` | `retention-oauth` |
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

`standby` était donc **l'ÉCHO de ce que l'agent de Meta ENVOIE**, pas un canal d'entrants : le 2026-09-15 à
07:58:39 un message du client est arrivé en `messages` alors que l'agent de Meta tenait le fil, ce que prouve
sa réponse sept secondes plus tard.

🔴 **DEPUIS LE 2026-09-29, UN ENTRANT ARRIVE AUSSI EN `standby`, ET C'EST LA LISTE DE L'AGENT QUI DIT À QUI IL
PARLE.** Mesuré ce jour-là sur le numéro de test : après un MODÈLE, la réponse du contact arrive en `standby`
(un modèle rend la conversation à l'agent chez Meta, un message libre nous la donne), et en mode liste Meta
continue d'y ranger des messages alors que l'agent se tait. Juste après le rattachement, avant
`processInbound` et tout ce qui lit `field`, la réception réécrit donc en `messages` le `standby` d'un contact
ABSENT de la liste de l'agent (`requalifierLesStandby`, `src/webhooks/standby-hors-liste.ts` ; une lecture des
réglages et une de la liste par espace et par lot, qui lève en échec et fait rejouer le job). L'avance (texte et
bouton), les automations, la remise « personne ne suit », le routage et l'arrivée publicitaires le traitent
comme un message ordinaire, et la correction du détenteur n'écrit pas `mba`. Le champ reçu reste sur l'entrant
(`fieldRecu`) et au journal (`standby_hors_liste`). Contact PRÉSENT sur la liste, ou agent éteint : le
`standby` reste un `standby`, et la garde `field !== 'messages'` (automations, avance, jeton de test) le fait
taire, l'agent lui parlant. `WebhookJobDeps` rend `listeALArrivee` obligatoire avec `inbox`.

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
   -> payload brut enfilé dans `webhook` (par le pool applicatif de l'API, prêté à pg-boss, § 6)
   -> 200 immédiat (cible < 50 ms), zéro logique métier
                      |
      worker, job `webhook` :
        dédup par meta_message_id (les webhooks arrivent en double)
        rattachement à l'espace, puis un `standby` d'un contact absent de la liste de
          l'agent de Meta devient un `messages` (une lecture de la liste par lot)
        auto-création ou mise à jour du contact (isolée : un échec ne casse pas l'inbox)
        capture du referral CTWA (premier message seulement) : champs de la fiche
        enregistrement dans le fil
        arrivée publicitaire (`arrivees_pub`, ctwa_clid et standby compris), isolée
        routage du lead publicitaire (lot 3), isolé : il ANNOTE l'arrivée ci-dessus et
          RESTREINT les déclencheurs ci-dessous, et il reprend le fil à l'agent de Meta
          (le contact quitte sa liste) quand la publicité confie ses prospects à un
          scénario (jamais à un opérateur)
        puis, DANS CET ORDRE et chacun isolé en try/catch :
          1. mapping de formulaire  (nfm_reply -> champs de la fiche)
          2. jeton de test          (CONSOMME le message, personne d'autre ne le voit)
          3. automations            (mot-clé, tag, lien de chaîne) -- CONSOMMENT aussi,
             et le routage publicitaire peut n'en autoriser QU'UNE, ou aucune
          4. rendu des fils pris pour rien (le routage a pris le fil, rien n'a démarré)
          5. avance de scénario     (le contact a répondu, sur ce qui reste)
          6. remise à l'agent de Meta quand personne ne suit (règle 2 du mode liste)
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

🔴 **L'ÉTAPE DU WIDGET EST LA DERNIÈRE DE `processInbound`** (`src/widgets/arrivee.ts`). Chaque étape au-dessus
voit exactement ce qu'elle voyait sans widget, et un message qui ne porte aucune phrase ne coûte qu'une lecture des
widgets de son espace (`reconnaissanceDesWidgets`). Un message TEXTE qui CONTIENT la phrase d'un widget actif (à la
casse, aux accents et aux espaces près ; la plus longue gagne) reçoit l'étiquette `widget-<code>`, dérivée du code
donc stable quand le widget est renommé, et qui n'émet AUCUN événement d'automation. Puis le devenir du widget :
`scenario` démarre son scénario par le runner des automations et toutes ses gardes, sur une automation construite
en mémoire dont le propriétaire est `POSSESSEUR_WIDGET` (`src/automation/match.ts`). Son type de lancement
(`typeDeLancementDe` : `automatisme_publicite_ou_widget`) REPREND donc le fil à l'agent de Meta et le LAISSE à un
opérateur qui le tient, comme une publicité ; un `standby` démarre comme un `messages`, la reprise retirant le contact de la liste de l'agent avant
tout envoi, ou annulant le démarrage si Meta refuse. Le message qui démarre le scénario est CONSOMMÉ : ni
automation, ni avance de parcours, ni remise à l'agent de Meta ne le voient. `mba`, `agent` (grisé « à venir » à
l'écran et refusé par l'API) et `null` ne démarrent rien. Les tirs du widget vivent dans `widget_tirs`, pas dans
`automation_fires`, qui référence `automations`.

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
         et relit la fiche : purge, STOP ou blocage posés depuis -> écarté (`skipped`), rien ne part
       envoi, puis résultat persisté HORS du catch d'envoi
```

🔴 **Le claim atomique par destinataire est la seule garantie anti-double-envoi.** Ni la file ni le verrou ne
la donnent : aucune file de ce dépôt ne déduplique quoi que ce soit (voir § 6).

🔴 **Le consentement se lit DEUX fois : à la construction de la liste (`optInAllows`), puis au moment d'envoyer,
par le claim** (`PgRecipientStore.claim`, son `returning` lit la fiche par sa clé primaire). Une campagne étalée
(débit bas, pause, heures ouvrées) part des heures après sa construction : une purge, un STOP ou un blocage posés
entre les deux rendent un écart, marqué `skipped` avec son motif (`MOTIF_ECART_A_L_ENVOI`, celui du STOP étant le
texte du scénario), jamais `failed` (la porte de qualité ne le compte pas). Le destinataire est réservé quand
même : un seul run l'écarte. La purge se lit sur `anonymized_at` et prime : le run tient le VRAI numéro lu à son
début, et une fiche purgée n'est ni désabonnée ni bloquée pour autant.

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

🔴 **Un démarrage de parcours a un TYPE, et le type décide de tous ses réglages** (`src/workflow/lancements.ts`).
`TypeDeLancement` est une liste fermée : Inbox, agent de Meta (scénario, bloc), automatisme (ordinaire, chaîne,
publicité ou widget), lien de test, campagne (scénario, bloc). `POLITIQUE_DE_LANCEMENT` donne pour chacun la
reprise du fil (`non` : arrêté par un fil tenu ; `oui` : repris même à un opérateur ; `sauf_operateur` : repris à
l'agent de Meta seulement), la publication des étiquettes posées (jamais sur un chemin de masse), le graphe joué
(publié, fourni par l'appelant, ou brouillon figé pour le seul lien de test) et la garde de fenêtre (gardée, selon
la preuve de l'appelant, levée sur un bloc de départ d'automation, levée). `WorkflowExecutor.demarrer` lit la table
lui-même : aucun câblage ne pose plus de réglage brut, il choisit un type et passe par l'entrée `creerLancements`,
construite par `buildWorkflowRuntime` sur l'exécuteur du processus (l'API et le worker ont donc la même). Une
automation reçoit son type de `typeDeLancementDe` (`src/automation/match.ts`), sur son propriétaire NOMMÉ ; le
runner construit la demande et le worker la transmet telle quelle. `tests/workflow-lancements.test.ts` exécute la
table type par type, sur le vrai contrôle du fil.

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

🔴 **CE QUE LA RECHERCHE DE CONNAISSANCE LIT, L'AGENT LE REÇOIT.** Le plein texte, le rappel vectoriel et le
reclassement lisent une fiche entière ; l'agent en reçoit au plus `CORPS_MAX`
(`src/agent/resolvers/connaissance.ts`). Une fiche ne dépasse donc jamais cette borne : `MAX_CORPS`
(`src/agent/scrape.ts`) en DÉRIVE, et c'est lui qui borne l'import d'une page, celui d'un document, la route
d'une fiche écrite à la main et l'écran, qui le rejoue (`web/lib/agent-connaissance.ts`). Une section plus
longue est découpée en « (suite N) » par `empilerEnFiches`, jamais tronquée ; le CSV a son découpage à lui, par
rangées, sous la même borne. Plus longue, une fiche serait retenue pour une phrase que l'agent ne reçoit pas.
⚠️ Tout nouveau chemin d'écriture d'une fiche passe par cette borne. Le bot d'aide (`src/aide/repondre.ts`)
porte sa propre copie de `CORPS_MAX` et ne tient pas encore cet invariant (`todo.md`).

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
  repose une). Chaque création et révocation est auditée (`cle_api.creee`, `cle_api.revoquee`). Elle se crée
  SANS plafond (`PgApiKeyStore.create`) et ne compte pas dans les dix clés actives de l'espace (§ 7).
- 🔴 **Une seule publication à la fois par espace** (`POST /mba-publication` rend 409 à la seconde) : deux
  poses de clé entrelacées se révoqueraient l'une l'autre. Le verrou est un verrou COURT en base
  (`mba-publication:<espace>`, `src/db/verrous-courts.ts`), donc commun à toutes les copies de l'API ; son jeton
  de garde fait qu'une publication ne relâche que le sien. Bail de dix minutes (`BAIL_PUBLICATION_MS`) : une
  publication ordinaire dure moins d'une minute, et un bail échu en cours de route rouvrirait la course.
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
  bornée à la liste permise). Les gestes réutilisent `poserTagDepuisAgent` (la pose commune,
  `src/crm/poser-etiquette.ts`, en publiant : déclaration, `tag_added` si nouveau) et `mergeFieldsByPhone`. Le
  journal ne porte que la nature du geste, jamais une valeur du client.
- **Ce qui part chez Meta** se calcule dans `src/mba/outils-a-publier.ts` (appels de connecteur, gestes maison et
  outils MCP appelables), testé ; une action d'agent IA exposée par l'ancienne route, une cible illisible ou un MCP
  non activable ou disparu de son serveur ne partent pas. Un MCP sans description part sous « Outil <nom>. », Meta
  exigeant ce champ. ⚠️ Changer la source d'un paramètre sur Connecteurs MCP ne republie rien : la ligne de l'onglet
  passe « À envoyer », et c'est l'envoi qui retire le paramètre de ce que Meta déclare. Un MCP déclare à Meta ses seuls paramètres `modele` ; le
  relais pose les autres (`completerArguments`, le point de passage partagé avec l'exécuteur d'un agent IA) et
  l'appelle sous `DELAI_REPONSE_MCP_MS`, sous les trois secondes de Meta.
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
  changer. Le relais l'envoie par un démarrage au bloc (le type de lancement `agent_meta_bloc`) : il REPREND le fil à
  l'agent de Meta, envoie, et le lui rend à l'accusé (0149). Hors fenêtre de 24 h, seul un bloc fait de modèles part.
- **Lancer un scénario** passe par le type de lancement `agent_meta_scenario`, la MÊME politique que le bouton de
  l'Inbox (fenêtre ouverte : garde levée, fermée : garde posée), et un scénario sans bloc publié est refusé.
- 🔴 **TOUT ÉCHEC APRÈS LA REPRISE DU FIL LE REND, EXCEPTION COMPRISE** (`src/mba/gestes-envoi.ts`, testé) :
  `runFrom` reprend le fil puis peut refuser (désabonné, envoi refusé), et rend alors une raison SANS rendre la
  main, parce que ses autres appelants ont un opérateur ; il peut aussi LEVER (Meta refuse un modèle en pause,
  coupure réseau), et l'exception traverse tout. Dans les deux cas le relais appelle
  `ControleDuFil.rendreApresParcours` (le geste de fin de parcours, `src/inbox/fil.ts`). Si la reprise
  elle-même a échoué, ce geste ne touche à rien (`only: ['app_workflow']`). Une PANNE d'envoi ne s'invite pas à
  réessayer (`erreurDePanne`) : le message a pu partir avant l'exception.
  Un contact bloqué ne reçoit ni bloc ni scénario (`DepsMaison.estBloque`, lu AVANT tout envoi).
- 🔴 **UN ENVOI NE SE REJOUE PAS POUR LE MÊME CLIENT, QUELLE QUE SOIT LA COPIE QUI SERT LE RAPPEL**
  (`src/mba/anti-rejeu.ts`) : deux clés prises d'un seul geste dans les verrous courts, le plancher (client et
  outil, 30 s) et la demande (client, outil et dernier message reçu, 2 min). Un rappel rend « déjà traitée » ; un
  refus relâche les deux ; une exception les garde (le message a pu partir). Une prise impossible (base
  injoignable) lève : rien ne part.
- 🔴 **L'ARRÊT D'UNE COPIE ATTEND LES ENVOIS LAISSÉS EN ROUTE** : un envoi qui dépasse `DELAI_REPONSE_ENVOI_MS`
  continue après la réponse (fin de tour de l'agent, jusqu'à 15 s). Le relais le confie à `TravauxEnVol`
  (`src/lib/en-vol.ts`), et `arreterApi` (`src/shutdown.ts`) l'attend après le serveur et AVANT la file et le
  pool, au plus `ATTENTE_GESTES_A_L_ARRET_MS` (20 s depuis le signal, sous le filet de 25 s). Au-delà, l'arrêt
  continue et le journalise.
- 🔴 **LA RÉPONSE « À CÔTÉ » PART CHEZ L'AGENT DE META** : dans la branche « il a écrit » d'`advance`, le fil est
  rendu PUIS CE message du client (lu par son identifiant, `corpsDuMessage`) lui est transmis par `agent_event`
  (`src/mba/transmettre-hors-parcours.ts`, testé ; l'événement dans `src/mba/evenement.ts`, `payload` en chaîne
  JSON bornée à 4 096 caractères APRÈS échappement, `to` en E.164 avec « + », mesuré). Seulement sur un VRAI
  message WhatsApp : cette branche reçoit aussi une réaction (sa charge porte le message visé) et un rapport RCS,
  qui ne se transmettent pas. Seulement si le fil est vraiment à lui (`mba`) : une conversation de test (marquée
  avant le 2026-10-03 : le lien de test ne marque plus rien), un release refusé ou un marqueur en attente laissent
  un autre détenteur. Rien sur une fin normale de parcours ni
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

🔴 **LA PREMIÈRE CONNEXION ACTIVE LE SERVEUR.** Une source MCP naît `draft` ; `PgMcpStore.appliquer` la passe à
`active` en fin d'import, jamais depuis `disabled`. Le résolveur refuse une source qui n'est pas active : sans
cette écriture, aucun outil MCP n'était appelable, et les fixtures, qui créaient leurs sources actives, le
cachaient. À l'écran, « Connecter » enchaîne l'aperçu (qui marque la réponse du serveur) et l'import ; il ne
demande confirmation que si un agent perdrait un outil (`consentementsTombes > 0`).

🔴 **DEUX ÉTAGES DE CHOIX, ET LE PREMIER VIT SUR L'OUTIL (0199).** `agent_tools.mcp_propose` dit si un outil MCP est
enregistré pour les agents de l'espace (vrai à l'import). `rattacherConsommateur` refuse un outil MCP non
enregistré, pour un agent IA comme pour l'agent de Meta. `PgMcpStore.proposer` refuse de désenregistrer un outil
rattaché à un agent et rend leurs noms (`UTILISE_PAR`, la sous-requête que l'écran affiche aussi). Il verrouille
l'outil par `verrouillerDefinitions`, en `for update` : c'est ce verrou qui fait attendre le `for key share` d'un
rattachement concurrent, puis relire `mcp_propose`. Un `for no key update` rouvrirait la course en silence.

🔴 **LA RÈGLE D'UN OUTIL S'ÉCRIT DANS LE CATALOGUE, JAMAIS CHEZ UN APPELANT.** Trois termes, définis une fois dans
`src/agent/catalog.pg.ts` (fragments `CAUSE_INAPPELABLE`, `ENREGISTRE`, `DE_LA_BIBLIOTHEQUE`) :
- **appelable** (un outil) : ce que son résolveur accepterait, à l'état de l'outil et de sa source. Sa source
  (serveur MCP, ou celle de la REQUÊTE d'un connecteur HTTP) est active et du bon type, et il n'est ni marqué non
  activable ni disparu de son serveur. Un outil maison l'est toujours. Sinon, `inappelable` porte la cause
  (`non_activable`, `disparu`, `source_inactive`), et `messageInappelable` son texte. ⚠️ Ce qui dépend de l'appel
  (requête effacée, connecteur « intègre » sans champ) reste au résolveur ;
- **offrable** (un outil, à un consommateur) : outil de la bibliothèque de l'espace, enregistré s'il est MCP,
  appelable, et pas déjà rattaché à ce consommateur. C'est `offrablesPour`, la liste « ajouter un outil » de l'agent
  de Meta, de la page d'un agent IA (`GET …/agents/:agentId/tools/offrables`) et de l'assistant de construction ;
- **publiable** (chez Meta) : donné à l'agent de Meta, activé, et appelable (`outilsAPublier` lit `inappelable`).

La porte (`rattacherConsommateur`) applique les mêmes fragments et rend sa raison (`Rattachement`, texte par
`messageDuRefus`) ; l'activation (`activerConsommateur`) refuse un outil inappelable ; `listActifs`, ce que voit le
modèle d'un agent IA, n'en rend aucun. ⚠️ `listActifsConsommateur` reste NON filtré : le relais de l'agent de Meta y
cherche l'outil que Meta appelle, et refuse lui-même un outil mort. ⚠️ Côté agent de Meta, un connecteur HTTP sur une
source qui n'est pas active est refusé AVANT d'être créé (`ajouterConnecteurPourMba`) : créer puis activer y est un
seul geste. Un appelant qui refiltre recrée ce que cette règle remplace : cinq copies, en trois versions qui se
contredisaient.

🔴 **CE QU'ON LIT D'UN SERVEUR N'EST PAS CE QU'ON TRANSMET.** Le transport lit une réponse jusqu'à
`LECTURE_MCP_MAX_OCTETS` (1 Mo, comme le catalogue) ; `agent_tools.max_bytes` borne ensuite ce que le modèle reçoit
(`borner`, dans l'exécuteur et dans le relais). Lire sous `max_bytes` faisait échouer en « réponse trop grosse »
tout serveur réel (Microsoft Learn rend 50 à 70 Ko).

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

`scopeTenant` (`src/http/scope.ts`) est la RÈGLE de ce contrôle pour toutes les routes `:tenantId` de la
console, et elle **ÉCHOUE FERMÉ** : sans `req.auth`, elle refuse au lieu de rendre le tenant pris dans l'URL.
Un garde-fou de `buildServer` couvre les modules à routes `:tenantId`, tenu par `tests/scope-tenant.test.ts`.
Sa couverture est **dérivée** du registre des modules de routes (`modulesDeRoutes`, `src/server.ts`), où
chaque module déclare sa classe d'accès : il n'y a aucune liste de modules à tenir à jour.

🔴 **LA RÈGLE S'APPLIQUE AU MONTAGE, JAMAIS DANS UN HANDLER** (lot 3 de l'audit ponytail, 2026-09-26). `entree`
(`src/server.ts`) monte chaque module déclaré `acces: 'tenant'` par `monterAvecEtapeEspace`, qui ajoute l'étape
`etapeEspace` EN DERNIER à la chaîne `preHandler` de chacune de ses routes `:tenantId` : après la garde
d'authentification (qui pose `req.auth`), après la garde de rôle et le plafond coûteux, donc exactement là où
se trouvait la première instruction du handler. Elle refuse en 403 `{ error: 'tenant interdit' }`. Le handler
lit l'espace par `espaceVerifie(req)`, qui **LÈVE** si l'étape n'a pas tourné : une route oubliée rend un 500
opaque, jamais un espace non vérifié. Trois choses à savoir :
- **le critère est la CLASSE du module, puis le chemin.** Les modules `session-ops` (`/ops/credits/:tenantId`)
  portent aussi des `:tenantId`, sans session d'espace : ils ne passent pas par le poseur, leur autorité est la
  session d'exploitation ;
- **les routes d'un module `tenant` SANS `:tenantId` ne reçoivent pas l'étape** : les trois routes de campagne
  adressées par `:campaignId` s'isolent par `req.auth.tenantId` et le filtre du store, et `/m/:fichier` est
  publique ;
- **un `addHook('preHandler')` de contexte ne convient pas** : il tourne AVANT les gardes de route, donc sans
  `req.auth`, et refuserait toute la console. Et le poseur construit toujours une NOUVELLE chaîne : celle d'un
  module est souvent partagée (`requireAdmin` est un seul tableau), un `push` y empilerait l'étape.

Un test qui monte un module à la main passe par `monterAvecEtapeEspace`, comme la production, jamais par un
contournement dans `src/`. La preuve se lit sur le serveur CONSTRUIT (`tests/serveur-sonde.ts` monte le vrai
registre avec les vraies gardes, sans base) : `tests/scope-tenant.test.ts` exige que chaque route `:tenantId`
d'un module `tenant` finisse par l'étape, une seule fois et derrière au moins une garde, qu'aucune autre ne la
porte, et qu'une session d'un autre espace y soit refusée avant le handler, sans un seul appel de dépendance.

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
  passe » est exprimé par la structure ; le SECOND FACTEUR y vit aussi, migration 0182 : `mfa_secret_enc`,
  `mfa_active_le`, `mfa_dernier_pas`, `mfa_secret_attente_enc`), `mfa_codes_secours` (empreintes SHA-256 des
  codes de secours d'une identité, `utilise_le`, cascade sur l'identité), `auth_tokens` (invite | reset,
  `token_hash` sha256, consommation atomique dans le `update ... returning`).
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
- `oauth_autorisations` et `oauth_codes` (0204) : une autorisation par PASSAGE dans le consentement, pour UN espace
  et une personne admin (`tenant_id` et `user_id` en cascade : supprimer le compte révoque). Elle porte UNE paire de
  jetons vivante, remplacée à chaque renouvellement : `acces_hash` (1 h), `refresh_hash`, `refresh_precedent_hash`
  (le précédent, qui reconnaît un rejeu), `refresh_expire_le` (30 jours sans usage), `refresh_max_le` (90 jours, fixé
  au premier échange), `revoque_le`. `client_id` est borné aux deux fiches de Claude et `scopes` à `mcp:read` et
  `mcp:write` par deux CHECK. Un code (60 s, usage unique) garde son défi PKCE et son adresse de retour. Seules des
  empreintes SHA-256 y entrent ; le rôle et la désactivation ne sont PAS recopiés, ils se relisent dans `users`.
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
- 🔴 **Le filtre par niveau de risque se REFUSE au lieu de s'ignorer**, comme les filtres de la dernière analyse
  (ci-dessous) : ce sont les deux seuls. Une valeur hors des quatre niveaux lève `FiltreContactInvalide` dans
  `buildContactFilters`, et son `statusCode` la fait rendre en 400 par le gestionnaire d'erreurs, sur toute route
  qui lit des filtres, sans que la route ait à le traiter. Ignorée, elle ne poserait aucune clause, et « risque
  élevé » rendrait tout l'espace à une campagne. ⚠️ Son prédicat est une égalité NUE, `risque_niveau = $n`, derrière `tenant_id = $1 and deleted_at
  is null` : c'est le contrat de l'index partiel `contacts_tenant_risque_idx (tenant_id, risque_niveau) where
  deleted_at is null`, et `tests/contact-where.test.ts` relit la migration pour le tenir. Une fiche jamais
  calculée n'est dans aucun niveau, `inconnu` compris : `inconnu` est un calcul qui n'a rien pu observer.
  ⚠️ La console ne PROPOSE ce filtre que si l'API a montré qu'elle le connaît (une ligne de `/contacts` porte la
  clé `risque`, `apiConnaitLeRisque`) : une API qui ne le connaît pas l'ignorerait, et « élevé » rendrait tout
  l'espace. Un filtre déjà posé reste affiché.
- 🔴 **La dernière analyse vit SUR LA FICHE** (colonnes `analyse_*`, migration 0196, chantier « Tout sur la
  fiche », spec `docs/superpowers/specs/2026-09-30-fiche-unique-design.md`). Son SEUL écrivain est
  `PgConversationAnalysisStore.save`, dans la transaction de l'analyse, et `tests/fiche-analyse-ecrivains.test.ts`
  le tient. Règle de la plus récente : une analyse n'écrase la copie que si sa borne de fenêtre est postérieure ou
  égale (`analyse_fenetre_fin`), l'ancienne copie lue `for update`. La copie est entière ou absente (CHECK de
  cohérence) et survit à l'effacement de la conversation, sauf `analyse_conversation_id`, qui retombe à `null` ;
  le résumé, lui, part avec la conversation (il suit `analyse_conversation_id` quand la copie existe). Aucune
  reprise de l'historique : une fiche se remplit à sa prochaine analyse. Le risque lit la copie, et retombe sur
  les conversations pour une fiche qui n'en a pas.
- 🔴 **Hors de la console, quatre lecteurs de la copie, et le résumé n'en suit que deux.** L'API publique rend
  `lastAnalysis` SANS résumé (décision 15 de la spec : il reprend les propos du client), lecture seule, la clé
  étant écartée par les schémas d'écriture. Le MCP rend `last_analysis` AVEC le résumé de la même analyse, en UNE
  requête par page (`PgContactStore.analysesEtResumes`, l'espace filtré sur les deux tables). L'outil
  `mba_lire_contact` de l'agent IA rend `derniere_analyse` et `resume` par `analyseEtResumeParWaId`, pour le
  contact du TOUR seulement, une dépendance REQUISE du résolveur et HORS de `projectionPourTiers` : les
  connecteurs, qui reçoivent cette projection, ne voient rien de plus. Les signaux lisent ses huit valeurs avec
  la fiche (`COLONNES_FICHE`, aucune requête de plus) et les envoient avec CHAQUE signal (`attributsRelus`) : un
  signal d'analyse rejoué après une analyse plus récente ne réécrit donc pas un état périmé chez l'outil.
- 🔴 **La liste unique des champs de la fiche est `src/crm/champs-fiche.ts`** : les données envoyées d'un
  connecteur (origine `fiche`), les filtres de contacts, le ciblage d'une campagne et le bloc Condition la
  lisent, la console la reçoit de `GET /tenants/:t/champs-fiche` (admin, comme `/user-fields`, qui n'est PAS
  enrichie : les variables de message ne reçoivent jamais l'analyse). Ses clés sont réservées : ni la
  bibliothèque de champs, ni l'import CSV, ni l'API, ni un formulaire Flow ne peuvent en faire un champ perso
  (`estCleReservee`, ensemble séparé de `SYSTEM_FIELD_KEYS`), `nom` et `wa_id` exceptés pour un formulaire.
- 🔴 **Les filtres de la dernière analyse passent par `fieldFilters`**, jamais par un membre neuf de
  `ContactFilters` : un serveur plus ancien ignorerait ce membre, et l'audience deviendrait l'espace entier. Une
  clé d'analyse va à SA colonne par la carte fermée de `src/crm/filtre-fiche.ts` (seule source des noms de
  colonne du SQL), avec les opérateurs de son type (`in`, `gte`, `lte`, `is_true`, `is_false`,
  `newer_than_days`, plus `empty`/`not_empty`) ; le sujet ne se filtre pas. Une valeur ou un opérateur invalide
  lève `FiltreContactInvalide` (400), et `parseFilters` normalise HORS du `try` qui décode le JSON, sans quoi le
  refus deviendrait « aucun filtre ». Un filtre qui n'a pas traversé la validation pose `false`, jamais l'absence
  de clause. `null` ne satisfait aucune comparaison et seul `empty` le retient ; une note de 0 est une mesure.
  Le bloc Condition applique la MÊME sémantique (`evaluerFiltreFiche`) sur `EvalContext.analyse`, membre séparé
  de `fields` (la fonction JS d'un scénario reçoit `fields`), rempli par `getContactStateByWaId` ; la parité
  avec le SQL est tenue contre une vraie base (`tests/integration/filtre-fiche.integration.test.ts`). La console
  ne propose ces filtres que si `champs-fiche` répond, et `filtresRepris` garde leurs opérateurs.
- 🔴 **Le déclencheur « un champ d'analyse devient » (`analyse_devient`) naît de la copie, jamais d'un balayage.**
  `save` rend la copie faite (ancienne et nouvelle valeurs, lues dans sa transaction), le job d'analyse la passe
  au point de sortie (`AnalyseTerminee`, un type à part de `StoredConversationAnalysis`, contrat de la poussée
  HubSpot), et le worker la met dans l'événement `analysis` avec toutes les valeurs. La config est UN filtre de
  dernière analyse (`{cle, op, valeur}`, relu par `lireFiltreFiche`, opérateurs bornés à `OPERATEURS_DEVIENT`) :
  il part quand la nouvelle copie le satisfait et l'ancienne non, une fiche jamais analysée ne satisfaisant rien.
  Un rejeu recopie la même analyse, donc ne fait rien naître ; une analyse plus ancienne que la copie n'écrit pas,
  donc non plus. Anti-rebond par défaut de 7 jours par contact (`antiRebondParDefaut`), la même garde
  anti-boucle que « conversation analysée » (au moins 3 600 s si on le règle). « Conversation analysée » filtre
  aussi sur tous les champs d'analyse (`filtres`, lus sur les valeurs de l'événement par `evaluerFiltreFiche`) ;
  `sentiment` et `unresolvedOnly` restent lus tels quels. ⚠️ Une analyse lance ses automations DANS le worker :
  un événement `analysis` qui passerait par la file `automation-event` y perd valeurs et copie, et n'y fait
  partir ni « devient » ni filtre. 🔴 **Retour arrière de l'API sous ce lot : éteindre d'abord les automations
  « conversation analysée » qui portent des `filtres`.** Une image plus ancienne ignore une automation
  `analyse_devient` (type inconnu, écarté par `toRow`), mais elle lit une « conversation analysée » filtrée
  comme si elle n'avait que son ressenti : « urgence au moins 7 » partirait à chaque analyse. ⚠️ Une transition
  manquée ne se rejoue pas : si l'anti-rebond, la condition ou un fil tenu empêchent le départ, l'analyse
  suivante voit l'ancienne copie égale à la nouvelle.
- 🔴 **`/v1/contacts` désigne une personne par sa FICHE, et UNE fonction la trouve** : `resoudreFiche`
  (`src/api/fiche.ts`). Quatre clés, `contactId`, `externalId`, `phone`, `bsuid` : toutes celles qu'on donne
  doivent désigner la même fiche (sinon `identity_conflict`, et la fiche n'est pas modifiée) ; une clé que la
  fiche ne porte pas encore lui est RATTACHÉE, jamais substituée, et le rattachement est tout ou rien (le
  `where` de `rattacherCles` et celui du `do update` de `creerFicheApi` gardent chaque clé demandée) ;
  `contactId` ne crée jamais rien. Elle rend une fiche, jamais une adresse : l'adresse d'envoi se calcule sur
  la fiche. `contacts.external_id` est unique PAR ESPACE (index partiel `contacts_tenant_external_id_uidx`), et
  la purge l'efface avec le numéro. 🔴 L'API ne fait naître ni champ ni étiquette (2026-09-26) : une clé de
  champ ou une étiquette inconnue de l'espace refuse la fiche AVANT la résolution (`champInconnu: 'refuser'`,
  `etiquettesInconnues`), donc « rien n'est écrit » n'a plus d'exception. ⚠️ `/v1/sends` (mode `phone`, `jamais` pour une ouverture de session), `/v1/messages/whatsapp` et `/v1/messages/rcs` (mode `jamais`) passent par cette même résolution ; les deux dernières rattachent une clé neuve même quand le message est ensuite refusé.
  ⚠️ Rattacher un numéro à une fiche qui n'avait qu'un BSUID change son adresse WhatsApp (`waIdOf` préfère
  le numéro).
- 🔴 **L'API écrit champs, étiquettes et nom par `editerFicheApi`, jamais par `applyEdits`** : une requête
  filtrée par `deleted_at is null`, sans transaction ni client dédié. Une fiche purgée entre la résolution et
  l'écriture n'est donc pas réécrite (`unknown_contact`), et un lot ne retient pas une connexion par élément.
  `applyEdits` (la fiche de la console) pose le même filtre sous son verrou : une fiche purgée y rend 404.
- 🔴 **La transition du consentement est écrite UNE fois : `src/crm/transition-consentement.ts`.** Les six
  écritures de `PgContactStore` qui posent `opt_in_status` (`upsertByPhoneReturningId`, `upsertManyByPhone`,
  `setOptInByWaId`, `ecrireConsentementParId`, `applyEdits`, `applyEditsMany`) composent ses fragments ; aucune
  n'écrit `opt_out_at` ni un `case` de consentement elle-même (gardé par `tests/optout-poussee.test.ts`). Trois
  règles : un statut inchangé ne réécrit RIEN (ni la date, ni la source, ni `updated_at` d'une écriture qui ne porte
  que le consentement) et ne s'annonce pas ; un STOP (`opted_out` vers `opted_in`) ne se lève que par une autorité
  de `LEVE_UN_STOP` ; `unknown` n'est jamais une destination. **Qui lève un STOP** : la fiche de la console
  (`fiche`), l'import CSV case cochée (`import_csv_coche`), la personne (mot STOP, formulaire coché : `personne`)
  et le bloc « Action » d'un scénario (`scenario`) ; **jamais** l'action en masse (`action_en_masse`, décision du
  2026-10-03), l'import sans case et HubSpot (`import`), le webhook entrant et la création à la main
  (`webhook_ou_saisie`), ni l'API publique (`api`, qui rend `refuse`). L'autorité est un type fermé, passée par
  l'appelant quand elle varie (`setOptInByWaId`, `LotContacts.autorite`) : un appelant qui l'oublie ne compile
  pas. La règle vit en TypeScript (`issueDeLaTransition`) et le SQL en est DÉPLIÉ (la liste des couples
  « statut d'avant, statut voulu » qui écrivent), jamais réécrit.
  🔴 `ecritureDuConsentement` est l'instruction des quatre écritures dédiées : l'état d'avant lu SOUS VERROU
  (`for update`, deux STOP simultanés n'annoncent qu'une fois), l'écriture gardée par le changement de statut et
  par l'espace (`espace`, le paramètre de l'appelant qui le porte : il laisse Postgres servir l'index d'espace sur
  une masse large), et pour chaque fiche `ecrite`, `passe` (passée à `opted_out`, à annoncer APRÈS le `commit`) et `garde` (STOP gardé),
  lus sur la copie verrouillée. L'action en masse prend le rendu `compte`, UNE ligne agrégée : elle rend
  `{ affected, stopsGardes }`, la route `set_optin` les renvoie et la console dit « N fiches ont gardé leur
  STOP » (en tolérant une réponse sans ce nombre). Un upsert ne demande jamais `opted_out` (types `ContactUpsert`
  et `LotContacts`) : il n'a rien à annoncer. Aucun chemin ne crée une fiche `opted_out`, et seuls ces types
  l'empêchent : la branche `insert` d'un upsert ne pose pas `opt_out_at`. L'API crée en `unknown`
  (`creerFicheApi`) puis écrit le consentement par la transition, qui pose la date et annonce le passage (décision
  de Julien du 2026-10-03 : un refus envoyé par l'API reste annoncé au système du client). La fiche de la console
  (`applyEdits`) rend `consentementChange`, et la route ne journalise `contact.optin` ou `contact.optout` que
  s'il est vrai. La table de cas : `tests/integration/transition-consentement.integration.test.ts`.
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
  destinataire est écarté `opted_out` et la fiche reste désabonnée. Qui lève un STOP : les autorités de
  `LEVE_UN_STOP` (plus haut), jamais l'API.
- 🔴 **Les upserts par numéro ne lèvent pas un STOP non plus** (2026-09-26), sauf l'import CSV case cochée.
  `upsertByPhoneReturningId` (webhook entrant, création à la main) et `upsertManyByPhone` (import HubSpot, import
  CSV) gardent, sur une fiche `opted_out`, le statut, `opt_out_at` ET `opt_in_source` (la source dit le canal du
  STOP au signal) ; le nom, les champs et les tags se mettent à jour quand même. La seule exception est un lot
  d'autorité `import_csv_coche`, que pose la route CSV quand la case opt-in est cochée (décision de Julien du
  2026-09-26 : c'est l'opérateur qui le demande, pour tout le fichier). Un upsert qui redit `opted_in` sur une fiche
  déjà `opted_in` garde la source d'origine. Le bloc « Action » d'un scénario (`setOptInByWaId`, autorité
  `scenario`) lève un STOP (décision de Julien du 2026-10-03).
- **Dans `/v1/contacts/batch`, les éléments d'une même personne s'écrivent DANS L'ORDRE** : deux éléments qui
  partagent une clé normalisée forment une chaîne séquentielle (`enChaines`, `src/api/contacts-v1.ts`), les
  chaînes partant par vagues bornées. En parallèle, le second pouvait se résoudre avant que le premier ait
  créé la fiche.
- 🔴 **Un appel de `/v1/contacts` est borné** (décision de Julien du 2026-09-26) : `MAX_BATCH` fiches par lot
  (`src/http/v1-contacts.ts`), `MAX_PAR_FICHE_EN_LOT` champs et étiquettes par fiche dans un lot, `MAX_PAR_FICHE`
  à l'unité et en `PATCH` (`src/api/contacts-upsert.ts`). Seule la taille du lot pèse sur la base : un lot tient
  l'UNIQUE place d'opération lourde du process. Le nombre de champs ne coûte rien (une fiche = une écriture), il
  borne un corps et le vocabulaire touché. Ces constantes sont les chiffres de la doc publique (`BORNES`, tenues
  égales par `tests/api-exemples.test.ts`), et c'est pourquoi aucune variable d'environnement ne les règle.
- 🔴 **`opted_out` et `unknown` ne veulent pas dire la même chose.** `optInAllows` exige un opt-in EXPLICITE
  pour une campagne **marketing** : un contact `unknown` est donc écarté **en silence**, seul `utility` passe.
  La saisie manuelle et l'import CSV créent en opt-in par défaut ; l'import HubSpot aussi, depuis le
  2026-08-15 (source `hubspot_list` : le consentement est géré dans HubSpot, qui en porte la preuve), sauf sur
  une fiche qui a dit STOP (cf. plus haut). L'API publique crée en `unknown`, sauf `consent` explicite, et sait
  écrire `opted_out` comme `opted_in` (jamais lever un STOP, cf. plus haut).
- 🔴 **Un seul geste de destruction.** `POST /contacts/purge` exige `confirm: 'SUPPRIMER'`. Il EFFACE ce qui
  identifie (conversation, messages, analyse, parcours, déclenchements, cache RCS) et ANONYMISE ce qui porte
  le quantitatif : le numéro devient `anon:<uuid>` ALÉATOIRE, pas une empreinte, qui serait réversible sur un
  espace de numéros français. Les totaux d'envoi et de livraison restent donc justes.
  Sur la fiche, elle vide aussi ce qui DÉCRIT la personne (étiquettes, risque, langue détectée, joignabilité
  WhatsApp, source du consentement, auteur du blocage) et GARDE ce qui dit NON (statut d'opt-in et sa date,
  STOP RCS, date du blocage) : sans numéro, un refus n'identifie personne, et l'effacer est la seule des deux
  erreurs qui ne se rattrape pas. La course avec un run de campagne en cours (il tient le vrai numéro en
  mémoire) est fermée ailleurs : `claim` écarte d'abord une fiche purgée (`anonymized_at`, motif `efface`), et
  les balayages de relance et de bascule ne reprennent plus une ligne purgée (`to_e164 = 'anonyme'`, que la
  purge écrit), qui garde son statut pour les totaux.
  🔴 **Toute colonne ajoutée à `contacts` décide son sort dans l'`update` de `purgeMany`**, où chaque colonne
  porte sa raison ; et un écrivain qui vise une fiche par son identifiant filtre `deleted_at is null`
  (l'identifiant survit à la purge, dans `campaign_recipients.contact_id` entre autres).
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
  des chemins d'exécution : l'entrée des lancements (`src/workflow/lancements.ts`), pour le seul type dont la
  politique joue le brouillon (`lien_de_test`, `graphe: 'brouillon_fige'`) ; tous les autres types jouent
  `wf.graph`. `tests/workflow-lancements.test.ts` exécute la colonne type par type, et l'inventaire de
  `tests/workflow-graphe-fige.test.ts` tient le reste de `src/`.

**Conversations**

- `conversations` (`control_owner`, `assigned_to`, `archived_at`, `traitee_le`, `last_direction`,
  `escaladee_le`), `conversation_messages` (`media_id`, `media_mime`, `media_nom`), `conversation_evenements`
  (migration 0192, le journal que lit le panneau Détail de l'Inbox).
- 🔴 **LE JOURNAL DES ÉVÉNEMENTS D'UNE CONVERSATION** (`conversation_evenements`, `src/inbox/evenements.ts`) :
  assignée, désassignée, prise à l'agent de Meta, rendue à l'agent, passée à l'équipe par l'agent, traitée,
  archivée, signalée et leurs inverses, rouverte par un message du contact. Lu par
  `GET /tenants/:tenantId/conversations/:conversationId/detail` (`PgInboxStore.detailConversation`), les 50
  derniers, sous la visibilité de `src/inbox/assignment.ts` (`visibiliteSql`) : un agent ne lit que les siennes
  et le pot commun, sinon 404. Deux règles d'écriture, tenues par `PgInboxStore` et par lui seul :
  - **l'événement s'écrit DANS la requête du changement** (une CTE), jamais dans une seconde : deux écritures
    laisseraient une fenêtre où l'un existe sans l'autre. `tests/inbox-evenements.test.ts` compte, dans chaque
    écriture, autant d'`insert into conversation_evenements` que de requêtes ;
  - **seulement si la valeur a VRAIMENT changé** : l'état d'avant est lu dans un sous-select verrouillé
    (`for no key update`, le verrou que l'`update` prend lui-même ; `for update` bloquait aussi les insertions
    filles, message ou événement, dont la clé étrangère pose `for key share`), ou, pour un upsert, dans
    l'instantané de la requête. Réassigner au même, archiver
    l'archivée, libérer une libre n'écrivent rien. Sur le chemin de chaque message reçu, `rouverte` ne s'écrit
    que si `archived_at` ou `traitee_le` était posé avant et ne l'est plus : un message ordinaire n'écrit rien,
    une réaction sur une conversation seulement traitée non plus (elle ne retire pas ce statut), une réaction
    sur une conversation archivée écrit `rouverte` (elle la sort d'Archivé).
  ⚠️ **Une ligne porte un acteur OU une cause.** Les écritures reçoivent un `AuteurDuChangement` REQUIS
  (`{ collaborateur }` ou `{ cause }`) : les gestes de la console passent la session, les chemins automatiques
  leur cause (« automatique : campagne Rentrée », « automatique : scénario Bienvenue », celles de `CAUSES` dans
  `src/inbox/fil.ts`). Un acteur nul SANS cause est donc un collaborateur supprimé depuis (`on delete set null`),
  que l'écran dit « ancien collaborateur ». Un identifiant qui n'est pas un uuid (clé d'API, observation /ops,
  session sans identifiant) devient nul AVANT la base (`colonnesAuteur`), sans quoi le changement lui-même
  échouerait, et porte alors une CAUSE (`CAUSE_CLE_API`, `CAUSE_HORS_COMPTE`) : sans elle, une clé d'API se lisait
  « ancien collaborateur ». ⚠️ Les lignes écrites entre le déploiement de 0192 et ce correctif par une telle
  identité n'ont ni acteur ni cause : elles restent lues « ancien collaborateur ».
  ⚠️ La lecture (`detailConversation`) ne nomme que des collaborateurs DE L'ESPACE (`users.tenant_id =
  e.tenant_id`, pour l'acteur, la cible et l'assigné) : un identifiant qu'elle n'y retrouve pas se lit « ancien
  collaborateur ». Une assignation dont l'acteur est la cible est marquée `prise`, que l'écran dit « Prise en
  charge ».
  ⚠️ Côté détenteur du fil, s'écrit ce qui touche l'agent de Meta (`prise_mba`, `rendue_mba`, `passee_par_mba`)
  et, depuis 0194, les deux bornes d'une demande du Quantitatif > Performance : `escaladee` quand un geste qui
  ouvre une demande (`EcritureDuFil.ouvreUneDemande`, posé par `passerAUnHumain` et `prendrePourLEquipe`, et par
  eux seuls) fait passer un fil d'un robot (`app_workflow` ou `mba`) à l'équipe, drapeau d'escalade ou non, avec
  une cause qui nomme le scénario, l'agent IA ou la campagne (portée par l'appelant, qui l'exige) ; et
  `rendue_scenario` quand un fil `app_human` repasse à `app_workflow`. `escaladee` s'écrit aussi SANS bascule
  (`PgInboxStore.ouvrirUneDemande`, cause `CAUSE_REOUVERTURE`) quand un client rouvre une conversation « Traité » ou
  archivée que l'équipe tient encore, avant son délai de reprise (`ControleDuFil.remettreSiPersonneNeSuit`) : c'est
  une nouvelle demande pour elle, qui pose AUSSI la marque collante `escaladee_le`, dans la même requête que
  l'événement : le client attend l'équipe, et le délai ne la lui reprend plus tant que personne n'a répondu
  (décision du 2026-10-01). Le drapeau `escalade` d'une bascule, lui, ne pose que la marque, jamais l'événement. Un opérateur qui prend le fil en écrivant, et l'état d'attente
  d'une fin de parcours, n'écrivent rien. Les branches de l'agent de Meta passent AVANT `rendue_scenario` : un fil
  qui quitte `mba` reste `prise_mba`, et s'il va à l'équipe par un geste qui ouvre une demande, il écrit la prise
  PUIS `escaladee`. Une escalade qui sort la conversation d'Archivé ou de Traité le dit aussi (`desarchivee`,
  `non_traitee`, avec sa cause). Le type se lit sur
  les colonnes (le fil quitte `mba` : prise ; il y va : rendu), SAUF quand l'écriture le dit
  (`EcritureDuFil.rendAgentDeMeta`) : « Rendre la main » sur un fil que notre colonne croit déjà `mba` écrit
  `app_workflow`, et les colonnes y liraient une prise. La rétention est
  celle de la conversation (`on delete cascade`). La migration amorce le journal depuis l'état réel (cause
  `CAUSE_AMORCAGE`), une ligne par fait daté.
  ⚠️ **L'en-tête de la migration 0192 est inexact sur deux points** (relecture du 2026-09-29 ; le fichier est
  appliqué et ne se corrige pas, la vérité est ici) : l'amorçage lit `conversations` CINQ fois (une par branche de
  son `union all`), pas une ; et sa clé étrangère vers `tenants` pose, elle aussi, son verrou pendant la
  transaction. L'amorçage a recopié `assigned_by` et `signalee_par` sans filtrer l'espace : c'est pourquoi la
  lecture le filtre. ⚠️ Même chose pour l'en-tête de 0194, qui dit `escaladee` écrit « drapeau d'escalade posé » :
  vrai à son écriture, faux depuis le 2026-09-29, où c'est `ouvreUneDemande` qui décide (ci-dessus).
- 🔴 **LES DEMANDES DU QUANTITATIF > PERFORMANCE** (`GET /tenants/:tenantId/stats/performance`, garde admin et
  période des autres statistiques). Elles ne sont PAS stockées : `PgPerformanceStore.lire`
  (`src/stats/performance.pg.ts`) les reconstruit du journal, et `calculerPerformance` (`src/stats/performance.ts`)
  en tire les durées. Une durée stockée deviendrait fausse le jour où l'espace change ses horaires.
  - **Ouverture** : `escaladee` ou `passee_par_mba`, seulement si rien n'était ouvert, c'est-à-dire si l'événement
    d'ouverture ou de fin qui précède sur la conversation (`lag`) est une fin, ou s'il n'y en a pas. Deux passages
    sans fin entre eux font UNE demande. Un client qui rouvre une conversation « Traité » de l'équipe écrit un
    `escaladee` après le `traitee` qui a clos la précédente : la lecture en fait une nouvelle demande, sans rien
    savoir de plus, et son début est ce message du client.
  - 🔴 **Début** (le chrono part quand le CLIENT a écrit) : l'ouverture si, à cet instant, le dernier message
    significatif de la conversation est entrant ; sinon le premier message entrant qui suit l'ouverture et précède
    la fin. Significatif (`MESSAGE_SIGNIFICATIF_SQL`) : un entrant, un modèle sortant (`type = 'template'`), ou un
    sortant `origin = 'humain'` ; les autres messages d'un robot (scénario, agent IA, agent de Meta) ne rendent pas
    la balle au client. Sans entrant, la demande n'a jamais commencé et n'est comptée NULLE PART : une campagne
    « modèle puis passer à un humain » n'en compte que pour les destinataires qui répondent, datées de leur
    réponse. La période et le jour (Paris, `STATS_TZ`) se lisent sur le début : sa réponse et sa fin peuvent tomber
    après la période.
  - **Fin** : le premier `traitee`, `archivee`, `rendue_mba` ou `rendue_scenario` qui suit l'ouverture. Son auteur
    est l'acteur de l'événement ; nul AVEC une cause, c'est « automatique » (un geste sans auteur connu : délai de
    reprise, scénario qui reprend la conversation, y compris lancé depuis l'Inbox, clé d'API) ; nul SANS cause, ou
    introuvable dans l'espace, c'est un ancien collaborateur (la règle du journal, ci-dessus).
  - **Réponse** : le premier message `direction = 'out'` et `origin = 'humain'` (écrit dans l'Inbox, texte, modèle
    ou RCS) entre le début et la fin, attribué à son `sender_user_id`. Ni l'API, ni un assistant MCP, ni une
    campagne, ni un robot. La lecture rend aussi la DERNIÈRE réponse avant la fin.
  - **Durées** : en heures d'ouverture de l'espace (`tempsOuvre`, `src/lib/heures-ouvrees.ts` : jours civils du
    fuseau, ouvertures murales converties en instants, donc juste au changement d'heure). Un espace sans aucun
    créneau exploitable (`horairesExploitables`) est compté en temps brut, et la réponse le dit (`mode: 'brut'`).
    Les horaires lus sont ceux de `settingsStore.get`, défauts du serveur compris : ceux que l'écran Paramètres
    montre. Médiane et 90e centile en TypeScript, par interpolation (`percentile_cont`), `null` sans mesure.
  - 🔴 **Une fin automatique après une réponse s'arrête à la dernière réponse.** Le balayage ne rend jamais un fil
    dont l'escalade attend sa première réponse ; cette réponse efface la marque, et le balayage rend ensuite le fil
    au robot au bout du délai de reprise de l'espace (deux heures par défaut) compté depuis la DERNIÈRE réponse
    humaine, faute de « Traité ». Pour une demande close par un geste automatique et répondue, la résolution
    s'arrête donc à la dernière réponse avant la fin, sans quoi elle mesurerait le minuteur ; elle reste résolue.
  - ⚠️ **Les résolues SANS réponse sont une catégorie à part, hors du temps de résolution** : une demande close
    sans qu'aucun collaborateur ait répondu (archivée, marquée Traité, reprise par un scénario, ou rendue par le
    balayage quand le passage n'a pas posé de marque d'escalade) n'a pas de travail de l'équipe à mesurer.
  - **Par collaborateur** : la réponse va à celui qui a répondu le premier ; « demandes closes » compte TOUTES
    celles qu'il a closes, avec ou sans réponse, et la médiane de résolution ne porte que sur celles qui ont eu une
    réponse.
  - ⚠️ **« Encore ouvertes » et la plus ancienne portent sur TOUTES les demandes ouvertes en ce moment**, depuis le
    début de la mesure et quelle que soit la période : la lecture les rend en plus de celles de la période
    (`dansLaPeriode` à faux). Les autres compteurs sont ceux de la période, dont les demandes se partagent entre
    résolues, résolues sans réponse et encore ouvertes.
  - **Écriture des durées** (`fmtDuree`, `web/lib/performance.ts`) : en heures d'ouverture, jamais de jours (« 45 h
    12 ») ; un jour y vaudrait 24 heures ouvrées. En temps brut, les jours s'écrivent.
  - ⚠️ **La mesure démarre à l'application de 0194**, lue dans `public.schema_migrations`
    (`MIGRATION_DES_DEMANDES`) : avant elle, ni le passage d'un scénario ni le retour au scénario n'étaient datés,
    donc une demande de l'agent de Meta d'avant 0194 pouvait n'avoir jamais de fin. Aucune ouverture antérieure
    n'est comptée, et l'écran dit « mesuré depuis le ... ».
  - ⚠️ Le journal n'a d'index que par conversation : la lecture filtre l'espace sur `conversations` et sur le
    journal, puis descend par conversation, et relit tous les événements depuis le début de la mesure (les encore
    ouvertes n'ont pas de borne de date). Le début, qui coûte deux lectures de messages, n'est calculé que pour les
    demandes encore ouvertes ou qui peuvent commencer dans la période. À surveiller le jour où un espace porte des
    dizaines de milliers d'événements (`todo.md`).
- 🔴 **UNE ESCALADE EST « À TRAITER » TOUT DE SUITE** (`escaladee_le`, migration 0164), et TROIS chemins la
  posent : l'agent de Meta qui nous passe le fil (`control_passed`), le bloc « passer à un humain » d'un
  scénario, et l'escalade d'un agent IA (une demande ouverte sans bascule la pose aussi, `ouvrirUneDemande`,
  ci-dessus). Les trois font la même promesse au client, et souffraient du même
  défaut : leur dernière phrase est SORTANTE, donc la conversation n'entrait dans le dossier qu'au message
  suivant du client. Elle devient `app_human`, entre dans le dossier même si la dernière phrase est sortante,
  et sort d'« Archivé » et de « Traité ». Elle y reste jusqu'à ce que quelqu'un agisse : la PREMIÈRE réponse
  d'un opérateur, « Traité », « Archiver » ou le bouton « Rendre la main » la clôt, et le balayage de reprise
  ne rend JAMAIS un fil escaladé à l'agent (arbitrage de Julien : on ne le lui rend qu'après une réponse
  humaine, puis les 2 h habituelles).
  🔴 **Tout geste où un ROBOT reprend le fil la clôt aussi** (arbitrage de Julien du 2026-09-27) : l'agent de
  Meta à qui on rend le fil (accusé du dernier envoi, client que personne ne suit, fin de parcours dès son état
  d'attente) et un scénario lancé délibérément. Sans ça, la conversation restait dans « À traiter » pendant que
  l'agent répondait, ou collée pour toujours quand Meta refusait la remise (le balayage l'excluait).
  ⚠️ Un `standby` de Meta postérieur à l'escalade fait exception : il prouve que l'agent a repris le fil, et la
  clôt.
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
- 🔴 **`control_owner` NE S'ÉCRIT QUE DANS `src/inbox/fil.ts`** (`creerControleDuFil`, construit une fois par
  processus dans le socle). Chaque geste y a son nom (un humain écrit, « Reprendre la main », « Rendre la main »,
  fin de parcours, remise sur accusé, client que personne ne suit, reprise pour un scénario, réponse de campagne
  « Inbox », passage à un humain, passation de l'agent de Meta, entrant `standby`, balayage), et le module porte
  seul ce que chacun faisait à sa façon : **Meta d'abord, la colonne ensuite, rien d'écrit sur un refus** (deux
  exceptions : l'état d'attente `app_human` d'une fin de parcours, posé avant la remise ; la marque d'accusé,
  consommée avant l'appel), un **rejeu** pour toute reprise (le retrait de la liste), jamais pour une remise,
  et la **marque d'escalade**. `tests/fil.test.ts` exécute la table contre un faux Meta, un dépôt et une liste en
  mémoire, refuse tout autre appelant de l'écriture ou du `release`, tout autre appelant de la liste que
  `src/mba/liste.ts`, et toute trace de `take`. Trois règles qui y vivent :
  - **agent de Meta allumé, aucun numéro connecté : la colonne ne bouge pas vers l'agent**, quelle que soit la
    porte (balayage, fin de parcours, client qui revient, bouton, qui répond alors 409) ;
  - **un démarrage que le CLIENT déclenche ne prend pas le fil à un opérateur** (`saufOperateur` : l'automation
    d'une publicité, le routage d'un lead, le scénario d'un widget ; la réponse de campagne « Inbox » laisse un fil d'opérateur tel quel) ;
    les lancements EXPLICITES (campagne, Inbox, lien de chaîne, `/v1/sends`, jeton de test, relais de l'agent de
    Meta) le prennent, opérateur compris.
    ⚠️ La garde lit NOTRE colonne, que `processInbound` corrige d'abord. Un lead arrivé en `standby` y fait écrire
    `mba` (`entrantEnStandby` : Meta fait autorité) dès que la conversation n'est pas escaladée, ou que le
    `standby` est daté après l'escalade ; le routage voit alors un fil de l'agent de Meta et le reprend pour le
    scénario de la publicité, comme le scénario d'un widget le reprend pour le sien. Elle ne protège donc un opérateur que là où notre colonne le dit encore maître du
    fil : un entrant `messages` (le cas mesuré de tous les entrants), ou un `standby` antérieur à une escalade ou
    non daté ;
  - **la réponse à une campagne « Inbox » prend le fil pour l'ÉQUIPE** (`app_human`) : la remise « personne ne
    suit » du même job le voit et s'abstient, aucune automation ne démarre (`app_workflow` seul le permet).
    🔴 **À la PREMIÈRE réponse seulement, et à la campagne la PLUS RÉCENTE** (relecture du lot 4,
    `PgCampaignRepo.campagneAssignanteDuContact`). La requête choisit d'abord la dernière campagne servie au
    contact, puis regarde si elle porte un devenir ou une affectation : une campagne plus récente qui ne décide
    de rien masque une ancienne campagne « Inbox ». Et elle rend `premiereReponse` (au plus un entrant depuis
    `sent_at`, celui qu'on traite), sans lequel `assignerReponse` ne prend pas le fil. Sans ces deux règles, une
    campagne « Inbox » SANS affectation, qui ne pose jamais `assigned_to`, reprenait le fil à chaque message du
    contact, pour toujours : elle défaisait un « Rendre la main » et figeait le scénario d'une campagne envoyée
    depuis. L'affectation, elle, garde sa seule borne `assigned_to is null`.
  ⚠️ Un entrant `standby` est corrigé AVANT l'affectation dans `processInbound` (relecture du lot 4) : dans l'ordre
  inverse, une première réponse de campagne « Inbox » arrivée en `standby` était prise pour l'équipe, puis réécrite
  `mba` par ce même `standby`, alors que Meta venait de nous céder le fil ; la prise n'ayant lieu qu'une fois, rien
  ne la refaisait.
- 🔴 **L'AGENT DE META EST TOUJOURS EN MODE LISTE, ET C'EST LA PLATEFORME QUI TIENT LA LISTE** (mesuré le
  2026-09-29). Un contact absent de la liste n'entend jamais l'agent, même quand Meta lui a rendu le fil : c'est
  le seul interrupteur par contact que Meta nous donne. L'action `take` de `thread_control` ne nous rendait rien
  (200 sans effet, ou la phrase de passation de l'agent au client) : elle n'existe plus. Deux gestes, dans
  `src/inbox/fil.ts`, sur `src/mba/liste.ts` :
  - **confier** = ajouter le contact à la liste (Meta en E.164, PUIS la ligne de `mba_liste` avec l'identifiant
    rendu, l'ajout défait si la ligne échoue ; un contact déjà dans notre table ne coûte aucun appel ; le 400
    sans code que Meta rend sur un doublon se résout par UNE relecture), puis `release`. Agent éteint, aucun
    numéro, ou fil de test sur un chemin automatique (seules les conversations marquées avant le 2026-10-03 le
    sont : le lien de test ne marque plus rien) : rien. 🔴 Un `release` refusé APRÈS la liste n'est pas une
    erreur : c'est la liste qui décide si l'agent parle, et Meta refuse le `release` quand son agent tient déjà
    le fil, ce qui arrive après tout modèle (essai réel du 2026-09-30). Il est journalisé et le contact est
    confié ; si nous tenions en fait le fil, le prochain message arrive chez nous et la remise le rejoue ;
  - **reprendre** = retirer le contact (Meta, avec le numéro et l'identifiant gardés, PUIS la ligne ; un 404
    vaut retrait ; un rejeu sur une erreur rejouable, jamais deux ; absent de la table, aucun appel). 🔴 Il ne
    dépend pas de l'allumage de l'agent : une ligne présente se retire même agent éteint, sinon l'agent
    répondrait à ce contact le jour où on le rallume. `false` = refus de Meta, et chaque appelant garde son
    comportement de refus (409 dans l'Inbox, démarrage de scénario annulé avec le motif « le contact n'a pas pu
    être retiré de la liste de l'agent de Meta », lead `reprise_refusee`). Une panne de `mba_liste` LÈVE, elle
    n'est jamais rendue comme un refus : le job ou la requête échoue et se rejoue.
  Toute écriture des réglages porte `ai_audience: ALLOWLISTED_ONLY` (`modifierSettings`, `src/mba/client.ts`),
  et l'allumage suit l'ordre de Meta : l'audience, une relecture, puis `rollout.enabled` (`ecrireRollout`). Une
  relecture qui ne rend pas encore la liste est refaite UNE fois après `RELECTURE_AUDIENCE_ATTENTE_MS` (Meta
  peut propager avec retard) ; toujours pas, on n'allume pas. 🔴 Les trois chemins d'allumage écrivent ensuite
  notre drapeau `tenant_settings.mba_enabled`, que toute la mécanique de la liste lit : `mba-activation`
  (l'Accueil), `rollout` (l'onglet Aperçu) et la mise en service de l'assistant. Le PATCH des réglages refuse
  `aiAudience` (400), et la liste n'a plus de route : une entrée posée à la main échapperait à notre table.
- 🔴 **AUCUN MODÈLE NE PART VERS UN CONTACT DE LA LISTE** : `MetaClientFactory.clientForTenant`, par où passent
  tous les envois, enveloppe `sendTemplate` et `sendMarketing` d'un retrait préalable (`listeDeLAgent`, requise
  comme `numerosDelies`). Un modèle rend la conversation à l'agent chez Meta : sur la liste, l'agent répondrait
  à la réponse du contact à la place du scénario. Retrait refusé : le modèle ne part pas
  (`RetraitDeLaListeRefuse`, une `MetaApiError` 503 que `classify` range en rejouable et qui n'est jamais un
  plafond du numéro ; la campagne marque le destinataire en échec avec ce motif, l'Inbox l'affiche, le scénario
  suit son chemin d'échec d'envoi). Le retrait cherche la ligne sous les deux formes du numéro
  (`formesDuNumero`) : le modèle part vers le numéro de la fiche, la ligne porte le `wa_id` du webhook, et les deux
  diffèrent pour un mobile brésilien d'avant le 9 ou un mobile mexicain (`521`). Coût : une lecture par modèle, un
  appel à Meta pour les seuls contacts de la liste. Un message libre ne retire rien : il nous donne la conversation.
- 🔴 **UN MESSAGE QUE PERSONNE NE PREND EST CONFIÉ À L'AGENT, QUI Y RÉPOND TOUT DE SUITE**
  (`remettreSiPersonneNeSuit`) : après ses gardes (agent allumé, aucun parcours en attente, pas d'opérateur dans son
  délai de reprise, ci-dessous),
  confier, écrire `mba`, puis `agent_event` `message_sans_suite` avec le texte reçu (`src/mba/evenement.ts` ; le
  corps enregistré, donc `[audio]` pour un vocal, dont la transcription ne se fait qu'à la demande).
  Plusieurs messages du même contact dans un lot : un seul geste, textes bout à bout, dans la borne de 4 096
  caractères (`processRemiseMbaEntrant` ; `rendreLesFilsSansReponse` fait de même pour les leads). 🔴 Si confier
  échoue, aucun événement, et la conversation passe à l'équipe (`app_human`, cause « l'agent de Meta n'a pas pu
  prendre la conversation ») : laissée `app_workflow`, elle sortait d'« À traiter » sans réponse, cas
  systématique d'un identifiant qui n'est pas un numéro. Sur une conversation DÉJÀ confiée (sur la liste et
  `mba`), l'événement ne part que si Meta vient d'accepter le `release` : nous tenions donc le fil et l'agent n'a
  pas vu ce message. Refusé, son agent tient déjà le fil : c'est la réponse « à côté » d'un scénario, transmise
  par la fin du parcours dans le même lot, et un second événement ferait répondre l'agent deux fois. Un
  événement refusé est journalisé, la colonne reste `mba`. « Rendre la main », la fin de parcours et le balayage
  confient SANS événement : l'agent parle au prochain message du client.
- ⚠️ **LA PURGE RGPD RETIRE AUSSI LE CONTACT DE LA LISTE** : `purgeMany` supprime sa ligne de `mba_liste` dans
  sa transaction et la rend, et la route retire l'entrée chez Meta APRÈS avoir répondu (au mieux, journalisé,
  suivi par `TravauxEnVol` pour que l'arrêt de la copie l'attende) : un appel à un tiers ne se fait pas dans une
  transaction qu'il retiendrait, et une grosse purge attendant Meta dépasserait le délai de Cloudflare.
- ⚠️ `on delete set null` sur l'affectataire : supprimer un membre LIBÈRE ses conversations. Une conversation
  que plus personne ne peut prendre serait invisible et sans réponse.
- ⚠️ `control_changed_at` se rafraîchit à CHAQUE réponse humaine sur un fil `app_human`
  (`PgInboxStore.recordOutbound`) et à chaque « Traité » posé sur un tel fil (`basculerRangement`, dans la même
  requête ; le retirer et archiver n'y touchent pas) : le compte à rebours de reprise court depuis le plus tardif
  des deux. Reposer le même détenteur, lui, ne le rafraîchit pas (`setControlOwner` n'écrit rien), et « Traité » ne
  rend pas la main.
- 🔴 **LE DÉLAI DE REPRISE EST UNE SEULE RÈGLE, À DEUX LECTEURS** (`repriseDue`, `src/inbox/delai-reprise.ts`) : le
  balayage (`runControlSweep`) et la remise « personne ne suit ». Une escalade sans réponse n'est jamais échue, un
  délai absent ou nul garde la main, un fil non daté est échu. Le délai de l'espace
  (`tenant_settings.control_handback_seconds`) prime sur `CONTROL_HUMAN_TIMEOUT_MS`. La fenêtre de service n'en fait
  pas partie : le balayage saute une fenêtre fermée, la remise part d'un message du client, qui vient de l'ouvrir.
  Délai échu, un client qui écrit dans un fil `app_human` est donc confié TOUT DE SUITE à l'agent de Meta (s'il est
  allumé), qui répond à ce message ; l'écriture de `mba` ne prend que depuis `app_human` et sans escalade venue
  entre-temps (`only`, `saufEscalade`), sous la cause « le contact réécrit après le délai de reprise ». Avant le
  délai (ou délai à 0, ou agent éteint), le fil reste à l'équipe, et si CE message vient de rouvrir la conversation
  (`recordInbound` rend `rouverte`, `processInbound` le garde par message, le job le passe à la remise, sans relecture
  qui ferait une course), une demande s'ouvre pour elle, avec l'escalade (`escaladee`, ci-dessus) : passé le délai,
  elle reste à l'équipe tant que personne n'a répondu. Une réaction n'en ouvre pas.
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

**Publicités**

- `pubs_brouillons` : un FORMULAIRE mémorisé, jamais une publicité (aucun identifiant Meta, aucune dépense).
  Le visuel est une image (`visuel_octets`, `bytea`, que seule la lecture d'UN brouillon sélectionne) OU une
  vidéo, dont seul l'identifiant chez Meta est gardé (`video_id`, migration 0187), jamais les octets.
  🔴 **Un seul visuel à la fois** : `PgBrouillonsPubStore.mettreAJour` efface l'un quand l'autre est POSÉ (non
  nul), et le CHECK `pubs_brouillons_un_visuel_chk` en est la ceinture. `audiences_incluses` et
  `audiences_exclues` sont des `text[]` d'identifiants Meta, vides par défaut, relus chez Meta à la création.
  Une clé absente du corps veut dire « ne pas toucher », pour l'image, la vidéo et les audiences : un écran qui
  ne les connaît pas ne les efface pas en enregistrant.
- 🔴 **Une vidéo ne s'arrête jamais chez nous.** Elle est déposée chez Meta dès qu'elle est choisie, en trois
  gestes (`POST /pubs/videos` ouvre et rend le premier morceau que Meta attend, `POST
  /pubs/videos/:session/morceaux?debut=&fin=` relaie chaque morceau, `POST /pubs/videos/:session/fin` clôt).
  Le NAVIGATEUR découpe le fichier comme Meta le demande : un seul envoi de 100 Mo buterait sur les plafonds de
  Cloudflare (taille d'une requête, délai de réponse). Chaque morceau traverse l'API EN FLUX : le parseur
  `application/octet-stream` ne lit rien (il tourne avant les gardes), le gestionnaire lit la tête du morceau
  (signature `ftyp`, durée si `moov` est au début, `src/pubs/video.ts`), puis `transfererMorceauVideo`
  (`src/meta/pubs-creation.ts`) relaie le reste dans un corps multipart construit en flux, à longueur exacte.
  La taille des morceaux est décidée par Meta et non documentée : on relaie ce qu'il demande.
- 🔴 **La créa ne part que sur une vidéo `ready`.** `creerLaPublicite` (`src/pubs/creation.ts`) relit, AVANT la
  campagne, l'état de la vidéo et celui de chaque audience demandée (`delivery_status` 200) : un refus y est
  `refusee` (409), rien n'a été créé. La vignette de la créa est l'image PRÉFÉRÉE de Meta, rapatriée (sans le
  jeton, HTTPS seulement, bornée, signature vérifiée) puis redéposée par `adimages` : on ne cite jamais une
  adresse de son CDN. Le rattrapage est celui de l'image : tout créé en pause, campagne supprimée sur échec.
- 🔴 **Advantage+ audience est explicite** (`ciblage`, `src/meta/pubs-payloads.ts`) : `targeting_automation.
  advantage_audience = 1` sur tout ensemble, sinon Meta l'active en silence depuis v23. Il impose un âge minimum
  entre 18 et 25 ans et un maximum à 65, que la route refuse avec des mots et que `ciblage` refuse encore en
  levant. Les audiences incluses deviennent des suggestions ; les exclusions restent fermes.
- ⚠️ **Non documenté chez Meta, isolé à un endroit** : le lien WhatsApp d'une créa vidéo, posé dans
  `call_to_action.value.link` (`VALEUR_BOUTON_VIDEO`), faute de champ `link` dans `video_data`. La première
  création réelle tranche.

**Widgets**

- `widgets` (0200) : une ligne par bulle. 🔴 **Le `code` est une porte à SENS UNIQUE** : il est dans l'adresse du
  script collé sur le site du client (`/widget/<code>.js`), aucun `update` ne le réécrit, et il donne aussi
  l'étiquette de source. `devenir` vaut `agent`, `mba`, `scenario` ou `null` (le réglage de l'espace), avec des
  CHECK à SENS UNIQUE sur `agent_id` et `workflow_id`, écrits `coalesce(devenir = 'x', false)` parce qu'un CHECK qui
  vaut NULL est satisfait. Les deux clés étrangères sont en `on delete set null` : un scénario supprimé rend le
  widget INERTE sans le détruire. `widgets_phrase_key` rend la phrase unique par espace, à la casse et aux espaces
  près.
- `widget_tirs` (0201) : l'anti-rebond et le plafond horaire du scénario d'un widget, clé `(widget_id, wa_id)`. Il
  porte un numéro : 🔴 la purge RGPD l'efface par TOUS les numéros de la personne, ceux de ses fils ET celui de sa
  fiche, parce que la rétention efface les fils et garde la fiche.
- 🔴 **Un seul point de passage pour écrire : `src/widgets/gestion.ts`**, appelé par la route de la console
  (`src/http/widgets.ts`, réservée aux admins, lecture comprise) ET par les outils MCP (`create_widget`,
  `update_widget`, `list_widgets`, `list_scenarios`). Ses contrôles, que la base ne fait pas : cinq widgets au plus
  par espace ; le scénario désigné appartient au MÊME espace (sinon fuite entre espaces) et, quand la requête le
  choisit, a une version publiée ; le devenir `agent` est refusé ; et la phrase. L'espace des phrases d'un espace
  est **widgets UNION liens de chaîne**, comparés par INCLUSION dans les deux sens après normalisation et
  ponctuation finale retirée (`src/widgets/phrases.ts`, partagé avec la création d'un lien de chaîne). Une phrase
  déjà vue dans des messages reçus est refusée, les arrivées par un widget n'y comptant pas. Une phrase qui
  COMMENCE par un mot d'arrêt est refusée, sinon `estDemandeArret` désabonnerait chaque visiteur avant l'étape du
  widget ; même règle pour un lien de chaîne.

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
contente de 60 bits parce qu'il doit tenir dans l'URL d'un bouton WhatsApp. Le code d'un widget a la même forme
que celui d'un lien tracé : il ne donne aucun accès, il désigne une bulle publique, et il ne change jamais (bloc
« Widgets » plus haut).

### Le schéma `salesforce` (l'app Salesforce)

L'app Salesforce (spec et plan du 2026-09-26) range ses données dans un schéma À PART, `salesforce` (migration
0183), le premier que ce dépôt crée. Trois règles le rendent extractible vers sa propre base le jour où des
clients réels le justifient :

- 🔴 **un seul fichier le lit et l'écrit**, `src/salesforce/store.pg.ts`, et ce fichier ne nomme aucune table de
  `public` ; aucun autre fichier ne nomme une table `salesforce.*`. Tenu par `tests/salesforce-isolation.test.ts` ;
- **aucune clé étrangère vers `public`**, aucun `search_path` (tables toujours qualifiées) : tenu par
  `tests/salesforce-migration.test.ts`. Conséquence : supprimer un espace n'emporte pas sa ligne ;
- **le store reçoit son pool par le constructeur** : c'est la couture. Le jour de l'extraction, il faudra en plus
  un `pg_dump --schema=salesforce`, un moyen de migrer l'autre base (le runner n'applique que `DATABASE_URL`) et
  une connexion chiffrée propre : ce n'est PAS une simple variable.

`tenant_id = $1` sur chaque requête, sauf DEUX lectures transverses comptées par le test : `orgParIdentifiant`
(l'org qui signe un appel entrant DONNE l'espace) et `espacesConnectes` (le cache de l'émetteur de signaux).
Le secret qui signe les appels d'une org est chiffré DANS le store (`ENCRYPTION_KEY`) ; `lire` ne le
sélectionne pas. L'interrupteur de l'espace, lui, vit dans le coeur (`tenant_settings.salesforce_actif`), parce
que `salesforce.orgs` n'a pas de ligne avant la connexion.

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
`pollingIntervalSeconds` reste le repli automatique si l'écouteur meurt. Seule `webhook` a un filet court
(`FILETS_NOTIFIES`, 5 s), la ceinture du vidage continu ci-dessous ; `agent-turn` garde 60 s, ses douze boucles
rendraient un filet court coûteux.

🔴 **UNE NOTIFICATION NE RÉVEILLE CHAQUE BOUCLE QUE POUR UNE LECTURE**, d'où le vidage continu de `webhook`
(`FILES_VIDEES_EN_CONTINU`). Plusieurs notifications reçues pendant un traitement se fondent en un seul drapeau,
et une boucle qui a traité un message repart dormir son filet si rien ne l'a notifiée entre-temps ; la rafale ne
s'engage que sur un compte mis en cache. Ce qui arrive plus vite que le worker ne traite restait donc en file
jusqu'au filet (mesuré sur le banc des trente espaces : 120 messages d'un coup, le pire à 67 s). `webhook` est
donc enregistrée boucle par boucle, et chaque message traité les réveille toutes (`notifyWorker`) jusqu'à une
lecture vide : 8,6 s au pire sur la même rafale. Le plafond d'un message à la fois par contact tient, pg-boss le
suivant par nom de file. ⚠️ Pas `burstWhenBatchFull` (il exige des lots de deux, et `batchSize: 1` protège une
tâche réussie du rejeu de sa voisine en échec), ni de seuil de rafale à zéro (refusé au démarrage, minimum 1).

🔴 **CHAQUE FILE PORTE UN BATTEMENT DE CŒUR** (`BATTEMENT_SECONDES`, 20 s, rafraîchi toutes les 5 s pendant le
traitement), posé par `updateQueue` puisque les files existent. La supervision de pg-boss passe toutes les
`SURVEILLANCE_FILES_SECONDES` (10 s) et son moniteur toutes les 9 (pg-boss compare strictement), sur le SEUL worker
principal (`superviseLesFiles`) : elle couvre toutes les files, et la doubler doublait l'egress de sa relecture de
`pgboss.queue`. Le cache des files de chaque processus garde son défaut de 60 s, pour la même raison. Sans
battement, la tâche en cours d'un worker mort (crash, mémoire, `docker kill`) attendait son expiration, 15 min,
avant d'être rejouée (mesuré : 932 s ; avec lui : 29 s). Il reconnaît un worker MORT sans tuer une tâche LENTE, ce
qu'une expiration courte ferait, et quatre battements manqués sont exigés avant de rejouer. ⚠️ Les tâches recopient
le battement de leur file à leur création : celles déjà en file lors d'un déploiement gardent l'ancien comportement.
⚠️ **Un retour arrière du code ne retire PAS le battement des files** (il vit dans `pgboss.queue`) : pg-boss
continuerait de le rafraîchir à son défaut (la moitié du battement) et de surveiller toutes les 60 s, soit deux
battements de marge seulement. Le retirer avec le code : `updateQueue(<file>, { heartbeatSeconds: null })`.

🔴 **LA FILE VIDÉE EN CONTINU A UN DÉLAI DE REJEU** (`DELAI_REJEU_VIDAGE_SECONDES`, 10 s, doublé à chaque tentative).
Les files sont créées sans délai : une tâche en échec est remise en file aussitôt, et le vidage la relit tout de
suite. Sans ce délai, ses six tentatives s'enchaînaient en une seconde jusqu'à la file d'échec pendant une panne
passagère de la base, là où le filet de 60 s les étalait sur plusieurs minutes.

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

🔴 **Une clé d'idempotence EN COURS est un verrou, et elle en porte deux pièces** (`api_idempotency`,
`src/api/idempotency-store.pg.ts`). Son **bail** : une pose jamais scellée depuis plus de
`DUREE_CLE_EN_COURS_MAX_MS` est abandonnée (son traitement est mort), et `claim` la retire avant d'insérer, pour
le MÊME corps seulement (un autre corps reste un 422 toute la vie de la clé) ; une clé SCELLÉE ne s'abandonne
jamais, seule sa durée de 24 h la libère. Son **jeton de garde** (`jeton`) : `possede`, `complete` et `release`
ne touchent que la ligne de LEUR jeton. `POST /v1/sends` demande `possede` juste avant de créer la campagne, puis
crée la campagne ET scelle la clé dans UNE transaction (`createWithRecipientsSiConfirme`, `complete` recevant le
client de cette transaction) : une campagne d'API n'existe que si sa clé la désigne. Copie tuée ou clé reprise
entre-temps, tout est annulé, et il ne reste aucun brouillon qu'on pourrait lancer depuis la console. C'est le
jeton, pas la durée du bail, qui empêche le double envoi ; le bail décide seulement combien de temps une clé
abandonnée bloque son client. ⚠️ Le code d'avant 0203
scelle et libère SANS jeton : une copie ancienne qui vivrait plus d'un bail à côté d'une copie neuve pourrait
écraser le scellement de celle-ci. Impossible avec une seule copie (`stop_grace_period` de 30 s, très en deçà du
bail) ; un déploiement progressif à plusieurs copies doit garder son délai d'arrêt sous le bail.

### Plusieurs copies de l'API : ce qui ne doit arriver qu'une fois se garde en base

L'API peut tourner en plusieurs copies derrière un répartiteur (le worker reste un exemplaire par rôle). Une garde
tenue dans la mémoire d'une copie ne voit pas les autres : ce qui ne doit arriver qu'UNE fois pour tout le service
passe par les **verrous courts** (`src/db/verrous-courts.ts`, table `verrous_courts`, migration 0185), sur le
modèle de `run-lock.ts` : une prise prend toutes ses clés ou aucune, en une transaction et dans l'ordre des clés ;
une clé échue se reprend (l'échéance est le bail, lue à l'heure de la base) ; on ne relâche que ce qui porte
encore son jeton. Deux usages : l'anti-rejeu des envois de l'agent de Meta (`mba-envoi:…`) et la publication du
relais (`mba-publication:…`), plus, depuis le lot B, la minute entre deux demandes de code d'un numéro
(`es-code:…`) et le repos entre deux alertes de `/ops` (`ops.alerte`). Une prise se PROLONGE avec son jeton
(`prolonger`, `false` dès qu'une clé ne le porte plus) : la publication repousse son bail avant chaque geste et
s'arrête si elle l'a perdu. Toute instruction qui touche plusieurs clés les verrouille dans l'ordre de la clé
(`order by cle for update`), comme la prise : dans l'ordre physique, un relâchement ou une purge pouvait tenir la
clé qu'une prise attendait pendant qu'il attendait la sienne, et Postgres en tuait un (40P01). Les clés échues sont
effacées par la rétention générale du worker. Le double des tests (`tests/verrous.ts`) tient les mêmes règles ; la
course entre deux copies et l'ordre des verrous se prouvent contre Postgres
(`tests/integration/verrous-courts.integration.test.ts`).

🔴 **CE QUI DOIT ÊTRE TENU AU TOTAL SE COMPTE EN BASE** (lot B, 2026-09-28) : les plafonds de débit partagés
comptent dans `compteurs_debit` (migration 0186, `src/db/debit.ts`), une ligne par clé et par fenêtre FIXE alignée
sur l'heure de la base, toutes les fenêtres d'un appel ou aucune, un appel compté seulement s'il tient sous le
plafond (`insert ... on conflict do update ... where n + pas <= plafond returning n`). Ce qui y compte et ce qui
reste par copie : § 7, les plafonds. Chaque copie pose devant la base la mémoire de SES fenêtres pleines
(`memoireDesPleines`, posée par `buildServer`) : une fenêtre vue pleine le reste jusqu'à sa fin, donc un refus ne
coûte plus d'écriture (sans elle, une boucle d'intégrateur qui réessaie contre un plafond atteint ferait une
écriture par essai sur le pool de la copie). Les fenêtres échues sont effacées toutes les cinq minutes
(`compteurs-debit`, ci-dessous). La course se prouve contre Postgres
(`tests/integration/compteurs-debit.integration.test.ts`), deux copies du vrai `buildServer` sur un même compteur
par `tests/plafonds-partages.test.ts`.

Ce qui reste par copie, et pourquoi c'est juste :
- **le jeton Meta en cache** (5 min, `MetaCredentialsResolver`) : une copie peut garder l'ancien jeton après une
  reconnexion. Sur une erreur d'auth, elle vide SON cache et ne marque invalide que le chiffré qui a échoué
  (`markTokenInvalid(waba, chiffré)`), jamais le jeton neuf ; une reconnexion (un chiffré neuf) repart `active` ;
- **la garde du numéro délié** (5 s) : seule la copie qui sert « Délier » vide son cache, les autres gardent
  leur réponse jusqu'à 5 s (§ 12, invariant 38) ;
- **les envois qui continuent après la réponse** : chaque copie attend les siens à l'arrêt (`arreterApi`), comme
  le signal d'un clic sur un lien suivi, qui part après le 302 ;
- **les plafonds qui restent en mémoire** et les places d'opérations lourdes : § 7, les plafonds.

### Les balayeurs du worker

Tous en `unref()`, chacun avec sa variable de cadence (les valeurs sont dans `src/config.ts`).

Ils se répartissent entre DEUX RÔLES de worker, choisis par `WORKER_ROLE` (table d'appartenance dans
`src/worker/roles.ts`, tenue par `tests/worker-roles.test.ts`, qui la dérive de `worker.ts` dans les deux sens) :
`principal` porte le chemin que la production emprunte (webhooks, campagnes, scénarios, tours d'agent, purges,
reprises), `analyse` porte l'analyse des conversations et ce qu'elle alimente, et `all`, le défaut, porte tout.
Les minuteries d'infrastructure du processus (`heartbeat`, `pool-attentes`) tournent dans les deux. 🔴
`agregats-analyse` reste sur `principal` avec `retention-conversations` : ils se parlent par un drapeau en
mémoire (`agregatsAJour`), et les séparer arrêterait la purge RGPD en silence. Le filtre des files vit dans
`PgBossQueue.neTravailleQue` et non aux enregistrements, parce que des tests dérivent les files consommées du
texte de `worker.ts`. ⚠️ Un rôle peut ENFILER vers une file qu'il ne consomme pas (l'analyse déclenche signaux et
automations, servis par le principal) : ça tient parce que `enqueue` crée sa file lui-même.

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
| `compteurs-debit` | toutes les 5 min, efface les fenêtres échues des plafonds partagés (`compteurs_debit`) : une tentative de connexion sur une adresse inventée écrit une ligne, six heures de rafale en garderaient des millions |
| `retention-oauth` | toutes les 6 h (`principal`), efface les codes OAuth échus depuis une heure et les autorisations révoquées ou expirées depuis 30 jours, par paquets (`PgOauthStore.purger`) |
| heartbeat | écrit `worker_heartbeat`, UNE LIGNE PAR RÔLE (clé = le rôle), lu par `/ops` pour voir un worker mort ; une ligne unique laisserait le survivant masquer la mort de l’autre |

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

🔴 **LA PASSE DE DÉMARRAGE PASSE PAR LE REGISTRE** (`immediat`), donc sous la même garde de ré-entrance : un
premier tour qui arrive pendant qu'elle tourne encore est sauté et journalisé. Les gardes locales de
`reveil-parcours` et `tours-agent-bloques` sont parties ; celles de `creerDlqSweep` et
`creerWebhooksMuetsSweep` restent, liées à leur compteur.

### Deux pools Postgres

- **`DATABASE_URL`** = pooler en mode **SESSION** (port 5432). Sert le **pg-boss du worker** et **tous les
  scripts CLI** (`db/migrate.ts`, `db/seed.ts`), qui lisent cette variable en direct.
  🔴 Le pg-boss du worker ne peut PAS aller en mode transaction : son écoute (`LISTEN`), sa supervision et sa
  migration ne survivent pas à la réassignation du backend entre transactions.
- **`APP_DATABASE_URL`** = pooler en mode **TRANSACTION** (port 6543), pour le pool applicatif. Vide -> repli
  sur `DATABASE_URL`, dégradation SÛRE.
- 🔴 **L'API n'ouvre AUCUN pool pg-boss : elle PRÊTE son pool applicatif** (`new PgBossQueue(pool)`, le `db` de
  pg-boss). Elle ne fait qu'empiler, et chaque instruction de l'empilement est autonome (un `insert`, ou un bloc
  `BEGIN; ...; COMMIT;` envoyé d'un seul message), donc le mode transaction lui convient. Le prêt éteint tout le
  reste dans `PgBossQueue`, pas au site d'appel : ni migration (c'est le worker ; pg-boss VÉRIFIE seulement la
  version du schéma au démarrage, et l'API refuse de démarrer si elle diffère, DEPLOY.md « Montée de version de
  pg-boss »), ni supervision, ni écoute, ni cron. Il reste, sur le pool prêté : quatre `select` au démarrage, le
  cache des files (un `select` par minute), les `send`, et au premier enfilement de chaque file sa création et ses
  réglages (`createQueue`, puis `updateQueue` pour le réveil, le battement et le délai de rejeu). Conséquences : **une copie de l'API ne coûte plus aucune
  session**, quel que soit leur nombre ; et **l'accusé d'un webhook de Meta attend sur le même pool que la
  console**, donc `pool_attentes` (ligne `api`, ou `api-<copie>` quand `API_COPIE` nomme une copie parmi
  plusieurs) mesure aussi la réception. ⚠️ Un `send` part sur une connexion
  prise au pool, jamais sur celle d'une transaction ouverte : enfiler DANS une transaction (`enTransaction`) n'y
  inscrirait pas la tâche (comme avant) et prendrait une SECONDE connexion au même pool. Aucun code ne le fait
  (l'opt-out annonce après le `commit`).
- **`DB_POOL_MAX`** est instancié **PAR PROCESS**, et **chaque service le fixe dans `docker-compose.yml`** (le
  défaut de la configuration n'est qu'un repli). Ce qui mord n'est pas Postgres mais le pool du pooler de
  Supabase, « Pool Size », par utilisateur, base et MODE : la somme des pools de tous les processus doit y
  tenir, sinon l'attente passe de NOTRE pool, borné par `DB_CONN_TIMEOUT_MS` et visible dans `/ops`, à celle de
  Supavisor, MUETTE (la latence double sans erreur). Ce budget, sa mesure et sa règle par copie vivent dans
  `tests/budget-pooler.test.ts`, qui refuse un compose qui le dépasse : **ajouter une copie d'API, c'est ajouter
  un service au compose, et le test exige alors de redimensionner chaque copie, ou de monter « Pool Size » dans
  la limite qu'il calcule** (le pool plein, plus les sessions, plus ce que Supabase tient lui-même, sous 80 % des
  connexions de Postgres).
- **`PGBOSS_MAX`** (workers seuls) vit dans le budget des sessions du même pooler (le même « Pool Size »,
  mode session), **partagé avec mm-hubspot**, plus la connexion d'écoute de CHAQUE worker : un conteneur de
  worker de plus coûte `PGBOSS_MAX` + 1 sessions. Le même test en tient le compte.
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
| `etapeEspace` (règle `scopeTenant`), posée au montage | toute route `:tenantId` d'un module `tenant` (§ 5) | l'accès aux données d'un autre client (IDOR) |
| `requireAdmin` (`g.admin`, au montage) ; `forbidNonAdmin` dans le handler des modules sur `g.auth`, plus deux écarts délibérés sur `g.admin` (`contacts`, dont les lectures de conformité passent par `g.encadrement`, et `mbaAssistant`) | écritures | un opérateur d'inbox qui modifierait la configuration |
| Plafonds de débit | routes authentifiées | l'épuisement par un client, volontaire ou non |
| Session d'exploitation (`makeRequireOps`, `src/auth/middleware.ts`) | `/ops` | l'exploitation cross-tenant par qui n'est pas une adresse de `OPS_EMAILS` avec son second facteur |
| Jeton d'accès OAuth (`mbo_`) dans `makeRequireApiKey`, relu en base à chaque appel | `/mcp` ; `/v1` et le relais le refusent faute de leurs droits | un Claude dont l'autorisation est révoquée ou échue, ou dont la personne n'est plus admin ou est désactivée |
| Second facteur (`apresLeMotDePasse`, `src/auth/routes.ts`) | connexion par mot de passe, inscription, invitation acceptée, et toute connexion d'exploitation (Google compris) | une session d'admin, ou d'exploitation, ouverte avec le seul mot de passe |
| `urlRecuperable` + `resolutionPublique` | toute URL saisie par un client | le SSRF vers le réseau interne |
| `lireCorpsBorne` | toute réponse distante | l'épuisement mémoire par un corps géant |
| Signature `ftyp`, bornes du morceau (`src/pubs/video.ts`), parseur d'octets muet | dépôt d'une vidéo publicitaire | autre chose qu'une vidéo envoyé chez Meta sous l'identité du client, et un corps tamponné avant l'authentification |
| En-têtes de sécurité | toute réponse de l'API et de la console | ce qu'une faille future pourrait faire depuis le navigateur |

🔴 **LE RÔLE ADMIN SE POSE AU MONTAGE, ET `forbidNonAdmin` NE VIT QUE LÀ OÙ UN AGENT PASSE LA GARDE** (lot 3 de
l'audit ponytail, 2026-09-26). Un module monté sur `g.admin` (`[requireAuth, makeRequireRole(['admin'])]`)
refuse un agent ou un manager AVANT le handler, avec le même 403 que `forbidNonAdmin`
(`{ error: 'action réservée aux administrateurs' }`) : un second refus dans ses handlers ne pouvait jamais
répondre, il a été retiré. Les modules montés sur `g.auth` (leur LECTURE est ouverte à un agent) gardent
`forbidNonAdmin` sur leurs écritures, et c'est alors leur SEULE barrière de rôle. Deux modules admin gardent
délibérément les deux : `mbaAssistant` (décision écrite dans `src/server.ts`) et `contacts`, dont les lectures
de conformité sont composées sur `g.admin` : tant que ce n'est pas corrigé, retirer ses refus d'écriture ferait
dépendre la purge et l'action en masse de cette composition.

⚠️ **LA BARRIÈRE D'UN MODULE ADMIN TIENT DONC À UN MOT DU REGISTRE** (`g.admin` dans son entrée). Le remplacer
par `g.auth` ne casse ni le typecheck ni un test de module monté avec une garde ouverte. `tests/role-admin.test.ts`
le voit, sur le serveur construit : chaque route qui a perdu son `forbidNonAdmin` refuse un agent et un manager
(403, même corps, handler jamais atteint), un admin l'atteint, et dans l'autre sens les écritures des modules
`g.auth` refusent toujours un agent DANS le handler.

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

🔴 **AUCUNE SESSION D'ADMIN SANS SECOND FACTEUR, SAUF PAR GOOGLE** (plan
`docs/superpowers/plans/2026-09-25-mfa-admins.md`). Après le mot de passe, `apresLeMotDePasse`
(`src/auth/routes.ts`) décide avant tout accès : une identité qui a un facteur actif reçoit `{ mfaToken }`, quel
que soit son rôle ; une identité qui a au moins un compte `admin` actif et aucun facteur reçoit `{ enrolToken }` ;
les autres reçoivent la suite d'avant (session si un espace, jeton de choix sinon). La connexion, l'inscription
(elle crée un admin) et l'invitation acceptée passent toutes par là ; `/auth/google` non, par décision de Julien,
SAUF pour une connexion d'exploitation (`ops: true`), où Google prouve l'adresse et jamais le second facteur.
Les deux jetons d'étape suivent le modèle du jeton de choix : un `kind` à eux, la liste SIGNÉE des comptes, ni
`tenantId` ni `role` à la racine, et `verifySession` refuse tout jeton qui porte un `kind`. ⚠️ **AUCUN
INTERRUPTEUR** : ni drapeau ni variable ne saute l'étape, et un magasin du second facteur absent FERME (503 sur
l'étape, donc aucune session d'admin), il n'ouvre jamais. Les tests passent par le vrai parcours (`tests/mfa.ts`).

🔴 **LE MOT DE PASSE SE LIT LÀ OÙ IL S'ÉCRIT : SUR L'IDENTITÉ.** `getPasswordHash` (l'ancien mot de passe vérifié
au changement) lit `identities`, comme la connexion ; `users.password_hash` n'est qu'une copie de transition. Et
l'inscription d'une adresse déjà connue exige son mot de passe (`motDePasseDeLAdresse`, 409 sinon, et pour une
identité sans mot de passe). Sans ces deux gardes, s'inscrire avec l'adresse d'un autre puis changer « son » mot de
passe ouvrait tous ses espaces (fermé le 2026-09-26).

⚠️ **LE FACTEUR EST SUR L'IDENTITÉ, PAS SUR LE COMPTE** (`identities`, comme le mot de passe) : une personne
admin dans deux espaces s'enrôle une fois. D'où la réinitialisation en deux portes : un admin d'espace
(`DELETE /tenants/:tenantId/users/:userId/mfa`) ne peut pas toucher une identité qui a un compte ailleurs (409),
ce cas passe par l'exploitation (`POST /ops/mfa/reinitialiser`, note obligatoire).

🔴 **LES ÉCHECS SE COMPTENT EN BASE** (`identities.mfa_echecs`, 0184). Chaque série de 5 codes faux consécutifs bloque le
code de l'application pour une durée qui double (15 min, 30 min, ... 24 h au plus) ; un succès remet le compteur à zéro.
Pendant un blocage, un code de secours reste accepté (80 bits ne se devinent pas) : c'est la porte du vrai titulaire. Le
plafond de 5 essais par minute, en mémoire, reste en plus. L'enrôlement volontaire depuis Mon compte exige le mot de passe
(403 s'il est faux, jamais 401, qui ferait perdre la session à la console), et les jetons d'étape ne portent pas les noms
d'espaces, relus après le code.

🔴 **LE SECRET EST CHIFFRÉ, LES CODES DE SECOURS SONT HACHÉS, ET LES DEUX CONSOMMATIONS SONT ATOMIQUES.** Le
secret TOTP (et celui d'un enrôlement en cours) passe par `encryptSecret` avec `ENCRYPTION_KEY`. Les dix codes de
secours (80 bits chacun) ne sont stockés qu'en SHA-256 : un hachage lent n'ajoute rien à 80 bits tirés au hasard,
et un hachage déterministe permet de consommer un code par UN `update ... where utilise_le is null returning`.
L'anti-rejeu TOTP tient de la même façon : le pas accepté s'écrit par un `update` conditionnel
(`mfa_dernier_pas < $2`), et seul ce qui a écrit est accepté. Un code faux, rejoué ou hors fenêtre rend le MÊME
401 ; au-delà de cinq essais par minute et par identité, 429. `mfa.echec` s'écrit au journal sans le code, et
sans être attendu sur le chemin de réponse.

🔴 **LE MINIMUM DU MOT DE PASSE EST DE 12 CARACTÈRES, SANS RÈGLE DE COMPOSITION** (2026-09-10), et il ne
mord que sur les quatre chemins qui en CHOISISSENT un. `/auth/login` compare un hash et ne regarde jamais
la longueur : un compte existant continue de se connecter, et ne rencontre la règle qu'au prochain
changement. La valeur est arrimée entre le serveur et les quatre écrans par
`web/lib/mot-de-passe.test.ts`, parce qu'elle était écrite huit fois et que quatre copies ont dérivé le
jour même du changement.

🔴 **L'OAUTH DEVANT `/mcp`** (migration 0204, spec `docs/superpowers/specs/2026-10-03-oauth-mcp-design.md`). Claude
Code et claude.ai se connectent à `/mcp` sans clé : la personne clique « Authenticate », prouve qui elle est,
clique « Autoriser » dans un espace où elle est admin, et Claude reçoit un jeton. Les clés d'API ne changent pas.
- **La surface publique** (`src/http/oauth.ts`, classe `anonyme`) : `GET /.well-known/oauth-protected-resource`
  et `.../oauth-protected-resource/mcp` (RFC 9728), `GET /.well-known/oauth-authorization-server` (RFC 8414),
  `GET /oauth/authorize` (302 vers `<APP_URL>/autoriser?demande=<jeton signé>`), `POST /oauth/token`,
  `POST /oauth/revoke` (toujours 200), `POST /oauth/consentement/demande`, `.../google` et `.../autoriser`. La
  console (`src/http/oauth-consentement.ts`, classe `tenant`, `g.admin`) : `POST /tenants/:tenantId/oauth/autoriser`
  (le même clic avec la session), `GET /tenants/:tenantId/oauth/autorisations` et `DELETE .../:id` (404 si inconnue,
  d'un autre espace ou déjà révoquée ; `oauth.revoque` au journal).
- 🔴 **TOUT SE DÉRIVE DE `PUBLIC_API_URL`, JAMAIS DE `Host`** (`src/oauth/metadonnees.ts`) : l'émetteur, la
  ressource (`<PUBLIC_API_URL>/mcp`) et chaque adresse annoncée. Le client compare l'adresse qu'il appelle au champ
  `resource` (RFC 9728, 3.3) : renommer `api.messagingme.app` ou son `/mcp` déconnecterait tous les Claude
  autorisés. Sans `PUBLIC_API_URL`, rien ne se monte (404 partout, la route de la console comprise) : l'émetteur
  serait l'adresse de la console. `mba.messagingme.app/mcp` reste à clé seulement : son proxy envoie `/.well-known/*`
  à l'ancienne console, et la ressource annoncée ne correspondrait pas.
- **Le 401 de `/mcp`** porte `WWW-Authenticate: Bearer resource_metadata=..., scope="mcp:read mcp:write"` (plus
  `error="invalid_token"` quand un jeton `mbo_` a été présenté), et c'est lui qui déclenche la connexion chez Claude.
  Posé par un crochet de la route `/mcp` (`src/http/mcp.ts`), jamais par la garde partagée : ni `/v1`, ni un 403, ni
  un 429 ne le portent. Et seulement quand l'hôte appelé est celui de `PUBLIC_API_URL`, ce qui suppose que NPM
  transmet le `Host` d'origine (à mesurer après le déploiement : `curl -si -X POST https://api.messagingme.app/mcp`).
- **Deux clients, épinglés** (`src/oauth/clients.ts`) : les fiches de Claude Code et de claude.ai, RECOPIÉES et
  jamais récupérées à la volée (pas de requête sortante vers une adresse fournie par un tiers, pas de dépendance au
  Cloudflare de claude.ai). Claude Code revient sur `http://localhost:<port>/callback` ou `127.0.0.1`, tout port ;
  claude.ai sur son adresse exacte. Tout autre client, ou une adresse de retour non validée : 400 en texte, AUCUNE
  redirection. `npm run oauth:fiches` relit les fiches publiées à chaque déploiement de l'API (`DEPLOY.md`).
- **Les jetons sont opaques**, jamais des JWT : `mbo_` l'accès (1 h, `expires_in` rendu), `mbr_` le renouvellement
  (30 jours sans usage, 90 au plus, remplacé à chaque usage), `mbc_` le code (60 s, usage unique, brûlé même si
  l'échange échoue ensuite). PKCE S256 seul. 🔴 **Un ancien jeton de renouvellement présenté révoque toute
  l'autorisation** (RFC 9700, 4.14) : `invalid_grant`, et Claude redemande une connexion. ⚠️ Deux renouvellements
  simultanés du même jeton y mènent aussi.
- **La garde** (`makeRequireApiKey`) reste le seul point d'entrée de `/mcp`, `/v1` et du relais : le préfixe aiguille
  (`mba_` vers les clés, `mbo_` vers les autorisations), le même ordre (forme, budget des empreintes inconnues,
  plafond de l'ESPACE, partagé avec `/v1`), et la base relue à chaque appel : révoquée, échue, compte désactivé ou
  plus admin, 401 ; espace suspendu, 403 (un 401 relancerait la connexion en boucle). `req.auth.role` reste `api`,
  la personne vit dans `req.apiPersonne` et signe les réponses et assignations faites par `/mcp`, et le journal
  d'usage range l'appel sous `oauth:<autorisation>`. Un jeton ne porte que `mcp:read` et `mcp:write` (CHECK) : `/v1`
  et le relais le refusent par leurs droits.
- 🔴 **LE CONSENTEMENT N'EST JAMAIS SAUTÉ, ET SEUL UN ADMIN AUTORISE.** La page vit dans la console (la CSP de l'API
  est fermée, l'origine de la console est déjà autorisée chez Google). Deux preuves d'identité : la session de la
  console, ou un jeton Google frais vérifié comme `/auth/google`, qui rend une preuve signée (`oauth_choix`, 5 min,
  liée à l'empreinte de LA demande). Les deux portes passent par UNE fonction, `autoriser` (`src/oauth/autoriser.ts`),
  qui relit le rôle en base AU CLIC, jamais dans la preuve ni la session. Une adresse Google inconnue crée son espace
  par le MÊME chemin que `/auth/google` (`creerEspaceParGoogle`, `src/auth/routes.ts`). Pas de second facteur exigé :
  c'est la règle de la connexion Google à un espace.
- **Les erreurs de `/oauth/token` sont au format OAuth et en 400** (`invalid_grant`, `invalid_request`,
  `invalid_client`, `invalid_target`, `unsupported_grant_type`) : un refus n'est jamais un 5xx, dont Cloudflare
  remplacerait le corps. Seule une panne de base y rend 500, délibérément : un `invalid_grant` ferait jeter ses
  jetons à Claude pour une panne passagère ; leur `error_description` est en anglais ASCII (RFC 6749, 5.2). Une demande expirée rend 400
  `demande_expiree`, jamais 401 : la route de la console le rend aussi. Toute réponse de `/oauth/*` part en
  `Cache-Control: no-store`. Aucun jeton, code, vérificateur ni empreinte dans un journal ; `oauth.autorise` et
  `oauth.revoque` ne portent que le client et les droits. La révocation par le client lui-même n'est pas tracée :
  elle ne connaît que le jeton, pas l'espace.

🔴 **LES OUTILS MCP DE L'AGENT IA ET DU CRÉDIT AGISSENT AU NOM D'UNE PERSONNE** (lot 8a, spec
`docs/superpowers/specs/2026-10-03-mcp-agent-ia-design.md`). Les outils de `src/mcp/outils-agent.ts` permettent à
Claude de créer un agent IA, d'écrire sa fiche, de lui donner sa connaissance et ses outils sûrs, de l'essayer, de
l'activer, et d'ouvrir une recharge du crédit.
- **Personne requise** : un outil `exigePersonne` n'est ni listé ni appelable quand `ContexteMcp.personne` est nul,
  c'est-à-dire avec une clé d'API. `outilsPour(ctx)` (`src/mcp/outils.ts`) filtre `tools/list` ET `tools/call`, et le
  refus est mot pour mot celui d'un outil inconnu. La raison : une clé `mcp:write` peut être branchée comme connecteur
  d'un agent qui lit des messages de clients, et une injection y modifierait un agent ou ouvrirait un paiement. Toutes
  les écritures de l'agent le portent ; ses lectures (`list_agents`, `get_agent`, `list_knowledge`, `get_credit`)
  restent lisibles par une clé. La répartition est tenue par `tests/mcp-agent.test.ts`.
  `preview_site` est une lecture (`mcp:read`) qui exige une personne, et la seule lecture en monde ouvert : il lit un
  site tiers. La sonde 15 de l'auto-attaque le vérifie sur le serveur construit.
- **Une seule vérité** : chaque outil appelle la fonction de la console (`src/agent/gestion.ts`, `connaissance.ts`,
  `essai.ts`, `reglages.ts`, `src/stripe/paiement.ts`), sur les MÊMES objets que les routes (`src/index.ts`,
  `agentsDeLaConsole` et ses voisins). Un refus devient un refus d'outil avec la phrase de l'écran, suivie de ses
  détails en JSON (la liste des manques d'une activation, le code d'un refus de paiement) : `valeurOuRefus`,
  `src/mcp/saisie.ts`.
- 🔴 **Le plafond des opérations coûteuses est celui de la console** : `buildServer` construit UN `PlafondPartage`
  (`Gardes.plafondCouteux`), dont dérive `limiteCouteuse`, et le pose dans les dépendances du MCP au montage
  (`DepsMcp.couteux` ; le câblage fournit `CablageMcp`, sans lui). Même instance, même clé (l'espace) : les outils
  coûteux (un essai facturé, un ajout ou une suppression de connaissance, un site, un document, un paiement) le
  consomment avant leur fonction, en plus de l'unité de débit de l'appel MCP. Leur liste est tenue par
  `tests/mcp-agent.test.ts`.
- **`update_agent` filtre ses arguments** : objectif, ton, personnalité, règles de transfert, règles d'arrêt, modèle
  (liste fermée) et `fiche_version`. Toute autre clé est REFUSÉE, pas ignorée : `modifierAgent` est la porte de
  l'administrateur et accepte aussi les plafonds de coût, la mention d'IA, le libellé et le statut. Claude ne voit ni
  les plafonds ni la mention d'IA (`get_agent` ne les rend pas).
- **La personne signe** : la ligne `fiche_agent` de l'historique (origine `mcp`), l'activation des outils sûrs
  (`active_par`), la suppression d'une fiche de connaissance (origine `mcp`, par `journaliserSuppressionDe`), et le
  payeur d'une recharge. L'historique de la console l'affiche « par Claude ».
- **`buy_credit` annonce le montant HORS TAXE** de l'offre : la taxe est calculée par Stripe Tax sur la page de
  paiement, selon le pays et le numéro de TVA saisis, donc aucun TTC n'est connu avant le paiement. Seul le webhook
  signé crédite.
- **`import_document_text` suit le chemin d'un fichier texte déposé** (`importerTexteDocument`,
  `src/agent/connaissance.ts`) : même `normaliser`, même découpe hors de la boucle sous la même échéance
  (`LECTURE_DOCUMENT`, celle de `lireDocumentHorsBoucle`), même provenance et même remplacement par nom. Un caractère
  nul est refusé en 400, comme le chemin fichier refuse un binaire : Postgres le refuse dans un `text`, et l'écriture
  lèverait. `tests/agent-connaissance-texte.test.ts` compare les deux chemins.
- **Les bornes de chaque saisie de la console sont annoncées dans le schéma de l'outil**, lues dans son Zod : l'extracteur
  partagé `tests/aide/bornes-zod.ts`, appliqué par `tests/mcp-agent.test.ts` (et par `tests/mcp-widgets.test.ts`).
- ⚠️ Un agent créé et activé par Claude ne répond à aucun client tant qu'un scénario publié ne le contient pas : les
  descriptions des outils le disent, jusqu'au répondeur par défaut (lot 5).

🔴 **LE CORS EST EN LISTE BLANCHE ET SANS `credentials`, et les deux comptent.** `CORS_ORIGINS` refuse `*` AU
CHARGEMENT de la configuration. Jamais `credentials: true` : la session voyage dans un en-tête
`Authorization`, jamais dans un cookie, donc **il n'y a aucun CSRF aujourd'hui** ; l'activer en créerait un de
toutes pièces. Vide = aucun en-tête CORS n'est posé, ce qui est le bon défaut.

🔴 **Deux plafonds de débit, et 0 les désactive.** `RATE_LIMIT_USER_PAR_MINUTE` (clé = utilisateur, posé DANS
`makeRequireAuth` donc hérité par tous les modules gardés) et `RATE_LIMIT_COUTEUX_PAR_MINUTE` (clé = ESPACE)
sur import, aperçu, action en masse, purge, export, lancement de campagne, et les routes lourdes de la
connaissance d'un agent (suppression en masse, import d'un document, aperçu et import d'un site), plus les outils MCP
coûteux de l'agent IA, sur la MÊME instance (`Gardes.plafondCouteux`, ci-dessus). Mettre l'une à 0 est le levier
d'urgence : un mauvais calibrage couperait la console de tous les clients, et un `--force-recreate` va plus
vite qu'un déploiement de code. ⚠️ Le premier reste LOCAL À LA COPIE, délibérément (ci-dessous) ; le second compte
dans le compteur partagé : un espace a ses opérations coûteuses au TOTAL des copies.

🔴 **CE QUI COMPTE AU TOTAL DES COPIES DE L'API, ET CE QUI RESTE PAR COPIE** (lot B, 2026-09-28). N copies
servaient N fois chaque plafond tenu en mémoire. Ce qui borne un espace, une identité ou un quota de Meta passe
dans le compteur PARTAGÉ (`compteurs_debit`, migration 0186, § 6) ou dans les verrous courts ; chaque plafond y a
une politique ÉCRITE pour le cas où la base ne répond pas (`PlafondPartage.siLaBaseEchoue`, requise à la
construction) :

| Plafond | Où il compte | Base muette |
|---|---|---|
| API publique par espace (`/v1` et `/mcp`, minute et heure), et ses `x-ratelimit-*` | compteur partagé | l'appel PASSE, sans en-têtes (refuser tous les intégrateurs sur une panne passagère déclencherait leurs rejeux au retour de la base, et la route a de toute façon besoin de la base) |
| opérations coûteuses d'un espace (`RATE_LIMIT_COUTEUX_PAR_MINUTE`), routes de la console et outils MCP coûteux confondus | compteur partagé | l'opération PASSE (même raison) |
| usage de l'API publique (`/ops/usage`, et le quota par espace le jour où il existera) | compteur partagé | l'appel PASSE (le garde observe, il ne devient pas la panne) |
| connexion : `login` (et le choix d'espace), `signup`, `forgot-password`, `reset-password`, `invitations/accept`, `google`, clé = l’EMPREINTE de `ip::discriminant` (jamais l’adresse ni le jeton en clair : la clé vit en base, donc dans ses sauvegardes) | compteur partagé | la tentative est REFUSÉE (429, « vérification momentanément impossible ») : une panne n'ouvre jamais un essai de plus |
| la minute entre deux demandes de code d'un numéro (`/numero/code`, le quota de Meta : dix requêtes sur 72 h) | verrou court `es-code:<numéro>`, jamais relâché | REFUSÉE (429), Meta n'est pas appelé |
| refus de `/ops` et repos de leur alerte Telegram | compteur partagé (`ops.refus`), verrou court `ops.alerte` | le refus est journalisé (`dansLaFenetre: null`), aucune alerte |
| OAuth : un MÊME code ou jeton de renouvellement sur `/oauth/token` (`oauth.jeton`, 10/min), le consentement par jeton Google ou par preuve (`oauth.consentement`, 20/min), clé = l’empreinte de `ip::jeton` | compteur partagé | REFUSÉ (429), comme la connexion |

Restent EN MÉMOIRE, par copie, délibérément :
- **le plafond par utilisateur** (`RATE_LIMIT_USER_PAR_MINUTE`, 300/min) : le plus fréquent (chaque requête de la
  console), le porter en base coûterait une écriture par requête ; N copies en font N fois 300, ce qui borne encore un
  compte qui martèle ;
- **les petits plafonds** : l'aide et le support (par compte), le formulaire de contact de la vitrine (un seul
  compteur pour tous : sans `trustProxy`, `req.ip` est le proxy), la chaîne (demandes de lien), le relais du Meta
  Business Agent (par clé), le budget des empreintes et des codes jamais résolus (`API_KEY_PREFILTRE_MAX`,
  `CODES_INCONNUS_PAR_MINUTE`, qui protègent la base AVANT toute lecture, donc ne peuvent pas la payer), les codes de
  `/w/:code` et `/rcs/callback/:code`, et les cinq essais par minute du second facteur (le total est tenu en base par
  le blocage progressif de 0184) ;
- **les places d'opérations lourdes simultanées** (`API_MAX_LOURDES_SIMULTANEES`) : elles protègent le pool DE LA
  COPIE, que chaque copie a pour elle seule ; les compter au total diviserait la capacité sans rien protéger de plus ;
- **les caches sans invalidation** : N copies font N fois les lectures, aucune ne rend un résultat faux.

🔴 **LE COÛT : UNE ÉCRITURE PAR APPEL COMPTÉ, ET AUCUNE PAR REFUS RÉPÉTÉ.** Concernés : les routes de `/v1` et
`/mcp` (le plafond, une instruction à deux lignes, plus l'usage, une instruction à deux lignes : deux allers-retours
de plus par appel accepté, bornés par le plafond de l'espace, 60 par minute et 1 000 par heure par défaut), les
routes coûteuses (gestes manuels, rares), les routes anonymes de la connexion (une par tentative), la demande
de code d'un numéro, et chaque refus de `/ops`. Le plafond par utilisateur, qui voit passer toute la console, n'y
passe PAS. Un refus coûte une écriture la première fois qu'une copie voit la fenêtre pleine, puis plus rien jusqu'à
sa fin (`memoireDesPleines`) ; un refus d'une fenêtre sur deux en coûte une seconde, qui rend ce que l'autre avait
compté. ⚠️ Plus de plafond de clés vivantes sur la connexion : il bornait la MÉMOIRE d'une copie contre un robot qui
invente des adresses ; en base, ces lignes vivent une minute et la tâche `compteurs-debit` les efface toutes les
cinq minutes. Le vrai fusible contre une telle rafale est la règle Cloudflare des POST d'authentification
(`docs/ARCHITECTURE-CIBLE.md` §7.7).

⚠️ **LA CLÉ PAR IP N'EST PAS L'ADRESSE DU CLIENT, et ce lot ne l'a pas changé** (c'est un sujet d'infra) : Fastify
tourne sans `trustProxy`, donc `req.ip` est l'adresse du proxy (NPM aujourd'hui), et la clé `ip::adresse` vaut en
pratique un plafond par identité tentée pour toute la plateforme. Derrière un répartiteur qui présenterait
plusieurs adresses sources, la même identité se répartirait sur plusieurs clés, donc un plafond multiplié
d'autant. `CF-Connecting-IP` ne deviendra lisible qu'avec une origine qui ne répond qu'à Cloudflare (§7.3).

🔴 **Les portes publiques ont leurs propres plafonds, et un plafond ne compte que des clés qui EXISTENT.**
- `/v1` et `/mcp` : un budget GLOBAL (`API_KEY_PREFILTRE_MAX`, clé constante) freine les empreintes jamais
  résolues par ce process AVANT la requête en base ; une empreinte résolue en est exemptée, sinon une attaque qui
  l'épuise couperait tous les clients. Puis le plafond de l'ESPACE (`src/auth/plafond-espace.ts`, 2026-09-25),
  commun à toutes ses clés : deux fenêtres fixes qui s'appliquent ensemble (`API_PLAFOND_MINUTE`, défaut 60,
  `API_PLAFOND_HEURE`, défaut 1 000), comptées toutes ou aucune, sur l'ESPACE d'une clé résolue (avant la lecture
  de la clé dès qu'elle est connue, l'espace étant retenu avec l'empreinte dans `ClesResolues` ; après la lecture
  la première fois). Une fausse clé n'entre donc jamais dans le compteur. Depuis le lot B, les fenêtres vivent dans
  le compteur PARTAGÉ (calées sur la minute et l'heure pleines, heure de la base) : le plafond est tenu au total des
  copies, et `x-ratelimit-*` disent le compte commun. Il compte des APPELS : le
  travail reste mesuré par le garde d'usage. Un espace peut porter son réglage (`tenant_settings.api_plafond_minute`
  et `_heure`, migration 0181, `null` = défaut, CHECK > 0), lu à travers un cache de 30 s (une lecture partagée par
  rafale ; en cas d'échec, le dernier réglage connu, sinon le défaut) et réglé par `GET`/`PUT
  /ops/plafond-api/:tenantId` (session d'exploitation, note obligatoire, ligne `ops_plafond_api` avec l'état d'avant et `par`,
  la route pose dans le cache le réglage écrit (`poser`), qui reste le dernier réglage connu si une relecture
  échoue). Refus : 429 `rate_limited`, `Retry-After` = la fenêtre pleine qui se libère le
  plus tard, message qui la nomme avec son plafond ; les `x-ratelimit-*` décrivent la fenêtre la plus proche de
  son plafond. `0` en configuration éteint la fenêtre pour les espaces sans réglage (levier d'urgence) ; un
  réglage d'espace reste appliqué. ⚠️ Le cache du réglage, lui, reste par copie : un plafond relevé par `/ops`
  s'applique tout de suite sur la copie qui a servi l'écriture, dans les 30 s sur les autres.
- La clé du relais du Meta Business Agent (droit `mba:relais`, attribué par la seule publication) n'entre PAS
  dans ce plafond : elle garde un compteur PAR CLÉ (`API_KEY_RATE_LIMIT_MAX`, sur l'empreinte), pour qu'un
  intégrateur qui charge l'API ne coupe pas les outils de l'agent de Meta en pleine conversation.
- `/w/:code`, `/rcs/callback/:code` et `/widget/:code.js` : AVANT la base, un budget COMMUN
  (`CODES_INCONNUS_PAR_MINUTE`, clé constante, en silence, une instance par porte) freine les codes jamais résolus
  par ce process, et un code résolu en est exempté, comme une clé sur `/v1`. Épuisé, il rend 429, sauf au widget,
  qui rend son script inerte sans cache (la réponse s'exécute dans la page d'un client). APRÈS la lecture, pour
  les deux premières seulement (le widget n'a pas de plafond par code : sa réponse se met en cache 60 s chez le navigateur et le CDN (🔴 chez le navigateur
  GRÂCE À une Cache Rule Cloudflare, « Widget WhatsApp » : `https://api.messagingme.app/widget/*`, Browser TTL
  « Respect origin TTL », posée le 2026-10-03 ; sans elle, Cloudflare impose 4 h à tout `.js`, son Browser Cache
  TTL par défaut, et un réglage changé dans la console met jusqu'à 4 h à apparaître), et son
  rendu se garde 30 s par code dans le process, `cacheCourt`, parce qu'un paramètre de requête contourne le
  premier), le
  plafond par code EXISTANT (`WEBHOOK_IN_RATE_LIMIT_*`, `RCS_CALLBACK_PAR_MINUTE`). Le second se calcule sur le débit RCS d'un run de campagne, et ne tient que parce
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
  réception des messages passe avant l'équité entre intégrateurs). Par COPIE, délibérément : c'est le pool de la
  copie qu'elle protège.

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
`META_APP_SECRET`, `ENCRYPTION_KEY`, `AUTH_SECRET` (il signe aussi les sessions d'exploitation), `AI_GATEWAY_API_KEY`, `VERCEL_API_TOKEN`,
la clé Supabase.

🔴 **`VERCEL_API_TOKEN` n'est pas un secret comme les autres, et le confondre avec `AI_GATEWAY_API_KEY`
coûterait cher.** La seconde ne sait que DÉPENSER sous un plafond ; le premier sait FABRIQUER des clés
facturées à l'équipe, autant qu'on veut. Sa compromission n'est donc pas bornée par nos plafonds applicatifs.
Le seul contre-feu est le **plafond d'ÉQUIPE posé chez Vercel**, hors de ce dépôt et hors d'atteinte de qui
lirait le `.env.prod` : il borne les dégâts quel que soit le nombre de clés créées.

**Chiffrés au repos** (AES-256-GCM, `src/crypto/secretbox.ts`, même patron partout) : les tokens business
d'Embedded Signup (`waba_credentials`), les clés RCS par workspace (`rcs_agents.api_key_enc`), les clés AI Gateway par espace (`agent_gateway_keys.cle_chiffree`), les mots de
passe SMTP (`email_accounts.password_enc`), les secrets de connecteur API (`agent_tool_sources`), les clés d'un
outil qui reçoit les signaux (la table de son adaptateur, dans `src/signaux/`), le secret TOTP d'une identité
(`identities.mfa_secret_enc`, et `mfa_secret_attente_enc` pendant l'enrôlement).

**Hachés, jamais stockés en clair** : les clés d'API publiques (`api_keys`, sha256), les jetons d'invitation et
de réinitialisation (`auth_tokens`), les secrets de webhook entrant, les codes de secours du second facteur
(`mfa_codes_secours`, sha256), les jetons et codes OAuth (`oauth_autorisations`, `oauth_codes`, sha256).

**Au plus dix clés d'API actives par espace** (`MAX_CLES_API_ACTIVES`, `src/http/api-keys.ts`) : la onzième
est refusée en 409, les révoquées ne comptent pas, la clé du relais de l'agent de Meta non plus. C'est une borne
d'exposition (moins de secrets oubliés chez d'anciens intégrateurs), pas de débit : le plafond de l'API est
déjà commun à toutes les clés de l'espace. 🔴 Le compte et l'insertion se font sous un verrou consultatif par
espace (`creerSousPlafond`, clé `api_keys:<espace>`) : sans lui, des créations simultanées dépassent le
plafond. La route n'a accès qu'à cette création ; `create`, sans plafond, ne sert que la clé du relais.

🔴 **`/ops` EST NOMINATIF, AVEC SECOND FACTEUR** (plan `docs/superpowers/plans/2026-09-28-ops-nominatif.md`).
Plus de jeton partagé : `OPS_TOKEN` n'existe plus, et il n'y a aucun accès de secours. `OPS_EMAILS` (des
adresses séparées par des virgules, refusée au chargement si une entrée n'en a pas la forme, vide = `/ops`
fermé pour tous) désigne qui entre. La connexion est celle de la console, avec un paramètre : `/auth/login` ou
`/auth/google` avec `ops: true`. Après l'identité prouvée, `entreeOps` (`src/auth/routes.ts`) refuse en 403 une
adresse hors de la liste, puis passe par la porte du second facteur (code si un facteur est actif, enrôlement
sinon, comme un admin) avec une étape marquée `ops`, signée avec le reste. Au bout du code, `suiteDeConnexion`
rend `{ sessionOps, email }` : une session de portée `ops` (`signSessionOps`, 12 h, `sub` = l'identité), qui
porte l'adresse et le moyen qui a prouvé le facteur.
- **Trois remparts contre une session d'exploitation sur le seul mot de passe**, chacun vérifié seul en le
  retirant : `entreeOps` passe `obligatoire: true` ; `apresLeMotDePasse` force l'enrôlement d'une étape `ops` ;
  `suiteDeConnexion` LÈVE sur une étape `ops` sans moyen vérifié, que seules `/auth/mfa/verifier` et
  `/auth/mfa/activer` lui passent.
- **Deux portées qui se refusent l'une l'autre.** `verifySession` refuse tout jeton qui porte un `kind` (une
  session d'exploitation n'ouvre AUCUNE route d'espace) ; `verifySessionOps` exige `kind: 'ops'` et le moyen
  (une session d'espace, même d'admin, même au même secret, n'ouvre pas `/ops`).
- **Relu à CHAQUE requête** (`makeRequireOps`) : la signature d'abord (un appel sans session valide ne coûte
  aucune lecture), puis l'identité relue en base : son adresse (celle de la BASE, pas celle du jeton) doit être
  dans la liste, et son facteur toujours actif. Retirer quelqu'un de `OPS_EMAILS` (puis `--force-recreate`) ou
  réinitialiser son facteur coupe son accès à la requête suivante, sans attendre 12 heures. L'ancien en-tête
  `x-ops-token` n'est plus lu nulle part, ni autorisé par le CORS.
- 🔴 **L'inscription libre refuse une adresse de la liste** (`/auth/signup`, même 409 qu'une adresse prise) :
  elle ne prouve pas qu'on possède l'adresse, et un tiers créerait sinon le compte d'un futur exploitant, poserait
  son propre facteur et ouvrirait `/ops`. N'inscrire dans `OPS_EMAILS` qu'une adresse dont le compte existe déjà.
- **Sans l'écran** (verrou d'un espace, recharge, rejeu de DLQ, réinitialisation d'un facteur) : la session
  d'exploitation est un `Bearer`. L'obtenir par `POST /auth/login` (`{ email, password, ops: true }`) puis
  `POST /auth/mfa/verifier` (`{ mfaToken, code }`), qui rend `sessionOps` ; ou la reprendre dans la console
  connectée à `/ops` (`localStorage`, clé `mba.sessionOps`). Puis `curl -H "authorization: Bearer <sessionOps>"`.
- **Chaque écriture signe sa trace** : `par` (l'adresse, lue par `auteurOps`) dans la ligne de journal de
  chacune des neuf écritures, la note signée (`noteSignee`) dans `grille_prix.modifie_par` et dans la note du
  mouvement de crédit, l'adresse pour acteur des lignes `mfa.reinitialise` écrites dans les espaces de la
  personne, et `observateur` dans le jeton d'observation. La connexion elle-même laisse `ops_connexion`.
  Aucune migration : les colonnes qui portaient la note portent désormais aussi l'auteur.
- ⚠️ **La surveillance reste** : au 5e refus dans une fenêtre de 5 minutes, une alerte Telegram part, throttlée,
  et une session dont l'adresse a quitté la liste compte comme un refus. 🔴 **Le jeton présenté n'est JAMAIS
  journalisé.**
- La console garde la session d'exploitation sous sa propre clé (`mba.sessionOps`, `web/lib/session.ts`), à
  part de la session d'espace : observer un espace remplace la seconde sans fermer la première. L'ancienne clé
  `mba.ops` est effacée à la première lecture. Le menu du compte montre un lien « Exploitation » quand `/me`
  rend `exploitation: true` (un confort, jamais une autorisation).

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
pas** : un lecteur qui croit « toutes traçables » ne cherchera pas la trace qui manque. Depuis le
2026-09-28, les neuf disent QUI (`par`) ; `cle-modele` et `dlq/replay` ne disent toujours pas POURQUOI.

⚠️ **Ce qui vaut, lui, pour les huit** : elles sont délibérément **cross-espace**, parce que `/ops`
s'authentifie par la session d'exploitation (`makeRequireOps`) et jamais par une session d'espace. Leurs
dépendances sont requises par le type : toutes les routes, `dlq/replay` comprise, sont montées dès que le
module l'est.

🔴 **ET UNE SESSION D'ESPACE, D'OBSERVATION OU NON, N'ATTEINT JAMAIS `/ops` : elle est refusée en 401 par
`makeRequireOps`, faute de portée `ops`.** Ce n'est PAS la garde de méthode qui l'arrête : celle-là vit
dans `makeRequireAuth` et ne s'exécute pas sur cette surface, qui n'a qu'un `preHandler`,
`makeRequireOps`, et ne lit jamais `req.auth`. `scripts/auto-attaque.mts` le tient sur la classe
`session-ops` (sonde 5 : un admin d'espace, l'ancien `x-ops-token`, une session d'exploitation signée
ailleurs, et une session bien signée dont l'identité n'a pas de facteur actif, qui doit atteindre la
relecture du facteur) et dans l'autre sens (sonde 5 bis : une session d'exploitation sur chaque route
d'espace).

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
| **Interrupteurs de fonctionnalité** | `META_ES_CONFIG_ID`, `AI_GATEWAY_API_KEY`, `DRY_RUN`, `CONVERSATION_ANALYSIS_ENABLED`, `OPS_EMAILS` | vide = la fonctionnalité est OFF, proprement (503 explicite, file non consommée, `/ops` fermé pour tous) |
| **Capacité** | `DB_POOL_MAX`, `PGBOSS_MAX`, `RATE_LIMIT_*` | latence, saturation muette, ou coupure de service |
| **Rétention** | `WEBHOOK_EVENTS_RETENTION_DAYS` | une réponse RGPD fausse |
| **Paramètres commerciaux** | `EUR_PER_USD`, `COMMISSION_MODELE_PCT`, `CREDIT_OFFERT_MICRO_EUR` | ce qu'on facture, et ce qu'on offre |
| **Provisionnement des clés client** | `VERCEL_API_TOKEN` + `VERCEL_TEAM_ID` | les deux vides = éteint ; une seule moitié = refus au boot (chaque création d'agent échouerait, donc plus aucun client ne pourrait en créer) |
| **Recharge par Stripe** | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRIX_REFILL_50`, `STRIPE_PRIX_REFILL_100` | vides = recharge fermée (la route rend 503, le webhook n'est pas monté) ; une clé sans préfixe `sk_`/`rk_` + `live_`/`test_`, ou la clé sans le secret du webhook (ou l'inverse) = refus au boot |

🔴 **Le boot ÉCHOUE VITE plutôt que de dégrader en silence**, et c'est délibéré : `AUTH_SECRET` trop court en
production, `CORS_ORIGINS` à `*`, une entrée de `OPS_EMAILS` qui n'a pas la forme d'une adresse, `AI_GATEWAY_API_KEY` sans ses deux modèles, une seule moitié des clés
Zadarma, `VERCEL_API_TOKEN` sans `VERCEL_TEAM_ID` ou sans `ENCRYPTION_KEY`, `STRIPE_SECRET_KEY` sans un préfixe qui dise son mode, une seule moitié de Stripe (la clé seule laisserait payer sans que rien ne crédite ; le secret seul monterait un webhook qui ignore le mode de la clé). Chacun de ces cas produirait sinon une panne en pleine conversation, des semaines plus tard.

⚠️ **`EUR_PER_USD` est un paramètre commercial, pas un cours.** Le Gateway facture en dollars, tous nos
compteurs sont en micro-euros. Aller chercher un cours en temps réel ferait varier le prix d'une même
conversation d'un jour à l'autre, pour un gain nul, et ajouterait une dépendance réseau sur le chemin d'un
tour. Un taux absent ou aberrant retombe sur 1, JAMAIS sur 0 : un zéro rendrait toute consommation gratuite,
donc désarmerait le plafond en silence.

🔴 **QUI PAIE QUOI, ET À QUEL PRIX.** Sur le **crédit prépayé du client**, au **prix client** : le coût du
Gateway au taux `EUR_PER_USD`, majoré de `COMMISSION_MODELE_PCT`, calculé par `prixClientMicroEur`
(`src/agent/devise.ts`), seul point de calcul du montant débité. Ses appelants : le cerveau de l'agent (donc
le tour de production et l'essai du bac à sable) et la traduction des conversations. La commission est la même
variable que celle du tarif annoncé dans la liste des modèles : le prix affiché est le prix payé. Sur **notre
clé** : les deux assistants de configuration, mesurés au coût brut (`microEurosDepuisDollars`, que
`tests/agent-devise.test.ts` refuse ailleurs) et plafonnés par espace ; la transcription, le bot d'aide et la
connaissance (vectorisation, reclassement), qui ne se décomptent d'aucun crédit.
⚠️ **La traduction se débite à chaque appel mais s'inscrit au journal en UNE ligne par espace et par jour de
Paris** (raison `traduction`, colonne `jour`, index unique partiel de 0190, upsert de
`PgCreditStore.debiterTraduction`). Solde nul : pas de traduction. Sa clé de modèle s'ouvre à la première
traduction s'il y a du crédit (`creerAssureurDeCle`, `src/agent/provisionner-cle.ts`), EN ARRIÈRE-PLAN : une
promesse en vol par espace, et le GET du fil rend la cause `cle_en_preparation` sans l'attendre (Vercel peut
prendre jusqu'à 30 s, le fil se rafraîchit toutes les 4). Le crédit se lit avant de partir : sous le minimum
d'une clé (1 $, environ 0,92 €), la cause est `credit_insuffisant`, distincte de `credit` (épuisé). Un répit
d'une minute suit un échec chez Vercel. Une clé ILLISIBLE en base (`PgCleGatewayStore.lireEtat` la distingue
d'une absence) n'en fait ouvrir aucune autre : elle se journalise, une fois par répit, et la traduction reste
indisponible (`cle`). Le fil vérifie l'espace UNE fois par rafraîchissement (`Traducteur.ouvrir`). L'ouverture en
vol est confiée à `travauxEnVol` (déclaré AVANT le traducteur dans `src/index.ts`) : l'arrêt d'une copie l'attend,
sans quoi une clé créée chez Vercel ne s'enregistrait pas chez nous. Quand la cause disparaît, la console reprend
le fil ENTIER au tour suivant (`traductionIndisponibleRef`, `web/app/inbox/page.tsx`) : le delta seul laissait
l'historique en VO.
⚠️ **Le plafond de la clé Vercel reste le cumul crédité au COÛT BRUT** : notre solde, décompté au prix client,
s'épuise avant lui. Il n'est qu'un filet pour un bug de comptage. Il suit les TROIS portes d'entrée du crédit
(achat Stripe, recharge `/ops`, crédit offert), chacune appelant `remonterPlafondApresRecharge` après sa
transaction (l'achat et l'offre en arrière-plan, suivis par `travauxEnVol`), et l'ouverture de la clé elle-même.
🔴 **La cible se RECALCULE, elle ne s'incrémente pas** (`PgCleGatewayStore.ajusterPlafond`) : le solde, plus tout
ce qui en a été débité depuis `agent_gateway_keys.created_at`, c'est-à-dire tout ce qui a été crédité depuis
l'ouverture de la clé, plafond initial compris. Sous le verrou de la ligne de la clé (`for update`, tenu pendant
l'appel à Vercel), la cible se lit dans une SECONDE instruction, qui voit donc ce que la remontée précédente a
noté. Deux remontées simultanées convergent, et un crédit écrit pendant l'ouverture de la clé (quand il n'y avait
encore rien à remonter) est rattrapé par la remontée qui suit l'enregistrement de la clé.
⚠️ **`CREDIT_OFFERT_MICRO_EUR`** (5 € par défaut depuis le 2026-09-29) s'offre au PREMIER numéro WhatsApp que
**Meta dit vérifié**, jamais à la liaison seule (`PgEmbeddedSignupStore.linkTenant` n'offre rien : elle tourne
avant que la route ne sache si le numéro est `NOT_VERIFIED`). La route l'appelle (`offrirCredit`, câblé par
`creerOffreDeBienvenue`) à l'inscription si Meta le dit `CONNECTED`, `VERIFIED`, ou vient d'accepter son
enregistrement ; sinon à l'activation, dès que le code est accepté (ou si Meta le dit déjà vérifié ou activé). Une
offre qui échoue ne fait pas échouer la route. `offrirAuNumeroVerifie` relit le numéro dans `phone_numbers` DE CET
ESPACE et insère dans `credits_offerts` : clé primaire sur l'espace, unique sur l'identifiant Meta (0191), unique
sur le numéro AFFICHÉ normalisé en E.164 (0193, `NUMERO_AFFICHE_SQL`, la même expression que la reprise), SANS clé
étrangère pour survivre à l'espace ; le crédit et son mouvement `offert` ne s'écrivent que si l'insertion a pris.
Un numéro retiré puis rajouté sous un autre identifiant ne repart donc pas avec 5 €. Les migrations ont marqué à
zéro les espaces qui avaient déjà un numéro (pas rétroactif). La création d'un espace n'offre rien : sans preuve,
l'offre s'y récoltait par script. Les raisons de mouvement sont listées par `RaisonMouvement`
(`src/agent/credits.ts`), et la lecture les rend telles qu'écrites.
⚠️ **L'historique du client** (`PgCreditStore.historique`) lit les `JOURS_HISTORIQUE` derniers jours, sur ses DEUX
branches (les tours d'agent agrégés par jour, et le reste tel qu'écrit) : l'index `(tenant_id, at desc)` ne
connaît pas la raison, donc une branche sans fenêtre parcourait tous les mouvements de l'espace. Une ligne
`achat` porte son paiement (`paiementId`, la session Stripe) et s'il a une facture (`facture`).

🔴 **LA RECHARGE PAR STRIPE** (lot 2, 2026-09-29, `src/http/credit-stripe.ts`, `src/stripe/`). Le client REST
est écrit sans SDK (formulaire `x-www-form-urlencoded`, `Stripe-Version` épinglée sur celle de la destination
webhook, `Idempotency-Key` sur chaque création, `client-<espace>` pour le client Stripe), avec un transport
injectable : aucun test n'appelle Stripe.
- `POST /tenants/:tenantId/credit/paiement` (admin, plafond coûteux) : le corps ne porte qu'une offre
  (`refill_50`, `refill_100`) ; le prix Stripe vient de la configuration, le crédit de `src/stripe/offres.ts`
  (dérivé du HT). Le client Stripe de l'espace est créé au premier achat et gardé PAR MODE (`stripe_clients`,
  clé `(tenant_id, livemode)`) : un client de test n'existe pas en live. 🔴 **Le prix est relu chez Stripe AVANT
  tout** (`lirePrixStripe`, la clé restreinte a les prix en lecture) : s'il ne vaut pas le HT de l'offre, en
  `eur`, la route rend 422 `prix_incoherent` et une trace `stripe_prix_incoherent`, sans rien créer, au lieu de
  laisser payer un paiement que le webhook refuserait de créditer. La session Checkout porte la taxe
  automatique, l'Adaptive Pricing ÉTEINT (le client paie en euros, que le webhook sait recouper), la collecte du
  numéro de TVA, l'adresse de facturation requise, la facture, et nos métadonnées (`tenant_id`, `offre`,
  `client_reference_id`). Une erreur de Stripe rend 422 lisible et son message part au journal, jamais au
  navigateur. Clé de test : seul un exploitant (`OPS_EMAILS`) peut payer (`creerPayeurAutorise`, dont le câblage
  est tenu par `tests/credit-cablage.test.ts`).
- `GET /tenants/:tenantId/credit/factures/:sessionId` (mêmes gardes, même règle du mode test) : le paiement se relit
  dans `stripe_paiements` DE CET ESPACE (`PgStripeStore.factureDe`), puis sa facture chez Stripe
  (`lireFactureStripe`, `GET /v1/invoices/{id}`, la clé restreinte doit avoir les factures en lecture) ; la route
  rend `{ url }` depuis `hosted_invoice_url`, https seulement. Paiement inconnu ou d'un autre espace : 404
  `paiement_inconnu`, sans appel à Stripe ; sans facture : 404 `sans_facture` ; facture sans page hébergée : 422 ;
  erreur de Stripe : 422, jamais 5xx. Le lien entre un mouvement `achat` et son paiement est une DONNÉE
  (`agent_credit_mouvements.stripe_session_id`, migration 0193, écrite par `crediterAchat` dans la transaction du
  webhook), jamais la note ; la reprise de 0193 a rattaché par la note, une fois, l'achat d'avant la colonne.
- `POST /webhooks/stripe` (classe `signature-service`) : 🔴 **la signature d'abord**, sur le corps brut
  (HMAC SHA-256 de `t.corps`, chaque `v1`, temps constant, cinq minutes), 401 sinon, avant toute lecture ;
  puis `safeParse`. Seuls `checkout.session.completed` payé et `checkout.session.async_payment_succeeded`
  créditent ; une session sans nos métadonnées rend 200 sans effet. Un événement d'un autre `livemode` que la clé
  configurée ne crédite rien (200, trace `stripe_mode_incoherent`). 🔴 **Le recoupement** : `amount_subtotal`
  doit valoir le HT de l'offre, en `eur`, et la référence désigner le même espace, sinon aucun crédit et une trace
  `stripe_paiement_incoherent`. 🔴 **L'idempotence** : UNE transaction (ligne `stripe_paiements`, clé primaire
  sur la session, puis crédit et mouvement `achat`) ; un conflit veut dire déjà crédité (rejeu de Stripe, ou
  second événement de la même session). Une panne de base rend 5xx et Stripe rejoue ; une session illisible rend
  422 pour la même raison. La réponse part dès la transaction passée : la remontée du plafond Vercel suit sans
  être attendue par Stripe (suivie par l'arrêt propre du processus, `travauxEnVol`).
- Le retour de Stripe se fait sur la page Crédit IA de la console (`APP_URL/parametres/credit`) et ne crédite
  rien : il relit le solde et l'historique, et reconnaît l'arrivée à la ligne `achat` postérieure au départ vers
  Stripe (`achatArriveDepuis`, `web/lib/api-credit.ts`), dès la première lecture : un solde comparé à lui-même ne
  « montait » jamais quand le webhook passait avant.
- La console ouvre la facture dans un onglet ouvert SYNCHRONEMENT au clic, qui reçoit son adresse ensuite (sinon
  bloqué comme fenêtre surgissante), `opener` coupé ; un échec referme l'onglet vide et se dit dans la page.

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

### 🔴 Le 502 après un `up --build` : la cause, et pourquoi il ne doit plus durer

Recréer un conteneur lui donne une nouvelle IP sur `mcp-robot_default`. Un `proxy_pass` qui écrit le nom en dur
est résolu au CHARGEMENT de nginx : il tape l'ancienne adresse jusqu'au `nginx -s reload`. C'était le cas des
quatre routes de `mba.` (le chemin des webhooks de Meta) ; elles passent par une variable depuis le 2026-10-03,
comme l'hôte `api.`, donc nginx relit l'adresse seul (au plus 10 s). Mesuré en recréant `mba-api` sans
recharger NPM : 502 pendant les 4 à 5 s du redémarrage lui-même, puis 200 sur les deux portes. ⚠️ **`docker
network connect` ne répare rien** : le conteneur est déjà sur le bon réseau. ⚠️ Une route ajoutée à
`advanced_config` avec un nom écrit en dur RAMÈNE le défaut : toujours `set $var conteneur;` puis
`proxy_pass http://$var:port;` (et un `rewrite` pour retirer un préfixe, qu'un `proxy_pass` par variable ne
retire pas).

🔴 **Le contrôle public reste obligatoire après CHAQUE `up --build`**, pas seulement quand on se méfie, et il se fait sur le BON chemin : sur un hôte à routage par chemin, une URL servie par un AUTRE
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

`/ops/verrou/:tenantId` (session d'exploitation, POST, note obligatoire) : pose ou retire le verrou d'un
espace (`tenants.status`). Il ferme la console ET l'API publique (`/v1`, `/mcp` rendent 403
`tenant_locked`). 🔴 Il n'arrête PAS les campagnes déjà enfilées : la séquence complète (verrouiller,
lister les campagnes en cours, les mettre en pause) est dans le runbook de `DEPLOY.md`.

`/ops/risque/:tenantId` (session d'exploitation, POST, note obligatoire) : lance TOUT DE SUITE le balayage du
risque de désengagement d'un espace, pour l'essai réel et le dépannage, et rend son bilan (fiches évaluées,
changements de niveau, automations déclenchées, passages au-delà du plafond, échecs). Il tourne DANS la
requête. Rejoué, il ne redéclenche rien : un passage en élevé déjà écrit n'en est plus un. Un espace
verrouillé n'est pas sauté (c'est un geste explicite). Son plafond est celui du JOUR, partagé avec la nuit : ce
que la nuit a déjà déclenché compte (`dejaDeclenches` dans le bilan). Les automations qu'il publie partent à
l'ouverture de l'espace (`departLe` dans le bilan) : tout de suite pendant les heures d'ouverture, sinon à la
suivante.

`/ops/usage` (session d'exploitation) : l'usage de l'API publique agrégé PAR MINUTE, par espace, par clé et
par opération, avec le TRAVAIL demandé (un lot de 50 contacts y compte 50, pas 1). En mémoire du process
qui sert la requête, jamais en base : une ligne SQL par appel ferait amplifier par la journalisation la
charge qu'elle observe. Aucun seuil n'est posé à ce jour, ces compteurs OBSERVENT.

`/ops/overview` (session d'exploitation) : rollup par tenant, charge des files, battement de chaque rôle de worker. Les DLQ non
vides déclenchent une alerte Telegram. Le SLO vit dans [docs/SLO-2026-09-01.md](docs/SLO-2026-09-01.md).

**La latence HTTP par route** (carte de `/ops/overview`, sur 24 h). Chaque requête de l'API est mesurée par un
crochet `onResponse` (`src/server.ts`), ou `onRequestAbort` sous le code 499 quand le client l'abandonne avant sa
réponse (ce sont les plus lentes, qu'`onResponse` ne voit jamais), sous le MOTIF de sa route (`req.routeOptions.url`, jamais l'adresse
réelle ; une adresse qu'aucune route ne reconnaît tombe sous `(aucune route)`), par méthode et code de retour,
dans des tranches de durée à bornes fixes (`BORNES_LATENCE_MS`, `src/ops/latence-http.ts`). Chaque copie vide sa
mesure chaque minute dans `http_latences` (fenêtres de cinq minutes, sous `NOM_API`), comme l'attente du pool :
`/ops` est servi par UNE copie et voit les autres par la table.
- p50 et p95 se tirent des tranches ADDITIONNÉES entre copies et fenêtres, parce qu'un centile ne s'additionne
  pas. Ce sont des MAJORANTS : la borne haute de la tranche, plafonnée par le maximum mesuré.
- La carte colore le p95 au-delà de 800 ms (le haut de la fourchette de l'audit du 2026-10-02), à partir de 20
  requêtes, sur ce qui DOIT être rapide : les webhooks entrants (Meta, Stripe, `/w/`, rapport RCS, HubSpot) et les
  lectures de l'Inbox. Pas ses écritures ni ses médias, ni le reste, lents par nature (envoi chez Meta, modèle,
  import, export) : ils crieraient au loup (`web/lib/latence-http.ts`).
- Au-delà de `MAX_LIGNES_PAR_VIDAGE` lignes entre deux vidages, une ligne neuve se replie sous
  `(au-delà du plafond)` : un robot qui balaie toutes les routes ne gonfle pas la table.
- Rétention `RETENTION_LATENCES_JOURS`, purgée par le balayage de rétention du worker. Écriture et lecture au
  mieux : une mesure ne fait jamais tomber ce qu'elle mesure.
- 🔴 Changer les bornes rend les lignes déjà en base incohérentes : vider la table dans le même déploiement.

---

## 11. Limites connues

**Elles vivent dans [todo.md](todo.md), et nulle part ailleurs.** Un « reste à faire » qui existe à deux
endroits en existe zéro : l'un des deux sera fait sans que l'autre le sache.

Les deux qui ont le plus de conséquences aujourd'hui :

- **Les plafonds qui restent par copie** (le plafond par utilisateur, les petits plafonds, § 7) : N copies les
  servent N fois, délibérément ; les plafonds qui bornent un espace, une identité ou un quota de Meta comptent au
  total depuis le lot B (2026-09-28).
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
   un événement par destinataire. Le défaut est « n'émet pas ». La pose d'une étiquette sur UN contact
   (`src/crm/poser-etiquette.ts`), commune aux cinq portes unitaires, n'a pas de défaut du tout : `publier` y
   est une option REQUISE, que l'agent et la fiche passent à vrai, le widget, l'outil MCP et le bloc de scénario
   à faux (l'exécuteur publiant à part, selon le lancement).
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
   ⚠️ Elle est mise en cache 5 s par process (`NUMERO_DELIE_TTL_MS`) : un envoi peut encore partir 5 s après
   « Délier », du worker comme de toute copie de l'API autre que celle qui a servi le geste (elle seule vide son
   cache ; aucune invalidation ne traverse les processus, et cette fenêtre de 5 s est acceptée). Dans l'autre
   sens, le worker ou une autre copie peut refuser à tort pendant 5 s après « Relier » : aucune pause `numero_delie` ne s'écrit sans relecture en base hors cache
   (`numerosDelies.pauserCampagne`, `PgNumeroDelieStore.pauserCampagne` : une seule instruction, `status in
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
   (`PgStatsStore.messagesEcritsParMba`, dépendance requise de la route) ;
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
| `src/http/scope.ts` | `scopeTenant` (la RÈGLE d'accès tenant), `etapeEspace` et `monterAvecEtapeEspace` (où elle s'applique : au montage des modules `tenant`, jamais dans un handler), `espaceVerifie` (ce qu'un handler de route `:tenantId` lit : l'espace vérifié, et il lève sans l'étape), `nonEmpty`, `estUuid` |
| `src/api/modele-envoi.ts` | ce qu'un envoi de l'API sait d'un template : `modeleLuDe` (la construction de la lecture partagée `templateVarInfo` ET du catalogue `/v1/templates`), `raisonNonEnvoyable` (ce qu'aucun envoi ne peut faire partir) et `verdictModele`. Le catalogue n'annonce que ce que l'envoi accepte |
| `src/server.ts` -> `modulesDeRoutes` | 🔴 le point de passage OBLIGÉ pour monter un module de routes. Chaque entrée déclare sa `ClasseDAcces` (six valeurs, pas deux), et la couverture du garde-fou d'authentification s'en DÉRIVE au lieu d'être recopiée, comme l'étape d'espace (posée par `entree` sur les seuls modules `tenant`). Monter une route ailleurs la sort du garde-fou et de l'étape : si elle lit l'espace par `espaceVerifie`, elle rend un 500 au lieu de servir, sinon aucune erreur ne le dit |
| `src/crm/contact-store.pg.ts` -> `MATCH_BY_WAID_SQL` | résoudre un contact par `wa_id` (E.164 exact, chiffres nus, BSUID) |
| `src/crm/identity.ts` -> `waIdOfTarget` | la règle wa_id pour une cible d'envoi |
| `src/api/fiche.ts` -> `resoudreFiche` | 🔴 trouver la fiche d'une personne à partir des clés reçues par l'API publique. Une seconde résolution divergerait sur la règle multi-clés, et une personne aurait deux fiches |
| `src/api/consentement.ts` -> `appliquerConsentement` | le consentement écrit par une machine, et sa ligne d'audit |
| `src/api/erreurs.ts` | `STATUT_PAR_CODE` et `refuser` : la forme `{ error, code }` des erreurs de `/v1/contacts`, `/v1/sends`, `/v1/messages/whatsapp`, `/v1/messages/rcs`, des catalogues et de la garde de clé ; tout nouveau refus de l'API publique passe par là |
| `src/crm/date-iso.ts` | normaliser une date venue d'un tiers, et REFUSER l'ambigu en le disant |
| `src/crm/contact-filters.ts` | les règles de filtrage des contacts (bornes, opérateurs, plafonds), et le refus d'un niveau de risque inconnu (`FiltreContactInvalide`, 400) |
| `src/crm/csv.ts` -> `separateurCsv`, `parseCsv` | 🔴 le séparateur d'un CSV reçu d'un client, ESSAYÉ dans l'ordre (point-virgule, tabulation, virgule, barre) : le premier qui rend, sur les 50 premières rangées, un tableau régulier d'au moins deux colonnes l'emporte. Laissée seule, la devinette de papaparse prend la virgule dès que les cellules d'un fichier en point-virgule en portent assez (une réponse de FAQ, une adresse). L'import de contacts et son aperçu, l'import de FAQ de l'agent de Meta et la connaissance d'un agent y passent ; sans tableau régulier, `parseCsv` retombe sur la devinette et la connaissance lit du texte libre. Une seconde règle lirait le même fichier autrement selon l'écran. 🔴 `parseCsv` refuse AVANT la lecture, par `CsvTropGros` (un 400 lisible sur chacune de ses routes), deux formes qui tiendraient la boucle d'événements plusieurs secondes : plus de 1 048 576 lignes, lignes vides comprises (le maximum d'Excel ; fins de ligne `\n` et `\r` comptées à part, le plus grand l'emporte, puisque papaparse prend l'une, l'autre ou les deux), ou un en-tête de plus de 16 384 colonnes, le maximum d'Excel aussi. L'en-tête compté est la plus large des rangées jusqu'à la première non vide, parce que papaparse prend pour en-tête une première rangée de séparateurs seuls (il renomme ses doublons avant de sauter les vides). ⚠️ Ces bornes ne bornent PAS le temps de lecture : d'autres formes, sous elles, coûtent des secondes à des minutes (`todo.md`), d'où la lecture hors de la boucle (`src/lib/hors-boucle.ts`) : les routes appellent `parseCsvHorsBoucle`, jamais `parseCsv`. 🔴 Une cellule absente reste absente, ses lecteurs la lisent comme vide : compléter chaque rangée jusqu'à la largeur de l'en-tête coûtait en-têtes x rangées |
| `src/engagement/risque.ts` | 🔴 la grille du risque de désengagement, en règles PURES (`calculerRisque`), ses niveaux et ses codes de raisons (`NIVEAUX_RISQUE`, `RAISONS_RISQUE`), les seuils par défaut et `passeEnEleve`. La base (CHECK de 0178), l'API, les signaux et la console (`web/lib/risque.ts`, par `tests/web-risque-parite.test.ts`) lui sont tenus |
| `src/inbox/evenements.ts` | 🔴 le journal des événements d'une conversation : ses types (miroir du CHECK en vigueur, celui de 0194, et de `web/lib/inbox-detail.ts`, tenus par deux tests), `AuteurDuChangement` (le paramètre requis de toute écriture de l'Inbox), `colonnesAuteur` (un identifiant qui n'est pas un uuid devient nul avant la base, et porte une cause), `automatique` (la forme d'une cause), `auteurDeLEnvoi` (qui prend le fil en écrivant) et `acteurSql` (l'acteur résolu DANS l'espace) |
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
| `src/auth/totp.ts` | 🔴 le second facteur sur `node:crypto` seul : base32 RFC 4648 (PAS l'alphabet Crockford de `src/ids/code.ts`, qu'une application d'authentification décoderait autrement), `codeAuPas`, `verifierCode` (fenêtre de plus ou moins un pas, anti-rejeu par le dernier pas, comparaison en temps constant), `uriOtpauth`, et les codes de secours (`genererCodesSecours`, `empreinteCodeSecours`) |
| `src/auth/mfa-store.pg.ts` -> `PgMfaStore` | l'état du second facteur d'une IDENTITÉ : chiffrement du secret, activation qui ne remplace jamais un facteur actif, pas et code de secours consommés par un `update` conditionnel, réinitialisation (refusée à un admin d'espace pour une identité multi-espace). `tests/mfa.ts` en porte le double en mémoire, aux mêmes conditions |
| `src/auth/routes.ts` -> `apresLeMotDePasse`, `suiteDeConnexion` | 🔴 la porte du second facteur, et la suite d'une connexion (session si un espace, jeton de choix sinon). UNE fonction pour la connexion, `/auth/mfa/verifier` et `/auth/mfa/activer` : trois copies divergeraient sur « ouvrir ou demander ». Une étape d'exploitation (`etape.ops`, via `entreeOps`) y passe aussi : toujours le code ou l'enrôlement, puis une session d'exploitation, signée seulement avec le moyen vérifié que seules les deux routes du code passent |
| `src/auth/middleware.ts` -> `makeRequireOps`, `auteurOps`, `estAdresseOps` | 🔴 la garde de `/ops` (session d'exploitation, puis l'adresse relue en base dans `OPS_EMAILS` et le facteur toujours actif, à CHAQUE requête), l'auteur d'une écriture d'exploitation (échoue fermé sans la garde), et la comparaison d'une adresse à la liste (sans la casse, liste vide = personne). Une seule garde, construite par `buildServer` (`Gardes.ops`) pour les deux modules `session-ops` |
| `src/lib/adresse-privee.ts` | `resolutionPublique` : ce qu'un texte d'URL ne peut pas voir |
| `src/lib/page-distante.ts` | `urlRecuperable` (garde SSRF) et `fetchUrlBorne` (redirections revalidées saut par saut ; 10 s par saut, et le signal facultatif d'une requête l'arrête plus tôt). 🔴 L'aperçu et l'import d'un site (`src/http/agent-knowledge.ts`) ont une échéance de 30 s de réseau par requête (`ECHEANCE_PARCOURS_MS`), passée à chaque lecture de page et à `visiter` : NPM coupe à 60 s sans réponse (aucun `proxy_read_timeout` posé, donc le défaut de nginx) et un parcours n'avait aucune durée maximale, une page écartée ne comptant pas dans les cinquante. L'aperçu dit alors `tempsAtteint`, y compris quand l'échéance coupe la dernière page de la file ; l'import écrit ce qu'il a lu et rend les pages qu'il n'a pas eu le temps de lire (`restantes`), que la console propose d'un clic et garde jusqu'au prochain import ; chaque coupure est journalisée (`parcours_coupe`). 30 s de réseau, 3 s de résolution DNS (`DELAI_RESOLUTION_MS`), 20 s de lecture (`LECTURE_PAGES`) et, pour l'import, ses écritures (une transaction par page, après les lectures) tiennent sous les 60 s : la somme est tenue par un test, aucune des trois constantes ne se change seule. L'import nomme aussi les pages qui ont atteint le plafond de fiches (`tronquees`) : l'écran comparait le total écrit au plafond par page |
| `src/lib/corps-borne.ts` | lire un corps distant EN FLUX, avec ses trois verdicts : `lireCorpsBorne` pour du texte, `lireOctetsBornes` pour du binaire (une image), qui ne décode pas en UTF-8 |
| `src/lib/hors-boucle.ts` -> `avecLecteur`, `horsBoucle` | 🔴 lire un fichier déposé par un client, ou les pages d'un site, HORS de la boucle d'événements, dans un worker qu'on peut tuer. Un lecteur (`avecLecteur`) garde son worker le temps d'une requête et le tue quand elle finit : plusieurs lectures, une à la fois, sous une échéance CUMULÉE (10 s par défaut, 30 s pour un document, 20 s pour les pages d'un aperçu ou d'un import de site, qui ne paient ainsi qu'un démarrage) ; `horsBoucle` en est la lecture unique. 1 Go de tas, quatre lectures EN COURS à la fois (429 au-delà, sans démarrer de worker ; un lecteur qui attend le réseau n'en occupe aucune, et il rend son worker après 5 s sans lecture, `REPOS_MS` : ce plafond borne les lectures, pas les workers vivants, qui pèsent 15 à 25 Mo au repos), chaque refus journalisé (`lecture_interrompue`), résultat rendu en JSON. 🔴 Ce qui revient au fil principal n'est pas borné par le worker : chaque lecture n'y rapporte que ce dont sa route a besoin, sous une forme compacte (`parseCsvHorsBoucle` rend les rangées indexées par numéro de colonne, `apercuCsvHorsBoucle` quatre rangées, `lireDocumentHorsBoucle` les seules fiches, en un seul worker par document). `extraireDepuisCsvHorsBoucle`, `extraireDepuisHtmlHorsBoucle`, `texteEnFichesHorsBoucle`, `pageEnFichesHorsBoucle` et `liensDeLaPageHorsBoucle` complètent la liste (`visiter` reçoit l'extraction des liens en paramètre, sans défaut), et `tests/lecture-hors-boucle-inventaire.test.ts` refuse ailleurs tout appel direct comme tout passage en référence : sous toutes les bornes de forme, des fichiers de quelques centaines de Ko, et des pages de quelques dizaines, figeaient l'API des secondes à des minutes, pour tous les espaces. L'import d'un site lit et découpe toutes ses pages AVANT d'en écrire une : un refus en cours de route n'en laisse aucune à moitié |
| `src/lib/cache-court.ts` | le micro-cache du dépôt : durée de vie ET mutualisation des appels en vol |
| `src/lib/journal.ts` -> `journaliser` | la ligne de journal JSON du dépôt (`{ lvl, msg, ... }`). 🔴 `req.log` et `app.log` sont MUETS (`logger: false`). Une `Error` y garde son message, sa CAUSE sur un niveau (un `fetch failed` sans son `ENOTFOUND` ne dit rien) et sa pile au niveau `error` ; un champ illisible est remplacé SEUL, sans emporter ses voisins ; elle ne lève jamais. L'espace s'y écrit `tenantId`, tenu par un test |
| `src/meta/numero-espace.ts` | le numéro Meta d'un espace, mis en cache. 🔴 Il ne garde QUE les réponses POSITIVES : une réponse nulle devient fausse à l'instant où un client branche son premier numéro, et le cache étant par process, aucune invalidation ne traverse l'API et le worker. C'est ce qui rend acceptable de mettre en cache une décision |
| `src/lib/http-get.ts` | une lecture GET injectable, testable sans réseau |
| `src/lib/heures-ouvrees.ts` -> `prochaineOuverture` | « quand est le prochain créneau ouvert ? », pour le bloc Attente et les campagnes |
| `src/lib/heures-ouvrees.ts` -> `fenetreDeRattrapageOuverte` | « a-t-on le droit de RATTRAPER maintenant ? ». 🔴 Autre question que `business_hours_only` (l'envoi initial, côté moteur), et une semaine entièrement fermée y rend `true` : sinon ses rattrapages gèlent pour toujours |
| `src/lib/heures-ouvrees.ts` -> `tempsOuvre`, `mesureurDeTempsOuvre`, `horairesExploitables` | « combien de temps OUVRÉ entre deux instants ? », pour le Quantitatif > Performance. Temps brut quand l'espace n'a aucun créneau exploitable, et l'appelant le dit |
| `src/lib/adresses-publiques.ts` | les adresses que le produit DISTRIBUE (`/r/`, `/m/`, `/w/`) |
| `src/agent/devise.ts` | dollars du Gateway -> micro-euros, en UN endroit |
| `src/agent/modeles.ts` | les modèles proposables et leur tarif client : le menu ET la garde d'écriture y lisent |
| `src/llm/errors.ts` -> `direPanneModele` | ce qu'un échec d'appel au modèle a le droit de dire au client, ou `null` : c'est alors NOTRE panne, que l'appelant RELANCE en 500 opaque. ⚠️ `fetch failed` et un abandon n'y sont attribués au modèle que parce que, dans ses quatre appelants, le seul `fetch` est l'appel au modèle |
| `src/agent/llm/tool-schema.ts` -> `paramsOutil` | 🔴 la séparation des sources d'un paramètre (`modele` vs `contact` ou `fixe`). Deux lectures divergentes rendraient la cible au modèle, donc un IDOR |
| `src/agent/setup/proposition.ts` | ce que l'IA de construction a le DROIT de proposer. 🔴 La FRONTIÈRE est la liste des CLÉS et les énumérations FERMÉES, jamais une longueur : les bornes sont de l'hygiène, et `assainirProposition` les RAMÈNE avant que Zod ne juge, au lieu de perdre le tour. ⚠️ Toute borne appliquée est annoncée dans le schéma envoyé au modèle, et un test le dérive plutôt que de le relire |
| `src/crm/poser-etiquette.ts` | 🔴 poser une étiquette sur UN contact, le geste des cinq portes unitaires (agent IA et agent de Meta, bloc de scénario, widget, outil MCP `tag_conversation`, fiche contact) : nettoyer (`normaliserEtiquette`, `nettoyerEtiquettes` : espaces, 64 caractères, vides et doublons), poser, déclarer dans le référentiel (au mieux), et publier `tag_added` sur les seules nouvelles, SI l'appelant le demande (`publier`, requise). `apresPose` sert la fiche, qui pose dans la transaction d'`applyEdits` ; `publierEnDiffere`, l'exécuteur. Construit une fois par `buildWorkflowRuntime`, rendu à l'API et au worker. Les chemins de masse (import, API publique, action en masse) n'en prennent que le nettoyage |
| `src/agent/contexte.ts` | ce que le cerveau doit savoir d'un agent (production ET bac à sable), et `lireContexteAvecReglages`, la lecture UNIQUE des réglages de l'espace pour ses deux politiques, branchée par le worker ET par l'API |
| `src/agent/fiche.ts` | les DEUX schémas de fiche : celui qui LIT, celui qui PATCHE |
| `src/webhooks/json.ts` | `asArray`, `asRecord`, `texteNonVide`, `objetOuNull` : lecture défensive d'un JSON tiers (payload Meta, réponse MCP, schéma d'outil) |
| `src/queue/names.ts` | les files, leur cadence, leur DLQ, leur réveil |
| `src/signaux/types.ts` | 🔴 le DICTIONNAIRE des signaux remontés vers l'outil d'un client, indépendant de tout outil : noms d'événements et d'attributs, noms des CHAMPS de chaque événement (`CHAMPS_EVENEMENT`), borne des textes, résumé en morceaux, `idSignal` (l'`em_event_id` STABLE et opaque), `identifiantPoussable` (la fiche se pousse-t-elle, et sous quel identifiant : une règle pour le complément et pour l'adaptateur), libellé neutre du journal des erreurs. Un adaptateur le traduit, il ne l'étend ni ne le renomme. La documentation publique (`web/lib/signaux-dictionnaire.ts`) lui est tenue par `tests/web-signaux-parite.test.ts`, sans nommer aucun outil |
| `src/signaux/emetteur.ts` | 🔴 le SEUL point d'émission d'un signal : il ne lève jamais, ne lit rien tant qu'aucun espace n'a branché d'outil, ne transporte que ce que le chemin chaud sait déjà, et enfile des jobs bornés (`SIGNAUX_PAR_JOB`) avec leur priorité (`PRIORITE_SIGNAL` : les accusés derrière). La fiche, l'origine et l'analyse se relisent au moment de pousser (`completer.ts`) |
| `src/signaux/completer.ts` | relit, au moment de pousser, ce qu'un signal ne transporte pas (fiche et consentement courants, contexte d'un message, lien, analyse). 🔴 CONTRAT : il porte la règle d'identité de l'adaptateur actuel (`identifiantPoussable`, une fiche ne se pousse que sous son `externalId`, sinon ni contexte ni lien ne sont relus). Un adaptateur qui désignerait un profil autrement devra lui passer SON critère, sinon il recevrait des signaux amputés sans erreur |
| `src/salesforce/client.ts` | 🔴 le SEUL client de l'API d'une org Salesforce : jeton client credentials par org (cache par process, un seul renouvellement sur `INVALID_SESSION_ID`), `fetchPublic` et lecture bornée (l'adresse est saisie par un client), classement des erreurs sur le CODE de Salesforce et non sur le statut, refus d'adresse et redirection définitifs AVANT tout rejeu, quota du client relevé à chaque réponse. L'adresse passe d'abord par `lireMyDomain` (`src/salesforce/my-domain.ts`), et la connexion d'une org par `src/salesforce/connexion.ts` (contrat avec le package figé là) |
| `src/ids/code.ts` | les identifiants publics et les codes de lien |
| `src/db/verrous-courts.ts` -> `VerrousCourts` (`PgVerrousCourts`) | 🔴 ce qui ne doit arriver qu'UNE fois pour toutes les copies de l'API : `prendre(clés)` rend une prise ou `null` (toutes les clés ou aucune, une clé échue se reprend), `relacher(prise)` ne libère que ce qui porte encore son jeton, `prolonger(prise, durée)` repousse l'échéance tant que le jeton tient (`false` sinon : le travail gardé doit s'arrêter). Un `Set` ou une `Map` en mémoire pour ce rôle ne voit qu'une copie. Chaque usage préfixe ses clés (`mba-envoi:`, `mba-publication:`, `es-code:`, `ops.alerte`). Un délai « pas deux fois en N secondes » est une prise jamais relâchée. Le double des tests vit dans `tests/verrous.ts`, jamais dans `src/` |
| `src/db/debit.ts` -> `CompteurDebit` (`PgCompteurDebit`, `memoireDesPleines`) | 🔴 ce qui doit être tenu au TOTAL des copies de l'API : `compter(fenêtres)` compte un appel dans toutes ses fenêtres ou aucune, seulement s'il tient sous chaque plafond, et rend l'état de chacune sur l'horloge de la base ; `lister(préfixe)` sert `/ops/usage`. Une `Map` de compteurs en mémoire pour ce rôle sert N fois le plafond. Chaque usage préfixe ses clés (`api.minute|`, `couteux|`, `connexion.login|`, `usage|`, `ops.refus`). Le compteur en mémoire (`debit.memoire.ts`) est le défaut d'un serveur sans base et le double des tests, jamais un câblage de production (`tests/debit-cablage.test.ts`) |
| `src/auth/plafond-partage.ts` -> `PlafondPartage`, `consommerPartageAvecEntetes` | un plafond à une fenêtre dans le compteur partagé, avec sa politique OBLIGATOIRE si la base ne répond pas (`siLaBaseEchoue` : `laisser-passer` pour ce qui protège la charge, `refuser` pour ce qui protège d'une attaque). Le plafond de l'API publique a ses deux fenêtres dans `plafond-espace.ts` |
| `src/lib/en-vol.ts` -> `creerTravauxEnVol` | 🔴 un travail qu'une réponse HTTP laisse derrière elle et dont la perte a une conséquence pour quelqu'un (un envoi du relais annoncé « c'est parti », le signal d'un clic que l'outil du client attend) se confie ici : `arreterApi` (`src/shutdown.ts`) l'attend, borné, avant de fermer la file et le pool. ⚠️ Restent des `void` hors suivi, qu'un arrêt de copie peut couper, et c'est accepté : les écritures d'observation (horodatage de connexion et d'usage d'une clé, lignes d'audit d'un échec de connexion ou du second facteur, compte d'un refus de `/ops`) et l'e-mail du mot de passe oublié (la réponse ne promet rien, l'utilisateur redemande) |
| `src/db/transaction.ts` -> `enTransaction` | LA transaction du dépôt : `begin`, `commit` si le travail rend, `rollback` s'il lève, connexion relâchée dans tous les cas (y compris un `rollback` qui échoue), et c'est l'erreur D'ORIGINE qui remonte. ⚠️ Rendre sans lever VALIDE : un travail qui a écrit et ne doit rien laisser doit lever (`PgUserStore.deleteUser` garde donc sa transaction à la main) |
| `src/worker/taches.ts` -> `programmer(nom, cadence, passe, { immediat, enEchec })` | les tâches périodiques du worker. `immediat` lance la passe de démarrage SOUS la même garde de ré-entrance que les autres ; `enEchec` porte le journal et l'alerte (`echecDeBalayage`, `src/worker.ts`). Une passe lancée à côté (`void passe()`) échappe à la garde |
| `src/lib/tenter.ts` -> `tenter` | une étape ISOLÉE : son échec est journalisé (`console.error(echec, message)`) puis avalé |
| `src/lib/erreur.ts` -> `messageDe`, `texteDe` | le message d'une valeur levée : `messageDe` rend la valeur elle-même si ce n'est pas une `Error`, `texteDe` la convertit en texte. Un repli différent (« erreur inconnue ») reste sur place |
| `src/meta/graph.ts` -> `appelGraph` | l'appel Graph authentifié des clients WhatsApp (modèles, flows, lecture du numéro, ajout et vérification d'un numéro, média entrant) : `Bearer`, `fetch` injectable, `MetaApiError` si non-2xx. ⚠️ Ni `ClientGraph.call` (plafond de durée, `ErreurGraph`), ni `MbaClient`, ni le transport des envois |
| `src/campaign/enqueue.ts` -> `relanceurDeCampagnes` | l'enfilement d'un run au débit RÉSOLU sur la configuration du process : les relances du worker (hors planification et reprise après plafond, qui résolvent le débit dans leur balayage) et l'envoi de l'API publique |
| `src/stats/chiffrage.ts` -> `creerChiffrage` | 🔴 toutes les lectures de COÛT de la console (statistiques, fiche de campagne, bilan contact) : le tarif Meta et son cache (60 s, un par process, `null` jamais mémorisé), la marge, la classification RCS simple ou conversationnel (`repartirRcs`) et la lecture des liens tracés d'un scénario (`liensDesTemplates`), écrites une fois. La racine le construit et passe ses membres aux routes ; `tests/chiffrage.test.ts` l'exécute contre de faux dépôts |
| `src/pubs/connexion.ts` -> `creerConnexionPub` | la connexion publicitaire d'un espace : jeton chiffré au repos et déchiffré à la demande, connexion concurrente, révocation (Meta d'abord, puis la base), état du compte en cache 2 min, dépôt de jeton par `/ops` |
| `src/inbox/fil.ts` -> `creerControleDuFil` | 🔴 le contrôle du fil : les gestes qui confient, reprennent ou passent une conversation (agent de Meta, scénario, équipe), l'ordre « Meta d'abord, la colonne ensuite », les gardes (agent allumé, `only`, fil de test, parcours en attente, détenteur relu avant Meta, opérateur épargné par un démarrage du client), l'événement `message_sans_suite` et la marque d'escalade. Seul appelant de `setControlOwner`, `demanderReleaseMba`, `consommerReleaseMba` et du `release` de Meta ; `tests/fil.test.ts` exécute sa table |
| `src/inbox/delai-reprise.ts` -> `repriseDue`, `delaiHumainMs` | 🔴 le délai de reprise d'un fil tenu, une seule règle pour le balayage (`runControlSweep`) et la remise « personne ne suit » (`remettreSiPersonneNeSuit`) : escalade sans réponse jamais échue, délai nul ou absent = jamais, fil non daté échu ; le réglage de l'espace prime sur `CONTROL_HUMAN_TIMEOUT_MS`. Sans la fenêtre de service, que seul le balayage lit ; `tests/fil-delai-reprise.test.ts` |
| `src/mba/liste.ts` -> `creerListeDeLAgent` | 🔴 la liste de l'agent de Meta (`mba_liste`, migration 0195) : ajouter (Meta puis la ligne, défait si la ligne échoue), retirer (Meta puis la ligne, un rejeu, un 404 vaut retrait, une panne de la table lève), retirer avant un modèle sous les deux formes du numéro (`formesDuNumero`, `RetraitDeLaListeRefuse`), lire qui y est. Seul appelant des routes `allowlist` de Meta ; `tests/mba-liste.test.ts` |
| `src/socle.ts` -> `construireSocle` | 🔴 ce que l'API et le worker doivent construire À L'IDENTIQUE : les dépôts communs, le dépôt de contacts décoré (un opt-out écrit par l'un ou l'autre processus est annoncé et signalé), la pile d'envoi Meta et ses freins, la clé de modèle par espace (avec son signalement d'échec de déchiffrement), le résolveur e-mail, le numéro de l'espace en cache, le contrôle du fil, le runtime de scénario. Il reçoit le pool, la file et la configuration : chaque processus garde son pool, sa file et ses caches. `tests/socle.test.ts` le construit contre un faux pool et une fausse file |
| `src/stats/cost.ts` -> `chiffrer`, `chiffrerVolume`, `round2` | « chiffrable ou pourquoi pas », pour une catégorie ou un volume ; `round2`, l'arrondi au centime des coûts |
| `src/meta/pubs-creation.ts` -> `lireDepenses` | le suivi d'une publicité en UN appel par paquet de 50 campagnes : le cumul (dépense, clics sur le lien, impressions, couverture) et, sous l'alias `.as(jours)` de la même expansion `insights`, la dépense jour par jour (forme mesurée le 2026-09-30). Les jours sont lus À PART du cumul (une forme inattendue ne le fait pas perdre) ; les comptes passent par `entierOuRien`, une colonne entière refusant `2.5` ferait tomber le balayage de l'espace |
| `src/pubs/publicites.pg.ts` -> `coutParPub` | 🔴 le coût par engagé des publicités sur une PÉRIODE (carte Coûts) : la dépense des jours de la période (`pubs_depense_jour`, 0198) et les PERSONNES arrivées par la campagne dans la période. Un engagé a cliqué PUIS écrit, ce n'est pas un prospect qualifié. Les jours sont ceux du compte publicitaire, les arrivées bornées à l'heure de Paris |
| `src/crm/transition-consentement.ts` | 🔴 LA transition du consentement WhatsApp d'une fiche : qui lève un STOP (`LEVE_UN_STOP`, par autorité typée), ce que deviennent statut, `opt_out_at` et `opt_in_source`, et qui est passé à `opted_out` (à annoncer). Les six écritures de `PgContactStore` la composent (`affectationsDUpsert`, `ecritureDuConsentement`) ; une septième copie divergerait, comme deux l'ont fait (738a7c3d) |
| `src/crm/contact-store.pg.ts` -> `projectionPourTiers` | 🔴 la fiche projetée pour tout ce qui sort vers un tiers (connecteur, opt-out poussé, relais de l'agent de Meta, `mba_lire_contact`) : nom, tags, champs, JAMAIS le numéro, le BSUID ni l'opt-in |
| `src/workflow/lancements.ts` -> `creerLancements`, `POLITIQUE_DE_LANCEMENT` | 🔴 le seul chemin pour démarrer un parcours : un TYPE de lancement (liste fermée) et sa politique (reprise du fil, publication des étiquettes, graphe joué, garde de fenêtre), lue par `WorkflowExecutor.demarrer`. Un câblage choisit un type, jamais un réglage ; `tests/workflow-lancements.test.ts` exécute la table |
| `src/workflow/engine.ts` -> `FENETRE_SERVICE_MS` | la fenêtre de service de Meta (24 h), pour le balayage de contrôle et la fenêtre ouverte de l'Inbox |
| `src/crm/render.ts` -> `escapeHtml` | l'échappement HTML du dépôt (gabarits d'e-mail, pages d'erreur des liens tracés) |
| `src/stats/range.ts` -> `isValidDateStr` | une date `YYYY-MM-DD` qui EXISTE (aller-retour strict), lue aussi par la grille de prix |

### Front

| Module | Ce qu'il porte |
|---|---|
| `web/lib/format.ts`, `web/lib/day.ts` | les seuls porteurs des tags BCP47. ⚠️ Un nombre affiché passe par `fmtNum`, jamais par un `toLocaleString('fr-FR')` écrit sur place : celui-là ignore la langue choisie |
| `web/lib/cout-moyen.ts` -> `coutMoyenParEngagement`, `coutToutConfondu` | 🔴 le chiffre du haut de la carte Coûts : le rapport des TOTAUX, pas la moyenne des ratios. Une campagne sans coût connu sort des deux termes, une campagne sans engagé GARDE sa dépense (Julien, 2026-09-30). Campagnes push et publicités ne se réunissent que dans une même devise connue, sinon le chiffre reste celui du push et `raison` fait dire pourquoi |
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
| `web/lib/inbox-detail.ts` | le panneau Détail de l'Inbox : la validation de sa réponse (`lireDetail`, une réponse mal formée replie le panneau), les phrases de la frise, et son repli retenu par navigateur (dans un try/catch) |
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
