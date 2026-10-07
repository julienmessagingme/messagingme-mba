---
ecran: workflows
source_section: Automatisations (menu « Scénario », ex-« Flow »)
source_empreinte: 446e15
---
# Créer un scénario

Un scénario se dessine sur une toile : vous posez des blocs et vous les reliez par des flèches. Le contact
avance de bloc en bloc.

Les blocs que vous utiliserez le plus :

- **Envoi de modèle** : envoie un message approuvé par WhatsApp. C'est ce qui ouvre une conversation avec
  quelqu'un qui ne vous a pas écrit récemment. Sur la toile, le bloc montre une miniature du modèle choisi.
- **Message rapide** : un texte, avec jusqu'à trois boutons de réponse ou un bouton qui ouvre une page. Il ne
  part que dans une conversation déjà ouverte.
- **Question** : une question avec un menu de réponses, ou une question ouverte. Le scénario attend la
  réponse avant de continuer.
- **Action** : agit sur la fiche du contact, par exemple poser ou retirer un tag, remplir un champ.
- **Condition** : aiguille le contact selon son état (ses tags, ses champs, sa dernière analyse, l'heure…). Vous
  pouvez y créer jusqu'à dix familles, chacune nommée et avec ses propres conditions : le contact suit la première
  famille vraie, de haut en bas, et part sur « Sinon » si aucune ne l'est. Sous « Système », la liste des champs
  propose aussi le dernier message reçu, la langue détectée et le pays de l'indicatif. Le dernier message reçu sert
  surtout dans une campagne : quand c'est un message du contact qui lance le scénario, c'est ce message-là, donc
  « maintenant ». Le pays suit l'indicatif : les départements d'outre-mer ont le leur, à cocher en plus de la France.
- **Attente** : met le parcours en pause, pour une durée, jusqu'à une date, ou jusqu'aux prochaines heures
  d'ouverture.
- **Assigner à un agent** : passe la main à quelqu'un de votre équipe, qui reprend la conversation.
- **Aller à** : envoie le contact sur un autre bloc, de ce scénario ou d'un autre, par exemple pour revenir au menu
  après une réponse. Choisissez le scénario puis le bloc, ou collez le code du bloc. Ses réponses déjà données le
  suivent, elles sont sur sa fiche. Vers un autre scénario, c'est sa version publiée qui joue : publiez-le d'abord.
  Un scénario qui se renvoie sans fin vers un autre s'arrête au bout de vingt sauts, et la conversation passe à votre
  équipe. La publication est refusée si le bloc visé n'existe pas, ou si un saut vers un autre scénario suit une
  attente de 24 h ou plus et mène à autre chose qu'un modèle ; dans le même scénario, l'écran vous en avertit.

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
