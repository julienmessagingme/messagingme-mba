---
ecran: automations
source_section: Automation (menu « Automation »)
source_empreinte: ec2828
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

**Une automation neuve est toujours créée éteinte.** Vous la relisez, puis vous l'allumez d'un clic sur son
badge. Pour changer son déclencheur ou son scénario, vous la supprimez et vous la recréez : c'est
volontaire, pour qu'une automation en service ne change jamais de comportement sans qu'on s'en aperçoive.

Attention à un point qui surprend : un tag posé en masse sur une sélection de contacts **ne déclenche rien**.
Seul un tag posé sur une fiche, une par une, lance l'automation. Sans cette limite, cocher cinq mille
contacts enverrait cinq mille messages d'un coup. Pour toucher une liste entière, c'est une campagne.
