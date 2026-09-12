# Le récap du bot d'aide : cadrage

> Cadrage, pas encore une spec finie. Date : 2026-09-12. Demande de Julien : « à l'ouverture du bot,
> proposer toujours un bouton récap du jour qui ferait le récap de la veille : combien de
> conversations, combien de messages, quels thèmes principaux. Le bot doit donc aider mais aussi
> synthétiser. »

## Ce que ça change vraiment

🔴 **Ce n'est pas un bouton, c'est la PREMIÈRE capacité de lecture de données du bot d'aide.**
`src/http/aide.ts` ne lui câble aucun outil : il cherche dans `aide_fiches` et rien d'autre. Le
paramètre `outils` existe dans la signature du moteur et personne ne le remplit. On passe d'un bot
qui explique le produit à un bot qui lit l'espace du client.

Deux conséquences immédiates. L'isolation (`tenant_id = $1`) devient un enjeu là où il n'y en avait
aucun (les fiches d'aide n'ont pas de `tenant_id`, c'est le même corpus pour tout le monde). Et le
rôle de la personne décide de ce qu'elle a le droit de lire, là où il ne décidait que des écrans
qu'on avait le droit de lui montrer.

## Trois trouvailles qui commandent le dessin

### 1. Les jetons du bot d'aide sont à NOTRE charge, pas sur le crédit du client

C'est écrit dans `src/http/aide.ts` et c'est une décision de Julien du 2026-09-11 : « facturer
quelqu'un pour apprendre à se servir du produit se retourne contre nous, celui qui hésite à poser
une question étant celui qui abandonne ».

🔴 **Un récap proposé à chaque ouverture du bot est donc une dépense RÉCURRENTE sur notre clé**, et
pas une dépense du client. Cent espaces, cinq personnes chacun, un clic par jour : cinq cents appels
de modèle quotidiens à notre charge, pour un contenu identique d'une personne à l'autre dans un même
espace.

**La parade est le cache, et elle est gratuite** : le récap porte sur la VEILLE, donc il ne bouge
plus. Le premier qui clique dans un espace le fait calculer, tous les autres lisent le même. La
dépense passe de « par personne et par jour » à « par espace et par jour », et tout le monde voit la
même chose, ce qui est de toute façon préférable.

### 2. `conversation_analysis.created_at` n'est PAS la date de la conversation

🔴 **Le piège qui rendrait le récap silencieusement faux.** C'est documenté dans
`src/stats/conversation-stats.pg.ts` : la ligne d'analyse est réécrite en `now()` à chaque
ré-analyse (upsert), donc cette colonne porte la date de **dernière analyse**, pas celle de la
conversation.

Un récap « d'hier » bâti dessus compterait les conversations **analysées** hier, ce qui veut dire :
une conversation d'il y a trois jours ré-analysée hier y apparaît, et une conversation tenue hier
mais analysée ce matin n'y est pas. Personne ne le verrait, et les chiffres seraient plausibles.

**Donc deux sources, pas une** :

- le **volume** (conversations, messages) se lit sur `conversations` et `conversation_messages`, à
  leurs vraies dates ;
- les **thèmes** se lisent sur `conversation_analysis.topic`, mais **rattachés aux conversations
  d'hier**, quelle que soit la date de leur analyse.

### 3. L'analyse ne tourne qu'à l'inactivité, donc le récap est toujours incomplet

Une conversation d'hier soir encore vivante ce matin n'a pas de thème. Un récap qui annonce
42 conversations et n'en thématise que 25 **doit l'écrire**. Sans cette phrase, il sous-déclare sans
prévenir, et quelqu'un conclura que le sujet dont il se préoccupe n'est pas remonté.

## La conception

### Le partage du travail : le SQL compte, le modèle formule

🔴 **Le modèle ne compte JAMAIS.** Un chiffre faux dans un récap est pire que pas de récap, parce
que les gens agissent dessus. C'est la leçon de la migration 0126, où l'annonce d'IA était confiée
au modèle et où le code a dû reprendre la décision.

Le SQL produit **tout** ce qui est chiffré, y compris les comparaisons :

```
{
  jour: '2026-09-11',
  conversations: 42,
  conversationsAnalysees: 25,   // le reste n'a pas de thème, et le récap le dit
  messagesEntrants: 128,
  messagesSortants: 96,
  themes: [ { topic: 'retard de livraison', n: 12 }, ... ],   // les 5 premiers
  veilleComparable: { conversations: 21, messagesEntrants: 60 },  // même jour la semaine d'avant
}
```

Le modèle reçoit cet objet et écrit deux ou trois phrases. **Il ne peut inventer aucun nombre, parce
que tout nombre qu'il a le droit de citer est dans son entrée.**

⚠️ **La comparaison est le seul endroit où le modèle apporte quelque chose**, et c'est pour ça
qu'elle est calculée en SQL plutôt que laissée à son appréciation : « les retards de livraison ont
doublé par rapport à la semaine dernière » est utile, et ça doit être vrai.

### Une question à se poser avant d'écrire : faut-il un modèle du tout ?

Un gabarit rendu sans appel de modèle donnerait déjà : « Hier : 42 conversations, 128 messages
reçus. Trois thèmes dominants : retard de livraison (12), remboursement (8), horaires (5). » C'est
déterministe, instantané, et gratuit.

**Ce que le modèle ajoute n'est pas la mise en forme, c'est le REMARQUABLE** : dire que tel thème a
doublé, que le volume est inhabituel, qu'un sujet nouveau est apparu. Si on ne lui demande que de
reformuler une liste, il ne vaut pas sa dépense.

**Position retenue, à confirmer** : appel de modèle, mais **uniquement quand le SQL a trouvé quelque
chose à signaler** (un écart significatif avec la semaine précédente, un thème nouveau). Sinon,
gabarit. Le coût ne se paie que les jours où il achète quelque chose.

### Là où le bouton se pose

L'écran d'accueil du bot porte **déjà** trois suggestions cliquables, avec sa justification écrite
dans `web/components/BoutonAide.tsx` : « une suggestion qu'on clique est une porte, une phrase qui
dit quoi faire est un mur ». Le récap devient une quatrième porte, en tête. Rien à réinventer.

⚠️ **Le libellé dit ce qu'il fait.** « Récap du jour » qui recense la veille laissera quelqu'un se
demander à 16 h pourquoi ses conversations du matin n'y sont pas. Le libellé est **« Hier »** ou
« Le récap d'hier ».

### L'invariant du moteur à ne pas casser

🔴 Le moteur actuel porte une garde documentée : **quand aucune fiche n'est pertinente, il dit qu'il
ne sait pas SANS appeler le modèle**, parce qu'appeler sans source c'est demander d'inventer.

Un récap ne vient d'aucune fiche. Branché naïvement comme une question ordinaire, il tomberait droit
dans le chemin « je ne sais pas ». **Le récap est donc un chemin à part, pas une question déguisée**,
et il n'emprunte pas le rappel de connaissance.

## Ce qui existe et qu'on réutilise

| Brique | Ce qu'elle donne |
|---|---|
| `src/stats/range.ts` (`STATS_TZ`, `BOUNDS_CTE`) | Les bornes de journée dans le bon fuseau. ⚠️ À réutiliser, pas à réécrire : les mesures filtrent en UTC et l'écran raisonne en heure locale, c'est un piège déjà relevé dans `todo.md` |
| `conversation_analysis.topic` | « Le sujet en 2 à 5 mots, en français », déjà alimenté |
| `src/stats/conversation-stats.pg.ts` | Le motif de lecture et sa documentation des pièges. ⚠️ `getSummary` est indexé sur la date d'ANALYSE : ne pas l'appeler tel quel pour un récap daté |
| `web/components/BoutonAide.tsx` | L'accueil et ses suggestions cliquables |
| `carteVisiblePar(role)` | Le motif de filtrage par rôle, aujourd'hui pour les écrans |

## Les décisions de Julien (2026-09-12)

**Le récap est réservé aux rôles `admin` et `manager`.** Un opérateur (rôle `agent`, qui ne voit que
l'Inbox) n'y a pas droit. C'est un artefact de pilotage, pas un outil de traitement.

🔴 **Le bouton est MASQUÉ pour un opérateur, pas grisé avec sa raison**, et c'est une exception
assumée à la règle inverse posée ailleurs dans le produit (un canal non configuré se grise en disant
pourquoi). La distinction tient au type d'empêchement : un canal grisé dit « tu pourrais avoir ceci,
voilà comment », ce qui est utile ; un récap grisé dirait à un opérateur « tes collègues ont une
fonctionnalité que tu n'auras jamais », ce qui n'est que du bruit. La règle générale n'est donc pas
« toujours griser », c'est **« griser quand l'empêchement est levable par celui qui le voit »**.

⚠️ La garde se pose **côté serveur**, pas seulement en masquant le bouton. La route refuse en 403
pour un rôle non autorisé, comme les écritures admin du reste du produit.

**Le récap porte sur la veille, et rien d'autre.** Pas d'historique, pas de choix de date, pas de
relecture d'avant-hier. « Sinon trop compliqué » (Julien). Conséquence : le cache n'a pas besoin
d'être une table, une entrée par espace remplacée chaque jour suffit.

## Ce qui reste à trancher

1. **Appel de modèle systématique, ou seulement quand il y a quelque chose à signaler ?** Position
   proposée plus haut : gabarit par défaut, modèle seulement les jours où le SQL a trouvé un écart.
   On ne paie que quand ça achète quelque chose, et le bot d'aide dépense NOTRE argent.
