---
ecran: mba-settings
source_section: L'onglet « Outils » de l'agent de Meta (Meta Business Agent > Paramètres > Outils)
source_empreinte: 59179a
---
# Donner des outils à l'agent de Meta

Par défaut, l'agent de Meta parle. Un outil lui donne le droit de **faire** quelque chose : poser une
étiquette, retenir une information, envoyer un message que vous avez écrit, lancer un de vos scénarios, ou
appeler votre système. L'onglet Outils de ses paramètres les liste, et eux seuls. Réservé aux
administrateurs.

**Cinq types**, derrière le bouton « Ajouter un outil » :

- **Poser un tag.** L'étiquette est fixée par vous, l'agent ne décide que du moment. Elle arrive sur la fiche
  du mini-CRM. Attention : ne comptez pas sur vos automations « tag ajouté » pour prendre le relais. L'agent
  de Meta tient alors la conversation, et un démarrage automatique n'écrit jamais dans une conversation
  tenue. Le scénario qu'elles lanceraient ne démarre pas, et il n'est pas rejoué ensuite. L'écran le dit.
- **Enregistrer une information.** Le champ de la fiche est fixé, l'agent fournit la valeur, tirée de la
  conversation. Vous pouvez lui imposer une liste de valeurs permises : toute autre valeur est refusée, et
  il le sait.
- **Envoyer un bloc.** Un message précis d'un de vos scénarios publiés, choisi à l'avance. Il part **seul**,
  sans la suite du scénario, et l'agent reprend la parole au message suivant du client. Un bloc qui attend
  une réponse (des boutons, une question, un formulaire, une attente) ne se choisit pas : il reste visible,
  grisé, avec sa raison. Hors de la fenêtre de 24 heures, seul un modèle peut partir. C'est irréversible, et
  l'écran le dit : un message parti ne se rappelle pas.
- **Lancer un scénario.** Un scénario publié, depuis son début, exactement comme le bouton de l'Inbox. Engage
  Me prend la conversation le temps du parcours, puis la rend à l'agent de Meta.
- **Appeler un connecteur API.** Un appel que vous avez déclaré une fois dans Tools > Connecteurs API.

Un type reste grisé, avec le lien qui y mène, tant que votre espace n'a rien à y mettre : aucun champ
déclaré, aucun appel déclaré. Une lecture qui échoue ne passe pas pour « aucun » : elle le dit, avec
« Réessayer ».

**La réponse « à côté ».** Quand un de vos scénarios pose une question à boutons et que le client écrit
autre chose (« vous êtes ouverts dimanche ? »), le parcours s'arrête, la conversation revient à l'agent de
Meta et son message lui est transmis : il y répond aussitôt, au lieu d'attendre le message suivant.

**Enregistrer, c'est envoyer à Meta.** Créer, modifier ou supprimer un outil le porte chez Meta dans le même
geste. Si l'envoi échoue, votre enregistrement n'est pas défait : la ligne reste « À envoyer », qui est un
bouton. Il envoie tout ce qui attend, parce que Meta ne reçoit qu'une publication entière.

**Écrivez « Quand l'appeler » comme une consigne, pas comme un constat.** C'est cette phrase qui décide si
l'agent appelle l'outil, et ses propres réflexes peuvent l'emporter sur une description vague. « Le client
demande à rajouter une étiquette » ne déclenche rien. « Appelle cet outil dès que le client demande qu'on
lui ajoute une étiquette. Il sait déjà qui est le client et quelle étiquette poser. Confirme-lui que c'est
fait. Ne passe pas la main pour cette demande. » déclenche au premier essai. Une consigne pré-remplie vous
est proposée par type, et l'outil ne s'enregistre pas tant que le trou à compléter est resté tel quel.

**Ce que l'écran vous signale, et pourquoi :**

- **Une ligne rouge** quand la cible n'existe plus, par exemple un champ que vous avez supprimé du mini-CRM.
  Un tel outil refuse à chaque appel, rien n'est écrit sur la fiche, et l'agent lit pourquoi.
- **Un appel irréversible le dit**, sur la ligne et au moment de le choisir, en rappelant que l'agent
  l'exécute sans validation humaine.
- **Un connecteur partagé avec un agent IA le dit** (« Aussi utilisé par… ») : le modifier le modifie pour
  cet agent aussi. « Supprimer » ne le retire alors qu'à l'agent de Meta.
- **« Désactivé »** quand la personne qui avait ajouté un outil a quitté votre espace : ses autorisations
  s'éteignent, et un administrateur rallume l'outil d'un clic.
- **Ce que Meta liste encore sans outil ici** apparaît au-dessus de la liste, avec le bouton qui le range.
  Tout effacement chez Meta que ce geste n'a pas demandé vous est demandé en le nommant, parce que Meta ne
  rend jamais un outil effacé.

**Engage Me fait foi, et la publication écrase.** Un outil ajouté à la main dans WhatsApp Manager sera
supprimé à la publication suivante. L'écran le dit, et l'aperçu vous le montre avant le clic. Publier deux
fois de suite ne produit en revanche aucun geste.

**Comment ça marche, en un paragraphe.** L'agent de Meta n'appelle pas votre système directement : il passe
par Engage Me. Nous reconnaissons votre client à son numéro WhatsApp (que WhatsApp transmet lui-même, l'agent
ne peut pas l'inventer), nous remplissons les valeurs que nous connaissons déjà, puis nous faisons l'appel
avec les mêmes contrôles et le même journal que pour vos agents IA. Votre clé d'accès ne quitte donc jamais
Engage Me. Une clé « Agent de Meta » apparaît dans la liste de vos clés d'API : c'est celle que l'agent nous
présente. Elle ne se crée pas à la main, et la révoquer coupe ses outils jusqu'au prochain envoi.
