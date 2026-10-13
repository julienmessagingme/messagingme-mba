/**
 * La mise en forme du titre d'une consigne (« skill ») de l'agent de Meta, côté console. La règle qu'il doit
 * respecter et ses bornes sont partagées avec le serveur (`./partage/agent-meta` : `titreSkillValide`,
 * `TITRE_SKILL_MAX`) ; ce module ramène une saisie libre vers elle, sans aller-retour réseau.
 */
import { TITRE_SKILL_MAX } from './partage/agent-meta';

/** Accents retirés, minuscules, séparateurs réduits à un tiret unique, tirets de tête retirés, longueur bornée. */
function base(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, TITRE_SKILL_MAX);
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
