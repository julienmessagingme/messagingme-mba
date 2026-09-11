# API + worker (même image, commande différente). Runtime tsx (ESM/TS direct), pas de build.
FROM node:22-alpine
WORKDIR /app

# 🔴 TOUT CE QUI SUIT TOURNE EN `node`, PAS EN ROOT (plan RSSI, 2026-09-10). L'image officielle fournit
# deja cet utilisateur (uid 1000) et son `/home/node`. Un processus compromis n'obtient donc plus root
# DANS le conteneur, ce qui est la premiere marche vers une evasion et la seule que nous controlions.
#
# ⚠️ `chown` SUR LE REPERTOIRE VIDE, puis `COPY --chown`, et surtout PAS un `chown -R /app` a la fin : le
# recursif recopierait tout `node_modules` dans une nouvelle couche, doublant la taille de l'image pour
# changer un proprietaire. Ici chaque fichier arrive deja au bon nom.
#
# ⚠️ CE QUI REND CE CHANGEMENT SUR : le conteneur n'ecrit RIEN sur disque a l'execution (verifie le
# 2026-09-10, aucun `writeFile`, `mkdir` ni `tmpdir()` hors des tests), et le compose ne monte aucun volume.
# Le jour ou un chemin ecrira quelque chose, il faudra lui donner un repertoire possede par `node`, et le
# conteneur le dira en echouant au demarrage plutot qu'en silence.
RUN chown node:node /app
USER node

COPY --chown=node:node package.json package-lock.json ./
# 🔴 `--omit=dev` : l'image de production n'embarque PAS les outils de test. Sans lui, `vitest` et toute sa
# chaîne (`vite`, `esbuild`, `postcss`…) partaient en production, ce qui faisait porter à l'image cinq
# alertes de sécurité (dont une critique) pour du code qui n'y sert à rien. Constaté le 2026-08-31 dans le
# conteneur en ligne, pas déduit.
#
# ⚠️ Ce qui rend ce drapeau SÛR ici, et qu'il faut revérifier avant d'ajouter une dépendance : l'application
# tourne par `tsx`, qui est une dépendance de PRODUCTION, et qui transpile par esbuild sans avoir besoin du
# paquet `typescript`. Les seules `devDependencies` sont les `@types/*` (effacés à l'exécution), `typescript`
# et `vitest`. `tsconfig.json` ne déclare aucun alias de chemin, donc rien ne réclame le compilateur au
# démarrage. Le jour où un module du chemin d'exécution dépendrait d'un paquet de développement, le conteneur
# ne démarrerait plus : la preuve se refait par un `compose run --rm --no-deps mba-api npm run migrate`.
RUN npm ci --omit=dev

COPY --chown=node:node tsconfig.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node db ./db
# 🔴 LES FICHES DU MODE D EMPLOI ENTRENT DANS L IMAGE, comme les migrations, et pour la meme raison :
# `npm run aide:charger` tourne DANS le conteneur. Sans cette ligne il ne trouve aucun fichier, refuse de
# charger, et le bot d aide repond << je ne sais pas >> a tout sans que rien n explique pourquoi. Seul
# `docs/aide` est copie : le reste de `docs/` est de la documentation d equipe, elle n a rien a faire en
# production.
COPY --chown=node:node docs/aide ./docs/aide
# CA Supabase (cert PUBLIC, pas un secret) bakée dans l'image -> DB_SSL_CA_FILE=/app/certs/... toujours présent
# (pas de crash import-time sur un mount manquant), reproductible et compatible Railway. Cf. src/db/ssl.ts (4.11).
COPY --chown=node:node certs ./certs

EXPOSE 8095
# API par défaut ; le worker surcharge la commande (voir docker-compose).
CMD ["npx", "tsx", "src/index.ts"]
