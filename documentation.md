# documentation.md : technique

## Architecture (async découplé, 3 étages)

Le traitement synchrone est exclu (timeout Meta au moindre pic). Flux entrant :

1. **Webhook Receiver (bouclier)** : Fastify. Valide la signature `X-Hub-Signature-256`,
   pousse le payload brut en file, répond `200` immédiatement (cible < 50 ms). Zéro logique
   métier. Route `POST /webhooks/meta` (+ handshake `GET /webhooks/meta` avec `hub.challenge`).
2. **File durable** : `pg-boss` sur Postgres (PAS en RAM : une file mémoire perd les jobs au
   crash). Transactionnelle avec nos données. Interface abstraite pour basculer BullMQ+Redis
   si l'échelle Phase 3 le justifie.
3. **Workers** : dépilent à rythme maîtrisé. Réconciliation contacts (E.164/BSUID, merge CTA),
   mises à jour DB, notifications.

File OUTBOUND critique (campagnes) : pacing (plafond Meta), lissage, ralentissement auto sur
dégradation du quality rating, fréquence max par contact. C'est là que vivent les garde-fous.

## Stack

- **Runtime** : Node.js >= 22 (`engines` de `package.json`, images `node:22-alpine` des deux Dockerfile),
  TypeScript (ESM), `tsx` en dev **et en production** (le conteneur lance `npx tsx`, jamais `node dist` :
  ESM `moduleResolution: Bundler` sans extensions). `npm run build` (tsc) n'est pas le chemin de déploiement.
- **API/Receiver** : Fastify 5.
- **Validation** : zod.
- **File** : pg-boss (Loop 1).
- **DB** : Postgres = **Supabase** (projet `messagingme-MBA`, ref `npdqnrirxhqsyyvtvtjz`,
  org distincte de leadgen/EDH → invisible au MCP Supabase, connexion directe uniquement).
  Migrations SQL versionnées dans `db/migrations/`, appliquées via `npm run migrate`
  (`db/migrate.ts`, suivi `schema_migrations`). Connexion directe `db.<ref>` en IPv6-only ;
  fallback pooler IPv4 (session mode) documenté dans `.env`. Un Postgres local (Docker) peut
  servir pour des tests isolés si on veut éviter de taper la prod.
- **Frontend** : **Next.js 15 App Router** (`web/`), Tailwind PUR (pas de shadcn), tokens MM
  (brand/ink/mint/coral/gold/navy). Auth JWT (jose HS256), session côté client. **3 statuts de membre** admin / manager / agent (`ROLES` dans
  `src/http/users.ts`, migration 0065) ; tout ce qui est réservé l’est à `admin`, un manager a aujourd’hui les
  accès d’un agent (cf « Rôle `manager` »).
  Le front proxifie `/api/backend/*` vers `mba-api` (pas de CORS).
- **Auth** : login JWT (jose HS256, scrypt async, rate-limit + hash leurre anti-énumération), isolation
  tenant sur toutes les routes, **RBAC** (`adminOnly = active !== 'inbox'` ; écritures admin-only).
- **Tests** : vitest. 240 fichiers dans `tests/` (3009 cas unitaires, sans base) et 27 fichiers dans
  `tests/integration/` (265 cas, Postgres requis), au 2026-08-29. ⚠️ Les tests d'intégration ne se lancent
  PAS en local : le `DATABASE_URL` du `.env` pointe la base de PRODUCTION. La CI monte un Postgres jetable
  (job `integration`), donc c'est le run GitHub qui fait foi, pas un `npm test` vert en local.
- **Hosting** : VPS OVH + Docker. 3 conteneurs (`mba-api` Fastify :8095, `mba-worker` (7 files pg-boss + une quinzaine de balayeurs, cf « Files et balayeurs »),
  `mba-web` Next :3000) sur le réseau `mcp-robot_default`, NPM `mba.messagingme.app`. Cf `DEPLOY.md`.
- **Email** : deux chemins qui n'ont rien à voir. (1) **Resend** pour les mails du produit (formulaire de
  support, invitation, réinitialisation), destinataire et expéditeur fixés côté serveur. (2) **nodemailer /
  SMTP par workspace** pour le CANAL email du builder (bloc « Envoi de mail », migration 0062, `src/email/`) :
  la boîte est déclarée par le client, son mot de passe est chiffré au repos (AES-256-GCM, `src/crypto/secretbox.ts`).

## Schéma DB

Migrations SQL versionnées `db/migrations/`, suivi `schema_migrations` **par NOM de fichier** (les numéros non
contigus sont donc sans conséquence : 0060 n'existe pas, cf. l'en-tête de 0062), appliquées via `npm run migrate`.

**Dernière migration du repo : 0088** (`agent_tool_sources`, lot L2). **Prochaine libre : 0089.** Le compteur
vivant est tenu dans `CLAUDE.md` et dans `DEPLOY.md`, pas ici : ce paragraphe a annoncé « dernière : 0025 »
pendant que le repo en comptait 63 de plus.

🔴 **Migrations NON auto-appliquées.** Une migration qui AJOUTE une colonne écrite par le code passe AVANT le
déploiement ; une migration qui RETIRE une colonne encore lue par l'ancien code passe APRÈS (cf `DEPLOY.md`).
🔴 **Les migrations vivent DANS L'IMAGE** (`COPY db ./db` du Dockerfile), pas sur le disque du VPS : un
`git pull` suivi de `compose run ... npm run migrate` rejoue les ANCIENNES sans rien signaler. La séquence
commence donc par `sudo docker compose build mba-api`.

Tables :
- `tenants` / `users` (`role` ∈ admin|agent, `name` nullable 0013, `disabled` 0014) / `waba` / `phone_numbers`.
- `contacts` : identité BSUID-native (`phone_e164` OU `bsuid`), opt-in tracé, `fields jsonb` (user fields),
  `tags text[]`. Merge jsonb qui n'écrase jamais une clé absente.
- `campaigns` (0003) : `template_name`/`template_language` (**nullable** depuis 0024, couplage par CHAÎNE,
  pas de FK), `category`, `status` ∈ draft|running|paused|completed|failed, + **`workflow_id`** (0024, FK
  `workflows` on delete set null) = campagne déclencheur de workflow (XOR template),
  + **`webhook_id`** (0084, FK `webhooks` on delete set null) = campagne AU FIL DE L'EAU : elle naît sans
  destinataire, chaque arrivant du webhook en devient un, et elle ne passe jamais `completed` toute seule.
- `campaign_recipients` (0003+) : `status` interne ∈ pending|sending|sent|failed|skipped, `sent_at`, +
  **`delivery_status`** (0007) ∈ null|sent|delivered|read|failed (cycle Meta, écrit MONOTONE par message_id).
- `conversation_messages` (0009) / `conversations` : inbox. `template_category`/`template_name` (0012),
  **`sender_user_id`** (0017, FK users, on delete set null) = auteur d'une bulle sortante (pastille).
- `flows` (0015) : id = id Meta, `status` ∈ DRAFT|PUBLISHED, `fields jsonb` (DÉRIVÉ), + **`elements jsonb`,
  `ref text` (unique), `mapping jsonb`** (0016, modèle riche), + **`cta text`** (0021, libellé du bouton final).
- `workflows` (0022) : `name`, `status` ∈ draft|active, **`graph jsonb`** `{nodes[], edges[]}` (scope tenant).
- `workflow_runs` (0023) : état d'exécution PAR contact : `workflow_id`, `contact_id`, `wa_id`, `current_node`,
  `status` ∈ waiting|inbox|done, `last_message_id` (dédup d'avance). Index partiel sur les runs `waiting`.
- `webhooks` (0074) : webhooks ENTRANTS (menu Tools). `code` (26 car. base32, unique GLOBAL, c'est la clé
  d'accès publique), `secret_hash` nullable, `mapping jsonb` (`[{chemin, cible}]`), `create_contact`,
  **`automation_id`** (FK `automations` on delete set null) = la ligne compagnon qui porte le scénario,
  `last_payload`/`last_received_at` (le DERNIER appel seulement), `contacts_created`.
- `webhook_events` : log brut, `meta_message_id` unique (idempotence). pg-boss = schéma `pgboss` séparé.

## Flows (modèle riche, migration 0016)

`src/meta/flow-json.ts` : un flow = des **écrans** (`FlowScreenDef {title?, cta?, elements}`, Lot 7) dont les
éléments sont ordonnés (`heading|subheading|body|caption|image|field`). `buildFlowScreens(name, screens,
version, ref, cta)` rend le flow_json : ids d'écrans `FORM`/`FORM_B`/… (**lettres+underscores UNIQUEMENT**,
sondé live : un chiffre est rejeté ; l'écran 1 reste `FORM`, baké en `navigate_screen` des templates approuvés
ET dans `sendFlowMessage`), PAS de `routing_model` (facultatif sans endpoint, sondé 7.2/7.3), Footers
intermédiaires `navigate` (payload `{}`), Footer terminal `complete` dont le payload **agrège TOUS les champs**
: refs globales `${screen.<ID>.form.<clé>}` (écrans précédents) + `${form.<clé>}` (dernier) + la **constante
`_ref`** (discriminant du retour `nfm_reply`). ⚠️ Refs globales : payloads d'action SEULEMENT, PAS dans les
textes affichés (non résolues, sondé). Clés de champ GLOBALEMENT uniques (`deriveScreens`, collision inter-
écrans -> 400). Un Flow mono-écran est un multi-écran à un seul élément : pas de chemin de code séparé.
**Conditions** : `visibleIf` (input `{field: LIBELLÉ source, op eq|neq, value}` -> stocké `{fieldKey}`) ->
propriété `visible` backticks ; sources dropdown/radio/optin du MÊME écran situées AVANT ; valeur ∈ options
(sans apostrophe/backtick, refusées) ou booléen. Sondé live : champ masqué/vide **OMIS** du payload complete
(-> `hasOwnProperty` du mapping suffit, aucun écrasement) ; un `required` caché ne bloque NI navigate NI
complete. Stockage : colonne jsonb `flows.elements` **POLYMORPHE sans migration**, normalisée par `screensOf`
à la lecture (null legacy / tableau plat historique = 1 écran / `{screens}` nouveau). `fields` reste DÉRIVÉ
(`fieldsOfScreens`). Image = **base64 BRUT** embarqué. `bodyLimit` 7 Mo. Édition d'un DRAFT = `POST
/{flow_id}/assets` en **multipart** (create en JSON inline : vérifié live) ; PUBLISHED immuable (409) ->
duplication (ref régénéré). **Sonde committée** : `scripts/sonde-flow-live.mts` (fixture via le code produit
POSTée en draft sur le WABA réel, exige `validation_errors == []`, delete) : à rejouer à chaque évolution
du générateur.

**Mapping webhook (défensif)** : à la réception d'un `nfm_reply`, `webhooks/flow-mapping.processFlowCompletions`
retrouve le flow par `_ref` (`findByRef`), itère sur NOTRE mapping (clé champ -> clé user field, jamais les
valeurs brutes -> `_ref`/`flow_token` jamais écrits) et fait un MERGE jsonb sur le contact
(`mergeFieldsByPhone`, même matching que l'inbox). **Isolé en try/catch, ne throw JAMAIS** : partage le job
webhook des statuts de livraison, un mapping cassé ne doit pas rejouer/DLQ les statuts.

## Builder de formulaires (A) + Workflow builder (B) : lot 3

**Dépendance front** : **`@xyflow/react`** (React Flow, ^12, MIT) pour l'éditeur de graphe de blocs.
Seule lib ajoutée du lot ; tout le reste reste Tailwind pur. (État au 2026-08-29 : le front n’a que DEUX
  dépendances de production hors React/Next, `@xyflow/react` et `qrcode`. Toujours aucune lib de charts,
  aucun shadcn.)

**(A) Formulaires WhatsApp** (`web/components/FlowBuilder.tsx`) : builder visuel de TOUS les composants d'un
écran Flow : textes (heading/subheading/body/caption), image, saisies (`text|email|phone|number|passcode`,
textarea, date), **choix à options** (`Dropdown`/`RadioButtonsGroup`/`CheckboxGroup`, data-source `id=title`),
**OptIn** (consentement -> **champ booléen dédié**), **Footer = bouton final au libellé personnalisable** (`cta`).
Aperçu en direct (`FlowScreenPreview`). ⚠️ RGPD : un champ basculé en `optin` **réinitialise son `saveTo`**
(front `changeType`/submit + back `parseFlowBody`) pour qu'un booléen de consentement ne puisse jamais écraser
un autre user field.

**(B) Workflow builder** (`src/workflow/`, menu gauche « Flow ») :
- **Modèle** `graph.ts` : `parseGraph` PUR (sanitise, intégrité référentielle arête->node, caps 200 nodes /
  400 edges). **15 types de bloc** (`WORKFLOW_NODE_TYPES`, source unique) : `template`, `quick_message`,
  `inbox`, `flow`, `question`, `tag`, `field`, `condition`, `action`, `wait`, `mba_handoff`, `mba_disable`,
  `rcs_message`, `email`, `agent`. Cette liste est la SEULE : un type ajouté sans y passer n'existe pas pour
  le moteur.
- **Moteur** `engine.ts` : `walk(graph, startNodeId)` LINÉAIRE : blocs `tag`/`field` = action synchrone puis on
  continue ; `template`/`flow` = envoi puis **attente** ; `inbox` = terminal (conversation remontée à l'humain) ;
  anti-cycle. `executor.ts` : `start` applique les actions + persiste le run ; `advance` quand le contact répond,
  **dédup par `last_message_id`**.
- **Avance** branchée sur le webhook inbound (`webhooks/workflow-advance.processWorkflowAdvance`), **ISOLÉ en
  try/catch par message** (comme le flow-mapping : ne throw jamais, partage le job webhook des statuts).
  ⚠️ V1 : avance sur **n'importe quelle** réponse inbound (pas de branche par bouton quick-reply -> réservé).
- **Déclencheur = campagne** (`campaign/engine.ts`) : si `campaign.workflow_id`, le run de campagne appelle
  `startWorkflow` (executor.start) par destinataire **au lieu d'un envoi template**, en réutilisant l'infra
  campagne (claim atomique anti double-envoi, quality gate, fréquence marketing) : **pas de nouvelle file ni
  rate gate**. message_id synthétique `wf-<id>` (la livraison/lecture Meta n'est donc PAS suivie pour ces
  campagnes -> funnel delivered/read=0, limitation V1 assumée). Route create = **Template XOR Workflow**
  (`workflowBelongsToTenant` valide l'appartenance). `getTemplateBreakdown` exclut les campagnes workflow
  (`template_name is not null`).

## Identité contact (numéro OU BSUID)

`src/crm/identity.ts` expose `waIdOf(phone, bsuid)` (clé de routage WhatsApp) et `classifyWaId(waId)` :
7-15 chiffres -> `{phoneE164:'+'+waId}`, sinon `{bsuid}` (heuristique, aucun trafic BSUID en prod aujourd'hui
-> à confirmer au 1er BSUID réel).

⚠️ **La règle d'AFFICHAGE « numéro sinon BSUID » n'est PAS factorisée.** Corrigé le 2026-07-18 : ce paragraphe
annonçait `src/crm/identity.ts` comme « source unique de la règle » alors que le `contactIdentity` serveur
n'avait aucun appelant (supprimé depuis). La règle est réécrite à la main à trois endroits :
`web/lib/api.ts` (`contactIdentity`, le seul vivant, utilisé par les pages Contacts et Campagne),
`src/api/sends-build.ts` et `src/campaign/build.ts`. Les factoriser est un chantier ouvert, pas un acquis.
- `contacts` porte `phone_e164` + `bsuid` (0001, contrainte « au moins un », 2 index uniques partiels).
  `ContactRow.bsuid` exposé partout (tous les selects). Front : colonne « Identifiant », fiche « Compte
  WhatsApp », sélection/label campagne via le `contactIdentity` DU FRONT (`web/lib/api.ts`).
- **Auto-création depuis l'inbound** : `PgContactStore.upsertFromInbound` (upsert par l'index unique phone OU
  bsuid, opt-in 'unknown' à la CRÉATION seulement, `opt_in_source='inbound'`, coalesce du profile_name).
  Câblée dans `processInbound(payload, store, upsertContact?)` AVANT `recordInbound`, **isolée** (un échec ne
  casse pas l'inbox). 7e param `inboundContactUpsert?` de `handleWebhookJob`, branché dans `worker.ts`.
- **Matching étendu au BSUID** : `mergeFieldsByPhone`/`addTagsByPhone` + le lien conversation->contact
  (`recordInbound`) matchent `or bsuid = $2` (flow-mapping, blocs tag/champ de workflow atteignent un BSUID).
- **Envoi identity-aware** : `messagingTarget(identity)` (`src/meta/types.ts`) = numéro (`+…` ou chiffres nus
  <= 15) -> `{to}`, sinon -> `{recipient}`. Utilisé par `MetaClient.sendTemplate` (route inbox + workflow +
  campagne utility) et l'engine marketing (`sendMarketing({...messagingTarget, template})`). `buildRecipients`
  cible `phone_e164 ?? bsuid`, dédup par identité. Branche workflow de l'engine : `waId` = chiffres nus pour un
  numéro, BSUID intact (jamais dénaturé par un strip de non-chiffres).

## Formulaires : suppression (Meta)

`MetaFlowClient.delete` (DRAFT -> `DELETE /{flow}`) / `deprecate` (PUBLISHED immuable -> `POST /{flow}/deprecate`).
Route `DELETE /flows/:id` : getFlow (404) -> Meta (deprecate si PUBLISHED sinon delete) -> `PgFlowStore.remove`.
**Meta AVANT store** : un refus Meta (flow rattaché à un template) remonte en 422 et conserve la ligne locale
(pas d'orphelin). Front : retrait optimiste + rollback sur erreur.

## Lot 5 : sélecteur de variable (hints) + branche par bouton

**Variable picker + propagation (hints)** : à la création de template, le front (`web/app/templates/page.tsx`)
insère `{{n}}` via un sélecteur de champ et pose des `paramHints` (`{position, source}`, source = `ParamSource`).
Persistés dans **`template_param_hints`** (migration 0025, PK tenant+name+language+position) via
`PgTemplateHintStore` (`save` = REMPLACE transactionnel). `src/http/templates.ts` : `parseParamHints` (sparse,
pas de 1..N contigu), 400 si malformé AVANT Meta, `saveHintsSafe` best-effort ; ⚠️ **clé `paramHints` ABSENTE =
on NE touche PAS aux indices** (un PATCH hors-variables ne les efface pas ; seul un tableau explicite remplace).
Route `GET /templates/:name/param-hints?language=`. La campagne (`chooseTemplate`) lit les hints pour
pré-remplir son mapping (anti-course `chooseSeq`). `WhatsAppPreview` : `renderBody` rend un chip `[Label]` si
`varLabels` fourni, sinon substitution par exemple. Exemples déterministes = **front** (`deterministicExample`,
par clé connue puis par type), jamais vide (garde serveur).

**Branche par bouton (workflow)** : le node `template` dénormalise ses boutons (`node.data.templateButtons`, via
`TemplateSummary.buttons`). L'éditeur (`WorkflowBuilder.tsx`) expose un handle source `id="btn:<index>"` par
bouton quick-reply (URL/flow grisés non-reliables) ; sans quick-reply -> une seule sortie bas (repli).
`onConnect` dédup par (source, sourceHandle). Moteur : `engine.nextNodeByHandle(graph, node, handle)` ;
`executor.advance(tenant, waId, msgId, buttonPayload)` = `(buttonPayload ? nextNodeByHandle : null) ?? nextNode`
(repli 1re arête sur texte / bouton non câblé) ; `workflow-advance` relaie `m.buttonPayload`. **Envoi
déterministe** : `worker.ts` pose un payload CONTRÔLÉ sur chaque quick-reply (`components` :
`{type:'button', sub_type:'quick_reply', index:String(i), parameters:[{type:'payload', payload:'btn:'+i}]}`) ->
le webhook renvoie `btn:<index>`, la branche est sûre (pas de pari sur le défaut Meta). Aucune migration
(sourceHandle déjà dans le modèle/jsonb). ⚠️ V2 (todo) : snapshot des boutons figé + arêtes orphelines à la
re-sélection de template.

## Campagne : une-page 2 étapes, sources, débit, planification (Lot 8, 2026-07-17, mig 0032-0034)

Écran `web/app/campaigns/page.tsx` (`AppShell fullBleed`, conteneur scrollable interne). CreateForm en 2 étapes ;
le lancement est RAPATRIÉ (createCampaign -> runCampaign + polling inline, gardes `mountedRef`/`onBusyChange`).

- **Filtres CRM requêtables** (`src/crm/contact-store.pg.ts`) : `buildWhere` construit un WHERE 100 % PARAMÉTRÉ
  (y compris la CLÉ jsonb `fields ->> $key`, liée ; `tenant_id=$1` TOUJOURS). `ContactFilters` : tags AND(@>)/OR(&&),
  optIn, phonePrefix (ancré), phoneContains (chiffres nus), nameSearch (ilike), fieldFilters eq/contains.
  `query`/`count`/`idsForFilters`. Route GET /contacts étendue (+ /count, /ids) dans `src/http/import.ts`
  (`parseFilters` défensif ; `hasFilters` route query vs listContacts). Index mig **0032** (pg_trgm nom + GIN jsonb).
  Front : source-picker + panneau de filtres + compteur live (debounce 350ms, anti-course).
- **Import comme source** : composant partagé `web/components/CsvImport.tsx` (extrait de contacts/page, `requireTag`
  pour la campagne) ; après import, pivot sur la source CRM filtrée par le(s) tag(s).
- **Débit par campagne** (mig **0033** `campaigns.rate_per_minute` CHECK 1..80, null=pas de throttle) : `run-job`
  construit un `RateLimiter(ceil(60000/rate))` PAR RUN (factory `makeRateLimiter` injectable). ⚠️ **Timeout de job
  DIMENSIONNÉ** (`src/campaign/pacing.ts` `campaignJobExpireSeconds(n, rate)`) passé PAR JOB à l'enqueue (`/run`
  via `getRunSizing`) : un timeout FIXE ne couvre pas un run throttlé long -> pg-boss le rejoue en parallèle
  (débit x2). `Queue.enqueue` accepte `expireInSeconds`. Cf `brain/LEARNINGS.md` 2026-07-17.
  ⚠️ **Plafonné à 23 h** depuis le 2026-08-25 : pg-boss REFUSE toute expiration atteignant 24 h (assert strict),
  donc au-delà d'environ 954 destinataires à 1/min ou 4767 à 5/min l'enfilement levait et la campagne ne partait
  JAMAIS (500 opaque en immédiat, blocage silencieux et perpétuel en programmé). Contrepartie : au-delà d'environ
  1380 x débit destinataires, le run expire en cours d'envoi et est rejoué en parallèle ; le claim atomique par
  destinataire empêche le double envoi, mais le débit double pendant le chevauchement.
- **Planification** (mig **0034** `scheduled_at` + statut `scheduled` + index partiel ; Path B) : route `/run`
  accepte `scheduledAt` FUTUR (409 non programmable, 400 passé) -> statut `scheduled` ; `/cancel-schedule`.
  Sweeper `src/campaign/schedule-sweep.ts` (worker, 60s) : `listDueScheduled` -> enqueue (expire dimensionné) PUIS
  `markScheduledRunning` (pas de 'running' orphelin ; idempotent singletonKey + garde). `CampaignStatus += scheduled`
  propagé (STATUS front, garde D1 template, counts sans filtre). `scheduled_at` en timestamptz UTC ; front convertit
  `datetime-local -> ISO UTC` au clic.

## Conversations (analyse) : lecture des agrégats Pièce 1 (Lot 9, 2026-07-17, 0 migration, 0 LLM)

Surface l'analyse de conversation (moteur Pièce 1 `src/analysis/*`, table `conversation_analysis` mig 0027,
ACTIF en prod `CONVERSATION_ANALYSIS_ENABLED=true`) qui n'avait AUCUN lecteur. Le Lot 9 est une couche de
LECTURE pure, séparée du moteur d'écriture.
- `src/stats/conversation-stats.pg.ts` `PgConversationStatsStore(pool, enabled)` : `getSummary(tenantId, range)`
  = UNE passe `count(*) FILTER` sur tous les enums (sentiment/intent/handled_by/action) + `avg`/`percentile_cont`
  exchanges + buckets confidence ; `group by lower(btrim(topic))` séparé (top 10). `listAnalyzed(tenantId, range,
  {sentiment?,intent?,action?,limit?})` = join `conversations` (wa_id) + left join `contacts` (profile_name,
  contact_id nullable), `inboxHref='/inbox?c=<id>'`. **`tenant_id=$1` sur CHAQUE requête** (double barrière avec
  scopeTenant). Bornes CTE Europe/Paris identiques à PgStatsStore.
- Routes `src/http/stats.ts` (admin-only) : `GET /stats/conversations` (summary + `enabled`) et
  `/stats/conversations/list` (filtres validés contre un SET d'enum -> valeur hors enum IGNORÉE, pas d'injection ;
  limit borné). `api.ts` : `getConversationAnalysisSummary` / `listAnalyzedConversations`.
- Front : `web/components/ConversationAnalysisCard.tsx` (self-fetch isolé, donut SVG maison **pas de lib de
  charts**, barres, empty-state différencié `enabled` vs `total=0`). Deep-link inbox : `web/app/inbox/page.tsx`
  lit `?c=<conversationId>` (useSearchParams sous Suspense, pré-sélection une fois via ref).
- ⚠️ **Sémantique** : `conversation_analysis.created_at` est réécrit à `now()` à chaque ré-analyse (upsert) ->
  date de DERNIÈRE analyse, pas de la conversation ; agrégat = instantané « à date de dernière analyse », pas un
  registre (cf `brain/LEARNINGS.md`). Champs LLM = INDICATIFS ; `handled_by`/`exchanges` déterministes ; bucket
  `mba` inatteignable (MBA fermé). **1 seul enrichissement en base au 2026-07-17** (peu de trafic) -> empty-state
  vu jusqu'à montée en charge.

## Analytics (stats, plage de dates)

`src/stats/range.ts` : `DateRange {from,to}` (YYYY-MM-DD, Europe/Paris), `parseRange` (repli `?days=`,
400 si from>to / to futur / span>366), `rangeToUnix` (epoch minuit Paris de from..to+1, **DST-aware**, pas
de `date*86400`). `PgStatsStore` : bornes SQL EXCLUSIVES (`(to+1)@TZ`), `IS DISTINCT FROM 'failed'`
obligatoire (delivery_status null souvent). Routes (admin-only) : `/stats`, `/stats/templates`,
`/stats/campaign-funnel?campaignId` (sent/delivered/read/**replied**/failed ; « replied » = inbound après
sent_at attribué au dernier envoi, join `to_e164`↔`wa_id`), `/stats/errors?templateName` (group by
`(error_code, template_name)`, filtre template optionnel côté serveur ; l'UI agrège côté client avec un
dropdown « Tous les templates », ancré `coalesce(delivery_updated_at,sent_at,claimed_at)` ; portée =
campagnes, aucune colonne d'erreur sur `conversation_messages`), `/stats/cost?campaignId&templateName` (coût/jour
estimé). `error_code` (0020) alimenté par `extractDelivery` (webhook) + `markResult` (échec d'envoi,
`MetaApiError.code`). **Coût = backend** : `getCostVolume` (volume/jour/catégorie, filtrable) × tarif Meta
(`getPricing`), combinés par `estimateCostSeries` (pur, `src/stats/cost.ts`, jamais de coût sans tarif).

## Accueil + statut compte

`src/account/service.ts` (`computeAccountStatus` PUR, « jamais de faux vert »), `src/account/pull.ts`
(`pullFromInfo`/`pullFromError`, pur), `src/meta/phone-number.ts` (`GET /{phone_number_id}`),
`src/account/store.pg.ts` (persiste status/quality/tier, migration 0019). Routes `GET /tenants/:t/account-status`
(admin, ne throw jamais) + `GET /tenants/:t/me` (tout authentifié, « Bonjour {prénom} »). Front `/accueil`.

## Exploitation cross-tenant `/ops` (interne)

Autorité SÉPARÉE du JWT tenant : secret d'env `OPS_TOKEN` comparé constant-time (`makeRequireOps`,
`timingSafeEqualStr`). Vide -> 401 (désactivé). Fail-fast prod si défini et < 32 octets. `PgOpsStore`
(`src/ops/store.pg.ts`, LECTURE SEULE) : `getTenantOverview` (rollup par tenant), `getGlobalDaily`,
`getQueueLoad` (SQL brut `${PGBOSS_SCHEMA}.job` group by state, `safeSchema` valide l'identifiant, tolère
42P01). Route unique `GET /ops/overview` (`src/http/ops.ts`). Front `web/app/ops/page.tsx` (hors AppShell,
token en localStorage `mba.ops`, fetch dédié qui ne touche pas la session console). 🔴 **Ce n’est PLUS une surface en lecture seule.** `src/http/ops.ts` porte quatre routes, dont deux POST :
`POST /ops/observe` (ouvrir un espace client en observation) et surtout `POST /ops/credits/:tenantId`, qui
recharge le solde prépayé d’un workspace. C’est la seule écriture d’argent du produit, et elle est ici
précisément pour qu’un client ne puisse pas créditer son propre compte.

## Support (Resend)

`src/support/resend.ts` (`ResendClient.send` -> POST `/emails`) + `src/http/support.ts` (POST
`/tenants/:id/support`, auth requise, 503 si non configuré, 502 sur erreur d'envoi, destinataire FIXE
serveur). Env : `RESEND_API_KEY`, `SUPPORT_FROM` (défaut `onboarding@resend.dev` = mode test), `SUPPORT_TO`.

## Décisions actées (lot MBA, D1-D10)

D1 édition template = autoriser + **bloquer si campagne active** (409). D2 clé user field **verrouillée**.
D3 tags **dérivés** des contacts. D4 mapping flow -> user field (défaut = slug du champ + ensureField, ou cible
choisie ; merge-si-contact-existe). D5 Analytics = `/dashboard` relabellé ; read receipts **campagnes-only**.
D6 coût = réutiliser `/stats/templates` (zéro backend). D7 largeur cap `max-w-7xl`. D8 support = form phase 1,
Resend phase 7. D9 Abonnement/Billing désactivés. ⚠️ Depuis 0087, il existe malgré tout un **solde prépayé par workspace**
pour l’agent IA (consommation en micro-euros, recharge par `POST /ops/credits/:tenantId`, affichage client) :
ce n’est pas un abonnement, mais ce n’est plus « le produit ne connaît pas d’argent ». D10 flow publié = **dupliquer pour modifier**.

## Variables d'environnement

Voir `.env.example` / `.env.prod.example`. Clés : `PORT`, `META_APP_SECRET` (signature webhook),
`META_VERIFY_TOKEN` (handshake), `META_ACCESS_TOKEN` (System User, envoi), `META_GRAPH_VERSION`,
`META_FLOW_JSON_VERSION`, `META_APP_ID` (=`988129420727963`, sert au FB.init + à l'échange de code ES),
`AUTH_SECRET` (fail-fast en prod, >= 32 octets), `DATABASE_URL`, `DRY_RUN`, `RESEND_API_KEY` / `SUPPORT_FROM` /
`SUPPORT_TO` (support), **`META_ES_CONFIG_ID`** (Embedded Signup ; vide → feature OFF, route 503), **`ENCRYPTION_KEY`**
(64 hex ; chiffre les tokens business ES ; fail-fast prod si `META_ES_CONFIG_ID` posé),
**`WEBHOOK_IN_RATE_LIMIT_MAX`** / **`WEBHOOK_IN_RATE_LIMIT_WINDOW_MS`** (débit d'UN webhook entrant, défaut
120 par minute) et **`WEBHOOK_PAYLOAD_RETENTION_DAYS`** (défaut 7, purge du dernier payload).
Côté agent IA : **`AI_GATEWAY_API_KEY`** (vide -> la file `agent-turn` n'est pas consommée, l'assistant de
construction et le bac à sable répondent 503), **`AGENT_SETUP_MODEL`**, **`AGENT_MODEL`**,
**`AGENT_VISION_MODEL`** et **`EUR_PER_USD`**.
🔴 **`AGENT_VISION_MODEL` est SÉPARÉ de `AGENT_SETUP_MODEL`, et ce n'est pas de la précaution : c'est mesuré.**
Sonde de la Gateway avec la clé de production le 2026-08-31 : `zai/glm-4.7`, le modèle d'entretien, REFUSE une
part `image_url` avec un **400 au corps vide**. Les réutiliser aurait livré une pièce jointe image morte, avec
une erreur que personne n'aurait su relier à sa cause. `google/gemini-2.5-flash` la lit (vérifié : il a décrit
le pixel de test), c'est la valeur posée en production. Vide → les images sont refusées explicitement, sans
aucun appel ; les documents texte, PDF et Word passent quand même, ils n'ont besoin d'aucun modèle.
⚠️ Poser la clé SANS les deux modèles est refusé au boot : le code retomberait sur `LLM_MODEL`, qui est
l'identifiant de l'ANALYSE de conversation servie EN DIRECT par Anthropic, là où le Gateway attend un
identifiant préfixé par son fournisseur. Rien ne le signalerait à la création d'un agent, et chaque tour
échouerait en pleine conversation. ⚠️ Cette dernière
est un **paramètre commercial** et non un cours : le Gateway facture en dollars, tous nos compteurs sont en
micro-euros, et la changer change ce qu'on facture au client. ⚠️ Un changement de `.env.prod`
exige `docker compose up -d --force-recreate` (env_file rechargé seulement à la recréation).

## Publicités Click-to-WhatsApp (CTWA) : identifier d'où vient un lead

Quand quelqu'un clique une publicité « Click to WhatsApp », Meta joint un objet **`referral`** au message
entrant, dans `messages[]` :

```json
"referral": {
  "source_url": "https://fb.me/XXXX",
  "source_id": "120212345678901234",
  "source_type": "ad",
  "headline": "Offre de rentrée",
  "body": "Parlez-nous sur WhatsApp",
  "media_type": "image",
  "image_url": "...",
  "ctwa_clid": ""
}
```

`source_id` est l'identifiant de la PUB : c'est la clé de routage.

**🔴 Trois pièges, tous vérifiés avant de coder :**

1. **Le referral n'arrive que sur le PREMIER message** après le clic. Les suivants ne le portent plus. Ne pas
   le capter à l'arrivée, c'est perdre l'origine du lead définitivement. D'où l'écriture immédiate sur la
   fiche contact, dans le même passage que l'auto-création (`src/worker.ts`).
2. **`ctwa_clid` peut arriver VIDE.** Vu dans un corps réellement capté. N'en jamais faire une condition.
3. **Une bascule d'attribution doit être active côté WhatsApp Business**, sinon Meta n'envoie pas le referral
   du tout. Information de source tierce, à vérifier dans les réglages du WABA le jour du premier test réel.

**Où ça atterrit.** Deux champs de contact aux clés stables (`src/crm/fields.ts`) : `pub_id` (« Pub
(identifiant) ») et `pub_titre` (« Pub (titre) »), créés à la volée au premier lead publicitaire. Des CHAMPS
plutôt qu'une colonne dédiée, et ce n'est pas un raccourci : l'origine devient filtrable dans le mini-CRM,
utilisable comme variable dans un message, et segmentable en campagne, sans migration ni écran de plus.

**Le déclencheur d'automation** `ctwa_ad` route ces leads vers un scénario. Sa config vide veut dire
« n'importe quelle pub », à l'INVERSE de « tag ajouté » et « étape de deal » où une config vide n'attrape
rien : ici le montage courant est « tout lead publicitaire part dans le scénario d'accueil », et la portée
reste bornée aux messages venus d'une pub. Un message ordinaire ne déclenche jamais.

**La fenêtre 24 h est ouverte** sur ce premier message (le contact vient d'écrire à Meta), donc le scénario
déclenché peut ouvrir par un message rapide, sans template à faire approuver.

**Ce qui n'est pas fait** : renvoyer les conversions à Meta via `ctwa_clid` (Automatic Events / Conversions
API) pour que l'algorithme optimise la diffusion. Le `ctwa_clid` n'est pas recopié sur la fiche, mais il n'est
pas perdu pour autant : le corps brut de chaque webhook est conservé intégralement dans `webhook_events.payload`
(aucune purge), donc ce chantier pourra repartir de là.

**⚠️ Rien de tout cela n'a encore été vu en vol.** Au 2026-08-26, sur 275 corps de webhook conservés depuis
juillet, AUCUN ne contient `referral` ni `ctwa_clid` : personne n'a encore pointé de pub sur ce numéro. Le
code suit la doc et un corps réel capté par un tiers, il n'est pas prouvé par notre propre trafic.

## Patterns

- **Idempotence** : dédup par `meta_message_id` avant traitement (les webhooks arrivent en
  double).
- **ACK d'abord** : le receiver ne fait jamais de travail lourd en synchrone.
- **BSUID-native** : toute identité = E.164 OU BSUID ; ne jamais supposer un numéro présent
  (usernames : `from`/`wa_id` peuvent être omis, cf. cadrage §5bis).
- **Mocks des contrats Meta** : les wrappers API se testent contre des réponses mockées
  tirées de la spec (`META-BUSINESS-AGENT-API.md`), pas contre le live.

## Auth (lot 6)

- **Jetons** : `auth_tokens` (mig 0026), `purpose` invite|reset, `token_hash` sha256, consommation ATOMIQUE
  (`used_at is null` dans le UPDATE RETURNING), TTL (invite 7 j / reset 1 h). `PgAuthTokenStore.create/consume`.
- **Inscription libre** : `createTenantWithAdmin(name, {email, name, passwordHash})` TRANSACTIONNEL (jamais de
  tenant orphelin). `passwordHash` **null** = compte Google-only (login mot de passe impossible, Google OK).
- **Google** : `src/auth/google.ts verifyGoogleIdToken` via **jose** `createRemoteJWKSet` (JWKS
  `https://www.googleapis.com/oauth2/v3/certs`, issuer `accounts.google.com`, audience `GOOGLE_CLIENT_ID`,
  `email_verified` exigé, jamais de throw -> null). Injecté en dep dans `registerAuth` (testable avec un fake).
  Liaison par email : `PgUserStore.getByEmail` renvoie un compte TOUT statut (y compris pending) pour connecter un
  invité via Google. Front : bouton GIS (`web/components/GoogleButton.tsx`), `GET /auth/config` expose le client_id.
- **Anti-énumération** : forgot-password toujours 200 + `DUMMY_HASH` (timing constant) + envoi fire-and-forget.
  `hashPassword` **async** (scrypt threadpool) sur les routes publiques (sync bloquerait l'event-loop du webhook).
- **Crochet paiement** : `tenants.status` (`trial|active|locked`) ; `makeRequireAuth` bloque `locked` (403, inerte).

## Résolution des variables de template (lot 5-7)

- **Design** : `template_param_hints` (mig 0025) mappe `{{position}} -> champ` (sparse). `PgTemplateHintStore`.
- **Campagne template directe** : l'UI construit un `paramMapping` CONTIGU 1..N, `resolveTemplateParams` (exige
  1..N, throw sinon) résout par destinataire -> `resolvedParams` persistés -> `buildTemplateComponents` à l'envoi.
  ⚠️ **`meta/template-components.ts` est le SEUL constructeur de composants d'envoi** (2026-08-11). Il en existait
  un second dans `campaign/guardrails.ts` (`buildComponents`, supprimé) : ce doublon est la raison pour laquelle
  le carousel n'avait aucun « bon endroit » unique où se brancher, et n'est jamais parti côté campagne.
  L'envoi CAROUSEL vit ici : `MetaTemplateClient.list` relit les cartes (`carouselOf`, l'URL vient de
  `example.header_handle[0]` et n'est retenue que si c'en est une, un handle `4::` étant écarté),
  `carouselSendBlocker` refuse ce qui n'est pas envoyable (0 carte, carte sans image, variable de carte), et
  `getTemplateCarousel` (dep optionnelle d'`EngineDeps`) est appelée **une fois par run**, jamais par destinataire.
  ⚠️ Les URL de carte portent une expiration (`oe=`) : cache 5 min côté worker, mais le moteur de campagne prend
  un instantané pour tout le run (à surveiller sur une campagne longue à faible débit).
- **Campagne via WORKFLOW** (lot 7) : chemin distinct. La closure `sendTemplate` de `worker.ts` obtient N (corps
  live via `MetaTemplateClient.list`, caché 5 min par WABA|nom|langue), lit les hints, résout le contact
  (`getResolvableByPhone`, matching phone exact/chiffres nus/bsuid), et appelle `resolveHintParams(hints, N,
  contact, examples)` (SPARSE, garantit N valeurs, repli exemple) -> `buildWorkflowTemplateComponents` (fonction
  PURE, `src/workflow/template-send.ts`, testée directement : pas un fake d'executor). Corrige Meta #132000.
- **Éditeur du corps** : `web/components/VariableBodyEditor.tsx` (contentEditable, chips `[Label]` <-> `{{n}}`).
  Numérotation MAX+1 à l'insertion ; canonicalisation 1..N au submit (`page.tsx`).
- **Sources de variable (2026-07-16)** : `ParamSource` attribut = `name|phone|bsuid|wa_id` ; `valueOf` (switch
  exhaustif) résout via le contact ; `bsuid` ajouté à `ResolvableContact` + `getResolvableByPhone`. **Champs
  système** = constante code (`src/crm/fields.ts SYSTEM_FIELD_KEYS` + `web/lib/fields.ts SYSTEM_FIELDS`), SANS
  migration ; le sélecteur front (`selForSource`) coerce un champ perso inconnu → `sys:name` (garde anti-fantôme).
- **Bouton FLOW à l'envoi** : `buildWorkflowTemplateComponents` génère, par bouton FLOW du template, un composant
  `{type:'button', sub_type:'flow', index, parameters:[{type:'action', action:{flow_token}}]}` (`flow_token` non
  vide, `${waId}-${Date.now()}`). Corrige Meta #131009. Corrélation de la réponse par `_ref` baké (flow_json).

## Embedded Signup (Tech Provider, 2026-07-16)

Onboarding self-service du numéro WhatsApp d'un client. **OFF par défaut** (`META_ES_CONFIG_ID` vide → route 503,
bouton placeholder). Flux :
- **Front** (`web/app/accueil/page.tsx ConnectNumberZone`) : `GET /tenants/:id/embedded-signup/config` (appId+configId
  publics) → `FB.login({config_id, response_type:'code', override_default_response_type:true})` (SDK FB chargé à la
  demande). Le `code` arrive par le callback `FB.login` (TTL 30 s) ; `waba_id`/`phone_number_id` par `postMessage`
  `WA_EMBEDDED_SIGNUP` (origine ANCRÉE `^https://([a-z0-9-]+\.)*facebook\.com$`, ids string OU number).
- **Back** (`src/http/embedded-signup.ts` + `src/meta/embedded-signup.ts` + `src/account/es-store.pg.ts`) :
  `POST /complete {code, wabaId, phoneNumberId}` → échange code→business token (`GET /oauth/access_token`) →
  **`verifyWaba` + `getPhone` BLOQUANTS** avec le business token (garde anti-hijack cross-tenant : ne pas croire les
  ids du client) → `link` (rattache waba+numéro au tenant, réaffecte si besoin) → `subscribeApp` (webhooks, best-effort
  warning) → `register` si `status != CONNECTED` (pin CSPRNG) → `saveCredentials` (token+pin **chiffrés AES-256-GCM**
  via `src/crypto/secretbox.ts`, mig **0029** `waba_credentials`). Config Meta = template « WhatsApp Embedded Signup
  60-day » (cf `brain/LEARNINGS.md` 2026-07-16 pour la chaîne de prérequis Meta).

### 🔴 Le second passage : la popup ne dit RIEN (mesuré et corrigé le 2026-08-17)

Meta n'émet `WA_EMBEDDED_SIGNUP` que lorsque la popup exécute VRAIMENT les étapes de configuration. Un client
qui rouvre le parcours après un premier passage abouti obtient un code... et rien d'autre. Mesuré toutes traces
ouvertes : le seul message reçu de `facebook.com` était le canal interne du SDK portant le code. La doc de Meta
est muette sur ce cas. Tant qu'on exigeait les identifiants, ce client était bloqué DÉFINITIVEMENT.

`wabaId`/`phoneNumberId` sont donc désormais **facultatifs**. Absents, le serveur les retrouve : `wabasForToken`
(`GET /debug_token` -> `granular_scopes[].target_ids`) puis `listPhones`. ⚠️ `debug_token` prend DEUX tokens de
rôles DIFFÉRENTS : `input_token` est le token inspecté (celui du client), et l'autorisation doit être un token
d'APPLICATION (`{appId}|{appSecret}`). S'authentifier avec celui du client rend « #100 You must provide an app
access token ». Un token non scopé (notre System User) rend `target_ids: null`, ce n'est pas une erreur.

Sûreté inchangée : les identifiants viennent du token du CLIENT, ils ne peuvent donc pas désigner les biens d'un
autre, et `verifyWaba`/`getPhone` restent joués sur l'identifiant retrouvé (test dédié). L'ambiguïté (plusieurs
comptes ou plusieurs numéros) est REFUSÉE en 409, jamais tranchée au hasard.

### 🔴 Statuts HTTP : aucun message utilisateur dans un 5xx (Cloudflare le détruit)

Mesuré le 2026-08-17 : par l'URL publique, un `502 {"error":"..."}` revient en `text/html` de 6 429 octets,
page « 502: Bad gateway » de Cloudflare, notre corps disparu. L'utilisateur lisait « Erreur 502 » sans jamais
connaître le motif de Meta. Les refus lisibles sortent donc en **422** (409 pour une ambiguïté), et chaque refus
est **journalisé côté serveur** : le corps peut être détruit en route, le log reste. Un test verrouille la règle.
Astuce de diagnostic : comparer l'appel INTERNE et l'appel PUBLIC isole la couche coupable en une mesure.

## i18n FR/EN (2026-07-16)

`web/lib/i18n.tsx` : `LocaleProvider` (langue dans un contexte, persistée localStorage, défaut FR, appliquée après
montage → pas de mismatch d'hydratation ; l'effet de montage resynchronise AUSSI `document.documentElement.lang`) +
`useT()` → `t('texte FR', 'EN text')` **co-localisé** au point d'appel (pas de dictionnaire central). Provider dans
`app/layout.tsx`, toggle dans `AccountMenu` + `LocaleToggle` (pill FR/EN) sur les 5 pages pré-login. Règle : NE JAMAIS
wrapper une valeur backend/clé/comparaison dans `t()` ; chaînes au niveau module → déplacer dans le composant ou passer `t`.

**Lot 6 (2026-07-16), dates/nombres/libellés localisés** : le type `Locale` vit dans `web/lib/locale.ts` (**.ts pur** :
le tsc racine n'a pas `--jsx`, importer un type depuis `i18n.tsx` casse le build → TS6142 ; i18n.tsx le ré-exporte).
`day.ts` (`dayLabel`/`hourMin`/`formatDate`) et `format.ts` (`fmtNum`/`fmtPct`/`sendingLimitLabel`/`tierLabel`) prennent
un `locale` **REQUIS** (pas de défaut : tsc LISTE tous les appelants, aucun oubli possible). Les tags BCP47 (`fr-FR`/
`en-GB`) sont CONFINÉS à ces 2 libs : grep `fr-FR` = 0 ailleurs dans `web/`. `dayKey` (en-CA = clé ISO de tri) et
`fmtCost` restent indépendants de la langue.

**Rattrapage du 2026-08-21 : le trou était sous les composants.** Le chantier de 2026-07-16 avait traduit les
`.tsx`, où une chaîne non enveloppée dans `t()` se repère à l'oeil. Les lots d'août ont ensuite extrait la
logique de présentation vers des modules `.ts` PURS, testables par vitest, où `useT()` est **inappelable**
(c'est un hook). 79 chaînes s'y sont accumulées et sortaient en français sur une console en anglais, sans que
build, tsc ni tests ne bronchent : `i18n.tsx` retombe **silencieusement** sur le français quand l'argument
anglais manque. Corrigés : `mesures-scenario.ts` (tout l'écran Mes tableaux), `meta-errors.ts` (22 messages
d'erreur Meta), `fields.ts` (libellés des champs système, désormais en paires `[fr, en]`, ce qui a permis de
supprimer la copie qu'en portait `ConditionBuilder`), `timezones.ts` (exonymes), `http.ts` (messages jetés,
qui lit la langue directement dans `localStorage` faute de contexte React), plus les guillemets `« »` restés
dans des phrases anglaises.

🔴 **Deux pièges vérifiés à cette occasion.** (1) `ScenarioCanvas` comparait `d.titre !== t(...meta.label)`,
soit une chaîne jamais traduite contre une chaîne traduite : en anglais l'égalité n'arrivait jamais et le
sous-titre redondant réapparaissait sur tous les blocs. Remplacé par un booléen calculé à la source
(`titrePropre`). C'était la seule occurrence du grep de sûreté `=== t(`. (2) Le libellé d'une mesure est
**persisté** dans un tableau enregistré : `groupesDuTableau` le RE-DÉRIVE à l'affichage au lieu de relire
celui du JSON, sinon un tableau enregistré en français ressort en français dans une console en anglais.

⚠️ **Règle** : un module `.ts` qui produit du texte destiné à l'écran prend un paramètre `locale` **REQUIS**
(tsc liste alors les appelants), ou porte ses libellés en paires `[fr, en]` résolues au rendu par `t(...paire)`.
Attention, TypeScript ne protège PAS le rendu : `{f.label}` où `label` est une paire compile sans broncher et
React affiche « NomName ».

## Identifiants publics « schéma A » (Lot 4a, 2026-07-16, migration 0031)

Socle d'une future API : chaque entité porte un **code public** `<type>_<code-client>_<ULID>` (ex.
`scn_by5p57_01KXNVZD0NP4WY7WAEHA4765G5`). **ADDITIF strict** : colonnes `tenants.public_code` + `code`
(workflows/users/user_fields/tags) nullables + index uniques PARTIELS ; AUCUNE PK/FK/slug/clé (tenant,name)
touchée, les uuid internes restent la source de vérité des relations.

- `src/ids/code.ts` (PUR, testé) : `newUlid()` 26 car. Crockford (48 bits temps triable + 80 bits aléa),
  `makeCode(type, tenantCode)`, `deriveTenantCode(seed)` (6 car. base32 minuscules, déterministe depuis
  l'uuid tenant → immuable, collision barrée par l'index unique).
- `src/ids/tenant-code.ts` : `resolveTenantCode(pool, tenantId)` lit `public_code`, le dérive + persiste
  si absent (**self-heal idempotent**, pose concurrente absorbée).
- Génération à l'INSERT dans les 4 stores (`scn`/`usr`/`fld`/`tag`) ; `createTenantWithAdmin` pose la racine
  dans SA transaction. `on conflict do nothing` (champ/tag) = la ligne existante GARDE son code.
- Backfill one-shot des lignes antérieures : `db/backfill-codes.ts` (idempotent, `where code is null`),
  lancé APRÈS migrate. Types front : `code?: string | null` sur WorkflowSummary/AdminUser/UserFieldDef/TagCount,
  affiché discrètement (scénarios/champs/tags). Tags : le code vit sur la table des tags DÉCLARÉS (null pour un
  tag utilisé mais jamais déclaré).
- **Lot 4b (FAIT 2026-07-16)** : codes des NODES mintés **côté serveur** au save du graphe (`src/workflow/node-codes.ts`,
  POST/PATCH après parseGraph ; regex anti-forge `^nod_<tenantCode>_[ULID]$` : un code valide du même tenant est
  PRÉSERVÉ par référence, tout le reste est re-minté ; la réponse renvoie le graphe enrichi). Champs SYSTÈME : code
  **déterministe sans stockage** `fld_<client>_sys_<key>` (`systemFieldCode`), calculé côté front via le `tenantCode`
  exposé par GET /fields. Restent : endpoints API publics (chantier dédié).

## Workflow : auto-save + node « message rapide » (Lot C, 2026-07-16, migration 0030)

- **Auto-save** (`WorkflowBuilder.tsx`) : debounce ~1,2 s sur `[nodes, edges]` (skip du rendu initial), flush au
  démontage + `beforeunload` en **keepalive** (`updateWorkflow(..., {keepalive:true})`), planification via
  `doSaveRef` (changement de langue ≠ save), **saves sérialisés** (un PATCH à la fois, re-save si édité pendant).
  Indicateur passif « Enregistré à HH:MM » / retry sur échec. Colonne `workflows.status` **droppée** (mig 0030,
  elle était 100 % cosmétique) : ⚠️ 1re migration DROP du repo : deploy AVANT migrate (cf DEPLOY.md).
- **Node `quick_message`** : bloquant (attend la réponse) comme template ; `actionOf` → `{kind:'sendQuickMessage',
  body, buttons}` (null si corps vide ou aucune réponse non vide → no-op, comme un template sans nom) ;
  `executor.apply` → dep `sendQuickMessage` → `MetaClient.sendInteractive` (interactive/button, filtre les titres
  vides en PRÉSERVANT l'index `btn:<slot>` → la branche par bouton reste stable, cap Meta 3 boutons/20 car.) ;
  worker : câblage type sendTemplate (texte littéral V1, log inbox best-effort). Fenêtre 24 h garantie par l'archi
  (jamais node d'entrée).
- **Node `flow` (Lot 7, fini le no-op)** : `actionOf` -> `{kind:'sendFlow', flowId, flowName, body, cta}`
  (flowId vide -> null+waiting, contrat template vide ; accroche défaut « Formulaire : <nom> », cta défaut =
  cta du flow) -> dep executor `sendFlow` -> worker -> `MetaClient.sendFlowMessage` (interactive/flow,
  `flow_message_version:'3'`, `flow_token` jetable jamais vide `${waId}-${Date.now()}` (corrélation par `_ref`,
  pas le token), `flow_action_payload.screen = FORM`, `mode:'draft'` dispo pour tester un brouillon).
  **Garde fenêtre 24 h** (mise à jour 2026-08-15) : `scanOpening` (engine, PUR) fait UNE traversée en largeur
  depuis l'entrée et rend 5 faits sur l'OUVERTURE : message de session avant tout template, 1er template
  atteignable, ambiguïté (deux templates différents selon la branche), attente avant le 1er template, template
  d'ouverture sans nom. `opensOutsideServiceWindow` n'en est plus qu'un appelant.
  L'enregistrement du graphe reste VOLONTAIREMENT permissif (le builder sauve en continu) ; les gardes sont
  `POST /campaigns` (400 en nommant la cause) et le runtime (`executor.runFrom`). Côté front, le miroir vit
  dans `web/lib/campaign-eligibility.ts` (frontière de build : aucun module partagé) et
  `tests/web-campaign-eligibility.test.ts` compare les DEUX implémentations sur les mêmes graphes.

  **Bloc « Attente » (2026-08-15, migration 0054)** : un parcours peut dormir jusqu'à une échéance.
  - moteur PUR : `waitDurationMs` (minutes/heures/jours, plafond 30 j, durée absente = passe-plat) ; `walk`
    rend `{ status: 'sleeping', nodeId, resumeInMs }`.
  - base : `workflow_runs.resume_at` + statut `sleeping` (CHECK élargi) + index partiel `(resume_at)`.
  - réveil : `wake-sweep.ts` (miroir de `campaign/schedule-sweep`) toutes les
    `WORKFLOW_WAKE_SWEEP_INTERVAL_MS` (60 s = la précision réelle d'un délai).
  - ⚠️ **le claim est un BAIL** : `resume_at = now() + 5 min`, statut INCHANGÉ à `sleeping`. Passer à `waiting`
    exposerait le run à `advance` (un message du contact pendant la reprise rejouerait le même bloc = double
    envoi) et un worker tué laisserait un run figé, ressuscitable par n'importe quel message. Avec le bail, un
    worker tué rend simplement le parcours dû 5 minutes plus tard.
  - un run endormi OCCUPE le contact (`hasRecentWaitingRun` compte `sleeping`), sinon une automation lancerait
    un 2e parcours en parallèle et les deux écriraient au réveil.
  - `executor.resume` : gardes `mayAct`, bloc suivant existant, puis fenêtre 24 h RELUE en base
    (`getWindowOpenByWaIds`) si la suite envoie un message de session -> sinon on n'envoie pas et on remonte en
    inbox. Un template, lui, part hors fenêtre.
  - chaîne d'attentes cyclique : bornée par l'âge du run (90 j) dans le claim + `closeStaleSleeping`.
  - `waitBeforeSessionMessage` (pur, + miroir front) détecte « attente >= 24 h puis message de session » pour
    l'afficher dans le builder ; cumul plafonné à 24 h, ce qui garantit la terminaison sur graphe cyclique.

## Canal RCS (smsmode) : envoi, rappels, composeur (2026-08-24, migrations 0056-0058, 0077-0079)

Deuxième canal du produit, à côté de WhatsApp. Ce qui signe les messages n'est pas un numéro mais un **agent
de marque** déposé chez un fournisseur et approuvé par Google et les opérateurs. Fournisseur en production :
**smsmode** (API REST RCS v1.8).

### Ce qui isole les workspaces

Le mapping `rcs_agents` (tenant -> agent) est le SEUL contrôle : toute résolution d'agent, toute clé, tout
rappel passe par lui, scopé tenant. Depuis 0078 chaque workspace a **sa** clé d'API, chiffrée en base
(`api_key_enc`, `src/crypto/secretbox.ts`) ; la variable d'environnement `SMSMODE_RCS_API_KEY` n'est plus
qu'un repli. Le canal est **allumé par déduction** : `hasAgent(tenant)`, pas de drapeau à basculer à la main.

### Ce que smsmode fait, et ne fait pas (mesuré, pas supposé)

- Une clé d'API est rattachée à **UN canal**. Une clé de canal SMS s'authentifie et répond `403 Channel type
  mismatch` sur l'API RCS. D'où la vérification à l'activation (`src/rcs/channel-info.ts`), en **422**.
- **Aucun endpoint de joignabilité.** Leur `lookup` est l'opérateur du destinataire renvoyé AVEC le rapport de
  livraison, donc après coup. `SmsmodeRcsProvider.canCheckReachability = false` : le sender saute la
  vérification préalable au lieu de payer un aller-retour pour une constante.
- **Reporting différé** : juste après un 201, la fiche du message répond 404. Rien ne se conclut d'un statut
  lu immédiatement.
- Le statut `READ` **existe** et n'est pas dans leur énumération documentée. Tout mapping tolère l'inconnu.
- Destinataire en **chiffres nus**, sans `+`. `refClient` borné à 140 caractères.
- **Aucune signature** sur les rappels : voir ci-dessous.

### Rappels entrants (`POST /rcs/callback/:code`)

URL publique `https://mba.messagingme.app/api/backend/rcs/callback/<code>`, posée sur CHAQUE envoi
(`callbackUrlFor`), et non configurée à la main chez le fournisseur. Une seule adresse pour les deux flux : le
corps porte `direction` (MT = rapport de livraison, MO = message entrant).

🔴 **Ce qui autorise l'appel**, faute de signature : (1) le `webhook_code` de l'URL, 128 bits, propre au
workspace, qui porte le tenant, jamais le corps ; (2) le `channel.channelId` du corps, qui doit être l'agent
de ce workspace. La migration 0079 fait tourner les codes courts émis avant.

Effets d'un rapport de livraison (`src/index.ts`, deps `rcsCallback`) :

| Rapport | Effet |
| --- | --- |
| tout statut connu | statut de livraison du destinataire de campagne (même échelle que Meta) |
| `DELIVERED` | reprend la sortie **« envoyé »** du bloc, **seulement** si le bloc n'offre aucun bouton réponse |
| `UNDELIVERABLE` / `UNDELIVERED` | reprend la sortie **« non joignable »** : c'est la cascade RCS vers WhatsApp |
| statut inconnu | **ignoré**, jamais traité comme un échec |

Le garde-fou du `DELIVERED` est le point délicat : l'accusé arrive en quelques secondes, le contact répond bien
plus tard. Avancer alors qu'un bouton est proposé enverrait son clic dans le vide.

Effets d'un message entrant : opt-out si le texte commence par STOP (avant tout le reste), enregistrement dans
le fil d'inbox avec `channel='rcs'`, puis avance du scénario.

smsmode **rejoue** six fois (30 s, 2 min, 10 min, 1 h, 5 h, 24 h) tant qu'il n'a pas reçu un 2xx. D'où : 200
sur un corps illisible (le rejouer ne le rendra pas lisible), 404 sur un code inconnu, et une panne interne
qu'on LAISSE remonter en 5xx pour qu'ils rejouent.

### Charge utile des boutons

`normaliserPostbacks` (`src/rcs/schema.ts`) réécrit le `postbackData` de chaque bouton RÉPONSE en `btn:<i>`,
i étant son rang **parmi les réponses**, c'est-à-dire le nom que le builder donne à la sortie correspondante.
Appliqué au point de passage unique (`RcsSender.sendTo`), donc à l'envoi et non à l'enregistrement : les
messages déjà en bibliothèque se réparent seuls. Sans cette réécriture, un clic ne retrouve aucune arête et le
parcours s'arrête en silence.

### Les six formes de bouton

Les six du provider sont exposées, aucune de plus. Trois ramènent le contact dans la conversation ou l'en
sortent, trois agissent sur son téléphone :

| Forme | Ce qu'elle fait | Sortie de scénario |
| --- | --- | --- |
| `reply` | réponse en un tap | **oui**, `btn:<i>` |
| `openUrl` | ouvre une page web | non |
| `dial` | compose un numéro | non |
| `calendar` | ajoute un rendez-vous à l'agenda | non |
| `showLocation` | ouvre un lieu sur la carte | non |
| `requestLocation` | demande sa position au contact | non |

🔴 **Pourquoi une seule ouvre une branche.** Seul un `reply` renvoie une charge utile (`postbackData`) que
l'exécuteur puisse relier à une arête. Une position partagée revient dans un corps `LOCATION` **sans texte et
sans `postbackData`** (vérifié sur leur spec) : impossible d'en déduire quel bouton l'a déclenchée. Le builder
n'affiche donc de sortie reliable que pour les boutons réponse, règle tenue par `ouvreUneSortie` et partagée
entre le rendu du bloc et son panneau de configuration.

**Le bouton Agenda et la date de CHAQUE contact.** `startAt`/`endAt` acceptent une date-heure locale
(`2026-09-01T10:00`) ou une variable `{{champ}}`. Un message de bibliothèque étant réutilisable, une date en
dur y serait vraie une fois et fausse ensuite ; l'écran ne propose que les champs de type **date et heure**
(un champ `date` seul ne porte pas d'heure et produirait une valeur refusée). Une date qui ne se résout pas
fait tomber **le bouton** (`elaguerBoutonsInvalides`, appliqué au point de passage unique de l'envoi et
journalisé), jamais le message : sans cette garde, un contact sans rendez-vous ne recevrait plus rien du tout.

**Ce que le contact renvoie.** Une position (`latitude`/`longitude`) et un fichier (`fileUrl`, `filename`)
sont conservés et rendus lisibles dans le fil d'inbox par `apercuMo`. Sans cela, la réponse ne serait qu'une
bulle vide et l'information demandée serait perdue.

### 🔴 Le canal est porté par le PARCOURS, pas par le bloc (migration 0082)

Le multicanal, tel que Julien l'a formulé le 2026-08-24 : « le RCS part en premier, l'utilisateur clique, la
suite doit partir en RCS ; s'il clique l'autre bouton, on bascule sur WhatsApp ».

Un « message rapide » est un texte avec des réponses en un tap : WhatsApp sait le faire, le RCS aussi. Le bloc
dit donc l'INTENTION, pas le tuyau. `workflow_runs.channel` porte le canal courant, et les envois le font
évoluer :

| Ce qui part | Effet sur le canal du parcours |
| --- | --- |
| bloc RCS **réellement envoyé** | passe à `rcs` |
| **template** WhatsApp | revient à `whatsapp` (c'est ainsi qu'on bascule volontairement) |
| **message rapide** | suit le canal courant, ne le change pas |
| bloc RCS **sauté** (opt-out, agent absent) | inchangé : le repli « non joignable » est WhatsApp |

Un message rapide envoyé en RCS devient un TEXTE + boutons `reply`, dans le même ordre : le clic revient donc
sur la même sortie `btn:<i>` que côté WhatsApp, et le reste du moteur ne voit aucune différence.

⚠️ Le canal suit ce que le contact a REÇU, jamais une intention : un bloc RCS sauté ne bascule rien, sinon la
branche de repli partirait elle aussi en RCS, chez un contact qu'on vient justement de constater injoignable.

⚠️ Seul le **formulaire** (WhatsApp Flow) reste impossible derrière un RCS : il n'a aucun équivalent RCS, part
donc forcément par WhatsApp, et se fait refuser hors fenêtre. Le builder le signale (`sessionMessageAfterRcs`).

### 🔴 Ce qui peut OUVRIR un scénario, et ce qui peut le SUIVRE

Deux règles distinctes, longtemps confondues parce que WhatsApp était le seul canal.

**Ouvrir.** Une campagne, comme un lancement depuis l'Inbox hors fenêtre, part sur un contact qui n'a rien
écrit récemment. Peuvent donc ouvrir : un **template** WhatsApp configuré, ou un **bloc RCS** configuré
(`scanOpening.rcsOpen`). Le RCS n'a aucune fenêtre : la contrainte des 24 h appartient à WhatsApp.

⚠️ Vécu le 2026-08-24 : un scénario commençant par un bloc RCS n'apparaissait PAS dans le sélecteur de
l'Inbox quand la fenêtre était fermée, c'est-à-dire précisément quand il servait. La règle « seul un template
peut ouvrir à froid » datait d'avant le canal RCS. Les DEUX miroirs (`src/workflow/engine.ts` et
`web/lib/campaign-eligibility.ts`) portent maintenant `rcsOpen`, et le test de parité compare les deux sur des
graphes RCS.

**Suivre.** Après un bloc RCS, mesuré :

| Bloc branché derrière | Résultat |
| --- | --- |
| **template** WhatsApp | part (aucune fenêtre requise) |
| **autre bloc RCS** | part |
| **message rapide** | part **en RCS** : le canal est porté par le parcours (voir la section ci-dessus) |
| **formulaire** (WhatsApp Flow) | **refusé par Meta** si le contact n'a pas écrit SUR WHATSAPP depuis 24 h |

Répondre à un message RCS ne rouvre pas la fenêtre WhatsApp : ce sont deux tuyaux distincts. C'est pourquoi
un message rapide suit désormais le canal du parcours au lieu de partir en WhatsApp par principe. Le
formulaire, lui, n'a pas d'équivalent RCS : le parcours ne fait pas semblant, il clôt le run et remonte la
conversation à un humain, avec la raison en journal, et le builder signale le montage sans l'interdire.

### L'écran d'envoi de template de l'Inbox

Deux corvées supprimées le 2026-08-24, toutes deux du même genre : redemander ce que le produit sait déjà.

- **Les variables sont PRÉ-REMPLIES** sur la fiche du contact ouvert, via les indices posés à la création du
  template (`template_param_hints`), et le libellé du champ s'affiche à côté. L'écran demandait `{{1}}`,
  `{{2}}` en texte libre, sans dire ce qu'ils attendaient. Route :
  `GET /tenants/:id/conversations/:cid/template-params?name=&language=&count=`, MÊME résolution que l'envoi
  réel, donc l'écran montre exactement ce qui partira. Les valeurs restent modifiables.
- **L'en-tête média du template est repris automatiquement** (`headerMediaUrl`, lu chez Meta dans
  `example.header_handle`). Meta exige le fichier à CHAQUE envoi, mais l'opérateur n'a aucun moyen de
  retrouver l'URL de ce qu'il a choisi en créant le template. Le champ de saisie ne réapparaît que si le
  template n'en porte aucune (lien expiré chez Meta), et il le DIT alors.

### Un envoi RCS apparaît dans le fil, quel que soit son déclencheur

Les trois chemins écrivent la bulle dans la conversation, avec `channel = 'rcs'` (l'Inbox la dessine alors
aux couleurs du canal) :

| Déclencheur | Qui journalise |
| --- | --- |
| campagne RCS | `campaign/engine.ts` (`recordOutboundByWaId`) |
| Inbox (bouton 📱) | la route `send-rcs` |
| **bloc de scénario** | `rcs.recordOutbound`, câblé dans `wiring.ts` |

⚠️ Le troisième manquait jusqu'au 2026-08-24 : un message RCS parti par un scénario n'apparaissait NULLE PART
dans l'Inbox. L'opérateur voyait la réponse du contact sans jamais voir la question, ce qui rend une
conversation illisible pour qui la reprend. Best-effort strict : le message est déjà parti chez l'opérateur
télécom quand on journalise, un incident de journal ne doit pas le faire passer pour un échec. Un envoi SAUTÉ
(opt-out, agent absent) n'écrit rien : il n'a rien montré au contact.

### Envoyer un RCS depuis l'Inbox

`POST /tenants/:id/conversations/:cid/send-rcs`, avec l'identifiant d'un message de la bibliothèque.

🔴 **Volontairement SANS garde de fenêtre 24 h**, à la différence de `reply`. Cette fenêtre est une règle de
WhatsApp, pas une règle du monde : le RCS n'en a pas, et c'est précisément quand la fenêtre WhatsApp est
fermée qu'il devient le moyen de reprendre contact sans template à faire approuver. L'écran propose donc le
bouton dans les DEUX états de la barre de réponse.

Le message vient de la bibliothèque (comme un template vient de Meta) : un opérateur d'inbox n'a pas à
composer une carte, un visuel et des boutons dans une barre de réponse. Ses variables sont résolues sur la
fiche du contact par le MÊME chemin d'envoi que les campagnes (`rcsStack.sender`), donc avec les mêmes
garde-fous (opt-out, élagage des boutons, normalisation des charges utiles) sans en réécrire un seul.

Chaque refus porte sa RAISON, en **422** : « le canal n'est pas activé » et « ce contact s'est désabonné »
demandent deux gestes différents, et un 5xx verrait son corps remplacé par la page d'erreur de Cloudflare.
Comme la réponse texte, l'envoi fait PRENDRE le fil à l'opérateur, et la bulle est enregistrée avec
`channel = 'rcs'`.

### Le champ variable, comme un template Meta

`ChampCorpsVariables` (ex-`RcsBodyField`, renommé le 2026-08-25) : on écrit, on clique « + Variable », on
choisit un champ du contact, et un chip `[Prénom]` s'insère au curseur. La chaîne stockée reste
`Bonjour {{prenom}}` ; c'est l'AFFICHAGE qui change. Quatre appelants : messages RCS, bloc RCS du builder,
campagne RCS, et le corps en format Texte d'un modèle d'email.

⚠️ Le bouton et sa liste de champs vivent à part, dans `SelecteurVariable` : trois surfaces doivent l'ouvrir
(le sujet d'un modèle d'email, son corps en Texte, son corps en HTML) et seule la première passe par l'éditeur
à chips. Un `contenteditable` resérialise le DOM, donc il abîmerait un HTML collé depuis un outil externe.

⚠️ La liste proposée vient de `emailVariableFields` et NON de `emailResolvableFields` : la première ajoute les
variables de base réellement fournies par `contactVars` (`profile_name` pour le nom, `phone`), que
`GET /user-fields` ne renvoie jamais puisqu'il ne sert que les champs perso. La seconde sert à choisir un champ
qui CONTIENT une adresse (destinataire du bloc email), où proposer « Téléphone » serait un piège.

L'éditeur à chips (`VariableBodyEditor`) est désormais partagé avec le corps d'un template Meta. Il prend un
`varPattern` (positions `{{1}}` par défaut, motif NOMMÉ pour le RCS) et un `labelOf(nom)`. Les deux contrats
restent distincts, et c'est voulu : les variables Meta sont POSITIONNELLES (exemple obligatoire,
renumérotation à l'envoi, parce que Meta valide un gabarit), celles du RCS sont NOMMÉES et résolues sur la
fiche. Un seul éditeur en dessous, deux vocabulaires au-dessus.

### Héberger le visuel (migration 0081)

Un message RCS ne transporte pas l'image, il transporte son **adresse**, que l'opérateur télécom va chercher
lui-même. Sans hébergement, un client doit poser son visuel ailleurs et coller un lien, ce qui suffit à rendre
la fonctionnalité inutilisable pour celui à qui elle sert. La console héberge donc les visuels.

- **Téléversement** : `POST /tenants/:id/rcs/media` (admin), data URL base64, et rend directement l'URL
  publique. `GET` liste la médiathèque, `DELETE` retire un visuel (suppression DURE : ce qui compte est qu'il
  cesse d'être servi, ce qu'une suppression douce ne ferait pas).
- **Lecture** : `GET /m/<code>.<ext>`, **publique et non authentifiée**, exposée par un rewrite dédié du front
  (`/m/:fichier`), comme `/r/:code` pour les liens tracés. C'est l'opérateur qui télécharge, il n'a aucune
  session ; le `code` (130 bits) tient donc l'accès à lui seul.
- **Stockage** : les octets en base (`rcs_media.bytes`). Un volume Docker ne survit pas à une recréation de
  conteneur sans déclaration explicite et n'est sauvegardé nulle part ; un bucket ajoute un service, des clés
  et un mode de panne. Le volume est minuscule (2 Mo maximum par visuel, quelques visuels par client) et suit
  la base dans toute restauration. Déplacer le stockage un jour ne changerait que `media-store.pg.ts` :
  l'URL publique, elle, ne bougerait pas.

🔴 **Ce qui est servi est décidé par la SIGNATURE du fichier**, jamais par le type déclaré au téléversement
(`src/rcs/image.ts`). Servir un fichier pour ce qu'il prétend être est la façon classique de transformer un
hébergeur d'images en hébergeur de pages ; un PDF renommé en `.png` est refusé en **415**. Trois formats
seulement (JPEG, PNG, GIF, ceux que l'opérateur accepte), pas de SVG (XML exécutable). La réponse porte
`nosniff` et le type réel.

⚠️ **Cache d'UN JOUR, pas d'un an.** Le contenu d'un code ne changeant jamais, `immutable` sur un an semblait
évident. Mesuré sur la production le 2026-08-24 : Cloudflare met ces images en cache au bord
(`cf-cache-status: HIT`) et continuait de servir un visuel **supprimé** alors que l'origine répondait déjà
404. Une suppression qui ne supprime pas est une promesse intenable. Un jour couvre entièrement la rafale de
lectures d'une campagne (elle part en quelques minutes, et chaque destinataire déclenche un téléchargement) et
borne l'exposition après suppression. Pour rendre une suppression immédiate, il faudrait purger le cache
Cloudflare par API, ce qui suppose un jeton que ce projet n'a pas.

⚠️ L'extension de l'URL n'est pas décorative : le fournisseur exige une adresse qui finit par `.jpg`, `.jpeg`,
`.png` ou `.gif`. Elle doit CORRESPONDRE au fichier stocké, sinon on servirait un PNG sous une adresse en
`.jpg` (404 dans ce cas).

### 🔴 Où les boutons sont accrochés décide de leur apparence

Ce n'est pas nous qui dessinons les boutons : c'est l'application Messages du destinataire. Le seul levier est
l'endroit où on les accroche, et il change tout (documentation RBM de Google, lue le 2026-08-24) :

| Accrochés à | Apparence | Nombre | Durée |
| --- | --- | --- | --- |
| la **carte** (`card.suggestions`) | boutons **pleine largeur empilés**, dans la carte | 4 | ils restent |
| le **message** (`suggestions`) | petites **pastilles en ligne**, sous la bulle | 11 | elles disparaissent quand la conversation avance |

C'est la première forme qu'on reconnaît des grandes campagnes RCS. L'écran met donc les boutons DANS la carte
dès qu'il y a un visuel (et laisse retomber le surplus en pastilles plutôt que de le perdre), plafonne à 4
dans ce cas, et son aperçu dessine les deux formes différemment : afficher des pastilles pour un message qui
partira en liste ferait croire à un choix qu'on ne fait pas.

⚠️ Conséquence pour `normaliserPostbacks` : la numérotation `btn:<i>` parcourt les boutons **de la carte
d'abord**, les pastilles ensuite. C'est l'ordre dans lequel l'écran les écrit et celui dans lequel le builder
numérote les sorties du bloc ; l'inverser enverrait le clic du premier bouton sur la branche d'un autre.

**Non exposé** : `webviewSize` sur un bouton lien (ouvrir la page dans une vue intégrée plutôt que dans le
navigateur), et le carrousel.

### Composeur : texte, visuel, variables

Le format se **déduit** de la saisie, dans un seul endroit (`web/lib/rcs.ts`, miroir serveur dans
`rcsOutboundOf`) : TEXTE sans visuel, **CARTE** dès qu'il y en a un (image au-dessus du texte, hauteur `TALL`).
Le texte tombe alors de 3072 à 2000 caractères, borne de leur champ `description`.

⚠️ Le mapping carte/carrousel a longtemps été FAUX (`card`/`cards` et `media.url` au lieu de `content`/
`contents` et `media.fileUrl`). Aucun envoi ne l'exerçait ; la première image serait partie en 400. Corrigé
contre leur spec le 2026-08-24, figé par un test.

Variables `{{champ}}` : **même** contrat et **même** table de substitution que les modèles d'email
(`contactVars`). Substituées dans le corps uniquement, jamais dans les libellés de boutons (25 caractères) ni
dans les URL, où une valeur vide ou trop longue ferait refuser le message entier. La fiche du contact n'est lue
QUE si le message porte des variables.

### Reste à faire

Le carrousel n'a pas de composeur, et `webviewSize` (ouvrir un lien dans une vue intégrée plutôt que dans le
navigateur du téléphone) n'est pas exposé.

## Lot « inbox, comptes, modération » (2026-08-21, migrations 0068-0073)

### Affectation d'une conversation (0070)

🔴 **`assigned_to` et `control_owner` sont ORTHOGONAUX.** `control_owner` dit QU'EST-CE QUI parle (scénario,
humain, agent Meta) ; `assigned_to` dit QUEL HUMAIN s'en occupe. Une conversation peut être affectée ET tenue
par le scénario. Les mélanger casserait le gel de scénario d'août.

La règle d'accès vit dans `src/inbox/assignment.ts`, fonction PURE, appelée par les TROIS routes qui écrivent
au client (réponse, template, lancement de scénario). Elle ne reçoit même pas `control_owner` : si quelqu'un
le lui passait, le code ne compilerait plus. Griser un bouton ne protège rien, le refus vient du serveur.

`on delete set null` sur l'affectataire : supprimer un membre LIBÈRE ses conversations au lieu de les
emporter. Une conversation que plus personne ne peut prendre serait invisible et sans réponse.

### Pagination et filtres de l'inbox (0069)

Le filtrage est en SQL, curseur sur `(last_message_at, id)` comparé en TUPLE. `id` départage les ex æquo :
sans lui, la pagination saute ou répète une ligne à la frontière de deux pages. Pas de drapeau `hasMore` :
une page pleine le dit déjà, un drapeau coûterait un décompte complet.

⚠️ Avant, l'écran filtrait EN MÉMOIRE les 100 conversations chargées : au-delà, le filtre ignorait le reste
sans rien signaler, et le compteur plafonnait à la taille de la page.

### Modération (0071)

Deux choses SÉPARÉES : `conversation_analysis.abusive` est un CONSTAT posé par l'analyse (qui ne déclenche
rien), `contacts.blocked_at` est une DÉCISION humaine (qui a des effets). Les mélanger laisserait un modèle
bloquer des clients tout seul.

Bloqué = plus aucun envoi (campagnes filtrées à la SOURCE dans `campaign/store.pg.ts`, automations coupées à
leur unique point d'entrée `runAutomations`) ET conversation masquée. 🔴 Les messages restent ENREGISTRÉS :
filtrer à la réception ferait disparaître une résiliation ou une menace juridique sans que personne le sache.

L'écran des contacts bloqués (Paramètres) est la SEULE porte de sortie : sans lui, un contact bloqué est
introuvable, donc perdu.

### Observation d'un espace depuis /ops

🔴 La LECTURE SEULE est une garde GLOBALE dans `makeRequireAuth`, fondée sur la MÉTHODE HTTP : `GET`/`HEAD`
passent, tout le reste est refusé. Une garde route par route aurait laissé passer celle qu'on oublie, et
surtout toute route d'écriture AJOUTÉE DEMAIN est couverte sans que personne y pense. Effet heureux : le
marquage « lu » est un POST, donc refusé : regarder une conversation ne fait pas disparaître les non-lus du
client.

La session d'emprunt (`Session.impersonated`) ne relit AUCUN état en base : son porteur n'a pas de compte
dans l'espace visité, le loader le révoquerait. Sa légitimité vient de sa signature, émise par `/ops/observe`
que protège le jeton d'exploitation (autorité SÉPARÉE du JWT client). `impersonated` est lu STRICTEMENT
(`=== true`).

### Une adresse, plusieurs espaces (0072/0073)

Le mot de passe vit sur l'ADRESSE (`identities`), plus sur le compte. Une table plutôt qu'un hash dupliqué :
l'invariant « une adresse = UN mot de passe » est EXPRIMÉ par la structure, pas simulé.

Connexion en deux temps. Un seul espace -> session directe (aucun écran de plus, c'est le cas courant).
Plusieurs -> le serveur rend la LISTE et un jeton de CHOIX, jamais une session.

🔴 Le jeton de choix ne peut pas tenir lieu de session : pas de `tenantId`/`role` à la racine (donc
`verifySession` le rejette), `kind` vérifié explicitement, et il PORTE la liste signée des espaces autorisés.
Sans cette liste, présenter un jeton légitime avec l'identifiant d'un espace quelconque suffirait à y entrer.

`setPassword` écrit sur l'IDENTITÉ (et en miroir sur `users.password_hash`, le temps de la transition) : une
réinitialisation vaut donc pour TOUS les espaces de l'adresse.

⚠️ **0073 est la seule migration IRRÉVERSIBLE du lot** : recréer `users_email_lower_unique` n'est possible
que TANT QU'AUCUN doublon n'existe. `users_tenant_email_unique` reste : deux comptes de la même adresse dans
le MÊME espace n'auraient aucun sens.

## Passage de main MBA et écran Activation (2026-08-21, migration 0067)

### Quand l'agent passe-t-il la main ? (mesuré au bac à sable le 2026-08-21)

Mesures faites via `POST /{phone_number_id}/agent_test` sur le numéro de test, `handoff` non configuré. Meta
écrit que les jetons consommés par cet endpoint ne sont pas facturés.

| Message envoyé | Réponse de l'agent | `handoff_reason` |
|---|---|---|
| « Je veux parler à un conseiller humain » | annonce le transfert | `customer_request` |
| « Le bus de 8h ne s'est pas arrêté ce matin. » | compatit, demande des précisions | `null` |
| « Comment obtenir un remboursement de mon abonnement ? » | répond depuis la base de connaissance | `null` |
| « Quel est le montant de ma dernière facture ? » | renvoie vers le service client | `null` |
| **« Le bus ne s'est pas arrêté ce matin. Comment obtenir un remboursement ? »** | **VIDE** | **`integrity_violation`** |

🔴 **Quand l'agent ne SAIT pas, il ne passe PAS la main.** Il renvoie vers les coordonnées de la base de
connaissance. L'intuition « s'il ne sait pas, il transfère » est fausse : c'est mesuré, deux fois.

🔴 **Un incident vécu PLUS une demande de réparation produit `integrity_violation` et une réponse VIDE.** Ni
l'incident seul, ni le mot « remboursement » seul ne le déclenchent : c'est bien la combinaison. Le client
reçoit alors le silence. Sans détection de notre côté, il reste sans réponse et personne n'est prévenu, ce qui
est le pire cas possible et l'argument le plus fort en faveur de la pastille « quelqu'un a besoin d'aide ».

**Troisième valeur de `handoff_reason` désormais connue** : `customer_request` (mesurée), `integrity_violation`
(mesurée le 2026-08-21), `complex_request` (exemple de la doc Meta, jamais observé chez nous).

⚠️ **Ces mesures viennent du BAC À SABLE, pas d'une conversation WhatsApp réelle.** Tant qu'aucun moyen de
paiement n'est rattaché au compte, aucun message WhatsApp n'atteint l'agent : l'onglet « Tester » est le seul
canal. La forme du payload `messaging_handovers` reste donc inconnue, et le restera jusque-là.


**Le point à ne pas confondre.** L'agent de Meta décide SEUL de transférer à un humain (« je veux parler à un
conseiller » produit `handoff_reason: customer_request`, mesuré sur le numéro de test le 2026-08-18). Le champ
`handoff.enabled` ne décide donc PAS du transfert : il décide si l'agent **lâche le fil** après l'avoir annoncé.
Le mettre à `false` en croyant « désactiver le transfert » livre le pire cas : le client lit « un conseiller
arrive » et personne n'est prévenu.

**Les trois champs** de `handoff` (`agent_config/settings`) : `enabled`, `message`, `message_selection`
(`DEFAULT` / `AGENT` / `CUSTOM`). Nous n'écrivons aujourd'hui que `enabled` ; le texte lu par le client reste
celui de Meta tant que le comportement réel des deux autres n'a pas été mesuré en conversation réelle.

**Chemin d'écriture.** `PATCH /tenants/:t/settings/mba-handoff` (admin) enregistre `mba_handoff_mode` en base : c'est la source de vérité : puis applique `handoff.enabled` chez Meta en best-effort. Un échec côté Meta ne
fait pas échouer l'enregistrement (le balayage rattrape) et la réponse porte `appliqueChezMeta: false`, que
l'écran affiche. `PATCH /mba/:pn/settings` accepte par ailleurs `handoffEnabled`, `handoffMessage` et
`handoffMessageSelection` pour piloter les trois champs directement.

🔴 **`modifierSettings` fusionne `handoff` par sous-objet**, comme `rollout` et `followup`. Sans cette ligne,
le balayage horaire : qui n'envoie que `enabled` : effacerait `message` et `message_selection` à chaque
bascule. C'est le même piège que le remplacement complet du PUT, une couche plus bas.

**Balayage horaire** (`src/mba/handoff-sweep.ts`, intervalle `CONTROL_SWEEP_INTERVAL_MS`, 5 min). Meta n'a
aucune notion d'horaires : c'est la seule façon de faire varier ce que le client perçoit selon l'heure. Il ne
traite QUE les tenants en mode `business_hours` (les deux autres modes sont écrits une fois, au choix), et
n'écrit que si l'état lu diffère de l'état voulu, sinon il réécrirait la configuration toutes les 5 minutes.

🔴 **`lireHandoffEnabled` rend trois états, pas deux** (`EtatHandoff`) : `true`/`false` lus chez Meta,
`'absent'` quand les réglages sont lisibles mais que `handoff` n'a jamais été configuré (Meta : « Null if not
configured »), et `null` quand il n'y a rien à lire. Confondre `'absent'` avec `false` empêcherait
d'initialiser un agent neuf : le balayage croirait l'état déjà conforme.

**Routage d'une réponse hors boutons** (`advance`, `src/workflow/executor.ts`). Trois cas : arête partant du
handle du bouton tapé ; sinon arête LIBRE (`nextNodeSansHandle`, aucune `sourceHandle`) ; sinon fin du run et
release vers l'agent. `nextNode` prenait la 1re arête venue, donc la branche du 1er bouton. Le builder expose
la sortie libre sur les blocs à boutons, sans quoi le 2e cas serait inatteignable.

⚠️ **`control_changed_at` ne se rafraîchit pas** quand un opérateur répond une 2e fois : `setControlOwner`
porte `control_owner is distinct from $3` dans son WHERE, donc reposer le même détenteur ne met à jour aucune
ligne. Le compte à rebours de reprise part donc de la PREMIÈRE intervention. L'ancien texte de l'Accueil
disait « dernière » : c'était faux, et le nouvel écran le dit correctement.

## Traçage des clics sur les liens de templates (2026-08-20, migration 0066)

**Le principe.** L'utilisateur saisit son lien. À la **soumission à Meta**, le serveur le remplace par
`https://<APP_URL>/r/<code>` et garde la destination d'origine en base. Au clic : on compte, puis on redirige
en **302**. Personne d'autre ne garde la destination : Meta ne connaît plus que la nôtre.

**La maille est le BOUTON**, pas le template : un template peut porter deux boutons URL, un carousel en porte
par carte. Clé unique `(tenant, template_name, template_language, coalesce(card_index,-1), button_index)`.

**Deux tables** (`db/migrations/0066_tracked_links.sql`) :
- `tracked_links` : `code` (12 car. base32 minuscules, `newTrackingCode()` dans `src/ids/code.ts`), la cible,
  la `destination`, et `confirmed_at`.
- `tracked_link_clicks` : une LIGNE par clic (pas un compteur : l'écran filtre sur une période).

🔴 **`confirmed_at` n'est pas décoratif.** Il est posé seulement quand **Meta a accepté** le template. Les
mesures et le ré-habillage d'affichage ne lisent QUE les lignes confirmées, sans quoi une réservation suivie
d'un refus ferait apparaître dans Analytics une case qui reste à zéro pour toujours. En revanche la
**redirection ne filtre PAS** dessus : si Meta a accepté mais que notre confirmation a échoué, le lien circule
déjà et doit fonctionner. Un lien qui marche sans être mesuré vaut mieux qu'un lien mort bien comptabilisé.

🔴 **Ordre d'écriture imposé** : destination en base **AVANT** l'appel à Meta. L'inverse laisserait, sur une
panne entre les deux, un template approuvé pointant un code inexistant, donc un lien mort irréparable dans des
messages déjà livrés. Une panne du traçage soumet le template avec le lien **saisi** (`preparerLiens` dans
`src/http/templates.ts`) : un template non mesuré vaut mieux qu'un template refusé.

**Ré-habillage à la relecture** : `rehabillerTemplates` (`src/http/templates.ts`) remplace notre adresse par la
destination d'origine **sur la route de liste**, donc pour les quatre écrans qui affichent un template (page
Templates, création de campagne, éditeur de scénario, inbox). Appariement **sur l'URL**, jamais sur la position :
un template édité hors console peut avoir vu ses boutons réordonnés.

**Route publique** `GET /r/:code` (`src/http/links.ts`), montée avec le webhook et `/ops`, **avant** les gardes
d'auth. Trois points non négociables :
- `scopeTenant` est **inutilisable** ici : sans `req.auth`, elle rend le tenant de l'URL sans le vérifier. Le
  tenant vient du **code** retrouvé en base.
- **Open redirect** : la destination est revalidée par `isSendableButtonUrl` **à la lecture**, pas seulement à
  l'écriture.
- **302 et non 301** : un 301 est mis en cache par le navigateur, qui n'appellerait plus jamais la route. On
  perdrait tous les clics suivants et on ne pourrait plus changer la destination.

⚠️ **Exposition publique** : NPM ne route que `mba-web`, et `mba-api` n'a aucun port hôte publié. Le seul
chemin est le rewrite `/r/:code` de `web/next.config.mjs`, **gelé au build de l'image web**.

**Mesures.** Les clics ne peuvent PAS vivre dans `workflow_node_events` : elle exige `tenant_id`,
`workflow_id`, `node_id` et `wa_id` tous NOT NULL, or un clic sur un lien statique n'identifie personne. Ils
sont donc **fusionnés à la lecture** (`src/links/mesures.ts`, `getWorkflowNodeCounts` dans `src/index.ts`) sous
une nature `url_click` qui n'existe QUE dans la réponse de l'API et dans le front. Rien n'a été ajouté au CHECK
de 0063, ce qui évite la panne silencieuse d'un insert refusé (`record()` est best-effort partout).
`NodeEventCount.contacts` devient `number | null` : `null` = « on ne sait pas distinguer les personnes ».

**Lecture par CAMPAGNE** : `getCampaignFunnel` (`src/stats/store.pg.ts`) rend `urlClicks` (clics des liens
tracés du template de la campagne, **depuis son premier envoi**) et `buttonReplies` (taps de réponse rapide,
sous-ensemble de `replied`, discriminés par `conversation_messages.type = 'button'` et surtout PAS par
`button_payload is not null`, que remplissent aussi `interactive` et `reaction`). `urlClicks` vaut **`null`**
quand le template ne porte aucun lien tracé confirmé : l'écran masque alors l'étape au lieu d'afficher un zéro
trompeur. La route `GET /tenants/:t/stats/links` et `listAvecClics` (lecture « tous envois confondus ») ont été
RETIRÉES le 2026-08-21 avec la carte de Mes tableaux qu'elles alimentaient.

🔴 **Ne comptez pas les clics de Meta.** Mesuré le 2026-08-21 sur le premier lien de la production : 70 requêtes
sur le lien d'un template JAMAIS envoyé, dont 59 de l'agent `facebookexternalhit` et 11 de vrais navigateurs
arrivant de Facebook (référent `*.facebook.com`, paramètre `fbclid`), soit l'équipe de revue de Meta. Tout
template à bouton URL est donc exploré ET cliqué avant son premier envoi. Deux garde-fous, complémentaires :
`estClicAutomatique` (`src/links/clic-automatique.ts`) écarte ces requêtes **à l'écriture** tout en redirigeant
toujours, et le seuil « depuis le premier envoi » du funnel écarte **à la lecture** tout ce qui a été
enregistré avant que ce filtre n'existe. Aucun user-agent ni IP n'est stocké pour autant (migration 0066).

**Faits Meta MESURÉS le 2026-08-20** (deux templates d'essai, tous deux approuvés) : le domaine du bouton
**n'a pas besoin d'appartenir à l'entreprise**, et Meta **ne vérifie pas l'accessibilité** de l'URL à la revue
(un lien en 404 est passé). Détail : `brain/LEARNINGS.md`.

## Export PDF d'une carte (2026-08-20, aucune dépendance)

`web/lib/impression.ts` marque la carte visée d'une classe, marque le `body`, et appelle `window.print()`. Le
CSS de `web/app/globals.css` masque tout le reste **sous `@media print` uniquement** : à l'écran, une zone
restée marquée ne change rien. `visibility` et non `display`, sinon retirer les ancêtres du flux casserait la
grille qui porte la carte. Pas de `jspdf`/`html2canvas` : quelques centaines de kilo-octets pour rendre une
image au lieu d'un document, alors que « Enregistrer au format PDF » est dans la boîte d'impression de tous les
systèmes. ⚠️ La zone précédente est **démarquée** avant chaque impression : `afterprint` n'est pas garanti, et
une zone restée marquée s'imprimerait avec la suivante.

## Rôle `manager` (2026-08-20, migration 0065)

Troisième statut de membre. La contrainte de 0001 n'admettait que deux rôles : sans la migration, attribuer
« manager » remonte une 23514 depuis la base.

⚠️ **Un statut, pas des droits.** Tout ce qui est réservé l'est à `admin` (`makeRequireRole(['admin'])` sur les
groupes, `forbidNonAdmin` dans les handlers) : un manager a donc les accès d'un agent. Ce qu'il aura le droit de
faire se décidera écriture par écriture.

Corrigé au passage : le prédicat de `setRole` était écrit en dur sur `role = 'agent'`, il refusait donc de
rétrograder un manager dès qu'il ne restait qu'un seul admin. C'est `role <> 'admin'` : le compte visé n'étant
pas admin, le changer ne peut pas faire tomber le nombre d'admins. `pageDArrivee(role)` (`web/lib/session.ts`)
centralise la redirection après connexion : seul l'admin va sur `/accueil`, tout le reste sur `/inbox`.

## RGPD : journal d'audit et suppression (2026-08-19, migration 0061)

**Une seule destruction.** Il en a existé deux : `softDeleteMany` (douce, `deleted_at`, réversible, qui gardait
la conversation) et la purge. Les distinguer à l'écran ne servait personne : on supprime un contact pour qu'il
disparaisse, pas à moitié, et le fil restait dans l'Inbox après coup. « Supprimer » appelle donc
`POST /tenants/:t/contacts/purge`, qui exige `confirm: 'SUPPRIMER'` dans le corps, et l'écran fait TAPER le mot
(le serveur le demande déjà, mais c'est le client qui l'envoie : cette garde ne protège que d'une erreur d'API).
La colonne `deleted_at` reste : la purge la pose en même temps que `anonymized_at`, pour que la fiche vidée
quitte le CRM, et l'upsert par numéro la remet à null (résurrection).

**Ce que `purgeMany` efface, et ce qu'il garde.** EFFACÉ (contenu identifiant) : la conversation, ses messages,
son analyse qualitative (`topic` et `justification` en texte libre produits par un modèle), plus les traces
techniques portant le numéro (parcours de scénario, déclenchements d'automation, cache de joignabilité RCS).
ANONYMISÉ (pour que le quantitatif survive) : la ligne de contact (`phone_e164` remplacé par `anon:<uuid>`
ALÉATOIRE, pas une empreinte, qui serait réversible sur un espace de numéros français) et les lignes de
campagne (`to_e164`, `resolved_params`). Les totaux d'envoi et de livraison restent donc justes.

⚠️ **Trois pièges de format dans cette fonction, tous vus en production le 2026-08-18.** (1) Le fil porte un
`wa_id` SANS `+` (`33612345678`), la fiche un E.164 (`+33612345678`) : la correspondance passe par le prédicat
partagé `matchWaIdPredicat`, jamais par une égalité directe. (2) `rcs_capabilities_cache` a pour clé
`(agent_id, phone_e164)`, donc E.164 et non wa_id. (3) `automation_fires` a pour clé `(automation_id, wa_id)`
et **ne porte PAS de `tenant_id`** : son cloisonnement passe par un `using automations`. Un filtre sur une
colonne absente ne renvoie pas « rien », il LÈVE et annule toute la transaction.

**Le journal d'audit** (`src/audit/store.pg.ts`, table `audit_log`, migration 0061) est en AJOUT SEUL : ni
update ni delete, sinon il ne prouve rien. Il ne porte JAMAIS de donnée personnelle, seulement l'identifiant
interne du contact : y écrire le numéro au moment d'une suppression annulerait la suppression. `actor_email`
est DÉNORMALISÉ pour que l'historique reste lisible après le départ d'un collaborateur ; acteur `null` = le
système (webhook, script serveur). Écriture BEST-EFFORT partout (`src/audit/journal.ts`) : une panne de log ne
doit pas empêcher un client d'exercer son droit à l'effacement. Actions consignées : `contact.created`,
`contact.imported` (UNE ligne par LOT, sinon un import de 50 000 lignes noie l'historique), `contact.purged`,
`contact.optin`, `contact.optout`. Lecture : `GET /tenants/:t/audit`, affichée dans Paramètres.

**Consentement.** ⚠️ Tout part d'un fait à garder en tête : `optInAllows` (`src/campaign/guardrails.ts`) exige
un opt-in **EXPLICITE** pour une campagne marketing. Un contact `unknown` est donc écarté des envois **en
silence** ; seul `utility` passe. Chaque défaut d'opt-in ci-dessous se lit à cette lumière.

`opted_out` était lu par les filtres et le garde-fou mais **aucun chemin ne l'écrivait** : l'upsert d'import et
d'API ne fait jamais régresser un statut, donc un client demandant à ne plus rien recevoir n'était
enregistrable nulle part. Trois chemins l'écrivent maintenant, tous journalisés :

- **En masse** depuis le mini-CRM : action `set_optin` (`BulkEdits.setOptIn`, source `crm`).
- **Sur la fiche** : `PATCH /tenants/:t/contacts/:id` accepte `optInStatus`. DEUX valeurs seulement, jamais un
  retour à `unknown` : ce statut signifie « rien n'a jamais été enregistré », le repeindre falsifierait le
  registre au lieu de le corriger. L'écran ne propose pas non plus le statut courant.
- **Par WhatsApp Flow** (composant OptIn coché), la preuve de consentement la plus forte : `markOptedIn`,
  source `flow`, acteur `null` au journal puisque c'est le contact lui-même qui a agi.

**Opt-in PAR DÉFAUT** sur les deux chemins de création manuelle : la saisie à la main (case pré-cochée) et
l'import CSV (idem, et le défaut de la route est aligné dessus). Les saisir suppose qu'on tient le numéro de la
personne, et les créer muets en ferait des contacts que les campagnes ignorent sans rien dire. L'**API publique
`/v1/contacts` et l'import HubSpot gardent l'exigence inverse** (opt-in explicite) : leur appelant charge une
liste dont il ne connaît pas chaque ligne. ⚠️ Conséquence à connaître : les contacts venus de HubSpot arrivent
`unknown`, donc hors marketing tant qu'on ne les bascule pas (fiche ou action en masse).

⚠️ **Une promesse d'effacement ne se teste pas avec un faux.** Les tests unitaires à faux store prouvaient que
la route appelle `purgeMany`, jamais que `purgeMany` efface quelque chose : c'est ainsi que les trois pièges
ci-dessus sont partis en production. `tests/integration/purge-rgpd.integration.test.ts` écrit un contact, son
fil, ses messages, son analyse, un parcours et un déclenchement, purge, et RELIT ce qui reste.

## Lot UX 6 clusters (2026-07-28, migration 0049)

- **Mini-CRM : filtres + actions en masse** (`src/crm/contact-store.pg.ts`) : `buildContactWhere` et
  `buildBulkSelector` extraits en **fonctions PURES exportées** (testables sans DB), avec `deleted_at is null`
  TOUJOURS dans le WHERE. Opérateurs de champ étendus (`ContactFieldOp` : eq/contains/not_contains/empty/not_empty)
  + `tagsExclude` (« ne possède pas »), whitelist partagée `CONTACT_FIELD_OPS`/`isContactFieldOp` (miroir du parse
  serveur `parseFilters` et du corps `normalizeContactFilters`). Méthodes ensemblistes `applyEditsMany` (une seule
  clause `tags=` add+remove, MERGE jsonb pour set_field). Cible = ids OU `{filters, excludeIds}`
  (jamais un payload de 100k UUID). Route `POST /tenants/:t/contacts/bulk` (admin-only). ⚠️ `softDeleteMany` et
  `/bulk-delete` ont été RETIRÉS le 2026-08-19 : voir « Une seule destruction » plus bas.
  Migration **0049** : colonne `deleted_at` + index partiel `idx_contacts_active`. ⚠️ Soft-delete propagé à
  `listContactsForBuild`/`listContactsForBuildByIds` (campaign/store.pg.ts) + `findByPhone` ; l'upsert par numéro
  remet `deleted_at=null` (résurrection). Front : `web/lib/contact-filters.ts` (types + `filtersToQuery`, PUR).
- **Scénarios** : `autoLayoutHorizontal` (`web/lib/workflow-layout.ts`, PUR) = disposition en couches gauche->droite
  (relaxation « plus long chemin » bornée à N itérations, sûre sur cycles). Route duplicate `POST /workflows/:id/
  duplicate` au niveau route (réutilise getWorkflow/listWorkflows/createWorkflow/tenantCode) : nom « (copie) »
  unique + **codes de node RE-MINTÉS** (strip `data.code` avant `mintNodeCodes`, sinon conservés = doublons).
  Colonne date via `formatDate` (`web/lib/day.ts`).
- **Contenu > Blocs** : `web/lib/node-search.ts` (`filterNodes<T>`, `normalizeSearch`, PUR) : filtrage client
  cumulable type + texte (haystack : type/summary/workflowName/code, insensible accents/casse). La page charge tous
  les blocs une fois (dataset borné).
- **Flow field mapping** : `web/lib/flow-mapping.ts` (`BASE_SAVE_FIELDS`, `suggestBaseField`, PUR). Cible du champ
  de base « Nom » = **sentinelle `PROFILE_NAME_SAVE_KEY = '@profile_name'`** (impossible à produire par `slugify`,
  qui n'émet que `[a-z0-9_]`) -> `processFlowCompletions` (webhook report) route `@profile_name` vers
  `setProfileNameByPhone` (nouvelle méthode du writer = `PgContactStore`), le reste dans `contacts.fields`. Test
  anti-drift : `PROFILE_NAME_SAVE_KEY` (web) === `PROFILE_NAME_TARGET` (serveur).
- **Guide MBA** : page de CONTENU `web/app/mba/page.tsx` (nav `web/components/AppShell.tsx`, tab `mba`), aucune
  logique. Ton client, zéro mention d'infra. Config live parquée (ToS Meta Business AI + gating vertical).

## Webhooks entrants (2026-08-23, migration 0074)

Un outil tiers poste du JSON sur `POST /w/:code` ; on en extrait des valeurs vers la fiche contact, et on
publie l'événement qui déclenchera le scénario configuré.

### La décision structurante : le webhook POSSÈDE une automation

La tentation était de poser `workflow_id` / `start_node_id` / `cooldown_seconds` sur la table `webhooks`,
comme sur `automations`. On aurait alors DUPLIQUÉ la sémantique du déclenchement à deux endroits, avec deux
jeux de garde-fous à maintenir.

À la place, un webhook qui doit lancer un scénario possède une ligne `automations` de type `webhook`
(`webhooks.automation_id`), et la route publique se contente de publier un événement dans la file
`automation-event`. Le déclenchement passe donc par `runAutomations` et hérite **gratuitement** de ses six
filtres : contact bloqué, correspondance, anti-rebond par contact, condition, plafond horaire, un seul
parcours actif. Zéro logique de déclenchement nouvelle, une seule source de vérité.

Cette ligne compagnon est POSSÉDÉE par son webhook :
- créée, modifiée et supprimée par `PgWebhookStore`, dans une transaction (le lien est un invariant) ;
- **exclue** de `PgAutomationStore.list`, donc invisible dans l'écran Automation (l'y montrer donnerait une
  ligne que l'utilisateur n'a pas créée, et un second endroit pour la modifier, donc une désynchronisation) ;
- **refusée** à la création depuis la route `/automations` (`validateTriggerConfig`), sinon on obtiendrait une
  automation active que son propre écran ne montre pas et qu'aucun webhook ne détient.

⚠️ `trigger_kind` n'a **aucune contrainte CHECK en base** (migration 0052) : ajouter le type `webhook` n'a
demandé AUCUNE migration sur `automations`, exactement comme `hubspot_deal_stage` avant lui.

### La route publique

`POST /w/:code`, montée dans `buildServer` **avant** les gardes d'auth, aux côtés de `/r/:code`. Servie par le
rewrite `/api/backend/:path*` du front, déjà en place : pas de rewrite dédié dans `next.config.mjs`, qui serait
GELÉ au build de l'image web et casserait au premier `up -d` sans `--build`.

1. Forme du code vérifiée AVANT toute requête SQL (26 car. base32).
2. Code inconnu **ou webhook désactivé** rendent le MÊME 404. Secret exigé et absent, faux, ou d'un autre
   webhook rendent le MÊME 401.
3. Plafond de débit par WEBHOOK, pas par IP : l'IP d'un Zapier n'a aucune stabilité.
4. ⚠️ **Le parseur JSON global transforme un corps invalide en `{}` sans lever** (il est écrit pour le webhook
   Meta, où la signature tranche ensuite). On ne peut donc PAS conclure d'un objet vide qu'on a reçu du JSON
   valide : la route relit le `rawBody` pour trancher, et rend 400.
5. Le mapping est appliqué **en itérant sur NOTRE mapping, jamais sur les clés reçues** (même doctrine que
   `web/lib/flow-mapping.ts`) : sinon un tiers écrirait où il veut en nommant ses clés comme nos champs.
6. L'écriture du contact passe par `upsertContactsFromApi`, le chemin PARTAGÉ avec l'API publique et l'import.
7. Le payload est enregistré dans `last_payload` **quoi qu'il arrive** : c'est ce qui alimente l'arbre de
   mapping, et le seul moyen de déboguer « pourquoi rien ne se passe ».

🔴 **Toujours 200 sur un appel bien formé, même si rien n'a été fait.** Un tiers qui reçoit une erreur
réessaie en boucle, et beaucoup désactivent le webhook après quelques échecs. Le détail passe dans le corps :
`{ ok, contact, champs, scenario, raison?, ignores? }`. Toute erreur destinée au tiers sort en **4xx**, jamais
en 5xx (Cloudflare remplace le corps des 5xx par sa page).

### Les chemins JSON, dupliqués des deux côtés

`src/webhook-entrant/chemin.ts` LIT les chemins (`client.tel`, `lignes[0].prix`), `web/lib/chemin-json.ts` les
FABRIQUE depuis l'arbre affiché. Les deux ne partagent aucun paquet (le front a son propre tsconfig), donc la
grammaire est **dupliquée**, comme `lib/signature.ts` l'est avec mm-hubspot. Deux filets :
- un **jeu de chemins d'or identique**, figé dans les tests des deux côtés ;
- la route de configuration **REFUSE** un chemin qu'elle ne sait pas lire, donc une divergence sort en 4xx
  visible au lieu de produire un mapping muet.

Une clé contenant un point ou un crochet est **inadressable** : inventer une syntaxe d'échappement que
personne ne saurait relire dans l'écran serait pire. L'arbre l'affiche mais la signale comme telle.

### Deux refus qu'il faut comprendre

🔴 **Une valeur non scalaire est refusée À LA CONFIGURATION.** Les valeurs de champ sont stockées en chaîne, et
`contactVars` transforme en `null` toute valeur non primitive : un objet écrit dans un champ rendrait la
variable **vide** dans un template, sans la moindre erreur. Le seul moment où l'utilisateur peut comprendre le
problème, c'est quand il configure. La validation se fait contre `last_payload` ; un chemin qui ne résout pas
est en revanche accepté, parce qu'un tiers n'envoie pas toujours ses champs facultatifs.

🔴 **La LONGUEUR est filtrée en amont, le TYPE non.** `upsertContactsFromApi` refuse l'enregistrement ENTIER
dès qu'une valeur est invalide : un téléphone parfaitement bon serait perdu parce qu'un tiers a envoyé une
description de 3000 caractères dans un champ voisin. Ce cas-là n'est pas une erreur de mapping, donc
`valeurTexte` écarte la seule valeur fautive et la RAPPORTE dans `ignores`. Une valeur invalide pour le TYPE
du champ reste, elle, un refus complet avec sa raison : c'est une erreur de configuration, et la faire
disparaître en silence empêcherait l'opérateur de la corriger.

### Dates venues d'un tiers (2026-08-23, aucune migration)

`src/crm/date-iso.ts` normalise vers l'ISO 8601, et sert `validateFieldValue` + `canonicalizeFieldValue`,
donc TOUS les chemins d'écriture d'un champ (webhook, API publique, import CSV, fiche contact, formulaire).

**La règle : on normalise ce qui est NON AMBIGU, on refuse le reste EN LE DISANT.**

| Reçu | Résultat |
|---|---|
| `2026-08-23T15:40:00Z`, `...+02:00`, sans secondes | conservé tel quel |
| `2026-08-23 15:40:00` (espace) | -> `2026-08-23T15:40:00` |
| epoch 10 ou 13 chiffres | -> ISO UTC |
| `2026-08-23` dans un champ `date` | conservé |
| `2026-08-23` dans un champ `datetime` | **refusé** (`sans_heure`) |
| `03/04/2026`, `23/08/2026`, `3.4.26` | **refusé** (`ambigu`) |
| `2026-02-30`, `2026-08-23T25:00` | **refusé** (`illisible`) |

🔴 **Pourquoi refuser plutôt que deviner.** Une date mal devinée ne ressemble pas à un bug, elle ressemble à
une date. Elle ne se voit qu'au moment où un rappel part un mois trop tôt, chez le client. `23/08/2026` serait
déchiffrable (23 ne peut pas être un mois), mais l'accepter pendant qu'on refuse `03/04/2026` rendrait la
MÊME intégration tantôt bonne tantôt cassée selon le jour du mois : on refuse uniformément.

🔴 **Pourquoi ne pas inventer minuit** sur un jour seul. C'était déjà le contrat (« date nue = pas datetime »,
verrouillé par un test antérieur), et ça compte encore plus depuis qu'un déclencheur peut partir « X heures
avant » cette valeur : un rappel réglé sur 2 h avant partirait à 22 h la VEILLE.

⚠️ Une valeur SANS fuseau reste SANS fuseau : c'est une heure murale, interprétée dans le fuseau de l'espace
à l'évaluation. Lui coller un `Z` la décalerait de plusieurs heures, silencieusement.

⚠️ Une première version du motif « ambigu » acceptait 1 à 4 chiffres en tête, si bien que `2026-07-17` y
tombait : toutes les dates ISO auraient été refusées. Attrapé par la suite existante, pas par un test neuf.

Chaque refus remonte jusqu'à l'appelant (`raisonDateLisible`), donc un intégrateur de webhook lit
« il manque l'heure » plutôt que « valeur invalide (datetime) ».

### Sécurité et RGPD

- **Le tenant vient du CODE, jamais du corps.** `/hubspot/deal-stage` accepte un `tenantId` dans son payload :
  tolérable pour un connecteur maison à secret unique, inacceptable pour une URL remise à Zapier.
- Code de 26 caractères base32 (130 bits) : c'est une clé d'accès, pas un identifiant. `newTrackingCode` se
  contente de 60 bits parce qu'il doit tenir dans une URL de bouton WhatsApp ; nous n'avons pas cette contrainte.
- Secret d'en-tête **optionnel** (`X-Webhook-Secret`), stocké haché, comparé en temps constant.
- Le CRUD de gestion est **admin only** (`requireAdmin` + `forbidNonAdmin`).
- `last_payload` : le **dernier seulement**, jamais d'historique. Purge automatique à
  `WEBHOOK_PAYLOAD_RETENTION_DAYS` jours sans appel (balayage du worker, toutes les 6 h) + bouton « oublier ».
- ⚠️ `windowOpen = false` pour un événement webhook : le contact n'a pas forcément écrit, donc le scénario doit
  ouvrir par un template approuvé, sinon la garde de l'exécuteur le refuse.

## Campagne AU FIL DE L'EAU, alimentée par un webhook (2026-08-26, migration 0084)

Une campagne ordinaire fige ses destinataires à la création. Celle-ci n'en a AUCUN au départ : elle reste
ouverte, et chaque contact qui arrive par le webhook désigné devient un destinataire de plus.

### La décision structurante : aucun chemin d'envoi nouveau

L'alimentation INSCRIT un destinataire et enfile un `campaign-run`. C'est `runCampaign` qui envoie, avec sa
cadence, son quality gate, son claim atomique, son journal de conversation et ses statistiques. Un arrivant
part donc exactement comme un destinataire choisi à la main, et aucune règle d'envoi n'existe en double.

Même doctrine pour l'éligibilité : `alimenterCampagnesWebhook` appelle `buildRecipients` TEL QUEL sur UN
contact (opt-in marketing, identité requise, résolution des variables). Rien n'est réécrit, donc rien ne peut
diverger de la voie ordinaire.

### Une colonne, pas un type de campagne

`campaigns.webhook_id is not null` DIT déjà tout : c'est la source, et c'est le drapeau. Un `source text` en
plus décrirait deux fois la même chose, avec le risque classique que les deux divergent.

### Les cinq pièges, et ce qui les tient

1. **Une campagne au fil de l'eau ne se TERMINE pas.** `runCampaign` sort en `running` au lieu de `completed`
   quand `campaign.webhookId` est posé. La marquer terminée la couperait de son webhook (le feed ne nourrit
   que les campagnes `running`) et plus aucun lead ne serait contacté, sans le moindre signal. Le quality gate
   garde le dernier mot : une pause reste une pause.
2. **La route publique ne publiait RIEN sans scénario.** `POST /w/:code` ne publiait l'événement que si
   `automation_id` était posé. `getByCode` rend désormais `alimenteCampagne`, calculé par un `exists` sur les
   campagnes `running` DANS la requête qui a lieu de toute façon. Un compteur sur la table se
   désynchroniserait au premier arrêt ou archivage oublié ; l'état des campagnes, lui, fait foi.
3. **`singletonKey` peut avaler l'enfilement.** Un arrivant pendant un run en vol verrait son job coalescé et
   resterait `pending` jusqu'à l'arrivant SUIVANT, qui peut ne jamais venir. Un balayage de 60 s
   (`listWebhookCampaignsWithPending`) relance les campagnes qui ont vraiment quelqu'un en attente.
4. **Un écart doit s'INSCRIRE.** Un arrivant sans consentement (marketing) ou dont une variable manque est
   enregistré `skipped` AVEC son motif. Sinon l'opérateur voit une campagne à zéro destinataire alors que des
   gens sont bien arrivés. L'écran prévient en amont quand l'adresse choisie n'affirme pas le consentement.
5. **Supprimer l'adresse tuerait la campagne en silence.** La route `DELETE /tenants/:t/webhooks/:id` refuse en
   **409** tant qu'une campagne vivante s'en nourrit, en la NOMMANT (409 et pas 5xx : Cloudflare remplace le
   corps de toute réponse 5xx). La FK reste `on delete set null` pour ne pas emporter l'historique d'une
   campagne terminée.

### Chemin complet

```
POST /w/:code  (route publique, tenant déduit du code)
  -> écriture du contact (chemin partagé upsertContactsFromApi)
  -> publish { kind: 'webhook', waId, webhookId }   si scénario OU campagne au fil de l'eau
        file automation-event
  -> worker : runAutomations(...)                    (scénario, inchangé)
  -> worker : alimenterCampagnesWebhook(...)         (campagnes, isolé dans son propre try)
        listRunningByWebhook -> contactForBuildByWaId -> buildRecipients
        -> insertWebhookRecipient (on conflict do nothing) -> enqueueCampaignRun
  -> job campaign-run -> runCampaign  (envoi réel, cadence, garde-fous)
```

L'alimentation est isolée dans son propre `try` : un souci de campagne ne doit pas faire échouer l'événement,
donc rejouer un scénario DÉJÀ démarré. Une campagne perdue se rattrape au balayage, un scénario démarré deux
fois ne se rattrape pas.

### Anti-doublon

La contrainte `campaign_recipients (campaign_id, contact_id)` fait tout le travail : la même personne qui
repasse par l'adresse ne reçoit pas le message une seconde fois. `insertWebhookRecipient` rend `false` dans ce
cas, et AUCUN run n'est enfilé (sinon la campagne repartirait pour rien à chaque repassage).

### Arrêt

`POST /tenants/:t/campaigns/:id/stop` passe la campagne en `completed` : c'est son seul point final. `completed`
et pas `paused`, parce que la liste propose « Reprendre » sur une campagne en pause, ce qui n'aurait ici aucun
sens (rien ne reste à envoyer). 404 sur une campagne ordinaire ou déjà arrêtée.

## Bloc QUESTION : menu WhatsApp, réponse attendue, et échéance (2026-08-26, migration 0085)

Un bloc qui pose une question au contact, avec un MENU déroulant de réponses (liste interactive WhatsApp) ou
sans menu, et qui ROUTE la réponse. Trois familles de sorties : `row:<i>` par ligne du menu, l'arête LIBRE
(le contact écrit au lieu de choisir), et `timeout` à l'échéance.

### La décision structurante : il attend la réponse ET le temps

C'est le seul bloc du produit dans ce cas, et c'est ce qui a demandé le plus de soin.

Le moteur n'avait que deux repos : `waiting` (une réponse du contact le reprend, via `findWaitingByWaId`) et
`sleeping` (le balayeur le reprend à l'échéance). Ils s'excluent : un run `sleeping` est INVISIBLE de
`advance`, c'est écrit et voulu.

Le bloc Question reste donc **`waiting`** et porte EN PLUS un `resume_at`. Le choix se lit à l'envers : mettre
le run en `sleeping` pour obtenir l'échéance ferait perdre la réponse du contact, ce qui est exactement ce
qu'un bloc Question ne peut pas se permettre.

- `WalkRest` gagne `timeoutInMs` sur la variante `waiting` ; `restToState` le traduit en `resume_at`.
- `claimDueQuestions` (nouveau) réclame les runs `waiting` à échéance due. Migration 0085 : un index partiel
  `(resume_at) where status = 'waiting' and resume_at is not null`, sans quoi un balayage par minute
  scannerait toute la table des runs en attente. AUCUNE colonne neuve, `resume_at` existe depuis 0054.
- `resume(run)` reçoit désormais `status` : `sleeping` reprend au bloc SUIVANT (bloc Attente, inchangé),
  `waiting` sort par la poignée `timeout`. Prendre le successeur enverrait un contact silencieux dans la
  branche du premier câblage venu.

### Réclamation : un BAIL, jamais une consommation

Première version : `resume_at = null` à la réclamation, pour qu'une expiration ne soit prise qu'une fois.
Elle garantissait surtout de la PERDRE définitivement au premier refus de Meta ou redéploiement du worker :
le run restait `waiting` sans échéance, le fil tenu par un parcours mort, et `closeStaleSleeping` ne le voit
pas (il ne regarde que les dormants).

C'est donc le MÊME bail que `claimDueSleeping` (`resume_at = now() + 15 minutes`). Ce qui efface l'échéance
pour de bon, c'est la reprise elle-même : toutes les sorties de `resume` passent par `setState`, qui écrit
`resume_at` SANS coalesce. Différence assumée avec le sommeil : le run reste joignable par une réponse
pendant la reprise, parce qu'avaler une réponse de client serait pire qu'un doublon.

### L'index d'une ligne EST sa sortie

`row:<i>` suit la ligne AFFICHÉE dans l'éditeur. Trois conséquences, chacune apprise à ses dépens ailleurs :

1. `sendList` filtre les libellés vides **après** numérotation (miroir exact de `sendInteractive` pour
   `btn:<i>`). Filtrer avant renuméroterait, et le contact partirait dans la mauvaise branche.
2. Supprimer une ligne depuis le panneau passe par un événement `wf-row-delete` que le BUILDER traite :
   il retire l'arête de la ligne et **décale les `row:<j>` suivants**. Le panneau seul ne voit pas les arêtes ;
   renuméroter les données sans elles repointait silencieusement des branches déjà reliées.
3. Une ligne au libellé vide n'expose AUCUNE poignée : elle n'est jamais envoyée, la relier promettrait une
   branche que le contact ne peut pas prendre.

### Ce qu'il fallait toucher ailleurs, et pourquoi

- **Canal.** Une question réussie ramène le parcours sur WhatsApp, comme un template ou un formulaire. La
  liste interactive n'existe QUE sur WhatsApp : sans cette bascule, un run venu d'un bloc RCS restait marqué
  `rcs`, et la garde d'étanchéité de `advance` JETAIT la réponse WhatsApp du contact.
- **Fenêtre de 24 h.** C'est un message de session : `besoinsFenetre` (reprise), la garde de `runFrom`
  (ouverture à froid) et `exigeFenetre24h` (API publique `/v1/sends`) le connaissent tous les trois.
- **Variables `{{champ}}`.** Le panneau offre le composant d'insertion partagé, donc `wiring.sendQuestion` les
  RÉSOUT (corps, libellés et descriptions) avant l'envoi. La fiche n'est lue que si le texte en porte. Sans
  ça, l'éditeur promettait une substitution que personne ne faisait et le contact lisait `{{prenom}}`.
- **Bouton mort.** `row:` rejoint `btn:|card:` dans la règle d'escalade : une ligne tapée qui ne mène nulle
  part remonte la conversation à un humain, au lieu de rendre la main en silence.
- **Analytics.** `timeout` est exclu des choix (personne ne CLIQUE une absence de réponse), les lignes
  portent leur libellé et non `row:0`, et chaque bloc porte SA question comme titre.
- **Ouverture de campagne.** `scanOpening` le compte comme `sessionOpen`, et une question NON configurée est
  un PASSE-PLAT (dans `walk` comme dans les deux miroirs d'analyse) : figer un parcours sur une question
  jamais posée serait invisible, le laisser continuer se voit.

## Automation : déclencher un scénario sur un événement (Lots E / E.2, 2026-08-03, migrations 0052-0053)

**Modèle.** Table `automations` (tenant, nom, `enabled`, `trigger_kind`, `trigger_config` jsonb,
`condition_group` jsonb réutilisant le ConditionGroup du bloc « Si », scénario cible, bloc de départ
optionnel, `cooldown_seconds`) + `automation_fires` (une ligne par couple automation/contact, écrasée à chaque
tir) qui sert à la fois l'anti-rebond et le plafond horaire.

**Découpage.** `automation/match.ts` est PUR (correspondance déclencheur/événement, anti-rebond) donc testable
sans base. `automation/runner.ts` compose les filtres avec l'IO injectée. `automation/store.pg.ts` est le seul
à toucher Postgres. Le runner réutilise `WorkflowExecutor` tel quel, il hérite donc de ses gardes.

**Les filtres, dans l'ordre (du moins cher au plus cher).** Correspondance pure (aucune requête) → anti-rebond
par contact → plafond horaire par automation → `conditionGroup` (contexte contact chargé une seule fois, et
seulement s'il sert) → un seul parcours actif par contact → gardes de l'exécuteur (fil détenu, fenêtre 24 h).

**Deux voies d'entrée.** Les événements issus d'un message entrant sont traités DANS le job webhook
(`webhooks/triggers.ts`, isolé comme ses voisins pour ne jamais mettre le job partagé en échec). Les autres
passent par la file `automation-event` : l'API pose un tag mais ne sait pas démarrer un scénario, c'est le
worker qui tient l'exécuteur. L'analyse de conversation, elle, émet en direct depuis le worker.

**Fenêtre de service.** Un déclencheur issu d'un message PROUVE que la fenêtre est ouverte : le scénario peut
alors ouvrir par un message de session. Un déclencheur à froid (tag, analyse) ne la prouve pas et garde la
protection : le scénario doit ouvrir par un template.

**Priorité du jeton de test.** `webhooks/test-token.ts` s'exécute AVANT l'avance de scénario et les
automations, et signale les messages qu'il a consommés pour qu'un seul message ne déclenche jamais deux choses.

**Ce qui borne les envois** : anti-rebond par contact (1 h par défaut), plafond par automation (200/h), un seul
parcours actif par contact, et l'émission gouvernée par le chemin (les campagnes n'émettent pas). Voir
`CLAUDE.md` pour les règles à ne pas casser.

**Déclencheur `hubspot_deal_stage` (2026-08-16, déployé).** Le connecteur mm-hubspot reçoit le webhook
`deal.propertyChange` de HubSpot, remonte deal -> contact -> téléphone, et pousse vers mba sur
`POST /hubspot/deal-stage` (signature v1 partagée). mba fait correspondre l'étape à une automation. La
correspondance porte sur l'IDENTIFIANT d'étape, jamais sur le libellé (un renommage côté HubSpot casserait
sinon l'automation en silence) ; le libellé n'est stocké que pour l'affichage. Le pipeline ne restreint que si
les DEUX côtés le portent : le webhook ne transporte pas le pipeline, et une étape appartient déjà à un seul
pipeline chez HubSpot.

`GET /tenants/:t/hubspot/deal-stages` (admin) rend les pipelines du portail avec les libellés de leurs étapes,
via le canal service signé (`POST /service/deal-stages` côté connecteur). Volontairement NON gardée par le
réglage « Campagnes via données HubSpot », qui gouverne l'import de contacts, un tout autre pouvoir. Portail
non lié -> `200 {connected:false}` ; une panne reste un 500. L'écran Automation la consomme dans un menu groupé
par pipeline, chargé PARESSEUSEMENT (à la sélection du déclencheur, une seule fois). ⚠️ Le garde-fou « déjà
demandé » y est une `useRef` et NON l'état de chargement : mettre ce dernier dans les dépendances de l'effet
le relançait, son nettoyage annulait la requête en vol, et l'écran restait figé sur « Lecture des étapes… ».
Trouvé par le test de bout en bout, invisible à la lecture.

## Visuels d'un template à l'envoi (en-tête média et cartes de carousel, 2026-08-17)

**La règle Meta.** Un template approuvé avec un en-tête IMAGE / VIDEO / DOCUMENT, ou avec un carousel, EXIGE son
média à CHAQUE envoi. Le visuel déposé à la création ne sert qu'à la validation. Sans lui : refus `132012` sur
TOUS les destinataires.

**D'où vient le visuel.** Du template lui-même (`example.header_handle[0]`, relu chez Meta), pas d'un champ
saisi. Donc aucune migration, aucun écran, aucune donnée par campagne, et ça marche sur les templates existants.

🔴 **Pourquoi un `media id` et jamais un `link`.** Mesuré le 2026-08-15 : envoyer l'URL du CDN de Meta est
ACCEPTÉ (200 + id de message) puis échoue 2 s plus tard en `131053`, son téléchargeur se prenant un 403 sur son
propre CDN. L'URL est pourtant lisible depuis n'importe où ailleurs, ce qui rend le piège invisible à une sonde
qui se contente de la lire. On re-téléverse donc le visuel sur le numéro d'envoi et on envoie son identifiant.
Vérifié en réel le 2026-08-17 : les deux destinataires de la campagne « Test Napo » sont passés en `delivered`,
sans erreur de livraison différée.

**Les briques, et il n'y en a qu'une de chaque.** `meta/template-media.ts` (`TemplateMediaPreparer`) prépare les
visuels, pour les cartes comme pour l'en-tête : `prepareOne` pour une URL, `prepare` pour un lot de cartes.
⚠️ La clé de son cache porte le NUMÉRO d'envoi, pas seulement l'URL : un `media id` est scopé au numéro qui l'a
téléversé, et un numéro reconnecté dans les 7 jours réutiliserait sinon l'identifiant de l'ancien. Le numéro est
résolu une fois par lot, pas une fois par carte. `meta/template-components.ts` reste le SEUL constructeur de
composants (`headerMediaId` prioritaire sur `headerMediaUrl`, `headerMediaSendBlocker` pour le refus lisible).

🔴 **Le piège de câblage, vécu DEUX fois.** `sendTemplate` (`workflow/wiring.ts`) a deux branches : variables
déjà résolues (campagne scénario) et résolution par hints (réponse webhook). Le carousel n'avait été branché que
sur l'une (incident du 2026-08-15), puis l'en-tête média a répété l'erreur sur l'autre (rattrapé en revue le
2026-08-17, avant déploiement). Les deux branches partagent désormais UN helper unique, `visuelsPourEnvoi` : la
divergence n'est plus possible. Ne pas la réintroduire en « optimisant » une branche.

**Le refus est AVANT la boucle** (`campaign/engine.ts`) : visuel impossible à préparer -> aucun destinataire ne
part, tous en `failed` avec la raison, campagne `completed`. Y passer dans la boucle ferait voir 100 % d'échecs
au quality gate, qui mettrait la campagne en pause avec un diagnostic trompeur.

**L'inbox reste en `link`** : le visuel y est une URL saisie par l'opérateur, elle se télécharge normalement.

## Capture automatique de l'OTP d'embarquement (Zadarma, 2026-08-16, précâblage)

**Le problème.** Pour embarquer son numéro WhatsApp, le client doit fournir un numéro puis saisir un code que
Meta lui dicte. On veut fournir le numéro ET capter le code. La popup d'Embedded Signup est un iframe d'un
autre domaine : la remplir automatiquement est IMPOSSIBLE. On ne la pilote donc pas, on la contourne, en
ajoutant et vérifiant le numéro par API (`MetaPhoneRegisterClient` : `phone_numbers` -> `request_code` en
VOICE et en français -> `verify_code`). L'activation Cloud API (`/register` + PIN) n'est PAS dupliquée ici,
elle vit dans `MetaEmbeddedSignupClient.register`.

**Les modules** (`src/zadarma/`, inertes tant que `ZADARMA_API_KEY`/`SECRET` sont vides ; la config refuse au
démarrage qu'une seule des deux moitiés soit posée) : `client.ts` (signature + transport), `api.ts` (numéros,
appels entrants, transcription), `otp-extract.ts` (le code depuis la transcription), `otp-capture.ts`
(orchestration). Tous testables sans réseau : l'IO est injectée.

**Partis pris à ne pas défaire.** `otp-extract` comprend le français PARLÉ (« douze trente-quatre
cinquante-six » = 123456), parce qu'un moteur français regroupe spontanément les chiffres par deux ; le
réduire aux chiffres écrits n'attraperait qu'un cas sur trois. Il applique l'unanimité ou rien : deux codes
différents dans la transcription rendent `null`, car Meta plafonne à 10 tentatives par numéro sur 72 h et un
code deviné en brûle une. `otp-capture` identifie l'appel par DIFFÉRENCE avec un instantané pris avant de
déclencher, jamais par l'heure (le fuseau du compte Zadarma n'est pas garanti), absorbe les erreurs passagères
(la tentative Meta est déjà consommée, la boucle EST le rejeu) et rend une cause distincte par maillon.

**Verdict d'architecture (sondage du 2026-08-16).** Le ROUTAGE est pilotable par API :
`PUT /v1/direct_numbers/set_sip_id/` accepte une adresse SIP EXTERNE, donc un client se provisionne en un
appel, sans clic. Le DÉCROCHÉ, non : Zadarma n'expose aucune commande « décroche », la machine qui répond doit
donc être à nous (ou son répondeur, dont on n'a pas confirmé qu'il produise un enregistrement exploitable).
⚠️ L'appel de Meta arrive quasi immédiatement après `request_code` : le routage doit être armé AVANT.

**Gotchas Zadarma mesurés en direct** (détail et suite dans le §Journal des lots livrés, plus bas) : signature = base64 du HMAC-SHA1
HEXADÉCIMAL (56 caractères) ; en écriture les paramètres vont dans le CORPS, URL nue. Les deux erreurs
produisent le même « 401 Not authorized » qui fait accuser des clés pourtant bonnes.

## Filtrage des clics automatiques (2026-08-21)

`src/links/clic-automatique.ts` décide si un appel sur `/r/:code` COMPTE. Il ne décide jamais de la
redirection, qui reste inconditionnelle : un lien déjà livré doit fonctionner pour tout le monde.

🔴 **Chaque marqueur d'agent porte son délimiteur** (`googlebot`, `curl/`, `okhttp/`, `java/`). Un marqueur
nu testé en sous-chaîne libre attrape de vrais appareils : « bot » seul écarte tous les téléphones **CUBOT**,
une marque Android vendue en Europe dont le modèle figure dans le user-agent. Le faux positif est le défaut
le plus grave ici, parce qu'il efface le clic d'un vrai client en silence et sans recours ; laisser passer un
robot exotique se voit et se corrige.

Un user-agent ABSENT ne disqualifie pas, pour la même raison. Trois signaux écartent : agent déclaré robot,
référent `*.facebook.com`, paramètre `fbclid`. Les deux derniers visent la revue de template, pendant
laquelle des humains de chez Meta ouvrent le bouton depuis Facebook avec un navigateur ordinaire.

## Pièges d'écriture des requêtes SQL

🔴 **Jamais de `backtick` dans un commentaire SQL.** Nos requetes vivent dans des gabarits JS delimites par
des backticks : un seul dans un commentaire `--` FERME la chaine, et tsc rend une cascade d erreurs de syntaxe
qui ne pointent pas sur la vraie ligne. Vu deux fois le 2026-08-21. Ecrire le mot sans le citer.

🔴 **Un `count` d agregat SANS `group by` rend TOUJOURS une ligne**, meme quand aucune ligne n entre. Une
requete censee distinguer « rien a mesurer » (aucune ligne) de « zero » rend donc zero dans les deux cas, et
l ecran affiche une etape qui ment. Ajouter un `group by` sur une colonne de la source : zero ligne en entree
donne alors zero ligne en sortie. C est exactement ce qui distingue `urlClicks: null` de `urlClicks: 0` dans
le funnel par campagne.

## Modules partagés (audit anti-slop du 2026-08-18)

Points de passage OBLIGÉS. Chacun existe parce que la même chose était écrite plusieurs fois et avait commencé
à diverger : le rapport complet est dans `AUDIT-ANTI-SLOP-2026-08-18.md`. Avant d'écrire un helper, chercher ici.

**Backend**

| Module | Ce qu'il porte | Ce qu'il remplaçait |
|---|---|---|
| `src/http/scope.ts` | `scopeTenant` (contrôle d'accès tenant) et `nonEmpty` | 22 et 12 copies dans `src/http/` |
| `src/crm/contact-store.pg.ts` -> `MATCH_BY_WAID_SQL` | Résolution d'un contact par `wa_id` (E.164 exact, chiffres nus, BSUID) | 9 copies + 1 dans `inbox/store.pg` |
| `src/stats/range.ts` -> `BOUNDS_CTE` | CTE des bornes de date, robuste au changement d'heure | 9 copies dans les 2 stores de stats |
| `src/campaign/store.pg.ts` -> `insertCampaignRow`, `summarySelect()`, `RECIPIENT_FAILED_SQL` | L'INSERT d'une campagne, la projection des résumés, la définition d'un échec | 2 INSERT, 2 projections |
| `src/crm/contact-filters.ts` | Règles de filtrage des contacts (bornes, opérateurs, plafonds) | query params et corps JSON, alignés à la main |
| `src/webhooks/json.ts` | `asArray`, `asRecord` (lecture défensive d'un payload Meta) | 3 copies. ⚠️ `str` reste LOCAL (null vs undefined selon le lecteur) |
| `src/crm/identity.ts` -> `waIdOfTarget` | La règle wa_id pour une cible d'envoi | redérivée dans le moteur de campagne |
| `src/account/types.ts` | Types de persistance du compte | ils vivaient dans la couche HTTP, que le store importait |
| `src/agent/llm/tool-schema.ts` -> `paramsOutil` | 🔴 La lecture de `agent_tools.params` et la séparation des sources (`modele` vs `contact`/`fixe`). Source UNIQUE : l'exposition au modèle, la validation des arguments et l'injection du runtime en dérivent toutes | posé en tâche 16. Deux lectures divergentes rendraient la cible au modèle, donc un IDOR. Les résolveurs `http` et `mcp` doivent l'importer, jamais relire `params` |
| `src/lib/page-distante.ts` | 🔴 `urlRecuperable` (garde SSRF) et `fetchUrlBorne` (redirections revalidées saut par saut, plafond de taille vérifié APRÈS lecture). Deux surfaces font lire au serveur une adresse SAISIE PAR UN CLIENT (import de FAQ de l'agent Meta, import de connaissance d'un agent IA), et le serveur voit l'admin NPM, les autres conteneurs et le service de métadonnées du VPS | vivait dans `src/http/mba.ts` ; une seconde copie qui divergerait ouvrirait un lecteur de l'intérieur du réseau au premier oubli |
| `src/http/scope.ts` -> `estUuid` | La forme d'un identifiant de chemin. Une valeur mal formée ne rend pas zéro ligne dans un `where` sur une colonne `uuid` : elle fait LEVER Postgres (22P02), donc un 500 dont Cloudflare remplace le corps | posé en tâche 19b, sur les routes d'agents et de connaissance |
| `src/agent/fiche.ts` -> `ficheAgentSchema` / `fichePatchSchema` | 🔴 Les DEUX schémas de la fiche, construits sur des champs communs. Le premier LIT (défauts appliqués), le second PATCHE (optionnel SANS défaut) | posé en tâche 19d. `ficheAgentSchema.partial()` NE rend PAS un objet partiel : le `.default()` survit au `.partial()`, la fusion jsonb n'a alors plus aucune clé absente à protéger, et enregistrer l'objectif efface le ton et toutes les règles d'arrêt. Un patch de fiche importe TOUJOURS `fichePatchSchema` |
| `src/agent/setup/proposition.ts` | 🔴 Ce que l'IA de construction a le DROIT de proposer, et le diff. Frontière de sécurité : la fiche et les mots des outils, jamais la mention légale d'IA, les plafonds, le modèle, le risque d'un outil ni son activation | posé en tâche 19d. L'assistant lit du contenu tiers (le site du client) : ce qu'il peut écrire est énuméré là et nulle part ailleurs |
| `src/agent/poser-tag.ts` | 🔴 Les TROIS effets de « poser un tag » depuis un agent : le contact, le référentiel Tags, et la file d'automations, cette dernière SEULEMENT si le tag était nouveau | posé en tâche 20, après que l'outil eut menti : il posait le tag et s'arrêtait là, alors que sa description promet au client de pouvoir déclencher une automation |
| `src/agent/contexte.ts` -> `lireContexteAgent` | Ce que le cerveau doit savoir d'un agent (fiche, règles d'arrêt, outils actifs, politique de contact inconnu) | posé en tâche 20. Le tour de production et le bac à sable de la console le construisaient chacun le leur : un champ ajouté d'un seul côté ferait diverger ce que le modèle voit selon qu'on teste ou qu'on est en production |
| `src/agent/brain.gateway.ts` -> `penserTrace` | 🔴 LA boucle de raisonnement d'un agent : appel du modèle, exécution des outils, arrêt. Elle est l'APPELANT d'`executeTool`, et porte les trois responsabilités que sa JSDoc lui assignait (alerte sur `fatal`, plafonds recalculés À CHAQUE appel, résultat encadré en bloc délimité) | posée en tâche 19e, ferme la dette D3. Le bac à sable et le futur tour de production partagent cette boucle : un bac à sable qui n'exercerait pas le vrai chemin ne testerait rien |
| `src/agent/prompt.ts` | 🔴 Le prompt système d'un agent (mention légale d'IA EN TÊTE, jamais absente) et `blocResultatOutil`, qui encadre ce qu'un outil rend avant de le remettre au modèle | posé en tâche 19e. Un résultat d'outil concaténé au prompt est une injection indirecte : le contenu vient d'une base de connaissance qu'un site tiers a remplie |
| `src/agent/outils-maison.ts` | 🔴 Le CATALOGUE des outils maison (handler, mots, paramètres, risque) et `outilExpose`, qui construit ce que le modèle voit. C'est ici, et nulle part ailleurs, que l'énumération du paramètre `sortie` de `terminer` est posée, DÉRIVÉE de `agents.fiche.sorties` | posé en tâche 19c. La console ne peut pas inventer un `handler` (l'outil serait actif et refuserait à chaque appel), et recopier les codes de sortie dans `agent_tools.params` créerait une seconde vérité qui divergerait au premier ajout de règle |
| `src/agent/http-cible.ts` -> `construireCible` | 🔴 L'URL FINALE d'un appel de connecteur (lot L2), et le risque qu'une méthode porte. Quatre gardes : adresse de base publique et HTTPS, valeurs de paramètres ENCODÉES, cible qui reste SOUS l'adresse de base (segment par segment), paramètre manquant = refus. Le serveur vit dans le réseau Docker du VPS : une adresse mal contrôlée fait d'un connecteur un lecteur de l'intérieur, et une valeur mal encodée fait d'un gabarit un IDOR | posé en tâche L2-3. La MÊME fonction sert la validation À L'ÉCRITURE d'une source (`src/http/agent-sources.ts`) : deux définitions de « adresse acceptable » finiraient par accepter à l'écriture ce que l'appel refuse |
| `src/agent/champs-contact.ts` -> `CHAMPS_CONTACT_AUTORISES` | 🔴 Les seuls champs du contact dont un paramètre d'outil peut dériver. Liste FERMÉE : la projection du contact peut s'élargir, la surface offerte à un connecteur ne doit pas suivre toute seule | posé en tâche L2-4bis. `wa_id` y est mais ne vient PAS de la projection (qui ne le porte pas, exprès) : il vient du contexte du TOUR, authentifié par la signature du webhook Meta |
| `src/agent/devise.ts` -> `microEurosDepuisDollars` / `eurosDepuisMicro` | 🔴 La conversion du coût d'un appel de modèle, en UN endroit. Le Gateway facture en DOLLARS, tous nos compteurs et tous nos plafonds sont en micro-euros. Le taux est un paramètre COMMERCIAL (`EUR_PER_USD`), pas un cours | posé en tâche 21, ferme la dette D1. Un taux absent ou aberrant retombe sur 1, JAMAIS sur zéro : un zéro rendrait toute consommation gratuite, donc désarmerait tous les plafonds en silence. `web/lib/agent-solde.ts` en porte le miroir d'affichage, dont `tests/agent-devise.test.ts` ancre la parité |
| `src/agent/brain.ts` -> `TourInterrompu` | 🔴 Le contrat « un cerveau qui lève APRÈS avoir dépensé porte sa consommation dans l'erreur ». Ses deux appelants (le tour de production, le bac à sable) l'enregistrent avant de traiter l'échec | posé en tâche 21. Un tour fait plusieurs allers-retours facturés séparément : le cumul vivait DANS la boucle, donc une exception au deuxième appel emportait ce que le premier avait déjà coûté. **Un compteur de dépense ne vit jamais dans la portée qui peut lever** |
| `src/workflow/executor.ts` -> `runEnAttenteSur` | « Le run en attente d'un contact ET le bloc qui l'attend, s'il est du type demandé » | 3 copies (reprises RCS, sortie d'agent, outil d'agent) |
| `src/lib/cache-court.ts` -> `cacheCourt` | Le micro-cache mémoire à durée de vie courte : durée de vie ET mutualisation des appels EN VOL, plus la garde d'identité qui empêche une valeur périmée de se ranger en cache après une invalidation. Posé en R7 pour les compteurs de l'inbox | posé le 2026-08-31. Un cache de compteur écrit à la main oublie l'un des trois, et devient le bug qu'il évitait |
| `src/crm/import.ts` -> `ContactStore.upsertManyByPhone` | L'écriture d'un LOT de contacts (import CSV, listes HubSpot). L'upsert unitaire n'est plus le chemin d'import : une requête par ligne dépassait le timeout de Cloudflare | posé en R9. La déduplication du lot est DANS le store, pas chez l'appelant : c'est Postgres qui l'exige |

**Front**

| Module | Ce qu'il porte |
|---|---|
| `web/lib/ui.ts` | `inputCls` et `inputClsAuto` (sans `w-full`). Une variante s'écrit `${inputCls} py-1.5`, ne se recopie pas |
| `web/lib/normalize.ts` | `normalizeText` (minuscules, sans accents, espaces resserrés) |
| `web/lib/fields.ts` | `fieldValue` (champ perso, casse insensible) et `varCountOf` (variables `{{n}}` distinctes) |
| `web/components/Toggle.tsx` | L'interrupteur on/off de l'Accueil |
| `web/lib/poll.ts` | `repeterAvecGigue` : la répétition périodique DÉSYNCHRONISÉE (±20 %). Tout nouveau polling passe par là, jamais par `setInterval` : sinon les onglets d'un même client rebattent ensemble |
| `web/lib/csv.ts` -> `teteCsv` | La TÊTE d'un fichier envoyée à l'aperçu d'import (coupée sur une fin de ligne). Un aperçu qui transmet le fichier entier fait tomber le mur du volume au choix du fichier |
| `web/components/PhoneFrame.tsx` | Le chrome « fenêtre WhatsApp » des aperçus |
| `web/components/CampaignCreateForm.tsx` | L'assistant de création de campagne (extrait de la page, qui passait de 1637 à 486 lignes) |
| `web/lib/workflow-sorties.ts` | 🔴 La SORTIE LIBRE d'un bloc (« toute autre réponse ») : nommée `libre` dans le canevas, et RIEN dans le graphe enregistré (contrat du moteur, `nextNodeSansHandle`). Traduction aux deux bords, plus `uneAreteParSortie`. Sans nom de poignée, React Flow ancrait cette flèche sur la PREMIÈRE sortie du bloc : elle se dessinait sur la ligne de la première réponse rapide, où une autre flèche part déjà (mesuré le 2026-08-28). Un patch d'arête du canevas passe TOUJOURS par ces deux fonctions |

⚠️ **Un composant React se déclare au niveau MODULE, jamais dans le corps d'un autre composant.** Sa fonction
change alors d'identité à chaque rendu, donc React démonte et remonte le sous-arbre : une modale ouverte perd
son état. Vu en prod sur le panneau « lancer un scénario » de l'inbox, où l'arrivée d'un message effaçait la
sélection en cours (corrigé le 2026-08-18, test E2E `inbox-envoi-scenario.spec.ts`).

⚠️ **Deux styles de fin de ligne cohabitent dans ce repo** (LF et CRLF selon les fichiers). Un script de
refactor par expression régulière qui n'attend que `
` rate silencieusement les fichiers CRLF : toujours
`
?
`, et vérifier le compte de remplacements.

## Le connecteur API d'un client (lot L2, livré le 2026-08-28)

Une **source** (`agent_tool_sources`, migration 0088) porte l'adresse de base du système d'un client, son mode
d'authentification et son secret chiffré. Elle appartient au **workspace** (`tenant_id`, jamais `agent_id`) et
se déclare dans **Tools > Connecteurs API** (`/connecteurs`) : plusieurs agents tapent dans la même
bibliothèque. La placer dans un agent ferait croire qu'elle lui appartient, et on la supprimerait en cassant
les autres ; l'écran affiche donc combien d'agents s'en servent. Un **outil de connecteur** (`agent_tools` avec `origin = 'http'` et
`source_id`) est un gabarit de chemin sur cette source. Le résolveur `http` fait l'appel ; tout le reste (la
validation des arguments, l'injection des paramètres non confiés au modèle, le budget de temps, le journal, la
troncature) reste le tronc commun, exactement comme pour un outil maison.

🔴 **Quatre gardes, et chacune répond à une façon précise de perdre.**

1. **Le modèle ne choisit jamais une cible.** L'adresse est figée sur la source, le gabarit est écrit par un
   administrateur, et `construireCible` vérifie que l'URL finale reste SOUS l'adresse de base, segment par
   segment, après encodage des valeurs. Une valeur contenant `/` ou `..` ne change donc pas de chemin.
2. **Le `wa_id` vient du TOUR, pas de la projection du contact.** C'est ce qui permet de brancher une API par
   contact (« où en est MA commande ») sans que le modèle puisse désigner quelqu'un d'autre. La projection est
   bornée exprès et ne porte pas le numéro : elle part chez le fournisseur de modèle.
3. **Le risque est DÉRIVÉ de la méthode HTTP** (`GET` -> read, `POST`/`PUT`/`PATCH` -> write, `DELETE` ->
   irréversible) et ne peut être que MONTÉ. Un client qui déclarerait `read` un `DELETE` désarmerait la garde
   d'autonomie sur une action irréversible.
4. **Le filtre de sortie est obligatoire.** La réponse appartient au client et part chez le fournisseur de
   modèle : `outputPaths` dit ce que l'agent a le droit de lire, et rien d'autre ne traverse. Sur un outil
   maison, c'est nous qui écrivons la réponse ; ici, non.

⚠️ **CE QUE LA GARDE D'ADRESSE NE COUVRE PAS : le DNS rebinding.** `urlRecuperable` valide le NOM D'HÔTE, pas
l'adresse IP finalement résolue. Un administrateur de tenant peut donc déclarer un domaine à lui, passer la
validation à l'écriture, puis repointer son DNS vers `172.18.0.1` ou `169.254.169.254` : l'appel suivant
résoudrait la nouvelle adresse. La différence avec le scraper de connaissance, qui porte le même trou, est la
CONSÉQUENCE : ici la réponse peut repartir vers un contact WhatsApp par `outputPaths`. Le pare-feu de l'hôte
ne protège pas ce chemin (le trafic reste dans le réseau Docker, il ne traverse jamais `ens3`). La fermeture
demande de revalider l'IP résolue juste avant l'appel (dispatcher undici) : c'est dans `todo.md`, et c'est un
risque d'ADMINISTRATEUR, pas de contact.

⚠️ **`redirect: 'error'`, contrairement au scraper de connaissance.** Une page publique redirige légitimement,
une API de connecteur non : suivre la redirection rouvrirait la porte que la garde d'URL vient de fermer, le
premier saut étant validé et le second pas.

⚠️ **Le bac à sable SIMULE un connecteur.** Un essai depuis la console ne doit pas taper sur le système de
production d'un client, même en lecture : il consommerait son quota, apparaîtrait dans ses journaux, et un
connecteur mal déclaré (un `DELETE` là où le client voulait un `GET`) ferait un dégât réel pendant qu'on croit
essayer.

⚠️ **L'assistant de construction peut réécrire les MOTS d'un connecteur, jamais en créer un.** Déclarer une
source, c'est écrire une adresse réseau et un secret : cela reste un geste d'administrateur, et le serveur
filtre les noms inconnus avant même que la proposition n'atteigne l'écran.

## Banc de tool calling : le choix des deux modèles de l'agent (mesuré le 2026-08-28)

🔴 **DEUX MÉTIERS, DEUX MODÈLES, et les confondre coûte cher.** L'assistant de CONSTRUCTION tourne rarement
(réglage d'un agent) et fait le travail le plus dur : une sortie structurée imbriquée (objet + tableau d'objets
+ enum), en français, en appel d'outil FORCÉ. Le modèle d'un AGENT tourne à CHAQUE message d'un contact : il
lui faut un appel d'outil fiable en boucle, la reprise fidèle de ce que l'outil a rendu, et le prix au tour.

Banc joué contre le Gateway avec **notre propre schéma** (`SCHEMA_PROPOSITION` pour la construction, la vraie
boucle `chercher_connaissance` -> résultat d'outil -> réponse pour le runtime), 5 répétitions par modèle sur le
runtime, 4 sur la construction.

| Modèle | Construction (conforme) | Boucle d'outil | Reprend le fait | N'invente rien sans source | $/tour | ms |
|---|---|---|---|---|---|---|
| `zai/glm-4.7` | **4/4**, avec sorties ET outils | - | - | 0,00097 | 2865 |
| `deepseek/deepseek-v4-pro` | 4/4, jamais d'outil proposé | 5/5 | 5/5 | 5/5 | 0,000425 | 4563 |
| `zai/glm-4.7-flash` | 0/1 (aucune sortie) | **5/5** | **5/5** | **5/5** | **0,000084** | **2177** |
| `alibaba/qwen3.7-flash` | 1/4 | 5/5 | 5/5 | 5/5 | 0,000104 | 4477 |
| `deepseek/deepseek-v4-flash` | 2/4 | 5/5 | 5/5 | 5/5 | 0,000161 | 3409 |
| `minimax/minimax-m3` | 4/4 | 5/5 | **4/5** | 5/5 | 0,000283 | 2620 |
| `moonshotai/kimi-k2.5` | 0/1 (aucune sortie) | 5/5 | **3/5** | 5/5 | 0,000697 | 4834 |

**Retenu : `zai/glm-4.7` pour la construction, `zai/glm-4.7-flash` pour le runtime.** Le second est le moins
cher ET le plus rapide du banc, sans une seule faute sur 15 épreuves. Les deux modes d'échec qui écartent les
autres sont exactement ceux qui abîment une conversation client : **kimi-k2.5 perd le fait qu'il vient de lire
2 fois sur 5** (une fois en rendant un texte VIDE), et **minimax-m3 répond « je ne trouve pas les horaires »
alors que l'outil venait de les lui rendre**. Un modèle qui contredit sa propre source est pire qu'un modèle
lent.

⚠️ **Ce banc se rejoue.** Le catalogue du Gateway bouge toutes les semaines, et un modèle qu'on ajoute doit
passer ces deux épreuves AVANT d'entrer dans le catalogue de la console. C'est le « banc » annoncé au §
« Ce qui reste ouvert » du document produit.

## Agent IA (migrations 0086 à 0088)

Un **agent** est un bloc de scénario qui tient une conversation seul, avec des outils, jusqu'à une SORTIE
nommée qui rend la main au parcours. Il n'a rien à voir avec le rôle utilisateur « agent », ni avec le
Meta Business Agent (`src/mba/`), qui est un produit de Meta.

### Le schéma (0086)

- `agents` : la **fiche** (`fiche jsonb` : objectif, nom, ton, personnalité, règles de transfert et d'arrêt,
  écrite par l'IA de construction et validée par `ficheAgentSchema`) et, HORS du jsonb parce qu'aucune IA ne
  doit y toucher : `mention_ia` (la mention légale), `max_tours`, `max_appels_outils`, `budget_micro_eur`,
  `inactivite_minutes`, `contact_inconnu` (`aucun_outil` | `lecture_seule` | `tous`), `modele`, `status`
  (draft | active | disabled). Unique sur `(tenant_id, lower(label))`.
- `agent_tools` : le catalogue par agent. `origin` ∈ `mba` (outil maison) | `http` (connecteur) | `mcp`
  (déclaré, non servi). `name` contraint au charset commun OpenAI/Gemini, `params jsonb`, `output_paths`,
  `risk` ∈ read | write | irreversible, `timeout_ms`, `max_bytes`.
  🔴 **Deux CHECK portent le consentement humain EN BASE** : `actif = false or active_par is not null`, et
  `autonome = false or autonome_par is not null`. La spec MCP exige un consentement humain avant invocation ;
  notre agent n'a aucun humain au runtime, donc le consentement est déplacé du runtime vers la CONFIGURATION,
  et rendu incontournable par la base plutôt que par une convention.
- `agent_sessions` : l'état multi-tours d'une conversation (`transcript jsonb`, `tours`, `appels_outils`,
  `tokens_in`/`out`, `cout_micro_eur`, `status` ∈ en_cours | sortie | inactivite | plafond | erreur, `sortie`).
  **Un index unique partiel `(run_id) where status = 'en_cours'`** : une seule session vivante par parcours,
  l'invariant est en base.
- `agent_tool_calls` : le journal d'appels (`args_rediges`, `status` ∈ ok | erreur_outil | refuse | timeout |
  erreur_protocole | budget, `http_status`, `duree_ms`, `taille_reponse`).
- `agent_knowledge` : la base de connaissance par agent. Recherche **plein texte native** (`corps_tsv`
  générée, `to_tsvector('french'::regconfig, ...)`, GIN) plus pg_trgm sur le titre. **Pas de pgvector.**
  ⚠️ Le cast `::regconfig` est obligatoire : la surcharge à config texte de `to_tsvector` n'est que STABLE et
  serait refusée dans une colonne générée. Un btree `(tenant_id, agent_id)` vient EN TÊTE de chaque recherche,
  sans quoi le planificateur n'a que les GIN et remonte puis jette les lignes des autres clients.
- `agent_credits` / `agent_credit_mouvements` (0087) : le **solde prépayé par workspace**, en micro-euros,
  `bigint` SIGNÉ : un solde peut finir légèrement négatif, et c'est voulu, un tour déjà joué a déjà coûté.
  La garde est à l'ENTRÉE du tour (solde épuisé -> on ne démarre pas), jamais à l'écriture. Le journal porte
  `delta_micro_eur` (négatif = conso, positif = recharge), `raison`, `session_id` en `set null` (la trace
  comptable survit à la purge RGPD des conversations à 30 jours) et une `note` obligatoire sur les recharges.
- `agent_tool_sources` (0088) : cf « Le connecteur API d'un client ».

### La chaîne d'exécution

`src/agent/` : `brain.gateway.ts` (`penserTrace`, LA boucle de raisonnement, partagée par le tour de
production et le bac à sable), `prompt.ts` (mention légale d'IA EN TÊTE, `blocResultatOutil` qui encadre un
résultat d'outil, parce qu'un résultat concaténé au prompt est une injection indirecte), `executor.ts` (tronc
commun d'exécution : validation des arguments, injection des paramètres non confiés au modèle, budget de
temps, journal, troncature), `resolvers/` (`mba` maison, `http` connecteur, `simulation` pour le bac à sable),
`outils-maison.ts` (le catalogue), `contexte.ts`, `credits.ts`, `devise.ts`, `escalade.ts`, `run-turn.ts`,
`turn-job.ts`, `setup/` (l'assistant de construction et son lint).

**La file `agent-turn`** (`src/queue/names.ts`, polling 2 s comme `webhook` : un tour répond à un message d'un
contact, c'est un chemin conversationnel). ⚠️ Elle n'est **consommée que si `AI_GATEWAY_API_KEY` est posée** ;
sinon le worker journalise « agent-turn : file NON consommée » et les blocs agent restent muets.

**Deux modèles, deux métiers** : `AGENT_SETUP_MODEL` (construction, sortie structurée imbriquée, tourne
rarement) et `AGENT_MODEL` (runtime, à chaque message). Le boot REFUSE la clé du Gateway sans les deux, parce
que le repli sur `LLM_MODEL` donnerait à un agent l'identifiant de l'ANALYSE de conversation, servie en direct
par Anthropic, que le Gateway ne connaît pas. Cf « Banc de tool calling » pour le choix mesuré.

## Deux pools Postgres, et pourquoi

- **`DATABASE_URL`** = pooler Supabase en mode **SESSION** (port 5432). Sert **pg-boss** (API et worker) et
  **tous les scripts CLI** (`db/migrate.ts`, `db/seed.ts`, `db/backfill-codes.ts`), qui lisent cette variable
  en direct : DDL et seed toujours en session mode, c'est voulu.
- **`APP_DATABASE_URL`** = pooler en mode **TRANSACTION** (port 6543), pour le pool APPLICATIF (toutes les
  requêtes des stores). Vide -> repli sur `DATABASE_URL`, dégradation SÛRE en cas d'oubli.
  🔴 pg-boss ne peut PAS y aller : il maintient des connexions longues et une maintenance qui ne survivent pas
  au transaction pooling (le pooler réassigne le backend entre transactions).
- **`DB_POOL_MAX` = 8**, mais le pool est instancié **PAR PROCESS** (l'API et le worker importent le même
  module), donc 16 clients simultanés vers le pooler, exactement la capacité observée en production le
  2026-08-25 : au-delà de 16, la latence double sans qu'aucune erreur ne remonte. Monter plus haut déplacerait
  la file d'attente de NOTRE pool vers celle de Supavisor, où elle est MUETTE, et `DB_CONN_TIMEOUT_MS` ne
  protégerait plus de rien.
- **`PGBOSS_MAX` = 2** : c'est LUI qui vit dans le budget d'environ 15 sessions partagé avec mm-hubspot
  (2 process x 2 ici, 2 x 2 chez lui). Ne pas le relever sans refaire cette arithmétique.
- **`DB_CONN_TIMEOUT_MS` = 8000** : le défaut `pg` est une attente ILLIMITÉE, donc un pool saturé rend une
  requête HTTP qui ne répond jamais, sans erreur ni trace.
- **TLS** : `DB_SSL`, `DB_SSL_CA_FILE`, `DB_SSL_INSECURE` sont lues par `src/db/ssl.ts`, PAS par `config.ts`.
- ⚠️ Sûr parce que mba est **search_path-agnostique** (tables en `public` par défaut, `mmhs` TOUJOURS
  qualifié) et que toutes ses transactions passent par un client dédié.

## Files et balayeurs

**Sept files** (`src/queue/names.ts`, `BASE_QUEUES`, source UNIQUE) plus leur DLQ (`dlqName`), soit 14 files
réelles côté `/ops`. La cadence de polling se règle **par file**, sur la latence réellement utile :

| File | Polling | Pourquoi |
| --- | --- | --- |
| `webhook` | 2 s | messages entrants, latence conversationnelle |
| `agent-turn` | 2 s | un tour d'agent IA répond à un message, même chemin |
| `campaign-run` | 5 s | l'utilisateur vient de cliquer « lancer » et regarde l'écran |
| `automation-event` | 5 s | démarre un scénario sur mot-clé, tag, webhook |
| `analyze-conversation`, `push-analysis`, `hubspot-catchup` | 30 s | traitements de fond |
| toute DLQ | 60 s | dépôt inspecté par `/ops`, consommé par personne |

🔴 **Pourquoi ce n'est pas le défaut de pg-boss (2 s partout)** : mesuré le 2026-08-17, le polling à vide des
4 process (mba api + worker, mm-hubspot api + worker) produisait 663 000 requêtes et 249 Mo d'egress par jour
pour 157 jobs en table, soit 7,5 Go/mois contre 5 Go inclus. L'egress d'un poll est du pur overhead.

🔴 **Toute nouvelle file entre dans `BASE_QUEUES`**, sinon elle est invisible de `/ops` et sa DLQ n'est
surveillée par personne. `tests/queue-names.test.ts` dérive la liste des `queue.work(...)` du worker et casse
si on l'oublie ; `QUEUE_POLLING_SECONDS` doit aussi porter une entrée.

**Les balayeurs du worker** (`src/worker.ts`), tous `unref()`, avec leur variable de cadence :

| Balayeur | Cadence | Ce qu'il fait |
| --- | --- | --- |
| reclaim | `RECLAIM_INTERVAL_MS` | ramène à `pending` un destinataire `sending` plus vieux que `STALE_SENDING_MS` |
| `campaign/schedule-sweep` | 60 s | enfile les campagnes programmées dues, puis marque `running` |
| campagne au fil de l'eau | 60 s | relance les campagnes webhook qui ont un destinataire `pending` avalé par un `singletonKey` |
| `workflow/wake-sweep` | `WORKFLOW_WAKE_SWEEP_INTERVAL_MS` | réveille les parcours endormis (bloc Attente) et réclame les blocs Question à échéance |
| `campaign/retry-sweep` | `AUTO_RETRY_SWEEP_INTERVAL_MS` | auto-relance des échecs (fenêtre matinale des 131049) |
| `inbox/control-sweep` | `CONTROL_SWEEP_INTERVAL_MS` | rend la main au scénario après `CONTROL_HUMAN_TIMEOUT_MS` / `CONTROL_MBA_TIMEOUT_MS` |
| `mba/handoff-sweep` | `CONTROL_SWEEP_INTERVAL_MS` | applique le mode `business_hours` du passage de main Meta |
| `analysis/sweep` | `CONVERSATION_ANALYSIS_SWEEP_INTERVAL_MS` | réclame les conversations closes à analyser |
| rattrapage HubSpot | `HUBSPOT_CATCHUP_SWEEP_INTERVAL_MS` | relance les marques restées sur un numéro reconnecté |
| `automation/date-sweep` | `AUTOMATION_DATE_SWEEP_INTERVAL_MS` | déclencheur « X avant la date d'un champ » |
| `account/status-sweep` | `PHONE_STATUS_SWEEP_INTERVAL_MS` | statut et qualité des numéros Meta |
| purge des payloads webhook | 6 h | `WEBHOOK_PAYLOAD_RETENTION_DAYS` |
| `ops/dlq-sweep` | | alerte Telegram sur les DLQ non vides |
| heartbeat | `HEARTBEAT_INTERVAL_MS` | écrit `worker_heartbeat` (0044), lu par `/ops` pour voir un worker mort |

## API publique v1 (migration 0035)

Deux surfaces : `POST /v1/contacts` et `/v1/contacts/batch` (`src/http/v1-contacts.ts`), `POST /v1/sends` et
`GET /v1/sends/:sendId` (`src/http/v1-sends.ts`). Gestion des clés dans `src/http/api-keys.ts`, écran
`/developers`.

- **Clés** (`api_keys`) : jamais stockées en clair, seulement leur `sha256` (même doctrine que `auth_tokens`).
  `scopes text[]`, validés contre `VALID_API_SCOPES = ['contacts:write', 'sends:create']` ; au moins un scope
  est exigé à la création. `revoked_at` plutôt qu'un DELETE. La clé n'est rendue QU'UNE FOIS, à la création.
- **Idempotence** (`api_idempotency`) : `Idempotency-Key` OBLIGATOIRE sur `POST /v1/sends`. Claim atomique par
  la PK `(tenant_id, idempotency_key)` : `send_id` null = calcul en cours, donc un rejeu concurrent rend 409 ;
  renseigné = on renvoie le rapport caché. Purge après 24 h.
- **Débit** : `API_KEY_RATE_LIMIT_MAX` / `_WINDOW_MS` (60 par minute), **en mémoire et par process**, donc
  effectivement doublé entre l'API et le worker si un jour le worker montait ces routes.
- **Consentement** : `/v1/contacts` exige un **opt-in EXPLICITE**, à l'inverse de la saisie manuelle et de
  l'import CSV (cf « RGPD »). Un appelant d'API charge une liste dont il ne connaît pas chaque ligne.
- **Fenêtre 24 h** : `exigeFenetre24h` sur `/v1/sends`, troisième détenteur de cette règle avec `besoinsFenetre`
  et la garde de `runFrom`.

## Canal email (migration 0062)

Troisième canal, servi par le bloc « Envoi de mail » du builder. `src/email/` : `account-store.pg.ts`,
`template-store.pg.ts`, `resolver.ts`, `smtp.ts` (nodemailer).

- `email_accounts` : une boîte SMTP par workspace : `host`, `port`, `secure`, `username`, **`password_enc`**
  (AES-256-GCM via `src/crypto/secretbox.ts`, même patron que `waba_credentials` et `agent_tool_sources`),
  `from_address`, `from_name`, `reply_to`, `verified_at`. Le mot de passe en clair ne transite que dans
  `buildTransport`, jamais journalisé ni renvoyé par une route.
- `email_templates` : `format` ∈ `basic` | `html`, `subject`, `body`. Écran `/email-templates`.
- **Suppression DOUCE** (`deleted_at`) sur les deux tables, avec des index uniques partiels : un bloc qui
  référence une boîte ou un modèle retiré devient inerte, le graphe reste valide. Une suppression dure
  casserait un scénario en silence.
- **Variables** : même contrat `{{champ}}` et même table de substitution que le RCS (`contactVars`). Le
  sélecteur propose `emailVariableFields` (qui ajoute `profile_name` et `phone`, que `GET /user-fields` ne
  rend jamais) ; `emailResolvableFields` sert au choix du champ qui CONTIENT l'adresse du destinataire, où
  proposer « Téléphone » serait un piège.
- **Destinataires en copie cachée** (`bcc`) : aucun en-tête n'est posé si la liste est vide.

## Réglages d'espace (`tenant_settings`, `src/settings/store.pg.ts`)

Une ligne par tenant (PK = `tenant_id`), enrichie migration après migration. Chaque colonne est un
interrupteur produit, et aucune n'a de défaut « allumé » :

| Colonne | Migration | Ce qu'elle gouverne |
| --- | --- | --- |
| `mba_enabled` | 0012 | l'agent Meta Business Agent est actif sur cet espace |
| `hubspot_lists_enabled` | 0036 | « Campagnes via données HubSpot » (import de contacts, pas les étapes de deal) |
| `campaigns_paused` | 0047 | coupe-circuit d'envoi de campagnes pour tout l'espace |
| `auto_retry_enabled` | 0048 | auto-relance des échecs |
| `timezone` / `business_hours` | 0050 | le fuseau de l'espace (une heure murale sans fuseau est interprétée là) et les horaires |
| `mba_handoff_mode` | 0067 | `always` \| `business_hours` \| `never`, source de vérité du passage de main (cf sa section) |
| `return_behavior` | 0051, **droppée en 0059** | ne plus chercher cette colonne |

## Gotchas et décisions (journal, déplacé de CLAUDE.md)

Vue chronologique par lot. La vue thématique correspondante est dans les sections ci-dessus.

### Gotchas Meta du lot (2026-07-12)
- **Édition d'un template Meta REMPLACE tous les components** (pas de patch) : un HEADER/FOOTER/CAROUSEL
  serait supprimé s'il n'est pas re-fourni -> on **bloque l'édition** de ces templates (flag `editable`).
- **En-tête template TEXTE à variable interdit en V1** : aucun chemin d'envoi (campagne/inbox) ne fournit un
  paramètre de header -> Meta #132000 à l'envoi. `parseHeader` rejette `{{n}}` dans le header texte.
- **Éditer le flow_json d'un DRAFT = `POST /{flow_id}/assets` en MULTIPART** (le create est du JSON inline) ;
  un flow PUBLISHED est immuable -> « dupliquer pour modifier ».
- **Funnel read receipts** : `delivery_status IS DISTINCT FROM 'failed'` (PAS `<> 'failed'` : la colonne est
  souvent NULL, `NULL <> x` = NULL = faux -> sortirait les null du dénominateur).

### Gotchas lot 2 (2026-07-12)
- **Statut compte « jamais de faux vert »** (`src/account/service.ts`, PUR) : le vert exige numéro `CONNECTED`
  + qualité `GREEN` confirmée ; tout inconnu -> gris. Une qualité `UNKNOWN` fraîche doit ÉCRASER un vieux
  `GREEN` en base (`pullFromInfo` persiste toujours la qualité, sinon staleness = faux vert).
- **Funnel « répondu » attribué au DERNIER envoi** : `getCampaignFunnel` borne la réponse par un `not exists`
  d'un envoi ultérieur au même numéro avant la réponse -> pas de double-comptage sur plusieurs campagnes.
- **`/ops` = surface cross-tenant, majoritairement en lecture MAIS avec DEUX POST** (observation d’un espace, et recharge du solde prépayé : la seule écriture d’argent du produit), autorité SÉPARÉE du JWT : header `x-ops-token` == `OPS_TOKEN`
  (env, compare constant-time). Vide -> 401 (désactivé). `OPS_TOKEN` vit dans `.env.prod` du VPS, jamais commité.
- **Nom de schéma pgboss interpolé en SQL** (`${schema}.job`) : validé par regex (`safeSchema`), source = env
  seule. Toute VALEUR reste bindée `$n`. Un `$n` non typé dans un CASE défaut à `text` -> caster `$n::type`.

### Gotchas lot 7 (2026-07-13)
- **Résolution des variables d'un template envoyé via WORKFLOW = dans la closure `sendTemplate` de `worker.ts`**,
  PAS dans l'executor (qui ne porte que waId). Elle lit N (nb de variables du corps live via `list()` Meta, caché
  5 min par WABA|nom|langue), les `template_param_hints`, le contact (`getResolvableByPhone`) et fournit TOUJOURS N
  params (`buildWorkflowTemplateComponents`, pure + testée). Sans ça : envoi à 0 variable -> Meta #132000. Le vrai
  chemin étant une closure inline, on teste la **fonction pure** extraite, pas un fake d'executor (cf LEARNINGS).
- **Numérotation d'une nouvelle variable de template = MAX des positions présentes + 1**, jamais le simple compte :
  après suppression d'une variable, réutiliser le compte crée une collision `{{n}}`. Le corps est **canonicalisé**
  (renumérote 1..N par ordre d'apparition + réaligne sources/exemples) **au submit** -> Meta exige 1..N contigu.
- **Éditeur du corps = `contentEditable` (VariableBodyEditor)** affichant des chips `[Prénom]` tout en sérialisant
  `{{n}}`. Quasi non-contrôlé : ne réécrit l'innerHTML que si `serialize(DOM) !== value` (sinon le caret saute à
  chaque frappe). Labels mis à jour EN PLACE dans les chips (n'affecte pas le caret).
- **Fiche contact : téléphone + BSUID en LECTURE SEULE** (identités qui routent les messages / clés uniques). Seuls
  Nom (`profile_name`), Prénom et les user fields sont éditables ; suppression de champ via `fields - text[]` (accepte
  une clé orpheline sans définition).
- **Tag d'un bloc « ajout de tag » déclaré dans le référentiel** à la sauvegarde du workflow (`declareTags`,
  best-effort) ET au runtime (`applyTag` upsert), même normalisation (trim + slice 64) que la route Tags. Aussi
  persisté **au blur** du champ dans le bot builder (`createTag`) -> visible tout de suite dans Contenu > Tags.

### Gotchas / décisions (2026-07-15)
- **Campagne WORKFLOW : « statut envoyé ≠ livré ».** La branche workflow de l'engine marque le destinataire `sent`
  avec un **message_id synthétique `wf-<id>`** (fire-and-forget `startWorkflow`) -> le funnel delivered/read reste à 0
  ET un envoi réel sauté en aval ne se voit pas. Parade câblée : on **associe + résout les variables du 1er template
  À LA CRÉATION** (buildRecipients -> `resolvedParams` passés jusqu'à l'envoi via `startWorkflow`/`executor.start`/
  `sendTemplate explicitParams`) et on **saute + avertit** (« X contacts sautés ») au lieu d'un skip runtime silencieux.
  Détail transversal : `brain/LEARNINGS.md` 2026-07-15. **Reste à faire** : le vrai tracking de livraison (todo).
- **Campagne workflow : le 1er nœud DOIT être un template** (validé côté route via `getWorkflowGraph` + `entryNode`,
  400 sinon). Le mapping du 1er template est stocké sur la campagne (`param_mapping`), pas sur le template global.
- **Cap d'envoi Meta : `messaging_limit_tier`** = **cap de clients uniques par 24 h** (TIER_250/1K/10K/100K/UNLIMITED),
  affiché via `web/lib/format.ts` `sendingLimitLabel` (repli honnête si Meta n'a pas évalué, jamais un faux chiffre).
  Le débit brut `throughput_level` (STANDARD 80 msg/s, identique pour tous) N'EST PLUS affiché ni mappé (décision
  produit F2 : sans valeur pour l'utilisateur). Le champ reste pull/persisté côté backend, juste non rendu.
- **État HubSpot d'un numéro = lecture CROSS-SCHEMA** : mba lit `mmhs.tenant_portals`/`mmhs.portals` (schéma du
  connecteur mm-hubspot, même Supabase) via `getHubspotPortal` (best-effort, catch -> non connecté, jamais de 500).
  Le toggle par-numéro (`phone_numbers.hubspot_connected`) gate le push d'analyse. Bouton « Connecter HubSpot » =
  lien d'installation **SIGNÉ**, obtenu par `POST /tenants/:tenantId/hubspot/install-link` (route admin, JWT ;
  le tenant vient du jeton, jamais de l'URL) et consommé par le connecteur en `/oauth/install?t=<jeton>`.
  ⚠️ **La forme `?tenant=<tenantId>` documentée ici jusqu'au 2026-08-29 NE MARCHE PLUS**, et c'est voulu :
  elle acceptait n'importe quel identifiant sans authentification, donc n'importe qui pouvait relier SON
  portail HubSpot au workspace d'un client (faille 1.1 de `PLAN.md`, fermée). Le jeton est un HMAC à durée de
  vie de 10 minutes ; l'ancienne forme ne survit que derrière `HUBSPOT_INSTALL_ALLOW_LEGACY_TENANT`, à
  `false` en production, et la reposer à `true` rouvrirait la faille à l'identique.

### Gotchas / décisions (2026-07-16)
- **Campagne workflow : 3 pannes SILENCIEUSES fermées** (le « envoyé mais rien reçu » persistant). (a) **Cap fréquence 24h RETIRÉ** : `DEFAULT_THRESHOLDS.frequencyWindowMs=0` + garde `t.frequencyWindowMs > 0` (court-circuit, aucune requête). Un garde-fou qui laissait un destinataire `pending` en silence pendant que la campagne se marquait `completed` = panne invisible ; plomberie fréquence conservée + testée (fenêtre >0 la réactive). (b) **Indice de template périmé → 0 destinataire** : un hint `{field, nom}` fantôme mappait `{{1}}` sur un champ inexistant ; le `<select>` affichait « Nom » mais gardait le sel fantôme -> tous sautés. Fix front `selForSource` (coerce un champ inconnu → `sys:name`) + option de garde + campagne 0 destinataire = avertissement ROUGE. (c) **Bouton FLOW à l'envoi (#131009)** : un template à bouton **FLOW** (NAVIGATE) part rejeté sans son composant bouton ; Meta exige `{type:'button', sub_type:'flow', index, parameters:[{type:'action', action:{flow_token}}]}` avec `flow_token` NON vide. mba corrèle la réponse par `_ref` baké dans le flow_json, donc le flow_token peut être n'importe quelle valeur unique (`worker` passe `${waId}-${Date.now()}`). **Vérifié empiriquement contre la Cloud API** avant de coder. Détail transversal : `brain/LEARNINGS.md` 2026-07-16.
- **Champs SYSTÈME (Nom/Prénom/Téléphone/BSUID/WhatsApp ID/Email) = constante de CODE, SANS migration** : `src/crm/fields.ts` SYSTEM_FIELD_KEYS (garde PATCH/DELETE/POST 403/409) + `web/lib/fields.ts` SYSTEM_FIELDS (miroir, source par champ). Résolus via les attributs existants + 2 nouveaux (`bsuid`, `wa_id` dans `ParamSource`/`valueOf` switch + `getResolvableByPhone` remonte bsuid). Sélecteur de variable de campagne = **dropdown** (base + vrais champs perso + texte fixe), fini la clé tapée à la main.
- **Embedded Signup (Tech Provider) : LIVE mais OFF par défaut.** Bouton « Connecter mon compte WhatsApp » (accueil, espace sans numéro). Env : `META_ES_CONFIG_ID` (vide → route 503 + bouton placeholder), `ENCRYPTION_KEY` (64 hex, fail-fast prod si config_id posé), `META_APP_ID=988129420727963`. Backend `src/http/embedded-signup.ts` + `src/meta/embedded-signup.ts` + `src/account/es-store.pg.ts` + `src/crypto/secretbox.ts` (AES-256-GCM). **Anti-hijack** : `verifyWaba`+`getPhone` BLOQUANTS avec le business token avant tout rattachement (sinon un tenant relie les assets d'un autre). Token+pin **chiffrés** (mig **0029** `waba_credentials`, col `pin_enc`). Config Meta via template « WhatsApp Embedded Signup 60-day » (cf `brain/LEARNINGS.md`). ⚠️ Marche seulement quand Meta a validé Access Verification (Tech Provider) + App Review : **soumises le 2026-07-16, en review**.
- **Compte de test reviewer** : `meta-review@messagingme.app` / `MetaReview2026!` (admin sur le workspace Demo `4169c753-…`, scrypt). Créé pour l'App Review Meta. **À SUPPRIMER après approbation.**
- **Landing admin = `/accueil`** (Home), plus `/dashboard` (Analytics) : login/racine/Google/invite redirigent l'admin sur Home (montre le numéro + statut, cohérent avec les reviewer instructions Meta). Le lien Analytics du menu reste.
- **i18n FR/EN** : moteur léger `web/lib/i18n.tsx` (`useT()` → `t('fr','en')` co-localisé, contexte persisté localStorage, défaut FR), toggle dans le menu Compte. Toute l'app traduite. Règle : NE JAMAIS wrapper une valeur backend/clé/comparaison dans `t()` (grep de sûreté `value={t(`, `=== t(`).

### Gotchas / décisions (2026-07-16, suite : programme 16 features, lots A-E)
- **⚠️ Ordre migration/deploy selon le TYPE** : ADD colonne = migrate AVANT le deploy (habituel) ; **DROP colonne = deploy AVANT le migrate** (l'ancien code la lit encore → 500 pendant le rebuild sinon). Exception documentée dans `DEPLOY.md` + règle générale dans `brain/LEARNINGS.md`. 1er cas réel : `0030_drop_workflow_status.sql`.
- **Codes publics « schéma A » (socle API, Lot 4a)** : `<type>_<code-client>_<ULID>` (scn/usr/fld/tag ; nod = Lot 4b). **ADDITIFS** : colonnes `tenants.public_code` + `code` (mig 0031, nullables + index uniques partiels), AUCUNE PK/FK/slug touchée. Génération à l'INSERT (`src/ids/code.ts` : newUlid/makeCode/deriveTenantCode ; `src/ids/tenant-code.ts` : resolveTenantCode self-heal). Racine client = 6 car. base32 **immuable**, dérivée de l'uuid tenant (PAS le numéro : PII + inexistant au signup). Backfill one-shot : `db/backfill-codes.ts` (idempotent, après migrate).
- **Scénario : AUTO-SAVE, plus de statut** : debounce ~1,2s sur [nodes,edges], **flush au démontage + beforeunload en `keepalive`** (sinon perte des dernières modifs), skip du rendu initial, planification via `doSaveRef` (le changement de langue ne déclenche pas de save), **saves sérialisés** (un PATCH à la fois, re-save si édité pendant). Colonne `status` droppée (elle était 100 % cosmétique, rien ne la lisait).
- **Node « message rapide » (quick_message)** : bloquant comme template, action `sendQuickMessage` → `MetaClient.sendInteractive` (interactive/button, cap 3 boutons / 20 car.). **Index de branche préservé** : `reply.id = btn:<slot>` même après filtrage des titres vides (sinon mauvaise branche). Fenêtre 24h garantie par l'archi (jamais node d'entrée : campagne exige entry=template). ⚠️ Le node `flow` reste un no-op silencieux (n'envoie rien, run bloqué) → fix différé au lot Flow avancé (envoi interactif flow = sonde Meta).
- **⚠️ Closure de wiring et arité TS** : `index.ts` câblait `(tenant, range) => store.getErrorBreakdown(tenant, range)` alors que la route passait un 3e arg → filtre `?templateName=` MORT en prod, tsc muet (arité non vérifiée), test masqué par le fake. À CHAQUE ajout de param à une interface de deps : grep toutes les implémentations (prod + fakes). Cf `brain/LEARNINGS.md`.
- **Erreurs Meta par template** : `getErrorBreakdown(range, templateName?)` groupe par (code, template_name) ; l'UI agrège CÔTÉ CLIENT (un fetch, dropdown « Tous les templates »). Portée = campagnes (aucune colonne d'erreur sur `conversation_messages` → envois Inbox/Workflow non couverts, cf todo).
- **Import HubSpot (#14) parké en todo** (multi-repo : scope `crm.lists.read` + re-consentement portail + client lists mm-hubspot + proxy mba).

### Gotchas / décisions (2026-07-17, Lot 7 : Flow avancé)
- **⚠️ Id d'écran Flow JSON = lettres + underscores UNIQUEMENT** (`ETAPE_2` rejeté à cause du chiffre, sondé live). Nos ids : `FORM`, `FORM_B`, `FORM_C`… L'écran 1 s'appelle `FORM` POUR TOUJOURS (baké en `navigate_screen` des templates FLOW approuvés + `flow_action_payload.screen` de `sendFlowMessage`).
- **Champ masqué (visible/If) ou vide = OMIS du payload `complete`** (sondé) : le mapping webhook (`hasOwnProperty`) suffit tel quel, AUCUN risque d'écrasement de champ contact par du vide. Un `required` caché ne bloque ni navigate ni complete. Refs globales `${screen.<ID>.form.<clé>}` : payloads d'action SEULEMENT (non résolues dans les textes affichés).
- **`flows.elements` = jsonb POLYMORPHE sans migration** : null legacy / tableau plat (mono-écran historique) / `{screens:[...]}` (Lot 7), normalisé par `screensOf` à la LECTURE. Toute nouvelle lecture de la colonne passe par `screensOf`, jamais un cast direct.
- **Garde fenêtre 24 h** : un scénario ne peut pas OUVRIR sur un node flow/quick_message (`opensOutsideServiceWindow` -> 400 au save + skip défensif `start()` + badge UI sur le node d'ouverture réel, calculé en traversant les blocs synchrones tag/field). ⚠️ Contrat de test CHANGÉ sciemment : « quick_message en entrée envoyé par start » assertait la faille -> réécrit.
- **Sonde LIVE committée** : `MBA_TOKEN=$(ssh ubuntu@146.59.233.252 "grep '^META_ACCESS_TOKEN=' /home/ubuntu/mba/.env.prod | cut -d= -f2-") WABA_ID=1695646181671929 npx tsx scripts/sonde-flow-live.mts` : à rejouer à CHAQUE évolution du générateur flow_json (crée un draft sur le vrai WABA, exige `validation_errors == []`, se nettoie).
- **Preview interactive Meta** = banc de test runtime sans device : `GET /{flow_id}?fields=preview.invalidate(false)` puis `?interactive=true&debug=true&flow_action=navigate&flow_action_payload={"screen":"FORM"}` (les 2 derniers params REQUIS ensemble) ; le panneau debug affiche le payload exact de chaque action.

### Gotchas / décisions (2026-07-17, Lot 9 : ConvAnalyzer light)
- **⚠️ `conversation_analysis.created_at` = date de DERNIÈRE analyse, pas de la conversation** : la table est upsertée (`on conflict do update set created_at=now()`). Tout agrégat temporel dessus compte des ré-analyses, pas des conversations nouvelles ; une ligne ré-analysée saute de fenêtre. Assumé et LIBELLÉ « à date de dernière analyse ». Pour une vraie timeline, joindre `conversations.created_at` (stable). Cf `brain/LEARNINGS.md`.
- **Couche de LECTURE séparée du moteur d'écriture** : `src/stats/conversation-stats.pg.ts` (lecture, 1er lecteur de la table) ≠ `src/analysis/store.pg.ts` (écriture). Ne pas mélanger. `tenant_id=$1` sur CHAQUE requête (IDOR = leçon convanalyzer). Filtres quali validés contre un SET d'enum (valeur hors enum ignorée, pas d'injection).
- **Champs LLM = indicatifs** (sentiment/intent/topic/resolved/action/confidence) ; `handled_by`/`exchanges_count` sont DÉTERMINISTES (code). Bucket `handled_by='mba'` inatteignable (MBA fermé ToS) -> 2 valeurs réelles, ne pas dessiner 3 catégories égales.
- **Repo web SANS lib de charts** (règle no-ai-slop) : donut = SVG maison (`pathLength=100` + `stroke-dasharray`), barres = patron inline existant. Ne JAMAIS ajouter recharts/tremor/d3.
- **Analyse ACTIVE en prod** : `CONVERSATION_ANALYSIS_ENABLED=true`, `LLM_MODEL=claude-haiku-4-5`. La table se remplit ; empty-state (`total=0`) couvre « inactif » (via `enabled`) ET « aucune donnée sur la période ».

### Gotchas / décisions (2026-07-17, Lot 8 : campagne une-page)
- **⚠️ Timeout d'un job de file THROTTLÉ = dimensionné PAR JOB, pas une constante** : un run de campagne à débit bas tourne des heures ; un `expireInSeconds` fixe (pg-boss défaut 900s) le fait EXPIRER -> **rejeu parallèle** (l'original n'est pas tué) -> débit réel x2 + statut `completed` prématuré. Fix : `src/campaign/pacing.ts campaignJobExpireSeconds(n, rate)` passé PAR JOB à l'enqueue (`Queue.enqueue({expireInSeconds})`, route `/run` via `getRunSizing`). ⚠️ `pg-boss createQueue` est `ON CONFLICT DO NOTHING` (ne met PAS à jour une file existante) : pour une policy de file, `updateQueue` ; pour une valeur qui varie, l'option par job. Cf `brain/LEARNINGS.md`.
- **Filtres CRM = WHERE 100 % paramétré, clé jsonb LIÉE** : `contact-store.buildWhere` : `fields ->> $key` (la clé vient de l'utilisateur, JAMAIS interpolée), `tenant_id=$1` toujours. Route GET /contacts (+/count, +/ids) dans `src/http/import.ts` (PAS http/contacts.ts, piège de localisation) ; `parseFilters` défensif (JSON de `fields` illisible -> ignoré). Le submit campagne reste `contactIds` (buildRecipients = dernier garde opt-in).
- **Statut campagne `scheduled` à propager PARTOUT** : `CampaignStatus` + CHECK `campaigns_status_check` (mig 0034, DROP+ADD, nom vérifié) + `STATUS` map front + garde D1 `listActiveCampaignsForTemplate` (édition template) + counts (listCampaignSummaries n'a AUCUN filtre de statut, OK). Sweeper `schedule-sweep.ts` : enqueue PUIS markRunning (jamais de 'running' orphelin), idempotent (singletonKey + garde `status='scheduled'`).
- **Import réutilisable** : `web/components/CsvImport.tsx` extrait (Contacts + campagne, prop `requireTag`), zéro dupe. Contacts NE navigue plus après import (le rapport + erreurs par ligne sont enfin visibles).

### Gotchas / décisions (2026-07-16, fin de programme : lots 4b + 6)
- **Codes de NODES (Lot 4b) = mint SERVEUR, jamais confiance au client** : `src/workflow/node-codes.ts` au POST/PATCH workflows (après parseGraph). Regex anti-forge `^nod_<tenantCode>_[ULID]$` : code valide du MÊME tenant → préservé par référence (stabilité des codes existants) ; absent/forgé/autre tenant → re-minté. La réponse renvoie le graphe ENRICHI (le front réaffiche les codes sans re-fetch). Champs système : code **déterministe sans stockage** `fld_<client>_sys_<key>` (`systemFieldCode`), le front le calcule via `tenantCode` exposé par GET /fields (dep OPTIONNELLE côté fields, REQUISE côté workflows).
- **⚠️ Type partagé front : `Locale` vit dans `web/lib/locale.ts` (.ts PUR)** : le tsc RACINE (qui type-check `tests/`) n'a pas `--jsx` → importer même un simple type depuis un `.tsx` casse le build (TS6142). Tout type consommé par du code non-JSX doit vivre dans un `.ts` ; `i18n.tsx` le ré-exporte pour les composants.
- **Helpers localisés = paramètre `locale` REQUIS, pas de défaut** (`day.ts`, `format.ts`) : tsc LISTE alors tous les appelants à mettre à jour, zéro oubli possible (l'inverse du piège d'arité des closures). Tags BCP47 confinés aux 2 libs, grep `fr-FR` = 0 ailleurs dans `web/`.
- **⚠️ GATES : jamais de pipe sur une commande gate** : `npm run build 2>&1 | tail` renvoie l'exit du TAIL → un build cassé passe « vert ». Toujours `cmd > log 2>&1; echo EXIT=$?`. Et **vitest ne type-check PAS** (esbuild) : 707 tests verts ≠ tsc vert. Cf `brain/LEARNINGS.md` 2026-07-16.

## Journal des lots livrés (déplacé de `wip.md` le 2026-08-29)

🔴 **POURQUOI CES SECTIONS ONT DÉMÉNAGÉ.** `wip.md` avait atteint 1341 lignes et remontait à juillet : les lots
finis n’en sortaient jamais. Un fichier censé dire « ce sur quoi je travaille MAINTENANT » était devenu une
archive, donc illisible pour son seul usage. Les trente-huit sections ci-dessous sont des lots LIVRÉS ET
DÉPLOYÉS, gardées telles quelles parce qu’elles portent des GOTCHAS et des DÉCISIONS (pourquoi tel ordre, quel
piège évité) qu’aucun autre document ne consigne. Elles se lisent à la demande, jamais en entier.

⚠️ Elles sont datées et figées : ce qu’elles décrivent était vrai le jour du déploiement. En cas de
contradiction avec le reste de ce fichier ou avec `features.md`, c’est le reste qui fait foi.

---
## DEPLOYE le 2026-09-02 : tracer et attribuer les liens des messages RCS (migration 0107)

Julien : « il faut aussi que ça marche si j'envoie un RCS hein ? ». Le pendant RCS de l'attribution des clics
livrée le même jour pour WhatsApp (0106).

🔴 **LA 0106 S'ÉTAIT TROMPÉE DE CLÉ, et c'est le vrai enseignement du lot.** Elle avait posé
`tracked_links.rcs_message_id`, une référence vers `rcs_messages`, la BIBLIOTHÈQUE. La reconnaissance faite en
écrivant le code a montré que cette clé ne couvrait presque rien : une campagne RCS porte son message
EMBARQUÉ (`campaigns.rcs_message`), un bloc de scénario aussi (dans le graphe), la réponse rapide convertie en
RCS le fabrique à la volée, et SEUL l'envoi manuel depuis l'inbox lit la bibliothèque par identifiant. La clé
aurait donc tracé le cas le moins utile et laissé sans mesure les deux qui comptent.

**La règle à en tirer** : une clé étrangère choisie sur le SCHÉMA, sans avoir suivi les appelants réels,
désigne la table qu'on a sous les yeux, pas celle qui produit la donnée. Ici l'erreur a coûté une migration
corrective écrite le jour même (colonne encore vide, 0 ligne vérifiée en base) ; une semaine plus tard il
aurait fallu migrer des données au lieu de retirer une colonne.

**La clé retenue : `(tenant_id, destination)`.** Elle se déduit de la nature du canal, pas d'un goût. La clé
WhatsApp (template, langue, carte, bouton) sert l'IDEMPOTENCE DE LA RÉSERVATION : un template est soumis puis
figé, et le resoumettre doit retrouver le MÊME code sinon les messages déjà livrés pointent une ligne
orpheline. Un message RCS n'est soumis à personne : il ne reste qu'à ne pas créer une ligne par destinataire,
qu'un lien d'hier résolve encore, et que les clics s'accumulent. La destination fait les trois, et c'est la
clé la plus simple qui le fasse.

**Ce qui a emporté la décision : le point de passage unique.** Les quatre chemins d'envoi RCS convergent DÉJÀ
sur `RcsSender.sendTo`, dont le commentaire dit pourquoi les mises en forme vivent là (« y penser dans chaque
appelant serait exactement le genre d'oubli qui se voit six mois plus tard »). À cet endroit, la seule
identité disponible est l'URL. Toute autre clé obligeait à réécrire les liens dans quatre appelants.

**Deux conséquences heureuses de réécrire À L'ENVOI :**
- aucun `{{1}}`, donc **aucun risque de 132000** et **aucune garde « tout ou rien »** comme côté WhatsApp : sans
  jeton, on envoie simplement `/r/<code>`, que la route sert comme un lien anonyme ;
- le message STOCKÉ garde l'adresse saisie par l'utilisateur, donc **rien à ré-habiller à l'affichage**,
  contrairement aux templates (`rehabillerBoutons`). Un item du plan initial est mort de lui-même.

**Le cache est structurel, pas une optimisation.** `TraceurLiensRcs` mémorise `tenant\0adresse -> code` pour la
durée du process : sans lui, une campagne de 5 000 destinataires ferait 5 000 allocations de la même adresse
sur le chemin le plus chaud du produit. Il est sûr POUR TOUJOURS parce que l'association est immuable (index
unique de la 0107, aucun code jamais réattribué). Éviction FIFO bornée à 1000 entrées.

**Le jeton : batch côté masse, unitaire côté scénario.** Une campagne charge les jetons de tous ses
destinataires en UN énoncé (`jetonsPourContacts`), et seulement si le message porte un lien traçable
(`CampaignSender.aBesoinDeJeton`, calculé une fois sur le message figé). Un scénario ou l'inbox, qui écrivent à
une personne à la fois, lisent par numéro (`jetonPourE164`), et seulement si le message porte un lien : on ne
fabrique pas d'identifiant public pour quelqu'un à qui on n'envoie rien à cliquer.

**Ce qui rend enfin l'attribution VISIBLE : « Engagé » compte le clic.** La 0106 ÉCRIVAIT `contact_id` sur
chaque clic mais rien ne le LISAIT nulle part. Et l'indicateur « engagé » du mini-CRM ne regardait que les
messages entrants, or un bouton URL fait SORTIR le contact de la conversation : la personne la plus engagée de
la campagne s'affichait comme n'ayant pas réagi. Les deux trous se ferment l'un l'autre. Seuls les clics
ATTRIBUÉS créditent quelqu'un ; un clic anonyme (template d'avant le 2026-09-02) ne crédite personne, ce qui
vaut mieux que d'attribuer un geste à la mauvaise personne.

**Mesures : un espace de noms de handle à part (`lien:<i>`), et c'était le piège.** Les sorties d'un bloc RCS
s'appellent déjà `btn:0`, `btn:1`… mais elles ne comptent QUE les boutons RÉPONSE (`normaliserPostbacks`), un
bouton lien ne revenant jamais dans la conversation. Numéroter les liens dans ce même espace aurait fait porter
« a cliqué sur le lien » et « a cliqué Oui » par la MÊME clé sur un même bloc, y compris dans les tableaux
DÉJÀ enregistrés par un opérateur. L'index est celui de la liste plate `data.suggestions`, que le serveur
numérote et que l'écran relit pour nommer le bouton : les deux ne peuvent pas diverger sur l'ordre.

⚠️ Un lien RCS sans code alloué vaut **zéro** au lieu de disparaître de l'écran. Ce n'est pas une anomalie
comme côté WhatsApp : le code naît au PREMIER ENVOI, pas à la soumission. Zéro est alors la vérité exacte
(rien n'est parti, personne n'a cliqué), et c'est ce qui rend la mesure cochable avant que le scénario n'ait
tourné.

**Une adresse démesurée n'est PAS tracée** (`URL_TRACABLE_MAX = 1000`) : la clé d'unicité porte sur
`destination`, et un index btree refuse une valeur trop longue, ce qui ferait échouer l'allocation donc
l'envoi. Un lien non mesuré est un défaut de mesure ; un message qui ne part pas est un défaut de produit.

🔴 **UN DÉFAUT PARTI EN PRODUCTION LE MATIN MÊME, ET TROUVÉ APRÈS DÉPLOIEMENT.** L'API monte
`GET /r/:code/:jeton` et les templates partaient chez Meta avec `/r/<code>/{{1}}`, mais le rewrite de
`web/next.config.mjs` ne déclarait que `/r/:code`. **Un rewrite Next ne capture QU'UN segment** : la forme
attribuée n'atteignait jamais le backend, Next rendait une 404. Tout était vert (3454 unitaires, 417 e2e, CI
complète) parce que l'e2e MOCKE le backend et ne traverse jamais le proxy réel.

Ce que ça aurait coûté : en base, le template `tarifs` était DÉJÀ approuvé par Meta avec cette forme, et un
template approuvé porte son URL POUR TOUJOURS. Au premier envoi, chaque destinataire aurait reçu un lien mort,
irréparable autrement qu'en resoumettant un template. Personne ne l'a subi (aucune campagne ne l'utilisait,
zéro message envoyé, vérifié en base).

**La règle qui en sort** : la route et sa règle de proxy sont deux moitiés dans deux dépôts de configuration
différents, et rien dans le langage ne les relie. Une route publique neuve n'est pas livrée tant que son
rewrite ne l'est pas. Le garde-fou est `tests/web-rewrites-liens.test.ts`, qui DÉRIVE la liste des routes de
`src/http/links.ts` et casse si l'une d'elles n'a pas sa règle ; la mutation qui retire la ligne reproduit
exactement le défaut. Et la vérification post-déploiement se fait sur le chemin **PUBLIC** : un appel interne
au conteneur aurait réussi, précisément là où le proxy était le coupable.

⚠️ **Erreur de méthode à ne pas refaire** : un `git checkout <fichier>` pour annuler une mutation de test a
effacé les modifications NON COMMITÉES du même fichier. Sur du travail non commité, on restaure depuis une
copie, jamais depuis l'index.

### 🔴 L'incident 131008 du soir même : QUATRE défauts d'une seule famille (44a720f, 8943736)

Julien lance « Test Ciné 4 » en fin de journée : chaque destinataire échoue en **131008 « Required parameter
is missing »**, sans rien d'anormal dans le scénario. La cause est dans la base de production et dans la
définition du template chez Meta : ses deux boutons URL ont été soumis le matin même sous la forme
`/r/<code>/{{1}}`. **Un `{{1}}` dans une URL de bouton EXIGE son composant `sub_type: url` à chaque envoi.**
Aucun n'était produit, par quatre chemins indépendants, chacun suffisant à tout casser :

1. **Le passe-plat perdu** (campagnes directes). `boutonsTraces` et `jetonsPourContacts` étaient câblées dans
   le worker, mais absentes du `Pick` de `RunJobDeps` et de la construction d'`optionsMoteur`. Elles
   arrivaient dans un **spread**, qui échappe au contrôle des propriétés en trop : `tsc` vert, tests du moteur
   verts (ils appellent `runCampaign` en direct, pas `campaignRunJob`), et plus aucun template tracé ne
   partait.
2. **Le chemin scénario** ne produisait aucun composant de bouton URL par construction :
   `buildWorkflowTemplateComponents` ne connaissait que `quick_reply` et `flow`. Il aurait continué d'échouer
   après le correctif 1. Le calcul est désormais fait dans `wiring.ts` en RÉUTILISANT la règle des campagnes,
   pas en écrivant une seconde qui divergerait.
3. **Le repli était à l'envers.** Sans jeton, le code ne produisait aucun composant, en annonçant « on perd la
   mesure, on ne perd pas le message ». C'est l'inverse : le template étant déjà approuvé avec `{{1}}`, l'appel
   est refusé et RIEN ne part. **Ce qui décide, c'est le TEMPLATE, jamais l'état du jeton d'un contact.** Sans
   jeton on envoie donc un suffixe anonyme : le lien redirige (302, vérifié en production), le clic est compté,
   il n'est rattaché à personne.
4. **Le bouton de CARTE de carousel** (trouvé en vérifiant que les trois autres étaient bien tous les trous).
   `boutonsTracables` traçait aussi les boutons portés par les cartes, mais `buildTemplateComponents` ne sait
   produire que `{ type: 'button', index }`, qui adresse un bouton DU TEMPLATE : un bouton de carte se désigne
   autrement, et rien ne sait le faire. Un carousel à bouton URL soumis après le 2026-09-02 aurait échoué à
   chaque envoi, **définitivement**, l'URL étant figée chez Meta une fois le template approuvé. Zéro occurrence
   en base au moment du correctif : le piège était armé, il n'avait pas encore servi. La règle vit désormais à
   UN seul endroit (`estAttribuable`, `src/http/templates.ts`) et `avec_jeton` n'est plus codé en dur à `true`
   dans `allocate`, c'est l'appelant qui décide.

**La leçon qui vaut au-delà du 131008 : un `Pick` utilisé comme passe-plat est un FILTRE SILENCIEUX.** Les
propriétés qui arrivent par un spread échappent au contrôle des propriétés en trop, donc le compilateur accepte
ce qu'il va jeter. Une dépendance ajoutée d'un côté et oubliée de l'autre ne produit aucune erreur, seulement
une fonctionnalité qui disparaît. Partout où une liste de dépendances est recopiée, la recopie est le point
faible, et le commentaire d'avertissement est posé dessus (`src/campaign/run-job.ts`).

**Deuxième leçon, de méthode : un test qui n'entre pas par la même porte que la production ne garde rien.** Les
tests du moteur appelaient `runCampaign` directement et étaient tous verts pendant que la production échouait à
100 %. Les tests de garde partent maintenant de `campaignRunJob`, le point d'entrée réel, et la mutation qui
remet le défaut fait tomber le test sur le symptôme exact (une liste de composants vide).

**Troisième leçon, sur Meta : 131008 et 132000 sont symétriques et tous deux fatals.** Un composant manquant
pour une URL à `{{1}}` rend 131008 ; un composant fourni pour une URL SANS variable rend 132000. Il n'y a pas
de « au cas où » possible : le composant se produit si et seulement si le template porte la variable. C'est
aussi ce qui rend le **RCS immunisé** (aucun `{{1}}`, message composé à l'envoi, cf. la note de la 0107).

---
## DEPLOYE le 2026-09-02 : le connecteur API digne de ce nom (migration 0105)

Constat de Julien : « selon les doc API que le user aura pour setuper ce connecteur tool, il ne pourra pas
faire grand chose avec ce qu'on lui propose là ». Vérifié dans le code, il avait raison sur toute la ligne :
`fetch(url, { method, headers })` **sans corps**, des paramètres qui ne remplissaient qu'un gabarit de CHEMIN,
et des variables limitées à `wa_id` et `nom` alors que dix champs personnalisés sont déclarés en production.

**Migration 0105** : `connector_requests` + `agent_tools.request_id`. Un appel est désormais décrit UNE fois
dans la bibliothèque du workspace, puis ouvert aux agents, au lieu d'être redécrit dans chaque agent. Même
raison que pour la source elle-même : ce qui appartient au client ne se range pas dans un agent.

**Les deux modes de corps compilent vers le MÊME arbre**, puis passent par UNE seule substitution. C'était la
demande de Julien (« il faut qu'on puisse avoir les 2, du JSON brut pour les mecs habitués et une liste de
champs ») et c'est aussi ce qui rend la sécurité tenable : la substitution est **STRUCTURELLE**, jamais
textuelle. Une valeur ne peut donc pas refermer une chaîne JSON et injecter des clés. Deux moteurs séparés
auraient divergé au premier ajustement, et le mode « JSON brut » aurait été le maillon faible.

Autres gardes du lot : `EN_TETES_RESERVES` (`authorization`, `content-type`, `content-length`, `host`) qu'un
utilisateur ne peut pas écraser ; `cheminsDeLaReponse` ne propose QUE les chemins que l'extracteur sait
résoudre, les tableaux étant proposés entiers, pour qu'aucune case cochée ne rende systématiquement du vide.

🔴 **TROIS DÉFAUTS TROUVÉS EN CONSTRUISANT, DONT DEUX PAR DES TESTS QUI VISAIENT AUTRE CHOSE.**

1. **`.partial()` de zod ne retire PAS les `.default()`.** Un `patch` construit avec `.partial()` renvoyait donc
   les valeurs par défaut pour toute clé absente : **renommer une requête aurait effacé toutes ses variables,
   ses paramètres, ses en-têtes et son corps, EN SILENCE**. Corrigé à la racine (les défauts ne vivent plus que
   sur le schéma de création), gardé par un test qui vérifie que le store ne reçoit QUE les clés changées.
   La règle : un schéma de mise à jour partielle ne se dérive pas d'un schéma de création qui porte des défauts.
2. **Une réponse mal formée BLANCHISSAIT tout l'onglet Outils d'un agent** (un `.map` sur `undefined`), y
   compris la liste des outils maison qui n'a rien à voir. Trouvé par huit tests e2e PRÉ-EXISTANTS qui
   échouaient : la leçon est qu'un composant qui affiche une liste venue du réseau doit se défendre seul.
3. **`requis` ne servait à rien** : une variable dont la valeur était inconnue partait en `null` sans
   distinction. La garde manquait dans le résolveur, pas dans l'écran.

⚠️ **0105 n'était PAS bloquante**, et c'est ce qui a permis de l'écrire trois commits avant de l'appliquer :
aucun code ne l'écrivait tant que les routes n'étaient pas livrées, et sa forme pouvait encore bouger en les
construisant. La règle « migrer avant de déployer » vaut pour les migrations que le code ÉCRIT.

⚠️ **Erreur de méthode à ne pas refaire** : `deb71ed` a été poussé après n'avoir lancé QUE le spec e2e des
connecteurs, alors que le lot touchait un onglet PARTAGÉ. La CI est restée rouge une heure et quart sur huit
tests que la suite complète aurait montrés tout de suite. Toucher un composant partagé impose la suite entière.

---
## DEPLOYE le 2026-09-02 : voir et rejouer les jobs MORTS

Le dépôt ALERTAIT déjà quand une file d'échec se remplissait, mais la seule reprise possible était de renvoyer
le message à la main, ce qui ne passe pas l'échelle. Un job qui épuise ses rejeux part en file d'échec, que
**rien ne consomme** : il y reste pour toujours.

🔴 **Pour un `webhook`, un job mort est un MESSAGE DE CLIENT jamais traité.** C'est le pire cas du dépôt parce
qu'il est silencieux : le client a écrit, le scénario n'a pas avancé, et personne ne le sait.

### Deuxième écriture métier de `/ops`, et pourquoi elle y a sa place

Le CLAUDE.md exige qu'aucune écriture ne rejoigne cette surface sans la même justification que le rechargement
de solde. Elle tient : rejouer un traitement mort est un geste d'EXPLOITATION par nature. Il est cross-espace,
il suppose qu'on ait corrigé la cause de l'échec, et il ne doit jamais être accessible depuis un compte de la
console, sans quoi un client rejouerait des traitements sans savoir pourquoi ils avaient échoué.

### Trois décisions qui portent le reste

🔴 **Enfiler PUIS oublier, jamais l'inverse.** L'ordre décide du mode de panne : un crash entre les deux
produit un DOUBLON, l'ordre inverse produirait une PERTE. Le doublon est rattrapé partout où ça compte
(déduplication du message entrant, réclamation atomique d'un destinataire, verrou de run) ; la perte n'est
rattrapée nulle part. Un test le prouve dans les deux sens.

🔴 **La file est OBLIGATOIRE, il n'y a pas de « tout rejouer ».** Un rejeu global relancerait campagnes et
webhooks ensemble, sur des causes d'échec différentes qu'on n'a pas toutes corrigées. Le lot est borné à 100,
pour forcer à regarder entre deux passes.

⚠️ **La lecture d'abord.** `GET /ops/dlq` montre les plus anciens avec leur erreur tronquée. Rejouer sans
regarder, c'est relancer en masse des traitements qui ont échoué pour une raison qu'on n'a pas corrigée.

---
## DEPLOYE le 2026-09-01 : le tour d'avance est RÉSERVÉ avant les envois (migration 0104)

Le trou le plus cher du produit, documenté dans `executor.ts` depuis des semaines sous la forme « cette garde
protège l'ÉTAT, pas les effets ». Il est fermé.

**Ce qui se passait.** Deux avances peuvent se chevaucher DÈS AUJOURD'HUI, avec un seul worker : l'API traite
un retour RCS pendant que le worker traite un webhook du même contact. Les deux lisaient le run sur le bloc N,
calculaient chacune leur suite, **envoyaient toutes les deux**, et seule la seconde écriture était refusée. Le
contact recevait donc deux messages, dont un qu'il ne devait jamais voir.

**Le seul correctif possible** est de réserver le tour AVANT les effets, pas après. `setStateSiEncoreSur` reste
en place : elle devient la ceinture, la réservation étant la bretelle. Deux gardes qui se recouvrent valent
mieux qu'une seule sur un chemin qui envoie de l'argent.

### Les trois pièces, et la quatrième qu'on n'a PAS mise

Mêmes pièces que le verrou de run de campagne (`src/campaign/run-lock.ts`), parce que ce sont elles qui font la
différence entre un verrou et un drapeau :

- un **bail** (`avance_jusqu_a`) : un worker tué en plein traitement ne bloque pas le parcours à vie ;
- un **jeton** (`avance_token`) : le porteur d'un bail périmé, revenu tard, ne peut pas libérer le verrou de
  celui qui l'a repris entre-temps ;
- une **libération explicite** dans un `finally`, y compris quand un envoi jette : sinon le message SUIVANT du
  contact attendrait la fin du bail pour rien, sur un parcours parfaitement sain.

⚠️ **PAS de drapeau de relance**, à la différence du verrou de campagne, et c'est un choix. Le perdant d'une
avance ne doit RIEN rejouer : son message a été traité par le gagnant, qui lisait le même bloc. Un drapeau de
relance ferait avancer le parcours deux fois, c'est-à-dire recréerait le défaut à l'envers.

⚠️ **Perdre la réservation n'est pas une erreur**, c'est le cas normal quand deux messages du même contact
arrivent ensemble. Le perdant sort sans rien faire, en le journalisant (« avance IGNOREE ») : une course qu'on
ne voit pas est une course qu'on ne corrigera jamais.

### Ce que ça ne ferme toujours pas

Le crash APRÈS un succès fournisseur mais AVANT la persistance. Sans clé d'idempotence acceptée par Meta,
l'exactly-once est impossible : le compromis reste « un rejeu possible plutôt qu'une perte », et il est assumé.

---
## DEPLOYE le 2026-09-01 : la liste des scénarios ne transporte plus les graphes

Dernier constat du contre-audit. `PgWorkflowStore.list` renvoie **deux graphes complets par ligne** (le publié
et le brouillon, tous deux dans `COLS`) à des écrans qui n'affichent qu'un nom : la page Scénarios, la liste
des blocs, le sélecteur de campagne, l'inbox, les automations, les webhooks. Avec quelques dizaines de
scénarios c'est indolore ; avec des centaines de graphes riches, chaque écran paie le transfert et l'analyse
de tous les JSON.

Ce que les écrans TIRAIENT réellement du graphe se résume à trois choses, qui deviennent trois champs :
`nodeCount`, `hasDraft`, `campaignEligible`. Les deux premiers se calculent en SQL sans rien transporter ; le
troisième demande un parcours du graphe, et il est donc calculé côté serveur avec `scanOpening`, **la même
fonction que la garde de création de campagne** (parité déjà gardée par `tests/web-campaign-eligibility.test.ts`).
L'écran ne peut donc plus proposer un scénario que la création refuserait.

⚠️ **`list()` n'a PAS changé**, et c'est délibéré : la résolution d'un scénario ou d'un bloc par code
(`/v1/sends`) a réellement besoin des graphes. C'est `listResume()` qui sert le navigateur.

⚠️ **Ce que ça ne fait pas.** La base envoie toujours le graphe à l'application, puisque l'éligibilité en a
besoin. Ce qui disparaît est le trajet application vers navigateur et l'analyse JSON côté client, c'est-à-dire
ce que les écrans paient vraiment. Aller plus loin demanderait de dénormaliser le nombre de blocs et
l'éligibilité en colonnes tenues à l'écriture, avec le risque de péremption que ça implique : à faire le jour
où la lecture en base pèse, pas avant.

### Les deux endroits qui avaient VRAIMENT besoin du graphe

L'écran d'édition appelait déjà `GET /workflows/:id` à l'ouverture : rien à changer. Le formulaire de campagne,
lui, cherche le template d'ouverture à paramétrer : il charge désormais le graphe **au moment où l'opérateur
choisit son scénario**. Un aller-retour à ce moment-là est très largement préférable à N graphes à chaque
ouverture d'écran.

Chaque lecture côté client garde un repli sur l'ancien calcul (`campaignEligible ?? isCampaignEligible(graph)`)
: deux conteneurs ne redémarrent pas à la même seconde, et le temps d'un déploiement le front neuf peut
interroger l'API d'avant.

---
## DEPLOYE le 2026-09-01 : la reprise après un plafond Meta (migration 0103)

Troisième constat du contre-audit. Sur un plafond, le moteur rendait déjà le destinataire à la file et mettait
la campagne en pause, sans perdre personne. Mais **aucune routine ne la repassait en `running`** : il fallait
un clic, alors que le texte affiché promettait une reprise automatique. Le texte a été corrigé le jour même ;
ce lot apporte la reprise.

### La seule décision qui compte : les deux raisons ne se reprennent pas pareil

- **Débit** (130429, ou un HTTP 429 sans code connu) : une limite de CADENCE. Elle retombe seule, donc on
  réessaie après un délai borné. C'est le seul cas repris automatiquement.
- **Qualité** (131048) : Meta juge le NUMÉRO. Relancer sans rien changer aggrave le problème et peut coûter le
  numéro. `paused_until` reste nul, aucune machine ne lève cette pause, et c'est un humain qui décide.

`paused_until` nul veut donc dire « pas de reprise automatique », et c'est le DÉFAUT : une pause dont on ne
sait pas quoi penser (y compris celle qu'un opérateur pose à la main) ne repart pas toute seule.

### Trois choses à connaître avant d'y toucher

⚠️ **Un HTTP 429 sans code connu est désormais un plafond.** Angle mort relevé par l'audit : il était rejouable
dans le transport mais n'entrait pas dans `estPlafondNumero`. Une fois les tentatives épuisées, il finissait en
ÉCHEC DU DESTINATAIRE, qui n'y est pour rien et devient injoignable sans intervention, pendant que le suivant
échouait pareil. « Trop de requêtes » ne parle jamais du destinataire, il parle de nous.

⚠️ **Le délai suit le `Retry-After` de Meta, mais BORNÉ** (1 min à 1 h, 15 min par défaut). C'est Meta qui sait,
mais un en-tête absurde ne doit pas décider seul du comportement d'une campagne.

🔴 **`setStatus` écrit TOUJOURS les deux colonnes, y compris à null.** Les laisser telles quelles sur une
reprise ferait qu'une campagne repartie garderait l'échéance de sa pause d'avant, et le balayage la
« reprendrait » une seconde fois alors qu'elle tourne déjà.

⚠️ **L'ordre du balayage est l'INVERSE de celui des campagnes programmées, et c'est voulu.** Là-bas on enfile
puis on marque, pour qu'un échec d'enfilement laisse la campagne reprise au tour suivant. Ici la reprise en
base est ce qui RÉCLAME la ligne (atomique) : elle doit venir d'abord, sinon deux balayages enfileraient deux
runs. La contrepartie, une campagne `running` sans run, est exactement ce que le balayage de reprise après gel
(R4) rattrape à la minute suivante. On échange un double envoi possible contre un retard d'une minute.

---
## DEPLOYE le 2026-09-01 : la cible d'une campagne part en INTENTION, pas en liste d'identifiants

Deuxième constat du contre-audit. L'écran proposait « tout sélectionner » jusqu'à 100 000 contacts,
rapatriait tous leurs identifiants dans le navigateur, et les renvoyait dans le corps de la requête, plafonné
à 1 Mo. Le JSON des seuls identifiants pèse environ 975 Ko à 25 000 contacts : **la création échouait bien
AVANT la limite que l'écran annonçait**, et sans rien dire. L'interface promettait donc quelque chose qui
n'existait pas.

Rien de neuf n'a été inventé : le mini-CRM faisait DÉJÀ ce geste pour ses actions en masse (`allMode` +
`excluded` + une cible `BulkTarget`). Le formulaire de campagne reprend son modèle, et la route réutilise
**le même analyseur de cible** (`parseBulkTarget`, exporté de `http/contacts.ts`). Deux analyseurs auraient
fini par ne plus viser la même chose, et une cible qui dérive veut dire une campagne qui ne vise pas ce que
l'écran montrait.

### Le pire accident de ce chemin, et les quatre refus qui le ferment

Une campagne qui part à TOUT L'ESPACE. `createCampaignWithRecipients` retombe sur « charger tous les
contacts » dès que la liste d'identifiants est absente ou vide, ce qui est le comportement voulu pour
« absente » et un accident pour « vide ». D'où :

1. une cible qui ne résout **personne** est refusée (422) ;
2. une cible **illisible** est refusée (400), jamais interprétée ;
3. **`contactIds: []` est refusé** (422). 🔴 Trou PRÉ-EXISTANT trouvé en relisant ce chemin : un tableau vide
   est truthy, il traversait toutes les gardes, et la campagne partait à l'espace entier. Le test a été écrit
   AVANT le correctif et rendait 201 ;
4. **deux façons de désigner les mêmes personnes** ensemble sont refusées (liste + cible, cible + webhook),
   même doctrine que le refus liste + webhook qui existait déjà.

⚠️ `contactIds` ABSENT continue de vouloir dire « tous les contacts ». C'est documenté et voulu ; ce qu'on
refuse, c'est de DÉSIGNER une liste et de n'y mettre personne.

### Ce que la revue a trouvé, et qui valait le lot à lui seul

🔴 **Le mode « tout ce qui correspond » SURVIVAIT à un changement de source.** On cliquait « Tout
sélectionner » sur le CRM (filtres vides = tout l'espace), on basculait sur « Import fichier », et l'écran
montrait un widget d'upload vide pendant que l'état retenait encore la cible du CRM. Le bandeau qui annonce
ce mode et le compteur ne sont rendus que dans la branche CRM : plus rien à l'écran ne disait ce qui était
visé, mais « Prêt à lancer à N » restait affiché. Créer aurait envoyé les ANCIENS filtres à un opérateur
persuadé de viser son fichier. **L'accident que le lot ferme, déplacé d'un cran.**
Règle qui en sort : un état de SÉLECTION doit mourir avec l'écran qui le rend visible. S'il survit à un
changement de contexte où plus rien ne l'affiche, il devient une décision que personne ne prend.

⚠️ Les exclusions sont aussi remises à zéro à chaque changement de filtre : elles désignaient des contacts
d'un autre ensemble, les garder retirerait des gens que l'utilisateur n'a jamais vus.

⚠️ `GET /tenants/:id/contacts/ids` n'a plus aucun appelant (c'était le mécanisme du piège). La route reste
montée, la fonction cliente est supprimée, et la décision de retrait est posée dans `todo.md`.

---
## DEPLOYE le 2026-09-01 : le budget d'un numéro, partagé entre l'API et le worker (migration 0102)

Premier constat du contre-audit, et le seul qui se produisait DÉJÀ en production. `src/index.ts` et
`src/worker.ts` construisaient chacun leur arbitre de débit en mémoire ; les deux sont des conteneurs
distincts, donc un numéro avait deux budgets. Pendant qu'une campagne part du worker, un opérateur qui répond
depuis l'inbox consomme un second budget sur le même numéro. **Ce n'est pas un sujet de gros volume : ça se
produit avec un client et deux messages.**

### Le montage, et pourquoi celui-là

Le champ `nextAllowed` que le limiteur en mémoire gardait dans une variable devient une LIGNE, et la
réservation devient une instruction SQL atomique. L'algorithme ne change pas ; c'est son état qui sort du
process. Deux process qui réservent en même temps se sérialisent sur le verrou de ligne, ce qui est
exactement le comportement voulu.

Choisi contre l'autre voie possible, une file d'envoi durable partitionnée par numéro. Celle-ci aurait donné
en plus l'ORDONNANCEMENT (faire passer l'inbox devant une campagne), mais au prix d'un aller-retour de file
sur le chemin interactif, donc de la latence pour l'opérateur. **Le trou d'aujourd'hui est un trou de
COMPTAGE, pas d'ordonnancement** : on le ferme sans changer le comportement de l'inbox. La priorité reste à
prendre le jour où elle manquera vraiment.

### Les trois propriétés à connaître avant d'y toucher

🔴 **Aucune transaction n'est tenue ouverte pendant l'appel à Meta.** La réservation est UNE instruction qui
rend un nombre de millisecondes ; l'attente a lieu ensuite, hors de la base. Tenir un verrou pendant un
aller-retour réseau chez un tiers immobiliserait une connexion du pool pour tous les envois du numéro.

🔴 **En cas de panne de la base, on retombe sur le frein LOCAL, jamais sur « laisser passer ».** C'est ce qui
rend le changement sûr : le pire cas possible après cette migration est exactement le comportement d'avant.
Et un envoi ne doit pas échouer parce que la table de débit est indisponible, parce qu'un frein protège la
qualité d'un numéro, il n'autorise pas l'envoi.

⚠️ **Le temps de référence est celui de Postgres**, jamais celui des conteneurs : deux horloges qui dérivent
de quelques secondes suffiraient à laisser passer une rafale, et personne ne surveille l'heure d'un conteneur.
Les deux `now()` de l'instruction sont dans la même requête, donc la même valeur.

### Ce qui le prouve

Le test unitaire vérifie que l'attente rendue est observée et que la panne retombe sur le frein local. Il ne
peut PAS prouver le partage : c'est Postgres qui l'assure. D'où
`tests/integration/porte-debit.integration.test.ts`, avec **deux pools séparés** pour imiter deux process (un
pool unique aurait pu réussir pour une mauvaise raison, deux requêtes sur la même connexion se sérialisant de
toute façon). Six réservations alternées doivent attendre 0, 1, 2, 3, 4 puis 5 secondes ; avant la migration
elles auraient attendu 0, 0, 1, 1, 2, 2, soit le double du débit configuré.

Le SQL a aussi été éprouvé **contre la base de production dans une transaction annulée** avant tout
déploiement : la requête part vraiment (donc la syntaxe et les types sont vérifiés), et rien n'est écrit.

---
## DEPLOYE le 2026-09-01 : le lot UX + le serveur MCP (les six points de la liste de Julien)

Quatre briques, trois commits, deux migrations. Ce qui suit ne redit pas ce que `features.md` décrit : ce sont
les décisions et les pièges.

### Ce que la reconnaissance a invalidé, avant d'écrire une ligne

🔴 **Une supposition écrite dans un cadrage n'est pas un constat.** Deux affirmations du document de cadrage
étaient fausses, et les vérifier a changé le plan :
1. Le groupe « AI Agent » et la période du qualitatif EXISTAIENT DÉJÀ. Le travail restant sur la nav n'était
   pas « créer un menu » mais « ajouter un troisième niveau au modèle », et il n'y avait rien à faire sur la
   période.
2. L'origine d'un message de service n'était PAS dérivable. Les envois de scénario (`wiring.ts`) et les
   réponses de l'agent IA (`envoyerTexteAgent`) écrivent tous les deux `type: 'text'` avec
   `sender_user_id = null` : rien ne les séparait.

### Migration 0099 : l'origine d'un message sortant

- Colonne **NULLABLE et sans défaut**. Un `not null` aurait fait échouer une insertion sur le chemin chaud du
  webhook le jour d'un oubli d'appelant, c'est-à-dire l'incident du 2026-08-17. La garde contre l'oubli est
  posée là où elle ne coûte rien en production : le paramètre `origine` est **obligatoire dans la signature
  TypeScript**, donc un chemin d'écriture oublié ne compile pas. Le compilateur a désigné les six appelants.
- La lecture de l'historique (`src/inbox/origine.ts`) est **bornée dans le temps**. Avant la bascule, un
  sortant hors template sans expéditeur humain vient forcément d'un scénario : **mesuré** le 2026-09-01 sur la
  base de production, `agent_sessions` était vide. Après la bascule, une origine absente ressort en
  « indéterminée » À L'ÉCRAN. Sans cette borne, un chemin ajouté plus tard sans poser son origine serait
  compté comme du scripté, en silence et pour toujours.
- Le fragment SQL de classement est **partagé** entre l'agrégat et le détail : un total et sa ventilation qui
  classeraient différemment ne tomberaient plus juste.

### Migration 0100 : le résumé de conversation

`justification` explique le CLASSEMENT, pas ce qui s'est dit. La montrer comme un résumé aurait été un
raccourci qu'on ne voit plus une fois pris. Colonne nullable, **jamais remplie rétroactivement** : la fiche
affiche un repli nommé. Le champ est `.optional()` dans le schéma Zod (comme `abusive` avant lui) pour qu'un
modèle qui l'omet ne fasse pas perdre toute l'analyse, et une chaîne vide est écrite `null` : l'absence doit
rester distinguable d'un résumé vide, parce que l'écran ne dit pas la même chose des deux.

### Serveur MCP : les trois décisions qui portent le reste

🔴 **`/v1` ne compte que quatre endpoints et AUCUNE lecture.** « MCP = façade mince sur /v1 » était donc faux :
les outils de lecture n'avaient aucun endpoint à appeler. La règle retenue est plus forte et plus simple :
**un outil MCP n'a jamais de logique métier à lui, il appelle la fonction que la route de console appelle.**
C'est ce qui a fait extraire `src/inbox/repondre.ts` (`repondreDansLaFenetre`), désormais partagé par la route
d'inbox et par l'outil `reply_in_open_window`. Une copie qui dérive ici ne produit pas un affichage bancal :
elle produit un agent tiers qui envoie des WhatsApp avec des garde-fous différents de ceux de l'interface.

🔴 **Transport écrit à la main, sans le SDK officiel.** La surface utile tient en cinq méthodes
(`initialize`, `notifications/initialized`, `tools/list`, `tools/call`, `ping`), et le SDK apporte une gestion
de session et un canal SSE dont un serveur d'outils **sans état** n'a aucun usage. Sans état est un choix :
ni `Mcp-Session-Id` ni reprise de flux, donc deux requêtes du même client peuvent tomber sur deux process
différents. C'est ce qui permettra d'en lancer une seconde instance.

🔴 **Un refus MÉTIER est un RÉSULTAT, pas une erreur de protocole.** Fenêtre de 24 h fermée, conversation
inconnue : `isError: true` dans le résultat, avec la raison en clair. Une erreur JSON-RPC dirait au modèle
« l'outil est cassé » au lieu de « ta demande n'était pas recevable, lis pourquoi ». Seule une panne réelle
sort en `-32603`, et son message d'origine n'est PAS renvoyé (il peut porter un fragment de requête SQL ou de
réponse Meta).

⚠️ **Deux détails d'autorisation qui ne se devinent pas.** (1) Un outil hors des scopes de la clé n'est même
pas LISTÉ, et le refus d'appel dit « inconnu ou non autorisé » : distinguer les deux renseignerait un porteur
de clé sur des capacités qu'on lui refuse. (2) Les scopes MCP ne sont PAS cochés d'avance à la création d'une
clé (`API_SCOPES_PAR_DEFAUT`) : l'écran cochait tout quand il n'y avait que deux droits, et laisser ce geste
aurait donné à toute clé neuve le droit d'envoyer des WhatsApp au nom du client.

⚠️ **Aucun outil n'émet d'événement d'automation.** Le CLAUDE.md range l'API publique parmi les chemins qui
n'émettent pas ; un serveur MCP en est une. Un agent qui boucle sur 500 conversations déclencherait sinon 500
automations, donc des envois facturés que personne n'a demandés. La page Developers le dit à l'intégrateur.

🔴 **Ce que la revue du lot a trouvé, et qu'il faut retenir.** Deux bloquants, tous les deux sur la surface
d'écriture ouverte aux tiers :

1. **Le lot JSON-RPC contournait le plafond de débit.** Le quota se compte UNE FOIS PAR REQUÊTE HTTP, dans le
   preHandler de la clé. Un tableau accepté laissait donc passer, pour une seule unité de quota, autant
   d'appels `reply_in_open_window` que le corps de 1 Mo peut en contenir : des milliers d'envois Meta réels
   dans un seul POST. C'est exactement le mégaphone que le lot dit avoir fermé en n'exposant pas
   `send_template`, rouvert par le VOLUME au lieu de la fonctionnalité. Le lot est désormais REFUSÉ, ce qui
   est aussi la bonne réponse de protocole (il a été retiré de MCP en 2025-06-18).
   **Règle générale : quand un plafond se compte par requête, tout mécanisme qui met N actions dans une
   requête est un contournement du plafond.**
2. **Une réponse MCP était enregistrée « scenario ».** `recordOutbound` DÉDUISAIT l'origine de l'expéditeur.
   Vrai tant que ses appelants étaient tous des routes de console ; faux dès qu'un appelant sans expéditeur
   humain est apparu. Et la faute était INVISIBLE : la valeur fausse étant écrite explicitement, le repli
   « indéterminée » de la migration 0099 ne pouvait pas se déclencher. Le paramètre est devenu obligatoire
   (migration 0101, origine `mcp`).
   **Règle générale : une valeur déduite d'un autre champ n'est une garde que tant que la liste des appelants
   ne bouge pas, et une liste d'appelants bouge toujours.**

⚠️ **`control_owner` reste `app_human` pour un agent tiers**, et c'est un choix. `ControlOwner` n'a que trois
valeurs ; ce qui compte est que le scénario cesse d'avancer TOUT SEUL et que MBA cesse de répondre, ce que
`app_human` produit exactement. La distinction « qui a parlé » est portée là où elle sert et où elle ne coûte
pas de migration du chemin chaud : l'origine du message.

⚠️ **Le rewrite `/mcp` est GELÉ AU BUILD** de l'image web, comme `/r/:code` et `/m/:fichier`. Toute
modification de `web/next.config.mjs` exige `up -d --build`. `tests/rewrites-web.test.ts` garde les quatre.

---
## DEPLOYE le 2026-09-01 : banc de charge et de reprise après kill (dernier item ouvert du lot 8)

**Ce qui a été mesuré, et comment.** Postgres 16 jetable sur le VPS, worker réel en `DRY_RUN=true` (le sender
de démo rend un identifiant sans appeler Meta), campagne de 400 destinataires, `kill -9` du worker en plein
envoi. Script rejouable : `scripts/banc-charge.mts`, avec DEUX gardes indépendantes avant la moindre écriture
(`BANC_CONFIRME=1`, et refus de toute chaîne de connexion qui ressemble à Supabase).

🔴 **CE QUE LE BANC A TROUVÉ, et c'était une perte SILENCIEUSE et DÉFINITIVE.** Le destinataire en vol au
moment du kill reste à l'état `sending`. Le run suivant ne le voit pas (`listPending` ne rend que les
`pending`), vide la file et marque la campagne **`completed`** : 399 envoyés sur 400, campagne « terminée ».
Dix minutes plus tard `reclaimStale` fait son travail et le remet en `pending`... sur une campagne TERMINÉE,
que la reprise ne relance plus (elle ne regarde que les `running`). Ce contact ne recevait jamais son message,
et rien ne le disait. Corrigé : le statut de sortie d'un run reste `running` tant qu'un destinataire est
réservé.

**Ce que le banc a prouvé, et qui tient :**
- **zéro destinataire envoyé deux fois** après le kill : le claim atomique fait son travail ;
- la campagne **repart toute seule**, sans intervention, en **trois minutes au plus** : le bail du verrou de
  run dure 120 s et le balayage de reprise passe toutes les 60 s. Mesuré : 92 envoyés au moment du kill,
  reprise automatique, 400 traités à la fin ;
- `reclaimStale` récupère bien le destinataire coincé.

⚠️ **Ce que le banc ne peut PAS prouver, et qu'il faut savoir** : le destinataire coincé a `message_id` NULL,
donc on ignore si son message était déjà parti chez Meta quand le process est mort. Le rejouer peut produire
**un double envoi par kill brutal et par run**. Le fermer demanderait une idempotence côté Meta, pas une garde
de plus chez nous.

⚠️ **Ce que ce banc ne mesure PAS non plus** : le débit d'une campagne. Il est plafonné à **80 messages par
minute** par une contrainte de base (migration 0033), donc décidé par nous et pas par la tuyauterie. Le débit
qui se mesurerait vraiment est celui de la file des ENTRANTS, qui n'a pas ce plafond.

---
## DEPLOYE le 2026-09-01 : programme II, lot 4 (la rétention des quatre dernières tables non bornées)

Événements de blocs, parcours terminés, clics tracés, journal d'audit : quatre tables qui grossissaient depuis
le premier jour, dont deux portent un numéro de téléphone. Migration 0097 (hors transaction), quatre index
dédiés : ⚠️ les index de LECTURE existants ne servaient à aucun de ces balayages, parce qu'ils commencent tous
par `tenant_id` alors qu'une purge balaye la table entière par date. C'est le cas où « il y en a déjà un » est
faux.

🔴 **Deux natures, deux traitements, et c'est le point du lot.**
- Les **événements de blocs sont ANONYMISÉS**, jamais supprimés (`wa_id = 'anonyme'`). Ils SONT la mesure des
  tableaux, et il n'existe aucune statistique rétroactive (migration 0063) : les effacer viderait l'historique
  du client pour retirer un numéro. On retire le numéro et on garde le compteur, exactement la décision déjà
  prise pour la purge d'un contact et pour `campaign_recipients.to_e164`. ⚠️ Corollaire assumé : ce balayage
  ne borne PAS la croissance de cette table, il ferme le risque RGPD. Le volume sera un pré-agrégat, pas une
  purge.
- Les **trois autres sont supprimées** : plus personne ne les relit.

🔴 **Deux garanties de NON-effacement, testées pour elles-mêmes.**
1. Un parcours **vivant** (`waiting`, `sleeping`) n'est jamais purgé, quel que soit son âge. La garde est posée
   DEUX fois : dans la requête, et dans le prédicat de l'index partiel. Un run en attente depuis un an est une
   anomalie à corriger ailleurs, sûrement pas une ligne à supprimer sous les pieds d'un contact.
2. Purger les clics ne touche **jamais** `tracked_links`. Porte à sens unique : un lien supprimé est une
   adresse morte dans des messages déjà livrés, sans recours.

🔴 **Une rétention à ZÉRO ne purge RIEN, et ce n'est pas cosmétique.** Vérifié sur le banc :
`make_interval(days => 0)` vaut « maintenant », donc `at < now()` est vrai pour TOUTE ligne. Sans le
`if (days <= 0) return 0`, régler une rétention à 0 en croyant la désactiver viderait la table entière,
immédiatement. Un test le fixe pour les quatre méthodes.

**Les durées, et leur logique** : courtes là où il y a une donnée personnelle (blocs 365 j, parcours 90 j),
longues là où il n'y en a pas (clics et journal 730 j), puisque la question n'y est que le volume et que le
journal d'audit est la PREUVE qu'une purge a eu lieu. Le raccourcir reviendrait à effacer l'attestation en
gardant l'obligation.

**Vérifié avant de pousser**, sur un postgres:16 jetable : migration appliquée, purge qui épargne le parcours
en attente, et plan qui utilise bien le nouvel index partiel. En production le balayage est resté muet, ce qui
est correct : les 22 parcours terminés, 89 événements, 79 clics et 9 entrées de journal sont tous récents.

---
## DEPLOYE le 2026-09-01 : programme II, lot 3 (les entrants en parallèle, ordonnés par contact)

**Ce qui changeait.** La file des messages entrants traitait UN job à la fois, tous clients confondus : un
envoi Meta lent ou un appel HubSpot qui traîne, et la réponse d'un autre client attendait derrière. C'est le
« noisy neighbour » de l'audit, sur le chemin le plus visible du produit.

🔴 **Les deux options vont ENSEMBLE, et c'est tout le sujet.** `concurrency` seul remettrait le désordre entre
deux messages d'un même contact : le verrou d'avance conditionnelle (lot 1 du programme I) protège l'ÉTAT du
parcours, pas les EFFETS, et deux messages envoyés dans le désordre restent envoyés dans le désordre.
`groupConcurrency` seul serait un NO-OP, pg-boss n'ayant rien à répartir tant qu'un seul job est en vol. Un
test statique lit désormais `src/worker.ts` et refuse l'une sans l'autre, vérifié dans les deux sens.

**La clé de groupe est `phone_number_id:wa_id`**, calculée par le receveur SANS toucher la base (il doit
accuser réception à Meta immédiatement). Un numéro appartient à un seul espace, donc deux espaces ne peuvent
pas partager une clé : le cloisonnement tient sans lecture. Elle vaut `undefined` dès que le payload ne désigne
pas UN contact et un seul (plusieurs contacts, `wa_id` masqué par un BSUID, bascule de contrôle dont la forme
n'est pas documentée) : même doctrine conservatrice que l'aiguillage des accusés, dans le doute on renonce à
l'optimisation plutôt que d'inventer un ordre faux.

**Concurrence à 3, avec l'arithmétique.** Le worker tient déjà 4 runs de campagne en parallèle, plus les
accusés, les automations et les tours d'agent ; le pool applicatif est de 8 connexions PAR PROCESS, valeur
mesurée comme la capacité réelle du pooler. Relever `WEBHOOK_CONCURRENCY` demande de refaire ce calcul, pas
seulement de changer la variable.

⚠️ **La garantie d'ordre est LOCALE au process** (`localGroupConcurrency`). Avec un second worker elle tombe :
c'est le lot 8. `automation-event` reste à un job en vol, donc ordonnée par construction, et la note est posée
à l'endroit exact où quelqu'un voudra lui donner de la concurrence.

**Refactor préalable, commit séparé.** `handleWebhookJob` prenait DOUZE paramètres positionnels : l'appel de
la file des accusés s'écrivait avec sept `undefined` d'affilée, dont aucun lecteur ne peut dire ce qu'ils
désignent, et où insérer un paramètre au mauvais rang changeait le câblage en silence (tout est optionnel et
de types voisins, le compilateur ne bronchait pas). Dépendances nommées, corps inchangé, seize appels de test
convertis, même leçon que `enqueueCampaignRun`.

---
## DEPLOYE le 2026-09-01 : programme II, lots 1 et 2 (index des chemins chauds, et ce qui se dégradait en silence)

**Lot 1, le runner AVANT les index, et l'ordre n'est pas négociable.** `db/migrate.ts` jouait tout dans une
transaction, donc `CREATE INDEX CONCURRENTLY` y était interdit : le premier index sur une grosse table aurait
bloqué les écritures en plein déploiement. D'où la directive `-- migrate: no-transaction` (migration 0096, la
première du dépôt à s'en servir).

🔴 **Le piège qui rendait la directive INUTILE, et qui a failli passer.** Postgres exécute une requête simple
contenant PLUSIEURS instructions dans une transaction IMPLICITE. Retirer le `begin`/`commit` ne suffisait donc
pas : envoyer le fichier entier en un `client.query()` gardait `CONCURRENTLY` illégal. Mesuré dans un
postgres:16 jetable : deux `CONCURRENTLY` dans un seul `psql -c` échouent, les mêmes en deux `-c` passent. Le
runner envoie désormais **instruction par instruction** (`decouperInstructions`, conscient des chaînes, des
commentaires et des dollars). Contrepartie assumée et écrite dans le runner : une migration hors transaction
n'a **aucun filet**, elle est rejouée depuis le début après un échec, donc chaque instruction doit être
idempotente. `tests/migration-directives.test.ts` garde les deux sens sur les fichiers réels.

**TROIS index, pas quatre, et c'est la mesure qui a tranché.** Banc jetable, 200 000 lignes, plans réels :
résolution `wa_id` -> contact **54,96 ms -> 0,20 ms** (BitmapOr des trois branches) ; `reclaimStale`
**16,01 ms -> 0,17 ms** ; préfixe téléphone en Index Scan, y compris en plan générique. L'index réclamé par
l'audit pour le `NOT EXISTS` du funnel n'a **pas** été posé : le plan et le temps ne bougent pas (186 -> 184 ms),
Postgres préfère un Hash Anti Join complet, et un index posé « au cas où » se paie à chaque écriture.

⚠️ **Deux commentaires FAUX corrigés au passage**, tous deux démentis par un `explain` sur la production :
le `like` ancré sur `phone_e164` n'utilisait PAS l'index unique (un btree ordinaire ne borne pas un préfixe
hors collation C, d'où `text_pattern_ops`), et le GIN `contacts_fields_gin` de la migration 0032 ne sert PAS
`fields ->> clé` (noté pour le lot 6).

⚠️ **Sur la production d'aujourd'hui, ces index ne changent RIEN** : 12 contacts, 51 destinataires, Postgres
les ignorera à raison. Ils sont posés à froid, exactement pour la raison donnée à propos du quota par numéro :
construire un index d'expression sous charge est une opération à cœur ouvert.

**Lot 2, deux dégradations silencieuses.** (1) `setInterval` ne saute pas un tour parce que le précédent n'est
pas fini : une passe plus lente que sa cadence se superposait à elle-même, et **un seul des dix-sept balayages
se protégeait**. La garde est posée dans le registre `src/worker/taches.ts`, donc elle couvre les dix-sept et
les suivants. Le saut est journalisé avec le nombre de tours sautés d'affilée, sans quoi on aurait échangé une
contention contre une invisibilité. ⚠️ Limite connue : elle protège les passes PÉRIODIQUES entre elles, pas la
passe de démarrage lancée à côté par l'appelant, d'où la garde locale conservée sur `reveil-parcours`.
(2) Le POST de webhook refusé rendait 403 **sans écrire une ligne**. Trois causes distinguées, parce qu'elles
ne disent pas la même chose : signature ABSENTE (un scanner), signature INVALIDE (**Meta nous parle et notre
secret ne correspond plus, donc 100 % des entrants jetés**, la panne indiagnosticable du 2026-08-17), corps
absent. Au plus une ligne par cause et par minute, avec le compte depuis la dernière ligne, et jamais le corps
ni la signature reçue. Le test de rafale a trouvé un vrai défaut de comptage : la ligne annonçait 51 pour 50.

---
## DEPLOYE le 2026-09-01 : lot 7, un brouillon et une version publiée pour les scénarios

**Ce que ça ferme.** `workflow_runs` porte `workflow_id` et `current_node`, jamais une version : modifier un
bloc changeait les parcours DÉJÀ démarrés, dans la seconde, sans que personne l'ait demandé.

**Les quatre décisions de Julien (2026-09-01) ont divisé le lot par trois.** Un parcours en cours SUIT la
version publiée (pas d'épinglage), et une campagne programmée prend la version en ligne le jour de
l'expédition. La version publiée est donc la SEULE qui existe à l'exécution : ni table de versions, ni colonne
`workflow_version_id` par run, ni migration des runs existants, ni sémantique de retour arrière. Deux refus
explicites : **pas de conservation de la version précédente** (« on s'encombre pas de l'ancienne version »), et
**un contact qui attend sur un bloc supprimé par la nouvelle publication reste clos en silence** (« tant pis on
assume que le user tombe dans le vide »).

🔴 **LE POINT DE CONCEPTION : `graph` reste le PUBLIÉ, et `draft_graph` est le nouveau.** Une douzaine de
chemins lisent `graph` pour exécuter (exécuteur, campagnes, automations, API publique par code, mesures,
comptage de blocs). Nommer le brouillon `graph` aurait fait basculer les douze d'un coup, et le moindre oubli
aurait mis un brouillon en ligne sans que rien ne le signale. Dans ce sens-ci, un oubli lit le publié : le
pire cas est de ne pas voir une modification, pas d'en envoyer une qui n'était pas prête. **Seuls deux
chemins lisent le brouillon**, tous deux par `grapheEditable(row)` : l'éditeur, et le lien de test.

**Deux gardes MESURÉES, pas supposées.**
1. **Ouvrir un scénario déclenche UN enregistrement** (mesuré le 2026-09-01 avec une sonde Playwright : React
   Flow remesure les blocs au montage, ce qui change `nodes`, ce qui réveille l'auto-save). Sans garde, tout
   scénario simplement CONSULTÉ aurait porté « brouillon non publié » à vie. D'où le `case when $4::jsonb =
   graph then null` de `update` : un brouillon identique au publié n'en est pas un.
2. **Publier vide d'abord la file d'enregistrement** (`enregistrerMaintenant`). L'auto-save attend 1,2 s :
   sans ce vidage, un clic dans cette fenêtre mettait en ligne le brouillon d'AVANT la dernière frappe, en
   affichant « en ligne ». Vérifié DANS LES DEUX SENS : le test e2e échoue si on retire le vidage. La boucle
   d'attente n'est pas du zèle non plus, parce que `doSave` rend la main tout de suite si un PATCH est déjà
   en vol : l'attendre ne prouverait rien dans ce cas précis.

**Le reste des choix.** `publish` promeut avec un `coalesce(draft_graph, graph)` (sans lui, republier deux
fois d'affilée écraserait le publié par NULL, donc effacerait le scénario de la production sur un double-clic)
et ne redate que s'il y avait quelque chose à mettre en ligne. `insert` écrit le BROUILLON : une création, une
duplication, rien n'est en ligne tant qu'on n'a pas publié, une seule règle. Dupliquer copie ce qu'on VOIT.
QUI a publié va au journal d'audit (`workflow.published`), pas dans une colonne : le mécanisme existait.

**Refactor préalable, dans un commit séparé** (règle : jamais refactor et comportement ensemble).
`WorkflowBuilder.tsx` passait de 1 860 à 573 lignes, en trois sorties posées sur des frontières qui existaient
déjà : `WorkflowNode.tsx` (props React Flow + `CustomEvent`), `WorkflowConfigPanel.tsx` (reçoit un bloc, rend
un patch), `lib/use-enregistrement-scenario.ts` (l'enregistrement, c'est-à-dire exactement le code que le lot
allait modifier), plus `lib/workflow-canevas.ts` pour la frontière graphe <-> canevas. Les 64 tests e2e du
builder passent sans modification.

**Migration 0095, BLOQUANTE** (le code écrit `draft_graph`) : migrer AVANT de déployer.

---
## DEPLOYE le 2026-08-29 : le bloc Question, des sorties qu'on voyait sans pouvoir les relier

Symptôme rapporté par Julien : « certains boutons de réponses restent rouges et je ne peux pas les relier […]
puis je vais dans l'inbox et je reviens et là je peux les relier ».

🔴 **Cause racine, lue dans `@xyflow/system` 0.0.79.** React Flow garde les positions des poignées EN CACHE
(`node.internals.handleBounds`) et ne les remesure que si la taille EXTÉRIEURE du bloc change, ou sur ordre
(`updateNodeInternals`). Or `onPointerDown` commence par résoudre la poignée de départ DANS CE CACHE, et sort
**en silence** si elle n'y est pas : le point se voit, se survole, et le glisser ne commence jamais. Passer par
l'inbox remontait le composant, donc vidait le cache, d'où le contournement que Julien avait trouvé seul.

Ce qui rendait le cache faux : `handleSig`, une signature ÉCRITE À LA MAIN censée reproduire le JSX, qui avait
déjà dérivé à deux endroits. Une ligne de menu au libellé VIDE compte dans `rows` mais ne dessine aucune
poignée ; taper son libellé en ajoute une sans changer ni la signature ni la hauteur du bloc. Idem pour un
bouton qui passe de « lien » à « réponse rapide ». Dans les deux cas, la poignée naissait morte.

**Le correctif ne répare pas les deux cas, il supprime la classe entière** : la signature est désormais LUE
DANS LE DOM (les poignées réellement présentes, dans leur ordre), c'est-à-dire la même chose que React Flow
mesure. La dérive devient impossible par construction, et ce qu'on ajoutera plus tard est couvert d'avance.
Test : `web/e2e/workflow-sorties-multiples.spec.ts`, « une réponse AJOUTÉE À L'INSTANT se relie ».

---
## DEPLOYE le 2026-08-31 : LOT 6 (1re moitié), les accusés ne passent plus devant les messages

Une seule file `webhook` traitait TOUT : les messages entrants, les accusés de livraison, et l'avance des
scénarios. Or une campagne de 5 000 messages produit **trois accusés par destinataire**, soit quinze mille
jobs qui passaient DEVANT la réponse d'un vrai client, lequel attendait derrière toute la rafale.

**L'aiguillage est au RECEVEUR**, et il ne pouvait pas être ailleurs : router depuis le worker aurait laissé
la rafale s'empiler dans la même file d'abord, ce qui ne résout rien. Le receveur ne parsait rien, exprès,
pour répondre à Meta immédiatement ; le test ajouté est un parcours d'objet de quelques microsecondes.

**La règle est volontairement stricte et conservatrice** : un payload part sur `webhook-status` s'il contient
AU MOINS un accusé et RIEN d'autre. Message, echo, changement de contrôle, payload mixte, forme inconnue :
tout cela reste sur la file des entrants, qui sait aussi traiter les accusés. On ne perd donc jamais un
événement ; au pire on renonce à l'optimisation. Le traitement est la MÊME fonction, avec les seules
dépendances de livraison : rien n'est dupliqué.

⚠️ **Conséquence assumée** : l'ordre relatif entre un accusé et un message entrant n'est plus garanti. Ils
touchent des lignes différentes (un accusé met à jour un envoi par son `message_id`, un entrant crée une
conversation), donc aucun invariant n'en dépend. C'est écrit dans le code parce que ça ne se devine pas.

Pas de concurrence sur cette file : deux accusés du même message (`sent` puis `delivered`) doivent s'appliquer
dans l'ordre, et c'est sa sérialisation qui le garantit. Sa cadence est de 30 s, comme les traitements de
fond : personne n'attend un accusé, et les espacer réduit d'autant l'egress de la rafale.

**Ce que la garde de files a attrapé tout de suite** : `webhook-status` déclarée sans consommateur. Le test
qui exige que toute file de `BASE_QUEUES` ait un `queue.work` dans le worker a échoué à la seconde où la
déclaration a été ajoutée, avant même que le consommateur soit écrit. C'est exactement le trou qu'il existe
pour fermer (`agent-turn` avait vécu plusieurs jours déclarée et non consommée).

### `CampaignCreateForm` : une extraction, et le refus argumenté des autres

1 686 lignes et 48 états. **`useCampagneReferences` est sorti** (`web/lib/use-campagne-references.ts`) :
templates, scénarios, champs, tags, réglages de l'espace, plus leur indicateur d'attente et le rechargement
des templates. Huit états, un effet et un `useCallback` en moins dans le composant, qui tombe à 1 641 lignes
et 40 états.

🔴 **Le critère du choix est celui de l'audit lui-même** : « une extraction mécanique ne réduit pas la
complexité d'état ». Ce bloc-ci est une concern COHÉRENTE (un chargement, ses données, son attente) qui
n'interagit avec AUCUN état de saisie. Les trois autres découpages proposés ne le sont pas :

- **les zones de rendu** (Destinataires, Message) lisent et écrivent quinze à vingt états chacune : en faire
  des composants demanderait autant de props, c'est-à-dire déplacer la complexité, pas la réduire ;
- **l'enregistrement du brouillon** construit son état à partir d'une vingtaine de champs de saisie : le
  passer en `hook` produirait exactement le « hook opaque à 48 états » que l'audit interdit ;
- **le réducteur de lancement** vaut d'être fait, mais l'audit demande d'abord des tests sur l'hydratation,
  l'autosauvegarde, le changement de type de contenu et le double clic de lancement. Ces tests-là sont le
  vrai préalable, et ils sont un lot en soi.

⚠️ `onErreur` est passé en dépendance EXPLICITE au hook, plutôt qu'un `setError` interne : sinon l'écran
aurait deux endroits où il affiche ses erreurs, dont un invisible depuis le formulaire.

Vérifié par les **18 tests E2E de campagne** (brouillons, contacts dégradés, template créé à la volée avec son
sondage d'approbation, filtre de scénarios, RCS), tous verts après extraction.

### Ce qui NE sera PAS fait, et pourquoi

Les fonctions `register*Jobs` du worker, reportées du lot 3, **ne seront pas écrites**. L'audit demandait de
ranger `worker.ts` avant d'y ajouter des files, et sa propre grille dit comment juger : « mesurer le nombre de
DÉPENDANCES et les tests isolables, pas le nombre de lignes ». Or chaque bloc de composition y utilise une
douzaine de stores : `registerCampaignJobs(...)` prendrait quinze paramètres, ou bien un objet fourre-tout,
c'est-à-dire un localisateur de services que l'audit interdit explicitement. On échangerait une composition
linéaire et lisible contre six fonctions à longue signature. Le gain réel du lot 3 était le REGISTRE DE
TÂCHES, qui a effectivement trouvé trois minuteries jamais arrêtées et un chemin de crash ; celui-ci n'a pas
d'équivalent.

---
## DEPLOYE le 2026-08-31 : LOT 5 du programme, campagnes en lots courts et concurrence (aucune migration)

**Le problème** : `queue.work('campaign-run')` ne passait AUCUNE option, donc aucune concurrence, et un job
traitait sa campagne **jusqu'à épuisement**. 5 000 destinataires à 30/min, c'est 2 h 47 pendant lesquelles la
file ne sert personne d'autre. La campagne d'un client bloquait littéralement celles de tous les autres.

**Une DURÉE, pas un nombre de destinataires.** Le run s'arrête entre deux destinataires au bout de
`CAMPAIGN_RUN_MAX_MS` (2 min), rend `reste: true`, et le job le réenfile. Un nombre fixe serait faux des deux
côtés : à 1/min un lot de 100 durerait plus d'une heure, à 80/min une minute. C'est le temps d'occupation de
la file qu'on borne.

🔴 **Deux gardes qui font la différence entre un découpage et une boucle infinie.**
1. La sortie n'est prise que si du travail a DÉJÀ été fait (`traites > 0`). Sans ça, une durée mal réglée
   ferait un run qui n'envoie rien, se réenfile, n'envoie rien... pour l'éternité, en tournant à plein régime.
2. La campagne reste `running` : ce n'est pas une pause, personne n'a rien décidé. Le statut n'est pas
   réécrit, exactement comme pour l'arrêt du service.

Et la relance se fait **après avoir rendu le verrou**, sinon le job suivant se heurterait à lui et se
contenterait de demander un rerun, ce qui rallongerait le trajet pour rien.

**La concurrence, désormais sûre.** `concurrency: 4` avec `groupConcurrency: 1`, le groupe étant l'ESPACE :
quatre runs en parallèle, mais un seul par client. Un client n'attend plus la campagne d'un autre, et deux
campagnes du même client restent sérialisées (elles partagent de toute façon un seul numéro, donc un seul
budget d'envoi). 🔴 **Ceci n'est sûr QUE parce que le lot 4 est en place** : sans frein partagé par numéro,
deux runs en parallèle doubleraient le débit réel, ce que Meta observe et sanctionne.

**La garde statique a payé, deux fois.** Elle exigeait déjà que tout enfilement de `campaign-run` porte son
expiration ; elle exige maintenant qu'il porte son GROUPE. Elle a immédiatement trouvé **trois enfilements
sans groupe** : les campagnes programmées, le lancement manuel et le renvoi d'un destinataire. Chacun aurait
échappé au plafond par espace, c'est-à-dire aurait permis à un seul client d'occuper toute la file, ce que
la concurrence est précisément censée empêcher.

`enqueueCampaignRun` prend désormais un objet plutôt que quatre paramètres positionnels : à ce nombre on
finit par en inverser deux, et une inversion entre le compte et le débit ne se voit que sur une campagne
longue. `getRunSizing` et `listDueScheduled` rendent le `tenantId` au même endroit que le dimensionnement,
pour ne pas payer une seconde requête à chaque relance.

---
## DEPLOYE le 2026-08-31 : LOT 4 du programme, le débit partagé par NUMÉRO (aucune migration)

Le seul frein d'envoi du dépôt était instancié **par run de campagne** : deux campagnes du même numéro avaient
deux budgets, et 30/min configurés en faisaient 60. Les trois autres chemins d'envoi (réponse d'inbox, message
de scénario, automation) n'avaient **aucun** frein. Le débit réel d'un numéro n'était donc borné par rien,
alors que c'est lui que Meta observe et sur lequel il fonde la qualité et les paliers.

**Le point de pose est ce qui fait la valeur du lot.** `MetaClientFactory.clientForTenant` est l'endroit où
les quatre chemins se rejoignent : campagne, scénario, automation et inbox y construisent tous leur client.
Une ligne y injecte la porte du numéro, `MetaClient.call` l'acquiert avant chaque appel `messages`, et un
chemin d'envoi FUTUR en hérite sans que personne y pense. Aucun appelant n'a été modifié.

**L'arbitre ne remplace pas le débit par campagne, il s'y ajoute, en série.** Le débit de campagne dit « à
quelle vitesse je veux que CETTE campagne parte » (1 à 80/min, c'est une fonctionnalité de l'écran) ;
l'arbitre dit « ce numéro ne dépassera jamais ça ». D'où le défaut de `PHONE_RATE_PER_MINUTE_MAX` à **80** :
c'est exactement le maximum qu'une campagne peut choisir, donc une campagne seule n'est jamais bridée, et deux
campagnes se partagent 80 au lieu d'en faire 160.

🔴 **Ce que ça ne fait PAS.** Le budget est en mémoire, donc **par process** : l'API et le worker en ont
chacun un. Le worker porte tout le volume ; l'API ne porte que les envois d'un humain dans l'inbox, à cadence
humaine. Le pire cas théorique est deux fois le plafond. Rendre le budget réellement partagé (base, ou
affectation exclusive d'un numéro à un worker) est le **prérequis du second worker**, pas de celui-ci.

Le RCS n'est pas concerné : il ne passe pas par Meta et a ses propres quotas fournisseur. Les mélanger ferait
qu'une campagne RCS ralentirait WhatsApp sans raison.

⚠️ Effet de bord assumé : quand une campagne tourne à plein régime, une réponse d'opérateur peut attendre son
tour (au plus l'intervalle du numéro, 750 ms à 80/min). Donner la priorité aux messages humains est un
raffinement séparé, noté dans la synthèse (§A2).

**Un détail de couches, corrigé au passage** : `MetaClientOpts.rateLimiter` était typé sur la CLASSE
`RateLimiter`. L'interface `PorteDeDebit` est désormais déclarée dans `meta/http.ts`, la couche la plus basse,
pour que le client Meta n'ait rien à importer de la couche campagne.

---
## DEPLOYE le 2026-08-31 : LOT 3 du programme, le registre des tâches du worker (aucune migration)

Refactor **neutre en comportement**, sauf sur un point qui est une correction de bug, dit plus bas.

Le worker programmait dix-sept `setInterval` et devait les arrêter **une par une**, à la main, dans son arrêt
propre. Ce couplage a exactement le défaut qu'on attend de lui : on oublie. Deux tâches y avaient déjà
échappé historiquement (le code le disait dans un commentaire), et **les deux balayages de rétention ajoutés
le jour même** n'y étaient pas non plus, découverts en écrivant le registre. Un oubli ne casse rien tout de
suite (les minuteries sont `unref`) : il se voit à l'arrêt, quand une passe part pendant qu'on ferme le pool,
et laisse une erreur à chaque déploiement.

`src/worker/taches.ts` : programmer et arrêter deviennent le MÊME geste. `taches.arreterTout()` remplace les
dix-sept `clearInterval`, et les quatre variables `let ...Sweeper` des tâches conditionnelles disparaissent.

🔴 **Le bug trouvé en écrivant le test, et corrigé ici.** `setInterval(() => void f())` laisse un rejet NON
RATTRAPÉ si `f` rejette, et depuis Node 15 un rejet non rattrapé **tue le process**. Chaque balayage attrape
déjà ses erreurs, mais rien ne le garantissait : il suffisait que le `catch` lui-même échoue (l'alerte
Telegram qui lève) pour que le worker meure en silence, sans autre trace qu'un redémarrage. Le registre
enveloppe donc chaque passe. C'est le seul écart de comportement du lot, et il va dans le sens de la survie.

⚠️ **Ce que le registre ne fait PAS** : lancer la première passe. Les appelants qui balayent au démarrage
gardent leur `void passe()` là où ils l'écrivaient. Le rendre implicite ferait démarrer quinze balayages qui
ne le faisaient pas, c'est-à-dire un changement de comportement caché dans un refactor.

**La seconde moitié de l'item (les fonctions `register*Jobs`) est reportée au lot 6**, et c'est la logique de
l'audit lui-même : elle sert « avant d'y ajouter de nouvelles files », or c'est le lot 6 qui en ajoute (en
séparant les entrants des accusés). L'extraire maintenant serait un gros diff sans utilisateur.

---
## DEPLOYE le 2026-08-31 : LOT 2 du programme, la rétention des conversations (migration 0094)

La moitié restante de 5.2. Les conversations, leurs messages et leur analyse qualitative étaient gardés POUR
TOUJOURS. L'analyse est le pire de ce qu'on garde : son `topic` et sa `justification` sont du texte libre
produit par un modèle à partir de ce que la personne a raconté.

**365 jours, et le chiffre est une décision, pas un réglage.** Julien a donné un PLANCHER de 3 mois
(motif RGPD) ; on prend quatre fois ce plancher, parce que la suppression est IRRÉVERSIBLE et qu'un an est la
durée qu'on défend sans hésiter devant une DSI. Descendre est sans danger, remonter ne ressuscite rien.

**Ce que la purge emporte, et par quel mécanisme** : les messages et l'analyse partent avec la conversation
**par les cascades DÉJÀ déclarées en base** (0009 et 0027), donc en une commande atomique, sans une ligne de
code applicatif. C'est pour ça que le test est en INTÉGRATION : un faux store rendrait ce qu'on lui fait
rendre, et le jour où une cascade manquerait, il resterait du texte libre orphelin et invisible.

**Ce qu'elle n'emporte PAS** : la FICHE du contact. Une conversation périmée n'est pas un contact supprimé.
L'effacement d'une personne reste `purgeMany`, qui anonymise en plus.

⚠️ Deux gardes testées explicitement, dans ce sens-là : `0` DÉSACTIVE la purge (sans le test,
`make_interval(days => 0)` viserait tout ce qui est antérieur à maintenant, donc TOUTES les conversations de
TOUS les clients), et l'effacement est BORNÉ par passage (500), le balayage repassant toutes les 6 heures.

La migration n'ajoute qu'un INDEX : les index existants sur `last_message_at` ne servaient pas ce besoin (celui
de 0069 est préfixé par `tenant_id`, celui de 0027 est partiel sur `analysis_status = 'pending'`).

---
## DEPLOYE le 2026-08-31 : LOT 1 du programme, quatre choses qui cassaient déjà (aucune migration)

### Un plafond Meta brûlait l'audience restante d'une campagne

`130429` (plafond de débit) et `131048` (plafond lié à la qualité) n'étaient dans AUCUNE des deux listes de
`src/meta/errors.ts`, donc traités par le défaut « 4xx sans code connu = terminal ». Un refus TEMPORAIRE, qui
vise le NUMÉRO, faisait donc échouer définitivement le destinataire en cours, puis le suivant, puis tous les
autres. Les contacts brûlés n'étaient plus joignables sans intervention (un destinataire `failed` n'est pas
repris par un relancement).

Trois pièces : les codes sont **rejouables** (c'est la vérité, l'attente les résout, et c'est ce qu'il faut
pour un envoi unitaire depuis l'inbox ou un scénario) ; le moteur de campagne les reconnaît EN PLUS comme un
plafond de numéro (`estPlafondNumero`) et met la campagne **en pause** ; et le destinataire est **rendu à la
file** (`relacher`, l'inverse exact de `claim`) au lieu d'être compté en échec.

⚠️ `131056` est délibérément EXCLU : c'est un plafond de la PAIRE (trop de messages entre ce numéro et CE
contact). Le confondre avec les autres arrêterait 5 000 envois légitimes pour un seul contact. Un test garde
cette distinction dans les deux sens.

### L'avance d'un scénario écrivait sans condition

`setStateSiEncoreSur` existait, était testé, et n'avait qu'UN appelant (le tour d'agent) : les cinq écritures
de `advance` passaient par `setState`, un `update where id` nu. Or deux avances peuvent se chevaucher **dès
aujourd'hui, avec un seul worker** : le process API traite certains retours RCS pendant que le worker traite un
webhook du même contact. Les deux lisaient le run sur le même bloc, et le dernier écrivait : `current_node`
pouvait REVENIR sur un bloc déjà franchi, et rejouer sa branche au message suivant.

Les cinq écritures passent par une fermeture `ecrire()` conditionnée au bloc **de départ**, et une avance
perdue est JOURNALISÉE (on ne corrige pas ce qu'on ne voit pas).

🔴 **Ce que ça ne ferme PAS, et c'est écrit dans le code** : les envois du perdant sont déjà partis quand la
garde le refuse. Cette garde protège l'ÉTAT, pas les effets. Fermer le double envoi demande un claim pris
AVANT les envois (donc un statut transitoire, donc une migration) plus des clés d'idempotence : c'est un lot à
part. Ne pas lire cette garde comme « l'avance est atomique ».

⚠️ Piège trouvé en chemin : la garde SQL disait `current_node = $3`. Un run peut légitimement attendre avec
`current_node` à null, et `null = null` vaut NULL : l'écriture aurait été silencieusement perdue. C'est
désormais `is not distinct from`, identique pour toute valeur non nulle.

### Le garde-fou anti-hallucination vivait en double

La recherche de connaissance était recopiée à l'identique entre le résolveur de PRODUCTION et celui du BAC À
SABLE, et leurs erreurs avaient déjà divergé. Or le bac à sable n'a de valeur que s'il rend EXACTEMENT ce que
la production rendrait : plus indulgent, il laisse croire qu'un agent sait répondre là où il transférera.

La règle vit dans `src/agent/resolvers/connaissance.ts`. Ce qui reste chez chaque appelant est le message
d'erreur d'une requête vide, que les deux surfaces n'expriment pas dans la même forme, et qui n'est pas une
règle métier. Un test de PARITÉ compare les deux sorties (il ne relit pas le code : il tient même si quelqu'un
dé-mutualisait, tant que les deux restent d'accord).

### Un second numéro était accepté et fusionnait les canaux

Décision produit du 2026-08-31 : **un seul numéro WhatsApp par espace**. Le refus est posé DANS la transaction
de rattachement, et il ignore le numéro en cours de rattachement (recommencer l'embarquement reste possible).
Le message nomme le numéro déjà présent et dit quoi faire, en 409 (un 5xx serait remplacé par la page
Cloudflare).

⚠️ Ce refus n'est pas une limitation arbitraire : le modèle suppose un fil par `(tenant_id, wa_id)` et ne
porte pas `phone_number_id` sur `conversations`, `workflow_runs`, les automations ni les analytics. Lever la
limite ne consiste donc PAS à supprimer le test ; la liste des chemins est au §A8 de la synthèse du 2026-08-31.

**Un test d'intégration existant a dû être corrigé** : il rattachait son numéro à l'espace partagé du fichier,
qui en portait déjà un depuis un test précédent. Il aurait échoué pour la nouvelle raison au lieu de celle
qu'il teste. Il a désormais son espace dédié.

---
## DEPLOYE le 2026-08-31 sur `5456d14` : la rétention des événements Meta bruts (migration 0093, PLAN.md 5.2)

`webhook_events` gardait le payload COMPLET de chaque événement Meta reçu **depuis le premier jour** : le
texte des messages entrants et le numéro de la personne qui écrit. Aucune purge, aucun index de date, et
surtout **aucun discriminant d'espace**. C'était la dernière table du dépôt à garder une trace nominative hors
de portée de la purge par contact.

🔴 **Le discriminant est la partie qui ne se rattrape pas.** Une ligne écrite sans lui n'est attribuable à
personne, pour toujours : le payload de Meta ne porte pas d'identifiant d'espace, seulement le numéro
DESTINATAIRE (`value.metadata.phone_number_id`), que `phone_numbers` rattache à son tenant. C'est pour ça que
la colonne est posée maintenant plutôt qu'au moment où on en aura besoin. Les lignes antérieures restent
inattribuables, et c'est la rétention qui s'en occupe.

**Trois pièces.**
1. **Le numéro destinataire suit l'événement** depuis `parseWebhook` jusqu'à l'insertion (`phoneNumberId`).
2. **Une purge par rétention**, `WEBHOOK_EVENTS_RETENTION_DAYS` (30 jours), balayée toutes les heures avec
   alerte Telegram en cas d'échec. L'effacement est BORNÉ par passage (50 000 lignes) : une première purge sur
   une table qui n'en a jamais eu peut viser des millions de lignes, et un `delete` unique tiendrait un verrou
   et gonflerait le WAL d'un coup. ⚠️ `0` désactive la purge, et le test d'intégration verrouille ce sens-là :
   à `0` elle ne doit RIEN toucher, surtout pas tout effacer (`make_interval(days => 0)` viserait tout).
3. **L'effacement par personne** : `purgeMany` efface désormais les événements Meta de la personne, visée par
   `payload->>'from'` (message entrant, echo) ou `payload->>'recipient_id'` (statut de livraison). 🔴 Scopé au
   tenant par le numéro destinataire : la même personne peut écrire à deux de nos clients, et purger chez l'un
   ne doit pas toucher au journal de l'autre. Un test d'intégration pose exactement ce cas.

**Ce qui n'est PAS couvert, et c'est écrit dans le code** : les lignes d'avant 0093 (sans discriminant) et les
payloads `messaging_handovers` (qui ne portent ni `from` ni `recipient_id`, mais pas de texte non plus).

**Reste de 5.2** : la rétention des CONVERSATIONS et des analyses, faite le même jour dans le lot 2 (365 j,
migration 0094). 5.2 est clos.

---
## DEPLOYE le 2026-08-31 sur `5456d14` : les deux restes du lot « journée 1 » (aucune migration)

Deux chemins que le correctif voisin ne couvrait PAS, malgré ce que son intitulé laissait croire.

### Un appel sortant n'avait aucun plafond de temps

Le plafonnement du `Retry-After` bornait l'attente ENTRE deux tentatives, jamais la durée d'UNE requête. Un
fournisseur qui accepte la connexion et ne répond jamais immobilisait donc le job jusqu'au défaut d'undici, de
l'ordre de cinq minutes. Sur la file `webhook`, sérialisée (`batchSize: 1`), c'est l'entrant de TOUS les
clients qui s'arrête derrière un seul appel pendu.

`FetchTransport` porte désormais un plafond **par instance** : 30 s pour un fournisseur d'API ordinaire (Meta,
HubSpot, dont les réponses se comptent en centaines de millisecondes), **120 s pour un modèle de langage**, qui
a le droit d'être lent. Un plafond unique aurait forcément été faux pour l'un des deux.

🔴 **Trois choses font la correction, et il en manquait une à l'énoncé de l'audit.**
1. Le dépassement est **rejouable** (`HttpTimeoutError.retryable`), sinon un silence transitoire ferait échouer
   un envoi parfaitement rejouable. Ce que ça coûte, écrit noir sur blanc dans le code : la requête est PARTIE,
   donc un serveur qui répond après 30 s peut recevoir le même envoi deux fois. Le dépôt acceptait déjà ce
   risque (`ECONNRESET` est rejoué), et le plafond généreux est ce qui le garde théorique.
2. L'échéance de **l'APPELANT est prioritaire et n'est jamais convertie**. Le cerveau d'un agent passe la
   sienne : son abandon est une décision (« je n'ai plus le temps »), pas une panne. La convertir en erreur
   rejouable multiplierait sa limite de temps par le nombre de tentatives. C'est pour ça que le typage passe
   par une erreur À NOUS plutôt que par un test de `TimeoutError` dans `isRetryable`, qui aurait attrapé les
   deux cas sans les distinguer.
3. Le plafond couvre aussi la **lecture du corps**. Sans le test ajouté dans le `catch` de `res.json()`,
   l'abandon y était ravalé et l'appel rendait `{ status: 200, json: null }` : un SUCCÈS au corps vide.

### Le retry-sweep enfilait sans dimensionner

C'était le SEUL enfileur de `campaign-run` à passer par `queue.enqueue` nu : il retombait sur le défaut de 15
minutes, alors qu'une relance de plus de ~450 destinataires (à 30/min) dure plus longtemps. Le job expirait en
plein envoi, pg-boss le rejouait, et le run reparti en parallèle appliquait SON propre limiteur de débit : le
débit réel doublait. Le plafond de 23 h posé par le lot « journée 1 » ne protégeait pas ce chemin, qui n'en
passait simplement pas.

Le câblage passe par `enqueueCampaignRun` avec le sizing relu, comme les trois autres appelants. La garde est
un test STATIQUE (`tests/campaign-pacing.test.ts`) : aucun `enqueue('campaign-run', ...)` du dépôt ne peut
omettre `expireInSeconds`. Un test de comportement était impossible, le câblage vivant dans le `main()` du
worker, que rien n'atteint.

---
## DEPLOYE le 2026-08-31 sur `434d875` : R9 et R7, les deux derniers oranges de l'audit (migration 0092)

### R9. Le mur de l'import CSV tombait au CHOIX du fichier, pas à l'import

Trois choses, dans cet ordre de gravité.

**1. L'aperçu envoyait le fichier ENTIER** pour n'en extraire que les en-têtes et quatre lignes d'exemple.
C'était le premier mur, et le plus bête : avec le plafond de corps global de 1 Mo, choisir un fichier de plus
de 14 000 lignes échouait avant tout import. Il ne part plus que la TÊTE, coupée sur une fin de ligne
(`teteCsv`, `web/lib/csv.ts`, 512 000 caractères). Conséquence assumée : au-delà d'environ 8 000 lignes, le
nombre affiché devient une ESTIMATION au prorata des caractères, signalée par un « ≈ » à l'écran. Un nombre
approché sur un gros fichier vaut mieux qu'un refus, et sous le seuil il reste exact.

**2. La route d'import ne relevait pas le plafond**, alors que flows, media, workflows et rcs le font. Elle
est à 8 Mo (environ 150 000 contacts), l'aperçu à 2 Mo. Pourquoi pas plus : le corps est parsé D'UN BLOC, et
pendant ce temps l'API ne répond à personne d'autre. **Mesuré ici** : 102 ms pour 5,4 Mo / 100 000 lignes,
donc quelques centaines de millisecondes sur le VPS. C'est le vrai facteur limitant, pas la mémoire.

**3. Le refus, quand il tombe, est en français.** Fastify répondait « Request body is too large ». Le message
est traduit dans le gestionnaire d'erreurs GLOBAL (`src/server.ts`, sur `FST_ERR_CTP_BODY_TOO_LARGE`), donc
toutes les routes à corps volumineux en profitent, pas seulement l'import.

**Et l'écriture passe par lots de 500** (`upsertManyByPhone`, `src/crm/contact-store.pg.ts`) au lieu d'un
aller-retour par ligne. À 11 ms d'aller-retour, 50 000 contacts passaient de neuf minutes, donc bien au-delà
du timeout de 100 s de Cloudflare, à une centaine de requêtes.

🔴 **Le piège du lot : Postgres refuse qu'un `on conflict do update` touche deux fois la même ligne** dans une
même commande (« cannot affect row a second time »), et un CSV a des doublons. Le store DÉDUPLIQUE donc avant
d'écrire, sur la règle exacte qu'appliquait l'écriture ligne à ligne (la ligne suivante écrase les mêmes clés,
un nom non vide gagne), et ne compte qu'UNE création par numéro, à sa première apparition. Sans ça, un fichier
répétant cinq fois le même contact annonçait cinq créations pour une personne, ou faisait échouer la requête.

Deux détails de la requête qui coûtent cher à retrouver : le lot voyage en UN paramètre `jsonb`
(`jsonb_to_recordset`) et non en tableaux parallèles, parce qu'un tableau de fragments JSON devrait être
échappé comme littéral de tableau Postgres ; et chaque paramètre est CASTÉ explicitement, parce que dans un
`insert ... select` le type d'un paramètre n'est pas toujours déduit de la colonne visée.

**La file pg-boss d'import (point 4 de l'audit) n'est PAS faite, et c'est une décision** : après les lots, le
timeout n'est plus approché. Condition de réouverture dans `todo.md`.

### R7. Les compteurs de l'inbox, interrogés par chaque utilisateur en boucle

La pastille de non-lus est montée sur TOUTES les pages et pour tous les rôles, relue toutes les 30 s, et
`countUnread` compte avec un `exists` corrélé sur TOUTES les conversations de l'espace. Vingt-cinq
utilisateurs d'un même client posaient vingt-cinq fois la même question, pour un nombre qui n'a pas bougé.

**Micro-cache par espace, 5 secondes** (`src/lib/cache-court.ts`, câblé sur `unread-count` et `todo-count`).
Deux mécanismes, et les deux comptent : la durée de vie absorbe le polling étalé, la mutualisation des appels
EN VOL absorbe les arrivées simultanées, c'est-à-dire le rechargement collectif après un déploiement, qui est
exactement le moment où ça fait mal.

🔴 **Ce qu'un cache de compteur doit avoir pour ne pas devenir le bug qu'il évite** : une invalidation sur
l'écriture qui le rend faux (marquer un fil comme lu, prendre ou rendre la main), ET une garde d'identité au
moment d'écrire dans le cache. Sans la seconde, une invalidation qui tombe pendant qu'un comptage est en vol
laisse le comptage d'AVANT se ranger en cache juste après : la pastille reste allumée alors que l'opérateur
vient d'ouvrir le fil. Les deux sont testées, chacune vérifiée dans les deux sens.

**Index partiel `conversation_messages_unread_idx` (migration 0092)**, sur les seuls messages entrants :
l'index historique savait borner sur la date mais rapportait aussi les sortants de l'intervalle, que le moteur
écartait ligne à ligne. Sur un contact qui vient de recevoir une campagne, cet intervalle est justement plein
de sortants. ⚠️ Pas de `concurrently` : le runner enveloppe chaque migration dans une transaction, ce qui
l'interdit. La table est petite aujourd'hui ; si elle grossit, créer les prochains index à la main.

**Gigue sur les trois pollings** (`web/lib/poll.ts`, ±20 %, retirée après chaque exécution). Le nombre de
requêtes ne change pas, leur RÉPARTITION si : `setInterval` fait battre tous les onglets ensemble pour
toujours, et c'est la pointe qui sature, pas la moyenne.

**Ce qui n'est PAS traité** : la colonne `unread` dénormalisée, et surtout le polling du fil ouvert toutes les
4 secondes, qui reste la charge de lecture dominante et qu'aucun des quatre correctifs de l'audit ne touche.
Conditions de réouverture dans `todo.md`.

---
## DEPLOYE le 2026-08-31 sur `a737edf` : R4 et R10 de l'audit (aucune migration)

### R4. Un déploiement gelait une campagne en cours, sans erreur visible

Le worker est tué en plein envoi à chaque `up -d` : SIGKILL vers 10 s, un run de deux heures n'a aucune
chance. Rien ne reprenait ensuite la campagne. Chaque interruption consommait un rejeu pg-boss, et **à la
sixième elle était figée pour toujours**. Mesure du jour : ce seul lot a déclenché le cas cinq fois.

🔴 **Le correctif n'est PAS d'attendre la fin d'un run**, c'est de le rendre REPRENABLE. Quatre pièces, et une
seule est la garantie :

- **Le balayage de reprise** (`listCampagnesGelees`) relance toute campagne `running` qui a du travail et
  AUCUN run vivant. C'est la garantie, parce qu'elle rattrape aussi les arrêts qu'aucun signal ne précède
  (SIGKILL, panne, OOM). « Aucun run vivant » se lit sur le verrou d'exécution de R1-bis.
- ⚠️ **Il REMPLACE le balayage du fil de l'eau**, qui n'en était qu'un cas particulier (les campagnes nourries
  par un webhook) et qui, lui, ne savait pas voir qu'un run tournait déjà : il empilait un job de plus par
  minute. Deux balayages pour une seule question, dont un faux.
- 🔴 **Le bail du verrou devient COURT (2 min) et RENOUVELÉ**, et ce raisonnement REMPLACE celui écrit le
  matin même. Le bail était alors calé sur l'expiration du job pg-boss, dimensionnée en heures, au motif que
  les deux mécanismes devaient lâcher prise ensemble. C'était juste pour un bail qu'on ne renouvelle pas, et
  **faux dès qu'on veut reprendre** : le verrou d'un process mort serait resté « vivant » pendant des heures,
  et le balayage aurait sagement attendu. Un renouvellement refusé arrête le run (on ne tient plus le verrou).
- **Un drapeau d'arrêt**, lu à chaque destinataire, laisse le run sortir à la frontière d'un envoi et rendre
  son verrou. ⚠️ Le statut n'est **pas** réécrit : la campagne reste `running`, personne n'a rien décidé, et la
  marquer `paused` exigerait un geste humain pour repartir.
- **`stop_grace_period: 30s`** dans le compose, au-dessus du filet de 25 s du shutdown. ⚠️ Les deux vont
  ENSEMBLE : relever l'un sans l'autre ne change rien. Et ce n'est PAS la garantie, seulement le confort du cas
  courant : un run throttlé peut dormir jusqu'à une minute dans son limiteur avant de relire le drapeau.

### R10 + J2. Le rappel « avant date » pouvait partir deux ou trois fois

La déduplication vivait UNIQUEMENT dans le balayage, qui lit le marqueur d'occurrence avant de publier. Tant
que l'événement publié n'était pas consommé, le balayage suivant revoyait le contact comme dû et **republiait
la même échéance**. Un client avec quinze rendez-vous à la même heure suffit à faire prendre du retard à la
file. Symptôme : deux, parfois trois rappels WhatsApp **identiques, facturés, visibles du client**, avec le
risque de note de qualité Meta.

`markFired` devient un **claim conditionnel** quand un marqueur est donné : la garantie descend du balayage au
RUNNER, seul endroit atomique.

- ⚠️ **SANS marqueur, l'écriture reste inconditionnelle.** Tous les autres déclencheurs y écrivent
  `fired_for = null`, et `null is distinct from null` est faux : rendre ce cas conditionnel aurait fait
  échouer TOUT déclenchement répété, sur toutes les automations du produit.
- ⚠️ **Le rattrapage du balayage n'est pas cassé.** Quand le scénario ne démarre pas, `clearFired` efface le
  marqueur et la tentative suivante regagne le claim. C'est le comportement voulu, documenté dans
  `date-sweep.ts` : un fil momentanément tenu par un opérateur doit pouvoir laisser passer le rappel une
  minute plus tard.

### Ce que la CI a attrapé, et que rien en local ne pouvait voir

Mes tests d'intégration du claim empruntaient une automation qu'un test précédent du même fichier
**supprime** : l'ordre d'exécution décidait du résultat. Le job `integration` ne tourne qu'en CI (le
`DATABASE_URL` local est la production), donc c'est elle, et elle seule, qui pouvait le voir. Un test qui
dépend de ce qu'un autre a laissé n'est pas un test, c'est un pari.

---
## DEPLOYE le 2026-08-31 sur `b058eaa` : le SERVEUR conduit l'entretien de construction (migration 0090)

✅ **Migration 0090 appliquée**, séquence tenue : `build mba-api`, vérification que la 0090 est **DANS l'image**,
`migrate`, vérification EN BASE (six colonnes, la clé primaire, les deux clés étrangères, `0090` en tête de
`schema_migrations`), puis `up -d --build`. Un second déploiement `--force-recreate` a suivi pour
`AGENT_VISION_MODEL` (un `.env.prod` modifié n'est relu qu'à la recréation). **Prochaine libre = 0091.**

Vérifié APRÈS déploiement : trois conteneurs sains sur `mcp-robot_default`, **zéro redémarrage**, aucune erreur
dans les journaux. Par le chemin PUBLIC : l'accueil et `/agents` en 200 ; les quatre nouvelles routes montées et
gardées (**401 sans jeton**, pas 404) : `GET`, `POST` et `DELETE` sur `/setup`, et `POST /setup/piece-jointe`.
`AGENT_VISION_MODEL` relu depuis l'intérieur du conteneur.

⚠️ **La CI a attrapé ce qu'une passe locale partielle avait manqué** : le changement d'onglet d'entrée faisait
tomber trois tests de `agents-fiche.spec.ts`, qui comptaient sur l'ancien défaut. Ils cliquent maintenant
l'onglet, comme le ferait un utilisateur. Leçon rejouée : après un changement de NAVIGATION, la suite e2e se
lance en ENTIER, pas sur le seul fichier touché.

### 🔴 Le défaut n'était pas la liste des points, c'était QUI CONDUIT

Le modèle choisissait sa question suivante et **déclarait lui-même** ce qu'il avait couvert ; le serveur ne
faisait que compter. Rien n'était déterministe, et ça se voyait à l'usage : le ton, l'identité et la base de
connaissance n'étaient jamais demandés, et « l'agent le fait tout seul » passait pour une réponse complète.

L'inversion : **l'ordre du jour et la couverture sont des faits du serveur** (`src/agent/setup/couverture.ts`).
Le modèle formule la question qu'on lui désigne et extrait la réponse ; il ne décide plus de rien. Trois
mécanismes portent la garantie, et aucun n'est une consigne :

- 🔴 **Un point n'est couvert que s'il a été POSÉ au client**, pas seulement si le modèle prétend en connaître
  la réponse. C'est ce qui garantit qu'on a fait le tour et pas que le modèle a bien deviné. Une réponse donnée
  d'avance est gardée : le tour venu, on la fait **confirmer** en une phrase plutôt que de reposer la question,
  ce qui rend l'entretien court sans rien sauter.
- 🔴 **Le prompt reçoit DEUX points, l'ouvert et le suivant.** Structurel : le serveur choisit la question
  AVANT de lire la réponse, il ne peut donc pas savoir que le dernier message y répond déjà. Un seul point
  ferait repiétiner ; toute la liste laisserait le modèle la survoler. Deux, pas un de plus.
- 🔴 **Le creusement est mécanique.** Répondre « il appelle un outil » à `bascules` **ouvre** le point
  `quel_outil`, qui n'existait pas avant, et l'entretien ne peut plus se terminer sans. Se raviser le referme.
  C'est la demande de Julien : « si c'est l'agent qui peut le faire lui-même, il faut que l'agent creuse et
  demande, ben comment l'agent fait dans ces cas là ? ».

L'ordre du jour passe de six à neuf points, **de la substance vers la surface** : on ne demande le ton et
l'identité qu'une fois qu'on sait ce que l'agent fait, sinon on décore une coquille.

⚠️ **Le vieux garde-fou « au moins deux messages du client » a été RETIRÉ.** C'était un pis-aller qui compensait
une couverture déclarée par le modèle. Elle ne l'est plus, et garder les deux aurait fait croire que le second
portait quelque chose.

### La persistance n'est pas qu'un confort

Table `agent_setup_conversations`. Elle rend la conversation reprenable au retour sur l'onglet, ce que Julien
demandait, **mais c'est surtout elle qui rend la couverture calculable côté serveur** : sans état, la couverture
ne pouvait qu'être recalculée à partir de ce que le modèle voulait bien annoncer.

Conséquence de sécurité au passage : le navigateur n'envoie plus l'historique mais **un** message. Un historique
forgé ne peut donc plus faire croire à l'assistant qu'il a déjà tout demandé. Un bouton « Recommencer » évite
que la persistance devienne une prison.

### Les pièces jointes

`src/agent/setup/piece-jointe.ts`. Un document joint devient des **fiches de connaissance**.

- **Le type vient de la SIGNATURE du fichier**, jamais du MIME déclaré : même doctrine que `src/rcs/image.ts`,
  et elle mord autant ici, puisque ce texte finit dans le prompt d'un agent qui parle à de vrais contacts. Un
  ZIP quelconque ne passe pas pour un `.docx` (on exige son `word/document.xml`), et un binaire ne passe pas
  pour du texte (UTF-8 valide, sans octet nul).
- 🔴 **Le texte est DÉCOUPÉ, jamais avalé d'un bloc.** C'est la leçon déjà écrite dans `scrape.ts` : la
  recherche mesure « combien de termes de la question se retrouvent dans la fiche », donc un document entier
  dans une seule fiche contient à peu près tous les mots du métier, devient pertinent pour n'importe quelle
  question, et **rend la garde anti-hallucination inopérante sans qu'aucun test ne le voie**. Un PDF de
  quarante pages est le pire cas de ce défaut. Les plafonds sont ceux de l'import de page web, importés et non
  recopiés.
- ⚠️ **Un test a attrapé un vrai défaut d'implémentation** : une section plus longue que le plafond était
  TRONQUÉE, et tout le reste perdu en silence, le client croyant son document importé. Elle est maintenant
  découpée en « suite 2 », « suite 3 », et le test compare les caractères non blancs de bout en bout.
- **Une image est lue UNE SEULE FOIS**, au moment où elle est jointe, par un appel vision qui en relève le
  texte. Aucune image ne circule dans l'entretien persisté : l'y garder ferait grossir une ligne jsonb de
  plusieurs méga et referait payer sa lecture à chaque tour.
- ⚠️ **`ChatMessage` n'a PAS été élargi** pour ça. L'essai (`content: string | Part[]`) a fait sortir une
  dizaine d'endroits qui lisent ce champ comme une chaîne, dans le runtime de l'agent et ses tests, pour un
  besoin qu'aucun n'a. Un type `ChatMessageImage` séparé, accepté en union par `completer`, laisse tout
  l'existant intact.
- **Deux dépendances neuves**, toutes deux SANS dépendance transitive (le dépôt en compte onze) : `unpdf`
  (importé dynamiquement, pour ne pas faire payer pdf.js au démarrage de l'API) et `fflate` (dézippage du
  `.docx`). `xlsx` reste écarté, comme décidé auparavant : les deux bibliothèques npm sont mauvaises.
- **Écrire directement n'est pas une entorse au « rien ne s'écrit sans un clic ».** Ce diff protège contre ce
  que le MODÈLE propose ; ici c'est le client qui téléverse son propre document, et le geste EST le
  consentement. Même doctrine que l'import d'une page de son site, qui écrit aussi ses fiches directement.

### Écran

« Construire en parlant » devient l'onglet d'**entrée** (l'ordre des onglets le disait déjà, le défaut ouvrait
le formulaire). Un agent se supprime **depuis la liste**. Et la conversation ressemble à un tchat : fil de
hauteur fixe, descente automatique, première bulle qui interroge au lieu d'expliquer, zone de texte
multi-ligne (Entrée envoie, Maj+Entrée va à la ligne), indicateur de frappe.

---
## DEPLOYE le 2026-08-31 sur `3a708ce` : R1, R1-bis et R13 de l'audit du 25 août (migration 0089)

✅ **Migration 0089 appliquée**, séquence tenue : `build mba-api`, vérification que la 0089 est **DANS l'image**
(`docker run --entrypoint sh` sur l'image fraîche), `migrate` (« 1 migration appliquée »), vérification EN BASE
(six colonnes, la clé primaire, les deux clés étrangères, et `0089` en tête de `schema_migrations`), puis
`up -d --build`. **Prochaine libre = 0090.**

Vérifié APRÈS déploiement : les trois conteneurs sains, rattachés à `mcp-robot_default`, **zéro redémarrage**,
aucune erreur dans les journaux de l'API ni du worker (qui redémarre bien avec ses sept files). Par le chemin
PUBLIC : l'accueil et `/campaigns` en 200, `/api/backend/health` en 200, et la nouvelle route de pause qui
répond **401 sans jeton** (donc montée et gardée, un 404 aurait voulu dire qu'elle n'existait pas). Le libellé
« Mettre en pause » est présent dans le bundle réellement servi.

### 🔴 R1. `singletonKey` n'a JAMAIS dédupliqué quoi que ce soit dans ce dépôt

Douze commentaires (l'audit en comptait huit) promettaient « un seul job vivant par campagne / par
conversation » sur la foi d'un `singletonKey`. **Lu dans la source de pg-boss 12.25.1 :** la déduplication sur
`singleton_key` ne passe que par des index uniques **partiels**, tous filtrés sur une policy de file
(`job_i1` short, `job_i2` singleton, `job_i3` stately, `job_i6` exclusive, `job_i8` key_strict_fifo,
`migrationStore.js`). Or `PgBossQueue.ensure()` crée les files sans `policy`, donc en `standard`
(`manager.js` : `options.policy || QUEUE_POLICIES.standard`), où aucun de ces index ne s'applique. Le
paramètre était accepté, écrit en base, et ignoré.

⚠️ **Et on ne peut pas rattraper en ajoutant `policy`** : pg-boss refuse tout changement après création
(« queue policy cannot be changed after creation »), et les files de la production existent déjà. Il faudrait
de nouvelles files, donc de nouveaux noms, donc abandonner les jobs en vol.

Le paramètre a été **retiré de l'interface `Queue`** : un commentaire dérive, un type non. Ce que la vérité
rétablie change concrètement :

- l'enfilement d'un `campaign-run` n'est **pas** idempotent. Ce qui empêche le double-run d'une campagne
  programmée, c'est `markRunning` (la garde sur le statut, qui la retire de la liste des dues), pas la file ;
- le claim atomique par destinataire garantit qu'**aucun contact ne reçoit deux fois**, il ne garantit **pas
  le débit** : N runs concurrents instancient N limiteurs en mémoire et envoient à N fois la cadence annoncée.
  C'est ce qui grille un numéro neuf en palier 250 ;
- 🔴 **le balayage « fil de l'eau » se justifiait par un mécanisme inverse du réel.** Son commentaire disait
  rattraper les arrivants dont le job avait été « avalé » par le `singletonKey`. Rien n'avalait rien : l'effet
  réel est qu'il **empile un run de plus par minute** tant que la campagne a des destinataires en attente,
  alors qu'un run tourne déjà. Un envoi throttlé d'une heure finirait à soixante runs concurrents. Aucune
  campagne au fil de l'eau n'a encore tourné en production, donc ça n'a jamais mordu.

### R1-bis. Le verrou d'exécution qui remplace la déduplication inexistante (migration 0089)

`src/campaign/run-lock.ts`, table `campaign_run_locks`. **Posé au SEUL endroit qui exécute** (`campaignRunJob`),
jamais aux cinq endroits qui enfilent : on n'essaie pas d'empêcher les enfilements en double, on empêche les
exécutions en double. C'est la différence entre verrouiller toutes les portes et verrouiller le coffre, et
c'est ce qui fait qu'un seul point de code couvre les cinq chemins d'un coup (route `/run`, renvoi d'un
destinataire, balayage de planification, auto-relance F6, alimentation au fil de l'eau).

Trois pièces, et il en faut trois :

- 🔴 **Le bail** (`expires_at`). Sans lui, un worker tué en plein envoi (SIGKILL à 10 s au déploiement, cf. R4)
  laisserait la campagne verrouillée pour toujours. Il est dimensionné sur **la même estimation que
  l'expiration du job pg-boss** (`campaignJobExpireSeconds`), délibérément : les deux mécanismes doivent lâcher
  prise au même instant. Un bail plus court laisserait un second run démarrer sous le premier ; un bail plus
  long garderait la campagne bloquée alors que pg-boss rejoue déjà son job.
- 🔴 **Le jeton de garde** (`holder`). Si notre bail a expiré et qu'un autre run a repris le verrou, notre
  libération ne doit pas supprimer le sien. Sans ce jeton, l'expiration du bail recréerait exactement la
  concurrence que la table existe pour empêcher.
- 🔴 **Le drapeau de relance** (`rerun`). Un job écarté peut porter du travail que le run en cours ne verra
  pas : il a pris son instantané de destinataires à son démarrage. Un destinataire remis en attente par
  « Renvoyer » ou par l'auto-relance F6 resterait alors `pending` **à vie** sur une campagne passée
  `completed`. Le tenant du verrou relance donc une fois en sortant, et seulement s'il reste vraiment du
  travail (sinon un double clic sur « Lancer » ferait clignoter le statut pour un run vide).

Un job qui n'obtient pas le verrou **ne lève pas** : il rend un rapport à zéro. Lever ferait rejouer le job par
pg-boss, qui se heurterait au même verrou, cinq fois, puis finirait en file d'échec pour un cas parfaitement
normal.

⚠️ **Ce que le verrou NE fait pas.** Le cas documenté dans `pacing.ts` (un run dont la durée réelle dépasse son
expiration estimée) reste ouvert : à cet instant, le bail expire en même temps que le job, donc le rejeu
pg-boss prend le verrou pendant que le run d'origine tourne encore. C'est le risque déjà assumé pour les très
grosses campagnes à débit très bas, dont le vrai remède est le découpage du run en tranches.

Le SQL est prouvé en intégration (`tests/integration/stores.integration.test.ts`), le câblage en unitaire : les
deux, parce qu'aucun ne peut prouver ce que prouve l'autre.

### R13. Arrêter une campagne lancée

Trois pièces, chacune nécessaire, aucune ne suffit seule :

1. **Le moteur relit le statut dans sa boucle** (`runCampaign`) et sort dès qu'il n'est plus `running`. Cadencé
   par le **temps** (5 s, `statusPollMs`) et non par un nombre de destinataires : une campagne à 1 msg/min
   mettrait sinon des heures à voir la pause. Le contrôle passe **avant le claim**, et la sortie **ne réécrit
   pas** le statut (ce serait écraser la décision de l'opérateur, et `completed` mentirait).
2. **Le job refuse de démarrer une campagne en pause** (`campaignRunJob`). Sans cette garde, un job enfilé avant
   la pause la ressusciterait, puisque le moteur remet toute campagne en `running` à son démarrage. Le cas est
   atteignable précisément parce que la file ne déduplique rien (R1). Conséquence voulue : l'auto-relance F6
   n'insiste plus sur une campagne en pause, elle attend une reprise décidée.
3. **La reprise est explicite** : `POST /run` lève la pause **avant** d'enfiler, et la **rétablit** si
   l'enfilement échoue. Sans ce rétablissement, la campagne resterait affichée « en cours » sans qu'aucun job
   ne tourne, et « Reprendre » ne s'affiche pas sur une campagne en cours : l'opérateur serait coincé.

Route `POST /tenants/:tenantId/campaigns/:campaignId/pause`, admin, scopée tenant. **404 « pas à toi » et 409
« n'envoie pas » sont distincts** (contrôle d'appartenance d'abord), et jamais 5xx : Cloudflare remplace le
corps de toute réponse 5xx par sa page d'erreur.

⚠️ **Piège rencontré, et attrapé par le test :** l'engine appelait la relecture par une référence déliée
(`const f = deps.campaigns.getStatus`), ce qui perd le `this` et aurait cassé `PgCampaignStore` en production
(`this.pool` indéfini). Une méthode d'un store injecté s'appelle **sur son objet**, jamais détachée.

Les trois gardes sont vérifiées **dans les deux sens** : retirée une à une, chacune fait échouer un test avec
son symptôme exact (3 envoyés au lieu de 1, 1 au lieu de 0, pause non rétablie).

---
## DEPLOYE le 2026-08-28 sur `05f791d` : le lot L2, le connecteur API du client

Plan execute : [AGENT-IA-PLAN-L2.md](AGENT-IA-PLAN-L2.md), neuf taches, quatre decisions tranchees par Julien
et retenues telles quelles. Un agent peut desormais interroger le systeme d un client par une API HTTP que le
client declare lui-meme, sans qu aucune adresse ni aucun identifiant de ressource ne soit choisi par le modele.

🔴 **Un trou trouve en ecrivant le plan, et ferme par la tache 4bis.** Un parametre `contactPath: 'wa_id'`
recevait `null` : la projection du contact ne porte PAS le numero (volontairement, elle part chez le
fournisseur de modele), alors qu un connecteur sert d abord a repondre « ou en est MA commande ». Le numero
vient maintenant du contexte du tour, ou il est authentifie par la signature du webhook Meta. Le fixe des tests
portait `wa_id`, ce que la production n a jamais eu : il a ete recale sur la vraie projection.

✅ **Migration 0088 appliquee**, sequence tenue : `build mba-api`, verification que la 0088 est DANS l image,
`migrate` (« 1 migration appliquee »), verification en base (les deux tables, la colonne `source_id`, les deux
contraintes), puis `up -d --build`. **Prochaine libre = 0089.**

Verifie APRES deploiement : les trois conteneurs sains et rattaches a `mcp-robot_default`, zero redemarrage,
l accueil, `/workflows` et `/agents` en 200, la route `/agent-sources` montee (401 sans jeton) et
`POST .../tools/connecteur` montee (401 sans jeton). Le webhook Meta repond 403 sur un jeton faux et sur un
POST non signe, par le chemin public reel (`/api/backend/webhooks/meta`).

⚠️ **Une fenetre de 968 ms d erreurs de proxy pendant la recreation** (`mba-web` -> `mba-api`, ECONNREFUSED,
20:01:41,744 a 20:01:42,712), le temps que l API se mette a ecouter. Les livraisons Meta tombees dans cette
seconde sont rejouees par Meta. C est le cout normal d un `up -d --build` ; le noter pour ne pas le confondre
avec un incident la prochaine fois qu on lit ces logs.

🔴 **L ECRAN A CHANGE DE PLACE le 2026-08-28, apres retour de Julien.** La bibliotheque de systemes vit dans
**Tools > Connecteurs API** (`/connecteurs`), a cote des webhooks, et pas dans l onglet Outils d un agent : un
systeme appartient au CLIENT, et plusieurs agents tapent dedans. L agent, lui, ne declare que les APPELS qu il
a le droit d y faire. En base, rien n a bouge : `agent_tool_sources` portait deja `tenant_id`.

⚠️ **Piege de vocabulaire** : la console a un menu « Tools » ET un onglet « Outils » dans un agent. Ils ne
parlent pas de la meme chose. Si la confusion revient, renommer l un des deux.

⚠️ **Rien n est branche tant qu un client n a pas declare de source.** Le lot n active rien tout seul : sans
source, l onglet Outils est exactement ce qu il etait.

## DEPLOYE le 2026-08-28 : l agent a ses DEUX modeles, et le canevas ne ment plus

**Les modeles (`e678377`).** Deux metiers, deux reglages, choisis au BANC contre le Gateway avec notre propre
schema (tableau complet dans `documentation.md`) :
- `AGENT_SETUP_MODEL=zai/glm-4.7` pour l assistant de CONSTRUCTION (sortie structuree imbriquee, en francais).
  Conforme 4 fois sur 4, propose a chaque fois des regles d arret ET des outils.
- `AGENT_MODEL=zai/glm-4.7-flash` pour un agent NEUF, celui qui tourne a chaque message. 15/15 sur la boucle
  reelle d outil, 0,000084 $ le tour, 2,2 s : le moins cher ET le plus rapide du banc.

🔴 **Piege ferme au passage** : le modele d un agent neuf retombait sur `LLM_MODEL`, l identifiant de l ANALYSE
de conversation servie EN DIRECT par Anthropic. Le Gateway ne le connait pas : chaque tour aurait echoue en
pleine conversation, sans que la creation n ait rien signale. Poser la cle sans les deux modeles est desormais
refuse au boot.

⚠️ **La cle du Gateway est celle du projet hyundai** (compte Vercel de Julien), reutilisee pour debloquer. Une
cle dediee a mba rendrait l attribution du cout lisible par projet : a creer cote Vercel quand Julien voudra.

Verifie APRES deploiement : le worker liste `agent-turn` dans ses files, et le conteneur `mba-api` joint le
Gateway et recoit `usage.cost` (c est lui qui alimente le solde prepaye).

**Le canevas (`a4ea371`).** Trois symptomes signales par Julien, deux causes mesurees : la fleche de « toute
autre reponse » etait ancree sur la PREMIERE sortie du bloc (arete sans `sourceHandle` = pas de poignee nommee
pour React Flow), et les points de liaison faisaient 5,7 px avec une tolerance de visee de ±2 px. Corriges,
avec les mesures en tests de bout en bout. Le visuel d un bloc s affiche desormais dans sa miniature.

## DEPLOYE le 2026-08-28 sur `cd90bd7` (2 commits, migration 0087 appliquee)

Sequence tenue : `git pull`, `build mba-api`, verification que **0087 est DANS l image** (`ls db/migrations`),
`migrate` (« 1 migration appliquee »), verification des deux tables `agent_credits` et
`agent_credit_mouvements` en base (colonnes conformes, aucune `par_utilisateur`), puis `up -d --build`.
Les trois conteneurs sont sains, rattaches a `mcp-robot_default`, zero redemarrage ; l accueil et `/agents`
repondent 200, `mba-api:8095/health` repond depuis le reseau interne.

La surface `/ops/credits` a ete verifiee EN PRODUCTION, en lecture seule : un tenant reel rend
`{"soldeMicroEur":0,"mouvements":[]}`, un uuid inconnu rend **404** (et non un solde de zero, qui etait le
piege), un identifiant mal forme rend **404** (et non un 500 remplace par la page Cloudflare), et sans jeton
d exploitation **401**. Aucune ecriture n a ete faite : personne n a ete recharge.

⚠️ **`EUR_PER_USD` n a PAS ete posee dans `.env.prod`** : elle a un defaut de **0,92** dans `src/config.ts`,
qui s applique donc. C est un parametre COMMERCIAL : le poser explicitement est un choix de Julien, pas une
correction technique.

## LE SOLDE PREPAYE PAR WORKSPACE (tache 21)

Demande de Julien : un budget qui existe dans l outil et qui **descend vraiment avec la consommation**, sans
Stripe (recharge a la main). Ses deux arbitrages : un solde **par workspace**, et tout **en euros** avec un
**taux fixe en configuration** (`EUR_PER_USD`), pas un cours en temps reel.

🔴 **Ce que ca a mis au jour : le cout d un tour n etait ecrit NULLE PART.** La colonne
`agent_sessions.cout_micro_eur` existait, la console affichait un plafond par conversation, `runTurn` le
comparait, et rien ne l alimentait : le reglage montre au client etait DECORATIF. Repare, et c est ce qui rend
le prepaye possible. **Ferme aussi D1** : la conversion dollars vers micro-euros se fait a l entree, en un seul
endroit (`src/agent/devise.ts`).

Le solde se lit et se recharge sur `/ops/credits/:tenantId` (**premiere ecriture metier de `/ops`** : un client
ne doit jamais pouvoir crediter son propre compte). Recharge bornee a 1000 € et **note obligatoire**. Le bac a
sable de la console consomme pour de vrai, il est donc soumis au meme solde.

✅ **Migration 0087 appliquee** le 2026-08-28 (voir la section de deploiement ci-dessus).
Le compteur des migrations vit dans le CLAUDE.md du repo, et nulle part ailleurs.

⚠️ **Nouvelle variable d env** : `EUR_PER_USD` (defaut **0,92** dans `src/config.ts`, gabarit dans
`.env.example`). Elle est un **parametre commercial** : la changer change ce qu on facture. Non posee dans
`.env.prod`, le defaut s applique.

🔴 **AUCUN workspace n a de solde aujourd hui** (la table est vide, donc solde = ZERO partout). C est le bon
defaut (un credit implicite ferait payer une consommation que personne n a autorisee), mais ca veut dire que
**tant que personne n a recharge, les agents ne demarrent pas et le bac a sable rend 409**. Recharge, quand on
la voudra (le montant est en MICRO-euros, 10 EUR = 10 000 000) :

```bash
curl -s -X POST "https://mba.messagingme.app/api/backend/ops/credits/<tenant-uuid>" -H "x-ops-token: <OPS_TOKEN, dans /home/ubuntu/mba/.env.prod>" -H "content-type: application/json" -d '{"montantMicroEur": 10000000, "note": "recharge Julien, phase de conception"}'
```

La **note est obligatoire** (qui recharge, et pourquoi) : c est la seule trace, le jeton d exploitation etant
partage. Plafond de 1000 EUR par operation, et il n existe AUCUNE route de debit pour rattraper une virgule
mal placee.

## DEPLOYE le 2026-08-28 sur `a325844` (54 commits, migration 0086 appliquee)

Sequence tenue : `git pull`, `build mba-api`, verification que 0086 est DANS l image, `migrate`
(« 1 migration appliquee »), verification des cinq tables `agent*` en base, puis `up -d --build`.
Les trois conteneurs sont sains et rattaches a `mcp-robot_default`, l accueil et `/agents` repondent 200,
`mba-api:8095/health` repond depuis le reseau interne, aucune erreur en trois minutes de logs.

🔴 **LE BLOC AGENT EST DEPLOYE MAIS INERTE, ET C EST VOULU.** `AI_GATEWAY_API_KEY` n est pas dans le
`.env.prod` : le worker le DIT au demarrage (« agent-turn: file NON consommee ») et la file n est pas
consommee. Conséquences tant que la cle n est pas posee :

- l assistant de construction et le bac a sable repondent **503** ;
- un agent ACTIVE et pose dans un scenario laisserait le contact **sans reponse** : le tour serait enfile et
  personne ne le consommerait. Le run reste `waiting`, rien ne casse, mais rien ne repond.

Donc : ne pas poser de bloc agent dans un scenario vivant avant d avoir mis la cle.

✅ **D1 (la devise) est fermee depuis, par la tache 21** : le Gateway facture en DOLLARS, la conversion se fait
desormais a l entree au taux `EUR_PER_USD`, en un seul endroit.

✅ **Migration 0086 appliquee** le 2026-08-28 (dette D6 fermee). La **0087** (solde prepaye), elle, ne l est
pas : voir la section « A DEPLOYER » ci-dessus.

⚠️ **Nouvelles variables d env** : `AI_GATEWAY_API_KEY` (19d et 19e) et `AGENT_SETUP_MODEL` (19d). Vides, la
conversation de construction et le bac a sable repondent 503, aucun crash. A poser sur le VPS avant de
deployer ce lot.

**Ou on en est (2026-08-28) : LA TACHE 19 EST FINIE.** Un agent EXISTE (fiche, regles d arret, activation),
il a une base de connaissance (fiches editables, lecture d une page du site), des OUTILS (catalogue maison,
activation par un humain, drapeau d autonomie), il se construit EN PARLANT (l assistant propose, le client
garde ou jette, rien ne s ecrit en silence) et il se TESTE depuis la console avant d etre active.

**Le tour de PRODUCTION est cable (tache 20).** Le worker consomme `agent-turn` avec les VRAIS resolveurs, et
l agent a enfin une MEMOIRE : il lit la conversation en base depuis l ouverture de sa session. Un vrai
contact peut donc lui parler des que le deploiement est fait.

⚠️ **Rien n a encore tourne sur du VRAI trafic.** Ce qui reste a voir en vol : un contact qui atteint un bloc
agent, une reponse qui part, un outil qui s execute, une sortie qui reprend le scenario. C est la premiere
chose a faire apres le deploiement, et elle ne se remplace par aucun test.

## LIVRE ET DEPLOYE le 2026-08-26 : bloc « Question » dans les scenarios

Demande de Julien : un bloc qui ouvre un MENU (au lieu de boutons) avec X reponses, qui ATTEND la reponse du
contact, ou chaque reponse est mappable vers un autre bloc, ou la reponse ecrite est mappable meme quand un
menu existe, et ou « pas de reponse apres X temps » est une sortie mappable elle aussi.

Arbitrages tranches par Julien : sans menu, UNE seule sortie « il a repondu » (pas de mots-cles) ; bloc
RESERVE a WhatsApp (pas de repli RCS).

**Deploiement (prod sur `52a33b6`)** : migration **0085** appliquee AVANT le code, puis les 6 tests
d integration lances contre la vraie base (verts, ils n avaient jamais pu tourner), puis `build mba-api` ->
`ls db/migrations` dans l image pour verifier que 0085 y est -> `migrate` (« a jour », donc fiable) ->
`up -d --build`. Les trois conteneurs sont sains, aucune erreur au demarrage, `mba-web` toujours rattache a
`mcp-robot_default`.

**Verifie EN VOL** : index partiel present en base ; les marqueurs du bloc (`question-node-timeout`,
`question-row-title-`, `wf-row-delete`, la sortie « Pas de reponse ») sont dans le bundle reellement servi ;
le type `question` et `claimDueQuestions` sont bien dans le code des conteneurs qui tournent.

**Reste a voir sur du VRAI trafic** : aucun contact n a encore recu de menu. Le premier test se fait en
posant un bloc Question dans un scenario et en se l envoyant depuis l Inbox (fenetre de 24 h ouverte).

**Le point d architecture** : c est le seul bloc du produit qui attend DEUX choses a la fois, une reponse ET
le temps qui passe. Le run reste `waiting` (sans quoi la reponse du contact serait perdue) et porte en plus un
`resume_at`, reclame par un bail, pas par une consommation. Detail dans `documentation.md`.

**Revue adversariale** : 4 lentilles ont rapporte 39 defauts, chacun soumis a deux sceptiques charges de le
REFUTER. 10 ont survecu, et j en ai verifie chacun dans le code avant de corriger. Les quatre plus graves
etaient reels et invisibles sans revue :
- supprimer une reponse du menu renumerotait les sorties et repointait SILENCIEUSEMENT les branches deja
  reliees (le contact qui choisit « C » partait dans la branche de « B », supprimee) ;
- l echeance etait CONSOMMEE avant la reprise : un refus de Meta la perdait pour toujours, le fil restant
  tenu par un parcours mort que plus rien ne reveillait ;
- une question posee sur un parcours RCS laissait le run marque `rcs`, donc la reponse WhatsApp du contact
  etait jetee par la garde d etancheite ;
- les variables `{{champ}}` du panneau ne resolvaient nulle part : le contact aurait lu `{{prenom}}`.

Deux de mes propres tests passaient A VIDE (le canal, et un filtre d aretes mal ecrit) : corriges et
re-verifies par mutation.

Verifie avant de m arreter : tsc vert (racine + front), racine **2491** tests, front **132**, E2E **329**,
lint front sans avertissement nouveau. **9 mutations dans les deux sens** sur les regles decisives.

## LIVRE ET DEPLOYE le 2026-08-26 : campagne AU FIL DE L'EAU alimentée par un webhook

Demande de Julien : dans la création de campagne, un bouton **« Autre »** à côté de « Liste de contacts » et
« Import fichier », qui contient HubSpot (masqué quand le connecteur est éteint) et un nouveau choix
**Webhook** : on désigne une adresse de Tools > Webhooks, et tous les contacts qui arrivent par elle sont
« shootés au fur et à mesure ».

**Interprétation assumée** : la campagne envoie à partir de son LANCEMENT, pas aux contacts déjà arrivés par
cette adresse avant. C'est la lecture naturelle de « au fil de l'eau », et la seule qui ne risque pas
d'arroser d'un coup des centaines de contacts passés. Un rattrapage des antérieurs reste possible à ajouter.

**Déploiement (prod sur `9f018c2`)** : migration **0084** appliquée AVANT le code, puis les 11 tests
d'intégration lancés contre la vraie base (verts), puis `build mba-api` -> `ls db/migrations` dans l'image
pour vérifier que 0084 y est -> `migrate` (« à jour », donc fiable) -> `up -d --build`. Les trois conteneurs
sont sains, aucune erreur au démarrage, `mba-web` toujours rattaché à `mcp-robot_default`.

**Vérifié EN VOL** : colonne + index + FK `on delete set null` présents en base ; les marqueurs du nouvel
écran (`campaign-source-autre`, `campaign-webhook-select`, `campaign-badge-fil`, `campaign-stop`) sont dans le
bundle réellement servi ; la route `/stop` répond **401** là où une route inexistante répond 404 (le contrôle
rend la distinction probante).

**Reste à voir sur du VRAI trafic** : personne n'a encore fait passer un lead par une adresse alimentée. Le
premier test réel se fait en postant sur l'URL du webhook, campagne lancée.

Vérifié avant de déployer : tsc vert (racine + front), racine **2448** tests verts, front **128**, E2E
**320** (dont 8 neufs), lint front sans avertissement nouveau. Cinq mutations dans les deux sens (statut de
sortie du moteur, anti-doublon, inscription d'un écart, condition de publication de la route publique, garde
d'affichage de HubSpot) : chacune fait bien tomber les tests censés la couvrir.

## LIVRE ET DEPLOYE le 2026-08-24 : le canal RCS ecoute (rappels smsmode) + composeur a visuel

Prod sur **`694b739`**, migrations **0079** et **0080** appliquees AVANT le code (image rebatie d'abord, puis
`ls db/migrations` dans l'image pour verifier qu'elles y sont, puis `migrate`, puis `up -d --build`). Les trois
conteneurs sont sains, aucune erreur dans les logs, `mba-web` toujours rattache a `mcp-robot_default`.

⚠️ **Ce deploiement embarque le chantier d'une AUTRE session** : `98a4438` (consentement des contacts par
webhook, migration 0080, defaut a `true` y compris pour les webhooks deja crees). Decision de Julien du
2026-08-24, mais elle part avec ce lot et pas separement.

### Ce que le lot RCS apporte

**Le canal ecoute.** Une adresse publique par workspace, `POST /rcs/callback/<code>`, posee automatiquement
sur chaque envoi. Elle recoit les rapports de livraison ET les reponses (le corps porte `direction`). Trois
choses n'existaient pas et existent maintenant : la sortie « non joignable » d'un bloc s'allume (cascade RCS
vers WhatsApp), un bouton tape fait avancer le scenario, un STOP pose l'opt-out.

**Deux defauts corriges au passage, qu'aucun envoi n'exercait encore :**
- les charges utiles des boutons partaient en `btn_1` alors que le graphe attend `btn:0` : un clic ne trouvait
  aucune arete et le parcours s'arretait en silence. Reecriture a l'envoi, donc les messages deja enregistres
  sont repares sans ressaisie ;
- le mapping CARTE/CARROUSEL etait faux (`card`/`cards` et `media.url` au lieu de `content`/`contents` et
  `media.fileUrl`) : la premiere image envoyee serait partie en 400.

**Un blocage de conception corrige.** Un bloc RCS sans bouton laissait le parcours en attente pour toujours :
seuls un echec definitif ou une reponse le relancaient. Un rapport `DELIVERED` reprend desormais la sortie
« envoye », mais UNIQUEMENT si le bloc n'offre aucun bouton reponse (l'accuse arrive en secondes, le contact
repond bien plus tard : avancer trop tot enverrait son clic dans le vide).

**Le composeur.** Image d'en-tete (le message bascule en CARTE, texte plafonne a 2000 au lieu de 3072),
variables `{{champ}}` (meme table que les modeles d'email) et emojis, aux trois endroits ou l'on ecrit un
message RCS. La bascule texte/carte vit dans UN endroit (`web/lib/rcs.ts`, miroir serveur dans
`rcsOutboundOf`).

### Ce qui a ete verifie, et comment

- Typecheck des deux tsconfig, **2281 tests unitaires**, **274 E2E** (deux passages complets ; un echec isole
  sur `inbox-envoi-scenario` au premier passage, revenu vert seul et sur un ecran non touche : c'est
  l'instabilite deja documentee dans `playwright.config.ts`, serveur Next partage entre 4 workers).
- Les deux gardes de non-regression ont ete verifiees **DANS LES DEUX SENS** : garde retiree, le test echoue.
- **Sonde de bout en bout sur la PROD**, sans envoyer un seul message : sept corps postes sur l'URL publique
  (donc Cloudflare, NPM, la reecriture du front, l'API). Resultats : bon canal 200, canal etranger **403**,
  code inconnu **404**, corps illisible **200** (ne pas faire rejouer six fois ce qui ne sera jamais lisible),
  statut inconnu ignore. La sonde a laisse une conversation fictive sur `33600000000`, supprimee ensuite
  (1 message, 1 conversation, transaction bornee).

### Ajoute dans la foulee, le 2026-08-24

- **Les six formes de bouton** (Reponse, Lien, Appel, Agenda, Voir un lieu, Demander sa position). Deux
  demandaient plus qu un champ : la position n avait pas de RETOUR (coordonnees jetees, bulle vide) et
  l Agenda exige des date-heures absolues, donc prises dans un champ << date et heure >> du contact, avec
  chute du BOUTON (jamais du message) quand la date ne se resout pas.
- **Les boutons d une carte passent en LISTE.** Julien voulait les boutons larges des campagnes RCS et
  obtenait des mini-pastilles. Verifie dans la doc RBM : accroches a la CARTE ils s affichent pleine largeur
  et RESTENT (4 max), accroches au MESSAGE ce sont des pastilles ephemeres (11 max). Nous n en dessinons
  aucun. Des qu il y a un visuel, les boutons partent donc dans la carte.
- **La console heberge les visuels** (migration 0081). `POST /tenants/:id/rcs/media` rend directement l URL
  publique, servie par `GET /m/<code>.<ext>` (rewrite dedie, comme `/r/`). La SIGNATURE du fichier decide du
  type servi, jamais le type declare.
- 🔴 **Mesure a retenir : Cloudflare cache ces images au bord.** Avec `immutable` sur un an, une suppression
  restait sans effet un an (origine en 404, edge en 200, `cf-cache-status: HIT`). Ramene a 24 h, ce qui
  couvre toute la rafale d une campagne et borne l exposition. Purge immediate = jeton Cloudflare, qu on n a pas.

- **Envoi RCS depuis l Inbox** (bouton 📱). Sans garde de fenetre 24 h : cette fenetre est une regle de
  WhatsApp, pas du RCS, et c est justement quand elle est fermee que le RCS sert. Message pris dans la
  bibliotheque, variables resolues sur la fiche, refus en 422 avec sa raison.
- **Champ variable facon template Meta** : bouton << + Variable >>, chip [Prenom] au curseur, chaine stockee
  inchangee. L editeur a chips est partage avec le corps d un template (motif + resolveur de libelle).
- **`inbox-envoi-scenario` etait instable AVANT ce lot** (un echec sur six executions, mesure). Cause : le fil
  se recharge toutes les 4 s, un `selectOption` pendant le re-rendu vise un noeud detache sans rien signaler.
  Selection reessayee jusqu a etre posee ; le clic d envoi reste unique puisqu il poste.

### 🔴 Le canal est porte par le PARCOURS (2026-08-24, migration 0082)

Deux bugs trouves en testant le scenario reel de Julien, tous deux dus a la meme cause de fond : les regles du
moteur avaient ete ecrites quand WhatsApp etait le seul canal.

1. **Un scenario qui OUVRE par un bloc RCS n apparaissait pas** dans le selecteur de l Inbox fenetre fermee,
   c est-a-dire quand il servait le plus. `scanOpening` porte desormais `rcsOpen` dans les DEUX miroirs.
2. **Un << message rapide >> derriere un bloc RCS partait en WhatsApp**, chez un contact qui n y avait jamais
   ecrit : refus Meta 131047, parcours mort. Or un message rapide est un texte + reponses en un tap, que le
   RCS sait faire. Le bloc dit l INTENTION, le PARCOURS porte le canal (`workflow_runs.channel`).

Regle : un envoi RCS met le parcours sur `rcs`, un TEMPLATE le remet sur `whatsapp` (c est la bascule
volontaire), un message rapide suit. Le canal suit ce que le contact a RECU, jamais une intention : un bloc
RCS saute ne bascule rien, sinon le repli partirait en RCS chez un injoignable.

Seul le FORMULAIRE (WhatsApp Flow) reste impossible derriere un RCS, faute d equivalent : le builder le
signale.

### ✅ RESOLU : le clic sur un bouton RCS (2026-08-24, soir)

**Cause finale, trouvee en gardant le corps recu en base** : leur DOCUMENTATION montre un entrant avec
`from` = le contact et `recipient.to` = l agent ; leur PRODUCTION fait l INVERSE (elle garde l orientation du
sortant). On lisait `from`, on n y trouvait aucun chiffre, et on jetait le clic. Deux clics de Julien perdus.
On se fie desormais a la FORME (le premier des deux qui ressemble a un numero), pas a la position.

⚠️ **A retenir au-dela de smsmode** : l exemple d une doc d API n est pas la verite de sa production.

Corriges dans la foulee, tous signales en testant :
- le premier RCS d un scenario n apparaissait pas dans le fil d Inbox (seul chemin d envoi qui ne
  journalisait pas sa bulle) ;
- l ecran d envoi de template de l Inbox redemandait les variables en texte libre (desormais pre-remplies
  depuis la fiche, avec le libelle du champ) et l URL de l image d en-tete (desormais reprise du template).

### Trace du diagnostic (a garder, la methode a paye)

Symptome : le bouton << Recois un whatsapp >> du scenario de Julien ne declenche pas le template.

Etabli par mesure sur la PRODUCTION :
- le parcours `a6d096a3` est bien en attente sur le bloc RCS, canal `rcs`, `updated_at == created_at` : il n a
  JAMAIS avance ;
- le message est parti correctement (carte, image hebergee, boutons `btn:0`/`btn:1` DANS la carte) et il a ete
  **LU** a 22:36 ;
- un rappel smsmode est arrive 24 s apres l envoi, et **notre lecture l a rejete** (discrimination sur
  `direction`, corrigee : c est la presence d un `status` qui tranche) ;
- **aucun message ENTRANT n existe chez smsmode** sur 10 jours (`GET /rcs/v1/messages`, 4 items, tous MT).

Donc le rappel rejete etait un RAPPORT, pas le clic : le clic n a jamais produit d entrant, meme chez eux.

Deux causes possibles, une seule facon de trancher, un tap :
1. le tap n a pas ete fait / n a rien envoye ;
2. **l agent est depose en NON conversationnel** : il afficherait les boutons sans pouvoir recevoir de reponse.
   ⚠️ Ce choix est fait au depot et n est PAS modifiable (cf. `brain` RCS). Ce serait alors un redepot.

Tout est pret pour le prochain tap : parseur corrige, dernier rappel GARDE en base
(`rcs_agents.last_callback`, migration 0083), fil sous controle `app_workflow`, numero WhatsApp CONNECTED.

### Reste ouvert sur le canal

- Le **carrousel** n'a aucun composeur (le modele et le provider le supportent).
- `webviewSize` sur un bouton lien (ouvrir la page dans une vue integree) n est pas expose.
- Il n y a pas d ecran de MEDIATHEQUE : les visuels se televersent depuis le composeur, la route de liste et
  celle de suppression existent mais aucun ecran ne les appelle encore.
- Les deux cles d'API smsmode qui ont circule en clair dans une conversation sont **a faire tourner**. Elles
  sont desormais stockees chiffrees par workspace : les remplacer veut dire les ressaisir dans la carte
  d'activation de l'accueil.
- Aucun envoi RCS reel n'a ete refait apres ce deploiement : la chaine complete (envoi -> rapport -> reprise
  du parcours) n'est prouvee que par la sonde, pas encore par un vrai message.

## LIVRE ET DEPLOYE le 2026-08-23 : webhooks entrants (menu Tools)

Prod sur **`c109449`**, migration **0074** appliquee AVANT le code (image rebatie d'abord, sinon `migrate`
annonce << a jour >> depuis une image perimee). Les trois conteneurs sont sains et rattaches a
`mcp-robot_default`. Trois commits sont partis : le lot webhooks, le renommage du menu Contenu, et la
doc du lot precedent. Aucun n'etait le chantier d'une autre session.

Ce que ca fait : un outil tiers (Zapier, Make, un CRM, le formulaire d'un site) poste du JSON sur une adresse
que la console fournit ; on choisit en cliquant ou va chaque valeur (telephone, nom, champs de contact) et on
peut declencher un scenario. L'appelant n'est PAS le contact : c'est le CONTENU recu qui porte le telephone
et le nom, precision de Julien du 2026-08-23.

Decision d'architecture a retenir : un webhook qui declenche un scenario **possede** une ligne `automations`
de type `webhook` (`webhooks.automation_id`). On n'a donc ecrit AUCUNE logique de declenchement : les six
garde-fous de `runAutomations` s'appliquent tels quels. Cette ligne est invisible dans l'ecran Automation, et
cet ecran refuse d'en creer une. Detail complet : `documentation.md` §Webhooks entrants.

Etat des portes, mesure :
- racine `tsc` + `vitest` : **2158 tests** verts (2091 avant le lot, donc **67 nouveaux**).
- integration (base reelle) : **146 tests**, 141 verts + **6 nouveaux** sur l'appartenance des automations de
  webhook. Les **5 echecs** sont l'`ENCRYPTION_KEY` absente du `.env` LOCAL, connu et sans rapport (`todo.md`).
- web `tsc` + `vitest` : **107 tests** verts (**11 nouveaux**). `npm run build` passe, la route `/webhooks`
  est generee. `next lint` : aucun avertissement sur les fichiers neufs.
- E2E Playwright : **246 tests** verts (234 avant, donc **12 nouveaux**).
- Chaque test nouveau a ete verifie DANS LES DEUX SENS (mutation du code, echec constate, restauration).

Revue adversariale (agent separe, contexte isole) : **aucun rouge**. Trois points verifies un par un puis
corriges dans la foulee :
- Deux tests sur le secret **ne pouvaient pas echouer** : ils passaient par un faux store qui ne portait de
  toute facon aucun secret. La vraie frontiere est `toRow`, qui SELECTIONNE `secret_hash` et n'en garde que le
  booleen ; elle est desormais exportee et testee directement, et le faux store porte un etat.
- L'appartenance d'une automation a son webhook ne tenait qu'a un fait de presentation (l'identifiant n'est
  expose nulle part). Elle tient maintenant EN BASE : un predicat dans les quatre requetes de
  `PgAutomationStore`, avec un test d'integration qui le verifie dans les deux sens.
- Deux commentaires qui mentaient : un renvoi a une variable d'environnement inexistante, et une regle
  << jamais de 5xx >> que le code contredit deliberement en cas de panne de la file.

⚠️ En restaurant une mutation de test, un `git checkout` sur un fichier NON SUIVI par git n'a rien restaure :
la mutation (une fuite de l'empreinte du secret) est restee en place quelques minutes. Defaire une mutation
sur un fichier neuf demande une copie de sauvegarde, pas git.

Deux tests ecrits pendant ce lot **ne pouvaient pas echouer** et ont ete corriges :
- un test de « repli du mapping » qui passait aussi en dernier-gagne, parce qu'une regle qui ne resout pas
  n'atteint jamais l'affectation. Refait avec deux chemins qui resolvent tous les deux.
- deux tests E2E « pas attachable » dont le selecteur ne trouvait AUCUNE ligne : `toHaveCount(0)` sur un
  locator vide est toujours vrai. Les lignes de l'arbre portent maintenant un `data-cle`, et le test verifie
  d'abord que la ligne existe.

Verifie EN PRODUCTION, avec un webhook sonde cree puis supprime (mapping sans telephone, donc aucun contact
ne pouvait etre cree ; verifie apres coup : 0 contact, 0 webhook restant) :
- Appel bien forme -> **200** avec le corps complet, et la raison exacte (aucun champ du mapping ne vise le
  telephone).
- Corps non-JSON -> **400 `corps JSON invalide`**. C'est la preuve que la relecture du `rawBody` marche a
  travers Cloudflare + le rewrite Next + Fastify, la ou le parseur global aurait rendu un `{}` muet.
- Corps vide -> **400** explicite. Le payload est enregistre a l'identique, avec son horodatage.
- Code inconnu et code mal forme -> **404**. CRUD admin sans jeton -> **401**. Page `/webhooks` -> **200**.
- Non-regression : `/r/:code` rend toujours 404, le handshake Meta toujours 403, `/live` toujours 200.
- Les corps 4xx passent INTACTS a travers Cloudflare : c'est exactement pourquoi tout refus metier sort en
  4xx et jamais en 5xx.

⚠️ Le code de la sonde avait d'abord ete choisi avec des lettres EXCLUES de l'alphabet base32 (i, l, o, u).
La route l'aurait rejete a la verification de forme, et j'aurais conclu a une panne. Un code de test se tire
avec le meme alphabet que `newWebhookCode`, pas a la main.

Reste a faire :
- **Le premier appel d'un VRAI outil** (Zapier, Make) : jamais fait. L'arbre est teste sur des payloads
  fabriques, pas sur ce qu'un outil du marche envoie vraiment.
- Verification a l'oeil du parcours de bout en bout (creer, copier l'URL, envoyer un test, mapper).

## LIVRE ET DEPLOYE le 2026-08-21 : lot « 5 corrections »

Prod sur **`e77434d`**, migrations inchangees (**0073**), conteneurs sains. Cinq demandes de Julien,
traitees ensemble.

1. **Le nom de l'entreprise dans la miniature de template.** L'apercu affichait « Votre entreprise » sur
   100 % des rendus : la prop existait depuis toujours mais aucun ecran ne la passait. `PhoneFrame` resout
   desormais le nom verifie tout seul (une requete par espace, memorisee au niveau du module, car l'apercu de
   `TemplateForm` se redessine a chaque frappe), et l'ecran de campagne passe le numero REELLEMENT choisi.
2. **La cinematique du template cree a la volee.** Le bouton n'etait pas casse : il rechargeait une liste
   filtree sur APPROVED, affichee ailleurs, pendant que le panneau montrait un statut fige a la creation.
   L'ecran sonde maintenant tout seul (15 s, onglet au premier plan uniquement), selectionne le template des
   qu'il est approuve, et annonce un refus sans en inventer le motif.
   ⚠️ Le webhook `message_template_status_update` n'est ni souscrit chez Meta ni parse par `webhooks/parse.ts`
   (verifie des deux cotes) : le sondage est donc la seule voie, et un abonnement seul ne suffirait pas.
3. **Les clics dans le funnel par campagne** (Analytics > Quantitatif) et le RETRAIT de la carte « Clics sur
   les liens » de Mes tableaux, avec toute sa chaine (route `/stats/links`, `listAvecClics`, `lib/liens-traces`).
4. **Les faux clics.** 70 requetes mesurees sur le lien d'un template jamais envoye : 59 du robot
   `facebookexternalhit`, 11 de relecteurs Meta arrivant de Facebook. Filtre a l'ecriture
   (`src/links/clic-automatique.ts`, la redirection reste inconditionnelle) ET seuil « depuis le premier
   envoi » a la lecture, qui couvre en plus tout ce qui a ete enregistre avant.
5. **L'anglais.** 79 chaines francaises trouvees dans les modules `.ts` PURS (ou `useT()` est inappelable),
   toutes corrigees. Plus un vrai bug d'affichage : `ScenarioCanvas` comparait une chaine traduite a une
   chaine qui ne l'etait pas, donc en anglais le sous-titre redondant revenait sur tous les blocs.

### Revue adversariale passee (2026-08-21) : 6 rouges corriges

5 relecteurs sur dimensions separees, puis un refutateur par constat. 35 constats rapportes, 6 rouges
confirmes, tous corriges dans la foulee, jaunes compris (regle zero dette).

Les deux qui auraient coute cher en production :
1. **Le panneau annoncait « il est selectionne » sans savoir si quoi que ce soit l'avait ete.** La selection
   automatique s'abstient quand un AUTRE template a ete choisi pendant l'attente : la phrase mentait dans
   exactement le cas pour lequel le garde-fou avait ete ecrit, et la campagne partait avec l'autre template.
   La phrase suit desormais l'etat REEL (`templateName === submittedTemplate.name`).
2. **Les deux effets n'etaient bornes a AUCUN mode.** Apres une bascule vers Scenario ou RCS, le sondage
   continuait et `chooseTemplate` finissait par s'executer tout seul, ECRASANT la categorie (`marketing` au
   lieu de `utility`) que `chooseWorkflow` ne reecrit jamais : contacts sans opt-in ecartes, facturation
   changee. Les deux effets sortent maintenant si `mode !== 'template'`, et `chooseMode` ferme le panneau.

Les quatre autres : le marqueur `bot` teste en sous-chaine libre ecartait les vrais telephones **CUBOT**
(marque Android vendue en Europe) ; un total de contacts INVENTE a partir des lignes ramenees, plafonne par
la limite de la requete ; et deux tests qui ne pouvaient pas echouer (l'un gardait une normalisation deja
couverte par un `catch`, l'autre pretendait distinguer une reaction emoji sans jamais lui donner de payload).

### La meme fragilite, trouvee TROIS fois

Une reponse 200 amputee d'un champ pose `undefined` dans un etat type tableau, un `.length` ou un `.marketing`
du rendu jette, et React demonte l'ECRAN ENTIER. Le `try/catch` autour de l'appel n'y peut rien : il n'y a
aucune erreur reseau. Deja vu deux fois la veille (brouillons de campagne, fil de conversation), retrouvee ici
sur l'ecran de creation de campagne (`/contacts`) et sur le tableau de bord (`/stats`).

Les trois sont desormais NORMALISES a la frontiere reseau, avant d'entrer dans l'etat. Regle : tout champ
tableau lu d'une reponse se traite comme optionnel, meme quand le contrat dit qu'il ne l'est pas. Le typage
TypeScript ne couvre pas ce cas, il decrit ce que l'API PROMET.

### Verifie APRES deploiement, pas seulement en test
- 🔴 **Le filtre des faux clics, mesure en PRODUCTION sur le vrai lien** : 3 robots
  (`facebookexternalhit`, `curl`, `Googlebot`) + 1 relecteur Meta (vrai navigateur, referent
  `lm.facebook.com`) -> compteur INCHANGE a 70. Puis un vrai destinataire, sur un telephone **CUBOT** (le
  faux positif que la revue avait trouve) -> **71**. La redirection, elle, rend 302 vers la destination pour
  TOUT LE MONDE, robots compris.
  ⚠️ Le compteur de `testurl` est donc a 71 et non 70 : le +1 est mon clic de verification.
- Le nouveau libelle du funnel est bien dans le bundle servi, et `tableaux-liens` n'y est plus.
- `/api/backend/tenants/:t/stats/links` rend **404** : la route retiree a bien disparu.
- Routes protegees en **401** (et non 500), `/health` en 200, aucune erreur dans les journaux des trois
  conteneurs depuis le redemarrage.

### Ce qui n'a PAS ete verifie en production
- Le **nom de l'entreprise dans l'apercu** et la **cinematique du template** demandent une session connectee :
  couverts par 8 tests E2E, pas re-joues sur la prod. A regarder au premier passage sur l'ecran.

### Trouve en chemin, corrige au passage
- L'ecran de creation de campagne tombait ENTIEREMENT si `/contacts` rendait 200 sans le champ `contacts`
  (`undefined.length`). Normalise a la frontiere reseau. Meme classe de defaut que les deux ecrans perdus la
  veille.
- Deux fois : un backtick dans un commentaire SQL ferme le gabarit JS et produit des erreurs de syntaxe qui
  ne pointent pas la bonne ligne. Consigne dans `documentation.md`.
- Un `count` d'agregat sans `group by` rend toujours une ligne : « aucun lien trace » devenait « 0 clic ».
  C'est le test d'integration EXISTANT du funnel qui l'a attrape.

---

## LIVRE ET DEPLOYE le 2026-08-21 : lot « inbox, comptes, moderation » (7/7)

Prod sur **`c4d7b41`**, migrations jusqu'a **0073**, conteneurs sains. Cadrage et decisions :
`.loop/lot-inbox-comptes-moderation.md`. Le detail fonctionnel est passe dans `features.md`.

Les 7 items : brouillons de campagne (0068), entree Accueil, pagination + filtres SQL de l'inbox (0069),
fiche contact partagee, affectation (0070), moderation (0071), observation d'un espace depuis /ops,
multi-espaces par adresse (0072/0073).

**Le chantier « parametres d'activation MBA » est LIVRE lui aussi** (ecran Activation + migration 0067 +
regle du texte libre + abonnement webhook `standby`/`messaging_handovers`). Ce qui en reste ouvert est dans
`todo.md` : le test en conversation reelle est BLOQUE par l'absence de moyen de paiement (le bac a sable est
le seul canal), et la pastille « quelqu'un a besoin d'aide » attend cette mesure.

### Verifie APRES deploiement, pas seulement en test
- Reprise des comptes : 7 users, 7 identites, **0 sans identite, 0 hash perdu**.
- `/auth/login` rend 401 (et non 500) : la nouvelle requete d'identite tourne.
- `/auth/choose-workspace` et `/ops/observe` refusent proprement sans jeton valide.

### Ce qui reste ouvert
- **L'ECRITURE en observation** : volontairement hors lot. S'ouvrira action par action si le besoin apparait.
  Aujourd'hui une action faite par megarde chez un client serait indiscernable d'une action du client.
- **`users.password_hash`** subsiste, tenu en MIROIR de `identities` : c'est le chemin de retour de 0072.
  A retirer quand la confiance est acquise, jamais avant.
- 🔴 **0073 est la seule etape irreversible du lot** : recreer l'index d'unicite n'est possible que TANT
  QU'AUCUN doublon n'existe. Des qu'une adresse portera deux comptes, revenir en arriere voudra dire en
  choisir un a supprimer.
- Le **flake E2E** de `campaign-carousel-preview` (contention), quantifie dans `todo.md`.

---

## TERMINE ET EN LIGNE (2026-08-19/20) : le detail est passe dans features.md / documentation.md

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

### « Analytics > Mes tableaux » : ce qui est en ligne
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

### (en-tête de l’ancien wip.md, conservé pour le contexte)

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

## Pièce 1 : passe d'analyse : durcissement du balayage (2026-07-14) ✅

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

## État (2026-07-06) : V1 LIVE : 1er envoi WhatsApp réel fait ✅

`mba.messagingme.app` est en **prod LIVE** (`DRY_RUN=false`). Un numéro **Zadarma**
(WABA neuf hors UChat) est branché sur l'app Meta dédiée « Messaging Me MBA »,
webhook actif (statuts de livraison), et le **premier message WhatsApp réel a été envoyé depuis
la console** (template `hello_world`, wamid Meta, livraison remontée). Assets/secrets Meta :
`brain/PROJECTS.md` §Meta/WhatsApp.

**Backend (feature-loop, chaque brique reviewée par un agent séparé) :**
- Loop 1 : webhook receiver async (signature timing-safe, ACK bouclier, file pg-boss durable,
  dédup idempotente, DLQ, BSUID-native).
- Loop 2 : wrapper Meta typé (`MetaClient`, retries/backoff, rate limiter, transport injectable).
- Loop 3 : mini-CRM + import CSV (user fields, reconnaissance colonnes, E.164, variables template).
- Loop 4 : moteur de campagne + garde-fous (opt-in, fréquence marketing-only, quality gate,
  **claim atomique** anti double-envoi, idempotent, report).
- Loop 5 : adaptateurs Postgres + services + routes HTTP + run bout-en-bout (prouvé E2E Supabase).

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

## Lot MBA : Contenu/Analytics/Support (2026-07-12) : phases 0-7 LIVE ✅

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

## Lot 2 : Contact/Contenu/Analytics/Accueil/Ops (2026-07-12) : phases A-F LIVE ✅

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

## Lot 3 : Builder visuel (A formulaires + B automatisation) (2026-07-13) : LIVE ✅

Troisième grand lot en feature-loop (plan `.loop/lot3-builder.md`, revue transversale + fixes par phase,
commit + deploy à chaque phase). Deux builders DISTINCTS + le déclencheur campagne. Détail usage :
`features.md`. Détail technique : `documentation.md §Builder`.
- **Fix + quick wins** : bug suppression template (surface le `error_user_msg` de Meta au lieu de « Invalid
  parameter »), tag -> clic sur le compteur ouvre la **liste des contacts** taggés, **créer un nouveau champ
  depuis la fiche** contact, **miniature** de flow.
- **PA : Formulaires WhatsApp, TOUS les composants** : Dropdown/RadioButtonsGroup/CheckboxGroup, OptIn
  (consentement), passcode, date, **bouton final personnalisable**. Aperçu en direct. Menu Contenu>Flow
  renommé « **Formulaires** ». **Migration 0021** (`flows.cta`). 🔴 fermé (optin ne peut plus écraser un autre
  champ, défense front+back, RGPD).
- **PB1 : Workflow builder (modèle + éditeur visuel, SANS exécution)** : nouveau menu gauche « **Flow** »,
  éditeur **React Flow** (`@xyflow/react`), blocs template/inbox/flow/tag/field, flèches courbées drag,
  `+`/poubelle sur chaque arête, config par bloc. **Migration 0022** (table `workflows`).
- **PB2 : Moteur d'exécution** : `engine.ts` (`walk` linéaire), `executor.ts` (start applique les actions +
  persiste ; advance quand le contact répond, dédup `last_message_id`), avance branchée sur le webhook
  **isolée par message**. **Migration 0023** (table `workflow_runs`). 🔴 fermé (isolation par message).
- **PB3 : Déclencheur campagne (Template OU Workflow)** : le run de campagne DÉMARRE le workflow par
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

## Lot 5 : Builder v2 + variables + branche par bouton (2026-07-13) : LIVE ✅

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

## Lot 4 : Retouches builder + identité BSUID (2026-07-13) : LIVE ✅

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

## Lot 6 : Refonte auth + onboarding (2026-07-13) : 5 phases LIVE ✅

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

## Lot 7 : variables template + bot builder + fiche contact (2026-07-13) : LIVE ✅

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

## Embedded Signup + i18n + fixes campagne (2026-07-16) : LIVE ✅

- **Campagnes workflow : 3 pannes SILENCIEUSES fermées** (le « envoyé mais rien reçu » persistant) : cap fréquence
  24h retiré, indice périmé → 0 destinataire (dropdown coerce), **bouton FLOW #131009** (composant bouton flow +
  flow_token, vérifié vs Cloud API). Détail : `CLAUDE.md` §Gotchas 2026-07-16 + `brain/LEARNINGS.md`.
- **Champs système + sélecteur de variable dropdown** (constante code, sans migration ; attributs bsuid/wa_id ajoutés).
- **Brique Embedded Signup (Tech Provider)** construite + reviewée (2 failles multi-tenant corrigées avant prod) +
  déployée **OFF par défaut** (mig 0029 `waba_credentials`). Activée avec le `config_id` réel (bouton live).
- **i18n FR/EN** sur toute l'app (moteur `web/lib/i18n.tsx`, toggle menu Compte). Logo Meta Business Agent sur
  l'accueil, landing admin → Home, compte de test reviewer créé.

## Programme 16 features : lots A-E (2026-07-16) : LIVE ✅

Cinq feature-loops enchaînées (cartographie 9 explorers → plan `.loop/lotA..E-*.md` validé par Julien → boucle →
reviewer séparé → commit + deploy auto). **13 features + le socle API en prod.** Le reviewer a attrapé 4 vrais
bugs avant merge (dont le wiring `templateName` mort, cf `brain/LEARNINGS.md`).
- **A : Cohérence campagne/template** : variables template = source commune (6 champs de base + persos, comme la
  campagne), sélecteur de langue (39 langues + whitelist serveur), boutons visibles dans la miniature, écran
  campagne en 3 zones (nom en haut).
- **B : UX** : inbox auto-refresh (liste 15s / fil 4s, anti-saut-de-scroll, pause onglet masqué), analytics
  période FIGÉE en haut, suppression complète de « créer un compte » par mdp (invitations only, -221 lignes).
- **C : Scénario** : AUTO-SAVE (debounce + flush démontage/beforeunload keepalive + saves sérialisés, statut
  brouillon droppé mig **0030**, ⚠️ 1re migration DROP = deploy AVANT migrate), node **« message rapide »**
  (2-3 quick replies, `sendInteractive`, branche par bouton stable). Node `flow` no-op → différé Lot 7.
- **4a : Identifiants publics (schéma A)** : `<type>_<code-client>_<ULID>` ADDITIFS (mig **0031** + backfill
  `db/backfill-codes.ts`), racine client immuable, génération à l'INSERT (scn/usr/fld/tag), affichage discret.
  4b (nodes + champs système + endpoints) différé.
- **E : Analytics erreurs** : par TEMPLATE (dropdown, agrégation client) + par période (plage globale). 🔴 réel
  attrapé par le reviewer : wiring `index.ts` perdait le 3e arg → corrigé.
- **F (= 4b) : fin du socle identifiants** : codes des NODES mintés CÔTÉ SERVEUR au save (`nod_<client>_<ulid>`
  dans node.data.code, code valide conservé = stabilité, étranger/malformé re-minté = anti-forge), champs
  SYSTÈME déterministes (`fld_<client>_sys_<key>`), backfill nodes (1 graphe). ZÉRO migration. **Socle #12/#13
  COMPLET** ; endpoints API publics = chantier dédié (todo).
- **G (= 6) : i18n anglais COMPLET** : bug `<html lang>` fermé, day/format locale-REQUIS (Today/Yesterday,
  1,000, 42%, customers…), 0 `fr-FR` hors libs, `LocaleToggle` pré-login (5 pages). Sweep 11 agents parallèles.
  ⚠️ 2 leçons : test hors-sweep cassait le tsc racine (attrapé par le reviewer) + **gate pipé = exit masqué**
  (cf `brain/LEARNINGS.md`). Gates relancés exit codes réels.
- Tests : **707 unit** (681 → 707 : +26 nets). Migrations 0030-0031 appliquées. Baseline verte à chaque lot.

## Lot 7, Flow avancé (2026-07-17) : LIVE ✅, et fin du programme 16 features

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

## Lot 8 : Campagne « une-page, 2 étapes » (2026-07-17) : LIVE ✅

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

## Lot 9 : ConvAnalyzer light dans Analytics (2026-07-17) : LIVE ✅

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

## Migrations : l incident du 2026-08-17, a ne pas refaire

⚠️ **Ce titre annonçait « 0083 appliquée, prochaine libre = 0084 » jusqu au 2026-08-29 : quinze migrations de
retard.** Le compteur vit dans le CLAUDE.md du repo et NULLE PART ailleurs. Trois documents le recopiaient, tous
les trois faux (PLAN.md en retard de 43, le cerveau de 15, celui-ci de 5). Un compteur recopié est un compteur
qui dérive, et croire celui-ci menait à écrire par-dessus une migration existante.

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

## OTP automatique de l'Embedded Signup (Zadarma) : précâblage FAIT, pilote à mener (2026-08-16)

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

## Node « Envoi de mail » (SMTP) dans les Scénarios : design validé, plan à venir (2026-08-18)

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

## Reste (non bloquant) : voir `todo.md`

- TLS pooler en vérif complète (pinner la CA Supabase).
- Unicité email globale (décision produit).
- Pagination contacts UI, quality rating alimenté par webhook, tests DLQ/CI intégration.
