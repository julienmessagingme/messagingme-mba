# features.md : fonctionnel

Statut : 🔲 pas commencé · 🚧 en cours · ✅ live

`mba.messagingme.app` est **en prod LIVE** (`DRY_RUN=false`, numéro Zadarma réel). Console de gestion
WhatsApp/Meta, 2 rôles : **admin** (tout) et **agent** (inbox seule).

## Navigation (sidebar gauche, pleine largeur)

Admin : **Inbox · mini-CRM · Campagnes · Scénario · Automation · MBA (Guide / Paramètres) · Contenu (Templates / Formulaires / Blocs / Tags / Champs) · Analytics (Quantitatif / Qualitatif) · Paramètres · Support**, plus un bloc **Developers (Documentation API / Clés d'API)** collé **en bas** de la barre.
Les groupes **MBA**, **Contenu**, **Analytics** et **Developers** sont **repliables** (clic sur l'en-tête, chevron) : ouverts d'office quand on est sur une de leurs pages, sinon repliés.
Agent : **Inbox** seule. Menu **Compte** en haut à droite (**toggle langue FR/EN**, Compte & équipe, Abonnement*, Billing*,
Déconnexion ; *désactivés, câblage Stripe hors lot). RBAC = barrière serveur (preHandler), l'UI ne fait que masquer.
- ✅ **Interface bilingue FR/EN COMPLÈTE** : un toggle dans le menu Compte bascule TOUTE l'interface en anglais
  (mémorisé par navigateur, défaut français), **y compris les dates (« Today/Yesterday/12 July 2026 »), les
  nombres (« 1,000 »), les paliers d'envoi (« 1,000 customers / 24 h », « Unlimited ») et les pourcentages**. Le
  toggle est aussi disponible **avant connexion** (login, inscription, mot de passe oublié, invitation). Pour
  les clients internationaux (Dubaï) et le screencast d'App Review Meta.
- ✅ **Après connexion, un admin arrive sur l'Accueil (Home)** (numéro + statut du compte), plus sur Analytics.
- ✅ **Paramètres (menu « Paramètres », admin)** : le **fuseau horaire** de l'espace et les **heures d'ouverture**
  jour par jour (heure de début, heure de fin, ou « fermé »). C'est la base sur laquelle s'appuient les conditions
  de temps des scénarios (l'heure qu'il est, le jour de la semaine, « dans les heures d'ouverture »). Un jour dont
  l'heure de fin précède l'heure de début est signalé en rouge et bloque l'enregistrement.

## Comptes & authentification

- ✅ **Inscription libre** (`/signup`) : n'importe qui crée **son propre espace** (nom d'espace + email + mot de
  passe) et en devient l'**admin**. Redirige vers l'accueil (connecter le numéro).
- ✅ **Se connecter avec Google** (bouton sur `/login`, `/signup`, `/invite`) : vérif du jeton côté serveur ;
  liaison **par email** (compte existant -> connexion ; email inconnu -> crée un espace, comme un signup).
- ✅ **Invitations d'équipe** (admin) : inviter un membre par email (Resend) -> il pose son mot de passe (ou
  Google) via un lien, puis rejoint l'espace avec le rôle défini. Le compte reste « invité » tant qu'il n'a pas
  activé. L'email est un **HTML brandé** (logo Messaging Me, couleurs de marque) et **personnalisé** (« X t'invite
  à rejoindre l'espace Y »). **La création de compte par mot de passe (posé par l'admin) est SUPPRIMÉE** : on
  n'ajoute un membre QUE par invitation (front + route + code backend retirés).
- ✅ **Mot de passe** : « oublié » (`/forgot`, lien de réinitialisation par email, réponse toujours générique
  anti-énumération) + changement depuis le compte (`/compte`).
- ✅ **Crochet paiement (inerte)** : chaque espace a un statut (`trial|active|locked`) ; un espace `locked`
  serait bloqué (403). Pas de Stripe pour l'instant, le contrôle est en place mais neutre.

## Contacts & CRM

- ✅ **mini-CRM : moteur de filtres + actions en masse** (2026-07-28) : l'écran Contacts filtre par **tag**
  (possède / ne possède pas, tous ou au moins un), **opt-in**, **nom**, **téléphone** (commence par / contient),
  **valeur de champ** (contient / ne contient pas / vide / rempli / égal) et un contrôle **Email** dédié (rempli /
  vide / valeur précise), cumulables. On **coche** des contacts (la case d'en-tête coche toute la page affichée) ;
  si le filtre ramène plus de contacts que l'écran n'en montre, un lien **« Sélectionner les N contacts
  correspondants »** étend la sélection à tout le segment, re-résolu côté serveur au moment d'appliquer l'action
  (les lignes décochées entre-temps restent exclues). Le nombre exact n'est affiché **que lorsqu'un filtre est
  posé** : sans filtre, la liste s'arrête à 500 et affiche « 500+ ». Puis un menu **« Action »** applique en masse :
  **ajouter / retirer un tag**, **poser un champ** (une valeur sur toute la sélection), **supprimer**. La
  suppression est **douce** (réversible en base, l'historique de campagnes est préservé) ; un contact supprimé
  disparaît des listes ET n'est plus destinataire de campagne. Ré-importer son numéro le ressuscite.
  Une action en masse (et l'import CSV) **ne déclenche aucun scénario** : poser un tag sur 5 000 contacts d'un coup
  ne lance pas l'automation « tag ajouté », sinon ce serait autant de messages facturés. Seul un tag posé sur
  **une** fiche la déclenche. Pour toucher une liste entière, c'est la campagne.
- ✅ **Contacts / opt-in** : opt-in tracé, tags. **Identité = numéro OU BSUID** (compte WhatsApp d'un client qui
  n'a pas partagé son numéro, post-octobre) : le tableau porte **une colonne par identité** (Téléphone, BSUID,
  WhatsApp ID), chacune remplie quand elle existe, et la **fiche** affiche en sous-titre celle qui identifie le
  contact (le numéro, sinon le BSUID). Un client qui **écrit** à l'entreprise crée automatiquement sa fiche (par
  numéro ou BSUID), opt-in « inconnu » (donc hors marketing tant qu'il n'a pas consenti).
- ✅ **Import CSV** : on dépose le fichier (ou on colle le texte), puis on **coche colonne par colonne** ce qu'on
  importe et on associe chacune à Téléphone, Nom, Prénom, Email, Ville, Société ou un champ perso (créé au
  passage) ; deux valeurs d'exemple par colonne aident à choisir, et les colonnes reconnues sont pré-cochées. Le
  téléphone est normalisé en E.164 et **une colonne Téléphone est obligatoire** (c'est la clé du contact). On pose
  l'opt-in et des tags pour tout le lot, et l'import rend un compte rendu (créés / mis à jour / ignorés, avec le
  motif des lignes en erreur).
- ✅ **Fiche contact éditable** : sur la fiche, on **modifie ou supprime** la valeur de chaque champ perso en
  place, et on édite le **Nom** et le **Prénom**. Le **téléphone et le BSUID restent en lecture seule** (ce sont
  les identités qui routent les messages WhatsApp). Un champ « orphelin » (dont la définition a été supprimée)
  reste supprimable. Toujours sur la fiche : on **affecte ou retire un tag** (les tags existants sont suggérés à
  la saisie), on renseigne un champ déjà déclaré, et on peut **créer un champ entièrement nouveau (libellé + type)
  sans quitter la fiche** : il rejoint les champs de l'espace et sa valeur est posée sur ce contact dans la foulée.
- ✅ **Onglet « Historique » sur la fiche contact** (2026-07-20) : deux vues de tout ce que ce contact a vécu.
  **Campagnes reçues** : quelle campagne, quel template ou scénario, quand, et où en est le message (envoyé,
  délivré, lu, non délivré, écarté, envoi en échec avec son motif). Un message parti dont Meta n'a jamais
  renvoyé de statut est marqué « envoyé, statut inconnu » et jamais « non délivré ». **Conversations** : chaque
  échange avec son nombre de messages, son dernier aperçu, et son analyse IA quand elle existe (sentiment,
  sujet, résolu ou non, traité par un humain ou par le bot). Une analyse rendue caduque par un message plus
  récent est signalée « à rafraîchir » plutôt que présentée comme à jour. Un clic ouvre le fil dans l'inbox.
  Un bouton **« Exporter en CSV »** télécharge la totalité des campagnes reçues par ce contact (campagne, statut,
  livraison, type, template ou scénario, date d'envoi, erreur brute et son explication en clair), sans la limite
  d'affichage de l'écran.
- ✅ **Tags** (menu Contenu) : renommer (re-dédup si la cible existe), supprimer -> répercuté sur tous
  les contacts. **Créer un tag** réutilisable depuis cette page, même sans aucun contact qui le porte : il devient
  aussitôt une suggestion dans les filtres, sur la fiche et dans les blocs de scénario. Chaque tag affiche **son
  nombre de contacts** ; cliquer sur ce nombre ouvre la liste des contacts qui le portent (500 premiers). Un tag
  saisi dans un bloc **« Action » (choix « Ajouter un tag »)** d'un scénario **apparaît aussi ici dès qu'on quitte
  le champ**, sans attendre l'enregistrement du scénario. Les anciens blocs « ajout de tag » se comportent de la
  même façon. Dérivés des contacts + tags déclarés.
- ✅ **Blocs** (menu Contenu, 2026-07-17) : liste à plat de TOUS les blocs de tous les scénarios, **filtrable par
  type** (Envoi template / Message rapide / Formulaire / Action / Condition / Inbox ; les anciens blocs « Ajout de
  tag » et « Ajout de champ » n'ont plus de filtre dédié mais restent affichés avec leur libellé d'origine),
  présentée en colonnes **Type | Nom | Scénario | Code**. La colonne **Nom** affiche le **nom libre** donné au bloc
  dans le scénario (champ « Nom du bloc », optionnel, ex. « Relance J+3 »), à défaut un résumé automatique de son
  contenu, à défaut « (sans nom) » ; ce nom remplace aussi le libellé de type sur la carte du bloc dans l'éditeur
  de scénario. Le **code public (`nod_…`) est toujours visible** (ou « non codé » pour un bloc jamais
  re-sauvegardé), et le nom du scénario est un lien qui l'ouvre. C'est la vue qui sert à retrouver le code d'un
  bloc précis (adressage d'une future API). **Recherche** (2026-07-28) : un champ texte filtre les blocs par
  **contenu, nom du bloc, nom du scénario, code ou type**, insensible à la casse et aux accents, **cumulable**
  avec le filtre de type. Filtrage instantané côté client.
- ✅ **Champs** (menu Contenu) : **créer un champ** (libellé + type parmi texte, nombre, date, date et heure,
  oui/non, lien), éditer le libellé / le type, supprimer. Supprimer la définition d'un champ **ne détruit pas les
  valeurs déjà saisies** sur les contacts : elles restent lisibles sur les fiches, où on peut les retirer une par
  une. La **clé est verrouillée** (renommer la clé casserait le mapping des campagnes) -> on édite label/type
  seulement. **Champs de base « système »** (Nom, Prénom, Téléphone, BSUID, WhatsApp ID, Email) : toujours
  présents, **non supprimables**, utilisables comme sources de variable partout.
- ✅ **Colonne « WhatsApp ID »** dans le tableau contacts (à côté du BSUID) : les chiffres du numéro sans « + »
  (la clé de routage que Meta émet), ou le BSUID si le contact n'a pas de numéro.
- ✅ **Codes publics (socle API) COMPLET** : chaque **scénario, bloc de scénario, champ (perso ET de base)
  et tag** porte un code unique lié au client (ex. `scn_by5p57_01KXNV…`, `nod_…`, `fld_…_sys_email`), affiché
  discrètement (liste des scénarios, panneau de config d'un bloc, page Champs, page Tags). C'est l'identifiant
  stable qu'une future API utilisera. Les codes des blocs sont posés côté serveur à l'enregistrement (un code
  existant n'est jamais changé).

## Templates (menu Contenu)

- ✅ **Création** : template simple (**en-tête optionnel** texte / image / vidéo, corps + variables, **pied de
  page optionnel**, boutons quick-reply / URL / **Flow**) ou **carousel** (message d'introduction commun à
  toutes les cartes + 2-10 cartes image, texte de carte optionnel, boutons identiques sur toutes les cartes).
  Soumission à validation Meta, suivi du statut. En-tête texte et pied de page : 60 caractères max, sans
  variable (l'en-tête texte accepte un titre fixe uniquement).
- ✅ **Langue = menu déroulant** (39 langues WhatsApp, plus de champ libre) **sur le template simple** ; une
  langue hors liste est aussi refusée côté serveur. Une langue existante hors liste (ancien champ libre) reste
  affichée à l'édition. Un **carousel** ne propose ni langue ni catégorie : il est toujours créé en
  **français**, catégorie **marketing**.
- ✅ **Sélecteur de variable + chips dans le corps** : bouton « + Variable » → on choisit une source dans **deux
  groupes (« Champs de base » : Date du jour (auto), Nom, Prénom, Téléphone, BSUID, WhatsApp ID, Email ·
  « Mes champs » : les champs perso), exactement la même liste que la campagne** au lieu de taper `{{n}}`.
  La variable s'affiche **directement dans la zone d'édition comme une puce lisible `[Prénom]`** (plus de `{{1}}`),
  et **l'exemple exigé par Meta se remplit tout seul**. La source « Date du jour (auto) » se remplit à l'envoi
  avec la date du jour. **Chaque variable DOIT être rattachée à une source : l'enregistrement est bloqué
  sinon** (fini le `{{n}}` tapé à la main qui partirait vide et se ferait rejeter par Meta). Supprimer une puce
  puis en réinsérer une ne casse pas la numérotation (renumérotée proprement à l'envoi).
  Le lien variable→champ est mémorisé : à la création d'une campagne avec ce template, le mapping est **déjà
  pré-rempli** (modifiable). Le texte d'un **bouton** est limité à **25 caractères** (limite Meta).
- ✅ **En-tête média** : l'image **ou la vidéo** uploadée s'affiche pour de vrai dans l'aperçu WhatsApp (plus
  juste une icône).
- ✅ **Envoi d'un carousel** : un template carousel s'envoie **depuis une campagne**, les images de chaque carte
  étant relues au lancement (l'opérateur n'a rien à ressaisir). Avant, tout envoi de carousel échouait pour
  100 % des destinataires, avec un message qui parlait d'une variable alors que le template n'en avait aucune.
  Deux cas sont désormais refusés d'avance, avec la raison exacte portée sur chaque destinataire : une carte
  dont l'image n'est pas récupérable, et une carte dont le texte contient une variable (le lien variable de
  carte vers champ client n'existe pas). Un carousel n'est **pas** proposé à l'envoi manuel depuis l'Inbox,
  et le sélecteur explique où l'envoyer.
- ✅ **Boutons d'un carousel : un texte et un lien PROPRES À CHAQUE CARTE**. On règle une fois la disposition
  (jusqu'à 2 boutons, réponse rapide ou lien), puis chaque carte a son propre libellé et sa propre destination :
  la carte « Masterclass » renvoie à la masterclass, la carte « Portes ouvertes » aux portes ouvertes. Avant, un
  jeu de boutons unique s'appliquait à toutes les cartes, donc 10 cartes pointaient au même endroit. Contrainte
  Meta respectée et affichée : la disposition (nombre, types, ordre) doit être la même sur toutes les cartes,
  seuls le texte et le lien varient. Le champ du lien occupe désormais toute la largeur de la carte.
- ✅ **Le bloc d'envoi montre l'aperçu du message** : un bloc « envoi de template » configuré sur un carousel
  affiche le message tel qu'il partira (bulle d'introduction, vignette de chaque carte, son texte, ses boutons).
  Les cartes sont **empilées et défilantes** : le bloc garde sa taille même avec 10 cartes. Les points de
  liaison, eux, restent listés juste sous l'aperçu, toujours visibles, chacun étiqueté par sa carte.
- ✅ **Brancher un scénario sur les boutons d'un carousel** : un bloc « envoi de template » qui envoie un
  carousel expose désormais **une sortie par bouton de carte** (10 cartes x 2 boutons = 20 destinations), chacune
  étiquetée « C1 », « C2 »… pour savoir de quelle carte elle vient. Avant, le bloc n'affichait aucune sortie et
  rien ne pouvait être branché après lui. Les boutons **lien** restent volontairement non reliables : ils ouvrent
  le navigateur et ne renvoient rien à WhatsApp, il n'y a donc aucun événement à brancher.
- ✅ **Aperçu d'un carousel déjà créé** : cliquer sur le nom d'un template carousel montre ses vraies cartes
  (image, texte, boutons) façon WhatsApp, au lieu d'un simple encadré. Une carte sans image visible, une carte
  vidéo, ou une image devenue injoignable sont annoncées telles quelles, jamais une vignette cassée.
- ✅ **Édition** (templates simples) : corps / boutons / catégorie. Avertissement « repasse en validation Meta ».
  **Bloquée** si le template a un **en-tête média** (image ou vidéo : Meta le supprimerait) ou s'il s'agit d'un
  **carousel**, ou s'il est utilisé par une **campagne active** (garde-fou anti envoi cassé). Un **pied de
  page** ou un **en-tête texte** n'empêchent pas l'édition. Nom et langue non modifiables (immuables chez Meta).
- ✅ **Pas d'édition tant que Meta n'a pas tranché** : un template encore en attente de validation n'est pas
  éditable (seuls approuvé, refusé et suspendu le sont). Le message le dit explicitement.
- ✅ **Suppression** : par nom (toutes langues) ; bloquée si une campagne active l'utilise.

## Formulaires (WhatsApp Flows, menu Contenu)

- ✅ **Constructeur visuel, tous les composants** : éléments ordonnables (monter / descendre / retirer) :
  titres (grand / sous-titre) / paragraphe / légende / **image** / saisies (texte, e-mail, téléphone, nombre,
  **code secret**, zone de texte, **date**) / **choix** (liste déroulante, **choix unique**, **choix
  multiple**) / **consentement (OptIn)** / **bouton final au libellé personnalisable**. Chaque champ se coche
  **Obligatoire** ou non, et chaque libellé de champ doit être unique (tous écrans confondus). **Aperçu fidèle
  de l'écran WhatsApp** en direct (le même rendu s'ouvre en cliquant sur le nom d'un formulaire dans la liste).
- ✅ **Formulaires MULTI-ÉCRANS** (2026-07-17) : onglets d'écrans dans le constructeur (ajouter / renommer /
  réordonner / supprimer, jusqu'à 10), titre d'en-tête et bouton « Continuer » personnalisables par écran, le
  dernier écran porte le bouton final. L'aperçu se **pagine** (◀ Écran N/M ▶), la miniature montre l'écran 1.
  Toutes les réponses (tous écrans confondus) reviennent d'un coup à l'envoi du formulaire.
- ✅ **Champs conditionnels** (2026-07-17) : chaque élément (texte, image ou champ) peut être « **Visible si…** »
  une liste à choix unique ou un consentement PLUS HAUT sur le même écran a une certaine valeur (est / n'est
  pas). Le contact ne voit le champ que si sa réponse le déclenche ; un champ resté masqué n'écrase JAMAIS une
  valeur déjà connue de la fiche contact. Badge « 👁 Visible si… » dans l'aperçu.
- ✅ Chaque **champ de saisie se range dans un user field du contact** (« Nouveau champ » d'après le libellé,
  ou un user field existant). À la réception du formulaire rempli, les valeurs atterrissent dans la fiche contact
  + la réponse apparaît dans l'inbox. **Champs de base proposés** (2026-07-28) : le menu « Enregistrer dans »
  propose désormais les champs de BASE (**Nom, Prénom, Email**) en plus des champs perso, et **suggère** celui qui
  correspond au libellé du champ (« Email » → Email, « Nom » → Nom…), insensible casse/accents. Le champ de base
  « Nom » alimente le nom d'affichage du contact (profile_name), les autres la fiche.
- ✅ **Consentement (OptIn) exploitable** (2026-07-17) : dans le constructeur, un champ « Consentement » se range
  dans le **champ Oui/Non de ton choix** (par défaut « Consentement WhatsApp », créé automatiquement). Quand le
  contact coche la case et envoie, on enregistre le champ ET **on passe son statut opt-in à « accepté »** : il
  devient éligible aux campagnes marketing (le consentement capté sert enfin à quelque chose). Un consentement
  frais l'emporte sur un désabonnement antérieur. Les valeurs Oui/Non sont stockées de façon uniforme.
- ✅ **Brouillon puis publication** : un formulaire créé depuis le menu Contenu naît en **brouillon** (badge dans
  la galerie) et n'est utilisable qu'une fois **publié** (bouton « Publier », avec confirmation : la publication
  est irréversible, un formulaire publié ne se modifie plus). Seuls les formulaires publiés sont proposés à
  l'attache d'un bouton Flow de template.
- ✅ **Depuis un template** : le bouton « + Flow » crée un formulaire inline (publié aussitôt) OU en choisit un
  déjà publié, puis l'attache au template (bouton FLOW exclusif).
- ✅ **Édition / duplication** : un brouillon s'édite ; un formulaire publié est immuable, l'action
  **« Dupliquer »** en crée une copie modifiable (« … (copie) », « … (copie 2) » si le nom est pris) qui s'ouvre
  aussitôt en édition.
- ✅ **Suppression** : un brouillon est supprimé, un formulaire publié est déprécié (Meta ne permet pas de le
  supprimer). Si le formulaire est encore rattaché à un template, Meta refuse et le message est affiché.

## Automatisations (menu « Scénario », ex-« Flow »)

- ✅ **Bloc « Attente »** (2026-08-15) : met le parcours en pause pendant un délai choisi en minutes, heures ou
  jours (30 jours maximum), puis la suite repart toute seule. Le délai est tenu à la minute près environ. Un
  bloc dont la durée n'est pas encore choisie laisse simplement passer, il ne bloque personne.
  ⚠️ **Après une attente, seul un envoi de template peut encore partir.** WhatsApp n'accepte un message libre
  que dans les 24 h qui suivent le dernier message du client. Le constructeur signale donc en clair un montage
  « attendre 24 h ou plus, puis message rapide », en nommant les deux blocs concernés. Et si la fenêtre s'avère
  fermée au moment de la reprise, le message n'est pas envoyé : la conversation remonte dans l'Inbox pour
  qu'une personne la reprenne, plutôt que de compter un envoi qui n'a jamais eu lieu.
- ✅ **La nature d'un bloc se choisit à sa création, plus après** : le panneau de droite ne sert qu'à configurer
  le bloc (choix du template, de l'action, de la durée…). Quand on tire une flèche dans le vide, ou qu'on insère
  un bloc sur une flèche existante, la liste des natures s'affiche et on choisit. Avant, le bloc était deviné
  puis se changeait dans le panneau, ce qui laissait derrière lui la configuration d'un autre type.
- ✅ **Éligibilité campagne élargie** (2026-08-15) : un scénario peut partir en campagne dès lors que le
  **premier message envoyé** est un template. Un tag, une action ou une condition placés avant ne changent
  rien : ils n'envoient rien. Seul un scénario qui ouvre par un message rapide ou un formulaire reste réservé
  aux contacts qui viennent d'écrire. Le refus explique désormais laquelle de ces raisons s'applique, y compris
  les deux cas moins évidents : une attente avant le premier envoi (rien ne partirait au lancement, il faut
  plutôt programmer la campagne avec « Plus tard »), et un scénario dont la branche prise déciderait de deux
  templates différents (impossible de savoir lequel paramétrer).

- ✅ **Constructeur de workflow visuel** : graphe de blocs reliés par des flèches courbées (drag-and-drop),
  `+` / ✕ sur chaque flèche pour insérer un bloc ou couper le lien, une rangée « + Créer un bloc » (un bouton
  par type), panneau de config par bloc. Blocs proposés : **envoi de template**, **message rapide**,
  **formulaire** (envoie un WhatsApp Flow), **Action** (tag / champ), **Condition** (aiguillage), **inbox**
  (passe la main à un humain). Deux blocs **MBA** (envoi vers MBA, désactivation MBA) sont affichés en plus,
  **grisés et non cliquables** tant que MBA n'est pas actif sur le numéro (2026-08-02). Les anciens blocs
  « ajout de tag » et « ajout de champ » ne sont plus proposés à la création, mais ils restent lisibles et
  modifiables sur les scénarios existants. (Éditeur React Flow.)
  **Bouton « Auto-arranger »** (2026-07-28) : réaligne les blocs en couches horizontales lisibles en un clic
  (les positions sont enregistrées par l'auto-save).
- ✅ **Bloc « Action »** (2026-08-02) : un seul bloc pour agir sur la fiche du contact, avec 4 actions au choix :
  **ajouter un tag**, **retirer un tag**, **mettre à jour un champ** (valeur fixe, ou « maintenant » = la date et
  l'heure du passage du contact), **vider un champ**. Il remplace dans la palette les anciens blocs « ajout de
  tag » et « ajout de champ ». Un tag saisi ici apparaît dans Contenu > Tags dès qu'on quitte le champ.
- ✅ **Bloc « Condition »** (2026-08-02) : aiguille le contact selon son état, avec **deux sorties à relier**,
  « Si réunie » (verte) et « Sinon » (rouge). On empile plusieurs conditions, combinées en **toutes** ou
  **au moins une** : **tag** (possède / n'a pas), **champ** (texte : contient, ne contient pas, est exactement,
  est renseigné, est vide ; nombre : égal, différent, <, ≤, >, ≥ ; oui/non ; date : est avant, est après,
  remonte à plus de / à moins de N minutes, heures, jours), **jour de la semaine**, **heures d'ouverture**
  (celles réglées par le client), **heure de la journée**, **coordonnées** (a un téléphone, un email, un
  identifiant WhatsApp), **consentement**. Sans aucune condition posée, le contact part toujours sur « Si
  réunie » ; une branche laissée non reliée arrête simplement le parcours.
- ✅ **Nommer un bloc** (2026-08-02) : chaque bloc a un champ **« Nom du bloc »** libre et optionnel (64
  caractères, ex. « Relance J+3 »). Le nom s'affiche sur la vignette du bloc à la place de son type, et se
  retrouve dans la colonne **Nom** de Contenu > Blocs, ce qui rend un gros scénario lisible d'un coup d'oeil.
- ✅ **Gérer un scénario depuis la liste** (2026-07-28) : le tableau récap garde « Ouvrir » et ajoute un menu
  **3 points** par ligne : **Tester le scénario**, **Renommer**, **Dupliquer** (copie « (copie) », « (copie 2) »…),
  **Supprimer**. Colonnes **Nom** (avec le code public du scénario), **Blocs**, **Créé le** (date + heure).
- ✅ **Tester le scénario depuis son téléphone** (2026-08-03) : « Tester le scénario » ouvre un **QR code** et un
  **lien WhatsApp** avec un mot déjà écrit. On scanne, on appuie sur Envoyer, et le scénario démarre sur son
  propre numéro, sans campagne et sans attendre qu'un vrai client écrive. Comme c'est le testeur qui parle en
  premier, même un scénario qui ouvre par un message rapide ou un formulaire se teste. Le lien est **permanent**
  pour ce scénario. La conversation de test est **marquée comme telle** : ses messages ne comptent ni dans les
  statistiques ni dans l'analyse (le numéro testeur apparaît en revanche dans le mini-CRM, comme tout numéro qui
  écrit). Sans numéro WhatsApp connecté, le mot à envoyer est affiché pour être recopié à la main.
- ✅ **Enregistrement AUTOMATIQUE** : plus de bouton « Enregistrer » ni de statut « brouillon » : le scénario se
  sauvegarde tout seul ~1 s après chaque modification (indicateur « Enregistré à HH:MM »), y compris quand on
  quitte la page ou ferme l'onglet. En cas d'échec réseau : indicateur rouge + « réessayer ».
- ✅ **Bloc « message rapide »** : un texte + **jusqu'à 3 réponses rapides** (20 caractères chacune), envoyé SANS
  template Meta approuvé (message interactif). Chaque réponse devient une **sortie à relier** (branche par
  bouton, comme un template). Depuis le 2026-08-02, il peut aussi **ouvrir un scénario**, à condition que le
  déclenchement garantisse que le contact vient d'écrire (mot-clé, premier message, lien de test) : c'est
  uniquement en **campagne** qu'il est refusé, une campagne partant sur une audience froide.
- ✅ **Bloc « formulaire » ENVOIE vraiment** (2026-07-17, fini le blocage silencieux) : le bloc envoie le
  formulaire choisi en message WhatsApp interactif, avec un **texte d'accroche** et un **libellé de bouton**
  personnalisables (pré-rempli avec le bouton du formulaire). Quand le contact soumet, ses réponses remplissent
  sa fiche et le scénario avance. Comme le message rapide, il peut désormais **ouvrir un scénario** (2026-08-02) :
  l'enregistrement n'est plus refusé. Le constructeur se contente d'un avertissement jaune sur le **premier bloc**
  du scénario, qui rappelle qu'un scénario n'ouvrant pas par un envoi de template ne pourra pas partir en
  campagne (mais reste parfaitement utilisable quand le contact vient d'écrire).
  - **Tirer une flèche dans le vide crée un bloc** à cet endroit (relié), puis on choisit son type dans le
    panneau de droite. Un **✕** en coin de chaque bloc le supprime directement (avec ses flèches).
- ✅ **Variables du template collées automatiquement** : quand un bloc « envoi template » part (au lancement OU
  au fil du workflow), les variables du template sont **remplies avec les attributs du contact** (ex. `{{1}}`
  relié à Prénom -> le prénom du contact), avec repli sur l'exemple du template. Plus besoin de re-saisir la
  variable ; corrige l'erreur Meta « nombre de variables ».
- ✅ **Sortie par bouton** : un bloc « envoi template » affiche **une sortie par bouton de réponse rapide**
  (à relier vers le bloc suivant) ; les boutons lien/formulaire sont montrés grisés (ils sortent de WhatsApp,
  non reliables). Un bloc sans réponse rapide garde une sortie unique.
- ✅ **Exécution réelle par contact** : le scénario s'exécute vraiment, contact par contact, quel que soit son
  point de départ (campagne, déclencheur d'Automation, lien de test, appel d'API) : les blocs Action s'appliquent
  au passage (visibles sur la fiche), un bloc Condition choisit sa branche, un bloc template / formulaire /
  message rapide envoie puis attend la réponse, et **le bouton tapé choisit la branche** suivie (une réponse
  texte suit la 1re sortie). Le parcours s'arrête au bloc **inbox**, qui **passe explicitement la main à un
  humain** : la conversation est marquée comme prise en charge. Et tant qu'un opérateur (ou l'agent MBA) tient la
  conversation, le scénario ne lui écrit pas : le parcours est simplement gelé et repart quand la main revient.

## Automation (menu « Automation »)

- ✅ **Lancer un scénario sur un événement, sans campagne** (2026-08-03) : un écran liste les automations (nom
  interne, déclencheur écrit en clair, scénario visé, active ou non). « Ajouter une automation » ouvre le
  formulaire ; une automation neuve est **toujours créée désactivée**, on la relit puis on l'allume d'un clic
  sur son badge. Une ligne se supprime ; pour changer son déclencheur ou son scénario, on la supprime et on la
  recrée. Un scénario supprimé entre-temps s'affiche comme tel sur la ligne. Réservé à l'admin.
- ✅ **Quatre déclencheurs proposés à l'écran** :
  - **le client envoie un mot-clé** : une liste de mots séparés par des virgules, au choix « le message contient »
    ou « le message est exactement » le mot-clé. Casse et accents ignorés.
  - **un nouveau contact écrit pour la 1re fois** (aucun réglage).
  - **un tag est posé sur un contact** : on saisit le tag qui déclenche.
  - **une conversation vient d'être analysée** : filtre par ressenti du client (négatif par défaut, neutre,
    positif, ou peu importe) et, en option, « seulement si la demande n'a pas été résolue ».
- 🚧 **Un cinquième déclencheur, « un deal HubSpot atteint une étape »** (2026-08-16) : le serveur sait le
  recevoir et le traiter, mais il **n'est pas encore proposé dans l'écran** (le menu des étapes du portail
  manque) et il reste **inerte tant que la souscription HubSpot n'a pas été envoyée** depuis le compte
  développeur. L'étape est repérée par son IDENTIFIANT, jamais par son libellé : un client qui renomme son
  étape dans HubSpot casserait sinon son automation sans que rien ne le signale.
- ✅ **Ce qui ne déclenche RIEN** (annoncé à l'écran, pas seulement en coulisse) : un tag posé **en masse**, par
  **import de fichier** ou par un scénario lancé en **campagne** (poser un tag sur 5 000 contacts enverrait
  sinon 5 000 messages : pour toucher une liste, l'outil reste la campagne) ; une conversation quand
  l'**analyse n'est pas activée** sur le compte (l'automation s'affiche « active » mais ne part jamais, un
  encart le dit à la création) ; un message reçu alors qu'un **opérateur, ou l'agent de Meta, tient la
  conversation** ; un contact pour lequel un **parcours de scénario est déjà en attente**.
- ✅ **Garde-fous d'envoi** : **anti-rebond d'une heure** par contact et par automation (un client qui répète le
  mot-clé ne relance pas le scénario), **plafond de 200 déclenchements par heure et par automation** (borne la
  facture quand un seul geste produit des milliers d'événements), et **un seul parcours à la fois par contact**.
  Si le scénario n'a finalement rien envoyé, l'anti-rebond n'est pas consommé : la prochaine vraie demande du
  client passe quand même.
- ✅ **Quel scénario peut démarrer sur quel déclencheur** : mot-clé et nouveau contact partent d'un message reçu,
  la fenêtre de 24 h est donc ouverte et le scénario peut commencer par un message rapide ou un formulaire. Tag
  posé et conversation analysée arrivent à froid : le scénario doit commencer par un envoi de template, sinon
  rien ne part. L'écran le dit avant la création.
- ✅ **« Conversation analysée » est un déclencheur différé** : l'analyse ne tourne que lorsque la conversation
  est retombée inactive. L'automation part donc après coup, jamais dans la seconde qui suit le message.

## Campagnes

- ✅ **Ce que la campagne envoie, et quand** (2026-08-11). Chaque campagne annonce, dans la liste **et** dans son
  détail, ce qu'elle envoie : `Template « promo_ete » (fr)` pour un envoi direct, `Scénario « Relance promo »`
  pour une campagne qui déclenche un scénario, `Scénario supprimé` si le scénario a disparu depuis. Une campagne
  scénario affichait avant `template ()`, parce qu'elle ne porte pas de template propre. Le détail gagne une
  colonne **« Envoyé le »** : date et heure d'envoi de chaque destinataire, ou « non envoyé ». Pour une campagne
  scénario, le template exact reçu par un contact donné se lit dans son fil de conversation, qui est la source
  fiable ; la campagne, elle, dit ce qu'elle a réellement fait, à savoir démarrer un scénario.
- ✅ **Archiver ou supprimer une campagne** (2026-07-20). Une campagne qui n'a **jamais rien envoyé** se
  **supprime** définitivement (confirmation). Toutes les autres s'**archivent** : elles disparaissent de la liste
  mais restent conservées, parce que leurs destinataires portent l'historique qui alimente les Analytics (le coût,
  le funnel, les erreurs). Archiver ne change donc **jamais** un chiffre du tableau de bord. Un lien « Voir les
  archivées » bascule sur la corbeille, d'où chaque campagne se **restaure**. Le coût affiché en haut de liste
  porte explicitement sur « les campagnes affichées », pour ne pas contredire le total du tableau de bord.
- ✅ **Créer un template depuis l'écran Campagne** (2026-07-20) : sous le sélecteur de template, un bouton ouvre
  le formulaire de création habituel sans quitter la campagne en cours. Un template neuf part en validation chez
  Meta : l'écran le dit clairement et **ne le fait pas apparaître dans la liste** (une campagne ne peut partir
  qu'avec un template approuvé), avec un bouton « Rafraîchir la liste » pour le récupérer une fois approuvé.
- ✅ **Un seul écran PLEINE LARGEUR, en 2 étapes** (refonte 2026-07-17) : fini de préparer la campagne à un
  endroit et de la lancer ailleurs. **ÉTAPE 1 Préparation** (nom + Expéditeur | Destinataires | Débit | Message)
  et **ÉTAPE 2 Lancement** (le timing) sur la même page. L'étape 2 s'active quand l'étape 1 est prête.
- ✅ **Choisir les destinataires par SOURCE** : un sélecteur de source en haut de la zone Destinataires.
  - **📇 Liste de contacts** (mini-CRM) : un vrai moteur de FILTRES combinables : par **tag(s)** (tous / au moins
    un), **opt-in**, **téléphone** (commence par / contient), **valeur de champ perso**, **nom**. Un compteur live
    « N contact(s) correspondent » ; « Tout sélectionner (N) » cible tout le segment.
  - **📄 Import fichier** : importe un CSV (même écran de mapping que l'onglet Contacts) avec un **tag obligatoire**.
    Les contacts atterrissent dans le CRM taggés, et la campagne cible aussitôt ce tag.
  - **🔗 HubSpot** (2026-07-18) : importe une **liste HubSpot** comme destinataires. Le bouton est actif seulement
    si le toggle « Campagnes via données HubSpot » est activé (sur l'Accueil) **et** que la synchronisation HubSpot
    n'est pas en pause : pendant une pause, la source est **grisée** avec l'explication au survol, au lieu d'ouvrir
    un panneau vide. On choisit une liste du portail (nom, nombre de contacts, active/statique), on importe ses
    contacts (taggés `HubSpot: <nom>`, opt-in JAMAIS présumé), et la campagne cible aussitôt ce tag. Si le portail
    n'a pas encore autorisé l'accès aux listes, une CTA de re-consentement s'affiche (ajoute la permission
    « Lists » à ce portail uniquement).
- ✅ **Débit d'envoi réglable** : une **jauge par défaut à 60 messages/min** (toujours visible depuis 2026-07-28,
  plus de case « Limiter »), ajustable de 1 à 80/min (le plafond WhatsApp) pour protéger la réputation du numéro,
  avec la **durée estimée** affichée. Le débit est respecté pour de vrai côté serveur.
- ✅ **Lancer maintenant OU plus tard** (ÉTAPE 2) : « Maintenant » lance sur place (avec un suivi inline des
  envois) ; « Plus tard » ouvre un **calendrier** (date + heure) et **programme** la campagne, qui partira toute
  seule à l'échéance. Une campagne programmée porte un badge « planifiée » + sa date dans la liste, et se
  **désprogramme** en un clic.
- ✅ **Écran de préparation (étape 1)** : le **nom est une « étape 0 » obligatoire** (2026-07-28), qui **grise les
  zones Destinataires / Message / débit tant qu'il est vide** (le lancement était déjà bloqué, c'est explicite
  visuellement) ; puis **Expéditeur en bandeau pleine largeur au-dessus** (le numéro, affiché en texte s'il n'y en
  a qu'un), et **Destinataires** (source + filtres) et **Message** (toggle **Template OU Scénario**, aperçu,
  variables) en deux cadres pleine largeur. **Tooltip** au survol template vs scénario, qui précise que **si le
  client répond, le Meta Business Agent prend le relais**.
- ✅ **La miniature du template montre ses BOUTONS** (réponse rapide / lien / formulaire), que ce soit un template
  direct ou le 1er template d'un scénario. Le suivi des destinataires (statut interne + cycle de livraison Meta) se
  **rafraîchit tout seul pendant la douzaine de secondes qui suit un lancement**, le temps de voir les statuts
  bouger ; ensuite, un bouton « Rafraîchir » remet la liste à jour.
- ✅ **Le sélecteur de scénario ne propose que ce qui peut partir** : une campagne vise une audience froide, donc
  seul un scénario qui **démarre par un envoi de template configuré** y est proposé. Les autres scénarios (qui
  ouvrent sur un message rapide ou un formulaire) restent parfaitement valides, mais réservés aux déclenchements où
  le contact vient d'écrire. Quand aucun scénario n'est utilisable en campagne, l'écran le dit et explique
  pourquoi, au lieu d'annoncer « aucun scénario » alors qu'il en existe. Les variables associées sont celles du
  **1er template du scénario**.
- ✅ **Variables associées à la création** : on associe chaque variable à sa source via un **menu déroulant**
  (« Champs de base » : Nom, Prénom, Téléphone, BSUID, WhatsApp ID, Email · « Mes champs » : les vrais champs
  perso · « Autre » : **Date du jour (auto)** et **Texte fixe**). Fini la clé tapée à la main qui pointait un champ
  inexistant. La **date du jour est recalculée à l'instant de l'envoi**, pas à la création : une campagne
  programmée pour la semaine prochaine partira avec la date du jour de l'envoi. Les valeurs sont résolues **par
  contact** : un contact à qui il manque une valeur est **sauté et signalé (« X contacts sautés »)** ;
  0 destinataire = avertissement rouge, et la campagne n'est ni lancée ni programmée. Plus jamais de « envoyé »
  alors que rien ne part. **Un template à bouton Formulaire (FLOW) part correctement** via un scénario.
- ✅ **Un destinataire non parti n'est jamais compté comme envoyé** : sur une campagne scénario, si le parcours ne
  démarre pas (fenêtre de 24 h fermée, scénario supprimé entre-temps, ou fil déjà repris par un opérateur), le
  destinataire passe en **échec avec la raison affichée**, pas en « envoyé ». Et un échec de livraison signalé plus
  tard par Meta **rebascule** la ligne du côté des échecs dans les compteurs. Fini les « 500 envoyés, 0 échec »
  alors que rien n'est parti. (Le cycle de livraison Meta détaillé reste non câblé pour les campagnes scénario
  en V1.)
- ✅ **Corriger et renvoyer un destinataire en échec** : dans le détail d'une campagne, un destinataire tombé sur
  une erreur de **variable de template** (prénom absent, valeur vide) affiche un bouton **« Corriger + renvoyer »**.
  Un mini-formulaire propose les champs concernés : on saisit la bonne valeur, elle est **enregistrée sur la fiche
  du contact** (les autres champs ne sont pas touchés), et le message repart. Si la variable est **toujours** vide,
  le renvoi est refusé avec un message clair plutôt que de rejouer le même échec.
- ✅ **Auto-relance des échecs de livraison** (réglable sur l'Accueil, désactivée par défaut) : quand un message
  échoue pour une raison connue pour être passagère, la console le **rejoue toute seule une fois**. Les échecs de
  type « pas de fenêtre » repartent au **début de la journée suivante** (entre 8 h et midi, heure de Paris), là où
  le destinataire est le plus susceptible de recevoir. Un numéro qui échoue **deux fois** est signalé
  **injoignable dans HubSpot** plutôt que réessayé indéfiniment. Le compteur d'échecs de la campagne est remis à
  plat à chaque relance, il ne double jamais.
- ✅ **Garde-fous** : opt-in requis (un opt-out explicite bloque tout, marketing comme utility ; en marketing seul
  un opt-in explicite passe), coupure automatique sur quality rating rouge ou taux d'échec trop haut, claim
  atomique anti double-envoi, idempotence. Le plafond anti-répétition par contact est **désactivé** (décision
  pilote 2026-07-15) : c'est l'opérateur qui choisit ses destinataires, un saut silencieux laissait des contacts
  « en attente » sans explication. **« Lancer »** n'apparaît que sur un brouillon ; une campagne mise en pause par
  le quality gate montre **« Reprendre »** (relance les destinataires restants) ; une campagne en cours /
  terminée / en échec n'a pas de bouton.
- ✅ **Coût estimé par campagne** : « ≈ X (devise du compte) » par campagne + total, dérivé du tarif Meta
  (pricing_analytics) × nb envoyés facturables. « indisponible » si le prix Meta ne remonte pas (jamais 0).

## Inbox

- ✅ **Qui répond à ce client, à cet instant** (2026-07-21). Une conversation appartient à un seul
  répondeur à la fois : le **scénario** (automatique), un **opérateur** (quelqu'un s'en occupe), ou
  demain l'**agent de Meta**. Un badge le dit dans la liste et dans le fil, et n'apparaît que quand ce
  n'est PAS le scénario : c'est l'exception qui doit se voir.
- ✅ **Filtre « À traiter »** dans la liste des conversations, à côté de « Toutes ». Il ne garde que les
  conversations que **le scénario ne gère plus** : quelqu'un a pris la main, le scénario a passé la main, ou
  l'agent de Meta répond. Le nombre est affiché sur l'onglet, ce qui donne une file de travail plutôt qu'un flux
  à trier à l'œil. Quand il n'y a rien, l'écran le dit explicitement (« tout est géré par le scénario ») au lieu
  d'afficher une liste vide ambiguë.
- ✅ **Écrire depuis l'inbox met le scénario en pause** sur cette conversation, que ce soit une réponse texte ou
  l'envoi manuel d'un template : les deux sont des actes d'opérateur. Avant, l'opérateur et le scénario pouvaient
  écrire au client en même temps, et le client recevait deux messages sans rapport. Tant qu'un opérateur détient
  le fil, **aucun scénario n'y écrit**, y compris une campagne qui essaierait d'en démarrer un. Le scénario n'est
  pas abandonné, il reprend là où il en était.
- ✅ **Un scénario qui arrive au bout passe la main** : quand un parcours atteint son bloc « passer à un humain »,
  la conversation bascule côté opérateur. Le badge le dit tout de suite et la conversation apparaît dans
  « À traiter ». Avant, le scénario s'arrêtait en silence pendant que le badge affichait encore « scénario », et
  personne ne voyait que le client attendait.
- ✅ **Bouton « Rendre la main »** dans le fil, quand un opérateur détient la conversation. Le scénario
  repart immédiatement, sans attendre le délai.
- ✅ **Délai de reprise réglable par espace** (page Accueil, en minutes). Passé ce délai sans que
  personne ne rende la main, la conversation repart toute seule : un onglet fermé ou un opérateur parti
  ne bloquent jamais un client indéfiniment. Vide = 2 heures. `0` = jamais de reprise automatique, la
  main reste à l'opérateur jusqu'à ce qu'il la rende.
- ✅ **Comportement au RETOUR, réglable** : juste sous le délai, on choisit ce que devient le fil à la reprise,
  **« repart au scénario automatique »** (comportement historique) ou **« reste à traiter »** (l'humain garde la
  main jusqu'à un « Rendre la main » explicite). Ce choix est **surchargeable conversation par conversation** :
  un sélecteur « À la reprise : » en tête du fil permet de dire, pour ce client-là seulement, qu'il ne doit pas
  retomber dans l'automatique. Un fil réglé sur « reste à traiter » n'est **jamais** rendu tout seul, le délai ne
  s'y applique pas.
- ✅ **Conversations** : réponse texte libre dans la fenêtre de service 24 h, et envoi d'un **template approuvé à
  tout moment** (bouton dédié à côté du champ de saisie). Hors fenêtre, le champ libre disparaît et le template
  devient le seul moyen de re-contacter, avec l'explication à l'écran. Le panneau d'envoi affiche l'aperçu
  WhatsApp, demande les variables une à une, et réclame une **URL publique** quand le template porte une image,
  une vidéo ou un document en en-tête. Formulaires Flow remplis affichés en clair, et **séparateurs de jour** dans
  le fil pour se repérer dans l'historique.
- ✅ **Rafraîchissement automatique** : la liste (~15 s) et le fil ouvert (~4 s) se mettent à jour tout seuls,
  en pause quand l'onglet est masqué (reprise au retour). **Le fil ne « saute » pas** pendant qu'on lit
  l'historique (le scroll ne redescend que sur un vrai nouveau message).
- ✅ **Pastille agent** : les bulles sortantes portent les **initiales de l'auteur** (survol = nom). Repli
  neutre pour les messages sans auteur (legacy / réponse auto).

## Analytics (menu Analytics)

- ✅ **Deux pages** (2026-07-20) : **Quantitatif** (les volumes, coûts, erreurs et funnels ci-dessous) et
  **Qualitatif** (ce que les conversations disent). Les deux ont le **même bandeau de période** et la **même
  période par défaut** (30 derniers jours). En revanche la plage choisie **ne suit pas** d'une page à l'autre :
  chaque page repart de son défaut, il faut donc la régler des deux côtés pour comparer un chiffre de l'une et
  une conversation de l'autre sur la même fenêtre.
- ✅ **Plage de dates libre** : presets 7/30/90 j **+** sélecteur de dates personnalisé (les graphes honorent
  une plage passée). Séries : contacts (cumul), templates envoyés, messages échangés. **La barre périodes +
  dates reste FIGÉE en haut au scroll** (sticky sous la barre de compte).
- ✅ **Funnel PAR campagne** : sélecteur de campagne, envoyés → délivrés → **lus** → **répondus** + taux
  (+ échecs). « Répondu » = réponse reçue après l'envoi, attribuée au dernier envoi (pas de double-comptage).
  Sous-estimation des « lus » assumée si le destinataire a coupé les accusés. Campagne-only en V1. **Ce bloc
  ignore le sélecteur de période** : il porte toujours sur la totalité de la campagne choisie, changer la plage
  ne le fait pas bouger.
- ✅ **Erreurs Meta par code ET par template** : breakdown des codes d'erreur (131049, 131047, 131026...) sur la
  période, avec libellé FR et volume, **filtrable par template** (menu « Tous les templates » / un template précis).
  La période suit le sélecteur de plage global. (Portée : campagnes ; les envois Inbox/Workflow n'ont pas de suivi
  d'erreur, cf todo.)
- ✅ **Graphe de coût estimé** : coût/jour (marketing + utility) sur la période, **filtrable par campagne
  ou par template**, tarif Meta × volume. « Tarif indisponible » affiché si Meta ne renvoie pas de prix
  (jamais de faux coût).
- ✅ **Coût / breakdown par template** (prix Meta par catégorie).
- ✅ **Conversations (analyse)** (2026-07-17, page **Analytics > Qualitatif** depuis le 2026-07-20) : lecture de l'**analyse automatique des
  conversations** (une IA classe chaque conversation). **Quanti** : donut du **sentiment** (positif / neutre /
  négatif), barres par **intention** (demande de devis, SAV, réclamation, info, prise de RDV, autre) et par
  **action suggérée** (créer un devis / rappeler / relancer / escalader / aucune = le pipeline à traiter), **taux
  de résolution**, **qui a géré** (humain, automatisé, et l'agent de Meta quand il a répondu, ce 3e segment
  n'apparaissant que lorsqu'il y en a), **friction** (nb d'échanges moyen), top sujets. **Quali** : la table des
  conversations analysées, **filtrable** (sentiment / intention / action), où chaque ligne porte la date, le
  contact, le sentiment, l'intention, le sujet, si la demande est résolue, l'action suggérée, un **indice de
  confiance en %** (grisé sous 50 %, pour repérer les verdicts à ne pas prendre au pied de la lettre) et la
  **justification** ; un **clic ouvre le fil réel dans l'inbox**. Analyse IA = **indicative**. Vide tant que peu
  de trafic (message « aucune conversation analysée sur la période » ou « analyse non activée »). Réservé admin.
- ✅ **Les conversations de test ne polluent aucun chiffre** : une conversation ouverte par « Tester le scénario »
  est marquée comme test et **écartée des statistiques** (messages échangés, templates envoyés, détail par
  template, attribution des réponses du funnel) **et de l'analyse** (elle n'est jamais analysée, donc absente
  de la page Qualitatif). Tester un scénario depuis son propre téléphone ne déforme donc pas les compteurs.

## Support (menu Support)

- ✅ **Formulaire de contact** : sujet + message -> email à l'équipe via Resend. Le **reply-to est l'email du
  compte connecté, résolu côté serveur** (2026-07-20) : il ne peut plus être choisi depuis le navigateur.
  **5 envois par minute et par compte** ; au-delà, un message invite à réessayer plus tard.
  Domaine `messagingme.app` **vérifié** (hors mode test) : les emails partent réellement (support, invitations,
  réinitialisation de mot de passe).

## Accueil (clic logo)

- ✅ **Page d'accueil** `/accueil` (clic sur le logo, admin ; c'est aussi l'écran d'arrivée après connexion) :
  « Bonjour {prénom} », une **rangée de 4 chiffres sur 30 jours** (contacts, messages échangés, templates envoyés,
  coût estimé, exactement les mêmes chiffres qu'Analytics ; un tiret plutôt qu'un faux 0 quand Meta n'a fourni
  aucun tarif), le **statut du compte WhatsApp** (pastille vert/ambre/rouge/gris, jamais de faux vert, et « Statut
  indisponible » avec un bouton Réessayer quand on n'a pas pu le lire), le **numéro** + sa **qualité en pastille de
  couleur**, le **cap d'envoi sur 24 h** (« 1 000 clients / 24 h » selon le palier Meta, « Pas encore évalué par
  Meta » tant qu'il n'y en a pas ; le débit brut en messages par seconde, identique pour tous, n'est plus affiché),
  le **nom d'affichage** et la **santé du compte**, et la carte **MBA actif/inactif** (déplacée hors du Dashboard).
- ✅ **Panneau « Compte WhatsApp Business »** (sous le numéro) : **API MM Lite**, **revue du compte** par Meta,
  **vérification d'entreprise** et **business propriétaire**, chacun avec sa pastille (vert quand c'est bon, ambre
  quand ça traîne, gris quand Meta ne dit rien). Le **moyen de paiement n'est pas lisible** par l'API WhatsApp : la
  page renvoie honnêtement vers le Business Manager Meta au lieu d'afficher une valeur inventée.
- ✅ **État HubSpot par numéro** : si un portail HubSpot est relié -> « connecté au portail <nom ou id> », l'état de la
  synchronisation (**activée / en pause / coupée**, avec pastille) et un lien vers le guide de configuration HubSpot.
  Couper la synchro ouvre un choix explicite : **mettre en pause** (réversible ; les analyses produites pendant la
  pause sont **renvoyées à la reprise**, signalé par un bandeau « rattrapage en cours ») ou **déconnexion complète**
  (délie le compte HubSpot et révoque son accès ; un avertissement prévient que cela coupe **tous** les numéros de
  l'espace, le compte HubSpot étant lié à l'espace et non à un numéro). Si aucun portail -> un bouton
  **« Connecter HubSpot »** qui lance l'installation OAuth et relie ce numéro.
- ✅ **Toggle « Campagnes via données HubSpot »**, juste sous le bloc HubSpot : autorise l'import d'une liste HubSpot
  comme destinataires de campagne. Tant que l'accès aux listes n'a pas été accordé, un bouton **« Autoriser l'accès
  aux listes HubSpot »** demande ce droit au portail déjà connecté, sans re-solliciter le reste.
- ✅ **Guide « Configurer HubSpot avec Messaging Me »** (ouvert dans un nouvel onglet depuis l'Accueil et depuis le
  Guide MBA) : connecter son compte HubSpot, **ajouter la carte Messaging Me sur la fiche contact** (Paramètres >
  Objets > Contacts > onglet Personnalisation de la fiche > Ajouter des cartes), et ce que cette carte affiche.
- ✅ **Relancer automatiquement les échecs** (interrupteur sur la carte MBA) : un envoi bloqué par une limite Meta est
  relancé le lendemain matin ; un numéro non délivrable est retenté une fois, puis marqué injoignable dans HubSpot au
  2e échec. Désactivable par espace.
- ✅ **« À la reprise, le fil… »** (sous le délai de reprise) : choisir, pour tout l'espace, ce que devient une
  conversation après l'intervention d'un opérateur. Soit elle **repart au scénario automatique** (comportement
  historique), soit elle **reste à traiter** dans l'inbox jusqu'à ce qu'un humain rende la main. Surchargeable
  conversation par conversation depuis le fil.
- ✅ **Onboarding « Connecter mon compte WhatsApp » (Embedded Signup)** : un espace **sans numéro rattaché** voit un
  bouton qui ouvre la **popup Meta** (Facebook Login for Business + config_id) ; le business choisit son compte + son
  numéro et le backend rattache tout (échange de code, webhooks, register). 🚧 **Construit et déployé, mais ACTIF
  seulement quand Meta a validé Access Verification (Tech Provider) + App Review** (soumises le 2026-07-16). Tant que
  la configuration Meta n'est pas posée, le bouton reste un placeholder « bientôt disponible ».
- ✅ **Logo Meta Business Agent** sur la carte MBA (produit de Meta), à la place de notre logo MM.

## API publique `/v1` (intégrateurs externes)

- ✅ **Clés d'API** (2026-07-17) : un admin crée des clés depuis la console (nom + périmètres). La clé n'est
  **montrée qu'une fois** à la création (jamais re-affichée, seul son empreinte est stockée). Révocable.
  Deux périmètres : « écrire des contacts » et « lancer des envois » (une clé peut n'avoir que l'un des deux).
- ✅ **Créer / mettre à jour des contacts** : `POST /v1/contacts` (un contact) et `/v1/contacts/batch` (jusqu'à
  500). Champs de base ou perso, adressés par leur clé OU leur code ; un champ perso inconnu est créé
  automatiquement. Sert à pré-charger des contacts avant une campagne.
- ✅ **Lancer un envoi** : `POST /v1/sends` envoie un **scénario** (par code ou par nom) ou un **template** à un
  lot de destinataires (jusqu'à 50). L'API crée les contacts absents à la volée puis envoie. Réponse
  **détaillée** : combien créés / retrouvés, et la liste des numéros écartés **avec la raison** (non opt-in,
  numéro invalide, hors fenêtre...). Un en-tête `Idempotency-Key` **obligatoire** garantit qu'un même envoi
  relancé ne part jamais deux fois. `GET /v1/sends/:id` donne le suivi : compteurs globaux (en attente, en cours,
  envoyés, en échec, écartés) et **une ligne par destinataire** (statut, identifiant de message, erreur, état de
  livraison : envoyé, délivré, lu, en échec). Les **réponses** ne figurent pas dans ce suivi, elles se lisent dans
  Analytics.
  ⚠️ **Changement de réponse (2026-08-11)** sur `GET /v1/sends/:id` : pour un envoi de **scénario**, le nom et la
  langue du template valent désormais **null** (au lieu d'une chaîne vide) puisqu'un scénario n'a pas de template
  propre, et un champ **nom du scénario** apparaît. Un client qui affichait la chaîne vide telle quelle voyait
  jusqu'ici un libellé vide ; c'est ce que cette bascule corrige.
- ✅ **Cibler un bloc précis d'un scénario** : `POST /v1/sends` accepte aussi le **code d'un bloc** (`nod_...`, visible
  dans Contenu > Blocs) pour envoyer ce bloc à une liste de contacts. Réservé à la **fenêtre de 24 h** : un contact
  qui n'a pas écrit récemment est écarté (`out_of_window`), jamais forcé, et un numéro inconnu est écarté
  (`unknown_contact`) au lieu d'être créé pour rien.
- L'espace client est **toujours déduit de la clé** (jamais de l'URL) : une clé ne peut voir/toucher que les
  données de son espace. Débit borné par clé.
- ✅ **Menu « Developers »** (2026-07-20), en bas de la barre latérale, réservé aux admins. Deux pages :
  **Documentation API** (adresse de base, authentification, débit, chaque endpoint avec son corps de requête,
  ses réponses et ses codes d'erreur, plus un exemple curl complet) et **Clés d'API** (créer avec un nom et des
  périmètres, lister avec date de création et dernier appel, révoquer). La clé en clair s'affiche dans une
  fenêtre au moment de la création, avec un bouton Copier : c'est le seul instant où elle existe. Une clé
  révoquée reste dans la liste, marquée comme telle.

## Exploitation `/ops` (interne, hors console client)

- ✅ **Console d'exploitation cross-tenant** `/ops` : vue **lecture seule** de TOUS les clients (protégée par
  un jeton d'exploitation saisi une fois, distinct des comptes clients). Par client : MBA on/off, numéro +
  qualité, nb d'utilisateurs / contacts / messages / templates, dernier envoi. **Signal de charge pg-boss**
  (files en attente / actifs / échoués) pour décider d'une bascule d'infra. Messages échangés/jour (global).
- ✅ **Signal de vie du worker** (le process qui envoie réellement les messages) : « Actif », « Silencieux » ou
  « Aucun signal », affiché à côté du signal de charge des files. Distingue « les files ne se vident pas » de « le
  process est mort », ce que la seule charge des files ne dit pas.

## MBA (menu « MBA » : Guide / Paramètres)

- ✅ **Page de guidage `/mba`** (2026-07-28) : page de contenu **côté client** (ton produit) qui explique
  l'**agent MBA** (le répondeur intelligent WhatsApp de Meta). Sections : ce qu'il fait (répond seul, passe la
  main à l'Inbox, vous gardez le contrôle) ; **paramétrer en 5 étapes** (activer via les conditions Meta Business
  AI + éligibilité → base de connaissance → personnalité → tester → activer et garder la main) ; **gestion des
  connecteurs** avec les DEUX sens bien séparés (**pendant la conversation** = l'agent consulte un système externe,
  sur mesure via accompagnement ; **vers votre CRM** = les conversations remontent, HubSpot dispo + lien vers son
  guide) ; **prérequis + transparence des coûts** ; encart **« bientôt configurable ici »**. Page de PRÉPARATION :
  la config live s'ouvrira quand Meta rendra l'agent disponible pour le numéro (gating vertical + ToS).
- ✅ **Page « Paramètres de l'agent »** (2026-08) : l'écran de réglage complet de l'agent MBA, présenté en **aperçu
  désactivé** tant que Meta n'a pas ouvert l'agent pour le numéro. On y voit d'avance tout ce qui sera réglable :
  **activation & audience** (tout le monde, ou liste d'autorisation uniquement), **base de connaissance**
  (informations business, FAQ, fichiers jusqu'à 100 Mo, sites web crawlés), **personnalité & compétences** (ton et
  instructions), **liste d'autorisation**, **passage de main & relances**, et **tester l'agent**. Un bandeau explique
  pourquoi c'est bloqué (les conditions Meta Business AI ne sont signables qu'à l'éligibilité, ouverte par secteur)
  et renvoie au Guide.

## À venir / hors périmètre

- 🚧 **Onboarding guidé (Embedded Signup)** : bouton + popup + backend **construits et déployés** (OFF par défaut) ;
  en attente de validation Meta (Tech Provider + App Review, soumis 2026-07-16). Option pool de numéros = plus tard.
- 🚧 **Agent MBA** (auto-réponse IA, configuration LIVE) : bloqué par les ToS Meta Business AI (gating vertical).
  Le menu **MBA** existe déjà, avec sa page **Guide** et sa page **Paramètres** (aperçu désactivé de tous les
  réglages) ; ces réglages deviendront actifs à l'éligibilité du numéro.
- 🔲 **Abonnement / Billing** (Stripe) : menus câblés (désactivés), intégration hors lot.
- 🔲 **Rapport mensuel auto** : score agent + stats campagnes.
- Hors V1 (discipline anti tailor-made) : multicanal, segments avancés, A/B testing.
