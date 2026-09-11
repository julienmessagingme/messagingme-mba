# Bot d'aide de la console : plan d'implémentation

> **Pour un exécutant agentique :** SOUS-SKILL REQUISE, `superpowers:subagent-driven-development` (recommandé)
> ou `superpowers:executing-plans`, tâche par tâche. Les étapes portent des cases `- [ ]`.

**But :** un bouton de discussion dans la console qui répond aux questions de mode d'emploi et emmène la
personne sur le bon écran, sans jamais rien écrire.

**Architecture :** deux connaissances séparées. La CARTE de la console est dérivée de l'arbre de navigation
(donc jamais fausse, et le compilateur la garde) ; le MODE D'EMPLOI est un jeu de fiches en markdown versionnées
dans le dépôt, chargées en base et cherchées par le même rappel hybride que la connaissance des agents. Le
modèle ne choisit jamais une adresse : il choisit une CLÉ dans une liste fermée, que le serveur résout.

**Pile :** TypeScript, Fastify, Postgres (tsvector français + pgvector), Next.js 16, vitest, Playwright.

**Spec :** [docs/superpowers/specs/2026-09-11-bot-aide-console-design.md](../specs/2026-09-11-bot-aide-console-design.md)

## Un écart assumé par rapport à la spec

La spec prévoyait une table avec `statut` (`brouillon` / `publiee`) et un écran de relecture en diff.
**Ce plan supprime les deux** : les fiches sont des fichiers markdown dans `docs/aide/fiches/`, donc la
relecture est un diff git, l'historique est gratuit, et il n'y a aucune interface d'administration à
construire ni à tenir. La base ne sert plus qu'à la RECHERCHE, elle n'est plus la source.

⚠️ **La spec a été mise à jour EN MÊME TEMPS que ce plan**, pas plus tard : deux documents qui se
contredisent dans le dépôt, c'est la dérive que le CLAUDE.md passe son temps à réparer. Rien à faire pour
l'exécutant sur ce point.

## Contraintes globales

Elles s'appliquent à CHAQUE tâche, sans être répétées dans chacune.

- **Git : `git commit --only <chemins>`, JAMAIS `git add` puis `git commit` nu.** Pour un fichier nouveau,
  `git add -N <chemin>` d'abord. Rester sur `main`, pousser sur `origin`.
- **Le hook `rayon-de-souffle.js` bloque le PREMIER `git commit`** : lire sa sortie, puis relancer la MÊME
  commande, qui passe.
- **Aucun tiret cadratin ni demi-cadratin**, nulle part. Virgule, deux-points, parenthèses ou point.
- **Commentaires et messages en français**, comme tout le dépôt.
- **Un message de commit se passe par FICHIER (`-F`)**, jamais en ligne : les accents graves sont mangés par
  le shell.
- **`tenant_id = $1` sur chaque requête** qui touche une table portant un tenant. La RLS est contournée (le
  pooler est superuser), ce filtrage est le SEUL contrôle.
- **Erreur utilisateur = 4xx, jamais 5xx** : Cloudflare remplace le corps de toute réponse 5xx.
- **`safeParse`, jamais `parse`**, sur toute entrée non fiable.
- **Prochaine migration libre : 0131.** Les migrations ne sont PAS auto-appliquées. Une migration qui AJOUTE
  une colonne écrite par le code passe AVANT le déploiement.
- **Un test ne compte que MUTÉ à la main** : remettre le code fautif, constater l'échec ET son symptôme,
  restaurer. Le noter dans le message de commit.
- **`npm test` en local ne prouve que la moitié** : les tests d'intégration ne tournent qu'en CI. Après une
  poussée, lire le run job par job (`gh run view <id> --json jobs`), jamais `gh run watch --exit-status`.
- **Aucun `Workflow` ni `Agent` sans un oui explicite de Julien.**

## Les fichiers, et de quoi chacun répond

| Fichier | Responsabilité |
|---|---|
| `web/lib/nav.ts` (modifié) | `arbresNav(t)` : la structure ET les libellés de la barre, en un seul endroit |
| `web/components/AppShell.tsx` (modifié) | consomme `arbresNav(t)` au lieu de construire l'arbre |
| `scripts/carte-console.mts` (nouveau) | émet `src/aide/carte-console.json` depuis `arbresNav` |
| `src/aide/carte-console.json` (généré) | la carte lue par le serveur : clé, adresse, libellés FR/EN, rôle |
| `src/aide/carte.ts` (nouveau) | lit la carte, la filtre par rôle, résout une clé. Aucune entrée/sortie |
| `db/migrations/0131_aide_fiches.sql` (nouveau) | la table de recherche des fiches |
| `src/aide/fiches.ts` (nouveau) | le contrat du dépôt de fiches et le format d'un fichier de fiche |
| `src/aide/fiches.pg.ts` (nouveau) | la recherche hybride, calquée sur `PgKnowledgeStore` |
| `docs/aide/fiches/*.md` (nouveaux) | les fiches elles-mêmes, relues en diff |
| `db/charger-aide.ts` (nouveau) | `npm run aide:charger` : lit les .md, écrit la table |
| `scripts/aide-proposer.mts` (nouveau) | propose des brouillons de fiches depuis `features.md` |
| `src/aide/repondre.ts` (nouveau) | le moteur : rappel, reclassement, appel modèle, validation des clés |
| `src/http/aide.ts` (nouveau) | la route `POST /tenants/:tenantId/aide` |
| `web/components/BoutonAide.tsx` (nouveau) | le bouton flottant et son panneau |

---

### Tâche 1 : la barre de navigation devient une SOURCE, pas un rendu

Aujourd'hui l'arbre de nav est construit à l'intérieur du composant `AppShell`, au rendu, pour que les
libellés suivent la langue. Rien d'autre ne peut donc le lire. On l'extrait en une fonction qui PREND le
traducteur, ce qui garde structure et libellés ensemble (une structure séparée des libellés serait deux
listes à tenir alignées, et le CLAUDE.md du dépôt dit ce que ça coûte).

**Fichiers :**
- Modifier : `web/lib/nav.ts` (ajouter `Traducteur`, `EntreeNav`, `arbresNav`)
- Modifier : `web/components/AppShell.tsx` (consommer `arbresNav(t)`)
- Test : `web/lib/nav.test.ts` (ajouts) et `tests/web-carte-console.test.ts` (nouveau)

**Interfaces :**
- Produit : `arbresNav(t: Traducteur): Record<Onglet, EntreeNav[]>`, où
  `type Traducteur = (fr: string, en: string) => string` et
  `interface EntreeNav extends NavEntree { adminOnly?: boolean }`.
- Consommé par : tâche 2 (`scripts/carte-console.mts`).

- [ ] **Étape 1 : écrire le test qui échoue**

Dans `tests/web-carte-console.test.ts` :

```ts
import { describe, it, expect } from 'vitest';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { arbresNav, ONGLETS, type EntreeNav } from '../web/lib/nav';

/**
 * LA BARRE DE NAVIGATION EST LA CARTE DE LA CONSOLE, et ce test est ce qui l'empêche de mentir.
 *
 * 🔴 Le bot d'aide emmène la personne sur un écran en choisissant une CLÉ de cette barre. Une clé qui ne
 * mène nulle part produirait un lien mort dans une réponse d'aide, c'est-à-dire exactement la faute qu'on
 * refuse : un bot qui annonce un bouton qui n'existe pas fait perdre confiance dans le PRODUIT.
 */
const t = (fr: string) => fr;

/** Toutes les entrées de tous les onglets, à plat. */
function aPlat(entrees: EntreeNav[]): EntreeNav[] {
  return entrees.flatMap((e) => [e, ...(e.children ? aPlat(e.children as EntreeNav[]) : [])]);
}

/** Les adresses servies par une page réelle de `web/app`, sous la forme `/campaigns`. */
function routesReelles(): Set<string> {
  const racine = new URL('../web/app', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
  const vues = new Set<string>();
  const descendre = (dossier: string, prefixe: string): void => {
    for (const nom of readdirSync(dossier)) {
      const chemin = join(dossier, nom);
      if (statSync(chemin).isDirectory()) {
        // Les segments entre parenthèses sont des GROUPES Next : ils n'apparaissent pas dans l'URL.
        descendre(chemin, nom.startsWith('(') ? prefixe : `${prefixe}/${nom}`);
      } else if (nom === 'page.tsx') {
        vues.add(prefixe === '' ? '/' : prefixe);
      }
    }
  };
  descendre(racine, '');
  return vues;
}

describe('la carte de la console', () => {
  it('🔴 chaque adresse de la barre est servie par une page réelle', () => {
    const routes = routesReelles();
    const arbres = arbresNav(t);
    for (const onglet of ONGLETS) {
      for (const e of aPlat(arbres[onglet])) {
        if (!e.href) continue;
        expect(routes.has(e.href), `la barre pointe vers ${e.href}, qui n’a pas de page`).toBe(true);
      }
    }
  });

  it('une entrée porte SOIT une adresse SOIT des enfants, jamais ni l’un ni l’autre', () => {
    // Une entrée sans les deux est invisible du bot comme de l'utilisateur : elle n'est ni une destination
    // ni un groupe. C'est une faute de saisie, pas un cas à tolérer.
    const arbres = arbresNav(t);
    for (const onglet of ONGLETS) {
      for (const e of aPlat(arbres[onglet])) {
        expect(Boolean(e.href) || Boolean(e.children?.length), `entrée « ${e.key} » vide`).toBe(true);
      }
    }
  });

  it('aucune clé n’apparaît deux fois, tous onglets confondus', () => {
    // Deux entrées de même clé rendraient la résolution d'une clé ambiguë, et le bot enverrait au hasard.
    const toutes = ONGLETS.flatMap((o) => aPlat(arbresNav(t)[o])).map((e) => e.key);
    expect(new Set(toutes).size).toBe(toutes.length);
  });
});
```

- [ ] **Étape 2 : lancer le test, vérifier qu'il échoue**

```bash
npx vitest run tests/web-carte-console.test.ts
```

Attendu : ÉCHEC, `arbresNav` n'est pas exporté de `web/lib/nav.ts`.

- [ ] **Étape 3 : ajouter `arbresNav` à `web/lib/nav.ts`**

Y déplacer VERBATIM les trois tableaux `NAV_CONSOLE`, `NAV_INBOX` et `NAV_PERF` qui vivent aujourd'hui dans
`AppShell`, en remplaçant les appels `t(...)` par le paramètre. Ajouter en tête du fichier :

```ts
/** Le traducteur de la console, réduit à ce que la barre en utilise (`web/lib/i18n`). */
export type Traducteur = (fr: string, en: string) => string;

/**
 * Une entrée de barre, plus le DROIT d'y accéder.
 *
 * 🔴 `adminOnly` voyage AVEC l'entrée, il n'est pas déduit ailleurs. Le bot d'aide emmène une personne vers
 * un écran : envoyer un agent sur un écran d'administrateur le ferait tomber sur un refus, ce qui est pire
 * que de ne pas répondre. La vraie autorité reste le serveur, comme pour l'affichage de la barre.
 */
export interface EntreeNav extends NavEntree {
  adminOnly?: boolean;
  children?: EntreeNav[];
}

/**
 * LES TROIS ARBRES DE LA BARRE, structure ET libellés.
 *
 * 🔴 POURQUOI UNE FONCTION ET PAS UNE CONSTANTE : les libellés suivent la langue courante, donc ils ne
 * peuvent pas être figés au chargement du module. Et pourquoi structure et libellés ENSEMBLE plutôt qu'une
 * constante de structure plus une table de libellés : ce seraient deux listes à tenir alignées à la main,
 * et le CLAUDE.md de ce dépôt documente ce que ça coûte (un `Pick` recopié pour être retransmis dérive).
 *
 * ⚠️ C'est aussi la CARTE que lit le bot d'aide, via `scripts/carte-console.mts`. Ajouter un écran ici le
 * rend connaissable du bot ; l'oublier ici le lui rend invisible, ce qui est le bon défaut (silence plutôt
 * qu'invention).
 */
export function arbresNav(t: Traducteur): Record<Onglet, EntreeNav[]> {
  // ... les trois tableaux, déplacés depuis AppShell
}
```

- [ ] **Étape 4 : faire consommer `arbresNav` par `AppShell`**

Remplacer les trois déclarations locales par :

```tsx
const { console: NAV_CONSOLE, inbox: NAV_INBOX, perf: NAV_PERF } = arbresNav(t);
```

- [ ] **Étape 5 : lancer les tests et le typecheck**

```bash
npx vitest run tests/web-carte-console.test.ts web/lib/nav.test.ts && npx tsc --noEmit && (cd web && npx tsc --noEmit)
```

Attendu : tout vert.

- [ ] **Étape 6 : vérifier que la barre s'affiche encore, pour de vrai**

```bash
cd web && npx playwright test e2e/ --reporter=line
```

Attendu : les e2e de la console passent. C'est le seul contrôle qui prouve qu'un déplacement de 200 lignes
de JSX n'a rien cassé visuellement.

- [ ] **Étape 7 : muter le test de parité**

Changer un `href` de `arbresNav` en `/nexistepas`, relancer `tests/web-carte-console.test.ts`, constater
l'échec ET son message, restaurer.

- [ ] **Étape 8 : commiter** (message dans un fichier, puis `-F`)

```bash
git add -N tests/web-carte-console.test.ts
git commit --only web/lib/nav.ts web/components/AppShell.tsx tests/web-carte-console.test.ts -F /tmp/msg.txt
```

---

### Tâche 2 : la carte, émise pour le serveur

Le serveur ne peut pas importer `web/`. La carte est donc ÉMISE en JSON, et un test casse la CI quand le
fichier émis ne correspond plus à la barre.

**Fichiers :**
- Créer : `scripts/carte-console.mts`, `src/aide/carte-console.json`, `src/aide/carte.ts`
- Modifier : `package.json` (script `aide:carte`)
- Test : `tests/aide-carte.test.ts`

**Interfaces :**
- Consomme : `arbresNav(t)` (tâche 1).
- Produit :
  ```ts
  export interface EcranAide { cle: string; href: string; fr: string; en: string; adminOnly: boolean; chemin: string[] }
  export function chargerCarte(): EcranAide[]
  export function carteVisiblePar(role: string): EcranAide[]
  export function resoudre(cles: string[], role: string): EcranAide[]
  ```

- [ ] **Étape 1 : écrire le test qui échoue**

Dans `tests/aide-carte.test.ts` :

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { chargerCarte, carteVisiblePar, resoudre } from '../src/aide/carte';

/**
 * LA CARTE QUE LIT LE BOT D'AIDE.
 *
 * 🔴 C'EST LA GARDE ANTI-HALLUCINATION, et elle est structurelle. Le modèle ne rend jamais une adresse, il
 * rend une CLÉ, et `resoudre` la cherche dans cette liste fermée. Une clé inventée ne produit aucun lien.
 * Une consigne de prompt (« ne cite que des écrans réels ») serait un souhait ; ceci est une garantie.
 */
describe('carte de la console', () => {
  it('🔴 le fichier émis correspond à la barre : sinon la CI casse', () => {
    // Le fichier est un ARTEFACT, pas une source. S'il dérive, le bot emmène vers l'état d'hier.
    const avant = readFileSync(new URL('../src/aide/carte-console.json', import.meta.url), 'utf8');
    execFileSync('npx', ['tsx', 'scripts/carte-console.mts'], { stdio: 'pipe', shell: true });
    const apres = readFileSync(new URL('../src/aide/carte-console.json', import.meta.url), 'utf8');
    expect(apres, 'carte périmée : lancer `npm run aide:carte` et commiter').toBe(avant);
  });

  it('un agent ne voit AUCUN écran réservé aux administrateurs', () => {
    const vue = carteVisiblePar('agent');
    expect(vue.length).toBeGreaterThan(0);
    expect(vue.every((e) => !e.adminOnly)).toBe(true);
    // Et le miroir, sinon le test passerait aussi sur une carte vide de son filtre.
    expect(carteVisiblePar('admin').some((e) => e.adminOnly)).toBe(true);
  });

  it('🔴 une clé INVENTÉE ne produit aucun écran', () => {
    expect(resoudre(['campagnes', 'ecran-imaginaire'], 'admin').map((e) => e.cle)).toEqual(['campagnes']);
  });

  it('🔴 une clé RÉSERVÉE aux administrateurs ne se résout pas pour un agent', () => {
    // Le modèle voit une carte filtrée, mais il peut recracher une clé vue ailleurs dans la conversation.
    // Le filtrage est donc refait à la résolution, pas seulement à la présentation.
    const admin = chargerCarte().find((e) => e.adminOnly)!;
    expect(resoudre([admin.cle], 'agent')).toEqual([]);
    expect(resoudre([admin.cle], 'admin')).toHaveLength(1);
  });
});
```

- [ ] **Étape 2 : lancer le test, vérifier qu'il échoue**

```bash
npx vitest run tests/aide-carte.test.ts
```

Attendu : ÉCHEC, `src/aide/carte.ts` n'existe pas.

- [ ] **Étape 3 : écrire l'émetteur `scripts/carte-console.mts`**

```ts
import { writeFileSync } from 'node:fs';
import { arbresNav, ONGLETS, type EntreeNav } from '../web/lib/nav';

/**
 * ÉMET LA CARTE DE LA CONSOLE pour le serveur, depuis la barre de navigation.
 *
 * 🔴 POURQUOI UN FICHIER ÉMIS PLUTÔT QU'UN IMPORT. Le serveur (`src/`) et la console (`web/`) sont deux
 * bundles séparés ; le serveur ne peut pas importer `web/lib/nav.ts` à l'exécution. Recopier la carte à la
 * main serait une seconde liste qui dérive. L'émettre garde UNE source, et `tests/aide-carte.test.ts` casse
 * la CI le jour où le fichier émis ne correspond plus.
 *
 * ⚠️ `adminOnly` est HÉRITÉ d'un parent : un écran rangé sous un groupe réservé l'est aussi, même s'il ne
 * le déclare pas lui-même. L'oublier enverrait un agent sur un refus.
 */
const fr = (f: string) => f;
const en = (_f: string, e: string) => e;

interface EcranAide { cle: string; href: string; fr: string; en: string; adminOnly: boolean; chemin: string[] }

function aplatir(entrees: EntreeNav[], libelles: Map<string, string>, chemin: string[], herite: boolean, out: EcranAide[]): void {
  for (const e of entrees) {
    const admin = herite || e.adminOnly === true;
    if (e.href) {
      out.push({ cle: e.key, href: e.href, fr: e.label, en: libelles.get(e.key) ?? e.label, adminOnly: admin, chemin });
    }
    if (e.children) aplatir(e.children, libelles, [...chemin, e.label], admin, out);
  }
}

const arbresFr = arbresNav(fr);
const arbresEn = arbresNav(en);
const libelles = new Map<string, string>();
const collecter = (entrees: EntreeNav[]): void => {
  for (const e of entrees) {
    libelles.set(e.key, e.label);
    if (e.children) collecter(e.children);
  }
};
for (const o of ONGLETS) collecter(arbresEn[o]);

const ecrans: EcranAide[] = [];
for (const o of ONGLETS) aplatir(arbresFr[o], libelles, [], false, ecrans);
ecrans.sort((a, b) => a.cle.localeCompare(b.cle));

writeFileSync(
  new URL('../src/aide/carte-console.json', import.meta.url),
  `${JSON.stringify(ecrans, null, 2)}\n`,
  'utf8',
);
// eslint-disable-next-line no-console
console.log(`carte émise : ${ecrans.length} écrans`);
```

- [ ] **Étape 4 : écrire `src/aide/carte.ts`**

```ts
import carte from './carte-console.json' with { type: 'json' };

/** Un écran de la console, tel que le bot d'aide peut y emmener quelqu'un. */
export interface EcranAide {
  cle: string;
  href: string;
  fr: string;
  en: string;
  adminOnly: boolean;
  /** Les groupes qui mènent à l'écran, pour dire « Tools > Connecteurs API » plutôt que « Connecteurs ». */
  chemin: string[];
}

export function chargerCarte(): EcranAide[] {
  return carte as EcranAide[];
}

/**
 * Les écrans que cette personne a le droit d'atteindre.
 *
 * ⚠️ Tout rôle qui n'est pas `admin` est traité comme un agent, et c'est volontaire : un rôle inconnu (ajouté
 * plus tard, ou corrompu) doit voir MOINS, jamais plus.
 */
export function carteVisiblePar(role: string): EcranAide[] {
  return role === 'admin' ? chargerCarte() : chargerCarte().filter((e) => !e.adminOnly);
}

/**
 * Résout les clés rendues par le modèle en écrans réels.
 *
 * 🔴 C'EST ICI QUE LA GARDE SE FERME. Une clé inconnue est JETÉE, jamais devinée, jamais rapprochée d'une
 * clé voisine : un lien approximatif est pire qu'un lien absent. Et le filtrage par rôle est REFAIT ici, pas
 * seulement à la présentation, parce que le modèle peut recracher une clé vue ailleurs dans la conversation.
 */
export function resoudre(cles: string[], role: string): EcranAide[] {
  const permis = new Map(carteVisiblePar(role).map((e) => [e.cle, e]));
  const vus = new Set<string>();
  const out: EcranAide[] = [];
  for (const c of cles) {
    const e = permis.get(c);
    if (e && !vus.has(c)) { vus.add(c); out.push(e); }
  }
  return out;
}
```

- [ ] **Étape 5 : générer la carte et ajouter le script npm**

Ajouter à `package.json` : `"aide:carte": "tsx scripts/carte-console.mts"`, puis :

```bash
npm run aide:carte
```

- [ ] **Étape 6 : lancer les tests**

```bash
npx vitest run tests/aide-carte.test.ts && npx tsc --noEmit
```

Attendu : les quatre tests passent.

- [ ] **Étape 7 : muter, dans les deux sens**

Retirer le filtre de rôle de `carteVisiblePar` : le test « un agent ne voit aucun écran réservé » doit
tomber. Restaurer. Puis retirer le `permis.get` de `resoudre` au profit d'un objet construit sur la carte
entière : le test de la clé réservée doit tomber. Restaurer.

- [ ] **Étape 8 : commiter**

```bash
git add -N scripts/carte-console.mts src/aide/carte.ts src/aide/carte-console.json tests/aide-carte.test.ts
git commit --only scripts/carte-console.mts src/aide/carte.ts src/aide/carte-console.json tests/aide-carte.test.ts package.json -F /tmp/msg.txt
```

---

### Tâche 3 : la table de recherche, migration 0131

**Fichiers :**
- Créer : `db/migrations/0131_aide_fiches.sql`, `src/aide/fiches.ts`, `src/aide/fiches.pg.ts`
- Modifier : `CLAUDE.md` (la ligne du compteur, APRÈS avoir appliqué la migration)
- Test : `tests/integration/aide-fiches.integration.test.ts`

**Interfaces :**
- Produit :
  ```ts
  export interface FicheAide { id: string; cle: string; titre: string; corps: string; ecran: string | null; couverture: number; proximiteTitre: number; similarite?: number }
  export interface DepotAide {
    chercher(requete: string, limite: number): Promise<FicheAide[]>;
    chercherParVecteur?(vecteur: number[], limite: number): Promise<FicheAide[]>;
  }
  export class PgDepotAide implements DepotAide, DepotAVectoriser { constructor(pool: Pool) }
  ```
- Consommé par : tâches 4 et 6.

- [ ] **Étape 1 : écrire la migration**

`db/migrations/0131_aide_fiches.sql` :

```sql
-- 0131 : les fiches du MODE D EMPLOI de la console, pour le bot d aide.
--
-- POURQUOI UNE TABLE A PART, et surtout pas `agent_knowledge` avec un `tenant_id` nullable. Ce filtre par
-- espace est LE controle d isolation entre clients : la RLS est contournee (le pooler est superuser), donc
-- `tenant_id = $1` est le seul controle qui reste. Le rendre conditionnel sur la table qui porte la
-- connaissance METIER des clients, pour y loger une donnee qui n a aucune raison d y etre, serait un
-- mauvais echange. Une table de plus ne coute rien.
--
-- ⚠️ CETTE TABLE N EST PAS LA SOURCE, elle est l INDEX. La source, ce sont les fichiers de
-- `docs/aide/fiches/`, versionnes et relus en diff. `npm run aide:charger` recopie les fichiers ici. Une
-- ligne effacee a la main se retrouve donc au chargement suivant, et c est voulu.
--
-- ⚠️ AUCUN `tenant_id` : le mode d emploi est le meme pour tout le monde. C est ce qui permet de mutualiser
-- le cout d une question posee deux fois.
--
-- ⚠️ ELLE CREE UNE TABLE QUE LE CODE ECRIT : elle passe AVANT le deploiement.
create table if not exists aide_fiches (
  id                uuid primary key default gen_random_uuid(),
  -- La cle est le NOM DU FICHIER sans extension. C est elle qui rend le chargement idempotent : recharger
  -- met a jour, il ne duplique pas.
  cle               text not null unique,
  titre             text not null,
  corps             text not null,
  -- La cle de NAV de l ecran concerne (`campagnes`, `workflows`...), jamais une URL. Une URL enregistree en
  -- base vieillit en silence le jour ou une page demenage ; une cle est resolue a l affichage par la carte,
  -- donc elle suit, et une cle inconnue est detectable.
  ecran             text,
  -- La section de `features.md` dont la fiche est tiree, et son empreinte au moment de la relecture. C est
  -- ce couple qui permet de DETECTER qu une fiche est devenue perimee sans la regenerer en silence.
  source_section    text,
  source_empreinte  text,
  corps_tsv         tsvector generated always as
                      (to_tsvector('french'::regconfig, coalesce(titre,'') || ' ' || coalesce(corps,''))) stored,
  -- Memes colonnes qu en 0110, meme dimension : c est le meme modele qui vectorise (`AGENT_EMBED_MODEL`),
  -- et en changer obligerait a recalculer les deux bases, pas une seule.
  embedding         vector(1536),
  embedding_modele  text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists aide_fiches_tsv_idx on aide_fiches using gin (corps_tsv);
create index if not exists aide_fiches_titre_trgm_idx on aide_fiches using gin (titre gin_trgm_ops);
-- Meme index et meme distance qu en 0110 : un index vectoriel sert une distance PRECISE, en changer ici
-- rendrait les deux recherches incomparables sans qu aucune erreur ne le signale.
create index if not exists aide_fiches_embedding_idx
  on aide_fiches using hnsw (embedding vector_cosine_ops);
```

- [ ] **Étape 2 : écrire le test d'intégration qui échoue**

Dans `tests/integration/aide-fiches.integration.test.ts`, suivre le montage des autres tests
d'intégration du dépôt (ils ouvrent un `Pool` sur le Postgres jetable de la CI) :

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { PgDepotAide } from '../../src/aide/fiches.pg';

/**
 * LA RECHERCHE DANS LE MODE D'EMPLOI.
 *
 * 🔴 Ce qui est vérifié n'est PAS « la requête SQL s'exécute », c'est qu'une question posée avec les mots
 * d'un client trouve la fiche écrite avec les mots du produit, et qu'une question hors sujet n'en trouve
 * aucune. Le second cas est celui qui compte : une recherche qui remonte toujours quelque chose transforme
 * le seuil de pertinence en décoration.
 */
let pool: Pool;
let depot: PgDepotAide;

beforeAll(async () => {
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  depot = new PgDepotAide(pool);
  await pool.query(`insert into aide_fiches (cle, titre, corps, ecran) values
    ('lancer-campagne', 'Lancer une campagne', 'Une campagne envoie un modèle de message approuvé à une liste de contacts. Ouvrez Campagnes, choisissez votre modèle, puis votre audience.', 'campagnes'),
    ('creer-scenario', 'Créer un scénario', 'Un scénario enchaîne des messages et des actions selon ce que répond le contact.', 'workflows')
    on conflict (cle) do nothing`);
});

afterAll(async () => {
  await pool.query(`delete from aide_fiches where cle in ('lancer-campagne', 'creer-scenario')`);
  await pool.end();
});

describe('recherche dans les fiches d’aide', () => {
  it('une question dans les mots du client trouve la fiche', async () => {
    const r = await depot.chercher('comment envoyer un message à toute ma liste', 12);
    expect(r.map((f) => f.cle)).toContain('lancer-campagne');
  });

  it('🔴 une question HORS SUJET ne remonte rien', async () => {
    const r = await depot.chercher('quelle est la capitale de la Bolivie', 12);
    expect(r).toEqual([]);
  });

  it('la fiche porte son écran, pour que la réponse sache où emmener', async () => {
    const r = await depot.chercher('lancer une campagne', 12);
    expect(r.find((f) => f.cle === 'lancer-campagne')?.ecran).toBe('campagnes');
  });

  it('⚠️ une requête vide ne lance AUCUNE requête et rend une liste vide', async () => {
    // `to_tsquery` sur une chaîne vide lèverait. C'est la même garde que `PgKnowledgeStore`.
    expect(await depot.chercher('   ', 12)).toEqual([]);
  });
});
```

- [ ] **Étape 3 : appliquer la migration sur la base de test, vérifier l'échec**

```bash
npm run test:integration -- tests/integration/aide-fiches.integration.test.ts
```

Attendu : ÉCHEC, `src/aide/fiches.pg.ts` n'existe pas.

- [ ] **Étape 4 : écrire `src/aide/fiches.ts` et `src/aide/fiches.pg.ts`**

`fiches.pg.ts` reprend la requête de `PgKnowledgeStore.chercher`
(`src/agent/knowledge.pg.ts`) en retirant `tenant_id` et `agent_id` et en ajoutant `ecran` aux colonnes
rendues. Réutiliser `termesDeRecherche` et `PROXIMITE_TITRE_MIN` exportés de `src/agent/knowledge.ts` plutôt
que de les réécrire : ce sont les points de passage obligés du dépôt.

- [ ] **Étape 5 : lancer le test d'intégration**

```bash
npm run test:integration -- tests/integration/aide-fiches.integration.test.ts
```

Attendu : les quatre tests passent.

- [ ] **Étape 6 : muter**

Retirer le `if (termes.length === 0) return []` : le test de la requête vide doit tomber avec une erreur
Postgres, pas avec une liste vide. Restaurer.

- [ ] **Étape 7 : mettre le compteur de migrations à jour**

Dans `CLAUDE.md`, passer la ligne du compteur à 0131 APRÈS avoir appliqué la migration, pas avant, et la
RELIRE une fois écrite. Cette ligne a déjà dérivé QUATRE fois, la dernière le 2026-09-11 : le moment où elle
se met à jour est l'exécution de `migrate`, et le geste qui manque toujours est la relecture.

- [ ] **Étape 8 : commiter**

---

### Tâche 4 : les fiches vivent dans le dépôt, et se chargent

**Fichiers :**
- Créer : `docs/aide/fiches/lancer-une-campagne.md` (et les suivantes), `db/charger-aide.ts`
- Modifier : `package.json` (`aide:charger`)
- Test : `tests/aide-fiches-format.test.ts`

**Interfaces :**
- Consomme : `PgDepotAide` (tâche 3).
- Produit : le format de fiche, et `chargerFiches(pool): Promise<{ ecrites: number; retirees: number }>`.

Format d'un fichier de fiche :

```markdown
---
ecran: campagnes
source_section: Campagnes
source_empreinte: 8f2a1c
---
# Lancer une campagne

Une campagne envoie un modèle de message approuvé par WhatsApp à une liste de contacts...
```

- [ ] **Étape 1 : écrire le test qui échoue**

Dans `tests/aide-fiches-format.test.ts` :

```ts
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { lireFiche } from '../src/aide/fiches';
import { chargerCarte } from '../src/aide/carte';

/**
 * LE CONTENU DES FICHES D'AIDE, vérifié comme du code.
 *
 * 🔴 CES FICHES SONT LUES PAR DES CLIENTS. Notre documentation interne parle de migrations, de fichiers
 * source et d'incidents datés ; une fiche qui en garde un morceau expose notre cuisine à un client. Ce test
 * est ce qui rend la fuite impossible, plutôt qu'une relecture attentive, qui se relâche.
 */
const DOSSIER = new URL('../docs/aide/fiches/', import.meta.url);
const fichiers = readdirSync(DOSSIER).filter((n) => n.endsWith('.md'));

/** Ce qui trahit une fiche recopiée de notre documentation interne. */
const MARQUEURS_INTERNES = [
  /db\/migrations\//, /\bsrc\//, /\bweb\//, /migration \d{4}/i, /\bvécu le\b/i,
  /\.ts\b/, /\.tsx\b/, /\bcommit\b/i, /\bpooler\b/i, /\bpg-boss\b/i,
];

describe('les fiches d’aide', () => {
  it('il y en a au moins une', () => {
    expect(fichiers.length).toBeGreaterThan(0);
  });

  it('🔴 aucune ne contient de marqueur INTERNE', () => {
    for (const nom of fichiers) {
      const texte = readFileSync(new URL(nom, DOSSIER), 'utf8');
      for (const m of MARQUEURS_INTERNES) {
        expect(m.test(texte), `${nom} contient un marqueur interne (${m})`).toBe(false);
      }
    }
  });

  it('🔴 chaque `ecran` désigne un écran RÉEL de la carte', () => {
    // Une fiche qui pointe vers un écran disparu ferait produire au bot un lien mort, c'est-à-dire
    // exactement la faute que toute cette conception cherche à rendre impossible.
    const cles = new Set(chargerCarte().map((e) => e.cle));
    for (const nom of fichiers) {
      const f = lireFiche(nom, readFileSync(new URL(nom, DOSSIER), 'utf8'));
      if (f.ecran === null) continue;
      expect(cles.has(f.ecran), `${nom} pointe vers l’écran « ${f.ecran} », absent de la carte`).toBe(true);
    }
  });

  it('chaque fiche a un titre et un corps non vides', () => {
    for (const nom of fichiers) {
      const f = lireFiche(nom, readFileSync(new URL(nom, DOSSIER), 'utf8'));
      expect(f.titre.trim(), `${nom} sans titre`).not.toBe('');
      expect(f.corps.trim().length, `${nom} sans corps`).toBeGreaterThan(40);
    }
  });

  it('⚠️ aucun tiret cadratin ni demi-cadratin', () => {
    // Même règle que le reste de la documentation du dépôt : c'est un marqueur « écrit par IA ».
    for (const nom of fichiers) {
      const texte = readFileSync(new URL(nom, DOSSIER), 'utf8');
      expect(/[—–]/.test(texte), `${nom} contient un tiret long`).toBe(false);
    }
  });
});
```

- [ ] **Étape 2 : lancer le test, vérifier qu'il échoue**

```bash
npx vitest run tests/aide-fiches-format.test.ts
```

Attendu : ÉCHEC, le dossier `docs/aide/fiches/` n'existe pas.

- [ ] **Étape 3 : écrire `lireFiche` dans `src/aide/fiches.ts`**

```ts
/** Une fiche telle qu'elle vit dans le dépôt, avant d'être chargée en base. */
export interface FicheFichier {
  cle: string;
  titre: string;
  corps: string;
  ecran: string | null;
  sourceSection: string | null;
  sourceEmpreinte: string | null;
}

/**
 * Lit un fichier de fiche : un en-tête `---` de métadonnées, puis un titre `# ...`, puis le corps.
 *
 * ⚠️ Volontairement primitif, PAS de dépendance de parsing d'en-tête. Le format est le nôtre, il est lu à un
 * seul endroit, et il est tenu par `tests/aide-fiches-format.test.ts`. Ajouter une bibliothèque pour six
 * lignes de découpage serait le genre de dépendance qu'on regrette au premier audit.
 */
export function lireFiche(nomFichier: string, texte: string): FicheFichier {
  const cle = nomFichier.replace(/\.md$/, '');
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(texte);
  const entete = m ? m[1]! : '';
  const corpsBrut = (m ? m[2]! : texte).trim();
  const champ = (nom: string): string | null => {
    const r = new RegExp(`^${nom}:\\s*(.+)$`, 'm').exec(entete);
    const v = r?.[1]?.trim() ?? '';
    return v === '' ? null : v;
  };
  const titreM = /^#\s+(.+)$/m.exec(corpsBrut);
  return {
    cle,
    titre: titreM?.[1]?.trim() ?? '',
    corps: corpsBrut.replace(/^#\s+.+$/m, '').trim(),
    ecran: champ('ecran'),
    sourceSection: champ('source_section'),
    sourceEmpreinte: champ('source_empreinte'),
  };
}
```

- [ ] **Étape 4 : écrire une première fiche à la main**

`docs/aide/fiches/lancer-une-campagne.md`, écrite dans les mots d'un client, sans aucun terme interne. Elle
sert de gabarit aux suivantes et fait passer le test.

- [ ] **Étape 5 : écrire le chargeur `db/charger-aide.ts`**

Il lit tous les `.md` du dossier, fait un `insert ... on conflict (cle) do update`, et SUPPRIME les lignes
dont la clé n'a plus de fichier (une fiche retirée du dépôt doit disparaître de la recherche, sinon le bot
continue de répondre avec une page effacée). Ajouter `"aide:charger": "tsx db/charger-aide.ts"`.

- [ ] **Étape 6 : lancer les tests**

```bash
npx vitest run tests/aide-fiches-format.test.ts && npx tsc --noEmit
```

- [ ] **Étape 7 : muter**

Ajouter `migration 0131` dans le corps de la fiche : le test des marqueurs internes doit tomber en nommant
le fichier. Restaurer. Puis mettre `ecran: nexistepas` : le test de la carte doit tomber. Restaurer.

- [ ] **Étape 8 : commiter**

---

### Tâche 5 : proposer des brouillons de fiches depuis `features.md`

**Fichiers :**
- Créer : `scripts/aide-proposer.mts`
- Modifier : `package.json` (`aide:proposer`)
- Test : `tests/aide-proposer.test.ts`

C'est un outil d'équipe, pas du code de production : il écrit des BROUILLONS dans `docs/aide/fiches/`, qu'on
relit dans le diff de la pull request avant de les garder. Il n'est jamais appelé par le serveur.

**Interfaces :**
- Consomme : `lireFiche` (tâche 4).
- Produit : `decouperFeatures(markdown): Array<{ section: string; corps: string; empreinte: string }>`, exporté
  pour être testé sans appeler de modèle.

- [ ] **Étape 1 : écrire le test qui échoue**

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { decouperFeatures, empreinteDe } from '../scripts/aide-proposer.mts';

/**
 * LE DÉCOUPAGE DE `features.md` EN SECTIONS, et l'empreinte qui dit qu'une section a bougé.
 *
 * 🔴 C'est ce qui permet de DÉTECTER une fiche périmée sans la régénérer en silence. Une régénération
 * automatique remplacerait un texte relu par un texte non relu, ce qui est précisément ce qu'on refuse.
 */
describe('découpage de features.md', () => {
  const md = readFileSync(new URL('../features.md', import.meta.url), 'utf8');

  it('rend au moins dix sections, toutes titrées', () => {
    const s = decouperFeatures(md);
    expect(s.length).toBeGreaterThan(10);
    expect(s.every((x) => x.section.trim() !== '')).toBe(true);
  });

  it('🔴 l’empreinte CHANGE quand le corps change, et pas quand il ne change pas', () => {
    expect(empreinteDe('bonjour')).toBe(empreinteDe('bonjour'));
    expect(empreinteDe('bonjour')).not.toBe(empreinteDe('bonjour '));
  });
});
```

- [ ] **Étape 2 : lancer le test, vérifier qu'il échoue**

```bash
npx vitest run tests/aide-proposer.test.ts
```

- [ ] **Étape 3 : écrire `scripts/aide-proposer.mts`**

`decouperFeatures` découpe sur les titres `##`, `empreinteDe` rend les six premiers caractères d'un SHA-256
du corps. Le reste du script appelle le modèle (`AI_GATEWAY_API_KEY` et `AGENT_AIDE_MODEL`) avec la consigne
de réécrire chaque section POUR UN CLIENT, en français, sans aucun terme interne, et écrit un fichier par
fiche proposée.

- [ ] **Étape 4 : lancer le test**

```bash
npx vitest run tests/aide-proposer.test.ts && npx tsc --noEmit
```

- [ ] **Étape 5 : lancer le script pour de vrai et relire**

```bash
npm run aide:proposer
git diff --stat docs/aide/fiches/
```

Relire CHAQUE fiche proposée, en jeter, en réécrire. `npx vitest run tests/aide-fiches-format.test.ts` doit
passer avant de garder quoi que ce soit.

- [ ] **Étape 6 : commiter**

---

### Tâche 6 : le moteur et la route

**Fichiers :**
- Créer : `src/aide/repondre.ts`, `src/http/aide.ts`
- Modifier : `src/config.ts` (`AGENT_AIDE_MODEL`), `src/index.ts` (montage de la route)
- Test : `tests/aide-repondre.test.ts`, `tests/http-aide.test.ts`

**Interfaces :**
- Consomme : `DepotAide` (tâche 3), `resoudre` et `carteVisiblePar` (tâche 2),
  `creerRechercheSemantique()` (`src/agent/recherche.ts`).
- Produit :
  ```ts
  export interface ReponseAide { sait: boolean; texte: string; sources: string[]; ecrans: EcranAide[] }
  export function creerRepondeur(deps: DepsAide): (q: QuestionAide) => Promise<ReponseAide>
  ```

- [ ] **Étape 1 : écrire le test qui échoue**

```ts
import { describe, it, expect, vi } from 'vitest';
import { creerRepondeur } from '../src/aide/repondre';

/**
 * LE MOTEUR DE L'AIDE.
 *
 * 🔴 LES DEUX CHOSES QUI COMPTENT, et aucune n'est « il répond bien » : quand aucune fiche n'est pertinente
 * il DIT qu'il ne sait pas au lieu d'inventer, et une clé d'écran qu'il n'aurait pas dû rendre ne produit
 * aucun lien. Le reste est de la formulation, qui n'est pas testable et n'a pas à l'être.
 */
const fiches = [{ id: '1', cle: 'lancer-campagne', titre: 'Lancer une campagne', corps: 'Ouvrez Campagnes...', ecran: 'campagnes', couverture: 0.8, proximiteTitre: 0.5 }];

function deps(over = {}) {
  return {
    depot: { chercher: async () => fiches },
    recherche: null,
    completer: async () => ({ texte: 'Ouvrez Campagnes.', cles: ['campagnes'] }),
    modele: 'test/modele',
    ...over,
  };
}

describe('répondeur d’aide', () => {
  it('🔴 aucune fiche pertinente -> il DIT qu’il ne sait pas, il n’appelle même pas le modèle', async () => {
    // Appeler le modèle sans source, c'est lui demander d'inventer. Et ça coûte, pour un résultat qu'on
    // refuserait de toute façon.
    const completer = vi.fn();
    const repondre = creerRepondeur(deps({ depot: { chercher: async () => [] }, completer }));
    const r = await repondre({ question: 'la capitale de la Bolivie', role: 'admin', langue: 'fr', ecranCourant: null });
    expect(r.sait).toBe(false);
    expect(r.ecrans).toEqual([]);
    expect(completer).not.toHaveBeenCalled();
  });

  it('une fiche pertinente -> réponse, source citée, et le lien vers l’écran', async () => {
    const repondre = creerRepondeur(deps());
    const r = await repondre({ question: 'comment lancer une campagne', role: 'admin', langue: 'fr', ecranCourant: null });
    expect(r.sait).toBe(true);
    expect(r.sources).toContain('Lancer une campagne');
    expect(r.ecrans.map((e) => e.cle)).toEqual(['campagnes']);
  });

  it('🔴 une clé d’écran INVENTÉE par le modèle ne produit aucun lien', async () => {
    const repondre = creerRepondeur(deps({ completer: async () => ({ texte: 'Allez-y.', cles: ['ecran-imaginaire'] }) }));
    const r = await repondre({ question: 'comment lancer une campagne', role: 'admin', langue: 'fr', ecranCourant: null });
    expect(r.ecrans).toEqual([]);
    // Et le texte part quand même : une réponse sans lien vaut mieux que pas de réponse.
    expect(r.texte).not.toBe('');
  });

  it('🔴 un AGENT ne reçoit pas de lien vers un écran d’administrateur', async () => {
    const repondre = creerRepondeur(deps({ completer: async () => ({ texte: 'x', cles: ['admin'] }) }));
    expect((await repondre({ question: 'q', role: 'agent', langue: 'fr', ecranCourant: null })).ecrans).toEqual([]);
  });

  it('⚠️ les fiches sont données au modèle dans un BLOC DÉLIMITÉ, jamais concaténées à la consigne', async () => {
    // Règle du CLAUDE.md global. Ici le contenu vient de notre dépôt, donc le risque est faible, mais la
    // forme doit être la bonne dès maintenant : la seconde spec fera passer par ce même moteur des textes
    // écrits par des inconnus.
    const completer = vi.fn().mockResolvedValue({ texte: 'x', cles: [] });
    const repondre = creerRepondeur(deps({ completer }));
    await repondre({ question: 'q', role: 'admin', langue: 'fr', ecranCourant: null });
    const messages = completer.mock.calls[0][0].messages;
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).not.toContain('Ouvrez Campagnes...');
  });
});
```

- [ ] **Étape 2 : lancer le test, vérifier qu'il échoue**

```bash
npx vitest run tests/aide-repondre.test.ts
```

- [ ] **Étape 3 : écrire `src/aide/repondre.ts`**

Enchaînement : rappel lexical (`depot.chercher`) fusionné avec le rappel vectoriel si `recherche` est
branchée, jusqu'à `AGENT_RAPPEL_CANDIDATS` ; reclassement par `recherche.reclasser`, on garde ce qui est
au-dessus de `AGENT_RERANK_SEUIL` ; aucune fiche retenue implique `{ sait: false }` SANS appeler le modèle ;
sinon un message système qui porte la consigne et la liste FERMÉE des clés autorisées, un message de données
qui porte les fiches entre délimiteurs, et la question ; enfin `resoudre(cles, role)` sur ce que le modèle
rend.

- [ ] **Étape 4 : lancer le test**

```bash
npx vitest run tests/aide-repondre.test.ts
```

- [ ] **Étape 5 : écrire la route `src/http/aide.ts` et son test**

`POST /tenants/:tenantId/aide`, avec `scopeTenant`, la garde d'authentification, et le plafond COÛTEUX
(`RATE_LIMIT_COUTEUX_PAR_MINUTE`, clé = espace). Corps validé par `safeParse` : `question` (1 à 500
caractères), `ecranCourant` (facultatif). Dépendances absentes (`AI_GATEWAY_API_KEY` vide) implique 503 avec
un message clair, jamais un repli silencieux. Le test de route couvre : 400 sur question vide, 400 sur
question trop longue, 403 si l'authentification manque, 200 avec la réponse, 503 sans modèle.

- [ ] **Étape 6 : ajouter `AGENT_AIDE_MODEL` à `src/config.ts`**

Sur le modèle exact de `AGENT_SETUP_MODEL`, exigé dès que `AI_GATEWAY_API_KEY` est renseignée, avec le
commentaire qui dit POURQUOI il est distinct : ce modèle répond à un client qui attend devant son écran,
pas à un contact dans une conversation, et il n'a aucun outil à appeler.

- [ ] **Étape 7 : muter**

Retirer le `if (retenues.length === 0) return { sait: false, ... }` : le premier test doit tomber, ET sur
l'appel du modèle, pas seulement sur `sait`. Puis remplacer `resoudre(cles, role)` par `resoudre(cles, 'admin')` :
le test de l'agent doit tomber. Restaurer les deux.

- [ ] **Étape 8 : commiter**

---

### Tâche 7 : le bouton flottant

**Fichiers :**
- Créer : `web/components/BoutonAide.tsx`, `web/lib/api-aide.ts`
- Modifier : `web/components/AppShell.tsx` (poser le bouton une fois)
- Test : `web/e2e/aide-console.spec.ts`

**Interfaces :**
- Consomme : `POST /tenants/:tenantId/aide` (tâche 6), `arbresNav` pour la clé de l'écran courant (tâche 1).

- [ ] **Étape 1 : écrire l'e2e qui échoue**

Un test Playwright qui simule la route `**/api/backend/**` (comme `web/e2e/workflow-quick-lien.spec.ts`),
ouvre `/campaigns`, clique le bouton d'aide, tape une question, et vérifie trois choses : la réponse
s'affiche, le lien proposé pointe vers `/campaigns`, et quand le serveur rend `sait: false` le panneau
propose le recours vers `/support`.

- [ ] **Étape 2 : lancer l'e2e, vérifier qu'il échoue**

```bash
cd web && npx playwright test e2e/aide-console.spec.ts --reporter=line
```

- [ ] **Étape 3 : écrire `BoutonAide.tsx` et `api-aide.ts`**

Bouton fixe en bas à droite, panneau qui s'ouvre au clic, historique local à la session, et la clé de
l'écran courant passée à chaque question. Quand `sait` est faux, afficher le recours `/support` plutôt qu'un
message d'échec sec.

- [ ] **Étape 4 : poser le bouton UNE FOIS dans `AppShell`**

Juste avant la fermeture du conteneur de contenu, donc sur les 36 écrans authentifiés et sur aucun des 8
écrans de connexion.

- [ ] **Étape 5 : lancer l'e2e**

```bash
cd web && npx playwright test e2e/aide-console.spec.ts --reporter=line
```

- [ ] **Étape 6 : muter**

Retirer le passage de l'écran courant : l'assertion du lien contextuel doit tomber. Restaurer.

- [ ] **Étape 7 : lancer la suite entière et les deux typechecks**

```bash
npx vitest run tests/ && npx tsc --noEmit && (cd web && npx tsc --noEmit && npx next lint --max-warnings 0)
```

- [ ] **Étape 8 : commiter, pousser, lire la CI job par job, puis déployer**

Séquence de déploiement pour ce lot, la migration 0131 AJOUTANT une table que le code écrit :

```bash
ssh -i ~/.ssh/id_ed25519 ubuntu@146.59.233.252 "cd /home/ubuntu/mba && git pull && sudo docker compose build mba-api && sudo docker compose run --rm --no-deps mba-api npm run migrate && sudo docker compose run --rm --no-deps mba-api npm run aide:charger && sudo docker compose up -d --build"
```

Puis `nginx -s reload`, le contrôle interne contre public, et `node scripts/fumee.mjs`.

---

## Auto-relecture du plan

**Couverture de la spec.** Les deux connaissances : tâches 1-2 (la carte) et 3-5 (les fiches). La garde
anti-hallucination : tâche 2 (`resoudre`) et tâche 6 (test de la clé inventée). La table séparée : tâche 3.
Le widget dans `AppShell` : tâche 7. La route synchrone et son plafond : tâche 6. Le recours `/support` :
tâches 6 et 7. Le coût sur notre clé : tâche 6 (`AGENT_AIDE_MODEL` sur `AI_GATEWAY_API_KEY`). Les six tests
annoncés par la spec sont répartis : carte contre routes (tâche 1), rôle respecté (tâche 2), clé inventée
(tâches 2 et 6), marqueurs internes (tâche 4), dérive de la doc (tâche 5), isolation (tâche 3, la table n'a
pas de `tenant_id`).

**Écart assumé et signalé** : `statut` et l'écran de relecture disparaissent au profit des fichiers
versionnés. La tâche 3 met la spec à jour dans la même livraison.

**Ce qui reste ouvert exprès** : la langue. Les fiches sont en français et le rappel lexical est un
`tsvector` français, donc une question posée en anglais ne sera servie que par le rappel sémantique. À
MESURER une fois quelques fiches chargées, avant de décider d'en écrire en anglais.
