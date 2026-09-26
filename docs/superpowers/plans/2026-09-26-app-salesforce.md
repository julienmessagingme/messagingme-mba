# L'app Salesforce d'Engage Me : plan de livraison (L0 à L5)

**But** : le pendant de HubSpot pour le Salesforce « core » : remonter le quali sur les fiches, un segment
Salesforce en audience de campagne, une transition Salesforce qui déclenche un scénario, une carte sur la fiche
qui envoie un WhatsApp.

**Spec** : `docs/superpowers/specs/2026-09-26-app-salesforce-design.md`, AMENDÉE le 2026-09-26 (§ « Les
amendements »). Elle fait foi sur le QUOI ; ce plan dit le COMMENT dans le code existant, établi par une
cartographie en lecture seule du dépôt (sept sous-systèmes) le même jour.

**Pile** : Fastify, pg-boss, Postgres (schéma `salesforce` neuf), Next.js (`web/`), et un package géré 2GP
Salesforce (Apex, LWC, métadonnées) dans un sous-dossier `salesforce/` du dépôt.

## Méthode de livraison

**En direct pour L0**, parce que ce sont des mesures sur deux orgs de test, sans code de production.
**Implémenteur par lot, puis revue humaine du DIFF et une relecture indépendante en fin de lot, pour L1 à
L5**, parce que la production emprunte ces chemins (envois, appels entrants signés, migrations, écritures dans
le système d'un client) et que le code porte des invariants invisibles : consentement (un STOP ne se lève jamais
par machine), doublons de fiche, quota d'API du client, un seul écrivain par objet, isolation entre espaces sur
un pool superuser. Deux « oui » en haut de la grille.

**L'essai réel qui clôt la feature**, sur une org qui n'est pas la nôtre (un essai Enterprise ou la sandbox d'un
prospect) : quelqu'un installe le package en suivant SEULEMENT le guide ; Julien envoie un WhatsApp depuis la
carte vers son téléphone, répond, et voit l'analyse arriver en activité ; il passe une opportunité à l'étape
surveillée et le scénario part ; il lance une campagne sur une Campaign Salesforce et voit les statuts de
membres bouger. Chaque lot a en plus son propre essai réel, écrit à sa fin.

## Contraintes globales

- **Ni `UChat` ni tiret cadratin** dans le code, les écrans et les docs ; chaque chaîne de la console en
  `t('fr', 'en')`, en vouvoyant.
- **`tenant_id = $1` sur chaque requête** du store du connecteur. Trois exceptions transverses seulement, nommées
  et COMPTÉES par un test : la résolution d'une org par son identifiant (signature entrante), la liste des
  espaces connectés (émetteur de signaux), les purges par date.
- **Aucune jointure, lecture croisée, clé étrangère ou transaction** entre `public` et `salesforce`. Aucun
  fichier hors de `src/salesforce/` ne nomme une table `salesforce.*` (test). Le cœur parle au connecteur par
  des méthodes du store, jamais par SQL.
- **Toute requête `salesforce.*` est qualifiée** (le dépôt est search_path-agnostique,
  `tests/db-session-agnostic.test.ts`), et aucun `set search_path` dans une migration.
- **`safeParse` sur tout corps entrant et toute réponse de Salesforce**, jamais `parse` ni `as`.
- **Toute URL saisie par un client** (l'adresse My Domain) passe par une garde textuelle stricte,
  `resolutionPublique` au clic « Connecter », puis `fetchPublic` (`redirect: 'error'`) et `lireCorpsBorne` pour
  CHAQUE appel ; les deux inventaires de `tests/lib-adresse-privee.test.ts` s'étendent.
- **Un refus métier ne sort jamais en 5xx** (Cloudflare remplace le corps) **ni en 401** vers la console
  (`request()` déconnecterait l'admin) : 409 ou 422, avec l'étape du guide qui règle le manque.
- **Toute file neuve** entre dans `BASE_QUEUES`, `QUEUE_POLLING_SECONDS` (30 s) et `FILES_NOTIFIEES`, avec un
  consommateur dans le worker et `groupConcurrency` à côté de `concurrency` (`tests/queue-names.test.ts`).
- **Aucun chemin de masse n'émet d'événement d'automation** (import de segment, statuts de membres).
- **Toute écriture chez le client est coupée en DRY_RUN** (bloc `dryRun` du worker).
- **Dépôt public** : aucun secret dans `salesforce/` ni ailleurs ; `.gitignore` et `.forceignore` posés AVANT la
  première commande de l'outillage Salesforce ; secrets de test tirés au hasard.
- **Fichiers de câblage partagés** (`src/index.ts`, `src/server.ts`, `src/worker.ts`) : annonce aux autres
  sessions avant de les éditer, commit par plomberie (index temporaire sur `origin/main`), jamais `--only` sur
  eux.
- **Numéro de migration** : pris dans le DOSSIER au moment d'écrire le fichier, et la ligne « Dernière
  appliquée » de `CLAUDE.md` mise à jour DANS le commit qui prend le numéro ; relue en base après `migrate`.

## L0 : les mesures (en direct, aucun code de production)

**Prérequis, à faire par Julien** (je ne crée pas de compte et ne saisis aucun mot de passe) : créer deux orgs
Developer Edition gratuites, A (Dev Hub, namespace `engageme`) et B (joue le client), puis connecter l'outil
Salesforce du poste à A et à B par sa connexion navigateur.

1. `.gitignore` : `salesforce/.sf/`, `salesforce/.sfdx/`, `salesforce/.localdevserver/` ; `.forceignore` pour les
   réglages OAuth globaux de l'app, AVANT tout retrieve.
2. Dans A : Dev Hub, namespace `engageme` (repli `engagemeapp`), un package 2GP minimal portant une External
   Client App packagée (client credentials) et un champ ; version bêta ; installation dans B par son lien.
3. Les onze mesures de la spec (§ « Ce que le lot L0 doit mesurer »), plus : la forme exacte de la réponse du
   jeton (présence de `instance_url`, `id`, `expires_in`) et le renouvellement sur `INVALID_SESSION_ID` ; le
   vecteur de signature produit par l'Apex, identique octet pour octet à celui de `signRequest`
   (`src/lib/signature.ts`) ; un appel Apex vers `https://api.messagingme.app` sans défi Cloudflare.
4. Consigner dans `docs/salesforce-mesures-2026-09.md` (document de travail daté, aucun secret), et amender la
   spec là où une mesure la contredit AVANT L1 (notamment : l'algorithme de recherche par téléphone, et
   l'idempotence par External ID qui décide de la table d'idempotence de L2).

**Clôture** : chaque mesure a son résultat ; la recherche par téléphone a un algorithme écrit.

## L1 : le socle et la connexion

**Tâches**

1. **Migration `NNNN_salesforce_socle.sql`** : `create schema if not exists salesforce` ; `salesforce.orgs` (forme
   de la spec, § Les données : CHECK sur `etat` à quatre valeurs, `org_id` unique, `secret_entrant` en `text`
   nullable au format `v1.` de secretbox, AUCUNE clé étrangère vers `public`) ; et
   `tenant_settings.salesforce_actif boolean not null default false` sur le modèle exact de 0179. Additive,
   commentée, sans accent grave.
2. **Package v0.1** (`salesforce/`, projet sfdx) : External Client App packagée ; jeu de permissions
   `Engage_Me_Integration` (lecture et écriture des champs Engage Me, création de Lead et de tâche, mise à jour
   des membres de Campaign, lecture des Opportunités, rôles de contact, Campaigns, vues de liste, rapports) ;
   champs Engage Me sur Lead et Contact DÉRIVÉS de `NOMS_ATTRIBUTS` (`src/signaux/types.ts`), plus l'identifiant
   de conversation, la date du dernier entrant WhatsApp et la joignabilité WhatsApp ; objet de configuration
   (liste autorisée, transitions surveillées, identifiant de l'utilisateur d'intégration) ; paramètre protégé du
   secret et sa ressource Apex REST (`PUT` et `DELETE`, appelables par l'utilisateur d'intégration seulement) ;
   Named Credential vers `https://api.messagingme.app` sans préfixe. Classes de test Apex.
3. **`src/salesforce/my-domain.ts`** : `lireMyDomain(brut)` : `https://` seul, sans chemin, requête, port ni
   identifiants, hôte à suffixe accepté (liste de L0), en minuscules ; sert aussi à valider l'adresse rendue par
   le jeton.
4. **`src/salesforce/client.ts`** : client REST sur `fetchPublic` + `lireCorpsBorne` + `redirect: 'error'` +
   `AbortSignal.timeout` ; jeton client credentials mis en cache par process, renouvelé une fois sur
   `INVALID_SESSION_ID` ; `SalesforceApiError { status, errorCode, retryable, retryAfterMs }` classée sur
   `errorCode` (verrou de ligne et quota momentané rejouables, redirection lue « l'adresse de l'org a changé »,
   refus d'adresse interne terminal AVANT `withRetry`) ; lecture de `Sforce-Limit-Info`. Réutilise `withRetry` et
   `parseRetryAfter` (`src/meta/http.ts`), jamais `FetchTransport`.
5. **`src/salesforce/store.pg.ts`** : `PgSalesforceStore(pool, cleChiffrement)` sur le modèle de
   `PgIntegrationBatchStore` et `PgMfaStore` (chiffrement dans le store) : lire, écrire, supprimer l'org d'un
   espace ; `orgParIdentifiant(orgId)` (exception transverse 1) ; `espacesConnectes()` (exception 2) ; quota
   écrit seulement quand il change.
6. **`src/salesforce/connexion.ts`** : `connecter(tenantId, adresse)` dans cet ordre : garde textuelle,
   `resolutionPublique`, jeton, identifiant et édition de l'org, package présent et à la bonne version, droits
   posés ; puis secret tiré (`randomBytes(32)`) et écrit CHEZ NOUS en état `connexion`, posé dans l'org, et
   seulement alors `connectee`. Chaque manque rend `{ etape, message }` (ancres du tuto). `deconnecter` : efface
   dans l'org, puis supprime la ligne ; org injoignable : supprime quand même et le dit.
7. **Configuration** (`src/config.ts`, `.env.example`, `.env.prod.example`) : `SALESFORCE_CLIENT_ID` et
   `SALESFORCE_CLIENT_SECRET` (la paire entière ou rien, et exigent `ENCRYPTION_KEY` en production, modèles
   Zadarma et ES) ; `SALESFORCE_PACKAGE_VERSION` (l'identifiant de version qui fait les liens d'installation) ;
   `SALESFORCE_ENTRANT_PAR_MINUTE`, défaut 60 (servi en L4).
8. **Routes admin** (`src/http/salesforce.ts`) : `GET`, `POST /connexion`, `PUT /reglages`, `DELETE` sur
   `/tenants/:tenantId/integrations/salesforce`, sous `g.admin` et `scopeTenant` ; `POST /connexion` composé
   avec `gardeEtendue(garde, limiteCouteuse)` ; 503 lisible si le chiffrement n'est pas prêt (sonde
   `chiffrementPret`) ; audit sans secret. `PATCH /settings/salesforce-actif` (modèle `hubspot-actif` : 409 si une
   org est connectée, 503 si la vérification échoue) ; `GET /settings` ajoute `salesforceActif` et
   `salesforceEtat` (lecture du store, `.catch(() => null)`). Entrée `entree('salesforce', 'tenant', ...)` du
   registre.
9. **Écrans** : carte `ReglageSalesforce` dans `/parametres` (branche admin, après `ReglageHubspot`, ancre
   `#integration-salesforce`) ; page `web/app/parametres/salesforce/page.tsx` (installation, connexion, réglages,
   déconnexion), qui REFUSE elle-même un rôle non admin puisque `AppShell` y laisse entrer les managers ;
   `web/lib/api-salesforce.ts` (import direct, un seul `base()`) ; `web/lib/salesforce.ts` (fonctions pures) ;
   page publique `web/app/tuto-salesforce` avec une ancre stable par étape ; carte « Salesforce » dans « Canaux
   et services » de l'Accueil (ambre quand l'org est coupée).
10. **Docs** : `documentation.md` (le schéma `salesforce`, la couture du store, les exceptions transverses),
    `DEPLOY.md` (quatre schémas, secret entrant des orgs indéchiffrable sans `ENCRYPTION_KEY`), et
    `.github/workflows/ci-salesforce.yml` filtré sur `salesforce/**` (analyse statique Apex). ⚠️ `salesforce/**`
    ne va PAS dans le `paths-ignore` de `ci.yml` : des tests racine lisent le package.

**Tests attendus**

- Migration : le schéma existe une fois, tables qualifiées, aucune clé étrangère sortante, aucun `search_path`,
  aucun accent grave, additive.
- Isolation (`tests/salesforce-isolation.test.ts`, modèle `signaux-isolation`) : chaque requête du store porte
  `tenant_id = $1` sauf les exceptions COMPTÉES ; aucun fichier hors de `src/salesforce/` ne nomme une table
  `salesforce.*`.
- `lireMyDomain` dans les deux sens ; client : `fetchPublic` seul (inventaire), redirection traduite, refus
  interne non rejoué, classement par `errorCode`, réponse illisible refusée, un seul renouvellement de jeton.
- Connexion : l'ordre des écritures (une panne entre l'écriture chez nous et la pose dans l'org ne laisse jamais
  `connectee`) ; un manque rend 422 et jamais 401 ; déconnexion d'une org injoignable.
- Routes : agent refusé, espace d'un autre client refusé, 503 sans chiffrement, audit sans secret ; interrupteur
  (409, 503, admin, booléen strict) ; gardes de configuration dans les deux sens ; `scope-tenant` passe seul.
- Web : `salesforce.test.ts` (un réglage absent n'est jamais « éteint » ; la source et le déclencheur restent
  MASQUÉS tant que l'état n'est pas `connectee`) ; e2e : carte invisible pour un manager, page de connexion,
  tuto public ; parité des ancres du tuto avec les étapes rendues par le serveur.
- Intégration (CI seulement) : isolation entre deux espaces, unicité de l'org, zéro clé étrangère sortant du
  schéma, nettoyage explicite des lignes `salesforce.*` (aucune cascade ne le fait).

**Déploiement** : build, `migrate` (le schéma et la colonne), relecture en base (dont
`has_schema_privilege('anon', 'salesforce', 'usage')` à faux), `up`, puis la console (interrupteur éteint par
défaut). **Essai réel** : connecter l'org B depuis la page, voir les manques en clair quand un droit manque,
déconnecter.

## L2 : remonter le quali

**Tâches**

1. **Migration** : `salesforce.fiches` (uniques `(tenant_id, contact_id)` et `(tenant_id, sf_id)`, identifiants
   en 18 caractères) et `salesforce.echecs` (index `(tenant_id, at desc)`) ; plus la table d'idempotence si L0 a
   montré qu'aucun External ID d'activité n'est possible.
2. **Code partagé des signaux** : `completerSignal` reçoit le critère d'identité de l'adaptateur en paramètre
   (Batch passe `identifiantPoussable`, Salesforce « toujours »), comme son en-tête le prévoit ;
   `ContactDuSignal` gagne le téléphone et le nom WhatsApp ; le contenu de `em_conversation_analyzed` gagne
   l'identifiant de conversation (sans toucher `CHAMPS_EVENEMENT`). La destination Salesforce s'ajoute aux DEUX
   émetteurs (`src/index.ts`, `src/worker.ts`) avec son `cacheCourt`, invalidé à la connexion, à la déconnexion
   et à la coupure.
3. **`src/salesforce/vers-salesforce.ts`**, fonction PURE sur le modèle de `versBatch` : regroupement par fiche,
   état courant relu, `null` n'est pas 0, résumé seulement si `envoyer_resume`, tâche ouverte sur action
   suggérée, STOP WhatsApp vers le champ du client (valeur « non »), jamais un STOP RCS, jamais l'écho d'un
   consentement venu de Salesforce.
4. **`src/salesforce/fiche.ts`** : lien connu, sinon recherche par téléphone (algorithme de L0), Contact avant
   Lead, sinon création d'un Lead (`Sforce-Auto-Assign` si une règle d'attribution est active, sinon le
   propriétaire de repli ; société vide si l'org a les comptes personnels ; origine du Lead seulement si la
   valeur existe) ; Lead converti suivi jusqu'au Contact ; upsert par External ID si L0 le permet.
5. **`src/salesforce/travail.ts`** : `creerTravailSignauxSalesforce(deps)` sur le modèle de
   `creerTravailSignauxBatch` : job relu par `safeParse` ; org relue (pas `connectee` : rien) ; TRI sur les
   signaux bruts avant complétion (clics écartés ; accusés gardés seulement pour un envoi depuis la fiche, en
   L5) ; poussée par collections de 200 ; refus définitif vers `salesforce.echecs` (message borné et nettoyé) ;
   jeton refusé : `coupee`, motif, cache invalidé ; rejouable : on lève ; quota proche : on réenfile avec
   `startAfter` au lieu de lever.
6. **File `signaux-salesforce`** : `BASE_QUEUES`, 30 s, non notifiée, consommée par le worker (concurrence 2,
   `groupConcurrency` 1).
7. **Joignabilité** : `flagUnreachable` du balayage des relances est composé, dans le bloc `dryRun` du worker,
   avec une écriture Salesforce en best-effort (échec vers `salesforce.echecs`).
8. **Journal des erreurs** : `listerEchecsPourJournal` du store ; fusion en mémoire par une fonction pure
   exportée de `src/ops/erreurs-livraison.pg.ts`, câblée dans l'API (la requête de `listerEchecsSysteme` et son
   constructeur ne bougent pas) ; une source illisible le DIT au lieu de rendre une liste vide ; l'écran nomme
   Salesforce (`quiAppelait`). **Et Batch se nomme aussi** : son travail journalise sous un libellé qui dit
   « Batch » ; la documentation publique des signaux, elle, ne nomme toujours aucun outil
   (`tests/web-signaux-parite.test.ts` inchangé).
9. **Purge RGPD** : `oublierContacts(tenantId, ids)` du store (liens et journaux), composé AVANT `purgeMany`
   dans le câblage ; rien n'est écrit chez le client.
10. **Rétention** : étape `salesforce-echecs` du balayage `retention-generale` (90 jours, constante en dur).
11. **Réglages** : choix du champ de consentement par objet (cases à cocher et listes de sélection lues dans
    l'org ; pour une liste, les valeurs « oui » et « non »), recherche du propriétaire de repli (`?q=`,
    utilisateurs actifs), case « envoyer le résumé ».

**Tests attendus**

- `vers-salesforce` : parité des champs avec `NOMS_ATTRIBUTS` ET avec les `*.field-meta.xml` du package (test
  qui lit `salesforce/`) ; résumé seulement avec l'option ; STOP RCS jamais dans le champ WhatsApp ; aucun écho.
- `fiche` : l'ordre (lien, recherche, création), Contact prioritaire, Lead converti, attribution.
- Travail : hors contrat lève ; définitif journalisé sans bloquer la tranche suivante ; jeton refusé coupe et
  invalide ; rejouable lève ; quota réenfile ; accusés de campagne jamais poussés.
- Émetteur à DEUX destinations (une en panne n'empêche pas l'autre) ; `completerSignal` avec le critère Batch
  rend exactement l'ancien résultat ; câblage lu dans le texte ; `queue-names` ; purge composée ; fusion du
  journal (et source illisible) ; Batch nommé dans son journal.
- Intégration (CI) : unicités de `fiches`, lecture du journal, purge, rétention.

**Déploiement** : migration, `up`, CI lue job par job. **Essai réel** : une conversation analysée sur l'espace
branché à l'org B arrive en activité sur la bonne fiche ; un inconnu devient un Lead ; un STOP met « non » dans
le champ du client.

## L3 : un segment Salesforce en audience

**Tâches**

1. **Migration** : `salesforce.campagnes` (la Campaign d'où vient une campagne) et `salesforce.membres` (envoyé,
   répondu, et ce qui est poussé), avec les index PARTIELS qui reprennent mot pour mot le `where` du balayage de
   poussée.
2. **Routes** (sur `/tenants/:tenantId/integrations/salesforce`) : lister les segments (`?type=` Campaign, vue de
   liste, rapport, `&q=`), `available: false` sans aucun appel réseau quand l'org n'est pas connectée ou
   l'interrupteur éteint ; importer un segment : membres lus (Campaign en SOQL paginé ; vue de liste par sa
   requête ; rapport exécuté, refusé en 422 au-delà de 2 000 lignes ou sans colonne téléphone), téléphones
   normalisés (`normalizePhone`), consentement par personne, liens `fiches` écrits, tag `Salesforce: <nom>`
   borné. Rend les identifiants EXACTS des contacts.
3. **Écriture des contacts** : une variante de `upsertManyByPhone` qui rend les identifiants et ne relève JAMAIS
   un `opted_out` ; deux lots (consentement « oui », puis le reste).
4. **Création de campagne** : `POST /campaigns` accepte `sourceSalesforce` (type, identifiant, libellé) AVEC les
   `contactIds` de l'import ; il écrit `salesforce.campagnes` et `salesforce.membres` par le store. Pour une
   Campaign : les statuts « Engage Me : envoyé » et « Engage Me : a répondu » (compté comme réponse) créés sur
   la Campaign, de façon idempotente.
5. **Envoyé** : `TentativeEnvoi` gagne `tenantId` (contrat du moteur, `satisfies` de
   `tests/campagne-cablage.test.ts`) ; `noterEnvoi` composé dans le bloc `dryRun` du worker marque
   `membres.envoye_le`. **A répondu** : sur `em_replied`, le travail de L2 attribue au dernier envoi de moins de
   7 jours (règle du funnel). **Poussée** : une tâche minutée du worker pousse les statuts en attente par
   collections de 200.
6. **Écran** : source « Salesforce » dans `EtapeAudience` (visible seulement si l'état est `connectee`), panneau
   qui choisit et importe puis affiche le compte ; `SourceAudience` gagne `salesforce` ; brouillon et
   `entreeDeCreation` transmettent la référence et les identifiants.

**Tests attendus** : import (fermé sans appel réseau ; rapport trop gros ou sans téléphone ; « oui » pose
l'opt-in source `salesforce` ; « non » ne touche rien ; un `opted_out` n'est JAMAIS relevé, vérifié dans les deux
sens) ; création exclusive des autres désignations et plafonnée ; statuts idempotents ; attribution de la
réponse (fenêtre, dernier envoi gagne) ; poussée coupée en DRY_RUN ; web (audience, brouillon, création) ; e2e
de visibilité (masquée sans le drapeau).

**Déploiement** : migration, `up`, puis la console. **Essai réel** : une campagne sur une Campaign de l'org B,
les statuts de membres qui passent à « envoyé » puis « a répondu ».

## L4 : une transition Salesforce déclenche un scénario

**Tâches**

1. **Package** : déclencheurs Apex sur Opportunity (changement d'`StageName`, jamais la création), Lead
   (`Status`) et CampaignMember (`Status`, une Campaign visée) : seulement les transitions surveillées de l'objet
   de configuration, jamais une modification de l'utilisateur d'intégration, par lots de 200 ; téléphone,
   consentement, identifiants et nom résolus dans l'org (contact principal pour une opportunité) ; boîte d'envoi
   (objet des notifications, envoi asynchrone par lots, rejeu planifié en respectant `retry-after`, expiration à
   72 h) ; signature au format `verifyRequest`, chemin exact.
2. **Migration** : `salesforce.notifications_recues` (clé `(tenant_id, notification_id)`).
3. **Route `POST /salesforce/v1/notifications`** (`src/http/salesforce-entrant.ts`) : classe d'accès neuve
   `signature-salesforce` (union `ClasseDAcces`, justification écrite, compte des classes corrigé dans
   `CLAUDE.md` et `documentation.md`) ; montée seulement si la clé d'app est posée ; en-tête d'org vérifié par
   forme ; budget commun silencieux des orgs inconnues ; org résolue, secret déchiffré ; `verifyRequest` (5 min) ;
   PUIS le plafond par org (60, seau « notifications ») ; lot de 200 au plus par `safeParse` ; pour chaque
   notification : doublon ignoré, contact créé ou retrouvé (jamais un STOP relevé, « oui » pose l'opt-in),
   lien `fiches`, publication par `enfilerEvenementAutomation`, et SEULEMENT ENSUITE l'inscription dans
   `notifications_recues` ; réponse par notification ; 5xx seulement si la file est tombée.
4. **Déclencheur `salesforce_transition`** sur les six sites de `hubspot_deal_stage` (liste, événement,
   correspondance stricte, lecture du job, `kindsFor` rendu exhaustif, validation du couple objet-champ) ; miroir
   web et un test de parité du miroir (absent aujourd'hui).
5. **Synchronisation des transitions surveillées** vers l'objet de configuration : à la création, modification,
   suppression et bascule d'une automation Salesforce (dépendance REQUISE de `registerAutomations`), à la
   connexion, et une fois par heure contre la dérive ; un échec est dit à l'écran (« enregistrée, pas encore
   active dans Salesforce »).
6. **Route des valeurs** `GET .../integrations/salesforce/transitions` : étapes, statuts de Lead, statuts de
   membres d'une Campaign.
7. **Écran Automation** : option masquée hors `connectee`, valeurs chargées une fois (garde par `ref`), groupées
   par objet, clé du menu sans séparateur textuel, rappel « le scénario doit commencer par un template ».
8. **Rétention** : étape `salesforce-notifications` (7 jours, constante strictement supérieure aux 72 h de la
   boîte d'envoi).
9. **`scripts/auto-attaque.mts`** : fausse autorité avec un VRAI secret tiré au hasard, classe ajoutée à
   `AUTORITE_DANS_L_APPEL`, sonde 14 (sans signature, signature fausse, org inconnue : 401).

**Tests attendus** : vecteur d'or de la signature (TS et Apex, même hex) et tests directs de `verifyRequest` dans
les deux sens ; route (non signé, faux, périmé, altéré, org inconnue : 401 et rien de publié ; plafond pris
après la signature ; réponse par notification ; rejeu ignoré ; publication avant l'inscription ; file tombée :
5xx et rien d'inscrit ; STOP non relevé ; contact créé avec son nom) ; bout en bout (la route publie,
`parseAutomationEventJob` accepte, `matchesTrigger` déclenche) ; correspondance, lecture du job, validation ;
synchronisation appelée sur chaque changement ; parité du miroir ; ordre des deux rétentions (lit la constante
Apex) ; `scope-tenant` et auto-attaque ; e2e de l'option.

**Déploiement** : migration, `up` de l'API, puis la version du package qui porte les déclencheurs installée
dans l'org B, puis la console. **Essai réel** : une opportunité passée à l'étape surveillée dans l'org B démarre
le scénario sur le téléphone de Julien.

## L5 : la carte et l'envoi depuis la fiche

**Tâches**

1. **Extraction du pipeline d'envoi** de `registerV1Sends` (de la résolution du numéro à `createSend`) vers
   `src/api/envoi.ts`, qui prend `tenantId` en paramètre et rend un rapport ou un refus ; `/v1/sends` garde le
   compteur d'usage, l'idempotence et l'enfilement ; les dépendances d'envoi deviennent UN objet transmis d'un
   seul spread aux deux routes ; les exports lus par `tests/api-exemples.test.ts` restent sur
   `src/http/v1-sends.ts`.
2. **File dédiée `envoi-unitaire`** : même job que `campaign-run` (`campaignRunJob`), groupe distinct, même
   frein de débit par numéro (l'arbitre Meta reste partagé).
3. **Migration** : `salesforce.modeles_autorises` (template, ou scénario avec sa catégorie et, s'il ouvre par un
   message de session, son bloc d'entrée) et `salesforce.envois` (clé d'idempotence unique par espace, sans clé
   étrangère vers `campaigns`).
4. **Route `POST /salesforce/v1/envois`** : même classe et même plomberie que les notifications, seau
   « envois » ; liste autorisée ; clé d'idempotence par clic ; note de qualité rouge refusée (`PgQualityProvider`
   câblé dans l'API) ; pipeline extrait (consentement, fenêtre, numéro délié) ; campagne « [Salesforce]
   <libellé> » avec `assignation: 'personne'` sur le membre qui a l'e-mail du commercial (lecture neuve,
   bornée à l'espace, critères de `membresAffectables`) ; enfilée sur `envoi-unitaire` ; `envois` écrit ; réponse
   `{ ok, motif }` par un `switch` exhaustif.
5. **Remontée des envois** : une tâche minutée du worker (DRY_RUN respecté) crée l'activité « WhatsApp envoyé »
   au nom du commercial et fait suivre son statut, monotone (un accusé arrivé avant la tâche est gardé et
   appliqué à sa création) ; un échec à l'envoi (aucun wamid) passe par `noterEnvoi` ; un scénario dit « scénario
   démarré ». Sur `em_replied`, le dernier envoi de moins de 7 jours reçoit sa réponse, et une tâche « a
   répondu » part au commercial ; le fil est affecté par le chemin de campagne existant. Le champ du dernier
   entrant WhatsApp suit `em_replied` sur le canal WhatsApp.
6. **Package** : la carte LWC sur Lead, Contact et Opportunité (dernière analyse, fenêtre de 24 h, lien vers le
   fil ; créer une opportunité en rattachant l'ouverte, planifier un rappel, en mode utilisateur ; envoyer par
   un contrôleur Apex, jamais depuis le navigateur) ; tests Apex et Jest des LWC ; version PROMUE, dont
   l'identifiant alimente `SALESFORCE_PACKAGE_VERSION`.
7. **Écran** : éditeur de la liste autorisée dans la page Salesforce, synchronisé vers l'objet de configuration
   comme les transitions.

**Tests attendus** : toute la suite `tests/v1-sends.test.ts` et les expressions de `tests/v1-cablage.test.ts`
vertes après l'extraction ; route (hors liste, double clic qui n'envoie qu'une fois, rouge, STOP, fenêtre
fermée : refus lisible ; accepté : campagne préfixée, membre retrouvé DANS l'espace et jamais dans un autre,
enfilée sur `envoi-unitaire` et pas sur `campaign-run`) ; statut monotone et accusé en avance ; échec à l'envoi ;
attribution de la réponse ; `queue-names` ; e2e de l'éditeur.

**Déploiement** : migration, `up` de l'API, version promue du package, puis la console. **Essai réel** : celui de
la feature, en tête de ce plan.

## Ordre de déploiement, pour tous les lots

1. `git log <déployé>..HEAD` et `gh run list` ; verdict lu job par job (`gh run view <id> --json jobs`), jamais
   sur le code de sortie d'un `watch`.
2. Build de l'image, `migrate`, relecture en base point par point (colonnes, contraintes, zéro clé étrangère
   sortante, privilèges du schéma), PUIS `up -d --build`, puis le contrôle public des deux portes (le 502 de
   NPM se règle par `nginx -s reload`).
3. La console en DERNIER : Vercel publie au push, donc un écran qui appelle une route neuve n'est poussé
   qu'après le `up` qui la porte ; tout reste masqué tant que l'interrupteur de l'espace est éteint et que l'org
   n'est pas `connectee`.
4. La version du package attendue par l'API est installée dans l'org de test AVANT l'essai réel du lot.
5. Une relecture indépendante par lot, en fin de lot (rouge = ce qui casse la production), avant le
   déploiement ; `/sync` après chaque lot déployé (`features.md` dit « désactivé par défaut » tant que
   l'interrupteur l'est).
