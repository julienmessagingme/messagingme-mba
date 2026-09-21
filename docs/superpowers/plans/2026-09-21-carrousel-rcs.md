# Carrousels RCS : plan d'exécution

> **Pour l'exécutant :** ce plan s'exécute EN DIRECT, tâche par tâche, cases à cocher (`- [ ]`). Chaque tâche
> se termine sur un livrable testable et un commit `--only`.

**Objectif :** composer un carrousel RCS dans Contenu > Messages RCS (écran refait sur le dessin de Contenu >
Templates), et pouvoir le choisir dans l'assistant de campagne.

**Architecture :** tout est côté ÉCRAN. Le serveur porte déjà le carrousel (schéma, traduction smsmode,
variables, liens tracés). La logique vit dans des modules PURS (`web/lib/rcs-carrousel.ts`, `web/lib/rcs.ts`,
`web/lib/campagne-*.ts`) testés en unitaire, et les écrans sont tenus par des e2e qui lisent le corps
réellement posté.

**Pile :** Next 15 / React 19 / Tailwind (écrans), vitest (suite racine et suite du front), Playwright (e2e).

**Spec :** [docs/superpowers/specs/2026-09-21-carrousel-rcs-design.md](../specs/2026-09-21-carrousel-rcs-design.md)

## Contraintes globales

- Aucune ligne dans `src/`, aucune migration : si une tâche semble en demander une, s'arrêter et le dire.
- Pas de tiret cadratin ni demi-cadratin dans le code, les commentaires, les textes d'écran et les docs.
- Commits : `git commit --only <chemins>`, liste construite depuis CE QU'ON A TOUCHÉ, jamais depuis
  `git status` (une autre session travaille dans le même dossier). Un fichier NEUF se `git add` d'abord.
- `data-testid` existants de `rcs-messages.spec.ts` : inchangés. Ses cas passent SANS être réécrits.
- Bornes : 2 à 10 cartes, titre 200, texte d'une carte 2 000, 4 boutons par carte, visuel en `TALL`.
- Textes d'écran bilingues par `t(fr, en)` ; dans un module pur, paires `[fr, en]`.
- Commandes de test :
  - suite racine : `npx vitest run tests/<fichier>` (depuis la racine) ;
  - suite du front : `cd web && npx vitest run lib/<fichier>` ;
  - e2e : `cd web && npx playwright test e2e/<fichier>` (le serveur Next est construit par la config) ;
  - types : `cd web && npx tsc --noEmit`, et `npm run typecheck` à la racine (il compile `tests/`, qui
    importe `web/lib`).

## Méthode de livraison

**En direct, par moi, en deux lots successifs**, parce que :

- rien ne change côté serveur ni en base : un redéploiement Vercel suffit à revenir en arrière ;
- les critères se testent mécaniquement : fonctions pures en unitaire, et e2e qui lisent le corps RÉELLEMENT
  posté (`rcs-messages.spec.ts` inchangé prouve que le nouveau dessin ne change rien à ce qui part) ;
- le seul chemin sensible est la création de campagne, et il est tenu par les tests du corps de création,
  le serveur revalidant tout à l'arrivée.

Chaque lot se ferme par : les trois suites vertes en local, `/revue` avec sa section « rayon de souffle », le
push, puis la CI lue job par job (`gh run view <id> --json jobs`, jamais le code de sortie de `gh run watch`).
Le lot 1 se ferme AUSSI sur des captures des deux écrans côte à côte (Templates et Messages RCS), montrées à
Julien AVANT le push : « la même gueule » se regarde, aucun test ne la prouve.

**L'essai réel qui clôt la feature**, par Julien sur son téléphone : composer un carrousel de 3 cartes
(visuels, un bouton Réponse, un bouton Lien), l'envoyer depuis le panneau RCS de l'Inbox à son numéro, vérifier
le rendu, taper le lien (clic compté) et la réponse (elle arrive dans l'Inbox), puis lancer une campagne RCS
vers lui-même avec ce carrousel. C'est aussi le premier carrousel réellement accepté (ou refusé) par smsmode.

---

# LOT 1 : l'écran Contenu > Messages RCS

### Tâche 1 : la logique pure du carrousel et des manques

**Fichiers :**
- Créer : `web/lib/rcs-carrousel.ts`
- Modifier : `web/lib/rcs.ts` (trois fonctions ajoutées à la fin, un import)
- Test : `tests/web-rcs-carrousel.test.ts` (suite RACINE, pour valider contre `rcsOutboundSchema`)

**Interfaces produites :**
- `type CarrouselRcs = Extract<RcsOutbound, { kind: 'carousel' }>`
- `interface CarteBrouillon { title: string; text: string; imageUrl: string; suggestions: RcsSuggestion[] }`
- `interface BrouillonCarrouselRcs { cartes: CarteBrouillon[] }`
- `MIN_CARTES = 2`, `MAX_CARTES = 10`, `MAX_TITRE_CARTE = 200`, `MAX_TEXTE_CARTE = 2000`
- `carteVide(): CarteBrouillon`, `carrouselVide(): BrouillonCarrouselRcs`
- `versCarrouselRcs(b): CarrouselRcs`, `versBrouillonCarrousel(content: RcsOutbound | null): BrouillonCarrouselRcs | null`
- `manquesCarrousel(nom: string, b): Array<[string, string]>`
- `carrouselDepuis(v: unknown): CarrouselRcs | null`
- dans `web/lib/rcs.ts` : `manquesMessageRcs(nom: string, b: BrouillonRcs): Array<[string, string]>`,
  `libelleFormatRcs(content: RcsOutbound | null): [string, string]`, `extraitRcs(content: RcsOutbound | null): string`

- [ ] **Étape 1 : écrire le test qui échoue** : `tests/web-rcs-carrousel.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import {
  versCarrouselRcs, versBrouillonCarrousel, manquesCarrousel, carrouselDepuis, carrouselVide,
  type BrouillonCarrouselRcs,
} from '../web/lib/rcs-carrousel';
import { manquesMessageRcs, libelleFormatRcs, extraitRcs } from '../web/lib/rcs';
import { rcsOutboundSchema } from '../src/rcs/schema';

/**
 * Le carrousel de l'ecran, verifie contre le schema SERVEUR.
 *
 * C'est le point de ce fichier, comme de `web-rcs-brouillon.test.ts` : ce que l'ecran fabrique doit passer la
 * validation de la route, sinon l'operateur decouvre son erreur en 400 au moment d'enregistrer. Les deux
 * vivent dans des tsconfig differents et ne partagent aucun paquet ; seul un test peut tenir l'invariant.
 */
const IMG = 'https://exemple.test/v.jpg';

function deuxCartes(): BrouillonCarrouselRcs {
  return {
    cartes: [
      { title: 'Séjour à Nice', text: 'Dès 99 €', imageUrl: IMG, suggestions: [{ kind: 'reply', text: 'Je veux', postbackData: '' }] },
      { title: '', text: 'Séjour à Lyon', imageUrl: IMG, suggestions: [{ kind: 'openUrl', text: 'Voir', url: 'https://exemple.test/lyon', postbackData: '' }] },
    ],
  };
}

describe('carrousel RCS (ecran) vers message envoyable', () => {
  it('produit un carrousel que la route accepte, visuels en TALL', () => {
    const msg = versCarrouselRcs(deuxCartes());
    expect(rcsOutboundSchema.safeParse(msg).success).toBe(true);
    expect(msg).toEqual({
      kind: 'carousel',
      cards: [
        {
          title: 'Séjour à Nice', description: 'Dès 99 €', mediaUrl: IMG, mediaHeight: 'TALL',
          suggestions: [{ kind: 'reply', text: 'Je veux', postbackData: 'carte1_btn1' }],
        },
        {
          description: 'Séjour à Lyon', mediaUrl: IMG, mediaHeight: 'TALL',
          suggestions: [{ kind: 'openUrl', text: 'Voir', url: 'https://exemple.test/lyon', postbackData: 'carte2_btn1' }],
        },
      ],
    });
  });

  it('ecarte un bouton sans libelle et garde un postbackData deja pose', () => {
    const b = deuxCartes();
    b.cartes[0]!.suggestions = [
      { kind: 'reply', text: '   ', postbackData: '' },
      { kind: 'reply', text: 'Oui', postbackData: 'deja_la' },
    ];
    const msg = versCarrouselRcs(b);
    expect(msg.cards[0]!.suggestions).toEqual([{ kind: 'reply', text: 'Oui', postbackData: 'deja_la' }]);
  });

  it('une carte a titre seul, sans visuel, part sans media', () => {
    const msg = versCarrouselRcs({ cartes: [{ title: 'A', text: '', imageUrl: '', suggestions: [] }, { title: 'B', text: '', imageUrl: '', suggestions: [] }] });
    expect(msg.cards).toEqual([{ title: 'A' }, { title: 'B' }]);
    expect(rcsOutboundSchema.safeParse(msg).success).toBe(true);
  });

  it('relit un carrousel stocke, et le reecrit a l identique', () => {
    const msg = versCarrouselRcs(deuxCartes());
    const relu = versBrouillonCarrousel(msg);
    expect(relu).not.toBeNull();
    expect(versCarrouselRcs(relu!)).toEqual(msg);
  });

  it('ne relit comme carrousel que ce qui en est un', () => {
    expect(versBrouillonCarrousel({ kind: 'text', text: 'x' })).toBeNull();
    expect(versBrouillonCarrousel(null)).toBeNull();
  });
});

describe('ce qui manque a un carrousel', () => {
  it('un carrousel neuf manque de nom, et d un visuel ou d un titre sur chaque carte', () => {
    expect(manquesCarrousel('', carrouselVide()).map(([fr]) => fr)).toEqual([
      'le nom du carrousel',
      'le visuel ou le titre de la carte 1',
      'le visuel ou le titre de la carte 2',
    ]);
  });

  it('un carrousel rempli ne manque de rien', () => {
    expect(manquesCarrousel('Rentrée', deuxCartes())).toEqual([]);
  });

  it('un bouton de lien sans adresse est nomme, carte comprise', () => {
    const b = deuxCartes();
    b.cartes[1]!.suggestions = [{ kind: 'openUrl', text: 'Voir', url: '', postbackData: '' }];
    expect(manquesCarrousel('x', b).map(([fr]) => fr)).toEqual(['un bouton complet sur la carte 2 (libellé, lien, numéro ou dates)']);
  });

  it('un texte de plus de 2000 caracteres est nomme', () => {
    const b = deuxCartes();
    b.cartes[0]!.text = 'a'.repeat(2001);
    expect(manquesCarrousel('x', b).map(([fr]) => fr)).toEqual(['un texte plus court sur la carte 1 (2000 caractères au plus)']);
  });

  it('une seule carte ne suffit pas', () => {
    expect(manquesCarrousel('x', { cartes: [deuxCartes().cartes[0]!] }).map(([fr]) => fr)).toEqual(['au moins deux cartes']);
  });
});

describe('relecture stricte d un carrousel venu d un brouillon', () => {
  const valide = versCarrouselRcs(deuxCartes());
  const carte = valide.cards[0]!;

  it('accepte ce que la route accepte', () => {
    expect(rcsOutboundSchema.safeParse(valide).success).toBe(true);
    expect(carrouselDepuis(JSON.parse(JSON.stringify(valide)))).toEqual(valide);
  });

  const casses: Array<[string, unknown]> = [
    ['une seule carte', { kind: 'carousel', cards: [carte] }],
    ['onze cartes', { kind: 'carousel', cards: Array.from({ length: 11 }, () => carte) }],
    ['un bouton de type inconnu', { kind: 'carousel', cards: [{ ...carte, suggestions: [{ kind: 'danse', text: 'x', postbackData: 'p' }] }, carte] }],
    ['un lien sans adresse', { kind: 'carousel', cards: [{ ...carte, suggestions: [{ kind: 'openUrl', text: 'x', url: '', postbackData: 'p' }] }, carte] }],
    ['une carte sans titre ni visuel', { kind: 'carousel', cards: [{ description: 'x' }, carte] }],
    ['cinq boutons sur une carte', { kind: 'carousel', cards: [{ ...carte, suggestions: Array.from({ length: 5 }, () => ({ kind: 'reply', text: 'x', postbackData: 'p' })) }, carte] }],
    ['un titre vide', { kind: 'carousel', cards: [{ ...carte, title: '' }, carte] }],
    ['une date d agenda qui n en est pas une', { kind: 'carousel', cards: [{ ...carte, suggestions: [{ kind: 'calendar', text: 'x', postbackData: 'p', title: 'RDV', startAt: 'demain', endAt: 'demain' }] }, carte] }],
    ['pas un carrousel', { kind: 'text', text: 'x' }],
    ['rien', null],
  ];
  for (const [nom, valeur] of casses) {
    it(`rejette ${nom}, comme la route`, () => {
      expect(carrouselDepuis(valeur)).toBeNull();
      const accepteCommeCarrousel = rcsOutboundSchema.safeParse(valeur).success
        && (valeur as { kind?: unknown } | null)?.kind === 'carousel';
      expect(accepteCommeCarrousel).toBe(false);
    });
  }

  // ⚠️ L'ECART CONNU, ECRIT PLUTOT QUE CACHE : la relecture verifie la FORME, pas le format d'une adresse.
  // Le serveur reste l'autorite et refuse en 400 a la creation, comme pour tout ce que l'assistant envoie.
  it('une adresse mal formee passe la relecture, et la route la refuse', () => {
    const x = { kind: 'carousel', cards: [{ ...carte, mediaUrl: 'pas-une-adresse' }, carte] };
    expect(carrouselDepuis(x)).not.toBeNull();
    expect(rcsOutboundSchema.safeParse(x).success).toBe(false);
  });
});

describe('le message simple dit ce qui lui manque', () => {
  it('nomme chacune des quatre conditions qui grisaient le bouton', () => {
    expect(manquesMessageRcs('', { text: '', imageUrl: '', suggestions: [] }).map(([fr]) => fr))
      .toEqual(['le nom du message', 'le texte du message']);
    expect(manquesMessageRcs('x', { text: 'a'.repeat(2001), imageUrl: IMG, suggestions: [] }).map(([fr]) => fr))
      .toEqual(['un texte plus court (2000 caractères au plus)']);
    // Le même texte SANS visuel tient dans les 3 072 d'un message texte.
    expect(manquesMessageRcs('x', { text: 'a'.repeat(2001), imageUrl: '', suggestions: [] })).toEqual([]);
    expect(manquesMessageRcs('x', { text: 'y', imageUrl: '', suggestions: [{ kind: 'openUrl', text: 'Voir', url: '', postbackData: '' }] }).map(([fr]) => fr))
      .toEqual(['un bouton complet (libellé, lien, numéro ou dates)']);
  });
});

describe('le tableau de la bibliotheque', () => {
  it('dit le format et le debut du texte, carrousel compris', () => {
    const carrousel = versCarrouselRcs(deuxCartes());
    expect(libelleFormatRcs({ kind: 'text', text: 'Bonjour' })).toEqual(['message', 'message']);
    expect(libelleFormatRcs({ kind: 'card', card: { mediaUrl: IMG } })).toEqual(['carte', 'card']);
    expect(libelleFormatRcs(carrousel)).toEqual(['carrousel · 2 cartes', 'carousel · 2 cards']);
    expect(libelleFormatRcs(null)).toEqual(['illisible', 'unreadable']);
    expect(extraitRcs(carrousel)).toBe('Dès 99 €');
    expect(extraitRcs({ kind: 'text', text: 'Bonjour' })).toBe('Bonjour');
    expect(extraitRcs(null)).toBe('');
  });
});
```

- [ ] **Étape 2 : vérifier qu'il échoue**

Run: `npx vitest run tests/web-rcs-carrousel.test.ts`
Attendu : ÉCHEC, « Failed to resolve import "../web/lib/rcs-carrousel" ».

- [ ] **Étape 3 : écrire `web/lib/rcs-carrousel.ts`**

```ts
import type { RcsCard, RcsOutbound, RcsSuggestion } from './rcs-types';
import { boutonPret } from './rcs-boutons';
import { MAX_BOUTONS_CARTE, MAX_TEXTE_RCS_AVEC_IMAGE } from './rcs';

/**
 * LE CARROUSEL RCS, CÔTÉ ÉCRAN : sa forme d'édition, sa traduction en message envoyable, ce qui lui manque,
 * et la relecture stricte d'une copie venue d'un JSON que rien n'a validé.
 *
 * Module PUR (aucun import navigateur) : il est testé depuis la suite RACINE contre le schéma SERVEUR
 * (`tests/web-rcs-carrousel.test.ts`), comme `web/lib/rcs.ts`. Ce que l'écran fabrique doit passer la
 * validation de la route, et seul un test peut tenir cet invariant entre deux tsconfig.
 *
 * ⚠️ LE SERVEUR N'A PAS BOUGÉ POUR CE FORMAT : `rcsOutboundSchema` et la traduction smsmode portent le
 * carrousel depuis le premier lot RCS. Seul l'écran manquait (spec `2026-09-21-carrousel-rcs-design.md`).
 */

export type CarrouselRcs = Extract<RcsOutbound, { kind: 'carousel' }>;

/** Une carte, telle qu'on l'édite. Mêmes noms que `BrouillonRcs`, pour qu'on les lise de la même façon. */
export interface CarteBrouillon {
  title: string;
  text: string;
  imageUrl: string;
  suggestions: RcsSuggestion[];
}

export interface BrouillonCarrouselRcs {
  cartes: CarteBrouillon[];
}

/** Les bornes du schéma serveur. smsmode accepte 11 cartes, le serveur s'arrête à 10 : c'est lui qui tranche. */
export const MIN_CARTES = 2;
export const MAX_CARTES = 10;
export const MAX_TITRE_CARTE = 200;
/** La borne du champ `description` d'une carte chez le fournisseur, avec ou sans visuel. */
export const MAX_TEXTE_CARTE = MAX_TEXTE_RCS_AVEC_IMAGE;

export function carteVide(): CarteBrouillon {
  return { title: '', text: '', imageUrl: '', suggestions: [] };
}

/** Un carrousel neuf : deux cartes, le minimum du format. */
export function carrouselVide(): BrouillonCarrouselRcs {
  return { cartes: [carteVide(), carteVide()] };
}

/**
 * Brouillon -> message envoyable.
 *
 * 🔴 LE VISUEL PART EN `TALL` (16:9), comme celui d'une carte simple (`versMessageRcs`) et pour la même
 * raison : le défaut du fournisseur (`MEDIUM`, 2:1) rogne le visuel. La largeur des cartes n'est PAS
 * envoyée : smsmode prend alors `MEDIUM`, la largeur qui autorise `TALL` chez Google.
 *
 * Les boutons sans libellé sont écartés, et un `postbackData` vide est dérivé (`carte<i>_btn<j>`), même règle
 * que `versMessageRcs`. Il n'a aujourd'hui aucun rôle de routage : un carrousel n'entre pas encore dans un
 * scénario, et `normaliserPostbacks` le laisse tel quel.
 */
export function versCarrouselRcs(b: BrouillonCarrouselRcs): CarrouselRcs {
  return {
    kind: 'carousel',
    cards: b.cartes.map((c, i): RcsCard => {
      const suggestions = c.suggestions
        .filter((s) => s.text.trim() !== '')
        .map((s, j) => ({ ...s, text: s.text.trim(), postbackData: s.postbackData.trim() || `carte${i + 1}_btn${j + 1}` }));
      const titre = c.title.trim();
      const texte = c.text.trim();
      const image = c.imageUrl.trim();
      return {
        ...(titre !== '' ? { title: titre } : {}),
        ...(texte !== '' ? { description: texte } : {}),
        ...(image !== '' ? { mediaUrl: image, mediaHeight: 'TALL' as const } : {}),
        ...(suggestions.length > 0 ? { suggestions } : {}),
      };
    }),
  };
}

/** Message stocké -> brouillon. `null` = ce n'est pas un carrousel. */
export function versBrouillonCarrousel(content: RcsOutbound | null): BrouillonCarrouselRcs | null {
  if (!content || content.kind !== 'carousel') return null;
  return {
    cartes: content.cards.map((c) => ({
      title: c.title ?? '',
      text: c.description ?? '',
      imageUrl: c.mediaUrl ?? '',
      suggestions: c.suggestions ?? [],
    })),
  };
}

/**
 * CE QUI MANQUE POUR ENREGISTRER UN CARROUSEL, en paires `[fr, en]`, la carte fautive désignée par son rang.
 *
 * 🔴 LE BOUTON « CRÉER LE CARROUSEL » EST GRISÉ SI ET SEULEMENT SI CETTE LISTE N'EST PAS VIDE. Un défaut peut
 * vivre dans la carte 7 d'un carrousel qui en porte dix : un bouton grisé sans explication ferait relire les
 * dix cartes une à une (c'est pour ça que `CarouselForm` nomme déjà les siens).
 *
 * ⚠️ « UN VISUEL OU UN TITRE » EST LA RÈGLE DU FOURNISSEUR (« must contain media or title »), déjà tenue par
 * `rcsCardSchema` côté serveur. La tenir ici évite de la découvrir en 400 à l'enregistrement.
 *
 * Paires `[fr, en]` parce que ce module est pur : `useT()` y est inappelable (convention de `LIBELLE_KIND`).
 */
export function manquesCarrousel(nom: string, b: BrouillonCarrouselRcs): Array<[string, string]> {
  const manques: Array<[string, string]> = [];
  if (nom.trim() === '') manques.push(['le nom du carrousel', 'the carousel name']);
  if (b.cartes.length < MIN_CARTES) manques.push(['au moins deux cartes', 'at least two cards']);
  if (b.cartes.length > MAX_CARTES) manques.push(['dix cartes au plus', 'ten cards at most']);
  b.cartes.forEach((c, i) => {
    const n = i + 1;
    if (c.imageUrl.trim() === '' && c.title.trim() === '') {
      manques.push([`le visuel ou le titre de la carte ${n}`, `the image or the title of card ${n}`]);
    }
    if (c.title.trim().length > MAX_TITRE_CARTE) {
      manques.push([
        `un titre plus court sur la carte ${n} (${MAX_TITRE_CARTE} caractères au plus)`,
        `a shorter title on card ${n} (${MAX_TITRE_CARTE} characters max)`,
      ]);
    }
    // Longueur BRUTE, comme le compteur que l'opérateur voit sous le champ (`ChampCorpsVariables`).
    if (c.text.length > MAX_TEXTE_CARTE) {
      manques.push([
        `un texte plus court sur la carte ${n} (${MAX_TEXTE_CARTE} caractères au plus)`,
        `a shorter text on card ${n} (${MAX_TEXTE_CARTE} characters max)`,
      ]);
    }
    if (c.suggestions.length > MAX_BOUTONS_CARTE) {
      manques.push([`${MAX_BOUTONS_CARTE} boutons au plus sur la carte ${n}`, `${MAX_BOUTONS_CARTE} buttons at most on card ${n}`]);
    }
    if (!c.suggestions.every(boutonPret)) {
      manques.push([
        `un bouton complet sur la carte ${n} (libellé, lien, numéro ou dates)`,
        `a complete button on card ${n} (label, link, number or dates)`,
      ]);
    }
  });
  return manques;
}

// --- Relecture STRICTE d'un carrousel venu d'un JSON non validé (le brouillon d'une campagne) ---

/**
 * Le motif de date d'un bouton Agenda, RECOPIÉ de `DATE_BOUTON_RE` (`src/rcs/schema.ts`) : l'écran ne peut
 * pas importer le serveur. La parité est tenue par `tests/web-rcs-carrousel.test.ts`, qui juge les mêmes
 * valeurs avec les deux.
 */
const DATE_BOUTON_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;
const VARIABLE_RE = /\{\{\s*[\w.-]+\s*\}\}/;

function objet(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
/** Une chaîne de 1 à `max` caractères : le `z.string().min(1).max(max)` du serveur. */
function requise(v: unknown, max: number): v is string {
  return typeof v === 'string' && v.length >= 1 && v.length <= max;
}
/** Une chaîne d'au plus `max` caractères, vide comprise. */
function bornee(v: unknown, max: number): v is string {
  return typeof v === 'string' && v.length <= max;
}
function dateBouton(v: unknown): v is string {
  return typeof v === 'string' && v.length >= 1 && (DATE_BOUTON_RE.test(v) || VARIABLE_RE.test(v));
}
function coordonnee(v: unknown, limite: number): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= -limite && v <= limite;
}
function estHauteur(v: unknown): v is NonNullable<RcsCard['mediaHeight']> {
  return v === 'SHORT' || v === 'MEDIUM' || v === 'TALL';
}
const SANS_BORNE = Number.MAX_SAFE_INTEGER;

function boutonDepuis(v: unknown): RcsSuggestion | null {
  const o = objet(v);
  if (!o) return null;
  const { kind, text, postbackData } = o;
  if (!requise(text, 25) || !requise(postbackData, SANS_BORNE)) return null;
  const base = { text, postbackData };
  switch (kind) {
    case 'reply':
      return { ...base, kind: 'reply' };
    case 'requestLocation':
      return { ...base, kind: 'requestLocation' };
    case 'openUrl': {
      const { url } = o;
      return requise(url, SANS_BORNE) ? { ...base, kind: 'openUrl', url } : null;
    }
    case 'dial': {
      const { phoneNumber } = o;
      return requise(phoneNumber, SANS_BORNE) ? { ...base, kind: 'dial', phoneNumber } : null;
    }
    case 'calendar': {
      const { title, description, startAt, endAt } = o;
      if (!requise(title, 100) || !dateBouton(startAt) || !dateBouton(endAt)) return null;
      if (description !== undefined && !bornee(description, 500)) return null;
      return { ...base, kind: 'calendar', title, startAt, endAt, ...(typeof description === 'string' ? { description } : {}) };
    }
    case 'showLocation': {
      const { latitude, longitude, label } = o;
      if (!coordonnee(latitude, 90) || !coordonnee(longitude, 180)) return null;
      if (label !== undefined && !bornee(label, 100)) return null;
      return { ...base, kind: 'showLocation', latitude, longitude, ...(typeof label === 'string' ? { label } : {}) };
    }
    default:
      return null;
  }
}

function carteDepuis(v: unknown): RcsCard | null {
  const o = objet(v);
  if (!o) return null;
  const { title, description, mediaUrl, mediaHeight, suggestions } = o;
  if (title !== undefined && !requise(title, MAX_TITRE_CARTE)) return null;
  if (description !== undefined && !bornee(description, MAX_TEXTE_CARTE)) return null;
  if (mediaUrl !== undefined && !requise(mediaUrl, 255)) return null;
  if (mediaHeight !== undefined && !estHauteur(mediaHeight)) return null;
  // La règle du fournisseur : un titre OU un visuel. Vides, ils ont déjà été refusés juste au-dessus.
  if (title === undefined && mediaUrl === undefined) return null;
  let boutons: RcsSuggestion[] | undefined;
  if (suggestions !== undefined) {
    if (!Array.isArray(suggestions) || suggestions.length > MAX_BOUTONS_CARTE) return null;
    const lus = suggestions.map(boutonDepuis);
    const valides = lus.filter((s): s is RcsSuggestion => s !== null);
    if (valides.length !== lus.length) return null;
    boutons = valides;
  }
  return {
    ...(typeof title === 'string' ? { title } : {}),
    ...(typeof description === 'string' ? { description } : {}),
    ...(typeof mediaUrl === 'string' ? { mediaUrl } : {}),
    ...(estHauteur(mediaHeight) ? { mediaHeight } : {}),
    ...(boutons ? { suggestions: boutons } : {}),
  };
}

/**
 * LA RELECTURE STRICTE D'UN CARROUSEL COPIÉ DANS UN BROUILLON DE CAMPAGNE, ou `null`.
 *
 * 🔴 UN CARROUSEL MAL FORMÉ EST JETÉ, JAMAIS RÉPARÉ. `campaign_drafts.state` est un `jsonb` libre que rien ne
 * valide. Réparer (comme `boutonsDepuisNode` fait d'un bouton inconnu un bouton Réponse) se défend sur un
 * contenu qu'on édite sous ses yeux ; sur une copie figée qu'on ne peut pas éditer dans l'assistant, ce serait
 * envoyer un message que personne n'a relu. L'étage redevient vide et le récapitulatif le dit.
 *
 * ⚠️ ELLE VÉRIFIE LA FORME ET LES BORNES, PAS LE FORMAT D'UNE ADRESSE : le serveur reste l'autorité et refuse
 * en 400 à la création, comme pour tout ce que l'assistant envoie. L'écart est écrit dans le test.
 */
export function carrouselDepuis(v: unknown): CarrouselRcs | null {
  const o = objet(v);
  if (!o || o.kind !== 'carousel') return null;
  const { cards } = o;
  if (!Array.isArray(cards) || cards.length < MIN_CARTES || cards.length > MAX_CARTES) return null;
  const lues = cards.map(carteDepuis);
  const valides = lues.filter((c): c is RcsCard => c !== null);
  if (valides.length !== lues.length) return null;
  return { kind: 'carousel', cards: valides };
}
```

- [ ] **Étape 4 : ajouter à `web/lib/rcs.ts` l'import et les trois fonctions**

En tête, sous l'import existant :

```ts
import { boutonPret } from './rcs-boutons';
```

À la fin du fichier :

```ts
/**
 * CE QUI MANQUE POUR ENREGISTRER UN MESSAGE SIMPLE, en paires `[fr, en]`.
 *
 * 🔴 LE BOUTON « CRÉER LE MESSAGE » EST GRISÉ SI ET SEULEMENT SI CETTE LISTE N'EST PAS VIDE. Il se grisait
 * jusqu'au 2026-09-21 sur ces quatre conditions sans en nommer aucune ; l'écran des templates WhatsApp, dont
 * celui-ci reprend le dessin, dit ce qu'il attend. Une seule fonction décide des deux, sans quoi le bouton se
 * grise pour une raison que la liste ne nomme pas.
 */
export function manquesMessageRcs(nom: string, b: BrouillonRcs): Array<[string, string]> {
  const manques: Array<[string, string]> = [];
  if (nom.trim() === '') manques.push(['le nom du message', 'the message name']);
  if (b.text.trim() === '') manques.push(['le texte du message', 'the message text']);
  const max = maxTexteRcs(b.imageUrl);
  if (b.text.length > max) {
    manques.push([`un texte plus court (${max} caractères au plus)`, `a shorter text (${max} characters max)`]);
  }
  if (!b.suggestions.every(boutonPret)) {
    manques.push(['un bouton complet (libellé, lien, numéro ou dates)', 'a complete button (label, link, number or dates)']);
  }
  return manques;
}

/** Le FORMAT d'un message de la bibliothèque, pour la colonne « Format » du tableau, en paire `[fr, en]`. */
export function libelleFormatRcs(content: RcsOutbound | null): [string, string] {
  if (!content) return ['illisible', 'unreadable'];
  if (content.kind === 'text') return ['message', 'message'];
  if (content.kind === 'card') return ['carte', 'card'];
  const n = content.cards.length;
  return [`carrousel · ${n} cartes`, `carousel · ${n} cards`];
}

/**
 * Le début du texte d'un message, pour la colonne « Texte » du tableau. Même lecture que l'aperçu du fil côté
 * serveur (`apercuRcsSortant`) : une carte n'a pas de `text`, un carrousel se lit par sa première carte.
 */
export function extraitRcs(content: RcsOutbound | null): string {
  if (!content) return '';
  if (content.kind === 'text') return content.text;
  if (content.kind === 'card') return content.card.description ?? content.card.title ?? '';
  const premiere = content.cards[0];
  return premiere?.description ?? premiere?.title ?? '';
}
```

- [ ] **Étape 5 : vérifier que tout passe, dans les deux suites**

Run: `npx vitest run tests/web-rcs-carrousel.test.ts tests/web-rcs-brouillon.test.ts`
Attendu : PASS (le second fichier prouve que `web/lib/rcs.ts` n'a rien perdu).
Run: `npm run typecheck`
Attendu : aucune erreur (la racine compile `tests/`, donc `web/lib/rcs-carrousel.ts` sous `noUncheckedIndexedAccess`).

- [ ] **Étape 6 : vérifier le test dans l'autre sens** (règle du dépôt) : remplacer temporairement, dans
`carteDepuis`, `if (title === undefined && mediaUrl === undefined) return null;` par rien ; relancer ; le cas
« une carte sans titre ni visuel » doit ÉCHOUER. Restaurer, relancer, PASS.

- [ ] **Étape 7 : commit**

```bash
git add web/lib/rcs-carrousel.ts tests/web-rcs-carrousel.test.ts
git commit --only web/lib/rcs-carrousel.ts web/lib/rcs.ts tests/web-rcs-carrousel.test.ts -m "feat(rcs): la logique pure du carrousel et des manques, testee contre le schema serveur"
```

---

### Tâche 2 : les pièces partagées (cadre, aperçus, visuel en tuile)

**Fichiers :**
- Créer : `web/components/RcsPhoneFrame.tsx`, `web/components/RcsCarouselPreview.tsx`
- Modifier : `web/components/RcsPreview.tsx` (prop `sansFond`), `web/components/ChampImageHebergee.tsx`
  (prop `apparence`), `web/components/TemplateForm.tsx` (exporter `Field`, sans rien changer d'autre)

**Interfaces produites :**
- `RcsPhoneFrame({ children }: { children: ReactNode })`, `data-testid="apercu-rcs-marque"` sur le nom
- `RcsCarouselPreview({ brouillon, sansFond }: { brouillon: BrouillonCarrouselRcs; sansFond?: boolean })`,
  `data-testid="rcs-carrousel-apercu"` et `rcs-carrousel-apercu-carte-<i>`
- `RcsPreview` gagne `sansFond?: boolean` (défaut `false`, rendu inchangé)
- `ChampImageHebergee` gagne `apparence?: 'ligne' | 'tuile'` (défaut `'ligne'`, rendu inchangé)
- `export function Field({ label, children })` depuis `TemplateForm.tsx`

- [ ] **Étape 1 : `web/components/RcsPhoneFrame.tsx`**

```tsx
'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { useT } from '@/lib/i18n';
import { getSession } from '@/lib/session';
import { listRcsAgents } from '@/lib/api';

/**
 * Chrome « téléphone » des aperçus RCS : le libellé, l'en-tête au nom de la marque, le fond de conversation.
 * C'est le pendant de `PhoneFrame`, le cadre des aperçus WhatsApp.
 *
 * 🔴 IL EXISTE PARCE QUE L'ÉCRAN MESSAGES RCS DOIT AVOIR « LA MÊME GUEULE » QUE CELUI DES TEMPLATES WHATSAPP
 * (Julien, 2026-09-21), dont l'aperçu vit dans un cadre de téléphone. Les bulles, elles, restent celles de
 * `RcsPreview` : menthe, la couleur du RCS dans l'Inbox.
 *
 * Le nom affiché est le NOM DE MARQUE de l'agent RCS (`RcsAgent.brandName`), ce que le destinataire lit en haut
 * de sa conversation. Il se résout comme le nom vérifié de `PhoneFrame` : une requête par espace pour toute la
 * page, un échec retiré de la mémoire (sans quoi une coupure d'une seconde figerait le repli pour la vie de
 * l'onglet), et un libellé neutre en repli réel.
 */
const marquesParEspace = new Map<string, Promise<string | null>>();

function nomDeMarque(tenantId: string): Promise<string | null> {
  const connu = marquesParEspace.get(tenantId);
  if (connu) return connu;
  const p = listRcsAgents(tenantId)
    .then((r) => {
      // Réponse 200 sans le champ attendu : `.find` sur `undefined` ferait tomber l'écran, pas le seul bandeau.
      const agents = Array.isArray(r?.agents) ? r.agents : [];
      return agents.find((a) => (a.brandName ?? '') !== '')?.brandName ?? null;
    })
    .catch(() => {
      marquesParEspace.delete(tenantId);
      return null;
    });
  marquesParEspace.set(tenantId, p);
  return p;
}

export function RcsPhoneFrame({ children }: { children: ReactNode }) {
  const t = useT();
  const [marque, setMarque] = useState<string | null>(null);

  useEffect(() => {
    const tenantId = getSession()?.tenantId;
    if (!tenantId) return;
    let vivant = true;
    void nomDeMarque(tenantId).then((n) => { if (vivant) setMarque(n); });
    return () => { vivant = false; };
  }, []);

  return (
    <div>
      <p className="mb-2 text-xs font-medium text-ink-500">{t('Aperçu RCS', 'RCS preview')}</p>
      <div className="overflow-hidden rounded-2xl border border-ink-200 shadow-sm">
        <div className="flex items-center gap-2 border-b border-ink-100 bg-white px-3 py-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-full bg-mint-100 text-sm">🏢</div>
          <div className="leading-tight">
            <div className="flex items-center gap-1 text-sm font-medium text-ink-900">
              <span data-testid="apercu-rcs-marque">{marque || t('Votre marque', 'Your brand')}</span>
              <span className="text-xs text-brand-600" title={t('Marque vérifiée', 'Verified brand')}>✓</span>
            </div>
            <div className="text-[10px] text-ink-400">{t('agent de marque vérifié', 'verified brand agent')}</div>
          </div>
        </div>
        <div className="space-y-2 bg-ink-50 px-3 py-4">{children}</div>
      </div>
    </div>
  );
}
```

- [ ] **Étape 2 : `web/components/RcsCarouselPreview.tsx`**

```tsx
'use client';

import { ICONE_KIND } from '@/lib/rcs-boutons';
import type { BrouillonCarrouselRcs } from '@/lib/rcs-carrousel';
import { useT } from '@/lib/i18n';

/**
 * LE CARROUSEL RCS TEL QUE LE CONTACT LE VERRA : des cartes qui défilent à l'horizontale, chacune avec son
 * visuel, son titre, son texte, et ses boutons EN LISTE pleine largeur. Ce sont des boutons de CARTE : ils
 * restent affichés, contrairement aux pastilles d'un message texte (cf. `RcsPreview`).
 *
 * Le dessin d'une carte est celui de la carte simple de `RcsPreview`, répété : deux dessins pour la même carte
 * divergeraient au premier ajustement. Partagé par la bibliothèque, l'assistant de campagne et l'Inbox.
 *
 * ⚠️ UNE CARTE SANS VISUEL N'A PAS D'EMPLACEMENT GRIS : en RCS le visuel est facultatif (une carte peut n'être
 * qu'un titre), et l'aperçu montrerait un trou que le téléphone ne montre pas. Seule une carte ENTIÈREMENT
 * vide se signale, pour qu'on voie qu'elle existe.
 */
export function RcsCarouselPreview({ brouillon, sansFond = false }: { brouillon: BrouillonCarrouselRcs; sansFond?: boolean }) {
  const t = useT();
  return (
    <div className={sansFond ? '' : 'rounded-xl bg-ink-50 p-3'}>
      <div data-testid="rcs-carrousel-apercu" className="flex gap-2 overflow-x-auto pb-1">
        {brouillon.cartes.map((c, i) => {
          const image = c.imageUrl.trim();
          const titre = c.title.trim();
          const texte = c.text.trim();
          const boutons = c.suggestions.filter((s) => s.text.trim() !== '');
          const vide = image === '' && titre === '' && texte === '' && boutons.length === 0;
          return (
            <div key={i} data-testid={`rcs-carrousel-apercu-carte-${i}`} className="w-48 shrink-0 overflow-hidden rounded-2xl bg-mint-100">
              {image !== '' && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={image} alt={`${t('Carte', 'Card')} ${i + 1}`} referrerPolicy="no-referrer" className="aspect-video w-full bg-ink-100 object-cover" />
              )}
              {vide && <div className="px-3 py-2 text-sm italic text-ink-400">{t(`Carte ${i + 1}…`, `Card ${i + 1}…`)}</div>}
              {(titre !== '' || texte !== '') && (
                <div className="px-3 py-2">
                  {titre !== '' && <div className="text-sm font-semibold text-ink-900">{titre}</div>}
                  {texte !== '' && <div className="whitespace-pre-wrap text-sm text-ink-800">{texte}</div>}
                </div>
              )}
              {boutons.map((s, j) => (
                <div key={j} className="border-t border-mint-200 bg-white px-3 py-2 text-center text-sm font-medium text-ink-800">
                  {ICONE_KIND[s.kind]}{s.text}
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
```

- [ ] **Étape 3 : `RcsPreview` gagne `sansFond`** : dans `web/components/RcsPreview.tsx`, la signature devient

```tsx
export function RcsPreview({ brouillon, vide, sansFond = false }: { brouillon: BrouillonRcs; vide?: string; sansFond?: boolean }) {
```

et la première balise du rendu devient

```tsx
    <div className={sansFond ? '' : 'rounded-xl bg-ink-50 p-3'}>
```

Ajouter au commentaire du composant : « `sansFond` : posé dans un `RcsPhoneFrame`, qui porte déjà le fond. »

- [ ] **Étape 4 : `ChampImageHebergee` gagne `apparence`** : ajouter la prop, documentée, et le rendu « tuile »
(la zone pointillée de `CarouselForm`), SANS toucher au rendu « ligne ». Dans la signature :

```tsx
export function ChampImageHebergee({
  tenantId, valeur, onChange, testIdPrefix = 'rcs-message', compact = false, avertirExtension = true, apparence = 'ligne',
}: {
  // ... props existantes inchangées ...
  /**
   * `tuile` : la zone pointillée « Choisir une image » des cartes de `CarouselForm`, avec le visuel dedans une
   * fois posé. C'est le dessin des cartes d'un carrousel RCS, qui doivent ressembler à celles d'un carousel
   * WhatsApp (Julien, 2026-09-21). `ligne` (défaut) : le bouton et la vignette, inchangés.
   */
  apparence?: 'ligne' | 'tuile';
}) {
```

Dans le rendu, remplacer le premier bloc `<div className="flex items-center gap-2">…</div>` et le champ
d'adresse par :

```tsx
  const aUneImage = valeur.trim() !== '';
  const retirer = (
    <button
      type="button"
      onClick={() => { onChange(''); setErreur(null); }}
      data-testid={`${testIdPrefix}-image-clear`}
      className="shrink-0 text-sm text-ink-400 hover:text-coral"
    >
      {t('Retirer', 'Remove')}
    </button>
  );
  const champAdresse = (classe: string) => (
    <input
      value={valeur}
      onChange={(e) => onChange(e.target.value)}
      data-testid={`${testIdPrefix}-image`}
      className={classe}
      placeholder={t('…ou collez l’adresse d’une image déjà en ligne', '…or paste the URL of an image already online')}
    />
  );

  return (
    <div>
      {apparence === 'tuile' ? (
        <button
          type="button"
          onClick={() => fichierRef.current?.click()}
          disabled={busy}
          data-testid={`${testIdPrefix}-image-upload`}
          className="flex aspect-video w-full items-center justify-center overflow-hidden rounded-lg border border-dashed border-ink-300 bg-ink-50 text-xs text-ink-400 hover:border-brand-400 disabled:cursor-not-allowed"
        >
          {busy ? t('Envoi…', 'Uploading…') : aUneImage ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={valeur.trim()} alt="" referrerPolicy="no-referrer" className="h-full w-full object-cover" />
          ) : t('Choisir une image', 'Choose an image')}
        </button>
      ) : (
        <div className="flex items-center gap-2">
          {/* ... bloc existant inchangé (bouton, vignette), son « Retirer » remplacé par {retirer} ... */}
        </div>
      )}
      <input ref={fichierRef} type="file" accept="image/jpeg,image/png,image/gif" data-testid={`${testIdPrefix}-image-file`} className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) void televerser(f); }} />
      {apparence === 'tuile' ? (
        <div className="mt-1.5 flex items-center gap-2">
          {champAdresse(cls)}
          {aUneImage && retirer}
        </div>
      ) : champAdresse(`${cls} mt-1.5`)}
      {/* ... messages d'erreur et d'extension existants, inchangés ... */}
    </div>
  );
```

⚠️ Le bloc « ligne » garde ses classes, ses `data-testid` et son ordre : `rcs-messages.spec.ts` le vise.

- [ ] **Étape 5 : exporter `Field`** : dans `web/components/TemplateForm.tsx`, `function Field(` devient
`export function Field(`. Rien d'autre.

- [ ] **Étape 6 : vérifier types et lint**

Run: `cd web && npx tsc --noEmit && npm run lint`
Attendu : aucune erreur.

- [ ] **Étape 7 : commit**

```bash
git add web/components/RcsPhoneFrame.tsx web/components/RcsCarouselPreview.tsx
git commit --only web/components/RcsPhoneFrame.tsx web/components/RcsCarouselPreview.tsx web/components/RcsPreview.tsx web/components/ChampImageHebergee.tsx web/components/TemplateForm.tsx -m "feat(rcs): cadre de telephone, apercu de carrousel et visuel en tuile"
```

---

### Tâche 3 : l'écran, sur le dessin de Contenu > Templates

**Fichiers :**
- Créer : `web/components/RcsMessageForm.tsx`, `web/components/RcsCarouselForm.tsx`, `web/e2e/rcs-carrousel.spec.ts`
- Réécrire : `web/app/rcs-messages/page.tsx`
- Modifier : `web/e2e/rcs-messages.spec.ts` (UN cas AJOUTÉ, aucun cas existant touché)

**Interfaces consommées :** tout ce que produisent les tâches 1 et 2.

**Interfaces produites (`data-testid`) :** `rcs-message-new`, `rcs-format-simple`, `rcs-format-carrousel`,
`rcs-message-manques`, `rcs-carrousel-nom`, `rcs-carte-<i>`, `rcs-carte-<i>-retirer`, `rcs-carte-<i>-titre`,
`rcs-carte-<i>-texte`, `rcs-carte-<i>-image`, `rcs-carte-<i>-message-add-button`,
`rcs-carrousel-ajouter-carte`, `rcs-carrousel-manques`, `rcs-carrousel-enregistrer`, `rcs-message-list`,
`rcs-message-format-<id>`, `rcs-message-editer-<id>`, `rcs-message-apercu`, `apercu-rcs`.

- [ ] **Étape 1 : écrire le e2e qui échoue** : `web/e2e/rcs-carrousel.spec.ts`

```ts
import { test, expect, type Page } from '@playwright/test';
import { TREIZE_POUCES, pasDeDebordement } from './aide/largeur';

/**
 * Contenu > Messages RCS : le CARROUSEL, et le dessin repris de Contenu > Templates (2026-09-21).
 *
 * Ce qu'on protège, comme dans `rcs-messages.spec.ts` : le corps RÉELLEMENT posté. Un écran peut montrer dix
 * cartes et n'en poster que deux, ou poser le visuel d'une carte sur sa voisine.
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };
const IMG = 'https://exemple.test/v.jpg';

const CARROUSEL = {
  id: 'c1', name: 'Sélection rentrée', createdAt: '', updatedAt: '',
  content: {
    kind: 'carousel',
    cards: [
      { title: 'Séjour à Nice', description: 'Dès 99 €', mediaUrl: IMG, mediaHeight: 'TALL', suggestions: [{ kind: 'reply', text: 'Je veux', postbackData: 'carte1_btn1' }] },
      { title: 'Séjour à Lyon', description: 'Dès 79 €', mediaUrl: IMG, mediaHeight: 'TALL' },
    ],
  },
};
const SIMPLE = { id: 's1', name: 'Relance', createdAt: '', updatedAt: '', content: { kind: 'text', text: 'Bonjour {{prenom}}' } };

interface Envois {
  posts: Array<Record<string, unknown>>;
  patches: Array<{ url: string; body: Record<string, unknown> }>;
}

async function mock(page: Page, messages: unknown[] = []): Promise<Envois> {
  const envois: Envois = { posts: [], patches: [] };
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
  await page.route('**/api/backend/**', async (route) => {
    const req = route.request();
    const url = req.url();
    const json = (b: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(b) });
    if (req.method() === 'POST' && url.includes('/rcs-messages')) {
      envois.posts.push((req.postDataJSON() ?? {}) as Record<string, unknown>);
      return json({ message: { id: 'n1', name: 'x', content: null, createdAt: '', updatedAt: '' } }, 201);
    }
    if (req.method() === 'PATCH' && url.includes('/rcs-messages/')) {
      envois.patches.push({ url, body: (req.postDataJSON() ?? {}) as Record<string, unknown> });
      return json({ ok: true });
    }
    if (url.includes('/rcs-messages')) return json({ messages });
    if (url.includes('/rcs-agents')) return json({ agents: [{ agentId: 'ag1', brandName: 'Ma marque', status: 'launched' }] });
    if (url.includes('/user-fields')) return json({ fields: [{ key: 'prenom', label: 'Prénom', type: 'text' }] });
    if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
    return json({});
  });
  return envois;
}

async function nouveauCarrousel(page: Page): Promise<void> {
  await page.goto('/rcs-messages');
  await page.getByTestId('rcs-message-new').click();
  await page.getByTestId('rcs-format-carrousel').click();
  await expect(page.getByTestId('rcs-carrousel-nom')).toBeVisible({ timeout: 15_000 });
}

test.describe('Contenu : carrousel RCS', () => {
  test('🔴 compose un carrousel de deux cartes et poste EXACTEMENT ses cartes', async ({ page }) => {
    const envois = await mock(page);
    await nouveauCarrousel(page);
    await page.getByTestId('rcs-carrousel-nom').fill('Sélection rentrée');

    await page.getByTestId('rcs-carte-0-image').fill(IMG);
    await page.getByTestId('rcs-carte-0-titre').fill('Séjour à Nice');
    await page.getByTestId('rcs-carte-0-texte').fill('Dès 99 €');
    await page.getByTestId('rcs-carte-0-message-add-button').click();
    await page.getByTestId('rcs-carte-0').getByPlaceholder('Libellé du bouton').fill('Je veux');

    await page.getByTestId('rcs-carte-1-image').fill(IMG);
    await page.getByTestId('rcs-carte-1-texte').fill('Séjour à Lyon');

    // L'aperçu montre les deux cartes, titre et bouton compris, AVANT tout enregistrement.
    await expect(page.getByTestId('rcs-carrousel-apercu-carte-0')).toContainText('Séjour à Nice');
    await expect(page.getByTestId('rcs-carrousel-apercu-carte-0')).toContainText('Je veux');
    await expect(page.getByTestId('rcs-carrousel-apercu-carte-1')).toContainText('Séjour à Lyon');

    await page.getByTestId('rcs-carrousel-enregistrer').click();
    await expect.poll(() => envois.posts.length, { timeout: 10_000 }).toBe(1);
    expect(envois.posts[0]).toEqual({
      name: 'Sélection rentrée',
      content: {
        kind: 'carousel',
        cards: [
          {
            title: 'Séjour à Nice', description: 'Dès 99 €', mediaUrl: IMG, mediaHeight: 'TALL',
            suggestions: [{ kind: 'reply', text: 'Je veux', postbackData: 'carte1_btn1' }],
          },
          { description: 'Séjour à Lyon', mediaUrl: IMG, mediaHeight: 'TALL' },
        ],
      },
    });
  });

  test('dit ce qui manque, carte par carte, et ne poste rien tant qu il manque', async ({ page }) => {
    const envois = await mock(page);
    await nouveauCarrousel(page);
    const manques = page.getByTestId('rcs-carrousel-manques');
    await expect(manques).toContainText('le nom du carrousel');
    await expect(manques).toContainText('le visuel ou le titre de la carte 1');
    await expect(manques).toContainText('le visuel ou le titre de la carte 2');
    await expect(page.getByTestId('rcs-carrousel-enregistrer')).toBeDisabled();

    await page.getByTestId('rcs-carrousel-nom').fill('X');
    await page.getByTestId('rcs-carte-0-titre').fill('Titre seul');
    await expect(manques).not.toContainText('carte 1');
    await expect(manques).toContainText('le visuel ou le titre de la carte 2');
    expect(envois.posts).toHaveLength(0);
  });

  test('deux cartes au minimum, dix au plus', async ({ page }) => {
    await mock(page);
    await nouveauCarrousel(page);
    await expect(page.getByTestId('rcs-carte-0-retirer')).toBeDisabled();
    const ajouter = page.getByTestId('rcs-carrousel-ajouter-carte');
    for (let i = 0; i < 8; i += 1) await ajouter.click();
    await expect(page.getByTestId('rcs-carte-9')).toBeVisible();
    await expect(ajouter).toBeDisabled();
    await page.getByTestId('rcs-carte-9-retirer').click();
    await expect(page.getByTestId('rcs-carte-9')).toHaveCount(0);
    await expect(ajouter).toBeEnabled();
  });

  test('🔴 basculer de format ne perd pas la saisie', async ({ page }) => {
    await mock(page);
    await page.goto('/rcs-messages');
    await page.getByTestId('rcs-message-new').click();
    await page.getByTestId('rcs-message-name').fill('Mon message');
    await page.getByTestId('rcs-message-text').fill('Bonjour');
    await page.getByTestId('rcs-format-carrousel').click();
    await page.getByTestId('rcs-carrousel-nom').fill('Mon carrousel');
    await page.getByTestId('rcs-format-simple').click();
    await expect(page.getByTestId('rcs-message-name')).toHaveValue('Mon message');
    await expect(page.getByTestId('rcs-message-text')).toHaveText('Bonjour');
    await page.getByTestId('rcs-format-carrousel').click();
    await expect(page.getByTestId('rcs-carrousel-nom')).toHaveValue('Mon carrousel');
  });

  test('le tableau dit le format, et un carrousel se modifie dans SON formulaire', async ({ page }) => {
    const envois = await mock(page, [CARROUSEL, SIMPLE]);
    await page.goto('/rcs-messages');
    await expect(page.getByTestId('rcs-message-format-c1')).toHaveText('carrousel · 2 cartes');
    await expect(page.getByTestId('rcs-message-format-s1')).toHaveText('message');
    await page.getByTestId('rcs-message-editer-c1').click();
    // Pas de sélecteur de format en modification, comme pour un template.
    await expect(page.getByTestId('rcs-format-simple')).toHaveCount(0);
    await expect(page.getByTestId('rcs-carte-1-titre')).toHaveValue('Séjour à Lyon');
    await page.getByTestId('rcs-carte-1-titre').fill('Séjour à Lille');
    await page.getByTestId('rcs-carrousel-enregistrer').click();
    await expect.poll(() => envois.patches.length, { timeout: 10_000 }).toBe(1);
    expect(envois.patches[0]!.url).toContain('/rcs-messages/c1');
    expect(envois.patches[0]!.body).toMatchObject({
      name: 'Sélection rentrée',
      content: { kind: 'carousel', cards: [{ title: 'Séjour à Nice' }, { title: 'Séjour à Lille' }] },
    });
  });

  test('le nom ouvre l aperçu, dans le cadre de telephone de la marque', async ({ page }) => {
    await mock(page, [CARROUSEL]);
    await page.goto('/rcs-messages');
    await page.getByRole('button', { name: 'Sélection rentrée' }).click();
    const fenetre = page.getByTestId('rcs-message-apercu');
    await expect(fenetre.getByTestId('rcs-carrousel-apercu-carte-0')).toContainText('Séjour à Nice');
    await expect(fenetre.getByTestId('apercu-rcs-marque')).toHaveText('Ma marque');
  });

  test('🔴 a 1280 px, le formulaire carrousel ne deborde pas', async ({ page }) => {
    await page.setViewportSize(TREIZE_POUCES);
    await mock(page);
    await nouveauCarrousel(page);
    await page.getByTestId('rcs-carte-0-message-add-button').click();
    await pasDeDebordement(page);
  });
});
```

Et UN cas AJOUTÉ à la fin du `describe` de `web/e2e/rcs-messages.spec.ts` (les autres ne bougent pas) :

```ts
  // Le bouton se grisait sans rien dire. Le dessin des templates dit ce qu'il attend.
  test('le formulaire simple dit ce qui manque', async ({ page }) => {
    await mock(page, []);
    await page.goto('/rcs-messages');
    await page.getByTestId('rcs-message-new').click();
    const manques = page.getByTestId('rcs-message-manques');
    await expect(manques).toContainText('le nom du message');
    await expect(manques).toContainText('le texte du message');
    await page.getByTestId('rcs-message-name').fill('Offre');
    await page.getByTestId('rcs-message-text').fill('Bonjour');
    await expect(manques).toHaveCount(0);
    await expect(page.getByTestId('rcs-message-save')).toBeEnabled();
  });
```

- [ ] **Étape 2 : vérifier qu'ils échouent**

Run: `cd web && npx playwright test e2e/rcs-carrousel.spec.ts e2e/rcs-messages.spec.ts`
Attendu : les 7 cas neufs de `rcs-carrousel.spec.ts` et le cas ajouté ÉCHOUENT (testids introuvables) ; les
cas existants de `rcs-messages.spec.ts` PASSENT encore.

- [ ] **Étape 3 : `web/components/RcsMessageForm.tsx`** (le formulaire simple, sorti de la page, sur le
dessin de `TemplateForm`)

```tsx
'use client';

import { useState } from 'react';
import { createRcsMessage, updateRcsMessage, type UserFieldDef } from '@/lib/api';
import {
  versMessageRcs, maxTexteRcs, manquesMessageRcs, MAX_BOUTONS_RCS, MAX_BOUTONS_CARTE, type BrouillonRcs,
} from '@/lib/rcs';
import { RcsButtonsEditor } from '@/components/RcsButtonsEditor';
import { ChampImageHebergee } from '@/components/ChampImageHebergee';
import { ChampCorpsVariables } from '@/components/ChampCorpsVariables';
import { RcsPreview } from '@/components/RcsPreview';
import { RcsPhoneFrame } from '@/components/RcsPhoneFrame';
import { ListeManques } from '@/components/ListeManques';
import { Field } from '@/components/TemplateForm';
import { useT } from '@/lib/i18n';
import { inputCls } from '@/lib/ui';

/** Un message simple qu'on modifie : son identifiant, son nom, et son contenu déjà relu en brouillon. */
export interface MessageSimpleInitial {
  id: string;
  name: string;
  brouillon: BrouillonRcs;
}

/**
 * LE FORMULAIRE D'UN MESSAGE RCS SIMPLE (texte, ou carte dès qu'il y a un visuel), sur le dessin de
 * `TemplateForm` : le formulaire à gauche, l'« Aperçu RCS » dans un cadre de téléphone à droite, ce qui manque
 * sous le formulaire, et un bouton pleine largeur.
 *
 * 🔴 SORTI DE LA PAGE LE 2026-09-21 SANS CHANGER CE QU'IL POSTE (Julien : « il faut que ça ait vraiment la même
 * gueule que les écrans WhatsApp template »). Ce qui part reste `versMessageRcs(brouillon)`, et les
 * `data-testid` sont ceux d'avant : les cas de `rcs-messages.spec.ts` passent sans être réécrits, et c'est ce
 * qui prouve que le dessin n'a rien changé au contenu.
 *
 * 🔴 LE BOUTON EST GRISÉ SI ET SEULEMENT SI `manquesMessageRcs` N'EST PAS VIDE : la même liste décide du
 * bouton et de ce qu'on affiche, sans quoi le bouton se grise pour une raison qu'elle ne nomme pas.
 */
export function RcsMessageForm({ tenantId, fields, initial, onSaved }: {
  tenantId: string;
  fields: UserFieldDef[];
  initial?: MessageSimpleInitial;
  onSaved: () => void;
}) {
  const t = useT();
  const [nom, setNom] = useState(initial?.name ?? '');
  const [brouillon, setBrouillon] = useState<BrouillonRcs>(initial?.brouillon ?? { text: '', imageUrl: '', suggestions: [] });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 🔴 Où les boutons sont accrochés décide de leur APPARENCE sur le téléphone, et ce n'est pas nous qui la
  // dessinons. Dans la CARTE : pleine largeur, empilés, persistants (4 maximum). Sous le MESSAGE : petites
  // pastilles en ligne, éphémères (11 maximum). `RcsPreview` dessine cette différence, `versMessageRcs`
  // l'écrit ; ici on n'a besoin que de savoir s'il y a un visuel.
  const avecImage = brouillon.imageUrl.trim() !== '';
  const manques = manquesMessageRcs(nom, brouillon).map((m) => t(...m));
  const canSubmit = manques.length === 0 && !busy;

  async function enregistrer() {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const contenu = versMessageRcs(brouillon);
      if (initial) await updateRcsMessage(tenantId, initial.id, nom.trim(), contenu);
      else await createRcsMessage(tenantId, nom.trim(), contenu);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('Enregistrement impossible', 'Save failed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-2xl border border-ink-200 bg-white p-6 shadow-sm">
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div>
          <Field label={t('Nom (interne)', 'Name (internal)')}>
            <input
              value={nom}
              onChange={(e) => setNom(e.target.value)}
              maxLength={120}
              data-testid="rcs-message-name"
              className={inputCls}
              placeholder={t('Offre du jour', 'Daily offer')}
            />
          </Field>

          <Field label={t('Image d’en-tête (facultatif)', 'Header image (optional)')}>
            <ChampImageHebergee
              tenantId={tenantId}
              valeur={brouillon.imageUrl}
              onChange={(imageUrl) => setBrouillon((b) => ({ ...b, imageUrl }))}
            />
            <p className="mt-1 text-[11px] text-ink-400">
              {t('JPEG, PNG ou GIF, 2 Mo maximum. Avec un visuel, le message devient une carte : l’image s’affiche au-dessus du texte et les boutons passent en liste.', 'JPEG, PNG or GIF, 2 MB maximum. With a visual, the message becomes a card: the image shows above the text and the buttons switch to a list.')}
            </p>
          </Field>

          <div className="mt-3">
            <ChampCorpsVariables
              valeur={brouillon.text}
              onChange={(text) => setBrouillon((b) => ({ ...b, text }))}
              fields={fields}
              label={t('Message', 'Message')}
              testId="rcs-message-text"
              max={maxTexteRcs(brouillon.imageUrl)}
            />
            <p className="mt-1 text-[11px] text-ink-400">
              {t('« + Variable » insère un champ du contact : il s’affiche comme une étiquette et sera remplacé à l’envoi. Sans valeur sur la fiche, il laisse un blanc.', '“+ Variable” inserts a contact field: it shows as a tag and is filled in at send time. With no value on the record, it leaves a blank.')}
            </p>
          </div>

          <Field label={t('Boutons', 'Buttons')}>
            <RcsButtonsEditor
              boutons={brouillon.suggestions}
              onChange={(suggestions) => setBrouillon((b) => ({ ...b, suggestions }))}
              max={avecImage ? MAX_BOUTONS_CARTE : MAX_BOUTONS_RCS}
              dateFields={fields}
            />
            <p className="mt-1 text-[11px] text-ink-400">
              {avecImage
                ? t('Avec un visuel, jusqu’à 4 boutons : ils s’affichent en LISTE pleine largeur dans la carte, et y restent. 25 caractères chacun.', 'With a visual, up to 4 buttons: they show as a full-width LIST inside the card and stay there. 25 characters each.')
                : t('Sans visuel, jusqu’à 11 boutons : ils s’affichent en petites PASTILLES sous la bulle, et disparaissent dès que la conversation avance. Ajoutez une image pour des boutons en liste. 25 caractères chacun.', 'With no visual, up to 11 buttons: they show as small CHIPS under the bubble and vanish as the conversation moves on. Add an image to get list buttons. 25 characters each.')}
            </p>
            <p className="mt-1 text-[11px] text-ink-400">
              {t('Les variables ne sont pas remplacées dans un libellé. Un bouton « Réponse » est le seul qui devienne une sortie à relier dans un scénario.', 'Variables are not substituted in a label. A "Reply" button is the only one that becomes an output to connect in a scenario.')}
            </p>
          </Field>

          {error && <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
          <ListeManques manques={manques} testId="rcs-message-manques" busy={busy} />
          <button
            type="button"
            onClick={() => void enregistrer()}
            disabled={!canSubmit}
            data-testid="rcs-message-save"
            className="mt-4 w-full rounded-lg bg-brand-500 px-3 py-2 text-sm font-semibold text-white transition hover:bg-brand-600 disabled:opacity-50"
          >
            {busy ? t('Enregistrement…', 'Saving…') : initial ? t('Enregistrer les modifications', 'Save changes') : t('Créer le message', 'Create message')}
          </button>
        </div>

        {/* Colonne aperçu, collante quand elle est À CÔTÉ, comme celle de `TemplateForm`. */}
        <div data-testid="apercu-rcs" className="lg:sticky lg:top-4 lg:h-fit">
          <RcsPhoneFrame>
            <RcsPreview brouillon={brouillon} sansFond />
          </RcsPhoneFrame>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Étape 4 : `web/components/RcsCarouselForm.tsx`** (sur le dessin de `CarouselForm`)

```tsx
'use client';

import { useRef, useState } from 'react';
import { createRcsMessage, updateRcsMessage, type UserFieldDef } from '@/lib/api';
import {
  carteVide, carrouselVide, manquesCarrousel, versCarrouselRcs, MAX_CARTES, MIN_CARTES, MAX_TEXTE_CARTE,
  MAX_TITRE_CARTE, type BrouillonCarrouselRcs, type CarteBrouillon,
} from '@/lib/rcs-carrousel';
import { MAX_BOUTONS_CARTE } from '@/lib/rcs';
import { RcsButtonsEditor } from '@/components/RcsButtonsEditor';
import { ChampImageHebergee } from '@/components/ChampImageHebergee';
import { ChampCorpsVariables } from '@/components/ChampCorpsVariables';
import { RcsCarouselPreview } from '@/components/RcsCarouselPreview';
import { RcsPhoneFrame } from '@/components/RcsPhoneFrame';
import { ListeManques } from '@/components/ListeManques';
import { useT } from '@/lib/i18n';
import { inputClsAuto } from '@/lib/ui';

/** Un carrousel qu'on modifie : son identifiant, son nom, et son contenu déjà relu en brouillon. */
export interface CarrouselInitial {
  id: string;
  name: string;
  brouillon: BrouillonCarrouselRcs;
}

/** Une carte en cours d'édition, avec une CLÉ STABLE (cf. `majCarte`). */
type CarteEdition = CarteBrouillon & { cle: number };

/**
 * L'ÉDITEUR D'UN CARROUSEL RCS, sur le dessin de `CarouselForm` (le carousel des templates WhatsApp) : le nom,
 * les cartes en grille avec la tuile « + Ajouter une carte », l'aperçu en dessous, ce qui manque, le bouton.
 *
 * ⚠️ UNE DIFFÉRENCE AVEC WHATSAPP, ET ELLE EST VOULUE : les boutons se règlent CARTE PAR CARTE. Meta exige la
 * même disposition sur toutes les cartes d'un carousel ; le RCS, non. Recopier la disposition commune de
 * `CarouselForm` serait inventer une contrainte que le canal n'a pas.
 *
 * Ce qui part est `versCarrouselRcs`, et le bouton est grisé si et seulement si `manquesCarrousel` n'est pas
 * vide : la même liste décide du bouton et de ce qu'on affiche.
 */
export function RcsCarouselForm({ tenantId, fields, initial, onSaved }: {
  tenantId: string;
  fields: UserFieldDef[];
  initial?: CarrouselInitial;
  onSaved: () => void;
}) {
  const t = useT();
  const prochaineCle = useRef(0);
  const avecCle = (c: CarteBrouillon): CarteEdition => ({ ...c, cle: prochaineCle.current++ });
  const [nom, setNom] = useState(initial?.name ?? '');
  const [cartes, setCartes] = useState<CarteEdition[]>(() => (initial?.brouillon ?? carrouselVide()).cartes.map(avecCle));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * 🔴 PAR CLÉ, JAMAIS PAR RANG. Un téléversement dure une seconde ou deux : retirer la carte 1 pendant que le
   * visuel de la carte 3 monte décale les rangs, et une mise à jour par rang poserait l'image sur la mauvaise
   * carte. La clé suit la carte, le rang ne la suit pas.
   */
  const majCarte = (cle: number, patch: Partial<CarteBrouillon>) =>
    setCartes((l) => l.map((c) => (c.cle === cle ? { ...c, ...patch } : c)));
  const ajouterCarte = () => setCartes((l) => (l.length < MAX_CARTES ? [...l, avecCle(carteVide())] : l));
  const retirerCarte = (cle: number) => setCartes((l) => (l.length > MIN_CARTES ? l.filter((c) => c.cle !== cle) : l));

  const brouillon: BrouillonCarrouselRcs = { cartes };
  const manques = manquesCarrousel(nom, brouillon).map((m) => t(...m));
  const canSubmit = manques.length === 0 && !busy;

  async function enregistrer() {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const contenu = versCarrouselRcs(brouillon);
      if (initial) await updateRcsMessage(tenantId, initial.id, nom.trim(), contenu);
      else await createRcsMessage(tenantId, nom.trim(), contenu);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('Enregistrement impossible', 'Save failed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4 rounded-2xl border border-ink-200 bg-white p-5 shadow-sm">
      <div>
        <label className="mb-1 block text-xs font-medium text-ink-600">{t('Nom du carrousel (interne)', 'Carousel name (internal)')}</label>
        <input
          value={nom}
          onChange={(e) => setNom(e.target.value)}
          maxLength={120}
          data-testid="rcs-carrousel-nom"
          className={`${inputClsAuto} w-full max-w-sm`}
          placeholder={t('Sélection de la rentrée', 'Back-to-school selection')}
        />
      </div>

      <div className="space-y-3">
        <div className="text-xs font-medium text-ink-600">
          {t('Cartes', 'Cards')} ({cartes.length}/{MAX_CARTES}, {t('2 minimum', 'min. 2')})
        </div>
        <div className="flex flex-col gap-3 sm:flex-row">
          <div className="grid flex-1 gap-3 sm:grid-cols-2">
            {cartes.map((c, i) => (
              <div key={c.cle} data-testid={`rcs-carte-${i}`} className="min-w-0 space-y-2 rounded-xl border border-ink-200 p-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-ink-500">{t('Carte', 'Card')} {i + 1}</span>
                  <button
                    type="button"
                    onClick={() => retirerCarte(c.cle)}
                    disabled={cartes.length <= MIN_CARTES}
                    data-testid={`rcs-carte-${i}-retirer`}
                    className="text-xs text-ink-400 hover:text-coral disabled:opacity-40"
                  >
                    {t('Retirer', 'Remove')}
                  </button>
                </div>
                <ChampImageHebergee
                  tenantId={tenantId}
                  valeur={c.imageUrl}
                  onChange={(imageUrl) => majCarte(c.cle, { imageUrl })}
                  testIdPrefix={`rcs-carte-${i}`}
                  apparence="tuile"
                  compact
                />
                <input
                  value={c.title}
                  onChange={(e) => majCarte(c.cle, { title: e.target.value })}
                  maxLength={MAX_TITRE_CARTE}
                  data-testid={`rcs-carte-${i}-titre`}
                  className={`${inputClsAuto} w-full`}
                  placeholder={t('Titre de la carte (facultatif)', 'Card title (optional)')}
                />
                <ChampCorpsVariables
                  valeur={c.text}
                  onChange={(text) => majCarte(c.cle, { text })}
                  fields={fields}
                  placeholder={t('Texte de la carte', 'Card text')}
                  testId={`rcs-carte-${i}-texte`}
                  max={MAX_TEXTE_CARTE}
                  compact
                />
                <RcsButtonsEditor
                  boutons={c.suggestions}
                  onChange={(suggestions) => majCarte(c.cle, { suggestions })}
                  max={MAX_BOUTONS_CARTE}
                  dateFields={fields}
                  testIdPrefix={`rcs-carte-${i}`}
                  compact
                />
              </div>
            ))}
          </div>
          {/* La tuile de `CarouselForm`, à droite des cartes, pleine hauteur. */}
          <button
            type="button"
            onClick={ajouterCarte}
            disabled={cartes.length >= MAX_CARTES}
            data-testid="rcs-carrousel-ajouter-carte"
            className="flex w-full shrink-0 flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed border-brand-200 px-4 py-6 text-brand-600 transition hover:border-brand-400 hover:bg-brand-50 disabled:opacity-40 sm:w-40"
          >
            <span className="text-2xl leading-none">+</span>
            <span className="text-sm font-medium">{t('+ Ajouter une carte', '+ Add a card')}</span>
          </button>
        </div>
      </div>

      <RcsPhoneFrame>
        <RcsCarouselPreview brouillon={brouillon} sansFond />
      </RcsPhoneFrame>

      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      <ListeManques manques={manques} testId="rcs-carrousel-manques" busy={busy} />
      <button
        type="button"
        onClick={() => void enregistrer()}
        disabled={!canSubmit}
        data-testid="rcs-carrousel-enregistrer"
        className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-600 disabled:opacity-60"
      >
        {busy ? t('Enregistrement…', 'Saving…') : initial ? t('Enregistrer les modifications', 'Save changes') : t('Créer le carrousel', 'Create carousel')}
      </button>
    </div>
  );
}
```

- [ ] **Étape 5 : réécrire `web/app/rcs-messages/page.tsx`**

```tsx
'use client';

import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import type { Session } from '@/lib/session';
import { listRcsMessages, deleteRcsMessage, listUserFields, type RcsMessage, type UserFieldDef } from '@/lib/api';
import { versBrouillonRcs, libelleFormatRcs, extraitRcs } from '@/lib/rcs';
import { versBrouillonCarrousel } from '@/lib/rcs-carrousel';
import { RcsMessageForm } from '@/components/RcsMessageForm';
import { RcsCarouselForm } from '@/components/RcsCarouselForm';
import { RcsPreview } from '@/components/RcsPreview';
import { RcsCarouselPreview } from '@/components/RcsCarouselPreview';
import { RcsPhoneFrame } from '@/components/RcsPhoneFrame';
import { useT } from '@/lib/i18n';

/**
 * Contenu > Messages RCS : la bibliothèque des messages réutilisables du canal RCS.
 *
 * 🔴 SUR LE DESSIN DE CONTENU > TEMPLATES DEPUIS LE 2026-09-21 (Julien : « il faut que ça ait vraiment la même
 * gueule que les écrans WhatsApp template »). Un tableau pour la liste, la création dans un encadré avec son
 * sélecteur « Message simple | Carrousel », le formulaire dans une carte blanche avec son aperçu dans un cadre
 * de téléphone, et ce qui manque nommé sous le bouton.
 *
 * Différence de fond avec les templates WhatsApp, et c'est ce qui change tout à l'usage : un message RCS n'est
 * soumis à PERSONNE. Pas de validation, pas d'attente. On écrit, on enregistre, on envoie.
 *
 * ⚠️ BASCULER DE FORMAT NE PERD RIEN : les deux formulaires restent montés pendant la création, seul l'affiché
 * compte. L'écran des templates démonte le formulaire quitté ; ici, une saisie ne disparaît pas parce qu'on a
 * regardé l'autre format.
 *
 * ⚠️ UNE MODIFICATION N'A PAS DE SÉLECTEUR, comme un template : un message s'ouvre dans le formulaire de son
 * format. Changer de format, c'est créer un autre message.
 */
export default function RcsMessagesPage() {
  return <AppShell active="rcs-messages">{(session) => <RcsMessagesInner session={session} />}</AppShell>;
}

type Format = 'simple' | 'carrousel';

function RcsMessagesInner({ session }: { session: Session }) {
  const t = useT();
  const [items, setItems] = useState<RcsMessage[]>([]);
  const [fields, setFields] = useState<UserFieldDef[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [format, setFormat] = useState<Format>('simple');
  const [editing, setEditing] = useState<RcsMessage | null>(null);
  const [preview, setPreview] = useState<RcsMessage | null>(null);
  // Une génération par ouverture : rouvrir « Créer » repart de formulaires vierges, sans la saisie d'une
  // création abandonnée (la clé des formulaires la porte).
  const [ouverture, setOuverture] = useState(0);

  const reload = useCallback(async () => {
    setError(null);
    try {
      const r = await listRcsMessages(session.tenantId);
      setItems(r.messages);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('Chargement impossible', 'Loading failed'));
    } finally {
      setLoading(false);
    }
  }, [session.tenantId, t]);

  useEffect(() => { void reload(); }, [reload]);
  // `?? []` : une réponse sans `fields` (route absente, câblage de test) mettrait `undefined` dans l'état, et
  // le rendu suivant planterait sur `.filter`. Même garde que partout ailleurs sur une liste distante.
  useEffect(() => { listUserFields(session.tenantId).then((r) => setFields(r.fields ?? [])).catch(() => {}); }, [session.tenantId]);

  function ouvrirCreation() {
    setEditing(null);
    setFormat('simple');
    setOuverture((n) => n + 1);
    setCreating(true);
  }
  function fermer() {
    setCreating(false);
    setEditing(null);
  }
  async function apresEnregistrement() {
    fermer();
    await reload();
  }

  async function supprimer(m: RcsMessage) {
    if (!window.confirm(t(`Supprimer « ${m.name} » ?`, `Delete "${m.name}"?`))) return;
    setError(null);
    try {
      await deleteRcsMessage(session.tenantId, m.id);
      if (editing?.id === m.id) setEditing(null);
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('Suppression impossible', 'Delete failed'));
    }
  }

  const simpleEdite = editing ? versBrouillonRcs(editing.content) : null;
  const carrouselEdite = editing ? versBrouillonCarrousel(editing.content) : null;

  return (
    <div className="space-y-6">
      {editing ? (
        <section className="rounded-2xl border border-brand-200 bg-brand-50/40 p-6 shadow-sm">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-base font-semibold tracking-tight text-ink-900">{t(`Modifier « ${editing.name} »`, `Edit “${editing.name}”`)}</h2>
            <button onClick={fermer} className="text-xs text-ink-400 hover:text-ink-700">{t('Fermer', 'Close')}</button>
          </div>
          {carrouselEdite ? (
            <RcsCarouselForm
              key={editing.id}
              tenantId={session.tenantId}
              fields={fields}
              initial={{ id: editing.id, name: editing.name, brouillon: carrouselEdite }}
              onSaved={() => void apresEnregistrement()}
            />
          ) : simpleEdite ? (
            <RcsMessageForm
              key={editing.id}
              tenantId={session.tenantId}
              fields={fields}
              initial={{ id: editing.id, name: editing.name, brouillon: simpleEdite }}
              onSaved={() => void apresEnregistrement()}
            />
          ) : null}
        </section>
      ) : creating ? (
        <section className="rounded-2xl border border-brand-200 bg-brand-50/40 p-6 shadow-sm">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-base font-semibold tracking-tight text-ink-900">{t('Nouveau message RCS', 'New RCS message')}</h2>
            <button onClick={fermer} className="text-xs text-ink-400 hover:text-ink-700">{t('Fermer', 'Close')}</button>
          </div>
          <div className="inline-flex gap-1 rounded-lg bg-ink-100 p-1 text-xs" role="group" aria-label={t('Format du message', 'Message format')}>
            {(['simple', 'carrousel'] as const).map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setFormat(f)}
                aria-pressed={format === f}
                data-testid={`rcs-format-${f}`}
                className={`rounded-md px-3 py-1 ${format === f ? 'bg-white font-medium text-brand-700 shadow-sm' : 'text-ink-500 hover:text-ink-800'}`}
              >
                {f === 'simple' ? t('Message simple', 'Simple message') : t('Carrousel', 'Carousel')}
              </button>
            ))}
          </div>
          <p className="mb-4 mt-2 text-xs text-ink-500">
            {t('Aucune validation : un message RCS part tel qu’il est écrit, sous votre agent de marque.', 'No approval: an RCS message goes out as written, under your brand agent.')}
          </p>
          <div className={format === 'simple' ? '' : 'hidden'}>
            <RcsMessageForm key={`simple-${ouverture}`} tenantId={session.tenantId} fields={fields} onSaved={() => void apresEnregistrement()} />
          </div>
          <div className={format === 'carrousel' ? '' : 'hidden'}>
            <RcsCarouselForm key={`carrousel-${ouverture}`} tenantId={session.tenantId} fields={fields} onSaved={() => void apresEnregistrement()} />
          </div>
        </section>
      ) : null}

      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-semibold tracking-tight text-ink-900">{t('Messages RCS', 'RCS messages')} ({items.length})</h2>
          <div className="flex items-center gap-3">
            <button onClick={() => void reload()} className="text-xs text-brand-600 hover:underline">{t('Rafraîchir', 'Refresh')}</button>
            {!creating && !editing && (
              <button
                onClick={ouvrirCreation}
                data-testid="rcs-message-new"
                className="rounded-lg bg-brand-500 px-3 py-1.5 text-sm font-semibold text-white transition hover:bg-brand-600"
              >
                {t('+ Créer un message', '+ Create a message')}
              </button>
            )}
          </div>
        </div>
        {error && <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        {loading ? (
          <p className="text-sm text-ink-500">{t('Chargement...', 'Loading...')}</p>
        ) : items.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-ink-300 bg-white px-4 py-10 text-center text-sm text-ink-500">
            {t('Aucun message. Clique « + Créer un message » : il part tel qu’il est écrit, sans validation.', 'No messages yet. Click “+ Create a message”: it goes out as written, with no approval.')}
          </div>
        ) : (
          <div className="overflow-x-auto rounded-2xl border border-ink-200 bg-white shadow-sm" data-testid="rcs-message-list">
            <table className="w-full min-w-[520px] text-sm">
              <thead className="bg-ink-50 text-left text-xs uppercase tracking-wide text-ink-500">
                <tr>
                  <th className="px-4 py-2.5 font-medium">{t('Nom', 'Name')}</th>
                  <th className="px-4 py-2.5 font-medium">{t('Format', 'Format')}</th>
                  <th className="px-4 py-2.5 font-medium">{t('Texte', 'Text')}</th>
                  <th className="px-4 py-2.5 text-right font-medium">{t('Actions', 'Actions')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {items.map((m) => {
                  const editable = versBrouillonRcs(m.content) !== null || versBrouillonCarrousel(m.content) !== null;
                  return (
                    <tr key={m.id} className="hover:bg-ink-50">
                      <td className="px-4 py-2.5">
                        <button
                          onClick={() => setPreview(m)}
                          disabled={m.content === null}
                          className="text-left text-sm font-medium text-brand-600 hover:underline disabled:text-ink-500 disabled:no-underline"
                          title={t("Voir l'aperçu", 'View preview')}
                        >
                          {m.name}
                        </button>
                      </td>
                      <td className="px-4 py-2.5 text-xs text-ink-500" data-testid={`rcs-message-format-${m.id}`}>{t(...libelleFormatRcs(m.content))}</td>
                      <td className="max-w-xs truncate px-4 py-2.5 text-xs text-ink-600">{extraitRcs(m.content)}</td>
                      <td className="px-4 py-2.5 text-right">
                        <div className="flex items-center justify-end gap-3 text-xs">
                          {editable ? (
                            <button
                              onClick={() => { setCreating(false); setEditing(m); }}
                              data-testid={`rcs-message-editer-${m.id}`}
                              className="font-medium text-brand-600 hover:text-brand-700"
                            >
                              {t('Éditer', 'Edit')}
                            </button>
                          ) : (
                            <span
                              className="text-ink-300"
                              title={m.content === null
                                ? t('Contenu illisible : il ne peut pas être ouvert ici.', 'Unreadable content: it cannot be opened here.')
                                : t('Une carte à titre (créée par l’API) ne s’édite pas ici.', 'A titled card (created through the API) cannot be edited here.')}
                            >
                              {t('Éditer', 'Edit')}
                            </span>
                          )}
                          <button onClick={() => void supprimer(m)} className="font-medium text-coral hover:text-red-700">{t('Supprimer', 'Delete')}</button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {preview && <ApercuMessage message={preview} onClose={() => setPreview(null)} />}
    </div>
  );
}

/** L'aperçu d'un message au clic sur son nom, dans le cadre de téléphone, comme un template. */
function ApercuMessage({ message, onClose }: { message: RcsMessage; onClose: () => void }) {
  const t = useT();
  const simple = versBrouillonRcs(message.content);
  const carrousel = versBrouillonCarrousel(message.content);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/30 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()} data-testid="rcs-message-apercu">
        <div className="mb-3 flex items-start justify-between">
          <div>
            <h3 className="text-sm font-semibold text-ink-900">{message.name}</h3>
            <p className="text-xs text-ink-400">{t(...libelleFormatRcs(message.content))}</p>
          </div>
          <button onClick={onClose} className="text-2xl leading-none text-ink-400 hover:text-ink-700" aria-label={t('Fermer', 'Close')}>×</button>
        </div>
        <RcsPhoneFrame>
          {carrousel ? (
            <RcsCarouselPreview brouillon={carrousel} sansFond />
          ) : simple ? (
            <RcsPreview brouillon={simple} sansFond />
          ) : (
            <p className="text-xs text-ink-500">{t('Ce format ne se dessine pas ici (carte à titre).', 'This format cannot be drawn here (titled card).')}</p>
          )}
        </RcsPhoneFrame>
      </div>
    </div>
  );
}
```

- [ ] **Étape 6 : faire passer les e2e**

Run: `cd web && npx playwright test e2e/rcs-carrousel.spec.ts e2e/rcs-messages.spec.ts`
Attendu : PASS, tous. 🔴 Si un cas EXISTANT de `rcs-messages.spec.ts` échoue, c'est le code qui a tort : ne pas
toucher au test, corriger le formulaire.

- [ ] **Étape 7 : types, lint, suite du front**

Run: `cd web && npx tsc --noEmit && npm run lint && npx vitest run`
Attendu : aucune erreur.

- [ ] **Étape 8 : commit**

```bash
git add web/components/RcsMessageForm.tsx web/components/RcsCarouselForm.tsx web/e2e/rcs-carrousel.spec.ts
git commit --only web/components/RcsMessageForm.tsx web/components/RcsCarouselForm.tsx web/app/rcs-messages/page.tsx web/e2e/rcs-carrousel.spec.ts web/e2e/rcs-messages.spec.ts -m "feat(rcs): l ecran Messages RCS sur le dessin des templates, avec le carrousel"
```

---

### Tâche 4 : les deux retouches voisines (Inbox, bloc de scénario)

La bibliothèque CONTIENT désormais des carrousels : deux écrans qui la lisent doivent le dire.

**Fichiers :**
- Modifier : `web/components/InboxRcsPanel.tsx`, `web/components/WorkflowConfigPanel.tsx`
- Tests : `web/e2e/inbox-envoi-rcs.spec.ts` (un message ajouté à `MESSAGES_RCS`, un cas ajouté),
  `web/e2e/workflow-rcs-node.spec.ts` (un paramètre optionnel à `mockBuilder`, un cas ajouté)

- [ ] **Étape 1 : écrire les deux cas qui échouent**

Dans `web/e2e/inbox-envoi-rcs.spec.ts`, ajouter à `MESSAGES_RCS` :

```ts
  {
    id: 'lib-2',
    name: 'Sélection rentrée',
    content: {
      kind: 'carousel',
      cards: [
        { title: 'Séjour à Nice', mediaUrl: 'https://exemple.test/a.png', mediaHeight: 'TALL' },
        { title: 'Séjour à Lyon', mediaUrl: 'https://exemple.test/b.png', mediaHeight: 'TALL' },
      ],
    },
    createdAt: '', updatedAt: '',
  },
```

et le cas :

```ts
  test('un carrousel de la bibliotheque se DESSINE avant de partir', async ({ page }) => {
    const envois: string[] = [];
    await mock(page, { windowOpen: false, envois });
    await ouvrirPanneau(page);
    await page.getByTestId('inbox-rcs-select').selectOption('lib-2');
    await expect(page.getByTestId('rcs-carrousel-apercu-carte-1')).toContainText('Séjour à Lyon');
    await page.getByTestId('inbox-rcs-send').click();
    await expect.poll(() => envois, { timeout: 10_000 }).toEqual(['lib-2']);
  });
```

Dans `web/e2e/workflow-rcs-node.spec.ts`, `mockBuilder` gagne un 4e paramètre `messagesRcs: unknown[] = []`
rendu par `if (url.includes('/rcs-messages')) return json({ messages: messagesRcs });`, et le cas :

```ts
  test('🔴 un carrousel enregistré est proposé GRISÉ, avec sa raison, au lieu d être caché', async ({ page }) => {
    await mockBuilder(page, BLOC_RCS, [], [{
      id: 'car-1', name: 'Sélection rentrée', createdAt: '', updatedAt: '',
      content: { kind: 'carousel', cards: [{ title: 'A', mediaUrl: 'https://exemple.test/a.png' }, { title: 'B', mediaUrl: 'https://exemple.test/b.png' }] },
    }]);
    await page.goto('/workflows?open=wf1');
    await page.locator('.react-flow__node').first().click();
    await page.getByTestId('rcs-node-source-bibliotheque').click();
    const option = page.getByTestId('rcs-node-library').locator('option', { hasText: 'Sélection rentrée' });
    await expect(option).toHaveCount(1);
    await expect(option).toBeDisabled();
    await expect(option).toContainText('pas encore dans un scénario');
  });
```

- [ ] **Étape 2 : vérifier qu'ils échouent**

Run: `cd web && npx playwright test e2e/inbox-envoi-rcs.spec.ts e2e/workflow-rcs-node.spec.ts`
Attendu : les deux cas neufs ÉCHOUENT, les autres PASSENT.

- [ ] **Étape 3 : `InboxRcsPanel`** : importer `versBrouillonCarrousel` et `RcsCarouselPreview`, calculer
`const carrousel = sel ? versBrouillonCarrousel(sel.content) : null;` à côté de `brouillon`, et remplacer le
bloc d'aperçu par :

```tsx
        {sel && !libre && (
          <div className="mt-3">
            {brouillon || carrousel ? (
              <>
                {brouillon ? <RcsPreview brouillon={brouillon} /> : <RcsCarouselPreview brouillon={carrousel!} />}
                <p className="mt-1 text-[11px] text-ink-400">
                  {t('Les variables {{champ}} seront remplacées par la fiche de ce contact à l’envoi.', 'The {{field}} variables will be filled in from this contact at send time.')}
                </p>
              </>
            ) : (
              <p className="text-xs text-amber-700">
                {t('Ce message a un format que l’aperçu ne sait pas dessiner (carte à titre). Il partira tel qu’il a été enregistré.', 'This message has a format the preview cannot draw (titled card). It will go out as saved.')}
              </p>
            )}
          </div>
        )}
```

- [ ] **Étape 4 : `WorkflowConfigPanel`** : sous les options éditables du sélecteur `rcs-node-library`, ajouter
les carrousels GRISÉS, avec un commentaire qui dit pourquoi :

```tsx
                {/* 🔴 GRISÉS AVEC LEUR RAISON, JAMAIS CACHÉS : le produit ne fait pas disparaître une option
                    indisponible. Un carrousel dans un parcours pose la question de ses SORTIES (une par bouton de
                    chaque carte) : c'est le lot 3 de la spec du 2026-09-21, pas encore construit. */}
                {rcsMessages.filter((m) => m.content?.kind === 'carousel').map((m) => (
                  <option key={m.id} value={m.id} disabled>{m.name} {t('(carrousel : pas encore dans un scénario)', '(carousel: not yet in a scenario)')}</option>
                ))}
```

- [ ] **Étape 5 : faire passer**

Run: `cd web && npx playwright test e2e/inbox-envoi-rcs.spec.ts e2e/workflow-rcs-node.spec.ts && npx tsc --noEmit && npm run lint`
Attendu : PASS, aucune erreur.

- [ ] **Étape 6 : commit**

```bash
git commit --only web/components/InboxRcsPanel.tsx web/components/WorkflowConfigPanel.tsx web/e2e/inbox-envoi-rcs.spec.ts web/e2e/workflow-rcs-node.spec.ts -m "feat(rcs): l Inbox dessine un carrousel, le bloc de scenario le grise avec sa raison"
```

### Clôture du lot 1

- [ ] Suites complètes : `npx vitest run` (racine), `cd web && npx vitest run && npx playwright test`.
- [ ] Captures côte à côte des deux écrans (Templates et Messages RCS : liste, création simple, création
  carrousel), montrées à Julien. Ses retours se corrigent AVANT le push.
- [ ] `/revue` du lot, section « rayon de souffle » comprise (qui d'autre lit `RcsPreview`, `ChampImageHebergee`,
  `TemplateForm` ?), corriger les 🔴 ET les 🟡.
- [ ] Push `origin main`, puis `gh run list` et `gh run view <id> --json jobs`, job par job.

---

# LOT 2 : un carrousel dans l'assistant de campagne

### Tâche 5 : la logique pure (création, chaîne, brouillon)

**Fichiers :**
- Modifier : `web/lib/campagne-creation.ts`, `web/lib/campagne-chaine.ts`, `web/lib/campagne-brouillon.ts`
- Tests : `web/lib/campagne-creation.test.ts`, `web/lib/campagne-chaine.test.ts`, `web/lib/campagne-brouillon.test.ts`

**Interfaces produites :** le champ `carrouselRcs?: CarrouselRcs` dans `EtatPourCreation.contenus`,
`ContenuMinimal` (`carrouselRcs?: unknown`) et `ContenuBrouillon`.

- [ ] **Étape 1 : écrire les tests qui échouent**

À la fin de `web/lib/campagne-creation.test.ts` (ajouter `import type { CarrouselRcs } from './rcs-carrousel';`
en tête) :

```ts
/**
 * UN CARROUSEL SUR UN ÉTAGE RCS (spec du 2026-09-21).
 *
 * 🔴 CE QUI SE VÉRIFIE ICI EST CE QUI PART. L'écran masque le texte quand un carrousel est posé ; masquer
 * n'efface pas, et le texte resté en mémoire ne doit JAMAIS partir à sa place, ni bloquer le lancement.
 */
describe('un carrousel sur un etage RCS', () => {
  const CARROUSEL: CarrouselRcs = {
    kind: 'carousel',
    cards: [
      { title: 'Nice', mediaUrl: 'https://exemple.fr/a.jpg', mediaHeight: 'TALL' },
      { title: 'Lyon', mediaUrl: 'https://exemple.fr/b.jpg', mediaHeight: 'TALL' },
    ],
  };
  const CHAINE_RCS: EtageAssistant[] = [{ rang: 1, canal: 'rcs' }, { rang: 2, canal: 'whatsapp' }];
  const avecRcs = (rcs: Record<string, unknown>): EtatPourCreation => ({
    ...ETAT,
    contenus: {
      1: { formule: 'seul', devenir: 'inbox', suggestions: [], ...rcs },
      2: { formule: 'seul', devenir: 'inbox', templateName: 'promo', templateLanguage: 'fr', suggestions: [] },
    },
  });

  it('au rang 1, c est le carrousel qui part, jamais le texte masque', () => {
    const e = entreeDeCreation(avecRcs({ texteRcs: 'masque', imageRcs: 'https://exemple.fr/v.jpg', carrouselRcs: CARROUSEL }), CHAINE_RCS, CTX);
    expect(e.rcsMessage).toEqual(CARROUSEL);
  });

  it('en repli aussi, c est le carrousel qui part', () => {
    const etat: EtatPourCreation = {
      ...ETAT,
      contenus: { ...ETAT.contenus, 2: { formule: 'seul', devenir: 'inbox', texteRcs: 'masque', suggestions: [], carrouselRcs: CARROUSEL } },
    };
    expect(entreeDeCreation(etat, CHAINE, CTX).chaine?.[1]?.rcsMessage).toEqual(CARROUSEL);
  });

  // 🔴 L'AUTRE SENS : retiré, le carrousel ne laisse rien derrière lui, et le texte repart.
  it('carrousel retire, le texte repart', () => {
    const e = entreeDeCreation(avecRcs({ texteRcs: 'coucou', carrouselRcs: undefined }), CHAINE_RCS, CTX);
    expect(e.rcsMessage).toEqual({ kind: 'text', text: 'coucou' });
  });

  it('un etage porteur d un carrousel se lance sans texte, et ce qu il cache ne le bloque pas', () => {
    expect(problemeAvantLancement(avecRcs({ carrouselRcs: CARROUSEL }), CHAINE_RCS, CTX)).toBeNull();
    expect(problemeAvantLancement(avecRcs({
      carrouselRcs: CARROUSEL,
      texteRcs: 'a'.repeat(5000),
      suggestions: [{ kind: 'openUrl', text: 'Voir', url: '', postbackData: 'p' }],
    }), CHAINE_RCS, CTX)).toBeNull();
    // Sans le carrousel, le même étage vide reste refusé : la garde n'a pas été retirée.
    expect(problemeAvantLancement(avecRcs({}), CHAINE_RCS, CTX)).toMatch(/pas de message RCS/);
  });
});
```

À la fin de `web/lib/campagne-chaine.test.ts` :

```ts
describe('un etage RCS porteur d un carrousel', () => {
  it('est renseigne, meme sans texte ; retire, il ne l est plus', () => {
    expect(etageRenseigne('rcs', { formule: 'seul', carrouselRcs: { kind: 'carousel', cards: [] } })).toBe(true);
    expect(etageRenseigne('rcs', { formule: 'seul', carrouselRcs: undefined })).toBe(false);
  });
});
```

À la fin de `web/lib/campagne-brouillon.test.ts` :

```ts
describe('un carrousel copie sur un etage RCS', () => {
  const CARROUSEL = {
    kind: 'carousel' as const,
    cards: [
      { title: 'Nice', mediaUrl: 'https://exemple.fr/a.jpg', mediaHeight: 'TALL' as const, suggestions: [{ kind: 'reply' as const, text: 'Oui', postbackData: 'p' }] },
      { title: 'Lyon', mediaUrl: 'https://exemple.fr/b.jpg', mediaHeight: 'TALL' as const },
    ],
  };

  it('survit a l aller-retour d un brouillon, JSON compris', () => {
    const etat: EtatBrouillon = { ...ETAT, contenus: { 2: { formule: 'seul', devenir: 'inbox', suggestions: [], carrouselRcs: CARROUSEL } } };
    const relu = etatDeBrouillon(JSON.parse(JSON.stringify(brouillonDeLEtat(etat))));
    expect(relu.contenus?.[2]?.carrouselRcs).toEqual(CARROUSEL);
  });

  // 🔴 JETÉ, JAMAIS RÉPARÉ : une copie figée qu'on ne peut pas éditer ici ne se devine pas.
  it('mal forme, il est JETE, et le reste de l etage survit', () => {
    const relu = etatDeBrouillon({
      assistant: 1,
      contenus: { 2: { formule: 'seul', devenir: 'inbox', texteRcs: 'coucou', carrouselRcs: { kind: 'carousel', cards: [{ title: 'seule' }] } } },
    });
    expect(relu.contenus?.[2]?.carrouselRcs).toBeUndefined();
    expect(relu.contenus?.[2]?.texteRcs).toBe('coucou');
  });
});
```

- [ ] **Étape 2 : vérifier qu'ils échouent**

Run: `cd web && npx vitest run lib/campagne-creation.test.ts lib/campagne-chaine.test.ts lib/campagne-brouillon.test.ts`
Attendu : ÉCHECS sur les cas neufs (le carrousel ne part pas, l'étage n'est pas renseigné, le brouillon le perd),
et des erreurs de type sur `carrouselRcs`.

- [ ] **Étape 3 : `web/lib/campagne-creation.ts`**

Import : `import type { CarrouselRcs } from './rcs-carrousel';`

Dans `EtatPourCreation.contenus`, sous `imageRcs?: string;` :

```ts
    /**
     * LE CARROUSEL DE LA BIBLIOTHÈQUE COPIÉ SUR CET ÉTAGE. Présent, c'est LUI qui part ; le texte, le visuel et
     * les suggestions restent en mémoire pour le retour arrière mais ne partent pas. Cf. `ContenuEtage.carrouselRcs`.
     */
    carrouselRcs?: CarrouselRcs;
```

Dans `problemeAvantLancement`, juste avant la garde « n'a pas de message RCS » :

```ts
    /**
     * 🔴 UN ÉTAGE PORTEUR D'UN CARROUSEL N'A PAS DE TEXTE À VÉRIFIER : c'est le carrousel qui part, validé par le
     * serveur à son enregistrement en bibliothèque, puis relu strictement à la reprise d'un brouillon
     * (`carrouselDepuis`). Lui demander un texte refuserait un étage rempli ; vérifier le texte qu'il cache
     * bloquerait le lancement sur ce qui ne part pas.
     */
    const carrousel = etage.canal === 'rcs' ? c?.carrouselRcs : undefined;
```

puis ajouter `!carrousel &&` en tête des TROIS conditions RCS qui suivent (texte absent, texte trop long, bouton
incomplet), par exemple :

```ts
    if (etage.canal === 'rcs' && !carrousel && !c?.texteRcs?.trim()) {
```

Dans `messageRcs`, en première ligne :

```ts
  // 🔴 LE CARROUSEL D'ABORD, ET ALORS LUI SEUL. Le texte masqué derrière lui ne part JAMAIS : ce qu'on cache à
  // l'écran doit être exactement ce qu'on n'envoie pas (même motif que `reessayer`, `assignation`, `devenir`).
  if (c?.carrouselRcs) return c.carrouselRcs;
```

- [ ] **Étape 4 : `web/lib/campagne-chaine.ts`**

Dans `ContenuMinimal`, sous `texteRcs` :

```ts
  /** Cf. `ContenuEtage.carrouselRcs`. Présent = l'étage RCS a de quoi partir, même sans texte. */
  carrouselRcs?: unknown;
```

Dans `etageRenseigne` :

```ts
  if (canal === 'rcs') return contenu.carrouselRcs !== undefined || (contenu.texteRcs ?? '').trim() !== '';
```

- [ ] **Étape 5 : `web/lib/campagne-brouillon.ts`**

Import : `import { carrouselDepuis, type CarrouselRcs } from './rcs-carrousel';`

Dans `ContenuBrouillon`, sous `imageRcs?: string;` :

```ts
  /** Cf. `ContenuEtage.carrouselRcs`. Relu STRICTEMENT (`carrouselDepuis`) : mal formé, il est jeté. */
  carrouselRcs?: CarrouselRcs;
```

Dans `contenuDe`, avant le `return` :

```ts
  // 🔴 UN CARROUSEL MAL FORMÉ EST JETÉ, JAMAIS RÉPARÉ : c'est une copie figée qu'on ne peut pas éditer dans
  // l'assistant, la « réparer » enverrait un message que personne n'a relu. L'étage redevient vide, et le
  // récapitulatif le dit.
  const carrousel = carrouselDepuis(o.carrouselRcs);
```

et dans l'objet rendu, sous la ligne de `imageRcs` :

```ts
    ...(carrousel ? { carrouselRcs: carrousel } : {}),
```

- [ ] **Étape 6 : faire passer**

Run: `cd web && npx vitest run && npx tsc --noEmit`
Attendu : PASS, aucune erreur (`ContenuEtage` n'a pas encore le champ : si `tsc` le réclame, c'est la tâche 6 qui
le pose, les deux se font d'affilée).

- [ ] **Étape 7 : vérifier dans l'autre sens** : retirer temporairement la ligne `if (c?.carrouselRcs) return
c.carrouselRcs;` ; le cas « c est le carrousel qui part, jamais le texte masque » doit ÉCHOUER en montrant le
texte masqué dans `rcsMessage`. Restaurer.

- [ ] **Étape 8 : commit**

```bash
git commit --only web/lib/campagne-creation.ts web/lib/campagne-chaine.ts web/lib/campagne-brouillon.ts web/lib/campagne-creation.test.ts web/lib/campagne-chaine.test.ts web/lib/campagne-brouillon.test.ts -m "feat(campagne): un etage RCS porte un carrousel copie, et c est lui qui part"
```

### Tâche 6 : l'écran de l'assistant

**Fichiers :**
- Modifier : `web/components/campagne/AssistantCampagne.tsx` (le champ de `ContenuEtage`),
  `web/components/campagne/EtapeContenu.tsx` (`CadreRcs`)
- Test : `web/e2e/campagne-assistant-rcs.spec.ts`

- [ ] **Étape 1 : écrire les cas qui échouent** : dans `web/e2e/campagne-assistant-rcs.spec.ts`, le
carrousel de `MESSAGES_RCS` devient valide :

```ts
  {
    id: 'm2', name: 'Carrousel promo', createdAt: '', updatedAt: '',
    content: {
      kind: 'carousel',
      cards: [
        { title: 'Nice', mediaUrl: 'https://exemple.test/a.jpg', mediaHeight: 'TALL' },
        { title: 'Lyon', mediaUrl: 'https://exemple.test/b.jpg', mediaHeight: 'TALL' },
      ],
    },
  },
```

le cas « un carrousel enregistré n'est PAS proposé » est REMPLACÉ (la règle a changé, le cas qu'il exerçait,
« ce qui est proposé », est conservé dans les deux sens) par :

```ts
  /**
   * 🔴 UN CARROUSEL ENREGISTRÉ EST PROPOSÉ DEPUIS LE 2026-09-21, ET C'EST LUI QUI PART. Il se pose en ENTIER,
   * en copie figée : l'assistant ne l'édite pas, il le montre. Le texte masqué derrière lui ne part pas.
   */
  test('🔴 un carrousel enregistré est proposé, se dessine, et c est LUI qui part', async ({ page }) => {
    const f = await poserFaux(page, { rcsMessages: MESSAGES_RCS });
    await surLEtageRcs(page);
    const select = page.getByTestId('rcs-bibliotheque-1');
    await expect(select.locator('option', { hasText: 'Carrousel promo (carrousel)' })).toHaveCount(1);
    await page.getByTestId('rcs-texte').fill('texte masqué');
    await select.selectOption('m2');
    await expect(page.getByTestId('rcs-carrousel-apercu-carte-1')).toContainText('Lyon');
    await expect(page.getByTestId('rcs-texte')).toHaveCount(0);
    await lancer(page);
    await expect.poll(() => f.creations.length, { timeout: 15_000 }).toBe(1);
    expect(f.creations[0]!.rcsMessage).toEqual(MESSAGES_RCS[1]!.content);
  });

  test('« Revenir à un message simple » rend le texte saisi, et c est lui qui part', async ({ page }) => {
    const f = await poserFaux(page, { rcsMessages: MESSAGES_RCS });
    await surLEtageRcs(page);
    await page.getByTestId('rcs-texte').fill('Bonjour');
    await page.getByTestId('rcs-bibliotheque-1').selectOption('m2');
    await page.getByTestId('rcs-carrousel-retirer-1').click();
    await expect(page.getByTestId('rcs-texte')).toHaveText('Bonjour');
    await lancer(page);
    await expect.poll(() => f.creations.length, { timeout: 15_000 }).toBe(1);
    expect(f.creations[0]!.rcsMessage).toMatchObject({ kind: 'text', text: 'Bonjour' });
  });

  test('🔴 à 1280 px, l étage portant un carrousel ne déborde pas', async ({ page }) => {
    await page.setViewportSize(TREIZE_POUCES);
    await poserFaux(page, { rcsMessages: MESSAGES_RCS });
    await surLEtageRcs(page);
    await page.getByTestId('rcs-bibliotheque-1').selectOption('m2');
    await expect(page.getByTestId('rcs-carrousel-apercu')).toBeVisible();
    await pasDeDebordement(page);
  });
```

⚠️ `rcs-texte` est l'éditeur à variables : `toHaveText` sur la zone éditable, comme les autres cas du dépôt.

- [ ] **Étape 2 : vérifier qu'ils échouent**

Run: `cd web && npx playwright test e2e/campagne-assistant-rcs.spec.ts`
Attendu : les trois cas neufs ÉCHOUENT, les autres PASSENT.

- [ ] **Étape 3 : `ContenuEtage`** : dans `AssistantCampagne.tsx`, importer
`import type { CarrouselRcs } from '@/lib/rcs-carrousel';` et, sous `imageRcs?: string;` :

```ts
  /**
   * LE CARROUSEL CHOISI DANS LA BIBLIOTHÈQUE, COPIÉ EN ENTIER SUR L'ÉTAGE (spec du 2026-09-21).
   *
   * 🔴 PRÉSENT, C'EST LUI QUI PART, ET RIEN D'AUTRE. `texteRcs`, `imageRcs` et `suggestions` restent en mémoire
   * pour « Revenir à un message simple », mais ne partent pas : ce qu'on cache doit être exactement ce qu'on
   * n'envoie pas (`messageRcs`, `campagne-creation.ts`).
   *
   * ⚠️ UNE COPIE, JAMAIS UN LIEN, comme un message simple : modifier la bibliothèque ensuite ne réécrit pas une
   * campagne. Pour le changer, on le modifie dans Contenu > Messages RCS, puis on le choisit à nouveau.
   */
  carrouselRcs?: CarrouselRcs;
```

- [ ] **Étape 4 : `CadreRcs`** : importer `versBrouillonCarrousel` (`@/lib/rcs-carrousel`),
`RcsCarouselPreview` et `RcsPhoneFrame`. En tête du composant :

```tsx
  const carrousel = contenu.carrouselRcs ? versBrouillonCarrousel(contenu.carrouselRcs) : null;
```

Le sélecteur de la bibliothèque devient :

```tsx
      {/*
        ⚠️ PARTIR D'UN MESSAGE ENREGISTRÉ fait une COPIE, jamais un lien : modifier la bibliothèque ensuite ne
        réécrit pas une campagne déjà partie. Un message simple se recopie dans les trois champs de ce cadre ;
        un CARROUSEL se pose EN ENTIER (`carrouselRcs`), parce que trois champs ne savent pas porter plusieurs
        cartes. La carte à titre, que ce composeur ne sait pas éditer, n'est toujours pas proposée.
      */}
      <Selecteur
        libelle="Partir d’un message enregistré"
        testId={`rcs-bibliotheque-${rang}`}
        valeur=""
        onChange={(id) => {
          const c = references.messagesRcs.find((m) => m.id === id)?.content ?? null;
          if (c?.kind === 'carousel') {
            onChange({ carrouselRcs: c });
            return;
          }
          const b = versBrouillonRcs(c);
          // ⚠️ UN SEUL PATCH : trois appels de suite partiraient du même état de rendu. Et choisir un message
          // simple RETIRE le carrousel, sans quoi il continuerait de partir à la place de ce qu'on vient de choisir.
          if (b) onChange({ texteRcs: b.text, imageRcs: b.imageUrl, suggestions: b.suggestions, carrouselRcs: undefined });
        }}
        options={references.messagesRcs
          .filter((m) => versBrouillonRcs(m.content) !== null || m.content?.kind === 'carousel')
          .map((m) => ({ valeur: m.id, libelle: m.content?.kind === 'carousel' ? `${m.name} (carrousel)` : m.name }))}
        vide="Aucun message RCS enregistré sur cet espace."
      />
```

et le bloc Visuel / Message / Suggestions s'enveloppe :

```tsx
      {carrousel ? (
        <div className="space-y-2" data-testid={`rcs-carrousel-etage-${rang}`}>
          <RcsPhoneFrame>
            <RcsCarouselPreview brouillon={carrousel} sansFond />
          </RcsPhoneFrame>
          <p className="text-[11px] text-ink-500">
            {'Copié depuis la bibliothèque : pour le modifier, modifiez-le dans Contenu > Messages RCS, puis choisissez-le à nouveau ici.'}
          </p>
          <button
            type="button"
            onClick={() => onChange({ carrouselRcs: undefined })}
            data-testid={`rcs-carrousel-retirer-${rang}`}
            className="text-xs text-brand-600 hover:underline"
          >
            Revenir à un message simple
          </button>
        </div>
      ) : (
        <>
          {/* ... les blocs Visuel, Message et Suggestions existants, INCHANGÉS ... */}
        </>
      )}
```

- [ ] **Étape 5 : faire passer**

Run: `cd web && npx playwright test e2e/campagne-assistant-rcs.spec.ts && npx tsc --noEmit && npm run lint && npx vitest run`
Attendu : PASS, aucune erreur.

- [ ] **Étape 6 : commit**

```bash
git commit --only web/components/campagne/AssistantCampagne.tsx web/components/campagne/EtapeContenu.tsx web/e2e/campagne-assistant-rcs.spec.ts -m "feat(campagne): choisir un carrousel RCS dans l assistant, en copie figee"
```

### Tâche 7 : la documentation, et la clôture

**Fichiers :** `features.md`, `documentation.md`, `todo.md`, `docs/aide/fiches/lancer-une-campagne.md`

- [ ] `features.md`, chapitre « Canal RCS » : la puce « Bibliothèque » dit le tableau, les deux formats, le
  carrousel (2 à 10 cartes, visuel ou titre, texte, 4 boutons par carte), « Il manque » et l'aperçu au clic ;
  la puce « En campagne » dit qu'on peut partir d'un carrousel, en copie figée ; une puce dit que le bloc de
  scénario ne sait pas encore envoyer un carrousel (grisé avec sa raison).
- [ ] `documentation.md`, table des modules partagés : une ligne `web/lib/rcs-carrousel.ts` (le carrousel côté
  écran, sa relecture STRICTE des brouillons, testé contre le schéma serveur par la suite racine).
- [ ] `todo.md` : une entrée 🟡 « Un carrousel RCS dans un scénario (lot 3 de la spec du 2026-09-21) », avec les
  trois pièces de la spec (message entier dans le bloc, une sortie par bouton Réponse de chaque carte,
  `normaliserPostbacks` en `card:<i>:btn:<j>`).
- [ ] `docs/aide/fiches/lancer-une-campagne.md` : une phrase, sur un étage RCS on peut partir d'un carrousel
  enregistré.
- [ ] Suites complètes (racine, front, e2e), `/revue` du lot 2, push, CI job par job.
- [ ] Commit docs : `git commit --only features.md documentation.md todo.md docs/aide/fiches/lancer-une-campagne.md -m "docs(rcs): le carrousel, dans la bibliotheque et l assistant de campagne"`
- [ ] Demander à Julien l'essai réel (section « Méthode de livraison »).
