# Lot 6 du bilan des audits, première livraison : la CSP de la console et ses e2e

La politique de sécurité de la console (CSP, `web/next.config.mjs`) est en observation (`Report-Only`). Sur Vercel, la
console appelle `api.messagingme.app` en direct, et `connect-src` ne liste pas cette origine : passée en blocage, la
politique couperait chaque appel. Aucun e2e n'exerce cette topologie, et rien ne lit les violations signalées.

## Ce que livre ce lot

1. `connect-src` reçoit l'origine de `NEXT_PUBLIC_API_URL` quand elle est absolue, lue au build comme `BASE`
   (`web/lib/http.ts`). Sans la variable (console du VPS), rien ne change. `style-src` reçoit la feuille de style de
   Google Sign-In (`https://accounts.google.com/gsi/style`), seconde violation vue sur la page de connexion de
   production, que les e2e (qui simulent Google) ne pouvaient pas voir.
2. Une garde dans les e2e : `web/e2e/aide/test.ts` étend le `test` de Playwright d'une fixture automatique qui fait
   échouer le test si une page de son contexte a violé la CSP (Chromium écrit chaque violation dans la console de la
   page, en observation comme en blocage, mesuré). Les 175 specs importent ce `test` ; `tests/e2e-garde-csp.test.ts`
   refuse un spec qui importerait celui de `@playwright/test`.
3. Les e2e dans les deux topologies livrées : `E2E_TOPOLOGIE=vercel` construit la console avec une adresse d'API
   absolue sur une autre origine (`http://127.0.0.1:3000/api/backend`), que les interceptions `**/api/backend/**`
   couvrent telles quelles. La CI front les joue en parallèle (matrice `proxy` / `vercel`).
4. `web/scripts/verifier-base-api.mjs` vérifie aussi que la CSP du build de production autorise l'origine de l'API.
5. trivy épinglé par version et par empreinte dans `ci.yml` ; le commentaire qui disait le dépôt privé corrigé.
6. Ce que la garde a trouvé à son premier passage : la vignette de `ChampImageHebergee` dessinait toute adresse tapée,
   `http` compris, que `img-src` refuse. Elle ne se dessine plus que pour une adresse https.

Hors de cette livraison, en attente d'une décision de Julien : le collecteur des rapports CSP des vrais navigateurs, le
passage en blocage, les nonces, le quota Docker Hub, et les autres contrôles de CI (image de la console, CodeQL,
Dependabot, seuils bloquants).

## Tests attendus

La suite e2e entière verte dans les deux topologies. Vue rouge dans les deux sens : sans l'origine de l'API dans
`connect-src`, la topologie `vercel` échoue par la garde, avec le message de la violation ; un spec remis sur
`@playwright/test` fait échouer `tests/e2e-garde-csp.test.ts` ; `verifier-base-api.mjs` échoue sur un build dont la CSP
n'a pas l'origine.

## Méthode de livraison

Implémenteur par lot, puis une relecture indépendante du diff, parce que l'en-tête modifié est servi sur chaque page de
la console et que la CI front change de forme ; le rayon de souffle reste faible (la politique reste en observation,
rien ne peut casser chez un client). Aucune migration, aucun ordre de déploiement : la console se publie au push, l'API
ne bouge pas. Essai réel qui clôt la livraison : sur `console.messagingme.app` publiée, l'en-tête servi porte
`https://api.messagingme.app` dans `connect-src`, et la page de connexion, ouverte dans un vrai navigateur, ne signale
aucune violation de la CSP dans sa console.
