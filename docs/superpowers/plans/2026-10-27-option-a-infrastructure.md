# Option A de l'infrastructure : index de prise de pg-boss, disque rapide, petite copie d'API (2026-10-27)

Décision de Julien le 2026-10-27, sur les bancs du même jour (`docs/JOURNAL-TECHNIQUE.md`, « les bancs de la nouvelle
infrastructure ») : on garde la base de production en DB-DEV-M, on lui ajoute l'index de prise de pg-boss et le disque
rapide, et la copie d'API toujours allumée passe à la petite taille. Coût visé : environ 111 € HT par mois.

## Méthode de livraison

**Implémenteur unique, une relecture indépendante du diff, puis déploiement approuvé par Julien** : les trois gestes
touchent des chemins que la production emprunte (la prise de chaque tâche, le disque de la base, la taille de la copie
qui reçoit les webhooks de Meta), mais ils sont petits et chacun se défait en une commande.

## Les gestes, dans l'ordre

0. **Attendre la fin du déploiement de l'offre Business** (session voisine, migration 0257 en `avant`) : elle a demandé
   qu'aucun `deploy-scaleway` ne parte avant le sien.
1. **Le disque rapide de `mm-prod-db`** (`rdb instance upgrade volume-type=sbs_15k`), sans code : environ 7 minutes
   d'opération chez Scaleway, `/health` sondé toutes les 5 s pendant tout le geste, comme pour la descente de gamme.
   Relire ensuite le volume, l'adresse, le certificat et `max_connections`. Retour : `volume-type=sbs_5k`.
2. **L'index de prise de pg-boss**, posé par le worker principal à son démarrage, après `boss.start()` :
   `create index concurrently if not exists` sur `pgboss.job_common (name, priority desc, created_on, id)` partiel
   `where state < 'active' and not blocked`. Pas une migration : la table appartient à pg-boss, qui la crée à son premier
   démarrage, donc une migration échouerait sur une base neuve (CI, bancs). Seule l'instance qui supervise le pose (deux
   créations concurrentes du même index se gêneraient) ; un échec se journalise et ne bloque pas le worker, l'index n'étant
   qu'une accélération. Retour : `drop index concurrently`.
3. **La petite copie d'API** (`ops/scaleway/conteneur-api.json`) : `mvcpu_limit` 560, `memory_limit_bytes` 1 Go, seuil de
   montée `concurrent_requests_threshold` à 35 (au banc, la petite copie traite environ 40 requêtes simultanées à 150
   appels/s ; une 2e copie s'allume donc vers 120 appels/s, environ 17 fois le pic réel). Le budget de connexions ne
   bouge pas (les pools restent les mêmes). Retour : les anciennes valeurs, et un déploiement.
4. **Un déploiement** (`migration=aucune`) pour 2 et 3, puis la vérification : l'index présent et valide en base
   (`indisvalid`, sonde en lecture seule par la machine), la taille du conteneur relue, `/health`.

## Tests attendus

- L'index posé une fois, par l'instance qui supervise seulement, et un échec qui ne casse pas le démarrage (unitaire,
  faux client) ; sa présence après le démarrage du worker (intégration, Postgres jetable de la CI).
- `tests/deploy-scaleway.test.ts` : la taille et le seuil déclarés, le budget inchangé.

## Essai réel

Une campagne SANDBOX vers le numéro de Julien : les accusés « envoyé, distribué, lu » arrivent dans l'ordre sur l'écran
de la campagne ; Claude relit la file `webhook-status` dans `pgboss.job` et le plan de la prise (`EXPLAIN` en lecture
seule) qui doit passer par l'index.
