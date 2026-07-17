import type { WorkflowNodeType } from './graph';
import type { WorkflowRow } from './store.pg';

/**
 * Un node aplati depuis les graphes de workflows, pour l'affichage « Contenu > Blocs ».
 * `code` = code public `nod_<client>_<ulid>` (dans `node.data.code`), null pour un node jamais re-sauvegardé
 * depuis l'arrivée des codes (Lot 4b) : la liste tolère l'absence de code, elle ne le fabrique pas.
 */
export interface NodeListItem {
  code: string | null;
  type: WorkflowNodeType;
  workflowId: string;
  workflowName: string;
  /** Résumé humain, dérivé de `data` selon le type (même logique que le builder). Borné, jamais null. */
  summary: string;
}

const NOD_RE = /^nod_[0-9a-z]+_[0-9A-HJKMNP-TV-Z]{26}$/;

/** Résumé court d'un node selon son type. `data` est opaque : tout est coercé + borné, jamais de throw. */
function summarize(type: WorkflowNodeType, data: Record<string, unknown>): string {
  const s = (v: unknown) => String(v ?? '').replace(/\s+/g, ' ').trim();
  let out: string;
  switch (type) {
    case 'template': out = s(data.templateName); break;
    case 'quick_message': out = s(data.body); break;
    case 'flow': out = s(data.flowName); break;
    case 'tag': out = s(data.tag); break;
    case 'field': {
      // Le builder persiste `fieldLabel` (libellé affiché) + `fieldKey` (clé) ; `key` n'est qu'un fallback
      // pour d'éventuelles très vieilles données. Même logique que summaryOf / engine (fieldKey ?? key).
      const key = s(data.fieldLabel ?? data.fieldKey ?? data.key);
      const val = s(data.value);
      out = key === '' ? '' : val === '' ? key : `${key} = ${val}`;
      break;
    }
    case 'inbox': out = ''; break;
    default: out = '';
  }
  return out.slice(0, 120);
}

/**
 * Aplati tous les nodes des workflows d'un tenant en une liste requêtable par type. PUR (aucune IO).
 * Filtré optionnellement par `type`. Ordre : par workflow (comme reçu), puis par ordre des nodes dans le graphe.
 * Un `code` présent mais non conforme au motif `nod_..._<ulid>` est traité comme absent (null).
 */
export function collectNodes(workflows: WorkflowRow[], type?: WorkflowNodeType): NodeListItem[] {
  const out: NodeListItem[] = [];
  for (const wf of workflows) {
    for (const n of wf.graph.nodes) {
      if (type !== undefined && n.type !== type) continue;
      const raw = typeof n.data.code === 'string' ? n.data.code : '';
      out.push({
        code: NOD_RE.test(raw) ? raw : null,
        type: n.type,
        workflowId: wf.id,
        workflowName: wf.name,
        summary: summarize(n.type, n.data),
      });
    }
  }
  return out;
}
