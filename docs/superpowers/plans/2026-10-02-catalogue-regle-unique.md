# Une seule règle pour « quel outil pour quel agent » : le catalogue répond lui-même

Candidat 1 de la revue d'architecture du 2026-10-02, cadré par Julien le soir même en quatre rondes de questions
fermées. **À lancer après la démo du mercredi 7 octobre** : la zone touchée est celle qu'on y montre.

**Ce qui fait mal.** La règle « peut-on donner cet outil à cet agent, et peut-il l'appeler ? » est écrite à cinq
endroits, en trois versions qui se contredisent :
- `rattacherConsommateur` (`src/agent/catalog.pg.ts`) contrôle « enregistré », pas « utilisable » ;
- `outilsMcpProposables` (`src/mba/vue-outils.ts`) exige « enregistré ET utilisable » ;
- `catalogueBranchable` (`src/http/agent-setup.ts`) se contente de « enregistré OU déjà branché » ;
- `web/components/AgentOutils.tsx` filtre seulement « enregistré », dans le navigateur ;
- `src/mba/outils-a-publier.ts` recalcule « utilisable » en ligne ;
- la route `POST …/mba-outils/mcp/:outilId` revérifie tout.

Sur ces fichiers, 41 commits en deux semaines, dont 46 % de correctifs. La migration 0199 en a touché 21, et
l'assistant oublié a été rattrapé deux heures plus tard (590ef8e5). Un outil MCP inutilisable est aujourd'hui écarté
pour l'agent de Meta mais proposé à un agent IA, qui le rattache puis voit un bandeau rouge.

## Décisions (Julien, 2026-10-02)

- **Périmètre : offrir, appeler, publier.** Hors périmètre : le retrait d'un outil et l'ordre des verrous de la base
  (quatre fichiers), et la réunion des méthodes en double du catalogue (`rattacher` / `rattacherConsommateur`,
  `activer` / `activerConsommateur`, `listToutes` / `listToutesConsommateur`), pour un lot plus tard.
- **Un outil mort n'est proposé nulle part**, ni à un agent IA, ni à l'assistant, ni à l'agent de Meta. Un outil
  déjà donné qui meurt ensuite reste visible avec son bandeau, pour qu'on le désactive ou le retire.
- **« Appelable » = exactement ce que les résolveurs acceptent** : la source de l'outil (serveur MCP ou connecteur
  HTTP) est active, l'outil n'est pas marqué non activable, il n'a pas disparu de son serveur. Un serveur éteint ou
  en brouillon fait sortir ses outils des listes, de ce que voit le modèle et de la publication chez Meta.
- **La règle s'écrit une fois, en SQL, dans le catalogue.** La porte d'écriture et une lecture « ce qu'on peut
  offrir à ce consommateur » utilisent les mêmes fragments. Les appelants ne filtrent plus rien.
- **La porte refuse aussi un outil inappelable, et dit pourquoi**, au lieu de rendre `false`.
- **Un outil activé qui meurt n'est plus montré au modèle d'un agent IA.** Il sort de la publication chez Meta à la
  prochaine publication. Si Meta l'appelle entre-temps, le relais garde son refus, inscrit au journal des appels.
- **La page d'un agent IA reçoit sa liste du serveur**, le navigateur ne calcule plus rien.
- **Décision à ne pas reproposer** : une action qui appartient à un agent IA reste rattachable ailleurs par un
  appel d'API direct. Aucune liste ne la propose ; seul un administrateur du même espace pourrait le faire.
- **Créer un outil d'agent IA depuis un connecteur encore en brouillon reste possible** : on monte un connecteur
  avant de l'allumer, et l'activation attend qu'il le soit. La règle gouverne les listes « ajouter » d'outils
  existants, la porte de rattachement et l'activation.
- **Côté agent de Meta, ajouter un connecteur HTTP en brouillon ou éteint est refusé AVANT de créer** (Julien,
  dernière ronde) : créer puis activer est un seul geste là-bas, et l'activation refusée laisserait un outil créé à
  moitié. L'écran dit « ce connecteur n'est pas actif, activez-le dans Tools > Connecteurs ».

## Les trois termes (glossaire de `documentation.md`, posé avec le lot)

- **Appelable** (un outil) : sa source est active, il n'est ni non activable ni disparu. Un outil maison (sans
  source) l'est toujours.
- **Offrable** (un outil, à un consommateur) : outil de la bibliothèque de l'espace (ni action d'un agent, ni outil
  de l'agent de Meta), enregistré s'il est MCP, appelable, et pas déjà rattaché à ce consommateur.
- **Publiable** (chez Meta) : donné à l'agent de Meta, activé, et appelable.

## Méthode de livraison

**Implémenteur (la session) puis UNE relecture indépendante du diff en fin de lot**, parce que le lot change trois
chemins que la production emprunte : la porte de rattachement des consentements, ce que voit le modèle d'un agent
IA, et ce qui part chez Meta. Il porte aussi des invariants invisibles (le verrou `for key share` et la condition
relue après lui, le relais qui doit garder sa lecture non filtrée). Une table de cas exécutée sur une vraie base en
CI tient la règle. Mais l'essai réel suivant clôt le lot, en production, sur l'espace MessagingMe :
- `tag_conversation` (notre serveur MCP, non activable car il prend une liste) n'apparaît dans aucune des trois
  listes « ajouter » : la page d'un agent IA, les propositions de l'assistant, « Appeler un outil MCP » de l'agent
  de Meta ;
- `get_contact` reste donné à l'agent de Meta et appelé avec succès, vérifié dans `agent_tool_calls`.

## Tâches

1. **Le catalogue porte la règle** (`src/agent/catalog.ts`, `src/agent/catalog.pg.ts`).
   - Deux fragments SQL nommés, `APPELABLE` et `OFFRABLE`, écrits une fois et lus partout ci-dessous. ⚠️ Vérifier
     d'abord que `agent_tools.source_id` d'un connecteur HTTP est bien la source de sa requête (`ajouterConnecteur`,
     et le résolveur HTTP lit `requete.sourceId`). Si les deux peuvent diverger, le fragment lit celle du résolveur.
   - `rattacherConsommateur` (et donc `rattacher`) rend
     `{ ok: true } | { refus: 'introuvable' | 'agent_introuvable' | 'reserve_agent_meta' | 'non_enregistre' | 'inappelable' | 'deja_rattache', detail?: string }`.
     Il garde `verrouillerAgentDuConsommateur` puis `for key share`, et la condition est relue après le verrou.
   - `activerConsommateur` refuse l'activation d'un outil non appelable, source éteinte comprise (aujourd'hui seules
     les deux marques MCP sont vérifiées). La désactivation reste toujours possible.
   - `ajouterConnecteurPourMba` refuse, sans rien écrire, une requête dont la source n'est pas active, avec la raison
     `source_inactive`. Le geste « créer puis activer » de l'agent de Meta (`creerConnecteur` dans `src/index.ts`)
     ne peut plus s'arrêter à moitié.
   - Nouvelle lecture `offrablesPour(tenantId, consommateur): Promise<OutilBibliotheque[]>`.
   - `listCatalogue`, `listToutesConsommateur` et `listToutes` portent sur chaque ligne
     `inappelable: null | { cause: 'non_activable' | 'disparu' | 'source_inactive'; detail?: string }`, calculé par
     le fragment.
   - Ce que voit le modèle : `listActifs` (agent IA) ne rend que les appelables. **`listActifsConsommateur` reste non
     filtré** pour le relais de l'agent de Meta (l'appel tardif de Meta doit être refusé par le résolveur ET
     journalisé), et `byName` aussi.
   - **Tests** : une table de cas dans `tests/integration/agent-catalog.integration.test.ts`. Chaque cas est joué à
     travers les quatre lectures et la porte : `offrablesPour` (agent IA et agent de Meta), le refus de `rattacher`,
     le refus d'`activerConsommateur`, `listActifs`, et `inappelable` sur la ligne. Les cas :
     - MCP enregistré et vivant ; MCP non enregistré ; MCP non activable ; MCP disparu ;
     - MCP d'une source en brouillon, puis éteinte ;
     - HTTP d'une source éteinte ;
     - outil maison ; outil de l'agent de Meta proposé à un agent IA ;
     - déjà rattaché ; outil d'un autre espace ; agent supprimé ;
     - connecteur HTTP de l'agent de Meta créé sur une source en brouillon : refusé, aucune ligne écrite.

     Le test existant du verrou `proposer` contre rattachement reste vert. Mutation à voir rouge en CI (étiquette
     jetable) : retirer `APPELABLE` du fragment `OFFRABLE`.

2. **L'agent de Meta lit la règle** (`src/mba/vue-outils.ts`, `src/mba/outils-a-publier.ts`,
   `src/http/mba-outils.ts`).
   - `outilsMcpProposables` devient `offrablesPour(consommateurMba(pn))` restreint aux outils MCP, plus la mise en
     forme.
   - `mcpInappelable` disparaît au profit d'`inappelable`.
   - La publication lit `inappelable === null` au lieu de son test en ligne : un outil HTTP d'une source éteinte n'est
     plus publié, et la ligne passe « À envoyer ».
   - La route `POST …/mba-outils/mcp/:outilId` ne revérifie plus rien : elle traduit le refus en code HTTP (404
     introuvable, 409 avec un message par raison). Elle garde son message actuel pour « non enregistré » (« cochez-le
     dans Tools > Connecteurs MCP »). La création d'un connecteur HTTP refusée pour `source_inactive` rend 409
     avec « ce connecteur n'est pas actif, activez-le dans Tools > Connecteurs ».
   - **Tests** : `tests/mba-vue-outils.test.ts`, `tests/mba-outils-a-publier.test.ts` (dont un HTTP d'une source
     éteinte), `tests/http-mba-outils.test.ts` (une raison, un code), `tests/mba-outils-parite.test.ts` reste vert.

3. **L'agent IA et l'assistant lisent la règle** (`src/http/agent-tools.ts`, `src/http/agent-setup.ts`,
   `src/index.ts`).
   - 🔴 Annoncer aux sessions voisines avant de toucher `src/index.ts`, commit en plomberie.
   - Nouvelle route `GET /tenants/:tenantId/agents/:agentId/outils/offrables`.
   - `PUT …/:outilId/rattachement` traduit le refus. Un refus ne s'affiche plus en 404 « agent ou outil
     introuvable » : c'est le jaune « un `false` de `rattacherConsommateur` est mal nommé » du `todo.md`, à retirer.
   - La carte `catalogue` de l'assistant (`catalogueBranchable`) vient de `offrablesPour(consommateurAgent(id))`
     plus les outils déjà branchés, sans filtre à elle.
   - **Tests** : `tests/agent-setup-outils.test.ts` (un MCP mort n'est plus proposé), le test des routes d'outils
     d'agent (une raison, un code), et le lint d'un agent (`etatPourLint` lit `listActifs` : un outil mort compte
     désormais comme absent, vérifier que l'avertissement reste lisible).

4. **La console de l'agent IA** (`web/lib/api-agent-tools.ts`, `web/components/AgentOutils.tsx`).
   - La section MCP affiche la liste de la route `offrables`, sans filtre.
   - Le bandeau d'un outil déjà donné lit `inappelable`, donc il dit aussi « le serveur de cet outil est éteint ».
   - **Tests** : `web/e2e/agents-outils.spec.ts`, avec une maquette qui rend une liste où l'écran ne filtre rien,
     et un bandeau « source éteinte ».

5. **Documentation**, dans le même lot :
   - `documentation.md` : les trois termes au glossaire, et l'invariant « la règle d'un outil s'écrit dans le
     catalogue, jamais chez un appelant » ;
   - `features.md` : les outils d'un serveur éteint sortent des listes et de l'agent. Les fiches d'aide qui citent
     la section suivent, avec leur empreinte et `aide-proposer` avant de pousser ;
   - `todo.md` : retirer les deux jaunes soldés (le `false` mal nommé, le filtre d'`AgentOutils` sans test).

## Ordre de mise en ligne

- **Aucune migration.**
- **Deux poussées**, parce qu'un écran qui appelle une route neuve casse dès le push :
  1. le commit des tâches 1, 2, 3 et 5. CI lue job par job, relecture, puis `up` de l'API ;
  2. le commit de la tâche 4 (console), poussé APRÈS le déploiement. Avant lui, l'ancienne console garde son filtre
     et l'ancienne route : rien ne casse entre les deux.
- **Puis l'essai réel** décrit dans la méthode de livraison.
