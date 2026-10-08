import type { NomIcone } from './icones';

/**
 * LES MESSAGES INTERACTIFS DE L'AGENT DE META, côté console : les neuf composants, leur nom, leur icône, leur phrase
 * d'aide et le canevas qui pré-remplit leur fiche. Spec : `docs/superpowers/specs/2026-10-07-messages-interactifs-design.md`.
 *
 * ⚠️ LA LISTE DES TYPES EST DUPLIQUÉE du serveur (`src/mba/messages-interactifs.ts`), délibérément, comme
 * `web/lib/mba-skills.ts` : les deux builds ne partagent aucun module. `tests/web-messages-interactifs.test.ts` casse
 * dès que les deux listes divergent. Le titre suit la règle des consignes (`slugSkillTitle`, `web/lib/mba-skills.ts`) :
 * Meta exige un slug (mesuré le 2026-10-07).
 */

export const TYPES_MESSAGE_INTERACTIF = [
  'interactive_reply_buttons',
  'interactive_list',
  'cta_url',
  'flow',
  'image',
  'location',
  'location_request',
  'carousel_url',
  'carousel_quick_reply',
] as const;
export type TypeMessageInteractif = (typeof TYPES_MESSAGE_INTERACTIF)[number];

/** La borne de Meta sur la consigne, comptée en OCTETS UTF-8 comme Meta la compte (un « é » en vaut deux). */
export const CONSIGNE_MESSAGE_MAX = 20_000;
export const octets = (s: string): number => new TextEncoder().encode(s).length;

type Paire = readonly [string, string];

export interface FicheType {
  nom: Paire;
  /** Ce que le composant fait, en une phrase, sous son nom dans la grille. */
  aide: Paire;
  icone: NomIcone;
  /** Le contenu pré-rempli, sans la ligne « Quand » (elle a son champ dans la fiche). */
  canevas: Paire;
  /** Un titre de départ, déjà en slug. */
  titre: string;
}

/** `Record` EXHAUSTIF : un type sans nom, sans icône ou sans canevas ne compile pas. */
export const TYPES: Record<TypeMessageInteractif, FicheType> = {
  interactive_reply_buttons: {
    nom: ['Boutons de réponse', 'Reply buttons'],
    aide: ['Jusqu’à trois boutons : le libellé touché revient à l’agent.', 'Up to three buttons: the tapped label goes back to the agent.'],
    icone: 'reponse',
    canevas: [
      'Texte du message (1 à 1 024 caractères) :\nBoutons (1 à 3, 20 caractères chacun, tous différents) :',
      'Message text (1 to 1,024 characters):\nButtons (1 to 3, 20 characters each, all different):',
    ],
    titre: 'boutons-de-reponse',
  },
  interactive_list: {
    nom: ['Liste de choix', 'List of choices'],
    aide: ['Un bouton qui ouvre jusqu’à dix lignes à choisir.', 'A button that opens up to ten rows to pick from.'],
    icone: 'liste',
    canevas: [
      'Texte du message (1 à 4 096 caractères) :\nTexte du bouton qui ouvre la liste (1 à 20 caractères) :\nLignes (1 à 10) : pour chacune, un identifiant stable (188 caractères au plus), un titre (24 au plus), une description facultative (72 au plus)',
      'Message text (1 to 4,096 characters):\nText of the button that opens the list (1 to 20 characters):\nRows (1 to 10): for each, a stable identifier (up to 188 characters), a title (up to 24), an optional description (up to 72)',
    ],
    titre: 'liste-de-choix',
  },
  cta_url: {
    nom: ['Bouton lien', 'Link button'],
    aide: ['Un bouton qui ouvre une page : paiement, réservation, lien profond.', 'A button that opens a page: payment, booking, deep link.'],
    icone: 'lien',
    canevas: [
      'Texte du message (1 à 1 024 caractères) :\nLibellé du bouton (1 à 20 caractères) :\nAdresse ouverte (https) :\nFacultatif : image ou vidéo d’en-tête (adresse https), pied de message (1 à 60 caractères)',
      'Message text (1 to 1,024 characters):\nButton label (1 to 20 characters):\nAddress opened (https):\nOptional: header image or video (https address), footer (1 to 60 characters)',
    ],
    titre: 'bouton-lien',
  },
  flow: {
    nom: ['Formulaire', 'Form'],
    aide: ['Ouvre l’un de vos formulaires publiés : check-in, prise de dates.', 'Opens one of your published forms: check-in, picking dates.'],
    icone: 'formulaire',
    canevas: [
      'Texte du message (ce que le client fera après avoir touché le bouton) :\nLibellé du bouton (20 caractères au plus) :\nFacultatif : les valeurs qui pré-remplissent le premier écran du formulaire',
      'Message text (what the customer will do after tapping the button):\nButton label (up to 20 characters):\nOptional: the values that pre-fill the form’s first screen',
    ],
    titre: 'formulaire',
  },
  image: {
    nom: ['Image', 'Image'],
    aide: ['Une image, avec sa légende.', 'An image, with its caption.'],
    icone: 'image',
    canevas: [
      'L’image : son adresse publique (une photo JPEG ou PNG), ou l’identifiant d’une image déjà téléversée\nFacultatif : la légende',
      'The image: its public address (a JPEG or PNG photo), or the identifier of an already uploaded image\nOptional: the caption',
    ],
    titre: 'image',
  },
  location: {
    nom: ['Lieu', 'Location'],
    aide: ['Une épingle sur la carte : une boutique, un point de rendez-vous.', 'A pin on the map: a shop, a meeting point.'],
    icone: 'position',
    canevas: [
      'Latitude (-90 à 90) et longitude (-180 à 180) du lieu :\nFacultatif : le nom du lieu, l’adresse',
      'Latitude (-90 to 90) and longitude (-180 to 180) of the place:\nOptional: the place name, the address',
    ],
    titre: 'lieu',
  },
  location_request: {
    nom: ['Demande de position', 'Location request'],
    aide: ['Un bouton pour que le client partage sa position.', 'A button for the customer to share their location.'],
    icone: 'localiser',
    canevas: ['Texte du message (1 à 1 024 caractères) :', 'Message text (1 to 1,024 characters):'],
    titre: 'demande-de-position',
  },
  carousel_url: {
    nom: ['Carrousel à liens', 'Link carousel'],
    aide: ['Deux à dix cartes avec image, chacune ouvre une page.', 'Two to ten cards with images, each opens a page.'],
    icone: 'carrousel',
    canevas: [
      'Texte du message (1 à 1 024 caractères) :\nCartes (2 à 10) : pour chacune, une image (adresse), un texte (1 à 160 caractères), l’adresse du bouton, le libellé du bouton (1 à 20 caractères)',
      'Message text (1 to 1,024 characters):\nCards (2 to 10): for each, an image (address), a text (1 to 160 characters), the button address, the button label (1 to 20 characters)',
    ],
    titre: 'carrousel-liens',
  },
  carousel_quick_reply: {
    nom: ['Carrousel à réponses', 'Reply carousel'],
    aide: ['Deux à dix cartes avec image : le choix revient à l’agent.', 'Two to ten cards with images: the choice goes back to the agent.'],
    icone: 'carrousel',
    canevas: [
      'Texte du message (1 à 1 024 caractères) :\nCartes (2 à 10) : pour chacune, une image (adresse), un texte (1 à 160 caractères), le libellé du bouton (1 à 20 caractères)',
      'Message text (1 to 1,024 characters):\nCards (2 to 10): for each, an image (address), a text (1 to 160 characters), the button label (1 to 20 characters)',
    ],
    titre: 'carrousel-reponses',
  },
};

export function estTypeMessageInteractif(v: unknown): v is TypeMessageInteractif {
  return typeof v === 'string' && (TYPES_MESSAGE_INTERACTIF as readonly string[]).includes(v);
}

/** Les deux préfixes écrits par la console, selon sa langue. */
const PREFIXES_QUAND = ['Quand : ', 'When: '] as const;
/** Ce qui est RECONNU à la relecture : aussi « quand: » ou « When : », qu'un modèle peut écrire. */
const LIGNE_QUAND = /^(quand|when)\s*:\s*/i;

/**
 * La consigne envoyée à Meta : « Quand : <la situation> » sur la première ligne, puis le contenu. C'est la forme que
 * Meta met en avant (la consigne dit à la fois QUAND envoyer et QUOI mettre), et celle que l'assistant écrit aussi.
 */
export function composerConsigne(quand: string, contenu: string, langue: 'fr' | 'en' = 'fr'): string {
  const q = quand.trim().replace(/\s*\n\s*/g, ' ');
  const c = contenu.trim();
  if (q === '') return c;
  return `${langue === 'en' ? PREFIXES_QUAND[1] : PREFIXES_QUAND[0]}${q}\n${c}`;
}

/**
 * L'inverse, pour rouvrir une fiche. Une consigne qui ne commence pas par l'un des préfixes (écrite à la main dans un
 * autre outil, ou ancienne) va ENTIÈRE dans le contenu : la couper au hasard perdrait ce qu'elle dit.
 */
export function separerConsigne(consigne: string): { quand: string; contenu: string } {
  const m = LIGNE_QUAND.exec(consigne);
  if (m === null) return { quand: '', contenu: consigne };
  const fin = consigne.indexOf('\n');
  return fin === -1
    ? { quand: consigne.slice(m[0].length).trim(), contenu: '' }
    : { quand: consigne.slice(m[0].length, fin).trim(), contenu: consigne.slice(fin + 1) };
}
