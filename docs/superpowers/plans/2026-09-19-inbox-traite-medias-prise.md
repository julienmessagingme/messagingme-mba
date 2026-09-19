# Inbox : le statut « Traité », les pièces jointes reçues, et la prise d'une conversation par un agent

**Demande de Julien, 2026-09-19**, arbitrée le même jour par trois questions :

1. « il faudrait créer un nouveau status : Traité. Et si qqun revient pour parler, évidemment on enlève le
   statut et on repasse en à traiter ». Arbitrage : **deux statuts distincts**. « Traité » sort la
   conversation de « À traiter » et la laisse dans « Tout » avec une pastille ; « Archivé » continue de tout
   cacher. Un message du contact efface les deux. **Arbitrage complémentaire du même jour** : une RÉACTION
   emoji (👍) ne retire pas « Traité » et ne change pas qui a parlé en dernier ; elle sort toujours d'Archivé,
   que l'arbitrage ne visait pas.
2. « dans les conversations on doit pouvoir recevoir des photos... voire des fichiers ». Arbitrage : **pas de
   copie chez nous**. On affiche ce que Meta garde, puis on dit « expiré ».
3. « une option à la main des admin et des managers pour que les agents puissent ou non réaffecter la
   conversation ». Arbitrage : **un agent ne réaffecte jamais** (ni les siennes, ni le pot commun) ; le
   réglage l'autorise seulement à **PRENDRE** une conversation du pot commun.

Le quatrième point de la demande (retirer deux phrases de Tools > Connecteurs API) est livré à part,
commit `071e4c8d`.

## Ce que la lecture du code et la mesure ont appris avant d'écrire une ligne

- **« Archivé » faisait déjà le retour en « À traiter »** : `upsertConversationByWaId` remet
  `archived_at` à null dans la MÊME écriture qu'un message du contact (`src/inbox/store.pg.ts`). « Traité »
  se greffe sur ce même paramètre, pas sur une seconde écriture.
- 🔴 **Meta ne garde PAS les médias reçus 30 jours, mais 7.** La doc de référence : « Media IDs in webhooks
  expire after 7 days » (les 30 jours valent pour ce qu'on TÉLÉVERSE). Mesuré le 2026-09-19 depuis le
  conteneur de production : les deux seuls vocaux enregistrés (reçus il y a 7,9 et 8,9 jours) rendent
  `100 / 33` (« object does not exist »). Le dépôt affirmait 30 jours à deux endroits.
- **Le webhook capte déjà l'identifiant de TOUS les médias** (image, vidéo, document, audio, sticker) depuis
  la migration 0125 ; seul l'écran se limite à l'audio. La production n'a encore reçu ni photo ni document.
- **La route de lecture plafonne à 2 Mo**, plafond hérité de la transcription. Meta autorise 5 Mo pour une
  image, 16 Mo pour une vidéo, 100 Mo pour un document.
- 🔴 **Un manager ne peut affecter à personne** : la liste des membres (`GET /users`) est réservée aux
  admins, donc son sélecteur ne propose que « Non affectée ». Invisible parce que les 4 comptes existants
  sont admin (mesuré).
- **Paramètres est réservé aux admins** (module de réglages monté sous `gardeAdmin`, écran absent des écrans
  d'encadrement). Le réglage demandé doit être à la main des managers : l'écran s'ouvre à eux avec cette
  seule section, sur une route dédiée sous `gardeEncadrement`, comme `GET /settings/mention-ia`.

## Lot 1 : « Traité »

- Migration : `conversations.traitee_le timestamptz` nullable, sans défaut, sans index (le dossier est borné
  par l'espace, comme « Signalé » avant son index ; rien ne le justifie à cette échelle).
- `upsertConversationByWaId` : le booléen `desarchive` devient un objet `rouvre: { archive, traite }`, et le
  sens accepte `reaction`, qui garde le sens précédent. Seul `recordInbound` rouvre ; une réaction y passe
  `{ archive: true, traite: false }`.
- `A_TRAITER_SQL` exclut `traitee_le is not null`. Les trois lecteurs (liste, menu, vieille route) le
  suivent puisqu'ils citent le fragment.
- Dossier « Traité » : non archivées et `traitee_le is not null`. « Tout » les garde.
- Compteur `traitees` dans `compterConversations`.
- Routes `POST .../traiter` et `.../ne-plus-traiter`, ouvertes aux opérateurs comme l'archivage.
- Écran : entrée de menu « Traité », pastille « Traité » sur la ligne, gestes « Traité » et
  « Ne plus marquer traité » dans les deux menus de rangement (`destinationsEnLot` et la conversation
  ouverte), texte du dossier vide.

## Lot 2 : les pièces jointes reçues

- `getMessages` rend `mediaExpire` (dérivé de l'âge, une seule constante serveur de 7 jours) et le nom de
  fichier d'un document (nouvelle colonne `conversation_messages.media_nom`, captée au webhook).
- La route de lecture : `410` avec un code `media_expire` quand le message a plus de 7 jours OU quand Meta
  répond `100/33` ; un plafond PROPRE aux médias (`MEDIA_ENTRANT_TAILLE_MAX_KO`, 25 Mo) au lieu de celui de
  la transcription ; `Content-Disposition: attachment` et `nosniff` pour tout ce qui n'est pas une image
  affichable.
- Écran : image et sticker affichés dans la bulle (chargés quand ils deviennent visibles dans le fil, image
  seulement, jamais un document ; « au rendu » dans la première version, corrigé sur revue) ;
  document et vidéo en bouton « Télécharger » ; vocal inchangé ; les trois disent « expiré » passé le délai.
- 🔴 Sécurité : un fichier reçu n'est JAMAIS rendu dans l'origine de la console autrement que par `<img>`
  (qui n'exécute rien) ou par un téléchargement forcé. Un `text/html` ou un SVG ouvert dans un onglet depuis
  une URL `blob:` s'exécuterait avec l'origine de la console, donc lirait la session.
- Correction des deux textes qui affirment 30 jours.

## Lot 3 : un agent PREND une conversation du pot commun

- Migration : `tenant_settings.agents_peuvent_prendre boolean not null default false`. `false` = le
  comportement d'aujourd'hui pour tout le monde.
- Règle pure dans `src/inbox/assignment.ts` : `peutPrendre(acteur, affectataire, reglage)`, vraie pour une
  conversation à personne, quand l'acteur a une identité ET (réglage actif OU acteur de l'encadrement, qui
  peut déjà tout affecter).
- Route `POST .../assignee/moi` : écriture CONDITIONNELLE (`assigned_to is null` dans le `where`), `409` si
  un collègue l'a prise entre-temps. La LISTE des conversations rend `peutPrendre`, calculé par la même
  règle, pour que le bouton et le refus ne divergent pas. (Le plan disait « la lecture du fil » : la liste a
  été préférée à l'implémentation, parce qu'elle est relue toutes les 15 s au lieu de 4, et que le drapeau ne
  dépend pas de la conversation ouverte.)
- Réglage : `GET/PATCH /settings/agents-peuvent-prendre` sous `gardeEncadrement`. Paramètres s'ouvre aux
  managers avec cette seule section ; fuseau, prix, relance et contacts bloqués restent admin.
- Réparation au passage : une liste de membres affectables ouverte à l'encadrement, pour le sélecteur des
  managers.

## Méthode de livraison

**En direct, lot par lot, puis relecture à froid du diff complet par un agent séparé (`/revue-finale`)
avant le déploiement.** La raison : les trois lots touchent des chemins que la production emprunte
(l'écriture de CHAQUE message entrant pour « Traité », le dossier « À traiter », deux migrations), mais
chacun reste petit et ses critères se vérifient par des tests d'intégration en CI, pas par une boucle
itérative. Pas de feature-loop parce que le critère décisif (le retour en « À traiter » au message suivant)
vit dans une écriture SQL que seul un test d'intégration voit, et pas de workflow parce que rien n'est
répétitif. Ordre de la migration : UNE seule (0160) pour les trois lots, qui AJOUTE trois colonnes que le code
écrit ou nomme, donc AVANT le déploiement.

**Essai réel qui clôt la feature**, à faire par Julien sur son espace après déploiement :

1. Envoyer depuis son téléphone une photo puis un PDF au numéro ; les voir dans le fil (photo affichée,
   PDF téléchargeable avec son nom).
2. Marquer la conversation « Traité » : elle quitte « À traiter », reste dans « Tout » avec sa pastille.
   Répondre par un 👍 depuis le téléphone : elle RESTE « Traité » et hors d'« À traiter » (seul endroit où un
   vrai payload de réaction de Meta traverse ce chemin). Puis réécrire un mot : elle revient dans « À
   traiter » et la pastille disparaît.
3. Créer un compte agent, activer le réglage dans Paramètres depuis un compte manager, et vérifier que
   l'agent voit « Je m'en occupe » sur une conversation non affectée, et rien sur celle d'un collègue.
