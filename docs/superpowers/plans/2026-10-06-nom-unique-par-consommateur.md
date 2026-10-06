# Un agent ne voit jamais deux outils du même nom (2026-10-06)

Constat (relecture du 2026-10-05, lot « Modifier un appel de connecteur ») : une action d'agent (`agent_id` non nul)
et un connecteur de l'espace (`agent_id` nul) peuvent porter le même nom, parce que les deux index partiels de 0157
ne se recoupent pas. Si l'agent utilise aussi ce connecteur, `listActifs` lui expose deux fonctions du même nom. Le
nom est libre à la création d'une action (« Nom vu par le modèle ») et d'un appel de connecteur, et depuis le
2026-10-05 à sa modification.

## Mesures (2026-10-05)

- **Production**, en lecture seule (un client dédié, `begin read only`, aucun `SET`), à 21 h 18 UTC, base à 0210 :
  26 outils, 14 liaisons, 2 agents. Aucun consommateur ne voit deux outils du même nom, 0 couple du cas signalé,
  0 action renommée hors `mba_`, 0 action prêtée à un autre agent, 0 liaison dont l'espace diffère de celui de son
  outil. Le défaut est latent : la contrainte se pose sans reprise.
- **Gateway**, le corps de `chat-client.ts` envoyé depuis `mba-api` (clé maison, sans `tool_choice`) : un témoin à
  noms distincts, puis deux `verifier` dans les deux ordres, puis une demande de description.

  | Modèle (servi par) | Témoin | Deux `verifier` |
  |---|---|---|
  | `zai/glm-4.7-flash` (bedrock) | 200 | 400 « The tool verifier is already defined at toolConfig.tools.1. » |
  | `anthropic/claude-haiku-4.5` (anthropic) | 200 | 400 « tools: Tool names must be unique. » |
  | `google/gemini-2.5-flash` (vertex) | 200 | 400 « Duplicate function declaration found: verifier » |

  Aucun repli vers un autre fournisseur, et `chat-client.ts` lit ce 400 comme terminal : chaque tour de l'agent
  finirait en échec technique.

## Méthode de livraison

**En direct, sans agent, un lot clos par UNE relecture indépendante, puis un second lot court après le
déploiement.** Raison : trois fichiers de code et une migration ADDITIVE (réversible par `drop`), un invariant qui
se teste mécaniquement en intégration et se vérifie dans les deux sens en CI, sur étiquette jetable. Les invariants
invisibles sont nommés pour la relecture : les deux index partiels de 0157, l'ordre des verrous (la définition, puis
ses liaisons), et le mode de verrou d'un renommage, qui passe à `FOR UPDATE` dès que `name` entre dans une contrainte
unique non partielle.

**Essai réel qui clôt** : en production, juste après `migrate`, relire 0211 en base (colonne, clé étrangère en
`confupdtype = 'c'`, index unique, zéro liaison sans nom) ; puis, sur un agent de test, donner une action du nom
d'un appel de connecteur que l'agent utilise : refus 409 lisible, rien de créé, et `test_agent` répond toujours.

## Lot 1 : la contrainte, dans la base (avant le `up` de l'API)

- **0211 `nom_par_consommateur`** : `agent_tool_consommateurs.tool_name`, copie du nom tenue par une clé étrangère
  COMPOSITE `(tool_id, tool_name)` vers `agent_tools (id, name)`, `on update cascade` (sa cible : une contrainte
  unique `(id, name)` sur `agent_tools`), la reprise des liaisons existantes, et l'index unique
  `(tenant_id, consommateur, tool_name)`. Une clé étrangère et pas un déclencheur (le dépôt n'en a aucun, 0152 a fait
  le même choix), et pas une vérification lue puis écrite : deux écritures concurrentes la passeraient toutes les
  deux. NULLABLE, parce que l'ancien code n'écrit pas la colonne : il y survit, une liaison sans nom échappant à
  l'index le temps du déploiement.
- `src/agent/catalog.pg.ts` : les quatre insertions de liaison écrivent `tool_name` ; un renommage n'a rien à faire,
  la cascade suit. `surNomDejaPris` lit le nouvel index (portée `consommateur`) ; `rattacherConsommateur` le rend en
  refus `nom_pris`.
- `src/agent/catalog.ts` : `NomOutilDejaPris('consommateur')` et le refus `nom_pris`, en 409 par les routes
  existantes (agent IA et agent de Meta). Aucune route neuve, aucun écran touché.
- Tests d'intégration (`tests/integration/nom-par-consommateur.integration.test.ts`) : une action contre un appel
  utilisé, un appel contre une action, le renommage d'une action, le renommage d'un connecteur partagé refusé à cause
  d'UN AUTRE agent, le rattachement, la course (une action et un appel du même nom créés en même temps : un seul
  passe), la cascade (l'ancien nom se libère, le nouveau se prend), et le témoin (le même nom chez deux agents
  différents reste permis). Dans les deux sens : un commit enfant qui retire SEULEMENT l'index rougit sur ces cas.
- Doc : `documentation.md` (l'invariant), le commentaire de 0157 qui le disait « sans conséquence », `features.md`
  avec la fiche qui cite la section, le compteur de `CLAUDE.md`.
- **Ordre** : 0211 appliquée AVANT le `up` de l'API, qui écrit sa colonne. Seule l'API écrit des liaisons.

## Lot 2 : `tool_name` NOT NULL (après le `up`)

- 0212 : la reprise des liaisons écrites par l'ancien code pendant la fenêtre, puis `set not null`. Après le `up`,
  jamais avant : l'ancien code n'y survit pas. Poussée seule, une fois le lot 1 en production.
- Les fixtures d'intégration qui écrivent une liaison à la main (`insert into agent_tool_consommateurs` dans
  `tests/`) nomment l'outil.
