# WIP

## EN COURS (2026-08-21) — lot « inbox, comptes, moderation » : 4 items sur 7 faits

Cadrage complet et decisions de Julien : `.loop/lot-inbox-comptes-moderation.md`.
**Pousse, PAS deploye.** Migrations a appliquer AVANT le code : **0068, 0069, 0070**.

### Fait
1. **Brouillons de campagne** (0068) : le nom saisi cree un brouillon de COMPOSITION, retrouvable et
   reprenable. Table a part : `campaigns.status = 'draft'` designe autre chose (une campagne complete non
   lancee, qu aucune route ne sait modifier).
2. **Entree Accueil** dans la barre laterale, au-dessus d Inbox, pas pour les agents.
3. **Socle de volume de l inbox** (0069) : filtres et pagination en SQL, curseur sur (last_message_at, id),
   compteur « A traiter » compte sur toute la base. Prerequis des trois autres items.
4. **Fiche contact partagee** : `ContactDetail` extrait de la page mini-CRM, ouvert dans l inbox au clic sur
   le NOM (la vignette continue d ouvrir la conversation).
5. **Affectation** (0070) : manager/admin confient une conversation ; refus applique CoTE SERVEUR sur les
   trois routes qui ecrivent. Premiere prerogative reelle du role manager.

### Reste (3 items, decisions deja prises)
- **Moderation** : reutiliser l analyse IA existante (delai de 15-20 min assume par Julien), blocage d un
  contact = plus d envoi ET plus d affichage, avec un ECRAN DEDIE dans les parametres pour debloquer.
  ⚠️ Cet ecran est la SEULE porte de sortie : sans lui un contact bloque est perdu. Meme lot, jamais apres.
- **Superadmin depuis /ops** : ⚠️ casse le principe ecrit « ops = LECTURE SEULE ». Lecture seule au premier
  lot, marquage « lu » neutralise, journalise cote ops et invisible cote client, bandeau permanent.
- **Multi-comptes par email** : ⚠️ revient sur la migration 0010 (« un email = un compte »), et deplace le mot
  de passe hors de `users` (un seul par ADRESSE). Migration d authentification : a faire SEULE, en dernier.

### Piege trouve DEUX fois dans la meme journee, a ne pas reperdre
Une reponse 200 sans le champ attendu (`drafts`, `users`) passe le try/catch et pose `undefined` dans un etat
type tableau. Le rendu suivant casse TOUT l ecran, pas seulement la section concernee. `Array.isArray` sur
toute liste venue de l API, systematiquement.

---


## EN COURS (2026-08-21) — parametres d'activation MBA : code pousse, PAS deploye

Pousse sur `main` (`9893793` + `89d9a47`). **Rien n'est en prod** : la prod tourne toujours sur `139eba2`,
migrations jusqu'a 0066.

### Ce qui est fait
- **Regle du texte libre** (`9893793`) : une reponse ECRITE a un bloc a boutons ne part plus dans la branche
  du premier bouton. Trois cas : bouton cable -> sa branche ; sinon arete LIBRE -> on la suit ; sinon fin du
  run et l'agent reprend la parole. Le builder gagne la sortie « toute autre reponse » sur les blocs a
  boutons, sans quoi le 2e cas serait inatteignable.
- **Ecran Activation** (`89d9a47`, migration **0067**) : MBA > Parametres > Activation, deux questions.
  Ouvre `handoff` a `PATCH /mba/:pn/settings`, stocke le choix (`mba_handoff_mode`), l'applique chez Meta
  tout de suite, et fait varier `handoff.enabled` selon les heures d'ouverture par un nouveau balayage.
  Le delai de reprise quitte l'Accueil, et son texte est corrige (PREMIERE intervention, pas derniere).

### DEPLOYE le 2026-08-21
Migration 0067 appliquee, puis `docker compose up -d --build`. Les trois conteneurs sont sains.
⚠️ Le commit `ccd2da2` (correction du libelle mensonger, voir ci-dessous) n'est PAS encore deploye.

### Abonnement webhook : CORRIGE le 2026-08-21
`POST /{app_id}/subscriptions` -> l'app est desormais abonnee a **`messages` + `standby` +
`messaging_handovers`** (elle n'avait que `messages`). C'etait un trou majeur : la doc Meta dit que quand
l'agent tient le fil, tout passe par `standby` et que `messages` reste VIDE. L'inbox serait donc devenue
muette le jour de l'allumage de MBA chez un client, **sans aucune erreur nulle part**.
Au passage, inconnue levee : Meta ACCEPTE `standby` et `messaging_handovers` sur un WABA, alors qu'ils ne
figurent pas dans sa liste publique de champs.

### Ce qui reste, dans l'ordre
1. 🔴 **Le test en conversation REELLE est BLOQUE par l'absence de moyen de paiement.** Aucun message
   WhatsApp n'atteint l'agent : le bac a sable (`agent_test`, onglet « Tester ») est le SEUL canal. Ce n'est
   pas un manque de notre cote, il n'y a rien a tenter d'ici la. La forme du payload `messaging_handovers`
   reste donc inconnue, et `ownerFromHandover` reste une lecture devinee.
2. **La pastille « quelqu'un a besoin d'aide »** dans l'inbox : demande une donnee NOUVELLE (`app_human` ne
   distingue pas « escalade, personne ne s'en occupe » de « un operateur a repondu »). Les mesures du
   2026-08-21 la rendent BEAUCOUP plus urgente : un refus de l'agent produit une reponse VIDE.
3. **Ecrire le texte lu par le client** (`message` + `message_selection: CUSTOM`), une fois son effet mesure.

### Mesures au bac a sable (2026-08-21), tableau complet dans documentation.md
- « je veux parler a un conseiller » -> `customer_request`, l'agent annonce le transfert.
- Question hors de sa base -> `handoff_reason: null`. 🔴 **Quand il ne SAIT pas, il ne passe PAS la main**,
  il renvoie vers les coordonnees. L'intuition inverse etait fausse.
- Incident vecu + demande de dedommagement -> **`integrity_violation` et reponse VIDE**. Ni l'incident seul
  ni le mot « remboursement » seul ne le declenchent : c'est la combinaison.
- Consequence : le libelle de l'ecran Activation promettait un transfert « quand l'agent ne sait pas ».
  Corrige dans `ccd2da2`, a deployer.

### Mesure faite (etape 0 du plan)
`GET {WABA}/subscribed_apps` sur le WABA de test : **deux** apps abonnees, la notre (`988129420727963`) et
**« Business Agent »** de Meta (`1143680903703001`). Cette reponse liste les APPS, pas les CHAMPS : la sonde
`scripts/sonde-webhooks.mts` interroge desormais aussi `{app_id}/subscriptions` (jeton d'application requis),
qui est la seule facon de savoir si `standby` et `messaging_handovers` nous arrivent.

### Ce qu'on ne doit PAS promettre au client
- Qu'un humain ne peut pas prendre la main : aucun verrou n'existe, ni chez nous ni chez Meta.
- Que « jamais » empeche l'agent de transferer : il decide seul. `enabled` dit s'il LACHE le fil ensuite.
- Que les heures d'ouverture pilotent autre chose que ce passage de main et la clause de scenario.

Dossier complet : `.loop/mba-parametres-activation.md`.

---

## TERMINE ET EN LIGNE (2026-08-19/20) — le detail est passe dans features.md / documentation.md

Prod sur **`139eba2`**, migrations jusqu'a **0066**, CI verte. Trois lots livres, plus rien en cours dessus :

1. **UX + exports + statut manager** : un seul bouton « Rajouter des contacts », export PDF des cartes
   d'Analytics et des tableaux, export CSV du journal des actions, statut `manager` (mig 0065), messages de
   service dans Analytics quanti, devise sur les couts, barres d'histogramme jointives.
2. **Tracage des clics sur les liens de templates** (mig 0066) : substitution a la soumission Meta,
   redirection publique `/r/:code`, comptage, re-habillage a la relecture, et la correction d'une case qui
   MENTAIT dans Mes tableaux (un bouton URL proposait « a clique », que Meta n'emet jamais).
3. **Carte « Clics sur les liens »** dans Mes tableaux, tous envois confondus.

Ou lire quoi : le **fonctionnel** dans `features.md` (sections Templates, Analytics, Contacts, Comptes), la
**technique** dans `documentation.md` (§ Tracage des clics, § Export PDF, § Role manager), ce qui **reste
ouvert** dans `todo.md`.

### Ce qui reste ouvert (detail dans todo.md)
- Les **droits du manager** : le statut existe, il ne donne rien de plus qu'un agent. Decision de Julien.
- Le **premier test reel de bout en bout** du tracage : jamais fait. La redirection est verifiee en prod, la
  substitution en test contre un faux Meta, mais aucun template avec un lien n'a encore ete cree depuis la
  console.
- Deux templates d'essai a retirer du WABA de test (le token ne sait pas les supprimer).

### Piege trouve en construisant, a ne pas reperdre
`recordOutboundByWaId` retombe sur `type: 'template'` quand l'appelant ne precise rien : il a d'abord servi
aux envois de campagne. Un test qui n'en dit rien enregistre donc des templates en croyant enregistrer des
messages de service.

## POINT DE REPRISE (2026-08-19, apres-midi)

### En production
Prod sur **`e4d2c8e`**, migrations jusqu'a **0065**. Sont EN LIGNE : le lot des 4 demandes (bug campagne,
creation de contact, bloc Action opt-in/opt-out, Analytics multi-selection) ET « Analytics > Mes tableaux ».

⚠️ **Les mesures ont commence a s'accumuler le 2026-08-19 vers 15h30.** Toute periode anterieure reste vide,
c'est normal et l'ecran le dit. Verifie ce jour-la : le scenario « randstad » avait tourne a 9h49, donc bien
AVANT la mise en service, d'ou un tableau vide qui n'etait pas un bug. Le chemin d'une CAMPAGNE passe bien par
l'instrumentation (`worker.ts` -> `executor.start` -> `apply`), donc les envois suivants sont mesures.

Le deploiement a aussi emporte le front e-mail d'une session concurrente (ecran Boites SMTP, page Modeles
d'email, node dans le builder). Le node est VERROUILLE tant qu'aucune boite n'est connectee, avec l'infobulle
qui l'explique : rien ne peut partir par erreur.

### « Analytics > Mes tableaux » — ce qui est en ligne
Migration **0063** (`workflow_node_events`) + les 4 phases. CI verte, et 125 tests d'integration verts contre
la base de production apres deploiement.

Constat qui commande tout : **rien ne reliait un message envoye au bloc qui l'a envoye**. Il a fallu
instrumenter. **Les mesures demarrent au deploiement, pas d'historique retroactif.**

- `walk()` rend des ETAPES `{ nodeId, action }` : le bloc voyage AVEC son action.
- L'executeur mesure `sent`/`failed` sur l'issue reelle, `reply_button` (avec le handle) et `reply_text`.
- Les accuses Meta retrouvent leur bloc par `meta_message_id` (idempotent ; `sent` exclu, deja compte).
- Route `GET /tenants/:t/stats/workflow/:workflowId` : compteurs BRUTS.
- Ecran `/dashboard/tableaux` : le scenario s'affiche TEL QU'IL EST DESSINE (memes positions, memes fleches),
  blocs non-mesurables grises et inertes, panneau des mesures a droite comme dans l'editeur. Rendu par
  `web/components/ScenarioCanvas.tsx`, composant SEPARE du builder : celui-ci porte l'auto-save, et un mode
  « lecture seule » y aurait mis un enregistrement automatique a un clic d'un ecran de consultation.
- Le tableau est un HISTOGRAMME (`web/components/TableauHistogramme.tsx`) : barres verticales groupees par
  bloc, espace entre les groupes, UNE SEULE ligne d'abscisse (c'est elle qui dit que les groupes sont du meme
  parcours). UNE couleur par NATURE, sauf les clics qui prennent des nuances par POSITION du choix, sans quoi
  deux barres voisines du meme bloc seraient indiscernables. Hauteurs relatives au MAXIMUM DU TABLEAU, pas de
  chaque groupe. Regles de couleur et de groupement dans `lib/mesures-scenario.ts`, donc testables.
- ⚠️ RGPD : la purge ANONYMISE ces lignes (elles portent un wa_id), elle ne les supprime pas.

L'ENREGISTREMENT est fait (migration **0064**, `workflow_reports`) : ouvrir, nommer, enregistrer, mettre a
jour, supprimer. Un tableau ne contient que la SELECTION, jamais des chiffres : ils se recalculent a la
lecture, donc un tableau rouvert sur une autre periode repond juste.

« Echecs » et « Delivres » ne sont proposes que sur le PREMIER bloc de message : apres lui, le message part a
quelqu'un qui vient de repondre, l'envoi aboutit et arrive quasiment toujours (demande de Julien).

**Les clics sur boutons URL ne sont PAS mesurables** : Meta n'envoie aucun evenement. Chantier separe.

### ⚠️ CI rouge le 2026-08-19 au soir : test INSTABLE de la session e-mail
`web/e2e/email-accounts.spec.ts:90` echoue en CI (`getByText('Support')` matche 3 elements) alors qu'il passe
en isolation en local (6/6). Les 172 autres tests passent. Ce n'est PAS mon lot : signale a Julien plutot que
corrige, le fichier appartenant a une session active. **A reprendre : un rouge intermittent finit par rendre le
rouge normal, et c'est exactement ce qui a masque un rouge systematique ce matin.**

Deux executions CI sont aussi restees BLOQUEES 25 min sur `npx playwright install --with-deps` (incident
d'infrastructure, pas le code). Annulees puis relancees, la relance a tourne en 3 min.

### ⚠️ La CI fait partie du controle avant deploiement
Elle a ete rouge a chaque push pendant des heures sans que je la regarde (voir le commit `d442ea3`).
`gh run list` avant tout deploiement, au meme titre que `git log <deploye>..HEAD`.

### Session e-mail en parallele
Une autre session travaille sur le node « Envoi de mail » dans le MEME depot et commite sur `main`. Ne jamais
committer par repertoire ni par `-A` : chemins de FICHIERS explicites.

# wip.md — travail en cours

## Lots A-F + E.2 (2026-08-02/03) : LIVE ✅

Gros lot demandé par Julien, exécuté en feature-loop avec un reviewer séparé par sous-lot (revues
adversariales multi-lentilles). Tout est déployé.

- **A** nom libre par bloc + page Contenu > Blocs en Type | Nom | Scénario | Code.
- **B** bloc « Action » unique (ajouter/retirer tag, mettre à jour/vider champ) qui remplace les blocs tag et
  champ dans la palette (les anciens restent lisibles, zéro migration).
- **C** cohérence du contrôle du fil : routage standby, un scénario qui atteint le bloc inbox passe la main,
  filtre « À traiter », comportement au retour réglable par espace et par conversation (mig 0051), blocs MBA
  grisés et inertes.
- **D** un scénario peut démarrer sans template ; en contrepartie le sélecteur de campagne ne propose que les
  scénarios lançables.
- **E** section Automation : déclencheurs mot-clé et nouveau contact (mig 0052).
- **F** tester un scénario par lien wa.me + QR, conversation de test exclue des stats et de l'analyse (mig 0053).
- **E.2** déclencheurs tag ajouté et conversation analysée, via une file `automation-event` (pont API vers worker).

Ce que les revues ont rattrapé, et qui vaut d'être retenu : un run de campagne non démarré était compté comme
envoyé ; l'émission « tag ajouté » passait par un point partagé avec les campagnes (envoi de masse possible) ;
un anti-rebond par contact ne borne rien à l'échelle d'une population (d'où un plafond horaire) ; un parcours
en attente sans expiration rendait un contact injoignable à vie.

Tests 1151 -> 1376. Prochaine migration = 0054.

## Lot UX 6 chantiers (2026-07-28) : LIVE ✅

Lot de 6 demandes produit/UX de Julien, en feature-loop (plan validé → boucle code / reviewer(s) séparé(s) /
tests → commit + deploy par cluster). **Tout en prod.** Détail usage : `features.md`.
- **Mini-CRM** (mig **0049** soft-delete) : moteur de filtres sur l'écran Contacts (5 ops de champ,
  tag possède/ne possède pas, Email dédié) + sélection multi + « tout sélectionner (N) » + menu Action
  (tag +/-, poser un champ, **suppression douce** réversible). Soft-delete propagé aux chemins d'envoi ; ré-upsert ressuscite.
- **Scénarios** : bouton **Auto-arranger** (fonction pure `autoLayoutHorizontal`) + menu 3 points
  (Renommer via PATCH existant / Dupliquer route neuve, codes de node re-mintés / Supprimer) + colonne date.
- **Campagnes UX** : nom obligatoire étape-0 (grise le reste), Expéditeur en bandeau, jauge de débit défaut 60,
  hover template « MBA prend le relais ».
- **Contenu > Blocs** : recherche cumulable (mot-clé/contenu/type), fonction pure `filterNodes`, filtrage client.
- **Flow field mapping** : champs de base (Nom/Prénom/Email) proposés + suggérés par libellé ; « Nom » routé
  vers `profile_name` via la **sentinelle `@profile_name`** (impossible à produire par slugify → pas de collision).
- **Guide MBA** : page `/mba` de guidage client (contenu, pas de logique).

**Qualité** : reviewers séparés par cluster → **7 🔴 réels corrigés** (fuite soft-delete sur les ENVOIS,
crash 500 `fieldFilters:[null]`, collision clé email `addRow`, course réseau sur compteur de suppression,
SQL double-`tags=`, détournement `profile_name` par slug, 1re fuite campagne). Apprentissages : `brain/LEARNINGS.md`
(2026-07-28). Tests : **~1116 → 1151**. 1 migration (0049). 8 commits sur `main`, déployés (`13d39b7`→`8de2565`).
⚠️ **Prochaine migration mba = 0050.** Restent les vérifs visuelles Julien (hors boucle).

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
- **D. Identité BSUID** : `src/crm/identity.ts` (`classifyWaId`, `waIdOf` ; le `contactIdentity` serveur listé
  ici à l'origine n'a jamais eu d'appelant, supprimé le 2026-07-18) + `messagingTarget` (envoi
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

## Lot 9 — ConvAnalyzer light dans Analytics (2026-07-17) : LIVE ✅

Feature-loop 2 phases (plan `.loop/lot9-convanalyzer.md`, cartographie 4 explorers dont le repo convanalyzer
externe, reviewer séparé par phase PASS). Le moteur d'analyse (Pièce 1, actif en prod, sans lecteur) est
surfacé dans Analytics. Détail usage : `features.md §Analytics`. Détail technique : `documentation.md
§Conversations (analyse)`.
- **Phase A (2dbc226)** : couche de LECTURE `src/stats/conversation-stats.pg.ts` (agrégats en une passe +
  liste quali, `tenant_id=$1` partout) + 2 routes admin-only (`/stats/conversations` + `/list`, filtres enum
  validés) + api.ts. 1er lecteur de `conversation_analysis`. ZÉRO LLM, ZÉRO migration.
- **Phase B (c88cdcf)** : bloc `ConversationAnalysisCard` (donut sentiment SVG maison, barres intent/action,
  compteurs, top topics ; table quali filtrable -> clic ouvre le fil inbox via deep-link `?c=`). Empty-state
  différencié (inactif vs aucune donnée sur la période).
- Tests : **763 unit** (+2 route) + intégration Supabase (agrégats sur jeu réel, scope tenant croisé).
  Reviewers PASS. ⚠️ Sémantique `created_at` = date de dernière analyse (cf `brain/LEARNINGS.md`). V1/V2 (rendu
  visuel + montée en charge du trafic) = vérif Julien. Base posée pour un futur agent IA décisionnel (V2).

## Prochaine étape

1. Faire approuver un template Marketing FR à variable pour de vraies campagnes.
2. **Onboarding client (Embedded Signup) : brique FAITE + déployée.** Côté Meta, **Access Verification (Tech
   Provider) VÉRIFIÉE le 2026-07-17 ✓** (email Meta « Your business has been verified as a Tech Provider »,
   business « Messaging Me » ID 103185632463539). **Reste l'App Review, encore en review** (~20 j). Rien à
   faire côté produit d'ici là : quand ce dernier feu passe au vert, le bouton marche de bout en bout et on
   tourne la vraie vidéo de démo. Surveiller mails Meta + onglet Required actions. Voir `todo.md`.
3. **Lots A-F + E.2 : TERMINÉS et déployés (2026-08-03).** La console sait désormais déclencher un scénario sur
   un événement (Automation) et se tester sans campagne (lien wa.me + QR). Suites identifiées en revue mais NON
   traitées : cf `todo.md` (sweeper des parcours en attente, contact de test compté dans la stat Contacts,
   signal « nouveau contact » perdu si le webhook est rejoué).
4. **Programme 16 features : TERMINÉ (16/16 + socle codes publics).** Restent les chantiers hors programme
   (cf `todo.md`) : **HubSpot import #14** (multi-repo, re-consentement portail = action Julien) · chantier dédié
   **endpoints API publics** · analytics palier L (erreurs Inbox/Workflow).

## Lot UX du 2026-08-17 (soir) : LIVRÉ, déployé, et porté dans `features.md`

Neuf retouches demandées d'un bloc, plus deux bugs trouvés en chemin. Les features sont désormais décrites
dans `features.md` (ajout d'un contact à la main, duplication d'un template, bannière de session expirée).
Ne restent ici que les suites.

**Deux bugs corrigés au passage, non signalés par Julien** : l'auto-save d'un scénario se relançait après un
ÉCHEC et bouclait à l'infini sur une session expirée (E2E qui compte les appels) ; et un espace NEUF refusait
le champ Prénom que son propre écran propose (cf. §champs socles).

**Abandonné après discussion** : déplacer les boutons du carousel sous les cartes (Julien a retiré la demande
une fois la contrainte Meta expliquée ; le libellé a été clarifié à la place).

**Reste à faire, petit et mécanique** : les astérisques sur les onze champs de l'éditeur de formulaire. La
liste des manquants sous le bouton couvre déjà tous les cas de blocage, d'où l'arrêt volontaire.

**Reste à VÉRIFIER par Julien** (rien ne bloque, tout est en ligne) : le champ Prénom sur son nouveau compte,
l'ajout d'un contact à la main, la duplication d'un template, le carousel, l'écran formulaire, et la bannière
de session. Plus les deux pilotes en attente de sa main : l'OTP Zadarma (numéro dédié qui décroche) et une
automation « étape de deal » avec un deal déplacé dans HubSpot.

## ✅ LIVE (2026-08-18) : configurer l'agent MBA depuis la console

**Déployé en production le 2026-08-18** (`8043f1d`), après vérification des deux règles de déploiement :
`git log 91f9cde..HEAD` (10 commits, tous ceux de ce chantier, aucun travail d'une autre session embarqué au
passage) et migrations (58 appliquées pour 58 fichiers, aucune en attente).

Vérifié EN PRODUCTION, pas déduit : les 7 ressources répondent **401** sur `/tenants/:t/mba/:pn/*` (donc les
routes sont montées ET la garde admin est active ; un 404 aurait signifié « pas montées »), `/health` répond
`ok:true`, `mba.messagingme.app/mba/parametres` répond 200, aucune erreur dans les journaux des 3 conteneurs.

⚠️ Le `git pull` sur le VPS échouait d'abord : des copies de sondes y traînaient en non-suivi alors que ces
mêmes chemins sont désormais suivis dans le dépôt. Retirées avant le pull. Réflexe pour la prochaine fois : une
sonde déposée à la main sur le VPS devient un obstacle le jour où elle est committée.

**Reste à faire, non bloquant** : le coup d'œil visuel de Julien sur les 4 points marqués « vérif Julien » dans
`.loop/mba-ecrans-parametres.md` (cohérence de style, lisibilité des 8 onglets sur écran étroit, ton des
messages FR et EN, rendu de la transcription du bac à sable).

### Le détail du chantier (historique)


**Reprendre ici : les routes backend `/tenants/:t/mba/*`, puis les écrans.**

### Ce qui a changé aujourd'hui, et qui débloque tout

**MBA est OUVERT sur la France**, mesuré et non déduit : `agent_eligibility` renvoie `is_eligible:true` sur
`+33 5 25 68 03 01` (`phone_number_id=1305301719324792`, WABA `1067000669256166`), après acceptation des ToS
par Julien. Toute la surface `agent_config/*` répond. Le relevé complet et les 20 écarts avec notre
transcription du 2026-07-20 sont dans `docs/MBA-API-REFERENCE.md` (chapitre en tête) et
`messagingme-pilot/docs/META-BUSINESS-AGENT-API.md`.

**L'agent du numéro de test est configuré et il RÉPOND.** Posé par API : business info, une skill de
comportement (interdiction d'inventer horaire/tarif/délai, escalade sur incident), et **80 FAQ dont 77
RÉELLES** tirées de la base du chatbot `keolis-auxerre`. Testé dans le bac à sable (`agent_test`, jetons non
facturés) : il refuse d'inventer un horaire, cite les vrais contacts du réseau, suit le fil d'une
conversation, et « je veux parler à un conseiller » déclenche un `handoff_reason: customer_request`.
**Le mécanisme central du produit fonctionne de bout en bout.**

### Fait et poussé

- `src/mba/client.ts` : client des cinq ressources (business info, FAQ, skills, fichiers, sites web) plus
  réglages, allowlist, éligibilité, `agent_test`. **9 tests** (`tests/mba-client.test.ts`), aucun réseau.
  Trois pièges absorbés dans le client : `api.facebook.com` sans version dans le chemin (pas Graph), la forme
  d'erreur `{title, detail}` propre à MBA (sinon le `detail`, qui porte la marche à suivre, est perdu), et le
  REMPLACEMENT COMPLET de `business_info`/`settings` (`fusionnerBusinessInfo`, `modifierSettings` repassent
  les clés inconnues telles quelles). `agent_id` toujours explicite sur les skills.
- Outillage (`scripts/`) : `sonde-mba-live.mts` (état d'un agent), `mba-config-initiale.mts`,
  `mba-charger-faq-auxerre.mts` (idempotent), `mba-test-agent.mts` (bac à sable, messages via `MBA_MESSAGES`),
  `mba-activer-restreint.mts` (allowlist puis activation), `sonde-waba-billing.mts`, `sonde-capacites-app.mts`,
  `sonde-webhooks.mts`. Plus un lanceur `mba-test.sh` sur le VPS.

### Routes backend : FAITES (2026-08-18)

`src/http/mba.ts`, montées sous `/tenants/:t/mba/:phoneNumberId/*`, groupe **admin-only**. Le contrôle
d'isolation est `phoneNumberBelongsToTenant` : la surface MBA est indexée par NUMÉRO, pas par tenant, donc
sans lui un admin authentifié piloterait l'agent d'un autre client en changeant l'id dans l'URL.

`status` · `settings` (PATCH) · `rollout` (PUT, route SÉPARÉE car l'effet est asymétrique) · `business-info`
(GET/PATCH) · `faq` (CRUD + `preview` + `import`) · `skills` (CRUD) · `websites` · `files` · `allowlist` ·
`test` (bac à sable). **27 tests** (`tests/http-mba.test.ts`) + **16** sur l'extraction (`tests/mba-faq-import.test.ts`).

Trois défauts corrigés au passage, dont deux trouvés en relisant la spec :

- **`PUT settings` renvoyait `agent_id` et `channel` dans le CORPS** alors qu'ils sont dans la réponse du GET
  mais PAS dans le schéma de requête (risque de 400), et sans `agent_id` en QUERY le PUT bascule en
  « create-or-fetch » : on ne sait plus quelle configuration on écrit. Corrigé dans `src/mba/client.ts` ET
  dans `scripts/mba-activer-restreint.mts`, test vérifié dans les deux sens.
- **SSRF par redirection** sur l'import de FAQ depuis une URL : le contrôle d'hôte ne portait que sur l'URL
  saisie. Les redirections sont maintenant suivies à la main et CHAQUE saut est revalidé (3 max).
- Le compte-rendu d'import comptait les créations par identifiant retourné : une entrée créée sans `id`
  aurait été recomptée comme « restant à faire » au passage suivant.

### La suite, dans cet ordre

1. **Écrans**, en remplacement de la maquette GELÉE de `web/app/mba/parametres/page.tsx` (151 lignes, tout est
   désactivé, son propre commentaire dit « le jour de l'éligibilité, on branche chaque section »). Un onglet
   par ressource, plus l'écran d'import de FAQ (aperçu avant écriture).
2. **Excel et PDF vers des FAQ structurées : NON FAIT, décision en attente.** Aucun parseur dans le dépôt et
   les deux candidats sont mauvais (`xlsx` npm est figé en 0.18.5 avec une CVE de pollution de prototype ;
   `exceljs` est énorme). Ce qui marche DÉJÀ sans rien ajouter : Meta accepte nativement `.pdf`, `.docx`,
   `.csv` et `.xlsx` comme **fichiers de connaissance** (route `files`), donc un client qui arrive avec ses
   procédures en PDF est servi aujourd'hui. La conversion d'un PDF en Q/R structurées demanderait en plus une
   segmentation par LLM, avec une perte de fidélité : à ne faire que si le besoin d'ÉDITER chaque Q/R une par
   une le justifie. ⚠️ `.csv` et `.xlsx` en fichier de connaissance sont conditionnés à un réglage de l'asset
   WhatsApp que la doc Meta ne dit ni comment vérifier ni comment activer : prévoir un message d'aide dédié
   quand un CSV part en 400 alors qu'un PDF passe.

### Décisions produit prises avec Julien

- **FAQ : saisie unitaire ET import en masse.** Une par une à la main, plus un chargement par lot depuis
  **CSV, Excel, PDF, ou une URL qui porte les Q/R**. C'est le vrai sujet : un client arrive avec ses Q/R déjà
  écrites ailleurs (Keolis en avait 78), le formulaire unitaire ne suffit pas. Réutiliser `CsvImport` côté
  front. Le chargement doit rester **idempotent** (ne pas dupliquer une question déjà posée), comme
  `mba-charger-faq-auxerre.mts`.
- **Skills = personnalité et procédures, PAS du tool calling.** Trois champs : `title`, `description` (QUAND
  l'appliquer), `skill` (QUOI faire, 20 000 caractères). Le tool calling, ce sont les **Connectors + Tools**,
  qui décrivent un appel HTTP sortant dont l'agent extrait les paramètres depuis la conversation. Une skill
  peut orchestrer des tools. C'est pour ça que l'étape « Tools » de l'écran Meta est grise sans connector.
- **Connectors/Tools : REPORTÉS**, volontairement. Ils ne servent à rien tant que la connaissance de base
  n'est pas pilotable, et l'étude du cas GTFS a montré que le vrai travail est côté API métier du client.

### Le cas GTFS/Auxerre, étudié (à garder pour la reprise des connectors)

⚠️ **Auxerre n'utilise PAS de GTFS** (c'est Grand Dole). Ses horaires viennent de **grilles JSON** générées
hors ligne en parsant les PDF. L'API existe : `GET /api/bus/next?grille=&arret=&heure=&n=`, protégée par un
jeton partagé (`x-api-key` ou `?token=`), ce que MBA sait consommer (`auth_type: API_KEY`).

**Le maillon fragile est le paramètre `grille`** (`3`, `3-samedi`, `dim1`, `navette`) : aujourd'hui c'est le
flow WhatsApp qui choisit la grille selon le jour. Confier ce choix au LLM lui demanderait de connaître les
samedis, dimanches, fériés et vacances scolaires, et une erreur de grille donne un horaire faux avec l'aplomb
d'une réponse juste. **À faire avant tout connector : un endpoint qui prend `arret`, `ligne`, `quand` et
déduit la grille CÔTÉ SERVEUR.** Prévoir aussi un jeton dédié au connector, révocable seul.

### En attente (hors de notre main)

L'agent ne peut pas être allumé (`rollout.enabled=true`) : Meta répond « Cannot enable Meta Business Agent.
A payment method is required », avec le lien exact du Billing Hub. Le numéro de Julien (`+33633921577`) est
déjà dans l'allowlist de l'agent, et `mba-activer-restreint.mts` fait le reste en une commande le moment venu.
**Julien s'en occupe, ne pas relancer sur le sujet.**

## Audit anti-slop du 2026-08-18 : CORRIGÉ et déployé ✅

Demande de Julien : « audit code simple et structure maintenable, sans verbiage et sans slop ». Rapport
complet dans `AUDIT-ANTI-SLOP-2026-08-18.md`, corrections dans les commits `b1f3758` -> `87ba4e0`, déployées
sur `mba.messagingme.app`.

**Méthode** : 7 auditeurs en parallèle (une zone chacun, ~40 000 lignes lues) puis 7 contre-experts séparés
qui rouvrent chaque fichier, refont les grep et réfutent par défaut. **57 findings rapportés, 57 confirmés.**
Le juge n'était pas le producteur, et ça se voit : plusieurs findings ont été regradés ou corrigés dans le
détail par la contre-expertise, aucun n'était inventé.

**Verdict** : la structure profonde est saine (moteurs purs à IO injectée, `tenant_id` partout, transactions
propres, commentaires narratifs jugés « un actif »). La dette avait UNE nature dominante, le copier-coller :
24 findings de duplication sur 57. Le repo connaissait pourtant son antidote (fragments SQL partagés, tests de
parité) ; la dette, c'est là où le réflexe a manqué.

**Les 6 rouges** : `scopeTenant` (le contrôle d'accès tenant) copié 22 fois · un cast non validé sur l'API
publique qui transformait un 400 en 500 · l'INSERT de campagne écrit deux fois (déjà responsable d'un faux
vert sur `workflow_id`) · le matching wa_id copié 10 fois · un composant React déclaré dans le corps d'un
autre, donc une modale qui perdait sa sélection à chaque message reçu (BUG RÉEL) · l'assistant de campagne à
1000 lignes et 41 états.

**50 des 51 jaunes** ont suivi (7 lots) : code mort fauché, documentation décollée de sa fonction recollée,
fragments SQL et helpers front mutualisés. Détail des modules créés : `documentation.md` § Modules partagés.

**Reste UN item, à cadrer avec Julien** : le découpage de `web/lib/api.ts` (1325 lignes, 203 exports) par
domaine derrière un barrel. Mécanique, mais il brasse tous les imports du front. Voir `todo.md`.

**Deux changements VISIBLES à l'écran**, assumés : l'aperçu WhatsApp affiche « Votre entreprise » au lieu du
nom du compte pilote figé en dur (faux chez tout autre client), et l'interrupteur MBA grise pendant sa
sauvegarde comme les trois autres de la page.

**Un flake E2E PRÉEXISTANT supprimé au passage** : mesuré à 3 échecs sur 5 suites complètes avant, 0 sur 5
après. Les tests de l'inbox cliquaient pendant que le fil se rechargeait, et le clic se perdait sur un noeud
détaché. La mesure comptait : sans elle, je me serais attribué un flake qui ne venait pas de moi.

**Gates à la fin** : 1702 tests unitaires, 100 tests d'intégration (base réelle), 79 E2E, build web, types
propres des deux côtés. Déploiement du 2026-08-18 fait dans l'ordre : `git log` du commit déployé (13 commits,
aucun travail tiers embarqué), migrations vérifiées AVANT (« à jour, rien à appliquer »), puis build et
redémarrage. Vérifié après : API saine, worker reparti avec ses 6 files, front public en 200, zéro erreur.

## Migrations : 0058 appliquée, prochaine libre = 0059

Le chantier RCS (canal comme dimension de premier ordre) a ses migrations en base : `channel` sur
`conversations`/`conversation_messages`/`campaigns` (défaut `whatsapp`, tout l'existant intact), unique de
`conversations` passé à `(tenant_id, channel, wa_id)`, `campaigns.phone_number_id` devenu nullable, et les tables
`rcs_agents`/`rcs_capabilities_cache` créées. Vérifié après coup : aucune perte, toutes les lignes en `whatsapp`.

🔴 **Incident à ne pas refaire.** Ces migrations ont été appliquées en RETARD : du code qui les attendait avait
déjà été déployé, et pendant 1 h 30 aucun message entrant n'a été enregistré (le contact se créait, la
conversation non, le job partait en file d'échec `webhook-dlq`). Cause : quatre déploiements sans exécuter les
migrations, alors que `DEPLOY.md` décrit l'étape et annonce même le symptôme. Voir `~/CLAUDE.md` (règle ferme) et
`brain/LEARNINGS.md` 2026-08-17. ⚠️ Un message reste dans `webhook-dlq` (rien ne consomme cette file) : sans
outil de rejeu, la reprise se fait en renvoyant le message.

## OTP automatique de l'Embedded Signup (Zadarma) — précâblage FAIT, pilote à mener (2026-08-16)

But : ne plus demander au client de trouver un numéro. On lui en fournit un (Zadarma), Meta l'appelle et
dicte le code, on transcrit l'enregistrement et on poste le code par API (`verify_code`), donc **hors de la
popup Meta**, qui est un iframe d'un autre domaine et ne se remplit pas automatiquement.

Codé et testé, inerte tant que `ZADARMA_API_KEY/SECRET` sont vides : `src/zadarma/{client,api,otp-extract,
otp-capture}.ts` et `src/meta/phone-register.ts`.

**Gotchas Zadarma mesurés en direct le 2026-08-16 (ne pas les redécouvrir) :**

- 🔴 **Lecture vs écriture.** En GET les paramètres vont dans l'URL ; en **POST/PUT ils vont dans le CORPS**
  (`x-www-form-urlencoded`), URL nue. Un PUT qui laisse ses paramètres dans l'URL arrive SANS paramètres,
  la signature est recalculée sur une chaîne vide, et Zadarma répond **401 « Not authorized »** : on accuse
  alors les clés, qui sont bonnes. Mesuré : à paramètres identiques, GET -> 404, PUT -> 401 ; paramètres
  déplacés dans le corps, PUT -> 404.
- 🔴 **Signature** = base64 du HMAC-SHA1 **hexadécimal** (56 caractères). Signer les octets bruts donne
  28 caractères et un 401 tout aussi muet.
- `receive_sms` arrive en **chaîne** « false ». Les numéros français sont **voix seule** : pas d'OTP par SMS.
- La **reconnaissance vocale est autorisée** sur le compte (vérifié sur un identifiant bidon : 404
  « fichier introuvable », pas un refus de droits).
- 🔴 **Rien ne décroche aujourd'hui** : le PBX n'a aucune extension, donc aucun enregistrement, donc rien à
  transcrire. À régler dans le panneau Zadarma (« Mon PBX » > « Appels entrants et SVI » : un scénario
  déclenché par « appels vers le numéro », qui DÉCROCHE et garde la ligne, avec l'enregistrement d'appel
  activé). C'est le préalable au pilote, et ça ne se fait pas par l'API.

**Déployé le 2026-08-16** (mba `f20962c`), mais sans effet : les modules ne sont importés par aucun fichier
exécuté. Le parcours d'embarquement actuel (popup Meta, numéro cherché à la main, code recopié à la main) est
strictement inchangé.

**Verdict du sondage d'architecture (2026-08-16).** Le ROUTAGE d'un numéro est pilotable par API :
`PUT /v1/direct_numbers/set_sip_id/` accepte une adresse SIP EXTERNE (exemple explicite dans la doc). Donc un
client se provisionne en un appel d'API, zéro clic, ce qui sauve la thèse « on fournit le numéro » à l'échelle.
Le DÉCROCHÉ, lui, n'a aucune commande d'API : la machine qui répond doit être à nous, ou être le répondeur de
Zadarma, dont personne n'a pu confirmer qu'il dépose un enregistrement porteur d'un identifiant d'appel
exploitable.

**Prochain pas, et ce n'est PAS de construire.** Le risque qui tue l'angle n'est ni le routage ni le décroché,
c'est de savoir si **Meta accepte de dicter son code à une machine** ou raccroche en détectant un répondeur.
Aucun retour d'expérience publié nulle part. Ça se teste sans rien bâtir : répondeur Zadarma sur un numéro
DÉDIÉ (jamais un numéro qui sert Odalys, EDHEC ou Gan Prévoyance), un OTP déclenché, et on regarde. Si Meta
dicte, l'infra SIP maison devient inutile ; s'il raccroche, l'angle full-auto meurt et on bascule sur le repli
assisté en ayant économisé la construction.

Contrainte de conception relevée : l'appel de Meta arrive quasi immédiatement après `request_code`, donc le
routage doit être **armé avant**, jamais réglé à la volée.

Reste ensuite : le pilote, la réserve de numéros en base (migration 0056), la route + l'écran qui affiche le
code en direct (qui est aussi le repli assisté si le full-auto meurt), et l'instanciation du client dans
`index.ts`. Question NON technique à trancher tôt : le dossier d'identité exigé pour un numéro français. S'il
en faut un par client final, le geste manuel revient par la porte juridique et c'est le modèle qui est touché,
pas le code.

## Node « Envoi de mail » (SMTP) dans les Scénarios — design validé, plan à venir (2026-08-18)

Demande de Julien : un node « Envoi de mail » dans les Scénarios. Décidé avec lui : **SMTP
uniquement** (pas d'expéditeur partagé Resend, pas de vérif de domaine, Gmail/Google Sign-In
écarté vu le coût de validation du scope restreint), **plusieurs boîtes SMTP par client** (le
node choisit laquelle envoie), setup **dans le menu en haut à droite** (admin-only), modèles
d'email (basique + HTML, variables `{{champ}}`) dans « Contenu », destinataire **libre**
(adresse en dur, nous/contact/tiers, ou variable d'un champ). Node best-effort non bloquant :
un mail raté n'arrête jamais le parcours WhatsApp.

Design complet : `docs/superpowers/specs/2026-08-18-node-email-smtp-design.md`. Réutilise le
coffre `secretbox`, le patron `waba_credentials`, le câblage unique `wiring.ts`, la résolution
de variables des templates. Neuf : tables `email_accounts`/`email_templates` (**migration
0060**), stores + résolveur + client `nodemailer`, routes admin-only, écran de connexion,
section « Modèles d'email », type de node `email`. ⚠️ Contacts sans colonne email : « écrire au
contact » suppose son email dans un `user_field`. Prochaine étape : plan d'implémentation.

## En attente (dépendances externes)

- **MBA (agent auto-réponse)** : bloqué par les ToS (403 « Meta Business AI Terms »), gating
  vertical. Veille à mettre en place (cron `agent_eligibility`). Parqué.

## Reste (non bloquant) — voir `todo.md`

- TLS pooler en vérif complète (pinner la CA Supabase).
- Unicité email globale (décision produit).
- Pagination contacts UI, quality rating alimenté par webhook, tests DLQ/CI intégration.
