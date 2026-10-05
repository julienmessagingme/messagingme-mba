#!/bin/sh
# LE PONT DU CODE, COTE ASTERISK (lot 3a, spec docs/superpowers/specs/2026-10-05-pont-du-code-design.md).
# Lance par le plan de numerotation (extension h) apres chaque appel recu sur un numero de la reserve : signe
# l'enregistrement et le poste a l'API, puis l'efface si l'API l'a recu (tout 2xx). Sinon il reste, pour un rejeu
# a la main (meme commande).
#
#   envoyer-otp.sh <numero appele> <identifiant d'appel> <fichier wav>
#   envoyer-otp.sh --signer <horodatage ms> <nonce> <chemin> <fichier> <fichier secret>   (sert au test du depot)
#
# La signature est celle de nos services (src/lib/signature.ts, signRequest) : HMAC-SHA256, avec le secret partage,
# de "<horodatage>.<nonce>.POST.<chemin>." suivi des octets du fichier ; en-tete "v1=<horodatage>.<nonce>.<hex>".
# Le chemin porte le numero et l'identifiant d'appel : ils sont signes avec le son.
#
# Le secret vient d'un FICHIER monte (/otp/secret), pas de l'environnement : Asterisk ne transmet pas toujours
# celui du conteneur aux commandes qu'il lance. ⚠️ openssl le recoit en argument (-hmac) : il est lisible dans la
# liste des processus de l'hote pendant les quelques millisecondes du calcul. La CLI d'openssl n'offre pas mieux ;
# le conteneur n'execute que ce que le plan de numerotation filtre, et le VPS n'a pas d'autre utilisateur.
set -u

signer() {
  # $1 horodatage, $2 nonce, $3 chemin, $4 fichier, $5 fichier secret
  pre=$(mktemp)
  printf '%s.%s.POST.%s.' "$1" "$2" "$3" > "$pre"
  cat "$4" >> "$pre"
  hex=$(openssl dgst -sha256 -hmac "$(cat "$5")" -hex < "$pre" | sed 's/^.*= *//')
  rm -f "$pre"
  printf 'v1=%s.%s.%s' "$1" "$2" "$hex"
}

if [ "${1:-}" = "--signer" ]; then
  signer "$2" "$3" "$4" "$5" "$6"
  exit 0
fi

NUMERO=$(printf '%s' "${1:-}" | tr -cd '0-9')
APPEL=$(printf '%s' "${2:-}" | tr -cd '0-9.')
FICHIER=${3:-}
SECRET=${OTP_PONT_SECRET_FICHIER:-/otp/secret}
BASE=${OTP_PONT_URL:-https://api.messagingme.app}

# Les enregistrements gardes (l'API les a refuses) ne servent qu'a un rejeu le jour meme : au-dela d'un jour, ce sont
# des voix de tiers qui remplissent le disque.
find /var/spool/asterisk/monitor -maxdepth 1 -name 'otp-*.wav' -mmin +1440 -delete 2>/dev/null || true

# Rien a envoyer : appel raccroche avant l'enregistrement.
[ -n "$NUMERO" ] && [ -n "$APPEL" ] && [ -s "$FICHIER" ] || exit 0

CHEMIN="/internes/otp/appels/$NUMERO/$APPEL"
TS=$(date +%s%3N)
NONCE=$(openssl rand -hex 8)
SIGNATURE=$(signer "$TS" "$NONCE" "$CHEMIN" "$FICHIER" "$SECRET")

STATUT=$(curl -s -o /dev/null -w '%{http_code}' -m 120 -X POST "$BASE$CHEMIN" \
  -H 'content-type: audio/wav' -H "x-mm-service-signature: $SIGNATURE" --data-binary @"$FICHIER")
case "$STATUT" in
  2*) rm -f "$FICHIER" ;;
  *) echo "envoyer-otp : $NUMERO $APPEL refuse par l'API ($STATUT), fichier garde : $FICHIER" >&2 ;;
esac
