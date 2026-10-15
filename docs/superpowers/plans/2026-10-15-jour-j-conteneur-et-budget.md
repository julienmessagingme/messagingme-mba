# Plan : le conteneur de l'API et le budget de connexions du jour J (2026-10-15)

Lot de code de la bascule Scaleway, après la création de la base de production (`mm-prod-db`, DB-PRO2-XXS, 200
connexions) et le banc sur la vraie gamme (au moins 500 appels/s par copie d'API, `docs/JOURNAL-TECHNIQUE.md`, même
date). **Rien ne touche la production du VPS** : les fichiers neufs ne servent qu'au déploiement chez Scaleway.

## Tranché par Julien

**Le maximum de copies de l'API : 3** (2026-10-15). Le budget de connexions en permet 6 (calcul ci-dessous ; 12 au
moment du choix, avant que la relecture ne fasse compter deux versions pendant un déploiement). Une copie allumée coûte
environ 40 € par mois (1 120 mvCPU et 2 Go, au prix serverless), celle du minimum comprise ; l'autoscaler n'allume les
autres que sous la charge. Trois copies tiennent environ 1 500 appels/s, EXTRAPOLÉ du banc d'une seule copie.

## Le calcul (§ 7.5 de `docs/ARCHITECTURE-CIBLE.md`)

200 connexions, dont 3 réservées au superutilisateur : 197. Workers (`ops/scaleway/docker-compose.workers.yml`) :
principal 8 + 2 (pg-boss) + 1 (écoute) = 11, analyse 3 + 2 + 1 = 6. Marge de 10 (migrations, sondes, sauvegardes,
console d'administration). Reste 170 pour l'API, soit 12 copies de 14 connexions (10 applicatives et 4 de réception)
en régime établi, et **6** en comptant deux versions pleines pendant un déploiement (l'ancienne sert jusqu'à ce que la
nouvelle soit prête) : c'est ce que tient le test.

## Tâches

1. **Le certificat de la base** dans le dépôt : `certs/scaleway-mm-prod.crt` (public, sans clé), ouvert par un test
   (X509, adresse 172.16.0.8, validité de plus d'un an).
2. **`ops/scaleway/conteneur-api.json`**, la taille déclarée du conteneur : minimum 1, maximum tranché ci-dessus, 1 120
   mvCPU, 2 Go, seuil de 50 requêtes simultanées, sonde de vie HTTP sur `/live` (une sonde TCP dit « prêt » même quand
   l'application ne répond pas). Et SEULEMENT les réglages non secrets qui comptent pour le budget et la charge :
   `DB_POOL_MAX` 10, `DB_POOL_RECEPTION_MAX` 4, `API_COPIE=auto`, `API_PLAFOND_GLOBAL_PAR_10S` 3500. ⚠️ PAS
   `DB_SSL_CA_FILE` (corrigé au codage) : il va avec l'adresse de la base et change d'un environnement à l'autre (essai
   sur `mm-banc`, production sur `mm-prod-db`), donc il reste avec les variables du script. Le reste de la
   configuration (adresses, listes nominatives) reste hors du dépôt, qui est public.
3. **Le workflow** `deploy-scaleway.yml` applique ce fichier à chaque déploiement, DANS l'appel qui change l'image :
   tout PATCH redéploie, même à valeurs identiques (mesuré le 2026-10-15), donc un seul appel, et plus de `/redeploy`.
   Variables FUSIONNÉES avec celles déjà posées (lues, complétées, réécrites), jamais remplacées, pour ne pas effacer
   celles que pose le script de Julien.
4. **Le budget pour Scaleway**, dans `tests/deploy-scaleway.test.ts` (qui lit déjà le compose des workers, plutôt
   qu'un fichier de plus) : refuse un total au-delà de 197 moins la marge, un minimum à 0, un pool de réception sous
   4, une sonde TCP, et toute variable hors des quatre prévues. Constantes : 200 et 3, relus à la création de la base.
   `tests/budget-pooler.test.ts` (Supabase) reste jusqu'au jour J, et part après.
5. **Le test du workflow** (même fichier) : la taille part avec l'image, les variables sont fusionnées, pas de
   `/redeploy`, et le fichier entre dans l'artefact de livraison.
6. **La doc** : `DEPLOY.md` (le fichier et son application), `docs/ARCHITECTURE-CIBLE.md` § 7.5 et § 10 étape 7, le
   journal technique.

**Hors de ce lot** : les secrets de production (un script lancé par Julien la veille du jour J), la séquence du jour J.

## Tests attendus

- Chaque test vérifié dans les deux sens : le budget accepte 6 copies et refuse 7, le test du workflow refuse une
  étape qui remplace les variables ; les deux programmes `jq` du workflow s'exécutent en CI.
- `npm test`, `npm run typecheck` ; l'auto-attaque est inchangée (aucune route neuve).

## Ordre de déploiement

Le push ne touche pas le VPS. Le déploiement suivant chez Scaleway (environnement d'essai, `DRY_RUN`, base jetable
`mm-banc`) applique la taille au conteneur de test : la relire par `container get` (minimum, maximum, sonde,
variables), et vérifier que les variables posées par le script sont intactes.

## Méthode de livraison

**En direct**, avec la relecture indépendante de fin de lot, parce que le lot tient en quelques fichiers, qu'il est
réversible, qu'aucun chemin emprunté par la production du VPS n'y passe, et que l'invariant qui compte (le budget de
connexions) est précisément ce que le test encode.

L'essai réel qui clôt le lot : le second banc (`scripts/banc-deux-api-2.mts`, ses cinq épreuves, dont l'arrêt d'une
copie) rejoué sur le conteneur serverless ainsi réglé, et `/ops` qui montre chaque copie sous son propre nom. Ensuite
seulement, la base de test `mm-banc` se supprime.
