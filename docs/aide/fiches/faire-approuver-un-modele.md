---
description: Créer un modèle de message WhatsApp et le faire approuver par Meta : le texte, les variables, la durée de validité, la langue, puis la soumission.
ecran: templates
source_section: Templates WhatsApp (menu Contenu)
source_empreinte: fbcd42
publique: oui
rubrique: parler-aux-clients
rang: 3
comment_faire: oui
video: oui
---
# Créer un modèle et le faire approuver

Un modèle est un message que WhatsApp valide avant que vous ayez le droit de l'envoyer. C'est le passage
obligé pour écrire à quelqu'un qui ne vous a pas répondu récemment.

**1. Composer le message.** Dans l'écran Templates (menu Contenu > WhatsApp), écrivez le corps du texte, puis ajoutez si besoin un en-tête
(texte, image ou vidéo), un pied de page et des boutons.

L'en-tête texte et le pied de page sont limités à soixante caractères et n'acceptent pas de variable. Sous
chaque champ limité, un compteur dit combien de caractères il vous reste : le corps en accepte 1 024, le texte
d'un bouton 25. Un corps trop long passe en rouge, et le modèle ne part pas tant qu'il dépasse. Vous pouvez
aussi créer un carousel : un message d'introduction commun, puis de deux à dix cartes avec image (160
caractères de texte chacune), chacune portant les mêmes boutons.

**2. Personnaliser avec des variables.** Notez une variable entre doubles accolades : elle est remplacée au
départ par ce qu'il y a dans la fiche du contact.

Un contact dont le champ est vide ne reçoit pas le message : WhatsApp refuse un modèle dont une variable manque,
et vous le retrouvez dans les destinataires écartés de la campagne, avec son motif.

**Un lien propre à chaque contact** : dans l'adresse d'un bouton de lien, le bouton « Variable » insère un champ
de la fiche, par exemple un numéro de commande. Chaque contact arrive sur sa page : le champ est rempli au
moment du clic, et simplement retiré s'il est vide. Un exemple, sous l'adresse, montre ce que le contact
recevra. Le champ se place après le nom du site, jamais dedans, et pas dans les liens des cartes d'un carousel.

**3. Choisir la durée de validité.** Sous la catégorie, dites combien de temps WhatsApp essaie de livrer le
message avant de l'abandonner : de 12 heures à 30 jours pour un modèle marketing, de 1 à 12 heures pour un
modèle utilitaire, et 30 jours si vous n'y touchez pas.

Un message abandonné ne reçoit aucun accusé de livraison. Une promo n'arrive plus après la fin de l'offre, un
rappel plus après le rendez-vous. Pour un modèle marketing, Meta ne l'applique qu'aux envois par son API
Marketing Messages ; et si Meta change la catégorie du modèle, la durée revient à 30 jours.

**4. Choisir la langue et soumettre.** Choisissez la langue dans une liste, puis soumettez : WhatsApp répond en
général en quelques minutes, parfois quelques heures, et l'écran suit le statut pour vous.

**Bon à savoir.** Les clics sur vos boutons de lien sont comptés, sans que vous ayez rien à faire. Vous saisissez
votre lien normalement, et la console vous remontre toujours le vôtre. Les compteurs se lisent dans le détail de
chaque campagne, et dans le Performance Lab (Quantitatif > Funnel).
Deux limites, dites franchement : seuls les **boutons** sont suivis, pas un lien écrit dans le corps du message ;
et un modèle déjà approuvé garde l'adresse figée chez WhatsApp, ses clics restent donc anonymes.

Pour vous y retrouver, rangez vos modèles dans des dossiers : les onglets au-dessus de la liste filtrent, et
« Déplacer vers… » range une ligne ou les modèles cochés. Un modèle se range avec toutes ses langues.
