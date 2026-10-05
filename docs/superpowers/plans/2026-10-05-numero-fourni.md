# Lot 3b : le numéro fourni côté client, plan

Spec : `docs/superpowers/specs/2026-10-05-numero-fourni-design.md`. Plan court : tâches, interfaces, tests attendus,
ordre de déploiement. Le code se lit dans origin (l'arbre partagé peut être en retard) ; commits en plomberie.

## Méthode de livraison

**Implémenteur par lot + revue humaine du diff**, en deux livraisons, chacune avec sa relecture indépendante, parce
que la production emprunte ces chemins : l'inscription de TOUS les clients (`/embedded-signup/complete`), une
migration, le montant d'un crédit offert, et des écritures chez Meta qui consomment des essais limités. Le code porte
des invariants invisibles (le CHECK à sens unique de l'espace, l'unicité par espace, une offre par espace). Aucun
workflow multi-agents.

**Mesure avant la chaîne** (tâche 0) : ce que Meta renvoie sur une fin sans numéro, et s'il nous laisse ajouter un
numéro au compte du client, ne sont pas documentés ; la livraison B ne s'écrit qu'après.

**L'essai réel qui clôt** : sur un espace créé depuis Claude Code, avec un portefeuille Meta qui a une place libre,
« Fournissez-moi un numéro », la fenêtre finie sans numéro, la page suit les étapes et le numéro est actif en
quelques minutes, sans que le client ait tapé ni numéro ni code ; crédit offert de 1 € ; alerte Telegram de réserve
basse reçue.

## Contraintes globales

- Aucun tiret long dans le code, les commentaires et les docs.
- Toute réponse de Meta en `safeParse`, jamais `as` ; `tenant_id = $1` sur chaque requête d'espace.
- Dépendances requises, jamais optionnelles (un câblage qui oublie doit ne pas compiler).
- Toute file neuve dans `BASE_QUEUES` (`src/queue/names.ts`) et `QUEUE_POLLING_SECONDS`.
- Migration écrite au numéro libre relu dans origin (0211 au 2026-10-05), appliquée AVANT le `up`.
- La console n'est poussée qu'après le déploiement de l'API qui porte ses routes.

## Points de vigilance (non couverts par la spec, chacun avec son test dans sa tâche)

1. Deux démarrages pour le même espace (double clic, deux onglets) : un seul numéro attribué, le second rend 409.
2. Le client ferme la page en pleine chaîne : la chaîne continue dans le worker, et la page rouverte montre l'étape.
3. Le client, dans le parcours « fourni », termine la fenêtre AVEC son propre numéro : on relie le sien (chemin
   actuel), et aucun numéro de la réserve n'est attribué.
4. Le code est mal transcrit (aucun code certain) : l'échéance de 3 minutes met la connexion en « code absent »,
   et « Relancer » redemande un appel.
5. Le compte du client porte déjà deux numéros : message « compte plein », numéro gardé jusqu'à « Réessayer » ou
   « Abandonner » (ce dernier le rend à la réserve).

## Livraison A : le compte sans numéro, puis la mesure

**Tâche 1. Accepter un compte WhatsApp sans numéro**
- `src/account/es-store.pg.ts` : `lierCompteSansNumero({ tenantId, wabaId })` écrit la ligne `waba` de l'espace sans
  `phone_numbers` (refus si l'espace a déjà un numéro, ou si le compte appartient à un autre espace).
- `src/http/embedded-signup.ts`, `/embedded-signup/complete` : un compte unique SANS numéro ne rend plus 422 ; après
  `verifyWaba`, il passe par `lierCompteSansNumero`, `saveCredentials` (jeton, PIN nul) et `subscribeApp`, et rend
  200 `{ sansNumero: true }`. Journal `es_complete_sans_numero` avec l'événement de la fenêtre.
- `web/lib/connexion-numero.ts` : l'écoute garde le `waba_id` seul et le nom de l'événement (`FINISH_ONLY_WABA`),
  et les poste ; l'Accueil affiche « compte relié, sans numéro » sur `sansNumero`.
- Tests : compte sans numéro (200, jeton gardé, ligne `waba`, aucun `phone_numbers`) ; compte d'un autre espace (409) ;
  le parcours avec numéro inchangé ; intégration de `lierCompteSansNumero`.
- Déploiement : relecture, CI, `up` de l'API, PUIS push de la console.

**Tâche 0. La mesure chez Meta** (après la tâche 1 en production)
1. Julien passe la fenêtre sur un espace de test, dans un portefeuille qui a une place libre, et finit sans numéro.
   On lit : l'événement et ses champs (journal du navigateur et du serveur), le jeton gardé, la ligne `waba`.
2. Avec l'accord explicite de Julien (écriture chez Meta), un script ponctuel dans `mba-api`, avec le jeton de
   l'espace : `addPhoneNumber` (d'abord `cc: '44'` et le numéro national ; sur refus, le numéro complet), puis
   `requestCode` en appel, le code lu par le pont dans `codes_verification`, `verifyCode`, `register`.
3. Consigner dans la spec (§ 2), le document privé et le Claude Doc : les champs de l'événement, le format accepté,
   les codes d'erreur, la langue dictée. Puis le sort du numéro de test : retiré du compte de test et rendu à la
   réserve, ou un numéro de Londres acheté par Julien pour l'essai réel.
4. **Repli** si Meta refuse l'ajout : la livraison B garde l'attribution, l'alerte et le crédit, et la page fait taper
   le numéro attribué au client dans la fenêtre, en lui affichant le code capté.

## Livraison B : la chaîne, les routes, la page

**Tâche 2. Migration 0211 et magasin**
- `tenants.origine` (`console` par défaut, CHECK `console` ou `claude_code`), sans reprise.
- `numeros_fournis` : statut `bloque` ajouté au CHECK ; index unique partiel `(tenant_id) where statut = 'attribue'`.
- Table `connexions_numero` (une ligne par espace, cascade sur l'espace) : `numero_id` (set null), `waba_id`,
  `nom_affiche`, `etape` (CHECK : `attribue`, `ajoute`, `code_demande`, `actif`, `echec`), `cause` (CHECK :
  `compte_plein`, `numero_indisponible`, `code_absent`, `activation`, `reserve_vide`), `phone_number_id`,
  `code_demande_le`, `maj_le`. L'état vit ici et non sur le numéro, qui peut quitter l'espace en cours de route.
- `src/otp/store.pg.ts` : `attribuer(tenantId)` (une instruction, `for update skip locked`, rend le numéro ou `null`),
  `rendreALaReserve(numeroId)`, `bloquer(numeroId)`, `codeRecuDepuis(numeroId, depuis)` (le dernier code non nul reçu
  après la demande), `compterLibres()`. Un magasin `connexions` : `ouvrir`, `lire(tenantId)`, `avancer`.
- Tests d'intégration : deux espaces et un numéro libre, un seul gagnant ; unicité par espace ; `bloque` sans espace ;
  `codeRecuDepuis` ignore les codes antérieurs et les échecs ; lecture filtrée par espace.

**Tâche 3. Le crédit offert selon l'origine**
- `creerEspaceParGoogle` prend l'origine : `claude_code` depuis `src/http/oauth.ts`, `console` depuis `/auth/google`.
- `CREDIT_OFFERT_CLAUDE_CODE_MICRO_EUR` (1 € par défaut) dans `src/config.ts` ; `offrirCredit` choisit le montant
  selon `tenants.origine`, sur les deux chemins (fourni et apporté).
- Tests : 1 € pour `claude_code`, 5 € pour `console`, toujours une seule offre par espace ; l'espace créé par OAuth
  porte `claude_code`.

**Tâche 4. La chaîne en tâche de fond (file `numero-fourni`)**
- Le travail lit la connexion de l'espace et avance d'une étape : ajouter le numéro (`phone_number_id` gardé), demander
  le code en appel (`code_demande_le`), puis, au code reçu : `verifyCode`, `register` (PIN tiré, gardé chiffré),
  `linkTenant`, crédit offert, `actif`. Un second envoi différé de 3 minutes déclare `code_absent` si rien n'est venu.
- Le pont (`src/http/otp-pont.ts`) relance la file quand il écrit un code pour un numéro attribué dont la connexion
  attend (`code_demande`). Dépendance requise.
- Erreurs de Meta : compte plein (on garde le numéro, `echec/compte_plein`) ; numéro refusé (`bloquer`, Telegram, une
  seule réattribution automatique, sinon `echec/reserve_vide`) ; `register` refusé (`echec/activation`).
- Tests avec un faux Meta : chaque étape, chaque échec, la relance par le pont, l'échéance, l'idempotence d'un
  travail rejoué (vigilance 2), le compte plein (vigilance 5), le code mal transcrit (vigilance 4).

**Tâche 5. Les routes de l'espace et l'alerte**
- Module de classe `tenant` : `POST /tenants/:tenantId/numero-fourni` (`{ nomAffiche }` ; exige le compte gardé par
  la tâche 1 et aucun numéro ; attribue, ouvre la connexion, enfile ; 409 si une connexion existe déjà, réserve vide :
  `echec/reserve_vide`), `GET` (étape, cause, numéro affiché ; jamais le code), `POST .../relancer`,
  `POST .../abandonner` (rend le numéro).
- L'alerte : après chaque attribution et sur réserve vide, `compterLibres()` sous `ALERTE_RESERVE_SEUIL` (3) : Telegram
  sous le verrou court `numeros.reserve-basse` de 24 heures.
- Tests : le double démarrage (vigilance 1), l'espace qui a déjà son numéro (vigilance 3), l'isolation par
  `tests/scope-tenant.test.ts`, l'alerte une seule fois sur 24 heures.

**Tâche 6. La page « Connecter WhatsApp »**
- `web/app/connecter-whatsapp/page.tsx` : les deux choix ; « fourni » : nom affiché (prérempli), consigne « continuer
  sans numéro », fenêtre Meta, `complete`, puis `POST numero-fourni` et suivi par `GET` toutes les 3 secondes ; un
  message et un bouton par cause d'échec. « Apporté » : le parcours actuel. L'Accueil sans numéro y mène.
- `web/lib/api/` : les fonctions et leurs types. Tests de la console selon les gardes du dépôt (formes, icônes).
- Docs : `features.md` (fiches d'aide vérifiées par `aide-proposer`), `documentation.md`, `wip.md`.

## Ordre de déploiement

1. **Livraison A** : relecture, CI job par job, `up` de l'API et des workers, push de la console. Puis la tâche 0.
2. **Livraison B** : relecture, CI job par job ; migration 0211 AVANT le `up` de l'API et des deux workers (le worker
   porte la chaîne), relue en base, compteur de `CLAUDE.md` mis à jour ; contrôle public ; puis push de la console.
3. **Essai réel** (ci-dessus), puis la réserve réapprovisionnée par Julien.
