<!-- Version Markdown de https://console.messagingme.app/developers/api/contacts, générée depuis la page (npm run doc:md). English: https://console.messagingme.app/developers/api/contacts.en.md -->

# Contacts

Une fiche se désigne par ses clés : [Désigner une personne](https://console.messagingme.app/developers/api/concepts.md#identification).

Sur cette page

|   |   |
| --- | --- |
| POST | [/v1/contacts](https://console.messagingme.app/developers/api/contacts.md#creer) : Crée ou met à jour une fiche. |
| POST | [/v1/contacts/batch](https://console.messagingme.app/developers/api/contacts.md#lot) : Crée ou met à jour jusqu’à 50 fiches en un appel. |
| GET | [/v1/contacts/{contactId}](https://console.messagingme.app/developers/api/contacts.md#lire) : Lit une fiche. |
| POST | [/v1/contacts/search](https://console.messagingme.app/developers/api/contacts.md#rechercher) : Cherche une fiche par téléphone, BSUID ou identifiant externe. |
| DELETE | [/v1/contacts/{contactId}](https://console.messagingme.app/developers/api/contacts.md#effacer) : Efface une fiche pour de vrai (RGPD), dans la limite du jour de l’offre. |
| GET | [/v1/fields](https://console.messagingme.app/developers/api/contacts.md#champs) : Liste les champs personnalisés : les clés à utiliser dans fields. |
| POST | [/v1/fields](https://console.messagingme.app/developers/api/contacts.md#creer-champ) : Crée un champ personnalisé ; sa clé vient du libellé. |
| PATCH | [/v1/contacts/{contactId}](https://console.messagingme.app/developers/api/contacts.md#modifier) : Modifie les champs, les tags, le consentement ou l’identifiant externe d’une fiche. |

<a id="creer"></a>

## POST /v1/contacts

Crée ou met à jour une fiche.

Droit : `contacts:write`

### Requête

| Champ | Obligatoire | Description |
| --- | --- | --- |
| `contactId` : uuid | Une clé au moins | L’identifiant de la fiche, rendu à sa création. [Désigner une personne](https://console.messagingme.app/developers/api/concepts.md#identification) |
| `externalId` : string | Une clé au moins | Votre identifiant de la personne, unique par espace, 512 caractères au plus. |
| `phone` : string | Une clé au moins | Le numéro, au format international (+33…). |
| `bsuid` : string | Une clé au moins | L’identifiant WhatsApp d’une personne sans numéro visible. |
| `name` : string | Non | Le nom affiché. |
| `fields` : object | Non | Les champs de la fiche, par clé technique ou code fld_, 20 au plus. Valeur texte, nombre ou booléen, enregistrée en texte. Un champ inconnu de l’espace est refusé : créez-le d’abord dans la console (Bibliothèque > Champs). |
| `tags` : string[] | Non | Des tags à ajouter, 20 au plus. Aucun n’est retiré : PATCH le fait. Un tag inconnu de l’espace est refusé : déclarez-le d’abord dans la console (Bibliothèque > Étiquettes). |
| `consent` : string | Non | Absent : inchangé. Valeurs : `opted_in` , `opted_out`. [Consentement et STOP](https://console.messagingme.app/developers/api/concepts.md#consentement) |
| `consentSource` : string | Non | D’où vient le consentement, 100 caractères au plus. Absent : api. |

Une clé inconnue est ignorée. Refusées : `optIn` , `optInSource` (les anciens noms de consent et consentSource).

_Commande_

```
curl -X POST https://api.messagingme.app/v1/contacts \
  -H "Authorization: Bearer mba_xxxxxxxxxxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{
  "phone": "+33612345678",
  "externalId": "crm-7781",
  "name": "Camille Roy",
  "fields": {
    "ville": "Lyon"
  },
  "tags": [
    "prospect"
  ],
  "consent": "opted_in",
  "consentSource": "formulaire-site"
}'
```

### Réponse 200

_JSON_

```
{
  "contactId": "5f0c1e2a-8b7d-4c3e-9a1f-2d6b7e8c9f01",
  "status": "created"
}
```

status : created ou updated. Le statut HTTP est 200 dans les deux cas.

### Erreurs

| Statut | Code | Cause |
| --- | --- | --- |
| 400 | `invalid_body` | Champ mal formé ou refusé, trop de champs ou de tags, champ ou tag inconnu de l’espace ; le message le nomme. |
| 404 | `unknown_contact` | Aucune fiche trouvée, et ni phone ni bsuid pour en créer une (un externalId seul, par exemple). |
| 409 | `opted_out` | consent opted_in sur une fiche désabonnée. Rien n’est modifié. |
| 400, 409 | `invalid_recipient` `invalid_phone` `identity_conflict` | Clés de fiche absentes, illisibles ou contradictoires : [Désigner une personne](https://console.messagingme.app/developers/api/concepts.md#identification) |

<a id="lot"></a>

## POST /v1/contacts/batch

Crée ou met à jour jusqu’à 50 fiches en un appel.

Droit : `contacts:write`

### Requête

| Champ | Obligatoire | Description |
| --- | --- | --- |
| `contacts` : object[] | Oui | De 1 à 50 fiches, chacune avec les champs de POST /v1/contacts, mais 10 champs et 10 tags au plus par fiche. |

Une clé inconnue est ignorée.

_Commande_

```
curl -X POST https://api.messagingme.app/v1/contacts/batch \
  -H "Authorization: Bearer mba_xxxxxxxxxxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{
  "contacts": [
    {
      "phone": "+33612345678",
      "externalId": "crm-7781"
    },
    {
      "phone": "+33698765432",
      "externalId": "crm-7782",
      "consent": "opted_out",
      "consentSource": "desinscription-email"
    }
  ]
}'
```

### Réponse 200

_JSON_

```
{
  "results": [
    {
      "index": 0,
      "status": "updated",
      "contactId": "5f0c1e2a-8b7d-4c3e-9a1f-2d6b7e8c9f01"
    },
    {
      "index": 1,
      "status": "created",
      "contactId": "7a3d9c10-2e4b-4f6a-b8c1-0d9e8f7a6b5c"
    }
  ],
  "created": 1,
  "updated": 1,
  "errors": 0
}
```

| Champ | Sens |
| --- | --- |
| `results` | Un résultat par élément, dans l’ordre : index, status (created, updated ou error), et pour un refus code et reason. |
| `created`, `updated`, `errors` | Le nombre de résultats de chaque status. |

### Erreurs

| Statut | Code | Cause |
| --- | --- | --- |
| 400 | `invalid_body` | contacts absent, vide, ou trop long. |

### Notes

- Un élément refusé (mal formé, trop de champs ou de tags, champ ou tag inconnu) n’arrête pas les autres.
- Les éléments qui désignent la même personne s’écrivent dans l’ordre du lot.
- Importer un fichier : envoyez-le par lots de 50, comme ci-dessous (un module : fichier .mjs). Le débit dépend de l’offre de votre espace (les en-têtes x-ratelimit de chaque réponse le disent), et les fiches écrites ont un quota de 20000 par jour. Un 429 n’a rien écrit : attendez Retry-After (jusqu’à minuit pour le quota du jour) et renvoyez le même lot. Un très gros fichier passe plus vite par l’import CSV de la console.

_Importer un CSV simple (phone,name), Node.js_

```
import { readFileSync } from 'node:fs';

const lignes = readFileSync('contacts.csv', 'utf8').trim().split(/\r?\n/).slice(1);
const fiches = lignes.map((l) => { const [phone, name] = l.split(','); return { phone, name }; });

for (let i = 0; i < fiches.length; ) {
  const r = await fetch('https://api.messagingme.app/v1/contacts/batch', {
    method: 'POST',
    headers: { authorization: 'Bearer mba_xxxxxxxxxxxxxxxx', 'content-type': 'application/json' },
    body: JSON.stringify({ contacts: fiches.slice(i, i + 50) }),
  });
  if (r.status === 429) {
    await new Promise((ok) => setTimeout(ok, Number(r.headers.get('retry-after') ?? 2) * 1000));
    continue;
  }
  if (!r.ok) throw new Error(await r.text());
  const { results } = await r.json();
  for (const e of results.filter((x) => x.status === 'error')) console.log(i + e.index, e.code, e.reason);
  i += 50;
}
```

<a id="lire"></a>

## GET /v1/contacts/{contactId}

Lit une fiche.

Droit : `contacts:read`

### Requête

contactId, dans le chemin.

_Commande_

```
curl https://api.messagingme.app/v1/contacts/5f0c1e2a-8b7d-4c3e-9a1f-2d6b7e8c9f01 \
  -H "Authorization: Bearer mba_xxxxxxxxxxxxxxxx"
```

### Réponse 200

_JSON_

```
{
  "contactId": "5f0c1e2a-8b7d-4c3e-9a1f-2d6b7e8c9f01",
  "externalId": "crm-7781",
  "phone": "+33612345678",
  "bsuid": null,
  "name": "Camille Roy",
  "fields": {
    "ville": "Lyon"
  },
  "tags": [
    "prospect"
  ],
  "consent": {
    "status": "opted_in",
    "source": "formulaire-site",
    "optedOutAt": null
  },
  "rcsOptedOutAt": null,
  "blocked": false,
  "reachability": {
    "whatsapp": true,
    "rcs": null
  },
  "engagementRisk": {
    "level": "moyen",
    "score": 40,
    "reasons": [
      "silence_60j"
    ],
    "computedAt": "2026-09-25T03:05:00.000Z"
  },
  "lastAnalysis": {
    "intent": "suivi_commande",
    "sentiment": "negatif",
    "satisfaction": 3,
    "urgency": 7,
    "resolved": false,
    "topic": "Colis en retard",
    "handledBy": "humain",
    "actionSuggestion": "rappeler",
    "analyzedAt": "2026-09-26T14:32:00.000Z"
  },
  "createdAt": "2026-09-24T10:00:00.000Z"
}
```

| Champ | Sens |
| --- | --- |
| `consent` | status : opted_in, opted_out ou unknown. source : son origine. optedOutAt : date du désabonnement. |
| `rcsOptedOutAt` | Date d’un STOP sur le canal RCS, sinon null. |
| `blocked` | true : un message vers la fiche est refusé, un envoi l’écarte. |
| `reachability` | true ou false quand un envoi l’a appris, null sinon. |

`engagementRisk` : risque de désengagement, recalculé chaque nuit sur les 90 derniers jours (réponses, clics, lectures, dernière conversation analysée, joignabilité, désabonnement, blocage). null s’il n’a jamais été calculé. level : `faible` (score 0 à 29), `moyen` (30 à 59), `eleve` (60 à 100), `inconnu` (score null : aucun message délivré sur la période). Désabonnement ou blocage : eleve, score 100. reasons : 3 codes au plus, du plus lourd au plus léger, parmi `stop`, `bloque`, `silence_60j`, `silence_30j`, `sans_reponse`, `non_lu`, `reclamation`, `negatif`, `insatisfait`, `injoignable`. computedAt : date du passage à ce niveau ; elle ne change qu’avec le niveau, score et reasons sont toujours à jour.

`lastAnalysis` : la dernière analyse de conversation du contact, recopiée sur sa fiche ; elle reste là quand la conversation est effacée. null s’il n’a jamais été analysé. Lecture seule : envoyée dans un POST ou un PATCH, elle est ignorée. intent : `demande_devis`, `sav`, `reclamation`, `information`, `prise_rdv`, `achat`, `suivi_commande`, `retour`, `autre`. sentiment : `positif`, `neutre`, `negatif`. satisfaction et urgency : de 0 à 10, null quand l’analyse n’a pas pu les mesurer (0 est une vraie mesure). resolved : la conversation est-elle résolue. topic : son sujet, en clair. handledBy : `humain`, `automatise`, `mba`. actionSuggestion : `creer_devis`, `rappeler`, `relancer`, `escalader`, `aucune`. analyzedAt : la date de l’analyse. Le résumé de la conversation n’en fait pas partie : il reprend les propos du client.

### Erreurs

| Statut | Code | Cause |
| --- | --- | --- |
| 404 | `unknown_contact` | Fiche inconnue ou supprimée. |

<a id="rechercher"></a>

## POST /v1/contacts/search

Cherche une fiche par téléphone, BSUID ou identifiant externe.

Droit : `contacts:read`

### Requête

| Champ | Obligatoire | Description |
| --- | --- | --- |
| `externalId` : string | Exactement une | Votre identifiant de la personne, unique par espace, 512 caractères au plus. |
| `phone` : string | Exactement une | Le numéro, au format international (+33…). |
| `bsuid` : string | Exactement une | L’identifiant WhatsApp d’une personne sans numéro visible. |

Une clé inconnue est ignorée.

_Commande_

```
curl -X POST https://api.messagingme.app/v1/contacts/search \
  -H "Authorization: Bearer mba_xxxxxxxxxxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{
  "externalId": "crm-7781"
}'
```

### Réponse 200

_JSON_

```
{
  "contact": {
    "contactId": "5f0c1e2a-8b7d-4c3e-9a1f-2d6b7e8c9f01",
    "externalId": "crm-7781",
    "phone": "+33612345678",
    "bsuid": null,
    "name": "Camille Roy",
    "fields": {
      "ville": "Lyon"
    },
    "tags": [
      "prospect"
    ],
    "consent": {
      "status": "opted_in",
      "source": "formulaire-site",
      "optedOutAt": null
    },
    "rcsOptedOutAt": null,
    "blocked": false,
    "reachability": {
      "whatsapp": true,
      "rcs": null
    },
    "engagementRisk": {
      "level": "moyen",
      "score": 40,
      "reasons": [
        "silence_60j"
      ],
      "computedAt": "2026-09-25T03:05:00.000Z"
    },
    "lastAnalysis": {
      "intent": "suivi_commande",
      "sentiment": "negatif",
      "satisfaction": 3,
      "urgency": 7,
      "resolved": false,
      "topic": "Colis en retard",
      "handledBy": "humain",
      "actionSuggestion": "rappeler",
      "analyzedAt": "2026-09-26T14:32:00.000Z"
    },
    "createdAt": "2026-09-24T10:00:00.000Z"
  }
}
```

contact : la fiche, sous la forme de GET /v1/contacts/{contactId}, ou null. Rien n’est créé ni rattaché.

### Erreurs

| Statut | Code | Cause |
| --- | --- | --- |
| 400 | `invalid_body` | Aucune clé, ou plusieurs. |
| 400 | `invalid_phone` | Numéro illisible. |

<a id="modifier"></a>

## PATCH /v1/contacts/{contactId}

Modifie les champs, les tags, le consentement ou l’identifiant externe d’une fiche.

Droit : `contacts:write`

### Requête

contactId, dans le chemin. Corps : au moins un champ.

| Champ | Obligatoire | Description |
| --- | --- | --- |
| `name` : string | Non | Le nouveau nom. null le vide. |
| `fields` : object | Non | Fusionnés avec les champs de la fiche, 20 au plus. Une valeur null vide le champ. Un champ inconnu de l’espace est refusé. |
| `addTags` : string[] | Non | Des tags à ajouter, 20 au plus. Un tag inconnu de l’espace est refusé. |
| `removeTags` : string[] | Non | Des tags à retirer, 20 au plus. |
| `consent` : string | Non | Absent : inchangé. Valeurs : `opted_in` , `opted_out`. [Consentement et STOP](https://console.messagingme.app/developers/api/concepts.md#consentement) |
| `consentSource` : string | Non | D’où vient le consentement, 100 caractères au plus. Absent : api. |
| `externalId` : string | Non | Pose ou remplace votre identifiant, 512 caractères au plus. |

Une clé inconnue est ignorée. Refusées : `phone` , `bsuid` (ils portent les conversations de la fiche).

_Commande_

```
curl -X PATCH https://api.messagingme.app/v1/contacts/5f0c1e2a-8b7d-4c3e-9a1f-2d6b7e8c9f01 \
  -H "Authorization: Bearer mba_xxxxxxxxxxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{
  "fields": {
    "ville": "Grenoble",
    "code_promo": null
  },
  "addTags": [
    "client"
  ],
  "removeTags": [
    "prospect"
  ],
  "consent": "opted_out",
  "consentSource": "centre-de-preferences"
}'
```

### Réponse 200

_JSON_

```
{
  "contactId": "5f0c1e2a-8b7d-4c3e-9a1f-2d6b7e8c9f01"
}
```

### Erreurs

| Statut | Code | Cause |
| --- | --- | --- |
| 400 | `invalid_body` | Rien à modifier, trop de champs ou de tags, champ ou tag à ajouter inconnu de l’espace, ou valeur refusée. |
| 404 | `unknown_contact` | Fiche inconnue. |
| 409 | `identity_conflict` | externalId déjà porté par une autre fiche. |
| 409 | `opted_out` | consent opted_in sur une fiche désabonnée. |

<a id="effacer"></a>

## DELETE /v1/contacts/{contactId}

Efface une fiche pour de vrai (RGPD), dans la limite du jour de l’offre.

Droit : `contacts:admin`

Avec le droit contacts:admin. Irréversible : la fiche, ses conversations, ses messages et son analyse sont effacés ; ce qui porte les compteurs est anonymisé. Dans la limite du jour de l’offre (10 en formule Free, sans limite en formules Pro et Entreprise). Une fiche désabonnée (STOP) laisse une empreinte de son numéro, illisible sans notre clé, gardée trois ans après le STOP : recréée, elle naît désabonnée.

### Réponse 200

_JSON_

```
{
  "deleted": true,
  "conversations": 1,
  "messages": 14
}
```

### Erreurs

| Statut | Code | Cause |
| --- | --- | --- |
| 404 | `unknown_contact` | Fiche inconnue de cet espace, ou déjà effacée (la limite du jour n’est pas entamée). |
| 402 | `plan_limit_reached` | Limite d’effacements du jour de l’offre atteinte. |
| 429 | `rate_limited` | Trop d’opérations lourdes sur cet espace (10 par minute, comme la purge de la console) : réessayer après Retry-After. |

<a id="champs"></a>

## GET /v1/fields

Liste les champs personnalisés : les clés à utiliser dans fields.

Droit : `contacts:read`

_Commande_

```
curl https://api.messagingme.app/v1/fields \
  -H "Authorization: Bearer mba_xxxxxxxxxxxxxxxx"
```

### Réponse 200

_JSON_

```
{
  "data": [
    {
      "key": "numero_commande",
      "label": "Numéro de commande",
      "type": "text"
    },
    {
      "key": "date_de_naissance",
      "label": "Date de naissance",
      "type": "date"
    }
  ]
}
```

key est la clé à utiliser dans fields d’une fiche ; type : text, number, date, datetime, boolean ou url.

<a id="creer-champ"></a>

## POST /v1/fields

Crée un champ personnalisé ; sa clé vient du libellé.

Droit : `contacts:admin`

_Commande_

```
curl -X POST https://api.messagingme.app/v1/fields \
  -H "Authorization: Bearer mba_xxxxxxxxxxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{
  "label": "Date de naissance",
  "type": "date"
}'
```

### Réponse 201

_JSON_

```
{
  "key": "date_de_naissance",
  "label": "Date de naissance",
  "type": "date"
}
```

La clé vient du libellé (minuscules, sans accents, _ entre les mots) et ne change plus. Renommer ou supprimer un champ se fait dans la console.

### Erreurs

| Statut | Code | Cause |
| --- | --- | --- |
| 400 | `invalid_body` | Libellé vide ou trop long (100), type inconnu. |
| 409 | `field_exists` | Un champ porte déjà cette clé, ou c’est le libellé d’un champ de base (Nom, Téléphone…). |
