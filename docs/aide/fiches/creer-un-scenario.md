---
ecran: workflows
source_section: Automatisations (menu « Scénario », ex-« Flow »)
source_empreinte: e83be9
---
# Créer un scénario

Un scénario se dessine sur une toile : vous posez des blocs et vous les reliez par des flèches. Le contact
avance de bloc en bloc.

Les blocs que vous utiliserez le plus :

- **Envoi de modèle** : envoie un message approuvé par WhatsApp. C'est ce qui ouvre une conversation avec
  quelqu'un qui ne vous a pas écrit récemment. Sur la toile, le bloc montre une miniature du modèle choisi.
- **Message rapide** : un texte, avec jusqu'à trois boutons de réponse ou un bouton qui ouvre une page. Il ne
  part que dans une conversation déjà ouverte. Il peut porter une image, une vidéo MP4 ou un PDF ; la vidéo et le
  PDF ne partent qu'en WhatsApp, et le texte qui les accompagne est limité à 1 024 caractères. Une vidéo d'iPhone
  (MOV, ou HEVC) est refusée au dépôt : convertissez-la en MP4 H.264. Le fichier vient de votre ordinateur
  (« Choisir un fichier ») ou de ceux que vous avez déjà déposés (« Depuis la médiathèque », qui ne propose que ce que
  le bloc peut envoyer). Vos fichiers et le quota de votre offre se gèrent dans Paramètres > Médiathèque, où vous
  pouvez aussi en ajouter directement.
- **Question** : une question avec un menu de réponses, ou une question ouverte. Le scénario attend la
  réponse avant de continuer.
- **Formulaire** : envoie un formulaire WhatsApp et attend. Il a deux sorties : « Formulaire rempli » quand le
  contact le renvoie (ses réponses remplissent sa fiche), « Toute autre réponse » quand il écrit à la place. Tant
  que « Formulaire rempli » n'est reliée à rien, le formulaire renvoyé passe par « Toute autre réponse ».
- **Action** : agit sur la fiche du contact, par exemple poser ou retirer un tag, remplir un champ.
- **Condition** : aiguille le contact selon son état (ses tags, ses champs, sa dernière analyse, l'heure…). Vous
  pouvez y créer jusqu'à dix familles, chacune nommée et avec ses propres conditions : le contact suit la première
  famille vraie, de haut en bas, et part sur « Sinon » si aucune ne l'est. Sous « Système », la liste des champs
  propose aussi le dernier message reçu, la langue détectée et le pays de l'indicatif. Le dernier message reçu sert
  surtout dans une campagne : quand c'est un message du contact qui lance le scénario, c'est ce message-là, donc
  « maintenant ». Le pays suit l'indicatif : les départements d'outre-mer ont le leur, à cocher en plus de la France.
- **Attente** : met le parcours en pause, pour une durée, jusqu'à une date, ou jusqu'aux prochaines heures
  d'ouverture. En secondes (de 1 à 59), elle espace deux messages pour leur donner le rythme d'une personne qui
  écrit : quand le scénario répond au contact, celui-ci voit « en train d'écrire… » et son message passe en lu.
- **Assigner à un agent** : passe la main à quelqu'un de votre équipe, qui reprend la conversation.
- **Aller à** : envoie le contact sur un autre bloc, de ce scénario ou d'un autre, par exemple pour revenir au menu
  après une réponse. Choisissez le scénario puis le bloc, ou collez le code du bloc. Ses réponses déjà données le
  suivent, elles sont sur sa fiche. Vers un autre scénario, c'est sa version publiée qui joue : publiez-le d'abord.
  Un scénario qui se renvoie sans fin vers un autre s'arrête au bout de vingt sauts, et la conversation passe à votre
  équipe. La publication est refusée si le bloc visé n'existe pas, ou si un saut vers un autre scénario suit une
  attente de 24 h ou plus et mène à autre chose qu'un modèle ; dans le même scénario, l'écran vous en avertit.
- **Envoyer au MBA** : le parcours s'arrête et l'agent de Meta prend la conversation, quel que soit celui qui répond
  d'habitude au client ; il répond tout de suite au dernier message du contact. Si l'agent de Meta est éteint, le
  panneau du bloc vous prévient : la conversation passe alors à votre équipe, dans « À traiter ».

Chaque bouton que vous proposez devient une **sortie à relier** : le petit point à droite du bloc. Un bouton
que vous laissez débranché est un trou dans le parcours, le contact tape et ne reçoit rien. L'écran vous le
signale sur la ligne du bouton concerné.

Le scénario s'enregistre tout seul, environ une seconde après chaque modification. Un indicateur vous dit
quand la dernière sauvegarde a eu lieu.

Pour l'essayer avant de le mettre en service, utilisez le lien de test : il ouvre une conversation avec votre
numéro et fait partir le scénario depuis le début. Si l'agent de Meta tenait la conversation, il répond
d'abord « Je lance le test. », et le scénario part quelques secondes après.

Vous pouvez aussi l'essayer **à partir d'un bloc précis**, sans dérouler tout ce qui précède : le petit
bouton lecture en haut à gauche d'un bloc ouvre le même lien, mais le scénario démarrera à ce bloc-là. Ce
qui précède ce bloc n'est pas rejoué : les tags et les champs de ces étapes ne sont pas posés.

Le petit bouton à côté, en haut à gauche de chaque bloc, **copie son code** : c'est lui qu'on colle dans un « Aller
à », ou dans un appel à l'API. Il reste grisé tant que le bloc n'est pas enregistré, le temps d'une seconde.

**Ranger vos scénarios dans des dossiers.** Au-dessus de la liste, les onglets « Tous », « Sans dossier » et vos
dossiers filtrent ce que vous voyez. « + Dossier » en crée un ; « Déplacer vers… », dans le menu ⋯ d'un scénario ou
après en avoir coché plusieurs, les y range. Supprimer un dossier ne supprime pas ses scénarios : ils repassent dans
« Sans dossier ».
