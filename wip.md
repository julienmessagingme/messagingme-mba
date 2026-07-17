# wip.md — travail en cours

## Pièce 1 — passe d'analyse : durcissement du balayage (2026-07-14) ✅

Enquête sur un symptôme d'activation (une conversation coincée en `analysis_status='queued'` sans
job pgboss, auto-réparée à 15 min). **La cause supposée (« 1er `enqueue` sur file pg-boss neuve
no-op silencieusement, bug de cache pg-boss ») était fausse**, disprouvée par repro contre un vrai
Postgres (4 scénarios, schéma jetable) : l'enqueue crée le job à tous les coups, et `send()` sur
file absente **lève** (jamais de silence). Détail + règles réutilisables : `brain/LEARNINGS.md`
(2026-07-14).

Vrai point faible corrigé : `analysisSweep` basculait tout un lot en `queued` (`claimForAnalysis`)
puis enqueue un par un ; un enqueue qui lève orphelinait le reste du lot jusqu'au reclaim (15 min).
Extraction testable `src/analysis/sweep.ts` (`runAnalysisSweep`) : enqueue **isolé par
conversation** (un échec ne bloque plus le lot) + `reclaimQueued(id)` qui relâche aussitôt la
conversation en `pending` (reprise en secondes au tour suivant, pas 15 min). Store :
`PgConversationAnalysisStore.reclaimQueued` (gardé `WHERE status='queued'`). Tests : 4 unitaires
(`tests/analysis-sweep.test.ts`) + 2 intégration (`reclaimQueued` + garde). Bannière de démarrage
du worker corrigée (liste `analyze-conversation` quand la file est active).

Décisions actées (pas de code en plus) : (1) ré-tenter chaque tour sur transient est voulu, pas de
boucle serrée possible (un échec réel est global et fait aussi échouer le claim) ; (2) l'edge
« insert commité mais `send` rejette » est absorbé par `singletonKey` + idempotence du job + la
garde `reclaimQueued`.

## État (2026-07-06) : V1 LIVE — 1er envoi WhatsApp réel fait ✅

`mba.messagingme.app` est en **prod LIVE** (`DRY_RUN=false`). Un numéro **Zadarma**
(WABA neuf hors UChat) est branché sur l'app Meta dédiée « Messaging Me MBA »,
webhook actif (statuts de livraison), et le **premier message WhatsApp réel a été envoyé depuis
la console** (template `hello_world`, wamid Meta, livraison remontée). Assets/secrets Meta :
`brain/PROJECTS.md` §Meta/WhatsApp.

**Backend (feature-loop, chaque brique reviewée par un agent séparé) :**
- Loop 1 — webhook receiver async (signature timing-safe, ACK bouclier, file pg-boss durable,
  dédup idempotente, DLQ, BSUID-native).
- Loop 2 — wrapper Meta typé (`MetaClient`, retries/backoff, rate limiter, transport injectable).
- Loop 3 — mini-CRM + import CSV (user fields, reconnaissance colonnes, E.164, variables template).
- Loop 4 — moteur de campagne + garde-fous (opt-in, fréquence marketing-only, quality gate,
  **claim atomique** anti double-envoi, idempotent, report).
- Loop 5 — adaptateurs Postgres + services + routes HTTP + run bout-en-bout (prouvé E2E Supabase).

**Depuis (revues + corrections) :**
- Revue multi-agent Loops 3-5 (23 constats corrigés) + revue sécurité auth (12 constats).
- **Auth** : login JWT (scrypt async, rate-limit, hash leurre anti-énumération), isolation
  tenant sur toutes les routes, **RBAC** (écritures admin-only), `AUTH_SECRET` fail-fast en prod.
- **Suivi de livraison** : webhooks statut Meta -> `delivery_status` par message_id (monotone).
- **Robustesse** : création de campagne transactionnelle + sweeper des `sending` bloqués.
- **UI Next.js** (`web/`) : login, contacts + import CSV, campagnes (création + lancement +
  détail des statuts, auto-refresh).
- **Déploiement** : `mba.messagingme.app` (Docker VPS, NPM + Let's Encrypt). Cf `DEPLOY.md`.

Tests : ~148 unitaires + 10 intégration verts.

## Lot MBA — Contenu/Analytics/Support (2026-07-12) : phases 0-7 LIVE ✅

Grand lot exécuté en feature-loop (plan validé, revue transversale multi-agents + vérif adversariale par
phase, commit + deploy à chaque phase). Détail des décisions : `documentation.md §Décisions D1-D10`.
- **Ph 0** dette + aperçu WhatsApp du carousel. **Ph 1** refonte shell (sidebar gauche, pleine largeur,
  menu Compte à droite, slot Support). **Ph 2** Contenu I : Tags + User fields éditables (répercutés contacts).
- **Ph 3** Flows riches (texte/image/champ + mapping user field + création inline depuis un template),
  webhook mapping isolé, **migration 0016** (elements/ref/mapping).
- **Ph 4** Contenu II : édition/suppression Templates (garde-fou campagne active, header/footer/carousel
  non éditables) + édition-draft / « dupliquer pour modifier » Flows.
- **Ph 5** Analytics : plage de dates libre, funnel de lecture (read receipts), coût par campagne.
- **Ph 6** pastille initiales de l'agent dans l'inbox, **migration 0017** (sender_user_id).
- **Ph 7** Support : formulaire branché sur Resend.

Tests : **~380 verts**. Aucune régression. 2 migrations appliquées (0016, 0017).

## Lot 2 — Contact/Contenu/Analytics/Accueil/Ops (2026-07-12) : phases A-F LIVE ✅

Deuxième grand lot en feature-loop (plan `.loop/lot2-plan.md`, revue transversale + fixes par phase,
commit + deploy à chaque phase). Détail usage : `features.md`. Détail technique : `documentation.md`.
- **A** Fiche contact éditable (champs+valeurs+libellés, ajout champ/tag, `applyEdits` transactionnel).
- **B** Contenu liste-first + créer (Tags/Champs/Templates/Flows), aperçu au clic, **migration 0018** (table `tags`).
- **C** Templates : header **texte/image/vidéo** + footer (variable header interdite V1) ; aperçu WhatsApp header+footer.
- **D** Page **`/accueil`** (clic logo) : « Bonjour {prénom} », statut compte « jamais faux vert » (pull Graph),
  carte MBA déplacée hors Dashboard ; séparateurs de date inbox. **Migration 0019** (`phone_numbers.status`/tier).
- **E** Analytics : funnel PAR campagne (répondu attribué au dernier envoi), breakdown codes d'erreur Meta,
  graphe coût estimé filtrable campagne/template. **Migration 0020** (`campaign_recipients.error_code`).
- **F** Console **`/ops`** cross-tenant LECTURE SEULE (protégée `OPS_TOKEN`, rollup par tenant + charge pg-boss).
  Revue sécurité 10/10. `OPS_TOKEN` posé dans `.env.prod` du VPS.

Tests : **441 unit + 18 intégration**. 2 migrations (0019, 0020) appliquées avant deploy. Aucune régression.

## Lot 3 — Builder visuel (A formulaires + B automatisation) (2026-07-13) : LIVE ✅

Troisième grand lot en feature-loop (plan `.loop/lot3-builder.md`, revue transversale + fixes par phase,
commit + deploy à chaque phase). Deux builders DISTINCTS + le déclencheur campagne. Détail usage :
`features.md`. Détail technique : `documentation.md §Builder`.
- **Fix + quick wins** : bug suppression template (surface le `error_user_msg` de Meta au lieu de « Invalid
  parameter »), tag -> clic sur le compteur ouvre la **liste des contacts** taggés, **créer un nouveau champ
  depuis la fiche** contact, **miniature** de flow.
- **PA — Formulaires WhatsApp, TOUS les composants** : Dropdown/RadioButtonsGroup/CheckboxGroup, OptIn
  (consentement), passcode, date, **bouton final personnalisable**. Aperçu en direct. Menu Contenu>Flow
  renommé « **Formulaires** ». **Migration 0021** (`flows.cta`). 🔴 fermé (optin ne peut plus écraser un autre
  champ, défense front+back, RGPD).
- **PB1 — Workflow builder (modèle + éditeur visuel, SANS exécution)** : nouveau menu gauche « **Flow** »,
  éditeur **React Flow** (`@xyflow/react`), blocs template/inbox/flow/tag/field, flèches courbées drag,
  `+`/poubelle sur chaque arête, config par bloc. **Migration 0022** (table `workflows`).
- **PB2 — Moteur d'exécution** : `engine.ts` (`walk` linéaire), `executor.ts` (start applique les actions +
  persiste ; advance quand le contact répond, dédup `last_message_id`), avance branchée sur le webhook
  **isolée par message**. **Migration 0023** (table `workflow_runs`). 🔴 fermé (isolation par message).
- **PB3 — Déclencheur campagne (Template OU Workflow)** : le run de campagne DÉMARRE le workflow par
  destinataire au lieu d'un envoi template, en réutilisant l'infra campagne (claim/quality/fréquence), pas de
  nouvelle file. Front : contacts choisis d'ABORD, puis Template OU Workflow. **Migration 0024**
  (`campaigns.workflow_id` + template nullable). 🔴 fermé, **le plus sérieux** : le VRAI chemin de création
  `createWithRecipients` ne persistait PAS `workflow_id` (feature cassée en prod) alors que le test visait
  `insertCampaign`, une méthode sœur non branchée -> faux vert ; corrigé + test d'intégration remis sur le
  chemin réel. + 1 🟡 (toSummary null->'').

Tests : **~490 unit + 21 intégration**. 4 migrations (0021-0024) appliquées avant deploy. Aucune régression.
**BUILDER (A + B) TERMINÉ**, flux E2E vivant : campagne -> contacts -> workflow -> tag posé -> template envoyé
-> le contact répond -> avance -> inbox. ⚠️ mba LIVE (`DRY_RUN=false`) : tester une campagne workflow sur son
propre numéro avant un envoi large.

## Lot 5 — Builder v2 + variables + branche par bouton (2026-07-13) : LIVE ✅

6 modifs en feature-loop (plan `.loop/lot5-builder.md`, 3 phases, reviewer + 🔴 fermés + commit/deploy par phase).
- **P1 (layout)** : bot builder plein écran + nodes compacts (AppShell `fullBleed`), galerie de miniatures
  Formulaires, colonnes contact tél/BSUID/email, inbox plein écran.
- **P2 (variables)** : sélecteur « + Variable » (chip `[Prénom]`) + exemples Meta déterministes + **propagation
  malin** (table `template_param_hints` mig 0025, campagne pré-remplit son mapping). 🔴 fermé (clé paramHints
  absente n'efface plus les indices).
- **P3 (branche par bouton)** : node template à une sortie par bouton quick-reply, moteur `nextNodeByHandle` +
  `advance(+buttonPayload)` (repli 1re arête), envoi payload CONTRÔLÉ `btn:<index>`. 🔴 fermé (template sans
  quick-reply exposait 0 sortie -> repli sortie bas). ⚠️ **check LIVE Julien** : taper un bouton -> bonne branche.
- 516 unit + 24 intégration. 1 migration (0025). ⚠️ V2 (todo) : snapshot boutons figé + arêtes orphelines.

## Lot 4 — Retouches builder + identité BSUID (2026-07-13) : LIVE ✅

Quatre demandes de Julien + l'encapsulation d'identité BSUID. Revue transversale (agent séparé) : 2 🔴 fermés
+ vérifs. 501 unit + 23 intégration. Aucune migration (colonnes `bsuid`/`opt_in_source` déjà en 0001).
- **A. Aperçu Flow FIDÈLE** : composant partagé `web/components/FlowScreen.tsx` (écran WhatsApp réel : champs
  Material à label flottant, choix en lignes, bouton vert), utilisé par le builder (aperçu live) ET la popup au
  clic sur le nom. Colonne « Aperçu » du tableau retirée. Ancien rendu grossier supprimé.
- **B. Supprimer un formulaire** : Meta DRAFT->delete / PUBLISHED->deprecate, route DELETE (Meta avant store,
  422 si rattaché à un template), bouton + confirm.
- **C. Bouton campagne** : « Lancer » (brouillon) / « Reprendre » (en pause, relance les restants) seulement ;
  plus rien sur en cours / terminée / échec.
- **D. Identité BSUID** : `src/crm/identity.ts` (`classifyWaId`, `contactIdentity`) + `messagingTarget` (envoi
  `to` numéro / `recipient` BSUID). `bsuid` exposé (fiche, liste « Identifiant », campagne). Auto-création de
  fiche depuis l'inbound (numéro OU BSUID, isolée, opt-in 'unknown'). Matching étendu au bsuid
  (merge/tag/conversation). `buildRecipients` cible `phone ?? bsuid`. Détail : `documentation.md §Identité`.
- **2 🔴 fermés à la revue** : (1) l'envoi mettait le BSUID dans `to` au lieu de `recipient` (feature cassée dès
  le 1er contact BSUID) -> `messagingTarget` en source unique ; (2) « Lancer » caché aussi pour `paused`
  (campagne pausée par le quality gate non relançable) -> bouton « Reprendre ».

## Lot 6 — Refonte auth + onboarding (2026-07-13) : 5 phases LIVE ✅

Plan `.loop/lot6-auth.md`, feature-loop (reviewer séparé + 🔴/🟡 fermés + commit/deploy par phase). **Migration
0026** (`auth_tokens` + `tenants.status`) appliquée avant deploy.
- **Ph 1** fondations : `PgAuthTokenStore` (create/consume atomique, token sha256), `createTenantWithAdmin`
  transactionnel, `createPending`/`setPassword`, `getAuthState` + `tenantStatus`, crochet `locked`->403 (inerte).
- **Ph 2** inscription libre (`/signup` -> nouvel espace + admin), mot de passe perdu (`/forgot`, anti-énum),
  reset (`/reset/[token]`), changement (`/compte`). 🔴 fermé : `hashPassword` SYNC sur route publique ->
  event-loop DoS (le webhook tourne dans le même process) -> passé en async + `hashPasswordSync` pour seed/tests.
- **Ph 3** invitations (Resend) : `POST /invitations` (pending + token + email), accept (pose le mdp, rôle/tenant
  depuis la base pas le body). Front InviteCard + badge « invité » + `/invite/[token]`.
- **Ph 4** Google : `verifyGoogleIdToken` (jose + JWKS Google, **pas de nouvelle dépendance**), `POST /auth/google`
  (login/signup/invite par email vérifié), `GET /auth/config`, bouton GIS sur login/signup/invite. GOOGLE_CLIENT_ID
  posé au `.env.prod`. Julien a ajouté l'origine JS + publié l'app Google.
- **Ph 5** onboarding accueil : espace sans numéro -> zone grisée « Connecter ton numéro » (placeholder futur
  Embedded Signup). Pur front, « jamais de faux vert ».

## Lot 7 — variables template + bot builder + fiche contact (2026-07-13) : LIVE ✅

7 demandes de Julien. Exploration parallèle (7 agents) puis revue adversariale par chantier (6 agents) : **1 🔴 +
3 🟡 fermés**, 🔴 re-vérifié PASS. **Aucune migration** (réutilise `template_param_hints` 0025). 565 unit (+19).
- **C7 (bug 132000)** : une campagne via workflow dont le 1er node est un template envoyait **0 variable** ->
  rejet Meta. Fix : la closure `sendTemplate` (worker.ts) résout les `{{n}}` avec les attributs du contact (indices
  `template_param_hints`), repli exemple, fournit TOUJOURS N params. `buildWorkflowTemplateComponents` (PURE,
  testée), `resolveHintParams`, `getResolvableByPhone`, N via `list()` Meta caché 5 min.
- **C1** : corps du template en **chips lisibles** (`VariableBodyEditor` contentEditable, sérialise en `{{n}}`,
  caret-safe). 🔴 fermé : numérotation par MAX+1 (pas de collision après suppression d'une variable) + canonicalise
  1..N au submit ; 🟡 panneau exemples piloté par positions réelles.
- **C2** drag une flèche dans le vide -> crée un node (`onConnectEnd`). **C5** ✕ de suppression sur chaque node.
- **C3** vraie image dans la miniature (object URL local, révoqué). **C4** édition/suppression champs + Nom/Prénom
  sur la fiche (tél + BSUID lecture seule ; champ orphelin supprimable). **C6** tag du node « ajout de tag »
  déclaré dans Contenus > Tags (à la sauvegarde + au runtime, best-effort).

### Suivis ouverts (lots 1 + 2 + 3 + 4)
- **Envoi vers un BSUID non prouvé en prod** : le code route bien `recipient`, mais aucun contact BSUID
  n'existe encore (zéro trafic post-octobre). À valider au 1er BSUID réel (et confirmer l'heuristique
  `classifyWaId`). Cf `todo.md`.
- **PB2 avance sur n'importe quelle réponse** du contact (pas de branche par bouton quick-reply) : réservé à
  une itération V2 si un cas réel l'exige.
- **Funnel campagnes workflow** : delivered/read/replied = 0 (message_id synthétique `wf-<id>`, la livraison
  Meta n'est pas suivie pour ces envois). Limitation V1 assumée.
- ✅ **Refonte auth : FAITE (Lot 6, 2026-07-13)** : inscription libre + Google + invitations Resend + mot de passe
  perdu/reset/changement, tous LIVE. Reste un raffinement V2 non bloquant (invariant admin excluant les pending,
  cf `todo.md`).
- ✅ **Resend HORS mode test (2026-07-13)** : domaine `messagingme.app` **vérifié** dans un compte Resend dédié
  (region eu-west-1). `.env.prod` du VPS basculé : `RESEND_API_KEY` = clé de CE compte (⚠️ PAS l'ancienne clé du
  compte de test), `SUPPORT_FROM=support@messagingme.app`, `SUPPORT_TO=julien@messagingme.fr` ; conteneurs
  `mba-api`/`mba-worker` recréés (`up -d --force-recreate`). Envoi réel confirmé (Resend id retourné). Sauvegarde
  `.env.prod.bak.*` sur le VPS. La clé vit UNIQUEMENT dans `.env.prod` (jamais le repo).
- **Analytics (ph 5)** : le filet de revue multi-agents a stallé (souci workflow) ; revue manuelle + 32 tests
  stats clean, déployé pour test par Julien. À re-vérifier si un retour terrain remonte un souci.
- **Coup d'œil navigateur (Julien)** sur les visuels des lots 1 (ph 3-7), 2 (A-F : `/accueil`, dates inbox,
  cartes analytics, table `/ops`) et 3 (**Contenu>Formulaires** builder tous composants, menu **Flow** éditeur
  de workflow, **Campagnes** switch Template/Workflow).

## Embedded Signup + i18n + fixes campagne (2026-07-16) — LIVE ✅

- **Campagnes workflow : 3 pannes SILENCIEUSES fermées** (le « envoyé mais rien reçu » persistant) : cap fréquence
  24h retiré, indice périmé → 0 destinataire (dropdown coerce), **bouton FLOW #131009** (composant bouton flow +
  flow_token, vérifié vs Cloud API). Détail : `CLAUDE.md` §Gotchas 2026-07-16 + `brain/LEARNINGS.md`.
- **Champs système + sélecteur de variable dropdown** (constante code, sans migration ; attributs bsuid/wa_id ajoutés).
- **Brique Embedded Signup (Tech Provider)** construite + reviewée (2 failles multi-tenant corrigées avant prod) +
  déployée **OFF par défaut** (mig 0029 `waba_credentials`). Activée avec le `config_id` réel (bouton live).
- **i18n FR/EN** sur toute l'app (moteur `web/lib/i18n.tsx`, toggle menu Compte). Logo Meta Business Agent sur
  l'accueil, landing admin → Home, compte de test reviewer créé.

## Programme 16 features — lots A-E (2026-07-16) : LIVE ✅

Cinq feature-loops enchaînées (cartographie 9 explorers → plan `.loop/lotA..E-*.md` validé par Julien → boucle →
reviewer séparé → commit + deploy auto). **13 features + le socle API en prod.** Le reviewer a attrapé 4 vrais
bugs avant merge (dont le wiring `templateName` mort, cf `brain/LEARNINGS.md`).
- **A — Cohérence campagne/template** : variables template = source commune (6 champs de base + persos, comme la
  campagne), sélecteur de langue (39 langues + whitelist serveur), boutons visibles dans la miniature, écran
  campagne en 3 zones (nom en haut).
- **B — UX** : inbox auto-refresh (liste 15s / fil 4s, anti-saut-de-scroll, pause onglet masqué), analytics
  période FIGÉE en haut, suppression complète de « créer un compte » par mdp (invitations only, -221 lignes).
- **C — Scénario** : AUTO-SAVE (debounce + flush démontage/beforeunload keepalive + saves sérialisés, statut
  brouillon droppé mig **0030**, ⚠️ 1re migration DROP = deploy AVANT migrate), node **« message rapide »**
  (2-3 quick replies, `sendInteractive`, branche par bouton stable). Node `flow` no-op → différé Lot 7.
- **4a — Identifiants publics (schéma A)** : `<type>_<code-client>_<ULID>` ADDITIFS (mig **0031** + backfill
  `db/backfill-codes.ts`), racine client immuable, génération à l'INSERT (scn/usr/fld/tag), affichage discret.
  4b (nodes + champs système + endpoints) différé.
- **E — Analytics erreurs** : par TEMPLATE (dropdown, agrégation client) + par période (plage globale). 🔴 réel
  attrapé par le reviewer : wiring `index.ts` perdait le 3e arg → corrigé.
- **F (= 4b) — fin du socle identifiants** : codes des NODES mintés CÔTÉ SERVEUR au save (`nod_<client>_<ulid>`
  dans node.data.code, code valide conservé = stabilité, étranger/malformé re-minté = anti-forge), champs
  SYSTÈME déterministes (`fld_<client>_sys_<key>`), backfill nodes (1 graphe). ZÉRO migration. **Socle #12/#13
  COMPLET** ; endpoints API publics = chantier dédié (todo).
- **G (= 6) — i18n anglais COMPLET** : bug `<html lang>` fermé, day/format locale-REQUIS (Today/Yesterday,
  1,000, 42%, customers…), 0 `fr-FR` hors libs, `LocaleToggle` pré-login (5 pages). Sweep 11 agents parallèles.
  ⚠️ 2 leçons : test hors-sweep cassait le tsc racine (attrapé par le reviewer) + **gate pipé = exit masqué**
  (cf `brain/LEARNINGS.md`). Gates relancés exit codes réels.
- Tests : **707 unit** (681 → 707 : +26 nets). Migrations 0030-0031 appliquées. Baseline verte à chaque lot.

## Lot 7 — Flow avancé (2026-07-17) : LIVE ✅ — PROGRAMME 16 FEATURES TERMINÉ

Dernier lot du programme, feature-loop 1 tour (plan `.loop/lot7-flow-avance.md` validé, cartographie 5 explorers
+ recherche spec + 4 SONDES LIVE avant plan, reviewer transversal PASS avec 2 🟡 appliqués, commit `9fd2002`).
- **C1 fix node `flow`** : le node de scénario ENVOIE le formulaire (message interactif type flow, calque
  sendQuickMessage, accroche + CTA configurables dans le node). **Garde fenêtre 24 h à 3 étages** : 400 au save
  d'un graphe qui OUVRE sur un flow/message rapide, skip défensif au start(), badge rouge sur le node d'ouverture
  réel dans le builder. La complétion nfm_reply avance le run (mécanique existante, inchangée).
- **C2 multi-écrans** : onglets d'écrans dans le builder (max 10, titre + bouton « Continuer » par écran),
  ids `FORM`/`FORM_B`… (écran 1 = FORM pour toujours, sondé : chiffres REJETÉS par Meta), payload `complete`
  agrégé par refs globales + `_ref` -> **pipeline webhook/mapping inchangé d'une ligne**. Colonne jsonb
  polymorphe (plat = 1 écran à la lecture), ZÉRO migration. Aperçu paginé (builder + modale), miniature = écran 1.
- **C3 champs conditionnels** : « Visible si… » par élément (source = liste choix unique/consentement du même
  écran, est/n'est pas, valeur = option ou coché) -> propriété `visible` backticks. Sondé : champ masqué OMIS
  du payload (zéro écrasement de champ contact), requis caché ne bloque pas la soumission.
- **Sonde committée** `scripts/sonde-flow-live.mts` : fixture générée par LE CODE PRODUIT postée en draft sur
  le WABA réel -> `validation_errors == []` -> delete. Gate T6 rejouable à chaque évolution du générateur.
- Tests : **741 unit** (723 -> +18). Gates exit codes réels. Deploy vérifié (3 containers Up, HTTP 200).

## Lot 8 — Campagne « une-page, 2 étapes » (2026-07-17) : LIVE ✅

Refonte de l'écran campagne. Feature-loop 5 phases (plan `.loop/lot8-campagne-une-page.md` validé, cartographie
5 explorers, reviewer séparé PAR PHASE -> 5 vrais bugs attrapés, commit + deploy par phase). Détail usage :
`features.md §Campagnes`. Détail technique : `documentation.md §Campagne`.
- **P1 (f592536)** : PLEINE LARGEUR (AppShell fullBleed), une seule page en 2 ÉTAPES (Préparation / Lancement),
  lancement RAPATRIÉ sur l'écran (createCampaign -> runCampaign + polling inline). Fini « préparer ici, lancer là ».
- **P2 (055aea1, mig 0032)** : sélecteur de SOURCE (📇 Liste de contacts / 📄 Import / 🔗 HubSpot grisé) + mini-CRM
  REQUÊTABLE : `query`/`count`/`idsForFilters` (WHERE paramétré, tenant toujours) filtres tags ET/OU, opt-in,
  tél commence/contient, valeur de champ, nom ; compteur live « N correspondent ».
- **P3 (257b06b)** : import fichier comme source = composant partagé `CsvImport` (extrait, zéro dupe) + tag
  OBLIGATOIRE, puis pivot sur la source CRM taggée. Bonus : rapport d'import enfin visible côté Contacts.
- **P4 (56b844b, mig 0033)** : DÉBIT ajustable 1-80/min (slider, défaut = max), RateLimiter par campagne. Vrai 🔴
  attrapé : un timeout de job FIXE ne couvre pas un run throttlé long -> rejeu parallèle. Fix = timeout PAR JOB
  dimensionné (`campaign/pacing.ts`), cf `brain/LEARNINGS.md`.
- **P5 (74399d2, mig 0034)** : PLANIFICATION maintenant/plus tard (datetime -> ISO UTC), statut `scheduled` +
  sweeper 60s (`schedule-sweep.ts`), annulable. Badge « planifiée » + date dans la liste.
- Tests : **761 unit** (745 -> +16 : filtres, débit+pacing, sweeper, route schedule/cancel) + intégrations
  (filtres CRM, programmation). 3 migrations (0032-0034). Reviewers PASS. Restent E1 (drive navigateur) + V1
  (œil Julien) hors boucle.

## Prochaine étape

1. Faire approuver un template Marketing FR à variable pour de vraies campagnes.
2. **Onboarding client (Embedded Signup) : brique FAITE + déployée.** Côté Meta, **Access Verification (Tech
   Provider) VÉRIFIÉE le 2026-07-17 ✓** (email Meta « Your business has been verified as a Tech Provider »,
   business « Messaging Me » ID 103185632463539). **Reste l'App Review, encore en review** (~20 j). Rien à
   faire côté produit d'ici là : quand ce dernier feu passe au vert, le bouton marche de bout en bout et on
   tourne la vraie vidéo de démo. Surveiller mails Meta + onglet Required actions. Voir `todo.md`.
3. **Programme 16 features : TERMINÉ (16/16 + socle codes publics).** Restent les chantiers hors programme
   (cf `todo.md`) : **HubSpot import #14** (multi-repo, re-consentement portail = action Julien) · chantier dédié
   **endpoints API publics** · analytics palier L (erreurs Inbox/Workflow).

## En attente (dépendances externes)

- **MBA (agent auto-réponse)** : bloqué par les ToS (403 « Meta Business AI Terms »), gating
  vertical. Veille à mettre en place (cron `agent_eligibility`). Parqué.

## Reste (non bloquant) — voir `todo.md`

- TLS pooler en vérif complète (pinner la CA Supabase).
- Unicité email globale (décision produit).
- Pagination contacts UI, quality rating alimenté par webhook, tests DLQ/CI intégration.
