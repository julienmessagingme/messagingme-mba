---
ecran: workflows
source_section: Automatisations (menu « Scénario », ex-« Flow »)
source_empreinte: 18896a
---
# Créer un scénario

Un scénario se dessine sur une toile : vous posez des blocs et vous les reliez par des flèches. Le contact
avance de bloc en bloc.

Les blocs que vous utiliserez le plus :

- **Envoi de modèle** : envoie un message approuvé par WhatsApp. C'est ce qui ouvre une conversation avec
  quelqu'un qui ne vous a pas écrit récemment.
- **Message rapide** : un texte, avec jusqu'à trois boutons de réponse ou un bouton qui ouvre une page. Il ne
  part que dans une conversation déjà ouverte.
- **Question** : une question avec un menu de réponses, ou une question ouverte. Le scénario attend la
  réponse avant de continuer.
- **Action** : agit sur la fiche du contact, par exemple poser ou retirer un tag, remplir un champ.
- **Condition** : aiguille le contact selon son état, avec deux suites possibles.
- **Attente** : met le parcours en pause, pour une durée, jusqu'à une date, ou jusqu'aux prochaines heures
  d'ouverture.
- **Assigner à un agent** : passe la main à quelqu'un de votre équipe, qui reprend la conversation.

Chaque bouton que vous proposez devient une **sortie à relier** : le petit point à droite du bloc. Un bouton
que vous laissez débranché est un trou dans le parcours, le contact tape et ne reçoit rien. L'écran vous le
signale sur la ligne du bouton concerné.

Le scénario s'enregistre tout seul, environ une seconde après chaque modification. Un indicateur vous dit
quand la dernière sauvegarde a eu lieu.

Pour l'essayer avant de le mettre en service, utilisez le lien de test : il ouvre une conversation avec votre
numéro et fait partir le scénario depuis le début.

Vous pouvez aussi l'essayer **à partir d'un bloc précis**, sans dérouler tout ce qui précède : le petit
bouton lecture en haut à gauche d'un bloc ouvre le même lien, mais le scénario démarrera à ce bloc-là. Ce
qui précède ce bloc n'est pas rejoué : les tags et les champs de ces étapes ne sont pas posés.
