# API + worker (même image, commande différente). Runtime tsx (ESM/TS direct), pas de build.
FROM node:22-alpine
WORKDIR /app

COPY package.json package-lock.json ./
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

COPY tsconfig.json ./
COPY src ./src
COPY db ./db
# CA Supabase (cert PUBLIC, pas un secret) bakée dans l'image -> DB_SSL_CA_FILE=/app/certs/... toujours présent
# (pas de crash import-time sur un mount manquant), reproductible et compatible Railway. Cf. src/db/ssl.ts (4.11).
COPY certs ./certs

EXPOSE 8095
# API par défaut ; le worker surcharge la commande (voir docker-compose).
CMD ["npx", "tsx", "src/index.ts"]
