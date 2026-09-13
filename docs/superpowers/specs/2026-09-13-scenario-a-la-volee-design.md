# Créer un scénario sans quitter sa campagne

**Demandé par Julien le 2026-09-13**, à la suite du bug « Modèle et scénario » corrigé le même jour.

## Le problème

Pour lancer une campagne « Modèle et scénario », il faut un scénario qui existe déjà. Celui qui n'en a
pas doit quitter sa campagne, aller dans l'onglet Scénario, le construire, le publier, revenir, et
retrouver où il en était. Le brouillon de campagne le protège de tout perdre, mais le parcours reste
une interruption au milieu d'une tâche.

## Ce qu'on construit

Dans le sélecteur de scénario d'un étage, **une première entrée avant les scénarios existants :
« Créer un scénario »**. Elle ouvre une fenêtre occupant environ les trois quarts de l'écran, qui
porte l'éditeur de scénario habituel. « Publier » referme la fenêtre et sélectionne le scénario neuf
dans la campagne.

## 🔴 La contrainte qui commande tout le reste : le scénario existe AVANT son graphe

`WorkflowBuilder` (`web/components/WorkflowBuilder.tsx`, 653 lignes) est déjà un composant autonome,
montable dans une fenêtre modale sans rien réécrire. Mais **il exige un `workflowId`** : il édite un
scénario qui existe, il n'en crée pas.

La séquence est donc forcée :

1. l'opérateur choisit « Créer un scénario » ;
2. **on lui demande son nom** (c'est déjà la première étape du parcours normal, et l'éditeur n'a pas
   d'endroit où la poser) ;
3. **le scénario est CRÉÉ, vide**, et on obtient son identifiant ;
4. l'éditeur se monte dessus, dans la fenêtre ;
5. « Publier » ferme et le sélectionne dans la campagne.

⚠️ **CONSÉQUENCE ASSUMÉE : le scénario existe dès l'étape 3, donc il apparaît tout de suite dans
l'onglet Scénario** (ce que Julien demande explicitement), **mais aussi si l'opérateur ferme la fenêtre
sans rien construire.** Un scénario vide et non publié traînerait alors dans sa liste.

C'est le seul vrai arbitrage de cette feature, et il se règle sans inventer de mécanique : un scénario
jamais publié est **un brouillon**, notion que le produit porte déjà (`brouillonInitial`, `publieLe`).
Fermer la fenêtre sans publier laisse donc un brouillon, exactement comme quitter l'éditeur normal en
cours de route. On ne supprime rien automatiquement : effacer le travail de quelqu'un parce qu'il a
fermé une fenêtre est pire que de lui laisser une ligne à ranger.

## 🔴 La garde du premier bloc, qui est le cœur de la demande

Julien : « faire bien attention que le user qui crée le scénario à la volée ne puisse pas publier un
scénario qui ne commence pas par un Template. Et si c'est du RCS, il faut aussi que ça démarre par un
RCS. Appliquer les mêmes règles aux campagnes avec fallback qui utilisent des scénarios. »

**La moitié de cette règle existe déjà et se réutilise** : `scanOpening(graph)`
(`web/lib/campaign-eligibility.ts`) rend `firstTemplate` (avec son `templateName`) et `rcsOpen`, et
`isCampaignEligible` s'en sert pour filtrer la liste des scénarios proposés en campagne.

Ce qui manque, et qui est à construire :

- **la règle PAR CANAL D'ÉTAGE.** `isCampaignEligible` accepte aujourd'hui les deux ouvertures, template
  ou RCS. Sur un étage **WhatsApp**, un scénario qui ouvre en RCS est pourtant invalide, et
  réciproquement. La liste proposée doit donc être filtrée par le canal de l'étage, pas seulement par
  « lançable en campagne » ;
- **le refus AU MOMENT DE PUBLIER depuis la fenêtre**, avec sa raison, plutôt qu'un refus plus tard au
  récapitulatif de la campagne ;
- **la même règle sur les étages de repli**, qui utilisent eux aussi des scénarios.

⚠️ **LA LISTE NE PORTE PAS LES GRAPHES**, et c'est délibéré : elle les a portés, elle renvoyait deux
graphes complets par scénario, et on les a retirés. Filtrer par canal côté navigateur exigerait de les
relire un par un. Le canal d'ouverture doit donc être **calculé par le serveur** et rendu à côté de
`campaignEligible`, comme lui.

## Ce qu'on ne construit pas

- **Pas de second éditeur, pas de version allégée.** L'éditeur de la fenêtre est celui de l'onglet
  Scénario, monté ailleurs. Deux éditeurs divergeraient en une semaine.
- **Pas de scénario « propre à la campagne ».** Julien est explicite : on doit le retrouver dans
  l'onglet Scénario. C'est un scénario de l'espace comme un autre.
- **Pas de suppression automatique** d'un brouillon abandonné (cf. ci-dessus).

## Les points à vérifier avant de coder

1. La fenêtre modale doit laisser l'éditeur **respirer** : il porte un canevas de blocs, un panneau de
   configuration et une barre d'outils. Sur un 13 pouces (1280 x 800), « les trois quarts de l'écran »
   font environ 960 x 600. La garde de largeur (`web/e2e/aide/largeur.ts`) doit mesurer ce cas.
2. L'éditeur charge ses propres données (modèles, formulaires, agents, membres, requêtes). Monté dans
   la fenêtre, il les rechargera : c'est acceptable, mais il faut vérifier qu'aucun de ces chargements
   ne dépend d'un contexte que seule la page `/workflows` fournit.
3. Le brouillon de la CAMPAGNE doit survivre à l'ouverture de la fenêtre : on ne quitte pas la page,
   donc en principe oui, mais ça se vérifie plutôt que ça ne se suppose.

## L'essai réel qui clôt la feature

Créer un scénario depuis une campagne WhatsApp, le publier, **vérifier qu'il apparaît dans l'onglet
Scénario**, puis lancer la campagne sur un vrai destinataire et constater qu'il reçoit bien le modèle
d'ouverture. Et l'autre sens, qui est celui qui protège : tenter de publier depuis la fenêtre un
scénario qui commence par autre chose qu'un modèle, et constater le refus AVEC sa raison.
