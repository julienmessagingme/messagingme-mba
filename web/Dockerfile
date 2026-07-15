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
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
# La sortie standalone n'inclut PAS public/ : copie explicite pour servir /logo.png (email d'invitation).
COPY --from=build /app/public ./public
EXPOSE 3000
CMD ["node", "server.js"]
