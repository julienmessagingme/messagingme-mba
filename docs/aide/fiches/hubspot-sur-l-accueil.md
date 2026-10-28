---
description: Relier HubSpot à Messaging Me : le connecter dans Tools > Intégrations, choisir ce qui se synchronise, répondre depuis HubSpot, mettre en pause ou couper.
ecran: accueil
source_section: Accueil (1re entrée du menu)
source_empreinte: 496dbc
publique: oui
rubrique: demarrer
rang: 6
captures: non
offre: business
---
# HubSpot sur l'Accueil : le brancher, le suivre, le couper

Quand HubSpot est relié à votre espace, l'Accueil lui donne son propre bloc. Il se connecte et se règle dans les
Paramètres, avant même d'avoir un numéro WhatsApp.

**HubSpot**, s'il est relié, a son propre bloc : le portail, l'état de la synchronisation et un lien vers le
guide de configuration. La couper vous fait choisir entre une **pause**, réversible (les analyses produites
pendant la pause sont renvoyées à la reprise), et une **déconnexion complète**, qui délie le compte HubSpot
et coupe tous les numéros de l'espace. Juste dessous, le bloc dit si vos listes HubSpot servent d'audience de
campagne, avec un lien vers le réglage.

**HubSpot se connecte et se règle dans Tools > Intégrations**, numéro WhatsApp ou pas : un espace tout neuf
peut donc connecter HubSpot avant d'avoir un numéro. Au retour de la connexion, l'écran vous demande ce que vous
branchez : la fiche contact et l'analyse de chaque conversation, la tâche immédiate quand un client demande un
humain, la création de tâches (sinon les propriétés seulement), le contact injoignable, la réponse aux clients
depuis HubSpot, vos listes comme audience de campagne. Chaque choix se change ensuite d'un interrupteur.

**Répondre aux clients depuis HubSpot** est éteint au départ ; il suppose un portail HubSpot relié, ce que permettent
les offres Business et Entreprise. Allumé, toute personne du
portail lit la conversation et répond depuis la carte Messaging Me de la fiche contact, signée de son adresse, tant
que la fenêtre de 24 heures est ouverte ; « Rendre au robot » redonne la main à l'agent. La carte n'écrit jamais à
un contact qui a dit STOP ni à un contact bloqué. Une conversation qu'un membre tient ne se répond que par lui, un
admin ou un manager, et chaque personne envoie au plus 20 réponses par minute.

**La page « Messaging Me » de HubSpot** (l'icône Marketplace, puis l'app) liste les conversations qui attendent un
humain : les urgentes d'abord, puis la plus ancienne attente. « Ouvrir » affiche la conversation pour y répondre comme
depuis la carte. Toute personne du portail voit la liste entière, quels que soient ses droits sur les contacts dans
HubSpot. Si la synchronisation du numéro est en pause, la page le dit.

**Envoyer des modèles depuis HubSpot** s'allume une fois la réponse allumée. Quand le client n'a plus écrit depuis
24 heures, la carte propose vos modèles approuvés, avec leurs variables déjà remplies depuis la fiche du contact :
vous les vérifiez, puis « Envoyer le modèle ». Un modèle Marketing ne part qu'à un contact qui a donné son accord ;
les autres modèles partent à tout contact qui n'a pas dit STOP et n'est pas bloqué. Meta facture chaque modèle, et
chaque personne en envoie au plus 5 par minute.

**Workflows HubSpot : envoyer des modèles WhatsApp** est éteint au départ ; il suppose l'offre qui relie HubSpot, et
ne dépend pas de la réponse. L'action « Envoyer un modèle WhatsApp (Messaging Me) » apparaît dans vos workflows HubSpot
de contacts, mais elle n'envoie qu'une fois cette ligne allumée (éteinte, l'historique du workflow dit que les
workflows ne sont pas branchés). Vous y choisissez l'espace, un modèle Service approuvé, la propriété qui porte le
numéro WhatsApp du contact et, pour chaque variable du modèle, la propriété qui la remplit (le texte fixe vit dans le
modèle). Rien
ne part à un contact qui a dit STOP ou qui est bloqué, ni à un numéro fixe, ni deux fois le même modèle au même
contact en 24 heures ; les modèles Marketing ne sont pas proposés. L'historique du workflow dit, contact par contact,
ce qui est parti ou pourquoi rien n'est parti, et chaque envoi apparaît dans Campagnes. Au plus 60 envois par minute
et 2 000 par jour pour l'espace ; Meta facture chaque modèle.

Sans portail relié, l'Accueil n'affiche qu'une ligne qui vous y renvoie. Pour délier HubSpot, faites la déconnexion complète depuis le bloc HubSpot (sans
numéro, c'est un bouton du bloc, sans l'option de pause).
