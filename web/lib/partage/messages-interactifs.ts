/**
 * LE CONTRAT PUR DES MESSAGES INTERACTIFS DE L'AGENT DE META, partagé par le serveur, son assistant et la console.
 * Il ne porte ni Zod, ni React, ni libellé d'écran : seulement les types et règles que les trois chemins appliquent.
 */

/** Les neuf composants, dans l'ordre de la grille de la console. */
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

/** Bornes mesurées chez Meta. La consigne et le titre sont comptés en octets UTF-8. */
export const TITRE_MESSAGE_INTERACTIF_MAX = 64;
export const CONSIGNE_MESSAGE_MAX = 20_000;

/** Minuscules, chiffres et tirets, sans tiret au début ni à la fin. */
export const TITRE_MESSAGE_INTERACTIF_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Identifiant Meta d'un formulaire WhatsApp. */
export const ID_FORMULAIRE_MESSAGE_RE = /^\d{1,20}$/;

const ENCODEUR_UTF8 = new TextEncoder();

export function octetsUtf8(texte: string): number {
  return ENCODEUR_UTF8.encode(texte).length;
}

export function estTypeMessageInteractif(v: unknown): v is TypeMessageInteractif {
  return typeof v === 'string' && (TYPES_MESSAGE_INTERACTIF as readonly string[]).includes(v);
}

export function titreMessageInteractifValide(titre: string): boolean {
  return titre !== ''
    && octetsUtf8(titre) <= TITRE_MESSAGE_INTERACTIF_MAX
    && TITRE_MESSAGE_INTERACTIF_RE.test(titre);
}

/** Les deux préfixes écrits par la console, selon sa langue. */
const PREFIXES_QUAND = ['Quand : ', 'When: '] as const;
/** Ce qui est reconnu à la relecture : aussi « quand: » ou « When : », qu'un modèle peut écrire. */
const LIGNE_QUAND = /^(quand|when)\s*:\s*/i;

/** Assemble la situation et le contenu dans la forme que la console et l'assistant annoncent à Meta. */
export function composerConsigneMessage(
  quand: string,
  contenu: string,
  langue: 'fr' | 'en' = 'fr',
): string {
  const q = quand.trim().replace(/\s*\n\s*/g, ' ');
  const c = contenu.trim();
  if (q === '') return c;
  return `${langue === 'en' ? PREFIXES_QUAND[1] : PREFIXES_QUAND[0]}${q}\n${c}`;
}

/**
 * Sépare une consigne composée. Un texte libre sans préfixe reconnu reste entier : le couper au hasard ferait perdre
 * une partie d'une consigne écrite par l'assistant ou directement chez Meta.
 */
export function separerConsigneMessage(consigne: string): { quand: string; contenu: string } {
  const m = LIGNE_QUAND.exec(consigne);
  if (m === null) return { quand: '', contenu: consigne };
  const fin = consigne.indexOf('\n');
  return fin === -1
    ? { quand: consigne.slice(m[0].length).trim(), contenu: '' }
    : { quand: consigne.slice(m[0].length, fin).trim(), contenu: consigne.slice(fin + 1) };
}
