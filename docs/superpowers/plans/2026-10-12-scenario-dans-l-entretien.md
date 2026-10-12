# Le scénario d'un moment, choisi dans l'entretien et posé par « Enregistrer »

Décision de Julien du 2026-10-12, sur l'essai de l'agent SMATIS : il a dit « quand le client veut faire un devis,
lancer le scénario SMATIS Devis (flow) », et rien n'est arrivé dans l'onglet Outils. Deux défauts : la question du
moyen ne listait pas ses scénarios, et l'assistant n'a pas le droit de poser un outil qui vise quelque chose (RC4).
Décision : la question liste les scénarios publiés, le serveur rapproche la réponse d'un VRAI scénario, et le diff
porte une ligne « Outil : lancer « … » » qu'« Enregistrer » pose, éteinte, par la route du bouton « Ajouter un outil ».
La cible vient de la liste réelle, jamais du modèle : c'est l'assouplissement consenti de RC4.

## Tâches

1. **Serveur, l'entretien connaît les scénarios.** `ContexteConstruction.scenarios` (id, nom) depuis
   `listResume` filtré sur les scénarios en ligne (graphe publié non vide), câblé dans `agentSetup.etatCourant`.
   L'inventaire les porte ; la question du moyen d'un moment « scénario » les liste par leur nom.
2. **Serveur, le moyen se capte et se résout.** Au tour qui demande le moyen du moment N, si le modèle ne l'a pas
   rendu, le message du client devient le moyen. `scenariosAPoser` rapproche chaque moment « scénario » de son
   scénario par le nom (égalité normalisée, ou un seul nom contenu) et écarte ceux qu'un outil `lancer_scenario`
   de l'agent vise déjà. La réponse de la route porte `proposition.scenarios` (workflowId, nom, moment) et une ligne
   de diff `scenario.<workflowId>` par scénario, dont le texte est la description de l'outil (« Quand … »).
3. **Console, « Enregistrer » pose l'outil.** `PropositionConstruction.scenarios` ; `restreindreProposition` ne
   garde que les lignes gardées, avec le texte corrigé ; `appliquerProposition` appelle `ajouterOutil(handler
   'lancer_scenario', { cible: { workflowId }, name })` puis `patchOutil(description)`, nom tiré du scénario,
   suffixé si pris, et saute un scénario déjà visé.
4. **Bloc « Pour finir ».** Un moment dont le scénario est posé dit d'allumer l'outil (il naît éteint) ; un moment
   sans scénario reconnu dit la marche « Ajouter un outil > Lancer un scénario ».

## Interfaces

- `ContexteConstruction.scenarios?: Array<{ id: string; nom: string }>` ; `Inventaire.scenarios: string[]`.
- `scenariosAPoser(bascules, scenarios, outilsVises): Array<{ workflowId: string; nom: string; moment: string }>`.
- Réponse de `POST /setup` : `proposition.scenarios` à côté de `fiche`, `outils`, `connecteurs`.
- `EntreeFin.scenariosPoses?: Array<{ nom: string; moment: string }>`.

## Tests attendus

Serveur : la question liste les scénarios ; le moyen capté depuis le message ; le rapprochement (exact, contenu
unique, ambigu écarté, déjà visé écarté) ; la route rend la ligne de diff et `proposition.scenarios` à la fin de
l'entretien seulement. Console : `restreindreProposition` (ligne jetée, texte corrigé) et `appliquerProposition`
(pose avec cible et nom, nom pris suffixé, scénario déjà visé sauté). Le bloc de fin pour les deux cas.

## Ordre de déploiement

Un commit. La console est publiée par Vercel au push et ne lit que des champs optionnels : avant le `up` de l'API,
la proposition n'a pas de `scenarios`, rien ne casse. Puis `up` de l'API et des deux workers. Aucune migration.

## Méthode de livraison

**En direct, puis une relecture indépendante en fin de lot** : le chemin écrit un outil qui envoie des messages
facturés (« Lancer un scénario »), donc une seconde lecture du diff avant le déploiement ; les critères sont
vérifiables par test, et l'outil naît éteint, ce qui borne le rayon de souffle.

**L'essai réel qui clôt le lot** : Julien recommence l'entretien de SMATIS ; la question du devis liste « SMATIS
Devis (flow) », il le choisit, le diff montre la ligne, « Enregistrer » la pose, et l'outil apparaît éteint dans
l'onglet Outils, visant ce scénario. Il coche l'autonomie, l'allume, et un essai dans l'onglet Tester lance le devis.
