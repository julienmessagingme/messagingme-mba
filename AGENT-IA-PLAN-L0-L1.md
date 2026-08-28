# Plan d'exécution, agent IA lots L0 et L1

> **Pour un exécutant agentique :** SOUS-SKILL REQUISE, utiliser `superpowers:subagent-driven-development`
> (recommandé) ou `superpowers:executing-plans` pour exécuter tâche par tâche. Les étapes sont des cases
> à cocher (`- [ ]`).

**But :** poser un bloc « agent » dans le moteur de scénario, capable de tenir une conversation
WhatsApp sur plusieurs tours et d'en sortir par une branche câblée, avec les outils maison seulement.

**Architecture :** le bloc agent est une **main rendue** dans le moteur (patron `rcs_send`), pas un
état de repos. Le `walk` reste pur et rend un `rest`, l'exécuteur persiste et enfile un job
`agent-turn`. Chaque tour est un job. La boucle vit **entre** les jobs, bornée par des compteurs
persistés. L'inactivité est un job différé par `startAfter`, pas un balayage. Le run reste en
`waiting` sur le bloc agent pendant toute la session.

**Stack :** TypeScript ESM exécuté par `tsx`, Fastify, pg-boss sur Postgres Supabase, vitest,
Next.js 15 dans `web/`, Playwright pour les e2e.

**Cadrage de référence :** [AGENT-IA-CADRAGE-2026-08-23.md](AGENT-IA-CADRAGE-2026-08-23.md).

---

## 🔴 DETTES OUVERTES (registre unique, tenu à jour à chaque tâche)

La règle de la maison est « on ne laisse rien traîner » : 🔴 **et** 🟡 corrigés dans la foulée, pas de report
qui s'empile. Ce registre existe pour ce qui **ne pouvait pas** être fait dans la tâche courante, parce que la
pièce qui le consomme n'existe pas encore. Chaque ligne dit **quand** elle se ferme et **ce qui casse** si on
l'oublie. Rien n'entre ici sans ces deux colonnes.

**Aucune de ces dettes n'est un bug latent aujourd'hui** : rien de tout cela n'est branché en production, le
bloc agent n'est servi nulle part. Elles deviennent des bugs le jour où on branche.

| # | Dette | Se ferme | Ce qui casse si on l'oublie |
|---|---|---|---|
| D1 | **Devise.** Le Gateway facture en **dollars** (`coutDollars`, `chat-client.ts`) ; la colonne est `budget_micro_eur` et `runTurn` compare `coutMicroEur >= budgetMicroEur`. | Avant la mise en service. Décision de **facturation** (convertir, ou renommer la colonne), pas technique. | Le plafond de budget est faux d'un facteur de change. Trop haut, on dépasse ; trop bas, l'agent se coupe tout seul. |
| D2 | **La file `agent-turn` n'a aucun consommateur.** Elle est dans `BASE_QUEUES` (donc visible d'`/ops`, DLQ surveillée), mais `src/worker.ts` ne l'écoute pas. Le test `queue-names` est **unidirectionnel** et ne peut pas le voir. | Tâche de câblage du cerveau réel. Avec `retryLimit: 2` et `parseAgentTurnJob`. | Rien n'enfile aujourd'hui non plus. Le jour où `enqueueAgentTurn` est câblé sans le worker : les tours s'empilent, les conversations restent muettes, et **c'est silencieux**. |
| D3 | **`executeTool` n'a aucun appelant.** Trois responsabilités lui reviennent, écrites en JSDoc là où elles se jouent : (a) **alerter** sur `fatal: true` (erreur de protocole) via la dep d'alerte du worker ; (b) calculer `appelsRestants` et `budgetRestantMicroEur` depuis la fiche et la session ; (c) **encadrer le résultat en bloc délimité** avant de le remettre au modèle. | Même tâche de câblage que D2. | (a) une panne de notre client passe inaperçue ; (b) les deux plafonds ne s'appliquent pas ; (c) **un résultat d'outil concaténé au prompt est une injection indirecte**, c'est la règle du CLAUDE.md global. |
| D4 | **Le câblage du runtime d'agent n'existe pas dans `wiring.ts`.** Ni `agentSessions`, ni `enqueueAgentTurn`, ni les résolveurs, ni `escaladerVersHumain`, ni `envoyerBloc`. | Même tâche que D2 et D3. C'est elle qui les ferme toutes les trois. | Le bloc agent est traversé comme un passe-plat en production : le scénario continue sans que l'agent parle. |
| D5 | **Un bloc agent est invisible d'Analytics.** `web/lib/mesures-scenario.ts` (`BLOCS_MESSAGE`) n'inclut pas `agent`. | Tâche dédiée, après l'UI. Pose une **question produit** : comment mesurer un contenu généré au fil des tours, inconnu statiquement. | Aucune panne. Le client ne voit simplement pas ce bloc dans « Mes tableaux ». |
| D6 | **La migration 0086 n'est pas appliquée en production** (dernière appliquée : 0085). | Au déploiement, **après** un `compose build` et **avant** le `up -d` (les migrations vivent dans l'image, pas sur le disque du VPS). | `column ... does not exist`, en silence, dans une file d'échec. C'est l'incident du 2026-08-17. |

**Trou générique préexistant, hors périmètre agent** (noté ici pour ne pas le perdre) : `advance` est aussi
appelé sur un accusé de livraison RCS, donc un montage `rcs_message --(unreachable)--> bloc de session`
atteint une transition fraîche sans fenêtre WhatsApp prouvée. Vaut déjà pour `quick_message`, `flow` et
`question`, et la campagne le bloque par `scanOpening`.

## Révision du 2026-08-26 : le bloc Question change trois choses

Un chantier parallèle ajoute un bloc **Question** au moteur (24 fichiers, non commité au moment de
cette révision). Il résout le même problème que l'inactivité de l'agent, et mieux que ce que ce plan
prévoyait. Trois conséquences.

**La tâche 3 est supprimée.** Le bloc Question fait attendre un run sur **deux choses à la fois** :
une réponse du contact **et** le temps qui passe. Le run reste `waiting`, donc `findWaitingByWaId` le
voit et une réponse peut le reprendre, et il porte **en plus** un `resume_at` que le balayeur de
réveil consomme. `WalkRest.waiting` a gagné un `timeoutInMs` optionnel, `restToState` le traduit en
`resume_at`, et `claimDueQuestions` le réclame en le **consommant** (`resume_at = null`), donc une
expiration ne peut être prise qu'une fois même avec plusieurs instances. L'agent monte dessus tel
quel : plus besoin de `startAfter` sur le contrat `Queue`, plus besoin d'un job différé.

**La tâche 17 devient une ligne, plus un mécanisme.** Quand l'agent pose une question et attend, le
tour rend `{ status: 'waiting', nodeId, timeoutInMs: inactivite_minutes * 60_000 }`. Le reste est
déjà écrit. Et la sortie prend le **même nom de handle que le bloc Question**, `timeout`, plutôt
qu'un `sortie:inactivite` à moi : un seul vocabulaire dans le builder.

**La migration passe de 0085 à 0086**, et elle n'a **pas** à créer l'index partiel sur
`workflow_runs (resume_at) where status = 'waiting' and resume_at is not null` : le bloc Question
l'apporte déjà.

Deux choses à reprendre telles quelles de ce chantier, parce qu'elles sont le patron exact dont les
tâches 6, 7 et 8 ont besoin : ses cas `question` dans `actionOf`, `walk`, `scanOpening`,
`waitBeforeSessionMessage`, `node-list`, `nodeMeta` et `campaign-eligibility` ; et sa façon de
reprendre par un handle nommé plutôt que par `nextNode`, avec sa justification (« le successeur d'une
question n'a aucun sens, c'est la réponse qui décide de la suite »).

Et une course résiduelle documentée chez eux vaut aussi pour l'agent : si le contact répond dans les
quelques centaines de millisecondes qui suivent la réclamation de l'échéance, il reçoit deux
messages. L'arbitrage retenu est explicite et il tient pour nous : mieux vaut un message en double,
qui se voit, qu'une réponse de client avalée en silence.

## État de ce plan, à lire avant de commencer

**Les tâches 1 à 13 sont détaillées pas à pas, avec le code et les commandes.** Elles vont du bump
zod jusqu'à un **squelette ambulant** : un bloc agent qui tient le fil sur plusieurs tours, répond,
sort par ses branches câblées et respecte ses plafonds, avec un cerveau bouchonné. C'est un
incrément livrable et testable, et c'est la partie **risquée**, celle qui touche `advance`, le chemin
le plus chaud du produit.

**Les tâches 14 à 19 portent leurs décisions, leurs contrats et leurs pièges, mais pas encore leurs
étapes.** Elles ont besoin d'une passe de détail avant exécution. Ne pas les lancer en l'état.

**Ce que ce plan ne couvre pas :** la conversation de construction (§5 du cadrage), que le cadrage
prévoit de livrer en version minimale avec L1. C'est un chantier d'interface à part entière, il aura
son propre plan.

## Corrections du cadrage établies par la cartographie du 2026-08-26

Le cadrage contient des numéros de ligne périmés et deux erreurs de fond. Ce plan fait foi.

| Le cadrage dit | La vérité vérifiée sur HEAD |
|---|---|
| `engine.ts:487-495` (branche générique) | `engine.ts:567-574` |
| `executor.ts:191` (`restToState`) | `executor.ts:241-248` |
| `executor.ts:637` (`advance`) | `executor.ts:867-978` |
| `web/lib/api.ts:1282` (miroir des types) | `web/lib/api.ts:1445` |
| migrations 0075 et 0076 | **déjà prises**. 0085 l est aussi depuis le bloc Question : la prochaine libre est **0086** |
| « une seule branche à ajouter dans `advance()` » | **trois sites** : `advance` (867), `resume` (489-582), `runFrom` (678-742) |
| zod : viser `^3.25.76` | **faux et dangereux**, viser `^4.4.3` directement, voir tâche 1 |

Cinq points que le cadrage ne mentionnait pas et qui sont des pannes silencieuses : `scanOpening`,
`waitBeforeSessionMessage`, `v1-sends.ts:39`, `node-list.ts` et le fait que `restToState` **sera**
atteint par le nouveau statut (contrairement à `rcs_send`, toujours résolu avant).

## Contraintes globales

- **zod cible : `^4.4.3` exactement**, jamais `^3.25.76`, jamais `4.0.x`. Raison mesurée en tâche 1.
- **Le bump zod atterrit AVANT tout `npm i ai` ou `npm i @modelcontextprotocol/client`.**
  `@modelcontextprotocol/client@2.0.0` déclare `zod: ^4.2.0` en dépendance **dure** : installé sur une
  racine en 3.x, il crée trois arbres zod dans le lock, et deux runtimes zod dans un process font
  lâcher les `instanceof` en silence.
- **Prochaine migration libre : 0086** (0085 est prise par le bloc Question). Les migrations vivent dans l'image Docker (`COPY db ./db`) :
  `compose build` **avant** `compose run --rm --no-deps mba-api npm run migrate`, puis `up -d --build`.
- **`tenant_id = $1` sur chaque requête.** Le pooler est superuser, la RLS est bypassée, le filtrage
  en code est le seul contrôle.
- **`node.data` est opaque et fourni par le client** (`graph.ts:81`). Un `data.agentId` peut pointer
  l'agent d'un autre tenant : toute lecture d'agent se fait `where tenant_id = $1 and id = $2`.
- **Zod `safeParse`, jamais `parse`,** sur toute entrée non fiable. Jamais de `as` sur un payload externe.
- **Aucune erreur destinée à l'utilisateur en 5xx** : Cloudflare remplace le corps. 422 ou 409.
- **Pas de tiret cadratin ni demi-cadratin** dans le code, les commentaires et la doc.
- **`npm test` en local ne prouve que la moitié.** Le `DATABASE_URL` local pointe sur la PRODUCTION :
  ne jamais lancer `test:integration` d'ici. Après push, lire le run GitHub (jobs `unit`,
  `integration`, `web`).
- **Référence à noter avant de commencer :** `npx tsc --noEmit` propre, et `npm test` à 192 fichiers
  et 2451 tests verts en environ 94 s. C'est la seule base de comparaison.

---

# Phase L0, les fondations

## Révision du 2026-08-27 : réconciliation avec le cadrage rev3

Le cadrage a beaucoup bougé les 2026-08-26 et 27 (deux IA, temps 1 contre temps 2, objectif de
l'agent, scénarios déclenchés, choix de modèle, base de connaissance, anti-hallucination, concurrence
par tenant). Ce plan est aligné ici. **Le cœur du moteur** (main rendue, jobs par tour, compteurs
persistés) **ne change pas** ; seules ces additions arrivent.

- **Nouvelle tâche 4bis (L0)** : la brique de concurrence par tenant sur `agent-turn`, la moitié
  réutilisable du correctif **B4** de l'audit de scalabilité. Elle borne le nombre de tours simultanés
  d'un même tenant, pour qu'un client bavard n'affame pas les autres sur le worker unique.
- **Tâche 5 étendue** : la migration ajoute la table `agent_knowledge` (recherche plein texte
  `tsvector` plus `pg_trgm`, aucune extension Postgres nouvelle, pas de pgvector). C'est la base de
  connaissance par tenant, celle que l'écran de fiches montre et que l'agent interroge.
- **Le schéma de fiche (`ficheAgentSchema`) gagne trois champs** : `nom`, `ton`, `personnalite`. Ils
  vivent dans le `jsonb` de la fiche, donc pas de colonne : juste le schéma Zod et le prompt système
  qui les lit.
- **Nouvelle tâche 16bis** : l'outil maison de recherche dans `agent_knowledge`, et le handle
  déterministe `sortie:sans_source`. Le seuil de score est calculé en code ; sous le seuil, l'outil
  rend `aucune_source` et le node sort par ce handle, jamais une décision du modèle. C'est le
  mécanisme anti-hallucination du doc produit.
- **Tâches 18 et 19 réécrites** : le groupe de navigation « AI Agent », et les **deux surfaces
  d'édition** (la construction en parlant et un écran de réglage classique à onglets, synchronisés sur
  la même fiche).
- **« Après L1 » rafraîchi** : la vérification live du Gateway est faite (`usage.cost` présent), elle
  ne conditionne plus rien.

Le plan L2 et suivants (connecteurs, MCP, retour dans la durée) reste au niveau du séquencement du
cadrage §7 ; il sera détaillé le moment venu.

---

## Tâche 1 : passer zod en 4.4.3

**Fichiers :**
- Modifier : `package.json:31`
- Modifier : `package-lock.json` (régénéré, jamais édité à la main)
- Créer : `tests/zod-bump-garde.test.ts`

**Interfaces :**
- Consomme : rien.
- Produit : un runtime zod 4 unique et dédupé, prérequis de toutes les tâches suivantes.

**Pourquoi 4.4.3 et pas l'étape intermédiaire, mesuré :** le sous-chemin `zod/v4` exposé par 3.25.76
est un instantané de zod 4.0, et **zod 4.0 réécrit les URL au parse**. Sur les quatre versions
testées : 3.25.76 via `zod/v4` normalise, 4.0.0 normalise, 4.1 à 4.4.3 ne normalisent pas. L'étape
dite prudente porte donc le comportement dangereux. Conséquence concrète dans ce repo :
`src/rcs/schema.ts:69` déclare `mediaUrl: z.string().url().max(255)`, dans cet ordre la borne
s'applique à la valeur **normalisée**, et la valeur parsée est **persistée**
(`campaigns.ts:229`, `rcs-messages.ts:48` et `:60`) puis relue par `parseStoredRcsOutbound`, qui rend
`null` sur échec. Un visuel de campagne dont l'URL porte un accent reviendrait en `content: null`,
affiché en bulle vide, sans log et sans 500.

**Aucun fichier source n'a besoin de changer.** Vérifié : 30 cas représentatifs rejoués sous 3.25.76
puis 4.4.3 donnent une sortie identique octet pour octet, et `tsc --noEmit` est propre sous les deux.
Le repo utilise déjà `z.record(z.string(), z.unknown())` à deux arguments (`analysis/schema.ts:19`) et
lit déjà `error.issues` et non `error.errors` (`tests/config-guards.test.ts:21`), les deux ruptures
qui auraient mordu.

- [ ] **Étape 1 : noter la référence AVANT de toucher quoi que ce soit**

```bash
npx tsc --noEmit && npm test 2>&1 | tail -5
```

Attendu : `tsc` sans sortie, et une ligne de résumé vitest. Noter le nombre de fichiers et de tests.

- [ ] **Étape 2 : écrire le test de garde, qui doit être vert AVANT et APRÈS**

Ce test épingle la seule propriété qui diffère entre les versions candidates. Il est vert sur 3.25.76
et sur 4.4.3, et rouge sur 4.0.0 et sur `zod/v4` de 3.25.76. C'est un vrai test à double sens.

```ts
// tests/zod-bump-garde.test.ts
import { describe, expect, it } from 'vitest';
import { rcsOutboundSchema } from '../src/rcs/schema';

// Garde du bump zod. La seule difference de comportement entre les versions candidates est la
// normalisation d URL au parse : zod 4.0 (et le sous-chemin zod/v4 de 3.25.76) reecrit l URL,
// 3.25.76 et 4.1+ la rendent verbatim. Comme la valeur PARSEE est persistee puis relue par
// parseStoredRcsOutbound (qui rend null sur echec), une reecriture rendrait un visuel de campagne
// illisible en silence. Ce test tombe au rouge sur toute version normalisatrice.
describe('garde du bump zod', () => {
  it('rend une URL de media VERBATIM, sans normalisation', () => {
    const url = 'https://CDN.Exemple.FR:443/ete photo.png';
    const r = rcsOutboundSchema.safeParse({
      kind: 'card',
      card: { title: 'Ete', mediaUrl: url },
    });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data).toMatchObject({ card: { mediaUrl: url } });
  });
});
```

- [ ] **Étape 3 : le lancer sur le repo intact, il doit être VERT**

```bash
npx vitest run tests/zod-bump-garde.test.ts
```

Attendu : PASS. S'il est rouge ici, c'est que la forme du schéma a changé : lire
`src/rcs/schema.ts:66-86` et adapter l'objet, pas l'assertion.

- [ ] **Étape 4 : bumper**

```bash
npm install zod@^4.4.3
```

Attendu : `package.json` passe à `"zod": "^4.4.3"` et `package-lock.json` est régénéré. Ne pas
éditer le lock à la main. `Dockerfile:6` et les trois jobs de `.github/workflows/ci.yml` font
`npm ci`, qui lit le **lock** et ignore la borne : un `package.json` édité sans lock régénéré fait
échouer `npm ci` (bruyant, tant mieux), un lock régénéré sans édition de `package.json` est un no-op
**silencieux**.

- [ ] **Étape 5 : vérifier qu'il n'y a qu'un seul zod**

```bash
npm ls zod
```

Attendu : une seule ligne `zod@4.4.3`, aucun frère `deduped` à une autre version.

- [ ] **Étape 6 : rejouer la référence**

```bash
npx tsc --noEmit && npm test 2>&1 | tail -5
```

Attendu : `tsc` propre, et exactement le même nombre de tests verts qu'à l'étape 1. Si un test casse,
ne pas le modifier : c'est le signal.

- [ ] **Étape 7 : vérifier le test de garde dans le sens de l'ÉCHEC**

Ne pas revenir en arrière sur le repo. Dans une copie jetable hors du repo, installer `zod@4.0.0`,
y copier `src/rcs/schema.ts` et `src/rcs/types.ts`, et constater que l'URL revient réécrite. Environ
une minute. C'est le protocole qui a établi le comportement, et c'est ce qu'exige la règle « un test
de non-régression se vérifie dans les deux sens ».

- [ ] **Étape 8 : commit**

```bash
git add package.json package-lock.json tests/zod-bump-garde.test.ts
git commit -m "chore(deps): zod 4.4.3, et la garde qui empeche une version normalisatrice

Le sous-chemin zod/v4 de 3.25.76 est un instantane de zod 4.0, qui REECRIT les URL
au parse. Comme la valeur parsee est persistee (campaigns, rcs-messages) puis relue
par parseStoredRcsOutbound qui rend null sur echec, un visuel dont l URL porte un
accent reviendrait en bulle vide, sans log ni 500. L etape intermediaire etait donc
le chemin risque et la destination est propre : on va directement en 4.4.3.

Aucun fichier source ne change : verifie sur 30 cas rejoues sous les deux versions,
sortie identique et tsc propre. Le repo utilisait deja z.record a deux arguments et
lisait deja error.issues, les deux ruptures qui auraient morde.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

- [ ] **Étape 9 : pousser et lire la CI**

```bash
git push origin main
```

Attendu : les trois jobs verts. Le job `integration` est le seul qui exerce les migrations et les
stores contre un vrai Postgres, et il ne peut pas être joué en local.

---

## Tâche 2 : aligner `engines` sur le runtime réel

**Fichiers :** Modifier `package.json` (champ `engines`).

Commit **séparé** de la tâche 1, délibérément : zod 4.4.3 ne déclare aucun `engines`, les deux
changements sont indépendants, et groupés une CI rouge aurait deux causes candidates.

- [ ] **Étape 1 : passer `engines.node` de `>=20` à `>=22`**

Le `Dockerfile` est déjà sur `node:22-alpine` et la CI sur `node-version: 22`. La borne `>=20` est
déjà désynchronisée du runtime réel : c'est de l'honnêteté de manifeste.

- [ ] **Étape 2 : vérifier**

```bash
npm ci --dry-run 2>&1 | tail -3
```

Attendu : aucun `EBADENGINE`.

- [ ] **Étape 3 : commit**

```bash
git add package.json
git commit -m "chore: engines node >=22, aligne sur le Dockerfile et la CI

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Tâche 3 : SUPPRIMÉE, le bloc Question rend `startAfter` inutile

**Ne pas exécuter.** Conservée pour mémoire du raisonnement, et parce que savoir pourquoi un
mécanisme n'a pas été ajouté vaut mieux que son absence silencieuse.

L'agent avait besoin de se réveiller sur inactivité. Un job différé par `startAfter` était le moyen
d'éviter un second balayage. Mais le bloc Question a apporté mieux : le run reste `waiting` avec un
`resume_at`, et le balayeur **existant** le réclame en consommant l'échéance. Un mécanisme de moins,
et l'agent attend exactement comme le reste du produit au lieu d'inventer sa propre façon.

Passer directement à la tâche 4.

<details>
<summary>Le contenu d'origine, pour mémoire</summary>

### (obsolète) ajouter `startAfter` au contrat `Queue`

**Fichiers :**
- Modifier : `src/queue/queue.ts:15`
- Modifier : `src/queue/pgboss.ts:124-132`
- Modifier : `src/queue/fake.ts:8` et `:14`
- Créer : `tests/queue-start-after.test.ts`

**Interfaces :**
- Produit : `Queue.enqueue(name, data, opts?: { singletonKey?, expireInSeconds?, startAfter? })`.
  C'est le mécanisme d'inactivité de la tâche 17, et il remplace un second balayage.

**Vérifié :** `maintenanceOptions` pose `schedule: false` (`pgboss.ts:50`), ce qui désactive le
**cron** de pg-boss (`boss.schedule`) et **pas** les jobs différés, qui passent par la requête de
récupération normale (`start_after <= now()`). Le mécanisme tient.

- [ ] **Étape 1 : écrire le test qui échoue**

```ts
// tests/queue-start-after.test.ts
import { describe, expect, it } from 'vitest';
import { FakeQueue } from '../src/queue/fake';

describe('Queue.enqueue startAfter', () => {
  it('transporte startAfter jusqu au job empile', async () => {
    const q = new FakeQueue();
    await q.enqueue('agent-turn', { sessionId: 'a' }, { startAfter: 1800 });
    expect(q.enqueued[0]?.opts).toMatchObject({ startAfter: 1800 });
  });

  it('n invente pas startAfter quand l appelant ne le passe pas', async () => {
    const q = new FakeQueue();
    await q.enqueue('agent-turn', { sessionId: 'a' });
    expect(q.enqueued[0]?.opts?.startAfter).toBeUndefined();
  });
});
```

- [ ] **Étape 2 : le lancer, il doit ÉCHOUER**

```bash
npx vitest run tests/queue-start-after.test.ts
```

Attendu : FAIL, TypeScript refuse `startAfter` sur le type des options.

- [ ] **Étape 3 : élargir le contrat**

Dans `src/queue/queue.ts:15`, ajouter `startAfter` au type des options, avec sa doc, dans le style
des deux options déjà documentées :

```ts
  /**
   * Empile un job (fire-and-forget, durable cote impl reelle). `opts.singletonKey` :
   * ... (doc existante conservee)
   * `opts.startAfter` : DIFFERE le job. Nombre de SECONDES, date ISO ou Date. C est le
   * mecanisme d inactivite du bloc agent : on enfile le tour de reveil au moment ou l agent
   * pose sa question, et le verrou optimiste sur le numero de tour le rend inoffensif si le
   * contact a repondu entre temps. `schedule: false` de pg-boss ne desactive que le CRON,
   * pas les jobs differes.
   */
  enqueue(
    name: string,
    data: unknown,
    opts?: { singletonKey?: string; expireInSeconds?: number; startAfter?: number | string | Date },
  ): Promise<void>;
```

- [ ] **Étape 4 : câbler l'implémentation réelle**

Dans `src/queue/pgboss.ts:128-131`, ajouter la propagation **sous la même forme conditionnelle** que
les deux autres options. Ne pas écrire `?? valeur` : le fichier documente déjà lignes 34-46 pourquoi
une option absente doit rester absente, et `startAfter: 0` serait avalé par un test de véracité,
exactement comme `max: 0` l'a été pour `poolOptions`.

```ts
    await this.boss.send(name, data as object, {
      ...(opts?.singletonKey ? { singletonKey: opts.singletonKey } : {}),
      ...(opts?.expireInSeconds ? { expireInSeconds: opts.expireInSeconds } : {}),
      ...(opts?.startAfter !== undefined ? { startAfter: opts.startAfter } : {}),
    });
```

- [ ] **Étape 5 : câbler le fake**

Dans `src/queue/fake.ts`, élargir le type du tableau `enqueued` (ligne 8) et la signature (ligne 14)
avec exactement le même type d'options. Sans ça la file n'est pas testable.

- [ ] **Étape 6 : relancer, les deux tests doivent PASSER**

```bash
npx vitest run tests/queue-start-after.test.ts && npx tsc --noEmit
```

Attendu : 2 passed, et `tsc` propre.

- [ ] **Étape 7 : commit**

```bash
git add src/queue/queue.ts src/queue/pgboss.ts src/queue/fake.ts tests/queue-start-after.test.ts
git commit -m "feat(queue): startAfter sur enqueue"
```

</details>

---

## Tâche 4 : déclarer la file `agent-turn`

**Fichiers :**
- Créer : `src/agent/turn-job.ts`
- Modifier : `src/queue/names.ts:13` et `:41-48`
- Modifier : `tests/queue-names.test.ts:21`

**Interfaces :**
- Produit : `AGENT_TURN_QUEUE`, et `parseAgentTurnJob(raw): AgentTurnJob | null`, consommés par la
  tâche 13.

- [ ] **Étape 1 : créer le module de la file, sur le patron de `src/automation/event-job.ts`**

```ts
// src/agent/turn-job.ts
export const AGENT_TURN_QUEUE = 'agent-turn';

export type RaisonTour = 'demarrage' | 'message' | 'inactivite';

export interface AgentTurnJob {
  tenantId: string;
  runId: string;
  sessionId: string;
  workflowId: string;
  nodeId: string;
  waId: string;
  raison: RaisonTour;
  /** Numero de tour ATTENDU. Verrou optimiste : pg-boss est at-least-once, et un job
   *  d inactivite differe peut se reveiller apres que le contact a repondu. */
  tours: number;
}

const RAISONS: readonly RaisonTour[] = ['demarrage', 'message', 'inactivite'];

/**
 * Coerce defensivement le payload de la file. Rend `null` plutot que de lever : un payload
 * inexploitable ne doit pas faire boucler la file jusqu a la DLQ (meme doctrine que
 * parseAutomationEventJob). Le producteur DOIT relire ce parseur : une chaine morte parce que
 * le producteur emet un champ que le consommateur n attend pas est deja arrivee sur automation-event.
 */
export function parseAgentTurnJob(raw: unknown): AgentTurnJob | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const s = (k: string): string | null => (typeof o[k] === 'string' && o[k] ? (o[k] as string) : null);
  const tenantId = s('tenantId');
  const runId = s('runId');
  const sessionId = s('sessionId');
  const workflowId = s('workflowId');
  const nodeId = s('nodeId');
  const waId = s('waId');
  const raison = RAISONS.find((r) => r === o.raison) ?? null;
  const tours = typeof o.tours === 'number' && Number.isInteger(o.tours) && o.tours >= 0 ? o.tours : null;
  if (!tenantId || !runId || !sessionId || !workflowId || !nodeId || !waId || !raison || tours === null) {
    return null;
  }
  return { tenantId, runId, sessionId, workflowId, nodeId, waId, raison, tours };
}
```

- [ ] **Étape 2 : écrire le test du parseur**

```ts
// tests/agent-turn-job.test.ts
import { describe, expect, it } from 'vitest';
import { parseAgentTurnJob } from '../src/agent/turn-job';

const valide = {
  tenantId: 't', runId: 'r', sessionId: 's', workflowId: 'w',
  nodeId: 'n1', waId: '33600000000', raison: 'message', tours: 3,
};

describe('parseAgentTurnJob', () => {
  it('accepte un payload complet', () => {
    expect(parseAgentTurnJob(valide)).toEqual(valide);
  });

  it('rend null plutot que de lever sur un payload inexploitable', () => {
    expect(parseAgentTurnJob(null)).toBeNull();
    expect(parseAgentTurnJob({})).toBeNull();
    expect(parseAgentTurnJob({ ...valide, raison: 'autre' })).toBeNull();
    expect(parseAgentTurnJob({ ...valide, tours: 1.5 })).toBeNull();
    expect(parseAgentTurnJob({ ...valide, tenantId: '' })).toBeNull();
  });

  it('accepte le tour zero, qui est le demarrage', () => {
    expect(parseAgentTurnJob({ ...valide, raison: 'demarrage', tours: 0 })).not.toBeNull();
  });
});
```

- [ ] **Étape 3 : lancer, ça doit PASSER**

```bash
npx vitest run tests/agent-turn-job.test.ts
```

- [ ] **Étape 4 : déclarer la file**

Dans `src/queue/names.ts`, ajouter `'agent-turn'` au tuple `BASE_QUEUES` (ligne 13) **et** une entrée
dans `QUEUE_POLLING_SECONDS` (lignes 41-48). `QUEUE_POLLING_SECONDS` est typé
`Record<(typeof BASE_QUEUES)[number], number>` : ajouter la file sans la cadence casse `tsc`, c'est
voulu. Cadence **2 s**, comme `webhook`, parce que c'est un chemin conversationnel. À assumer
explicitement : cette cadence a été descendue pour contenir l'egress Supabase (663 000 requêtes par
jour mesurées le 2026-08-17, commentaire lignes 26-39). Conséquence : `ALL_QUEUES` passe de 12 à 14
entrées et la DLQ `agent-turn-dlq` devient surveillée depuis `/ops`.

- [ ] **Étape 5 : apprendre la constante au test de garde**

`tests/queue-names.test.ts` dérive la liste des files en lisant le source de `src/worker.ts` et
**lève** sur une constante qu'il ne sait pas résoudre (ligne 22, « constante de file inconnue du
test »). Ajouter la résolution de `AGENT_TURN_QUEUE` ligne 21. Ne pas contourner en passant le
littéral `'agent-turn'` au call site : la panne est bruyante et c'est le but.

- [ ] **Étape 6 : vérifier**

```bash
npx vitest run tests/queue-names.test.ts && npx tsc --noEmit
```

- [ ] **Étape 7 : commit**

```bash
git add src/agent/turn-job.ts src/queue/names.ts tests/agent-turn-job.test.ts tests/queue-names.test.ts
git commit -m "feat(agent): declarer la file agent-turn et son parseur defensif

Un tour d agent est un appel LLM plus N appels d outils, soit 3 a 20 s. Le laisser en
ligne dans le handler de webhook tiendrait la connexion Meta ouverte et ferait retenter
le webhook pendant qu on parle au modele. D ou une file dediee, a 2 s comme webhook
puisque c est un chemin conversationnel.

Le payload porte le numero de tour attendu : pg-boss est at-least-once et le job
d inactivite differe peut se reveiller apres que le contact a repondu.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

# Phase L1-A, le socle sans comportement

> **Lire le bloc Question avant de commencer cette phase.** Il vient d'ajouter un type de node en
> traitant exactement les mêmes points de couture, et son code est le patron à recopier plutôt qu'à
> réinventer : ses cas `question` dans `actionOf`, `walk`, `scanOpening`,
> `waitBeforeSessionMessage`, `etapeOffreUnChoix`, `node-list`, `nodeMeta` et
> `campaign-eligibility`. Deux points où sa version fait autorité sur les extraits de ce plan :
> `WalkRest.waiting` porte désormais un `timeoutInMs` optionnel, et `restToState` a déjà gagné le cas
> qui le traduit en `resume_at`. Les extraits ci-dessous s'insèrent **à côté**, jamais par-dessus.
>
> Un choix de leur `walk` mérite d'être repris pour l'agent : un bloc Question **non configuré** est
> un passe-plat plutôt qu'un blocage, avec la justification « attendre une réponse à une question
> jamais posée figerait le parcours pour toujours, sans le moindre signal ». Un bloc agent sans agent
> configuré doit se comporter pareil : passer au suivant, pas geler le fil.

## Tâche 4bis : la brique de concurrence par tenant (L0) — ✅ FAIT (commit 51de908, 2026-08-27)

**Fichiers :** `src/queue/queue.ts` (interface), `src/queue/pgboss.ts` (fonction pure
`workConcurrencyOptions` + câblage `localConcurrency`/`localGroupConcurrency` + `groupId` à l'enqueue),
`src/queue/fake.ts` (observable via `workCalls`). Tests : `tests/queue-group-concurrency.test.ts`
(unitaire, local) et `tests/integration/queue-group-concurrency.integration.test.ts` (enforcement, CI
seulement). Réalisé de façon **générique** : aucun enfilage `agent-turn` à ce stade, les tâches 10 et 13
passeront `groupId=tenantId` et `{ concurrency, groupConcurrency }` aux vrais call sites.

**Pourquoi, et pourquoi en L0.** Le worker est unique, sans réplicas, et chaque file est sérialisée
(`pgboss.ts` force `batchSize: 1` sans option de concurrence). L'audit de scalabilité l'a déjà
constaté sur les campagnes (constat **B4** : un tenant à gros volume bloque tous les autres). La file
`agent-turn` hériterait du même défaut : un client dont l'agent enchaîne beaucoup de tours, ou qui
boucle sur une injection, affamerait les autres tenants **et** viderait son propre prépayé. On pose
donc dès le départ un plafond de tours simultanés **par tenant**.

**La brique est partagée avec B4.** pg-boss 12 n'a plus de `teamSize` ; il offre `localConcurrency`
et surtout `groupConcurrency` / `localGroupConcurrency`, qui donnent un plafond **par groupe**. On
étend le wrapper `Queue.work` pour accepter ces options et un identifiant de groupe par job, et on
enfile chaque `agent-turn` avec le `tenant_id` comme groupe. La fin de B4 sur les campagnes (bloc 5)
réutilisera la même extension. Confirmer le nom exact de l'option contre la doc pg-boss 12 à
l'implémentation ; repli simple si besoin : un plafond applicatif (compter les sessions `en_cours`
d'un tenant avant d'enfiler, refuser au-delà avec réenfilage différé).

- [ ] **Étape 1 : écrire le test.** N+1 tours d'un même tenant enfilés, vérifier qu'au plus N
  tournent en même temps, et qu'un second tenant n'est jamais bloqué par le premier.
- [ ] **Étape 2 à 6 :** échouer, implémenter, passer, vérifier dans les deux sens, commit.

**Garde-fous à porter ailleurs** (pas ici) : aucun travail CPU synchrone lourd dans un outil (il
gèlerait le worker unique), et jamais de connexion Postgres tenue pendant l'appel LLM (règle de la
tâche 13).

---

## Tâche 5 : la migration 0086 — ✅ FAIT (commit 0816234, 2026-08-27), appliquée proprement en CI

Vérifiée par le job `integration` de la CI (`npm run migrate` sur Postgres jetable) plutôt qu'en local :
le `DATABASE_URL` local pointe la prod, l'étape 3 (Docker local) est donc remplacée par la preuve CI.
`to_tsvector('french'::regconfig, ...)` a reçu le cast explicite (surcharge immutable, obligatoire dans
une colonne générée). CLAUDE.md recalé (0086 nouvelle, 0087 libre).

**Fichiers :** Créer `db/migrations/0086_agent_ia.sql`.

**Interfaces :** Produit les tables `agents`, `agent_tools`, `agent_sessions`, `agent_tool_calls`
et `agent_knowledge`, consommées par les tâches 9 à 16bis.

Note : le design retenu (le run reste en `waiting` sur le bloc agent) n'exige **aucune** migration
sur `workflow_runs`, et c'est un argument fort pour lui. Si quelqu'un proposait un statut de run
dédié, il faudrait **remplacer** le CHECK d'origine et non en ajouter un second, précédent exact en
`0054_workflow_wait.sql:12-16`, plus un index partiel.

- [ ] **Étape 1 : écrire la migration**

```sql
-- 0086_agent_ia.sql
-- Le bloc agent : la fiche, son catalogue d outils, l etat multi-tours, le journal d appels,
-- et la base de connaissance par tenant.
-- Le journal est AUSSI le grand livre de facturation : c est la meme table, volontairement.

create table if not exists agents (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references tenants(id) on delete cascade,
  label              text not null,
  -- Ce que l IA de setup peut ecrire, valide par ficheAgentSchema (Zod safeParse) : objectif, nom,
  -- ton, personnalite, regles de transfert et d arret, sources de connaissance.
  fiche              jsonb not null default '{}'::jsonb,
  fiche_version      int  not null default 1,
  -- Ce qu elle ne peut PAS ecrire : hors du jsonb, ecrit par un admin authentifie.
  mention_ia         text not null,
  max_tours          int  not null default 8  check (max_tours between 1 and 20),
  max_appels_outils  int  not null default 12 check (max_appels_outils between 0 and 60),
  budget_micro_eur   bigint not null default 30000 check (budget_micro_eur > 0),
  inactivite_minutes int  not null default 30 check (inactivite_minutes between 1 and 1440),
  contact_inconnu    text not null default 'lecture_seule'
                     check (contact_inconnu in ('aucun_outil','lecture_seule','tous')),
  modele             text not null,
  status             text not null default 'draft' check (status in ('draft','active','disabled')),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create unique index if not exists agents_label_idx on agents (tenant_id, lower(label));

create table if not exists agent_tools (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id) on delete cascade,
  agent_id        uuid not null references agents(id) on delete cascade,
  origin          text not null check (origin in ('mba','http','mcp')),
  -- Nom EXPOSE au modele. Charset commun OpenAI et Gemini.
  name            text not null check (name ~ '^[a-z0-9_]{1,64}$'),
  title           text not null,
  description     text not null,
  ne_pas_utiliser text not null,
  params          jsonb not null default '[]'::jsonb,
  binding         jsonb not null default '{}'::jsonb,
  output_paths    text[] not null default '{}',
  risk            text not null check (risk in ('read','write','irreversible')),
  timeout_ms      int  not null default 8000 check (timeout_ms between 1000 and 30000),
  max_bytes       int  not null default 16384 check (max_bytes between 256 and 262144),
  actif           boolean not null default false,
  active_par      uuid references users(id) on delete set null,
  active_le       timestamptz,
  -- Autonomie sur une action irreversible : reglage du CLIENT, outil par outil, pose par un
  -- administrateur (decision du 2026-08-26). Faux par defaut : cocher est un acte explicite.
  autonome        boolean not null default false,
  autonome_par    uuid references users(id) on delete set null,
  autonome_le     timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create unique index if not exists agent_tools_name_idx on agent_tools (agent_id, name);
create index if not exists agent_tools_actifs_idx on agent_tools (tenant_id, agent_id) where actif;
-- Un outil n est actif que si un humain l a active. La spec MCP exige un consentement humain
-- avant l invocation d un outil ; notre agent n a pas d humain au runtime, donc on deplace le
-- consentement du runtime vers la CONFIGURATION, et on le rend incontournable EN BASE.
alter table agent_tools drop constraint if exists agent_tools_actif_humain_chk;
alter table agent_tools add constraint agent_tools_actif_humain_chk
  check (actif = false or active_par is not null);
-- Meme doctrine pour l autonomie : cochee, elle porte le nom de qui l a cochee. C est ce qui rend
-- un incident instruisable, et c est la contrepartie du choix de deplacer la decision vers le client.
alter table agent_tools drop constraint if exists agent_tools_autonome_humain_chk;
alter table agent_tools add constraint agent_tools_autonome_humain_chk
  check (autonome = false or autonome_par is not null);

create table if not exists agent_sessions (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants(id) on delete cascade,
  run_id            uuid not null references workflow_runs(id) on delete cascade,
  agent_id          uuid not null references agents(id) on delete cascade,
  node_id           text not null,
  wa_id             text not null,
  transcript        jsonb  not null default '[]'::jsonb,
  tours             int    not null default 0,
  appels_outils     int    not null default 0,
  tokens_in         bigint not null default 0,
  tokens_out        bigint not null default 0,
  cout_micro_eur    bigint not null default 0,
  status            text not null default 'en_cours'
                    check (status in ('en_cours','sortie','inactivite','plafond','erreur')),
  sortie            text,
  derniere_activite timestamptz not null default now(),
  created_at        timestamptz not null default now()
);
-- Une seule session vivante par parcours : l invariant est en base, pas dans une convention.
create unique index if not exists agent_sessions_run_vivante_idx
  on agent_sessions (run_id) where status = 'en_cours';
create index if not exists agent_sessions_tenant_idx on agent_sessions (tenant_id, created_at desc);

create table if not exists agent_tool_calls (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id) on delete cascade,
  session_id     uuid not null references agent_sessions(id) on delete cascade,
  tool_id        uuid references agent_tools(id) on delete set null,
  tool_name      text not null,
  origin         text not null,
  args_rediges   jsonb,
  status         text not null check (status in
                   ('ok','erreur_outil','refuse','timeout','erreur_protocole','budget')),
  http_status    int,
  duree_ms       int,
  taille_reponse int,
  erreur         text,
  at             timestamptz not null default now()
);
create index if not exists agent_tool_calls_session_idx on agent_tool_calls (tenant_id, session_id, at);

-- La base de connaissance par tenant : les fiches issues du scraping, editables. Recherche plein
-- texte native (tsvector), PAS de pgvector. pg_trgm (deja installe en 0032) en complement.
create table if not exists agent_knowledge (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references tenants(id) on delete cascade,
  agent_id            uuid not null references agents(id) on delete cascade,
  titre               text not null,
  corps               text not null,
  source_url          text,
  derniere_lecture_at timestamptz,
  corps_tsv           tsvector generated always as
                        (to_tsvector('french', coalesce(titre,'') || ' ' || coalesce(corps,''))) stored,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index if not exists agent_knowledge_tsv_idx on agent_knowledge using gin (corps_tsv);
create index if not exists agent_knowledge_titre_trgm_idx
  on agent_knowledge using gin (titre gin_trgm_ops);
```

- [ ] **Étape 2 : vérifier la numérotation**

```bash
ls db/migrations/ | tail -3
```

Attendu : `0085_question_timeout.sql` est la dernière avant la nouvelle. Si `0086` existe déjà,
prendre le numéro suivant : le suivi se fait par **nom** dans `schema_migrations`, les trous sont
sans conséquence, les doublons non.

- [ ] **Étape 3 : appliquer localement contre un Postgres jetable, jamais contre le `DATABASE_URL` du `.env`**

```bash
docker run --rm -d -p 55432:5432 -e POSTGRES_PASSWORD=x --name mba-mig postgres:16
```

Puis, avec `DATABASE_URL=postgres://postgres:x@localhost:55432/postgres npm run migrate`, vérifier
qu'elle passe et qu'un second passage est un no-op.

- [ ] **Étape 4 : corriger le CLAUDE.md du repo, périmé à deux endroits**

Il annonce « Prochaine migration libre = 0059 » et « Dernière appliquée 0073, prochaine 0074 ». Les
deux sont faux. Mettre à jour dans ce commit.

- [ ] **Étape 5 : commit**

```bash
git add db/migrations/0086_agent_ia.sql CLAUDE.md
git commit -m "feat(agent): les cinq tables du bloc agent (migration 0086)

Le run reste en waiting sur le bloc agent, donc AUCUNE migration sur workflow_runs.

agent_tools porte une contrainte dure : un outil ne peut etre actif que si un humain
l a active. La spec MCP exige un consentement humain avant l invocation d un outil,
notre agent n en a pas au runtime, on deplace donc le consentement vers la
configuration et on le rend incontournable en base.

agent_tool_calls est le journal d audit ET le grand livre de facturation. Meme table,
volontairement : on ne compte pas deux fois la meme chose.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Tâche 6 : déclarer le type de bloc `agent` partout où il doit être connu — ✅ FAIT (commit a0a48ba, 2026-08-27)

Enum serveur + miroir front + entrée `NODE_META` + cas `summarize` (exportée pour être testée). Pas de
palette ni de moteur (tâches 18 et 7). Reviewer PASS. Tests : `tests/workflow-graph.test.ts` (parseGraph
accepte `agent`) et `tests/node-list.test.ts` (summarize rend le label).

**Fichiers :**
- Modifier : `src/workflow/graph.ts:29`
- Modifier : `web/lib/api.ts:1445`
- Modifier : `web/lib/nodeMeta.ts`
- Modifier : `src/workflow/node-list.ts:23-88`
- Test : `tests/workflow-graph.test.ts`

Le type cote web est une copie **manuelle** de l'enum serveur, et **aucun test ne les relie**. Bonne
nouvelle : `web/lib/nodeMeta.ts:6` déclare `NODE_META` en `Record<WorkflowNodeType, ...>`, donc `tsc`
du build web casse tant que l'entrée `agent` manque, ce qui rattrape l'oubli côté front.

- [ ] **Étape 1 : écrire le test**

```ts
// dans tests/workflow-graph.test.ts, ajouter
it('accepte un bloc de type agent', () => {
  const r = parseGraph({
    nodes: [{ id: 'n1', type: 'agent', position: { x: 0, y: 0 }, data: {} }],
    edges: [],
  });
  expect(r.ok).toBe(true);
});
```

- [ ] **Étape 2 : lancer, ça doit ÉCHOUER**

```bash
npx vitest run tests/workflow-graph.test.ts
```

Attendu : FAIL, `parseGraph` rejette le graphe entier sur un type inconnu (`graph.ts:76`).

- [ ] **Étape 3 : ajouter `'agent'` à la FIN du tuple `WORKFLOW_NODE_TYPES`**

Règle écrite en clair lignes 19-23 du fichier : on ne **retire** jamais une valeur de cet enum,
parce que retirer rendrait inenregistrable tout scénario sauvegardé avant le retrait, avec un
« graphe invalide » inexplicable. C'est pour ça que `tag`, `field`, `mba_handoff` et `mba_disable`
y sont encore alors qu'ils ne sont plus dans la palette.

- [ ] **Étape 4 : ajouter `'agent'` au miroir front `web/lib/api.ts:1445`**

Dans le même commit, sinon le canevas ne connaît pas le bloc.

- [ ] **Étape 5 : ajouter un `case 'agent':` dans `summarize` de `src/workflow/node-list.ts`**

Sans lui, le bloc tombe sur `default: out = ''` (ligne 85) et apparaît dans « Contenu > Blocs » avec
un résumé **vide**, donc indistinguable des autres blocs agent. C'est exactement l'incident déjà vécu
deux fois et documenté dans ce même fichier, pour `wait` (lignes 44-45) puis pour `rcs_message`
(lignes 29-31). Le switch a un `default`, donc `tsc` n'aide pas.

```ts
    case 'agent':
      out = String((data as { label?: unknown }).label ?? '');
      break;
```

- [ ] **Étape 6 : relancer**

```bash
npx vitest run tests/workflow-graph.test.ts && npx tsc --noEmit
```

- [ ] **Étape 7 : commit**

```bash
git add src/workflow/graph.ts src/workflow/node-list.ts web/lib/api.ts tests/workflow-graph.test.ts
git commit -m "feat(scenario): declarer le type de bloc agent, cote serveur et cote front

Le miroir front est une copie manuelle et aucun test ne le relie a l enum serveur :
les deux dans le meme commit. NODE_META est un Record sur le type, donc tsc du build
web rattrape l oubli de ce cote la.

summarize gagne son cas : c est la troisieme recidive du meme defaut (wait, puis
rcs_message), un bloc sans cas apparait avec un resume vide dans Contenu > Blocs.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Tâche 7 : la main rendue dans le moteur — ✅ FAIT (commit ff3cb82, 2026-08-27)

`WalkRest` gagne `agent_turn`, branche dans `walk` à côté de `rcs_message`, cas explicite dans
`restToState` (exportée pour être testée). Sens de l'échec vérifié sur les DEUX gardes. Run CI complet
vert (`unit`, `integration`, `web` avec ses 70 e2e). Reviewer PASS.

⚠️ **Conflit de plan tranché ici** : l'étape 4 ci-dessous montre un code minimal où `data: {}` rend la
main. C'est la note de « Révision du 2026-08-26 » qui gouverne : un bloc agent **sans `agentId`** est un
**passe-plat**, comme le bloc Question sans texte, sinon le parcours gèle pour toujours sans signal.
Test dédié dans `tests/workflow-agent-main-rendue.test.ts`.

**Fichiers :**
- Modifier : `src/workflow/engine.ts:256-264` (`WalkRest`) et `:512-577` (`walk`)
- Modifier : `src/workflow/executor.ts:241-248` (`restToState`)
- Test : `tests/workflow-engine.test.ts`

**Interfaces :**
- Produit : `WalkRest` gagne `{ status: 'agent_turn'; nodeId: string }`. Consommé par les tâches 10
  à 12.

**Le piège central, confirmé par lecture.** Un type non traité par `walk` tombe dans la branche
générique 567-574 : `actionOf` rend `null` (son `return null` final ligne 474), `if (a)` est faux,
rien n'est journalisé, et la ligne 574 fait **avancer** le parcours au bloc suivant. Le bloc agent
serait traversé en silence. Ce comportement n'est pas un accident, il est délibérément testé
(`tests/workflow-engine.test.ts:66-97`, « un type inconnu est traversé en passe-plat ») : il ne peut
pas être retiré, il faut seulement passer **avant** lui.

**La différence avec `rcs_send`, qui décide du design.** `rcs_send` n'atteint jamais `restToState`
parce que `walkResolved` le résout toujours. `agent_turn`, lui, n'est **pas** résolu dans
`walkResolved` : il **atteindra** `restToState`, qui est une fonction de 8 lignes sans contrôle
d'exhaustivité dont le `return` final avale tout le reste en `{ currentNode: null, status: 'done' }`.
Le parcours serait clos en silence pile au moment où l'agent doit prendre la main. On ajoute donc un
cas **explicite**.

- [ ] **Étape 1 : écrire les deux tests qui échouent**

```ts
// tests/workflow-engine.test.ts
it('un bloc agent rend la main au lieu d etre traverse', () => {
  const graph = {
    nodes: [
      { id: 'a', type: 'agent', position: { x: 0, y: 0 }, data: {} },
      { id: 'b', type: 'quick_message', position: { x: 1, y: 0 }, data: { body: 'apres' } },
    ],
    edges: [{ id: 'e', source: 'a', target: 'b' }],
  };
  const r = walk(graph, 'a');
  expect(r.rest).toEqual({ status: 'agent_turn', nodeId: 'a' });
  // le bloc suivant ne doit PAS avoir ete execute
  expect(r.actions).toHaveLength(0);
});

it('les actions qui PRECEDENT le bloc agent partent quand meme', () => {
  const graph = {
    nodes: [
      { id: 't', type: 'action', position: { x: 0, y: 0 }, data: { actionKind: 'add_tag', tag: 'vu' } },
      { id: 'a', type: 'agent', position: { x: 1, y: 0 }, data: {} },
    ],
    edges: [{ id: 'e', source: 't', target: 'a' }],
  };
  const r = walk(graph, 't');
  expect(r.rest).toEqual({ status: 'agent_turn', nodeId: 'a' });
  expect(r.actions).toHaveLength(1);
});
```

- [ ] **Étape 2 : lancer, ça doit ÉCHOUER**

```bash
npx vitest run tests/workflow-engine.test.ts
```

Attendu : FAIL avec `rest` valant `{ status: 'done' }` et `actions` contenant le `quick_message` du
premier test. C'est la traversée silencieuse, observée.

- [ ] **Étape 3 : ajouter le statut au `WalkRest`**

Juste après la ligne 262 (`rcs_send`), en recopiant le commentaire des lignes 259-261 **mot pour
mot**, parce que c'est le même invariant :

```ts
  // Bloc agent : ce n est PAS un etat de repos, c est une MAIN RENDUE, comme rcs_send.
  // Le walk est pur et ne peut pas savoir ce que le modele va decider. L executeur persiste,
  // ouvre la session et enfile un tour ; il reprendra plus tard par un handle de sortie.
  // Difference avec rcs_send : celui-ci est TOUJOURS resolu par walkResolved et n atteint donc
  // jamais restToState. agent_turn, lui, l atteint : restToState a un cas explicite.
  | { status: 'agent_turn'; nodeId: string }
```

- [ ] **Étape 4 : brancher dans `walk`, entre les lignes 546 et 547**

Exactement au même endroit et sous la même forme que `rcs_message`, donc **avant** la branche
template / flow / quick_message et **avant** la branche générique :

```ts
    if (node.type === 'agent') {
      return { actions, rest: { status: 'agent_turn', nodeId: current } };
    }
```

- [ ] **Étape 5 : rendre `restToState` explicite et exhaustif**

Ajouter le cas, et un garde-fou pour que le prochain statut ajouté casse la compilation au lieu de
tomber dans le `done` silencieux :

```ts
  if (rest.status === 'agent_turn') {
    // Le run ATTEND sur le bloc agent : c est ce qui permet a findWaitingByWaId de retrouver
    // le parcours au message suivant du contact. Ne jamais le passer en done ici.
    return { currentNode: rest.nodeId, status: 'waiting' as const };
  }
```

- [ ] **Étape 6 : relancer, les deux tests doivent PASSER**

```bash
npx vitest run tests/workflow-engine.test.ts && npx tsc --noEmit
```

- [ ] **Étape 7 : vérifier dans le sens de l'ÉCHEC**

Commenter la branche ajoutée à l'étape 4, relancer, constater que les deux tests repassent au rouge
avec la traversée silencieuse. Décommenter. Un test qui passe des deux côtés annonce une garantie
qu'il n'apporte pas.

- [ ] **Étape 8 : commit**

```bash
git add src/workflow/engine.ts src/workflow/executor.ts tests/workflow-engine.test.ts
git commit -m "feat(scenario): le bloc agent rend la main au lieu d etre traverse

Sans branche dediee, un type non traite tombe dans la branche generique de walk :
actionOf rend null, rien n est journalise, et le parcours AVANCE au bloc suivant. Le
bloc agent aurait ete traverse en silence. Ce passe-plat est deliberement teste, il ne
peut pas etre retire : on passe avant lui.

restToState gagne un cas EXPLICITE. Contrairement a rcs_send, toujours resolu par
walkResolved, le statut agent_turn l atteint reellement, et son return final aurait
clos le parcours en { currentNode: null, status: done } pile au moment ou l agent doit
prendre la main.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Tâche 8 : les quatre gardes que le cadrage avait oubliées — ✅ FAIT (commit 04994e5, 2026-08-27)

En réalité **CINQ** gardes. La revue en a trouvé une que ce plan ne listait pas :
**`sessionMessageAfterRcs`** (web uniquement). Un montage « RCS puis agent » n'était pas signalé.
`quick_message` en est exclu parce qu'il part sur le canal du parcours ; l'agent tient sa session sur le
numéro WhatsApp et n'a aucun équivalent RCS, il est donc du côté formulaire/question.

⚠️ **Invariant appliqué partout, que ce plan ne dit pas** : un agent **non configuré** est un
**passe-plat** dans les analyses, comme dans `walk` (tâche 7), sinon l'éditeur juge un parcours que le
moteur ne suit pas. C'est la règle déjà écrite dans le cas `question` de `scanOpening`.

⚠️ Le test de parité front/serveur ne prouve que l'**égalité** des deux côtés, pas leur justesse : si
les deux traversaient l'agent, la parité passerait. D'où des assertions explicites côté serveur.

**Reste hors périmètre, pour une tâche dédiée** : `web/lib/mesures-scenario.ts` (`BLOCS_MESSAGE`)
n'inclut pas `agent`, donc un bloc agent n'apparaît pas dans le tableau de mesures d'Analytics. Autre
famille (aucune panne d'envoi), et ça pose une question produit à part : comment mesurer un contenu
généré au fil des tours, qui n'est pas connu statiquement.

**Fichiers :**
- Modifier : `src/workflow/engine.ts:88-143` (`scanOpening`) et `:198-254` (`waitBeforeSessionMessage`)
- Modifier : `web/lib/campaign-eligibility.ts:91-140` et `:211` (miroirs manuels)
- Modifier : `src/http/v1-sends.ts:39` (`exigeFenetre24h`)
- Test : `tests/workflow-engine.test.ts`, `tests/web-campaign-eligibility.test.ts`

Chacune est une panne silencieuse distincte. Elles vont dans le même commit parce qu'elles ont la
même cause : un nouveau type de bloc qu'un `switch` non exhaustif traverse.

**`scanOpening`** : sans cas dédié, un bloc agent tombe dans la branche générique 138-140 (« bloc
synchrone, explorer la suite ») et est **traversé**. Un scénario « agent puis template » serait vu
comme ouvrant sur le template. La garde de campagne (`src/http/campaigns.ts:258-270`) l'accepterait,
la campagne demanderait de paramétrer ce template, et au lancement `walk` s'arrêterait sur le bloc
agent : le template ne partirait **jamais** alors que les destinataires seraient comptés touchés.
C'est le scénario « 500 envoyés, 0 message réel » que `StartOutcome` a été créé pour éviter.

**`waitBeforeSessionMessage`** : un montage « attente 2 jours puis agent » ne serait pas signalé,
alors que le premier message de l'agent est un message de session que Meta refusera à coup sûr.

**`v1-sends.ts:39`** : le commentaire du fichier le dit lui-même, « liste explicite plutôt qu'une
règle dérivée, le jour où un type de bloc s'ajoute, le compilateur ne dira rien mais ce commentaire
si ». Sans l'ajout, un envoi ciblant un bloc agent n'écarterait **aucun** destinataire hors fenêtre.

- [ ] **Étape 1 : écrire les tests qui échouent**

```ts
// tests/workflow-engine.test.ts
it('scanOpening : un bloc agent ouvre en message de SESSION et bloque l exploration', () => {
  const graph = {
    nodes: [
      { id: 'a', type: 'agent', position: { x: 0, y: 0 }, data: {} },
      { id: 't', type: 'template', position: { x: 1, y: 0 }, data: { templateName: 'promo' } },
    ],
    edges: [{ id: 'e', source: 'a', target: 't' }],
  };
  const out = scanOpening(graph, 'a');
  expect(out.sessionOpen).toBe(true);
  expect(out.firstTemplate).toBeUndefined();
});

it('waitBeforeSessionMessage : attente longue puis agent est signale', () => {
  const graph = {
    nodes: [
      { id: 'w', type: 'wait', position: { x: 0, y: 0 }, data: { delay: 2, unit: 'days' } },
      { id: 'a', type: 'agent', position: { x: 1, y: 0 }, data: {} },
    ],
    edges: [{ id: 'e', source: 'w', target: 'a' }],
  };
  expect(waitBeforeSessionMessage(graph, 'w')).toEqual({ waitNodeId: 'w', messageNodeId: 'a' });
});
```

Et dans `tests/v1-sends.test.ts`, un cas qui vérifie qu'un destinataire hors fenêtre ciblant un bloc
agent est écarté en `out_of_window`.

- [ ] **Étape 2 : lancer, ça doit ÉCHOUER**

```bash
npx vitest run tests/workflow-engine.test.ts tests/v1-sends.test.ts
```

- [ ] **Étape 3 : traiter `scanOpening`**

```ts
    if (node.type === 'agent') {
      // L agent envoie du texte libre : c est un message de SESSION (contrairement au RCS, qui
      // ouvre legalement a froid), et il BLOQUE l exploration puisque walk s y arrete.
      out.sessionOpen = true;
      continue;
    }
```

- [ ] **Étape 4 : traiter `waitBeforeSessionMessage`**

Le traiter comme `flow` et `quick_message` (lignes 218-230) : rendre
`{ waitNodeId: dernierWait, messageNodeId: id }` si le cumul dépasse la fenêtre, puis `continue`,
l'agent étant bloquant on n'explore pas au-delà.

- [ ] **Étape 5 : traiter `v1-sends.ts:39`**

```ts
  return type === null || type === 'quick_message' || type === 'flow' || type === 'agent';
```

- [ ] **Étape 6 : aligner les deux miroirs web**

`web/lib/campaign-eligibility.ts` est un miroir **manuel** dans un build qui ne partage aucun module
avec le serveur. Sans l'alignement, l'éditeur proposera en campagne un scénario que le serveur
refusera en 400. La parité est gardée par `tests/web-campaign-eligibility.test.ts:213-254`, mais sur
une **liste de cas écrite à la main** : elle ne cassera pas toute seule. Y ajouter au moins « bloc
agent seul », « agent puis template » et « attente longue puis agent ».

- [ ] **Étape 7 : relancer**

```bash
npx vitest run tests/workflow-engine.test.ts tests/v1-sends.test.ts tests/web-campaign-eligibility.test.ts && npx tsc --noEmit
```

- [ ] **Étape 8 : commit**

```bash
git add src/workflow/engine.ts src/http/v1-sends.ts web/lib/campaign-eligibility.ts tests/
git commit -m "fix(scenario): les quatre gardes que le bloc agent doit franchir

Meme cause pour les quatre : un switch non exhaustif traverse un type nouveau.

scanOpening : sans cas dedie, un scenario agent puis template serait vu comme ouvrant
sur le template. La campagne l accepterait, demanderait de le parametrer, et au
lancement walk s arreterait sur l agent : le template ne partirait jamais alors que
les destinataires seraient comptes touches.

waitBeforeSessionMessage : un montage attente 2 jours puis agent n aurait pas ete
signale, alors que le premier message de l agent est un message de session que Meta
refuse hors fenetre.

v1-sends : sans l ajout, un envoi ciblant un bloc agent n ecartait AUCUN destinataire
hors fenetre. Le commentaire du fichier annoncait deja ce piege.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

# Phase L1-B, les trois sites de couture, et un squelette qui marche

## Tâche 9 : le store des sessions — ✅ FAIT (commit 8d9a381, 2026-08-27)

`src/agent/session-store.ts` (contrat) + `.pg.ts` (implémentation). Les 10 tests d'intégration ont
réellement tourné en CI (vérifié dans le log du job, pas seulement au vert du run).

⚠️ **Trois écarts au plan, assumés :** (1) `coutMicroEur` en **`number`** et non `bigint` (le repo lit
ses colonnes bigint en string puis convertit, et `JSON.stringify` LÈVE sur un BigInt alors que ce champ
ira dans une réponse d'API) ; (2) **`tenantId` exigé par CHAQUE méthode**, y compris les trois que
l'interface du plan n'en dotait pas (pooler superuser, RLS bypassée, ce filtrage est le seul contrôle
d'isolation) ; (3) **pas de fake** pour l'instant, il gagnera sa place à la tâche 13 où il aura un vrai
consommateur (un fake testé contre lui-même ne prouve rien).

**Fichiers :**
- Créer : `src/agent/session-store.ts` (contrat) et `src/agent/session-store.pg.ts`
- Test : `tests/agent-session-store.test.ts` (unitaire, sur un fake) et
  `tests/integration/agent-session-store.int.test.ts` (Postgres, joué par la CI seulement)

**Interfaces :**
- Produit :

```ts
export interface AgentSession {
  id: string; tenantId: string; runId: string; agentId: string;
  nodeId: string; waId: string; tours: number; appelsOutils: number;
  coutMicroEur: bigint; status: 'en_cours' | 'sortie' | 'inactivite' | 'plafond' | 'erreur';
}

export interface AgentSessionStore {
  open(input: { tenantId: string; runId: string; agentId: string; nodeId: string; waId: string }): Promise<AgentSession>;
  byRun(tenantId: string, runId: string): Promise<AgentSession | null>;
  /** Verrou optimiste : incremente le tour SI et seulement si `tours` vaut `toursAttendus`.
   *  Rend null si la ligne n a pas bouge, ce qui vaut REJEU et doit faire sortir sans rien faire. */
  prendreLeTour(sessionId: string, toursAttendus: number): Promise<AgentSession | null>;
  ajouterAuTranscript(sessionId: string, entree: unknown): Promise<void>;
  clore(sessionId: string, status: AgentSession['status'], sortie?: string): Promise<void>;
}
```

- [ ] **Étape 1 : écrire le test du verrou optimiste, le seul qui compte**

```ts
// tests/integration/agent-session-store.int.test.ts
it('prendreLeTour rend null au second appel avec le meme numero de tour', async () => {
  const s = await store.open({ tenantId, runId, agentId, nodeId: 'n1', waId: '336' });
  const premier = await store.prendreLeTour(s.id, 0);
  expect(premier?.tours).toBe(1);
  const rejeu = await store.prendreLeTour(s.id, 0);
  expect(rejeu).toBeNull();
});

it('une seule session vivante par run', async () => {
  await store.open({ tenantId, runId, agentId, nodeId: 'n1', waId: '336' });
  await expect(store.open({ tenantId, runId, agentId, nodeId: 'n1', waId: '336' })).rejects.toThrow();
});
```

- [ ] **Étape 2 : lancer, ça doit ÉCHOUER (module absent)**

- [ ] **Étape 3 : implémenter `prendreLeTour` en une seule requête atomique**

```sql
update agent_sessions
   set tours = tours + 1, derniere_activite = now()
 where id = $1 and status = 'en_cours' and tours = $2
returning id, tenant_id, run_id, agent_id, node_id, wa_id, tours, appels_outils, cout_micro_eur, status
```

Zéro ligne rendue vaut rejeu. C'est la même mécanique que le `last_message_id` déjà en place sur
`workflow_runs`, et c'est ce qui rend un job d'inactivité différé inoffensif quand le contact a
répondu entre temps.

- [ ] **Étape 4 : relancer les tests d'intégration**

Ne pas les lancer en local. Pousser et lire le job `integration` de la CI.

- [ ] **Étape 5 : commit**

```bash
git add src/agent/session-store.ts src/agent/session-store.pg.ts tests/
git commit -m "feat(agent): le store de sessions et son verrou optimiste

pg-boss est at-least-once, et un job d inactivite differe peut se reveiller apres que
le contact a repondu. Le verrou est une seule requete : on incremente le tour si et
seulement si le compteur vaut celui que le job attendait. Zero ligne rendue vaut
rejeu, on sort sans rien faire.

Meme mecanique que le last_message_id de workflow_runs, et l unicite d une session
vivante par parcours est un index partiel, pas une convention.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Tâche 10 : la branche agent dans `advance` — ✅ FAIT (commit fd32eff, 2026-08-27)

⚠️ **L'ORDRE des deux écritures compte, et le fragment ci-dessous l'a à l'envers.** On enfile le tour
**AVANT** d'écrire `lastMessageId`. Si l'enfilage lève, l'exception est avalée par l'isolation par
message de `processWorkflowAdvance` et Meta reçoit un 200 : avec l'ordre inverse, `lastMessageId` est
déjà écrit, la redélivrance est dédupliquée, et le tour n'est **jamais** enfilé. Un test de garde le
verrouille. Trouvé en revue.

⚠️ **Trois écarts au fragment ci-dessous :** la branche est placée **APRÈS** le bloc de mesure (qui
distingue déjà clic et texte libre ; la refaire dans la branche aurait perdu la mesure d'un bouton) ;
**pas d'écriture au transcript ici**, car `advance` ne reçoit pas le texte du message et l'y ajouter
changerait la signature du chemin le plus chaud et ses 3 appelants (**à faire en tâche 13**, qui lira
la conversation en base : `recordInbound` tourne toujours avant `advance`) ; `this.mesurer` a une autre
signature que le fragment.

**Fichiers :** Modifier `src/workflow/executor.ts:867-978`. Test : `tests/workflow-executor.test.ts`.

**C'est le chemin le plus chaud du produit** : `advance` est appelé sur chaque message entrant de
chaque tenant, et il porte déjà la cicatrice de la régression du 2026-08-20 (bloc de doc lignes
851-866 : « le cas 3 remplace l'ancien repli sur la 1re arête sortante, qui envoyait non merci dans
la branche du bouton Oui »).

**Ce qui casse sans la branche, vérifié ligne par ligne.** `sortieTypee` (923-925) ne regarde que
`sent` et `unreachable`, donc il est faux pour un bloc agent. Deux issues, fatales toutes les deux :
si une arête libre part du bloc agent, `nextNodeSansHandle` la trouve et **le parcours saute
l'agent** dès le premier message du contact ; sinon `next` est null, le run est écrit
`{ currentNode: null, status: 'done' }` (948) et `rendreLaMainAMba` (954) envoie la conversation à
l'agent de Meta. Dans les deux cas la session reste `en_cours` en base, orpheline, et le job
d'inactivité se réveillera plus tard sur un run mort.

- [ ] **Étape 1 : écrire les trois tests qui échouent**

```ts
it('un message du contact sur un bloc agent enfile un tour au lieu de router', async () => {
  await executor.advance(tenantId, waId, 'wamid.1', undefined);
  expect(queue.enqueued.map((j) => j.name)).toEqual(['agent-turn']);
  expect(queue.enqueued[0]?.data).toMatchObject({ raison: 'message', nodeId: 'a' });
});

it('le parcours ne SAUTE PAS le bloc agent quand une arete libre en part', async () => {
  // graphe : agent 'a' -> quick_message 'b' par une arete SANS handle
  await executor.advance(tenantId, waId, 'wamid.1', undefined);
  expect(sendQuickMessage).not.toHaveBeenCalled();
  expect(runs.setState).toHaveBeenCalledWith('run1', expect.objectContaining({ currentNode: 'a', status: 'waiting' }));
});

it('persiste lastMessageId, sinon un rejeu empile deux fois le message', async () => {
  await executor.advance(tenantId, waId, 'wamid.1', undefined);
  await executor.advance(tenantId, waId, 'wamid.1', undefined);
  expect(queue.enqueued).toHaveLength(1);
});
```

- [ ] **Étape 2 : lancer, ça doit ÉCHOUER**

Le deuxième test observe précisément le saut silencieux du bloc.

- [ ] **Étape 3 : insérer la branche juste après la ligne 901**

Donc **après** la garde d'étanchéité des canaux et **avant** la mesure de la réponse. Attention :
la mesure `reply_text` des lignes 912-919 ne serait plus atteinte, il faut la faire dans la branche.

```ts
    if (courant?.type === 'agent') {
      const session = await this.deps.agentSessions?.byRun(tenantId, run.id);
      if (!session || session.status !== 'en_cours') {
        // Session absente ou close alors que le run pointe encore le bloc : etat incoherent.
        // On ne route pas au hasard, on remonte en inbox et on laisse une trace.
        console.error('[agent] run sur bloc agent sans session vivante', { runId: run.id });
        await this.deps.runs.setState(run.id, { currentNode: null, status: 'inbox', lastMessageId: messageId });
        await this.deps.escalateToHuman?.(tenantId, waId);
        return;
      }
      await this.mesurer(run, courant.id, 'reply_text');
      await this.deps.agentSessions.ajouterAuTranscript(session.id, { role: 'user', text: texte });
      // ATTENTION : setState ecrit current_node SANS coalesce (run-store.pg.ts:124). Passer
      // currentNode: null effacerait la position et le bloc agent serait perdu.
      await this.deps.runs.setState(run.id, {
        currentNode: run.currentNode,
        status: 'waiting',
        lastMessageId: messageId,
      });
      await this.deps.enqueueAgentTurn?.({
        tenantId, runId: run.id, sessionId: session.id,
        workflowId: run.workflowId, nodeId: courant.id, waId,
        raison: 'message', tours: session.tours,
      });
      return;
    }
```

- [ ] **Étape 4 : ajouter la dep optionnelle `enqueueAgentTurn`**

Sur `WorkflowExecutorDeps`, en suivant la convention déjà établie du fichier : `setOptIn`,
`recordNodeEvent`, `escalateToHuman`, `releaseToMba` et `emitTagAdded` sont tous **optionnels avec un
no-op documenté**, ce qui préserve les suites de tests à deps minimales, dont l'intégration Postgres.
Ne pas élargir `WorkflowRuntimeDeps.queue` (`wiring.ts:47-71`), qui est typée sans `opts` et ne sert
qu'à publier « tag ajouté ».

- [ ] **Étape 5 : relancer, les trois tests doivent PASSER**

```bash
npx vitest run tests/workflow-executor.test.ts && npx tsc --noEmit
```

- [ ] **Étape 6 : vérifier dans le sens de l'ÉCHEC**

Retirer la branche, constater que le test « ne saute pas le bloc agent » repasse au rouge en montrant
`sendQuickMessage` appelé. Remettre.

- [ ] **Étape 7 : lancer la suite ENTIÈRE, pas seulement le fichier touché**

```bash
npm test
```

Attendu : le même nombre de tests verts qu'à la référence de la tâche 1, plus les nouveaux. C'est le
chemin le plus chaud du produit : une régression ici casse **tous** les scénarios de **tous** les
clients, pas seulement ceux qui ont un agent.

- [ ] **Étape 8 : commit**

```bash
git add src/workflow/executor.ts tests/workflow-executor.test.ts
git commit -m "feat(agent): advance rend la main au tour d agent au lieu de router

Sans cette branche, un message du contact pendant une conversation d agent tombe dans
le routage normal, et sortieTypee ne connait que sent et unreachable. Deux issues,
fatales toutes les deux : une arete libre fait SAUTER le bloc agent des le premier
message, sinon le run est clos en done et la conversation part a l agent de Meta. Dans
les deux cas la session reste vivante et orpheline en base.

lastMessageId est persiste dans la branche : sans lui la dedup at-least-once ne protege
pas, et un rejeu empilerait deux fois le message avec deux appels LLM factures.

currentNode est repasse explicitement : setState ecrit current_node sans coalesce, un
null effacerait la position du parcours.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Tâche 11 : la branche agent dans `resume` — ✅ FAIT (commit b209d2b, 2026-08-27)

⚠️ **ORDRE INVERSE de celui de la tâche 10, délibérément.** Ici on enfile **APRÈS** l'écriture d'état.
Le claim du balayage est un **BAIL** : en cas d'échec avant `setState`, le run reste `sleeping` et
`resume` serait rejoué EN ENTIER (`walkResolved` + `apply`), donc **les messages déjà partis seraient
renvoyés**. Enfiler d'abord achèterait la reprise du job au prix de doublons chez le contact. Risque
résiduel assumé : la conversation se répare au message suivant du contact (tâche 10 retrouve la session
par `byRun`), seul le premier message spontané de l'agent est perdu.

Un helper privé **`demarrerTourAgent`** est écrit ici et **réutilisé par la tâche 12**. Il RÉUTILISE une
session vivante avant d'en ouvrir une (`open` lèverait sur l'index partiel, et l'échec emporterait tout
le réveil).

**Fichiers :** Modifier `src/workflow/executor.ts:489-582`. Test : `tests/workflow-executor.test.ts`.

Deuxième site. Un montage « attente puis agent » arrive ici : ligne 514, `walkResolved` part du
successeur du bloc Attente.

**Ordre obligatoire :** ouvrir la session **après** les sorties anticipées des lignes 561-565
(fenêtre fermée, remontée en inbox) et 569-577 (refus sans envoi, remontée en inbox). Ouvrir avant
ces `return` créerait une session vivante sur un run déjà clos, que rien ne nettoierait.

- [ ] **Étape 1 : écrire les deux tests**

Un montage « wait puis agent » qui réveille et enfile un tour `demarrage`. Et un montage identique
mais avec la fenêtre 24 h **fermée**, qui doit remonter en inbox **sans** ouvrir de session.

- [ ] **Étape 2 : lancer, ça doit ÉCHOUER**

- [ ] **Étape 3 : mapper le rest et ouvrir la session, après les sorties anticipées**

À la ligne 578, là où `setState` est appelé avec `restToState`, ajouter le traitement du cas
`agent_turn` : persister l'état (déjà fait par le cas explicite de la tâche 7), puis ouvrir la
session et enfiler le tour.

- [ ] **Étape 4 : relancer et vérifier dans les deux sens**

- [ ] **Étape 5 : commit**

```bash
git add src/workflow/executor.ts tests/workflow-executor.test.ts
git commit -m "feat(agent): resume ouvre la session quand un reveil atteint un bloc agent

Deuxieme des trois sites. L ouverture se fait APRES les sorties anticipees (fenetre
fermee, refus sans envoi), sinon on cree une session vivante sur un run deja clos que
rien ne nettoie.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Tâche 12 : la branche agent dans `runFrom`, et la garde de fenêtre — ✅ FAIT (commit ef80bd4, 2026-08-27)

⚠️ **La revue a trouvé DEUX trous que ce plan ne listait pas, tous deux réels.**

1. **`resume` (tâche 11) avait le même trou que `runFrom`** : « attente puis agent » **DIRECT**, fenêtre
   fermée, ouvrait la session. Le test de la tâche 11 ne l'attrapait pas (son montage avait un message
   rapide intercalaire qui déclenchait la garde à sa place). Corrigé, et le commentaire d'`engine.ts`
   qui affirmait une protection runtime inexistante a été rectifié.
2. **🔴 `advance` ne traitait pas la TRANSITION FRAÎCHE, et c'est le montage CENTRAL du produit.**
   « Template de campagne, puis l'agent reprend la main sur la réponse » : le run était posé sur le bloc
   agent **sans session ni tour**, **l'agent restait muet**, et l'anomalie n'apparaissait qu'au message
   suivant. Pas de garde de fenêtre à cet endroit : `advance` n'est déclenché que par un message
   entrant, et c'est la **parité** avec les blocs de session existants, pas un relâchement.

**Audit de clôture** : `walkResolved`, seule fonction capable de produire `agent_turn`, n'a que **trois**
appelants (`resume`, `runFrom`, `advance`), tous durcis. Aucun chemin résiduel.

**Noté hors périmètre** : `advance` est aussi appelé sur un accusé de livraison RCS, donc un montage
`rcs_message --(unreachable)--> bloc de session` atteindrait une transition fraîche sans fenêtre WhatsApp
prouvée. Trou **générique et préexistant** (vaut aussi pour `quick_message`/`flow`/`question`), bloqué en
campagne par `scanOpening`.

**Fichiers :** Modifier `src/workflow/executor.ts:678-742`. Test : `tests/workflow-executor.test.ts`.

Troisième site, et le cadrage ne le mentionnait pas. Trois choses ici.

**L'ordre est contraint par une clé étrangère.** Ligne 737, `runs.start` **crée** le run, et son
retour `{ id }` est aujourd'hui **jeté**. Or `agent_sessions.run_id` est une FK not null vers
`workflow_runs` : le run n'existe pas avant cette ligne. C'est ce qui interdit d'ouvrir la session
dans `walkResolved`. Ordre obligatoire : `apply`, puis `runs.start` en **capturant l'id**, puis
l'insert de session, puis l'enqueue.

**Et une garde de fenêtre à élargir, sinon on brûle des tokens pour rien.** Lignes 718-722, la garde
ne regarde que `actions.some(kind === 'sendFlow' || 'sendQuickMessage')`. Un rest `agent_turn` ne
produit **aucune** action : une campagne froide dont le scénario ouvre sur un agent **passe** la
garde, démarre un agent qui envoie du texte libre hors fenêtre, se fait refuser par Meta en 131047,
et brûle des tokens. Ajouter `|| rest.status === 'agent_turn'` à cette condition.

- [ ] **Étape 1 : écrire le test qui prouve la brûlure de tokens**

```ts
it('un demarrage hors fenetre sur un bloc agent est refuse AVANT d ouvrir la session', async () => {
  isWindowOpen.mockResolvedValue(false);
  const out = await executor.start(tenantId, waId, workflowId);
  expect(out).toBe('out_of_window');
  expect(queue.enqueued).toHaveLength(0);
  expect(sessions.open).not.toHaveBeenCalled();
});
```

- [ ] **Étape 2 : lancer, ça doit ÉCHOUER** (le démarrage passe et enfile un tour)

- [ ] **Étape 3 : élargir la garde de fenêtre ligne 718-722**

- [ ] **Étape 4 : capturer l'id du run et ouvrir la session dans le bon ordre**

- [ ] **Étape 5 : relancer, plus la suite entière**

- [ ] **Étape 6 : commit**

```bash
git add src/workflow/executor.ts tests/workflow-executor.test.ts
git commit -m "feat(agent): runFrom ouvre la session, et la garde de fenetre couvre le bloc agent

Troisieme des trois sites, absent du cadrage. L ordre est contraint par la FK :
agent_sessions.run_id pointe workflow_runs, et le run n existe qu apres runs.start,
dont le retour etait jusqu ici jete. D ou apply, puis start en capturant l id, puis
la session, puis l enqueue.

La garde de fenetre ne regardait que les actions produites. Un rest agent_turn n en
produit aucune : une campagne froide ouvrant sur un agent PASSAIT la garde, envoyait
du texte libre hors fenetre, se faisait refuser en 131047 et brulait des tokens.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Tâche 13 : le squelette qui marche, avec un cerveau bouchonné

⚠️ **COUPÉE EN DEUX.** 13a livre le contrat de cerveau, le cerveau bouchonné et `runTurn` avec ses huit
gardes, tout injecté et testable sans base ni réseau. **13b reste à faire** : la plomberie (store
d'agents pour les plafonds, lecture d'un run par son id, sortie du bloc par une branche) et
l'enregistrement du worker. Raison de sûreté : **câbler le worker avec un cerveau bouchonné ferait
répondre un agent déployé avec une réponse en dur.** On câble quand le vrai cerveau existe (tâche 14).

### 13a — ✅ FAIT (commit 877671d, 2026-08-27)

`src/agent/brain.ts`, `brain.fake.ts`, `run-turn.ts`, `tests/agent-run-turn.test.ts`. Diff **inerte en
production** (la file `agent-turn` n'a aucun consommateur, et aucun tenant ne peut router vers un bloc
agent, absent du builder). Reviewer PASS.

⚠️ **Bornes de plafond** : `>` pour les tours et les outils, `>=` pour le budget. Avec `>=`, un agent
réglé à `max_tours = 1` (valeur légale du CHECK 0086) ne pourrait **jamais** parler ; le budget, lui, est
une limite dont on ne connaît pas le coût du tour à l'avance. Un test de frontière ancre la sémantique.

⚠️ Le fragment de test ci-dessous est illustratif : `coutMicroEur` est un `number` (cf. tâche 9), et
`runTurn` prend `(job, deps)`.

### 13b — ✅ FAIT (commit cfb54f5, 2026-08-27), sauf le câblage du worker

`PgAgentStore` (plafonds de la fiche), `PgWorkflowRunStore.byId` (tous statuts : le tour doit distinguer
un run **mort** d'un run **introuvable**), et `sortirDuBlocAgent`. 7 tests d'intégration verts en CI.

La sortie **réutilise `advance`** avec un handle synthétique `sortie:<code>`, comme le font déjà
`rcsDelivered`/`rcsUndeliverable`, plutôt que de dupliquer le chemin de reprise. Deux gardes : une sortie
n'est ni **mesurée** comme une réponse du contact, ni **interceptée** par la branche agent. Audit du
reviewer : un contact **ne peut pas** forger ce préfixe (un texte libre rend toujours `buttonPayload:
null`, et tous les payloads de boutons/menus/carrousels sont réécrits par notre code à chaque envoi).

⚠️ Corrigé en revue : une sortie **non câblée** rendait la main à l'agent de Meta **en silence**. Elle
rejoint la liste des trous de montage (escalade + journalisation), comme un bouton non branché.

### Reste de la tâche 13 : le câblage du worker, DÉPLACÉ EN TÂCHE 14

Volontairement : brancher `queue.work(AGENT_TURN_QUEUE, ...)` maintenant ferait répondre un agent déployé
avec la phrase en dur du cerveau bouchonné. On câble avec le vrai cerveau, `retryLimit` à **2**, et
`parseAgentTurnJob` en entrée.

**Fichiers :**
- Créer : `src/agent/brain.ts` (contrat) et `src/agent/brain.fake.ts`
- Créer : `src/agent/run-turn.ts` (le tour, pur autant que possible)
- Modifier : `src/worker.ts` (enregistrement du worker `agent-turn`)
- Test : `tests/agent-run-turn.test.ts`

**Interfaces :**
- Produit :

```ts
export interface DecisionAgent {
  /** Texte a envoyer au contact. `null` = ne rien envoyer (cas escalade, le node aval parle). */
  texte: string | null;
  /** Code de sortie predefinie, ou null si l agent pose une question et attend. */
  sortie: string | null;
  usage?: { tokensIn: number; tokensOut: number; coutMicroEur: bigint };
}

export interface AgentBrain {
  penser(input: {
    agentId: string; tenantId: string; transcript: unknown[]; deadline: number;
  }): Promise<DecisionAgent>;
}
```

C'est un **squelette ambulant** : à la fin de cette tâche, le bloc agent tient le fil, répond, sort
par ses branches et respecte ses plafonds, avec un cerveau qui rend une réponse fixe. La tâche 14
remplace le fake par le vrai client LLM sans toucher au reste. C'est ce qui permet de dérisquer le
chemin chaud indépendamment du modèle.

**La garde qui rend tout tueur de run futur inoffensif.** Trois chemins tuent un run `waiting` sans
rien savoir des sessions d'agent : `closeActiveByWaId` (lancement manuel depuis l'inbox,
`src/index.ts:430`), `endWaitingRun` du jeton de test (`src/worker.ts:334-337`), et les clôtures
internes d'`advance` et de `resume`. Plutôt que de patcher les six sites, **le job relit le run par
son id et exige `status = 'waiting'` et `current_node = <nodeId du job>` avant tout envoi.** Une
seule garde, et tout tueur de run futur devient automatiquement sûr.

- [ ] **Étape 1 : écrire les tests du tour**

```ts
it('sort par sortie:plafond quand max_tours est atteint, jamais en silence', async () => {
  const out = await runTurn({ ...deps, session: { ...session, tours: 8 }, agent: { ...agent, maxTours: 8 } });
  expect(out.sortie).toBe('plafond');
  expect(brain.penser).not.toHaveBeenCalled();
});

it('n envoie RIEN si le run n est plus waiting sur le bloc agent', async () => {
  runs.byId.mockResolvedValue({ status: 'done', currentNode: null });
  await runTurn(deps);
  expect(sendQuickMessage).not.toHaveBeenCalled();
});

it('ne fait rien sur un rejeu, le verrou optimiste rend null', async () => {
  sessions.prendreLeTour.mockResolvedValue(null);
  await runTurn(deps);
  expect(brain.penser).not.toHaveBeenCalled();
  expect(sendQuickMessage).not.toHaveBeenCalled();
});

it('relit mayAct juste avant d envoyer, un operateur a pu prendre la main entre temps', async () => {
  mayAct.mockResolvedValue(false);
  await runTurn(deps);
  expect(sendQuickMessage).not.toHaveBeenCalled();
});
```

- [ ] **Étape 2 : lancer, ça doit ÉCHOUER**

- [ ] **Étape 3 : implémenter `runTurn` dans cet ordre exact**

1. `prendreLeTour(sessionId, tours)`, `null` vaut rejeu, sortir sans rien faire.
2. Relire le run : `status === 'waiting'` et `currentNode === nodeId`, sinon clore la session en
   `erreur` et sortir.
3. Vérifier les plafonds (`tours`, `appelsOutils`, `coutMicroEur`), tout dépassement sort par
   `sortie:plafond`.
4. `brain.penser(...)` sous un `AbortSignal.timeout(30_000)`.
5. Relire `mayAct` juste avant d'envoyer.
6. Envoyer via la même dep que le reste du scénario, donc `DRY_RUN` honoré et journalisation dans
   le fil.
7. Mesurer `sent` ou `failed` sur le nodeId du bloc.
8. Si `sortie` est null : enfiler le tour d'inactivité différé (tâche 17). Sinon clore la session et
   reprendre le scénario par `sortie:<code>`.

- [ ] **Étape 4 : enregistrer le worker dans `src/worker.ts`**

Avec `queue.work(AGENT_TURN_QUEUE, ...)`, `retryLimit` à **2** (mieux vaut une conversation qui sort
par `sortie:echec` avec le message de repli du client qu'une conversation qui reçoit trois fois la
même relance), et le `parseAgentTurnJob` de la tâche 4 en entrée.

- [ ] **Étape 5 : relancer, tous les tests doivent PASSER**

```bash
npx vitest run tests/agent-run-turn.test.ts && npm test && npx tsc --noEmit
```

- [ ] **Étape 6 : commit**

```bash
git add src/agent/ src/worker.ts tests/agent-run-turn.test.ts
git commit -m "feat(agent): le tour d agent, avec un cerveau bouchonne

Squelette ambulant : le bloc tient le fil, repond, sort par ses branches et respecte
ses plafonds, avec un cerveau qui rend une reponse fixe. Le vrai client LLM le
remplacera sans toucher au reste, ce qui derisque le chemin chaud independamment du
modele.

Une seule garde plutot que six correctifs : trois chemins tuent un run waiting sans
rien savoir des sessions (lancement manuel depuis l inbox, jeton de test, clotures
internes). Le job relit le run et exige waiting sur SON bloc avant tout envoi, donc
tout tueur de run futur est automatiquement sur.

mayAct est relu juste avant l envoi, pas seulement a l entree du tour : entre
l enfilage et l execution du job, un operateur a pu prendre la main.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

# Phase L1-C, le vrai cerveau

## Tâche 14 : le client Chat Completions — ✅ FAIT (commit 4306a50, 2026-08-27)

Le corps de réponse des tests est celui **réellement observé** lors d'un appel live au Gateway
(2026-08-27), pas une recopie de doc. `LlmApiError` déplacée en `src/llm/errors.ts` et ré-exportée depuis
son ancien emplacement (une seule classe, `instanceof` reste vrai, aucun import cassé). `HttpTransport`
gagne un 4e paramètre optionnel `signal` : les six `FakeTransport` du repo restent assignables (vérifié).

⚠️ **Dette D1** (registre en tête de plan) : le Gateway facture en **dollars**, la colonne de budget est en
micro-euros. Décision de facturation, à trancher avant la mise en service.

**Fichiers :**
- Créer : `src/llm/errors.ts` (déplacement de `LlmApiError`, ré-exportée depuis `llm-client.ts`)
- Créer : `src/agent/llm/chat-client.ts`
- Modifier : `src/meta/http.ts:1-10` (ajout d'un `signal` optionnel)
- Test : `tests/agent-chat-client.test.ts`

**Verdict : second contrat, pas une extension.** `LlmClient` est
`complete(prompt): Promise<string>` : le seul canal de sortie est le texte, donc il ne peut porter ni
`usage`, ni `tool_call`, ni `finish_reason`. `AnthropicClient.complete` **jette** déjà tout bloc non
texte. L'élargir imposerait de toucher deux fakes de test et deux consommateurs pour un besoin
qu'aucun d'eux n'a. Précédent maison à recopier : `src/rcs/channel-info.ts:1-8` déclare une interface
`HttpGet` locale plutôt que d'élargir `HttpTransport`.

Ne **pas** étendre `createLlmClient` non plus : le modèle y est une constante de boot
(`config.LLM_MODEL`), alors que le modèle d'un agent est une colonne lue par ligne, et
`LLM_PROVIDER: z.enum(['anthropic'])` a été posé exprès par l'audit pour refuser un provider inconnu
**au boot**.

**Le format, vérifié sur la doc Vercel datée du 2026-07-28.** `POST https://ai-gateway.vercel.sh/v1/chat/completions`,
en-tête `Authorization: Bearer <clé>`. Le tableau `tools` porte le schéma **sous `function.parameters`**
(forme Chat Completions, différente de Responses). La réponse porte `usage` **à la racine** en
snake_case, et `provider_metadata.gateway` **sur le message** (`choices[0].message`), avec `cost` en
**chaîne décimale de dollars**, hors surcharges.

- [ ] **Étape 1 : écrire le test sur un `FakeTransport`**

Vérifier que le corps envoyé porte bien `tools[].function.parameters`, que `usage` est lu à la
racine, que `provider_metadata.gateway.cost` est lu sur le message, et qu'un 400 est **terminal**
alors qu'un 429 est rejouable.

- [ ] **Étape 2 : lancer, ça doit ÉCHOUER**

- [ ] **Étape 3 : ajouter le `signal` à `HttpTransport`**

```ts
post(url: string, body: unknown, headers: Record<string, string>, opts?: { signal?: AbortSignal }): Promise<HttpResponse>;
```

Vérifié : une implémentation qui ne déclare que trois paramètres reste assignable, donc les **six**
`FakeTransport` existants ne cassent pas. Aujourd'hui l'appel n'a **aucun** timeout, le défaut undici
est de l'ordre de 300 s : un Gateway qui pend immobilise un slot de worker pendant des minutes, sans
trace.

- [ ] **Étape 4 : implémenter le client**

Réutiliser `withRetry`, mais **toujours avec des options explicites** :
`{ maxRetries: 2, baseDelayMs: 250, maxDelayMs: 2000 }`. Les défauts sont `maxRetries: 4` et
`maxDelayMs: 30000`, et la ligne 108 dort jusqu'à **30 secondes** sur un seul 429 portant un
`Retry-After` long : avec une deadline de tour de 30 s, la seule attente de retry la consomme
entièrement. `withRetry` n'a aucune notion de deadline murale, elle doit venir de l'`AbortSignal`.

Taxonomie, en recopiant `llm-client.ts:58` et en y ajoutant 408 et 425 comme le fait
`src/meta/errors.ts:23` : `retryable = status === 429 || status === 408 || status === 425 || status >= 500`.
Un 400 (schéma d'outil refusé), un 401 (clé), un 403 (`no_providers_available`) et un 404 (modèle
inconnu) sont **terminaux** : les rejouer paierait quatre fois la même erreur de configuration.

- [ ] **Étape 5 : relancer et vérifier**

- [ ] **Étape 6 : commit**

---

## Tâche 15 : le schéma d'outil envoyé au modèle — ✅ FAIT (commit d55763a, 2026-08-27)

La garde a été auditée ligne à ligne par la revue : **aucun chemin** n'expose un paramètre `contact` ou
`fixe`, y compris avec une `source` d'une autre casse, absente, ou inventée (l'égalité est stricte, et
toute valeur non reconnue rejette l'entrée entière plutôt que de la traiter comme exposée).

⚠️ **Écart au plan** : les deux nettoyages demandés (bruit `minimum`/`maximum` de `z.number().int()`, et
`$schema`) supposaient une dérivation depuis Zod. **Le repo n'en a aucune** (`zod-to-json-schema` absent,
vérifié) : le schéma est construit directement, donc le bruit n'existe pas par construction. Un test
d'ancrage empêche qu'une future dérivation le réintroduise en silence.

⚠️ **À GARDER EN TÊTE POUR LA TÂCHE 16**, relevé par la revue : au moment de l'exécution, le runtime
fusionne les valeurs du modèle avec celles injectées (`contact`, `fixe`). Il faut garantir qu'**un
paramètre rempli par le modèle ne peut jamais écraser une valeur injectée**, sinon la garde de ce module
serait contournée à l'étape suivante. Ce n'est pas un défaut ici (fonction pure, sans état), c'est le
point de vigilance du tronc commun.

### Le détail d'origine

**Fichiers :** Créer `src/agent/llm/tool-schema.ts` (fonction pure). Test : `tests/agent-tool-schema.test.ts`.

Dérive `agent_tools.params` (source `modele` **seulement**) vers le JSON Schema. Deux nettoyages
mesurés à faire : `z.number().int()` émet `minimum: -9007199254740991 / maximum: 9007199254740991`,
du bruit payé à chaque tour, et `$schema` n'est attendu par aucun fournisseur.

**C'est ici que le modèle perd la main sur la cible.** Les paramètres de source `contact` et `fixe`
n'entrent **jamais** dans ce schéma : ils sont injectés par le runtime à l'étape 4 du tronc commun.
Un test doit le prouver explicitement.

- [ ] **Étape 1 : écrire le test, dont le cas de sécurité**

```ts
it('n expose au modele QUE les parametres de source modele', () => {
  const s = toolParamsToJsonSchema([
    { name: 'reference', type: 'string', source: 'modele', required: true, description: 'la reference' },
    { name: 'wa_id', type: 'string', source: 'contact', required: true, description: 'le numero', contactPath: 'wa_id' },
  ]);
  expect(Object.keys(s.properties)).toEqual(['reference']);
  expect(s.required).toEqual(['reference']);
});
```

- [ ] **Étape 2 à 5 :** échouer, implémenter, passer, commit.

---

## Tâche 16 : le tronc commun d'exécution d'outil, et les outils maison — ✅ FAIT (commit dd776a2, 2026-08-27)

**Deux revues, deux FAIL avant le PASS**, et la seconde a trouvé le trou le plus sérieux du lot : la garde de
source (tâche 15) **se contournait par une déclaration cassée**. Si `agent_tools.params` porte un paramètre en
`source: 'modele'` ET une seconde entrée du MÊME nom en `contact` mais mal formée (type absent), la coercion
écartait la seconde, la première restait exposée, validée, et **plus rien ne venait l'écraser à l'injection** :
le modèle reprenait la main sur la cible, c'est-à-dire l'IDOR exact que le module existe pour fermer. La
réservation des noms se fait désormais sur le **brut**, avant coercion, dans `paramsOutil`.

Corrigé au passage, dans le même lot (règle zéro dette) : `catalogue.byName` était le seul `await` capable de
tuer le tour ; le compteur d'appels n'avançait ni sur un délai dépassé ni sur un résolveur qui lève, c'est-à-dire
sur les deux issues les plus chères ; `envoyerBlocDepuisAgent` acceptait un sous-parcours contenant une
**attente** (tout ce qui suit ne partait jamais, en silence, alors qu'on répondait « envoyé » au modèle) ;
`borner` comptait des caractères contre un plafond en octets ; l'escalade n'était qu'une interface documentée.

**Écarts au plan, assumés :**
- **Deux fichiers de plus que prévu.** `src/agent/catalog.ts` (les contrats catalogue + journal) et
  `src/agent/escalade.ts`. Ce dernier ne fait que TRENTE lignes et n'apporte qu'une chose, l'ordre des trois
  effets, mais c'est justement ce que le plan demandait de garantir : un test l'ancre par égalité stricte.
- **Un sous-parcours qui rend la main est refusé, il n'est pas rattrapé.** Le plan prévoyait d'attraper le
  23505 de l'index unique. On refuse **avant tout envoi** sur les repos `agent_turn`, `inbox`, `sleeping`,
  `rcs_send` et `waiting` à échéance : même garantie, déterministe, sans dépendre d'une erreur de base.
- **L'escalade ne clôt pas depuis le résolveur.** Le résolveur appelle une dep qui ordonne clore -> sortir ->
  basculer, et rend `rendu: true`. L'ordre est contre-intuitif et vérifié : `advance` sort en premier sur
  `mayAct`, donc basculer le fil AVANT de sortir du bloc rendrait la sortie inopérante.

🔴 **Dette D3** (registre en tête de plan) : `executeTool` n'a aucun appelant. L'alerte sur `fatal`, le calcul
des plafonds restants et l'encadrement du résultat en bloc délimité reviennent à la tâche de câblage.

### Le détail d'origine

**Fichiers :** Créer `src/agent/executor.ts`, `src/agent/resolvers/mba.ts`, `src/agent/catalog.pg.ts`.
Test : `tests/agent-tool-executor.test.ts`.

**Règle centrale : `execute` ne lève jamais.** Une exception qui remonte tue le tour, alors que le
modèle sait se corriger sur une erreur d'exécution. C'est la leçon de hyundai, où un slug inconnu
renvoie `{ erreur: "slug inconnu, utilise un slug du catalogue" }` et où le modèle se rattrape seul.
Seule exception : une erreur de protocole, qui est un bug de notre client, arrête le tour et est
alertée.

Les huit étapes du tronc commun sont en §3.3 du cadrage. Deux points à ne pas rater.

**L'autonomie sur une action irréversible est un réglage du client** (tranché le 2026-08-26). L'étape
2 du tronc commun ne refuse donc pas `risk = 'irreversible'` en bloc : elle lit un drapeau posé outil
par outil dans la console, par un administrateur. Trois choses restent non négociables autour, et
elles ne dépendent pas de ce drapeau : les identifiants sont en `source: 'contact'` donc le modèle ne
peut pas désigner la ressource d'un autre, chaque appel entre dans `agent_tool_calls` avec ses
arguments rédigés, et la case est réservée aux administrateurs par le RBAC existant.

**L'autorisation se relit en base à l'exécution**, `where tenant_id = $1 and agent_id = $2 and actif`.
Filtrer ce qu'on envoie au modèle n'est pas un contrôle : `vercel/ai#8653` documente exactement le cas
où le filtrage d'exposition marchait pendant que l'exécuteur tapait dans le catalogue complet.

**`mba_envoyer_bloc` ne doit pas passer par `startFromNode`.** Piège majeur : `startFromNode` passe
par `runFrom`, qui **crée un run** dès que le rest n'est pas `done`. On obtiendrait deux runs
`waiting` pour le même contact, et `findWaitingByWaId` ne rend que le plus récent : le run de l'agent
deviendrait orphelin **pour toujours**, et rien ne nettoie un `waiting`. L'outil doit faire un `walk`
plus `apply` borné **sans persister de run**. Si le bloc visé reboucle sur le même bloc agent,
l'insert de session échouerait en 23505 sur l'index unique : à attraper et à rendre au modèle comme
un refus, jamais à laisser remonter.

**L'escalade doit clore la session, pas seulement basculer le détenteur.** Piège non mentionné au
cadrage : une conversation tenue par `app_human` est **rendue automatiquement** au scénario par
`runControlSweep` (`src/worker.ts:682-708`) après `CONTROL_HUMAN_TIMEOUT_MS`. Si l'outil se contente
de basculer `control_owner`, alors l'humain traite, le balayage rend la main, le message suivant
repasse `mayAct`, et **l'agent reprend la conversation qu'un humain avait récupérée**. Silencieux et
très désagréable côté client. L'outil doit appeler `escalateToHuman` (`wiring.ts:288`, avec son
`only: ['app_workflow']` qui évite d'écraser une prise de main concurrente), **et** clore la session,
**et** sortir le run du bloc agent.

- [ ] **Étape 1 : écrire les tests, dont les trois pièges ci-dessus**

- [ ] **Étape 2 à 6 :** échouer, implémenter, passer, vérifier dans les deux sens, commit.

---

## Tâche 16bis : la recherche dans la base de connaissance, et `sortie:sans_source` — ✅ FAIT (commit 962a044, 2026-08-28)

🔴 **La leçon de cette tâche, et elle vaut au-delà.** La première version faisait exactement ce que le plan
demandait : classer par `ts_rank_cd`, comparer le rang à un seuil en code. La revue a montré que **ce seuil
ne pouvait jamais se déclencher** : `ts_rank_cd` a un plancher arithmétique (poids D = 0,1, soit 0,0909 après
normalisation) et l'opérateur `%` un autre (0,3), donc toute ligne rendue par le SQL était au-dessus d'un
seuil de 0,05. Le filtre réel était le `where`, un OR sur les termes : **un seul mot commun suffisait** à
livrer une fiche au modèle, ce qui est précisément le trou que cette tâche existe pour fermer.

**Et aucun test ne pouvait le voir**, parce que tous les tests du seuil fabriquaient le score. Règle à
retenir : **une garde chiffrée se prouve là où le nombre est PRODUIT**, pas là où on le simule. Ici, ça veut
dire en intégration, contre un vrai Postgres, avec un corpus qui ressemble à une vraie base de connaissance.

**Écart au plan, assumé et nécessaire :** on ne mesure plus un rang. Un rang dit « à quel point ça ressort » ;
on mesure maintenant **combien de termes signifiants de la question se retrouvent dans la fiche**, ce qui
répond à la seule question posée : « ai-je une source pour CETTE question ». Trois raisons d'accepter, chacune
explicable en une phrase à un client (`ficheEstPertinente`, `src/agent/knowledge.ts`) : deux mots communs au
moins, ou une question si courte que la fiche en couvre la moitié, ou un titre très proche au trigramme (la
faute de frappe). Ce qui reste vrai quoi qu'il arrive, et qui porte la garantie : une question sans le moindre
mot commun ne fait remonter **aucune** fiche.

Corrigé dans le même lot : index `(tenant_id, agent_id)` manquant sur `agent_knowledge` (la migration 0086
n'étant pas appliquée, elle a été complétée) ; le seuil trigramme dépendait d'un GUC serveur et vient
désormais de notre code ; le plafond de termes coupait le sujet d'une question bavarde (doublons retirés
avant) ; la requête et le corps des fiches n'étaient bornés par personne.

### Le détail d'origine

**Fichiers :** Modifier `src/agent/resolvers/mba.ts` (nouvel outil maison), créer
`src/agent/knowledge.pg.ts` (la requête). Test : `tests/agent-knowledge.test.ts`.

**C'est le mécanisme anti-hallucination**, et il est déterministe. On ne demande jamais au modèle de
juger s'il sait : on le rend incapable de répondre hors de ses sources.

**L'outil maison `mba_chercher_connaissance`** interroge `agent_knowledge` du tenant courant
(`ts_rank_cd` sur `corps_tsv`, complété par `similarity()` de `pg_trgm` pour les requêtes courtes) et
renvoie les fiches les mieux classées **avec leur score maximal, calculé en code**. Le tenant est
toujours `tenant_id = $1` (rôle superuser, RLS bypassée, le filtrage en code est le seul contrôle).

**Le seuil est en code, jamais dans le raisonnement du modèle.** Si le score maximal est sous un seuil
(constante, ou réglage tenant plus tard), l'outil rend un résultat structuré `{ aucune_source: true }`
par le tronc commun (§3.3, jamais une exception), et le tour fait **sortir le node par le handle
`sortie:sans_source`**, réservé au même rang que `timeout`, `sortie:plafond`, `sortie:echec`. Le
client câble ce handle vers le transfert humain ou le renvoi aux coordonnées. C'est ça, et rien
d'autre, qui fait marcher « l'agent ne sait pas, donc il transfère ».

- [ ] **Étape 1 : écrire les tests, dans les deux sens.** Une question couverte par une fiche : score
  au-dessus du seuil, l'agent répond depuis la fiche. Une question hors sujet : score sous le seuil,
  résultat `aucune_source`, sortie par `sortie:sans_source`, **jamais** une réponse inventée. Vérifier
  que remettre le seuil à zéro casse le second test (preuve que la garde tient).
- [ ] **Étape 2 à 6 :** échouer, implémenter, passer, vérifier dans les deux sens, commit.

---

## Tâche 17 : l'inactivité — ✅ FAIT (commit ebf5cb2, 2026-08-28)

Le pari du plan tient : **aucun mécanisme nouveau**. Le tour rend `timeoutInMs` dans son repos, `restToState`
n'est pas touchée, et tout le reste (run `waiting` porteur d'un `resume_at`, `claimDueQuestions`, `resume` par
le handle `timeout`) était déjà écrit et en production pour le bloc Question.

🔴 **Mais rendre ce chemin possible a ouvert deux trous, tous deux trouvés en revue.**

**1. Une session d'agent orpheline, pour toujours.** Avant cette tâche, un run posé sur un bloc agent n'avait
jamais de `resume_at` : le balayeur ne le voyait pas, donc `resume` n'était JAMAIS appelé dessus. La tâche 17
rend ce chemin atteignable, et `resume` tue un run par trois sorties, dont deux qui ne closaient rien. La plus
probable est même la première : un opérateur reprend le fil depuis l'Inbox, le contact se tait, l'échéance
tombe, `mayAct` répond faux, le run meurt et la session reste `en_cours` à jamais. Elle serait alors
RÉUTILISÉE si le scénario repasse un jour sur un bloc agent (`byRun ?? open`), avec ses tours et son coût déjà
consommés : un agent muet dès le premier tour. La règle posée n'est donc pas « une échéance sur un bloc agent
clôt sa session » mais **« `resume` qui tue un run clôt la session vivante de ce run »**, en `inactivite` quand
c'est une échéance consommée, en `erreur` sinon.

**2. Le tour pouvait RESSUSCITER un run tué pendant qu'il réfléchissait.** L'écriture finale du tour était un
`setState` inconditionnel, 3 à 30 secondes après la lecture. Un opérateur qui lance un scénario depuis
l'Inbox appelle `closeActiveByWaId` : le run passe `done`, un autre naît, et le tour remettait le premier en
`waiting` AVEC une échéance. Invisible de `findWaitingByWaId` (le nouveau est plus récent), mais parfaitement
visible du balayeur, qui aurait déclenché plus tard la branche « pas de réponse » d'un parcours fermé exprès,
en parallèle du nouveau. D'où `setStateSiEncoreSur`, l'écriture conditionnelle : c'est le pendant, côté
écriture, de la garde que le tour applique déjà en lecture.

**Écarts au plan :** `lirePlafonds` devient `lireFiche` (le tour a besoin de l'inactivité en plus, et
`FicheAgent` porte déjà les deux : deux lectures de la même ligne n'avaient pas lieu d'être). L'échéance est
posée aussi quand la main est perdue, sans quoi un fil repris par un humain qui ne revient jamais laisserait
run et session en plan. La raison de tour `inactivite` est retirée : elle n'a plus de producteur depuis que
l'inactivité passe par le bloc Question, et un vocabulaire sans producteur finit remis en service par erreur.

### Le détail d'origine

**Fichiers :** Modifier `src/agent/run-turn.ts`. Test : `tests/agent-inactivite.test.ts`.

**Révisée le 2026-08-26 : il n'y a plus de mécanisme à écrire.** Le bloc Question a apporté
exactement ce qu'il fallait, et l'agent monte dessus.

Quand le tour se termine sans sortie prédéfinie, c'est-à-dire quand l'agent a posé une question et
attend, le tour rend l'échéance dans le repos :

```ts
{ status: 'waiting', nodeId, timeoutInMs: agent.inactiviteMinutes * 60_000 }
```

Le reste est déjà écrit et en production : `restToState` traduit `timeoutInMs` en `resume_at` sur un
run qui **reste** `waiting`, `claimDueQuestions` le réclame en **consommant** l'échéance
(`resume_at = null`, `for update skip locked`), le balayeur de réveil le reprend, et `resume` sort
par le handle **`timeout`**. Même nom de handle que le bloc Question, délibérément : un seul
vocabulaire dans le builder.

Deux conséquences à respecter, tirées de leur code.

**On ne reprend jamais par `nextNode` sur une échéance.** Leur commentaire le dit et vaut mot pour
mot pour l'agent : « le successeur d'une question n'a aucun sens, c'est la réponse qui décide de la
suite. Prendre `nextNode` ici enverrait un contact silencieux dans la branche du premier câblage
venu. » Si la sortie `timeout` n'est pas câblée, on clôt le parcours **et on rend la main**, parce
que l'agent la retenait.

**La course résiduelle est assumée et bornée.** Si le contact répond dans les quelques centaines de
millisecondes qui suivent la réclamation, `advance` et la reprise avancent le même parcours et le
contact reçoit deux messages. L'ordre inverse est sûr : `advance` réécrit l'état sans `resume_at`.
L'arbitrage est déjà pris et il tient pour nous.

- [ ] **Étape 1 : écrire le test des deux sens**

```ts
it('un tour sans sortie pose l echeance d inactivite dans le repos', async () => {
  const out = await runTurn({ ...deps, agent: { ...agent, inactiviteMinutes: 30 } });
  expect(out.rest).toEqual({ status: 'waiting', nodeId: 'a', timeoutInMs: 30 * 60_000 });
});

it('une echeance de zero ne pose AUCUN resume_at, l agent attend sans limite', async () => {
  const out = await runTurn({ ...deps, agent: { ...agent, inactiviteMinutes: 0 } });
  expect(out.rest).toEqual({ status: 'waiting', nodeId: 'a' });
});

it('la reprise sur echeance sort par le handle timeout, jamais par nextNode', async () => {
  // graphe : agent 'a' -> 'suivant' par une arete SANS handle, plus 'fin' par le handle timeout
  await executor.resume({ ...run, currentNode: 'a', status: 'waiting' });
  expect(runs.setState).toHaveBeenCalledWith('run1', expect.objectContaining({ currentNode: 'fin' }));
});
```

Le deuxième test est celui qui compte : `restToState` n'écrit `resume_at` que si `timeoutInMs` est
**défini**, et un `0` transmis au lieu d'un champ absent poserait une échéance immédiate. C'est le
même piège que `startAfter: 0` et `max: 0` déjà documenté deux fois dans `src/queue/pgboss.ts`.

- [ ] **Étape 2 : lancer, ça doit ÉCHOUER**

- [ ] **Étape 3 : implémenter, en réutilisant `restToState` sans le modifier**

- [ ] **Étape 4 : relancer, plus la suite entière**

- [ ] **Étape 5 : commit**

```bash
git add src/agent/run-turn.ts tests/agent-inactivite.test.ts
git commit -m "feat(agent): l inactivite monte sur l echeance du bloc Question

Aucun mecanisme nouveau. Le bloc Question fait deja attendre un run sur deux choses a
la fois, une reponse du contact et le temps qui passe : le run reste waiting, donc
findWaitingByWaId le voit, et il porte en plus un resume_at que le balayeur consomme.
L agent rend simplement timeoutInMs dans son repos.

Meme nom de handle que le bloc Question, timeout, plutot qu une sortie a nous : un
seul vocabulaire dans le builder.

Une echeance de zero ne pose AUCUN resume_at. Le test le verifie explicitement : un 0
transmis au lieu d un champ absent poserait une echeance immediate, c est le piege
deja documente deux fois dans src/queue/pgboss.ts.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

# Phase L1-D, le front

## Tâche 18 : le bloc agent dans le builder — ✅ FAIT (commit 796b0b4, 2026-08-28)

🔴 **Le bug que la revue a trouvé, et il tenait en deux clics.** Un bloc agent SANS agent est un passe-plat
(décision de la tâche 7 : rendre la main à un agent qui n'existe pas figerait le parcours). Il suivait
`nextNode`, c'est-à-dire la PREMIÈRE arête sortante, tous handles confondus. Or on peut choisir un agent,
câbler ses sorties, puis remettre le sélecteur sur « choisir un agent » : tous les contacts partaient alors
dans la première branche du tableau, typiquement « échec technique », sans le moindre signal. Le passe-plat
suit désormais une arête LIBRE seulement, exactement comme le bloc Condition, et le builder EMPORTE les
arêtes des sorties disparues quand on change d'agent, comme le fait déjà la suppression d'une ligne de menu.

🔴 **Une sortie que la plateforme emprunte n'était dessinée nulle part** : `sortie:humain`, celle de l'outil
d'escalade. Elle était donc incâblable, et son issue réelle aurait été l'escalade en inbox avec un log
d'erreur. `sorties.ts` gagne `SORTIE_HUMAIN` et `SORTIE_TIMEOUT` (ce dernier vivait en littéral dans
l'exécuteur), et le test de parité front/serveur les ancre tous les cinq.

**Écart au plan, assumé :** le plan ne listait que deux fichiers front, mais un bloc dont on ne peut pas
choisir l'agent n'est pas constructible. On ajoute donc la LECTURE (`GET /tenants/:id/agents`, admin comme le
builder qu'elle sert) et son store. L'écriture reste la tâche 19.

**Design :** les sorties d'un bloc sont de deux familles. Les réservées, toujours dessinées. Et les règles
d'arrêt du client, qui vivent sur la fiche et sont COPIÉES dans le bloc au moment du choix, ce qui rend le
graphe auto-suffisant (le moteur route sans relire la table des agents). La copie peut ensuite diverger de la
fiche : un encart le signale dans le panneau, avec un bouton pour rafraîchir, jamais automatiquement.

⚠️ **Pour la tâche 19, relevé par la revue.** `fiche.sorties` est un contrat de données posé ici, sans schéma
(`ficheAgentSchema` n'existe pas encore) et sans lien avec la source runtime réelle des codes, qui est
l'énumération du paramètre `sortie` de l'outil `terminer` (`agent_tools.params`). **La surface qui édite les
règles d'arrêt doit écrire les DEUX d'un seul geste**, sinon on rejoue la divergence que ce lot combat. En
attendant, `listActifs` rend `sorties: []` pour tout le monde, puisque rien n'écrit encore `fiche.sorties`.

### Le détail d'origine

**Fichiers :** Modifier `web/lib/nodeMeta.ts`, `web/components/WorkflowBuilder.tsx`.
Test : `web/e2e/` (une spec nouvelle).

Quatre points côté builder : `NODE_META` et `NODE_ORDER`, `initialDataFor`, `summaryOf`,
`ConfigPanel`.

Reprendre le patron du **bloc conditionné** déjà en place pour RCS et l'email
(`WorkflowBuilder.tsx:598-624`) : rendu à part, grisé et non cliquable tant qu'aucun agent n'est
configuré, avec un `title` explicatif. Et le patron des **sorties multiples par handle nommé**, déjà
utilisé pour les boutons de template et pour `sent` / `unreachable` de `rcs_message` : chaque règle
d'arrêt devient un handle, plus les réservés `timeout` (inactivité, même nom que le bloc Question),
`sortie:plafond`, `sortie:echec`, et `sortie:sans_source` (l'agent n'a trouvé aucune source, il sort).

- [ ] **Étape 1 à 6 :** spec e2e qui échoue, implémentation, passage, commit.

## Tâche 19 : le groupe « AI Agent » et les deux surfaces d'édition

**Cette tâche est trop grosse pour un lot, et elle est découpée.** Elle demande trois choses de tailles très
différentes : un groupe de navigation, un écran de réglage à sept onglets, et une IA de construction qui
remplit la fiche en discutant. La dernière est une feature à elle seule (appel modèle, sortie structurée,
écriture validée dans la fiche). Découpage, dans l'ordre où chaque tranche débloque la suivante :

| Tranche | Contenu | État |
|---|---|---|
| **19a** | Groupe de nav « AI Agent », CRUD serveur de la fiche, écran de réglage (identité et ton, objectif et transferts, périmètre et garde-fous, modèle), activation | ✅ FAIT (commit 6dca192, 2026-08-28) |
| **19b** | Onglet base de connaissance : les fiches, leur édition, le scraping cadré | ✅ FAIT (commit e9e2c73, 2026-08-28) |
| **19c** | Onglet outils : `agent_tools`, l'activation par un humain, le drapeau d'autonomie | ✅ FAIT (commit c978e69, 2026-08-28) |
| **19d** | La surface de construction conversationnelle (l'IA de setup) | ✅ FAIT (commit fa32a18, 2026-08-28) |
| **19e** | Onglet tester : parler à l'agent depuis la console avant de l'activer | à faire |

### Tranche 19d : la surface de construction conversationnelle -- ✅ FAIT (commit fa32a18, 2026-08-28)

**Livré :** `src/agent/setup/` (le schéma de proposition et le diff, l'assemblage des messages, le lint), la
route `src/http/agent-setup.ts`, l'onglet `web/components/AgentConstruction.tsx`, et le premier câblage réel
du Vercel AI Gateway (`AI_GATEWAY_API_KEY`, `AGENT_SETUP_MODEL`).

🔴 **LE DÉFAUT LE PLUS GRAVE DU LOT ENTIER A ÉTÉ TROUVÉ ICI, ET IL DATAIT DE LA TRANCHE 19a.**

`ficheAgentSchema.partial()` NE REND PAS un objet partiel. `.partial()` rend le champ optionnel, mais le
`.default()` qui est DESSOUS s'applique quand même à l'absence : un `{objectif}` ressortait en fiche ENTIÈRE,
chaque autre champ rempli par son défaut. Écrit ensuite par la fusion jsonb (`fiche || $n::jsonb`), il n'y
avait plus aucune clé absente à protéger. **Enregistrer l'objectif effaçait le ton, la personnalité et TOUTES
les règles d'arrêt, sans la moindre erreur.**

C'est exactement le défaut que la revue de 19a croyait avoir fermé par la fusion plus le verrou de version.
La correction ne fermait pas le cas, et rien ne pouvait le voir : le formulaire renvoie toujours la fiche
entière. Il a fallu une surface qui écrit PAR PETITES TOUCHES pour le faire sortir.

`fiche.ts` porte maintenant `ficheAgentSchema` (lecture, avec défauts) et `fichePatchSchema` (patch,
optionnel SANS défaut), construits sur des champs communs. Le piège est ancré par un test qui affirme le
MAUVAIS comportement de `.partial()`, pour qu'on n'y retombe pas. Les deux autres usages de `.partial()` du
dépôt portent sur des schémas sans défaut : ils ne sont pas concernés.

⚠️ **La leçon, générale.** Un correctif qui vise un défaut se vérifie sur le défaut LUI-MÊME, pas sur le
mécanisme qu'on lui oppose. La tâche 19a a testé la fusion et le verrou (qui marchent), jamais « un patch
partiel laisse-t-il vraiment les autres clés tranquilles » (qui ne marchait pas).

🔴 **Le défaut de cette tranche, trouvé par la revue : le lint se calculait sur l'état PÉRIMÉ.**

Le corps d'un `PATCH` peut porter `contenu` ET `status: 'active'` ensemble, et le store applique les deux
d'un coup. Linter l'état lu en base laissait donc vider l'objectif et activer l'agent dans la MÊME requête,
c'est-à-dire contourner la garde en un appel. C'est une règle déjà écrite dans le `CLAUDE.md` du dépôt
(« une garde de validation se calcule sur l'état EFFECTIF après écriture, `patch ?? courant` »), posée après
un défaut du même genre sur la garde anti-boucle de l'analyse de conversation. Corrigé, et testé dans les
DEUX sens : vider et activer ensemble est refusé, combler et activer ensemble passe (le second compte autant,
c'est ce que fera l'assistant quand il proposera d'activer après une proposition).

**Les cinq garde-fous du cadrage §5.9, et où ils vivent.**

1. **Ce que l'assistant peut écrire est ÉNUMÉRÉ** (`propositionSchema`) : la fiche et les mots des outils
   maison. Ni la mention légale d'IA, ni les plafonds, ni le modèle, ni le risque d'un outil, ni son
   ACTIVATION. Écarté par `safeParse` sans faire échouer le tour : un modèle qui renvoie du bruit n'obtient
   rien, il ne casse pas la conversation.
2. **Aucune écriture silencieuse.** La route n'écrit RIEN. Elle rend une proposition et le diff qu'elle
   produirait ; l'écriture passe par le `PATCH` et les routes d'outils, avec leurs verrous.
3. **Le contexte part en bloc délimité**, et le contenu ne peut pas recréer le délimiteur. L'assistant lit ce
   que le SITE du client a écrit (les fiches de la tranche 19b).
4. **Le lint bloque l'activation**, sur des champs vides et jamais sur une qualité sémantique.
5. **Le chat n'est jamais le seul chemin d'édition** : les six onglets de formulaire restent là.

**Trois décisions de fond.**

**L'assistant ne propose PAS de fiches de connaissance.** Une base de connaissance doit contenir ce que le
client dit vraiment. Laisser un modèle en écrire retournerait le mécanisme anti-hallucination contre
lui-même : l'agent citerait comme source une phrase inventée au moment du réglage.

**La conversation n'est pas persistée.** Le client porte l'historique, le serveur relit la fiche à chaque
tour. Pas de table de plus, et la synchronisation avec le formulaire est gratuite. Un admin pourrait forger
un faux tour d'assistant : sans conséquence, il a déjà le droit d'écrire la fiche en direct.

**Le modèle de l'IA de construction est SÉPARÉ de celui de l'agent** (`AGENT_SETUP_MODEL`). Celle-ci tourne
rarement et joue le rôle le plus dur ; celui-là répond à chaque message d'un contact.

🟡 **Les trois autres constats de la revue, corrigés.** L'application d'une proposition compose deux écritures
sans transaction : un échec après que la fiche est écrite le DIT maintenant, et l'écran relit l'agent même en
cas d'échec (sans quoi un second essai se faisait refuser en 409 sur un numéro de version périmé, pour une
raison sans rapport avec la cause). Le même outil proposé deux fois est refusé. Et les MOTS ACTUELS des
outils déjà posés partent dans le contexte, sans quoi le modèle réinventait une description que le client
avait soignée.

### Tranche 19c : l'onglet outils -- ✅ FAIT (commit c978e69, 2026-08-28)

**Ce que ça débloque.** `agent_tools` restait vide, donc l'agent ne pouvait ni terminer par une sortie, ni
escalader, ni envoyer un bloc, ni chercher dans sa base de connaissance. Tout le lot 16 était écrit et
inatteignable.

**Livré :** le catalogue déclaratif `src/agent/outils-maison.ts` (les sept outils, miroir de `HANDLERS` dans
`resolvers/mba.ts`), le `ToolAdminStore` sur `PgToolCatalog`, les six routes de `src/http/agent-tools.ts`, et
l'onglet `web/components/AgentOutils.tsx`.

🔴 **LA RÈGLE QUE CETTE TRANCHE DEVAIT HONORER, et elle tient.** L'énumération du paramètre `sortie` de
l'outil `terminer` DÉRIVE de `agents.fiche.sorties` au moment de construire le schéma, et n'est jamais écrite
en base (`paramsInitiaux` la retire, `outilExpose` la pose). Une énumération qu'on écrirait quand même dans
`agent_tools.params` est ignorée : la fiche fait autorité, seule. C'est le relevé de la revue de la tâche 18,
fermé ici. Vérifié dans les deux sens : retirer la dérivation casse cinq tests.

**Trois décisions de fond.**

**Le client choisit dans un CATALOGUE, il ne compose pas un outil.** Le comportement vient de
`binding.handler`, et les seuls handlers qui existent sont ceux du résolveur maison. Une console qui
laisserait écrire un handler quelconque produirait un outil ACTIF, exposé au modèle, qui refuse à chaque
appel : le client verrait un agent qui « ne fait rien », sans aucune trace lisible. Le titre, les mots, les
paramètres et le RISQUE viennent donc du serveur ; le client compose le nom, les mots et les valeurs
autorisées là où le catalogue lui en laisse.

**`mba_envoyer_bloc` est déclaré IRRÉVERSIBLE.** Un message parti chez un contact ne se rappelle pas, et il
est facturé. Le tronc commun refuse alors l'appel tant que le client n'a pas coché l'autonomie sur cet outil.
C'est ce qui rend ce drapeau vivant dès L1, au lieu d'un réglage qui n'aurait servi qu'aux familles HTTP et
MCP. ⟶ à confirmer par Julien : si l'envoi de bloc doit être libre par défaut, c'est une ligne à changer.

**Une dérivation VIDE retire l'outil, elle ne l'expose pas sans énumération.** Un `terminer` offert sans
valeurs possibles accepterait n'importe quelle chaîne : le modèle en inventerait une, le bloc n'aurait pas ce
handle, et la conversation remonterait en inbox sans explication. La distinction avec une liste vide REMPLIE
PAR LE CLIENT (les tags autorisés) est nette : là, vide veut dire « aucune restriction ».

🔴 **Le défaut que la revue a trouvé, et il ne touchait même pas cette tranche en apparence.**

**`on delete set null` NE SUFFIT PAS quand la table cible porte un `check` sur la colonne mise à null.**
`agent_tools.active_par` référence `users` en `on delete set null`, et la migration 0086 exige
`actif = false or active_par is not null`. L'action référentielle est une écriture ORDINAIRE, soumise au
check : supprimer un collaborateur qui avait activé un outil encore actif faisait échouer TOUT le `delete`
en `23514`, donc un 500, donc une page Cloudflare sur un geste d'offboarding parfaitement légitime. Le cas
était inerte jusqu'ici parce que rien n'écrivait jamais `active_par` ; c'est cette tranche qui le rend
atteignable. `deleteUser` passe en transaction : il éteint les outils que ce compte avait mis en service,
puis supprime, et fait `rollback` si la suppression est refusée (un refus ne doit rien laisser d'éteint).

⚠️ **La leçon, générale.** Le commentaire de 2026-07-18 de `store.pg.ts` disait « toute nouvelle FK vers
`users` doit déclarer son comportement de suppression ». C'était juste et insuffisant : une FK
`on delete set null` PLUS un `check` sur la même colonne casse quand même. La règle complète est donc : une FK
vers `users` doit déclarer son comportement de suppression **et** ce comportement doit rester compatible avec
les contraintes de la table qui la porte.

🟡 **Les trois autres constats de la revue, corrigés dans le même lot.** `normaliserNomOutil` rendait `_` sur
une saisie sans caractère alphanumérique, que la règle du serveur accepte : le champ aurait enregistré « _ »
comme nom d'outil exposé au modèle (et le test qui prétendait couvrir ce cas ne pouvait pas échouer). Le
PATCH des énumérations n'était pas borné aux paramètres que le catalogue ouvre. Et `/autonomie` n'avait pas
le test d'usurpation d'identité que `/activation` avait déjà.

### Tranche 19b : l'onglet base de connaissance -- ✅ FAIT (commit e9e2c73, 2026-08-28)

**Ce que ça débloque.** `agent_knowledge` restait vide pour toujours, donc `mba_chercher_connaissance`
(tâche 16bis) ne trouvait rien, donc TOUS les parcours d'agent seraient sortis par `sortie:sans_source`. Le
garde-fou anti-hallucination existait sans que personne puisse lui donner de quoi travailler.

**Livré :** le CRUD serveur (`KnowledgeAdminStore` dans `src/agent/knowledge.ts`, son implémentation dans
`knowledge.pg.ts`, les cinq routes admin dans `src/http/agent-knowledge.ts`), l'extracteur pur
`src/agent/scrape.ts`, l'onglet `web/components/AgentConnaissance.tsx`, et la garde de fraîcheur
`web/lib/agent-connaissance.ts`.

**Trois décisions de fond, chacune prise pour une raison qui n'est pas de confort.**

**Le découpage d'une page en fiches est une GARDE, pas une commodité de lecture.** La recherche mesure
« combien de termes de la question se retrouvent dans la fiche ». Une page avalée d'un bloc contient à peu
près tous les mots du site : elle serait pertinente pour n'importe quelle question, et `sortie:sans_source`
ne tomberait plus jamais. C'est le seul endroit du lot où l'extraction HTML a une conséquence de sûreté, et
c'est pour ça qu'elle est testée à ses bornes.

**Relire une source REMPLACE ses fiches.** Ajouter doublerait la base à chaque passage, et deux copies d'une
même fiche ne rendent pas la réponse plus sûre, elles la rendent deux fois plus probable qu'une autre. Le
prix (les corrections faites sur les fiches de cette adresse partent avec) est dit dans l'écran AVANT le clic.
Écart assumé avec `MbaFaqImportPanel`, qui impose un « analyser puis confirmer » en deux temps : là-bas le
résultat part chez Meta et n'est plus visible, ici les fiches s'affichent juste en dessous, éditables et
supprimables une par une. Un aperçu n'apporterait rien que la liste ne montre déjà.

**L'alerte de fraîcheur se calcule sur `updated_at`, la date AFFICHÉE sur `derniere_lecture_at`.** Les deux
disent des choses différentes : la seconde est la provenance, la première dit qu'un humain est passé. Corriger
une fiche à la main EST une vérification ; sans cette distinction, l'écran réclamerait une relecture d'une
fiche que quelqu'un vient de relire, et l'avertissement finirait par ne plus rien vouloir dire.

🟡 **Les quatre constats de la revue, tous corrigés dans le même lot.**

1. **La garde de FORME d'identifiant avait tué une couverture de test.** En ajoutant `estUuid` aux routes
   d'agents, les trois tests « agent inconnu » (qui appelaient `/agents/inconnu`) ne touchaient plus le
   `if (!agent) return 404` derrière : ils ne prouvaient plus que la nouvelle garde. Un uuid valide mais
   absent du store les remet sur le bon chemin, et un test séparé couvre la forme.
2. **Le plafond de fiches par page était calculé, transporté, typé, et jamais montré.** Une page tronquée à
   40 fiches se taisait : l'admin lisait « 40 fiches écrites » et croyait que toute sa page était devenue une
   source. L'agent aurait ensuite transféré sur des questions que la page couvrait, sans explication possible.
3. **Le plafond de titre était recopié en littéral dans le schéma de la route**, alors que celui du corps
   était importé, précisément pour éviter qu'un titre produit par l'import ne soit plus modifiable à la main.
   `MAX_TITRE` est maintenant exporté et importé comme `MAX_CORPS`, et le test de parité vérifie la DÉRIVATION
   (que la route importe les constantes), pas seulement l'égalité des valeurs.
4. **`modifier` et `supprimer` ne contrôlaient que le tenant, pas l'agent.** L'adresse
   `/agents/:agentId/knowledge/:ficheId` promettait un périmètre que la requête ne tenait pas : ce n'était pas
   un IDOR entre clients, mais un identifiant mal aiguillé par l'écran aurait corrigé en silence la fiche d'un
   AUTRE agent du même client. Le couple (tenant, agent) est désormais le périmètre partout.

**Deux modules partagés posés au passage** (inscrits dans `documentation.md` §Modules partagés) :
`src/lib/page-distante.ts` (la garde SSRF et la lecture bornée, extraites de `src/http/mba.ts` où l'import de
FAQ les avait écrites : un module de route n'est pas un point de passage) et `src/http/scope.ts -> estUuid`.

**19a fait de l'agent une chose qui EXISTE.** Avant elle, la table `agents` était vide pour toujours et la
brique du builder restait grisée quoi qu'on fasse : c'était le vrai blocage.

🔴 **Les deux défauts que la revue a trouvés, et ils touchaient le même endroit.**

**Le patch de la fiche REMPLAÇAIT tout.** Un `PATCH {contenu:{objectif}}` écrasait la fiche entière, parce que
le schéma Zod remplissait chaque champ absent par son défaut. Deux onglets ouverts suffisaient : l'un ajoute
une règle d'arrêt, l'autre enregistre l'objectif depuis son état périmé, et la règle disparaît sans erreur. Or
le plan exige que le formulaire et la surface conversationnelle cohabitent sur la même fiche. Le patch est
donc devenu une **fusion** (`fiche || $n::jsonb`, qui protège les clés qu'on ne touche pas) **plus un verrou
optimiste** sur `fiche_version` (qui protège celles qu'on touche, en refusant en 409 au lieu d'écraser).

**Un label en double rendait un 500**, donc une page Cloudflare, sur un geste aussi banal que créer deux
agents du même nom. L'index unique de la migration 0086 est maintenant traduit en 409, et une route DELETE
existe : sans elle, un agent mal nommé ne pouvait être ni renommé vers un nom occupé, ni retiré.

**Écart au plan, assumé :** l'activation vit sur la FICHE, agent par agent, et non sur un interrupteur
d'accueil comme l'agent de Meta. Meta n'a qu'un agent par workspace ; ici il y en a plusieurs, et « activé »
veut dire « proposable dans un scénario », pas « répond à tout ».

### Le détail d'origine

**Fichiers :** Créer `web/app/agents/page.tsx`, `web/lib/api-agent.ts`. Modifier
`web/components/AppShell.tsx` (le groupe de nav et l'icône). C'est de l'UI, donc hors feature-loop :
tâche d'ensemble, pas de TDD ligne à ligne.

**Le groupe de navigation « AI Agent ».** La barre latérale gagne un groupe qui rassemble les deux
répondeurs que le client peut faire parler : l'agent Meta (les deux entrées MBA existantes, guide et
paramètres, qui gardent leurs URL) et **Other AI agent**, le nôtre. Contrainte connue : le modèle de
nav (`AppShell.tsx`) n'a **qu'un niveau d'enfants**, donc le groupe est plat. Le groupe `mba` actuel
disparaît au profit de celui-ci.

**Les deux surfaces d'édition, sur la même fiche.** Un seul agent, deux entrées :

- **La construction en parlant** (l'IA de construction, version minimale livrée avec L1 : mandat,
  connaissance, règles d'arrêt et de transfert, modèle, outils maison), qui écrit dans la fiche.
- **L'écran de réglage classique**, à onglets, calqué sur celui de l'agent Meta d'aujourd'hui, qui
  montre **dans les bonnes cases** tout ce que la conversation a rempli, éditable champ par champ.
  Onglets : identité et ton, objectif et transferts, base de connaissance (les fiches), outils,
  périmètre et garde-fous, modèle, tester.

Les deux sont **toujours accessibles** (temps 1 comme temps 2) et **synchronisées** : ce que le chat
produit apparaît dans les cases, ce qu'on change dans les cases est repris par le chat. Objectif : que
le client comprenne et corrige sans réinterroger l'IA. C'est le §1bis « Deux surfaces d'édition » du
cadrage, rendu concret.

Suivre le patron de tout écran authentifié : `request` depuis `web/lib/http.ts` comme `api-mba.ts`,
style et bilinguisme par `web/lib/ui.ts` et `web/lib/i18n.tsx`. L'activation reprend trait pour trait
le patron de l'agent Meta (interrupteur sur l'accueil, admin seulement), en gardant le sens propre au
mot « activé » (prêt à servir dans les scénarios, pas « répond à tout »).

- [ ] **Étape 1 à 6 :** spec e2e qui échoue, implémentation, passage, commit.

---

# Après L1

**L'action irréversible est tranchée** (2026-08-26) : l'autonomie est un réglage du client, outil par
outil, par une case réservée aux administrateurs. La tâche 16 est donc débloquée. L'outil passe quand
même par le tronc commun, les identifiants restent en `source: 'contact'`, et chaque appel est
journalisé avec ses arguments rédigés. Contrepartie assumée : la responsabilité se déplace vers le
tenant qui coche, ce qui doit être écrit dans les conditions.

Une décision reste ouverte et ne bloque que la suite : MCP en allowlist de serveurs validés ou en URL
libre par tenant (D3, §8 du cadrage). Le solde à zéro (D2) a été **requalifié le 2026-08-27** : le
prépayé par tenant est notre grand livre, la sortie propre est donc entièrement dans notre code, rien
à négocier avec le Gateway.

Côté vérifications : l'appel live au Gateway est **fait** (2026-08-27, `usage.cost` et
`provider_metadata.gateway.cost` présents), le modèle économique n'attend plus rien. Reste à cadrer le
texte primaire Meta sur la clause « AI Providers » avant d'ouvrir en grand, mais c'est commercial, pas
un bloquant technique.
