import type { ResolvableContact } from './template';

/** Échappe les caractères dangereux pour une insertion dans du HTML. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Remplace les `{{clef}}` par la valeur fournie (espaces internes tolérés : `{{ clef }}`). Valeur absente ou
 *  nulle -> chaîne vide (jamais `undefined` littéral). Seules les clés PROPRES de `vars` sont lues (jamais la
 *  chaîne de prototype via `hasOwnProperty`) : une clef comme `toString`, `constructor` ou `__proto__` remonterait
 *  sinon vers le membre hérité d'Object.prototype (une fonction, ou Object.prototype lui-même) au lieu de
 *  `undefined` : texte parasite en mode texte, et `TypeError` dans escapeHtml en mode HTML puisque la valeur
 *  n'est pas une chaîne. En mode HTML, la valeur substituée est échappée ; le corps du modèle lui-même ne l'est
 *  jamais (il est rédigé par le tenant, pas une donnée non fiable). */
export function renderText(
  text: string,
  vars: Record<string, string | null | undefined>,
  opts: { html: boolean },
): string {
  return text.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_match, key: string) => {
    const raw = Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : undefined;
    if (raw == null) return '';
    return opts.html ? escapeHtml(raw) : raw;
  });
}

/** Table des variables d'un contact : attributs système + champs libres. Clés système alignées sur le
 *  sélecteur de variables du builder (mêmes noms que pour les templates WhatsApp). Les champs libres sont
 *  ajoutés après et peuvent donc écraser une clé système du même nom (dernier mot au tenant). Table construite
 *  avec `Object.create(null)` (pas de prototype) : défense en profondeur contre une lecture accidentelle d'une
 *  clé héritée dans renderText, même si son garde `hasOwnProperty` devait un jour sauter. Un champ dont la
 *  valeur n'est pas primitive (objet, tableau) devient `null`, jamais `"[object Object]"`. */
export function contactVars(contact: ResolvableContact): Record<string, string | null> {
  const out: Record<string, string | null> = Object.create(null);
  out.phone = contact.phone_e164 ?? null;
  out.phone_e164 = contact.phone_e164 ?? null;
  out.bsuid = contact.bsuid ?? null;
  out.profile_name = contact.profile_name ?? null;
  for (const [k, v] of Object.entries(contact.fields ?? {})) {
    out[k] = typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? String(v) : null;
  }
  return out;
}
