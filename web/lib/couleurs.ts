/**
 * LA PALETTE DE LA CONSOLE, EN UN SEUL ENDROIT. `tailwind.config.ts` la lit pour fabriquer les classes, et le
 * code qui a besoin d'une couleur en valeur (un trait du canevas de scénario, une pastille calculée) l'importe
 * d'ici au lieu de recopier un hexadécimal.
 *
 * Trois règles, et chacune a une raison :
 * - `brand` est le SEUL accent. Le bleu décoratif d'appoint (`sky`, `blue`) a été ramené à lui.
 * - UNE teinte par état : `danger`, `alerte`, `succes`. Chacune part d'une couleur du design system
 *   (le corail, l'or, la menthe) déclinée en nuances, pour que le fond pâle d'un bandeau, sa bordure et son
 *   texte restent de la même famille. Les familles Tailwind d'origine (`red`, `amber`, `emerald`…) ne
 *   servent plus : deux rouges pour une même erreur se voyaient d'un écran à l'autre.
 * - `DEFAULT` pointe la nuance qu'on lit sur fond blanc : le corail pur (500) ne tient pas 4,5:1 en texte,
 *   la 600 si.
 *
 * Le texte gris n'a que TROIS niveaux : `ink-900` (courant), `ink-500` (secondaire), `ink-400` (tertiaire).
 * Les autres nuances de `ink` restent pour les fonds, les bordures et les filets.
 */
export const brand = {
  50: '#E0F2FF',
  100: '#B8E0FF',
  200: '#6FC2FE',
  300: '#33ABFE',
  400: '#009AFE',
  500: '#0080D6',
  600: '#0066AA',
  700: '#004E82',
  800: '#003559',
  900: '#001E33',
} as const;

export const navy = {
  50: '#EEEFF5',
  100: '#D4D7E4',
  200: '#A8ADC8',
  300: '#6E76A1',
  400: '#424A7A',
  500: '#2B3162',
  600: '#202550',
  700: '#181C40',
  800: '#10132E',
  900: '#080A1C',
} as const;

export const ink = {
  50: '#F4F5F9',
  100: '#E7E9F0',
  200: '#D0D3E1',
  300: '#A6ABC6',
  400: '#7379A0',
  500: '#4A507A',
  600: '#2C3360',
  700: '#1E2349',
  800: '#131735',
  900: '#0B0E24',
} as const;

/** Le corail du design system (#E4604A, la 500), décliné. */
export const danger = {
  DEFAULT: '#C9452F',
  50: '#FDF2F0',
  100: '#FBE3DE',
  200: '#F6C4BA',
  300: '#EFA091',
  400: '#E97D6A',
  500: '#E4604A',
  600: '#C9452F',
  700: '#A53624',
  800: '#7F2A1D',
  900: '#5C1F16',
} as const;

/** L'or du design system (#E5A53B, la 500), décliné. */
export const alerte = {
  DEFAULT: '#9A6616',
  50: '#FEF8EC',
  100: '#FCEDCF',
  200: '#F8DA9F',
  300: '#F1C16A',
  400: '#EBB04E',
  500: '#E5A53B',
  600: '#C4861F',
  700: '#9A6616',
  800: '#764D13',
  900: '#583A11',
} as const;

/** La menthe du design system (ses nuances d'origine, prolongées de 800 et 900). */
export const succes = {
  DEFAULT: '#0E8334',
  50: '#E7FBEC',
  100: '#C2F4CE',
  200: '#8AE7A0',
  300: '#4ED777',
  400: '#17C74E',
  500: '#12A641',
  600: '#0E8334',
  700: '#0A6527',
  800: '#084F1F',
  900: '#063A17',
} as const;
