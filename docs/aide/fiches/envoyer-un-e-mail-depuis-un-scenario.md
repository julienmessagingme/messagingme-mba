---
ecran: email-templates
source_section: E-mail (menu Compte > Boîtes email, menu Contenu > Modèles d'email)
source_empreinte: 3e0a73
---
# Envoyer un e-mail depuis un scénario

L'e-mail est le troisième canal, et il est **réservé aux scénarios** : il n'existe ni campagne e-mail ni
inbox e-mail. Un bloc de scénario envoie un message à l'adresse portée par la fiche du contact. Cela se
prépare en deux endroits.

**Connecter votre boîte**, d'abord, depuis le menu Compte en haut à droite, « Boîtes email ». Vous y
déclarez une ou plusieurs boîtes : nom d'affichage, serveur, port, identifiant, mot de passe, adresse
d'expéditeur, nom d'expéditeur, adresse de réponse. Le mot de passe est chiffré chez nous et **jamais
réaffiché** : à l'édition, un champ laissé vide veut dire « inchangé ». Un bouton **« Tester »** envoie un
vrai message à l'adresse de votre choix, et c'est le seul moyen de savoir qu'un mot de passe d'application
est bon avant qu'un client n'en fasse les frais.

**Écrire vos modèles**, ensuite, dans Contenu > Modèles d'email : un nom, un sujet, un corps, au choix en
**texte simple** ou en **HTML brut** si vous collez un message préparé ailleurs. Le sujet et le corps
acceptent des variables, insérées par le même bouton « Variable » que les modèles WhatsApp et les messages
RCS, avec la même liste de champs de base et de champs à vous. Vous ne recopiez jamais un nom de variable à
la main.

**Dans le scénario**, le bloc « Envoi de mail » est présenté à part dans la palette et **grisé tant
qu'aucune boîte n'est connectée**, avec l'infobulle qui vous renvoie à Boîtes email. Même règle que le bloc
RCS : un bloc qui ne peut rien envoyer ne doit pas être proposé comme s'il le pouvait.

**Jusqu'à trois destinataires.** Vous choisissez le champ qui porte l'adresse, et vous pouvez en ajouter
deux autres. Le premier part en « À », les suivants **en copie cachée** : les destinataires ne se voient pas
entre eux.

**Le sélecteur de destinataire dit combien de fiches ont ce champ rempli**, par exemple « Email (12/40
fiches) ». C'est ce qui distingue deux champs voisins dont l'un est vide partout : brancher un bloc mail sur
un champ vide, c'est n'envoyer aucun message.

**Un échec n'interrompt jamais le parcours** : le scénario continue. Les envois comme les échecs se comptent
dans le Performance Lab, sous Mes tableaux.
