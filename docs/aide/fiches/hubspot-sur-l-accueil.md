---
description: Relier HubSpot à Messaging Me : le connecter dans Tools > Intégrations, choisir ce qui se synchronise, répondre depuis HubSpot, mettre en pause ou couper.
ecran: accueil
source_section: Accueil (1re entrée du menu)
source_empreinte: d1bfb9
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

**Workflows HubSpot : envoyer des modèles et lancer des scénarios** est éteint au départ ; il suppose l'offre qui
relie HubSpot, et ne dépend pas de la réponse. Les actions « Envoyer un modèle WhatsApp (Messaging Me) » et « Lancer un
scénario Messaging Me » apparaissent dans vos workflows HubSpot de contacts, mais elles n'agissent qu'une fois cette
ligne allumée (éteinte, l'historique du workflow dit que les workflows ne sont pas branchés). Vous y choisissez
l'espace, un modèle Service approuvé ou un scénario publié qui commence par un tel modèle et n'en contient aucun
Marketing, la propriété qui porte le
numéro WhatsApp du contact et, pour chaque variable du modèle, la propriété qui la remplit (le texte fixe vit dans le
modèle). Un scénario qui commence par une question, un message rapide ou l'agent IA n'est pas proposé : WhatsApp
exige que le contact ait écrit dans les 24 heures. Rien ne part à un contact qui a dit STOP ou qui est bloqué, ni à un
numéro fixe, ni deux fois le même modèle ou le même scénario au même contact en 24 heures ; les modèles Marketing ne
sont pas proposés. Un scénario ne part jamais vers une conversation qu'un conseiller a en main, et remplace un scénario
automatique en cours. L'historique du workflow dit, contact par contact, ce qui est parti ou pourquoi rien n'est parti,
et chaque envoi apparaît dans Campagnes. Au plus 60 envois par minute et 2 000 par jour pour l'espace, les trois actions
comptées ensemble ; Meta facture chaque modèle.

Depuis une **transaction**, l'action « Lancer un scénario Messaging Me (transaction) » lance le même genre de scénario
quand votre workflow HubSpot de transactions le décide (par exemple au passage à une étape). Elle écrit au seul contact
associé à la transaction : avec plusieurs contacts associés, rien ne part. Elle pose sur sa fiche Messaging Me trois
champs, déclarés quand vous allumez la ligne : **Prénom (HubSpot)**, **Conseiller (HubSpot)** (le propriétaire de la
transaction) et **Lien d'agenda (HubSpot)** (sa page de réservation, quand Messaging Me peut la lire). Les variables
de son modèle d'ouverture viennent des sources posées sur le modèle (par exemple « {{1}} » = Prénom (HubSpot)), et les
messages du scénario peuvent écrire « {{hubspot_conseiller}} » ou « {{hubspot_lien_agenda}} ». Dans le modèle
d'ouverture, ne posez que ce qui est toujours rempli, comme le prénom : une variable vide arrête l'envoi. Le conseiller
et son lien vont dans les messages qui suivent, et ces trois champs ne servent qu'aux scénarios lancés par cette action.
Placez l'action juste après le déclencheur, et activez la réinscription pour qu'une proposition révisée reparte (elle
est refusée dans les 24 heures). Ne branchez pas en plus une automatisation de la console sur la même étape : le contact
recevrait deux scénarios.

Sans portail relié, l'Accueil n'affiche qu'une ligne qui vous y renvoie. Pour délier HubSpot, faites la déconnexion complète depuis le bloc HubSpot (sans
numéro, c'est un bouton du bloc, sans l'option de pause).
