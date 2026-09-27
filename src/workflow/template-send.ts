import { resolveHintParams, type ResolvableContact } from '../crm/template';
import type { ParamHint } from '../crm/template-hints.pg';
import { buildTemplateComponents } from '../meta/template-components';
import type { OutboundCarouselCard } from '../meta/template-components';
import type { WorkflowButton } from './engine';

/**
 * Construit les `components` Meta d'un envoi de template dans un workflow. Pur : la lecture du contact, des
 * hints et du corps live du template reste dans worker.ts.
 *  1) Variables du corps : attributs du contact collés via `template_param_hints` (ex. {{1}} -> prenom), repli
 *     sur les exemples du template. Exactement `varCount` valeurs, le compte attendu par Meta (sinon 132000).
 *  2) Payload contrôlé sur chaque bouton quick-reply (`btn:<index>`) -> branche déterministe au tap.
 * Ordre attendu par l'API Cloud : body avant boutons.
 */
export function buildWorkflowTemplateComponents(opts: {
  hints: ParamHint[];
  varCount: number;
  contact: ResolvableContact;
  buttons: WorkflowButton[];
  /**
   * Variables du corps déjà résolues (campagne workflow, 1er template) : court-circuite la résolution par hints.
   * Une valeur vide -> position `missing` (l'appelant saute : jamais de `text:''`).
   */
  explicitParams?: string[];
  /** Horodatage courant + fuseau, pour la source de variable NOW (date du jour). Absent -> pas de NOW résolu. */
  now?: Date;
  tz?: string;
  /**
   * Jeton de session d'un bouton FLOW. Meta l'exige non vide à l'envoi d'un template NAVIGATE (sinon #131009).
   * La corrélation de la réponse passe par `_ref` baké dans le flow_json, pas par ce jeton : toute valeur non
   * vide convient.
   */
  flowToken?: string;
  /**
   * Cartes du carousel du template (relues chez Meta). Absent = template sans carousel. Même constructeur que
   * le chemin campagne : un même template produit les mêmes composants des deux côtés.
   */
  carousel?: { cards: OutboundCarouselCard[] };
  /**
   * `media id` de l'en-tête média, préparé par l'appelant (re-téléversé sur le numéro d'envoi). Meta l'exige à
   * chaque envoi d'un template à en-tête IMAGE/VIDEO/DOCUMENT (sinon 132012) ; l'appelant refuse en amont via
   * `headerMediaSendBlocker`.
   */
  headerMediaId?: string;
  headerFormat?: 'IMAGE' | 'VIDEO' | 'DOCUMENT';
  /**
   * Suffixes des boutons URL tracés, par index de bouton (attribution des clics). Une URL soumise à Meta sous
   * la forme `/r/<code>/{{1}}` exige son composant à chaque envoi, quel que soit le chemin qui envoie :
   * l'oublier ici fait refuser l'envoi en 131008.
   */
  suffixesBoutons?: Record<number, string>;
}): { components: unknown[]; missing: number[] } {
  const resolved = opts.explicitParams !== undefined
    ? { values: opts.explicitParams, missing: opts.explicitParams.flatMap((v, i) => (v === '' ? [i + 1] : [])) }
    : opts.varCount > 0 ? resolveHintParams(opts.hints, opts.varCount, opts.contact, { now: opts.now, tz: opts.tz }) : { values: [], missing: [] };
  const bodyComponents = buildTemplateComponents({
    bodyParams: resolved.values,
    ...(opts.carousel ? { carousel: opts.carousel } : {}),
    ...(opts.headerMediaId ? { headerMediaId: opts.headerMediaId } : {}),
    ...(opts.headerFormat ? { headerFormat: opts.headerFormat } : {}),
    ...(opts.suffixesBoutons ? { suffixesBoutons: opts.suffixesBoutons } : {}),
  });
  const flowToken = opts.flowToken && opts.flowToken !== '' ? opts.flowToken : 'mba-flow';
  // Un composant par bouton, à l'index du template : quick-reply -> payload contrôlé (`btn:<i>`) ; FLOW ->
  // action + flow_token (requis par Meta pour un template à bouton formulaire) ; URL statique -> rien.
  const buttonComponents = opts.buttons.flatMap((b, i): unknown[] => {
    if (b.type === 'QUICK_REPLY') return [{ type: 'button', sub_type: 'quick_reply', index: String(i), parameters: [{ type: 'payload', payload: `btn:${i}` }] }];
    if (b.type === 'FLOW') return [{ type: 'button', sub_type: 'flow', index: String(i), parameters: [{ type: 'action', action: { flow_token: flowToken } }] }];
    return [];
  });
  // `missing` non vide -> l'appelant saute l'envoi (pas de `text:''`, donc pas de 132012).
  return { components: [...bodyComponents, ...buttonComponents], missing: resolved.missing };
}
