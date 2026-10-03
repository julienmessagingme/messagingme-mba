# La clé d'idempotence coincée par un arrêt brutal (2026-10-03)

Trouvé par le second banc le jour même (`docs/JOURNAL-TECHNIQUE.md`, 2026-10-03) : une copie de l'API tuée
entre la POSE d'une clé d'`api_idempotency` et son SCELLEMENT laisse la ligne « en cours » (`send_id` nul), et
chaque rejeu rend 409 pendant 24 h, sans que rien ne la libère. Trois arrêts brutaux sur cinq. Julien : « corrige
la clé coincée maintenant ».

## Méthode de livraison

**Implémenteur par lot + revue indépendante du DIFF**, parce que `POST /v1/sends` est un chemin que la production
emprunte, irréversible une fois les messages partis, et qu'il porte un invariant invisible : une clé désigne UN
envoi, jamais deux. Une seule relecture indépendante, en fin de lot. L'essai réel qui clôt ce plan : le second
banc remonté, l'épreuve `arret` brutale rejouée jusqu'à couper un envoi entre pose et scellement, et la clé
coupée qui aboutit (201) une fois la borne passée, sans second envoi.

## La conception : un verrou, donc un bail ET un jeton de garde

La règle du dépôt sur l'unicité d'exécution (`src/campaign/run-lock.ts`) s'applique : une clé « en cours » EST un
verrou sur l'envoi. Il lui manquait deux des trois pièces.
- **Le bail** : une clé en cours depuis plus de `DUREE_CLE_EN_COURS_MAX_MS` (5 min, `src/api/idempotence.ts`) est
  abandonnée, et `claim` la retire avant d'insérer, comme il retire déjà une clé expirée. Une clé SCELLÉE ne
  s'abandonne jamais : seule sa durée de 24 h la libère.
- **Le jeton de garde** : chaque pose écrit un jeton (`api_idempotency.jeton`, migration 0203). `complete` et
  `release` ne touchent que la ligne de LEUR jeton. Sans lui, un traitement lent qui dépasse la borne
  scellerait la ligne de celui qui l'a reprise, ou la libérerait, et les deux enverraient : le double envoi que
  l'idempotence existe pour empêcher.
- **Deux gardes dans la route** : avant de créer la campagne (le geste irréversible), la clé est-elle encore à
  nous ? Sinon 409, et aucune campagne. Au scellement, `complete` rend faux si la clé a été reprise entre-temps :
  la campagne déjà créée n'est PAS lancée (brouillon orphelin, journalisé), et la réponse est 409.
- **Pourquoi 5 minutes** : un envoi légitime en prend au plus quelques secondes (`MAX_RECIPIENTS` vaut 50). La
  borne ne décide pas du double envoi, que le jeton empêche quoi qu'il arrive ; elle décide seulement de combien
  de temps une clé abandonnée bloque son client. 24 h devient 5 minutes.

## Ordre de déploiement

1. **0203 poussée SEULE et appliquée AVANT que son code n'arrive sur main** : le code neuf écrit `jeton` à chaque
   pose, et un `up` d'une autre session emporterait sinon un code qui nomme une colonne absente (chaque envoi par
   l'API en 42703). Elle est additive et nullable : l'ancien code l'ignore.
2. Le code et ses tests, la relecture indépendante, la CI lue job par job.
3. Le banc remonté, l'épreuve brutale rejouée.
4. Le `up` de `mba-api`, accordé avec les sessions voisines qui déploient aujourd'hui.
