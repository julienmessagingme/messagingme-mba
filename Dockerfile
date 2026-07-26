# API + worker (même image, commande différente). Runtime tsx (ESM/TS direct), pas de build.
FROM node:22-alpine
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY db ./db
# CA Supabase (cert PUBLIC, pas un secret) bakée dans l'image -> DB_SSL_CA_FILE=/app/certs/... toujours présent
# (pas de crash import-time sur un mount manquant), reproductible et compatible Railway. Cf. src/db/ssl.ts (4.11).
COPY certs ./certs

EXPOSE 8095
# API par défaut ; le worker surcharge la commande (voir docker-compose).
CMD ["npx", "tsx", "src/index.ts"]
