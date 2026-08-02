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
  /** Nom libre donné par l'utilisateur au bloc (`data.name`), borné. Vide si non renseigné. */
  name: string;
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
    case 'condition': {
      const clauses = Array.isArray(data.clauses) ? data.clauses.length : 0;
      const combineur = data.match === 'any' ? 'au moins une' : 'toutes';
      out = clauses === 0 ? 'Condition' : `Si ${combineur} de ${clauses} condition${clauses > 1 ? 's' : ''}`;
      break;
    }
    case 'action': {
      const kind = String(data.actionKind ?? '');
      const tag = s(data.tag);
      const key = s(data.fieldLabel ?? data.fieldKey ?? data.key);
      if (kind === 'add_tag') out = tag === '' ? '' : `+ ${tag}`;
      else if (kind === 'remove_tag') out = tag === '' ? '' : `− ${tag}`;
      else if (kind === 'set_field') { const val = data.valueKind === 'now' ? 'maintenant' : s(data.value); out = key === '' ? '' : val === '' ? key : `${key} = ${val}`; }
      else if (kind === 'clear_field') out = key === '' ? '' : `${key} (vidé)`;
      else out = '';
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
        name: String(n.data.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 64),
        workflowId: wf.id,
        workflowName: wf.name,
        summary: summarize(n.type, n.data),
      });
    }
  }
  return out;
}
