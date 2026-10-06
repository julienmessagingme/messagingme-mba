# RC4 : les outils de l'agent IA présentés comme ceux du MBA, et « Lancer un scénario »

> Chantier « Retours console du 6 octobre » (RC1 à RC8), cadré avec Julien le 2026-10-06. Plan COURT : tâches,
> interfaces, tests attendus, ordre de déploiement, sans code. Suit RC2 (l'outil « Marquer urgent » existe).

**But :** l'onglet Outils d'un agent IA prend la forme de celui de l'agent de Meta (une grille « Quel outil ajouter ? »
à six cartes, un formulaire, une liste des outils posés), avec une section « Toujours là » pour les outils propres à
l'agent IA ; et un outil neuf, « Lancer un scénario ».

**Décisions de Julien :**

| Question | Décision |
|---|---|
| Les outils propres à l'agent IA (terminer, passer à l'équipe, connaissance, lire la fiche, marquer urgent) | Une section « Toujours là » séparée, un interrupteur chacun, au-dessus de la grille |
| Les six cartes | Poser un tag, Enregistrer une information, Envoyer un bloc, Lancer un scénario, Appeler un connecteur API, Appeler un outil MCP |
| « Lancer un scénario » | Un scénario FIXÉ par l'admin, un par outil ; l'agent se retire et le scénario prend la conversation |
| Tag, information, bloc | ALIGNÉS sur le MBA : la cible est fixée par l'admin (un tag, un champ, un bloc par outil). Pour l'information, le champ est fixé et la valeur vient du modèle (bornée à une liste si l'admin en donne une, comme `champ_fixe`) |

## Mesure qui autorise l'alignement

Lu en production le 2026-10-06 (lecture seule, `begin read only` sur un client dédié) : **zéro outil `poser_tag`,
`ecrire_variable` ou `envoyer_bloc`** chez les agents IA (26 outils au total : 7 de base, 4 de l'agent de Meta, 16
connecteurs). Aligner ne demande donc aucune reprise. 🔴 **À remesurer en tête de lot** : si une ligne est apparue
depuis, on s'arrête et on demande à Julien.

## Contraintes globales

- Le modèle d'outil vient du catalogue, jamais de l'appelant (`src/agent/reglages.ts:20-45`). La cible vit dans
  `binding`, validée par un schéma `.strict()` en `safeParse`, comme `cibleMaisonSchema` (`src/mba/outils-maison.ts`).
- Les handlers de l'agent IA restent DISJOINTS de ceux du MBA (disjonction tenue par `tests/mba-outils-maison.test.ts`) :
  on calque le schéma, on ne partage pas les noms.
- 🔴 **Toute borne appliquée à une sortie de modèle est annoncée dans le schéma qu'on lui envoie** (CLAUDE.md,
  `tests/agent-setup-bornes.test.ts`) : l'assistant de configuration propose des outils, il suit l'alignement.
- Aucun tiret cadratin ni demi-cadratin. `grep` des libellés dans `web/e2e` avant de les changer.

## T1. Le catalogue et les cibles (serveur)

**Fichiers :** `src/agent/outils-maison.ts`, `src/agent/reglages.ts`, `src/agent/resolvers/mba.ts`,
`src/agent/resolvers/simulation.ts`, `src/agent/brain.gateway.ts` (ce qu'il lit des paramètres), `src/http/agents.ts`
(pose et modification), tests.

- `cibleOutilAgentSchema` (discriminée sur `handler`, `.strict()`) : `poser_tag { tag }`, `ecrire_variable { champ,
  valeurs[] }`, `envoyer_bloc { workflowId, code }`, `lancer_scenario { workflowId }`. Les trois premiers perdent leur
  paramètre `enum` choisi par le modèle : `poser_tag` et `envoyer_bloc` n'en ont plus aucun, `ecrire_variable` garde
  seulement `valeur` (énumérée si `valeurs` n'est pas vide).
- La pose d'un de ces quatre outils EXIGE sa cible (400 lisible sinon) ; une cible qui vise un bloc ou un scénario d'un
  autre espace est refusée (404). Plusieurs outils du même handler sur un agent sont permis (un par tag, un par bloc),
  avec des noms distincts (contrainte 0211).
- Le résolveur lit la cible dans `binding`, jamais dans les arguments du modèle ; une cible illisible refuse l'appel
  (et le journalise) au lieu d'agir.

**Tests attendus :** chaque handler agit sur SA cible quels que soient les arguments du modèle (un modèle qui passe
`tag: "autre"` pose quand même le tag fixé) ; une cible manquante ou étrangère est refusée à la pose ; le bac à sable
simule sans écrire ; le miroir `HANDLERS` et la disjonction avec le MBA passent.

## T2. « Lancer un scénario »

**Fichiers :** `src/workflow/lancements.ts`, `src/agent/resolvers/mba.ts`, le tour (`src/agent/run-turn.ts`) pour la
fin de session, `tests/workflow-lancements.test.ts`, tests.

- Type de lancement `agent_ia_scenario`, politique calquée sur `agent_meta_scenario` (l. 107) : `reprise: 'oui'`,
  `publieLesEtiquettes: true`, `graphe: 'publie'`, `fenetre: 'selon_preuve'`.
- L'outil est TERMINAL : il lance le scénario publié de sa cible, puis la session de l'agent se clôt (motif
  `scenario_lance`) sans nouvel appel au modèle. 🔴 Le parcours qui portait l'agent (bloc Agent IA d'un scénario, ou
  parcours du répondeur) est clos par le démarrage (`executor.ts:1139-1165`) : vérifier qu'aucune sortie du bloc agent
  ne repart derrière, et qu'aucune fin de parcours ne rend la main à l'agent de Meta entre les deux.
- Un scénario non publié, supprimé, ou un contact désabonné : l'outil rend un refus lisible au modèle, la session
  continue.

**Tests attendus :** la ligne `agent_ia_scenario` de la table s'exécute sur le vrai exécuteur ; depuis un bloc Agent IA
d'un scénario A, l'outil lance B et A est clos sans suivre aucune sortie ; depuis le répondeur, même chose ; la
session est close et le modèle n'est pas rappelé ; un scénario dépublié est refusé sans clore la session.

## T3. Les dépendants qui supposaient l'ancienne forme

Relevés par `grep` sur `e5c338d7` : `src/agent/setup/proposition.ts` (l'assistant propose des outils),
`src/mcp/outils-agent.ts` (`set_agent_tools` ; `OUTILS_SURS` n'en contient aucun des quatre, à confirmer),
`src/workflow/executor.ts` et `src/worker.ts` (câblage d'`envoyer_bloc`), `web/lib/agent-outils.ts`,
`web/lib/signes-outils.ts` (le dessin `scenario` existe déjà, `signeDuHandler` gagne la case), et leurs tests
(`agent-setup-proposition`, `agent-setup-conversation`, `http-agent-setup`, `agent-resolver-*`, `agent-run-turn`,
`web-agent-outils`, `web-agent-setup-lignes`, `integration/agent-catalog`).

- L'assistant de configuration propose la cible en même temps que l'outil (schéma annoncé = schéma appliqué), et
  `assainirProposition` ramène une cible absente ou invalide en retirant l'outil proposé, jamais en posant un outil sans
  cible.

## T4. L'écran

**Fichiers :** `web/components/AgentOutils.tsx`, `web/components/AgentConnecteurs.tsx`, la section MCP de l'agent,
les composants de `web/components/mba-outils/` (`ChoixTypeOutil`, `CiblesOutil`) rendus réutilisables par une prop qui
dit le consommateur, `web/lib/mba-outils.ts` (textes), e2e.

- **« Toujours là »** en tête : terminer, passer à l'équipe, chercher dans la connaissance, lire la fiche, marquer
  urgent ; un interrupteur chacun (allumer = poser l'outil s'il manque, puis l'activer ; éteindre = le désactiver). Les
  réglages propres (nom vu par le modèle, quand l'appeler) restent derrière un « Régler ».
- **« Quel outil ajouter ? »** : la grille des six cartes de `ChoixTypeOutil`, avec ses cartes grisées et leur lien
  quand il n'y a rien à choisir (aucun connecteur, aucun champ, aucun serveur MCP). Les textes ne parlent pas de
  « l'agent de Meta ».
- **Le formulaire** : la cible (`CiblesOutil`), le titre, le nom technique, quand l'appeler, quand ne pas l'appeler ; et
  ce que l'agent IA a en plus du MBA, gardé : la case d'autonomie d'un outil irréversible (`envoyer_bloc`), les gestes
  « Et en plus, faire ceci », « Voir ce que le modèle voit ».
- **La liste des outils posés** au format des lignes du MBA (`LigneOutil`) : titre et cible, badge de type, état
  (actif / inactif à la place de « chez Meta »), Modifier, Supprimer. Les connecteurs API et les outils MCP y entrent
  comme les autres ; les sections « Vos systèmes » et « Vos serveurs MCP » disparaissent en tant que sections.
- ⚠️ L'écran du MBA ne doit pas changer : ses e2e passent tels quels.

**Tests attendus :** e2e de l'agent : poser un tag fixe par la grille, le voir dans la liste ; poser « Lancer un
scénario » ; allumer et éteindre « Marquer urgent » dans « Toujours là » ; un connecteur API ajouté par sa carte
apparaît dans la liste. Les e2e existants de l'agent (`agents-connecteurs.spec.ts` et voisins) adaptés, ceux du MBA
inchangés et verts.

## T5. Documentation

`features.md` (les outils de l'agent IA, avec la fiche d'aide « construire-un-agent-ia » relue et son empreinte dans le
même commit, `tests/aide-proposer.test.ts` vert avant le push), `documentation.md` (les cibles fixes, le lancement
`agent_ia_scenario`), journal.

---

## Méthode de livraison

**Implémenteur par lot + revue humaine du diff**, une relecture indépendante en fin de lot, parce que le lot change ce
qu'un modèle peut faire au contact (une sortie de modèle qui agit sur une fiche ou lance un parcours) et que les
dépendants sont nombreux et invisibles du compilateur : l'assistant qui propose des outils, le bac à sable, la
disjonction des handlers, la clôture du parcours qui portait l'agent.

**Ordre de déploiement :** livraison A (serveur, T1 à T3) : CI verte job par job, `compose build`, `up` de l'API et
des deux workers (aucune migration : la cible vit dans le `binding` jsonb), contrôle public. Livraison B (console, T4)
poussée APRÈS le `up` de A.

**L'essai réel qui clôt :** sur l'agent IA d'un espace de test, poser par la grille un outil « Lancer un scénario »
vers un scénario publié et un outil « Poser un tag » fixe ; depuis un vrai téléphone, amener l'agent à les appeler ;
voir le tag sur la fiche, le scénario partir, et l'agent se taire ensuite.
