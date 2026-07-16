# features.md — fonctionnel

Statut : 🔲 pas commencé · 🚧 en cours · ✅ live

`mba.messagingme.app` est **en prod LIVE** (`DRY_RUN=false`, numéro Zadarma réel). Console de gestion
WhatsApp/Meta, 2 rôles : **admin** (tout) et **agent** (inbox seule).

## Navigation (sidebar gauche, pleine largeur)

Admin : **Inbox · Contacts · Campagnes · Scénario · Contenu (Templates / Formulaires / Tags / Champs) · Analytics · Support**.
Agent : **Inbox** seule. Menu **Compte** en haut à droite (**toggle langue FR/EN**, Compte, Abonnement*, Billing*,
Déconnexion ; *désactivés, câblage Stripe hors lot). RBAC = barrière serveur (preHandler), l'UI ne fait que masquer.
- ✅ **Interface bilingue FR/EN** : un toggle dans le menu Compte bascule TOUTE l'interface en anglais (mémorisé par
  navigateur, défaut français). Pour les clients internationaux (Dubaï) et le screencast d'App Review Meta.
- ✅ **Après connexion, un admin arrive sur l'Accueil (Home)** (numéro + statut du compte), plus sur Analytics.

## Comptes & authentification

- ✅ **Inscription libre** (`/signup`) : n'importe qui crée **son propre espace** (nom d'espace + email + mot de
  passe) et en devient l'**admin**. Redirige vers l'accueil (connecter le numéro).
- ✅ **Se connecter avec Google** (bouton sur `/login`, `/signup`, `/invite`) : vérif du jeton côté serveur ;
  liaison **par email** (compte existant -> connexion ; email inconnu -> crée un espace, comme un signup).
- ✅ **Invitations d'équipe** (admin) : inviter un membre par email (Resend) -> il pose son mot de passe (ou
  Google) via un lien, puis rejoint l'espace avec le rôle défini. Le compte reste « invité » tant qu'il n'a pas
  activé. (Remplace le mot de passe posé par l'admin.) L'email est un **HTML brandé** (logo Messaging Me,
  couleurs de marque) et **personnalisé** (« X t'invite à rejoindre l'espace Y »).
- ✅ **Mot de passe** : « oublié » (`/forgot`, lien de réinitialisation par email, réponse toujours générique
  anti-énumération) + changement depuis le compte (`/compte`).
- ✅ **Crochet paiement (inerte)** : chaque espace a un statut (`trial|active|locked`) ; un espace `locked`
  serait bloqué (403). Pas de Stripe pour l'instant, le contrôle est en place mais neutre.

## Contacts & CRM

- ✅ **Contacts / opt-in** : import CSV (reconnaissance de colonnes, normalisation E.164, mapping des
  colonnes vers des user fields), opt-in tracé, tags. **Identité = numéro OU BSUID** (compte WhatsApp d'un
  client qui n'a pas partagé son numéro, post-octobre) : la colonne « Identifiant » et la fiche affichent l'un
  ou l'autre. Un client qui **écrit** à l'entreprise crée automatiquement sa fiche (par numéro ou BSUID),
  opt-in « inconnu » (donc hors marketing tant qu'il n'a pas consenti).
- ✅ **Fiche contact éditable** : sur la fiche, on **modifie ou supprime** la valeur de chaque champ perso en
  place, et on édite le **Nom** et le **Prénom**. Le **téléphone et le BSUID restent en lecture seule** (ce sont
  les identités qui routent les messages WhatsApp). Un champ « orphelin » (dont la définition a été supprimée)
  reste supprimable.
- ✅ **Tags** (menu Contenu) : renommer (re-dédup si la cible existe), supprimer -> répercuté sur tous
  les contacts. Un tag saisi dans un bloc « ajout de tag » du bot builder **apparaît aussi ici dès qu'on quitte
  le champ** (persisté au blur, sans attendre l'enregistrement du workflow). Dérivés des contacts + tags déclarés.
- ✅ **User fields** (menu Contenu) : éditer le libellé / le type, supprimer. La **clé est verrouillée**
  (renommer la clé casserait le mapping des campagnes) -> on édite label/type seulement. **Champs de base
  « système »** (Nom, Prénom, Téléphone, BSUID, WhatsApp ID, Email) : toujours présents, **non supprimables**,
  utilisables comme sources de variable partout.
- ✅ **Colonne « WhatsApp ID »** dans le tableau contacts (à côté du BSUID) : les chiffres du numéro sans « + »
  (la clé de routage que Meta émet), ou le BSUID si le contact n'a pas de numéro.

## Templates (menu Contenu)

- ✅ **Création** : template simple (corps + variables + boutons quick-reply / URL / **Flow**) ou
  **carousel** (2-10 cartes image + texte + boutons identiques). Soumission à validation Meta, suivi du statut.
- ✅ **Sélecteur de variable + chips dans le corps** : bouton « + Variable » → on choisit une source (**Nom du
  profil WhatsApp**, Téléphone + champs perso comme **Prénom / Nom**, bien distincts) au lieu de taper `{{n}}`.
  La variable s'affiche **directement dans la zone d'édition comme une puce lisible `[Prénom]`** (plus de `{{1}}`),
  et **l'exemple exigé par Meta se remplit tout seul**. **Chaque variable DOIT être rattachée à une source :
  l'enregistrement est bloqué sinon** (fini le `{{n}}` tapé à la main qui partirait vide et se ferait rejeter par
  Meta). Supprimer une puce puis en réinsérer une ne casse pas la numérotation (renumérotée proprement à l'envoi).
  Le lien variable→champ est mémorisé : à la création d'une campagne avec ce template, le mapping est **déjà
  pré-rempli** (modifiable). Le texte d'un **bouton** est limité à **25 caractères** (limite Meta).
- ✅ **En-tête image** : l'image uploadée s'affiche pour de vrai dans l'aperçu WhatsApp (plus juste une icône).
- ✅ **Édition** (templates simples) : corps / boutons / catégorie. Avertissement « repasse en validation Meta ».
  **Bloquée** si le template a un en-tête/pied de page/carousel (Meta les supprimerait), ou s'il est utilisé
  par une **campagne active** (garde-fou anti envoi cassé). Nom et langue non modifiables (immuables chez Meta).
- ✅ **Suppression** : par nom (toutes langues) ; bloquée si une campagne active l'utilise.

## Formulaires (WhatsApp Flows, menu Contenu)

- ✅ **Constructeur visuel, tous les composants** : éléments ordonnables : titres (grand / sous-titre) /
  paragraphe / légende / **image** / saisies (texte, e-mail, téléphone, nombre, code, zone de texte, **date**) /
  **choix** (liste déroulante, boutons radio, cases à cocher) / **consentement (OptIn)** / **bouton final au
  libellé personnalisable**. **Aperçu fidèle de l'écran WhatsApp** en direct (le même rendu s'ouvre en cliquant
  sur le nom d'un formulaire dans la liste).
- ✅ Chaque **champ de saisie se range dans un user field du contact** (« Nouveau champ » d'après le libellé,
  ou un user field existant). Le consentement OptIn se range dans un champ booléen dédié. À la réception du
  formulaire rempli, les valeurs atterrissent dans la fiche contact + la réponse apparaît dans l'inbox.
- ✅ **Depuis un template** : le bouton « + Flow » crée un formulaire inline (publié aussitôt) OU en choisit un
  déjà publié, puis l'attache au template (bouton FLOW exclusif).
- ✅ **Édition / duplication** : un DRAFT s'édite ; un flow PUBLISHED est immuable -> « Dupliquer pour modifier »
  crée une copie éditable.
- ✅ **Suppression** : un brouillon est supprimé, un formulaire publié est déprécié (Meta ne permet pas de le
  supprimer). Si le formulaire est encore rattaché à un template, Meta refuse et le message est affiché.

## Automatisations (menu « Scénario », ex-« Flow »)

- ✅ **Constructeur de workflow visuel** : graphe de blocs reliés par des flèches courbées (drag-and-drop),
  `+` / poubelle sur chaque flèche pour insérer ou couper, bouton « + Créer un bloc », panneau de config par
  bloc. Blocs : **envoi de template**, **inbox** (remonte la conversation à un humain), **formulaire** (envoie
  un WhatsApp Flow), **ajout de tag**, **ajout de champ**. (Éditeur React Flow.)
  - **Tirer une flèche dans le vide crée un bloc** à cet endroit (relié), puis on choisit son type dans le
    panneau de droite. Un **✕** en coin de chaque bloc le supprime directement (avec ses flèches).
- ✅ **Variables du template collées automatiquement** : quand un bloc « envoi template » part (au lancement OU
  au fil du workflow), les variables du template sont **remplies avec les attributs du contact** (ex. `{{1}}`
  relié à Prénom -> le prénom du contact), avec repli sur l'exemple du template. Plus besoin de re-saisir la
  variable ; corrige l'erreur Meta « nombre de variables ».
- ✅ **Sortie par bouton** : un bloc « envoi template » affiche **une sortie par bouton de réponse rapide**
  (à relier vers le bloc suivant) ; les boutons lien/formulaire sont montrés grisés (ils sortent de WhatsApp,
  non reliables). Un bloc sans réponse rapide garde une sortie unique.
- ✅ **Exécution réelle par contact** : lancé depuis une campagne, le workflow s'exécute vraiment pour chaque
  destinataire : les blocs tag/champ s'appliquent au passage (visibles sur la fiche), un bloc template/formulaire
  envoie puis attend la réponse, et **le bouton tapé choisit la branche** suivie (une réponse texte suit la 1re
  sortie). Le parcours avance jusqu'au bloc inbox (terminal). La suite des blocs détermine ce qui se passe.

## Campagnes

- ✅ **Envoi** : on choisit **d'abord les destinataires**, PUIS on décide **Template** (template approuvé +
  mapping des variables sur les attributs/champs contact) **OU Workflow** (déclenche le workflow choisi pour
  chaque destinataire). Un **tooltip au survol** explique quand privilégier chacun. Lancement, suivi des
  destinataires (statut interne + cycle de livraison Meta), auto-refresh. (Suivi de livraison Meta non câblé
  pour les campagnes workflow en V1 : leur statut « envoyé » ne reflète pas la livraison réelle.)
- ✅ **Variables associées à la création** : que ce soit un template direct OU un **workflow** (dans ce cas on
  vérifie que le **1er nœud est un envoi de template**, sinon bloqué, et on remonte SES variables), on associe
  chaque variable à sa source via un **menu déroulant** (« Champs de base » : Nom, Prénom, Téléphone, BSUID,
  WhatsApp ID, Email · « Mes champs » : les vrais champs perso · « Texte fixe »). Fini la clé tapée à la main qui
  pointait un champ inexistant. Les valeurs sont résolues **par contact** : un contact à qui il manque une valeur
  est **sauté et signalé (« X contacts sautés »)** ; 0 destinataire = avertissement rouge. Plus jamais de « envoyé »
  alors que rien ne part. **Un template à bouton Formulaire (FLOW) part correctement** via un workflow (composant
  bouton flow câblé, corrige le rejet Meta #131009).
- ✅ **Garde-fous** : opt-in requis, fréquence max par contact (marketing), coupure sur quality rating, claim
  atomique anti double-envoi, idempotence. **« Lancer »** n'apparaît que sur un brouillon ; une campagne mise
  en pause par le quality gate montre **« Reprendre »** (relance les destinataires restants) ; une campagne en
  cours / terminée / en échec n'a pas de bouton.
- ✅ **Coût estimé par campagne** : « ≈ X (devise du compte) » par campagne + total, dérivé du tarif Meta
  (pricing_analytics) × nb envoyés facturables. « indisponible » si le prix Meta ne remonte pas (jamais 0).

## Inbox

- ✅ **Conversations** : réponse texte dans la fenêtre de service 24 h ; hors fenêtre, envoi d'un template
  approuvé (seul moyen de re-contacter). Formulaires Flow remplis affichés en clair.
- ✅ **Pastille agent** : les bulles sortantes portent les **initiales de l'auteur** (survol = nom). Repli
  neutre pour les messages sans auteur (legacy / réponse auto).

## Analytics (menu Analytics)

- ✅ **Plage de dates libre** : presets 7/30/90 j **+** sélecteur de dates personnalisé (les graphes honorent
  une plage passée). Séries : contacts (cumul), templates envoyés, messages échangés.
- ✅ **Funnel PAR campagne** : sélecteur de campagne, envoyés → délivrés → **lus** → **répondus** + taux
  (+ échecs). « Répondu » = réponse reçue après l'envoi, attribuée au dernier envoi (pas de double-comptage).
  Sous-estimation des « lus » assumée si le destinataire a coupé les accusés. Campagne-only en V1.
- ✅ **Erreurs Meta par code** : breakdown des codes d'erreur (131049, 131047, 131026...) sur la période,
  avec libellé FR et volume.
- ✅ **Graphe de coût estimé** : coût/jour (marketing + utility) sur la période, **filtrable par campagne
  ou par template**, tarif Meta × volume. « Tarif indisponible » affiché si Meta ne renvoie pas de prix
  (jamais de faux coût).
- ✅ **Coût / breakdown par template** (prix Meta par catégorie).

## Support (menu Support)

- ✅ **Formulaire de contact** : sujet + message -> email à l'équipe via Resend (reply-to = email de l'auteur).
  Domaine `messagingme.app` **vérifié** (hors mode test) : les emails partent réellement (support, invitations,
  réinitialisation de mot de passe).

## Accueil (clic logo)

- ✅ **Page d'accueil** `/accueil` (clic sur le logo, admin) : « Bonjour {prénom} », **statut du compte
  WhatsApp** (pastille vert/ambre/rouge/gris, jamais de faux vert), **numéro** + **qualité en pastille de couleur**
  (plus le texte « Verte »), **débit chiffré** (80 msg/s en standard, 1 000/s en high) et **cap réel** (N clients
  par 24 h selon le palier), et la carte **MBA actif/inactif** (déplacée hors du Dashboard).
- ✅ **État HubSpot par numéro** : si le connecteur HubSpot est branché pour le numéro -> « connecté au portail
  <nom ou id> » + un **toggle** qui coupe/active l'envoi des analyses de conversation à HubSpot. Si aucun portail
  -> un bouton **« Connecter HubSpot »** qui lance l'installation OAuth et relie ce numéro. (Pont : mba lit le
  portail du connecteur mm-hubspot en cross-schema, même Supabase.)
- ✅ **Onboarding « Connecter mon compte WhatsApp » (Embedded Signup)** : un espace **sans numéro rattaché** voit un
  bouton qui ouvre la **popup Meta** (Facebook Login for Business + config_id) ; le business choisit son compte + son
  numéro et le backend rattache tout (échange de code, webhooks, register). 🚧 **Construit et déployé, mais ACTIF
  seulement quand Meta a validé Access Verification (Tech Provider) + App Review** (soumises le 2026-07-16). Tant que
  `META_ES_CONFIG_ID` n'est pas posé, le bouton reste un placeholder « bientôt disponible ».
- ✅ **Logo Meta Business Agent** sur la carte MBA (produit de Meta), à la place de notre logo MM.

## Exploitation `/ops` (interne, hors console client)

- ✅ **Console d'exploitation cross-tenant** `/ops` : vue **lecture seule** de TOUS les clients (protégée par
  un jeton `OPS_TOKEN` saisi une fois, distinct des comptes clients). Par client : MBA on/off, numéro +
  qualité, nb d'utilisateurs / contacts / messages / templates, dernier envoi. **Signal de charge pg-boss**
  (files en attente / actifs / échoués) pour décider d'une bascule d'infra. Messages échangés/jour (global).

## À venir / hors périmètre

- 🚧 **Onboarding guidé (Embedded Signup)** : bouton + popup + backend **construits et déployés** (OFF par défaut) ;
  en attente de validation Meta (Tech Provider + App Review, soumis 2026-07-16). Option pool de numéros = plus tard.
- 🔲 **Agent MBA** (auto-réponse IA) : bloqué par les ToS Meta Business AI (gating vertical). Parqué.
- 🔲 **Abonnement / Billing** (Stripe) : menus câblés (désactivés), intégration hors lot.
- 🔲 **Rapport mensuel auto** : score agent + stats campagnes.
- Hors V1 (discipline anti tailor-made) : multicanal, segments avancés, A/B testing.
