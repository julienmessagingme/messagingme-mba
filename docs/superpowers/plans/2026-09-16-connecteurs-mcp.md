# Connecteurs MCP : plan d'exécution

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** brancher Engage Me sur un serveur MCP tiers, en importer le catalogue d'outils, et permettre à un agent IA d'en appeler ceux que le client a explicitement autorisés.

**Architecture:** aucune table nouvelle. Un serveur MCP est une ligne d'`agent_tool_sources` avec `kind = 'mcp'` (la table le prévoit depuis 0088), ses outils sont des lignes d'`agent_tools` avec `origin = 'mcp'` (la valeur existe depuis 0086). Un client MCP écrit à la main (`src/mcp/client.ts`), un aplatisseur de schéma pur (`src/agent/mcp/aplatir.ts`), un résolveur (`src/agent/resolvers/mcp.ts`) monté à côté de `http` et `mba`. Tout le reste (consentement 0127, journal 0142, bac à sable, écran `AI Agent > Outils`) est réutilisé sans modification.

**Tech Stack:** TypeScript, Fastify, Postgres, Zod, Next.js, Vitest, Playwright.

**Spec:** [docs/superpowers/specs/2026-09-16-connecteurs-mcp-design.md](../specs/2026-09-16-connecteurs-mcp-design.md)

## Global Constraints

- **Aucune dépendance npm nouvelle.** Le serveur MCP de ce dépôt est écrit à la main, avec sa justification (« une dépendance qu'on n'utilise qu'à 10 % est une dépendance qu'on subira à 100 % le jour où elle changera de contrat »). Le client suit la même règle.
- **Révision du protocole : `2025-06-18`.** `VERSION_PROTOCOLE` existe déjà dans `src/mcp/serveur.ts` et se réutilise.
- **`safeParse`, jamais `parse`, jamais `as`** sur toute réponse d'un serveur MCP. C'est un tiers.
- **Transport : Streamable HTTP uniquement.** L'ancien HTTP+SSE (2024-11-05) est refusé avec un message qui le nomme.
- **Toute adresse saisie par un client** passe par `urlRecuperable` puis `resolutionPublique` (`src/lib/adresse-privee.ts`), et tout corps distant par `lireCorpsBorne` (`src/lib/corps-borne.ts`).
- **Aucun secret dans un journal, une erreur ou une réponse JSON.** `contenu` et `erreur` d'un résolveur repartent au modèle, donc chez le fournisseur.
- **`git commit --only <chemins>`**, jamais `git add` puis commit nu. La liste se construit depuis ce qu'on a touché soi-même, jamais depuis `git status`.
- **Pas de tiret cadratin** dans le code, les commentaires, les libellés ni la doc.
- **Ne jamais lancer `npm run test:integration` en local** : le `DATABASE_URL` local pointe sur la PRODUCTION. La CI monte un Postgres jetable.
- **Écritures réservées aux admins** (RBAC existant), garde `scopeTenant` obligatoire sur toute route portant `:tenantId`.

## Méthode de livraison

**Implémenteur par lot, avec revue humaine du diff.**

Le choix se fait sur les quatre questions du CLAUDE.md, et deux répondent oui : **la production emprunte ce chemin** (un tour d'agent en conversation réelle avec un contact), et **le code touché porte des invariants invisibles** (la séparation `modele`/`contact`/`fixe` qui est la garde anti-IDOR, l'unicité du nom d'outil par espace, le filtre de sortie de 0150, la contrainte `origin`/`source_id` de 0088).

`feature-loop` a été écarté **parce que** sa porte est la complétude, pas le rayon de souffle : ici un test vert ne prouve rien du seul risque qui compte, qu'un contact lise la donnée d'un autre. Ça se regarde sur le diff, par un humain. La **raison** de fond est que ce lot modifie des tables et un résolveur qui servent déjà des agents en production.

**L'essai réel qui clôt la feature : Engage Me branché sur notre propre serveur MCP** (`/mcp` sur `api.messagingme.app`). Il coche tout sans dépendre de personne : authentification par clé d'API donc « jeton simple », JSON-RPC sur un seul POST donc Streamable HTTP, outils connus (`list_conversations`, `get_contact`, `search_contacts`), et un `get_contact` dont le paramètre se cloue naturellement au contact, donc la garde d'identité est éprouvée **sur un vrai** échange et pas seulement en test. Le geste qui clôt : depuis un agent IA, poser en conversation WhatsApp une question dont la réponse exige l'appel de l'outil MCP, et vérifier que l'agent répond avec la donnée du **bon** contact, pas d'un autre.

Un second essai contre un serveur tiers reste souhaitable (lui seul mesure la proportion de schémas irréductibles), mais il n'est pas la porte de sortie du lot.

---

## File Structure

| Fichier | Responsabilité |
|---|---|
| `db/migrations/0152_outils_mcp.sql` | Quatre colonnes nullables sur `agent_tools` |
| `src/mcp/client.ts` | **Transport pur.** Cycle de vie, session, JSON ou flux d'événements, pagination. Aucune notion de base |
| `src/agent/mcp/aplatir.ts` | **Fonction pure.** Schéma distant vers feuilles + raison de non activabilité |
| `src/agent/mcp/import.ts` | Orchestration : appeler le client, aplatir, comparer à l'existant, rendre un PLAN de changements |
| `src/agent/resolvers/mcp.ts` | Le résolveur d'exécution, monté à côté de `http` et `mba` |
| `src/agent/champs-contact.ts` | S'ouvre aux champs déclarés de l'espace (`champs.<cle>`) |
| `src/agent/executor.ts` | Injection à deux niveaux pour `champs.<cle>` |
| `src/agent/llm/tool-schema.ts` | `ParamOutil.cheminMcp` |
| `src/agent/catalog.ts` / `catalog.pg.ts` | Les quatre colonnes portées par le contrat et le store |
| `src/agent/resolvers/simulation.ts` | Libellé du bac à sable pour un outil MCP |
| `src/http/agent-mcp.ts` | Les routes : éprouver, importer, rafraîchir, régler |
| `src/server.ts` | Le module entre au registre `modulesDeRoutes`, classe `tenant` |
| `web/app/connecteurs-mcp/page.tsx` + `web/lib/nav.ts` | L'écran et son entrée de menu |
| `web/components/McpServeurs.tsx`, `McpOutilReglage.tsx` | La liste des serveurs, le réglage d'un outil |
| `web/lib/api-mcp-connecteurs.ts` | L'accès HTTP du front |
| `web/app/mba/parametres/page.tsx` | **Tâche 1, à part :** l'onglet Outils du MBA |

---

## Task 1 : l'onglet Outils dans le paramétrage du MBA

**Livrable indépendant, committé et déployable AVANT tout le reste.** Il ne doit rien au chantier MCP : c'est la correction d'ergonomie sortie du constat que la seule page qui décide ce que l'agent de Meta peut appeler n'est pas dans le menu MBA.

**Files:**
- Modify: `web/app/mba/parametres/page.tsx` (la liste d'onglets, lignes 127-136)
- Test: `web/e2e/mba-onglet-outils.spec.ts`

**Interfaces:**
- Consumes: `BibliothequeOutils({ tenantId, isAdmin })`, composant existant, inchangé.
- Produces: rien pour les tâches suivantes.

- [ ] **Step 1 : écrire l'essai qui échoue**

`web/e2e/mba-onglet-outils.spec.ts` :

```ts
import { test, expect } from '@playwright/test';
import { connecter } from './utils';

test('le paramétrage du MBA porte un onglet Outils qui montre la bibliothèque', async ({ page }) => {
  await connecter(page);
  await page.goto('/mba/parametres');
  await page.getByTestId('mba-tab-outils').click();
  await expect(page.getByTestId('bibliotheque-outils')).toBeVisible();
  // La case qui décide ce que l'agent de Meta peut appeler doit être atteignable DEPUIS le menu MBA.
  await expect(page.getByTestId('publication-mba')).toBeVisible();
});
```

- [ ] **Step 2 : le lancer, vérifier qu'il échoue**

```bash
cd web && npx playwright test e2e/mba-onglet-outils.spec.ts
```

Attendu : ÉCHEC, `mba-tab-outils` introuvable.

- [ ] **Step 3 : ajouter l'onglet**

Dans `web/app/mba/parametres/page.tsx`, ajouter l'entrée après `'competences'` (l'outillage suit les compétences, qui sont les procédures) :

```tsx
{ key: 'outils', label: t('Outils', 'Tools') },
```

et le rendu correspondant, avec le commentaire qui dit pourquoi le même écran vit à deux endroits :

```tsx
{/* 🔴 LE MÊME ÉCRAN QUE `Tools > Outils`, ET C'EST VOULU. La bibliothèque appartient à l'ESPACE : elle est
    partagée par tous les consommateurs, donc sa place est bien dans Tools. Mais c'est ici, et nulle part
    ailleurs, qu'on décide ce que l'agent de Meta peut appeler (`exposerOutilAuMba`) et qu'on publie chez
    Meta. Un client qui configure son MBA cherche ses outils dans les onglets du MBA : Julien l'a cherché
    là le 2026-09-16 et ne l'a pas trouvé. Deux chemins vers un écran unique, pas deux écrans. */}
{onglet === 'outils' && <BibliothequeOutils tenantId={session.tenantId} isAdmin={session.role === 'admin'} />}
```

- [ ] **Step 4 : relancer, vérifier que ça passe**

```bash
cd web && npx playwright test e2e/mba-onglet-outils.spec.ts
```

- [ ] **Step 5 : commiter**

```bash
git commit --only web/app/mba/parametres/page.tsx web/e2e/mba-onglet-outils.spec.ts -m "feat(mba): un onglet Outils dans le parametrage, la ou on le cherche"
```

---

## Task 2 : le client MCP (transport pur)

**Files:**
- Create: `src/mcp/client.ts`
- Test: `tests/mcp-client.test.ts`

**Interfaces:**
- Consumes: `lireCorpsBorne` (`src/lib/corps-borne.ts`), `VERSION_PROTOCOLE` (`src/mcp/serveur.ts`).
- Produces :

```ts
export interface CibleMcp {
  url: string;
  enTetes: Record<string, string>;   // l'authentification, construite par l'appelant
  timeoutMs: number;
  maxBytes: number;
}

export interface OutilAnnonce {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

export type EchecMcp =
  | { genre: 'transport_ancien' }        // le serveur ne parle que HTTP+SSE de 2024-11-05
  | { genre: 'reseau'; message: string }
  | { genre: 'protocole'; message: string }
  | { genre: 'refus'; code: number; message: string };

export interface SessionMcp {
  /** Les outils annoncés, TOUTES les pages suivies. `tronque` dit qu'on a buté sur la borne. */
  lister(): Promise<{ outils: OutilAnnonce[]; tronque: boolean }>;
  appeler(nom: string, arguments_: Record<string, unknown>):
    Promise<{ texte: string; estErreur: boolean } | { echec: EchecMcp }>;
  fermer(): Promise<void>;
}

/** Ouvre une session : `initialize` puis `notifications/initialized`. */
export function ouvrirSessionMcp(
  cible: CibleMcp,
  opts?: { fetchImpl?: typeof fetch },
): Promise<SessionMcp | { echec: EchecMcp }>;
```

- [ ] **Step 1 : écrire les tests qui échouent**

`tests/mcp-client.test.ts`. Cinq cas, un par fait de la spec :

```ts
import { describe, it, expect } from 'vitest';
import { ouvrirSessionMcp } from '../src/mcp/client';

const CIBLE = { url: 'https://exemple.test/mcp', enTetes: {}, timeoutMs: 5000, maxBytes: 65536 };

/** Un faux serveur : rend les réponses dans l'ordre, et garde ce qu'on lui a envoyé. */
function faussaire(reponses: Array<{ statut?: number; type?: string; corps: string; enTetes?: Record<string, string> }>) {
  const vues: Array<{ corps: unknown; enTetes: Record<string, string> }> = [];
  let i = 0;
  const impl = (async (_url: string, init: RequestInit) => {
    const enTetes = Object.fromEntries(
      Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]),
    );
    vues.push({ corps: JSON.parse(String(init.body ?? '{}')), enTetes });
    const r = reponses[i++] ?? reponses[reponses.length - 1]!;
    return new Response(r.corps, {
      status: r.statut ?? 200,
      headers: { 'content-type': r.type ?? 'application/json', ...(r.enTetes ?? {}) },
    });
  }) as unknown as typeof fetch;
  return { impl, vues };
}

const INIT_OK = JSON.stringify({
  jsonrpc: '2.0', id: 1,
  result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'x', version: '1' } },
});

describe('le client MCP', () => {
  it('annonce Accept avec les DEUX types, sinon la moitie des serveurs conformes repondent en flux et on ne sait pas lire', async () => {
    const f = faussaire([{ corps: INIT_OK }]);
    await ouvrirSessionMcp(CIBLE, { fetchImpl: f.impl });
    expect(f.vues[0]!.enTetes.accept).toContain('application/json');
    expect(f.vues[0]!.enTetes.accept).toContain('text/event-stream');
  });

  it('porte Mcp-Session-Id sur toutes les requetes SUIVANTES quand le serveur en assigne un', async () => {
    const f = faussaire([
      { corps: INIT_OK, enTetes: { 'mcp-session-id': 'abc123' } },
      { statut: 202, corps: '' },
      { corps: JSON.stringify({ jsonrpc: '2.0', id: 3, result: { tools: [] } }) },
    ]);
    const s = await ouvrirSessionMcp(CIBLE, { fetchImpl: f.impl });
    await (s as import('../src/mcp/client').SessionMcp).lister();
    expect(f.vues[0]!.enTetes['mcp-session-id']).toBeUndefined();
    expect(f.vues[1]!.enTetes['mcp-session-id']).toBe('abc123');
    expect(f.vues[2]!.enTetes['mcp-session-id']).toBe('abc123');
    // L'en-tete de version est obligatoire sur tout ce qui suit l'initialisation.
    expect(f.vues[2]!.enTetes['mcp-protocol-version']).toBe('2025-06-18');
  });

  it('lit une reponse rendue en FLUX d evenements, pas seulement en JSON', async () => {
    const corpsSse = 'event: message\ndata: {"jsonrpc":"2.0","id":3,"result":{"tools":[{"name":"a","inputSchema":{"type":"object"}}]}}\n\n';
    const f = faussaire([
      { corps: INIT_OK },
      { statut: 202, corps: '' },
      { type: 'text/event-stream', corps: corpsSse },
    ]);
    const s = await ouvrirSessionMcp(CIBLE, { fetchImpl: f.impl });
    const r = await (s as import('../src/mcp/client').SessionMcp).lister();
    expect(r.outils.map((o) => o.name)).toEqual(['a']);
  });

  it('SUIT LA PAGINATION : un catalogue sur deux pages rend deux outils, pas un', async () => {
    const page1 = JSON.stringify({ jsonrpc: '2.0', id: 3, result: { tools: [{ name: 'a', inputSchema: { type: 'object' } }], nextCursor: 'c2' } });
    const page2 = JSON.stringify({ jsonrpc: '2.0', id: 4, result: { tools: [{ name: 'b', inputSchema: { type: 'object' } }] } });
    const f = faussaire([{ corps: INIT_OK }, { statut: 202, corps: '' }, { corps: page1 }, { corps: page2 }]);
    const s = await ouvrirSessionMcp(CIBLE, { fetchImpl: f.impl });
    const r = await (s as import('../src/mcp/client').SessionMcp).lister();
    expect(r.outils.map((o) => o.name)).toEqual(['a', 'b']);
    expect(r.tronque).toBe(false);
  });

  it('NOMME l ancien transport au lieu d echouer en silence', async () => {
    const f = faussaire([{ statut: 405, corps: 'Method Not Allowed' }]);
    const s = await ouvrirSessionMcp(CIBLE, { fetchImpl: f.impl });
    expect(s).toEqual({ echec: { genre: 'transport_ancien' } });
  });
});
```

- [ ] **Step 2 : les lancer, vérifier qu'ils échouent**

```bash
npx vitest run tests/mcp-client.test.ts
```

Attendu : ÉCHEC, `Cannot find module '../src/mcp/client'`.

- [ ] **Step 3 : écrire le client**

`src/mcp/client.ts`. Points obligatoires, chacun adossé à une phrase de la spec :

```ts
/**
 * Le CLIENT MCP : Engage Me va chercher des outils chez un tiers.
 *
 * 🔴 NE PAS CONFONDRE AVEC `serveur.ts`, QUI VA DANS L'AUTRE SENS. Celui-ci nous rend consommateur d'un
 * serveur que nous ne contrôlons pas. Tout ce qu'il en reçoit est du tiers : `safeParse`, jamais `as`.
 *
 * 🔴 UN APPEL N'EST PAS UN POST ISOLÉ. La spec impose `initialize` puis la notification
 * `notifications/initialized` avant toute autre requête, et si le serveur assigne un `Mcp-Session-Id`, il
 * DOIT être porté par tout ce qui suit. D'où une session, ouverte pour une opération et jetée après.
 *
 * ⚠️ ELLE N'EST JAMAIS MISE EN CACHE ENTRE DEUX OPÉRATIONS. L'API et le worker sont deux process, le
 * déploiement en lance d'autres, et un identifiant partagé entre deux process rend un 404 qu'il faudrait
 * rattraper. Le coût assumé est de deux allers-retours au premier appel d'un tour, dans un budget de 8 s.
 */
```

- `Accept: application/json, text/event-stream` sur **chaque** POST.
- `MCP-Protocol-Version: 2025-06-18` sur tout ce qui suit l'initialisation.
- Réponse `202` sans corps pour une notification : c'est un succès, pas une réponse vide à parser.
- Lecture du corps : si `content-type` commence par `text/event-stream`, parser les lignes `data:` et s'arrêter au premier message JSON-RPC dont l'`id` correspond ; sinon, JSON direct. Dans les deux cas, le corps passe par `lireCorpsBorne` et ses trois verdicts (`trop_gros`, `casse`, texte) : **un flux coupé n'est pas un corps vide**.
- `4xx` sur le POST d'`initialize` : `{ genre: 'transport_ancien' }`. C'est la signature exacte que la spec donne d'un serveur resté sur 2024-11-05, et on la NOMME plutôt que de basculer dessus.
- `lister()` suit `nextCursor` avec deux bornes : **20 pages** et **500 outils**. Atteindre une borne pose `tronque: true`, jamais une troncature muette.
- `appeler()` concatène les blocs `content` de type `text` ; tout bloc non textuel devient `[image]`, `[audio]`, `[ressource]`. `isError: true` rend `{ texte, estErreur: true }`, une erreur JSON-RPC rend `{ echec: { genre: 'refus', ... } }`. **Aucun de ces cas ne lève.**
- `fermer()` envoie le `DELETE` avec `Mcp-Session-Id` si le serveur en a assigné un, et ignore un `405` (le serveur a le droit de refuser).

- [ ] **Step 4 : relancer, vérifier que les cinq passent**

```bash
npx vitest run tests/mcp-client.test.ts && npm run typecheck
```

- [ ] **Step 5 : commiter**

```bash
git commit --only src/mcp/client.ts tests/mcp-client.test.ts -m "feat(mcp): un client MCP, cycle de vie, session, flux d evenements et pagination"
```

---

## Task 3 : l'aplatissement d'un schéma distant

**Files:**
- Create: `src/agent/mcp/aplatir.ts`
- Test: `tests/mcp-aplatir.test.ts`

**Interfaces:**
- Consumes: `TypeParam` (`src/agent/llm/tool-schema.ts`).
- Produces :

```ts
export interface FeuilleMcp {
  /** Nom exposé au modèle : plat, normalisé, unique dans l'outil. */
  name: string;
  /** Chemin dans le schéma distant ("filtres.ville"). Interne, jamais exposé. */
  cheminMcp: string;
  type: TypeParam;
  description?: string;
  required: boolean;
  enum?: string[];
}

/** `null` en `raisonNonActivable` = l'outil est activable. */
export function aplatirSchema(inputSchema: unknown): {
  feuilles: FeuilleMcp[];
  raisonNonActivable: string | null;
};
```

- [ ] **Step 1 : écrire les tests qui échouent**

`tests/mcp-aplatir.test.ts` :

```ts
import { describe, it, expect } from 'vitest';
import { aplatirSchema } from '../src/agent/mcp/aplatir';

describe('aplatir un schema MCP', () => {
  it('descend dans les sous-objets et garde le CHEMIN, qui est ce qui permet de recomposer', () => {
    const r = aplatirSchema({
      type: 'object',
      properties: {
        filtres: { type: 'object', properties: { ville: { type: 'string' }, date: { type: 'string' } }, required: ['ville'] },
        limite: { type: 'integer' },
      },
      required: ['filtres'],
    });
    expect(r.raisonNonActivable).toBeNull();
    expect(r.feuilles.map((f) => [f.name, f.cheminMcp, f.required])).toEqual([
      ['filtres_ville', 'filtres.ville', true],
      ['filtres_date', 'filtres.date', false],
      ['limite', 'limite', false],
    ]);
  });

  it('desambigue deux feuilles dont le nom final se collisionne', () => {
    const r = aplatirSchema({
      type: 'object',
      properties: {
        a: { type: 'object', properties: { ville: { type: 'string' } } },
        b: { type: 'object', properties: { ville: { type: 'string' } } },
      },
    });
    expect(new Set(r.feuilles.map((f) => f.name)).size).toBe(2);
  });

  it('refuse un TABLEAU d objets, et NOMME le parametre en cause', () => {
    const r = aplatirSchema({
      type: 'object',
      properties: { lignes: { type: 'array', items: { type: 'object', properties: { sku: { type: 'string' } } } } },
    });
    expect(r.raisonNonActivable).toContain('lignes');
  });

  it('refuse des alternatives', () => {
    const r = aplatirSchema({ type: 'object', properties: { cle: { oneOf: [{ type: 'string' }, { type: 'integer' }] } } });
    expect(r.raisonNonActivable).not.toBeNull();
  });

  it('refuse un objet libre, qui n a aucune feuille a enumerer', () => {
    const r = aplatirSchema({ type: 'object', properties: { meta: { type: 'object' } } });
    expect(r.raisonNonActivable).toContain('meta');
  });

  it('un outil SANS parametre est activable, avec zero feuille', () => {
    const r = aplatirSchema({ type: 'object', properties: {} });
    expect(r).toEqual({ feuilles: [], raisonNonActivable: null });
  });

  it('un inputSchema absent ou illisible n est pas une exception, c est un refus lisible', () => {
    expect(aplatirSchema(null).raisonNonActivable).not.toBeNull();
    expect(aplatirSchema({ type: 'string' }).raisonNonActivable).not.toBeNull();
  });
});
```

- [ ] **Step 2 : les lancer, vérifier qu'ils échouent**

```bash
npx vitest run tests/mcp-aplatir.test.ts
```

- [ ] **Step 3 : écrire l'aplatisseur**

```ts
/**
 * Un `inputSchema` MCP est du JSON Schema quelconque ; nos paramètres sont PLATS et scalaires.
 *
 * 🔴 CE MODULE EST CE QUI PERMET À LA GARDE D'IDENTITÉ DE DESCENDRE DANS LES SOUS-OBJETS. Sans lui, un
 * paramètre imbriqué serait forcément rempli par le modèle, donc influençable par le contact : un
 * `filtres.client_id` deviendrait un IDOR. En énumérant les FEUILLES, chacune reçoit sa source
 * (`modele` / `contact` / `fixe`) comme n'importe quel paramètre maison.
 *
 * 🔴 IL REFUSE PLUTÔT QUE DE DEVINER, et c'est le point. Trois formes n'ont pas de jeu de feuilles fixe :
 * un tableau d'objets (nombre d'éléments inconnu), des alternatives (`oneOf`/`anyOf`, deux formes
 * possibles), un objet libre (rien de déclaré). Les aplatir demanderait d'inventer une convention que le
 * serveur distant ne connaît pas. On rend donc une RAISON, qui part telle quelle à l'écran.
 *
 * ⚠️ IL NE LÈVE JAMAIS. Son entrée vient d'un tiers : une exception ici ferait échouer l'import ENTIER
 * à cause d'un seul outil mal formé, et le client perdrait les quinze autres.
 */
```

Règles : profondeur maximale **5** (au delà, refus nommé). Le nom d'une feuille est le chemin normalisé en `[a-z0-9_]`, tronqué à 64, suffixé en cas de collision. `required` est vrai si **tous** les maillons du chemin le sont. Un `enum` de chaînes est conservé (une énumération fermée empêche le modèle d'inventer une valeur hors domaine).

- [ ] **Step 4 : relancer**

```bash
npx vitest run tests/mcp-aplatir.test.ts && npm run typecheck
```

- [ ] **Step 5 : commiter**

```bash
git commit --only src/agent/mcp/aplatir.ts tests/mcp-aplatir.test.ts -m "feat(mcp): aplatir un schema distant en feuilles, pour que la garde d identite y descende"
```

---

## Task 4 : la migration et le contrat de store

**Files:**
- Create: `db/migrations/0152_outils_mcp.sql`
- Modify: `src/agent/catalog.ts`, `src/agent/catalog.pg.ts`, `src/agent/llm/tool-schema.ts`
- Modify: `CLAUDE.md` (le compteur, APRÈS `migrate`)
- Test: `tests/mcp-catalogue.test.ts`, `tests/migration-directives.test.ts` (existant, doit rester vert)

**Interfaces:**
- Produces : `OutilDefini` et `OutilBibliotheque` gagnent `mcpAnnonce: unknown | null`, `mcpNonActivable: string | null`, `mcpIndisponibleLe: Date | null`, `mcpVuLe: Date | null`. `ParamOutil` gagne `cheminMcp?: string`.

- [ ] **Step 1 : écrire la migration**

```sql
-- 0152 : ce qu'un outil IMPORTE d un serveur MCP garde de son annonce.
--
-- AUCUNE TABLE NOUVELLE. Un serveur MCP est une ligne d `agent_tool_sources` avec kind = 'mcp', que 0088
-- prevoyait deja ("'mcp' est declare des maintenant pour que L4 n ait pas de migration a faire"), et ses
-- outils sont des lignes d `agent_tools` avec origin = 'mcp', que 0086 prevoyait aussi. La contrainte
-- `agent_tools_origin_src_chk` impose deja qu un outil non maison porte une source : elle vaut telle quelle.
--
-- ELLE AJOUTE DES COLONNES QUE LE CODE ECRIT, donc elle passe AVANT le deploiement.

-- L annonce BRUTE du serveur pour cet outil (name, title, description, inputSchema, outputSchema,
-- annotations), telle qu elle est arrivee.
--
-- POURQUOI LA GARDER, alors qu on en derive deja `params`. C est la seule facon de DIRE CE QUI A CHANGE au
-- rafraichissement. Le consentement tombe quand le schema bouge (0127 : il porte sur un outil precis) ;
-- sans l annonce d avant, on saurait qu il a bouge sans pouvoir dire en quoi, et le client devrait
-- reautoriser a l aveugle.
alter table agent_tools add column if not exists mcp_annonce jsonb;

-- null = activable. Sinon, la RAISON en clair, affichee telle quelle au client.
-- Trois formes n ont pas de jeu de feuilles fixe (tableau d objets, alternatives, objet libre) : on les
-- IMPORTE et on les MONTRE, on ne les active pas. Une raison stockee, plutot que recalculee a l affichage,
-- parce que c est l import qui l a etablie et qu elle doit survivre a un changement de notre aplatisseur.
alter table agent_tools add column if not exists mcp_non_activable text;

-- L outil a disparu du catalogue distant. On ne le supprime PAS : la ligne est la trace de ce qui a tourne,
-- et le journal des appels y renvoie.
alter table agent_tools add column if not exists mcp_indisponible_le timestamptz;

-- Dernier rafraichissement ou le serveur l annoncait encore.
alter table agent_tools add column if not exists mcp_vu_le timestamptz;

-- AUCUN INDEX, delibere : les lectures passent par `source_id`, qui porte deja `agent_tools_source_idx`.
-- Un index partiel est un contrat avec une requete precise, et aucune requete de ce lot n en demande un.
```

- [ ] **Step 2 : appliquer, PUIS relire la base**

```bash
npm run migrate
```

Puis, dans la base, vérifier les quatre points **et pas seulement l'absence d'erreur** : `schema_migrations` rend `0152_outils_mcp.sql` en tête ; les quatre colonnes sont dans `information_schema` avec le bon type et sans défaut ; `pg_indexes` n'en porte aucun ; et zéro ligne existante n'en porte une valeur, donc aucun comportement n'a bougé.

- [ ] **Step 3 : mettre à jour le compteur de `CLAUDE.md`**

Section Déploiement : **Dernière appliquée : 0152 / Prochaine libre = 0153**, avec ce qu'elle répare. La ligne se relit **depuis la base**, jamais depuis le fichier SQL qu'on vient d'écrire : ce compteur a dérivé huit fois, toujours pour cette raison.

- [ ] **Step 4 : porter les colonnes dans le contrat et le store**

`OutilDefini` et `OutilBibliotheque` gagnent les quatre champs, **requis** (pas optionnels) : un câblage qui les oublierait ne doit pas compiler, c'est ce qui a fait tenir `grapheFige` sur `WorkflowRunRow`. Les quatre sites de lecture de `catalog.pg.ts` les sélectionnent.

`ParamOutil` gagne `cheminMcp?: string`, avec sa coercion dans `coercer()` sur le même patron que `contactPath`.

- [ ] **Step 5 : écrire et lancer le test de parité**

`tests/mcp-catalogue.test.ts` vérifie qu'un outil sans annonce MCP rend `mcpAnnonce: null` et non `undefined` (la distinction a déjà coûté un bug de toggle), et que `paramsOutil` conserve `cheminMcp`.

```bash
npx vitest run tests/mcp-catalogue.test.ts tests/migration-directives.test.ts && npm run typecheck
```

- [ ] **Step 6 : commiter**

```bash
git commit --only db/migrations/0152_outils_mcp.sql src/agent/catalog.ts src/agent/catalog.pg.ts src/agent/llm/tool-schema.ts tests/mcp-catalogue.test.ts CLAUDE.md -m "feat(mcp): ce qu un outil importe garde de son annonce (migration 0152)"
```

---

## Task 5 : le clouage aux champs du mini-CRM

**Files:**
- Modify: `src/agent/champs-contact.ts`, `src/agent/executor.ts`
- Modify: `src/http/agent-tools.ts` (validation à l'écriture)
- Test: `tests/agent-champs-contact.test.ts`

**Interfaces:**
- Consumes: la projection du tour, `{ nom, tags, champs }` (`src/worker.ts:1690`).
- Produces: `contactPath` accepte désormais la forme `champs.<cle>`.

- [ ] **Step 1 : écrire les tests qui échouent**

```ts
import { describe, it, expect } from 'vitest';
import { estChampContact } from '../src/agent/champs-contact';

describe('les champs auxquels un parametre peut etre cloue', () => {
  it('garde les deux d avant', () => {
    expect(estChampContact('wa_id')).toBe(true);
    expect(estChampContact('nom')).toBe(true);
  });

  it('accepte un champ DECLARE du mini-CRM, sous le prefixe qui dit d ou il vient', () => {
    expect(estChampContact('champs.email')).toBe(true);
  });

  it('REFUSE un chemin libre, qui est exactement ce que la fermeture de 0086 protegeait', () => {
    expect(estChampContact('champs')).toBe(false);          // l objet entier
    expect(estChampContact('champs.a.b')).toBe(false);       // deux niveaux sous champs
    expect(estChampContact('tags')).toBe(false);             // un tableau n est pas un scalaire
    expect(estChampContact('opt_in')).toBe(false);           // une cle de la ligne brute
    expect(estChampContact('champs.')).toBe(false);
  });
});
```

Et dans `tests/agent-executor.test.ts`, le cas d'injection, **vérifié par mutation** :

```ts
it('injecte un champ du mini-CRM SANS jamais l exposer au modele', async () => {
  // Le parametre est marque `contact` : il ne doit pas apparaitre dans le schema envoye au modele,
  // et sa valeur doit venir de la projection, pas de ce que le modele a propose.
  // Le modele tente `client@ennemi.fr`, la projection porte `vrai@client.fr`.
  // Attendu : l appel part avec `vrai@client.fr`.
});
```

- [ ] **Step 2 : les lancer, vérifier qu'ils échouent**

```bash
npx vitest run tests/agent-champs-contact.test.ts
```

- [ ] **Step 3 : ouvrir la liste**

`estChampContact` accepte `wa_id`, `nom`, ou `champs.<cle>` où `<cle>` matche `^[a-zA-Z0-9_-]{1,64}$`. **Un seul niveau sous `champs`**, et le commentaire dit pourquoi :

```ts
/**
 * ⚠️ LA FERMETURE S'OUVRE D'UN CRAN, ET PAS D'UN DE PLUS (2026-09-16). Elle ne portait que `wa_id` et `nom`,
 * trop étroit pour MCP : beaucoup de serveurs identifient par e-mail ou par référence client, et ces
 * paramètres-là retomberaient sur le modèle, c'est-à-dire précisément là où on ne les veut pas.
 *
 * 🔴 CE QUI EST CONSERVÉ DE LA FERMETURE : on désigne un champ qui EXISTE, jamais un chemin libre. La forme
 * `champs.<cle>` n'accepte qu'UN niveau, et la route vérifie à l'ÉCRITURE que la clé est un champ déclaré
 * de l'espace. La garde d'origine visait « un paramètre qui dériverait d'une clé future ajoutée pour tout
 * autre chose » : une clé du jsonb `contacts.fields` est par construction une clé que le client a créée.
 *
 * ⚠️ `tags` reste dehors : c'est un tableau, pas un scalaire, et un paramètre d'outil est scalaire.
 */
```

- [ ] **Step 4 : l'injection à deux niveaux**

Dans `src/agent/executor.ts`, étape 4, remplacer l'accès plat par un accès qui descend dans `champs` :

```ts
if (p.source === 'contact') {
  const chemin = p.contactPath ?? p.name;
  args[p.name] = chemin === 'wa_id'
    ? ctx.waId
    : valeurProjetee(ctx.contact, chemin);
}
```

`valeurProjetee` descend d'un seul cran sur `champs.<cle>` et rend `null` si absent. **Rendre `null` est le comportement voulu** : le champ vide part vide, et c'est le serveur distant qui décide (décision de Julien du 2026-09-16). Refuser l'appel serait faux pour un paramètre optionnel, un outil qui refuse de chercher parce que le contact n'a pas renseigné sa ville serait absurde.

- [ ] **Step 5 : la validation à l'écriture**

La route qui pose un paramètre `contact` vérifie que `champs.<cle>` désigne un champ **déclaré** de l'espace, et rend un 400 nommé sinon. C'est là, et pas au runtime, que la fermeture se tient.

- [ ] **Step 6 : vérifier dans les DEUX sens**

Remettre l'ancien `chemin === 'wa_id' ? ... : ctx.contact[chemin]`, constater que le test d'injection échoue **et** que son symptôme est bien « la valeur est `undefined` », restaurer. Un test qui passe dans les deux sens ne prouve rien.

```bash
npx vitest run tests/agent-champs-contact.test.ts tests/agent-executor.test.ts && npm run typecheck
```

- [ ] **Step 7 : commiter**

```bash
git commit --only src/agent/champs-contact.ts src/agent/executor.ts src/http/agent-tools.ts tests/agent-champs-contact.test.ts tests/agent-executor.test.ts -m "feat(agent): un parametre peut se clouer a un champ declare du mini-CRM"
```

---

## Task 6 : le résolveur MCP

**Files:**
- Create: `src/agent/resolvers/mcp.ts`
- Modify: `src/worker.ts` (le câblage des résolveurs), `src/agent/resolvers/simulation.ts`
- Test: `tests/agent-resolveur-mcp.test.ts`

**Interfaces:**
- Consumes: `ouvrirSessionMcp` (Task 2), `SourceStore.pourAppel`, `paramsOutil`, `resolutionPublique`.
- Produces: `creerResolveurMcp(deps): ResolveurOutil`, monté sous la clé `mcp` de `deps.resolveurs`.

🔴 **Sans cette tâche, un outil `origin='mcp'` fait ARRÊTER LE TOUR.** L'exécuteur dispatche sur `deps.resolveurs[outil.origin]` et, faute de résolveur, rend `erreur_protocole` avec `fatal: true` (`src/agent/executor.ts:341`). Le résolveur doit donc être câblé dans le même lot que l'import.

- [ ] **Step 1 : écrire les tests qui échouent**

Quatre cas, plus la recomposition :

```ts
import { describe, it, expect, vi } from 'vitest';
import { creerResolveurMcp } from '../src/agent/resolvers/mcp';

const SOURCE = {
  id: 's1', tenantId: 't1', kind: 'mcp' as const, baseUrl: 'https://exemple.test/mcp',
  authKind: 'bearer' as const, authHeaderName: null, authSecret: 'jeton', status: 'active' as const,
};

function deps(session: unknown, resolution: 'publique' | 'privee' = 'publique') {
  return {
    sources: { pourAppel: async () => SOURCE, marquerEpreuve: async () => {} },
    journal: { ouvrir: async () => 'j1', clore: async () => {} },
    ouvrirSession: vi.fn(async () => session),
    verifierResolution: async () => ({ verdict: resolution }),
  };
}

const outil = (params: unknown[], nature: 'integre' | 'pousse' = 'integre') => ({
  id: 'o1', tenantId: 't1', origin: 'mcp' as const, name: 'notion_search', description: '', nePasUtiliser: '',
  params, binding: { outilDistant: 'search' }, sourceId: 's1', requestId: null,
  nature, outputPaths: ['ignore_moi'], risk: 'read' as const, timeoutMs: 8000, maxBytes: 4096, autonome: false,
  mcpAnnonce: null, mcpNonActivable: null, mcpIndisponibleLe: null, mcpVuLe: null,
});

const ctx = { tenantId: 't1', waId: '33600000000', contact: { nom: 'Ada', tags: [], champs: {} } };

describe('le resolveur MCP', () => {
  it('RECOMPOSE l objet imbrique depuis les chemins avant d appeler', async () => {
    const appeler = vi.fn(async () => ({ texte: 'ok', estErreur: false }));
    const r = creerResolveurMcp(deps({ lister: vi.fn(), appeler, fermer: vi.fn() }));
    await r({
      outil: outil([{ name: 'filtres_ville', cheminMcp: 'filtres.ville', type: 'string', source: 'modele' }]),
      args: { filtres_ville: 'Lyon' }, ctx,
    });
    // 🔴 Le serveur distant doit recevoir SA forme, pas la notre. Le nom plat est une etiquette locale.
    expect(appeler).toHaveBeenCalledWith('search', { filtres: { ville: 'Lyon' } });
  });

  it('un isError:true du serveur rend ok:false avec sa raison, et NE LEVE PAS', async () => {
    const session = { lister: vi.fn(), appeler: async () => ({ texte: 'quota depasse', estErreur: true }), fermer: vi.fn() };
    const r = creerResolveurMcp(deps(session));
    const sortie = await r({ outil: outil([]), args: {}, ctx });
    expect(sortie.ok).toBe(false);
    expect(JSON.stringify(sortie)).toContain('quota depasse');
  });

  it('une erreur JSON-RPC rend ok:false, et NE LEVE PAS', async () => {
    const session = { lister: vi.fn(), appeler: async () => ({ echec: { genre: 'refus', code: -32602, message: 'Unknown tool' } }), fermer: vi.fn() };
    const r = creerResolveurMcp(deps(session));
    // 🔴 Lever ferait une `erreur_protocole`, qui ARRETE le tour, alors que le client peut corriger son
    // branchement dans sa console. Un outil qui echoue doit laisser l agent dire quelque chose au contact.
    const sortie = await r({ outil: outil([]), args: {}, ctx });
    expect(sortie.ok).toBe(false);
  });

  it('une adresse qui resout vers une adresse privee est REFUSEE avant tout appel', async () => {
    const ouvrirSession = vi.fn();
    const d = { ...deps({}, 'privee'), ouvrirSession };
    const sortie = await creerResolveurMcp(d)({ outil: outil([]), args: {}, ctx });
    expect(sortie.ok).toBe(false);
    expect(ouvrirSession).not.toHaveBeenCalled();
  });

  it('IGNORE output_paths : le texte rendu part entier, borne par maxBytes', async () => {
    // 🔴 Le laisser simplement vide reproduirait le bug que 0150 a corrige : filtre vide = zero champ =
    // l agent ne recoit rien, et rien ne le signale. Ici `outputPaths` vaut ['ignore_moi'] et ne doit
    // filtrer RIEN DU TOUT.
    const session = { lister: vi.fn(), appeler: async () => ({ texte: 'reponse entiere', estErreur: false }), fermer: vi.fn() };
    const sortie = await creerResolveurMcp(deps(session))({ outil: outil([]), args: {}, ctx });
    expect(sortie.ok).toBe(true);
    expect(JSON.stringify(sortie)).toContain('reponse entiere');
  });

  it('une nature `pousse` rend le VERDICT seul, jamais le contenu d un succes', async () => {
    const session = { lister: vi.fn(), appeler: async () => ({ texte: 'fiche complete du client', estErreur: false }), fermer: vi.fn() };
    const sortie = await creerResolveurMcp(deps(session))({ outil: outil([], 'pousse'), args: {}, ctx });
    expect(sortie.ok).toBe(true);
    expect(JSON.stringify(sortie)).not.toContain('fiche complete');
  });
});
```

- [ ] **Step 2 : les lancer, vérifier qu'ils échouent**

```bash
npx vitest run tests/agent-resolveur-mcp.test.ts
```

- [ ] **Step 3 : écrire le résolveur**

Il relit la source **à chaque appel** (une source désactivée doit cesser d'être appelée sans attendre un redémarrage, comme le fait déjà le résolveur `http`), vérifie `resolutionPublique` sur `base_url`, ouvre une session, recompose les arguments depuis `cheminMcp`, appelle, et ferme. `nature: 'pousse'` rend le verdict seul, jamais le contenu d'un succès.

- [ ] **Step 4 : câbler, et réparer le bac à sable**

Dans `src/worker.ts`, ajouter `mcp: creerResolveurMcp({...})` au dictionnaire des résolveurs. ⚠️ Le contrôle des propriétés en trop **ne traverse pas un spread** : poser la garde `satisfies` sur l'objet intérieur, comme `tests/campagne-cablage.test.ts` l'impose déjà pour les campagnes.

Dans `simulation.ts`, `connecteurSimule` reçoit l'origine et rend un libellé juste :

```ts
// ⚠️ IL LISAIT `binding.methode` ET `binding.chemin`, QUE N'A PAS UN OUTIL MCP, et affichait donc
// « l'appel ? ? vers votre système » : un bac à sable qui promet de montrer ce qui va se passer et qui
// affiche deux points d'interrogation est pire qu'un bac à sable absent.
```

- [ ] **Step 5 : relancer la suite complète**

```bash
npm test && npm run typecheck
```

- [ ] **Step 6 : commiter**

```bash
git commit --only src/agent/resolvers/mcp.ts src/agent/resolvers/simulation.ts src/worker.ts tests/agent-resolveur-mcp.test.ts -m "feat(mcp): le resolveur d execution, et le bac a sable qui nomme enfin l appel"
```

---

## Task 7 : l'import, le rafraîchissement et les routes

**Files:**
- Create: `src/agent/mcp/import.ts`, `src/http/agent-mcp.ts`
- Modify: `src/server.ts` (registre `modulesDeRoutes`, classe `tenant`)
- Test: `tests/mcp-import.test.ts`, `tests/scope-tenant.test.ts` (existant, doit rester vert)

**Interfaces:**
- Consumes: `ouvrirSessionMcp` (Task 2), `aplatirSchema` (Task 3), `ToolAdminStore` (Task 4).
- Produces :

```ts
export type ChangementMcp =
  | { type: 'nouveau'; nom: string }
  | { type: 'inchange'; nom: string }
  | { type: 'schema_change'; nom: string; consentementsTombes: number }
  | { type: 'disparu'; nom: string; consentementsTombes: number };

export function planifierImport(
  annonces: OutilAnnonce[],
  existants: OutilBibliotheque[],
): ChangementMcp[];

/**
 * Le nom LOCAL d'un outil importé : `<prefixe_serveur>_<nom_distant_normalisé>`, tronqué à 64,
 * suffixé si `pris` le contient déjà. Le nom distant, lui, ne bouge pas : il reste dans
 * `binding.outilDistant` et c'est LUI qu'on envoie au serveur.
 */
export function nommerOutilImporte(libelleSource: string, nomDistant: string, pris: Set<string>): string;
```

- [ ] **Step 1 : écrire les tests qui échouent**

```ts
import { describe, it, expect } from 'vitest';
import { planifierImport, nommerOutilImporte } from '../src/agent/mcp/import';

const annonce = (name: string, schema: unknown) => ({ name, inputSchema: schema as Record<string, unknown> });
const SCHEMA_A = { type: 'object', properties: { q: { type: 'string' } } };
const SCHEMA_B = { type: 'object', properties: { q: { type: 'string' }, page: { type: 'integer' } } };

const existant = (nomDistant: string, schema: unknown, consommateurs = 2) => ({
  id: 'o1', name: `notion_${nomDistant}`, binding: { outilDistant: nomDistant },
  mcpAnnonce: { name: nomDistant, inputSchema: schema },
  consommateurs: Array.from({ length: consommateurs }, (_, i) => ({ cle: `agent:${i}`, actif: true })),
});

describe('planifier un import MCP', () => {
  it('un schema CHANGE fait tomber le consentement, parce qu un outil dont le schema a change n est plus l outil autorise', () => {
    const plan = planifierImport([annonce('search', SCHEMA_B)], [existant('search', SCHEMA_A)] as never);
    expect(plan).toEqual([{ type: 'schema_change', nom: 'search', consentementsTombes: 2 }]);
  });

  it('un outil DISPARU est marque indisponible, pas supprime : la ligne est la trace de ce qui a tourne', () => {
    const plan = planifierImport([], [existant('search', SCHEMA_A)] as never);
    expect(plan).toEqual([{ type: 'disparu', nom: 'search', consentementsTombes: 2 }]);
  });

  it('un outil inchange ne touche a aucun consentement', () => {
    const plan = planifierImport([annonce('search', SCHEMA_A)], [existant('search', SCHEMA_A)] as never);
    expect(plan).toEqual([{ type: 'inchange', nom: 'search' }]);
  });

  it('deux serveurs qui exposent chacun un `search` produisent deux noms distincts', () => {
    // 🔴 `agent_tools.name` est unique par ESPACE depuis 0127. Sans le prefixe, le deuxieme serveur
    // branche echouerait a l import sur une contrainte d unicite, ce qui est illisible pour le client.
    expect(nommerOutilImporte('Notion', 'search', new Set())).toBe('notion_search');
    expect(nommerOutilImporte('Jira', 'search', new Set(['notion_search']))).toBe('jira_search');
  });

  it('normalise un nom distant hors charset, et desambigue une collision apres troncature', () => {
    // Le charset de `agent_tools.name` est `^[a-z0-9_]{1,64}$` ; MCP n en impose aucun.
    expect(nommerOutilImporte('Notion', 'searchPages.v2', new Set())).toBe('notion_searchpages_v2');
    expect(nommerOutilImporte('Notion', 'search', new Set(['notion_search']))).toBe('notion_search_2');
  });
});
```

⚠️ **Le préfixage vit ici, pas dans l'aplatisseur.** `aplatirSchema` nomme les FEUILLES d'un outil ; `nommerOutilImporte` nomme l'OUTIL dans l'espace. Deux portées d'unicité différentes, deux fonctions.

Et le cas de la troncature, qui n'est pas dans le plan pur mais dans l'appel des routes :

```ts
it('un catalogue TRONQUE le DIT : un plafond silencieux se lit comme une couverture complete', async () => {
  // `SessionMcp.lister()` rend `{ outils, tronque }`. La route repropage `tronque` dans sa reponse,
  // et l ecran l affiche. Un import qui s arrete a 500 outils sans le dire donnerait un client
  // convaincu d avoir tout son catalogue.
});
```

- [ ] **Step 2 : les lancer, vérifier qu'ils échouent**

```bash
npx vitest run tests/mcp-import.test.ts
```

- [ ] **Step 3 : écrire l'import**

`planifierImport` est **pure** : elle compare et rend un plan. L'écriture est séparée, sur le patron de l'aperçu de publication chez Meta, où « écraser n'est acceptable que si l'on montre QUOI avant de le faire ».

- [ ] **Step 4 : les routes**

`src/http/agent-mcp.ts`, toutes sous `:tenantId`, garde **requise** par le type (jamais `garde?`), écritures réservées aux admins :

| Route | Rôle |
|---|---|
| `POST /agents/:tenantId/mcp/eprouver` | `initialize` seul. Rend la version négociée, ou le refus nommé pour l'ancien transport |
| `POST /agents/:tenantId/mcp/:sourceId/importer` | Suit la pagination, stocke tout, rend le plan appliqué |
| `GET /agents/:tenantId/mcp/:sourceId/apercu` | Le plan **sans** l'appliquer |
| `PATCH /agents/:tenantId/mcp/outils/:outilId` | Le réglage : sources des paramètres, risque, `nePasUtiliser` |

Elles entrent au registre `modulesDeRoutes` de `src/server.ts` avec `acces: 'tenant'`, sans quoi le garde-fou ne les couvre pas. `tests/scope-tenant.test.ts` monte chaque module un par un et compare la classe DÉCLARÉE aux adresses réellement montées : il doit rester vert.

⚠️ Les routes d'import et de rafraîchissement sont **lourdes** (réseau, pagination, écritures en masse) : elles portent `RATE_LIMIT_COUTEUX_PAR_MINUTE`, comme l'import CSV et l'aperçu de site.

- [ ] **Step 5 : relancer**

```bash
npx vitest run tests/mcp-import.test.ts tests/scope-tenant.test.ts && npm run typecheck
```

- [ ] **Step 6 : commiter**

```bash
git commit --only src/agent/mcp/import.ts src/http/agent-mcp.ts src/server.ts tests/mcp-import.test.ts -m "feat(mcp): importer un catalogue, et dire ce qui a change au rafraichissement"
```

---

## Task 8 : l'écran

**Files:**
- Create: `web/app/connecteurs-mcp/page.tsx`, `web/components/McpServeurs.tsx`, `web/components/McpOutilReglage.tsx`, `web/lib/api-mcp-connecteurs.ts`
- Modify: `web/lib/nav.ts`, `web/components/AppShell.tsx` (le type `Tab`)
- Test: `web/e2e/connecteurs-mcp.spec.ts`

**Interfaces:**
- Consumes: les quatre routes de la Task 7.

- [ ] **Step 1 : écrire l'essai qui échoue**

```ts
test('un serveur MCP se declare, s eprouve, et ses outils non activables disent POURQUOI', async ({ page }) => {
  // ... déclaration, épreuve, import
  await expect(page.getByTestId('mcp-outil-non-activable')).toContainText('lignes');
});

test('l ecran DIT que le MBA ne peut pas recevoir ces outils, il ne grise pas une case sans raison', async ({ page }) => {
  await expect(page.getByTestId('mcp-note-mba')).toBeVisible();
});
```

- [ ] **Step 2 : le lancer, vérifier qu'il échoue**

```bash
cd web && npx playwright test e2e/connecteurs-mcp.spec.ts
```

- [ ] **Step 3 : l'entrée de menu**

Dans `web/lib/nav.ts`, sous `tools`, après `connecteurs`. Le commentaire du menu annonce déjà MCP (« MCP viendra s'ajouter dans ce menu, à côté ») : le mettre à jour pour qu'il décrive le présent.

```tsx
{ key: 'connecteurs-mcp', href: '/connecteurs-mcp', label: t('Connecteurs MCP', 'MCP connectors') },
```

⚠️ **Ne pas toucher à `Developers > Serveur MCP`**, qui décrit le sens INVERSE (ce que nous exposons). Les deux ne partagent aucun mot à part MCP, et c'est ce qui les distingue.

- [ ] **Step 4 : les écrans**

`McpServeurs` liste les serveurs avec `last_ok_at` / `last_error`, le bouton **Rafraîchir**, et l'aperçu du plan avant application. `McpOutilReglage` montre le schéma complet, la source de chaque feuille (liste déroulante des champs déclarés de l'espace pour `contact`), et **l'avertissement au clouage** sur un paramètre que le schéma distant déclare obligatoire.

La note MBA est du texte, pas un état grisé :

```tsx
{/* ⚠️ ON LE DIT, ON NE GRISE PAS. Meta n'accepte pas MCP : une case désactivée sans explication enverrait
    le client ouvrir un ticket. */}
<p data-testid="mcp-note-mba" className="text-xs text-ink-500">
  {t('Ces outils servent vos agents IA. L’agent de Meta ne peut pas les recevoir : Meta n’accepte pas encore de connexion MCP.',
     'These tools serve your AI agents. Meta’s agent cannot receive them: Meta does not accept MCP connections yet.')}
</p>
```

- [ ] **Step 5 : le bandeau de l'agent doit dire qu'un outil a été désactivé**

La page d'un agent porte déjà un bandeau de manques (`MbaNotice` de testid `agent-manques`, alimenté par
`lireManques` / `ManqueFiche`). Un outil dont le consentement est tombé au rafraîchissement doit y produire
un manque nommé, sans quoi le client ne l'apprend qu'en constatant que son agent ne sait plus faire quelque
chose.

```ts
test('un outil MCP desactive par un rafraichissement apparait dans le bandeau de l agent', async ({ page }) => {
  await page.goto('/agents');
  await expect(page.getByTestId('agent-manques')).toContainText('notion_search');
});
```

- [ ] **Step 6 : réparer les TROIS textes de l'assistant qui annoncent que MCP n'existe pas**

🔴 **Rayon de souffle trouvé à l'inventaire, et il serait passé inaperçu.** L'assistant de configuration
d'agent propose déjà l'action `outil_mcp`, avec des textes qui deviennent **faux** le jour où ce lot est
déployé (`src/agent/setup/couverture.ts`) :

| Endroit | Ce qu'il dit aujourd'hui |
|---|---|
| `CHOIX_ACTION` | « appeler un outil branché par MCP (pas encore disponible : ce serait à brancher) » |
| Le commentaire de tête | « `outil_mcp` est proposé alors que MCP N'EST PAS ENCORE CÂBLÉ (lot L4, non développé) » |
| La branche `action === 'outil_mcp'` | « MCP n'est PAS encore disponible sur cette console » |

Les trois se corrigent ensemble, et la branche se met à ressembler à celle d'`outil_api` : elle énumère les
serveurs déclarés (`inv.mcp`, champ qui existe déjà) et les outils appelables. **Corriger un compte à un
endroit et le laisser à deux autres, c'est le laisser faux.**

- [ ] **Step 7 : relancer**

```bash
npx vitest run tests/agent-setup-couverture.test.ts && cd web && npx playwright test e2e/connecteurs-mcp.spec.ts && npm run build
```

- [ ] **Step 8 : commiter**

```bash
git commit --only web/app/connecteurs-mcp/page.tsx web/components/McpServeurs.tsx web/components/McpOutilReglage.tsx web/lib/api-mcp-connecteurs.ts web/lib/nav.ts web/components/AppShell.tsx web/e2e/connecteurs-mcp.spec.ts src/agent/setup/couverture.ts -m "feat(mcp): l ecran Connecteurs MCP, et l assistant cesse de dire que MCP n existe pas"
```

---

## Task 9 : revue, déploiement, essai réel

- [ ] **Step 1 : `/revue` sur l'ensemble du diff**, avec la section Rayon de souffle. Corriger 🔴 **et** 🟡 dans la foulée, zéro dette reportée.

- [ ] **Step 2 : `gh run view <id> --json jobs`**, job par job. `gh run watch --exit-status` ment, il a déjà rendu 0 sur un run en échec.

- [ ] **Step 3 : `/revue-finale`** : relecteur à froid séparé, contre-vérification de chaque 🔴, attestation liée au commit exact. La garde `hooks/deploiement-garde.js` refuse un déploiement qui ne la porte pas.

- [ ] **Step 4 : déployer**, dans cet ordre, la migration AJOUTANT des colonnes que le code écrit :

```bash
ssh -i ~/.ssh/id_ed25519 ubuntu@146.59.233.252
cd /home/ubuntu/mba && git pull
sudo docker compose build mba-api
sudo docker compose run --rm --no-deps mba-api npm run migrate
sudo docker compose up -d --build
```

Puis, **séparément**, le rechargement nginx (le 502 public après un `up --build` est arrivé plusieurs fois, NPM tenant l'ancienne IP) :

```bash
sudo docker exec mcp-robot_nginx-proxy-manager_1 nginx -s reload
```

Puis `node scripts/fumee.mjs`, et la vérification du module déployé **dans le conteneur**, pas déduite du fait qu'on vient de pousser.

- [ ] **Step 5 : l'essai réel**

Déclarer `https://api.messagingme.app/mcp` comme serveur MCP, authentification `bearer` avec une clé d'API de l'espace. Importer. Clouer le paramètre de `get_contact` au numéro du contact. L'activer sur un agent IA. Puis, **depuis un vrai WhatsApp**, poser à l'agent une question dont la réponse exige l'appel, et vérifier deux choses : qu'il répond, et qu'il répond avec la donnée du **bon** contact. Puis demander explicitement la donnée d'un AUTRE numéro, et vérifier qu'il ne l'obtient pas.

- [ ] **Step 6 : `/sync`**, et consigner dans `brain/LEARNINGS.md` ce que ce chantier aura appris.
