# Frontend Next.js (build standalone). Contexte de build = racine du repo (voir compose).
FROM node:22-alpine AS build
WORKDIR /app
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
# Les rewrites Next sont figées au BUILD : BACKEND_URL doit être défini ici (pas au runtime)
# pour que /api/backend/* pointe vers l'API dans le réseau Docker.
ARG BACKEND_URL=http://mba-api:8095
ENV NEXT_TELEMETRY_DISABLED=1 BACKEND_URL=$BACKEND_URL
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
# 🔴 EN `node`, PAS EN ROOT (2026-09-10), comme l'image API. Ce Dockerfile-ci a failli etre oublie : le lot
# a traite l'image API/worker et laisse celle du front en root, ce qu'un `docker exec mba-web id -u` a dit
# apres le deploiement. Une image sur trois en root n'est pas « deux tiers du controle », c'est le controle
# absent : un questionnaire demande si les conteneurs tournent sans privilege, pas combien.
#
# ⚠️ La sortie `standalone` de Next n'ecrit rien sur disque a l'execution (elle sert des fichiers deja
# construits) et le compose ne monte aucun volume : les fichiers arrivent au bon proprietaire par `--chown`,
# sans `chown -R` final qui recopierait toute l'arborescence dans une couche de plus.
RUN chown node:node /app
USER node
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
# La sortie standalone n'inclut PAS public/ : copie explicite pour servir /logo.png (email d'invitation).
COPY --from=build --chown=node:node /app/public ./public
EXPOSE 3000
CMD ["node", "server.js"]
