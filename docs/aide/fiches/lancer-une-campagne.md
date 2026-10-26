---
description: Lancer une campagne WhatsApp ou RCS en cinq étapes : le nom, le canal, le contenu, l'audience, puis le récapitulatif et l'envoi.
ecran: campagnes
source_section: Campagnes
source_empreinte: dd28b7
publique: oui
rubrique: parler-aux-clients
rang: 5
comment_faire: oui
prerequis: faire-approuver-un-modele
video: oui
---
# Lancer une campagne

Une campagne envoie un même message à une liste de contacts, les uns après les autres. Depuis « Ajouter une
campagne », un assistant vous pose une question par écran, en cinq étapes, et vous pouvez revenir en arrière
sans rien perdre.

Une campagne s'adresse à des gens qui ne vous ont pas forcément écrit récemment. C'est pourquoi son premier
message doit être un modèle approuvé par WhatsApp, ou un scénario qui commence par un tel modèle.

**1. Le nom.** Donnez à la campagne un nom, visible de votre équipe seulement, et dites sa nature :
« Marketing », qui n'envoie qu'aux contacts ayant donné leur consentement, ou « Service », pour une
information liée à une commande, un rendez-vous ou un compte.

**2. Le canal.** Choisissez un canal seul (WhatsApp ou RCS), ou une chaîne : le message part sur un premier
canal, et les contacts qu'il n'a pas atteints sont repris sur un second, puis éventuellement par e-mail.

L'écran ouvre sur cette seule question, sans réponse pré-cochée, et le reste de l'étape apparaît une fois votre
choix fait. Sur un canal seul, vous pouvez demander de réessayer les envois qui échouent ; avec une chaîne, la
question ne se pose pas, puisque le repli EST le rattrapage. Vous décidez enfin si la campagne n'envoie que
pendant vos heures d'ouverture : cette case vaut pour les premiers envois comme pour les relances.

**Bon à savoir.** Lancée hors de vos heures d'ouverture, la campagne n'est pas refusée : elle se met en pause
et repart d'elle-même à la prochaine ouverture. La liste ne dit pas encore pourquoi une campagne est en pause
ni quand elle repartira ; et si vous corrigez vos heures d'ouverture après coup, la campagne déjà en pause ne
se réveille pas toute seule : utilisez son bouton « Reprendre ».

**3. Le contenu.** Pour WhatsApp, choisissez un modèle approuvé : un aperçu vous montre tout de suite ce que le
contact recevra, et vous dites d'où vient chaque variable du modèle. Une chaîne a un cadre par étage, dans
l'ordre d'envoi.

Si le modèle qu'il vous faut n'existe pas encore, vous le créez sans quitter la campagne : il part en
validation chez WhatsApp, et il est choisi tout seul dès qu'il est approuvé. Tant qu'un étage n'a pas son
contenu, l'écran vous le dit et ne vous laisse pas avancer.

Dans le cadre de chaque étage qui n'ouvre pas un scénario, une question vous est posée : ce qui se passe quand
un contact répond à CET étage. « Le répondeur automatique prend la main » laisse la réponse à celui que vous
avez choisi sur l'Accueil, dans « Qui répond au client » (l'agent de Meta, un agent IA ou un scénario) ; ce
choix est grisé, avec sa raison, si c'est votre équipe qui répond. L'autre choix envoie la conversation dans
votre Inbox. Elle se règle étage par étage. Puis, une fois tout le contenu choisi, une dernière question
apparaît, mais seulement si au moins un étage renvoie vers l'Inbox : à qui la conversation revient, personne
en particulier, une personne désignée, ou à tour de rôle.

Sur un étage RCS, « Partir d'un message enregistré » propose aussi vos carrousels (plusieurs cartes qui
défilent, chacune avec son visuel et ses boutons). Le carrousel est copié tel quel sur l'étage et s'affiche en
aperçu : pour le changer, modifiez-le dans Contenu > RCS > Messages puis choisissez-le à nouveau. « Revenir à un
message simple » rend le texte que vous aviez écrit.

Un étage peut aussi partir en scénario plutôt qu'en simple message. Sur WhatsApp, c'est le scénario qui
fournit le modèle d'ouverture ; sur RCS, votre message part d'abord et le scénario démarre juste après. Comme
pour les modèles, si le scénario qu'il vous faut n'existe pas, vous le créez sans quitter la campagne :
l'éditeur s'ouvre dans une fenêtre, et le scénario publié est choisi tout seul pour cet étage. Vous le
retrouvez ensuite dans l'onglet Scénario comme les autres. Sur un étage qui ouvre un scénario, la question de
la réponse ne vous est pas posée : c'est le scénario qui décide de ce qui se passe à la réponse, et l'écran
vous le dit à sa place. Elle réapparaît sur tout étage qui envoie un message simple, parce que les contacts
joints par celui-là répondront hors de tout scénario.

Si le scénario que vous cherchez n'apparaît pas dans le sélecteur, c'est l'une de ces deux raisons : il
commence par un message qui ne peut partir que dans une conversation déjà ouverte, ou bien il ouvre sur
l'autre canal (un étage WhatsApp ne propose que les scénarios qui démarrent par un modèle, un étage RCS que
ceux qui démarrent par un message RCS).

**4. L'audience.** Dites à qui envoyer. Le plus courant : piocher dans vos contacts, avec des filtres que vous
combinez (un ou plusieurs tags, le consentement marketing, le début ou un morceau du numéro, la valeur d'un
champ que vous avez créé, le nom). Un compteur vous dit en direct combien de contacts correspondent.

Vous pouvez aussi importer un fichier CSV, qui pose alors un tag obligatoire sur les contacts importés et cible
ce tag. Autre possibilité : une campagne « au fil de l'eau », sans liste du tout, qui prend chaque contact
arrivant par une adresse de webhook tant qu'elle reste ouverte.

**5. Le récapitulatif et le lancement.** Vérifiez combien de contacts chaque étage concerne, réglez la cadence
d'envoi, puis répondez à « Quand ? » : « Maintenant » (bouton « Lancer la campagne »), ou « Plus tard », à la
date et à l'heure que vous fixez, pour programmer l'envoi (bouton « Créer et programmer »).

Ce récapitulatif est le seul écran qui vous dise combien de contacts chaque étage de la chaîne concerne. Une
cadence prudente protège la réputation de votre numéro. Une campagne programmée apparaît dans la liste avec la
mention « Planifiée le » et sa date. « Créer sans envoyer » crée la campagne sans rien envoyer, pour vérifier
qui est retenu avant d'engager le moindre message : elle vous attend alors dans la liste, avec son bouton
« Lancer ».

**Bon à savoir.** Une campagne que vous avez commencée sans la lancer est conservée dès que vous lui avez donné
un nom, avec tout ce que vous avez saisi ensuite, destinataires cochés compris. Vous la retrouvez en haut de la
liste des campagnes et vous reprenez où vous en étiez.
