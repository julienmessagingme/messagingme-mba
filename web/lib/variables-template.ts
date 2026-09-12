import type { ParamSource, TemplateParam, UserFieldDef } from './api';
import { SYSTEM_FIELDS, isSystemFieldKey } from './fields';

/**
 * L'ASSOCIATION DES VARIABLES D'UN TEMPLATE, en fonctions PURES.
 *
 * 🔴 CE FICHIER EXISTE POUR QU'IL N'Y AIT QU'UNE SEULE SÉMANTIQUE D'ASSOCIATION DANS LE PRODUIT. Ces
 * trois fonctions vivaient dans `CampaignCreateForm.tsx`, donc inatteignables depuis l'assistant, et les
 * y recopier aurait donné deux règles qui décident du MÊME envoi : le jour où l'une gagne un cas
 * (une clé système renommée, un indice périmé), l'autre l'ignore et personne ne le voit. L'ancien
 * formulaire les importe désormais d'ici : c'est la même règle des deux côtés, par construction.
 *
 * ⚠️ ELLES NE CONNAISSENT NI REACT NI L'API : elles traduisent un choix de `<select>` en ce que le
 * serveur attend (`paramMapping`). C'est ce qui les rend exerçables en quelques millisecondes, alors que
 * la même règle enfouie dans un `.tsx` ne pourrait l'être que par un e2e qui monte un serveur Next.
 */

/** Une ligne du sélecteur : la variable `{{i+1}}` et d'où elle vient. */
export interface VarRow {
  /** Option choisie : `sys:<key>` (champ de base), `field:<key>` (champ perso), `now`, ou `literal`. */
  sel: string;
  /** Valeur saisie, et UNIQUEMENT pour `literal`. */
  value: string;
}

/**
 * LE DÉFAUT D'UNE VARIABLE NON RENSEIGNÉE PAR UN INDICE.
 *
 * ⚠️ IL EST NOMMÉ PARCE QUE DEUX LECTEURS EN DÉPENDENT : le pré-remplissage d'une liste neuve, et le
 * repli de `selForSource` sur un indice qui vise un champ disparu. Deux `'sys:name'` en dur auraient pu
 * diverger, et c'est précisément la divergence qui ferait sauter un contact sans rien dire.
 */
export const SEL_DEFAUT = 'sys:name';

/** Option choisie -> `ParamSource` envoyée au serveur. */
export function selToSource(sel: string, value: string): ParamSource {
  if (sel === 'now') return { type: 'now' };
  if (sel === 'literal') return { type: 'literal', value };
  if (sel.startsWith('sys:')) {
    const f = SYSTEM_FIELDS.find((s) => `sys:${s.key}` === sel);
    return f ? f.source : { type: 'attribute', key: 'name' };
  }
  return { type: 'field', key: sel.slice('field:'.length) };
}

/**
 * `ParamSource` (indice de template stocké) -> option à présélectionner.
 *
 * `customFields` = les champs perso RÉELS. Un indice vers un champ inexistant (indice périmé d'un champ
 * supprimé) retombe sur le défaut : sinon le `<select>` afficherait sa première option tout en gardant en
 * interne une clé fantôme, et le contact serait sauté à l'envoi sans que l'écran l'ait montré.
 */
export function selForSource(s: ParamSource, customFields: UserFieldDef[]): string {
  if (s.type === 'now') return 'now';
  if (s.type === 'literal') return 'literal';
  if (s.type === 'attribute') return `sys:${s.key ?? 'name'}`;
  const key = s.key ?? '';
  if (isSystemFieldKey(key)) return `sys:${key}`; // prenom/email = champ système
  return customFields.some((f) => f.key === key) ? `field:${key}` : SEL_DEFAUT;
}

/** Les lignes d'un template à `n` variables, toutes au défaut. */
export function lignesParDefaut(n: number): VarRow[] {
  return Array.from({ length: Math.max(0, n) }, () => ({ sel: SEL_DEFAUT, value: '' }));
}

/**
 * LES LIGNES D'UN TEMPLATE, AFFINÉES PAR LES INDICES POSÉS À SA CRÉATION.
 *
 * ⚠️ UN INDICE HORS BORNES EST IGNORÉ, PAS APPLIQUÉ EN BOUT DE LISTE. Les indices sont stockés avec le
 * template et le corps a pu changer depuis : une position 4 sur un template à trois variables n'est pas
 * « la dernière », c'est un indice périmé, et le poser ailleurs associerait une variable à la source
 * d'une autre.
 *
 * ⚠️ La valeur ne voyage QUE pour un indice `literal` : c'est l'exemple posé au design du template, et
 * c'est le seul cas où une valeur saisie a un sens (les autres sources se résolvent par contact).
 */
export function lignesAvecIndices(
  n: number,
  indices: ReadonlyArray<{ position: number; source: ParamSource }>,
  customFields: UserFieldDef[],
): VarRow[] {
  return appliquerIndices(lignesParDefaut(n), indices, customFields);
}

/**
 * LES MÊMES INDICES, POSÉS SUR UNE LISTE DÉJÀ LÀ.
 *
 * ⚠️ ELLE EXISTE PARCE QUE LES INDICES ARRIVENT APRÈS. Le sélecteur s'affiche tout de suite avec ses
 * défauts, et la lecture des indices est un aller-retour réseau : reconstruire depuis les défauts à son
 * retour effacerait ce que l'opérateur aurait changé entre-temps sur une position qu'aucun indice ne
 * couvre. On écrase donc les positions INDIQUÉES, et elles seules.
 */
export function appliquerIndices(
  base: readonly VarRow[],
  indices: ReadonlyArray<{ position: number; source: ParamSource }>,
  customFields: UserFieldDef[],
): VarRow[] {
  const lignes = [...base];
  for (const h of indices) {
    const i = h.position - 1;
    if (!Number.isInteger(i) || i < 0 || i >= lignes.length) continue;
    lignes[i] = {
      sel: selForSource(h.source, customFields),
      value: h.source.type === 'literal' ? (h.source.value ?? '') : '',
    };
  }
  return lignes;
}

/** Les lignes du sélecteur -> le `paramMapping` du serveur, positions 1..N dans l'ordre. */
export function versParamMapping(vars: readonly VarRow[]): TemplateParam[] {
  return vars.map((v, i) => ({ position: i + 1, source: selToSource(v.sel, v.value) }));
}

/**
 * CE QUI EMPÊCHE D'ENVOYER CE MAPPING, en français, ou `null`.
 *
 * 🔴 LES DEUX CAS SONT RÉELS ET SE RÉPARENT PAREIL, MAIS ILS N'ONT PAS LA MÊME CAUSE.
 *   - le COMPTE : la liste ne couvre pas les `{{n}}` du modèle. Elle est construite au moment où l'on
 *     choisit le modèle ; un écran rouvert directement sur le récapitulatif (`?etape=recap`), ou un
 *     modèle dont le corps a changé chez Meta depuis, laisse une liste plus courte. Meta refuse alors la
 *     CAMPAGNE ENTIÈRE sur le compte de paramètres, pas seulement un destinataire.
 *   - le TEXTE FIXE VIDE : `{ type: 'literal', value: '' }` est un paramètre vide, que Meta refuse aussi.
 *     C'est le seul choix du sélecteur qui peut être laissé à blanc, les autres se résolvant par contact.
 *
 * ⚠️ ELLE NE JUGE PAS LES SOURCES PAR CONTACT (un champ perso vide sur une fiche) : ce cas-là est traité
 * à la construction des destinataires, qui ÉCARTE la fiche au lieu de refuser la campagne. Les confondre
 * ferait refuser un lancement parfaitement valide parce qu'un contact sur mille n'a pas son prénom.
 */
export function problemeDAssociation(vars: readonly VarRow[], nbVariables: number): string | null {
  if (vars.length !== nbVariables) {
    return `ce modèle porte ${nbVariables} variable(s) et ${vars.length} sont associées`;
  }
  const vide = vars.findIndex((v) => v.sel === 'literal' && v.value.trim() === '');
  if (vide >= 0) return `la variable {{${vide + 1}}} est un texte fixe laissé vide`;
  return null;
}
