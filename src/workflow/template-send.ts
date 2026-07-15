import { resolveHintParams, type ResolvableContact } from '../crm/template';
import type { ParamHint } from '../crm/template-hints.pg';
import { buildTemplateComponents } from '../meta/template-components';
import type { WorkflowButton } from './engine';

/**
 * Construit les `components` Meta d'un envoi de template DANS un workflow (chemin réel de prod, worker.ts). Deux
 * apports :
 *  1) Variables du corps : on COLLE les attributs du contact via les indices `template_param_hints` (ex. {{1}} ->
 *     prenom), avec repli sur les exemples du template. On fournit EXACTEMENT `varCount` valeurs (le compte attendu
 *     par Meta) -> corrige l'erreur 132000 « le nombre de variables fournies ne correspond pas au template ».
 *  2) Payload contrôlé sur chaque bouton quick-reply (`btn:<index>`) -> branche déterministe au tap.
 * Fonction PURE (aucune IO) donc testable directement ; l'IO (lecture du contact, des hints, du corps live du
 * template) reste dans worker.ts. Ordre respecté : body avant boutons (attendu par l'API Cloud).
 */
export function buildWorkflowTemplateComponents(opts: {
  hints: ParamHint[];
  varCount: number;
  contact: ResolvableContact;
  buttons: WorkflowButton[];
}): { components: unknown[]; missing: number[] } {
  const resolved = opts.varCount > 0 ? resolveHintParams(opts.hints, opts.varCount, opts.contact) : { values: [], missing: [] };
  const bodyComponents = resolved.values.length > 0 ? buildTemplateComponents({ bodyParams: resolved.values }) : [];
  const buttonComponents = opts.buttons
    .map((b, i) => ({ b, i }))
    .filter(({ b }) => b.type === 'QUICK_REPLY')
    .map(({ i }) => ({ type: 'button', sub_type: 'quick_reply', index: String(i), parameters: [{ type: 'payload', payload: `btn:${i}` }] }));
  // `missing` non vide -> l'appelant (worker) SAUTE l'envoi (pas de `text:''` -> pas de 132012).
  return { components: [...bodyComponents, ...buttonComponents], missing: resolved.missing };
}
