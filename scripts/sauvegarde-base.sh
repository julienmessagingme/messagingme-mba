#!/bin/sh
# LA SAUVEGARDE QUOTIDIENNE DE LA BASE DE PRODUCTION (lot 2 du bilan des audits, 2026-10-14).
#
# Le projet Supabase n'a aucune sauvegarde relevée : jusqu'à la bascule vers la base managée de Scaleway (qui a les
# siennes), ce script est la seule. Il garde nos cinq schémas (public, pgboss, mmhs, pgboss_mmhs, salesforce) au format
# de pg_dump, relit la table des matières de la copie, et efface les copies de plus de GARDER_JOURS jours.
#
# ⚠️ ELLE VIT SUR LE VPS : elle protège d'une erreur sur la base, pas d'une perte du serveur. Elle contient des données
# clients : dossier et fichiers lisibles par le seul propriétaire (umask 077), jamais copiés ailleurs sans chiffrement.
# Le mot de passe de la base ne passe jamais en argument (il serait lisible dans `ps`) : il voyage par l'environnement.
#
# Usage : scripts/sauvegarde-base.sh   (planifié par Julien : crontab, une fois par nuit)
set -eu

DOSSIER=${SAUVEGARDES:-/home/ubuntu/sauvegardes-mba}
ENV_PROD=${ENV_PROD:-/home/ubuntu/mba/.env.prod}
CA=${CA:-/home/ubuntu/mba/certs/supabase-pooler-ca.crt}
GARDER_JOURS=${GARDER_JOURS:-7}

umask 077
mkdir -p "$DOSSIER"

# DATABASE_URL découpée en variables PG* par Python (décodage des caractères encodés du mot de passe compris).
eval "$(python3 - "$ENV_PROD" <<'PY'
import shlex, sys, urllib.parse as u
url = ''
for ligne in open(sys.argv[1], encoding='utf-8'):
    if ligne.startswith('DATABASE_URL='):
        url = ligne.split('=', 1)[1].strip().strip('"').strip("'")
if not url:
    sys.exit('DATABASE_URL introuvable')
p = u.urlsplit(url)
for nom, valeur in (('PGHOST', p.hostname), ('PGPORT', str(p.port or 5432)), ('PGUSER', u.unquote(p.username or '')),
                    ('PGPASSWORD', u.unquote(p.password or '')), ('PGDATABASE', p.path.lstrip('/') or 'postgres')):
    print(f'export {nom}={shlex.quote(valeur)}')
PY
)"
export PGSSLMODE=verify-full PGSSLROOTCERT="$CA"

FICHIER="$DOSSIER/mba-$(date -u +%Y%m%dT%H%M%SZ).dump"
DEBUT=$(date +%s)
pg_dump --format=custom --no-owner --no-privileges \
  --schema=public --schema=pgboss --schema=mmhs --schema=pgboss_mmhs --schema=salesforce \
  --file="$FICHIER.partiel"
mv "$FICHIER.partiel" "$FICHIER"
# Une sauvegarde qui ne se relit pas n'en est pas une.
pg_restore --list "$FICHIER" > /dev/null
find "$DOSSIER" -name 'mba-*.dump' -mtime +"$GARDER_JOURS" -delete
echo "$(date -u +%FT%TZ) OK $FICHIER $(du -h "$FICHIER" | cut -f1) en $(( $(date +%s) - DEBUT )) s"
