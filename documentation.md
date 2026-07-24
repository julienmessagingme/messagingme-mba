# documentation.md — technique

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

- **Runtime** : Node.js >= 20, TypeScript (ESM), `tsx` en dev.
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
  (brand/ink/mint/coral/gold/navy). Auth JWT (jose HS256), session côté client. 2 rôles admin/agent.
  Le front proxifie `/api/backend/*` vers `mba-api` (pas de CORS).
- **Auth** : login JWT (jose HS256, scrypt async, rate-limit + hash leurre anti-énumération), isolation
  tenant sur toutes les routes, **RBAC** (`adminOnly = active !== 'inbox'` ; écritures admin-only).
- **Tests** : vitest (~380 unitaires + intégration).
- **Hosting** : VPS OVH + Docker. 3 conteneurs (`mba-api` Fastify :8095, `mba-worker` pg-boss+sweeper,
  `mba-web` Next :3000) sur le réseau `mcp-robot_default`, NPM `mba.messagingme.app`. Cf `DEPLOY.md`.
- **Email** : Resend (formulaire de support).

## Schéma DB

Migrations SQL versionnées `db/migrations/` (suivi `schema_migrations`), appliquées via `npm run migrate`.
**Migrations NON auto-appliquées** au déploiement : toute migration qui ajoute une colonne écrite par le
code doit être passée sur le VPS AVANT de déployer ce code (sinon INSERT 500). Dernière : **0025**
(`phone_numbers.status`/`messaging_limit_tier` 0019, `campaign_recipients.error_code` 0020, `flows.cta` 0021,
table `workflows` 0022, table `workflow_runs` 0023, `campaigns.workflow_id` + template nullable 0024,
table `template_param_hints` 0025, table `auth_tokens` + `tenants.status` 0026).

Tables :
- `tenants` / `users` (`role` ∈ admin|agent, `name` nullable 0013, `disabled` 0014) / `waba` / `phone_numbers`.
- `contacts` — identité BSUID-native (`phone_e164` OU `bsuid`), opt-in tracé, `fields jsonb` (user fields),
  `tags text[]`. Merge jsonb qui n'écrase jamais une clé absente.
- `campaigns` (0003) — `template_name`/`template_language` (**nullable** depuis 0024, couplage par CHAÎNE,
  pas de FK), `category`, `status` ∈ draft|running|paused|completed|failed, + **`workflow_id`** (0024, FK
  `workflows` on delete set null) = campagne déclencheur de workflow (XOR template).
- `campaign_recipients` (0003+) — `status` interne ∈ pending|sending|sent|failed|skipped, `sent_at`, +
  **`delivery_status`** (0007) ∈ null|sent|delivered|read|failed (cycle Meta, écrit MONOTONE par message_id).
- `conversation_messages` (0009) / `conversations` — inbox. `template_category`/`template_name` (0012),
  **`sender_user_id`** (0017, FK users, on delete set null) = auteur d'une bulle sortante (pastille).
- `flows` (0015) — id = id Meta, `status` ∈ DRAFT|PUBLISHED, `fields jsonb` (DÉRIVÉ), + **`elements jsonb`,
  `ref text` (unique), `mapping jsonb`** (0016, modèle riche), + **`cta text`** (0021, libellé du bouton final).
- `workflows` (0022) — `name`, `status` ∈ draft|active, **`graph jsonb`** `{nodes[], edges[]}` (scope tenant).
- `workflow_runs` (0023) — état d'exécution PAR contact : `workflow_id`, `contact_id`, `wa_id`, `current_node`,
  `status` ∈ waiting|inbox|done, `last_message_id` (dédup d'avance). Index partiel sur les runs `waiting`.
- `webhook_events` — log brut, `meta_message_id` unique (idempotence). pg-boss = schéma `pgboss` séparé.

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
écrans -> 400). `buildFlowElements` = wrapper mono-écran (non-régression prouvée par test d'égalité).
**Conditions** : `visibleIf` (input `{field: LIBELLÉ source, op eq|neq, value}` -> stocké `{fieldKey}`) ->
propriété `visible` backticks ; sources dropdown/radio/optin du MÊME écran situées AVANT ; valeur ∈ options
(sans apostrophe/backtick, refusées) ou booléen. Sondé live : champ masqué/vide **OMIS** du payload complete
(-> `hasOwnProperty` du mapping suffit, aucun écrasement) ; un `required` caché ne bloque NI navigate NI
complete. Stockage : colonne jsonb `flows.elements` **POLYMORPHE sans migration**, normalisée par `screensOf`
à la lecture (null legacy / tableau plat historique = 1 écran / `{screens}` nouveau). `fields` reste DÉRIVÉ
(`fieldsOfScreens`). Image = **base64 BRUT** embarqué. `bodyLimit` 7 Mo. Édition d'un DRAFT = `POST
/{flow_id}/assets` en **multipart** (create en JSON inline — vérifié live) ; PUBLISHED immuable (409) ->
duplication (ref régénéré). **Sonde committée** : `scripts/sonde-flow-live.mts` (fixture via le code produit
POSTée en draft sur le WABA réel, exige `validation_errors == []`, delete) — à rejouer à chaque évolution
du générateur.

**Mapping webhook (défensif)** : à la réception d'un `nfm_reply`, `webhooks/flow-mapping.processFlowCompletions`
retrouve le flow par `_ref` (`findByRef`), itère sur NOTRE mapping (clé champ -> clé user field, jamais les
valeurs brutes -> `_ref`/`flow_token` jamais écrits) et fait un MERGE jsonb sur le contact
(`mergeFieldsByPhone`, même matching que l'inbox). **Isolé en try/catch, ne throw JAMAIS** : partage le job
webhook des statuts de livraison, un mapping cassé ne doit pas rejouer/DLQ les statuts.

## Builder de formulaires (A) + Workflow builder (B) — lot 3

**Dépendance front** : **`@xyflow/react`** (React Flow, ^12, MIT) pour l'éditeur de graphe de blocs.
Seule lib ajoutée du lot ; tout le reste reste Tailwind pur.

**(A) Formulaires WhatsApp** (`web/components/FlowBuilder.tsx`) : builder visuel de TOUS les composants d'un
écran Flow — textes (heading/subheading/body/caption), image, saisies (`text|email|phone|number|passcode`,
textarea, date), **choix à options** (`Dropdown`/`RadioButtonsGroup`/`CheckboxGroup`, data-source `id=title`),
**OptIn** (consentement -> **champ booléen dédié**), **Footer = bouton final au libellé personnalisable** (`cta`).
Aperçu en direct (`FlowScreenPreview`). ⚠️ RGPD : un champ basculé en `optin` **réinitialise son `saveTo`**
(front `changeType`/submit + back `parseFlowBody`) pour qu'un booléen de consentement ne puisse jamais écraser
un autre user field.

**(B) Workflow builder** (`src/workflow/`, menu gauche « Flow ») :
- **Modèle** `graph.ts` : `parseGraph` PUR (sanitise, intégrité référentielle arête->node, caps 200 nodes /
  400 edges). Types de bloc : `template` | `inbox` | `flow` | `tag` | `field`.
- **Moteur** `engine.ts` : `walk(graph, startNodeId)` LINÉAIRE — blocs `tag`/`field` = action synchrone puis on
  continue ; `template`/`flow` = envoi puis **attente** ; `inbox` = terminal (conversation remontée à l'humain) ;
  anti-cycle. `executor.ts` : `start` applique les actions + persiste le run ; `advance` quand le contact répond,
  **dédup par `last_message_id`**.
- **Avance** branchée sur le webhook inbound (`webhooks/workflow-advance.processWorkflowAdvance`), **ISOLÉ en
  try/catch par message** (comme le flow-mapping : ne throw jamais, partage le job webhook des statuts).
  ⚠️ V1 : avance sur **n'importe quelle** réponse inbound (pas de branche par bouton quick-reply -> réservé).
- **Déclencheur = campagne** (`campaign/engine.ts`) : si `campaign.workflow_id`, le run de campagne appelle
  `startWorkflow` (executor.start) par destinataire **au lieu d'un envoi template**, en réutilisant l'infra
  campagne (claim atomique anti double-envoi, quality gate, fréquence marketing) — **pas de nouvelle file ni
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

## Lot 5 — sélecteur de variable (hints) + branche par bouton

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
token en localStorage `mba.ops`, fetch dédié qui ne touche pas la session console). Aucune écriture exposée.

## Support (Resend)

`src/support/resend.ts` (`ResendClient.send` -> POST `/emails`) + `src/http/support.ts` (POST
`/tenants/:id/support`, auth requise, 503 si non configuré, 502 sur erreur d'envoi, destinataire FIXE
serveur). Env : `RESEND_API_KEY`, `SUPPORT_FROM` (défaut `onboarding@resend.dev` = mode test), `SUPPORT_TO`.

## Décisions actées (lot MBA, D1-D10)

D1 édition template = autoriser + **bloquer si campagne active** (409). D2 clé user field **verrouillée**.
D3 tags **dérivés** des contacts. D4 mapping flow -> user field (défaut = slug du champ + ensureField, ou cible
choisie ; merge-si-contact-existe). D5 Analytics = `/dashboard` relabellé ; read receipts **campagnes-only**.
D6 coût = réutiliser `/stats/templates` (zéro backend). D7 largeur cap `max-w-7xl`. D8 support = form phase 1,
Resend phase 7. D9 Abonnement/Billing désactivés. D10 flow publié = **dupliquer pour modifier**.

## Variables d'environnement

Voir `.env.example` / `.env.prod.example`. Clés : `PORT`, `META_APP_SECRET` (signature webhook),
`META_VERIFY_TOKEN` (handshake), `META_ACCESS_TOKEN` (System User, envoi), `META_GRAPH_VERSION`,
`META_FLOW_JSON_VERSION`, `META_APP_ID` (=`988129420727963`, sert au FB.init + à l'échange de code ES),
`AUTH_SECRET` (fail-fast en prod, >= 32 octets), `DATABASE_URL`, `DRY_RUN`, `RESEND_API_KEY` / `SUPPORT_FROM` /
`SUPPORT_TO` (support), **`META_ES_CONFIG_ID`** (Embedded Signup ; vide → feature OFF, route 503), **`ENCRYPTION_KEY`**
(64 hex ; chiffre les tokens business ES ; fail-fast prod si `META_ES_CONFIG_ID` posé). ⚠️ Un changement de `.env.prod`
exige `docker compose up -d --force-recreate` (env_file rechargé seulement à la recréation).

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
  1..N, throw sinon) résout par destinataire -> `resolvedParams` persistés -> `buildComponents` à l'envoi.
- **Campagne via WORKFLOW** (lot 7) : chemin distinct. La closure `sendTemplate` de `worker.ts` obtient N (corps
  live via `MetaTemplateClient.list`, caché 5 min par WABA|nom|langue), lit les hints, résout le contact
  (`getResolvableByPhone`, matching phone exact/chiffres nus/bsuid), et appelle `resolveHintParams(hints, N,
  contact, examples)` (SPARSE, garantit N valeurs, repli exemple) -> `buildWorkflowTemplateComponents` (fonction
  PURE, `src/workflow/template-send.ts`, testée directement — pas un fake d'executor). Corrige Meta #132000.
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

## i18n FR/EN (2026-07-16)

`web/lib/i18n.tsx` : `LocaleProvider` (langue dans un contexte, persistée localStorage, défaut FR, appliquée après
montage → pas de mismatch d'hydratation ; l'effet de montage resynchronise AUSSI `document.documentElement.lang`) +
`useT()` → `t('texte FR', 'EN text')` **co-localisé** au point d'appel (pas de dictionnaire central). Provider dans
`app/layout.tsx`, toggle dans `AccountMenu` + `LocaleToggle` (pill FR/EN) sur les 5 pages pré-login. Règle : NE JAMAIS
wrapper une valeur backend/clé/comparaison dans `t()` ; chaînes au niveau module → déplacer dans le composant ou passer `t`.

**Lot 6 (2026-07-16), dates/nombres/libellés localisés** : le type `Locale` vit dans `web/lib/locale.ts` (**.ts pur** :
le tsc racine n'a pas `--jsx`, importer un type depuis `i18n.tsx` casse le build → TS6142 ; i18n.tsx le ré-exporte).
`day.ts` (`dayLabel`/`hourMin`/`formatDate`) et `format.ts` (`fmtNum`/`fmtPct`/`throughputLabel`/`tierLabel`) prennent
un `locale` **REQUIS** (pas de défaut : tsc LISTE tous les appelants, aucun oubli possible). Les tags BCP47 (`fr-FR`/
`en-GB`) sont CONFINÉS à ces 2 libs : grep `fr-FR` = 0 ailleurs dans `web/`. `dayKey` (en-CA = clé ISO de tri) et
`fmtCost` restent indépendants de la langue.

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
  elle était 100 % cosmétique) — ⚠️ 1re migration DROP du repo : deploy AVANT migrate (cf DEPLOY.md).
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
  **Garde fenêtre 24 h à 3 étages** : `opensOutsideServiceWindow` (engine, détecte flow/quick_message en
  OUVERTURE y compris derrière une chaîne tag/field) -> 400 au save du graphe (POST+PATCH workflows) ; skip
  défensif + console.error dans `executor.start()` (graphes antérieurs) ; badge rouge UI sur le node
  d'ouverture RÉEL (traversée des blocs synchrones dans WorkflowBuilder). L'avance du run sur `nfm_reply`
  est la mécanique existante (fallback 1re arête, dédup lastMessageId) : inchangée.

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
- **`/ops` = surface cross-tenant LECTURE SEULE**, autorité SÉPARÉE du JWT : header `x-ops-token` == `OPS_TOKEN`
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
- **Débit Meta : `throughput_level` ≠ `messaging_limit_tier`.** throughput = débit d'envoi (STANDARD 80 msg/s, HIGH
  1000/s) ; messaging_limit_tier = **cap de clients uniques par 24 h** (TIER_250/1K/10K/100K/UNLIMITED). Deux infos
  distinctes à afficher séparément (`web/lib/format.ts` `throughputLabel`/`tierLabel`).
- **État HubSpot d'un numéro = lecture CROSS-SCHEMA** : mba lit `mmhs.tenant_portals`/`mmhs.portals` (schéma du
  connecteur mm-hubspot, même Supabase) via `getHubspotPortal` (best-effort, catch -> non connecté, jamais de 500).
  Le toggle par-numéro (`phone_numbers.hubspot_connected`) gate le push d'analyse. Bouton « Connecter HubSpot » =
  lien `mm-hubspot.messagingme.app/oauth/install?tenant=<tenantId>`.

### Gotchas / décisions (2026-07-16)
- **Campagne workflow : 3 pannes SILENCIEUSES fermées** (le « envoyé mais rien reçu » persistant). (a) **Cap fréquence 24h RETIRÉ** : `DEFAULT_THRESHOLDS.frequencyWindowMs=0` + garde `t.frequencyWindowMs > 0` (court-circuit, aucune requête). Un garde-fou qui laissait un destinataire `pending` en silence pendant que la campagne se marquait `completed` = panne invisible ; plomberie fréquence conservée + testée (fenêtre >0 la réactive). (b) **Indice de template périmé → 0 destinataire** : un hint `{field, nom}` fantôme mappait `{{1}}` sur un champ inexistant ; le `<select>` affichait « Nom » mais gardait le sel fantôme -> tous sautés. Fix front `selForSource` (coerce un champ inconnu → `sys:name`) + option de garde + campagne 0 destinataire = avertissement ROUGE. (c) **Bouton FLOW à l'envoi (#131009)** : un template à bouton **FLOW** (NAVIGATE) part rejeté sans son composant bouton ; Meta exige `{type:'button', sub_type:'flow', index, parameters:[{type:'action', action:{flow_token}}]}` avec `flow_token` NON vide. mba corrèle la réponse par `_ref` baké dans le flow_json, donc le flow_token peut être n'importe quelle valeur unique (`worker` passe `${waId}-${Date.now()}`). **Vérifié empiriquement contre la Cloud API** avant de coder. Détail transversal : `brain/LEARNINGS.md` 2026-07-16.
- **Champs SYSTÈME (Nom/Prénom/Téléphone/BSUID/WhatsApp ID/Email) = constante de CODE, SANS migration** : `src/crm/fields.ts` SYSTEM_FIELD_KEYS (garde PATCH/DELETE/POST 403/409) + `web/lib/fields.ts` SYSTEM_FIELDS (miroir, source par champ). Résolus via les attributs existants + 2 nouveaux (`bsuid`, `wa_id` dans `ParamSource`/`valueOf` switch + `getResolvableByPhone` remonte bsuid). Sélecteur de variable de campagne = **dropdown** (base + vrais champs perso + texte fixe), fini la clé tapée à la main.
- **Embedded Signup (Tech Provider) — LIVE mais OFF par défaut.** Bouton « Connecter mon compte WhatsApp » (accueil, espace sans numéro). Env : `META_ES_CONFIG_ID` (vide → route 503 + bouton placeholder), `ENCRYPTION_KEY` (64 hex, fail-fast prod si config_id posé), `META_APP_ID=988129420727963`. Backend `src/http/embedded-signup.ts` + `src/meta/embedded-signup.ts` + `src/account/es-store.pg.ts` + `src/crypto/secretbox.ts` (AES-256-GCM). **Anti-hijack** : `verifyWaba`+`getPhone` BLOQUANTS avec le business token avant tout rattachement (sinon un tenant relie les assets d'un autre). Token+pin **chiffrés** (mig **0029** `waba_credentials`, col `pin_enc`). Config Meta via template « WhatsApp Embedded Signup 60-day » (cf `brain/LEARNINGS.md`). ⚠️ Marche seulement quand Meta a validé Access Verification (Tech Provider) + App Review — **soumises le 2026-07-16, en review**.
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
- **Sonde LIVE committée** : `MBA_TOKEN=$(ssh ubuntu@146.59.233.252 "grep '^META_ACCESS_TOKEN=' /home/ubuntu/mba/.env.prod | cut -d= -f2-") WABA_ID=1695646181671929 npx tsx scripts/sonde-flow-live.mts` — à rejouer à CHAQUE évolution du générateur flow_json (crée un draft sur le vrai WABA, exige `validation_errors == []`, se nettoie).
- **Preview interactive Meta** = banc de test runtime sans device : `GET /{flow_id}?fields=preview.invalidate(false)` puis `?interactive=true&debug=true&flow_action=navigate&flow_action_payload={"screen":"FORM"}` (les 2 derniers params REQUIS ensemble) ; le panneau debug affiche le payload exact de chaque action.

### Gotchas / décisions (2026-07-17, Lot 9 : ConvAnalyzer light)
- **⚠️ `conversation_analysis.created_at` = date de DERNIÈRE analyse, pas de la conversation** : la table est upsertée (`on conflict do update set created_at=now()`). Tout agrégat temporel dessus compte des ré-analyses, pas des conversations nouvelles ; une ligne ré-analysée saute de fenêtre. Assumé et LIBELLÉ « à date de dernière analyse ». Pour une vraie timeline, joindre `conversations.created_at` (stable). Cf `brain/LEARNINGS.md`.
- **Couche de LECTURE séparée du moteur d'écriture** : `src/stats/conversation-stats.pg.ts` (lecture, 1er lecteur de la table) ≠ `src/analysis/store.pg.ts` (écriture). Ne pas mélanger. `tenant_id=$1` sur CHAQUE requête (IDOR = leçon convanalyzer). Filtres quali validés contre un SET d'enum (valeur hors enum ignorée, pas d'injection).
- **Champs LLM = indicatifs** (sentiment/intent/topic/resolved/action/confidence) ; `handled_by`/`exchanges_count` sont DÉTERMINISTES (code). Bucket `handled_by='mba'` inatteignable (MBA fermé ToS) -> 2 valeurs réelles, ne pas dessiner 3 catégories égales.
- **Repo web SANS lib de charts** (règle no-ai-slop) : donut = SVG maison (`pathLength=100` + `stroke-dasharray`), barres = patron inline existant. Ne JAMAIS ajouter recharts/tremor/d3.
- **Analyse ACTIVE en prod** : `CONVERSATION_ANALYSIS_ENABLED=true`, `LLM_MODEL=claude-haiku-4-5`. La table se remplit ; empty-state (`total=0`) couvre « inactif » (via `enabled`) ET « aucune donnée sur la période ».

### Gotchas / décisions (2026-07-17, Lot 8 : campagne une-page)
- **⚠️ Timeout d'un job de file THROTTLÉ = dimensionné PAR JOB, pas une constante** : un run de campagne à débit bas tourne des heures ; un `expireInSeconds` fixe (pg-boss défaut 900s) le fait EXPIRER -> **rejeu parallèle** (l'original n'est pas tué) -> débit réel x2 + statut `completed` prématuré. Fix : `src/campaign/pacing.ts campaignJobExpireSeconds(n, rate)` passé PAR JOB à l'enqueue (`Queue.enqueue({expireInSeconds})`, route `/run` via `getRunSizing`). ⚠️ `pg-boss createQueue` est `ON CONFLICT DO NOTHING` (ne met PAS à jour une file existante) : pour une policy de file, `updateQueue` ; pour une valeur qui varie, l'option par job. Cf `brain/LEARNINGS.md`.
- **Filtres CRM = WHERE 100 % paramétré, clé jsonb LIÉE** : `contact-store.buildWhere` — `fields ->> $key` (la clé vient de l'utilisateur, JAMAIS interpolée), `tenant_id=$1` toujours. Route GET /contacts (+/count, +/ids) dans `src/http/import.ts` (PAS http/contacts.ts, piège de localisation) ; `parseFilters` défensif (JSON de `fields` illisible -> ignoré). Le submit campagne reste `contactIds` (buildRecipients = dernier garde opt-in).
- **Statut campagne `scheduled` à propager PARTOUT** : `CampaignStatus` + CHECK `campaigns_status_check` (mig 0034, DROP+ADD, nom vérifié) + `STATUS` map front + garde D1 `listActiveCampaignsForTemplate` (édition template) + counts (listCampaignSummaries n'a AUCUN filtre de statut, OK). Sweeper `schedule-sweep.ts` : enqueue PUIS markRunning (jamais de 'running' orphelin), idempotent (singletonKey + garde `status='scheduled'`).
- **Import réutilisable** : `web/components/CsvImport.tsx` extrait (Contacts + campagne, prop `requireTag`), zéro dupe. Contacts NE navigue plus après import (le rapport + erreurs par ligne sont enfin visibles).

### Gotchas / décisions (2026-07-16, fin de programme : lots 4b + 6)
- **Codes de NODES (Lot 4b) = mint SERVEUR, jamais confiance au client** : `src/workflow/node-codes.ts` au POST/PATCH workflows (après parseGraph). Regex anti-forge `^nod_<tenantCode>_[ULID]$` : code valide du MÊME tenant → préservé par référence (stabilité des codes existants) ; absent/forgé/autre tenant → re-minté. La réponse renvoie le graphe ENRICHI (le front réaffiche les codes sans re-fetch). Champs système : code **déterministe sans stockage** `fld_<client>_sys_<key>` (`systemFieldCode`), le front le calcule via `tenantCode` exposé par GET /fields (dep OPTIONNELLE côté fields, REQUISE côté workflows).
- **⚠️ Type partagé front : `Locale` vit dans `web/lib/locale.ts` (.ts PUR)** : le tsc RACINE (qui type-check `tests/`) n'a pas `--jsx` → importer même un simple type depuis un `.tsx` casse le build (TS6142). Tout type consommé par du code non-JSX doit vivre dans un `.ts` ; `i18n.tsx` le ré-exporte pour les composants.
- **Helpers localisés = paramètre `locale` REQUIS, pas de défaut** (`day.ts`, `format.ts`) : tsc LISTE alors tous les appelants à mettre à jour, zéro oubli possible (l'inverse du piège d'arité des closures). Tags BCP47 confinés aux 2 libs, grep `fr-FR` = 0 ailleurs dans `web/`.
- **⚠️ GATES : jamais de pipe sur une commande gate** : `npm run build 2>&1 | tail` renvoie l'exit du TAIL → un build cassé passe « vert ». Toujours `cmd > log 2>&1; echo EXIT=$?`. Et **vitest ne type-check PAS** (esbuild) : 707 tests verts ≠ tsc vert. Cf `brain/LEARNINGS.md` 2026-07-16.
