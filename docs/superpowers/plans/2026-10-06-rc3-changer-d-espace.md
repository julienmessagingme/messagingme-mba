# RC3 : changer d'espace sans se déconnecter

> Chantier « Retours console du 6 octobre » (RC1 à RC8), cadré avec Julien le 2026-10-06. Plan COURT : tâches,
> interfaces, tests attendus, ordre de déploiement, sans code.

**But :** une adresse qui a plusieurs espaces passe de l'un à l'autre depuis le menu du compte, juste au-dessus de
« Déconnexion ».

**Décisions de Julien :** bascule directe, sans redemander le mot de passe ni le second facteur ; la liste n'apparaît
qu'à partir de deux espaces ; pas d'entrée « Créer un espace » dans ce lot.

## Ce qui existe, et ce qui manque

- Une identité (`identities`, une adresse) a un compte (`users`) par espace, chacun avec son rôle (0072, 0073).
- La connexion le sait déjà : avec plusieurs comptes, `suiteDeConnexion` (`src/auth/routes.ts:96-131`) rend un jeton
  de choix de cinq minutes et la liste `workspaces` ; `/auth/choose-workspace` l'échange contre une session.
- La session (`src/auth/token.ts:28`, `{ userId, tenantId, role }`, 12 h) est liée à UN espace, et `scopeTenant` exige
  que l'espace de l'URL soit le sien. **Aucune route ne liste les espaces d'une identité une fois connecté, ni n'échange
  une session contre une autre.**
- 🔴 Pourquoi la bascule directe ne baisse aucune garde : la connexion propose déjà le choix entre CES espaces avec
  CETTE preuve (mot de passe et second facteur, ou Google). Basculer revient à rejouer ce choix.

## T1. Les deux routes

**Fichiers :** nouveau module de routes (ou `src/http/me.ts`), `src/server.ts` (registre, annoncé), `src/user/store.pg.ts`
si une lecture manque, tests.

- `GET /tenants/:tenantId/espaces` : les comptes de l'identité de la session, avec `tenantId`, `tenantName`, `role`,
  et `actuel: boolean`. Mêmes filtres que la connexion (les comptes retenus par `findIdentity` puis le filtre des comptes
  actifs de la ligne 367 : un espace verrouillé ou un compte désactivé n'apparaît pas). Classe `tenant` au registre :
  `scopeTenant` s'applique, l'identité vient de la session, jamais de l'URL.
- `POST /tenants/:tenantId/changer-espace` `{ tenantId: cible }` : vérifie que la cible est dans la liste ci-dessus
  (sinon 404, jamais 403 qui confirmerait qu'un espace existe), signe une session `{ userId: compte de la cible, tenantId,
  role }` et la rend avec `user: { email, role, tenantId }`, la forme exacte de `suiteDeConnexion`. `markLogin` sur le
  compte cible.
- 🔴 **La nouvelle session garde l'ÉCHÉANCE de l'actuelle** (lue dans le jeton présenté), au lieu de repartir pour
  12 h : sinon deux bascules par jour prolongeraient une session sans fin, sans jamais repasser par une preuve.
- 🔴 **Une session d'observation (`/ops`, celle qui porte l'adresse de l'observateur) ne bascule pas** : 403. Elle a
  été signée pour UN espace par un exploitant, et basculer lui ouvrirait les autres espaces de l'identité observée.
- Les deux routes passent par le plafond par utilisateur existant (posé dans `makeRequireAuth`), rien de plus.

**Tests attendus :** la liste rend les deux espaces d'une identité, marque l'actuel, n'inclut ni l'espace d'une autre
identité ni un espace verrouillé ; la bascule vers un espace de l'identité rend une session valide sur CET espace, avec
le rôle de CE compte (admin d'un côté, agent de l'autre) ; vers un espace étranger : 404 ; l'échéance est celle du jeton
d'origine (vérifié dans les deux sens : avec `12h` en dur, le test échoue) ; une session d'observation : 403 ;
`tests/scope-tenant.test.ts` et la parité du registre passent ; `npx tsx scripts/auto-attaque.mts` passe.

## T2. La console

**Fichiers :** `web/components/AccountMenu.tsx`, `web/lib/session.ts` (écriture de la session), `web/lib/api/`, e2e.

- Dans le menu du compte, juste au-dessus de « Déconnexion » (l. 117) : « Changer d'espace », la liste des AUTRES
  espaces par leur nom (le rôle en petit). Lue à l'ouverture du menu, pas à chaque page. Absente avec un seul espace.
- Choisir un espace : appel de la route, écriture de la nouvelle session dans `localStorage['mba.session']` à la place
  de l'ancienne, puis navigation vers la page d'accueil du rôle (`/accueil` pour un admin, `/inbox` sinon,
  `web/lib/session.ts:92`), en rechargeant la page pour qu'aucun état de l'ancien espace ne survive en mémoire.
- Le nom de l'espace actuel s'affiche en tête du menu, sous l'adresse (il n'apparaît nulle part aujourd'hui, et c'est
  ce qui dit où l'on est). Au passage, le libellé de rôle « Agent » affiché pour un manager (`AccountMenu.tsx:83`) est
  corrigé.

**Tests attendus :** un e2e avec une identité à deux espaces (fixture), qui bascule et voit le nom du second espace
dans le menu et ses données ; avec un seul espace, l'entrée n'existe pas.

## T3. Documentation

`documentation.md` (l'authentification : la bascule, l'échéance conservée, le refus de l'observation, modifié sur
place), `features.md` (le menu du compte, et sa fiche d'aide si une la cite, `tests/aide-proposer.test.ts` vert avant
le push), journal.

---

## Méthode de livraison

**Implémenteur par lot + revue humaine du diff**, une relecture indépendante en fin de lot, parce que le lot touche le
chemin d'authentification : une route qui signe une session est exactement l'endroit où une erreur ouvre un espace à
quelqu'un qui n'y a pas de compte, et l'invariant « une session ne dure jamais plus que sa preuve » ne se voit dans
aucun type.

**Ordre de déploiement :** CI verte job par job, `compose build`, `up` de l'API (aucune migration), rechargement NPM et
contrôle public. La console part APRÈS le `up` : elle appelle deux routes neuves.

**L'essai réel qui clôt :** Julien, connecté avec son adresse qui porte plusieurs espaces, ouvre le menu du compte, voit
ses autres espaces, en choisit un, arrive sur ses données sans écran de connexion, et revient au premier de la même
façon ; puis vérifie qu'une personne avec un seul espace ne voit pas l'entrée.
