# L'index de la remise à l'agent de Meta (migration 0242, 2026-10-17)

Le banc des accusés du 2026-10-17 a montré que chaque accusé de Meta relit toute la table des conversations
(`consommerReleaseMba`, colonne `release_mba_apres_message` sans index) : la file des statuts plafonne vers 16 numéros
à plein débit, et passe à au moins 24 avec un index partiel. Accord de Julien du même jour. L'audit des requêtes
réellement jouées en production (planifiées avec leurs vraies valeurs, en lecture seule) n'a trouvé aucun autre trou
sur un chemin chaud.

## Méthode de livraison

**Implémenteur, puis une relecture indépendante du diff**, parce que la migration touche une table de production et
le chemin de chaque accusé, même si elle est additive : la relecture regarde que l'index serve bien la requête et que
sa construction ne bloque rien. **La vérification réelle qui clôt** : après la migration en production, l'index relu
en base (`indisvalid`, prédicat) et le plan de l'instruction du code relu en lecture seule.

## Tâches

1. `db/migrations/0242_conversations_index_remise_mba.sql` : `create index concurrently if not exists` partiel, hors
   transaction, une seule instruction.
2. `src/inbox/store.pg.ts` : l'instruction de `consommerReleaseMba` exportée (`CONSOMMER_REMISE_MBA_SQL`), sans rien y
   changer, pour que le test planifie la vraie.

## Tests attendus

- `tests/migration-0242.test.ts` : hors transaction, une instruction rejouable, sans accent grave.
- `tests/integration/index-remise-mba.integration.test.ts` (CI) : l'index existe, valide, avec son prédicat ; l'instruction
  du code passe par lui sur 2 000 conversations.

## Ordre de déploiement

Additive et sans lecteur : l'ordre est libre. La séquence habituelle de `DEPLOY.md` : construire l'image, vérifier dans
l'image que seule 0242 attend, `pg_stat_activity` lu, `migrate`, l'index relu en base, puis `up` de l'API et des
workers.
