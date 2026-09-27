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

/** Remplace les `{{clef}}` par la valeur fournie (`{{ clef }}` toléré). Valeur absente ou nulle -> chaîne vide.
 *  Seules les clés propres de `vars` sont lues : `toString`, `constructor` ou `__proto__` remonteraient sinon
 *  un membre d'Object.prototype (texte parasite, ou `TypeError` dans escapeHtml). En mode HTML, la valeur
 *  substituée est échappée ; le corps du modèle, rédigé par le tenant, ne l'est jamais. */
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

/** Table des variables d'un contact : attributs système + champs libres (mêmes noms que le sélecteur du
 *  builder). Les champs libres passent après et peuvent écraser une clé système (dernier mot au tenant). Table
 *  sans prototype, en défense en profondeur ; une valeur non primitive devient `null`, jamais `"[object Object]"`. */
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
