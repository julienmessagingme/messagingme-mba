# features.md — fonctionnel

Statut : 🔲 pas commencé · 🚧 en cours · ✅ live

`mba.messagingme.app` est **en prod LIVE** (`DRY_RUN=false`, numéro Zadarma réel). Console de gestion
WhatsApp/Meta, 2 rôles : **admin** (tout) et **agent** (inbox seule).

## Navigation (sidebar gauche, pleine largeur)

Admin : **Inbox · Contacts · Campagnes · Flow · Contenu (Templates / Formulaires / Tags / Champs) · Analytics · Support**.
Agent : **Inbox** seule. Menu **Compte** en haut à droite (Compte, Abonnement*, Billing*, Déconnexion ;
*désactivés, câblage Stripe hors lot). RBAC = barrière serveur (preHandler), l'UI ne fait que masquer.

## Contacts & CRM

- ✅ **Contacts / opt-in** : import CSV (reconnaissance de colonnes, normalisation E.164, mapping des
  colonnes vers des user fields), opt-in tracé, tags. **Identité = numéro OU BSUID** (compte WhatsApp d'un
  client qui n'a pas partagé son numéro, post-octobre) : la colonne « Identifiant » et la fiche affichent l'un
  ou l'autre. Un client qui **écrit** à l'entreprise crée automatiquement sa fiche (par numéro ou BSUID),
  opt-in « inconnu » (donc hors marketing tant qu'il n'a pas consenti).
- ✅ **Tags** (menu Contenu) : renommer (re-dédup si la cible existe), supprimer -> répercuté sur tous
  les contacts. Dérivés des contacts (pas de table dédiée).
- ✅ **User fields** (menu Contenu) : éditer le libellé / le type, supprimer. La **clé est verrouillée**
  (renommer la clé casserait le mapping des campagnes) -> on édite label/type seulement.

## Templates (menu Contenu)

- ✅ **Création** : template simple (corps + variables `{{n}}` + boutons quick-reply / URL / **Flow**) ou
  **carousel** (2-10 cartes image + texte + boutons identiques). Soumission à validation Meta, suivi du statut.
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

## Automatisations (menu « Flow »)

- ✅ **Constructeur de workflow visuel** : graphe de blocs reliés par des flèches courbées (drag-and-drop),
  `+` / poubelle sur chaque flèche pour insérer ou couper, bouton « + Créer un bloc », panneau de config par
  bloc. Blocs : **envoi de template**, **inbox** (remonte la conversation à un humain), **formulaire** (envoie
  un WhatsApp Flow), **ajout de tag**, **ajout de champ**. (Éditeur React Flow.)
- ✅ **Exécution réelle par contact** : lancé depuis une campagne, le workflow s'exécute vraiment pour chaque
  destinataire : les blocs tag/champ s'appliquent au passage (visibles sur la fiche), un bloc template/formulaire
  envoie puis attend la réponse du contact, et à la réponse le parcours avance jusqu'au bloc inbox (terminal).
  La suite des blocs détermine ce qui se passe. ⚠️ V1 : l'avance se déclenche sur **toute** réponse du contact
  (pas encore de branche par bouton de réponse rapide).

## Campagnes

- ✅ **Envoi** : on choisit **d'abord les destinataires**, PUIS on décide **Template** (template approuvé +
  mapping des variables sur les attributs/champs contact) **OU Workflow** (déclenche le workflow choisi pour
  chaque destinataire). Lancement, suivi des destinataires (statut interne + cycle de livraison Meta),
  auto-refresh. (Suivi de livraison Meta non câblé pour les campagnes workflow en V1.)
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
  Mode test tant que le domaine n'est pas vérifié (envoi limité à l'adresse du compte Resend).

## Accueil (clic logo)

- ✅ **Page d'accueil** `/accueil` (clic sur le logo, admin) : « Bonjour {prénom} », **statut du compte
  WhatsApp** (pastille vert/ambre/rouge/gris, jamais de faux vert), **numéro** + qualité + palier d'envoi,
  et la carte **MBA actif/inactif** (déplacée hors du Dashboard).

## Exploitation `/ops` (interne, hors console client)

- ✅ **Console d'exploitation cross-tenant** `/ops` : vue **lecture seule** de TOUS les clients (protégée par
  un jeton `OPS_TOKEN` saisi une fois, distinct des comptes clients). Par client : MBA on/off, numéro +
  qualité, nb d'utilisateurs / contacts / messages / templates, dernier envoi. **Signal de charge pg-boss**
  (files en attente / actifs / échoués) pour décider d'une bascule d'infra. Messages échangés/jour (global).

## À venir / hors périmètre

- 🔲 **Onboarding guidé** (Embedded Signup) : connexion du numéro en self-service + option pool de numéros.
- 🔲 **Agent MBA** (auto-réponse IA) : bloqué par les ToS Meta Business AI (gating vertical). Parqué.
- 🔲 **Abonnement / Billing** (Stripe) : menus câblés (désactivés), intégration hors lot.
- 🔲 **Rapport mensuel auto** : score agent + stats campagnes.
- Hors V1 (discipline anti tailor-made) : multicanal, segments avancés, A/B testing.
