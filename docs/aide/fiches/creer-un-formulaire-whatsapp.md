---
ecran: flows
source_section: Formulaires WhatsApp (WhatsApp Flows, menu Contenu)
source_empreinte: d050f4
---
# Créer un formulaire WhatsApp

Un formulaire WhatsApp s'ouvre dans la conversation et collecte des réponses sans faire sortir le contact de
l'application. Vous le construisez dans Contenu > Formulaires WhatsApp, et vous l'attachez ensuite au bouton
d'un modèle ou à un bloc de scénario.

**Le constructeur** est une liste d'éléments que vous montez, descendez ou retirez : titres, paragraphe,
légende, image, saisies (texte, e-mail, téléphone, nombre, code secret, zone de texte, date), choix (liste
déroulante, choix unique, choix multiple), consentement, et le bouton final dont vous écrivez le libellé.
Chaque champ se coche **Obligatoire** ou non, et chaque libellé doit être unique, tous écrans confondus. Un
aperçu fidèle de l'écran WhatsApp se met à jour en direct.

**Plusieurs écrans** sont possibles, jusqu'à dix : des onglets en haut du constructeur permettent d'en
ajouter, d'en renommer, de les réordonner. Chaque écran porte son titre et son bouton « Continuer », le
dernier portant le bouton final. L'aperçu se pagine, et toutes les réponses reviennent d'un coup à l'envoi
du formulaire.

**Des champs conditionnels.** Chaque élément peut être « Visible si… » une liste à choix unique ou un
consentement placé **plus haut sur le même écran** a une certaine valeur. Le contact ne voit alors le champ
que si sa réponse le déclenche, et un champ resté masqué n'écrase jamais une valeur déjà connue de la fiche
contact.

**Chaque saisie se range dans un champ du contact**, que vous choisissez : un champ existant, ou un nouveau
créé d'après le libellé. Le menu « Enregistrer dans » propose aussi les champs de base (Nom, Prénom, Email)
et vous suggère celui qui correspond au libellé. À la réception, les valeurs atterrissent sur la fiche du
contact et la réponse apparaît dans l'Inbox.

**Le champ Consentement fait quelque chose.** Il se range dans le champ Oui/Non de votre choix, et quand le
contact coche la case et envoie, on enregistre ce champ **et** on passe son statut à « accepté » : il devient
éligible à vos campagnes marketing. Un consentement frais l'emporte sur un désabonnement antérieur.

**Brouillon, puis publication.** Un formulaire naît en brouillon et n'est utilisable qu'une fois publié. La
publication est **irréversible** et l'écran le confirme avant : un formulaire publié ne se modifie plus.
Pour le faire évoluer, utilisez « Dupliquer », qui en crée une copie modifiable et l'ouvre aussitôt. Seuls
les formulaires publiés sont proposés à l'attache d'un bouton de modèle. Un brouillon se supprime ; un
formulaire publié est déprécié, Meta ne permettant pas de le supprimer, et il est refusé tant qu'il est
encore rattaché à un modèle.

**Le bouton « Rafraîchir »** va chercher les formulaires de votre compte WhatsApp Manager et met la liste à
jour. Il sert à deux choses : faire apparaître ici un formulaire construit ailleurs, et reprendre un
renommage ou une publication faits là-bas. Un compte-rendu vous dit ce qui a été importé, mis à jour,
ignoré, ou n'existe plus chez Meta. **Ce qu'un formulaire importé sait faire, et ce qu'il ne sait pas** :
il s'attache à un modèle et s'envoie dans un scénario comme les autres, mais ses réponses **n'alimentent pas
les fiches contact** et son aperçu reste indisponible, parce que Meta ne nous rend pas sa structure. Pour un
formulaire qui remplit les fiches, construisez-le ici. Rien n'est supprimé automatiquement : un formulaire
que Meta ne liste plus vous est signalé, la suppression reste votre décision.
