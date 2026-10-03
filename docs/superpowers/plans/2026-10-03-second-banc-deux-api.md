# Second banc à deux copies d'API (2026-10-03)

Décidé par Julien le 2026-10-03 : un second banc AVANT tout autoscaling, ce week-end (aucun trafic), sur un
Postgres jetable du VPS qu'il a autorisé. Le premier banc (`scripts/banc-deux-api.mts`) a prouvé les clés,
leur révocation et le plafond global. Celui-ci prouve ce qui reste, et ne dépend que du CODE : les chiffres de
capacité se remesureront sur Scaleway, où la base et le proxy changent.

## Méthode de livraison

**En direct, sans agent**, parce que le seul changement de code de production est un nom de processus
(réversible, deux fichiers) et que le reste est un script de banc qui ne tourne jamais contre la production.
L'essai réel qui clôt ce plan EST le banc lui-même : deux vraies copies de l'image, un worker, un Postgres
jetable, et chaque verdict lu sur la base, pas déduit d'un code de retour.

## Correctif préalable (code de production)

- `API_COPIE` (config, vide par défaut) : le nom de la copie dans `/ops`. Vide = `api`, exactement le
  comportement d'avant ; renseigné = `api-<copie>`. Il nomme les attentes de pool ET les alertes Telegram de
  l'API, comme `nomDuProcessus` le fait pour les workers. Sans lui, deux copies s'additionnent dans une seule
  courbe et le banc ne pourrait pas dire laquelle sature.
- Aucun changement de `DB_POOL_MAX` en production : il n'y a qu'une copie. La règle (le redimensionner AVANT
  d'ajouter une copie) est écrite dans `src/config.ts`.

## Les épreuves

1. **Idempotence entre copies** : dix clés, chaque envoi tiré EN MÊME TEMPS sur A et B. Attendu : un seul
   envoi par clé en base, et toute réponse 201 d'une même clé porte le même `sendId` (l'autre copie rend 409
   « en cours » ou rejoue le rapport).
2. **Arrêt propre d'une copie** (`docker stop`, SIGTERM) en plein trafic : aucune requête déjà reçue n'est
   coupée, l'autre copie ne rend aucune erreur, aucune clé ne reste « en cours ».
3. **Arrêt brutal** (`docker kill`, SIGKILL) en plein trafic : toute requête acquittée a laissé sa trace en
   base ; les requêtes coupées sont rejouées sur l'autre copie avec la même clé, et on compte ce qu'elles
   rendent. 🔴 Hypothèse à mesurer : une copie tuée entre la pose de la clé et son scellement laisse la clé
   « en cours » (409) pendant 24 h, rien ne la libère. Ce n'est pas propre au multi-copies (un crash fait
   pareil), mais un autoscaling qui réduit le nombre de copies le rendrait fréquent s'il tuait sans SIGTERM.
4. **Réception des webhooks sous pression de pool** : pools réduits sur le banc, lectures lourdes en rafale
   sur A, webhooks signés en même temps. On mesure l'accusé (latence, statut), les tâches réellement
   enfilées, et les attentes de pool de chaque copie, sous son nom.
5. **Connexions ouvertes par copie**, lues dans `pg_stat_activity` au repos et sous charge : au plus
   `DB_POOL_MAX` par copie d'API, et aucune connexion d'écoute (`LISTEN`) côté API.

Hors banc, et pourquoi : les verrous courts (publication de l'agent de Meta, demande de code d'un numéro,
anti-rejeu du relais) vivent en base par construction et `tests/integration/verrous-courts.integration.test.ts`
les éprouve ; les routes qui les prennent appellent Meta, qu'un banc ne peut pas joindre.

## Ordre

1. Le correctif `API_COPIE` (annoncé aux sessions voisines : il touche `src/index.ts`), tests, poussé.
2. Le script `scripts/banc-deux-api-2.mts`, poussé.
3. Le banc monté sur le VPS selon la recette de `scripts/banc-deux-api.mts`, les épreuves jouées, puis DÉMONTÉ.
4. Les verdicts dans le journal ; un défaut trouvé devient un lot à part, pas un correctif glissé ici.
