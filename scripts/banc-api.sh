#!/usr/bin/env bash
# LE BANC DE L'API (lot 14, B) : monte une copie JETABLE de l'API et du worker principal sur un Postgres jetable, joue
# `scripts/banc-api.mts` (semer, paliers, rafale d'accusés, plafond global allumé), puis démonte tout. Lancé par Julien
# sur le VPS, avec sudo : il crée des conteneurs, et c'est son accord à ce moment-là qui le permet.
#
# Usage : sudo bash banc-api.sh <sha de main> [palier1,palier2,...] [epreuves, défaut paliers,statuts,plafond]
#   BANC_TELEGRAM=1 : les alertes de la veille de charge du banc partent sur Telegram, préfixées « [BANC lot 14, copie
#   jetable, PAS la production] » (essai réel 91). Seul le conteneur du script reçoit le jeton Telegram, lu dans
#   /home/ubuntu/mba/.env.prod ; ni l'API ni le worker du banc ne l'ont.
#   BANC_GARDER=1 : ne démonte pas à la fin (pour relire la base du banc).
#   BANC_PLAFOND_10S=N : la valeur du plafond global de l'épreuve « plafond » (sinon, celle que les paliers recommandent).
#   BANC_DELAI_MS=N : l'aller-retour simulé vers la base (10 par défaut, comme Londres ; environ 1 pour une base de la
#   même région chez Scaleway).
#   ⚠️ sudo efface l'environnement : ces variables se passent APRÈS sudo, `sudo BANC_PLAFOND_10S=700 bash banc-api.sh ...`.
#
# 🔴 NE TOUCHE PAS LA PRODUCTION : tout porte l'étiquette banc=api14 et le préfixe banc14-, sur un réseau à part
# (banc14_net), sans aucun port publié, et le démontage passe par l'étiquette, jamais par un nom. La base est un
# conteneur jetable, à BANC_DELAI_MS d'aller-retour (tc netem). Aucun secret de production n'entre, sauf le
# jeton Telegram si BANC_TELEGRAM=1.
set -euo pipefail

SHA="${1:?usage : sudo bash banc-api.sh <sha de main> [paliers]}"
PALIERS="${2:-10,25,50,75,100,150}"
DELAI_MS="${BANC_DELAI_MS:-10}"
EPREUVES=",${3:-paliers,statuts,plafond},"
D=/home/ubuntu/banc-api14
IMG=banc-mba:api14
NET=banc14_net
LBL=banc=api14
R="$D/resultats-$(date -u +%Y%m%dT%H%M%SZ)"

demonter() {
  if [ "${BANC_GARDER:-0}" = "1" ]; then echo "BANC_GARDER=1 : banc laissé en place (démontage : relancer sans, ou docker rm -f par l'étiquette $LBL)"; return; fi
  docker ps -aq --filter "label=$LBL" | xargs -r docker rm -f >/dev/null
  docker network rm "$NET" >/dev/null 2>&1 || true
  docker rmi "$IMG" >/dev/null 2>&1 || true
  echo "banc démonté (les résultats restent dans $R)"
}
trap demonter EXIT

echo "== montage du banc sur $SHA (base à ${DELAI_MS} ms)"
rm -rf "$D/src-banc" && mkdir -p "$D" "$R"
git clone -q https://github.com/julienmessagingme/messagingme-mba.git "$D/src-banc"
git -C "$D/src-banc" checkout -q "$SHA"
docker build -q -t "$IMG" "$D/src-banc" >/dev/null
docker network create --label "$LBL" "$NET" >/dev/null

PGPASS=$(openssl rand -hex 16)
docker run -d --name banc14-postgres --label "$LBL" --network "$NET" --cap-add NET_ADMIN \
  -e POSTGRES_PASSWORD="$PGPASS" pgvector/pgvector:pg16 >/dev/null
until docker exec banc14-postgres pg_isready -U postgres >/dev/null 2>&1; do sleep 1; done
docker exec banc14-postgres sh -c "apt-get update -qq >/dev/null && apt-get install -qq -y iproute2 >/dev/null && tc qdisc add dev eth0 root netem delay ${DELAI_MS}ms"

# Les secrets du banc : JETABLES, jamais affichés, effacés au démontage avec le dossier des sources.
E="$D/src-banc/.env.banc"
umask 077
cat > "$E" <<EOF
NODE_ENV=production
DATABASE_URL=postgres://postgres:$PGPASS@banc14-postgres:5432/postgres
DB_SSL=off
AUTH_SECRET=$(openssl rand -hex 32)
META_APP_SECRET=$(openssl rand -hex 32)
ENCRYPTION_KEY=$(openssl rand -hex 32)
BANC_SECRET=$(openssl rand -hex 32)
DRY_RUN=true
API_PLAFOND_MINUTE=0
API_PLAFOND_HEURE=0
API_QUOTA_ENVOIS_JOUR=0
API_QUOTA_FICHES_JOUR=0
EOF

docker run --rm --label "$LBL" --network "$NET" --env-file "$E" "$IMG" npm run migrate >"$R/migrate.log" 2>&1
# Les tailles de pool de la production (docker-compose.yml) : le worker d'abord, il prépare pg-boss.
docker run -d --name banc14-worker --label "$LBL" --network "$NET" --env-file "$E" \
  -e WORKER_ROLE=principal -e DB_POOL_MAX=8 -e PGBOSS_MAX=2 "$IMG" npx tsx src/worker-cli.ts >/dev/null
sleep 20

lancer_api() {
  docker rm -f banc14-api >/dev/null 2>&1 || true
  docker run -d --name banc14-api --label "$LBL" --network "$NET" --env-file "$E" \
    -e DB_POOL_MAX=10 -e DB_POOL_RECEPTION_MAX=4 -e API_COPIE=banc "$@" "$IMG" >/dev/null
  until docker exec banc14-api wget -qO- http://127.0.0.1:8095/live >/dev/null 2>&1; do sleep 1; done
}
lancer_api

TG=()
if [ "${BANC_TELEGRAM:-0}" = "1" ]; then
  TG=(-e BANC_TELEGRAM=1
      -e "TELEGRAM_BOT_TOKEN=$(grep -m1 '^TELEGRAM_BOT_TOKEN=' /home/ubuntu/mba/.env.prod | cut -d= -f2-)"
      -e "TELEGRAM_CHAT_ID=$(grep -m1 '^TELEGRAM_CHAT_ID=' /home/ubuntu/mba/.env.prod | cut -d= -f2-)")
fi
jouer() {
  docker run --rm --label "$LBL" --network "$NET" --env-file "$E" -v "$D/src-banc/scripts:/app/scripts:ro" \
    -e BANC_CONFIRME=1 -e BANC_API=http://banc14-api:8095 "${TG[@]}" "$@" "$IMG" npx tsx scripts/banc-api.mts
}

# Le processeur des trois conteneurs, toutes les 10 s, pendant toute la mesure.
( while true; do docker stats --no-stream --format '{{.Name}} {{.CPUPerc}} {{.MemUsage}}' banc14-api banc14-worker banc14-postgres 2>/dev/null | sed "s/^/$(date -u +%T) /"; sleep 10; done ) >"$R/cpu.log" &
STATS=$!

echo "== semer"; jouer -e BANC_EPREUVE=semer | tee "$R/semer.log"
if [[ "$EPREUVES" == *,paliers,* ]]; then echo "== paliers $PALIERS"; jouer -e BANC_EPREUVE=paliers -e BANC_PALIERS="$PALIERS" | tee "$R/paliers.log"; fi
if [[ "$EPREUVES" == *,statuts,* ]]; then echo "== rafale d'accusés"; jouer -e BANC_EPREUVE=statuts | tee "$R/statuts.log"; fi

# Le plafond global posé à la valeur recommandée, puis un palier une fois et demie au-dessus.
N=$(grep -o 'API_PLAFOND_GLOBAL_PAR_10S=[0-9]*' "$R/paliers.log" 2>/dev/null | tail -1 | cut -d= -f2 || true)
N="${BANC_PLAFOND_10S:-$N}"
if [[ "$EPREUVES" == *,plafond,* ]] && [ -n "$N" ] && [ "$N" -gt 0 ]; then
  lancer_api -e API_PLAFOND_GLOBAL_PAR_10S="$N" -e API_PLAFOND_GLOBAL_PART_FREE=50
  AU_DESSUS=$(( N * 15 / 100 ))
  echo "== plafond global à $N par 10 s, palier à $AU_DESSUS appels/s"
  jouer -e BANC_EPREUVE=plafond -e BANC_PALIERS="$AU_DESSUS" | tee "$R/plafond.log"
elif [[ "$EPREUVES" == *,plafond,* ]]; then
  echo "== plafond SAUTÉ : ni paliers.log ni BANC_PLAFOND_10S (passé après sudo) pour en donner la valeur"
fi

kill "$STATS" 2>/dev/null || true
echo "== processeur (pic par conteneur)"
for c in banc14-api banc14-worker banc14-postgres; do
  echo "$c $(grep " $c " "$R/cpu.log" | awk '{gsub("%","",$3); if ($3+0 > m) m = $3+0} END {print m "%"}')"
done | tee "$R/cpu-pic.log"
docker logs banc14-api >"$R/api.log" 2>&1 || true
docker logs banc14-worker >"$R/worker.log" 2>&1 || true
rm -f "$E"
echo "== fini : $R"
