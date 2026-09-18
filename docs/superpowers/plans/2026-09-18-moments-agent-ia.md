# Les MOMENTS d'un agent IA : plan en cinq lots (2026-09-18)

> Ce plan applique les décisions du grilling du 2026-09-18, arbitrées par Julien, question par question.
> Il ne rouvre aucune d'entre elles : ce qui est tranché est écrit ici comme un fait, et ce qui reste
> ouvert est signalé comme tel.

## Ce qui a déclenché ce chantier

Julien a mené un entretien de construction jusqu'au bout, l'a validé, et n'a rien retrouvé dans les onglets.
Trois défauts ont été corrigés le jour même (`9ba34f21`, `b1899cbd`, `36a961bb`). Restait sa phrase :
« il faut vraiment revoir cette logique outils ». Ce plan est ce qui en sort.

## L'idée, en une phrase

**Tout est un moment** : « quand X arrive, l'agent fait Y ». Un moment est ce que le modèle voit, et sa
description EST le déclencheur. **Y est soit une ACTION** (interne, nous l'avons écrite et nous en
garantissons le comportement) **soit un OUTIL** (externe, le client l'a déclaré et nous n'en savons rien).

Les sept « outils maison » d'aujourd'hui ne sont donc pas des outils : ce sont des actions, mal nommées, et
elles n'ont rien à faire dans `Tools >`, qui est le setup de ce qui pointe vers l'extérieur.

## Ce qui existe DÉJÀ, et qu'il ne faut pas reconstruire

Mesuré avant d'écrire ce plan. C'est ce qui rend le chantier plus petit qu'il n'en a l'air.

| Besoin | Ce qui existe | Où |
|---|---|---|
| Les trois familles de réponse | `ACTIONS` = `scenario`, `outil_api`, `outil_mcp`, `humain`, `continuer`, `autre` | `src/agent/setup/couverture.ts:39` |
| La collecte des moments | le point `bascules`, moment par moment, avec action ET moyen | `couverture.ts` |
| Un outil externe rend-il de l'info ? | `agent_tools.nature` (`pousse` / `integre`), migration 0150 | `src/agent/resolvers/http.ts` |
| Le filtre de ce que l'agent lit d'une réponse | `agent_tools.output_paths`, par outil depuis 0150 | idem |
| Un scénario qui donne la main à un agent | le bloc de type `agent`, plus `sortirDuBlocAgent` | `src/workflow/executor.ts:1491` |
| Envoyer un bloc sans bouger le parcours | l'action `envoyer_bloc` | `executor.ts:1502` |
| Les horaires d'ouverture et le prochain créneau | `prochaineOuverture`, qui traverse un week-end et gère les changements d'heure | `src/lib/heures-ouvrees.ts:39` |
| Trois modes de transfert selon l'heure | `mba_handoff_mode` (`always` / `business_hours` / `never`), migration 0067 | `tenant_settings` |
| Le consentement humain par consommateur | `agent_tool_consommateurs`, migration 0127 | `src/agent/catalog.ts` |

🔴 **CE QUI N'EXISTE NULLE PART, et c'est le seul vrai manque technique** : déléguer une branche de scénario
ET récupérer la main. `envoyer_bloc` ne bouge pas le parcours, donc ne peut pas déclencher une branche qui
ATTEND ; `terminer` le fait avancer et ne revient jamais.

⚠️ **ET LES BASCULES NE VONT NULLE PART.** Hors de l'entretien, personne ne les lit : elles servent
uniquement à fabriquer les questions suivantes. C'est le plus gros « offert-et-inerte » du dépôt, et c'est
lui qui rend ce chantier plus petit qu'une refonte : la collecte est déjà juste, il manque sa destination.

---

## Lot 1 : les horaires du transfert

**Ce qu'il répare, et il tourne AUJOURD'HUI** : un agent transfère à 3 h du matin en laissant croire qu'un
conseiller arrive. Le commentaire de la migration 0067 avait déjà rencontré le problème pour le MBA :
« `never` s'accompagne toujours d'un message qui ne promet aucun conseiller ».

- un réglage d'ESPACE, trois valeurs, les MÊMES que le MBA : `always`, `business_hours`, `never`. La
  disponibilité est une propriété de l'ÉQUIPE, pas du robot ni de la situation.
- hors créneau, **la conversation arrive quand même dans « À traiter »**. C'est la seule façon que la
  promesse soit vraie : « on revient vers vous » sans ligne de travail derrière est un mensonge poli.
- l'agent **formule lui-même** la phrase, dans son ton, et on lui donne **la date que `prochaineOuverture`
  calcule**. 🔴 Un samedi soir, elle rend « lundi 9 h » et pas « demain » : c'est une fonction testée, quand
  un modèle qui fait de l'arithmétique de dates par-dessus un week-end est exactement le point qui casse.

⚠️ **AUCUNE PHRASE N'EST STOCKÉE DANS CE LOT**, et c'est ce qui le rend petit : la phrase par moment
n'arrive qu'avec les moments (lot 2). Ici, le modèle écrit et nous fournissons le fait.

⚠️ Une migration, dont **le numéro se lit dans `CLAUDE.md` § Déploiement et nulle part ailleurs** : trois
documents l'ont recopié, les trois étaient faux. Elle AJOUTE une colonne que le code écrit, donc elle passe
AVANT le déploiement.

**Ce qui le clôt** : un vrai contact qui écrit hors horaires sur le numéro de production, et qui lit une
phrase citant le bon jour de réouverture, pendant que la conversation apparaît dans « À traiter ».

---

## Lot 2 : le modèle des moments

Le cœur. Tout le reste s'y accroche, et c'est pour ça qu'il passe avant la parenthèse : construire la
délégation d'abord reviendrait à fabriquer une action que ce lot déplacerait ensuite.

- un moment porte un DÉCLENCHEUR (ce que le modèle voit), UNE réponse principale (une action ou un outil
  externe), et des GESTES déterministes que nous exécutons nous-mêmes.
- 🔴 **Les gestes sont INDÉPENDANTS de la réussite de la réponse** : ils marquent que la SITUATION s'est
  produite, pas que l'appel a réussi, ce qui permet de rattraper à la main. ⚠️ Conséquence à tenir dans les
  libellés par défaut : « rendez-vous demandé », JAMAIS « rendez-vous pris ».
- **transférer** et **chercher dans la base** sont posés d'office, actifs. On règle leurs mots, pas leur
  existence. La phrase de transfert devient un réglage du moment.
- **choisir un connecteur dans un moment vaut consentement.** Le consentement reste humain et explicite, il
  change d'endroit : un geste au lieu de trois.
- `Tools >` ne garde que les connecteurs API et MCP. Les actions en sortent.

🔴 **LA REPRISE EST LA MOITIÉ DU LOT, ET LA PLUS DANGEREUSE.** Les outils aujourd'hui branchés mais
**INACTIFS restent éteints**, traduits en moments désactivés. Le comportement de chaque agent en production
doit être identique au jour de la bascule. ⚠️ L'état intermédiaire qu'on supprime doit donc survivre pour
les anciens : un drapeau qui n'existe que pour l'histoire.

⚠️ **Ce lot rend caduc le correctif « Brancher » de `b1899cbd` pour les actions**, qui ne servira plus que
pour les connecteurs. C'est voulu, et c'est la bonne nouvelle : le 409 disparaît par le haut.

**Ce qui le clôt** : un agent de production ouvert avant et après, dont la liste de moments dit exactement
ce que sa liste d'outils disait, et une conversation réelle qui se comporte à l'identique.

---

## Lot 3 : la parenthèse de scénario

Le seul manque technique réel, et le plus risqué : il touche l'exécuteur de parcours et la session d'agent,
donc le chemin que chaque message entrant emprunte.

- l'agent délègue une branche, le parcours QUITTE le bloc agent et déroule la branche, y compris si elle
  attend le contact.
- un node **« retour vers l'agent IA »** rend la main **à l'appelant**, pas à un agent nommé : une adresse de
  retour est mémorisée sur le parcours. C'est ce qui permet qu'une même branche serve plusieurs agents sans
  être recopiée. ⚠️ À ne pas confondre avec le bloc `agent` existant, qui veut dire l'inverse (« ici l'agent
  prend la main »).
- la **session reste vivante** : l'agent reprend avec son contexte.
- 🔴 **LE TOUR N'EST PAS SUSPENDU.** `boucler` (`src/agent/brain.gateway.ts:184`) consomme le résultat d'un
  outil dans le même tour, en mémoire ; rien ne sait attendre entre deux messages. L'action rend donc la main
  tout de suite, et l'information de retour démarre un NOUVEAU tour dans la MÊME session.
- le node de retour **porte une information composée par le client** (texte fixe ou champ). Elle est
  **invisible** : pour le modèle seul. ⚠️ Revers assumé avec Julien : un opérateur qui reprend le fil verra un
  agent qui sait des choses sans voir d'où. C'est une ligne à rendre visible le jour où ça gêne, pas une
  décision à refaire.
- une branche dont un chemin ne revient jamais n'est ni refusée ni signalée. Le délai d'inactivité de
  l'agent, qui existe, sert de filet.

**Ce qui le clôt** : une vraie conversation où l'agent délègue une prise de rendez-vous, où le contact répond
au formulaire, et où l'agent reprend la parole en sachant ce qui s'est passé.

---

## Lot 4 : l'entretien écrit les moments

- chaque bascule collectée devient une ligne du diff de fin d'entretien, gardée ou jetée comme le reste.
- 🔴 **SANS MOYEN, PAS DE MOMENT.** Quand le client décrit une capacité dont le connecteur n'existe pas,
  l'assistant DIT ce qu'il reste à câbler au lieu de créer une ligne inerte. C'est le quatrième
  « offert-et-inerte » qu'on refuse d'ouvrir après en avoir fermé trois le même jour.
- une fois l'entretien fini, l'assistant peut MODIFIER un moment sur demande. La consigne d'évolution
  l'autorise déjà : elle n'interdit que les propositions non sollicitées.

**Ce qui le clôt** : un entretien mené de bout en bout sur un agent neuf, dont le diff final porte les
moments, et dont l'écran les montre après application.

---

## Lot 5 : le Meta Business Agent passe au même modèle

Il a ses moments comme un agent IA, et `Tools >` lui sert de bibliothèque de connecteurs comme aux autres.

⚠️ **À MESURER AVANT D'ÉCRIRE UNE LIGNE** : ce que le MBA porte réellement en production aujourd'hui. C'est
l'agent de META, dont nous ne pilotons pas le comportement de la même façon, et il faut vérifier que ce que
nous appelons un moment a un sens de son côté. Ce lot est le seul dont le contenu exact reste ouvert.

---

## Méthode de livraison

Le choix se pose lot par lot, parce que les cinq n'ont ni le même rayon de souffle ni le même type de
critère. La raison de chaque choix est écrite en dessous, et aucune méthode ne remplace **l'essai réel** qui
clôt chaque lot, nommé dans sa section : personne n'a cliqué sur l'écran tant que ça n'a pas tourné sur de
vraies données.

### Lot 1, horaires : en direct, avec revue humaine du diff

**En direct**, parce que le lot est petit, qu'il ne touche aucun invariant invisible, et que son seul risque
est une phrase dite au contact. Sa vérification est mécanique (la date rendue par `prochaineOuverture` un
samedi soir) sauf sur un point qui ne l'est pas, la phrase elle-même, et c'est justement ce qu'une revue de
diff regarde bien. L'essai réel qui le clôt : un vrai contact hors horaires sur le numéro de production.

### Lot 2, modèle des moments : implémenteur par lot, revue humaine du diff à chaque passe

**Implémenteur**, car ce lot déplace des données de production et touche le consentement, c'est-à-dire la
garde qui décide si un modèle peut invoquer un outil. La reprise « les inactifs restent éteints » est un
invariant qu'aucun test d'interface ne verra, pour la raison que le dépôt a déjà payée : un test unitaire
monte un faux câblage, et le faux bouge avec le code. Chaque passe se relit sur le diff. L'essai réel : un
agent de production ouvert avant et après, dont le comportement ne bouge pas d'un pouce.

### Lot 3, parenthèse de scénario : implémenteur par lot, revue humaine du diff

**Implémenteur** aussi, et pour une raison plus forte que le lot précédent : c'est le chemin que chaque
message entrant emprunte. Un parcours qui part dans une branche sans savoir revenir laisse une conversation
morte, et le symptôme n'apparaît qu'en production, chez un vrai contact. L'essai réel : une vraie
conversation déléguée de bout en bout, formulaire compris, avec l'agent qui reprend la parole.

### Lot 4, entretien : feature-loop

**feature-loop**, parce que les critères y sont mécaniquement testables (une bascule collectée produit une
ligne de diff, un moyen absent n'en produit aucune) et que le rayon de souffle est faible : la route de
l'entretien n'écrit rien de l'agent, elle propose. C'est le cas d'école de la boucle plan, exécute, vérifie,
reviewer. L'essai réel : un entretien complet mené à la main sur un agent neuf.

### Lot 5, MBA : à décider après la mesure

Pas de méthode arrêtée, **parce que** le contenu du lot dépend de ce que la mesure montrera. Choisir
maintenant serait choisir la méthode qu'on a déjà suivie ailleurs, ce que ce fichier existe pour empêcher.
L'essai réel sera nommé en même temps que le contenu.

### Ce qu'aucun lot ne fera

🔴 **Pas de workflow multi-agents.** Aucun de ces lots n'est un balayage mécanique répétitif à grande
échelle, et la règle du dépôt est qu'un workflow ne se lance pas sans un oui explicite de Julien.

---

## Les invariants à ne pas casser

Listés ici parce qu'ils ne sont visibles dans aucun des fichiers qu'on va toucher.

1. **Le consentement reste humain et explicite.** Il change d'endroit (choisir un connecteur dans un moment),
   il ne disparaît pas. La spécification MCP l'exige avant qu'un modèle invoque un outil, et notre agent n'a
   aucun humain au runtime.
2. **La conversation de construction n'écrit rien de l'agent.** Elle propose, le client applique par les
   mêmes routes que le formulaire, avec le même verrou de version.
3. **Toute borne appliquée à une sortie de modèle est annoncée dans le schéma qu'on lui envoie**, et la
   parité se dérive (`tests/agent-setup-bornes.test.ts`), elle ne se relit pas.
4. **Une migration qui AJOUTE une colonne écrite par le code passe AVANT le déploiement ; une qui RETIRE une
   colonne encore lue passe APRÈS.** La question se pose à chaque fois, et se décide sur « l'ancien code
   survit-il à ce changement ? ».
5. **Le compteur de migrations se lit dans `CLAUDE.md`, jamais dans ce plan.**
6. **Un index partiel est un contrat avec une requête précise.** Élargir un `where` sans élargir le prédicat
   ne produit aucune erreur, juste un balayage.

---

# État d'exécution, au 2026-09-18 au soir

> Écrit ici et pas dans `wip.md` : une autre session y travaille, et ce plan est le seul document que ce
> chantier possède en propre. Ce qui suit doit suffire à reprendre sans la conversation.

## Livré, poussé, CI verte job par job

| Lot | Commits | Ce qu'il fait |
|---|---|---|
| **1. Horaires du transfert** | `4850d234`, `fe4fc12a` | Réglage d'espace à trois valeurs (les mêmes que le MBA). Hors créneau, la conversation arrive quand même dans « À traiter » et l'agent annonce la réouverture, avec la date que NOUS calculons. Il ne garde la parole à l'escalade **que** si l'équipe est fermée. |
| **2, passe 1. Propriété** | `a7d16f65`, `71c37564` | `agent_id` revient : une ACTION appartient à l'agent, un CONNECTEUR à l'espace. Deux index partiels complémentaires, un CHECK, une cascade. Le 409 disparaît par le haut. |
| **2, passe 2. Gestes** | `04b89fa6`, `0cd0e2b5` | Un moment porte une réponse principale et des gestes que NOUS exécutons, **avant l'appel** (donc indépendants de sa réussite) et **après les gardes** (donc jamais sur un appel refusé). |
| **2, passe 3. Écran** | `68083c6e`, `12119894`, `20f0f28d` | L'éditeur de gestes, qui DIT qu'ils partent même si l'appel échoue. Le bouton « Brancher » retiré (sa cause a disparu). Les 7 définitions orphelines supprimées, CHECK strict posé. |

## 🔴 L'ORDRE DE DÉPLOIEMENT, ET IL N'EST PAS UNIFORME

Quatre migrations écrites, **aucune appliquée**. Le compteur fait foi dans `CLAUDE.md`, jamais ici.

- **0156, 0157, 0158 : AVANT le déploiement.** Additives et permissives, l'ancien code y survit.
- **0159 : APRÈS le déploiement, et elle seule.** Son CHECK strict est violé par l'ancien `ajouter`, qui
  écrit `agent_id` à null : l'appliquer avant ferait échouer toute création d'outil pendant la fenêtre.
  C'est la leçon de 0152, appliquée dans l'autre sens.

⚠️ **0159 est la seule opération IRRÉVERSIBLE du chantier.** Sa requête de re-mesure est écrite dans le
fichier : la jouer avant de l'appliquer, pour revérifier que les orphelines sont toujours à zéro consommateur
(mesuré le 2026-09-18 : 7 définitions, 0 consommateur, 0 active, 1 agent en brouillon).

## Ce qui RESTE de ce plan

1. **Les gestes dans la trace du bac à sable.** Il n'en exécute aucun, à raison (un essai ne doit pas taguer
   un vrai contact), mais il promet « exactement ce que l'agent fera » : tant qu'il ne les AFFICHE pas, il
   ment par omission, exactement comme `connecteurSimule` avant la migration 0150. Dette assumée, pas oubli.
2. **Lot 3, la parenthèse de scénario.** Rien de commencé. Le seul manque technique réel, et le plus risqué.
3. **Lot 4, l'entretien écrit les moments.** Rien de commencé.
4. **Lot 5, le MBA.** À mesurer avant d'écrire quoi que ce soit.

## Trois choses mesurées qui ont changé le plan en cours de route

- **La reprise de données du lot 2 était vide.** 7 définitions, 0 consommateur : rien à dédoubler, rien à
  éteindre. La partie annoncée comme « la plus dangereuse » n'existait pas.
- **Aucun outil n'était attaché au Meta Business Agent.** Le préfixe `mba_` que Julien voyait est le NOM PAR
  DÉFAUT de `outils-maison.ts`, pas une appartenance. Le modèle est poreux, son espace ne l'était pas.
- **L'agent est MUET à l'escalade** (son texte est jeté délibérément) : ce que le contact lit vient de la
  branche `humain` du scénario, un bloc statique. La prémisse du lot 1 était donc partiellement fausse.

## Ce que la CI a repris, cinq fois

Toujours le même motif, et il vaut pour la suite : **les tests d'intégration ne tournent qu'en CI**, un
`npm test` vert en local ne prouve rien de la moitié base. Les cinq : une fixture de réglages non typée, un
test qui affirmait l'invariant que la passe 1 renversait, deux sondes qui passaient pour la mauvaise raison
(le bon code `23514`, levé par une autre contrainte), une lecture par `byName` qui filtre sur `actif`, et une
assertion de cascade dont la vérité avait changé. **Chaque fois le CAS a été conservé, jamais supprimé.**
