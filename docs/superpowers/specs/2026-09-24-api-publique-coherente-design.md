# L'API publique `/v1` : une identité, un vocabulaire, le RCS, et les signaux vers Batch

**Date** : 2026-09-24. **Statut** : design validé par Julien le 2026-09-24 (analyse de la doc, trois rondes de
questions, trois parties validées une à une, la première après une reprise), puis AMENDÉ le même jour après la
lecture du montage Batch (session « Intégration Batch ») : identifiant externe, idempotence dans le corps,
consentement par destinataire, échecs des messages libres, intentions retail, signaux et adaptateur Batch.
Spec à relire.

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
4. **L'échec de livraison d'un message LIBRE n'est écrit nulle part.** Le rapport de smsmode (`onDlr`,
   `src/index.ts`) ne met à jour que les destinataires de campagne, les mesures par bloc et les parcours ; les
   statuts de Meta (`processStatuses`, `src/webhooks/delivery.ts`) que les destinataires de campagne (plus le
   tarif, la remise du fil et les mesures par bloc). Un message de conversation ne porte aucun statut de
   livraison. Une réponse de l'Inbox, un RCS libre ou un message d'API qui n'arrive pas n'apparaît donc ni
   dans Sécurité > Journal des erreurs, ni sur la bulle, et le cache de joignabilité RCS n'en apprend rien.
   Trouvé en répondant à Julien (« si le RCS n'est pas délivré, est-ce qu'on verra une entrée dans le
   journal ? ») : la première version de cette spec affirmait à tort qu'un tel échec « arrive ensuite dans
   l'Inbox ».

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

**Ce que le montage Batch ajoute** (session « Intégration Batch », et doc de Batch relue le 2026-09-24) :

- Batch appelle un service tiers par son **Universal Channel** : un POST par profil, corps JSON rempli par ses
  variables de profil (`{{b.phone_number}}`, `{{b.custom_id}}`…). Sa doc ne dit PAS que les en-têtes se
  remplissent par profil.
- **Batch ne lit pas notre réponse** (« Batch only confirms delivery of the request ») : son orchestration
  réagit à ce qui est écrit dans SON profil, par son API Profils (`POST /profiles/update`, clé par `custom_id`,
  attributs et événements). Ce qu'on lui renvoie est donc une POUSSÉE de notre part, pas un endpoint qu'il lit.
- Ses profils se désignent par SON identifiant (`custom_id`), comme ceux de Brevo, SFMC ou Splio.
- Nos intentions calculées sont celles des services et de l'assurance ; il n'y a pas d'« achat », alors que les
  clients de Batch sont surtout dans le retail.

**Personne n'est branché sur l'API aujourd'hui** (Julien, 2026-09-24) : on casse proprement, sans garder les
anciennes formes.

## Le principe

Trois règles, qui tiennent toute l'API :

1. **Une personne est une FICHE.** L'intégrateur la désigne par ce qu'il a (`contactId`, `externalId`, `phone`,
   `bsuid`), et ces clés ne servent qu'à la TROUVER. L'adresse d'envoi, le produit la déduit de la fiche et du
   canal.
2. **Le canal n'est jamais un paramètre.** Il se lit dans ce qu'on envoie (la cible d'un envoi) ou dans
   l'adresse de la route (le message simple).
3. **Un même refus porte le même code partout**, qu'il arrive en erreur sur un message ou en motif d'écart
   dans un envoi.

Et une quatrième pour le retour : **ce qu'on remonte est un dictionnaire de signaux indépendant de l'outil
cible** ; un adaptateur le traduit pour chaque outil, Batch en premier.

## Les arbitrages (Julien, 2026-09-24)

| Question | Décision |
|---|---|
| Identifiant d'une personne | `contactId`, l'identifiant de fiche qui existe déjà (`contacts.id`) |
| Identifiant de l'outil du client | `externalId` (le `custom_id` de Batch), gardé sur la fiche, unique par espace |
| Désigner un destinataire | au moins une clé parmi `contactId`, `externalId`, `phone`, `bsuid` ; toutes désignent la même fiche |
| Routage WhatsApp quand la fiche a numéro ET BSUID | inchangé : la règle du mini-CRM (`waIdOf`, le numéro sinon le BSUID) |
| Intégrations existantes | aucune : on casse proprement |
| Qui peut recevoir un RCS libre d'une machine | contact connu, non bloqué, non désabonné, ET (`opted_in` OU nous a déjà écrit) |
| Message simple WhatsApp et RCS | deux routes distinctes, leurs règles n'ont presque rien en commun |
| Idempotence d'un envoi | la clé en en-tête OU dans le corps (le Universal Channel ne remplit pas ses en-têtes par profil) |
| Consentement | porté aussi par chaque destinataire d'un envoi (il vit chez l'outil du client) |
| Échecs des messages libres | capturés : journal des erreurs, joignabilité RCS, signal `em_message_failed` |
| Intentions | ajout de `achat`, `suivi_commande`, `retour`, maintenant |
| Signaux remontés | dictionnaire + adaptateur Batch dans cette spec |
| Risque de désengagement par contact | lot 7, à cadrer (§ 19) |
| Doc API | aucun outil tiers nommé, ni dans le texte ni dans les exemples : elle sert à tous les intégrateurs |
| Périmètre | lecture de fiche, désabonnement, catalogues (templates WhatsApp, scénarios, messages RCS), variables par destinataire |
| Le `contactId` dans la console | affiché sur la fiche du mini-CRM, avec un bouton Copier |
| Hors périmètre | webhooks sortants génériques, variables dans un scénario, BSUID d'abord, suppression de fiche par API |

## 1. L'identité d'une personne

| Donnée | Sur la fiche (`contacts`) | Qui la remplit | Dans l'API | Sert à |
|---|---|---|---|---|
| Identifiant de fiche | `id` | créé avec la fiche | `contactId` | désigner la fiche sans dépendre d'un numéro |
| Identifiant externe | `external_id` (**nouveau**) | l'outil du client, par l'API | `externalId` | retrouver la fiche par l'identifiant de l'outil du client, et savoir dans quel profil réécrire |
| Numéro | `phone_e164` (`+33…`) | message WhatsApp entrant, import, API, saisie | `phone` | adresse RCS (obligatoire) ; adresse WhatsApp quand il existe |
| BSUID | `bsuid` | message entrant d'un utilisateur à nom d'utilisateur ; import, API | `bsuid` | adresse WhatsApp quand il n'y a pas de numéro |
| `wa_id` | pas une colonne : calculé par `waIdOf` | | pas exposé | l'adresse WhatsApp réellement utilisée |

**Comment la fiche se remplit** : Meta envoie un `wa_id` à chaque message entrant, et `classifyWaId`
(`src/crm/identity.ts`) le range : de 7 à 15 chiffres, c'est un numéro ; sinon, un BSUID. Aucun BSUID n'a été
reçu à ce jour. **Rien dans cette spec ne dépend de la façon dont il arrivera** : le jour où il arrive, l'entrant
remplit `bsuid` et l'API retrouve la fiche par `bsuid`, `externalId` ou `contactId` ; s'il n'arrive jamais, la
clé `bsuid` ne sert pas.

**`externalId`** : texte de 512 caractères au plus (la borne du `custom_id` de Batch), unique par espace,
jamais obligatoire. Il n'est pas une adresse : il ne sert qu'à retrouver la fiche et à réécrire dans l'outil du
client.

**Trouver la fiche** (dans `/v1/contacts`, dans `/v1/messages/*` et dans chaque destinataire de `/v1/sends`),
par UNE fonction partagée :

- au moins une clé parmi `contactId`, `externalId`, `phone`, `bsuid`, sinon `invalid_recipient` ;
- toutes les clés données doivent désigner LA MÊME fiche, sinon `identity_conflict` et rien n'est écrit ;
- une clé que la fiche trouvée ne porte pas encore lui est RATTACHÉE (Batch envoie naturellement le numéro ET
  son `custom_id` ensemble) ; `contactId`, lui, ne se rattache jamais, il existe ou il est inconnu ;
- aucune clé ne trouve de fiche : une fiche est créée SEULEMENT si la route crée (voir chaque route) ET qu'un
  `phone` ou un `bsuid` est donné (la base exige l'un des deux). Sinon `unknown_contact`.
- Le `phone` est normalisé en E.164 avec la France par défaut, comme aujourd'hui (`normalizePhone`).

⚠️ Cette règle remplace « exactement une clé », validée en première lecture : elle est tombée devant le premier
cas réel, un Universal Channel qui envoie le numéro et le `custom_id` dans le même corps.

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
  "externalId": "crm-7781",
  "bsuid": "…",
  "name": "Camille Roy",
  "fields": { "ville": "Lyon" },
  "tags": ["prospect"],
  "consent": "opted_in",
  "consentSource": "formulaire-site"
}
```

- La fiche se trouve par la règle du § 1, et cette route CRÉE : une fiche neuve exige `phone` ou `bsuid`.
  `externalId` seul et inconnu rend 404 `unknown_contact`.
- `fields` : adressés par clé technique ou par code `fld_`. Un champ inconnu est créé en texte, dans la limite
  du plafond par espace. `tags` s'AJOUTENT, n'en retirent jamais.
- `consent` : `"opted_in"` ou `"opted_out"`, absent = inchangé. Il REMPLACE `optIn` / `optInSource`, dont le
  `false` ne voulait rien dire.
  - `opted_in` fait passer une fiche de « inconnu » à « opt-in ». 🔴 **Il ne lève JAMAIS un STOP** : sur une
    fiche `opted_out`, 409 `opted_out`, et ni ses champs, ni ses étiquettes, ni son consentement ne bougent
    (décision de Julien du 2026-09-24 : une machine ne réabonne pas quelqu'un qui a dit stop ; seul un
    opérateur, depuis la fiche de la console, ou la personne elle-même le peut). La garde vit dans la
    requête du dépôt, pour tenir un STOP arrivé pendant l'appel.
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
  "externalId": "crm-7781",
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
`contacts.whatsapp_joignable` (0133), RCS du cache de joignabilité (`PgReachabilityStore`, que le § 5 alimente
désormais). Une fiche supprimée rend 404.

### `POST /v1/contacts/search` : retrouver une fiche (`contacts:read`)

Corps `{ "phone" }`, `{ "bsuid" }` ou `{ "externalId" }` (exactement une clé : c'est une recherche, pas un
rattachement). Réponse 200 `{ "contact": {…} | null }`, même forme que `GET`. **Le numéro voyage dans le corps,
jamais dans l'adresse** : une adresse `/v1/contacts/+33…` l'inscrirait dans les journaux d'accès du proxy et de
Cloudflare.

### `PATCH /v1/contacts/{contactId}` : modifier une fiche (`contacts:write`)

`{ "name", "fields", "addTags", "removeTags", "consent", "consentSource", "externalId" }`, tous optionnels.

- `fields` : une valeur `null` VIDE le champ ; les autres se fusionnent.
- `consent` : même sens que sur `POST`.
- `externalId` : se pose ou se remplace ; déjà porté par une autre fiche, 409 `identity_conflict`.
- Le numéro et le BSUID ne se modifient PAS ici : ils portent les conversations, un changement les couperait
  de leur historique.
- Réponse 200 `{ "contactId": "…" }` ; 404 `unknown_contact`.

## 3. Déclencher un envoi : `POST /v1/sends` (`sends:create`)

Un envoi est un LOT : asynchrone, idempotent, visible dans Campagnes, suivi par `GET /v1/sends/{sendId}`.

```json
POST /v1/sends

{
  "idempotencyKey": "relance-panier-crm-7781-2026-09-24",
  "target": { "template": { "name": "confirmation", "language": "fr" } },
  "recipients": [
    { "externalId": "crm-7781", "phone": "+33612345678", "consent": "opted_in", "variables": { "commande": "8412" } },
    { "contactId": "…" }
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
lieu de l'entrée, et une fonction neuve, `ouvertureApi` (`src/workflow/ouverture-api.ts`), en dérive le verdict
de l'API. UNE fonction juge donc le scénario (depuis son entrée), le bloc (depuis lui-même) et le catalogue.
`canalDOuverture` (`src/workflow/store.pg.ts`), lue par trois écrans de la console, ne change PAS : lui ajouter
une option que personne n'appellerait serait du code mort (écart relevé par le plan du lot 2, tranché ainsi).
`exigeFenetre24h`, qui jugeait sur le type du bloc, disparaît.

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

- `recipients` : 50 au plus, chacun `{ contactId?, externalId?, phone?, bsuid?, consent?, consentSource?, variables? }`,
  résolu par la règle du § 1.
- **Cette route CRÉE** la fiche d'un destinataire inconnu qui porte un `phone` (un template ou un RCS partent
  vers quelqu'un qui n'a pas écrit), SAUF pour une ouverture `whatsapp_session`, où il est écarté
  `unknown_contact` : il n'a par construction aucune fenêtre ouverte. Un destinataire inconnu qui ne porte
  qu'un `bsuid` est écarté `unknown_contact` : un envoi ne fonde pas une fiche sur un identifiant qu'aucun
  message n'a encore confirmé (`/v1/contacts`, lui, le peut). Le paramètre `createMissing` disparaît.
- **`consent` par destinataire** : écrit sur la fiche AVANT la construction de l'envoi, avec le même sens que
  sur `/v1/contacts` (un `opted_in` promeut une fiche inconnue mais ne lève jamais un STOP, un `opted_out`
  désabonne ; dans ces deux derniers cas le destinataire est écarté en `opted_out`). C'est ce qui permet à un outil où vit le consentement (Batch, Brevo) d'envoyer sans pousser
  chaque fiche au préalable. `consentSource` absent vaut `api`.
- Un destinataire mal formé est ÉCARTÉ (`invalid_recipient`, `invalid_phone`), il ne fait pas tomber l'envoi.
- **Aucune perte silencieuse** : doublon (`duplicate`), identités contradictoires (`identity_conflict`),
  bloqué (`blocked_contact`), désabonné (`opted_out`, y compris le STOP RCS sur une ouverture `rcs`),
  consentement manquant pour un envoi marketing (`no_consent`), fenêtre fermée (`window_closed`), variable
  manquante (`missing_variable`), pas de numéro pour le RCS (`no_phone`).

### Les variables par destinataire

- `variables` : un objet `{ clé: texte }` propre à ce destinataire, qui n'est PAS écrit sur la fiche.
- **Template** : une nouvelle source de paramètre `{ "type": "variable", "key": "commande" }` lit
  `variables.commande`. Absente et sans `fallback` : `missing_variable`, comme une source de champ vide.
- **Message RCS** : `{{commande}}` prend `variables.commande` en priorité, puis le champ de fiche du même nom.
- **Scénario et bloc** : `variables` refusé (400 `invalid_body`) : un parcours n'a aujourd'hui aucun endroit où
  les ranger.
- **`params`** : sur un template, et sur un **scénario qui ouvre par un template** : une campagne de scénario
  transmet ces valeurs à son template d'ouverture, comme dans la console. Ce template est alors lu chez Meta
  comme la cible `template` (introuvable : 404 `template_not_found` ; catégorie illisible ou non admise : 422
  `template_category_unknown`), et `params` doit décrire exactement le nombre de variables de son corps, sur
  les deux cibles (sinon 422 `unsendable_target` : Meta refuserait chaque message après un 201). La source
  `variable` y est refusée (400). Ailleurs, `params` est refusé (400) : un scénario qui ouvre en RCS n'a aucun
  template d'ouverture, un bloc résout son template par les sources enregistrées dans la console, un message
  RCS prend ses `{{variables}}` dans `recipients[].variables`. (Corrigé après le lot 2, qui refusait `params`
  sur tout scénario : un scénario ouvrant par un template à variable rendait 201, puis échouait chez Meta pour
  chaque destinataire.)

### Catégorie, numéro, débit

- **Template** : la catégorie est LUE CHEZ META, comme dans l'Inbox ; illisible, l'envoi est refusé (422
  `template_category_unknown`). Un template absent ou non approuvé : 404 `template_not_found`. Le champ
  `category` est refusé sur un template.
- **Scénario, bloc, message RCS** : `category` (`marketing` | `utility`) est obligatoire. Elle décide du
  consentement exigé : `marketing` écarte tout ce qui n'est pas `opted_in`, `utility` n'écarte que les
  désabonnés. Pour un scénario qui ouvre par un template, ET pour un bloc qui fait partir un template
  (correctif de la revue finale du 2026-09-25 : le catalogue publie `entryNode`, qui contournait la règle), la
  catégorie lue chez Meta pour ce template l'emporte si elle est plus stricte : un template marketing annoncé
  `utility` reste marketing. Illisible, l'envoi est refusé ; le nombre de variables ne se compare pas sur un
  bloc, qui les résout par les sources de la console.
- **Ce qu'aucun envoi ne peut faire partir** (en-tête ou bouton de lien à variable que rien ne remplit, carrousel
  ou visuel que le moteur refuse) : 422 `unsendable_target`, jugé par la MÊME fonction que le catalogue
  (`raisonNonEnvoyable`), sur la cible template, le template d'ouverture d'un scénario et celui d'un bloc.
- **Numéro WhatsApp** : exigé pour `template`, `scenario` et `node` (la console l'exige pour toute campagne
  de scénario) ; il n'est PAS exigé pour `rcsMessage`, qui part de l'agent RCS de l'espace. `phoneNumberId`
  reste optionnel et documenté ; absent, le numéro par défaut de l'espace.
- **`ratePerMinute`** : entier de 1 à 80, sinon 400, comme dans la console. Le plafond réel du canal
  s'applique ensuite (`plafondDuCanal`), et la doc le dit.

### Idempotence

- La clé est OBLIGATOIRE, et elle se donne **en en-tête (`Idempotency-Key`) OU dans le corps
  (`idempotencyKey`)**. Les deux présentes et différentes : 400 `invalid_body`. Raison : le Universal Channel
  de Batch remplit son CORPS avec les variables du profil, et sa doc ne dit pas qu'il en fait autant pour ses
  en-têtes.
- L'EMPREINTE du corps est gardée avec la clé. La même clé avec un autre corps rend 422
  `idempotency_key_reused` au lieu de rejouer en silence le rapport du premier. La clé vit 24 h, et la doc le
  dit.
- ⚠️ **À faire dire par Batch avant la recette** : quelle variable rend un passage UNIQUE (un même profil peut
  repasser par la même étape). Une clé faite du seul `custom_id` écarterait en silence le second passage
  légitime.

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
      "externalId": "crm-7781",
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
scénario cesse d'avancer seul, l'agent de Meta cesse de répondre), comme aujourd'hui. Pas de clé
d'idempotence, comme la barre de réponse de l'Inbox. La personne doit avoir une FICHE : ces routes ne créent
pas, un message simple ne fonde pas une relation, c'est un envoi (`/v1/sends`) qui le fait.

Réponse 200 des deux routes : `{ "messageId": "…", "conversationId": "…" | null, "channel": "whatsapp" | "rcs" }`.
`conversationId` vaut `null` dans un seul cas, en RCS : le message est parti, mais la fiche a été bloquée ou
supprimée entre-temps et aucun fil ne l'accueille (200 quand même, un 5xx ferait renvoyer). En WhatsApp, le fil
est trouvé AVANT l'envoi, donc toujours rendu ; il n'est jamais créé par la route : sans fil, pas de message
entrant, donc fenêtre fermée (422 `window_closed`, rien n'est écrit). Correctifs de la revue finale du 2026-09-25.

### `POST /v1/messages/whatsapp` (`sends:create`)

`{ "contactId"?, "externalId"?, "phone"?, "bsuid"?, "text" }` (règle du § 1), texte de 4 096 caractères au plus.

Règles d'aujourd'hui, inchangées : la fiche existe (404 `unknown_contact`), n'est pas bloquée (409
`blocked_contact`), n'est pas désabonnée (409 `opted_out`), l'espace a un numéro (409 `no_whatsapp_number`), la
fenêtre de 24 h est ouverte (422 `window_closed`). Le chemin reste `repondreDansLaFenetre`, partagé avec la
console et le serveur MCP.

### `POST /v1/messages/rcs` (`sends:create`)

Même corps, texte de 3 072 caractères au plus (`RCS_TEXTE_MAX`). Pas de fenêtre. Dans l'ordre :

| Condition | Refus |
|---|---|
| la fiche existe | 404 `unknown_contact` |
| elle porte un numéro | 422 `no_phone` |
| elle n'est pas bloquée | 409 `blocked_contact` |
| elle n'est pas désabonnée, ni en général ni du RCS (`rcs_optout_at`) | 409 `opted_out` |
| **elle a consenti (`opted_in`) OU nous a déjà écrit** (au moins un message entrant, tout canal) | 409 `no_consent` |
| le canal RCS est actif sur l'espace | 409 `rcs_not_enabled` |
| le cache de joignabilité ne la dit pas injoignable pour l'agent de l'espace | 422 `rcs_unreachable` |

- **Colonne « Répondu par » de l'analyse des conversations** (décision de Julien du 2026-09-24) : un message
  de l'API ne compte comme « Scripté » que s'il RÉPOND à un client qui avait déjà écrit dans ce fil. Quand il
  écrit le premier (RCS libre à une fiche qui a seulement consenti), il ne compte pas, comme un envoi de
  campagne : la colonne ne dit jamais « on a répondu » à quelqu'un qui n'avait rien dit.
- **Un seul chemin pour l'API et le bouton RCS de l'Inbox.** L'envoi libre de `sendRcsFromInbox`
  (`src/index.ts`) devient une fonction partagée, sur le modèle de `repondreDansLaFenetre`. La condition de
  consentement ne s'applique qu'aux MACHINES (API), jamais à l'opérateur, comme la garde de désabonnement
  aujourd'hui.
- ⚠️ **La joignabilité n'est connue qu'après coup.** smsmode ne sait pas la vérifier avant l'envoi
  (`canCheckReachability = false`) : le PREMIER RCS libre vers un numéro non RCS est accepté, puis son échec
  arrive par le rapport de livraison. Depuis le § 5, cet échec est écrit (journal, joignabilité, signal) et le
  suivant est refusé en `rcs_unreachable`. La route lit le cache DIRECTEMENT, pas à travers l'envoyeur, qui
  saute ce contrôle quand le fournisseur ne sait pas vérifier.

## 5. Les échecs des messages libres

C'est la correction du défaut 4.

- **Où l'échec est capté.** Dans le traitement des statuts de Meta (`processStatuses`) et dans le rapport de
  smsmode (`onDlr`) : quand un échec (`failed` chez Meta, `echecDefinitif` chez smsmode) porte l'identifiant
  d'un message qui n'est PAS un destinataire de campagne mais un message SORTANT de conversation (index unique
  `conversation_messages_wamid_uidx`), une ligne est écrite dans une table d'échecs. Seuls les échecs sont
  écrits : la table reste petite, sur le modèle des échecs d'avance de scénario (0108).
- **Ce qu'elle porte** : espace, identifiant du message, `wa_id`, canal, ORIGINE du message (opérateur, API,
  MCP, scénario, agent : la colonne `origin` du message), code Meta s'il y en a un, motif, date. Purge avec
  la même rétention que les échecs d'avance.
- **Le journal des erreurs** (`PgErreursLivraisonStore.lister`) la lit comme une quatrième source, origine
  `message`, avec les mêmes filtres (numéro, texte, dates). Filtrer par code Meta ne rend que les lignes qui en
  portent un.
- **La joignabilité RCS** : un échec définitif écrit `injoignable` dans le cache (`PgReachabilityStore.put`)
  pour l'agent et le numéro ; une livraison (`delivered`) y écrit `joignable`. C'est ce que lisent
  `/v1/messages/rcs` et `GET /v1/contacts`.
- **Le signal** `em_message_failed` part du même point (§ 8).
- ⚠️ Un bloc RCS de scénario qui prend sa sortie « non joignable » y apparaît AUSSI, origine scénario : c'est
  bien un message non délivré, même si le parcours a su quoi faire. Ce n'est pas une erreur de traitement,
  c'est un fait de livraison.
- ⚠️ **Le chemin des statuts est très chaud** (chaque message envoyé en reçoit plusieurs). La lecture de plus
  n'a lieu que pour un ÉCHEC qui n'a touché aucun destinataire de campagne : un statut `sent`, `delivered` ou
  `read` ne coûte rien de plus, sauf pour un espace qui a un adaptateur de signaux actif (§ 8).

## 6. Les catalogues (`sends:create`)

- **`GET /v1/templates`** : les templates WhatsApp APPROUVÉS,
  `{ "name", "language", "category", "header": "none" | "text" | "image" | "video" | "document", "variables": [{ "position", "source" }] }`.
  `source` est le champ suggéré quand la console le connaît (`template_param_hints`), `null` sinon.
- **`GET /v1/scenarios`** : les scénarios PUBLIÉS,
  `{ "code", "name", "opening", "openingTemplate", "entryNode", "publishedAt" }`. `opening`
  vaut `whatsapp_template`, `whatsapp_session`, `rcs` ou `null` (ne peut pas partir), calculé par la même
  fonction que `/v1/sends`. `openingTemplate` (`{ "name", "language" }`) est le template que `params`
  paramètre, pour une ouverture `whatsapp_template` seulement, `null` sinon ; `entryNode` est le code `nod_`
  du bloc d'entrée, à viser en cible `node` (seul chemin d'un `whatsapp_session`), `null` quand ce bloc n'a
  pas de code public (`catalogueScenarios`, `src/http/v1-catalogues.ts`).
- **`GET /v1/rcs-messages`** : `{ "name", "kind": "text" | "card" | "carousel", "variables": ["prenom"] }`.

## 7. Les intentions : `achat`, `suivi_commande`, `retour`

- La liste `INTENTS` (`src/analysis/schema.ts`) gagne trois valeurs : `achat` (le client veut acheter),
  `suivi_commande` (où en est ma commande), `retour` (retour ou échange d'un produit). Le prompt de l'analyse
  (`src/analysis/engine.ts`) décrit chacune, pour que le modèle sache les distinguer de `demande_devis`, `sav`
  et `reclamation`.
- Les écrans et exports qui les nomment suivent : `web/components/CarteIntentions.tsx`,
  `web/components/ConversationAnalysisCard.tsx`, `web/lib/quali-export.ts`, les statistiques
  (`src/stats/conversation-stats.pg.ts`, `src/http/stats.ts`, `web/lib/api/stats.ts`).
- Les analyses passées ne sont PAS reclassées : elles gardent leur intention d'origine.
- 🔴 **Deux lectures à faire avant d'écrire la première ligne**, dans le plan :
  - la migration 0027 porte-t-elle une contrainte sur les valeurs d'intention ? Si oui, une migration la
    RELÂCHE avant le déploiement (l'ancien code y survit) ;
  - **le connecteur HubSpot (`mm-hubspot`, dépôt séparé) reçoit `analysis.intent`** dans l'événement poussé
    (`src/analysis/connector-push.ts`). S'il valide la liste strictement, une intention neuve lui fait refuser
    l'événement, donc la remontée HubSpot casse. Il se met à jour et se déploie AVANT.

## 8. Les signaux et l'adaptateur Batch

### Le dictionnaire

Un contrat indépendant de l'outil cible. Préfixe `em_`, noms de 30 caractères au plus en `[a-z0-9_]` (la borne
de Batch, la plus stricte connue).

| Type | Nom | Quand | Contenu |
|---|---|---|---|
| événement | `em_message_delivered` | immédiat | canal, origine, `sendId` si c'est un envoi |
| événement | `em_message_read` | immédiat | idem |
| événement | `em_message_failed` | immédiat | idem, plus le motif et le code Meta |
| événement | `em_replied` | immédiat | canal, bouton tapé s'il y en a un. **Jamais le texte du message.** |
| événement | `em_link_clicked` | immédiat | le lien tracé cliqué, l'envoi ou le template |
| événement | `em_opted_out` | immédiat | canal ou source du désabonnement |
| événement | `em_conversation_analyzed` | à la fin d'une conversation | `intent`, `sentiment`, `satisfaction`, `urgence`, `resolved`, `topic`, `action_suggestion`, `handled_by`, `exchanges_count`, et `summary` SI l'option est activée |
| attribut | `em_contact_id` | à chaque poussée (réécrire la même valeur ne coûte rien, se souvenir de « déjà envoyé » serait un état de plus) | notre `contactId`, pour que l'outil nous renvoie la fiche sans ambiguïté |
| attributs | `em_last_intent`, `em_last_sentiment`, `em_satisfaction`, `em_urgency`, `em_last_resolved`, `em_last_reply_at`, `em_whatsapp_optout`, `em_rcs_optout`, `em_rcs_reachable` | avec les événements | l'état courant du contact |

- **« À la fin d'une conversation »** veut dire : 25 minutes sans message (`CONVERSATION_INACTIVITY_MS`), puis
  le passage du balayage, toutes les 5 minutes. Un « veut acheter » arrive donc une demi-heure environ après le
  dernier message : assez pour une relance, pas pour une alerte immédiate. La doc le dit.
- **« Immédiat »** veut dire : enfilé sur le fait, sans attendre de balayage, puis poussé par la file de
  l'adaptateur, un job à la fois par espace. Les réponses, clics, désabonnements et analyses y passent DEVANT
  les accusés (priorité de file) ; derrière une campagne de plusieurs milliers de destinataires, les accusés
  de livraison et de lecture peuvent donc arriver avec plusieurs dizaines de minutes de retard. La doc le dit.
- **`em_satisfaction` et `em_urgency`** reprennent la note de la DERNIÈRE conversation analysée ; une analyse
  sans note ne les écrase pas (l'absence veut dire « pas de mesure », jamais 0).
- **Le résumé** ne tient pas en un seul champ : un texte plafonne à 300 caractères chez Batch, pour un
  attribut de fiche COMME pour un attribut d'événement (la page renvoie des seconds aux premiers, relue le
  2026-09-24), et le résumé en fait jusqu'à 800. Il voyage donc dans l'événement, en morceaux consécutifs de
  300 caractères au plus (`summary_1` à `summary_3`, à recoller bout à bout), et seulement si l'espace a
  activé l'option, parce qu'il contient des propos du client. Les noms de ces morceaux, comme ceux de tous
  les champs, sont fixés par le dictionnaire, pas par l'adaptateur.
- Les points d'émission : les deux traitements de statuts (§ 5), les deux traitements d'entrants (Meta et
  RCS), la redirection des liens tracés, les chemins de désabonnement, et le point de sortie de l'analyse
  (`makeOnAnalyzed`, qui sert déjà la poussée HubSpot et reste inchangé pour elle).

### L'adaptateur Batch

- **Réglage** : Paramètres > Intégrations > Batch, réservé aux admins. La clé REST et la clé de projet
  (`X-Batch-Project`) sont chiffrées comme les autres secrets d'espace (`ENCRYPTION_KEY`) et ne sont jamais
  relues en clair par l'écran. Une case « Envoyer le résumé des conversations », décochée par défaut.
- **Poussée** : vers `POST /profiles/update` de Batch, profil désigné par `custom_id` = notre `externalId`.
  Une fiche SANS `externalId` n'est pas poussée, et le compte des signaux non poussés pour cette raison se lit
  dans l'écran du réglage : un intégrateur qui a oublié de nous passer ses identifiants doit le voir.
- **Transport** : une file pg-boss dédiée, déclarée dans `BASE_QUEUES` (sinon invisible de `/ops`), groupée
  par espace. Nouvel essai sur 429, 5xx et panne réseau ; un 4xx est terminal. Bornes de Batch respectées :
  200 profils et 15 événements par appel, 300 mises à jour par seconde.
- **Un échec de poussée est visible** dans la moitié « système » du journal des erreurs, comme un connecteur
  qui refuse un appel.
- Batch est un HÔTE FIXE, pas une adresse saisie par un client : la garde d'adresse publique ne s'applique
  pas, comme pour les clients de Meta et de smsmode.
- ⚠️ **À confirmer avec Batch avant la recette** : qu'un événement ou un attribut poussé déclenche bien une
  orchestration (affirmé dans la session Batch, non retrouvé sur la page de l'API Profils relue le
  2026-09-24), s'ils rejouent un appel du Universal Channel en cas d'échec, et quelle variable identifie un
  passage (§ 3, idempotence). Un événement peut arriver DEUX fois si notre poussée est rejouée : chaque
  événement porte donc un `em_event_id` stable.

## 9. Les erreurs

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
| `tenant_locked` | 403 | |
| `unknown_contact` | 404 | oui |
| `duplicate` | | oui |
| `identity_conflict` | 409 | oui |
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

## 10. La console

- **Fiche du mini-CRM** (`web/components/ContactDetail.tsx`) : l'identifiant de fiche s'affiche, libellé
  « Identifiant API », avec un bouton Copier. C'est la valeur que l'API appelle `contactId`. L'identifiant
  externe s'affiche aussi quand il existe.
- **Clés d'API** (`web/app/developers/keys/page.tsx`) : le droit `contacts:read` apparaît (« Lire les
  contacts »). La liste des droits vit en DEUX endroits à tenir d'accord (`VALID_API_SCOPES` dans
  `src/http/api-keys.ts`, `API_SCOPES` dans `web/lib/api/integrations.ts`) : un test de parité les compare.
- **Réglage Batch** : § 8.
- **Documentation API** (`web/app/developers/api/page.tsx`) : réécrite. Deux familles clairement séparées
  (« Envoyer un message simple », « Déclencher un envoi »), la table d'identité, chaque paramètre, la table des
  codes, des exemples RCS, avec les accents. Plus deux sections : **« Brancher un outil qui appelle par
  contact »** (plateforme d'orchestration, CRM, outil marketing : adresse, en-tête d'authentification, corps
  type avec `externalId`, `phone`, `consent`, `variables` et `idempotencyKey`) et **« Ce que nous
  remontons »** (le dictionnaire du § 8).
  - 🔴 **La page ne nomme AUCUN outil tiers**, ni dans son texte ni dans ses exemples (décision de Julien du
    2026-09-24) : elle sert à tous les intégrateurs. Les identifiants d'exemple sont neutres (`crm-7781`).
    Le nom de Batch n'apparaît que sur l'écran de réglage de son adaptateur (Paramètres > Intégrations).
  - **Les exemples de corps vivent dans un module** importé par la page ET par un test qui les passe aux
    validateurs des routes : la page ne peut plus décrire un corps que le serveur refuse.

## 11. Ce qu'on stocke

Toutes additives, numérotées au moment de les écrire (le compteur vit dans `CLAUDE.md`, section Déploiement, et
le DOSSIER tranche sur ce qui est pris). Toutes passent AVANT le déploiement du code qui les écrit :

- `api_idempotency.request_hash text` nullable : l'empreinte du corps. Une ligne d'avant (hash `null`) rejoue
  son rapport comme aujourd'hui.
- `campaign_recipients.variables jsonb` nullable : les variables d'un destinataire, relues à l'envoi d'un
  message RCS (un template résout les siennes à la construction, dans `resolved_params`, comme aujourd'hui).
- `contacts.external_id text` nullable, et son index unique PARTIEL `(tenant_id, external_id) where
  external_id is not null and deleted_at is null` : unique parmi les fiches ACTIVES, une fiche supprimée ne
  retient plus son identifiant (revue finale du 2026-09-24 ; ressusciter une fiche dont l'identifiant a été
  repris rend `identity_conflict`). ⚠️ `contacts` est la plus grosse table : l'index se crée `CONCURRENTLY`, donc
  dans une migration hors transaction (`-- migrate: no-transaction`), aux instructions idempotentes, avec
  `indisvalid` vérifié après coup (précédent : 0115).
- La table des échecs de messages libres (§ 5), avec un index qui sert la lecture du journal par espace et par
  date.
- La table du réglage Batch (§ 8) : une ligne par espace, secrets chiffrés, option du résumé.
- Si la migration 0027 contraint les intentions (§ 7) : sa contrainte relâchée pour les trois valeurs neuves.

## 12. Les lots

1. **Identité et contacts** : la fonction de résolution de fiche (§ 1), `external_id`, `POST` et `batch`
   refondus (`consent`, `identity_conflict`), `GET`, `search`, `PATCH`, droit `contacts:read`, identifiants
   affichés sur la fiche.
2. **Envois refondus** : destinataires par la résolution partagée, `consent` par destinataire, rapport par
   index sans perte silencieuse, codes unifiés, jugement de l'ouverture depuis un bloc (défaut 3), gardes
   alignées sur la console, catégorie lue chez Meta, idempotence en en-tête ou dans le corps avec empreinte,
   contrat de `GET /v1/sends`. `/v1/messages/whatsapp` remplace `/v1/messages`.
3. **RCS, variables, échecs** : cible `rcsMessage`, `/v1/messages/rcs` et sa fonction partagée avec l'Inbox,
   variables par destinataire, capture des échecs des messages libres et joignabilité RCS (défaut 4).
4. **Catalogues et doc** : les trois catalogues, la page réécrite (recette « un outil qui appelle par contact » comprise, sans nommer d'outil), le module
   d'exemples et son test, `features.md`.
5. **Intentions** : les trois valeurs neuves, le prompt, les écrans, et le connecteur HubSpot mis à jour et
   déployé AVANT.
6. **Signaux et adaptateur Batch** : les points d'émission, le réglage, la file, la poussée, les échecs dans
   le journal, la section « Ce que nous remontons ».
7. **Risque de désengagement, À CADRER** (demande de Julien du 2026-09-24, § 19) : un indicateur par contact,
   poussé dans l'outil du client par le dictionnaire du lot 6. Aucun plan tant que sa définition n'est pas
   tranchée.

## 13. Tests

- **Chaque défaut constaté a son test de non-régression, vérifié dans les deux sens** (remettre le code fautif,
  voir le test échouer avec le bon symptôme, restaurer) : contact bloqué perdu en silence, bloc sur une
  condition qui mène à un message rapide, scénario à ouverture de session accepté, template inconnu accepté,
  même clé d'idempotence avec un autre corps, échec d'un message libre écrit nulle part.
- **Parité** : `opening` rendu par le catalogue, par `/v1/sends` et par la console sur les mêmes graphes (la
  fonction est unique, le test le garde).
- **Identité** : chaque clé retrouve la même fiche ; deux clés sur deux fiches rendent `identity_conflict` sans
  rien écrire ; une clé neuve est rattachée ; `contactId` inconnu ne crée jamais rien ; l'adresse WhatsApp
  d'une fiche à numéro et BSUID reste le numéro, quelle que soit la clé reçue.
- **Consentement** : `consent: "opted_out"` pose le statut, la date et la ligne d'audit ; un `POST` sans
  `consent` ne rétrograde jamais ; le `consent` d'un destinataire est écrit AVANT le tri marketing.
- **Consentement RCS** : les quatre cas (`opted_in` sans message, message entrant sans `opted_in`, ni l'un ni
  l'autre, désabonné RCS), et l'opérateur de l'Inbox qui n'y est PAS soumis.
- **Idempotence** : en-tête seul, corps seul, les deux identiques, les deux différents.
- **Échecs** : un échec Meta et un échec smsmode d'un message libre écrivent une ligne, un échec de
  destinataire de campagne n'en écrit PAS de seconde, un statut `delivered` n'écrit rien ; la joignabilité RCS
  bascule dans les deux sens ; le journal rend la nouvelle source avec ses filtres.
- **Intentions** : la liste de `schema.ts`, le prompt et les libellés des écrans nomment les MÊMES valeurs
  (dérivé, pas relu à la main).
- **Adaptateur Batch** : la traduction du dictionnaire vers le corps de Batch est une fonction PURE testée ;
  tout nom d'événement tient en 30 caractères `[a-z0-9_]` ; aucun texte, de fiche ou d'événement, ne dépasse
  300 caractères ni n'est vide ; le résumé n'apparaît que si l'option est cochée, et il arrive entier, en
  morceaux ; une fiche sans `externalId` n'est pas poussée ; la file est
  dans `BASE_QUEUES` (`tests/queue-names.test.ts` le vérifie déjà pour toute file).
- **Intégration** (job `integration` de la CI, jamais en local : le `DATABASE_URL` local est la production) :
  `search`, `PATCH`, la résolution multi-clés, l'index d'`external_id`, la table des échecs et les migrations.

## 14. L'essai réel qui clôt la feature

Avec une VRAIE clé, en production, sur le numéro d'essai, en regardant le téléphone, Campagnes et l'Inbox :

1. `POST /v1/contacts` avec le numéro d'essai et un `externalId`, puis `GET` et `search` (par numéro, puis par
   `externalId`) rendent la même fiche, et son identifiant est celui qu'affiche la fiche du mini-CRM.
2. `POST /v1/sends` avec l'idempotence DANS LE CORPS : un template avec une variable par destinataire, puis un
   message RCS de la bibliothèque. Les deux arrivent sur le téléphone, la variable est remplie.
3. `POST /v1/messages/rcs` : le RCS libre arrive et apparaît dans l'Inbox. Puis vers un numéro NON RCS : le
   premier est accepté, son échec apparaît dans Sécurité > Journal des erreurs, le second rend
   `rcs_unreachable`.
4. `POST /v1/messages/whatsapp` dans la fenêtre (après avoir écrit depuis le téléphone), puis hors fenêtre :
   422 `window_closed`.
5. `PATCH` avec `consent: "opted_out"`, puis un envoi : écarté `opted_out`, et la ligne d'audit existe.
6. **Batch** : sur un espace Batch de test (à obtenir de Batch, c'est un prérequis), une étape Universal
   Channel appelle `/v1/sends`, le WhatsApp arrive, on y répond et on clique un lien ; les événements
   `em_message_delivered`, `em_replied`, `em_link_clicked`, puis `em_conversation_analyzed`, apparaissent sur
   le profil Batch. **Sans espace Batch de test, le lot 6 ne peut pas se clore** : il reste vert, pas éprouvé.

## 15. Méthode de livraison

**Implémenteur par lot, avec revue humaine du diff.** Ce sont des chemins que la production emprunte (envoi de
messages, écriture du consentement, traitement de chaque statut de livraison), porteurs d'invariants
invisibles (l'upsert qui ne sait que promouvoir, l'index partiel de chaque identité, le scellement de
l'idempotence AVANT l'enfilement, la fenêtre de 24 h, le chemin chaud des statuts). Un message parti ne se
rappelle pas. `/revue` après chaque lot, `/revue-finale` avant chaque déploiement.

## 16. Déploiement

- Les migrations passent AVANT le `up` de l'API qui les écrit (`compose build`, `migrate`, `up -d --build`),
  puis relecture en base juste après `migrate` (et `indisvalid` pour l'index d'`external_id`), et contrôle
  public des deux portes (502 de NPM).
- 🔴 **La doc se pousse APRÈS le déploiement de l'API.** Vercel publie la console à chaque push : une page qui
  décrit des routes que la production n'a pas encore tromperait l'intégrateur qui la lit. Même piège que
  l'onglet « Outils » du 2026-09-21. L'identifiant sur la fiche, lui, ne dépend d'aucune route neuve ; l'écran
  du réglage Batch, si : il suit la même règle.
- 🔴 **Le connecteur HubSpot se déploie AVANT les intentions neuves** (§ 7).
- `/v1/messages` disparaît au profit de `/v1/messages/whatsapp` : sans intégrateur branché, aucune transition.

## 17. Rayon de souffle déjà repéré

- `exigeFenetre24h` et ses tests (`tests/v1-sends.test.ts`) : la fonction disparaît, les cas qu'elle exerçait
  sont CONSERVÉS dans les tests du nouveau jugement (règle du dépôt : réécrire un test garde son cas).
- `scanOpening` sert la console, la liste des scénarios, le sélecteur de l'Inbox et l'éditeur : lui ajouter un
  point de départ ne doit rien changer à l'appel sans point de départ (`tests/workflow-ouverture.test.ts`,
  `tests/web-campaign-eligibility.test.ts`).
- `upsertContactsFromApi` sert AUSSI le webhook entrant et l'import de listes : `consent`, `externalId` et la
  résolution multi-clés ne doivent pas changer leur comportement. Le schéma de l'API se sépare de l'entrée
  partagée si besoin.
- `sendRcsFromInbox` devient une fonction partagée : le bouton de l'Inbox doit rester identique (e2e de
  l'envoi RCS dans l'Inbox).
- `processStatuses` et `onDlr` : chemins CHAUDS, chaque ajout y est best-effort (une exception y ferait
  rejouer tout le job par pg-boss) et ne coûte aucune requête sur un statut ordinaire (§ 5).
- Le journal des erreurs trie en mémoire deux sources aujourd'hui (`PgErreursLivraisonStore.lister`) : une
  troisième suit la même fusion bornée par `limit`.
- Les intentions (§ 7), et le connecteur HubSpot qui les reçoit.
- `features.md` (§ API publique : « deux périmètres », `/v1/messages`, `recipients`), `todo.md` (l'entrée
  « L'API publique v1 ne sait pas dire désabonné » se ferme), `documentation.md` si un invariant y décrit
  l'API ou le journal des erreurs.
- Le serveur MCP n'est PAS touché : ses outils désignent un fil par `conversation_id`, ce qui a du sens pour un
  agent qui lit l'Inbox.

## 18. Hors périmètre

- **Webhooks sortants GÉNÉRIQUES** (une adresse quelconque, un corps modelable) : le dictionnaire du § 8 en
  sera le contenu le jour où on les fait, mais cette spec ne construit que l'adaptateur Batch.
- **Adaptateurs Brevo, SFMC, Splio** : même dictionnaire, construits quand un client les tire.
- **Variables dans un scénario** : un parcours n'a pas de contexte où les ranger.
- **BSUID d'abord** pour le routage WhatsApp : changerait tous les envois, pas seulement l'API.
- **Suppression de fiche par API** (effacement RGPD) : irréversible, à discuter.
- **Les autres chemins qui lèvent encore un STOP** : l'import CSV, le WEBHOOK ENTRANT avec `optIn` (un outil
  tiers, par l'upsert partagé) et le bloc « Action » d'un scénario réabonnent encore un contact qui a dit STOP,
  alors que l'API ne le peut plus (§ 2, décision du 2026-09-24). Relevé par la revue finale du 2026-09-24 ;
  aligner ces trois chemins est à trancher par Julien à part.
  **Tranché le 2026-09-26 pour les upserts** : le webhook entrant, la création à la main et l'import HubSpot
  (qui passait lui aussi par l'upsert de l'import CSV) ne lèvent plus un STOP ; l'import CSV case cochée le
  peut, c'est l'opérateur qui le demande (`peutLeverStop`). Reste le bloc « Action » d'un scénario.
- **Statut de livraison sur la bulle de l'Inbox** : le § 5 écrit l'échec et le journal le montre ; l'afficher
  sur la bulle demanderait une jointure sur la lecture du fil, rafraîchie toutes les 4 secondes. À cadrer à
  part.

## 19. Lot 7 : le risque de désengagement (cadré le 2026-09-25)

**La demande** (Julien, 2026-09-24) : que l'outil du client porte toujours, pour chaque contact, un indicateur
clair de son risque de partir, calculé à partir des conversations, du non-engagement et de la lecture ou non
des messages. Ce n'est pas un « churn rate » (un taux sur une base entière, que seul le CRM connaît) : c'est un
RISQUE DE DÉSENGAGEMENT par contact, tiré des signaux conversationnels qui précèdent le départ.

**Décisions du cadrage** (Julien, 2026-09-25, en deux tours de questions) :

- **Quatre surfaces** : l'outil du client (attributs du dictionnaire des signaux, § 8), la fiche du mini-CRM,
  un filtre de la liste des contacts (donc ciblable par une campagne), et un champ de l'API publique.
- **Fenêtre d'observation** : 90 jours.
- **Toutes les familles de signaux** : réponses et clics, lecture, analyse, désabonnement et blocage.
- **Règles transparentes, pas un modèle appris** (aucune issue réelle pour calibrer : mesuré le 2026-09-25,
  la production porte 18 contacts dont 4 sollicités sur 90 jours).
- **Calcul chaque nuit**, espace par espace, et pas à chaque événement : le désengagement est une ABSENCE
  d'événement, et un seul chemin de calcul se teste mieux que deux.

**La grille** (points de risque, total plafonné à 100 ; validée telle quelle) :

| Signal, sur 90 jours | Code | Points |
|---|---|---|
| Aucun signe de vie (réponse, clic, lecture) depuis plus de 60 jours, avec au moins 2 messages délivrés | `silence_60j` | +40 |
| Aucun signe de vie depuis plus de 30 jours (même condition) | `silence_30j` | +25 |
| Les 3 derniers messages délivrés, sans réponse ni clic | `sans_reponse` | +15 |
| Les 3 derniers messages délivrés, non lus, SEULEMENT si le contact lit d'habitude | `non_lu` | +15 |
| Dernière conversation analysée : réclamation non résolue | `reclamation` | +20 |
| Dernière conversation analysée : sentiment négatif | `negatif` | +10 |
| Dernière conversation analysée : satisfaction de 3 sur 10 ou moins | `insatisfait` | +10 |
| Injoignable au dernier envoi (WhatsApp ou RCS) | `injoignable` | +10 |
| A répondu ou cliqué dans les 14 derniers jours | (allègement) | -25, plancher 0 |
| Désabonné (STOP) ou bloqué | `stop`, `bloque` | 100 d'office |

- `silence_60j` et `silence_30j` sont exclusifs (le plus fort s'applique).
- **« Lit d'habitude »** = au moins un « lu » sur la fenêtre. Un contact qui répond sans jamais renvoyer « lu »
  a coupé ses accusés de lecture : la lecture n'est pas comptée pour lui (1 contact sur 4 dans la mesure).
- **Niveaux** : `faible` de 0 à 29, `moyen` de 30 à 59, `eleve` de 60 à 100. **`inconnu`**, sans score, quand
  aucun message n'a été délivré au contact sur la fenêtre (on ne dit pas qu'un contact est fidèle ou perdu sans
  l'avoir observé). Un STOP ou un blocage donne `eleve` à 100 même sans historique.
- **Raisons** : les trois contributions les plus lourdes, en codes courts (texte de 300 caractères au plus
  côté outil).
- **Limite assumée de la V1** : la lecture et la livraison ne se mesurent que sur les envois de CAMPAGNE (seuls
  à porter un statut par destinataire) ; un message libre ou un bloc de scénario ne compte que par la réponse
  qu'il reçoit.

**Ce que le changement de niveau déclenche** :
- un événement `em_risk_changed` vers l'outil du client (ancien niveau, nouveau niveau, score, raisons), en
  plus des attributs de fiche `em_risk_level`, `em_risk_score`, `em_risk_reasons` ;
- un déclencheur d'automation « risque élevé », émis par le balayage de nuit quand un contact PASSE en élevé.
  🔴 C'est un chemin de MASSE (une nuit peut faire basculer beaucoup de contacts, chacun pouvant lancer un
  scénario facturé) : il est borné par le plafond horaire existant de chaque automation ET par un plafond de
  **200 déclenchements par nuit et par espace** ; au-delà, le niveau est écrit sans déclencher, et c'est
  journalisé.

**Essai réel** : un contact d'essai laissé sans réponse passe en moyen puis en élevé ; on le constate sur la
fiche, dans le filtre, dans l'API, dans l'outil branché, et par le scénario déclenché. Le seuil de silence est
paramétrable dans les tests seulement, pour ne pas attendre 30 jours.
