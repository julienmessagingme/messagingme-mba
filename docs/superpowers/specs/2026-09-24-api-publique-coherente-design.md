# L'API publique `/v1` : une identité, un vocabulaire, et le RCS

**Date** : 2026-09-24. **Statut** : design validé par Julien le 2026-09-24 (analyse de la doc, trois rondes de
questions, trois parties validées une à une, la première après une reprise), spec à relire.

## Le problème

Julien relit la page Developers > Documentation API et la trouve illogique : un envoi vise des `recipients`, un
message vise un `to`, un contact se met à jour par son `phone`. L'analyse du 2026-09-24 confirme le constat et
trouve pire à côté, dans le code comme dans la doc.

**Le vocabulaire.** Quatre noms pour un numéro (`phone`, `to`, `recipients[]`, `toE164` dans le suivi d'un
envoi). Le même refus porte deux codes selon la route : `unknown_contact` (motif d'écart de `/v1/sends`) contre
`contact_inconnu` (erreur de `/v1/messages`), et un contact désabonné est écarté en `not_opted_in` par l'un,
refusé en `contact_desabonne` par l'autre. Les codes mélangent français et anglais, et `/v1/sends` comme
`/v1/contacts` n'en rendent aucun.

**Ce que la doc promet et que le code ne tient pas.**

1. « Un numéro écarté est toujours motivé, jamais perdu en silence » : un contact BLOQUÉ est compté dans
   `matched` (`src/http/v1-sends.ts`), puis retiré par `listContactsForBuildByIds` (`src/campaign/store.pg.ts`,
   `blocked_at is null`). Il n'apparaît ni dans les destinataires, ni dans `skipped`. Aucun test ne le couvre.
2. L'API accepte ce que la console refuse. La création de campagne juge l'ouverture d'un scénario
   (`scanOpening`, `src/http/campaigns.ts`) ; `/v1/sends` ne juge rien, répond 201, et chaque destinataire
   échoue ensuite chez Meta. Même chose pour un template inconnu ou non approuvé.
3. **Une cible `node` décide de la fenêtre de 24 h sur le TYPE du bloc visé** (`exigeFenetre24h`), pas sur ce
   qu'il envoie en premier. Viser une condition, une étiquette ou un champ qui mène à un message rapide ne
   demande aucune fenêtre : le message part vers des gens qui n'ont pas écrit et Meta le refuse (131047).
   Relevé par Julien pendant le cadrage : « cela dépend du premier node, il ne faut pas se tromper là-dessus ».

**Ce qui est flou ou absent.**

- La catégorie d'un template est DÉCLARÉE par l'appelant : un template marketing déclaré `utility` part aux
  contacts dont le consentement est inconnu. L'Inbox, elle, lit la catégorie chez Meta et refuse en cas de
  doute (`src/http/inbox.ts`, envoi de template).
- `GET /v1/sends/:id` rend l'objet interne de la console (`chaine`, `paramMapping`, `archivedAt`) : aucun
  contrat, aucun exemple.
- Paramètres réels jamais documentés (`phoneNumberId`, `createMissing`, `optInSource`, `bsuid`, codes `fld_`),
  `category` obligatoire sans explication, `ratePerMinute` ramené à 80 en silence et éteint en silence s'il
  arrive en texte (la console répond 400).
- `optIn: false` ne fait rien, les tags ne font que s'ajouter, un champ ne se vide pas.
- La section `/v1/messages` de la page est écrite sans accents.
- Aucune lecture : ni d'une fiche (le serveur MCP le fait, pas l'API REST), ni de ce qu'on peut envoyer
  (templates, scénarios, messages RCS). Aucun désabonnement (`todo.md`, « L'API publique v1 ne sait pas dire
  désabonné »).
- Le RCS n'existe pas dans l'API, sauf, sans que la doc le dise, à travers un scénario qui contient des blocs
  RCS.

**Personne n'est branché sur l'API aujourd'hui** (Julien, 2026-09-24) : on casse proprement, sans garder les
anciennes formes.

## Le principe

Trois règles, qui tiennent toute l'API :

1. **Une personne est une FICHE.** L'intégrateur la désigne par ce qu'il a (`contactId`, `phone` ou `bsuid`),
   et ces clés ne servent qu'à la TROUVER. L'adresse d'envoi, le produit la déduit de la fiche et du canal.
2. **Le canal n'est jamais un paramètre.** Il se lit dans ce qu'on envoie (la cible d'un envoi) ou dans
   l'adresse de la route (le message simple).
3. **Un même refus porte le même code partout**, qu'il arrive en erreur sur un message ou en motif d'écart
   dans un envoi.

## Les arbitrages (Julien, 2026-09-24)

| Question | Décision |
|---|---|
| Identifiant d'une personne | `contactId`, l'identifiant de fiche qui existe déjà (`contacts.id`) |
| Désigner un destinataire | exactement une clé parmi `contactId`, `phone`, `bsuid` |
| Routage WhatsApp quand la fiche a numéro ET BSUID | inchangé : la règle du mini-CRM (`waIdOf`, le numéro sinon le BSUID) |
| Intégrations existantes | aucune : on casse proprement |
| Qui peut recevoir un RCS libre d'une machine | contact connu, non bloqué, non désabonné, ET (`opted_in` OU nous a déjà écrit) |
| Message simple WhatsApp et RCS | deux routes distinctes, leurs règles n'ont presque rien en commun |
| Périmètre | lecture de fiche, désabonnement, catalogues (templates WhatsApp, scénarios, messages RCS), variables par destinataire |
| Le `contactId` dans la console | affiché sur la fiche du mini-CRM, avec un bouton Copier |
| Hors périmètre | webhooks sortants, variables dans un scénario, BSUID d'abord, identifiant du CRM client, suppression de fiche par API |

## 1. L'identité d'une personne

| Donnée | Sur la fiche (`contacts`) | Qui la remplit | Dans l'API | Sert à |
|---|---|---|---|---|
| Identifiant de fiche | `id` | créé avec la fiche | `contactId` | désigner la fiche sans dépendre d'un numéro |
| Numéro | `phone_e164` (`+33…`) | message WhatsApp entrant, import, API, saisie | `phone` | adresse RCS (obligatoire) ; adresse WhatsApp quand il existe |
| BSUID | `bsuid` | message entrant d'un utilisateur à nom d'utilisateur ; import, API | `bsuid` | adresse WhatsApp quand il n'y a pas de numéro |
| `wa_id` | pas une colonne : calculé par `waIdOf` | | pas exposé | l'adresse WhatsApp réellement utilisée |

**Comment la fiche se remplit** : Meta envoie un `wa_id` à chaque message entrant, et `classifyWaId`
(`src/crm/identity.ts`) le range : de 7 à 15 chiffres, c'est un numéro ; sinon, un BSUID. Aucun BSUID n'a été
reçu à ce jour. **Rien dans cette spec ne dépend de la façon dont il arrivera** : le jour où il arrive, l'entrant
remplit `bsuid` et l'API retrouve la fiche par `bsuid` ou par `contactId` ; s'il n'arrive jamais, la clé `bsuid`
ne sert pas.

**Trouver la fiche** (dans `/v1/messages/*` et dans chaque destinataire de `/v1/sends`) : exactement UNE clé
parmi `contactId`, `phone`, `bsuid`. Zéro ou deux : `invalid_recipient`. Le `phone` est normalisé en E.164 avec
la France par défaut, comme aujourd'hui (`normalizePhone`).

**L'adresse d'envoi** ne vient JAMAIS de la clé reçue :

- **WhatsApp** : `waIdOf(phone_e164, bsuid)`, donc le numéro, sinon le BSUID ;
- **RCS** : `phone_e164`, toujours. Une fiche sans numéro est refusée en `no_phone`.

⚠️ Recevoir `{ "phone": "+33…" }` pour une fiche qui porte aussi un BSUID ne fait donc PAS partir le WhatsApp
sur le numéro reçu : il part sur l'adresse de la fiche. C'est ce qui garde un seul fil par personne.

## 2. Les contacts

Droits : `contacts:write` (écrire), **`contacts:read` (nouveau, lire)**. Les droits d'une clé se fixent à sa
création : une lecture demande une clé neuve, ce qui est acceptable puisque personne n'est branché.

### `POST /v1/contacts` : créer ou compléter une fiche

```json
{
  "phone": "+33612345678",
  "bsuid": "…",
  "name": "Camille Roy",
  "fields": { "ville": "Lyon" },
  "tags": ["prospect"],
  "consent": "opted_in",
  "consentSource": "formulaire-site"
}
```

- Au moins `phone` ou `bsuid`. La fiche se retrouve par `phone`, sinon par `bsuid`. Si les deux désignent deux
  fiches DIFFÉRENTES : 409 `identity_conflict`, rien n'est écrit. Si l'une trouve la fiche et l'autre est neuve,
  la neuve est rattachée à la fiche.
- `fields` : adressés par clé technique ou par code `fld_`. Un champ inconnu est créé en texte, dans la limite
  du plafond par espace. `tags` s'AJOUTENT, n'en retirent jamais.
- `consent` : `"opted_in"` ou `"opted_out"`, absent = inchangé. Il REMPLACE `optIn` / `optInSource`, dont le
  `false` ne voulait rien dire.
  - `opted_in` promeut, par l'upsert existant.
  - `opted_out` est un VRAI désabonnement : statut, date (`opt_out_at`, invariant de 0138) et ligne d'audit
    `contact.optout` (source `api`). L'upsert ne sait que promouvoir, et c'est une bonne garde qu'on garde :
    le désabonnement est donc une SECONDE écriture après l'upsert, sur l'identifiant rendu, comme la route
    `PATCH` de la fiche dans la console.
- Réponse 200 : `{ "contactId": "…", "status": "created" | "updated" }`.

`POST /v1/contacts/batch` : même corps par élément, 500 au plus, un résultat par index, un élément refusé ne
fait pas tomber le lot (contrat actuel, inchangé).

### `GET /v1/contacts/{contactId}` : lire une fiche (`contacts:read`)

```json
{
  "contactId": "…",
  "phone": "+33612345678",
  "bsuid": null,
  "name": "Camille Roy",
  "fields": { "ville": "Lyon" },
  "tags": ["prospect"],
  "consent": { "status": "opted_in", "source": "formulaire-site", "optedOutAt": null },
  "rcsOptedOutAt": null,
  "blocked": false,
  "reachability": { "whatsapp": true, "rcs": null },
  "createdAt": "2026-09-24T10:00:00Z"
}
```

`reachability` : `true` / `false` quand c'est connu, `null` sinon. WhatsApp vient de
`contacts.whatsapp_joignable` (0133), RCS du cache de joignabilité. Une fiche supprimée rend 404.

### `POST /v1/contacts/search` : retrouver une fiche par numéro ou BSUID (`contacts:read`)

Corps `{ "phone": "…" }` ou `{ "bsuid": "…" }` (exactement une clé). Réponse 200 `{ "contact": {…} | null }`,
même forme que `GET`. **Le numéro voyage dans le corps, jamais dans l'adresse** : une adresse
`/v1/contacts/+33…` l'inscrirait dans les journaux d'accès du proxy et de Cloudflare.

### `PATCH /v1/contacts/{contactId}` : modifier une fiche (`contacts:write`)

`{ "name", "fields", "addTags", "removeTags", "consent", "consentSource" }`, tous optionnels.

- `fields` : une valeur `null` VIDE le champ ; les autres se fusionnent.
- `consent` : même sens que sur `POST`.
- Le numéro et le BSUID ne se modifient PAS ici : ils portent les conversations, un changement les couperait
  de leur historique.
- Réponse 200 `{ "contactId": "…" }` ; 404 `unknown_contact`.

## 3. Déclencher un envoi : `POST /v1/sends` (`sends:create`)

Un envoi est un LOT : asynchrone, idempotent, visible dans Campagnes, suivi par `GET /v1/sends/{sendId}`.

```json
POST /v1/sends
Idempotency-Key: commande-8412

{
  "target": { "template": { "name": "confirmation", "language": "fr" } },
  "recipients": [
    { "contactId": "…", "variables": { "commande": "8412" } },
    { "phone": "+33698765432" }
  ],
  "params": [{ "position": 1, "source": { "type": "variable", "key": "commande" } }],
  "ratePerMinute": 20
}
```

### Les quatre cibles, et le canal qu'elles donnent

| Cible | Désignée par | Canal |
|---|---|---|
| `template` | `{ "name", "language" }` | WhatsApp |
| `scenario` | code `scn_…` ou nom | celui de son premier envoi |
| `node` | code `nod_…` | celui de son premier envoi |
| **`rcsMessage` (nouvelle)** | nom dans Contenu > Messages RCS, unique par espace en base (`rcs_messages_tenant_name`) | RCS |

### Ce qu'un scénario ou un bloc envoie EN PREMIER

C'est la correction du défaut 3. `scanOpening` (`src/workflow/engine.ts`) apprend à partir d'un bloc donné au
lieu de l'entrée, et `canalDOuverture` (`src/workflow/store.pg.ts`) gagne la même option. UNE fonction juge
donc le scénario (depuis son entrée), le bloc (depuis lui-même) et le catalogue. `exigeFenetre24h`, qui jugeait
sur le type du bloc, disparaît.

| Premier envoi atteint | `opening` | Règle |
|---|---|---|
| un template | `whatsapp_template` | part vers quelqu'un qui n'a pas écrit |
| un bloc RCS configuré | `rcs` | part vers quelqu'un qui n'a pas écrit ; fiche sans numéro écartée `no_phone` |
| un message rapide, une question, un formulaire, un agent | `whatsapp_session` | fenêtre de 24 h exigée par destinataire (`window_closed` sinon) |
| une attente avant tout envoi, rien, plusieurs templates possibles, un template sans nom | aucun | refusé avant l'envoi : 422 `unsendable_target`, la raison dans le message |

- **Scénario** : `whatsapp_session` est REFUSÉ (`unsendable_target`), comme dans la console ; pour parler à
  quelqu'un dans sa fenêtre, on vise le bloc. Un scénario jamais publié est refusé : un envoi joue le graphe
  PUBLIÉ (`workflows.graph`), un brouillon seul n'a rien à jouer.
- **Bloc** : les trois `opening` sont admis.
- **Prudence** : si UNE branche peut envoyer un message de session, la fenêtre est exigée pour tous.

### Les destinataires

- `recipients` : 50 au plus, chacun `{ contactId | phone | bsuid, variables? }`.
- **Un `phone` inconnu crée la fiche** (un template ou un RCS partent vers quelqu'un qui n'a pas écrit), SAUF
  pour une ouverture `whatsapp_session`, où il est écarté `unknown_contact` : il n'a par construction aucune
  fenêtre ouverte. Un `contactId` ou un `bsuid` inconnu est écarté `unknown_contact`. Le paramètre
  `createMissing` disparaît.
- Un destinataire mal formé est ÉCARTÉ (`invalid_recipient`, `invalid_phone`), il ne fait pas tomber l'envoi.
- **Aucune perte silencieuse** : doublon (`duplicate`), bloqué (`blocked_contact`), désabonné (`opted_out`,
  y compris le STOP RCS sur une ouverture `rcs`), consentement manquant pour un envoi marketing (`no_consent`),
  fenêtre fermée (`window_closed`), variable manquante (`missing_variable`), pas de numéro pour le RCS
  (`no_phone`).

### Les variables par destinataire

- `variables` : un objet `{ clé: texte }` propre à ce destinataire, qui n'est PAS écrit sur la fiche.
- **Template** : une nouvelle source de paramètre `{ "type": "variable", "key": "commande" }` lit
  `variables.commande`. Absente et sans `fallback` : `missing_variable`, comme une source de champ vide.
- **Message RCS** : `{{commande}}` prend `variables.commande` en priorité, puis le champ de fiche du même nom.
- **Scénario et bloc** : `variables` refusé (400 `invalid_body`) : un parcours n'a aujourd'hui aucun endroit où
  les ranger. `params` n'a de sens que sur un template (400 ailleurs).

### Catégorie, numéro, débit

- **Template** : la catégorie est LUE CHEZ META, comme dans l'Inbox ; illisible, l'envoi est refusé (422
  `template_category_unknown`). Un template absent ou non approuvé : 404 `template_not_found`. Le champ
  `category` est refusé sur un template.
- **Scénario, bloc, message RCS** : `category` (`marketing` | `utility`) est obligatoire. Elle décide du
  consentement exigé : `marketing` écarte tout ce qui n'est pas `opted_in`, `utility` n'écarte que les
  désabonnés.
- **Numéro WhatsApp** : exigé pour `template`, `scenario` et `node` (la console l'exige pour toute campagne
  de scénario) ; il n'est PAS exigé pour `rcsMessage`, qui part de l'agent RCS de l'espace. `phoneNumberId` reste optionnel et documenté ; absent, le numéro par
  défaut de l'espace.
- **`ratePerMinute`** : entier de 1 à 80, sinon 400, comme dans la console. Le plafond réel du canal
  s'applique ensuite (`plafondDuCanal`), et la doc le dit.

### Idempotence

`Idempotency-Key` reste obligatoire. Nouveau : l'EMPREINTE du corps est gardée avec la clé. La même clé avec
un autre corps rend 422 `idempotency_key_reused` au lieu de rejouer en silence le rapport du premier. La doc
dit enfin que la clé vit 24 h.

### La réponse 201

```json
{
  "sendId": "…",
  "opening": "whatsapp_template",
  "recipientCount": 1,
  "created": 0,
  "matched": 2,
  "skipped": [{ "index": 1, "reason": "opted_out" }],
  "skippedTotal": 1
}
```

Chaque écart porte l'`index` du destinataire dans `recipients` : c'est lui qui permet de le retrouver, quelle
que soit la clé utilisée. La liste reste tronquée à 200, `skippedTotal` donne le compte réel.

### `GET /v1/sends/{sendId}` : un contrat écrit

```json
{
  "sendId": "…",
  "status": "running",
  "target": { "template": { "name": "confirmation", "language": "fr" } },
  "opening": "whatsapp_template",
  "createdAt": "…",
  "counts": { "pending": 0, "sending": 0, "sent": 1, "failed": 0, "skipped": 0 },
  "recipients": [
    {
      "contactId": "…",
      "channel": "whatsapp",
      "status": "sent",
      "messageId": "wamid…",
      "delivery": "delivered",
      "error": null,
      "sentAt": "…"
    }
  ]
}
```

Une fonction de mise en forme dédiée, testée, remplace le renvoi de l'objet de la console : un changement de
la console ne change plus l'API. `error` vaut `{ "message", "metaCode" }` quand un envoi a échoué. Pour un
scénario ou un bloc, la ligne décrit le DÉPART du parcours et `channel` son canal d'ouverture ; la suite du
parcours se lit dans la console.

## 4. Envoyer un message simple

Un message simple est un TEXTE, à UNE personne, synchrone, visible dans l'Inbox. Écrire PREND le fil (le
scénario cesse d'avancer seul, l'agent de Meta cesse de répondre), comme aujourd'hui. Pas d'`Idempotency-Key`,
comme la barre de réponse de l'Inbox. La personne doit avoir une FICHE : un message simple ne fonde pas une
relation, c'est un envoi (`/v1/sends`) qui le fait.

Réponse 200 des deux routes : `{ "messageId": "…", "conversationId": "…", "channel": "whatsapp" | "rcs" }`.

### `POST /v1/messages/whatsapp` (`sends:create`)

`{ "contactId" | "phone" | "bsuid": "…", "text": "…" }`, texte de 4 096 caractères au plus.

Règles d'aujourd'hui, inchangées : la fiche existe (404 `unknown_contact`), n'est pas bloquée (409
`blocked_contact`), n'est pas désabonnée (409 `opted_out`), l'espace a un numéro (409 `no_whatsapp_number`), la
fenêtre de 24 h est ouverte (422 `window_closed`). Le chemin reste `repondreDansLaFenetre`, partagé avec la
console et le serveur MCP.

### `POST /v1/messages/rcs` (`sends:create`)

`{ "contactId" | "phone" | "bsuid": "…", "text": "…" }`, texte de 3 072 caractères au plus
(`RCS_TEXTE_MAX`). Pas de fenêtre. Dans l'ordre :

| Condition | Refus |
|---|---|
| la fiche existe | 404 `unknown_contact` |
| elle porte un numéro | 422 `no_phone` |
| elle n'est pas bloquée | 409 `blocked_contact` |
| elle n'est pas désabonnée, ni en général ni du RCS (`rcs_optout_at`) | 409 `opted_out` |
| **elle a consenti (`opted_in`) OU nous a déjà écrit** (au moins un message entrant, tout canal) | 409 `no_consent` |
| le canal RCS est actif sur l'espace | 409 `rcs_not_enabled` |
| elle n'est pas connue comme injoignable en RCS | 422 `rcs_unreachable` |

- **Un seul chemin pour l'API et le bouton RCS de l'Inbox.** L'envoi libre de `sendRcsFromInbox`
  (`src/index.ts`) devient une fonction partagée, sur le modèle de `repondreDansLaFenetre`. La condition de
  consentement ne s'applique qu'aux MACHINES (API), jamais à l'opérateur, comme la garde de désabonnement
  aujourd'hui.
- ⚠️ **La joignabilité n'est connue d'avance que si elle a déjà été constatée** : smsmode ne sait pas la
  vérifier avant l'envoi (`canCheckReachability = false`). Sinon, le message est accepté et un échec éventuel
  arrive ensuite dans l'Inbox. Sans webhooks sortants, l'intégrateur ne le voit pas : c'est une limite dite dans
  la doc, pas cachée.

## 5. Les catalogues (`sends:create`)

- **`GET /v1/templates`** : les templates WhatsApp APPROUVÉS,
  `{ "name", "language", "category", "header": "none" | "text" | "image" | "video" | "document", "variables": [{ "position", "source" }] }`.
  `source` est le champ suggéré quand la console le connaît (`template_param_hints`), `null` sinon.
- **`GET /v1/scenarios`** : les scénarios PUBLIÉS, `{ "code", "name", "opening", "publishedAt" }`. `opening`
  vaut `whatsapp_template`, `whatsapp_session`, `rcs` ou `null` (ne peut pas partir), calculé par la même
  fonction que `/v1/sends`.
- **`GET /v1/rcs-messages`** : `{ "name", "kind": "text" | "card" | "carousel", "variables": ["prenom"] }`.

## 6. Les erreurs

Toute erreur a la forme `{ "error": "<phrase en français>", "code": "<code>" }`. Les codes sont en anglais
snake_case : ce sont des identifiants, lus par des programmes.

**Un code par situation qu'un programme peut traiter.** Tout défaut de FORME est `invalid_body`, avec le champ
fautif dans le message (« fields.adresse : texte attendu »).

**Les statuts** : 400 corps invalide ; 401 / 403 clé ; 404 introuvable ; 409 l'état de la fiche ou de l'espace
l'interdit ; 422 la demande est juste mais ne peut pas partir comme ça ; 429 débit.

| Code | Erreur | Motif d'écart (`/v1/sends`) |
|---|---|---|
| `invalid_body` | 400 | |
| `invalid_recipient` | 400 | oui |
| `invalid_phone` | 400 | oui |
| `unauthorized` | 401 | |
| `missing_scope` | 403 | |
| `unknown_contact` | 404 | oui |
| `duplicate` | | oui |
| `identity_conflict` | 409 | |
| `blocked_contact` | 409 | oui |
| `opted_out` | 409 | oui |
| `no_consent` | 409 | oui |
| `window_closed` | 422 | oui |
| `missing_variable` | | oui |
| `no_phone` | 422 | oui |
| `rcs_unreachable` | 422 | |
| `rcs_not_enabled` | 409 | |
| `no_whatsapp_number` | 409 | |
| `scenario_not_found`, `node_not_found`, `template_not_found`, `rcs_message_not_found`, `send_not_found` | 404 | |
| `scenario_ambiguous` | 409 | |
| `unsendable_target` | 422 | |
| `template_category_unknown` | 422 | |
| `idempotency_key_required` | 400 | |
| `idempotency_in_progress` | 409 | |
| `idempotency_key_reused` | 422 | |
| `rate_limited` | 429 | |

⚠️ Les refus du GARDE commun (clé absente, droit manquant, débit) rendent aujourd'hui `{ error }` seul
(`src/auth/api-key.ts`, `src/auth/rate-limit.ts`). Ils sont partagés : leur ajouter un `code` ne doit changer
ni leurs statuts ni leurs en-têtes (`retry-after`, `x-ratelimit-*`).

## 7. La console

- **Fiche du mini-CRM** (`web/components/ContactDetail.tsx`) : l'identifiant de fiche s'affiche, libellé
  « Identifiant API », avec un bouton Copier. C'est la valeur que l'API appelle `contactId`.
- **Clés d'API** (`web/app/developers/keys/page.tsx`) : le droit `contacts:read` apparaît (« Lire les
  contacts »). La liste des droits vit en DEUX endroits à tenir d'accord (`VALID_API_SCOPES` dans
  `src/http/api-keys.ts`, `API_SCOPES` dans `web/lib/api/integrations.ts`) : un test de parité les compare.
- **Documentation API** (`web/app/developers/api/page.tsx`) : réécrite. Deux familles clairement séparées
  (« Envoyer un message simple », « Déclencher un envoi »), la table d'identité, chaque paramètre, la table des
  codes, des exemples RCS, avec les accents.
  - **Les exemples de corps vivent dans un module** importé par la page ET par un test qui les passe aux
    validateurs des routes : la page ne peut plus décrire un corps que le serveur refuse.

## 8. Ce qu'on stocke

Deux migrations additives, numérotées au moment de les écrire (le compteur vit dans `CLAUDE.md`, section
Déploiement, et le DOSSIER tranche sur ce qui est pris). Les deux passent AVANT le déploiement du code qui les
écrit :

- `api_idempotency.request_hash text` nullable : l'empreinte du corps. Une ligne d'avant (hash `null`) rejoue
  son rapport comme aujourd'hui.
- `campaign_recipients.variables jsonb` nullable : les variables d'un destinataire, relues à l'envoi d'un
  message RCS (un template résout les siennes à la construction, dans `resolved_params`, comme aujourd'hui).

Aucune colonne sur `contacts` : `contactId`, `phone` et `bsuid` existent déjà.

## 9. Les lots

1. **Identité et contacts** : `POST` et `batch` refondus (`bsuid`, `consent`, `identity_conflict`), `GET`,
   `search`, `PATCH`, droit `contacts:read`, identifiant affiché sur la fiche.
2. **Envois refondus** : destinataires par clé, rapport par index sans perte silencieuse, codes unifiés,
   jugement de l'ouverture depuis un bloc (défaut 3), gardes alignées sur la console, catégorie lue chez Meta,
   empreinte d'idempotence, contrat de `GET /v1/sends`. `/v1/messages/whatsapp` remplace `/v1/messages`.
3. **RCS et variables** : cible `rcsMessage`, `/v1/messages/rcs` et sa fonction partagée avec l'Inbox,
   variables par destinataire.
4. **Catalogues et doc** : les trois catalogues, la page réécrite, le module d'exemples et son test,
   `features.md`.

## 10. Tests

- **Chaque défaut constaté a son test de non-régression, vérifié dans les deux sens** (remettre le code fautif,
  voir le test échouer avec le bon symptôme, restaurer) : contact bloqué perdu en silence, bloc sur une
  condition qui mène à un message rapide, scénario à ouverture de session accepté, template inconnu accepté,
  même clé d'idempotence avec un autre corps.
- **Parité** : `opening` rendu par le catalogue, par `/v1/sends` et par la console sur les mêmes graphes (la
  fonction est unique, le test le garde).
- **Consentement RCS** : les quatre cas (`opted_in` sans message, message entrant sans `opted_in`, ni l'un ni
  l'autre, désabonné RCS), et l'opérateur de l'Inbox qui n'y est PAS soumis.
- **Identité** : chaque clé retrouve la même fiche ; `phone` et `bsuid` sur deux fiches rendent
  `identity_conflict` sans rien écrire ; l'adresse WhatsApp d'une fiche à numéro et BSUID reste le numéro,
  quelle que soit la clé reçue.
- **Désabonnement** : `consent: "opted_out"` pose le statut, la date et la ligne d'audit ; un `POST` sans
  `consent` ne rétrograde jamais.
- **Intégration** (job `integration` de la CI, jamais en local : le `DATABASE_URL` local est la production) :
  `search`, `PATCH`, l'upsert par BSUID et les deux migrations.

## 11. L'essai réel qui clôt la feature

Avec une VRAIE clé, en production, sur le numéro d'essai, en regardant le téléphone, Campagnes et l'Inbox :

1. `POST /v1/contacts` avec le numéro d'essai, puis `GET` et `search` rendent la même fiche, et son identifiant
   est celui qu'affiche la fiche du mini-CRM.
2. `POST /v1/sends` : un template avec une variable par destinataire, puis un message RCS de la bibliothèque.
   Les deux arrivent sur le téléphone, la variable est remplie.
3. `POST /v1/messages/rcs` : le RCS libre arrive et apparaît dans l'Inbox.
4. `POST /v1/messages/whatsapp` dans la fenêtre (après avoir écrit depuis le téléphone), puis hors fenêtre :
   422 `window_closed`.
5. `PATCH` avec `consent: "opted_out"`, puis un envoi : écarté `opted_out`, et la ligne d'audit existe.

## 12. Méthode de livraison

**Implémenteur par lot, avec revue humaine du diff.** Ce sont des chemins que la production emprunte (envoi de
messages, écriture du consentement), porteurs d'invariants invisibles (l'upsert qui ne sait que promouvoir,
l'index partiel de chaque identité, le scellement de l'idempotence AVANT l'enfilement, la fenêtre de 24 h). Un
message parti ne se rappelle pas. `/revue` après chaque lot, `/revue-finale` avant le déploiement.

## 13. Déploiement

- Les deux migrations passent AVANT le `up` de l'API qui les écrit (`compose build`, `migrate`, `up -d
  --build`), puis relecture en base juste après `migrate`, et contrôle public des deux portes (502 de NPM).
- 🔴 **La doc se pousse APRÈS le déploiement de l'API.** Vercel publie la console à chaque push : une page qui
  décrit des routes que la production n'a pas encore tromperait l'intégrateur qui la lit. Même piège que
  l'onglet « Outils » du 2026-09-21. L'identifiant sur la fiche, lui, ne dépend d'aucune route neuve.
- `/v1/messages` disparaît au profit de `/v1/messages/whatsapp` : sans intégrateur branché, aucune transition.

## 14. Rayon de souffle déjà repéré

- `exigeFenetre24h` et ses tests (`tests/v1-sends.test.ts`) : la fonction disparaît, les cas qu'elle exerçait
  sont CONSERVÉS dans les tests du nouveau jugement (règle du dépôt : réécrire un test garde son cas).
- `scanOpening` sert la console, la liste des scénarios, le sélecteur de l'Inbox et l'éditeur : lui ajouter un
  point de départ ne doit rien changer à l'appel sans point de départ (`tests/workflow-ouverture.test.ts`,
  `tests/web-campaign-eligibility.test.ts`).
- `upsertContactsFromApi` sert AUSSI le webhook entrant et l'import de listes : `consent` et l'upsert par BSUID
  ne doivent pas changer leur comportement. Le schéma de l'API se sépare de l'entrée partagée si besoin.
- `sendRcsFromInbox` devient une fonction partagée : le bouton de l'Inbox doit rester identique (e2e de
  l'envoi RCS dans l'Inbox).
- `features.md` (§ API publique : « deux périmètres », `/v1/messages`, `recipients`), `todo.md` (l'entrée
  « L'API publique v1 ne sait pas dire désabonné » se ferme), `documentation.md` si un invariant y décrit
  l'API.
- Le serveur MCP n'est PAS touché : ses outils désignent un fil par `conversation_id`, ce qui a du sens pour un
  agent qui lit l'Inbox.

## 15. Hors périmètre

- **Webhooks sortants** (livraison, réponses, désabonnements) : le seul moyen de suivre un message simple
  après coup. Le plus gros morceau, à cadrer à part.
- **Variables dans un scénario** : un parcours n'a pas de contexte où les ranger.
- **BSUID d'abord** pour le routage WhatsApp : changerait tous les envois, pas seulement l'API.
- **Identifiant du CRM du client** sur la fiche.
- **Suppression de fiche par API** (effacement RGPD) : irréversible, à discuter.
- **Re-consentement d'un contact qui a dit STOP** : `consent: "opted_in"` le réabonne, comme l'import CSV
  aujourd'hui. Comportement existant, gardé tel quel, à trancher à part s'il pose question.
