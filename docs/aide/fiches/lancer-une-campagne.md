---
ecran: campagnes
source_section: Campagnes
source_empreinte: 584936
---
# Lancer une campagne

Une campagne envoie un même message à une liste de contacts, les uns après les autres.

Depuis « Ajouter une campagne », un assistant vous pose une question par écran, en cinq étapes. Vous pouvez
revenir en arrière à tout moment sans rien perdre.

**1. Le nom.** Il n'est visible que de votre équipe. Vous dites aussi ici la nature de la campagne :
« Marketing », qui n'envoie qu'aux contacts ayant donné leur consentement, ou « Service », pour une
information liée à une commande, un rendez-vous ou un compte.

**2. Le canal.** Un canal seul (WhatsApp ou RCS), ou une chaîne : le message part sur un premier canal, et
les contacts qu'il n'a pas atteints sont repris sur un second, puis éventuellement par e-mail. Sur un canal
seul, vous pouvez demander de réessayer les envois qui échouent ; avec une chaîne, la question ne se pose
pas, puisque le repli EST le rattrapage. Vous décidez enfin si la campagne n'envoie que pendant vos heures
d'ouverture : cette case vaut pour les premiers envois comme pour les relances.

Lancée hors de ces heures, la campagne n'est pas refusée : elle se met en pause et repart d'elle-même à la
prochaine ouverture. Attention, la liste ne dit pas encore pourquoi une campagne est en pause ni quand elle
repartira ; et si vous corrigez vos heures d'ouverture après coup, la campagne déjà en pause ne se réveille
pas toute seule : utilisez son bouton « Reprendre ».

**3. Le contenu.** Un cadre par étage de la chaîne, dans l'ordre d'envoi. Pour WhatsApp, vous choisissez un
modèle approuvé, vous voyez tout de suite un aperçu de ce que le contact recevra, et vous dites d'où vient
chaque variable du modèle. Si le modèle qu'il vous faut n'existe pas encore, vous le créez sans quitter la
campagne : il part en validation chez WhatsApp, et il est choisi tout seul dès qu'il est approuvé. Tant qu'un
étage n'a pas son contenu, l'écran vous le dit et ne vous laisse pas avancer. Une fois le premier étage
rempli, une dernière question apparaît : ce qui se passe quand un contact répond, c'est-à-dire l'agent de
Meta, un agent IA, ou votre Inbox.

**4. L'audience.** À qui. Le plus courant est de piocher dans votre liste de contacts, avec des filtres que
vous combinez (un ou plusieurs tags, le consentement marketing, le début ou un morceau du numéro, la valeur
d'un champ que vous avez créé, le nom). Un compteur vous dit en direct combien de contacts correspondent.
Vous pouvez aussi importer un fichier CSV, qui pose alors un tag obligatoire sur les contacts importés et
cible ce tag. Autre possibilité : une campagne « au fil de l'eau », sans liste du tout, qui prend chaque
contact arrivant par une adresse de webhook tant qu'elle reste ouverte.

**5. Le récapitulatif.** Il montre combien de contacts chaque étage de la chaîne concerne, ce qu'aucun écran
précédent ne pouvait vous dire. Vous y réglez la cadence d'envoi (une cadence prudente protège la réputation
de votre numéro) et vous choisissez le moment : maintenant, ou à une date que vous fixez. Vous pouvez aussi
créer la campagne sans rien envoyer, pour vérifier qui est retenu avant d'engager le moindre message : elle
vous attend alors dans la liste, avec son bouton « Lancer ».

Une campagne s'adresse à des gens qui ne vous ont pas forcément écrit récemment. C'est pourquoi son premier
message doit être un modèle approuvé par WhatsApp, ou un scénario qui commence par un tel modèle. Si le
scénario que vous cherchez n'apparaît pas dans le sélecteur, c'est presque toujours cela : il commence par un
message qui ne peut partir que dans une conversation déjà ouverte.

Une campagne que vous avez commencée sans la lancer est conservée dès que vous lui avez donné un nom, avec
tout ce que vous avez saisi ensuite, destinataires cochés compris. Vous la retrouvez en haut de la liste des
campagnes et vous reprenez où vous en étiez.
