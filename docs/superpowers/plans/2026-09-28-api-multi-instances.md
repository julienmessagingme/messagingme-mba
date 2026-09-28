# L'API en N copies : rien de ce qu'une copie garde en mémoire ne doit devenir faux (2026-09-28)

Décision de Julien du 2026-09-28 : l'API sera autoscalée à Scaleway **sans plafond de copies imposé par le code** ;
le worker reste **un exemplaire par rôle** (les deux rôles décidés le 2026-09-21, `docs/ARCHITECTURE-CIBLE.md` §5,
ne changent pas). Ce plan remplace l'ancienne borne « deux copies au plus » de `docs/ARCHITECTURE-CIBLE.md` §2,
§3.1 et §3.3. Le maximum de l'autoscaler se déduira du seul budget de connexions de la base (§7.5).

L'inventaire complet (état en mémoire par processus, fichier par fichier) a été fait le 2026-09-28 sur
`origin/main` 7337a40f ; ses conclusions sont ci-dessous, lot par lot. Il démarre APRÈS le lot `/ops` nominatif
(`2026-09-28-ops-nominatif.md`), qui touche les mêmes fichiers.

## Lot A : ce qui devient FAUX avec deux copies

- **L'anti-rejeu des gestes d'envoi de l'agent de Meta** (`src/mba/anti-rejeu.ts`, lu par `executer-maison.ts`) :
  en mémoire. Un rappel de l'outil sur une autre copie renvoie un template ou un scénario, facturé. Il passe en base.
- **Le verrou « publication en cours »** (`src/http/mba-publication.ts`) : un `Set` en mémoire. Deux publications
  simultanées se révoquent la clé du relais. Il passe en base, avec un jeton de garde.
- Les deux reposent sur UNE table de verrous courts (clé, jeton, échéance ; prise par `insert ... on conflict ...
  where échéance < now() returning`), sur le modèle de `src/campaign/run-lock.ts` (bail et jeton de garde).
- **Les pièces jointes de l'assistant MBA** (`src/mba/assistant/pieces-jointes.ts`, en mémoire 2 h) : la route n'a
  plus d'appelant côté écran (`todo.md`). La retirer suffit ; sinon l'Object Storage de §6.
- **Le jeton Meta en cache** (`src/meta/credentials.ts`, 5 min) : une copie qui garde l'ancien jeton après une
  reconnexion prend un 190, et `markTokenInvalid` marque alors le NOUVEAU jeton invalide. Le marquage devient
  conditionnel au jeton qui a échoué.
- **La garde du numéro délié** (5 s par copie) : « Délier » ne vide que la copie qui sert la requête. Accepté (5 s au
  plus), mais l'invariant de `documentation.md` qui dit « l'API n'a aucune fenêtre » est corrigé.
- **Les gestes qui continuent après la réponse** (`bloc_fixe` / `scenario_fixe` du relais, environ 16 s) : l'arrêt
  d'une copie (réduction de l'autoscaler) ferme le pool sans les attendre. L'arrêt les attend, borné.

## Lot B : les plafonds de débit partagés en base

Aujourd'hui N copies servent N fois chaque plafond. Un compteur Postgres par fenêtre (`upsert n = n + 1 returning
n`, une écriture par requête plafonnée, `docs/ARCHITECTURE-CIBLE.md` §9 : Postgres d'abord, Redis quand la mesure
le demande), dans cet ordre :
- le plafond par espace de l'API publique (`/v1` et `/mcp`, minute et heure, `src/auth/plafond-espace.ts`) et ses
  en-têtes `x-ratelimit-*` ;
- le plafond des opérations coûteuses par espace (`RATE_LIMIT_COUTEUX_PAR_MINUTE`) et les opérations lourdes
  simultanées (`src/api/usage-guard.memoire.ts`), plus le compteur `/ops/usage` ;
- les plafonds de connexion (`src/auth/routes.ts` : login, inscription, mot de passe oublié, Google) ;
- l'intervalle de 60 s entre deux demandes de code d'inscription d'un numéro (`src/http/embedded-signup.ts`), qui
  protège le quota de Meta (au-delà, numéro bloqué 72 h) ;
- les refus de `/ops` et l'anti-répétition de leur alerte Telegram (`src/ops/tentatives.ts`).
Restent en mémoire, délibérément et écrit : le plafond par utilisateur (300/min), les petits plafonds (aide,
support, chaîne, relais MBA, codes `/w` et `/rcs/callback`), les caches sans invalidation (N fois les lectures,
aucun résultat faux).
⚠️ Derrière un répartiteur de charge, la clé d'un plafond par IP doit lire la VRAIE adresse du client
(en-tête posé par Cloudflare, §7.3), jamais celle du répartiteur.

## Lot C : les connexions de pg-boss

Chaque copie de l'API réserve `PGBOSS_MAX` connexions de session pour seulement EMPILER des tâches. pg-boss accepte
une connexion fournie (`db` avec `executeSql`) : l'API lui passe son pool applicatif, avec `migrate: false`
(`docs/ARCHITECTURE-CIBLE.md` §3.1, déjà instruit).

## Méthode de livraison

**Implémenteur par lot, puis UNE relecture par lot**, parce que chaque lot touche des chemins que la production
emprunte (envois de l'agent de Meta, publication, dépôt de toutes les tâches, garde de débit de l'API publique) et
porte des invariants qu'un test unitaire à une seule copie ne peut pas voir. Les tests d'intégration (CI, vraie
base) portent la preuve des verrous et des compteurs partagés : deux « copies » simulées par deux instances des
modules sur la même base.

**Essai réel qui clôt le chantier** : deux copies de l'API sur le VPS (`docker compose up --scale mba-api=2`,
derrière le même proxy), puis, depuis l'extérieur : le plafond par espace de l'API publique tient au TOTAL et pas
par copie ; une double publication de l'agent de Meta est refusée ; un geste d'envoi rejoué ne part qu'une fois ;
le nombre de connexions de session ouvertes ne double pas. Puis retour à une copie.

**Ordre de déploiement** : lot A (migration de la table de verrous AVANT le `up`, l'ancien code l'ignore), lot B
(migration du compteur AVANT le `up`), lot C (aucune migration). Chaque lot déployé avant le suivant.
