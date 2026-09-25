/**
 * Le message d'une valeur levée : celui de l'`Error`, sinon la valeur ELLE-MÊME, telle que `console` l'affiche.
 * ⚠️ PAS `String(err)` : un objet levé s'affiche alors inspecté dans le journal, et le convertir en
 * « [object Object] » ferait perdre ce qu'il portait. Pour du TEXTE (une raison, un champ), c'est `texteDe`.
 */
export const messageDe = (err: unknown): unknown => (err instanceof Error ? err.message : err);

/** Le message d'une valeur levée, en TEXTE : celui de l'`Error`, sinon `String(valeur)`. */
export const texteDe = (err: unknown): string => (err instanceof Error ? err.message : String(err));
