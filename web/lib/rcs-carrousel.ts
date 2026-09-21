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
const SANS_BORNE = Number.MAX_SAFE_INTEGER;

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
