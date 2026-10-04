# Un point d'entrée par type de lancement de scénario

Piste 4 du rapport d'architecture du 2026-10-02 (`todo.md`, section du 2026-10-03), qui est aussi le candidat 6 de
« approfondir la racine » (2026-09-27). Cadrage du 2026-10-04 en deux rondes de questions fermées, décisions de Julien.

## Le problème

Sept lancements de scénario choisissent chacun, dans une flèche de `src/index.ts` ou de `src/worker.ts`, les
réglages de `WorkflowExecutor` : reprendre le fil (`ignoreHumanControl`, `saufOperateur`), publier les étiquettes
posées (`emitEvents`), jouer le brouillon figé (`figerLeGraphe`), lever la garde de fenêtre (`startInWindow`,
`startFromNode`). Ces choix ne sont gardés que par des tests qui lisent le TEXTE des câblages
(`tests/campagne-controle-humain.test.ts`, `tests/automation-chaine-reprend-la-main.test.ts` et voisins), et l'un
d'eux (`saufOperateur`, leads publicitaires du 2026-09-27) a déjà atterri dans la racine.

Les sept, avec leur comportement d'aujourd'hui, qui ne change pas :

| Type | Câblage actuel | Reprise du fil | Publie les étiquettes | Graphe | Fenêtre 24 h |
|---|---|---|---|---|---|
| Inbox | `lancerScenarioPourContact` (`src/index.ts`) | oui, même un opérateur | oui | publié | levée si l'appelant l'a prouvée ouverte, sinon gardée |
| Agent de Meta, lancer un scénario | `creerGestesEnvoi.lancerScenario` -> même flèche | oui | oui | publié | idem |
| Agent de Meta, envoyer un bloc | `envoyerDepuisBloc` (`src/index.ts`) | oui | non | celui de l'appelant (réduit au bloc) | levée (l'appelant l'a vérifiée) |
| Automatisme ordinaire (mot-clé, tag, date, analyse) | `automationRunnerDeps.startWorkflow` (`src/worker.ts`) | non : bloqué par un fil tenu (`mayAct`) | oui | publié | levée sur un bloc de départ ; sinon selon la preuve |
| Automatisme de chaîne | idem | oui, même un opérateur | oui | publié | idem |
| Automatisme de publicité, de widget | idem | oui, sauf un opérateur | oui | publié | idem |
| Lien de test | `startTestRun` (`src/worker.ts`) | oui | oui | brouillon, figé | levée |
| Campagne à scénario | `moteur.startWorkflow` (`src/worker.ts`) | oui | non | publié | gardée |
| Campagne à un bloc (`/v1/sends`) | `moteur.startWorkflowFromNode` | oui | non | publié | levée (vérifiée à la création de l'envoi) |

## Décisions (Julien, 2026-10-04)

- **Les sept, réglages fermés** : tout lancement passe par le module ; plus aucun câblage ne pose
  `ignoreHumanControl`, `saufOperateur`, `emitEvents`, `figerLeGraphe` ni ne choisit `start`/`startInWindow`/
  `startFromNode`. Un lancement ajouté plus tard choisit un type.
- **À l'identique** : chaque ligne du tableau reste vraie. Le défaut connu de `reprendrePourLApp({ saufOperateur })`
  (l'état d'attente `app_human` d'une fin de parcours pris pour un opérateur) reste au backlog.
- **Les lectures de texte sur ces choix sont remplacées par une table** qui exécute le vrai module.
- **En production avant la démo du mercredi 7**, viser lundi 5. En cas de défaut en production avant la démo, on
  corrige sur place (pas de retrait du lot).
- Pas couplé au point d'envoi unique (candidat 2 du rapport du 2026-09-14), comme pour la piste des envois de bloc.

## Méthode de livraison

**Implémenteur + une relecture**, puis revue humaine du diff : chaque scénario lancé en production passe par ce
chemin, il touche les trois câblages partagés (`src/index.ts`, `src/worker.ts`, `src/workflow/wiring.ts`), et ses
invariants ne se voient pas au compilateur (un mot-clé ne prend jamais le fil d'un opérateur, aucun chemin de masse
ne publie, seul le test joue le brouillon). L'essai réel qui clôt le lot est en fin de plan.

## Tâche unique

**Interface.** Un module `src/workflow/lancements.ts` :
- un type FERMÉ `TypeDeLancement` (une valeur par ligne du tableau, l'automatisme en trois valeurs : ordinaire,
  chaîne, publicité ou widget, ou quatre si la lecture du code le justifie) ;
- une table `POLITIQUE_DE_LANCEMENT` exportée, une ligne par type : reprise (`non` / `oui` / `sauf_operateur`),
  publication des étiquettes, graphe (publié / fourni par l'appelant / brouillon figé), fenêtre (gardée / selon la
  preuve de l'appelant / levée) ;
- une entrée de lancement dont la demande est typée PAR TYPE (une union discriminée : `firstTemplateParams`
  n'existe que pour la campagne, le graphe fourni que pour l'envoi d'un bloc, etc.), qui lit le scénario, trouve la
  fiche (`findIdByWaId`), choisit le bloc de départ et rend `StartOutcome` (ou `null` pour un scénario inconnu là où
  l'appelant l'attend aujourd'hui).

Le module est construit par `buildWorkflowRuntime` (`src/workflow/wiring.ts`, qui a déjà `workflowStore` et
`contactStore`) et rendu à côté de `executor` : l'API et le worker ont donc le même. Les sept câblages l'appellent.
`WorkflowExecutor` n'accepte plus les réglages bruts de l'extérieur : ses démarrages prennent la politique du type
(ou le type), et `runFrom` en dérive ses options. Les tests de l'exécuteur qui appelaient `start` sans réglage
choisissent un type (le plus proche de ce qu'ils exercent), sans perdre leur cas.

`reprendLaMain` et `epargneLOperateur` (`src/automation/match.ts`) deviennent une seule fonction qui rend le type de
lancement d'une automation ; `AutomationRunnerDeps.startWorkflow` reçoit ce type au lieu de deux booléens. Le widget
(`demarrageParLeRunner`) suit sans changement de comportement.

**Ce qui ne bouge pas** : `runFrom` et ses gardes (opérateur, bloc absent, fenêtre, numéro délié), la reprise du fil
par le routage publicitaire AVANT les déclencheurs (`routagePub.reprendreLeFil`), `envoyerBlocDepuisAgent` (agent IA,
qui ne lance pas de parcours), `src/mba/gestes-envoi.ts` (attente de fin de tour, fil rendu sur échec), les
signatures des dépendances du moteur de campagne (`startWorkflow`, `startWorkflowFromNode`), la console.

**Tests attendus.**
- Une table qui exécute le VRAI module sur un vrai `WorkflowExecutor` (dépendances en mémoire, comme les tests de
  l'exécuteur existants), un cas par type : la reprise demandée (et avec quelle option) ou la garde `mayAct`, une
  étiquette publiée ou non, le graphe joué et figé ou non, la garde de fenêtre levée ou non. Plus un cas qui vérifie
  que `buildWorkflowRuntime` rend un `lancements` construit sur son propre exécuteur.
- Les tests qui lisent le texte des câblages SUR CES CHOIX sont retirés, SANS perdre aucun de leurs cas
  (corollaire (b)) : la liste « ancien cas -> cas de la table » va dans le rapport. Restent les tests de texte qui
  gardent autre chose (constante des propriétaires recopiée en SQL, texte de l'écran).
- Les gardes « aucun chemin de masse ne publie » (`tests/contacts.test.ts`, `tests/workflow-executor.test.ts`)
  restent vertes ou suivent.
- Vérification dans les deux sens sur au moins : l'automatisme ordinaire qui ne prend pas le fil d'un opérateur, la
  publicité qui épargne l'opérateur, la campagne qui ne publie pas, le test qui fige le brouillon.

**Contrôles** : `npm run typecheck`, `npm test` (code de sortie lu sans pipe), `npx tsx scripts/auto-attaque.mts`,
`npx tsc -p tsconfig.prod.json --noEmit` (symboles morts). Jamais `test:integration` en local.

## Rayon de souffle

- Tous les appelants de `start`, `startInWindow`, `startFromNode` (sept câblages, dix-sept fichiers de tests).
- Les lecteurs de `reprendLaMain`, `epargneLOperateur` (`src/webhooks/inbound.ts`, `src/automation/store.pg.ts`,
  `src/widgets/arrivee.ts`, leurs tests) et les commentaires qui les citent.
- `documentation.md` s'il décrit les réglages de démarrage de l'exécuteur ; `features.md` ne bouge pas (rien de
  visible).

## Déploiement

Aucune migration. API, `mba-worker` et `mba-worker-analyse` ensemble (le module vit dans les deux processus), après
la CI verte lue job par job et la relecture sans rouge. Contrôle public des deux portes après le `up`.

## Essai réel qui clôt le lot (Julien)

Quatre gestes, chacun relu en base ensuite (parcours créé, détenteur du fil, étiquettes, graphe figé ou non) :
1. lancer un scénario depuis l'Inbox ;
2. ouvrir un lien de test ;
3. envoyer un mot-clé qui déclenche un automatisme ;
4. lancer une campagne vers son seul numéro.
