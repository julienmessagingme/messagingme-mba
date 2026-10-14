#!/bin/sh
# L'EXERCICE DE RESTAURATION, CHRONOMÉTRÉ (lot 2 du bilan des audits, joué pour la première fois le 2026-10-14).
#
# Restaure une sauvegarde de `sauvegarde-base.sh` dans un Postgres 17 JETABLE (écoute 127.0.0.1:55432 seulement, aucun
# réseau partagé), puis déchiffre TOUS les secrets de la copie avec la clé de production (`exercice-dechiffrer.ts`, dans
# l'image de l'API). Le conteneur, son mot de passe et la clé temporaire disparaissent à la fin, même en cas d'échec.
#
# ⚠️ LES EXTENSIONS NE SONT PAS DANS LA SAUVEGARDE (pg_dump par schémas) : `vector`, `pg_trgm` et `unaccent` se créent
# AVANT la restauration, sinon les tables qui s'en servent échouent. Même geste sur toute base neuve (Scaleway compris).
# La seule erreur attendue de pg_restore est « schema "public" already exists » (une base neuve le crée d'office).
#
# Usage : sh scripts/exercice-restauration.sh [fichier .dump]   (par défaut, la sauvegarde la plus récente)
set -eu

DOSSIER=${SAUVEGARDES:-/home/ubuntu/sauvegardes-mba}
ENV_PROD=${ENV_PROD:-/home/ubuntu/mba/.env.prod}
IMAGE_API=${IMAGE_API:-mba-mba-api}
ICI=$(cd "$(dirname "$0")" && pwd)
DUMP=${1:-$(ls -t "$DOSSIER"/mba-*.dump | head -1)}
NOM=mba-exercice-pg
PORT=55432

umask 077
TRAVAIL=$(mktemp -d)
nettoyer() { sudo docker rm -f "$NOM" >/dev/null 2>&1 || true; rm -rf "$TRAVAIL"; }
trap nettoyer EXIT

MDP=$(python3 -c 'import secrets; print(secrets.token_hex(16))')
export PGPASSWORD="$MDP"
psql_copie() { psql -h 127.0.0.1 -p "$PORT" -U postgres -d exercice -qtA "$@"; }

echo "sauvegarde : $DUMP ($(du -h "$DUMP" | cut -f1))"
T0=$(date +%s)
sudo docker run -d --name "$NOM" -p "127.0.0.1:$PORT:5432" -e POSTGRES_PASSWORD="$MDP" -e POSTGRES_DB=exercice \
  pgvector/pgvector:pg17 > /dev/null
until psql_copie -c 'select 1' > /dev/null 2>&1; do sleep 1; done
T1=$(date +%s)
psql_copie -c 'create extension if not exists vector; create extension if not exists pg_trgm; create extension if not exists unaccent;'
pg_restore --no-owner --no-privileges -h 127.0.0.1 -p "$PORT" -U postgres -d exercice "$DUMP" 2> "$TRAVAIL/restauration.err" || true
T2=$(date +%s)
if grep 'error:' "$TRAVAIL/restauration.err" | grep -v 'schema "public" already exists' | grep -q .; then
  echo "RESTAURATION EN ÉCHEC :"; grep 'error:' "$TRAVAIL/restauration.err"; exit 1
fi

grep '^ENCRYPTION_KEY=' "$ENV_PROD" | tr -d "\"'" > "$TRAVAIL/cle.env"
sudo docker run --rm --network host --env-file "$TRAVAIL/cle.env" \
  -e EXERCICE_URL="postgres://postgres:$MDP@127.0.0.1:$PORT/exercice" \
  -v "$ICI/exercice-dechiffrer.ts:/app/scripts/exercice-dechiffrer.ts:ro" "$IMAGE_API" npx tsx scripts/exercice-dechiffrer.ts
T3=$(date +%s)
echo "base jetable prête en $((T1 - T0)) s, restauration en $((T2 - T1)) s, relecture et déchiffrement en $((T3 - T2)) s"
