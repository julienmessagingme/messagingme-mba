# Tout sur la fiche : plan des quatre lots

**Spec :** [docs/superpowers/specs/2026-09-30-fiche-unique-design.md](../specs/2026-09-30-fiche-unique-design.md), à
lire en entier d'abord, amendements compris (§ « Les amendements du 2026-09-30 »). Points de contact relevés par
une cartographie du code en lecture seule (quatre lecteurs, un par lot, sur origin/main `54f36f1b`).

**Contraintes globales :** pas de tiret long ; `tenant_id = $1` sur chaque requête neuve ; `null` n'est jamais 0 ni
`false` ; migration AVANT le code qui l'écrit, relue en base après `migrate`, compteur de `CLAUDE.md` mis à jour
dans le commit qui prend le numéro (le dossier s'arrête à 0195 au moment de ce plan : revérifier au commit) ; pas
d'accent grave dans un commentaire SQL ; un écran part APRÈS l'API qui porte sa route, ou tolère son absence ;
fichiers de câblage partagés (`src/worker.ts`, `src/index.ts`, `src/server.ts`) annoncés aux autres sessions et
commités en plomberie depuis une extraction d'origin ; formes de la console tenues par `tests/web-formes.test.ts`
et `tests/web-icones.test.ts`.

## Méthode de livraison

**Implémenteur par lot, puis UNE relecture indépendante du diff par lot** (un rouge = ce qui casse la production,
tout le reste est jaune et part au lot suivant), parce que le chantier emprunte des chemins que la production
prend à chaque minute (l'écriture de l'analyse, le ciblage d'une campagne, le déclencheur d'automation, la purge
RGPD) et porte des invariants invisibles du compilateur : CHECK recopiés d'une énumération, index partiels,
règle « dernière », audience qui s'élargit si un filtre est ignoré. Aucun workflow. Chaque lot est déployé et
essayé avant que le suivant commence.

**Essai réel qui clôt la feature**, sur l'espace d'essai avec le téléphone de Julien : un message mécontent ; après
l'analyse, la section « Dernière analyse » de la fiche montre les valeurs ; le filtre « sentiment négatif,
urgence ≥ 7 » trouve la fiche dans la liste et dans le ciblage d'une campagne ; « le sentiment devient négatif »
part une fois, puis pas une seconde fois dans la semaine ; un connecteur et les signaux envoient les vraies
valeurs ; l'agent IA qui a « Lire la fiche » sait que le contact est mécontent ; une fois la conversation effacée,
la fiche garde ses valeurs et le résumé disparaît. Chaque lot a en plus son propre essai réel, ci-dessous.

## Lot 1 : les champs d'analyse sur la fiche

### Tâche 1.1 : les migrations
- Migration A (en transaction) : les onze colonnes de la spec sur `contacts`, nullables sans défaut, en UN
  `alter table` ; CHECK nommés sur `INTENTS`, `SENTIMENTS`, `ACTIONS`, `HANDLED_BY` et les bornes `NOTE_MIN` /
  `NOTE_MAX` ; le sujet borné à 120 caractères (même borne que le `max(120)` Zod) ; `analyse_conversation_id` en
  `on delete set null`. Modèle : 0178.
- Migration B (`-- migrate: no-transaction`) : l'index partiel sur `analyse_conversation_id` (non nul), construit
  `CONCURRENTLY`. Sans lui, chaque conversation effacée par la rétention ou la purge parcourrait `contacts` pour
  appliquer le `set null`.
- Tests : `tests/fiche-analyse-migration.test.ts` dérive du SQL chaque CHECK et le compare à `schema.ts` (modèle
  `tests/risque-migration.test.ts`) ; `tests/intentions-parite.test.ts` généralisé par nom de colonne (il ne
  cherche aujourd'hui que `intent in`). 🔴 Raison : un CHECK de la fiche qui refuserait une valeur que Zod accepte
  annulerait TOUTE la transaction de `save`, analyse comprise, et le job partirait en DLQ.

### Tâche 1.2 : la copie dans `save`
- `PgConversationAnalysisStore.save` (`src/analysis/store.pg.ts`) : dans sa transaction, une instruction qui trouve
  le contact (`coalesce(conversations.contact_id, sous-requête par identités)`, `deleted_at is null`,
  `anonymized_at is null`, `tenant_id`), lit l'ancienne copie `for update` et écrit la nouvelle seulement si
  `analyse_fenetre_fin is null or analyse_fenetre_fin <= windowEnd` (`<=` rend le rejeu idempotent). `windowEnd`
  nul : pas de copie. `analyse_le = now()`. `updated_at` ne bouge pas (comme le risque).
- Interface : `save` rend désormais `CopieFiche | null` (`{ contactId, waId, avant: AnalyseDeFiche | null,
  apres: AnalyseDeFiche }`, `null` quand aucune copie n'est faite). Le lot 3 s'en sert : la transition ne doit pas
  rouvrir une transaction de production déjà relue. Modèle : la CTE `avant ... for update` de
  `src/engagement/risque.pg.ts`.
- Tests d'intégration (CI) : repli par `contact_id` puis par identités ; une vieille fenêtre n'écrase pas une plus
  récente ; rejeu identique sans effet ; fiche supprimée ou purgée intacte ; isolation entre espaces ; `avant` nul
  à la première analyse. Un test de scan des sources : seules l'analyse et la purge écrivent `analyse_*`.
  `tests/analysis-job.test.ts` suit la nouvelle signature.

### Tâche 1.3 : le risque et la purge
- `risque.pg.ts` : la CTE `analyses` disparaît, les colonnes sont lues dans `cible` sous les mêmes alias, avec
  `analyse_le >= $3`. `tests/risque-isolation.test.ts` (compte de vues 11 vers 10) et la fixture `mecontent` de
  `tests/integration/risque.integration.test.ts` suivent.
- `PgContactStore.purgeMany` vide les onze colonnes. `tests/integration/purge-rgpd.integration.test.ts` remplit la
  fiche par `store.save`, l'ancre avant la purge, `null` après, vérifié dans les deux sens.

### Tâche 1.4 : la route de la fiche
- `resumeContact` (`src/crm/contact-history.pg.ts`) rend `derniereAnalyse` (les huit valeurs, la date, `perimee`)
  et suit `analyse_conversation_id` pour le résumé QUAND la copie existe, sinon la règle actuelle : sans ce repli,
  tous les résumés disparaîtraient au déploiement (pas de reprise). `perimee` compare `max(m.created_at)` des fils
  du contact à `analyse_fenetre_fin`, jamais `last_message_at` (posé par `now()`, toutes les fiches paraîtraient
  périmées). Garder le CTE `conv` exigé par `tests/contact-resume.test.ts`.
- Tests : `tests/http-contact-history.test.ts`, `tests/contact-resume.test.ts`, une intégration.

### Tâche 1.5 : la console et les textes
- Un module `web/lib/analyse.ts` porte les libellés du sentiment, de l'action et de « traitée par » (aujourd'hui
  privés dans `ConversationAnalysisCard.tsx`), avec une parité sur `schema.ts` ; section « Dernière analyse » dans
  `ContactDetail.tsx`, près du bloc du résumé, absente si `derniereAnalyse` manque (API plus ancienne comprise).
- Les textes sur la conservation : `features.md`, `ConversationAnalysisCard.tsx`, `docs/aide/fiches/`
  (`importer-mes-contacts.md`, `lire-mes-resultats.md`), `web/lib/api/contacts.ts`, le commentaire de
  `contact-history.pg.ts`.
- Tests : parité des libellés, e2e `web/e2e/inbox-fiche-contact.spec.ts`.

**Déploiement du lot 1 :** CI job par job ; `compose build`, `pg_stat_activity`, `migrate` (A puis B), relecture en
base (colonnes, CHECK sous leur nom, `indisvalid`) AVANT le `up` ; `up -d --build` ; fumée. La console tolère
l'absence de `derniereAnalyse` et peut partir avec le push. **Essai réel :** un message mécontent sur l'espace
d'essai, la section apparaît après l'analyse ; la mention « périmée » après un nouveau message.

## Lot 2 : la liste unique des champs

**Mesures avant de coder** (lecture seule en production) : les variables de connecteur enregistrées sur
`systeme:analyse_*` depuis `b4a62d3b` ; les `user_fields` dont la clé deviendrait réservée ; le volume de fiches
par espace (décide des index).

### Tâche 2.1 : le module, la route, les clés réservées
- `src/crm/champs-fiche.ts`, module pur : `ChampFiche` (clé, libellés, provenance, type, modifiable, sortie vers un
  tiers, sensible, opérateurs), `CHAMPS_FICHE`, `champsDeLaFiche(perso)`, `champFiche(cle)`, `estCleReservee(cle)`,
  et la carte FERMÉE clé vers colonne (jamais envoyée à la console). Les choix viennent de `schema.ts`, sans copie.
- Route `GET /tenants/:tenantId/champs-fiche` dans `registerFields`. ⚠️ NE PAS enrichir `/user-fields` : dix écrans
  l'appellent, dont les sélecteurs de variables de message (décisions 9 et 10).
- Clés réservées : un ensemble `CLES_RESERVEES` séparé, PAS `SYSTEM_FIELD_KEYS` (amendement 1), consulté par
  `isReservedFieldLabel`, l'import CSV (`src/crm/import.ts`, qui crée des champs sans garde) et
  `preparateurDeChamps` (`src/api/contacts-upsert.ts`), avec un refus lisible.
- Tests : clés uniques, choix égaux aux énumérations, `tests/web-codes.test.ts` inchangé, colonne CSV ou champ API
  d'analyse refusé, parité des libellés console.

### Tâche 2.2 : les connecteurs
- Une origine `fiche` dont la clé doit être un champ de la liste qui peut sortir ; `lireVariables` réécrit à la
  lecture `contact:*` et `systeme:analyse_*` / `risque_depart` en `fiche:*`, sans reprise.
- Une lecture unique `PgContactStore.ficheDuContact(tenantId, waId)` remplace `analyseDuContact` (qui part) et
  devient une dépendance REQUISE `fiche` à la place de `analyses` optionnelle, sur les quatre câblages
  (`src/worker.ts` deux fois, `src/index.ts`, `src/workflow/wiring.ts`, instance dans `src/socle.ts`).
  `CHAMPS_CONTACT_AUTORISES` n'est PAS élargie (paramètres d'outil et MCP la lisent). La projection vers le modèle
  ne porte toujours pas l'analyse.
- Tests : l'ancienne variable rend la même valeur que la neuve ; 0 et `false` gardés ; aucune lecture sans
  variable ; 400 sur une clé qui ne peut pas sortir ; `tests/signaux-isolation.test.ts` passe de 8 à 7 requêtes ;
  `tests/agent-variables.test.ts`, `tests/web-valeurs-systeme.test.ts`, `tests/agent-resolver-http.test.ts`,
  l'intégration des signaux suivent.

### Tâche 2.3 : les filtres (serveur)
- Les filtres d'analyse passent par `fieldFilters`, avec les clés de la liste et six opérateurs neufs (`in`, `gte`,
  `lte`, `is_true`, `is_false`, `newer_than_days`) ; `buildContactWhere` route une clé de la liste vers sa colonne
  par la carte fermée, le reste au jsonb. Raison : `hasFilters` les compte déjà, et un membre neuf au premier
  niveau serait IGNORÉ par un serveur ancien, donc l'audience deviendrait tout l'espace.
- 🔴 Une valeur ou un opérateur invalide sur une clé d'analyse lève `FiltreContactInvalide`, jamais ignoré. Index
  partiels seulement si les mesures l'exigent (migration `CONCURRENTLY` à part).
- Tests : SQL exact par opérateur, colonne venue de la carte, clé perso toujours en jsonb, satisfaction 0 gardée,
  `null` exclu, aller-retour query et JSON, `hasFilters`, ciblage de campagne.

### Tâche 2.4 : le bloc Condition (serveur)
- `EvalContext.analyse`, membre SÉPARÉ de `fields` (la fonction JS d'un scénario reçoit `fields` : l'analyse ne
  doit pas y entrer) ; `getContactStateByWaId` lit les colonnes sur la même ligne ; une clé de la liste est lue
  avant le jsonb ; la date part en ISO ; mêmes opérateurs et même sens des seuils que le SQL (un évaluateur pur
  partagé avec le lot 3).
- Tests : 0 et `null`, `false` et `null`, date, clé jsonb homonyme ignorée, parité avec le SQL ; les fixtures qui
  construisent un contexte suivent.

### Tâche 2.5 : la console (poussée APRÈS le `up`)
- `web/lib/contact-filters.ts`, `ContactFilterPanel`, `ListeDestinataires`, `ConditionBuilder` (le type choix y
  est inconnu), `RequetesConnecteur`, `AgentConnecteurs`. Filtres d'analyse proposés seulement si la route de la
  liste répond ; `catalogue.fiche ?? []`.
- 🔴 `filtresRepris` écarte aujourd'hui un opérateur inconnu : un brouillon de campagne repris élargirait son
  audience. Il doit garder les opérateurs neufs.
- Tests : `filtresRepris`, écran tolérant à un 404 et à un catalogue sans `fiche`, e2e liste et ciblage.

**Déploiement du lot 2 :** vérifier la migration du lot 1 dans `schema_migrations` (sinon chaque condition échoue
fermée) ; API et worker ; puis la console. **Essai réel :** filtrer « sentiment négatif, urgence ≥ 7 » dans la
liste et dans le ciblage ; l'appel `signaler` du connecteur de l'espace d'essai envoie les valeurs lues sur la
fiche.

## Lot 3 : les automations

### Tâche 3.1 : le déclencheur, en fonctions pures
- `src/automation/match.ts` : l'événement `analysis` porte toutes les valeurs et `copieFiche` (nouveau type
  `AnalyseTerminee`, SANS toucher `StoredConversationAnalysis`, contrat de la poussée HubSpot) ; le type
  `analyse_devient` (champ, valeur visée ou seuil) ; « devient » = la nouvelle copie correspond, l'ancienne non
  (ancienne nulle = ne correspondait pas ; nouvelle nulle = ne correspond jamais) ; filtres de « conversation
  analysée » évalués sur les valeurs de l'événement par l'évaluateur du lot 2, `sentiment` et `unresolvedOnly`
  lus tels quels ; anti-rebond par défaut de 7 jours dans `antiRebondParDefaut`.
- `runner.ts` : `kindsFor` rend `['conversation_analyzed', 'analyse_devient']` pour cet événement, par une branche
  explicite. `event-job.ts` : le parse de la file suit.
- Tests : chaque champ, première analyse, valeurs nulles, anciennes configurations inchangées, la boucle
  « défaut de l'instance » de `tests/automation-match.test.ts` (qui casse avec 7 jours), le parse.

### Tâche 3.2 : l'émission et la route
- `src/analysis/job.ts` passe la copie rendue par `save` à `onAnalyzed` ; `src/worker.ts` (plomberie) transmet
  l'événement complet, avec le `waId` de la FICHE écrite. Un seul point d'appel, direct : un rejeu ne redéclenche
  rien (l'ancienne copie vaut la nouvelle), un crash entre `save` et l'émission perd la transition sans jamais la
  doubler. `tests/signaux-cablage.test.ts` (texte exact) suit ; `tests/concurrence-files.test.ts` inchangé.
- `src/http/automations.ts` : validation du nouveau type avec des listes dérivées de `schema.ts` (plus de
  sentiments en dur) ; `refuseIfLoopy` étendu. Tests : `tests/http-automations.test.ts`.
- Aucune migration (`trigger_kind` n'a pas de CHECK).

### Tâche 3.3 : l'écran (poussé APRÈS le `up`)
- `web/app/automations/page.tsx` : le déclencheur « un champ d'analyse devient », les filtres étendus de
  « conversation analysée », et un réglage de l'anti-rebond à l'écran (il n'existe aujourd'hui que par l'API ;
  la décision 13 le veut réglable) ; libellés tirés de la liste du lot 2 ; la liste des types de
  `web/lib/api/integrations.ts` exportée en constante avec un test de parité ; `features.md`.
- Tests : un cas e2e sur le modèle du risque élevé.

**Déploiement du lot 3 :** deux commits, serveur puis console, chaque moitié typecheckée ; `up` entre les deux.
**Essai réel :** automation « le sentiment devient négatif » vers un scénario à un message ; elle part au premier
message mécontent, pas au second dans la semaine.

## Lot 4 : les sorties

### Tâche 4.1 : l'API contacts et sa doc (un seul commit)
- `lireFicheApi` et `FicheApiLigne` (`src/crm/contact-store.pg.ts`), `FicheApi` et `formaterFicheApi`
  (`src/api/contacts-v1.ts`) : `lastAnalysis: { intent, sentiment, satisfaction, urgency, resolved, topic,
  handledBy, actionSuggestion, analyzedAt } | null`, sans résumé. En écriture, la clé est IGNORÉE comme
  `engagementRisk`, pas refusée (l'aller-retour lecture puis écriture d'un intégrateur casserait).
- Doc : `web/lib/api-exemples.ts` (exemple lié au type par `MemesCles`), un paragraphe `doc-last-analysis` dans
  `web/app/developers/api/contacts/page.tsx` sur le modèle de `doc-engagement-risk`, avec sa parité.
- Tests : une note à 0 reste 0, `resolved: false` reste `false`, `null` si jamais analysé, aucun résumé, POST et
  PATCH n'écrivent aucune colonne d'analyse ; les fixtures `api-contacts-v1`, `contacts-identite-store`,
  `aide/fiches-memoire`, `v1-contacts` suivent.

### Tâche 4.2 : le MCP
- `contactPublic` (`src/mcp/outils.ts`) : `last_analysis` avec le résumé, lu par `analyse_conversation_id` via une
  méthode `resumesDesFiches(tenantId, ids)` (une requête par page, filtrée sur l'espace dans les deux tables).
- Tests : résumé présent, `null` quand la conversation est effacée, une seule requête pour N fiches, isolation
  (intégration), fixture `tests/mcp-serveur.test.ts`.

### Tâche 4.3 : les signaux
- `NOMS_ATTRIBUTS` gagne `em_last_topic`, `em_last_handled_by`, `em_last_action_suggestion` ; les huit valeurs se
  lisent dans `COLONNES_FICHE` de `src/signaux/store.pg.ts` (aucune requête de plus) et partent avec CHAQUE
  signal (c'est l'état courant) ; `completer.ts` ne rend plus `null` quand la conversation a disparu mais que la
  fiche est analysée ; `batch.ts` et `web/lib/signaux-dictionnaire.ts` suivent. ⚠️ Nommer ces attributs AVANT le
  package Salesforce v0.1 : un package géré fige ses noms de champs.
- Tests : chaque nom de `NOMS_ATTRIBUTS` est produit (aucun test ne le vérifie aujourd'hui) ; conversation effacée
  mais fiche analysée ; compte d'isolation inchangé ; `tests/signaux-batch.test.ts` et l'intégration suivent.

### Tâche 4.4 : l'outil « Lire la fiche » de l'agent IA
- Nouvelle dépendance REQUISE `lireAnalyse(tenantId, waId)` dans `DepsResolveurMba` (`src/agent/resolvers/mba.ts`),
  appelée seulement par le handler `lire_contact`, toujours avec `ctx.waId` ; le handler rend `{ connu, champs,
  derniere_analyse, resume }`. La projection ne change pas : les connecteurs ne reçoivent rien de plus. Câblage
  dans `src/worker.ts` (plomberie). La description par défaut de l'outil le dit. Corriger les deux commentaires
  faux (`src/agent/variables.ts`, `src/agent/executor.ts`) qui affirment que le modèle ne voit pas les champs.
- Tests : contact inconnu, aucune lecture ; lecture sur `ctx.waId` même si le modèle passe un autre numéro ;
  `tests/contact-projection-tiers.test.ts` reste vert ; `tests/agent-resolver-mba.test.ts` suit.

**Déploiement du lot 4 :** aucune migration ; la doc et `FicheApi` partent dans le même commit, donc Vercel publie
la doc avant l'`up` : pousser puis déployer dans la foulée. **Essai réel :** `GET /v1/contacts/...` rend
`lastAnalysis` ; `get_contact` par le MCP rend le résumé ; l'outil branché reçoit les trois nouveaux attributs ;
l'agent IA d'essai, avec « Lire la fiche », répond en sachant que le contact est mécontent.
