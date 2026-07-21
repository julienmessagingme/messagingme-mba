# Plan détaillé, bloc A : l'état de contrôle d'une conversation

> **Version 2, du 2026-07-21.** La version 1 a été soumise à une chasse aux pièges (4 angles, chaque lot
> revérifié contre le code) : 29 pièges trouvés, 25 confirmés, dont **13 bloquants**. Trois erreurs de la v1
> étaient des trous réels, vérifiés à la main et corrigés ici. Ce qui suit intègre ces corrections.
>
> Contexte du pourquoi : `MBA-ARCHITECTURE.md`. Séquencement global : `PLAN.md`.

## Le problème, en une phrase

Le système ne sait pas qui détient une conversation, donc un humain qui répond dans l'inbox et un scénario
qui continue écrivent au client en parallèle. Aujourd'hui à deux émetteurs, demain à trois avec MBA.

## Le modèle

Une colonne sur `conversations`, trois valeurs exclusives :

| Valeur | Sens | Qui la pose |
|---|---|---|
| `app_workflow` | notre côté, automatique (scénario, campagne) | défaut, et les envois automatisés **sous condition** |
| `app_human` | un opérateur est engagé | un envoi depuis l'inbox, ou un run atteignant son bloc inbox |
| `mba` | l'agent de Meta tient le fil | **uniquement** un `messaging_handovers` reçu (A.3) |

**Règle 1 : seul `app_workflow` autorise l'avance ou le démarrage d'un scénario.**

**Règle 2, la plus importante, absente de la v1 : un envoi automatisé ne dégrade JAMAIS un détenteur plus
fort que le sien.** Toute pose automatique est conditionnelle (`where control_owner = 'app_workflow'`).

**Règle 3 : tout état doit avoir un chemin de retour.** Un état dans lequel on entre sans pouvoir en sortir
est un bug de schéma, pas un détail d'implémentation.

## ⚠️ Les trois erreurs de la version 1, vérifiées à la main

Elles sont consignées parce que chacune était une conclusion plausible et fausse.

**1. Le point de pose de A.5 était dans une branche morte.** `campaign/engine.ts:158` est à l'intérieur du
`else` ouvert ligne 148. La branche node sort ligne 137, la branche workflow ligne 147. **Aucune campagne
workflow n'atteint jamais la ligne 158.** Les deux premières lignes de mon tableau A.5 étaient donc lettre
morte, et le seul détenteur qu'une campagne aurait jamais posé était `mba`. Le bon point est **après
`markResult` (ligne 175), hors du if/else**, là où les trois formes convergent.

**2. Le garde de A.2 n'était pas unique.** `runFrom` (`executor.ts:70`) appelle `this.apply(...)` ligne 87,
donc **envoie**, sans consulter personne. `start` (ligne 97) et `startFromNode` (ligne 108) passent tous
deux par là. Un garde posé uniquement dans `advance()` laisse le démarrage de scénario écrire dans un fil
tenu par un humain.

**3. Le plan gardait la lecture et laissait les écritures libres.** Je définissais une option `only` sur
`setControlOwner` sans l'imposer nulle part. Conséquence : un opérateur répond à 10h00, une campagne
programmée touche le même contact à 10h02, le worker repose `app_workflow`, le client répond à 10h03 et le
scénario redémarre par-dessus l'opérateur. Le gel était révoqué en silence, et `control_changed_at` re-daté
au passage, donc le garde-fou de A.4 n'aurait jamais vu de contrôle humain ancien.

---

## Ordre d'exécution révisé

**A.1 (élargi) → A.2 (élargi) → A.4 → A.3 → A.5 (réécrit).**

Deux changements par rapport à la v1. **A.4 remonte avant A.3 et part dans le MÊME déploiement que A.2** :
dès qu'on sait geler, on doit savoir dégeler, sinon on met en production une capacité de blocage sans sa
soupape. **A.3 descend** : il ne sert à rien tant que MBA n'est actif chez aucun tenant.

Migrations : **0040 avec A.1 et A.2**, **0041 livrée avec A.5**. Jamais A.5 sur la seule 0040.

---

## A.1 : la colonne, sa pose, et sa visibilité

### La migration 0040

`db/migrations/0040_conversation_control.sql` (0039 est la dernière, vérifié).

```sql
-- 0040_conversation_control.sql : qui détient la conversation, et donc qui répond au client.
--
-- DÉFAUT 'app_workflow' : reproduit EXACTEMENT le comportement actuel, donc la migration ne change le sort
-- d'aucune conversation existante et ne gèle rétroactivement aucun scénario en attente.
alter table conversations
  add column if not exists control_owner text not null default 'app_workflow'
    check (control_owner in ('app_workflow', 'app_human', 'mba'));

alter table conversations add column if not exists control_changed_at timestamptz;

-- Le balayage de A.4 doit récupérer TOUT état non rendu, pas seulement 'app_human' : une conversation
-- passée à 'mba' sans chemin de retour serait bloquée définitivement (cf. règle 3).
create index if not exists conversations_control_held_idx
  on conversations (control_changed_at) where control_owner <> 'app_workflow';
```

**Backfill borné, à trancher avant d'écrire la migration.** Sans backfill, une conversation aujourd'hui
tenue par un humain naît `app_workflow`, donc le bug actuel persiste sur elle jusqu'à la prochaine action
humaine (qui la corrige). Avec un backfill total, on gèle rétroactivement des scénarios dont un humain a
envoyé un message il y a six mois. **Recommandation : backfill borné aux conversations dont le dernier
message sortant porte un `sender_user_id` non nul ET date de moins de 24 h.** À faire dans la même
migration, avec `control_changed_at` posé à la date de ce message, pas à `now()`.

### Le store

`src/inbox/store.pg.ts`.

```ts
/** Pose le détenteur du fil. Crée la conversation si elle n'existe pas (campagne vers un contact qui n'a
 *  jamais écrit). `only` RESTREINT la transition aux détenteurs courants listés : c'est le mécanisme qui
 *  empêche un envoi automatisé de révoquer un opérateur engagé. Rend false si la garde a bloqué. */
async setControlOwner(
  tenantId: string, waId: string,
  owner: 'app_workflow' | 'app_human' | 'mba',
  opts?: { only?: readonly string[] },
): Promise<boolean>

/** Détenteur courant. Absence de ligne = 'app_workflow' (la conversation n'existe pas encore). */
async getControlOwner(tenantId: string, waId: string): Promise<'app_workflow' | 'app_human' | 'mba'>
```

**Ligne 42 à 59, `upsertConversationByWaId` : ne PAS toucher au `DO UPDATE`.** La ligne 54 y remet
`analysis_status` à `pending` à chaque message. Imiter ce précédent ferait rendre la main au scénario à
chaque message entrant et annulerait tout le gel. Le précédent est un piège, pas un modèle.

**Ligne 92 à 111, `listConversations`** et **ligne 118 à 135, `getConversationContext`** : ajouter
`control_owner` au select et aux types. Attention au `group by c.wa_id` ligne 127.

### Les trois familles d'émetteurs, et leurs conditions

| Famille | Où poser | Détenteur | Condition |
|---|---|---|---|
| Inbox, humain | **dans la route** `src/http/inbox.ts:97` et `:142`, pas dans les closures de `index.ts` (la route seule connaît `req.auth.userId`) | `app_human` | aucune, un humain prend toujours la main |
| Worker, scénario | `src/worker.ts:129`, `:165`, `:182`, `:201` | `app_workflow` | **`only: ['app_workflow']`** |
| Moteur de campagne | `src/campaign/engine.ts`, **après `markResult` ligne 175, hors du if/else** | `app_workflow` | **`only: ['app_workflow']`** |

### ⚠️ Ne pas accrocher l'état à `recordOutbound`

Il paraît idéal (il connaît la conversation et l'émetteur) mais il est **conditionnel** à
`engine.ts:181` (`if (deps.recordOutbound && !campaign.workflowId)`, donc muet pour une campagne workflow)
et **best-effort** à `worker.ts:184` et `:203` (erreur avalée par un `catch {}` assumé). Un état accroché
dessus se désynchroniserait précisément dans le cas qui compte.

### La visibilité et la reprise, absentes de la v1

Un état invisible et irréversible est inutilisable. À livrer avec A.1 :

- `control_owner` remonté jusqu'au front (la route de détail construit sa réponse en dur,
  `src/http/inbox.ts:72-77`, à étendre) et affiché dans l'inbox ;
- une **route de reprise** qui rend la main au scénario, et son bouton. Sans elle, un opérateur gèle un
  parcours d'un clic sans pouvoir l'annuler.

### La dérivation du `waId`

Règle déjà écrite à `engine.ts:135` et `:144`, à reprendre telle quelle :
`to.startsWith('+') ? to.replace(/[^0-9]/g, '') : to`. Numéro en chiffres nus, BSUID brut. La clé
`unique (tenant_id, wa_id)` de `0009_inbox.sql` rend la recherche exacte et indexée.

---

## A.2 : geler l'avance ET le démarrage

**Trois points d'insertion, pas un.**

**1. `src/workflow/executor.ts`, dans `advance()` ligne 117**, après `findWaitingByWaId` (pour pouvoir
décider explicitement du sort du run plutôt que de le laisser en attente indéfiniment) :

```ts
const run = await this.deps.runs.findWaitingByWaId(tenantId, waId);
if (!run || run.lastMessageId === messageId) return;
// Un scénario n'avance que si NOUS tenons le fil en automatique.
if (!(await this.deps.mayAdvance(tenantId, waId))) return;
```

**2. `src/workflow/executor.ts`, dans `runFrom()` ligne 78, AVANT le `apply` ligne 87.** C'est le point
oublié par la v1 : `start` et `startFromNode` envoient par là. Journaliser le saut, sur le modèle du
`console.error` de la garde 24 h juste au-dessus (lignes 82 à 86).

**3. `src/campaign/engine.ts`, avant le claim ligne 124.** Sauter le destinataire de façon **transitoire**
(il reste `pending`, réévalué au prochain run), sur le modèle exact du skip de fréquence lignes 115 à 121.
Sans ce troisième point, le canal le plus bruyant du produit, l'envoi de masse, est le seul que l'état ne
bloque pas : la campagne du soir écrit au client en plein échange avec un opérateur.

**Pourquoi un dep et pas un accès direct au store** : l'executor ne connaît aucun store, il reçoit tout par
`deps`. Câblage dans `src/worker.ts:211`.

---

## A.4 : le garde-fou d'inactivité, livré AVEC A.2

Il n'existe **aucun** release automatique côté Meta. Un contrôle jamais rendu (opérateur parti, onglet
fermé, crash) laisse la conversation gelée indéfiniment. Une capacité de gel sans soupape ne doit pas
partir en production.

Patron déjà présent quatre fois dans `src/worker.ts` : `setInterval` + `.unref()` + `clearInterval` à
l'arrêt (lignes 311, 327, 348, 364, nettoyage ligne 368).

Balayage sur **`control_owner <> 'app_workflow'`** (pas seulement `app_human`, cf. règle 3), avec un délai
distinct par état : court pour `app_human` (un opérateur inactif rend la main), plus long pour `mba`. Délais
au zod dans `src/config.ts`, sur le modèle de `CONVERSATION_ANALYSIS_SWEEP_INTERVAL_MS`.

---

## A.3 : consommer `standby` et `messaging_handovers`

Typés dans `src/webhooks/parse.ts` (lignes 89 à 109), **rien ne les lit en aval**. Deux traitements à
brancher dans `src/webhooks/handler.ts`, **isolés** (un échec ne doit jamais faire échouer le job webhook
partagé, cf. commentaire ligne 49) :

1. `messaging_handovers` → recaler `control_owner`. **C'est le SEUL écrivain légitime de la valeur `mba`.**
2. `standby` (`message_echoes`) → afficher dans l'inbox ce que MBA a répondu.

⚠️ **La forme du payload est devinée.** `parse.ts:90` boucle sur `value['message_echoes']` et le commentaire
ligne 100 avoue « shape peu documentée ». La doc Meta décrit la sémantique de `standby`, jamais la
structure. Traiter tout champ comme optionnel, ne jamais planter, journaliser un payload non reconnu.

⚠️ **Piège de routage** : `parse.ts:65` boucle sur `value['messages']` **quel que soit le champ**. Quand MBA
tient le fil, le message du client arrive sur `standby`. Notre code ne doit pas le traiter comme un message
ordinaire, sinon le scénario répondrait et **prendrait le contrôle à MBA** (envoyer suffit à prendre).

---

## A.5 : l'intention de la campagne, réécrit

La v1 était fausse trois fois : point de pose en branche morte, gel prématuré, et déduction `mba` sans
retour. Nouvelle formulation.

**Une campagne porte une INTENTION de fin de parcours, pas un état posé à l'envoi.**

| Campagne | Intention | Matérialisée quand |
|---|---|---|
| Workflow finissant sur un bloc inbox | `app_human` | le run **atteint réellement** son état terminal inbox |
| Workflow sans bloc inbox | `app_workflow` | jamais (c'est le défaut) |
| Template seul | `app_workflow` | jamais. **Aucune déduction `mba`** |

**Pourquoi pas de pose à l'envoi** : `walk` s'arrête au premier bloc bloquant, et le seul chemin vers le
bloc inbox est `advance`, que A.2 gèle. Poser `app_human` à l'envoi gèlerait donc le scénario **à son
premier message**, et la forme la plus courante (accroche automatique puis passage à un humain) cesserait
de fonctionner pour tous les destinataires, sans erreur ni log.

**Où matérialiser** : dans `executor.advance`, après le `setState` ligne 130, quand l'état atteint vaut
`inbox`. Corollaire à traiter : aujourd'hui, quand un run atteint vraiment son bloc inbox, aucun détenteur
n'est posé et l'inbox afficherait `app_workflow` sur une conversation que plus rien ne fait avancer.

**Pourquoi aucune déduction `mba`** : `mba` ne doit être écrit que par un `messaging_handovers` réellement
reçu. Le déduire d'une campagne créerait un état sans chemin de retour chez un tenant où MBA n'est même pas
actif (`mba_enabled` est faux par défaut, `settings/store.pg.ts:19`), et le seul remède serait un UPDATE
manuel en production.

**Points d'insertion** : `src/campaign/types.ts`, `src/campaign/store.pg.ts` (`CreateCampaignInput` et
**les DEUX inserts**, lignes 77 et 480, cf. ci-dessous), `src/http/campaigns.ts` (validation, allowlist
stricte), **`src/http/v1-sends.ts`** (oublié par la v1 : l'API publique crée aussi des campagnes, un
intégrateur doit pouvoir déclarer l'intention), `web/app/campaigns/page.tsx`.

⚠️ **Deux inserts de `campaigns`, pas un** : `store.pg.ts:77` (`insertCampaign`, sans appelant applicatif)
et `store.pg.ts:480` (`createWithRecipients`, le seul chemin réel). Ne modifier que le premier perdrait le
champ en silence. **C'est déjà arrivé sur `workflow_id`**, d'où le test de non-régression
`stores.integration.test.ts:630`.

⚠️ **Migration 0041 obligatoire** (`campaigns.target_control_owner`), livrée avec A.5. Sans elle, le premier
POST de création de campagne tombe en 500 `column does not exist`, le mode de panne décrit dans
`DEPLOY.md:65-69`.

---

## Les tests à écrire

1. **Un humain répond, le scénario ne bouge plus.** Le test qui justifie le bloc.
2. **Un envoi automatisé ne dégrade pas `app_human`.** Mutation : retirer `only` doit faire échouer.
3. **`upsertConversationByWaId` ne réinitialise pas le détenteur.** Mutation : l'ajouter au `DO UPDATE`
   doit faire échouer.
4. **`start` et `startFromNode` refusent d'écrire dans un fil tenu par un humain** (le trou de la v1).
5. **Une conversation absente vaut `app_workflow`.**
6. **Le garde vaut aussi pour `mba`**, pas seulement pour `app_human`.
7. **Le webhook `standby` ne fait pas répondre le scénario.**
8. **Le balayage libère `mba` comme `app_human`**, et jamais une conversation active.
9. **Un run qui atteint son bloc inbox pose `app_human`** (A.5).

Fakes à mettre à jour, ils cassent à la compilation dès qu'une clé est ajoutée :
`tests/http-rbac.test.ts`, `tests/auth-live-state.test.ts`, `tests/http-campaigns.test.ts`,
`tests/contacts.test.ts`, plus les suites d'inbox et de workflow.

## Ordre de déploiement

Migrations ADD-only, donc **migrer avant de déployer**, 0040 avec A.1/A.2/A.4 et 0041 avec A.5.

Rappel du piège de `DEPLOY.md` : le `compose run` de migration part de l'**image**, pas du disque. Donc
`docker compose build mba-api` d'abord, sinon `migrate` répond « à jour, rien à appliquer » avec aplomb
sans rien avoir appliqué.
