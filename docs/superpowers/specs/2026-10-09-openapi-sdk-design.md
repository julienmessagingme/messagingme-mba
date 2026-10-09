# Le contrat OpenAPI et le SDK TypeScript : conception (lot 16)

2026-10-09 · décisions de Julien, prises en cadrage le même jour.

Un intégrateur lit aujourd'hui la doc de l'API (`/developers/api`) et écrit son client à la main. Ce lot publie le
CONTRAT de l'API, dérivé du code (jamais écrit à part : un contrat écrit à côté est un second inventaire, donc une
divergence programmée), et un SDK TypeScript qui en tire ses types.

## Méthode de livraison

**Implémenteur par lot, puis une relecture.** Le contrat est une promesse publique faite aux intégrateurs, et le lot
ajoute une route anonyme ; mais aucun chemin d'envoi ni de données ne change, et chaque critère se vérifie par un test.
Deux livraisons : **A**, le contrat (registre, génération, `GET /openapi.json`, liens) ; **B**, le SDK (`sdk/`, son
dépôt dédié). L'essai réel : section 6.

## Décisions de Julien (2026-10-09)

| Question | Décision |
| --- | --- |
| Où vit le contrat | Servi par l'API, `GET https://api.messagingme.app/openapi.json`, toujours égal au code déployé ; lié depuis la doc de l'API et `llms.txt` |
| Ce qu'il décrit | Les routes `/v1` ET les événements que nos webhooks envoient (section `webhooks` d'OpenAPI 3.1) |
| Distribution du SDK | Sur GitHub, sans npm : un dépôt public dédié `messagingme-sdk`, rempli automatiquement depuis `sdk/` de ce dépôt |
| Contenu du SDK | Un client typé sans dépendance (fetch natif), des erreurs typées avec leur code et `Retry-After`, et la vérification de signature des webhooks ; aucune relance automatique |

## 1. Le registre, seule source du contrat

`src/api/openapi/` porte un REGISTRE : pour chaque route `/v1`, sa méthode, son chemin, son droit, son résumé (repris
de l'index des points d'entrée de la doc), le schéma Zod de son corps et de ses paramètres (ceux que la route utilise
déjà, exportés), le schéma de sa réponse, et ses codes d'erreur. Les schémas de RÉPONSE sont neufs (en Zod) : chacun est
tenu par un test qui y fait passer l'exemple de réponse de la doc (`web/lib/api-exemples.ts`, déjà typé par son
producteur). Zod 4 rend le JSON Schema lui-même (`z.toJSONSchema`, côté entrée) : aucune dépendance.

Trois tests tiennent le registre : chaque route `/v1` montée par Fastify y figure, et aucune n'y figure sans être
montée ; chaque exemple de corps et de réponse de la doc valide son schéma ; le document produit est un OpenAPI 3.1
valide (structure, références, chaque `operationId` unique).

## 2. Le document servi

`GET /openapi.json`, anonyme, mis en cache en mémoire au démarrage, `access-control-allow-origin: *` sur cette route
seule (un document public, sans cookie ni jeton : un éditeur OpenAPI dans un navigateur doit pouvoir le lire). Il porte
`servers` (`PUBLIC_API_URL`), la sécurité (clé `Bearer`, droits par route), les erreurs communes (`{ error, code }`), et
la section `webhooks` : l'enveloppe signée (Standard Webhooks) et le contenu de chaque type d'événement abonnable.

## 3. Le SDK (`sdk/`)

Paquet `@messagingme/sdk`, TypeScript, aucune dépendance d'exécution, ESM et Node 18 ou plus. Noms publics en anglais,
comme l'API.
- `createClient({ apiKey, baseUrl? })` : un appel par route, typé par chemin et méthode depuis le contrat
  (`client.POST('/v1/contacts', { body })`), corps et réponse compris.
- `ApiError` : `status`, `code`, `message`, `retryAfter` (secondes) ; aucune relance automatique.
- `verifyWebhook({ secret(s), headers, body })` : signature Standard Webhooks (`webhook-id`, `webhook-timestamp`,
  `webhook-signature`), tolérance de 5 minutes, plusieurs secrets acceptés (la rotation garde l'ancien 24 h), rend
  l'événement typé ou lève.
- Ses types sont générés depuis le contrat (`sdk/openapi.json`, recopié par un script) ; un test refuse un SDK dont le
  contrat recopié diffère de celui que le code produit.

## 4. Le dépôt dédié

Une action GitHub de ce dépôt, sur un push qui touche `sdk/`, construit le SDK et pousse `sdk/` construit vers
`julienmessagingme/messagingme-sdk`, puis l'étiquette `v<version>` de son `package.json`. Installation :
`npm install github:julienmessagingme/messagingme-sdk#v0.1.0`. Le dépôt et sa clé d'écriture sont créés par Julien
(commande fournie) ; tant qu'ils n'existent pas, l'action ne fait rien et le dit.

## 5. Ce qui ne change pas

Aucune route existante, aucun comportement. La doc garde ses pages : le contrat s'y ajoute.

## 6. L'essai réel

Julien importe `https://api.messagingme.app/openapi.json` dans un outil (Postman, Bruno ou l'éditeur Swagger) et appelle
une route avec sa clé ; puis, dans un projet vide, installe le SDK depuis GitHub, crée un contact et vérifie un webhook
d'essai (`POST /v1/webhooks/{id}/test`).
