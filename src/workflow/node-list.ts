import type { WorkflowNodeType } from './graph';
import type { WorkflowRow } from './store.pg';

/**
 * Un node aplati depuis les graphes de workflows, pour l'affichage « Contenu > Blocs ».
 * `code` = code public `nod_<client>_<ulid>` (dans `node.data.code`), null pour un node jamais re-sauvegardé
 * depuis l'arrivée des codes : la liste tolère l'absence de code, elle ne le fabrique pas.
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

export const CODE_BLOC_RE = /^nod_[0-9a-z]+_[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * Résumé court d'un node selon son type. `data` est opaque : tout est coercé + borné, jamais de throw.
 * Chaque type a son cas, aligné sur `summaryOf` (web/components/WorkflowBuilder.tsx) : un type oublié tombe
 * sur `default` et s'affiche avec un résumé vide, indistinguable des autres.
 */
export function summarize(type: WorkflowNodeType, data: Record<string, unknown>): string {
  const s = (v: unknown) => String(v ?? '').replace(/\s+/g, ' ').trim();
  let out: string;
  switch (type) {
    case 'template': out = s(data.templateName); break;
    case 'quick_message': out = s(data.body); break;
    // Comme `summaryOf`, qui lit `data.text`.
    case 'rcs_message': out = s(data.text); break;
    // La question, plus le nombre de choix quand il y a un menu.
    case 'question': {
      const q = s(data.body);
      const n = Array.isArray(data.rows) ? data.rows.filter((r) => s((r as { title?: unknown })?.title) !== '').length : 0;
      out = q === '' ? '' : n === 0 ? q : `${q} (${n} choix)`;
      break;
    }
    case 'flow': out = s(data.flowName); break;
    case 'tag': out = s(data.tag); break;
    case 'field': {
      // Le builder persiste `fieldLabel` (libellé) + `fieldKey` (clé) ; `key` n'est qu'un repli pour de vieilles
      // données. Même logique que summaryOf et le moteur.
      const key = s(data.fieldLabel ?? data.fieldKey ?? data.key);
      const val = s(data.value);
      out = key === '' ? '' : val === '' ? key : `${key} = ${val}`;
      break;
    }
    case 'wait': {
      const mode = String(data.waitMode ?? 'delai');
      if (mode === 'heures_ouvrees') { out = 'jusqu’aux heures ouvrées'; break; }
      if (mode === 'date') {
        const brut = String(data.waitDate ?? '').trim();
        out = brut === '' ? '' : `jusqu’au ${brut.replace('T', ' ')}`;
        break;
      }
      const n = Number(data.delay ?? 0);
      const u = String(data.unit ?? 'hours');
      const lib = u === 'minutes' ? 'min' : u === 'days' ? 'j' : 'h';
      out = !Number.isFinite(n) || n <= 0 ? '' : `attendre ${n} ${lib}`;
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
      else if (kind === 'set_field') { const val = data.valueKind === 'now' ? 'maintenant' : data.valueKind === 'derniere_saisie' ? 'dernier message' : s(data.value); out = key === '' ? '' : val === '' ? key : `${key} = ${val}`; }
      else if (kind === 'clear_field') out = key === '' ? '' : `${key} (vidé)`;
      else if (kind === 'set_optin') out = 'passer en opt-in';
      else if (kind === 'set_optout') out = 'passer en opt-out';
      else out = '';
      break;
    }
    case 'email': {
      // Non configuré -> chaîne vide. Lit les deux formes de `to` (objet ou liste), comme le moteur et le canevas :
      // n'en lire qu'une afficherait un résumé vide sur des blocs qui envoient très bien.
      type Dest = { kind?: unknown; value?: unknown; field?: unknown };
      const bruts: Dest[] = Array.isArray(data.to) ? (data.to as Dest[]) : [data.to as Dest];
      const cibles = bruts
        .map((dst) => (dst?.kind === 'field' ? (s(dst.field) === '' ? '' : `{{${s(dst.field)}}}`) : s(dst?.value)))
        .filter((x) => x !== '');
      const reste = cibles.length - 1;
      out = cibles.length === 0 ? '' : reste === 0 ? `Mail vers ${cibles[0]}` : `Mail vers ${cibles[0]} +${reste}`;
      break;
    }
    case 'inbox': out = ''; break;
    // Le champ où la réponse atterrit ; l'appel lui-même est nommé dans la bibliothèque.
    case 'http': out = s(data.champCible) === '' ? '' : `-> ${s(data.champCible)}`; break;
    // Les deux champs, pas le code : une liste de blocs doit tenir sur une ligne.
    case 'js': out = s(data.champSource) === '' || s(data.champCible) === '' ? '' : `${s(data.champSource)} -> ${s(data.champCible)}`; break;
    case 'agent': out = s(data.label); break;
    default: out = '';
  }
  return out.slice(0, 120);
}

/**
 * Aplatit les nodes des workflows d'un tenant en une liste filtrable par `type`. Pur (aucune IO). Ordre : par
 * workflow (comme reçu), puis par ordre des nodes. Un `code` non conforme à `nod_..._<ulid>` est traité comme
 * absent (null).
 */
export function collectNodes(workflows: WorkflowRow[], type?: WorkflowNodeType): NodeListItem[] {
  const out: NodeListItem[] = [];
  for (const wf of workflows) {
    for (const n of wf.graph.nodes) {
      if (type !== undefined && n.type !== type) continue;
      const raw = typeof n.data.code === 'string' ? n.data.code : '';
      out.push({
        code: CODE_BLOC_RE.test(raw) ? raw : null,
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
