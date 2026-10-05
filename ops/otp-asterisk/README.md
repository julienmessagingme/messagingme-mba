# L'Asterisk du pont du code (lot 3a)

Meta vérifie un numéro que nous fournissons en l'appelant et en dictant un code. Ce conteneur décroche, enregistre,
puis `envoyer-otp.sh` poste l'enregistrement signé à `POST /internes/otp/appels/:numero/:appel`, où l'API transcrit et
garde le code (`src/http/otp-pont.ts`). Spec : `docs/superpowers/specs/2026-10-05-pont-du-code-design.md`.

Il tourne sur le VPS, dans `/home/ubuntu/otp-asterisk`, hors du dépôt de l'application. Ce dossier en est la source.

## Les fichiers

| Fichier | Rôle |
| --- | --- |
| `docker-compose.yml` | le conteneur, en `network_mode: host`, ses montages |
| `extensions.conf` | décrocher, enregistrer 90 s en chemin absolu, puis lancer le script à la fin de l'appel |
| `envoyer-otp.sh` | signer et poster l'enregistrement, l'effacer sur un 2xx (exécutable) |
| `pjsip.conf.example` | le gabarit SIP : l'Asterisk s'enregistre chez DIDWW sur le port 5080 |
| `rtp.conf` | la plage des ports RTP |
| `modules.conf` | celui de l'image, sans l'IAX2 : le conteneur n'écoute qu'en SIP (5080) et en RTP |
| `pare-feu.sh` | le 5080 et la plage RTP fermés à tout ce qui n'est pas DIDWW, lancé au démarrage du VPS |

Deux fichiers ne sont JAMAIS dans le dépôt : `pjsip.conf` (les identifiants SIP du trunk, relevés dans le portail
DIDWW) et `secret-pont` (le secret partagé avec l'API, `OTP_PONT_SECRET` de `.env.prod`, une ligne).

## Mettre à jour le VPS

1. Recopier les fichiers du dépôt dans `/home/ubuntu/otp-asterisk`, et rendre le script exécutable
   (`chmod 755 envoyer-otp.sh`).
2. `secret-pont` : la même valeur que `OTP_PONT_SECRET` dans `.env.prod`, droits 600.
3. `docker compose up -d --force-recreate` : les fichiers sont montés seuls, un rechargement d'Asterisk relirait
   les anciens sans rien signaler.
4. Vérifier `asterisk -rx "pjsip show registrations"` (`Registered`), puis les trois prérequis du script, qui
   échoueraient en silence au premier appel : `docker exec -u asterisk otp-asterisk sh -c 'command -v curl &&
   command -v openssl && test -r /otp/secret && test -x /otp/envoyer-otp.sh && echo ok'` (un `command -v` par
   commande : celui de `sh` ne regarde que son premier argument). Un `secret-pont` absent fait créer à Docker un
   DOSSIER à sa place : le poser avant le premier `up`.
5. Prouver la signature sans attendre un appel : depuis le conteneur, le script sur un faux fichier et un numéro hors
   réserve (`head -c 2048 /dev/urandom > /tmp/x.wav && /otp/envoyer-otp.sh 449990000001 1.1 /tmp/x.wav`). L'API doit
   répondre 404 (« hors réserve »), ce qui n'arrive qu'après une signature acceptée ; un 401 dit que `secret-pont` et
   `OTP_PONT_SECRET` diffèrent. Rien n'est écrit, effacer `/tmp/x.wav` ensuite.

## Le pare-feu

Le VPS n'a pas de pare-feu actif (`ufw` inactif, `INPUT` en `ACCEPT`), et le conteneur est en `network_mode: host` :
sans `pare-feu.sh`, le 5080 et la plage RTP sont ouverts au monde. Un scanneur y envoyait des INVITE le jour même de
la mise en service. Le script n'ajoute que des règles ciblées sur ces ports : jamais de `ufw default deny`, qui
couperait le 22 s'il n'est pas autorisé avant. Les règles iptables ne survivent pas à un redémarrage, d'où la ligne
`@reboot sh /home/ubuntu/otp-asterisk/pare-feu.sh` dans la crontab de root. Poser une persistance système revient à
Julien, pas à un agent.

⚠️ Ses plages sont celles de la section `identify` de `pjsip.conf` : changer l'une sans l'autre ferait passer un appel
que l'Asterisk refuse, ou jeter un appel qu'il attend. `tests/otp-asterisk-config.test.ts` les compare.

## Rejouer un envoi à la main

Un enregistrement que l'API a refusé reste dans `monitor/`. La même commande le renvoie, depuis le conteneur :
`/otp/envoyer-otp.sh <numéro> <identifiant d'appel> <fichier>`. Une signature se périme en cinq minutes : le script en
calcule une neuve à chaque envoi, et l'API ignore un appel déjà écrit.
