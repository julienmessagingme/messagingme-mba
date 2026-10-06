# RC5 : le bloc Condition à familles, les champs système, et le bloc « Aller à »

> Chantier « Retours console du 6 octobre » (RC1 à RC8), cadré avec Julien le 2026-10-06. Plan COURT : tâches,
> interfaces, tests attendus, ordre de déploiement, sans code. Deux livraisons indépendantes : A (Condition) puis B
> (Aller à).

**Décisions de Julien :**

| Question | Décision |
|---|---|
| Plusieurs familles vraies en même temps | La PREMIÈRE vraie, de haut en bas ; « Sinon » reste en bas |
| Forme d'une famille | Nommée (le nom s'affiche sur sa sortie), son propre jeu de conditions en ET ou en OU, 10 familles au plus |
| Champs à ajouter | Les champs système : dernier message reçu (date), langue détectée, pays de l'indicatif |
| Cible d'« Aller à » | N'importe quel bloc de n'importe quel scénario de l'espace |
| Choix de la cible | Un sélecteur (scénario puis bloc) OU un code collé ; sur chaque carte, un bouton qui copie le code du bloc |
| Les réponses déjà collectées | Elles suivent le contact |

## Faits qui cadrent le lot (lus sur `e5c338d7`)

- Le bloc Condition a DÉJÀ N clauses en ET/OU (`src/workflow/conditions.ts:31`, `web/components/ConditionBuilder.tsx`),
  teste déjà les étiquettes et tous les champs DÉCLARÉS ; deux sorties fixes `true` / `false`, choisies par
  `nextNodeByHandle` (`src/workflow/engine.ts:531`, `:786-796`).
- 🔴 **`true` et `false` sont codés en dur à six autres endroits** : `engine.ts:186-191` (`scanOpening`),
  `engine.ts:335-344` (`waitBeforeSessionMessage`), `web/lib/campaign-eligibility.ts:157-158` et `:326-331`,
  `web/lib/mesures-scenario.ts:258`, `web/lib/apercu-reponse.ts:86`. Une famille neuve que l'un d'eux ignore = une
  branche invisible à l'analyse de fenêtre, aux mesures ou à l'aperçu, sans aucune erreur.
- Le modèle de N sorties à codes STABLES existe : le bloc Agent IA (`sortie:<code>`, `WorkflowNode.tsx:396-420`,
  arêtes orphelines retirées par `wf-agent-change`, `WorkflowBuilder.tsx:308-317`). Le Message rapide, lui, numérote
  ses sorties par index et ne renumérote pas à la suppression : ne PAS le copier.
- Chaque bloc a un code stable `nod_<client>_<ULID>`, attribué par le serveur à l'enregistrement
  (`src/workflow/node-codes.ts`), affiché dans le panneau, résolu par `src/ids/resolve.ts:42-52`.
- **Un parcours ne porte aucune variable propre** (`workflow_runs`, 0023 et 0151) : les réponses d'une Question ou d'un
  Formulaire vivent sur la fiche du contact. « Les réponses suivent » est donc acquis sans rien transporter.
- `walk` ne repasse jamais par un bloc déjà visité dans le même enchaînement (`engine.ts:777`).

## Livraison A : la Condition

### A1. Le modèle et le moteur

**Fichiers :** `src/workflow/conditions.ts`, `src/workflow/engine.ts`, `src/workflow/executor.ts` (contexte), tests.

- `data.familles?: Array<{ code: string; nom: string; groupe: ConditionGroup }>` (1 à 10, codes stables générés par
  l'écran, uniques dans le bloc). **Compatibilité sans migration** : un bloc sans `familles` se lit comme une famille
  unique de code `true` portant son groupe actuel, et la sortie « Sinon » garde le code `false`. Les graphes en place ne
  bougent donc pas d'un octet, leurs arêtes non plus. Une famille ajoutée par l'écran prend la poignée
  `famille:<code>` ; la première garde `true`.
- Le moteur évalue les familles dans l'ordre et suit la poignée de la première vraie ; aucune vraie : `false`. Une
  famille vraie mais non reliée arrête le parcours, comme aujourd'hui (`engine.ts:793-794`).
- Une fonction unique `sortiesDeCondition(node): string[]` (serveur, et son miroir console) que les six endroits
  ci-dessus appellent au lieu de nommer `true` et `false`.

**Tests attendus :** un bloc ancien (sans `familles`) suit exactement les mêmes sorties qu'avant (vérifié dans les deux
sens) ; avec trois familles dont deux vraies, la première gagne ; aucune vraie : « Sinon » ; chacun des six endroits
voit une branche `famille:<code>` (un test par endroit, sur un graphe à trois familles).

### A2. Les champs système

- Trois clauses neuves dans `Clause` : `dernier_message_recu` (opérateurs de date : avant, après, plus vieux que, plus
  récent que, vide), `langue_detectee` (est, n'est pas, vide ; valeurs de `contacts.langue_detectee`), `pays`
  (est l'un de ; pays déduit du numéro par libphonenumber, déjà dans `src/crm/phone.ts`).
- `EvalContext` les reçoit chargés SEULEMENT si un bloc s'en sert, sur le modèle exact de `derniereSaisie`
  (`executor.ts:441-443`) : une requête de plus que les autres scénarios ne paient pas. Absent = valeur vide, jamais
  inventée.

**Tests attendus :** chaque clause, valeur présente et absente ; le contexte ne lit pas la date du dernier message
quand aucun bloc ne la demande (compte des requêtes).

### A3. L'écran

**Fichiers :** `web/components/ConditionBuilder.tsx`, `web/components/WorkflowConfigPanel.tsx`,
`web/components/WorkflowNode.tsx`, `web/components/WorkflowBuilder.tsx`, e2e.

- Le panneau liste les familles (nom éditable, ET/OU, clauses), « Ajouter une famille » jusqu'à 10, réordonner (haut /
  bas), supprimer ; « Sinon » est fixe en bas.
- La carte affiche une sortie par famille, à son nom, puis « Sinon » ; supprimer une famille retire SON arête et
  aucune autre (événement sur le modèle de `wf-agent-change`).
- Les trois champs système dans la liste des champs, sous un intitulé « Système ».

**Tests attendus :** e2e : créer trois familles, relier, publier, rouvrir, les retrouver reliées ; supprimer la
deuxième ne décroche pas la troisième ; `workflow-condition.spec.ts` existant reste vert.

## Livraison B : « Aller à » et le code des blocs

### B1. Le bouton « copier le code »

- Sur chaque carte (`WorkflowNode.tsx`, à côté du bouton lecture `node-test-<id>`), un bouton qui copie `data.code`.
  Grisé tant que le bloc n'a pas de code (bloc neuf non enregistré), avec l'infobulle « Enregistrez pour obtenir le
  code ».

### B2. Le bloc et son exécution

**Fichiers :** `src/workflow/graph.ts` (type `aller_a`), `src/workflow/engine.ts`, `src/workflow/executor.ts`,
`src/workflow/lancements.ts`, la validation de publication (`src/http/workflows.ts` et ce qu'il appelle), tests.

- `aller_a`, `data: { cible: string }` (un code `nod_…`), aucune sortie.
- **Même scénario** : le parcours continue sur le bloc cible, dans le même `walk` s'il n'y a pas eu de pause ; un
  retour sur un bloc déjà visité dans le même enchaînement est arrêté par la garde existante de `walk`, ce qui est la
  bonne réponse à une boucle sans pause.
- **Autre scénario** : le parcours courant est clos, et un parcours du scénario cible démarre SUR le bloc cible (même
  mécanique que le bloc de départ d'une automation ou la cible `node` de `/v1/sends`), type de lancement neuf
  `aller_a` (`reprise: 'oui'`, `publieLesEtiquettes: true`, `graphe: 'publie'`, `fenetre: 'selon_preuve'`). Pendant un
  test (lien de test, brouillon figé), une cible du même scénario se lit dans le brouillon ; une cible d'un autre
  scénario, dans sa version publiée.
- 🔴 **Garde anti-boucle entre scénarios** : A saute vers B qui saute vers A, sans pause. Un compteur de sauts voyage
  avec la demande de lancement ; au-delà de 20 sauts sans pause, le parcours s'arrête, la conversation va à l'équipe et
  le journal des échecs le dit. Si le démarrage passe par une file plutôt qu'un appel direct, le compteur est porté par
  le job.
- 🔴 **La garde de la fenêtre de 24 h suit le saut** : `waitBeforeSessionMessage` et la refus de publication « après
  une attente longue, seul un template » doivent voir qu'un `aller_a` placé après une attente mène à un message de
  session dans le scénario cible. Si suivre le graphe d'un autre scénario à la publication est trop large, la
  publication refuse un `aller_a` vers un message de session quand une attente longue le précède.
- Cible absente à l'exécution (bloc supprimé, scénario dépublié depuis) : le parcours s'arrête, une ligne au journal
  des échecs nomme le bloc. À la publication : une cible qui n'existe pas (dans le brouillon pour le même scénario,
  dans la version publiée pour un autre) est REFUSÉE avec le nom du bloc.

**Tests attendus :** saut dans le même scénario, réponse d'une Question puis retour au menu (une pause entre les deux :
pas d'arrêt) ; saut vers un autre scénario, l'ancien parcours clos et le nouveau démarré sur le bon bloc, avec les
champs de la fiche posés avant le saut lisibles par une condition après ; A vers B vers A sans pause : arrêt au 21e
saut, conversation à l'équipe ; cible supprimée : arrêt journalisé ; publication refusée sur une cible inexistante ;
la ligne `aller_a` de la table des lancements s'exécute sur le vrai exécuteur.

### B3. L'écran du bloc

- Palette : « Aller à » ; panneau : un sélecteur de scénario puis de bloc (par son libellé et son type), ou un champ
  « code du bloc » ; la carte affiche la cible (« → Menu principal, Question 2 »).
- `web/lib/nodeMeta.ts`, et chaque liste de types côté console (`mesures-scenario`, `apercu-reponse`,
  `campaign-eligibility`) traite le nouveau type.

## Documentation

`documentation.md` (familles, compatibilité des anciens blocs, `aller_a` et ses deux gardes), `features.md` (le
constructeur de scénarios, sa fiche d'aide « creer-un-scenario » relue et son empreinte dans le même commit,
`tests/aide-proposer.test.ts` vert avant le push), journal.

---

## Méthode de livraison

**Implémenteur par lot + revue humaine du diff**, une relecture indépendante à la fin de chaque livraison, parce que le
lot touche le moteur d'exécution de tous les scénarios en production et des invariants invisibles du compilateur : les
sorties `true` / `false` nommées à six endroits, la compatibilité des graphes déjà publiés, la garde de la fenêtre de
24 h, et une boucle entre scénarios que seul un compteur arrête.

**Ordre de déploiement :** pour chaque livraison, CI verte job par job, `compose build`, `up` de l'API et des deux
workers (aucune migration : tout vit dans le graphe jsonb), contrôle public ; la console part APRÈS (un bloc
`aller_a` publié avant que le moteur le connaisse serait traversé comme un type inconnu).

**L'essai réel qui clôt :** dans l'espace de Julien, (A) un scénario avec une Condition à trois familles (« pays est
France », « langue est anglais », « dernier message il y a plus de 7 jours ») testée depuis un vrai téléphone, qui sort
par la bonne famille ; (B) un menu qui renvoie par « Aller à » vers la question d'un autre scénario, joué de bout en
bout depuis le téléphone, et le code d'un bloc copié depuis sa carte puis collé dans le bloc.
