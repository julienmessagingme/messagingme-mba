# Modifier un appel de connecteur posé sur un agent (2026-10-05)

Constat, sur l'agent « Groupama santé animale » (espace Groupama PJ) : la ligne d'un appel de connecteur porte
Activer, Désactiver et Retirer depuis 362dde63, mais aucun Modifier. Julien : « je peux pas le modifier, y a pas
un bouton pour le modifier ? ». La seule voie était Retirer puis recréer.

## Méthode de livraison

**En direct, sans agent, en deux lots à la suite, chacun clos par UNE relecture indépendante.** Raison : quelques
fichiers, réversible sans migration, critères vérifiables par des tests (e2e pour la console, intégration pour le
store), et un seul invariant, petit et testable : un appel qui pousse ne lit aucun champ, un appel qui intègre en
lit au moins un. Le lot 1 ne touche que la console (la route `PATCH` existe en production) ; le lot 2 porte
l'invariant, avec sa propre relecture.

**Essai réel qui clôt** : Julien, sur l'agent « Groupama santé animale », clique Modifier, change un mot,
enregistre, rouvre. Au lot 2, la nature se change sur un appel de TEST, enregistrée puis remise. ⚠️ Pas sur
`obtenir_tarif` de l'agent en service : un « pousse » enregistré efface par conception ses trois chemins
`tarifs.*`, et l'agent ne lirait plus le tarif jusqu'à ce qu'on les recoche (relecture du lot 2).

## Lot 1 : le bouton Modifier (console seule)

- `web/components/AgentConnecteurs.tsx` : « Modifier » sur chaque ligne (`connecteur-modifier-<id>`). Un seul
  formulaire ouvert à la fois, création OU modification. C'est le formulaire de création, pré-rempli ; Enregistrer
  appelle `patchOutil` avec les quatre mots. Un refus (409 « porte déjà ce nom ») s'affiche dans le formulaire,
  sous le nom, et la saisie reste. La nature et les champs lus sont montrés, pas modifiables.
- `web/lib/api-agent-tools.ts` : `OutilAgent` déclare `nature` et `outputPaths`, que le serveur envoie depuis 0150.
- e2e (`web/e2e/agents-connecteurs.spec.ts`) : Modifier envoie le `PATCH` des quatre mots et rien d'autre ; un 409
  se lit dans le formulaire, saisie gardée. Les `data-testid` existants restent.
- `features.md` (Agent IA, « Vos propres systèmes ») ; fiche `construire-un-agent-ia` relue, empreinte à jour,
  `tests/aide-proposer.test.ts` vert avant de pousser.
- Interfaces : aucune route neuve. Déploiement : le push publie la console (Vercel), aucune API.

## Lot 2 : la nature et les champs lus (serveur, puis console)

- `PatchOutil` (`src/agent/catalog.ts`) et `patchSchema` (`src/http/agent-tools.ts`) acceptent `nature` et
  `outputPaths`. La paire voyage ensemble : `outputPaths` sans `nature` refusé, `integre` exige au moins un champ,
  `pousse` avec des champs refusé, et refus sur un outil qui n'est pas un connecteur API. Mêmes messages qu'à la
  création. La cohérence se juge sur la requête, sans lecture préalable de l'outil.
- `patchConsommateur` (`src/agent/catalog.pg.ts`) : `nature` en `coalesce` ; `output_paths` vidé sur `pousse`,
  remplacé sur `integre`, inchangé sans nature. L'agent de Meta (`modifierConnecteur`) n'envoie ni l'un ni l'autre.
- Tests : la route (`tests/http-agent-tools.test.ts`) et le store en intégration
  (`tests/integration/outil-nature.integration.test.ts`).
- Ordre : commit serveur poussé, CI lue job par job, API déployée (ce qui part relu d'abord avec `git log`, d'autres
  sessions poussant du code serveur), contrôle public des deux portes ; PUIS le commit console (nature et champs
  modifiables dans le même formulaire, e2e, `features.md`, fiche).
- ⚠️ `patchSchema` est un `z.object` : il ignore un champ inconnu sans erreur. Une console poussée avant l'API
  enverrait `nature`, recevrait 200, et rien ne changerait.
