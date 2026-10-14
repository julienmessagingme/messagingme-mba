# Vidéos et PDF dans le bloc « message rapide », et le stock de fichiers qui les porte

Cadrage du 2026-10-14 avec Julien, en deux rondes de questions. Remplace la fiche de `todo.md` « Joindre un FICHIER à
un message rapide » (2026-08-28), écrite AVANT la décision de sortir les fichiers de Postgres (2026-09-21) : elle
prévoyait d'ajouter le PDF dans `rcs_media.bytes`, ce que cette spec écarte.

## Le problème

Le bloc « message rapide » d'un scénario ne porte qu'une IMAGE (`data.imageUrl`, 2 Mo, champ partagé avec le bloc
RCS). Julien veut y joindre une **vidéo** ou un **PDF** (plaquette, devis, catalogue).

Ce n'est pas un champ de plus, pour trois raisons :
- **le stockage** : les images vivent aujourd'hui EN BASE (`rcs_media.bytes`). Une vidéo de 16 Mo n'a rien à y faire,
  et la base part à Scaleway dans un dump ;
- **le stock** : rien ne s'efface jamais, sauf avec l'espace. Avec des images de 2 Mo, ça ne se voyait pas ; avec des
  vidéos, un espace peut remplir le stockage sans que personne ne le voie ;
- **l'exposition** : les fichiers de la médiathèque sont servis sur une adresse PUBLIQUE (`/m/<code>.<ext>`). Un PDF
  public sur notre domaine, c'est un hébergeur offert à qui voudrait diffuser un document piégé.

## Les décisions de Julien (2026-10-14)

| Question | Décision |
|---|---|
| Où et quand stocker | **Après la bascule Scaleway**, dans le bucket du « lot des fichiers » (`docs/ARCHITECTURE-CIBLE.md` §6). Ordre : la bascule, puis le lot des fichiers, puis cette feature. Aucune base en plus : un bucket. |
| Le canal RCS | **WhatsApp seulement** pour la vidéo et le PDF. Sur un parcours RCS, le bloc refuse l'envoi et dit pourquoi. |
| Le stock | **Quota par offre** : Free 0, Pro 100 Mo, Entreprise 500 Mo. Bouton Supprimer, refusé tant que le fichier sert. Les objets s'effacent avec l'espace. |
| Formats et plafonds | **MP4 16 Mo** (H.264) et **PDF 16 Mo**, rien d'autre en plus des images. |
| Le Pro | **Le dépôt s'ouvre au Pro**, sous quota : il exige les scénarios, plus le RCS. |
| Un espace au-dessus de son quota (changement d'offre) | **Rien n'est effacé**, les blocs continuent d'envoyer ; seuls les nouveaux dépôts sont refusés, avec la raison et le lien vers l'offre. |

Ajouté pendant le cadrage, présenté à Julien dans le design :
- vidéos et PDF ne sont **jamais servis publiquement** (§ 3.2) ;
- une suppression est **douce pendant 30 jours** (§ 2.4) : un visuel déjà parti en RCS peut être téléchargé tard par
  l'opérateur, et `/m/` est une porte à sens unique.

## Ce que dit Meta (relevé le 2026-10-14)

Sources : [Media](https://developers.facebook.com/docs/whatsapp/cloud-api/reference/media),
[Interactive reply buttons](https://developers.facebook.com/docs/whatsapp/cloud-api/messages/interactive-reply-buttons-messages),
[Document messages](https://developers.facebook.com/docs/whatsapp/cloud-api/messages/document-messages).

- **Meta ne stocke rien pour nous.** « All media files sent through this API are encrypted and persist for 30 days » :
  un fichier téléversé vit 30 jours, rattaché au numéro qui l'a téléversé. Une fois livré, il est sur le téléphone du
  contact. **Garder l'original est donc à nous** : un scénario tourne des mois, et chaque envoi au-delà de 30 jours
  re-téléverse depuis notre copie. C'est déjà ce que fait `TemplateMediaPreparer` pour les images (cache de 7 jours
  par numéro et par adresse).
- **Plafonds** : vidéo 16 Mo (MP4, 3GP), document 100 Mo, image 5 Mo (JPEG et PNG seulement, **pas de GIF**).
- **Vidéo** : « Only H.264 video codec and AAC audio codec supported. Single audio stream or no audio stream only. »
  Et : « videos encoded with the H.264 "High" profile and B-frames are not supported by Android WhatsApp clients. »
- **En-tête d'un message à réponses rapides** : texte, image, **vidéo** ou **document**, par `id` téléversé.
- **Légende** d'une image, d'une vidéo ou d'un document : **1 024 caractères au plus**. `filename` d'un document : nom
  avec extension, qui choisit l'icône du fichier chez le contact.

## 0. Prérequis et ordre

1. **La bascule Scaleway.** Les médias RCS partent dans le dump du jour J, comme décidé le 2026-10-04.
2. **Lot A, les fichiers sortent de Postgres** (§ 1). C'est le lot de §6 d'ARCHITECTURE-CIBLE, précisé ici. Il devient
   un PRÉREQUIS de cette feature.
3. **Lot B, le stock** (§ 2) : quota, ouverture au Pro, médiathèque, suppression.
4. **Lot C, vidéo et PDF dans le bloc** (§ 3).

Chaque lot se déploie seul et laisse la production dans un état complet. La session « Migration vers Scaleway » a été
prévenue le 2026-10-14 (aucun changement pour la bascule, une mesure à faire, § 6).

## 1. Lot A : les fichiers sortent de Postgres

### Le bucket

- **Object Storage Scaleway, région `nl-ams` (Amsterdam, comme toute la cible depuis le 2026-10-14), privé**, créé
  par Julien (créer chez Scaleway lui revient). La CLI garde `fr-par` par défaut : la région se passe à chaque
  commande, sinon le bucket naît à Paris et les fichiers sortent de la région promise. Une clé IAM
  d'application limitée à CE bucket (lire, écrire, effacer), posée par Julien dans les secrets de la cible. Si l'IAM
  ne sait borner qu'au projet, une politique de bucket restreint la clé (à mesurer, § 6).
- **Clé d'objet** : `tenants/<tenant_id>/<code>.<ext>`. Le préfixe par espace rend l'effacement d'un espace possible
  sans lire la base (§ 1.4).
- **Client** : `@aws-sdk/client-s3`, seule dépendance ajoutée. Le protocole S3 est standard (ARCHITECTURE-CIBLE §2,
  aucun enfermement chez l'hébergeur), et une signature SigV4 réécrite à la main serait du code de sécurité maison.
- Derrière une interface étroite (`MagasinObjets` : déposer, lire en flux, effacer, effacer un préfixe), pour que les
  tests tournent contre un faux en mémoire.

### Postgres ne garde que la fiche

La table garde son nom, `rcs_media`. Il est faux depuis que WhatsApp s'en sert, mais la renommer toucherait le store,
la carte `/ops`, la suppression d'espace et les tests d'intégration sans rien apporter. Le commentaire de la migration
le dit.

- **Migration A1, AVANT le code** (relâcher une contrainte) : `bytes` devient nullable, colonne `cle_objet text`, et
  un CHECK « exactement l'un des deux » (`bytes` en base OU `cle_objet` au bucket).
- **Le code** écrit tout fichier NEUF au bucket, et la lecture sait faire les deux : `cle_objet` -> flux depuis le
  bucket, sinon `bytes`.
- **La recopie** : un script idempotent recopie chaque `bytes` au bucket, pose `cle_objet` et vide `bytes`. Il rend
  un compte (lignes encore en base = 0) qui se relit avant la suite.
- **Migration A2, APRÈS** que plus aucun code ne lise `bytes` : `drop column bytes`. Les variables du bucket
  deviennent alors OBLIGATOIRES (refus de démarrer sans elles). Jusque-là, vides = l'ancien comportement (écriture en
  base, images seulement), selon la règle du dépôt : une variable dont l'oubli casse la production est une mauvaise
  variable.

### La route publique `/m/` ne bouge pas

Elle va chercher l'objet au bucket au lieu de la table, en **flux** (jamais le fichier entier en mémoire), mêmes
en-têtes qu'aujourd'hui (`nosniff`, `inline`, nom neutre, un jour de cache). L'adresse du bucket ne sort jamais.

### La suppression d'un espace efface ses objets

Aujourd'hui `on delete cascade` emporte les octets avec l'espace. **Un bucket ne suit pas la base** : sans étape
nouvelle, les fichiers d'un espace supprimé resteraient à vie.

- Nouvelle étape `fichiers` dans `src/ops/suppression-espace.ts`, jouée **avant** `purge`, « au mieux » comme les
  étapes de l'étape 2 : notée dans la trace, elle n'arrête pas la suite.
- Elle efface tout le préfixe `tenants/<tenant_id>/` (listes de 1 000 clés, effacement groupé).
- Un échec se relance : le préfixe se déduit de l'identifiant de l'espace, que la trace (`espaces_supprimes`) garde,
  pas de lignes que la purge aura emportées.

### La carte « Stockage en base » de `/ops`

Elle mesure aujourd'hui `rcs_media.bytes`. Elle devient « Stockage des fichiers » : la somme des `taille` des fiches,
sans appel au bucket, et le seuil rouge (`SEUIL_FICHIERS_EN_BASE_OCTETS`, 500 Mo) est revu pour un stockage objet.

## 2. Lot B : le stock

### 2.1 Le quota est une limite de l'offre

- Nouveau champ de `Limites` (`src/offres/offres.ts`) : `stockageOctets`. **Base 0, Pro 100 Mo, Entreprise 500 Mo.**
  Pas de surcharge `/ops` pour l'Entreprise : à rouvrir si un client le demande.
- **Compté** : la somme des `taille` des fichiers non supprimés de l'espace (§ 2.4), images comprises.
- **Vérifié au dépôt** : contrôle rapide avant d'envoyer l'objet au bucket, puis contrôle exact sous verrou par espace
  (`pg_advisory_xact_lock`) dans la transaction qui écrit la fiche. Deux dépôts simultanés ne peuvent pas dépasser.
  Refusé dans la transaction -> l'objet déjà déposé est effacé. Un objet orphelin ne naît que d'une course perdue
  suivie d'un échec d'effacement, et il est sous le préfixe de l'espace, donc effacé avec lui.
- **Au-dessus du quota** (changement d'offre) : rien n'est effacé, les envois continuent. Le dépôt suivant est refusé
  par le refus d'offre habituel (`src/offres/refus.ts`), avec la raison et le lien vers l'offre.
- **La vue de l'offre l'annonce**, comme les autres limites (`src/offres/vue.ts`, l'outil MCP `get_plan`, et la page
  des offres de la vitrine si elle liste les limites).

### 2.2 Un même fichier ne compte qu'une fois

Colonne `empreinte` (SHA-256 des octets), unique par espace parmi les fichiers non supprimés (index partiel). Déposer
à nouveau un fichier identique rend la fiche existante, sans rien consommer, même au-dessus du quota. Sans ça, une
même vidéo posée dans trois scénarios coûterait trois fois son poids.

### 2.3 Le dépôt s'ouvre au Pro

Le module de routes de la médiathèque est monté aujourd'hui avec `toutes('rcs')` (`src/server.ts`) : seule
l'Entreprise a le RCS, donc **le bloc « message rapide » d'un espace Pro ne peut pas recevoir d'image aujourd'hui**
(constaté à la lecture du code le 2026-10-14). La fonction exigée devient `scenarios` : c'est équivalent pour
l'Entreprise, qui a les deux, et ça ouvre le Pro. La route publique `/m/` n'est pas concernée (aucun espace dans son
adresse).

### 2.4 Supprimer : refusé tant que le fichier sert, puis doux pendant 30 jours

**Refusé tant qu'il sert.** Un fichier est « utilisé » si son code (`/m/<code>.`) apparaît dans un contenu de l'espace
qui peut encore partir :
- les scénarios, **brouillon ET publié** (`workflows.draft_graph` et `workflows.graph`) ;
- les messages RCS enregistrés non supprimés (`rcs_messages.content`) ;
- les campagnes pas encore terminées (`campaigns.rcs_message`), leurs brouillons (`campaign_drafts.state`) et les
  étages des chaînes en cours (`campaign_etages.rcs_message`).

Le refus nomme ce qui l'utilise (« utilisé par le scénario X »). 🔴 **Cette liste dérive dès qu'un écran neuf se met
à téléverser** : un test dérive les composants qui utilisent `ChampImageHebergee` dans `web/`, et échoue si l'un
d'eux n'est rattaché à aucun lieu de la liste.

**Puis doux pendant 30 jours.** Supprimer pose `supprime_le` :
- tout de suite, le fichier sort de la médiathèque et **libère le quota** ;
- pendant 30 jours, `/m/` le sert encore et la préparation d'envoi le lit encore : un visuel RCS déjà livré peut être
  téléchargé tard par l'opérateur, et casser une adresse déjà distribuée est sans recours ;
- au-delà, une étape de la purge du worker (par lots, `purgerJusquAEpuisement`) efface l'objet PUIS la fiche. Si
  l'effacement de l'objet échoue, la fiche reste et le passage suivant recommence ; effacer une clé absente réussit
  en S3, donc l'état intermédiaire se répare tout seul.

### 2.5 La médiathèque à l'écran

Une page de la console (Paramètres) : la jauge « X Mo sur Y Mo », la liste (nom, type, taille, date), et Supprimer.
Trois routes, toutes d'espace, sous `etapeEspace` comme les autres : lister, supprimer, ouvrir un fichier (§ 3.2).

## 3. Lot C : vidéo et PDF dans le bloc « message rapide »

### 3.1 Ce qu'on accepte, tranché par les octets

| Type | Reconnu par | Plafond | Contrôle en plus |
|---|---|---|---|
| Image | signature JPEG, PNG, GIF (inchangé) | 2 Mo (inchangé) | |
| Vidéo | `ftyp` aux octets 4 à 8 | 16 Mo, la constante de l'en-tête vidéo des templates (`src/http/media.ts`) | encodage, ci-dessous |
| PDF | `%PDF-` en tête | 16 Mo | |

**L'encodage d'une vidéo se lit au dépôt**, sinon Meta accepte le téléversement et le message ne se livre pas, ou ne
se lit pas sur Android. Une fonction pure parcourt les boîtes MP4 (`moov` > `trak` > ... > `stsd`, que `moov` soit en
tête ou en fin de fichier) et refuse :
- une piste vidéo qui n'est pas H.264 (`avc1`, `avc3`) : le cas courant est le HEVC d'un iPhone (`hvc1`, `hev1`) ;
- plus d'une piste audio, ou une piste audio qui n'est pas AAC (`mp4a`) ;
- le profil High (`avcC`, profil 100 et plus) AVEC des images B (présence d'une boîte `ctts`) : la combinaison
  qu'Android ne lit pas.

Chaque refus dit quoi faire (« exportez en H.264, profil Main », et le réglage courant des logiciels). Aucun
transcodage chez nous : c'est hors périmètre.

**Le type annoncé par le navigateur ne compte jamais**, comme pour les images : un PDF renommé en `.mp4` est refusé.

### 3.2 Vidéos et PDF ne sont jamais publics

- `/m/` ne sert **que les images**, comme aujourd'hui (l'opérateur RCS en a besoin). Une vidéo ou un PDF y rend 404.
  Un PDF public sur `api.messagingme.app`, c'est un hébergeur de documents offert ; un signalement Safe Browsing
  bloquerait **tout le domaine de l'API**.
- **La préparation d'envoi lit le fichier directement**, sans passer par HTTP : si l'adresse est l'une des nôtres
  (`/m/<code>.<ext>`), `TemplateMediaPreparer.prepareOne` lit la fiche par (espace, code) puis l'objet au bucket.
  Un code d'un AUTRE espace n'est pas trouvé. Les images y gagnent aussi : aujourd'hui le worker se télécharge
  lui-même à travers Cloudflare. Une adresse étrangère (le CDN de Meta, pour les templates) garde le chemin HTTP
  actuel. Faute de fiche pour cet espace, une adresse `/m/` repasse par HTTP : une image publique d'un autre espace
  marche comme avant, une vidéo ou un PDF échoue, donc le bloc refuse.
- **L'aperçu dans la console** passe par une route d'espace sous session (`nosniff`, `attachment` pour le PDF). La
  session voyage dans un en-tête `Authorization`, qu'une balise `<video src>` ne sait pas envoyer : l'écran télécharge
  le fichier puis l'ouvre (le motif des médias de l'Inbox).

### 3.3 Le champ du bloc

Le bloc garde le champ `imageUrl`, qui porte `/m/<code>.<ext>` ; **l'extension dit le type** (`jpg`, `png`, `gif`,
`mp4`, `pdf`). Les scénarios enregistrés portent déjà cette clé, et trois lecteurs la lisent (le moteur, la miniature
du bloc, les alertes de montage). Le nom ment désormais : un commentaire le dit au point de lecture, et le renommer
réécrirait chaque graphe enregistré.

### 3.4 L'envoi WhatsApp

| Le bloc porte | Ce qui part |
|---|---|
| des réponses rapides + un fichier | interactif `button`, en-tête `image`, `video` ou `document` |
| un bouton de lien + un fichier | interactif `cta_url`, même en-tête |
| un fichier, sans bouton | message `image`, `video` ou `document`, le texte en légende |
| ni fichier ni bouton | texte simple (inchangé) |

- Un document part avec `filename` = le nom d'origine (déjà gardé dans la fiche), extension `.pdf` imposée, `document.pdf`
  à défaut.
- `MetaClient` : l'en-tête passe d'un `mediaId` d'image à `{ type, id, filename? }`, et `sendImage` devient un envoi de
  média typé. `ClientDesEnvois` (un `Pick` consommé sur place) suit.
- **La préparation qui échoue fait REFUSER le bloc**, en nommant le fichier : règle actuelle, jamais un message amputé
  de sa pièce jointe.
- 🔴 **Légende : 1 024 caractères dès qu'un fichier est joint.** L'éditeur borne aujourd'hui le texte à 4 096 sans
  bouton, même avec une image, alors que ce texte devient une légende. La borne de l'éditeur et une garde du moteur
  passent à 1 024 dès qu'il y a un fichier OU un bouton, images comprises (voir § 9).

### 3.5 Le canal RCS

Sous le champ, l'éditeur dit : « La vidéo et le PDF ne partent qu'en WhatsApp. » Sur un parcours RCS, l'exécuteur
(`src/workflow/executor.ts`, la branche qui met `imageUrl` dans une carte) **refuse** le bloc dont le fichier est une
vidéo ou un PDF, avec cette raison, AVANT de construire la carte. Sans ça, l'adresse d'un PDF partirait dans une carte
RCS que l'opérateur ne saurait pas lire.

### 3.6 L'écran

- `ChampImageHebergee` prend une option `accepte` : `image` par défaut (bloc RCS, campagnes, chaînes : inchangés),
  `image-video-pdf` pour le bloc « message rapide », qui n'accepte en image que JPEG et PNG (WhatsApp ne prend pas le
  GIF, § 11).
- L'aperçu montre l'image, ou l'icône, le nom et le poids d'une vidéo ou d'un PDF, avec « Ouvrir » (§ 3.2).
- La miniature du bloc et l'aperçu WhatsApp montrent le type de la pièce jointe.
- Le texte d'aide dit les formats, les plafonds et le quota restant.

### 3.7 Le transport du dépôt

En data URL base64, comme `/tenants/:tenantId/media` aujourd'hui : un peu plus de 22 Mo pour une vidéo de 16 Mo,
`bodyLimit` de 24 Mo. La route passe sous le plafond des routes coûteuses (10 par minute et par espace). ⚠️ **Ce choix
dépend d'une mesure** (§ 6) : si la porte HTTP du conteneur Scaleway coupe plus bas, le dépôt passe par une URL signée
vers le bucket, puis le serveur vérifie l'objet (signature, encodage) avant d'écrire la fiche.

## 4. Cas limites

- **Un fichier supprimé dont un bloc a encore besoin** : impossible tant qu'il sert (§ 2.4). Pendant les 30 jours de
  suppression douce, il se prépare encore. Au-delà, la fiche n'existe plus et le bloc refuse en nommant le fichier.
- **Un numéro remplacé** : la clé du cache de préparation porte le numéro, le nouveau re-téléverse (inchangé).
- **Un fichier déposé, puis l'espace passe en Free** : les fichiers restent et comptent (quota 0, donc plus aucun
  dépôt) ; ce qui les utilise suit les règles de l'offre Free sur les scénarios, que cette feature ne change pas.
- **Deux dépôts simultanés au bord du quota** : le verrou d'espace en laisse passer un seul (§ 2.1).
- **Le même fichier déposé deux fois** : une seule fiche (§ 2.2).
- **Un MP4 dont `moov` est en fin de fichier** : lu quand même, le dépôt a tout le fichier en mémoire.
- **Un PDF chiffré ou abîmé** : accepté s'il commence par `%PDF-` ; Meta le livre tel quel, ce n'est pas à nous de le
  lire.
- **Les adresses `/m/` historiques** (`mba.messagingme.app`, `engageme.`) : le chemin ne change pas, le routage NPM
  vers l'API non plus.

## 5. Tests

- **Unitaires** : signatures (MP4, PDF, faux PDF renommé), parcours MP4 sur des boîtes construites dans le test
  (`avc1` accepté, `hvc1` refusé, High avec `ctts` refusé, Main avec `ctts` accepté, deux pistes audio refusées,
  `moov` en fin), quota (sous la limite, au bord, Free à 0, dépassement après changement d'offre qui laisse envoyer),
  empreinte, suppression refusée par chaque lieu de § 2.4, suppression douce servie puis purgée, `/m/` en 404 pour une
  vidéo et un PDF, aperçu d'espace (un autre espace -> 404), préparation par (espace, code) sans repli public pour un
  PDF, les quatre formes d'envoi du § 3.4, refus RCS, garde de légende, étape `fichiers` de la suppression d'espace
  (faux magasin d'objets).
- **Test d'inventaire** des lieux qui portent une adresse `/m/` (§ 2.4), dérivé de `web/`.
- **Intégration (Postgres de la CI)** : les migrations (CHECK « l'un des deux », index partiel d'empreinte, CHECK des
  types élargi), deux dépôts parallèles au bord du quota, les requêtes « utilisé par » sur chaque table.
- **E2E** : `web/e2e/workflow-quick-media.spec.ts` étendu (dépôt d'un PDF, miniature, avertissement RCS). Avant de
  changer un rôle ARIA, `grep` de `web/e2e` : les e2e trouvent les éléments par rôle.
- **Auto-attaque** : les routes neuves sont de classe `tenant`, couvertes par `tests/scope-tenant.test.ts`. La lancer en
  local avant de pousser (la CI `unit` la lance).

Chaque test de non-régression se vérifie dans les deux sens (le défaut remis, il échoue sur le bon symptôme).

## 6. Mesures avant de construire

1. **La taille maximale d'une requête acceptée par le Serverless Container de l'API.** La documentation de Scaleway
   ne la donne pas pour les Containers (le plafond de 6 Mio connu concerne les Functions). Elle conditionne le § 3.7,
   et AUSSI l'existant : `POST /tenants/:tenantId/media` reçoit déjà jusqu'à 24 Mo. Transmise à la session de
   migration le 2026-10-14 : une requête de 23 Mo vers le conteneur cible tranche.
2. **Borner la clé IAM au bucket** : par l'IAM si elle le sait, sinon par une politique de bucket (lot A).
3. **Le nom affiché d'un document en en-tête interactif** : la documentation dit que `filename` choisit l'icône, pas
   qu'il est affiché. Vu à l'essai réel (§ 7), sur le téléphone de Julien.

## 7. Essai réel qui clôt la feature

Sur le téléphone de Julien, depuis un espace Pro :
1. un scénario dont le bloc porte un **PDF** et deux réponses rapides : l'en-tête document s'affiche avec son nom,
   un tap part dans la bonne branche ;
2. un bloc qui porte une **vidéo** sans bouton : la vidéo se lit avec sa légende, sur iPhone ET sur un Android ;
3. le dépôt d'une vidéo **HEVC** d'iPhone : refus lisible, qui dit quoi faire ;
4. la **jauge** du quota bouge au dépôt ; supprimer un fichier utilisé est refusé avec le nom du scénario ;
5. lot A : une adresse `/m/` d'image envoyée AVANT la recopie s'affiche toujours après le retrait de la colonne.

## 8. Méthode de livraison

**Implémenteur par lot + revue humaine du diff**, une relecture par lot : les trois lots touchent des chemins que la
production emprunte (l'envoi d'un bloc, une migration qui retire une colonne, la purge, la suppression d'un espace) et
portent des invariants invisibles (l'isolation par espace d'une lecture sans HTTP, une porte à sens unique, un index
partiel). La vérification d'interface (dépôt, aperçu, refus) se fait à l'œil, en plus des e2e.

## 9. Déploiement

- **Lot A** : Julien crée le bucket et la clé, pose les variables -> migration A1 -> API et worker -> le script de
  recopie, et son compte relu -> migration A2 avec les variables devenues obligatoires.
- **Lot B** : migration (`supprime_le`, `empreinte`, index partiel) AVANT le code -> API et worker -> la console
  APRÈS (un écran qui appelle une route neuve casse dès le push).
- **Lot C** : migration (CHECK des types élargi à `video/mp4` et `application/pdf`) AVANT le code qui les écrit -> API
  et worker -> la console APRÈS.
- `gh run view <id> --json jobs`, job par job, avant chaque `up`.
- La section « message rapide » de `features.md` est citée par une fiche d'aide : la fiche et son empreinte changent
  dans le même commit, et `tests/aide-proposer.test.ts` passe avant le push.

## 10. Rayon de souffle repéré

- **`rcs_media`** : son store, la carte `/ops` (`src/ops/stockage.pg.ts`), la cascade de la suppression d'espace, les
  tests d'intégration qui la nomment.
- **`TemplateMediaPreparer`** sert le worker ET l'API (Inbox), et les cartes de carousel des templates : la lecture
  directe ne doit toucher que nos adresses `/m/`, le CDN de Meta garde son chemin. Les deux processus ont besoin des
  variables du bucket.
- **Les signatures de `MetaClient`** (`sendInteractive`, `sendCtaUrl`, `sendImage`) : d'autres appelants que le bloc
  (gestes de l'agent IA, outils maison du MBA), à énumérer au plan.
- **`toutes('rcs')` -> `toutes('scenarios')`** sur le module de la médiathèque : les tests de l'étape d'offre.
- **Un champ de `Limites`** : `DROITS`, la vue de l'offre, `get_plan`, la documentation de l'API qui décrit les
  limites, la vitrine si elle les liste.
- **`ChampImageHebergee`** sert sept composants : l'option `accepte` garde l'image seule par défaut.
- **L'exécuteur RCS** lit `imageUrl` (`src/workflow/executor.ts`) : le refus du § 3.5 passe avant la carte.
- **La route `/m/`** sur ses trois noms d'hôte, et le cache Cloudflare d'un jour (plus court que les 30 jours de
  suppression douce, donc sans effet).

## 11. Défauts voisins, trouvés en cadrant

À vérifier au lot C, sans les présumer :
1. **Image sans bouton et texte de plus de 1 024 caractères** : l'éditeur l'autorise, Meta refuse une légende plus
   longue. Corrigé par le § 3.4 si le défaut est confirmé.
2. **Un GIF dans le bloc « message rapide »** : le champ partagé l'accepte (le RCS le lit), WhatsApp ne prend que JPEG
   et PNG. Décision : l'option `image-video-pdf` (§ 3.6) n'accepte en image que JPEG et PNG. Pour les blocs déjà
   enregistrés avec un GIF, le comportement de Meta à l'envoi se constate au lot C ; s'il échoue, le refus du bloc
   le nomme, comme toute préparation ratée.
3. **L'image du bloc en Pro** : refusée au dépôt aujourd'hui (§ 2.3). Corrigé par le lot B.
4. **Le fil de l'Inbox journalise un message rapide comme un texte** (`type: 'text'`) : la pièce jointe n'y apparaît
   pas, ni pour un opérateur ni pour l'agent IA qui relit le fil. Hors périmètre, à décider.

## Hors périmètre

- Joindre un fichier ailleurs que dans le bloc « message rapide » (envoi manuel de l'Inbox, bloc RCS, campagnes,
  chaînes) : la médiathèque le permettra, les écrans restent sur l'image.
- Choisir un fichier déjà déposé (« depuis la médiathèque ») : l'empreinte évite déjà le double comptage.
- Le transcodage d'une vidéo, l'audio, le 3GP, Word, Excel et PowerPoint (des archives ZIP, que leur signature ne
  distingue pas d'un ZIP quelconque, sur une adresse servie par nous).
- Une surcharge du quota par `/ops` pour l'Entreprise.
