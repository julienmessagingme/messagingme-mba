# Audit anti-slop 2026-08-18 : code simple, structure maintenable

> **État au 2026-08-18 (soir) : CORRIGÉ.** Les 6 rouges et 50 des 51 jaunes sont traités et poussés
> (commits `b1f3758` → `e0eb079`). Le rapport ci-dessous garde l'état d'origine, il sert de trace.
> **Reste UN item, volontairement non fait** : le découpage de `web/lib/api.ts` (1325 lignes, 203 exports)
> par domaine derrière un barrel. Mécanique mais il brasse tous les imports du front : à cadrer avec Julien.
>
> Deux changements sont **visibles à l'écran** : l'aperçu WhatsApp n'affiche plus « Messaging Me Tech » en dur
> (faux chez tout autre client) mais un libellé générique, et l'interrupteur MBA grise pendant sa sauvegarde
> comme les trois autres.
>
> Un **flake E2E préexistant** a été corrigé au passage : 3 échecs sur 5 suites complètes avant, 0 sur 5 après.


Audit demandé par Julien : « code simple et structure du code maintenable sans verbiage et sans slop ».

**Méthode** : 7 zones auditées en parallèle (~40 000 LOC lues), chaque zone par un auditeur puis un
contre-expert adversarial séparé qui refait les grep, compare réellement les duplications alléguées,
et réfute par défaut si la preuve ne tient pas. Résultat : **57 findings rapportés, 57 confirmés**
(plusieurs regradés rouge → jaune ou corrigés en détail par la contre-expertise). Standard appliqué :
« un dev senior de CE repo l'écrirait-il comme ça ? ». Les bugs fonctionnels n'étaient pas la cible.

## Verdict global

Le repo est **sain dans sa structure profonde** : moteurs purs avec IO injectée, scoping `tenant_id`
systématique, transactions propres (rollback + release partout), commentaires narratifs qui
verrouillent de vrais incidents (un actif, pas du bruit), logique métier front dans des modules purs
testés, pattern de parité front/back verrouillé par tests. Aucune dérive de stack, quasi aucune
abstraction spéculative (1 finding sur 57).

La dette réelle est **concentrée et d'une seule nature : le copier-coller**. 24 findings de
duplication sur 57. Le repo connaît pourtant son propre antidote (fragments partagés type
`UNREAD_SQL`, tests de parité, extraction en composants) ; la dette, c'est les endroits où le
réflexe n'a pas été appliqué. Trois fichiers concentrent l'essentiel : `campaign/store.pg.ts` (848
LOC, 5 classes), `crm/contact-store.pg.ts` (635 LOC, 3 responsabilités), `campaigns/page.tsx` (1636
LOC, CreateForm ~1000 lignes).

## 🔴 Les 6 rouges

1. **`src/http/account.ts:71` (et 21 autres fichiers) : `scopeTenant` copié 22 fois.** C'est le
   contrôle d'accès tenant du produit, dupliqué à l'identique dans 22 des 26 fichiers de src/http
   (y compris une copie imbriquée dans `import.ts:85`). Un durcissement futur devrait être reporté
   à la main 22 fois, un oubli serait silencieux.
   **Fix** : extraire dans un module partagé (`src/http/scope.ts`) et importer partout.

2. **`src/http/v1-sends.ts:79` : cast `as TemplateParam[]` sur l'API publique.** Violation directe
   de la règle « jamais de `as` sur un payload externe » : un élément sans `source` part dans
   `resolveTemplateParams` et jette une TypeError, soit un 500 public (que Cloudflare maquille) là
   où la route console répond 400 via `validateParamMapping` sur le même shape.
   **Fix** : `validateParamMapping(b.params ?? [])` + 400 si null, comme `campaigns.ts:245`.

3. **`src/campaign/store.pg.ts:141` : `insertCampaign` duplique l'INSERT 13 colonnes de
   `createWithRecipients` et n'a aucun appelant applicatif** (tests d'intégration uniquement). Ce
   doublon a déjà produit un faux vert en prod (workflow_id non persisté par le vrai chemin, cf.
   wip.md et PLAN-BLOC-A.md). Les colonnes RCS de 0056 ont déjà été ajoutées deux fois.
   **Fix** : fonction module `insertCampaignRow(q, input)` partagée, ou suppression et tests
   d'intégration via `createWithRecipients(input, [])`.

4. **`src/crm/contact-store.pg.ts:132` : le fragment SQL de matching wa_id copié 9 fois** (+ 1 dans
   `inbox/store.pg.ts:85`), avec divergence déjà commencée (`deleted_at is null` dans une copie,
   bsuid perdu dans deux docstrings). C'est la règle de routage des messages entrants.
   **Fix** : const module `MATCH_BY_WAID_SQL` interpolée (positions $1/$2 identiques partout,
   vérifié), même pattern que `UNREAD_SQL`.

5. **`web/app/inbox/page.tsx:332` : `ScenarioSendPanel` (~100 lignes) est défini DANS le corps de
   `Thread`** (indentation colonne 0 trompeuse). Composant recréé à chaque rendu : React le démonte
   et remonte, donc la modale ouverte perd sélection et fetch à chaque re-render de Thread (poll
   4 s). C'est un bug réel en plus d'une dette structurelle.
   **Fix** : déplacer au niveau module à côté de `TemplateSendPanel` (l.620), remonter `saveReturn`.

6. **`web/app/campaigns/page.tsx:555` : `CreateForm` fait ~1000 lignes et 41 hooks** dans une page
   de 1636 lignes, et cumule 6 responsabilités (destinataires, template/scénario/RCS, variables,
   débit, programmation, machine à états de lancement). Chaque feature récente y atterrit.
   **Fix** : extraire vers `web/components/CampaignCreateForm.tsx`, comme TemplateForm/CsvImport/
   ContactFilterPanel l'ont déjà été.

## 🟡 Les 51 jaunes, par zone

### src/http (+ index.ts, worker.ts)

- `api-keys.ts:21` (duplication) : `nonEmpty` recopié 12 fois. Fix : même module partagé que scopeTenant.
- `account.ts:8` (structure) : types de persistance définis côté HTTP et importés par le store, dépendance inversée unique dans src/. Fix : déplacer vers `src/account/`.
- `account.ts:43` (duplication) : `StatusPatch` redéfinit `PhoneStatusPatch` (3 copies, drift commencé). Fix : typer la dep avec `PhoneStatusPatch` de account/pull.
- `account.ts:157` (complexité) : les 12 champs Meta énumérés 3 fois (let, spreads, réponse) là où le sweep persiste en une ligne. Fix : rest-destructuring comme `status-sweep.ts:71`.
- `contacts.ts:60` (duplication) : `normalizeContactFilters` recopie ligne à ligne le cœur de `parseFilters` (import.ts). Fix : constructeur partagé, chacun garde son décodage d'entrée.
- `worker.ts:264` (duplication) : stores ré-instanciés alors que l'instance existe dans la portée (recipientStore l.114, esCredentialsStore index.ts:98, PgPhoneStatusStore x2 à hisser). Fix : réutiliser/hisser.

### src/campaign, workflow, automation, queue

- `campaign/run-job.ts:64` (duplication) : `RunJobDeps` redéclare 6 signatures d'`EngineDeps`, `channel` a déjà divergé (piège de type, pas de bug actif). Fix : `extends Pick<EngineDeps, ...>`.
- `campaign/engine.ts:122` (duplication) : `waIdOf` local réimplémente la dérivation wa_id que `crm/identity.ts` déclare « règle unique ». Fix : exporter une variante `waIdOfTarget` depuis crm/identity.
- `campaign/store.pg.ts:567` (complexité) : `PgCampaignRepo` fourre-tout, workflow/wiring exige la classe entière pour 2 lectures waba/phone. Fix : petit store « tenant assets » (ou Pick au minimum).
- `campaign/store.pg.ts:409` (duplication) : projection des résumés dupliquée entre list et détail, prédicat d'échec encodé 5 fois. Fix : constantes module `SUMMARY_SELECT` + prédicat.
- `campaign/store.pg.ts:435` (complexité) : 3e requête pour `param_mapping` alors que la requête de tête (group by PK) peut le sélectionner. Fix : ajouter au SELECT de tête.
- `workflow/executor.ts:229` (convention) : 2 JSDoc orphelins (doc de runFrom sur resume, firstTemplateParams sur buildCtx) + contrat « renvoie false » périmé. Fix : recoller et corriger.
- `workflow/wake-sweep.ts:26` (convention) : commentaire « 5 minutes » alors que le bail est 15 (aussi run-store.pg.ts:122/128). Fix : ne plus citer la durée hors de `claimDueSleeping`.
- `workflow/engine.ts:189` (code mort) : `opensOutsideServiceWindow`, wrapper 2 lignes sans appelant applicatif. Fix : supprimer, tests sur `scanOpening(g).sessionOpen`, MAJ documentation.md:696.
- `queue/pgboss.ts:128` (code mort) : `pullPending` test-only avec effet de bord, retrait déjà décidé (PLAN.md item 5.10). Fix : exécuter l'item 5.10.
- `automation/match.ts:30` (abstraction spéculative) : `AUTOMATION_TRIGGER_KINDS_CREATABLE` identique à la liste principale depuis E.2. Fix : supprimer la scission, la recréer si un kind moteur-seulement renaît.

### src/crm, inbox, analysis, stats

- `crm/contact-store.pg.ts:478` (duplication) : `list()` réécrit `query()` intégralement. Fix : déléguer.
- `crm/contact-store.pg.ts:186` (code mort) : `addTagsByPhone`, wrapper sans appelant prod (docstring déjà fausse). Fix : supprimer, adapter les 2 tests.
- `crm/fields.ts:101` (duplication) : `ensureField` duplique `ensureFieldByKey`. Fix : délégation avec `slugify(label)`.
- `crm/hubspot-import.ts:35` (structure) : le fichier est devenu le client générique du canal service mm-hubspot. Fix : renommer `crm/hubspot-service.ts` (4 importeurs).
- `analysis/engine.ts:16` (code mort) : `hasAutomated` calculé et transporté, jamais lu. Fix : retirer du type, du calcul, des fixtures.
- `analysis/events.ts:7` (code mort) : `OnConversationReady` importé nulle part. Fix : supprimer.
- `stats/store.pg.ts:69` (duplication) : CTE `bounds` DST-safe recopié 9 fois dans les 2 stores. Fix : const partagée dans `stats/range.ts`.

### src/meta, zadarma, webhooks, rcs, hubspot, api

- `meta/languages.ts:9` (duplication) : 39 codes dupliqués dans web/lib sans le test de parité que le repo utilise pour ses 3 autres duplications cross-build. Fix : `tests/web-languages-parity.test.ts`.
- `webhooks/inbound.ts:39` (duplication) : `asArray`/`asRecord` définis 3 fois dans le dossier (`str` diverge null/undefined, à laisser local ou unifier délibérément). Fix : `src/webhooks/json.ts`.
- `webhooks/parse.ts:8` (code mort) : membre `'unknown'` de l'union jamais produit ni consommé. Fix : retirer de l'union.
- `meta/flow-json.ts:116` (code mort) : `deriveElements` + `buildFlowElements` sans appelant prod, test d'égalité devenu tautologique. Fix : migrer les tests, supprimer, MAJ documentation.md:79.
- `webhooks/handover.ts:48` (complexité) : condition à moitié inerte (`str(...) !== undefined` impliqué par `in`). Fix : garder le seul `in`.

### src/auth, account, flow, user, settings (socle)

- `user/store.pg.ts:185` (convention) : docblock documente `'updated'`, le code renvoie `'ok'`. Fix : corriger le mot.
- `auth/middleware.ts:54` (convention) : docblock de `makeRequireAuth` accroché à `makeRequireOps`. Fix : recoller.
- `account/store.pg.ts:2` (structure) : miroir du finding http (import store → http). Même fix.
- `account/store.pg.ts:137` (duplication) : upsert de recalcul `campaigns_paused` copié dans 2 transactions. Fix : méthode privée `recomputeCampaignsPaused(client, tenantId)`.
- `flow/store.pg.ts:61` (duplication) : mapping row → FlowRow dupliqué entre `list()` et `getById()` (un nouveau champ = 4 éditions). Fix : `toFlowRow(r)` privé.

### web/app

- `accueil/page.tsx:357` (duplication) : markup du toggle copié 4 fois, handler optimiste 3 fois. Fix : `web/components/Toggle.tsx` + helper optimiste (applyHubspotState reste à part).
- `campaigns/page.tsx:1571` (duplication) : `inputCls` en 32 occurrences dans 24 fichiers, variante déjà divergente. Fix : exporter une fois (`web/lib/ui.ts`).
- `campaigns/page.tsx:55` (code mort) : imports de types `WorkflowGraph`/`WorkflowNode` inutilisés. Fix : supprimer.
- `campaigns/page.tsx:718` (duplication) : comptage `{{n}}` inline alors qu'inbox a `varCountOf` (même regex). Fix : exporter depuis web/lib (synchro backend reste par convention, builds non partagés).
- `campaigns/page.tsx:299` (duplication) : bloc compteurs de la liste duplique le JSX de `LaunchCounts` du même fichier. Fix : `<LaunchCounts counts={c.counts} className=... />`.
- `tags/page.tsx:207` (duplication) : `fieldValueOf` == `fieldValue` de contacts. Fix : déplacer dans `web/lib/fields.ts`.
- `contacts/page.tsx:305` (structure) : docstring de `BulkActionModal` orpheline au-dessus d'`AjoutContactModal`. Fix : recoller.

### web/components + web/lib

- `AppShell.tsx:66` (duplication) : appartenance page → groupe de nav énumérée 3 fois, le commentaire documente le piège au lieu de le supprimer. Fix : constante `GROUPS` unique, dériver le reste.
- `api.ts:1` (complexité) : 1325 LOC, 203 exports, une quinzaine de domaines. Fix : scinder par domaine dans `web/lib/api/` derrière un barrel (aucun import appelant ne change ; attention au `'use client'`).
- `api.ts:17` (convention) : docblock « retry des lectures 5xx » orphelin. Fix : recoller au-dessus de `RETRYABLE_METHODS`.
- `WhatsAppPreview.tsx:98` (code mort) : prop `senderName` jamais passée par les 6 appelants, défaut « Messaging Me Tech » en dur x2 (faux pour tout autre tenant), commentaire trompeur. Fix : câbler le verifiedName ou retirer la prop + constante partagée.
- `WorkflowBuilder.tsx:536` (duplication) : `rootNodeId` réimplémente `entryNodeOf` (déjà importé dans le fichier). Fix : `entryNodeOf(graphe)?.id ?? null`.
- `WorkflowBuilder.tsx:856` (duplication) : panneaux legacy `tag`/`field` recopient les sous-formulaires du panneau `action`, drift déjà commencé (texte d'aide). Fix : sous-composants TagPicker / FieldValueEditor.
- `CarouselPreview.tsx:72` (duplication) : chrome « fenêtre WhatsApp » dupliqué avec WhatsAppPreview. Fix : wrapper `PhoneFrame`.
- `day.ts:25` (duplication) : recopie `todayParis()` et `addDays()` de range.ts caractère pour caractère. Fix : les importer.
- `node-search.ts:22` (duplication) : `normalizeSearch` == `normalizeLabel` de flow-mapping (constante COMBINING comprise). Fix : `web/lib/normalize.ts`.
- `timezones.ts:50` (code mort) : `isKnownTimezone`, seul usage = son propre test. Fix : supprimer (ou utiliser vraiment).
- `nodeMeta.ts:31` (code mort) : `UNKNOWN_NODE_META` exporté pour rien. Fix : retirer l'export.

## État structurel par zone (résumé des contre-expertises)

- **http** : sain, câblage vérifié dep par dep (aucune injection morte). index.ts et worker.ts longs mais linéaires, pas à scinder. Seul `http/account.ts` mérite un passage dédié.
- **moteur** : au-dessus de la moyenne du genre. PAS de logique dupliquée entre campaign/engine et workflow/engine (frontière propre, contrairement à l'intuition de départ). Le point noir est `campaign/store.pg.ts` : split naturel en 3 stores (campagnes, retry F6/F7, tenant-assets).
- **data** : sain (tenant_id partout, transactions propres, pattern analysis/ exemplaire). Point noir `crm/contact-store.pg.ts` : split naturel en contact-store (identité/upsert) + contact-crm (édits/bulk/filtres).
- **externe** : très sain, pré-câblages assumés et documentés (zadarma inerte = voulu, tracé todo.md:170). Aucun split nécessaire.
- **socle** : sain, aucun export mort (les orphelins historiques déjà supprimés avec pierre tombale). `auth/routes.ts` premier candidat à scinder si l'auth grossit encore.
- **web-app** : pattern uniforme et sain, ContactFilterPanel réellement réutilisé. Le point noir absolu est `campaigns/page.tsx` ; contacts/page.tsx (916 LOC) est en fait bien factorisé en interne.
- **web-composants** : zone visiblement entretenue, modules purs testés avec commentaires miroir anti-drift (pattern rare et précieux), aucun composant orphelin. Points noirs : `api.ts` (hub qui grossit à chaque feature) et le ConfigPanel de WorkflowBuilder (l.697-980) à extraire.

## Chantiers groupés suggérés (ordre de valeur)

1. **Les 6 rouges** (dont 1 bug réel : ScenarioSendPanel). Petits sauf CreateForm.
2. **Module partagé src/http** : scopeTenant + nonEmpty (fait tomber 34 copies d'un coup).
3. **Fragments SQL partagés** : MATCH_BY_WAID_SQL, BOUNDS_CTE, SUMMARY_SELECT + prédicat d'échec (pattern UNREAD_SQL existant).
4. **Fauchage du code mort** (~10 items, mécanique, chaque item liste ses tests à adapter).
5. **Doc-drift** (~7 items : JSDoc orphelins, « 5 minutes », 'updated', commentaires faux). Trivial.
6. **Helpers web partagés** : inputCls, Toggle, fieldValue, varCountOf, normalize, PhoneFrame.
7. **Splits de fond** (chantiers séparés, à planifier) : campaign/store.pg.ts en 3 stores, contact-store.pg.ts en 2, CampaignCreateForm, web/lib/api/ en domaines, ConfigPanel.
