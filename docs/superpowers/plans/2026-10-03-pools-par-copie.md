# Les pools dimensionnés par copie (2026-10-03)

Demandé par Julien : « fais le redimensionnement du pool par copie maintenant », dernier préalable de code avant
l'autoscaling après le second banc.

## Méthode de livraison

**En direct, sans agent, avec une relecture indépendante du diff**, parce que le lot ne change qu'une
configuration (la taille de pool de chaque service dans `docker-compose.yml`) et des textes, réversible d'un
`up`, mais qu'il porte sur le chemin que la production emprunte (le pool de l'API sert la console et l'accusé des
webhooks). L'essai réel qui clôt le lot : la sonde du pooler (N `pg_sleep(1)` simultanés) qui voit le nouveau
réglage APPLIQUÉ, puis `mba-api` recréé avec sa taille et vu sain, et les attentes de pool lues dans `/ops`.

## Ce que la mesure a décidé

- Le pooler de Supabase tenait 16 connexions (réglage « Pool Size » à 15, par utilisateur, base et mode) ; nos
  pools en promettaient 19, et celui de l'API saturait 6 % de ses prises de connexion sur sept jours. Partager les
  16 entre copies aurait aggravé une saturation mesurée.
- Le levier est le réglage : Julien l'a monté à 30, la sonde en voit 31. API 10, principal 8, analyse 3.
- `tests/budget-pooler.test.ts` tient le budget à chaque commit : une taille par service, la somme et les
  sessions sous le pool, le pire cas sous 80 % des connexions de Postgres, et chaque copie d'API plus grande que
  ses opérations lourdes.

## Ordre de déploiement

Aucune migration. Commit, CI lue job par job, puis `up` de `mba-api` (sa taille change). `mba-worker` ne voit que
des valeurs explicitées à l'identique : il sera recréé au prochain `up` d'une session voisine, sans effet.
