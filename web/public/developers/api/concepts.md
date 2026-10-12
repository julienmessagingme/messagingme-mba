<!-- Version Markdown de https://console.messagingme.app/developers/api/concepts, générée depuis la page (npm run doc:md). English: https://console.messagingme.app/developers/api/concepts.en.md -->

# Concepts

Les règles communes à plusieurs routes.

<a id="identification"></a>

## Désigner une personne

Une personne est une fiche. Quatre clés la désignent :

| Clé | Ce que c’est |
| --- | --- |
| `contactId` | Identifiant de la fiche, créé avec elle. Affiché sur la fiche du mini-CRM (« Identifiant API », bouton Copier). |
| `externalId` | Identifiant de la personne dans votre outil (CRM, plateforme marketing), gardé sur la fiche. Unique par espace, 512 caractères au plus. |
| `phone` | Numéro au format international (+33…). Sans indicatif : lu comme français. |
| `bsuid` | Identifiant WhatsApp d’une personne qui écrit sous un nom d’utilisateur, sans numéro visible. |

- Au moins une clé, sinon `invalid_recipient`. Numéro illisible : `invalid_phone`.
- Toutes les clés données désignent la même fiche, sinon `identity_conflict` et rien n’est modifié.
- Une clé que la fiche ne porte pas encore lui est rattachée : un externalId envoyé avec le numéro se pose sur la fiche.
- contactId ne se rattache jamais : il existe, ou il est inconnu.

| Route | Aucune fiche ne correspond |
| --- | --- |
| POST /v1/contacts, POST /v1/contacts/batch | Fiche créée avec un phone ou un bsuid. |
| POST /v1/sends | Fiche créée avec un phone, sauf ouverture whatsapp_session. |
| Autres routes | Aucune création. |

Pas de création possible : `unknown_contact`.

> **Note**
>
> L’adresse d’envoi vient de la fiche, jamais de la clé reçue. WhatsApp : le numéro, sinon le BSUID. RCS : le numéro (fiche sans numéro : `no_phone`).

<a id="consentement"></a>

## Consentement et STOP

| Champ | Effet |
| --- | --- |
| `consent` = `opted_in` | Enregistre le consentement. |
| `consent` = `opted_out` | Désabonne : statut, date, ligne au journal d’audit. |
| `consent` absent | Aucun changement. |
| `consentSource` | Origine du consentement. Absent : api. |

> **Attention**
>
> opted_in ne lève jamais un STOP : sur une fiche désabonnée, 409 `opted_out`, rien n’est modifié. Seuls un opérateur ou la personne elle-même peuvent la réabonner.

- POST /v1/sends : consent par destinataire, même effet, écrit sur la fiche avant le tri. opted_out écarte le destinataire.
- Exigences d’une catégorie d’envoi : [Catégorie](https://console.messagingme.app/developers/api/sends.md#categorie) ; d’un message RCS : [POST /v1/messages/rcs](https://console.messagingme.app/developers/api/messages.md#message-rcs).

<a id="fenetre-24h"></a>

## La fenêtre de 24 h

- Règle de Meta : s’ouvre quand la personne écrit, se ferme 24 h après son dernier message.
- Hors fenêtre, seul un template peut partir (POST /v1/sends).
- S’applique à [POST /v1/messages/whatsapp](https://console.messagingme.app/developers/api/messages.md#message-whatsapp) et aux envois qui ouvrent en whatsapp_session ([Message d’ouverture](https://console.messagingme.app/developers/api/sends.md#ouverture)). Fermée : `window_closed`.
- Pas de fenêtre en RCS.

<a id="idempotence"></a>

## Idempotence

Seul POST /v1/sends porte une clé d’idempotence. Les messages n’en ont pas ([Message ou envoi](https://console.messagingme.app/developers/api/messages.md#messages-simples)).

> **Obligatoire**
>
> Clé obligatoire : en-tête Idempotency-Key ou champ idempotencyKey. Absente : 400 `idempotency_key_required`.

_En-tête_

```
Idempotency-Key: confirmation-8412
```

| Cas | Réponse |
| --- | --- |
| Même clé, même corps | Le rapport 201 du premier appel, tel quel, même si la cible a changé depuis. Rien n’est renvoyé. |
| Même clé, autre corps | 422 `idempotency_key_reused` |
| Premier appel encore en cours | 409 `idempotency_in_progress` |
| Premier appel interrompu avant sa réponse (coupure, panne) | Rejouer la même clé rend son rapport si l’envoi a abouti ; sinon la clé reste en cours 5 min au plus, puis se libère, et la même clé crée l’envoi, une seule fois. |
| En-tête et champ présents et différents | 400 `invalid_body` |
| Envoi refusé (cible introuvable, numéro absent…) | Clé libérée : l’appel corrigé repart avec la même. |

Durée de vie d’une clé : 24 h au moins. Composer la clé pour un outil qui appelle par contact : [La clé d’idempotence](https://console.messagingme.app/developers/api/guides/per-contact.md#cle).
