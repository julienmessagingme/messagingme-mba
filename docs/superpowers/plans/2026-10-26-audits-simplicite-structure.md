# Les lots des audits simplicité et structure (2026-10-26)

Deux audits en lecture seule de `origin/main` le 2026-10-25 (simplicité, puis structure au sens des modules profonds),
leurs affirmations fortes revérifiées dans le code. Julien a retenu quatre lots ; le lot des types de réponse recopiés
côté console part au backlog (`todo.md`), parce qu'il demande de réconcilier chaque paire serveur/console. Aucun
changement de comportement visible n'est voulu, sauf la correction du lot B.

## Méthode de livraison

Un lot à la fois, chacun relu par UNE relecture indépendante du diff avant le push. Lot A en direct (isolé,
réversible, quelques fichiers). Lots B et C par implémenteur et revue du diff : ils déplacent des protocoles que la
production emprunte (numéros payés, envois d'un opérateur, crédit Stripe), et leurs tests actuels migrent vers les
modules de domaine. Lot D en direct, la console seule, e2e de l'Inbox compris. Pas de workflow. Chaque lot se clôt
par un essai réel en production, nommé dans l'ordre de déploiement ci-dessous.

## Lot A : les petits, en direct

1. `reglagesSousLOffre(deps, t)` dans `src/repondeur/mode.ts`, à la place de cinq des six compositions « réglages et
   offre lus ensemble, puis `sousLOffre` » (`inbox/fil.ts`, `workflow/wiring.ts`, `worker.ts`, `mcp/outils.ts`,
   `repondeur/reglage.ts`). La sixième, `lireRepondeur` (`reglage.ts`), reste dans son `Promise.all` à six lectures.
2. `ecrireRolloutPuisDrapeau` dans `src/mba/client.ts`, pour la route `PUT .../rollout` et l'assistant : « Meta
   d'abord, nous ensuite » y a un exemplaire. `appliquerActivation` garde le sien, qui reçoit les deux écritures en
   dépendances séparées (`activationPour`, `src/http/mba.ts`).
3. Retrait de `scripts/mesure-tour-agent.mts` (banc ponctuel, résultat archivé).
4. Les quatre pages qui ne faisaient qu'un `router.replace` deviennent des `redirects()` de `web/next.config`.
5. Une seule sonde de chiffrement dans `src/index.ts` au lieu de quatre (fichier de câblage partagé : annonce).
6. Le composant `Champ` (texte enregistré à la sortie du champ) en un exemplaire.

Tests : les existants restent verts ; un test par fonction nouvelle (1, 2) ; les e2e des pages redirigées.

## Lot B : la réserve de numéros fournis

`src/numero/reserve.ts` porte le droit au numéro, obtenir, remplacer, rendre, et `servirLAttente(sauf)`, qui ne lève
jamais. Ses quatre copies (`http/numero-fourni.ts`, `index.ts`, `worker.ts`, `http/ops-numeros.ts`) l'appellent. Corrige
le 500 de `/ops` quand l'attribution à l'abonné qui attend échoue APRÈS la déclaration du numéro. Invariants à garder :
pas de numéro avant paiement, un Pro ne prend pas le numéro d'un abonné, le verrou de remplacement, `sauf`. Tests :
ceux de `numero-fourni.test.ts` et `ops-numeros.test.ts` migrent vers le module, la route garde la traduction.

## Lot C : l'envoi d'un opérateur dans un fil, puis la recharge Stripe

1. `envoyerModeleDansLeFil` et `envoyerRcsDansLeFil` dans `src/inbox/`, à côté de `repondreAvec`, avec une queue
   commune « prendre le fil, inscrire l'envoi accepté » (invariant 59). Les routes `send-template`, `send-rcs` et
   `POST /v1/messages/rcs` traduisent l'issue. Invariants : la catégorie se lit chez Meta ; un opérateur peut envoyer
   un modèle « Service » à un désabonné, l'API et les campagnes non (deux règles voulues) ; `/v1/messages/rcs` ouvre
   le fil avant de le prendre.
2. `creerTraitementRecharge(deps).traiter(evenement)` dans `src/stripe/`, sur le modèle de `traitement-abonnements`.
   La route garde la signature, l'enveloppe et l'aiguillage ; 422 seulement pour un événement illisible.

## Lot D : la console

1. La synchronisation du fil de l'Inbox en module pur (`web/lib/fil-synchro.ts`), testé par vitest ; React garde le
   minuteur, l'abandon et la garde « en vol ».
2. `useChargement` à la place des neuf chargements recopiés ; `CadrePublic` pour les six pages publiques ; les quatre
   constantes encore recopiées passent dans `web/lib/partage/`.

## Ordre de déploiement

Lots poussés un par un, CI lue job par job. A, B et C touchent l'API et le worker : `up` après la CI verte, aucune
migration attendue. D ne touche que la console (Vercel au push). L'essai réel qui clôt chaque lot : A, les quatre
adresses historiques ouvertes dans la console de production et l'agent de Meta allumé puis éteint sur la sandbox ; B,
l'achat d'un numéro sur un espace de test puis sa libération ; C, un modèle et un RCS envoyés depuis l'Inbox, une recharge
Stripe en mode test ; D, une conversation traduite dans l'Inbox.
