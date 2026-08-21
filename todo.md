# todo.md — backlog

> **Le plan global vit dans `PLAN.md`.** Audit de scalabilité et lot de features séquencés ensemble,
> en 6 blocs. Ce `todo.md` reste l'historique détaillé des lots livrés et le backlog de fond.

## 🔴 MBA : ce qui reste après le chantier « paramètres d'activation » (livré le 2026-08-21)

**Le chantier est DÉPLOYÉ** (écran Activation, migration 0067, règle du texte libre, abonnement webhook).
Dossier complet dans `.loop/mba-parametres-activation.md`. Ne restent que les deux points ci-dessous, dont
le premier ne dépend pas de nous.

### Ce qui reste à faire, dans l'ordre
1. 🔴 **BLOQUÉ PAR LE MOYEN DE PAIEMENT** : provoquer un VRAI transfert en conversation WhatsApp réelle.
   Sans moyen de paiement rattaché au compte, aucun message WhatsApp n'atteint l'agent : le bac à sable
   (`agent_test`, onglet « Tester ») est le SEUL canal. Rien à tenter d'ici là, ce n'est pas un manque de
   notre côté. Le jour où c'est rattaché : envoyer « je veux parler à un conseiller » au
   `+33 5 25 68 03 01` (`phone_number_id=1305301719324792`, WABA `1067000669256166`) et regarder si l'on
   reçoit `messaging_handovers`, sous quelle forme, si la suite bascule de `standby` vers `messages`, et si
   l'écho du message de transfert arrive. Puis corriger `ownerFromHandover` (`src/webhooks/handover.ts`),
   dont la lecture est DEVINÉE et probablement INVERSÉE. Le module journalise déjà tout payload reçu
   (`handover_recu`, `standby_echo`) : la trace sera là.
   ✅ L'abonnement webhook, lui, est FAIT (2026-08-21) : `messages`, `standby` et `messaging_handovers` sont
   souscrits sur l'app. Ce n'est donc plus un prérequis manquant.
2. 🔲 **La pastille « quelqu'un a besoin d'aide »** dans l'inbox. Demande une donnée NOUVELLE : `app_human` ne
   distingue pas « escaladé, personne ne s'en occupe » de « un opérateur a répondu », donc la pastille ne
   pourrait jamais s'éteindre. Et le balayage de reprise rebascule après le délai même si personne n'a rien
   fait : une demande d'aide peut donc s'éteindre toute seule. À ne faire qu'APRÈS le point 1.
3. 🔲 **Le texte lu par le client hors horaires** reste celui de Meta. Nous ne l'écrivons pas encore
   (`message` + `message_selection: CUSTOM`), parce que le comportement réel de ces deux champs n'a pas été
   mesuré. À traiter avec le point 1, sur le même test réel.

### Faits à ne pas re-chercher
- `handoff` a **trois** champs : `enabled`, `message`, `message_selection` (DEFAULT/AGENT/CUSTOM).
  🔴 `enabled` **n'active pas** le passage de main, il décide si l'agent LÂCHE le fil après l'avoir annoncé.
- « Je veux parler à un conseiller » -> `handoff_reason: customer_request`, **déjà mesuré** sur notre numéro
  de test. Le déclencheur est natif, rien à câbler.
- **Deux interrupteurs MBA** : `mba_enabled` (Accueil) ne fait PAS répondre l'agent, c'est le **rollout**
  (MBA > Vue d'ensemble) qui le fait. Asymétrique : `false` coupe TOUTES les conversations, `true` ne reprend
  que les nouvelles.
- Sur le WABA de test, **deux** apps sont abonnées : la nôtre et « Business Agent » de Meta. `subscribed_apps`
  liste les APPS, pas les CHAMPS ; les champs se lisent sur `{app_id}/subscriptions` (jeton d'application).
- ❌ Une skill = trois champs de TEXTE chez Meta. Elle ne produit aucun effet chez nous, elle ne fait
  qu'influencer le modèle. Ne jamais la vendre comme un transfert garanti.

## 🔲 CI rouge par intermittence : `inbox-envoi-scenario` et `campaign-carousel-preview` (mesuré 2026-08-21)

**Ce n'est pas une régression** : mesuré sur 5 exécutions, les échecs CHANGENT de test d'une fois sur l'autre,
et les deux fichiers passent **25/25** et **6/6** en isolation, y compris avec 4 workers.

| Exécution | Échecs |
|---|---|
| local (20/08 au soir) | aucun, 192/192 |
| CI | campaign-carousel |
| CI (rerun, même commit) | campaign-carousel + inbox-envoi-scenario |
| local | campaign-carousel + inbox-envoi-scenario |
| local | inbox-envoi-scenario seul, sur un AUTRE test du fichier |

**Point commun constant** : le chargement de la liste des SCÉNARIOS (`wfSelect`, `scenario-select`), qui
attend workflows ET templates puis filtre par éligibilité. Ce sont les deux écrans les plus lourds de la suite.

**Cause** : contention. 4 workers partagent UN serveur Next (`playwright.config.ts`), et le budget du TEST
(30 s par défaut) est mangé par le chargement de l'écran avant que l'assertion commence.
`campaign-carousel-preview` a déjà reçu 90 s pour cette raison exacte ; `inbox-envoi-scenario` est resté à 30 s
alors que son `ouvrirPanneau` réessaie déjà pendant 20 s.

**Deux pistes, dans cet ordre :**
1. Aligner le budget de `inbox-envoi-scenario` sur les 90 s de son jumeau. Ce n'est PAS affaiblir un test :
   les assertions ne bougent pas, on rend seulement au test le temps que la contention lui prend.
2. 🔴 Un échec reste INEXPLIQUÉ par la contention : en CI, `carousel-cards` et « Séjour à Nice » étaient
   visibles mais « Séjour à Lyon » **absent du DOM** (`element(s) not found`, pas un timeout). Les deux cartes
   viennent pourtant du même `.map()`. À creuser avec un trace Playwright : la CI n'uploade aucun artefact
   aujourd'hui, l'ajouter est le prérequis pour diagnostiquer au lieu de deviner.

⚠️ Ne PAS « corriger » en rallongeant encore les attentes internes : ça a déjà été fait deux fois et n'a pas tenu.

## 🔲 Bornes de journée : les mesures filtrent en UTC, l'écran raisonne en heure locale (2026-08-21)

`countByNode` (`src/workflow/node-events.pg.ts`) compare `at >= $3::date and at < ($4::date + interval '1 day')`.
Les bornes sont donc interprétées en UTC, alors que l'utilisateur choisit « aujourd'hui » dans SON fuseau.
L'été, deux heures d'événements changent de journée : un clic de 23 h 30 à Paris est compté le lendemain.

**Comment c'est apparu** : un test d'intégration a échoué en CI à 00 h 05 heure de Paris, sur un commit qui
n'y touchait pas (vérifié en relançant la CI du commit précédent, qui a échoué au même endroit). Le test a été
rendu insensible au fuseau ; le décalage de fond, lui, est toujours là.

**À décider** : soit les bornes sont converties dans le fuseau du tenant (`tenant_settings.timezone`, déjà
lu ailleurs), soit on assume l'UTC et on le dit à l'écran. Aujourd'hui ce n'est ni l'un ni l'autre.
Concerne les mesures par bloc, et probablement les autres agrégats datés d'Analytics : à vérifier ensemble.

## Ouvert au 2026-08-20 (traçage des liens + statut manager)

- 🔲 **Décider ce qu'un MANAGER a le droit de faire.** Le statut existe et s'attribue (migration 0065), mais
  il donne exactement les mêmes accès qu'un agent : tout ce qui n'est pas admin reste fermé. Ouvrir des routes
  à ce rôle se décide écriture par écriture, ça ne se devine pas. **En attente d'une décision de Julien.**
- 🔲 **Premier test RÉEL du traçage des liens, de bout en bout.** La redirection est vérifiée en prod (302 +
  clic compté) et la substitution est vérifiée en test contre un faux Meta, mais **personne n'a encore créé un
  template avec un lien depuis la console**. Le maillon création -> approbation Meta -> envoi -> clic ->
  compteur n'a jamais été exercé en vrai.
- 🔲 **Nettoyer `test_lien_redir_a` et `test_lien_redir_b`** sur le WABA de test (« AuxR M le Bus MBA test »).
  Le token sait créer un template mais **pas le supprimer** sur ce compte (« Need permission on either
  WhatsApp Business Account or owner/shared business », par l'arête WABA comme par l'id). À retirer depuis
  Business Manager.
- 🔲 **Attribution par personne des clics** (reportée, pas abandonnée) : demanderait un suffixe fourni à
  l'envoi, donc un composant de bouton sur les quatre chemins d'envoi. Le lien de base ne changerait pas, les
  templates déjà approuvés n'auraient pas à être resoumis. **Julien n'en veut pas pour l'instant** : il veut
  un comptage global.
- ❌ **HORS PÉRIMÈTRE, tranché le 2026-08-20** : les liens écrits dans le **CORPS** d'un message ne sont pas
  traçables. Seuls les **boutons** le sont. WhatsApp va chercher lui-même les liens du corps pour en afficher
  l'aperçu, un compteur y compterait des robots plutôt que des humains. Décision de Julien, ne pas rouvrir
  sans qu'il le demande.

## ⚠️ AUDIT DE SCALABILITÉ (2026-07-18) — LIRE EN PREMIER

**`AUDIT-SCALE-2026-07-18.md`** : audit multi-agents des deux repos (10 dimensions, 117 constats,
chacun passé devant des vérificateurs adverses, 189 agents). Verdict : **le produit ne peut PAS
accueillir des dizaines de clients en l'état**. Trois bloquants mécaniques :

1. **Le multi-tenant Meta n'est pas câblé.** Les 12 sites d'envoi utilisent `config.META_ACCESS_TOKEN`
   (token global unique) ; le token business chiffré de chaque client est écrit en base mais
   `decryptSecret` n'a **aucun appelant** en prod. « Chaque client connecte son numéro » est simulé.
2. **Budget de connexions Postgres non borné** : jusqu'à 42 sessions demandées contre 15 au pooler
   Supabase. C'est la cause du « internal error » du Dashboard, **déjà avec un seul client**.
   mm-hubspot a codé la garde (`DB_POOL_MAX`/`PGBOSS_MAX`), mba non. Correctif : une demi-journée.
3. **Un seul numéro par tenant, câblé en dur** (`getTenantPhoneNumberId` = `order by created_at limit 1`,
   `conversations` sans `phone_number_id`). Deux numéros chez UN client cassent l'inbox.

Le plan d'action ordonné (3 vagues, ~3 semaines pour les vagues 1 et 2) est en §7 du rapport.
Les vagues 1 et 2 sont le minimum avant de vendre. §8 liste ce qui reste à trancher côté produit.

## Plan des boucles feature-loop (ordre)

1. ✅ **Loop 1 — Webhook receiver + file + idempotence** (le socle que tout consomme).
2. ✅ **Loop 2 — Wrapper Cloud API + MM Lite** (send text/template, statuts, marketing_messages,
   erreurs + retries + throttling).
3. ✅ **Loop 3 — Contacts BSUID-native + import CSV + user fields** (parsing, dédup, merge CTA).
4. ✅ **Loop 4 — Moteur de campagne + garde-fous** (pacing, fréquence max, coupure quality rating).
5. ✅ **Loop 5 — Adaptateurs Postgres + run E2E** (stores PG, services create/run, routes HTTP
   import/campagne/run, worker campaign-run ; E2E CSV->campagne->envoi prouvé contre Supabase).

Fait ✅ : UI (login, contacts/import, campagnes) + auth JWT/RBAC + déployé **LIVE** sur
`mba.messagingme.app` (1er envoi WhatsApp réel le 2026-07-06, numéro Zadarma).

## Programme 16 features (2026-07-16) — lots restants

Lots A-E LIVE (cf `wip.md`). Restent, dans l'ordre recommandé :
- ✅ **Lot 4b — fin du socle identifiants : FAIT (2026-07-16)** (codes des NODES mintés serveur + champs système
  déterministes + backfill, cf `.loop/lotF-identifiants-4b.md`). Reste le chantier DÉDIÉ **endpoints API publics**
  adressés par code (API keys, auth consommateur externe, scopes, rate limiting -> cadrage produit).
- ✅ **Lot 6 — i18n anglais COMPLET : FAIT (2026-07-16)** (bug lang resync fermé, day/format locale-requis,
  toggle pré-login sur les 5 pages auth, cf `.loop/lotG-i18n-anglais.md`).
- ✅ **Lot 7 — Flow avancé (#6b/#6c) : FAIT (2026-07-17)** : formulaires MULTI-ÉCRANS (onglets builder, ids
  `FORM`/`FORM_B`…, complete agrégé par refs globales, webhook INCHANGÉ), champs CONDITIONNELS (`visibleIf` ->
  propriété `visible`, sondé : champ masqué OMIS du payload, requis caché ne bloque pas), **fix node `flow`**
  (envoi interactif réel + garde fenêtre 24 h à 3 étages). Sondes LIVE avant plan + sonde committée
  `scripts/sonde-flow-live.mts` (générateur produit vs WABA réel). Cf `.loop/lot7-flow-avance.md`.
  ⚠️ Vérif Julien restante (V2) : scénario avec node Formulaire -> envoi réel reçu sur son WhatsApp,
  formulaire multi-écrans rempli -> champs contact + run avancé + carte inbox.
- ✅ **Lot 8 — Campagne « une-page » : FAIT (2026-07-17, 5 phases LIVE)** : écran pleine largeur 2 étapes
  (Préparation / Lancement), sources de destinataires (Liste de contacts requêtable par filtres / Import fichier
  + tag / HubSpot grisé), débit ajustable (mig 0033, timeout de job dimensionné), planification maintenant/plus
  tard (mig 0034, sweeper, annulable). Cf `.loop/lot8-campagne-une-page.md`. ⚠️ Vérif Julien restante (E1/V1) :
  drive navigateur du parcours complet + coup d'œil visuel (pleine largeur, filtres, slider, calendrier).
- **HubSpot import (#14, parké)** = **3e bouton de source** de campagne (le socle source-picker est prêt, il ne
  reste que la source HubSpot) : importer une liste HubSpot comme destinataires. Multi-repo : scope
  `crm.lists.read` sur l'app mm-hubspot + RE-CONSENTEMENT du portail cobaye (action Julien), client lists + route
  service-à-service côté mm-hubspot, proxy + réutilisation `importContacts()` côté mba, opt-in JAMAIS posé à
  'opted_in' par défaut (conformité). + (todo #5-tail) proposer les internal names HubSpot dans les sélecteurs.
- **Analytics palier L (suite #8)** : tracker les erreurs des envois Inbox/Workflow (colonnes d'erreur sur
  `conversation_messages` + toucher le handler de statuts webhook EN PROD, risqué → à froid).
- ✅ **ConvAnalyzer light (Lot 9) : FAIT (2026-07-17)** — bloc « Conversations (analyse) » dans Analytics
  (quanti donut/barres + table quali filtrable -> inbox), sur le moteur Pièce 1 déjà actif. Cf
  `.loop/lot9-convanalyzer.md`. **V2 (backlog)** : (a) **agent IA décisionnel** branché sur l'analyse
  (déclencher une action HubSpot / dire au MBA de faire qqch) = le vrai objectif de Julien, à cadrer ;
  (b) enrichir le schéma d'analyse pour reprendre ce que le vrai convanalyzer a en plus (urgence graduée 0-5,
  score d'échec du bot, churn, clustering de sujets) ; (c) tendance temporelle stable (joindre
  `conversations.created_at`, pas `conversation_analysis.created_at` qui bouge à la ré-analyse).
- ✅ **Palier 2 — champ booléen + consentement de flow : FAIT (2026-07-17)** : canonicalisation booléenne
  (`crm/fields.ts`, partagée fiche/import/webhook), OptIn de flow -> champ booléen choisi (défaut `whatsapp_optin`
  créé à la volée) ET flip `opt_in_status='opted_in'` (opt-out écrasé, décision Julien), garde double-consentement.
  Cf `.loop/palier2-consentement.md` + cadrage `~/messagingme-pilot/docs/CADRAGE-MBA-API-CONTENU-HUBSPOT.md`.
  ⚠️ Dette test : `toBElems` (FlowBuilder) non testé unitairement (fonction non exportée) -> exporter + test
  (optin défaut -> saveTo vide ; optin cible explicite -> saveTo non vide). ⚠️ Vérif Julien : flow avec écran
  de consentement -> coché -> champ « Oui » + statut opt-in + éligibilité campagne marketing.

## Décisions API/HubSpot tranchées (2026-07-17) -> paliers restants

Cf `~/messagingme-pilot/docs/CADRAGE-MBA-API-CONTENU-HUBSPOT.md` (D-1..D-10 validées par Julien). Paliers :
- ✅ **Palier 3 (Phase A+B) — API publique v1 : FAIT (2026-07-17)** : clés d'API (`api_keys`, scopes
  contacts:write/sends:create, rôle synthétique 'api'), résolveur code+nom (409 ambigu), `POST /v1/contacts`
  (+ batch), `POST /v1/sends` (scénario + template, `Idempotency-Key` obligatoire + claim atomique, rapport
  skipped détaillé, upsert-then-send), `GET /v1/sends/:id`, CRUD clés admin. Migration 0035. Cf
  `.loop/palier3-api.md`. Reviewer sécurité : 🔴 double-envoi (idempotence libérée post-enqueue) trouvé + corrigé.
  - ✅ **Phase B2 — cible node : FAITE (2026-07-18)** : `WorkflowExecutor.startFromNode` (garde 24 h de `start`
    conservée intacte), `PgInboxStore.getWindowOpenByWaIds` (fenêtre en lot, 1 requête), `Campaign.startNodeId`
    de bout en bout, branche `startWorkflowFromNode` du moteur, `POST /v1/sends` accepte `{node:'nod_...'}`.
    Hors fenêtre -> `skipped:{reason:'out_of_window'}`, jamais d'envoi. `createMissing` forcé à false et `params`
    refusé (400) sur cette cible. Aucune migration (0035 portait déjà la colonne). Reviewer PASS.
    Cf `.loop/palier3-b2-et-robustesse.md`.
  - **Reste Phase C (différé)** : page web `/api-keys` (gestion des clés côté admin ; aujourd'hui via la route
    admin/curl). + lien nav.
  - ✅ 🟡 **follow-up enqueue : FAIT (2026-07-18)** : retry borné (3 tentatives, backoff 100/300 ms) au lieu d'un
    sweeper. Motif : un sweeper qui ré-enfilerait les campagnes `draft` relancerait aussi les brouillons créés à
    la main dans l'UI et jamais lancés volontairement (= envois non désirés). L'idempotence reste scellée
    inconditionnellement sur tous les chemins.
  - 🟡 **runs de workflow orphelins** (reviewer 2026-07-18, pré-existant, rendu probable par la cible node) :
    `PgWorkflowRunStore.findWaitingByWaId` prend le run `waiting` le plus RÉCENT. Un contact qui avait déjà un run
    en attente (campagne scénario) et à qui on envoie un bloc se retrouve avec 2 runs : le 2e avance et se
    termine, puis une réponse ultérieure réveille le PREMIER et envoie un message que personne n'a demandé.
    Correctif proposé : dans `PgWorkflowRunStore.start`, clore les runs `waiting` du même (tenant, wa_id) avant
    l'insert (l'index partiel `workflow_runs_waiting_idx` couvre déjà l'écriture). Change la sémantique de cycle
    de vie des runs pour TOUTES les campagnes -> décision Julien avant de le faire.
  - 🟡 **`phoneNumberId` ignoré à l'envoi workflow** (reviewer 2026-07-18) : `/v1/sends` valide le numéro et le
    persiste sur la campagne, mais `worker.ts` (sendTemplate/sendQuickMessage/sendFlow du workflow) résout le
    numéro via `getTenantPhoneNumberId` = le PREMIER numéro du tenant. Zéro impact avec un seul numéro ; au 2e,
    un appel API explicite partirait du mauvais expéditeur en silence. Correctif : passer `campaign.phoneNumberId`
    jusqu'aux callbacks de l'executor.
  - 🟡 **intégration `queue.integration.test.ts`** : échoue en EMAXCONNSESSION (pooler Supabase plafonné à 15
    sessions, partagées avec la prod mba-api/mba-worker). `fileParallelism: false` a réglé les 5 autres fichiers
    (17 -> 60 tests verts). Reste à borner les pools de ce test précis, ou à le pointer sur une autre base.
- ~~Palier 3 (ancien cadrage)~~ remplacé par l'entrée ci-dessus.
  Rappel de portée (fait) : `POST /v1/sends` scénario + template, node = fenêtre 24h uniquement (D-1, Phase B2).
- 🔶 **Palier 4 — import listes HubSpot (Phase 0+1 FAITES 2026-07-18)** : toggle self-serve + re-consentement
  ciblé (`optional_scope=crm.lists.read`, mécanisme natif HubSpot, ne touche pas les autres portails). Phase 0
  (connecteur mm-hubspot) : client Lists (search/memberships/batch-read borné 5000), OAuth optional_scope +
  granted_scopes + garde anti-hijack, route service signée `/service/lists[/contacts]`. Phase 1 (mba) : toggle
  `hubspot_lists_enabled`, proxy signé, `importHubspotList` (opt-in JAMAIS opted_in, garanti au niveau du type,
  tag `HubSpot: <nom>`). Migrations 0007 (mmhs) + 0036 (mba). Reviewer cross-repo PASS. Cf
  `~/mm-hubspot/.loop/palier4-lists-connecteur.md`.
  - ✅ **Phase 2 (UI mba) FAITE (2026-07-18)** : toggle « Campagnes via données HubSpot » + CTA re-consentement
    sur /accueil (dans le bloc portail connecté), 3e bouton de source de campagne activé + composant
    HubspotListImport (liste -> sélection -> import, tag serveur source de vérité). Reviewer logique PASS (2 🔴
    corrigés : mismatch de tag, getSettings dans Promise.all). **RESTE Phase 3 (Julien)** : re-consentement réel du
    portail cobaye 139615673 + import de test.
  - ✅ 🟡 (a) **`searchLists` paginé : FAIT (2026-07-18)** : boucle par `offset`, arrêt sur `hasMore=false`,
    `total` atteint, page vide, borne 500 listes ET borne dure d'itérations, chaque troncature loguée.
  - ✅ 🟡 (b) **`/service/*` fermé au public : FAIT (2026-07-18)** : `advanced_config` sur le proxy host NPM 22
    (`mm-hubspot.messagingme.app`), `location ^~ /service/ { return 404; }`. mba appelle le connecteur en INTERNE
    (`HUBSPOT_SERVICE_URL=http://mm-hubspot-api:8096`), donc sans passer par NPM. Vérifié après bascule : public
    `/service/lists` -> 404, `/health` -> 200, `/ingest` -> 401 (inchangé), interne `/service/lists` -> 401
    (vivant, signature exigée).
- **Palier 5 — échelle d'autonomie HubSpot (4 niveaux)** : curseur sur le dashboard (N1 suggère, N2 actions
  sûres, N3 Deal auto, N4 autonome), seuil de confiance interne calibré par niveau (D-8/D-9/D-10). 5a = N1-2 +
  curseur + setter `autonomy_level` ; 5b = N3 (Deal auto) après mesure.
- **Drop différés** : rien (0030 a droppé `workflows.status` ; codes = additifs).

## Suites des revues Automation (2026-08-03) — identifiées, NON traitées

Trois points relevés par les revues adversariales des lots E/E.2/F, jugés non bloquants et laissés de côté.
Chacun est un compromis assumé, pas un oubli.

- **Pas de sweeper des parcours en attente.** Un parcours qu'un contact ne fait jamais avancer reste « en
  attente » indéfiniment. Aujourd'hui une automation l'ignore au bout de 7 jours (fenêtre d'âge), ce qui
  débloque le contact, mais la ligne reste en base. Un balayage qui les clôt proprement serait plus sain.
- **Le numéro qui teste un scénario compte dans la statistique Contacts.** Les messages du test sont bien
  exclus des chiffres et de l'analyse, mais la fiche contact créée par le test, elle, est comptée comme
  n'importe quel contact. L'écran de test le dit, ce n'est donc pas un mensonge, juste une imprécision.
- **Le signal « nouveau contact » ne survit pas à un rejeu du webhook.** Si le traitement d'un message échoue
  après la création de la fiche et qu'il est rejoué, le contact n'est plus « nouveau » : un déclencheur
  « nouveau contact » ne partira pas pour lui. Le rendre infaillible imposerait une requête de comptage sur
  chaque message entrant, prix jugé trop élevé pour un cas qui suppose déjà un incident.

## Chantier OTP + étapes de deal HubSpot (ouvert le 2026-08-16)

Contexte et gotchas : `wip.md` §OTP automatique. Prochaine migration libre = **0059**.

- 🔴 **Le pilote OTP, avant toute construction.** Répondeur Zadarma sur un numéro DÉDIÉ, un OTP déclenché, et
  on regarde si Meta dicte son code à une machine ou raccroche. Aucun retour d'expérience publié : c'est la
  seule question qui décide si le full-auto vit. Ne jamais utiliser un numéro qui sert Odalys, EDHEC ou Gan
  Prévoyance : une écriture de routage les couperait.
- **Le dossier d'identité (KYC) par numéro français** : un seul dossier au nom de la société, réutilisable, ou
  un par client final ? La deuxième réponse ramène le geste manuel par la porte juridique et touche le modèle,
  pas le code. À trancher AVANT d'industrialiser.
- **Réserve de numéros en base** (migration 0056) : quel numéro est alloué à quel embarquement, et son état.
- **Route + écran qui affiche le code en direct.** Sert dans les DEUX scénarios : c'est l'affichage du repli
  assisté si le full-auto meurt, et le suivi de la capture s'il vit. Avec un bouton « renvoyer le code ».
- **Instancier `ZadarmaClient` dans `index.ts`** à partir de la config (rien ne le fait aujourd'hui).
- 🟡 **L'aperçu de template n'affiche pas le visuel d'en-tête.** `web/components/TemplatePreview.tsx` ne
  transmet pas la prop `header` que `WhatsAppPreview` accepte pourtant déjà. Purement cosmétique (l'envoi, lui,
  joint bien le visuel depuis le 2026-08-17), mais ça donne un aperçu qui ne ressemble pas au message reçu.
- ✅ **Menu des étapes de deal dans l'écran Automation** (fait et déployé le 2026-08-16).
- ✅ **Souscription webhook HubSpot envoyée** (2026-08-16, build #8 sur le compte dev 148896252). La chaîne
  est donc vivante de bout en bout ; reste à l'éprouver sur le portail cobaye avec un deal dont le contact
  porte un numéro, et un scénario qui ouvre par un template.

## Suite de l'audit anti-slop (2026-08-18) — 1 item sur 57

Les 6 rouges et 50 des 51 jaunes sont corrigés et déployés (cf. `wip.md`). Ne reste que celui-ci, laissé
volontairement à l'arbitrage de Julien.

- 🟡 **Découper `web/lib/api.ts`** (1325 lignes, 203 exports, une quinzaine de domaines) par domaine dans
  `web/lib/api/`, derrière un barrel qui re-exporte tout (aucun import appelant ne change). Le repo pratique
  déjà l'extraction avec shim de re-export (`contact-filters`, `field-kinds`). Mécanique, mais ça brasse tous
  les imports du front, d'où l'arrêt : à faire dans un lot dédié, pas en fin de session. ⚠️ Reporter le
  `'use client'` de tête dans les modules qui touchent `session`/`window`.

## MBA ouvert sur la France (2026-08-18) — ce que la doc fraîche impose d'instruire

Contexte : `agent_eligibility` renvoie `is_eligible:true` sur `+33 5 25 68 03 01` (ToS acceptées par Julien),
et Meta a modifié 6 pages entre le 11 et le 15 août dont une page `changelog` neuve. Relevé complet :
`docs/MBA-API-REFERENCE.md` § « Ce qui a changé chez Meta ». Rien n'est cassé, rien n'est branché.

- 🔴 **Instruire « configured escalation partner ».** C'est la condition d'accès à l'action `take` de
  `thread_control`, donc au handoff propre vers un humain, donc à la plus-value centrale du produit. Meta
  écrit la restriction et ne définit NI qui désigne ce partenaire, NI comment. Sans réponse, on reste sur la
  prise de contrôle par envoi de message. À poser à Meta, ou à mesurer sur le numéro de test.
- 🔴 **Relever le nom exact des deux nouveaux champs de `handoff`** (« release thread control after sending a
  handoff message » et « source du message : CUSTOM / AGENT / DEFAULT »). Leur description est documentée,
  pas leur nom : il faut le lire dans le rendu de la page ou le déduire d'un GET une fois un handoff
  configuré. Ne pas coder dessus avant.
- 🔴 **Le read-modify-write de `settings` doit repasser les clés inconnues telles quelles.** La ressource est
  en remplacement complet ; un modèle typé fermé (Zod ou interface qui ne connaît que `enabled`/`message`)
  effacerait `never_say_phrases` et les champs de handoff au premier PUT, sans que personne l'ait demandé.
- 🟠 **Dire au client qu'un moyen de paiement conditionne la LIVRAISON**, pas seulement l'activation :
  « messages are not delivered unless your Business Agent account has a payment method attached ». Rien ne le
  signale côté console aujourd'hui.
- 🟠 **Lire les deux pages Meta jamais transcrites** : `agent-insights` (quelles sources de connaissance et
  quelles skills ont servi à répondre, utile pour expliquer une réponse à un client) et `capabilities`. Elles
  sont désormais dans la veille.
- 🟡 **Modèle de coût** : les messages MBA ont un régime tarifaire propre (grille « non-template messages »),
  que notre estimation par catégorie de template ne couvre pas.
- 🟢 **`agent_test` ne facture pas les jetons** (« Tokens consumed while testing through this endpoint are not
  billed »), écrit deux fois dans la page : la QA peut s'appuyer dessus sans compter.

## Post-live — prochaines actions

- 🟡 **Aucun outil de rejeu de la file d échecs (DLQ).** Un job en échec part dans `<file>-dlq`, que RIEN ne
  consomme : il y reste indéfiniment. Un message entrant y dort depuis le 2026-08-17. Une commande `/ops` qui
  liste et rejoue une entrée éviterait de perdre de la donnée à chaque incident de schéma.
- 🟡 **Une file sans consommateur devrait CRIER.** Le worker annonce `[inerte]` au démarrage quand une
  fonctionnalité n est pas configurée, mais personne ne lit cette ligne. Une alerte (Telegram, comme
  l error-tracking) au démarrage d une file inerte aurait économisé une journée sur le déclencheur HubSpot.


- ✅ **Token permanent POSÉ (2026-07-08).** `META_ACCESS_TOKEN` = token System User permanent
  (`expires_at:0`, scopes messaging+management), dans `.env.prod` du VPS. Templates create+list
  validés en live via l'app. Détails : `brain/PROJECTS.md` §Meta/WhatsApp.
- ✅ **Placeholders demo supprimés (2026-07-08).** `demo-pn`/`demo-waba` (seed) traînaient sous le
  tenant réel et gagnaient le `order by created_at limit 1` -> 502 templates. DELETE des 2 lignes.
- 🟡 **Robustesse `getTenantWabaId`/`getTenantPhoneNumberId`** : sélectionnent par
  `order by created_at limit 1`. OK aujourd'hui (une seule vraie ligne), mais fragile si un 2e numéro
  réel est onboardé (choix arbitraire) ou si un placeholder de seed réapparaît. À terme : filtrer sur
  un critère de validité (id numérique / flag actif) plutôt que l'ordre d'insertion. Cf. LEARNINGS 2026-07-08.
- **Template `mba_console_test`** (id `1507311428074574`, PENDING) : template de test créé pour prouver
  la feature. Supprimable depuis l'onglet Templates quand tu veux.
- **Onboarding client (Embedded Signup)** : Facebook Login for Business (config_id) → bouton ES +
  échange de token BISU côté backend → **Access Verification (Tech Provider)** + **App Review**
  (Advanced Access sur les perms WhatsApp, screencast par permission). Ni l'un ni l'autre requis
  pour NOTRE propre numéro (rôle sur l'app), mais requis pour brancher les WABA de clients.
- ✅ **Veille MBA POSÉE (2026-07-09)** : cron VPS `ops/mba-eligibility-watch.mjs` (crontab ubuntu,
  toutes les 6h) qui poll `GET api.facebook.com/{pnid}/agent_eligibility` (X-API-Version 2.0.0).
  Baseline = 403 « Meta Business AI Terms » (`BLOCKED_TOS`, état dans `.mba-eligibility-state.json`).
  Alerte Telegram (`@Messagingmeapp_bot`, creds lus au runtime depuis `messagingme-pilot/config.json`)
  au moindre changement d'état (mur ToS levé → MBA ouvre FR). Log `.mba-eligibility.log`.

## ✅ Suites revue templates + inbox — TOUT RÉSOLU (2026-07-08)

- ✅ **Bouton URL dynamique** : `buildComponents` émet l'`example` bouton quand l'URL contient `{{n}}`.
- ✅ **Types interactifs Flows** : `nfm_reply` capturé (corps + `response_json` en payload), réaction
  (emoji), médias (légende ou `[type]`), localisation, sous-type inconnu -> `[interactif]`. Plus de
  perte silencieuse.
- ✅ **Liaison contact** : match `'+'||wa_id` PUIS chiffres normalisés (`regexp_replace`) -> tolère un
  formatage différent.
- ✅ **Message Meta** : 502 tronqué à 200 car., espaces compactés.
- ✅ **Templates list** : pagination complète (suit `paging.next`, cap 20 pages).

## ✅ Sécurité / auth — RÉSOLU (était BLOQUANT à la revue Loops 3-5)

Auth construite et déployée : login JWT (scrypt async, rate-limit, hash leurre anti-énumération),
isolation tenant sur toutes les routes (tenant DÉRIVÉ du JWT, 403 si mismatch), RBAC (écritures
admin-only via `forbidNonAdmin`), ownership `phoneNumberId` validée, `AUTH_SECRET` fail-fast en
prod. Résidus non bloquants ci-dessous.

## Suites de la revue sécurité auth

- ✅ **RBAC** : `forbidNonAdmin` applique le rôle admin sur les écritures (import, création + run
  de campagne). Reads ouverts aux comptes authentifiés. Matrice à affiner si un rôle `agent` est
  réellement provisionné.
- ✅ **Compte démo** `admin@demo.test` désactivé en prod (password_hash null, réversible).
- ✅ **AUTH_SECRET** : boot prod échoue si absent/faible ; posé sur le VPS.
- ⏳ **TLS pooler** (BLOQUÉ sur un fichier externe, pas de la flemme) : la vérif complète échoue
  (chaîne self-signed du pooler Supabase) -> `DB_SSL_INSECURE=true` (chiffré mais non vérifié). Le
  code est PRÊT (`DB_SSL_CA_FILE` -> vérif stricte, `pgSsl()`), il ne manque QUE la CA : la
  télécharger dans le dashboard Supabase (Project Settings -> Database -> SSL Configuration ->
  « Download certificate »), la monter dans le conteneur, poser `DB_SSL_CA_FILE=/chemin/ca.crt` et
  retirer `DB_SSL_INSECURE`. Action Julien (accès dashboard).
- ✅ **Unicité email** : tranché -> email GLOBAL insensible à la casse. Migration 0010 (index
  `users_email_lower_unique` sur `lower(email)`), `findByEmail` matche `lower(email)`. Fin du
  non-déterminisme multi-tenant.

## ✅ Dashboard v2 — prix templates MARCHE EN PROD (corrigé 2026-07-10)

⚠️ CORRECTION d'une conclusion erronée. J'avais écrit que `pricing_analytics` était bloqué par
l'Advanced Access (403 #200). **C'était FAUX** : la sonde avait tourné avec le token du `.env` LOCAL,
qui est limité/périmé, PAS le token permanent de prod. Re-testé DANS le conteneur `mba-api` (vrai token
`.env.prod`) : `pricing_analytics` renvoie **200 + vraies données** (marketing 0,0712 / utility 0,0248…).
Donc **le prix par template s'affiche déjà en prod** (le getPricing déployé utilise le bon token). Aucun
App Review requis pour l'analytics de NOTRE WABA. Pas de dégradation « indisponible » en réalité.

- **Leçon (cf. LEARNINGS)** : le `META_ACCESS_TOKEN` du `.env` LOCAL n'est PAS le token de prod. Toute
  sonde Meta doit tourner **dans le conteneur / avec le token de prod** (`docker cp` + `docker exec mba-api
  node ...`), jamais avec un scratch local, sinon faux négatifs (#200 « Provide valid app ID »).

## Dette Feature 2 — Admin + RBAC (revue adversariale 2026-07-10)

RBAC posé : rôles `admin`/`agent`, agent = inbox uniquement (garde serveur `makeRequireRole`
sur tous les groupes sauf inbox + templates GET, source de vérité), onglet Admin (liste users,
créer un agent, changer un rôle). Corrigé à la revue : 🔴 templates GET remis en `requireAuth`
(l'inbox agent en dépend) ; invariant « ≥1 admin/tenant » forcé EN BASE dans `setRole` (refus
`last_admin` -> 409) ; tests agent->403 ajoutés sur contacts/import. Résidus non bloquants :

- ✅ **JWT figé sur changement de rôle / révocation — RÉSOLU (2026-07-10)** : `requireAuth` relit
  l'état du compte EN BASE à chaque requête authentifiée (`getUserState` -> `PgUserStore.getAuthState`) :
  compte supprimé/révoqué -> 401 immédiat, rôle rafraîchi depuis la base. Un changement de rôle, une
  révocation ou une suppression prennent effet TOUT DE SUITE, plus de fenêtre de 12h. Coût : un lookup
  PK par requête (négligeable à ce volume). Optionnel (absent en test -> JWT seul).
- 🟡 **Oracle d'existence d'email cross-tenant** : POST /users renvoie 409 si l'email existe DÉJÀ
  ailleurs (index unique GLOBAL `lower(email)`, migration 0010). Un admin peut ainsi sonder si un
  email est déjà un compte console d'un autre tenant (fuite limitée à l'existence, message générique,
  pas de PII ni de tenant révélé). Conséquence assumée du design « un email = un compte global ».
  Fermer l'oracle imposerait de repasser à l'unicité par tenant + login scopé au tenant (changement
  de schéma qui touche le login) -> à trancher côté produit, pas en aveugle.
- 🟡 **Course théorique zéro-admin** : deux rétrogradations croisées simultanées (READ COMMITTED)
  pourraient toutes deux voir count>1. Négligeable (2 admins à la milliseconde). Fermer via
  transaction + `SELECT ... FOR UPDATE` si on ajoute un jour token_version.

## Suites de la revue Loops 3-5

- ✅ **Réconciliation `sending`** : sweeper `reclaimStale` en place (worker.ts, `STALE_SENDING_MS`),
  reset `sending` -> `pending` au-delà du timeout.
- ✅ **createCampaign transactionnel + bulk** : `createWithRecipients` est dans un BEGIN/COMMIT et
  insère les destinataires en UNE requête (`unnest`, helper `bulkInsertRecipients`, idempotent
  `on conflict do nothing`). `insertRecipients` idem.
- 🟡 **quality getRating** : lu à chaque destinataire (point-query PK). Mémoïser (TTL court) si la
  volumétrie l'exige. Dominé par l'appel Meta aujourd'hui -> laissé tel quel.
- 🟡 **Stress-test concurrence** : le claim atomique (pending->sending) + `singletonKey` sont en place
  et testés au niveau claim ; un test « 2 runs concurrents -> zéro double-envoi » sous vraie course
  reste à ajouter (nice-to-have, pas un bug connu).

## Raffinement invariant admin (lot 6 P3, non bloquant)

Les sous-requêtes « ≥1 admin actif » de `PgUserStore.setRole/setDisabled/deleteUser` comptent
`role='admin' and disabled_at is null` SANS exclure les comptes **pending** (password_hash null, invitation non
acceptée). Non exploitable (self-block + un pending ne peut pas s'authentifier), mais correctness-of-intent :
ajouter `and password_hash is not null` aux 3 sous-requêtes pour qu'un admin invité jamais activé ne compte pas
comme « admin actif ». Défense en profondeur, à faire à froid (touche du SQL d'invariant sécurité).

## Refonte auth — ✅ FAITE (Lot 6, 2026-07-13)

Inscription libre + Google + invitations Resend + mot de passe perdu/reset/changement, tous LIVE. Détail :
`wip.md §Lot 6`. Domaine Resend vérifié + client OAuth Google configuré (origine JS + app publiée par Julien).

## Vérifier l'identité BSUID au 1er trafic réel (lot 4)

L'envoi route déjà un BSUID en `recipient` (vs `to` pour un numéro) via `messagingTarget`, et l'inbound
auto-crée les fiches (numéro OU BSUID). Mais **aucun contact BSUID n'existe encore** (le BSUID post-octobre
n'a pas commencé à remonter). Au 1er BSUID réel : (1) confirmer le format Meta et l'heuristique
`classifyWaId` (7-15 chiffres = numéro, sinon BSUID) ; (2) vérifier qu'un template part bien via `recipient`
et est délivré ; (3) vérifier que la fiche auto-créée + le matching merge/tag/conversation collent au format
réel. Cf `documentation.md §Identité`.

## Suites builder Lot 5 — node à sorties par bouton (V2, non bloquant)

Signalés à la revue Phase 3 (sous le seuil de confiance, défense en profondeur) :
- **Snapshot des boutons figé** : le node template mémorise `templateButtons` à la sélection. Si on ÉDITE
  ensuite le template (réordonner/renommer les boutons) sans ré-ouvrir le node, le workflow garde l'ancien
  ordre -> un bouton pourrait brancher vers la mauvaise cible (le payload `btn:<i>` reste posé sur l'index i).
  Fix possible : re-fetch les boutons courants du template à l'exécution, ou invalider/re-valider le node quand
  le template change. Conditionnel (édition après câblage), pas bloquant.
- **Arêtes orphelines à la re-sélection** : changer le template d'un node déjà câblé ne purge pas les arêtes des
  anciens `sourceHandle` disparus ; combiné au repli `nextNode` (1re arête), une arête morte pourrait être
  choisie. Fix : purger les arêtes du node dont le `sourceHandle` n'existe plus au changement de template.

## Suites builder Lot 3 (V2, non bloquant)

- **Branche par bouton quick-reply** : PB2 avance aujourd'hui sur N'IMPORTE QUELLE réponse inbound. Pour un
  vrai arbre (bouton A -> bloc X, bouton B -> bloc Y), mapper les arêtes sortantes d'un bloc template sur ses
  boutons (`sourceHandle` déjà prévu dans le modèle de graphe). À faire quand un scénario réel le réclame.
- **Livraison/lecture des campagnes workflow** : message_id synthétique `wf-<id>` -> le funnel affiche
  delivered/read/replied = 0 pour ces campagnes. Câbler un vrai suivi imposerait de relier le wamid du 1er
  template envoyé par le workflow au destinataire de campagne. Limitation V1 assumée.

## Décisions ouvertes

- **OTP post-octobre** : espérer un équivalent WABA-only en ES v4 ; sinon construire le
  fallback « copy-paste assisté ». Solution Partner écarté (hors de portée court terme).
- **Vertical de notre WABA** vs les 5 verticaux MBA : trancher via `agent_eligibility`
  post-ToS.
- **PaaS** : point de décision à l'entrée Phase 3 (Fly.io Paris / Railway EU, critère RGPD).

## Dette de la revue Loops 1-2

- ⏳ **TLS Supabase** : idem « TLS pooler » ci-dessus (bloqué sur la CA à télécharger au dashboard).
- ✅ **Test DLQ** : test d'intégration qui prouve job qui throw -> `<name>-dlq` (retryLimit
  configurable + `pullPending`, 1 seule tentative avec retryLimit:0).
- ✅ **CI intégration** : job `integration` (service Postgres 16, `DB_SSL=off`, migrate +
  `test:integration`) ajouté à `.github/workflows/ci.yml`.
- 🟢 **parse.ts** : VÉRIFIÉ, pas de double-comptage. Chaque sous-événement a une `dedupKey`
  distincte par source (rien ne collapse) ; messages+statuses arrivent sous le même `field:messages`
  donc le routage par tableau est le bon choix (gater par `field` serait fragile aux versions Meta).
- ⏸️ **`webhook_events` renommage `meta_message_id` -> `dedup_key`** : décision de NE PAS le faire.
  Renommer une colonne sur le chemin chaud du webhook (coordination migration+déploiement, fenêtre
  d'échec d'insert) pour un gain purement cosmétique n'en vaut pas le risque ; la couche appli
  utilise déjà `dedupKey` et la colonne est documentée. `tenant_id`/`waba_id` : prématuré tant
  qu'aucun consommateur analytique n'existe (colonnes vides = spéculatif).
- ⏸️ **`processed_at`/`error`** : sémantique à trancher (log brut d'ingestion vs statut de
  traitement réel). Décision produit, pas un bug.

## Raffinements notés

- ✅ **Loop 3 / import collision** : deux colonnes -> même custom key est signalé (`report.errors`
  « colonnes fusionnées »), 1re valeur non vide gagne.
- ⏸️ **Loop 3 / slugify** : deux labels distincts -> même key = fusion (1er gagne) + warning.
  Décision : on GARDE ce comportement. Disambiguer en `ville_2` casserait silencieusement le mapping
  des variables de template (l'utilisateur mappe sur `ville`). Le warning est le bon compromis.
- ✅ **Loop 2 / `withRetry`** : ne rejoue QUE `MetaApiError.retryable` + codes réseau connus
  (`NETWORK_CODES`), pas un throw arbitraire.
- ✅ **Loop 2 / `MetaClient`** : test « `rateLimiter.acquire()` appelé à chaque tentative » ajouté.
- ✅ **Loop 5 / existence campagne** : `campaignBelongsTo` = `select 1 ... where id and tenant_id`.
- ✅ **Loop 5 / `insertRecipients`** : bulk insert (`unnest`).
- 🟡 **Loop 5 / état `queued`** : la route `run` enqueue sans état intermédiaire visible (reste
  `draft` jusqu'à `running`). Une future UI voudra peut-être un `queued`. Décision produit.
- 🟡 **Loop 5 / quality rating** : `PgQualityProvider` lit `phone_numbers.quality_rating` (défaut
  UNKNOWN). Câbler l'alimentation par webhook `phone_number_quality_update` (feature, pas un bug).

## À durcir / suites (2026-07-15)

- 🔒 **Durcir `/oauth/install?tenant=` du connecteur** : il fait aujourd'hui confiance à un **UUID de tenant nu**
  (signé dans le state, mais l'UUID lui-même n'est pas prouvé). Un tiers qui connaîtrait l'UUID d'un autre tenant
  pourrait relier SON portail HubSpot à ce tenant (détourner ses analyses). Inoffensif au pilote (1 tenant, UUID non
  exposés, bouton rendu au seul admin du tenant). Quand multi-tenant : mba émet un **ticket signé court-lived** que
  le connecteur vérifie, au lieu de l'UUID nu. (Repéré par le reviewer, sous le seuil bloquant.)
- 📊 **Tracking réel de livraison des campagnes WORKFLOW** : remplacer le message_id synthétique `wf-<id>` par le vrai
  wamid du 1er template (rapproché des webhooks de statut) -> funnel delivered/read non figé à 0. Limitation V1 connue.
- ✅ **Bouton FLOW dans l'envoi workflow — FAIT (2026-07-16)** : `buildWorkflowTemplateComponents` génère désormais
  le composant `{sub_type:'flow', parameters:[{type:'action', action:{flow_token}}]}` par bouton FLOW (corrige #131009).
  Vérifié empiriquement contre la Cloud API. Détail : `CLAUDE.md` §Gotchas 2026-07-16.
- ⚠️ **Variables de template non contiguës** (`{{1}}` + `{{3}}` sans `{{2}}`) : le front compte les positions distinctes
  (Set) alors que le backend attend 1..N contigu -> désalignement possible. Pré-existant (mode direct), pas introduit
  ce lot ; à corriger si un template non contigu apparaît.

## Suites Embedded Signup / i18n (2026-07-16)

- 🔄 **Refresh du business token ES (60 j)** : le token BISU par-client expire à 60 j. Aujourd'hui il ne sert qu'à
  l'onboarding (subscribe webhooks), donc son expiration est sans impact. **Quand on enverra les campagnes avec le
  token PAR-CLIENT** (au lieu du `META_ACCESS_TOKEN` global), câbler le refresh + l'alerting d'expiration.
- 📤 **Envoi via le token par-client** : le worker envoie aujourd'hui avec le token global (marche pour NOTRE numéro).
  Pour de vrais clients onboardés, router l'envoi/les lectures sur le business token du WABA du client.
- 🗑️ **Supprimer le compte de test reviewer** `meta-review@messagingme.app` (admin Demo) **après approbation** de
  l'App Review Meta. Le garder tant que la review n'est pas passée (Meta peut re-tester).
- 🌐 **i18n** : spot-check des chaînes visibles restées en français en mode EN (build vert + grep « aucune valeur
  backend traduite » OK, mais quelques chaînes rares ont pu être oubliées). Corriger au fil des retours de Julien.
- 🔒 **Durcir `/oauth/install?tenant=` ES multi-tenant** : l'UUID tenant est nu dans le state (cf. plus bas, connecteur
  mm-hubspot) ; même durcissement (ticket signé court-lived) côté ES quand multi-tenant.

## Bugs connus

(aucun pour l'instant)

## Plus tard (V2+)

- Sync CRM (audiences entrantes + « zéro saisie » sortant : extraction post-conversation).
- Recettes événementielles (agent_event vs template selon fenêtre ouverte).
- Couche pub : wedge CTWA + attribution (referral/ctwa_clid + Conversions API).
- Coexistence (option d'onboarding app → API).
