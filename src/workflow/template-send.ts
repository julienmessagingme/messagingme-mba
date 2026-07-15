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
  /**
   * Variables du corps DÉJÀ résolues (campagne workflow, 1er template) : si fourni, on court-circuite la résolution
   * par hints et on utilise ces valeurs directement. Une valeur vide -> position `missing` (l'appelant saute :
   * jamais de `text:''`). Absent -> résolution par hints (chemin advance/webhook, inchangé).
   */
  explicitParams?: string[];
  /**
   * Jeton de session pour un bouton FLOW (formulaire). Meta l'EXIGE non vide à l'envoi d'un template NAVIGATE
   * (sinon #131009 « Parameter value is not valid »). La corrélation de la réponse côté mba passe par `_ref` baké
   * dans le flow_json, PAS par ce jeton -> n'importe quelle valeur non vide convient (le worker en passe un unique).
   */
  flowToken?: string;
}): { components: unknown[]; missing: number[] } {
  const resolved = opts.explicitParams !== undefined
    ? { values: opts.explicitParams, missing: opts.explicitParams.flatMap((v, i) => (v === '' ? [i + 1] : [])) }
    : opts.varCount > 0 ? resolveHintParams(opts.hints, opts.varCount, opts.contact) : { values: [], missing: [] };
  const bodyComponents = resolved.values.length > 0 ? buildTemplateComponents({ bodyParams: resolved.values }) : [];
  const flowToken = opts.flowToken && opts.flowToken !== '' ? opts.flowToken : 'mba-flow';
  // Un composant par bouton, à l'INDEX du template (préservé) : quick-reply -> payload contrôlé (`btn:<i>`) ;
  // FLOW -> action + flow_token (requis par Meta pour un template à bouton formulaire) ; URL statique -> rien.
  const buttonComponents = opts.buttons.flatMap((b, i): unknown[] => {
    if (b.type === 'QUICK_REPLY') return [{ type: 'button', sub_type: 'quick_reply', index: String(i), parameters: [{ type: 'payload', payload: `btn:${i}` }] }];
    if (b.type === 'FLOW') return [{ type: 'button', sub_type: 'flow', index: String(i), parameters: [{ type: 'action', action: { flow_token: flowToken } }] }];
    return [];
  });
  // `missing` non vide -> l'appelant (worker) SAUTE l'envoi (pas de `text:''` -> pas de 132012).
  return { components: [...bodyComponents, ...buttonComponents], missing: resolved.missing };
}
