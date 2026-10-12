<!-- Version Markdown de https://console.messagingme.app/developers/api/reference, générée depuis la page (npm run doc:md). English: https://console.messagingme.app/developers/api/reference.en.md -->

# Authentification, limites et erreurs

Valable pour toutes les routes.

<a id="authentification"></a>

## Authentification et droits

- Une clé par appel, dans l’en-tête Authorization. Elle commence par mba_.
- L’espace se déduit de la clé : aucune adresse ne porte d’identifiant d’espace.
- Adresse de base : [Accueil](https://console.messagingme.app/developers/api.md#adresse).
- Le droit de chaque route, ses erreurs et ses formes, lisibles par une machine : [le contrat OpenAPI](https://console.messagingme.app/developers/api.md#openapi).

_En-tête_

```
Authorization: Bearer mba_xxxxxxxxxxxxxxxx
```

| Droit | Ouvre | Routes |
| --- | --- | --- |
| `contacts:write` | Créer et modifier des fiches. | POST /v1/contacts POST /v1/contacts/batch PATCH /v1/contacts/{contactId} |
| `contacts:read` | Lire et chercher des fiches. | GET /v1/contacts/{contactId} POST /v1/contacts/search GET /v1/fields |
| `sends:create` | Envoyer, suivre un envoi, lire les catalogues. | POST /v1/messages POST /v1/messages/whatsapp POST /v1/messages/rcs POST /v1/sends GET /v1/sends/{sendId} GET /v1/templates GET /v1/scenarios GET /v1/rcs-messages |
| `conversations:read` | Lire les conversations, leurs messages et les fichiers reçus. | GET /v1/conversations GET /v1/conversations/{conversationId} GET /v1/conversations/{conversationId}/messages GET /v1/messages/{messageId} GET /v1/messages/{messageId}/media |
| `templates:write` | Créer des modèles et suivre leur validation par Meta. | POST /v1/templates GET /v1/templates/{name} |
| `contacts:admin` | Créer des champs personnalisés et effacer une fiche pour de vrai (RGPD). | DELETE /v1/contacts/{contactId} POST /v1/fields |
| `webhooks:write` | Gérer les webhooks sortants, lire et rejouer leur journal (il porte des données de contacts). | GET /v1/webhooks POST /v1/webhooks GET /v1/webhooks/{webhookId} PATCH /v1/webhooks/{webhookId} POST /v1/webhooks/{webhookId}/rotate-secret DELETE /v1/webhooks/{webhookId} POST /v1/webhooks/{webhookId}/test GET /v1/webhooks/{webhookId}/deliveries POST /v1/webhooks/deliveries/{deliveryId}/replay POST /v1/webhooks/{webhookId}/replay-failures |

| Statut | Code | Cause |
| --- | --- | --- |
| 401 | `unauthorized` | Clé absente, mal formée, inconnue ou révoquée. |
| 403 | `missing_scope` | Droit manquant. |
| 403 | `tenant_locked` | Espace suspendu. La clé reste valide. |

> **Note**
>
> Les droits d’une clé se fixent à sa création. Pour un droit de plus : une nouvelle clé.

<a id="debit"></a>

## Débit

| Plafond par défaut, par espace | Valeur |
| --- | --- |
| Requêtes par minute | 60 |
| Requêtes par heure | 1000 |

- Partagé par toutes les clés de l’espace et le serveur MCP.
- Un appel compte pour un, quel que soit son volume (50 fiches en un lot : un appel).
- Plafond différent pour un espace : sur demande.

Chaque réponse comptée porte le compteur le plus proche de son plafond :

_En-têtes de réponse_

```
x-ratelimit-limit: 60
x-ratelimit-remaining: 57
x-ratelimit-reset: 1790000000
```

| En-tête | Sens |
| --- | --- |
| `x-ratelimit-reset` | Heure de remise à zéro, en secondes depuis 1970. |
| `retry-after` | Sur un 429 : secondes avant la remise à zéro de la fenêtre pleine (minute ou heure, nommée dans le message). |

- Au dépassement : 429 `rate_limited`. Un appel refusé ne compte pas.
- Clé inconnue (401) : aucun de ces en-têtes.

<a id="quotas"></a>

En plus du débit, un quota QUOTIDIEN par espace compte le travail DEMANDÉ (un destinataire écarté ensuite compte quand même) :

| Quota par défaut, par espace et par jour | Valeur |
| --- | --- |
| Envois : destinataires d’un envoi, et messages libres WhatsApp ou RCS | 2000 |
| Fiches écrites (une par fiche d’un lot) | 20000 |

- Remise à zéro à minuit, heure de Paris.
- Une requête qui dépasserait le quota est refusée en entier : 429 `quota_exceeded`, avec retry-after jusqu’à minuit. Un lot plus petit peut encore passer.
- Un nouvel appel avec la même clé d’idempotence ne compte pas, qu’il rejoue un envoi fini ou tombe sur un envoi en cours (409). Un envoi refusé par le quota libère sa clé.
- Les lectures, les catalogues et les campagnes lancées depuis la console n’ont pas de quota. Le serveur MCP non plus, sauf l’envoi d’un modèle, qui compte dans les envois.
- Quota différent pour un espace : sur demande.

> **Note**
>
> Compteurs tenus en base et partagés par toutes les copies du serveur : un déploiement ne les remet pas à zéro.

<a id="erreurs"></a>

## Erreurs

Forme d’un refus :

_JSON_

```
{
  "error": "fenêtre de 24 h fermée : cette personne n’a pas écrit récemment. Utilisez un template (POST /v1/sends).",
  "code": "window_closed"
}
```

- error : phrase en français, pour un humain. code : identifiant stable, pour un programme.
- Un refus porte le même code partout, en erreur comme en motif d’écart d’un envoi.
- Corps JSON lisible mais mal formé : invalid_body, champ fautif dans le message. Clé de fiche absente ou illisible : invalid_recipient, invalid_phone.

| Statut | Sens |
| --- | --- |
| 400 | Corps invalide. |
| 401 | Clé absente ou invalide. |
| 403 | Droit manquant, ou espace suspendu. |
| 404 | Fiche, envoi ou cible introuvable. |
| 409 | L’état de la fiche ou de l’espace interdit l’opération : désabonnée, bloquée, sans consentement, clés contradictoires, canal ou numéro absent, nom de scénario ambigu, clé d’idempotence en cours. |
| 422 | Corps valide, mais l’envoi est impossible en l’état : fenêtre fermée, cible non envoyable, catégorie illisible, fiche sans numéro, numéro injoignable en RCS, clé d’idempotence déjà utilisée, refus de Meta. |
| 429 | Débit ou quota quotidien dépassé. |

Chaque code, quand il arrive et quoi faire, avec les erreurs de Meta : [le catalogue des erreurs](https://console.messagingme.app/developers/api/errors.md).

> **Attention**
>
> Un JSON illisible est lu comme un objet vide : le refus nomme ce qui manque, pas la syntaxe. Toujours envoyer Content-Type: application/json.
