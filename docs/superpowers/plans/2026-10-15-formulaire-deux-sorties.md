# Le bloc « Formulaire » a deux sorties : « Formulaire rempli » et « Toute autre réponse »

Demandé par Julien le 2026-10-15. Aujourd'hui le bloc n'a qu'une sortie, et TOUTE réponse du contact la suit : le
formulaire rempli, mais aussi un « bonjour » écrit à la place.

## Décisions (Julien, 2026-10-15)

- **« Formulaire rempli » non relié : le formulaire passe par « Toute autre réponse »**, comme un bouton non relié d'un
  message rapide (règle de `advance` : la poignée, sinon l'arête libre, sinon le parcours s'arrête). Les 6 blocs en
  production (tous dans la SANDBOX, sonde en lecture seule du 2026-10-15, aucun parcours en attente dessus) gardent
  leur flèche, qui devient « Toute autre réponse » et continue de tout recevoir. Aucune migration de données.
- **N'importe quel formulaire renvoyé compte** (`nfm_reply`), pas seulement celui du bloc : marche aussi pour un
  formulaire créé dans WhatsApp Manager, qui n'a pas notre `_ref`.

## Tâches

**Serveur (commit 1, déployé AVANT la console)**
1. `web/lib/partage/sorties-formulaire.ts` : `SORTIE_FORMULAIRE_REMPLI = 'rempli'`, lu par le moteur et le canevas.
2. `src/webhooks/inbound.ts` : un `nfm_reply` porte `formulaire: true` sur le message entrant.
3. `src/webhooks/workflow-advance.ts` : le transmet à `advance` (`entrant.formulaire`).
4. `src/workflow/executor.ts` (`advance`) : sur un bloc `flow`, la poignée est `rempli` pour un formulaire, aucune
   sinon (un ancien bouton ne choisit pas de branche ici) ; puis l'arête libre ; puis l'arrêt. La mesure d'un
   formulaire porte la poignée `rempli` au lieu des 2 000 caractères du JSON de réponse.
5. `src/workflow/engine.ts` (`walk`) : un bloc formulaire NON configuré traversé (agent de Meta allumé) suit l'arête
   libre, pas la première arête venue.

**Console (commit 2, poussé APRÈS le déploiement de l'API et du worker)**
6. `WorkflowNode.tsx` : deux sorties sur le bloc, « Formulaire rempli » (`rempli`) et « Toute autre réponse » (libre).
7. `web/lib/mesures-scenario.ts` : la poignée `rempli` s'affiche « Formulaire rempli » dans les statistiques.
8. Doc : `features.md` (bloc Formulaire) et la fiche d'aide qui cite la section, avec son empreinte ;
   `documentation.md` (la règle de routage) ; le commentaire du format dans `web/lib/api/scenarios.ts`.

## Tests attendus

- Moteur : formulaire rempli -> `rempli` ; texte -> arête libre ; formulaire avec seulement l'arête libre (montage
  d'avant) -> arête libre ; seulement `rempli` relié et le contact écrit -> arrêt ; ancien bouton tapé -> arête libre.
- Réception : un `nfm_reply` porte `formulaire`, un bouton ou un texte non.
- Console : e2e du bloc (deux sorties, la flèche d'un ancien montage sur « Toute autre réponse ») ; libellé des
  statistiques. Chaque test de non-régression vérifié dans les deux sens.

## Ordre de déploiement

Commit serveur, CI lue job par job, `up` de `mba-api` et `mba-worker` (aucune migration), puis le commit console :
pousser l'écran avant que le worker connaisse `rempli` ferait relier une sortie que le moteur ignore.

## Méthode de livraison

**En direct, avec une relecture indépendante en fin de lot**, parce que le changement est petit (une poignée de plus)
mais passe par `advance`, le chemin de CHAQUE réponse d'un contact en production : une erreur de routage enverrait
des contacts dans la mauvaise branche sans bruit. Pas de `feature-loop` : l'écran demande un œil.

**Essai réel qui clôt la feature** : sur le téléphone de Julien, un scénario de la SANDBOX avec un bloc Formulaire
relié des deux côtés ; remplir le formulaire mène à la branche « Formulaire rempli », écrire « bonjour » à la place
mène à « Toute autre réponse ».
