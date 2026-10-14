# Lot 6 du bilan des audits, livraison B3 : le collecteur des rapports CSP

La CSP de la console est en observation. Les e2e la surveillent (livraison A), mais ils simulent les tiers : la feuille de
style de Google Sign-In n'est apparue qu'en ouvrant la vraie page de connexion. Décision de Julien du 2026-10-14 : les
rapports des vrais navigateurs vont dans une table agrégée, lue avant de passer en blocage.

## Ce que livre ce lot

1. Migration 0236 : `csp_rapports`, une ligne par (règle, origine bloquée, page, disposition), avec un compteur et les
   deux dates. Aucune donnée d'espace ni de personne.
2. `src/csp/rapports.ts` : la lecture des deux formats (`report-uri` et la Reporting API), réduite à la règle, à
   l'ORIGINE bloquée (ou son mot-clé), au CHEMIN de la page sans requête et identifiants masqués ; seuls comptent les
   rapports d'une page de nos origines et d'une règle de la liste fermée `DIRECTIVES_CSP`, au plus vingt par requête.
3. `src/csp/store.pg.ts` : l'écriture agrégée, bornée à `MAX_LIGNES_CSP` combinaisons par l'insertion elle-même.
4. `POST /csp-rapports` (`src/http/csp-rapports.ts`, classe `anonyme` du registre, fausse autorité dans
   l'auto-attaque) : 204 sans corps à tout corps lu, plafond de débit global compté par rapport, arrêt au premier
   échec de la base, corps borné. Origines : `CORS_ORIGINS`, `APP_URL` et la console du VPS, que plus aucune variable
   ne nomme.
5. CI : le seuil critique de l'image de la console devient bloquant (première mesure du 2026-10-14 : 0 critique).

Puis, APRÈS le déploiement de l'API (une page qui pointe vers une route absente ne casse rien, mais perd ses rapports) :
la directive `report-uri` de `web/next.config.mjs`, vers `https://api.messagingme.app/csp-rapports` sur Vercel et
`/api/backend/csp-rapports` sur le VPS.

## Tests attendus

`tests/csp-rapports.test.ts` (les deux formats, l'origine refusée, la requête et les identifiants retirés, toujours 204,
corps trop gros, plafond), `tests/migration-0236.test.ts`, et `tests/integration/csp-rapports.integration.test.ts` en
CI (la même combinaison compte, la borne arrête une combinaison neuve sans arrêter les anciennes). Mutations vues
rouges : le filtre des origines retiré, l'adresse complète gardée.

## Méthode de livraison

Implémenteur par lot, puis une relecture indépendante du diff, parce que c'est une route publique neuve qui écrit en
base de production, montée dans les fichiers de câblage. Ordre : la CI verte, le build, la migration 0236 (additive,
avant le `up`), le `up` ; puis la console. Essai réel qui clôt la livraison : un rapport posté par `curl` vers
`https://api.messagingme.app/csp-rapports` rend 204, puis, la console branchée, une violation provoquée dans un vrai
navigateur sur la console apparaît dans `csp_rapports` (lecture seule).
