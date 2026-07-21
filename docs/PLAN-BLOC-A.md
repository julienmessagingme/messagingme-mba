# Plan détaillé, bloc A : l'état de contrôle d'une conversation

> Écrit le 2026-07-20 pour être exécuté à froid. Points d'insertion vérifiés dans le code, avec numéros de
> ligne. Contexte du pourquoi : `MBA-ARCHITECTURE.md`. Séquencement global : `PLAN.md`.
>
> **Ordre d'exécution : A.1 puis A.2 ensemble (ils livrent seuls la valeur), puis A.3, A.4, A.5.**

## Le problème, en une phrase

Le système ne sait pas qui détient une conversation, donc un humain qui répond dans l'inbox et un scénario
qui continue écrivent au client en parallèle. Aujourd'hui à deux émetteurs, demain à trois avec MBA.

## Le modèle

Une colonne sur `conversations`, trois valeurs exclusives :

| Valeur | Sens | Qui la pose |
|---|---|---|
| `app_workflow` | notre côté, automatique (scénario, campagne) | défaut, et chaque envoi automatisé |
| `app_human` | un opérateur est engagé | un envoi depuis l'inbox |
| `mba` | l'agent de Meta tient le fil | `messaging_handovers`, ou notre `release` |

Un enum plutôt que deux booléens : les états illégaux deviennent non représentables. Un humain qui envoie
détient forcément le fil, l'enum interdit d'exprimer le contraire.

**Règle d'or : seul `app_workflow` autorise l'avance d'un scénario.** `app_human` et `mba` la gèlent.

---

## A.1 : la colonne et sa pose

### La migration

Fichier à créer : `db/migrations/0040_conversation_control.sql` (0039 est la dernière, vérifié).

```sql
-- 0040_conversation_control.sql : qui détient la conversation, et donc qui répond au client.
--
-- Trois détenteurs exclusifs. 'app_workflow' = notre côté en automatique (scénario, campagne),
-- 'app_human' = un opérateur est engagé dans l'inbox, 'mba' = l'agent de Meta tient le fil.
--
-- DÉFAUT 'app_workflow' : c'est EXACTEMENT le comportement actuel (le scénario avance toujours), donc la
-- migration ne change le sort d'aucune conversation existante. Choisir 'app_human' par défaut gèlerait
-- rétroactivement tous les scénarios en attente au moment du déploiement.
--
-- ADD-only, migrer AVANT de déployer le code neuf.
alter table conversations
  add column if not exists control_owner text not null default 'app_workflow'
    check (control_owner in ('app_workflow', 'app_human', 'mba'));

-- Horodatage de la dernière bascule : sert au garde-fou d'inactivité (A.4), qui cherche les conversations
-- détenues par un humain depuis trop longtemps. Nullable : une conversation qui n'a jamais basculé n'a pas
-- de date de bascule, et mettre now() par défaut mentirait sur des conversations antérieures.
alter table conversations add column if not exists control_changed_at timestamptz;

-- Index partiel sur le chemin chaud du garde-fou : il ne balaie QUE les conversations sous contrôle humain,
-- jamais la table entière. Même forme que conversations_analysis_pending_idx (0027).
create index if not exists conversations_human_control_idx
  on conversations (control_changed_at) where control_owner = 'app_human';
```

### Le store

`src/inbox/store.pg.ts`.

**Ajouter une méthode dédiée**, plutôt que de greffer l'état sur une méthode existante :

```ts
/** Pose le détenteur du fil. Crée la conversation si elle n'existe pas (cas d'une campagne vers un
 *  contact qui n'a jamais écrit). `only` restreint la transition à un détenteur courant précis. */
async setControlOwner(
  tenantId: string,
  waId: string,
  owner: 'app_workflow' | 'app_human' | 'mba',
  opts?: { only?: string[] },
): Promise<boolean>
```

**Ligne 42 à 59, `upsertConversationByWaId`** : ne PAS toucher au `DO UPDATE`. C'est le piège numéro un.
La ligne 54 y remet `analysis_status` à `'pending'` à chaque message : si on imite ce précédent pour
`control_owner`, **chaque message entrant rendrait la main au scénario** et annulerait tout le travail.
La colonne doit être posée par des écritures explicites, jamais par l'upsert de passage.

**Ligne 92 à 111, `listConversations`** : ajouter `c.control_owner` au select (ligne 96) et au type
`ConversationSummary` (lignes 4 à 10). L'inbox doit montrer qui répond.

**Ligne 118 à 135, `getConversationContext`** : ajouter `control_owner` au select. Attention au
`group by c.wa_id` ligne 127, toute colonne ajoutée doit y entrer.

### Les trois familles d'émetteurs, vérifiées

Tout envoi passe par `MetaClient` (`src/meta/client.ts`), mais **le bon endroit pour poser l'état n'est pas
le client HTTP** : il ne connaît ni le tenant ni l'intention. Les points de pose sont les trois appelants.

| Famille | Fichier et lignes | Détenteur à poser |
|---|---|---|
| Inbox, humain | `src/index.ts:151` (`sendReply`) et `:155` (`sendTemplateMessage`), appelés depuis `src/http/inbox.ts:97` et `:142` | `app_human` |
| Worker, scénario | `src/worker.ts:129`, `:165`, `:182`, `:201` | `app_workflow` |
| Moteur de campagne | `src/campaign/engine.ts:158-159` | celui déclaré par la campagne (A.5) |

Le chemin humain porte **déjà** `req.auth?.userId` jusqu'au store (`recordOutbound`, 7e paramètre, défaut
null, documenté « null pour les réponses auto »). Le discriminant existe, il n'est pas exploité.

### ⚠️ Le piège que j'ai vérifié : ne pas accrocher l'état à `recordOutbound`

`recordOutbound` semble le point de passage idéal, il connaît la conversation et l'émetteur. **Il ne
convient pas** :

- `src/campaign/engine.ts:181` l'appelle sous condition `if (deps.recordOutbound && !campaign.workflowId)`.
  Une campagne qui lance un **scénario** ne journalise donc rien ici.
- `src/worker.ts:184` et `:203` l'appellent en best-effort, l'erreur est avalée par un `catch {}` assumé.

La journalisation est optionnelle, conditionnelle et silencieuse en cas d'échec, **par conception**. Un état
de contrôle accroché dessus se désynchroniserait précisément dans le cas qui compte, la campagne workflow.

### ⚠️ Deuxième piège vérifié : la conversation peut ne pas exister

Pour une campagne **workflow**, `engine.ts:181` ne crée pas la conversation. Elle n'apparaît que plus tard,
quand le worker envoie réellement (`worker.ts:184` → `recordOutboundByWaId` → `upsertConversationByWaId`).

Donc `setControlOwner` doit **créer la ligne si elle manque** (insert ... on conflict do update), et tout
lecteur doit traiter l'absence de ligne comme `app_workflow`, jamais comme une erreur.

### La dérivation du `waId`

`advance()` et le moteur de campagne raisonnent en `waId`, pas en `conversationId`. La règle est déjà écrite
à `engine.ts:182` et doit être reprise telle quelle, sans la réinventer :

```ts
const waId = r.toE164.startsWith('+') ? r.toE164.replace(/[^0-9]/g, '') : r.toE164;
```

Numéro en chiffres nus, BSUID brut. La clé `unique (tenant_id, wa_id)` de `0009_inbox.sql` rend la
recherche exacte et indexée.

---

## A.2 : geler l'avance du scénario

**Point d'insertion unique et exact : `src/workflow/executor.ts:117`, première ligne de `advance()`.**

```ts
async advance(tenantId: string, waId: string, messageId: string, buttonPayload: string | null = null) {
  // Un scénario n'avance que si NOUS tenons le fil en automatique. Un opérateur engagé dans l'inbox ou
  // MBA qui répond doivent geler le parcours, sinon deux émetteurs écrivent au client en parallèle.
  if (!(await this.deps.mayAdvance(tenantId, waId))) return;
  const run = await this.deps.runs.findWaitingByWaId(tenantId, waId);
  ...
```

**Pourquoi ici et pas dans la route webhook** : `advance()` est le point d'entrée unique de la progression
sur message entrant. Un garde posé dans `src/webhooks/workflow-advance.ts` serait contourné par tout
appelant futur d'`advance`. Le garde appartient à la règle métier, pas au transport.

**Pourquoi un dep `mayAdvance` et pas un accès direct au store** : l'executor ne connaît aucun store, il
reçoit tout par `deps` (convention du fichier). Câblage dans `src/worker.ts:211`, à côté de
`advance: (t, w, m, bp) => workflowExecutor.advance(...)`.

Le dep rend `true` seulement si le détenteur vaut `app_workflow`, **absence de ligne comprise**.

---

## A.3 : consommer `standby` et `messaging_handovers`

Ils sont typés dans `src/webhooks/parse.ts` (lignes 89 à 109) mais **rien ne les lit en aval** : ils sont
insérés bruts dans `webhook_events` et ignorés par `inbound.ts`, `delivery.ts` et `workflow-advance.ts`.

Deux traitements à brancher dans `src/webhooks/handler.ts`, sur le modèle des blocs existants, **isolés**
(un échec ne doit jamais faire échouer le job webhook partagé, cf. le commentaire ligne 49) :

1. `messaging_handovers` → recaler `control_owner`. C'est la seule source de vérité côté Meta.
2. `standby` (les `message_echoes`) → afficher dans l'inbox ce que MBA a répondu, pour que l'opérateur voie
   la conversation complète et pas seulement sa moitié.

⚠️ **La forme du payload est devinée.** `parse.ts:90` boucle sur `value['message_echoes']`, et le
commentaire ligne 100 dit lui-même « Shape peu documentée ». La doc Meta téléchargée décrit la sémantique
de `standby` mais **jamais la structure du corps**. Traiter tout champ comme optionnel, ne jamais planter
sur une forme inattendue, et journaliser un payload non reconnu au lieu de le laisser tomber en silence.

⚠️ **Piège de routage** : `parse.ts:65` boucle sur `value['messages']` **quel que soit le champ**. Quand
MBA tient le fil, le message du client arrive sur `standby`. À vérifier au moment du branchement : notre
code ne doit pas traiter un message standby comme un message à traiter normalement, sinon le scénario
répondrait et **prendrait le contrôle à MBA** (envoyer suffit à prendre le contrôle).

---

## A.4 : le garde-fou d'inactivité

Il n'existe **aucun** release automatique côté Meta. Un contrôle jamais rendu (opérateur parti, onglet
fermé, crash) laisse la conversation gelée et MBA muet, indéfiniment.

Patron à imiter, déjà présent quatre fois dans `src/worker.ts` : `setInterval` + `.unref()`, avec
`clearInterval` à l'arrêt (lignes 311, 327, 348, 364, et le bloc de nettoyage ligne 368).

Balayage : les conversations `control_owner = 'app_human'` dont `control_changed_at` est plus vieux qu'un
délai configurable, remises à `app_workflow` (et plus tard `release` vers MBA quand il sera actif). L'index
partiel de la migration sert exactement ce balayage.

Délai en variable d'environnement au zod (`src/config.ts`), sur le modèle de
`CONVERSATION_ANALYSIS_SWEEP_INTERVAL_MS`.

---

## A.5 : le détenteur visé par campagne

Règle validée par Julien le 2026-07-20, défaut **déduit** de la forme, **surchargeable** :

| Campagne | Détenteur visé | Pourquoi |
|---|---|---|
| Workflow finissant sur un bloc **inbox** | `app_human` | le bloc inbox dit qu'un humain prend le relais |
| Workflow sans bloc inbox | `app_workflow` | le scénario continue |
| Template seul | `mba` | personne chez nous n'attend la réponse |

Points d'insertion : `src/campaign/types.ts` (le champ), `src/campaign/store.pg.ts` (`CreateCampaignInput`
+ insert + select), `src/http/campaigns.ts` (validation du POST, allowlist stricte des trois valeurs),
`src/campaign/engine.ts:158` (la pose après envoi), `web/app/campaigns/page.tsx` (le sélecteur).

Détection du bloc inbox terminal : parcourir le graphe, chercher les nœuds sans arête sortante, regarder
leur type. Le type `inbox` existe déjà (c'est le bloc terminal du builder).

⚠️ **Question non tranchée, à tester en conditions réelles avant toute campagne de volume** : un envoi
sortant prend-il implicitement le contrôle du fil côté Meta ? La doc ne le dit nulle part. Si oui, une
campagne « template seul » coupe MBA sur tous ses destinataires jusqu'à un `release` **par destinataire**,
avec le coût et le débit que ça implique. Tant que ce n'est pas vérifié, poser l'intention en base et **ne
pas** appeler `release` en masse.

---

## Les tests à écrire

Le repo est à 922 tests. Ce qui doit être prouvé, et qui n'est pas visible à la lecture :

1. **Un humain répond, le scénario ne bouge plus.** Le test qui justifie tout le bloc.
2. **`upsertConversationByWaId` ne réinitialise pas le détenteur.** Mutation : ajouter `control_owner` au
   `DO UPDATE` doit faire échouer ce test.
3. **Une conversation absente vaut `app_workflow`.** Cas de la campagne vers un contact qui n'a jamais écrit.
4. **Le garde vaut aussi pour `mba`**, pas seulement pour `app_human`.
5. **Le webhook `standby` ne fait pas répondre le scénario** (celui-là protège du pire scénario MBA).
6. **Le garde-fou d'inactivité ne libère que ce qui est trop vieux**, et jamais une conversation active.

Fakes à mettre à jour, ils implémentent des interfaces en dur et cassent à la compilation dès qu'une clé
est ajoutée : `tests/http-rbac.test.ts`, `tests/auth-live-state.test.ts`, `tests/http-campaigns.test.ts`,
`tests/contacts.test.ts`, plus les suites d'inbox et de workflow.

## Ordre de déploiement

Migration ADD-only, donc **migrer avant de déployer**. Rappel du piège documenté dans `DEPLOY.md` : le
`compose run` de migration part de l'IMAGE, pas du disque, donc `docker compose build mba-api` d'abord,
sinon `migrate` répond « à jour, rien à appliquer » avec aplomb sans rien avoir appliqué.
