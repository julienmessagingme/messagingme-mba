# Tester un scénario depuis un node précis

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal :** un bouton lecture sur chaque bloc du constructeur, qui donne un lien wa.me et un QR démarrant le
scénario **à ce bloc**, sur le brouillon, sans passer par un envoi de template.

**Architecture :** le jeton de test existant (`test-` + 8 caractères, un par scénario) gagne un suffixe qui
désigne le bloc (`test-abc12345.0f7c9a21-4d3e-4b18-9a55-1c2e3f4a5b6c`). Le graphe joué est **figé dans le parcours** au démarrage, ce qui
répare au passage un défaut existant. Le bouton réutilise le panneau QR déjà présent dans la même page.

**Tech Stack :** TypeScript, Fastify, Postgres (pg-boss), Next.js, React Flow, vitest, Playwright.

**Spec :** ce document. Les décisions ont été arrêtées avec Julien le 2026-09-16 par deux tours de grilling ;
elles sont reproduites ci-dessous et font foi.

## Ce qui existe déjà, mesuré dans le code avant d'écrire ce plan

| Pièce | État |
|---|---|
| Jeton de test par scénario | ✅ `src/workflow/test-token.ts`, `test-` + 8 car. Crockford, stable |
| Lien wa.me + QR | ✅ panneau dans `web/app/workflows/page.tsx` (QR calculé dans le navigateur) |
| Déclenchement par le jeton | ✅ `src/webhooks/test-token.ts`, AVANT l'avance et les automations |
| Marquage « fil de test » | ✅ sort de l'analyse, du push HubSpot et des statistiques |
| Démarrer à un bloc ARBITRAIRE | ✅ `WorkflowExecutor.startFromNode`, déjà utilisé par `/v1/sends` |
| Jouer le BROUILLON au démarrage | ✅ `startTestRun` appelle `grapheEditable(wf)` |
| Enregistrement auto du brouillon | ✅ `useEnregistrementScenario` dans le constructeur |
| Purge des parcours terminés | ✅ `purgeTerminesOlderThan` : rien à inventer pour la rétention |

🔴 **ET UN DÉFAUT EXISTANT, TROUVÉ EN CARTOGRAPHIANT.** Le test DÉMARRE sur le brouillon
(`startTestRun` passe `grapheEditable(wf)`), mais il REPREND sur le publié : `runEnAttenteSur` et les deux
autres points de reprise appellent `this.deps.getGraph(...)`, que le câblage résout en `?.graph`. Un test qui
atteint un bloc d'attente et reçoit une réponse **change donc de version en cours de route**, en silence. Si
le bloc courant n'existe pas dans le publié, `graph.nodes.find(...)` rend `undefined` et le parcours se fige
sans un mot. La tâche 1 ferme ce trou, et c'est elle qui justifie le figeage plutôt qu'un simple drapeau.

## Les décisions de Julien, et ce qu'elles écartent

1. **Le jeton porte le bloc en suffixe** (`test-abc12345.<identifiant du bloc>`), pas un jeton par bloc stocké, pas les
   identifiants en clair à la UChat. Le secret reste celui du scénario ; le suffixe n'est qu'un pointeur.
2. **Le brouillon, figé dans le parcours au démarrage.** L'exécuteur partagé ne voit jamais un brouillon,
   donc aucun défaut ne peut en servir un à un vrai client.
3. 🔴 **RIEN sur les étapes sautées.** Décision explicite : « si on saute des étapes parce que la personne a
   décidé de tester qu'un bout du scénario, et bien tant pis ! il ne se passe rien ». Pas de liste des tags
   non posés, pas de bouton de nettoyage de fiche, pas d'avertissement. Le panneau reste le QR et le lien.
4. **Tous les blocs** portent le bouton, le bloc d'entrée compris.
5. **Un parcours en cours est terminé**, et on repart à ce bloc. C'est déjà le comportement du test existant.
6. **Le lien est permanent**, et un bloc disparu donne un refus lisible.

⚠️ **CE QUI N'ÉTAIT PAS UN PROBLÈME, et qu'il ne faut pas « réparer »** : les variables. `{{prenom}}` sortira,
parce que `buildEvalContext` lit la FICHE du contact (`fields`, `tags`, nom, téléphone) et qu'aucune variable
n'appartient au parcours (`workflow_runs` n'a pas de colonne de variables). Vérifié avant d'écrire ce plan.

## Global Constraints

- `git commit --only <chemins>`, JAMAIS `git add` puis un commit nu : une autre session partage ce `.git`.
- Aucun tiret cadratin ni demi-cadratin, nulle part.
- `tenant_id = $1` sur CHAQUE requête : la RLS est contournée, ce filtrage est le seul contrôle.
- `safeParse`, jamais `parse` ni `as`, sur toute entrée non fiable.
- Un message destiné à l'utilisateur sort en 4xx, jamais en 5xx (Cloudflare remplace les corps 5xx).
- **Prochaine migration libre : 0151.** ⚠️ Le compteur de `CLAUDE.md` est la seule source, et il se relit EN
  BASE juste après `migrate`, jamais après avoir écrit le fichier SQL.
- Une migration qui AJOUTE une colonne écrite par le code passe AVANT le déploiement.
- Verdict CI lu job par job (`gh run view <id> --json jobs`), jamais sur `gh run watch --exit-status`.
- 🔴 Ne JAMAIS lancer `npm run test:integration` en local : le `DATABASE_URL` du `.env` pointe sur la PROD.

## File Structure

| Fichier | Responsabilité |
|---|---|
| `db/migrations/0151_run_graphe_fige.sql` | **Créé.** La colonne qui porte le graphe figé d'un parcours de test |
| `src/workflow/test-token.ts` | **Modifié.** La forme du jeton s'ouvre au suffixe de bloc ; nouvelle lecture `lireJetonDeTest` |
| `src/workflow/run-store.pg.ts` | **Modifié.** Écrire et relire `graphe_fige` |
| `src/workflow/executor.ts` | **Modifié.** Figer au démarrage, préférer le figé à la reprise |
| `src/webhooks/test-token.ts` | **Modifié.** Transmettre le suffixe de bloc à `startTestRun` |
| `src/worker.ts` | **Modifié.** Résoudre le bloc dans le brouillon, démarrer là, figer |
| `web/components/WorkflowNode.tsx` | **Modifié.** Le bouton lecture, en haut à gauche de chaque bloc |
| `web/components/WorkflowBuilder.tsx` | **Modifié.** Le contexte qui porte le rappel de test |
| `web/app/workflows/page.tsx` | **Modifié.** Le panneau existant accepte un bloc |
| `tests/workflow-test-token-node.test.ts` | **Créé.** La forme du jeton et sa lecture |
| `tests/workflow-graphe-fige.test.ts` | **Créé.** Le figeage et la préférence à la reprise |

---

## Méthode de livraison

**Implémenteur par lot + revue humaine sur le DIFF.**

**Pourquoi celle-là**, contre les trois autres, en répondant aux quatre questions d'arbitrage :

1. **La production emprunte-t-elle ce chemin ?** OUI, deux fois. Le jeton est lu sur CHAQUE message entrant
   (`looksLikeTestToken` est le filtre du chemin chaud), et l'exécuteur touché est celui qui sert les vrais
   clients.
2. **Est-ce réversible ?** NON entièrement. Un test qui démarre envoie de VRAIS messages WhatsApp facturés et
   peut poser de vrais tags sur une vraie fiche. Un message parti ne se rappelle pas.
3. **Les critères sont-ils testables ?** Oui pour la forme du jeton et le figeage ; **non pour le bouton**,
   dont le seul critère réel est « le bon message arrive sur mon téléphone ».
4. **Le code porte-t-il des invariants invisibles ?** OUI, et c'est le point décisif : le filtre du chemin
   chaud (un jeton élargi ne doit pas faire interroger la base à chaque message client), la garde `mayStart`,
   le marquage « fil de test » qui sort la conversation des statistiques, et la règle « un contact réel ne
   tombe jamais dans un brouillon ».

Deux « oui » en haut de la liste imposent la revue humaine. ⚠️ **Pas de feature-loop** : son critère de sortie
est la complétude, et ici le critère qui compte est qu'aucun brouillon n'atteigne un client, ce qui ne se lit
pas dans une suite verte. ⚠️ **Pas de workflow multi-agents** : trois tâches sur un seul chemin.

**Chaque tâche est un commit**, testée par MUTATION dans les deux sens, et le diff est relu par Julien avant
la suivante.

### 🔴 L'essai réel qui clôt cette feature

Aucun test ne le remplace, et Julien peut le faire lui-même (c'est son propre numéro qui teste) :

1. **Cliquer le bouton d'un bloc AU MILIEU d'un scénario**, scanner le QR, envoyer : c'est **ce message-là**
   qui doit arriver, pas le premier du scénario.
2. **Modifier le brouillon SANS publier**, recliquer le même bloc : le test doit suivre la modification.
3. **Atteindre un bloc d'attente et répondre** : le parcours doit continuer sur le BROUILLON, pas sur le
   publié. C'est la vérification du défaut existant, et celle qu'aucun test unitaire ne peut faire.
4. **Cliquer un bloc d'un scénario publié SANS brouillon en attente** : ce cas ne doit rien casser.

---

## Task 1 : le graphe figé dans le parcours

**Files:**
- Create: `db/migrations/0151_run_graphe_fige.sql`
- Modify: `src/workflow/run-store.pg.ts` (le `select` des colonnes, et la création d'un run)
- Modify: `src/workflow/executor.ts` (`runFrom`, `runEnAttenteSur`, et les deux autres `getGraph`)
- Test: `tests/workflow-graphe-fige.test.ts`

**Interfaces:**
- Consomme : `WorkflowRunRow` (`src/workflow/run-store.pg.ts`), `WorkflowGraph` (`src/workflow/types.ts`).
- Produit : `WorkflowRunRow.grapheFige: WorkflowGraph | null` et l'option
  `runFrom(..., opts: { figerLeGraphe?: boolean })`, consommées par la tâche 2.

- [ ] **Step 1 : écrire la migration**

```sql
-- 0151_run_graphe_fige.sql : le graphe JOUÉ par un parcours de test, figé à son démarrage.
--
-- 🔴 ELLE RÉPARE UN DÉFAUT EXISTANT, ET PAS SEULEMENT LA NOUVELLE FONCTIONNALITÉ. Le test DÉMARRE sur le
-- brouillon (`startTestRun` passe `grapheEditable(wf)`) mais il REPREND sur le publié : les trois points de
-- reprise de l exécuteur appellent `getGraph`, que le câblage résout en `row.graph`. Un test qui atteint un
-- bloc d attente et reçoit une réponse change donc de version EN SILENCE, et si le bloc courant n existe pas
-- dans le publié, le parcours se fige sans un mot.
--
-- 🔴 NULLABLE, ET LE DÉFAUT EST `null`. Un parcours réel n en porte AUCUN : figer le graphe de chaque
-- destinataire d une campagne de 5 000 personnes recopierait 5 000 fois le même objet. `null` = on lit le
-- publié, c est-à-dire exactement le comportement d aujourd hui pour tout ce qui n est pas un test.
--
-- ⚠️ AUCUN INDEX, délibérément : cette colonne ne sert jamais un `where`, elle se lit par la clé primaire du
-- parcours qu on vient de trouver. Un index dessus ne servirait aucune requête, et son absence dit au
-- prochain lecteur que personne ne cherche par ce champ.
--
-- ⚠️ RIEN À PURGER EN PLUS : `purgeTerminesOlderThan` supprime les parcours terminés, et le graphe figé part
-- avec eux.

alter table workflow_runs add column if not exists graphe_fige jsonb;
```

- [ ] **Step 2 : appliquer et RELIRE la base**

```bash
npm run migrate
```

Puis relire (et non supposer) : `select name from public.schema_migrations order by name desc limit 3` doit
rendre `0151_run_graphe_fige` en tête, et `information_schema.columns` doit donner `graphe_fige` en `jsonb`
nullable sur `workflow_runs`. Mettre à jour le compteur de `CLAUDE.md` APRÈS cette relecture, jamais avant.

- [ ] **Step 3 : écrire le test qui échoue**

```ts
import { describe, it, expect } from 'vitest';
import { WorkflowExecutor } from '../src/workflow/executor';

const GRAPHE_BROUILLON = { nodes: [{ id: 'n-brouillon', type: 'message' as const, data: { text: 'version brouillon' } }], edges: [] };
const GRAPHE_PUBLIE = { nodes: [{ id: 'n-publie', type: 'message' as const, data: { text: 'version publiee' } }], edges: [] };

describe('le graphe figé d’un parcours de test', () => {
  it('🔴 la REPRISE joue le graphe FIGÉ, pas le publié', async () => {
    // Le défaut d'avant : le démarrage jouait le brouillon, la reprise relisait le publié, donc un test
    // changeait de version au premier bloc d'attente, en silence.
    const lu: string[] = [];
    const run = { id: 'r1', workflowId: 'w1', currentNode: 'n-brouillon', status: 'waiting', grapheFige: GRAPHE_BROUILLON };
    const graphe = await grapheDuRun(run, async () => { lu.push('publie'); return GRAPHE_PUBLIE; });
    expect(graphe).toEqual(GRAPHE_BROUILLON);
    expect(lu, 'le publié ne doit même pas être lu quand un graphe est figé').toEqual([]);
  });

  it('⚠️ sans graphe figé, on lit le publié : c’est le comportement de TOUS les parcours réels', async () => {
    const run = { id: 'r2', workflowId: 'w1', currentNode: 'n-publie', status: 'waiting', grapheFige: null };
    expect(await grapheDuRun(run, async () => GRAPHE_PUBLIE)).toEqual(GRAPHE_PUBLIE);
  });
});
```

- [ ] **Step 4 : lancer le test, vérifier qu’il échoue**

Run : `npx vitest run tests/workflow-graphe-fige.test.ts`
Attendu : ÉCHEC, `grapheDuRun is not defined`.

- [ ] **Step 5 : écrire le point de passage unique dans l’exécuteur**

Dans `src/workflow/executor.ts`, au-dessus de la classe :

```ts
/**
 * LE GRAPHE QUE CE PARCOURS JOUE : le sien s'il en porte un, le publié sinon.
 *
 * 🔴 UN SEUL POINT DE PASSAGE, ET C'EST TOUT L'INTÉRÊT. L'exécuteur demandait le graphe à TROIS endroits
 * (`runEnAttenteSur`, l'avance, le réveil) et recevait le publié aux trois. Poser la préférence dans chacun
 * serait trois endroits où l'oublier, et le quatrième point de reprise ajouté demain ne l'aurait pas.
 *
 * ⚠️ `grapheFige` À NULL EST LE CAS NORMAL, pas une exception : aucun parcours réel n'en porte.
 */
export async function grapheDuRun(
  run: { workflowId: string; grapheFige: WorkflowGraph | null },
  lirePublie: () => Promise<WorkflowGraph | null>,
): Promise<WorkflowGraph | null> {
  return run.grapheFige ?? await lirePublie();
}
```

- [ ] **Step 6 : lancer le test, vérifier qu’il passe**

Run : `npx vitest run tests/workflow-graphe-fige.test.ts`
Attendu : SUCCÈS, 2 tests.

- [ ] **Step 7 : brancher les trois points de reprise**

Remplacer, aux trois endroits de `src/workflow/executor.ts` qui appellent `this.deps.getGraph(run.workflowId, tenantId)` :

```ts
const graph = await grapheDuRun(run, () => this.deps.getGraph(run.workflowId, tenantId));
```

- [ ] **Step 8 : écrire le graphe figé au démarrage**

Dans `runFrom`, à la création du parcours, passer `opts.figerLeGraphe === true ? graph : null` au store, et
dans `src/workflow/run-store.pg.ts` ajouter `graphe_fige` aux colonnes lues (`COLS`) et à l'`insert` de
création, avec `grapheFige: r.graphe_fige ?? null` dans le mapping de ligne.

- [ ] **Step 9 : vérifier par MUTATION, dans les deux sens**

Remettre `const graph = await this.deps.getGraph(...)` à l'un des trois endroits : le premier test doit
ÉCHOUER. Restaurer. Puis mettre `graphe_fige` à `null` de force à l'écriture : le premier test doit échouer
aussi. Restaurer.

- [ ] **Step 10 : la suite complète, puis commit**

```bash
npm run typecheck && npx vitest run
git commit --only db/migrations/0151_run_graphe_fige.sql src/workflow/executor.ts src/workflow/run-store.pg.ts tests/workflow-graphe-fige.test.ts CLAUDE.md -m "fix(scenario): un parcours de test joue le MEME graphe du debut a la fin"
```

---

## Task 2 : le jeton porte le bloc

**Files:**
- Modify: `src/workflow/test-token.ts`
- Modify: `src/webhooks/test-token.ts`
- Modify: `src/worker.ts` (le câblage de `startTestRun`)
- Test: `tests/workflow-test-token-node.test.ts`

**Interfaces:**
- Consomme : `WorkflowRunRow.grapheFige` et `opts.figerLeGraphe` (tâche 1),
  `WorkflowExecutor.startFromNode(tenantId, workflowId, graph, contact, startNodeId, opts)` (existant),
  `grapheEditable(row): WorkflowGraph` (existant).
- Produit : `lireJetonDeTest(body: string | null): { jeton: string; nodeId: string | null } | null`, et
  `TestTokenDeps.startTestRun(tenantId, workflowId, waId, nodeId: string | null)`.

- [ ] **Step 1 : écrire le test qui échoue**

```ts
import { describe, it, expect } from 'vitest';
import { lireJetonDeTest, looksLikeTestToken } from '../src/workflow/test-token';

describe('un jeton de test qui désigne un bloc', () => {
  it('🔴 le suffixe est LU, et le jeton reste celui du scénario', () => {
    expect(lireJetonDeTest('test-abc12345.0f7c9a21-4d3e-4b18-9a55-1c2e3f4a5b6c'))
      .toEqual({ jeton: 'test-abc12345', nodeId: '0f7c9a21-4d3e-4b18-9a55-1c2e3f4a5b6c' });
  });

  it('⚠️ sans suffixe, c’est le jeton d’avant et il démarre à l’entrée', () => {
    // Les liens déjà distribués doivent continuer de marcher : ils n'ont pas de point.
    expect(lireJetonDeTest('test-abc12345')).toEqual({ jeton: 'test-abc12345', nodeId: null });
  });

  it('🔴 le FILTRE DU CHEMIN CHAUD accepte les deux formes, et rien d’autre', () => {
    // Ce filtre décide si un message entrant interroge la base. L'élargir de travers ferait payer une requête
    // à chaque message de chaque client.
    expect(looksLikeTestToken('test-abc12345')).toBe(true);
    expect(looksLikeTestToken('test-abc12345.0f7c9a21-4d3e-4b18-9a55-1c2e3f4a5b6c')).toBe(true);
    expect(looksLikeTestToken('bonjour je teste test-abc12345')).toBe(false);
    expect(looksLikeTestToken('test-abc12345.')).toBe(false);
    expect(looksLikeTestToken('test-abc12345.zzz')).toBe(false);
    expect(looksLikeTestToken('test-abc12345.0f7c9a21')).toBe(false); // un préfixe ne suffit pas
  });

  it('⚠️ la normalisation d’avant tient toujours : majuscules et espaces', () => {
    expect(lireJetonDeTest('  TEST-ABC12345.0F7C9A21-4D3E-4B18-9A55-1C2E3F4A5B6C '))
      .toEqual({ jeton: 'test-abc12345', nodeId: '0f7c9a21-4d3e-4b18-9a55-1c2e3f4a5b6c' });
  });
});
```

- [ ] **Step 2 : lancer le test, vérifier qu’il échoue**

Run : `npx vitest run tests/workflow-test-token-node.test.ts`
Attendu : ÉCHEC, `lireJetonDeTest is not exported`.

- [ ] **Step 3 : élargir la forme du jeton**

Dans `src/workflow/test-token.ts`, remplacer `TOKEN_RE` et ajouter la lecture :

```ts
/**
 * Forme attendue d'un jeton, avec un suffixe de BLOC facultatif (2026-09-16).
 *
 * 🔴 CE `RegExp` EST LE FILTRE DU CHEMIN CHAUD : il décide si un message entrant coûte une requête en base.
 * L'élargir de travers ferait payer une résolution à chaque message de chaque client, pour rien. Le suffixe
 * est donc borné : 8 caractères hexadécimaux, ni plus ni moins, et un point suivi de rien est REFUSÉ.
 *
 * 🔴 L'IDENTIFIANT ENTIER, ET C'EST UN CHANGEMENT PAR RAPPORT AU PREMIER JET DE CE PLAN. Il proposait un
 * préfixe de huit caractères, plus joli dans le lien. Mais le navigateur devait alors RETIRER les tirets de
 * l'UUID pour fabriquer le suffixe, et le serveur comparer sur la même normalisation : un invariant partagé
 * de part et d'autre d'une frontière que ce dépôt interdit justement de franchir (aucun fichier de `web/`
 * n'importe `src/`), donc recopié à la main des deux côtés, donc voué à diverger sans qu'aucun test ne le
 * voie. L'identifiant entier supprime la question : la comparaison devient une ÉGALITÉ, pas un préfixe, et il
 * n'y a plus de cas « deux blocs correspondent ». Le lien est plus long, mais il est pré-rempli.
 */
const TOKEN_RE = new RegExp(`^${PREFIX}[0-9a-hjkmnp-tv-z]{${RANDOM_LEN}}(\\.[0-9a-f-]{36})?$`);

/**
 * Le jeton et le bloc qu'il désigne, ou `null` si ce n'en est pas un.
 *
 * ⚠️ `nodeId` À NULL EST LE CAS D'AVANT, pas une erreur : les liens déjà distribués n'ont pas de point, et
 * ils doivent continuer de démarrer le scénario à son entrée.
 */
export function lireJetonDeTest(body: string | null): { jeton: string; nodeId: string | null } | null {
  const texte = normalizeTestToken(body);
  if (!TOKEN_RE.test(texte)) return null;
  const point = texte.indexOf('.');
  return point === -1
    ? { jeton: texte, nodeId: null }
    : { jeton: texte.slice(0, point), nodeId: texte.slice(point + 1) };
}
```

- [ ] **Step 4 : lancer le test, vérifier qu’il passe**

Run : `npx vitest run tests/workflow-test-token-node.test.ts`
Attendu : SUCCÈS, 4 tests.

- [ ] **Step 5 : transmettre le bloc dans le handler**

Dans `src/webhooks/test-token.ts`, remplacer `normalizeTestToken(m.body)` par `lireJetonDeTest(m.body)`,
chercher le scénario avec `lu.jeton`, et appeler `deps.startTestRun(tenantId, wf.workflowId, m.waId, lu.nodeId)`.
Élargir la signature de `TestTokenDeps.startTestRun` au quatrième paramètre.

- [ ] **Step 6 : résoudre le bloc et démarrer là, dans le câblage**

Dans `src/worker.ts`, remplacer le corps de `startTestRun` :

```ts
startTestRun: async (tenant, workflowId, waId, nodeId) => {
  const wf = await workflowStore.getById(workflowId, tenant);
  if (!wf) return false;
  const contactId = await contactStore.findIdByWaId(tenant, waId);
  // 🔴 LE TEST JOUE LE BROUILLON, et il est désormais FIGÉ dans le parcours : sans ça, la reprise après un
  // bloc d'attente relisait le publié et le test changeait de version en silence (défaut du 2026-09-16).
  const graphe = grapheEditable(wf);
  if (nodeId === null) {
    return workflowExecutor.startInWindow(tenant, workflowId, graphe, { waId, contactId }, { emitEvents: true, figerLeGraphe: true });
  }
  // ⚠️ UN BLOC INTROUVABLE EST UN REFUS LISIBLE, pas un démarrage à l'entrée : un lien collé il y a trois
  // semaines peut pointer un bloc supprimé, et repartir du début enverrait au testeur une séquence qu'il
  // n'a pas demandée. L'égalité (et non un préfixe) rend le cas « plusieurs blocs correspondent » impossible.
  if (!graphe.nodes.some((n) => n.id === nodeId)) return 'ce bloc n’existe plus dans le scénario';
  return workflowExecutor.startFromNode(tenant, workflowId, graphe, { waId, contactId }, nodeId, { emitEvents: true, figerLeGraphe: true });
},
```

- [ ] **Step 7 : vérifier par MUTATION, dans les deux sens**

Retirer le `(\\.[0-9a-f-]{36})?` du `RegExp` : le premier test doit échouer. Restaurer. Puis rendre
`{ jeton: texte, nodeId: null }` dans tous les cas : le premier test doit échouer. Restaurer.

⚠️ **Et muter le CÂBLAGE, pas seulement le module** (leçon du 2026-09-16) : retirer la garde
`if (!graphe.nodes.some(...))` et vérifier qu'un test tombe. Si aucun ne tombe, c'est que le refus du bloc
introuvable n'est éprouvé nulle part : l'écrire avant de continuer.

- [ ] **Step 8 : la suite complète, puis commit**

```bash
npm run typecheck && npx vitest run
git commit --only src/workflow/test-token.ts src/webhooks/test-token.ts src/worker.ts tests/workflow-test-token-node.test.ts -m "feat(scenario): le jeton de test designe un bloc, et le demarrage s y fait"
```

---

## Task 3 : le bouton lecture sur chaque bloc

**Files:**
- Modify: `web/components/WorkflowNode.tsx` (le bouton, et le contexte qui porte le rappel)
- Modify: `web/components/WorkflowBuilder.tsx` (fournir le contexte, attendre l'enregistrement)
- Modify: `web/app/workflows/page.tsx` (le panneau existant accepte un bloc)
- Test: `web/e2e/workflow-test-node.spec.ts`

**Interfaces:**
- Consomme : le jeton rendu par la route existante (`ensureTestToken`), et `lireJetonDeTest` côté serveur
  (tâche 2) qui en lira le suffixe.
- Produit : rien que d'autres tâches consomment.

- [ ] **Step 1 : le contexte du rappel de test**

Dans `web/components/WorkflowNode.tsx`, à côté de `TemplatesCtx` :

```tsx
/**
 * Le rappel « tester à partir de ce bloc ».
 *
 * ⚠️ UN CONTEXTE ET NON UNE PROPRIÉTÉ DE `data` : React Flow recrée l'objet `data` d'un bloc à chaque rendu,
 * et y glisser une fonction ferait re-rendre tous les blocs à chaque frappe dans le panneau de configuration.
 * C'est déjà pour cette raison que `TemplatesCtx` existe.
 */
export const TestDepuisBlocCtx = createContext<((nodeId: string) => void) | null>(null);
```

- [ ] **Step 2 : le bouton, en haut à gauche du bloc**

Dans le composant du bloc, juste avant l'en-tête :

```tsx
{testDepuisBloc && (
  <button
    type="button"
    data-testid={`node-test-${id}`}
    title={t('Tester le scénario à partir de ce bloc', 'Test the scenario from this block')}
    onClick={(e) => { e.stopPropagation(); testDepuisBloc(id); }}
    className="absolute -left-2 -top-2 z-10 grid h-6 w-6 place-items-center rounded-full border border-ink-200 bg-white text-brand-600 shadow-sm hover:bg-brand-50"
  >
    <svg viewBox="0 0 24 24" className="h-3 w-3" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z" /></svg>
  </button>
)}
```

⚠️ `e.stopPropagation()` n'est pas décoratif : sans lui, le clic sélectionne aussi le bloc et ouvre son
panneau de configuration par-dessus le panneau de test.

- [ ] **Step 3 : fournir le contexte, après avoir enregistré**

Dans `web/components/WorkflowBuilder.tsx`, envelopper le canevas et passer un rappel qui attend
l'enregistrement en cours avant d'appeler le parent :

```tsx
<TestDepuisBlocCtx.Provider value={onTesterBloc ? async (nodeId) => { await enregistrement.flush(); onTesterBloc(nodeId); } : null}>
```

⚠️ **Le `flush` avant d'ouvrir le panneau est la seule chose qui rend le bouton juste sur un bloc qu'on vient
de poser** : le serveur ne connaît que ce que l'enregistrement automatique lui a envoyé.

- [ ] **Step 4 : le panneau accepte un bloc**

Dans `web/app/workflows/page.tsx`, élargir `openTest(w: WorkflowSummary, nodeId?: string)` : construire le
texte du lien en concaténant le jeton, un point, et le `node.id` TEL QUEL, et passer
`onTesterBloc={(nodeId) => { void openTest(editing, nodeId); }}` au constructeur.

🔴 **AUCUNE TRANSFORMATION DE L'IDENTIFIANT, ET C'EST LE POINT.** Le navigateur colle le `node.id` tel quel,
le serveur compare par ÉGALITÉ. Une normalisation (retirer les tirets, tronquer) serait un invariant partagé
de part et d'autre d'une frontière que ce dépôt interdit de franchir (aucun fichier de `web/` n'importe
`src/`), donc recopié à la main des deux côtés : il divergerait le jour où l'un des deux change, sans
qu'aucun test ne le voie.

- [ ] **Step 5 : le test de bout en bout**

```ts
test('🔴 le bouton d’un bloc ouvre le panneau de test avec le lien de CE bloc', async ({ page }) => {
  await monter(page);
  await page.goto('/workflows');
  await page.getByTestId('workflow-open-w1').click();
  await page.getByTestId('node-test-n2').click();
  await expect(page.getByTestId('workflow-test-panel')).toBeVisible();
  // Le lien doit porter le suffixe du bloc, sinon le test démarrerait à l'entrée.
  await expect(page.getByTestId('workflow-test-link')).toHaveAttribute('href', /%2E|\./);
});
```

- [ ] **Step 6 : lancer le test, vérifier qu’il passe**

Run : `cd web && npx playwright test e2e/workflow-test-node.spec.ts --reporter=line`

- [ ] **Step 7 : vérifier par MUTATION**

Retirer le suffixe du lien (rendre toujours `link.token`) : le test de bout en bout doit ÉCHOUER. Restaurer.

- [ ] **Step 8 : la suite complète, le build du front, puis commit**

```bash
npm run typecheck && npx vitest run && (cd web && npx tsc --noEmit && npx next build --no-lint)
git commit --only web/components/WorkflowNode.tsx web/components/WorkflowBuilder.tsx web/app/workflows/page.tsx web/e2e/workflow-test-node.spec.ts -m "feat(scenario): un bouton lecture sur chaque bloc, pour tester a partir de la"
```

---

## Ce que ce plan ne fait PAS, et pourquoi

- **Aucun avertissement sur les étapes sautées.** Décision explicite de Julien : « tant pis, il ne se passe
  rien ». Pas de liste des tags non posés, pas de nettoyage de fiche.
- **Aucun formulaire de variables.** Elles viennent de la fiche du contact et sortiront donc normalement.
- **Aucune expiration du lien.** Le jeton du scénario est déjà permanent, et un bloc disparu donne un refus.
- **Aucune route nouvelle.** Le suffixe se construit dans le navigateur à partir du jeton déjà rendu par la
  route existante : un aller-retour de plus n'apporterait rien.
