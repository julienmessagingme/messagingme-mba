/**
 * Le message d'une valeur levée : celui de l'`Error`, sinon la valeur elle-même, telle que `console` l'affiche.
 * Pas `String(err)` : un objet levé deviendrait « [object Object] » et perdrait ce qu'il portait. Pour du
 * texte (une raison, un champ), c'est `texteDe`.
 */
export const messageDe = (err: unknown): unknown => (err instanceof Error ? err.message : err);

/** Le message d'une valeur levée, en texte : celui de l'`Error`, sinon `String(valeur)`. */
export const texteDe = (err: unknown): string => (err instanceof Error ? err.message : String(err));
