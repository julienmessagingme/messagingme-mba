# Approfondir la racine de composition (2026-09-27)

Revue d'architecture du 2026-09-27 : `src/index.ts` fait 3 043 lignes et a été touché par 137 commits en 17 jours,
`src/worker.ts` 1 770 lignes et 51 commits. Julien a validé les candidats 1 à 5, dans l'ordre, un lot déployé avant
que le suivant commence. Aucun lot ne change un comportement visible : chacun déplace ou supprime du câblage.

## Méthode de livraison

**Implémenteur par lot, puis UNE relecture en fin de lot**, parce que chaque lot touche un câblage que la
production emprunte (toutes les routes, le worker, la réception des messages) et porte des invariants que le
compilateur ne voit pas : le nombre d'arguments transmis, la liaison de `this` d'une méthode de store, l'ordre
« Meta d'abord, notre état ensuite ». Pas de feature-loop (les critères sont « rien ne change », qu'un œil doit
juger), pas de workflow. La suite de tests existante est la première preuve, la relecture la seconde, la CI
d'intégration la troisième.

**Essai réel après chaque déploiement** : `scripts/fumee.mjs`, puis un geste réel propre au lot.
- Lot 1 et lot 3 : répondre depuis l'Inbox à une vraie conversation, recevoir un vrai message, ouvrir Contacts,
  Campagnes, Statistiques et `/ops`.
- Lot 2 : relever AVANT le déploiement les coûts affichés de deux campagnes réelles, de la page des coûts et de
  `/ops`, puis les comparer APRÈS : ils doivent être identiques au centime.
- Lot 4 : prendre puis rendre une vraie conversation tenue par l'agent de Meta.
- Lot 5 : un vrai message entrant arrive dans l'Inbox, un vrai STOP est enregistré.

**Ordre de déploiement** : aucun lot n'a de migration ni ne touche la console. `up -d --build mba-api mba-worker`,
rechargement NPM, fumée. Commits construits en plomberie depuis `origin/main` (l'arbre partagé est en retard).

## Lot 1 : la couche de relais disparaît

- Un module de routes qui reçoit des méthodes de store recopiées une à une déclare, dans son propre fichier,
  l'interface de la tranche de store qu'il lit (motif existant : `src/webhooks/inbound.ts`), et reçoit le store
  sous un nom. La racine passe le store tel quel.
- Reste un champ nommé tout membre qui porte de la logique : arguments réordonnés ou complétés, composition de
  deux appels, valeur par défaut, `catch`, lecture de configuration.
- Même geste dans `src/worker.ts` pour ses consommateurs, SAUF les étapes de la réception (`handleWebhookJob`),
  traitées au lot 5.
- Règles : la tranche est déclarée par le consommateur, jamais un `Pick` d'un store Postgres (un module de
  routes ne dépend pas de l'adapter) ; une tranche ne se déstructure jamais (perte de `this`) ; le spread
  `satisfies` du worker reste en place.
- Tests : les faux des tests de route suivent la nouvelle forme, sans changer une assertion. Un test qui lit le
  texte d'`index.ts` ou de `worker.ts` pour épingler l'arité d'un relais devient sans objet quand le relais
  disparaît : il est retiré ou réécrit, en le disant. Un test d'inventaire (qui recense des chemins) reste.
- Critère : plus aucun relais pur hors réception dans les deux racines (mesuré par la même expression régulière
  avant et après), typecheck, lint et `npm test` verts, CI d'intégration verte. Restent délibérément des flèches :
  les gardes de consentement (`estDesabonne`, `estDesabonneRcs`, `aConsentiOuEcrit`, contrat nommé des quatre
  interfaces d'envoi), `getUserState` (rappel de `makeRequireAuth`), `console.*` et `Date.now` (relus à chaque
  appel, pas figés au câblage). Livré le 2026-09-27 : 317 relais à 11 dans `src/index.ts`, 92 à 34 dans
  `src/worker.ts` (dont 23 de la réception).

## Lot 2 : le chiffrage sort de la racine

- Un module dans `src/stats/` construit à partir du dépôt de statistiques, de la grille et du tarif Meta, et
  rend les lectures de coût lues par les statistiques, `/ops` et la fiche contact. La classification RCS
  (simple ou conversationnel) et la lecture des liens tracés d'un scénario s'y écrivent une fois.
- La connexion publicitaire (jeton, connexion concurrente, révocation) rejoint `src/pubs/connexion.ts`, à côté
  de son dépôt (`connexion.pg.ts`) et de la création (`creation.ts`) ; `src/meta/pubs.ts` reste le client Graph.
- Tests : `cout-campagne-rcs-cablage` et `prix-cablage`, qui lisent la source, sont remplacés par des tests qui
  EXÉCUTENT le module contre un faux dépôt et vérifient le chiffre et l'argument `attribuer`, vérifiés dans les
  deux sens.

## Lot 3 : un socle commun aux deux processus

- Une fonction voisine de `buildWorkflowRuntime` construit ce qui doit être identique dans l'API et le worker :
  les dépôts, le dépôt de contacts décoré (annonce d'opt-out et signaux), la pile d'envoi Meta et ses freins,
  l'émetteur, le résolveur e-mail, le runtime de scénario. Elle reçoit le pool, la file et la configuration en
  paramètres : les deux pools restent dimensionnés par processus.
- `src/index.ts` monte les routes, `src/worker.ts` les files et balayages.
- Test : construire le socle avec un faux pool et une fausse file, écrire un opt-out, vérifier que l'annonce et
  le signal sont enfilés. Il remplace la double expression régulière de `signaux-cablage`.

## Lot 4 : le contrôle du fil devient un module deep

- D'abord la table des transitions, écrite et montrée à Julien avant de coder : les gestes (un humain prend,
  l'opérateur rend, escalade, remise sur accusé, reprise pour l'app, balayage), l'ordre Meta puis état local,
  les gardes. `setControlOwner` reste derrière le seam.
- Exception à garder telle quelle : `src/agent/escalade.ts` ne préserve pas la marque, délibérément.
- Tests : la table, exécutée contre un faux client Meta (y compris un Meta qui refuse) et un faux dépôt.

## Lot 5 : la réception rattache l'espace une seule fois

- `handleWebhookJob` extrait les messages et résout le numéro vers son espace (et le numéro délié) une fois,
  puis passe aux étapes des messages déjà rattachés. Les étapes perdent `phoneNumberTenant` et
  `extractInbound`.
- L'étape d'opt-out devient requise (une dépendance de consentement n'est jamais optionnelle).
- Test : le nombre de lectures `phoneNumberTenant` pour un message entrant, avant et après.

## Hors périmètre

Le candidat 6 (« lancer un scénario »), le découpage des gros dépôts (écarté par la revue), les plafonds de débit
locaux au processus et le cache numéro vers espace (freins à la montée en charge, backlog).
