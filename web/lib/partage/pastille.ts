/**
 * Le motif d'une pastille nommée `{{ville}}` : le serveur substitue selon lui (les appels de connecteur), l'écran des
 * connecteurs signale selon lui les pastilles mal placées, et l'éditeur de messages en affiche des pastilles
 * cliquables. Qu'un seul accepte un caractère que les autres refusent, et l'écran déclare valide un gabarit que le
 * serveur refusera en pleine conversation, ou une variable part littéralement `{{prenom}}` chez un contact.
 *
 * Lettres, chiffres, tiret, point et souligné, avec des espaces tolérées autour du nom ; le nom est le premier groupe.
 * C'est un TEXTE et pas une expression : une expression `g` ou `y` garde son `lastIndex`, donc chaque module construit
 * la sienne (`new RegExp(MOTIF_PASTILLE, 'g')`) au lieu de partager un objet à état.
 */
export const MOTIF_PASTILLE = String.raw`\{\{\s*([\w.-]+)\s*\}\}`;
