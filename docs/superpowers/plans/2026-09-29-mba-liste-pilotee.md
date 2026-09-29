# L'agent de Meta en mode liste : plan

**But :** l'agent de Meta se tait pendant un scénario et ne parle que quand personne d'autre ne répond, grâce à
une liste qu'on tient nous-mêmes.

**Spec :** [docs/superpowers/specs/2026-09-29-mba-liste-pilotee-design.md](../specs/2026-09-29-mba-liste-pilotee-design.md).
À lire en entier avant de commencer : chaque tâche renvoie à ses paragraphes.

**Base :** `origin/main` à `caf45bf6`. Un seul lot.

## Contraintes globales

- Rien dans l'arbre partagé `C:\Users\julie\messagingme-mba`. Il a 69 commits de retard et porte le travail d'une
  autre session. On travaille dans un export de `origin/main`.
- 🔴 **Aucun test d'intégration en local**, et aucun `migrate` : le `DATABASE_URL` du poste est la production. Les
  tests d'intégration s'écrivent ici et tournent en CI.
- `safeParse` sur toute réponse de Meta, jamais `as`. Aucun tiret cadratin ni demi-cadratin, ni dans le code ni
  dans les textes.
- Commentaires au niveau du dépôt : le POURQUOI, pas le récit.
- Les dépendances neuves sont **requises** et les fixtures disent leur hypothèse, comme `numerosDelies` et
  `tests/executeur-inerte.ts`.

## Mesure faite avant ce plan (2026-09-29, 20 h 08 UTC)

Ajouter deux fois le même numéro : le premier `POST .../agent_config/allowlist` rend `{ id, consumer_phone_number }`.
Le second rend un **400** `MbaError`, « The request or consumer identifier is invalid », `retryable: false`, **sans
code** qui le distingue d'un numéro vraiment invalide.

Conséquences :

- l'idempotence se tient par **notre table**, lue avant d'ajouter ;
- sur un 400 à l'ajout seulement, on relit une fois la liste de Meta pour retrouver l'entrée de ce numéro ;
- introuvable, on relève l'erreur.

## Tâches

### 1. La table et le module de la liste

**Fichiers :**

- `db/migrations/0195_mba_liste.sql` ;
- `src/mba/liste.ts` (neuf) ;
- `src/mba/liste.pg.ts` (neuf) ;
- `tests/mba-liste.test.ts` ;
- `tests/integration/mba-liste.integration.test.ts`.

**Migration :** la table de la spec § 5, avec sa clé primaire `(tenant_id, wa_id)` et aucun autre index.

**Interfaces produites :**

- La mémoire :

  ```
  ListeStore {
    presents(tenantId, waIds[]) → Set<waId>
    trouver(tenantId, waId) → { phoneNumberId, entreeId } | null
    poser(tenantId, waId, phoneNumberId, entreeId)
    supprimer(tenantId, waId)
  }
  ```

- `creerListeDeLAgent({ store, clientMba(tenantId), attendre })` rend `ListeDeLAgent` :
  - `ajouter(tenantId, phoneNumberId, waId)` : ne fait rien si le contact est présent. Sinon, dans l'ordre :
    `POST` en E.164, le cas du 400 ci-dessus, `poser`. Si `poser` échoue : retrait chez Meta, puis on relève
    l'erreur.
  - `retirer(tenantId, waId) → boolean` :
    - absent de la table : `true`, sans appel ;
    - présent : `DELETE` avec l'identifiant et le numéro gardés, un rejeu sur une erreur rejouable (constantes
      `REJEU_*` de `fil.ts`), un 404 vaut retrait, puis `supprimer` et `true` ;
    - refus : `false`, journalisé.
  - `presents(tenantId, waIds)` : délègue au store.
  - `retirerAvantUnModele(tenantId, destinataire)` : ramène le destinataire aux chiffres nus, appelle `retirer`,
    et lève sur `false` une erreur que `classify` (`src/meta/errors.ts`) range en **rejouable**.

**Tests attendus :**

- l'ordre de chaque geste ;
- l'ajout sur un contact déjà présent ne fait aucun appel ;
- le 400 retrouvé par relecture, et le 400 introuvable qui relève ;
- la compensation quand `poser` échoue ;
- le 404 au retrait ;
- un rejeu et un seul ;
- l'erreur de `retirerAvantUnModele` classée rejouable ;
- en intégration : la clé primaire, la cascade depuis l'espace, `presents` sur plusieurs numéros.

### 2. Les deux gestes dans `src/inbox/fil.ts`, et la règle 2

**Fichiers :**

- `src/inbox/fil.ts` ;
- `src/mba/evenement.ts` ;
- `src/socle.ts` (câblage) ;
- `tests/fil.test.ts`, `tests/banc-du-fil.ts`, `tests/controle-du-fil-cablage.test.ts`, et les tests de `fil.ts`
  cités dans l'inventaire.

**Interfaces :**

- consomme : `ListeDeLAgent` (tâche 1), ajoutée à `DepsControleDuFil`, requise ;
- produit : un « confier » interne qui fait `ajouter` puis `release`, et remplace l'acte `releaseThread` de
  `acteChezMeta`, `remiseAutomatique` et `rendreLaMain`. Un « reprendre » interne, qui est
  `liste.retirer`, remplace `prendreAvecUnRejeu` dans `reprendreLaMain`, `reprendrePourLApp` et
  `prendrePourLEquipe`. Leur contrat de retour ne change pas (spec § 1) ;
- `remettreSiPersonneNeSuit(tenantId, waId, contenu)` : après ses trois gardes, dans l'ordre, confier, écrire `mba`,
  envoyer `evenementMessageSansSuite(contenu)` par `agentEvent`. Aucun événement si confier a échoué ;
- `evenement.ts` gagne `TYPE_MESSAGE_SANS_SUITE = 'message_sans_suite'`, sa description (texte exact de la spec
  § 3) et `evenementMessageSansSuite(message)`, sur la même borne que `evenementHorsParcours`.

**À retirer :**

- `reprendreSurNotreBouton`, `retenirApresNotreModele` et la cause `boutonDuScenario` ;
- dans `reprendreLaMain`, la condition « colonne `mba` ». Il retire dès que le contact est dans la table.

**Tests attendus :**

- confier : ajout, puis `release`, puis colonne, dans cet ordre ;
- une conversation de test n'est pas confiée automatiquement, mais le bouton de l'Inbox la confie ;
- reprendre ne fait aucun appel quand le contact est absent ;
- reprendre agit même agent éteint ;
- `remettreSiPersonneNeSuit` envoie l'événement avec le contenu, et n'en envoie aucun si l'ajout est refusé ;
- un `release` refusé après l'ajout laisse la colonne telle quelle ; un événement refusé est journalisé et la colonne reste `mba` ;
- plus aucun appel `takeThread`.

### 3. Règle 1 dans la fabrique Meta

**Fichiers :**

- `src/meta/factory.ts` ;
- `src/socle.ts` ;
- toute construction de `MetaClientFactory` (fixtures comprises) ;
- `tests/meta-factory*.test.ts` (neuf ou existant) ;
- les tests de la campagne, du scénario et de la route d'envoi de modèle de l'Inbox qui couvrent l'échec d'envoi.

**Interfaces :**

- consomme : `ListeDeLAgent.retirerAvantUnModele` ;
- `MetaClientFactoryOpts.listeDeLAgent` est **requise** ;
- le client rendu par `clientForTenant` enveloppe `sendTemplate` et `sendMarketing` : `retirerAvantUnModele(tenantId,
  to)` passe d'abord, et l'envoi n'a pas lieu s'il lève ;
- le module de la liste reçoit le client MBA par une fonction qui appelle la fabrique au moment de l'appel, pas à la
  construction.

**Tests attendus, chacun vérifié dans les deux sens** (retirer l'enveloppe fait échouer le test) :

- un contact présent est retiré avant le modèle ;
- un retrait refusé veut dire aucun envoi ;
- un message libre (`sendText`, `sendInteractive`) ne retire rien ;
- la campagne traite l'erreur comme un refus temporaire ;
- le scénario suit son chemin d'échec d'envoi ;
- la route `send-template` de l'Inbox rend une erreur lisible.

### 4. L'arrivée des messages

**Fichiers :**

- `src/webhooks/handler.ts` ;
- `src/webhooks/inbound.ts` (champ d'origine gardé) ;
- `src/webhooks/workflow-advance.ts` ;
- `src/worker.ts` (dépendances du webhook) ;
- `src/webhooks/remise-mba-entrant.ts` et `src/webhooks/routage-pub.ts` (ils passent le contenu à
  `remettreSiPersonneNeSuit`) ;
- les tests `workflow-advance`, `webhook-triggers`, `remise-mba-entrant`, `pubs-routage`, `webhook-rattachement` et
  `webhook-fixtures`, plus un test du handler.

**Interfaces :**

- une étape après `rattacherLesEntrants`, avant `processInbound`. Si l'agent est allumé, qu'un entrant est en
  `standby` et que son contact est absent de `ListeDeLAgent.presents`, il passe en `messages`. Une lecture par lot ;
- le champ reçu de Meta reste sur l'entrant ;
- `NOTRE_BOUTON`, l'exception `standby` de l'avance, la dépendance `reprendreSurNotreBouton` et la fixture
  `aucuneRepriseSurBouton` disparaissent ;
- plusieurs messages du même contact dans un lot : un seul événement, contenus mis bout à bout (spec § 3).

**Tests attendus :**

- agent allumé et contact absent : le scénario avance sur un texte et sur un bouton, l'automation se déclenche, et
  la règle 2 joue ;
- contact présent : rien ne change ;
- agent éteint : rien ne change ;
- un seul événement pour deux messages du même contact.

### 5. L'exécuteur

**Fichiers :**

- `src/workflow/executor.ts` ;
- `src/workflow/wiring.ts` ;
- `tests/executeur-inerte.ts` ;
- `tests/workflow-executor.test.ts` ;
- un test neuf sur la chaîne réelle de la réponse imprévue.

**À retirer :** la dépendance `retenirApresModele`, son appel après `sendTemplate` et la fixture `aucuneRetenue`.

**Test attendu, sur la chaîne réelle** (`creerControleDuFil` avec un dépôt en mémoire, pas des fixtures qui
répondent `mba`) : une réponse en texte libre plus récente que notre dernier envoi est confiée tout de suite, et
`reponse_hors_parcours` part avec son contenu.

### 6. Réglages, routes et console

**Fichiers :**

- `src/mba/client.ts` : retirer `takeThread` et l'action `take`. `modifierSettings` écrit toujours
  `ai_audience: 'ALLOWLISTED_ONLY'` ;
- `src/mba/activation.ts`, la route `rollout` de `src/http/mba.ts` et `src/mba/assistant/application.ts`
  (`mettreEnService`) : l'ordre audience, relecture GET, puis `rollout.enabled` ;
- `src/http/mba.ts` : le PATCH refuse `aiAudience` (400, avec un message), et les trois routes `allowlist`
  disparaissent ;
- `web/components/MbaOverviewPanel.tsx` : le choix d'audience disparaît ;
- `web/components/MbaAllowlistPanel.tsx` : supprimé ;
- `web/lib/api-mba.ts` : les fonctions de la liste et `aiAudience` disparaissent ;
- les e2e `mba-parametres-overview` et `accueil-settings`, et le support `web/e2e/support/mba.ts` ;
- `scripts/mba-activer-restreint.mts` : supprimé ;
- les tests `mba-client`, `http-mba`, `mba-activation` et `mba-handoff-sweep`.

**Tests attendus :**

- toute écriture des réglages porte `ALLOWLISTED_ONLY` ;
- l'allumage fait l'audience, la relecture, puis le `rollout`, dans cet ordre ;
- le PATCH avec `aiAudience` rend 400 ;
- un test d'inventaire : plus aucune occurrence de `takeThread` ni de `'take'` dans `src/`.

### 7. Purge RGPD

**Fichiers :**

- `src/crm/contact-store.pg.ts` (`purgeMany`) ;
- `src/http/contacts.ts` (la route de purge) ;
- les tests d'intégration de la purge.

**Interfaces :** `purgeMany` supprime les lignes `mba_liste` des contacts purgés dans sa transaction et les rend.
Après la validation, la route appelle le retrait chez Meta pour chacune, en best-effort journalisé.

**Tests attendus :** la ligne supprimée et rendue (intégration), et le retrait chez Meta appelé après la validation
(unitaire sur la route).

### 8. Documentation

Mettre à jour, au présent, sans récit :

- `documentation.md` : la section sur le contrôle du fil. `take` n'existe plus, la liste est l'interrupteur, et la
  réécriture du `standby` ;
- `features.md` : ce que fait l'agent de Meta pendant un scénario, et le mode liste toujours posé ;
- les fiches d'aide qui parlent d'audience ou de liste (à chercher dans `docs/aide/fiches`) ;
- `todo.md` : l'entrée « Scinder le PUT d'activation » est faite.

⚠️ Ne pas toucher au compteur de migrations de `CLAUDE.md` : il se met à jour quand la migration est appliquée.

## Vérifications avant de rendre la main

Dans l'export :

- `npm run typecheck` ;
- `npm test`. Quatre échecs connus, locaux seulement : `mba-outils-parite`, `migration-directives` (0096),
  `prix-bornes` et `workflow-graphe-fige`. Les signaler s'ils sont là, et tout autre échec est à corriger ;
- `cd web && npx tsc --noEmit`, puis le lint de `web`.

Rendre :

- la liste exacte des fichiers touchés, créés et supprimés ;
- le patch ;
- les tests ajoutés, et pour chacun, comment il a été vu échouer.

## Ordre de déploiement

1. CI lue job par job (`gh run view <id> --json jobs`).
2. VPS, dans cet ordre :
   1. `build` de l'image ;
   2. `ls` des migrations dans l'image ;
   3. lecture de `pg_stat_activity` ;
   4. `migrate` (0195 crée une table que le code neuf lit sur le chemin chaud, donc elle passe **avant** le `up`) ;
   5. relecture en base ;
   6. `up -d --build mba-api mba-worker` ;
   7. rechargement de NPM, puis contrôle public.
3. La console part au `push` et n'appelle aucune route neuve : pas de fenêtre de 404.
4. GET des réglages et de la liste du numéro : `ALLOWLISTED_ONLY`, liste vide.
5. L'essai réel.

## Méthode de livraison

**Implémenteur unique, puis une relecture du diff**, parce que ce lot touche la réception de chaque message et
l'envoi de chaque modèle. Ses invariants ne se voient pas à la lecture : l'ordre des écritures chez Meta et en base,
la réécriture du champ à l'arrivée, et une garde requise dans la fabrique. Déploiement s'il n'y a pas de rouge ; les
jaunes se poussent après.

L'essai réel qui clôt la feature, sur le numéro de Julien :

1. Club Med lancé depuis l'Inbox, bouton : l'agent se tait.
2. Texte libre à la place du bouton : l'agent répond, et le contact est sur la liste.
3. Club Med relancé : le contact est retiré de la liste avant le modèle, et au bouton l'agent se tait.
4. Message spontané : l'agent répond.
5. Campagne de modèle seul, devenir « l'agent de Meta » : l'agent répond.
6. « Rendre la main » puis un message du client : l'agent répond.
