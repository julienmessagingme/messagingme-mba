# L'écouteur de pg-boss se retente au démarrage (lot 2 du bilan, 2026-10-14)

pg-boss rouvre seul un écouteur LISTEN établi qui tombe, mais pas un écouteur dont la PREMIÈRE ouverture échoue : le
worker sondait alors seul, à la cadence de base et sans aucun réveil, jusqu'à son redémarrage.

## Méthode de livraison

**En direct, puis une relecture indépendante du diff**, parce que le changement tient dans une classe
(`PgBossQueue.start`) et se vérifie par un faux `PgBoss`, mais qu'il arrête et relance pg-boss au démarrage de chaque
worker : la relecture regarde surtout que rien ne soit enregistré sur la file avant (`src/worker.ts`).

**La vérification réelle qui clôt** : après le déploiement, en lecture seule, une connexion `LISTEN` du worker visible
dans `pg_stat_activity`, et aucun avertissement d'écouteur dans ses journaux. Le chemin d'échec, lui, ne se provoque pas
en production.

## Tâches

1. `src/queue/pgboss.ts` : `ATTENTES_ECOUTE_MS` (1 s, 5 s, 15 s), `estEchecEcoute` (l'avertissement du `catch` de
   `Notifier.start`, le seul qui porte `error`), et `start` qui relance pg-boss tant que l'écouteur échoue, en taisant
   les échecs suivis d'une tentative (une alerte pour un écouteur rouvert serait fausse).
2. Les cinq textes qui disaient « pg-boss retombe sur la cadence de base si l'écouteur meurt » : faux pour un écouteur
   établi, qui compte encore comme actif pendant sa reprise.

## Tests attendus

`tests/queue-ecoute-demarrage.test.ts` : un échec puis un succès (une relance, aucune alerte) ; des échecs partout
(trois relances, une alerte) ; sans écoute, aucune relance ; le tri des avertissements. Vérifiés par trois mutations.

## Ordre de déploiement

Aucune migration. CI lue job par job, puis les deux workers (`mba-worker`, `mba-worker-analyse`) ; l'API n'écoute pas.
