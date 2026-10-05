# Lot 3a : le pont du code de vérification et la réserve de numéros

Cadré avec Julien le 2026-10-05 (trois rondes de questions). Document de référence du chantier :
`docs/prive/2026-10-02-engageme-claude-code.md`, sections « Le numéro et le code de vérification » et « DIDWW : ce
qui est vérifié ».

## 1. Ce qu'on construit, et ce qui dit que c'est réussi

Engage Me fournit un numéro WhatsApp à un client qui n'en a pas. Meta vérifie ce numéro en l'appelant et en dictant un
code à six chiffres. Personne ne décroche chez le client : c'est notre Asterisk qui décroche, et l'API qui lit le code.

Le lot 3 est découpé en trois :
- **3a (ce document)** : la réserve de numéros et le pont du code, côté serveur ;
- 3b : la page « Connecter WhatsApp », la popup de Meta sans l'écran du numéro (`featureType: 'only_waba_sharing'`),
  et le serveur qui ajoute le numéro au compte du client, demande le code par appel, le soumet et active le numéro ;
- 3c : l'abonnement Stripe mensuel du numéro et l'outil d'attente de Claude Code.

**Ce qui dit que 3a est réussi** : Julien déclare un numéro de la réserve dans /ops, l'ajoute dans le WhatsApp Manager
avec la méthode « Appel », et le code apparaît dans /ops en moins d'une minute, sans aucun guetteur lancé à la main.

## 2. Décisions de Julien (2026-10-05)

| Question | Réponse |
| --- | --- |
| Paiement du numéro fourni | Abonnement Stripe mensuel (lot 3c) |
| Qui achète les numéros de la réserve | Julien, chez DIDWW ; une alerte le prévient quand la réserve baisse (lot 3b, où la réserve se consomme) |
| Qui branche un numéro acheté sur l'Asterisk | Le serveur, par l'API DIDWW, quand Julien le déclare dans /ops |
| Où voir le code capté en 3a | Dans /ops, section « Numéros fournis » |
| Découpage | 3a, 3b, 3c, chacun avec son essai réel |

## 3. La réserve

Migration **0210** (prochaine libre au 2026-10-05, à relire dans `db/migrations/` d'origin au moment d'écrire) :

- `numeros_fournis` : `id`, `numero` (chiffres seuls, format `wa_id`, unique), `didww_did_id` (unique), `statut`
  (`libre`, `attribue`, `resilie`, CHECK), `tenant_id` (nullable, `on delete set null`), `attribue_le`, `cree_le`.
  CHECK à sens unique : `tenant_id is null or statut = 'attribue'` (l'inverse est atteignable : un espace supprimé).
- `codes_verification` : `id`, `numero_id` (cascade), `appel_id` (l'identifiant d'appel d'Asterisk, unique : une
  redélivrance n'écrit pas deux lignes), `recu_le`, `code` (nullable : `null` = aucun code certain), `transcription`,
  `cause` (`transcription_indisponible`, `code_introuvable`, ou `null`). Lu par 3b dans les dix minutes ; purgé après
  sept jours par le balayage de rétention existant.

Elle AJOUTE deux tables que l'ancien code ignore : elle passe AVANT le `up`.

**Déclarer un numéro** (`POST /ops/numeros-fournis`, session d'exploitation nominative) : le serveur cherche le
numéro dans l'inventaire DIDWW (`GET /dids?filter[number]=`), le branche sur le trunk « OTP Asterisk VPS »
(`PATCH /dids/{id}`, relation `voice_in_trunk`), puis l'inscrit `libre`. Un numéro absent de l'inventaire ou un refus
de DIDWW rend un 4xx lisible, et rien n'est inscrit. Une déclaration en double rend l'état existant, sans rien
rebrancher.

**Le client DIDWW** (`src/didww/`) ne sait que lire un numéro et le brancher. Il n'achète rien et ne résilie rien en
3a. Réponses lues en `safeParse`. En-têtes `Api-Key` et `X-DIDWW-API-VERSION: 2026-04-16`, chemins avec soulignés.

## 4. Le pont

1. **L'Asterisk** décroche et enregistre 90 secondes, comme aujourd'hui (`Record` en chemin absolu). Puis le plan de
   numérotation lance en arrière-plan un script (`envoyer-otp.sh`), et raccroche.
2. **Le script** signe et envoie l'enregistrement à `POST https://api.messagingme.app/internes/otp/appel` :
   - l'API n'est pas joignable en local depuis l'Asterisk (elle n'est que sur le réseau Docker), d'où l'adresse
     publique ; elle refuse tout appel sans signature valide ;
   - en-têtes : le numéro appelé, l'identifiant d'appel, un horodatage, et une signature HMAC-SHA256 calculée avec un
     secret partagé (`OTP_PONT_SECRET`) sur l'horodatage, le numéro, l'identifiant et l'empreinte du fichier ;
   - sur une réponse 2xx, le fichier est effacé ; sinon il reste, pour un rejeu à la main.
3. **La route** (classe `signature-service`, comme Stripe et HubSpot) :
   - vérifie la signature et la fraîcheur (cinq minutes), avant de lire le reste ;
   - retrouve le numéro dans la réserve (un numéro inconnu rend 404, rien n'est écrit) ;
   - transcrit sur NOTRE clé (`gatewayAide`, le service des vocaux, `openai/whisper-1`), comme la transcription des
     vocaux et pour la même raison : ce n'est pas une dépense du client ;
   - extrait le code, écrit la ligne, rend 200, y compris quand aucun code n'est certain (la ligne dit pourquoi) ;
   - borne le corps (4 Mo : 90 secondes de son téléphonique en font moins de 1,5).
4. **L'extraction** : `extraireCodeOtp` (`src/zadarma/otp-extract.ts`) passe dans `src/otp/` et apprend l'anglais
   (Meta dicte « your verification code is 8 6 3 8 0 1 », aussi en mots). La règle reste « unanimité ou rien » :
   deux suites de six chiffres différentes, aucun code. Meta limite à dix demandes par numéro sur 72 heures, et un code
   faux en consomme une.

Le montage de l'Asterisk entre dans le dépôt (`ops/otp-asterisk/` : `docker-compose.yml`, `extensions.conf`,
`envoyer-otp.sh`, et un `pjsip.conf.example` sans identifiants). Les identifiants SIP et le secret restent sur le VPS.

## 5. /ops

Une section « Numéros fournis » :
- le champ de déclaration ;
- la réserve : chaque numéro, son état, l'espace qui l'a reçu ;
- le nombre de numéros libres ;
- le dernier code capté par numéro, avec sa transcription, son heure et sa cause d'échec éventuelle.

## 6. Ce qui reste dehors

- L'attribution d'un numéro à un client, la popup, l'ajout chez Meta, la demande du code et l'activation (3b).
- L'alerte de réserve basse : la réserve ne se consomme qu'à l'attribution, donc en 3b.
- L'abonnement, la résiliation chez DIDWW, l'outil d'attente de Claude Code (3c).
- Le pare-feu du port SIP 5080, réservé aux plages de DIDWW : un geste d'infrastructure à part, sans code.

## 7. Prérequis de Julien, avant le déploiement

- **Une clé d'API DIDWW de production**, créée par Julien dans le portail DIDWW, limitée à l'adresse du VPS, avec les
  rappels activés. La clé inscrite aujourd'hui dans `.env.prod` est révoquée (mesuré le 2026-10-02 : 401). Elle se pose
  dans `.env.prod` par une commande prête à coller, sans jamais être affichée ni collée dans la conversation.
- **Un numéro neuf pour l'essai** (de préférence à Londres, +44 20) : `+441873901056` a déjà servi le 2026-10-05.

## 8. Méthode de livraison

**Implémenteur par lot + revue humaine du diff**, une relecture indépendante à la fin : le lot ouvre une route
publique (signée) et une migration, deux chemins que la production emprunte, et la signature porte un invariant
invisible (la comparaison en temps constant, la fraîcheur). Aucun workflow multi-agents.

**L'essai réel qui clôt** : celui du § 1, sur un numéro neuf, par l'appel de Meta lui-même.
