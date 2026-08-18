/**
 * Règles de titre d'une compétence MBA.
 *
 * ⚠️ DUPLIQUÉ du serveur (`src/http/mba.ts`, `TITRE_SKILL_RE`), délibérément et sur le modèle de
 * `button-url.ts` : les deux builds ne partagent aucun module. La copie existe pour refuser une saisie
 * invalide sans aller-retour réseau, pas pour remplacer le contrôle serveur. `tests/web-mba-parity.test.ts`
 * casse dès que les deux définitions divergent.
 */

/** Minuscules, chiffres et tirets, sans tiret aux extrémités, 64 caractères au plus. */
export const SKILL_TITLE_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const SKILL_TITLE_MAX = 64;
export const SKILL_DESCRIPTION_MAX = 1024;
export const SKILL_BODY_MAX = 20000;

export function isValidSkillTitle(title: string): boolean {
  return title.length > 0 && title.length <= SKILL_TITLE_MAX && SKILL_TITLE_RE.test(title);
}

/** Accents retirés, minuscules, séparateurs réduits à un tiret unique, tirets de tête retirés, longueur bornée. */
function base(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, SKILL_TITLE_MAX);
}

/**
 * Mise en forme PENDANT LA FRAPPE. Le tiret final est CONSERVÉ, et c'est tout l'objet de cette variante.
 *
 * ⚠️ Le retirer à chaque frappe rendait impossible d'écrire un nom en plusieurs mots : à l'espace de
 * « politique de retour », la valeur devenait « politique- » puis était nettoyée en « politique », si bien que
 * la lettre suivante se collait et qu'on obtenait « politiquederetour ». Le séparateur doit survivre entre
 * deux frappes.
 */
export function slugSkillTitleFrappe(raw: string): string {
  return base(raw);
}

/**
 * Mise en forme DÉFINITIVE : celle qu'on applique en quittant le champ et avant d'envoyer. « Politique de
 * retour ! » donne « politique-de-retour ».
 *
 * C'est ce qui évite de renvoyer une règle de format à quelqu'un qui a simplement écrit en français normal.
 */
export function slugSkillTitle(raw: string): string {
  return base(raw).replace(/-+$/, '');
}
