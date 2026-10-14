# Lot 6 du bilan des audits, livraison B1 : les dépendances de production vulnérables

Mesuré le 2026-10-14 sur la CI : `npm audit` remontait des failles de gravité haute dans les dépendances de PRODUCTION,
sans que personne ne le lise (le contrôle est en `continue-on-error`, et un `bash -e` arrêtait l'étape après l'audit de
l'API : celui de la console ne tournait jamais).

- API : fastify (contournements de validation et d'authentification par des adresses malformées, déni de service),
  fast-uri (sa dépendance), nodemailer (dont une fuite d'identifiants SMTP entre espaces par un cache DNS partagé, que
  notre montage ne semble pas exposer : nous ouvrons la socket nous-mêmes et ne posons pas `servername`).
- Console : next, sharp, source-map-js.

## Ce que livre ce lot

Chaque version retenue est publiée depuis au moins deux semaines, et c'est la plus ancienne qui corrige :
fastify 5.12.5, fast-uri 3.1.8, nodemailer 10.0.13 (la 10 est une réécriture en TypeScript, en ESM et CommonJS, et exige
Node 20, la production est en 22 ; elle embarque ses types, `@types/nodemailer` part et la signature de `getSocket` est
inférée), next 15.5.27, sharp 0.35.5,
source-map-js 1.2.2. Restent, faute de correctif hors d'une version majeure : la copie de postcss embarquée dans next
et un avis modéré sur next (next 16), et vitest en développement (vitest 5) ; ils deviennent les exceptions datées de
la livraison B2 (les seuils bloquants).

## Tests attendus

`npm audit --omit=dev` à zéro côté API, typecheck, suite serveur, auto-attaque (fastify sert chaque route), le
dialogue SMTP réel de `tests/email-smtp.test.ts` (socket vérifiée et refus d'un hôte interne) ; côté console, build,
lint, `tsc`, vitest et la suite e2e entière, puis la CI dans les deux topologies.

## Méthode de livraison

Implémenteur par lot, puis une relecture indépendante du diff, parce que fastify sert chaque requête de l'API et
nodemailer chaque e-mail des clients : c'est un chemin que la production emprunte, réversible par l'image précédente.
Ordre : la CI verte, puis le déploiement de l'API (build des trois conteneurs avec `REVISION`, sans migration) ; la
console part avec Vercel au push. Essai réel qui clôt la livraison : les portes publiques répondent, l'auto-attaque
est passée, et Julien clique « Tester » sur une boîte d'envoi de son espace d'essai (menu Tools, « SMTP email »), qui
doit envoyer le message de test. Le dialogue SMTP des tests est en clair : l'essai doit couvrir les chemins chiffrés de
la production, donc une boîte en 465 (TLS implicite) et, s'il en a une, une en 587 (STARTTLS) ; puis un envoi par le
WORKER (un scénario à bloc e-mail sur l'espace d'essai), car « Tester » ne passe que par l'API.
