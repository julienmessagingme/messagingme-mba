# L'autonomie d'un outil tombe quand sa requête le rend irréversible (2026-10-14)

Orange du backlog (relecture de `099fd6c1`, 2026-10-05). Un changement de méthode monte le risque des outils d'une
requête (`PgRequeteStore.patch`), mais pas leur autonomie : un POST coché autonome, passé en DELETE, devenait une
action irréversible que l'agent IA exécutait seul, au nom d'un oui donné pour une écriture.

## Méthode de livraison

**En direct, puis une relecture indépendante du diff**, parce que le changement tient en une instruction dans une
transaction existante, mais qu'il touche la garde d'une action irréversible : la relecture regarde l'ordre des verrous
et les autres chemins qui montent un risque.

**La vérification réelle qui clôt** : le test d'intégration, sur le Postgres de la CI, qui coche l'autonomie par le
vrai catalogue, passe la requête en DELETE et relit `agent_tool_consommateurs`. Aucun essai en production : aucun
espace n'a aujourd'hui de connecteur autonome à basculer, et en créer un pour l'essai écrirait chez un client.

## Tâches

1. `src/agent/requetes.pg.ts` : dans la transaction de `patch`, quand le plancher est `irreversible`, `autonome =
   false` pour les consommateurs des outils montés (`autonome_par` gardé, comme le rafraîchissement MCP).
2. `documentation.md` (l'invariant du risque dérivé), `features.md` (la case qui se décoche), `todo.md`.

## Tests attendus

- `tests/requete-methode-autonomie.test.ts` : ce qui PART vers la base (la mise à jour dans la transaction, seulement
  vers `irreversible`, seulement s'il y a des outils montés), vérifié par deux mutations.
- `tests/integration/requete-methode-risque.integration.test.ts` : l'autonomie relue en base après un POST passé en
  DELETE, et gardée sur un outil déjà irréversible.

## Ordre de déploiement

Aucune migration. CI lue job par job (le job `integration` porte le test en base), puis l'API (les routes qui
modifient une requête vivent dans l'API).
