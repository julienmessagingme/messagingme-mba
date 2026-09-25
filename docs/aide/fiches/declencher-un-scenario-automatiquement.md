---
ecran: automations
source_section: Automation (menu « Automation ») | Rappels avant ou après une date (menu Automation) | Automatisations (menu « Scénario », ex-« Flow »)
source_empreinte: 8ee8bd | 08adbf | 650781
---
# Lancer un scénario tout seul, sans campagne

Une automation relie un **événement** à un **scénario** : quand l'événement se produit, le scénario part,
pour la personne concernée, sans que vous ayez rien à lancer.

L'écran Automation liste ce que vous avez monté : le nom que vous lui avez donné, le déclencheur écrit en
clair, le scénario visé, et si c'est allumé ou non.

**Les déclencheurs que vous pouvez choisir :**

- **Le client envoie un mot-clé** : vous listez des mots séparés par des virgules, et vous choisissez si le
  message doit contenir le mot ou lui être exactement égal. La casse et les accents sont ignorés.
- **Un nouveau contact écrit pour la première fois** : rien à régler.
- **Un tag est posé sur un contact** : vous saisissez le tag qui déclenche.
- **Une conversation vient d'être analysée** : vous filtrez par ressenti du client, et vous pouvez n'agir
  que sur les demandes restées sans solution.
- **Un deal HubSpot atteint une étape** : vous choisissez l'étape dans la liste de vos pipelines, les étapes
  de fin étant signalées. Ce déclencheur n'apparaît que si un portail HubSpot est relié à votre espace.
- **Un délai avant ou après une date enregistrée** : de quoi faire un rappel. Vous dites combien de temps
  (en minutes, en heures ou en jours), de quel côté de la date, et sur quel champ. Il vous faut pour cela un
  champ « date et heure » dans votre espace ; sinon l'écran vous le dit et vous propose d'en créer un.
- **Le contact arrive d'une publicité WhatsApp** : l'identifiant de la publicité est facultatif. Laissé vide,
  le scénario part pour toute personne arrivant par une publicité, **sauf celles que vous pilotez depuis
  l'écran Publicités** : ces campagnes-là disent elles-mêmes qui répond à leurs prospects.
- **Le risque de désengagement d'un contact devient élevé** : rien à régler. Le calcul de nuit fait passer un
  contact en risque élevé, et le scénario part pour lui, une seule fois : un contact qui reste en risque élevé
  ne relance rien la nuit suivante.

Trois de ces déclencheurs demandent une précision, parce qu'ils surprennent :

**Sur le délai autour d'une date**, une échéance déjà passée n'envoie rien. Un rappel qui part en retard dit
quelque chose de faux au client. Si la date change sur la fiche, le rappel repart sur la nouvelle. Et cela
vaut aussi pour « après » : allumer l'automation ne rattrape pas les dates déjà dépassées, sinon tous vos
contacts concernés partiraient d'un coup.

**Sur l'arrivée par une publicité**, le contact vient de vous écrire : la fenêtre de vingt-quatre heures est
donc ouverte, et ce scénario peut commencer par un message rapide, sans modèle à faire approuver. C'est le
seul déclencheur qui vous laisse ouvrir librement.

Il y a une seconde chose à savoir, et elle compte si vous créez vos publicités ici. **Une publicité pilotée
depuis l'écran Publicités choisit elle-même qui répond à ses prospects** : le scénario que vous lui avez
désigné, ou l'agent de Meta. Pour ces prospects-là, aucune autre automation ne part, ni « toute personne
arrivant par une publicité », ni « un nouveau contact écrit pour la première fois ». C'est ce qui garantit
qu'un clic que vous avez payé reçoit la réponse que vous aviez prévue, et une seule. Les publicités que vous
continuez de gérer dans le Gestionnaire de Meta, elles, ne changent pas : leurs prospects passent par les
automations de cet écran, comme avant.

**Sur le risque élevé**, le scénario part vers des contacts qui ne vous ont pas écrit : il doit commencer
par un envoi de modèle. Comme le calcul porte sur toute votre base en une nuit, il est plafonné à 200
contacts par nuit ; au-delà, le niveau est bien noté sur leur fiche, mais le scénario ne part pas pour eux.
Un contact désabonné ou bloqué ne déclenche jamais rien.

**Une automation neuve est toujours créée éteinte.** Vous la relisez, puis vous l'allumez d'un clic sur son
badge. Pour changer son déclencheur ou son scénario, vous la supprimez et vous la recréez : c'est
volontaire, pour qu'une automation en service ne change jamais de comportement sans qu'on s'en aperçoive.

Attention à un point qui surprend : un tag posé en masse sur une sélection de contacts **ne déclenche rien**.
Seul un tag posé sur une fiche, une par une, lance l'automation. Sans cette limite, cocher cinq mille
contacts enverrait cinq mille messages d'un coup. Pour toucher une liste entière, c'est une campagne.
