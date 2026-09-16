/**
 * Les seuls champs du contact dont un paramètre d'outil peut dériver (`source: 'contact'`).
 *
 * 🔴 FERMÉE EXPRÈS. La projection du contact passée au tour (`src/worker.ts`) peut s'élargir un jour ; la
 * surface offerte à un connecteur ne doit pas suivre toute seule. Un `contactPath` libre ferait dériver un
 * paramètre de n'importe quelle clé future, y compris d'une qu'on aurait ajoutée pour tout autre chose.
 *
 * ⚠️ `wa_id` est dans la liste mais ne vient PAS de la projection : il vient du contexte du TOUR, où il est
 * arrivé par la signature du webhook Meta. Voir l'étape 4 de `src/agent/executor.ts`.
 */
export const CHAMPS_CONTACT_AUTORISES = ['wa_id', 'nom'] as const;

export type ChampContact = (typeof CHAMPS_CONTACT_AUTORISES)[number];

export function estChampContact(v: unknown): v is ChampContact {
  return typeof v === 'string' && (CHAMPS_CONTACT_AUTORISES as readonly string[]).includes(v);
}

/**
 * La valeur d'un CHAMP PERSONNALISÉ du contact, lue dans la projection du tour.
 *
 * 🔴 ELLE NE REMPLACE PAS LA LISTE FERMÉE CI-DESSUS, ELLE OUVRE UNE PORTE VOISINE. Un `contactPath` libre
 * ferait dériver un paramètre de n'importe quelle clé FUTURE de la projection, y compris d'une qu'on y
 * aurait ajoutée pour tout autre chose : c'est ce que `CHAMPS_CONTACT_AUTORISES` interdit, et elle reste à
 * deux entrées. Ici, l'espace des clés est celui que le CLIENT a déclaré pour ses contacts
 * (`Bibliothèque > Champs`), et il ne contient par construction rien d'autre que ce qu'il y a mis. Le
 * raisonnement est déjà écrit, mot pour mot, pour les variables de requête (`src/agent/variables.ts`,
 * origine `champ`) : on l'applique ici aux paramètres d'outil, qui sont le seul chemin d'un outil MCP.
 *
 * 🔴 ELLE NE LIT QUE SOUS `champs`. La projection porte aussi `nom` et `tags` ; les rendre atteignables par
 * ce chemin créerait une seconde façon de lire `nom` et rouvrirait la clé libre qu'on vient de refuser.
 *
 * ⚠️ UNE VALEUR NON SCALAIRE REND `null`. Un paramètre d'outil est scalaire : laisser passer un objet
 * enverrait au système du client une structure qu'il n'attend pas, et ferait voyager une donnée que
 * personne n'a regardée.
 *
 * ⚠️ UN CHAMP ABSENT REND `null`, ET L'APPEL PART QUAND MÊME (décision de Julien, 2026-09-16). Refuser
 * serait faux pour un paramètre facultatif : un outil qui refuse de chercher parce que le contact n'a pas
 * renseigné sa ville serait absurde. L'avertissement se pose au moment du CLOUAGE, sur les paramètres que
 * le schéma distant déclare obligatoires.
 */
export function champDuContact(
  contact: Record<string, unknown> | null,
  cle: string,
): string | number | boolean | null {
  const champs = contact?.champs;
  if (typeof champs !== 'object' || champs === null || Array.isArray(champs)) return null;
  const v = (champs as Record<string, unknown>)[cle];
  return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? v : null;
}
