---
description: WhatsApp dans HubSpot avec l'app Messaging Me : répondre depuis la fiche contact, envoyer depuis vos workflows, analyser chaque conversation. Sans Sales Hub.
ecran: integrations
ancre_console: integration-hubspot
source_section: Accueil (1re entrée du menu)
source_empreinte: 00b3d0
publique: oui
rubrique: demarrer
rang: 6
captures: non
offre: business
---
# Intégrer WhatsApp à HubSpot, sans Sales Hub

L'app Messaging Me met WhatsApp dans HubSpot : vos équipes répondent aux clients depuis la fiche contact, vos
workflows envoient des modèles et lancent des scénarios, et chaque conversation remonte analysée. Sans Sales Hub, et
sans Data Hub pour les webhooks.

## Ce que fait l'app

- **Répondre depuis la fiche contact.** La carte Messaging Me montre la conversation WhatsApp, et toute personne du
  portail y répond, chaque réponse signée de son adresse. Quand le client n'a plus écrit depuis 24 heures, elle propose
  vos modèles approuvés, déjà remplis depuis la fiche.
- **Une page « Messaging Me » dans HubSpot.** Elle liste les conversations qui attendent un humain, les urgentes
  d'abord : vous y répondez sans chercher la fiche du contact.
- **Une tâche dès qu'un client demande un humain.** Elle arrive dans la minute chez le propriétaire du contact, avec le
  lien de la conversation, et se coche toute seule quand quelqu'un répond.
- **Vos workflows HubSpot écrivent sur WhatsApp.** Trois actions s'ajoutent à vos workflows : envoyer un modèle, lancer
  un scénario, ou le lancer depuis une transaction, avec le conseiller et son lien de réservation.
- **Une étape de transaction lance un scénario.** Quand une transaction arrive sur l'étape choisie, son contact reçoit
  le scénario, sans écrire de workflow.
- **L'analyse de chaque conversation.** L'intention, le sentiment et l'action suggérée arrivent dans la fiche, en
  propriétés que vos workflows suivent, avec une tâche et des actions en un clic : créer ou rattacher le devis,
  rappeler, escalader vers un humain.
- **Vos listes HubSpot comme audiences.** Une campagne WhatsApp cible une liste HubSpot.

## Ce qu'il faut côté HubSpot

**Pas besoin de Sales Hub.** La carte, la page, les tâches, l'analyse et les listes fonctionnent quelle que soit votre
offre HubSpot. **Pas besoin non plus de Data Hub** (ex-Operations Hub), la seule offre HubSpot qui donne aux workflows
l'action webhook : le scénario qu'une étape de transaction déclenche écoute HubSpot par l'app elle-même. Seules les
trois actions de workflow demandent les workflows de HubSpot, qu'apporte un abonnement Pro : Marketing Hub Pro suffit.

## Le mettre en place

Tout se règle dans la console, sur la carte HubSpot de Tools > Intégrations, réservée aux administrateurs. Chaque
fonction s'allume et s'éteint d'un interrupteur.

**1. Connecter HubSpot.** Dans Tools > Intégrations, la carte HubSpot propose « Connecter HubSpot », numéro WhatsApp ou
pas : vous autorisez l'app Messaging Me sur votre portail, chez HubSpot, dans un autre onglet.

Un espace tout neuf peut donc connecter HubSpot avant d'avoir un numéro.

**2. Choisir ce que vous branchez.** Au retour, la carte demande ce qui passe dans HubSpot : la fiche contact et
l'analyse de chaque conversation, la tâche immédiate quand un client demande un humain, la création de tâches, le
contact injoignable sur WhatsApp, vos listes comme audience de campagne.

Sans « Créer des tâches dans HubSpot », seules les propriétés arrivent, pour vos workflows HubSpot ; ce réglage vaut
pour tout le portail. Si le droit de lire vos listes manque, « Autoriser l'accès aux listes HubSpot » le demande au
portail.

**3. Ajouter la carte à la fiche contact.** Dans HubSpot, ouvrez Paramètres, puis Objets, Contacts et l'onglet
« Personnalisation de la fiche ». Ouvrez la vue par défaut et, dans la colonne du milieu, « Ajouter des cartes » :
cherchez « Messaging Me », ajoutez la carte, enregistrez.

**4. Répondre depuis HubSpot.** Allumez « Répondre aux clients depuis HubSpot », éteint au départ. Toute personne du
portail lit alors la conversation dans la carte et répond, signée de son adresse, tant que la fenêtre de 24 heures est
ouverte ; « Rendre au robot » redonne la main à l'agent.

La carte n'écrit jamais à un contact qui a dit STOP ni à un contact bloqué. Une conversation qu'un membre tient ne se
répond que par lui, un admin ou un manager, et chaque personne envoie au plus 20 réponses par minute.

La page « Messaging Me » de HubSpot (l'icône Marketplace, puis l'app) liste les conversations qui attendent un humain :
les urgentes d'abord, puis la plus ancienne attente. « Ouvrir » affiche la conversation pour y répondre comme depuis la
carte. Toute personne du portail voit la liste entière, quels que soient ses droits sur les contacts dans HubSpot. Si
la synchronisation du numéro est en pause, la page le dit.

**5. Envoyer des modèles depuis HubSpot.** Allumez « Envoyer des modèles depuis HubSpot », proposé une fois la réponse
allumée. Quand le client n'a plus écrit depuis 24 heures, la carte propose vos modèles approuvés, avec leurs variables
déjà remplies depuis la fiche du contact : vous les vérifiez, puis « Envoyer le modèle ».

Un modèle Marketing ne part qu'à un contact qui a donné son accord ; les autres modèles partent à tout contact qui n'a
pas dit STOP et n'est pas bloqué. Meta facture chaque modèle, et chaque personne en envoie au plus 5 par minute.

**6. Brancher vos workflows HubSpot.** Allumez « Workflows HubSpot : envoyer des modèles et lancer des scénarios ». Vos
workflows de contacts gagnent « Envoyer un modèle WhatsApp (Messaging Me) » et « Lancer un scénario Messaging Me », vos
workflows de transactions « Lancer un scénario Messaging Me (transaction) ».

Ligne éteinte, les actions restent visibles dans HubSpot mais n'agissent pas : l'historique du workflow dit que les
workflows ne sont pas branchés. Dans l'action, vous choisissez l'espace, un modèle Service approuvé ou un scénario
publié qui commence par un tel modèle et n'en contient aucun Marketing, la propriété qui porte le numéro WhatsApp du
contact et, pour chaque variable du modèle, la propriété qui la remplit (le texte fixe vit dans le modèle). Un scénario
qui commence par une question, un message rapide ou l'agent IA n'est pas proposé : WhatsApp exige que le contact ait
écrit dans les 24 heures.

Rien ne part à un contact qui a dit STOP ou qui est bloqué, ni à un numéro fixe, ni deux fois le même modèle ou le même
scénario au même contact en 24 heures ; les modèles Marketing ne sont pas proposés. Un scénario ne part jamais vers une
conversation qu'un conseiller a en main, et remplace un scénario automatique en cours. L'historique du workflow dit,
contact par contact, ce qui est parti ou pourquoi rien n'est parti, et chaque envoi apparaît dans Campagnes. Au plus 60
envois par minute et 2 000 par jour pour l'espace, les trois actions comptées ensemble ; Meta facture chaque modèle.

L'action de transaction écrit au seul contact associé à la transaction : avec plusieurs contacts associés, rien ne
part. Elle pose sur sa fiche Messaging Me trois champs, déclarés quand vous allumez la ligne : **Prénom (HubSpot)**,
**Conseiller (HubSpot)** (le propriétaire de la transaction) et **Lien d'agenda (HubSpot)** (sa page de réservation,
quand Messaging Me peut la lire). Les variables de son modèle d'ouverture viennent des sources posées sur le modèle
(par exemple « {{1}} » = Prénom (HubSpot)), et les messages du scénario peuvent écrire « {{hubspot_conseiller}} » ou
« {{hubspot_lien_agenda}} ». Dans le modèle d'ouverture, ne posez que ce qui est toujours rempli, comme le prénom : une
variable vide arrête l'envoi. Le conseiller et son lien vont dans les messages qui suivent, et ces trois champs ne
servent qu'aux scénarios lancés par cette action.

Placez l'action juste après le déclencheur, et activez la réinscription pour qu'une proposition révisée reparte (elle
est refusée dans les 24 heures). Ne branchez pas en plus une automatisation de la console sur la même étape : le contact
recevrait deux scénarios.

**7. Lancer un scénario à une étape de transaction.** Sans workflow : dans Automation, le déclencheur « un deal HubSpot
atteint une étape » lance le scénario de votre choix au contact de la transaction, quand elle arrive sur cette étape.
Vous choisissez l'étape par son nom ; la renommer ensuite dans HubSpot ne casse rien.

Le contact n'écrivant pas à ce moment-là, le scénario commence par un modèle. Une transaction sans contact, ou un
contact sans numéro, ne déclenche rien, et une transaction déplacée plusieurs fois de suite ne déclenche qu'une fois.

**8. Suivre, mettre en pause ou couper.** Sur l'Accueil, le bloc HubSpot montre le portail, l'état de la
synchronisation et si vos listes servent d'audience. Couper la synchronisation vous fait choisir entre une pause,
réversible, et une déconnexion complète.

Les analyses produites pendant une pause sont renvoyées à la reprise. La déconnexion complète délie le compte HubSpot
et coupe tous les numéros de l'espace ; sans numéro, c'est un bouton du bloc, sans l'option de pause. Sans portail
relié, l'Accueil n'affiche qu'une ligne qui vous renvoie vers Intégrations.
