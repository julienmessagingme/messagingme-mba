# Lot A : les trois onglets Console / Inbox / Performance Lab

> **Pour un exécutant :** ce plan se déroule tâche par tâche. Les étapes sont en cases à cocher (`- [ ]`).

**But :** faire passer la console d'une barre latérale unique à trois onglets de premier niveau, sans changer
une seule URL ni une seule fonctionnalité.

**Architecture :** l'onglet n'est pas une nouvelle propriété passée par les pages. Il se **déduit** de la clé
`active` que les 33 pages passent déjà à `AppShell`, en cherchant cette clé dans trois arbres de navigation.
`web/lib/nav.ts`, module pur et déjà testé, gagne cette fonction ; `AppShell` scinde son `NAV_ADMIN` en trois
et rend une barre d'onglets au-dessus de la colonne de gauche.

**Stack :** Next.js (App Router), React, Tailwind 3.4, vitest (unitaire), Playwright (E2E).

**Spec :** [docs/superpowers/specs/2026-09-08-refonte-menus-design.md](../specs/2026-09-08-refonte-menus-design.md)

## Contraintes globales

- 🔴 **Aucune URL existante ne change.** Les onglets sont un niveau de regroupement au-dessus de la nav.
- 🔴 **Aucune des 33 pages qui appellent `AppShell` n'est modifiée.** Si une tâche vous fait ouvrir une page
  sous `web/app/`, c'est que la déduction de l'onglet a été mal faite : revenez à la tâche 1.
- 🔴 **Isolation par espace** : ce lot ne touche aucune requête serveur. S'il vous en fait écrire une,
  arrêtez-vous, ce n'est pas ce lot.
- Un compte `agent` ne voit que l'onglet Inbox (règle actuelle : `adminOnly = active !== 'inbox'`).
- Pas de tirets longs (« — » ni « – ») dans le code, les commentaires ou la doc : virgule, deux-points,
  parenthèses ou point.
- Commentaires et libellés en français, anglais via `t('fr', 'en')`.
- `git commit --only <chemins>`, jamais `git add` puis un commit nu.

## Écart assumé par rapport à la spec

La spec annonçait une route neuve `/performance` dans ce lot. **Elle est retirée d'ici et rejoint les lots E
et F**, ceux qui lui donnent son contenu. Raison : la vertu du lot A est de ne rien changer d'autre que le
rangement, et une page qui annoncerait « la synthèse arrive » serait la seule chose du lot qu'un client
verrait comme neuve, et vide. **La destination de l'onglet Performance Lab est donc `/dashboard`** (Messages
& contacts), sa première entrée. L'entrée « Synthèse » s'ajoutera en tête avec le lot E.

## Structure des fichiers

| Fichier | Responsabilité |
|---|---|
| `web/lib/nav.ts` (modifier) | Le modèle de nav. Gagne `Onglet`, `contientLaCle`, `ongletDeLaPage`. Reste PUR : aucun import React. |
| `web/lib/nav.test.ts` (modifier) | Tests unitaires du module pur, dont la couverture des clés. |
| `web/components/AppShell.tsx` (modifier) | Scinde `NAV_ADMIN` en trois arbres, rend la barre d'onglets, restructure la mise en page extérieure. |
| `web/e2e/navigation-onglets.spec.ts` (créer) | Les onglets vus du navigateur, et le fait qu'aucune URL ne bouge. |

---

## Tâche 1 : la déduction de l'onglet, dans le module pur

**Fichiers :**
- Modifier : `web/lib/nav.ts`
- Test : `web/lib/nav.test.ts`

**Interfaces :**
- Consomme : `NavEntree` (existe déjà dans ce fichier).
- Produit : `type Onglet = 'console' | 'inbox' | 'perf'`, `ONGLETS`, `contientLaCle(items, key): boolean`,
  `ongletDeLaPage(arbres, key): Onglet` où `arbres` est `Record<Onglet, NavEntree[]>`.

- [ ] **Étape 1 : écrire les tests qui échouent**

Ajouter à la fin de `web/lib/nav.test.ts` :

```ts
describe('ongletDeLaPage', () => {
  const arbres: Record<Onglet, NavEntree[]> = {
    console: [
      { key: 'accueil', href: '/accueil', label: 'Accueil' },
      { key: 'contenu', label: 'Contenu', children: [{ key: 'templates', href: '/templates', label: 'Templates' }] },
    ],
    inbox: [{ key: 'inbox', href: '/inbox', label: 'Inbox' }],
    perf: [
      { key: 'quantitatif', label: 'Quantitatif', children: [{ key: 'quanti-couts', href: '/dashboard/couts', label: 'Coûts' }] },
    ],
  };

  it('trouve une page de PREMIER niveau', () => {
    expect(ongletDeLaPage(arbres, 'accueil')).toBe('console');
    expect(ongletDeLaPage(arbres, 'inbox')).toBe('inbox');
  });

  it('🔴 trouve une page ENFOUIE dans un groupe, à n’importe quelle profondeur', () => {
    // C'est le cas qui compte : la moitié des pages de la console vivent sous deux niveaux de groupe, et
    // c'est là qu'une recherche naïve « sur le premier niveau » les perdrait toutes.
    expect(ongletDeLaPage(arbres, 'templates')).toBe('console');
    expect(ongletDeLaPage(arbres, 'quanti-couts')).toBe('perf');
  });

  it('🔴 une clé INCONNUE tombe sur « console », elle ne fait pas disparaître la barre', () => {
    // Même parti pris que `cheminDeNav`, qui rend une chaîne vide plutôt que de jeter : une page dont
    // l'onglet n'a pas été déclaré doit s'afficher dans un onglet plausible.
    expect(ongletDeLaPage(arbres, 'page-inventee')).toBe('console');
  });

  it('un GROUPE est trouvé comme ses enfants : c’est une clé de la nav comme une autre', () => {
    expect(ongletDeLaPage(arbres, 'contenu')).toBe('console');
  });
});

describe('contientLaCle', () => {
  const items: NavEntree[] = [{ key: 'a', label: 'A', children: [{ key: 'b', label: 'B', children: [{ key: 'c', href: '/c', label: 'C' }] }] }];
  it('descend à toutes les profondeurs', () => {
    for (const k of ['a', 'b', 'c']) expect(contientLaCle(items, k), k).toBe(true);
  });
  it('ne trouve pas ce qui n’y est pas', () => {
    expect(contientLaCle(items, 'z')).toBe(false);
    expect(contientLaCle([], 'a')).toBe(false);
  });
});
```

Ajouter les imports en tête du fichier de test :
`import { cheminDeNav, contientLaCle, ongletDeLaPage, ONGLETS, type NavEntree, type Onglet } from './nav';`

- [ ] **Étape 2 : lancer les tests pour les voir ÉCHOUER**

```bash
cd web && npx vitest run lib/nav.test.ts
```
Attendu : ÉCHEC, `contientLaCle is not a function` (et l'erreur de compilation TypeScript sur `Onglet`).

- [ ] **Étape 3 : écrire l'implémentation**

Ajouter à la fin de `web/lib/nav.ts` :

```ts
/**
 * Les trois onglets de premier niveau (2026-09-08).
 *
 * 'console' = configurer et opérer · 'inbox' = traiter les conversations · 'perf' = lire les résultats.
 * Trois métiers qui ne se pratiquent ni au même moment ni par les mêmes personnes, et que la barre unique
 * mettait sur le même plan.
 */
export const ONGLETS = ['console', 'inbox', 'perf'] as const;
export type Onglet = (typeof ONGLETS)[number];

/** Cette clé est-elle quelque part dans cet arbre, à n'importe quelle profondeur ? */
export function contientLaCle(items: NavEntree[], key: string): boolean {
  return items.some((item) => item.key === key || (item.children ? contientLaCle(item.children, key) : false));
}

/**
 * L'onglet qui contient cette page.
 *
 * 🔴 POURQUOI C'EST UNE DÉDUCTION ET PAS UNE PROPRIÉTÉ. Trente-trois pages passent déjà leur clé à
 * `AppShell`. Leur faire passer AUSSI leur onglet, ce serait trente-trois occasions d'écrire le mauvais, et
 * une page ajoutée plus tard n'en aurait aucun. La nav sait déjà où vit chaque page : on le lui demande.
 *
 * ⚠️ Une clé INCONNUE rend 'console', elle ne jette pas. Même parti pris que `cheminDeNav` juste au-dessus :
 * une page dont l'onglet n'a pas été déclaré doit s'afficher dans un onglet plausible, pas faire disparaître
 * la barre entière. Le test de couverture de `Tab` (`AppShell`) est ce qui empêche ce cas d'exister.
 */
export function ongletDeLaPage(arbres: Record<Onglet, NavEntree[]>, key: string): Onglet {
  return ONGLETS.find((o) => contientLaCle(arbres[o], key)) ?? 'console';
}
```

- [ ] **Étape 4 : lancer les tests pour les voir PASSER**

```bash
cd web && npx vitest run lib/nav.test.ts && npx tsc --noEmit
```
Attendu : tous verts, aucune erreur de type.

- [ ] **Étape 5 : commiter**

```bash
git commit --only web/lib/nav.ts web/lib/nav.test.ts -m "feat(nav): deduire l onglet d une page depuis l arbre de navigation"
```

---

## Tâche 2 : scinder la navigation en trois arbres

**Fichiers :**
- Modifier : `web/components/AppShell.tsx` (les constantes `NAV_ADMIN`, lignes ~73 à ~152)
- Test : `web/lib/nav.test.ts` (le test de couverture)

**Interfaces :**
- Consomme : `Onglet`, `contientLaCle` (tâche 1).
- Produit : `NAV_CONSOLE`, `NAV_INBOX`, `NAV_PERF` dans `AppShell`, et `ARBRES: Record<Onglet, NavEntree[]>`.

**Ce qui bouge, exactement.** `NAV_ADMIN` contient aujourd'hui, dans l'ordre : `accueil`, `inbox`,
`contacts`, `campagnes`, `chaine`, `workflows`, `automations`, le groupe `ia`, le groupe `contenu`, le groupe
`tools`, le groupe `analytics`, `parametres`, `support`.

- `NAV_INBOX` reçoit l'entrée `inbox` (avec son badge de non-lus).
- `NAV_PERF` reçoit **les enfants du groupe `analytics`, remontés d'un cran** : le groupe `quantitatif` (qui
  garde ses quatre enfants), `dashboard-quali`, `dashboard-tableaux`.
- `NAV_CONSOLE` reçoit **tout le reste**, dans son ordre actuel.
- `NAV_ADMIN_BAS` (le bloc Developers collé en bas) **ne bouge pas** et reste dans l'onglet Console.

⚠️ **Les entrées du Performance Lab n'ont PAS d'icône**, et c'est un choix : le rendu les accepte sans (`{item.d && <Ico …>}`), elles sont toutes dans le même onglet donc l'icône ne distingue rien, et n'en donner qu'à certaines les désalignerait. Le groupe `quantitatif` n'en avait déjà pas.

- [ ] **Étape 1 : écrire le test de couverture qui échoue**

Ajouter à `web/lib/nav.test.ts` :

```ts
/**
 * 🔴 CHAQUE PAGE APPARTIENT À UN ONGLET, ET À UN SEUL.
 *
 * C'est LE test du lot : sans lui, une page ajoutée plus tard n'appartient à aucun arbre et retombe
 * silencieusement sur « console » (le repli de `ongletDeLaPage`), ou pire se trouve dans deux arbres et
 * change d'onglet selon l'ordre de recherche. Les deux sont invisibles à la compilation.
 *
 * Il DÉRIVE les clés du fichier source plutôt que de les recopier : une liste recopiée ne ferait que
 * déplacer la dérive d'un fichier à l'autre. Même idiome que `web/lib/contact-filters.test.ts`.
 */
it('🔴 chaque clé du type Tab appartient à exactement UN arbre de navigation', async () => {
  const src = await readFile(new URL('../components/AppShell.tsx', import.meta.url), 'utf8');

  const ligneTab = src.slice(src.indexOf('type Tab ='), src.indexOf(';', src.indexOf('type Tab =')));
  const clesTab = [...ligneTab.matchAll(/'([a-z0-9-]+)'/g)].map((m) => m[1]!);
  expect(clesTab.length, 'le type Tab n’a pas été lu : ce test ne garde plus rien').toBeGreaterThan(25);

  // Les trois arbres, lus tels que le composant les déclare.
  const arbre = (nom: string): string[] => {
    const debut = src.indexOf(`const ${nom}: NavEntree[] = [`);
    expect(debut, `${nom} a disparu de AppShell : ce test ne garde plus rien`).toBeGreaterThan(-1);
    const fin = src.indexOf('\n  ];', debut);
    return [...src.slice(debut, fin).matchAll(/key: '([a-z0-9-]+)'/g)].map((m) => m[1]!);
  };
  const arbres = {
    console: [...arbre('NAV_CONSOLE'), ...arbre('NAV_ADMIN_BAS')],
    inbox: arbre('NAV_INBOX'),
    perf: arbre('NAV_PERF'),
  };

  for (const cle of clesTab) {
    const dedans = (Object.keys(arbres) as Array<keyof typeof arbres>).filter((o) => arbres[o].includes(cle));
    expect(dedans, `« ${cle} » est dans ${dedans.length} onglet(s), il en faut exactement un`).toHaveLength(1);
  }
});
```

Ajouter en tête du fichier de test : `import { readFile } from 'node:fs/promises';`

⚠️ La clé `admin` du type `Tab` désigne une page d'exploitation qui n'est dans aucune nav. **Si le test
échoue sur elle**, ce n'est pas au test de céder : ajouter `admin` à `NAV_CONSOLE` la rendrait visible à tous
les clients. Retirer `admin` du type `Tab` n'est pas possible non plus (la page le passe). La bonne réponse
est une liste d'exception NOMMÉE, avec sa raison, juste au-dessus de la boucle :

```ts
  // Pages HORS NAV, volontairement : elles existent, elles ont une clé, et aucun menu ne doit y mener.
  // `admin` est la surface d'exploitation (accès par l'adresse, jamais par un menu client).
  const horsNav = new Set(['admin']);
  for (const cle of clesTab.filter((c) => !horsNav.has(c))) {
```

- [ ] **Étape 2 : lancer le test pour le voir ÉCHOUER**

```bash
cd web && npx vitest run lib/nav.test.ts
```
Attendu : ÉCHEC, `NAV_CONSOLE a disparu de AppShell` (il n'existe pas encore).

- [ ] **Étape 3 : scinder les constantes**

Dans `web/components/AppShell.tsx`, remplacer la déclaration `const NAV_ADMIN: NavEntree[] = [ … ];` par
trois constantes. Le contenu des entrées est repris **à l'identique**, seul leur rangement change :

```tsx
  /**
   * 🔴 TROIS ARBRES DEPUIS LE 2026-09-08, un par onglet. C'était `NAV_ADMIN`, une liste unique qui mettait
   * sur le même plan trois métiers : configurer, traiter, mesurer.
   *
   * ⚠️ Le CONTENU des entrées n'a pas changé, seul leur rangement. Aucune adresse ne bouge : les onglets
   * sont un niveau de regroupement au-dessus, pas un nouveau routage.
   */
  const NAV_CONSOLE: NavEntree[] = [
    // … toutes les entrées de l'ancien NAV_ADMIN, SAUF `inbox` et SAUF le groupe `analytics`,
    // dans leur ordre actuel : accueil, contacts, campagnes, chaine, workflows, automations,
    // le groupe `ia`, le groupe `contenu`, le groupe `tools`, parametres, support.
  ];

  /** L'onglet Inbox n'a PAS de barre de navigation : son entrée sert à situer la page, pas à naviguer.
   *  Le menu de dossiers (Tout / À traiter / Signalé / Archivé) arrive au lot B, DANS l'écran. */
  const NAV_INBOX: NavEntree[] = [
    { key: 'inbox', href: '/inbox', label: t('Inbox', 'Inbox'), d: icons.inbox, badge: unread },
  ];

  /** Les enfants de l'ancien groupe `analytics`, remontés d'un cran : dans cet onglet, ils SONT le menu. */
  const NAV_PERF: NavEntree[] = [
    { key: 'quantitatif', label: t('Quantitatif', 'Quantitative'), children: [
      { key: 'quanti-messages', href: '/dashboard', label: t('Messages & contacts', 'Messages & contacts') },
      { key: 'quanti-couts', href: '/dashboard/couts', label: t('Coûts', 'Costs') },
      { key: 'quanti-funnel', href: '/dashboard/funnel', label: t('Funnel', 'Funnel') },
      { key: 'quanti-erreurs', href: '/dashboard/erreurs', label: t('Erreurs', 'Errors') },
    ] },
    { key: 'dashboard-quali', href: '/dashboard/quali', label: t('Qualitatif', 'Qualitative') },
    { key: 'dashboard-tableaux', href: '/dashboard/tableaux', label: t('Mes tableaux', 'My reports') },
  ];
```

Puis, juste après `NAV_ADMIN_BAS` et `NAV_AGENT`, remplacer le calcul du chemin :

```tsx
  /** Les trois arbres, dans l'ordre de recherche de `ongletDeLaPage`. `NAV_ADMIN_BAS` appartient à Console. */
  const ARBRES: Record<Onglet, NavEntree[]> = {
    console: [...NAV_CONSOLE, ...NAV_ADMIN_BAS],
    inbox: NAV_INBOX,
    perf: NAV_PERF,
  };
  const onglet = ongletDeLaPage(ARBRES, active);
  // Le chemin des groupes à déplier se calcule dans l'arbre de l'onglet COURANT, pas dans l'union : deux
  // arbres pourraient porter un groupe de même clé, et l'union ferait déplier celui du mauvais onglet.
  const chemin = cheminDeNav(ARBRES[onglet], active);
```

Mettre à jour l'import : `import { cheminDeNav, ongletDeLaPage, type NavEntree, type Onglet } from '@/lib/nav';`

- [ ] **Étape 4 : lancer les tests pour les voir PASSER**

```bash
cd web && npx vitest run lib/nav.test.ts && npx tsc --noEmit
```
Attendu : tous verts.

- [ ] **Étape 5 : commiter**

```bash
git commit --only web/components/AppShell.tsx web/lib/nav.test.ts -m "refactor(nav): scinder la navigation en trois arbres, un par onglet"
```

---

## Tâche 3 : la barre d'onglets, et la mise en page qui l'accueille

**Fichiers :**
- Modifier : `web/components/AppShell.tsx` (le `return`, lignes ~309 à ~330)

**Interfaces :**
- Consomme : `onglet`, `ARBRES`, `NAV_CONSOLE`/`NAV_INBOX`/`NAV_PERF` (tâche 2).
- Produit : le rendu. Aucune nouvelle export.

**La mise en page.** Aujourd'hui l'entête vit à l'intérieur de la colonne de droite, donc à droite de la
barre latérale. La barre d'onglets doit être **au-dessus des deux**, sinon les onglets auraient l'air de
faire partie du contenu alors qu'ils changent le menu. On sort donc l'entête de la colonne :

```
<div class="min-h-screen flex flex-col">
  <header>  logo | ONGLETS | AccountMenu  </header>   <- pleine largeur, h-14
  <div class="lg:flex flex-1 min-h-0">
     <aside>  le menu de l'onglet  </aside>
     <div>  bannières + main  </div>
  </div>
</div>
```

⚠️ **`h-14` sur l'entête n'est pas décoratif** : la colonne latérale est `sticky top-0 h-screen`. Sous une
entête de hauteur inconnue, elle dépasserait de l'écran et son bloc bas (Developers) deviendrait
inatteignable. Elle devient `sticky top-14 h-[calc(100vh-3.5rem)]`, et les deux valeurs doivent rester
d'accord.

- [ ] **Étape 1 : rendre la barre d'onglets**

Ajouter, juste avant le `return`, la définition des onglets et leur destination :

```tsx
  /**
   * Les trois onglets et leur point d'entrée.
   *
   * ⚠️ La destination du Performance Lab est `/dashboard`, sa PREMIÈRE entrée, et non une page de synthèse :
   * celle-ci arrive avec les lots E et F, ceux qui lui donnent son contenu. Ce lot ne crée aucune adresse.
   */
  const ONGLETS_UI: Array<{ cle: Onglet; label: string; href: string }> = [
    { cle: 'console', label: t('Console', 'Console'), href: '/accueil' },
    { cle: 'inbox', label: t('Inbox', 'Inbox'), href: '/inbox' },
    { cle: 'perf', label: t('Performance Lab', 'Performance Lab'), href: '/dashboard' },
  ];
  // 🔴 Un compte `agent` n'a accès QU'À l'inbox (`adminOnly` ci-dessus, et le serveur derrière). Lui montrer
  // trois onglets dont deux le renverraient à l'inbox serait pire que la barre unique d'avant.
  const ongletsVisibles = session.role === 'admin' ? ONGLETS_UI : ONGLETS_UI.filter((o) => o.cle === 'inbox');
```

Dans l'entête, entre le bouton du tiroir mobile et `AccountMenu` :

```tsx
          <nav aria-label={t('Sections', 'Sections')} className="flex items-center gap-1" data-testid="onglets">
            {ongletsVisibles.map((o) => (
              <Link
                key={o.cle}
                href={o.href}
                data-testid={`onglet-${o.cle}`}
                aria-current={onglet === o.cle ? 'page' : undefined}
                className={`rounded-lg px-3 py-1.5 text-sm transition ${
                  onglet === o.cle
                    ? 'bg-brand-50 font-semibold text-brand-700'
                    : 'text-ink-600 hover:bg-ink-100 hover:text-ink-900'
                }`}
              >
                {o.label}
              </Link>
            ))}
          </nav>
```

- [ ] **Étape 2 : la barre latérale suit l'onglet**

Dans `SidebarInner`, remplacer `{renderNav(nav)}` par le menu de l'onglet, et masquer la colonne entière
dans l'onglet Inbox :

```tsx
  // L'onglet Inbox n'a PAS de menu de navigation : son écran porte son propre menu de dossiers (lot B).
  // Une colonne vide y prendrait 15 rem de large pour ne rien montrer.
  const avecBarreLaterale = onglet !== 'inbox';
  const navDeLOnglet = session.role === 'admin' ? ARBRES[onglet] : NAV_INBOX;
```

Le logo passe dans l'entête (il est désormais en haut, à gauche des onglets) ; `SidebarInner` ne garde que
la nav et le bloc bas. Le bloc bas (`NAV_ADMIN_BAS`) ne se rend que dans l'onglet Console :
`{session.role === 'admin' && onglet === 'console' && ( … )}`.

Envelopper `<aside>` et le tiroir mobile dans `{avecBarreLaterale && ( … )}`.

- [ ] **Étape 3 : vérifier à l'œil et au type**

```bash
cd web && npx tsc --noEmit && npm run build
```
Attendu : aucune erreur.

- [ ] **Étape 4 : commiter**

```bash
git commit --only web/components/AppShell.tsx -m "feat(nav): la barre des trois onglets, au-dessus du menu"
```

---

## Tâche 4 : les onglets vus du navigateur

**Fichiers :**
- Créer : `web/e2e/navigation-onglets.spec.ts`

**Interfaces :**
- Consomme : les `data-testid` `onglets`, `onglet-console`, `onglet-inbox`, `onglet-perf` (tâche 3).

- [ ] **Étape 1 : écrire les tests**

```ts
import { test, expect } from '@playwright/test';

/**
 * Les trois onglets, et ce qu'ils rangent.
 *
 * 🔴 Ce que ce fichier protège : qu'AUCUNE URL n'ait bougé, et que l'onglet actif se DÉDUISE de la page
 * plutôt que d'être passé par elle. Le second point ne se voit qu'en arrivant directement sur une page
 * profonde : c'est le cas d'un favori ou d'un lien partagé, celui que personne n'essaie à la main.
 */
const ADMIN = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };
const AGENT = { token: 'e2e-token', email: 'agent@e2e.test', role: 'agent', tenantId: 't-e2e' };

async function mock(page: import('@playwright/test').Page, session: typeof ADMIN) {
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), session);
  await page.route('**/api/backend/**', async (route) => {
    const url = route.request().url();
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (url.includes('/unread-count')) return json({ count: 0 });
    if (url.endsWith('/me')) return json({ email: session.email, name: 'Jean Test', role: session.role });
    return json({});
  });
}

test.describe('Navigation : trois onglets', () => {
  for (const [chemin, attendu] of [
    ['/accueil', 'console'],
    ['/campaigns', 'console'],
    ['/templates', 'console'],
    ['/inbox', 'inbox'],
    ['/dashboard', 'perf'],
    ['/dashboard/couts', 'perf'],
  ] as const) {
    test(`arriver sur ${chemin} active l’onglet « ${attendu} »`, async ({ page }) => {
      await mock(page, ADMIN);
      await page.goto(chemin);
      await expect(page.getByTestId(`onglet-${attendu}`)).toHaveAttribute('aria-current', 'page');
      // Et l'URL n'a pas bougé : les onglets ne redirigent rien.
      expect(new URL(page.url()).pathname).toBe(chemin);
    });
  }

  test('🔴 l’onglet Inbox n’a AUCUN menu de navigation', async ({ page }) => {
    await mock(page, ADMIN);
    await page.goto('/inbox');
    await expect(page.getByTestId('onglet-inbox')).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('link', { name: 'Campagnes' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: /Mes tableaux/ })).toHaveCount(0);
  });

  test('🔴 le Performance Lab montre l’arbre Analytics, et PAS le reste de la console', async ({ page }) => {
    await mock(page, ADMIN);
    await page.goto('/dashboard/couts');
    await expect(page.getByRole('link', { name: /Mes tableaux/ })).toBeVisible();
    // Preuve inverse : sans elle, une barre qui montrerait TOUT passerait le test ci-dessus.
    await expect(page.getByRole('link', { name: 'Campagnes' })).toHaveCount(0);
  });

  test('🔴 un compte agent ne voit qu’UN onglet', async ({ page }) => {
    await mock(page, AGENT);
    await page.goto('/inbox');
    await expect(page.getByTestId('onglet-inbox')).toBeVisible();
    await expect(page.getByTestId('onglet-console')).toHaveCount(0);
    await expect(page.getByTestId('onglet-perf')).toHaveCount(0);
  });
});
```

- [ ] **Étape 2 : lancer les tests**

```bash
cd web && npx playwright test e2e/navigation-onglets.spec.ts --reporter=line
```
Attendu : tous verts.

- [ ] **Étape 3 : prouver qu'ils échouent SANS le correctif**

Remplacer temporairement dans `AppShell.tsx` le calcul `const onglet = ongletDeLaPage(ARBRES, active);` par
`const onglet: Onglet = 'console';`, relancer la suite, **constater l'échec sur `/inbox` et `/dashboard`**,
puis restaurer. Un test d'onglet actif qui passerait avec un onglet figé ne garderait rien.

- [ ] **Étape 4 : commiter**

```bash
git commit --only web/e2e/navigation-onglets.spec.ts -m "test(nav): les trois onglets, et la preuve qu aucune URL ne bouge"
```

---

## Tâche 5 : la doc, et la livraison

**Fichiers :**
- Modifier : `features.md`, `wip.md`

- [ ] **Étape 1 : décrire l'onglet dans `features.md`**

Ajouter, dans la section de navigation :

```markdown
- ✅ **Trois onglets en haut de la console** (2026-09-08) : **Console** (configurer et opérer), **Inbox**
  (traiter les conversations) et **Performance Lab** (lire les résultats). Le menu de gauche change avec
  l'onglet : la Console garde le menu d'avant, le Performance Lab montre l'arbre Analytics, et l'Inbox n'a
  aucun menu de navigation. ⚠️ **Aucune adresse n'a changé** : un favori ou un lien partagé continue
  d'ouvrir la même page, qui s'affiche simplement dans son onglet. Un compte opérateur ne voit que l'Inbox.
```

- [ ] **Étape 2 : mettre `wip.md` à jour**

Cocher le lot A comme livré dans l'entrée « Refonte des menus », et laisser les cinq autres en attente.

- [ ] **Étape 3 : la suite complète, avant de pousser**

```bash
cd web && npx tsc --noEmit && npx vitest run && npx playwright test --reporter=line
cd .. && npx tsc --noEmit && npx vitest run
```
Attendu : tout vert. ⚠️ **La suite E2E entière**, pas seulement le fichier neuf : ce lot touche l'ossature
de 33 pages, et c'est exactement le genre de changement dont les dégâts se voient ailleurs.

- [ ] **Étape 4 : la revue**

Lancer `/revue` sur le lot, corriger 🔴 **et** 🟡 dans la foulée, puis commiter les corrections.

- [ ] **Étape 5 : pousser et déployer**

```bash
git commit --only features.md wip.md -m "docs: les trois onglets de la console"
git push origin main
```
Puis attendre le vert de la CI **job par job** (`gh run view <id> --json jobs`, jamais le code de sortie de
`gh run watch`), et déployer : la console vit sur Vercel (automatique au push) **et** sur le VPS
(`git pull` + `docker compose up -d --build`, attendre `healthy`, recharger nginx, puis
`node scripts/fumee.mjs`).

---

## Auto-relecture du plan

**Couverture de la spec (lot A) :** trois onglets → tâches 2 et 3 · contenu de chaque onglet → tâche 2 ·
aucune URL ne change → contrainte globale + tâche 4 · déduction depuis `active` → tâche 1 · Inbox sans barre
→ tâche 3, vérifié tâche 4 · Performance Lab = arbre Analytics → tâche 2, vérifié tâche 4 · RBAC agent →
tâche 3, vérifié tâche 4 · test de couverture de `Tab` → tâche 2. **Un écart assumé et écrit** : la route
`/performance` part aux lots E et F.

**Cohérence des noms :** `Onglet`, `ONGLETS`, `contientLaCle`, `ongletDeLaPage`, `ARBRES`, `NAV_CONSOLE`,
`NAV_INBOX`, `NAV_PERF`, `ONGLETS_UI`, `ongletsVisibles`, `avecBarreLaterale` sont employés avec la même
orthographe de la tâche 1 à la tâche 4.
