# wip.md — travail en cours

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

### Suivis ouverts (lots 1 + 2 + 3 + 4)
- **Envoi vers un BSUID non prouvé en prod** : le code route bien `recipient`, mais aucun contact BSUID
  n'existe encore (zéro trafic post-octobre). À valider au 1er BSUID réel (et confirmer l'heuristique
  `classifyWaId`). Cf `todo.md`.
- **PB2 avance sur n'importe quelle réponse** du contact (pas de branche par bouton quick-reply) : réservé à
  une itération V2 si un cas réel l'exige.
- **Funnel campagnes workflow** : delivered/read/replied = 0 (message_id synthétique `wf-<id>`, la livraison
  Meta n'est pas suivie pour ces envois). Limitation V1 assumée.
- **Refonte auth** (invitations Resend + gestion du mot de passe + « mot de passe perdu » + Google OAuth) :
  demandée, PAS commencée, gated sur la vérif du domaine Resend + un client OAuth Google (actions Julien). Cf `todo.md`.
- **Support** : toujours en **mode test** Resend (n'envoie qu'à l'adresse du compte `testsuperchatjd@gmail.com`).
  Pour router vers `julien@messagingme.fr` : vérifier un domaine chez resend.com/domains (records DNS
  Cloudflare) puis basculer `SUPPORT_FROM=support@messagingme.app` + `SUPPORT_TO=julien@messagingme.fr` dans
  `.env.prod` + `docker compose up -d --force-recreate`. Clé Resend déjà dans `.env.prod` (dormante avant ph 7).
- **Analytics (ph 5)** : le filet de revue multi-agents a stallé (souci workflow) ; revue manuelle + 32 tests
  stats clean, déployé pour test par Julien. À re-vérifier si un retour terrain remonte un souci.
- **Resend** : basculer le support hors mode test (vérifier le domaine chez resend.com/domains -> DNS
  Cloudflare -> `SUPPORT_FROM=support@messagingme.app` + `SUPPORT_TO=julien@messagingme.fr` dans `.env.prod`
  + `up -d --force-recreate`). Action Julien.
- **Coup d'œil navigateur (Julien)** sur les visuels des lots 1 (ph 3-7), 2 (A-F : `/accueil`, dates inbox,
  cartes analytics, table `/ops`) et 3 (**Contenu>Formulaires** builder tous composants, menu **Flow** éditeur
  de workflow, **Campagnes** switch Template/Workflow).

## Prochaine étape

1. Faire approuver un template Marketing FR à variable pour de vraies campagnes.
2. **Onboarding client (Embedded Signup)** : configurer Facebook Login for Business (config_id),
   coder le bouton ES + l'échange de token, puis Access Verification (Tech Provider) + App Review
   (screencast). Voir `todo.md`.
(Le token System User permanent est déjà posé, cf `todo.md` — plus d'urgence token.)

## En attente (dépendances externes)

- **MBA (agent auto-réponse)** : bloqué par les ToS (403 « Meta Business AI Terms »), gating
  vertical. Veille à mettre en place (cron `agent_eligibility`). Parqué.

## Reste (non bloquant) — voir `todo.md`

- TLS pooler en vérif complète (pinner la CA Supabase).
- Unicité email globale (décision produit).
- Pagination contacts UI, quality rating alimenté par webhook, tests DLQ/CI intégration.
