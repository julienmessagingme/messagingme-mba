# Lot 16 : le contrat OpenAPI et le SDK TypeScript

Spec : `docs/superpowers/specs/2026-10-09-openapi-sdk-design.md` (décisions de Julien du 2026-10-09).

## Méthode de livraison

Implémenteur par lot, puis UNE relecture par livraison : le contrat est une promesse publique et le lot ajoute une route
anonyme, mais aucun chemin d'envoi ni de données ne change, et chaque critère se vérifie par un test (parité des
routes, exemples qui valident leurs schémas, document valide, SDK qui compile et vérifie une vraie signature). Aucune
migration. L'essai réel qui clôt le lot : Julien importe le contrat dans un outil et appelle une route, puis installe le
SDK depuis GitHub, crée un contact et vérifie un webhook d'essai.

## Livraison A : le contrat

1. **Le registre** (`src/api/openapi/registre.ts`) : une entrée par route `/v1` (méthode, chemin, droit, résumé, schémas
   d'entrée exportés des routes, schéma de réponse neuf, codes d'erreur). Tests : parité avec les routes montées (dans
   les deux sens), chaque exemple de corps et de réponse de la doc valide son schéma.
2. **Les événements** : l'enveloppe signée et le contenu de chaque type abonnable (`src/evenements/types.ts`). Test :
   chaque type abonnable a son schéma, chaque exemple d'événement de la doc le valide.
3. **Le document** (`src/api/openapi/document.ts`, `z.toJSONSchema`) et `GET /openapi.json` (anonyme, en cache,
   `access-control-allow-origin: *` sur cette route seule). Tests : OpenAPI 3.1 bien formé, `operationId` uniques,
   références résolues, la route déclarée ouverte à l'auto-attaque.
4. **Les liens** : la doc de l'API (page Accueil et Référence), `site/llms.txt`, `features.md`, `documentation.md`.

## Livraison B : le SDK

5. **`sdk/`** : `createClient`, `ApiError`, `verifyWebhook`, types générés depuis `sdk/openapi.json` (script
   `npm run sdk:contrat`). Tests : le client contre un faux serveur (chemins, en-têtes, erreurs, `Retry-After`), la
   signature contre `src/evenements/signature.ts` (une signature produite par le serveur se vérifie, une altérée non,
   une trop vieille non, l'ancien secret oui), et la parité du contrat recopié.
6. **L'action** `.github/workflows/sdk.yml` : construit et pousse vers `julienmessagingme/messagingme-sdk`, étiquette la
   version ; inerte sans le secret `SDK_DEPLOY_KEY`. Commande de création du dépôt et de la clé fournie à Julien.
7. **La doc** : une page « SDK » dans la doc de l'API (installation, exemple, vérification d'un webhook).

## Ordre de déploiement

Aucune migration. A : la doc et la route partent dans le même push ; Vercel publie la doc avant le `up` de l'API, donc
son lien vers `/openapi.json` rend 404 le temps de la CI et du `up`, fenêtre réduite par un `up` juste après la CI.
B : sans effet en production ; le dépôt dédié se remplit au premier push après la création de sa clé par Julien.
