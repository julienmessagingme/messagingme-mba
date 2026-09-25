---
ecran: rcs-messages
source_section: Canal RCS (menu Contenu > Messages RCS, et canal de campagne)
source_empreinte: 464234
---
# Envoyer un message RCS

Le RCS est le second canal, à côté de WhatsApp. Vos messages partent sous un **agent de marque** : votre nom
et votre logo s'affichent dans l'application Messages du destinataire, avec la pastille de vérification. Il
n'y a pas de numéro d'expéditeur, et surtout **aucun modèle à faire approuver** : vous écrivez, vous
enregistrez, vous envoyez.

**Le canal reste éteint tant qu'aucune clé d'API n'est posée.** Sur l'Accueil, sous votre numéro WhatsApp, le
bouton « Activer le RCS » demande cette clé, la vérifie chez le fournisseur et affiche ce à quoi elle donne
droit (nom de l'agent, type de trafic, quotas). Tant que le canal est éteint, les briques RCS restent
visibles mais grisées : rien ne peut partir.

**La bibliothèque** (Contenu > Messages RCS) sert à composer des messages réutilisables. Un texte, une image
d'en-tête facultative, des variables remplacées par la fiche du contact à l'envoi, des emojis, et jusqu'à
onze boutons. L'aperçu vit dans un cadre de téléphone à votre marque, et le formulaire vous dit ce qui
manque au lieu de griser son bouton sans explication. Avec une image, le texte est limité à 2 000 caractères
au lieu de 3 072.

**Un carrousel** est l'autre format : de 2 à 10 cartes qui défilent à l'horizontale, chacune avec son
visuel, son titre facultatif, son texte et jusqu'à quatre boutons **qui lui sont propres**. Les manques sont
nommés carte par carte. Changer de format, c'est créer un autre message ; en revanche, basculer entre les
deux dans le formulaire ne perd rien de ce que vous avez saisi.

**Six formes de bouton**, les mêmes partout : **Réponse** (le contact répond en un tap), **Lien**, **Appel**,
**Agenda** (ajoute le rendez-vous à l'agenda du téléphone), **Voir un lieu** et **Demander sa position**.
Seul un bouton Réponse ouvre une sortie à relier dans un scénario : les cinq autres agissent sur le
téléphone ou sortent de la conversation, ils ne renvoient rien qui permette de choisir une branche. Pour un
bouton Agenda, la date se prend en dur ou dans un champ « date et heure » de la fiche ; un contact sans date
perd le bouton et reçoit quand même le message.

**L'allure des boutons se choisit en ajoutant un visuel**, pas dans un réglage : avec une image, ils
s'affichent en liste pleine largeur dans la carte et y restent (quatre au maximum) ; sans image, en petites
pastilles sous la bulle, qui disparaissent quand la conversation avance (onze au maximum). C'est
l'application Messages du destinataire qui décide, et l'aperçu vous montre les deux formes.

**Le visuel se téléverse depuis la console** : vous choisissez une image sur votre ordinateur (JPEG, PNG ou
GIF, 2 Mo maximum) et l'adresse se remplit toute seule. Le champ accepte aussi une adresse collée si vous
hébergez déjà vos visuels ailleurs.

**En campagne**, choisissez « Un message RCS » comme contenu, puis partez d'un message enregistré ou écrivez
directement. Les contacts sans numéro mobile sont comptés « ignorés » avec leur motif : le RCS s'adresse à
un mobile, une ligne fixe ne peut pas le recevoir. Un carrousel choisi en campagne est **copié en entier**
sur l'étage : pour le modifier, modifiez-le dans la bibliothèque puis choisissez-le à nouveau.

**En scénario**, le bloc « Message RCS » a deux sorties de livraison, **Envoyé** et **Non joignable**, plus
une sortie par bouton réponse. Relier « Non joignable » à un envoi de modèle WhatsApp donne la cascade : le
RCS d'abord, le WhatsApp pour ceux qu'il n'atteint pas. Le fournisseur ne sait pas dire à l'avance si un
numéro est joignable en RCS : cette sortie se déclenche donc sur le rapport de livraison, quelques instants
à quelques minutes après l'envoi, et non au moment où le bloc est atteint.

**Le canal suit la conversation, pas le bloc.** Un scénario qui commence en RCS continue en RCS. Pour
basculer volontairement sur WhatsApp, branchez un envoi de modèle : le parcours y passe et y reste. Un
scénario peut donc **commencer** par un message RCS même quand la fenêtre WhatsApp de 24 heures est fermée,
puisque le RCS n'a pas de fenêtre. Une exception que l'éditeur signale : un **formulaire** WhatsApp placé
juste derrière ne partira que si le contact a écrit sur WhatsApp dans les 24 heures, car répondre en RCS ne
rouvre pas cette fenêtre.

**Depuis l'Inbox**, le bouton 📱 envoie un message RCS de votre bibliothèque au contact ouvert, ou, dans
l'onglet « Réponse libre », votre propre phrase, qui part telle quelle sous l'agent de marque. Il vous est
proposé même quand la fenêtre WhatsApp est fermée : c'est souvent le moyen le plus simple de reprendre
contact.

**Deux points sur les réponses et les chiffres.** Un contact qui répond STOP est désabonné du RCS sans que
cela touche son consentement WhatsApp. Et les deux canaux ne se mélangent pas dans vos mesures : une réponse
reçue en RCS ne compte pas comme une réponse au modèle WhatsApp d'une campagne. Le RCS a un prix, le vôtre,
et il entre dans le coût par engagement comme le reste.
