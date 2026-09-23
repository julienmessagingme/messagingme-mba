# Refactor des écrans d'agent : en-tête identitaire et sous-menu vertical

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** donner aux deux écrans de réglage d'agent (l'agent de Meta et un agent IA) un en-tête qui identifie l'agent, dit ce qui lui manque et combien de messages il a échangés, et faire descendre leurs onglets en colonne à gauche du contenu.

**Architecture:** deux composants partagés plutôt que deux copies. `EnteteAgent` est purement présentationnel et ne lit rien ; `MbaTabs` gagne une prop d'orientation optionnelle et garde ses `data-testid`, ce qui laisse passer les suites e2e sans les toucher. Le chiffre de messages vient de deux routes neuves, sans migration, et l'en-tête tolère leur absence.

**Tech Stack:** Next.js 15 (App Router, `'use client'`), Tailwind, Fastify, Postgres (`pg`), vitest (unitaire et intégration), Playwright (e2e).

**Spec:** [docs/superpowers/specs/2026-09-23-refactor-ecrans-agents-design.md](../specs/2026-09-23-refactor-ecrans-agents-design.md)

## Global Constraints

- **Arbre de travail PARTAGÉ entre sessions.** Committer avec `git commit --only <chemins>`, la liste construite depuis ce qu'on a touché soi-même, JAMAIS depuis `git status`. Contrôle avant chaque commit : `git diff <ses chemins>` pour vérifier que le contenu est encore le sien.
- **`src/index.ts` est un fichier de câblage partagé** : ANNONCER à l'autre session avant de l'éditer, et avant tout `git checkout --` dessus. Il est déjà modifié dans l'arbre au moment où ce plan est écrit.
- **Aucun tiret cadratin ni demi-cadratin**, nulle part : ni code, ni commentaire, ni message de commit, ni texte d'écran.
- **Jamais « UChat »** dans un texte visible par un client.
- **`npm run test:integration` ne se lance JAMAIS en local** : le `DATABASE_URL` du `.env` pointe sur la PRODUCTION. Ces tests tournent en CI, sur un Postgres jetable. Après un push, lire `gh run view <id> --json jobs`, jamais le code de sortie de `gh run watch`.
- **Tout sur `main`**, pas de branche, pas de worktree.
- **Le dépôt est PUBLIC** : aucun secret, aucune adresse IP dans un fichier committé.
- **Zéro dette** : les 🔴 se corrigent avant usage, les 🟡 aussi, dans la foulée.

---

## Ce que le relevé du code a démenti dans la spec

Trois points ont été mesurés après l'écriture de la spec et changent le travail. Ils sont intégrés aux tâches ci-dessous, mais il faut les avoir en tête avant de commencer.

🔴 **1. Rendre DEUX copies de la liste d'onglets casserait la suite e2e.** La spec dit « sous `lg`, la colonne redevient la barre horizontale ». Si on implémente ça par deux blocs (`hidden lg:flex` et `lg:hidden`), les deux sont dans le DOM et chaque `data-testid="mba-tab-X"` existe en double. `web/e2e/mba-parametres-gate.spec.ts:14` fait `toHaveCount(0)` (donc rendrait 2 au lieu de 0 dans les cas bloqués) et les onze `.click()` tomberaient en violation de mode strict. **Une seule liste est rendue, et seules ses classes changent.**

🔴 **2. La liste des agents ne connaît pas le modèle.** `AgentResume` ne porte ni `modele` côté front (`web/lib/api-agent.ts:11-17`) ni côté serveur (`src/agent/agent-store.ts:79-84`), et la projection SQL commune ne lit pas la colonne (`src/agent/agent-store.pg.ts:66-85`). Le logo dans la liste, que Julien a demandé, exige donc un changement SERVEUR. C'est la Task 6.

🔴 **3. Les deux modules de routes sont montés avec `g.admin`** (`src/server.ts:475` et `:517`). Les deux routes neuves seront donc admin seulement, et un compte manager ou agent recevra 403. L'en-tête doit traiter 403 exactement comme 404 : pas de chiffre, aucune erreur affichée.

---

## File Structure

**Créés :**

| Fichier | Responsabilité |
|---|---|
| `web/lib/logos-llm.ts` | Le logo d'un modèle, dérivé du préfixe de son identifiant. Aucune dépendance React. |
| `web/public/llm/*.svg` | Les marques des fournisseurs, servies par nous. |
| `web/components/EnteteAgent.tsx` | L'en-tête présentationnel, commun aux deux écrans. |
| `tests/web-mbatabs-parite.test.ts` | Garde de forme sur `MbaTabs` (une seule liste rendue, défaut horizontal). |
| `tests/web-logos-llm.test.ts` | Garde de complétude : tout fournisseur du catalogue a un logo, ou déclare pourquoi il n'en a pas. |
| `tests/integration/mba-messages.integration.test.ts` | La requête de comptage de l'agent de Meta, contre une vraie base. |

**Modifiés :**

| Fichier | Ce qui change |
|---|---|
| `web/components/MbaTabs.tsx` | Prop `orientation` optionnelle, une seule liste rendue. |
| `web/app/mba/parametres/page.tsx` | En-tête identitaire, grille à deux colonnes, `MbaCompletion` remplacé. |
| `web/app/agents/page.tsx` | Idem, plus le logo sur chaque ligne de la liste. |
| `web/lib/api-agent.ts` | `AgentResume.modele`, et le client de la route de comptage. |
| `web/lib/api-mba.ts` | Le client de la route de comptage MBA. |
| `src/agent/agent-store.ts` / `.pg.ts` | `modele` dans la projection des résumés. |
| `src/agent/session-store.ts` / `.pg.ts` | `messagesTenus`, la requête de comptage par agent. |
| `src/stats/store.pg.ts` | `messagesTenusParMba`, la requête de comptage de l'agent de Meta. |
| `src/http/agents.ts` | La route `GET .../agents/:agentId/messages`. |
| `src/http/mba.ts` | La route `GET .../mba/:phoneNumberId/messages`. |
| `src/index.ts` | Le câblage des deux nouvelles dépendances. ⚠️ Fichier partagé. |
| `web/e2e/support/mba.ts` | Les branches de faux backend pour `/completion` et `/messages`. |

---

### Task 1: `MbaTabs` sait se rendre en colonne, sans doubler son marquage

**Files:**
- Modify: `web/components/MbaTabs.tsx:14-39`
- Test: `tests/web-mbatabs-parite.test.ts` (créer)

**Interfaces:**
- Consumes: rien.
- Produces: `MbaTabs({ tabs, active, onSelect, orientation })` où `orientation?: 'horizontale' | 'verticale'` vaut `'horizontale'` par défaut. L'interface `MbaTab { key: string; label: string }` ne change pas.

- [ ] **Step 1: Écrire le test qui échoue**

Ce test lit le TEXTE du composant. C'est l'idiome du dépôt pour garder une propriété de forme d'un fichier de `web/` depuis les tests unitaires de la racine (voir `tests/web-field-kinds-parity.test.ts`).

```ts
// tests/web-mbatabs-parite.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * 🔴 UNE SEULE LISTE RENDUE, QUELLE QUE SOIT L'ORIENTATION.
 *
 * Le passage des onglets en colonne invite à rendre deux blocs (`hidden lg:flex` et `lg:hidden`). Ce serait
 * la pire façon de le faire : les deux vivent dans le DOM, donc CHAQUE `data-testid="mba-tab-<cle>"` existe
 * en double. `web/e2e/mba-parametres-gate.spec.ts:14` exige `toHaveCount(0)` sur un écran bloqué et en
 * lirait 2 ; les onze `.click()` des cinq suites tomberaient en violation de mode strict Playwright.
 *
 * Ce test compte les occurrences du gabarit de testid dans la source. Il doit y en avoir EXACTEMENT UNE.
 */
const SRC = readFileSync(join(resolve(__dirname, '..'), 'web', 'components', 'MbaTabs.tsx'), 'utf8');

describe('MbaTabs', () => {
  it('🔴 ne rend le gabarit de data-testid QU UNE SEULE FOIS', () => {
    const occurrences = SRC.split('data-testid={`mba-tab-').length - 1;
    expect(occurrences, 'deux listes rendues feraient exister chaque testid en double, et cinq suites e2e '
      + 'tomberaient en violation de mode strict').toBe(1);
  });

  it('accepte une orientation, et son DEFAUT est horizontal', () => {
    // Le défaut compte autant que la prop : sans lui, les deux appelants existants changeraient de rendu
    // le jour du refactor, alors que ce lot veut que rien ne bouge tant qu'on ne le demande pas.
    expect(SRC).toContain('orientation');
    expect(SRC).toMatch(/orientation\s*=\s*'horizontale'/);
  });

  it('garde le gabarit de testid mot pour mot', () => {
    // Cinq suites e2e s'appuient dessus. Le renommer est la seule façon de rendre ce refactor cher.
    expect(SRC).toContain('data-testid={`mba-tab-${tab.key}`}');
  });
});
```

- [ ] **Step 2: Lancer le test et vérifier qu'il ÉCHOUE**

Run: `npx vitest run tests/web-mbatabs-parite.test.ts`
Expected: FAIL sur le cas « accepte une orientation » (le mot `orientation` n'existe pas dans le fichier). Les deux autres passent déjà, ce qui est normal : ils gardent l'existant.

- [ ] **Step 3: Écrire le composant**

Remplacer le corps de `web/components/MbaTabs.tsx` à partir de la ligne 14 :

```tsx
/**
 * L'orientation du menu. 🔴 ELLE NE CHANGE QUE DES CLASSES, jamais le marquage : une seule liste est
 * rendue dans les deux cas. Rendre une colonne ET une barre ferait exister chaque `data-testid` en double,
 * ce que `tests/web-mbatabs-parite.test.ts` refuse et que cinq suites e2e paieraient.
 *
 * ⚠️ Le repli sous `lg` est porté par les classes elles-memes, pas par un second bloc : en colonne, le
 * composant est `flex-row` par defaut et `lg:flex-col`, donc un telephone retrouve exactement la barre
 * horizontale d'aujourd'hui, avec le meme defilement.
 */
export type OrientationOnglets = 'horizontale' | 'verticale';

export function MbaTabs({ tabs, active, onSelect, orientation = 'horizontale' }: {
  tabs: MbaTab[];
  active: string;
  onSelect: (key: string) => void;
  orientation?: OrientationOnglets;
}) {
  const vertical = orientation === 'verticale';
  /**
   * ⚠️ `-mb-px` ET `border-b` SONT UN COUPLE. En horizontal, le `-mb-px` du bouton fait chevaucher sa
   * bordure basse active sur le trait du conteneur. En colonne, il n'y a plus de trait bas a chevaucher :
   * garder le couple laisserait un decalage d'un pixel sur chaque entree.
   */
  const conteneur = vertical
    ? 'flex gap-1 overflow-x-auto lg:flex-col lg:overflow-x-visible'
    : 'flex gap-1 overflow-x-auto border-b border-ink-200';
  const base = vertical
    ? 'shrink-0 whitespace-nowrap rounded-lg px-3 py-2 text-left text-sm transition lg:w-full'
    : '-mb-px shrink-0 whitespace-nowrap border-b-2 px-3 py-2 text-sm transition';
  const actif = vertical
    ? 'bg-brand-50 font-medium text-brand-700'
    : 'border-brand-500 font-medium text-brand-700';
  const inactif = vertical
    ? 'text-ink-600 hover:bg-ink-100 hover:text-ink-900'
    : 'border-transparent text-ink-500 hover:text-ink-800';

  return (
    <div
      className={conteneur}
      role="tablist"
      aria-orientation={vertical ? 'vertical' : 'horizontal'}
    >
      {tabs.map((tab) => {
        const courant = tab.key === active;
        return (
          <button
            key={tab.key}
            role="tab"
            aria-selected={courant}
            data-testid={`mba-tab-${tab.key}`}
            onClick={() => onSelect(tab.key)}
            className={`${base} ${courant ? actif : inactif}`}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
```

⚠️ Les classes actives et inactives du mode vertical sont celles des DEUX menus verticaux qui existent déjà (`web/components/AppShell.tsx:154-157` et `web/components/InboxDossiers.tsx:74-82`). Ne pas en inventer d'autres : c'est le même vocabulaire de style dans toute la console.

- [ ] **Step 4: Lancer le test et le typecheck**

Run: `npx vitest run tests/web-mbatabs-parite.test.ts && npm run typecheck`
Expected: PASS sur les trois cas, typecheck propre. Les deux appelants existants ne passent pas `orientation`, donc ils gardent le rendu horizontal au pixel près.

- [ ] **Step 5: Commit**

```bash
git commit --only web/components/MbaTabs.tsx tests/web-mbatabs-parite.test.ts -m "feat(onglets): MbaTabs sait se rendre en colonne, sans doubler son marquage"
```

---

### Task 2: le logo d'un modèle, et la garde qui empêche d'en oublier un

**Files:**
- Create: `web/lib/logos-llm.ts`
- Create: `web/public/llm/openai.svg`, `anthropic.svg`, `google.svg`, `mistral.svg`, `zai.svg`
- Test: `tests/web-logos-llm.test.ts` (créer)

**Interfaces:**
- Consumes: rien.
- Produces: `logoDuModele(modele: string): { src: string; alt: string } | null` et `pastilleDuModele(modele: string): string`. Les deux sont pures et sans React.

- [ ] **Step 1: Écrire le module**

```ts
// web/lib/logos-llm.ts
/**
 * LE LOGO D'UN MODÈLE, dérivé du PRÉFIXE de son identifiant (`anthropic/claude-haiku-4.5` -> `anthropic`).
 *
 * 🔴 IL NE SE DEVINE PAS DU NOM LISIBLE. Le catalogue rend un `nom` maison (« Claude Haiku 4.5 ») qui ne
 * contient pas toujours le fournisseur, et un agent peut porter un modèle « en place, hors liste » que le
 * catalogue ne décrit plus du tout. Le seul porteur fiable du fournisseur est l'identifiant lui-même.
 *
 * ⚠️ `null` EST UN CAS NORMAL, pas une panne : un fournisseur qui entre au catalogue sans que son fichier
 * soit ajouté, ou un identifiant sans préfixe. L'appelant retombe alors sur la pastille typographique.
 */
const LOGOS: ReadonlyMap<string, string> = new Map([
  ['openai', 'OpenAI'],
  ['anthropic', 'Anthropic'],
  ['google', 'Google'],
  ['mistral', 'Mistral AI'],
  ['zai', 'Z.ai'],
]);

/** Le fournisseur d'un identifiant de modèle, ou `null` s'il n'en porte pas. */
export function fournisseurDuModele(modele: string): string | null {
  const i = modele.indexOf('/');
  if (i <= 0) return null;
  return modele.slice(0, i).toLowerCase();
}

export function logoDuModele(modele: string): { src: string; alt: string } | null {
  const f = fournisseurDuModele(modele);
  if (f === null) return null;
  const marque = LOGOS.get(f);
  if (marque === undefined) return null;
  /**
   * ⚠️ `alt` VIDE, ET CE N'EST PAS UN OUBLI. Ce logo est DÉCORATIF : le nom du modèle est écrit juste à
   * côté, en toutes lettres. Un `alt` renseigné entrerait dans le nom accessible du bouton qui porte
   * l'image, et `web/e2e/agents-modele.spec.ts:51` ouvre justement la fiche par
   * `getByRole('button', { name: /Conseiller séjours/ })`. Un `alt="Anthropic"` ferait échouer ce test, et
   * avec lui tout le fichier, son clic vivant dans un helper commun.
   */
  return { src: `/llm/${f}.svg`, alt: '' };
}

/** Le repli quand aucun logo ne convient : deux ou trois lettres, jamais un nom tronqué au hasard. */
export function pastilleDuModele(modele: string): string {
  const f = fournisseurDuModele(modele);
  if (f === null) return modele.slice(0, 2).toUpperCase();
  return f.slice(0, 2).toUpperCase();
}
```

- [ ] **Step 2: Écrire le test de complétude, qui échoue**

```ts
// tests/web-logos-llm.test.ts
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { MODELES_CHOISIS } from '../src/agent/modeles';
import { fournisseurDuModele, logoDuModele, pastilleDuModele } from '../web/lib/logos-llm';

/**
 * 🔴 TOUT FOURNISSEUR DU CATALOGUE A UN LOGO, OU DIT POURQUOI IL N'EN A PAS.
 *
 * Sans ce test, ajouter un modèle d'un fournisseur neuf au catalogue donnerait une pastille grise dans
 * l'en-tête, en silence, et personne ne le saurait avant de tomber dessus. C'est le même motif que la liste
 * des sections d'aide sans fiche : l'absence doit être une DÉCISION, pas un oubli.
 */
const RACINE = resolve(__dirname, '..');
const DOSSIER = join(RACINE, 'web', 'public', 'llm');

/** Les fournisseurs qu'on assume SANS logo, avec la raison. Vide aujourd'hui, et c'est le but. */
const SANS_LOGO: ReadonlyMap<string, string> = new Map([]);

describe('les logos de fournisseurs de modèles', () => {
  it('🔴 chaque fournisseur du catalogue a son fichier, ou sa dispense écrite', () => {
    const manquants = [...new Set(MODELES_CHOISIS.map((m) => fournisseurDuModele(m.id)))]
      .filter((f): f is string => f !== null)
      .filter((f) => !existsSync(join(DOSSIER, `${f}.svg`)) && !SANS_LOGO.has(f));
    expect(manquants, 'fournisseur(s) du catalogue sans logo : déposez `web/public/llm/<fournisseur>.svg`, '
      + 'ou inscrivez-le dans SANS_LOGO avec sa raison').toEqual([]);
  });

  it('⚠️ et la dispense ne survit pas au fournisseur qu elle dispense', () => {
    // Sans ce sens-là, retirer un modèle du catalogue laisserait une dispense permanente pour un
    // fournisseur qui n'existe plus, pendant qu'un neuf passerait inaperçu.
    const reels = new Set(MODELES_CHOISIS.map((m) => fournisseurDuModele(m.id)));
    expect([...SANS_LOGO.keys()].filter((f) => !reels.has(f))).toEqual([]);
  });

  it('le logo se dérive du PRÉFIXE, et son alt est VIDE', () => {
    const l = logoDuModele('anthropic/claude-haiku-4.5');
    expect(l).toEqual({ src: '/llm/anthropic.svg', alt: '' });
  });

  it('🔴 un modèle hors catalogue ou sans préfixe rend null, il ne jette pas', () => {
    // Un agent peut porter un modèle « en place, hors liste » : c'est un cas NORMAL de cet écran.
    expect(logoDuModele('fournisseur-inconnu/modele-x')).toBeNull();
    expect(logoDuModele('un-modele-sans-slash')).toBeNull();
    expect(logoDuModele('')).toBeNull();
  });

  it('la pastille de repli rend toujours quelque chose de lisible', () => {
    expect(pastilleDuModele('fournisseur-inconnu/modele-x')).toBe('FO');
    expect(pastilleDuModele('un-modele-sans-slash')).toBe('UN');
  });
});
```

- [ ] **Step 3: Lancer le test et vérifier qu'il ÉCHOUE**

Run: `npx vitest run tests/web-logos-llm.test.ts`
Expected: FAIL sur le premier cas, avec les cinq fournisseurs listés (`web/public/llm/` n'existe pas encore).

- [ ] **Step 4: Déposer les cinq fichiers**

Créer `web/public/llm/` et y déposer un SVG par fournisseur, nommé exactement `openai.svg`, `anthropic.svg`, `google.svg`, `mistral.svg`, `zai.svg`.

Contraintes sur chaque fichier, à respecter sans exception :
- **Une marque monochrome**, tracée en `currentColor`, sans texte, dans un `viewBox="0 0 24 24"`. Elle est rendue à 20 px dans la liste et à 40 px dans l'en-tête, elle doit rester lisible aux deux tailles.
- **Aucun attribut `width` ni `height`** sur la racine : la taille vient de la classe Tailwind de l'appelant.
- **Moins de 4 Ko** par fichier. Un logo vectorisé à la truelle fait dix fois ça et part dans le bundle servi à chaque client.
- **Prendre la marque OFFICIELLE du fournisseur**, depuis sa page de ressources de marque. Ne pas redessiner de mémoire : un logo approximatif est pire qu'une pastille, il a l'air juste.
- Si la marque d'un fournisseur n'est pas récupérable au moment de l'implémentation, **ne pas inventer** : inscrire ce fournisseur dans `SANS_LOGO` du test, avec sa raison en une phrase. La pastille prend le relais et le test reste vert.

- [ ] **Step 5: Lancer le test et le typecheck**

Run: `npx vitest run tests/web-logos-llm.test.ts && npm run typecheck`
Expected: PASS sur les cinq cas.

- [ ] **Step 6: Commit**

```bash
git commit --only web/lib/logos-llm.ts web/public/llm tests/web-logos-llm.test.ts -m "feat(agents): le logo d un modele se derive de son prefixe, et un fournisseur sans logo se declare"
```

---

### Task 3: `EnteteAgent`, l'en-tête commun aux deux écrans

**Files:**
- Create: `web/components/EnteteAgent.tsx`
- Test: `tests/web-entete-agent-parite.test.ts` (créer)

**Interfaces:**
- Consumes: `logoDuModele`, `pastilleDuModele` (Task 2).
- Produces: `EnteteAgent(props: EnteteAgentProps)` et `libelleEtapes(n: number, t: Traduire): string`.

- [ ] **Step 1: Écrire le composant**

```tsx
// web/components/EnteteAgent.tsx
'use client';

import type { ReactNode } from 'react';
import { useT } from '@/lib/i18n';

/**
 * L'EN-TÊTE D'UN ÉCRAN D'AGENT : qui est cet agent, ce qui lui manque, ce qu'il a produit.
 *
 * 🔴 PUREMENT PRÉSENTATIONNEL, ET C'EST TOUT L'INTÉRÊT. Il ne lit rien, n'appelle rien, et ne sait ni ce
 * qu'est l'agent de Meta ni ce qu'est un agent IA. Les deux écrans le remplissent depuis des sources
 * différentes (une route de complétion d'un côté, une liste de manques de l'autre) et obtiennent le même
 * dessin. Y mettre un `fetch` ferait deux comportements de chargement à tenir alignés à la main.
 */

export interface EtapeEntete {
  /** Ce qui manque, dans les mots du client. Rendu tel quel. */
  message: string;
  /** L'onglet où ça se corrige. Absent = ça ne se règle pas sur cet écran (le moyen de paiement). */
  onglet?: string;
}

export interface EnteteAgentProps {
  logo: { src: string; alt: string } | null;
  /** Le repli quand `logo` est nul : deux ou trois lettres. */
  pastille: string;
  nom: string;
  /** Sous le nom : le numéro pour l'agent de Meta, le modèle pour un agent IA. */
  precision?: string;
  /** L'état, rendu tel quel : la pastille d'activation d'un agent IA, celle du numéro côté Meta. */
  etat?: ReactNode;
  /** Ce qui reste à faire. Liste VIDE = tout est réglé, et l'en-tête le dit. */
  etapes: EtapeEntete[];
  /** Rendu en plus du compte, et SEULEMENT quand il existe un ratio vrai (l'agent de Meta en a un). */
  ratio?: { faites: number; total: number };
  /** `null` = on ne sait pas. On n'affiche alors AUCUN chiffre. Voir le commentaire plus bas. */
  messages30j: number | null;
  onOnglet(cle: string): void;
}

/**
 * 🔴 « n ÉTAPES À FINIR », PAS « n SUR m », ET CE N'EST PAS UN CHOIX DE STYLE.
 *
 * Côté agent IA, le dénominateur n'existe pas : `manquesAvantActivation` (src/agent/setup/lint.ts) applique
 * cinq contrôles inconditionnels et UN SIXIÈME conditionnel (« la base est remplie mais l'outil de recherche
 * est inactif », qui ne s'applique que s'il y a à la fois des fiches et des outils actifs). Le nombre de
 * contrôles qui s'appliquent varie donc d'un agent à l'autre, et la route ne rend que ce qui MANQUE. Figer
 * 5 ou 6 dans l'écran afficherait un dénominateur faux la moitié du temps.
 *
 * L'agent de Meta, lui, a un ratio VRAI (`faites` et `total` calculés au serveur) : il le montre EN PLUS.
 * L'asymétrie est dans la donnée, pas dans le dessin.
 */
export function libelleEtapes(n: number, t: (fr: string, en: string) => string): string {
  if (n === 0) return t('Tout est réglé', 'All set');
  if (n === 1) return t('1 étape à finir', '1 step left');
  return t(`${n} étapes à finir`, `${n} steps left`);
}

export function EnteteAgent({
  logo, pastille, nom, precision, etat, etapes, ratio, messages30j, onOnglet,
}: EnteteAgentProps) {
  const t = useT();
  return (
    <header
      data-testid="entete-agent"
      className="flex flex-col gap-4 rounded-2xl border border-ink-200 bg-white p-4 shadow-sm sm:flex-row sm:items-start sm:gap-5"
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- next/image mettrait en cache une URL signée
          qui expire (même contrainte que la photo de profil de l'Accueil), et nos SVG sont servis par nous. */}
      {logo !== null ? (
        <img src={logo.src} alt={logo.alt} data-testid="entete-agent-logo"
          className="h-10 w-10 shrink-0 text-ink-800" />
      ) : (
        <span data-testid="entete-agent-pastille"
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-ink-100 text-xs font-semibold text-ink-600">
          {pastille}
        </span>
      )}

      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="truncate text-xl font-semibold tracking-tight text-ink-900">{nom}</h2>
          {etat}
        </div>
        {precision !== undefined && precision !== '' && (
          <p data-testid="entete-agent-precision" className="truncate text-sm text-ink-600">{precision}</p>
        )}

        <p data-testid="entete-agent-etapes" className="pt-1 text-sm font-medium text-ink-800">
          {libelleEtapes(etapes.length, t)}
          {ratio !== undefined && (
            <span data-testid="entete-agent-ratio" className="ml-2 font-normal text-ink-500">
              {t(`${ratio.faites} sur ${ratio.total} réglages obligatoires`,
                 `${ratio.faites} of ${ratio.total} required settings`)}
            </span>
          )}
        </p>

        {etapes.length > 0 && (
          <ul className="space-y-1 pt-1">
            {etapes.map((e) => (
              <li key={e.message} className="text-sm text-ink-600">
                {/* ⚠️ UNE ÉTAPE SANS ONGLET RESTE AFFICHÉE, en texte simple. C'est le cas du moyen de
                    paiement, qui ne se règle pas dans la console : la masquer ferait disparaître une
                    condition réelle de l'écran qui prétend les lister toutes. */}
                {e.onglet === undefined ? (
                  <span>{e.message}</span>
                ) : (
                  <button
                    type="button"
                    data-testid={`entete-etape-${e.onglet}`}
                    onClick={() => onOnglet(e.onglet as string)}
                    className="text-left underline decoration-dotted hover:decoration-solid"
                  >
                    {e.message}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* 🔴 AUCUN CHIFFRE QUAND ON NE SAIT PAS. `null` couvre trois cas réels : la lecture n'a pas encore
          abouti, la route n'est pas encore déployée (Vercel publie l'écran au push, l'API attend son
          déploiement), et le compte n'est pas administrateur (les deux modules sont montés en `g.admin`,
          donc un manager reçoit 403). Un « 0 » se lirait « cet agent n'a parlé à personne ». */}
      {messages30j !== null && (
        <div data-testid="entete-agent-messages" className="shrink-0 text-right">
          <p className="text-2xl font-semibold tabular-nums text-ink-900">{messages30j.toLocaleString('fr-FR')}</p>
          <p className="text-xs text-ink-500">{t('messages échangés sur 30 jours', 'messages exchanged over 30 days')}</p>
        </div>
      )}
    </header>
  );
}
```

- [ ] **Step 2: Écrire le test**

```ts
// tests/web-entete-agent-parite.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * L'EN-TÊTE NE DOIT JAMAIS AFFICHER UN ZÉRO QU'IL N'A PAS MESURÉ.
 *
 * C'est la seule propriété de ce composant qui, si elle se perd, produit un mensonge à l'écran plutôt qu'un
 * défaut visible. Elle tient dans une garde `messages30j !== null` : ce test vérifie qu'elle est là, et que
 * personne ne l'a remplacée par un `?? 0` au premier avertissement de typage.
 */
const SRC = readFileSync(join(resolve(__dirname, '..'), 'web', 'components', 'EnteteAgent.tsx'), 'utf8');

describe('EnteteAgent', () => {
  it('🔴 n affiche le chiffre QUE s il est connu', () => {
    expect(SRC).toContain('messages30j !== null');
    expect(SRC, 'un `?? 0` transformerait « on ne sait pas » en « personne n a parlé »')
      .not.toMatch(/messages30j\s*\?\?\s*0/);
  });

  it('🔴 le ratio n est rendu que s il existe vraiment', () => {
    // Le dénominateur n'existe pas côté agent IA : le rendre systématiquement obligerait à en inventer un.
    expect(SRC).toContain('ratio !== undefined');
  });

  it('⚠️ une étape sans onglet reste affichée', () => {
    expect(SRC).toContain('e.onglet === undefined');
  });
});
```

- [ ] **Step 3: Lancer les tests et le typecheck**

Run: `npx vitest run tests/web-entete-agent-parite.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git commit --only web/components/EnteteAgent.tsx tests/web-entete-agent-parite.test.ts -m "feat(agents): l en-tete commun aux deux ecrans d agent"
```

---

### Task 4: le comptage des messages d'un agent IA

**Files:**
- Modify: `src/agent/session-store.ts:46-47` (déclaration) et `:174-182` (voisinage du type)
- Modify: `src/agent/session-store.pg.ts:224-257` (juste après `consommation`)
- Modify: `src/http/agents.ts:16` (constante) et `:18-63` (deps) et après `:146` (la route)
- Modify: `src/index.ts:1627` (câblage) ⚠️ **fichier partagé, annoncer avant**
- Test: `tests/http-agents.test.ts`, `tests/integration/agent-session-store.integration.test.ts`

**Interfaces:**
- Consumes: rien.
- Produces: `AgentsRouteDeps.messagesAgent?(tenantId: string, agentId: string, jours: number): Promise<number>` et la route `GET /tenants/:tenantId/agents/:agentId/messages` qui rend `{ messages: number | null, jours: number }`.

- [ ] **Step 1: Écrire le test de route qui échoue**

Dans `tests/http-agents.test.ts`, à la suite des tests existants :

```ts
describe('GET /tenants/:tenantId/agents/:agentId/messages', () => {
  it('rend le compte et la fenêtre', async () => {
    const app = await monter({ ...depsDeBase(), messagesAgent: async () => 412 });
    const r = await app.inject({ method: 'GET', url: `/tenants/${TENANT}/agents/${AGENT}/messages` });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ messages: 412, jours: 30 });
  });

  it('🔴 rend null, PAS zéro, quand la dépendance est absente', () => {
    // Même convention que `/consommation` juste à côté : un zéro se lirait « cet agent n a parlé à
    // personne », alors que la vérité est « cette instance ne sait pas compter ».
    return monter(depsDeBase()).then(async (app) => {
      const r = await app.inject({ method: 'GET', url: `/tenants/${TENANT}/agents/${AGENT}/messages` });
      expect(r.statusCode).toBe(200);
      expect(r.json()).toEqual({ messages: null, jours: 30 });
    });
  });

  it('🔴 refuse un identifiant d agent mal formé AVANT de toucher au store', async () => {
    // Un identifiant non-uuid dans un `where` sur une colonne uuid fait LEVER Postgres (500), il ne rend
    // pas zéro. L'ordre des gardes n'est pas décoratif.
    let appele = false;
    const app = await monter({ ...depsDeBase(), messagesAgent: async () => { appele = true; return 1; } });
    const r = await app.inject({ method: 'GET', url: `/tenants/${TENANT}/agents/pas-un-uuid/messages` });
    expect(r.statusCode).toBe(404);
    expect(appele).toBe(false);
  });
});
```

⚠️ Reprendre les helpers `monter`, `depsDeBase`, `TENANT` et `AGENT` tels que le fichier les définit déjà (ils existent : la fixture d'un `AgentsRouteDeps` littéral est à `tests/http-agents.test.ts:61`). Ne pas en créer de seconds.

- [ ] **Step 2: Lancer et vérifier l'échec**

Run: `npx vitest run tests/http-agents.test.ts`
Expected: FAIL, 404 sur une route qui n'existe pas.

- [ ] **Step 3: Déclarer la dépendance et écrire la route**

Dans `src/http/agents.ts`, ajouter à `AgentsRouteDeps`, à côté de `consommationAgent` :

```ts
  /**
   * Les messages échangés dans les conversations que cet agent a tenues, sur une fenêtre de N jours.
   *
   * ⚠️ OPTIONNELLE, comme `consommationAgent` juste au-dessus, et pour la même raison : deux fixtures de
   * test construisent un littéral complet de cette interface (`tests/http-agents.test.ts:61`,
   * `tests/agent-setup-lint.test.ts:118`). La rendre requise les casserait sans rien acheter, et l'écran
   * sait déjà ne rien afficher quand le chiffre manque.
   */
  messagesAgent?(tenantId: string, agentId: string, jours: number): Promise<number>;
```

Puis, juste après la route `/consommation` (`src/http/agents.ts:146`) :

```ts
  /**
   * Combien de messages ont été échangés dans les conversations que cet agent a tenues.
   *
   * 🔴 LA MÊME FENÊTRE QUE LA CONSOMMATION, et c'est ce qui rend les deux chiffres comparables : ils sont
   * lus sur le même écran. `jours` est RENDU par le serveur, jamais deviné par l'écran, exactement comme
   * `ConsommationAgent.jours`.
   *
   * ⚠️ `messages: null` QUAND ON NE SAIT PAS, jamais 0. Un zéro affirmerait que l'agent n'a parlé à
   * personne, ce qui est une information FAUSSE présentée comme une mesure.
   */
  app.get('/tenants/:tenantId/agents/:agentId/messages', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const { agentId } = req.params as { agentId: string };
    if (!estUuid(agentId)) return reply.code(404).send({ error: 'agent introuvable' });
    if (!deps.messagesAgent) return reply.code(200).send({ messages: null, jours: JOURS_CONSOMMATION });
    return reply.code(200).send({
      messages: await deps.messagesAgent(tenant, agentId, JOURS_CONSOMMATION),
      jours: JOURS_CONSOMMATION,
    });
  });
```

⚠️ `opts` et non un objet neuf : c'est lui qui porte le `preHandler`. `tests/scope-tenant.test.ts:105` échoue si une route portant `:tenantId` n'en a pas.

- [ ] **Step 4: Écrire la requête dans le store**

Dans `src/agent/session-store.ts`, à côté de `consommation?` :

```ts
  messagesTenus?(tenantId: string, agentId: string, jours: number): Promise<number>;
```

Dans `src/agent/session-store.pg.ts`, juste après `consommation` :

```ts
  /**
   * Les messages échangés dans les conversations que cet agent a tenues sur la fenêtre.
   *
   * 🔴 LA JOINTURE SUR `conversations` EST LE SEUL CONTRÔLE D'ISOLATION. `conversation_messages` ne porte
   * PAS de `tenant_id` (migration 0009) : une requête qui compterait les messages sur la seule fenêtre de
   * temps compterait ceux de TOUS les espaces. Ce n'est pas une imprécision, c'est une fuite entre clients.
   *
   * 🔴 `not c.is_test` : sans lui, les conversations ouvertes par « Tester le scénario » gonflent le
   * chiffre. Tout le reste des statistiques de ce dépôt les exclut, et un chiffre qui les compterait ici
   * contredirait le Performance Lab à deux écrans de distance.
   *
   * ⚠️ LE RAPPROCHEMENT SE FAIT SUR `wa_id`, ET IL N'Y A PAS D'AUTRE CLÉ. `agent_sessions` ne porte aucun
   * `conversation_id` ; `conversations` porte un `unique (tenant_id, wa_id)`, ce qui rend le rapprochement
   * déterministe à l'intérieur d'un espace. Ne pas chercher une clé étrangère, il n'y en a pas, et
   * `run_id` ne mène pas à une conversation.
   *
   * ⚠️ FENÊTRE GLISSANTE, comme `consommation` juste au-dessus, et pas les bornes civiles de `BOUNDS_CTE` :
   * les deux chiffres se lisent côte à côte sur le même écran, et deux fenêtres différentes y seraient
   * illisibles.
   */
  async messagesTenus(tenantId: string, agentId: string, jours: number): Promise<number> {
    const { rows } = await this.pool.query<{ n: string }>(
      `select count(*)::text as n
         from conversation_messages m
         join conversations c on c.id = m.conversation_id
        where c.tenant_id = $1
          and not c.is_test
          and m.created_at > now() - make_interval(days => $3)
          and c.wa_id in (
            select s.wa_id from agent_sessions s
             where s.tenant_id = $1 and s.agent_id = $2
               and s.created_at > now() - make_interval(days => $3)
          )`,
      [tenantId, agentId, jours],
    );
    return Number(rows[0]?.n ?? 0);
  }
```

- [ ] **Step 5: Câbler, en annonçant d'abord**

⚠️ **AVANT d'ouvrir `src/index.ts`, envoyer un message à l'autre session :** « j'édite `src/index.ts`, bloc `agents:` vers la ligne 1627, pour y ajouter `messagesAgent` ». C'est la règle des trois annonces du CLAUDE.md du projet.

Ajouter, juste après la ligne `consommationAgent: ...` :

```ts
      messagesAgent: (tenant, agentId, jours) => agentSessions.messagesTenus!(tenant, agentId, jours),
```

⚠️ Le `!` est là pour la même raison que sur la ligne voisine : la méthode est optionnelle dans l'interface `AgentSessionStore` alors que `PgAgentSessionStore` l'implémente. Ne pas recopier ce motif pour une méthode qu'on n'aurait pas encore écrite dans le store.

- [ ] **Step 6: Écrire le test d'intégration**

Dans `tests/integration/agent-session-store.integration.test.ts`, en suivant la forme des cas existants du fichier (création d'un tenant jetable, insertion, lecture, nettoyage) :

```ts
  it('🔴 messagesTenus compte les DEUX sens, et EXCLUT les fils de test', async () => {
    // Deux conversations : une tenue par l'agent (2 messages, un dans chaque sens), une de TEST tenue par
    // le même agent (1 message). Le compte doit valoir 2 et pas 3.
    // Et une troisième conversation du même espace que l'agent n'a jamais tenue (1 message) : elle ne doit
    // pas entrer non plus, sinon la mesure compterait tout l'espace au lieu de cet agent.
    const n = await store.messagesTenus(tenantId, agentId, 30);
    expect(n).toBe(2);
  });

  it('🔴 il ne voit RIEN d un autre espace', async () => {
    // `conversation_messages` n'a pas de tenant_id : si la jointure sautait, ce test le dirait.
    const n = await store.messagesTenus(autreTenantId, agentId, 30);
    expect(n).toBe(0);
  });
```

⚠️ Monter les fixtures avec les helpers du fichier (il en a déjà pour créer un tenant et un agent). Insérer les conversations et messages par SQL direct dans le test, en posant `is_test = true` sur celle qui doit être exclue.

- [ ] **Step 7: Lancer les tests unitaires et le typecheck**

Run: `npx vitest run tests/http-agents.test.ts tests/scope-tenant.test.ts && npm run typecheck`
Expected: PASS. 🔴 **Ne PAS lancer `npm run test:integration` en local** : le `DATABASE_URL` pointe sur la production. Le job `integration` de la CI le fera.

- [ ] **Step 8: Commit**

```bash
git diff src/index.ts
git commit --only src/agent/session-store.ts src/agent/session-store.pg.ts src/http/agents.ts src/index.ts tests/http-agents.test.ts tests/integration/agent-session-store.integration.test.ts -m "feat(agents): compter les messages echanges dans les conversations qu un agent a tenues"
```

⚠️ Le `git diff src/index.ts` avant le commit n'est pas décoratif : `--only` ne protège que si le CONTENU du fichier est encore le sien. Si le diff montre autre chose que la ligne ajoutée, s'arrêter et en parler à l'autre session.

---

### Task 5: le comptage des messages de l'agent de Meta

**Files:**
- Modify: `src/stats/store.pg.ts` (nouvelle méthode, à côté de la requête qui utilise déjà `ORIGINE_EFFECTIVE_SQL`, ligne 650)
- Modify: `src/http/mba.ts:28-61` (deps) et après `:226` (la route, juste après `/completion`)
- Modify: `src/index.ts:1586-1605` (câblage de `deps.mba`) ⚠️ **fichier partagé, annoncer avant**
- Test: `tests/http-mba.test.ts`, `tests/integration/mba-messages.integration.test.ts` (créer)

**Interfaces:**
- Consumes: `ORIGINE_EFFECTIVE_SQL` depuis `src/inbox/origine.ts` (importé, JAMAIS recopié).
- Produces: `MbaRouteDeps.messagesTenus?(tenantId: string, jours: number): Promise<number>` et la route `GET /tenants/:tenantId/mba/:phoneNumberId/messages` qui rend `{ messages: number | null, jours: number }`.

- [ ] **Step 1: Écrire le test de route qui échoue**

Dans `tests/http-mba.test.ts`, en suivant la forme des trois cas d'isolation existants (`:74-96`) :

```ts
describe('GET /tenants/:tenantId/mba/:phoneNumberId/messages', () => {
  it('rend le compte et la fenêtre', async () => {
    const app = await monter({ ...depsDeBase(), messagesTenus: async () => 87 });
    const r = await app.inject({ method: 'GET', url: `/tenants/${TENANT}/mba/${PN}/messages` });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ messages: 87, jours: 30 });
  });

  it('🔴 rend null, PAS zéro, quand la dépendance est absente', async () => {
    const app = await monter(depsDeBase());
    const r = await app.inject({ method: 'GET', url: `/tenants/${TENANT}/mba/${PN}/messages` });
    expect(r.json()).toEqual({ messages: null, jours: 30 });
  });

  it('🔴 refuse un numéro qui n appartient pas à cet espace', async () => {
    // Le `:phoneNumberId` ne filtre PAS le comptage (`conversations` ne porte aucun numéro) : il ne sert
    // qu'à ce contrôle d'isolation, hérité de `contexte()`. Ce test est là pour qu'on ne le retire pas en
    // croyant qu'il ne sert à rien.
    const app = await monter({ ...depsDeBase(), phoneNumberBelongsToTenant: async () => false });
    const r = await app.inject({ method: 'GET', url: `/tenants/${TENANT}/mba/${PN}/messages` });
    expect(r.statusCode).toBe(404);
  });
});
```

- [ ] **Step 2: Lancer et vérifier l'échec**

Run: `npx vitest run tests/http-mba.test.ts`
Expected: FAIL, 404 sur une route qui n'existe pas.

- [ ] **Step 3: Déclarer la dépendance et écrire la route**

Dans `src/http/mba.ts`, ajouter à `MbaRouteDeps` :

```ts
  /**
   * Les messages échangés dans les conversations que l'agent de Meta a tenues, sur une fenêtre de N jours.
   *
   * ⚠️ PAR ESPACE, PAS PAR NUMÉRO, et ce n'est pas un raccourci : `conversations` ne porte aucun
   * `phone_number_id` (migration 0009), sa clé métier est `(tenant_id, wa_id)`. Le produit refusant par
   * ailleurs un second numéro par espace, les deux coïncident aujourd'hui. Le jour où un espace en
   * piloterait deux, ce chiffre deviendrait la somme des deux et il faudrait le dire.
   *
   * ⚠️ OPTIONNELLE : `MbaRouteDeps` ne donne aujourd'hui AUCUN accès à la base, et les fixtures de test
   * bouchonnent l'objet entier. L'écran sait ne rien afficher quand le chiffre manque.
   */
  messagesTenus?(tenantId: string, jours: number): Promise<number>;
```

Ajouter, en tête du fichier à côté des autres constantes de module :

```ts
/** La fenêtre du chiffre de l'en-tête. La même que celle de la consommation d'un agent IA, pour que les
 *  deux écrans ne racontent pas deux durées différentes sous le même mot. */
const JOURS_MESSAGES = 30;
```

Puis, juste après la route `/completion` :

```ts
  app.get(`${base}/messages`, g, async (req, reply) => {
    const ctx = await contexte(req, reply, deps);
    if (!ctx) return;
    if (!deps.messagesTenus) return reply.code(200).send({ messages: null, jours: JOURS_MESSAGES });
    return reply.code(200).send({
      messages: await deps.messagesTenus(ctx.tenant, JOURS_MESSAGES),
      jours: JOURS_MESSAGES,
    });
  });
```

⚠️ Le motif `const ctx = await contexte(...); if (!ctx) return;` est obligatoire : `contexte()` répond elle-même et rend `null`. Répondre une seconde fois après elle provoque une double réponse Fastify.

- [ ] **Step 4: Écrire la requête dans le store de stats**

Dans `src/stats/store.pg.ts`, à côté de la requête qui utilise déjà le fragment partagé :

```ts
  /**
   * Les messages échangés dans les conversations que l'agent de Meta a tenues sur la fenêtre.
   *
   * 🔴 LE FRAGMENT D'ORIGINE S'IMPORTE, IL NE SE RECOPIE PAS (règle « Modules partagés » du CLAUDE.md).
   * `ORIGINE_EFFECTIVE_SQL` attend l'alias `m` pour `conversation_messages` : c'est pour ça que le
   * sous-select nomme sa table `m` et que la requête extérieure nomme la sienne `msg`. Inverser les deux
   * produit un SQL invalide, et recopier le fragment ferait diverger ce chiffre de la ventilation du
   * Performance Lab au premier changement de règle d'origine.
   *
   * 🔴 DEUX FAÇONS DE POSER L'ORIGINE `mba`, et le fragment couvre les deux : la colonne `origin = 'mba'`
   * écrite depuis la migration 0099, et la dérivation `when m.type = 'mba'` pour l'historique d'avant.
   * C'est exactement pourquoi on ne teste pas `m.origin = 'mba'` à la main.
   *
   * 🔴 `not c.is_test` DES DEUX CÔTÉS de la requête. Le sous-select repère les conversations, l'extérieur
   * compte : oublier le filtre dans l'un des deux laisserait rentrer les fils de test par l'autre porte.
   */
  async messagesTenusParMba(tenantId: string, jours: number): Promise<number> {
    const { rows } = await this.pool.query<{ n: string }>(
      `select count(*)::text as n
         from conversation_messages msg
         join conversations c on c.id = msg.conversation_id
        where c.tenant_id = $1
          and not c.is_test
          and msg.created_at > now() - make_interval(days => $2)
          and msg.conversation_id in (
            select m.conversation_id
              from conversation_messages m
              join conversations cv on cv.id = m.conversation_id
             where cv.tenant_id = $1
               and not cv.is_test
               and m.created_at > now() - make_interval(days => $2)
               and ${ORIGINE_EFFECTIVE_SQL} = 'mba'
          )`,
      [tenantId, jours],
    );
    return Number(rows[0]?.n ?? 0);
  }
```

- [ ] **Step 5: Câbler, en annonçant d'abord**

⚠️ **Annoncer à l'autre session avant d'ouvrir `src/index.ts`**, bloc `mba:` vers la ligne 1586.

```ts
      messagesTenus: (tenant, jours) => statsStore.messagesTenusParMba(tenant, jours),
```

`statsStore` est déjà instancié dans la même portée (`src/index.ts:215`). Ne pas en créer un second.

- [ ] **Step 6: Écrire le test d'intégration**

Créer `tests/integration/mba-messages.integration.test.ts`, sur le modèle d'un fichier voisin du dossier (ils ouvrent leur propre `pg.Pool` et le ferment dans `afterAll`) :

```ts
  it('🔴 compte les deux sens des conversations où l agent de Meta a répondu, et rien d autre', async () => {
    // Fixtures : (a) une conversation avec un sortant `origin = 'mba'` plus un entrant du client -> 2 ;
    // (b) une conversation du même espace sans aucun message `mba` -> 0 ; (c) une conversation `is_test`
    // avec un message `mba` -> 0 ; (d) une conversation d'un AUTRE espace avec un message `mba` -> 0.
    expect(await store.messagesTenusParMba(tenantId, 30)).toBe(2);
  });

  it('🔴 reconnaît aussi l ancienne façon de marquer un message de l agent de Meta', async () => {
    // Avant la colonne `origin`, un message de l'agent de Meta se reconnaissait à `type = 'mba'`. Le
    // fragment partagé couvre les deux ; ce test empêche qu'on le remplace un jour par un simple
    // `m.origin = 'mba'`, qui perdrait tout l'historique sans qu'aucune erreur ne le dise.
    expect(await store.messagesTenusParMba(tenantAncien, 30)).toBe(1);
  });
```

- [ ] **Step 7: Lancer les tests unitaires et le typecheck**

Run: `npx vitest run tests/http-mba.test.ts tests/scope-tenant.test.ts tests/origine-message.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git diff src/index.ts
git commit --only src/stats/store.pg.ts src/http/mba.ts src/index.ts tests/http-mba.test.ts tests/integration/mba-messages.integration.test.ts -m "feat(mba): compter les messages echanges dans les conversations que l agent de Meta a tenues"
```

---

### Task 6: `AgentResume` porte le modèle, pour que la liste puisse l'afficher

**Files:**
- Modify: `src/agent/agent-store.ts:79-84` (le type)
- Modify: `src/agent/agent-store.pg.ts:66-85` (la projection commune)
- Modify: `web/lib/api-agent.ts:11-17` (le miroir front)
- Test: `tests/integration/agent-store.integration.test.ts`

**Interfaces:**
- Consumes: rien.
- Produces: `AgentResume { id, label, status, sorties, modele }` des deux côtés.

- [ ] **Step 1: Écrire le test d'intégration qui échoue**

Dans `tests/integration/agent-store.integration.test.ts` :

```ts
  it('🔴 le résumé porte le MODÈLE : la liste en fait un logo', async () => {
    // Sans lui, la liste des agents devrait lire chaque fiche une par une pour afficher un logo, soit une
    // requête par ligne, sur un écran qui en affiche potentiellement des dizaines.
    const resumes = await store.listToutes(tenantId);
    const cree = resumes.find((r) => r.id === agentId);
    expect(cree?.modele).toBe('anthropic/claude-haiku-4.5');
  });
```

- [ ] **Step 2: Vérifier l'échec**

Run: la CI, ou localement à la lecture : la propriété n'existe pas, le typecheck la refuse déjà.
Expected: `npm run typecheck` échoue sur `cre e?.modele` (propriété inconnue de `AgentResume`).

- [ ] **Step 3: Ajouter le champ des deux côtés**

Dans `src/agent/agent-store.ts`, à `AgentResume` :

```ts
  /** Le modèle qui fait tourner cet agent. La liste en dérive le logo du fournisseur, sans relire la fiche. */
  modele: string;
```

Dans `src/agent/agent-store.pg.ts`, modifier la projection commune :

```ts
    const res = await this.pool.query<{ id: string; label: string; status: StatutAgent; fiche: unknown; modele: string }>(
      `select id, label, status, fiche, modele from agents
        where tenant_id = $1 ${filtreStatut}
        order by lower(label)`,
      [tenantId],
    );
    return res.rows.map((r) => ({
      id: r.id, label: r.label, status: r.status, sorties: sortiesDeLaFiche(r.fiche), modele: r.modele,
    }));
```

⚠️ C'est la projection COMMUNE à `listActifs` et `listToutes`, donc au builder de scénario ET à l'écran de réglage. C'est voulu : le commentaire du fichier dit que deux projections finiraient par montrer deux agents différents sous le même nom.

Dans `web/lib/api-agent.ts`, à `AgentResume` :

```ts
  /** Le modèle, pour le logo du fournisseur dans la liste. Miroir manuel du type serveur : la frontière de
   *  build interdit au front d'importer `src/`. */
  modele: string;
```

- [ ] **Step 4: Lancer le typecheck et les tests unitaires**

Run: `npm run typecheck && npx vitest run`
Expected: PASS. Si une fixture de test construit un `AgentResume` littéral, le typecheck la nomme : y ajouter `modele`, en reprenant un identifiant réel du catalogue plutôt qu'une chaîne inventée.

⚠️ **Les fixtures e2e ne sont PAS typées, donc le typecheck ne les nommera pas.** Chaque suite d'agents pose sa liste à la main, par exemple `web/e2e/agents-fiche.spec.ts:23` : `[{ id: 'ag1', label: 'Conseiller séjours', status: 'draft', sorties: [] }]`. Sans `modele`, la ligne rendra la pastille de repli au lieu du logo, en silence. Les balayer et leur ajouter `modele` avant de passer à la Task 8 : `rg "sorties: \[\]" web/e2e/`.

- [ ] **Step 5: Commit**

```bash
git commit --only src/agent/agent-store.ts src/agent/agent-store.pg.ts web/lib/api-agent.ts tests/integration/agent-store.integration.test.ts -m "feat(agents): le resume d un agent porte son modele"
```

---

### Task 7: l'écran de l'agent de Meta adopte l'en-tête et la colonne

**Files:**
- Modify: `web/app/mba/parametres/page.tsx:63-164`
- Modify: `web/lib/api-mba.ts` (ajouter le client de comptage)
- Modify: `web/e2e/support/mba.ts:132-196` (branches de faux backend)
- Test: `web/e2e/mba-parametres-entete.spec.ts` (créer)

**Interfaces:**
- Consumes: `EnteteAgent` (Task 3), `MbaTabs` avec `orientation` (Task 1), la route de Task 5.
- Produces: rien pour les tâches suivantes.

- [ ] **Step 1: Ajouter le client de la route**

Dans `web/lib/api-mba.ts`, à la suite de `getMbaCompletion` :

```ts
/** `messages: null` = on ne sait pas : route absente, ou compte non administrateur. Jamais zéro. */
export interface MessagesMba { messages: number | null; jours: number }

export function getMbaMessages(tenantId: string, phoneNumberId: string): Promise<MessagesMba> {
  return request<MessagesMba>(`${base(tenantId, phoneNumberId)}/messages`);
}
```

⚠️ Toute fonction de ce fichier est préfixée `Mba` sans exception, c'est la convention écrite en tête du fichier.

- [ ] **Step 2: Brancher l'en-tête dans la page**

Dans `web/app/mba/parametres/page.tsx` :

1. Garder la réponse entière de `getAccountStatus` dans un état, au lieu de n'en extraire que `phoneNumberId`. 🔴 **Ne PAS ajouter la lecture des messages dans la chaîne du `useEffect` existant** : son `.catch` unique fait rendre la page entière comme une erreur (`mba-page-error`). La lecture des messages vit dans SON propre effet, avec son propre `.catch` qui laisse la valeur à `null`.

```tsx
  const [compte, setCompte] = useState<AccountStatus | null>(null);
  const [messages, setMessages] = useState<number | null>(null);

  // ⚠️ UN EFFET À PART, ET UN `.catch` QUI AVALE. La route peut répondre 404 (front publié avant l'API) ou
  // 403 (compte non administrateur) : dans les deux cas l'en-tête n'affiche pas de chiffre, et l'écran
  // fonctionne. La joindre à l'effet principal ferait rendre la page entière comme une erreur.
  useEffect(() => {
    if (phoneNumberId === null) return;
    let vivant = true;
    void getMbaMessages(tenantId, phoneNumberId)
      .then((r) => { if (vivant) setMessages(r.messages); })
      .catch(() => { if (vivant) setMessages(null); });
    return () => { vivant = false; };
  }, [tenantId, phoneNumberId]);
```

2. Charger la complétion dans la page (et non plus dans `MbaCompletion`), pour en nourrir l'en-tête, avec la même tolérance :

```tsx
  const [completion, setCompletion] = useState<CompletionMba | null>(null);
  useEffect(() => {
    if (phoneNumberId === null) return;
    let vivant = true;
    void getMbaCompletion(tenantId, phoneNumberId)
      .then((r) => { if (vivant && Array.isArray(r?.taches)) setCompletion(r); })
      .catch(() => { if (vivant) setCompletion(null); });
    return () => { vivant = false; };
  }, [tenantId, phoneNumberId]);
```

3. Remplacer l'en-tête textuel (lignes 101-109) par `EnteteAgent`. 🔴 **L'en-tête actuel est rendu dans les CINQ états, y compris les deux blocages** (il est à l'intérieur de `coquille`). L'en-tête identitaire doit donc supporter `compte === null` : il rend alors la pastille, le titre « Paramètres de l'agent » et aucune étape.

```tsx
  const entete = (
    <EnteteAgent
      logo={{ src: '/meta-business-agent.png', alt: '' }}
      pastille="MB"
      nom={compte?.verifiedName ?? t('Paramètres de l’agent', 'Agent settings')}
      precision={compte?.number ? (compte.number.startsWith('+') ? compte.number : `+${compte.number}`) : undefined}
      etat={compte?.status ? <PastilleNumero status={compte.status} /> : undefined}
      etapes={(completion?.taches ?? [])
        .filter((x) => x.etat === 'a_faire')
        .map((x) => ({ message: x.raison ?? LIBELLES[x.cle].fr, onglet: LIBELLES[x.cle].onglet }))}
      ratio={completion ? { faites: completion.faites, total: completion.total } : undefined}
      messages30j={messages}
      onOnglet={choisirOnglet}
    />
  );
```

⚠️ `number` n'est PAS normalisé par le serveur : le seul autre écran qui l'affiche le préfixe d'un `+` s'il n'en a pas (`web/app/accueil/page.tsx:485`). Reprendre exactement ce geste, ne pas en inventer un autre.

🔴 **`PastilleNumero` N'EXISTE PAS ENCORE : il faut l'extraire, et ce n'est pas optionnel.** Aujourd'hui la pastille de statut du numéro est écrite EN LIGNE dans l'Accueil (`web/app/accueil/page.tsx:457-459`, avec la table de couleurs `DOT_HEX` à la ligne 26). La recopier dans l'en-tête ferait deux vérités sur la même pastille. Créer donc `web/components/PastilleNumero.tsx` :

```tsx
'use client';

/** Les couleurs en hexadécimal direct, comme l'Accueil : aucun risque de nuance Tailwind manquante. */
const DOT_HEX: Record<string, string> = { green: '#16A34A', amber: '#D97706', red: '#DC2626', grey: '#9CA3AF' };

/** L'état d'un numéro WhatsApp, tel que `getAccountStatus` le rend. */
export function PastilleNumero({ status }: { status: { dot: string; label: string } }) {
  return (
    <span data-testid="entete-numero-statut" className="inline-flex items-center gap-1.5 text-sm text-ink-600">
      <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: DOT_HEX[status.dot] ?? DOT_HEX.grey }} />
      {status.label}
    </span>
  );
}
```

Puis faire pointer l'Accueil dessus (lignes 457-459) plutôt que de laisser les deux coexister, et **relire les valeurs exactes de `DOT_HEX` dans `web/app/accueil/page.tsx:26` avant de les recopier ici** : celles du bloc ci-dessus sont les couleurs usuelles, pas une lecture du fichier.

🔴 **`LIBELLES` doit sortir de `MbaCompletion.tsx` avant que ce fichier disparaisse.** La table des neuf clés de tâche et de leur onglet (`MbaCompletion.tsx:25-35`) est la seule qui fasse le lien entre une clé serveur et un onglet. La déplacer dans `web/lib/libelles-mba.ts`, l'exporter, et l'importer depuis la page. La recopier serait la faire diverger au premier ajout de tâche.

4. Mettre la grille en place, avec `MbaTabs` en colonne :

```tsx
  return coquille(
    <div className="grid gap-4 lg:grid-cols-[14rem_1fr]">
      <div className="lg:border-r lg:border-ink-200 lg:pr-3">
        <MbaTabs orientation="verticale" active={onglet} onSelect={choisirOnglet} tabs={[/* inchangé */]} />
      </div>
      <div className="min-w-0">
        {/* les onze panneaux conditionnels, inchangés */}
      </div>
    </div>,
  );
```

⚠️ `min-w-0` sur la colonne de contenu : sans lui, un panneau large (un tableau de FAQ) pousse la grille et fait déborder la page. C'est le même geste que la mise en page de l'Inbox.

5. Supprimer l'appel `<MbaCompletion .../>` du corps, et supprimer le fichier `web/components/MbaCompletion.tsx` s'il n'a plus d'appelant. ⚠️ Vérifier par un grep avant de supprimer.

- [ ] **Step 3: Ajouter les branches du faux backend e2e**

Dans `web/e2e/support/mba.ts`, ⚠️ **AVANT** les branches courtes (le routage se fait par `includes`, pas par égalité : `/status` capturerait `/messages` si on le plaçait après) :

```ts
    if (url.includes('/messages')) return json({ messages: 412, jours: 30 });
    if (url.includes('/completion')) return json({
      taches: [
        { cle: 'business_info', requise: true, etat: 'fait' },
        { cle: 'faq', requise: true, etat: 'a_faire', raison: 'Aucune question enregistrée.' },
      ],
      faites: 1, total: 2, indeterminees: 0,
    });
```

⚠️ Ajouter aussi `verifiedName` et `number` à `compteParDefaut` (`support/mba.ts:43-53`), sinon l'en-tête rend le titre de repli dans toutes les suites.

- [ ] **Step 4: Écrire le test e2e**

```ts
// web/e2e/mba-parametres-entete.spec.ts
test('l en-tete identifie l agent, et le menu ne se rend qu UNE fois', async ({ page }) => {
  await mockMba(page);
  await page.goto('/mba/parametres');
  await expect(page.getByTestId('entete-agent')).toBeVisible();
  await expect(page.getByTestId('entete-agent-messages')).toContainText('412');
  await expect(page.getByTestId('entete-agent-etapes')).toContainText('1 étape à finir');

  // 🔴 LE CAS QUI PROTEGE LES CINQ AUTRES SUITES : un seul element par testid d'onglet, a toutes les
  // largeurs. Deux listes rendues feraient tomber `toHaveCount(0)` du gate et les onze clics existants.
  await expect(page.getByTestId('mba-tab-apercu')).toHaveCount(1);
  await page.setViewportSize({ width: 390, height: 800 });
  await expect(page.getByTestId('mba-tab-apercu')).toHaveCount(1);
});

test('🔴 sans la route de comptage, AUCUN chiffre, et l ecran marche', async ({ page }) => {
  // C'est la fenetre ou Vercel a publie l'ecran et ou l'API n'est pas encore deployee.
  await mockMba(page);
  await page.route('**/mba/**/messages', (r) => r.fulfill({ status: 404, body: '{}' }));
  await page.goto('/mba/parametres');
  await expect(page.getByTestId('entete-agent')).toBeVisible();
  await expect(page.getByTestId('entete-agent-messages')).toHaveCount(0);
});
```

- [ ] **Step 5: Lancer la suite e2e**

⚠️ **ANNONCER à l'autre session avant de lancer une suite e2e** : deux suites concurrentes empoisonnent `web/.next`. Si le symptôme apparaît (`ENOENT` dans `.next`, puis « Timed out waiting 180000ms from config.webServer »), la sortie est `rm -rf web/.next` PUIS `npm run build` À LA MAIN, parce qu'un build à froid dépasse les 180 s que Playwright accorde.

Run: `cd web && npx playwright test e2e/mba-parametres-entete.spec.ts e2e/mba-parametres-gate.spec.ts e2e/mba-parametres-overview.spec.ts e2e/mba-onglet-outils.spec.ts`
Expected: PASS, les trois suites existantes comprises et sans les avoir modifiées.

- [ ] **Step 6: Commit**

```bash
git commit --only web/app/mba/parametres/page.tsx web/lib/api-mba.ts web/e2e/support/mba.ts web/e2e/mba-parametres-entete.spec.ts -m "feat(mba): l ecran de reglage gagne son en-tete identitaire et son menu en colonne"
```

---

### Task 8: l'écran des agents IA adopte l'en-tête, la colonne et les logos

**Files:**
- Modify: `web/app/agents/page.tsx:255-388` (branche ouverte) et `:431-461` (une ligne de liste)
- Modify: `web/lib/api-agent.ts` (client de comptage)
- Test: `web/e2e/agents-entete.spec.ts` (créer)

**Interfaces:**
- Consumes: `EnteteAgent`, `MbaTabs` orienté, `logoDuModele`, `AgentResume.modele` (Task 6), la route de Task 4.
- Produces: rien.

- [ ] **Step 1: Ajouter le client de la route**

```ts
// web/lib/api-agent.ts, à la suite du client de consommation
/** `messages: null` = on ne sait pas : route absente, ou compte non administrateur. Jamais zéro. */
export async function messagesAgent(tenantId: string, agentId: string): Promise<number | null> {
  const r = await request<{ messages: number | null }>(`/tenants/${tenantId}/agents/${agentId}/messages`);
  return r.messages ?? null;
}
```

- [ ] **Step 2: Brancher l'en-tête dans la branche ouverte**

Remplacer le bloc titre (lignes 275-278) par `EnteteAgent`, et laisser la barre d'actions (258-274) AU-DESSUS, inchangée.

```tsx
  <EnteteAgent
    logo={logoDuModele(ouvert.modele)}
    pastille={pastilleDuModele(ouvert.modele)}
    nom={ouvert.label}
    precision={ouvert.modele}
    etat={<Activation agent={ouvert} busy={busy} onChange={(status) => void enregistrer({ status })} />}
    etapes={manques.map((m) => ({ message: m.message, onglet: m.onglet }))}
    messages30j={messages}
    onOnglet={(cle) => aller(ouvert.id, lireOnglet(cle))}
  />
```

🔴 **Le `<h2>` doit survivre.** `web/e2e/agents-fiche.spec.ts:86` fait `getByRole('heading', { name: 'Conseiller séjours' })`. `EnteteAgent` rend bien un `<h2>` avec `nom` : ne pas le dégrader en `<p>`.

⚠️ **`Activation` passe dans `etat`, il ne se recopie pas.** Il contient la `Pastille`, dont les testids `agent-statut-draft|active|disabled` sont lus par `agents-fiche.spec.ts` avec un `.first()` parce qu'il y en a deux à l'écran. Déplacer `Activation` dans l'en-tête garde ce compte à deux : ne pas en profiter pour en supprimer une.

⚠️ **Retirer le bandeau `agent-manques` du corps** (ses étapes sont maintenant dans l'en-tête), mais **GARDER `agent-avertissements` là où il est** : ces avertissements ne bloquent pas l'activation et n'entrent pas dans le compteur d'étapes. `web/e2e/agents-construction.spec.ts:245-249` s'appuie sur `agent-manques` et `agent-manque-connaissance` : ce test doit être MIS À JOUR pour viser `entete-etape-connaissance`, pas supprimé. Le cas qu'il exerce (un manque affiché mène à son onglet) doit être conservé.

🔴 **`tests/agent-historique.test.ts:183` LIT LE TEXTE de `page.tsx`** et exige les trois chaînes littérales `'historique'`, `surface="agent"` et `agentId={ouv...}`. Le refactor doit les laisser intactes. Lancer ce test avant de commiter.

- [ ] **Step 3: Mettre la grille et la largeur**

Le conteneur de la branche ouverte passe de `max-w-4xl` à `max-w-6xl`, et les onglets en colonne :

```tsx
<div className="mx-auto flex max-w-6xl flex-col gap-4">
  {/* barre d'actions, en-tete, avertissements */}
  <div className="grid gap-4 lg:grid-cols-[14rem_1fr]">
    <div className="lg:border-r lg:border-ink-200 lg:pr-3">
      <MbaTabs orientation="verticale" active={onglet} onSelect={(k) => aller(ouvert.id, lireOnglet(k))} tabs={[/* inchangé */]} />
    </div>
    <div className="min-w-0">{/* les neuf panneaux, inchangés */}</div>
  </div>
</div>
```

⚠️ La branche LISTE (ligne 391) porte la même classe `max-w-4xl`. La passer à `6xl` aussi, pour que la liste et la fiche ne changent pas de largeur quand on ouvre un agent.

- [ ] **Step 4: Le logo sur chaque ligne de la liste**

Dans la ligne d'agent (`:436-460`), ajouter le logo **DANS le bouton d'ouverture**, avec `alt=""` :

```tsx
  {logoDuModele(a.modele) !== null ? (
    <img src={logoDuModele(a.modele)!.src} alt="" className="h-5 w-5 shrink-0" />
  ) : (
    <span aria-hidden="true" className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-ink-100 text-[9px] font-semibold text-ink-600">
      {pastilleDuModele(a.modele)}
    </span>
  )}
```

🔴 **`alt=""` et `aria-hidden` ne sont pas optionnels.** `web/e2e/agents-modele.spec.ts:51` ouvre la fiche par `getByRole('button', { name: /Conseiller séjours/ })`, et le nom accessible d'un bouton inclut le texte alternatif de ses images. Un `alt="Anthropic"` ferait échouer ce sélecteur, et avec lui TOUT le fichier, dont le clic vit dans un helper commun à tous ses tests.

- [ ] **Step 5: Écrire le test e2e**

🔴 **Il n'existe AUCUN helper partagé pour les agents.** `web/e2e/support/` ne contient que `accueil.ts`, `mba.ts` et `zones-pdf.ts`. Chaque suite d'agents définit sa propre fonction `mockAgents` en tête de fichier. Recopier celle de `web/e2e/agents-fiche.spec.ts:23` dans le fichier neuf, avec sa constante `SESSION` et son objet `AGENT`.

🔴 **Et son `AGENT.modele` vaut `'modele-test'`, SANS barre oblique.** `logoDuModele('modele-test')` rend donc `null`, et c'est la pastille qui s'affiche, pas le logo. Deux conséquences, toutes deux à respecter : le test du logo doit poser un modèle RÉEL dans sa fixture, et un test doit garder le cas de la pastille, qui est le comportement réel d'un agent au modèle hors catalogue.

```ts
// web/e2e/agents-entete.spec.ts
test('l en-tete porte le logo du modele, le statut et les etapes', async ({ page }) => {
  // Fixture avec un modele REEL : c'est le prefixe qui decide du logo.
  await mockAgents(page, [], [{ id: 'ag1', label: 'Conseiller séjours', status: 'draft', sorties: [], modele: 'anthropic/claude-haiku-4.5' }]);
  await page.goto('/agents?id=ag1&tab=identite');
  await expect(page.getByTestId('entete-agent')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Conseiller séjours' })).toBeVisible();
  await expect(page.getByTestId('entete-agent-logo')).toBeVisible();
  await expect(page.getByTestId('mba-tab-identite')).toHaveCount(1);
});

test('⚠️ un modele hors catalogue rend la PASTILLE, pas un logo cassé', async ({ page }) => {
  await mockAgents(page, []); // AGENT.modele vaut 'modele-test', sans prefixe connu
  await page.goto('/agents?id=ag1&tab=identite');
  await expect(page.getByTestId('entete-agent-pastille')).toBeVisible();
  await expect(page.getByTestId('entete-agent-logo')).toHaveCount(0);
});

test('🔴 le logo de la liste ne change PAS le nom accessible du bouton', async ({ page }) => {
  // Le piege exact qui casserait agents-modele.spec.ts en entier.
  await mockAgents(page, [], [{ id: 'ag1', label: 'Conseiller séjours', status: 'draft', sorties: [], modele: 'anthropic/claude-haiku-4.5' }]);
  await page.goto('/agents');
  await expect(page.getByRole('button', { name: /Conseiller séjours/ })).toBeVisible();
});
```

- [ ] **Step 6: Lancer les tests**

⚠️ **Annoncer avant la suite e2e.**

Run: `npx vitest run tests/agent-historique.test.ts` puis `cd web && npx playwright test e2e/agents-entete.spec.ts e2e/agents-fiche.spec.ts e2e/agents-modele.spec.ts e2e/agents-construction.spec.ts`
Expected: PASS partout.

- [ ] **Step 7: Commit**

```bash
git commit --only web/app/agents/page.tsx web/lib/api-agent.ts web/e2e/agents-entete.spec.ts web/e2e/agents-construction.spec.ts -m "feat(agents): la fiche gagne son en-tete, son menu en colonne et le logo de son modele"
```

---

### Task 9: la documentation suit, et la revue finale

**Files:**
- Modify: `features.md` (section « Agent IA » et section « MBA, le répondeur de Meta »)
- Modify: `wip.md`

**Interfaces:**
- Consumes: tout ce qui précède.
- Produces: rien.

- [ ] **Step 1: Décrire la feature côté utilisateur**

Ajouter dans `features.md`, à la section de chaque écran, ce que le client voit : l'en-tête qui identifie l'agent, le menu en colonne, le chiffre de messages sur 30 jours et ce qu'il compte (les conversations tenues, fils de test exclus), et le fait qu'aucun chiffre ne s'affiche quand on ne sait pas.

🔴 **Écrire ce qui EXISTE, jamais ce qui a changé.** Pas de « désormais », pas de date de livraison, pas de numéro de migration.

⚠️ **Toucher ces deux sections change leur empreinte**, et deux fiches du bot d'aide en dérivent (`construire-un-agent-ia`, `le-repondeur-de-meta`). `npx vitest run tests/aide-proposer.test.ts` deviendra ROUGE : c'est le mécanisme qui fonctionne. Relire les deux fiches, les compléter, puis recalculer leur `source_empreinte`.

- [ ] **Step 2: Lancer toute la suite unitaire et le typecheck**

Run: `npm test && npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 3: Pousser et lire la CI job par job**

```bash
git commit --only features.md wip.md docs/aide/fiches -m "docs(agents): l en-tete et le menu en colonne, vus du client"
git push origin main
gh run list --limit 1
```

🔴 Lire `gh run view <id> --json jobs`, job par job. `gh run watch --exit-status` a déjà rendu 0 sur un run en échec.

- [ ] **Step 4: Revue finale, puis déploiement**

Lancer `/revue-finale`. 🔴 **Les deux routes neuves doivent être déployées AVANT que quiconque compte sur le chiffre**, mais l'écran ne casse pas si elles manquent : c'est toute la raison du contrat `messages30j: number | null`. L'ordre reste néanmoins : revue finale attestée, puis `compose build`, puis `up -d --build`. Aucune migration dans ce lot.

---

## Méthode de livraison

**Implémenteur par lot, avec revue humaine du diff.**

Le choix se fait sur les quatre questions du CLAUDE.md, et il est pris **parce que** trois d'entre elles répondent dans le même sens. La production emprunte ce chemin : ce sont les écrans qui règlent les deux agents qui répondent aux clients, et une route neuve y touche la base de production. Le travail est réversible, mais les critères ne sont **pas** tous mécaniquement testables : la moitié du lot est visuelle, et aucun test ne dira si une colonne de onze entrées est lisible. Enfin, le code touché porte des invariants invisibles que le compilateur ne voit pas : les `data-testid` dont dépendent cinq suites e2e, l'onglet qui vit dans l'adresse, le nom accessible d'un bouton que le texte alternatif d'une image modifie, et la tolérance à l'absence d'une route.

`feature-loop` est écarté pour la même raison : sa porte est la complétude mécanique, et elle ne verrait pas ces quatre-là. Un workflow multi-agents n'a pas lieu d'être sur neuf tâches séquentielles qui se relisent mieux une par une.

**L'essai réel qui clôt la feature, et qu'aucun test vert ne remplace** : Julien ouvre les deux écrans sur un agent complètement réglé et sur un agent vide, et vérifie quatre choses. Le bon logo de fournisseur en tête de la fiche d'agent. Le nombre d'étapes restantes, comparé à ce que les onglets contiennent vraiment. Le chiffre de messages, comparé à ce que le Performance Lab affiche pour la même période. Et la colonne d'onglets sur un téléphone, où elle doit redevenir la barre horizontale d'aujourd'hui.

---

## Rayon de souffle, à relire avant de commiter chaque tâche

- **`MbaTabs`** a exactement deux consommateurs, tous deux dans ce lot. Sa prop nouvelle est optionnelle avec un défaut : aucun appelant existant ne change de rendu.
- **Cinq suites e2e cliquent des `mba-tab-<cle>`**, dont une dans un helper commun à tout son fichier. Une seule liste rendue, testids inchangés.
- **17 autres fichiers e2e naviguent par `?tab=<cle>`** (141 occurrences) sans jamais toucher le composant. Renommer ou regrouper une clé d'onglet les casserait tous : ce lot n'en renomme aucune.
- **Les deux écrans divergent sur la clé du dernier onglet** (`test` côté MBA, `tester` côté agent IA). Aucun code partagé ne doit nommer une clé en dur.
- **`tests/agent-historique.test.ts` lit le TEXTE de `web/app/agents/page.tsx`** et exige trois chaînes littérales.
- **`conversation_messages` n'a pas de `tenant_id`** : toute requête de comptage joint `conversations` et filtre `c.tenant_id`. L'oublier est une fuite entre clients, pas une imprécision.
- **`src/index.ts` est partagé** : annoncer, puis `git diff` avant de commiter.
- **Les deux modules sont montés en `g.admin`** : un manager reçoit 403 sur les routes de comptage, et l'en-tête doit s'en accommoder comme d'un 404.
