# features.md — fonctionnel

Statut : 🔲 pas commencé · 🚧 en cours · ✅ live

`mba.messagingme.app` est **en prod LIVE** (`DRY_RUN=false`, numéro Zadarma réel). Console de gestion
WhatsApp/Meta, 2 rôles : **admin** (tout) et **agent** (inbox seule).

## Navigation (sidebar gauche, pleine largeur)

Admin : **Inbox · Contacts · Campagnes · Contenu (Templates / Flows / Tags / Champs) · Analytics · Support**.
Agent : **Inbox** seule. Menu **Compte** en haut à droite (Compte, Abonnement*, Billing*, Déconnexion ;
*désactivés, câblage Stripe hors lot). RBAC = barrière serveur (preHandler), l'UI ne fait que masquer.

## Contacts & CRM

- ✅ **Contacts / opt-in** : import CSV (reconnaissance de colonnes, normalisation E.164, mapping des
  colonnes vers des user fields), opt-in tracé, tags. Identité **BSUID-native** (E.164 OU username).
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

## Flows (formulaires WhatsApp, menu Contenu)

- ✅ **Constructeur riche** : éléments ordonnables (titre / paragraphe / légende / image / champ de saisie).
  Chaque **champ se range dans un user field du contact** (« Nouveau champ » d'après le libellé, ou un user
  field existant). À la réception du formulaire rempli, les valeurs atterrissent dans la fiche contact + la
  réponse apparaît dans l'inbox.
- ✅ **Depuis un template** : le bouton « + Flow » crée un formulaire inline (publié aussitôt) OU en choisit un
  déjà publié, puis l'attache au template (bouton FLOW exclusif).
- ✅ **Édition / duplication** : un DRAFT s'édite ; un flow PUBLISHED est immuable -> « Dupliquer pour modifier »
  crée une copie éditable.

## Campagnes

- ✅ **Envoi** : choix d'un template approuvé + mapping des variables sur les attributs/champs contact, sélection
  d'audience, lancement, suivi des destinataires (statut interne + cycle de livraison Meta), auto-refresh.
- ✅ **Garde-fous** : opt-in requis, fréquence max par contact (marketing), coupure sur quality rating, claim
  atomique anti double-envoi, idempotence.
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
- ✅ **Funnel de livraison & lecture** : envoyés → délivrés → **lus (accusés de lecture)** + taux, sur les
  campagnes. Sous-estimation assumée si le destinataire a coupé les accusés. Campagne-only en V1.
- ✅ **Coût / breakdown par template** (prix Meta par catégorie).

## Support (menu Support)

- ✅ **Formulaire de contact** : sujet + message -> email à l'équipe via Resend (reply-to = email de l'auteur).
  Mode test tant que le domaine n'est pas vérifié (envoi limité à l'adresse du compte Resend).

## À venir / hors périmètre

- 🔲 **Onboarding guidé** (Embedded Signup) : connexion du numéro en self-service + option pool de numéros.
- 🔲 **Agent MBA** (auto-réponse IA) : bloqué par les ToS Meta Business AI (gating vertical). Parqué.
- 🔲 **Abonnement / Billing** (Stripe) : menus câblés (désactivés), intégration hors lot.
- 🔲 **Rapport mensuel auto** : score agent + stats campagnes.
- Hors V1 (discipline anti tailor-made) : multicanal, segments avancés, A/B testing.
