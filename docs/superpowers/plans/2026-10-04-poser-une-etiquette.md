# Un seul geste « poser une étiquette »

Piste 6 du rapport d'architecture du 2026-10-02 (`todo.md`, section du 2026-10-03). Cadrage du 2026-10-04 en deux
rondes de questions fermées, décisions de Julien.

## Le problème

`src/agent/poser-tag.ts` (`creerPoserTagAgent`, `normaliserTag`) est le vrai module de la pose d'une étiquette sur UN
contact : nettoyer, poser, déclarer dans le référentiel de l'espace (Contenus > Étiquettes), publier « tag ajouté » si
elle est nouvelle. Mais les autres portes unitaires le réimplémentent, chacune avec ses écarts :

| Porte | Nettoie (`trim`, 64 car.) | Déclare dans le référentiel | Publie `tag_added` |
|---|---|---|---|
| Agent IA et agent de Meta (`poserTagDepuisAgent`, `src/workflow/wiring.ts`) | oui | oui | oui, si nouvelle |
| Bloc de scénario (`applyTag` + `emitTagAdded`, `src/workflow/wiring.ts`) | oui, recopié | oui | oui, par l'exécuteur, selon la politique du lancement |
| Widget (`poserEtiquette`, `src/widgets/arrivee.ts`) | non (étiquette interne) | oui | non |
| Outil MCP `tag_conversation` (`src/mcp/outils.ts`) | `trim` seul, **pas de borne** | **non** | non (voulu, dit dans sa description) |
| Fiche contact de la console (`PATCH`, `src/http/contacts.ts`, dans `applyEdits`) | oui, recopié | **non** | oui, sur les nouvelles |

Et `trim().slice(0, 64)` est recopié dans une dizaine de fichiers (import, API publique, action en masse, référentiel,
validation des blocs).

## Décisions (Julien, 2026-10-04)

- **Les portes unitaires passent par le module** : scénario, widget, outil MCP, ET la fiche contact de la console
  (en plus de l'agent, déjà dedans). Les chemins de MASSE (import, API publique, action en masse) gardent leur
  comportement et appellent seulement la fonction de nettoyage commune.
- **Le geste est le même partout** : nettoyer (espaces, 64 caractères, doublons et vides retirés), poser sur le
  contact, déclarer dans le référentiel (best-effort, une erreur de déclaration n'échoue jamais la pose).
- **Changements voulus** : l'outil MCP coupe à 64 caractères et déclare dans le référentiel ; la fiche contact déclare
  ses étiquettes dans le référentiel.
- **La publication `tag_added` reste au choix de chaque porte, sans changement** : agent oui, scénario selon la
  politique de son lancement, fiche oui (sur les nouvelles), widget non, MCP non. Elle se DEMANDE explicitement, elle
  n'est jamais un défaut du module (règle « l'émission est gouvernée par le chemin appelant »).
- **En production avant la démo du mercredi 7.** Un défaut en production se corrige sur place.

## Méthode de livraison

**Implémenteur + une relecture**, puis revue humaine du diff : la fiche contact et le bloc de scénario sont des chemins
que la production emprunte à chaque minute, la publication `tag_added` déclenche des scénarios donc des messages
facturés (une publication en trop envoie, une en moins se tait), et le câblage de l'API (`src/index.ts`) change.
L'essai réel qui clôt le lot est en fin de plan.

## Tâche unique

**Interface.** Le module quitte `src/agent/` (il n'est plus propre à l'agent) pour `src/crm/poser-etiquette.ts` :
- la fonction de nettoyage d'une étiquette et d'une liste d'étiquettes (bornes de la liste propres à chaque porte :
  10 pour l'outil MCP, 50 pour la fiche et la masse), importée par toutes les copies de `trim().slice(0, 64)` qui
  normalisent une ÉTIQUETTE (pas celles qui bornent autre chose, comme un nom de bloc) ;
- le geste de pose sur un contact (une ou plusieurs étiquettes), qui rend ce qui était réellement nouveau, et dont la
  publication est une option REQUISE de l'appelant (pas de valeur par défaut) ;
- de quoi déclarer et publier APRÈS une pose faite ailleurs, pour la fiche contact, dont la pose vit dans la
  transaction d'`applyEdits` (avec les champs et le consentement), qui ne bouge pas.
Les cinq portes l'appellent ; aucune ne recopie plus la règle. Le module est construit une fois par
`buildWorkflowRuntime` (qui a déjà `contactStore`, `tagStore` et la file) ou à côté, et l'API comme le worker
reçoivent le même.

**Ce qui ne bouge pas** : la publication de chaque porte (tableau ci-dessus), la borne de 10 étiquettes par appel de
l'outil MCP et sa réponse (`tags_ajoutes`, `deja_presents`), le retrait d'étiquette, `applyEdits` et sa transaction,
les chemins de masse (hors nettoyage partagé), la console.

**Tests attendus.**
- Le module exécuté directement : nettoyage (espaces, 65 caractères, doublons, vide), pose, déclaration best-effort
  (une erreur ne fait pas échouer), publication seulement si demandée ET nouvelle.
- Par porte, sur le vrai module : l'outil MCP coupe à 64 et déclare, sans publier ; la fiche déclare et publie les
  seules nouvelles ; le scénario garde sa publication par la politique du lancement (une campagne ne publie toujours
  pas) ; le widget déclare sans publier ; l'agent inchangé.
- Vérification dans les deux sens sur au moins : l'outil MCP qui publierait, la fiche qui ne déclarerait pas, la
  campagne qui publierait.
- Les gardes existantes « aucun chemin de masse ne publie » restent vertes.

**Contrôles** : `npm run typecheck`, `npm test` (code de sortie lu sans pipe), `npx tsx scripts/auto-attaque.mts`.
Jamais `test:integration` en local. Si `features.md` change, `tests/aide-proposer.test.ts` et l'empreinte de la fiche
d'aide qui cite la section.

## Rayon de souffle

- Les importeurs de `src/agent/poser-tag.ts` (`wiring.ts`, `src/mba/executer-maison.ts` en commentaire, leurs tests).
- `src/mcp/outils.ts` : sa description d'outil, lue par Claude, doit rester juste (classe sans rien envoyer).
- `features.md` (fiche contact, outil MCP, Contenus > Étiquettes) et la doc des outils MCP si elle décrit ce que fait
  `tag_conversation`.

## Déploiement

Aucune migration. API, `mba-worker` et `mba-worker-analyse`, après la CI verte lue job par job et la relecture sans
rouge. Préavis aux sessions voisines avant le `up`.

## Essai réel qui clôt le lot (Julien)

1. Claude, par le connecteur MCP, pose une étiquette neuve sur sa conversation ;
2. Julien ajoute une étiquette neuve sur sa fiche contact dans la console ;
3. Julien lance un scénario qui pose une étiquette.
Puis Contenus > Étiquettes : les trois y sont. Relu en base : les étiquettes sur la fiche, et les tirs d'automations
« étiquette ajoutée » (aucun pour l'outil MCP).
