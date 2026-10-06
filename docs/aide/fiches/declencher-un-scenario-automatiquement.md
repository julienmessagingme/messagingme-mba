---
ecran: automations
source_section: Automation (menu « Automation ») | Rappels avant ou après une date (menu Automation) | Automatisations (menu « Scénario », ex-« Flow »)
source_empreinte: eda598 | 08adbf | 4f1c01
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
  que sur les demandes restées sans solution. Vous pouvez ajouter d'autres filtres sur l'analyse, les mêmes
  que dans la liste des contacts : intention, urgence ou satisfaction au-dessus ou en dessous d'une note,
  action suggérée, demande résolue ou non.
- **La dernière analyse d'un contact change** : vous choisissez un champ et ce qu'il doit devenir, par exemple
  « le sentiment devient négatif » ou « l'urgence passe à 7 ou plus ». Le scénario part quand une analyse fait
  passer le contact dans ce cas, pas quand il y était déjà. La première analyse d'un contact compte.
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
  ne relance rien la nuit suivante, et un même contact ne relance pas le scénario avant 30 jours, même s'il
  ressort puis repasse en risque élevé.

Pour chaque automation, vous réglez aussi le délai avant de relancer le scénario pour un même contact : le
délai par défaut (une heure, sept jours pour « la dernière analyse change », trente jours pour « le risque
devient élevé »), ou une heure, six heures, un jour, trois jours, sept jours.

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
par un envoi de modèle. Il ne part jamais la nuit : le calcul se fait vers 3 heures, et le scénario attend
l'ouverture de votre espace (vos heures d'ouverture dans Paramètres, du lundi au vendredi de 9 heures à
18 heures tant que vous n'avez rien réglé). Comme le calcul porte sur toute votre base, il est plafonné à
200 contacts par jour ; au-delà, le niveau est bien noté sur leur fiche, mais le scénario ne part pas pour
eux. Un contact désabonné ou bloqué ne déclenche jamais rien.

**Sur « la dernière analyse change »**, un changement manqué ne se rattrape pas. Si le scénario ne part pas
à ce moment-là (un membre de l'équipe ou l'agent de Meta tient la conversation, ou le délai de relance court
encore), il ne repartira qu'au prochain vrai changement. Le client n'écrivant plus quand l'analyse tourne,
le scénario doit commencer par un envoi de modèle.

**Une automation neuve est toujours créée éteinte.** Vous la relisez, puis vous l'allumez d'un clic sur son
badge. Pour la changer, cliquez sur « Modifier » sur sa ligne : le formulaire se rouvre tel que vous l'avez
rempli. Elle garde son état : si elle est allumée, vos changements s'appliquent dès l'enregistrement.

Attention à un point qui surprend : un tag posé en masse sur une sélection de contacts **ne déclenche rien**.
Seul un tag posé sur une fiche, une par une, lance l'automation. Sans cette limite, cocher cinq mille
contacts enverrait cinq mille messages d'un coup. Pour toucher une liste entière, c'est une campagne.
