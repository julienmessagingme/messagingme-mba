# API + worker (même image, commande différente). Runtime tsx (ESM/TS direct), pas de build.
FROM node:22-alpine
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY db ./db

EXPOSE 8095
# API par défaut ; le worker surcharge la commande (voir docker-compose).
CMD ["npx", "tsx", "src/index.ts"]
