# Référence Meta Business Agent (MBA) API v2.0.0

> **Ce que c'est.** La transcription complète et vérifiée de la documentation officielle Meta Business
> Agent v2.0.0, telle que téléchargée par Julien le 2026-07-20 dans `mba documentation/` (34 fichiers :
> guides markdown + specs OpenAPI). Objectif : permettre d'écrire le client HTTP sans rouvrir les specs.
>
> **Autorité.** En cas de contradiction entre un guide Meta et une spec OpenAPI, **c'est la spec qui fait
> foi**. Le cas le plus important est documenté au chapitre « Contrôle du fil » (`pass` contre `release`).
>
> **Fiabilité.** Chaque chapitre a été rédigé depuis les fichiers sources, puis relu par un agent
> adversarial qui a rouvert les specs pour prendre le chapitre en défaut. 11 erreurs et 53 omissions ont
> été corrigées. Ce qui reste incertain est rassemblé au chapitre « Ce que la doc ne dit pas », et n'est
> pas comblé par des suppositions.
>
> **Ce document n'est pas une feuille de route.** Il décrit ce que Meta expose, pas ce qu'on construit.

## ⚠️ Ce qui a changé chez Meta depuis cette transcription (relevé du 2026-08-18)

La transcription ci-dessous date du **2026-07-20**. Entre le 11 et le 15 août, la veille
(`ops/mba-docs-watch.mjs`) a signalé **neuf modifications** sur les pages suivies, dont **une page
entièrement nouvelle**. Les pages ont été retéléchargées et comparées chapitre par chapitre, puis chaque
écart a été re-vérifié contre le texte de Meta par un second lecteur : **20 écarts confirmés sur 24
rapportés**. Ce qui suit ne liste que les confirmés, avec la citation d'origine.

Les chapitres concernés ont été corrigés SUR PLACE quand ils étaient devenus faux (contrôle du fil).
Le reste est consigné ici, sans réécrire la transcription.

### 🔴 Contrôle du fil : l'action `take` existe (corrigé sur place, chapitre « Contrôle du fil »)

> « `take` acquires thread control from the current owner and is restricted to the configured escalation
> partner. » · « `pass` is reserved for future use **and is not currently accepted**. »

Le résumé de l'endpoint est passé de « Release thread control » à « **Release or take** ». Un champ
`metadata` apparaît (chaîne libre relayée à l'app receveuse dans le webhook `messaging_handovers`).

**Ce que ça change vraiment** : notre thèse « il n'y a pas d'endpoint take control » est morte, et notre enum
client à deux valeurs rejetterait une valeur valide. **Ce que ça ne change pas encore** : `take` est réservé
au « configured escalation partner », une notion que Meta ne définit nulle part, dont la procédure de
désignation est inconnue et dont rien ne dit qu'elle nous soit ouverte. La prise de contrôle par envoi d'un
message reste le seul chemin vérifié. Question à instruire avant de concevoir le handoff.

### 🟠 Réglages : le handoff pilote enfin le contrôle du fil

Notre transcription posait, à trois endroits, que le lien entre `handoff.enabled` et le transfert de contrôle
n'était **pas documenté** et devait être mesuré. Meta le documente désormais :

> « Controls whether the agent will release thread control after sending a handoff message. true = agent will
> release control, false = agent will not release control. »

Et la source du message devient réglable :

> « Controls the source of the consumer-facing handoff message. CUSTOM: the business supplies its own handoff
> message. AGENT: the AI agent composes a handoff message for each conversation. DEFAULT: a fixed, standard
> handoff message is used. »

⚠️ **Le nom exact de ces deux champs n'est pas lisible dans le rendu extrait**, seulement leur description :
à relever avant de coder. Reste inconnu : **sur quel webhook arrive la suite de la conversation** après
libération. Le protocole de test décrit plus bas reste donc à jouer.

**Piège de conception qui en découle** : `settings` est une ressource en REMPLACEMENT COMPLET. Un modèle typé
fermé côté console (Zod ou interface qui ne connaît que `enabled` et `message`) DÉPOUILLERAIT ces champs au
read-modify-write et les remettrait à leur défaut sans que personne l'ait demandé. Sur cette ressource, les
clés inconnues doivent être repassées telles quelles.

### 🟠 Réglages : `never_say_phrases` est documenté, avec une sémantique d'écriture à part

> « Exact phrases the AI agent must never include in a response. Each turn is checked against this list and a
> matching response is withheld. **Provide the full replacement list; omit to leave the current list
> unchanged, or send an empty list to clear it.** »

Le champ avait été mesuré en live le 2026-08-18 (`never_say_phrases: []`) ; c'est sa sémantique qui est neuve.
Noter la contradiction interne de la page : la règle générale du PUT dit « All fields must be provided for a
complete replacement », mais ce champ-là est explicitement omissible. Suivre la règle du champ.

### 🟠 Un moyen de paiement conditionne la LIVRAISON, pas seulement l'activation

> « Set up billing before you turn your agent on. Meta Business Agent messages are not delivered unless your
> Business Agent account has a payment method attached. »

C'est cohérent avec l'écran WhatsApp Manager, qui liste « Payment method » parmi les 5 tâches obligatoires.
À dire au client à l'onboarding : sans moyen de paiement, l'agent ne répond pas, et rien ne le signale côté
console.

### 🟢 Test d'agent : les jetons consommés ne sont pas facturés

> « Tokens consumed while testing through this endpoint are not billed. »

Écrit deux fois dans la page. Le bac à sable `agent_test` est donc utilisable largement pour la QA, sans
compter les appels.

### 🆕 Deux surfaces Meta que notre corpus n'a jamais lues

- **`agent-insights`** (groupe Operate) : « Review which knowledge sources and skills the agent uses in its
  responses. » Un endroit où voir CE QUI a servi à répondre : intéressant pour expliquer une réponse à un
  client. Jamais transcrit chez nous.
- **`capabilities`** (référencée depuis Overview) : « see what the agent can do today and where to configure
  each capability ». Jamais lue non plus.

Les deux sont ajoutées à la veille.

### 🟡 Connecteurs : les règles de validation deviennent explicites

> « At least one of headers, query_params, or body_params must contain a populated entry. The request fails
> with HTTP 400 if this field is null or missing. »

Même durcissement documentaire pour `oauth_config` (400 si null ou absent) et pour `auth_config`, dont la
consigne est réécrite valeur par valeur, avec obligation d'OMETTRE le champ quand `auth_type` vaut `NONE`.

### 🟡 Tarification propre aux messages MBA

> « Meta Business Agent messages are priced differently from other WhatsApp message types. »

Renvoi vers la grille « WhatsApp pricing for non-template messages ». Notre modèle de coût, calé sur les
catégories de template, ne couvre pas ce régime.

## Pourquoi ce document existe

`mba.messagingme.app` est une couche logicielle qui aide les entreprises à **onboarder et piloter finement
l'agent MBA de Meta**, et à lancer des campagnes (ce que MBA ne fait pas). Ce n'est pas un constructeur de
bot concurrent de MBA, et il est volontairement moins fouillé qu'UChat.

La plus-value centrale du produit est le **contrôle** : permettre au client de dire « ça je fais répondre
automatiquement, ça non », et surtout **comment on passe la main à un humain**. Les chapitres « Onboarding »
(pour `ai_audience` et l'allowlist) et « Contrôle du fil » (pour le handoff) sont donc le cœur de cette
référence. Le reste est du contexte.

**~~Blocage actuel~~ LEVÉ le 2026-08-18.** `agent_eligibility` renvoyait HTTP 403 « The Meta Business AI
Terms of Service must be accepted » sur notre WABA française. Julien a accepté les Terms of Sales, et la
sonde `scripts/sonde-mba-live.mts` mesure désormais `{"is_eligible": true}` sur le numéro
`+33 5 25 68 03 01` (`phone_number_id=1305301719324792`), avec un agent déjà créé et `rollout.enabled=false`.
Toute la surface `agent_config/*` répond. Ce qui reste fermé est ailleurs : moyen de paiement, et la notion
de « configured escalation partner » pour `take`.

## Sommaire

1. [Onboarding : éligibilité, activation, réglages, allowlist](#1-onboard)
2. [Contrôle du fil : thread control, webhooks standby et messaging_handovers](#2-operate-control)
3. [Connaissance : business info, FAQ, sites web, fichiers](#3-knowledge)
4. [Skills : instructions système, ton, priorités](#4-skills)
5. [Connecteurs et connector tools : brancher les API du client](#5-connectors)
6. [Agent event et agent test](#6-operate-event-test)
7. [Évaluation et suppression](#7-operate-eval-delete)
8. [Ce que la doc ne dit pas](#8-incertitudes)

Voir aussi `MBA-ARCHITECTURE.md`, qui décrit ce que tout ceci implique pour notre code et dans quel ordre
construire. Le présent document décrit ce que Meta expose, pas ce qu'on en fait.

---

<a id="1-onboard"></a>

## 1. Onboarding : éligibilité, activation, réglages, allowlist

> Relecture adversariale : 3 erreur(s) et 10 omission(s) corrigées.

#### Vue d'ensemble du cycle de vie

Quatre APIs composent l'onboarding d'un agent MBA sur un numero WhatsApp. Elles s'enchainent dans cet ordre, et la console doit refleter cet enchainement : le guide « Get started » qualifie l'onboarding de « Required step before turning the agent on ». Ce que renvoie precisement un appel effectue hors sequence n'est pas documente.

1. **Eligibilite** (`GET /{entity_id}/agent_eligibility`) : le numero peut-il porter un agent MBA. Lecture seule, sans effet de bord.
2. **Onboarding** (`POST /{entity_id}/agent_onboarding?channel=whatsapp`) : cree les entites necessaires et **planifie des jobs asynchrones de preparation des donnees**. C'est l'etape qui fait exister l'agent et qui renvoie l'`agent_id`.
3. **Settings** (`GET` / `PUT /{entity_id}/agent_config/settings`) : allume ou eteint l'agent (`rollout.enabled`), definit le handoff humain, le followup d'inactivite, et l'audience (`ai_audience`).
4. **Allowlist** (`GET` / `POST /{entity_id}/agent_config/allowlist`, `DELETE /{entity_id}/agent_config/allowlist/{entry_id}`) : la liste des numeros consommateurs auxquels l'agent repond quand `ai_audience = ALLOWLISTED_ONLY`.

Fin de vie, hors de ce chapitre mais utile pour cadrer : `DELETE /{entity_id}/delete_agent` supprime la configuration de l'agent et, quand c'est le dernier agent du compte, deconnecte l'integration. Reponse `BizAIOmniChannelDeleteAgentResponse` avec un champ `deleted_agent_id` (string, nullable, `null` s'il n'y avait rien a supprimer). **Ce champ n'est pas marque requis dans la spec** : ne pas supposer qu'il est toujours present dans le corps de reponse, coder sa lecture comme optionnelle.

**ATTENTION, `delete_agent` n'obeit pas aux memes regles d'autorisation.** Son bloc « Authorization » exige **uniquement** la permission `whatsapp_business_messaging`, sans l'alternative capability `bizai_wa_enterprise_api_3p_access` acceptee par les quatre APIs de ce chapitre. Un token qui passe partout ailleurs grace a la seule capability peut donc echouer sur la suppression. Provisionner la permission, pas seulement la capability.

##### Prerequis hors API

**ATTENTION, ToS.** Le client doit avoir accepte les Terms of Service Meta Business Agent **dans WhatsApp Manager** (onglet « Meta Business Agent », visible seulement si un numero est eligible), et un BSP / Tech Provider doit en plus avoir accepte les Tech Provider ToS dans le portail developpeur. Les appels API MBA sont **rejetes** tant que ces ToS ne sont pas acceptes. Aucun endpoint de ce chapitre ne permet de lire ou d'accepter ces ToS : la console ne peut donc pas verifier programmatiquement cet etat, elle doit le traiter comme une etape manuelle guidee, et interpreter un echec d'appel comme un possible « ToS non acceptes ».

Les quatre specs declarent par ailleurs une licence : **Meta Business AI Terms of Service**, https://www.facebook.com/legal/3774714022740775. C'est le texte de reference a citer dans la documentation client de la console.

**Prerequis listes par le guide « Get started »**, tous en amont du premier appel :

| Prerequis | Detail |
|---|---|
| WABA ID | l'identifiant du WhatsApp Business Account portant le numero |
| App ID | l'identifiant de l'app Meta utilisee pour les appels |
| Permission app | `whatsapp_business_messaging` accordee a l'app |
| Pays et vertical | le business doit operer dans un pays supporte **et** un vertical supporte |
| ToS | Meta Business Agent ToS acceptes dans WhatsApp Manager (+ Tech Provider ToS pour un BSP) |

**Prerequis d'assets, cause racine du 403 sur le PUT settings** : l'app **et** la WABA doivent etre **assignees au system user**, avec la permission « View and manage phone numbers » sur la WABA. Un token techniquement valide mais dont l'asset n'est pas assigne produit un refus a l'ecriture, pas un `401`.

**Abonnements a mettre en place** (etapes 6 et 7 du guide, sans lesquelles la sequence de la section 5 est incomplete) :

1. Abonner l'app a la WABA : `POST /{WABA_ID}/subscribed_apps`, verification par `GET /{WABA_ID}/subscribed_apps`.
2. S'abonner explicitement, dans le portail developpeur, aux champs webhook `messages`, `standby` et `messaging_handovers`. Sans cet abonnement, la console ne verra jamais passer les conversations ni les changements de controle de fil.

##### Conventions communes a tous les endpoints du chapitre

| Element | Valeur |
|---|---|
| Hote | `https://api.facebook.com` |
| Authentification | `Authorization: Bearer <token>` (schema HTTP Bearer, `OAuthToken__Authorization`), requis sur **tous** les endpoints |
| Autorisation | l'une au choix : capability `bizai_wa_enterprise_api_3p_access` **ou** permission `whatsapp_business_messaging` (sauf `delete_agent`, voir ci-dessus) |
| En-tete de version | `X-API-Version: 2.0.0` (seule valeur d'enum documentee, champ **non requis** dans la spec) |
| `entity_id` | le **WhatsApp Business Phone Number ID** (pas le WABA ID, pas le numero au format E.164) |
| Corps | `application/json` |
| Schema d'erreur | `StandardError` |
| Tags OpenAPI | `Business AI` seul pour eligibility et onboarding ; `Agent Config` + `Business AI` pour settings et allowlist |

**ATTENTION.** `X-API-Version` est marque `required: false` dans les quatre YAML. Ne pas s'y fier : la valeur par defaut appliquee cote Meta en son absence n'est **pas documentee**. Le client HTTP doit envoyer `X-API-Version: 2.0.0` systematiquement, en dur, sur chaque appel.

**Note token.** Le guide de demarrage precise que les deux types de token (system user pour un integrateur direct, BISU pour un BSP / Tech Provider) requierent les permissions `whatsapp_business_messaging` **et** `whatsapp_business_management`, alors que le bloc « Authorization » des references ne mentionne que `whatsapp_business_messaging`. Provisionner les deux.

##### Schema d'erreur `StandardError`

Commun aux quatre APIs.

| Champ | Type | Requis | Description |
|---|---|---|---|
| `title` | string | oui | aucune description dans la spec ; les exemples montrent un libelle court (`Bad Request`, `Not Found`, `Unauthorized`, `Forbidden`, `Too Many Requests`, `Internal Server Error`, `Invalid request`, `Allowlist entry not found`) |
| `detail` | string | oui | aucune description dans la spec ; les exemples montrent un message detaille |
| `type` | string | non | aucune description dans la spec |
| `status` | integer | non | aucune description dans la spec |

Autrement dit, aucune des quatre proprietes n'est decrite dans les YAML : tout ce qu'on sait du contenu attendu vient des exemples. Ne pas construire de logique metier sur `type` ni sur `status`, dont on ignore jusqu'au format.

Exemples de valeurs presentes dans les specs : `{"title":"Bad Request","detail":"Invalid parameters"}`, `{"title":"Not Found","detail":"Resource not found"}`, `{"title":"Unauthorized","detail":"Authentication credentials are missing or invalid"}`, `{"title":"Forbidden","detail":"The caller is not authorized to access this entity"}`, `{"title":"Too Many Requests","detail":"Rate limit exceeded"}`, `{"title":"Internal Server Error","detail":"An unexpected error occurred"}`. Pour l'allowlist : `{"title":"Invalid request","detail":"The request is invalid"}` (400 du `GET /allowlist`), `{"title":"Invalid request","detail":"The request is invalid or the phone number format is not valid"}` (400 du `POST /allowlist`) et `{"title":"Allowlist entry not found","detail":"The specified allowlist entry was not found"}` (404 du `DELETE`). Les deux 400 de l'allowlist portent le meme `title` mais un `detail` different : ne pas router sur le `title` seul.

Chaque operation declare en plus une reponse `default` decrite « Error response. » portant le meme schema `StandardError`. Le client doit donc traiter tout code non 2xx comme un `StandardError`, sans supposer que la liste des codes documentes est exhaustive.

---

#### 1. Eligibilite

##### `GET /{entity_id}/agent_eligibility`

`operationId: getAgentEligibility`, tag `Business AI`. Ressource singleton : un resultat d'eligibilite par `entity_id`.

**Requete**

```
GET https://api.facebook.com/{entity_id}/agent_eligibility
Authorization: Bearer <token>
X-API-Version: 2.0.0
```

Parametres de chemin :

| Nom | Type | Requis | Description |
|---|---|---|---|
| `entity_id` | string | oui | Le WhatsApp Business Phone Number ID a tester |

Parametres de requete : aucun. Corps : aucun.

**Reponse 200, `BizAIOmniChannelEligibilityResponse`**

| Champ | Type | Requis | Description |
|---|---|---|---|
| `is_eligible` | boolean | oui | `true` eligible, `false` non eligible |

```json
{ "is_eligible": true }
```

**Codes documentes** : 200, 400, 404, 401, 429, 500, plus `default`.

**ATTENTION.** La reponse est **binaire, sans motif**. Aucun champ ne dit *pourquoi* un numero n'est pas eligible (pays non supporte, vertical non supporte, ToS non acceptes, numero non provisionne). La console ne peut donc pas afficher un diagnostic issu de l'API : il faudra un texte d'aide statique renvoyant vers les criteres de disponibilite (pays et vertical supportes, cf. prerequis du guide) et vers WhatsApp Manager.

**ATTENTION.** Distinguer `200 {"is_eligible": false}` (numero connu, non eligible) de `404` (ressource introuvable, typiquement un `entity_id` errone ou non accessible au token). Ce sont deux etats produit differents et le message utilisateur doit differer.

**Non documente** : la frequence de rafraichissement de l'eligibilite, sa mise en cache cote Meta, et s'il existe un webhook signalant un passage a eligible. En pratique la console devra re-interroger l'endpoint, sans garantie de fraicheur.

---

#### 2. Onboarding

##### `POST /{entity_id}/agent_onboarding`

`operationId: createOnboardingSession`, tag `Business AI`. Declenche le flux d'onboarding : cree les entites necessaires et **planifie des jobs asynchrones de preparation des donnees**.

**Requete**

```
POST https://api.facebook.com/{entity_id}/agent_onboarding?channel=whatsapp
Authorization: Bearer <token>
X-API-Version: 2.0.0
```

Parametres de chemin :

| Nom | Type | Requis | Description |
|---|---|---|---|
| `entity_id` | string | oui | Le WhatsApp Business Phone Number ID |

Parametres de requete :

| Nom | Type | Requis | Valeurs autorisees | Description |
|---|---|---|---|---|
| `channel` | string | **oui** | `email`, `instagram`, `line`, `messenger`, `sms`, `tiktok`, `unknown`, `webchat`, `whatsapp` | Le canal pour lequel onboarder l'agent |

Corps : **aucun corps de requete n'est declare** pour cette operation. Tout se joue dans le `channel` en query.

**Reponse 201, `BizAIOmniChannelOnboardingResponse`**

| Champ | Type | Requis | Description |
|---|---|---|---|
| `agent_id` | string | oui | L'ID de l'entite de settings de l'agent |

```json
{ "agent_id": "1234567890" }
```

**Codes documentes** : 201, 400, 401, 429, 500, plus `default`. Noter l'absence de `404` ici, contrairement a l'eligibilite et aux settings.

**ATTENTION.** L'enum `channel` couvre neuf canaux, mais `entity_id` est partout decrit comme un **WhatsApp Business Phone Number ID**, et `ai_audience` n'existe que pour les entites WhatsApp. Dans la console, cabler `channel=whatsapp` en dur et ne pas exposer les autres valeurs : rien dans cette documentation ne decrit comment obtenir un `entity_id` valide pour Instagram, Messenger ou les autres, ni ce que renverrait l'appel.

**ATTENTION.** `agent_id` est le pivot de tout le reste de l'integration. Le persister en base des le 201, associe au couple (`entity_id`, `channel`). C'est la seule occasion ou l'API le donne « gratuitement » ; ensuite il faut le relire via `GET settings`.

**ATTENTION, asynchronisme.** La reponse 201 signifie « onboarding declenche », pas « agent pret ». Les jobs de preparation des donnees sont explicitement asynchrones et **aucun champ de statut, aucun endpoint de suivi et aucun webhook de completion ne sont documentes**. La console ne peut pas afficher une barre de progression fidele : le seul signal observable est ce que renvoie `GET settings` ensuite. Prevoir un etat « onboarding en cours » cote console, avec relecture periodique de `GET settings`.

**Non documente** : l'idempotence. Ce que fait un second `POST agent_onboarding` sur un `entity_id` deja onboarde (nouvel agent, meme `agent_id` renvoye, ou 400) n'est pas precise. Traiter l'appel comme potentiellement non idempotent : garder une garde cote console (ne pas re-declencher si un `agent_id` est deja connu et que `GET settings` renvoie une entree), et ne pas le mettre derriere un bouton reessayable sans confirmation.

**Non documente** : la duree typique de la preparation, et si l'agent est configurable (knowledge, skills) avant la fin des jobs.

---

#### 3. Settings

Base : `https://api.facebook.com/{entity_id}/agent_config/settings`. Tags `Agent Config` + `Business AI`. La spec decrit la ressource comme un singleton (« one settings object per entity_id »), tout en exposant un `agent_id` optionnel et une reponse GET en **tableau**. Voir l'ATTENTION plus bas : ces deux affirmations ne sont pas coherentes et le client doit coder pour le tableau.

##### 3.1 `GET /{entity_id}/agent_config/settings`

`operationId: getSettings`. Recupere les settings courants.

```
GET https://api.facebook.com/{entity_id}/agent_config/settings[?agent_id=...]
Authorization: Bearer <token>
X-API-Version: 2.0.0
```

Parametres de chemin :

| Nom | Type | Requis | Description |
|---|---|---|---|
| `entity_id` | string | oui | Le WhatsApp Business Phone Number ID |

Parametres de requete :

| Nom | Type | Requis | Description |
|---|---|---|---|
| `agent_id` | string | non | Quand fourni, renvoie la configuration de cet agent precis. Quand absent, renvoie **tous** les settings pour le canal donne |

**ATTENTION.** La description de `agent_id` parle de « the given channel » mais **aucun parametre `channel` n'existe sur cet endpoint**. Il n'y a donc pas de moyen documente de filtrer par canal en GET. Considerer que le canal est implicite au `entity_id`.

**Reponse 200** : **tableau** de `BizAIOmniChannelSettingsResponse`.

**ATTENTION, asymetrie GET / PUT.** `GET` renvoie un **tableau** (`type: array`), `PUT` renvoie un **objet unique**. Un client type doit definir deux types de retour distincts. Ne pas ecrire `parseSettings(json)` partage entre les deux.

**Non documente** : ce que renvoie le GET quand l'onboarding n'a jamais eu lieu (tableau vide `[]` ou `404`). Coder les deux : traiter `404` et `[]` comme « pas encore onboarde ».

**Codes documentes** : 200, 400, 404, 401, 429, 500, plus `default`. Pas de 403 sur le GET.

##### 3.2 `PUT /{entity_id}/agent_config/settings`

`operationId: updateSettings`. Description officielle : « Create or fully replace the AI settings for the specified entity. All fields must be provided for a complete replacement. »

```
PUT https://api.facebook.com/{entity_id}/agent_config/settings[?agent_id=...]
Authorization: Bearer <token>
X-API-Version: 2.0.0
Content-Type: application/json
```

Parametres de chemin :

| Nom | Type | Requis | Description |
|---|---|---|---|
| `entity_id` | string | oui | Le WhatsApp Business Phone Number ID |

Parametres de requete :

| Nom | Type | Requis | Description |
|---|---|---|---|
| `agent_id` | string | non | Quand fourni, met a jour cette configuration d'agent precise. Quand absent, comportement « create-or-fetch » |

**ATTENTION.** Le libelle du comportement sans `agent_id` est « create-or-fetch », pas « create-or-update ». Le terme suggere que l'appel peut se contenter de **recuperer** une configuration existante au lieu de l'ecraser, ce qui contredit le « fully replace » du resume. Le comportement exact n'est pas documente. Regle d'implementation : **toujours passer `agent_id` explicitement** sur les PUT de mise a jour, et ne laisser l'appel sans `agent_id` que pour la toute premiere creation. C'est la seule facon d'obtenir un comportement previsible.

**Corps de requete (requis) : `BizAIOmniChannelSettingsRequest`**

| Champ | Type | Requis | Valeurs / defaut |
|---|---|---|---|
| `rollout` | `BizAIOmniChannelSettingsRollout` | non | objet, voir ci-dessous |
| `handoff` | `BizAIOmniChannelSettingsHandoff` | non | objet nullable |
| `followup` | `BizAIOmniChannelSettingsFollowup` | non | objet nullable |
| `ai_audience` | string | non | `ALLOWLISTED_ONLY` ou `EVERYONE`. Defaut documente : `EVERYONE`. « Only supported for WhatsApp entities » |

**ATTENTION, le piege central de ce chapitre.** Le corps est declare **requis**, la semantique est **remplacement complet** (« All fields must be provided »), mais **aucun champ du schema `BizAIOmniChannelSettingsRequest` n'est marque requis**. La spec n'interdit donc pas d'envoyer `{}`, et rien ne dit ce qui arrive aux champs omis (remis a leur defaut, mis a `null`, ou conserves). Consequence pratique pour la console :

> Ne **jamais** construire un PUT a partir des seuls champs modifies dans le formulaire. Toujours faire un `GET settings` juste avant, reprendre l'objet complet renvoye, appliquer la modification, et renvoyer l'objet entier. Un PUT partiel risque d'effacer silencieusement le handoff ou le followup du client.

C'est aussi un argument produit : la console apporte precisement la garantie « read-modify-write » que l'API brute ne donne pas.

**ATTENTION.** `agent_id` et `channel` figurent dans la **reponse** mais **pas** dans le schema de requete. En read-modify-write, il faut donc **retirer** ces deux champs de l'objet lu avant de le renvoyer en PUT, et repasser `agent_id` en query string. Un renvoi brut de l'objet GET est un risque de 400.

###### `BizAIOmniChannelSettingsRollout`

Description : « Rollout configuration for the AI agent, containing the enabled flag and future gradual rollout fields ».

| Champ | Type | Requis | Description |
|---|---|---|---|
| `enabled` | boolean | **oui** | `true` agent allume, `false` eteint. Exemple : `true` |

Le nom « rollout » et la mention « future gradual rollout fields » annoncent des champs a venir (deploiement progressif en pourcentage, par exemple) qui n'existent pas aujourd'hui. Ne pas les anticiper dans le modele de donnees, mais ne pas non plus aplatir `rollout` en un simple booleen dans la base de la console : garder l'objet, il grossira.

**ATTENTION, l'asymetrie desactivation / reactivation.** Texte officiel : « disabling the agent will make the AI stop responding to all threads. Re-enabling it will make the AI start responding to new threads only ».

- `enabled: false` agit sur **toutes** les conversations, y compris celles en cours. Effet immediat et global.
- `enabled: true` n'agit que sur les **nouvelles** conversations. Les fils qui etaient ouverts au moment de la coupure **ne repartent pas** sous agent.

C'est irreversible au sens operationnel : un « kill switch » actionne par erreur ne se defait pas par un simple re-clic, les conversations en cours restent orphelines. Implications console, a traiter comme des exigences :

1. Le bouton de desactivation doit demander confirmation et annoncer explicitement l'effet sur les fils en cours.
2. Apres reactivation, la console doit signaler que les fils anterieurs restent hors agent, et que la reprise passe par un traitement humain ou par le mecanisme de thread control.
3. Ne pas modeliser l'agent comme un interrupteur symetrique dans l'UI. C'est un etat avec un cout de sortie.

**Non documente** : ce que voit le consommateur dans un fil en cours au moment de la desactivation (aucun message, message de fin, silence), et si les fils orphelins arrivent sur le webhook `messages` ou restent en `standby`. A observer en conditions reelles, c'est determinant pour le handoff.

###### `BizAIOmniChannelSettingsHandoff`

Description : « Settings for handing over the conversation to a human agent. Null if not configured ». Objet **nullable**.

| Champ | Type | Requis | Description |
|---|---|---|---|
| `enabled` | boolean | **oui** | `true` handoff vers un humain active, `false` desactive. Exemple : `true` |
| `message` | string | non | Message affiche a l'utilisateur au moment du passage a un humain. Exemple : `Connecting you to a human agent` |

**ATTENTION.** Le seul levier de handoff expose ici est un booleen et un texte. La documentation de cet endpoint **ne dit pas** ce qui declenche le handoff (intention detectee par le modele, mot-cle, echec de reponse), ni s'il est configurable, ni quelle notification le business recoit. Aucune longueur maximale n'est documentee pour `message`, aucune contrainte de langue, aucun format de variable.

**ATTENTION, articulation avec le controle du fil.** Le handoff des settings et le controle de conversation sont **deux mecanismes distincts** :

- `handoff` (ici) : reglage declaratif de l'agent MBA.
- Controle du fil (documente ailleurs, cote Cloud API) : quand MBA est actif il est **primary responder**, l'app tierce est **standby**. Les messages du consommateur arrivent sur le webhook `standby` quand MBA a le controle, sur `messages` quand l'app a le controle, et `messaging_handovers` notifie chaque changement. L'app **prend** le controle simplement en envoyant un message dans la conversation, et le **rend** via l'endpoint Thread Control avec l'action `pass`.

**Precision importante sur le `standby`** : l'app tierce n'y recoit pas seulement les messages entrants du consommateur. Elle recoit aussi des **copies des messages envoyes par l'agent au nom du business**, ainsi que leurs **accuses de livraison et de lecture**, explicitement « so it stays in sync ». Le `standby` n'est donc pas une simple redirection des entrants : c'est un flux miroir complet de la conversation, ce qui permet a la console d'afficher le fil integral meme quand MBA a le controle. Modeliser le stockage en consequence (auteur du message : consommateur, agent MBA, ou operateur humain).

Rappel operationnel : ces webhooks n'arrivent que si l'app est abonnee a la WABA (`POST /{WABA_ID}/subscribed_apps`) **et** abonnee aux champs `messages`, `standby` et `messaging_handovers` dans le portail developpeur.

Rien dans la reference des settings ne dit si activer `handoff.enabled` transfere effectivement le controle du fil a l'app tierce, ni sur quel webhook la suite de la conversation arrive. **Le lien entre les deux mecanismes n'est pas documente.** C'est le point le plus important a verifier en conditions reelles, parce que c'est exactement le coeur de valeur de la console : savoir de facon fiable quand l'humain reprend la main et sur quel canal les messages lui parviennent.

###### `BizAIOmniChannelSettingsFollowup`

Description : « Settings for following up with an inactive user. Null if not configured ». Objet **nullable**.

| Champ | Type | Requis | Description |
|---|---|---|---|
| `enabled` | boolean | **oui** | `true` followup active, `false` desactive |
| `followup_interval_in_seconds` | integer, enum ferme | non | Duree d'inactivite avant envoi du message de relance. Valeurs autorisees **exclusivement** : `0`, `300`, `900`, `1800`, `3600`, `7200`, `28800`, `86400`. Exemple : `900`. `0` desactive le followup |
| `message` | string | non | Message de relance. Exemple : `Is there anything else I can help with?` |

**ATTENTION.** L'enum est ferme : 0 s, 5 min, 15 min, 30 min, 1 h, 2 h, 8 h, 24 h. Toute autre valeur doit etre rejetee **cote console** avant l'appel, avec un selecteur limite a ces huit options. Un champ libre en minutes produirait des 400 opaques.

**ATTENTION.** Deux facons de desactiver le followup coexistent (`enabled: false` et `followup_interval_in_seconds: 0`), et la doc ne dit pas laquelle prime si elles se contredisent (par exemple `enabled: true` avec un intervalle `0`). Choisir une convention unique dans la console : `enabled: false` **et** ne pas envoyer d'intervalle contradictoire.

**Non documente** : le nombre de relances (une seule ou repetees), l'interaction avec la fenetre de 24 h WhatsApp, et si l'envoi consomme un template ou un message de session.

###### Reponse `BizAIOmniChannelSettingsResponse`

Renvoye par `PUT` (objet) et, dans un tableau, par `GET`.

| Champ | Type | Requis | Description |
|---|---|---|---|
| `agent_id` | string | **oui** | Identifiant unique de cette configuration d'agent. A utiliser pour cibler un agent precis en update ou delete. Exemple : `1234567890` |
| `channel` | string, enum | **oui** | `email`, `instagram`, `line`, `messenger`, `sms`, `tiktok`, `unknown`, `webchat`, `whatsapp`. Exemple : `whatsapp` |
| `rollout` | `BizAIOmniChannelSettingsRollout` | **oui** | |
| `handoff` | `BizAIOmniChannelSettingsHandoff` | non | peut etre `null` si non configure |
| `followup` | `BizAIOmniChannelSettingsFollowup` | non | peut etre `null` si non configure |
| `ai_audience` | string, enum, nullable | non | `ALLOWLISTED_ONLY` ou `EVERYONE`. `EVERYONE` est le defaut. **Null pour les entites non WhatsApp** |

Exemple de reponse GET reconstruit a partir des exemples de la spec :

```json
[
  {
    "agent_id": "1234567890",
    "channel": "whatsapp",
    "rollout": { "enabled": true },
    "handoff": { "enabled": true, "message": "Connecting you to a human agent" },
    "followup": {
      "enabled": true,
      "followup_interval_in_seconds": 900,
      "message": "Is there anything else I can help with?"
    },
    "ai_audience": "EVERYONE"
  }
]
```

**Codes documentes sur le PUT** : 200, 400, 404, 401, **403**, 429, 500, plus `default`. Le `403` (« The caller is not authorized to access this entity ») n'existe **que** sur le PUT, pas sur le GET : c'est le signal typique d'un token en lecture qui ne peut pas ecrire, ou, cause racine la plus frequente, d'un asset non assigne au system user (l'app ou la WABA non assignee, ou la permission « View and manage phone numbers » manquante sur la WABA). La console doit differencier ce message de l'`401` et pointer explicitement l'assignation d'assets.

##### 3.3 `ai_audience`, le levier de controle

C'est le reglage le plus important du chapitre pour un produit dont la valeur est le controle.

- `EVERYONE` : l'agent repond a **tous** les consommateurs. **C'est le defaut.**
- `ALLOWLISTED_ONLY` : l'agent ne repond qu'aux numeros presents dans l'allowlist.

**ATTENTION, le piege le plus dangereux de l'onboarding.** Le defaut est `EVERYONE`. Enchainer `POST agent_onboarding` puis un `PUT settings` avec `rollout.enabled: true` sans preciser `ai_audience` met potentiellement l'agent en production face a **toute** la base clients du numero. La console doit imposer l'ordre inverse pour tout demarrage controle :

1. `POST agent_onboarding`
2. `PUT settings` avec `rollout.enabled: false` et `ai_audience: "ALLOWLISTED_ONLY"`
3. Peupler l'allowlist (`POST allowlist` pour chaque numero de test)
4. Verifier par `GET settings` **et** `GET allowlist`
5. Seulement alors `PUT settings` avec `rollout.enabled: true`
6. Elargir plus tard en basculant `ai_audience` a `EVERYONE`, comme une action explicite et confirmee, jamais comme un effet de bord d'un autre reglage

**ATTENTION.** `ai_audience` etant absent du PUT signifie potentiellement retour au defaut `EVERYONE`, ce qui combine les deux pieges precedents : un PUT partiel destine a changer le message de followup pourrait, dans le pire cas, elargir l'audience de l'agent a tout le monde. Raison de plus pour n'envoyer que des objets complets, et pour afficher l'audience en clair dans la console apres chaque ecriture, relue via `GET`.

**Non documente** : l'effet d'un passage de `EVERYONE` a `ALLOWLISTED_ONLY` sur les conversations **en cours** avec des numeros non allowlistes. Par symetrie avec le comportement de `rollout`, il faut le verifier, pas le supposer.

**Non documente** : le comportement exact quand `ai_audience = ALLOWLISTED_ONLY` et qu'un numero non allowliste ecrit. Silence total, message d'attente, ou routage vers l'app en `standby` / `messages` : rien n'est precise. A verifier en conditions reelles, c'est central pour ne pas laisser des clients sans reponse pendant un pilote.

---

#### 4. Allowlist

Base : `https://api.facebook.com/{entity_id}/agent_config/allowlist`. Tags `Agent Config` + `Business AI`. Description officielle : « When the AIAudience setting is set to ALLOWLISTED_ONLY, the agent only responds to consumers whose phone numbers are in this list ».

Trois operations, et **rien d'autre** : ajouter une entree, lister toutes les entrees, supprimer une entree par son id.

##### 4.1 `GET /{entity_id}/agent_config/allowlist`

`operationId: listAllowlist`. Liste toutes les entrees.

```
GET https://api.facebook.com/{entity_id}/agent_config/allowlist
Authorization: Bearer <token>
X-API-Version: 2.0.0
```

Parametres de chemin : `entity_id` (string, requis, « The entity ID for the Meta Business Agent. It is a WhatsApp Business Phone Number ID »). Parametres de requete : **aucun**.

**Reponse 200** : tableau de `BizAIOmniChannelAllowlistResponse`.

```json
[ { "id": "1234567890", "consumer_phone_number": "+15551234567" } ]
```

**Codes documentes** : 200, 400, 401, 429, 500, plus `default`. Pas de 404. L'exemple du 400 sur ce GET est `{"title":"Invalid request","detail":"The request is invalid"}`, distinct de celui du POST qui mentionne le format de numero.

**ATTENTION, pas de pagination.** Aucun parametre `limit`, `after`, `cursor` ou equivalent n'est documente, et la reponse est un tableau nu sans enveloppe de pagination. Rien ne dit ce qui se passe si la liste devient longue. Ne pas presumer que le GET renvoie l'integralite de la liste au-dela d'une certaine taille : la console doit afficher le nombre d'entrees renvoyees et ne pas s'en servir comme d'une verite absolue pour un gros volume.

**ATTENTION, pas de filtre ni de recherche.** Pour savoir si un numero donne est allowliste, il faut recuperer toute la liste et chercher cote client. Consequence : la console doit tenir un **miroir local** de l'allowlist, resynchronise par `GET`, et ne pas interroger l'API a chaque saisie.

##### 4.2 `POST /{entity_id}/agent_config/allowlist`

`operationId: addToAllowlist`. Ajoute **un** numero.

```
POST https://api.facebook.com/{entity_id}/agent_config/allowlist
Authorization: Bearer <token>
X-API-Version: 2.0.0
Content-Type: application/json

{ "consumer_phone_number": "+15551234567" }
```

Corps requis, `BizAIOmniChannelAllowlistRequest` :

| Champ | Type | Requis | Description |
|---|---|---|---|
| `consumer_phone_number` | string | **oui** | Numero WhatsApp du consommateur au **format E.164**, ex. `+15551234567` |

**Reponse 201, `BizAIOmniChannelAllowlistResponse`** :

| Champ | Type | Requis | Description |
|---|---|---|---|
| `id` | string | oui | Identifiant unique de l'entree d'allowlist. Exemple : `1234567890` |
| `consumer_phone_number` | string | oui | Le numero, format E.164 |

**Codes documentes** : 201, 400, 401, 429, 500, plus `default`. Pas de 404, pas de 409.

**ATTENTION, format des numeros.** E.164, avec le **`+` en tete**, comme dans l'exemple `+15551234567`. C'est different de la convention Cloud API WhatsApp habituelle ou le `wa_id` est renvoye **sans** `+` (ex. `15551234567`). Un numero recopie depuis un webhook WhatsApp doit donc etre normalise (ajout du `+`) avant d'etre envoye ici, et inversement pour rapprocher une entree d'allowlist d'un `wa_id`. Normaliser en un seul point du code, pas dans chaque appelant.

**ATTENTION.** L'exemple d'erreur 400 propre a cet endpoint est explicite sur le sujet : `{"title":"Invalid request","detail":"The request is invalid or the phone number format is not valid"}`. Valider le format E.164 cote console avant d'appeler.

**ATTENTION, ajout unitaire uniquement.** Le corps accepte **un seul** numero, pas un tableau. Il n'y a **aucun endpoint d'ajout en masse**. Importer une liste de 200 numeros signifie 200 requetes POST, avec un risque de 429 (« Rate limit exceeded ») dont **le seuil n'est pas documente** et qui ne fournit pas de `Retry-After` documente. Implementation obligatoire cote console : file d'attente serialisee, backoff exponentiel sur 429, reprise idempotente, et affichage d'un etat par ligne d'import.

**Non documente** : le comportement en cas de doublon. Un second POST du meme numero peut creer une deuxieme entree avec un `id` different, renvoyer l'entree existante, ou echouer en 400. Il n'y a pas de 409 declare. La console doit dedupliquer **avant** l'appel, a partir de son miroir local, et tolerer l'apparition de doublons cote API sans casser (dedupliquer aussi a l'affichage, par `consumer_phone_number`).

**Non documente** : le **plafond** de l'allowlist. Aucune taille maximale n'est indiquee, ni dans la description de l'API, ni dans le schema, ni dans les exemples d'erreur. Ne pas promettre au client une allowlist illimitee. Prevoir que le POST puisse commencer a echouer en 400 au-dela d'un certain nombre d'entrees et remonter le `detail` brut de l'erreur.

##### 4.3 `DELETE /{entity_id}/agent_config/allowlist/{entry_id}`

`operationId: removeFromAllowlist`. Retire **une** entree, **par son `id`**, pas par numero.

```
DELETE https://api.facebook.com/{entity_id}/agent_config/allowlist/{entry_id}
Authorization: Bearer <token>
X-API-Version: 2.0.0
```

Parametres de chemin :

| Nom | Type | Requis | Description |
|---|---|---|---|
| `entity_id` | string | oui | Le WhatsApp Business Phone Number ID |
| `entry_id` | string | oui | L'identifiant unique de l'entree d'allowlist |

Corps : aucun.

**Reponse 204** : « Allowlist entry successfully deleted ». **Pas de corps.**

**Codes documentes** : 204, 404, 401, 429, 500, plus `default`. Noter l'**absence de 400**.

**ATTENTION.** La suppression se fait par `id` d'entree, jamais par numero de telephone. La console doit donc conserver le mapping `consumer_phone_number` vers `id` issu du POST ou du GET. Si le mapping est perdu, la seule voie est un `GET` complet pour retrouver l'`id`.

**ATTENTION.** Le `404` (`{"title":"Allowlist entry not found","detail":"The specified allowlist entry was not found"}`) est le cas normal d'un mapping perime, par exemple si un autre operateur a supprime l'entree entre-temps. Le traiter comme un succes idempotent cote console (l'etat vise est atteint), pas comme une erreur bloquante.

##### 4.4 Remplacement de l'allowlist

**ATTENTION.** Il n'existe **aucune operation de remplacement**, ni `PUT` sur la collection, ni `DELETE` sur la collection entiere, ni endpoint de purge. « Remplacer l'allowlist » est une operation **synthetisee par la console**, pas une primitive de l'API. Algorithme a implementer :

1. `GET allowlist` pour l'etat courant.
2. Calculer le diff avec la liste cible, en comparant sur `consumer_phone_number` normalise E.164.
3. `POST` chaque numero a ajouter, un par un.
4. `DELETE /{entry_id}` chaque entree a retirer, une par une.
5. `GET allowlist` de nouveau pour verifier le resultat.

**Cette sequence n'est pas atomique.** Un echec au milieu laisse une allowlist partielle, donc un agent qui repond a un ensemble de personnes different de celui affiche. La console doit journaliser chaque operation, afficher un etat de reconciliation explicite (« N ajoutes, M retires, K en echec »), et ne jamais afficher la liste cible comme si elle etait appliquee tant que le `GET` de verification n'a pas confirme.

Recommandation operationnelle : pour un remplacement large, faire les **ajouts avant les suppressions**. En cas d'interruption, l'etat intermediaire est une allowlist trop large plutot qu'un client legitime prive de reponse. Si l'inverse est prefere pour des raisons de conformite, c'est un choix a faire explicitement, pas par accident d'ordre de boucle.

---

#### 5. Sequence de reference pour la console

Sequence complete d'un onboarding controle, telle que la console devrait l'orchestrer. Les etapes 0.a a 0.d sont hors des quatre APIs du chapitre mais conditionnent tout le reste.

```
0.a Prerequis manuels : ToS Meta Business Agent acceptes dans WhatsApp Manager
        (+ Tech Provider ToS si BSP), pays et vertical supportes.
0.b Prerequis d'assets : app ET WABA assignees au system user,
        permission "View and manage phone numbers" sur la WABA,
        permission whatsapp_business_messaging accordee a l'app
        (+ whatsapp_business_management sur le token, cf. guide).
0.c POST /{WABA_ID}/subscribed_apps       (abonner l'app a la WABA)
    GET  /{WABA_ID}/subscribed_apps       (verification)
0.d Portail developpeur : s'abonner aux champs webhook
        messages, standby, messaging_handovers.

1.  GET  /{entity_id}/agent_eligibility
        -> is_eligible == false : arret, message d'aide (pays / vertical / ToS WhatsApp Manager)

2.  POST /{entity_id}/agent_onboarding?channel=whatsapp
        -> 201 { agent_id }  : persister agent_id

3.  PUT  /{entity_id}/agent_config/settings?agent_id={agent_id}
        {
          "rollout":  { "enabled": false },
          "handoff":  { "enabled": true, "message": "..." },
          "followup": { "enabled": false },
          "ai_audience": "ALLOWLISTED_ONLY"
        }

4.  POST /{entity_id}/agent_config/allowlist   (une fois par numero de test, serialise)
5.  GET  /{entity_id}/agent_config/allowlist   (verification)
6.  GET  /{entity_id}/agent_config/settings    (verification, lire ai_audience)

7.  PUT  /{entity_id}/agent_config/settings?agent_id={agent_id}
        objet COMPLET relu en 6, avec rollout.enabled = true
        (retirer agent_id et channel du corps)

8.  Elargissement, action separee et confirmee :
        PUT settings, objet complet, ai_audience = "EVERYONE"
```

Regles invariantes a inscrire dans le client HTTP :

- `X-API-Version: 2.0.0` sur tous les appels.
- Tout `PUT settings` est precede d'un `GET settings` et envoie l'objet complet, ampute de `agent_id` et `channel`.
- `agent_id` toujours passe en query sur les mises a jour.
- Numeros normalises E.164 avec `+` en un point unique du code.
- 429 : backoff exponentiel, pas de retry immediat, seuil de rate limit inconnu.
- 404 sur DELETE allowlist : succes idempotent.
- 403 sur PUT settings : probleme de droits d'ecriture ou, le plus souvent, asset non assigne au system user. Message distinct du 401, avec renvoi vers la checklist d'assets.
- `delete_agent` exige la permission `whatsapp_business_messaging` (la capability seule ne suffit pas) et son `deleted_agent_id` peut etre absent du corps de reponse.
- Toute erreur non 2xx est un `StandardError` ; ne router que sur le couple (`code HTTP`, `detail`), jamais sur le `title` seul, deux erreurs distinctes de l'allowlist partageant le titre `Invalid request`.

---

<a id="2-operate-control"></a>

## 2. Contrôle du fil : thread control, webhooks standby et messaging_handovers

> Relecture adversariale : 2 erreur(s) et 10 omission(s) corrigées.

### Vue d'ensemble : qui parle, qui écoute

Meta Business Agent (MBA) n'est pas un bot que votre app appelle. C'est un **répondeur automatique installé devant votre app** sur le numéro WhatsApp. Une fois MBA activé sur un numéro, la topologie par défaut est :

- **MBA = responder principal** (« primary responder »). Il répond au consommateur directement, sans passer par vous.
- **Votre app = participant standby**. Elle reçoit tout, mais ne répond pas.

Citation exacte de la page Get Started :

> When Meta Business Agent is enabled, it acts as the **primary responder** for a conversation and answers the consumer directly. Your app is a **standby** participant: it still receives the consumer's messages, plus copies of the messages the agent sends on the business's behalf and their delivery and read receipts, so it stays in sync.

> ATTENTION, précision sur le mot « enabled » : cet état par défaut n'est **pas** automatique dès qu'un numéro est éligible. L'étape 1 de Get Started le dit au point 4 : « Your agent won't reply to customers yet, and you should set up its knowledge and skills first ». Et la description de l'endpoint Settings dans le tableau « Onboard » précise : « Enabling makes the agent start responding to new conversations. » MBA ne devient donc répondeur principal qu'après une activation explicite via l'API Settings. Tant que l'agent n'est pas activé, il n'y a pas de MBA devant l'app et le numéro se comporte comme en Cloud API classique. C'est une bonne nouvelle pour la migration : on peut câbler toute l'intégration avant d'allumer l'agent.

Ce que ça implique concrètement pour mba.messagingme.app, une fois l'agent activé : en régime nominal, notre plateforme est **observatrice**. Elle voit tout le trafic (messages entrants du consommateur, réponses de l'agent, accusés de livraison et de lecture) mais n'émet rien. Le produit ne devient acteur qu'au moment où il **prend le contrôle du fil**, et le contrôle est ce qui décide sur quel champ webhook les messages atterrissent.

#### Le modèle de contrôle

Il n'y a que deux détenteurs possibles du contrôle d'un fil, et un seul à la fois :

| Détenteur du contrôle | Qui répond au consommateur | Le message entrant du consommateur arrive sur |
|---|---|---|
| Meta Business Agent (état par défaut) | MBA, automatiquement | champ webhook `standby` |
| Votre app | votre app (donc l'humain, ou votre logique) | champ webhook `messages` |

Citation exacte, Get Started :

> Which webhook field a consumer's message arrives on depends on who holds control: the **`standby`** field when Meta Business Agent holds control, and the **`messages`** field when your app holds control. A **`messaging_handovers`** webhook notifies you whenever control changes.

> ATTENTION, c'est le piège d'intégration numéro un. Un développeur qui vient de la Cloud API classique câble un handler sur `messages` et considère avoir fini. Avec MBA actif, **`messages` sera vide en régime nominal** : tout le trafic passe par `standby`. Un pipeline d'ingestion qui n'écoute que `messages` ne verra strictement rien tant que l'app n'a pas pris le contrôle, et paraîtra « cassé » sans aucune erreur.

> ATTENTION, corollaire inverse : le même message consommateur n'arrive **pas** sur les deux champs. La doc décrit un routage exclusif (`standby` **ou** `messages` selon le détenteur), pas une duplication. Un pipeline qui écoute les deux champs doit donc les **fusionner dans un même fil de conversation** côté base, pas les traiter comme deux sources distinctes, sinon l'historique d'une conversation se coupe en deux au moment du handoff.

---

### Prérequis et chaîne d'habilitation

Avant qu'un seul webhook n'arrive ou qu'un seul appel ne passe, Get Started impose une chaîne complète de prérequis. Elle est intégralement bloquante : sauter une étape ne produit pas un message d'erreur explicite, mais un silence.

#### Prérequis d'entrée (section Prerequisites)

- Un **WhatsApp Business Account (WABA) ID**
- Un **App ID** pour votre app Meta
- La permission **`whatsapp_business_messaging`** accordée à l'app
- Un business qui opère dans un **« supported country and vertical »** (pays et secteur d'activité supportés, listés dans la page Overview)

> ATTENTION : le critère « supported country and vertical » est un filtre d'éligibilité produit, pas technique. Il conditionne l'apparition même de l'onglet Meta Business Agent dans WhatsApp Manager. À vérifier pour chaque client avant de vendre la brique, et à croiser avec l'endpoint Eligibility (« Check whether a WhatsApp Business phone number can use Meta Business Agent »).

#### Étape 1 : mise en place dans WhatsApp Manager

L'onglet **Meta Business Agent** de WhatsApp Manager n'apparaît que si au moins un numéro est éligible. C'est là que le client configure l'agent sur ses numéros **et** accepte les Terms of Service Meta Business Agent.

#### Étapes 2 à 4 : system user et assignation des assets

Souvent oubliées, et sans elles le token de l'étape 5 ne sert à rien.

- **Étape 2, créer un system user** : Meta Business Suite, **Users** > **System users**, **Add**, avec le rôle **Admin**. (À sauter si un system user existe déjà.)
- **Étape 3, assigner l'app au system user** : sélectionner le system user, **Add assets**, **Apps**, choisir l'app.
- **Étape 4, assigner la WABA au system user** : **Add assets**, **WhatsApp Accounts**, choisir la WABA, et surtout **cocher la permission « View and manage phone numbers »** sur cette WABA.

> ATTENTION : la case « View and manage phone numbers » de l'étape 4 est explicitement exigée par la doc. C'est le genre de case décochée par défaut qui produit ensuite des 403 incompréhensibles sur des endpoints scopés au numéro, Thread Control compris.

#### Étape 5 : générer un token

Deux options selon le modèle d'intégration, détaillées plus bas dans la section Authentification.

#### Étape 6 : abonner l'app à la WABA

Étape indispensable et totalement invisible dans le reste de la doc : **sans elle, aucun webhook n'arrive**, quel que soit le champ souscrit à l'étape 7.

1. Ouvrir le **Graph API Explorer**.
2. Choisir l'app dans le menu déroulant et cliquer **Get App Token**. Une boîte de dialogue demande le Business Portfolio et le compte WhatsApp : **choisir la bonne WABA**.
3. Faire un `POST /{WABA_ID}/subscribed_apps` (référence Subscribed Apps API).
4. Vérifier avec un `GET /{WABA_ID}/subscribed_apps` : en cas de succès, **l'App ID apparaît dans la réponse**.

> ATTENTION : c'est le point de contrôle numéro un du diagnostic « je ne reçois rien ». Avant de soupçonner le parseur, le champ webhook ou le certificat, faire le `GET /{WABA_ID}/subscribed_apps` et vérifier que notre App ID y figure. Notre parcours d'onboarding client doit automatiser ce POST et exposer ce GET comme test de santé.

#### Étape 7 : souscrire aux champs webhook

Dans le portail développeur Meta (onglet **WhatsApp** puis **Configuration**), souscrire à trois champs :

- `messages`
- `standby`
- `messaging_handovers`

Rôles respectifs, tels que la doc les décrit :

##### `standby`
Reçoit les messages du consommateur **quand MBA détient le contrôle**, ainsi que, d'après la description du rôle standby, les copies des messages envoyés par l'agent au nom de l'entreprise et leurs accusés de livraison et de lecture. C'est le flux d'observation : celui qui alimente la timeline de conversation dans notre console, et celui sur lequel doivent tourner les règles de détection (mot-clé d'escalade, sentiment, boucle de l'agent) qui déclenchent une prise de contrôle.

##### `messages`
Reçoit les messages du consommateur **quand votre app détient le contrôle**. C'est le flux opérationnel : celui que l'agent humain lit dans notre interface pendant qu'il a la main.

##### `messaging_handovers`
Notification de **changement de détenteur du contrôle**. C'est la seule source de vérité événementielle sur l'état du contrôle. Il faut la traiter comme la machine à états : c'est elle qui fait basculer une conversation de « pilotée par MBA » à « pilotée par un humain » et retour, dans notre modèle de données.

> ATTENTION : la doc fournie ne documente **aucun schéma de payload** pour `standby`, ni pour `messaging_handovers`. Aucun exemple, aucun champ, aucune structure. Voir la section « Ce que la doc ne dit pas » plus bas : c'est un trou majeur, à combler par observation sur le numéro cobaye avant d'écrire le parseur.

#### L'endpoint Allowlist : l'outil du déploiement contrôlé

Le tableau « Onboard » de Get Started décrit un endpoint Allowlist :

> **Allowlist** : Limit the agent to a specific set of consumer phone numbers, useful for a controlled rollout.

C'est exactement le levier dont on a besoin pour tout le protocole de test recommandé dans ce chapitre : plutôt que d'activer MBA pour tous les consommateurs d'un numéro, on restreint l'agent à une liste de numéros de test. La spec Agent Settings expose le pendant côté réglages, le champ `ai_audience` :

> Controls which consumers the AI agent responds to. `EVERYONE` = all consumers (default), `ALLOWLISTED_ONLY` = only phone numbers in the allowlist. Null for non-WhatsApp entities.

> ATTENTION : le défaut est `EVERYONE`. Un agent activé sans passer `ai_audience` à `ALLOWLISTED_ONLY` répond immédiatement à **tout** le trafic entrant du numéro. Pour nos phases de recette, la séquence sûre est : allowlist peuplée, puis `ai_audience: ALLOWLISTED_ONLY`, puis seulement activation de l'agent.

---

### Prendre le contrôle du fil

#### ⚠️ RÉÉCRIT le 2026-08-18 : une action `take` existe désormais

**Ce chapitre affirmait « il n'y a pas d'endpoint take control ». C'est FAUX depuis la mise à jour Meta du
13 août 2026.** La page `thread-control-cloud-api` documente maintenant trois actions, et son résumé est passé
de « Release thread control » à « **Release or take** thread control for a consumer conversation » :

> « `take` acquires thread control from the current owner and **is restricted to the configured escalation
> partner**. »

Deux conséquences, à ne pas confondre :

- **Sur la doc** : notre enum client (`pass` | `release`) rejetterait une valeur désormais valide, et le
  raisonnement du chapitre « La contradiction pass contre release » plus bas s'appuie sur des phrases qui
  n'existent plus dans la page (« Currently only "release" is supported » a disparu).
- **Sur le produit : rien n'est acquis.** `take` est verrouillé par une notion de **« configured escalation
  partner »** que Meta ne définit nulle part, dont la procédure de désignation est inconnue, et dont rien ne
  dit que nous y ayons droit. Tant que ce point n'est pas instruit, le mécanisme décrit ci-dessous (prendre le
  contrôle en envoyant un message) reste notre seul chemin vérifié.

Le paragraphe qui suit décrit donc l'ancien chemin, qui reste valable, pas le seul possible.

C'est le point le plus contre-intuitif du modèle historique, et il est explicite dans Get Started :

> To respond to a conversation, your app needs control of it. **Your app takes control simply by sending a message to the conversation.**

Autrement dit : **la prise de contrôle est un effet de bord de l'envoi d'un message** via la Cloud API WhatsApp standard (`POST /{phone_number_id}/messages`). Il n'existe pas d'appel dédié pour prendre la main sans parler.

Conséquences directes pour le produit :

- Un opérateur ne peut pas « se mettre en écoute active » ou « verrouiller » une conversation avant d'être prêt à répondre. Le seul moyen de faire taire MBA sur un fil donné est de **publier un message**. Notre UI doit refléter ça : le bouton « reprendre la main » est nécessairement un bouton « reprendre la main **et envoyer** », ou alors il envoie un message de transition (« un conseiller prend le relais ») dont le contenu est un paramètre produit.
- Il y a une **fenêtre de course** entre le moment où on décide d'escalader et le moment où le message part. Pendant cet intervalle, MBA détient toujours le contrôle et peut répondre. La doc ne décrit aucun mécanisme de verrou ni de priorité pour arbitrer ce cas.
- La bascule n'est pas confirmée par la réponse de l'API `/messages` (qui ne dit rien du contrôle). La confirmation arrive de façon **asynchrone, via `messaging_handovers`**. Notre état interne doit donc être optimiste puis réconcilié, pas synchrone.

> ATTENTION : la doc ne précise pas si un envoi de **template** (message sortant hors fenêtre 24 h) prend le contrôle au même titre qu'un message de session, ni si un envoi de campagne (le cas d'usage central de mba.messagingme.app) fait basculer le contrôle et coupe donc MBA sur les fils touchés. C'est une question de première importance : une campagne sortante pourrait, si elle prend le contrôle, désactiver l'agent automatique sur tous les destinataires jusqu'à release explicite. À vérifier en conditions réelles avant toute campagne de volume.

---

### Rendre le contrôle : l'endpoint Thread Control (Cloud API)

Un seul endpoint, une seule opération. Dans la taxonomie OpenAPI, il est classé sous la famille **« Business AI »** (`tags: [{name: "Business AI", description: "Business AI API operations"}]`, et `tags: [Business AI]` sur l'opération POST elle-même) : c'est le tag commun à tout le corpus MBA, utile à connaître si on génère un client à partir des specs, puisque c'est lui qui déterminera le nom de la classe ou du module généré.

Le document est déclaré en **OpenAPI 3.1.1** (`openapi: 3.1.1`), comme le reste du corpus.

#### `POST` Thread Control

##### URL complète

```
POST https://api.facebook.com/business/whatsapp/phone_numbers/{phone_number_id}/thread_control
```

Dans la spec OpenAPI, l'URL du serveur porte déjà tout le chemin (`servers[0].url` = `https://api.facebook.com/business/whatsapp/phone_numbers/{phone_number_id}/thread_control`) et le path déclaré est `/`. L'URL effective est donc bien celle ci-dessus.

> ATTENTION, trois pièges d'URL :
> 1. L'hôte est **`api.facebook.com`**, pas `graph.facebook.com`. Un client HTTP configuré avec la base Graph habituelle appellera la mauvaise machine.
> 2. **Aucun préfixe de version Graph** (`/v21.0/` ou équivalent) n'apparaît dans l'URL. Le versionnage passe par l'en-tête `X-API-Version`, pas par le chemin.
> 3. Le path déclaré étant `/`, la question du slash final (`.../thread_control` contre `.../thread_control/`) n'est pas tranchée par la doc. Tester les deux.

##### En-têtes

| En-tête | Type | Requis | Valeur autorisée | Défaut |
|---|---|---|---|---|
| `X-API-Version` | string | non (`required: false`) | enum à une seule valeur : `1.0.0` | non documenté |
| `Authorization` | HTTP Bearer | voir section Authentification | `Bearer <token>` | sans objet |
| `Content-Type` | string | oui, en pratique | `application/json` | sans objet |

> ATTENTION : `X-API-Version` vaut **`1.0.0`** ici, et non `2.0.0` comme sur tous les autres endpoints MBA (onboarding, settings, allowlist, eligibility, knowledge, connectors, agent event, agent test, agent eval). Thread Control est le seul endpoint du corpus versionné en 1.0.0 (`info.version: 1.0.0`, fichier `..._thread-control-cloud-api_v1.0.0.openapi.yaml`). Un client qui met un `X-API-Version: 2.0.0` global sur tous les appels MBA enverra une valeur hors enum sur celui-ci. Il faut que la version soit un paramètre **par endpoint**, pas une constante de client.

##### Paramètres de chemin

| Nom | Type | Requis | Contrainte | Description |
|---|---|---|---|---|
| `phone_number_id` | integer | oui | `minimum: 1` | WhatsApp Business Account Phone Number ID |

> ATTENTION : le schéma déclare `integer`, alors que Meta expose habituellement les Phone Number ID comme des **chaînes de chiffres** dans ses réponses JSON. En pratique c'est un paramètre de chemin, donc sérialisé en chiffres bruts dans l'URL, sans guillemets. Si votre modèle interne stocke l'ID en string, ne le passez pas entre quotes et méfiez-vous du dépassement d'entier 53 bits si vous le convertissez en `number` JavaScript : préférez le garder en string et le concaténer dans l'URL.

##### Paramètres de requête

Aucun paramètre de requête fonctionnel documenté. Deux des schémas d'authentification passent toutefois par la query string (`access_token`, `oauth_token`), voir Authentification.

##### Corps de requête (`application/json`, requis)

Schéma `ThreadControlRequest`, type `object`. Champs requis : `messaging_product`, `action`.

| Champ | Type | Requis | Valeurs autorisées | Défaut | Description (verbatim de la spec) |
|---|---|---|---|---|---|
| `messaging_product` | string | oui | enum : `whatsapp` (valeur unique) | aucun | « Messaging service used for the request. Must be "whatsapp". » |
| `action` | string | oui | enum : `pass`, `release`, `take` | aucun | ⚠️ **Réécrit par Meta le 2026-08-13.** Verbatim actuel : « The thread control action to perform. "release" relinquishes thread control and hands the conversation back to Meta Business Agent as the automatic responder; you must currently hold thread control. "take" acquires thread control from the current owner and is restricted to the configured escalation partner. "pass" is reserved for future use and is not currently accepted. » |
| `to` | string | non | libre | aucun | « Consumer identifier (phone number or WhatsApp ID) whose thread control is being transferred. » |
| `recipient` | string | non | libre | aucun | « Business-scoped user ID of the consumer whose thread control is being transferred. Accepted but not yet wired; provide `to` instead. » |
| `metadata` | string | non | libre | aucun | 🆕 **Ajouté par Meta le 2026-08-13.** « Optional free-form string forwarded verbatim to the receiving app in the resulting messaging_handovers webhook. » ⚠️ « receiving app » : sur un `release`, l'app receveuse est MBA, pas nous. Rien ne dit que ce champ nous revienne quand c'est nous qui lâchons le contrôle. |

> ATTENTION : **ni `to` ni `recipient` n'est marqué requis** dans le schéma, alors qu'il est évidemment impossible d'identifier une conversation sans l'un des deux. Il faut lire ça comme un `oneOf` non exprimé. En pratique : **toujours envoyer `to`**, jamais `recipient` seul, puisque la spec dit elle-même que `recipient` est « accepted but not yet wired ». Le comportement d'une requête sans `to` ni `recipient` n'est pas documenté (erreur ? no-op ? release sur toutes les conversations du numéro ?). Ne pas tester ça en production.

> ATTENTION : le format exact attendu par `to` n'est pas précisé au-delà de « phone number or WhatsApp ID ». La convention Cloud API est le format E.164 sans `+` ni séparateurs (exemple : `33612345678`). La doc fournie ne le confirme pas. À normaliser côté produit et à valider sur le numéro cobaye.

> ATTENTION : **précondition métier**, en toutes lettres dans la description de `action` : « You must currently hold thread control for the conversation. » Un release sur une conversation dont MBA a déjà le contrôle est donc hors contrat. La doc ne dit pas si c'est une erreur, un no-op silencieux, ou un 200 trompeur. Notre couche doit maintenir l'état du contrôle (alimenté par `messaging_handovers`) et **ne jamais appeler release en aveugle**.

##### Réponse

**200** : « Thread control action result with messaging product identifier. »

Content-Type `application/json`, schéma `ThreadControlResponse` :

| Champ | Type | Requis | Valeurs autorisées | Description |
|---|---|---|---|---|
| `messaging_product` | string | oui | enum : `whatsapp` | « Messaging service used for the response. Always "whatsapp". » |

Corps de réponse effectif :

```json
{ "messaging_product": "whatsapp" }
```

En-têtes de réponse documentés, tous optionnels (`required: false`, type string) :

| En-tête | Description (verbatim) |
|---|---|
| `Vary` | « Vary http response header » |
| `Access-Control-Allow-Origin` | « Denotes whether the response can be shared with requesting code from the given origin » |
| `Facebook-API-Version` | « Effective Graph API version for the request. » |

> ATTENTION : la réponse **ne contient aucune information utile**. Pas de booléen de succès, pas d'identifiant de conversation, pas d'état du contrôle après l'opération, pas d'horodatage. Un 200 confirme uniquement que la requête a été acceptée. **Il n'existe aucun endpoint de lecture de l'état du contrôle** dans tout le corpus : impossible de demander « qui détient le fil de ce consommateur ? ». La seule façon de connaître l'état est de reconstruire une machine à états à partir des webhooks `messaging_handovers` et du champ sur lequel les messages arrivent. Cette machine à états est donc **une pièce obligatoire de notre backend**, pas une optimisation. Et elle n'a pas de mécanisme de resynchronisation : si on rate un webhook, on dérive sans moyen de se recaler par l'API.

##### Codes d'erreur

**La spec ne documente qu'une seule réponse : `200`.** Aucun code d'erreur, aucun schéma d'erreur, aucune enveloppe `error` n'est décrit pour cet endpoint, contrairement à d'autres endpoints du corpus qui définissent un schéma `StandardError` (`title`, `detail` requis, plus `type` et `status`).

C'est une absence, pas une garantie. Il faut coder défensivement en supposant les erreurs Graph habituelles (401 token invalide, 403 permission manquante, 400 payload ou précondition invalide, 429 rate limit, 5xx) et **logger intégralement toute réponse non-200** sur le numéro cobaye pour construire notre propre table d'erreurs. Ne jamais traiter « ce n'est pas dans la spec » comme « ça n'arrive pas ». Il n'est pas non plus garanti que les erreurs de cet endpoint suivent la forme `StandardError` du reste du corpus : hôte différent (`api.facebook.com`), version différente (1.0.0), donc potentiellement enveloppe d'erreur différente (typiquement l'enveloppe Graph `{"error": {...}}`). Notre parseur d'erreur doit tolérer les deux formes.

##### Authentification

Permission requise : **`whatsapp_business_messaging`** (« any of the following Permission: whatsapp_business_messaging »).

Trois schémas de sécurité déclarés, avec les exemples d'usage donnés par la page rendue :

| Schéma | Type | Emplacement | Forme exacte |
|---|---|---|---|
| `OAuthToken__access_token` | API Key | query : `access_token` | `access_token=your-api-key-here` en query |
| `OAuthToken__oauth_token` | API Key | query : `oauth_token` | `oauth_token=your-api-key-here` en query |
| `OAuthToken__Authorization` | HTTP Bearer | header : `Authorization` | `Authorization: Bearer your-token-here` en en-tête |

> ATTENTION : le bloc `security` de la spec place les trois schémas dans **un seul objet de requirement**, ce que la page rendue traduit littéralement par « All endpoints require: OAuthToken__access_token AND OAuthToken__oauth_token AND OAuthToken__Authorization ». Prise au pied de la lettre, cette lecture imposerait d'envoyer le token **trois fois** (deux fois en query string, une fois en en-tête). C'est presque certainement un artefact de génération : la sémantique voulue est un OU (trois façons alternatives de présenter le même token). **Utiliser `Authorization: Bearer <token>`**, qui est la seule des trois qui ne met pas de secret dans une URL (donc dans les logs de proxy et d'accès). Si un 401 persiste, tester l'ajout de `access_token` en query avant de conclure.

Le token à utiliser est celui obtenu à l'étape 5 de Get Started :

- **Option A, system user token** (intégrateurs directs, pour leur propre WABA). Généré depuis Meta Business Suite, **Users** > **System users**, bouton **Generate new token**, en sélectionnant l'app dans le menu déroulant et en cochant les permissions **`whatsapp_business_messaging`** et **`whatsapp_business_management`**.
- **Option B, BISU token** (BSP et Tech Providers agissant pour le compte des WABA de clients), via la documentation Business Integration System User.

Les deux types requièrent `whatsapp_business_messaging` **et** `whatsapp_business_management`.

Prérequis en amont, sans lesquels les appels sont rejetés : Terms of Service Meta Business Agent acceptés par le client dans WhatsApp Manager, **et** Tech Provider Terms of Service acceptés par nous dans le portail développeur (en devenant Tech Provider). Verbatim Get Started : « Meta Business Agent API calls are rejected until the required Terms of Service are accepted. » Pour mba.messagingme.app, positionné comme Tech Provider, c'est un point de blocage d'onboarding à cocher explicitement dans le parcours client.

##### Exemple d'appel

```bash
curl -X POST \
  "https://api.facebook.com/business/whatsapp/phone_numbers/123456789012345/thread_control" \
  -H "Authorization: Bearer $MBA_TOKEN" \
  -H "X-API-Version: 1.0.0" \
  -H "Content-Type: application/json" \
  -d '{
    "messaging_product": "whatsapp",
    "action": "release",
    "to": "33612345678"
  }'
```

Réponse attendue :

```json
{ "messaging_product": "whatsapp" }
```

---

### La contradiction `pass` contre `release`

Les deux sources de la documentation se contredisent frontalement sur l'action à utiliser pour rendre la main à l'agent. Il faut la connaître, parce qu'un développeur qui suit le guide de démarrage écrira du code que la spec dit non supporté.

#### Ce que dit la page Get Started

Section « Conversation routing », dernière phrase (verbatim) :

> To respond to a conversation, your app needs control of it. Your app takes control simply by sending a message to the conversation. To hand control back to Meta Business Agent so it resumes responding, use the [Thread Control (Cloud API)] endpoint with the **`pass`** action.

Le tableau « Operate » de la même page renforce l'ambiguïté en décrivant l'endpoint comme :

> **Pass or take control** of a conversation between your app and the agent.

(« take control » est faux au sens strict : l'endpoint ne permet pas de prendre le contrôle, seul l'envoi d'un message le fait.)

#### Ce que dit la spec OpenAPI

Le fichier `meta-business-agent_reference_operate_thread-control-cloud-api_v1.0.0.openapi.yaml`, description du champ `action` (verbatim) :

> The thread control action to perform. **Currently only "release" is supported**; it relinquishes thread control and hands the conversation back to Meta Business Agent as the automatic responder. **"pass" is reserved for future use.** You must currently hold thread control for the conversation.

#### Laquelle fait foi : `release`

**Utiliser `action: "release"`.** Raisons, par ordre de poids :

1. **Spécificité.** La spec OpenAPI est le contrat machine de cet endpoint précis, versionné indépendamment (1.0.0), et la phrase incriminée est une note d'implémentation explicite sur l'état réel du support (« currently only… is supported », « reserved for future use »). Get Started est une page de vue d'ensemble transverse. En cas de conflit, la référence d'endpoint prime sur le guide.
2. **Deux sources contre une.** La page de référence rendue de l'endpoint (`operate thread control cloud API.md`) reprend **mot pour mot** la même description que le YAML. Ce sont donc deux artefacts alignés (le YAML et sa page générée) contre une page rédigée à la main.
3. **Cohérence interne de la spec.** Le titre (`Thread Control (Cloud API)`), le résumé (« Release thread control for a consumer conversation on a WhatsApp Business phone number »), la description du document (« Release thread control for a consumer conversation, handing the conversation back to Meta Business Agent as the automatic responder. ») et la description de l'opération POST (« Release thread control for a consumer conversation. ») parlent tous de **release**, jamais de pass. Seul l'`operationId` est générique : `passOrReleaseThreadControl`, ce qui trahit un endpoint nommé pour un modèle Messenger (où pass/take/release sont trois opérations distinctes) puis restreint à release pour WhatsApp et MBA.
4. **L'enum contient bien `pass`.** Le champ accepte `pass` au niveau du schéma. C'est précisément ce qui rend l'erreur dangereuse : **un client qui envoie `pass` passera la validation de schéma**. Le rejet, s'il a lieu, sera un rejet applicatif côté Meta, et on ne sait pas s'il se manifeste par une erreur ou par un no-op silencieux (auquel cas la conversation reste orpheline : notre app détient le contrôle, MBA se tait, et personne ne répond au consommateur).

À noter au passage : le `info.description` du document, cité au point 3, est la formulation la plus explicite de tout le corpus sur ce que fait réellement l'endpoint (« handing the conversation back to Meta Business Agent as the automatic responder »). C'est la phrase à reprendre dans nos propres docs internes.

#### Règle d'implémentation à retenir

- Constante unique dans le code : `THREAD_CONTROL_ACTION = "release"`. Ne pas exposer `pass` dans notre API interne ni dans l'UI.
- Si un jour `pass` est activé, la sémantique visée par Get Started (« hand control back to MBA ») serait de toute façon couverte par `release`. `pass` correspond, dans le modèle Messenger dont ce vocabulaire est hérité, au transfert vers **une application tierce désignée**, ce qui n'a pas d'équivalent documenté ici. Ne pas supposer que `pass` et `release` feront la même chose le jour où `pass` sera actif.
- Documenter cet écart dans nos propres notes d'intégration : c'est le genre de piège qui coûte une demi-journée à quelqu'un qui découvre le produit par le guide.

---

### Cycle de vie complet d'un handoff

Séquence de référence, telle qu'on peut la reconstituer à partir de la doc (tout ce qui n'est pas explicitement dans la doc est signalé).

1. **État initial.** L'agent a été activé via Settings, MBA détient le contrôle. Les messages du consommateur arrivent sur `standby`. L'agent répond seul. Notre app observe.
2. **Déclencheur d'escalade.** Détecté par nous, à partir du flux `standby` : mot-clé, sentiment, nombre de tours sans résolution, demande explicite d'un humain, règle métier. *La doc ne décrit aucun mécanisme d'escalade poussé par Meta vers l'app.* Voir la nuance sur le réglage `handoff` ci-dessous.
3. **Prise de contrôle.** Notre app envoie un message dans la conversation via la Cloud API. C'est cet envoi, et rien d'autre, qui prend le contrôle.
4. **Confirmation.** Un webhook `messaging_handovers` notifie le changement de détenteur. Notre machine à états bascule la conversation en mode humain.
5. **Régime humain.** Les messages du consommateur arrivent désormais sur `messages`. MBA ne répond plus. L'agent humain converse via la Cloud API.
6. **Restitution.** Notre app appelle `POST .../thread_control` avec `action: "release"` et `to: <consommateur>`. Réponse 200 avec `{"messaging_product":"whatsapp"}`.
7. **Confirmation de retour.** Un webhook `messaging_handovers` notifie le retour du contrôle à MBA. Les messages suivants du consommateur repartent sur `standby`, et MBA redevient le répondeur automatique.

> ATTENTION : rien dans la doc ne décrit de **release automatique par expiration**. Si notre app prend le contrôle et ne le rend jamais (opérateur qui ferme l'onglet, crash du worker, bug), la conversation reste apparemment bloquée en mode humain **indéfiniment**, avec MBA muet. C'est un mode de panne silencieux et grave côté client final. Il faut construire notre propre garde-fou : un timer d'inactivité par conversation qui déclenche un release automatique, et une réconciliation périodique des conversations « détenues » depuis trop longtemps. Ne pas attendre que Meta le fasse.

#### Les réglages `handoff` et `followup` des Agent Settings : à ne pas confondre avec le thread control

Get Started décrit l'endpoint Settings comme servant à régler, entre autres, « handoff and followup policies ». Ce sont deux objets distincts de la spec `agent-settings` v2.0.0, tous deux **nullable** (donc absents tant qu'ils ne sont pas configurés), et tous deux **sans lien documenté avec le thread control**.

##### `BizAIOmniChannelSettingsHandoff`

« Settings for handing over the conversation to a human agent. Null if not configured »

| Champ | Type | Requis | Description (verbatim) | Exemple de la spec |
|---|---|---|---|---|
| `enabled` | boolean | oui | « Whether handoff to a human agent is enabled. true to enable, false to disable » | `true` |
| `message` | string | non | « The message displayed to the user when a handoff to a human agent occurs » | `Connecting you to a human agent` |

Il s'agit d'un concept **distinct** du thread control : c'est la politique interne de l'agent, qui décide de lui-même de passer la main (l'API Agent Test expose d'ailleurs un champ `handoff_reason`, « If the agent hands off to a human, this contains the reason »).

##### `BizAIOmniChannelSettingsFollowup`

« Settings for following up with an inactive user. Null if not configured »

| Champ | Type | Requis | Description (verbatim) | Valeurs / exemple |
|---|---|---|---|---|
| `enabled` | boolean | oui | « Whether followup is enabled. true to enable, false to disable » | `true` |
| `followup_interval_in_seconds` | integer | non | « The time in seconds of user inactivity before the followup message is sent. Setting to 0 will disable followup » | enum : `0`, `300`, `900`, `1800`, `3600`, `7200`, `28800`, `86400` (exemple `900`) |
| `message` | string | non | « The message sent to follow up with the user after inactivity » | `Is there anything else I can help with?` |

> ATTENTION : `followup` est **l'autre mécanisme par lequel MBA peut émettre un message sans aucune action de notre part**, et il est déclenché par une simple inactivité. Deux implications. (1) Pendant que MBA détient le contrôle, un message peut apparaître dans le fil sans stimulus consommateur : notre timeline et nos règles de détection doivent le tolérer et ne pas l'interpréter comme une réponse à un message entrant. (2) On ne sait pas ce que devient le followup quand **notre app** détient le contrôle : reste-t-il armé et risque-t-il d'envoyer « Is there anything else I can help with? » au milieu d'une conversation humaine ? La doc ne le dit pas. Sur un fil piloté par un conseiller, ce serait une régression d'expérience visible par le client final. À tester explicitement, et à défaut, envisager de désactiver `followup` sur les numéros où le mode humain est fréquent.

> ATTENTION : la doc **ne dit nulle part** si un handoff décidé par l'agent (`handoff.enabled: true`) **libère effectivement le thread control** vers notre app, ou s'il se contente d'afficher le `message` au consommateur en laissant le contrôle à MBA. Les deux lectures sont défendables et elles ont des conséquences produit opposées :
> - Si le handoff transfère le contrôle : nos messages entrants basculent de `standby` vers `messages` sans qu'on ait rien fait, et notre file d'attente humaine doit être alimentée par ce signal.
> - Si le handoff n'affiche qu'un message : le consommateur lit « un conseiller arrive » alors que personne n'est prévenu, et le fil reste sur `standby`. Il nous faudrait alors détecter ce message dans le flux `standby` pour créer le ticket.
>
> C'est **le point le plus important à lever en test réel**, parce que c'est exactement le cœur de valeur de mba.messagingme.app. Le protocole de vérification est simple : restreindre l'agent au numéro cobaye via l'Allowlist et `ai_audience: ALLOWLISTED_ONLY`, activer `handoff` avec un `message` reconnaissable, provoquer une escalade, et observer sur quel champ webhook arrive le message consommateur **suivant** l'escalade, ainsi que la présence ou non d'un `messaging_handovers`.

---

### Ce que la doc ne dit pas

À traiter comme des inconnues à lever, pas comme des détails.

#### Forme du payload `standby`
Aucun schéma, aucun exemple, aucune description de champ. Inconnues précises :
- L'enveloppe est-elle la structure Cloud API habituelle (`object: "whatsapp_business_account"`, `entry[].changes[].value`) avec `field: "standby"` ?
- La valeur contient-elle les mêmes sous-objets que `messages` (`messaging_product`, `metadata`, `contacts`, `messages`) ?
- **Les messages envoyés par l'agent** arrivent-ils dans le même tableau que ceux du consommateur, avec un discriminant (`from` égal au numéro business) ? La doc dit qu'on reçoit « copies of the messages the agent sends », sans dire où ni sous quelle forme. Sans discriminant fiable, impossible d'afficher une timeline correcte.
- **Les accusés** (`statuses` : delivered, read) arrivent-ils sur `standby` ou sur `messages` ? La phrase de Get Started les rattache au rôle standby, mais ne le formalise pas.
- Y a-t-il un marqueur indiquant que MBA est l'auteur, pour distinguer une réponse de l'agent d'un message envoyé par un autre outil sur le même numéro ? Et un marqueur distinguant une réponse de l'agent d'un message de `followup` déclenché par inactivité ?

#### Forme du payload `messaging_handovers`
Rien du tout. Inconnues : nom du champ, structure, identification de la conversation (`to` ? WAMID ?), désignation du nouveau et de l'ancien détenteur, raison du changement, horodatage. Sans ça, impossible d'écrire la machine à états autrement que par rétro-ingénierie sur le trafic réel.

#### Lecture de l'état du contrôle
Aucun endpoint GET. Pas de resynchronisation possible après un webhook perdu.

#### Erreurs de l'endpoint
Seul le 200 est documenté. Aucun code, aucun schéma, aucun message d'erreur, et pas de confirmation que le schéma `StandardError` du reste du corpus s'applique ici.

#### Comportement hors contrat
- Release alors que MBA détient déjà le contrôle : erreur, no-op, ou 200 trompeur ?
- `action: "pass"` : rejeté avec quelle erreur, ou accepté silencieusement sans effet ?
- Requête sans `to` ni `recipient` : comportement inconnu.
- Idempotence : deux releases consécutifs, effet ?

#### Quotas et limites
Aucun rate limit documenté pour cet endpoint, aucune limite de fréquence de bascule sur une même conversation, aucune limite du nombre de conversations simultanément détenues par l'app. Pour un produit qui pilote potentiellement des milliers de fils, c'est une inconnue de dimensionnement.

#### Temporalité
- Délai entre le release et le retour effectif de MBA comme répondeur : non documenté. Si le consommateur écrit dans l'intervalle, qui reçoit le message ?
- Aucun timeout automatique du contrôle détenu par l'app.
- Interaction avec la fenêtre de service client de 24 h : non abordée.

#### Formats
Format exact attendu par `to` (E.164 avec ou sans `+` ?). Sérialisation attendue de `phone_number_id` (typé `integer`, exposé ailleurs comme string).

#### Campagnes et messages sortants
Un envoi de template ou une campagne sortante prend-il le contrôle du fil, et donc coupe-t-il MBA sur tous les destinataires ? Non documenté, et déterminant pour la brique campagnes du produit.

#### Handoff, followup et thread control
Lien non documenté entre `BizAIOmniChannelSettingsHandoff.enabled` et le transfert effectif du contrôle. Comportement de `BizAIOmniChannelSettingsFollowup` quand notre app détient le contrôle : non documenté. Voir la section dédiée ci-dessus.

#### Allowlist et thread control
La doc ne dit pas ce qui se passe pour un consommateur hors allowlist quand `ai_audience` vaut `ALLOWLISTED_ONLY` : ses messages arrivent-ils directement sur `messages` (l'app étant de fait le seul répondeur), ou sur `standby` avec un MBA silencieux ? La réponse change complètement le câblage de la phase de déploiement contrôlé.

---

<a id="3-knowledge"></a>

## 3. Connaissance : business info, FAQ, sites web, fichiers

> Relecture adversariale : 2 erreur(s) et 4 omission(s) corrigées.

### Vue d'ensemble

Quatre familles de sources de connaissance, quatre APIs distinctes, toutes montées sous le même préfixe :

```
https://api.facebook.com/{entity_id}/agent_config/<ressource>
```

| Source | Ressource | Forme | Verbes disponibles |
|---|---|---|---|
| Business info | `business_info` | Singleton (un objet par entité) | GET, PUT, DELETE |
| FAQ | `faq` | Collection | GET (liste), POST, GET/{id}, PUT/{id}, DELETE/{id} |
| Sites web | `websites` | Collection | GET (liste), POST, GET/{id}, PUT/{id}, DELETE/{id} |
| Fichiers | `files` | Collection | GET (liste), POST, GET/{id}, DELETE/{id} |

ATTENTION : `files` n'a **pas** de PUT. Pas de mise à jour de fichier possible. Pour remplacer un document, il faut POST le nouveau puis DELETE l'ancien, dans cet ordre si on veut éviter un trou de connaissance. Un écran de console qui propose un bouton « Remplacer » doit donc orchestrer deux appels et gérer le cas où le POST réussit mais le DELETE échoue (doublon dans la base de connaissance, deux fichiers de même nom, la doc ne dit rien sur l'unicité de `file_name`).

ATTENTION : `business_info` n'a pas de PATCH. Le PUT est un remplacement complet. La console doit toujours faire un GET, fusionner localement, puis renvoyer l'objet entier, sinon les champs non transmis sont perdus (voir plus bas, comportement non explicité par la doc mais impliqué par « fully replace »).

#### Métadonnées communes des quatre specs

| Élément | Valeur |
|---|---|
| Version OpenAPI | `3.1.1` pour les quatre specs |
| Licence déclarée | « Meta Business AI Terms of Service », https://www.facebook.com/legal/3774714022740775 |
| Tags déclarés sur chaque opération | `Business AI` (« Business AI API operations ») et `Knowledge` (« Knowledge base management ») |

ATTENTION : le bloc `license` n'est pas décoratif. Les quatre APIs sont explicitement encadrées par les conditions d'utilisation Business AI de Meta, pas seulement par les conditions WhatsApp Business habituelles. C'est le texte à lire avant de promettre à un client un usage de la connaissance (données personnelles injectées dans les fichiers, contenu crawlé appartenant à un tiers, secteur régulé). À citer dans nos propres CGU si nous exposons ces fonctionnalités.

#### Authentification et en-têtes, communs aux quatre APIs

| Élément | Valeur |
|---|---|
| Schéma de sécurité | `OAuthToken__Authorization`, HTTP Bearer |
| En-tête | `Authorization: Bearer <token>` |
| Portée requise | l'une des deux : capability `bizai_wa_enterprise_api_3p_access` **ou** permission `whatsapp_business_messaging` |
| Versionnage | `X-API-Version`, type string, enum à une seule valeur : `2.0.0`. Paramètre `required: false` dans les quatre specs |
| Content-Type des corps JSON | `application/json` |
| Content-Type de l'upload de fichier | `multipart/form-data` |

ATTENTION : `X-API-Version` est déclaré optionnel, mais son enum ne contient que `2.0.0`. Ne pas l'envoyer signifie laisser Meta choisir la version, donc s'exposer à un changement de schéma silencieux le jour où une 2.1 sort. Envoyer `X-API-Version: 2.0.0` sur **tous** les appels, sans exception. Le client HTTP de la console doit l'injecter au niveau du transport, pas au niveau de chaque appel.

#### Paramètre de chemin commun

| Nom | Type | Requis | Description |
|---|---|---|---|
| `entity_id` | string | oui | Le WhatsApp Business Phone Number ID de l'agent MBA |

ATTENTION : `entity_id` est le **Phone Number ID**, pas le WABA ID, pas le numéro au format E.164. Toute la connaissance est donc scopée au numéro. Deux numéros dans le même WABA ont deux bases de connaissance indépendantes. Pour un client multi-numéros, la console doit dupliquer explicitement les FAQ, sites et fichiers d'un numéro vers l'autre : aucun endpoint de copie ou d'héritage n'existe.

#### Schéma d'erreur commun : `StandardError`

| Propriété | Type | Requis |
|---|---|---|
| `title` | string | oui |
| `detail` | string | oui |
| `type` | string | non |
| `status` | integer | non |

Exemples littéraux fournis dans les specs :

| Code | `title` | `detail` |
|---|---|---|
| 400 | `Bad Request` | `Invalid parameters` |
| 401 | `Unauthorized` | `Authentication credentials are missing or invalid` |
| 403 | `Forbidden` | `The caller is not authorized to access this entity` |
| 404 | `Not Found` | `Resource not found` |
| 429 | `Too Many Requests` | `Rate limit exceeded` |
| 500 | `Internal Server Error` | `An unexpected error occurred` |

Chaque opération déclare aussi une réponse `default` : « Error response. », même schéma `StandardError`. Le parseur d'erreurs doit donc traiter tout statut non listé comme un `StandardError` et ne jamais supposer un corps vide.

ATTENTION : les codes ne sont pas homogènes d'une API à l'autre. **Seule** l'API `websites` documente un `403 Forbidden`. `business_info`, `faq` et `files` ne le documentent nulle part. Ne pas coder un mapping d'erreurs partagé qui suppose la présence du 403 sur toutes les ressources, et ne pas supposer non plus son absence : il peut remonter via la réponse `default`.

ATTENTION : la doc ne donne **aucune valeur pour `type`** (pas d'URI ni de code machine documenté), et aucun catalogue de sous-codes d'erreur. Impossible de distinguer par programme « URL invalide » de « quota de sites atteint » : les deux arrivent en 400 avec `detail: Invalid parameters`. La console doit remonter `title` et `detail` bruts à l'utilisateur, et ne surtout pas construire de logique métier sur le texte de `detail`.

ATTENTION : aucun en-tête de rate limiting n'est documenté (pas de `Retry-After`, pas de `X-Business-Use-Case-Usage`). Sur 429, prévoir un backoff exponentiel avec jitter côté console, seule stratégie sûre. Le quota lui-même (appels par heure, par entité ou par token) n'est pas documenté.

---

### Business info

Base : `https://api.facebook.com/{entity_id}/agent_config/business_info`

Ressource singleton : un seul objet business info par `entity_id`. Le GET « renvoie des valeurs vides ou par défaut si rien n'a été configuré ». La spec documente malgré tout un **404** sur ce verbe, sans préciser le cas qui le déclenche (entité inconnue ? jamais configurée ?). Ne pas supposer qu'une entité vierge répond forcément 200 : traiter le 404 comme un cas possible du GET, à lever en conditions réelles. L'écran de console doit donc gérer les deux issues, et ne pas conclure d'un 404 que le numéro n'existe pas.

#### Schémas

`BizAIOmniChannelKnowledgeBusinessInfoRequest` et `BizAIOmniChannelKnowledgeBusinessInfoResponse` ont exactement les mêmes propriétés, **aucune n'est requise** :

| Propriété | Type | Requis | Description | Exemple de la spec |
|---|---|---|---|---|
| `payment_method` | string | non | Accepted payment methods | `We accept Visa, Mastercard, and PayPal` |
| `return_policy` | string | non | The company return policy | `30-day return policy for unused items` |
| `purchase_info` | string | non | Information about how to make a purchase | `Order online or visit our stores` |
| `delivery_and_shipping` | string | non | Details about delivery and shipping | `Free shipping on orders over $50` |
| `business_description` | string | non | General information about the business | `We are a retail company specializing in home goods` |
| `contact_info` | objet `BizAIOmniChannelKnowledgeContactInfo` | non | (voir ci-dessous) | |

`BizAIOmniChannelKnowledgeContactInfo`, `nullable: true`, description : « Contact and location details for the business. Null if not configured » :

| Propriété | Type | Requis | Description | Exemple de la spec |
|---|---|---|---|---|
| `email` | string | non | Business email address | `support@example.com` |
| `hours_of_operation` | string | non | Business hours of operation | `Mon-Fri 9am-5pm EST` |
| `address` | string | non | Physical address of the business | `123 Main St, New York, NY 10001` |

ATTENTION : `hours_of_operation` est un **texte libre**, pas un objet horaire structuré. Aucun format n'est imposé ni validé. La console ne peut donc pas calculer « ouvert / fermé maintenant » à partir de ce champ, ni le fiabiliser. Si on veut un routage horaire vers un humain (hors horaires, on bascule sur agent humain plutôt que sur l'agent), il faut le construire dans notre couche, avec notre propre modèle d'horaires, et ne se servir de `hours_of_operation` que comme chaîne à afficher au client final par l'agent.

ATTENTION : aucune longueur maximale n'est documentée pour aucun de ces champs. Aucune limite de caractères, aucun format markdown ou HTML précisé, aucune indication sur la langue. Il faut mesurer empiriquement où le 400 tombe et poser une limite conservatrice dans le formulaire de la console.

#### GET / (`getBusinessInfo`)

```
GET https://api.facebook.com/{entity_id}/agent_config/business_info/
Authorization: Bearer <token>
X-API-Version: 2.0.0
```

Réponse 200 : `BizAIOmniChannelKnowledgeBusinessInfoResponse`.
Codes documentés : 200, 400, 404, 401, 429, 500, plus `default`.

#### PUT / (`updateBusinessInfo`)

```
PUT https://api.facebook.com/{entity_id}/agent_config/business_info/
Authorization: Bearer <token>
X-API-Version: 2.0.0
Content-Type: application/json
```

Corps **requis** : `BizAIOmniChannelKnowledgeBusinessInfoRequest`. Description officielle : « Create or fully replace the business information for the specified entity. All provided fields will overwrite existing values. »

Réponse 200 : l'objet business info mis à jour.
Codes documentés : 200, 400, 404, 401, 429, 500, plus `default`.

ATTENTION : la formule exacte est « All provided fields will overwrite existing values », combinée à « fully replace » dans la description de l'API. La doc **ne tranche pas** explicitement le sort d'un champ **omis** : effacé (sémantique PUT stricte) ou conservé (sémantique merge). Le seul comportement sûr à implémenter côté console est de toujours renvoyer l'objet complet issu du dernier GET, champs inchangés inclus. À vérifier en conditions réelles avant de proposer une édition champ par champ.

ATTENTION : `contact_info` étant `nullable`, il faut distinguer trois cas dans le client : clé absente, clé à `null`, clé à objet partiel. La doc ne dit pas si envoyer `contact_info: null` efface le bloc contact. À tester.

ATTENTION : aucun mécanisme de concurrence optimiste (pas d'ETag, pas de `If-Match`, pas de champ `updated_at`). Deux opérateurs de la console éditant la fiche en même temps s'écrasent silencieusement. Si l'écran est multi-utilisateur, il faut poser un verrou applicatif ou un journal de modifications de notre côté.

#### DELETE / (`deleteBusinessInfo`)

```
DELETE https://api.facebook.com/{entity_id}/agent_config/business_info/
Authorization: Bearer <token>
X-API-Version: 2.0.0
```

Sémantique : **reset aux valeurs par défaut**, pas suppression de ressource. Réponse **200** (pas 204) contenant l'objet business info par défaut, c'est-à-dire vide.
Codes documentés : 200, 404, 401, 429, 500, plus `default`. Noter l'absence de 400 sur ce verbe.

ATTENTION : le DELETE ici renvoie un corps 200 exploitable, contrairement aux DELETE des trois autres ressources qui renvoient 204 sans corps. Un client HTTP générique qui suppose « DELETE égale 204 sans corps » cassera sur business_info.

#### Propagation

La doc ne dit **rien** sur le délai entre un PUT réussi et le moment où l'agent utilise réellement la nouvelle information dans une conversation. Aucun statut d'indexation, aucun champ d'horodatage sur cette ressource. Considérer la propagation comme non garantie et non observable via l'API, et prévoir dans la console un test de conversation (voir le chapitre agent test) plutôt qu'un indicateur « à jour » qu'on ne peut pas honnêtement calculer.

---

### FAQ

Base : `https://api.facebook.com/{entity_id}/agent_config/faq`

Collection CRUD complète. Description officielle de l'API : « FAQs are question-answer pairs that the agent references when responding to customer queries. »

#### Schémas

`BizAIOmniChannelKnowledgeFAQRequest`, requis : `question`, `answer`.

| Propriété | Type | Requis | Description |
|---|---|---|---|
| `question` | string | oui | Le texte de la question. La spec recommande d'écrire une question naturelle telle qu'un client la poserait, et qu'une FAQ traite un seul sujet précis. Exemple donné : préférer « What is your return policy? » à « Returns, exchanges, and refunds », car l'agent apparie mieux les questions quand elles reflètent la formulation des clients. |
| `answer` | string | oui | Le texte de la réponse. Doit être factuelle, concise et autoportante, contenir tout ce qu'il faut pour répondre sans relance, et éviter de renvoyer à une autre FAQ, car l'agent récupère chaque entrée indépendamment. |
| `metadata` | objet, `additionalProperties: string` | non | Métadonnées clé-valeur associées à l'entrée |

Exemple de `question` dans la spec : `What is your return policy?`
Exemple de `answer` dans la spec : `We offer a 30-day return policy for unused items in their original packaging. To start a return, visit your order history and select the item you want to return. Refunds are processed within 5-7 business days.`

`BizAIOmniChannelKnowledgeFAQResponse`, requis : `id`, `question`, `answer`.

| Propriété | Type | Requis | Description | Exemple |
|---|---|---|---|---|
| `id` | string | oui | Identifiant unique de l'entrée FAQ | `1234567890` |
| `question` | string | oui | Le texte de la question | `What is your return policy?` |
| `answer` | string | oui | Le texte de la réponse | `We offer a 30-day return policy for unused items` |
| `created_at` | integer | non | Timestamp de création de la FAQ | `1714500000` |
| `metadata` | objet, `additionalProperties: string` | non | Métadonnées clé-valeur | |

ATTENTION : `created_at` est un **integer** (epoch en secondes, d'après l'exemple `1714500000`), pas une date ISO. Aucun `updated_at` n'existe. On ne peut pas afficher « modifié le » dans la console sans le stocker de notre côté au moment de l'écriture. C'est un point à câbler dès le premier jour, sinon l'historique est perdu définitivement.

ATTENTION : le champ `metadata` est un dictionnaire libre string vers string, sans schéma, sans limite documentée de nombre de clés ni de longueur de valeur. C'est le **seul point d'accroche** dont on dispose pour rattacher une FAQ à notre modèle interne (auteur, campagne d'origine, version, catégorie, statut de validation, identifiant dans notre base). Il faut définir dès maintenant un préfixe de clés propre au produit (par exemple `mm_*`) pour ne pas collisionner avec ce que Meta ou un autre outil pourrait y écrire, et ne jamais supposer que `metadata` revient intact si un autre outil écrit sur la même entité.

ATTENTION : la description de l'API mentionne « Each FAQ entry has a question, answer, optional type, source, and tags ». Ces trois champs `type`, `source` et `tags` **n'existent dans aucun schéma** de la spec 2.0.0. C'est une incohérence de la doc (la première des trois relevées dans ce chapitre). Ne pas les envoyer, ne pas les attendre en réponse. Le seul emplacement réel pour cette information est `metadata`.

#### Limite de nombre

La description de l'API dit : « Adding too many FAQs (generally beyond a few hundred) can degrade the agent's ability to find the right answer. Prioritize the questions your customers ask most frequently ».

ATTENTION : « a few hundred » est une **recommandation de qualité, pas un quota technique**. Aucune limite dure n'est documentée, aucun code d'erreur associé au dépassement. La dégradation est silencieuse : au-delà, l'agent répond moins bien, mais l'API continue de renvoyer 201. C'est exactement le genre de dérive qu'une console de pilotage doit rendre visible : compteur de FAQ affiché en permanence, alerte visuelle au passage de quelques centaines, et incitation à fusionner ou archiver plutôt qu'à empiler. Aucune limite de longueur n'est documentée pour `question` ni pour `answer`.

#### GET / (`listFAQs`)

```
GET https://api.facebook.com/{entity_id}/agent_config/faq/
Authorization: Bearer <token>
X-API-Version: 2.0.0
```

Réponse 200 : **tableau JSON nu** de `BizAIOmniChannelKnowledgeFAQResponse` (pas d'enveloppe `data`, pas d'objet `paging`).
Codes documentés : 200, 400, 404, 401, 429, 500, plus `default`.

ATTENTION : **aucune pagination n'est documentée**, aucun paramètre de requête (pas de `limit`, `after`, `offset`, ni de filtre ou de tri). Avec plusieurs centaines de FAQ, la liste part en un seul bloc. Deux conséquences pour la console : mettre en cache le résultat côté serveur plutôt que de rappeler l'API à chaque rendu, et implémenter recherche, tri et filtrage **côté client**, puisque l'API n'en offre aucun. Si Meta ajoute une pagination implicite plus tard, un client qui suppose « la liste est complète » se retrouvera à supprimer ou désynchroniser des entrées invisibles : ne jamais faire de réconciliation destructive (« tout ce qui n'est pas dans ma liste locale, je le supprime ») sur la base de ce GET.

#### POST / (`createFAQ`)

```
POST https://api.facebook.com/{entity_id}/agent_config/faq/
Authorization: Bearer <token>
X-API-Version: 2.0.0
Content-Type: application/json

{"question": "...", "answer": "...", "metadata": {"cle": "valeur"}}
```

Corps requis. Réponse **201** : l'entrée FAQ créée, avec son `id`.
Codes documentés : 201, 400, 401, 429, 500, plus `default`. Noter qu'il n'y a **pas de 404** sur ce verbe.

ATTENTION : pas d'endpoint de création en lot. L'import d'un jeu de FAQ depuis un fichier, cas d'usage évident d'onboarding, se fait en N appels POST séquentiels. Il faut donc, côté console : limiter la concurrence (le 429 est le risque principal), rendre l'import reprenable, et journaliser chaque `id` retourné pour pouvoir annuler l'import en cas d'échec partiel. Aucune transactionnalité n'existe : un import interrompu laisse la moitié des FAQ en place.

ATTENTION : rien n'indique que l'API déduplique. Rejouer un import crée vraisemblablement des doublons. La détection de doublon est à notre charge, avant l'appel.

#### GET /{faq_id} (`getFAQ`)

```
GET https://api.facebook.com/{entity_id}/agent_config/faq/{faq_id}
```

Paramètre de chemin supplémentaire : `faq_id`, string, requis, « The unique identifier of the FAQ entry ».
Réponse 200 : `BizAIOmniChannelKnowledgeFAQResponse`.
Codes documentés : 200, 400, 404, 401, 429, 500, plus `default`.

#### PUT /{faq_id} (`updateFAQ`)

```
PUT https://api.facebook.com/{entity_id}/agent_config/faq/{faq_id}
Content-Type: application/json
```

Corps requis : `BizAIOmniChannelKnowledgeFAQRequest`, donc `question` et `answer` **obligatoires même en modification**.
Réponse 200 : l'entrée mise à jour.
Codes documentés : 200, 400, 404, 401, 429, 500, plus `default`.

ATTENTION : on ne peut pas modifier la seule réponse en omettant la question, le schéma de corps est identique à celui de la création. La console doit toujours renvoyer les deux champs. Corollaire pour `metadata` : la doc ne dit pas si omettre `metadata` dans un PUT efface les métadonnées existantes. Traiter comme un remplacement complet et toujours renvoyer les métadonnées lues au GET.

#### DELETE /{faq_id} (`deleteFAQ`)

```
DELETE https://api.facebook.com/{entity_id}/agent_config/faq/{faq_id}
```

Réponse **204** sans corps.
Codes documentés : 204, 404, 401, 429, 500, plus `default`. Pas de 400.

ATTENTION : pas de suppression en lot, pas de corbeille, pas d'archivage. Un DELETE est irréversible côté Meta. Si la console veut un bouton « désactiver cette FAQ » (retirer une réponse automatique sans perdre le contenu), il faut la supprimer chez Meta et la conserver dans notre base, puis la recréer à la réactivation, avec un **nouvel `id`**. Prévoir dès la conception que l'identifiant Meta n'est pas stable à travers un cycle désactivation puis réactivation, et que toute référence à cet identifiant dans nos données doit être remappée.

#### Propagation et statut d'indexation

Il n'y a **aucun champ de statut** sur une FAQ : pas d'`indexing_status`, pas de `state`, pas d'`error`. Une FAQ créée avec 201 est réputée présente. La doc ne documente aucun délai entre le 201 et le moment où l'agent s'en sert. À observer en réel.

---

### Sites web

Base : `https://api.facebook.com/{entity_id}/agent_config/websites`

Description officielle : le système crawle et extrait le contenu des sites soumis pour enrichir la connaissance de l'agent.

#### Schémas

`BizAIKnowledgeWebsiteRequest`, requis : `url`.

| Propriété | Type | Requis | Description | Exemple |
|---|---|---|---|---|
| `url` | string | oui | The URL of the website to crawl | `https://www.example.com` |

C'est **tout**. Un seul champ.

ATTENTION : la description de haut niveau de l'API annonce « Businesses can submit website URLs with **optional crawl depth and frequency settings** ». Ces réglages **n'existent dans aucun schéma** de la spec 2.0.0. Il n'y a ni `depth`, ni `frequency`, ni `include`/`exclude`, ni sitemap. Deuxième incohérence de la doc, du même type que `type`/`source`/`tags` sur les FAQ. Conséquence produit directe : **on ne contrôle pas le périmètre du crawl**. Impossible d'exclure une section du site (blog, mentions légales, pages obsolètes, espace client) par l'API. Le seul levier réel est de choisir soigneusement l'URL soumise, et de vérifier après coup ce que le crawl a réellement ingéré.

ATTENTION : aucune contrainte de format n'est déclarée sur `url` (pas de `format: uri`, pas de pattern). Le schéma est un simple `string`. La validation d'URL est donc entièrement à notre charge en amont, sinon on récolte un 400 générique. Le `https://` n'est pas documenté comme obligatoire.

`BizAIKnowledgeWebsiteResponse`, requis : `id`, `url`.

| Propriété | Type | Requis | Description | Exemple |
|---|---|---|---|---|
| `id` | string | oui | Identifiant unique de l'entrée de crawl | `1234567890` |
| `url` | string | oui | L'URL du site crawlé | `https://www.example.com` |
| `crawl_status` | string | non | The current status of the crawl (e.g., "pending", "in_progress", "completed", "failed") | `COMPLETED` |
| `pages_crawled` | integer | non | Nombre de pages crawlées avec succès | `42` |
| `last_crawled_at` | integer | non | Timestamp du dernier crawl réussi | `1714500000` |
| `created_at` | integer | non | Timestamp de création de l'entrée | `1714500000` |

#### Statuts de crawl

ATTENTION, piège majeur : `crawl_status` est déclaré `type: string` **sans enum**. La description donne quatre valeurs entre guillemets et en minuscules, précédées de « e.g. » (donc explicitement non exhaustives) : `pending`, `in_progress`, `completed`, `failed`. Mais l'**exemple** du même champ vaut `COMPLETED`, en majuscules. La doc se contredit sur la casse et n'engage pas sur la liste.

Conséquences impératives pour le client HTTP :

- Normaliser la casse avant toute comparaison (`crawl_status.toUpperCase()`), jamais d'égalité stricte sur `"completed"`.
- Traiter la liste comme ouverte : toute valeur inconnue doit tomber dans un état d'affichage « autre, valeur brute » et **ne jamais être interprétée comme un succès**.
- Le champ étant `required: false`, il peut être **absent**. Un site sans `crawl_status` n'est ni en succès ni en échec : afficher « inconnu », pas « en cours ».

Transitions : la doc **ne décrit aucune machine à états**. Elle ne dit pas si `pending` mène toujours à `in_progress`, si un `failed` est réessayé automatiquement, ni si un `completed` peut repasser à `in_progress` lors d'un recrawl périodique. La présence de `last_crawled_at` (« dernier crawl **réussi** ») suggère des crawls répétés, mais **aucune fréquence de recrawl n'est documentée**, et aucun endpoint ne permet de **déclencher** un recrawl à la demande.

ATTENTION : il n'existe pas de « bouton recrawler ». Le seul contournement plausible est PUT sur l'entrée avec la même URL, ou DELETE puis POST, mais la doc ne garantit ni l'un ni l'autre. Ne pas promettre cette fonctionnalité dans la console avant l'avoir vérifiée en réel. Si on l'implémente par DELETE puis POST, l'entrée change d'`id` et la connaissance disparaît le temps du nouveau crawl.

#### Échec de crawl

ATTENTION : quand un crawl échoue, la seule information disponible est `crawl_status` valant probablement `failed` ou `FAILED`. **Aucun champ d'erreur, aucun message, aucune raison** n'est prévu dans le schéma de réponse : ni code HTTP rencontré sur le site, ni « bloqué par robots.txt », ni « domaine injoignable », ni « certificat invalide ». La console ne pourra donc afficher que « le crawl a échoué », sans expliquer pourquoi. C'est un point de friction d'onboarding à anticiper : prévoir dans notre couche des vérifications préalables côté serveur (URL joignable, statut 200, robots.txt permissif, contenu non entièrement rendu en JavaScript) pour donner au client un diagnostic que Meta ne fournit pas.

ATTENTION : le POST renvoie **201 immédiatement**, avant que le crawl n'ait eu lieu. Le 201 signifie « entrée créée », pas « site ingéré ». La console doit poller `GET /{website_id}` pour suivre `crawl_status`, sans indication de fréquence de polling recommandée ni de délai typique de crawl dans la doc. Aucun webhook de fin de crawl n'est documenté. Prévoir un polling à intervalle croissant et un timeout d'affichage côté produit.

ATTENTION : `pages_crawled` est le seul indicateur du volume ingéré. Une valeur anormalement basse (1 page sur un site de 500) ou anormalement haute est le signal le plus utile pour détecter un crawl inutile ou hors périmètre. À afficher systématiquement dans la console, à côté du statut, avec comparaison à la valeur du crawl précédent (que nous devons stocker nous-mêmes, l'API ne conserve pas d'historique).

#### GET / (`listKnowledgeWebsites`)

```
GET https://api.facebook.com/{entity_id}/agent_config/websites/
Authorization: Bearer <token>
X-API-Version: 2.0.0
```

Réponse 200 : tableau nu de `BizAIKnowledgeWebsiteResponse`. Pas de pagination, pas de paramètre de requête.
Codes documentés : 200, 400, 404, 401, **403**, 429, 500, plus `default`.

#### POST / (`addKnowledgeWebsite`)

```
POST https://api.facebook.com/{entity_id}/agent_config/websites/
Content-Type: application/json

{"url": "https://www.example.com"}
```

Réponse **201** : l'entrée créée.
Codes documentés : 201, 400, 401, **403**, 429, 500, plus `default`. Pas de 404.

ATTENTION : aucun nombre maximal de sites par entité n'est documenté. Aucun code d'erreur spécifique au dépassement de quota. Aucune règle d'unicité : rien ne dit qu'on ne peut pas ajouter deux fois la même URL. Vérifier l'unicité côté console avant l'appel.

#### GET /{website_id} (`getKnowledgeWebsite`)

Paramètre de chemin `website_id`, string, requis, « The unique identifier of the website crawl entry ».
Réponse 200 : `BizAIKnowledgeWebsiteResponse`.
Codes documentés : 200, 400, 404, 401, **403**, 429, 500, plus `default`.
C'est l'endpoint de polling du statut de crawl.

#### PUT /{website_id} (`updateKnowledgeWebsite`)

```
PUT https://api.facebook.com/{entity_id}/agent_config/websites/{website_id}
Content-Type: application/json

{"url": "https://www.example.com/nouveau"}
```

Corps requis : `BizAIKnowledgeWebsiteRequest`, donc `url` obligatoire (seul champ existant).
Réponse 200 : l'entrée mise à jour.
Codes documentés : 200, 400, 404, 401, **403**, 429, 500, plus `default`.

ATTENTION : changer l'`url` d'une entrée existante ne dit rien sur le sort du contenu déjà crawlé depuis l'ancienne URL. Est-il purgé, conservé, remplacé au prochain crawl ? La doc est muette. Ne pas proposer « modifier l'URL » comme une opération anodine dans la console : présenter DELETE puis POST comme le chemin propre tant que le comportement du PUT n'est pas vérifié.

#### DELETE /{website_id} (`deleteKnowledgeWebsite`)

Réponse **204** sans corps.
Codes documentés : 204, 404, 401, **403**, 429, 500, plus `default`. Pas de 400.

ATTENTION : la doc ne dit pas si la suppression de l'entrée purge immédiatement le contenu déjà indexé issu du crawl. En cas de retrait urgent d'information (page contenant une erreur de prix, une promotion expirée, une mention réglementaire fausse), on ne peut donc pas garantir au client que l'agent cessera d'y faire référence dès le 204. C'est un risque à formuler explicitement, et une raison forte de prévoir dans la console un levier de repli immédiat au niveau du contrôle du fil (couper l'automatique, passer la main à un humain) plutôt que de compter sur la suppression de la source.

---

### Fichiers

Base : `https://api.facebook.com/{entity_id}/agent_config/files`

Quatre opérations seulement : lister, uploader, récupérer, supprimer. Pas de PUT.

#### Schémas

`BizAIOmniChannelKnowledgeFileRequest`, corps en `multipart/form-data`, requis : `file_name`, `file`.

| Propriété | Type | Requis | Description |
|---|---|---|---|
| `file_name` | string | oui | The name of the file being uploaded. Exemple : `product-guide.pdf` |
| `file` | string, `format: binary` | oui | Le fichier à envoyer (voir limites ci-dessous) |

Limites et formats, recopiés littéralement de la spec :

- Taille maximale : **100000000 bytes** (100 000 000 octets, soit 100 Mo décimaux, à ne pas confondre avec 100 MiB).
- Types de fichier supportés :
  - `.pdf`
  - `.doc`
  - `.docx`
  - `.png`
  - `.jpg`
  - `.jpeg`
  - `.csv`, **uniquement si l'extraction CSV est activée pour l'asset WhatsApp**
  - `.xlsx`, **uniquement si l'extraction XLSX est activée pour l'asset WhatsApp**

ATTENTION : `.csv` et `.xlsx` sont **conditionnels à un réglage de l'asset WhatsApp**, et la doc de cette API ne dit **ni comment vérifier** si l'extraction est activée, **ni comment l'activer**, ni quel code d'erreur remonte quand elle ne l'est pas (vraisemblablement un 400 générique). La console doit donc traiter CSV et XLSX comme « peut échouer selon la configuration du compte » : ne pas les présenter comme garantis, et afficher un message d'aide dédié quand l'upload d'un CSV ou d'un XLSX part en 400 alors qu'un PDF passe.

ATTENTION : formats notablement **absents** de la liste : `.txt`, `.md`, `.html`, `.rtf`, `.pptx`, `.odt`. Le convertisseur est à notre charge. Le cas le plus fréquent en onboarding, un client qui envoie ses procédures en `.txt` ou en markdown, exige une conversion en PDF côté console.

ATTENTION : troisième incohérence de la doc, du même type que `type`/`source`/`tags` sur les FAQ et `crawl depth`/`frequency` sur les sites. La description de l'API `files` annonce « Files such as PDFs, **text documents**, or other supported formats can be uploaded », alors que la liste des types supportés du schéma ne contient **ni `.txt` ni aucun format texte brut**. Ne pas se fier à cette phrase pour promettre l'upload de documents texte : la liste du schéma fait foi, et le `.txt` en est absent. Retenir la règle générale : sur ces quatre APIs, **les descriptions en prose annoncent plus que les schémas ne fournissent**. Toujours implémenter d'après le schéma, jamais d'après la description.

ATTENTION : `.png`, `.jpg` et `.jpeg` sont acceptés, ce qui implique une extraction de contenu depuis des images. La doc **ne dit rien** sur ce qui en est réellement extrait (OCR ? description visuelle ? rien ?). Ne rien promettre là-dessus au client tant que ce n'est pas vérifié sur un cas réel.

ATTENTION : `file_name` est un champ **séparé** du fichier binaire. Rien ne garantit que Meta déduise l'extension du contenu binaire plutôt que de `file_name`. Toujours envoyer un `file_name` avec l'extension correcte et cohérente avec le contenu, sinon on s'expose à un rejet ou, pire, à une ingestion silencieusement ratée.

`BizAIOmniChannelKnowledgeFileResponse`, requis : `id`, `file_name`.

| Propriété | Type | Requis | Description | Exemple |
|---|---|---|---|---|
| `id` | string | oui | Identifiant unique du fichier | `1234567890` |
| `file_name` | string | oui | Nom du fichier | `product-guide.pdf` |

ATTENTION, piège le plus important de cette ressource : la réponse ne contient **que deux champs**. Pas de `status`, pas d'`indexing_status`, pas de `size`, pas de `created_at`, pas de `page_count`, pas d'`error`, pas d'URL de téléchargement. Concrètement :

- **On ne peut pas savoir si un fichier a été correctement indexé.** Un 201 signifie « fichier reçu », pas « contenu exploitable par l'agent ». Un PDF scanné sans couche texte, un document protégé par mot de passe ou un fichier corrompu peuvent très bien retourner 201 et n'apporter aucune connaissance. Il n'existe **aucun moyen par l'API de le détecter**.
- **On ne peut pas relire le contenu**, ni le retélécharger, ni vérifier ce que l'agent a réellement retenu. `GET /{file_id}` renvoie exactement les mêmes deux champs que la liste : c'est un endpoint de métadonnées, pas de contenu.
- La console doit donc **conserver de son côté** tout ce que Meta ne renvoie pas : le binaire d'origine ou son hash, la taille, la date d'upload, l'auteur, la version. Sans cela, l'écran de connaissance ne pourra afficher qu'une liste de noms de fichiers, ce qui est inexploitable pour un client.
- Le seul moyen de vérifier qu'un fichier « prend » est **de tester une question en conversation** et de constater si l'agent répond juste. À prévoir explicitement dans le parcours d'onboarding de la console, pas comme une option.

#### GET / (`listKnowledgeFiles`)

```
GET https://api.facebook.com/{entity_id}/agent_config/files/
Authorization: Bearer <token>
X-API-Version: 2.0.0
```

Réponse 200 : tableau nu de `BizAIOmniChannelKnowledgeFileResponse`. Pas de pagination, pas de paramètre de requête.
Codes documentés : 200, 400, 404, 401, 429, 500, plus `default`. Pas de 403.

#### POST / (`uploadKnowledgeFile`)

```
POST https://api.facebook.com/{entity_id}/agent_config/files/
Authorization: Bearer <token>
X-API-Version: 2.0.0
Content-Type: multipart/form-data; boundary=...

--boundary
Content-Disposition: form-data; name="file_name"

product-guide.pdf
--boundary
Content-Disposition: form-data; name="file"; filename="product-guide.pdf"
Content-Type: application/pdf

<binaire>
--boundary--
```

Réponse **201** : `{"id": "...", "file_name": "..."}`.
Codes documentés : 201, 400, 401, 429, 500, plus `default`. Pas de 404, pas de 403.

ATTENTION : c'est le seul endpoint des quatre APIs de connaissance en `multipart/form-data`. Le client HTTP partagé de la console, s'il pose `Content-Type: application/json` par défaut, doit être court-circuité ici. Ne pas fixer manuellement le `Content-Type` sur cette requête : laisser la bibliothèque multipart générer la `boundary`.

ATTENTION : aucun upload en lot, un fichier par appel. Aucun nombre maximal de fichiers par entité n'est documenté. Aucune taille cumulée maximale n'est documentée. Aucun comportement en cas de doublon de `file_name` n'est documenté (écrasement ou coexistence, inconnu).

ATTENTION : avec 100 Mo par fichier autorisés et aucun `Content-Length` de retour, prévoir côté console un timeout d'upload généreux, une barre de progression basée sur l'émission locale, et une validation de taille et d'extension **avant** l'appel réseau : envoyer 100 Mo pour récolter un 400 `Invalid parameters` est la pire expérience possible.

#### GET /{file_id} (`getKnowledgeFile`)

```
GET https://api.facebook.com/{entity_id}/agent_config/files/{file_id}
```

Paramètre de chemin `file_id`, string, requis, « The unique identifier of the file ».
Réponse 200 : `BizAIOmniChannelKnowledgeFileResponse` (les deux mêmes champs).
Codes documentés : 200, 400, 404, 401, 429, 500, plus `default`.

Utilité pratique : essentiellement vérifier qu'un `file_id` existe encore. Aucune information de plus que la liste.

#### DELETE /{file_id} (`deleteKnowledgeFile`)

```
DELETE https://api.facebook.com/{entity_id}/agent_config/files/{file_id}
```

Réponse **204** sans corps.
Codes documentés : 204, 404, 401, 429, 500, plus `default`. Pas de 400, pas de 403.

ATTENTION : même remarque que pour les sites. La doc ne dit pas si la suppression purge immédiatement le contenu déjà indexé. Pour un retrait d'urgence (tarif erroné dans un PDF diffusé), ne pas compter sur le DELETE seul.

---

### Ce que ces quatre APIs ne permettent pas, et qui compte pour la console

Résumé des manques structurels, tous vérifiés comme absents des quatre specs. Ils dessinent en creux la valeur de notre couche.

- **Aucune notion d'activation ou de désactivation d'une source.** Une source est présente ou supprimée, sans état intermédiaire. Il n'y a pas de « brouillon », pas de « publié », pas de « suspendu ». Or le contrôle de ce à quoi l'agent répond automatiquement est précisément la promesse du produit : ce cycle de vie doit donc être entièrement porté par notre couche, avec un état local et une synchronisation qui crée ou supprime chez Meta. Conséquence technique déjà notée : les identifiants Meta ne survivent pas à un cycle désactivation puis réactivation.
- **Aucun ciblage d'audience ni de segment.** La connaissance est globale à l'`entity_id`. On ne peut pas décider qu'une FAQ ne s'applique qu'à certains contacts, certains pays, certaines heures. Toute segmentation est à construire chez nous, et ne pourra pas s'exprimer via ces APIs.
- **Aucun signal de handoff au niveau de la connaissance.** On ne peut pas marquer une FAQ « ne réponds pas, passe la main à un humain ». Le seul champ où stocker une intention de ce type est le `metadata` des FAQ, et il est **inerte** du point de vue de Meta : rien n'indique que l'agent en tienne compte. Le passage à l'humain se pilote donc ailleurs (contrôle du fil, allowlist, réglages de l'agent), pas ici. Ne jamais laisser croire dans l'interface qu'un tag de FAQ déclenche un handoff.
- **Aucun retour d'usage.** Impossible de savoir quelle FAQ a servi à répondre, quel fichier a été cité, quelle page crawlée a été utilisée. Aucun compteur d'utilisation, aucune attribution de source dans les réponses. On ne peut donc pas dire au client « cette FAQ vous a évité 40 conversations » à partir de ces APIs seules.
- **Aucune historisation, aucun audit.** Les seuls horodatages exposés sont `created_at` sur les FAQ, et `created_at` plus `last_crawled_at` sur les sites. Aucun horodatage sur `business_info` ni sur les fichiers. Aucun `updated_at` nulle part, aucun auteur, aucun journal. Si nous voulons un historique des modifications de la connaissance, cas de figure attendu chez un client sérieux ou en secteur régulé, il faut l'écrire nous-mêmes au moment de chaque appel. C'est irrattrapable a posteriori.
- **Aucun mécanisme de concurrence.** Ni ETag, ni version, ni verrou. Deux opérateurs simultanés s'écrasent en silence sur `business_info` et sur une FAQ donnée.
- **Aucune indication de propagation.** Rien ne permet de répondre à « à partir de quand l'agent connaît-il cette information ? » pour aucune des quatre sources. Le seul vérificateur honnête est un test de conversation.

---

<a id="4-skills"></a>

## 4. Skills : instructions système, ton, priorités

> Relecture adversariale : chapitre jugé fidèle à la source.

#### Vue d'ensemble

Les **skills** sont l'unite de personnalisation la plus fine de l'agent MBA. Chaque skill est un triplet (titre, description de declenchement, corps d'instructions) attache a une entite, c'est-a-dire a un **WhatsApp Business Phone Number ID**. La spec le formule ainsi : les skills definissent les lignes de conduite comportementales, le ton de voix et les patterns de reponse de l'agent, et **l'agent suit les skills telles qu'elles sont ecrites** (« The agent follows skills as written, so write them as clear directives »).

Deux consequences directes pour un produit de pilotage comme mba.messagingme.app :

1. Tout ce qui releve du **controle du fil** (a quoi l'agent repond, a quoi il ne repond pas, quand il passe la main a un humain) doit etre exprime dans le corps `skill`, en langage naturel imperatif. La spec n'expose **aucun champ structure** de type `enabled`, `priority`, `scope`, `fallback` ou `handoff`. Il n'y a pas de mecanisme declaratif de handoff dans cette API.
2. La seule granularite technique est le **document skill**. Le seul levier de hierarchisation documente est **redactionnel** : ecrire des declencheurs disjoints et consolider les actions concurrentes dans une seule skill.

Source : `Agent Skills`, OpenAPI 3.1.1, `info.version: 2.0.0`, licence « Meta Business AI Terms of Service » (https://www.facebook.com/legal/3774714022740775).

##### Base URL et authentification

Le serveur declare dans la spec est deja **prefixe par l'entite et le sous-chemin** :

```
https://api.facebook.com/{entity_id}/agent_config/skills
```

Les chemins d'operation (`/` et `/{skill_id}`) s'ajoutent a cette base. Les URL completes sont donc :

| Operation | URL complete |
|---|---|
| List | `GET https://api.facebook.com/{entity_id}/agent_config/skills/` |
| Create | `POST https://api.facebook.com/{entity_id}/agent_config/skills/` |
| Get | `GET https://api.facebook.com/{entity_id}/agent_config/skills/{skill_id}` |
| Update | `PUT https://api.facebook.com/{entity_id}/agent_config/skills/{skill_id}` |
| Delete | `DELETE https://api.facebook.com/{entity_id}/agent_config/skills/{skill_id}` |

ATTENTION : le chemin de collection est litteralement `/` dans la spec, donc l'URL canonique se termine par un slash (`.../skills/`). La doc ne precise pas si `.../skills` sans slash final est accepte. A verifier en conditions reelles avant de figer le client HTTP ; en attendant, emettre la forme avec slash final, qui est celle de la spec.

**Authentification** : schema unique `OAuthToken__Authorization`, type HTTP Bearer, en en-tete `Authorization`.

```
Authorization: Bearer <token>
```

`security` est declare au niveau global : **toutes** les operations l'exigent, y compris le DELETE.

**Habilitations** requises (doc de reference, section Authorization) : « any of the following »
- Capability : `bizai_wa_enterprise_api_3p_access`
- Permission : `whatsapp_business_messaging`

##### En-tetes

| En-tete | Type | Requis | Valeurs autorisees |
|---|---|---|---|
| `Authorization` | string | oui (securite globale) | `Bearer <token>` |
| `X-API-Version` | string | **non** (`required: false`) | enum a une seule valeur : `2.0.0` |
| `Content-Type` | string | oui pour POST et PUT | `application/json` |

ATTENTION : `X-API-Version` est optionnel dans la spec mais son enum ne contient que `2.0.0`. La doc **ne dit pas** quelle version est appliquee quand l'en-tete est absent (elle ne documente aucun defaut). Envoyer systematiquement `X-API-Version: 2.0.0` sur les cinq appels : c'est le seul moyen de garantir que le contrat decrit ici est celui qui s'applique, et cela protege d'un changement de version par defaut cote Meta.

##### Parametres communs

**Chemin**

| Nom | Type | Requis | Description |
|---|---|---|---|
| `entity_id` | string | oui | The WhatsApp Business Phone Number ID for the Meta Business Agent. |
| `skill_id` | string | oui (endpoints `/{skill_id}`) | The unique identifier (UUID) of the skill |

ATTENTION sur `skill_id` : la description dit « UUID », mais le schema de reponse type `id` en `string` avec l'exemple `'1234567890'`, qui n'est pas un UUID. Ne pas valider le format cote client, ne pas parser : traiter `id` comme une chaine opaque.

**Requete (query)**

| Nom | Type | Requis | Endpoints | Comportement |
|---|---|---|---|---|
| `agent_id` | string | non | `GET /`, `POST /` uniquement | Optional settings ID. Sur GET : retourne les skills des settings specifies ; absent, retourne les skills des **settings les plus recemment crees pour le canal donne**. Sur POST : cree la skill sous les settings specifies ; absent, utilise les settings les plus recemment crees pour le canal donne. |

ATTENTION, c'est le piege operationnel majeur de cette API. `agent_id` est **absent de GET /{skill_id}, PUT /{skill_id} et DELETE /{skill_id}**. Autrement dit, un skill se lit, se modifie et se supprime par son seul `id`, mais se cree et se liste dans un contexte de « settings » implicite. Si une nouvelle configuration d'agent est creee cote Meta, un `POST` sans `agent_id` ira ecrire sous **ces nouveaux settings**, et le `GET /` sans `agent_id` ne montrera plus les skills des settings precedents. Pour un produit qui vend le controle, il faut **toujours passer `agent_id` explicitement** sur List et Create, et persister cet identifiant en base a cote de chaque skill que l'on gere.

ATTENTION : la spec parle de « the given channel » sans jamais exposer de parametre `channel` en entree. Le canal apparait uniquement en **sortie** (`BizAIOmniChannelSkillsResponse.channel`). La doc ne dit pas comment le canal est determine a la creation : vraisemblablement deduit de l'entite (numero WhatsApp), mais ce n'est pas ecrit. Ne pas supposer qu'on peut creer une skill pour `instagram` ou `email` via cet endpoint numero-WhatsApp.

---

#### Structure d'un skill

##### Corps de requete : `BizAIOmniChannelSkillsRequest`

Utilise a l'identique pour `POST /` et `PUT /{skill_id}`. `Content-Type: application/json`, `required: true`.

| Champ | Type | Requis | Limite | Contraintes et notes |
|---|---|---|---|---|
| `title` | string | **non** | Max 64 caracteres | Nom lisible. « Must contain only lowercase letters, numbers, and hyphens, and must not start or end with a hyphen. » Exemple : `greeting-skill`. Titre descriptif ; eviter les generiques type `skill-1`. |
| `description` | string | **non** | Max 1024 caracteres | Dit a l'IA **quand** appliquer la skill. Etre specifique sur le declencheur ou le contexte, par exemple « Apply when the customer first messages the agent » ou « Apply when the customer asks about returns or refunds. » C'est ce champ que l'agent utilise pour decider quelles skills sont pertinentes dans la conversation en cours. |
| `skill` | string | **non** dans le schema de requete | Max 20000 caracteres | Le corps d'instructions effectif. « Write clear, non-conflicting directives. » Exemple de la spec : `'When a customer sends their first message: 1) Look up their contact info, 2) Check business hours, 3) Greet them by name and ask how you can help.'` |

ATTENTION, incoherence de contrat a gerer cote client : `BizAIOmniChannelSkillsRequest` ne declare **aucun** `required`, donc un `POST` avec un corps `{}` est formellement valide au sens du schema. Mais `BizAIOmniChannelSkillsResponse` declare `skill` comme **requis**. Une skill sans corps n'a aucun sens fonctionnel. La doc ne dit pas si le serveur rejette un corps vide en 400. Imposer `skill` non vide dans la validation de mba avant l'appel, ne pas dependre du 400 serveur.

ATTENTION sur `title` : la contrainte de casse et de caracteres n'est exprimee **qu'en prose**, pas en `pattern` ni `maxLength` dans le schema. Aucune validation automatique n'est donc garantie cote Meta. Implementer la regex cote mba : `^[a-z0-9]+(-[a-z0-9]+)*$` avec longueur <= 64. A noter que l'exemple du champ `title` en **reponse** est `Greeting Skill` (majuscules et espace), ce qui contredit la contrainte de la requete. Signe probable que le serveur ne valide pas. Ne pas se fier a l'API pour la propriete des titres.

ATTENTION sur les limites de longueur : 64 / 1024 / 20000 sont annoncees en prose uniquement, sans `maxLength`. Compter en caracteres cote client et tronquer ou refuser avant l'envoi. La doc **ne dit pas** ce qui se passe en cas de depassement (400, troncature silencieuse, acceptation puis ignorance a l'inference) : a observer.

ATTENTION sur `PUT` : la spec ne dit **jamais** si `PUT /{skill_id}` est un remplacement complet ou une fusion partielle. La semantique HTTP standard de `PUT` est le remplacement, et le corps est le meme schema que la creation. Traiter `PUT` comme un **remplacement integral** : toujours renvoyer les trois champs `title`, `description`, `skill`, y compris ceux qu'on ne modifie pas, sous peine de vider un champ. Il n'existe **pas de PATCH** dans cette API.

##### Corps de reponse : `BizAIOmniChannelSkillsResponse`

| Champ | Type | Requis | Notes |
|---|---|---|---|
| `id` | string | **oui** | Identifiant unique du skill. Exemple : `'1234567890'`. |
| `title` | string | non | Nom lisible, optionnel. Exemple : `Greeting Skill`. |
| `description` | string | non | Description disant a l'IA quand appliquer la skill. Exemple : `How the agent should greet customers`. |
| `skill` | string | **oui** | Le corps d'instructions. « Has no specific restrictions on structure or content. » |
| `channel` | string enum | **oui** | Une valeur parmi : `email`, `instagram`, `line`, `messenger`, `sms`, `tiktok`, `unknown`, `webchat`, `whatsapp`. |
| `created_at` | integer | non | Timestamp de creation. Exemple : `1714500000` (secondes Unix, 10 chiffres). |
| `metadata` | object | non | Map cle/valeur, `additionalProperties: string`. Aucune cle documentee. |

ATTENTION sur `channel` : l'enum est en **minuscules** (`whatsapp`) mais l'`example` du champ est `WHATSAPP` en majuscules. Ne jamais comparer en strict egal : normaliser en minuscules avant comparaison, et prevoir un cas par defaut, la valeur `unknown` faisant partie de l'enum.

ATTENTION sur `created_at` : type `integer`, unite non documentee. L'exemple `1714500000` correspond a des secondes Unix (30 avril 2024). Traiter comme des secondes mais coder defensivement (si la valeur depasse ~1e12, ce sont des millisecondes). Il n'y a **pas de champ `updated_at`** : impossible de savoir via l'API quand une skill a ete modifiee. Si mba doit tracer les modifications, il faut tenir son propre journal.

ATTENTION sur `metadata` : le champ existe en reponse mais **pas dans le schema de requete**. Il n'y a donc aucun moyen documente d'y ecrire via cette API. Ne pas l'utiliser comme espace de stockage pour des metadonnees produit (identifiant de campagne, version, auteur) : stocker cela dans la base de mba, pas chez Meta.

ATTENTION, absence de champ d'etat : il n'y a **ni `enabled`, ni `active`, ni `status`, ni `priority`, ni `order`, ni `version`**. Desactiver temporairement une skill n'est possible qu'en la **supprimant** (DELETE) et en la recreant, ce qui genere un **nouvel `id`** et perd le `created_at`. Pour un produit qui veut offrir un interrupteur « cette skill est active / inactive », il faut conserver le texte de la skill en base cote mba et gerer soi-meme le cycle create/delete, en re-mappant les identifiants a chaque bascule.

---

#### Endpoints

Dans tout ce qui suit, `{entity_id}` est le WhatsApp Business Phone Number ID, et les en-tetes minimaux sont `Authorization: Bearer <token>` et `X-API-Version: 2.0.0`.

##### List skills

`GET https://api.facebook.com/{entity_id}/agent_config/skills/`
`operationId: listSkills`, tags `Agent Config`, `Business AI`.

- Chemin : `entity_id` (requis).
- Requete : `agent_id` (optionnel, voir plus haut).
- En-tete : `X-API-Version` (optionnel, enum `2.0.0`).
- Pas de corps.

**200** : `application/json`, **tableau** de `BizAIOmniChannelSkillsResponse` (le schema racine est `type: array`, pas une enveloppe `{data: [...]}`).

Codes d'erreur documentes : **400** Bad request (`{"title":"Bad Request","detail":"Invalid parameters"}`), **404** Not found (`{"title":"Not Found","detail":"Resource not found"}`), **401** Unauthorized (`{"title":"Unauthorized","detail":"Authentication credentials are missing or invalid"}`), **429** Too many requests (`{"title":"Too Many Requests","detail":"Rate limit exceeded"}`), **500** Server error (`{"title":"Internal Server Error","detail":"An unexpected error occurred"}`), plus une reponse **`default`** « Error response. » au schema `StandardError`. Le `default` signifie que **n'importe quel autre code** peut survenir avec le meme corps : le client doit gerer le cas generique, pas seulement la liste ci-dessus.

ATTENTION : **aucune pagination n'est documentee**. Pas de `limit`, pas de `after`, pas de curseur, pas de champ `paging` dans la reponse. La doc ne dit pas si la liste est tronquee au-dela d'un certain nombre. Ne pas construire de logique de pagination speculative, mais logguer la taille du tableau retourne pour detecter un plafond en conditions reelles.

ATTENTION : un **404 sur une liste** est documente. Cela signifie que l'absence de settings ou d'entite valide se manifeste par 404 et non par un tableau vide. Distinguer les deux dans l'UI de mba : « aucune skill configuree » (200 + tableau vide) et « agent non configure ou `agent_id` inconnu » (404).

##### Get a skill

`GET https://api.facebook.com/{entity_id}/agent_config/skills/{skill_id}`
`operationId: getSkill`.

- Chemin : `entity_id`, `skill_id` (les deux requis).
- **Pas de parametre `agent_id`.**
- En-tete : `X-API-Version` (optionnel, enum `2.0.0`).
- Pas de corps.

**200** : un objet `BizAIOmniChannelSkillsResponse`.

Erreurs documentees : **400**, **404**, **401**, **429**, **500**, plus `default`. Memes corps d'exemple que ci-dessus.

##### Create a skill

`POST https://api.facebook.com/{entity_id}/agent_config/skills/`
`operationId: createSkill`.

- Chemin : `entity_id` (requis).
- Requete : `agent_id` (optionnel, determine sous quels settings la skill est creee).
- En-tete : `X-API-Version` (optionnel, enum `2.0.0`), `Content-Type: application/json`.
- Corps **requis** : `BizAIOmniChannelSkillsRequest`.

**201** : la skill creee, `BizAIOmniChannelSkillsResponse` (recuperer `id` ici, c'est le seul endroit ou il est retourne a la creation).

Erreurs documentees : **400**, **401**, **429**, **500**, plus `default`.

ATTENTION : **pas de 404 documente sur le POST**, alors que le GET de liste en a un. Un `entity_id` ou un `agent_id` invalide remontera donc probablement en 400 (ou via `default`). Ne pas brancher la detection « entite inconnue » sur le seul 404.

ATTENTION : **pas de 409 ni de contrainte d'unicite documentee** sur `title`. Rien n'indique que deux skills ne peuvent pas porter le meme titre. Le client de mba doit garantir l'unicite lui-meme s'il veut adresser les skills par titre ; sinon, adresser exclusivement par `id`.

Exemple de creation, avec le style de corps recommande par la spec (sequence explicite) :

```http
POST /1234567890/agent_config/skills/?agent_id=<AGENT_ID> HTTP/1.1
Host: api.facebook.com
Authorization: Bearer <token>
X-API-Version: 2.0.0
Content-Type: application/json

{
  "title": "greeting-skill",
  "description": "Apply when the customer first messages the agent to set the greeting tone and collect initial context.",
  "skill": "When a customer sends their first message: 1) Look up their contact info, 2) Check business hours, 3) Greet them by name and ask how you can help."
}
```

##### Update a skill

`PUT https://api.facebook.com/{entity_id}/agent_config/skills/{skill_id}`
`operationId: updateSkill`.

- Chemin : `entity_id`, `skill_id` (requis).
- **Pas de parametre `agent_id`.**
- En-tete : `X-API-Version` (optionnel, enum `2.0.0`), `Content-Type: application/json`.
- Corps **requis** : `BizAIOmniChannelSkillsRequest`, meme schema que la creation.

**200** : la skill mise a jour, `BizAIOmniChannelSkillsResponse`.

Erreurs documentees : **400**, **404**, **401**, **429**, **500**, plus `default`.

ATTENTION : envoyer les trois champs a chaque `PUT` (voir plus haut, semantique de remplacement non documentee mais a presumer). ATTENTION egalement : rien n'indique de mecanisme de concurrence optimiste (pas d'`ETag`, pas de `If-Match`, pas de champ de version). Deux operateurs qui editent la meme skill en parallele dans mba ecraseront silencieusement le travail de l'autre. Si le produit est multi-utilisateur, serialiser les ecritures cote mba.

##### Delete a skill

`DELETE https://api.facebook.com/{entity_id}/agent_config/skills/{skill_id}`
`operationId: deleteSkill`.

- Chemin : `entity_id`, `skill_id` (requis).
- **Pas de parametre `agent_id`.**
- En-tete : `Authorization` (requis, securite globale), `X-API-Version` (optionnel, enum `2.0.0`).
- Pas de corps.

**204** : « Skill successfully deleted », **sans corps** (aucun `content` declare). Ne pas tenter de parser la reponse.

Erreurs documentees : **404**, **401**, **429**, **500**, plus `default`. **Pas de 400 documente** sur le DELETE.

ATTENTION : suppression **definitive et immediate**, sans corbeille ni endpoint de restauration. Avant tout DELETE, mba doit snapshotter `title`, `description` et `skill` en base : c'est le seul filet. La recreation produira un `id` different.

---

#### Combinaison et hierarchisation des skills

C'est le point le plus important du chapitre, et aussi celui ou la doc est la plus avare.

**Ce que la doc dit explicitement**

1. Le champ `description` est le mecanisme de selection : « The agent uses this to decide which skills are relevant to the current conversation. » La selection est donc **semantique**, faite par le modele a partir des descriptions, pas par un routeur deterministe.
2. Plusieurs skills peuvent s'appliquer a une meme conversation (« which skills are relevant », au pluriel).
3. Il n'y a **aucun mecanisme de priorite**. La spec le dit frontalement : « the agent cannot resolve conflicting priorities and may produce duplicate or inconsistent responses ». Ecrire « fais ceci en premier » dans deux skills differentes pour le meme declencheur produit des reponses dupliquees ou incoherentes.
4. La resolution recommandee est la **consolidation** : « If multiple actions should happen on the same trigger, consolidate them into a single skill with an explicit sequence of steps. » L'exemple canonique de la spec est une seule skill avec des etapes numerotees 1) 2) 3).

**Regles operationnelles a implementer dans mba**

- **Un declencheur, une skill.** Le modele de donnees de mba doit rendre difficile la creation de deux skills dont les `description` couvrent le meme evenement. A minima : un ecran qui liste les skills existantes et leurs declencheurs au moment de la creation, et un avertissement quand deux descriptions se recouvrent visiblement (premier message, retours et remboursements, horaires, escalade).
- **Ordonner a l'interieur du corps, pas entre les skills.** L'ordre n'existe qu'a l'interieur d'un champ `skill`, sous forme d'etapes numerotees. Il n'y a **aucun ordre garanti** entre skills : ni par `created_at`, ni par position dans le tableau du `GET /`. La doc ne dit rien sur l'ordre de retour de la liste ; ne pas en deduire une precedence.
- **Interdire les meta-instructions de priorite.** Les formulations « toujours en premier », « avant toute autre instruction », « prioritaire sur les autres regles » sont a proscrire dans le corps `skill` des lors qu'elles peuvent entrer en collision. C'est exactement le cas d'echec nomme par la spec.

**Ce qui touche au controle du fil, a l'audience et au handoff**

C'est la valeur centrale de mba, et la doc n'offre **aucun champ structure** pour cela. Tout doit passer par le texte des skills. Consequences a assumer dans le produit :

- **Perimetre de reponse** (a quoi l'agent repond, a quoi il ne repond pas) : exprimable uniquement en prose dans `skill`, sous forme de regles negatives (« Ne reponds pas a X », « Si le client demande Y, dis Z et arrete-toi »). Il n'y a **pas de liste de sujets bloques, pas de deny-list, pas de garde structure** dans cette API. Le respect de la consigne repose sur l'obeissance du modele, pas sur une garantie de plateforme. Ne jamais vendre cela comme un blocage dur.
- **Handoff humain** : la spec des skills **ne documente aucun mecanisme de passage a un humain** : pas de champ, pas d'action, pas d'evenement, pas de webhook mentionne ici. Une skill peut au mieux instruire l'agent d'annoncer qu'un humain va reprendre. Le declenchement effectif de la reprise en main doit etre detecte et execute par mba en dehors de cette API (a partir des webhooks de messages / du canal de conversation), pas configure par une skill. C'est un point a cadrer avant de promettre du handoff pilote.
- **Audience de l'agent** (a qui l'agent parle) : rien dans cette API. Le seul axe de segmentation expose est `entity_id`, c'est-a-dire **le numero**. Segmenter par audience implique donc des numeros distincts, ou un aiguillage cote mba.
- Le champ `channel` etant en lecture seule et fixe par l'entite, un jeu de skills est de facto **lie a un numero WhatsApp**. Pour deployer la meme configuration sur plusieurs numeros, mba doit tenir la source de verite en base et **rejouer les creations** entite par entite. Il n'y a **ni endpoint de copie, ni import/export, ni bulk**.

**Nombre maximum de skills**

ATTENTION, point critique laisse ouvert par la doc : **le nombre maximum de skills par entite ou par agent n'est documente nulle part**. Ni dans la spec OpenAPI, ni dans la page de reference. Les seules limites chiffrees sont les longueurs de champ (64 / 1024 / 20000 caracteres). Il n'y a pas non plus de budget cumule documente pour l'ensemble des corps `skill`. Ne pas supposer « illimite » : construire mba avec un plafond configurable, journaliser le nombre de skills poussees par entite, et remonter proprement tout 400 ou 429 obtenu a la creation, qui sera le premier signal d'un plafond reel.

**Quotas et limites de debit**

Le 429 « Rate limit exceeded » est documente sur les cinq operations, mais **aucun chiffre, aucune fenetre, aucun en-tete de quota** (`Retry-After`, `X-RateLimit-*`) n'est mentionne. Implementer un backoff exponentiel avec jitter sur 429 et sur 500, et lire `Retry-After` s'il est present sans en dependre.

---

#### Gestion des erreurs : `StandardError`

Schema unique pour toutes les erreurs de cette API.

| Champ | Type | Requis |
|---|---|---|
| `title` | string | **oui** |
| `detail` | string | **oui** |
| `type` | string | non |
| `status` | integer | non |

Corps d'exemple fournis par la spec, a utiliser comme reference de mapping :

| Code | `title` | `detail` |
|---|---|---|
| 400 | `Bad Request` | `Invalid parameters` |
| 401 | `Unauthorized` | `Authentication credentials are missing or invalid` |
| 404 | `Not Found` | `Resource not found` |
| 429 | `Too Many Requests` | `Rate limit exceeded` |
| 500 | `Internal Server Error` | `An unexpected error occurred` |

ATTENTION : ce format **n'est pas** le format d'erreur historique de l'API Graph (`{"error": {"message", "type", "code", "fbtrace_id"}}`). Un client mba qui parle deja a Graph pour d'autres besoins doit avoir **deux parseurs d'erreur distincts**, ou un parseur tolerant qui essaie les deux formes. La doc ne dit pas si un rejet en amont (passerelle, token invalide au niveau plateforme) renvoie le format Graph plutot que `StandardError` : coder defensivement.

ATTENTION : `status` etant optionnel dans le corps, **ne jamais s'y fier** pour la logique de branchement. Se baser sur le code HTTP de la reponse.

ATTENTION : chaque operation declare une reponse `default` « Error response. » avec le meme schema. Un client correct traite donc tout code hors 2xx comme un `StandardError` potentiel, y compris des codes non listes (403, 422, 503).

---

#### Recapitulatif pour l'implementation du client

- Base : `https://api.facebook.com/{entity_id}/agent_config/skills`, slash final sur la collection.
- En-tetes systematiques : `Authorization: Bearer <token>`, `X-API-Version: 2.0.0`, et `Content-Type: application/json` sur POST et PUT.
- `agent_id` en query **uniquement** sur `GET /` et `POST /` ; le passer toujours et le persister.
- `PUT` = remplacement : envoyer `title`, `description`, `skill` en entier a chaque fois.
- `DELETE` renvoie 204 sans corps ; snapshotter avant.
- Validation cote client (le serveur ne la garantit pas) : `title` <= 64 et `^[a-z0-9]+(-[a-z0-9]+)*$`, `description` <= 1024, `skill` non vide et <= 20000.
- Traiter `id` comme une chaine opaque, normaliser `channel` en minuscules, lire `created_at` comme des secondes Unix avec garde-fou millisecondes.
- Toute la logique de perimetre, de refus et d'annonce de handoff vit dans le texte de `skill` ; le declenchement reel du handoff et le controle du fil doivent etre implementes hors de cette API.
- Un declencheur, une skill ; ordonner par etapes numerotees a l'interieur du corps ; jamais de revendication de priorite croisee entre skills.

---

<a id="5-connectors"></a>

## 5. Connecteurs et connector tools : brancher les API du client

> Relecture adversariale : chapitre jugé fidèle à la source.

### Connecteurs et connector tools : brancher les API du client

Deux ressources imbriquées, deux specs distinctes, un seul mécanisme : le **connecteur** décrit *où* l'agent tape (base URL, auth, mTLS) et le **connector tool** décrit *quel appel exact* il a le droit de faire (méthode, chemin, paramètres, corps) et *quand* l'agent doit s'en servir (la `description`). Un connecteur sans tool ne fait rien. Un tool ne peut exister que sous un connecteur (il est adressé par un chemin imbriqué, pas par une référence dans le corps).

Pour mba.messagingme.app, c'est le levier de contrôle le plus fin de toute la spec v2.0.0 : le périmètre de ce à quoi l'agent peut répondre en autonomie est très largement défini ici, tool par tool, description par description. Un tool ajouté = une capacité d'action supplémentaire donnée à l'agent, sans autre garde-fou documenté que sa propre `description` et la qualité du schéma de son corps.

#### Cadre commun aux deux ressources

##### Métadonnées de spec

Les deux fichiers sont en **`openapi: 3.1.1`**. Toutes leurs opérations sont taguées `Business AI` + `Connectors`, y compris celles de la spec Connector Tools, qui **n'a pas de tag propre `Tools`**. Une génération de client par tag produira donc un seul groupe mélangeant connecteurs et tools : à renommer nous-mêmes si on veut deux modules distincts.

Le bloc `info` des deux YAML déclare une licence : **« Meta Business AI Terms of Service »**, https://www.facebook.com/legal/3774714022740775. Ce n'est pas décoratif pour mba : l'acceptation de ces conditions conditionne l'accès à l'API, et c'est un point à vérifier côté juridique avant de vendre l'intégration à un client.

L'`info.description` de la spec Connector Tools contient en outre une consigne d'implémentation qu'il ne faut pas rater : « In the `request_definition`, define the body schema with explicit field types, descriptions, and required fields rather than using unstructured objects, the agent uses this schema to extract the correct values from the conversation and build valid API requests. » Autrement dit, le schéma de corps n'est pas un contrat de validation, c'est un **support d'extraction pour l'agent**. Voir la section « Qualité de schéma » plus bas.

##### Base URL et autorisation

| Ressource | Base URL |
|---|---|
| Connecteurs | `https://api.facebook.com/{entity_id}/agent_connectors` |
| Tools | `https://api.facebook.com/{entity_id}/agent_connectors/{connector_id}/tools` |

`entity_id` (string, requis) : le WhatsApp Business Phone Number ID de l'agent MBA. Ce n'est pas le WABA ID.

Autorisation requise par les deux specs, au choix :
- Capability `bizai_wa_enterprise_api_3p_access`
- Permission `whatsapp_business_messaging`

Schéma de sécurité unique, appliqué globalement à tous les endpoints : `OAuthToken__Authorization`, type HTTP bearer, en-tête `Authorization: Bearer <token>`.

##### `operationId` de chaque opération

Utiles pour nommer les méthodes du client généré, et pour parler des endpoints sans ambiguïté dans nos tickets.

| Ressource | `operationId` |
|---|---|
| Connecteurs | `listConnectors`, `createConnector`, `getConnector`, `updateConnector`, `deleteConnector`, `upsertConnectorCertificate`, `upsertConnectorApiKey`, `upsertConnectorOAuth`, `getConnectorLogs` |
| Tools | `listConnectorTools`, `createConnectorTool`, `getConnectorTool`, `updateConnectorTool`, `deleteConnectorTool`, `runConnectorTool` |

##### En-têtes

| En-tête | Valeur | Requis |
|---|---|---|
| `Authorization` | `Bearer <token>` | oui (security global) |
| `X-API-Version` | `2.0.0` (seule valeur de l'enum) | **non**, `required: false` dans les deux YAML |
| `Content-Type` | `application/json` | oui sur tous les POST/PUT (tous les `requestBody` sont `required: true` et `application/json`) |

ATTENTION : `X-API-Version` est optionnel côté spec mais l'enum ne contient que `2.0.0`. Envoyer autre chose n'est pas défini. Recommandation d'implémentation : le poser en dur à `2.0.0` sur chaque appel, pour ne pas dépendre de la version que Meta considère comme défaut côté serveur (la doc ne dit pas quelle version s'applique quand l'en-tête est absent).

##### Schéma d'erreur commun `StandardError`

| Champ | Type | Requis |
|---|---|---|
| `title` | string | oui |
| `detail` | string | oui |
| `type` | string | non |
| `status` | integer | non |

Exemples fournis par la spec, utiles pour le mapping côté client : `{"title":"Bad Request","detail":"Invalid parameters"}`, `{"title":"Not Found","detail":"Resource not found"}`, `{"title":"Unauthorized","detail":"Authentication credentials are missing or invalid"}`, `{"title":"Too Many Requests","detail":"Rate limit exceeded"}`, `{"title":"Internal Server Error","detail":"An unexpected error occurred"}`.

Chaque opération déclare en plus une réponse `default` (« Error response. ») avec le même schéma. ATTENTION : ne pas coder un `switch` fermé sur les codes documentés, il faut un fallback qui parse `StandardError` pour tout code non listé.

ATTENTION, incohérence de la spec sur les 404 : `POST /` (création de connecteur), `POST /` (création de tool), `POST /{connector_id}/upsertCertificate` et `POST /{tool_id}/run` ne documentent **pas** de 404, alors que ces trois derniers portent des IDs de chemin qui peuvent parfaitement ne pas exister. Traiter le 404 comme possible partout, la spec est plus étroite que la réalité HTTP.

---

#### Connecteurs

##### Modèle de données

###### `BizAIOmniChannelConnectorRequest` (corps de POST / et PUT /{connector_id})

| Champ | Type | Requis | Détail |
|---|---|---|---|
| `name` | string | oui | Nom d'affichage. La spec demande un nom identifiant clairement le service externe. Exemple : `Shopify Order Management`, `Salesforce CRM` |
| `description` | string | oui | Description de ce que le connecteur intègre. **L'agent la lit** pour comprendre les capacités du connecteur. Exemple spec : `Connects to the Shopify API for managing customer orders, processing returns, and checking inventory availability.` |
| `base_url` | string | oui | URL de base de l'API externe. Exemple : `https://api.shopify.com/v1` |
| `auth_type` | enum string | oui | `OAUTH2`, `OAUTH2_CLIENT_CREDENTIALS`, `API_KEY`, `BASIC`, `CUSTOM`, `NONE` |
| `auth_config` | objet `BizAIOmniChannelConnectorAuthConfig` (nullable) | non | Voir ci-dessous |
| `user_auth_injection_config` | objet inline | non | Voir ci-dessous |
| `requires_certificate` | boolean | non | `true` si mTLS. Exemple spec : `false`. Pas de défaut déclaré |

###### Authentification supportée, et surtout celle qui ne l'est PAS

L'enum `auth_type` contient six valeurs, mais la description du champ et la description globale de la spec disent la même chose noir sur blanc : **seuls `OAUTH2_CLIENT_CREDENTIALS`, `API_KEY` et `NONE` sont supportés aujourd'hui.**

Donc, non supportés malgré leur présence dans l'enum :
- `OAUTH2` (le flow autorisation utilisateur classique, avec redirection)
- `BASIC` (HTTP Basic)
- `CUSTOM`

ATTENTION, piège majeur pour l'onboarding client : ces trois valeurs seront acceptées par la validation de schéma (elles sont dans l'enum) mais ne sont pas supportées fonctionnellement. La spec ne dit pas si l'API renvoie un 400 ou si elle accepte et échoue plus tard au moment de l'appel du tool. Côté mba, il faut **valider en amont dans notre propre couche** et refuser `OAUTH2` / `BASIC` / `CUSTOM` avec un message explicite, plutôt que de compter sur Meta pour le faire.

Conséquence produit directe : une API cliente en HTTP Basic ne se branche pas telle quelle. Contournement praticable dans le cadre de la spec : `auth_type: API_KEY` avec un header `Authorization` dont `prefix` vaut `"Basic "` et `value` la chaîne base64 (le schéma `ApiKeyParam` autorise n'importe quel `field_name` de header et n'importe quel `prefix`). La spec ne documente pas ce montage, c'est une déduction, à tester.

L'authentification **utilisateur final** (le client WhatsApp qui se connecte à son compte chez le client) n'est pas couverte par `auth_type` : elle passe par le couple `user_auth_injection_config` (côté connecteur) + `user_auth_required` / `user_auth_action_config` (côté tool). Voir plus bas.

###### `BizAIOmniChannelConnectorAuthConfig` (nullable)

| Champ | Type | Requis |
|---|---|---|
| `oauth2_client_credentials` | `BizAIOmniChannelConnectorOAuth2ClientCredentialsAuthConfig` | non |
| `api_key` | `BizAIOmniChannelConnectorApiKeyAuthConfig` | non |

Les deux sous-objets sont optionnels au niveau du schéma : rien n'impose formellement la cohérence avec `auth_type`. Ce sont les descriptions qui la posent (« Provide this only when auth_type is ... »). ATTENTION : envoyer `api_key` avec `auth_type: OAUTH2_CLIENT_CREDENTIALS` n'est pas rejeté par le schéma, le comportement n'est pas documenté. À ne jamais faire.

###### `BizAIOmniChannelConnectorOAuth2ClientCredentialsAuthConfig` (nullable)

| Champ | Type | Requis | Détail |
|---|---|---|---|
| `token_url` | string | oui | Exemple : `https://auth.example.com/token` |
| `scopes_to_request` | array of string | oui | Exemple : `["read","write"]` |
| `token_request_content_type` | string (nullable) | non | Valeurs supportées : `application/x-www-form-urlencoded` et `application/json`. **Défaut : `application/x-www-form-urlencoded`** |
| `client_id` | string | oui | |
| `client_secret` | string | oui | |

ATTENTION : `token_request_content_type` n'est **pas** déclaré comme un `enum` dans le YAML, c'est un `string` libre dont la description énumère les deux valeurs supportées. Une typo ne sera donc probablement pas attrapée à la validation.

ATTENTION : `scopes_to_request` est `required`. La spec ne dit pas si un tableau vide est accepté pour une API qui n'utilise pas de scopes.

###### `BizAIOmniChannelConnectorApiKeyAuthConfig` (nullable)

| Champ | Type | Requis | Détail |
|---|---|---|---|
| `headers` | array de `ApiKeyParam` (nullable) | non | Champs injectés comme en-têtes HTTP |
| `query_params` | array de `ApiKeyParam` (nullable) | non | Champs injectés comme paramètres de requête |
| `body_params` | array de `ApiKeyParam` (nullable) | non | Champs injectés comme **paramètres de corps JSON** |

`BizAIOmniChannelConnectorApiKeyParam` :

| Champ | Type | Requis | Détail |
|---|---|---|---|
| `field_name` | string | oui | Nom du header, du query param ou du champ de corps. Exemple : `X-API-Key` |
| `value` | string | oui | La valeur secrète |
| `prefix` | string (nullable) | non | Préfixe de valeur, exemple `"Bearer "` (espace final inclus dans l'exemple de la spec) |

ATTENTION : le `prefix` est concaténé tel quel, l'espace fait partie de la chaîne. `"Bearer"` sans espace produira `Bearerabc123`.

ATTENTION : `body_params` ne s'applique évidemment qu'aux requêtes qui ont un corps. La spec ne dit pas ce qui se passe quand un tool en `GET` sans corps est rattaché à un connecteur qui a des `body_params`.

###### `user_auth_injection_config` (objet inline, connecteur)

| Champ | Type | Requis | Valeurs |
|---|---|---|---|
| `location` | enum string | **oui** | `body`, `headers`, `path`, `query` |
| `field_name` | string | **oui** | Exemple : `X-User-Token` |
| `prefix` | string | **oui** | Exemple : `"Bearer "` |

ATTENTION, deux pièges ici :
1. Les trois champs sont **tous requis**, y compris `prefix`. Pas de préfixe voulu = envoyer la chaîne vide, pas omettre le champ.
2. La description dit « Where to inject the token (HEADERS, QUERY, or BODY) » **en majuscules et sans `path`**, alors que l'enum réel est en **minuscules** et comporte **quatre** valeurs dont `path`. La valeur à envoyer est la valeur de l'enum : `headers`, pas `HEADERS`. Le statut de `path` est ambigu (présent dans l'enum, absent de la description) : à ne pas utiliser sans test.

Ce bloc définit *comment* le token utilisateur est injecté ; c'est le tool qui décide *si* il l'est, via `user_auth_required`.

###### `BizAIOmniChannelConnectorResponse`

| Champ | Type | Requis | Détail |
|---|---|---|---|
| `id` | string | oui | Exemple : `"1234567890"` (string, même si numérique) |
| `name` | string | oui | |
| `description` | string | oui | |
| `base_url` | string | oui | |
| `auth_type` | enum string (même enum à 6 valeurs) | oui | |
| `auth_config` | `AuthConfig` | non | |
| `mtls_config` | objet inline (nullable) | non | |
| `connection_status` | objet inline | **oui** | |
| `user_auth_injection_config` | objet inline | non | |

`mtls_config` :

| Sous-champ | Type | Requis | Nullable | Détail |
|---|---|---|---|---|
| `has_certificate` | boolean | **oui** | non | Le seul champ garanti présent et non nul |
| `fingerprint` | string | non | **oui** | SHA-256 |
| `expires_at` | integer | non | **oui** | Timestamp Unix |
| `subject` | string | non | **oui** | DN du certificat |
| `client_certificate` | string | non | **oui** | PEM, « public, safe to expose » |
| `ca_certificate` | string | non | **oui** | PEM, chaîne CA, également documentée « public, safe to expose » |

**La clé privée n'est jamais exposée** (elle n'a même pas de champ en réponse).

ATTENTION : hormis `has_certificate`, **tous** les sous-champs de `mtls_config` sont `nullable: true` et optionnels. Un `mtls_config` avec `has_certificate: true` peut donc arriver sans `expires_at` ni `fingerprint`. Une UI qui affiche « expire le ... » doit gérer l'absence, pas seulement la présence.

`connection_status` : `status` (enum requis : `PENDING_OAUTH`, `ACTIVE`, `EXPIRED`, `ERROR`) et `error_message` (string nullable).

ATTENTION : la spec ne documente ni le déclencheur de la transition entre ces statuts, ni le délai après un upsert de credentials, ni s'il existe un endpoint de test de connexion. Ce qui est écrit, c'est que les endpoints d'upsert « re-establish » la connexion. Côté mba, il faut prévoir un `GET /{connector_id}` de re-lecture après un upsert pour afficher le statut réel, et ne pas supposer qu'il est `ACTIVE` immédiatement.

ATTENTION : `PENDING_OAUTH` suggère un flow OAuth interactif, alors que `OAUTH2` (le flow utilisateur) est justement documenté comme non supporté. Zone grise non expliquée par la doc.

ATTENTION sur la réponse : la doc **ne dit pas** si les secrets (`client_secret`, `value` d'une clé API) sont renvoyés en clair, masqués, ou omis dans `auth_config`. Les seuls champs pour lesquels le statut d'exposition est explicite sont ceux de `mtls_config` (`client_certificate` et `ca_certificate` déclarés publics, clé privée jamais renvoyée). Ne pas construire l'UI en supposant qu'on pourra relire un secret.

##### `GET /` : lister les connecteurs (`listConnectors`)

`GET https://api.facebook.com/{entity_id}/agent_connectors`

- Chemin : `entity_id` (string, requis)
- Requête : aucun paramètre. **Pas de pagination documentée**, pas de `limit`, pas de curseur. La spec ne dit pas ce qui se passe au-delà d'un certain nombre de connecteurs.
- 200 : **tableau** de `BizAIOmniChannelConnectorResponse` (tableau nu, pas d'enveloppe `{data: [...]}`)
- Erreurs : 400, 404, 401, 429, 500, `default`

##### `POST /` : créer un connecteur (`createConnector`)

`POST https://api.facebook.com/{entity_id}/agent_connectors`

- Corps requis : `BizAIOmniChannelConnectorRequest`
- **201** : `BizAIOmniChannelConnectorResponse`
- Erreurs : 400, 401, 429, 500, `default` (pas de 404 documenté)

ATTENTION : le code de succès est **201**, pas 200. Un client qui teste `=== 200` cassera à la création.

##### `GET /{connector_id}` : lire un connecteur (`getConnector`)

`GET https://api.facebook.com/{entity_id}/agent_connectors/{connector_id}`

- Chemin : `entity_id`, `connector_id` (strings, requis)
- 200 : `BizAIOmniChannelConnectorResponse`
- Erreurs : 400, 404, 401, 429, 500, `default`

##### `PUT /{connector_id}` : mettre à jour un connecteur (`updateConnector`)

`PUT https://api.facebook.com/{entity_id}/agent_connectors/{connector_id}`

- Corps requis : `BizAIOmniChannelConnectorRequest` (le **même** schéma que la création)
- 200 : `BizAIOmniChannelConnectorResponse`
- Erreurs : 400, 404, 401, 429, 500, `default`

ATTENTION : c'est un `PUT` avec le schéma complet, donc `name`, `description`, `base_url` et `auth_type` sont **requis à chaque mise à jour**. Il n'y a pas de `PATCH`. Pour changer une seule ligne, il faut faire un `GET` puis renvoyer l'objet entier. Le comportement des champs optionnels omis (`auth_config`, `requires_certificate`, `user_auth_injection_config`) n'est pas documenté : effacés ou conservés ? Non spécifié. Prudence : toujours reconstruire le corps complet depuis notre propre état persisté, jamais depuis un objet partiel.

C'est aussi le seul chemin documenté pour **changer d'`auth_type`** (« change its auth type via the update endpoint »), y compris pour retirer une couche d'authentification : les endpoints d'upsert ne suppriment jamais de credentials.

##### `DELETE /{connector_id}` : supprimer un connecteur (`deleteConnector`)

`DELETE https://api.facebook.com/{entity_id}/agent_connectors/{connector_id}`

- **204** sans corps
- Erreurs : 404, 401, 429, 500, `default` (**pas de 400 documenté**)

ATTENTION : la spec ne dit pas ce qu'il advient des tools rattachés (suppression en cascade ou orphelins). Ne pas supposer. Côté mba, supprimer les tools explicitement avant le connecteur, c'est le seul comportement dont on maîtrise le résultat.

##### `POST /{connector_id}/upsertApiKey` (`upsertConnectorApiKey`)

`POST https://api.facebook.com/{entity_id}/agent_connectors/{connector_id}/upsertApiKey`

Corps requis, `BizAIOmniChannelConnectorUpsertApiKeyRequest` :

| Champ | Type | Requis |
|---|---|---|
| `api_key_config` | `BizAIOmniChannelConnectorApiKeyAuthConfig` | oui |

- 200 : `BizAIOmniChannelConnectorResponse` (« The updated connector with API key metadata »)
- Erreurs : 400, 404, 401, 429, 500, `default`

Sémantique explicite : si des credentials existent, ils sont **remplacés** et la connexion est ré-établie. Le payload est obligatoire, **cet endpoint ne supprime jamais de credentials**. Pour retirer la couche API key : supprimer le connecteur, ou changer son `auth_type` via `PUT`.

ATTENTION : c'est un remplacement complet du bloc `api_key_config`, pas une fusion champ à champ. Envoyer seulement `headers` alors qu'il y avait aussi `query_params` remplace vraisemblablement l'ensemble ; la spec ne détaille pas la granularité, donc toujours renvoyer la configuration complète.

##### `POST /{connector_id}/upsertOAuth` (`upsertConnectorOAuth`)

`POST https://api.facebook.com/{entity_id}/agent_connectors/{connector_id}/upsertOAuth`

Corps requis, `BizAIOmniChannelConnectorUpsertOAuthRequest` :

| Champ | Type | Requis |
|---|---|---|
| `oauth_config` | `BizAIOmniChannelConnectorOAuth2ClientCredentialsAuthConfig` | oui |

- 200 : `BizAIOmniChannelConnectorResponse` (« The updated connector with OAuth credential metadata »)
- Erreurs : 400, 404, 401, 429, 500, `default`

Même sémantique que l'upsert API key : remplacement, ré-établissement de la connexion, jamais de suppression. Malgré le nom générique « upsertOAuth », le schéma accepté est **uniquement** le client credentials.

C'est le chemin à privilégier pour la **rotation de secret** : il évite de renvoyer tout l'objet connecteur comme le ferait un `PUT`.

##### `POST /{connector_id}/upsertCertificate` (`upsertConnectorCertificate`)

`POST https://api.facebook.com/{entity_id}/agent_connectors/{connector_id}/upsertCertificate`

Corps requis, `BizAIOmniChannelConnectorCertificateRequest` :

| Champ | Type | Requis | Contrainte de format |
|---|---|---|---|
| `client_certificate` | string | oui | PEM, doit commencer par `-----BEGIN CERTIFICATE-----` |
| `client_key` | string | oui | PEM, doit commencer par `-----BEGIN PRIVATE KEY-----` (PKCS8), `-----BEGIN RSA PRIVATE KEY-----` ou `-----BEGIN EC PRIVATE KEY-----` |
| `ca_certificate` | string | non | PEM, chaîne de confiance CA côté client pour vérifier le certificat serveur. Utile si le certificat serveur n'est pas signé par une CA publique |

- 200 : `BizAIOmniChannelConnectorResponse` (« The updated connector with mTLS certificate metadata »)
- Erreurs : 400, 401, 429, 500, `default` (**pas de 404 documenté**, bien que l'endpoint porte un `connector_id`)

ATTENTION, pièges de format PEM : les en-têtes sont vérifiés au préfixe. Une clé chiffrée (`-----BEGIN ENCRYPTED PRIVATE KEY-----`) n'entre dans aucune des trois formes acceptées. Les sauts de ligne du PEM doivent survivre à l'encodage JSON (`\n` littéraux dans la chaîne JSON) : c'est la source d'erreur classique quand on copie-colle un certificat depuis un formulaire web. La spec ne documente pas de limite de taille.

ATTENTION : le connecteur doit avoir `requires_certificate: true` (posé via `POST /` ou `PUT /{connector_id}`) pour que la couche mTLS s'applique. Ordre pratique : créer le connecteur avec `requires_certificate: true`, puis upserter le certificat.

##### `GET /{connector_id}/logs` : observabilité (`getConnectorLogs`)

`GET https://api.facebook.com/{entity_id}/agent_connectors/{connector_id}/logs`

C'est l'endpoint le plus utile pour le pilotage côté mba : c'est là qu'on voit si un tool échoue en production, et sur quoi.

Paramètres de requête (tous optionnels) :

| Nom | Type | Défaut | Contraintes |
|---|---|---|---|
| `start_time` | integer | il y a 24 heures | Timestamp Unix en **secondes**. Doit être dans les 7 derniers jours |
| `end_time` | integer | maintenant (côté serveur) | Timestamp Unix en secondes |
| `limit` | integer | 100 | 1 à 1000 |
| `tool_id` | string | tous les tools | Filtre sur une opération |
| `include_stats` | boolean | `false` | Ajoute le bloc `stats` |
| `summary_only` | boolean | `false` | Renvoie des motifs d'échec agrégés au lieu d'entrées individuelles |
| `top_n` | integer | 10 | 1 à 50. Ne s'applique **que** si `summary_only=true` |

Contraintes de fenêtre, énoncées trois fois dans la spec : `end_time - start_time` ne doit **pas dépasser 7 jours**, et les logs ne sont **conservés que 7 jours**. Pour une rétention plus longue côté mba, il faut ingérer et stocker nous-mêmes.

ATTENTION, limite fondamentale : « Only errors originating from the third-party system are included ». Ce ne sont pas des logs d'appels complets. Les succès n'apparaissent **pas** dans `data` ; ils ne se voient que via les compteurs de `stats` (`success_count`). Il n'y a donc aucun moyen documenté d'obtenir la trace d'un appel réussi (payload envoyé, réponse reçue).

Réponse 200, `BizAIOmniChannelConnectorLogStatsResponse` :

| Champ | Type | Requis |
|---|---|---|
| `data` | array d'objets | oui |
| `stats` | objet | non, présent seulement si `include_stats=true` |

Objet de `data` (aucun champ n'est requis, le contenu dépend du mode) :

| Champ | Type | Mode |
|---|---|---|
| `event_time` | string | mode entrées individuelles. ISO 8601 UTC à la seconde, ex. `"2026-05-13T21:46:58Z"` |
| `failure_code_name` | string | nom lisible du code d'échec, ex. `TRANSPORT_ERROR` |
| `error_message` | string | message d'erreur de l'opération échouée |
| `tool_name` | string | le tool utilisé au moment de l'erreur |
| `occurrences` | integer | mode `summary_only` : nombre d'occurrences du motif |
| `last_seen` | string | mode `summary_only` : ISO 8601 UTC, dernière occurrence |

ATTENTION : `data` est un tableau **hétérogène selon le mode**, et aucun champ n'est marqué requis. Le client doit se brancher sur le mode demandé (`summary_only`) pour choisir son type de sortie, pas deviner d'après la présence des champs. `tool_name` est un nom, pas un `tool_id`, il ne se rejoint pas directement avec le filtre `tool_id`.

ATTENTION : `failure_code_name` n'est pas un enum dans la spec ; seul l'exemple `TRANSPORT_ERROR` est donné. La liste complète des codes d'échec **n'est pas documentée**. Ne pas coder de logique métier sur des valeurs devinées.

Bloc `stats` (tous champs requis quand présent) : `start_count` (integer, nombre total de démarrages d'exécution), `success_count` (integer), `exception_count` (integer), `success_rate` (number, ratio succès/démarrages), `avg_latency_s` (number, secondes), `p95_latency_s` (number), `p99_latency_s` (number), `time_window_seconds` (integer).

ATTENTION : `time_window_seconds` reflète la fenêtre **réellement couverte**, qui peut être plus courte que la plage demandée si les logs les plus récents ne sont pas encore traités. Il y a donc un délai d'ingestion non chiffré par la doc. Ne jamais calculer un taux « par heure » en divisant par la plage demandée : diviser par `time_window_seconds`.

Erreurs : 400, 404, 401, 429, 500, `default`.

---

#### Connector tools

Un tool = une opération HTTP sur l'API du client, entièrement décrite en JSON, plus une `description` en langage naturel qui pilote la décision de l'agent.

##### La règle produit à ne pas rater

La spec est explicite : « The agent relies on this description to decide when to invoke the tool during a conversation. Vague or missing descriptions cause the agent to invoke tools incorrectly or not at all. »

Autrement dit, **le contrôle de ce que l'agent fait ou ne fait pas passe par du texte, pas par une règle déclarative**. Il n'y a dans cette spec aucun champ de type « condition d'activation », « audience », « désactiver ce tool », « demander confirmation avant d'appeler », ni aucun flag d'activation booléen. Un tool existe ou n'existe pas. Conséquences pour mba :

- Le seul interrupteur documenté pour couper une capacité, c'est `DELETE /{tool_id}`. Il faut donc que notre couche sache **recréer à l'identique** un tool supprimé (persister le `BizAIOmniChannelConnectorToolRequest` complet de notre côté), sinon désactiver est une opération à sens unique.
- Aucun mécanisme documenté de handoff humain ne vit dans les connectors/tools. Le passage de main se joue ailleurs dans l'API (contrôle du fil). Ce qu'on peut faire ici, c'est un tool qui appelle **notre** endpoint pour signaler un besoin d'escalade, mais rien ne garantit que l'agent le déclenche : la décision reste probabiliste, guidée par la `description`.
- Le champ `description` est un artefact de production à versionner comme du code. Une reformulation change le comportement de l'agent sans qu'aucun schéma ne change.

##### Qualité de schéma : la deuxième règle produit

La `description` n'est pas le seul texte qui pilote l'agent. La **structure du corps** en fait autant, et la spec le dit à trois endroits différents, ce qui indique à quel point c'est le mode d'échec attendu.

Description de `BizAIOmniChannelConnectorToolBodyNode.type` : « When defining a field that contains structured data, use `object` with explicit `properties` rather than `string`. Fully defined schemas allow the agent to extract and pass the correct fields automatically. Avoid using `object` without defining its `properties`, as this causes the agent to guess the expected structure. »

Description de `BizAIOmniChannelConnectorToolBodyNode.properties` : « Always define explicit properties with their types and descriptions instead of leaving an object undefined, the agent needs a fully specified schema to correctly populate the request. »

Et l'`info.description` de la spec, déjà citée plus haut, répète la même consigne au niveau du `request_definition` entier.

Trois anti-patterns explicitement condamnés, donc, à interdire dans notre propre couche de validation avant même l'appel Meta :
1. Un champ structuré déclaré `type: "string"` (l'agent devra sérialiser du JSON à la main dans une chaîne, il le fera mal).
2. Un nœud `type: "object"` sans `properties` (l'agent devine la structure).
3. Un nœud sans `description`, à n'importe quel niveau de profondeur.

C'est un critère de recette d'intégration côté mba, pas un détail de style : un schéma flou ne produit pas un 400, il produit des appels sortants silencieusement faux.

##### Modèle de données

###### `BizAIOmniChannelConnectorToolRequest` (corps de POST / et PUT /{tool_id})

| Champ | Type | Requis | Détail |
|---|---|---|---|
| `name` | string | oui | Clé stable de l'action, **visible par l'agent**. Exemple : `check_order_status`, `create_return_request`. La spec proscrit explicitement les noms génériques type `action1` ou `tool` |
| `description` | string | oui | Voir ci-dessus. Exemple complet de la spec : `Use this tool when a customer asks about the status of an existing order. Requires an order ID. Returns the order status, estimated delivery date, and tracking information.` |
| `request_definition` | `BizAIOmniChannelConnectorToolRequestDefinition` | oui | |
| `user_auth_required` | boolean | **oui** | Si `true`, MBA injecte l'auth utilisateur stockée dans la requête sortante, en utilisant le `user_auth_injection_config` **du connecteur** |
| `user_auth_action_config` | `BizAIOmniChannelConnectorToolUserAuthToolConfig` (nullable) | non | |

ATTENTION : `user_auth_required` est **requis** et booléen, il n'a pas de défaut. Il faut l'envoyer explicitement à `false` pour les tools ordinaires.

ATTENTION : la spec ne dit pas si `name` doit être unique au sein d'un connecteur, ni s'il est contraint (regex, longueur, casse). Les exemples sont tous en `snake_case` ASCII minuscule. S'y tenir.

###### `BizAIOmniChannelConnectorToolRequestDefinition`

| Champ | Type | Requis | Détail |
|---|---|---|---|
| `method` | enum string | oui | `GET`, `POST`, `PUT`, `DELETE`, `PATCH` |
| `path` | string | oui | Modèle de chemin sortant, avec des segments `{placeholder}`. Exemple : `/items` |
| `path_parameters` | map string -> `ParameterNode` | non | Les clés **doivent** correspondre aux noms des placeholders de `path` |
| `query_parameters` | map string -> `ParameterNode` | non | Clés = noms canoniques des paramètres de requête sortants |
| `headers` | map string -> `ParameterNode` | non | Clés = noms canoniques des en-têtes sortants |
| `body` | `BizAIOmniChannelConnectorToolRequestBodyDefinition` (nullable) | non | Omettre ou mettre `null` quand la requête n'a pas de corps |

`path` est relatif : il se concatène au `base_url` du connecteur. La spec ne précise pas la règle de jointure exacte (slash dupliqué, slash manquant). Convention sûre déduite des exemples : `base_url` sans slash final, `path` commençant par `/`.

ATTENTION : `path_parameters`, `query_parameters` et `headers` sont des **maps** (`additionalProperties`), pas des tableaux. Le nom du paramètre est la **clé** de l'objet, il n'y a pas de champ `name` dans `ParameterNode`. Exemple : `"query_parameters": {"limit": {"type":"integer","description":"..."}}`.

###### `BizAIOmniChannelConnectorToolParameterNode` (chemin, requête, en-têtes)

| Champ | Type | Requis | Détail |
|---|---|---|---|
| `type` | enum string | oui | `string`, `integer`, `number`, `boolean` |
| `description` | string (nullable) | non | « Always provide a description », l'agent s'en sert pour extraire la valeur de la conversation |
| `required` | boolean (nullable) | non | **Ignoré pour les paramètres de chemin**, qui sont toujours requis |
| `binding` | `ParameterBinding` (nullable) | non | Voir macros ci-dessous |

ATTENTION : l'enum de `ParameterNode` **ne contient ni `object` ni `array`**. Un paramètre de requête multivalué ou structuré n'est pas exprimable ici. Seul `BodyNode` (corps) accepte `object` et `array`.

ATTENTION : `description` est optionnel au schéma mais la spec insiste pour qu'il soit toujours fourni. Un paramètre sans description, c'est un paramètre que l'agent remplira mal.

###### `BizAIOmniChannelConnectorToolBodyNode` (corps uniquement)

| Champ | Type | Requis | Détail |
|---|---|---|---|
| `type` | enum string | oui | `object`, `array`, `string`, `integer`, `number`, `boolean`. **Préférer `object` avec `properties` explicites à `string` pour toute donnée structurée**, et ne jamais laisser un `object` sans `properties` (voir « Qualité de schéma ») |
| `description` | string (nullable) | non | À fournir pour **chaque** nœud |
| `required` | array of string (nullable) | non | Propriétés requises de cet objet. **Uniquement pour les nœuds de type `object`** |
| `properties` | map string -> **string** (nullable) | non | Champs enfants des nœuds `object`. Uniquement si `type: "object"`. « Always define explicit properties with their types and descriptions » |
| `items` | **string** (nullable) | non | Schéma d'élément des nœuds `array`. Uniquement si `type: "array"` |
| `binding` | `ParameterBinding` (nullable) | non | |

ATTENTION : `required` change de type entre `ParameterNode` (**boolean**, « ce paramètre est-il requis ») et `BodyNode` (**array of string**, « quelles propriétés de cet objet sont requises »). Même nom, deux sémantiques et deux types. C'est la source d'erreur la plus probable dans un client qui factorise trop.

###### L'encodage des sous-schémas : le piège central

C'est le point le plus contre-intuitif de toute la spec v2.0.0.

Dans un `BodyNode`, les sous-schémas ne sont **pas** des objets JSON imbriqués. Ce sont des **chaînes de caractères contenant du JSON**.

- `properties` : `additionalProperties: {type: string}`. Chaque valeur est « a string representation of the BodyNode type ».
- `items` : `type: string`. Idem, « a string representation of the BodyNode type ».

Exemple donné par la spec pour `properties` :

```json
"properties": {
  "key":   "{\"type\":\"string\",\"description\":\"Property key.\"}",
  "value": "{\"type\":\"string\",\"description\":\"Property value.\"}"
}
```

Et pour `items` d'un tableau d'objets, l'imbrication devient récursive : un `BodyNode` sérialisé qui contient lui-même des `properties` dont les valeurs sont des `BodyNode` sérialisés. Il faut donc **échapper deux fois** au deuxième niveau. La spec fournit cet exemple textuel :

```
'{"type":"object","description":"Key-value item property.","required":["key","value"],"properties":{"key":"{"type":"string","description":"Property key."}","value":"{"type":"string","description":"Property value."}"}}'
```

ATTENTION : cet exemple, tel qu'il figure dans le YAML officiel, n'est **pas du JSON valide** : les guillemets internes des `properties` ne sont pas échappés. C'est une erreur de la documentation, pas une syntaxe à reproduire. L'intention est claire, la forme correcte à envoyer sur le fil est :

```json
"items": "{\"type\":\"object\",\"description\":\"Key-value item property.\",\"required\":[\"key\",\"value\"],\"properties\":{\"key\":\"{\\\"type\\\":\\\"string\\\",\\\"description\\\":\\\"Property key.\\\"}\",\"value\":\"{\\\"type\\\":\\\"string\\\",\\\"description\\\":\\\"Property value.\\\"}\"}}"
```

Règle d'implémentation côté mba : ne **jamais** construire ces chaînes à la main. Écrire une fonction récursive `serializeBodyNode(node)` qui, pour tout nœud, sérialise `properties[k]` et `items` par `JSON.stringify` de leur forme objet, puis laisse le `JSON.stringify` global du corps de requête faire l'échappement. Et une fonction inverse pour l'affichage. Toute la manipulation en amont se fait sur des objets natifs, ce qui permet au passage d'appliquer les règles de qualité de schéma (pas d'`object` sans `properties`, description partout) sur la forme objet avant sérialisation.

ATTENTION, asymétrie à vérifier en conditions réelles : la spec dit « Roundtripped outbound HTTP request definition ». Elle **ne dit pas** si `GET /{tool_id}` renvoie ces sous-schémas sous la même forme sérialisée qu'à l'écriture. Le mot « roundtripped » le suggère, ce n'est pas garanti. Le désérialiseur doit être tolérant : accepter à la fois une chaîne JSON et un objet natif à cette position.

ATTENTION : le niveau supérieur, lui, n'est PAS sérialisé. `body.params` est une vraie map d'objets `BodyNode` (`additionalProperties: $ref BodyNode`). La sérialisation en chaîne ne commence qu'à partir de `properties` et `items`, donc au deuxième niveau de profondeur. C'est exactement le genre d'incohérence qui produit des 400 opaques.

###### `BizAIOmniChannelConnectorToolRequestBodyDefinition` (nullable)

| Champ | Type | Requis | Détail |
|---|---|---|---|
| `content_type` | enum string | oui | **`application/json` uniquement.** Seule valeur de l'enum |
| `params` | map string -> `BodyNode` | oui | Champs JSON de premier niveau, clés = noms canoniques sortants |
| `required` | array of string (nullable) | non | Champs de premier niveau requis. Les entrées **doivent être des clés présentes dans `params`** |

ATTENTION, conséquence produit de `content_type` : **aucune API cliente en `application/x-www-form-urlencoded` ou en `multipart/form-data` n'est branchable en tant que corps de tool.** Pas d'upload de fichier. Pas de POST de formulaire. C'est une limite dure, à poser dès la qualification commerciale d'une intégration.

(À ne pas confondre avec `token_request_content_type` du bloc OAuth, qui lui accepte `application/x-www-form-urlencoded` : le form-urlencoded est possible pour aller chercher un token, pas pour le corps d'un appel métier.)

###### Macros : `BizAIOmniChannelConnectorToolParameterBinding`

Le `binding` est le mécanisme par lequel **MBA possède la valeur d'un champ**, au lieu de la laisser à l'agent ou au runtime.

| Champ | Type | Requis | Détail |
|---|---|---|---|
| `kind` | enum string | oui | `default` ou `macro` |
| `value` | string (nullable) | conditionnel | Requis quand `kind = "default"`. **Doit être fourni comme une chaîne**, la valeur sous-jacente devant correspondre au type du nœud ; elle est convertie au bon type lors de l'appel |
| `macro` | enum string (nullable) | conditionnel | Requis quand `kind = "macro"` |

Macros disponibles, **liste exhaustive de l'enum** :

| Macro | Ce que la doc en dit |
|---|---|
| `WHATSAPP_PHONE_NUMBER` | (aucune description au-delà du nom) |
| `WHATSAPP_IDENTITY_HASH` | (aucune description au-delà du nom) |
| `WHATSAPP_CURRENT_STATUS_ID` | (aucune description au-delà du nom) |

ATTENTION : ce sont les **trois seules** macros. La spec ne documente **rien** de leur contenu : ni le format du numéro de téléphone (E.164 avec ou sans `+` ? avec ou sans espaces ?), ni ce qu'est exactement l'`IDENTITY_HASH` (algorithme, stabilité dans le temps, portée), ni ce que désigne `CURRENT_STATUS_ID`. Aucun exemple de valeur n'est fourni. Il faut les observer en conditions réelles avant de construire quoi que ce soit dessus.

ATTENTION, règle bloquante : « This cannot be provided for an "object" or "array" type node ». Un `binding` est interdit sur un nœud `object` ou `array`. Pour figer une valeur imbriquée, il faut poser le binding sur le nœud feuille scalaire.

ATTENTION : `kind: "default"` avec `value` en **chaîne**, toujours, même pour un nœud `integer` ou `boolean`. Envoyer `"value": 42` au lieu de `"value": "42"` viole le schéma. Idem `"true"` et non `true`.

Sémantique de l'omission : « omitted means agent/runtime input at the node's canonical path ». Pas de `binding` = c'est l'agent (ou le runtime) qui remplit le champ. C'est donc le levier de contrôle le plus dur disponible sur les paramètres : **tout champ que l'agent ne doit pas pouvoir décider doit porter un `binding`.** Pour mba, c'est la garantie qu'un identifiant de tenant, une clé de compte ou un flag de périmètre ne peut pas être halluciné.

###### `BizAIOmniChannelConnectorToolUserAuthToolConfig`

Extraction de token depuis la réponse d'un tool de login ou de refresh.

| Champ | Type | Requis | Détail |
|---|---|---|---|
| `user_action_tool_type` | enum string | oui | `auth` (autorisation initiale) ou `refresh` (utilise un refresh token existant) |
| `user_auth_token_path` | string | oui | Dot-path d'extraction de l'access token. Exemple : `data.access_token` |
| `refresh_token_path` | string (nullable) | non | Exemple : `data.refresh_token` |
| `expires_at_path` | string (nullable) | non | Exemple : `data.expires_at` |
| `expires_at_type` | enum string (nullable) | non | `absolute` ou `relative_seconds` |

ATTENTION : la spec des tools définit **deux schémas identiques** sous deux noms, `...ToolUserAuthToolConfig` (utilisé dans la **requête**) et `...ToolUserAuthActionConfig` (utilisé dans la **réponse**). Champs, types et contraintes strictement identiques. Un seul type suffit côté client, mais il ne faut pas conclure à une différence de forme en lisant les deux noms.

ATTENTION : `expires_at_type` n'a **pas de défaut documenté**. Si `expires_at_path` est fourni sans `expires_at_type`, l'interprétation est indéfinie. Fournir les deux ou aucun.

ATTENTION : la doc ne dit **rien** sur le stockage du token utilisateur (durée, portée par conversation ou par utilisateur, chiffrement), ni sur le déclenchement automatique du tool `refresh` quand le token expire, ni sur ce qui se passe pour un tool avec `user_auth_required: true` quand aucun token n'est stocké. Zone entièrement à observer.

Mécanique d'ensemble, à retenir : le tool de type `auth` produit le token et dit **où le lire** dans la réponse. Le `user_auth_injection_config` du **connecteur** dit **où le réinjecter**. Les tools métier avec `user_auth_required: true` en bénéficient. Trois objets, trois endroits, un seul flux.

###### `BizAIOmniChannelConnectorToolResponse`

| Champ | Type | Requis | Détail |
|---|---|---|---|
| `id` | string | oui | « Tool ID returned by the Stefi API ». Exemple : `123456789012345` |
| `name` | string | oui | |
| `description` | string | oui | |
| `request_definition` | `ToolRequestDefinition` | oui | |
| `user_auth_required` | boolean | oui | |
| `user_auth_action_config` | `ToolUserAuthActionConfig` | non | |

ATTENTION : `id` est déclaré `type: string` mais l'exemple du YAML est un **entier nu** (`123456789012345`, sans guillemets), à la différence du connecteur dont l'exemple est bien `'1234567890'` entre quotes. Le parseur doit accepter les deux et normaliser en chaîne, sous peine de perte de précision sur un entier 64 bits en JavaScript.

Note : « Stefi API » est une fuite de nommage interne Meta dans la doc publique, sans incidence.

##### `GET /` : lister les tools d'un connecteur (`listConnectorTools`)

`GET https://api.facebook.com/{entity_id}/agent_connectors/{connector_id}/tools`

- Chemin : `entity_id`, `connector_id`
- Aucun paramètre de requête, **aucune pagination documentée**
- 200 : **tableau** de `BizAIOmniChannelConnectorToolResponse`
- Erreurs : 400, 404, 401, 429, 500, `default`

ATTENTION : il n'existe **aucun endpoint listant tous les tools d'une entité**, toutes connexions confondues. Pour un inventaire complet de ce que l'agent sait faire (l'écran le plus important de mba), il faut faire `GET /agent_connectors` puis un `GET .../tools` par connecteur : N+1 appels, à mettre en cache et à gérer contre le 429.

##### `POST /` : créer un tool (`createConnectorTool`)

`POST https://api.facebook.com/{entity_id}/agent_connectors/{connector_id}/tools`

- Corps requis : `BizAIOmniChannelConnectorToolRequest`
- **201** : `BizAIOmniChannelConnectorToolResponse`
- Erreurs : 400, 401, 429, 500, `default` (pas de 404 documenté, alors que `connector_id` peut ne pas exister)

##### `GET /{tool_id}` : lire un tool (`getConnectorTool`)

`GET https://api.facebook.com/{entity_id}/agent_connectors/{connector_id}/tools/{tool_id}`

- Chemin : `entity_id`, `connector_id`, `tool_id`
- 200 : `BizAIOmniChannelConnectorToolResponse`
- Erreurs : 400, 404, 401, 429, 500, `default`

##### `PUT /{tool_id}` : mettre à jour un tool (`updateConnectorTool`)

`PUT https://api.facebook.com/{entity_id}/agent_connectors/{connector_id}/tools/{tool_id}`

- Corps requis : `BizAIOmniChannelConnectorToolRequest` (schéma complet, même que la création)
- 200 : `BizAIOmniChannelConnectorToolResponse`
- Erreurs : 400, 404, 401, 429, 500, `default`

ATTENTION : comme pour les connecteurs, pas de `PATCH`. `name`, `description`, `request_definition` et `user_auth_required` sont requis à chaque mise à jour, y compris pour corriger un simple mot dans la description. Reconstruire le corps complet.

##### `DELETE /{tool_id}` : supprimer un tool (`deleteConnectorTool`)

`DELETE https://api.facebook.com/{entity_id}/agent_connectors/{connector_id}/tools/{tool_id}`

- **204** sans corps
- Erreurs : 404, 401, 429, 500, `default` (pas de 400 documenté)

C'est, encore une fois, le seul mécanisme documenté pour retirer une capacité à l'agent. Voir la règle produit plus haut : persister le payload complet avant de supprimer.

##### `POST /{tool_id}/run` : exécuter un tool à la main (`runConnectorTool`)

`POST https://api.facebook.com/{entity_id}/agent_connectors/{connector_id}/tools/{tool_id}/run`

C'est l'endpoint de test, indispensable pour l'onboarding : il permet de valider une intégration sans passer par une vraie conversation WhatsApp.

Corps requis, `BizAIOmniChannelConnectorToolRunRequest` :

| Champ | Type | Requis | Détail |
|---|---|---|---|
| `input` | string | **non** | Payload d'entrée **JSON-encodé** pour l'action. Défaut : objet vide si non fourni. Exemple spec : `'{"query": "search for product"}'` |

Réponse 200, `BizAIOmniChannelConnectorToolRunResponse` :

| Champ | Type | Requis | Détail |
|---|---|---|---|
| `output` | string | oui | Réponse **JSON-encodée** de l'exécution. Exemple : `'{"results": []}'` |
| `status` | string | oui | « Execution status: success or error » |

Erreurs : 400, 401, 429, 500, `default` (pas de 404 documenté).

ATTENTION, double encodage encore : `input` et `output` sont des **chaînes** contenant du JSON, pas des objets. Il faut `JSON.stringify` en entrée et `JSON.parse` en sortie. Le corps HTTP est donc du JSON contenant du JSON échappé.

ATTENTION, sur `status` : la description dit « success or error » (minuscules) mais l'exemple du YAML vaut `SUCCESS` (majuscules). Ce n'est **pas** un enum dans le schéma, c'est un `string` libre. Comparer en insensible à la casse, ou mieux : ne pas se fier à `status` seul et vérifier aussi le contenu de `output`.

ATTENTION : « Returns the raw response from the upstream API endpoint ». Un échec applicatif de l'API du client peut donc remonter en **HTTP 200** avec un `status` d'erreur et un `output` contenant l'erreur amont. Le code HTTP de cette API ne reflète pas la santé de l'appel sortant.

ATTENTION : la doc ne dit **pas** quelle est la structure attendue de `input` par rapport au `request_definition` (est-ce une map plate nom -> valeur tous emplacements confondus ? un objet segmenté par `path_parameters` / `query_parameters` / `headers` / `body` ?). L'exemple `{"query": "search for product"}` suggère une map plate au niveau des noms canoniques, mais ce n'est pas énoncé. À déterminer empiriquement, c'est le premier test à faire.

ATTENTION : la doc ne dit pas si les champs portant un `binding` de type `macro` sont résolus lors d'un `run` manuel. Hors conversation WhatsApp, `WHATSAPP_PHONE_NUMBER` n'a pas de valeur naturelle. Un tool qui dépend d'une macro peut donc se comporter différemment en test et en production.

---

#### Ce que la spec ne borne pas, et qu'il faut border côté mba

- **Aucun quota chiffré** : pas de nombre maximal de connecteurs par entité, de tools par connecteur, de taille de payload, de longueur de `description`, de profondeur d'imbrication des `BodyNode`. Le 429 existe mais aucun budget d'appels n'est publié, ni en-tête de rate limit documenté.
- **Aucun timeout documenté** sur l'appel sortant vers l'API du client, ni politique de retry, ni comportement du circuit breaker. Un `TRANSPORT_ERROR` apparaît dans les logs, sa définition non.
- **Aucune atomicité** entre un connecteur et ses tools. Créer un connecteur puis N tools, c'est N+1 appels sans transaction. Prévoir la réconciliation.
- **Aucun contrôle d'audience ni de handoff** dans ces deux specs. Le contrôle du fil se joue ailleurs ; ici, le seul contrôle réel est le quatuor (existence du tool, qualité de sa `description`, qualité du schéma de corps, `binding` sur les champs sensibles).
- **Aucune validation automatique de la qualité de schéma.** Les trois consignes de la spec sur les `object` sans `properties`, les données structurées en `string` et les descriptions manquantes sont des recommandations en prose, pas des contraintes JSON Schema. Personne ne les fera respecter à notre place : c'est à notre couche de les refuser à l'entrée.
- **Conditions d'utilisation à accepter** : l'accès est régi par les Meta Business AI Terms of Service (https://www.facebook.com/legal/3774714022740775), déclarées dans le bloc `info` des deux specs. À valider avant tout engagement client sur une intégration.

---

<a id="6-operate-event-test"></a>

## 6. Agent event et agent test

> Relecture adversariale : 3 erreur(s) et 9 omission(s) corrigées.

### Où ces deux endpoints se placent

`agent_event` et `agent_test` sont les deux endpoints du groupe « Operate » qui ne touchent pas au fil de conversation en cours :

- **`agent_event`** : un back-office externe (CRM, ERP, outil de paiement, back-office KYC) notifie l'agent qu'un fait métier vient de se produire pour un consommateur donné, et l'agent décide d'agir dans la conversation. C'est la porte d'entrée « inbound système » de MBA, par opposition à `thread_control` qui est la porte d'entrée « qui parle maintenant ». Le `info.summary` de la spec le formule ainsi : « Trigger an agent action asynchronously for a specific phone number conversation. »
- **`agent_test`** : on parle à l'agent sans passer par WhatsApp, en synchrone, pour valider son comportement. `info.summary` : « Send test messages to the AI agent for automated testing. »

Les deux partagent le même modèle d'authentification et la même racine d'URL que le reste de l'API v2.0.0.

#### Socle commun aux deux endpoints

##### Métadonnées des fichiers de spec

| Élément | `agent_event` | `agent_test` |
|---|---|---|
| Version OpenAPI du fichier | `3.1.1` | `3.1.1` |
| Version d'API déclarée | `2.0.0` | `2.0.0` |
| Licence | « Meta Business AI Terms of Service », `https://www.facebook.com/legal/3774714022740775` | identique |
| Tags racine déclarés | `Business AI` (« Business AI API operations ») | `Agent Config` (« Agent configuration and settings ») et `Business AI` |
| Tags des opérations | `sendAgentEvent`, `getAgentEvent` : `Business AI` | `runAgentTest` : `Agent Config` **et** `Business AI` |

> ATTENTION : les deux fichiers sont en **OpenAPI 3.1.1**, alors qu'ils utilisent encore le mot-clé propre à 3.0 `nullable: true` (sur `handoff_reason` et `no_response_reason` de `agent_test`). En 3.1, `nullable` n'existe plus : la forme canonique est `type: [string, 'null']`. Les fichiers sont donc formellement incohérents avec la version qu'ils déclarent. Conséquence pratique : un générateur de client strictement 3.1 **ignorera** `nullable` et produira des types non nullables, alors que ces champs peuvent bel et bien arriver à `null`. Si on génère notre client depuis le YAML, il faut patcher ces deux champs à la main.

> Le bloc `license` est le seul rattachement contractuel documenté dans ces specs : les « Meta Business AI Terms of Service ». C'est le document à lire avant toute mise en service client, aucun autre engagement (SLA, quota, facturation) n'apparaît dans les fichiers.

##### Authentification

| Élément | Valeur |
|---|---|
| Schéma | `OAuthToken__Authorization`, HTTP Bearer |
| En-tête | `Authorization: Bearer <token>` |
| Portée | `security` global dans les deux specs : **tous** les endpoints l'exigent |

Autorisation requise, identique pour `agent_event` et `agent_test`, en **any of** (l'un OU l'autre suffit) :

- Capability `bizai_wa_enterprise_api_3p_access`
- Permission `whatsapp_business_messaging`

> ATTENTION : c'est le jeu d'autorisations **standard** de l'API MBA v2.0.0, pas un jeu particulier à ces deux endpoints. Il est identique à celui des endpoints `agent_config/*`, `agent_allowlist`, `agent_eligibility`, `agent_onboarding`, `agent_knowledge/*` et `agent_eval`. Les seuls endpoints du corpus à s'en écarter sont `thread_control` et `delete_agent`, qui exigent la permission `whatsapp_business_messaging` **sans alternative par capability**.

> ATTENTION, conséquence directe sur le handoff : `thread_control` (spec v1.0.0, base URL `https://api.facebook.com/business/whatsapp/phone_numbers/{phone_number_id}/thread_control`) n'accepte que `whatsapp_business_messaging`. L'inclusion va donc dans un seul sens : un token qui passe sur `thread_control` passe forcément sur `agent_event` et `agent_test`, mais l'inverse est faux. Un token qui ne dispose que de la capability `bizai_wa_enterprise_api_3p_access` fonctionnera sur `agent_event` et `agent_test`, et **échouera sur `thread_control`**. Si notre console pilote le handoff, exiger `whatsapp_business_messaging` à l'onboarding est la seule position sûre : c'est le sur-ensemble qui couvre tout le corpus, capability comprise.

##### En-tête de version

| Nom | Emplacement | Type | Requis | Valeurs autorisées |
|---|---|---|---|---|
| `X-API-Version` | header | string | non (`required: false`) | enum à une seule valeur : `2.0.0` |

> ATTENTION : l'en-tête est **optionnel** dans la spec, mais son enum ne contient qu'une valeur. La spec ne dit **pas** quelle version est servie si on omet l'en-tête. Envoyer `X-API-Version: 2.0.0` systématiquement, sur toutes les requêtes, est la seule position défendable : sinon un basculement de version par défaut côté Meta change silencieusement le contrat de notre client HTTP. C'est gratuit à faire et cela supprime une classe entière de panne future.

##### `entity_id`

Paramètre de chemin, `string`, **requis** sur les trois opérations décrites dans ce chapitre.

Description exacte de la spec :
- `agent_event` (POST et GET) : « The WhatsApp Business Phone Number ID for the Meta Business Agent. »
- `agent_test` (POST) : « The WhatsApp Business Phone Number ID for the AI agent to test. »

> ATTENTION : c'est le **Phone Number ID** WhatsApp, pas le WABA ID, et pas le numéro E.164. Une confusion WABA/Phone Number ID est l'erreur la plus fréquente sur cette API, et elle ne se manifeste pas par un message clair : on récolte un 400 ou un 404 générique. Dans notre modèle de données, stocker le Phone Number ID comme clé de rattachement de l'agent, jamais le WABA seul.

> Les deux specs de ce chapitre ne mentionnent **que** WhatsApp pour `entity_id`. Contrairement à d'autres endpoints MBA où un Page ID Facebook/Instagram est évoqué, ici la doc ne dit rien d'un usage Messenger ou Instagram. **La doc ne précise pas** si `agent_event` ou `agent_test` fonctionnent sur un canal autre que WhatsApp. À traiter comme WhatsApp-only tant que ce n'est pas observé.

##### Schéma d'erreur commun : `StandardError`

Corps de réponse de **toutes** les erreurs des deux endpoints, y compris la réponse `default`.

| Champ | Type | Requis |
|---|---|---|
| `title` | string | oui |
| `detail` | string | oui |
| `type` | string | non |
| `status` | integer | non |

Exemples fournis par les specs, réutilisables en tests :

| Code | `title` | `detail` |
|---|---|---|
| 400 | `Bad Request` | `Invalid parameters` |
| 401 | `Unauthorized` | `Authentication credentials are missing or invalid` |
| 403 | `Forbidden` | `This endpoint is not enabled for the requested entity` |
| 404 | `Not Found` | `The agent event could not be found` |
| 429 | `Too Many Requests` | `Rate limit exceeded` |
| 500 | `Internal Server Error` | `An unexpected error occurred` |

Les exemples 400, 401, 429 et 500 sont fournis par les deux specs. Les exemples 403 (« This endpoint is not enabled for the requested entity ») et 404 (« The agent event could not be found ») ne figurent que dans la spec `agent_event`, sur la seule opération GET `/{agent_event_id}`. La spec `agent_test`, elle, ne documente ni 403 ni 404.

> ATTENTION : `status` (le code HTTP répété dans le corps) est **optionnel**. Ne jamais router la gestion d'erreur sur `body.status` : lire le code HTTP de la réponse. De même, `type` est optionnel et la spec n'énumère aucune valeur : il n'existe **aucun code d'erreur machine stable** dans ce contrat. Toute la discrimination d'erreur au-delà du code HTTP repose sur du texte libre (`title`, `detail`), donc non parsable de façon fiable. Conséquence pratique : notre couche doit logger `title` et `detail` bruts pour diagnostic humain, et ne prendre de décision automatique que sur le code HTTP.

Les deux specs déclarent une réponse `default` (« Error response. ») avec le même `StandardError`. Le client doit donc traiter tout code non listé comme une erreur au format `StandardError`, sans supposer que la liste des codes est close.

---

### `agent_event` : déclencher l'agent depuis un back-office

#### Ce que fait l'endpoint

Résumé de la spec (`info.description`) : notifier le Meta Business Agent d'un événement survenant dans nos systèmes (achat terminé, vérification d'identité, mise à jour d'expédition) afin que l'agent **prenne l'action appropriée dans la conversation client**. Le `info.summary` précise le cadre : « Trigger an agent action asynchronously **for a specific phone number conversation**. »

> Ce membre de phrase, « for a specific phone number conversation », est le **seul** indice de la source sur la question ouverte que l'on posera plus bas (un `agent_event` peut-il ouvrir une conversation à froid ?). Il suggère que l'événement se rattache à une conversation existante plutôt qu'il n'en crée une, mais ce n'est qu'un résumé de haut niveau, pas une règle normative : il ne suffit pas à trancher.

Mécanique en deux temps :

1. `POST` : soumet l'événement. **Retourne immédiatement**, l'événement est mis en file. Statut `accepted`. Description de la réponse 200 dans la spec : « Acknowledgment that the event was accepted for processing. »
2. `GET /{agent_event_id}` : interroge l'état de traitement d'un événement déjà soumis. Description de la réponse 200 : « The current status of the agent event. »

> ATTENTION : c'est **asynchrone de bout en bout**. Le 200 sur le POST ne signifie **rien** sur le fait que l'agent ait parlé au client. Il signifie uniquement « l'événement est entré dans la file », et la spec l'écrit noir sur blanc avec le mot `Acknowledgment`. Un événement peut parfaitement être accepté puis finir en `skipped` ou `failed` sans que personne ne reçoive de message. Toute UI qui affiche « événement envoyé au client » sur la base du 200 ment à l'utilisateur. Dans notre console, l'état affiché doit venir du `GET`, pas du `POST`.

#### POST : soumettre un événement

##### Requête

```
POST https://api.facebook.com/{entity_id}/agent_event
```

`operationId` : `sendAgentEvent` · tag : `Business AI`

En-têtes :

| Nom | Requis | Valeur |
|---|---|---|
| `Authorization` | oui | `Bearer <token>` |
| `Content-Type` | oui | `application/json` |
| `X-API-Version` | non (mais à envoyer) | `2.0.0` |

Paramètres de chemin :

| Nom | Type | Requis | Description |
|---|---|---|---|
| `entity_id` | string | oui | WhatsApp Business Phone Number ID de l'agent |

Aucun paramètre de requête (query string) n'est défini.

Corps requis (`required: true`), schéma `BizAIOmniChannelAgentEventRequest` :

| Champ | Type | Requis | Contrainte | Exemple spec |
|---|---|---|---|---|
| `to` | string | **oui** | Numéro de téléphone du consommateur au format E.164 | `+15551234567` |
| `event` | object | **oui** | « Event-specific fields. » Voir ci-dessous | |

Objet `event` (les trois champs sont **requis**) :

| Champ | Type | Requis | Contrainte documentée |
|---|---|---|---|
| `event.type` | string | **oui** | Identifiant d'événement défini par le partenaire, ex. `document_verified`, `payment_received`. **Max 256 caractères** |
| `event.description` | string | **oui** | Description lisible par un humain, ex. `User's identity document has been verified`. **Max 1024 caractères** |
| `event.payload` | string | **oui** | Chaîne JSON opaque transmise à l'agent **telle quelle**. **Max 4096 caractères** |

Exemple de corps conforme :

```json
{
  "to": "+33612345678",
  "event": {
    "type": "payment_received",
    "description": "Le client a réglé sa facture de 249 EUR",
    "payload": "{\"invoice_id\":\"INV-2026-8891\",\"amount\":249,\"currency\":\"EUR\"}"
  }
}
```

##### Les pièges du corps, un par un

> ATTENTION, le plus mordant : **`payload` est de type `string`, pas `object`**. C'est une chaîne JSON, donc il faut sérialiser puis échapper. Envoyer `"payload": {"invoice_id": "INV-1"}` est une violation de schéma. La spec dit « Opaque JSON string passed through to the agent as-is ». Le mot `as-is` est important : Meta ne parse pas, ne valide pas, ne normalise pas. Corollaire : rien n'empêche d'y mettre une chaîne qui n'est pas du JSON valide, et **la doc ne dit pas** ce que fait l'agent dans ce cas. À traiter comme une erreur de notre côté, avec validation JSON avant envoi.

> ATTENTION : la limite de **4096 caractères** porte sur la chaîne sérialisée et échappée. Un payload qui semble petit en objet peut dépasser une fois échappé (les guillemets doublent). Mesurer la longueur **après** `JSON.stringify`, pas avant. Prévoir une troncature ou un rejet explicite côté console, sinon on prend un 400 opaque.

> ATTENTION : les trois limites (256, 1024, 4096) sont énoncées en **prose de description**, pas en `maxLength` dans le schéma. Elles ne seront donc **pas** attrapées par une validation OpenAPI automatique côté client. Si on génère notre client depuis le YAML, ces contraintes disparaissent silencieusement. Il faut les coder à la main.

> ATTENTION : `event.type` est **défini par le partenaire**, pas par Meta. Il n'existe **aucune liste d'événements officiels**. `document_verified` et `payment_received` sont des exemples, pas un vocabulaire imposé. Conséquence produit : c'est nous qui devons figer un vocabulaire d'événements et le tenir stable, parce que l'agent, lui, s'appuie sur `type` et `description` en langage naturel pour décider quoi faire. Un renommage de `type` en cours de route change le comportement de l'agent sans aucun signal d'erreur. Ce vocabulaire doit vivre dans notre configuration, versionné, pas être construit à la volée par chaque intégration client.

> ATTENTION : `description` n'est pas décorative. C'est du langage naturel destiné au modèle. La qualité de la réaction de l'agent dépend directement de sa formulation. C'est le seul champ à travers lequel on explique **le sens** de l'événement. Le traiter comme un champ de prompt, pas comme un commentaire.

> `to` est le numéro du **consommateur**, pas le nôtre. La spec ne dit **pas** ce qui se passe si `to` ne correspond à aucune conversation existante avec ce Phone Number ID, ni si un événement peut initier une conversation à froid. Le `info.summary` (« for a specific phone number conversation ») penche pour un rattachement à une conversation existante, sans le poser en règle. À vérifier en conditions réelles : c'est déterminant, car un événement capable d'ouvrir une conversation tomberait sous les règles de fenêtre de 24 h et de templates WhatsApp, que cette spec n'évoque nulle part.

##### Réponse 200

Description de la spec : « Acknowledgment that the event was accepted for processing. » Schéma `BizAIOmniChannelAgentEventResponse` :

| Champ | Type | Requis | Description | Exemple |
|---|---|---|---|---|
| `status` | string | **oui** | `"accepted"` quand l'événement est correctement mis en file | `accepted` |
| `agent_event_id` | string | non | ID de l'événement enregistré, **quand un événement a été créé** | `1234567890123456` |

> ATTENTION, double piège ici. Premièrement, `status` en réponse de POST **n'a pas d'enum** : seule la valeur `accepted` est décrite. La spec ne dit pas s'il existe d'autres valeurs possibles en 200. Ne pas coder `if (status === "accepted")` comme unique branche de succès sans branche `else` qui logge la valeur inattendue. Deuxièmement, et c'est plus grave : **`agent_event_id` est optionnel**. La formulation « when one was created » implique qu'un 200 peut revenir **sans** ID. Dans ce cas, il est **impossible de suivre l'événement** : plus de `GET` possible, aucune trace, aucune façon de savoir s'il a abouti. La doc ne dit **pas** dans quelles conditions l'ID est omis. Notre code doit traiter « 200 sans `agent_event_id` » comme un cas nommé, logué et remonté, pas comme un succès silencieux, sinon on perdra des événements sans jamais savoir lesquels.

##### Codes d'erreur du POST

| Code | Signification |
|---|---|
| 400 | Bad request |
| 401 | Unauthorized |
| 429 | Too many requests |
| 500 | Server error |
| `default` | Error response (format `StandardError`) |

> ATTENTION : **le POST ne documente pas de 403**, alors que le GET le documente. On ne peut donc pas se reposer sur un 403 au POST pour détecter qu'un entity_id n'a pas l'agent activé. La détection d'un entity_id non habilité doit passer par les endpoints d'onboarding/eligibility, en amont, pas par la réponse du POST.

#### GET : suivre le statut d'un événement

##### Requête

```
GET https://api.facebook.com/{entity_id}/agent_event/{agent_event_id}
```

`operationId` : `getAgentEvent` · tag : `Business AI`

En-têtes : `Authorization: Bearer <token>`, `X-API-Version: 2.0.0` (optionnel dans la spec).

Paramètres de chemin :

| Nom | Type | Requis | Description |
|---|---|---|---|
| `entity_id` | string | oui | WhatsApp Business Phone Number ID de l'agent |
| `agent_event_id` | string | oui | ID de l'événement, tel que retourné par `POST /{entity_id}/agent_event` |

Aucun paramètre de requête. Aucun corps.

##### Réponse 200

Description de la spec : « The current status of the agent event. » Schéma `BizAIOmniChannelAgentEventStatusResponse` :

| Champ | Type | Requis | Description | Exemple |
|---|---|---|---|---|
| `status` | string, enum | **oui** | Statut de traitement courant | `request_received` |
| `event_type` | string | **oui** | L'identifiant partenaire fourni à la soumission | `document_verified` |
| `error_message` | string | non | Résumé de l'échec, si l'état est FAILED | `internal_server_error` |
| `skipped_reason` | string | non | Résumé de la raison du saut, si l'état est SKIPPED | `no_phone_settings` |
| `created_at` | string | **oui** | Horodatage ISO 8601 de réception de l'événement | `2024-01-15T10:30:00+0000` |
| `updated_at` | string | **oui** | Horodatage ISO 8601 de dernière mise à jour du statut | `2024-01-15T10:31:00+0000` |

Enum **exacte** de `status`, dans l'ordre de l'`enum` machine de la spec :

```
request_received
processing
sent
failed
skipped
success
```

> ATTENTION : la spec se contredit avec elle-même sur cette liste. La `description` en prose du champ `status` énonce « request_received, processing, skipped, sent, success, failed », tandis que l'`enum` machine liste « request_received, processing, sent, failed, skipped, success ». Les six valeurs sont les mêmes, seul l'ordre diffère, donc l'incohérence est bénigne sur le fond, mais elle signale que la prose de cette spec n'est pas tenue à jour avec son schéma. C'est **l'enum machine** qui fait foi, et c'est elle qui est reprise ci-dessus. Ne jamais déduire un ordre de progression du cycle de vie à partir de l'ordre de la liste : ni l'un ni l'autre ne décrit une séquence.

Lecture pratique de ces six valeurs :

- `request_received`, `processing` : en vol, il faut repoller.
- `sent` : envoyé. La spec ne dit pas ce qui distingue `sent` de `success`.
- `success` : terminal, positif.
- `failed` : terminal, négatif, `error_message` renseigné.
- `skipped` : terminal, l'agent n'a rien fait, `skipped_reason` renseigné.

> ATTENTION : **`sent` et `success` coexistent sans que la doc explique la différence**, ni lequel est terminal. C'est un vrai trou. Deux hypothèses également plausibles : soit `sent` est un état intermédiaire (message parti, accusé non encore reçu) qui transite ensuite vers `success`, soit ce sont deux issues terminales de natures différentes. Coder les deux comme terminales positives, mais **continuer à afficher les deux distinctement** dans notre UI plutôt que de les fusionner, pour pouvoir trancher par observation une fois en production.

> ATTENTION : `skipped` est l'état le plus important pour notre produit, et le plus mal documenté. `skipped` signifie que l'événement a été accepté, traité, et que **l'agent a délibérément choisi de ne rien faire**. C'est exactement le point de contrôle que notre console vend. Or la spec ne fournit **aucune énumération** de `skipped_reason` : un seul exemple, `no_phone_settings`. Il faut donc **collecter les valeurs observées en production** et construire notre propre table de traduction au fil de l'eau. Prévoir dès maintenant un stockage de la valeur brute et un affichage de repli pour les raisons inconnues. Ne pas mapper vers un enum fermé côté notre base, ce serait perdre l'information au moment précis où elle est le plus utile.

> ATTENTION : `error_message` n'est pas énuméré non plus (exemple unique : `internal_server_error`). Même traitement : stocker brut.

> Les horodatages sont au format `2024-01-15T10:30:00+0000`, offset **sans deux-points**. Ce n'est pas le format ISO 8601 le plus courant (`+00:00`). Certains parseurs stricts le refusent. Vérifier le parseur avant de s'appuyer dessus, ou parser en tolérant les deux formes.

##### Codes d'erreur du GET

| Code | Signification | Note |
|---|---|---|
| 400 | Bad request | |
| 401 | Unauthorized | |
| 403 | Forbidden | `detail` d'exemple : « This endpoint is not enabled for the requested entity » |
| 404 | Not found | `detail` d'exemple : « The agent event could not be found » |
| 429 | Too many requests | |
| 500 | Server error | |
| `default` | Error response | Format `StandardError` |

> ATTENTION : un 404 sur le GET ne veut pas nécessairement dire « l'événement n'existe pas ». Il peut aussi refléter une latence de propagation entre la mise en file par le POST et la disponibilité de l'événement en lecture. **La doc ne dit rien** de ce délai. Ne pas conclure à un échec au premier 404 : prévoir une politique de re-tentative avec un délai de grâce avant de déclarer l'événement perdu.

#### Absence de webhook, conséquence sur l'architecture

Les deux specs de ce chapitre ne mentionnent **aucun webhook** de notification de fin de traitement d'un `agent_event`. La seule façon documentée de connaître l'issue est de **poller** le GET.

Conséquences concrètes pour notre implémentation :

- Il faut une file de suivi persistante : chaque `agent_event_id` retourné doit être stocké avec son état, et repollé jusqu'à un état terminal.
- Il faut une politique de backoff, parce que le 429 est documenté sur le GET comme sur le POST.
- Il faut une durée de vie maximale de suivi (au-delà de N tentatives, marquer `unknown`), parce que rien ne garantit qu'un événement atteigne un état terminal.

> ATTENTION : **aucun quota, aucun seuil, aucune fenêtre de rate limit ne sont chiffrés** dans ces specs. Le 429 est documenté, sa limite ne l'est pas. Cela vaut pour les deux endpoints, POST comme GET. Un polling naïf et serré nous fera découvrir la limite par l'échec, en production, et le 429 frappera aussi bien nos GET de polling que nos POST d'événements métier, c'est-à-dire que le polling peut affamer l'envoi. Dimensionner défensivement dès le départ (intervalle initial de l'ordre de plusieurs secondes, backoff exponentiel, plafond global de requêtes par entity_id), et instrumenter le taux de 429 pour caler ensuite sur du mesuré.

#### Ce que `agent_event` signifie pour le contrôle du fil

C'est le point à retenir pour notre positionnement produit, et c'est aussi celui où la doc est la plus avare.

Ce qui est certain :
- `agent_event` est le **seul** mécanisme documenté permettant à un système tiers de provoquer une prise de parole de l'agent sans message entrant du consommateur.
- L'agent conserve son pouvoir de décision : il peut traiter (`success`/`sent`) ou refuser (`skipped`). Nous **déclenchons**, nous ne **commandons** pas.
- Le déclenchement vise « a specific phone number conversation » : la spec se place explicitement à l'échelle d'une conversation rattachée à un Phone Number ID, pas à l'échelle de l'agent en général.

Ce que la doc ne dit pas, et qu'il faut lever en priorité :
- **Interaction avec `ai_audience`** : si l'agent est en `ALLOWLISTED_ONLY` et que `to` n'est pas dans l'allowlist, l'événement finit-il en `skipped` ? C'est probable, mais non documenté. C'est structurant, parce que notre pattern de contrôle repose sur une allowlist vide par défaut.
- **Interaction avec `thread_control`** : si notre application détient le contrôle du fil, un `agent_event` fait-il parler l'agent quand même, court-circuitant notre contrôle ? Ou est-il mis en attente, ou `skipped` ? La doc ne tranche pas. C'est **la** question critique : si l'événement passe outre le contrôle du fil, alors `agent_event` est un canal par lequel un back-office client peut faire parler l'agent au milieu d'un échange humain, ce qui casse la promesse de handoff maîtrisé. À noter que les deux endpoints n'ont même pas les mêmes prérequis d'autorisation (voir plus haut) : rien ne garantit qu'ils partagent une logique d'exécution commune.
- **Interaction avec `rollout.enabled: false`** : un agent désactivé traite-t-il ses événements ? Non documenté.

> ATTENTION : tant que ces trois points ne sont pas vérifiés en conditions réelles, ne pas exposer `agent_event` en libre-service aux clients dans notre console. Le protocole de vérification est simple et doit être fait le jour de l'ouverture : envoyer un événement dans chacune des trois configurations (allowlist ne contenant pas `to` ; fil sous contrôle de notre application ; agent désactivé), et lire le `status` et le `skipped_reason` retournés par le GET. Ces trois observations valent plus que tout ce qu'on peut déduire de la spec.

---

### `agent_test` : parler à l'agent sans WhatsApp

#### Ce que fait l'endpoint

Citation de la spec : « sends test messages to the AI agent for automated testing **without requiring a real consumer phone number** ». Les messages sont traités par **le pipeline complet de l'agent** et la réponse est renvoyée **de façon synchrone**.

Les usages déclarés dans `info.description` sont au nombre de trois, et tous cadrés « during development » :

1. **`validate agent behavior`** : vérifier que l'agent se comporte comme attendu.
2. **`test knowledge base responses`** : vérifier ce que l'agent répond à partir de sa base de connaissances. Directement exploitable pour notre banc de test : c'est la boucle de validation d'une KB client avant mise en service, sans mobiliser un numéro ni un testeur humain.
3. **`verify skill/connector integrations`** : vérifier les intégrations de compétences et de connecteurs.

Les trois réponses aux questions posées :

1. **Mode d'appel** : un unique `POST`. Pas de GET, pas de listing, pas d'endpoint de conversation. Corps JSON minimal (un champ requis).
2. **Synchrone** : **oui**, explicitement. La réponse de l'agent est dans le corps de la réponse HTTP. C'est l'opposé exact de `agent_event`. Pas d'ID à poller, pas de file.
3. **Numéro consommateur réel** : **non, aucun**. Il n'y a pas de champ `to` dans la requête. C'est la différence structurante avec `agent_event`.

#### POST : lancer un test

##### Requête

```
POST https://api.facebook.com/{entity_id}/agent_test
```

`operationId` : `runAgentTest` · tags : `Agent Config` **et** `Business AI`

> Ce double tag est une singularité : `sendAgentEvent` et `getAgentEvent` ne portent que `Business AI`. Sans incidence sur le comportement de l'API, mais il compte si l'on génère un client par tag : `runAgentTest` apparaîtra dans **deux** classes générées (un `AgentConfigApi` et un `BusinessAiApi`), avec une méthode dupliquée. À arbitrer explicitement au moment de la génération plutôt que de le découvrir dans le diff.

En-têtes :

| Nom | Requis | Valeur |
|---|---|---|
| `Authorization` | oui | `Bearer <token>` |
| `Content-Type` | oui | `application/json` |
| `X-API-Version` | non (mais à envoyer) | `2.0.0` |

Paramètres de chemin :

| Nom | Type | Requis | Description |
|---|---|---|---|
| `entity_id` | string | oui | WhatsApp Business Phone Number ID de l'agent à tester |

Aucun paramètre de requête.

Corps requis (`required: true`), schéma `BizAIOmniChannelAgentTestRequest` :

| Champ | Type | Requis | Description | Exemple spec |
|---|---|---|---|---|
| `user_msg` | string | **oui** | Contenu texte du message de test envoyé à l'agent | `What products do you have?` |
| `conversation_id` | string | non | Identifiant pour les conversations de test multi-tours. Fournir le `conversation_id` d'une réponse précédente pour continuer cette conversation | `conv_abc123` |

Premier tour :

```json
{ "user_msg": "Quels sont vos horaires ?" }
```

Tour suivant :

```json
{ "user_msg": "Et le dimanche ?", "conversation_id": "conv_abc123" }
```

> ATTENTION : `user_msg` est **texte uniquement**. Aucun champ pour image, document, audio, localisation, ni pour un bouton ou une réponse rapide cliquée. On ne peut donc **pas** tester par cette API le comportement de l'agent face à une pièce jointe ou à un clic sur un `quick_reply`, alors que l'agent en produit lui-même (`quick_replies` en réponse). C'est une limite dure de la couverture de test.

> ATTENTION : **aucune longueur maximale n'est documentée pour `user_msg`**, contrairement aux champs de `agent_event` qui sont tous bornés. Ne pas en conclure qu'il n'y a pas de limite : en conclure qu'elle est inconnue et qu'un message long peut produire un 400.

> ATTENTION : ne pas fournir `conversation_id` démarre une **nouvelle** conversation. C'est le piège classique d'une boucle de test qui oublie de réinjecter l'ID : chaque tour repart de zéro, l'agent perd tout le contexte, et le test valide un comportement qui n'a rien à voir avec la réalité multi-tours. Le symptôme est trompeur, l'agent répond correctement à chaque message pris isolément.

##### Réponse 200

Description de la spec : « Response containing the AI agent response and test conversation metadata ». Schéma `BizAIOmniChannelAgentTestResponse` :

| Champ | Type | Requis | Description | Exemple spec |
|---|---|---|---|---|
| `message_id` | string | **oui** | Identifiant unique de cet échange de messages | `msg_abc123` |
| `agent_response` | string | **oui** | Texte de la réponse de l'agent | `We have several products available...` |
| `conversation_id` | string | **oui** | Identifiant de la conversation de test, à réutiliser pour le multi-tours | `conv_abc123` |
| `timestamp` | integer | non | Horodatage Unix de génération de la réponse | `1714500000` |
| `handoff_reason` | string, `nullable: true` | non | Si l'agent passe la main à un humain, contient la raison | `complex_request` |
| `no_response_reason` | string, `nullable: true` | non | Si l'agent n'a pas généré de réponse, contient la raison. Valeurs possibles **incluant** `ELIGIBILITY_CHECK_FAILED` | `out_of_scope` |
| `quick_replies` | array of string | non | Réponses rapides suggérées par l'agent | |
| `product_variant_ids` | array of string | non | IDs de variantes des produits référencés dans la réponse de l'agent | |

> Rappel du point relevé plus haut : `nullable: true` est un mot-clé OpenAPI 3.0 alors que le fichier se déclare en 3.1.1. Un générateur strictement 3.1 l'ignorera et produira `handoff_reason: string` et `no_response_reason: string` non nullables, alors que ce sont précisément les deux champs qui arriveront à `null` la plupart du temps. À corriger à la main dans le client généré.

##### Les deux champs qui comptent vraiment pour nous

**`handoff_reason`** est le seul endroit de toute cette API où l'on peut **observer une décision de handoff avant la production**. Si ce champ est non nul, l'agent a jugé qu'il fallait passer à un humain.

> ATTENTION : `handoff_reason` **n'a pas d'enum**. Un seul exemple, `complex_request`. Il n'existe donc **aucune liste connue des motifs de handoff**. Pour un produit dont la valeur centrale est de maîtriser le passage à l'humain, c'est le trou de documentation le plus coûteux du chapitre. La seule voie est empirique : construire une batterie de messages de test couvrant les cas où l'on **veut** un handoff et ceux où l'on n'en veut pas, la passer systématiquement, et **collecter les `handoff_reason` observées** pour bâtir notre propre référentiel. Cette batterie a de la valeur au-delà du debug : c'est le matériau d'une fonctionnalité de notre console (montrer au client, avant mise en production, sur quoi son agent va lâcher prise).

> ATTENTION : la spec ne dit **pas** si `handoff_reason` en mode test correspond exactement aux motifs de handoff en production, ni si le fait de renseigner `handoff_reason` déclenche quoi que ce soit. En test, aucun humain n'est notifié, évidemment, mais **on ignore si l'agent en mode test emprunte le même chemin de décision qu'en production** (le `handoff` configuré dans `agent_config/settings` est-il pris en compte ?). À vérifier en conditions réelles, en comparant une même question avec `handoff.enabled` à `true` puis à `false`.

**`no_response_reason`** : l'agent n'a rien produit. La spec nomme `ELIGIBILITY_CHECK_FAILED` mais écrit « Possible values **include** », donc la liste est **explicitement non exhaustive**. L'exemple donné dans le YAML, `out_of_scope`, est d'ailleurs une valeur qui n'est pas dans la phrase de description : il y a donc déjà au moins deux valeurs connues, et rien ne dit qu'il n'y en a pas dix.

> `ELIGIBILITY_CHECK_FAILED` est en MAJUSCULES, `out_of_scope` en minuscules. La spec est incohérente sur la casse de ce champ. **Comparer sans tenir compte de la casse**, ou stocker brut et comparer normalisé.

> ATTENTION : `agent_response` est marqué **requis**, alors que `no_response_reason` existe précisément pour le cas où l'agent n'a pas répondu. Le contrat est contradictoire : soit `agent_response` arrive vide (`""`), soit il est absent malgré `required`. Coder défensivement, en traitant `agent_response` comme potentiellement vide ou manquant dès que `no_response_reason` est renseigné.

**`product_variant_ids`** révèle que l'agent est câblé à un catalogue produit. Aucun autre élément de ces deux specs n'en parle. Utile à noter, hors périmètre ici.

##### Codes d'erreur du POST

| Code | Signification |
|---|---|
| 400 | Bad request |
| 401 | Unauthorized |
| 429 | Too many requests |
| 500 | Server error |
| `default` | Error response (format `StandardError`) |

> ATTENTION : **pas de 403 documenté** sur `agent_test`, et **pas de 404** non plus. Un `conversation_id` inconnu ou expiré ne produit donc pas de 404 documenté. La doc ne dit **pas** ce qui arrive dans ce cas : nouvelle conversation créée silencieusement, ou 400 ? Les deux comportements sont plausibles et ils n'ont pas les mêmes conséquences (le premier fait passer un test multi-tours cassé pour un test réussi). À vérifier en conditions réelles.

#### Ce que la doc ne dit pas sur `agent_test`, et qui compte

- **Durée de vie de `conversation_id`** : non documentée. Aucune indication de TTL, ni de nombre maximal de tours par conversation de test.
- **Aucun moyen de lister, relire ou supprimer une conversation de test.** Il n'y a qu'un POST. Si l'on veut un historique de test dans notre console, **c'est à nous de le stocker** au fur et à mesure des appels. Rien ne sera récupérable a posteriori côté Meta.
- **Effet de bord sur les données réelles** : la doc affirme qu'aucun numéro consommateur n'est nécessaire, mais elle ne dit **pas** explicitement qu'aucun message n'est envoyé sur WhatsApp, ni si les conversations de test apparaissent dans les statistiques, les logs ou l'historique de l'agent. Le fait qu'il n'y ait pas de destinataire rend un envoi réel très improbable, mais l'absence d'effet sur les métriques n'est pas garantie.
- **Coût et facturation** : rien. On ignore si un appel `agent_test` est facturé, et s'il consomme le même quota que le trafic réel. Le seul document contractuel référencé par la spec est le bloc `license` (« Meta Business AI Terms of Service »), qui est donc l'endroit où chercher avant de facturer un banc de test à un client.
- **Latence** : rien. L'endpoint est synchrone et traverse « le pipeline complet de l'agent », donc il peut être lent (appel LLM, recherche dans la base de connaissances, éventuellement appels de connecteurs sortants). **Aucun timeout n'est documenté.** Notre client HTTP doit poser un timeout généreux et explicite plutôt que de s'en remettre au défaut de la librairie, et l'UI doit être asynchrone côté navigateur même si l'API est synchrone.
- **Fidélité du test à la production** : la spec cadre `agent_test` « during development » et pour « validate agent behavior », mais ne dit jamais que le chemin d'exécution est identique à celui de la production. Un test qui passe n'est pas une garantie de production.
- **Exécution réelle des connecteurs** : la spec dit que `agent_test` sert à « verify skill/connector integrations ». Cela implique fortement que les connecteurs sont **réellement appelés** pendant un test. Ce n'est pas dit noir sur blanc, mais c'est la lecture la plus naturelle. Même raisonnement pour « test knowledge base responses » : la KB réelle de l'agent est vraisemblablement interrogée, donc un test reflète l'état courant de la KB du client, pas un instantané figé.

> ATTENTION, conséquence sérieuse : si les connecteurs sont réellement exécutés, alors un `agent_test` peut **provoquer un effet de bord dans un système tiers** (créer un ticket, débiter, envoyer un mail depuis le CRM du client). « Test » ne veut pas dire « sandbox ». Avant d'exposer un banc de test dans notre console, il faut soit vérifier ce comportement, soit pointer les connecteurs vers un environnement de recette pendant les campagnes de test. Ne jamais laisser un client marteler un banc de test branché sur ses connecteurs de production sans l'en avertir explicitement.

---

### Tableau de synthèse

| | `agent_event` | `agent_test` |
|---|---|---|
| Verbe(s) | `POST /`, `GET /{agent_event_id}` | `POST /` uniquement |
| URL | `https://api.facebook.com/{entity_id}/agent_event` | `https://api.facebook.com/{entity_id}/agent_test` |
| `operationId` | `sendAgentEvent`, `getAgentEvent` | `runAgentTest` |
| Tags | `Business AI` | `Agent Config` **et** `Business AI` |
| Version OpenAPI du fichier | `3.1.1` (avec `nullable` de 3.0 en réponse `agent_test`) | `3.1.1` |
| Licence déclarée | Meta Business AI Terms of Service | identique |
| Synchronicité | **Asynchrone** (file + polling) | **Synchrone** |
| Destinataire réel | **Oui**, `to` en E.164, requis | **Non**, aucun numéro |
| Champ requis du corps | `to`, `event.type`, `event.description`, `event.payload` | `user_msg` |
| Suivi | `GET` sur `agent_event_id` | aucun, la réponse est immédiate |
| Codes documentés | POST : 400, 401, 429, 500. GET : 400, 401, **403**, **404**, 429, 500 | 400, 401, 429, 500 |
| Signal de handoff | absent du contrat | `handoff_reason` (non énuméré) |
| Signal de non-réponse | `status: skipped` + `skipped_reason` (non énuméré) | `no_response_reason` (liste non exhaustive) |
| Autorisation | `bizai_wa_enterprise_api_3p_access` **ou** `whatsapp_business_messaging` (jeu standard MBA) | identique |
| `X-API-Version` | `2.0.0`, optionnel dans la spec, à envoyer quand même | identique |

#### Rappel transverse sur les autorisations

| Endpoints | Autorisation |
|---|---|
| `agent_event`, `agent_test`, `agent_config/*`, `agent_allowlist`, `agent_eligibility`, `agent_onboarding`, `agent_knowledge/*`, `agent_eval` | capability `bizai_wa_enterprise_api_3p_access` **ou** permission `whatsapp_business_messaging` |
| `thread_control` (spec v1.0.0), `delete_agent` | permission `whatsapp_business_messaging` **uniquement** |

> ATTENTION : c'est le seul écart d'autorisation du corpus, et il tombe pile sur les deux opérations les plus sensibles (prendre le contrôle du fil, supprimer un agent). Un onboarding qui ne valide que la capability laissera passer toute la configuration et tout le test, puis échouera au premier handoff réel. Valider `whatsapp_business_messaging` dès l'onboarding est la règle à retenir.

---

<a id="7-operate-eval-delete"></a>

## 7. Évaluation et suppression

> Relecture adversariale : 1 erreur(s) et 11 omission(s) corrigées.

#### Vue d'ensemble

Deux APIs distinctes, qui n'ont en commun que la version d'en-tête et le schéma d'erreur :

| API | Base URL | Nature |
|-----|----------|--------|
| Agent Eval | `https://api.facebook.com/{entity_id}/agent-eval` | Lecture des cas de test, lancement de jobs d'évaluation simulée, lecture des résultats |
| Delete Agent | `https://api.facebook.com/{entity_id}/delete_agent` | Suppression de l'agent sur un numéro |

Les deux specs sont en **OpenAPI 3.1.1**, sous licence **Meta Business AI Terms of Service**. Les tags déclarés : `Business AI` et `Insights` pour Agent Eval, `Business AI` seul pour Delete Agent.

Dans les deux cas, `entity_id` est le **WhatsApp Business Phone Number ID**. Pour Agent Eval la doc le décrit de façon plus lâche (« The entity ID (e.g. WhatsApp Business phone number ID) »), pour Delete Agent elle est explicite (« The WhatsApp Business Phone Number ID for the Meta Business Agent »).

Authentification commune : `Authorization: Bearer <token>` (securityScheme `OAuthToken__Authorization`, HTTP bearer). Aucun endpoint n'est public.

Les autorisations diffèrent, et c'est un point à câbler correctement côté console :

- **Agent Eval** : `Capability: bizai_wa_enterprise_api_3p_access` **OU** `Permission: whatsapp_business_messaging`.
- **Delete Agent** : `Permission: whatsapp_business_messaging` uniquement.

> ATTENTION : la capability `bizai_wa_enterprise_api_3p_access` ouvre l'eval mais n'est pas listée pour la suppression. Un token qui lit les évaluations n'est donc pas forcément un token qui peut détruire l'agent. C'est une bonne nouvelle pour la séparation des rôles dans mba.messagingme.app : on peut donner un token « analyse » à un profil non destructeur.

**`operationId` déclarés**, utiles si on génère un client typé à partir des specs :

| Endpoint | `operationId` |
|----------|---------------|
| `GET /cases` | `listEvalCases` |
| `POST /run` | `runEvaluation` |
| `GET /run` | `getEvalRunStatus` |
| `GET /details` | `getEvalDetails` |
| `GET /summary` | `getEvalSummary` |
| `DELETE /` (delete_agent) | `deleteAgent` |

En-tête de version, identique partout :

```
X-API-Version: 2.0.0
```

Type `string`, `enum: [2.0.0]`, **`required: false`**. La doc ne dit pas quelle version est appliquée quand l'en-tête est absent. Envoyer `2.0.0` systématiquement sur chaque appel : c'est la seule façon de ne pas dépendre d'un défaut serveur non documenté qui peut bouger.

Schéma d'erreur commun à toutes les réponses non 200 :

##### `StandardError`

| Champ | Type | Requis | Notes |
|-------|------|--------|-------|
| `title` | string | oui | Libellé court, ex. `Bad Request`, `Job Not Found` |
| `detail` | string | oui | Texte explicatif, ex. `Rate limit exceeded` |
| `type` | string | non | Non documenté au-delà du type |
| `status` | integer | non | Non documenté au-delà du type (aucune description dans la spec) |

> ATTENTION : `status` est déclaré `integer` sans aucune description dans les deux specs. Il est tentant d'y lire le code HTTP répliqué dans le corps, mais **la doc ne le dit nulle part**. Ne jamais router la logique d'erreur sur ce champ : il est optionnel et sa sémantique n'est pas contractuelle. Se fier au code HTTP de la réponse.

Formulation du 403 selon l'API, l'écart mérite d'être noté :

- Agent Eval : `Forbidden` / `The caller is not authorized to access this entity`.
- Delete Agent : `Forbidden` / `The caller is not permitted to delete the agent`.

Autrement dit, le 403 de l'eval parle d'accès à l'entité, celui de la suppression parle du droit de supprimer. Un 403 sur `DELETE` ne signifie donc pas forcément que le token n'a aucun accès au numéro : il peut lire et ne pas pouvoir détruire.

---

#### Agent Eval

L'eval sert à simuler des conversations contre l'agent, à les faire noter par un juge LLM, puis à agréger le tout en rapport. C'est le seul moyen documenté de vérifier **avant la prod** comment l'agent se comporte sur un scénario donné, y compris sur les scénarios d'escalade et de passage à un humain.

##### Ce qui est pilotable par API, et ce qui ne l'est pas

Point structurant pour le produit, à lire avant de concevoir l'écran :

**Pilotable :**
- Lister les cas de test existants (`GET /cases`).
- Lancer un job d'évaluation sur une sélection de cas existants (`POST /run`).
- Suivre l'avancement d'un job (`GET /run`).
- Lire les résultats détaillés par conversation (`GET /details`).
- Lire les rapports agrégés (`GET /summary`).

**NON pilotable :**
- **Créer un cas de test.** Il n'existe aucun `POST /cases`, `PUT /cases`, ni `PATCH`.
- **Modifier un cas de test** (scénario, `max_turns`, `success_criteria`, `categories`).
- **Supprimer un cas de test.**
- Il n'existe pas non plus d'endpoint pour lister les jobs, les évaluations ou les summaries : `GET /details` et `GET /summary` exigent des IDs qu'il faut avoir obtenus autrement.

> ATTENTION : conséquence produit directe. La console ne peut pas offrir « créer un scénario de test du handoff ». Les cas de test sont créés ailleurs (interface Meta, ou provisionnement hors de cette API v2.0.0), et l'API ne fait que les consommer. Tout écran de mba.messagingme.app qui promettrait la création de cas de test serait faux. Ce que la console peut faire, et qui a de la valeur : lister les cas disponibles, permettre de les sélectionner, orchestrer les runs, historiser les scores dans notre propre base, et surveiller la dérive dans le temps (l'API Meta n'offre aucun historique consultable sans IDs).

> ATTENTION : corollaire d'implémentation. Comme il n'existe aucun endpoint de listing des jobs ou des évaluations, **c'est notre base qui doit être le registre**. À chaque `POST /run`, persister `job_id`. À chaque job `COMPLETED`, persister `summary_id`, puis tous les `eval_ids` extraits de `eval_ids_by_score`. Un ID perdu est un résultat définitivement inaccessible.

##### `GET /cases` : lister les cas d'évaluation

`operationId` : `listEvalCases`.

```
GET https://api.facebook.com/{entity_id}/agent-eval/cases
Authorization: Bearer <token>
X-API-Version: 2.0.0
```

Paramètre de chemin : `entity_id` (string, requis).
Aucun paramètre de requête. Aucun corps.

> ATTENTION : pas de pagination documentée (ni `limit`, ni `after`, ni `cursor`), et pas de filtrage par catégorie. La doc ne dit pas combien de cas peuvent exister ni si la réponse est tronquée au delà d'un certain nombre. À vérifier en conditions réelles avant de construire un tableau paginé côté console.

**Réponse 200** : objet avec un seul champ.

| Champ | Type | Requis |
|-------|------|--------|
| `eval_cases` | array de `BizAIEvalCaseResponse` | oui |

###### `BizAIEvalCaseResponse`

| Champ | Type | Requis | Description et valeurs |
|-------|------|--------|------------------------|
| `id` | string | oui | ID du cas de test. Exemple doc : `"1234567890"` |
| `scenario` | string | oui | Texte libre définissant la tâche et les contraintes du simulateur d'utilisateur. Exemple : `Customer asks about return policy for damaged item` |
| `categories` | array de string | non | Nullable. Catégories du scénario. Aucune liste de valeurs autorisées n'est documentée, c'est du texte libre |
| `max_turns` | integer | non | Nullable. Nombre maximum de tours dans la simulation. Exemple : `10`. Pas de minimum, maximum ni défaut documenté |
| `success_criteria` | array de string | non | Nullable. Critères que l'agent doit satisfaire pour que le test passe |

> ATTENTION : `id` est décrit comme « the eval case ent ID » avec l'exemple numérique `"1234567890"`, alors que le paramètre `eval_case_ids` du `POST /run` exige explicitement le **format pfbid**. Les deux descriptions ne concordent pas. Traiter l'`id` comme une chaîne opaque, la renvoyer telle quelle sans reformatage ni conversion numérique, et surtout ne jamais la parser en entier (un ID pfbid est alphanumérique et long).

**Codes d'erreur documentés** : 400, 401, 403, 404, 429, 500, plus une réponse `default` de type `StandardError`. Exemples fournis par la spec :

| Code | `title` | `detail` |
|------|---------|----------|
| 400 | `Bad Request` | `Invalid parameters` |
| 403 | `Forbidden` | `The caller is not authorized to access this entity` |
| 404 | `Not Found` | `Resource not found` |
| 429 | `Too Many Requests` | `Rate limit exceeded` |

Le 400 générique (`Invalid parameters`) sur un endpoint qui n'a **aucun paramètre de requête** ne dit pas ce qui peut être invalide : vraisemblablement l'`entity_id` du chemin ou l'en-tête de version. La doc ne tranche pas.

##### `POST /run` : lancer un job d'évaluation

`operationId` : `runEvaluation`.

```
POST https://api.facebook.com/{entity_id}/agent-eval/run?eval_case_ids=<id1>,<id2>
Authorization: Bearer <token>
X-API-Version: 2.0.0
Content-Type: application/json
```

Soumet un job combiné qui enchaîne simulation, évaluation, et optionnellement insights, sur plusieurs cas. Renvoie un `job_id` à interroger ensuite.

**Paramètre de chemin** : `entity_id` (string, requis).

**Paramètre de requête** :

| Nom | Type | Requis | Description |
|-----|------|--------|-------------|
| `eval_case_ids` | string | oui | Liste d'IDs de cas séparés par des virgules, format pfbid |

**Corps de requête** : `required: true`, `Content-Type: application/json`, schéma `BizAIComboRunRequest`.

###### `BizAIComboRunRequest`

```yaml
type: object
additionalProperties: false
```

Aucune propriété. Aucun champ requis. `additionalProperties: false`.

> ATTENTION : c'est le piège le plus vicieux de tout le chapitre. Le corps est **obligatoire** mais doit être **vide**, et tout champ supplémentaire est **interdit** par le schéma. Envoyer exactement `{}` avec `Content-Type: application/json`. Envoyer `null`, une chaîne vide, ou rien du tout risque un 400 côté serveur si le corps est validé ; envoyer un champ « utile » (`case_ids`, `run_insights`, `max_turns`…) viole `additionalProperties: false`. Toute la configuration du run passe par la **query string**, pas par le corps.

> ATTENTION : la description parle d'insights « optionnellement » calculés, mais **aucun paramètre ne permet de piloter cette option**. Ni le corps (vide), ni la query (un seul paramètre). Le déclenchement des insights est donc décidé côté Meta selon une règle non documentée. Ne pas promettre à l'utilisateur un run « avec ou sans rapport agrégé » : on ne contrôle pas ce levier.

> ATTENTION : aucune limite documentée sur le nombre d'IDs dans `eval_case_ids`, alors que la doc du `GET /details` mentionne explicitement une erreur « contains too many IDs » pour son propre paramètre. Prévoir un découpage en lots côté console (valeur à calibrer empiriquement) et gérer le 400 proprement plutôt que de supposer qu'on peut passer 200 cas d'un coup.

**Réponse 200** : `BizAIComboRunResponse`.

| Champ | Type | Requis | Description |
|-------|------|--------|-------------|
| `job_id` | string | oui | Identifiant du job créé, format pfbid |
| `status` | string | oui | Statut initial du job : `QUEUED` |

> ATTENTION : la description du champ dit `QUEUED`, l'exemple du YAML dit `RUNNING`. La doc se contredit. Ne coder aucune assertion sur la valeur initiale, et surtout ne pas conditionner le démarrage du polling à `status === "QUEUED"`. Persister le `job_id` et lancer le polling quel que soit le statut renvoyé.

> ATTENTION : un 200 ici signifie seulement que le job est **accepté pour traitement** (« Acknowledgment that the job was accepted for processing »). Ce n'est pas une évaluation faite. Un job accepté peut finir en `FAILED`.

**Codes d'erreur documentés** : 400, 401, 403, 404, 429, 500, plus `default`. Exemples fournis :

| Code | `title` | `detail` |
|------|---------|----------|
| 400 | `Invalid request` | `The request is invalid or missing required fields` |
| 404 | `Not found` | `The requested resource was not found` |

À noter : le libellé du 400 ici (`Invalid request`, casse basse sur le second mot) diffère de celui de `GET /cases` (`Bad Request`). Les `title` ne sont pas normalisés d'un endpoint à l'autre : ne jamais matcher sur leur texte pour classer une erreur.

##### `GET /run` : suivre un job

`operationId` : `getEvalRunStatus`.

```
GET https://api.facebook.com/{entity_id}/agent-eval/run?job_id=<pfbid>
Authorization: Bearer <token>
X-API-Version: 2.0.0
```

**Paramètre de chemin** : `entity_id` (string, requis).

**Paramètre de requête** :

| Nom | Type | Requis | Description |
|-----|------|--------|-------------|
| `job_id` | string | oui | Le `job_id` renvoyé par `POST /run` |

Un seul `job_id` par appel (pas de liste séparée par virgules, contrairement à `/details` et `/summary`). Suivre N jobs demande N appels.

**Réponse 200** : `BizAIComboJobStatusResponse`.

| Champ | Type | Requis | Description |
|-------|------|--------|-------------|
| `status` | string | oui | `QUEUED`, `RUNNING`, `COMPLETED` ou `FAILED`. Exemple YAML : `COMPLETED` |
| `progress` | objet `Progress` | non | Nullable. Présent pendant l'exécution |
| `result` | `BizAIComboJobResult` | non | Nullable. Payload complet quand `status` vaut `COMPLETED` |
| `error` | objet `Error` | non | Nullable. Détails quand `status` vaut `FAILED` |

> ATTENTION : dossier complet des incohérences de statut, à garder en tête. `POST /run` décrit `QUEUED` mais donne `RUNNING` en exemple ; `GET /run` donne `COMPLETED` en exemple. Trois valeurs d'exemple différentes sur le même champ selon l'endroit de la spec. Aucune n'est un contrat.

###### `Progress`

| Champ | Type | Requis | Description |
|-------|------|--------|-------------|
| `completed` | integer | oui | Nombre de cas terminés |
| `total` | integer | oui | Nombre total de cas dans le job |
| `current_stage` | string | oui | Étape courante : `simulation`, `evaluation`, `insights` ou `done` |

> ATTENTION : `status` et `current_stage` sont typés `string` **sans `enum`** dans le YAML. Les valeurs listées le sont en prose, dans la description. Elles ne sont donc pas garanties par le contrat : traiter toute valeur inconnue comme « état non terminal » plutôt que de planter, et ne jamais faire de `switch` exhaustif sans branche `default`.

###### `Error`

| Champ | Type | Requis | Description |
|-------|------|--------|-------------|
| `code` | string | oui | Code d'erreur, ex. `SIMULATION_FAILED` |
| `message` | string | oui | Message lisible |
| `failed_case_ids` | array de string | non | IDs des cas en échec |

Aucune liste exhaustive de `code` n'est documentée : `SIMULATION_FAILED` est donné comme exemple, pas comme énumération.

###### `BizAIComboJobResult` (présent quand `COMPLETED`)

| Champ | Type | Requis | Description |
|-------|------|--------|-------------|
| `summary_id` | string | oui | ID du rapport agrégé, à réutiliser dans `GET /summary` |
| `avg_conversation_score` | number | non | Score moyen par conversation. Doc : plage 1-5. Exemple : `0.85` |
| `avg_turn_score` | number | non | Score moyen par tour (un tour = une paire message utilisateur / message agent), granularité plus fine. Doc : plage 1-5. Exemple : `0.92` |
| `summary` | string | oui | Résumé en langage naturel de la performance globale |
| `highlights` | string | non | **Chaîne** contenant un tableau JSON d'objets {description, eval ids} |
| `top_failure_categories` | string | non | **Chaîne** contenant un tableau JSON d'objets {catégorie, eval ids, actions recommandées} |
| `eval_ids_by_score` | string | non | **Chaîne** contenant un objet JSON groupant les eval IDs par score. Exemple : `{"5": ["eval_001"], "4": ["eval_002", "eval_003"]}` |
| `creation_time` | integer | oui | Timestamp Unix de création. Exemple : `1714500000` |
| `update_time` | integer | oui | Timestamp Unix de dernière mise à jour. Exemple : `1714500000` |

> ATTENTION : contradiction non résolvable dans la doc. Les descriptions annoncent une plage **1-5** pour `avg_conversation_score` et `avg_turn_score`, mais les exemples valent `0.85` et `0.92`, cohérents avec une plage 0-1. Impossible de trancher sur pièces. Ne pas afficher ces scores sous forme de pourcentage ni de note sur 5 tant que la plage réelle n'a pas été observée sur un vrai job. Stocker le nombre brut, et n'ajouter la mise en forme qu'après vérification empirique.

> Bonne nouvelle en revanche sur les timestamps : l'exemple `1714500000` fait 10 chiffres, ce sont donc des **secondes** Unix, pas des millisecondes. Multiplier par 1000 avant tout `new Date()` en JavaScript.

> ATTENTION : `highlights`, `top_failure_categories` et `eval_ids_by_score` sont typés `string` mais contiennent du JSON. Double décodage obligatoire : parser la réponse HTTP, puis `JSON.parse` sur chacun de ces champs. Envelopper chaque parse dans un try/catch : les exemples du YAML pour `highlights` (`Handled 95% of queries without escalation`) et `top_failure_categories` (`Product availability, pricing`) ne sont **pas du JSON valide**, ce qui laisse penser que le contenu réel peut parfois être du texte brut. Un parse non protégé fera tomber l'écran de résultats.

> ATTENTION : le YAML ne documente aucune durée de rétention du job, ni fréquence de polling recommandée, ni délai avant expiration du `job_id`, ni durée typique d'un run. Ne pas poller en boucle serrée : le 429 est documenté sur cet endpoint. Prévoir un backoff exponentiel et un plafond de tentatives côté worker.

**Codes d'erreur documentés** : 401, 403, 404, 429, 500, plus `default`. **Pas de 400 documenté** sur ce GET, alors que `job_id` est obligatoire : un `job_id` manquant ou malformé remontera vraisemblablement en 404 ou en `default`. Le 404 a pour exemple `Job Not Found`.

##### `GET /details` : résultats par conversation

`operationId` : `getEvalDetails`.

```
GET https://api.facebook.com/{entity_id}/agent-eval/details?eval_ids=<id1>,<id2>
Authorization: Bearer <token>
X-API-Version: 2.0.0
```

**Paramètre de chemin** : `entity_id` (string, requis).

**Paramètre de requête** :

| Nom | Type | Requis | Description |
|-----|------|--------|-------------|
| `eval_ids` | string | oui | Liste d'IDs d'évaluation séparés par des virgules |

**Réponse 200** : objet avec `evaluations`, array de `BizAIEvalDetailResponse` (requis).

###### `BizAIEvalDetailResponse`

| Champ | Type | Requis | Description |
|-------|------|--------|-------------|
| `id` | string | oui | ID de l'évaluation |
| `score` | integer | non | Score global attribué par le juge LLM. Exemple : `85` |
| `per_turn_labels` | string | oui | Décrit comme un tableau JSON d'entiers par tour. Exemple : `GOOD,GOOD,NEEDS_IMPROVEMENT` |
| `reasons` | string | oui | Chaîne contenant un tableau JSON d'objets {category, score, description, recommended_actions} |
| `custom_success_criteria` | string | non | Chaîne contenant un tableau JSON des critères de succès spécifiés par le client |
| `eval_case_id` | string | non | ID du cas ayant défini le scénario et les critères. Exemple : `"9876543210"` |
| `transcript` | string | non | Chaîne contenant un objet JSON avec `system_prompt` et `transcript_turns`. Exemple : `User: I want to return... Agent: Sure, let me help...` |
| `creation_time` | integer | oui | Timestamp Unix de création. Exemple : `1714500000` |
| `update_time` | integer | oui | Timestamp Unix de mise à jour. Exemple : `1714500000` |

> ATTENTION : `per_turn_labels` est le champ le plus incohérent de l'API. Il est déclaré `required`, typé `string`, décrit comme « JSON array of per-turn label integers », et illustré par `GOOD,GOOD,NEEDS_IMPROVEMENT`, qui n'est ni du JSON, ni des entiers. Trois affirmations, trois formats différents. Écrire un décodeur défensif : tenter `JSON.parse`, et en cas d'échec retomber sur un `split(",")` avec trim. Ne présumer ni du type des éléments, ni de leur nombre. Les libellés `GOOD` et `NEEDS_IMPROVEMENT` de l'exemple ne constituent pas une énumération documentée : d'autres valeurs sont possibles.

> ATTENTION : `transcript` est un troisième champ dont l'exemple contredit le type annoncé. Il est décrit comme une chaîne contenant un objet JSON (`system_prompt` + `transcript_turns`), mais l'exemple donné est du texte brut de conversation (`User: I want to return... Agent: Sure, let me help...`), qui n'est pas du JSON valide. Même traitement que `highlights` et `top_failure_categories` : `JSON.parse` sous try/catch, et repli sur l'affichage du texte brut. Le motif se répète assez pour qu'on en fasse une règle générale : **dans cette API, tout champ `string` annoncé comme porteur de JSON doit être considéré comme pouvant être du texte libre.**

> ATTENTION : `score` est un integer d'exemple `85`, alors que les scores agrégés sont des `number` d'exemple `0.85` et de plage annoncée 1-5. Trois échelles apparemment différentes cohabitent dans la même API. Ne jamais comparer un `score` de `/details` à un `avg_conversation_score` de `/summary` sans avoir validé les échelles en réel.

> ATTENTION : `transcript` porte le `system_prompt` de l'agent et l'intégralité de la conversation simulée. C'est de la donnée sensible (configuration métier du client, formulations internes). L'exposer telle quelle dans une console multi-clients ou la logguer en clair est un risque. Restreindre l'accès et exclure ce champ des logs applicatifs.

**Codes d'erreur documentés** : 400, 401, 403, 429, 500, plus `default`. **Pas de 404**. L'exemple du 400 est explicite et couvre **deux causes distinctes** :

```
title:  Invalid request
detail: The eval_ids parameter is missing or contains too many IDs
```

Deux enseignements. Premier : un `eval_ids` **absent** remonte en 400, pas en 404, ce qui est cohérent avec l'absence de 404 sur cet endpoint. Deuxième : il existe un plafond au nombre d'IDs, mais **aucun chiffre n'est donné**. Découper les requêtes en lots et traiter le 400 comme un signal de découpage, pas comme un bug. Attention à ne pas confondre les deux causes dans la gestion d'erreur : elles partagent le même code et le même `title`, seul le `detail` les distingue, et il n'est pas structuré.

Le comportement en cas d'ID inexistant n'est pas documenté : l'évaluation est probablement simplement absente du tableau `evaluations`, sans erreur. Ne jamais supposer que la longueur de `evaluations` égale le nombre d'IDs demandés, et réapparier les résultats sur le champ `id`.

##### `GET /summary` : rapports agrégés

`operationId` : `getEvalSummary`.

```
GET https://api.facebook.com/{entity_id}/agent-eval/summary?summary_ids=<id1>,<id2>
Authorization: Bearer <token>
X-API-Version: 2.0.0
```

**Paramètre de chemin** : `entity_id` (string, requis).

**Paramètre de requête** :

| Nom | Type | Requis | Description |
|-----|------|--------|-------------|
| `summary_ids` | string | oui | Liste d'IDs de rapport séparés par des virgules |

**Réponse 200** : objet avec `insights`, array de `BizAIEvalSummaryResponse` (requis).

###### `BizAIEvalSummaryResponse`

Champs requis : `id`, `summary`, `creation_time`, `update_time`.

| Champ | Type | Requis | Description |
|-------|------|--------|-------------|
| `id` | string | oui | ID du rapport d'insight |
| `avg_conversation_score` | number | non | Score moyen par conversation. Exemple : `0.85` |
| `avg_turn_score` | number | non | Score moyen par tour. Exemple : `0.92` |
| `summary` | string | oui | Résumé en langage naturel |
| `highlights` | string | non | Chaîne contenant un tableau JSON |
| `top_failure_categories` | string | non | Chaîne contenant un tableau JSON |
| `eval_ids_by_score` | string | non | Chaîne contenant un objet JSON |
| `creation_time` | integer | oui | Timestamp Unix. Exemple : `1714500000` |
| `update_time` | integer | oui | Timestamp Unix. Exemple : `1714500000` |

> ATTENTION : `BizAIEvalSummaryResponse` et `BizAIComboJobResult` portent les mêmes champs, à une différence près : la clé d'identification s'appelle `id` ici et `summary_id` dans le résultat de job. Autre écart : `BizAIComboJobResult` documente une plage 1-5 pour les scores moyens, `BizAIEvalSummaryResponse` ne documente aucune plage. Ne pas réutiliser le même type TypeScript pour les deux sans normalisation explicite, sinon on lira `undefined` sur la clé d'ID selon la source.

**Codes d'erreur documentés** : 400, 401, 403, 429, 500, plus `default`. **Pas de 404**, même remarque que pour `/details`. L'exemple du 400 porte ici la **seule contrainte chiffrée de toute l'API Eval** :

```
title:  Invalid request
detail: The summary_ids parameter must contain at least one valid ID
```

Autrement dit : au moins un ID valide est exigé. Deux lectures possibles, et la doc ne tranche pas entre elles. Soit « au moins un ID » au sens syntaxique (paramètre non vide), soit « au moins un ID **valide**  » au sens sémantique (si tous les IDs fournis sont inconnus, on prend un 400 et non un 200 avec `insights: []`). Cette seconde lecture serait un comportement différent de `/details`, où l'ID inconnu semble simplement absent du tableau. À observer en réel. En attendant, côté console : ne jamais appeler `/summary` avec une liste vide, et traiter le 400 comme « aucun de mes IDs n'est reconnu » plutôt que comme une panne.

À noter aussi l'asymétrie entre les deux endpoints de lecture par IDs : `/details` documente un plafond haut (« too many IDs »), `/summary` documente un plancher (« at least one »). Aucun des deux ne documente les deux bornes. Prudence : supposer que le plafond de `/details` s'applique probablement aussi à `/summary`, sans que la doc l'affirme.

##### Chaînage complet d'un run

L'enchaînement à implémenter, IDs compris :

1. `GET /cases` pour obtenir les `id` disponibles, à afficher pour sélection.
2. `POST /run?eval_case_ids=<ids>` avec le corps `{}`. Récupérer `job_id`, le persister immédiatement.
3. Poller `GET /run?job_id=<id>` avec backoff jusqu'à `COMPLETED` ou `FAILED`. Afficher `progress.completed / progress.total` et `progress.current_stage`.
4. Si `FAILED` : lire `error.code`, `error.message`, `error.failed_case_ids`. Un job peut échouer partiellement ; `failed_case_ids` dit lesquels.
5. Si `COMPLETED` : lire `result.summary_id` (à persister) et parser `result.eval_ids_by_score` pour extraire tous les eval IDs (à persister aussi).
6. `GET /details?eval_ids=<ids>` par lots pour les transcriptions et les raisons, `GET /summary?summary_ids=<id>` pour relire le rapport ultérieurement.

> ATTENTION : l'étape 5 est le seul point où les eval IDs sont exposés. Si `eval_ids_by_score` est absent (champ non requis) ou non parsable, on n'a **aucun autre moyen** de retrouver les évaluations individuelles du job. Vérifier ce champ et alerter s'il manque.

##### Ce que l'eval ne dit pas, et qui compte pour le contrôle du fil

L'eval note l'agent sur des scénarios simulés. Rien dans cette API ne permet de :

- Vérifier à quelles audiences l'agent répond ou ne répond pas.
- Tester le passage de main à un humain autrement qu'indirectement, en écrivant un `success_criteria` qui l'exige. Or on ne peut pas créer de cas de test par API : ce critère doit donc préexister.
- Reprendre la main sur un fil réel. Cela relève de l'API Thread Control, pas de l'eval.

Ce que l'eval apporte au produit, concrètement : une mesure répétable, avant chaque changement de configuration, du comportement de l'agent sur les scénarios d'escalade déjà définis. Le pattern à construire dans mba.messagingme.app est le run de non-régression, déclenché après toute modification de la base de connaissance ou des règles, avec comparaison au score du run précédent stocké chez nous.

---

#### Delete Agent

##### `DELETE /` : supprimer l'agent d'un numéro

`operationId` : `deleteAgent`. Tag : `Business AI`.

```
DELETE https://api.facebook.com/{entity_id}/delete_agent/
Authorization: Bearer <token>
X-API-Version: 2.0.0
```

Le serveur OpenAPI est `https://api.facebook.com/{entity_id}/delete_agent` et le chemin déclaré est `/`. L'URL effective est donc la concaténation des deux.

> ATTENTION : la concaténation produit un slash final. La doc ne précise pas si `.../delete_agent` sans slash est équivalent à `.../delete_agent/`. Sur une opération destructrice, ne pas tester deux formes au hasard : figer une URL unique dans le client, la vérifier une fois en environnement de test, et ne plus la toucher.

**Paramètre de chemin** :

| Nom | Type | Requis | Description |
|-----|------|--------|-------------|
| `entity_id` | string | oui | Le WhatsApp Business Phone Number ID de l'agent |

**En-tête** : `X-API-Version: 2.0.0` (enum `2.0.0`, non requis).

**Aucun paramètre de requête. Aucun corps de requête.**

> ATTENTION : il n'y a **aucun mécanisme de confirmation dans l'API**. Pas de champ `confirm`, pas de token de double validation, pas de mode `dry_run`, pas de suppression différée. Un seul appel HTTP bien formé détruit la configuration. Le garde-fou doit donc être **entièrement côté mba.messagingme.app** : confirmation explicite dans l'UI par saisie du numéro, restriction RBAC aux administrateurs, journalisation de l'auteur et de l'horodatage avant l'appel.

> ATTENTION : le seul paramètre est `entity_id`, dans le chemin. Une erreur de variable dans le client (mauvais numéro pour le bon client, ou numéro d'un autre tenant) supprime silencieusement le mauvais agent, sans que la requête paraisse anormale. Valider `entity_id` contre le tenant authentifié **avant** de construire l'URL, jamais après.

##### Ce que la suppression détruit

D'après la description officielle : l'appel retire l'agent Meta Business du numéro WhatsApp indiqué, supprime la configuration de l'agent, et **quand le dernier agent du compte est retiré, déconnecte l'intégration**.

Deux niveaux d'effet, donc, et le second est beaucoup plus grave que le premier :

1. **Suppression d'un agent parmi d'autres** : le numéro visé perd son agent. Les autres numéros du compte continuent.
2. **Suppression du dernier agent du compte** : en plus de la suppression, **l'intégration entière est déconnectée**.

> ATTENTION : c'est le piège central de cet endpoint. Rien dans la requête ne distingue les deux cas, et **rien dans la réponse ne signale lequel s'est produit**. Le schéma de réponse ne contient qu'un champ, `deleted_agent_id`. Il n'existe aucun `integration_disconnected: true`. L'appelant qui supprime le dernier agent apprend qu'il a déconnecté l'intégration seulement en constatant que le reste ne marche plus.

> ATTENTION : conséquence obligatoire pour la console. Avant tout appel, **compter les agents restants sur le compte** et, si celui qu'on s'apprête à supprimer est le dernier, afficher un avertissement d'un autre niveau : ce n'est plus « retirer un agent », c'est « déconnecter l'intégration Meta Business Agent ». La doc ne dit pas ce que « disconnects the integration » implique exactement, ni ce qu'il faut refaire pour se reconnecter. Il faut présumer un re-onboarding complet (éligibilité, allowlist, onboarding, reconfiguration de la connaissance, des connecteurs et des règles), donc plusieurs heures ou jours, dépendant de validations côté Meta.

##### Irréversibilité

Il n'existe, dans la surface v2.0.0, **aucun endpoint d'annulation, de restauration, ni de corbeille**. Pas de `POST /restore_agent`, pas de champ `deleted_at` permettant une récupération dans un délai de grâce, pas de période de rétention documentée. La suppression doit être considérée comme définitive et immédiate.

La doc ne dit rien non plus sur :

- Le devenir de la base de connaissance (FAQ, fichiers, sites, informations métier) attachée à l'agent supprimé : détruite avec lui, ou conservée et rattachable à un futur agent ? Non documenté.
- Le devenir des cas d'évaluation, des évaluations et des rapports de l'entité supprimée. Non documenté. Un `GET /details` sur des eval IDs d'un agent supprimé peut très bien renvoyer 200 avec un tableau vide, sans erreur.
- Le devenir des conversations en cours au moment de la suppression, et notamment des fils sous contrôle humain.

> ATTENTION : parce que la restauration est impossible et que la persistance de la configuration n'est pas garantie, mba.messagingme.app doit **exporter et archiver la configuration complète de l'agent dans notre base juste avant l'appel DELETE**. C'est notre seule assurance : si Meta ne conserve rien, notre archive est le seul moyen de reconstruire l'agent à l'identique. Cet export doit être une étape bloquante du flux de suppression, pas une option.

##### `BizAIOmniChannelDeleteAgentResponse` (réponse 200)

La réponse 200 est intitulée, dans la spec, **`Agent deleted successfully`**.

| Champ | Type | Requis | Description |
|-------|------|--------|-------------|
| `deleted_agent_id` | string | **non** | Nullable. ID de la configuration d'agent retirée, ou `null` s'il n'y avait rien à retirer |

C'est tout. Un seul champ, ni requis, ni garanti non nul.

> ATTENTION : **un 200 ne prouve pas qu'une suppression a eu lieu**, et c'est une contradiction interne à la spec elle-même. Le libellé officiel du 200 affirme `Agent deleted successfully`, alors que la description du seul champ de ce même 200 dit l'inverse : `deleted_agent_id` vaut `null` « s'il n'y avait rien à retirer ». Le titre de la réponse et la sémantique du champ ne disent pas la même chose. C'est précisément cette contradiction qui impose de ne jamais se fier au code HTTP seul. Un 200 avec `deleted_agent_id: null` signifie « rien n'a été supprimé, il n'y avait pas d'agent », quoi qu'en dise l'intitulé. L'endpoint est idempotent et ne renvoie pas d'erreur sur un numéro déjà nettoyé. La règle de lecture est la suivante.
>
> - 200 avec `deleted_agent_id` non vide : un agent a bien été retiré, et cet ID est à journaliser.
> - 200 avec `deleted_agent_id: null` : aucun agent n'existait sur ce numéro. Message à afficher : « aucun agent à supprimer sur ce numéro », pas « suppression réussie ». Sinon on masque une erreur de ciblage (mauvais `entity_id`) derrière un succès apparent.
> - 200 sans le champ `deleted_agent_id` du tout : le champ n'est pas requis, ce cas est autorisé par le schéma. Le traiter comme le cas `null`, et non comme un succès.

> ATTENTION : cette ambiguïté a une conséquence sur les retries. L'endpoint étant idempotent et ne signalant pas la différence par un code d'erreur, un retry après timeout réseau renverra très probablement 200 avec `null`, alors que la première tentative a peut-être réussi. Ne pas en conclure que la suppression a échoué. Journaliser la tentative **avant** l'appel, et considérer une suppression comme confirmée dès qu'un `deleted_agent_id` non nul a été observé une fois.

**Codes d'erreur documentés** : 400 (`Bad Request` / `Invalid parameters`), 401 (`Unauthorized`), 403 (`Forbidden` / `The caller is not permitted to delete the agent`), 429 (`Too Many Requests` / `Rate limit exceeded`), 500 (`Internal Server Error`), plus la réponse `default` de type `StandardError`.

> ATTENTION : **il n'y a pas de 404 documenté** sur cet endpoint, contrairement à `GET /cases` et `GET /run` de l'API Eval. Un `entity_id` inexistant ne remontera donc probablement pas en 404 mais en 400, en 403, ou en 200 avec `deleted_agent_id: null`. Ne pas écrire de branche `if (status === 404) { agent introuvable }` : elle ne se déclenchera jamais et le cas réel tombera dans la branche succès.

> ATTENTION : le 429 est documenté ici comme ailleurs, mais aucun quota, aucune fenêtre et aucun en-tête de rate limit ne sont spécifiés dans la doc. Sur une opération destructrice, ne pas retenter automatiquement un 429 en boucle. Remonter l'erreur à l'utilisateur et exiger une action manuelle.

##### Suppression et contrôle du fil : ne pas confondre les deux outils

Point de cadrage produit, à garder net dans l'interface.

`DELETE /delete_agent` n'est **pas** un bouton « pause » ni « reprendre la main ». C'est une destruction de configuration, potentiellement une déconnexion d'intégration, et elle est irréversible. Le besoin quotidien du client (« l'agent ne doit pas répondre à celui-ci », « je reprends ce fil ») relève de l'API Thread Control et des réglages d'agent, pas de la suppression.

Dans la console, ces deux actions ne doivent jamais se ressembler visuellement ni cohabiter dans le même menu. La suppression appartient à un écran d'administration séparé, derrière une confirmation forte, avec l'archivage préalable de la configuration comme étape obligatoire.

---

<a id="8-incertitudes"></a>

## 8. Ce que la doc ne dit pas

Les trous relevés chapitre par chapitre. Ils ne sont **pas** comblés par des suppositions : chacun
devra être observé en conditions réelles le jour où MBA s'ouvre. Un point marqué ici ne doit jamais
servir de base à un engagement client.

### Onboarding : éligibilité, activation, réglages, allowlist (37)

- Rate limits : aucun seuil, aucune fenetre, aucun en-tete Retry-After documente sur les 429, alors que l'allowlist impose des appels unitaires en boucle. A mesurer sur un import reel de plusieurs dizaines de numeros.
- Plafond de l'allowlist : aucune taille maximale documentee. Tester jusqu'ou le POST accepte des entrees avant de basculer en 400.
- Doublons dans l'allowlist : rien ne dit si un POST du meme numero cree une seconde entree, renvoie l'existante ou echoue. Aucun 409 declare. A tester.
- PUT settings partiel : le corps est requis mais aucun champ n'est requis, et le devenir des champs omis (defaut, null, conserve) n'est pas documente. A tester en envoyant un PUT amputes de handoff, followup et ai_audience, puis en relisant.
- Comportement create-or-fetch du PUT sans agent_id : 'fetch' suggere que l'appel peut ne rien ecrire. A verifier, sinon toujours passer agent_id.
- Idempotence de POST agent_onboarding : un second appel sur un entity_id deja onboarde cree-t-il un nouvel agent, renvoie-t-il le meme agent_id, ou echoue-t-il.
- Fin des jobs asynchrones d'onboarding : aucun statut, aucun endpoint de suivi, aucun webhook de completion. Comment savoir que l'agent est reellement pret, et est-il configurable avant.
- GET settings avant onboarding : tableau vide ou 404, non precise.
- Lien entre handoff.enabled et le controle du fil (primary responder / standby / messaging_handovers). Rien ne dit si activer le handoff transfere le controle a l'app tierce ni sur quel webhook la suite arrive. Point le plus critique pour le produit.
- Declencheur du handoff : intention, mot-cle, echec de reponse. Non documente, et apparemment non configurable via cette API.
- Fils orphelins apres rollout.enabled = false puis true : que voit le consommateur au moment de la coupure, et sur quel webhook (messages ou standby) arrivent ensuite les messages de ces fils.
- Passage de EVERYONE a ALLOWLISTED_ONLY : effet sur les conversations deja en cours avec des numeros non allowlistes.
- Numero non allowliste qui ecrit quand ai_audience = ALLOWLISTED_ONLY : silence, message automatique, ou routage vers l'app. Non documente, determinant pour un pilote.
- Followup : nombre de relances (une seule ou repetees), interaction avec la fenetre de 24 h WhatsApp, consommation d'un template ou d'un message de session. Priorite entre enabled=false et followup_interval_in_seconds=0 en cas de contradiction.
- Contraintes sur handoff.message et followup.message : longueur maximale, langue, variables. Aucune indiquee.
- X-API-Version absent : quelle version est appliquee par defaut cote Meta. Non documente.
- Eligibilite : aucun motif de refus renvoye, pas de distinction entre pays non supporte, vertical non supporte et ToS non acceptes. Frequence de rafraichissement et mise en cache inconnues, pas de webhook signalant un passage a eligible.
- Acceptation des ToS Meta Business Agent : aucun endpoint pour la lire ou la declencher, alors que les appels API sont rejetes tant qu'elle manque. Verifier a quoi ressemble concretement le rejet (code et detail) pour pouvoir l'expliquer a l'utilisateur.
- Pagination du GET allowlist : aucun parametre ni enveloppe. Comportement au-dela d'un certain nombre d'entrees inconnu.
- Canaux autres que whatsapp dans l'enum channel : aucune indication sur la facon d'obtenir un entity_id valide, ni sur le comportement de l'appel. ai_audience est explicitement null hors WhatsApp.
- Ce que renvoie un appel effectue hors sequence (settings avant onboarding, allowlist avant onboarding) : la correction impose de ne rien affirmer, mais la console a besoin de savoir si c'est un 404, un 400 ou un succes silencieux. A tester des le premier numero pilote.
- Si l'absence de X-API-Version fait basculer sur une version par defaut differente de 2.0.0, et laquelle. Aucun element documentaire, a observer en comparant deux appels identiques avec et sans l'en-tete.
- Comportement reel du PUT settings sans agent_id (le fameux create-or-fetch) : cree-t-il, met-il a jour, ou se contente-t-il de renvoyer l'existant sans ecrire.
- Sort des champs omis dans un PUT partiel : remis au defaut, mis a null, ou conserves. A tester en envoyant volontairement un corps ampute de handoff sur un agent de test.
- Idempotence du POST agent_onboarding sur un entity_id deja onboarde.
- Comportement en cas de doublon sur POST allowlist, et plafond reel du nombre d'entrees.
- Seuil de rate limit et presence ou non d'un en-tete Retry-After sur les 429.
- Lien effectif entre handoff.enabled et le controle de fil : est-ce que MBA passe le controle a l'app tierce, et sur quel webhook la suite arrive (messages ou standby). Point le plus determinant pour la console.
- Ce qui arrive aux conversations en cours quand rollout.enabled passe a false, et ou elles atterrissent (messages, standby, ou nulle part).
- Comportement quand un numero non allowliste ecrit alors que ai_audience = ALLOWLISTED_ONLY : silence, message, ou routage vers l'app.
- Effet d'un passage de EVERYONE a ALLOWLISTED_ONLY sur les fils deja ouverts avec des numeros non allowlistes.
- Nombre de relances followup (une seule ou repetees), interaction avec la fenetre de 24 h WhatsApp, et si l'envoi consomme un template ou un message de session.
- Contraintes reelles sur handoff.message et followup.message (longueur max, langue, variables).
- Fraicheur et mise en cache du resultat de agent_eligibility, et existence eventuelle d'un webhook signalant un passage a eligible.
- Duree typique des jobs asynchrones d'onboarding, et si l'agent est configurable avant leur fin.
- Pagination de GET allowlist au-dela d'un certain volume : rien n'est documente, il faut mesurer a partir de quelle taille la reponse se tronque, si elle se tronque.
- Verification a faire sur delete_agent : la difference d'autorisation (permission exigee sans alternative capability) est relevee dans la spec, mais son effet pratique avec un token portant les deux n'a pas ete teste.

### Contrôle du fil : thread control, webhooks standby et messaging_handovers (29)

- Forme du payload du webhook `standby` : totalement absente de la doc. Enveloppe, champs, présence des messages sortants de l'agent, discriminant auteur (agent contre consommateur), présence des accusés de livraison et de lecture. À capturer sur le numéro cobaye avant d'écrire le parseur.
- Forme du payload du webhook `messaging_handovers` : aucune description. Nom du champ, identification de la conversation, désignation de l'ancien et du nouveau détenteur, raison, horodatage. C'est la source de vérité de la machine à états, on ne peut pas la coder à l'aveugle.
- Lien entre le réglage `handoff` des Agent Settings (enabled + message) et le thread control réel : un handoff décidé par l'agent libère-t-il le contrôle vers notre app, ou affiche-t-il seulement le message au consommateur en gardant le contrôle ? Point le plus critique pour le produit. Test : activer handoff avec un message reconnaissable, provoquer une escalade, observer sur quel champ arrive le message consommateur suivant et si un `messaging_handovers` est émis.
- Statut réel de `action: "pass"` : la valeur est dans l'enum donc elle passe la validation de schéma, mais la spec la dit réservée pour usage futur alors que Get Started la recommande. Rejet applicatif avec erreur, ou no-op silencieux qui laisse la conversation orpheline ? À tester explicitement.
- Comportement d'un `release` alors que MBA détient déjà le contrôle (précondition « you must currently hold thread control » violée) : erreur, no-op, ou 200 trompeur ? Idempotence de deux releases consécutifs également inconnue.
- Codes d'erreur : seul le 200 est documenté, aucun schéma d'erreur. Il faut logger intégralement toute réponse non-200 sur le cobaye pour construire notre propre table (401, 403, 400, 429, 5xx).
- Un envoi de template ou une campagne sortante prend-il le contrôle du fil au même titre qu'un message de session ? Si oui, une campagne de volume couperait MBA sur tous les destinataires jusqu'à release explicite. Déterminant pour la brique campagnes de mba.messagingme.app.
- Absence de timeout automatique du contrôle détenu par l'app : rien dans la doc ne décrit de release par expiration. Si le contrôle n'est jamais rendu (crash, opérateur parti), la conversation semble bloquée indéfiniment avec MBA muet. À confirmer, et à couvrir de toute façon par notre propre garde-fou.
- Absence totale d'endpoint de lecture de l'état du contrôle : aucune resynchronisation possible après un webhook `messaging_handovers` perdu. Confirmer qu'aucun GET n'existe ailleurs dans l'API.
- Quotas et rate limits de l'endpoint thread_control : non documentés. Aucune limite connue sur la fréquence de bascule d'une même conversation ni sur le nombre de conversations simultanément détenues.
- Délai de propagation entre le 200 du release et le retour effectif de MBA comme répondeur, et sort d'un message consommateur arrivant dans cet intervalle.
- Sémantique réelle du bloc `security` (les trois schémas listés dans un même requirement object, rendu en « AND »). Presque certainement un artefact de génération, le Bearer devrait suffire. À confirmer par un appel réel avec le seul en-tête `Authorization`.
- Format exact attendu par le champ `to` : « phone number or WhatsApp ID » sans plus de précision. E.164 avec ou sans `+` ? Et sérialisation de `phone_number_id`, typé `integer` dans le schéma mais exposé comme string partout ailleurs chez Meta.
- Tolérance au slash final sur l'URL (`.../thread_control` contre `.../thread_control/`), le path OpenAPI étant déclaré `/` sous un server URL déjà complet.
- Comportement d'une requête sans `to` ni `recipient` : aucun des deux n'est marqué requis dans le schéma alors qu'au moins un est indispensable. Erreur, no-op, ou effet de bord large ? Ne pas tester en production.
- Interaction du modèle de contrôle avec la fenêtre de service client de 24 h : non abordée par la doc.
- Payload du webhook `standby` : structure d'enveloppe, presence ou non des messages de l'agent dans le meme tableau que ceux du consommateur, discriminant d'auteur, et rattachement des `statuses` (delivered/read). Rien n'est documente, tout doit etre observe sur le numero cobaye avant d'ecrire le parseur.
- Payload du webhook `messaging_handovers` : nom du champ, cle d'identification de la conversation, designation de l'ancien et du nouveau detenteur, raison, horodatage. Sans ces elements, la machine a etats du controle ne peut etre ecrite que par retro-ingenierie.
- Effet d'un envoi de template ou d'une campagne sortante sur le thread control : si l'envoi prend le controle, une campagne coupe MBA sur tous les destinataires jusqu'a release explicite. Point bloquant a lever avant toute campagne de volume.
- Lien entre `handoff.enabled` (Agent Settings) et le transfert effectif du thread control : transfert reel vers l'app, ou simple affichage du `message` au consommateur avec MBA qui garde la main. C'est le coeur de valeur du produit.
- Comportement de `followup` quand notre app detient le controle : le message de relance par inactivite reste-t-il arme et risque-t-il de s'inserer au milieu d'une conversation pilotee par un conseiller.
- Comportements hors contrat : release alors que MBA detient deja le controle, envoi de `action: "pass"`, requete sans `to` ni `recipient`, deux releases consecutifs (idempotence). Aucun n'est documente et le seul code de reponse decrit est 200.
- Forme reelle des erreurs de l'endpoint : enveloppe Graph `{"error": {...}}` ou schema `StandardError` du reste du corpus. L'hote (`api.facebook.com`) et la version (1.0.0) different du reste des endpoints MBA, donc rien ne garantit l'alignement.
- Details d'URL : slash final tolere ou non sur `/thread_control`, et serialisation attendue de `phone_number_id` (declare `integer`, expose ailleurs comme chaine).
- Format exact attendu par `to` : E.164 avec ou sans `+`, ou WhatsApp ID. A valider sur le numero cobaye.
- Delai entre le release et le retour effectif de MBA comme repondeur, et destinataire d'un message consommateur ecrit pendant cet intervalle.
- Quotas : aucun rate limit, aucune limite de frequence de bascule par conversation, aucune limite du nombre de fils simultanement detenus par l'app.
- Routage des messages d'un consommateur hors allowlist quand `ai_audience` vaut `ALLOWLISTED_ONLY` : champ `messages` ou champ `standby` avec MBA silencieux.
- Les deux erreurs relevees en relecture ont ete appliquees telles quelles (resume `info.summary` complete, et `deux pieges d'URL` corrige en `trois`), toutes deux verifiees directement contre le YAML source `meta-business-agent_reference_operate_thread-control-cloud-api_v1.0.0.openapi.yaml` : aucune contestation.

### Connaissance : business info, FAQ, sites web, fichiers (36)

- Sémantique exacte du PUT sur business_info : un champ omis est-il effacé (remplacement strict) ou conservé (merge) ? La doc dit à la fois 'fully replace' et 'All provided fields will overwrite existing values', ce qui n'est pas la même chose. À tester en envoyant un PUT partiel après un PUT complet.
- Effet de contact_info: null dans un PUT business_info : efface-t-il le bloc contact, ou est-il ignoré ? Le schéma est nullable mais le comportement n'est pas décrit.
- Casse réelle de crawl_status : la description dit 'pending, in_progress, completed, failed' en minuscules, l'exemple du même champ dit 'COMPLETED'. Il faut relever les valeurs effectivement renvoyées, et vérifier si d'autres valeurs existent (le champ n'a pas d'enum et la liste est donnée en 'e.g.').
- Machine à états du crawl : transitions possibles, réessai automatique après failed, existence et fréquence d'un recrawl périodique. Rien n'est documenté et last_crawled_at suggère pourtant des crawls répétés.
- Existence d'un moyen de déclencher un recrawl : est-ce qu'un PUT avec la même URL relance le crawl ? Est-ce que DELETE puis POST est le seul chemin ? Aucun endpoint dédié n'existe.
- Raison d'un échec de crawl : aucune information n'est exposée. Vérifier si un champ non documenté remonte quand même dans la réponse réelle (les specs Meta sont souvent incomplètes en aval).
- Délai typique entre POST d'un site et crawl_status terminal, et fréquence de polling tolérée sans déclencher un 429.
- Délai de propagation entre une écriture réussie (200/201) et le moment où l'agent utilise réellement l'information en conversation, pour les quatre sources. Aucune des specs ne l'aborde.
- Statut d'indexation des fichiers : aucun champ ne l'expose. Vérifier si la réponse réelle du POST ou du GET /{file_id} contient des champs non documentés (status, size, created_at), sinon il faut acter qu'un PDF scanné sans couche texte échoue silencieusement.
- Ce qui est réellement extrait d'un .png, .jpg ou .jpeg : OCR, description visuelle, ou rien du tout. La doc autorise ces formats sans dire ce qu'elle en fait.
- Comment vérifier et activer l'extraction CSV et XLSX sur l'asset WhatsApp, et quel code ou message d'erreur exact remonte quand elle est désactivée.
- Quotas et limites de nombre non documentés : nombre maximal de FAQ (seule une recommandation floue de 'quelques centaines' existe, sans code d'erreur), nombre maximal de sites, nombre maximal de fichiers, taille cumulée de la base de connaissance.
- Limites de longueur des champs texte : question, answer, et les six champs de business_info. Aucune n'est documentée. Il faut trouver empiriquement où tombe le 400.
- Limites du champ metadata des FAQ : nombre de clés, longueur des clés et des valeurs, caractères autorisés. Et surtout : est-ce que metadata est purement inerte, ou est-ce que Meta s'en sert d'une façon ou d'une autre dans la récupération ?
- Comportement du PUT sur une FAQ quand metadata est omis : les métadonnées existantes sont-elles effacées ?
- Unicité et déduplication : peut-on créer deux FAQ identiques, ajouter deux fois la même URL, uploader deux fichiers de même file_name ? Et dans ce dernier cas, écrasement ou coexistence ?
- Purge effective après DELETE : le contenu déjà indexé d'un site ou d'un fichier disparaît-il immédiatement de ce que l'agent peut citer, ou reste-t-il accessible un temps ? Point critique pour un retrait d'urgence.
- Pagination implicite des trois endpoints de liste : aucun paramètre n'est documenté, mais rien ne garantit que la réponse ne soit pas tronquée au-delà d'un certain volume. À tester avec plusieurs centaines de FAQ avant d'écrire toute logique de réconciliation.
- Politique de rate limiting : quota, fenêtre, et présence éventuelle d'un en-tête Retry-After ou X-Business-Use-Case-Usage sur les 429. Rien n'est documenté, ce qui conditionne la stratégie d'import en lot.
- Valeurs possibles du champ type de StandardError, et existence de sous-codes permettant de distinguer les causes d'un 400. Sans cela, quota atteint et URL invalide sont indistinguables par programme.
- Présence ou absence réelle d'un 403 sur business_info, faq et files : seule l'API websites le documente, mais la réponse 'default' laisse la porte ouverte.
- Le 404 de getBusinessInfo : la spec le documente, mais ne dit pas ce qui le declenche. Entite (Phone Number ID) inconnue ou non habilitee Business AI ? Business info jamais configuree malgre la phrase sur les valeurs vides ? A lever par un GET sur un numero vierge ET sur un numero inexistant, et noter la difference de 'detail'.
- Le 403 n'est documente que sur l'API websites. Reste a verifier s'il remonte quand meme sur business_info, faq et files (via la reponse 'default') en appelant avec un token qui n'a pas acces a l'entite, ou si Meta renvoie 404 dans ce cas (masquage d'existence).
- PUT business_info : sort exact d'un champ omis (efface ou conserve). Et effet de 'contact_info: null' : efface le bloc ou est ignore.
- PUT faq : omettre 'metadata' efface-t-il les metadonnees existantes ?
- Casse reelle de crawl_status renvoyee par l'API (minuscules comme la description, majuscules comme l'exemple, ou autre), et liste reelle des valeurs possibles au-dela des quatre citees en 'e.g.'.
- Existence et frequence d'un recrawl automatique des sites, et effet reel d'un PUT avec la meme URL (declenche-t-il un recrawl ?).
- Sort du contenu deja indexe apres DELETE d'un site ou d'un fichier, et apres changement d'URL par PUT : purge immediate, purge differee, ou persistance.
- Delai de propagation entre un 2xx et le moment ou l'agent utilise reellement l'information, pour les quatre sources. Non documente, seulement observable par test de conversation.
- Comment verifier et activer l'extraction CSV et XLSX sur l'asset WhatsApp, et quel code d'erreur remonte quand elle est desactivee.
- Ce qui est reellement extrait des images (.png/.jpg/.jpeg) : OCR, description visuelle, ou rien.
- Comportement en cas de doublon de file_name a l'upload (ecrasement ou coexistence), et unicite eventuelle des URLs de sites.
- Existence d'une pagination implicite sur les GET de liste (faq, websites, files) au-dela d'un certain volume : rien n'est documente, mais rien ne garantit non plus que la liste soit complete a 500 entrees.
- Quotas reels : nombre max de FAQ, de sites, de fichiers par entite, taille cumulee, et limites de caracteres sur question/answer et sur les champs business_info. A borner empiriquement en cherchant ou tombe le 400.
- Politique de rate limiting (appels/heure, par entite ou par token) et presence eventuelle d'en-tetes non documentes (Retry-After, X-Business-Use-Case-Usage) dans une reponse 429 reelle.
- Comportement reel si X-API-Version est omis : version par defaut appliquee, ou rejet.

### Skills : instructions système, ton, priorités (15)

- Nombre maximum de skills par entite ou par agent : totalement absent de la doc. Aucune limite de cardinalite, ni budget cumule de caracteres sur l'ensemble des skills. A decouvrir en poussant des skills jusqu'a obtenir un 400 ou un 429 a la creation.
- Semantique exacte de PUT : remplacement complet ou fusion partielle ? La spec ne le dit pas. Tester en envoyant un corps ne contenant que 'skill' et verifier si 'title' et 'description' survivent.
- Comportement en cas de depassement des limites de longueur (64 / 1024 / 20000) : rejet 400, troncature silencieuse, ou acceptation puis ignorance a l'inference ? Aucune contrainte maxLength ni pattern n'est declaree dans le schema, donc la validation serveur est incertaine.
- Validation reelle du format de 'title' (minuscules, chiffres, tirets) : l'exemple de reponse 'Greeting Skill' contredit la contrainte de requete, ce qui suggere que le serveur ne valide pas. A confirmer.
- URL de collection : est-ce que '.../skills' sans slash final fonctionne, ou faut-il imperativement '.../skills/' ? La spec ne declare que le chemin '/'.
- Comportement par defaut quand l'en-tete X-API-Version est absent : quelle version est appliquee ? Non documente.
- Ordre de retour du GET / : la liste est-elle triee (par created_at, par ordre d'application) ? Non documente. Et existe-t-il une troncature au-dela d'un certain nombre, puisqu'aucune pagination n'est exposee ?
- Quotas de debit : aucun chiffre, aucune fenetre, aucun en-tete de quota (Retry-After, X-RateLimit-*) documente pour le 429.
- Comment le champ 'channel' est-il determine a la creation ? Aucun parametre d'entree ne le porte, alors que la spec parle de 'the given channel'. Peut-on creer une skill pour un canal autre que whatsapp via cet endpoint numero-WhatsApp ?
- Le champ 'metadata' est en lecture seule de fait (absent du schema de requete) : y a-t-il un autre moyen de l'ecrire, et Meta y met-il des cles ? Aucune cle documentee.
- Comment desactiver temporairement une skill sans la supprimer ? Aucun champ enabled/status/version. Le cycle delete/recreate est-il la seule voie, et a-t-il un cout (perte de created_at, nouvel id) acceptable ?
- Delai de propagation d'un create/update/delete jusqu'a l'agent en production : instantane ou differe ? Non documente, et critique pour un produit qui promet du controle.
- Handoff humain : cette API n'expose aucun mecanisme. Reste a determiner, hors de ce chapitre, quel signal (webhook, evenement de conversation) permet a mba de detecter et d'executer une reprise en main.
- Comportement du champ 'agent_id' quand de nouveaux settings sont crees cote Meta : les skills des anciens settings restent-elles actives, ou seuls les settings les plus recents s'appliquent a l'agent en production ?
- Format d'erreur en cas de rejet amont (passerelle, token invalide au niveau plateforme) : StandardError ou format Graph historique ? A verifier pour dimensionner le parseur.

### Connecteurs et connector tools : brancher les API du client (42)

- Structure exacte attendue de `input` sur POST /{tool_id}/run : map plate des noms canoniques, ou objet segmenté par path_parameters / query_parameters / headers / body ? L'unique exemple ({"query": "search for product"}) ne tranche pas. Premier test a faire.
- Contenu et format reel des trois macros : WHATSAPP_PHONE_NUMBER (E.164 avec ou sans +, avec ou sans separateurs), WHATSAPP_IDENTITY_HASH (algorithme, stabilite dans le temps, portee par utilisateur ou par conversation), WHATSAPP_CURRENT_STATUS_ID (a quoi ca refere). Zero description dans la doc, zero exemple de valeur.
- Les macros sont-elles resolues lors d'un run manuel, hors conversation WhatsApp ? Si non, tout tool dependant d'une macro se teste differemment de son execution reelle.
- Forme des sous-schemas en LECTURE : GET /{tool_id} renvoie-t-il properties et items sous la meme forme serialisee en chaine qu'a l'ecriture, ou en objets natifs ? Le mot 'roundtripped' le suggere sans le garantir. Le desserialiseur doit etre tolerant aux deux.
- Les secrets sont-ils relisibles ? La doc ne dit pas si client_secret et les value des ApiKeyParam sont renvoyes en clair, masques, ou omis dans auth_config des reponses. Seule la cle privee mTLS est explicitement non exposee.
- Comportement du PUT sur les champs optionnels omis (auth_config, requires_certificate, user_auth_injection_config cote connecteur) : effaces ou conserves ? Aucune indication.
- Cascade a la suppression : DELETE /{connector_id} supprime-t-il les tools rattaches, ou les laisse-t-il orphelins ?
- Que fait l'API si auth_type vaut OAUTH2, BASIC ou CUSTOM (valeurs presentes dans l'enum mais documentees comme non supportees) : rejet en 400 a la creation, ou acceptation puis echec au moment de l'appel du tool ?
- Transitions de connection_status : quel evenement fait passer de PENDING_OAUTH a ACTIVE, sous quel delai apres un upsert, et existe-t-il un test de connexion ? Le statut PENDING_OAUTH lui-meme est inexplique alors que le flow OAUTH2 utilisateur est annonce comme non supporte.
- Cycle de vie du token utilisateur : duree de stockage, portee (par conversation ou par utilisateur), declenchement automatique du tool refresh a l'expiration, et comportement d'un tool user_auth_required:true quand aucun token n'est stocke.
- Liste complete des failure_code_name : seul TRANSPORT_ERROR est cite en exemple, l'enum n'existe pas dans le schema.
- Delai d'ingestion des logs : time_window_seconds peut etre plus court que la plage demandee, mais le retard typique n'est pas chiffre.
- Quotas et limites : nombre max de connecteurs par entite, de tools par connecteur, taille de payload, longueur des descriptions, profondeur d'imbrication des BodyNode, budget d'appels avant 429, taille max d'un PEM. Rien de chiffre nulle part.
- Timeout de l'appel sortant vers l'API du client, politique de retry, circuit breaker : non documentes.
- Unicite et contraintes de format du champ name d'un tool (regex, longueur, casse, collision au sein d'un connecteur).
- Regle de jointure exacte entre base_url du connecteur et path du tool (gestion du slash duplique ou manquant).
- Interaction entre les body_params d'une auth API_KEY et un tool en GET sans corps.
- Acceptation d'un scopes_to_request vide pour une API OAuth sans scopes.
- Montage HTTP Basic via auth_type API_KEY avec un header Authorization et prefix 'Basic ' : deduction non documentee, a valider.
- Structure exacte attendue par le champ `input` de `POST /{tool_id}/run` : map plate des noms canoniques, ou objet segmente par `path_parameters` / `query_parameters` / `headers` / `body`. La spec ne l'enonce pas, seul l'exemple `{"query": "search for product"}` oriente. Premier test a faire.
- Resolution ou non des `binding` de type `macro` lors d'un `run` manuel, hors conversation WhatsApp. Un tool dependant de `WHATSAPP_PHONE_NUMBER` peut se comporter differemment en test et en production.
- Contenu et format reel des trois macros : `WHATSAPP_PHONE_NUMBER` (E.164 avec ou sans `+` ?), `WHATSAPP_IDENTITY_HASH` (algorithme, stabilite dans le temps, portee), `WHATSAPP_CURRENT_STATUS_ID` (ce qu'il designe). Aucune description ni exemple dans la spec.
- Forme des sous-schemas `properties` / `items` en LECTURE (`GET /{tool_id}`) : chaines JSON serialisees comme a l'ecriture, ou objets natifs ? Le mot « roundtripped » le suggere sans le garantir. Le deserialiseur doit accepter les deux.
- Comportement de l'API face aux `auth_type` presents dans l'enum mais non supportes (`OAUTH2`, `BASIC`, `CUSTOM`) : 400 immediat a la creation, ou acceptation puis echec au moment de l'appel du tool ?
- Faisabilite du contournement HTTP Basic via `auth_type: API_KEY` + header `Authorization` avec `prefix: "Basic "` et `value` en base64. Deduction non documentee, a tester.
- Comportement des champs optionnels omis lors d'un `PUT` (connecteur comme tool) : `auth_config`, `requires_certificate`, `user_auth_injection_config`, `user_auth_action_config` sont-ils effaces ou conserves ?
- Sort des tools rattaches lors d'un `DELETE /{connector_id}` : cascade ou orphelins.
- Exposition des secrets en reponse (`client_secret`, `value` d'une cle API dans `auth_config`) : en clair, masques, ou omis. Seul le statut des champs mTLS est explicite (`client_certificate` et `ca_certificate` publics, cle privee jamais renvoyee).
- Declencheurs et delais des transitions de `connection_status` (`PENDING_OAUTH`, `ACTIVE`, `EXPIRED`, `ERROR`), et sens de `PENDING_OAUTH` alors que le flow `OAUTH2` utilisateur est declare non supporte. Aucun endpoint de test de connexion documente.
- Liste complete des valeurs de `failure_code_name` dans les logs : seul `TRANSPORT_ERROR` est donne en exemple, ce n'est pas un enum.
- Delai d'ingestion des logs, implique par `time_window_seconds` (fenetre reellement couverte plus courte que la plage demandee) mais jamais chiffre.
- Stockage du token utilisateur final : duree, portee (par conversation ou par utilisateur), chiffrement, declenchement automatique du tool `refresh` a l'expiration, et comportement d'un tool `user_auth_required: true` quand aucun token n'est stocke.
- Statut de la valeur `path` dans l'enum `user_auth_injection_config.location` : presente dans l'enum, absente de la description. A ne pas utiliser sans test.
- Acceptation d'un tableau vide pour `scopes_to_request`, qui est `required`, dans le cas d'une API sans scopes.
- Comportement d'un connecteur portant des `body_params` (API key) quand un tool en `GET` sans corps y est rattache.
- Granularite du remplacement lors d'un `upsertApiKey` : remplacement complet du bloc `api_key_config` (hypothese retenue) ou fusion partielle par sous-champ (`headers` / `query_params` / `body_params`).
- Regle exacte de jointure entre `base_url` du connecteur et `path` du tool (slash duplique, slash manquant). Convention deduite des exemples seulement.
- Unicite et contraintes de format du champ `name` d'un tool au sein d'un connecteur (regex, longueur, casse) : non documentees, seuls les exemples en `snake_case` orientent.
- Quotas non publies : nombre de connecteurs par entite, de tools par connecteur, taille de payload, longueur de `description`, profondeur d'imbrication des `BodyNode`, budget d'appels avant 429 et en-tetes de rate limit.
- Timeout de l'appel sortant vers l'API du client, politique de retry et comportement d'un eventuel circuit breaker.
- Version d'API appliquee cote serveur quand l'en-tete `X-API-Version` est absent (il est `required: false` mais l'enum ne contient que `2.0.0`).
- Limite de taille des PEM sur `upsertCertificate`, et comportement face a une cle chiffree (`-----BEGIN ENCRYPTED PRIVATE KEY-----`), qui n'entre dans aucun des trois prefixes acceptes.

### Agent event et agent test (34)

- agent_event et ai_audience : la doc ne dit pas ce qui se passe si l'agent est en ALLOWLISTED_ONLY et que le numero 'to' n'est pas dans l'allowlist. On suppose un status 'skipped' mais rien ne le confirme. Structurant, car notre pattern de controle repose sur une allowlist vide par defaut.
- agent_event et thread_control : la doc ne dit rien de l'interaction. Si notre application detient le controle du fil, un agent_event fait-il parler l'agent quand meme (court-circuitant notre controle), est-il mis en attente, ou skippe ? C'est la question la plus critique du chapitre pour la promesse produit de handoff maitrise.
- agent_event et rollout.enabled=false : un agent desactive traite-t-il quand meme ses evenements, ou les skippe-t-il ? Non documente.
- Difference entre les statuts 'sent' et 'success' : les deux existent dans l'enum, la doc n'explique ni ce qui les distingue ni lequel est terminal. Deux lectures plausibles (sent = intermediaire vers success, ou deux issues terminales distinctes).
- Valeurs possibles de skipped_reason : aucune enumeration, un seul exemple ('no_phone_settings'). C'est pourtant le champ qui dit pourquoi l'agent a refuse d'agir, donc central pour notre produit. A collecter empiriquement en production.
- Valeurs possibles de handoff_reason (agent_test) : aucune enumeration, un seul exemple ('complex_request'). Trou le plus couteux pour un produit dont la valeur est le controle du passage a l'humain.
- Valeurs possibles de no_response_reason : la doc dit 'possible values include ELIGIBILITY_CHECK_FAILED', liste explicitement non exhaustive, et le YAML donne un second exemple 'out_of_scope' avec une casse differente. Casse incoherente entre les deux valeurs connues.
- Valeurs possibles de error_message (agent_event) : non enumerees, un seul exemple ('internal_server_error').
- Conditions dans lesquelles un POST agent_event renvoie 200 SANS agent_event_id : la doc dit 'when one was created' mais ne precise jamais quand aucun n'est cree. Dans ce cas l'evenement devient intracable.
- Quotas et seuils de rate limit : le 429 est documente sur les deux endpoints, aucune limite chiffree, aucune fenetre, aucune indication de scope (par entity_id ? par token ? par app ?). Le polling du GET et l'envoi du POST peuvent se disputer le meme quota.
- Delai de propagation entre le POST agent_event et la disponibilite de l'evenement au GET : non documente. Un 404 immediat apres un POST peut donc etre une latence plutot qu'une absence.
- Aucun webhook de fin de traitement d'un agent_event n'est documente : le polling semble etre la seule voie, mais la doc ne dit pas explicitement qu'aucun webhook n'existe (il pourrait etre documente ailleurs, cote Webhooks WhatsApp).
- Comportement si event.payload n'est pas du JSON valide : la doc dit 'opaque JSON string passed through as-is', sans dire ce que fait l'agent d'une chaine non parsable.
- agent_event sur un 'to' sans conversation existante : la doc ne dit pas si l'evenement peut initier une conversation a froid, ni comment cela s'articule avec la fenetre de 24 h et les templates WhatsApp (jamais evoques dans ces deux specs).
- Canaux supportes : les deux specs ne mentionnent que le WhatsApp Business Phone Number ID. Rien ne dit si agent_event ou agent_test fonctionnent avec un Page ID Facebook ou Instagram.
- Version servie si l'en-tete X-API-Version est omis : l'en-tete est optionnel, l'enum ne contient que '2.0.0', la doc ne dit pas quel comportement s'applique par defaut.
- Longueur maximale de user_msg (agent_test) : non documentee, alors que tous les champs de agent_event sont bornes.
- Duree de vie et nombre maximal de tours d'un conversation_id (agent_test) : non documentes.
- Comportement d'agent_test avec un conversation_id inconnu ou expire : ni 404 ni 400 specifique documente. Creation silencieuse d'une nouvelle conversation, ou erreur ? Les deux ont des consequences opposees sur la validite d'un test multi-tours.
- Effets de bord d'agent_test : la doc ne dit pas explicitement qu'aucun message n'est envoye sur WhatsApp, ni si les conversations de test comptent dans les statistiques ou l'historique de l'agent.
- Execution reelle des connecteurs pendant un agent_test : fortement implique par 'verify skill/connector integrations' mais jamais affirme. Si les connecteurs sont reellement appeles, un test peut declencher des effets de bord dans les systemes tiers du client.
- Cout et facturation d'un appel agent_test : rien dans la doc. On ignore s'il consomme le meme quota que le trafic reel.
- Latence et timeout d'agent_test : endpoint synchrone traversant tout le pipeline de l'agent, aucun timeout ni SLA documente.
- Le handoff observe en mode test correspond-il au handoff de production ? La doc ne dit pas si agent_test tient compte de la configuration handoff de agent_config/settings, ni si le chemin de decision est identique.
- Le champ agent_response est marque requis alors que no_response_reason existe pour le cas ou l'agent n'a pas repondu : contrat contradictoire, on ignore si agent_response arrive vide ou absent dans ce cas.
- Format des horodatages agent_event : '2024-01-15T10:30:00+0000', offset sans deux-points, non accepte par tous les parseurs ISO 8601 stricts. La doc ne garantit pas la stabilite de ce format.
- Absence de 403 sur POST agent_event et sur agent_test alors que le GET agent_event en documente un : on ne peut pas detecter par ces endpoints qu'un entity_id n'est pas habilite.
- Le corpus source (fichiers YAML des specs agent_event / agent_test / thread_control, et les .md du corpus MBA) n'est pas present sur cette machine : recherche par nom de fichier sous C:\Users\julie sans aucun resultat. Je n'ai donc PAS pu verifier moi-meme les corrections du relecteur, je les ai appliquees telles quelles en leur faisant confiance. Les points a re-verifier en priorite contre la source : (a) la base URL et la version 1.0.0 de thread_control, (b) le fait que delete_agent partage bien le regime restreint de thread_control, (c) la liste exacte des endpoints partageant le jeu standard.
- Toutes les affirmations sur le regime d'autorisation de thread_control (« un token qui passe sur thread_control passe forcement sur agent_event ») supposent que Meta traite reellement le 'any of' comme un OU inclusif au moment de l'evaluation, et que la capability n'implique pas la permission. La spec ne le dit pas explicitement : a confirmer par un appel reel avec un token portant uniquement la capability.
- Le double tag de runAgentTest (Agent Config + Business AI) est confirme par le relecteur, mais la consequence que j'en tire (duplication de methode dans un client genere par tag) est une deduction de ma part sur le comportement des generateurs OpenAPI, pas un fait tire de la spec. Le comportement exact depend du generateur retenu.
- L'incoherence `nullable: true` en OpenAPI 3.1.1 est un fait de la spec, mais le comportement precis d'un generateur donne face a ce mot-cle inconnu (ignore silencieusement, avertissement, ou tolerance retrocompatible) varie selon l'outil. A tester sur le generateur qu'on retiendra avant de conclure que le patch manuel est necessaire.
- La spec agent_event se contredit sur l'ordre des statuts (prose vs enum). J'affirme que c'est l'enum machine qui fait foi : c'est la convention normale, mais rien dans le fichier ne le dit. Si un jour la prose et l'enum divergeaient sur les VALEURS et plus seulement sur l'ordre, il faudrait trancher par observation.
- Le membre de phrase « for a specific phone number conversation » du info.summary est le seul indice sur la question de la conversation a froid. Je l'ai presente comme un indice non concluant. Il reste possible qu'il soit purement redactionnel et ne dise rien du comportement reel : seule l'observation (envoyer un agent_event vers un numero n'ayant jamais ecrit) tranchera, et cette observation est prioritaire car elle conditionne l'exposition aux regles de fenetre 24 h et de templates WhatsApp.
- L'usage declare « test knowledge base responses » implique-t-il que la KB reelle du client est interrogee, ou une copie ? La spec ne le precise pas. J'ai retenu la lecture la plus naturelle (KB reelle, etat courant), par symetrie avec le raisonnement sur les connecteurs, mais ce n'est pas ecrit.

### Évaluation et suppression (36)

- Plage reelle des scores : la doc de BizAIComboJobResult annonce une plage 1-5 pour avg_conversation_score et avg_turn_score, mais les exemples valent 0.85 et 0.92 (coherents avec 0-1). BizAIEvalSummaryResponse ne documente aucune plage. Et le champ score de /details est un integer d'exemple 85. Trois echelles apparemment incompatibles : a observer sur un vrai job avant tout affichage en pourcentage ou en note sur 5.
- Format reel de per_turn_labels : declare required, type string, decrit comme 'JSON array of per-turn label integers', illustre par 'GOOD,GOOD,NEEDS_IMPROVEMENT'. Trois formats contradictoires. A observer, ainsi que la liste complete des libelles possibles (GOOD et NEEDS_IMPROVEMENT ne sont pas donnes comme enum).
- Format reel des champs string contenant du JSON (highlights, top_failure_categories, reasons, eval_ids_by_score, custom_success_criteria, transcript) : les exemples du YAML pour highlights et top_failure_categories ne sont PAS du JSON valide. A verifier si le contenu reel est toujours du JSON parsable ou parfois du texte brut.
- Corps du POST /run : le schema BizAIComboRunRequest est un objet vide avec additionalProperties:false, mais le corps est declare required. A verifier si le serveur accepte {} , s'il accepte un corps absent, et s'il rejette effectivement tout champ supplementaire.
- Statut initial renvoye par POST /run : la description dit QUEUED, l'exemple dit RUNNING. A observer.
- Origine des cas de test : aucun endpoint de creation, modification ou suppression n'existe en v2.0.0. Il faut determiner par quel canal les eval cases sont reellement crees (interface Meta, autre API, provisionnement partenaire) avant de promettre quoi que ce soit dans la console.
- Pilotage des insights : la description du POST /run dit que les insights sont calcules 'optionnellement', mais aucun parametre ne permet de le controler. A determiner quelle regle cote Meta declenche ou non le calcul du rapport agrege.
- Nombre maximum d'IDs par requete : le 400 de /details evoque 'too many IDs' sans chiffre, et POST /run ne documente aucune limite sur eval_case_ids. A calibrer empiriquement pour dimensionner les lots.
- Pagination de GET /cases : aucun parametre de pagination ni de filtrage. A verifier si la reponse est tronquee au-dela d'un certain nombre de cas et, si oui, a partir de combien.
- Duree de vie et retention des jobs : aucune duree de conservation d'un job_id, aucun delai d'expiration, aucune duree typique de run, aucune frequence de polling recommandee. A mesurer avant de fixer le backoff du worker.
- Quotas et rate limits : le 429 est documente sur tous les endpoints des deux APIs, mais aucun quota, aucune fenetre de temps et aucun en-tete de rate limit (Retry-After ou equivalent) ne sont specifies.
- Comportement des GET /details et /summary sur des IDs inexistants : pas de 404 documente. A verifier si les IDs inconnus sont silencieusement omis du tableau ou provoquent un 400 global.
- Version appliquee quand X-API-Version est absent : l'en-tete est required:false et la doc ne dit pas quel defaut s'applique.
- URL exacte du DELETE : le serveur est .../delete_agent et le chemin declare est '/', ce qui produit un slash final. Equivalence avec la forme sans slash non documentee, a fixer par un test unique en environnement de test.
- Portee exacte de 'disconnects the integration' au retrait du dernier agent : la doc ne dit ni ce qui est deconnecte precisement, ni ce qu'il faut refaire pour se reconnecter, ni si un re-onboarding complet (eligibilite, allowlist, onboarding) est necessaire.
- Devenir des donnees apres suppression : sort de la base de connaissance (FAQ, fichiers, sites, business info), des connecteurs, des eval cases, des evaluations et des rapports rattaches a l'entite. Non documente. Determine si notre export prealable est un confort ou la seule sauvegarde existante.
- Devenir des conversations en cours au moment de la suppression, en particulier des fils sous controle humain. Non documente.
- Reversibilite : aucun endpoint de restauration ni periode de grace documentes. A confirmer aupres de Meta qu'il n'existe reellement aucun recours, y compris par support.
- Comportement du DELETE sur un entity_id inexistant ou appartenant a un autre compte : pas de 404 documente, donc reponse reelle inconnue (400, 403, ou 200 avec deleted_agent_id null). Determinant pour detecter une erreur de ciblage.
- Difference reelle entre la capability bizai_wa_enterprise_api_3p_access et la permission whatsapp_business_messaging pour l'acces a l'eval, et confirmation que la capability seule ne permet effectivement pas la suppression.
- Plage reelle des scores moyens (avg_conversation_score, avg_turn_score) : la doc annonce 1-5, les exemples valent 0.85 et 0.92 (plage 0-1). Non tranchable sur pieces, a observer sur un vrai job avant toute mise en forme (pourcentage ou note sur 5).
- Echelle du champ score de GET /details (exemple entier 85) par rapport aux scores agreges (nombres 0.85). Trois echelles apparentes coexistent, aucune n'est confirmee.
- Format reel de per_turn_labels : declare string, decrit comme tableau JSON d'entiers, illustre par GOOD,GOOD,NEEDS_IMPROVEMENT. Seule l'observation dira lequel des trois est le vrai, et si l'ensemble des libellees possibles depasse GOOD / NEEDS_IMPROVEMENT.
- Format reel de highlights, top_failure_categories, eval_ids_by_score et transcript : types string annonces porteurs de JSON, mais les exemples de la spec ne sont pas du JSON valide. A verifier si le contenu reel est du JSON, du texte brut, ou variable.
- Plafond chiffre du nombre d'IDs accepte par eval_ids (GET /details) et par eval_case_ids (POST /run) : l'erreur 'too many IDs' existe pour details, aucun chiffre n'est donne nulle part, et rien n'est documente pour /run ni /summary.
- Semantique exacte du 400 de /summary ('must contain at least one valid ID') : contrainte syntaxique (parametre non vide) ou semantique (tous les IDs inconnus -> 400 au lieu d'un 200 avec insights vide) ? Comportement a observer, il differe potentiellement de /details.
- Comportement de /details et /summary sur un ID inexistant : absence silencieuse du tableau, ou erreur ? Aucun 404 documente sur ces deux endpoints.
- Pagination et volumetrie de GET /cases : aucun limit / after / cursor documente, on ignore si la reponse est tronquee au dela d'un certain nombre de cas.
- Valeur de X-API-Version appliquee quand l'en-tete est absent (il est required: false, enum 2.0.0). Defaut serveur non documente.
- Statut initial reellement renvoye par POST /run : description QUEUED, exemple RUNNING, et exemple COMPLETED sur GET /run. Aucune valeur d'exemple n'est contractuelle (les champs status et current_stage sont types string sans enum).
- Liste exhaustive des codes de error.code (SIMULATION_FAILED n'est qu'un exemple) et des valeurs de current_stage au dela de simulation / evaluation / insights / done.
- Duree de retention d'un job, duree de vie du job_id, duree typique d'un run et frequence de polling recommandee : rien de documente. Quotas et fenetres de rate limit (429) non specifies non plus, ni en-tetes associes.
- Equivalence entre .../delete_agent et .../delete_agent/ (le serveur + path '/' produisent un slash final). Non precise, et a ne pas tester au hasard sur une operation destructrice.
- Ce que 'disconnects the integration' implique concretement quand on supprime le dernier agent du compte, et ce qu'exige la reconnexion (re-onboarding complet ? delais de validation Meta ?).
- Devenir apres suppression de la base de connaissance de l'agent, des cas d'evaluation / evaluations / rapports de l'entite, et des conversations en cours (notamment les fils sous controle humain). Rien de documente.
- Comportement reel d'un entity_id inexistant sur DELETE : 400, 403 ou 200 avec deleted_agent_id null ? Aucun 404 documente.

