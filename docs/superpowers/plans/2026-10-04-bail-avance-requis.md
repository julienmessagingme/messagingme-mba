# Le bail anti-double-envoi de l'exécuteur, requis

Piste 8 du rapport d'architecture du 2026-10-02 (`todo.md`). Cadrage du 2026-10-04, une ronde de questions fermées.

## Le problème

`reserverAvance`, `prolongerAvance` et `libererAvance` (le bail qui empêche deux messages simultanés du même contact
de faire partir deux fois la suite d'un parcours) sont optionnelles dans `WorkflowExecutorDeps['runs']`, « pour les
fixtures ». Un câblage qui les oublierait compilerait, et l'exécuteur avancerait sans réservation.

## Décisions (Julien, 2026-10-04)

- Seulement ces trois fonctions ; le reste des dépendances optionnelles (candidat 6 du rapport du 2026-09-14) attend.
- Aucun changement de comportement en production : `PgWorkflowRunStore` les porte toutes.
- Pas de déploiement dédié : le lot part au prochain déploiement.

## Méthode de livraison

**En direct, puis une relecture** : un contrat, une version inerte pour les tests, et un test de type ; le chemin est
emprunté par la production mais rien n'y change, et le compilateur vérifie tous les câblages. Pas d'essai réel
dédié : la production empruntait déjà ces trois fonctions ; le premier parcours qui avance après le prochain
déploiement suffit, et les journaux disent s'il a été refusé.

## Tâche unique

- `src/workflow/executor.ts` : les trois deviennent requises ; `advance` réserve toujours, bat toujours, libère
  toujours (les branches « absente » disparaissent).
- `tests/executeur-inerte.ts` : `avecGardesDEtatInertes` ajoute un bail inerte (réservation accordée, battement
  « toujours à nous », libération sans effet), qui reproduit l'ancienne absence.
- `tests/workflow-bail-requis.test.ts` : une directive `@ts-expect-error` par fonction ; si l'une redevient
  optionnelle, le typecheck échoue.

**Contrôles** : `npm run typecheck`, `npm test`, vérification de la garde de type dans les deux sens.
