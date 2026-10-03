# Plan : deux rôles de worker, et le banc à deux copies d'API

> Décidé par Julien le 2026-10-02, après l'audit de performance du même jour
> (`docs/prive/` n'en porte pas de copie : l'audit est arrivé en conversation).
> Base : `4d5acbb8`, arbre réaligné et typecheck propre le 2026-10-02.

## Pourquoi ces deux-là, et pas le reste de l'audit

L'audit proposait neuf lots. Julien en retient deux et écarte les médias RCS. Ce qui motive chacun :

- **Les deux workers** : Julien les veut faits maintenant, pour que ce soit fait avant la bascule. ⚠️ J'avais
  recommandé d'attendre un incident mesuré ; il a tranché, et c'est sa décision. Le gain réel est
  l'ISOLATION, pas le débit : un appel LLM lent ou un redémarrage de l'analyse ne doit pas retarder les
  messages entrants ni les campagnes.
- **Le banc à deux copies d'API** : l'autoscaling est décidé, et « hors de question de se lancer là-dedans
  sans avoir crash testé ». Le code multi-instance est livré (lots A, B et C du 2026-09-28), l'essai ne l'est
  pas.

## Méthode de livraison

**Lot A (le banc) : en direct.** Il n'ajoute aucun chemin que la production emprunte, il ne touche que
`scripts/` et refuse de démarrer sur une base de production. Rayon de souffle nul, réversible par un `rm`.

**Lot B (les deux rôles) : implémenteur par lot, avec une relecture indépendante en fin de lot.** Les quatre
questions tranchent toutes du même côté : la production emprunte ce chemin (les webhooks entrants et les
campagnes passent par `src/worker.ts`), c'est réversible (un drapeau plus un service compose), les critères
sont vérifiables par un test de propriété, MAIS le code touché porte des invariants invisibles. Le principal
est que **`groupConcurrency` est local au processus pg-boss** : deux copies d'un même rôle doubleraient le
plafond par espace et feraient partir certaines minuteries deux fois. Un test ne voit pas cet invariant, un
œil oui.

🔴 **L'essai réel qui clôt chaque lot, parce qu'aucune de ces deux méthodes ne le remplace.** Pour le banc :
il tourne sur un vrai Postgres jetable et rend ses cinq verdicts, sans quoi l'autoscaling reste interdit.
Pour les deux rôles : en production, un message entrant RÉEL traité par le principal pendant qu'une analyse
tourne sur l'autre rôle, et les DEUX heartbeats visibles dans `/ops`. C'est l'isolation qu'on achète, donc
c'est elle qui doit être constatée en vrai. Détail en fin de plan.

## Lot A : le banc à deux copies d'API

Le banc existe déjà (`scripts/banc-charge.mts`, 221 lignes) avec sa garde anti-production (toute chaîne qui
ressemble au pooler Supabase est refusée, plus `BANC_CONFIRME=1`). On lui ajoute un profil, on ne le réécrit
pas.

🔴 **PRÉREQUIS QUI N'EST PAS DU CODE : un Postgres jetable.** Il n'y a pas de Docker sur ce poste (vérifié),
et le `DATABASE_URL` local pointe sur la PRODUCTION. Le banc a donc besoin d'un conteneur Postgres sur le
VPS, avec un nom et un port dédiés, et sans jamais lire le `.env` de production. **Cela demande l'accord
explicite de Julien** avant tout `docker run` là-bas.

Les cinq propriétés à éprouver, choisies parce qu'un seul processus ne peut pas les montrer :

1. le plafond `/v1` par espace reste GLOBAL aux deux copies (migrations 0181 et `compteurs_debit`) ;
2. une clé révoquée est refusée sur les DEUX copies, sans attendre l'expiration d'un cache ;
3. l'idempotence de `/v1/sends` empêche un double envoi après un retry qui frappe l'autre copie ;
4. ajouter une copie n'ajoute AUCUNE connexion de session pg-boss ;
5. tuer une copie en pleine requête ne perturbe pas l'autre, et ne perd ni ne double un envoi.

Sortie attendue : p50, p95, max, attentes de pool, nombre de connexions, âge des files. Le banc refuse de
démarrer sans base jetable, comme le profil existant.

## Lot B : deux rôles de worker

### Les deux coutures qui existent déjà, et qu'on n'invente pas

- les files s'enregistrent par dix appels `queue.work(...)` dans `src/worker.ts` ;
- les minuteries passent TOUTES par `taches.programmer(nom, intervalle, fn, opts)`
  (`src/worker/taches.ts`), un registre déjà en place.

C'est ce qui rend ce lot petit : il n'y a pas à réécrire `worker.ts` (1628 lignes), il y a à déclarer une
APPARTENANCE et à filtrer dessus.

### Tâches

1. `WORKER_ROLE` dans `src/config.ts`, trois valeurs : `principal`, `analyse`, `all`. Défaut `all`, qui
   reproduit EXACTEMENT le comportement d'aujourd'hui, donc un déploiement sans la variable ne change rien.
2. Une table d'appartenance, dans un module à part, qui nomme pour CHAQUE file de `BASE_QUEUES` et CHAQUE nom
   de minuterie son rôle propriétaire. `analyse` prend `analyze-conversation`, `push-analysis`,
   `hubspot-catchup`, le balayage d'analyse, les agrégats et la rétention des analyses. `principal` prend tout
   le reste.
3. Le filtre au point d'enregistrement : une file ou une minuterie dont le rôle n'est pas le rôle courant ne
   s'enregistre pas.
4. 🔴 **Le principal SEUL supervise et migre pg-boss.** Deux superviseurs se disputeraient l'entretien des
   files.
5. Heartbeat et alertes PAR RÔLE. Aujourd'hui une ligne unique `worker` : telle quelle, elle masquerait la
   mort de l'un des deux, ce qui est pire que l'état actuel.
6. Pools recalculés par rôle, par variable d'environnement et non par du code neuf : le même conteneur reçoit
   `DB_POOL_MAX` et `PGBOSS_MAX` différents selon le service.
7. Arrêt propre indépendant.

### Tests attendus

- **Test de propriété** : chaque file de `BASE_QUEUES` et chaque nom passé à `taches.programmer` appartient à
  EXACTEMENT un rôle. C'est ce test qui empêche qu'un onzième job arrive sans propriétaire, ou qu'une
  minuterie tourne deux fois.
- **Test de parité** : en `all`, l'ensemble des files et minuteries enregistrées est IDENTIQUE à celui
  d'aujourd'hui. C'est la garantie que le défaut ne change rien.
- Les deux vérifiés par mutation, dans les deux sens, sur le CÂBLAGE et pas sur la fonction pure.

### Ce que la mesure du 2026-10-03 a tranché, et le bloqueur qu’elle a sorti

✅ **La question du `ensure` est tranchée, par la mesure et pas par un raisonnement** : les DIX sites
d’`enqueue` du worker ont été relus, et **tous visent une file du MÊME rôle**. Aucun rôle n’a donc besoin de
CRÉER une file qu’il ne consomme pas, et le filtre peut se poser avant le `ensure`. L’API, elle, n’a jamais
créé de file : elle a toujours dépendu du worker pour ça, et le découpage n’y change rien.

✅ **Le filtre est posé DANS la file, pas aux enregistrements**, et c’est une révision sur donnée mesurée :
renommer l’appel cassait **cinq gardes du dépôt d’un coup**, celles qui dérivent les files consommées du TEXTE
de `worker.ts`. Les réécrire aurait voulu dire toucher des tests dont le rôle est justement de vérifier
qu’aucune file ne perd son consommateur. `PgBossQueue.neTravailleQue(predicat)` les laisse intactes, et
`filesTravaillees()` rend le journal de démarrage juste tout seul.

✅ **VÉRIFIÉ SUR LE BANC, PAS SEULEMENT EN TEST** : `all` consomme 8 files, `principal` les mêmes MOINS
`analyze-conversation`, et `analyse` exactement `analyze-conversation`. La partition est celle qui est
déclarée, sans recouvrement ni perte.

🔴 **BLOQUEUR TROUVÉ, ET IL DOIT PASSER AVANT LES DEUX SERVICES : le battement est une LIGNE UNIQUE.**
`worker_heartbeat` porte `id = worker` ÉCRIT EN DUR (`src/ops/heartbeat-store.pg.ts`). Deux rôles
l’écriraient tous les deux, le survivant rafraîchirait la ligne du mort, et `/ops` la lirait vivante : le
découpage rendrait la surveillance **strictement pire qu’aujourd’hui**, où un worker unique et une ligne
unique sont honnêtes. Il faut clefer le battement par rôle (migration), le lire par rôle et alerter par rôle.
C’est un sous-lot à part, avec sa migration, donc il ne s’improvise pas.

### Ordre de déploiement

Aucune migration. Donc :

1. déployer avec `WORKER_ROLE` ABSENT, c'est-à-dire en `all` : le code neuf tourne, le comportement est celui
   d'hier, et on le vérifie en production avant de découper ;
2. puis ajouter le service `mba-worker-analyse` au compose et passer le worker existant en `principal`.

🔴 **`min=1` et `max=1` pour CHAQUE rôle**, et ce n'est pas un réglage de prudence : `groupConcurrency` est
local au processus, donc deux copies d'un même rôle doubleraient le plafond par espace et dédoubleraient les
minuteries.

⚠️ **Ne pas profiter du découpage pour relever la concurrence de l'analyse.** Un seul changement à la fois,
sinon une régression ne s'attribue plus.

## Ce que ces lots NE font pas

Les trois autres sujets de l'audit restent ouverts et aucun n'est dans ce plan : le budget de connexions
Scaleway (décision du jour de la bascule, pas du code), la métrique des médias RCS (écartée par Julien
aujourd'hui), et le quota d'unités de l'API publique (défaut `0`, vérifié : il observe sans refuser, et
inventer un chiffre maintenant serait une promesse que rien ne soutient).

## L'essai réel qui clôt chaque lot

- **Lot A** : le banc tourne sur la base jetable et rend ses cinq verdicts. Tant qu'il n'a pas tourné,
  l'autoscaling reste interdit.
- **Lot B** : en production, après le passage à deux services, un message entrant réel traité par le
  principal PENDANT qu'une analyse tourne sur l'autre rôle, et les DEUX heartbeats visibles dans `/ops`.
  Aucun test ne remplace ça : c'est précisément l'isolation qu'on achète qui doit être constatée.
